import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dial: vi.fn(),
	info: vi.fn(),
	listContainers: vi.fn(),
	execAsync: vi.fn(),
	readFile: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	docker: {
		modem: { dial: mocks.dial },
		info: mocks.info,
		listContainers: mocks.listContainers,
	},
	paths: () => ({ BASE_PATH: "/etc/dokploy" }),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
}));

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		promises: { ...original.promises, readFile: mocks.readFile },
	};
});

const {
	parseDuOutput,
	parseSwapFileBytes,
	probeDockerUsage,
	probeSlowUsage,
	summarizeDockerDiskUsage,
} = await import("@dokploy/server/monitoring/disk-usage");

const GB = 1e9;
const ANONYMOUS = "a".repeat(64);

const answerDiskUsage = (answers: Record<string, unknown>) => {
	mocks.dial.mockImplementation(
		(
			request: { options: { type: string[] } },
			callback: (error: Error | null, data?: unknown) => void,
		) => {
			const answer = answers[request.options.type.join(",")];
			if (answer instanceof Error) {
				callback(answer);
				return;
			}
			callback(null, answer);
		},
	);
};

describe("summarizeDockerDiskUsage", () => {
	it("groups images by repository and counts only what each one owns", () => {
		const { parts, items } = summarizeDockerDiskUsage({
			LayersSize: 5 * GB,
			Images: [
				{
					RepoTags: ["registry.example:5000/shop/web:v2"],
					Size: 3 * GB,
					SharedSize: 2 * GB,
				},
				{
					RepoTags: ["<none>:<none>"],
					RepoDigests: ["registry.example:5000/shop/web@sha256:abc"],
					Size: 3 * GB,
					SharedSize: 2.5 * GB,
				},
				{ RepoTags: null, RepoDigests: [], Size: 1 * GB, SharedSize: -1 },
			],
		});

		expect(parts).toEqual({ images: 5 * GB });
		expect(items).toEqual({
			"image:registry.example:5000/shop/web": 1.5 * GB,
			"image:untagged": 1 * GB,
		});
	});

	it("adds up the tasks of one swarm service", () => {
		const { parts, items, itemKinds } = summarizeDockerDiskUsage({
			Containers: [
				{
					Names: ["/web.1.abc"],
					Labels: { "com.docker.swarm.service.name": "web" },
					SizeRw: 10,
				},
				{
					Names: ["/web.1.def"],
					Labels: { "com.docker.swarm.service.name": "web" },
					SizeRw: 5,
				},
				{ Names: ["/compose-db-1"], Labels: {}, SizeRw: 7 },
				{ Id: "0123456789abcdef", Names: [] },
			],
		});

		expect(parts).toEqual({ containers: 22 });
		expect(items).toEqual({
			"container:web": 15,
			"container:compose-db-1": 7,
			"container:0123456789ab": 0,
		});
		expect(itemKinds).toEqual(["container"]);
	});

	it("folds anonymous volumes into one item", () => {
		const { parts, items } = summarizeDockerDiskUsage({
			Volumes: [
				{ Name: "pg-data", UsageData: { Size: 4 * GB } },
				{ Name: ANONYMOUS, UsageData: { Size: 100 } },
				{ Name: "b".repeat(64), UsageData: { Size: 50 } },
				{ Name: "unmeasured", UsageData: { Size: -1 } },
			],
		});

		expect(parts).toEqual({ volumes: 4 * GB + 150 });
		expect(items).toEqual({
			"volume:pg-data": 4 * GB,
			"volume:anonymous volumes": 150,
			"volume:unmeasured": 0,
		});
	});

	it("leaves out build cache that images already count", () => {
		const { parts, items } = summarizeDockerDiskUsage({
			BuildCache: [
				{ Size: 6 * GB, Shared: false },
				{ Size: 1 * GB, Shared: true },
				{ Size: 2 * GB },
			],
		});

		expect(parts).toEqual({ buildCache: 8 * GB });
		expect(items).toEqual({});
	});

	it("reads the sections Docker moved under the Usage objects", () => {
		const { parts, items, itemKinds } = summarizeDockerDiskUsage({
			ImageUsage: {
				TotalSize: 2 * GB,
				Items: [{ RepoTags: ["web:latest"], Size: 2 * GB, SharedSize: 0 }],
			},
			ContainerUsage: {
				TotalSize: 9,
				Items: [{ Names: ["/web"], SizeRw: 9 }],
			},
			VolumeUsage: {
				TotalSize: 3,
				Items: [{ Name: "data", UsageData: { Size: 3 } }],
			},
			BuildCacheUsage: { TotalSize: 4, Items: [{ Size: 4, Shared: false }] },
		});

		expect(parts).toEqual({
			images: 2 * GB,
			containers: 9,
			volumes: 3,
			buildCache: 4,
		});
		expect(items).toEqual({
			"image:web": 2 * GB,
			"container:web": 9,
			"volume:data": 3,
		});
		expect(itemKinds).toEqual(["image", "container", "volume"]);
	});

	it("says nothing about a section Docker was not asked for", () => {
		expect(summarizeDockerDiskUsage({ Images: null })).toEqual({
			parts: {},
			items: {},
			itemKinds: [],
		});
	});
});

