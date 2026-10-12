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
});
