import { ShowExternalMysqlCredentials } from "@/components/dashboard/mysql/general/show-external-mysql-credentials";
import { ShowGeneralMysql } from "@/components/dashboard/mysql/general/show-general-mysql";
import { ShowInternalMysqlCredentials } from "@/components/dashboard/mysql/general/show-internal-mysql-credentials";

export const ShowMysqlGeneralTab = ({ mysqlId }: { mysqlId: string }) => (
	<>
		<ShowGeneralMysql mysqlId={mysqlId} />
		<ShowInternalMysqlCredentials mysqlId={mysqlId} />
		<ShowExternalMysqlCredentials mysqlId={mysqlId} />
	</>
);
