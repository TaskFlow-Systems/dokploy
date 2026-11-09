import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { formatCommandFailure } from "@dokploy/server/utils/process/failure-message";
import { describe, expect, it } from "vitest";

const stderr = [
	'NOTICE: Config file "/root/.config/rclone/rclone.conf" not found - using defaults',
	"pg_dump: error: connection to server failed: FATAL: no pg_hba.conf entry",
	"RCLONE_CONFIG_DOKPLOYS3_SECRET_ACCESS_KEY=err-secret",
	"PGPASSWORD=db-secret pg_dump failed",
].join("\n");

describe("formatCommandFailure", () => {
	it.each([
		["local", "Command execution failed: exit code 1", undefined],
		["remote", "Remote command failed with exit code 1", "server-1"],
	])(
		"appends the redacted stderr of a %s failure",
		(_name, message, serverId) => {
			const text = formatCommandFailure(
				new ExecError(message, {
					command: "PGPASSWORD=cmd-secret pg_dump --secret-access-key=cmd-key",
					stderr,
					exitCode: 1,
					serverId,
				}),
			);

			expect(text).toContain(message);
			expect(text).toContain("FATAL: no pg_hba.conf entry");
			expect(text).not.toContain("Config file");
			for (const secret of [
				"err-secret",
				"db-secret",
				"cmd-secret",
				"cmd-key",
			]) {
				expect(text).not.toContain(secret);
			}
		},
	);

	it("keeps only the end of a very long stderr", () => {
		const text = formatCommandFailure(
			new ExecError("failed", {
				command: "x",
				stderr: `${"a".repeat(5000)}\nthe end`,
				exitCode: 1,
			}),
		);
		expect(text.length).toBeLessThan(2100);
		expect(text).toContain("the end");
	});

	it("redacts plain errors and other values", () => {
		expect(
			formatCommandFailure(new Error("boom PGPASSWORD=plain-secret")),
		).not.toContain("plain-secret");
		expect(formatCommandFailure("text")).toBe("text");
	});
});
