export type TraefikErrorCause =
	| "no_dns_record"
	| "no_address"
	| "lets_encrypt_timeout"
	| "port_443_answered_by_other"
	| "port_443_closed"
	| "rate_limit"
	| "unknown";

export type ClassifiedTraefikError = {
	cause: TraefikErrorCause;
	explanation: string;
};

// The texts are read by the panel operator, so they stay in Russian and reuse
// the wording of docs/certificates-and-ports.md where the case is the same.
const EXPLANATIONS: Record<TraefikErrorCause, string> = {
	no_dns_record:
		"Для этого имени нет DNS-записи. Добавьте запись A с адресом сервера или удалите домен, если он больше не используется.",
	no_address:
		"DNS-запись есть, но в ней нет адреса. Укажите в записи A адрес сервера.",
	lets_encrypt_timeout:
		"Let's Encrypt не ответил вовремя. Часто это проходит само собой; проверьте позже.",
	port_443_answered_by_other:
		"На 443 отвечает не Traefik, обычно перед сервером стоит CDN или прокси, который завершает TLS. Отключите проксирование для этого имени или уберите его с прокси.",
	port_443_closed:
		"Порт 443 закрыт файрволом или не ведет на Traefik. Проверьте файрвол и публикацию портов.",
	rate_limit:
		"Слишком много неудачных попыток у Let's Encrypt (429). Сначала устраните причину, и только потом ждите новую попытку.",
	unknown: "Неизвестная ошибка, см. лог ниже.",
};

const TIMEOUT = /timeout|timed out|deadline exceeded/i;
const PORT_443 = /:443\b|\bport 443\b/i;
const OUTBOUND_TO_LETS_ENCRYPT =
	/dial tcp|letsencrypt\.org|acme-v0\d|Client\.Timeout|deadline exceeded/i;
const LETS_ENCRYPT_HOST = /letsencrypt\.org|acme-v0\d/i;

// Order matters: a 429 line can also mention a timeout, and a timeout that
// names port 443 points at the panel's firewall unless the dial goes out to
// Let's Encrypt.
const RULES: ReadonlyArray<{
	cause: TraefikErrorCause;
	matches: (message: string) => boolean;
}> = [
	{
		cause: "rate_limit",
		matches: (message) => /\b429\b|rate[ -]?limit/i.test(message),
	},
	{
		cause: "no_dns_record",
		matches: (message) =>
			/NXDOMAIN|does not exist|no such host/i.test(message) &&
			!LETS_ENCRYPT_HOST.test(message),
	},
	{
		cause: "no_address",
		matches: (message) =>
			/no valid (?:A|AAAA|A\/AAAA) records?|no (?:A|AAAA) records/i.test(
				message,
			),
	},
	{
		cause: "port_443_answered_by_other",
		matches: (message) =>
			/ALPN|tls-alpn|Incorrect validation certificate/i.test(message),
	},
	{
		cause: "port_443_closed",
		matches: (message) =>
			/connection refused|Timeout during connect|firewall problem/i.test(
				message,
			) ||
			(TIMEOUT.test(message) &&
				PORT_443.test(message) &&
				!OUTBOUND_TO_LETS_ENCRYPT.test(message)),
	},
	{
		cause: "lets_encrypt_timeout",
		matches: (message) => TIMEOUT.test(message),
	},
];

export const classifyTraefikError = (
	message: string,
): ClassifiedTraefikError => {
	const cause = RULES.find((rule) => rule.matches(message))?.cause ?? "unknown";
	return { cause, explanation: EXPLANATIONS[cause] };
};
