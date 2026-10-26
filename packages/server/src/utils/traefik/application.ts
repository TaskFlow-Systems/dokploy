import fs, { createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { paths } from "@dokploy/server/constants";
import type { Domain } from "@dokploy/server/services/domain";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import { quoteShellArg } from "../filesystem/safe-path";
import {
	execAsync,
	execAsyncRemote,
	writeFileRemote,
} from "../process/execAsync";
import type { FileConfig, HttpLoadBalancerService } from "./file-types";

export const createTraefikConfig = (appName: string) => {
	const defaultPort = 3000;
	const serviceURLDefault = `http://${appName}:${defaultPort}`;
	const domainDefault = `Host(\`${appName}.docker.localhost\`)`;
	const config: FileConfig = {
		http: {
			routers: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${appName}-router-1`]: {
								rule: domainDefault,
								service: `${appName}-service-1`,
								entryPoints: ["web"],
							},
						}),
			},

			services: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${appName}-service-1`]: {
								loadBalancer: {
									servers: [{ url: serviceURLDefault }],
									passHostHeader: true,
								},
							},
						}),
			},
		},
	};
	const yamlStr = stringify(config);
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	fs.mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(
		path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`),
		yamlStr,
		"utf8",
	);
};

export const removeTraefikConfig = async (
	appName: string,
	serverId?: string | null,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		const command = `rm -f ${quote([configPath])}`;

		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing traefik config for ${appName}:`, error);
	}
};

export const removeTraefikConfigRemote = async (
	appName: string,
	serverId: string,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		await execAsyncRemote(serverId, `rm -f ${quoteShellArg(configPath)}`);
	} catch (error) {
		console.error(
			`Error removing remote traefik config for ${appName}:`,
			error,
		);
	}
};

const configLocks = new Map<string, Promise<unknown>>();

export const withTraefikConfigLock = async <T>(
	appName: string,
	serverId: string | null | undefined,
	fn: () => Promise<T>,
): Promise<T> => {
	const key = `${serverId ?? "local"}:${appName}`;
	const previous = configLocks.get(key) ?? Promise.resolve();
	const current = previous.catch(() => {}).then(fn);
	configLocks.set(key, current);
	try {
		return await current;
	} finally {
		if (configLocks.get(key) === current) {
			configLocks.delete(key);
		}
	}
};

export const loadOrCreateConfig = (appName: string): FileConfig => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
	if (fs.existsSync(configPath)) {
		const yamlStr = fs.readFileSync(configPath, "utf8");
		const parsedConfig = (parse(yamlStr) as FileConfig) || {
			http: { routers: {}, services: {} },
		};
		return parsedConfig;
	}
	return { http: { routers: {}, services: {} } };
};

export const loadOrCreateConfigRemote = async (
	serverId: string,
	appName: string,
) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths(true);
	const fileConfig: FileConfig = { http: { routers: {}, services: {} } };
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
	try {
		const { stdout } = await execAsyncRemote(
			serverId,
			`cat ${quote([configPath])}`,
		);

		if (!stdout) return fileConfig;

		const parsedConfig = (parse(stdout) as FileConfig) || {
			http: { routers: {}, services: {} },
		};
		return parsedConfig;
	} catch {
		return fileConfig;
	}
};

export const readConfig = (appName: string) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
	if (fs.existsSync(configPath)) {
		const yamlStr = fs.readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const readRemoteConfig = async (serverId: string, appName: string) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths(true);
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
	try {
		const { stdout } = await execAsyncRemote(
			serverId,
			`cat ${quote([configPath])}`,
		);
		if (!stdout) return null;
		return stdout;
	} catch {
		return null;
	}
};

