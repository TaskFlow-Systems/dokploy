import type { DiskUsageHistory } from "@dokploy/server/index";
import { cn } from "@/lib/utils";
import {
	DISK_CATEGORIES,
	formatDiskBytes,
	formatDiskDelta,
	getDiskMoverCategory,
	getDiskMoverLabel,
} from "./disk-usage-format";

type Current = NonNullable<DiskUsageHistory["current"]>;

const Swatch = ({ color }: { color: string }) => (
	<span
		className="mt-1 size-2.5 shrink-0 rounded-[2px]"
		style={{ backgroundColor: color }}
	/>
);

const Delta = ({ bytes }: { bytes: number | null }) => (
	<span
		className={cn(
			"tabular-nums",
			bytes === null || Math.abs(bytes) < 5e5
				? "text-muted-foreground"
				: "font-medium",
		)}
	>
		{bytes === null ? "—" : formatDiskDelta(bytes)}
	</span>
);

export const DiskCompositionBar = ({
	current,
	categories,
}: {
	current: Current;
	categories: DiskUsageHistory["categories"];
}) => (
	<div
		className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
		role="img"
		aria-label={`Disk: ${formatDiskBytes(current.usedBytes)} used of ${formatDiskBytes(current.totalBytes)}`}
	>
		{categories
			.filter((row) => (row.bytes ?? 0) > 0)
			.map((row) => (
				<div
					key={row.category}
					className="h-full min-w-0.5"
					style={{
						width: `${((row.bytes ?? 0) / current.totalBytes) * 100}%`,
						backgroundColor: DISK_CATEGORIES[row.category].color,
					}}
					title={`${DISK_CATEGORIES[row.category].label}: ${formatDiskBytes(row.bytes ?? 0)}`}
				/>
			))}
	</div>
);

export const DiskCategoryTable = ({
	history,
	current,
}: {
	history: DiskUsageHistory;
	current: Current;
}) => (
	<div className="flex flex-col">
		<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 border-b pb-2 text-xs text-muted-foreground">
			<span>What takes the space</span>
			<span className="w-16 text-right sm:w-20">Now</span>
			<span className="w-20 text-right sm:w-24">Change</span>
		</div>
		<ul className="divide-y">
			{history.categories.map((row) => {
				const meta = DISK_CATEGORIES[row.category];
				return (
					<li
						key={row.category}
						className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-4 py-2 text-sm"
					>
						<div className="flex min-w-0 gap-2">
							<Swatch color={meta.color} />
							<div className="min-w-0">
								<p title={meta.description}>{meta.label}</p>
								<p className="hidden text-xs text-muted-foreground sm:block">
									{meta.description}
								</p>
							</div>
						</div>
						<span className="w-16 text-right sm:w-20 tabular-nums">
							{row.bytes === null ? "—" : formatDiskBytes(row.bytes)}
						</span>
						<span className="w-20 text-right sm:w-24">
							<Delta bytes={row.deltaBytes} />
						</span>
					</li>
				);
			})}
		</ul>
		<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 border-t pt-2 text-sm font-medium">
			<span>Used in total</span>
			<span className="w-16 text-right sm:w-20 tabular-nums">
				{formatDiskBytes(current.usedBytes)}
			</span>
			<span className="w-20 text-right sm:w-24">
				<Delta bytes={history.usedDeltaBytes} />
			</span>
		</div>
	</div>
);

export const DiskMoversList = ({ history }: { history: DiskUsageHistory }) => {
	if (history.changeSince === null) {
		return (
			<p className="text-sm text-muted-foreground">
				The history has just started. What grows shows up here after the next
				measurements.
			</p>
		);
	}
	if (history.movers.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				Nothing changed by more than 10 MB.
			</p>
		);
	}
	return (
		<ul className="divide-y">
			{history.movers.map((mover) => {
				const label = getDiskMoverLabel(mover);
				return (
					<li
						key={`${mover.kind}:${mover.name}`}
						className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 py-2 text-sm"
					>
						<div className="flex min-w-0 gap-2">
							<Swatch
								color={DISK_CATEGORIES[getDiskMoverCategory(mover)].color}
							/>
							<div className="min-w-0">
								<p className="break-all" title={label.name}>
									{label.name}
								</p>
								{label.kind && (
									<p className="text-xs text-muted-foreground">{label.kind}</p>
								)}
							</div>
						</div>
						<div className="text-right">
							<Delta bytes={mover.deltaBytes} />
							<p className="text-xs text-muted-foreground tabular-nums">
								now {formatDiskBytes(mover.bytes)}
							</p>
						</div>
					</li>
				);
			})}
		</ul>
	);
};
