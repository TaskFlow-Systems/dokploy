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
