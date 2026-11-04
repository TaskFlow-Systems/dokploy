import { ShowExternalLibsqlCredentials } from "@/components/dashboard/libsql/general/show-external-libsql-credentials";
import { ShowGeneralLibsql } from "@/components/dashboard/libsql/general/show-general-libsql";
import { ShowInternalLibsqlCredentials } from "@/components/dashboard/libsql/general/show-internal-libsql-credentials";

export const ShowLibsqlGeneralTab = ({ libsqlId }: { libsqlId: string }) => (
	<>
		<ShowGeneralLibsql libsqlId={libsqlId} />
		<ShowInternalLibsqlCredentials libsqlId={libsqlId} />
		<ShowExternalLibsqlCredentials libsqlId={libsqlId} />
	</>
);
