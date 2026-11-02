#!/usr/bin/env bash
# Deletes old GHCR versions of the AgentHits image. Kept: every version tagged
# agenthits-vX.Y.Z, agenthits-dev, agenthits-stable or buildcache, the newest KEEP_RECENT other
# versions, and every manifest a kept image index points at (GHCR lists the
# platform manifests of an index as separate untagged versions, and deleting
# them breaks the tagged image).
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN must be a token of the package owner with read:packages and delete:packages}"
owner="${PACKAGE_OWNER:-agentHits}"
package="${PACKAGE_NAME:-dokploy}"
image="${IMAGE:-ghcr.io/agenthits/dokploy}"
keep_recent="${KEEP_RECENT:-10}"
dry_run="${DRY_RUN:-true}"
api="users/${owner}/packages/container/${package}/versions"

versions="$(gh api --paginate "${api}?per_page=100" | jq -s 'add // []')"

plan="$(jq --argjson keep "$keep_recent" '
	def protected:
		(.metadata.container.tags // [])
		| any(. == "agenthits-dev" or . == "agenthits-stable" or . == "buildcache" or test("^agenthits-v[0-9]+\\.[0-9]+\\.[0-9]+$"));
	sort_by(.created_at) | reverse
	| map(select(protected | not)) as $rest
	| {keep: (map(select(protected)) + $rest[:$keep]), delete: $rest[$keep:]}
' <<<"$versions")"

if ! jq -e 'any(.keep[]; (.metadata.container.tags // []) | index("agenthits-dev"))' <<<"$plan" >/dev/null; then
	echo "::error::No version tagged agenthits-dev in the listing of ${owner}/${package}; refusing to delete anything."
	exit 1
fi

work_dir="$(mktemp -d)"
: >"${work_dir}/children"
while read -r digest; do
	docker buildx imagetools inspect --raw "${image}@${digest}" >"${work_dir}/manifest.json"
	jq -r '.manifests[]?.digest' "${work_dir}/manifest.json" >>"${work_dir}/children"
done < <(jq -r '.keep[].name' <<<"$plan")
children="$(jq -R . "${work_dir}/children" | jq -s 'unique')"
delete="$(jq --argjson children "$children" '.delete | map(select(.name as $d | $children | index($d) | not))' <<<"$plan")"

echo "Versions: $(jq length <<<"$versions"), keeping $(($(jq length <<<"$versions") - $(jq length <<<"$delete"))), deleting $(jq length <<<"$delete") (dry run: ${dry_run})."

failed=0
while IFS=$'\t' read -r id digest created tags; do
	label="${id} ${digest} ${created} ${tags:-<untagged>}"
	if [ "$dry_run" = true ]; then
		echo "would delete ${label}"
	elif gh api -X DELETE "${api}/${id}" >/dev/null; then
		echo "deleted ${label}"
	else
		echo "::warning::could not delete ${label}"
		failed=$((failed + 1))
	fi
done < <(jq -r '.[] | [.id, .name, .created_at, ((.metadata.container.tags // []) | join(","))] | @tsv' <<<"$delete")

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo "## GHCR retention for ${owner}/${package}"
		echo
		echo "Dry run: ${dry_run}. Versions listed: $(jq length <<<"$versions"), to delete: $(jq length <<<"$delete"), failed: ${failed}."
		echo
		echo "Kept tags: $(jq -r '[.keep[].metadata.container.tags // [] | .[]] | join(", ")' <<<"$plan")"
	} >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$failed" != 0 ]; then
	echo "::error::${failed} version(s) could not be deleted"
	exit 1
fi
