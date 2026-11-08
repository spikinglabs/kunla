---
description: Work through Ready Kunla tasks one by one until Kunla says stop
argument-hint: [project key]
---
Work through Kunla tasks without stopping to ask me between them (project `$ARGUMENTS` if given):

1. Call `next_task`. If it returns no task, or `continuous.go` is false, tell me in one line why it stopped (its message) and stop.
2. Otherwise `claim_task` it (skip it and go back to step 1 if someone else holds it), read its brief, criteria, rules and handoff, and do the work.
3. Finish with `submit_for_review` and the deliverable (for code: a PR, with the task key in the title and commit trailer). Pass `tokens` and/or `cost_usd` for this task if you know them; they count toward the daily limits.
4. If you need a person's answer, `update_task` with `blocked_question` and move on: a question on one task is not a reason to stop.
5. Go back to step 1.

The line under each Kunla reply says how much of today's budget is left. When it says to stop, finish the task you hold and stop.
