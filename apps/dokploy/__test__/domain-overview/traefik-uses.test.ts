import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	compileHostPattern,
	namesMatchPatterns,
} from "@dokploy/server/utils/domain-overview/host-patterns";
import {
	buildDynamicHostsCommand,
	buildTraefikRoutesCommand,
	extractRuleMatchers,
	parseDynamicConfigUses,
	parseTraefikUses,
} from "@dokploy/server/utils/domain-overview/traefik-routes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const which = (name: string) =>
	spawnSync("sh", ["-c", `command -v ${name}`], {
		encoding: "utf8",
	}).stdout.trim();

const SHELLS = ["/bin/sh", which("dash") || "/bin/dash"];

const line = (name: string, labels: Record<string, string>) =>
	`/${name}|${JSON.stringify(labels)}`;

describe("rule matchers", () => {
	it("reads Host, HostSNI and HostHeader as names", () => {
		expect(
			extractRuleMatchers(
				"Host(`a.example.com`) || HostSNI(`b.example.com`) || HostHeader(`c.example.com`)",
			),
		).toEqual({
			hosts: ["a.example.com", "b.example.com", "c.example.com"],
			patterns: [],
		});
	});

	it("reads HostRegexp and HostSNIRegexp as patterns, keeping a closing bracket inside", () => {
		expect(
			extractRuleMatchers(
				"HostRegexp(`^(a|b)\\.example\\.com$`) || HostSNIRegexp(`{sub:[a-z]+}.example.com`)",
			),
		).toEqual({
			hosts: [],
			patterns: ["^(a|b)\\.example\\.com$", "{sub:[a-z]+}.example.com"],
		});
	});

	it("reads a multi-name matcher", () => {
		expect(
			extractRuleMatchers("Host(`a.example.com`, `b.example.com`)").hosts,
		).toEqual(["a.example.com", "b.example.com"]);
	});
});

describe("label uses: unreadable and templates", () => {
	it("marks a container whose labels are not valid JSON as unreadable", () => {
		expect(parseTraefikUses("/web|{not json").unreadable).toBe(true);
		expect(parseTraefikUses('/web|["a"]').unreadable).toBe(true);
		expect(parseTraefikUses("nonsense without a separator").unreadable).toBe(
			true,
		);
	});

	it("accepts a container without labels", () => {
		expect(parseTraefikUses("/web|null\n/db|{}\n").unreadable).toBe(false);
	});

	it("turns a Go template in a Host rule into a match-everything pattern", () => {
		const uses = parseTraefikUses(
			line("web", {
				"traefik.http.routers.web.rule": 'Host(`{{ env "SUB" }}.example.com`)',
			}),
		);

		expect(uses.routes).toEqual([]);
		expect(namesMatchPatterns(["anything.example.org"], uses.patterns)).toBe(
			true,
		);
	});
});

describe("label uses", () => {
	it("counts a TCP router rule", () => {
		const uses = parseTraefikUses(
			line("db", {
				"traefik.tcp.routers.db.rule": "HostSNI(`db.example.com`)",
			}),
		);

		expect(uses.routes.map((route) => route.host)).toEqual(["db.example.com"]);
	});

	it("still counts an HTTP router rule", () => {
		const uses = parseTraefikUses(
			line("web", {
				"traefik.http.routers.web.rule": "Host(`web.example.com`)",
			}),
		);

		expect(uses.routes.map((route) => route.host)).toEqual(["web.example.com"]);
	});

	it("keeps names from tls.domains of HTTP and TCP routers as mentions", () => {
		const uses = parseTraefikUses(
			[
				line("web", {
					"traefik.http.routers.web.tls.domains[0].main": "example.com",
					"traefik.http.routers.web.tls.domains[0].sans":
						"a.example.com, b.example.com",
				}),
				line("db", {
					"traefik.tcp.routers.db.tls.domains[1].main": "tcp.example.com",
				}),
			].join("\n"),
		);

		expect(uses.mentions.sort()).toEqual([
			"a.example.com",
			"b.example.com",
			"example.com",
			"tcp.example.com",
		]);
	});

	it("keeps regexp matchers as patterns", () => {
		const uses = parseTraefikUses(
			line("web", {
				"traefik.http.routers.web.rule": "HostRegexp(`^.+\\.example\\.com$`)",
			}),
		);

		expect(uses.patterns).toEqual(["^.+\\.example\\.com$"]);
	});

	it("reads swarm service labels and names the service", () => {
		const uses = parseTraefikUses(
			`svc:shop_app|${JSON.stringify({
				"traefik.http.routers.shop.rule": "Host(`shop.example.com`)",
			})}`,
		);

		expect(uses.routes).toEqual([
			{
				host: "shop.example.com",
				containerName: "shop_app",
				composeProject: null,
				serviceName: "shop_app",
			},
		]);
	});

	it("ignores a disabled container", () => {
		expect(
			parseTraefikUses(
				line("off", {
					"traefik.enable": "false",
					"traefik.tcp.routers.off.rule": "HostSNI(`off.example.com`)",
				}),
			).routes,
		).toEqual([]);
	});
});

