# ADR-0016: One key per conversation, and what it carries

**Status**: accepted (2026-08). Not built. The build is charted on [the container map (#309)](https://github.com/alp82/curia/issues/309).
**Provenance**: [The chat and the overseer become one thing, in a container (#301)](https://github.com/alp82/curia/issues/301), [The per-thread conversation key, in detail (#311)](https://github.com/alp82/curia/issues/311)

## Context

[ADR-0014](0014-the-overseer-in-its-own-container.md) states that the overseer keeps one conversation per thread. It left the detail behind that key to its own grilling ticket. [ADR-0015](0015-the-overseer-is-a-service.md) then made the overseer one service, so many conversations pass through one container.

The key is more than a resume handle. In the shipped daemon it keys three things:

1. the resume id, in `store.overseerSessions`
2. the notes that wait for a conversation's next turn, in `addOverseerNote`
3. the one-turn-at-a-time lock, the `busy` set in `overseer.mjs`

So the key is the conversation's identity, and every part of the overseer reads it.

Two facts forced the shape below.

**The transcript is not keyed at all.** Every conversation shares one config dir and one cwd, so all of them write their transcripts into one directory. `findTranscript` takes the newest file by mtime. The Chat screen therefore shows whichever conversation answered last, and a Discord turn hides the browser chat. `readTranscriptMeters` reads that same file, so the context percent on the status line is wrong for the same reason.

**One browser conversation is not enough.** The console chat was one key forever, `console`, and it only grows. A conversation that never ends rots its own context and compacts badly. Discord does not have this problem, because every top-level message opens a thread and starts a fresh conversation.

## Decision

- **A key has two shapes, and they cannot collide.** A Discord conversation is keyed on the thread snowflake, which is all digits. A browser conversation is keyed `console-<n>`, which always starts with a letter.
- **The browser gets many conversations.** `console-1`, `console-2`, and so on. A new browser conversation is the reset, the same way a new Discord thread is. The Chat screen serves one as the session `curia-console-<n>`, which `validSessionName` admits.
- **A browser conversation number is never reused.** Numbers only go up. The chat handle of [#241](https://github.com/alp82/curia/issues/241) takes the lowest free index, and a conversation must not, because a reused number would wake the deleted conversation's memory. An agent is torn down whole. A conversation is memory, and that is the difference.
- **`chat-<n>` is not available.** It already names a ticketless agent, whose session is `curia-chat-<n>`.
- **The daemon owns the key, and the container holds no conversation state.** A turn carries the key, the resume id and the prompt in, and the new session id back. The container never learns that a browser key differs from a Discord one. The rule that a browser turn runs its verbs with no origin thread travels as its own field, which the daemon fills.
- **A transcript is found by key, never by mtime.** The daemon journals the live session id per key, and the claude harness names the transcript file after that id. So the Chat screen and the context meter both read the file the key names. This is what makes a per-conversation context percent true.
- **Nothing expires a conversation on a timer.** There is no idle limit, no age limit, and no cap on how many keys exist. A Discord conversation goes quiet by itself and costs one journal line.
- **No new warning says that a conversation is long.** The status line already shows context percent, and it already marks an over-full context. A browser conversation carries that same meter, and the operator opens a new conversation when they judge it is time.
- **The cutover keeps no history.** The container config dir is new, so every journalled resume id names a file that is not there. Nothing is copied across. Every conversation starts fresh on its first turn after the cutover.
- **A ticket that took over a conversation thread leaves one line behind.** While that ticket runs, the operator's words reach the agent rather than the overseer, so the conversation comes back with a gap it cannot see. The note machinery of [#94](https://github.com/alp82/curia/issues/94) already puts journalled lines in front of a conversation's next prompt, and the end of the ticket writes one there.

## The whole key space

| Conversation | Key | Minted by | Ends |
|---|---|---|---|
| A Discord thread | the thread snowflake, all digits | Discord, when a top-level message opens the thread | when the thread is deleted |
| A browser chat | `console-<n>`, n only goes up | the daemon, when the operator opens one | when the operator deletes it |

The cases this key has to survive:

1. **A ticket takes over a conversation thread.** The key keeps working. The operator's words reach the agent while the ticket runs. The conversation returns on the same key afterwards, with the one note above.
2. **A thread that dispatch opened, with no conversation behind it.** A message in it after the ticket ends starts a conversation on that key.
3. **A Discord thread that goes quiet.** Discord files it away after seven days. The next message revives it, on the same key and the same conversation.
4. **A deleted Discord thread.** Its key is left in the journal and is never used again. It costs one line, and nothing collects it.
5. **A message outside a thread of the curia channel.** Nothing answers, and no key is minted.
6. **Two browser tabs on one browser conversation.** One key, one conversation. The `busy` lock makes the second message wait.
7. **A browser conversation and a Discord thread at once.** Two keys, two conversations, both answered at the same time inside the one container.
8. **A browser conversation with no turn yet.** The key exists, there is no resume id and no transcript file, and the screen is empty. That is correct.
9. **A deleted browser conversation.** Its number is spent. The next one takes a higher number.
10. **The cutover.** Every key lives, every resume id is dropped, and every conversation starts fresh.

## Considered options

**A prefix on every key**, such as `discord:<snowflake>`. It makes a key self-describing on the wire. It buys nothing, because the two shapes already cannot collide, and it would rewrite journalled state that every live conversation resumes from.

**A config dir per conversation.** Then the newest file in a dir is always the right one, and no lookup is needed. It costs a seeded config dir per Discord thread, and threads are frequent and cheap today. ADR-0015 rejected one container per thread on the same ground.

**A second config dir for the browser alone.** It is cheaper than the last option and it fixes the Chat screen. It can never surface a Discord conversation, and it leaves the context meter wrong for Discord.

**An idle timer on a conversation.** It bounds growth and adds no surface. It is a surprise: the operator comes back after a weekend and the brain has forgotten. Many browser conversations bound growth and forget nothing.

## Consequences

- **The key is opaque at the boundary.** Everything that knows what a key means stays in the daemon. This is what lets [#314](https://github.com/alp82/curia/issues/314) carry a turn as data rather than as a surface.
- **The Chat screen needs a conversation picker.** Many browser conversations have no surface today. This record names them. Building the picker and the new-conversation action is its own ticket.
- **The transcript fix is shipped in-daemon behavior, not container work.** It is a live defect on `main`, and it stands alone from the move.
- **One check stays for the build.** A resumed session mints a fresh session id. Whether that new file carries the whole prior history is not verified here. If it does not, the file a key names is short, and the build must say so before it drops the mtime path.
- **[#326](https://github.com/alp82/curia/issues/326) agrees with this key.** The single-use conversation thread rule keeps the key working across a takeover, and the note above is what keeps the conversation honest when it comes back.
