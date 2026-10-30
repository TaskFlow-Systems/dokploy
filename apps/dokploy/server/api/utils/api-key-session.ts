import { TRPCError } from "@trpc/server";

type SessionLike =
	| {
			id?: string | null;
			authMethod?: string | null;
	  }
	| null
	| undefined;

// validateRequest marks sessions built from an x-api-key header; every other
// session comes from the better-auth cookie.
export const isApiKeySession = (session: SessionLike) =>
	session?.authMethod === "api-key";

export const assertBrowserSession = (ctx: { session: SessionLike }) => {
	if (isApiKeySession(ctx.session) || !ctx.session?.id) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "This action is only available from a browser session.",
		});
	}
};
