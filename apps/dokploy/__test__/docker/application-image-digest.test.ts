import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	pickPushedImageDigest,
	preservePinnedDigestOnReload,
	resolvePushedImageRef,
	stripImageTag,
} from "@dokploy/server/utils/builders";
// @ts-expect-error Its types are declared only in packages/server.
import Dockerode from "dockerode";
import { afterEach, describe, expect, it } from "vitest";

const SHA_A =
	"sha256:658de00d840dcdc7803528f7d425a4399a867ad64d0bdf37a2ffd171b1359346";
const SHA_B =
	"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Seen = { method?: string; path: string };
type Reply = { status: number; body?: unknown } | "silent";

let server: Server | undefined;

const startDaemon = async (reply: (request: IncomingMessage) => Reply) => {
	const seen: Seen[] = [];
	server = createServer((request, response) => {
		seen.push({ method: request.method, path: request.url ?? "" });
		request.on("end", () => {
			const answer = reply(request);
			if (answer === "silent") return;
			response.writeHead(answer.status, {
				"content-type": "application/json",
			});
			response.end(JSON.stringify(answer.body ?? {}));
		});
		request.resume();
	});
	await new Promise<void>((resolve) =>
		server?.listen(0, "127.0.0.1", () => resolve()),
	);
	const { port } = server.address() as AddressInfo;
	return {
		seen,
		docker: new Dockerode({ host: "127.0.0.1", port, protocol: "http" }),
	};
};

afterEach(async () => {
	const running = server;
	if (!running) return;
	running.closeAllConnections();
	await new Promise((resolve) => running.close(resolve));
	server = undefined;
});

describe("stripImageTag", () => {
	it("strips explicit tag while keeping registry host port", () => {
		expect(stripImageTag("agenthits.asuscomm.com:80/builder/site:latest")).toBe(
			"agenthits.asuscomm.com:80/builder/site",
		);
		expect(stripImageTag("agenthits.asuscomm.com:80/builder/site")).toBe(
			"agenthits.asuscomm.com:80/builder/site",
		);
		expect(stripImageTag("nginx:alpine")).toBe("nginx");
		expect(
			stripImageTag(`agenthits.asuscomm.com:80/builder/site@${SHA_A}`),
		).toBe("agenthits.asuscomm.com:80/builder/site");
		expect(
			stripImageTag(`agenthits.asuscomm.com:80/builder/site:latest@${SHA_A}`),
		).toBe("agenthits.asuscomm.com:80/builder/site");
	});
});

describe("pickPushedImageDigest", () => {
	it("picks the matching registry repository digest over bare local entries", () => {
		const target = "agenthits.asuscomm.com:80/builder/hitproxy-site:latest";
		const resolved = pickPushedImageDigest(target, [
			`hitproxy-site@${SHA_A}`,
			`agenthits.asuscomm.com:80/builder/hitproxy-site@${SHA_A.toUpperCase()}`,
		]);
		expect(resolved).toBe(
			`agenthits.asuscomm.com:80/builder/hitproxy-site@${SHA_A}`,
		);
	});

	it("does not match a digest belonging to a different registry", () => {
		const target = "agenthits.asuscomm.com:80/builder/hitproxy-site:latest";
		expect(
			pickPushedImageDigest(target, [
				`other.registry.local:5000/builder/hitproxy-site@${SHA_A}`,
				`hitproxy-site@${SHA_A}`,
			]),
		).toBeNull();
	});

	it("matches Docker Hub canonical repo aliases", () => {
		expect(
			pickPushedImageDigest("myorg/myapp:latest", [
				`docker.io/myorg/myapp@${SHA_A}`,
			]),
		).toBe(`myorg/myapp@${SHA_A}`);
		expect(
			pickPushedImageDigest("nginx:alpine", [
				`index.docker.io/library/nginx@${SHA_A}`,
			]),
		).toBe(`nginx@${SHA_A}`);
	});

	it("returns already digest-pinned references unchanged and rejects missing/invalid digests", () => {
		const pinned = `agenthits.asuscomm.com:80/builder/app@${SHA_A}`;
		expect(pickPushedImageDigest(pinned, [])).toBe(pinned);
		expect(
			pickPushedImageDigest("agenthits.asuscomm.com:80/builder/app:latest", [
				"agenthits.asuscomm.com:80/builder/app@sha256:short",
			]),
		).toBeNull();
	});
});

describe("preservePinnedDigestOnReload", () => {
	it("preserves the existing service digest when the target repository matches", () => {
		expect(
			preservePinnedDigestOnReload(
				"agenthits.asuscomm.com:80/builder/app:latest",
				`agenthits.asuscomm.com:80/builder/app@${SHA_B}`,
			),
		).toBe(`agenthits.asuscomm.com:80/builder/app@${SHA_B}`);
	});

	it("drops the old digest when the repository changes or the desired ref is already pinned", () => {
		expect(
			preservePinnedDigestOnReload(
				"ghcr.io/agenthits/app:latest",
				`agenthits.asuscomm.com:80/builder/app@${SHA_B}`,
			),
		).toBeUndefined();
		expect(
			preservePinnedDigestOnReload(
				`agenthits.asuscomm.com:80/builder/app@${SHA_A}`,
				`agenthits.asuscomm.com:80/builder/app@${SHA_B}`,
			),
		).toBeUndefined();
		expect(
			preservePinnedDigestOnReload(
				"agenthits.asuscomm.com:80/builder/app:latest",
				"agenthits.asuscomm.com:80/builder/app:latest",
			),
		).toBeUndefined();
	});
});

describe("resolvePushedImageRef", () => {
	it("inspects the pushed image on the Docker daemon and returns a pinned @sha256 ref", async () => {
		const { docker, seen } = await startDaemon(() => ({
			status: 200,
			body: {
				Id: SHA_B,
				RepoDigests: [
					`hitproxy-siteastro-dev-lq96li@${SHA_A}`,
					`agenthits.asuscomm.com:80/builder/hitproxy-siteastro-dev-lq96li@${SHA_A}`,
				],
			},
		}));

		const ref = await resolvePushedImageRef({
			docker,
			imageRef:
				"agenthits.asuscomm.com:80/builder/hitproxy-siteastro-dev-lq96li:latest",
		});

		expect(ref).toBe(
			`agenthits.asuscomm.com:80/builder/hitproxy-siteastro-dev-lq96li@${SHA_A}`,
		);
		expect(seen[0]?.method).toBe("GET");
		expect(seen[0]?.path.split("?")[0]).toBe(
			"/images/agenthits.asuscomm.com:80/builder/hitproxy-siteastro-dev-lq96li:latest/json",
		);
		expect(seen[0]?.path).not.toContain("abortSignal");
	});

	it("aborts cleanly when the Docker daemon hangs past timeoutMs", async () => {
		const { docker } = await startDaemon(() => "silent");
		await expect(
			resolvePushedImageRef({
				docker,
				imageRef: "agenthits.asuscomm.com:80/builder/slow:latest",
				timeoutMs: 100,
			}),
		).rejects.toThrow();
	});
});
