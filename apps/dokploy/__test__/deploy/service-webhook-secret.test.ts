import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	findApplication: vi.fn(),
	findCompose: vi.fn(),
}));
const queueMocks = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("@dokploy/server", () => ({
	getBitbucketHeaders: vi.fn(() => ({})),
	IS_CLOUD: false,
	shouldDeploy: vi.fn(() => true),
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findFirst: dbMocks.findApplication },
			compose: { findFirst: dbMocks.findCompose },
		},
	},
}));
vi.mock("drizzle-orm", () => ({
	eq: vi.fn((left, right) => ({ left, right })),
}));
vi.mock("@/server/db/schema", () => ({
	applications: { refreshToken: "application.refreshToken" },
	compose: { refreshToken: "compose.refreshToken" },
}));
vi.mock("@/server/queues/queueSetup", () => ({ myQueue: queueMocks }));
vi.mock("@/server/utils/deploy", () => ({ deploy: vi.fn() }));

const { default: applicationHandler, extractBranchName } = await import(
	"../../pages/api/deploy/[refreshToken]"
);
const { default: composeHandler } = await import(
	"../../pages/api/deploy/compose/[refreshToken]"
);

const SECRET = "service-hook-secret";

const createResponse = () => {
	const response = { json: vi.fn(), setHeader: vi.fn(), status: vi.fn() };
	response.status.mockReturnValue(response);
	return response as unknown as NextApiResponse & {
		json: ReturnType<typeof vi.fn>;
		status: ReturnType<typeof vi.fn>;
	};
};

const streamRequest = (raw: string, headers: Record<string, string>) => {
	const buffer = Buffer.from(raw);
	const chunks: Buffer[] = [];
	for (let at = 0; at < buffer.length; at += 5) {
		chunks.push(buffer.subarray(at, at + 5));
	}
	const request = Readable.from(chunks) as unknown as NextApiRequest;
	Object.assign(request, {
		method: "POST",
		query: { refreshToken: "token" },
		headers: { "content-type": "application/json", ...headers },
		body: undefined,
	});
	return request;
};

const hmac = (raw: string, secret = SECRET) =>
	createHmac("sha256", secret).update(raw).digest("hex");

// Bodies in each sender's own shape; the raw text has a trailing newline and
// non-canonical spacing, as Go and Java senders produce, so only the raw bytes
// verify.
const bitbucketCloud = (branch: string | null) =>
	`${JSON.stringify(
		{
			push: {
				changes: [
					{
						new: branch
							? { type: "branch", name: branch, target: { hash: "h1", message: "m" } }
							: null,
						old: { type: "branch", name: "main" },
					},
				],
			},
		},
		null,
		4,
	)}\n`;
const bitbucketDataCenter = (branch: string) =>
	JSON.stringify(
		{
			eventKey: "repo:refs_changed",
			changes: [
				{
					ref: { id: `refs/heads/${branch}`, displayId: branch, type: "BRANCH" },
					type: "UPDATE",
					toHash: "h2",
				},
			],
		},
		null,
		2,
	);
