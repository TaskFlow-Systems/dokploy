import {
	buildWebhookHelp,
	detectWebhookProvider,
	parseGitRemote,
} from "@dokploy/server/utils/providers/git-remote";
import { redactDeployableServiceSecrets } from "@dokploy/server/utils/security/redaction";
import { describe, expect, it } from "vitest";

const URL_ = "https://panel.example.com/api/deploy/tok";
const link = (u: string) => buildWebhookHelp(parseGitRemote(u)!, URL_);

describe("parseGitRemote", () => {
	it("parses http and https, with and without .git", () => {
		expect(parseGitRemote("https://github.com/o/r.git")).toMatchObject({
			scheme: "https",
			host: "github.com",
			path: "o/r",
		});
		expect(parseGitRemote("http://git.local/o/r")).toMatchObject({
			scheme: "http",
			path: "o/r",
		});
	});

	it("keeps the web port of http(s) and the ssh port of ssh", () => {
		expect(parseGitRemote("https://git.local:8443/o/r.git")?.webPort).toBe(
			8443,
		);
		const ssh = parseGitRemote("ssh://git@git.local:2222/o/r.git");
		expect(ssh).toMatchObject({ sshPort: 2222, webPort: null });
	});

	it("parses scp-style urls", () => {
		expect(parseGitRemote("git@github.com:owner/repo.git")).toMatchObject({
			host: "github.com",
			path: "owner/repo",
			scheme: "ssh",
		});
	});

	it("maps SSH-over-443 hosts to the main site", () => {
		expect(parseGitRemote("ssh://git@ssh.github.com:443/o/r.git")?.host).toBe(
			"github.com",
		);
		expect(parseGitRemote("git@altssh.gitlab.com:g/p.git")?.host).toBe(
			"gitlab.com",
		);
	});

	it("never carries credentials", () => {
		const r = parseGitRemote("https://user:s3cret@github.com/o/r.git?x=1#f");
		expect(JSON.stringify(r)).not.toMatch(/s3cret|user|x=1/);
		expect(parseGitRemote("https://oauth2:tok@gitlab.com/g/p")?.host).toBe(
			"gitlab.com",
		);
	});

	it("rejects what it cannot link safely", () => {
		for (const bad of [
			"",
			null,
			"ftp://h/o/r",
			"https://github.com/onlyone",
			"https://github.com/o/r<script>",
			"https://github.com/o/../r",
			"not a url",
		]) {
			expect(parseGitRemote(bad as string | null)).toBeNull();
		}
	});
});

describe("buildWebhookHelp", () => {
	it("GitHub", () => {
		const h = link("git@github.com:owner/repo.git");
		expect(h.settingsUrl).toBe(
			"https://github.com/owner/repo/settings/hooks/new",
		);
		expect(h.docsUrl).toContain(
			"creating-webhooks#creating-a-repository-webhook",
		);
		expect(h.steps.join("\n")).toContain("application/json");
		expect(h.steps.join("\n")).toContain(URL_);
	});

	it("GitLab with subgroups and a self-hosted host with a port", () => {
		expect(link("https://gitlab.com/a/b/c/p.git").settingsUrl).toBe(
			"https://gitlab.com/a/b/c/p/-/hooks",
		);
		expect(link("https://gitlab.corp.io:8443/a/b.git").settingsUrl).toBe(
			"https://gitlab.corp.io:8443/a/b/-/hooks",
		);
		expect(link("ssh://git@altssh.gitlab.com:443/a/b.git").settingsUrl).toBe(
			"https://gitlab.com/a/b/-/hooks",
		);
	});

	it("Gitea, Forgejo and Codeberg", () => {
		expect(link("https://codeberg.org/o/r.git").settingsUrl).toBe(
			"https://codeberg.org/o/r/settings/hooks",
		);
		expect(link("git@forgejo.example.com:o/r.git").settingsUrl).toBe(
			"https://forgejo.example.com/o/r/settings/hooks",
		);
		expect(link("https://gitea.example.com/o/r").provider).toBe("gitea");
	});

	it("Bitbucket", () => {
		expect(link("git@bitbucket.org:ws/repo.git").settingsUrl).toBe(
			"https://bitbucket.org/ws/repo/admin/webhooks",
		);
	});

	it("Soft Serve gets a ready command with the real repo and url", () => {
		const h2 = link("ssh://git.example.com:23231/team/myrepo.git");
		expect(h2.provider).toBe("softserve");
		expect(h2.settingsUrl).toBeNull();
		expect(h2.command).toBe(
			`ssh -p 23231 git.example.com repo webhook create myrepo ${URL_} -e push -s <secret>`,
		);
	});

	it("unknown hosts get text and no link", () => {
		const h = link("https://git.example.com/o/r.git");
		expect(
			detectWebhookProvider(parseGitRemote("https://git.example.com/o/r")!),
		).toBe("unknown");
		expect(h.settingsUrl).toBeNull();
		expect(h.docsUrl).toBeNull();
		expect(h.steps.length).toBeGreaterThan(0);
	});

	it("never puts the secret into a link", () => {
		const h = link("https://github.com/o/r.git");
		expect(`${h.settingsUrl}${h.docsUrl}`).not.toMatch(/secret/i);
	});
});

describe("redacted service output", () => {
	it("keeps customGitUrl redacted but gives the browser a safe remote", () => {
		const out = redactDeployableServiceSecrets({
			customGitUrl: "ssh://git@ssh.github.com:443/o/r.git",
		}) as unknown as { customGitRemote: unknown };
		expect(out.customGitRemote).toMatchObject({
			host: "github.com",
			path: "o/r",
		});
		const withToken = redactDeployableServiceSecrets({
			customGitUrl: "https://user:tok3n@github.com/o/r.git",
		}) as unknown as { customGitRemote: unknown };
		expect(JSON.stringify(withToken.customGitRemote)).not.toContain("tok3n");
	});
});
