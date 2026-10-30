import copy from "copy-to-clipboard";
import { Eye } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

interface Props {
	apiKeyId: string;
	name: string | null;
	revealable: boolean;
}

export const RevealApiKey = ({ apiKeyId, name, revealable }: Props) => {
	const [key, setKey] = useState<string | null>(null);
	const { mutateAsync, isPending } = api.user.revealApiKey.useMutation();

	const reveal = async () => {
		try {
			const result = await mutateAsync({ apiKeyId });
			setKey(result.key);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Error revealing API key",
			);
		}
	};

	return (
		<>
			<TooltipProvider delayDuration={0}>
				<Tooltip>
					<TooltipTrigger asChild>
						{/* Disabled buttons swallow pointer events, so the tooltip needs a wrapper. */}
						<span>
							<Button
								variant="ghost"
								size="icon"
								isLoading={isPending}
								disabled={!revealable}
								onClick={reveal}
							>
								<Eye className="size-4" />
							</Button>
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{revealable
							? "Show key"
							: "This key was created before keys could be revealed"}
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<Dialog
				open={key !== null}
				onOpenChange={(open) => !open && setKey(null)}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>{name || "API Key"}</DialogTitle>
						<DialogDescription>
							Anyone with this key can act as you. Don't share it.
						</DialogDescription>
					</DialogHeader>
					<div className="mt-4 space-y-4">
						<CodeEditor
							className="font-mono text-sm break-all"
							language="properties"
							value={key ?? ""}
							readOnly
						/>
						<div className="flex justify-end gap-3">
							<Button
								onClick={() => {
									copy(key ?? "");
									toast.success("API key copied to clipboard");
								}}
							>
								Copy to Clipboard
							</Button>
							<Button variant="outline" onClick={() => setKey(null)}>
								Close
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
};
