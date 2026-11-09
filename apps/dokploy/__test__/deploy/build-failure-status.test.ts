import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const chain: Record<string, ReturnType<typeof vi.fn>> = {};
	chain.set = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.returning = vi.fn().mockResolvedValue([{}]);
	return {
		chain,
		execAsync: vi.fn(),
		execAsyncRemote: vi.fn(),
		updateDeploymentStatus: vi.fn(),
		sendBuildErrorNotifications: vi.fn(),
		sendBuildSuccessNotifications: vi.fn(),
		mechanizeDockerContainer: vi.fn(),
		waitForApplicationRollout: vi.fn(),
		waitForStackRollout: vi.fn(),
		waitForComposeContainers: vi.fn(),
	};
});

vi.mock("@dokploy/server/utils/docker/compose-containers", () => ({
	waitForComposeContainers: mocks.waitForComposeContainers,
}));

vi.mock("@dokploy/server/utils/docker/stack-rollout", () => ({
	waitForStackRollout: mocks.waitForStackRollout,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: vi.fn(() => mocks.chain),
		query: {
			applications: { findFirst: vi.fn() },
			compose: { findFirst: vi.fn() },
			previewDeployments: { findFirst: vi.fn() },
			server: {
				findFirst: vi.fn().mockResolvedValue({ buildTimeoutMinutes: 60 }),
			},
		},
	},
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/services/deployment", () => {
	const deployment = {
		deploymentId: "dep-1",
		logPath: "/etc/dokploy/logs/app/app.log",
	};
	return {
		createDeployment: vi.fn().mockResolvedValue(deployment),
		createDeploymentCompose: vi.fn().mockResolvedValue(deployment),
		createDeploymentPreview: vi.fn().mockResolvedValue(deployment),
		updateDeployment: vi.fn(),
		updateDeploymentStatus: mocks.updateDeploymentStatus,
	};
});
vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn().mockResolvedValue("https://panel.example.com"),
}));
vi.mock("@dokploy/server/services/github", () => ({
	issueCommentExists: vi.fn().mockResolvedValue(true),
	createPreviewDeploymentComment: vi.fn(),
	getIssueComment: vi.fn().mockReturnValue(""),
	updateIssueComment: vi.fn(),
	findGithubById: vi.fn(),
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: vi.fn().mockResolvedValue("patch;"),
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.sendBuildErrorNotifications,
}));
vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: mocks.sendBuildSuccessNotifications,
}));
vi.mock("@dokploy/server/utils/providers/github", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/github")
	>("@dokploy/server/utils/providers/github");
	return {
		...actual,
		cloneGithubRepository: vi.fn().mockResolvedValue("clone;"),
	};
});
vi.mock("@dokploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders")
	>("@dokploy/server/utils/builders");
	return {
		...actual,
		getBuildCommand: vi.fn().mockResolvedValue("build;"),
		mechanizeDockerContainer: mocks.mechanizeDockerContainer,
		waitForApplicationRollout: mocks.waitForApplicationRollout,
	};
});
vi.mock("@dokploy/server/utils/builders/compose", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders/compose")
	>("@dokploy/server/utils/builders/compose");
	return {
		...actual,
		getBuildComposeCommand: vi.fn().mockResolvedValue("compose up;"),
	};
});

import { db } from "@dokploy/server/db";
import {
	deployApplication,
	deployPreviewApplication,
	rebuildApplication,
	rebuildPreviewApplication,
} from "@dokploy/server/services/application";
import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";
import {
	issueCommentExists,
	updateIssueComment,
} from "@dokploy/server/services/github";
import { settleBackgroundNotifications } from "@dokploy/server/utils/notifications/background";
import { ExecError } from "@dokploy/server/utils/process/ExecError";

const LOST_CONNECTION = "SSH connection error: Keepalive timeout";
const lostConnection = () =>
	new ExecError(LOST_CONNECTION, {
		command: "build",
		serverId: "build-server",
	});

const application = {
	applicationId: "app-1",
	name: "Web",
	appName: "web-app",
	sourceType: "github",
	owner: "Dokploy",
	repository: "examples",
	githubId: "gh-1",
	serverId: "deploy-server",
	buildServerId: "build-server",
	previewEnv: "",
	previewBuildArgs: "",
	previewBuildSecrets: "",
	domains: [],
	environment: { name: "dev", project: { name: "p", organizationId: "org-1" } },
};

