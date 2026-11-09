import copy from "copy-to-clipboard";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

const HIDDEN_SECRET = "__DOKPLOY_REDACTED_SECRET__";

interface Props {
	id: string;
	type: "application" | "compose";
}

// Sources whose webhooks the panel checks with this secret: Custom Git has no
// provider row, Bitbucket and Soft Serve send a signature but have no panel-side
// credentials. GitHub, GitLab and Gitea keep the secret of their provider.
const HELP: Record<string, string> = {
	git: "Custom Git: paste the secret into the webhook of any GitHub, GitLab, Gitea or Forgejo mirror (Secret / Secret token field), or into the webhook of Bitbucket or Soft Serve (ssh <host> repo webhook create <repo> <url> -e push -s <secret>). The panel accepts GitHub's X-Hub-Signature-256, GitLab's X-Gitlab-Token, Gitea's X-Gitea-Signature, Bitbucket's X-Hub-Signature and Soft Serve's X-SoftServe-Signature. Without a secret these webhooks are refused.",
	bitbucket:
		"Bitbucket: paste the secret into the Secret field of the repository webhook (Repository settings > Webhooks). Bitbucket signs each request in X-Hub-Signature. Without a secret its webhooks are refused.",
};

export const WebhookSecret = ({ id, type }: Props) => {
	const utils = api.useUtils();
	const application = api.application.one.useQuery(
		{ applicationId: id },
		{ enabled: type === "application" },
	);
	const compose = api.compose.one.useQuery(
		{ composeId: id },
		{ enabled: type === "compose" },
	);
	const service = type === "application" ? application.data : compose.data;
	const sourceType = service?.sourceType;

	const [secret, setSecret] = useState<string | null>(null);
	const revealApp = api.application.revealWebhookSecret.useMutation();
	const revealCompose = api.compose.revealWebhookSecret.useMutation();
	const regenApp = api.application.regenerateWebhookSecret.useMutation();
	const regenCompose = api.compose.regenerateWebhookSecret.useMutation();
	const removeApp = api.application.removeWebhookSecret.useMutation();
	const removeCompose = api.compose.removeWebhookSecret.useMutation();

	if (!service || !sourceType || !(sourceType in HELP)) {
		return null;
	}

	const isSet = service.webhookSecret === HIDDEN_SECRET;
	const help = HELP[sourceType];

	const refresh = async () => {
		if (type === "application") {
			await utils.application.one.invalidate({ applicationId: id });
		} else {
			await utils.compose.one.invalidate({ composeId: id });
		}
	};

	const generate = async () => {
		try {
			const answer =
				type === "compose"
					? await regenCompose.mutateAsync({ composeId: id })
					: await regenApp.mutateAsync({ applicationId: id });
			setSecret(answer.webhookSecret);
			await refresh();
			toast.success("Webhook secret generated. Paste it into the webhook.");
		} catch {
			toast.error("Error generating the webhook secret");
		}
	};

	const copySecret = async () => {
		let value = secret;
		if (value === null) {
			try {
				const answer =
					type === "compose"
						? await revealCompose.mutateAsync({ composeId: id })
						: await revealApp.mutateAsync({ applicationId: id });
				value = answer.webhookSecret ?? "";
				setSecret(value);
			} catch {
				toast.error("You are not allowed to see the webhook secret.");
				return;
			}
		}
		copy(value);
		toast.success("Copied to clipboard.");
	};

	const remove = async () => {
		try {
			if (type === "compose") {
				await removeCompose.mutateAsync({ composeId: id });
			} else {
				await removeApp.mutateAsync({ applicationId: id });
			}
			setSecret(null);
			await refresh();
			toast.success("Webhook secret removed");
		} catch {
			toast.error("Error removing the webhook secret");
		}
	};

	return (
		<div className="flex flex-col gap-2 text-sm">
			<div className="flex flex-row items-center gap-2 flex-wrap">
				<span>Webhook secret: </span>
				{isSet ? (
					<>
						<Button
							type="button"
							variant="outline"
							size="sm"
							aria-label="Copy webhook secret to clipboard"
							onClick={copySecret}
						>
							{secret ?? "••••••••••••••••"}
							<Copy className="h-4 w-4 ml-2" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label="Generate a new webhook secret"
							onClick={generate}
						>
							<KeyRound className="h-4 w-4" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label="Remove the webhook secret"
							onClick={remove}
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					</>
				) : (
					<Button type="button" variant="outline" size="sm" onClick={generate}>
						<KeyRound className="h-4 w-4 mr-2" />
						Generate secret
					</Button>
				)}
			</div>
			{help && <span className="text-muted-foreground">{help}</span>}
		</div>
	);
};
