import { CheckCircle2, CircleHelp, ShieldAlert } from "lucide-react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/utils/api";

type Server = RouterOutputs["domainOverview"]["list"]["servers"][number];
type Renewal = NonNullable<Server["certificateRenewal"]>;

const CHALLENGE_LABELS: Record<Renewal["challenge"], string> = {
	tls: "TLS-ALPN-01 on port 443",
	http: "HTTP-01, needs port 80",
	dns: "DNS-01, no inbound port",
	none: "No ACME challenge",
	missing: "traefik.yml not found",
	unreadable: "traefik.yml could not be read",
};

const StatusIcon = ({ renewal }: { renewal: Server["certificateRenewal"] }) => {
	if (renewal?.status === "ok") {
		return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
	}
	if (renewal?.status === "problem") {
		return <ShieldAlert className="size-4 shrink-0 text-red-500" />;
	}
	return <CircleHelp className="size-4 shrink-0 text-muted-foreground" />;
};

const Ports = ({ renewal }: { renewal: Renewal }) => {
	if (!renewal.traefikFound) {
		return (
			<span className="text-muted-foreground">Traefik container not found</span>
		);
	}
	const port80 = renewal.publishedPorts.some((port) => port.startsWith("80/"));
	return (
		<div className="flex flex-col gap-1">
			<span className="font-mono text-xs">
				{renewal.publishedPorts.length > 0
					? renewal.publishedPorts.join(", ")
					: "none"}
			</span>
			<span
				className={
					port80
						? "text-xs text-red-600 dark:text-red-400"
						: "text-xs text-muted-foreground"
				}
			>
				{port80 ? "port 80 is open" : "port 80 is closed"}
			</span>
		</div>
	);
};

export const CertificateRenewal = ({ servers }: { servers: Server[] }) => (
	<div className="flex flex-col gap-3">
		<div className="flex flex-col gap-1">
			<h3 className="text-lg font-semibold">Certificate renewal</h3>
			<p className="text-sm text-muted-foreground">
				Traefik issues and renews Let&apos;s Encrypt certificates through port
				443 (TLS-ALPN-01). Port 80 is never opened, so HTTP-01 is not used. This
				applies to every domain you connect, with nothing to switch on.
			</p>
		</div>
		<div className="overflow-x-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Server</TableHead>
						<TableHead>Method</TableHead>
						<TableHead>Published ports</TableHead>
						<TableHead>What to do</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{servers.map((server) => {
						const renewal = server.certificateRenewal;
						return (
							<TableRow
								key={`renewal-${server.serverId ?? "local"}`}
								className="align-top"
							>
								<TableCell className="text-sm">
									<div className="flex items-center gap-2">
										<StatusIcon renewal={renewal} />
										<span>{server.name}</span>
									</div>
								</TableCell>
								<TableCell className="text-sm">
									{renewal
										? CHALLENGE_LABELS[renewal.challenge]
										: "Not checked"}
								</TableCell>
								<TableCell className="text-sm">
									{renewal ? (
										<Ports renewal={renewal} />
									) : (
										<span className="text-muted-foreground">Not checked</span>
									)}
								</TableCell>
								<TableCell className="text-sm">
									{renewal && renewal.problems.length > 0 ? (
										<ul className="flex flex-col gap-1 text-red-600 dark:text-red-400">
											{renewal.problems.map((problem) => (
												<li key={problem}>{problem}</li>
											))}
										</ul>
									) : renewal?.status === "ok" ? (
										<span className="text-muted-foreground">Nothing</span>
									) : (
										<span className="text-muted-foreground">
											The server could not be checked. See the warnings above.
										</span>
									)}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	</div>
);
