import { vi } from "vitest";

// bcrypt is slow by design, and on a busy CI host a suite that hashes many
// times can blow the 5 s test timeout. Cost 4 keeps the real algorithm and hash
// format.
vi.mock("bcrypt", async (importOriginal) => {
	type Bcrypt = typeof import("bcrypt");
	// The CJS module also exposes itself as `default` at runtime.
	const actual = await importOriginal<Bcrypt & { default?: Bcrypt }>();
	const original = actual.default ?? actual;
	const hash = ((data: string | Buffer, saltOrRounds: string | number) =>
		original.hash(
			data,
			typeof saltOrRounds === "number"
				? Math.min(saltOrRounds, 4)
				: saltOrRounds,
		)) as typeof original.hash;
	return { ...actual, hash, default: { ...original, hash } };
});

/**
 * Mock the DB module so tests that import from @dokploy/server (barrel)
 * never open a real TCP connection to PostgreSQL (e.g. in CI where no DB runs).
 * Without this, loading the server barrel pulls in lib/auth and db, which
 * connect to localhost:5432 and cause ECONNREFUSED.
 */
vi.mock("@dokploy/server/db", () => {
	const chain = () => chain;
	chain.set = () => chain;
	chain.where = () => chain;
	chain.values = () => chain;
	chain.returning = () => Promise.resolve([{}]);
	chain.from = () => chain;
	chain.innerJoin = () => chain;
	// biome-ignore lint/suspicious/noThenProperty: Drizzle query mocks intentionally emulate thenable chains.
	chain.then = (resolve: (value: unknown) => void) => {
		resolve([]);
	};

	const tableMock = {
		findFirst: vi.fn(() => Promise.resolve(undefined)),
		findMany: vi.fn(() => Promise.resolve([])),
		insert: vi.fn(() => Promise.resolve([{}])),
		update: vi.fn(() => chain),
		delete: vi.fn(() => chain),
	};

	return {
		db: {
			select: vi.fn(() => chain),
			insert: vi.fn(() => ({
				values: () => ({ returning: () => Promise.resolve([{}]) }),
			})),
			update: vi.fn(() => chain),
			delete: vi.fn(() => chain),
			query: new Proxy({} as Record<string, typeof tableMock>, {
				get: () => tableMock,
			}),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});
