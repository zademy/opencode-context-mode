#!/usr/bin/env bash
# Coordinator preflight for a lane branch, then merge it into main.
#
#   ./scripts/merge-lane.sh lane-pi-omp
#
# Refuses to merge a lane that:
#   - committed a *.bundle.mjs (the coordinator regenerates bundles centrally;
#     two lanes touching the same minified single-line bundle is an unresolvable
#     merge)
#   - baked an absolute machine path into a repo file
#   - touched docs/backlog/issue-review.md or pr-review.md (shared, coordinator-owned)
#   - touched package.json or a plugin manifest (release is coordinator-owned)
#   - has uncommitted work

# Re-exec under bash when started by a POSIX sh: this script relies on
# bash-only features (`set -o pipefail`, `${SHELLOPTS#*posix}`) that POSIX sh
# cannot run (mksglu/open-context-mode#1242). See scripts/open_ctx-debug.sh for the full
# rationale.
if [ -z "${BASH_VERSION:-}" ] || [ "${SHELLOPTS#*posix}" != "${SHELLOPTS:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  printf '%s: bash is required (invoked by a POSIX sh without bash)\n' "$0" >&2
  exit 127
fi

set -euo pipefail

LANE="${1:?usage: merge-lane.sh <branch>}"
ROOT="/Volumes/HIKSEMI/GitHub/open-context-mode"
cd "$ROOT"

fail=0
note() { printf '%s\n' "$*"; }
bad() { printf 'BLOQUEO: %s\n' "$*"; fail=1; }

note "== preflight $LANE =="

if ! git rev-parse --verify "$LANE" >/dev/null 2>&1; then
  bad "la rama $LANE no existe"
  exit 1
fi

COMMITS=$(git log --oneline "main..$LANE" | wc -l | tr -d ' ')
note "commits por delante de main: $COMMITS"
if [ "$COMMITS" = "0" ]; then
  note "nada que mergear"
  exit 0
fi

CHANGED=$(git diff --name-only "main...$LANE")

# 1. bundles
if printf '%s\n' "$CHANGED" | grep -q '\.bundle\.mjs$'; then
  bad "el carril commiteo bundles (deben regenerarse centralmente):"
  printf '%s\n' "$CHANGED" | grep '\.bundle\.mjs$'
fi

# 2. rutas absolutas de ESTA maquina (un fixture /Users/example/... en un test
#    es legitimo; filtrar /home/tester o /opt/... lo que no vale es el home y el
#    volumen reales, que es lo que se hornea sin querer en hooks.json/configs)
HOME_ABS="${HOME:-}"
REPO_ABS="$(cd "$(dirname "$0")/.." && pwd)"
ABS=$(git diff "main...$LANE" -- . | grep -E '^\+' | grep -E -F -e "$HOME_ABS" -e "${REPO_ABS%%/open-context-mode*}" || true)
if [ -n "$ABS" ]; then
  bad "el carril escribio rutas absolutas de esta maquina ($HOME_ABS / volumen del repo):"
  printf '%s\n' "$ABS" | head -10
fi

# 3. archivos del coordinador
if printf '%s\n' "$CHANGED" | grep -qE '^docs/backlog/(issue-review|pr-review)\.md$'; then
  bad "el carril toco el ledger compartido (issue-review.md / pr-review.md)"
fi

# 4. version / manifests
if printf '%s\n' "$CHANGED" | grep -qE '(^package\.json$|plugin\.json$|openclaw\.plugin\.json$|^\.pi/extensions/open-context-mode/package\.json$)'; then
  bad "el carril toco package.json o un manifest de plugin (release es del coordinador):"
  printf '%s\n' "$CHANGED" | grep -E '(^package\.json$|plugin\.json$|openclaw\.plugin\.json$)'
fi

# 5. hooks.json horneado
if printf '%s\n' "$CHANGED" | grep -qx 'hooks/hooks.json'; then
  note "AVISO: el carril cambio hooks/hooks.json — revisa que no tenga rutas absolutas"
  git diff "main...$LANE" -- hooks/hooks.json | grep -E '^\+' | grep -E '/(Users|Volumes)/' && \
    bad "hooks/hooks.json lleva rutas absolutas"
fi

if [ "$fail" = "1" ]; then
  note ""
  note "NO se mergeo. Corrige el carril o mergea a mano lo legitimo."
  exit 1
fi

note "preflight OK"
note ""
note "== merge $LANE -> main =="
git merge --no-ff "$LANE" -m "merge(lane): $LANE ($COMMITS commits)"

note ""
note "commits de la lane que ahora estan en main:"
git log --oneline -1