const compose = {
	composeId: "compose-1",
	name: "Stack",
	appName: "stack",
	sourceType: "raw",
	composeFile: "services: {}",
	composePath: "docker-compose.yml",
	serverId: "deploy-server",
	domains: [],
	environment: { name: "dev", project: { name: "p", organizationId: "org-1" } },
};

const applicationRequest = {
	applicationId: "app-1",
	titleLog: "Deploy",
	descriptionLog: "",
};
const composeRequest = {
	composeId: "compose-1",
	titleLog: "Deploy",
	descriptionLog: "",
};

const savedStatuses = () =>
	mocks.chain.set?.mock.calls.map(([values]) => values) ?? [];

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.chain.set?.mockImplementation(() => mocks.chain);
	mocks.chain.where?.mockImplementation(() => mocks.chain);
	mocks.chain.returning?.mockResolvedValue([{}]);
	// A preview deployment renames the application it loads.
	vi.mocked(db.query.applications.findFirst).mockImplementation((async () =>
		structuredClone(application)) as never);
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(compose as never);
	vi.mocked(db.query.previewDeployments.findFirst).mockResolvedValue({
		previewDeploymentId: "preview-1",
		appName: "preview-web",
		branch: "feature",
		pullRequestNumber: "1",
		pullRequestCommentId: "1",
		domain: { host: "preview.example.com", https: false },
		application,
	} as never);
	// Every remote command fails, as it does while the network is down.
	mocks.execAsyncRemote.mockRejectedValue(lostConnection());
});

