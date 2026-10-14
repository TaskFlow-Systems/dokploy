import { REDACTED_SECRET_VALUE as R } from "@dokploy/server/utils/security/redaction";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const SENTINEL = "Zx9-sentinel-Value42";

const mocks = vi.hoisted(() => ({
	getKnownSecretMatcher: vi.fn(),
	resetKnownSecretMatcherCache: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/services/known-secrets", () => ({
	getKnownSecretMatcher: mocks.getKnownSecretMatcher,
	resetKnownSecretMatcherCache: mocks.resetKnownSecretMatcherCache,
}));

vi.mock("@dokploy/server/services/super-password", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/super-password")
	>()),
	checkSuperSessionAccess: vi.fn(async () => null),
}));

const { buildKnownSecretMatcher } = await import(
	"@dokploy/server/utils/security/secret-scrub"
);
const { createTRPCRouter, protectedProcedure } = await import(
	"@/server/api/trpc"
);
const { isProcedureDeniedForApiKey } = await import(
	"@/server/api/utils/api-key-output-guard"
);
const { PROCEDURE_ACCESS } = await import(
	"@/server/api/utils/procedure-access"
);

const handled = vi.fn();

const service = {
	applicationId: "app-1",
	name: "api",
	env: `API_TOKEN=${SENTINEL}`,
	environment: { name: "production", env: `SHARED=${SENTINEL}` },
};

const secretReader = protectedProcedure.mutation(() => {
	handled();
	return { env: SENTINEL };
});

const storedCompose = [
	"services:",
	"  api:",
	"    image: api:1",
	"    environment:",
	`      FAVOURITE_COLOUR: ${SENTINEL}`,
	"      NEUTRAL_NAME: plain-neutral-value",
	"",
].join("\n");
const storedMount = `user=app\npassword=${SENTINEL}\nport=8080\n`;
const saved = vi.fn();

const { restoreApiKeyText } = await import(
	"@/server/api/utils/api-key-output-guard"
);

const testRouter = createTRPCRouter({
	compose: createTRPCRouter({
		loadComposeVariables: secretReader,
		one: protectedProcedure.query(() => ({
			composeId: "compose-1",
			composeFile: storedCompose,
		})),
		getConvertedCompose: protectedProcedure.query(() => storedCompose),
		update: protectedProcedure
			.input(
				z.object({
					composeFile: z.string(),
					description: z.string().optional(),
				}),
			)
			.mutation(async ({ input, ctx }) => {
				saved(
					await restoreApiKeyText(
						ctx.session,
						"compose",
						input.composeFile,
						storedCompose,
					),
				);
				return true;
			}),
	}),
	mounts: createTRPCRouter({
		one: protectedProcedure.query(() => ({
			mountId: "m-1",
			content: storedMount,
		})),
		update: protectedProcedure
			.input(z.object({ content: z.string() }))
			.mutation(async ({ input, ctx }) => {
				saved(
					await restoreApiKeyText(
						ctx.session,
						"file",
						input.content,
						storedMount,
					),
				);
				return true;
			}),
	}),
	application: createTRPCRouter({
		one: protectedProcedure.query(() => service),
		readLogs: protectedProcedure.query(
			() => `boot ok\nusing token ${SENTINEL}\nDB_PASS=hunter2-hunter2`,
		),
		update: protectedProcedure
			.input(z.object({ command: z.string(), env: z.string().optional() }))
			.mutation(({ input }) => {
				handled(input);
				return true;
			}),
		fail: protectedProcedure.query(() => {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: `docker login failed for ${SENTINEL}`,
			});
		}),
		deployWithLogs: protectedProcedure.subscription(async function* () {
			yield `pulling with ${SENTINEL}`;
			yield "done";
		}),
		revision: protectedProcedure.query(() => ({
			revision: "env:Abc123-revision",
			expectedRevision: "env:Abc123-revision",
		})),
		revealEnvironment: secretReader,
	}),
	postgres: createTRPCRouter({ revealEnvironment: secretReader }),
	docker: createTRPCRouter({
		getConfig: secretReader,
		readContainerFile: secretReader,
	}),
	dockerVolume: createTRPCRouter({ readVolumeFile: secretReader }),
	settings: createTRPCRouter({
		readTraefikEnv: secretReader,
		getOpenApiDocument: protectedProcedure.query(() => ({
			properties: { password: { type: "string" }, env: { type: "string" } },
		})),
	}),
	user: createTRPCRouter({ revealApiKey: secretReader }),
});

