import {
	buildTraefikRoutesCommand,
	extractRuleHosts,
	parseTraefikRoutes,
} from "@dokploy/server/utils/domain-overview/traefik-routes";
import { describe, expect, it } from "vitest";

const inspectLine = (name: string, labels: Record<string, string> | null) =>
	`/${name}|${JSON.stringify(labels)}`;

describe("traefik route label parser", () => {
	it("reads a single Host rule with its compose project", () => {
		const output = inspectLine("shop-web-1", {
			"traefik.enable": "true",
			"traefik.http.routers.shop-web-router-1.rule":
				"Host(`shop.example.test`)",
			"com.docker.compose.project": "shop-abc123",
		});

		expect(parseTraefikRoutes(output)).toEqual([
			{
				host: "shop.example.test",
				containerName: "shop-web-1",
				composeProject: "shop-abc123",
				serviceName: null,
			},
		]);
	});

	it("splits a multi-host rule joined with || into one route per host", () => {
		const output = inspectLine("api-1", {
			"traefik.http.routers.api.rule":
				"Host(`api.example.test`) || Host(`api2.example.test`)",
		});

		expect(parseTraefikRoutes(output).map((route) => route.host)).toEqual([
			"api.example.test",
			"api2.example.test",
		]);
	});

	it("reads hosts listed inside a single Host matcher", () => {
		expect(
			extractRuleHosts("Host(`one.example.test`, `two.example.test`)"),
		).toEqual(["one.example.test", "two.example.test"]);
	});

	it("ignores containers whose labels have no HTTP router rule", () => {
		const output = inspectLine("worker-1", {
			"traefik.enable": "true",
			"traefik.http.services.worker.loadbalancer.server.port": "3000",
			"traefik.tcp.routers.worker.rule": "HostSNI(`tcp.example.test`)",
		});

		expect(parseTraefikRoutes(output)).toEqual([]);
	});

	it("skips containers that Traefik is told to ignore", () => {
		const output = inspectLine("hidden-1", {
			"traefik.enable": "false",
			"traefik.http.routers.hidden.rule": "Host(`hidden.example.test`)",
		});

		expect(parseTraefikRoutes(output)).toEqual([]);
	});

	it("reads the swarm service name when there is no compose project", () => {
		const output = inspectLine("swarm-app.1.abc", {
			"traefik.http.routers.swarm-app.rule": "Host(`swarm.example.test`)",
			"com.docker.swarm.service.name": "swarm-app",
		});

		expect(parseTraefikRoutes(output)).toEqual([
			{
				host: "swarm.example.test",
				containerName: "swarm-app.1.abc",
				composeProject: null,
				serviceName: "swarm-app",
			},
		]);
	});

	it("treats a container without labels as having no routes", () => {
		expect(parseTraefikRoutes(inspectLine("bare-1", null))).toEqual([]);
	});

	it("reports a host once per container even when two routers repeat it", () => {
		const output = inspectLine("dup-1", {
			"traefik.http.routers.a.rule": "Host(`dup.example.test`)",
			"traefik.http.routers.b.rule": "Host(`dup.example.test`)",
		});

		expect(parseTraefikRoutes(output)).toHaveLength(1);
	});

	it("attaches every host of a || rule to the same container", () => {
		const output = inspectLine("pipe-1", {
			"traefik.http.routers.pipe.rule":
				"Host(`pipe.example.test`) || Host(`pipe2.example.test`)",
		});

		expect(
			parseTraefikRoutes(output).map((route) => route.containerName),
		).toEqual(["pipe-1", "pipe-1"]);
	});

	it("ignores blank and malformed lines", () => {
		const output = [
			"",
			"no separator here",
			"/broken-1|{not json",
			inspectLine("ok-1", {
				"traefik.http.routers.ok.rule": "Host(`ok.example.test`)",
			}),
		].join("\n");

		expect(parseTraefikRoutes(output).map((route) => route.host)).toEqual([
			"ok.example.test",
		]);
	});

	it("builds the docker inspect command with the label format", () => {
		expect(buildTraefikRoutesCommand()).toBe(
			"docker ps -q | xargs -r docker inspect --format '{{.Name}}|{{json .Config.Labels}}'",
		);
	});
});
