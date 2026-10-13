import type { DokployImageInfo } from "@dokploy/server/services/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execAsync } = vi.hoisted(() => ({ execAsync: vi.fn() }));

vi.mock("@dokploy/server/db", () => ({
	db: {},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync,
	execAsyncRemote: vi.fn(),
}));

const {
	getRemovableDokployImages,
	getUpdateDiskSpace,
	removeOldDokployImages,
} = await import("@dokploy/server/services/settings");

const PREVIOUS = `sha256:${"b".repeat(64)}`;

const info = (
	id: string,
	overrides: Partial<DokployImageInfo> = {},
): DokployImageInfo => ({
	id,
	tags: [],
	createdAt: "2026-10-07T10:00:00Z",
	sizeBytes: 4_000_000_000,
	uniqueSizeBytes: 1_000_000_000,
	forkVersion: null,
	officialVersion: null,
	isCurrent: false,
	dokployTaskContainers: 0,
	otherContainers: 0,
	...overrides,
});

describe("removable Dokploy images", () => {
	it("keeps the running and the previous image", () => {
		const images = [
			info("sha256:new", { isCurrent: true }),
			info(PREVIOUS),
			info("sha256:old1"),
			info("sha256:old2"),
		];

		expect(
			getRemovableDokployImages(images, PREVIOUS).map((image) => image.id),
		).toEqual(["sha256:old1", "sha256:old2"]);
	});

	it("keeps the newest older image when no previous one was recorded", () => {
		const images = [
			info("sha256:new", { isCurrent: true }),
			info("sha256:old1"),
			info("sha256:old2"),
		];

		expect(
			getRemovableDokployImages(images, null).map((image) => image.id),
		).toEqual(["sha256:old2"]);
	});

	it("skips images that other containers still use", () => {
		const images = [
			info("sha256:new", { isCurrent: true }),
			info(PREVIOUS),
			info("sha256:old1", { otherContainers: 1 }),
		];

		expect(getRemovableDokployImages(images, PREVIOUS)).toEqual([]);
	});
});

describe("update disk space", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("DOKPLOY_PREVIOUS_IMAGE", PREVIOUS);
		vi.stubEnv("DOKPLOY_AGENTHITS_UPDATE_IMAGE", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const image = (id: string, createdAt: string) =>
		JSON.stringify({
			id,
			createdAt,
			size: 4_450_000_000,
			tags: [],
			config: { Env: [] },
		});

	it("reports free space, old builds and the build cache", async () => {
		execAsync.mockImplementation(async (command: string) => {
			if (command.startsWith("df ")) {
				return {
					stdout:
						"Filesystem     1024-blocks     Used Available Capacity Mounted on\noverlay           51475068 36000000  15000000      71% /\n",
					stderr: "",
				};
			}
			if (command.startsWith("docker image ls")) {
				return {
					stdout: `sha256:new\n${PREVIOUS}\nsha256:old\n`,
					stderr: "",
				};
			}
			if (command.startsWith("docker image inspect")) {
				return {
					stdout: [
						image("sha256:new", "2026-10-07T12:00:00Z"),
						image(PREVIOUS, "2026-10-07T11:00:00Z"),
						image("sha256:old", "2026-10-07T10:00:00Z"),
					].join("\n"),
					stderr: "",
				};
			}
			if (command.startsWith("docker system df -v")) {
				return {
					stdout: JSON.stringify({
						Images: [{ ID: "sha256:old", UniqueSize: "1.5GB" }],
					}),
					stderr: "",
				};
			}
			if (command.startsWith("docker system df")) {
				return {
					stdout: [
						JSON.stringify({ Type: "Images", Reclaimable: "70MB (0%)" }),
						JSON.stringify({ Type: "Build Cache", Reclaimable: "6.193GB" }),
					].join("\n"),
					stderr: "",
				};
			}
			return {
				stdout: JSON.stringify({
					image: "sha256:new",
					running: true,
					service: "dokploy",
				}),
				stderr: "",
			};
		});

		await expect(getUpdateDiskSpace()).resolves.toEqual({
			availableBytes: 15_000_000 * 1024,
			totalBytes: 51_475_068 * 1024,
			requiredBytes: 4_450_000_000,
			oldImageCount: 1,
			oldImageBytes: 1_500_000_000,
			oldImages: [
				expect.objectContaining({
					id: "sha256:old",
					uniqueSizeBytes: 1_500_000_000,
				}),
			],
			buildCacheBytes: 6_193_000_000,
		});
	});

	it("still answers when Docker and df fail", async () => {
		execAsync.mockRejectedValue(new Error("docker is down"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(getUpdateDiskSpace()).resolves.toEqual({
			availableBytes: null,
			totalBytes: null,
			requiredBytes: null,
			oldImageCount: 0,
			oldImageBytes: 0,
			oldImages: [],
			buildCacheBytes: 0,
		});
	});

	it("removes every old build but the previous one", async () => {
		execAsync.mockResolvedValue({ stdout: "", stderr: "" });

		await removeOldDokployImages();

		const command = execAsync.mock.calls[0]?.[0] as string;
		expect(command).toContain(`protected="${PREVIOUS}"`);
		expect(command).toContain("tail -n +1 ");
	});
});
