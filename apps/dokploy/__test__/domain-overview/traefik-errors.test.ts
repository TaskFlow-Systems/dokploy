import { classifyTraefikError } from "@dokploy/server/utils/domain-overview/traefik-errors";
import { describe, expect, it } from "vitest";

describe("traefik ACME error classifier", () => {
	it("classifies a rate limit answer", () => {
		const result = classifyTraefikError(
			'level=error msg="Unable to obtain ACME certificate for domains" error="acme: error: 429 :: urn:ietf:params:acme:error:rateLimited :: too many certificates (5) already issued for these domains: example.test" domain=example.test',
		);

		expect(result.cause).toBe("rate_limit");
		expect(result.explanation).toBe(
			"Слишком много неудачных попыток у Let's Encrypt (429). Сначала устраните причину, и только потом ждите новую попытку.",
		);
	});

	it("classifies a name that has no DNS record", () => {
		const result = classifyTraefikError(
			"DNS problem: NXDOMAIN looking up A for example.test - check that a DNS record exists for this domain",
		);

		expect(result.cause).toBe("no_dns_record");
		expect(result.explanation).toBe(
			"Для этого имени нет DNS-записи. Добавьте запись A с адресом сервера или удалите домен, если он больше не используется.",
		);
	});

	it("classifies a missing DNS record on a full line that names the Let's Encrypt directory", () => {
		const result = classifyTraefikError(
			'2026-10-10T22:30:12Z ERR Error renewing ACME certificate: {gone.example.test []} error="resolver: one or more domains had a problem: [gone.example.test: invalid authorization: acme: error: 400 :: urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up A for gone.example.test - check that a DNS record exists for this domain]" acmeCA=https://acme-v02.api.letsencrypt.org/directory providerName=letsencrypt.acme',
		);

		expect(result.cause).toBe("no_dns_record");
	});

	it("classifies a DNS record that has no address", () => {
		const result = classifyTraefikError(
			"DNS problem: no valid A records found for example.test",
		);

		expect(result.cause).toBe("no_address");
		expect(result.explanation).toBe(
			"DNS-запись есть, но в ней нет адреса. Укажите в записи A адрес сервера.",
		);
	});

	it("classifies a TLS-ALPN challenge answered by something other than Traefik", () => {
		const result = classifyTraefikError(
			'Cannot negotiate ALPN protocol "acme-tls/1" for tls-alpn-01 challenge',
		);

		expect(result.cause).toBe("port_443_answered_by_other");
		expect(result.explanation).toBe(
			"На 443 отвечает не Traefik, обычно перед сервером стоит CDN или прокси, который завершает TLS. Отключите проксирование для этого имени или уберите его с прокси.",
		);
	});

	it("classifies a refused connection on port 443", () => {
		const result = classifyTraefikError(
			"urn:ietf:params:acme:error:connection :: 203.0.113.10: Connection refused",
		);

		expect(result.cause).toBe("port_443_closed");
		expect(result.explanation).toBe(
			"Порт 443 закрыт файрволом или не ведет на Traefik. Проверьте файрвол и публикацию портов.",
		);
	});

	it("classifies an inbound timeout on port 443 as a closed port", () => {
		const result = classifyTraefikError(
			"urn:ietf:params:acme:error:connection :: 203.0.113.10:443: Timeout during connect (likely firewall problem)",
		);

		expect(result.cause).toBe("port_443_closed");
	});

	it("classifies a timeout while talking to Let's Encrypt", () => {
		const result = classifyTraefikError(
			'Get "https://acme-v02.example.test/directory": context deadline exceeded',
		);

		expect(result.cause).toBe("lets_encrypt_timeout");
		expect(result.explanation).toBe(
			"Let's Encrypt не ответил вовремя. Часто это проходит само собой; проверьте позже.",
		);
	});

	it("keeps an outbound dial timeout to Let's Encrypt out of the port 443 class", () => {
		const result = classifyTraefikError(
			"dial tcp 203.0.113.99:443: i/o timeout",
		);

		expect(result.cause).toBe("lets_encrypt_timeout");
	});

	it("does not call a Let's Encrypt host lookup failure a missing DNS record", () => {
		const result = classifyTraefikError(
			"dial tcp: lookup acme-v02.example.test: no such host",
		);

		expect(result.cause).toBe("unknown");
	});

	it("falls back to the unknown explanation for any other message", () => {
		const result = classifyTraefikError(
			"something unexpected happened while renewing",
		);

		expect(result.cause).toBe("unknown");
		expect(result.explanation).toBe("Неизвестная ошибка, см. лог ниже.");
	});
});
