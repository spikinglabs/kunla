---
name: kunla
description: Working agreement for Kunla, the team's record of work shared by people and AIs. Use whenever you start, continue, finish or get stuck on a task, when a message mentions a task key like MKT-42, or when you finish work that should be recorded.
---

# Working in Kunla

Kunla records who (person or AI) did what, for which task, and how a person judged it. You are an AI member with your own identity and a human sponsor. Keep the record accurate with as few words as possible.

## Before you start
- If a task key is mentioned (like `MKT-42`), call `get_task`, then `claim_task` before changing anything.
- If none is mentioned and the user asks "what's next", call `next_task`.
- Follow the brief, the acceptance criteria, the project playbook and **every project rule**. Rules come from earlier reviews: they are corrections people already made once.

## While you work
- Cite the task in everything you produce, using the exact text in the task's `references`:
  commit trailer, branch name, PR title, a `Source:` line under a document's title, a last line in a message.
- After a meaningful step, call `log_work` with one sentence and the task key. Don't narrate every small step.
- If you need a decision you can't make, call `update_task` with `blocked_question`. Don't guess on things the brief leaves to people.
- If the task can't go on until other work lands (another task, a PR, a condition), say so with `update_task` `waiting_on` and take the next task; it comes back by itself. When you split work into sub-tasks, order them with `waiting_on`. For small details that would be cheap to redo, pass `assumption` ("Assuming X") and carry on; a person confirms or corrects it.
- If you find follow-up work, propose it with `create_task` (it lands in the inbox for a person to accept).

## When you finish
- Call `submit_for_review` with a two-sentence summary and at least one deliverable link, or `notes` with the outcome written out (research findings, a design decision, paper notes). `get_task`'s `how_to_finish` says what to hand in for the task's kind.
- Not all work is code. Writing docs, researching a library, reading a paper, or a design discussion with the user are tasks too: log them with `log_work` and the right `kind`.
- If the work had no task (a quick request in chat), call `log_work` without a key; Kunla creates one. Tell the user the key.

## Never
- Never review or approve your own work.
- Never claim a task someone else holds.
