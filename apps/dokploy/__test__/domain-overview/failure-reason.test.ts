import {
	buildFailureReason,
	sanitizeFailureText,
} from "@dokploy/server/utils/domain-overview/failure-reason";
import { describe, expect, it } from "vitest";

describe("failure reason", () => {
	it("keeps the exit code and the first line only", () => {
		expect(
			buildFailureReason({
				exitCode: 127,
				text: "\njq: command not found\nsecond line",
			}),
		).toBe("exit code 127: jq: command not found");
	});

	it("strips addresses from a connection error", () => {
		const text = sanitizeFailureText(
			"SSH connection error: connect ECONNREFUSED 203.0.113.9:22",
		);

		expect(text).not.toContain("203.0.113.9");
		expect(text).toContain("ECONNREFUSED");
	});

	it("strips IPv6 addresses", () => {
		expect(sanitizeFailureText("connect to 2001:db8::1 failed")).not.toContain(
			"2001:db8",
		);
	});

	it("strips keys and tokens", () => {
		const pem =
			"-----BEGIN OPENSSH PRIVATE KEY-----\nDUMMYKEYBODYDUMMYKEYBODY\n-----END OPENSSH PRIVATE KEY-----";
		expect(sanitizeFailureText(pem)).not.toContain("DUMMYKEYBODY");
		expect(sanitizeFailureText("token=abc123def456")).not.toContain("abc123");
		expect(
			sanitizeFailureText("denied AAAAB3NzaC1yc2EAAAADAQABAAABgQDdummydummy"),
		).not.toContain("AAAAB3NzaC1yc2E");
	});

	it("is at most about 200 characters", () => {
		expect(sanitizeFailureText("x ".repeat(400)).length).toBeLessThanOrEqual(
			203,
		);
	});

	it.each([
		["connect ECONNREFUSED ::1:22", "::1"],
		["connect ECONNREFUSED [::1]:22", "::1"],
		["connect EHOSTUNREACH fe80::1ff:fe23:4567:890a", "fe80"],
		["connect ETIMEDOUT fe80::1%eth0", "fe80"],
		["connect ECONNREFUSED [2001:db8::7]:22", "2001:db8"],
		["connect ECONNREFUSED 2001:db8:0:0:0:0:0:7", "2001:db8"],
		["connect ECONNREFUSED ::ffff:192.0.2.7", "192.0.2"],
		["connect ECONNREFUSED 192.0.2.7:22", "192.0.2.7"],
	])("strips the address in %s", (text, leaked) => {
		const result = sanitizeFailureText(text);

		expect(result).not.toContain(leaked);
	});

	it.each([
		"getaddrinfo ENOTFOUND build.internal.example.net",
		"connect ECONNREFUSED build.internal.example.net:22",
		"connect EHOSTUNREACH build.internal.example.net",
		"connect ETIMEDOUT build.internal.example.net:22",
		"getaddrinfo EAI_AGAIN build.internal.example.net",
	])("replaces the host name in %s", (text) => {
		const result = sanitizeFailureText(text);

		expect(result).not.toContain("build.internal");
		expect(result).toContain("[host]");
	});

	it("keeps the error code readable", () => {
		expect(sanitizeFailureText("connect ECONNREFUSED 192.0.2.7:22")).toMatch(
			/ECONNREFUSED/,
		);
	});

	it("does not touch a plain exit code line", () => {
		expect(
			buildFailureReason({ exitCode: 1, text: "docker: permission denied" }),
		).toBe("exit code 1: docker: permission denied");
	});
});
