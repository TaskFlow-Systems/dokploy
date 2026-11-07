import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShowInternalLibsqlCredentials } from "@/components/dashboard/libsql/general/show-internal-libsql-credentials";
import { ShowLibsqlPrimaryUrl } from "@/components/dashboard/libsql/general/show-libsql-primary-url";

const state = vi.hoisted(() => ({
	libsql: null as Record<string, unknown> | null,
	permissions: null as { service: { create: boolean } } | null,
}));

vi.mock("@/utils/api", () => ({
	api: {
		libsql: {
			one: {
				useQuery: () => ({ data: state.libsql, refetch: vi.fn() }),
			},
			update: {
				useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
			},
			revealCredentials: {
				useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
			},
		},
		user: {
			getPermissions: {
				useQuery: () => ({ data: state.permissions }),
			},
		},
	},
}));

const libsql = (sqldNode: "primary" | "replica") => ({
	appName: "lib-app",
	command: null,
	databasePassword: "stored",
	databaseUser: "panel",
	enableNamespaces: false,
	sqldNode,
	sqldPrimaryUrl: sqldNode === "replica" ? "http://primary:5001" : null,
});

const internal = () =>
	renderToStaticMarkup(
		createElement(ShowInternalLibsqlCredentials, { libsqlId: "libsql-1" }),
	);

const primaryUrl = () =>
	renderToStaticMarkup(
		createElement(ShowLibsqlPrimaryUrl, { libsqlId: "libsql-1" }),
	);

describe("a libSQL database's page", () => {
	beforeEach(() => {
		state.permissions = { service: { create: true } };
	});

	it("offers the gRPC port and replication URL on a primary", () => {
		state.libsql = libsql("primary");

		expect(internal()).toContain("Internal Replication Connection URL");
		expect(internal()).toContain("Internal GRPC Port");
		expect(internal()).toContain("Internal Connection URL");
	});

	it("does not offer them on a replica, which does not open that port", () => {
		state.libsql = libsql("replica");

		expect(internal()).not.toContain("Internal Replication Connection URL");
		expect(internal()).not.toContain("Internal GRPC Port");
		expect(internal()).toContain("Internal Connection URL");
	});

	it("has no primary URL form on a primary", () => {
		state.libsql = libsql("primary");

		expect(primaryUrl()).toBe("");
	});

	it("lets someone who can update the service edit it on a replica", () => {
		state.libsql = libsql("replica");

		const html = primaryUrl();
		expect(html).toContain("Sqld Primary URL");
		expect(html).toContain("Save");
		expect(html).not.toMatch(/<input[^>]*\sdisabled=""/);
	});

	it.each([
		["cannot update the service", { service: { create: false } }],
		["has no answer on permissions yet", null],
	])("shows it read-only to someone who %s", (_, permissions) => {
		state.libsql = libsql("replica");
		state.permissions = permissions;

		const html = primaryUrl();
		expect(html).toContain("Sqld Primary URL");
		expect(html).not.toContain("Save");
		expect(html).toMatch(/<input[^>]*\sdisabled=""/);
	});
});
