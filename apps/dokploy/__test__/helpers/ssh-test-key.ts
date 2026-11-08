import { utils } from "ssh2";

// ssh2's ed25519 generator writes a key its own parser rejects about once in
// 350 keys, which made every test that starts an ssh2 server fail now and then.
export const generateSshTestKey = () => {
	for (;;) {
		const { private: key } = utils.generateKeyPairSync("ed25519");
		if (!(utils.parseKey(key) instanceof Error)) {
			return key;
		}
	}
};
