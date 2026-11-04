import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { docker } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	deployApplication,
	deployPreviewApplication,
	rebuildApplication,
	rebuildPreviewApplication,
} from "@dokploy/server/services/application";
import { rollback } from "@dokploy/server/services/rollbacks";
import { waitForSwarmServiceConvergence } from "@dokploy/server/utils/docker/utils";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
	savedValues: [] as Record<string, unknown>[],
	logPaths: [] as string[],
	logDirectory: { path: "" },
	updateDeploymentStatus: vi.fn(),
	sendBuildErrorNotifications: vi.fn(),
	sendBuildSuccessNotifications: vi.fn(),
	updateIssueComment: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const chain: Record<string, unknown> = {};
	chain.set = (values: Record<string, unknown>) => {
		mocks.savedValues.push(values);
		return chain;
	};
	chain.where = () => chain;
	chain.returning = () => Promise.resolve([{}]);
	return {
		db: {
			update: vi.fn(() => chain),
			query: {
				applications: { findFirst: vi.fn() },
				previewDeployments: { findFirst: vi.fn() },
				rollbacks: { findFirst: vi.fn() },
				webServerSettings: {
					findFirst: vi.fn().mockResolvedValue({ buildTimeoutMinutes: 60 }),
				},
			},
		},
	};
});

vi.mock("@dokploy/server/services/deployment", () => {
	const newDeployment = async () => {
		const logPath = `${mocks.logDirectory.path}/${mocks.logPaths.length}.log`;
		mocks.logPaths.push(logPath);
		return { deploymentId: "deployment", logPath };
	};
	return {
		createDeployment: newDeployment,
		createDeploymentPreview: newDeployment,
		updateDeployment: vi.fn(),
		updateDeploymentStatus: mocks.updateDeploymentStatus,
		findDeploymentById: vi.fn().mockResolvedValue({ applicationId: "app" }),
	};
});

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn().mockResolvedValue("https://panel.example.com"),
}));

vi.mock("@dokploy/server/services/github", () => ({
	issueCommentExists: vi.fn().mockResolvedValue(true),
	createPreviewDeploymentComment: vi.fn(),
	getIssueComment: (_name: string, status: string) => status,
	updateIssueComment: mocks.updateIssueComment,
	findGithubById: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.sendBuildErrorNotifications,
}));

vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: mocks.sendBuildSuccessNotifications,
}));

// A preview builds from GitHub. Its image is tagged by the test instead, because
// what these tests are about starts after the build.
vi.mock("@dokploy/server/utils/providers/github", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/github")
	>("@dokploy/server/utils/providers/github");
	return { ...actual, cloneGithubRepository: vi.fn().mockResolvedValue(":;") };
});

vi.mock("@dokploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders")
	>("@dokploy/server/utils/builders");
	return {
		...actual,
		getBuildCommand: vi.fn(async ({ sourceType }: { sourceType: string }) =>
			sourceType === "docker" ? "" : ":;",
		),
	};
});

const execFileAsync = promisify(execFile);

const IMAGE = "redis:8-alpine";
const REAL_TEST_TIMEOUT = 240_000;
// What `getSwarmConvergenceTimeoutMs` gives a spec with no stop grace period.
const LIMIT_WITHOUT_STOP_GRACE_MS = 35_000;
const NO_STOP_GRACE = { stopGracePeriodSwarm: 0 };
const CRASHES = { command: "/bin/sh", args: ["-c", "exit 3"] };

// Same id as application.real.test.ts: the PR workflow removes services named
// real-<kind>-<id>* after a cancelled run, and Docker is shared by CI runners.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const RUN_ID = `${CHECKOUT_ID}-${Date.now()}`;
const NETWORK = `real-rollout-net-${RUN_ID}`;
const SLOW_HEALTH_IMAGE = `real-rollout-${RUN_ID}:slow-health`;

const appNames: string[] = [];
const images: string[] = [SLOW_HEALTH_IMAGE];

const dockerCli = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, {
		timeout: 120_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
};

