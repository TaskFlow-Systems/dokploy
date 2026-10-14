import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
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
import { api, type RouterOutputs } from "@/utils/api";

const HARDENING_ITEMS = ["ufw", "ssh", "fail2ban"] as const;

type HardeningItem = (typeof HARDENING_ITEMS)[number];

const HARDENING_DONE = "Security hardening finished ✅";
const HARDENING_FAILED = "Security hardening failed ❌";

const ITEM_LABELS: Record<HardeningItem, { title: string; details: string }> = {
	ufw: {
		title: "UFW firewall",
		details:
			"Denies incoming traffic except SSH and HTTPS (443 tcp and udp). Port 80 stays closed.",
	},
	ssh: {
		title: "SSH: keys only",
		details:
			"Turns off password login and PAM. Root can log in with a key only.",
	},
	fail2ban: {
		title: "Fail2Ban",
		details: "Bans addresses that keep failing SSH login (aggressive mode).",
	},
};

type SecurityAuditResult = RouterOutputs["server"]["security"];

export const failingHardeningItems = (
	audit: SecurityAuditResult | undefined,
): HardeningItem[] => {
	if (!audit) {
		return [...HARDENING_ITEMS];
	}
	const failing: HardeningItem[] = [];
	if (
		!audit.ufw?.installed ||
		!audit.ufw?.active ||
		audit.ufw?.defaultIncoming !== "deny"
	) {
		failing.push("ufw");
	}
	if (audit.ssh?.passwordAuth !== "no" || audit.ssh?.usePam !== "no") {
		failing.push("ssh");
	}
	if (
		!audit.fail2ban?.installed ||
		!audit.fail2ban?.enabled ||
		!audit.fail2ban?.active ||
		audit.fail2ban?.sshEnabled !== "true" ||
		audit.fail2ban?.sshMode !== "aggressive"
	) {
		failing.push("fail2ban");
	}
	return failing;
};

interface Props {
	serverId: string;
	audit: SecurityAuditResult | undefined;
	onFinished: () => void;
}

export const HardenServer = ({ serverId, audit, onFinished }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [isRunning, setIsRunning] = useState(false);
	const [selected, setSelected] = useState<HardeningItem[]>([]);
	const [logs, setLogs] = useState("");

	api.server.hardenWithLogs.useSubscription(
		{ serverId, items: selected },
		{
			enabled: isRunning && selected.length > 0,
			onData(log) {
				setLogs((prev) => `${prev}${log}`);
				if (log.includes(HARDENING_DONE) || log.includes(HARDENING_FAILED)) {
					setIsRunning(false);
					if (log.includes(HARDENING_DONE)) {
						toast.success("Security settings applied");
					} else {
						toast.error("Security hardening failed, see the log");
					}
					onFinished();
				}
			},
			onError(err) {
				setLogs((prev) => `${prev}${err.message}\n`);
				setIsRunning(false);
				toast.error("Security hardening failed");
			},
		},
	);

	const toggle = (item: HardeningItem, checked: boolean) => {
		setSelected((prev) =>
			checked
				? HARDENING_ITEMS.filter((i) => i === item || prev.includes(i))
				: prev.filter((i) => i !== item),
		);
	};

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (open && !isRunning) {
					setSelected(failingHardeningItems(audit));
					setLogs("");
				}
				setIsOpen(open);
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline">
					<ShieldCheck className="size-4" />
					Apply hardening
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<ShieldCheck className="size-5" /> Apply security hardening
					</DialogTitle>
					<DialogDescription>
						Runs the hardening script on this server over SSH. Items that the
						check marked red are selected. The log is also saved in the server
						deployments.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					{HARDENING_ITEMS.map((item) => (
						<div key={item} className="flex items-start gap-2 text-sm">
							<Checkbox
								id={`harden-${item}-${serverId}`}
								checked={selected.includes(item)}
								disabled={isRunning}
								onCheckedChange={(checked) => toggle(item, checked === true)}
								className="mt-0.5"
							/>
							<Label
								htmlFor={`harden-${item}-${serverId}`}
								className="flex flex-col items-start gap-1"
							>
								<span>{ITEM_LABELS[item].title}</span>
								<span className="text-xs font-normal text-muted-foreground">
									{ITEM_LABELS[item].details}
								</span>
							</Label>
						</div>
					))}
				</div>

				{selected.includes("ssh") && (
					<AlertBlock type="warning">
						After this, nobody can log in to this server with a password,
						including you. Dokploy keeps working because it connects with its
						SSH key. Make sure your own key is in authorized_keys before you
						continue.
					</AlertBlock>
				)}
				{selected.includes("ufw") && (
					<p className="text-xs text-muted-foreground">
						Ports published by Docker containers bypass UFW and stay reachable.
						If this server joins a swarm with other servers, open 2377/tcp,
						7946/tcp+udp and 4789/udp between them yourself.
					</p>
				)}

				<Button
					disabled={isRunning || selected.length === 0}
					onClick={() => {
						setLogs("");
						setIsRunning(true);
					}}
					className="w-full"
				>
					{isRunning && <Loader2 className="size-4 animate-spin" />}
					{isRunning
						? "Applying..."
						: selected.length > 0
							? `Apply ${selected.length} item${selected.length > 1 ? "s" : ""}`
							: "Select at least one item"}
				</Button>

				{logs && (
					<pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
						{logs}
					</pre>
				)}
			</DialogContent>
		</Dialog>
	);
};
