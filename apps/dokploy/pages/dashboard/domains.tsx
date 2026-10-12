import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowDomainOverview } from "@/components/dashboard/domains/show-domain-overview";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { appRouter } from "@/server/api/root";

export default function Domains() {
	return <ShowDomainOverview />;
}

Domains.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user, session } = await validateRequest(ctx.req);
	const redirectHome = {
		redirect: {
			permanent: false,
			destination: "/",
		},
	};
	if (!user) {
		return redirectHome;
	}

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: ctx.req as any,
			res: ctx.res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});
	const permissions = await helpers.user.getPermissions
		.fetch()
		.catch(() => null);
	if (!permissions?.traefikFiles.read) {
		return redirectHome;
	}

	return {
		props: {},
	};
}
