import {
	hideComposeSecrets,
	restoreComposeSecrets,
	restoreTextSecrets,
	SecretRestoreError,
} from "@dokploy/server/utils/security/compose-secrets";
import { REDACTED_SECRET_VALUE as BARE } from "@dokploy/server/utils/security/redaction";
import {
	buildKnownSecretMatcher,
	EMPTY_KNOWN_SECRET_MATCHER,
	findSecretTokens,
	scrubSecretText,
	secretTokenFor,
} from "@dokploy/server/utils/security/secret-scrub";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const NONE = EMPTY_KNOWN_SECRET_MATCHER;
const hide = (text: string, matcher = NONE) =>
	hideComposeSecrets(text, matcher);
const restore = (submitted: string, stored: string, matcher = NONE) =>
	restoreComposeSecrets(submitted, stored, matcher);

const SECRETS = [
	"plain-neutral-value",
	"quoted neutral: value",
	"4242",
	"list-neutral-value",
	"quoted list value",
	"build-arg-value",
	"inline secret body",
	"first line\nsecond line\n",
	"shared-anchor-value",
	"cli-flag-value",
];

const COMPOSE = `# deploy notes, password: comment-secret-1
x-defaults: &defaults
  SHARED_SETTING: shared-anchor-value
services:
  api:
    image: registry.example.test/team/api:1.4.2
    container_name: api
    ports:
      - "8080:80"
    environment:
      <<: *defaults
      FAVOURITE_COLOUR: plain-neutral-value
      GREETING: "quoted neutral: value"
      PIN: 4242
      FROM_ENV: \${FROM_ENV}
      FROM_PROJECT: \${{project.SHARED}}
      EMPTY_ONE:
      BANNER: |
        first line
        second line
    command: server --listen 0.0.0.0 --api-token cli-flag-value # keep
    labels:
      - "traefik.http.routers.api.rule=Host(\`api.example.test\`)"
  worker:
    build:
      context: .
      args:
        VARIANT: build-arg-value
    environment:
      - MODE=list-neutral-value
      - "TITLE=quoted list value"
      - PASSED_THROUGH
      - REFERENCED=\${REFERENCED}
configs:
  motd:
    content: inline secret body
`;

describe("hideComposeSecrets", () => {
	const hidden = hide(COMPOSE);

	it("hides every literal value of the variable blocks, whatever the name", () => {
		for (const secret of SECRETS) {
			expect(hidden).not.toContain(secret.trim().split("\n")[0]);
		}
		expect(hidden).not.toContain("comment-secret-1");
	});

	it("keeps names, references, empty values and the rest of the file", () => {
		for (const kept of [
			"image: registry.example.test/team/api:1.4.2",
			"container_name: api",
			'- "8080:80"',
			"<<: *defaults",
			"FROM_ENV: ${FROM_ENV}",
			"FROM_PROJECT: ${{project.SHARED}}",
			"EMPTY_ONE:",
			"- PASSED_THROUGH",
			"- REFERENCED=${REFERENCED}",
			"traefik.http.routers.api.rule=Host(`api.example.test`)",
			"context: .",
			"# keep",
		]) {
			expect(hidden).toContain(kept);
		}
		for (const name of [
			"SHARED_SETTING",
			"FAVOURITE_COLOUR",
			"GREETING",
			"PIN",
			"BANNER",
			"VARIANT",
			"MODE=",
			"TITLE=",
		]) {
			expect(hidden).toContain(name);
		}
	});

	it("stays valid YAML with the same structure", () => {
		const before = parse(COMPOSE, { merge: true });
		const after = parse(hidden, { merge: true });

		expect(Object.keys(after.services)).toEqual(Object.keys(before.services));
		expect(Object.keys(after.services.api.environment).sort()).toEqual(
			Object.keys(before.services.api.environment).sort(),
		);
		expect(after.services.api.image).toBe(before.services.api.image);
		expect(after.services.worker.environment).toHaveLength(4);
	});

	it("gives the same value the same token and different values different ones", () => {
		const text =
			"services:\n  a:\n    environment:\n      ONE: same-value-1\n      TWO: same-value-1\n      THREE: other-value-2\n";
		const tokens = findSecretTokens(hide(text));

		expect(tokens).toHaveLength(3);
		expect(tokens[0]).toBe(tokens[1]);
		expect(tokens[0]).not.toBe(tokens[2]);
		expect(tokens[0]).toBe(secretTokenFor("same-value-1"));
		expect(tokens[0]).toMatch(/^__DOKPLOY_REDACTED_SECRET__[A-Z2-7]{12}__$/);
	});

	it("is stable when applied again", () => {
		expect(hide(hidden)).toBe(hidden);
	});

	it("hides values the panel knows wherever they stand", () => {
		const matcher = buildKnownSecretMatcher(["Known-Value-77"]);
		const text =
			"services:\n  a:\n    image: app\n    labels:\n      note: uses Known-Value-77 here\n    healthcheck:\n      test: curl -H 'X-Probe: Known-Value-77' localhost\n";

		expect(hide(text, matcher)).not.toContain("Known-Value-77");
	});

	it("hides generated-looking values in labels and commands, keeps names and routing", () => {
		const text = [
			"services:",
			"  api:",
			"    image: registry.example.test/team/api:1.0.0",
			"    container_name: backend-prod-eu-west-01",
			"    hostname: api-internal-node-02",
			'    command: ["server", "--mode", "fast", "Zx9PositionalValue42"]',
			"    labels:",
			"      note: Qw7-label-Neutral-0099",
			"      team: platform-services-eu",
			"  web:",
			"    image: web:2",
			"    entrypoint: run Ab12Cd34Ef56Gh78 --verbose",
			"    labels:",
			'      - "traefik.http.routers.web-a1b2c3d4e5f6a7b8.rule=Host(`web.example.test`)"',
			'      - "owner=Qw7-list-Neutral-0077"',
			"",
		].join("\n");
		const hidden = hide(text);

		for (const secret of [
			"Zx9PositionalValue42",
			"Qw7-label-Neutral-0099",
			"Ab12Cd34Ef56Gh78",
			"Qw7-list-Neutral-0077",
		]) {
			expect(hidden).not.toContain(secret);
		}
		for (const kept of [
			"container_name: backend-prod-eu-west-01",
			"hostname: api-internal-node-02",
			"team: platform-services-eu",
			"traefik.http.routers.web-a1b2c3d4e5f6a7b8.rule=Host(`web.example.test`)",
			"owner=",
			"note: ",
			'"--mode"',
			"--verbose",
		]) {
			expect(hidden).toContain(kept);
		}
		expect(parse(restore(hidden, text))).toEqual(parse(text));
	});

	it("shows nothing of a file that does not parse", () => {
		expect(hide("services:\n  a:\n   environment:\n  X: [unclosed\n")).toBe(
			BARE,
		);
	});

	it("leaves an empty file alone", () => {
		expect(hide("")).toBe("");
		expect(hide("  \n")).toBe("  \n");
	});
});

