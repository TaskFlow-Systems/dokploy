import type {
	DiskHistoryPeriod,
	DiskUsageHistory,
} from "@dokploy/server/index";
import { format } from "date-fns";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	DiskCategoryTable,
	DiskCompositionBar,
	DiskMoversList,
} from "./disk-usage-breakdown";
import { DISK_PERIOD_LABELS, formatDiskBytes } from "./disk-usage-format";
import { DiskUsageHistoryChart } from "./disk-usage-history-chart";

const ALMOST_FULL_SHARE = 0.9;

interface Props {
	history: DiskUsageHistory | null | undefined;
	isLoading: boolean;
	period: DiskHistoryPeriod;
	onPeriodChange: (period: DiskHistoryPeriod) => void;
	/** Rendered under the tables; the page puts the cleanup actions here. */
	children?: ReactNode;
}

export const DiskUsagePanel = ({
	history,
	isLoading,
	period,
	onPeriodChange,
	children,
}: Props) => {
	const current = history?.current;

	if (isLoading && !history) {
		return (
			<div className="flex h-64 items-center justify-center">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}
	if (!history || !current) {
		return (
			<p className="text-xs text-muted-foreground">
				No disk usage data available.
			</p>
		);
	}

	const usedShare = current.usedBytes / current.totalBytes;
	// The first saved sample is later than the period's start while the
	// history is younger than the period.
	const isShortHistory =
		history.changeSince !== null &&
		history.changeSince > history.from + history.bucketMs;

	return (
		<div className="flex w-full flex-col gap-5">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex flex-col gap-1">
					<p className="text-2xl font-semibold tracking-tight tabular-nums">
						{formatDiskBytes(current.usedBytes)}
						<span className="ml-2 text-sm font-normal text-muted-foreground">
							used of {formatDiskBytes(current.totalBytes)}
						</span>
					</p>
					<p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
						<span>
							{formatDiskBytes(current.availableBytes)} free ·{" "}
							{Math.round(usedShare * 100)}% full
						</span>
						{usedShare >= ALMOST_FULL_SHARE && (
							<span className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
								<AlertTriangle className="size-3.5" />
								Almost full
							</span>
						)}
					</p>
				</div>
				<Tabs
					value={period}
					onValueChange={(value) => onPeriodChange(value as DiskHistoryPeriod)}
				>
					<TabsList aria-label="Disk usage period">
						{(Object.keys(DISK_PERIOD_LABELS) as DiskHistoryPeriod[]).map(
							(option) => (
								<TabsTrigger key={option} value={option}>
									{DISK_PERIOD_LABELS[option]}
								</TabsTrigger>
							),
						)}
					</TabsList>
				</Tabs>
			</div>

			<DiskCompositionBar current={current} categories={history.categories} />
			<DiskUsageHistoryChart history={history} />

			<div className="grid gap-x-8 gap-y-6 xl:grid-cols-2">
				<DiskCategoryTable history={history} current={current} />
				<div className="flex flex-col">
					<div className="border-b pb-2 text-xs text-muted-foreground">
						{history.changeSince === null
							? "What changed the most"
							: `What changed the most since ${format(new Date(history.changeSince), "d MMM, HH:mm")}`}
					</div>
					<div className="pt-2">
						<DiskMoversList history={history} />
					</div>
					{isShortHistory && (
						<p className="pt-2 text-xs text-muted-foreground">
							The history is shorter than {DISK_PERIOD_LABELS[period]}, so the
							changes are counted from its first measurement.
						</p>
					)}
				</div>
			</div>

			<p className="text-xs text-muted-foreground">
				1 GB is 1000 MB here, the same units Docker reports.
			</p>

			{children}
		</div>
	);
};
