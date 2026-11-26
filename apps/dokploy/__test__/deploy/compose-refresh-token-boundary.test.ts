import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
	shouldDeploy: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
	findCompose: vi.fn(),
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
				findFirst: vi.fn(),
			},
			compose: {
				findFirst: dbMocks.findCompose,
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
	compose: {
		refreshToken: "compose.refreshToken",
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

const { default: composeDeployHandler } = await import(
	"../../pages/api/deploy/compose/[refreshToken]"
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
			refreshToken: "compose-refresh-token",
		},
		headers: {
			"x-github-event": "push",
			"x-hub-signature-256": "sha256=signature",
		},
		body: {
			ref: "refs/heads/main",
			head_commit: {
				id: "sha-main",
				message: "Deploy compose",
			},
			commits: [
				{
					modified: ["docker-compose.yml"],
				},
			],
		},
	}) as unknown as NextApiRequest;

const createGitlabRequest = (token: string) =>
	({
		method: "POST",
		query: {
			refreshToken: "compose-refresh-token",
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
					message: "Deploy compose",
					modified: ["docker-compose.yml"],
				},
			],
		},
	}) as unknown as NextApiRequest;

const createGiteaRequest = () =>
	({
		method: "POST",
		query: {
			refreshToken: "compose-refresh-token",
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
					message: "Deploy compose",
					modified: ["docker-compose.yml"],
				},
			],
		},
	}) as unknown as NextApiRequest;

const createManualRequest = () =>
	({
		method: "POST",
		query: {
			refreshToken: "compose-refresh-token",
		},
		headers: {},
		body: {},
	}) as unknown as NextApiRequest;

const createCompose = (overrides: Record<string, unknown> = {}) => ({
	autoDeploy: true,
	bitbucket: null,
	branch: "main",
	composeId: "compose-1",
	gitea: null,
	github: {
		githubWebhookSecret: "github-webhook-secret",
	},
	gitlab: null,
	serverId: null,
	sourceType: "github",
	watchPaths: ["docker-compose.yml"],
	...overrides,
});

describe("compose refresh-token deploy webhook authentication", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serverMocks.shouldDeploy.mockReturnValue(true);
		queueMocks.add.mockResolvedValue(undefined);
		webhookMocks.verify.mockResolvedValue(true);
		dbMocks.findCompose.mockResolvedValue(createCompose());
	});

	it("rejects unsigned GitHub compose deploy webhooks before queuing deployments", async () => {
		webhookMocks.verify.mockResolvedValue(false);
		const response = createResponse();

		await composeDeployHandler(createGithubRequest(), response);

		expect(response.status).toHaveBeenCalledWith(401);
		expect(response.json).toHaveBeenCalledWith({
			message: "Invalid webhook signature",
		});
		expect(serverMocks.shouldDeploy).not.toHaveBeenCalled();
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("allows signed GitHub compose deploy webhooks to continue to deployment queueing", async () => {
		const response = createResponse();

		await composeDeployHandler(createGithubRequest(), response);

		expect(webhookMocks.verify).toHaveBeenCalledWith(
			JSON.stringify(createGithubRequest().body),
			"sha256=signature",
		);
		expect(queueMocks.add).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationType: "compose",
				composeId: "compose-1",
				type: "deploy",
			}),
			expect.any(Object),
		);
		expect(response.status).toHaveBeenCalledWith(200);
	});

	it("rejects GitLab compose deploy webhooks when the provider token mismatches", async () => {
		dbMocks.findCompose.mockResolvedValue(
			createCompose({
				github: null,
				gitlab: {
					secret: "gitlab-webhook-secret",
				},
				gitlabBranch: "main",
				sourceType: "gitlab",
			}),
		);
		const response = createResponse();

		await composeDeployHandler(createGitlabRequest("wrong-token"), response);

		expect(response.status).toHaveBeenCalledWith(401);
		expect(response.json).toHaveBeenCalledWith({
			message: "Invalid webhook signature",
		});
		expect(serverMocks.shouldDeploy).not.toHaveBeenCalled();
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("allows GitLab compose deploy webhooks when the provider token matches", async () => {
		dbMocks.findCompose.mockResolvedValue(
			createCompose({
				github: null,
				gitlab: {
					secret: "gitlab-webhook-secret",
				},
				gitlabBranch: "main",
				sourceType: "gitlab",
			}),
		);
		const response = createResponse();

		await composeDeployHandler(
			createGitlabRequest("gitlab-webhook-secret"),
			response,
		);

		expect(queueMocks.add).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationType: "compose",
				composeId: "compose-1",
				type: "deploy",
			}),
			expect.any(Object),
		);
		expect(response.status).toHaveBeenCalledWith(200);
	});

	it("rejects provider webhook headers that have no verifiable stored webhook secret", async () => {
		dbMocks.findCompose.mockResolvedValue(
			createCompose({
				gitea: {
					giteaId: "gitea-1",
				},
				giteaBranch: "main",
				github: null,
				sourceType: "gitea",
			}),
		);
		const response = createResponse();

		await composeDeployHandler(createGiteaRequest(), response);

		expect(response.status).toHaveBeenCalledWith(401);
		expect(response.json).toHaveBeenCalledWith({
			message: "Invalid webhook signature",
		});
		expect(serverMocks.shouldDeploy).not.toHaveBeenCalled();
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("keeps manual refresh-token compose deploy POSTs separate from provider webhook authentication", async () => {
		dbMocks.findCompose.mockResolvedValue(
			createCompose({
				github: null,
				sourceType: "raw",
			}),
		);
		const response = createResponse();

		await composeDeployHandler(createManualRequest(), response);

		expect(queueMocks.add).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationType: "compose",
				composeId: "compose-1",
				type: "deploy",
			}),
			expect.any(Object),
		);
		expect(response.status).toHaveBeenCalledWith(200);
	});
});
