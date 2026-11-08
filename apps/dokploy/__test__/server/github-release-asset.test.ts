import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = path.resolve(
	__dirname,
	"../../../../scripts/github-release-asset.sh",
);
const asset = Buffer.from("release asset body");
const digest = `sha256:${createHash("sha256").update(asset).digest("hex")}`;

let server: http.Server;
let base = "";
let dir = "";
let webStatus = 200;
let recordedDigest: string | undefined = digest;
let assetAccept: string | undefined;
let apiFailuresLeft = 0;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const url = req.url ?? "";
		if (url === "/web/owner/tool/releases/download/v1/tool.tar.gz") {
			res
				.writeHead(webStatus)
				.end(webStatus === 200 ? asset : "Gateway Timeout");
			return;
		}
		if (url === "/api/repos/owner/tool/releases/tags/v1") {
			if (apiFailuresLeft > 0) {
				apiFailuresLeft -= 1;
				res.writeHead(503).end("Service Unavailable");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					assets: [
						{ name: "other.tar.gz", url: `${base}/api/assets/2` },
						{
							name: "tool.tar.gz",
							url: `${base}/api/assets/1`,
							...(recordedDigest ? { digest: recordedDigest } : {}),
						},
					],
				}),
			);
			return;
		}
		if (url === "/api/assets/1") {
			assetAccept = req.headers.accept;
			res.writeHead(200).end(asset);
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	dir = await mkdtemp(path.join(tmpdir(), "github-release-asset-"));
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, { recursive: true, force: true });
});

const run = async (name: string, rounds = 1) => {
	const out = path.join(dir, name);
	try {
		const { stderr } = await promisify(execFile)(
			"sh",
			[script, "owner/tool", "v1", name, out],
			{
				env: {
					...process.env,
					GITHUB_RELEASE_WEB: `${base}/web`,
					GITHUB_RELEASE_API: `${base}/api`,
					GITHUB_RELEASE_ROUNDS: String(rounds),
					GITHUB_RELEASE_PAUSE: "0",
					GITHUB_TOKEN: "",
				},
			},
		);
		return { ok: true, stderr, body: await readFile(out).catch(() => null) };
	} catch (error) {
		const { stderr } = error as { stderr: string };
		return { ok: false, stderr, body: await readFile(out).catch(() => null) };
	}
};

describe("github-release-asset.sh", () => {
	it("takes the file from github.com when it answers", async () => {
		webStatus = 200;
		assetAccept = undefined;
		const result = await run("tool.tar.gz");
		expect(result.ok).toBe(true);
		expect(result.body).toEqual(asset);
		expect(assetAccept).toBeUndefined();
	});

	it("falls back to the API when github.com answers 504", async () => {
		webStatus = 504;
		recordedDigest = digest;
		const result = await run("tool.tar.gz");
		expect(result.ok).toBe(true);
		expect(result.body).toEqual(asset);
		expect(assetAccept).toBe("application/octet-stream");
		expect(result.stderr).toContain("trying the GitHub API");
	});

	it("goes round again when the API fails as well", async () => {
		webStatus = 504;
		recordedDigest = digest;
		apiFailuresLeft = 1;
		const result = await run("tool.tar.gz", 2);
		expect(result.ok).toBe(true);
		expect(result.body).toEqual(asset);
		expect(result.stderr).toContain("round 1 of 2");
	});

	it("gives up after the last round", async () => {
		webStatus = 504;
		apiFailuresLeft = 5;
		const result = await run("tool.tar.gz", 2);
		apiFailuresLeft = 0;
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain("in 2 rounds");
	});

	it("refuses a file from the API that does not match its digest", async () => {
		webStatus = 504;
		recordedDigest = `sha256:${"0".repeat(64)}`;
		const result = await run("tool.tar.gz");
		expect(result.ok).toBe(false);
		expect(result.body).toBeNull();
		expect(result.stderr).toContain("does not match its digest");
	});

	it("fails when the release has no such asset", async () => {
		webStatus = 504;
		recordedDigest = digest;
		const result = await run("missing.tar.gz");
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain("has no asset missing.tar.gz");
	});
});
