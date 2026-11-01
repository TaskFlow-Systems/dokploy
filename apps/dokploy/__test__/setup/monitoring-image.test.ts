import {
	FORK_MONITORING_IMAGE,
	getMonitoringImage,
	setupMonitoring,
	setupWebMonitoring,
} from "@dokploy/server/setup/monitoring-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ServiceOptions = {
	TaskTemplate?: { ContainerSpec?: { Image?: string } };
};

const mocks = vi.hoisted(() => {
	const createService = vi.fn<(options: ServiceOptions) => Promise<unknown>>(
		async () => undefined,
	);
	const docker = {
		getContainer: vi.fn(() => ({
			remove: vi.fn(async () => {
				throw Object.assign(new Error("no such container"), {
					statusCode: 404,
				});
			}),
		})),
		getService: vi.fn(() => ({
			inspect: vi.fn(async () => {
				throw Object.assign(new Error("service not found"), {
					statusCode: 404,
				});
			}),
		})),
		createService,
	};
	return {
		docker,
		createService,
		pullImage: vi.fn(async () => undefined),
		pullRemoteImage: vi.fn(async () => undefined),
	};
});

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => ({
		serverId: "server-1",
		metricsConfig: {},
	})),
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => ({
		metricsConfig: { server: { port: 4500 } },
	})),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImage: mocks.pullImage,
	pullRemoteImage: mocks.pullRemoteImage,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => ({ stdout: "", stderr: "" })),
	execAsyncRemote: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => mocks.docker),
}));

const deployedImage = () =>
	mocks.createService.mock.calls[0]?.[0]?.TaskTemplate?.ContainerSpec?.Image;

describe("monitoring image", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("DOKPLOY_MONITORING_IMAGE", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("defaults to the fork's GHCR image", () => {
		expect(FORK_MONITORING_IMAGE).toBe(
			"ghcr.io/agenthits/dokploy-monitoring:agenthits-dev",
		);
		expect(getMonitoringImage()).toBe(FORK_MONITORING_IMAGE);
	});

	it("takes DOKPLOY_MONITORING_IMAGE from the panel's environment", () => {
		vi.stubEnv("DOKPLOY_MONITORING_IMAGE", " dokploy/monitoring:canary ");
		expect(getMonitoringImage()).toBe("dokploy/monitoring:canary");
	});

	it("ignores a blank DOKPLOY_MONITORING_IMAGE", () => {
		vi.stubEnv("DOKPLOY_MONITORING_IMAGE", "   ");
		expect(getMonitoringImage()).toBe(FORK_MONITORING_IMAGE);
	});

	it("pulls and runs the fork image on a remote server", async () => {
		await setupMonitoring("server-1");

		expect(mocks.pullRemoteImage).toHaveBeenCalledWith(
			FORK_MONITORING_IMAGE,
			"server-1",
		);
		expect(deployedImage()).toBe(FORK_MONITORING_IMAGE);
	});

	it("pulls and runs the fork image on the panel host", async () => {
		await setupWebMonitoring();

		expect(mocks.pullImage).toHaveBeenCalledWith(FORK_MONITORING_IMAGE);
		expect(deployedImage()).toBe(FORK_MONITORING_IMAGE);
	});
});
