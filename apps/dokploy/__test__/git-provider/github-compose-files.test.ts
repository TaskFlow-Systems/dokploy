import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindGithubById = vi.hoisted(() => vi.fn());
const mockGetBranch = vi.hoisted(() => vi.fn());
const mockGetTree = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: mockFindGithubById,
}));

vi.mock("@octokit/auth-app", () => ({
	createAppAuth: vi.fn(),
}));

vi.mock("octokit", () => ({
	Octokit: class {
		rest = {
			repos: { getBranch: mockGetBranch },
			git: { getTree: mockGetTree },
		};
	},
}));

const { getGithubComposeFiles, isComposeFilePath } = await import(
	"@dokploy/server/utils/providers/github"
);

const input = {
	githubId: "gh-1",
	owner: "acme",
	repo: "web",
	branch: "feature/compose",
};

describe("getGithubComposeFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindGithubById.mockResolvedValue({
			githubId: "gh-1",
			githubUrl: "https://github.com",
			githubAppId: 1,
			githubPrivateKey: "key",
			githubInstallationId: "42",
		});
		mockGetBranch.mockResolvedValue({
			data: { commit: { commit: { tree: { sha: "tree-sha" } } } },
		});
	});

	it("lists compose files of the branch tree, root files first", async () => {
		mockGetTree.mockResolvedValue({
			data: {
				tree: [
					{ path: "deploy/docker-compose.prod.yml", type: "blob" },
					{ path: "docker-compose.yml", type: "blob" },
					{ path: "compose.yaml", type: "blob" },
					{ path: "compose", type: "tree" },
					{ path: ".github/workflows/ci.yml", type: "blob" },
					{ path: "README.md", type: "blob" },
				],
			},
		});

		const files = await getGithubComposeFiles(input);

		expect(mockGetBranch).toHaveBeenCalledWith({
			owner: "acme",
			repo: "web",
			branch: "feature/compose",
		});
		expect(mockGetTree).toHaveBeenCalledWith({
			owner: "acme",
			repo: "web",
			tree_sha: "tree-sha",
			recursive: "true",
		});
		expect(files).toEqual([
			"./compose.yaml",
			"./docker-compose.yml",
			"./deploy/docker-compose.prod.yml",
		]);
	});

	it("returns no files for a missing branch or an empty repository", async () => {
		mockGetBranch.mockRejectedValue(
			Object.assign(new Error("Not Found"), { status: 404 }),
		);

		await expect(getGithubComposeFiles(input)).resolves.toEqual([]);
	});

	it("passes other GitHub errors through", async () => {
		mockGetBranch.mockRejectedValue(
			Object.assign(new Error("Bad credentials"), { status: 401 }),
		);

		await expect(getGithubComposeFiles(input)).rejects.toThrow(
			"Bad credentials",
		);
	});
});

describe("isComposeFilePath", () => {
	it.each([
		"docker-compose.yml",
		"compose.yaml",
		"docker-compose.override.yml",
		"stack/my-compose.dev.YML",
	])("accepts %s", (path) => {
		expect(isComposeFilePath(path)).toBe(true);
	});

	it.each([
		"compose/app.yml",
		"docker-compose.yml.bak",
		".github/workflows/ci.yml",
		"Dockerfile",
	])("rejects %s", (path) => {
		expect(isComposeFilePath(path)).toBe(false);
	});
});