const pushBody = (branch: string) =>
	`${JSON.stringify({ ref: `refs/heads/${branch}`, after: "h3", commits: [{ id: "h3", message: "<b>" }] }, null, 2).replace(/[<>]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;

type Format = {
	name: string;
	body: (branch: string) => string;
	headers: (raw: string, secret?: string) => Record<string, string>;
};

const formats: Format[] = [
	{
		name: "Bitbucket Cloud",
		body: bitbucketCloud,
		headers: (raw, secret = SECRET) => ({
			"x-event-key": "repo:push",
			"x-hub-signature": `sha256=${hmac(raw, secret)}`,
		}),
	},
	{
		name: "Bitbucket Data Center",
		body: bitbucketDataCenter,
		headers: (raw, secret = SECRET) => ({
			"x-event-key": "repo:refs_changed",
			"x-hub-signature": `sha256=${hmac(raw, secret)}`,
		}),
	},
	{
		name: "Soft Serve",
		body: pushBody,
		headers: (raw, secret = SECRET) => ({
			"x-softserve-event": "push",
			"x-softserve-signature": `sha256=${hmac(raw, secret)}`,
		}),
	},
	{
		name: "GitHub-style",
		body: pushBody,
		headers: (raw, secret = SECRET) => ({
			"x-github-event": "push",
			"x-hub-signature-256": `sha256=${hmac(raw, secret)}`,
		}),
	},
	{
		name: "GitLab-style",
		body: pushBody,
		headers: (_raw, secret = SECRET) => ({
			"x-gitlab-event": "Push Hook",
			"x-gitlab-token": secret,
		}),
	},
	{
		name: "Gitea-style",
		body: pushBody,
		headers: (raw, secret = SECRET) => ({
			"x-gitea-event": "push",
			"x-gitea-signature": hmac(raw, secret),
		}),
	},
	{
		name: "Gitea-style (GitHub-compatible header only)",
		body: pushBody,
		headers: (raw, secret = SECRET) => ({
			"x-gitea-event": "push",
			"x-github-event": "push",
			"x-hub-signature-256": `sha256=${hmac(raw, secret)}`,
		}),
	},
];

const targets = [
	{
		name: "application",
		handler: applicationHandler,
		mock: dbMocks.findApplication,
		service: (overrides: Record<string, unknown>) => ({
			applicationId: "a1",
			autoDeploy: true,
			bitbucket: null,
			github: null,
			gitlab: null,
			gitea: null,
			serverId: null,
			sourceType: "git",
			customGitBranch: "main",
			bitbucketBranch: "main",
			watchPaths: null,
			webhookSecret: SECRET,
			...overrides,
		}),
	},
	{
		name: "compose",
		handler: composeHandler,
		mock: dbMocks.findCompose,
		service: (overrides: Record<string, unknown>) => ({
			composeId: "c1",
			autoDeploy: true,
			bitbucket: null,
			github: null,
			gitlab: null,
			gitea: null,
			serverId: null,
			sourceType: "git",
			customGitBranch: "main",
			bitbucketBranch: "main",
			watchPaths: null,
			webhookSecret: SECRET,
			...overrides,
		}),
	},
];

describe.each(targets)("per-service deploy webhook secret ($name)", (target) => {
	beforeEach(() => {
		vi.clearAllMocks();
		queueMocks.add.mockResolvedValue(undefined);
		target.mock.mockResolvedValue(target.service({}));
	});

	describe.each(formats)("$name on Custom Git", (format) => {
		const send = async (raw: string, headers: Record<string, string>) => {
			const response = createResponse();
			await target.handler(streamRequest(raw, headers), response);
			return response;
		};

		it("deploys a correctly signed push to the tracked branch", async () => {
			const raw = format.body("main");
			const response = await send(raw, format.headers(raw));
			expect(response.status).toHaveBeenCalledWith(200);
			expect(queueMocks.add).toHaveBeenCalledTimes(1);
		});

		it("answers 301 for another branch, signed", async () => {
			const raw = format.body("feature");
			const response = await send(raw, format.headers(raw));
			expect(response.status).toHaveBeenCalledWith(301);
			expect(queueMocks.add).not.toHaveBeenCalled();
		});

		it("refuses a wrong signature with 401", async () => {
			const raw = format.body("main");
			const response = await send(raw, format.headers(raw, "other-secret"));
			expect(response.status).toHaveBeenCalledWith(401);
			expect(queueMocks.add).not.toHaveBeenCalled();
		});

		it("refuses a body changed after signing", async () => {
			const raw = format.body("main");
			const headers = format.headers(raw);
			const response = await send(
				format.name === "GitLab-style" ? raw : raw.replace("main", "feature"),
				format.name === "GitLab-style" ? { ...headers, "x-gitlab-token": "x" } : headers,
			);
			expect(response.status).toHaveBeenCalledWith(401);
		});

		it("refuses an unsigned request with 401", async () => {
			const raw = format.body("main");
			const headers = format.headers(raw);
			for (const key of Object.keys(headers)) {
				if (/signature|token/.test(key)) delete headers[key];
			}
			const response = await send(raw, headers);
			expect(response.status).toHaveBeenCalledWith(401);
			expect(queueMocks.add).not.toHaveBeenCalled();
		});

		it("keeps refusing with 401 while the service has no secret", async () => {
			target.mock.mockResolvedValue(target.service({ webhookSecret: null }));
			const raw = format.body("main");
			const response = await send(raw, format.headers(raw));
			expect(response.status).toHaveBeenCalledWith(401);
			expect(queueMocks.add).not.toHaveBeenCalled();
		});
	});

	it("does not accept another format's proof for the header it carries", async () => {
		const raw = pushBody("main");
		const response = createResponse();
		// GitLab event, but only a GitHub-style signature
		await target.handler(
			streamRequest(raw, {
				"x-gitlab-event": "Push Hook",
				"x-hub-signature-256": `sha256=${hmac(raw)}`,
			}),
			response,
		);
		expect(response.status).toHaveBeenCalledWith(401);
	});

	it("checks a Bitbucket source with the service secret too", async () => {
		target.mock.mockResolvedValue(target.service({ sourceType: "bitbucket" }));
		const raw = bitbucketCloud("main");
		const ok = createResponse();
		await target.handler(streamRequest(raw, formats[0].headers(raw)), ok);
		expect(ok.status).not.toHaveBeenCalledWith(401);
		const bad = createResponse();
		await target.handler(
			streamRequest(raw, formats[0].headers(raw, "nope")),
			bad,
		);
		expect(bad.status).toHaveBeenCalledWith(401);
	});

	it("leaves provider-backed GitHub sources on their provider secret", async () => {
		target.mock.mockResolvedValue(
			target.service({ sourceType: "github", github: null }),
		);
		const raw = pushBody("main");
		const response = createResponse();
		await target.handler(
			streamRequest(raw, {
				"x-github-event": "push",
				"x-hub-signature-256": `sha256=${hmac(raw)}`,
			}),
			response,
		);
		// the service secret is not a GitHub App secret
		expect(response.status).toHaveBeenCalledWith(401);
	});
});

describe("branch extraction", () => {
	it("reads Bitbucket Cloud, Data Center and Soft Serve pushes", () => {
		expect(
			extractBranchName(
				{ "x-event-key": "repo:push" },
				JSON.parse(bitbucketCloud("dev")),
			),
		).toBe("dev");
		expect(
			extractBranchName(
				{ "x-event-key": "repo:refs_changed" },
				JSON.parse(bitbucketDataCenter("dev")),
			),
		).toBe("dev");
		expect(
			extractBranchName(
				{ "x-softserve-event": "push" },
				JSON.parse(pushBody("dev")),
			),
		).toBe("dev");
	});

	it("gives no branch for a Bitbucket branch deletion, tag or empty body", () => {
		expect(
			extractBranchName(
				{ "x-event-key": "repo:push" },
				JSON.parse(bitbucketCloud(null)),
			),
		).toBeNull();
		expect(
			extractBranchName(
				{ "x-event-key": "repo:push" },
				{ push: { changes: [{ new: { type: "tag", name: "v1" } }] } },
			),
		).toBeNull();
		expect(extractBranchName({ "x-event-key": "repo:push" }, {})).toBeNull();
		expect(
			extractBranchName(
				{ "x-event-key": "repo:refs_changed" },
				{ changes: [{ ref: { displayId: "x", type: "BRANCH" }, type: "DELETE" }] },
			),
		).toBeNull();
	});
});
