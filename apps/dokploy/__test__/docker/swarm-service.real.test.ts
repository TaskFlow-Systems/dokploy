import { createHash } from "node:crypto";
import { docker } from "@dokploy/server/constants";
import { createOrUpdateSwarmService } from "@dokploy/server/utils/docker/swarm-service";
import { afterAll, describe, expect, it } from "vitest";

// real-<kind>-<id> is what the PR workflow removes after a cancelled run.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const appName = `real-svcupdate-${CHECKOUT_ID}-${Date.now()}`;

const replicated = {
	Name: appName,
	TaskTemplate: {
		ContainerSpec: { Image: "redis:8-alpine", Command: ["sleep", "600"] },
	},
	Mode: { Replicated: { Replicas: 0 } },
};

afterAll(async () => {
	await docker
		.getService(appName)
		.remove()
		.catch(() => undefined);
});

describe("createOrUpdateSwarmService on real Docker", () => {
	it("creates, then updates, then reports what Docker refused", async () => {
		await createOrUpdateSwarmService({
			docker,
			appName,
			settings: replicated,
		});
		const created = await docker.getService(appName).inspect();
		expect(created.Spec.Name).toBe(appName);
		expect(JSON.stringify(created.Spec)).not.toContain("abortSignal");

		await createOrUpdateSwarmService({
			docker,
			appName,
			settings: replicated,
		});
		const updated = await docker.getService(appName).inspect();
		expect(updated.ID).toBe(created.ID);
		expect(updated.Spec.TaskTemplate.ForceUpdate).toBe(
			(created.Spec.TaskTemplate.ForceUpdate ?? 0) + 1,
		);

		const refused = await createOrUpdateSwarmService({
			docker,
			appName,
			settings: { ...replicated, Mode: { Global: {} } },
		}).catch((error: Error) => error);

		expect(refused).toBeInstanceOf(Error);
		expect((refused as Error).message).toMatch(/mode/i);
		expect((refused as Error).message).not.toMatch(/name conflicts/);
		const after = await docker.getService(appName).inspect();
		expect(after.Spec.Mode.Replicated).toBeDefined();

		// What the user used to read instead of the real cause.
		await expect(docker.createService(replicated)).rejects.toThrow(
			/name conflicts/,
		);
	}, 60_000);
});
