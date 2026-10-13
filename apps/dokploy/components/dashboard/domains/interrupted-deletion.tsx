import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

type Props = {
	serverId: string | null;
	name: string;
	traefikLeftStopped: { kind: string; phase: string } | null;
	staleLock: boolean;
};

const TRAEFIK_STATE_TEXT = {
	running: "Traefik is running.",
	stopped: "Traefik is stopped.",
	unknown: "Docker did not say whether Traefik is running.",
	absent: "There is no Traefik on this server.",
} as const;

export const InterruptedDeletion = ({
	serverId,
	name,
	traefikLeftStopped,
	staleLock,
}: Props) => {
	const utils = api.useUtils();
	const recover = api.domainOverview.recoverTraefik.useMutation();
	const clearLock = api.domainOverview.clearStaleDeletionLock.useMutation();

	if (!traefikLeftStopped && !staleLock) {
		return null;
	}

	const startAgain = async () => {
		try {
			const result = await recover.mutateAsync({ serverId });
			const ok =
				result.status === "recovered" ||
				result.status === "recovered_restored" ||
				result.status === "already_running";
			(ok ? toast.success : toast.error)(result.message);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Traefik was not started",
			);
		}
		await utils.domainOverview.list.invalidate();
	};

	const removeLock = async () => {
		try {
			const result = await clearLock.mutateAsync({ serverId });
			const text = `${result.message} ${TRAEFIK_STATE_TEXT[result.traefik]}`;
			(result.status === "cleared" || result.status === "none"
				? toast.success
				: toast.error)(text);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "The lock was not removed",
			);
		}
		await utils.domainOverview.list.invalidate();
	};

	return (
		<>
			{traefikLeftStopped && (
				<AlertBlock type="error">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span>
							{name}: Traefik was left stopped by an interrupted certificate
							deletion. Sites on this server are down until it is started again.
						</span>
						<Button
							size="sm"
							variant="destructive"
							isLoading={recover.isPending}
							onClick={startAgain}
						>
							Start Traefik again
						</Button>
					</div>
				</AlertBlock>
			)}
			{staleLock && (
				<AlertBlock type="warning">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span>
							{name}: a certificate deletion left its lock behind and no process
							holds it. New deletions are blocked until it is removed.
						</span>
						<Button
							size="sm"
							variant="outline"
							isLoading={clearLock.isPending}
							onClick={removeLock}
						>
							Remove leftover lock
						</Button>
					</div>
				</AlertBlock>
			)}
		</>
	);
};
