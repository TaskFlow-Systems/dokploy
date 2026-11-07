import { getLibsqlPrimaryUrlProblem } from "@dokploy/server/utils/databases/libsql-primary-url";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

interface Props {
	libsqlId: string;
}

export const ShowLibsqlPrimaryUrl = ({ libsqlId }: Props) => {
	const { data, refetch } = api.libsql.one.useQuery({ libsqlId });
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { mutateAsync, isPending } = api.libsql.update.useMutation();
	const canEdit = permissions?.service.create ?? false;

	const form = useForm<{ sqldPrimaryUrl: string }>({
		defaultValues: { sqldPrimaryUrl: "" },
	});

	// Only on this value: a status change during a deploy refetches the same query,
	// and must not wipe what the user is typing.
	const storedUrl = data?.sqldPrimaryUrl ?? "";
	useEffect(() => {
		form.reset({ sqldPrimaryUrl: storedUrl });
	}, [form, storedUrl]);

	if (data?.sqldNode !== "replica") {
		return null;
	}

	const onSubmit = async (values: { sqldPrimaryUrl: string }) => {
		const sqldPrimaryUrl = values.sqldPrimaryUrl.trim();
		const problem = getLibsqlPrimaryUrlProblem(sqldPrimaryUrl, data.command);
		if (problem) {
			form.setError("sqldPrimaryUrl", { message: problem });
			return;
		}
		await mutateAsync({ libsqlId, sqldPrimaryUrl })
			.then(async () => {
				toast.success("Primary URL saved. Deploy this replica to apply it");
				await refetch();
			})
			.catch((error: Error) => {
				toast.error(error?.message || "Error saving the primary URL");
			});
	};

	return (
		<div className="flex w-full flex-col gap-5">
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">Primary</CardTitle>
					<CardDescription>
						The database this replica follows. A saved URL takes effect on the
						next deploy: Reload keeps the old one. A password in the URL stays
						hidden here, and the stored one is kept only while the URL stays as
						shown.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="flex flex-col gap-4"
						>
							<FormField
								control={form.control}
								name="sqldPrimaryUrl"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Sqld Primary URL</FormLabel>
										<FormControl>
											<Input
												placeholder="https://<primary-app-name>:5001"
												autoComplete="off"
												disabled={!canEdit}
												{...field}
											/>
										</FormControl>
										<FormDescription>
											The Internal Replication Connection URL from the primary's
											page.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							{canEdit && (
								<div className="flex justify-end">
									<Button type="submit" isLoading={isPending}>
										Save
									</Button>
								</div>
							)}
						</form>
					</Form>
				</CardContent>
			</Card>
		</div>
	);
};
