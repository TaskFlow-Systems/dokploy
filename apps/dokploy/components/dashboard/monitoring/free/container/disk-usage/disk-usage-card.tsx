import type { DiskHistoryPeriod } from "@dokploy/server/index";
import { useState } from "react";
import { FreeDiskSpace } from "@/components/dashboard/settings/web-server/free-disk-space";
import { api } from "@/utils/api";
import { DiskUsagePanel } from "./disk-usage-panel";

const REFRESH_INTERVAL_MS = 60_000;

export const DiskUsageCard = () => {
	const [period, setPeriod] = useState<DiskHistoryPeriod>("1d");
	const { data, isLoading } = api.settings.getDiskUsageHistory.useQuery(
		{ period, utcOffsetMinutes: -new Date().getTimezoneOffset() },
		{
			refetchOnWindowFocus: false,
			refetchInterval: REFRESH_INTERVAL_MS,
			placeholderData: (previous) => previous,
		},
	);

	return (
		<DiskUsagePanel
			history={data}
			isLoading={isLoading}
			period={period}
			onPeriodChange={setPeriod}
		>
			<FreeDiskSpace showOldImages />
		</DiskUsagePanel>
	);
};
