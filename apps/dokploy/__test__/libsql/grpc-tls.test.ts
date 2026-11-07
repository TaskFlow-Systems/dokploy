import { createPrivateKey, X509Certificate } from "node:crypto";
import {
	createLibsqlGrpcCa,
	issueLibsqlGrpcCertificate,
	libsqlGrpcTlsEnv,
} from "@dokploy/server/utils/databases/libsql-grpc-tls";
import { describe, expect, it } from "vitest";

describe("the libSQL gRPC certificates", () => {
	it("makes an authority that signs and nothing else", async () => {
		const ca = new X509Certificate(
			(await createLibsqlGrpcCa("org-1")).certificate,
		);

		expect(ca.ca).toBe(true);
		expect(ca.subject).toContain("org-1");
		expect(ca.verify(ca.publicKey)).toBe(true);
	});

	it("issues a certificate that serves a primary and a replica, under the name sqld checks", async () => {
		const ca = await createLibsqlGrpcCa("org-1");
		const leaf = await issueLibsqlGrpcCertificate(ca, "db-app");
		const certificate = new X509Certificate(leaf.certificate);

		expect(certificate.ca).toBe(false);
		expect(
			certificate.verify(new X509Certificate(ca.certificate).publicKey),
		).toBe(true);
		expect(certificate.subjectAltName).toBe("DNS:sqld, DNS:db-app");
		expect(certificate.keyUsage).toEqual(
			expect.arrayContaining(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]),
		);
		expect(certificate.checkPrivateKey(createPrivateKey(leaf.privateKey))).toBe(
			true,
		);
	});

	it("does not take a certificate of another authority as its own", async () => {
		const ours = new X509Certificate(
			(await createLibsqlGrpcCa("org-1")).certificate,
		);
		const foreign = await issueLibsqlGrpcCertificate(
			await createLibsqlGrpcCa("org-2"),
			"db-app",
		);

		expect(
			new X509Certificate(foreign.certificate).verify(ours.publicKey),
		).toBe(false);
	});
});

// What the service spec holds after prepareEnvironmentVariables.
const asSpecEnv = (lines: string) =>
	lines.split("\n").map((line) => line.replace(/^(\w+)="(.*)"$/, "$1=$2"));

describe("the certificate a redeploy hands the node", () => {
	it("stays the one in the running spec, so nothing else restarts", async () => {
		const ca = await createLibsqlGrpcCa("org-1");
		const first = await libsqlGrpcTlsEnv(ca, "db-app");

		expect(await libsqlGrpcTlsEnv(ca, "db-app", asSpecEnv(first))).toBe(first);
	});

	it("is new without a running spec, or when its authority changed", async () => {
		const ca = await createLibsqlGrpcCa("org-1");
		const first = await libsqlGrpcTlsEnv(ca, "db-app");

		expect(await libsqlGrpcTlsEnv(ca, "db-app")).not.toBe(first);
		expect(
			await libsqlGrpcTlsEnv(
				await createLibsqlGrpcCa("org-1"),
				"db-app",
				asSpecEnv(first),
			),
		).not.toBe(first);
	});

	it("is new when the spec holds a certificate the authority did not sign", async () => {
		const ca = await createLibsqlGrpcCa("org-1");
		const forged = asSpecEnv(
			await libsqlGrpcTlsEnv(await createLibsqlGrpcCa("org-2"), "db-app"),
		).map((line) =>
			line.startsWith("DOKPLOY_GRPC_CA=")
				? `DOKPLOY_GRPC_CA=${Buffer.from(ca.certificate).toString("base64")}`
				: line,
		);

		const next = await libsqlGrpcTlsEnv(ca, "db-app", forged);
		expect(next).not.toContain(forged[1]?.split("=")[1] ?? "-");
	});
});
