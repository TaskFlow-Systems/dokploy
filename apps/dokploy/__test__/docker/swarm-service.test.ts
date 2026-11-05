import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createOrUpdateSwarmService } from "@dokploy/server/utils/docker/swarm-service";
// @ts-expect-error Its types are declared only in packages/server.
import Dockerode from "dockerode";
import { afterEach, describe, expect, it } from "vitest";

type Reply = { status: number; body?: unknown } | "silent";
type Seen = { method?: string; path: string; body: string; closed: boolean };

const settings = {
	Name: "app",
	TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
};
const existing = {
	Version: { Index: 41 },
	Spec: { TaskTemplate: { ForceUpdate: 2 } },
};

let server: Server | undefined;

// A real HTTP daemon, so the abort goes through dockerode and docker-modem as it does
// in production, and what they put on the wire can be read.
const startDaemon = async (reply: (request: IncomingMessage) => Reply) => {
	const seen: Seen[] = [];
	server = createServer((request, response) => {
		const entry: Seen = {
			method: request.method,
			path: request.url ?? "",
			body: "",
			closed: false,
		};
		seen.push(entry);
		response.on("close", () => {
			entry.closed = true;
		});
		request.on("data", (chunk) => {
			entry.body += chunk;
		});
		request.on("end", () => {
			const answer = reply(request);
			if (answer === "silent") return;
			response.writeHead(answer.status, {
				"content-type": "application/json",
			});
			response.end(JSON.stringify(answer.body ?? {}));
		});
	});
	await new Promise<void>((resolve) =>
		server?.listen(0, "127.0.0.1", () => resolve()),
	);
	const { port } = server.address() as AddressInfo;
	return {
		seen,
		docker: new Dockerode({ host: "127.0.0.1", port, protocol: "http" }),
	};
};

const isInspect = ({ method, url }: IncomingMessage) =>
	method === "GET" && url?.endsWith("/services/app");
const isUpdate = ({ url }: IncomingMessage) => url?.includes("/update");
const isCreate = ({ url }: IncomingMessage) =>
	url?.endsWith("/services/create");

const paths = (seen: Seen[]) =>
	seen.map(({ method, path }) => `${method} ${path.split("?")[0]}`);

afterEach(async () => {
	const running = server;
	if (!running) return;
	running.closeAllConnections();
	await new Promise((resolve) => running.close(resolve));
	server = undefined;
});

