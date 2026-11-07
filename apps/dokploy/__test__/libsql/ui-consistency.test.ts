import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShowGeneralLibsql } from "@/components/dashboard/libsql/general/show-general-libsql";
import { ShowCustomCommand } from "@/components/dashboard/postgres/advanced/show-custom-command";
import { TooltipProvider } from "@/components/ui/tooltip";

const { state, database, query } = vi.hoisted(() => {
	const query = (data: unknown) => ({
		useQuery: () => ({ data, refetch: () => undefined }),
	});
	const mutation = {
		useMutation: () => ({
			mutateAsync: async () => undefined,
			isPending: false,
		}),
	};
	return {
		query,
		state: { permissions: null as { deployment: { create: boolean } } | null },
		database: {
			one: query({
				dockerImage: "image:1",
				command: null,
				appName: "app",
				applicationStatus: "done",
				sqldNode: "primary",
				mounts: [],
			}),
			update: mutation,
			reload: mutation,
			start: mutation,
			stop: mutation,
			deployWithLogs: { useSubscription: () => undefined },
		},
	};
});

vi.mock("@/utils/api", () => ({
	api: {
		libsql: database,
		postgres: database,
		docker: { getContainersByAppNameMatch: query([]) },
		user: {
			getPermissions: {
				useQuery: () => ({ data: state.permissions }),
			},
		},
	},
}));

const general = () =>
	renderToStaticMarkup(
		createElement(
			TooltipProvider,
			null,
			createElement(ShowGeneralLibsql, { libsqlId: "libsql-1" }),
		),
	);

const advanced = (type: "libsql" | "postgres") =>
	renderToStaticMarkup(createElement(ShowCustomCommand, { id: "id-1", type }));

describe("a libSQL database's Advanced tab", () => {
	it("has no Arguments field, which libsql.update would drop", () => {
		const html = advanced("libsql");

		expect(html).toContain("Docker Image");
		expect(html).toContain("Command");
		expect(html).not.toContain("Arguments (Args)");
		expect(html).not.toContain("Add Argument");
	});

	it("keeps Arguments for Postgres", () => {
		expect(advanced("postgres")).toContain("Arguments (Args)");
	});
});

describe("a libSQL database's deploy buttons", () => {
	beforeEach(() => {
		state.permissions = { deployment: { create: true } };
	});

	it("show Deploy, Reload and Stop to someone who can deploy", () => {
		const html = general();

		expect(html).toContain("Deploy");
		expect(html).toContain("Reload");
		expect(html).toContain("Stop");
	});

	it("hide them from a member without deploy permission", () => {
		state.permissions = { deployment: { create: false } };
		const html = general();

		expect(html).not.toContain("Deploy</div>");
		expect(html).not.toContain("Reload");
		expect(html).not.toContain("Stop");
		expect(html).toContain("Open Terminal");
	});
});

const appRoot = path.resolve(__dirname, "../..");
const servicePage = (type: string, id: string) =>
	readFileSync(
		path.join(
			appRoot,
			`pages/dashboard/project/[projectId]/environment/[environmentId]/services/${type}/[${id}].tsx`,
		),
		"utf8",
	);

describe("the libSQL page's tabs", () => {
	const postgres = servicePage("postgres", "postgresId");
	const libsql = servicePage("libsql", "libsqlId");

	it.each([
		["environment", "permissions?.envVars.read"],
		["logs", "permissions?.logs.read"],
		["monitoring", "permissions?.monitoring.read"],
		["advanced", "permissions?.service.create"],
	])("hides %s behind the permission Postgres checks", (tab, permission) => {
		const tabTrigger = new RegExp(
			`\\{${permission.replace(/[?.]/g, "\\$&")}[^]*?<TabsTrigger\\s+value="${tab}"`,
		);
		const tabContent = new RegExp(
			`\\{${permission.replace(/[?.]/g, "\\$&")} &&\\s*\\(\\s*<TabsContent value="${tab}"`,
		);

		for (const source of [postgres, libsql]) {
			expect(source).toMatch(tabTrigger);
			expect(source).toMatch(tabContent);
		}
	});
});
