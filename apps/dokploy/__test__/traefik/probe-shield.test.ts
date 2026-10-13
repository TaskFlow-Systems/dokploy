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
	PROBE_SHIELD_PATH_REGEXP,
	PROBE_SHIELD_PRIORITY,
} from "@dokploy/server/setup/traefik-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const generated = () => parse(getDefaultProbeShield());

// The rule uses only syntax that Go's RE2 and JavaScript read the same way, so the
// path cases below can run without Traefik. The real-Traefik run is in the PR.
const shieldPattern = new RegExp(
	PROBE_SHIELD_PATH_REGEXP.replace(/^\(\?i\)/, ""),
	"i",
);

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
];

describe("getDefaultProbeShield", () => {
	it("starts with a comment that says what it does and how to turn it off", () => {
		const lines = getDefaultProbeShield().split("\n");
		const comment = lines.slice(
			0,
			lines.findIndex((line) => line === "http:"),
		);

		expect(comment.length).toBeGreaterThan(0);
		expect(comment.every((line) => line.startsWith("#"))).toBe(true);
		expect(comment.join("\n")).toContain("replace the whole content");
		expect(comment.join("\n")).toContain("!Host(`git.example.com`)");
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

		expect(rule).toMatch(/^PathRegexp\(`[^`]+`\)$/);
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
		expect(shieldPattern.test(requestPath)).toBe(true);
	});

	it.each(ALLOWED)("lets %s through", (requestPath) => {
		expect(shieldPattern.test(requestPath)).toBe(false);
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
