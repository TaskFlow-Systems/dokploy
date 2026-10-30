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
import { api } from "@/utils/api";
import { CertificateRenewal } from "./certificate-renewal";
import { InterruptedDeletion } from "./interrupted-deletion";
import {
	CountBadge,
	DnsCell,
	formatTime,
	LastErrorCell,
	type Row,
} from "./shared";
import { ShowTraefikLogs } from "./show-traefik-logs";
import { UnusedCertificatesTable } from "./unused-certificates-table";

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
	const panelOwnerIds = new Set(row.panelUses.map((use) => use.ownerId));
	const routeOnly = row.routeUses.filter(
		(use) => !use.owner || !panelOwnerIds.has(use.owner.ownerId),
	);

	return (
		<div className="flex flex-col gap-2 text-sm">
			{row.panelHost && (
				<div className="flex flex-wrap items-center gap-2">
					<span>Panel</span>
					<Badge variant="blank">panel domain</Badge>
				</div>
			)}
			{row.configFiles.map((file) => (
				<div key={`file-${file}`} className="flex flex-wrap items-center gap-2">
					<span className="font-mono text-xs break-all">{file}</span>
					<Badge variant="blank">Traefik config file</Badge>
				</div>
			))}
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
				Owners and admins only
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
			<LastErrorCell error={row.lastError} logAvailable={row.logAvailable} />
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
	<div className="flex flex-col gap-3">
		<div className="flex items-center gap-2">
			<h3 className="text-lg font-semibold">Domains in use</h3>
			<CountBadge count={rows.length} />
		</div>
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
								No domains in use found on this instance.
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
	</div>
);

export const ShowDomainOverview = () => {
	const { data, error, isLoading, isFetching, refetch } =
		api.domainOverview.list.useQuery(undefined, {
			refetchOnWindowFocus: false,
			refetchInterval: (query) =>
				query.state.data?.servers.some(
					(item) => item.lastDeletion?.state === "in_progress",
				)
					? 5_000
					: false,
		});

	return (
		<div className="flex flex-col gap-4 w-full">
			<Card className="bg-sidebar p-2.5 rounded-xl w-full">
				<div className="rounded-xl bg-background shadow-md p-6 flex flex-col gap-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="flex flex-col gap-1">
							<h2 className="text-xl font-semibold">Domains</h2>
							<p className="text-sm text-muted-foreground">
								Domains that routes or the panel use, and certificates that
								nothing uses.
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
							certificate store, which only an owner or admin can read.
						</AlertBlock>
					)}
					{data && data.servers.length > 0 && (
						<CertificateRenewal servers={data.servers} />
					)}
					{data && (
						<DomainsTable
							rows={data.rows}
							certificatesVisible={data.certificatesVisible}
						/>
					)}
					{data && (
						<UnusedCertificatesTable
							items={data.unusedCertificates}
							certificatesVisible={data.certificatesVisible}
						/>
					)}
					{data?.servers.map((item) => (
						<InterruptedDeletion
							key={`recovery-${item.serverId ?? "local"}`}
							serverId={item.serverId}
							name={item.name}
							traefikLeftStopped={item.traefikLeftStopped}
							staleLock={item.staleLock}
						/>
					))}
					{data?.servers.map((item) =>
						item.lastDeletion ? (
							<AlertBlock
								key={`deletion-${item.serverId ?? "local"}`}
								type={
									item.lastDeletion.state === "succeeded"
										? "success"
										: item.lastDeletion.state === "in_progress"
											? "info"
											: "error"
								}
							>
								{item.name}: certificate deletion{" "}
								{item.lastDeletion.state === "in_progress"
									? "restart in progress"
									: item.lastDeletion.state}
								{item.lastDeletion.time
									? ` (${formatTime(item.lastDeletion.time)})`
									: ""}
								. {item.lastDeletion.message}
								{item.lastDeletion.backupFile
									? ` Backup file: ${item.lastDeletion.backupFile}.`
									: ""}
							</AlertBlock>
						) : null,
					)}
					{data?.servers
						.filter((item) => !item.usageVerified)
						.map((item) => (
							<AlertBlock
								key={`unverified-${item.serverId ?? "local"}`}
								type="warning"
							>
								{item.name}: routes or certificates could not be read, so unused
								certificates are not listed for this server.
							</AlertBlock>
						))}
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
