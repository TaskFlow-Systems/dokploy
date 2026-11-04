import { ShowExternalMongoCredentials } from "@/components/dashboard/mongo/general/show-external-mongo-credentials";
import { ShowGeneralMongo } from "@/components/dashboard/mongo/general/show-general-mongo";
import { ShowInternalMongoCredentials } from "@/components/dashboard/mongo/general/show-internal-mongo-credentials";

export const ShowMongoGeneralTab = ({ mongoId }: { mongoId: string }) => (
	<>
		<ShowGeneralMongo mongoId={mongoId} />
		<ShowInternalMongoCredentials mongoId={mongoId} />
		<ShowExternalMongoCredentials mongoId={mongoId} />
	</>
);
