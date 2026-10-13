import { writeTraefikSetup } from "@dokploy/server/services/settings";
import { TRAEFIK_MAIN_CONFIG_PATH } from "@dokploy/server/setup/traefik-setup";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findMany: vi.fn(),
	initializeStandaloneTraefik: vi.fn(),
	initializeTraefikService: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: {
				findMany: mocks.findMany,
			},
		},
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/setup/traefik-setup", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/setup/traefik-setup")
	>()),
	initializeStandaloneTraefik: mocks.initializeStandaloneTraefik,
	initializeTraefikService: mocks.initializeTraefikService,
}));

const CONVERSION = "traefik_convert_acme_to_tls";
const RESOURCE_CHECK = "RESOURCE_NAME=";
const NO_OUTPUT = { stdout: "", stderr: "" };

const answerResourceCheck = (resourceType: string, command: string) =>
	command.includes(RESOURCE_CHECK)
		? { stdout: `${resourceType}\n`, stderr: "" }
		: NO_OUTPUT;

const conversionCallIndex = (calls: unknown[][]) =>
	calls.findIndex((args) => String(args[args.length - 1]).includes(CONVERSION));

describe("writeTraefikSetup", { timeout: 60_000 }, () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findMany.mockResolvedValue([]);
	});

	it("converts the Traefik config on the server before the standalone Traefik is recreated", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) =>
				answerResourceCheck("standalone", command),
		);

		await writeTraefikSetup({ serverId: "server-1" });

		const conversion = conversionCallIndex(mocks.execAsyncRemote.mock.calls);
		expect(conversion).toBeGreaterThanOrEqual(0);
		expect(mocks.execAsyncRemote.mock.calls[conversion]?.[0]).toBe("server-1");
		expect(
			mocks.execAsyncRemote.mock.invocationCallOrder[conversion],
		).toBeLessThan(
			mocks.initializeStandaloneTraefik.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.initializeTraefikService).not.toHaveBeenCalled();
	});

	it("converts the Traefik config on the server before the Traefik service is updated", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) =>
				answerResourceCheck("service", command),
		);

		await writeTraefikSetup({ serverId: "server-1" });

		const conversion = conversionCallIndex(mocks.execAsyncRemote.mock.calls);
		expect(conversion).toBeGreaterThanOrEqual(0);
		expect(
			mocks.execAsyncRemote.mock.invocationCallOrder[conversion],
		).toBeLessThan(
			mocks.initializeTraefikService.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.initializeStandaloneTraefik).not.toHaveBeenCalled();
	});

	it("throws before any Traefik container is changed when the conversion fails", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) => {
				if (command.includes(RESOURCE_CHECK)) {
					return answerResourceCheck("standalone", command);
				}
				throw new Error("Remote command failed with exit code 1");
			},
		);

		await expect(writeTraefikSetup({ serverId: "server-1" })).rejects.toThrow(
			"exit code 1",
		);
		expect(mocks.initializeStandaloneTraefik).not.toHaveBeenCalled();
		expect(mocks.initializeTraefikService).not.toHaveBeenCalled();
	});

	it("names the config and the backup in the error when the conversion fails", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (_serverId: string, command: string) => {
				if (command.includes(RESOURCE_CHECK)) {
					return answerResourceCheck("standalone", command);
				}
				throw new ExecError("Remote command failed with exit code 1", {
					command,
					serverId: "server-1",
					exitCode: 1,
					stderr: `Error: could not convert ${TRAEFIK_MAIN_CONFIG_PATH} to tlsChallenge. The original config was left unchanged. Previous config saved to ${TRAEFIK_MAIN_CONFIG_PATH}.bak-20261009000000\n`,
				});
			},
		);

		const failure = writeTraefikSetup({ serverId: "server-1" });

		await expect(failure).rejects.toThrow(
			`Traefik config ${TRAEFIK_MAIN_CONFIG_PATH} could not be converted to tlsChallenge`,
		);
		await expect(failure).rejects.toThrow(
			`${TRAEFIK_MAIN_CONFIG_PATH}.bak-20261009000000`,
		);
		expect(mocks.initializeStandaloneTraefik).not.toHaveBeenCalled();
	});

	it("runs the conversion on this host, not over SSH, when no server is given", async () => {
		mocks.execAsync.mockImplementation(async (command: string) =>
			answerResourceCheck("standalone", command),
		);

		await writeTraefikSetup({});

		expect(
			conversionCallIndex(mocks.execAsync.mock.calls),
		).toBeGreaterThanOrEqual(0);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.initializeStandaloneTraefik).toHaveBeenCalledTimes(1);
	});
});
