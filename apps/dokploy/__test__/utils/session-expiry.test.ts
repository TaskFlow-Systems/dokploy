import {
	createTRPCUntypedClient,
	TRPCClientError,
	type TRPCLink,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { describe, expect, it, vi } from "vitest";
import type { AppRouter } from "@/server/api/root";
import {
	createNoSessionLink,
	isNoSessionError,
	isPublicPath,
	retryUnlessNoSession,
} from "@/utils/session-expiry";

const serverError = (
	code: string,
	httpStatus: number,
	noSession: boolean,
): TRPCClientError<AppRouter> =>
	TRPCClientError.from({
		error: {
			message: code,
			code: -32001,
			data: { code, httpStatus, path: "application.one", noSession },
		},
	} as never);

const noSession = serverError("UNAUTHORIZED", 401, true);
const notAllowed = serverError("UNAUTHORIZED", 401, false);
const serverFailure = serverError("INTERNAL_SERVER_ERROR", 500, false);
const networkFailure = TRPCClientError.from<AppRouter>(
	new TypeError("fetch failed"),
);

describe("isNoSessionError", () => {
	it("recognises only the answer the server marked", () => {
		expect(isNoSessionError(noSession)).toBe(true);
		expect(isNoSessionError(notAllowed)).toBe(false);
		expect(isNoSessionError(serverFailure)).toBe(false);
		expect(isNoSessionError(networkFailure)).toBe(false);
	});

	it("ignores anything that is not a tRPC error", () => {
		expect(isNoSessionError(null)).toBe(false);
		expect(isNoSessionError(undefined)).toBe(false);
		expect(isNoSessionError("UNAUTHORIZED")).toBe(false);
		expect(isNoSessionError(new Error("noSession"))).toBe(false);
		expect(isNoSessionError({ data: { noSession: "true" } })).toBe(false);
	});
});

describe("retryUnlessNoSession", () => {
	it("never retries a request that had no session", () => {
		expect(retryUnlessNoSession(0, noSession)).toBe(false);
	});

	it.each([
		["a refusal for the signed-in role", notAllowed],
		["a server failure", serverFailure],
		["a network failure", networkFailure],
	])("keeps the usual three retries for %s", (_name, error) => {
		expect(retryUnlessNoSession(0, error)).toBe(true);
		expect(retryUnlessNoSession(1, error)).toBe(true);
		expect(retryUnlessNoSession(2, error)).toBe(true);
		expect(retryUnlessNoSession(3, error)).toBe(false);
	});
});

describe("isPublicPath", () => {
	it.each([
		"/",
		"/register",
		"/invitation",
		"/reset-password",
		"/send-reset-password",
		"/accept-invitation/abc123",
		"/super-password/lock",
		"/register/",
	])("treats %s as a page that needs no session", (path) => {
		expect(isPublicPath(path)).toBe(true);
	});

	it.each([
		"/dashboard/home",
		"/dashboard/project/p1/environment/e1/services/application/a1",
		"/dashboard/settings/profile",
		"/swagger",
		"/registered",
		"/invitations",
		"/super-passwords",
	])("treats %s as a page that needs one", (path) => {
		expect(isPublicPath(path)).toBe(false);
	});
});

const setup = (
	pathname: string,
	answer: (op: number) => TRPCClientError<AppRouter> | "ok",
) => {
	const redirect = vi.fn();
	let requests = 0;
	const server: TRPCLink<AppRouter> = () => () =>
		observable((observer) => {
			const result = answer(requests++);
			queueMicrotask(() => {
				if (result === "ok") {
					observer.next({ result: { type: "data", data: "ok" } });
					observer.complete();
				} else {
					observer.error(result);
				}
			});
		});
	const client = createTRPCUntypedClient<AppRouter>({
		links: [
			createNoSessionLink({ getPathname: () => pathname, redirect }),
			server,
		],
	});
	return {
		redirect,
		requests: () => requests,
		call: () => client.query("application.one", { applicationId: "a1" }),
	};
};

describe("the no-session link", () => {
	it("sends the browser to the login page when the session has ended", async () => {
		const { call, redirect } = setup("/dashboard/home", () => noSession);

		await expect(call()).rejects.toBe(noSession);

		expect(redirect).toHaveBeenCalledTimes(1);
		expect(redirect).toHaveBeenCalledWith("/");
	});

	it("redirects once when ten requests fail together", async () => {
		const { call, redirect, requests } = setup(
			"/dashboard/home",
			() => noSession,
		);

		const settled = await Promise.allSettled(
			Array.from({ length: 10 }, () => call()),
		);

		expect(requests()).toBe(10);
		expect(settled.every(({ status }) => status === "rejected")).toBe(true);
		expect(redirect).toHaveBeenCalledTimes(1);
	});

	it("answers later requests itself instead of asking the server again", async () => {
		const { call, requests } = setup("/dashboard/home", () => noSession);

		await expect(call()).rejects.toBe(noSession);
		await expect(call()).rejects.toBe(noSession);
		await expect(call()).rejects.toBe(noSession);

		expect(requests()).toBe(1);
	});

	it.each([
		["a refusal for the signed-in role", notAllowed],
		["a server failure", serverFailure],
		["a network failure", networkFailure],
	])("leaves %s alone", async (_name, error) => {
		const { call, redirect, requests } = setup("/dashboard/home", () => error);

		await expect(call()).rejects.toBe(error);
		await expect(call()).rejects.toBe(error);

		expect(redirect).not.toHaveBeenCalled();
		expect(requests()).toBe(2);
	});

	it("passes successful answers through", async () => {
		const { call, redirect } = setup("/dashboard/home", () => "ok");

		await expect(call()).resolves.toBe("ok");

		expect(redirect).not.toHaveBeenCalled();
	});

	it("keeps asking after a refusal, so a later success still arrives", async () => {
		const { call, redirect } = setup("/dashboard/home", (op) =>
			op === 0 ? notAllowed : "ok",
		);

		await expect(call()).rejects.toBe(notAllowed);
		await expect(call()).resolves.toBe("ok");

		expect(redirect).not.toHaveBeenCalled();
	});

	it.each(["/", "/register", "/invitation", "/reset-password"])(
		"does not redirect from the public page %s",
		async (path) => {
			const { call, redirect, requests } = setup(path, () => noSession);

			await expect(call()).rejects.toBe(noSession);
			await expect(call()).rejects.toBe(noSession);

			expect(redirect).not.toHaveBeenCalled();
			expect(requests()).toBe(2);
		},
	);
});
