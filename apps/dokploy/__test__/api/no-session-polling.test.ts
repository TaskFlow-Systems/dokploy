import {
	environmentManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppRouter } from "@/server/api/root";
import {
	createNoSessionLink,
	retryUnlessNoSession,
} from "@/utils/session-expiry";

const mocks = vi.hoisted(() => ({ validateRequest: vi.fn() }));

vi.mock("@dokploy/server/lib/auth", async (importOriginal) => ({
	...(await importOriginal<object>()),
	validateRequest: mocks.validateRequest,
}));

vi.mock("@dokploy/server/services/known-secrets", () => ({
	getKnownSecretMatcher: async () => null,
	resetKnownSecretMatcherCache: () => {},
}));

const {
	createTRPCContext,
	createTRPCRouter,
	ownerProcedure,
	protectedProcedure,
} = await import("@/server/api/trpc");

const router = createTRPCRouter({
	application: createTRPCRouter({
		one: protectedProcedure
			.input(z.object({ applicationId: z.string() }))
			.query(() => "application"),
		owned: ownerProcedure.query(() => "owner only"),
	}),
});

const signedInAs = (role: "owner" | "member") => ({
	session: {
		id: "session-1",
		userId: "user-1",
		activeOrganizationId: "org-1",
		authMethod: "session",
	},
	user: { id: "user-1", email: "user-1@example.test", role, ownerId: "user-1" },
});

const POLL_MS = 5000;

const startPolling = (
	path: "application.one" | "application.owned",
	{
		pathname = "/dashboard/project/p1/environment/e1/services/application/a1",
		fetchFails = false,
		retry,
	}: { pathname?: string; fetchFails?: boolean; retry?: number } = {},
) => {
	const redirect = vi.fn();
	const requests = vi.fn();
	const client = createTRPCUntypedClient<AppRouter>({
		links: [
			createNoSessionLink({ getPathname: () => pathname, redirect }),
			httpBatchLink({
				url: "http://localhost/api/trpc",
				transformer: superjson,
				fetch: async (input, init) => {
					requests();
					if (fetchFails) {
						throw new TypeError("fetch failed");
					}
					return fetchRequestHandler({
						endpoint: "/api/trpc",
						req: new Request(input as string, init as RequestInit),
						router,
						createContext: () =>
							createTRPCContext({ req: { headers: {} }, res: {} } as never),
					});
				},
			}),
		],
	});
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: retryUnlessNoSession } },
	});
	const observer = new QueryObserver(queryClient, {
		queryKey: [path],
		queryFn: () => client.query(path, { applicationId: "a1" }),
		refetchInterval: POLL_MS,
		...(retry === undefined ? {} : { retry }),
	});
	const unsubscribe = observer.subscribe(() => {});
	return { redirect, requests, observer, stop: unsubscribe };
};

beforeEach(() => {
	vi.useFakeTimers();
	environmentManager.setIsServer(() => false);
});

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("a query polled with refetchInterval", () => {
	it("hits the server once and goes quiet when the session has ended", async () => {
		mocks.validateRequest.mockResolvedValue({ session: null, user: null });
		const { observer, redirect, requests, stop } =
			startPolling("application.one");

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

		expect(requests).toHaveBeenCalledTimes(1);
		expect(redirect).toHaveBeenCalledTimes(1);
		expect(redirect).toHaveBeenCalledWith("/");
		expect(observer.getCurrentResult().status).toBe("error");
		stop();
	});

	it("stays quiet when the query asks for its own retries", async () => {
		mocks.validateRequest.mockResolvedValue({ session: null, user: null });
		const { redirect, requests, stop } = startPolling("application.one", {
			retry: 2,
		});

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

		expect(requests).toHaveBeenCalledTimes(1);
		expect(redirect).toHaveBeenCalledTimes(1);
		stop();
	});

	it("keeps retrying and polling when a signed-in user is refused", async () => {
		mocks.validateRequest.mockResolvedValue(signedInAs("member"));
		const { redirect, requests, stop } = startPolling("application.owned");

		await vi.advanceTimersByTimeAsync(7_500);
		expect(requests).toHaveBeenCalledTimes(4);

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(requests.mock.calls.length).toBeGreaterThan(4);
		expect(redirect).not.toHaveBeenCalled();
		stop();
	});

	it("keeps retrying and polling when the network fails", async () => {
		const { redirect, requests, stop } = startPolling("application.one", {
			fetchFails: true,
		});

		await vi.advanceTimersByTimeAsync(7_500);
		expect(requests).toHaveBeenCalledTimes(4);

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(requests.mock.calls.length).toBeGreaterThan(4);
		expect(redirect).not.toHaveBeenCalled();
		stop();
	});

	it("keeps polling a signed-in session", async () => {
		mocks.validateRequest.mockResolvedValue(signedInAs("member"));
		const { observer, redirect, requests, stop } =
			startPolling("application.one");

		await vi.advanceTimersByTimeAsync(3 * POLL_MS + 100);

		expect(requests).toHaveBeenCalledTimes(4);
		expect(observer.getCurrentResult().data).toBe("application");
		expect(redirect).not.toHaveBeenCalled();
		stop();
	});

	it("does not redirect from the login page", async () => {
		mocks.validateRequest.mockResolvedValue({ session: null, user: null });
		const { redirect, requests, stop } = startPolling("application.one", {
			pathname: "/",
		});

		await vi.advanceTimersByTimeAsync(60_000);

		expect(requests).toHaveBeenCalled();
		expect(redirect).not.toHaveBeenCalled();
		stop();
	});
});
