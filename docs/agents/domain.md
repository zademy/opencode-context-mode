# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context

This is a single-context repo — two root vocabularies and one `docs/adr/` at the root. There is no `GLOSSARY-MAP.md` and no per-package `src/<context>/` split.

`CONTEXT.md` and `GLOSSARY.md` cover different vocabulary and both apply. Read whichever fits the area, and read both when naming a concept could land in either.

```
/
├── CONTEXT.md                            ← platform vocabulary (Platform, Adapter, …)
├── GLOSSARY.md                           ← product vocabulary (Dashboard, Insight, Report, …)
├── docs/
│   ├── adr/
│   │   ├── 0001-sessiondb-multi-writer.md
│   │   ├── 0002-tool-description-style.md
│   │   ├── 0003-routing-deny-reasons.md
│   │   ├── 0004-stats-strict-compression-formula.md
│   │   └── 0005-dashboard-ephemeral-local-server.md
│   └── agents/
└── src/
```

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: platform vocabulary — Platform, Adapter, and the rest.
- **`GLOSSARY.md`** at the repo root: product vocabulary — Dashboard, Insight, Report, Capture, Rescue bytes, Avoided/Returned tokens.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. The five existing ADRs cover session DB multi-writer behaviour, MCP tool description style, routing deny reasons, the stats strict-compression formula, and the Dashboard's ephemeral local server.

If either vocabulary file does not exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md` or `GLOSSARY.md`. Don't drift to synonyms the glossaries explicitly avoid.

If the concept you need isn't in either glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
