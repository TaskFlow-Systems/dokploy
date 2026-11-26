import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
	shouldDeploy: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
	findApplication: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
	add: vi.fn(),
}));

const webhookMocks = vi.hoisted(() => ({
	verify: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	getBitbucketHeaders: vi.fn(() => ({})),
	IS_CLOUD: false,
	shouldDeploy: serverMocks.shouldDeploy,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: {
				findFirst: dbMocks.findApplication,
			},
		},
	},
}));

vi.mock("@octokit/webhooks", () => ({
	Webhooks: class {
		verify = webhookMocks.verify;
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((left, right) => ({ left, right })),
}));

vi.mock("@/server/db/schema", () => ({
	applications: {
		refreshToken: "application.refreshToken",
	},
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: queueMocks,
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment-freeze", () => ({
	getActiveDeploymentFreeze: vi.fn(async () => null),
	recordSkippedDeploymentFreeze: vi.fn(async () => undefined),
}));

const { default: applicationDeployHandler } = await import(
	"../../pages/api/deploy/[refreshToken]"
);

const createResponse = () => {
	const response = {
		json: vi.fn(),
		setHeader: vi.fn(),
		status: vi.fn(),
	};
	response.status.mockReturnValue(response);
	return response as unknown as NextApiResponse & {
		json: ReturnType<typeof vi.fn>;
		setHeader: ReturnType<typeof vi.fn>;
		status: ReturnType<typeof vi.fn>;
	};
};

const createGithubRequest = () =>
	({
		method: "POST",
		query: {
			refreshToken: "application-refresh-token",
		},
		headers: {
			"x-github-event": "push",
			"x-hub-signature-256": "sha256=signature",
		},
		body: {
			ref: "refs/heads/main",
			head_commit: {
				id: "sha-main",
				message: "Deploy application",
			},
			commits: [
				{
					modified: ["src/index.ts"],
				},
			],
		},
	}) as unknown as NextApiRequest;

const createGitlabRequest = (token: string) =>
	({
		method: "POST",
		query: {
			refreshToken: "application-refresh-token",
		},
		headers: {
			"x-gitlab-event": "Push Hook",
			"x-gitlab-token": token,
		},
		body: {
			ref: "refs/heads/main",
			checkout_sha: "sha-main",
			commits: [
				{
					id: "sha-main",
					message: "Deploy application",
					modified: ["src/index.ts"],
				},
			],
		},
	}) as unknown as NextApiRequest;

const createGiteaRequest = () =>
	({
		method: "POST",
		query: {
			refreshToken: "application-refresh-token",
		},
		headers: {
			"x-gitea-event": "push",
		},
		body: {
			ref: "refs/heads/main",
			after: "sha-main",
			commits: [
				{
					id: "sha-main",
					message: "Deploy application",
					modified: ["src/index.ts"],
				},
			],
		},
	}) as unknown as NextApiRequest;

const createManualRequest = () =>
	({
		method: "POST",
		query: {
			refreshToken: "application-refresh-token",
		},
		headers: {},
		body: {},
	}) as unknown as NextApiRequest;

const createApplication = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "application-1",
	autoDeploy: true,
	bitbucket: null,
	branch: "main",
	dockerImage: "nginx:latest",
	gitea: null,
	github: {
		githubWebhookSecret: "github-webhook-secret",
	},
	gitlab: null,
	serverId: null,
	sourceType: "github",
	watchPaths: ["src/index.ts"],
	...overrides,
});

describe("application refresh-token deploy webhook authentication", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serverMocks.shouldDeploy.mockReturnValue(true);
		queueMocks.add.mockResolvedValue(undefined);
		webhookMocks.verify.mockResolvedValue(true);
		dbMocks.findApplication.mockResolvedValue(createApplication());
	});

	it("rejects unsigned GitHub application deploy webhooks before queuing deployments", async () => {
		webhookMocks.verify.mockResolvedValue(false);
		const response = createResponse();

		await applicationDeployHandler(createGithubRequest(), response);

		expect(response.status).toHaveBeenCalledWith(401);
		expect(response.json).toHaveBeenCalledWith({
			message: "Invalid webhook signature",
		});
		expect(serverMocks.shouldDeploy).not.toHaveBeenCalled();
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("allows signed GitHub application deploy webhooks to continue to deployment queueing", async () => {
		const response = createResponse();

		await applicationDeployHandler(createGithubRequest(), response);

		expect(webhookMocks.verify).toHaveBeenCalledWith(
			JSON.stringify(createGithubRequest().body),
			"sha256=signature",
		);
		expect(queueMocks.add).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-1",
				applicationType: "application",
				type: "deploy",
			}),
			expect.any(Object),
		);
		expect(response.status).toHaveBeenCalledWith(200);
	});

	it("rejects GitLab application deploy webhooks when the provider token mismatches", async () => {
		dbMocks.findApplication.mockResolvedValue(
			createApplication({
				github: null,
				gitlab: {
					secret: "gitlab-webhook-secret",
				},
				gitlabBranch: "main",
				sourceType: "gitlab",
			}),
		);
		const response = createResponse();

		await applicationDeployHandler(
			createGitlabRequest("wrong-token"),
			response,
		);

		expect(response.status).toHaveBeenCalledWith(401);
		expect(response.json).toHaveBeenCalledWith({
			message: "Invalid webhook signature",
		});
		expect(serverMocks.shouldDeploy).not.toHaveBeenCalled();
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("allows GitLab application deploy webhooks when the provider token matches", async () => {
		dbMocks.findApplication.mockResolvedValue(
			createApplication({
				github: null,
				gitlab: {
					secret: "gitlab-webhook-secret",
				},
				gitlabBranch: "main",
				sourceType: "gitlab",
			}),
		);
		const response = createResponse();

		await applicationDeployHandler(
			createGitlabRequest("gitlab-webhook-secret"),
			response,
		);

		expect(queueMocks.add).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-1",
				applicationType: "application",
				type: "deploy",
			}),
			expect.any(Object),
		);
		expect(response.status).toHaveBeenCalledWith(200);
	});

	it("rejects provider webhook headers that have no verifiable stored webhook secret", async () => {
		dbMocks.findApplication.mockResolvedValue(
			createApplication({
				gitea: {
					giteaId: "gitea-1",
				},
				giteaBranch: "main",
				github: null,
				sourceType: "gitea",
			}),
		);
		const response = createResponse();

		await applicationDeployHandler(createGiteaRequest(), response);

		expect(response.status).toHaveBeenCalledWith(401);
		expect(response.json).toHaveBeenCalledWith({
			message: "Invalid webhook signature",
		});
		expect(serverMocks.shouldDeploy).not.toHaveBeenCalled();
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("keeps manual refresh-token application deploy POSTs separate from provider webhook authentication", async () => {
		dbMocks.findApplication.mockResolvedValue(
			createApplication({
				github: null,
				sourceType: "docker",
			}),
		);
		const response = createResponse();

		await applicationDeployHandler(createManualRequest(), response);

		expect(queueMocks.add).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-1",
				applicationType: "application",
				type: "deploy",
			}),
			expect.any(Object),
		);
		expect(response.status).toHaveBeenCalledWith(200);
	});
});
