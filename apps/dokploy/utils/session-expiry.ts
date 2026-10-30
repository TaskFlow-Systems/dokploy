import type {
	TRPCClientError,
	TRPCClientErrorLike,
	TRPCLink,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@/server/api/root";

const LOGIN_PATH = "/";
const PUBLIC_PATHS = new Set([
	LOGIN_PATH,
	"/register",
	"/invitation",
	"/reset-password",
	"/send-reset-password",
]);
const PUBLIC_PREFIXES = ["/accept-invitation"];

// The server marks only a request that arrived without a valid session. The
// same UNAUTHORIZED code also answers a signed-in user whose role is not
// allowed, and that one must never end up on the login page.
export const isNoSessionError = (error: unknown) =>
	(error as TRPCClientErrorLike<AppRouter> | null)?.data?.noSession === true;

export const isPublicPath = (pathname: string) => {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	return (
		PUBLIC_PATHS.has(path) ||
		PUBLIC_PREFIXES.some(
			(prefix) => path === prefix || path.startsWith(`${prefix}/`),
		)
	);
};

// Same limit as the React Query default, except that a request which failed
// for lack of a session is never repeated: it would fail the same way.
export const retryUnlessNoSession = (failureCount: number, error: unknown) =>
	failureCount < 3 && !isNoSessionError(error);

type NoSessionLinkOptions = {
	getPathname: () => string;
	redirect: (path: string) => void;
};

// After the first no-session answer on a page that needs one, the link sends
// the browser to the login page and answers every later request itself. A
// poll that fires before the navigation has finished then costs no request.
export const createNoSessionLink =
	({ getPathname, redirect }: NoSessionLinkOptions): TRPCLink<AppRouter> =>
	() => {
		let ended: TRPCClientError<AppRouter> | null = null;

		return ({ next, op }) =>
			observable((observer) => {
				if (ended) {
					observer.error(ended);
					return;
				}
				const subscription = next(op).subscribe({
					next: (value) => observer.next(value),
					error: (error) => {
						if (
							!ended &&
							isNoSessionError(error) &&
							!isPublicPath(getPathname())
						) {
							ended = error;
							redirect(LOGIN_PATH);
						}
						observer.error(error);
					},
					complete: () => observer.complete(),
				});
				return () => subscription.unsubscribe();
			});
	};

export const noSessionLink = createNoSessionLink({
	getPathname: () => window.location.pathname,
	// A full navigation drops the cached data of the ended session as well.
	redirect: (path) => window.location.assign(path),
});
