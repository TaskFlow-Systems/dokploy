import { createPrivateKey, X509Certificate } from "node:crypto";
import {
	createLibsqlGrpcCa,
	issueLibsqlGrpcCertificate,
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
