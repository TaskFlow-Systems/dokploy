import { spawnPty } from "../../../server/wss/pty";

const run = (args: string[], input?: string, resize?: [number, number]) =>
	new Promise<{ output: string; exitCode: number }>((resolve) => {
		void spawnPty("sh", ["-c", ...args], { cols: 80, rows: 24 }).then((pty) => {
			let output = "";
			pty.onData((data) => {
				output += data;
			});
			pty.onExit(({ exitCode }) => resolve({ output, exitCode }));
			if (resize) pty.resize(...resize);
			if (input) pty.write(input);
		});
	});

const results = {
	lines: await run(["echo a; sleep 1; echo b"]),
	unicode: await run(["printf 'ж€😀\\n'"]),
	input: await run(["read line; echo got:$line"], "hello\n"),
	size: await run(["sleep 0.3; stty size"], undefined, [100, 40]),
	exitCode: await run(["exit 3"]),
	killed: await new Promise<boolean>((resolve) => {
		void spawnPty("sh", ["-c", "sleep 30"], { cols: 80, rows: 24 }).then(
			(pty) => {
				const timer = setTimeout(() => resolve(false), 5000);
				pty.onExit(() => {
					clearTimeout(timer);
					resolve(true);
				});
				pty.kill();
			},
		);
	}),
};
console.log(JSON.stringify(results));