export const readMonitoringConfig = async (readAll = false) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, "access.log");
	if (fs.existsSync(configPath)) {
		if (!readAll) {
			// Read first 500 lines using streams
			let content = "";
			let validCount = 0;

			const fileStream = createReadStream(configPath, { encoding: "utf8" });
			const readline = createInterface({
				input: fileStream,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			for await (const line of readline) {
				try {
					const trimmed = line.trim();
					if (
						trimmed !== "" &&
						trimmed.startsWith("{") &&
						trimmed.endsWith("}")
					) {
						const log = JSON.parse(trimmed);
						// Exclude Dokploy service app and Dashboard requests
						if (log.ServiceName !== "dokploy-service-app@file") {
							content += `${line}\n`;
							validCount++;
							if (validCount >= 500) {
								break;
							}
						}
					}
				} catch {
					// Ignore invalid JSON
				}
			}
			return content;
		}
		return fs.readFileSync(configPath, "utf8");
	}
	return null;
};

type TraefikFileAccessOptions = { allowProtected?: boolean };

// ACME storage and uploaded certificates hold TLS private keys, so the generic
// Traefik file editor only opens them when the caller passed the super session
// check (allowProtected). Backups made by operators or Traefik hold the same
// keys, so every path segment is checked, not only the last one: acme.json
// siblings, children of a directory with such a name, and names like
// old-acme.json or acme.bak.json. Ordinary config names such as acme-shop.yml
// stay editable.
const isProtectedSegment = (segment: string) => {
	const name = segment.toLowerCase();
	return (
		name.includes("acme.json") || /^acme[._-].*\.(?:json|bak)\b/.test(name)
	);
};

const hasProtectedSegment = (resolvedPath: string) =>
	resolvedPath.split(path.sep).some(isProtectedSegment);

const realPathOf = (target: string): string => {
	try {
		return fs.realpathSync(target);
	} catch {
		const parent = path.dirname(target);
		return parent === target
			? target
			: path.join(realPathOf(parent), path.basename(target));
	}
};

export const isProtectedTraefikPath = (
	configPath: string,
	serverId?: string,
) => {
	const { CERTIFICATES_PATH } = paths(!!serverId);
	const certificatesPath = path.resolve(CERTIFICATES_PATH);
	const check = (resolvedPath: string) =>
		hasProtectedSegment(resolvedPath) ||
		path.basename(resolvedPath).toLowerCase().endsWith(".key") ||
		resolvedPath === certificatesPath ||
		resolvedPath.startsWith(`${certificatesPath}${path.sep}`);

	const resolvedPath = path.resolve(configPath);
	if (check(resolvedPath)) {
		return true;
	}
	return !serverId && check(realPathOf(resolvedPath));
};

const assertRemoteLinkTarget = async (
	configPath: string,
	serverId: string,
	options: TraefikFileAccessOptions,
) => {
	if (options.allowProtected) {
		return;
	}
	const { stdout } = await execAsyncRemote(
		serverId,
		`readlink -f -- ${quote([configPath])} 2>/dev/null || true`,
	);
	const target = stdout.trim();
	if (target && isProtectedTraefikPath(target, serverId)) {
		throw new Error("Access to this Traefik file is not allowed");
	}
};

export const filterProtectedTraefikEntries = <
	T extends { id: string; children?: T[] },
>(
	entries: T[],
	serverId?: string,
): T[] =>
	entries
		.filter((entry) => !isProtectedTraefikPath(entry.id, serverId))
		.map((entry) =>
			entry.children
				? {
						...entry,
						children: filterProtectedTraefikEntries(entry.children, serverId),
					}
				: entry,
		);

export const resolveTraefikConfigPath = (
	pathFile: string,
	serverId?: string,
	options: TraefikFileAccessOptions = {},
) => {
	if (
		typeof pathFile !== "string" ||
		pathFile.includes("\0") ||
		/[\r\n]/.test(pathFile)
	) {
		throw new Error("Invalid Traefik config path");
	}

	const { MAIN_TRAEFIK_PATH } = paths(!!serverId);
	const rootPath = path.resolve(MAIN_TRAEFIK_PATH);
	const configPath = path.resolve(pathFile);

	if (
		configPath === rootPath ||
		!configPath.startsWith(`${rootPath}${path.sep}`)
	) {
		throw new Error("Invalid Traefik config path");
	}

	if (!options.allowProtected && isProtectedTraefikPath(configPath, serverId)) {
		throw new Error("Access to this Traefik file is not allowed");
	}

	return configPath;
};

export const readConfigInPath = async (
	pathFile: string,
	serverId?: string,
	options?: TraefikFileAccessOptions,
) => {
	const configPath = resolveTraefikConfigPath(pathFile, serverId, options);

	if (serverId) {
		await assertRemoteLinkTarget(configPath, serverId, options ?? {});
		const { stdout } = await execAsyncRemote(
			serverId,
			`cat ${quote([configPath])}`,
		);
		if (!stdout) return null;
		return stdout;
	}
	if (fs.existsSync(configPath)) {
		const yamlStr = fs.readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeConfig = (appName: string, traefikConfig: string) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths();
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		fs.writeFileSync(configPath, traefikConfig, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeConfigRemote = async (
	serverId: string,
	appName: string,
	traefikConfig: string,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		await writeFileRemote(serverId, configPath, traefikConfig);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfigInPath = async (
	pathFile: string,
	traefikConfig: string,
	serverId?: string,
	options?: TraefikFileAccessOptions,
) => {
	const configPath = resolveTraefikConfigPath(pathFile, serverId, options);
	if (serverId) {
		await assertRemoteLinkTarget(configPath, serverId, options ?? {});
	}

	try {
		if (serverId) {
			await writeFileRemote(serverId, configPath, traefikConfig);
		} else {
			fs.writeFileSync(configPath, traefikConfig, "utf8");
		}
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfig = (
	traefikConfig: FileConfig,
	appName: string,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths();
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		const yamlStr = stringify(traefikConfig);
		fs.writeFileSync(configPath, yamlStr, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfigRemote = async (
	traefikConfig: FileConfig,
	appName: string,
	serverId: string,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		const yamlStr = stringify(traefikConfig);
		await writeFileRemote(serverId, configPath, yamlStr);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

const isEmptyHttpRoutersAndServices = (traefikConfig: FileConfig) =>
	Object.keys(traefikConfig.http?.routers || {}).length === 0 &&
	Object.keys(traefikConfig.http?.services || {}).length === 0;

export const writeAppTraefikConfig = async (
	traefikConfig: FileConfig,
	appName: string,
	serverId?: string | null,
) => {
	if (isEmptyHttpRoutersAndServices(traefikConfig)) {
		await removeTraefikConfig(appName, serverId);
		return;
	}
	if (serverId) {
		await writeTraefikConfigRemote(traefikConfig, appName, serverId);
	} else {
		writeTraefikConfig(traefikConfig, appName);
	}
};

export const createServiceConfig = (
	appName: string,
	domain: Domain,
): {
	loadBalancer: HttpLoadBalancerService;
} => ({
	loadBalancer: {
		servers: [{ url: `http://${appName}:${domain.port || 80}` }],
		passHostHeader: true,
	},
});
