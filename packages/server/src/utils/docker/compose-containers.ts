import { getRemoteDocker } from "../servers/remote-docker";
import { QUIET_START_ALLOWANCE_MS, SWARM_READ_TIMEOUT_MS } from "./utils";

export class ComposeContainerError extends Error {}

// Docker's restart manager also counts a container as started once it has run for
// 10 s: only then does it reset the restart delay.
export const COMPOSE_CONTAINER_STABLE_MS = 10_000;
// A container that crashed once may still come up, for example after its database.
export const COMPOSE_CRASH_LIMIT_MS = 45_000;
// Over SSH every read of the Docker API is a connection of its own, and the default
// `MaxStartups` of sshd starts dropping new ones at 10 in progress.
const CONCURRENT_INSPECTS = 4;
// `startedSince` comes from the panel's clock and the start times from the daemon's;
// the offset between them is measured over one request.
const CLOCK_MARGIN_MS = 1_000;

type WaitOptions = {
	/** Panel time just before `docker compose up`. Containers that ended before it are left alone. */
	startedSince?: number;
	stableMs?: number;
	crashLimitMs?: number;
	timeoutMs?: number;
	intervalMs?: number;
	readTimeoutMs?: number;
};

type ContainerState = {
	Status?: string;
	Restarting?: boolean;
	OOMKilled?: boolean;
	ExitCode?: number;
	StartedAt?: string;
	Health?: { Status?: string; FailingStreak?: number };
};

type InspectedContainer = {
	Id: string;
	Name?: string;
	Created?: string;
	RestartCount?: number;
	State?: ContainerState;
	HostConfig?: {
		RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
	};
};

type Verdict =
	| { kind: "settled" }
	| { kind: "skipped" }
	| { kind: "pending"; reason: string; trouble?: boolean }
	| { kind: "failed"; reason: string };

const exitReason = (state: ContainerState) =>
	state.OOMKilled
		? `was killed for running out of memory (exit code ${state.ExitCode})`
		: `exited with code ${state.ExitCode}`;

const doesNotRunAgain = (container: InspectedContainer) => {
	const policy = container.HostConfig?.RestartPolicy;
	const name = policy?.Name || "no";
	if (name === "no") return true;
	const limit = policy?.MaximumRetryCount ?? 0;
	return (
		name === "on-failure" && limit > 0 && (container.RestartCount ?? 0) >= limit
	);
};

const judge = (
	container: InspectedContainer,
	daemonNow: number,
	daemonSince: number | undefined,
	stableMs: number,
): Verdict => {
	const state = container.State ?? {};
	const startedAt = Date.parse(state.StartedAt ?? "");
	const ranBefore = (time: number) =>
		daemonSince !== undefined && !(time >= daemonSince);

	if (state.Restarting || state.Status === "restarting") {
		return { kind: "pending", trouble: true, reason: "keeps restarting" };
	}
	switch (state.Status) {
		case "running": {
			const health = state.Health?.Status;
			if (health === "unhealthy") {
				return {
					kind: "failed",
					reason: `is unhealthy: its health check failed ${state.Health?.FailingStreak ?? 0} times in a row`,
				};
			}
			if (health === "starting") {
				return { kind: "pending", reason: "did not become healthy" };
			}
			if (!(daemonNow - startedAt >= stableMs)) {
				return {
					kind: "pending",
					reason: `did not stay up for ${stableMs / 1000} s`,
				};
			}
			return { kind: "settled" };
		}
		case "exited":
		case "dead": {
			// `docker compose up` starts every stopped container of the services it runs,
			// so one that ended before it belongs to a service it left out.
			if (ranBefore(startedAt)) return { kind: "skipped" };
			if (state.Status === "dead") {
				return { kind: "failed", reason: "is dead" };
			}
			if (state.ExitCode === 0) return { kind: "settled" };
			if (doesNotRunAgain(container)) {
				return {
					kind: "failed",
					reason: `${exitReason(state)}, and its restart policy does not start it again`,
				};
			}
			return { kind: "pending", trouble: true, reason: "keeps restarting" };
		}
		case "created": {
			if (ranBefore(Date.parse(container.Created ?? ""))) {
				return { kind: "skipped" };
			}
			return { kind: "failed", reason: "was created but did not start" };
		}
		default:
			return { kind: "settled" };
	}
};

const inspectAll = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	ids: string[],
	readTimeoutMs: number,
) => {
	const queue = [...ids];
	const inspected: InspectedContainer[] = [];
	await Promise.all(
		Array.from({ length: CONCURRENT_INSPECTS }, async () => {
			for (let id = queue.shift(); id; id = queue.shift()) {
				try {
					inspected.push(
						(await docker.getContainer(id).inspect({
							abortSignal: AbortSignal.timeout(readTimeoutMs),
						})) as InspectedContainer,
					);
				} catch (error) {
					// `--remove-orphans` and a running `down` remove containers between the two reads.
					if ((error as { statusCode?: number }).statusCode !== 404) {
						throw error;
					}
				}
			}
		}),
	);
	return inspected;
};

const describeReadFailure = (error: unknown, readTimeoutMs: number) =>
	error instanceof Error && error.name === "TimeoutError"
		? `no answer within ${readTimeoutMs}ms`
		: error instanceof Error
			? error.message
			: String(error);

