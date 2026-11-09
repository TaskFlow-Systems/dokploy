import {
	getMariadbBackupCommand,
	getMysqlBackupCommand,
} from "@dokploy/server/utils/backups/utils";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	getMariadbRestoreCommand,
	getMongoRestoreCommand,
	getMysqlRestoreCommand,
} from "@dokploy/server/utils/restore/utils";
import {
	isSecretPlaceholderValue,
	preserveSecretPlaceholderFields,
	REDACTED_SECRET_VALUE,
	redactBackupScheduleSecrets,
	redactDatabaseServiceSecrets,
	redactDatabaseServiceSecretsFor,
	redactDeployableServiceSecrets,
	redactDeployableServiceSecretsFor,
	redactProjectNestedSecrets,
	redactSecretFields,
	redactSensitiveText,
	secretUpdateValue,
} from "@dokploy/server/utils/security/redaction";
import { quote } from "shell-quote";
import { describe, expect, it } from "vitest";

describe("shared secret redaction helpers", () => {
	it("redacts nonempty secret fields while preserving empty values", () => {
		const redacted = redactSecretFields(
			{
				name: "prod",
				privateKey: "private-key",
				emptySecret: "",
				nullSecret: null,
			},
			["privateKey", "emptySecret", "nullSecret"],
		);

		expect(redacted.privateKey).toBe(REDACTED_SECRET_VALUE);
		expect(redacted.emptySecret).toBe("");
		expect(redacted.nullSecret).toBeNull();
		expect(redacted.name).toBe("prod");
	});

	it("treats redacted and blank update values as preserve-existing", () => {
		expect(secretUpdateValue(REDACTED_SECRET_VALUE)).toBeUndefined();
		expect(secretUpdateValue("[REDACTED]")).toBeUndefined();
		expect(secretUpdateValue("")).toBeUndefined();
		expect(secretUpdateValue("   ")).toBeUndefined();
		expect(secretUpdateValue("new-secret")).toBe("new-secret");
	});

	it("preserves stored values when an update contains redacted placeholders", () => {
		expect(isSecretPlaceholderValue(REDACTED_SECRET_VALUE)).toBe(true);
		expect(isSecretPlaceholderValue("[REDACTED]")).toBe(true);
		expect(
			isSecretPlaceholderValue(
				`https://${REDACTED_SECRET_VALUE}@example.com/org/repo.git`,
			),
		).toBe(true);
		expect(isSecretPlaceholderValue("TOKEN=new")).toBe(false);

		const next = preserveSecretPlaceholderFields(
			{
				env: REDACTED_SECRET_VALUE,
				buildArgs: "[REDACTED]",
				buildSecrets: "NPM_TOKEN=new",
				name: "api",
			},
			{
				env: "TOKEN=old",
				buildArgs: "ARG_TOKEN=old",
				buildSecrets: "NPM_TOKEN=old",
				name: "old-api",
			},
			["env", "buildArgs", "buildSecrets"],
		);

		expect(next).toEqual({
			env: "TOKEN=old",
			buildArgs: "ARG_TOKEN=old",
			buildSecrets: "NPM_TOKEN=new",
			name: "api",
		});
	});

	it("redacts deployable service read secrets", () => {
		const redacted = redactDeployableServiceSecrets({
			env: "TOKEN=secret",
			refreshToken: "refresh-token",
			webhookSecret: "hook-secret",
			buildSecrets: "NPM_TOKEN=secret",
			password: "docker-password",
			security: {
				password: "basic-auth-password",
			},
			name: "app-one",
		});

		expect(redacted).toMatchObject({
			env: REDACTED_SECRET_VALUE,
			refreshToken: REDACTED_SECRET_VALUE,
			webhookSecret: REDACTED_SECRET_VALUE,
			buildSecrets: REDACTED_SECRET_VALUE,
			password: REDACTED_SECRET_VALUE,
			security: {
				password: REDACTED_SECRET_VALUE,
			},
			name: "app-one",
		});
	});

	it("redacts nested server secrets from deployable service reads", () => {
		const redacted = redactDeployableServiceSecrets({
			name: "app-one",
			server: {
				serverId: "server-1",
				command: "curl https://example.com/setup.sh | sh",
				metricsConfig: {
					server: {
						token: "monitoring-token",
						port: 4500,
					},
					containers: {
						refreshRate: 60,
					},
				},
				sshKey: {
					privateKey: "private-key",
					publicKey: "public-key",
				},
			},
			buildServer: {
				serverId: "server-2",
				command: "docker login --password build-secret",
				metricsConfig: {
					server: {
						token: "build-monitoring-token",
						port: 4501,
					},
				},
			},
		});

		expect(redacted.server).toMatchObject({
			command: REDACTED_SECRET_VALUE,
			metricsConfig: {
				server: {
					token: REDACTED_SECRET_VALUE,
					port: 4500,
				},
				containers: {
					refreshRate: 60,
				},
			},
			sshKey: {
				privateKey: REDACTED_SECRET_VALUE,
				publicKey: "public-key",
			},
		});
		expect(redacted.buildServer).toMatchObject({
			command: REDACTED_SECRET_VALUE,
			metricsConfig: {
				server: {
					token: REDACTED_SECRET_VALUE,
					port: 4501,
				},
			},
		});
	});

	it("redacts git url credentials and shared env from deployable service reads", () => {
		const redacted = redactDeployableServiceSecrets({
			customGitUrl: "https://user:token@example.com/org/repo.git",
			environment: {
				env: "ENVIRONMENT_SHARED=secret",
				project: { env: "PROJECT_SHARED=secret", organizationId: "org-1" },
			},
		});

		expect(redacted).toEqual({
			customGitUrl: `https://${REDACTED_SECRET_VALUE}@example.com/org/repo.git`,
			environment: {
				env: REDACTED_SECRET_VALUE,
				project: { env: REDACTED_SECRET_VALUE, organizationId: "org-1" },
			},
		});
	});

	it("keeps only the shared env a reader may read", () => {
		const service = {
			env: "TOKEN=secret",
			environment: {
				env: "ENVIRONMENT_SHARED=secret",
				project: { env: "PROJECT_SHARED=secret" },
			},
		};

		expect(
			redactDeployableServiceSecretsFor(service, {
				environmentEnv: true,
				projectEnv: false,
			}),
		).toEqual({
			env: REDACTED_SECRET_VALUE,
			environment: {
				env: "ENVIRONMENT_SHARED=secret",
				project: { env: REDACTED_SECRET_VALUE },
			},
		});
		expect(
			redactDatabaseServiceSecretsFor(service, {
				environmentEnv: false,
				projectEnv: true,
			}),
		).toEqual({
			env: REDACTED_SECRET_VALUE,
			environment: {
				env: REDACTED_SECRET_VALUE,
				project: { env: "PROJECT_SHARED=secret" },
			},
		});
	});

	it("redacts shared env from database service reads", () => {
		expect(
			redactDatabaseServiceSecrets({
				databasePassword: "secret",
				environment: {
					env: "ENVIRONMENT_SHARED=secret",
					project: { env: "PROJECT_SHARED=secret" },
				},
			}),
		).toEqual({
			databasePassword: REDACTED_SECRET_VALUE,
			environment: {
				env: REDACTED_SECRET_VALUE,
				project: { env: REDACTED_SECRET_VALUE },
			},
		});
	});

	it("redacts database service read credentials", () => {
		const redacted = redactDatabaseServiceSecrets({
			env: "PGSSLMODE=require",
			databaseUser: "dokploy",
			databasePassword: "secret",
			databaseRootPassword: "root-secret",
		});

		expect(redacted).toMatchObject({
			env: REDACTED_SECRET_VALUE,
			databaseUser: "dokploy",
			databasePassword: REDACTED_SECRET_VALUE,
			databaseRootPassword: REDACTED_SECRET_VALUE,
		});
	});

	it("redacts nested server secrets from database service reads", () => {
		const redacted = redactDatabaseServiceSecrets({
			databaseName: "postgres",
			server: {
				serverId: "server-1",
				command: "curl https://example.com/setup.sh | sh",
				metricsConfig: {
					server: {
						token: "monitoring-token",
						port: 4500,
					},
				},
			},
		});

		expect(redacted).toMatchObject({
			databaseName: "postgres",
			server: {
				command: REDACTED_SECRET_VALUE,
				metricsConfig: {
					server: {
						token: REDACTED_SECRET_VALUE,
						port: 4500,
					},
				},
			},
		});
	});

	it("redacts backup metadata and related service credentials", () => {
		const redacted = redactBackupScheduleSecrets({
			name: "backup",
			metadata: {
				mariadb: { databasePassword: "mariadb-secret" },
				mysql: { databaseRootPassword: "mysql-root-secret" },
			},
			postgres: {
				env: "PGPASSWORD=postgres-secret",
				databasePassword: "postgres-secret",
			},
		});

		expect(redacted.metadata).toMatchObject({
			mariadb: { databasePassword: REDACTED_SECRET_VALUE },
			mysql: { databaseRootPassword: REDACTED_SECRET_VALUE },
		});
		expect(redacted.postgres).toMatchObject({
			env: REDACTED_SECRET_VALUE,
			databasePassword: REDACTED_SECRET_VALUE,
		});
	});

	it("redacts nested project environment and service secrets", () => {
		const redacted = redactProjectNestedSecrets({
			name: "project",
			env: "PROJECT_TOKEN=secret",
			environments: [
				{
					env: "ENV_TOKEN=secret",
					applications: [{ env: "APP_TOKEN=secret" }],
					compose: [{ composeFile: "services:\n  api:", env: "TOKEN=secret" }],
					postgres: [{ databasePassword: "postgres-secret" }],
				},
			],
		});

		expect(redacted.env).toBe(REDACTED_SECRET_VALUE);
		expect(redacted.environments?.[0]?.env).toBe(REDACTED_SECRET_VALUE);
		expect(redacted.environments?.[0]?.applications?.[0]?.env).toBe(
			REDACTED_SECRET_VALUE,
		);
		expect(redacted.environments?.[0]?.compose?.[0]).toMatchObject({
			composeFile: REDACTED_SECRET_VALUE,
			env: REDACTED_SECRET_VALUE,
		});
		expect(redacted.environments?.[0]?.postgres?.[0]).toMatchObject({
			databasePassword: REDACTED_SECRET_VALUE,
		});
	});

	it("redacts secrets embedded in command and provider error text", () => {
		const message = [
			"Command failed: git clone https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz@github.com/org/repo.git",
			"rclone rcat --s3-access-key-id AKIA123 --s3-secret-access-key rcloneSecretValue :s3:bucket/path",
			"mongodump -d appdb -u root -p mongo-secret-value --archive",
			"mongodump -d appdb -u root -p 'mongo'\\''quoted-secret' --archive",
			'{"apiKey":"json-api-key","password":"json-password"}',
			"secret: yaml-secret",
			"DATABASE_URL=postgres://dokploy:postgres-password@postgres:5432/dokploy",
			"Authorization: Bearer bearer-token-123",
		].join("\n");

		const redacted = redactSensitiveText(message);

		expect(redacted).toContain(REDACTED_SECRET_VALUE);
		expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
		expect(redacted).not.toContain("rcloneSecretValue");
		expect(redacted).not.toContain("mongo-secret-value");
		expect(redacted).not.toContain("quoted-secret");
		expect(redacted).not.toContain("json-api-key");
		expect(redacted).not.toContain("json-password");
		expect(redacted).not.toContain("yaml-secret");
		expect(redacted).not.toContain("postgres-password");
		expect(redacted).not.toContain("bearer-token-123");
	});

	it("redacts standalone mongo password arguments with adjacent quoted fragments", () => {
		const messages = [
			"mongodump -d appdb -u root -p mongo-secret-value --archive",
			"mongodump -d appdb -u root -p 'mongo'''quoted-secret' --archive",
			String.raw`mongodump -d appdb -u root -p 'mongo'\''raw-quoted-secret' --archive`,
		];

		for (const message of messages) {
			const redacted = redactSensitiveText(message);

			expect(redacted).not.toContain("mongo-secret-value");
			expect(redacted).not.toContain("quoted-secret");
			expect(redacted).not.toContain("raw-quoted-secret");
		}
	});

	it("keeps the argument after a negated password flag while masking real passwords", () => {
		expect(
			redactSensitiveText(
				"pg_dump -Fc -h localhost -U postgres --no-password appdb | gzip",
			),
		).toContain("--no-password appdb |");

		const messages = [
			"psql --password hunter2 -d appdb",
			"tool --db-password=hunter2",
			"cli -password hunter2",
			"ALTER USER app WITH PASSWORD 'hunter2'",
			"CREATE USER 'app'@'%' IDENTIFIED BY 'hunter2'",
		];
		for (const message of messages) {
			const redacted = redactSensitiveText(message);

			expect(redacted).not.toContain("hunter2");
			expect(redacted).toContain(REDACTED_SECRET_VALUE);
		}
	});

	it("masks passwords glued to mysql/mariadb -p and shell-escaped values", () => {
		const messages = [
			"docker exec -i $CONTAINER_ID sh -c 'mysql -u root -phunter2 appdb'",
			"mariadb -u app -p'hunter2 x' appdb",
			String.raw`mysqldump -u root -phunter2\&tail appdb`,
			String.raw`mariadb-dump --user=app --password=hunter2\|tail appdb`,
			String.raw`docker exec -e DOKPLOY_DB_PASSWORD=hunter2\&tail -i c sh`,
			String.raw`MYSQL_PWD="hunter2\"tail" mysql -u root`,
		];
		for (const message of messages) {
			const redacted = redactSensitiveText(message);

			expect(redacted).not.toContain("hunter2");
			expect(redacted).not.toContain("tail");
			expect(redacted).toContain(REDACTED_SECRET_VALUE);
		}

		const untouched = [
			"docker run -p 3306:3306 mysql:8",
			"ssh -p 22 root@example.com 'mysql -u root -p appdb'",
			"mysql -h db -P3306 -u root appdb",
			"docker compose -p mysql-stack up -d",
			"mkdir -p /var/lib/mysql",
		];
		for (const message of untouched) {
			expect(redactSensitiveText(message)).toBe(message);
		}
	});

	describe("a shell word made of several quoted pieces", () => {
		// They cover the paths through shell-quote: `'` with `!` splits the word at
		// every `'`, `'` alone wraps it in double quotes, the rest stays bare.
		const passwords = [
			"we'ird\"pass\\word $HOME `x` ;!",
			"we'ird x!",
			"'we ird!",
			"we ird'!",
			"we''ird x!",
			"\"'we ird!",
			"\"'\"'we ird!",
			"we' ird!",
			"we'ird\"pass x",
			"we'ird;pass&x|y",
			"we'ird x\\",
			'we ird"!',
			'"ird x',
			"we'ird'",
			"we&ird|x",
		];
		const fragments = ["we", "ird", "pass", "word", "HOME", "x", "y"];
		const visiblePart = (redacted: string, password: string) => {
			const rest = redacted
				.replaceAll(REDACTED_SECRET_VALUE, " ")
				.split(/[^A-Za-z]+/);
			return fragments.filter(
				(fragment) => password.includes(fragment) && rest.includes(fragment),
			);
		};

		for (const password of passwords) {
			const word = quote([password]);

			it(`masks ${word} whole and nothing after it`, () => {
				for (const [before, after] of [
					["docker exec -e DOKPLOY_DB_PASSWORD=", " -i c sh"],
					["mysqldump --password=", " db"],
					["mongorestore --password ", " --db appdb"],
					["mysql -u root -p", " db"],
				] as const) {
					expect(redactSensitiveText(`${before}${word}${after}`)).toBe(
						`${before}${REDACTED_SECRET_VALUE}${after}`,
					);
				}
			});

			it(`shows no part of ${word} in the database commands`, () => {
				// The user of a compose backup is not validated, and one with a space
				// or a `!` changes how the whole inner command is quoted.
				for (const user of ["app", "ap p", "ap!p", "ap'p"]) {
					const commands = [
						getMysqlRestoreCommand("appdb", password),
						getMariadbRestoreCommand("appdb", user, password),
						getMongoRestoreCommand("appdb", user, password),
						getMysqlBackupCommand("appdb", password),
						getMariadbBackupCommand("appdb", user, password),
					];
					for (const command of commands) {
						const error = new ExecError(`Command failed: ${command}`, {
							command,
						});

						expect(visiblePart(error.message, password)).toEqual([]);
						expect(visiblePart(error.command ?? "", password)).toEqual([]);
					}
				}
			});
		}

		it("reads the other ways to join pieces", () => {
			for (const value of [
				String.raw`'we'\''ird x'`,
				String.raw`'we'\'\''ird x'`,
				`'we'"''"'ird x'`,
				`"we'"'"'ird x"`,
				String.raw`\"we'ird x\"`,
				String.raw`\"we\\\"ird x\"`,
			]) {
				expect(redactSensitiveText(`FOO_TOKEN=${value} next`)).toBe(
					`FOO_TOKEN=${REDACTED_SECRET_VALUE} next`,
				);
			}
		});

		it("keeps a variable reference and hides a word holding more", () => {
			const options = { broadKeys: true, keepVariableReferences: true };

			expect(redactSensitiveText(`run FOO_PASSWORD="$BAR" next`, options)).toBe(
				`run FOO_PASSWORD="$BAR" next`,
			);
			expect(
				redactSensitiveText(`run FOO_PASSWORD='$BAR'"'"'ird x' next`, options),
			).toBe(`run FOO_PASSWORD=${REDACTED_SECRET_VALUE} next`);
		});

		// What the pattern gave before it read several pieces, with # for the mask:
		// text, default options, broad options when they differ. The broad options
		// read a line that is one assignment to its end, whatever the value.
		const unchanged: [string, string, string?][] = [
			[
				`{"cmd":"FOO_TOKEN='abc'","x":"y z"}`,
				`{"cmd":"FOO_TOKEN=#","x":"y z"}`,
			],
			[`["FOO_TOKEN='abc'", "OTHER=1 2"]`, `["FOO_TOKEN=#", "OTHER=1 2"]`],
			[
				`sh -c "FOO_TOKEN='abc'" && echo "done now"`,
				`sh -c "FOO_TOKEN=#" && echo "done now"`,
			],
			[
				`echo "FOO_TOKEN='abc'" > "file name"`,
				`echo "FOO_TOKEN=#" > "file name"`,
			],
			[`FOO_TOKEN='abc',user='bob'`, `FOO_TOKEN=#,user='bob'`, "FOO_TOKEN=#"],
			[`FOO_TOKEN="abc",user="bob"`, `FOO_TOKEN=#,user="bob"`, "FOO_TOKEN=#"],
			[`call(FOO_TOKEN='abc')`, "call(FOO_TOKEN=#)"],
			[`<db FOO_TOKEN="abc"/><x y="1 2"/>`, `<db FOO_TOKEN=#/><x y="1 2"/>`],
			[`FOO_TOKEN='abc'\nsay 'hello there'`, `FOO_TOKEN=#\nsay 'hello there'`],
			[`FOO_TOKEN="abc"\nsay "hello there"`, `FOO_TOKEN=#\nsay "hello there"`],
			[
				`FOO_TOKEN=abc"def\nline two\nline "three" here`,
				`FOO_TOKEN=#\nline two\nline "three" here`,
			],
			[
				`FOO_TOKEN=abc'def\nthe build isn't done\nnext`,
				`FOO_TOKEN=#\nthe build isn't done\nnext`,
			],
			[
				`{"msg":"FOO_TOKEN=abc"}\n{"msg":"next line"}`,
				`{"msg":"FOO_TOKEN=#\n{"msg":"next line"}`,
			],
			["FOO_TOKEN=abc next", "FOO_TOKEN=# next", "FOO_TOKEN=#"],
			[
				`tool --password 'a b' --other 'c d'`,
				`tool --password # --other 'c d'`,
			],
			[`mysql -u root -p'a b' db`, "mysql -u root -p# db"],
			[`pg_dump --no-password 'db name'`, `pg_dump --no-password 'db name'`],
		];

		for (const [text, plain, broad = plain] of unchanged) {
			it(`leaves the text around the value in ${JSON.stringify(text)}`, () => {
				const masked = (expected: string) =>
					expected.replaceAll("#", REDACTED_SECRET_VALUE);

				expect(redactSensitiveText(text)).toBe(masked(plain));
				expect(
					redactSensitiveText(text, {
						broadKeys: true,
						keepVariableReferences: true,
					}),
				).toBe(masked(broad));
			});
		}

		it("keeps a quoted value over several lines whole", () => {
			for (const value of [`"one two\nthree"`, `'one two\nthree'`]) {
				expect(redactSensitiveText(`PRIVATE_KEY=${value}\nnext`)).toBe(
					`PRIVATE_KEY=${REDACTED_SECRET_VALUE}\nnext`,
				);
			}
		});

		// Quotes in a row have the most ways to pair up. The broad options are the
		// ones that run over whole logs and files.
		it("stays fast on long lines of quotes", () => {
			const size = 2_000_000;
			const fill = (unit: string, head = "") =>
				head + unit.repeat(Math.ceil(size / unit.length));
			const lines = [
				fill(`'a'"'"'b'"'"'`, "password="),
				fill(`a'"'"'`, `password='"'"'`),
				fill(`'"`, "password="),
				fill(`'`, `password=''"`),
				fill(`"`, `password=''`),
				fill("a", `password=''"`),
				fill("a", `password=\\"`),
				fill(String.raw`\\\a`, `password=\\"`),
				fill("\\", `password=\\"`),
				fill(`'"'"'`, `password="`),
				fill(`password=''"`),
				fill(`password="\\`),
				fill(`password=''' `),
				fill(`password=\\"`),
				fill(`password='"'"' `),
			];
			const startedAt = performance.now();

			for (const line of lines) {
				redactSensitiveText(line, { broadKeys: true });
			}

			expect(performance.now() - startedAt).toBeLessThan(15_000);
		});
	});

	it("stores only redacted command output on ExecError", () => {
		const error = new ExecError(
			"Command failed: npm run build TOKEN=build-secret",
			{
				command:
					"git clone https://oauth2:gitlab-token@example.com/group/repo.git && rclone rcat --s3-secret-access-key rcloneSecretValue :s3:bucket/path",
				stdout: "NPM_TOKEN=npm-secret",
				stderr: "postgres://dokploy:database-secret@postgres:5432/dokploy",
				exitCode: 1,
				originalError: Object.assign(
					new Error("raw original error with original-secret"),
					{
						command: "TOKEN=original-secret",
					},
				),
			},
		);

		const detailedMessage = error.getDetailedMessage();
		const enumerableError = JSON.stringify({ ...error });

		expect(error.message).not.toContain("build-secret");
		expect(error.command).not.toContain("gitlab-token");
		expect(error.command).not.toContain("rcloneSecretValue");
		expect(error.stdout).not.toContain("npm-secret");
		expect(error.stderr).not.toContain("database-secret");
		expect(detailedMessage).not.toContain("gitlab-token");
		expect(detailedMessage).not.toContain("database-secret");
		expect(detailedMessage).toContain(REDACTED_SECRET_VALUE);
		expect(enumerableError).not.toContain("original-secret");
	});
});
