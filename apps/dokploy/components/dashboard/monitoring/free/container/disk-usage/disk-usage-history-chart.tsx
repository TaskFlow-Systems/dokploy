import type { DiskCategory, DiskUsageHistory } from "@dokploy/server/index";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
} from "@/components/ui/chart";
import {
	DISK_CATEGORIES,
	DISK_CATEGORY_ORDER,
	describeDiskBucket,
	formatDiskBucket,
	formatDiskBytes,
	formatDiskTimeTick,
	getDiskAxisTicks,
	getDiskTimeTicks,
} from "./disk-usage-format";

const chartConfig = Object.fromEntries(
	DISK_CATEGORY_ORDER.map((category) => [
		category,
		{
			label: DISK_CATEGORIES[category].label,
			color: DISK_CATEGORIES[category].color,
		},
	]),
) satisfies ChartConfig;

type ChartRow = { from: number; usedBytes: number | null } & Record<
	DiskCategory,
	number
>;

const BucketTooltip = ({
	active,
	payload,
	bucketMs,
	totalBytes,
}: {
	active?: boolean;
	payload?: { payload?: ChartRow }[];
	bucketMs: number;
	totalBytes: number;
}) => {
	const row = payload?.[0]?.payload;
	if (!active || !row || row.usedBytes === null) {
		return null;
	}
	return (
		<div className="grid min-w-52 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
			<div className="font-medium">{formatDiskBucket(row.from, bucketMs)}</div>
			<div className="text-muted-foreground">
				Used {formatDiskBytes(row.usedBytes)} of {formatDiskBytes(totalBytes)}
			</div>
			<div className="grid gap-1">
				{DISK_CATEGORY_ORDER.filter((category) => row[category] > 0).map(
					(category) => (
						<div key={category} className="flex items-center gap-2">
							<span
								className="size-2.5 shrink-0 rounded-[2px]"
								style={{ backgroundColor: DISK_CATEGORIES[category].color }}
							/>
							<span className="flex-1 text-muted-foreground">
								{DISK_CATEGORIES[category].label}
							</span>
							<span className="font-medium tabular-nums">
								{formatDiskBytes(row[category])}
							</span>
						</div>
					),
				)}
			</div>
		</div>
	);
};

interface Props {
	history: DiskUsageHistory;
}

export const DiskUsageHistoryChart = ({ history }: Props) => {
	const totalBytes =
		history.current?.totalBytes ??
		history.buckets
			.map((bucket) => bucket.sample?.totalBytes ?? 0)
			.reduce((latest, bytes) => bytes || latest, 0);
	const rows: ChartRow[] = history.buckets.map((bucket) => ({
		from: bucket.from,
		usedBytes: bucket.sample?.usedBytes ?? null,
		...(Object.fromEntries(
			DISK_CATEGORY_ORDER.map((category) => [
				category,
				bucket.sample?.parts[category] ?? 0,
			]),
		) as Record<DiskCategory, number>),
	}));

	return (
		<div className="flex flex-col gap-1">
			<ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
				<BarChart
					data={rows}
					margin={{ top: 16, right: 8, left: 0, bottom: 0 }}
					barCategoryGap="14%"
				>
					<CartesianGrid vertical={false} />
					<XAxis
						dataKey="from"
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						minTickGap={28}
						ticks={getDiskTimeTicks(
							rows.map((row) => row.from),
							history.bucketMs,
						)}
						tickFormatter={(from: number) =>
							formatDiskTimeTick(from, history.bucketMs)
						}
					/>
					<YAxis
						domain={[0, totalBytes]}
						ticks={getDiskAxisTicks(totalBytes)}
						tickLine={false}
						axisLine={false}
						width={52}
						tickFormatter={(bytes: number) => `${Math.round(bytes / 1e9)} GB`}
					/>
					<ReferenceLine
						y={totalBytes}
						stroke="hsl(var(--muted-foreground))"
						strokeDasharray="4 4"
						label={{
							value: `Disk size ${formatDiskBytes(totalBytes)}`,
							position: "insideTopRight",
							className: "fill-muted-foreground text-[11px]",
						}}
					/>
					<ChartTooltip
						cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
						content={
							<BucketTooltip
								bucketMs={history.bucketMs}
								totalBytes={totalBytes}
							/>
						}
					/>
					{DISK_CATEGORY_ORDER.map((category, index) => (
						<Bar
							key={category}
							dataKey={category}
							stackId="disk"
							fill={`var(--color-${category})`}
							// A hairline of the surface colour keeps touching segments apart.
							stroke="hsl(var(--background))"
							strokeWidth={1}
							radius={
								index === DISK_CATEGORY_ORDER.length - 1 ? [3, 3, 0, 0] : 0
							}
							isAnimationActive={false}
						/>
					))}
				</BarChart>
			</ChartContainer>
			<p className="text-xs text-muted-foreground">
				Each bar covers {describeDiskBucket(history.bucketMs)} and shows the
				fullest moment of it, so a short spike stays visible.
			</p>
		</div>
	);
};
