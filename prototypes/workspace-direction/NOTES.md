# Workspace direction prototype

Throwaway prototype for [Choose between conversation-led and attention-led Curia workspaces](https://github.com/alp82/curia/issues/1021).
Three shells of the whole app, one file, static mock data, no persistence.

Run it from the repository root:

```sh
cd prototypes/workspace-direction && python3 -m http.server 9021 --bind 127.0.0.1
```

Open <http://127.0.0.1:9021/?variant=A>. The floating bar or the Left Arrow and Right Arrow keys switch variants. Press `d` to
switch between desktop and phone. The panel on the right holds the seven scenarios from
[Which agent and planning workflows should organize the Curia app?](https://github.com/alp82/curia/issues/1020); clicking a step
sets the mock state so the frame shows that moment.

| Variant | Name | The page is | Conversations | Map overview |
| --- | --- | --- | --- | --- |
| A | Threads | the open conversation | the left rail, grouped by state | an overlay from the conversation |
| B | Desk | a board of what needs you | a drawer over the board, tabbed | a separate top-level page (Efforts) |
| C | Atlas | the plan itself (every map, lanes, tickets) | a dock beside the plan, tabbed | the page |

Every variant renders picture, table, diagram, attachments, question cards, and a pull-request card in the conversation, and
every scenario completes on the phone.

## Judge inputs

The judge scores each scenario on each variant without a browser, from the source, these statements, and the walkthroughs.
Criteria: time to orientation, steps to act, place-keeping, nothing hidden, same journey on phone.

### A — Threads

- **Always present.** The conversation list on the left, grouped needs-you, running, review, finished, failed, filterable by map or
  quick. The objective header of the open conversation: map and ticket crumbs, title, state pill, pause, stop, ticket link, map
  button, terminal link. A new-conversation button.
- **Contextual.** A right pane for the open conversation: this ticket's place on its map with a lane count, what it unblocks,
  artifacts, session facts. The full map opens as an overlay over the conversation. A maps index sits behind a rail button.
- **After a return.** The overseer thread is pinned at the top of the rail and reads as the overnight summary. The needs-you group
  sits under it with a count.
- **Switching.** Click a thread. Each thread keeps its scroll. On the phone, the chats list pushes to a full-screen conversation
  with a context sheet; Chats, Maps, and New are bottom tabs.
- **Map overview.** Reachable from every conversation through the context pane and the header. The map is never a destination of
  its own on the desktop; on the phone it is a tab.

Walkthroughs (desktop, then phone where it differs):

1. Morning return. Land on the last open thread. Rail shows Overseer at top and needs-you 2. Click Overseer: table of the four
   sessions. Click the waiting thread in needs-you. Click an answer button. Four clicks. Phone: Chats tab lists the same groups;
   tap Overseer, back, tap the waiting thread, tap an answer.
2. Work a map ticket. Open any Redesign thread, click Map in the header: overlay with lanes. Click the frontier ticket: overlay
   closes, the ticket's conversation opens. Grill, answer. When resolved, the context pane's lane counts change; click Open map to
   see the lanes. Phone: Maps tab, Open waiting ticket, answer, Context sheet shows the rail.
3. Quick task. Phone: New tab, describe, Start. A thread appears under running with a quick label and no map. Desktop later: the
   thread sits under finished with the quick filter; PR card in the conversation.
4. Switch under load. Five threads open in the rail. A toast at the top names the interrupting question with an Answer button.
   Click Answer: that thread opens. Answer. Click the PR thread in the rail: it reopens at the same scroll. The toast is the only
   signal besides the needs-you group moving.
5. Reshape a plan. Open the resolved thread; read the diagram message and the closing system line. Click Map: overlay. Click
   Reshape: tickets become closable, a dashed add card appears in the frontier lane. Done editing, back to conversation.
6. Review and follow up. The review group in the rail holds the PR thread. Open it: PR card with Open PR, Open in VS Code, Merge,
   Redo. Type follow-ups in the composer. Merge or Redo from the card.
7. Artifact review (phone). Chats tab, needs-you, the ticket that published. Attachments row shows the report and the preview
   link; the picture renders in place; the report renders as Markdown in place. Tap the preview link, come back, tap an answer.

### B — Desk

- **Always present.** Top nav Desk, Efforts, History, and an ask box that accepts anything. On Desk: four columns, needs you,
  failed, running, finished since you left, each card with its next action inline: answer buttons and a text box, retry, pause
  and steer, PR, merge, follow-up, see map change.
- **Contextual.** A conversation opens in a drawer over the board with a strip of open chats. Efforts is the map page: each map
  as a card with a health line, a latest update line, five lanes, reshape.
- **After a return.** The board is the summary. The finished column carries an overseer summary card at its foot.
- **Switching.** The drawer strip holds every open chat; the board underneath does not move. Interrupts arrive as a toast plus a
  new card in needs-you.
- **Map overview.** Its own page. Finished cards link to the map change.

Walkthroughs:

1. Morning return. Land on Desk. Columns read left to right: needs you 2, failed 1, running 1, finished 4 plus the overseer
   card. Click an answer button on the first needs-you card. One click from landing; no conversation opened. Phone: same sections
   as a feed; tap an answer.
2. Work a map ticket. Efforts tab: lanes with state pills. Click the frontier ticket: drawer opens over Efforts. Answer. Close the
   drawer: the lanes show the ticket moved. Phone: Efforts tab, tap ticket, push page, back.
3. Quick task. Phone: ask box on Desk, describe, Start. A running card appears. Desktop later: the finished column has the quick
   card with a PR line; click it for the drawer with the PR card.
4. Switch under load. Drawer open on the PR review with four chips in the strip. Toast names the question. Click Answer: drawer
   switches to that chat, chip added. Answer. Click the PR chip: back at the same place. The board never changed.
5. Reshape a plan. The finished card says the map overview resolved; click See map change: Efforts with that map selected. Open the
   resolved chat from its lane to read the diagram. Reshape: strike a ticket, dashed add card in the frontier lane. Done.
6. Review and follow up. The finished column holds the PR card with PR, Merge, and Ask a follow-up. Click the card: drawer with the
   PR card and its buttons. Ask two questions in the composer. Merge or Redo from the PR card.
7. Artifact review (phone). Desk feed, needs-you section, the card that published. Its two answer buttons are inline, but to see
   the picture tap the card: push page renders the attachments, the picture, and the report in place. Tap the preview link, back,
   answer.

### C — Atlas

- **Always present.** The plan canvas: every map with destination, latest update, five lanes, tickets with state pills, plus an
  unmapped row for quick tasks and research. An attention strip across the top: needs-you chips, failed chips, running chips,
  an ask box, and the overseer.
- **Contextual.** Conversations dock on the right, tabbed, tied to their ticket, which highlights on the canvas.
- **After a return.** The strip says what needs you and what failed; the lanes show what finished. The overseer is one chip away.
- **Switching.** Click a ticket or a chip. Dock tabs keep every open conversation; the canvas stays.
- **Map overview.** The map is the page. Reshape happens in place.

Walkthroughs:

1. Morning return. Land on the canvas. Strip: two needs-you chips, one failed chip, one running chip. Lanes show two finished
   pills. Click the first needs-you chip: dock opens. Answer. Two clicks. Phone: Plan tab, same strip, tap chip, push page, answer.
2. Work a map ticket. The frontier lane is on the canvas. Click the ticket: dock opens. Answer. On resolution the ticket moves
   lanes on the same screen. Phone: Plan tab, Open lanes on the map card, tap ticket, back.
3. Quick task. Phone: ask box under the unmapped row, describe, Start. A running ticket appears in unmapped. Desktop later:
   unmapped row shows it finished; click for the PR card.
4. Switch under load. Dock has four tabs, PR review active. Toast names the question; the chip in the strip is also there. Click
   Answer: dock switches, tab added. Answer. Click the PR tab: same place. Canvas unchanged.
5. Reshape a plan. The lanes changed on their own; the resolved ticket shows a finished pill. Click it to read the diagram in the
   dock. Reshape on the map header: strike a ticket, dashed add card in the frontier lane. Done. Nothing left the page.
6. Review and follow up. The running lane of the Discord map shows a review pill, and the strip has a running chip for it. Click:
   dock with the PR card. Ask two questions. Merge or Redo from the PR card.
7. Artifact review (phone). Plan tab, needs-you chip for the ticket that published. Push page renders attachments, picture, and
   report in place. Tap the preview link, back, answer.

## Known limits of the mock

- Buttons for Pause, Stop, Merge, Redo, Retry, and the terminal link do nothing. Answer buttons only mark a choice.
- Reshape shows the strike-through and the dashed add card; it posts nothing.
- One set of mock data for every scenario, so scenario 4 shows five open conversations only in the dock or drawer tabs.
