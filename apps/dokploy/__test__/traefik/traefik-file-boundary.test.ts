import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	paths: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	paths: mocks.paths,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	writeFileRemote: mocks.writeFileRemote,
}));

const {
	filterProtectedTraefikEntries,
	isProtectedTraefikPath,
	readConfigInPath,
	writeTraefikConfigInPath,
	writeTraefikConfigRemote,
} = await import("@dokploy/server/utils/traefik/application");

describe("Traefik file path boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.paths.mockImplementation((remote?: boolean) => ({
			CERTIFICATES_PATH: remote
				? "/etc/dokploy/traefik/dynamic/certificates"
				: "/var/lib/dokploy/traefik/dynamic/certificates",
			DYNAMIC_TRAEFIK_PATH: remote
				? "/etc/dokploy/traefik/dynamic"
				: "/var/lib/dokploy/traefik/dynamic",
			MAIN_TRAEFIK_PATH: remote
				? "/etc/dokploy/traefik"
				: "/var/lib/dokploy/traefik",
		}));
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "http: {}\n" });
	});

	it("rejects local reads outside MAIN_TRAEFIK_PATH", async () => {
		await expect(
			readConfigInPath("/var/lib/dokploy/applications/app/.env"),
		).rejects.toThrow("Invalid Traefik config path");
	});

	it("rejects local writes outside MAIN_TRAEFIK_PATH", async () => {
		await expect(
			writeTraefikConfigInPath(
				"/var/lib/dokploy/applications/app/.env",
				"SECRET=value",
			),
		).rejects.toThrow("Invalid Traefik config path");
	});

	it("rejects remote reads outside the remote MAIN_TRAEFIK_PATH", async () => {
		await expect(
			readConfigInPath("/etc/dokploy/applications/app/.env", "server-1"),
		).rejects.toThrow("Invalid Traefik config path");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("rejects remote writes outside the remote MAIN_TRAEFIK_PATH", async () => {
		await expect(
			writeTraefikConfigInPath(
				"/etc/dokploy/applications/app/.env",
				"SECRET=value",
				"server-1",
			),
		).rejects.toThrow("Invalid Traefik config path");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it.each([
		["/var/lib/dokploy/traefik/dynamic/acme.json", undefined],
		["/var/lib/dokploy/traefik/dynamic/certificates", undefined],
		[
			"/var/lib/dokploy/traefik/dynamic/certificates/cert-1/chain.crt",
			undefined,
		],
		["/var/lib/dokploy/traefik/dynamic/custom/privkey.key", undefined],
		[
			"/var/lib/dokploy/traefik/dynamic/./certificates/../certificates/cert-1/privkey.key",
			undefined,
		],
		["/etc/dokploy/traefik/dynamic/acme.json", "server-1"],
		["/etc/dokploy/traefik/dynamic/certificates/cert-1/chain.crt", "server-1"],
		["/etc/dokploy/traefik/tls/site.KEY", "server-1"],
	])(
		"rejects reads and writes of TLS secret file %s",
		async (filePath, serverId) => {
			await expect(readConfigInPath(filePath, serverId)).rejects.toThrow(
				"Access to this Traefik file is not allowed",
			);
			await expect(
				writeTraefikConfigInPath(filePath, "{}", serverId),
			).rejects.toThrow("Access to this Traefik file is not allowed");

			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			expect(mocks.writeFileRemote).not.toHaveBeenCalled();
		},
	);

	it("opens TLS secret files only when the caller passed the protected resource check", async () => {
		const acmePath = "/etc/dokploy/traefik/dynamic/acme.json";
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "{}" });

		await expect(
			readConfigInPath(acmePath, "server-1", { allowProtected: false }),
		).rejects.toThrow("Access to this Traefik file is not allowed");
		await expect(
			readConfigInPath(acmePath, "server-1", { allowProtected: true }),
		).resolves.toBe("{}");

		await writeTraefikConfigInPath(acmePath, "{}", "server-1", {
			allowProtected: true,
		});
		expect(mocks.writeFileRemote).toHaveBeenCalledWith(
			"server-1",
			acmePath,
			"{}",
		);

		await expect(
			readConfigInPath("/etc/dokploy/app/.env", "server-1", {
				allowProtected: true,
			}),
		).rejects.toThrow("Invalid Traefik config path");
	});

	it("treats every acme.json sibling as protected for read, write and listing", async () => {
		const dir = "/etc/dokploy/traefik/dynamic";
		const names = [
			"acme.json.bak-20261012T101500Z",
			"acme.json.bak.2026-10-12",
			"acme.json.new-20261012T101500Z",
			"acme.json.restore-20261012T101500Z",
			"ACME.JSON.OLD",
			"acme.json~",
		];

		for (const name of names) {
			expect(isProtectedTraefikPath(`${dir}/${name}`, "server-1")).toBe(true);
			await expect(
				readConfigInPath(`${dir}/${name}`, "server-1"),
			).rejects.toThrow("Access to this Traefik file is not allowed");
			await expect(
				writeTraefikConfigInPath(`${dir}/${name}`, "{}", "server-1"),
			).rejects.toThrow("Access to this Traefik file is not allowed");
		}
		expect(isProtectedTraefikPath(`${dir}/app.yml`, "server-1")).toBe(false);

		const listing = [
			...names.map((name) => ({
				id: `${dir}/${name}`,
				name,
				type: "file" as const,
			})),
			{ id: `${dir}/app.yml`, name: "app.yml", type: "file" as const },
		];
		expect(filterProtectedTraefikEntries(listing, "server-1")).toEqual([
			{ id: `${dir}/app.yml`, name: "app.yml", type: "file" },
		]);
	});

	it("hides TLS secret files from Traefik directory listings", () => {
		const root = "/etc/dokploy/traefik";
		const listing = [
			{ id: `${root}/traefik.yml`, name: "traefik.yml", type: "file" },
			{
				id: `${root}/dynamic`,
				name: "dynamic",
				type: "directory",
				children: [
					{ id: `${root}/dynamic/acme.json`, name: "acme.json", type: "file" },
					{ id: `${root}/dynamic/app.yml`, name: "app.yml", type: "file" },
					{
						id: `${root}/dynamic/certificates`,
						name: "certificates",
						type: "directory",
						children: [
							{
								id: `${root}/dynamic/certificates/cert-1`,
								name: "cert-1",
								type: "directory",
								children: [],
							},
						],
					},
					{
						id: `${root}/dynamic/custom.key`,
						name: "custom.key",
						type: "file",
					},
				],
			},
		];

		expect(filterProtectedTraefikEntries(listing, "server-1")).toEqual([
			{ id: `${root}/traefik.yml`, name: "traefik.yml", type: "file" },
			{
				id: `${root}/dynamic`,
				name: "dynamic",
				type: "directory",
				children: [
					{ id: `${root}/dynamic/app.yml`, name: "app.yml", type: "file" },
				],
			},
		]);
	});

	it("quotes remote Traefik file paths before shell execution", async () => {
		const remotePath = "/etc/dokploy/traefik/dynamic/app'$(id).yml";

		await expect(readConfigInPath(remotePath, "server-1")).resolves.toBe(
			"http: {}\n",
		);

		expect(mocks.execAsyncRemote).toHaveBeenLastCalledWith(
			"server-1",
			`cat "/etc/dokploy/traefik/dynamic/app'\\$(id).yml"`,
		);

		await writeTraefikConfigInPath(remotePath, "http: {}", "server-1");

		// Remote writes go over SFTP (no shell), so the payload must arrive
		// intact and no shell command may carry raw file text.
		expect(mocks.writeFileRemote).toHaveBeenLastCalledWith(
			"server-1",
			"/etc/dokploy/traefik/dynamic/app'$(id).yml",
			"http: {}",
		);
		for (const [, command] of mocks.execAsyncRemote.mock.calls) {
			expect(command).not.toContain("http: {}");
		}
	});

	it("writes remote Traefik YAML as encoded data instead of raw shell text", async () => {
		await writeTraefikConfigRemote(
			{
				http: {
					middlewares: {
						"redirect-app-1": {
							redirectRegex: {
								regex: "Host(`example.com`)'; touch /tmp/pwn #",
								replacement: "https://example.com/$1$(id)",
								permanent: true,
							},
						},
					},
				},
			},
			"middlewares",
			"server-1",
		);

		const [serverId, remotePath, payload] =
			mocks.writeFileRemote.mock.calls.at(-1) ?? [];
		expect(serverId).toBe("server-1");
		expect(remotePath).toBe("/etc/dokploy/traefik/dynamic/middlewares.yml");
		// SFTP carries YAML as data, never as shell text.
		expect(payload).toContain("touch /tmp/pwn");
		expect(payload).toContain("$(id)");
		for (const [, command] of mocks.execAsyncRemote.mock.calls) {
			expect(command).not.toContain("touch /tmp/pwn");
			expect(command).not.toContain("redirect-app-1");
		}
	});

	it("quotes remote Traefik YAML destination paths before shell execution", async () => {
		await writeTraefikConfigRemote(
			{ http: { middlewares: {} } },
			"middlewares'$(id)",
			"server-1",
		);

		const [serverId, remotePath] =
			mocks.writeFileRemote.mock.calls.at(-1) ?? [];
		expect(serverId).toBe("server-1");
		// SFTP takes the resolved path as data: no shell quoting layers,
		// but also no unquoted shell redirection.
		expect(remotePath).toBe(
			"/etc/dokploy/traefik/dynamic/middlewares'$(id).yml",
		);
		for (const [, command] of mocks.execAsyncRemote.mock.calls) {
			expect(command).not.toContain("middlewares'$(id).yml");
		}
	});
});

