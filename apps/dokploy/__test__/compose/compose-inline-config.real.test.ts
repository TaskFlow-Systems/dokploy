import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyInlineConfigHashLabels } from "@dokploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

const execFileAsync = promisify(execFile);

// The PR workflow removes real-compose-<id>* after a cancelled run.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const PROJECT = `real-compose-${CHECKOUT_ID}-${Date.now()}-cfg`;
const TIMEOUT = 180_000;

let dir = "";

const compose = (...args: string[]) =>
	execFileAsync(
		"docker",
		["compose", "-p", PROJECT, "-f", join(dir, "compose.yml"), ...args],
		{ timeout: 120_000 },
	).then(({ stdout }) => stdout.trim());

// The change that left ClickHouse on its old config: two lines removed from
// the inline XML, nothing else in the file.
const spec = (withSeccomp: boolean): ComposeSpecification =>
	({
		services: {
			ch: {
				image: "alpine:3.22",
				command: ["sh", "-c", "sleep 3600"],
				configs: [
					{ source: "small", target: "/etc/small.xml" },
					{ source: "inserts", target: "/etc/inserts.xml" },
				],
			},
		},
		configs: {
			small: {
				content: [
					"<clickhouse>",
					"  <logger>",
					"    <level>warning</level>",
					"  </logger>",
					...(withSeccomp
						? ["  <!-- comment -->", "  <seccomp>log</seccomp>"]
						: []),
					"  <mark_cache_size>134217728</mark_cache_size>",
					"</clickhouse>",
					"",
				].join("\n"),
			},
			inserts: { content: "<clickhouse/>\n" },
		},
	}) as unknown as ComposeSpecification;

const deploy = async (result: ComposeSpecification, label: boolean) => {
	if (label) applyInlineConfigHashLabels(result);
	await writeFile(join(dir, "compose.yml"), stringify(result));
	await compose("up", "-d", "--build", "--remove-orphans");
	return compose("ps", "-q", "ch");
};

const seccompLines = async (container: string) =>
	(
		await execFileAsync("docker", [
			"exec",
			container,
			"sh",
			"-c",
			"grep -c seccomp /etc/small.xml || true",
		])
	).stdout.trim();

describe("an inline config change on real Docker Compose", () => {
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "compose-inline-config-"));
	});

	afterAll(async () => {
		await compose("down", "-v", "--remove-orphans").catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	}, TIMEOUT);

	it(
		"is missed by Compose alone, which is why the panel labels the service",
		async () => {
			const before = await deploy(spec(true), false);
			const after = await deploy(spec(false), false);

			expect(after).toBe(before);
			expect(await seccompLines(after)).toBe("1");
			await compose("down", "-v");
		},
		TIMEOUT,
	);

	it(
		"recreates the container with the new file once the panel labels it",
		async () => {
			const before = await deploy(spec(true), true);
			const after = await deploy(spec(false), true);

			expect(after).not.toBe(before);
			expect(await seccompLines(after)).toBe("0");

			const again = await deploy(spec(false), true);
			expect(again).toBe(after);
		},
		TIMEOUT,
	);
});
