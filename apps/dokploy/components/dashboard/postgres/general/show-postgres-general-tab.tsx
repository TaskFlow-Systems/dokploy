import { ShowExternalPostgresCredentials } from "@/components/dashboard/postgres/general/show-external-postgres-credentials";
import { ShowGeneralPostgres } from "@/components/dashboard/postgres/general/show-general-postgres";
import { ShowInternalPostgresCredentials } from "@/components/dashboard/postgres/general/show-internal-postgres-credentials";

export const ShowPostgresGeneralTab = ({
	postgresId,
}: {
	postgresId: string;
}) => (
	<>
		<ShowGeneralPostgres postgresId={postgresId} />
		<ShowInternalPostgresCredentials postgresId={postgresId} />
		<ShowExternalPostgresCredentials postgresId={postgresId} />
	</>
);
