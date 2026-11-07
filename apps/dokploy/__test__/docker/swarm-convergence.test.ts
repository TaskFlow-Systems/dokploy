import {
	getSwarmConvergenceTimeoutMs,
	waitForSwarmServiceConvergence,
} from "@dokploy/server/utils/docker/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { inspect, listTasks, info, inspectContainer } = vi.hoisted(() => ({
	inspect: vi.fn(),
	listTasks: vi.fn(),
	info: vi.fn(),
	inspectContainer: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: async () => ({
		getService: () => ({ inspect }),
		listTasks,
		info,
		getContainer: (id: string) => ({
			inspect: (options: unknown) => inspectContainer(id, options),
		}),
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

const endingService = (condition: string, state?: string) => {
	const base = service(state);
	return {
		...base,
		Spec: {
			...base.Spec,
			TaskTemplate: {
				...base.Spec.TaskTemplate,
				RestartPolicy: { Condition: condition },
			},
		},
	};
};

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

describe("a service whose restart policy lets it end", () => {
	const options = { intervalMs: 1, timeoutMs: 40, quietStartAllowanceMs: 0 };

	beforeEach(() => {
		inspect.mockReset();
		listTasks.mockReset();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-11-04T10:00:20.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const pastUpdateGrace = () => vi.setSystemTime(Date.now() + 5_000);

	it.each(["none", "on-failure"])(
		"passes a task that completed with condition %s",
		async (condition) => {
			inspect.mockImplementation(async () => {
				pastUpdateGrace();
				return endingService(condition);
			});
			listTasks.mockResolvedValue([
				task({ state: "complete", desired: "shutdown" }),
			]);

			await expect(
				waitForSwarmServiceConvergence("job", null, options),
			).resolves.toBeUndefined();
		},
	);

	it("does not take a complete task for success with condition any", async () => {
		inspect.mockImplementation(async () => {
			pastUpdateGrace();
			return service();
		});
		listTasks.mockResolvedValue([
			task({ state: "complete", desired: "shutdown" }),
		]);

		expect(
			await failureOf(waitForSwarmServiceConvergence("job", null, options)),
		).toContain("did not converge");
	});

	it("fails at once when the last run failed and nothing replaces it", async () => {
		inspect.mockImplementation(async () => {
			pastUpdateGrace();
			return endingService("none");
		});
		listTasks.mockResolvedValue([
			task({
				state: "failed",
				desired: "shutdown",
				err: "task: non-zero exit (3)",
			}),
		]);

		const failure = await failureOf(
			waitForSwarmServiceConvergence("job", null, options),
		);

		expect(failure).toContain("does not run it again");
		expect(failure).toContain("non-zero exit (3)");
		expect(inspect).toHaveBeenCalledTimes(1);
	});

	it("goes by the newest task of a slot, so a retry that succeeds passes", async () => {
		inspect.mockImplementation(async () => {
			pastUpdateGrace();
			return endingService("on-failure");
		});
		listTasks.mockResolvedValue([
			{
				...task({ id: "first", state: "failed", desired: "shutdown" }),
				Slot: 1,
				CreatedAt: "2026-11-04T10:00:01.000000000Z",
			},
			{
				...task({ id: "retry", state: "complete", desired: "shutdown" }),
				Slot: 1,
				CreatedAt: "2026-11-04T10:00:05.000000000Z",
			},
		]);

		await expect(
			waitForSwarmServiceConvergence("job", null, options),
		).resolves.toBeUndefined();
	});

	it("passes an update that Swarm paused only because a short task ended cleanly", async () => {
		inspect.mockResolvedValue(endingService("none", "paused"));
		listTasks.mockResolvedValue([
			task({
				state: "complete",
				desired: "shutdown",
				createdAt: "2026-11-04T10:00:05.000000000Z",
			}),
		]);

		await expect(
			waitForSwarmServiceConvergence("job", null, options),
		).resolves.toBeUndefined();
	});

	it.each([
		["the task failed", "failed", "2026-11-04T10:00:05.000000000Z"],
		[
			"the complete task is from before",
			"complete",
			"2026-11-04T09:00:00.000000000Z",
		],
	])("keeps a pause as a failure when %s", async (_, state, createdAt) => {
		inspect.mockResolvedValue(endingService("none", "paused"));
		listTasks.mockResolvedValue([
			task({ state, desired: "shutdown", createdAt }),
		]);

		expect(
			await failureOf(waitForSwarmServiceConvergence("job", null, options)),
		).toContain("paused the update");
	});

	it("keeps a pause as a failure with condition any", async () => {
		inspect.mockResolvedValue(service("paused"));
		listTasks.mockResolvedValue([
			task({
				state: "complete",
				desired: "shutdown",
				createdAt: "2026-11-04T10:00:05.000000000Z",
			}),
		]);

		expect(
			await failureOf(waitForSwarmServiceConvergence("job", null, options)),
		).toContain("paused the update");
	});

	it("does not fail on an old failed task while the update runs", async () => {
		inspect
			.mockResolvedValueOnce(endingService("none", "updating"))
			.mockResolvedValue(endingService("none", "completed"));
		listTasks
			.mockResolvedValueOnce([task({ state: "failed", desired: "shutdown" })])
			.mockResolvedValue([
				{
					...task({ id: "old", state: "failed", desired: "shutdown" }),
					Slot: 1,
					CreatedAt: "2026-11-04T10:00:01.000000000Z",
				},
				{
					...task({ id: "new", state: "complete", desired: "shutdown" }),
					Slot: 1,
					CreatedAt: "2026-11-04T10:00:05.000000000Z",
				},
			]);

		await expect(
			waitForSwarmServiceConvergence("job", null, options),
		).resolves.toBeUndefined();
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

	describe("a daemon that takes the request and stays silent", () => {
		// Only the read's own signal ends this, so without one the test times out.
		const silentRead = (options?: { abortSignal?: AbortSignal }) =>
			new Promise<never>((_, reject) => {
				options?.abortSignal?.addEventListener("abort", () => {
					reject(
						Object.assign(new Error("The operation was aborted"), {
							name: "AbortError",
						}),
					);
				});
			});

		it("reads again after a read that got no answer", async () => {
			inspect
				.mockImplementationOnce(silentRead)
				.mockResolvedValue(service("completed"));
			listTasks.mockResolvedValue([task({ state: "running" })]);

			await waitForSwarmServiceConvergence("app", null, {
				readTimeoutMs: 20,
				intervalMs: 1,
			});

			expect(inspect).toHaveBeenCalledTimes(2);
		});

		it("gives up when the service read stays silent", async () => {
			inspect.mockImplementation(silentRead);

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 5,
					readTimeoutMs: 20,
					intervalMs: 1,
				}),
			);

			expect(message).toContain("Could not read the state of service app");
			expect(message).toContain("no answer within 20ms");
		});

		it("gives up when the task list stays silent", async () => {
			inspect.mockResolvedValue(service("completed"));
			listTasks.mockImplementation(silentRead);

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 5,
					readTimeoutMs: 20,
					intervalMs: 1,
				}),
			);

			expect(message).toContain("Could not read the state of service app");
			expect(message).toContain("no answer within 20ms");
		});
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

// What a task of the node the panel connects to looks like once it runs.
const localTask = (id: string, nodeId = "node-1") => {
	const base = task({ id, state: "running" });
	return {
		...base,
		NodeID: nodeId,
		Status: {
			...base.Status,
			ContainerStatus: { ContainerID: `container-${id}` },
		},
	};
};

describe("waitForSwarmServiceConvergence and the engine of its node", () => {
	beforeEach(() => {
		inspect.mockReset();
		listTasks.mockReset();
		info.mockReset();
		inspectContainer.mockReset();
		info.mockResolvedValue({ Swarm: { NodeID: "node-1" } });
	});

	it("settles when the engine runs the task's container too", async () => {
		inspect.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([localTask("task-1")]);
		inspectContainer.mockResolvedValue({ State: { Running: true } });

		await waitForSwarmServiceConvergence("app", null, { intervalMs: 1 });

		expect(inspectContainer).toHaveBeenCalledWith(
			"container-task-1",
			expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
		);
	});

	it("does not take a task whose container stopped for a settled one, while Swarm still says running", async () => {
		inspect.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([localTask("task-1")]);
		inspectContainer.mockResolvedValue({
			State: { Running: false, ExitCode: 3 },
		});

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 20,
				intervalMs: 1,
			}),
		);

		expect(message).toContain("did not converge");
		expect(message).toContain(
			"a task's container had stopped while Swarm still reported it running",
		);
		expect(inspectContainer).toHaveBeenCalledTimes(1);
	});

	it("takes a container the engine no longer has for a stopped one", async () => {
		inspect.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([localTask("task-1")]);
		inspectContainer.mockRejectedValue(
			Object.assign(new Error("no such container"), { statusCode: 404 }),
		);

		const message = await failureOf(
			waitForSwarmServiceConvergence("app", null, {
				timeoutMs: 20,
				intervalMs: 1,
			}),
		);

		expect(message).toContain("had stopped while Swarm still reported it");
	});

	it("settles on the task Swarm starts in place of the stopped one", async () => {
		inspect.mockResolvedValue(service("completed"));
		listTasks
			.mockResolvedValueOnce([localTask("task-1")])
			.mockResolvedValueOnce([localTask("task-1")])
			.mockResolvedValue([localTask("task-2")]);
		inspectContainer.mockImplementation(async (id: string) => ({
			State: { Running: id !== "container-task-1" },
		}));

		await waitForSwarmServiceConvergence("app", null, { intervalMs: 1 });

		expect(inspectContainer.mock.calls.map(([id]) => id)).toEqual([
			"container-task-1",
			"container-task-2",
		]);
	});

	it("goes by Swarm for a task on another node, which the panel cannot reach", async () => {
		inspect.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([localTask("task-1", "node-2")]);

		await waitForSwarmServiceConvergence("app", null, { intervalMs: 1 });

		expect(inspectContainer).not.toHaveBeenCalled();
	});

	it("goes by Swarm when the engine cannot say", async () => {
		inspect.mockResolvedValue(service("completed"));
		listTasks.mockResolvedValue([localTask("task-1")]);
		inspectContainer.mockRejectedValue(new Error("socket hang up"));

		await expect(
			waitForSwarmServiceConvergence("app", null, { intervalMs: 1 }),
		).resolves.toBeUndefined();

		info.mockRejectedValue(new Error("no answer"));
		inspectContainer.mockClear();
		await waitForSwarmServiceConvergence("app", null, { intervalMs: 1 });
		expect(inspectContainer).not.toHaveBeenCalled();
	});
});

describe("waitForSwarmServiceConvergence, tasks across nodes and failures", () => {
	beforeEach(() => {
		inspect.mockReset();
		listTasks.mockReset();
		info.mockReset();
	});

	const onNode = (node: string, fields: Parameters<typeof task>[0]) => ({
		...task(fields),
		NodeID: node,
	});
	const globalService = (state?: string) => {
		const base = service(state);
		return { ...base, Spec: { ...base.Spec, Mode: { Global: {} } } };
	};

	describe("a global service", () => {
		it("waits for the task of every node that runs one", async () => {
			inspect.mockResolvedValue(globalService("completed"));
			listTasks.mockResolvedValue([
				onNode("node-1", { id: "a", state: "running" }),
				onNode("node-2", { id: "b", state: "preparing" }),
			]);

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 30,
					intervalMs: 1,
				}),
			);

			expect(message).toContain("did not converge");
			expect(message).toContain("1/2 tasks stayed running");
		});

		it("passes once the task of each node has settled", async () => {
			inspect.mockResolvedValue(globalService("completed"));
			listTasks.mockResolvedValue([
				onNode("node-1", { id: "a", state: "running" }),
				onNode("node-2", { id: "b", state: "running" }),
			]);

			await expect(
				waitForSwarmServiceConvergence("app", null, { intervalMs: 1 }),
			).resolves.toBeUndefined();
		});

		it("counts a node once, whatever its older tasks, and one node at least", async () => {
			inspect.mockResolvedValue(globalService("completed"));
			listTasks.mockResolvedValue([
				onNode("node-1", { id: "a", state: "running" }),
				onNode("node-1", { id: "old", state: "failed", desired: "shutdown" }),
			]);

			await expect(
				waitForSwarmServiceConvergence("app", null, { intervalMs: 1 }),
			).resolves.toBeUndefined();
		});
	});

	describe("an image that only one node has", () => {
		const noImage = "No such image: registry.local/app:latest";

		it("tells that the service needs a registry", async () => {
			inspect.mockResolvedValue(service("updating"));
			listTasks.mockResolvedValue([task({ state: "rejected", err: noImage })]);

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 20,
					intervalMs: 1,
				}),
			);

			expect(message).toContain(`task error: ${noImage}`);
			expect(message).toContain("needs a registry");
		});

		it("adds nothing to other task errors", async () => {
			inspect.mockResolvedValue(service("updating"));
			listTasks.mockResolvedValue([
				task({ state: "pending", err: "no suitable node" }),
			]);

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 20,
					intervalMs: 1,
				}),
			);

			expect(message).toContain("did not converge");
			expect(message).not.toContain("registry");
		});
	});

	describe("a host-mode port with start-first", () => {
		const withOrder = (order: string) => {
			const base = service("updating");
			return {
				...base,
				Spec: {
					...base.Spec,
					UpdateConfig: { ...base.Spec.UpdateConfig, Order: order },
				},
			};
		};
		const blocked = [
			task({ id: "old", state: "running", version: 50 }),
			task({
				id: "new",
				state: "pending",
				err: "no suitable node (host-mode port already in use on 1 node)",
			}),
		];

		it("fails at once and says to use stop-first", async () => {
			inspect.mockResolvedValue(withOrder("start-first"));
			listTasks.mockResolvedValue(blocked);

			const message = await failureOf(waitForSwarmServiceConvergence("app"));

			expect(message).toContain("cannot bind the published host-mode port");
			expect(message).toContain("stop-first");
			expect(inspect).toHaveBeenCalledTimes(1);
		});

		it("keeps the normal wait with stop-first", async () => {
			inspect.mockResolvedValue(withOrder("stop-first"));
			listTasks.mockResolvedValue(blocked);

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 20,
					intervalMs: 1,
				}),
			);

			expect(message).toContain("did not converge");
			expect(message).toContain("host-mode port already in use");
		});

		it("does not take the error of an earlier deployment for this update", async () => {
			inspect.mockResolvedValue(withOrder("start-first"));
			listTasks.mockResolvedValue([
				task({
					state: "pending",
					err: "no suitable node (host-mode port already in use on 1 node)",
					createdAt: "2026-11-04T09:00:00.000000000Z",
				}),
			]);

			const message = await failureOf(
				waitForSwarmServiceConvergence("app", null, {
					timeoutMs: 20,
					intervalMs: 1,
				}),
			);

			expect(message).toContain("did not converge");
		});
	});

	describe("a restart loop", () => {
		const crash = (id: string, second: number) =>
			task({
				id,
				state: "failed",
				desired: "shutdown",
				err: `task: non-zero exit (${second})`,
				timestamp: `2026-11-04T10:00:0${second}.000000000Z`,
			});

		it("fails once three tasks of this update have failed", async () => {
			inspect.mockResolvedValue(service("updating"));
			listTasks.mockResolvedValue([
				task({ id: "t4", state: "starting" }),
				crash("t1", 3),
				crash("t2", 4),
				crash("t3", 5),
			]);

			const message = await failureOf(waitForSwarmServiceConvergence("app"));

			expect(message).toContain(
				"3 tasks of one slot in this update have failed",
			);
			expect(message).toContain("last task error: task: non-zero exit (5)");
			expect(inspect).toHaveBeenCalledTimes(1);
		});

		it("passes three replicas that each fail once and then settle", async () => {
			const replicas = (n: number) => ({
				...service("completed"),
				Spec: {
					...service("completed").Spec,
					Mode: { Replicated: { Replicas: n } },
				},
			});
			inspect.mockResolvedValue(replicas(3));
			listTasks.mockResolvedValue(
				[1, 2, 3].flatMap((slot) => [
					{ ...task({ id: `up-${slot}`, state: "running" }), Slot: slot },
					{ ...crash(`down-${slot}`, 2 + slot), Slot: slot },
				]),
			);

			await expect(
				waitForSwarmServiceConvergence("app", null, { intervalMs: 1 }),
			).resolves.toBeUndefined();
		});

		it("does not count tasks of an earlier deployment or cancelled ones", async () => {
			inspect.mockResolvedValue(service("completed"));
			listTasks.mockResolvedValue([
				task({ id: "t4", state: "running" }),
				crash("t1", 3),
				crash("t2", 4),
				{
					...crash("t3", 5),
					CreatedAt: "2026-11-04T09:00:00.000000000Z",
				},
				task({
					id: "t5",
					state: "failed",
					desired: "shutdown",
					err: "Canceled: context canceled",
				}),
			]);

			await expect(
				waitForSwarmServiceConvergence("app", null, { intervalMs: 1 }),
			).resolves.toBeUndefined();
		});

		it("still passes after a single crash that recovers", async () => {
			inspect.mockResolvedValue(service("completed"));
			listTasks.mockResolvedValue([
				task({ id: "t2", state: "running" }),
				crash("t1", 3),
			]);

			await expect(
				waitForSwarmServiceConvergence("app", null, { intervalMs: 1 }),
			).resolves.toBeUndefined();
		});
	});
});
