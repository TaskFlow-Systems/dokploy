import {
	ComposeContainerError,
	waitForComposeContainers,
} from "@dokploy/server/utils/docker/compose-containers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	info: vi.fn(),
	listContainers: vi.fn(),
	inspect: vi.fn(),
	getRemoteDocker: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

const FAST = { stableMs: 60, crashLimitMs: 300, intervalMs: 10 };

type Fake = {
	id: string;
	status?: string;
	restarting?: boolean;
	exitCode?: number;
	oomKilled?: boolean;
	startedAgoMs?: number;
	createdAgoMs?: number;
	restartCount?: number;
	health?: { Status: string; FailingStreak?: number };
	policy?: { Name: string; MaximumRetryCount?: number };
	oneoff?: boolean;
};

// The daemon's clock runs an hour ahead of the panel's, so only differences count.
const DAEMON_AHEAD_MS = 3_600_000;
const daemonIso = (agoMs: number) =>
	new Date(Date.now() + DAEMON_AHEAD_MS - agoMs).toISOString();

let containers: Fake[] = [];
let sequence: Array<(containers: Fake[]) => Fake[]> = [];

// A fake's times are fixed when it is first read, as a real container's are.
const times = new WeakMap<Fake, { created: string; started: string }>();
const inspected = (fake: Fake) => {
	if (!times.has(fake)) {
		times.set(fake, {
			created: daemonIso(fake.createdAgoMs ?? fake.startedAgoMs ?? 60_000),
			started: daemonIso(fake.startedAgoMs ?? 60_000),
		});
	}
	const { created, started } = times.get(fake) ?? { created: "", started: "" };
	return {
		Id: fake.id,
		Name: `/${fake.id}`,
		Created: created,
		RestartCount: fake.restartCount ?? 0,
		State: {
			Status: fake.status ?? "running",
			Restarting: fake.restarting ?? false,
			OOMKilled: fake.oomKilled ?? false,
			ExitCode: fake.exitCode ?? 0,
			StartedAt: started,
			Health: fake.health,
		},
		HostConfig: { RestartPolicy: fake.policy ?? { Name: "no" } },
	};
};

beforeEach(() => {
	vi.clearAllMocks();
	containers = [];
	sequence = [];
	mocks.info.mockImplementation(async () => ({
		SystemTime: daemonIso(0),
	}));
	mocks.listContainers.mockImplementation(async () => {
		const next = sequence.shift();
		if (next) containers = next(containers);
		return containers.map((fake) => ({
			Id: fake.id,
			Labels: fake.oneoff ? { "com.docker.compose.oneoff": "True" } : {},
		}));
	});
	mocks.inspect.mockImplementation(async (id: string) => {
		const fake = containers.find((container) => container.id === id);
		if (!fake)
			throw Object.assign(new Error("no such container"), { statusCode: 404 });
		return inspected(fake);
	});
	mocks.getRemoteDocker.mockResolvedValue({
		info: mocks.info,
		listContainers: mocks.listContainers,
		getContainer: (id: string) => ({
			inspect: (options: unknown) => mocks.inspect(id, options),
		}),
	});
});

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => "",
		(error: Error) => {
			expect(error).toBeInstanceOf(ComposeContainerError);
			return error.message;
		},
	);

