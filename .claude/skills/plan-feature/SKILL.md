---
name: plan-feature
description: Turn a feature idea into a GitHub epic plus small, labelled, agent-assigned child issues. Use when the user describes something new to build.
argument-hint: <feature idea>
---

Plan this feature for `arvindjonn09/tax-invoice`: **$ARGUMENTS**

1. Check existing issues for overlap: `gh issue list --state all --search "<keywords>"`.
2. Use the `product-analyst` agent to write user stories + acceptance criteria
   (`docs/requirements/`). If it reports blocking open questions, ask the user before continuing.
3. If there are technical or regulatory unknowns, use `research-dev` and/or `domain-expert`.
4. Use the `architect` agent to design it and split it into implementation tasks.
5. Make sure the result on GitHub is: one `type:epic` issue with a task checklist linking each
   child issue; each child has `agent:*`, `type:*`, `priority:*`, `status:ready`, acceptance
   criteria, and "Part of #<epic>" / "Depends on #<n>" lines.
6. Report the epic link, the child issues in dependency order, and any open questions.
