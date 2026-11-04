import {
	getSwarmConvergenceTimeoutMs,
	waitForSwarmServiceConvergence,
} from "@dokploy/server/utils/docker/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { inspect, listTasks } = vi.hoisted(() => ({
	inspect: vi.fn(),
	listTasks: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: async () => ({
		getService: () => ({ inspect }),
		listTasks,
	}),
}));

const UPDATE_STARTED_AT = "2026-11-04T10:00:00.500000000Z";
const SECOND_NS = 1e9;

const service = (state?: string, forceUpdate = 1) => ({
	Spec: {
		Mode: { Replicated: { Replicas: 1 } },
		TaskTemplate: { ForceUpdate: forceUpdate },
	},
	...(state && {
		UpdateStatus: { State: state, StartedAt: UPDATE_STARTED_AT },
	}),
});

const task = (fields: {
	id?: string;
	state: string;
	desired?: string;
	err?: string;
	forceUpdate?: number;
	createdAt?: string;
	timestamp?: string;
}) => ({
	ID: fields.id ?? "task",
	CreatedAt: fields.createdAt ?? "2026-11-04T10:00:01.000000000Z",
	DesiredState: fields.desired ?? "running",
	Spec: { ForceUpdate: fields.forceUpdate ?? 1 },
	Status: {
		State: fields.state,
		Err: fields.err,
		Timestamp: fields.timestamp ?? "2026-11-04T10:00:02.000000000Z",
	},
});

const failureOf = (promise: Promise<void>) =>
	promise.then(
		() => "",
		(error: Error) => error.message,
	);

describe("waitForSwarmServiceConvergence", () => {
	beforeEach(() => {
		inspect.mockReset();
		listTasks.mockReset();
	});

	it.each([
		["rollback_started", "is rolling back", "previous configuration"],
		["rollback_completed", "rolled back", "previous configuration"],
		[
			"rollback_paused",
			"could not finish rolling back",
			"failed configuration",
		],
		["paused", "paused", "until the next deployment"],
	])(
		"fails at once on %s, even with a running task",
		async (state, action, outcome) => {
			inspect.mockResolvedValue(service(state));
			listTasks.mockResolvedValue([
				task({ state: "running" }),
				task({ state: "failed", desired: "shutdown", err: "task: exit (3)" }),
			]);

			const message = await failureOf(waitForSwarmServiceConvergence("app"));

			expect(message).toContain(`Swarm ${action} the update of service app`);
			expect(message).toContain("task: exit (3)");
			expect(message).toContain(outcome);
			expect(inspect).toHaveBeenCalledTimes(1);
		},
	);

	it("names the first failure, not the cancelled replacement or an older deployment", async () => {
		inspect.mockResolvedValue(service("rollback_started"));
		listTasks.mockResolvedValue([
			task({
				state: "failed",
				desired: "shutdown",
				err: "task: exit (1) from the previous deployment",
				createdAt: "2026-11-04T09:00:00.000000000Z",
				timestamp: "2026-11-04T09:00:01.000000000Z",
			}),
			task({
				state: "failed",
				desired: "shutdown",
				err: "Canceled: context canceled",
				timestamp: "2026-11-04T10:00:03.000000000Z",
			}),
			task({
				state: "failed",
				desired: "shutdown",
				err: "task: exit (3)",
				timestamp: "2026-11-04T10:00:02.000000000Z",
			}),
			task({
				state: "failed",
				desired: "shutdown",
				err: "task: exit (4)",
				timestamp: "2026-11-04T10:00:04.000000000Z",
			}),
		]);

		const message = await failureOf(waitForSwarmServiceConvergence("app"));

		expect(message).toContain(": task: exit (3).");
	});

	it("says a new task stopped when no task left an error", async () => {
		inspect.mockResolvedValue(service("rollback_completed"));
		listTasks.mockResolvedValue([
			task({ state: "complete", desired: "shutdown" }),
		]);

		const message = await failureOf(waitForSwarmServiceConvergence("app"));

		expect(message).toContain("a new task stopped or failed its health check");
	});

	it("keeps waiting while Swarm is updating, whatever the old task does", async () => {
		inspect
			.mockResolvedValueOnce(service("updating"))
			.mockResolvedValueOnce(service("updating"))
			.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([task({ state: "running" })]);

		await waitForSwarmServiceConvergence("app", null, { intervalMs: 1 });

		expect(inspect).toHaveBeenCalledTimes(3);
	});

	it("does not take a completed update without running tasks for convergence", async () => {
		inspect.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([
			task({ state: "failed", err: "task: exit (3)" }),
		]);

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 5,
				intervalMs: 1,
			}),
		);

		expect(message).toContain("did not converge within 5ms");
		expect(message).toContain("0/1 tasks running");
		expect(message).toContain("task error: task: exit (3)");
		expect(message).not.toContain("still updating");
	});

	it("does not trust a missing state before Swarm had time to start the update", async () => {
		inspect.mockResolvedValue(service());
		listTasks.mockResolvedValue([task({ state: "running" })]);

		const startedAt = Date.now();
		await waitForSwarmServiceConvergence("app", null, { intervalMs: 50 });

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
	});

	it("keeps waiting on a missing state while the task has an older ForceUpdate", async () => {
		inspect.mockResolvedValue(service(undefined, 2));
		listTasks.mockResolvedValue([task({ state: "running", forceUpdate: 1 })]);

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 2_100,
				intervalMs: 50,
			}),
		);

		expect(message).toContain("did not converge within 2100ms");
	});
});

