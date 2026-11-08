import * as ssh2 from "ssh2";

const MAX_ATTEMPTS = 10;

// ssh2's generator writes a private key its own parser rejects about once in
// 350 ed25519 keys ("Malformed OpenSSH private key"), and the key would only
// fail later, when a server connects with it.
const generateParsableKeyPair = (
	generate: () => { private: string; public: string },
) => {
	for (let attempt = 1; ; attempt++) {
		const keys = generate();
		if (
			!(ssh2.utils.parseKey(keys.private) instanceof Error) ||
			attempt === MAX_ATTEMPTS
		) {
			return keys;
		}
	}
};

export const generateSSHKey = async (type: "rsa" | "ed25519" = "rsa") => {
	const keys = generateParsableKeyPair(() =>
		type === "rsa"
			? ssh2.utils.generateKeyPairSync("rsa", {
					bits: 4096,
					comment: "dokploy",
				})
			: ssh2.utils.generateKeyPairSync("ed25519", { comment: "dokploy" }),
	);
	return {
		privateKey: keys.private,
		publicKey: keys.public,
	};
};
