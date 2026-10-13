import { describe, expect, it } from "vitest";
import {
	deletionTargets,
	selectedItems,
	toggleAll,
} from "@/components/dashboard/domains/selection";

const item = (
	key: string,
	serverId: string | null = null,
	deletable = true,
) => ({
	key,
	serverId,
	deletable,
});

const items = [
	item("a"),
	item("b"),
	item("c"),
	item("remote", "server-1"),
	item("wildcard", null, false),
];

describe("unused certificate selection", () => {
	it("deletes every ticked certificate when the button of a ticked row is pressed", () => {
		const selected = new Set(["a", "b", "c"]);

		expect(
			deletionTargets(items[1]!, items, selected).map((entry) => entry.key),
		).toEqual(["a", "b", "c"]);
	});

	it("deletes only the row itself when that row is not ticked", () => {
		const selected = new Set(["a", "b"]);

		expect(
			deletionTargets(items[2]!, items, selected).map((entry) => entry.key),
		).toEqual(["c"]);
	});

	it("keeps a deletion on the server of the pressed row", () => {
		const selected = new Set(["a", "b", "remote"]);

		expect(
			deletionTargets(items[0]!, items, selected).map((entry) => entry.key),
		).toEqual(["a", "b"]);
		expect(
			deletionTargets(items[3]!, items, selected).map((entry) => entry.key),
		).toEqual(["remote"]);
	});

	it("leaves out certificates that cannot be deleted", () => {
		expect(
			selectedItems(items, new Set(["a", "wildcard"])).map(
				(entry) => entry.key,
			),
		).toEqual(["a"]);
	});

	it("selects every deletable certificate and clears on the second press", () => {
		const all = toggleAll(items, new Set(["a"]));

		expect([...all]).toEqual(["a", "b", "c", "remote"]);
		expect(toggleAll(items, all).size).toBe(0);
	});
});
