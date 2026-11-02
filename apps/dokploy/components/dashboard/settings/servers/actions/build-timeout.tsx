import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 1440;

interface Props {
	/**
	 * When provided, configures the timeout for that remote server. When
	 * omitted, configures the local Dokploy web server.
	 */
	serverId?: string;
	/** Optional title override (e.g. the server name in a list). */
	label?: string;
}

export const BuildTimeout = ({ serverId, label }: Props) => {
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const serverQuery = api.server.one.useQuery(
		{ serverId: serverId ?? "" },
		{ enabled: !!serverId },
	);
	const webServerQuery = api.settings.getWebServerSettings.useQuery(undefined, {
		enabled: !serverId,
	});

	const current = serverId
		? serverQuery.data?.buildTimeoutMinutes
		: webServerQuery.data?.buildTimeoutMinutes;
	const refetch = serverId ? serverQuery.refetch : webServerQuery.refetch;

	const updateServer = api.server.updateBuildTimeout.useMutation();
	const updateWebServer = api.settings.updateBuildTimeout.useMutation();
	const isPending = serverId
		? updateServer.isPending
		: updateWebServer.isPending;

	const [value, setValue] = useState(String(DEFAULT_MINUTES));

	useEffect(() => {
		if (current) {
			setValue(String(current));
		}
	}, [current]);

	if (isCloud) return null;

	const handleSave = async () => {
		const parsed = Math.min(
			MAX_MINUTES,
			Math.max(1, Number.parseInt(value, 10) || DEFAULT_MINUTES),
		);
		setValue(String(parsed));
		try {
			if (serverId) {
				await updateServer.mutateAsync({
					serverId,
					buildTimeoutMinutes: parsed,
				});
			} else {
				await updateWebServer.mutateAsync({ buildTimeoutMinutes: parsed });
			}
			await refetch();
			toast.success("Build timeout updated");
		} catch {
			toast.error("Error updating build timeout");
		}
	};

	const hasChanges = Number(value) !== (current ?? DEFAULT_MINUTES);

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<div className="flex flex-row items-center justify-between gap-4">
				<div className="flex items-center gap-2">
					<p className="text-sm font-medium">
						{label ?? serverQuery.data?.name ?? "Dokploy Server"}
					</p>
					<span className="text-xs text-muted-foreground rounded border px-1.5 py-0.5">
						{serverId
							? (serverQuery.data?.ipAddress ?? "remote server")
							: "local host"}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<Input
						type="number"
						min={1}
						max={MAX_MINUTES}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						className="w-24"
						aria-label="Build timeout in minutes"
					/>
					<span className="text-sm text-muted-foreground">min</span>
					<Button
						type="button"
						size="sm"
						onClick={handleSave}
						isLoading={isPending}
						disabled={!hasChanges}
					>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
};
