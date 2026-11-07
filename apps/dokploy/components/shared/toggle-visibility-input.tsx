import copy from "copy-to-clipboard";
import { Clipboard } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input, type InputProps } from "../ui/input";

// What the API returns in place of a saved secret.
const HIDDEN_SECRET = "__DOKPLOY_REDACTED_SECRET__";

interface Props extends InputProps {
	// Loads the real value when the shown one still holds the placeholder.
	resolveValue?: () => Promise<string>;
}

export const ToggleVisibilityInput = ({ resolveValue, ...props }: Props) => {
	const inputRef = useRef<HTMLInputElement>(null);

	const currentValue = async () => {
		const shown = inputRef.current?.value || "";
		if (!resolveValue || !shown.includes(HIDDEN_SECRET)) {
			return shown;
		}
		return resolveValue();
	};

	return (
		<div className="flex w-full items-center space-x-2">
			<Input
				ref={inputRef}
				{...props}
				type="password"
				onBeforeShowPassword={async () => {
					try {
						await currentValue();
						return true;
					} catch (error) {
						toast.error(
							error instanceof Error
								? error.message
								: "Could not show the value",
						);
						return false;
					}
				}}
			/>
			<Button
				type="button"
				variant={"secondary"}
				onClick={async () => {
					try {
						copy(await currentValue());
						toast.success("Value is copied to clipboard");
					} catch (error) {
						toast.error(
							error instanceof Error
								? error.message
								: "Could not copy the value",
						);
					}
				}}
			>
				<Clipboard className="size-4 text-muted-foreground" />
			</Button>
		</div>
	);
};
