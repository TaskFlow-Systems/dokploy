import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { wrapComponentUpdateSteps } from "@dokploy/server/setup/server-components";
import {
	buildTraefikTlsMigrationStep,
	getDefaultServerTraefikConfig,
	getDefaultTraefikConfig,
	HTTP_CHALLENGE_TO_TLS_AWK,
	initializeStandaloneTraefik,
	initializeTraefikService,
	type TraefikOptions,
} from "@dokploy/server/setup/traefik-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getRemoteDocker: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

const storedPorts: NonNullable<TraefikOptions["additionalPorts"]> = [
	{ targetPort: 80, publishedPort: 80, protocol: "tcp" },
	{ targetPort: 8081, publishedPort: 80, protocol: "tcp" },
	{ targetPort: 9000, publishedPort: 9000, protocol: "tcp" },
];

const createStandaloneContainer = async (
	additionalPorts: TraefikOptions["additionalPorts"],
) => {
	const created = {
		start: vi.fn().mockResolvedValue(undefined),
		inspect: vi.fn().mockResolvedValue({
			State: { Running: true, StartedAt: "2026-10-26T00:00:00Z" },
		}),
	};
	const createContainer = vi.fn().mockResolvedValue(created);
	mocks.getRemoteDocker.mockResolvedValue({
		createContainer,
		getContainer: () => ({
			inspect: vi.fn().mockRejectedValue(new Error("no such container")),
		}),
		getImage: () => ({ inspect: vi.fn().mockResolvedValue({}) }),
	});

	const started = initializeStandaloneTraefik({ additionalPorts });
	await vi.runAllTimersAsync();
	await started;

	return createContainer.mock.calls[0]?.[0];
};

describe("initializeStandaloneTraefik", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("never binds host port 80, even when a stored port list still contains it", async () => {
		const settings = await createStandaloneContainer(storedPorts);
		const hostPorts = Object.values(settings.HostConfig.PortBindings).flatMap(
			(bindings) =>
				(bindings as { HostPort: string }[]).map((binding) => binding.HostPort),
		);

		expect(hostPorts).not.toContain("80");
		expect(hostPorts).toContain("9000");
		expect(settings.HostConfig.PortBindings).not.toHaveProperty("80/tcp");
		expect(settings.ExposedPorts).not.toHaveProperty("80/tcp");
	});

	it("keeps HTTPS and HTTP/3 on port 443 over TCP and UDP", async () => {
		const settings = await createStandaloneContainer([]);

		expect(settings.HostConfig.PortBindings["443/tcp"]).toEqual([
			{ HostPort: "443" },
		]);
		expect(settings.HostConfig.PortBindings["443/udp"]).toEqual([
			{ HostPort: "443" },
		]);
	});
});

describe("initializeTraefikService", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("never publishes host port 80 in the service endpoint", async () => {
		const createService = vi.fn().mockResolvedValue(undefined);
		mocks.getRemoteDocker.mockResolvedValue({
			createService,
			getService: () => ({
				inspect: vi.fn().mockRejectedValue(new Error("service not found")),
			}),
		});

		await initializeTraefikService({ additionalPorts: storedPorts });

		const endpointPorts = createService.mock.calls[0]?.[0].EndpointSpec.Ports;
		expect(
			endpointPorts.map(
				(port: { PublishedPort: number }) => port.PublishedPort,
			),
		).not.toContain(80);
		expect(endpointPorts).toContainEqual(
			expect.objectContaining({
				TargetPort: 443,
				PublishedPort: 443,
				Protocol: "tcp",
			}),
		);
		expect(endpointPorts).toContainEqual(
			expect.objectContaining({
				TargetPort: 443,
				PublishedPort: 443,
				Protocol: "udp",
			}),
		);
		expect(endpointPorts).toContainEqual(
			expect.objectContaining({
				TargetPort: 9000,
				PublishedPort: 9000,
				Protocol: "tcp",
			}),
		);
	});
});

