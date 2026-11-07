import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getMissingServiceContainerCommand } from "@dokploy/server/utils/backups/utils";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const execFileAsync = promisify(execFile);

const mocks = vi.hoisted(() => ({
	listTasks: vi.fn(),
	inspectNode: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: async () => ({
		listTasks: mocks.listTasks,
		getNode: () => ({ inspect: mocks.inspectNode }),
	}),
}));

const { describeMissingServiceContainer } = await import(
	"@dokploy/server/utils/docker/utils"
);

let bin = "";

// A stand-in for the docker CLI: `docker service ps` prints FAKE_NODE.
beforeAll(async () => {
	bin = await mkdtemp(join(tmpdir(), "fake-docker-"));
	await writeFile(
		join(bin, "docker"),
		'#!/bin/sh\n[ "$1 $2" = "service ps" ] && [ -n "$FAKE_NODE" ] && echo "$FAKE_NODE"\nexit 0\n',
	);
	await chmod(join(bin, "docker"), 0o755);
});

afterAll(async () => {
	await rm(bin, { recursive: true, force: true });
});

const stderrOf = async (node: string) => {
	const { stderr } = await execFileAsync(
		"sh",
		["-c", getMissingServiceContainerCommand("db-app")],
		{
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				FAKE_NODE: node,
			},
		},
	);
	return stderr.trim();
};

describe("the message for a database the panel cannot reach", () => {
	beforeEach(() => {
		mocks.listTasks.mockReset();
		mocks.inspectNode.mockReset();
	});

	it("names the node a database runs on in the shell command", async () => {
		expect(await stderrOf("worker-2")).toBe(
			"db-app runs on node worker-2, and the panel reaches only the containers of the node it connects to",
		);
	});

	it("says that no container runs when Swarm runs no task", async () => {
		expect(await stderrOf("")).toBe("No running container found for db-app");
	});

	it("names the node through the API too", async () => {
		mocks.listTasks.mockResolvedValue([
			{ NodeID: "node-2", Status: { State: "running" } },
		]);
		mocks.inspectNode.mockResolvedValue({
			Description: { Hostname: "worker-2" },
		});

		await expect(describeMissingServiceContainer("db-app")).resolves.toBe(
			"db-app runs on node worker-2, and the panel reaches only the containers of the node it connects to",
		);
	});

	it("falls back to the plain message without a running task or an answer", async () => {
		mocks.listTasks.mockResolvedValueOnce([]);
		await expect(describeMissingServiceContainer("db-app")).resolves.toBe(
			"No running container found for db-app",
		);

		mocks.listTasks.mockRejectedValueOnce(new Error("no answer"));
		await expect(describeMissingServiceContainer("db-app")).resolves.toBe(
			"No running container found for db-app",
		);
	});
});
