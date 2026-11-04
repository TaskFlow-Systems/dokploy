import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
	isApplicationEnvUpsertRequest,
	parseRequestUrl,
} from "../../server/request-url";
import { toCloseReason } from "../../server/wss/connection";

const request = (
	url: string | undefined,
	headers: IncomingMessage["headers"] = { host: "panel.example.com" },
) => ({ url, headers }) as IncomingMessage;

describe("parseRequestUrl", () => {
	it("reads the path from a normal request", () => {
		expect(parseRequestUrl(request("/terminal?serverId=1"))?.pathname).toBe(
			"/terminal",
		);
	});

	it("works without a Host header", () => {
		expect(parseRequestUrl(request("/terminal", {}))?.pathname).toBe(
			"/terminal",
		);
	});

	it.each([
		["a Host with a space", "/terminal", "a b"],
		["an empty Host", "/terminal", ""],
		["a bracket in the Host", "/terminal", "[::1"],
		["a target with no host", "//", "panel.example.com"],
	])("returns null for %s", (_name, url, host) => {
		expect(parseRequestUrl(request(url, { host }))).toBeNull();
	});
});

describe("isApplicationEnvUpsertRequest", () => {
	it.each(["/api/application/env/upsert", "/api/application.env.upsert"])(
		"matches %s",
		(url) => {
			expect(isApplicationEnvUpsertRequest(request(url))).toBe(true);
		},
	);

	it("matches through a forwarded path", () => {
		expect(
			isApplicationEnvUpsertRequest(
				request("/", {
					host: "panel.example.com",
					"x-forwarded-uri": "/api/application/env/upsert",
				}),
			),
		).toBe(true);
	});

	it("leaves other paths alone", () => {
		expect(isApplicationEnvUpsertRequest(request("/dashboard"))).toBe(false);
	});

	it("does not throw on a Host that cannot be parsed", () => {
		expect(
			isApplicationEnvUpsertRequest(request("/dashboard", { host: "a b" })),
		).toBe(false);
	});
});

describe("toCloseReason", () => {
	const bytes = (text: string) => Buffer.byteLength(text);

	it("keeps a short reason", () => {
		expect(toCloseReason("Container not running")).toBe(
			"Container not running",
		);
	});

	it("cuts a long reason to what a close frame can carry", () => {
		expect(toCloseReason("x".repeat(500))).toBe("x".repeat(123));
	});

	it.each(["я", "€", "😀"])("counts bytes, not characters, for %s", (char) => {
		const reason = toCloseReason(char.repeat(200));

		expect(bytes(reason)).toBeLessThanOrEqual(123);
		expect(reason.length).toBeGreaterThan(0);
	});
});
