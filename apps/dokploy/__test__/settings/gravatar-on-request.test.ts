import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { GravatarOption } from "@/components/dashboard/settings/profile/gravatar-option";
import { Form, FormField } from "@/components/ui/form";
import { RadioGroup } from "@/components/ui/radio-group";
import { getAvatarType, getGravatarUrl } from "@/lib/avatar-utils";

const appRoot = path.resolve(__dirname, "../..");
const clientSources = ["components", "hooks", "lib", "pages", "utils"].flatMap(
	(dir) =>
		readdirSync(path.join(appRoot, dir), { recursive: true, encoding: "utf8" })
			.filter((file) => /\.tsx?$/.test(file))
			.map((file) => path.join(dir, file)),
);

const currentGravatar = getGravatarUrl("a".repeat(64));
const previousGravatar = getGravatarUrl("b".repeat(64));

type AvatarForm = { image: string };

const Option = ({
	value,
	gravatarUrl,
	hashPending,
}: {
	value: string;
	gravatarUrl: string | null;
	hashPending?: boolean;
}) => {
	const form = useForm<AvatarForm>({ defaultValues: { image: value } });
	return createElement(Form<AvatarForm>, {
		...form,
		children: createElement(FormField<AvatarForm, "image">, {
			control: form.control,
			name: "image",
			render: ({ field }) =>
				createElement(
					RadioGroup,
					{ value: getAvatarType(field.value) },
					createElement(GravatarOption, {
						value: field.value,
						gravatarUrl,
						hashPending,
					}),
				),
		}),
	});
};

const render = (
	value: string,
	gravatarUrl: string | null,
	hashPending?: boolean,
) =>
	renderToStaticMarkup(
		createElement(Option, { value, gravatarUrl, hashPending }),
	);

describe("Gravatar option on the Profile page", () => {
	it.each([
		["no avatar", ""],
		["a bundled avatar", "/avatars/avatar-1.png"],
		["an uploaded avatar", "data:image/png;base64,AAAA"],
		["a solid color", "#336699"],
	])("offers the option without an image request for %s", (_, value) => {
		const html = render(value, currentGravatar);

		expect(html).toContain(`value="${currentGravatar}"`);
		expect(html).toContain('data-state="unchecked"');
		expect(html).not.toContain("<img");
	});

	it("shows the image once the Gravatar is the avatar", () => {
		const html = render(currentGravatar, currentGravatar);

		expect(html).toContain(`<img src="${currentGravatar}"`);
		expect(html).toContain('data-state="checked"');
	});

	it("keeps showing a saved Gravatar of a previous email and offers the current one", () => {
		const html = render(previousGravatar, currentGravatar);

		expect(html).toContain(`<img src="${previousGravatar}"`);
		expect(html).toContain(`value="${currentGravatar}"`);
		expect(html).toContain('data-state="unchecked"');
	});

	it("keeps showing a saved Gravatar where the browser cannot compute the hash", () => {
		const html = render(currentGravatar, null);

		expect(html).toContain(`<img src="${currentGravatar}"`);
		expect(html).toContain('data-state="checked"');
	});

	it("renders nothing without a hash and without a saved Gravatar", () => {
		expect(render("/avatars/avatar-1.png", null)).not.toContain('role="radio"');
	});

	it("holds the option's place while the hash is computed, with no request and no selectable value", () => {
		const html = render("/avatars/avatar-1.png", null, true);

		expect(html).toContain('role="radio"');
		expect(html).toContain("disabled");
		expect(html).not.toContain("gravatar.com");
		expect(html).not.toContain("<img");
	});

	it("builds the Gravatar URL in one place, so the avatar list cannot request it on render", () => {
		const withUrl = clientSources.filter((file) =>
			readFileSync(path.join(appRoot, file), "utf8").includes("gravatar.com/"),
		);

		expect(withUrl).toEqual([path.join("lib", "avatar-utils.ts")]);
	});
});