describe("parseDuOutput", () => {
	it("turns kilobytes into bytes per path", () => {
		expect([
			...parseDuOutput("4\t/data/a\n1024\t/data/with space\n2048\t/data\n"),
		]).toEqual([
			["/data/a", 4096],
			["/data/with space", 1024 * 1024],
			["/data", 2048 * 1024],
		]);
	});

	it("ignores lines that are not sizes", () => {
		expect(parseDuOutput("du: cannot read directory\n").size).toBe(0);
	});
});

describe("parseSwapFileBytes", () => {
	it("counts swap files and skips swap partitions", () => {
		const procSwaps = [
			"Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority",
			"/swapfile                               file\t\t2097148\t\t178280\t\t-3",
			"/dev/sda2                               partition\t4194300\t\t0\t\t-2",
			"/mnt/my\\040swap                         file\t\t1048572\t\t0\t\t-4",
		].join("\n");

		expect(parseSwapFileBytes(procSwaps)).toBe((2097148 + 1048572) * 1024);
	});

	it("is zero without swap", () => {
		expect(
			parseSwapFileBytes("Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n"),
		).toBe(0);
	});
});

describe("disk usage probes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("asks Docker only for what it answers from metadata", async () => {
		answerDiskUsage({
			"image,container,build-cache": {
				LayersSize: 10,
				Images: [{ RepoTags: ["web:1"], Size: 10, SharedSize: 0 }],
				Containers: [],
				BuildCache: [{ Size: 3, Shared: false }],
			},
		});

		await expect(probeDockerUsage()).resolves.toEqual({
			parts: { images: 10, containers: 0, buildCache: 3 },
			items: { "image:web": 10 },
			itemKinds: ["image", "container"],
		});
		expect(mocks.dial.mock.calls[0]?.[0]).toMatchObject({
			path: "/system/df?",
			method: "GET",
		});
	});

	it("reports nothing when Docker does not answer", async () => {
		answerDiskUsage({
			"image,container,build-cache": new Error("docker is down"),
		});

		await expect(probeDockerUsage()).resolves.toEqual({
			parts: {},
			items: {},
			itemKinds: [],
		});
	});

	it("measures volumes, container logs, Dokploy data and swap files", async () => {
		const containerId = "c".repeat(64);
		answerDiskUsage({
			volume: { Volumes: [{ Name: "pg-data", UsageData: { Size: 500 } }] },
		});
		mocks.info.mockResolvedValue({ DockerRootDir: "/var/lib/docker" });
		mocks.listContainers.mockResolvedValue([
			{
				Id: containerId,
				Names: ["/web.1.abc"],
				Labels: { "com.docker.swarm.service.name": "web" },
			},
		]);
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.startsWith("docker run")) {
				return {
					stdout: `100\t/docker-containers/${containerId}\n8\t/docker-containers/${"d".repeat(64)}\n108\t/docker-containers\n`,
					stderr: "",
				};
			}
			return {
				stdout:
					"40\t/etc/dokploy/logs\n4\t/etc/dokploy/ssh\n50\t/etc/dokploy\n",
				stderr: "",
			};
		});
		mocks.readFile.mockResolvedValue(
			"Filename Type Size Used Priority\n/swapfile file 1024 0 -2\n",
		);

		await expect(probeSlowUsage()).resolves.toEqual({
			parts: {
				volumes: 500,
				containerLogs: 108 * 1024,
				dokployData: 50 * 1024,
				swap: 1024 * 1024,
			},
			items: {
				"volume:pg-data": 500,
				"containerLog:web": 100 * 1024,
				"containerLog:dddddddddddd": 8 * 1024,
				"dokployData:logs": 40 * 1024,
				"dokployData:ssh": 4 * 1024,
			},
			itemKinds: ["volume", "containerLog", "dokployData"],
		});

		const logsCommand = mocks.execAsync.mock.calls
			.map(([command]) => command as string)
			.find((command) => command.startsWith("docker run"));
		expect(logsCommand).toContain("--network none");
		// shell-quote escapes the colons of the mount.
		expect(logsCommand?.replaceAll("\\", "")).toContain(
			"-v /var/lib/docker/containers:/docker-containers:ro busybox du",
		);
	});

	it("keeps the parts it could measure when the others fail", async () => {
		answerDiskUsage({ volume: new Error("docker is down") });
		mocks.info.mockRejectedValue(new Error("docker is down"));
		mocks.listContainers.mockRejectedValue(new Error("docker is down"));
		mocks.execAsync.mockResolvedValue({
			stdout: "50\t/etc/dokploy\n",
			stderr: "",
		});
		mocks.readFile.mockRejectedValue(new Error("no /proc on this system"));

		await expect(probeSlowUsage()).resolves.toEqual({
			parts: { dokployData: 50 * 1024 },
			items: {},
			itemKinds: ["dokployData"],
		});
	});
});
