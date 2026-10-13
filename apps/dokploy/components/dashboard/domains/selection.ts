type Selectable = {
	key: string;
	serverId: string | null;
	deletable: boolean;
};

const serverOf = (item: Selectable) => item.serverId ?? "local";

export const selectedItems = <T extends Selectable>(
	items: T[],
	selected: ReadonlySet<string>,
) => items.filter((item) => item.deletable && selected.has(item.key));

// One deletion edits one server's certificate file, so a ticked row brings
// along only the ticked rows of its own server.
export const deletionTargets = <T extends Selectable>(
	item: T,
	items: T[],
	selected: ReadonlySet<string>,
) =>
	selected.has(item.key)
		? selectedItems(items, selected).filter(
				(other) => serverOf(other) === serverOf(item),
			)
		: [item];

export const toggleAll = <T extends Selectable>(
	items: T[],
	selected: ReadonlySet<string>,
) => {
	const keys = items.filter((item) => item.deletable).map((item) => item.key);
	return keys.every((key) => selected.has(key))
		? new Set<string>()
		: new Set(keys);
};
