import {
	enrichDockerDiskUsageDetails,
	limitDockerDiskUsageDetails,
	parseDockerDiskUsageSummary,
	parseDockerDiskUsageVerbose,
	resolveDockerDiskUsageDetailLimit,
} from "@dokploy/server/utils/docker/utils";
import { describe, expect, test } from "vitest";

const summaryOutput = [
	'{"Active":"3","Reclaimable":"92.61MB (0%)","Size":"15.84GB","TotalCount":"4","Type":"Images"}',
	'{"Active":"3","Reclaimable":"0B (0%)","Size":"53.25kB","TotalCount":"3","Type":"Containers"}',
	'{"Active":"2","Reclaimable":"0B (0%)","Size":"68.57MB","TotalCount":"2","Type":"Local Volumes"}',
	'{"Active":"0","Reclaimable":"15.2GB","Size":"15.2GB","TotalCount":"326","Type":"Build Cache"}',
].join("\n");

const verboseOutput = [
	"Images space usage:",
	"",
	"REPOSITORY   TAG       IMAGE ID       CREATED        SIZE      SHARED SIZE   UNIQUE SIZE   CONTAINERS",
	"nginx        alpine    8b1e78743a03   2 weeks ago    92.6MB    0B            92.61MB       0",
	"postgres     16        4b7183ac05f8   2 weeks ago    663MB     0B            662.9MB       1",
	"",
	"Containers space usage:",
	"",
	"CONTAINER ID   IMAGE            COMMAND                  LOCAL VOLUMES   SIZE      CREATED             STATUS             NAMES",
	'057f8980d33f   postgres:16      "docker-entrypoint.s…"   1               20.5kB    About an hour ago   Up About an hour   dokploy-postgres.1.test',
	'fc4976a35ce3   redis:7          "docker-entrypoint.s…"   1               4.1kB     About an hour ago   Up About an hour   dokploy-redis.1.test',
	"",
	"Local Volumes space usage:",
	"",
	"VOLUME NAME        LINKS     SIZE",
	"dokploy-redis      1         226B",
	"dokploy-postgres   1         68.57MB",
	"",
	"Build cache usage: 15.2GB",
	"",
	"CACHE ID       CACHE TYPE     SIZE      CREATED       LAST USED     USAGE     SHARED",
	"8vq5d5k500k0   regular        13.4MB    5 days ago    5 days ago    1         false",
	"gso67gl55f9c   regular        123MB     5 days ago    5 days ago    1         false",
].join("\n");

describe("parseDockerDiskUsageSummary", () => {
	test("parses Docker system df summary output", () => {
		expect(parseDockerDiskUsageSummary(summaryOutput)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					active: 3,
					reclaimable: "92.61MB (0%)",
					size: "15.84GB",
					sizeBytes: 15.84 * 1024 ** 3,
					totalCount: 4,
					type: "Images",
				}),
				expect.objectContaining({
					active: 3,
					size: "53.25kB",
					sizeBytes: 53.25 * 1024,
					totalCount: 3,
					type: "Containers",
				}),
			]),
		);
	});
});

