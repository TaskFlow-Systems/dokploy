import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createMenuForAuthUser,
	linksAboveFirstGated,
	MENU,
} from "@/components/layouts/side";

type MenuOpts = Parameters<typeof createMenuForAuthUser>[0];

const permissionsOf = (allowed: boolean) =>
	new Proxy(
		{},
		{ get: () => new Proxy({}, { get: () => allowed }) },
	) as MenuOpts["permissions"];

const users: Record<string, MenuOpts> = {
	"owner on a self-hosted panel": {
		auth: { role: "owner" } as MenuOpts["auth"],
		permissions: permissionsOf(true),
		isCloud: false,
	},
	"owner on cloud": {
		auth: { role: "owner" } as MenuOpts["auth"],
		permissions: permissionsOf(true),
		isCloud: true,
	},
	"member with no permissions": {
		auth: { role: "member" } as MenuOpts["auth"],
		permissions: permissionsOf(false),
		isCloud: false,
	},
};

const titles = (items: { title: string }[]) => items.map((item) => item.title);

describe("sidebar links before the user's permissions are known", () => {
	it("never take a gated link", () => {
		for (const items of [MENU.home, MENU.settings]) {
			expect(
				linksAboveFirstGated(items).filter((item) => item.isEnabled),
			).toEqual([]);
		}
	});

	it("keep the home list's first links available", () => {
		expect(titles(linksAboveFirstGated(MENU.home))).toEqual([
			"Home",
			"Projects",
		]);
	});

	it.each(Object.keys(users))("stay in their place for %s", (name) => {
		const menu = createMenuForAuthUser(users[name] as MenuOpts);
		for (const [early, final] of [
			[linksAboveFirstGated(MENU.home), menu.home],
			[linksAboveFirstGated(MENU.settings), menu.settings],
		] as const) {
			expect(titles(final).slice(0, early.length)).toEqual(titles(early));
		}
	});

	it("are what the sidebar renders", () => {
		const source = readFileSync(
			path.resolve(__dirname, "../../components/layouts/side.tsx"),
			"utf8",
		);
		expect(source).toContain("{homeLinks.map(");
		expect(source).toContain("{settingsLinks.map(");
		expect(source).not.toContain("{filteredHome.map(");
		expect(source).not.toContain("{filteredSettings.map(");
	});
});

describe("user menu and footer text while their data loads", () => {
	const read = (file: string) =>
		readFileSync(
			path.resolve(__dirname, "../../components/layouts", file),
			"utf8",
		);

	it("keeps the email line's height before user.get answers", () => {
		const source = read("user-nav.tsx");
		expect(source).toContain('<span className="block h-4 truncate text-xs">');
		expect(source).not.toContain(
			'<span className="truncate text-xs">{data?.user?.email}</span>',
		);
	});

	it("holds one line for the white-label footer text while it loads", () => {
		const source = read("side.tsx");
		expect(source).toContain("isWhitelabelingPending");
		expect(source).toContain(
			"isWhitelabelingPending && haveValidLicense === true",
		);
		expect(source).toContain(
			"(isFooterTextPending || whitelabeling?.footerText) && (",
		);
		expect(source).toContain('className="min-h-4 px-3 text-xs');
	});
});