describe("host patterns", () => {
	it("matches the names a pattern can reach", () => {
		expect(
			namesMatchPatterns(["app.example.com"], ["^.+\\.example\\.com$"]),
		).toBe(true);
		expect(
			namesMatchPatterns(["app.other.net"], ["^.+\\.example\\.com$"]),
		).toBe(false);
	});

	it("keeps a wildcard certificate in use while any pattern exists on the server", () => {
		expect(
			namesMatchPatterns(["*.example.com"], ["^app-[0-9]+\\.example\\.com$"]),
		).toBe(true);
		expect(namesMatchPatterns(["*.example.com"], ["^shop\\..+$"])).toBe(true);
		expect(namesMatchPatterns(["*.example.com"], [])).toBe(false);
	});

	it("tests a plain name against each pattern", () => {
		expect(
			namesMatchPatterns(
				["app-7.example.com"],
				["^app-[0-9]+\\.example\\.com$"],
			),
		).toBe(true);
		expect(
			namesMatchPatterns(
				["shop.example.com"],
				["^app-[0-9]+\\.example\\.com$"],
			),
		).toBe(false);
		expect(
			namesMatchPatterns(
				["www.example.com", "other.example.org"],
				["^(www|app)\\.example\\.com$"],
			),
		).toBe(true);
	});

	it.each([
		"(a+)+$",
		"^(a|aa)+$",
		"^(.*)*x$",
		"^(a*)*$",
		"^(\\w+\\.)+example\\.com$",
		"(a)\\1",
		"(?=a)a",
		".*.*.*.*x",
		`^${"a".repeat(250)}$`,
		'{{ env "HOST" }}.example.com',
	])(
		"does not run the unsafe pattern %s and treats it as matching everything",
		(pattern) => {
			expect(compileHostPattern(pattern)).toBeNull();
			const started = Date.now();

			expect(namesMatchPatterns(["shop.example.com"], [pattern])).toBe(true);
			expect(Date.now() - started).toBeLessThan(1_000);
		},
	);

	it.each([
		"^app-[0-9]+\\.example\\.com$",
		"^(www|app)\\.example\\.com$",
		"^[a-z]+\\.example\\.com$",
		"{sub:[a-z]+}.example.com",
		"^.+\\.example\\.com$",
	])("still evaluates the ordinary pattern %s", (pattern) => {
		expect(compileHostPattern(pattern)).not.toBeNull();
	});

	it("does not hang on a hostile pattern against a long name", () => {
		const name = `${"a".repeat(240)}!.example.com`;
		const started = Date.now();

		expect(namesMatchPatterns([name], ["^(a+)+$"])).toBe(true);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("reads old named groups", () => {
		expect(
			compileHostPattern("{sub:[a-z]+}.example.com")?.test("a.example.com"),
		).toBe(true);
	});

	it("treats a pattern it cannot compile as matching everything", () => {
		expect(namesMatchPatterns(["anything.example.org"], ["(?P<x>a"])).toBe(
			true,
		);
	});
});

describe.each(SHELLS)("docker label command under %s", (shell) => {
	let dir: string;

	const run = (env: Record<string, string>) => {
		const result = spawnSync(shell, ["-c", buildTraefikRoutesCommand()], {
			encoding: "utf8",
			env: { PATH: dir, ...env } as unknown as NodeJS.ProcessEnv,
		});
		return { status: result.status, stdout: result.stdout };
	};

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "routes-cmd-"));
		symlinkSync(which("cat"), path.join(dir, "cat"));
		writeFileSync(
			path.join(dir, "docker"),
			`#!/bin/sh
case "$1" in
	ps) [ -z "$FAKE_PS_FAIL" ] || exit 1; echo abc; echo def ;;
	inspect) [ -z "$FAKE_INSPECT_FAIL" ] || exit 1
		echo '/web|{"traefik.tcp.routers.db.rule":"HostSNI(\`db.example.com\`)"}' ;;
	info) [ -z "$FAKE_INFO_FAIL" ] || exit 1; echo "\${FAKE_MANAGER:-false}" ;;
	service)
		case "$2" in
			ls) [ -z "$FAKE_LS_FAIL" ] || exit 1; echo svc1 ;;
			inspect) echo 'svc:shop|{"traefik.http.routers.shop.rule":"Host(\`shop.example.com\`)"}' ;;
		esac ;;
esac
`,
		);
		chmodSync(path.join(dir, "docker"), 0o755);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the labels of containers", () => {
		const { status, stdout } = run({});

		expect(status).toBe(0);
		expect(parseTraefikUses(stdout).routes.map((r) => r.host)).toEqual([
			"db.example.com",
		]);
	});

	it("fails when docker ps fails instead of reporting no routes", () => {
		const { status, stdout } = run({ FAKE_PS_FAIL: "1" });

		expect(status).not.toBe(0);
		expect(stdout).toBe("");
	});

	it("fails when docker info fails instead of skipping the swarm services", () => {
		expect(run({ FAKE_INFO_FAIL: "1" }).status).not.toBe(0);
	});

	it("fails when docker inspect fails", () => {
		expect(run({ FAKE_INSPECT_FAIL: "1" }).status).not.toBe(0);
	});

	it("adds swarm services on a manager node", () => {
		const { status, stdout } = run({ FAKE_MANAGER: "true" });

		expect(status).toBe(0);
		expect(
			parseTraefikUses(stdout)
				.routes.map((r) => r.host)
				.sort(),
		).toEqual(["db.example.com", "shop.example.com"]);
	});

	it("fails when the service list fails on a manager node", () => {
		expect(run({ FAKE_MANAGER: "true", FAKE_LS_FAIL: "1" }).status).not.toBe(0);
	});

	it("skips swarm services on a node that is not a manager", () => {
		const { stdout } = run({ FAKE_MANAGER: "false", FAKE_LS_FAIL: "1" });

		expect(parseTraefikUses(stdout).routes.map((r) => r.host)).toEqual([
			"db.example.com",
		]);
	});
});

