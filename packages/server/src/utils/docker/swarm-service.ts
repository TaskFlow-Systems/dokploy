import type Dockerode from "dockerode";
import type { AuthConfig, CreateServiceOptions } from "dockerode";

// A healthy daemon answers these calls in milliseconds. SSH_KEEPALIVE sees a dead
// network, not a daemon that took the request and stays silent, and such a call used
// to hold the deployment's slot in the queue for good.
const SWARM_CALL_TIMEOUT_MS = 30_000;

type ServiceInspect = Awaited<
	ReturnType<ReturnType<Dockerode["getService"]>["inspect"]>
>;

export const withNextForceUpdate = (
	settings: CreateServiceOptions,
	inspect: ServiceInspect,
) => ({
	...settings,
	TaskTemplate: {
		...settings.TaskTemplate,
		ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
	},
});

const isNotFound = (error: unknown) =>
	(error as { statusCode?: number } | null)?.statusCode === 404;

/**
 * Updates the service, or creates it if it does not exist. Only a 404 leads to a
 * create: any other failure used to fall through to one as well, and the user saw
 * `name conflicts` from the create instead of the real cause.
 *
 * A call that gets no answer is not repeated, because the daemon may still apply it.
 */
export const createOrUpdateSwarmService = async ({
	docker,
	appName,
	settings,
	authConfig,
	getUpdate = withNextForceUpdate,
	timeoutMs = SWARM_CALL_TIMEOUT_MS,
}: {
	docker: Dockerode;
	appName: string;
	settings: CreateServiceOptions;
	authConfig?: AuthConfig;
	getUpdate?: (
		settings: CreateServiceOptions,
		inspect: ServiceInspect,
	) => CreateServiceOptions;
	timeoutMs?: number;
}): Promise<void> => {
	const withLimit = async <T>(
		action: string,
		call: (abortSignal: AbortSignal) => Promise<T>,
	) => {
		const abortSignal = AbortSignal.timeout(timeoutMs);
		try {
			return await call(abortSignal);
		} catch (error) {
			if (!abortSignal.aborted) throw error;
			throw new Error(
				`Docker did not answer within ${timeoutMs / 1000} s while ${action} service ${appName}. The change may still apply, so check the service before deploying again.`,
				{ cause: error },
			);
		}
	};

	const create = () =>
		withLimit("creating", (abortSignal) =>
			authConfig
				? docker.createService(authConfig, {
						...settings,
						abortSignal,
					} as CreateServiceOptions)
				: docker.createService({
						...settings,
						abortSignal,
					} as CreateServiceOptions),
		);

	const service = docker.getService(appName);
	try {
		const inspect = await withLimit("reading", (abortSignal) =>
			service.inspect({ abortSignal }),
		);
		await withLimit("updating", (abortSignal) =>
			service.update({
				version: Number.parseInt(inspect.Version.Index, 10),
				...getUpdate(settings, inspect),
				abortSignal,
			}),
		);
	} catch (error) {
		if (!isNotFound(error)) throw error;
		await create();
	}
};
