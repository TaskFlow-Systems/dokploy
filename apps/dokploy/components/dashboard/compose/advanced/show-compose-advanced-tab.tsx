import { ShowImport } from "@/components/dashboard/application/advanced/import/show-import";
import { ShowVolumes } from "@/components/dashboard/application/advanced/volumes/show-volumes";
import { AddCommandCompose } from "@/components/dashboard/compose/advanced/add-command";
import { IsolatedDeploymentTab } from "@/components/dashboard/compose/advanced/add-isolation";
import { FreshVolumes } from "@/components/dashboard/compose/advanced/fresh-volumes";
import { AssignComposeNetworks } from "@/components/dashboard/networks/assign-compose-networks";

export const ShowComposeAdvancedTab = ({
	composeId,
}: {
	composeId: string;
}) => (
	<>
		<AddCommandCompose composeId={composeId} />
		<ShowVolumes id={composeId} type="compose" />
		<ShowImport composeId={composeId} />
		<AssignComposeNetworks composeId={composeId} />
		<IsolatedDeploymentTab composeId={composeId} />
		<FreshVolumes composeId={composeId} />
	</>
);