describe.each(SHELLS)("dynamic config scan under %s", (shell) => {
	let root: string;
	let dynamicDir: string;
	let staticFile: string;

	const scan = () => {
		const result = spawnSync(
			shell,
			["-c", buildDynamicHostsCommand(dynamicDir, staticFile)],
			{ encoding: "utf8" },
		);
		return { status: result.status, stdout: result.stdout };
	};

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "dyn-"));
		dynamicDir = path.join(root, "dynamic");
		staticFile = path.join(root, "traefik.yml");
		mkdirSync(path.join(dynamicDir, "nested"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reads a config file that is a symlink to a file elsewhere", () => {
		const elsewhere = path.join(root, "elsewhere.yml");
		writeFileSync(elsewhere, "rule: Host(`linked.example.com`)\n");
		symlinkSync(elsewhere, path.join(dynamicDir, "linked.yml"));

		const uses = parseDynamicConfigUses(scan().stdout);

		expect(uses.hosts.map((item) => item.host)).toContain("linked.example.com");
	});

	it("reports a directory it cannot list as unreadable", () => {
		if (process.getuid?.() === 0) {
			return;
		}
		const locked = path.join(dynamicDir, "locked");
		mkdirSync(locked);
		writeFileSync(
			path.join(locked, "hidden.yml"),
			"rule: Host(`h.example.com`)",
		);
		chmodSync(locked, 0o000);
		try {
			expect(parseDynamicConfigUses(scan().stdout).unreadable).toBe(true);
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	it("keeps a punycode top-level domain whole", () => {
		writeFileSync(
			path.join(dynamicDir, "idn.yml"),
			"rule: Host(`shop.example.xn--p1ai`)\n",
		);

		const uses = parseDynamicConfigUses(scan().stdout);

		expect(uses.mentions).toContain("shop.example.xn--p1ai");
		expect(uses.hosts.map((item) => item.host)).toContain(
			"shop.example.xn--p1ai",
		);
	});

	it("turns a Go template in a config file rule into a match-everything pattern", () => {
		writeFileSync(
			path.join(dynamicDir, "tpl.yml"),
			'rule: Host(`{{ env "SUB" }}.example.com`)\n',
		);

		const uses = parseDynamicConfigUses(scan().stdout);

		expect(namesMatchPatterns(["a.example.org"], uses.patterns)).toBe(true);
	});

	it("finds a rule folded over several lines", () => {
		writeFileSync(
			path.join(dynamicDir, "dokploy.yml"),
			[
				"http:",
				"  routers:",
				"    panel:",
				"      rule: >-",
				"        Host(`a.example.com`)",
				"        || Host(`b.example.com`,",
				"        `c.example.com`)",
			].join("\n"),
		);

		const uses = parseDynamicConfigUses(scan().stdout);

		expect(uses.hosts.map((item) => item.host).sort()).toEqual([
			"a.example.com",
			"b.example.com",
			"c.example.com",
		]);
		expect(uses.hosts[0]?.file).toBe("dokploy.yml");
	});

	it("keeps tls.domains of YAML and TOML as mentions", () => {
		writeFileSync(
			path.join(dynamicDir, "nested", "tls.yml"),
			[
				"http:",
				"  routers:",
				"    r:",
				"      tls:",
				"        domains:",
				"          - main: tls.example.com",
				"            sans:",
				"              - san.example.com",
			].join("\n"),
		);
		writeFileSync(
			path.join(dynamicDir, "extra.toml"),
			[
				"[[http.routers.x.tls.domains]]",
				'  main = "toml.example.com"',
				'  sans = ["toml-san.example.com"]',
			].join("\n"),
		);

		const uses = parseDynamicConfigUses(scan().stdout);

		expect(uses.mentions).toEqual(
			expect.arrayContaining([
				"tls.example.com",
				"san.example.com",
				"toml.example.com",
				"toml-san.example.com",
			]),
		);
	});

	it("keeps tls.domains of the static config and prints no other content", () => {
		writeFileSync(
			staticFile,
			[
				"entryPoints:",
				"  websecure:",
				"    http:",
				"      tls:",
				"        domains:",
				"          - main: static.example.com",
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: ops@mail.example.org",
				"      password: SECRET-VALUE-123",
			].join("\n"),
		);

		const { stdout } = scan();

		expect(parseDynamicConfigUses(stdout).mentions).toContain(
			"static.example.com",
		);
		expect(stdout).not.toContain("SECRET-VALUE-123");
		expect(stdout).not.toContain("mail.example.org");
	});

	it("keeps regexp matchers as patterns and never prints other file content", () => {
		writeFileSync(
			path.join(dynamicDir, "re.toml"),
			[
				'rule = "HostRegexp(`^.+\\\\.regex\\\\.example\\\\.com$`)"',
				'users = ["admin:$apr1$SECRETHASH$abc"]',
			].join("\n"),
		);

		const { stdout } = scan();

		expect(parseDynamicConfigUses(stdout).patterns).toHaveLength(1);
		expect(stdout).not.toContain("SECRETHASH");
	});

	it("does not read certificate storage files as configuration", () => {
		writeFileSync(
			path.join(dynamicDir, "acme.json"),
			'{"letsencrypt":{"Certificates":[{"domain":{"main":"stored.example.com"}}]}}',
		);

		expect(parseDynamicConfigUses(scan().stdout).mentions).not.toContain(
			"stored.example.com",
		);
	});

	it("reports an unreadable file instead of an empty answer", () => {
		if (process.getuid?.() === 0) {
			return;
		}
		const file = path.join(dynamicDir, "locked.yml");
		writeFileSync(file, "rule: Host(`x.example.com`)");
		chmodSync(file, 0o000);

		const uses = parseDynamicConfigUses(scan().stdout);
		chmodSync(file, 0o600);

		expect(uses.unreadable).toBe(true);
	});

	it("exits with the missing-directory code when there is no dynamic directory", () => {
		rmSync(dynamicDir, { recursive: true, force: true });

		expect(scan().status).toBe(3);
	});
});
