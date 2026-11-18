# Using Kunla

This guide is for everyone on the team: you don't need to write code to use Kunla. If you work with AI assistants (Claude, ChatGPT-style chats, coding agents), Kunla is where their work and yours is recorded, and where they ask you for decisions.

**Contents:** [The idea](#the-idea-in-one-minute) · [Words Kunla uses](#words-kunla-uses) · [The screens](#the-screens) · [Statuses](#what-a-tasks-status-means) · [A typical day](#a-typical-day) · [Reviews and rules](#reviewing-work-and-teaching-rules) · [Waiting and assumptions](#waiting-on-other-work-and-assumptions) · [Steering](#steering-what-gets-done-first) · [Continuous mode](#continuous-mode-letting-an-ai-work-through-a-list) · [Examples](#examples-by-team) · [FAQ](#faq)

## The idea in one minute

- Your AIs do a lot of work across many chats and tools, and most of it is invisible to the rest of the team. Kunla keeps **one record** of that work.
- AIs **update the record themselves**: they say what they are working on, log progress, and hand in results. You don't fill in a tracker.
- You get **one place for decisions**: approve or send back work, answer questions, accept or decline proposals.
- Every piece of work has a **key** like `MKT-42`. AIs put it in documents, messages and code, so anything can be traced back to the task and the chat that produced it.
- All kinds of work count: research, writing, outreach, discussions, design, analysis and planning, not only code.

## Words Kunla uses

| Word | Meaning |
|---|---|
| **Workspace** | A separate area with its own people, AIs, projects and rules, for example "Work", "Startup" and "Community". Nothing crosses between workspaces. |
| **Project** | A group of related tasks with a short key, like `MKT` for marketing. Optional: a task can sit straight in the workspace. A project can be ongoing or have an end date. |
| **Task** | One piece of work with a key (`MKT-42`), a brief (what and why), acceptance criteria, a holder, results and a full history. |
| **Sub-task** | A smaller piece of a task. When the last sub-task is done, its task is done too. |
| **Member** | A person or an AI. Each AI connection is its own member with a **sponsor**: the person responsible for it. |
| **Kind** | What sort of work a task is: code, writing, research, learning, discussion, outreach, design, operations or other. Your workspace can set its own list. |
| **Deliverable** | The result: a link to a document, slides, a sheet, a pull request, or written-out notes. |
| **Rule** | Something every AI is told on every future task in a project, often taught from a review ("always cite sources"). |
| **Playbook** | A project's standing instructions for anyone working in it. |

## The screens

| Screen | What it's for |
|---|---|
| **Briefing** (home) | What happened while you were away, then the decisions waiting on you one at a time, who is working on what right now, the one thing holding up the most work, and the rules every AI follows. Start here. |
| **Tasks** | Every task, grouped by project, person or status, with quick filters (Mine, Stuck, Done this week) and saved views. Use **Select to hand over** to give several tasks to a person or an AI at once. |
| **Map** | The work as a picture. *Timeline* shows a lane per person and AI (or per project or kind, with **Lanes by**) with work, waiting and decisions; *Relations* shows what waits on what. |
| **Projects** | Projects and their settings: focus, ranking, end dates, playbooks, and whether a person must review work. |
| **Team** | People and AIs, what each is doing, each AI's track record, **Connect an agent**, **Use in claude.ai**, and continuous mode limits. |
| **Task page** | Open any task (click it, or press ⌘K / Ctrl+K and type its key) to see the brief, history, results, the chats that worked on it, and to change its status or move it to another project. |

Press **⌘K** (Ctrl+K on Windows) anywhere to jump to a task or hand out work in one line, for example "Delegate: draft the Q3 newsletter to Claude".

Kunla works on a phone too, and can be installed like an app (the **Install** button at the bottom of the page).

## What a task's status means

| Status | Meaning | Who moves it on |
|---|---|---|
| **Proposed** | An AI suggested it. | A person **accepts** (it becomes Ready) or **declines** it. Proposals nobody looks at for 14 days close themselves. |
| **Ready** | Accepted and waiting to be picked up. | Anyone, person or AI, claims it, unless it names who should. |
| **In progress** | Someone claimed it and is working on it. | The holder. An AI that goes quiet for 30 minutes loses it back to Ready. |
| **Waiting on an answer** | The holder asked a question and can't go on until someone answers. | Whoever answers from the Briefing. |
| **In review** | Handed in, waiting for a person to look. | The reviewer approves or sends it back. |
| **Done** | Approved and finished. | |
| **Later** | A person put it off on purpose. AIs leave it alone until someone brings it back. | A person. |
| **Declined** | A person said no to the proposal. | |

You can set any status from the task page's status picker.

## A typical day

1. **Open the Briefing.** Read what changed since you last looked.
2. **Go through your decisions.** For each one: approve, send back with a reason, answer a question, or accept/decline a proposal. Each takes a click or a sentence.
3. **Hand out new work.** Create a task (or use ⌘K "Delegate"), or just ask your AI in its chat; it files the task in Kunla itself.
4. **Let the AIs work.** They claim tasks, log progress and hand in results. You don't need to update anything.
5. **Check in when you want.** The Briefing, Map and Tasks pages refresh by themselves while open.

You can also stay in your AI chat: ask Claude "what's waiting on me in Kunla?" or "show project status for MKT" and it shows the same views inside the chat (see [Connect your AI](connect-ai.md)).

## Reviewing work and teaching rules

When an AI hands in work, it lands in your decisions with its results.

- **Approve** when it's good. If the result is a pull request, approving can also merge it.
- **Send back** when it isn't: say what was wrong. Tick **apply next time** to turn your comment into a project **rule**, which every AI gets with every future task in that project. This is how the team gets better without you repeating yourself.

A project can require a person's review before anything counts as done. AIs then can't mark work done themselves in that project.

## Waiting on other work, and assumptions

Sometimes a task can't go on until something else happens.

- **Waiting on** can be another task (`MKT-12`), a link (a pull request) or a condition in words ("budget approved"). A waiting task is skipped when AIs look for work, and it moves on by itself when the other task finishes or the PR merges. Conditions in words are ticked by a person or an AI.
- **Assumptions:** instead of waiting, an AI can carry on with a stated assumption ("Assuming the export is CSV"). You confirm or correct it from your decisions; a correction sends the work back with your answer.
- **The bottleneck:** the Briefing names the one thing holding up the most work, and flags promises that went quiet for two days.
- **Map → Relations** draws it all: what has to happen first on the left, what waits on it to the right.

## Steering what gets done first

- **Focus:** mark projects as focus and rank them on the Projects page. AIs are offered focused work first.
- **Lanes:** pick the projects each member works on (the **Works on** pills on its Team card), so an AI for marketing doesn't pick up finance work.
- **Assign:** name who should do a task, or hand over a batch from Tasks. Assigned work always comes before open work.
- **Later:** park a task to keep AIs away from it.

## Continuous mode: letting an AI work through a list

When Ready tasks pile up, the Briefing and the Tasks page offer to **let one of your AIs work through them**. It then takes tasks one by one without anyone handing them out, asks questions where it must, and moves on to the next task while it waits for answers.

You set the limits before starting, all optional: new tasks per day (10 by default), how many may wait for your review before it pauses (5 by default), cost or tokens per day, and an end time. A limit stops new work only; the AI always finishes what it holds. The Team page shows whether each AI is running or why it stopped. Only the AI's sponsor or an admin can change these settings.

In a Claude chat, start it by saying "Work through my Kunla tasks". In Claude Code, run `/kunla:work`.

## Examples by team

- **Marketing:** a project `MKT`. Ask Claude to "draft three LinkedIn posts for the launch, file it in Kunla". It creates `MKT-14`, logs the drafts as a deliverable and sends them for review. You approve one and tick *apply next time* on "no exclamation marks".
- **Sales:** a project `SAL` for account research. An AI in continuous mode works through "research ACME", "research Globex"... and hands each in as notes with sources. The Briefing shows which are done.
- **Data:** an analysis task waits on "Q3 data export ready". The AI carries on with "Assuming Q3 means July–September"; you confirm it from your decisions.
- **Management:** open the Briefing once a day. It is the stand-up: what got done, what is stuck, what needs you.

## FAQ

**Do I have to update tasks myself?** No. AIs record their own work. You make decisions; people can also update tasks on the task page when they want to.

**Does Kunla run the AI?** No. Your AIs (Claude, Claude Code and others) run where they always do, with your own accounts. Kunla is the shared record they report to.

**Can I see the chat that produced a result?** Yes. AIs pass a link to their chat or session; the task page lists every chat that worked on it.

**What if two AIs pick the same task?** They can't. A task has one holder at a time; the other gets something else.

**Who can see what?** Everyone in a workspace sees that workspace. Nothing is shared across workspaces.

**Can I move a task to another project?** Yes, from the task page. It takes a new key there, and the old key keeps working in links and documents.

**Where is my data?** Wherever your team runs Kunla: your own Cloudflare account (see [Self-hosting](self-hosting.md)) or Kunla Cloud. An admin can download everything at any time.
