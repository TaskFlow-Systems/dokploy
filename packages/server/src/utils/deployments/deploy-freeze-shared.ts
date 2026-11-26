export const DEPLOY_FROZEN_CODE = "DEPLOY_FROZEN";
export const MAX_FREEZE_REASON_LENGTH = 200;
export const MAX_FREEZE_DURATION_MINUTES = 60 * 24 * 30;
export const MAX_FREEZE_TIMEOUT_MS = 2_147_483_000;

export type DeploymentFreezeScopeType =
	| "application"
	| "compose"
	| "environment"
	| "project";

export type DeploymentFreezeSkipSource = "webhook" | "api" | "queue";

export interface DeployFreezeRowLike {
	createdAt: string;
	expiresAt: string | null;
	liftedAt: string | null;
	reason: string | null;
	createdByLabel: string | null;
	skippedCount: number;
	lastSkippedAt: string | null;
	lastSkippedSource: DeploymentFreezeSkipSource | null;
}

export interface DeployFreezeState {
	active: true;
	frozenAt: string;
	expiresAt: string | null;
	reason: string | null;
	frozenByLabel: string | null;
	skippedCount: number;
	lastSkippedAt: string | null;
	lastSkippedSource: DeploymentFreezeSkipSource | null;
}

export interface OverviewDeployFreeze {
	frozenAt: string;
	expiresAt: string | null;
	reason: string | null;
	skippedCount: number;
}

export function isDeployFreezeActive(
	row: { liftedAt: string | null; expiresAt: string | null } | null | undefined,
	now = new Date(),
): boolean {
	if (!row || row.liftedAt !== null) {
		return false;
	}
	if (row.expiresAt === null) {
		return true;
	}
	const parsed = Date.parse(row.expiresAt);
	// Fail-closed if stored timestamp is malformed so corrupted expiry never unblocks deploys silently.
	if (Number.isNaN(parsed)) {
		return true;
	}
	return parsed > now.getTime();
}

export function toDeployFreezeState(
	row: DeployFreezeRowLike | null | undefined,
	opts?: { includeActorLabel?: boolean; now?: Date },
): DeployFreezeState | null {
	if (!row || !isDeployFreezeActive(row, opts?.now)) {
		return null;
	}
	return {
		active: true,
		frozenAt: row.createdAt,
		expiresAt: row.expiresAt,
		reason: row.reason ?? null,
		frozenByLabel:
			opts?.includeActorLabel === false ? null : (row.createdByLabel ?? null),
		skippedCount: row.skippedCount,
		lastSkippedAt: row.lastSkippedAt ?? null,
		lastSkippedSource: row.lastSkippedSource ?? null,
	};
}

export function toOverviewDeployFreeze(
	row: DeployFreezeRowLike | null | undefined,
	now = new Date(),
): OverviewDeployFreeze | null {
	if (!row || !isDeployFreezeActive(row, now)) {
		return null;
	}
	return {
		frozenAt: row.createdAt,
		expiresAt: row.expiresAt,
		reason: row.reason ?? null,
		skippedCount: row.skippedCount,
	};
}

export function sanitizeFreezeReason(
	reason: string | null | undefined,
): string | null {
	if (reason == null) {
		return null;
	}

	let cleaned = "";
	for (const ch of reason) {
		const cp = ch.codePointAt(0) ?? 0;
		if (ch === "\n" || ch === "\r" || ch === "\t") {
			cleaned += " ";
			continue;
		}
		if (
			(cp >= 0 && cp <= 0x1f) ||
			cp === 0x7f ||
			(cp >= 0x202a && cp <= 0x202e) ||
			(cp >= 0x2066 && cp <= 0x2069)
		) {
			continue;
		}
		cleaned += ch;
	}

	const normalized = cleaned.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) {
		return null;
	}
	if (normalized.length > MAX_FREEZE_REASON_LENGTH) {
		throw new Error(
			`Freeze reason must be ${MAX_FREEZE_REASON_LENGTH} characters or fewer`,
		);
	}
	return normalized;
}

export function formatDeployFrozenMessage(freeze: DeployFreezeState): string {
	let message = `${DEPLOY_FROZEN_CODE}: Deployments are frozen for this service`;
	if (freeze.expiresAt) {
		message += ` until ${freeze.expiresAt}`;
	}
	if (freeze.reason) {
		message += ` (reason: ${freeze.reason})`;
	}
	return message;
}

export function appendForcedFreezeNote(
	descriptionLog: string | undefined,
	freeze: DeployFreezeState | null,
): string {
	if (!freeze) {
		return descriptionLog ?? "";
	}
	const note = freeze.expiresAt
		? `[forced during deploy freeze until ${freeze.expiresAt}]`
		: "[forced during deploy freeze]";
	const base = (descriptionLog ?? "").trim();
	if (!base) {
		return note;
	}
	return base.includes("\n") ? `${base}\n${note}` : `${base} ${note}`;
}

export function getNextFreezeExpiryTimeoutMs(
	expiresAt: string | null,
	nowMs = Date.now(),
): number | null {
	if (!expiresAt) {
		return null;
	}
	const targetMs = Date.parse(expiresAt);
	if (Number.isNaN(targetMs)) {
		return null;
	}
	return Math.max(
		1000,
		Math.min(targetMs - nowMs + 1000, MAX_FREEZE_TIMEOUT_MS),
	);
}
