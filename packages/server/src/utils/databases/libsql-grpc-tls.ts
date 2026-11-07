import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

export {
	LIBSQL_GRPC_PRIMARY_FLAGS,
	LIBSQL_GRPC_REPLICA_FLAGS,
	LIBSQL_GRPC_TLS_SETUP,
} from "./libsql-grpc-flags";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export type LibsqlGrpcCa = { certificate: string; privateKey: string };

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// sqld checks its primary's certificate against this name whatever host the
// replica dials, so the panel's own name, an IP or a published port all work.
export const LIBSQL_GRPC_SERVER_NAME = "sqld";

const toPem = (label: string, der: ArrayBuffer) =>
	x509.PemConverter.encode(der, label);

const randomSerial = () =>
	Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)))
		.toString("hex")
		.replace(/^[89a-f]/, "1");

export const createLibsqlGrpcCa = async (
	organizationId: string,
): Promise<LibsqlGrpcCa> => {
	const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, [
		"sign",
		"verify",
	]);
	const now = new Date();
	const certificate = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: randomSerial(),
		name: `CN=Dokploy libSQL gRPC CA ${organizationId}`,
		notBefore: new Date(now.getTime() - 60_000),
		notAfter: new Date(now.getTime() + 30 * YEAR_MS),
		signingAlgorithm: ALGORITHM,
		keys: keys as CryptoKeyPair,
		extensions: [
			new x509.BasicConstraintsExtension(true, 0, true),
			new x509.KeyUsagesExtension(
				x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
				true,
			),
		],
	});
	return {
		certificate: certificate.toString("pem"),
		privateKey: toPem(
			"PRIVATE KEY",
			await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
		),
	};
};

// One certificate serves a primary as its server certificate and a replica as
// its client certificate, so both names and both uses are in it.
export const issueLibsqlGrpcCertificate = async (
	ca: LibsqlGrpcCa,
	appName: string,
) => {
	const caCertificate = new x509.X509Certificate(ca.certificate);
	const caKey = await webcrypto.subtle.importKey(
		"pkcs8",
		x509.PemConverter.decodeFirst(ca.privateKey),
		ALGORITHM,
		false,
		["sign"],
	);
	const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, [
		"sign",
		"verify",
	]);
	const now = new Date();
	const certificate = await x509.X509CertificateGenerator.create({
		serialNumber: randomSerial(),
		subject: `CN=${appName}`,
		issuer: caCertificate.subject,
		notBefore: new Date(now.getTime() - 60_000),
		notAfter: new Date(now.getTime() + 10 * YEAR_MS),
		signingAlgorithm: ALGORITHM,
		publicKey: keys.publicKey as never,
		signingKey: caKey as CryptoKey,
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			new x509.ExtendedKeyUsageExtension([
				x509.ExtendedKeyUsage.serverAuth,
				x509.ExtendedKeyUsage.clientAuth,
			]),
			new x509.SubjectAlternativeNameExtension([
				{ type: "dns", value: LIBSQL_GRPC_SERVER_NAME },
				{ type: "dns", value: appName },
			]),
		],
	});
	return {
		certificate: certificate.toString("pem"),
		privateKey: toPem(
			"PRIVATE KEY",
			await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
		),
	};
};

const base64 = (pem: string) => Buffer.from(pem, "utf8").toString("base64");

export const libsqlGrpcTlsEnv = async (ca: LibsqlGrpcCa, appName: string) => {
	const leaf = await issueLibsqlGrpcCertificate(ca, appName);
	return [
		`DOKPLOY_GRPC_CA="${base64(ca.certificate)}"`,
		`DOKPLOY_GRPC_CERT="${base64(leaf.certificate)}"`,
		`DOKPLOY_GRPC_KEY="${base64(leaf.privateKey)}"`,
	].join("\n");
};
