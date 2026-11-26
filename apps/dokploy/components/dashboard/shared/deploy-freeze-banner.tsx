import type { DeployFreezeState } from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { Snowflake } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

interface Props {
	serviceType: "compose" | "application";
	serviceId: string;
	deployFreeze: DeployFreezeState | null | undefined;
	canDeploy: boolean;
	onChanged?: () => unknown;
	onResumeAndDeploy?: () => Promise<void>;
}

export const DeployFreezeBanner = ({
	serviceType,
	serviceId,
	deployFreeze,
	canDeploy,
	onChanged,
	onResumeAndDeploy,
}: Props) => {
	const [isDeployingAfterResume, setIsDeployingAfterResume] = useState(false);
	const { mutateAsync: setComposeFreeze, isPending: isComposePending } =
		api.compose.setDeployFreeze.useMutation();
	const { mutateAsync: setApplicationFreeze, isPending: isAppPending } =
		api.application.setDeployFreeze.useMutation();

	if (!deployFreeze?.active) {
		return null;
	}

	const isPending = isComposePending || isAppPending || isDeployingAfterResume;

	const resumeFreeze = async () => {
		if (serviceType === "compose") {
			return setComposeFreeze({
				composeId: serviceId,
				frozen: false,
			});
		}
		return setApplicationFreeze({
			applicationId: serviceId,
			frozen: false,
		});
	};

	const handleResume = async () => {
		try {
			await resumeFreeze();
			toast.success("Deploys resumed");
			await onChanged?.();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to resume deploys",
			);
		}
	};

	const handleResumeAndDeploy = async () => {
		if (!onResumeAndDeploy) {
			return;
		}
		setIsDeployingAfterResume(true);
		try {
			await resumeFreeze();
			toast.success("Deploys resumed");
			await onChanged?.();
			await onResumeAndDeploy();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to resume and deploy service",
			);
		} finally {
			setIsDeployingAfterResume(false);
		}
	};

	return (
		<Alert className="border-amber-500/60 bg-amber-500/10 text-amber-900 dark:text-amber-200">
			<Snowflake className="size-4 text-amber-600 dark:text-amber-400" />
			<AlertTitle>
				Deploys are frozen{" "}
				{deployFreeze.expiresAt
					? `until ${new Date(deployFreeze.expiresAt).toLocaleString()}`
					: "until resumed manually"}
			</AlertTitle>
			<AlertDescription className="text-amber-900/90 dark:text-amber-200/90">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-0.5 text-xs">
						{deployFreeze.reason && <p>Reason: {deployFreeze.reason}</p>}
						{deployFreeze.frozenByLabel && (
							<p>Frozen by: {deployFreeze.frozenByLabel}</p>
						)}
						{deployFreeze.skippedCount > 0 && (
							<p>
								{deployFreeze.skippedCount} automated{" "}
								{deployFreeze.skippedCount === 1 ? "deploy" : "deploys"} skipped
								while frozen
								{deployFreeze.lastSkippedAt
									? ` (last skipped ${new Date(deployFreeze.lastSkippedAt).toLocaleString()})`
									: ""}
							</p>
						)}
					</div>

					{canDeploy && (
						<div className="flex flex-wrap items-center gap-2 shrink-0">
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={isPending}
								onClick={handleResume}
								className="border-amber-500/60 bg-background/80 hover:bg-background"
							>
								Resume
							</Button>
							{deployFreeze.skippedCount > 0 && onResumeAndDeploy && (
								<Button
									type="button"
									size="sm"
									variant="default"
									disabled={isPending}
									onClick={handleResumeAndDeploy}
								>
									Resume & Deploy
								</Button>
							)}
						</div>
					)}
				</div>
			</AlertDescription>
		</Alert>
	);
};
