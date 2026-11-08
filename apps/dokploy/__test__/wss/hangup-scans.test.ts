import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HANGUP_SCAN_DELAYS_MS,
	runHangupScans,
} from "../../server/wss/hangup-scans";

describe("runHangupScans", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// A container whose daemon starts the shell `startsAt` ms after the session
	// closed: a scan before that finds nothing, a scan after it hangs it up.
	const containerWithLateShell = (startsAt: number) => {
		const t0 = Date.now();
		const state = { scans: 0, hungUpAt: undefined as number | undefined };
		const scan = async () => {
			state.scans++;
			const now = Date.now() - t0;
			if (now >= startsAt && state.hungUpAt === undefined) {
				state.hungUpAt = now;
			}
		};
		return { state, scan };
	};

	it("scans at once and again at 0.5, 2 and 5 seconds", async () => {
		expect(HANGUP_SCAN_DELAYS_MS).toEqual([500, 2_000, 5_000]);
		const { state, scan } = containerWithLateShell(Number.POSITIVE_INFINITY);
		const scans = runHangupScans(scan);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.scans).toBe(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(state.scans).toBe(2);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.scans).toBe(3);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.scans).toBe(4);
		await scans.done;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(state.scans).toBe(4);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("hangs up a shell that the daemon starts after the first scan", async () => {
		const { state, scan } = containerWithLateShell(1_000);
		const scans = runHangupScans(scan);
		await vi.advanceTimersByTimeAsync(10_000);
		await scans.done;
		expect(state.hungUpAt).toBe(2_500);
	});

	it("never runs two scans at once, however slow one is", async () => {
		let running = 0;
		let peak = 0;
		let total = 0;
		const scans = runHangupScans(async () => {
			total++;
			running++;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			running--;
		});
		await vi.advanceTimersByTimeAsync(60_000);
		await scans.done;
		expect(peak).toBe(1);
		expect(total).toBe(4);
	});

	it("keeps going after a scan that throws, and stops after one that answers false", async () => {
		let calls = 0;
		const throwing = runHangupScans(async () => {
			calls++;
			throw new Error("docker missing");
		});
		await vi.advanceTimersByTimeAsync(10_000);
		await throwing.done;
		expect(calls).toBe(4);

		let refused = 0;
		const dead = runHangupScans(async () => {
			refused++;
			return false;
		});
		await vi.advanceTimersByTimeAsync(10_000);
		await dead.done;
		expect(refused).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves nothing behind when cancelled", async () => {
		const { state, scan } = containerWithLateShell(Number.POSITIVE_INFINITY);
		const scans = runHangupScans(scan);
		await vi.advanceTimersByTimeAsync(600);
		scans.cancel();
		await scans.done;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(state.scans).toBe(2);
	});
});
