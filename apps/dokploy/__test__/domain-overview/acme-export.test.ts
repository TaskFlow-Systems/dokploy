import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	AcmeFileFormatError,
	buildAcmeExportCommand,
	extractCertificateBundle,
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

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");

const sec1Key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
	.privateKey.export({ type: "sec1", format: "pem" })
	.toString();
const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
	.privateKey.export({ type: "sec1", format: "pem" })
	.toString();
const ACCOUNT_KEY = "FAKE-ACCOUNT-KEY-MATERIAL-FOR-TESTS-ONLY";

const entry = (main: string, sans: string[], key: string, chain = 2) => ({
	domain: { main, sans },
	certificate: encode(FIXTURE_CERTIFICATE.repeat(chain)),
	key: encode(key),
	Store: "default",
});

const acmeDocument = (certificates: unknown[]) =>
	JSON.stringify({
		letsencrypt: {
			Account: { Email: "ops@example.test", PrivateKey: ACCOUNT_KEY },
			Certificates: certificates,
		},
	});

describe("certificate export", () => {
	it("splits the stored chain and returns the key as PKCS#8", () => {
		const raw = acmeDocument([
			entry("other.test", [], otherKey),
			entry("example.test", ["www.example.test"], sec1Key),
		]);

		const bundle = extractCertificateBundle(raw, "WWW.Example.test.");

		expect(bundle?.domain).toBe("www.example.test");
		expect(bundle?.names).toEqual(["example.test", "www.example.test"]);
		expect(bundle?.certificate).toBe(FIXTURE_CERTIFICATE);
		expect(bundle?.chain).toBe(FIXTURE_CERTIFICATE);
		expect(bundle?.fullchain).toBe(FIXTURE_CERTIFICATE.repeat(2));
		expect(bundle?.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		expect(
			createPrivateKey(bundle?.privateKey ?? "").export({
				type: "sec1",
				format: "pem",
			}),
		).toBe(sec1Key);
		expect(JSON.stringify(bundle)).not.toContain(ACCOUNT_KEY);
	});

	it("leaves the chain empty for a certificate stored alone", () => {
		const raw = acmeDocument([entry("example.test", [], sec1Key, 1)]);

		const bundle = extractCertificateBundle(raw, "example.test");

		expect(bundle?.chain).toBe("");
		expect(bundle?.fullchain).toBe(FIXTURE_CERTIFICATE);
	});

	it("finds a wildcard entry for a name one label below it", () => {
		const raw = acmeDocument([entry("*.example.test", [], sec1Key)]);

		expect(extractCertificateBundle(raw, "api.example.test")?.names).toEqual([
			"*.example.test",
		]);
		expect(extractCertificateBundle(raw, "a.b.example.test")).toBeNull();
	});

	it("skips an entry whose key cannot be read", () => {
		const raw = acmeDocument([
			{ ...entry("example.test", [], sec1Key), key: encode("not a key") },
		]);

		expect(extractCertificateBundle(raw, "example.test")).toBeNull();
	});

	it("does not echo the file content when the JSON cannot be parsed", () => {
		expect(() => extractCertificateBundle("{broken", "example.test")).toThrow(
			AcmeFileFormatError,
		);
	});

	it("sends only the entries that can cover the domain", () => {
		const jq = spawnSync("sh", ["-c", "command -v jq"], {
			encoding: "utf8",
		}).stdout.trim();
		if (!jq) {
			return;
		}
		const dir = mkdtempSync(path.join(tmpdir(), "acme-export-"));
		try {
			const file = path.join(dir, "acme.json");
			writeFileSync(
				file,
				acmeDocument([
					entry("other.test", [], otherKey),
					entry("*.example.test", [], sec1Key),
					entry("Example.test.", ["api.example.test"], sec1Key),
				]),
			);
			const result = spawnSync(
				"sh",
				["-c", buildAcmeExportCommand(file, "api.example.test")],
				{ encoding: "utf8" },
			);

			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain(encode(otherKey));
			expect(result.stdout).not.toContain(ACCOUNT_KEY);
			const kept = JSON.parse(result.stdout).letsencrypt.Certificates;
			expect(
				kept.map((item: { domain: { main: string } }) => item.domain.main),
			).toEqual(["*.example.test", "Example.test."]);
			expect(
				extractCertificateBundle(result.stdout, "api.example.test")?.privateKey,
			).toMatch(/BEGIN PRIVATE KEY/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits with the missing-file code when acme.json is absent", () => {
		const result = spawnSync(
			"sh",
			["-c", buildAcmeExportCommand("/nonexistent/acme.json", "example.test")],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(3);
	});
});
