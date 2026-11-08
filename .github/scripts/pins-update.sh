#!/usr/bin/env bash
# Raises the pinned images and tools to their newest release within the
# allowed range and rewrites every file that repeats the pin
# (component-versions-sync.test.ts checks they agree).
#
# Allowed without review: a newer patch or minor release in the same major
# (for a 0.x tool, only patches of the same minor), and a new digest of the
# same Node tag. Traefik and Redis take patches only: their minor releases
# change defaults of the proxy and the database that run on every server.
# Newer releases outside that range, and every Railpack release (its default
# lives in a database migration), are listed in held.tsv for a manual PR.
#
# Usage: pins-update.sh OUT_DIR   (run from the repository root)
# Writes OUT_DIR/changes.tsv (name, old, new) and OUT_DIR/held.tsv
# (name, current, newer, reason). Needs curl, jq and perl;
# GITHUB_TOKEN, when set, raises the GitHub API rate limit.
set -euo pipefail

out="$1"
mkdir -p "$out"
changes="$out/changes.tsv"
held="$out/held.tsv"
: >"$changes"
: >"$held"

dockerfiles=(Dockerfile Dockerfile.cloud Dockerfile.schedule Dockerfile.server .devcontainer/Dockerfile)
package_jsons=(package.json apps/api/package.json apps/dokploy/package.json apps/schedules/package.json packages/server/package.json)
pins=packages/server/src/setup/component-versions.ts

fetch() {
	curl -fsSL --retry 3 --retry-delay 5 --max-time 60 "$@"
}