const buildImage = (tag: string, dockerfile: string) =>
	new Promise<void>((resolve, reject) => {
		const build = spawn("docker", ["build", "-q", "-t", tag, "-"], {
			stdio: ["pipe", "ignore", "inherit"],
		});
		build.on("error", reject);
		build.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`docker build: ${code}`)),
		);
		build.stdin.end(dockerfile);
	});

// A retried test needs a service of its own: some of them start from no service.
const newAppName = (kind: string) => {
	const appName = `real-rollout-${RUN_ID}-${kind}-${appNames.length}`;
	appNames.push(appName);
	return appName;
};

const environment = {
	environmentId: "env",
	projectId: "project",
	name: "production",
	env: "",
	project: {
		projectId: "project",
		organizationId: "org",
		name: "project",
		env: "",
	},
};

type ApplicationFixture = Record<string, unknown> & { appName: string };

const applicationFixture = (
	kind: string,
	overrides: Record<string, unknown> = {},
): ApplicationFixture => {
	const appName = newAppName(kind);
	return {
		applicationId: "app",
		name: appName,
		appName,
		sourceType: "docker",
		dockerImage: IMAGE,
		serverId: null,
		buildServerId: null,
		env: null,
		command: null,
		args: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuLimit: null,
		cpuReservation: null,
		replicas: 1,
		networkSwarm: [{ Target: NETWORK }],
		rollbackActive: false,
		previewEnv: "",
		previewBuildArgs: "",
		previewBuildSecrets: "",
		owner: "owner",
		repository: "repository",
		githubId: "github",
		mounts: [],
		ports: [],
		domains: [],
		security: [],
		redirects: [],
		registry: null,
		buildRegistry: null,
		rollbackRegistry: null,
		environmentId: "env",
		environment,
		...overrides,
	};
};

const request = {
	applicationId: "app",
	titleLog: "Deploy",
	descriptionLog: "",
};

// The deploy functions change the application they load, as the real query
// returns a new object each time.
const loads = (application: ApplicationFixture) => {
	vi.mocked(db.query.applications.findFirst).mockImplementation((async () =>
		structuredClone(application)) as never);
};

const run = async (
	deploy: () => Promise<unknown>,
): Promise<{
	failure: Error | null;
	elapsedMs: number;
	log: string;
	deploymentStatuses: unknown[];
	savedStatuses: Record<string, unknown>[];
}> => {
	mocks.savedValues.length = 0;
	mocks.updateDeploymentStatus.mockClear();
	mocks.sendBuildErrorNotifications.mockClear();
	mocks.sendBuildSuccessNotifications.mockClear();
	mocks.updateIssueComment.mockClear();
	const startedAt = Date.now();
	const failure = await deploy().then(
		() => null,
		(error: Error) => error,
	);
	const elapsedMs = Date.now() - startedAt;
	return {
		failure,
		elapsedMs,
		log: await readFile(mocks.logPaths.at(-1) as string, "utf8").catch(
			() => "",
		),
		deploymentStatuses: mocks.updateDeploymentStatus.mock.calls.map(
			([, status]) => status,
		),
		savedStatuses: [...mocks.savedValues],
	};
};

const deploy = (application: ApplicationFixture) => {
	loads(application);
	return run(() => deployApplication(request));
};

// Pulls nothing, unlike a deployment of a Docker image, so an image can stay
// local and a slow registry stays out of tests about what happens after the build.
const rebuild = (application: ApplicationFixture) => {
	loads(application);
	return run(() => rebuildApplication(request));
};

const inspect = (appName: string) => docker.getService(appName).inspect();

const runningTasks = async (appName: string) =>
	(
		await docker.listTasks({
			filters: JSON.stringify({
				service: [appName],
				"desired-state": ["running"],
			}),
		})
	).filter((task) => task.Status?.State === "running");

