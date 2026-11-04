import { AtSign } from "lucide-react";
import { FormControl, FormItem, FormLabel } from "@/components/ui/form";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { isGravatarAvatar } from "@/lib/avatar-utils";

interface Props {
	value?: string;
	gravatarUrl: string | null;
	hashPending?: boolean;
}

// Rendering the <img> sends a hash of the user's email to gravatar.com, so it
// appears only once the avatar value is a Gravatar: a saved one or the user's
// click on this option. gravatarUrl stays null where the browser has no
// crypto.subtle (a panel on plain HTTP), and a saved Gravatar still shows there.
// The hash arrives just after the first paint, so hashPending holds the option's
// place: without it every avatar after this one moves when the hash is ready.
export const GravatarOption = ({ value, gravatarUrl, hashPending }: Props) => {
	const selectedGravatar = isGravatarAvatar(value) ? value : null;
	const radioValue = gravatarUrl ?? selectedGravatar;
	if (!radioValue && !hashPending) return null;

	return (
		<FormItem>
			<FormLabel
				title="Use your Gravatar"
				className="[&:has([data-state=checked])>.gravatar-avatar]:border-primary [&:has([data-state=checked])>.gravatar-avatar]:border [&:has([data-state=checked])>.gravatar-avatar]:p-px cursor-pointer"
			>
				<FormControl>
					<RadioGroupItem
						value={radioValue ?? "gravatar-pending"}
						disabled={!radioValue}
						aria-label="Use your Gravatar"
						className="sr-only"
					/>
				</FormControl>
				<div className="gravatar-avatar h-12 w-12 rounded-full border hover:p-px hover:border-primary transition-colors flex items-center justify-center overflow-hidden">
					{selectedGravatar ? (
						// biome-ignore lint/performance/noImgElement: this is an justified use of img element
						<img
							src={selectedGravatar}
							alt="Gravatar"
							className="h-full w-full object-cover rounded-full"
						/>
					) : (
						<AtSign className="h-5 w-5 text-muted-foreground" />
					)}
				</div>
			</FormLabel>
		</FormItem>
	);
};