describe("restoreComposeSecrets", () => {
	const hidden = hide(COMPOSE);

	it("puts every value back when the file comes back untouched", () => {
		const restored = restore(hidden, COMPOSE);

		expect(findSecretTokens(restored)).toEqual([]);
		expect(parse(restored, { merge: true })).toEqual(
			parse(COMPOSE, { merge: true }),
		);
		expect(restored).toContain("comment-secret-1");
	});

	it("returns a file without tokens as it is", () => {
		const fresh =
			"services:\n  a:\n    image: app:2\n    environment:\n      NEW: brand-new\n";

		expect(restore(fresh, COMPOSE)).toBe(fresh);
	});

	it("keeps the hidden values through ordinary edits", () => {
		const edited = hidden
			.replace("api:1.4.2", "api:1.5.0")
			.replace('- "8080:80"', '- "9090:80"')
			.replace(
				"      EMPTY_ONE:\n",
				"      EMPTY_ONE:\n      ADDED: fresh-literal\n",
			)
			.replace("      - PASSED_THROUGH\n", "");
		const restored = parse(restore(edited, COMPOSE), { merge: true });
		const original = parse(COMPOSE, { merge: true });

		expect(restored.services.api.image).toBe(
			"registry.example.test/team/api:1.5.0",
		);
		expect(restored.services.api.ports).toEqual(["9090:80"]);
		expect(restored.services.api.environment).toEqual({
			...original.services.api.environment,
			ADDED: "fresh-literal",
		});
		expect(restored.services.worker.environment).toEqual([
			"MODE=list-neutral-value",
			"TITLE=quoted list value",
			"REFERENCED=${REFERENCED}",
		]);
		expect(restored.configs.motd.content).toBe("inline secret body");
	});

	it("lets a value be removed, or moved into another variable", () => {
		const colour = secretTokenFor("plain-neutral-value");
		const edited = hidden
			.replace(`      FAVOURITE_COLOUR: ${colour}\n`, "")
			.replace("      - PASSED_THROUGH\n", `      - COLOUR=${colour}\n`);
		const restored = parse(restore(edited, COMPOSE), { merge: true });

		expect(restored.services.api.environment.FAVOURITE_COLOUR).toBeUndefined();
		expect(restored.services.worker.environment).toContain(
			"COLOUR=plain-neutral-value",
		);
	});

	it("restores values that need quoting", () => {
		const stored = `services:\n  a:\n    environment:\n      TRICKY: 'it''s "quoted" # not a comment: yes'\n      MULTI: "line one\\nline two"\n`;
		const restored = parse(restore(hide(stored), stored));

		expect(restored).toEqual(parse(stored));
	});

	it.each([
		[
			"a placeholder without a token",
			(text: string) =>
				text.replace(/__DOKPLOY_REDACTED_SECRET__[A-Z2-7]{12}__/, BARE),
		],
		[
			"an MCP placeholder",
			(text: string) =>
				text.replace(/__DOKPLOY_REDACTED_SECRET__[A-Z2-7]{12}__/, "[REDACTED]"),
		],
		[
			"a token that was never issued",
			(text: string) =>
				text.replace(
					/__DOKPLOY_REDACTED_SECRET__[A-Z2-7]{12}__/,
					`${BARE}AAAAAAAAAAAA__`,
				),
		],
		["broken YAML", (text: string) => `${text}\n  bad: [unclosed\n`],
	])("rejects %s", (_name, change) => {
		expect(() => restore(change(hidden), COMPOSE)).toThrow(SecretRestoreError);
	});

	it.each([
		[
			"the image",
			"    image: registry.example.test/team/api:1.4.2",
			"    image: TOKEN",
		],
		[
			"the container name",
			"    container_name: api",
			"    container_name: TOKEN",
		],
		[
			"a label",
			"traefik.http.routers.api.rule=Host(`api.example.test`)",
			"note=TOKEN",
		],
		["a key", "    container_name: api", "    TOKEN: api"],
	])("refuses to move a hidden value into %s", (_name, from, to) => {
		const token = secretTokenFor("plain-neutral-value");
		const moved = hidden.replace(from, to.replace("TOKEN", token));

		expect(moved).not.toBe(hidden);
		expect(() => restore(moved, COMPOSE)).toThrow(/would become readable/);
	});

	it("never reveals a value in its error messages", () => {
		const moved = hidden.replace(
			"    container_name: api",
			`    container_name: ${secretTokenFor("plain-neutral-value")}`,
		);
		let message = "";
		try {
			restore(moved, COMPOSE);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).not.toBe("");
		for (const secret of SECRETS) {
			expect(message).not.toContain(secret);
		}
	});

	it("survives random values in every style", () => {
		const alphabet = "abcXYZ019 :#'\"\\{}[],&*!|>%@`=-_/\n\t$ёж";
		let seed = 20261012;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const randomValue = () =>
			Array.from(
				{ length: 1 + Math.floor(random() * 24) },
				() => alphabet[Math.floor(random() * alphabet.length)],
			).join("");

		for (let round = 0; round < 300; round++) {
			const values = Array.from({ length: 4 }, randomValue);
			const stored = [
				"services:",
				"  app:",
				"    image: app:1",
				"    environment:",
				...values.map(
					(value, index) => `      VAR_${index}: ${JSON.stringify(value)}`,
				),
				"    build:",
				"      args:",
				...values.map(
					(value, index) =>
						`        - ${JSON.stringify(`ARG_${index}=${value}`)}`,
				),
				"",
			].join("\n");
			const shown = hide(stored);
			const restored = restore(shown, stored);

			expect(parse(restored), `round ${round}`).toEqual(parse(stored));
			for (const value of values) {
				const literal = value.trim();
				if (literal.length >= 6 && !/^\$/.test(literal)) {
					expect(shown.includes(JSON.stringify(value)), `round ${round}`).toBe(
						false,
					);
				}
			}
		}
	});
});

