import { dockerDiskUsageDetailLimitSchema } from "@dokploy/server";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";

const generate = () =>
	generateOpenApiDocument(appRouter, {
		title: "Dokploy API",
		version: "test",
		baseUrl: "http://localhost/api",
	});

describe("OpenAPI document", () => {
	// One procedure the generator can't describe throws for the whole router,
	// and /swagger then renders an empty spec instead of the API.
	it("generates for every procedure in the app router", () => {
		const document = generate();

		expect(document.openapi).toMatch(/^3\./);
		const getDiskUsage = document.paths?.["/dockerDiskUsage.getDiskUsage"]
			?.get as { parameters?: { name: string }[] } | undefined;
		expect(getDiskUsage?.parameters?.map(({ name }) => name)).toContain(
			"detailLimit",
		);
	});

	it("serves blind env management at GET /env.keys and POST /env.apply", () => {
		const paths = generate().paths ?? {};
		const keys = paths["/env.keys"]?.get as
			| { operationId?: string; parameters?: { name: string; in: string }[] }
			| undefined;
		const apply = paths["/env.apply"]?.post as
			| { operationId?: string; requestBody?: unknown }
			| undefined;

		expect(
			Object.keys(paths).filter((path) => path.startsWith("/env.")),
		).toEqual(["/env.keys", "/env.apply"]);
		expect(Object.keys(paths["/env.keys"] ?? {})).toEqual(["get"]);
		expect(Object.keys(paths["/env.apply"] ?? {})).toEqual(["post"]);
		expect(keys?.operationId).toBe("env-keys");
		expect(keys?.parameters).toEqual([
			expect.objectContaining({ name: "scope", in: "query", required: true }),
			expect.objectContaining({ name: "id", in: "query", required: true }),
			expect.objectContaining({ name: "field", in: "query" }),
		]);
		expect(apply?.operationId).toBe("env-apply");
		expect(
			Object.keys(
				(
					apply?.requestBody as {
						content: {
							"application/json": { schema: { properties: object } };
						};
					}
				).content["application/json"].schema.properties,
			),
		).toEqual([
			"scope",
			"id",
			"field",
			"set",
			"remove",
			"generate",
			"copy",
			"dryRun",
			"expectedRevision",
		]);
	});

	it("describes blind env responses without any value field", () => {
		const paths = generate().paths ?? {};
		const responseSchema = (operation: unknown) =>
			(
				operation as {
					responses: {
						200: {
							content: {
								"application/json": {
									schema: {
										additionalProperties: boolean;
										properties: {
											variables: {
												items: {
													additionalProperties: boolean;
													properties: object;
												};
											};
										};
									};
								};
							};
						};
					};
				}
			).responses[200].content["application/json"].schema;
		const keys = responseSchema(paths["/env.keys"]?.get);
		const apply = responseSchema(paths["/env.apply"]?.post);

		expect(Object.keys(keys.properties)).toEqual([
			"scope",
			"id",
			"field",
			"revision",
			"variables",
		]);
		expect(Object.keys(keys.properties.variables.items.properties)).toEqual([
			"name",
			"secret",
			"empty",
		]);
		expect(Object.keys(apply.properties)).toEqual([
			"scope",
			"id",
			"field",
			"changed",
			"revision",
			"dryRun",
			"variables",
		]);
		expect(Object.keys(apply.properties.variables.items.properties)).toEqual([
			"name",
			"action",
			"source",
			"secret",
		]);
		for (const schema of [keys, apply]) {
			expect(schema.additionalProperties).toBe(false);
			expect(schema.properties.variables.items.additionalProperties).toBe(
				false,
			);
		}
	});
});

describe("dockerDiskUsageDetailLimitSchema", () => {
	it("accepts the allowed limits from tRPC and query strings", () => {
		expect(dockerDiskUsageDetailLimitSchema.parse(5)).toBe(5);
		expect(dockerDiskUsageDetailLimitSchema.parse("15")).toBe(15);
		expect(dockerDiskUsageDetailLimitSchema.parse(null)).toBeNull();
		expect(dockerDiskUsageDetailLimitSchema.parse(undefined)).toBeUndefined();
	});

	it("rejects other limits", () => {
		expect(() => dockerDiskUsageDetailLimitSchema.parse(7)).toThrow();
		expect(() => dockerDiskUsageDetailLimitSchema.parse("all")).toThrow();
	});
});