const expectReportedDone = (
	result: Awaited<ReturnType<typeof run>>,
	notified = true,
) => {
	expect(result.failure).toBeNull();
	expect(result.deploymentStatuses).toEqual(["done"]);
	expect(result.log).not.toContain("Error occurred");
	if (notified) {
		expect(mocks.sendBuildSuccessNotifications).toHaveBeenCalledTimes(1);
	}
	expect(mocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
};

const expectReportedFailed = (
	result: Awaited<ReturnType<typeof run>>,
	reason: RegExp,
	notified = true,
) => {
	expect(result.failure?.message).toMatch(reason);
	expect(result.deploymentStatuses).toEqual(["error"]);
	expect(result.log).toMatch(reason);
	expect(result.log).toContain("Error occurred");
	expect(result.log).not.toContain("runs the new version");
	expect(mocks.sendBuildSuccessNotifications).not.toHaveBeenCalled();
	if (notified) {
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
		expect(
			mocks.sendBuildErrorNotifications.mock.calls[0]?.[0].errorMessage,
		).toMatch(reason);
	}
};

const ROLLED_BACK = /Swarm (rolled|is rolling) back/;

const pullImage = async (attemptsLeft = 3): Promise<void> => {
	await dockerCli("pull", IMAGE).catch(async (error) => {
		if (attemptsLeft <= 1) {
			throw error;
		}
		await pullImage(attemptsLeft - 1);
	});
};

// The tests that run `deployApplication` pull from a registry, so one failed
// attempt is retried: it may be the network.
describe("application deployments on real Docker", { retry: 1 }, () => {
	beforeAll(async () => {
		mocks.logDirectory.path = await mkdtemp(
			path.join(tmpdir(), "application-rollout-"),
		);
		await pullImage();
		await dockerCli(
			"network",
			"create",
			"--driver",
			"overlay",
			"--attachable",
			NETWORK,
		);
		// Longer than the limit of a task that reports an error, and invisible in
		// the service spec, which has no health check of its own here.
		await buildImage(
			SLOW_HEALTH_IMAGE,
			`FROM ${IMAGE}
HEALTHCHECK --interval=1s --timeout=1s --retries=2 --start-period=120s CMD test -f /tmp/ready
CMD ["/bin/sh", "-c", "sleep ${(LIMIT_WITHOUT_STOP_GRACE_MS + 5_000) / 1000}; touch /tmp/ready; exec redis-server"]
`,
		);
	}, REAL_TEST_TIMEOUT);

	afterAll(async () => {
		for (const appName of appNames) {
			await docker
				.getService(appName)
				.remove()
				.catch(() => undefined);
		}
		const deadline = Date.now() + 30_000;
		// A task keeps its overlay endpoint for a moment after its service is gone.
		while (Date.now() < deadline) {
			const removed = await dockerCli("network", "rm", NETWORK).then(
				() => true,
				() => false,
			);
			if (removed) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		for (const image of images) {
			await dockerCli("image", "rm", "--force", image).catch(() => undefined);
		}
		await rm(mocks.logDirectory.path, { recursive: true, force: true });
	}, REAL_TEST_TIMEOUT);

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it(
		"reports a first deployment and a redeploy after the new task runs",
		async () => {
			const application = applicationFixture("good");

			const first = await deploy(application);
			expectReportedDone(first);
			expect(first.savedStatuses).toEqual([{ applicationStatus: "done" }]);
			const [firstTask] = await runningTasks(application.appName);
			expect(firstTask).toBeDefined();

			const second = await deploy(application);
			expectReportedDone(second);

			const info = await inspect(application.appName);
			expect(info.UpdateStatus?.State).toBe("completed");
			const [secondTask] = await runningTasks(application.appName);
			expect(secondTask?.ID).not.toBe(firstTask?.ID);
			expect(secondTask?.Spec?.ForceUpdate).toBe(
				info.Spec.TaskTemplate.ForceUpdate,
			);
			expect(second.log).toContain("Waiting for Swarm");
			expect(second.log).toContain("runs the new version");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a rolled-back deployment as failed, and the next one starts clean right away",
		async () => {
			const application = applicationFixture("rollback");
			expectReportedDone(await deploy(application));

			const failed = await deploy({ ...application, ...CRASHES });

			expectReportedFailed(failed, ROLLED_BACK);
			expect(failed.failure?.message).toContain("non-zero exit (3)");
			expect(failed.failure?.message).toContain("previous configuration");
			expect(failed.savedStatuses).toEqual([{ applicationStatus: "error" }]);
			expect(
				(await inspect(application.appName)).Spec.TaskTemplate.ContainerSpec
					.Args,
			).toBeUndefined();

			const next = await deploy(application);

			expectReportedDone(next);
			expect((await inspect(application.appName)).UpdateStatus?.State).toBe(
				"completed",
			);
			expect(await runningTasks(application.appName)).toHaveLength(1);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a rolled-back rebuild as failed, with the failure notification",
		async () => {
			const application = applicationFixture("rebuild");
			expectReportedDone(await deploy(application));
			expectReportedDone(await rebuild(application));

			const failed = await rebuild({ ...application, ...CRASHES });

			expectReportedFailed(failed, ROLLED_BACK);
			expect(failed.savedStatuses).toEqual([{ applicationStatus: "error" }]);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a health check that fails on the new task",
		async () => {
			const application = applicationFixture("unhealthy");
			expectReportedDone(await rebuild(application));

			const failed = await rebuild({
				...application,
				healthCheckSwarm: {
					Test: ["CMD-SHELL", "exit 1"],
					Interval: 1_000_000_000,
					Timeout: 1_000_000_000,
					Retries: 2,
				},
			});

			expectReportedFailed(
				failed,
				/Swarm (rolled|is rolling) back.*stopped or failed its health check/,
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"waits for a health check of the image past the limit of a task with an error",
		async () => {
			const application = applicationFixture("slow-health", NO_STOP_GRACE);
			expectReportedDone(await rebuild(application));

			const updated = await rebuild({
				...application,
				dockerImage: SLOW_HEALTH_IMAGE,
			});

			expectReportedDone(updated);
			expect(updated.elapsedMs).toBeGreaterThan(LIMIT_WITHOUT_STOP_GRACE_MS);
			const info = await inspect(application.appName);
			expect(info.Spec.TaskTemplate.ContainerSpec.Healthcheck).toBeUndefined();
			expect(info.UpdateStatus?.State).toBe("completed");
			const [task] = await runningTasks(application.appName);
			expect(task?.Spec?.ContainerSpec?.Image).toContain(SLOW_HEALTH_IMAGE);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports the failed update of two replicas, which Swarm can later call completed",
		async () => {
			const application = applicationFixture("two-replicas", { replicas: 2 });
			expectReportedDone(await rebuild(application));
			expect(await runningTasks(application.appName)).toHaveLength(2);
			expectReportedDone(await rebuild(application));

			const failed = await rebuild({ ...application, ...CRASHES });

			expectReportedFailed(failed, ROLLED_BACK);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a global service once its update completes",
		async () => {
			const application = applicationFixture("global", {
				modeSwarm: { Global: {} },
			});
			expectReportedDone(await rebuild(application));

			expectReportedDone(await rebuild(application));

			expect((await inspect(application.appName)).UpdateStatus?.State).toBe(
				"completed",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"does not trust the completed update of tasks that keep crashing, with FailureAction continue",
		async () => {
			const application = applicationFixture("continue", {
				...NO_STOP_GRACE,
				updateConfigSwarm: {
					Parallelism: 1,
					Order: "stop-first",
					FailureAction: "continue",
				},
			});
			expectReportedDone(await rebuild(application));

			const failed = await rebuild({ ...application, ...CRASHES });

			expectReportedFailed(failed, /did not converge.*non-zero exit \(3\)/);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a first deployment that crashes seconds after it starts",
		async () => {
			const application = applicationFixture("fresh-crash", {
				...NO_STOP_GRACE,
				command: "/bin/sh",
				args: ["-c", "sleep 2; exit 3"],
			});

			const failed = await rebuild(application);

			expectReportedFailed(failed, /did not converge.*non-zero exit \(3\)/);
			expect(failed.elapsedMs).toBeLessThan(
				LIMIT_WITHOUT_STOP_GRACE_MS + 30_000,
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports an update that cannot start next to the old task on a host-mode port",
		async () => {
			const application = applicationFixture("host-port", {
				...NO_STOP_GRACE,
				ports: [
					{
						publishMode: "host",
						protocol: "tcp",
						targetPort: 6379,
						publishedPort: 20_000 + Math.floor(Math.random() * 20_000),
					},
				],
			});
			expectReportedDone(await rebuild(application));
			const [before] = await runningTasks(application.appName);

			const failed = await rebuild(application);

			expectReportedFailed(
				failed,
				/did not converge.*still updating.*host-mode port already in use/,
			);
			expect(failed.elapsedMs).toBeLessThan(
				LIMIT_WITHOUT_STOP_GRACE_MS + 30_000,
			);
			const running = await runningTasks(application.appName);
			expect(running.map((task) => task.ID)).toEqual([before?.ID]);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports both kinds of preview deployment, on the preview's own service",
		async () => {
			const application = applicationFixture("preview-base", {
				sourceType: "github",
				buildType: "dockerfile",
				replicas: 1,
			});
			const previewAppName = newAppName("preview");
			const previewImage = `${previewAppName}:latest`;
			images.push(previewImage);
			await dockerCli("tag", IMAGE, previewImage);
			vi.mocked(db.query.previewDeployments.findFirst).mockResolvedValue({
				previewDeploymentId: "preview",
				appName: previewAppName,
				branch: "feature",
				pullRequestNumber: "1",
				pullRequestCommentId: "1",
				domain: { host: "preview.example.com", https: false },
				application: { applicationId: "app", serverId: null },
			} as never);
			const previewRequest = { ...request, previewDeploymentId: "preview" };
			const lastComment = () =>
				mocks.updateIssueComment.mock.calls.at(-1)?.[0]?.body;

			loads(application);
			const first = await run(() => deployPreviewApplication(previewRequest));
			expectReportedDone(first, false);
			expect(first.savedStatuses).toContainEqual({ previewStatus: "done" });
			expect(lastComment()).toContain("success");
			expect(first.log).toContain("runs the new version");
			expect(await runningTasks(previewAppName)).toHaveLength(1);
			await expect(inspect(application.appName)).rejects.toThrow();

			loads({ ...application, ...CRASHES });
			const failed = await run(() => deployPreviewApplication(previewRequest));
			expectReportedFailed(failed, ROLLED_BACK, false);
			expect(failed.savedStatuses).toContainEqual({ previewStatus: "error" });
			expect(lastComment()).toContain("error");

			loads(application);
			const rebuilt = await run(() =>
				rebuildPreviewApplication(previewRequest),
			);
			expectReportedDone(rebuilt, false);
			expect(rebuilt.savedStatuses).toContainEqual({ previewStatus: "done" });
			expect(lastComment()).toContain("success");

			loads({ ...application, ...CRASHES });
			const failedRebuild = await run(() =>
				rebuildPreviewApplication(previewRequest),
			);
			expectReportedFailed(failedRebuild, ROLLED_BACK, false);
			expect(failedRebuild.savedStatuses).toContainEqual({
				previewStatus: "error",
			});
			expect(lastComment()).toContain("error");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"keeps the panel's rollback working after a failed deployment",
		async () => {
			const application = applicationFixture("panel-rollback");
			expectReportedDone(await rebuild(application));
			expectReportedFailed(
				await rebuild({ ...application, ...CRASHES }),
				ROLLED_BACK,
			);
			vi.mocked(db.query.rollbacks.findFirst).mockResolvedValue({
				rollbackId: "rollback",
				deploymentId: "deployment",
				image: IMAGE,
				fullContext: application,
			} as never);
			const [beforeRollback] = await runningTasks(application.appName);

			await rollback("rollback");
			await waitForSwarmServiceConvergence(application.appName);

			const info = await inspect(application.appName);
			expect(info.UpdateStatus?.State).toBe("completed");
			const running = await runningTasks(application.appName);
			expect(running).toHaveLength(1);
			expect(running[0]?.ID).not.toBe(beforeRollback?.ID);
			expect(running[0]?.Spec?.ContainerSpec?.Image).toContain(IMAGE);

			expectReportedDone(await rebuild(application));
		},
		REAL_TEST_TIMEOUT,
	);
});
