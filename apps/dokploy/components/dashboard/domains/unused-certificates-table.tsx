import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";
import {
	CountBadge,
	DnsCell,
	LastErrorCell,
	type UnusedCertificate,
} from "./shared";

const HIDDEN_HINT = "Hidden without a super session";

const labelOf = (item: UnusedCertificate) => item.main ?? item.names[0] ?? "";

const ExpiryCell = ({ item }: { item: UnusedCertificate }) => {
	const { certificate } = item;
	const date = certificate.validTo.slice(0, 10);
	const toneClassName =
		certificate.daysLeft < 0 || certificate.tone === "critical"
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

const DeleteDialog = ({
	items,
	onClose,
}: {
	items: UnusedCertificate[] | null;
	onClose: () => void;
}) => {
	const utils = api.useUtils();
	const [typed, setTyped] = useState("");
	const { mutateAsync, isPending } =
		api.domainOverview.deleteUnusedCertificates.useMutation();

	const expected = items?.length === 1 ? labelOf(items[0]!) : "delete";
	const first = items?.[0];

	const submit = async () => {
		if (!items || !first) {
			return;
		}
		try {
			const result = await mutateAsync({
				serverId: first.serverId,
				domains: items.map((item) => ({
					domain: labelOf(item),
					resolver: item.resolver,
				})),
			});
			if (result.status === "refused") {
				toast.error(
					result.refused
						.map((item) => `${item.domain}: ${item.message}`)
						.join("\n"),
				);
				await utils.domainOverview.list.invalidate();
				return;
			}
			const backup = result.backupFile
				? ` Backup file: ${result.backupFile}.`
				: "";
			if (result.status === "failed") {
				toast.error(`${result.message}${backup}`);
			} else if (result.status === "started") {
				toast.info(`${result.message}${backup}`);
			} else {
				toast.success(`${result.message}${backup}`);
			}
			setTyped("");
			onClose();
			await utils.domainOverview.list.invalidate();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "The deletion failed",
			);
		}
	};

	return (
		<AlertDialog
			open={items !== null}
			onOpenChange={(open) => {
				if (!open && !isPending) {
					setTyped("");
					onClose();
				}
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete unused certificates</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="flex flex-col gap-3 text-sm">
							<ul className="list-disc pl-5 font-mono text-xs break-all">
								{items?.map((item) => (
									<li key={item.key}>{labelOf(item)}</li>
								))}
							</ul>
							<p>
								A backup of the certificate file is made. Traefik restarts once,
								sites on {first?.serverName} are unavailable for a few seconds.
								No site uses these certificates.
							</p>
							<p>
								Type <span className="font-mono font-semibold">{expected}</span>{" "}
								to confirm.
							</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<Input
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					autoComplete="off"
				/>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
					<Button
						variant="destructive"
						disabled={typed.trim() !== expected || isPending}
						isLoading={isPending}
						onClick={submit}
					>
						Delete
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
};

export const UnusedCertificatesTable = ({
	items,
	certificatesVisible,
}: {
	items: UnusedCertificate[];
	certificatesVisible: boolean;
}) => {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<UnusedCertificate[] | null>(null);

	const chosen = useMemo(
		() => items.filter((item) => selected.has(item.key) && item.deletable),
		[items, selected],
	);
	const servers = new Set(chosen.map((item) => item.serverId ?? "local"));
	const canDeleteSelected =
		certificatesVisible && chosen.length > 0 && servers.size === 1;

	const toggle = (key: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<h3 className="text-lg font-semibold">Unused certificates</h3>
					<CountBadge count={items.length} />
				</div>
				<div className="flex items-center gap-3">
					{servers.size > 1 && (
						<span className="text-xs text-muted-foreground">
							Select certificates from one server at a time
						</span>
					)}
					{!certificatesVisible && (
						<span className="text-xs text-muted-foreground">{HIDDEN_HINT}</span>
					)}
					<Button
						variant="destructive"
						size="sm"
						disabled={!canDeleteSelected}
						onClick={() => setPending(chosen)}
					>
						<Trash2 className="size-4" />
						Delete selected
					</Button>
				</div>
			</div>
			<p className="text-sm text-muted-foreground">
				An unused certificate is stored in Traefik's certificate file, but no
				route, panel domain or Traefik config file uses its domain. Traefik
				keeps trying to renew it every day and logs an error when that fails.
				Deleting it does not affect any site.
			</p>
			<div className="overflow-x-auto rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-10" />
							<TableHead>Domain</TableHead>
							<TableHead>Server</TableHead>
							<TableHead>Stored in</TableHead>
							<TableHead>DNS</TableHead>
							<TableHead>Expiry</TableHead>
							<TableHead>Last Traefik error</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{!certificatesVisible ? (
							<TableRow>
								<TableCell
									colSpan={8}
									className="text-center text-muted-foreground"
								>
									{HIDDEN_HINT}
								</TableCell>
							</TableRow>
						) : items.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={8}
									className="text-center text-muted-foreground"
								>
									No unused certificates.
								</TableCell>
							</TableRow>
						) : (
							items.map((item) => (
								<TableRow key={item.key} className="align-top">
									<TableCell>
										<Checkbox
											checked={selected.has(item.key)}
											disabled={!item.deletable}
											onCheckedChange={() => toggle(item.key)}
											aria-label={`Select ${labelOf(item)}`}
										/>
									</TableCell>
									<TableCell className="font-mono text-sm break-all">
										<div className="flex flex-col gap-1">
											<span>{labelOf(item)}</span>
											{item.names
												.filter((name) => name !== item.main)
												.map((name) => (
													<span
														key={name}
														className="text-xs text-muted-foreground"
													>
														{name}
													</span>
												))}
										</div>
									</TableCell>
									<TableCell>
										<div className="flex flex-col gap-1 text-sm">
											<span>{item.serverName}</span>
											{item.isLocal && <Badge variant="blank">Local</Badge>}
										</div>
									</TableCell>
									<TableCell>
										<div className="flex flex-col gap-1 text-xs">
											<span className="font-mono break-all">
												{item.storagePath}
											</span>
											<span className="text-muted-foreground">
												resolver {item.resolver}
											</span>
										</div>
									</TableCell>
									<TableCell>
										<DnsCell dns={item.dns} />
									</TableCell>
									<TableCell>
										<ExpiryCell item={item} />
									</TableCell>
									<TableCell>
										<LastErrorCell
											error={item.lastError}
											logAvailable={item.logAvailable}
										/>
									</TableCell>
									<TableCell>
										<Button
											variant="outline"
											size="sm"
											disabled={!item.deletable}
											onClick={() => setPending([item])}
										>
											<Trash2 className="size-4" />
											Delete
										</Button>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>
			<DeleteDialog
				items={pending}
				onClose={() => {
					setPending(null);
					setSelected(new Set());
				}}
			/>
		</div>
	);
};
