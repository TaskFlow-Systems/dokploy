import { createRequire } from "node:module";
import type * as UndiciModule from "undici";

// Bun answers an import of "undici" with a built-in module: its Agent has no
// close(), and its fetch, like Bun's global one, ignores `dispatcher`. The
// address pinning and checks that go through a dispatcher would then be
// skipped. Loaded by its file, the package is the real undici on Bun, and on
// Node the same module as a plain import.
const undici = createRequire(import.meta.url)(
	"undici/index.js",
) as typeof UndiciModule;

export const { Agent, fetch } = undici;
export type Agent = UndiciModule.Agent;
export type { RequestInit } from "undici";
