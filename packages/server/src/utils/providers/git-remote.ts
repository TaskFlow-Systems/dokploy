// Pure helpers (no imports) that turn a Custom Git URL into the credential-free
// facts the Deployments tab needs to link to a repository's webhook settings.
// The browser cannot read `customGitUrl` (the API redacts it), so the server
// calls `parseGitRemote` and sends only the result, which never carries the
// user, password, token, query or fragment of the original URL.

export interface GitRemote {
	scheme: "http" | "https" | "ssh";
	host: string;
	/** Port of the web UI, known only when the URL is http(s). */
	webPort: number | null;
	/** SSH port, known only when the URL is ssh or scp-style (null = default). */
	sshPort: number | null;
	/** `owner/repo` or `group/subgroup/project`, without `.git`. */
	path: string;
}

// SSH-over-443 hosts that serve the same repositories as the main site.
const HOST_ALIASES: Record<string, string> = {
	"ssh.github.com": "github.com",
	"altssh.gitlab.com": "gitlab.com",
	"altssh.bitbucket.org": "bitbucket.org",
};

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

const cleanPath = (raw: string): string | null => {
	let path = raw.replace(/^\/+|\/+$/g, "");
	path = path.replace(/\.git$/i, "");
	if (!path) {
		return null;
	}
	const segments = path.split("/");
	if (
		segments.length < 2 ||
		segments.some((s) => !SEGMENT_RE.test(s) || s === "." || s === "..")
	) {
		return null;
	}
	return path;
};

const cleanHost = (raw: string): string | null => {
	const host = raw.toLowerCase();
	if (!HOST_RE.test(host)) {
		return null;
	}
	return HOST_ALIASES[host] ?? host;
};

const toPort = (raw: string | undefined): number | null => {
	if (!raw) {
		return null;
	}
	const port = Number(raw);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
};

export const parseGitRemote = (
	input: string | null | undefined,
): GitRemote | null => {
	const value = input?.trim();
	if (!value) {
		return null;
	}

	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
	if (scheme) {
		if (scheme !== "http" && scheme !== "https" && scheme !== "ssh") {
			return null;
		}
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return null;
		}
		const host = cleanHost(url.hostname);
		const path = cleanPath(decodeURIComponent(url.pathname));
		if (!host || !path) {
			return null;
		}
		const port = toPort(url.port);
		return {
			scheme,
			host,
			webPort: scheme === "ssh" ? null : port,
			sshPort: scheme === "ssh" ? port : null,
			path,
		};
	}

	// scp-style: [user@]host:owner/repo.git
	const scp = /^(?:[^@/\s]+@)?([^:/\s@]+):(?!\/)(\S+)$/.exec(value);
	if (!scp?.[1] || !scp[2]) {
		return null;
	}
	const host = cleanHost(scp[1]);
	const path = cleanPath(scp[2]);
	if (!host || !path) {
		return null;
	}
	return { scheme: "ssh", host, webPort: null, sshPort: null, path };
};

export type WebhookProvider =
	| "github"
	| "gitlab"
	| "gitea"
	| "bitbucket"
	| "softserve"
	| "unknown";

export const SOFT_SERVE_DEFAULT_SSH_PORT = 23231;

export const detectWebhookProvider = (remote: GitRemote): WebhookProvider => {
	const host = remote.host;
	if (host === "github.com") return "github";
	if (host === "gitlab.com") return "gitlab";
	if (host === "bitbucket.org") return "bitbucket";
	if (host === "codeberg.org") return "gitea";
	if (
		remote.sshPort === SOFT_SERVE_DEFAULT_SSH_PORT ||
		host.includes("softserve") ||
		host.includes("soft-serve")
	) {
		return "softserve";
	}
	if (host.includes("github")) return "github";
	if (host.includes("gitlab")) return "gitlab";
	if (host.includes("gitea") || host.includes("forgejo")) return "gitea";
	return "unknown";
};

export interface WebhookHelp {
	provider: WebhookProvider;
	title: string;
	/** Page of the repository where the webhook is added; null when unknown. */
	settingsUrl: string | null;
	docsUrl: string | null;
	steps: string[];
	/** Ready-to-copy command (Soft Serve); holds a `<secret>` placeholder. */
	command: string | null;
}

const webBase = (remote: GitRemote) => {
	const scheme = remote.scheme === "http" ? "http" : "https";
	const port = remote.webPort ? `:${remote.webPort}` : "";
	return `${scheme}://${remote.host}${port}`;
};

export const buildWebhookHelp = (
	remote: GitRemote,
	webhookUrl: string,
): WebhookHelp => {
	const provider = detectWebhookProvider(remote);
	const base = webBase(remote);
	const repoUrl = `${base}/${remote.path}`;
	switch (provider) {
		case "github":
			return {
				provider,
				title: "GitHub",
				settingsUrl: `${repoUrl}/settings/hooks/new`,
				docsUrl:
					"https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks#creating-a-repository-webhook",
				steps: [
					"Open the link below (Settings > Webhooks > Add webhook).",
					`Payload URL: ${webhookUrl}`,
					"Content type: application/json",
					"Secret: the webhook secret above",
					"Events: Just the push event, then Add webhook.",
				],
				command: null,
			};
		case "gitlab":
			return {
				provider,
				title: "GitLab",
				settingsUrl: `${repoUrl}/-/hooks`,
				docsUrl: "https://docs.gitlab.com/user/project/integrations/webhooks/",
				steps: [
					"Open the link below (Settings > Webhooks > Add new webhook).",
					`URL: ${webhookUrl}`,
					"Secret token: the webhook secret above",
					"Trigger: Push events, then Add webhook.",
				],
				command: null,
			};
		case "gitea":
			return {
				provider,
				title: "Gitea / Forgejo",
				settingsUrl: `${repoUrl}/settings/hooks`,
				docsUrl: "https://forgejo.org/docs/latest/user/webhooks/",
				steps: [
					"Open the link below (Settings > Webhooks > Add Webhook).",
					`Target URL: ${webhookUrl}`,
					"POST Content Type: application/json",
					"Secret: the webhook secret above",
					"Trigger On: Push Events, then Add Webhook.",
				],
				command: null,
			};
		case "bitbucket":
			return {
				provider,
				title: "Bitbucket",
				settingsUrl: `${repoUrl}/admin/webhooks`,
				docsUrl:
					"https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/",
				steps: [
					"Open the link below (Repository settings > Webhooks > Add webhook).",
					"Title: anything, for example Dokploy",
					`URL: ${webhookUrl}`,
					"Secret: the webhook secret above",
					"Triggers: Repository push, then Save.",
				],
				command: null,
			};
		case "softserve": {
			const repo = remote.path.split("/").pop() ?? remote.path;
			const port =
				remote.sshPort && remote.sshPort !== 22 ? `-p ${remote.sshPort} ` : "";
			return {
				provider,
				title: "Soft Serve",
				settingsUrl: null,
				docsUrl: null,
				steps: [
					"Soft Serve has no web UI. Run this command with your SSH access, replacing <secret> with the webhook secret above:",
				],
				command: `ssh ${port}${remote.host} repo webhook create ${repo} ${webhookUrl} -e push -s <secret>`,
			};
		}
		default:
			return {
				provider,
				title: "Your git host",
				settingsUrl: null,
				docsUrl: null,
				steps: [
					"Add a webhook in the repository settings of your git host.",
					`URL: ${webhookUrl}`,
					"Content type: application/json",
					"Secret: the webhook secret above",
					"Event: push.",
				],
				command: null,
			};
	}
};