describe("waitForSwarmServiceConvergence with the options of an application", () => {
	const UPDATE_MONITOR_MS = 40;
	const monitoredService = (state?: string) => ({
		...service(state),
		Spec: {
			...service(state).Spec,
			UpdateConfig: { Monitor: UPDATE_MONITOR_MS * 1e6 },
		},
	});
	const failedTask = task({
		state: "failed",
		desired: "shutdown",
		err: "task: exit (3)",
	});

	beforeEach(() => {
		inspect.mockReset();
		listTasks.mockReset();
	});

	it("gives a quiet task the allowance, once per batch", async () => {
		inspect.mockResolvedValue({
			...service("updating"),
			Spec: {
				...service("updating").Spec,
				Mode: { Replicated: { Replicas: 2 } },
				UpdateConfig: { Parallelism: 1 },
			},
		});
		listTasks.mockResolvedValue([task({ state: "preparing" })]);
		const startedAt = Date.now();

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 10,
				quietStartAllowanceMs: 50,
				intervalMs: 1,
			}),
		);

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
		expect(message).toContain("did not converge within 110ms");
		expect(message).toContain("still updating");
	});

	it("takes the short limit from the first sight of a task error", async () => {
		inspect.mockResolvedValue(service("updating"));
		const quiet = [task({ state: "preparing" })];
		listTasks
			.mockResolvedValueOnce(quiet)
			.mockResolvedValueOnce(quiet)
			.mockResolvedValue([
				task({ state: "pending", err: "no suitable node (host-mode port)" }),
			]);
		const startedAt = Date.now();

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 30,
				quietStartAllowanceMs: 60_000,
				intervalMs: 1,
			}),
		);

		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(message).toContain("task error: no suitable node (host-mode port)");
	});

	it("does not take an error of an earlier deployment for this update", async () => {
		inspect.mockResolvedValue({
			...service(),
			UpdatedAt: "2026-11-04T10:00:00.000000000Z",
		});
		listTasks.mockResolvedValue([
			task({ state: "preparing", forceUpdate: 2 }),
			{
				...failedTask,
				CreatedAt: "2026-11-04T09:00:00.000000000Z",
			},
		]);
		const startedAt = Date.now();

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 10,
				quietStartAllowanceMs: 100,
				intervalMs: 1,
			}),
		);

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
		expect(message).not.toContain("task: exit (3)");
	});

	it("does not take a task for up before it stayed up for Monitor", async () => {
		const swarmStartGraceMs = 2_000;
		inspect.mockResolvedValue(monitoredService());
		listTasks.mockImplementation(async () => [
			task({ id: `task-${Date.now()}`, state: "running" }),
		]);

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: swarmStartGraceMs + 200,
				monitorTasks: true,
				intervalMs: 50,
			}),
		);

		expect(message).toContain("did not converge");
	});

	it("returns once the same task stayed up for Monitor", async () => {
		inspect.mockResolvedValue(monitoredService());
		listTasks.mockResolvedValue([task({ id: "steady", state: "running" })]);

		await waitForSwarmServiceConvergence("app", null, {
			monitorTasks: true,
			intervalMs: 10,
		});

		expect(listTasks.mock.calls.length).toBeGreaterThan(1);
	});

	it("takes a completed update without errors at once: Swarm has monitored it", async () => {
		inspect.mockResolvedValue(monitoredService("completed"));
		listTasks.mockResolvedValue([task({ state: "running" })]);

		await waitForSwarmServiceConvergence("app", null, { monitorTasks: true });

		expect(inspect).toHaveBeenCalledTimes(1);
	});

	it("does not trust a completed update whose tasks keep failing", async () => {
		inspect.mockResolvedValue(monitoredService("completed"));
		listTasks.mockImplementation(async () => [
			task({ id: `task-${Date.now()}`, state: "running" }),
			failedTask,
		]);

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 100,
				monitorTasks: true,
				intervalMs: 5,
			}),
		);

		expect(message).toContain("task error: task: exit (3)");
	});

	it("outlives a lost connection, because the update goes on without the panel", async () => {
		inspect
			.mockRejectedValueOnce(new Error("Keepalive timeout"))
			.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([task({ state: "running" })]);

		await waitForSwarmServiceConvergence("app", null, { intervalMs: 1 });

		expect(inspect).toHaveBeenCalledTimes(2);
	});

	it("gives up on a connection that stays lost", async () => {
		inspect.mockRejectedValue(new Error("Keepalive timeout"));

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 5,
				intervalMs: 1,
			}),
		);

		expect(message).toContain("Could not read the state of service app");
		expect(message).toContain("Keepalive timeout");
	});

	it("fails at once when the service is gone", async () => {
		inspect.mockRejectedValue(
			Object.assign(new Error("no such service"), { statusCode: 404 }),
		);

		const message = await failureOf(waitForSwarmServiceConvergence("app"));

		expect(message).toContain("no such service");
		expect(inspect).toHaveBeenCalledTimes(1);
	});
});

