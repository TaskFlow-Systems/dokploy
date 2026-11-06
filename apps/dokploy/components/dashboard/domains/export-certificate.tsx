import { Copy, Download, FileKey } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

type Props = {
	domain: string;
	serverId: string | null;
};

const PARTS = [
	{
		key: "certificate",
		label: "Certificate",
		suffix: "cert.pem",
		hint: "The domain's own certificate.",
	},
	{
		key: "chain",
		label: "Certificate chain",
		suffix: "chain.pem",
		hint: "Intermediate certificates of Let's Encrypt.",
	},
	{
		key: "privateKey",
		label: "Private key",
		suffix: "privkey.pem",
		hint: "PKCS#8, unencrypted. Keep it secret.",
	},
	{
		key: "fullchain",
		label: "Full chain",
		suffix: "fullchain.pem",
		hint: "Certificate and chain in one file, for nginx and similar.",
	},
] as const;

const saveFile = (name: string, content: string) => {
	const url = URL.createObjectURL(
		new Blob([content], { type: "application/x-pem-file" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	URL.revokeObjectURL(url);
};

export const ExportCertificate = ({ domain, serverId }: Props) => {
	const [open, setOpen] = useState(false);
	const { mutate, data, error, isPending, reset } =
		api.domainOverview.exportCertificate.useMutation();

	const fileBase = domain.replace(/[^a-zA-Z0-9.-]/g, "_");

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					mutate({ domain, serverId });
				} else {
					reset();
				}
			}}
		>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="group hover:bg-blue-500/10"
					title="Download certificate"
				>
					<FileKey className="size-4 text-primary group-hover:text-blue-500" />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Certificate of {domain}</DialogTitle>
					<DialogDescription>
						The Let's Encrypt certificate Traefik holds for this domain, to
						import into a load balancer, CDN or certificate store.
					</DialogDescription>
				</DialogHeader>
				{isPending && (
					<span className="text-sm text-muted-foreground">Reading…</span>
				)}
				{error && <AlertBlock type="error">{error.message}</AlertBlock>}
				{data && (
					<div className="flex flex-col gap-4">
						<span className="text-sm text-muted-foreground">
							{data.names.join(", ")} · {data.issuer} · valid until{" "}
							{data.validTo.slice(0, 10)} · {data.serverName}
						</span>
						{PARTS.map((part) => {
							const value = data[part.key];
							return (
								<div key={part.key} className="flex flex-col gap-2">
									<div className="flex items-center justify-between gap-2">
										<div className="flex flex-col">
											<span className="text-sm font-medium">{part.label}</span>
											<span className="text-xs text-muted-foreground">
												{part.hint}
											</span>
										</div>
										<div className="flex gap-1">
											<Button
												variant="outline"
												size="sm"
												disabled={!value}
												onClick={async () => {
													await navigator.clipboard.writeText(value);
													toast.success(`${part.label} copied`);
												}}
											>
												<Copy className="size-3.5" />
												Copy
											</Button>
											<Button
												variant="outline"
												size="sm"
												disabled={!value}
												onClick={() =>
													saveFile(`${fileBase}.${part.suffix}`, value)
												}
											>
												<Download className="size-3.5" />
												Download
											</Button>
										</div>
									</div>
									<Textarea
										readOnly
										value={
											value || "Empty: the certificate came without a chain."
										}
										className="font-mono text-xs h-28"
									/>
								</div>
							);
						})}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
};