describe("parseDockerDiskUsageVerbose", () => {
	test("parses verbose Docker disk usage sections and sorts details by size", () => {
		const details = parseDockerDiskUsageVerbose(verboseOutput);

		expect(details.images[0]).toEqual(
			expect.objectContaining({
				id: "4b7183ac05f8",
				name: "postgres:16",
				size: "663MB",
				sizeBytes: 663 * 1024 ** 2,
			}),
		);
		expect(details.containers[0]).toEqual(
			expect.objectContaining({
				id: "057f8980d33f",
				name: "dokploy-postgres.1.test",
				size: "20.5kB",
			}),
		);
		expect(details.volumes[0]).toEqual(
			expect.objectContaining({
				id: "dokploy-postgres",
				name: "dokploy-postgres",
				size: "68.57MB",
			}),
		);
		expect(details.buildCache[0]).toEqual(
			expect.objectContaining({
				id: "gso67gl55f9c",
				name: "regular",
				size: "123MB",
			}),
		);
	});

	test("enriches dangling images and volumes with inspect context", () => {
		const details = parseDockerDiskUsageVerbose(
			[
				"Images space usage:",
				"",
				"REPOSITORY   TAG       IMAGE ID       CREATED       SIZE     SHARED SIZE   UNIQUE SIZE   CONTAINERS",
				"<none>       <none>    2e7598a736d0   2 hours ago   2.99GB   247.5MB       2.743GB       1",
				"",
				"Containers space usage:",
				"",
				"CONTAINER ID   IMAGE          COMMAND                  LOCAL VOLUMES   SIZE   CREATED       STATUS      NAMES",
				'274333ea2993   2e7598a736d0  "docker-entrypoint.s…"   1               0B     2 hours ago   Exited      dokploy.1.test',
				"",
				"Local Volumes space usage:",
				"",
				"VOLUME NAME        LINKS     SIZE",
				"dokploy-postgres   1         69.41MB",
			].join("\n"),
		);

		const enriched = enrichDockerDiskUsageDetails(details, {
			containers: [
				{
					id: "274333ea2993",
					image: "2e7598a736d0",
					imageId: "sha256:2e7598a736d0full",
					name: "dokploy.1.test",
				},
			],
			imageInspects: new Map([
				[
					"2e7598a736d0",
					{
						Id: "sha256:2e7598a736d0full",
						RepoDigests: [],
						RepoTags: ["<none>:<none>"],
					},
				],
			]),
			volumeInspects: new Map([
				[
					"dokploy-postgres",
					{
						Driver: "local",
						Mountpoint: "/var/lib/docker/volumes/dokploy-postgres/_data",
						Name: "dokploy-postgres",
					},
				],
			]),
		});

		expect(enriched.images[0]).toEqual(
			expect.objectContaining({
				name: "<none>:<none>",
				subtitle: "Untagged local image",
			}),
		);
		expect(enriched.images[0]?.meta).toEqual(
			expect.arrayContaining([
				{
					label: "Full image id",
					value: "sha256:2e7598a736d0full",
				},
				{
					label: "Source",
					value: "dangling local image",
				},
				{
					label: "Used by",
					value: "dokploy.1.test",
				},
			]),
		);
		expect(enriched.volumes[0]?.meta).toEqual(
			expect.arrayContaining([
				{
					label: "Mountpoint",
					value: "/var/lib/docker/volumes/dokploy-postgres/_data",
				},
				{
					label: "Driver",
					value: "local",
				},
			]),
		);
	});

	test("names untagged images after the references that created them", () => {
		const details = parseDockerDiskUsageVerbose(
			[
				"Images space usage:",
				"",
				"REPOSITORY   TAG       IMAGE ID       CREATED       SIZE     SHARED SIZE   UNIQUE SIZE   CONTAINERS",
				"<none>       <none>    d0ef856968db   2 hours ago   2.45GB   74.87MB       2.373GB       1",
				"<none>       <none>    3a02d38405dc   5 months ago  114MB    0B            114MB         2",
				"<none>       <none>    b1c5c0aec2ab   9 hours ago   1.42GB   1.416GB       0B            0",
			].join("\n"),
		);
		const redisDigest =
			"sha256:09160599abd229764c0fb44cb6be640294e1d360a54b19985ab4843dcf2d90f1";

		const enriched = enrichDockerDiskUsageDetails(details, {
			containers: [
				{
					id: "old-panel-task",
					image: "ghcr.io/example/panel:dev",
					imageId: "sha256:d0ef856968dbfull",
					name: "panel.1.old",
					state: "exited",
				},
				{
					id: "redis-a",
					image: `redis:8-alpine@${redisDigest}`,
					imageId: "sha256:3a02d38405dcfull",
					name: "stack-redis-1",
					state: "running",
				},
				{
					id: "redis-b",
					image: `redis:8-alpine@${redisDigest}`,
					imageId: "sha256:3a02d38405dcfull",
					name: "stack-redis-rate-limit-1",
					state: "running",
				},
			],
			imageInspects: new Map([
				[
					"d0ef856968db",
					{
						Id: "sha256:d0ef856968dbfull",
						RepoDigests: ["ghcr.io/example/panel@sha256:08556bfbd114b366"],
						RepoTags: [],
					},
				],
				[
					"3a02d38405dc",
					{
						Id: "sha256:3a02d38405dcfull",
						RepoDigests: [`redis@${redisDigest}`],
						RepoTags: [],
					},
				],
				[
					"b1c5c0aec2ab",
					{
						Id: "sha256:b1c5c0aec2abfull",
						RepoDigests: [
							"registry.example.com:5000/team/grafana@sha256:b01e2b61edddaf1f8ed9",
						],
						RepoTags: [],
					},
				],
			]),
		});
		const byId = new Map(enriched.images.map((image) => [image.id, image]));

		expect(byId.get("d0ef856968db")).toEqual(
			expect.objectContaining({
				name: "ghcr.io/example/panel:dev",
				subtitle: "Previous version: the tag now points to another image",
			}),
		);
		expect(byId.get("d0ef856968db")?.meta).toEqual(
			expect.arrayContaining([
				{ label: "Source", value: "ghcr.io/example/panel:dev" },
				{ label: "Used by", value: "panel.1.old (exited)" },
			]),
		);
		expect(byId.get("3a02d38405dc")).toEqual(
			expect.objectContaining({
				name: "redis:8-alpine",
				subtitle: "Pulled by digest, no local tag",
			}),
		);
		expect(byId.get("3a02d38405dc")?.meta).toEqual(
			expect.arrayContaining([
				{
					label: "Used by",
					value: "stack-redis-1, stack-redis-rate-limit-1",
				},
			]),
		);
		expect(byId.get("b1c5c0aec2ab")).toEqual(
			expect.objectContaining({
				name: "registry.example.com:5000/team/grafana@sha256:b01e2b61eddd",
				subtitle: "Dangling local image",
			}),
		);
	});
});

describe("limitDockerDiskUsageDetails", () => {
	const makeDetail = (index: number) => ({
		id: `image-${index}`,
		meta: [],
		name: `image:${index}`,
		size: `${index}MB`,
		sizeBytes: index * 1024 ** 2,
	});

	test("limits detail rows by selected count and allows all rows", () => {
		const details = {
			buildCache: [],
			containers: [],
			images: Array.from({ length: 18 }, (_, index) => makeDetail(index + 1)),
			volumes: Array.from({ length: 12 }, (_, index) => makeDetail(index + 1)),
		};

		expect(limitDockerDiskUsageDetails(details).images).toHaveLength(10);
		expect(limitDockerDiskUsageDetails(details, 5).images).toHaveLength(5);
		expect(limitDockerDiskUsageDetails(details, 15).images).toHaveLength(15);
		expect(limitDockerDiskUsageDetails(details, null).images).toHaveLength(18);
		expect(limitDockerDiskUsageDetails(details, null).volumes).toHaveLength(12);
	});
});

describe("resolveDockerDiskUsageDetailLimit", () => {
	test("defaults only missing values and preserves all rows selection", () => {
		expect(resolveDockerDiskUsageDetailLimit(undefined)).toBe(10);
		expect(resolveDockerDiskUsageDetailLimit(5)).toBe(5);
		expect(resolveDockerDiskUsageDetailLimit(15)).toBe(15);
		expect(resolveDockerDiskUsageDetailLimit(null)).toBeNull();
	});
});
