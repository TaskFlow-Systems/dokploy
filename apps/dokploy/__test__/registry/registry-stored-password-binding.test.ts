import { REDACTED_SECRET_VALUE } from "@dokploy/server/utils/security/redaction";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	execFileAsync: vi.fn(),
	findFirst: vi.fn(),
	returning: vi.fn(),
	set: vi.fn(),
	update: vi.fn(),
	where: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { registry: { findFirst: mocks.findFirst } },
		update: mocks.update,
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	execFileAsync: mocks.execFileAsync,
}));

const { updateRegistry } = await import("@dokploy/server/services/registry");
const { apiUpdateRegistry } = await import("@dokploy/server/db/schema");

const storedRegistry = {
	registryId: "registry-1",
	registryName: "registry",
	registryUrl: "registry.example.com",
	registryType: "cloud" as const,
	username: "deploy",
	imagePrefix: null,
	organizationId: "org-1",
	createdAt: "2026-01-01T00:00:00.000Z",
};

describe("registry update stored password binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findFirst.mockResolvedValue(storedRegistry);
		mocks.update.mockReturnValue({ set: mocks.set });
		mocks.set.mockReturnValue({ where: mocks.where });
		mocks.where.mockReturnValue({ returning: mocks.returning });
		mocks.returning.mockResolvedValue([
			{ ...storedRegistry, password: "stored-password" },
		]);
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
	});

	it.each([
		["registryUrl", { registryUrl: "collector.example.net" }],
		["username", { username: "someone-else" }],
	])(
		"rejects a new %s while keeping the stored password",
		async (_field, change) => {
			await expect(
				updateRegistry("registry-1", {
					registryName: "registry",
					registryUrl: storedRegistry.registryUrl,
					username: storedRegistry.username,
					...change,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("Re-enter the registry password"),
			});

			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.execAsync).not.toHaveBeenCalled();
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			expect(mocks.execFileAsync).not.toHaveBeenCalled();

			await updateRegistry("registry-1", {
				...change,
				password: "new-password",
			});
			expect(mocks.set).toHaveBeenCalledWith(
				expect.objectContaining({ ...change, password: "new-password" }),
			);
		},
	);

	it("treats the redacted placeholder as keeping the stored password", async () => {
		await expect(
			updateRegistry("registry-1", {
				registryUrl: "collector.example.net",
				password: REDACTED_SECRET_VALUE,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.update).not.toHaveBeenCalled();

		await updateRegistry("registry-1", {
			registryName: "renamed",
			registryUrl: storedRegistry.registryUrl,
			password: REDACTED_SECRET_VALUE,
		});
		expect(mocks.set).toHaveBeenCalledWith(
			expect.not.objectContaining({ password: REDACTED_SECRET_VALUE }),
		);
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ registryName: "renamed" }),
		);
	});

	it("does not accept organizationId in the update input", () => {
		const parsed = apiUpdateRegistry.parse({
			registryId: "registry-1",
			organizationId: "org-2",
		});

		expect(parsed).not.toHaveProperty("organizationId");
	});
});
