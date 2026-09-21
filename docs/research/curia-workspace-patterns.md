# Agent workspace patterns for Curia

Research date: September 21, 2026.

Research ticket: [What can conversation-led and attention-led agent workspaces teach Curia?](https://github.com/alp82/curia/issues/1018).

This note supplies evidence for comparing two prototypes. It doesn't choose a design. The operator prioritizes broad work with agents, plan management, and roadmap shaping. Review remains available but comes later. The redesign must preserve ongoing work, history, and a map overview.

## Findings

Conversation and attention serve different moments of work. The sources support keeping a durable conversation for an outcome and exposing activity across conversations. Neither pattern alone establishes how Curia should represent a full plan, its decisions, or roadmap changes. That remains a design question for the operator.

### Conversations organized around outcomes

OpenAI's current documentation groups related chats, files, instructions, and sources into projects. It recommends a separate chat for each distinct outcome. Chats and projects can be pinned, searched, renamed, and archived. A self-contained task can start without a project. Local projects and uploaded project context have different access semantics. These are documented behaviors, not evidence that their exact navigation fits Curia. [Projects and chats](https://learn.chatgpt.com/docs/projects)

Design inference: compare a workspace whose primary content is a conversation tied to an outcome. Keep its plan and outputs reachable without requiring transcript search. Let the operator start exploratory work before classifying every detail. Preserve a clear distinction between organizing work and granting access.

### Direct controls beside conversation

OpenAI documents long-running goals with an explicit outcome, constraints, and completion criteria. The desktop progress row supports pause, resume, edit, and clear. Follow-up messages can steer running work. A side chat can request a recap without interrupting the main conversation. Independent chats can run concurrently; coding work needs appropriate isolation. [Long-running work](https://learn.chatgpt.com/docs/long-running-work)

Design inference: chat should complement visible controls. A prototype should make the active objective, current state, and pause or resume action recognizable without composing a message. Changes to the objective should remain inspectable after the conversation moves on.

### Attention as a view of ongoing work

OpenAI documents an Activity view, where available, for unread chats, running chats, and chats awaiting a response. Filters vary by surface. Completion notifications have separate controls from permission and question notifications. [Notifications](https://learn.chatgpt.com/docs/notifications)

Linear's Inbox separates Priority notifications from other updates. Opening an item exposes its issue and actions in context. Notification snoozing and issue reminders are distinct: a reminder doesn't hide its issue. [Linear Inbox](https://linear.app/docs/inbox)

Design inference: an attention-led prototype can show work that needs a decision alongside active efforts and the next useful action. It needn't become a review queue. Keep unread, needs input, blocked, and completed distinct. Reading or dismissing a notification mustn't imply that its underlying work is complete.

### Broad work can start from an outcome

Anthropic documents Cowork creating a plan, dividing complex tasks, coordinating parallel work when appropriate, and delivering previewable or downloadable outputs. The operator can steer during a task. These patterns apply to work beyond code review. [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)

Anthropic also documents a gradual merger of Chat and Cowork into one conversation. The system determines whether a request needs a quick response or a task. The documentation says availability differs during rollout. [Claude Cowork and chat are one Claude](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)

Design inference: test one entry point that accepts an unfinished idea, a question, or executable work. Show the resulting work state explicitly. Avoid making a new operator choose an agent execution category before describing the outcome. This is a hypothesis for Curia, not a decision to remove setup or permissions.

### Continuity across devices

Anthropic documents opening the same Cowork session across surfaces to check progress, answer questions, redirect work, and obtain output. Local resources can still require the desktop app to remain open. Availability differs across surfaces and project types. [Use Claude Cowork on web, desktop, and mobile](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)

Design inference: use the same work identity and conversation on desktop and phone. The phone can emphasize intervention and resumption while retaining access to context. A control should explain unavailable capabilities through the affected task, rather than suggesting that every action runs everywhere.

### Roadmap context needs its own structure

Linear documents initiative and project updates as a health indicator plus explanatory text. Initiative updates connect high-level goals to contributing projects; project updates describe individual efforts. The latest update appears in the overview, while previous updates remain accessible. [Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)

Design inference: Curia can keep a readable plan summary beside detailed work and retain a history of decisions. A useful overview should explain intent, current structure, and changes, rather than relying on counts. The cited agent workspace pages don't establish a full-plan dependency visualization or a persistent roadmap decision model. That is a gap in this research coverage, not proof that those products lack such capabilities.

## What to compare in prototypes

Use the same realistic work and states in both alternatives. These are proposed evaluation tasks, not implementation requirements.

1. Start an ambiguous roadmap idea and develop it with an agent into a plan.
2. Find a paused effort, recover its objective and latest decision, and continue it.
3. Move among several active agents without losing the selected plan or conversation.
4. Change a plan's scope and identify which ongoing work the change affects.
5. Open the full map, understand completed and remaining work, and return to the same conversation.
6. Answer an agent's question on a phone with enough context to make the decision.
7. Inspect a prototype or other non-code output, request a change, and later find the result.
8. Review completed work without letting review dominate starting and shaping work.

The conversation-led alternative should prioritize the selected outcome and its conversation, with persistent access to plans, artifacts, and other active work. The attention-led alternative should prioritize ongoing efforts and specific next actions, with direct entry into the same conversations and plans. Keep both alternatives capable of all eight tasks.

Observe whether the operator can identify the active objective, find context, predict an action's effect, and recover after switching work. Compare hesitation and unnecessary navigation. Don't infer the winning design from the number of features visible on the first screen.

## Limits and uncertainties

This is documentation research, not hands-on usability testing. Product documentation describes intended behavior and doesn't establish usability, reliability, or feature availability in the operator's account. OpenAI's former Codex app documentation redirects to ChatGPT Learn. Several pages combine surface-specific instructions; shortcut details are not stable enough to copy blindly. Anthropic explicitly describes a gradual rollout.

The local repository search found earlier agent-tool research, but no current first-party product documentation suitable for this comparison. External claims therefore use the eight first-party sources linked here. No claims depend on third-party reviews or community reports.

These sources don't decide Curia's canonical work objects, map layout, navigation hierarchy, visual style, integration requirements, or component library. They provide interaction patterns for the live prototype comparison. The operator must still choose which experience supports daily work best.
