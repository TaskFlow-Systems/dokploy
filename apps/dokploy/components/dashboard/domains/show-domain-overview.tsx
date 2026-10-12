import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";
import { ShowTraefikLogs } from "./show-traefik-logs";

type Overview = RouterOutputs["domainOverview"]["list"];
type Row = Overview["rows"][number];
type DnsStatus = Row["dns"]["status"];

const DNS_STATUS: Record<DnsStatus, { label: string; className: string }> = {
	points_to_this_server: {
		label: "Points to this server",
		className: "text-emerald-600 dark:text-emerald-400",
	},
	points_to_other_address: {
		label: "Points to another address",
		className: "text-yellow-600 dark:text-yellow-400",
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

const formatTime = (value: string | null) => {
	if (!value) {
		return "Time unknown";
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const serviceHref = (
	projectId: string,
	environmentId: string,
	ownerType: string,
	ownerId: string,
) =>
	`/dashboard/project/${projectId}/environment/${environmentId}/services/${ownerType}/${ownerId}`;

const dockerHref = (serverId: string | null) =>
	serverId ? `/dashboard/docker?serverId=${serverId}` : "/dashboard/docker";

const UsedBy = ({ row }: { row: Row }) => {
	if (row.panelUses.length === 0 && row.routeUses.length === 0) {
		return (
			<span className="text-sm text-muted-foreground">
				Not used by any route or panel domain
			</span>
		);
	}
	const panelOwnerIds = new Set(row.panelUses.map((use) => use.ownerId));
	const routeOnly = row.routeUses.filter(
		(use) => !use.owner || !panelOwnerIds.has(use.owner.ownerId),
	);

	return (
		<div className="flex flex-col gap-2 text-sm">
			{row.panelUses.map((use) => (
				<div
					key={`panel-${use.ownerId}-${use.domainType ?? "domain"}`}
					className="flex flex-wrap items-center gap-2"
				>
					<Link
						href={serviceHref(
							use.projectId,
							use.environmentId,
							use.ownerType,
							use.ownerId,
						)}
						className="underline underline-offset-4 hover:text-muted-foreground"
					>
						{use.ownerName}
					</Link>
					<Badge variant="blank">{use.ownerType}</Badge>
					{use.domainType === "preview" && (
						<Badge variant="blank">preview</Badge>
					)}
					{!use.enabled && <Badge variant="secondary">disabled</Badge>}
				</div>
			))}
			{routeOnly.map((use, index) =>
				use.owner ? (
					<div
						key={`route-owner-${use.owner.ownerId}-${index}`}
						className="flex flex-wrap items-center gap-2"
					>
						<Link
							href={serviceHref(
								use.owner.projectId,
								use.owner.environmentId,
								use.owner.ownerType,
								use.owner.ownerId,
							)}
							className="underline underline-offset-4 hover:text-muted-foreground"
						>
							{use.owner.ownerName}
						</Link>
						<Badge variant="blank">{use.owner.ownerType}</Badge>
						<span className="text-xs text-muted-foreground">via route</span>
					</div>
				) : (
					<div
						key={`route-container-${use.containerName}-${index}`}
						className="flex flex-wrap items-center gap-2"
					>
						<span className="font-mono text-xs break-all">
							{use.containerName}
						</span>
						{use.composeProject && (
							<Badge variant="blank">project {use.composeProject}</Badge>
						)}
						<Link
							href={dockerHref(row.serverId)}
							className="text-xs underline underline-offset-4 hover:text-muted-foreground"
						>
							Docker containers
						</Link>
					</div>
				),
			)}
		</div>
	);
};

const DnsCell = ({ dns }: { dns: Row["dns"] }) => {
	const status = DNS_STATUS[dns.status];
	return (
		<div className="flex flex-col gap-1.5 text-sm">
			<span className={cn("font-medium", status.className)}>
				{status.label}
			</span>
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

const CertificateCell = ({
	row,
	certificatesVisible,
}: {
	row: Row;
	certificatesVisible: boolean;
}) => {
	const { certificate } = row;
	if (!certificatesVisible) {
		return (
			<span className="text-sm text-muted-foreground">
				Hidden without a super session
			</span>
		);
	}
	if (!certificate) {
		return (
			<span className="text-sm text-muted-foreground">No certificate</span>
		);
	}
	const date = certificate.validTo.slice(0, 10);
	const toneClassName =
		certificate.tone === "critical"
			? "text-red-600 dark:text-red-400"
			: certificate.tone === "warning"
				? "text-yellow-600 dark:text-yellow-400"
				: "";
	return (
		<div className="flex flex-col gap-1 text-sm">
			{row.certificateOnly && (
				<span className="font-medium text-orange-600 dark:text-orange-400">
					certificate only, nothing uses it
				</span>
			)}
			<span className={toneClassName}>
				{certificate.daysLeft < 0
					? `expired on ${date}`
					: `expires on ${date}, ${certificate.daysLeft} days left`}
			</span>
			<span className="text-xs text-muted-foreground">
				{certificate.issuer}
			</span>
		</div>
	);
};

const LastErrorCell = ({ error }: { error: Row["lastError"] }) => {
	if (!error) {
		return (
			<span className="text-sm text-muted-foreground">
				No error in the recent Traefik log
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

const DomainRow = ({
	row,
	certificatesVisible,
}: {
	row: Row;
	certificatesVisible: boolean;
}) => (
	<TableRow className="align-top">
		<TableCell className="font-mono text-sm break-all">
			<div className="flex flex-col gap-1">
				<span>{row.domain}</span>
				{row.domain.startsWith("*.") && <Badge variant="blank">wildcard</Badge>}
			</div>
		</TableCell>
		<TableCell>
			<div className="flex flex-col gap-1 text-sm">
				<span>{row.serverName}</span>
				{row.isLocal && <Badge variant="blank">Local</Badge>}
			</div>
		</TableCell>
		<TableCell>
			<UsedBy row={row} />
		</TableCell>
		<TableCell>
			<DnsCell dns={row.dns} />
		</TableCell>
		<TableCell>
			<CertificateCell row={row} certificatesVisible={certificatesVisible} />
		</TableCell>
		<TableCell>
			<LastErrorCell error={row.lastError} />
		</TableCell>
	</TableRow>
);

const DomainsTable = ({
	rows,
	certificatesVisible,
}: {
	rows: Row[];
	certificatesVisible: boolean;
}) => (
	<div className="overflow-x-auto rounded-lg border">
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Domain</TableHead>
					<TableHead>Server</TableHead>
					<TableHead>Used by</TableHead>
					<TableHead>DNS</TableHead>
					<TableHead>Certificate</TableHead>
					<TableHead>Last Traefik error</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.length === 0 ? (
					<TableRow>
						<TableCell
							colSpan={6}
							className="text-center text-muted-foreground"
						>
							No domains found on this instance.
						</TableCell>
					</TableRow>
				) : (
					rows.map((row) => (
						<DomainRow
							key={row.key}
							row={row}
							certificatesVisible={certificatesVisible}
						/>
					))
				)}
			</TableBody>
		</Table>
	</div>
);

export const ShowDomainOverview = () => {
	const { data, error, isLoading, isFetching, refetch } =
		api.domainOverview.list.useQuery(undefined, {
			refetchOnWindowFocus: false,
		});

	return (
		<div className="flex flex-col gap-4 w-full">
			<Card className="bg-sidebar p-2.5 rounded-xl w-full">
				<div className="rounded-xl bg-background shadow-md p-6 flex flex-col gap-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="flex flex-col gap-1">
							<h2 className="text-xl font-semibold">Domains</h2>
							<p className="text-sm text-muted-foreground">
								Every domain on this instance with its DNS record, certificate
								and last Traefik error. Read only.
							</p>
						</div>
						<div className="flex items-center gap-3">
							{data && (
								<span className="text-xs text-muted-foreground">
									Checked {formatTime(data.generatedAt)}
								</span>
							)}
							<Button
								variant="outline"
								size="sm"
								onClick={() => refetch()}
								disabled={isFetching}
							>
								<RefreshCw
									className={cn("size-4", isFetching && "animate-spin")}
								/>
								Refresh
							</Button>
						</div>
					</div>

					{error && <AlertBlock type="error">{error.message}</AlertBlock>}
					{data?.serverErrors.map((item) => (
						<AlertBlock
							key={`${item.serverId ?? "local"}-${item.message}`}
							type="warning"
						>
							{item.serverName}: {item.message}
						</AlertBlock>
					))}
					{isLoading && (
						<p className="text-sm text-muted-foreground">
							Checking DNS, certificates and Traefik logs. A slow server can
							delay this by up to 15 seconds.
						</p>
					)}
					{data && !data.certificatesVisible && (
						<AlertBlock type="info">
							Certificate dates are hidden. Traefik keeps them in its
							certificate store, which only an owner or admin with an open super
							session can read.
						</AlertBlock>
					)}
					{data && (
						<DomainsTable
							rows={data.rows}
							certificatesVisible={data.certificatesVisible}
						/>
					)}
				</div>
			</Card>

			{data?.servers.map((server) => (
				<ShowTraefikLogs
					key={server.serverId ?? "local"}
					serverId={server.serverId}
					serverName={server.name}
				/>
			))}
		</div>
	);
};
