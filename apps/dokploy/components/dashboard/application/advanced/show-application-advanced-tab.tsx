import { ShowClusterSettings } from "@/components/dashboard/application/advanced/cluster/show-cluster-settings";
import { AddCommand } from "@/components/dashboard/application/advanced/general/add-command";
import { ShowPorts } from "@/components/dashboard/application/advanced/ports/show-port";
import { ShowRedirects } from "@/components/dashboard/application/advanced/redirects/show-redirects";
import { ShowSecurity } from "@/components/dashboard/application/advanced/security/show-security";
import { ShowBuildServer } from "@/components/dashboard/application/advanced/show-build-server";
import { ShowResources } from "@/components/dashboard/application/advanced/show-resources";
import { ShowTraefikConfig } from "@/components/dashboard/application/advanced/traefik/show-traefik-config";
import { ShowVolumes } from "@/components/dashboard/application/advanced/volumes/show-volumes";
import { AssignNetworks } from "@/components/dashboard/networks/assign-networks";

export const ShowApplicationAdvancedTab = ({
	applicationId,
}: {
	applicationId: string;
}) => (
	<>
		<AddCommand applicationId={applicationId} />
		<ShowClusterSettings id={applicationId} type="application" />
		<ShowBuildServer applicationId={applicationId} />
		<ShowResources id={applicationId} type="application" />
		<ShowVolumes id={applicationId} type="application" />
		<AssignNetworks id={applicationId} type="application" />
		<ShowRedirects applicationId={applicationId} />
		<ShowSecurity applicationId={applicationId} />
		<ShowPorts applicationId={applicationId} />
		<ShowTraefikConfig applicationId={applicationId} />
	</>
);
