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
	getAgentHitsUpdateImage,
	getDokployVersionData,
	getForkDokployVersion,
	getOfficialDokployVersion,
	getUpdateData,
	isAgentHitsUpdateChannel,
	isOlderAgentHitsVersion,
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
				if (url.endsWith("/manifests/agenthits-stable")) {
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
			latestImage: "ghcr.io/agenthits/dokploy:agenthits-stable",
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
				if (url.endsWith("/manifests/agenthits-stable")) {
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
				if (url.endsWith("/manifests/agenthits-stable")) {
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
				if (url.endsWith("/manifests/agenthits-stable")) {
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
				if (url.endsWith("/manifests/agenthits-stable")) {
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
				if (url.endsWith("/manifests/agenthits-stable")) {
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
			"docker pull ghcr.io/agenthits/dokploy\\:agenthits-stable",
		);
		expect(command).toContain('--image "$pinned_image"');
		expect(command).toContain("--env-add RELEASE_TAG\\=agenthits-stable");
		expect(command).toContain("--env-add DOKPLOY_OFFICIAL_VERSION\\=v0.30.0");
		expect(command).toContain(
			"--env-add DOKPLOY_FORK_VERSION\\=off_v0.29.8/Fork_159+next",
		);
	});
});

describe("AgentHits release channel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.DOKPLOY_AGENTHITS_UPDATE_IMAGE;
		delete process.env.DOKPLOY_AGENTHITS_UPDATE_TAG;
		delete process.env.DOKPLOY_OFFICIAL_VERSION;
		process.env.RELEASE_TAG = "agenthits-stable";
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetVersionEnv();
	});

	const stubLatestRelease = async (forkVersion: string) => {
		const { execAsync } = await import(
			"@dokploy/server/utils/process/execAsync"
		);
		vi.mocked(execAsync).mockResolvedValue({
			stdout: "ghcr.io/agenthits/dokploy:agenthits-dev@sha256:running\n",
			stderr: "",
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/token")) {
				return createJsonResponse({ token: "token" });
			}
			if (url.endsWith("/manifests/agenthits-stable")) {
				return createJsonResponse(
					{ config: { digest: "sha256:config" } },
					{ "docker-content-digest": "sha256:release" },
				);
			}
			if (url.endsWith("/blobs/sha256:config")) {
				return createJsonResponse({
					config: {
						Env: [
							"DOKPLOY_OFFICIAL_VERSION=v0.30.6",
							`DOKPLOY_FORK_VERSION=${forkVersion}`,
						],
					},
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	};

	it("updates from the newest published release by default", () => {
		expect(getAgentHitsUpdateImage()).toBe(
			"ghcr.io/agenthits/dokploy:agenthits-stable",
		);
		process.env.DOKPLOY_AGENTHITS_UPDATE_TAG = "agenthits-dev";
		expect(getAgentHitsUpdateImage()).toBe(
			"ghcr.io/agenthits/dokploy:agenthits-dev",
		);
	});

	it.each([
		["agenthits-v1.1.0", "agenthits-v1.1.0-1-gba742e125f30", true],
		["agenthits-v1.0.9", "agenthits-v1.1.0", true],
		["agenthits-v1.9.9", "agenthits-v1.10.0", true],
		["agenthits-v1.1.1", "agenthits-v1.1.0-3-gabcdef012345", false],
		["agenthits-v1.1.0", "agenthits-v1.1.0", false],
		["agenthits-v2.0.0", "agenthits-v1.10.4-7-gabcdef012345", false],
		["agenthits-v1.1.0", "off_v0.29.8/Fork_159+next", false],
		["agenthits-v1.1.0", "agenthits-dev-abcdef012345", false],
	])("treats %s as older than %s: %s", (candidate, current, older) => {
		expect(isOlderAgentHitsVersion(candidate, current)).toBe(older);
	});

	it("does not offer a build made after the release that older release", async () => {
		process.env.DOKPLOY_FORK_VERSION = "agenthits-v1.1.0-1-gba742e125f30";
		const fetchMock = await stubLatestRelease("agenthits-v1.1.0");

		const data = await getAgentHitsUpdateData("v0.30.6");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://ghcr.io/v2/agenthits/dokploy/manifests/agenthits-stable",
			expect.anything(),
		);
		expect(data).toMatchObject({
			latestVersion: "agenthits-v1.1.0",
			updateAvailable: false,
			currentDigest: "sha256:running",
			latestDigest: "sha256:release",
		});
	});

	it("offers the next release to a build made after the previous one", async () => {
		process.env.DOKPLOY_FORK_VERSION = "agenthits-v1.1.0-1-gba742e125f30";
		await stubLatestRelease("agenthits-v1.1.1");

		expect(await getAgentHitsUpdateData("v0.30.6")).toMatchObject({
			latestVersion: "agenthits-v1.1.1",
			updateAvailable: true,
		});
	});

	it("offers a rebuilt image of the same release", async () => {
		process.env.DOKPLOY_FORK_VERSION = "agenthits-v1.1.0";
		await stubLatestRelease("agenthits-v1.1.0");

		expect(await getAgentHitsUpdateData("v0.30.6")).toMatchObject({
			latestVersion: "agenthits-v1.1.0",
			updateAvailable: true,
		});
	});
});
