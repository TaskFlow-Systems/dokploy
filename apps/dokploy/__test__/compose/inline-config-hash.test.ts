import {
	applyInlineConfigHashLabels,
	COMPOSE_CONFIG_HASH_LABEL,
} from "@dokploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { describe, expect, it } from "vitest";

const spec = (
	small: string,
	service: Record<string, unknown> = {},
): ComposeSpecification =>
	({
		services: {
			ch: {
				image: "clickhouse/clickhouse-server",
				configs: [{ source: "small", target: "/etc/small.xml" }, "inserts"],
				...service,
			},
			web: { image: "nginx", labels: ["keep=1"] },
		},
		configs: {
			small: { content: small },
			inserts: { content: "<clickhouse/>" },
			fromFile: { file: "./a.xml" },
		},
	}) as unknown as ComposeSpecification;

const hashOf = (result: ComposeSpecification, name = "ch") => {
	const labels = result.services?.[name]?.labels;
	if (Array.isArray(labels)) {
		return labels
			.find((label) => label.startsWith(`${COMPOSE_CONFIG_HASH_LABEL}=`))
			?.split("=")[1];
	}
	return (labels as Record<string, string> | undefined)?.[
		COMPOSE_CONFIG_HASH_LABEL
	];
};

const labelled = (result: ComposeSpecification) => {
	applyInlineConfigHashLabels(result);
	return result;
};

describe("applyInlineConfigHashLabels", () => {
	it("labels a service with the contents of the inline configs it mounts", () => {
		const hash = hashOf(labelled(spec("<a/>")));

		expect(hash).toMatch(/^[0-9a-f]{32}$/);
		expect(hashOf(labelled(spec("<a/>")))).toBe(hash);
	});

	it("changes the label when the contents change, also by removed lines", () => {
		const before = hashOf(
			labelled(spec("<a>\n  <seccomp>log</seccomp>\n</a>")),
		);
		const after = hashOf(labelled(spec("<a>\n</a>")));

		expect(after).not.toBe(before);
	});

	it("leaves the services without inline configs and their labels alone", () => {
		const result = labelled(spec("<a/>"));

		expect(result.services?.web?.labels).toEqual(["keep=1"]);
	});

	it("keeps the service's own labels, as a list or a map", () => {
		const list = labelled(spec("<a/>", { labels: ["team=data"] }));
		const map = labelled(spec("<a/>", { labels: { team: "data" } }));

		expect(list.services?.ch?.labels).toContain("team=data");
		expect(map.services?.ch?.labels).toMatchObject({ team: "data" });
		expect(hashOf(list)).toBe(hashOf(map));
	});

	it("replaces a label left by an earlier deployment", () => {
		const result = labelled(
			spec("<a/>", { labels: [`${COMPOSE_CONFIG_HASH_LABEL}=stale`] }),
		);
		const labels = result.services?.ch?.labels as string[];

		expect(
			labels.filter((label) => label.startsWith(COMPOSE_CONFIG_HASH_LABEL)),
		).toEqual([`${COMPOSE_CONFIG_HASH_LABEL}=${hashOf(result)}`]);
		expect(hashOf(result)).not.toBe("stale");
	});

	it("drops the label once the service mounts no inline config", () => {
		const result = labelled(
			spec("<a/>", {
				configs: ["fromFile"],
				labels: { [COMPOSE_CONFIG_HASH_LABEL]: "stale", team: "data" },
			}),
		);

		expect(result.services?.ch?.labels).toEqual({ team: "data" });
	});
});
