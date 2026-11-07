import { toast } from "sonner";
import { ToggleVisibilityInput } from "@/components/shared/toggle-visibility-input";
import { UpdateDatabasePassword } from "@/components/shared/update-database-password";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDatabaseCredentials } from "@/hooks/use-database-credentials";
import { buildRedisUrl } from "@/lib/database-connection-url";
import { api } from "@/utils/api";

interface Props {
	redisId: string;
}
export const ShowInternalRedisCredentials = ({ redisId }: Props) => {
	const { data } = api.redis.one.useQuery({ redisId });
	const { credentials, reveal, forget } = useDatabaseCredentials(
		"redis",
		redisId,
		data,
	);
	const utils = api.useUtils();
	const { mutateAsync: changePassword } =
		api.redis.changePassword.useMutation();
	return (
		<>
			<div className="flex w-full flex-col gap-5 ">
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="text-xl">Internal Credentials</CardTitle>
					</CardHeader>
					<CardContent className="flex w-full flex-row gap-4">
						<div className="grid w-full md:grid-cols-2 gap-4 md:gap-8">
							<div className="flex flex-col gap-2">
								<Label>User</Label>
								<Input enableCopyButton disabled value="default" />
							</div>
							<div className="flex flex-col gap-2">
								<Label>Password</Label>
								<div className="flex flex-row gap-2 items-center">
									<ToggleVisibilityInput
										value={credentials?.databasePassword}
										resolveValue={async () => {
											const record = await reveal();
											return record.databasePassword ?? "";
										}}
										disabled
									/>
									<UpdateDatabasePassword
										notice="Redis restarts with the new password, so its clients disconnect for a moment and need the new password to reconnect. A stopped Redis takes it at the next start. With a custom command, only the running Redis changes: nothing restarts, and the command decides the password after the next restart."
										onUpdatePassword={async (newPassword) => {
											await changePassword({
												redisId,
												password: newPassword,
											});
											toast.success("Password updated successfully");
											forget();
											utils.redis.one.invalidate({ redisId });
										}}
									/>
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Internal Port (Container)</Label>
								<Input disabled value="6379" />
							</div>

							<div className="flex flex-col gap-2">
								<Label>Internal Host</Label>
								<Input enableCopyButton disabled value={data?.appName} />
							</div>

							<div className="flex flex-col gap-2 md:col-span-2">
								<Label>Internal Connection URL </Label>
								<ToggleVisibilityInput
									disabled
									value={
										credentials
											? buildRedisUrl(credentials, {
													host: credentials.appName,
													port: 6379,
												})
											: ""
									}
									resolveValue={async () => {
										const record = await reveal();
										return buildRedisUrl(record, {
											host: record.appName,
											port: 6379,
										});
									}}
								/>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>
		</>
	);
};
