import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({
	db: {},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

const {
	getAgentHitsUpdateCommand,
	getAgentHitsUpdateData,
	getDokployVersionData,
	getForkDokployVersion,
	getOfficialDokployVersion,
	getUpdateData,
	isAgentHitsUpdateChannel,
} = await import("@dokploy/server/services/settings");

const originalEnv = { ...process.env };

const resetVersionEnv = () => {
	process.env.DOKPLOY_OFFICIAL_VERSION = originalEnv.DOKPLOY_OFFICIAL_VERSION;
	process.env.DOKPLOY_FORK_VERSION = originalEnv.DOKPLOY_FORK_VERSION;
	process.env.DOKPLOY_UPDATE_SOURCE = originalEnv.DOKPLOY_UPDATE_SOURCE;
	process.env.DOKPLOY_AGENTHITS_UPDATE_IMAGE =
		originalEnv.DOKPLOY_AGENTHITS_UPDATE_IMAGE;
	process.env.DOKPLOY_AGENTHITS_UPDATE_TAG =
		originalEnv.DOKPLOY_AGENTHITS_UPDATE_TAG;
	process.env.RELEASE_TAG = originalEnv.RELEASE_TAG;
};

const createJsonResponse = (
	body: unknown,
	headers: Record<string, string> = {},
) =>
	({
		ok: true,
		status: 200,
		headers: {
			get: (name: string) => headers[name.toLowerCase()] ?? null,
		},
		json: async () => body,
	}) as Response;

describe("AgentHits fork version metadata", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.DOKPLOY_OFFICIAL_VERSION;
		delete process.env.DOKPLOY_FORK_VERSION;
		delete process.env.DOKPLOY_UPDATE_SOURCE;
		delete process.env.DOKPLOY_AGENTHITS_UPDATE_IMAGE;
		delete process.env.DOKPLOY_AGENTHITS_UPDATE_TAG;
		delete process.env.RELEASE_TAG;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetVersionEnv();
	});

	it("uses the current package version as official fallback", () => {
		expect(getOfficialDokployVersion("v0.29.8")).toBe("v0.29.8");
	});

	it("prefers build-time official and fork version metadata", () => {
		process.env.DOKPLOY_OFFICIAL_VERSION = "v0.29.8";
		process.env.DOKPLOY_FORK_VERSION = "off_v0.29.8/Fork_157+abc123def456";
		process.env.RELEASE_TAG = "agenthits-dev";

		expect(getDokployVersionData("v0.29.8")).toEqual({
			officialVersion: "v0.29.8",
			forkVersion: "off_v0.29.8/Fork_157+abc123def456",
			releaseTag: "agenthits-dev",
			isFork: true,
		});
	});

	it("falls back to the release tag for fork installs without build metadata", () => {
		process.env.RELEASE_TAG = "agenthits-dev";

		expect(getForkDokployVersion("v0.29.8")).toBe("agenthits-dev");
		expect(getDokployVersionData("v0.29.8")).toEqual({
			officialVersion: "v0.29.8",
			forkVersion: "agenthits-dev",
			releaseTag: "agenthits-dev",
			isFork: true,
		});
	});

	it("keeps official latest installs marked as non-fork without fork metadata", () => {
		expect(getDokployVersionData("v0.29.8")).toEqual({
			officialVersion: "v0.29.8",
			forkVersion: "v0.29.8",
			releaseTag: "latest",
			isFork: false,
		});
	});

	it("detects AgentHits update channel from fork metadata", () => {
		process.env.DOKPLOY_FORK_VERSION = "off_v0.29.8/Fork_158+c4ad5a3ab4d3";

		expect(isAgentHitsUpdateChannel("v0.29.8")).toBe(true);
	});

	it("checks AgentHits updates through GHCR image digest and config metadata", async () => {
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "ghcr.io/agenthits/dokploy:agenthits-dev@sha256:current\n",
			stderr: "",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url.includes("/token")) {
					return createJsonResponse({ token: "token" });
				}
				if (url.endsWith("/manifests/agenthits-dev")) {
					return createJsonResponse(
						{
							manifests: [
								{
									digest: "sha256:image",
									platform: { architecture: "amd64", os: "linux" },
								},
							],
						},
						{ "docker-content-digest": "sha256:latest" },
					);
				}
				if (url.endsWith("/manifests/sha256:image")) {
					return createJsonResponse({
						config: { digest: "sha256:config" },
					});
				}
				if (url.endsWith("/blobs/sha256:config")) {
					return createJsonResponse({
						config: {
							Env: [
								"DOKPLOY_OFFICIAL_VERSION=v0.29.8",
								"DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_159+next",
							],
						},
					});
				}

				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		expect(await getAgentHitsUpdateData("v0.29.8")).toEqual({
			latestVersion: "off_v0.29.8/Fork_159+next",
			updateAvailable: true,
			updateSource: "agenthits",
			latestImage: "ghcr.io/agenthits/dokploy:agenthits-dev",
			latestOfficialVersion: "v0.29.8",
			currentDigest: "sha256:current",
			latestDigest: "sha256:latest",
			latestPlatformDigest: "sha256:image",
		});
	});

	it("checks AgentHits updates when the tag is a bare manifest without an index", async () => {
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "ghcr.io/agenthits/dokploy:agenthits-dev@sha256:current\n",
			stderr: "",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url.includes("/token")) {
					return createJsonResponse({ token: "token" });
				}
				if (url.endsWith("/manifests/agenthits-dev")) {
					return createJsonResponse(
						{ config: { digest: "sha256:config" } },
						{ "docker-content-digest": "sha256:latest" },
					);
				}
				if (url.endsWith("/blobs/sha256:config")) {
					return createJsonResponse({
						config: {
							Env: [
								"DOKPLOY_OFFICIAL_VERSION=v0.29.8",
								"DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_159+next",
							],
						},
					});
				}

				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		expect(await getAgentHitsUpdateData("v0.29.8")).toMatchObject({
			latestVersion: "off_v0.29.8/Fork_159+next",
			updateAvailable: true,
			latestDigest: "sha256:latest",
			latestPlatformDigest: "sha256:latest",
		});
	});

	it("routes generic update checks to GHCR and detects stale fork metadata", async () => {
		process.env.RELEASE_TAG = "agenthits-dev";
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "ghcr.io/agenthits/dokploy:agenthits-dev@sha256:latest\n",
			stderr: "",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url.includes("/token")) {
					return createJsonResponse({ token: "token" });
				}
				if (url.endsWith("/manifests/agenthits-dev")) {
					return createJsonResponse(
						{
							manifests: [
								{
									digest: "sha256:image",
									platform: { architecture: "amd64", os: "linux" },
								},
							],
						},
						{ "docker-content-digest": "sha256:latest" },
					);
				}
				if (url.endsWith("/manifests/sha256:image")) {
					return createJsonResponse({
						config: { digest: "sha256:config" },
					});
				}
				if (url.endsWith("/blobs/sha256:config")) {
					return createJsonResponse({
						config: {
							Env: ["DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_159+next"],
						},
					});
				}

				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		expect(await getUpdateData("v0.29.8")).toMatchObject({
			latestVersion: "off_v0.29.8/Fork_159+next",
			updateAvailable: true,
			updateSource: "agenthits",
		});
	});

	it("detects stale AgentHits metadata when the current service image is tag-only", async () => {
		process.env.RELEASE_TAG = "agenthits-dev";
		process.env.DOKPLOY_FORK_VERSION = "off_v0.29.8/Fork_162+73ae6bcdf8b4";
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "ghcr.io/agenthits/dokploy:agenthits-dev\n",
			stderr: "",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url.includes("/token")) {
					return createJsonResponse({ token: "token" });
				}
				if (url.endsWith("/manifests/agenthits-dev")) {
					return createJsonResponse(
						{
							manifests: [
								{
									digest: "sha256:image",
									platform: { architecture: "amd64", os: "linux" },
								},
							],
						},
						{ "docker-content-digest": "sha256:latest" },
					);
				}
				if (url.endsWith("/manifests/sha256:image")) {
					return createJsonResponse({
						config: { digest: "sha256:config" },
					});
				}
				if (url.endsWith("/blobs/sha256:config")) {
					return createJsonResponse({
						config: {
							Env: [
								"DOKPLOY_OFFICIAL_VERSION=v0.29.8",
								"DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_164+0944dc204f55",
							],
						},
					});
				}

				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		expect(await getUpdateData("v0.29.8")).toMatchObject({
			latestVersion: "off_v0.29.8/Fork_164+0944dc204f55",
			updateAvailable: true,
			updateSource: "agenthits",
			currentDigest: null,
			latestDigest: "sha256:latest",
			latestPlatformDigest: "sha256:image",
		});
	});

	it("keeps tag-only AgentHits services up to date when metadata already matches", async () => {
		process.env.RELEASE_TAG = "agenthits-dev";
		process.env.DOKPLOY_FORK_VERSION = "off_v0.29.8/Fork_164+0944dc204f55";
		process.env.DOKPLOY_OFFICIAL_VERSION = "v0.29.8";
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "ghcr.io/agenthits/dokploy:agenthits-dev\n",
			stderr: "",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url.includes("/token")) {
					return createJsonResponse({ token: "token" });
				}
				if (url.endsWith("/manifests/agenthits-dev")) {
					return createJsonResponse(
						{
							manifests: [
								{
									digest: "sha256:image",
									platform: { architecture: "amd64", os: "linux" },
								},
							],
						},
						{ "docker-content-digest": "sha256:latest" },
					);
				}
				if (url.endsWith("/manifests/sha256:image")) {
					return createJsonResponse({
						config: { digest: "sha256:config" },
					});
				}
				if (url.endsWith("/blobs/sha256:config")) {
					return createJsonResponse({
						config: {
							Env: [
								"DOKPLOY_OFFICIAL_VERSION=v0.29.8",
								"DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_164+0944dc204f55",
							],
						},
					});
				}

				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		expect(await getUpdateData("v0.29.8")).toMatchObject({
			latestVersion: "off_v0.29.8/Fork_164+0944dc204f55",
			updateAvailable: false,
			updateSource: "agenthits",
			currentDigest: null,
		});
	});

	it("falls back to default update data when AgentHits update metadata cannot be fetched", async () => {
		process.env.RELEASE_TAG = "agenthits-dev";
		process.env.DOKPLOY_FORK_VERSION = "off_v0.29.8/Fork_162+73ae6bcdf8b4";
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockRejectedValue(new Error("inspect failed"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		expect(await getUpdateData("v0.29.8")).toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
		expect(consoleError).toHaveBeenCalledWith(
			"Error fetching update data:",
			expect.any(Error),
		);
	});

	it("keeps tag-only official canary services marked as up to date", async () => {
		process.env.RELEASE_TAG = "canary";
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "dokploy/dokploy:canary\n",
			stderr: "",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				createJsonResponse({
					next: null,
					results: [{ name: "canary", digest: "sha256:latest" }],
				}),
			),
		);

		expect(await getUpdateData("v0.29.8")).toEqual({
			latestVersion: "canary",
			updateAvailable: false,
		});
	});

	it("treats the AgentHits platform manifest digest as up to date", async () => {
		process.env.RELEASE_TAG = "agenthits-dev";
		process.env.DOKPLOY_FORK_VERSION = "off_v0.29.8/Fork_159+next";
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "ghcr.io/agenthits/dokploy:agenthits-dev@sha256:image\n",
			stderr: "",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url.includes("/token")) {
					return createJsonResponse({ token: "token" });
				}
				if (url.endsWith("/manifests/agenthits-dev")) {
					return createJsonResponse(
						{
							manifests: [
								{
									digest: "sha256:image",
									platform: { architecture: "amd64", os: "linux" },
								},
							],
						},
						{ "docker-content-digest": "sha256:latest" },
					);
				}
				if (url.endsWith("/manifests/sha256:image")) {
					return createJsonResponse({
						config: { digest: "sha256:config" },
					});
				}
				if (url.endsWith("/blobs/sha256:config")) {
					return createJsonResponse({
						config: {
							Env: ["DOKPLOY_FORK_VERSION=off_v0.29.8/Fork_159+next"],
						},
					});
				}

				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		expect(await getUpdateData("v0.29.8")).toMatchObject({
			updateAvailable: false,
			currentDigest: "sha256:image",
			latestDigest: "sha256:latest",
			latestPlatformDigest: "sha256:image",
		});
	});

	it("builds an AgentHits service update command with latest fork metadata", () => {
		const command = getAgentHitsUpdateCommand(
			"v0.29.8",
			"off_v0.29.8/Fork_159+next",
			"v0.30.0",
		);

		expect(command).toContain(
			"docker pull ghcr.io/agenthits/dokploy\\:agenthits-dev",
		);
		expect(command).toContain('--image "$pinned_image"');
		expect(command).toContain("--env-add RELEASE_TAG\\=agenthits-dev");
		expect(command).toContain("--env-add DOKPLOY_OFFICIAL_VERSION\\=v0.30.0");
		expect(command).toContain(
			"--env-add DOKPLOY_FORK_VERSION\\=off_v0.29.8/Fork_159+next",
		);
	});
});
