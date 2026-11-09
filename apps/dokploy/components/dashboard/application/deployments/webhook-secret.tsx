import {
	buildWebhookHelp,
	type GitRemote,
	parseGitRemote,
} from "@dokploy/server/utils/providers/git-remote";
import copy from "copy-to-clipboard";
import { Copy, ExternalLink, KeyRound, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

const HIDDEN_SECRET = "__DOKPLOY_REDACTED_SECRET__";

interface Props {
	id: string;
	type: "application" | "compose";
	/** The real webhook URL once revealed; null while the token is hidden. */
	webhookUrl?: string | null;
}

// Sources whose webhooks the panel checks with this secret: Custom Git has no
// provider row, Bitbucket and Soft Serve send a signature but have no panel-side
// credentials. GitHub, GitLab and Gitea keep the secret of their provider.
const HELP: Record<string, string> = {
	git: "Custom Git: paste the secret into the webhook of any GitHub, GitLab, Gitea or Forgejo mirror (Secret / Secret token field), or into the webhook of Bitbucket or Soft Serve (ssh <host> repo webhook create <repo> <url> -e push -s <secret>). The panel accepts GitHub's X-Hub-Signature-256, GitLab's X-Gitlab-Token, Gitea's X-Gitea-Signature, Bitbucket's X-Hub-Signature and Soft Serve's X-SoftServe-Signature. Without a secret these webhooks are refused.",
	bitbucket:
		"Bitbucket: paste the secret into the Secret field of the repository webhook (Repository settings > Webhooks). Bitbucket signs each request in X-Hub-Signature. Without a secret its webhooks are refused.",
};

export const WebhookSecret = ({ id, type, webhookUrl = null }: Props) => {
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

	// The API redacts `customGitUrl`, so the server sends the parsed, credential
	// free `customGitRemote`; Bitbucket sources carry owner and slug instead.
	const remote = useMemo<GitRemote | null>(() => {
		if (!service) return null;
		if (service.sourceType === "git") {
			return (
				(service as { customGitRemote?: GitRemote | null }).customGitRemote ??
				null
			);
		}
		if (service.sourceType === "bitbucket") {
			const s = service as {
				bitbucketOwner?: string | null;
				bitbucketRepositorySlug?: string | null;
				bitbucketRepository?: string | null;
			};
			const repo = s.bitbucketRepositorySlug || s.bitbucketRepository;
			return s.bitbucketOwner && repo
				? parseGitRemote(`https://bitbucket.org/${s.bitbucketOwner}/${repo}`)
				: null;
		}
		return null;
	}, [service]);
	const helpBlock = useMemo(
		() =>
			remote
				? buildWebhookHelp(remote, webhookUrl ?? "<webhook URL above>")
				: null,
		[remote, webhookUrl],
	);

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
			{helpBlock && (
				<div
					className="flex flex-col gap-1 rounded-md border p-3"
					data-testid="webhook-help"
				>
					<span className="font-medium">
						Add the webhook on {helpBlock.title}
					</span>
					<ol className="list-decimal pl-5 text-muted-foreground break-all">
						{helpBlock.steps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
					{helpBlock.command && (
						<code className="rounded bg-muted p-2 text-xs break-all">
							{helpBlock.command}
						</code>
					)}
					<div className="flex flex-row gap-4 flex-wrap">
						{helpBlock.settingsUrl && (
							<a
								href={helpBlock.settingsUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-primary underline"
							>
								Open the webhook settings of this repository
								<ExternalLink className="h-3 w-3" />
							</a>
						)}
						{helpBlock.docsUrl && (
							<a
								href={helpBlock.docsUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-primary underline"
							>
								Documentation
								<ExternalLink className="h-3 w-3" />
							</a>
						)}
					</div>
				</div>
			)}
		</div>
	);
};
