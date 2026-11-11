import { shouldDeploy } from "@dokploy/server";
import {
	apiSaveGithubProvider,
	apiSaveGitProvider,
	apiUpdateCompose,
} from "@dokploy/server/db/schema";
import { describe, expect, it, vi } from "vitest";

describe("shouldDeploy", () => {
	it("should deploy when no watch paths are configured", () => {
		expect(shouldDeploy(null, ["src/index.ts"])).toBe(true);
		expect(shouldDeploy([], ["src/index.ts"])).toBe(true);
	});

	it("should deploy when watch paths match modified files", () => {
		expect(shouldDeploy(["src/**"], ["src/index.ts"])).toBe(true);
		expect(shouldDeploy(["apps/web/**"], ["apps/web/page.tsx"])).toBe(true);
	});

	it("should not deploy when watch paths do not match", () => {
		expect(shouldDeploy(["src/**"], ["docs/readme.md"])).toBe(false);
	});

	it("should apply multiple negated watch paths as one pattern set", () => {
		const watchPaths = ["!CHANGELOG.md", "!VERSION", "!tests/**"];

		expect(shouldDeploy(watchPaths, ["CHANGELOG.md"])).toBe(false);
		expect(shouldDeploy(watchPaths, ["VERSION"])).toBe(false);
		expect(shouldDeploy(watchPaths, ["tests/unit/example.test.ts"])).toBe(
			false,
		);
	});

	it("should deploy when a changed file remains after exclusions", () => {
		const watchPaths = ["!CHANGELOG.md", "!VERSION", "!tests/**"];

		expect(shouldDeploy(watchPaths, ["VERSION", "src/index.ts"])).toBe(true);
	});

	it("should combine positive and negated watch paths", () => {
		const watchPaths = ["src/**", "!src/**/*.test.ts"];

		expect(shouldDeploy(watchPaths, ["src/index.ts"])).toBe(true);
		expect(shouldDeploy(watchPaths, ["src/index.test.ts"])).toBe(false);
		expect(shouldDeploy(watchPaths, ["docs/readme.md"])).toBe(false);
	});

	it("should not throw when modified files contain non-string values", () => {
		expect(() =>
			shouldDeploy(["src/**"], ["src/index.ts", undefined, null] as any),
		).not.toThrow();
		expect(
			shouldDeploy(["src/**"], ["src/index.ts", undefined, null] as any),
		).toBe(true);
	});

	it("should not throw when modified files are undefined or null", () => {
		expect(() => shouldDeploy(["src/**"], undefined)).not.toThrow();
		expect(() => shouldDeploy(["src/**"], null)).not.toThrow();
		expect(shouldDeploy(["src/**"], undefined)).toBe(false);
		expect(shouldDeploy(["src/**"], null)).toBe(false);
	});

	it("should not throw when every modified file is non-string", () => {
		expect(() =>
			shouldDeploy(["src/**"], [undefined, undefined] as any),
		).not.toThrow();
		expect(shouldDeploy(["src/**"], [undefined, undefined] as any)).toBe(false);
	});
});

describe("shouldDeploy limits", () => {
	const nested = (depth: number) => `${"{".repeat(depth)}a${"}".repeat(depth)}`;

	it("does not parse an oversized pattern and deploys", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const started = performance.now();

		expect(shouldDeploy([nested(20000)], ["docs/readme.md"])).toBe(true);
		expect(performance.now() - started).toBeLessThan(200);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("deploys when there are more watch paths than allowed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const paths = Array.from({ length: 65 }, (_, i) => `dir${i}/**`);

		expect(shouldDeploy(paths, ["docs/readme.md"])).toBe(true);
		warn.mockRestore();
	});

	it("still evaluates a pattern of exactly the largest allowed size", () => {
		const longest = "a".repeat(256);

		expect(shouldDeploy([longest], ["docs/readme.md"])).toBe(false);
		expect(shouldDeploy([longest], [longest])).toBe(true);
	});

	it("deploys instead of throwing when the matcher rejects a pattern", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(shouldDeploy(["src/**", ""], ["docs/readme.md"])).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe("watch paths in the API schemas", () => {
	const github = {
		repository: "repo",
		branch: "main",
		owner: "owner",
		buildPath: "/",
		githubId: "gh",
		triggerType: "push" as const,
		enableSubmodules: false,
	};

	it("accept ordinary globs", () => {
		const result = apiSaveGithubProvider.safeParse({
			...github,
			applicationId: "app",
			watchPaths: ["src/**", "!src/**/*.test.ts", "{apps,packages}/*/src/**"],
		});

		expect(result.success).toBe(true);
	});

	it("refuse a pattern over the size limit", () => {
		const result = apiSaveGithubProvider.safeParse({
			...github,
			applicationId: "app",
			watchPaths: ["src/**", "x".repeat(257)],
		});

		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path[0]).toBe("watchPaths");
		expect(result.error?.issues[0]?.message).toContain("at most 256");
	});

	it("refuse too many watch paths", () => {
		const result = apiUpdateCompose.safeParse({
			composeId: "compose",
			watchPaths: Array.from({ length: 65 }, (_, i) => `dir${i}/**`),
		});

		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path[0]).toBe("watchPaths");
	});

	it("apply to the generic git provider and accept a cleared list", () => {
		const git = {
			applicationId: "app",
			customGitUrl: "https://example.com/r.git",
			customGitBranch: "main",
			customGitBuildPath: "/",
			enableSubmodules: false,
		};
		const tooLong = apiSaveGitProvider.safeParse({
			...git,
			watchPaths: ["a".repeat(300)],
		});

		expect(tooLong.success).toBe(false);
		expect(tooLong.error?.issues[0]?.path[0]).toBe("watchPaths");
		expect(
			apiSaveGitProvider.safeParse({ ...git, watchPaths: ["src/**"] }).success,
		).toBe(true);
		expect(
			apiUpdateCompose.safeParse({ composeId: "compose", watchPaths: null })
				.success,
		).toBe(true);
	});
});
