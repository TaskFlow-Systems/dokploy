import dgram from "node:dgram";
import type { AddressInfo } from "node:net";

// A UDP DNS server answering for two names: `empty.test` exists and only has a
// TXT record (everything else is NOERROR with no data), `gone.test` is NXDOMAIN.
// Node reports the first as ENODATA; Bun reports ENOTFOUND for it.
export const startFakeDns = async () => {
	const socket = dgram.createSocket("udp4");
	socket.on("message", (message, remote) => {
		let offset = 12;
		const labels: string[] = [];
		while (message[offset]) {
			const length = message[offset] as number;
			labels.push(message.subarray(offset + 1, offset + 1 + length).toString());
			offset += length + 1;
		}
		const type = message.readUInt16BE(offset + 1);
		const question = message.subarray(12, offset + 5);
		const exists = labels.join(".") === "empty.test";
		const header = Buffer.alloc(12);
		message.copy(header, 0, 0, 2);
		header.writeUInt16BE(0x8180 | (exists ? 0 : 3), 2);
		header.writeUInt16BE(1, 4);
		let answer = Buffer.alloc(0);
		if (exists && type === 16) {
			const text = Buffer.from("hi");
			answer = Buffer.concat([
				Buffer.from([0xc0, 0x0c, 0, 16, 0, 1, 0, 0, 0, 60]),
				Buffer.from([0, text.length + 1, text.length]),
				text,
			]);
			header.writeUInt16BE(1, 6);
		}
		socket.send(
			Buffer.concat([header, question, answer]),
			remote.port,
			remote.address,
		);
	});
	await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
	return {
		server: `127.0.0.1:${(socket.address() as AddressInfo).port}`,
		close: () => socket.close(),
	};
};