# Stable release tags of a GitHub repository, newest first, without PREFIX.
gh_releases() {
	local repo="$1" prefix="$2" auth=()
	if [ -n "${GITHUB_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
	fetch "${auth[@]}" "https://api.github.com/repos/$repo/releases?per_page=15" |
		jq -r --arg p "$prefix" '.[] | select(.draft | not) | select(.prerelease | not) | .tag_name | select(startswith($p)) | ltrimstr($p)'
}

# Tags of a Docker Hub repository whose name contains FILTER.
hub_tags() {
	local repo="$1" filter="$2" url
	url="https://hub.docker.com/v2/repositories/$repo/tags?page_size=100&ordering=last_updated&name=$filter"
	for _ in 1 2 3; do
		[ -n "$url" ] || break
		local page
		page="$(fetch "$url")"
		jq -r '.results[].name' <<<"$page"
		url="$(jq -r '.next // ""' <<<"$page")"
	done
}

stable() { grep -E '^[0-9]+\.[0-9]+(\.[0-9]+)?$' || true; }

newest() { sort -V | tail -n 1; }

# 0 when B is a newer version than A.
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$2" ]; }

# 0 when CANDIDATE is in the range POLICY allows from CURRENT.
in_range() {
	local policy="$1" cur="$2" cand="$3" c_major c_minor n_major n_minor
	IFS=. read -r c_major c_minor _ <<<"$cur"
	IFS=. read -r n_major n_minor _ <<<"$cand"
	[ "$c_major" = "$n_major" ] || return 1
	if [ "$policy" = patch ] || [ "$c_major" = 0 ]; then
		[ "$c_minor" = "$n_minor" ] || return 1
	fi
	return 0
}

# Prints the newest allowed version (or CURRENT) and records anything newer
# outside the range in held.tsv.
pick() {
	local name="$1" policy="$2" cur="$3" candidates allowed=() v top best
	candidates="$(stable | sort -uV)"
	if [ -z "$candidates" ]; then
		echo "::warning::$name: no releases found, keeping $cur" >&2
		echo "$cur"
		return
	fi
	while IFS= read -r v; do
		if newer "$cur" "$v" && in_range "$policy" "$cur" "$v"; then allowed+=("$v"); fi
	done <<<"$candidates"
	best="$cur"
	if [ "${#allowed[@]}" -gt 0 ]; then best="$(printf '%s\n' "${allowed[@]}" | newest)"; fi
	top="$(newest <<<"$candidates")"
	if newer "$best" "$top"; then
		printf '%s\t%s\t%s\t%s\n' "$name" "$best" "$top" "outside the automatic range ($policy)" >>"$held"
	fi
	echo "$best"
}

# replace OLD NEW PERL_PREFIX_REGEX FILE...: the version right after the
# prefix, not followed by more version characters, becomes NEW.
replace() {
	local old="$1" new="$2" prefix="$3"
	shift 3
	OLD="$old" NEW="$new" PREFIX="$prefix" perl -pi -e \
		's/($ENV{PREFIX})\Q$ENV{OLD}\E(?![\w.])/${1}$ENV{NEW}/g' "$@"
}

record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$changes"; }

current_pin() { perl -ne "print \$1 if /^\\s*$1: \"([^\"]+)\"/" "$pins"; }

# Index digest of a Docker Hub tag (the multi-arch digest a FROM pins).
hub_digest() {
	fetch "https://hub.docker.com/v2/repositories/$1/tags/$2" | jq -r '.digest // ""'
}

# Node: newest 26.x trixie-slim image, pinned by its index digest.
node_cur="$(current_pin node)"
node_digest="$(perl -ne 'print $1 if /^FROM node:[\d.]+-trixie-slim@(sha256:[0-9a-f]{64})/' Dockerfile)"
node_new="$(hub_tags library/node trixie-slim | sed -n 's/^\([0-9.]*\)-trixie-slim$/\1/p' | pick node minor "$node_cur")"
node_new_digest="$(hub_digest library/node "${node_new}-trixie-slim")"
if [[ ! "$node_new_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
	echo "::error::node:${node_new}-trixie-slim: no index digest" >&2
	exit 1
fi
if [ "$node_new" != "$node_cur" ] || [ "$node_new_digest" != "$node_digest" ]; then
	OLD="node:${node_cur}-trixie-slim@${node_digest}" NEW="node:${node_new}-trixie-slim@${node_new_digest}" \
		perl -pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "${dockerfiles[@]}"
	if [ "$node_new" != "$node_cur" ]; then
		replace "$node_cur" "$node_new" '"node": "\^' "${package_jsons[@]}"
		replace "$node_cur" "$node_new" '^' .nvmrc
		replace "$node_cur" "$node_new" 'node: "' "$pins"
		record node "$node_cur" "$node_new"
	else
		record "node image digest" "${node_digest:7:12}" "${node_new_digest:7:12}"
	fi
fi

# Bun: the image, the dev container and CI (setup-bun reads packageManager).
bun_cur="$(perl -ne 'print $1 if /bun-v([\d.]+)/' Dockerfile)"
bun_new="$(gh_releases oven-sh/bun bun-v | pick bun minor "$bun_cur")"
if [ "$bun_new" != "$bun_cur" ]; then
	replace "$bun_cur" "$bun_new" 'bun-v' "${dockerfiles[@]}"
	replace "$bun_cur" "$bun_new" '"packageManager": "bun@' "${package_jsons[@]}"
	record bun "$bun_cur" "$bun_new"
fi

# Docker: the CLI in the image (Debian 13) and the engine install-agenthits.sh
# puts on servers (Ubuntu 24.04 by default); the version must exist for both,
# amd64 and arm64.
docker_versions() {
	local dist="$1" codename="$2" package="$3" arch
	for arch in amd64 arm64; do
		fetch "https://download.docker.com/linux/$dist/dists/$codename/stable/binary-$arch/Packages" |
			awk -v p="$package" '$1 == "Package:" { hit = ($2 == p) } hit && $1 == "Version:" { print $2 }' |
			sed -n 's/^5:\([0-9.]*\)-1~.*/\1/p' | sort -u
	done | sort | uniq -d
}
docker_cur="$(current_pin docker)"
docker_new="$(comm -12 <(docker_versions debian trixie docker-ce-cli) <(docker_versions ubuntu noble docker-ce) | pick docker minor "$docker_cur")"
if [ "$docker_new" != "$docker_cur" ]; then
	replace "$docker_cur" "$docker_new" 'ARG DOCKER_VERSION=' Dockerfile
	replace "$docker_cur" "$docker_new" 'DOCKER_VERSION="\$\{DOCKER_VERSION:-' install-agenthits.sh update.sh
	replace "$docker_cur" "$docker_new" 'docker: "' "$pins"
	record docker "$docker_cur" "$docker_new"
fi

rclone_cur="$(current_pin rclone)"
rclone_new="$(gh_releases rclone/rclone v | pick rclone minor "$rclone_cur")"
if [ "$rclone_new" != "$rclone_cur" ]; then
	replace "$rclone_cur" "$rclone_new" 'ARG RCLONE_VERSION=' Dockerfile
	replace "$rclone_cur" "$rclone_new" 'RCLONE_VERSION="\$\{RCLONE_VERSION:-' install-agenthits.sh
	replace "$rclone_cur" "$rclone_new" 'rclone: "' "$pins"
	record rclone "$rclone_cur" "$rclone_new"
fi

nixpacks_cur="$(current_pin nixpacks)"
nixpacks_new="$(gh_releases railwayapp/nixpacks v | pick nixpacks minor "$nixpacks_cur")"
if [ "$nixpacks_new" != "$nixpacks_cur" ]; then
	replace "$nixpacks_cur" "$nixpacks_new" 'ARG NIXPACKS_VERSION=' Dockerfile
	replace "$nixpacks_cur" "$nixpacks_new" 'NIXPACKS_VERSION="\$\{NIXPACKS_VERSION:-' install-agenthits.sh
	replace "$nixpacks_cur" "$nixpacks_new" 'nixpacks: "' "$pins"
	record nixpacks "$nixpacks_cur" "$nixpacks_new"
fi

# pack: the image copies it from buildpacksio/pack, so that tag must exist.
pack_cur="$(current_pin buildpacks)"
pack_new="$(gh_releases buildpacks/pack v | pick pack minor "$pack_cur")"
if [ "$pack_new" != "$pack_cur" ] && [ -n "$(hub_digest buildpacksio/pack "$pack_new")" ]; then
	replace "$pack_cur" "$pack_new" 'buildpacksio/pack:' Dockerfile
	replace "$pack_cur" "$pack_new" 'BUILDPACKS_VERSION="\$\{BUILDPACKS_VERSION:-' install-agenthits.sh
	replace "$pack_cur" "$pack_new" 'buildpacks: "' "$pins"
	record pack "$pack_cur" "$pack_new"
fi

traefik_cur="$(current_pin traefik)"
traefik_new="$(hub_tags library/traefik "v${traefik_cur%%.*}." | sed -n 's/^v//p' | pick traefik patch "$traefik_cur")"
if [ "$traefik_new" != "$traefik_cur" ]; then
	replace "$traefik_cur" "$traefik_new" 'TRAEFIK_IMAGE:-traefik:v' install-agenthits.sh
	replace "$traefik_cur" "$traefik_new" 'traefik: "' "$pins"
	record traefik "$traefik_cur" "$traefik_new"
fi

# Postgres: 18.x minor releases are its patch releases.
postgres_cur="$(current_pin postgres)"
postgres_new="$(hub_tags library/postgres "${postgres_cur%%.*}." | pick postgres minor "$postgres_cur")"
if [ "$postgres_new" != "$postgres_cur" ]; then
	replace "$postgres_cur" "$postgres_new" 'POSTGRES_IMAGE:-postgres:' install-agenthits.sh
	replace "$postgres_cur" "$postgres_new" 'postgres: "' "$pins"
	record postgres "$postgres_cur" "$postgres_new"
fi
if hub_tags library/postgres "$((${postgres_cur%%.*} + 1))." | stable | grep -q .; then
	printf '%s\t%s\t%s\t%s\n' postgres "$postgres_new" "$((${postgres_cur%%.*} + 1)).x" "new major: data directory upgrade" >>"$held"
fi

redis_cur="$(current_pin redis)"
redis_new="$(hub_tags library/redis "${redis_cur%%.*}." | pick redis patch "$redis_cur")"
if [ "$redis_new" != "$redis_cur" ]; then
	replace "$redis_cur" "$redis_new" 'REDIS_IMAGE:-redis:' install-agenthits.sh
	replace "$redis_cur" "$redis_new" 'redis: "' "$pins"
	record redis "$redis_cur" "$redis_new"
fi

# Railpack: the default for new applications is a database migration, and
# mise must follow core/mise/version.txt of the release, so only report it.
railpack_cur="$(current_pin railpack)"
railpack_top="$(gh_releases railwayapp/railpack v | stable | newest)"
if [ -n "$railpack_top" ] && newer "$railpack_cur" "$railpack_top"; then
	printf '%s\t%s\t%s\t%s\n' railpack "$railpack_cur" "$railpack_top" "needs a migration for the default and the matching mise" >>"$held"
fi

echo "Changed:"
cat "$changes"
echo "Held:"
cat "$held"
