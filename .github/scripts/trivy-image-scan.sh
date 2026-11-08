#!/usr/bin/env bash
# Scans an image with Trivy ($TRIVY_IMAGE) for critical and high
# vulnerabilities, writes them to the job summary and fails when one of them
# already has a fixed version. Findings listed in .trivyignore.yaml are shown
# as ignored and do not fail the job.
#
# Usage: trivy-image-scan.sh IMAGE [trivy image flags...]
# Run from the repository root; flags such as --image-src pass through.
set -euo pipefail

image="$1"
shift

report_dir="$(mktemp -d)"
report="${report_dir}/trivy.json"
summary="${report_dir}/summary.md"

# Only a scan of a local image (--image-src docker) needs the Docker socket.
socket=()
case " $* " in
*" --image-src docker "*) socket=(-v /var/run/docker.sock:/var/run/docker.sock) ;;
esac

docker run --rm "${socket[@]}" -v "$PWD:/src:ro" -v "${report_dir}:/report" -w /src \
	"$TRIVY_IMAGE" image --scanners vuln --severity CRITICAL,HIGH \
	--ignorefile .trivyignore.yaml --show-suppressed \
	--format json --output /report/trivy.json --no-progress \
	"$@" "$image"

count() {
	jq "[.Results[]?.Vulnerabilities[]? | select($1)] | length" "$report"
}

by_severity() {
	jq -r "[.Results[]?.Vulnerabilities[]? | select($1)] as \$v
		| \"critical \([\$v[] | select(.Severity == \"CRITICAL\")] | length), high \([\$v[] | select(.Severity == \"HIGH\")] | length)\"" "$report"
}

rows() {
	jq -r ".Results[]? as \$r | [\$r.Vulnerabilities[]? | select($1)]
		| sort_by(.Severity != \"CRITICAL\", .PkgName, .VulnerabilityID)[]
		| \"| \(.Severity) | \(.VulnerabilityID) | \(.PkgName) | \(.InstalledVersion) | \(.FixedVersion // \"\") | \(\$r.Target) |\"" "$report"
}

fixed='(.FixedVersion // "") != ""'
unfixed='(.FixedVersion // "") == ""'
fixable_count="$(count "$fixed")"
# A new build fixes these: the base stage takes every Debian update of the day.
os_fixable_count="$(jq "[.Results[]? | select(.Class == \"os-pkgs\") | .Vulnerabilities[]? | select($fixed)] | length" "$report")"
unfixed_count="$(count "$unfixed")"
ignored_count="$(jq '[.Results[]?.ExperimentalModifiedFindings[]? | select(.Status == "ignored")] | length' "$report")"
header='| Severity | ID | Package | Installed | Fixed in | Target |
|---|---|---|---|---|---|'

{
	echo "### \`${image}\`"
	echo
	echo "- With a fix: $(by_severity "$fixed")"
	echo "- Without a fix yet: $(by_severity "$unfixed")"
	echo "- Ignored by \`.trivyignore.yaml\`: ${ignored_count}"
	echo
	if [ "$fixable_count" -gt 0 ]; then
		echo "$header"
		rows "$fixed"
		echo
	fi
	if [ "$ignored_count" -gt 0 ]; then
		echo "<details><summary>Ignored (${ignored_count})</summary>"
		echo
		echo "| Severity | ID | Package | Target | Reason |"
		echo "|---|---|---|---|---|"
		jq -r '.Results[]? as $r | $r.ExperimentalModifiedFindings[]? | select(.Status == "ignored")
			| "| \(.Finding.Severity) | \(.Finding.VulnerabilityID) | \(.Finding.PkgName) | \($r.Target) | \(.Statement // "") |"' "$report"
		echo
		echo "</details>"
		echo
	fi
	if [ "$unfixed_count" -gt 0 ]; then
		echo "<details><summary>Without a fix yet (${unfixed_count})</summary>"
		echo
		echo "$header"
		rows "$unfixed"
		echo
		echo "</details>"
		echo
	fi
} >"$summary"

cat "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	cat "$summary" >>"$GITHUB_STEP_SUMMARY"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
	echo "os-fixable=${os_fixable_count}" >>"$GITHUB_OUTPUT"
fi

if [ "$fixable_count" -gt 0 ]; then
	echo "::error::${image}: ${fixable_count} critical or high vulnerabilities have a fix; update the image or the tool, or list the finding in .trivyignore.yaml with an expiry date."
	exit 1
fi
