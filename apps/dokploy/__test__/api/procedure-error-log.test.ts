import { buildKnownSecretMatcher } from "@dokploy/server/utils/security/secret-scrub";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	describeProcedureFailure,
	isUnexpectedFailure,
	logProcedureFailure,
	resetProcedureFailureLog,
} from "@/server/api/utils/procedure-error-log";

const SECRET = "Zx9-sentinel-Value42";

const mocks = vi.hoisted(() => ({
	getKnownSecretMatcher: vi.fn(),
}));

vi.mock("@dokploy/server/services/known-secrets", () => ({
	getKnownSecretMatcher: mocks.getKnownSecretMatcher,
	resetKnownSecretMatcherCache: () => {},
}));

const matcher = buildKnownSecretMatcher([SECRET]);

const wrapped = (cause: unknown) =>
	new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "boom", cause });

const failure = (error: unknown) => ({
	source: "openapi" as const,
	path: "settings.getIp",
	type: "query",
	error,
});

describe("procedure failure description", () => {
	it("names the procedure and walks the chain of causes down to the stack", () => {
		const root = Object.assign(new Error("write CONNECTION_ENDED"), {
			code: "CONNECTION_ENDED",
		});
		const query = new Error("Failed query: select 1", { cause: root });
		query.name = "DrizzleQueryError";

		const text = describeProcedureFailure(failure(wrapped(query)), matcher);

		const lines = text.split("\n");
		expect(lines[0]).toBe("[api] openapi settings.getIp (query) failed");
		expect(lines[1]).toBe("  TRPCError INTERNAL_SERVER_ERROR: boom");
		expect(lines[2]).toBe(
			"  caused by DrizzleQueryError: Failed query: select 1",
		);
		expect(lines[3]).toBe(
			"  caused by Error CONNECTION_ENDED: write CONNECTION_ENDED",
		);
		expect(lines[4]).toMatch(/^ {4}at /);
		expect(lines.length).toBeLessThanOrEqual(4 + 6);
	});

	it("drops the bound values of a failed query", () => {
		const query = new Error(
			'Failed query: update "application" set "env" = $1\nparams: TOKEN=brand-new-value-1234',
		);

		const text = describeProcedureFailure(failure(wrapped(query)), matcher);

		expect(text).toContain('update "application" set "env" = $1');
		expect(text).not.toContain("brand-new-value-1234");
		expect(text).not.toContain("params");
	});

	it("hides a known secret and a credential-looking setting in a message", () => {
		const error = new Error(
			`ssh failed for ${SECRET} with DATABASE_PASSWORD=hunter2hunter2`,
		);

		const text = describeProcedureFailure(failure(wrapped(error)), matcher);

		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("hunter2hunter2");
		expect(text).toContain("ssh failed for");
	});

	it("prints no message text at all when the secret list is unavailable", () => {
		const error = Object.assign(new Error(`leaks ${SECRET}`), {
			code: "ECONNRESET",
		});

		const text = describeProcedureFailure(failure(wrapped(error)), null);

		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("leaks");
		expect(text).toContain("caused by Error ECONNRESET: (message withheld");
		expect(text).toMatch(/\n {4}at /);
	});

	it("keeps a long message to one short line", () => {
		const error = new Error(`first\nsecond ${"x ".repeat(400)}`);

		const text = describeProcedureFailure(failure(error), matcher);

		const line = text.split("\n")[1] ?? "";
		expect(line.startsWith("  Error: first second x x")).toBe(true);
		expect(line.length).toBeLessThan(330);
	});

	it("ignores a code that is not a short plain word", () => {
		const error = Object.assign(new Error("nope"), {
			code: `has spaces ${SECRET}`,
		});

		expect(describeProcedureFailure(failure(error), matcher)).toContain(
			"  Error: nope",
		);
	});

	it("survives a cause that points back at itself and a thrown non-error", () => {
		const loop = new Error("loop");
		loop.cause = loop;

		expect(describeProcedureFailure(failure(loop), matcher)).toContain(
			"  Error: loop",
		);
		expect(describeProcedureFailure(failure("text"), matcher)).toContain(
			"a non-error value was thrown (string)",
		);
	});
});

describe("procedure failure log", () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});

	beforeEach(() => {
		error.mockClear();
		resetProcedureFailureLog();
		mocks.getKnownSecretMatcher.mockResolvedValue(matcher);
	});

	afterEach(() => {
		mocks.getKnownSecretMatcher.mockReset();
	});

	it("treats only a 500 as unexpected", () => {
		expect(isUnexpectedFailure(new Error("plain"))).toBe(true);
		expect(isUnexpectedFailure(wrapped(new Error("x")))).toBe(true);
		expect(isUnexpectedFailure(new TRPCError({ code: "UNAUTHORIZED" }))).toBe(
			false,
		);
		expect(isUnexpectedFailure(new TRPCError({ code: "BAD_REQUEST" }))).toBe(
			false,
		);
	});

	it("writes a 500 and stays silent about a 4xx", async () => {
		await logProcedureFailure(failure(new TRPCError({ code: "FORBIDDEN" })));
		expect(error).not.toHaveBeenCalled();

		await logProcedureFailure(failure(wrapped(new Error("db down"))));
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[0]).toContain("caused by Error: db down");
	});

	it("still writes names and the stack when the secret list cannot be loaded", async () => {
		mocks.getKnownSecretMatcher.mockRejectedValue(new Error("no database"));

		await logProcedureFailure(failure(wrapped(new Error(`has ${SECRET}`))));

		const text = String(error.mock.calls[0]?.[0]);
		expect(text).toContain("[api] openapi settings.getIp (query) failed");
		expect(text).toContain("(message withheld");
		expect(text).not.toContain(SECRET);
	});

	it("counts repeats inside the window instead of printing them", async () => {
		const start = 1_000_000;
		await logProcedureFailure(failure(wrapped(new Error("down"))), start);
		await logProcedureFailure(failure(wrapped(new Error("down"))), start + 5);
		await logProcedureFailure(failure(wrapped(new Error("down"))), start + 9);
		expect(error).toHaveBeenCalledTimes(1);

		await logProcedureFailure(
			failure(wrapped(new Error("down"))),
			start + 31_000,
		);
		expect(error).toHaveBeenCalledTimes(2);
		expect(error.mock.calls[1]?.[0]).toContain(
			"(2 more of the same were not printed)",
		);
	});

	it("does not let one procedure silence another", async () => {
		await logProcedureFailure(failure(wrapped(new Error("down"))), 1);
		await logProcedureFailure(
			{ ...failure(wrapped(new Error("down"))), path: "overview.domains" },
			2,
		);

		expect(error).toHaveBeenCalledTimes(2);
	});
});
