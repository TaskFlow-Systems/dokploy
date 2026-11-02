import { compose } from "@dokploy/server/db/schema";
import {
	deployCompose,
	upsertComposeEnvironment,
} from "@dokploy/server/services/compose";
import { getComposeEnvRevision } from "@dokploy/server/utils/env-upsert";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
	const returning = vi.fn();
	const where = vi.fn((_condition: unknown) => ({ returning }));
	const set = vi.fn(() => ({ where }));
	const update = vi.fn(() => ({ set }));
	const findFirst = vi.fn();
	const lockForUpdate = vi.fn();
	const selectWhere = vi.fn(() => ({ for: lockForUpdate }));
	const from = vi.fn(() => ({ where: selectWhere }));
	const select = vi.fn(() => ({ from }));
	const transaction = vi.fn(
		async (
			callback: (tx: {
				select: typeof select;
				update: typeof update;
			}) => unknown,
		) => callback({ select, update }),
	);
	return {
		findFirst,
		lockForUpdate,
		returning,
		select,
		set,
		transaction,
		update,
		where,
	};
});

const exactMocks = vi.hoisted(() => ({
	cloneGitRepository: vi.fn(() => "clone;"),
	createDeploymentCompose: vi.fn(),
	execAsync: vi.fn(),
	finalizeDeploymentOperation: vi.fn(),
	findComposeDeploymentOperation: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
	getBuildComposeCommand: vi.fn(),
	getDokployUrl: vi.fn(() => "https://dokploy.example"),
	getGitCommitInfo: vi.fn(),
	linkDeploymentOperation: vi.fn(),
	resolveDeploymentOperationRevision: vi.fn(),
	sendBuildErrorNotifications: vi.fn(),
	sendBuildSuccessNotifications: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { compose: { findFirst: dbMocks.findFirst } },
		transaction: dbMocks.transaction,
		update: dbMocks.update,
	},
}));

vi.mock("@dokploy/server/utils/builders/compose", () => ({
	getBuildComposeCommand: exactMocks.getBuildComposeCommand,
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: exactMocks.sendBuildErrorNotifications,
}));
vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: exactMocks.sendBuildSuccessNotifications,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	ExecError: class ExecError extends Error {},
	execAsync: exactMocks.execAsync,
	execAsyncRemote: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/git", () => ({
	cloneGitRepository: exactMocks.cloneGitRepository,
	getGitCommitInfo: exactMocks.getGitCommitInfo,
}));
vi.mock("@dokploy/server/utils/providers/bitbucket", () => ({
	cloneBitbucketRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/gitea", () => ({
	cloneGiteaRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	cloneGithubRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/gitlab", () => ({
	cloneGitlabRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: vi.fn(),
}));
vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: exactMocks.getDokployUrl,
}));
vi.mock("../../../../packages/server/src/services/deployment", () => ({
	createDeploymentCompose: exactMocks.createDeploymentCompose,
	finalizeDeploymentOperation: exactMocks.finalizeDeploymentOperation,
	findComposeDeploymentOperation: exactMocks.findComposeDeploymentOperation,
	linkDeploymentOperation: exactMocks.linkDeploymentOperation,
	resolveDeploymentOperationRevision:
		exactMocks.resolveDeploymentOperationRevision,
	updateDeployment: exactMocks.updateDeployment,
	updateDeploymentStatus: exactMocks.updateDeploymentStatus,
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: exactMocks.generateApplyPatchesCommand,
}));

