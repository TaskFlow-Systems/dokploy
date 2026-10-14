import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type {
	apiFindGithubBranches,
	apiFindGithubComposeFiles,
} from "@dokploy/server/db/schema";
import { findGithubById, type Github } from "@dokploy/server/services/github";
import type { InferResultType } from "@dokploy/server/types/with";
import { createAppAuth } from "@octokit/auth-app";
import { TRPCError } from "@trpc/server";
import { Octokit } from "octokit";
import type { z } from "zod";
import {
	buildCreateDirectoryCommand,
	buildGitCloneCommand,
	buildProviderEchoCommand,
	buildRemovePathCommand,
} from "./commands";

export const DEFAULT_GITHUB_URL = "https://github.com";
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

export const parseGithubBaseUrl = (
	githubUrl?: string | null,
): { url: string } | { error: string } => {
	const raw = githubUrl?.trim();
	if (!raw) {
		return { url: DEFAULT_GITHUB_URL };
	}

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
		? raw
		: `https://${raw}`;

	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return { error: `"${raw}" is not a valid URL` };
	}

	if (parsed.protocol !== "https:") {
		return { error: "Only https is supported for GitHub instances" };
	}

	// "acme.ghe.com." resolves the same as "acme.ghe.com", but the trailing dot
	// would slip past the checks below.
	if (parsed.hostname.endsWith(".")) {
		parsed.hostname = parsed.hostname.replace(/\.+$/, "");
	}

	const { hostname } = parsed;

	if (!hostname.includes(".")) {
		return { error: `"${hostname}" is not a fully qualified hostname` };
	}

	return { url: `${parsed.protocol}//${parsed.host}` };
};

export const normalizeGithubUrl = (githubUrl?: string | null): string => {
	const result = parseGithubBaseUrl(githubUrl);
	return "url" in result ? result.url : DEFAULT_GITHUB_URL;
};

export const deriveGithubApiUrl = (githubUrl?: string | null): string => {
	const normalized = normalizeGithubUrl(githubUrl);
	const { protocol, host } = new URL(normalized);

	if (host === "github.com" || host === "www.github.com") {
		return DEFAULT_GITHUB_API_URL;
	}

	// Data residency tenants keep the api. prefix; GHES does not have one.
	if (host === "ghe.com" || host.endsWith(".ghe.com")) {
		return `${protocol}//api.${host}`;
	}

	return `${protocol}//${host}/api/v3`;
};

export const authGithub = (githubProvider: Github): Octokit => {
	if (!haveGithubRequirements(githubProvider)) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Github Account not configured correctly",
		});
	}

	const octokit: Octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider?.githubAppId || 0,
			privateKey: githubProvider?.githubPrivateKey || "",
			installationId: githubProvider?.githubInstallationId,
		},
		baseUrl: deriveGithubApiUrl(githubProvider?.githubUrl),
	});

	return octokit;
};

export const getGithubToken = async (
	octokit: ReturnType<typeof authGithub>,
) => {
	const installation = (await octokit.auth({
		type: "installation",
	})) as {
		token: string;
	};

	return installation.token;
};

/**
 * Check if a GitHub user has write/admin permissions on a repository
 * This is used to validate PR authors before allowing preview deployments
 */
export const checkUserRepositoryPermissions = async (
	githubProvider: Github,
	owner: string,
	repo: string,
	username: string,
): Promise<{ hasWriteAccess: boolean; permission: string | null }> => {
	try {
		const octokit = authGithub(githubProvider);

		// Check if user is a collaborator with write permissions
		const { data: permission } =
			await octokit.rest.repos.getCollaboratorPermissionLevel({
				owner,
				repo,
				username,
			});

		// Allow only users with 'write', 'admin', or 'maintain' permissions
		// Currently exists Read, Triage, Write, Maintain, Admin
		const allowedPermissions = ["write", "admin", "maintain"];
		const hasWriteAccess = allowedPermissions.includes(permission.permission);

		return {
			hasWriteAccess,
			permission: permission.permission,
		};
	} catch (error) {
		// If user is not a collaborator, GitHub API returns 404
		console.warn(
			`User ${username} is not a collaborator of ${owner}/${repo}:`,
			error,
		);
		return {
			hasWriteAccess: false,
			permission: null,
		};
	}
};

export const haveGithubRequirements = (githubProvider: Github) => {
	return !!(
		githubProvider?.githubAppId &&
		githubProvider?.githubPrivateKey &&
		githubProvider?.githubInstallationId
	);
};

const getErrorCloneRequirements = (entity: {
	repository?: string | null;
	owner?: string | null;
	branch?: string | null;
}) => {
	const reasons: string[] = [];
	const { repository, owner, branch } = entity;

	if (!repository) reasons.push("1. Repository not assigned.");
	if (!owner) reasons.push("2. Owner not specified.");
	if (!branch) reasons.push("3. Branch not defined.");

	return reasons;
};

export type ApplicationWithGithub = InferResultType<
	"applications",
	{ github: true }
>;

export type ComposeWithGithub = InferResultType<"compose", { github: true }>;

