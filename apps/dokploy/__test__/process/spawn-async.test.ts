import { spawnAsync } from "@dokploy/server/utils/process/spawnAsync";
import { describe, expect, it } from "vitest";

describe("spawnAsync", () => {
	it("collects stdout across chunks and streams it to onData", async () => {
		const chunks: string[] = [];
		const result = await spawnAsync(
			"sh",
			["-c", "printf 'first\\n'; sleep 0.05; printf 'second\\n'"],
			(data) => chunks.push(data),
		);

		expect(result.toString()).toBe("first\nsecond\n");
		expect(result.length).toBe(13);
		expect(chunks.join("")).toBe("first\nsecond\n");
	});

	it("passes input to stdin", async () => {
		const result = await spawnAsync("cat", [], undefined, { input: "hello" });

		expect(result.toString()).toBe("hello");
	});

	it("rejects with stderr as the message and keeps both streams", async () => {
		const error = await spawnAsync("sh", [
			"-c",
			"printf out; printf 'boom' >&2; exit 4",
		])
			.then(() => null)
			.catch((e) => e);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("boom");
		expect(error.code).toBe(4);
		expect(error.stdout.toString()).toBe("out");
		expect(error.stderr.toString()).toBe("boom");
	});
});