describe("upsertComposeEnvironment", () => {
	const lockedRow = (env: string | null) =>
		dbMocks.lockForUpdate.mockResolvedValue([{ env }]);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("preserves unrelated comments and secret lines while returning metadata only", async () => {
		const currentEnv =
			"# keep this\nAPI_URL=https://old.example\nREDIS_PASSWORD=secret-canary\n";
		lockedRow(currentEnv);

		const result = await upsertComposeEnvironment({
			composeId: "compose_1",
			variables: { API_URL: "https://new.example", REDIS_HOST: "redis-dev" },
			expectedRevision: getComposeEnvRevision("compose_1", currentEnv),
		});

		expect(dbMocks.set).toHaveBeenCalledWith({
			env: "# keep this\nAPI_URL=https://new.example\nREDIS_PASSWORD=secret-canary\nREDIS_HOST=redis-dev\n",
		});
		expect(JSON.stringify(result)).not.toContain("secret-canary");
		expect(JSON.stringify(result)).not.toContain("https://new.example");
		expect(result.variables).toEqual([
			{ name: "API_URL", action: "updated", secret: false },
			{ name: "REDIS_HOST", action: "created", secret: false },
		]);
	});

	it("dry run returns current revision and performs no write", async () => {
		const currentEnv = "A=one";
		lockedRow(currentEnv);
		const result = await upsertComposeEnvironment({
			composeId: "compose_1",
			variables: { A: "two" },
			dryRun: true,
		});
		expect(result.revision).toBe(
			getComposeEnvRevision("compose_1", currentEnv),
		);
		expect(dbMocks.update).not.toHaveBeenCalled();
	});

	it("rejects a stale revision without writing", async () => {
		lockedRow("A=one");
		await expect(
			upsertComposeEnvironment({
				composeId: "compose_1",
				variables: { A: "two" },
				expectedRevision: "compose-env-v1:stale",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(dbMocks.update).not.toHaveBeenCalled();
	});

	it("locks the compose row for the read-check-write cycle", async () => {
		const currentEnv = "A=one";
		lockedRow(currentEnv);
		await upsertComposeEnvironment({
			composeId: "compose_1",
			variables: { A: "two" },
			expectedRevision: getComposeEnvRevision("compose_1", currentEnv),
		});
		expect(dbMocks.lockForUpdate).toHaveBeenCalledWith("update");
	});

	it("keys the write by composeId only and never compares the encrypted env column", async () => {
		const currentEnv = "A=one";
		lockedRow(currentEnv);
		await upsertComposeEnvironment({
			composeId: "compose_1",
			variables: { A: "two" },
			expectedRevision: getComposeEnvRevision("compose_1", currentEnv),
		});

		expect(dbMocks.where).toHaveBeenCalledTimes(1);
		const condition = dbMocks.where.mock.calls[0]?.[0] as SQL;
		const { sql, params } = new PgDialect().sqlToQuery(condition);
		expect(sql).toContain(`"${compose.composeId.name}"`);
		expect(sql).not.toContain(`"${compose.env.name}"`);
		expect(params).toEqual(["compose_1"]);
	});

	it("rejects an unknown compose without writing", async () => {
		dbMocks.lockForUpdate.mockResolvedValue([]);
		await expect(
			upsertComposeEnvironment({
				composeId: "missing",
				variables: { A: "two" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dbMocks.update).not.toHaveBeenCalled();
	});

	it.each([
		"prefix__DOKPLOY_REDACTED_SECRET__suffix",
		"prefix[REDACTED]suffix",
	])("rejects placeholder value %s before lookup or write", async (value) => {
		await expect(
			upsertComposeEnvironment({
				composeId: "compose_1",
				variables: { API_TOKEN: value },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(dbMocks.transaction).not.toHaveBeenCalled();
		expect(dbMocks.select).not.toHaveBeenCalled();
		expect(dbMocks.findFirst).not.toHaveBeenCalled();
		expect(dbMocks.update).not.toHaveBeenCalled();
	});
});

describe("deployCompose exact revision guard", () => {
	const requestedRevision = "0123456789abcdef0123456789abcdef01234567";
	const composeFixture = {
		composeId: "compose_1",
		appName: "compose-app",
		name: "Compose",
		env: "A=one",
		sourceType: "git" as const,
		serverId: null,
		environmentId: "environment-1",
		environment: {
			projectId: "project-1",
			name: "Environment",
			project: { name: "Project", organizationId: "organization-1" },
		},
		domains: [],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		dbMocks.returning.mockResolvedValue([{ composeId: "compose_1" }]);
		dbMocks.findFirst.mockResolvedValue(composeFixture);
		exactMocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "operation-1",
			composeId: "compose_1",
			sourceRevision: requestedRevision,
			envRevision: getComposeEnvRevision("compose_1", "A=one"),
		});
		exactMocks.execAsync
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: `${"f".repeat(40)}\n` });
	});

	it("fails a moved branch before patch, build, or deployment side effects", async () => {
		await expect(
			deployCompose({
				composeId: "compose_1",
				titleLog: "Exact deployment",
				descriptionLog: "",
				operationId: "operation-1",
				expectedRevision: requestedRevision,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(exactMocks.createDeploymentCompose).not.toHaveBeenCalled();
		expect(exactMocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(exactMocks.getBuildComposeCommand).not.toHaveBeenCalled();
		expect(
			exactMocks.resolveDeploymentOperationRevision,
		).not.toHaveBeenCalled();
		expect(exactMocks.finalizeDeploymentOperation).toHaveBeenCalledWith(
			"operation-1",
			"failed",
		);
		expect(dbMocks.set).toHaveBeenCalledWith({ composeStatus: "error" });
	});

	it("fetches the exact revision inside the authenticated clone command", async () => {
		await expect(
			deployCompose({
				composeId: "compose_1",
				titleLog: "Exact deployment",
				descriptionLog: "",
				operationId: "operation-1",
				expectedRevision: requestedRevision,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(exactMocks.cloneGitRepository).toHaveBeenCalledWith(
			expect.objectContaining({ checkoutRevision: requestedRevision }),
		);
		const verifyCommand = exactMocks.execAsync.mock.calls
			.map(([command]) => String(command))
			.at(-1);
		// The stored remote carries no credentials, so a separate fetch would
		// fail for private repositories.
		expect(verifyCommand).not.toContain("fetch");
		expect(verifyCommand).toContain("rev-parse");
	});

	it("keeps successful deployment state when terminal finalization is ambiguous", async () => {
		vi.clearAllMocks();
		exactMocks.execAsync.mockReset();
		dbMocks.returning.mockResolvedValue([{ composeId: "compose_1" }]);
		dbMocks.findFirst.mockResolvedValue(composeFixture);
		exactMocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "operation-1",
			composeId: "compose_1",
			sourceRevision: requestedRevision,
			envRevision: getComposeEnvRevision("compose_1", "A=one"),
		});
		exactMocks.execAsync
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: `${requestedRevision}\n` })
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "" });
		exactMocks.createDeploymentCompose.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
		});
		exactMocks.generateApplyPatchesCommand.mockResolvedValue("patch;");
		exactMocks.getBuildComposeCommand.mockResolvedValue("build;");
		exactMocks.finalizeDeploymentOperation.mockRejectedValue(
			new Error("update committed but response and read-back failed"),
		);
		exactMocks.sendBuildSuccessNotifications.mockResolvedValue(undefined);

		await expect(
			deployCompose({
				composeId: "compose_1",
				titleLog: "Exact deployment",
				descriptionLog: "",
				operationId: "operation-1",
				expectedRevision: requestedRevision,
			}),
		).rejects.toThrow(
			"Exact deployment operation-1 terminal state is ambiguous",
		);

		expect(exactMocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-1",
			"done",
		);
		expect(exactMocks.updateDeploymentStatus).not.toHaveBeenCalledWith(
			"deployment-1",
			"error",
		);
		expect(dbMocks.set).toHaveBeenCalledWith({ composeStatus: "done" });
		expect(dbMocks.set).not.toHaveBeenCalledWith({ composeStatus: "error" });
		expect(exactMocks.sendBuildErrorNotifications).not.toHaveBeenCalled();
	});
});
