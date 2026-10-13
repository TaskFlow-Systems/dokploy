const running = new Map<string, string>();

const keyOf = (serverId: string | null) => serverId ?? "local";

// Reloading Traefik and rewriting its certificate store must not overlap on
// one server: a reload in the middle of the stop-edit-start sequence would
// start Traefik with the old file.
export const acquireTraefikOperation = (
	serverId: string | null,
	label: string,
): (() => void) | null => {
	const key = keyOf(serverId);
	if (running.has(key)) {
		return null;
	}
	running.set(key, label);
	let held = true;
	return () => {
		if (held) {
			held = false;
			running.delete(key);
		}
	};
};

export const runningTraefikOperation = (serverId: string | null) =>
	running.get(keyOf(serverId)) ?? null;
