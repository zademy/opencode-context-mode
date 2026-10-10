# Kubernetes resource not found

- **Level:** error · **Stack:** kubernetes
- **Event ID:** `d6c93328-719b-4da6-ae88-529b6cea0750`
- **Time:** 2026-10-10T21:58:36.600Z
- **Release (git):** `2e7c422345e0`
- **Environment (branch):** main
- **Command:** `cd /Volumes/HIKSEMI/GitHub/opencode-context-mode && cat hooks/routing-block.mjs`


---

## Summary

The resource does not exist in the current context/namespace.

1. Check context: `kubectl config current-context`.
2. Try with `-n <namespace>` or `--all-namespaces`.


---

## Context

- **OS:** Darwin 27.0.0 (arm64)
- **Runtime:** node 26.3.0
- **Worktree:** /Volumes/HIKSEMI/GitHub/opencode-context-mode
- **cwd:** /Volumes/HIKSEMI/GitHub/opencode-context-mode
- **Git:** main @ 2e7c422345e0
- **opencode:** 2.0.26 · agent=build


---

## Breadcrumbs

| time | tool | status | command |
| --- | --- | --- | --- |
| 21:56:58 | execute | completed | `` |
| 21:57:28 | execute | completed | `` |
| 21:57:30 | execute | completed | `` |
| 21:57:32 | shell | completed | `cd /Volumes/HIKSEMI/GitHub/opencode-context-mode/skills && …` |
| 21:57:37 | shell | completed | `cd /Volumes/HIKSEMI/GitHub/opencode-context-mode/skills && …` |
| 21:58:33 | shell | completed | `cd /Volumes/HIKSEMI/GitHub/opencode-context-mode && ls -la …` |
| 21:58:34 | shell | completed | `cd /Volumes/HIKSEMI/GitHub/opencode-context-mode && echo "#…` |


---

## Frequency

- **Occurrences:** 1
- **First seen:** 2026-10-10T21:58:36.600Z
- **Last seen:** 2026-10-10T21:58:36.600Z
- **Fingerprint:** `c79bfa14eeae194f…`
