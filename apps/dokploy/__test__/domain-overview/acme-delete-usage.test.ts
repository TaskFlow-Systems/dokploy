import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { shellQuote } from "@dokploy/server/utils/domain-overview/acme";
import { buildAcmeDeleteScript } from "@dokploy/server/utils/domain-overview/acme-delete";
import { LOCK_FUNCTIONS } from "@dokploy/server/utils/domain-overview/acme-delete-shell";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeDir,
	acmeFile,
	backupDir,
	baseEnv,
	binDir,
	callsOf,
	lockFile,
	mains,
	markerFile,
	REAL_JQ,
	readAcme,
	resultOf,
	run,
	running,
	SHELLS,
	setupBin,
	spawnScript,
	targets,
	waitFor,
	which,
	workDir,
	writeExecutable,
} from "./acme-delete-harness";

const PRIMARY = SHELLS.slice(0, 1);

const liveOwner = () =>
	spawnSync(
		"sh",
		[
			"-c",
			`echo "${process.pid} $(if [ -r /proc/${process.pid}/stat ]; then sed 's/^.*) //' /proc/${process.pid}/stat | cut -d' ' -f20; else ps -o lstart= -p ${process.pid} | tr -s ' ' '_'; fi) $(if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; else sysctl -n kern.boottime | tr -s ' ,{}=' '_'; fi)"`,
		],
		{ encoding: "utf8" },
	).stdout;

const runScript = (shell: string, script: string) =>
	spawnSync(shell, ["-c", script], {
		encoding: "utf8",
		env: baseEnv(),
		timeout: 60_000,
	}).stdout;

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"locks, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
			writeExecutable(path.join(workDir, "bin", "ln"), "#!/bin/sh\nexit 1\n");
		});

		it("takes the lock without hard links", () => {
			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
			expect(existsSync(lockFile)).toBe(false);
		});

		it("still reports busy when another script really holds the lock", () => {
			writeFileSync(lockFile, liveOwner());

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("busy");
			expect(callsOf()).toEqual([]);
		});

		it("takes over a stale lock without hard links", () => {
			writeFileSync(lockFile, "999999 none other-boot\n");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
		});
	},
);

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"a stale lock taken by several scripts at once, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		it("never lets two of them stop Traefik at the same time", async () => {
			writeFileSync(lockFile, "999999 none other-boot\n");
			const jobs = Array.from({ length: 4 }, () =>
				spawnScript(shell, targets("one.example.com"), {
					FAKE_STOP_SLOW: "0.4",
				}),
			);
			await Promise.all(jobs.map((job) => job.exited));

			const sequence = callsOf()
				.filter((c) => /^(stop|start) /.test(c))
				.map((c) => c.split(" ")[0]);
			expect(sequence.length).toBeGreaterThan(0);
			sequence.forEach((call, index) => {
				expect(call).toBe(index % 2 === 0 ? "stop" : "start");
			});
			const outcomes = jobs.map((job) => resultOf(job.state.output));
			expect(outcomes.filter((o) => o === "ok").length).toBe(1);
			for (const outcome of outcomes) {
				expect(["ok", "busy", "count_mismatch"]).toContain(outcome);
			}
			expect(existsSync(lockFile)).toBe(false);
		});
	},
);

