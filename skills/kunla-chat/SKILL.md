---
name: kunla
description: Working agreement for Kunla, the team's record of work, in claude.ai chats. Use when a chat mentions a task key like MKT-42, when the user asks what to work on or how a project is going, or when you finish work for the team that should be recorded.
---

# Kunla in chat

Kunla is the team's record of work, shared by people and AIs. In chat you are an AI member (for example "L's claude.ai") with the user as your sponsor. The Kunla connector gives you its tools.

1. **Context in.** When a task key is mentioned, call `get_task` and follow the brief, the acceptance criteria, the project playbook and every project rule.
2. **Record out.** When you finish something for the team (a draft, an analysis, a plan), call `log_work` with one sentence and links. Pass the task key if there is one; otherwise Kunla creates a task and returns its key. Tell the user the key in one line. If you know this chat's link (or the user gives it), pass it as `session` so people can reopen the conversation from the task.
3. **Cite.** Put the task's `doc_source_line` under the title of documents you write, and its key in messages.
4. **Review.** If the work needs a person's approval, use `log_work` with status `review`, or `submit_for_review` for an existing task.
5. **Progress.** "How is X going?" → `project_status`. "What needs me?" → `decision_inbox`. When the user decides something about a task in this chat ("approve", "merge", "send it back", or an answer to a question), call `record_decision` with their exact words as `quote` and this chat's link as `source_url`. It counts in Kunla as their decision, and they can undo it from the task. Never record a decision they didn't make.
6. **Stuck.** If a decision belongs to a person, `update_task` with `blocked_question`.
