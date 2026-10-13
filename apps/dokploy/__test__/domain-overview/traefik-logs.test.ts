import {
	extractLogDomain,
	isErrorLine,
	readLogLevel,
	readLogTime,
	selectAcmeLogLines,
} from "@dokploy/server/utils/domain-overview/traefik-logs";
import { describe, expect, it } from "vitest";

const acmeLine = (index: number) =>
	`time="2026-10-08T10:00:${String(index % 60).padStart(2, "0")}Z" level=info msg="Certificate obtained for domains [host-${index}.example.test]"`;

describe("Traefik log line selection", () => {
	it("keeps only certificate and ACME lines and the last 300 of them", () => {
		const lines = [
			'time="2026-10-08T09:00:00Z" level=info msg="Starting provider"',
		];
		for (let index = 0; index < 350; index += 1) {
			lines.push(acmeLine(index));
			lines.push('time="2026-10-08T09:00:01Z" level=debug msg="request"');
		}

		const selected = selectAcmeLogLines(lines.join("\n"));

		expect(selected).toHaveLength(300);
		expect(selected[0]).toBe(acmeLine(50));
		expect(selected[299]).toBe(acmeLine(349));
	});
});

const consoleLine = (colour: boolean) => {
	const paint = (code: string, text: string) =>
		colour ? `\u001b[${code}m${text}\u001b[0m` : text;
	return `${paint("90", "2026-10-10T22:30:12Z")} ${paint("31", "ERR")} ${paint("1", "Error renewing ACME certificate: {gone.example.test []}")} ${paint("36", "error=")}"resolver: one or more domains had a problem: [gone.example.test: DNS problem: NXDOMAIN looking up A for gone.example.test]" ${paint("36", "acmeCA=")}https://acme-v02.api.letsencrypt.org/directory ${paint("36", "providerName=")}letsencrypt.acme`;
};

describe("Traefik console log format", () => {
	it("removes colour codes from the selected lines", () => {
		expect(selectAcmeLogLines(consoleLine(true))).toEqual([consoleLine(false)]);
	});

	it("reads the level, time and domain of a coloured console line", () => {
		const [line] = selectAcmeLogLines(consoleLine(true));

		expect(readLogLevel(line!)).toBe("error");
		expect(isErrorLine(line!)).toBe(true);
		expect(readLogTime(line!)).toBe("2026-10-10T22:30:12Z");
		expect(extractLogDomain(line!, new Set(["gone.example.test"]))).toBe(
			"gone.example.test",
		);
		expect(extractLogDomain(line!, new Set())).toBe("gone.example.test");
	});

	it("reads the level behind a docker service logs prefix", () => {
		const line = `dokploy-traefik.1.abc@node    | ${consoleLine(false)}`;

		expect(readLogLevel(line)).toBe("error");
		expect(readLogTime(line)).toBe("2026-10-10T22:30:12Z");
	});

	it("does not read an error level from an informational console line", () => {
		const line =
			"2026-10-10T22:30:12Z INF Testing certificate renew... acmeCA=https://acme-v02.api.letsencrypt.org/directory providerName=letsencrypt.acme";

		expect(readLogLevel(line)).toBe("info");
		expect(isErrorLine(line)).toBe(false);
	});
});

describe("Traefik log fields", () => {
	it("reads the level and time from logfmt lines", () => {
		const line =
			'time="2026-10-08T10:00:00Z" level=error msg="Error renewing ACME certificate"';

		expect(readLogLevel(line)).toBe("error");
		expect(readLogTime(line)).toBe("2026-10-08T10:00:00Z");
		expect(isErrorLine(line)).toBe(true);
	});

	it("reads the level and time from JSON lines", () => {
		const line =
			'{"level":"error","time":"2026-10-08T10:00:01Z","msg":"Unable to obtain ACME certificate"}';

		expect(readLogLevel(line)).toBe("error");
		expect(readLogTime(line)).toBe("2026-10-08T10:00:01Z");
	});

	it("does not treat an info line as an error", () => {
		expect(isErrorLine('time="2026-10-08T10:00:00Z" level=info msg="ok"')).toBe(
			false,
		);
	});
});

describe("Traefik log domain extraction", () => {
	it("takes the domain from a domains field", () => {
		const line =
			'time="2026-10-08T10:00:00Z" level=error msg="Unable to obtain ACME certificate for domains" ACME.domains=[example.test] error="timeout"';

		expect(extractLogDomain(line, new Set())).toBe("example.test");
	});

	it("prefers a host the panel already knows over a guess", () => {
		const line =
			'level=error msg="Unable to obtain ACME certificate for domains" domains=[other.example.test www.example.test]';

		expect(extractLogDomain(line, new Set(["www.example.test"]))).toBe(
			"www.example.test",
		);
	});

	it("ignores the Let's Encrypt provider name even on a domains line", () => {
		const line =
			'level=error msg="renewal failed for domains" providerName=letsencrypt.acme';

		expect(extractLogDomain(line, new Set())).toBeNull();
	});

	it("does not take the ACME directory host as the domain", () => {
		const line =
			'level=error msg="Get \\"https://acme-v02.example.test/directory\\": context deadline exceeded"';

		expect(extractLogDomain(line, new Set())).toBeNull();
	});

	it("does not guess a domain on a line that does not say domain", () => {
		const line =
			'level=error msg="acme: error 400 while reading response from host.example.test"';

		expect(extractLogDomain(line, new Set())).toBeNull();
	});
});
