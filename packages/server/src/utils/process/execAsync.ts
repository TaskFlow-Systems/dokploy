import { exec, execFile, spawn } from "node:child_process";
import util from "node:util";
import { findServerById } from "@dokploy/server/services/server";
import { resolveServerDestinationHost } from "@dokploy/server/utils/servers/destination";
import { Client } from "ssh2";
import { ExecError } from "./ExecError";

export class WriteFileRemoteError extends Error {
	constructor(
		message: string,
		public readonly context: {
			remotePath: string;
			serverId: string;
			originalError: Error;
		},
	) {
		super(message);
		this.name = "WriteFileRemoteError";
	}
}

// Re-export ExecError for easier imports
export { ExecError } from "./ExecError";

const execAsyncBase = util.promisify(exec);

type ExecErrorLike = Error & {
	code?: number | string;
	stdout?: Buffer | string;
	stderr?: Buffer | string;
};

export class CommandTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Command timed out after ${timeoutMs} ms`);
		this.name = "CommandTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

const MAX_TIMED_OUTPUT_BYTES = 8 * 1024 * 1024;

// exec only kills the shell on timeout, and a grandchild such as docker logs
// keeps running. A detached process group lets the whole tree be killed.
const execWithTimeout = (
	command: string,
	timeoutMs: number,
	options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", command], {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const killTree = () => {
			try {
				if (child.pid) {
					process.kill(-child.pid, "SIGKILL");
				}
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			killTree();
			reject(new CommandTimeoutError(timeoutMs));
		}, timeoutMs);
		const append = (current: string, chunk: Buffer) =>
			current.length >= MAX_TIMED_OUTPUT_BYTES
				? current
				: current + chunk.toString();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(
				new ExecError(`Command execution error: ${error.message}`, {
					command,
					stdout,
					stderr,
					originalError: error,
				}),
			);
		});
		child.on("close", (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(
				new ExecError(`Command execution failed: exit code ${code}`, {
					command,
					stdout,
					stderr,
					exitCode: code ?? undefined,
				}),
			);
		});
	});
// Node embeds the full command in error.message; it may carry secrets.
const withoutCommand = (message: string, command: string) =>
	message.split(command).join("[command omitted]");

export const execAsync = async (
	command: string,
	options?: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		shell?: string;
		timeoutMs?: number;
		maxBuffer?: number;
	},
): Promise<{ stdout: string; stderr: string }> => {
	if (options?.timeoutMs !== undefined) {
		return execWithTimeout(command, options.timeoutMs, options);
	}
	try {
		const result = await execAsyncBase(command, options);
		return {
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (error) {
		if (error instanceof Error) {
			const execError = error as NodeJS.ErrnoException & {
				stdout?: unknown;
				stderr?: unknown;
			};
			const exitCode =
				typeof execError.code === "number" ? execError.code : undefined;
			const stdout = execError.stdout?.toString() || "";
			const stderr = execError.stderr?.toString() || "";

			throw new ExecError(
				`Command execution failed: ${withoutCommand(error.message, command)}`,
				{
					command,
					stdout,
					stderr,
					exitCode,
					originalError: error,
				},
			);
		}
		throw error;
	}
};

interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export const execAsyncStream = (
	command: string,
	onData?: (data: string) => void,
	options: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> => {
	return new Promise((resolve, reject) => {
		let stdoutComplete = "";
		let stderrComplete = "";

		const childProcess = exec(command, options, (error) => {
			if (error) {
				reject(
					new ExecError(
						`Command execution failed: ${withoutCommand(error.message, command)}`,
						{
							command,
							stdout: stdoutComplete,
							stderr: stderrComplete,
							exitCode: typeof error.code === "number" ? error.code : undefined,
							originalError: error,
						},
					),
				);
				return;
			}
			resolve({ stdout: stdoutComplete, stderr: stderrComplete });
		});

		childProcess.stdout?.on("data", (data: Buffer | string) => {
			const stringData = data.toString();
			stdoutComplete += stringData;
			if (onData) {
				onData(stringData);
			}
		});

		childProcess.stderr?.on("data", (data: Buffer | string) => {
			const stringData = data.toString();
			stderrComplete += stringData;
			if (onData) {
				onData(stringData);
			}
		});

		childProcess.on("error", (error) => {
			console.log(error);
			reject(
				new ExecError(`Command execution error: ${error.message}`, {
					command,
					stdout: stdoutComplete,
					stderr: stderrComplete,
					originalError: error,
				}),
			);
		});
	});
};

export const execFileAsync = async (
	command: string,
	args: string[],
	options: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> => {
	const child = execFile(command, args);

	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(
					new Error(`Command failed with code ${code}. Stderr: ${stderr}`),
				);
			}
		});

		child.on("error", reject);

		if (options.input !== undefined && child.stdin) {
			child.stdin.on("error", reject);
			child.stdin.end(options.input);
		}
	});
};

export const execAsyncRemote = async (
	serverId: string | null,
	command: string,
	onData?: (data: string) => void,
	options: { timeoutMs?: number; input?: string } = {},
): Promise<{ stdout: string; stderr: string }> => {
	if (!serverId) return { stdout: "", stderr: "" };
	const server = await findServerById(serverId);
	if (!server.sshKeyId) throw new Error("No SSH key available for this server");
	const host = await resolveServerDestinationHost(server);

	let stdout = "";
	let stderr = "";
	return new Promise((resolve, reject) => {
		const conn = new Client();
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (options.timeoutMs !== undefined) {
			const timeoutMs = options.timeoutMs;
			timer = setTimeout(() => {
				conn.destroy();
				reject(new CommandTimeoutError(timeoutMs));
			}, timeoutMs);
		}

		sleep(1000);
		conn
			.once("ready", () => {
				conn.exec(command, (err, stream) => {
					if (err) {
						clearTimeout(timer);
						onData?.(err.message);
						reject(
							new ExecError(`Remote command execution failed: ${err.message}`, {
								command,
								serverId,
								originalError: err,
							}),
						);
						return;
					}
					stream
						.on("close", (code: number, _signal: string) => {
							clearTimeout(timer);
							conn.end();
							if (code === 0) {
								resolve({ stdout, stderr });
							} else {
								reject(
									new ExecError(
										`Remote command failed with exit code ${code}`,
										{
											command,
											stdout,
											stderr,
											exitCode: code,
											serverId,
										},
									),
								);
							}
						})
						.on("data", (data: string) => {
							stdout += data.toString();
							onData?.(data.toString());
						})
						.stderr.on("data", (data) => {
							stderr += data.toString();
							onData?.(data.toString());
						});
					if (options.input !== undefined) {
						stream.on("error", (error: Error) => {
							conn.end();
							reject(error);
						});
						stream.end(options.input);
					}
				});
			})
			.on("error", (err) => {
				clearTimeout(timer);
				conn.end();
				if (err.level === "client-authentication") {
					const technicalDetail = `Error: ${err.message} ${err.level}`;
					const friendlyMessage = [
						"",
						"❌ Couldn't connect to your server — the SSH key was not accepted.",
						"",
						"This usually means the key doesn't match what's on the server, or the key format is invalid.",
						"",
						`Technical details: ${technicalDetail}`,
						"",
						"💡 Hints:",
						"  • Check that the SSH key you added in Dokploy is the same one installed on the server (e.g. in ~/.ssh/authorized_keys).",
						"  • Try generating a new SSH key in Dokploy and add only the public key to the server, then try again.",
						"  • Make sure to follow the instructions on the Setup Server Button on the SSH Keys tab and then click on deployments tab and check the logs for more details.",
					].join("\n");
					const errorMsg = `Authentication failed: Invalid SSH private key. ❌ Error: ${err.message} ${err.level}`;
					onData?.(friendlyMessage);
					reject(
						new ExecError(
							`Authentication failed: Invalid SSH private key. ${friendlyMessage}`,
							{
								command,
								serverId,
								originalError: err,
							},
						),
					);
				} else {
					const errorMsg = `SSH connection error: ${err.message}`;
					onData?.(errorMsg);
					reject(
						new ExecError(errorMsg, {
							command,
							serverId,
							originalError: err,
						}),
					);
				}
			})
			.connect({
				host,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				timeout: 99999,
			});
	});
};

export const writeFileRemote = async (
	serverId: string,
	remotePath: string,
	content: string,
): Promise<void> => {
	const server = await findServerById(serverId);
	if (!server.sshKeyId) throw new Error("No SSH key available for this server");

	return new Promise((resolve, reject) => {
		const conn = new Client();
		conn
			.once("ready", () => {
				conn.sftp((err, sftp) => {
					if (err) {
						conn.end();
						reject(
							new WriteFileRemoteError(`SFTP session failed: ${err.message}`, {
								remotePath,
								serverId,
								originalError: err,
							}),
						);
						return;
					}
					sftp.writeFile(remotePath, content, (writeErr) => {
						conn.end();
						if (writeErr) {
							reject(
								new WriteFileRemoteError(
									`Failed to write remote file ${remotePath}: ${writeErr.message}`,
									{ remotePath, serverId, originalError: writeErr },
								),
							);
							return;
						}
						resolve();
					});
				});
			})
			.on("error", (err) => {
				conn.end();
				reject(
					new WriteFileRemoteError(`SSH connection error: ${err.message}`, {
						remotePath,
						serverId,
						originalError: err,
					}),
				);
			})
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				timeout: 99999,
			});
	});
};

export const sleep = (ms: number) => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};
