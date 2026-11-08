import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
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

const { default: handler, getProviderByHeader } = await import(
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
		status: ReturnType<typeof vi.fn>;
	};
};

// Gitea marshals its payload in Go, indented and with HTML characters escaped:
// the signed bytes are not what JSON.stringify gives for the parsed body.
const giteaPayload = {
	ref: "refs/heads/main",
	after: "sha-main",
	commits: [
		{ id: "sha-main", message: "Fix <b> & more", modified: ["src/index.ts"] },
	],
};
const giteaRaw = JSON.stringify(giteaPayload, null, 2).replace(
	/[<>&]/g,
	(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
const sign = (secret: string, raw: string) =>
	createHmac("sha256", secret).update(raw).digest("hex");

// A request as Next hands it over with the body parser off: a stream.
const streamRequest = (
	raw: string,
	headers: Record<string, string>,
	chunkSize = 7,
) => {
	const buffer = Buffer.from(raw);
	const chunks: Buffer[] = [];
	for (let at = 0; at < buffer.length; at += chunkSize) {
		chunks.push(buffer.subarray(at, at + chunkSize));
	}
	const request = Readable.from(chunks) as unknown as NextApiRequest;
	Object.assign(request, {
		method: "POST",
		query: { refreshToken: "application-refresh-token" },
		headers: { "content-type": "application/json", ...headers },
		body: undefined,
	});
	return request;
};

const createApplication = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "application-1",
	autoDeploy: true,
	bitbucket: null,
	branch: "main",
	customGitBranch: "main",
	giteaBranch: "main",
	dockerImage: "nginx:latest",
	gitea: { webhookSecret: "gitea-hook-secret" },
	github: null,
	gitlab: null,
	serverId: null,
	sourceType: "gitea",
	watchPaths: ["src/index.ts"],
	...overrides,
});

describe("Gitea deploy webhook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serverMocks.shouldDeploy.mockReturnValue(true);
		queueMocks.add.mockResolvedValue(undefined);
		dbMocks.findApplication.mockResolvedValue(createApplication());
	});

	it("deploys a push signed with the provider's webhook secret", async () => {
		const response = createResponse();
		await handler(
			streamRequest(giteaRaw, {
				"x-gitea-event": "push",
				"x-gitea-signature": sign("gitea-hook-secret", giteaRaw),
			}),
			response,
		);

		expect(response.status).not.toHaveBeenCalledWith(401);
		expect(queueMocks.add).toHaveBeenCalled();
	});

	it("treats a real Gitea delivery, which also carries GitHub's headers, as Gitea", async () => {
		const githubStyleSignature = `sha256=${sign("gitea-hook-secret", giteaRaw)}`;
		const giteaHeaders = {
			"x-gitea-event": "push",
			"x-gitea-event-type": "push",
			"x-gitea-delivery": "delivery-1",
			"x-gitea-signature": sign("gitea-hook-secret", giteaRaw),
			"x-gogs-event": "push",
			"x-gogs-signature": sign("gitea-hook-secret", giteaRaw),
			"x-github-event": "push",
			"x-github-event-type": "push",
			"x-github-delivery": "delivery-1",
			"x-hub-signature": "sha1=0",
			"x-hub-signature-256": githubStyleSignature,
		};
		expect(getProviderByHeader(giteaHeaders)).toBe("gitea");

		const response = createResponse();
		await handler(streamRequest(giteaRaw, giteaHeaders), response);
		expect(response.status).not.toHaveBeenCalledWith(401);
		expect(queueMocks.add).toHaveBeenCalled();
		expect(webhookMocks.verify).not.toHaveBeenCalled();

		vi.clearAllMocks();
		const wrong = createResponse();
		await handler(
			streamRequest(giteaRaw, {
				...giteaHeaders,
				"x-gitea-signature": sign("other-secret", giteaRaw),
			}),
			wrong,
		);
		expect(wrong.status).toHaveBeenCalledWith(401);
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("still reads a delivery with only GitHub's headers as GitHub", () => {
		expect(
			getProviderByHeader({
				"x-github-event": "push",
				"x-hub-signature-256": "sha256=0",
			}),
		).toBe("github");
	});

	it("refuses a wrong signature, a missing one and a provider without a secret", async () => {
		for (const [application, signature] of [
			[createApplication(), sign("other-secret", giteaRaw)],
			[createApplication(), undefined],
			[createApplication({ gitea: { webhookSecret: null } }), "00"],
			[createApplication({ gitea: null, sourceType: "git" }), "00"],
		] as const) {
			dbMocks.findApplication.mockResolvedValue(application);
			const response = createResponse();
			await handler(
				streamRequest(giteaRaw, {
					"x-gitea-event": "push",
					...(signature && { "x-gitea-signature": signature }),
				}),
				response,
			);
			expect(response.status).toHaveBeenCalledWith(401);
		}
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("refuses a signature made over the re-serialised body", async () => {
		const response = createResponse();
		await handler(
			streamRequest(giteaRaw, {
				"x-gitea-event": "push",
				"x-gitea-signature": sign(
					"gitea-hook-secret",
					JSON.stringify(giteaPayload),
				),
			}),
			response,
		);
		expect(response.status).toHaveBeenCalledWith(401);
	});

	it("parses form-encoded and rejects broken JSON bodies", async () => {
		const form = new URLSearchParams({ a: "1" }).toString();
		const formRequest = streamRequest(form, {
			"content-type": "application/x-www-form-urlencoded",
		});
		const formResponse = createResponse();
		await handler(formRequest, formResponse);
		expect(formRequest.body).toEqual({ a: "1" });

		const response = createResponse();
		await handler(streamRequest("{nope", {}), response);
		expect(response.status).toHaveBeenCalledWith(400);
	});

	it("says why a push without a provider header does not match a branch", async () => {
		dbMocks.findApplication.mockResolvedValue(
			createApplication({ sourceType: "git" }),
		);
		const response = createResponse();
		await handler(streamRequest(giteaRaw, {}), response);

		expect(response.status).toHaveBeenCalledWith(301);
		expect(response.json.mock.calls[0]?.[0].message).toMatch(
			/^Branch Not Match: the request has no Git provider event header/,
		);
		expect(queueMocks.add).not.toHaveBeenCalled();
	});

	it("checks GitLab's token against the webhook secret, falling back to the OAuth secret", async () => {
		for (const [gitlab, token, status] of [
			[{ webhookSecret: "hook", secret: "oauth" }, "hook", 200],
			[{ webhookSecret: "hook", secret: "oauth" }, "oauth", 401],
			[{ webhookSecret: null, secret: "oauth" }, "oauth", 200],
		] as const) {
			dbMocks.findApplication.mockResolvedValue(
				createApplication({
					gitea: null,
					gitlab,
					sourceType: "gitlab",
					gitlabBranch: "main",
				}),
			);
			const response = createResponse();
			await handler(
				streamRequest(giteaRaw, {
					"x-gitlab-event": "Push Hook",
					"x-gitlab-token": token,
				}),
				response,
			);
			if (status === 401) {
				expect(response.status).toHaveBeenCalledWith(401);
			} else {
				expect(response.status).not.toHaveBeenCalledWith(401);
			}
		}
	});
});
