export interface Pty {
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: { exitCode: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

export interface PtyOptions {
	cols: number;
	rows: number;
	name?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

// The parts of Bun's own PTY this module uses. The repository has no Bun
// type package, and the panel also runs on Node in development and tests.
interface BunTerminal {
	write(data: string): number;
	resize(cols: number, rows: number): void;
	close(): void;
}
interface BunSubprocess {
	terminal: BunTerminal;
	exited: Promise<number>;
	kill(signal?: number | string): void;
}
interface BunRuntime {
	spawn(
		cmd: string[],
		options: {
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			terminal: {
				cols: number;
				rows: number;
				name?: string;
				data(terminal: BunTerminal, data: Uint8Array): void;
			};
		},
	): BunSubprocess;
}

const bunRuntime = (): BunRuntime | undefined =>
	(globalThis as { Bun?: BunRuntime }).Bun;

// node-pty's child gets SIGHUP right after its first output under Bun, so
// on Bun the terminal comes from Bun.spawn's own PTY and the native module is
// never loaded.
export const spawnPty = async (
	file: string,
	args: string[],
	options: PtyOptions,
): Promise<Pty> => {
	const bun = bunRuntime();
	if (!bun) {
		const { spawn } = await import("node-pty");
		return spawn(file, args, { ...options, encoding: "utf8" });
	}

	const dataListeners: ((data: string) => void)[] = [];
	const exitListeners: ((event: { exitCode: number }) => void)[] = [];
	// A multi-byte character can be split across two reads.
	const decoder = new TextDecoder();
	const proc = bun.spawn([file, ...args], {
		cwd: options.cwd,
		env: options.env,
		terminal: {
			cols: options.cols,
			rows: options.rows,
			name: options.name,
			data(_terminal, data) {
				const text = decoder.decode(data, { stream: true });
				if (!text) return;
				for (const listener of dataListeners) listener(text);
			},
		},
	});
	void proc.exited.then((exitCode) => {
		proc.terminal.close();
		for (const listener of exitListeners) listener({ exitCode });
	});

	return {
		onData: (listener) => {
			dataListeners.push(listener);
		},
		onExit: (listener) => {
			exitListeners.push(listener);
		},
		write: (data) => {
			proc.terminal.write(data);
		},
		resize: (cols, rows) => {
			proc.terminal.resize(cols, rows);
		},
		kill: () => {
			proc.kill("SIGHUP");
		},
	};
};
