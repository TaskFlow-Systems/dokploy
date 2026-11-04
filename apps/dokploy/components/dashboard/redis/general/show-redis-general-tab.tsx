import { ShowExternalRedisCredentials } from "@/components/dashboard/redis/general/show-external-redis-credentials";
import { ShowGeneralRedis } from "@/components/dashboard/redis/general/show-general-redis";
import { ShowInternalRedisCredentials } from "@/components/dashboard/redis/general/show-internal-redis-credentials";

export const ShowRedisGeneralTab = ({ redisId }: { redisId: string }) => (
	<>
		<ShowGeneralRedis redisId={redisId} />
		<ShowInternalRedisCredentials redisId={redisId} />
		<ShowExternalRedisCredentials redisId={redisId} />
	</>
);
