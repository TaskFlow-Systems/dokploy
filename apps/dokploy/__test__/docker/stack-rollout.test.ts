import { waitForStackRollout } from "@dokploy/server/utils/docker/stack-rollout";
import { ServiceConvergenceError } from "@dokploy/server/utils/docker/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listServices: vi.fn(),
	wait: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: async () => ({ listServices: mocks.listServices }),
}));

vi.mock("@dokploy/server/utils/docker/utils", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/docker/utils")
	>()),
	waitForSwarmServiceConvergence: mocks.wait,
}));

const service = (
	name: string,
	mode: object = { Replicated: { Replicas: 1 } },
) => ({
	Spec: { Name: name, Mode: mode },
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.wait.mockResolvedValue(undefined);
});

describe("waitForStackRollout", () => {
	it("asks only for the services of this stack", async () => {
		mocks.listServices.mockResolvedValue([]);

		await expect(waitForStackRollout("shop", "server-1")).resolves.toBe(0);

		const [options] = mocks.listServices.mock.calls[0] ?? [];
		expect(JSON.parse(options.filters)).toEqual({
			label: ["com.docker.stack.namespace=shop"],
		});
		expect(options.abortSignal).toBeInstanceOf(AbortSignal);
		expect(mocks.wait).not.toHaveBeenCalled();
	});

	it("waits on the stack's server for every service but its jobs", async () => {
		mocks.listServices.mockResolvedValue([
			service("shop_web"),
			service("shop_all", { Global: {} }),
			service("shop_migrate", { ReplicatedJob: {} }),
			service("shop_clean", { GlobalJob: {} }),
		]);

		await expect(waitForStackRollout("shop", "server-1")).resolves.toBe(2);

		expect(
			mocks.wait.mock.calls.map(([name, server]) => [name, server]),
		).toEqual([
			["shop_web", "server-1"],
			["shop_all", "server-1"],
		]);
	});

	it("gives a stack the allowance of an application, for pulls and health checks", async () => {
		mocks.listServices.mockResolvedValue([service("shop_web")]);

		await waitForStackRollout("shop");

		expect(mocks.wait.mock.calls[0]?.[2]).toMatchObject({
			quietStartAllowanceMs: 600_000,
		});
	});

	it("reports every failed service, not only the first", async () => {
		mocks.listServices.mockResolvedValue([
			service("shop_a"),
			service("shop_b"),
			service("shop_c"),
		]);
		mocks.wait.mockImplementation(async (name: string) => {
			if (name !== "shop_b") throw new Error(`${name} rolled back`);
		});

		const failure = await waitForStackRollout("shop").catch((error) => error);

		expect(failure).toBeInstanceOf(ServiceConvergenceError);
		expect(failure.message).toContain("shop_a rolled back");
		expect(failure.message).toContain("shop_c rolled back");
		expect(failure.message).not.toContain("shop_b");
		expect(mocks.wait).toHaveBeenCalledTimes(3);
	});

	it("keeps few waits open at once, since each read over SSH is a connection", async () => {
		mocks.listServices.mockResolvedValue(
			Array.from({ length: 11 }, (_, index) => service(`shop_${index}`)),
		);
		let open = 0;
		let most = 0;
		mocks.wait.mockImplementation(async () => {
			open += 1;
			most = Math.max(most, open);
			await new Promise((resolve) => setTimeout(resolve, 5));
			open -= 1;
		});

		await expect(waitForStackRollout("shop")).resolves.toBe(11);

		expect(most).toBe(4);
		expect(mocks.wait).toHaveBeenCalledTimes(11);
	});

	it("tries a failed list again, because the specs are written by then", async () => {
		mocks.listServices
			.mockRejectedValueOnce(new Error("connection lost"))
			.mockResolvedValueOnce([service("shop_web")]);

		await expect(
			waitForStackRollout("shop", null, { intervalMs: 1 }),
		).resolves.toBe(1);
	});

	it("gives up on the list at the limit and says why", async () => {
		mocks.listServices.mockRejectedValue(new Error("connection lost"));

		const failure = await waitForStackRollout("shop", null, {
			intervalMs: 1,
			timeoutMs: 5,
		}).catch((error) => error);

		expect(failure).toBeInstanceOf(ServiceConvergenceError);
		expect(failure.message).toContain("stack shop");
		expect(failure.message).toContain("connection lost");
	});
});
