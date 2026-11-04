import {
	getSwarmConvergenceTimeoutMs,
	waitForSwarmServiceConvergence,
} from "@dokploy/server/utils/docker/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const SERVICE_VERSION = 100;
const NEWER_THAN_SERVICE = 101;

const service = (state?: string, forceUpdate = 1, monitorNs?: number) => ({
	UpdatedAt: "2026-11-04T10:00:10.000000000Z",
	Version: { Index: SERVICE_VERSION },
	Spec: {
		Mode: { Replicated: { Replicas: 1 } },
		TaskTemplate: { ForceUpdate: forceUpdate },
		UpdateConfig: { Monitor: monitorNs },
	},
	...(state && {
		UpdateStatus: { State: state, StartedAt: UPDATE_STARTED_AT },
	}),
});

// By default a task that went up 8 s before the service last changed, so it has
// done its time. A task of the current deployment passes `version`.
const task = (fields: {
	id?: string;
	version?: number;
	state: string;
	desired?: string;
	err?: string;
	forceUpdate?: number;
	createdAt?: string;
	timestamp?: string;
}) => ({
	ID: fields.id ?? "task-1",
	Version: { Index: fields.version ?? 50 },
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
		expect(message).toContain("0/1 tasks stayed running for 5 s");
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

	describe("a task that Swarm did not watch", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		// The wait counts on Date.now, which rounds to whole milliseconds, and the
		// clock tests below replace Date.now, so these use another clock with a margin.
		const secondsSince = (startedAt: number) =>
			(performance.now() - startedAt) / 1000;
		const AT_LEAST_WATCHED_S = 2.4;
		const NOT_WATCHED_AGAIN_S = 4;

		it("trusts a new task only after it stayed up for Monitor", async () => {
			inspect.mockResolvedValue(service(undefined, 1, 2.5 * SECOND_NS));
			listTasks.mockResolvedValue([
				task({ state: "running", version: NEWER_THAN_SERVICE }),
			]);

			const startedAt = performance.now();
			await waitForSwarmServiceConvergence("app", null, { intervalMs: 50 });

			expect(secondsSince(startedAt)).toBeGreaterThanOrEqual(
				AT_LEAST_WATCHED_S,
			);
		});

		it("does not trust a restart loop that shows a running task on every poll", async () => {
			let restarts = 0;
			inspect.mockResolvedValue(service(undefined, 1, 0.2 * SECOND_NS));
			listTasks.mockImplementation(async () => {
				restarts += 1;
				return [
					task({
						id: `task-${restarts}`,
						state: "running",
						version: NEWER_THAN_SERVICE + restarts,
					}),
					task({
						id: `task-${restarts - 1}`,
						state: "failed",
						desired: "shutdown",
						err: "task: non-zero exit (3)",
						createdAt: "2026-11-04T10:00:11.000000000Z",
					}),
				];
			});

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 2_300,
					intervalMs: 50,
				}),
			);

			expect(message).toContain("did not converge within 2300ms");
			expect(message).toContain("0/1 tasks stayed running for 0.2 s");
			expect(message).toContain("task error: task: non-zero exit (3)");
		});

		it("does not take a completed update for done while its task keeps restarting", async () => {
			let restarts = 0;
			inspect.mockResolvedValue(service("completed", 1, 0.2 * SECOND_NS));
			listTasks.mockImplementation(async () => {
				restarts += 1;
				return [
					task({ id: `task-${restarts}`, state: "running", version: 101 }),
				];
			});

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 400,
					intervalMs: 50,
				}),
			);

			expect(message).toContain("0/1 tasks stayed running");
			expect(message).not.toContain("still updating");
		});

		it("watches only the rest of Monitor for a task that went up before the service changed", async () => {
			inspect.mockResolvedValue(service("completed"));
			listTasks.mockResolvedValue([
				task({
					state: "running",
					timestamp: "2026-11-04T10:00:06.000000000Z",
				}),
			]);

			const startedAt = performance.now();
			await waitForSwarmServiceConvergence("app", null, { intervalMs: 50 });

			expect(secondsSince(startedAt)).toBeGreaterThanOrEqual(0.9);
			expect(secondsSince(startedAt)).toBeLessThan(NOT_WATCHED_AGAIN_S);
		});

		it("gives no credit to a new task on a node whose clock is behind", async () => {
			inspect.mockResolvedValue(service(undefined, 1, 2.5 * SECOND_NS));
			listTasks.mockResolvedValue([
				task({
					state: "running",
					version: NEWER_THAN_SERVICE,
					timestamp: "2026-11-04T09:00:00.000000000Z",
				}),
			]);

			const startedAt = performance.now();
			await waitForSwarmServiceConvergence("app", null, { intervalMs: 50 });

			expect(secondsSince(startedAt)).toBeGreaterThanOrEqual(
				AT_LEAST_WATCHED_S,
			);
		});

		it.each([
			["ahead of", 3_600_000],
			["behind", -3_600_000],
		])(
			"does not depend on the panel's clock being %s the server's",
			async (_, offsetMs) => {
				const realNow = Date.now;
				vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);

				inspect.mockResolvedValue(service());
				listTasks.mockResolvedValue([task({ state: "running" })]);
				const oldTaskStartedAt = performance.now();
				await waitForSwarmServiceConvergence("app", null, { intervalMs: 50 });
				expect(secondsSince(oldTaskStartedAt)).toBeLessThan(
					NOT_WATCHED_AGAIN_S,
				);

				inspect.mockResolvedValue(service(undefined, 1, 2.5 * SECOND_NS));
				listTasks.mockResolvedValue([
					task({ state: "running", version: NEWER_THAN_SERVICE }),
				]);
				const newTaskStartedAt = performance.now();
				await waitForSwarmServiceConvergence("app", null, { intervalMs: 50 });
				expect(secondsSince(newTaskStartedAt)).toBeGreaterThanOrEqual(
					AT_LEAST_WATCHED_S,
				);
			},
		);
	});
});

describe("waitForSwarmServiceConvergence with the options of an application", () => {
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
