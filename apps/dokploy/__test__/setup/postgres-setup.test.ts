import { PINNED_VERSIONS } from "@dokploy/server/setup/component-versions";
import { initializePostgres } from "@dokploy/server/setup/postgres-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

const image = `postgres:${PINNED_VERSIONS.postgres}`;

type ServiceOptions = {
	version?: number;
	TaskTemplate?: {
		ContainerSpec?: {
			Image?: string;
			Env?: string[];
			Mounts?: Array<{ Type?: string; Source?: string; Target?: string }>;
		};
	};
};

const {
	getServiceMock,
	inspectMock,
	updateMock,
	createServiceMock,
	pullImageMock,
} = vi.hoisted(() => {
	const inspect = vi.fn<() => Promise<unknown>>();
	const update = vi.fn<(options: ServiceOptions) => Promise<unknown>>(
		async () => undefined,
	);
	const createService = vi.fn<(options: ServiceOptions) => Promise<unknown>>(
		async () => undefined,
	);
	const getService = vi.fn(() => ({ inspect, update }));
	const pullImage = vi.fn<(image: string) => Promise<void>>(
		async () => undefined,
	);
	return {
		getServiceMock: getService,
		inspectMock: inspect,
		updateMock: update,
		createServiceMock: createService,
		pullImageMock: pullImage,
	};
});

vi.mock("@dokploy/server/constants", () => ({
	docker: {
		getService: getServiceMock,
		createService: createServiceMock,
	},
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImage: pullImageMock,
}));

const serviceNotFound = () =>
	Object.assign(new Error("service not found"), { statusCode: 404 });

describe("initializePostgres", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		pullImageMock.mockResolvedValue(undefined);
		createServiceMock.mockResolvedValue(undefined);
		inspectMock.mockRejectedValue(serviceNotFound());
	});

	it("pulls the pinned postgres and creates the service with PGDATA when none exists", async () => {
		await initializePostgres();

		expect(pullImageMock).toHaveBeenCalledWith(image);
		expect(updateMock).not.toHaveBeenCalled();
		expect(createServiceMock).toHaveBeenCalledTimes(1);

		const options = createServiceMock.mock.calls[0]?.[0];
		const spec = options?.TaskTemplate?.ContainerSpec;
		expect(spec?.Image).toBe(image);
		expect(spec?.Env).toContain("PGDATA=/var/lib/postgresql/data");
		expect(spec?.Mounts).toEqual([
			expect.objectContaining({ Target: "/var/lib/postgresql/data" }),
		]);
	});

	it("creates the service from a local image when the pull fails", async () => {
		pullImageMock.mockRejectedValue(
			Object.assign(new Error("getaddrinfo ENOTFOUND registry.test"), {
				code: "ENOTFOUND",
			}),
		);

		await expect(initializePostgres()).resolves.toBeUndefined();

		expect(pullImageMock).toHaveBeenCalledWith(image);
		expect(createServiceMock).toHaveBeenCalledTimes(1);

		const options = createServiceMock.mock.calls[0]?.[0];
		const spec = options?.TaskTemplate?.ContainerSpec;
		expect(spec?.Image).toBe(image);
		expect(spec?.Env).toContain("PGDATA=/var/lib/postgresql/data");
	});

	it("leaves an existing service unchanged, including its secrets and mounts", async () => {
		inspectMock.mockResolvedValue({
			Version: { Index: 7 },
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Image: "postgres:16",
						Env: ["POSTGRES_PASSWORD_FILE=/run/secrets/pg"],
						Secrets: [{ SecretName: "pg", SecretID: "test-secret-id" }],
						Mounts: [
							{
								Type: "volume",
								Source: "test-postgres-volume",
								Target: "/var/lib/postgresql",
							},
						],
					},
				},
			},
		});

		await expect(initializePostgres()).resolves.toBeUndefined();

		expect(updateMock).not.toHaveBeenCalled();
		expect(createServiceMock).not.toHaveBeenCalled();
		expect(pullImageMock).not.toHaveBeenCalled();
	});

	it("rethrows an inspect error that is not a 404", async () => {
		inspectMock.mockRejectedValue(
			Object.assign(new Error("connection refused"), { statusCode: 500 }),
		);

		await expect(initializePostgres()).rejects.toThrow("connection refused");

		expect(pullImageMock).not.toHaveBeenCalled();
		expect(createServiceMock).not.toHaveBeenCalled();
	});

	it("resolves when createService reports the service already exists (409)", async () => {
		createServiceMock.mockRejectedValueOnce(
			Object.assign(new Error("service already exists"), { statusCode: 409 }),
		);

		await expect(initializePostgres()).resolves.toBeUndefined();

		expect(pullImageMock).toHaveBeenCalledWith(image);
		expect(createServiceMock).toHaveBeenCalledTimes(1);
	});
});
