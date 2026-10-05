---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Where to save it:
- If the working directory is a project folder (any folder the user chose; not an app-made scratch workspace, whose path contains `/scratch-workspaces/`), save it to `<project>/.claude/handoffs/handoff-YYYY-MM-DD-HHMM.md`, creating the folder if needed. A new session in that project offers it for resumption.
- Otherwise save it to the temporary directory of the user's OS.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
