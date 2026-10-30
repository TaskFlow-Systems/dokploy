import {
	Column,
	getTableColumns,
	getTableName,
	is,
	Param,
	SQL,
	StringChunk,
	type Table,
} from "drizzle-orm";

type Row = Record<string, unknown>;

const isBlankChunk = (chunk: unknown) =>
	is(chunk, StringChunk) && chunk.value.join("").trim() === "";

const chunkText = (chunk: unknown) =>
	is(chunk, StringChunk) ? chunk.value.join("").trim() : null;

const comparable = (value: unknown) =>
	value instanceof Date ? value.getTime() : value;

/**
 * In-memory stand-in for the subset of drizzle that services under test use:
 * relational findFirst/findMany, insert (with onConflictDoUpdate),
 * select ... where (optionally for update), update ... returning and delete,
 * with eq/ne/gt/lt/isNull/isNotNull/and/or conditions evaluated against stored
 * rows.
 */
export const createFakeDrizzleDb = (tables: Record<string, Table>) => {
	const rows = new Map<Table, Row[]>();
	const locks: { table: string; strength: string }[] = [];
	const columnKeys = new Map<unknown, string>();
	const tableByName = new Map<string, Table>();

	for (const table of Object.values(tables)) {
		rows.set(table, []);
		tableByName.set(getTableName(table), table);
		for (const [key, column] of Object.entries(getTableColumns(table))) {
			columnKeys.set(column, key);
		}
	}

	const keyOf = (column: unknown) => {
		const key = columnKeys.get(column);
		if (!key) {
			throw new Error("Unknown column in fake db condition");
		}
		return key;
	};

	const evaluate = (condition: unknown, row: Row): boolean => {
		if (!condition) {
			return true;
		}
		if (!is(condition, SQL)) {
			throw new Error("Unsupported condition in fake db");
		}
		return evaluateParts(
			condition.queryChunks.filter((chunk) => !isBlankChunk(chunk)),
			row,
		);
	};

	const evaluateParts = (parts: unknown[], row: Row): boolean => {
		if (chunkText(parts[0]) === "(" && chunkText(parts.at(-1)) === ")") {
			return evaluateParts(parts.slice(1, -1), row);
		}

		if (parts.every((part) => is(part, SQL) || chunkText(part) !== null)) {
			const operands = parts.filter((part) => is(part, SQL));
			const operator = parts.map(chunkText).find((text) => text) ?? "and";
			const results = operands.map((operand) => evaluate(operand, row));
			return operator === "or" ? results.some(Boolean) : results.every(Boolean);
		}

		if (!is(parts[0], Column)) {
			throw new Error("Unsupported condition shape in fake db");
		}
		const left = comparable(row[keyOf(parts[0])] ?? null);
		const operator = chunkText(parts[1]);
		if (operator === "is null") {
			return left === null;
		}
		if (operator === "is not null") {
			return left !== null;
		}
		const raw = parts[2];
		const right = comparable(is(raw, Param) ? raw.value : raw);
		switch (operator) {
			case "=":
				return left === right;
			case "<>":
				return left !== right;
			case ">":
				return left !== null && (left as number) > (right as number);
			case "<":
				return left !== null && (left as number) < (right as number);
			case ">=":
				return left !== null && (left as number) >= (right as number);
			case "<=":
				return left !== null && (left as number) <= (right as number);
			default:
				throw new Error(`Unsupported operator in fake db: ${operator}`);
		}
	};

	const resolveValue = (value: unknown, row: Row) => {
		if (!is(value, SQL)) {
			return value;
		}
		const parts = value.queryChunks.filter((chunk) => !isBlankChunk(chunk));
		const match = /^\+\s*(\d+)$/.exec(chunkText(parts[1]) ?? "");
		if (is(parts[0], Column) && match) {
			return Number(row[keyOf(parts[0])] ?? 0) + Number(match[1]);
		}
		throw new Error("Unsupported SQL value in fake db");
	};

	const withDefaults = (table: Table, values: Row) => {
		const row: Row = {};
		for (const [key, column] of Object.entries(getTableColumns(table))) {
			if (values[key] !== undefined) {
				row[key] = values[key];
			} else if (column.defaultFn) {
				row[key] = column.defaultFn();
			} else if (is(column.default, SQL)) {
				row[key] = new Date();
			} else if (column.default !== undefined) {
				row[key] = column.default;
			} else {
				row[key] = null;
			}
		}
		return row;
	};

	const primaryKeyOf = (table: Table) =>
		Object.entries(getTableColumns(table)).find(
			([, column]) => column.primary,
		)?.[0];

	const project = (row: Row, columns?: Record<string, unknown>) => {
		if (!columns) {
			return { ...row };
		}
		return Object.fromEntries(
			Object.entries(columns).map(([alias, column]) => [
				alias,
				row[keyOf(column)],
			]),
		);
	};

	const insertRow = (table: Table, values: Row) => {
		const list = rows.get(table) ?? [];
		const row = withDefaults(table, values);
		const primaryKey = primaryKeyOf(table);
		if (
			primaryKey &&
			list.some((existing) => existing[primaryKey] === row[primaryKey])
		) {
			throw new Error(`duplicate key in ${getTableName(table)}`);
		}
		list.push(row);
		rows.set(table, list);
		return row;
	};

	const lazy = <T>(run: () => T, extra: Record<string, unknown> = {}) => ({
		...extra,
		// biome-ignore lint/suspicious/noThenProperty: emulates drizzle's thenable query builders.
		then: (
			resolve: (value: T) => unknown,
			reject: (error: unknown) => unknown,
		) => {
			try {
				return Promise.resolve(resolve(run()));
			} catch (error) {
				return Promise.resolve(reject(error));
			}
		},
	});

	// Only one-to-one relations named after a registered table whose id column
	// is `<name>Id` (notification.email / notification.resend), nested through
	// the relation's own `with`.
	const withRelations = (row: Row, relations?: Record<string, unknown>) => {
		const result: Row = { ...row };
		for (const name of Object.keys(relations ?? {})) {
			const relatedTable = tables[name];
			const foreignKey = `${name}Id`;
			const related = relatedTable
				? (rows.get(relatedTable) ?? []).find(
						(candidate) =>
							row[foreignKey] !== null &&
							candidate[foreignKey] === row[foreignKey],
					)
				: undefined;
			const nested = relations?.[name] as
				| { with?: Record<string, unknown> }
				| true;
			result[name] = related
				? withRelations(related, nested === true ? undefined : nested?.with)
				: null;
		}
		return result;
	};

	const queryApi = (table: Table) => ({
		findFirst: async (
			options: { where?: unknown; with?: Record<string, unknown> } = {},
		) => {
			const found = (rows.get(table) ?? []).find((row) =>
				evaluate(options.where, row),
			);
			return found ? withRelations(found, options.with) : undefined;
		},
		findMany: async (
			options: { where?: unknown; with?: Record<string, unknown> } = {},
		) =>
			(rows.get(table) ?? [])
				.filter((row) => evaluate(options.where, row))
				.map((row) => withRelations(row, options.with)),
	});

	const query = Object.fromEntries(
		Object.entries(tables).map(([key, table]) => [key, queryApi(table)]),
	);

	const db: Record<string, unknown> = {
		query,
		transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(db),
		select: (columns?: Record<string, unknown>) => ({
			from: (table: Table) => ({
				where: (condition: unknown) => {
					const find = () =>
						(rows.get(table) ?? [])
							.filter((row) => evaluate(condition, row))
							.map((row) => project(row, columns));
					return lazy(find, {
						for: async (strength: string) => {
							locks.push({ table: getTableName(table), strength });
							return find();
						},
					});
				},
			}),
		}),
		insert: (table: Table) => ({
			values: (values: Row) =>
				lazy(() => [insertRow(table, values)], {
					returning: async (columns?: Record<string, unknown>) => [
						project(insertRow(table, values), columns),
					],
					onConflictDoUpdate: async ({ set }: { set: Row }) => {
						const primaryKey = primaryKeyOf(table);
						const existing = (rows.get(table) ?? []).find(
							(row) => primaryKey && row[primaryKey] === values[primaryKey],
						);
						if (existing) {
							for (const [key, value] of Object.entries(set)) {
								existing[key] = resolveValue(value, existing);
							}
							return [existing];
						}
						return [insertRow(table, values)];
					},
				}),
		}),
		update: (table: Table) => ({
			set: (values: Row) => ({
				where: (condition: unknown) => {
					const apply = () => {
						const updated: Row[] = [];
						for (const row of rows.get(table) ?? []) {
							if (evaluate(condition, row)) {
								for (const [key, value] of Object.entries(values)) {
									if (value !== undefined) {
										row[key] = resolveValue(value, row);
									}
								}
								updated.push(row);
							}
						}
						return updated;
					};
					return lazy(apply, {
						returning: async (columns?: Record<string, unknown>) =>
							apply().map((row) => project(row, columns)),
					});
				},
			}),
		}),
		delete: (table: Table) => ({
			where: (condition: unknown) => {
				const remove = () => {
					const list = rows.get(table) ?? [];
					rows.set(
						table,
						list.filter((row) => !evaluate(condition, row)),
					);
					return list.filter((row) => evaluate(condition, row));
				};
				return lazy(remove, {
					returning: async (columns?: Record<string, unknown>) =>
						remove().map((row) => project(row, columns)),
				});
			},
		}),
	};

	return {
		db,
		locks,
		rows: (table: Table) => rows.get(table) ?? [],
		seed: (table: Table, values: Row) => insertRow(table, values),
		reset: () => {
			locks.length = 0;
			for (const table of rows.keys()) {
				rows.set(table, []);
			}
		},
		tableByName,
	};
};
