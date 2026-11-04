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
	state: string;
	desired?: string;
	err?: string;
	forceUpdate?: number;
	createdAt?: string;
	timestamp?: string;
}) => ({
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
