---
name: open_ctx-insight
description: |
  Open the open-context-mode Insight dashboard in your default browser.
  Insight is the hosted analytics layer for AI-assisted engineering teams —
  per-engineer productive rate, retry waste, blocker detection, role-narrowed views.
  Trigger: /open-context-mode:open_ctx-insight
user-invocable: true
---

# Open Context Mode Insight

Open the hosted Insight dashboard in the user's default browser.

## Instructions

1. Call the `open_ctx_insight` MCP tool (no parameters). It opens
   <https://open-context-mode.com/insight> in the default browser and returns a
   confirmation line.
2. Display the tool's output to the user.
3. Tell the user:
   - "Insight opened at https://open-context-mode.com/insight"
   - The landing page at open-context-mode.com/insight is the single source of truth for sign-in and pricing details.
   - If the browser did not open automatically, share the URL so they can open it manually.
