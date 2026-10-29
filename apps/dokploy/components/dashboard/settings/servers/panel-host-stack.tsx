import type { HostDockerUpgradeStatus } from "@dokploy/server/setup/host-docker-upgrade";
import type {
	HostStackComponent,
	HostStackRow,
} from "@dokploy/server/setup/host-stack-rows";
import {
	AlertTriangle,
	CheckCircle2,
	Loader2,
	RefreshCw,
	Server,
	XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { UpdateServer } from "../web-server/update-server";
import { updateOutcome } from "./host-stack-log";

const TRAEFIK_CONNECTION_NOTE =
	"If the connection to the panel dropped while Traefik was recreated, the update can still finish on the host. Reload this page to see the result.";

const LABELS: Record<HostStackComponent, string> = {
	panel: "Panel",
	docker: "Docker",
	traefik: "Traefik",
	postgres: "Postgres",
	redis: "Redis",
};

const WARNINGS: Partial<Record<HostStackComponent, string>> = {
	traefik:
		"Traefik is recreated; the admin site is unreachable for a few seconds.",
	redis: "Redis is restarted; it is unavailable for a few seconds.",
};

const DOCKER_POLL_MS = 2000;
const RECENT_RUN_MS = 24 * 60 * 60 * 1000;

const isDockerUpgradeActive = (status: HostDockerUpgradeStatus | null) =>
	status?.state === "starting" || status?.state === "running";

const isRecentRun = (status: HostDockerUpgradeStatus) => {
	const finished = Date.parse(status.finishedAt ?? status.startedAt);
	return Number.isFinite(finished) && Date.now() - finished < RECENT_RUN_MS;
};

const DockerUpgradeHeadline = ({
	status,
	connectionLost,
}: {
	status: HostDockerUpgradeStatus;
	connectionLost: boolean;
}) => {
	const versions = `${status.from ?? "unknown"} → ${status.to}`;
	if (isDockerUpgradeActive(status)) {
		return (
			<p className="flex items-start gap-2 text-sm">
				<Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
				<span>
					{connectionLost
						? "Docker is restarting, and this panel with it. Waiting for the panel to come back; this window reconnects by itself."
						: `Upgrading Docker Engine ${versions} on the host. Sites and this panel stop for a minute or two.`}
				</span>
			</p>
		);
	}
	if (status.state === "succeeded") {
		return (
			<p className="flex items-start gap-2 text-sm text-green-600">
				<CheckCircle2 className="mt-0.5 size-4 shrink-0" />
				<span>Docker Engine upgraded: {versions}.</span>
			</p>
		);
	}
	if (status.state === "interrupted") {
		return (
			<p className="flex items-start gap-2 text-sm text-amber-600">
				<AlertTriangle className="mt-0.5 size-4 shrink-0" />
				<span>
					The Docker Engine upgrade stopped reporting before it finished. Check
					the host with: journalctl -u dokploy-docker-engine-upgrade
				</span>
			</p>
		);
	}
	return (
		<p className="flex items-start gap-2 text-sm text-destructive">
			<XCircle className="mt-0.5 size-4 shrink-0" />
			<span>
				The Docker Engine upgrade failed
				{status.exitCode !== null ? ` (exit code ${status.exitCode})` : ""}. The
				log below says whether Docker was rolled back to {status.from}.
			</span>
		</p>
	);
};

const DockerUpgradeProgress = ({
	status,
	connectionLost,
}: {
	status: HostDockerUpgradeStatus;
	connectionLost: boolean;
}) => (
	<div className="flex flex-col gap-2 rounded-md border p-3">
		<DockerUpgradeHeadline status={status} connectionLost={connectionLost} />
		{status.log && (
			<pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
				{status.log}
			</pre>
		)}
	</div>
);

const StatusLine = ({ row }: { row: HostStackRow }) => {
	if (row.status === "outdated") {
		return (
			<span className="inline-flex items-center gap-1 text-xs text-amber-600">
				<AlertTriangle className="size-4" />
				Outdated
			</span>
		);
	}
	if (row.status === "current") {
		return (
			<span className="inline-flex items-center gap-1 text-xs text-green-600">
				<CheckCircle2 className="size-4" />
				Up to date
			</span>
		);
	}
	return <span className="text-xs text-muted-foreground">Unknown</span>;
};

const HostStackRowItem = ({
	row,
	checked,
	onCheckedChange,
	onOpenWebUpdate,
	dockerUpgradeBusy,
	onUpgradeDocker,
}: {
	row: HostStackRow;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	onOpenWebUpdate: () => void;
	dockerUpgradeBusy: boolean;
	onUpgradeDocker: () => void;
}) => {
	const checkboxId = `host-stack-${row.name}`;
	return (
		<div className="flex flex-col gap-3 rounded-md border p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
			<div className="flex min-w-32 flex-col gap-0.5">
				<span className="font-medium">{LABELS[row.name]}</span>
				<span className="text-xs text-muted-foreground">
					installed: {row.installed ?? "not found"}
				</span>
				<span className="text-xs text-muted-foreground">
					target: {row.target ?? "not pinned"}
				</span>
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-2 sm:items-end sm:text-right">
				<StatusLine row={row} />
				{row.action === "panel" && (
					<Button variant="outline" size="sm" onClick={onOpenWebUpdate}>
						Web Server Update
					</Button>
				)}
				{row.action === "ui" && (
					<div className="flex items-center gap-2">
						<Checkbox
							id={checkboxId}
							checked={row.outdated && checked}
							disabled={!row.outdated}
							onCheckedChange={(value) => onCheckedChange(value === true)}
						/>
						<Label
							htmlFor={checkboxId}
							className={cn(!row.outdated && "text-muted-foreground")}
						>
							{row.outdated ? `Update to ${row.target}` : "Nothing to update"}
						</Label>
					</div>
				)}
				{row.action === "docker" && row.outdated && (
					<Button
						variant="outline"
						size="sm"
						disabled={dockerUpgradeBusy}
						onClick={onUpgradeDocker}
					>
						{dockerUpgradeBusy && <Loader2 className="size-4 animate-spin" />}
						Upgrade to {row.target}
					</Button>
				)}
				{row.reason &&
					(row.action === "manual" ||
						row.status === "unknown" ||
						(row.action === "docker" && row.outdated)) && (
						<p className="text-xs text-muted-foreground">{row.reason}</p>
					)}
				{row.action === "manual" && row.command && (
					<code className="block max-w-full overflow-x-auto rounded bg-muted px-2 py-1 text-xs select-all">
						{row.command}
					</code>
				)}
				{row.action === "docker" &&
					row.command &&
					(row.outdated || row.status === "unknown") && (
						<details className="text-xs text-muted-foreground">
							<summary className="cursor-pointer">
								Or run it on the host yourself
							</summary>
							<code className="mt-1 block max-w-full overflow-x-auto rounded bg-muted px-2 py-1 text-left select-all">
								{row.command}
							</code>
						</details>
					)}
			</div>
		</div>
	);
};

const PanelHostCard = ({
	rows,
	refetch,
}: {
	rows: HostStackRow[];
	refetch: () => unknown;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const [isConfirmOpen, setIsConfirmOpen] = useState(false);
	const [isWebUpdateOpen, setIsWebUpdateOpen] = useState(false);
	const [chosen, setChosen] = useState<
		Partial<Record<HostStackComponent, boolean>>
	>({});
	const [isUpdating, setIsUpdating] = useState(false);
	const [runComponents, setRunComponents] = useState<HostStackComponent[]>([]);
	const [logs, setLogs] = useState("");
	const logBuffer = useRef("");
	const [isDockerConfirmOpen, setIsDockerConfirmOpen] = useState(false);
	const [isWatchingDocker, setIsWatchingDocker] = useState(false);
	const utils = api.useUtils();

	// The panel itself goes down while Docker restarts, so polling keeps going
	// through failed requests until the host reports the run finished.
	const dockerUpgrade = api.settings.hostDockerUpgrade.useQuery(undefined, {
		refetchOnWindowFocus: false,
		retry: false,
		refetchInterval: (query) =>
			isWatchingDocker || isDockerUpgradeActive(query.state.data ?? null)
				? DOCKER_POLL_MS
				: false,
	});
	const dockerStatus = dockerUpgrade.data ?? null;
	const dockerActive = isDockerUpgradeActive(dockerStatus);
	const dockerRow = rows.find((row) => row.name === "docker");

	const upgradeDocker = api.settings.upgradeHostDocker.useMutation({
		onSuccess(status) {
			utils.settings.hostDockerUpgrade.setData(undefined, status);
			setIsWatchingDocker(true);
		},
		onError(err) {
			toast.error(err.message);
			void dockerUpgrade.refetch();
		},
	});

	useEffect(() => {
		if (dockerActive) {
			setIsWatchingDocker(true);
			return;
		}
		if (!isWatchingDocker || !dockerStatus) {
			return;
		}
		setIsWatchingDocker(false);
		if (dockerStatus.state === "succeeded") {
			toast.success(`Docker Engine upgraded to ${dockerStatus.to}`);
		} else {
			toast.error("Docker Engine upgrade did not finish, see the log");
		}
		void refetch();
	}, [dockerActive, dockerStatus, isWatchingDocker, refetch]);

	const outdatedCount = rows.filter((row) => row.outdated).length;
	const unknownCount = rows.filter((row) => row.status === "unknown").length;
	const selected = rows
		.filter(
			(row) =>
				row.action === "ui" && row.outdated && (chosen[row.name] ?? true),
		)
		.map((row) => row.name);
	const summary = rows
		.filter((row) => row.name !== "panel")
		.map((row) => `${LABELS[row.name]} ${row.installed ?? "unknown"}`)
		.join(" · ");

	api.settings.updateHostStack.useSubscription(
		{ components: runComponents },
		{
			enabled: isUpdating,
			onData(log) {
				const previous = logBuffer.current;
				logBuffer.current = `${previous}${log}`;
				setLogs(logBuffer.current);
				const outcome = updateOutcome(previous, logBuffer.current);
				if (outcome === null) {
					return;
				}
				setIsUpdating(false);
				if (outcome === "done") {
					toast.success("Panel host components updated");
				} else {
					toast.error("Panel host update failed, see the log");
				}
				void refetch();
			},
			onError(err) {
				const note = runComponents.includes("traefik")
					? `\n${TRAEFIK_CONNECTION_NOTE}`
					: "";
				logBuffer.current = `${logBuffer.current}${err.message}${note}\n`;
				setLogs(logBuffer.current);
				setIsUpdating(false);
				toast.error("Panel host update did not finish");
				void refetch();
			},
		},
	);

	const startUpdate = () => {
		logBuffer.current = "";
		setLogs("");
		setRunComponents(selected);
		setIsConfirmOpen(false);
		setIsUpdating(true);
	};

	return (
		<>
			<Card className="bg-transparent">
				<CardHeader className="pb-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<CardTitle className="flex items-center gap-2 text-lg">
							<Server className="size-5 text-muted-foreground" />
							Panel host (this server)
						</CardTitle>
						{outdatedCount > 0 ? (
							<Badge variant="yellow">{outdatedCount} to update</Badge>
						) : unknownCount > 0 ? (
							<Badge variant="secondary">Some versions unknown</Badge>
						) : (
							<Badge variant="green">Up to date</Badge>
						)}
					</div>
					<CardDescription>
						Docker, Traefik, Postgres and Redis on the server that runs this
						panel.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<p className="text-sm text-muted-foreground">{summary}</p>
					<Dialog open={isOpen} onOpenChange={setIsOpen}>
						<DialogTrigger asChild>
							<Button
								variant={outdatedCount > 0 ? "default" : "outline"}
								size="sm"
								className={cn(
									"cursor-pointer",
									outdatedCount > 0 &&
										"bg-amber-500 text-black hover:bg-amber-400",
								)}
							>
								<RefreshCw className="size-4" />
								Components
							</Button>
						</DialogTrigger>
						<DialogContent className="sm:max-w-3xl">
							<DialogHeader>
								<DialogTitle className="flex items-center gap-2">
									<Server className="size-5" /> Panel host components
								</DialogTitle>
								<DialogDescription>
									Versions on the server that runs this panel, compared with the
									versions pinned in Dokploy.
								</DialogDescription>
							</DialogHeader>

							<div className="flex flex-col gap-2 pt-2">
								{rows.map((row) => (
									<HostStackRowItem
										key={row.name}
										row={row}
										checked={chosen[row.name] ?? true}
										onCheckedChange={(value) =>
											setChosen((prev) => ({ ...prev, [row.name]: value }))
										}
										onOpenWebUpdate={() => {
											setIsOpen(false);
											setIsWebUpdateOpen(true);
										}}
										dockerUpgradeBusy={
											dockerActive ||
											isWatchingDocker ||
											upgradeDocker.isPending
										}
										onUpgradeDocker={() => setIsDockerConfirmOpen(true)}
									/>
								))}
							</div>

							{dockerStatus &&
								(dockerActive ||
									isWatchingDocker ||
									isRecentRun(dockerStatus)) && (
									<DockerUpgradeProgress
										status={dockerStatus}
										connectionLost={dockerUpgrade.isError}
									/>
								)}

							{selected.map((name) =>
								WARNINGS[name] ? (
									<p key={name} className="text-xs text-amber-600">
										{WARNINGS[name]}
									</p>
								) : null,
							)}

							<Button
								disabled={selected.length === 0 || isUpdating}
								onClick={() => setIsConfirmOpen(true)}
								className="w-full"
							>
								{isUpdating && <Loader2 className="size-4 animate-spin" />}
								{selected.length > 0
									? `Update ${selected.map((name) => LABELS[name]).join(" and ")}`
									: "Traefik and Redis: nothing to update"}
							</Button>

							{logs && (
								<pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
									{logs}
								</pre>
							)}
						</DialogContent>
					</Dialog>
				</CardContent>
			</Card>

			{/* Opened from the row above, so the dialog's own trigger stays hidden. */}
			<UpdateServer isOpen={isWebUpdateOpen} onOpenChange={setIsWebUpdateOpen}>
				<span hidden />
			</UpdateServer>

			<AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Update {selected.map((name) => LABELS[name]).join(" and ")} on the
							panel host?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{selected.map((name) =>
								WARNINGS[name] ? (
									<span key={name} className="block">
										{WARNINGS[name]}
									</span>
								) : null,
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={startUpdate}>Update</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={isDockerConfirmOpen}
				onOpenChange={setIsDockerConfirmOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Upgrade Docker Engine to {dockerRow?.target} on the panel host?
						</AlertDialogTitle>
						<AlertDialogDescription asChild>
							<div className="flex flex-col gap-2">
								<span>
									Docker restarts, and every container on this server restarts
									with it: all sites and this panel are unavailable for a minute
									or two.
								</span>
								<span>
									The upgrade runs on the host, outside the panel. If the
									services do not come back healthy, it rolls Docker back to{" "}
									{dockerRow?.installed} by itself. Keep this window open; it
									reconnects when the panel is back.
								</span>
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setIsDockerConfirmOpen(false);
								upgradeDocker.mutate();
							}}
						>
							Upgrade Docker
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
};

export const PanelHostStack = () => {
	const { data, error, isPending, refetch } = api.settings.hostStack.useQuery(
		undefined,
		{
			refetchOnWindowFocus: false,
			staleTime: 60 * 1000,
			retry: false,
		},
	);

	if (isPending) {
		return (
			<Card className="bg-transparent">
				<CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					Checking the panel host...
				</CardContent>
			</Card>
		);
	}

	if (error) {
		if (
			error.data?.code === "UNAUTHORIZED" ||
			error.data?.code === "FORBIDDEN"
		) {
			return null;
		}
		return (
			<Card className="bg-transparent">
				<CardContent className="text-sm text-destructive">
					The panel host check failed: {error.message}
				</CardContent>
			</Card>
		);
	}

	if (!data) {
		return null;
	}

	return <PanelHostCard rows={data} refetch={refetch} />;
};