describe("createOrUpdateSwarmService", () => {
	it("updates an existing service at its version with the next ForceUpdate", async () => {
		const { docker, seen } = await startDaemon((request) =>
			isInspect(request) ? { status: 200, body: existing } : { status: 200 },
		);

		await createOrUpdateSwarmService({ docker, appName: "app", settings });

		expect(paths(seen)).toEqual([
			"GET /services/app",
			"POST /services/app/update",
		]);
		expect(seen[1]?.path).toContain("version=41");
		const sent = JSON.parse(seen[1]?.body ?? "");
		expect(sent.TaskTemplate.ForceUpdate).toBe(3);
		expect(sent).not.toHaveProperty("abortSignal");
		expect(seen[1]?.path).not.toContain("abortSignal");
	});

	it("creates a service that does not exist", async () => {
		const { docker, seen } = await startDaemon((request) =>
			isInspect(request)
				? { status: 404, body: { message: "service app not found" } }
				: { status: 201, body: { ID: "new" } },
		);

		await createOrUpdateSwarmService({ docker, appName: "app", settings });

		expect(paths(seen)).toEqual(["GET /services/app", "POST /services/create"]);
		expect(JSON.parse(seen[1]?.body ?? "")).not.toHaveProperty("abortSignal");
	});

	it("creates it when it disappears between the read and the update", async () => {
		const { docker, seen } = await startDaemon((request) => {
			if (isInspect(request)) return { status: 200, body: existing };
			if (isUpdate(request)) return { status: 404, body: { message: "gone" } };
			return { status: 201, body: { ID: "new" } };
		});

		await createOrUpdateSwarmService({ docker, appName: "app", settings });

		expect(paths(seen).at(-1)).toBe("POST /services/create");
	});

	it("shows why an update failed and does not try to create the service", async () => {
		const { docker, seen } = await startDaemon((request) =>
			isInspect(request)
				? { status: 200, body: existing }
				: { status: 500, body: { message: "update out of sequence" } },
		);

		await expect(
			createOrUpdateSwarmService({ docker, appName: "app", settings }),
		).rejects.toThrow(/update out of sequence/);
		expect(seen.filter(({ path }) => path.includes("create"))).toEqual([]);
	});

	it("shows why a read failed and does not try to create the service", async () => {
		const { docker, seen } = await startDaemon(() => ({
			status: 500,
			body: { message: "rpc error: the swarm does not have a leader" },
		}));

		await expect(
			createOrUpdateSwarmService({ docker, appName: "app", settings }),
		).rejects.toThrow(/does not have a leader/);
		expect(seen).toHaveLength(1);
	});

	it.each([
		["read", "reading", () => "silent" as const, 1],
		[
			"update",
			"updating",
			(request: IncomingMessage): Reply =>
				isUpdate(request) ? "silent" : { status: 200, body: existing },
			2,
		],
	])(
		"gives up on a silent %s, closes the request and sends nothing more",
		async (_name, action, reply, requests) => {
			const { docker, seen } = await startDaemon(reply);

			await expect(
				createOrUpdateSwarmService({
					docker,
					appName: "app",
					settings,
					timeoutMs: 100,
				}),
			).rejects.toThrow(`while ${action} service app`);

			expect(seen).toHaveLength(requests);
			await expect.poll(() => seen.at(-1)?.closed).toBe(true);
		},
	);

	it("gives up on a silent create", async () => {
		const { docker, seen } = await startDaemon((request) =>
			isCreate(request)
				? "silent"
				: { status: 404, body: { message: "not found" } },
		);

		await expect(
			createOrUpdateSwarmService({
				docker,
				appName: "app",
				settings,
				timeoutMs: 100,
			}),
		).rejects.toThrow("while creating service app");
		await expect.poll(() => seen.at(-1)?.closed).toBe(true);
	});

	it("sends registry credentials on a create", async () => {
		const { docker, seen } = await startDaemon((request) =>
			isInspect(request)
				? { status: 404, body: { message: "not found" } }
				: { status: 201, body: { ID: "new" } },
		);
		let header: string | string[] | undefined;
		server?.on("request", (request) => {
			if (isCreate(request)) header = request.headers["x-registry-auth"];
		});

		await createOrUpdateSwarmService({
			docker,
			appName: "app",
			settings,
			authConfig: { username: "u", password: "p", serveraddress: "r" },
		});

		expect(paths(seen).at(-1)).toBe("POST /services/create");
		const decoded = JSON.parse(
			Buffer.from(String(header), "base64").toString(),
		);
		expect(decoded).toMatchObject({ username: "u", serveraddress: "r" });
	});
});

describe("service update sites", () => {
	const read = (path: string) =>
		readFileSync(
			join(__dirname, "../../../../packages/server/src", path),
			"utf8",
		);

	// An upstream merge can bring back the old form: try to update, create on any error.
	it.each([
		"utils/builders/index.ts",
		"utils/databases/postgres.ts",
		"utils/databases/mysql.ts",
		"utils/databases/mariadb.ts",
		"utils/databases/mongo.ts",
		"utils/databases/redis.ts",
		"utils/databases/libsql.ts",
		"services/rollbacks.ts",
	])("%s goes through createOrUpdateSwarmService", (path) => {
		const source = read(path);

		expect(source).toContain("createOrUpdateSwarmService({");
		expect(source).not.toContain("docker.createService(");
	});
});
