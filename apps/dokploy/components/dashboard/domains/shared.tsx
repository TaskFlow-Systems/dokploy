import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";

type Overview = RouterOutputs["domainOverview"]["list"];
export type Row = Overview["rows"][number];
export type UnusedCertificate = Overview["unusedCertificates"][number];
type DnsStatus = Row["dns"]["status"];

const DNS_STATUS: Record<
	DnsStatus,
	{ label: string; className: string; hint?: string }
> = {
	points_to_this_server: {
		label: "Points to this server",
		className: "text-emerald-600 dark:text-emerald-400",
	},
	points_to_other_address: {
		label: "Points to another address",
		className: "text-yellow-600 dark:text-yellow-400",
		hint: "Expected when a load balancer, CDN or proxy stands in front of this server. The page cannot check where that address forwards to.",
	},
	server_address_unknown: {
		label: "Server address unknown",
		className: "text-muted-foreground",
	},
	nxdomain: {
		label: "No DNS record (NXDOMAIN)",
		className: "text-red-600 dark:text-red-400",
	},
	no_address: {
		label: "Record exists but has no address",
		className: "text-red-600 dark:text-red-400",
	},
	lookup_failed: {
		label: "Lookup failed or timed out",
		className: "text-muted-foreground",
	},
	not_checked: {
		label: "Not checked (wildcard)",
		className: "text-muted-foreground",
	},
};

export const formatTime = (value: string | null) => {
	if (!value) {
		return "Time unknown";
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export const DnsCell = ({ dns }: { dns: Row["dns"] }) => {
	const status = DNS_STATUS[dns.status];
	return (
		<div className="flex flex-col gap-1.5 text-sm">
			<span className={cn("font-medium", status.className)}>
				{status.label}
			</span>
			{status.hint && (
				<span className="max-w-xs text-xs text-muted-foreground">
					{status.hint}
				</span>
			)}
			{dns.addresses.length > 0 && (
				<div className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
					{dns.addresses.map((address) => (
						<span key={address} className="break-all">
							{address}
						</span>
					))}
				</div>
			)}
		</div>
	);
};

export const LastErrorCell = ({
	error,
	logAvailable,
}: {
	error: Row["lastError"];
	logAvailable: boolean;
}) => {
	if (!error) {
		return (
			<span className="text-sm text-muted-foreground">
				{logAvailable
					? "No error in the recent Traefik log"
					: "Log not available"}
			</span>
		);
	}
	return (
		<div className="flex flex-col gap-2 text-sm max-w-md">
			<span className="text-xs text-muted-foreground">
				{formatTime(error.time)}
			</span>
			<span className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
				{error.message}
			</span>
			<span>{error.explanation}</span>
		</div>
	);
};

export const CountBadge = ({ count }: { count: number }) => (
	<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
		{count}
	</span>
);
