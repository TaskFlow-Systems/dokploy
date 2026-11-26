import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const script = path.resolve(
	__dirname,
	"../../../../.github/scripts/validate-bun-lock.py",
);

const SHA_A = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SHA_B = "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const SHA_C = "sha512-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
const SHA_EMNAPI_1113 =
	"sha512-Xz4Tpyki7XyrpbUK1jR1AhdAdaXyhhY4lZ3neLodmhpuWfy2PAQN5B46sAiU4liOXGLkHypn/qU+jvfWSCYYLA==";
const SHA_EMNAPI_200 =
	"sha512-JcrSPzPvZuNZvJqPTF9Fw25LbOJ8avzFVlaf2grmH4Cku0oGP47tRgqPZadcfj3YoZMHkFVnCYFbQM8I+i5QEw==";

type PackageTuple =
	| [string]
	| [string, string, Record<string, unknown>, string];

const makeLock = (packages: Record<string, PackageTuple>) => {
	const lines = [
		"{",
		'  "lockfileVersion": 3,',
		'  "configVersion": 1,',
		'  "packages": {',
	];
	for (const [key, val] of Object.entries(packages)) {
		lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(val)},`);
	}
	lines.push("  },", "}");
	return `${lines.join("\n")}\n`;
};

const pkg = (
	spec: string,
	integrity = SHA_A,
	meta: Record<string, unknown> = {},
): PackageTuple => [spec, "", meta, integrity];

let rootDir = "";
let repoCounter = 0;

beforeAll(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "validate-bun-lock-"));
});

afterAll(async () => {
	if (rootDir) {
		await rm(rootDir, { recursive: true, force: true });
	}
});

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Test Bot",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test Bot",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const git = (cwd: string, args: string[]) =>
	execFileAsync(
		"git",
		["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
		{ cwd, env: gitEnv },
	);

const createRepo = async (baseLock: string | Buffer | null) => {
	repoCounter += 1;
	const repoDir = path.join(rootDir, `repo-${repoCounter}`);
	await mkdir(repoDir, { recursive: true });
	await git(repoDir, ["init", "-b", "main"]);
	await writeFile(path.join(repoDir, "package.json"), '{"name":"fixture"}\n');
	if (baseLock !== null) {
		await writeFile(path.join(repoDir, "bun.lock"), baseLock);
	}
	await git(repoDir, ["add", "."]);
	await git(repoDir, ["commit", "-m", "base"]);
	await git(repoDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	return repoDir;
};

const runValidator = async (
	baseLock: string | Buffer | null,
	newLock: string | Buffer,
	lockRelPath = "bun.lock",
) => {
	const repoDir = await createRepo(baseLock);
	await writeFile(path.join(repoDir, lockRelPath), newLock);
	try {
		const { stdout, stderr } = await execFileAsync(
			"python3",
			["-I", script, "main", lockRelPath],
			{ cwd: repoDir },
		);
		return { ok: true, stdout, stderr };
	} catch (error) {
		const { stdout = "", stderr = "" } = error as {
			stdout?: string;
			stderr?: string;
		};
		return { ok: false, stdout, stderr };
	}
};

describe("validate-bun-lock.py", () => {
	it("1. allows normal patch upgrade", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });
		const newLock = makeLock({ hono: pkg("hono@4.13.22", SHA_B) });
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(true);
	});

	it("2. rejects single-copy downgrade", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });
		const newLock = makeLock({ hono: pkg("hono@4.13.19", SHA_B) });
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("::error::bun.lock:");
	});

	it("3. enforces SemVer 2.0.0 prerelease ordering", async () => {
		const stableToRc = await runValidator(
			makeLock({ foo: pkg("foo@1.0.0", SHA_A) }),
			makeLock({ foo: pkg("foo@1.0.0-rc.1", SHA_B) }),
		);
		expect(stableToRc.ok).toBe(false);

		const rcToStable = await runValidator(
			makeLock({ foo: pkg("foo@1.0.0-rc.1", SHA_A) }),
			makeLock({ foo: pkg("foo@1.0.0", SHA_B) }),
		);
		expect(rcToStable.ok).toBe(true);

		const numericPreDowngrade = await runValidator(
			makeLock({ foo: pkg("foo@1.0.0-alpha.10", SHA_A) }),
			makeLock({ foo: pkg("foo@1.0.0-alpha.2", SHA_B) }),
		);
		expect(numericPreDowngrade.ok).toBe(false);
	});

	it("4. allows real @emnapi/runtime hoist when 2.0.0-beta.2 disappears and nested 1.11.3 vacates with matching sha512", async () => {
		const oldLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@2.0.0-beta.2", SHA_EMNAPI_200),
			"@img/sharp-wasm32/@emnapi/runtime": pkg(
				"@emnapi/runtime@1.11.3",
				SHA_EMNAPI_1113,
			),
			"@tailwindcss/oxide-wasm32-wasi/@emnapi/runtime": pkg(
				"@emnapi/runtime@1.11.3",
				SHA_EMNAPI_1113,
				{ bundled: true },
			),
		});
		const newLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@1.11.3", SHA_EMNAPI_1113),
			"@tailwindcss/oxide-wasm32-wasi/@emnapi/runtime": pkg(
				"@emnapi/runtime@1.11.3",
				SHA_EMNAPI_1113,
				{ bundled: true },
			),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(true);
	});

	it("5. allows hoist with patch bump when nested source vacates", async () => {
		const oldLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@2.0.0-beta.2", SHA_EMNAPI_200),
			"@img/sharp-wasm32/@emnapi/runtime": pkg(
				"@emnapi/runtime@1.11.3",
				SHA_EMNAPI_1113,
			),
		});
		const newLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@1.11.4", SHA_B),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(true);
	});

	it("6. rejects hoist with downgrade below vacated nested source", async () => {
		const oldLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@2.0.0-beta.2", SHA_EMNAPI_200),
			"@img/sharp-wasm32/@emnapi/runtime": pkg(
				"@emnapi/runtime@1.11.3",
				SHA_EMNAPI_1113,
			),
		});
		const newLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@1.11.2", SHA_B),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("downgrade forbidden");
	});

	it("7. rejects sha512 integrity mismatch on exact hoist", async () => {
		const oldLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@2.0.0-beta.2", SHA_EMNAPI_200),
			"@img/sharp-wasm32/@emnapi/runtime": pkg(
				"@emnapi/runtime@1.11.3",
				SHA_EMNAPI_1113,
			),
		});
		const newLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@1.11.3", SHA_C),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("Layer 2");
	});

	it("8. rejects hoist when only a bundled copy existed", async () => {
		const oldLock = makeLock({
			"@emnapi/runtime": pkg("@emnapi/runtime@2.0.0-beta.2", SHA_EMNAPI_200),
			"@tailwindcss/oxide-wasm32-wasi/@emnapi/runtime": pkg(
				"@emnapi/runtime@1.11.3",
				SHA_EMNAPI_1113,
				{ bundled: true },
			),
		});

		const keptBundled = await runValidator(
			oldLock,
			makeLock({
				"@emnapi/runtime": pkg("@emnapi/runtime@1.11.3", SHA_EMNAPI_1113),
				"@tailwindcss/oxide-wasm32-wasi/@emnapi/runtime": pkg(
					"@emnapi/runtime@1.11.3",
					SHA_EMNAPI_1113,
					{ bundled: true },
				),
			}),
		);
		expect(keptBundled.ok).toBe(false);

		const removedBundled = await runValidator(
			oldLock,
			makeLock({
				"@emnapi/runtime": pkg("@emnapi/runtime@1.11.3", SHA_EMNAPI_1113),
			}),
		);
		expect(removedBundled.ok).toBe(false);
	});

	it("9. rejects bump-nested + downgrade-root attack", async () => {
		const oldLock = makeLock({
			foo: pkg("foo@1.5.0", SHA_A),
			"bar/foo": pkg("foo@1.0.0", SHA_B),
		});
		const newLock = makeLock({
			foo: pkg("foo@1.0.0", SHA_B),
			"bar/foo": pkg("foo@1.0.1", SHA_C),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
	});

	it("10. rejects delete-nested + downgrade-root attack inside same compat line", async () => {
		const oldLock = makeLock({
			"@opentelemetry/api": pkg("@opentelemetry/api@1.10.0", SHA_A),
			"a/@opentelemetry/api": pkg("@opentelemetry/api@1.9.1", SHA_B),
		});
		const newLock = makeLock({
			"@opentelemetry/api": pkg("@opentelemetry/api@1.9.1", SHA_B),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("Layer 1");
	});

	it("11. rejects single-copy key relocation downgrade within same compat line", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });
		const newLock = makeLock({ "apps/api/hono": pkg("hono@4.13.0", SHA_B) });
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("Layer 1");
	});

	it("12. rejects cross-major relocation downgrade", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });
		const newLock = makeLock({ "apps/api/hono": pkg("hono@3.0.0", SHA_B) });
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("Layer 3");
	});

	it("13. rejects 0.x minor-jump downgrade", async () => {
		const oldLock = makeLock({
			foo: pkg("foo@0.9.5", SHA_A),
			"a/foo": pkg("foo@0.1.0", SHA_B),
		});
		const newLock = makeLock({
			foo: pkg("foo@0.2.0", SHA_C),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("Layer 3");
	});

	it("14. rejects 1 vacated slot excusing 2 downgrades", async () => {
		const oldLock = makeLock({
			foo: pkg("foo@2.0.0", SHA_A),
			"a/foo": pkg("foo@2.0.0", SHA_A),
			"b/foo": pkg("foo@1.0.0", SHA_B),
		});
		const newLock = makeLock({
			foo: pkg("foo@1.0.0", SHA_B),
			"a/foo": pkg("foo@1.0.0", SHA_B),
		});
		const res = await runValidator(oldLock, newLock);
		expect(res.ok).toBe(false);
		expect(res.stderr).toContain("Layer 2");
	});

	it("15. rejects JSONC indentation and multiline smuggling downgrades", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });

		const sixSpaceIndent = `{
  "lockfileVersion": 3,
  "packages": {
      "hono": ["hono@4.13.0", "", {}, "${SHA_B}"],
  },
}
`;
		const indentRes = await runValidator(oldLock, sixSpaceIndent);
		expect(indentRes.ok).toBe(false);

		const multilineArray = `{
  "lockfileVersion": 3,
  "packages": {
    "hono": [
      "hono@4.13.0",
      "",
      {},
      "${SHA_B}",
    ],
  },
}
`;
		const multiRes = await runValidator(oldLock, multilineArray);
		expect(multiRes.ok).toBe(false);
	});

	it("16. rejects SemVer -> non-SemVer tampering and cross-package alias swap", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });

		const toLatest = await runValidator(
			oldLock,
			makeLock({ hono: pkg("hono@latest", SHA_B) }),
		);
		expect(toLatest.ok).toBe(false);

		const toNpmSpec = await runValidator(
			oldLock,
			makeLock({ hono: pkg("hono@npm:evil@1.0.0", SHA_B) }),
		);
		expect(toNpmSpec.ok).toBe(false);

		const toBareNpmAlias = await runValidator(
			oldLock,
			makeLock({ hono: pkg("npm:evil@1.0.0", SHA_B) }),
		);
		expect(toBareNpmAlias.ok).toBe(false);

		const toWorkspace = await runValidator(
			oldLock,
			makeLock({ hono: ["hono@workspace:apps/hono"] }),
		);
		expect(toWorkspace.ok).toBe(false);

		const aliasSwap = await runValidator(
			oldLock,
			makeLock({ hono: pkg("evil-hono@9.9.9", SHA_B) }),
		);
		expect(aliasSwap.ok).toBe(false);
	});

	it("17. allows legitimate dedup into higher version and honest swap", async () => {
		const dedupRes = await runValidator(
			makeLock({
				foo: pkg("foo@1.5.0", SHA_A),
				"a/foo": pkg("foo@1.2.0", SHA_B),
			}),
			makeLock({
				foo: pkg("foo@1.5.0", SHA_A),
			}),
		);
		expect(dedupRes.ok).toBe(true);

		const swapRes = await runValidator(
			makeLock({
				foo: pkg("foo@1.5.0", SHA_A),
				"a/foo": pkg("foo@1.0.0", SHA_B),
			}),
			makeLock({
				foo: pkg("foo@1.0.0", SHA_B),
				"a/foo": pkg("foo@1.5.0", SHA_A),
			}),
		);
		expect(swapRes.ok).toBe(true);
	});

	it("18. rejects new URL injection and allows clean brand-new lockfiles", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });
		const injectedUrl = await runValidator(
			oldLock,
			makeLock({
				hono: pkg("hono@4.13.22", SHA_B),
				evil: ["evil@1.0.0", "https://evil.example/evil-1.0.0.tgz", {}, SHA_C],
			}),
		);
		expect(injectedUrl.ok).toBe(false);
		expect(injectedUrl.stderr).toContain("https://evil.example/evil-1.0.0.tgz");

		const brandNewClean = await runValidator(
			null,
			makeLock({ hono: pkg("hono@4.13.21", SHA_A) }),
		);
		expect(brandNewClean.ok).toBe(true);

		const brandNewWithUrl = await runValidator(
			null,
			makeLock({
				evil: ["evil@1.0.0", "git+https://evil.example/repo.git", {}, SHA_C],
			}),
		);
		expect(brandNewWithUrl.ok).toBe(false);
	});

	it("rejects symlinked bun.lock, NUL bytes, duplicate JSON keys, missing packages, and top-level bundled flip", async () => {
		const oldLock = makeLock({ hono: pkg("hono@4.13.21", SHA_A) });

		// Symlink bun.lock
		const symlinkRepo = await createRepo(oldLock);
		await writeFile(path.join(symlinkRepo, "target.lock"), oldLock);
		await rm(path.join(symlinkRepo, "bun.lock"));
		await symlink("target.lock", path.join(symlinkRepo, "bun.lock"));
		let symlinkOk = true;
		try {
			await execFileAsync("python3", ["-I", script, "main", "bun.lock"], {
				cwd: symlinkRepo,
			});
		} catch (error) {
			symlinkOk = false;
			expect((error as { stderr: string }).stderr).toContain("symlink");
		}
		expect(symlinkOk).toBe(false);

		// NUL byte
		const nulRes = await runValidator(
			oldLock,
			Buffer.concat([Buffer.from(oldLock), Buffer.from([0])]),
		);
		expect(nulRes.ok).toBe(false);
		expect(nulRes.stderr).toContain("NUL byte");

		// Duplicate JSON keys
		const dupKeys = `{
  "lockfileVersion": 3,
  "packages": {
    "hono": ["hono@4.13.22", "", {}, "${SHA_B}"],
    "hono": ["hono@4.13.0", "", {}, "${SHA_C}"],
  },
}
`;
		const dupRes = await runValidator(oldLock, dupKeys);
		expect(dupRes.ok).toBe(false);
		expect(dupRes.stderr).toContain("duplicate key");

		// Missing "packages" section
		const missingPkgs = await runValidator(oldLock, '{"lockfileVersion": 3}\n');
		expect(missingPkgs.ok).toBe(false);
		expect(missingPkgs.stderr).toContain('missing "packages"');

		// Top-level non-bundled -> bundled downgrade bypass
		const bundledBypass = await runValidator(
			oldLock,
			makeLock({ hono: pkg("hono@4.0.0", SHA_B, { bundled: true }) }),
		);
		expect(bundledBypass.ok).toBe(false);
		expect(bundledBypass.stderr).toContain("cannot become bundled");
	});

	it("allows deletion of higher-version nested copies when untouched lower-version spectator stays, while blocking downgrades behind it", async () => {
		const oldLock = makeLock({
			tslib: pkg("tslib@2.8.1", SHA_A),
			"@emnapi/core/tslib": pkg("tslib@2.9.1", SHA_B),
			"@aws-sdk/core/tslib": pkg("tslib@2.9.1", SHA_B),
		});

		// Legitimate removal of @emnapi/core/tslib while tslib@2.8.1 and @aws-sdk/core/tslib@2.9.1 are untouched
		const legitimateRemoval = await runValidator(
			oldLock,
			makeLock({
				tslib: pkg("tslib@2.8.1", SHA_A),
				"@aws-sdk/core/tslib": pkg("tslib@2.9.1", SHA_B),
			}),
		);
		expect(legitimateRemoval.ok).toBe(true);

		// Attack: hiding a relocation downgrade behind untouched tslib@2.8.1
		const hiddenDowngrade = await runValidator(
			oldLock,
			makeLock({
				tslib: pkg("tslib@2.8.1", SHA_A),
				"@aws-sdk/core/tslib": pkg("tslib@2.9.1", SHA_B),
				"evil/tslib": pkg("tslib@2.8.5", SHA_C),
			}),
		);
		expect(hiddenDowngrade.ok).toBe(false);
		expect(hiddenDowngrade.stderr).toContain("Layer 1");
	});

	it("supports --old-file / --new-file standalone CLI mode", async () => {
		const dir = path.join(rootDir, "cli-files");
		await mkdir(dir, { recursive: true });
		const oldPath = path.join(dir, "old.lock");
		const goodPath = path.join(dir, "good.lock");
		const badPath = path.join(dir, "bad.lock");
		await writeFile(oldPath, makeLock({ hono: pkg("hono@4.13.21", SHA_A) }));
		await writeFile(goodPath, makeLock({ hono: pkg("hono@4.13.22", SHA_B) }));
		await writeFile(badPath, makeLock({ hono: pkg("hono@4.13.20", SHA_C) }));

		const goodRes = await execFileAsync("python3", [
			"-I",
			script,
			"--old-file",
			oldPath,
			"--new-file",
			goodPath,
		]);
		expect(goodRes.stderr).toBe("");

		let badOk = true;
		try {
			await execFileAsync("python3", [
				"-I",
				script,
				"--old-file",
				oldPath,
				"--new-file",
				badPath,
			]);
		} catch (error) {
			badOk = false;
			expect((error as { stderr: string }).stderr).toContain("downgrade");
		}
		expect(badOk).toBe(false);
	});
});
