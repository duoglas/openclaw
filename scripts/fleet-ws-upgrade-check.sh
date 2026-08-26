#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/fleet-ws-upgrade-check.sh status [options]
  scripts/fleet-ws-upgrade-check.sh dry-run-light [options]
  scripts/fleet-ws-upgrade-check.sh dry-run-full [options]

Options:
  --source PATH          Source checkout to inspect (default: repository root)
  --maintenance-ref REF Maintenance commit to inspect (default: HEAD)
  --upstream-ref REF    Upstream commit/ref already present in source
                         (default: refs/remotes/origin/main)
  --artifact-dir PATH   Write candidate archive and SHA-256 manifest here
  --keep-workdir        Keep the isolated checkout for inspection

Exit codes for status: 0=current, 3=stale, 1=invalid/error.
Dry-run modes clone and rebase only in a temporary checkout. They never fetch,
checkout, rebase, reset, install, build, or restart in the source checkout.
EOF
}

fail() {
  printf 'error=%s\n' "$*" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
default_source="$(cd -- "${script_dir}/.." && pwd -P)"
mode="${1:-}"
[[ -n "$mode" ]] || {
  usage >&2
  exit 1
}
shift

source_root="$default_source"
maintenance_ref="HEAD"
upstream_ref="refs/remotes/origin/main"
artifact_dir=""
keep_workdir=0

while (($#)); do
  case "$1" in
    --source)
      (($# >= 2)) || fail "--source requires a path"
      source_root="$2"
      shift 2
      ;;
    --maintenance-ref)
      (($# >= 2)) || fail "--maintenance-ref requires a ref"
      maintenance_ref="$2"
      shift 2
      ;;
    --upstream-ref)
      (($# >= 2)) || fail "--upstream-ref requires a ref"
      upstream_ref="$2"
      shift 2
      ;;
    --artifact-dir)
      (($# >= 2)) || fail "--artifact-dir requires a path"
      artifact_dir="$2"
      shift 2
      ;;
    --keep-workdir)
      keep_workdir=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$mode" in
  status|dry-run-light|dry-run-full) ;;
  *)
    usage >&2
    fail "unknown mode: $mode"
    ;;
esac

source_root="$(cd -- "$source_root" && pwd -P)"
git -C "$source_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "source is not a Git checkout: $source_root"

maintenance_oid="$(git -C "$source_root" rev-parse --verify "${maintenance_ref}^{commit}")" ||
  fail "maintenance ref is not a commit: $maintenance_ref"
upstream_oid="$(git -C "$source_root" rev-parse --verify "${upstream_ref}^{commit}")" ||
  fail "upstream ref is not a commit: $upstream_ref"
source_head="$(git -C "$source_root" rev-parse HEAD)"
source_branch="$(git -C "$source_root" symbolic-ref --quiet --short HEAD || printf 'detached')"
source_status="$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)"

if git -C "$source_root" merge-base --is-ancestor "$upstream_oid" "$maintenance_oid"; then
  freshness="current"
  freshness_exit=0
else
  freshness="stale"
  freshness_exit=3
fi

print_status() {
  printf 'mode=status\n'
  printf 'source=%s\n' "$source_root"
  printf 'source_branch=%s\n' "$source_branch"
  printf 'source_head=%s\n' "$source_head"
  printf 'source_clean=%s\n' "$([[ -z "$source_status" ]] && printf true || printf false)"
  printf 'maintenance_ref=%s\n' "$maintenance_ref"
  printf 'maintenance_oid=%s\n' "$maintenance_oid"
  printf 'upstream_ref=%s\n' "$upstream_ref"
  printf 'upstream_oid=%s\n' "$upstream_oid"
  printf 'state=%s\n' "$freshness"
}

if [[ "$mode" == "status" ]]; then
  print_status
  exit "$freshness_exit"
fi

[[ -z "$source_status" ]] ||
  fail "source checkout is dirty; commit or use a separate clean checkout before dry-run"

source_status_before="$source_status"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-fleet-ws-upgrade.XXXXXX")"
isolated_checkout="${work_root}/candidate"
cleanup() {
  local exit_code="$?"
  local head_after status_after
  head_after="$(git -C "$source_root" rev-parse HEAD 2>/dev/null || printf missing)"
  status_after="$(git -C "$source_root" status --porcelain=v1 --untracked-files=all 2>/dev/null || printf missing)"
  if [[ "$head_after" != "$source_head" || "$status_after" != "$source_status_before" ]]; then
    printf 'error=source checkout changed during isolated dry run\n' >&2
    printf 'source_head_before=%s\nsource_head_after=%s\n' "$source_head" "$head_after" >&2
    exit_code=1
  fi
  if ((keep_workdir)); then
    printf 'kept_workdir=%s\n' "$work_root"
  else
    rm -rf -- "$work_root"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

printf 'mode=%s\n' "$mode"
printf 'isolated_checkout=%s\n' "$isolated_checkout"
printf 'source_head=%s\n' "$source_head"
printf 'upstream_oid=%s\n' "$upstream_oid"
printf 'initial_state=%s\n' "$freshness"

git clone --quiet --no-hardlinks -- "$source_root" "$isolated_checkout"
git -C "$isolated_checkout" config user.name "OpenClaw Fleet Upgrade Check"
git -C "$isolated_checkout" config user.email "fleet-upgrade-check@example.invalid"
git -C "$isolated_checkout" checkout --quiet --detach "$maintenance_oid"

merge_base="$(git -C "$isolated_checkout" merge-base "$maintenance_oid" "$upstream_oid")"
if [[ "$merge_base" != "$upstream_oid" ]]; then
  git -C "$isolated_checkout" rebase --onto "$upstream_oid" "$merge_base" "$maintenance_oid"
fi
candidate_oid="$(git -C "$isolated_checkout" rev-parse HEAD)"
candidate_tree="$(git -C "$isolated_checkout" rev-parse 'HEAD^{tree}')"
printf 'candidate_oid=%s\n' "$candidate_oid"
printf 'candidate_tree=%s\n' "$candidate_tree"

cd -- "$isolated_checkout"
corepack enable
pnpm install --frozen-lockfile

runtime_tests=(
  packages/ai/src/transports/openai-responses-websocket-client.test.ts
  packages/ai/src/transports/openai-responses-websocket.test.ts
  packages/model-catalog-core/src/model-catalog-normalize.test.ts
  src/agents/ai-transport-runtime-host.websocket.test.ts
  src/agents/sessions/model-registry.test.ts
)
pnpm test "${runtime_tests[@]}"
pnpm build:plugin-sdk:dts
node scripts/run-tsgo.mjs -p tsconfig.core.json

if [[ "$mode" == "dry-run-full" ]]; then
  pnpm build
fi

archive_sha256="$(git archive --format=tar HEAD | shasum -a 256 | cut -d ' ' -f 1)"
printf 'candidate_archive_sha256=%s\n' "$archive_sha256"

if [[ -n "$artifact_dir" ]]; then
  mkdir -p -- "$artifact_dir"
  archive_path="${artifact_dir}/openclaw-fleet-ws-${candidate_oid}.tar"
  manifest_path="${artifact_dir}/openclaw-fleet-ws-${candidate_oid}.sha256"
  git archive --format=tar --output="$archive_path" HEAD
  printf '%s  %s\n' "$archive_sha256" "$(basename -- "$archive_path")" >"$manifest_path"
  printf 'artifact=%s\n' "$archive_path"
  printf 'artifact_manifest=%s\n' "$manifest_path"
fi

printf 'result=pass\n'
