import { scheduleJob } from "node-schedule";
import { guardScheduledRun } from "../../../../../packages/server/src/utils/backups/scheduled-run";

// Real node-schedule timers: one job whose backup throws the way a run*Backup
// does after it recorded the failure. The unguarded job is the control, it has
// to be seen as an unhandled rejection or the check proves nothing.
const rejections: string[] = [];
process.on("unhandledRejection", (reason) => {
	rejections.push(reason instanceof Error ? reason.message : String(reason));
});

const fail = async () => {
	throw new Error("backup stage failed");
};
const calls = { guarded: 0, unguarded: 0 };
const at = () => new Date(Date.now() + 300);

scheduleJob(
	"guarded",
	at(),
	guardScheduledRun("guarded", async () => {
		calls.guarded++;
		await fail();
	}),
);
scheduleJob("unguarded", at(), async () => {
	calls.unguarded++;
	await fail();
});

await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(
	JSON.stringify({
		runtime: process.versions.bun ? "bun" : "node",
		calls,
		rejections,
	}),
);
process.exit(0);
