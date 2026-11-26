import type { DeployFreezeState } from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { Snowflake } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

interface Props {
	serviceType: "compose" | "application" | "environment";
	serviceId: string;
	deployFreeze?: DeployFreezeState | null | undefined;
	serviceFreeze?: DeployFreezeState | null | undefined;
	environmentFreeze?: DeployFreezeState | null | undefined;
	environmentId?: string;
	projectId?: string;
	environmentName?: string;
	canDeploy: boolean;
	canManageEnvironmentFreeze?: boolean;
	onChanged?: () => unknown;
	onResumeAndDeploy?: () => Promise<void>;
}

const formatExpiryPhrase = (expiresAt: string | null) =>
	expiresAt
		? `until ${new Date(expiresAt).toLocaleString()}`
		: "until resumed manually";

const FreezeLayerDetails = ({
	freeze,
	heading,
}: {
	freeze: DeployFreezeState;
	heading?: string;
}) => (
	<div className="space-y-0.5 text-xs">
		{heading && (
			<p className="font-medium">
				{heading} ({formatExpiryPhrase(freeze.expiresAt)})
			</p>
		)}
		{freeze.reason && <p>Reason: {freeze.reason}</p>}
		{freeze.frozenByLabel && <p>Frozen by: {freeze.frozenByLabel}</p>}
		{freeze.skippedCount > 0 && (
			<p>
				{freeze.skippedCount} automated{" "}
				{freeze.skippedCount === 1 ? "deploy" : "deploys"} skipped while frozen
				{freeze.lastSkippedAt
					? ` (last skipped ${new Date(freeze.lastSkippedAt).toLocaleString()})`
					: ""}
			</p>
		)}
	</div>
);

