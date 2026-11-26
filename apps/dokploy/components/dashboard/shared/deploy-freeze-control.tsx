import {
	type DeployFreezeState,
	getNextFreezeExpiryTimeoutMs,
	MAX_FREEZE_REASON_LENGTH,
	sanitizeFreezeReason,
} from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { ChevronDown, PlayCircle, Snowflake } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

const DURATION_PRESETS: Array<{ label: string; value: number | null }> = [
	{ label: "1 hour", value: 60 },
	{ label: "4 hours", value: 240 },
	{ label: "24 hours", value: 1440 },
	{ label: "Until resumed", value: null },
];

const formatShortExpiryBadge = (expiresAt: string | null) => {
	if (!expiresAt) {
		return "Manual";
	}
	const date = new Date(expiresAt);
	if (Number.isNaN(date.getTime())) {
		return "Manual";
	}
	const diffMs = date.getTime() - Date.now();
	if (diffMs <= 24 * 60 * 60 * 1000) {
		const hours = String(date.getHours()).padStart(2, "0");
		const minutes = String(date.getMinutes()).padStart(2, "0");
		return `until ${hours}:${minutes}`;
	}
	return `until ${date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	})}`;
};

interface Props {
	serviceType: "compose" | "application";
	serviceId: string;
	deployFreeze: DeployFreezeState | null | undefined;
	onChanged?: () => unknown;
	disabled?: boolean;
	className?: string;
}

