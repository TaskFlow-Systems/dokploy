import { CheckIcon, ChevronsUpDown, FileCode } from "lucide-react";
import type * as React from "react";
import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const normalizePath = (path: string) =>
	path.trim().replace(/^\.\//, "").toLowerCase();

interface Props
	extends Pick<
		React.ComponentProps<"input">,
		"id" | "aria-describedby" | "aria-invalid"
	> {
	value: string;
	onChange: (value: string) => void;
	onBlur?: () => void;
	name?: string;
	files?: string[];
	isLoading?: boolean;
	// Shown instead of the list while there is no branch to read files from.
	hint?: string;
	placeholder?: string;
}

export const ComposePathInput = ({
	value,
	onChange,
	onBlur,
	name,
	files,
	isLoading,
	hint,
	placeholder = "docker-compose.yml",
	...inputProps
}: Props) => {
	const [open, setOpen] = useState(false);
	// null until the user types, so a field that already holds a path still
	// lists every file when it is opened.
	const [query, setQuery] = useState<string | null>(null);
	// -1 keeps Enter submitting the form until a file is picked with the
	// arrows or the mouse.
	const [highlighted, setHighlighted] = useState(-1);
	const anchorRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const visibleFiles =
		query === null || !query.trim()
			? (files ?? [])
			: (files ?? []).filter((file) =>
					normalizePath(file).includes(normalizePath(query)),
				);

	const openList = () => {
		setQuery(null);
		setHighlighted(-1);
		setOpen(true);
	};

	const select = (file: string) => {
		onChange(file);
		setOpen(false);
		setQuery(null);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverAnchor asChild>
				<div ref={anchorRef} className="relative">
					<Input
						{...inputProps}
						ref={inputRef}
						name={name}
						value={value}
						placeholder={placeholder}
						autoComplete="off"
						role="combobox"
						aria-expanded={open}
						aria-autocomplete="list"
						className="pr-9"
						onFocus={openList}
						onBlur={() => {
							setOpen(false);
							onBlur?.();
						}}
						onChange={(event) => {
							onChange(event.target.value);
							setQuery(event.target.value);
							setHighlighted(-1);
							setOpen(true);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								setOpen(false);
								return;
							}
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								if (!open) {
									openList();
									return;
								}
								const step = event.key === "ArrowDown" ? 1 : -1;
								const count = visibleFiles.length;
								if (count > 0) {
									setHighlighted((current) =>
										current === -1
											? step === 1
												? 0
												: count - 1
											: (current + step + count) % count,
									);
								}
								return;
							}
							if (event.key === "Enter" && open) {
								const file = visibleFiles[highlighted];
								if (file) {
									event.preventDefault();
									select(file);
								}
							}
						}}
					/>
					<button
						type="button"
						tabIndex={-1}
						aria-label="Show compose files"
						className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
						onMouseDown={(event) => {
							// Keeps focus in the input, so its blur does not close the list
							// right before this toggles it.
							event.preventDefault();
							if (open) {
								setOpen(false);
							} else {
								inputRef.current?.focus();
								openList();
							}
						}}
					>
						<ChevronsUpDown className="h-4 w-4 opacity-50" />
					</button>
				</div>
			</PopoverAnchor>
			<PopoverContent
				align="start"
				className="w-[var(--radix-popover-trigger-width)] p-1"
				onOpenAutoFocus={(event) => event.preventDefault()}
				onInteractOutside={(event) => {
					if (anchorRef.current?.contains(event.target as Node)) {
						event.preventDefault();
					}
				}}
				onMouseDown={(event) => event.preventDefault()}
			>
				{hint ? (
					<p className="px-2 py-3 text-center text-sm text-muted-foreground">
						{hint}
					</p>
				) : isLoading ? (
					<p className="px-2 py-3 text-center text-sm text-muted-foreground">
						Loading compose files...
					</p>
				) : visibleFiles.length === 0 ? (
					<p className="px-2 py-3 text-center text-sm text-muted-foreground">
						{files?.length
							? "No matching files. The typed path will be used."
							: "No compose files found in this branch. Type the path."}
					</p>
				) : (
					<ScrollArea className={cn(visibleFiles.length > 8 && "h-72")}>
						<div role="listbox">
							{visibleFiles.map((file, index) => (
								<div
									key={file}
									role="option"
									tabIndex={-1}
									aria-selected={index === highlighted}
									className={cn(
										"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
										index === highlighted && "bg-accent text-accent-foreground",
									)}
									onMouseEnter={() => setHighlighted(index)}
									onClick={() => select(file)}
								>
									<FileCode className="h-4 w-4 shrink-0 opacity-60" />
									<span className="truncate">{file}</span>
									<CheckIcon
										className={cn(
											"ml-auto h-4 w-4 shrink-0",
											normalizePath(file) === normalizePath(value)
												? "opacity-100"
												: "opacity-0",
										)}
									/>
								</div>
							))}
						</div>
					</ScrollArea>
				)}
			</PopoverContent>
		</Popover>
	);
};
