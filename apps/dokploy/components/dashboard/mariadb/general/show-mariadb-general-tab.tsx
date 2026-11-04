import { ShowExternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-external-mariadb-credentials";
import { ShowGeneralMariadb } from "@/components/dashboard/mariadb/general/show-general-mariadb";
import { ShowInternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-internal-mariadb-credentials";

export const ShowMariadbGeneralTab = ({ mariadbId }: { mariadbId: string }) => (
	<>
		<ShowGeneralMariadb mariadbId={mariadbId} />
		<ShowInternalMariadbCredentials mariadbId={mariadbId} />
		<ShowExternalMariadbCredentials mariadbId={mariadbId} />
	</>
);
