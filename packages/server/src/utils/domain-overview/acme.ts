import { X509Certificate } from "node:crypto";

export const ACME_FILE_NAME = "acme.json";
export const ACME_FILE_MISSING_EXIT_CODE = 3;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type AcmeCertificate = {
	names: string[];
	validTo: Date;
	issuer: string;
};

export type CertificateTone = "critical" | "warning" | "ok";

// jq drops the private keys on the server. Without jq the whole file comes
// over and parseAcmeCertificates drops the keys before anything reads the data.
const JQ_REDUCE_FILTER =
	"{letsencrypt: {Certificates: [.letsencrypt?.Certificates[]? | {domain: {main: .domain?.main?, sans: (.domain?.sans? // [])}, certificate: .certificate?}]}}";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const buildAcmeReadCommand = (acmeFilePath: string) => {
	const file = shellQuote(acmeFilePath);
	return [
		`[ -f ${file} ] || exit ${ACME_FILE_MISSING_EXIT_CODE}`,
		"if command -v jq >/dev/null 2>&1; then",
		`jq -c '${JQ_REDUCE_FILTER}' ${file}`,
		"else",
		`cat ${file}`,
		"fi",
	].join("\n");
};

export class AcmeFileFormatError extends Error {
	constructor() {
		super("acme.json could not be parsed");
		this.name = "AcmeFileFormatError";
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeDomainName = (name: string) =>
	name.trim().replace(/\.$/, "").toLowerCase();

const formatIssuer = (issuer: string) => {
	const fields = new Map<string, string>();
	for (const line of issuer.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) {
			fields.set(line.slice(0, separator), line.slice(separator + 1));
		}
	}
	const label = [fields.get("O"), fields.get("CN")].filter(Boolean).join(" ");
	return label || issuer.replace(/\n/g, ", ");
};

export const parseCertificateChain = (encoded: string) => {
	const pem = Buffer.from(encoded, "base64").toString("utf8");
	const leaf = pem.match(
		/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
	)?.[0];
	if (!leaf) {
		return null;
	}
	try {
		const certificate = new X509Certificate(leaf);
		const validTo = new Date(certificate.validTo);
		if (Number.isNaN(validTo.getTime())) {
			return null;
		}
		return { validTo, issuer: formatIssuer(certificate.issuer) };
	} catch {
		return null;
	}
};

const toAcmeCertificate = (entry: unknown): AcmeCertificate | null => {
	if (!isRecord(entry)) {
		return null;
	}
	const encoded = entry.certificate;
	if (typeof encoded !== "string") {
		return null;
	}
	const domain: Record<string, unknown> = isRecord(entry.domain)
		? entry.domain
		: {};
	const sans = Array.isArray(domain.sans) ? domain.sans : [];
	const names = [domain.main, ...sans].flatMap((name) =>
		typeof name === "string" && name.trim() !== ""
			? [normalizeDomainName(name)]
			: [],
	);
	const parsed = parseCertificateChain(encoded);
	if (!parsed || names.length === 0) {
		return null;
	}
	return { names: [...new Set(names)], ...parsed };
};

// Errors never carry the file content: JSON.parse messages can quote the
// input, so the original error is dropped here.
export const parseAcmeCertificates = (raw: string): AcmeCertificate[] => {
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		throw new AcmeFileFormatError();
	}
	const letsencrypt = isRecord(document) ? document.letsencrypt : undefined;
	const entries = isRecord(letsencrypt) ? letsencrypt.Certificates : undefined;
	if (!Array.isArray(entries)) {
		return [];
	}
	return entries.flatMap((entry) => {
		const certificate = toAcmeCertificate(entry);
		return certificate ? [certificate] : [];
	});
};

export const daysUntil = (date: Date, now: Date) =>
	Math.floor((date.getTime() - now.getTime()) / DAY_MS);

export const certificateTone = (daysLeft: number): CertificateTone => {
	if (daysLeft < 14) {
		return "critical";
	}
	if (daysLeft < 30) {
		return "warning";
	}
	return "ok";
};

export const certificateCovers = (names: readonly string[], domain: string) =>
	names.some((name) => {
		if (name === domain) {
			return true;
		}
		if (!name.startsWith("*.")) {
			return false;
		}
		const suffix = name.slice(1);
		if (!domain.endsWith(suffix)) {
			return false;
		}
		const label = domain.slice(0, domain.length - suffix.length);
		return label.length > 0 && !label.includes(".");
	});

export const findCertificateFor = (
	certificates: readonly AcmeCertificate[],
	domain: string,
) =>
	certificates
		.filter((certificate) => certificateCovers(certificate.names, domain))
		.sort((a, b) => b.validTo.getTime() - a.validTo.getTime())[0];
