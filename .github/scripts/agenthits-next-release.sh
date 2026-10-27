#!/usr/bin/env bash
# Picks the next agenthits-vX.Y.Z tag for HEAD and writes release notes from
# every pull request merged since the previous tag. Collecting the whole range,
# not only the PR of this push, keeps a change in the next release when a run
# was dropped from the concurrency queue or failed before publishing.
#
# The owner wants one version per batch of work, not one per merged PR: a push
# releases only once RELEASE_EVERY changes (first-parent commits, one per merged
# PR) have piled up since the previous tag, and earlier pushes get an image
# without a release. A manual run releases whatever is pending.
#
# Outputs (GITHUB_OUTPUT): build, tag, previous, title, notes.
set -euo pipefail

: "${REPO:?REPO (owner/name) is required}"
: "${GITHUB_OUTPUT:?}"
bump="${BUMP:-auto}"
event="${EVENT:-push}"
release_every="${RELEASE_EVERY:-20}"
base_branch="${BASE_BRANCH:-AgentHits-Dev}"
image="${IMAGE:-ghcr.io/agenthits/dokploy}"
work_dir="$(mktemp -d)"

previous="$(git tag -l 'agenthits-v*' --sort=-v:refname |
	grep -E '^agenthits-v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"

if [ -z "$previous" ]; then
	echo "::warning::No agenthits-vX.Y.Z tag exists yet, so this push gets an image but no release. Publish agenthits-v1.0.0 to start the release line."
	echo "build=true" >>"$GITHUB_OUTPUT"
	exit 0
fi

pending="$(git rev-list --count --first-parent "${previous}..HEAD")"
if [ "$pending" = 0 ]; then
	echo "Nothing to release: HEAD has no commits after ${previous}."
	echo "build=false" >>"$GITHUB_OUTPUT"
	exit 0
fi

if [ "$event" = push ] && [ "$pending" -lt "$release_every" ]; then
	waiting="${pending} of ${release_every} changes since ${previous}: image only, the release waits for a full batch or a manual run."
	echo "$waiting"
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		echo "$waiting" >>"$GITHUB_STEP_SUMMARY"
	fi
	echo "build=true" >>"$GITHUB_OUTPUT"
	exit 0
fi

: >"${work_dir}/prs.jsonl"
: >"${work_dir}/direct.jsonl"
while read -r sha; do
	pr="$(gh api "repos/${REPO}/commits/${sha}/pulls" |
		jq -c --arg base "$base_branch" \
			'[.[] | select(.merged_at != null and .base.ref == $base)][0] // empty
			| {number, title, body: (.body // ""), url: .html_url}')"
	if [ -n "$pr" ]; then
		printf '%s\n' "$pr" >>"${work_dir}/prs.jsonl"
	else
		jq -nc --arg sha "$sha" --arg title "$(git log -1 --format=%s "$sha")" \
			'{sha: $sha, title: $title}' >>"${work_dir}/direct.jsonl"
	fi
done < <(git rev-list --first-parent --reverse "${previous}..HEAD")

prs="$(jq -s 'reduce .[] as $pr ([]; if any(.[]; .number == $pr.number) then . else . + [$pr] end)' "${work_dir}/prs.jsonl")"
direct="$(jq -s '.' "${work_dir}/direct.jsonl")"

if [ "$bump" = auto ]; then
	if jq -e -n --argjson prs "$prs" --argjson direct "$direct" \
		'any($prs[], $direct[]; .title | startswith("feat"))' >/dev/null; then
		bump="minor"
	else
		bump="patch"
	fi
fi

IFS=. read -r major minor patch <<<"${previous#agenthits-v}"
case "$bump" in
major) major=$((major + 1)) minor=0 patch=0 ;;
minor) minor=$((minor + 1)) patch=0 ;;
patch) patch=$((patch + 1)) ;;
*)
	echo "::error::Unknown bump '${bump}', expected auto, patch, minor or major"
	exit 1
	;;
esac
tag="agenthits-v${major}.${minor}.${patch}"

title="AgentHits Dokploy ${tag#agenthits-}"
if [ "$(jq -n --argjson prs "$prs" --argjson direct "$direct" '($prs | length) + ($direct | length)')" = 1 ]; then
	title="${title} — $(jq -rn --argjson prs "$prs" --argjson direct "$direct" '($prs + $direct)[0].title')"
fi

notes="${work_dir}/notes.md"
{
	jq -r '.[] | "## \(.title) ([#\(.number)](\(.url)))\n\n\(.body | sub("\\s+$"; ""))\n"' <<<"$prs"
	if [ "$(jq length <<<"$direct")" != 0 ]; then
		echo "## Коммиты без pull request"
		echo
		jq -r --arg repo "$REPO" '.[] | "- \(.title) ([`\(.sha[:12])`](https://github.com/\($repo)/commit/\(.sha)))"' <<<"$direct"
		echo
	fi
	echo "---"
	echo
	echo "Образ: \`${image}:${tag}\`"
	echo
	echo "Все изменения с ${previous}: https://github.com/${REPO}/compare/${previous}...${tag}"
} >"$notes"

delimiter="NOTES_$(openssl rand -hex 16)"
{
	echo "build=true"
	echo "tag=${tag}"
	echo "previous=${previous}"
	echo "title=${title}"
	echo "notes<<${delimiter}"
	cat "$notes"
	echo "${delimiter}"
} >>"$GITHUB_OUTPUT"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo "## ${title}"
		echo
		echo "${previous} → ${tag} (${bump})"
		echo
		cat "$notes"
	} >>"$GITHUB_STEP_SUMMARY"
fi
echo "Next release: ${tag} (${bump} after ${previous})"
