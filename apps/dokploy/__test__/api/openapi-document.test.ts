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

	it("serves blind env management at GET /env.keys, GET /env.layout and POST /env.apply", () => {
		const paths = generate().paths ?? {};
		const keys = paths["/env.keys"]?.get as
			| { operationId?: string; parameters?: { name: string; in: string }[] }
			| undefined;
		const layout = paths["/env.layout"]?.get as
			| { operationId?: string; parameters?: { name: string; in: string }[] }
			| undefined;
		const apply = paths["/env.apply"]?.post as
			| { operationId?: string; requestBody?: unknown }
			| undefined;

		expect(
			Object.keys(paths).filter((path) => path.startsWith("/env.")),
		).toEqual(["/env.keys", "/env.layout", "/env.apply"]);
		expect(Object.keys(paths["/env.keys"] ?? {})).toEqual(["get"]);
		expect(Object.keys(paths["/env.layout"] ?? {})).toEqual(["get"]);
		expect(Object.keys(paths["/env.apply"] ?? {})).toEqual(["post"]);
		expect(keys?.operationId).toBe("env-keys");
		expect(keys?.parameters).toEqual([
			expect.objectContaining({ name: "scope", in: "query", required: true }),
			expect.objectContaining({ name: "id", in: "query", required: true }),
			expect.objectContaining({ name: "field", in: "query" }),
		]);
		expect(layout?.operationId).toBe("env-layout");
		expect(layout?.parameters?.map(({ name }) => name)).toEqual([
			"scope",
			"id",
			"field",
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
			"layout",
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
		const layout = responseSchema(paths["/env.layout"]?.get);
		const apply = responseSchema(paths["/env.apply"]?.post);
		const layoutItems = (schema: unknown) =>
			(
				schema as {
					properties: {
						layout: {
							items: {
								oneOf: {
									properties: object;
									additionalProperties: boolean;
								}[];
							};
						};
					};
				}
			).properties.layout.items.oneOf;

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
			"layout",
		]);
		expect(Object.keys(layout.properties)).toEqual([
			"scope",
			"id",
			"field",
			"revision",
			"variables",
			"layout",
		]);
		for (const items of [layoutItems(layout), layoutItems(apply)]) {
			expect(items.map(({ properties }) => Object.keys(properties))).toEqual([
				["type", "name"],
				["type", "ref", "text"],
				["type", "ref", "kind", "variable"],
				["type"],
			]);
			for (const item of items) {
				expect(item.additionalProperties).toBe(false);
			}
		}
		expect(Object.keys(apply.properties.variables.items.properties)).toEqual([
			"name",
			"action",
			"source",
			"secret",
		]);
		for (const schema of [keys, layout, apply]) {
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
