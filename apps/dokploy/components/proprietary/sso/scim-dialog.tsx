"use client";

import copy from "copy-to-clipboard";
import { Copy, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import { useUrl } from "@/utils/hooks/use-url";

interface Props {
	children: ReactNode;
}

const EXPIRY_OPTIONS = [
	{ days: 90, label: "90 days" },
	{ days: 180, label: "180 days" },
	{ days: 365, label: "1 year" },
	{ days: 730, label: "2 years" },
];

const formatDate = (value: Date | string | null | undefined) =>
	value ? new Date(value).toLocaleDateString() : "—";

const shortId = (id: string) => (id.length > 28 ? `${id.slice(0, 28)}…` : id);

export const ScimDialog = ({ children }: Props) => {
	const utils = api.useUtils();
	const baseURL = useUrl();
	const [open, setOpen] = useState(false);
	const [expiresInDays, setExpiresInDays] = useState(365);
	const [issuedToken, setIssuedToken] = useState<{
		connectionId: string;
		token: string;
		expiresAt: Date | string;
	} | null>(null);

	const { data: connections = [], isPending } =
		api.scim.listConnections.useQuery(undefined, { enabled: open });
	const createConnection = api.scim.createConnection.useMutation();
	const rotateCredential = api.scim.rotateCredential.useMutation();
	const revokeCredential = api.scim.revokeCredential.useMutation();
	const decommissionConnection = api.scim.decommissionConnection.useMutation();

	const scimUrl = `${baseURL || "{baseURL}"}/api/auth/scim/v2`;

	const run = async (action: () => Promise<void>, failure: string) => {
		try {
			await action();
			await utils.scim.listConnections.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : failure);
		}
	};

	const handleCreate = () =>
		run(async () => {
			const created = await createConnection.mutateAsync({ expiresInDays });
			setIssuedToken(created);
		}, "Failed to create SCIM connection");

	const handleRotate = (connectionId: string) =>
		run(async () => {
			const rotated = await rotateCredential.mutateAsync({
				connectionId,
				expiresInDays,
			});
			setIssuedToken(rotated);
			toast.success(
				"New token issued; the previous one stays valid until revoked",
			);
		}, "Failed to rotate SCIM token");

	const handleRevoke = (connectionId: string, credentialId: string) =>
		run(async () => {
			await revokeCredential.mutateAsync({ connectionId, credentialId });
			toast.success("SCIM token revoked");
		}, "Failed to revoke SCIM token");

	const handleDecommission = (connectionId: string) =>
		run(async () => {
			const result = await decommissionConnection.mutateAsync({ connectionId });
			toast.success(
				result?.status === "complete"
					? "SCIM connection decommissioned"
					: "Decommissioning started; open this dialog again to finish it",
			);
		}, "Failed to decommission SCIM connection");

	const handleCopy = (value: string, label: string) => {
		copy(value);
		toast.success(`${label} copied`);
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) setIssuedToken(null);
	};

	const isMutating =
		createConnection.isPending ||
		rotateCredential.isPending ||
		revokeCredential.isPending ||
		decommissionConnection.isPending;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<KeyRound className="size-5" />
						SCIM provisioning
					</DialogTitle>
					<DialogDescription>
						Provision, update, and deactivate organization members from your
						identity provider (Okta, Entra ID, etc.). Deactivating a user in the
						IdP removes their access to this organization.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4 py-2">
					<div className="grid gap-1">
						<Label className="text-xs font-medium text-muted-foreground">
							SCIM 2.0 endpoint URL
						</Label>
						<div className="flex items-center gap-2">
							<p className="flex-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
								{scimUrl}
							</p>
							<Button
								variant="outline"
								size="icon"
								className="size-8 shrink-0"
								onClick={() => handleCopy(scimUrl, "Endpoint URL")}
								disabled={!baseURL}
							>
								<Copy className="size-3.5" />
							</Button>
						</div>
					</div>

					{issuedToken && (
						<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
							<p className="text-sm font-medium">
								Bearer token (expires {formatDate(issuedToken.expiresAt)})
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								Copy this token now — it will not be shown again. Paste it into
								your IdP&apos;s SCIM configuration.
							</p>
							<div className="mt-2 flex items-center gap-2">
								{/* ph-no-capture keeps the token out of session replay. */}
								<p className="ph-no-capture flex-1 break-all rounded-md bg-background px-2 py-1.5 font-mono text-xs">
									{issuedToken.token}
								</p>
								<Button
									variant="outline"
									size="icon"
									className="size-8 shrink-0"
									onClick={() => handleCopy(issuedToken.token, "Bearer token")}
								>
									<Copy className="size-3.5" />
								</Button>
							</div>
						</div>
					)}

					<div className="space-y-2">
						<Label className="text-sm font-medium">Token lifetime</Label>
						<div className="flex gap-2">
							<Select
								value={String(expiresInDays)}
								onValueChange={(value) => setExpiresInDays(Number(value))}
							>
								<SelectTrigger className="flex-1">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{EXPIRY_OPTIONS.map((option) => (
										<SelectItem key={option.days} value={String(option.days)}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button size="sm" onClick={handleCreate} disabled={isMutating}>
								<Plus className="mr-1 size-4" />
								New connection
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							Each connection belongs to this organization. Rotating issues a
							new token next to the current one, so you can switch the IdP
							without downtime.
						</p>
					</div>

					<div className="space-y-2">
						<Label className="text-sm font-medium">Connections</Label>
						{isPending ? (
							<div className="flex items-center gap-2 justify-center py-4">
								<Loader2 className="size-4 animate-spin text-muted-foreground" />
								<span className="text-sm text-muted-foreground">
									Loading...
								</span>
							</div>
						) : connections.length === 0 ? (
							<p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
								No SCIM connections yet.
							</p>
						) : (
							<ul className="flex flex-col gap-2">
								{connections.map(({ connection, credentials }) => {
									const isActive = connection.status === "active";
									return (
										<li
											key={connection.connectionId}
											className="space-y-2 rounded-md border bg-muted/30 px-3 py-2"
										>
											<div className="flex items-center gap-2">
												<span
													className="flex-1 font-mono text-xs"
													title={connection.connectionId}
												>
													{shortId(connection.connectionId)}
												</span>
												<Badge variant={isActive ? "default" : "secondary"}>
													{connection.status}
												</Badge>
												{isActive && (
													<Button
														variant="outline"
														size="sm"
														onClick={() =>
															handleRotate(connection.connectionId)
														}
														disabled={isMutating}
													>
														<RefreshCw className="mr-1 size-3.5" />
														Rotate
													</Button>
												)}
												{connection.status !== "decommissioned" && (
													<DialogAction
														title="Decommission SCIM connection"
														description="All tokens of this connection stop working and its users lose the access it granted. This cannot be undone."
														type="destructive"
														onClick={() =>
															handleDecommission(connection.connectionId)
														}
													>
														<Button
															variant="ghost"
															size="icon"
															className="size-8 shrink-0 text-destructive hover:text-destructive"
															disabled={isMutating}
														>
															<Trash2 className="size-3.5" />
														</Button>
													</DialogAction>
												)}
											</div>
											<ul className="space-y-1">
												{credentials.map((credential) => (
													<li
														key={credential.credentialId}
														className="flex items-center gap-2 text-xs text-muted-foreground"
													>
														<span
															className="flex-1 font-mono"
															title={credential.credentialId}
														>
															{shortId(credential.credentialId)}
														</span>
														<span>{credential.status}</span>
														<span>
															expires {formatDate(credential.expiresAt)}
														</span>
														<span>
															last used {formatDate(credential.lastUsedAt)}
														</span>
														{credential.status === "active" && (
															<DialogAction
																title="Revoke SCIM token"
																description="Requests that use this token are rejected from now on."
																type="destructive"
																onClick={() =>
																	handleRevoke(
																		connection.connectionId,
																		credential.credentialId,
																	)
																}
															>
																<Button
																	variant="ghost"
																	size="sm"
																	className="h-6 px-2 text-destructive hover:text-destructive"
																	disabled={isMutating}
																>
																	Revoke
																</Button>
															</DialogAction>
														)}
													</li>
												))}
											</ul>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