const owner = {
	id: "user-1",
	email: "owner@example.test",
	role: "owner" as const,
	ownerId: "user-1",
};

const callerFor = (authMethod: "session" | "api-key") =>
	testRouter.createCaller({
		db: {},
		req: { headers: {} },
		res: {},
		user: owner,
		session: {
			id: "session-1",
			userId: owner.id,
			activeOrganizationId: "org-1",
			authMethod,
		},
	} as never);

const apiKey = () => callerFor("api-key");
const browser = () => callerFor("session");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getKnownSecretMatcher.mockResolvedValue(
		buildKnownSecretMatcher([SENTINEL]),
	);
});

describe("API key responses", () => {
	it("never carry secret fields, even for the owner", async () => {
		const result = await apiKey().application.one();

		expect(result).toEqual({
			applicationId: "app-1",
			name: "api",
			env: R,
			environment: { name: "production", env: R },
		});
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
	});

	it("leave browser sessions untouched", async () => {
		await expect(browser().application.one()).resolves.toEqual(service);
		await expect(browser().application.readLogs()).resolves.toContain(SENTINEL);
		expect(mocks.getKnownSecretMatcher).not.toHaveBeenCalled();
	});

	it("scrub known values and credential-looking text out of logs", async () => {
		await expect(apiKey().application.readLogs()).resolves.toBe(
			`boot ok\nusing token ${R}\nDB_PASS=${R}`,
		);
	});

	it("scrub error messages", async () => {
		const error = await apiKey()
			.application.fail()
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
		expect((error as TRPCError).message).toBe(`docker login failed for ${R}`);
	});

	it("scrub every chunk of a subscription", async () => {
		const stream =
			(await apiKey().application.deployWithLogs()) as unknown as AsyncIterable<string>;
		const chunks: string[] = [];
		for await (const chunk of stream) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([`pulling with ${R}`, "done"]);
	});

	it("leave the OpenAPI document as it is", async () => {
		const document = await apiKey().settings.getOpenApiDocument();

		expect(document).toEqual({
			properties: { password: { type: "string" }, env: { type: "string" } },
		});
	});

	it("keep revisions intact", async () => {
		const matcher = buildKnownSecretMatcher(["env:Abc123-revision"]);
		mocks.getKnownSecretMatcher.mockResolvedValue(matcher);

		await expect(apiKey().application.revision()).resolves.toEqual({
			revision: "env:Abc123-revision",
			expectedRevision: "env:Abc123-revision",
		});
	});

	it("fail closed when the known secrets cannot be loaded", async () => {
		mocks.getKnownSecretMatcher.mockRejectedValue(new Error("db down"));

		await expect(apiKey().application.one()).rejects.toThrow();
	});
});

describe("procedures that return raw secrets", () => {
	it.each([
		[
			"application.revealEnvironment",
			() => apiKey().application.revealEnvironment(),
		],
		["postgres.revealEnvironment", () => apiKey().postgres.revealEnvironment()],
		[
			"compose.loadComposeVariables",
			() => apiKey().compose.loadComposeVariables(),
		],
		["docker.getConfig", () => apiKey().docker.getConfig()],
		["docker.readContainerFile", () => apiKey().docker.readContainerFile()],
		[
			"dockerVolume.readVolumeFile",
			() => apiKey().dockerVolume.readVolumeFile(),
		],
		["settings.readTraefikEnv", () => apiKey().settings.readTraefikEnv()],
		["user.revealApiKey", () => apiKey().user.revealApiKey()],
	])("%s is refused before it runs", async (_path, call) => {
		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(handled).not.toHaveBeenCalled();
	});

	it("stay available to browser sessions", async () => {
		await expect(browser().application.revealEnvironment()).resolves.toEqual({
			env: SENTINEL,
		});
	});

	it("cover every reveal procedure of the app router", () => {
		const reveals = Object.keys(PROCEDURE_ACCESS).filter((path) =>
			/reveal/i.test(path),
		);

		expect(reveals.length).toBeGreaterThan(0);
		for (const path of reveals) {
			expect(isProcedureDeniedForApiKey(path), path).toBe(true);
		}
	});
});