export const DeployFreezeControl = ({
	serviceType,
	serviceId,
	deployFreeze,
	onChanged,
	disabled,
	className,
}: Props) => {
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [tooltipOpen, setTooltipOpen] = useState(false);
	const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
	const [reason, setReason] = useState("");
	const onChangedRef = useRef(onChanged);
	onChangedRef.current = onChanged;

	const { mutateAsync: setComposeFreeze, isPending: isComposePending } =
		api.compose.setDeployFreeze.useMutation();
	const { mutateAsync: setApplicationFreeze, isPending: isAppPending } =
		api.application.setDeployFreeze.useMutation();
	const isPending = isComposePending || isAppPending;
	const isFrozen = Boolean(deployFreeze?.active);

	useEffect(() => {
		const timeoutMs = getNextFreezeExpiryTimeoutMs(
			deployFreeze?.expiresAt ?? null,
		);
		if (timeoutMs === null) {
			return;
		}
		const timer = setTimeout(() => {
			void onChangedRef.current?.();
		}, timeoutMs);
		return () => clearTimeout(timer);
	}, [deployFreeze?.expiresAt]);

	const mutateFreeze = async (payload: {
		frozen: boolean;
		durationMinutes?: number | null;
		reason?: string | null;
	}) => {
		if (serviceType === "compose") {
			return setComposeFreeze({
				composeId: serviceId,
				...payload,
			});
		}
		return setApplicationFreeze({
			applicationId: serviceId,
			...payload,
		});
	};

	const handleQuickToggle = async () => {
		try {
			if (isFrozen) {
				await mutateFreeze({ frozen: false });
				toast.success("Deploys resumed");
			} else {
				await mutateFreeze({
					frozen: true,
					durationMinutes: null,
					reason: null,
				});
				toast.success("Deploys frozen");
			}
			await onChangedRef.current?.();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: isFrozen
						? "Failed to resume deploys"
						: "Failed to freeze deploys",
			);
		}
	};

	const handlePopoverSubmit = async () => {
		let sanitized: string | null = null;
		try {
			sanitized = sanitizeFreezeReason(reason);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Invalid freeze reason",
			);
			return;
		}

		try {
			await mutateFreeze({
				frozen: true,
				durationMinutes,
				reason: sanitized,
			});
			toast.success(isFrozen ? "Deploy freeze updated" : "Deploys frozen");
			setPopoverOpen(false);
			await onChangedRef.current?.();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save deploy freeze",
			);
		}
	};

	const handleResumeFromPopover = async () => {
		try {
			await mutateFreeze({ frozen: false });
			toast.success("Deploys resumed");
			setPopoverOpen(false);
			await onChangedRef.current?.();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to resume deploys",
			);
		}
	};

	return (
		<fieldset
			aria-label="Deployment freeze controls"
			className={cn(
				"m-0 inline-flex min-w-0 items-stretch border-0 p-0",
				className,
			)}
		>
			<TooltipProvider delayDuration={0}>
				<Tooltip
					open={!popoverOpen && tooltipOpen}
					onOpenChange={(nextOpen) => {
						if (!popoverOpen) {
							setTooltipOpen(nextOpen);
						}
					}}
				>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="outline"
							disabled={disabled || isPending}
							onClick={handleQuickToggle}
							className={cn(
								"rounded-r-none border-r-0 flex items-center gap-1.5 flex-1",
								isFrozen &&
									"border-amber-500/60 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300",
							)}
						>
							{isFrozen ? (
								<>
									<PlayCircle className="size-4 shrink-0" />
									<span>Deploys Frozen</span>
									<Badge
										variant="outline"
										className="ml-1 border-amber-500/50 text-[11px] font-normal px-1.5 py-0"
									>
										{formatShortExpiryBadge(deployFreeze?.expiresAt ?? null)}
									</Badge>
								</>
							) : (
								<>
									<Snowflake className="size-4 shrink-0" />
									<span>Freeze Deploys</span>
								</>
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent sideOffset={5} className="z-60 max-w-xs text-xs">
						{isFrozen && deployFreeze ? (
							<div className="space-y-1">
								<p className="font-medium">
									Automated deploys are frozen{" "}
									{deployFreeze.expiresAt
										? `until ${new Date(deployFreeze.expiresAt).toLocaleString()}`
										: "until resumed manually"}
									.
								</p>
								{deployFreeze.reason && <p>Reason: {deployFreeze.reason}</p>}
								{deployFreeze.skippedCount > 0 && (
									<p>{deployFreeze.skippedCount} skipped while frozen</p>
								)}
								<p>Click to resume automated deploys.</p>
							</div>
						) : (
							<p>
								Block automated webhook and API deploys while leaving manual
								panel deploys available with confirmation.
							</p>
						)}
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<Popover
				open={popoverOpen}
				onOpenChange={(nextOpen) => {
					setPopoverOpen(nextOpen);
					if (nextOpen) {
						setTooltipOpen(false);
						setReason(deployFreeze?.reason ?? "");
						setDurationMinutes(null);
					}
				}}
			>
				<PopoverTrigger asChild>
					<Button
						type="button"
						size="icon"
						variant="outline"
						disabled={disabled || isPending}
						aria-label="Configure deploy freeze options"
						className={cn(
							"rounded-l-none px-2",
							isFrozen &&
								"border-amber-500/60 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300",
						)}
					>
						<ChevronDown className="size-4" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-80 space-y-3">
					<div className="space-y-1">
						<p className="text-sm font-medium">
							{isFrozen ? "Update deploy freeze" : "Freeze deployments"}
						</p>
						<p className="text-xs text-muted-foreground">
							Select a freeze duration and optional reason.
						</p>
					</div>

					<div className="grid grid-cols-2 gap-1.5">
						{DURATION_PRESETS.map((preset) => (
							<Button
								key={preset.label}
								type="button"
								size="sm"
								variant={
									durationMinutes === preset.value ? "default" : "outline"
								}
								onClick={() => setDurationMinutes(preset.value)}
							>
								{preset.label}
							</Button>
						))}
					</div>

					<div className="space-y-1.5">
						<label
							htmlFor={`freeze-reason-${serviceId}`}
							className="text-xs font-medium text-muted-foreground"
						>
							Reason (optional)
						</label>
						<Input
							id={`freeze-reason-${serviceId}`}
							maxLength={MAX_FREEZE_REASON_LENGTH}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="e.g. Incident investigation or maintenance"
						/>
					</div>

					<div className="flex items-center justify-end gap-2 pt-1">
						{isFrozen && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={isPending}
								onClick={handleResumeFromPopover}
							>
								Resume now
							</Button>
						)}
						<Button
							type="button"
							size="sm"
							disabled={isPending}
							onClick={handlePopoverSubmit}
						>
							{isFrozen ? "Update freeze" : "Freeze"}
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		</fieldset>
	);
};
