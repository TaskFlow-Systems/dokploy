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
		mechanizeDockerContainer: vi.fn(),
	};
});

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
	sendBuildSuccessNotifications: vi.fn(),
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
	rebuildApplication,
	rebuildPreviewApplication,
} from "@dokploy/server/services/application";
import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";
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
	vi.mocked(db.query.applications.findFirst).mockResolvedValue(
		application as never,
	);
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

describe("a build that succeeds", () => {
	beforeEach(() => {
		mocks.execAsyncRemote.mockReset();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
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
