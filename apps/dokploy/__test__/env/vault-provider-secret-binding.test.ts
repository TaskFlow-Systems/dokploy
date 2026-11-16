import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			vaultProvider: { findFirst: mocks.findFirst },
			projects: { findMany: mocks.findMany },
		},
		update: mocks.update,
	},
}));

const {
	VAULT_SECRET_MASK,
	maskVaultProviderConfig,
	mergeVaultProviderConfig,
	updateVaultProvider,
} = await import("@dokploy/server/services/vault-provider");

const storedHashicorp = {
	providerType: "hashicorp" as const,
	url: "https://vault.example.com",
	token: "stored-vault-token",
	mount: "secret",
};

describe("vault provider stored secret binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findMany.mockResolvedValue([]);
	});

	it("masks the AWS access key id together with the secret key", () => {
		for (const providerType of ["aws", "aws-parameter-store"] as const) {
			expect(
				maskVaultProviderConfig({
					providerType,
					region: "eu-west-1",
					accessKeyId: "AKIA_STORED",
					secretAccessKey: "stored-secret",
				}),
			).toMatchObject({
				accessKeyId: VAULT_SECRET_MASK,
				secretAccessKey: VAULT_SECRET_MASK,
			});
		}
	});

	it("restores masked AWS credentials when the endpoint is unchanged", () => {
		const stored = {
			providerType: "aws" as const,
			region: "eu-west-1",
			accessKeyId: "AKIA_STORED",
			secretAccessKey: "stored-secret",
			endpoint: "https://secrets.example.com",
		};

		expect(
			mergeVaultProviderConfig(
				{
					...stored,
					accessKeyId: VAULT_SECRET_MASK,
					secretAccessKey: VAULT_SECRET_MASK,
				},
				stored,
			),
		).toEqual(stored);
	});

	it("rejects sending a kept HashiCorp token to a new URL", () => {
		expect(() =>
			mergeVaultProviderConfig(
				{
					...storedHashicorp,
					url: "https://collector.example.net",
					token: VAULT_SECRET_MASK,
				},
				storedHashicorp,
			),
		).toThrow(
			expect.objectContaining({
				code: "BAD_REQUEST",
				message: "Re-enter the vault provider credentials to change url",
			}),
		);
	});

	it("rejects reading another HashiCorp mount with a kept token", () => {
		expect(() =>
			mergeVaultProviderConfig(
				{ ...storedHashicorp, token: VAULT_SECRET_MASK, mount: "kv" },
				storedHashicorp,
			),
		).toThrow(
			expect.objectContaining({
				code: "BAD_REQUEST",
				message: "Re-enter the vault provider credentials to change mount",
			}),
		);
	});

	it("names every changed HashiCorp field when a kept token would follow them", () => {
		expect(() =>
			mergeVaultProviderConfig(
				{
					...storedHashicorp,
					url: "https://collector.example.net",
					token: VAULT_SECRET_MASK,
					mount: "kv",
				},
				storedHashicorp,
			),
		).toThrow(
			expect.objectContaining({
				code: "BAD_REQUEST",
				message: "Re-enter the vault provider credentials to change url, mount",
			}),
		);
	});

	it("keeps the stored HashiCorp token when nothing else changes", () => {
		expect(
			mergeVaultProviderConfig(
				{ ...storedHashicorp, token: VAULT_SECRET_MASK },
				storedHashicorp,
			),
		).toEqual(storedHashicorp);
	});

	it("accepts a new HashiCorp URL and mount with a re-entered token", () => {
		const reentered = {
			...storedHashicorp,
			url: "https://vault-new.example.com",
			token: "new-token",
			mount: "kv",
		};
		expect(mergeVaultProviderConfig(reentered, storedHashicorp)).toEqual(
			reentered,
		);
	});

	it("rejects kept credentials with a new endpoint or identity for every URL-bearing provider", () => {
		const cases = [
			[
				{
					providerType: "infisical" as const,
					siteUrl: "https://app.infisical.com",
					clientId: "client",
					clientSecret: "stored",
					projectId: "p",
					environmentSlug: "prod",
					secretPath: "/",
				},
				{ siteUrl: "https://collector.example.net" },
				"clientSecret",
			],
			[
				{
					providerType: "aws" as const,
					region: "eu-west-1",
					accessKeyId: "AKIA_STORED",
					secretAccessKey: "stored",
				},
				{ endpoint: "https://collector.example.net" },
				"secretAccessKey",
			],
			[
				{
					providerType: "aws-parameter-store" as const,
					region: "eu-west-1",
					accessKeyId: "AKIA_STORED",
					secretAccessKey: "stored",
				},
				{ accessKeyId: "AKIA_OTHER" },
				"secretAccessKey",
			],
			[
				{
					providerType: "azure" as const,
					vaultUri: "https://vault.vault.azure.net",
					tenantId: "tenant",
					clientId: "client",
					clientSecret: "stored",
				},
				{ vaultUri: "https://collector.example.net" },
				"clientSecret",
			],
			[
				{
					providerType: "scaleway" as const,
					region: "fr-par",
					projectId: "p",
					secretKey: "stored",
					apiUrl: "https://api.scaleway.com",
				},
				{ apiUrl: "https://collector.example.net" },
				"secretKey",
			],
			[
				{
					providerType: "phase" as const,
					token: "stored",
					appId: "app",
					env: "prod",
					path: "/",
					apiUrl: "https://api.phase.dev",
				},
				{ apiUrl: "https://collector.example.net" },
				"token",
			],
		] as const;

		for (const [stored, change, secretField] of cases) {
			const incoming = {
				...stored,
				...change,
				[secretField]: VAULT_SECRET_MASK,
			};
			expect(() => mergeVaultProviderConfig(incoming as never, stored)).toThrow(
				expect.objectContaining({ code: "BAD_REQUEST" }),
			);
		}
	});

	it("does not persist a provider update that redirects the stored token", async () => {
		mocks.findFirst.mockResolvedValue({
			vaultProviderId: "vault-1",
			organizationId: "org-1",
			name: "vault",
			providerType: "hashicorp",
			config: storedHashicorp,
			assignments: [],
		});

		await expect(
			updateVaultProvider(
				"vault-1",
				"vault",
				{
					...storedHashicorp,
					url: "https://collector.example.net",
					token: VAULT_SECRET_MASK,
				},
				[],
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.update).not.toHaveBeenCalled();
	});
});
