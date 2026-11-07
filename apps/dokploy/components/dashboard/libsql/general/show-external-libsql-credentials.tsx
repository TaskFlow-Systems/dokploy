import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import Link from "next/link";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { ToggleVisibilityInput } from "@/components/shared/toggle-visibility-input";
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
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDatabaseCredentials } from "@/hooks/use-database-credentials";
import {
	buildLibsqlGrpcUrl,
	buildLibsqlUrl,
} from "@/lib/database-connection-url";
import { api } from "@/utils/api";

const DockerProviderSchema = z.object({
	externalPort: z.preprocess((a) => {
		if (a === null || a === undefined || a === "") return null;
		const parsed = Number.parseInt(String(a), 10);
		return Number.isNaN(parsed) ? null : parsed;
	}, z
		.number()
		.gte(0, "Range must be 0 - 65535")
		.lte(65535, "Range must be 0 - 65535")
		.nullable()),
	externalGRPCPort: z.preprocess((a) => {
		if (a === null || a === undefined || a === "") return null;
		const parsed = Number.parseInt(String(a), 10);
		return Number.isNaN(parsed) ? null : parsed;
	}, z
		.number()
		.gte(0, "Range must be 0 - 65535")
		.lte(65535, "Range must be 0 - 65535")
		.nullable()),
	externalAdminPort: z.preprocess((a) => {
		if (a === null || a === undefined || a === "") return null;
		const parsed = Number.parseInt(String(a), 10);
		return Number.isNaN(parsed) ? null : parsed;
	}, z
		.number()
		.gte(0, "Range must be 0 - 65535")
		.lte(65535, "Range must be 0 - 65535")
		.nullable()),
});

type DockerProvider = z.infer<typeof DockerProviderSchema>;

interface Props {
	libsqlId: string;
}
export const ShowExternalLibsqlCredentials = ({ libsqlId }: Props) => {
	const { data: ip } = api.settings.getIp.useQuery();
	const { data, refetch } = api.libsql.one.useQuery({ libsqlId });
	const { credentials, reveal } = useDatabaseCredentials(
		"libsql",
		libsqlId,
		data,
	);
	const { mutateAsync, isPending } = api.libsql.saveExternalPorts.useMutation();
	const getIp = data?.server?.ipAddress || ip;

	const form = useForm({
		defaultValues: {},
		resolver: zodResolver(DockerProviderSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				externalPort: data.externalPort,
				externalGRPCPort: data.externalGRPCPort,
				externalAdminPort: data.externalAdminPort,
			});
		}
	}, [form.reset, data, form]);

	const onSubmit = async (values: DockerProvider) => {
		await mutateAsync({
			externalPort: values.externalPort,
			externalGRPCPort: values.externalGRPCPort,
			externalAdminPort: values.externalAdminPort,
			libsqlId,
		})
			.then(async () => {
				toast.success("External port/ports updated");
				await refetch();
			})
			.catch((error: Error) => {
				toast.error(error?.message || "Error saving the external port/ports");
			});
	};

	const connectionUrlFor = (record: typeof data) =>
		record?.externalPort
			? buildLibsqlUrl(record, { host: getIp ?? "", port: record.externalPort })
			: "";
	const connectionUrl = connectionUrlFor(credentials);
	const connectionGRPCUrl = data?.externalGRPCPort
		? buildLibsqlGrpcUrl({ host: getIp ?? "", port: data.externalGRPCPort })
		: "";

	return (
		<div className="flex w-full flex-col gap-5">
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">External Credentials</CardTitle>
					<CardDescription>
						In order to make the database reachable through the internet, you
						must set a port and ensure that the port is not being used by
						another application or database
					</CardDescription>
				</CardHeader>
				<CardContent className="flex w-full flex-col gap-4">
					{!getIp && (
						<AlertBlock type="warning">
							You need to set an IP address in your{" "}
							<Link href="/dashboard/settings/server" className="text-primary">
								{data?.serverId
									? "Remote Servers -> Server -> Edit Server -> Update IP Address"
									: "Web Server -> Server -> Update Server IP"}
							</Link>{" "}
							to fix the database url connection.
						</AlertBlock>
					)}
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="flex flex-col gap-4"
						>
							<div className="grid grid-cols-2 gap-4">
								<div className="col-span-2 space-y-4">
									<FormField
										control={form.control}
										name="externalPort"
										render={({ field }) => (
											<FormItem>
												<FormLabel>External Port (Internet)</FormLabel>
												<FormControl>
													<Input
														placeholder="8080"
														{...field}
														value={field.value as string}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
							</div>
							{!!data?.externalPort && (
								<div className="grid w-full gap-8">
									<div className="flex flex-col gap-3">
										<Label>External Host</Label>
										<ToggleVisibilityInput
											value={connectionUrl}
											resolveValue={async () =>
												connectionUrlFor(await reveal())
											}
											disabled
										/>
									</div>
								</div>
							)}

							<div className="grid grid-cols-2 gap-4">
								<div className="col-span-2 space-y-4">
									<FormField
										control={form.control}
										name="externalAdminPort"
										render={({ field }) => (
											<FormItem>
												<FormLabel>External Admin Port (Internet)</FormLabel>
												<FormControl>
													<Input
														placeholder="5000"
														{...field}
														value={field.value as string}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
							</div>

							{data?.sqldNode !== "replica" && (
								<>
									<div className="grid grid-cols-2 gap-4">
										<div className="col-span-2 space-y-4">
											<FormField
												control={form.control}
												name="externalGRPCPort"
												render={({ field }) => (
													<FormItem>
														<FormLabel>External GRPC Port (Internet)</FormLabel>
														<FormControl>
															<Input
																placeholder="5001"
																{...field}
																value={field.value as string}
															/>
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
										</div>
									</div>
									{!!data?.externalGRPCPort && (
										<div className="grid w-full gap-8">
											<div className="flex flex-col gap-3">
												<Label>External GRPC Host</Label>
												<Input
													enableCopyButton
													value={connectionGRPCUrl}
													disabled
												/>
												<p className="text-xs text-muted-foreground">
													Only replicas deployed by this panel connect here: the
													port asks for a certificate of the panel.
												</p>
											</div>
										</div>
									)}
								</>
							)}

							<div className="flex justify-end">
								<Button type="submit" isLoading={isPending}>
									Save
								</Button>
							</div>
						</form>
					</Form>
				</CardContent>
			</Card>
		</div>
	);
};
