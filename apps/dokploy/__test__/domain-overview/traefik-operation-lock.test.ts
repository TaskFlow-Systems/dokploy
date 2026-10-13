import {
	acquireTraefikOperation,
	runningTraefikOperation,
} from "@dokploy/server/setup/traefik-operation-lock";
import { describe, expect, it } from "vitest";

describe("traefik operation lock", () => {
	it("allows one operation per server and names the holder", () => {
		const release = acquireTraefikOperation("server-1", "reload");

		expect(release).not.toBeNull();
		expect(acquireTraefikOperation("server-1", "certificate deletion")).toBe(
			null,
		);
		expect(runningTraefikOperation("server-1")).toBe("reload");
		release?.();
		expect(runningTraefikOperation("server-1")).toBeNull();
	});

	it("keeps servers and the local host independent", () => {
		const local = acquireTraefikOperation(null, "reload");
		const remote = acquireTraefikOperation("server-2", "reload");

		expect(local).not.toBeNull();
		expect(remote).not.toBeNull();
		local?.();
		remote?.();
	});

	it("ignores a second release so it cannot free a newer holder", () => {
		const first = acquireTraefikOperation("server-3", "reload");
		first?.();
		const second = acquireTraefikOperation("server-3", "certificate deletion");
		first?.();

		expect(runningTraefikOperation("server-3")).toBe("certificate deletion");
		second?.();
	});
});
