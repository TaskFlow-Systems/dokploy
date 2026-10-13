import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCommand } from "@dokploy/server/setup/server-setup";
import {
	buildProbeShieldInstallStep,
	createDefaultProbeShield,
	getDefaultProbeShield,
	PROBE_SHIELD_FILE,
	PROBE_SHIELD_PRIORITY,
} from "@dokploy/server/setup/traefik-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const generated = () => parse(getDefaultProbeShield());

// The rule uses only syntax that Go's RE2 and JavaScript read the same way, so the
// path cases below can run without Traefik. The real-Traefik run is in the PR.
// The parts are read back out of the generated rule, not taken from the constants,
// so the test checks what is really written to the file.
const RULE_SHAPE =
	/^PathRegexp\(`([^`]+)`\) && \(!PathRegexp\(`([^`]+)`\) \|\| PathRegexp\(`([^`]+)`\)\) && \(!PathRegexp\(`([^`]+)`\) \|\| PathRegexp\(`([^`]+)`\)\)$/;

const ruleParts = () => {
	const match = generated().http.routers["probe-shield"].rule.match(RULE_SHAPE);
	if (!match) {
		throw new Error("The shield rule does not have the expected shape");
	}
	return match
		.slice(1)
		.map((source: string) => new RegExp(source.replace(/^\(\?i\)/, ""), "i"));
};

const [secret, exempt, encodedSeparator, apiFiles, traversal] = ruleParts() as [
	RegExp,
	RegExp,
	RegExp,
	RegExp,
	RegExp,
];

const isBlocked = (requestPath: string) =>
	secret.test(requestPath) &&
	(!exempt.test(requestPath) || encodedSeparator.test(requestPath)) &&
	(!apiFiles.test(requestPath) || traversal.test(requestPath));

const PANEL_API_DIR = path.resolve(__dirname, "../../pages/api");

const panelApiRoutes = (dir = PANEL_API_DIR): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return panelApiRoutes(full);
		}
		const route = path
			.relative(path.resolve(PANEL_API_DIR, ".."), full)
			.replace(/\.[tj]sx?$/, "")
			.replace(/\/index$/, "")
			.replace(/\[\.\.\.[^\]]+\]/g, "a/b")
			.replace(/\[[^\]]+\]/g, "0a1b2c3d4e");
		return [`/${route}`];
	});

const BLOCKED = [
	"/.env",
	"/.ENV",
	"/.env.local",
	"/.env.production",
	"/.env.development",
	"/.env.backup",
	"/.env.bak",
	"/.env.old",
	"/.env.save",
	"/.env.example",
	"/api/.env",
	"/config/.env",
	"/backend/.env",
	"/app/.env",
	"/admin/.env",
	"/api/.env.local",
	"/.env/public/.env",
	"/.git/config",
	"/app/.GIT/HEAD",
	"/.aws/credentials",
	"/.aws/config",
	"/.docker/config.json",
	"/.ssh/id_rsa",
	"/.svn/entries",
	"/.hg/hgrc",
	"/.kube/config",
	"/.git-credentials",
	"/.gitconfig",
	"/.DS_Store",
	"/sub/.ds_store",
	"/.htpasswd",
	"/.htaccess",
	"/.npmrc",
	"/.netrc",
	"/.pgpass",
	"/.bash_history",
	"/.git",
	"/proc/self/environ",
	"/static/..%2F..%2F..%2F..%2Fproc/self/environ",
	"/uploads/..%2F..%2F.env",
	"/uploads/..%2f..%2f.env",
	"/uploads/..%5C..%5C.env",
	"/uploads/..\\..\\.env",
	"/x/..%2F.git%2Fconfig",
	"/.git/HEAD",
	"/project/.git/config",
	"/project/.git/HEAD",
	"/x/.git/info/refs",
	"/x/.git/git-upload-pack",
	"/x/.git/git-receive-pack",
	"/src/.env",
	"/raw/.env",
	"/blob/.env",
	"/media/.env",
	"/owner/repo/.git/config",
	"/owner/repo/.env",
	"/owner/repo/src/.env",
	"/owner/repo/raw/.env",
	"/owner/repo/blob/main/.env",
	"/owner/repo/src/main/.env",
	"/owner/repo/src/branch/.env",
	"/owner/repo/raw/branch/.env",
	"/owner/repo/src/branch/main/..%2F..%2F.env",
	"/owner/repo/raw/branch/main/..%2F..%2F..%2F.git%2Fconfig",
	"/owner/repo/src/branch/main/..%5C.env",
	"/owner/repo/src/branch/main/..\\.env",
	"/owner/repo/src/branch/main/x%2F.env",
	"/owner/repo/src/branch/main/x%5C.env",
	"/.env/repo/src/branch/main/file",
	"/api/v1/repos/owner/repo/contents/..%2F..%2F.env",
	"/api/v1/repos/owner/repo/.git/config",
	"/api/v4/projects/1/repository/files/..%2F..%2F.env",
	"/api/v4/projects/1/repository/files/a%2F..%2F..%2F.env",
	"/api/v4/projects/1/repository/files/..%2F.git%2Fconfig",
	"/api/v4/projects/1/repository/tree/.env",
	"/group/project/-/blob/main/..%2F.env",
	"/group/project/-/blob/.env",
	"/-/blob/main/.env",
	"/-/ide/project/..%2F.env",
	"/remote.php/.env",
	"/remote.php/dav/files/u/..%2F.env",
	"/x/remote.php/dav/files/u/.env",
	"/other.php/dav/files/u/.env",
	"/dav/files/u/.env",
	"/static/other/files/config%2F.env",
];

const ALLOWED = [
	"/",
	"/.well-known/security.txt",
	"/.well-known/acme-challenge/token",
	"/environment",
	"/api/envelope",
	"/user/repo/src/branch/main/.gitignore",
	"/.github/workflows/ci.yml",
	"/.gitattributes",
	"/.gitlab-ci.yml",
	"/user/repo.git/info/refs",
	"/.dockerignore",
	"/assets/app.env.js",
	"/git/config",
	"/proc/self",
	"/process/selfie",
	"/index.php",
	"/wp-login.php",
	"/credentials.json",
	"/secrets.json",
	"/x/.npmrcx",
	"/.gitx/y",
	"/owner/repo.git/git-upload-pack",
	"/owner/repo.git/git-receive-pack",
	"/owner/repo.git/info/lfs/objects/batch",
	"/owner/.github.git/info/refs",
	"/owner/.github",
	"/owner/.github/src/branch/main/README.md",
	"/owner/repo/src/branch/main/.env.example",
	"/owner/repo/src/branch/main/.env",
	"/owner/repo/src/commit/0a1b2c3d4e/.gitignore",
	"/owner/repo/src/tag/v1.0/.github/workflows/ci.yml",
	"/owner/repo/src/branch/feature/deep/name/.env.example",
	"/owner/repo/src/branch/main/my%20dir/.env.example",
	"/owner/repo/src/branch/main/.ssh",
	"/owner/repo/src/branch/main/.ssh/config",
	"/owner/repo/src/branch/main/.docker/config.json",
	"/owner/repo/raw/branch/main/.env.example",
	"/owner/repo/raw/commit/0a1b2c3d4e/.env",
	"/owner/repo/media/branch/main/.env.example",
	"/owner/repo/blame/branch/main/.env.example",
	"/owner/repo/commits/branch/main/.env",
	"/owner/repo/render/branch/main/.env.example",
	"/owner/repo/tree-view/branch/main/.ssh",
	"/owner/repo/_edit/main/.env.example",
	"/owner/repo/_new/main/.ssh",
	"/owner/repo/_delete/main/.env.example",
	"/owner/repo/_upload/main/.ssh",
	"/owner/repo/lastcommit/0a1b2c3d4e/.ssh",
	"/api/v1/repos/owner/repo/contents/.env.example",
	"/api/v1/repos/owner/repo/contents/.ssh/config",
	"/api/v1/repos/owner/repo/raw/.env.example",
	"/api/v1/repos/owner/repo/media/.env.example",
	"/group/project/-/blob/main/.env.example",
	"/group/subgroup/project/-/raw/main/.env.example",
	"/group/project/-/tree/main/.github",
	"/group/project/-/tree/main/.ssh",
	"/group/project/-/blame/main/.env.example",
	"/group/project/-/edit/main/.env.example",
	"/group/project/-/commits/main/.env",
	"/-/ide/project/group/project/edit/main/-/.env.example",
	"/api/v4/projects/5/repository/files/.env.example",
	"/api/v4/projects/5/repository/files/config%2F.env.example",
	"/api/v4/projects/5/repository/files/config%2F%2Eenv/raw",
	"/api/v4/projects/group%2Fproject/repository/files/.ssh%2Fconfig",
	"/remote.php/dav/files/user/project/.env",
	"/remote.php/dav/files/user/.git/config",
	"/remote.php/dav/files/user/My%20Docs/.env",
	"/remote.php/webdav/project/.git/HEAD",
	"/public.php/dav/files/token/.env",
	"/public.php/webdav/.env",
];

describe("getDefaultProbeShield", () => {
	it("starts with a comment that says what it does and how to turn it off", () => {
		const lines = getDefaultProbeShield().split("\n");
		const comment = lines.slice(0, lines.indexOf("http:"));

		expect(comment.length).toBeGreaterThan(0);
		expect(comment.every((line) => line.startsWith("#"))).toBe(true);
		expect(comment.join("\n")).toContain("replace the whole content");
		expect(comment.join("\n")).toContain("!Host(`s3.example.com`)");
	});

	it("tells the admin what is let through and what is not", () => {
		const comment = getDefaultProbeShield().split("\nhttp:")[0];

		for (const word of [
			"Gitea",
			"Forgejo",
			"GitLab",
			"Nextcloud",
			"ownCloud",
		]) {
			expect(comment).toContain(word);
		}
		expect(comment).toContain("S3-compatible");
		expect(comment).toContain("/project/.git/info/refs");
	});

	it("defines one router on the HTTPS entry point at the highest priority a user may set", () => {
		const routers = generated().http.routers;

		expect(Object.keys(routers)).toEqual(["probe-shield"]);
		expect(routers["probe-shield"]).toMatchObject({
			priority: PROBE_SHIELD_PRIORITY,
			entryPoints: ["websecure"],
			middlewares: ["probe-shield-deny"],
			service: "noop@internal",
			tls: {},
		});
		expect(PROBE_SHIELD_PRIORITY).toBe(2 ** 31 - 1 - 1000);
	});

	it("matches every host: the rule has no Host and no lookaround", () => {
		const { rule } = generated().http.routers["probe-shield"];

		expect(rule).toMatch(RULE_SHAPE);
		expect(rule).not.toMatch(/Host/i);
		expect(rule).not.toMatch(/\(\?[=!<]/);
	});

	it("answers 404 from an allow list that no client address can match", () => {
		const { middlewares } = generated().http;

		expect(middlewares).toEqual({
			"probe-shield-deny": {
				ipAllowList: { sourceRange: ["0.0.0.0/32"], rejectStatusCode: 404 },
			},
		});
	});

	it("needs neither port 80 nor an HTTP challenge", () => {
		const text = getDefaultProbeShield();

		expect(text).not.toMatch(/httpChallenge/i);
		expect(generated().http.routers["probe-shield"].entryPoints).not.toContain(
			"web",
		);
	});

	it("never asks for a certificate: tls is an explicit empty section", () => {
		const router = generated().http.routers["probe-shield"];

		expect(router.tls).toEqual({});
	});
});

describe("probe shield path pattern", () => {
	it.each(BLOCKED)("blocks %s", (requestPath) => {
		expect(isBlocked(requestPath)).toBe(true);
	});

	it.each(ALLOWED)("lets %s through", (requestPath) => {
		expect(isBlocked(requestPath)).toBe(false);
	});

	it("keeps every Git and WebDAV exemption behind a fixed word chain", () => {
		for (const dotName of [".env", ".git/config", ".aws/credentials"]) {
			for (const bare of ["src", "raw", "blob", "media", "dav", "api", "-"]) {
				expect(isBlocked(`/${bare}/${dotName}`)).toBe(true);
				expect(isBlocked(`/x/${bare}/${dotName}`)).toBe(true);
				expect(isBlocked(`/x/y/${bare}/${dotName}`)).toBe(true);
			}
		}
	});

	it("never exempts a path that climbs out of its prefix", () => {
		const prefixes = [
			"/o/r/src/branch/main",
			"/o/r/raw/tag/v1",
			"/o/r/_edit/main",
			"/api/v1/repos/o/r/contents",
			"/g/p/-/blob/main",
			"/-/ide/project/g/p/edit/main/-",
			"/api/v4/projects/1/repository/files",
			"/remote.php/dav/files/u",
			"/public.php/webdav",
		];
		for (const prefix of prefixes) {
			for (const climb of ["..%2F", "..%2f", "..%5C", "..%5c", "..\\"]) {
				expect(isBlocked(`${prefix}/${climb}.env`)).toBe(true);
				expect(isBlocked(`${prefix}/a${climb}${climb}.git%2Fconfig`)).toBe(
					true,
				);
			}
		}
	});
});

describe("panel routes that Git providers and other callers use", () => {
	const routes = panelApiRoutes();

	it("finds the webhook and provider routes", () => {
		expect(routes).toContain("/api/deploy/0a1b2c3d4e");
		expect(routes).toContain("/api/deploy/compose/0a1b2c3d4e");
		expect(routes).toContain("/api/deploy/github");
		expect(routes).toContain("/api/providers/github/webhook");
		expect(routes).toContain("/api/providers/gitlab/callback");
		expect(routes).toContain("/api/providers/gitea/callback");
	});

	it.each(routes)("is not touched by the shield: %s", (route) => {
		expect(isBlocked(route)).toBe(false);
		expect(secret.test(route)).toBe(false);
	});
});

describe("createDefaultProbeShield", () => {
	let cwd: string;
	let dynamicPath: string;
	let shieldPath: string;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-probe-shield-"));
		dynamicPath = path.join(cwd, ".docker", "traefik", "dynamic");
		shieldPath = path.join(dynamicPath, PROBE_SHIELD_FILE);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("creates the file, and its directory, when it is missing", () => {
		createDefaultProbeShield();

		expect(fs.readFileSync(shieldPath, "utf8")).toBe(getDefaultProbeShield());
	});

	it.each([
		["edited", "http:\n  routers: {}\n"],
		["emptied", ""],
		["switched off with a comment", "# off\n"],
	])("keeps a file that was %s", (_label, content) => {
		fs.mkdirSync(dynamicPath, { recursive: true });
		fs.writeFileSync(shieldPath, content, "utf8");

		createDefaultProbeShield();

		expect(fs.readFileSync(shieldPath, "utf8")).toBe(content);
	});

	it("is repeatable: a second start leaves the first file alone", () => {
		createDefaultProbeShield();
		const first = fs.statSync(shieldPath);

		createDefaultProbeShield();

		expect(fs.statSync(shieldPath).mtimeMs).toBe(first.mtimeMs);
		expect(fs.readFileSync(shieldPath, "utf8")).toBe(getDefaultProbeShield());
	});

	it("does not throw when the file cannot be written", () => {
		fs.mkdirSync(path.join(cwd, ".docker", "traefik"), { recursive: true });
		fs.writeFileSync(dynamicPath, "not a directory", "utf8");

		expect(() => createDefaultProbeShield()).not.toThrow();
		expect(console.error).toHaveBeenCalled();
	});
});

describe("buildProbeShieldInstallStep", () => {
	let dir: string;
	let shieldPath: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-probe-shield-sh-"));
		shieldPath = path.join(dir, PROBE_SHIELD_FILE);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const run = (dynamicPath: string) =>
		spawnSync(
			"bash",
			[
				"-c",
				`set -e\nSUDO_CMD=""\n${buildProbeShieldInstallStep(dynamicPath)}`,
			],
			{ encoding: "utf8" },
		);

	it("writes the exact generated file, backticks and backslashes included", () => {
		const result = run(dir);

		expect(result.status).toBe(0);
		expect(fs.readFileSync(shieldPath, "utf8")).toBe(getDefaultProbeShield());
	});

	it.each([
		["edited", "http: {}\n"],
		["emptied", ""],
	])("keeps a file that was %s", (_label, content) => {
		fs.writeFileSync(shieldPath, content, "utf8");

		const result = run(dir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("already exists");
		expect(fs.readFileSync(shieldPath, "utf8")).toBe(content);
	});

	it("only warns when the file cannot be written, so server setup goes on", () => {
		const result = run(path.join(dir, "missing", "dynamic"));

		expect(result.status).toBe(0);
		expect(result.stderr).toContain(
			"requests for secret files are not blocked",
		);
	});
});

describe("defaultCommand", () => {
	it("creates the shield right after the middlewares on a full server", () => {
		const script = defaultCommand(false);
		const middlewares = script.indexOf('echo -e "9. Setting up Middlewares"');
		const shield = script.indexOf(
			"/etc/dokploy/traefik/dynamic/probe-shield.yml",
		);
		const instance = script.indexOf(
			'echo -e "10. Setting up Traefik Instance"',
		);

		expect(middlewares).toBeGreaterThan(-1);
		expect(shield).toBeGreaterThan(middlewares);
		expect(shield).toBeLessThan(instance);
	});

	it("leaves a build server alone, it has no Traefik", () => {
		expect(defaultCommand(true)).not.toContain(PROBE_SHIELD_FILE);
	});
});