describe("restoreTextSecrets", () => {
	const matcher = buildKnownSecretMatcher(["Known-Value-77"]);
	const stored = [
		"server {",
		'  proxy_set_header Authorization "Bearer upstream.token.value";',
		"  set $upstream_password hunter2-hunter2;",
		"  # db: postgres://app:Pa55-word@db:5432/app",
		"  set $marker Known-Value-77;",
		"  listen 8080;",
		"}",
		"",
	].join("\n");
	const shown = scrubSecretText(stored, matcher, {
		replacement: secretTokenFor,
		file: true,
	});

	it("hides the values behind tokens", () => {
		for (const secret of [
			"upstream.token.value",
			"Pa55-word",
			"Known-Value-77",
		]) {
			expect(shown).not.toContain(secret);
		}
		expect(shown).toContain("listen 8080;");
		expect(findSecretTokens(shown).length).toBeGreaterThanOrEqual(3);
	});

	it("puts them back exactly, also after an edit elsewhere", () => {
		expect(restoreTextSecrets(shown, stored, matcher)).toBe(stored);
		expect(
			restoreTextSecrets(
				shown.replace("listen 8080;", "listen 9090;"),
				stored,
				matcher,
			),
		).toBe(stored.replace("listen 8080;", "listen 9090;"));
	});

	it("refuses a value moved to where it would be readable", () => {
		const token = secretTokenFor("Pa55-word");
		const moved = shown.replace("listen 8080;", `server_name ${token};`);

		expect(() => restoreTextSecrets(moved, stored, NONE)).toThrow(
			SecretRestoreError,
		);
	});

	it("refuses placeholders that cannot be resolved", () => {
		expect(() => restoreTextSecrets(`x ${BARE}`, stored, matcher)).toThrow(
			SecretRestoreError,
		);
		expect(() => restoreTextSecrets("x [REDACTED]", stored, matcher)).toThrow(
			SecretRestoreError,
		);
		expect(() =>
			restoreTextSecrets(`x ${BARE}AAAAAAAAAAAA__`, stored, matcher),
		).toThrow(SecretRestoreError);
	});
});
