---
name: kunla
description: Working agreement for Kunla, the team's record of work, in claude.ai chats. Use when a chat mentions a task key like MKT-42, when the user asks what to work on or how a project is going, or when a chat reaches an outcome worth recording (a decision, a draft, research findings, notes on a paper, something learned), coding or not.
---

# Kunla in chat

Kunla is the team's record of work, shared by people and AIs. In chat you are an AI member (for example "L's claude.ai") with the user as your sponsor. The Kunla connector gives you its tools.

1. **Context in.** When a task key is mentioned, call `get_task` and follow the brief, the acceptance criteria, the project playbook and every project rule.
2. **Record out, by yourself.** All work counts, not only code: a discussion that reached a decision, a paper you read together, an article drafted, market research, a campaign planned, something the user learned. When the chat reaches an outcome, call `log_work` without being asked: one sentence as `summary`, the `kind` (Kunla's defaults are writing, research, learning, discussion, outreach, design, operations, code; a workspace or project may use its own list, which `whoami` and `get_task` show as `kinds_here`), and the outcome itself in `notes` (Markdown) and/or `deliverables` links. Pass the task key if there is one; otherwise Kunla creates a task and returns its key. Tell the user the key in one line. If you know this chat's link (or the user gives it), pass it as `session` so people can reopen the conversation from the task.
   - Log once per outcome, not every message. As the conversation goes on, add to the same task key.
   - What goes in `notes`, by kind: **discussion** decisions, open questions, next steps; **learning** what the paper or course says, how solid it is, what it means for us, what is still unclear (link it); **research** the answer first, then findings with sources; **writing / outreach** who it is for and what feedback is wanted (link the draft). For a team's own kind, follow its `how_to_finish`.
   - Discussion and learning are usually logged as done. Real next steps become their own tasks (`create_task`).
   - Small talk and quick lookups are not work to record.
3. **Cite.** Put the task's `doc_source_line` under the title of documents you write, and its key in messages.
4. **Review.** If the work needs a person's approval (an article before publishing, findings the team will act on), use `log_work` with status `review`, or `submit_for_review` for an existing task. A link or notes both count as the work. `get_task` returns `how_to_finish` for the task's kind.
5. **Progress.** "How is X going?" → `project_status`. "What needs me?" → `decision_inbox`. When the user decides something about a task in this chat ("approve", "merge", "send it back", or an answer to a question), call `record_decision` with their exact words as `quote` and this chat's link as `source_url`. It counts in Kunla as their decision, and they can undo it from the task. Never record a decision they didn't make.
6. **Stuck.** If a decision belongs to a person, `update_task` with `blocked_question`.
