import { useRouter } from "next/router";
import { toast } from "sonner";
import { DeployFreezeBanner } from "@/components/dashboard/shared/deploy-freeze-banner";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { ComposeActions } from "./actions";
import { ShowProviderFormCompose } from "./generic/show";

interface Props {
	composeId: string;
}

export const ShowGeneralCompose = ({ composeId }: Props) => {
	const router = useRouter();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canDeploy = permissions?.deployment.create ?? false;
	const { data, refetch } = api.compose.one.useQuery(
		{ composeId },
		{
			enabled: !!composeId,
		},
	);
	const { mutateAsync: deployCompose } = api.compose.deploy.useMutation();

	return (
		<>
			<Card className="bg-background">
				<CardHeader>
					<div className="flex flex-row gap-2 justify-between flex-wrap">
						<CardTitle className="text-xl">Deploy Settings</CardTitle>
						<Badge>
							{data?.composeType === "docker-compose" ? "Compose" : "Stack"}
						</Badge>
					</div>

					<CardDescription>
						Create a compose file to deploy your compose
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4 flex-wrap">
					<DeployFreezeBanner
						serviceType="compose"
						serviceId={composeId}
						deployFreeze={data?.deployFreeze}
						canDeploy={canDeploy}
						onChanged={() => refetch()}
						onResumeAndDeploy={async () => {
							await deployCompose({ composeId });
							toast.success("Compose deployed successfully");
							await refetch();
							router.push(
								`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/services/compose/${composeId}?tab=deployments`,
							);
						}}
					/>
					<ComposeActions composeId={composeId} />
				</CardContent>
			</Card>
			<ShowProviderFormCompose composeId={composeId} />
		</>
	);
};