export const DeployFreezeBanner = ({
	serviceType,
	serviceId,
	deployFreeze,
	serviceFreeze,
	environmentFreeze,
	environmentId,
	projectId,
	environmentName,
	canDeploy,
	canManageEnvironmentFreeze,
	onChanged,
	onResumeAndDeploy,
}: Props) => {
	const utils = api.useUtils();
	const [isDeployingAfterResume, setIsDeployingAfterResume] = useState(false);
	const [isUnfreezeEnvDialogOpen, setIsUnfreezeEnvDialogOpen] = useState(false);

	const { mutateAsync: setComposeFreeze, isPending: isComposePending } =
		api.compose.setDeployFreeze.useMutation();
	const { mutateAsync: setApplicationFreeze, isPending: isAppPending } =
		api.application.setDeployFreeze.useMutation();
	const { mutateAsync: setEnvironmentFreeze, isPending: isEnvPending } =
		api.environment.setDeployFreeze.useMutation();

	const isPending =
		isComposePending || isAppPending || isEnvPending || isDeployingAfterResume;

	const invalidateEnvironmentCaches = async (targetEnvironmentId: string) => {
		await Promise.all([
			utils.environment.one.invalidate({ environmentId: targetEnvironmentId }),
			utils.environment.byProjectId.invalidate(),
			utils.overview.services.invalidate(),
		]);
	};

	const handleUnfreezeEnvironment = async (targetEnvironmentId: string) => {
		try {
			await setEnvironmentFreeze({
				environmentId: targetEnvironmentId,
				frozen: false,
			});
			await invalidateEnvironmentCaches(targetEnvironmentId);
			toast.success("Environment deploys resumed");
			setIsUnfreezeEnvDialogOpen(false);
			await onChanged?.();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to resume environment deploys",
			);
		}
	};

	if (serviceType === "environment") {
		const envActive = deployFreeze?.active
			? deployFreeze
			: environmentFreeze?.active
				? environmentFreeze
				: null;
		if (!envActive) {
			return null;
		}
		const canResumeEnv = canManageEnvironmentFreeze ?? canDeploy;

		return (
			<Alert className="border-amber-500/60 bg-amber-500/10 text-amber-900 dark:text-amber-200">
				<Snowflake className="size-4 text-amber-600 dark:text-amber-400" />
				<AlertTitle>
					Environment deploys are frozen{" "}
					{formatExpiryPhrase(envActive.expiresAt)}
				</AlertTitle>
				<AlertDescription className="text-amber-900/90 dark:text-amber-200/90">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<FreezeLayerDetails freeze={envActive} />
						{canResumeEnv && (
							<div className="flex flex-wrap items-center gap-2 shrink-0">
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={isPending}
									onClick={() => void handleUnfreezeEnvironment(serviceId)}
									className="border-amber-500/60 bg-background/80 hover:bg-background"
								>
									Resume Environment
								</Button>
							</div>
						)}
					</div>
				</AlertDescription>
			</Alert>
		);
	}

	const ownServiceFreeze =
		serviceFreeze !== undefined
			? serviceFreeze?.active
				? serviceFreeze
				: null
			: deployFreeze?.active && deployFreeze.scopeType !== "environment"
				? deployFreeze
				: null;

	const parentEnvFreeze =
		environmentFreeze !== undefined
			? environmentFreeze?.active
				? environmentFreeze
				: null
			: deployFreeze?.active && deployFreeze.scopeType === "environment"
				? deployFreeze
				: null;

	if (!ownServiceFreeze && !parentEnvFreeze) {
		return null;
	}

	const isDualFreeze = Boolean(ownServiceFreeze && parentEnvFreeze);
	const isEnvOnlyFreeze = Boolean(!ownServiceFreeze && parentEnvFreeze);
	const resolvedEnvId =
		environmentId ??
		(parentEnvFreeze?.scopeType === "environment"
			? parentEnvFreeze.scopeId
			: undefined);
	const envHref =
		projectId && resolvedEnvId
			? `/dashboard/project/${projectId}/environment/${resolvedEnvId}`
			: null;
	const envDisplayName = environmentName || "this environment";

	const resumeServiceFreeze = async () => {
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

	const handleResumeService = async () => {
		try {
			await resumeServiceFreeze();
			toast.success(
				parentEnvFreeze
					? "Service deploy freeze resumed (environment freeze still active)"
					: "Deploys resumed",
			);
			await onChanged?.();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to resume deploys",
			);
		}
	};

	const handleResumeAndDeploy = async () => {
		if (!onResumeAndDeploy || parentEnvFreeze) {
			return;
		}
		setIsDeployingAfterResume(true);
		try {
			await resumeServiceFreeze();
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
		<>
			<Alert className="border-amber-500/60 bg-amber-500/10 text-amber-900 dark:text-amber-200">
				<Snowflake className="size-4 text-amber-600 dark:text-amber-400" />
				<AlertTitle>
					{isDualFreeze
						? `Deploys are frozen at both environment${environmentName ? ` (${environmentName})` : ""} and service levels`
						: isEnvOnlyFreeze && parentEnvFreeze
							? `Deploys are frozen at environment level${environmentName ? ` (${environmentName})` : ""} ${formatExpiryPhrase(parentEnvFreeze.expiresAt)}`
							: ownServiceFreeze
								? `Deploys are frozen ${formatExpiryPhrase(ownServiceFreeze.expiresAt)}`
								: "Deploys are frozen"}
				</AlertTitle>
				<AlertDescription className="text-amber-900/90 dark:text-amber-200/90">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="space-y-2">
							{isDualFreeze && parentEnvFreeze && ownServiceFreeze ? (
								<>
									<FreezeLayerDetails
										freeze={parentEnvFreeze}
										heading={`Environment freeze${environmentName ? ` (${environmentName})` : ""}`}
									/>
									<FreezeLayerDetails
										freeze={ownServiceFreeze}
										heading="Service freeze"
									/>
								</>
							) : parentEnvFreeze ? (
								<FreezeLayerDetails freeze={parentEnvFreeze} />
							) : ownServiceFreeze ? (
								<FreezeLayerDetails freeze={ownServiceFreeze} />
							) : null}
						</div>

						<div className="flex flex-wrap items-center gap-2 shrink-0">
							{ownServiceFreeze && canDeploy && (
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={isPending}
									onClick={handleResumeService}
									className="border-amber-500/60 bg-background/80 hover:bg-background"
								>
									{parentEnvFreeze ? "Resume Service Freeze" : "Resume"}
								</Button>
							)}
							{ownServiceFreeze &&
								!parentEnvFreeze &&
								canDeploy &&
								ownServiceFreeze.skippedCount > 0 &&
								onResumeAndDeploy && (
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
							{parentEnvFreeze && envHref && (
								<Button
									asChild
									size="sm"
									variant="outline"
									className="border-amber-500/60 bg-background/80 hover:bg-background"
								>
									<Link href={envHref}>View Environment</Link>
								</Button>
							)}
							{parentEnvFreeze &&
								canManageEnvironmentFreeze &&
								resolvedEnvId && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={isPending}
										onClick={() => setIsUnfreezeEnvDialogOpen(true)}
										className="border-amber-500/60 bg-background/80 hover:bg-background"
									>
										Unfreeze Environment
									</Button>
								)}
						</div>
					</div>
				</AlertDescription>
			</Alert>

			{parentEnvFreeze && resolvedEnvId && (
				<AlertDialog
					open={isUnfreezeEnvDialogOpen}
					onOpenChange={setIsUnfreezeEnvDialogOpen}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Unfreeze Environment</AlertDialogTitle>
							<AlertDialogDescription>
								Are you sure you want to unfreeze environment{" "}
								<span className="font-semibold">{envDisplayName}</span>? This
								will resume automated deployments for all services in this
								environment that do not have their own service-level freeze.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
							<AlertDialogAction
								disabled={isPending}
								onClick={() => void handleUnfreezeEnvironment(resolvedEnvId)}
							>
								Unfreeze Environment
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</>
	);
};
