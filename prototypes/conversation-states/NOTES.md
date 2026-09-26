# Conversation states prototype

Throwaway prototype for [Define the conversation surface's interaction states and density](https://github.com/alp82/curia/issues/1029).
It starts from variant D, Calm threads, chosen on
[Choose between conversation-led and attention-led Curia workspaces](https://github.com/alp82/curia/issues/1021), and adds the
sidebar maps list from [Choose a map overview for the full plan and its execution](https://github.com/alp82/curia/issues/1022).
The page is one file, with static mock data and no persistence.

Run it from the repository root:

```sh
cd prototypes/conversation-states && python3 -m http.server 9029 --bind 127.0.0.1
```

Open <http://127.0.0.1:9029/?variant=A>. To switch the variant, use the floating bar or the Left Arrow and Right Arrow keys.
Press `d` to switch between desktop and phone. The panel on the right holds six scenarios; each step sets the mock state.
Buttons in the frame work: answer, fold and unfold, pause, resume, stop, start again, sign in, the dock pager, and Activity.

## The question

Density is two questions in one: where the agent's steps go, and where open questions live. The real timeline carries `say`,
`think`, `tool` with its `result`, `prompt`, `queued`, and `note` items, plus question cards (`choice`, `confirm`,
`free-text`, `approve-reject`, `preview-review`). Several questions can be open in one session at once (`waiting_on` is an
array). Each variant answers the two questions differently, and handles interrupts and the landing page to match.

| Variant | Name | Agent steps | Open questions | Interrupt from another conversation | Landing after a return |
| --- | --- | --- | --- | --- | --- |
| A | Full log | One monospaced line per step, in the conversation | In the conversation, where asked | Toast with **Answer** and **Later** | Cards with each conversation's last line |
| B | Folded work | One row per turn: "Worked for 48 min · 7 steps ›" | In the conversation, where asked | None. The sidebar row flashes and moves to Needs you | A "Since you left" list with one verb per row |
| C | Docked questions | Hidden behind **Activity** (≡) | Docked above the composer with the message that asked, paged | Joins the dock, marked with where it's from | The waiting questions in the dock, then cards |

In A and B the status line sticks to the top of the conversation. In C it joins the composer.

## Scenarios

1. Landing after a return: after 10 hours, reopening a conversation left mid-way (a "since you left" divider), nothing
   needs you, and the first day.
2. Interrupts: a question arrives in another conversation while you review a pull request; answering it; two questions
   open in one conversation; a question answered in Discord while the page is open; a question closed because its session
   ended.
3. Parallel conversations: six alive at once, starting a quick task while others run, the new conversation starting,
   switching back, and messaging an agent that's working.
4. Long-running work: two hours in, paused, no output for 30 minutes, cross-checking, and a usage limit.
5. Failure and recovery: a session died overnight and starting it again, an AI sign-in expired and signing in again, and
   a task that didn't start.
6. Empty states: a new conversation, a conversation that just started, a closed ticket's conversation, no maps, and the
   first day.

## Status line states

starting · working · paused · no output · cross-checking · waiting for you · pull request open · at a limit ·
sign-in expired · ended · didn't start · finished · closed

A ticket has no failed state, per the map overview decision. A dead session releases its claim, and the conversation offers
**Start again** on the same branch.

## Gaps against today's service

The prototype shows controls and states the daemon doesn't have yet. They join the service-contract fog on the map if the
operator keeps them.

- **Pause and Resume.** No pause exists. Today's verbs are `cancel`, `resume`, `start`, `attach`, `review`, and `reauth`
  (`daemon/src/commands.mjs`).
- **Stop.** Maps to `cancel`. There's no Stop button in the Chat room today.
- **Nudge** for the stall watchdog, and **Use OpenAI now** at a usage limit. Today a stall hold and a spent window offer
  only typed `resume`/`start` or nothing.
- **Unread position** ("since you left") needs a per-operator read mark per conversation.
- **A closed ticket's conversation** has no transcript after close
  ([How should the app keep agent artifacts reachable after a ticket closes?](https://github.com/alp82/curia/issues/1028)).
  The empty state points at the ticket and the map.
- **Pull-request card in the conversation.** Today the diff and merge controls live only on the review-gate card.

## Known limits of the mock

- Nothing talks to the service. Links go nowhere.
- The Maps page is a placeholder. Its design is decided on the map overview ticket.
- Answering a question in C's landing dock doesn't open the conversation.