interface CloneGithubRepository {
	appName: string;
	owner: string | null;
	branch: string | null;
	githubId: string | null;
	repository: string | null;
	type?: "application" | "compose";
	enableSubmodules: boolean;
	serverId: string | null;
	outputPathOverride?: string;
	checkoutRevision?: string;
}
export const cloneGithubRepository = async ({
	type = "application",
	...entity
}: CloneGithubRepository) => {
	let command = "set -e;";
	const isCompose = type === "compose";
	const {
		appName,
		repository,
		owner,
		branch,
		githubId,
		enableSubmodules,
		serverId,
		outputPathOverride,
		checkoutRevision,
	} = entity;
	const { APPLICATIONS_PATH, COMPOSE_PATH } = paths(!!serverId);

	if (!githubId) {
		command += `${buildProviderEchoCommand("Error: ❌ Github Provider not found")} exit 1;`;

		return command;
	}

	const requirements = getErrorCloneRequirements(entity);

	// Check if requirements are met
	if (requirements.length > 0) {
		command += buildProviderEchoCommand(
			`GitHub Repository configuration failed for application: ${appName}`,
		);
		command += buildProviderEchoCommand("Reasons:");
		command += `${buildProviderEchoCommand(requirements.join("\n"))} exit 1;`;
		return command;
	}

	const githubProvider = await findGithubById(githubId);
	const basePath = isCompose ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = outputPathOverride ?? join(basePath, appName, "code");
	const octokit = authGithub(githubProvider);
	const token = await getGithubToken(octokit);
	const cloneBase = new URL(normalizeGithubUrl(githubProvider.githubUrl));
	const repoclone = `${cloneBase.host}/${owner}/${repository}.git`;
	command += buildRemovePathCommand(outputPath);
	command += buildCreateDirectoryCommand(outputPath);
	const cloneUrl = `${cloneBase.protocol}//${repoclone}`;

	command += buildProviderEchoCommand(
		`Cloning Repo ${repoclone} to ${outputPath}: ✅`,
	);
	command += `${buildGitCloneCommand({
		branch: branch!,
		checkoutRevision,
		cloneUrl,
		credentials: { username: "oauth2", password: token },
		enableSubmodules,
		outputPath,
	})};`;

	return command;
};

export const getGithubRepositories = async (githubId?: string) => {
	if (!githubId) {
		return [];
	}

	const githubProvider = await findGithubById(githubId);

	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider.githubAppId,
			privateKey: githubProvider.githubPrivateKey,
			installationId: githubProvider.githubInstallationId,
		},
		baseUrl: deriveGithubApiUrl(githubProvider.githubUrl),
	});

	const repositories = (await octokit.paginate(
		octokit.rest.apps.listReposAccessibleToInstallation,
	)) as unknown as Awaited<
		ReturnType<typeof octokit.rest.apps.listReposAccessibleToInstallation>
	>["data"]["repositories"];

	return repositories;
};

export const getGithubBranches = async (
	input: z.infer<typeof apiFindGithubBranches>,
) => {
	if (!input.githubId) {
		return [];
	}
	const githubProvider = await findGithubById(input.githubId);

	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider.githubAppId,
			privateKey: githubProvider.githubPrivateKey,
			installationId: githubProvider.githubInstallationId,
		},
		baseUrl: deriveGithubApiUrl(githubProvider.githubUrl),
	});

	const branches = (await octokit.paginate(octokit.rest.repos.listBranches, {
		owner: input.owner,
		repo: input.repo,
	})) as unknown as Awaited<
		ReturnType<typeof octokit.rest.repos.listBranches>
	>["data"];

	return branches;
};

const COMPOSE_FILE_REGEX = /(^|\/)[^/]*compose[^/]*\.ya?ml$/i;

export const isComposeFilePath = (path: string) =>
	COMPOSE_FILE_REGEX.test(path);

// Paths are returned in the "./dir/file.yml" form the Compose Path field
// already uses, compose files closest to the repository root first.
export const getGithubComposeFiles = async (
	input: z.infer<typeof apiFindGithubComposeFiles>,
) => {
	const githubProvider = await findGithubById(input.githubId);
	const octokit = authGithub(githubProvider);

	try {
		const { data: branch } = await octokit.rest.repos.getBranch({
			owner: input.owner,
			repo: input.repo,
			branch: input.branch,
		});
		const { data: tree } = await octokit.rest.git.getTree({
			owner: input.owner,
			repo: input.repo,
			tree_sha: branch.commit.commit.tree.sha,
			recursive: "true",
		});

		return tree.tree
			.filter(
				(entry) =>
					entry.type === "blob" &&
					!!entry.path &&
					isComposeFilePath(entry.path),
			)
			.map((entry) => entry.path as string)
			.sort(
				(a, b) =>
					a.split("/").length - b.split("/").length || a.localeCompare(b),
			)
			.map((path) => `./${path}`);
	} catch (error) {
		// An empty repository or a branch that was just deleted has no tree;
		// the field still accepts a typed path.
		if ((error as { status?: number }).status === 404) {
			return [];
		}
		throw error;
	}
};