describe("Traefik editor protection of key backups", () => {
	let root = "";

	beforeEach(() => {
		vi.clearAllMocks();
		root = mkdtempSync(path.join(tmpdir(), "traefik-boundary-"));
		mkdirSync(path.join(root, "dynamic", "certificates"), { recursive: true });
		mocks.paths.mockImplementation((remote?: boolean) => ({
			CERTIFICATES_PATH: remote
				? "/etc/dokploy/traefik/dynamic/certificates"
				: path.join(root, "dynamic", "certificates"),
			DYNAMIC_TRAEFIK_PATH: remote
				? "/etc/dokploy/traefik/dynamic"
				: path.join(root, "dynamic"),
			MAIN_TRAEFIK_PATH: remote ? "/etc/dokploy/traefik" : root,
		}));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it.each([
		"dynamic/acme.json.d/inner.yml",
		"dynamic/acme.json.bak/deep/inner.json",
		"dynamic/old-acme.json",
		"dynamic/acme.bak.json",
		"dynamic/acme-backup.json",
		"dynamic/ACME.JSON.OLD",
		"dynamic/acme.json",
	])("protects %s", (relative) => {
		expect(isProtectedTraefikPath(path.join(root, relative))).toBe(true);
	});

	it.each([
		"dynamic/acme-shop.yml",
		"dynamic/acme.yml",
		"dynamic/middlewares.yml",
		"dynamic/my-app-acme.yml",
		"traefik.yml",
	])("leaves %s editable", (relative) => {
		expect(isProtectedTraefikPath(path.join(root, relative))).toBe(false);
	});

	it("follows a symlink to a protected file before deciding", async () => {
		writeFileSync(path.join(root, "dynamic", "acme.json"), "{}");
		symlinkSync(
			path.join(root, "dynamic", "acme.json"),
			path.join(root, "dynamic", "innocent.yml"),
		);
		mkdirSync(path.join(root, "dynamic", "acme.json.d"));
		symlinkSync(
			path.join(root, "dynamic", "acme.json.d"),
			path.join(root, "dynamic", "folder"),
		);

		const link = path.join(root, "dynamic", "innocent.yml");
		expect(isProtectedTraefikPath(link)).toBe(true);
		expect(
			isProtectedTraefikPath(path.join(root, "dynamic", "folder", "x.yml")),
		).toBe(true);
		await expect(readConfigInPath(link)).rejects.toThrow(
			"Access to this Traefik file is not allowed",
		);
		await expect(
			readConfigInPath(link, undefined, { allowProtected: true }),
		).resolves.toBe("{}");
	});

	it("resolves a remote symlink with readlink before it reads or writes", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (_server, command: string) =>
				command.startsWith("readlink")
					? { stdout: "/etc/dokploy/traefik/dynamic/acme.json\n" }
					: { stdout: "KEY" },
		);
		const link = "/etc/dokploy/traefik/dynamic/innocent.yml";

		await expect(readConfigInPath(link, "server-1")).rejects.toThrow(
			"Access to this Traefik file is not allowed",
		);
		await expect(
			writeTraefikConfigInPath(link, "x", "server-1"),
		).rejects.toThrow("Access to this Traefik file is not allowed");
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
	});
});
