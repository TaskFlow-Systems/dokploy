import { RefreshCw } from "lucide-react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

interface Props {
	serverId: string | null;
	serverName: string;
}

export const ShowTraefikLogs = ({ serverId, serverName }: Props) => {
	const { data, error, isFetching, refetch } =
		api.domainOverview.traefikLogs.useQuery(
			{ serverId },
			{ refetchOnWindowFocus: false },
		);

	return (
		<Card className="bg-sidebar p-2.5 rounded-xl w-full">
			<div className="rounded-xl bg-background shadow-md p-6 flex flex-col gap-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex flex-col gap-1">
						<h3 className="text-lg font-semibold">Traefik log: {serverName}</h3>
						<p className="text-sm text-muted-foreground">
							The last 300 lines that mention certificates or ACME, from the
							last 72 hours. Read only.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => refetch()}
						disabled={isFetching}
					>
						<RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
						Refresh
					</Button>
				</div>

				{error && <AlertBlock type="error">{error.message}</AlertBlock>}
				{data?.error && <AlertBlock type="warning">{data.error}</AlertBlock>}
				{data && !data.containerFound && (
					<AlertBlock type="info">
						The dokploy-traefik container was not found on this server.
					</AlertBlock>
				)}

				{data &&
					data.lines.length === 0 &&
					data.containerFound &&
					!data.error && (
						<p className="text-sm text-muted-foreground">
							No certificate or ACME lines in the recent log.
						</p>
					)}

				{data && data.lines.length > 0 && (
					<pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs font-mono">
						{data.lines.map((line, index) => (
							<div
								key={`${index}-${line.text.slice(0, 40)}`}
								className="whitespace-pre-wrap break-all"
							>
								{line.text}
							</div>
						))}
					</pre>
				)}
			</div>
		</Card>
	);
};
