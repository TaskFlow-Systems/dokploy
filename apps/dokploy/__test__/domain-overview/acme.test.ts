import {
	buildAcmeReadCommand,
	certificateCovers,
	certificateTone,
	daysUntil,
	findCertificateFor,
	parseAcmeCertificates,
	parseCertificateChain,
} from "@dokploy/server/utils/domain-overview/acme";
import { describe, expect, it } from "vitest";

const FIXTURE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIByzCCAXGgAwIBAgIUWlFvc+nf6dEY5hzHVUVViA92C6kwCgYIKoZIzj0EAwIw
NjEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MR0wGwYDVQQKDBRFeGFtcGxlIFRlc3Qg
Rml4dHVyZTAeFw0yNjAxMDEwMDAwMDBaFw0yNzA2MDExMjAwMDBaMDYxFTATBgNV
BAMMDGV4YW1wbGUudGVzdDEdMBsGA1UECgwURXhhbXBsZSBUZXN0IEZpeHR1cmUw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR8poBd9hdPZbBkGhYMU068RMvU5tEW
AGaG3Ak6Ia9ZJNXhgn2Rc8Kc1Xim/05OxNc7ubzinXH7XEBWyfLmI7Ylo10wWzAd
BgNVHQ4EFgQUkdsHQsjcvCmQo7qeXtOtA3bmJZAwDwYDVR0TAQH/BAUwAwEB/zAp
BgNVHREEIjAgggxleGFtcGxlLnRlc3SCEHd3dy5leGFtcGxlLnRlc3QwCgYIKoZI
zj0EAwIDSAAwRQIgWV3UtpalgH4fHv8AmFwlUfSdJjTLK5Li2K2OJKYZXrICIQCK
c9Rm3ru6I2cIJEIQwsANL6haSt6HrEbU14R9Zw3LWQ==
-----END CERTIFICATE-----
`;

const FAKE_ENTRY_KEY = "FAKE-ENTRY-KEY-MATERIAL-FOR-TESTS-ONLY";
const FAKE_ACCOUNT_KEY = "FAKE-ACCOUNT-KEY-MATERIAL-FOR-TESTS-ONLY";

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");

const acmeDocument = (certificates: unknown[]) =>
	JSON.stringify({
		letsencrypt: {
			Account: {
				Email: "ops@example.test",
				PrivateKey: FAKE_ACCOUNT_KEY,
			},
			Certificates: certificates,
		},
	});

const fixtureEntry = {
	domain: { main: "example.test", sans: ["www.example.test"] },
	certificate: encode(FIXTURE_CERTIFICATE),
	key: FAKE_ENTRY_KEY,
	Store: "default",
};

describe("acme.json parser", () => {
	it("returns names, expiry and issuer and never the key material", () => {
		const raw = acmeDocument([fixtureEntry]);

		const certificates = parseAcmeCertificates(raw);

		expect(certificates).toHaveLength(1);
		expect(certificates[0]?.names).toEqual([
			"example.test",
			"www.example.test",
		]);
		expect(certificates[0]?.validTo.toISOString()).toBe(
			"2027-06-01T12:00:00.000Z",
		);
		expect(certificates[0]?.issuer).toBe("Example Test Fixture example.test");
		expect(Object.keys(certificates[0] ?? {}).sort()).toEqual([
			"issuer",
			"names",
			"validTo",
		]);
		const serialized = JSON.stringify(certificates);
		expect(serialized).not.toContain(FAKE_ENTRY_KEY);
		expect(serialized).not.toContain(FAKE_ACCOUNT_KEY);
	});

	it("reads the reduced shape that the server-side jq filter prints", () => {
		const reduced = JSON.stringify({
			letsencrypt: {
				Certificates: [
					{
						domain: { main: "Example.TEST.", sans: [] },
						certificate: encode(FIXTURE_CERTIFICATE),
					},
				],
			},
		});

		expect(parseAcmeCertificates(reduced)[0]?.names).toEqual(["example.test"]);
	});

	it("skips entries without a readable certificate", () => {
		const raw = acmeDocument([
			{ domain: { main: "example.test" }, certificate: encode("not a cert") },
			{ domain: { main: "example.test" } },
		]);

		expect(parseAcmeCertificates(raw)).toEqual([]);
	});

	it("returns no certificates when the file has no letsencrypt section", () => {
		expect(parseAcmeCertificates("{}")).toEqual([]);
	});

	it("does not echo the file content when the JSON cannot be parsed", () => {
		const broken = `{"letsencrypt": {"Account": {"PrivateKey": "${FAKE_ACCOUNT_KEY}"`;

		let thrown: unknown;
		try {
			parseAcmeCertificates(broken);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("acme.json could not be parsed");
		expect(String(thrown)).not.toContain(FAKE_ACCOUNT_KEY);
	});
});

describe("certificate expiry parser", () => {
	it("reads validTo and the issuer from the first PEM block only", () => {
		const parsed = parseCertificateChain(
			encode(
				`${FIXTURE_CERTIFICATE}${FIXTURE_CERTIFICATE.replace(
					"MIIBy",
					"MIIBz",
				)}`,
			),
		);

		expect(parsed?.validTo.toISOString()).toBe("2027-06-01T12:00:00.000Z");
		expect(parsed?.issuer).toBe("Example Test Fixture example.test");
	});

	it("returns null when the chain holds no certificate", () => {
		expect(parseCertificateChain(encode("plain text"))).toBeNull();
	});

	it("counts whole days left from a given moment", () => {
		const validTo = new Date("2027-06-01T12:00:00.000Z");

		expect(daysUntil(validTo, new Date("2027-05-19T12:00:00.000Z"))).toBe(13);
		expect(daysUntil(validTo, new Date("2027-05-19T13:00:00.000Z"))).toBe(12);
		expect(daysUntil(validTo, new Date("2027-06-02T12:00:00.000Z"))).toBe(-1);
	});

	it("marks under 14 days as critical and under 30 days as warning", () => {
		expect(certificateTone(13)).toBe("critical");
		expect(certificateTone(0)).toBe("critical");
		expect(certificateTone(-3)).toBe("critical");
		expect(certificateTone(14)).toBe("warning");
		expect(certificateTone(29)).toBe("warning");
		expect(certificateTone(30)).toBe("ok");
	});
});

describe("certificate names", () => {
	it("matches exact names and one wildcard label", () => {
		expect(certificateCovers(["example.test"], "example.test")).toBe(true);
		expect(certificateCovers(["*.example.test"], "www.example.test")).toBe(
			true,
		);
		expect(certificateCovers(["*.example.test"], "example.test")).toBe(false);
		expect(certificateCovers(["*.example.test"], "a.b.example.test")).toBe(
			false,
		);
	});

	it("prefers the certificate with the latest expiry", () => {
		const older = {
			names: ["example.test"],
			validTo: new Date("2026-12-01T00:00:00Z"),
			issuer: "older",
		};
		const newer = {
			names: ["example.test"],
			validTo: new Date("2027-06-01T00:00:00Z"),
			issuer: "newer",
		};

		expect(findCertificateFor([older, newer], "example.test")?.issuer).toBe(
			"newer",
		);
		expect(findCertificateFor([older], "other.example.test")).toBeUndefined();
	});
});

describe("acme.json read command", () => {
	it("checks the file first and reduces it on the server when jq is available", () => {
		const command = buildAcmeReadCommand(
			"/etc/dokploy/traefik/dynamic/acme.json",
		);

		expect(
			command.startsWith(
				"[ -f '/etc/dokploy/traefik/dynamic/acme.json' ] || exit 3",
			),
		).toBe(true);
		expect(command).toContain("jq -c");
		expect(command).toContain("certificate: .certificate?");
		expect(command).not.toMatch(/PrivateKey|\.key\b/);
	});

	it("quotes the path so that it cannot end the argument", () => {
		const command = buildAcmeReadCommand("/srv/it's/acme.json");

		expect(command).toContain("'/srv/it'\\''s/acme.json'");
	});
});
