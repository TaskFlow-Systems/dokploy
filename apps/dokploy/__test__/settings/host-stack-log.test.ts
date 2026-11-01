import {
	COMPONENTS_UPDATE_DONE,
	COMPONENTS_UPDATE_FAILED,
} from "@dokploy/server/setup/server-components";
import { describe, expect, it } from "vitest";
import {
	UPDATE_DONE,
	UPDATE_FAILED,
	updateOutcome,
} from "@/components/dashboard/settings/servers/host-stack-log";

const outcomesFor = (chunks: string[]) => {
	let log = "";
	const outcomes: string[] = [];
	for (const chunk of chunks) {
		const outcome = updateOutcome(log, `${log}${chunk}`);
		log += chunk;
		if (outcome !== null) {
			outcomes.push(outcome);
		}
	}
	return outcomes;
};

describe("updateOutcome", () => {
	it("uses the same markers as the server", () => {
		expect(UPDATE_DONE).toBe(COMPONENTS_UPDATE_DONE);
		expect(UPDATE_FAILED).toBe(COMPONENTS_UPDATE_FAILED);
	});

	it("reports a success marker split across two chunks", () => {
		expect(
			outcomesFor([
				"Redis version 8.10.3 installed ✅\nComponents update fin",
				"ished ✅\n",
			]),
		).toEqual(["done"]);
	});

	it("reports a failure marker split across two chunks", () => {
		expect(outcomesFor(["Components update fa", "iled ❌\n"])).toEqual([
			"failed",
		]);
	});

	it("reports a marker once, even when more output follows it", () => {
		expect(
			outcomesFor([`${COMPONENTS_UPDATE_DONE}\n`, "trailing output\n"]),
		).toEqual(["done"]);
	});

	it("reports nothing while no marker has arrived", () => {
		expect(
			outcomesFor([
				"Pulling redis:8.10.3\n",
				"Traefik version 3.6.1 installed ✅\n",
			]),
		).toEqual([]);
	});
});