describe("texts an API key may edit", () => {
	const TOKEN = /__DOKPLOY_REDACTED_SECRET__[A-Z2-7]{12}__/g;

	it("shows a compose file with every literal value behind a token", async () => {
		const { composeFile } = await apiKey().compose.one();
		const converted = await apiKey().compose.getConvertedCompose();

		for (const text of [composeFile, converted]) {
			expect(text).not.toContain(SENTINEL);
			expect(text).not.toContain("plain-neutral-value");
			expect(text).toContain("image: api:1");
			expect(text.match(TOKEN)).toHaveLength(2);
		}
	});

	it("puts the values back when the edited compose file is saved", async () => {
		const { composeFile } = await apiKey().compose.one();

		await apiKey().compose.update({
			composeFile: composeFile.replace("image: api:1", "image: api:2"),
		});

		expect(saved).toHaveBeenCalledTimes(1);
		const restored = saved.mock.calls[0]?.[0] as string;
		expect(restored).toContain("image: api:2");
		expect(restored).toContain(SENTINEL);
		expect(restored).toContain("plain-neutral-value");
		expect(restored.match(TOKEN)).toBeNull();
	});

	it("does the same for a mounted file", async () => {
		const { content } = await apiKey().mounts.one();
		expect(content).not.toContain(SENTINEL);

		await apiKey().mounts.update({
			content: content.replace("port=8080", "port=9090"),
		});

		expect(saved).toHaveBeenCalledWith(
			storedMount.replace("port=8080", "port=9090"),
		);
	});

	it("rejects a compose file whose hidden value was moved into view", async () => {
		const { composeFile } = await apiKey().compose.one();
		// The second value is unknown to the panel: only its place hides it.
		const token = composeFile.match(TOKEN)?.[1] as string;

		await expect(
			apiKey().compose.update({
				composeFile: composeFile.replace("image: api:1", `image: ${token}`),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(saved).not.toHaveBeenCalled();
	});

	it("rejects tokens outside the field that can restore them", async () => {
		const { composeFile } = await apiKey().compose.one();
		const token = composeFile.match(TOKEN)?.[0] as string;

		await expect(
			apiKey().compose.update({
				composeFile: "services: {}",
				description: token,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			apiKey().application.update({ command: `run ${token}` }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(saved).not.toHaveBeenCalled();
	});

	it("rejects placeholders that carry no token", async () => {
		await expect(
			apiKey().compose.update({
				composeFile: `services:\n  a:\n    image: ${R}\n`,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			apiKey().mounts.update({ content: "password=[REDACTED]" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("leaves what a browser session sends untouched", async () => {
		const text = `services:\n  a:\n    image: ${R}\n`;

		await browser().compose.update({ composeFile: text });

		expect(saved).toHaveBeenCalledWith(text);
	});
});

describe("known secrets cache", () => {
	it("is dropped after every mutation, from an API key or a browser", async () => {
		await apiKey().application.update({ command: "run" });
		await browser().application.update({ command: "run" });

		expect(mocks.resetKnownSecretMatcherCache).toHaveBeenCalledTimes(2);
	});

	it("is kept after a query", async () => {
		await apiKey().application.one();
		await browser().application.one();

		expect(mocks.resetKnownSecretMatcherCache).not.toHaveBeenCalled();
	});
});

describe("API key writes", () => {
	it("reject text that was scrubbed on the way out", async () => {
		await expect(
			apiKey().application.update({ command: `run --token=${R}` }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			apiKey().application.update({ command: "run --token=[REDACTED]" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			apiKey().application.update({ command: R }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			apiKey().application.update({ command: "run", env: `A=1\nB=${R}` }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(handled).not.toHaveBeenCalled();
	});

	it("accept a whole secret field sent back as the bare placeholder", async () => {
		await expect(
			apiKey().application.update({ command: "run", env: R }),
		).resolves.toBe(true);
		expect(handled).toHaveBeenCalledWith({ command: "run", env: R });
	});

	it("do not restrict browser sessions", async () => {
		await expect(
			browser().application.update({ command: `run --token=${R}` }),
		).resolves.toBe(true);
	});
});
