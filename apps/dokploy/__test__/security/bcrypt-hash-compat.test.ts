import bcrypt from "bcrypt";
import { describe, expect, it } from "vitest";

// Generated with bcrypt 5.1.1, the version these hashes were stored with.
const LEGACY_HASHES = [
	{
		label: "login password ($2b$, cost 10)",
		password: "legacy-login-password",
		hash: "$2b$10$OZR9Sl3nuE.yt3N7Uz77Eu./0x/5vtxeregQv82qIwpWTJvrXoMMy",
	},
	{
		label: "$2a$ hash (cost 10)",
		password: "legacy-basic-auth",
		hash: "$2a$10$.3CLNohfPPBm3RvuTs/IQucFilfkHNwtftJP6si4XSzO3ir03pp2O",
	},
];

describe("bcrypt hash compatibility", () => {
	it.each(LEGACY_HASHES)(
		"verifies a stored $label",
		async ({ password, hash }) => {
			expect(await bcrypt.compare(password, hash)).toBe(true);
			expect(bcrypt.compareSync(password, hash)).toBe(true);
			expect(await bcrypt.compare(`${password}-wrong`, hash)).toBe(false);
		},
	);

	it("still produces $2b$ hashes that Traefik basic auth accepts", async () => {
		const hash = await bcrypt.hash("basic-auth-password", 10);
		expect(hash).toMatch(/^\$2b\$\d{2}\$[./A-Za-z0-9]{53}$/);
		expect(await bcrypt.compare("basic-auth-password", hash)).toBe(true);
	});
});