// Every command the lock functions use to create, move or remove a file.
const FILE_COMMANDS = ["mkdir", "rmdir", "mv", "rm", "ln"];

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"taking over a stale lock, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		let pausedBin: string;
		let pause: string;
		let done: string;

		beforeEach(() => {
			setupBin({ jq: true, shell });
			pausedBin = path.join(workDir, "paused-bin");
			pause = path.join(workDir, "pause");
			done = path.join(workDir, "done");
			mkdirSync(pausedBin);
			for (const command of FILE_COMMANDS) {
				writeExecutable(
					path.join(pausedBin, command),
					`#!/bin/sh\n: > "$PAUSE"\nwhile [ -e "$PAUSE" ]; do sleep 0.02; done\nexec ${which(command)} "$@"\n`,
				);
			}
		});

		const lockScript = (body: string) =>
			`LOCK=${shellQuote(lockFile)}\nHAVE_LOCK=0\n${LOCK_FUNCTIONS}\n${body}\n`;

		const newcomer = async () => {
			const child = spawn(
				shell,
				[
					"-c",
					lockScript(
						[
							"take_lock",
							'echo "HELD $HAVE_LOCK $MYOWNER"',
							'[ "$HAVE_LOCK" = 1 ] || exit 0',
							'while [ ! -e "$DONE" ]; do sleep 0.05; done',
							"release_lock",
						].join("\n"),
					),
				],
				{ env: baseEnv({ DONE: done }), stdio: ["ignore", "pipe", "ignore"] },
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += chunk.toString();
			});
			const exited = new Promise<void>((resolve) =>
				child.on("close", () => resolve()),
			);
			await waitFor(() => output.includes("\n"));
			const [, held, owner] = output.match(/^HELD ([01]) (.*)$/m) ?? [];
			return { held: held === "1", owner, exited };
		};

		it("never lets two scripts hold it while one that found it stale is slow", async () => {
			writeFileSync(lockFile, "999999 none other-boot\n");
			const slow = spawn(
				shell,
				[
					"-c",
					lockScript(
						'lock_state\n[ "$LOCK_STATE" != stale ] || release_stale_lock',
					),
				],
				{
					env: baseEnv({ PATH: `${pausedBin}:${binDir}`, PAUSE: pause }),
					stdio: "ignore",
				},
			);
			let finished = false;
			slow.on("close", () => {
				finished = true;
			});

			const newcomers = [];
			let pauses = 0;
			for (;;) {
				await waitFor(() => finished || existsSync(pause));
				if (finished) {
					break;
				}
				pauses++;
				newcomers.push(await newcomer());
				rmSync(pause);
			}
			newcomers.push(await newcomer());

			const holders = newcomers.filter((one) => one.held);
			expect(pauses).toBeGreaterThan(0);
			expect(holders).toHaveLength(1);
			expect(readFileSync(lockFile, "utf8").trim()).toBe(holders[0]?.owner);
			writeFileSync(done, "");
			await Promise.all(newcomers.map((one) => one.exited));
		});

		it("drops a guard left by a killed script once it is a minute old", () => {
			writeFileSync(lockFile, "999999 none other-boot\n");
			const guard = `${lockFile}.takeover`;
			mkdirSync(guard);
			const old = new Date(Date.now() - 5 * 60_000);
			utimesSync(guard, old, old);

			expect(resultOf(run(shell, targets("one.example.com")).stdout)).toBe(
				"busy",
			);
			expect(existsSync(guard)).toBe(false);
			expect(resultOf(run(shell, targets("one.example.com")).stdout)).toBe(
				"ok",
			);
			expect(existsSync(lockFile)).toBe(false);
		});

		it("answers busy behind a fresh guard and leaves it in place", () => {
			writeFileSync(lockFile, "999999 none other-boot\n");
			const guard = `${lockFile}.takeover`;
			mkdirSync(guard);

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("busy");
			expect(callsOf()).toEqual([]);
			expect(existsSync(guard)).toBe(true);
			expect(readFileSync(lockFile, "utf8")).toBe("999999 none other-boot\n");
		});
	},
);

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"the usage check before the stop, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		const untouched = (result: { stdout: string }) => {
			expect(resultOf(result.stdout)).toBe("in_use");
			expect(callsOf().some((c) => /^(stop|scale)/.test(c))).toBe(false);
			expect(running()).toBe("true");
			expect(existsSync(markerFile)).toBe(false);
			expect(mains(readAcme())).toContain("one.example.com");
			expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([]);
			expect(existsSync(lockFile)).toBe(false);
		};

		it("aborts when a dynamic config file now mentions the name", () => {
			writeFileSync(
				path.join(acmeDir, "app.yml"),
				"http:\n  routers:\n    r:\n      rule: Host(`one.example.com`)\n",
			);

			untouched(run(shell, targets("one.example.com")));
		});

		it("aborts when the static config mentions the name", () => {
			const staticFile = path.join(workDir, "traefik.yml");
			writeFileSync(staticFile, "# ONE.example.com\n");
			const script = buildAcmeDeleteScript({
				acmeFile,
				lockFile,
				markerFile,
				backupDir,
				staticFile,
				targets: targets("one.example.com"),
				timestamp: "20261012T101500Z",
				pollSeconds: 0,
				settleSeconds: 0,
			});

			untouched({ stdout: runScript(shell, script) });
		});

		it("aborts when a container label now mentions the name", () => {
			untouched(
				run(shell, targets("one.example.com"), {
					FAKE_LABELS:
						'{"traefik.http.routers.x.rule":"Host(`one.example.com`)"}',
				}),
			);
		});

		it("aborts when a swarm service label now mentions the name", () => {
			untouched(
				run(shell, targets("one.example.com"), {
					FAKE_SERVICE_LABELS:
						'{"traefik.http.routers.y.rule":"Host(`one.example.com`)"}',
				}),
			);
		});

		it("treats an alternative name of the certificate as a mention too", () => {
			writeFileSync(
				path.join(acmeDir, "app.yml"),
				"host: www.two.example.com\n",
			);
			const script = buildAcmeDeleteScript({
				acmeFile,
				lockFile,
				markerFile,
				backupDir,
				targets: [
					{
						resolver: "letsencrypt",
						domain: "two.example.com",
						names: ["two.example.com", "www.two.example.com"],
					},
				],
				timestamp: "20261012T101500Z",
				pollSeconds: 0,
				settleSeconds: 0,
			});

			expect(runScript(shell, script)).toContain("DOKPLOY_RESULT in_use");
		});

		it("lets the deletion go on when nothing mentions the name", () => {
			writeFileSync(path.join(acmeDir, "app.yml"), "host: other.example.org\n");

			const result = run(shell, targets("one.example.com"), {
				FAKE_LABELS: '{"a":"b"}',
			});

			expect(resultOf(result.stdout)).toBe("ok");
		});
	},
);
