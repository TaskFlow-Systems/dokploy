import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const chain: Record<string, ReturnType<typeof vi.fn>> = {};
	chain.set = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.returning = vi.fn().mockResolvedValue([{}]);
	return {
		chain,
		findFirst: vi.fn(),
		mechanizeDockerContainer: vi.fn(),
		waitForApplicationRollout: vi.fn(),
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: vi.fn(() => mocks.chain),
		query: { applications: { findFirst: mocks.findFirst } },
	},
}));
vi.mock("@dokploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders")
	>("@dokploy/server/utils/builders");
	return {
		...actual,
		mechanizeDockerContainer: mocks.mechanizeDockerContainer,
		waitForApplicationRollout: mocks.waitForApplicationRollout,
	};
});

import { reloadApplication } from "@dokploy/server/services/application";

const application = {
	applicationId: "app-1",
	appName: "web-app",
	serverId: "server-1",
};

const savedStatuses = () =>
	(mocks.chain.set?.mock.calls ?? []).map(
		([values]) => (values as { applicationStatus: string }).applicationStatus,
	);

describe("reloadApplication", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findFirst.mockResolvedValue(application);
		mocks.mechanizeDockerContainer.mockResolvedValue(undefined);
		mocks.waitForApplicationRollout.mockResolvedValue(undefined);
	});

	it("waits for Swarm on the application's server and ends in done", async () => {
		await expect(reloadApplication("app-1")).resolves.toMatchObject({
			applicationId: "app-1",
		});

		expect(mocks.waitForApplicationRollout).toHaveBeenCalledWith(
			"web-app",
			"server-1",
		);
		const [updated = 0] =
			mocks.mechanizeDockerContainer.mock.invocationCallOrder;
		const [waited = 0] =
			mocks.waitForApplicationRollout.mock.invocationCallOrder;
		expect(updated).toBeGreaterThan(0);
		expect(updated).toBeLessThan(waited);
		expect(savedStatuses()).toEqual(["running", "done"]);
	});

	it("sets error and rethrows the reason when the new task does not run", async () => {
		mocks.waitForApplicationRollout.mockRejectedValue(
			new Error("Swarm rolled back the update"),
		);

		await expect(reloadApplication("app-1")).rejects.toThrow(
			"Swarm rolled back the update",
		);
		expect(savedStatuses()).toEqual(["running", "error"]);
	});

	it("sets error when the service cannot be updated, without waiting", async () => {
		mocks.mechanizeDockerContainer.mockRejectedValue(
			new Error("update failed"),
		);

		await expect(reloadApplication("app-1")).rejects.toThrow("update failed");
		expect(mocks.waitForApplicationRollout).not.toHaveBeenCalled();
		expect(savedStatuses()).toEqual(["running", "error"]);
	});
});
