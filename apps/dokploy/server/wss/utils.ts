import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execAsync, IS_CLOUD, paths } from "@dokploy/server";

/**
 * Validates that the container ID matches Docker's expected format.
 * Docker container IDs are 64-character hex strings (or 12-char short form).
 * Also allows container names: alphanumeric, underscores, hyphens, and dots.
 */
export const isValidContainerId = (id: string): boolean => {
	// Match full ID (64 hex chars), short ID (12 hex chars), or container name
	const hexPattern = /^[a-f0-9]{12,64}$/i;
	const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
	return hexPattern.test(id) || (namePattern.test(id) && id.length <= 128);
};

/**
 * Validates the `tail` parameter for docker logs (number of lines, max 10000).
 * Prevents command injection by allowing only digits.
 */
export const isValidTail = (tail: string): boolean => {
	return (
		/^\d+$/.test(tail) &&
		Number.parseInt(tail, 10) <= 10000 &&
		Number.parseInt(tail, 10) >= 0
	);
};

/**
 * Validates the `since` parameter for docker logs: "all" or duration like 5s, 10m, 1h, 2d.
 * Prevents command injection by allowing only a strict format.
 */
export const isValidSince = (since: string): boolean => {
	return since === "all" || /^\d+[smhd]$/.test(since);
};

/**
 * Validates the `search` parameter for log filtering.
 * Search is concatenated into shell commands (SSH path: double quotes; local path: single quotes).
 * Only allow alphanumeric, space, dot, underscore, hyphen to prevent $, `, ', " from enabling command injection.
 * Max length 500.
 */
export const isValidSearch = (search: string): boolean => {
	// Space only (not \s) to reject \n, \r, \t and other control chars
	return /^[a-zA-Z0-9 ._-]{0,500}$/.test(search);
};

/**
 * Validates that the shell is one of the allowed shells.
 */
export const isValidShell = (shell: string): boolean => {
	const allowedShells = [
		"sh",
		"bash",
		"zsh",
		"ash",
		"/bin/sh",
		"/bin/bash",
		"/bin/zsh",
		"/bin/ash",
	];
	return allowedShells.includes(shell);
};

/**
 * Clamps cols/rows read from the client's initial connection query params
 * to a sane range, falling back to the standard 80x24 default.
 */
export const parseTerminalSize = (
	colsParam: string | null,
	rowsParam: string | null,
) => {
	const cols = Number(colsParam);
	const rows = Number(rowsParam);
	return {
		cols: Number.isInteger(cols) && cols > 0 && cols <= 1000 ? cols : 80,
		rows: Number.isInteger(rows) && rows > 0 && rows <= 1000 ? rows : 24,
	};
};

/**
 * Terminal input and resize control messages share the same websocket
 * channel. Resize messages are JSON envelopes; regular keystrokes never
 * start with "{", so this distinguishes them without an extra channel.
 */
export const parseResizeMessage = (data: string) => {
	if (!data.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(data);
		if (
			parsed?.type === "resize" &&
			Number.isInteger(parsed.cols) &&
			Number.isInteger(parsed.rows) &&
			parsed.cols > 0 &&
			parsed.cols <= 1000 &&
			parsed.rows > 0 &&
			parsed.rows <= 1000
		) {
			return { cols: parsed.cols, rows: parsed.rows };
		}
	} catch {
		return null;
	}
	return null;
};

// Killing a `docker exec` client leaves its shell running in the container: the
// daemon keeps the terminal open, so the shell never gets a hangup. Every
// process of a terminal session inherits this marker, so closing the session
// can hang up its shell the way closing an SSH session does.
export const newTerminalSessionMarker = () =>
	`DOKPLOY_TERMINAL_SESSION=${randomBytes(16).toString("hex")}`;

// Only the session's first process gets the hangup, so a shell passes it on to
// its jobs and a process started with nohup keeps running, as over SSH. The
// script avoids single quotes and backslashes because the SSH path quotes it.
export const getTerminalHangupArgs = (
	containerId: string,
	shell: string,
	marker: string,
) => [
	"exec",
	containerId,
	shell,
	"-c",
	`marker="${marker}"
for dir in /proc/[0-9]*; do
	grep -qF "$marker" "$dir/environ" 2>/dev/null || continue
	parent=$(sed -n "s/^PPid:[[:space:]]*//p" "$dir/status" 2>/dev/null)
	grep -qF "$marker" "/proc/$parent/environ" 2>/dev/null || kill -HUP "\${dir#/proc/}" 2>/dev/null
done
exit 0`,
];

export const getShell = () => {
	if (IS_CLOUD) {
		return "NO_AVAILABLE";
	}
	switch (os.platform()) {
		case "win32":
			return "powershell.exe";
		case "darwin":
			return "zsh";
		default:
			return "bash";
	}
};

/** Returns private SSH key for dokploy local server terminal. Uses already created SSH key or generates a new SSH key.
 */
export const setupLocalServerSSHKey = async () => {
	const { SSH_PATH } = paths(true);
	const sshKeyPath = path.join(SSH_PATH, "auto_generated-dokploy-local");

	if (!fs.existsSync(sshKeyPath)) {
		// Generate new SSH key if it hasn't been created yet
		await execAsync(
			`ssh-keygen -t rsa -b 4096 -f ${sshKeyPath} -N "" -C "dokploy-local-access"`,
		);
	}

	const privateKey = fs.readFileSync(sshKeyPath, "utf8");

	return privateKey;
};
