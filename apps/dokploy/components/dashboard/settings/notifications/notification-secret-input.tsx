import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

// What the API returns in place of a saved secret.
export const SAVED_NOTIFICATION_SECRET = "__DOKPLOY_REDACTED_SECRET__";

interface Props {
	value: string | undefined;
	onChange: (value: string) => void;
	onBlur?: () => void;
	name?: string;
	placeholder?: string;
	notificationId?: string;
	secretField: string;
}

export const NotificationSecretInput = ({
	value,
	onChange,
	onBlur,
	name,
	placeholder,
	notificationId,
	secretField,
}: Props) => {
	const { mutateAsync: revealSecret } =
		api.notification.revealSecret.useMutation();

	return (
		<Input
			type="password"
			autoComplete="off"
			name={name}
			placeholder={placeholder}
			value={value ?? ""}
			onBlur={onBlur}
			onChange={(event) => onChange(event.target.value)}
			onBeforeShowPassword={async () => {
				if (!notificationId || value !== SAVED_NOTIFICATION_SECRET) {
					return true;
				}
				try {
					const revealed = await revealSecret({
						notificationId,
						field: secretField,
					});
					onChange(revealed.value);
					return true;
				} catch (error) {
					toast.error(
						error instanceof Error ? error.message : "Could not show the value",
					);
					return false;
				}
			}}
		/>
	);
};
