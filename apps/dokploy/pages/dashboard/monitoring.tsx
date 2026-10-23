import { IS_CLOUD } from "@dokploy/server/constants";
import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import { ShowPaidMonitoring } from "@/components/dashboard/monitoring/paid/servers/show-paid-monitoring";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Card } from "@/components/ui/card";
import { useLocalStorage } from "@/hooks/useLocalStorage";

const Dashboard = () => {
	const [toggleMonitoring, _setToggleMonitoring] = useLocalStorage(
		"monitoring-enabled",
		false,
	);

	return (
		<div className="space-y-4 pb-10">
			{/* <AlertBlock>
				You are watching the <strong>Free</strong> plan.{" "}
				<a
					href="https://dokploy.com#pricing"
					target="_blank"
					className="underline"
					rel="noreferrer"
				>
					Upgrade
				</a>{" "}
				to get more features.
			</AlertBlock> */}
			<>
				{/* {monitoring?.enabledFeatures && (
						<div className="flex flex-row border w-fit p-4 rounded-lg items-center gap-2">
							<Label className="text-muted-foreground">Change Monitoring</Label>
							<Switch
								checked={toggleMonitoring}
								onCheckedChange={setToggleMonitoring}
							/>
						</div>
					)} */}
				{toggleMonitoring ? (
					<Card className="bg-sidebar  p-2.5 rounded-xl  mx-auto">
						<div className="rounded-xl bg-background shadow-md">
							<ShowPaidMonitoring />
						</div>
					</Card>
				) : (
					<Card className="h-full bg-sidebar  p-2.5 rounded-xl">
						<div className="rounded-xl bg-background shadow-md p-6">
							<ContainerFreeMonitoring appName="dokploy" />
						</div>
					</Card>
				)}
			</>
		</div>
	);
};

export default Dashboard;

Dashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}

	const permissionCtx = {
		user: { id: user.id },
		session: { activeOrganizationId: session?.activeOrganizationId || "" },
	};
	const [canReadMonitoring, canReadDocker] = await Promise.all([
		hasPermission(permissionCtx, { monitoring: ["read"] }),
		hasPermission(permissionCtx, { docker: ["read"] }),
	]);
	const canView = canReadMonitoring && canReadDocker;

	if (!canView) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}

	return {
		props: {},
	};
}
