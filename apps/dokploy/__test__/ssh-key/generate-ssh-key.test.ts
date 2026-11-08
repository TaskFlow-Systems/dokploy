import { generateSSHKey } from "@dokploy/server/utils/filesystem/ssh";
import { utils } from "ssh2";
import { describe, expect, it } from "vitest";
import { generateSshTestKey } from "../helpers/ssh-test-key";

describe("generated ssh keys", () => {
	it("generateSSHKey never returns an ed25519 key ssh2 cannot parse", async () => {
		for (let i = 0; i < 3000; i++) {
			const { privateKey } = await generateSSHKey("ed25519");
			expect(utils.parseKey(privateKey)).not.toBeInstanceOf(Error);
		}
	}, 60_000);

	it("the test key helper never returns a key ssh2 cannot parse", () => {
		for (let i = 0; i < 3000; i++) {
			expect(utils.parseKey(generateSshTestKey())).not.toBeInstanceOf(Error);
		}
	}, 60_000);
});