describe("buildTraefikTlsMigrationStep", () => {
	const isRoot = process.getuid?.() === 0;
	const SPAWN_TEST_TIMEOUT_MS = 30_000;
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "traefik-tls-"));
	});

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true });
	});

	const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

	const filesInDir = () => readdirSync(dir).sort();

	const backupFile = () => {
		const backups = filesInDir().filter((name) => name.includes(".bak-"));
		expect(backups).toHaveLength(1);
		return path.join(dir, backups[0] ?? "");
	};

	const runStep = (configPath: string) =>
		spawnSync(
			"bash",
			[
				"-c",
				[
					"set -eu",
					"if ! {",
					buildTraefikTlsMigrationStep(configPath),
					"}; then",
					"\texit 1",
					"fi",
				].join("\n"),
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `/bin:/usr/bin:${process.env.PATH ?? ""}`,
					SUDO_CMD: "",
				},
			},
		);

	const runWrapped = (configPath: string) => {
		const shims = path.join(dir, "shims");
		mkdirSync(shims);
		writeFileSync(path.join(shims, "sudo"), '#!/bin/sh\nexec "$@"\n');
		chmodSync(path.join(shims, "sudo"), 0o755);
		return spawnSync(
			"bash",
			[
				"-c",
				wrapComponentUpdateSteps(buildTraefikTlsMigrationStep(configPath)),
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${shims}:/bin:/usr/bin:${process.env.PATH ?? ""}`,
				},
			},
		);
	};

	it(
		"does not stop the settings script when the config has no httpChallenge",
		() => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      tlsChallenge: {}",
			);
			writeFileSync(configPath, original);

			const run = runWrapped(configPath);

			expect(run.status).toBe(0);
			expect(readFileSync(configPath, "utf8")).toBe(original);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"stops the settings script when the config cannot be converted",
		() => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:   # HTTP-01 needs port 80",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);

			const run = runWrapped(configPath);

			expect(run.status).not.toBe(0);
			expect(readFileSync(configPath, "utf8")).toBe(original);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("builds a step that rewrites httpChallenge and keeps a dated backup", () => {
		const step = buildTraefikTlsMigrationStep();

		expect(step.split("\n")[0]).toBe('traefik_acme_backup=""');
		expect(step).toContain(HTTP_CHALLENGE_TO_TLS_AWK);
		expect(step).toContain("tlsChallenge: {}");
		expect(step).toContain('.bak-$(date -u +%Y%m%d%H%M%S)"');
	});

	it("turns the default block form into tlsChallenge at the same indentation", () => {
		const configPath = path.join(dir, "traefik.yml");
		const original = lines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: admin@example.com",
			"      storage: /letsencrypt/acme.json",
			"      httpChallenge:",
			"        entryPoint: web",
		);
		writeFileSync(configPath, original);

		const run = runStep(configPath);
		const backup = backupFile();

		expect(run.status).toBe(0);
		expect(run.stdout).toContain(`Previous config saved to ${backup}`);
		expect(readFileSync(configPath, "utf8")).toBe(
			lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: admin@example.com",
				"      storage: /letsencrypt/acme.json",
				"      tlsChallenge: {}",
			),
		);
		expect(readFileSync(backup)).toEqual(Buffer.from(original));
		expect(filesInDir()).toEqual([path.basename(backup), "traefik.yml"].sort());
	});

	it("keeps the sibling keys around an httpChallenge block unchanged", () => {
		const configPath = path.join(dir, "traefik.yml");
		const original = lines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: admin@example.com",
			"      httpChallenge:",
			"        entryPoint: web",
			"      storage: /letsencrypt/acme.json",
			"api:",
			"  insecure: true",
		);
		writeFileSync(configPath, original);

		const run = runStep(configPath);

		expect(run.status).toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(
			lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: admin@example.com",
				"      tlsChallenge: {}",
				"      storage: /letsencrypt/acme.json",
				"api:",
				"  insecure: true",
			),
		);
		expect(readFileSync(backupFile())).toEqual(Buffer.from(original));
	});

	it("skips the children of an httpChallenge block that follow a blank line", () => {
		const configPath = path.join(dir, "traefik.yml");
		const original = lines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      httpChallenge:",
			"        entryPoint: web",
			"",
			"        domains: example.com",
			"      storage: /letsencrypt/acme.json",
		);
		writeFileSync(configPath, original);

		const run = runStep(configPath);

		expect(run.status).toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(
			lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      tlsChallenge: {}",
				"",
				"      storage: /letsencrypt/acme.json",
			),
		);
		expect(readFileSync(backupFile())).toEqual(Buffer.from(original));
	});
	it("converts the inline httpChallenge form", () => {
		const configPath = path.join(dir, "traefik.yml");
		const original = lines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: admin@example.com",
			"      httpChallenge: {entryPoint: web}",
			"      storage: /letsencrypt/acme.json",
		);
		writeFileSync(configPath, original);

		const run = runStep(configPath);

		expect(run.status).toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(
			lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: admin@example.com",
				"      tlsChallenge: {}",
				"      storage: /letsencrypt/acme.json",
			),
		);
		expect(readFileSync(backupFile())).toEqual(Buffer.from(original));
	});

	it("leaves a config that already uses tlsChallenge untouched", () => {
		const configPath = path.join(dir, "traefik.yml");
		const original = lines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      tlsChallenge: {}",
		);
		writeFileSync(configPath, original);

		const run = runStep(configPath);

		expect(run.status).toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(original);
		expect(filesInDir()).toEqual(["traefik.yml"]);
	});

	it.each(["bash", "/bin/sh"])(
		"fails before touching the config when sudo cannot run commands (%s)",
		(shell) => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);
			const shims = path.join(dir, "shims");
			const tmp = path.join(dir, "tmp");
			mkdirSync(shims);
			mkdirSync(tmp);
			writeFileSync(path.join(shims, "sudo"), "#!/bin/sh\nexit 1\n");
			chmodSync(path.join(shims, "sudo"), 0o755);

			const run = spawnSync(
				shell,
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${shims}:/bin:/usr/bin:${process.env.PATH ?? ""}`,
						SUDO_CMD: "sudo",
						TMPDIR: tmp,
					},
				},
			);

			expect(run.status).toBe(1);
			expect(run.stderr).toContain("could not run test as root");
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(filesInDir()).toEqual(["shims", "tmp", "traefik.yml"].sort());
			expect(readdirSync(tmp)).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it.each(["bash", "/bin/sh"])(
		"fails without changing anything when the existence check cannot run (%s)",
		(shell) => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);
			const shims = path.join(dir, "shims");
			const tmp = path.join(dir, "tmp");
			mkdirSync(shims);
			mkdirSync(tmp);
			writeFileSync(path.join(shims, "sudo"), '#!/bin/sh\nexec "$@"\n');
			chmodSync(path.join(shims, "sudo"), 0o755);
			// The probe on "/" must pass, so the run reaches the existence check that this test targets.
			writeFileSync(
				path.join(shims, "test"),
				'#!/bin/sh\n[ "$2" = / ] && exit 0\nexit 127\n',
			);
			chmodSync(path.join(shims, "test"), 0o755);

			const run = spawnSync(
				shell,
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${shims}:/bin:/usr/bin:${process.env.PATH ?? ""}`,
						SUDO_CMD: "sudo",
						TMPDIR: tmp,
					},
				},
			);

			expect(run.status).toBe(1);
			expect(run.stderr).toContain(`could not check ${configPath}`);
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(filesInDir()).toEqual(["shims", "tmp", "traefik.yml"].sort());
			expect(readdirSync(tmp)).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it.each(["bash", "/bin/sh"])(
		"fails without changing anything when test cannot run as root (%s)",
		(shell) => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);
			const shims = path.join(dir, "shims");
			const tmp = path.join(dir, "tmp");
			mkdirSync(shims);
			mkdirSync(tmp);
			writeFileSync(path.join(shims, "sudo"), '#!/bin/sh\nexec "$@"\n');
			chmodSync(path.join(shims, "sudo"), 0o755);
			writeFileSync(path.join(shims, "test"), "#!/bin/sh\nexit 1\n");
			chmodSync(path.join(shims, "test"), 0o755);

			const run = spawnSync(
				shell,
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${shims}:/bin:/usr/bin:${process.env.PATH ?? ""}`,
						SUDO_CMD: "sudo",
						TMPDIR: tmp,
					},
				},
			);

			expect(run.status).toBe(1);
			expect(run.stderr).toContain("could not run test as root");
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(filesInDir()).toEqual(["shims", "tmp", "traefik.yml"].sort());
			expect(readdirSync(tmp)).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("keeps a comment inside an httpChallenge block from ending the skip", () => {
		const configPath = path.join(dir, "traefik.yml");
		const original = lines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      httpChallenge:",
			"      # note",
			"        entryPoint: web",
		);
		writeFileSync(configPath, original);

		const run = runStep(configPath);

		expect(run.status).toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(
			lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      tlsChallenge: {}",
			),
		);
		expect(readFileSync(backupFile())).toEqual(Buffer.from(original));
	});

	it.each(["bash", "/bin/sh"])(
		"fails when a line under the converted tlsChallenge is more indented (%s)",
		(shell) => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge: {entryPoint: web}",
				"        extra: 1",
			);
			writeFileSync(configPath, original);
			const tmp = path.join(dir, "tmp");
			mkdirSync(tmp);

			const run = spawnSync(
				shell,
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{
					encoding: "utf8",
					env: { ...process.env, SUDO_CMD: "", TMPDIR: tmp },
				},
			);
			const backup = backupFile();

			expect(run.status).toBe(1);
			expect(run.stderr).toContain("has lines under tlsChallenge");
			expect(run.stderr).toContain(backup);
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(readFileSync(backup)).toEqual(Buffer.from(original));
			expect(readdirSync(tmp)).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it.each(["bash", "/bin/sh"])(
		"keeps saving when sudo cannot run test and the config needs no conversion (%s)",
		(shell) => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      tlsChallenge: {}",
			);
			writeFileSync(configPath, original);
			const shims = path.join(dir, "shims");
			const tmp = path.join(dir, "tmp");
			mkdirSync(shims);
			mkdirSync(tmp);
			writeFileSync(path.join(shims, "sudo"), "#!/bin/sh\nexit 1\n");
			chmodSync(path.join(shims, "sudo"), 0o755);

			const run = spawnSync(
				shell,
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${shims}:/bin:/usr/bin:${process.env.PATH ?? ""}`,
						SUDO_CMD: "sudo",
						TMPDIR: tmp,
					},
				},
			);

			expect(run.status).toBe(0);
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(filesInDir()).toEqual(["shims", "tmp", "traefik.yml"].sort());
			expect(readdirSync(tmp)).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it.each(["bash", "/bin/sh"])(
		"fails closed when sudo cannot run test and the config is missing (%s)",
		(shell) => {
			const configPath = path.join(dir, "traefik.yml");
			const shims = path.join(dir, "shims");
			const tmp = path.join(dir, "tmp");
			mkdirSync(shims);
			mkdirSync(tmp);
			writeFileSync(path.join(shims, "sudo"), "#!/bin/sh\nexit 1\n");
			chmodSync(path.join(shims, "sudo"), 0o755);

			const run = spawnSync(
				shell,
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${shims}:/bin:/usr/bin:${process.env.PATH ?? ""}`,
						SUDO_CMD: "sudo",
						TMPDIR: tmp,
					},
				},
			);

			expect(run.status).toBe(1);
			expect(run.stderr).toContain("could not run test as root");
			expect(filesInDir()).toEqual(["shims", "tmp"].sort());
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("does nothing when there is no config file", () => {
		const run = runStep(path.join(dir, "traefik.yml"));

		expect(run.status).toBe(0);
		expect(filesInDir()).toEqual([]);
	});

	it("fails and keeps the original config when the conversion cannot be verified", () => {
		const configPath = path.join(dir, "traefik.yml");
		const original = lines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      httpChallenge:   # HTTP-01 needs port 80",
			"        entryPoint: web",
		);
		writeFileSync(configPath, original);

		const run = runStep(configPath);
		const backup = backupFile();

		expect(run.status).toBe(1);
		expect(run.stderr).toContain(configPath);
		expect(run.stderr).toContain(backup);
		expect(readFileSync(configPath, "utf8")).toBe(original);
		expect(readFileSync(backup)).toEqual(Buffer.from(original));
		expect(filesInDir()).toEqual([path.basename(backup), "traefik.yml"].sort());
	});

	it.each(["bash", "/bin/sh"])(
		"fails with the original config untouched when awk exits non-zero after writing output (%s)",
		(shell) => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);
			const shims = path.join(dir, "shims");
			const tmp = path.join(dir, "tmp");
			mkdirSync(shims);
			mkdirSync(tmp);
			writeFileSync(
				path.join(shims, "awk"),
				'#!/bin/sh\necho "tlsChallenge: {}"\nexit 2\n',
			);
			chmodSync(path.join(shims, "awk"), 0o755);

			const run = spawnSync(
				shell,
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${shims}:/bin:/usr/bin:${process.env.PATH ?? ""}`,
						SUDO_CMD: "",
						TMPDIR: tmp,
					},
				},
			);
			const backup = backupFile();

			expect(run.status).toBe(1);
			expect(run.stderr).toContain("awk exited with status 2");
			expect(run.stderr).toContain(configPath);
			expect(run.stderr).toContain(backup);
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(readdirSync(tmp)).toEqual([]);
			expect(filesInDir()).toEqual(
				["shims", "tmp", path.basename(backup), "traefik.yml"].sort(),
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"converts a block-form config when run by /bin/sh, the shell the local settings path uses",
		() => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);

			const run = spawnSync(
				"/bin/sh",
				["-c", buildTraefikTlsMigrationStep(configPath)],
				{ encoding: "utf8", env: { ...process.env, SUDO_CMD: "" } },
			);

			expect(run.status).toBe(0);
			expect(readFileSync(configPath, "utf8")).toBe(
				lines(
					"certificatesResolvers:",
					"  letsencrypt:",
					"    acme:",
					"      tlsChallenge: {}",
				),
			);
			expect(readFileSync(backupFile())).toEqual(Buffer.from(original));
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("fails without changing anything when the config path is a directory", () => {
		const configPath = path.join(dir, "traefik.yml");
		mkdirSync(configPath);

		const run = runStep(configPath);

		expect(run.status).toBe(1);
		expect(run.stderr).toContain("is not a regular file");
		expect(filesInDir()).toEqual(["traefik.yml"]);
	});

	it.skipIf(isRoot)(
		"fails without changing anything when the config cannot be read",
		() => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);
			chmodSync(configPath, 0o000);

			const run = runStep(configPath);
			chmodSync(configPath, 0o600);

			expect(run.status).toBe(1);
			expect(run.stderr).toContain("could not read");
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(filesInDir()).toEqual(["traefik.yml"]);
		},
	);

	it.skipIf(isRoot)(
		"reports a failed write and keeps the backup in place",
		() => {
			const configPath = path.join(dir, "traefik.yml");
			const original = lines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      httpChallenge:",
				"        entryPoint: web",
			);
			writeFileSync(configPath, original);
			chmodSync(configPath, 0o444);

			const run = runStep(configPath);
			const backup = backupFile();

			expect(run.status).toBe(1);
			expect(run.stderr).toContain(`could not write ${configPath}`);
			expect(run.stderr).toContain(`restoring it from ${backup} failed`);
			expect(readFileSync(configPath, "utf8")).toBe(original);
			expect(readFileSync(backup)).toEqual(Buffer.from(original));
			expect(filesInDir()).toEqual(
				[path.basename(backup), "traefik.yml"].sort(),
			);
		},
	);
});

describe("Traefik ACME challenge", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses the TLS-ALPN challenge in the server config and keeps the web entrypoint", () => {
		const config = getDefaultServerTraefikConfig();

		expect(config).toContain("tlsChallenge: {}");
		expect(config).not.toContain("httpChallenge");
		expect(config).toMatch(/^\s+web:$/m);
	});

	it("uses the TLS-ALPN challenge in the production config and keeps the web entrypoint", () => {
		vi.stubEnv("NODE_ENV", "production");
		const config = getDefaultTraefikConfig();

		expect(config).toContain("tlsChallenge: {}");
		expect(config).not.toContain("httpChallenge");
		expect(config).toMatch(/^\s+web:$/m);
	});
});