describe("a build that loses the connection to its server", () => {
	it("marks an application deployment as failed", async () => {
		await expect(deployApplication(applicationRequest)).rejects.toThrow(
			LOST_CONNECTION,
		);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(savedStatuses()).toContainEqual({ applicationStatus: "error" });
		expect(savedStatuses()).toContainEqual({ errorMessage: LOST_CONNECTION });
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledWith(
			expect.objectContaining({ errorMessage: LOST_CONNECTION }),
		);
		expect(mocks.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("marks an application rebuild as failed", async () => {
		await expect(rebuildApplication(applicationRequest)).rejects.toThrow(
			LOST_CONNECTION,
		);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(savedStatuses()).toContainEqual({ applicationStatus: "error" });
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledWith(
			expect.objectContaining({ errorMessage: LOST_CONNECTION }),
		);
	});

	it("marks a preview rebuild as failed", async () => {
		await expect(
			rebuildPreviewApplication({
				...applicationRequest,
				previewDeploymentId: "preview-1",
			}),
		).rejects.toThrow(LOST_CONNECTION);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(savedStatuses()).toContainEqual({ previewStatus: "error" });
	});

	it("marks a compose deployment as failed", async () => {
		await expect(deployCompose(composeRequest)).rejects.toThrow(
			LOST_CONNECTION,
		);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(savedStatuses()).toContainEqual({ composeStatus: "error" });
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalled();
	});

	it("marks a compose rebuild as failed", async () => {
		await expect(rebuildCompose(composeRequest)).rejects.toThrow(
			LOST_CONNECTION,
		);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(savedStatuses()).toContainEqual({ composeStatus: "error" });
	});
});

describe("the rollout of a stack", () => {
	const ROLLED_BACK = "Swarm rolled back the update of service stack_web";
	const logged = (text: string) =>
		mocks.execAsyncRemote.mock.calls.find(([, command]) =>
			String(command).includes(
				Buffer.from(text).toString("base64").slice(0, 24),
			),
		);

	beforeEach(() => {
		mocks.execAsyncRemote.mockReset();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForStackRollout.mockReset();
		mocks.waitForStackRollout.mockResolvedValue(2);
	});

	const asStack = () =>
		vi
			.mocked(db.query.compose.findFirst)
			.mockResolvedValue({ ...compose, composeType: "stack" } as never);

	it.each([
		["deployment", deployCompose],
		["rebuild", rebuildCompose],
	])("waits for it on the stack's server after a %s", async (_, deploy) => {
		asStack();

		await deploy(composeRequest);

		expect(mocks.waitForStackRollout).toHaveBeenCalledWith(
			"stack",
			"deploy-server",
		);
		const buildOrder =
			mocks.execAsyncRemote.mock.invocationCallOrder.at(0) ?? 0;
		expect(
			mocks.waitForStackRollout.mock.invocationCallOrder[0],
		).toBeGreaterThan(buildOrder);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
		expect(savedStatuses()).toContainEqual({ composeStatus: "done" });
		expect(logged("The stack runs the new version")).toBeDefined();
	});

	it.each([
		["deployment", deployCompose],
		["rebuild", rebuildCompose],
	])("marks a %s as failed when a service rolled back", async (_, deploy) => {
		asStack();
		mocks.waitForStackRollout.mockRejectedValue(new Error(ROLLED_BACK));

		await expect(deploy(composeRequest)).rejects.toThrow(ROLLED_BACK);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalledWith(
			"dep-1",
			"done",
		);
		expect(savedStatuses()).toContainEqual({ composeStatus: "error" });
		expect(logged(ROLLED_BACK)).toBeDefined();
		expect(mocks.sendBuildSuccessNotifications).not.toHaveBeenCalled();
	});

	it("notifies with the reason after a failed deployment", async () => {
		asStack();
		mocks.waitForStackRollout.mockRejectedValue(new Error(ROLLED_BACK));

		await expect(deployCompose(composeRequest)).rejects.toThrow(ROLLED_BACK);

		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledWith(
			expect.objectContaining({ errorMessage: ROLLED_BACK }),
		);
	});

	it("says so when the stack has nothing to wait for", async () => {
		asStack();
		mocks.waitForStackRollout.mockResolvedValue(0);

		await deployCompose(composeRequest);

		expect(logged("This stack has no service to wait for")).toBeDefined();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
	});

	it.each([
		["deployment", deployCompose],
		["rebuild", rebuildCompose],
	])(
		"does not wait for Swarm after a %s of the docker-compose type",
		async (_, deploy) => {
			vi.mocked(db.query.compose.findFirst).mockResolvedValue({
				...compose,
				composeType: "docker-compose",
			} as never);

			await deploy(composeRequest);

			expect(mocks.waitForStackRollout).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"done",
			);
		},
	);
});

describe("the containers of a docker-compose project", () => {
	const EXITED = "Container stack-web-1 exited with code 1";
	const logged = (text: string) =>
		mocks.execAsyncRemote.mock.calls.find(([, command]) =>
			String(command).includes(
				Buffer.from(text).toString("base64").slice(0, 24),
			),
		);

	beforeEach(() => {
		mocks.execAsyncRemote.mockReset();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForComposeContainers.mockReset();
		mocks.waitForComposeContainers.mockResolvedValue(3);
		vi.mocked(db.query.compose.findFirst).mockResolvedValue({
			...compose,
			composeType: "docker-compose",
		} as never);
	});

	it.each([
		["deployment", deployCompose],
		["rebuild", rebuildCompose],
	])(
		"are checked on the project's server after a %s, from the start of `up`",
		async (_, deploy) => {
			const before = Date.now();

			await deploy(composeRequest);

			expect(mocks.waitForComposeContainers).toHaveBeenCalledTimes(1);
			const [project, server, options] =
				mocks.waitForComposeContainers.mock.calls[0] ?? [];
			expect([project, server]).toEqual(["stack", "deploy-server"]);
			expect(options.startedSince).toBeGreaterThanOrEqual(before);
			expect(options.startedSince).toBeLessThanOrEqual(Date.now());
			// The `up` command is the last one the build runner sends.
			let lastBuildCommand = -1;
			mocks.execAsyncRemote.mock.calls.forEach(([, command], index) => {
				if (String(command).includes("dokploy-build:")) {
					lastBuildCommand = index;
				}
			});
			expect(lastBuildCommand).toBeGreaterThanOrEqual(0);
			expect(
				mocks.waitForComposeContainers.mock.invocationCallOrder[0],
			).toBeGreaterThan(
				mocks.execAsyncRemote.mock.invocationCallOrder[lastBuildCommand] ?? 0,
			);
			expect(mocks.waitForStackRollout).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"done",
			);
			expect(logged("The containers run ✅ (3 containers)")).toBeDefined();
		},
	);

	it.each([
		["deployment", deployCompose],
		["rebuild", rebuildCompose],
	])(
		"mark a %s as failed when a container did not stay up",
		async (_, deploy) => {
			mocks.waitForComposeContainers.mockRejectedValue(new Error(EXITED));

			await expect(deploy(composeRequest)).rejects.toThrow(EXITED);

			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"error",
			);
			expect(mocks.updateDeploymentStatus).not.toHaveBeenCalledWith(
				"dep-1",
				"done",
			);
			expect(savedStatuses()).toContainEqual({ composeStatus: "error" });
			expect(logged(EXITED)).toBeDefined();
			expect(mocks.sendBuildSuccessNotifications).not.toHaveBeenCalled();
		},
	);

	it("notify with the reason after a failed deployment", async () => {
		mocks.waitForComposeContainers.mockRejectedValue(new Error(EXITED));

		await expect(deployCompose(composeRequest)).rejects.toThrow(EXITED);

		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledWith(
			expect.objectContaining({ errorMessage: EXITED }),
		);
	});

	it("say so when the project has no container", async () => {
		mocks.waitForComposeContainers.mockResolvedValue(0);

		await deployCompose(composeRequest);

		expect(logged("This project has no container to check")).toBeDefined();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
	});

	it("are not checked for a stack", async () => {
		vi.mocked(db.query.compose.findFirst).mockResolvedValue({
			...compose,
			composeType: "stack",
		} as never);
		mocks.waitForStackRollout.mockResolvedValue(1);

		await deployCompose(composeRequest);

		expect(mocks.waitForComposeContainers).not.toHaveBeenCalled();
	});
});