describe("waitForComposeContainers", () => {
	it("asks the project's server only for the project's containers", async () => {
		await expect(
			waitForComposeContainers("shop", "server-1", FAST),
		).resolves.toBe(0);

		expect(mocks.getRemoteDocker).toHaveBeenCalledWith("server-1");
		const [options] = mocks.listContainers.mock.calls[0] ?? [];
		expect(options.all).toBe(true);
		expect(JSON.parse(options.filters)).toEqual({
			label: ["com.docker.compose.project=shop"],
		});
		expect(options.abortSignal).toBeInstanceOf(AbortSignal);
		expect(mocks.info.mock.calls[0]?.[0]?.abortSignal).toBeInstanceOf(
			AbortSignal,
		);
	});

	it("passes at once when every container has been up for a while", async () => {
		containers = [{ id: "shop-web-1" }, { id: "shop-db-1" }];

		await expect(waitForComposeContainers("shop", null, FAST)).resolves.toBe(2);

		expect(mocks.listContainers).toHaveBeenCalledTimes(1);
	});

	it("waits until a container that just started has stayed up, by the daemon's clock", async () => {
		containers = [{ id: "shop-web-1", startedAgoMs: 0 }];

		await expect(waitForComposeContainers("shop", null, FAST)).resolves.toBe(1);

		expect(mocks.listContainers.mock.calls.length).toBeGreaterThan(1);
	});

	it("passes a one-shot container that exited 0", async () => {
		containers = [
			{ id: "shop-migrate-1", status: "exited", exitCode: 0, startedAgoMs: 5 },
		];

		await expect(
			waitForComposeContainers("shop", null, {
				...FAST,
				startedSince: Date.now() - 1_000,
			}),
		).resolves.toBe(1);
	});

	it("fails at once on a container that exited with an error and is not started again", async () => {
		containers = [
			{ id: "shop-web-1" },
			{ id: "shop-migrate-1", status: "exited", exitCode: 4, startedAgoMs: 5 },
		];

		const message = await failureOf(
			waitForComposeContainers("shop", null, {
				...FAST,
				crashLimitMs: 60_000,
			}),
		);

		expect(message).toBe(
			"Container shop-migrate-1 exited with code 4, and its restart policy does not start it again.",
		);
	});

	it("fails at once when on-failure has used up its retries", async () => {
		containers = [
			{
				id: "shop-worker-1",
				status: "exited",
				exitCode: 2,
				restartCount: 3,
				policy: { Name: "on-failure", MaximumRetryCount: 3 },
			},
		];

		const message = await failureOf(
			waitForComposeContainers("shop", null, { ...FAST, crashLimitMs: 60_000 }),
		);

		expect(message).toContain("exited with code 2, and its restart policy");
	});

	it("names an out-of-memory kill", async () => {
		containers = [
			{ id: "shop-web-1", status: "exited", exitCode: 137, oomKilled: true },
		];

		const message = await failureOf(
			waitForComposeContainers("shop", null, FAST),
		);

		expect(message).toContain(
			"was killed for running out of memory (exit code 137)",
		);
	});

	it("gives a crashed container time to come up, as after a database that starts late", async () => {
		containers = [
			{
				id: "shop-web-1",
				status: "restarting",
				restarting: true,
				exitCode: 1,
				policy: { Name: "always" },
			},
		];
		sequence = [
			(current) => current,
			() => [{ id: "shop-web-1", startedAgoMs: 0, restartCount: 1 }],
		];

		await expect(waitForComposeContainers("shop", null, FAST)).resolves.toBe(1);
	});

	it("fails a restart loop at the crash limit, with the last exit code, even if it is up at that moment", async () => {
		let restarts = 0;
		mocks.listContainers.mockImplementation(async () => {
			restarts += 1;
			containers = [
				restarts % 2 === 0
					? {
							id: "shop-web-1",
							status: "restarting",
							restarting: true,
							exitCode: 3,
							restartCount: restarts,
							startedAgoMs: 20,
						}
					: { id: "shop-web-1", startedAgoMs: 5, restartCount: restarts },
			];
			return [{ Id: "shop-web-1", Labels: {} }];
		});

		const message = await failureOf(
			waitForComposeContainers("shop", null, FAST),
		);

		expect(message).toMatch(
			/^Container shop-web-1 keeps restarting: it last exited with code 3 \(waited \d+ s\)\.$/,
		);
	});

	it("sees a restart between two reads, though the container is up both times", async () => {
		let reads = 0;
		mocks.listContainers.mockImplementation(async () => {
			reads += 1;
			containers = [{ id: "shop-web-1", startedAgoMs: 0, restartCount: reads }];
			return [{ Id: "shop-web-1", Labels: {} }];
		});

		const message = await failureOf(
			waitForComposeContainers("shop", null, FAST),
		);

		expect(message).toMatch(/^Container shop-web-1 keeps restarting \(waited/);
	});

	it("fails at once on an unhealthy container and waits for one whose check is starting", async () => {
		containers = [
			{ id: "shop-web-1", health: { Status: "unhealthy", FailingStreak: 3 } },
		];
		expect(await failureOf(waitForComposeContainers("shop", null, FAST))).toBe(
			"Container shop-web-1 is unhealthy: its health check failed 3 times in a row.",
		);

		containers = [{ id: "shop-web-1", health: { Status: "starting" } }];
		sequence = [
			(current) => current,
			(current) => current,
			() => [{ id: "shop-web-1", health: { Status: "healthy" } }],
		];
		await expect(waitForComposeContainers("shop", null, FAST)).resolves.toBe(1);
	});

	it("gives up on a health check that never ends at the overall limit", async () => {
		containers = [{ id: "shop-web-1", health: { Status: "starting" } }];

		const message = await failureOf(
			waitForComposeContainers("shop", null, { ...FAST, timeoutMs: 100 }),
		);

		expect(message).toMatch(
			/^Container shop-web-1 did not become healthy \(waited/,
		);
	});

	it("leaves out containers that ended before this deployment and one-off runs", async () => {
		containers = [
			{ id: "shop-web-1" },
			{
				id: "shop-old-1",
				status: "exited",
				exitCode: 1,
				startedAgoMs: 600_000,
			},
			{ id: "shop-idle-1", status: "created", createdAgoMs: 600_000 },
			{ id: "shop-run-1", status: "exited", exitCode: 1, oneoff: true },
		];

		await expect(
			waitForComposeContainers("shop", null, {
				...FAST,
				startedSince: Date.now() - 5_000,
			}),
		).resolves.toBe(1);
		expect(mocks.inspect.mock.calls.map(([id]) => id)).not.toContain(
			"shop-run-1",
		);
	});

	it("fails on a container this deployment created but did not start", async () => {
		containers = [{ id: "shop-web-1", status: "created", createdAgoMs: 10 }];

		const message = await failureOf(
			waitForComposeContainers("shop", null, {
				...FAST,
				startedSince: Date.now() - 1_000,
			}),
		);

		expect(message).toBe("Container shop-web-1 was created but did not start.");
	});

	it("reports every failed container, not only the first", async () => {
		containers = [
			{ id: "shop-a-1", status: "exited", exitCode: 1 },
			{ id: "shop-b-1", health: { Status: "unhealthy", FailingStreak: 1 } },
			{ id: "shop-c-1" },
		];

		const message = await failureOf(
			waitForComposeContainers("shop", null, FAST),
		);

		expect(message.split("\n")).toEqual([
			"Container shop-a-1 exited with code 1, and its restart policy does not start it again.",
			"Container shop-b-1 is unhealthy: its health check failed 1 times in a row.",
		]);
	});

	it("names a container that is still restarting when another one fails", async () => {
		containers = [
			{ id: "shop-migrate-1", status: "exited", exitCode: 4 },
			{
				id: "shop-web-1",
				status: "restarting",
				restarting: true,
				exitCode: 7,
				policy: { Name: "unless-stopped" },
			},
		];

		const message = await failureOf(
			waitForComposeContainers("shop", null, { ...FAST, crashLimitMs: 60_000 }),
		);

		expect(message.split("\n")).toEqual([
			"Container shop-migrate-1 exited with code 4, and its restart policy does not start it again.",
			"Container shop-web-1 is restarting: it last exited with code 7.",
		]);
	});

	it("skips a container that was removed between the list and the inspect", async () => {
		mocks.listContainers.mockResolvedValue([
			{ Id: "shop-web-1", Labels: {} },
			{ Id: "shop-gone-1", Labels: {} },
		]);
		containers = [{ id: "shop-web-1" }];

		await expect(waitForComposeContainers("shop", null, FAST)).resolves.toBe(1);
	});

	it("tries a failed read again, and gives up after the crash limit", async () => {
		mocks.listContainers
			.mockRejectedValueOnce(new Error("connection reset"))
			.mockResolvedValueOnce([]);
		await expect(waitForComposeContainers("shop", null, FAST)).resolves.toBe(0);

		mocks.listContainers.mockReset();
		mocks.listContainers.mockRejectedValue(new Error("connection reset"));
		expect(await failureOf(waitForComposeContainers("shop", null, FAST))).toBe(
			"Could not read the containers of project shop for 0.3 s: connection reset",
		);
	});
});
