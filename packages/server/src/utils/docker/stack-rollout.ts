import { getRemoteDocker } from "../servers/remote-docker";
import {
	getSwarmConvergenceTimeoutMs,
	QUIET_START_ALLOWANCE_MS,
	ServiceConvergenceError,
	SWARM_READ_TIMEOUT_MS,
	waitForSwarmServiceConvergence,
} from "./utils";

// Over SSH every read of the Docker API is a connection of its own, and the default
// `MaxStartups` of sshd starts dropping new ones at 10 in progress.
const CONCURRENT_SERVICE_WAITS = 4;

type WaitOptions = Parameters<typeof waitForSwarmServiceConvergence>[2];

type StackService = {
	Spec?: {
		Name?: string;
		Mode?: { ReplicatedJob?: unknown; GlobalJob?: unknown };
	};
};

const listStackServices = async (
	stackName: string,
	serverId?: string | null,
	options?: WaitOptions,
): Promise<StackService[]> => {
	const docker = await getRemoteDocker(serverId);
	const readTimeoutMs = options?.readTimeoutMs ?? SWARM_READ_TIMEOUT_MS;
	const limitMs = options?.timeoutMs ?? getSwarmConvergenceTimeoutMs();
	const startedAt = Date.now();
	while (true) {
		const abortSignal = AbortSignal.timeout(readTimeoutMs);
		try {
			return await docker.listServices({
				abortSignal,
				filters: JSON.stringify({
					label: [`com.docker.stack.namespace=${stackName}`],
				}),
			});
		} catch (error) {
			// The specs are written by now, so a lost connection says nothing about them.
			if (Date.now() - startedAt >= limitMs) {
				throw new ServiceConvergenceError(
					`Could not read the services of stack ${stackName} within ${limitMs}ms: ${abortSignal.aborted ? `no answer within ${readTimeoutMs}ms` : error instanceof Error ? error.message : String(error)}`,
				);
			}
			await new Promise((resolve) =>
				setTimeout(resolve, options?.intervalMs ?? 2_000),
			);
		}
	}
};

/**
 * Waits for every service of a stack and reports all that failed, since each of them
 * goes on or rolls back by itself. Returns how many it waited for. A job runs to its
 * own end and has no rollout, so it is not waited for.
 */
export const waitForStackRollout = async (
	stackName: string,
	serverId?: string | null,
	options?: WaitOptions,
): Promise<number> => {
	const services = await listStackServices(stackName, serverId, options);
	const names = services
		.filter(({ Spec }) => !Spec?.Mode?.ReplicatedJob && !Spec?.Mode?.GlobalJob)
		.flatMap(({ Spec }) => (Spec?.Name ? [Spec.Name] : []));

	const queue = [...names];
	const failures: string[] = [];
	await Promise.all(
		Array.from({ length: CONCURRENT_SERVICE_WAITS }, async () => {
			for (let name = queue.shift(); name; name = queue.shift()) {
				try {
					await waitForSwarmServiceConvergence(name, serverId, {
						quietStartAllowanceMs: QUIET_START_ALLOWANCE_MS,
						...options,
					});
				} catch (error) {
					failures.push(error instanceof Error ? error.message : String(error));
				}
			}
		}),
	);

	if (failures.length > 0) {
		throw new ServiceConvergenceError(failures.join("\n"));
	}
	return names.length;
};