describe("getSwarmConvergenceTimeoutMs", () => {
	const spec = (fields: {
		replicas?: number;
		update?: { Parallelism?: number; Monitor?: number; Delay?: number };
		stop?: number;
		healthcheck?: {
			Test?: string[];
			Interval?: number;
			Timeout?: number;
			Retries?: number;
			StartPeriod?: number;
		};
	}) => ({
		Mode: { Replicated: { Replicas: fields.replicas ?? 1 } },
		UpdateConfig: fields.update,
		TaskTemplate: {
			ContainerSpec: {
				StopGracePeriod: fields.stop,
				Healthcheck: fields.healthcheck,
			},
		},
	});

	it("gives the default spec 45 s, also with no replicas or no spec", () => {
		expect(getSwarmConvergenceTimeoutMs()).toBe(45_000);
		expect(getSwarmConvergenceTimeoutMs(spec({}))).toBe(45_000);
		expect(getSwarmConvergenceTimeoutMs(spec({ replicas: 0 }))).toBe(45_000);
	});

	it("multiplies by the batches, with Parallelism 0 meaning all at once", () => {
		const update = { Parallelism: 1 };
		expect(getSwarmConvergenceTimeoutMs(spec({ replicas: 3, update }))).toBe(
			135_000,
		);
		expect(
			getSwarmConvergenceTimeoutMs(
				spec({ replicas: 4, update: { Parallelism: 2 } }),
			),
		).toBe(90_000);
		expect(
			getSwarmConvergenceTimeoutMs(
				spec({ replicas: 3, update: { Parallelism: 0 } }),
			),
		).toBe(45_000);
	});

	it("counts the stop grace period, Monitor and Delay", () => {
		expect(
			getSwarmConvergenceTimeoutMs(
				spec({
					stop: 120 * SECOND_NS,
					update: { Monitor: 60 * SECOND_NS, Delay: 10 * SECOND_NS },
				}),
			),
		).toBe(220_000);
	});

	it("counts a health check, with Docker's defaults for what it leaves out", () => {
		expect(
			getSwarmConvergenceTimeoutMs(
				spec({
					healthcheck: {
						Test: ["CMD-SHELL", "true"],
						Interval: 2 * SECOND_NS,
						Timeout: 3 * SECOND_NS,
						Retries: 4,
						StartPeriod: 60 * SECOND_NS,
					},
				}),
			),
		).toBe(125_000);
		expect(
			getSwarmConvergenceTimeoutMs(
				spec({ healthcheck: { Test: ["CMD-SHELL", "true"] } }),
			),
		).toBe(225_000);
		expect(
			getSwarmConvergenceTimeoutMs(spec({ healthcheck: { Test: ["NONE"] } })),
		).toBe(45_000);
	});
});
