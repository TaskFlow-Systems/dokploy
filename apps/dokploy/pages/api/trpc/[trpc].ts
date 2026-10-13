import { createNextApiHandler } from "@trpc/server/adapters/next";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";
import { logProcedureFailure } from "@/server/api/utils/procedure-error-log";

// export API handler (v11: body parsed by Content-Type automatically, no experimental_contentTypeHandlers)
export default createNextApiHandler({
	router: appRouter,
	createContext: createTRPCContext,
	onError: ({ path, type, error }) => {
		if (process.env.NODE_ENV === "development") {
			console.error(
				`❌ tRPC failed on ${path ?? "<no-path>"}: ${error.message}`,
			);
			return;
		}
		void logProcedureFailure({ source: "trpc", path, type, error });
	},
});

export const config = {
	api: {
		bodyParser: false,
		sizeLimit: "1gb",
	},
};
