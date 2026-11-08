#!/bin/sh
# usage: github-release-asset.sh <owner/repo> <tag> <asset> <output file>
#
# github.com/<repo>/releases/download can answer 504 for hours, from every
# network alike, while the API keeps serving the same files. So the API is the
# fallback, and a file it serves must match the digest GitHub records for it.
set -eu

repo="$1"
tag="$2"
asset="$3"
out="$4"
web="${GITHUB_RELEASE_WEB:-https://github.com}"
api="${GITHUB_RELEASE_API:-https://api.github.com}"
retries="${GITHUB_RELEASE_RETRIES:-3}"

if curl -fsSL --retry "$retries" --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 300 \
	-o "$out" "$web/$repo/releases/download/$tag/$asset"; then
	exit 0
fi
echo "github-release-asset: $asset could not be downloaded from github.com, trying the GitHub API" >&2

meta="$(mktemp)"
trap 'rm -f "$meta"' EXIT
set --
if [ -n "${GITHUB_TOKEN:-}" ]; then
	set -- -H "Authorization: Bearer $GITHUB_TOKEN"
fi
curl -fsSL --retry "$retries" --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 60 "$@" \
	-H "Accept: application/vnd.github+json" -o "$meta" \
	"$api/repos/$repo/releases/tags/$tag"

# Every image that runs this has Node in its base, and so does CI.
found="$(ASSET="$asset" node -e '
	const release = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
	const item = (release.assets ?? []).find((a) => a.name === process.env.ASSET);
	if (item) console.log(`${item.url} ${item.digest ?? ""}`);
' "$meta")"
if [ -z "$found" ]; then
	echo "github-release-asset: release $tag of $repo has no asset $asset" >&2
	exit 1
fi
url="${found%% *}"
digest="${found#* }"

curl -fsSL --retry "$retries" --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 300 "$@" \
	-H "Accept: application/octet-stream" -o "$out" "$url"

case "$digest" in
sha256:*)
	if [ "$(sha256sum "$out" | cut -d " " -f 1)" != "${digest#sha256:}" ]; then
		rm -f "$out"
		echo "github-release-asset: $asset does not match its digest $digest" >&2
		exit 1
	fi
	;;
*)
	echo "github-release-asset: GitHub records no digest for $asset, so it is not checked" >&2
	;;
esac
