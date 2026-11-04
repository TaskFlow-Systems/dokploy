import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(appRoot, file), "utf8");

const servicePage = (type: string, id: string) =>
	read(
		`pages/dashboard/project/[projectId]/environment/[environmentId]/services/${type}/[${id}].tsx`,
	);

const databases = [
	["postgres", "postgresId"],
	["mysql", "mysqlId"],
	["mariadb", "mariadbId"],
	["mongo", "mongoId"],
	["redis", "redisId"],
	["libsql", "libsqlId"],
];

describe("what a service page knows at first paint", () => {
	it.each([
		["application", "applicationId"],
		["compose", "composeId"],
		...databases,
	])(
		"%s prefetches the permissions that gate its header and tabs",
		(type, id) => {
			expect(servicePage(type, id)).toContain(
				"helpers.user.getPermissions.prefetch()",
			);
		},
	);

	it.each(databases)(
		"%s prefetches the server IP, so the missing-IP warning is never a false one",
		(type, id) => {
			expect(servicePage(type, id)).toContain(
				"helpers.settings.getIp.prefetch()",
			);
		},
	);

	it("shows the application's Build Type only once the provider card's height is known", () => {
		expect(read("components/dashboard/application/general/show.tsx")).toMatch(
			/!isLoadingProviders && \(\s*<ShowBuildChooseForm/,
		);
	});
});
