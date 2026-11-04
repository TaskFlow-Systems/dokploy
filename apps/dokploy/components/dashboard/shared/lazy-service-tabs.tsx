import { Loader2 } from "lucide-react";
import dynamic, { type DynamicOptionsLoadingProps } from "next/dynamic";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";

const TabLoading = ({ error, pastDelay }: DynamicOptionsLoadingProps) => {
	// A panel update removes the chunks of the build an open page came from, and
	// next/dynamic renders nothing for a failed chunk unless the loader does.
	if (error) {
		return (
			<div className="flex w-full flex-col gap-4 min-h-[40vh] justify-center items-center">
				<span className="text-base text-muted-foreground">
					This tab could not be loaded. The panel may have been updated.
				</span>
				<Button variant="outline" onClick={() => window.location.reload()}>
					Reload page
				</Button>
			</div>
		);
	}

	return (
		<div className="flex w-full flex-row gap-4 min-h-[40vh] justify-center items-center">
			{pastDelay && (
				<>
					<Loader2 className="size-5 animate-spin text-muted-foreground" />
					<span className="text-base text-muted-foreground">Loading...</span>
				</>
			)}
		</div>
	);
};

// next/dynamic and not React.lazy: React holds the reveal of a new Suspense
// boundary for 300 ms, and next/dynamic in the pages router loads through state.
// ssr: false because DashboardLayout renders nothing until mounted, so the server
// never reaches a tab and need not load its code.
export const lazyTab = <P,>(load: () => Promise<ComponentType<P>>) =>
	Object.assign(dynamic(load, { loading: TabLoading, ssr: false }), {
		// For onPointerEnter of the tab's trigger, so the code is on its way before
		// the click. A failure here stays silent: the click loads again and shows it.
		preload: () => {
			load().catch(() => {});
		},
	});

export const ContainerFreeMonitoring = lazyTab(() =>
	import(
		"@/components/dashboard/monitoring/free/container/show-free-container-monitoring"
	).then((m) => m.ContainerFreeMonitoring),
);

export const ContainerPaidMonitoring = lazyTab(() =>
	import(
		"@/components/dashboard/monitoring/paid/container/show-paid-container-monitoring"
	).then((m) => m.ContainerPaidMonitoring),
);

export const ShowBackups = lazyTab(() =>
	import("@/components/dashboard/database/backups/show-backups").then(
		(m) => m.ShowBackups,
	),
);

export const ShowDatabaseAdvancedSettings = lazyTab(() =>
	import("@/components/dashboard/shared/show-database-advanced-settings").then(
		(m) => m.ShowDatabaseAdvancedSettings,
	),
);

export const ShowDeployments = lazyTab(() =>
	import(
		"@/components/dashboard/application/deployments/show-deployments"
	).then((m) => m.ShowDeployments),
);

export const ShowDockerLogs = lazyTab(() =>
	import("@/components/dashboard/application/logs/show").then(
		(m) => m.ShowDockerLogs,
	),
);

export const ShowDomains = lazyTab(() =>
	import("@/components/dashboard/application/domains/show-domains").then(
		(m) => m.ShowDomains,
	),
);

export const ShowEnvironment = lazyTab(() =>
	import(
		"@/components/dashboard/application/environment/show-environment"
	).then((m) => m.ShowEnvironment),
);

export const ShowPatches = lazyTab(() =>
	import("@/components/dashboard/application/patches/show-patches").then(
		(m) => m.ShowPatches,
	),
);

export const ShowSchedules = lazyTab(() =>
	import("@/components/dashboard/application/schedules/show-schedules").then(
		(m) => m.ShowSchedules,
	),
);

export const ShowVolumeBackups = lazyTab(() =>
	import(
		"@/components/dashboard/application/volume-backups/show-volume-backups"
	).then((m) => m.ShowVolumeBackups),
);