describe("a rollout that Swarm does not finish", () => {
	const ROLLED_BACK = "Swarm rolled back the update of service web-app";
	const previewRequest = {
		...applicationRequest,
		previewDeploymentId: "preview-1",
	};

	beforeEach(() => {
		mocks.execAsyncRemote.mockReset();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForApplicationRollout.mockRejectedValue(new Error(ROLLED_BACK));
	});

	const failureLogLine = () =>
		mocks.execAsyncRemote.mock.calls.find(([, command]) =>
			String(command).includes(Buffer.from(ROLLED_BACK).toString("base64")),
		);

	it.each([
		["deployment", deployApplication],
		["rebuild", rebuildApplication],
	])("marks an application %s as failed and notifies", async (_, deploy) => {
		await expect(deploy(applicationRequest)).rejects.toThrow(ROLLED_BACK);

		expect(mocks.waitForApplicationRollout).toHaveBeenCalledWith(
			"web-app",
			"deploy-server",
		);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalledWith(
			"dep-1",
			"done",
		);
		expect(savedStatuses()).toContainEqual({ applicationStatus: "error" });
		expect(mocks.sendBuildSuccessNotifications).not.toHaveBeenCalled();
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledWith(
			expect.objectContaining({ errorMessage: ROLLED_BACK }),
		);
		expect(failureLogLine()?.[0]).toBe("build-server");
	});

	it.each([
		["deployment", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])("marks a preview %s as failed and logs why", async (_, deploy) => {
		await expect(deploy(previewRequest)).rejects.toThrow(ROLLED_BACK);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(savedStatuses()).toContainEqual({ previewStatus: "error" });
		expect(savedStatuses()).not.toContainEqual({ previewStatus: "done" });
		expect(failureLogLine()?.[0]).toBe("build-server");
	});

	it("still reports the failure when the log is out of reach", async () => {
		mocks.execAsyncRemote.mockImplementation(async (_server, command) => {
			if (String(command).includes(">> ")) {
				if (!String(command).includes("dokploy-build:")) {
					throw lostConnection();
				}
			}
			return { stdout: "", stderr: "" };
		});

		await expect(deployApplication(applicationRequest)).rejects.toThrow(
			ROLLED_BACK,
		);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(savedStatuses()).toContainEqual({ errorMessage: ROLLED_BACK });
	});
});

describe("a build that succeeds", () => {
	beforeEach(() => {
		mocks.execAsyncRemote.mockReset();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForApplicationRollout.mockResolvedValue(undefined);
	});

	it("runs the whole application build on the build server under a timeout", async () => {
		await deployApplication(applicationRequest);

		const buildCall = mocks.execAsyncRemote.mock.calls.find(([, command]) =>
			String(command).includes("clone;patch;build;"),
		);
		expect(buildCall?.[0]).toBe("build-server");
		expect(buildCall?.[1]).toContain("timeout -k 30 3600;");
		expect(buildCall?.[1]).toContain(">> /etc/dokploy/logs/app/app.log 2>&1'");
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
		expect(mocks.mechanizeDockerContainer).toHaveBeenCalled();
	});

	it("keeps the done status when the log is out of reach after the rollout", async () => {
		mocks.execAsyncRemote.mockImplementation(async (_server, command) => {
			if (String(command).includes("base64 -d")) {
				throw lostConnection();
			}
			return { stdout: "", stderr: "" };
		});

		await deployApplication(applicationRequest);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
		expect(mocks.sendBuildSuccessNotifications).toHaveBeenCalled();
	});

	it("finishes while the success notification is still being sent", async () => {
		let release = () => {};
		mocks.sendBuildSuccessNotifications.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);

		await deployApplication(applicationRequest);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
		expect(mocks.sendBuildSuccessNotifications).toHaveBeenCalledTimes(1);
		release();
		await settleBackgroundNotifications();
	});

	it("keeps the done status when the success notification fails", async () => {
		mocks.sendBuildSuccessNotifications.mockRejectedValueOnce(
			new Error("database down"),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		await deployApplication(applicationRequest);
		await settleBackgroundNotifications();

		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalledWith(
			"dep-1",
			"error",
		);
		expect(log).toHaveBeenCalled();
		log.mockRestore();
	});

	it("runs every compose step under a timeout", async () => {
		await deployCompose(composeRequest);

		const steps = mocks.execAsyncRemote.mock.calls.filter(([, command]) =>
			String(command).includes(": dokploy-build:stack;"),
		);
		expect(steps.length).toBeGreaterThanOrEqual(2);
		for (const [serverId, command] of steps) {
			expect(serverId).toBe("deploy-server");
			expect(command).toContain("timeout -k 30 ");
		}
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
	});
});

describe("a preview while GitHub does not answer", () => {
	const previewRequest = {
		...applicationRequest,
		previewDeploymentId: "preview-1",
	};
	const GITHUB_DOWN = "getaddrinfo EAI_AGAIN api.github.com";

	beforeEach(() => {
		mocks.execAsyncRemote.mockReset();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForApplicationRollout.mockReset();
		mocks.waitForApplicationRollout.mockResolvedValue(undefined);
		vi.mocked(updateIssueComment).mockRejectedValue(new Error(GITHUB_DOWN));
	});

	it.each([
		["deployment", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])("finishes a preview %s and marks it done", async (_, deploy) => {
		await expect(deploy(previewRequest)).resolves.toBe(true);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "done");
		expect(savedStatuses()).toContainEqual({ previewStatus: "done" });
		expect(savedStatuses()).not.toContainEqual({ previewStatus: "error" });
	});

	it.each([
		["deployment", deployPreviewApplication],
		["rebuild", rebuildPreviewApplication],
	])(
		"marks a failed preview %s as failed, with the build's own error",
		async (_, deploy) => {
			mocks.waitForApplicationRollout.mockRejectedValue(
				new Error("rolled back"),
			);

			await expect(deploy(previewRequest)).rejects.toThrow("rolled back");

			expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
				"dep-1",
				"error",
			);
			expect(savedStatuses()).toContainEqual({ previewStatus: "error" });
		},
	);

	it("deploys a preview whose comment GitHub cannot create", async () => {
		vi.mocked(issueCommentExists).mockRejectedValueOnce(new Error(GITHUB_DOWN));

		await expect(deployPreviewApplication(previewRequest)).resolves.toBe(true);

		expect(savedStatuses()).toContainEqual({ previewStatus: "done" });
		expect(updateIssueComment).not.toHaveBeenCalled();
	});
});