/**
 * Waits after `docker compose up -d`, which exits 0 as soon as it has started the
 * containers, however they go on. Every container of the project has to stay up for
 * `stableMs` and pass its health check, and one that ran to its end has to exit 0.
 * A container that crashed gets `crashLimitMs` to come up. Returns how many
 * containers it checked.
 */
export const waitForComposeContainers = async (
	projectName: string,
	serverId?: string | null,
	options: WaitOptions = {},
): Promise<number> => {
	const stableMs = options.stableMs ?? COMPOSE_CONTAINER_STABLE_MS;
	const crashLimitMs = options.crashLimitMs ?? COMPOSE_CRASH_LIMIT_MS;
	const timeoutMs = options.timeoutMs ?? QUIET_START_ALLOWANCE_MS;
	const intervalMs = options.intervalMs ?? 2_000;
	const readTimeoutMs = options.readTimeoutMs ?? SWARM_READ_TIMEOUT_MS;
	const docker = await getRemoteDocker(serverId);
	const startedAt = Date.now();
	const firstTrouble = new Map<string, number>();
	const lastStart = new Map<string, string>();
	const lastExit = new Map<string, string>();
	let clockOffset: number | undefined;
	let failingReadsSince: number | undefined;

	while (true) {
		let containers: InspectedContainer[];
		try {
			if (clockOffset === undefined) {
				const before = Date.now();
				// dockerode passes `abortSignal` on, though its types give `info` no options.
				const readInfo = docker.info as unknown as (options: {
					abortSignal: AbortSignal;
				}) => Promise<{ SystemTime?: string }>;
				const info = await readInfo.call(docker, {
					abortSignal: AbortSignal.timeout(readTimeoutMs),
				});
				const daemonTime = Date.parse(info.SystemTime ?? "");
				if (Number.isNaN(daemonTime)) {
					throw new Error("the daemon did not report its time");
				}
				clockOffset = daemonTime - (before + Date.now()) / 2;
			}
			const listed = await docker.listContainers({
				all: true,
				abortSignal: AbortSignal.timeout(readTimeoutMs),
				filters: JSON.stringify({
					label: [`com.docker.compose.project=${projectName}`],
				}),
			} as Parameters<typeof docker.listContainers>[0]);
			const ids = listed
				// `docker compose run` leaves one-off containers that no deployment started.
				.filter(
					({ Labels }) => Labels?.["com.docker.compose.oneoff"] !== "True",
				)
				.map(({ Id }) => Id);
			containers = await inspectAll(docker, ids, readTimeoutMs);
			failingReadsSince = undefined;
		} catch (error) {
			failingReadsSince ??= Date.now();
			if (Date.now() - failingReadsSince >= crashLimitMs) {
				throw new ComposeContainerError(
					`Could not read the containers of project ${projectName} for ${crashLimitMs / 1000} s: ${describeReadFailure(error, readTimeoutMs)}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
			continue;
		}

		const now = Date.now();
		const daemonSince =
			options.startedSince === undefined
				? undefined
				: options.startedSince + clockOffset - CLOCK_MARGIN_MS;
		const failures: string[] = [];
		const pending: string[] = [];
		const restarting: string[] = [];
		let checked = 0;
		for (const container of containers.sort((a, b) =>
			(a.Name ?? "").localeCompare(b.Name ?? ""),
		)) {
			const name = (container.Name ?? container.Id).replace(/^\//, "");
			const start = `${container.State?.StartedAt}|${container.RestartCount}`;
			const previousStart = lastStart.get(container.Id);
			lastStart.set(container.Id, start);
			const verdict = judge(
				container,
				now + clockOffset,
				daemonSince,
				stableMs,
			);
			if (verdict.kind === "skipped") continue;
			checked += 1;
			// A running container reports exit code 0 again, so the reason of a crash is kept.
			if (container.State?.ExitCode) {
				lastExit.set(container.Id, exitReason(container.State));
			}
			// A restart between two reads can look like a container that is up.
			if (
				(verdict.kind === "pending" && verdict.trouble) ||
				(previousStart !== undefined && previousStart !== start)
			) {
				if (!firstTrouble.has(container.Id)) {
					firstTrouble.set(container.Id, now);
				}
			}
			if (verdict.kind === "failed") {
				failures.push(`Container ${name} ${verdict.reason}.`);
				continue;
			}
			if (verdict.kind !== "pending") continue;
			const troubleSince = firstTrouble.get(container.Id);
			if (
				(troubleSince !== undefined && now - troubleSince >= crashLimitMs) ||
				now - startedAt >= timeoutMs
			) {
				const crashed = troubleSince !== undefined;
				const exit = lastExit.get(container.Id);
				const reason = crashed
					? `keeps restarting${exit ? `: it last ${exit}` : ""}`
					: verdict.reason;
				const waited = Math.round(
					(now -
						(crashed && now - startedAt < timeoutMs
							? troubleSince
							: startedAt)) /
						1000,
				);
				failures.push(`Container ${name} ${reason} (waited ${waited} s).`);
				continue;
			}
			pending.push(name);
			if (troubleSince !== undefined) {
				const exit = lastExit.get(container.Id);
				restarting.push(
					`Container ${name} is restarting${exit ? `: it last ${exit}` : ""}.`,
				);
			}
		}

		if (failures.length > 0) {
			// What still restarts is often the cause or the result of what failed.
			throw new ComposeContainerError([...failures, ...restarting].join("\n"));
		}
		if (pending.length === 0) return checked;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
};
