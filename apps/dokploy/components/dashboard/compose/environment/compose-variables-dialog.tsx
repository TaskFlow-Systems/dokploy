import { FileCode, Loader2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
	type ComposeEnvEntry,
	formatEnvValue,
	readComposeEnvState,
} from "@/lib/compose-env";
import { api } from "@/utils/api";

export interface ComposeEnvImport {
	entries: ComposeEnvEntry[];
	active: boolean;
	header: string[];
}

interface Props {
	composeId: string;
	currentEnv: string;
	createEnvFile: boolean;
	// Runs before the dialog opens; returning false keeps it closed.
	beforeOpen: () => Promise<boolean>;
	onImport: (changes: ComposeEnvImport) => void;
}

const compareWithEnv = (
	stateOf: ReturnType<typeof readComposeEnvState>,
	name: string,
	value: string,
) => {
	const state = stateOf(name);
	const listedValue = state.kind === "listed" ? state.value.trim() : null;
	return {
		state: state.kind,
		listedValue,
		changed: listedValue !== null && listedValue !== formatEnvValue(value),
	};
};

export const ComposeVariablesDialog = ({
	composeId,
	currentEnv,
	createEnvFile,
	beforeOpen,
	onImport,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [isPreparing, setIsPreparing] = useState(false);
	const [filter, setFilter] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [active, setActive] = useState(false);
	const { mutateAsync, data, error, isPending, reset } =
		api.compose.loadComposeVariables.useMutation();
	// beforeOpen may reveal the environment, which arrives after load() began.
	const currentEnvRef = useRef(currentEnv);
	currentEnvRef.current = currentEnv;

	const rows = useMemo(() => {
		const stateOf = readComposeEnvState(currentEnv);
		return (data?.variables ?? []).map((variable) => {
			const value = variable.defaultValue ?? "";
			return {
				...variable,
				value,
				...compareWithEnv(stateOf, variable.name, value),
			};
		});
	}, [data, currentEnv]);

	const visibleRows = useMemo(() => {
		const query = filter.trim().toLowerCase();
		if (!query) {
			return rows;
		}
		return rows.filter(
			(row) =>
				row.name.toLowerCase().includes(query) ||
				row.services.some((service) => service.toLowerCase().includes(query)),
		);
	}, [rows, filter]);

	const selectableRows = visibleRows.filter((row) => row.state !== "set");
	const setCount = rows.filter((row) => row.state === "set").length;

	const load = async () => {
		setSelected(new Set());
		try {
			const result = await mutateAsync({ composeId });
			const stateOf = readComposeEnvState(currentEnvRef.current);
			setSelected(
				new Set(
					result.variables
						.filter((variable) => {
							const { state, changed } = compareWithEnv(
								stateOf,
								variable.name,
								variable.defaultValue ?? "",
							);
							return state === "absent" || changed;
						})
						.map((variable) => variable.name),
				),
			);
		} catch {
			// The error is shown in the dialog.
		}
	};

	const handleOpenChange = async (open: boolean) => {
		if (!open) {
			setIsOpen(false);
			setFilter("");
			reset();
			return;
		}
		setIsPreparing(true);
		try {
			if (!(await beforeOpen())) {
				return;
			}
		} finally {
			setIsPreparing(false);
		}
		setIsOpen(true);
		await load();
	};

	const toggleRow = (name: string, checked: boolean) => {
		setSelected((previous) => {
			const next = new Set(previous);
			if (checked) {
				next.add(name);
			} else {
				next.delete(name);
			}
			return next;
		});
	};

	const allVisibleSelected =
		selectableRows.length > 0 &&
		selectableRows.every((row) => selected.has(row.name));

	const toggleAllVisible = () => {
		setSelected((previous) => {
			const next = new Set(previous);
			for (const row of selectableRows) {
				if (allVisibleSelected) {
					next.delete(row.name);
				} else {
					next.add(row.name);
				}
			}
			return next;
		});
	};

	const handleImport = () => {
		if (!data) {
			return;
		}
		const source = `${data.composePath}${data.branch ? ` (branch ${data.branch})` : ""}`;
		onImport({
			entries: rows
				.filter((row) => row.state !== "set" && selected.has(row.name))
				.map(({ name, value, services }) => ({ name, value, services })),
			active,
			header: active
				? [`Values copied from ${source}.`]
				: [
						`Defaults from ${source}.`,
						"Lines starting with # are not applied: remove the # and change the value to override a default.",
					],
		});
		handleOpenChange(false);
	};

	const selectedCount = rows.filter(
		(row) => row.state !== "set" && selected.has(row.name),
	).length;

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<Button
				type="button"
				variant="outline"
				size="sm"
				isLoading={isPreparing}
				onClick={() => handleOpenChange(true)}
			>
				<FileCode className="mr-2 size-4" />
				Variables from compose
			</Button>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Variables from the compose file</DialogTitle>
					<DialogDescription>
						{data
							? `Variables used in ${data.composePath}${data.branch ? ` on branch ${data.branch}` : ""}, with the value the file falls back to while a variable is not set here.`
							: "Fetching the compose file from the source selected in General."}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					{!createEnvFile && (
						<AlertBlock type="warning">
							Create Environment File is off, so variables set here do not reach
							the compose file until it is turned on.
						</AlertBlock>
					)}

					{isPending || (!data && !error) ? (
						<div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" />
							Fetching the compose file...
						</div>
					) : error ? (
						<div className="flex flex-col items-center gap-3 py-8 text-sm">
							<span className="text-destructive">{error.message}</span>
							<Button type="button" variant="outline" size="sm" onClick={load}>
								Try again
							</Button>
						</div>
					) : rows.length === 0 ? (
						<div className="py-8 text-center text-muted-foreground text-sm">
							The compose file does not use any variables.
						</div>
					) : (
						<>
							<div className="text-muted-foreground text-sm">
								{rows.length} variables: {setCount} set here,{" "}
								{rows.length - setCount} use the default from the file.
							</div>
							<Input
								placeholder="Filter by variable or service"
								value={filter}
								onChange={(event) => setFilter(event.target.value)}
							/>
							<div className="flex items-center justify-between">
								<Label className="flex items-center gap-2">
									<Checkbox
										checked={allVisibleSelected}
										onCheckedChange={toggleAllVisible}
										disabled={selectableRows.length === 0}
									/>
									Select all
								</Label>
								<span className="text-muted-foreground text-sm">
									{selectedCount} selected
								</span>
							</div>
							<ScrollArea className="h-96 rounded-md border">
								<div className="flex flex-col divide-y">
									{visibleRows.map((row) => (
										<div key={row.name} className="flex items-start gap-3 p-3">
											<Checkbox
												id={`compose-variable-${row.name}`}
												className="mt-0.5"
												checked={row.state !== "set" && selected.has(row.name)}
												disabled={row.state === "set"}
												onCheckedChange={(checked) =>
													toggleRow(row.name, checked === true)
												}
											/>
											<div className="flex min-w-0 flex-1 flex-col gap-1">
												<div className="flex flex-wrap items-center gap-2">
													<label
														htmlFor={`compose-variable-${row.name}`}
														className="font-mono text-sm"
													>
														{row.name}
													</label>
													{row.state === "set" && (
														<Badge variant="green">set here</Badge>
													)}
													{row.state === "listed" && !row.changed && (
														<Badge variant="secondary">listed</Badge>
													)}
													{row.changed && (
														<Badge variant="yellow">default changed</Badge>
													)}
													{row.secret && <Badge variant="orange">secret</Badge>}
													{row.placeholder && (
														<Badge variant="red">placeholder</Badge>
													)}
													{row.required && (
														<Badge variant="red">required</Badge>
													)}
													{row.conflictingDefaults && (
														<Badge variant="yellow">defaults differ</Badge>
													)}
												</div>
												<span className="break-all font-mono text-muted-foreground text-xs">
													{row.defaultValue === null
														? "no default"
														: row.defaultValue === ""
															? "empty by default"
															: `default: ${row.defaultValue}`}
												</span>
												{row.changed && (
													<span className="break-all font-mono text-muted-foreground text-xs">
														listed here as: {row.listedValue}
													</span>
												)}
												{row.services.length > 0 && (
													<span className="text-muted-foreground text-xs">
														Used by {row.services.join(", ")}
													</span>
												)}
												{row.placeholder && (
													<span className="text-destructive text-xs">
														The default from the file is a placeholder. Set your
														own value.
													</span>
												)}
											</div>
										</div>
									))}
								</div>
							</ScrollArea>
						</>
					)}

					<div className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
						<div className="space-y-0.5">
							<Label htmlFor="compose-variables-active">
								Add as active lines
							</Label>
							<p className="text-muted-foreground text-xs">
								{active
									? "Values are copied as they are and override the file, so later changes to the defaults in the repository no longer apply."
									: "Lines are added commented out (# NAME=value): the defaults from the file keep applying, and you override one by removing its #. Adding again refreshes the commented values."}
							</p>
						</div>
						<Switch
							id="compose-variables-active"
							checked={active}
							onCheckedChange={setActive}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						type="button"
						onClick={handleImport}
						disabled={!data || selectedCount === 0}
					>
						Add {selectedCount > 0 ? selectedCount : ""} variable
						{selectedCount === 1 ? "" : "s"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
