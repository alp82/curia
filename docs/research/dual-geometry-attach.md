# Can two devices drive one live worker at their own sizes?

Resolves [#72](https://github.com/alp82/curia/issues/72), graduated by
[A phone and a desktop cannot share one terminal geometry](https://github.com/alp82/curia/issues/71),
which refused all six geometry trades and set the scope wide: the same PTY is a
means, not the requirement. The requirement is **full control of the same live
worker from both devices**. The mechanism pick lives on
[#73](https://github.com/alp82/curia/issues/73); this report is the evidence
under it.

Run 2026-07-29. Measurements on `alppc` against `tmux 3.7b` and `ttyd 1.7.7`,
the versions the deployment host actually serves attach with. Probe scripts:
[`prototypes/dual-geometry/`](../../prototypes/dual-geometry/).

**Answer: no mechanism exists in the terminal-relay family, and the reason is
structural rather than a gap somebody could close. The recommendation is
therefore the one #71 already suspected — a non-PTY surface — and the report
ends by naming a cheaper form of it than expected, built from two things curia
already owns.**

---

## The mechanism that would have to exist

State it once, precisely, because every candidate is judged against it and
almost every candidate fails it the same way.

A PTY carries exactly one window size. `TIOCSWINSZ` sets one `struct winsize`,
the kernel raises one `SIGWINCH`, and the program renders **one** grid. A
full-screen TUI on the alternate screen buffer emits cursor-addressed writes
that are only correct at the geometry the program believes it has. Everything
downstream of the program therefore receives a single stream of
absolute-positioned output, and no amount of cleverness in a relay can recover
the layout decisions the program already made and discarded.

So per-client geometry needs one of exactly three mechanisms:

- **(a)** the program lays its own state out more than once, one output buffer
  per client, at each client's size;
- **(b)** the server holds an independent emulator *and* an independent PTY
  *and* an independent program instance per client, reconciled at the
  application-state layer;
- **(c)** the transported content is **not a cell grid at all**, but a
  re-renderable description each client lays out locally.

Note what is *not* on that list: a server-side screen model. That turns out to
be the most useful negative result in this report, and it is treated on its own
below.

---

## Leg 1 — the narrow sweep

Expected to return "no". It did. It is recorded anyway, measured rather than
assumed, because #71's answer rests on it.

### Measured first, on the incumbent

#71 measured grouped sessions and got one answer. This ticket re-ran the whole
option surface on the deployment host's own tmux, with two clients at the
operator's real geometries. The rig is #71's: two outer tmux sessions of fixed
size stand in for the two devices, each hosting one client of one inner session.

Inner session created at 100x30. PC client 159x71, phone client 47x48.

| state | window size | PC client | phone client |
| --- | --- | --- | --- |
| no client attached | `100x30` | — | — |
| PC attaches | `159x70` | `159x71` | — |
| phone attaches too, `window-size=latest` (default) | **`47x47`** | `159x71` | `47x48` |
| `window-size=largest` | `159x70` | `159x71` | `47x48` |
| `window-size=smallest` | `47x47` | `159x71` | `47x48` |
| `window-size=manual` + `resize-window -x 100 -y 30` | `100x30` | `159x71` | `47x48` |

Read the last two columns. **tmux does track a per-client size** — it knows the
PC is 159 wide and the phone is 47, at the same time, in the same session. It
simply has nowhere to put two renderings, because the window has one size and
every mode is a different way of picking one number out of the set. `latest`
picks the last toucher, which is the flap the operator reported.

Four further probes closed the remaining doors.

**1. `refresh-client -C` is not the escape hatch.** Aimed at either attached
client, tmux 3.7b answers `not a control client`. The dispatch is gated on
`if (~tc->flags & CLIENT_CONTROL) goto not_control_client;`
([`cmd-refresh-client.c#L289`](https://github.com/tmux/tmux/blob/e802909de06012a4df6209d55e86487c56223163/cmd-refresh-client.c#L289)),
so no human client can hold a private size. Two *control* clients can hold
different values, and it still does not help: the `skip:` block in
`clients_calculate_size()` uses them only as a downward clamp on the one window
size, under the comment "Do not allow any size to be larger than the per-client
window size if one exists"
([`resize.c#L218-L244`](https://github.com/tmux/tmux/blob/e802909de06012a4df6209d55e86487c56223163/resize.c#L218-L244)).
Two values produce the minimum, applied to one grid.

**2. Grouped sessions share the window object itself, not a copy.** PC on
session `work`, phone on grouped session `mirror`: both report `window_id`
**`@0`** — the same window. Setting `window-size largest` on `work` and
`smallest` on `mirror` left **both** reading `smallest`, because it is a
*window* option and there is one window, so the second write overwrote the
first. Creating a window in `mirror` made it appear in `work` too (`@2` in
both). In source, `session_group_synchronize1()` rebuilds each member's winlinks
with `winlink_set_window(wl2, wl->window)`
([`session.c#L659`](https://github.com/tmux/tmux/blob/e802909de06012a4df6209d55e86487c56223163/session.c#L659)) —
the identical `struct window` pointer. This confirms #71's finding and explains
it.

**3. `largest` is better than #71 recorded, and the correction matters.** #71
wrote that under `largest` "the phone sees the top-left corner of 159 columns".
It is not a fixed corner. tmux gives the smaller client its **own** viewport
offset onto the larger grid, tracked per client and by default chasing that
client's own cursor (`tty_window_offset1()`,
[`tty.c#L952-L1008`](https://github.com/tmux/tmux/blob/e802909de06012a4df6209d55e86487c56223163/tty.c#L952);
stored per client by `tty_update_client_offset()`,
[`tty.c#L1030`](https://github.com/tmux/tmux/blob/e802909de06012a4df6209d55e86487c56223163/tty.c#L1030)).
The manual states the scope outright: "Note that the visible position is a
property of the client not of the window"
([`tmux.1#L1472`](https://github.com/tmux/tmux/blob/e802909de06012a4df6209d55e86487c56223163/tmux.1#L1472)).

Measured here: with the window at `159x70`, the 47-wide client reported
`offset=0,0` while the 159-wide client reported no offset at all, and
`refresh-client -t <small> -R 40` moved the small client to `offset=40,0`
**with the large client unchanged**.

So `largest` is the one arrangement in this entire sweep that gives two clients
genuinely independent per-client state at zero cost, with both still writable.
It is still not a fitted render — the phone reads 47 columns of a layout
composed for 159 — and #73's pass bar refuses exactly this ("neither clipped,
letterboxed, **panned**, nor zoomed"). It is recorded because it is the honest
fallback, and because #71's note about it was wrong.

**4. The kernel agrees, which is the end of the argument.** With both clients
attached, `stty size` on the pane's own tty reported **`46 47`**. One
`TIOCSWINSZ`, one number, matching the phone. The program at the other end
rendered once, for 47 columns, and the PC was shown that rendering.

### tmux, in the maintainer's own words

The strongest primary evidence is not the code, it is nicm saying the capability
does not exist and describing what it would cost.

> "Ptys displayed in different sizes of panes must be handled. At the moment
> windows may be oversize and are cropped and panned, but panes may not be. As a
> first step ptys could be limited to the smallest pane in which they are
> displayed, but that would only be a stopgap, eventually they would need pan
> which would be complicated and considerable effort."
> — [tmux#2449](https://github.com/tmux/tmux/issues/2449#issuecomment-719981190)

A year later, still open:

> "I don't really know how all the UI and stuff will look, and how we will deal
> with panes shown in two places at different sizes."
> — [tmux#2449](https://github.com/tmux/tmux/issues/2449#issuecomment-963608646)

Read what the proposed stopgap is: clamp to the smallest, then pan. Both are
mechanisms tmux already has. No maintainer has ever proposed rendering twice.
Nothing in the `CHANGES` for 3.4, 3.5, 3.6 or 3.7 adds per-client sizing;
`force-width`/`force-height` were removed in 2.8 when `window-size` arrived.

### The other multiplexers

| candidate | verdict | the mechanism it actually implements |
| --- | --- | --- |
| **zellij** | no | stores `client_sizes` per client, then `recompute_tab_size()` sorts and takes index `[0]` — the **minimum** — and applies it to the one shared tab ([`screen.rs#L2499-L2547`](https://github.com/zellij-org/zellij/blob/9969ed10b2cd95cb84ddaf8a783949483e2b038b/zellij-server/src/screen.rs#L2499)). tmux's `smallest` by another road. |
| **GNU screen** | no | `MayResizeLayer()` returns 0 as soon as a layer is shown in more than one canvas ([`resize.c#n203`](https://git.savannah.gnu.org/cgit/screen.git/tree/src/resize.c?id=9d8b0ff3901bdcb8d3bc05d94fce2ef987562768#n203)) — it **refuses to resize at all** and hands the mismatched display a clipped, offset view. |
| **abduco + dvtm** | no | `MSG_RESIZE` runs `TIOCSWINSZ` only for `c == server.clients`, the head of the list ([`server.c#L230`](https://github.com/martanne/abduco/blob/8c32909a159aaa9484c82b71f05b7a73321eb491/server.c#L230)). One client owns the size; `-l` exists only to queue behind it. abduco holds no emulator at all, so there is nothing on the server to render twice. dvtm has no client/server model. |
| **wezterm mux** | no | `ClientInfo` carries no geometry field ([`client.rs#L43-L55`](https://github.com/wezterm/wezterm/blob/46a166d6dc8188ede1a32a96375e308081ebafc5/mux/src/client.rs#L43)); attaching takes `size.cols.max(tab_size.cols)` and resizes **both** the local window and the remote tab ([`termwindow/mod.rs#L1262-L1275`](https://github.com/wezterm/wezterm/blob/46a166d6dc8188ede1a32a96375e308081ebafc5/wezterm-gui/src/termwindow/mod.rs#L1262)). Two clients converge on one geometry. |
| **mosh** | no, one step earlier | a `Connection` holds exactly one `remote_addr`; a datagram from a new address **replaces** it rather than adding a peer ([`network.cc#L526`](https://github.com/mobile-shell/mosh/blob/decd9b705eb81626f694335b8d5940538beb06da/src/network/network.cc#L526)). A second client hijacks the session, it does not join it. Its synced state is a fixed-size `Framebuffer`, so diffing it does not make it re-flowable. |

**zellij deserves one extra line, because it is the near miss.** It has a
watcher role whose size does *not* enter the tab calculation — a genuine
per-client render pass. That pass can only crop and pad
([`output/mod.rs#L563-L601`](https://github.com/zellij-org/zellij/blob/9969ed10b2cd95cb84ddaf8a783949483e2b038b/zellij-server/src/output/mod.rs#L563)),
and watchers **cannot type**: `route.rs` discards their input with the comment
"Ignore all input from watcher clients"
([`route.rs#L2256-L2296`](https://github.com/zellij-org/zellij/blob/9969ed10b2cd95cb84ddaf8a783949483e2b038b/zellij-server/src/route.rs#L2256)).
Tellingly, zellij *does* implement per-client emulators — `grids: HashMap<ClientId, Grid>` —
but only for WASM **plugin** panes, which re-render on demand, and never for
PTY-backed panes, which cannot
([`plugin_pane.rs#L92-L93`](https://github.com/zellij-org/zellij/blob/9969ed10b2cd95cb84ddaf8a783949483e2b038b/zellij-server/src/panes/plugin_pane.rs#L92)).
The project has the pattern and knows exactly where it stops applying.

### The relays

The important structural finding here is that **the relay layer is the wrong
place to look**, and its own maintainers say so.

**ttyd spawns one PTY per browser tab.** The per-connection struct owns a
`pty_process *process`, and the first data frame calls `spawn_process` unless
one already exists
([`protocol.c#L328-L349`](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/protocol.c#L328-L349)).
`RESIZE_TERMINAL` therefore reaches only that client's own PTY
([`protocol.c#L316-L320`](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/protocol.c#L316-L320)).
There is no shared-session mode; `--max-clients` is a connection cap and
`--writable` is one boolean gating input. Neither joins two clients to one
process. Maintainer tsl0922, asked directly for a shared-session mode
([ttyd#53](https://github.com/tsl0922/ttyd/issues/53),
[ttyd#1189](https://github.com/tsl0922/ttyd/issues/1189)): *"I would recommend
tmux too."* A user in that thread who patched it reported the failure exactly —
*"the second user steals the stdout."*

**So in curia's own stack there are N+1 PTYs, not one:**

| PTY | created by | sized by |
| --- | --- | --- |
| one per browser tab, running `tmux attach` | ttyd, `pty_spawn` | that tab, exactly, with no contention |
| one window PTY, running the worker CLI | the tmux server | **tmux, reducing over all attached clients** |

**ttyd is geometry-innocent. tmux is where the two devices collide.** Swapping
ttyd for gotty or wetty changes nothing — both spawn per connection too, and
gotty's README says so in as many words: *"users cannot share a single terminal
with others by default … you can use terminal multiplexers."*

The sharing-oriented relays are all equal to or worse than the tmux already
running:

- **tmate** forked tmux at 2.4, *before* `window-size` existed, so it is
  permanently on the old smallest-client rule and adds a **second** minimum from
  remote viewers ([`resize.c#L47-L110`](https://github.com/tmate-io/tmate/blob/985ab6140c4a640a9030d3a64fd782c503e56128/resize.c#L47)).
  A phone viewer clamps the desktop. Strictly worse.
- **upterm** applies the minimum across the host and every attached client
  ([`event.go#L134-L147`](https://github.com/owenthereal/upterm/blob/1a8b11e43b117d4dcfc8d7d92d421cb3f1abbca9/host/internal/event.go#L134)).
  Its `--force-command 'tmux attach'` recipe is curia's own shape, handing the
  problem straight back to tmux.
- **dtach** lets the last writer overwrite one global winsize.
- **tty-share** broadcasts the host's geometry and, when a viewer is smaller,
  does not even crop — it blanks the screen and prints *"Your window is smaller
  than the remote window. Please resize."*
- **sshx** is the sharpest trap, because "multiplayer" reads like the answer. It
  has real per-user state — cursors, names, focus, write permission — and none
  of it is geometry. Size lives in a `WsWinsize` keyed by *shell*, broadcast to
  everyone, and every viewer's xterm.js is bound to it
  ([`protocol.rs#L8-L19`](https://github.com/ekzhang/sshx/blob/dd42496be83da6a7cbb963aee54ba9402f0ddd98/crates/sshx-server/src/web/protocol.rs#L8),
  [`Session.svelte#L487-L501`](https://github.com/ekzhang/sshx/blob/dd42496be83da6a7cbb963aee54ba9402f0ddd98/src/lib/Session.svelte#L487)).
  The per-user "zoom" is a CSS transform: it changes apparent pixel scale, never
  `cols`. And sshx **could not** render per client even if it wanted to — the
  terminal stream is end-to-end encrypted and the server holds no decryption
  code at all. That is an architectural exclusion, not an omission.

### What leg 1 rules out

Every multiplexer and every relay places its reconciliation at the **grid**
layer, downstream of the single PTY, where exactly four moves are available:

1. pick a winner (`latest`, abduco's head client, dtach's last writer,
   tty-share's host);
2. take a min or a max (`smallest`, `largest`, zellij's `recompute_tab_size`,
   wezterm's `.max()`, upterm's and tmate's minimums);
3. freeze and clip (`manual`, screen's `MayResizeLayer`, zellij's watcher
   crop-and-pad);
4. pan a viewport (tmux `refresh-client -LRUD`, screen's canvas offsets).

None of those four is a second rendering. **This rules out the entire "swap the
multiplexer" and "swap the relay" branch of the solution space.**

### The negative result worth keeping: a screen model is not sufficient

This is the finding most likely to be re-litigated later, so it is recorded
plainly. tmux, GNU screen, mosh, asciinema and VS Code's terminal service all
hold **real server-side terminal emulators**. Not one of them renders one
program at two geometries. A grid inherits its size from the single PTY that
filled it. A relay holding a grid can crop it, pad it, or pan around it — it
cannot re-lay-out an alternate-screen TUI, because the layout decisions live in
the application and were discarded before the relay ever saw the bytes.

The two systems found that genuinely deliver per-client geometry from shared
state — Charm's `wish`/`bubbletea`, where each SSH session builds its own
`tea.Program` at that session's size, and the **Emacs daemon**, which gives each
`emacsclient -t` its own frame and its own glyph matrices and lays the same
buffer out into each — both work by mechanism (a): **the application is
multi-headed by design**. That capability lives in the application and never in
the relay. No relay can add it to a program that lacks it.

---

## Leg 2 — non-PTY attach surfaces

The family that reflows for free, because a timeline of messages has no grid.

**The headline for this leg is uniform across all three candidates, and it is the
answer to the ticket: none of them carries geometry at all.** Property-name scans
for `cols`, `columns`, `rows`, `width`, `cursor`, `viewport` and `resize` across
the three protocols return either nothing or a handful of false friends —
pagination cursors, byte sizes, and file line numbers. There is nothing to
reflow, so each client lays the same content out at its own width for free. The
blocker was never the width. It is **who owns the fan-out point**.

### A. Claude Code `stream-json`

**Two observers: broker required.** One stdin, one stdout, no subscription
concept. Two clients cannot attach to one `claude -p` process.

**But the fan-out half is nearly free.** `--replay-user-messages` re-emits every
stdin user message back on stdout ([`cli-reference`](https://code.claude.com/docs/en/cli-reference.md)),
so stdout becomes **the single canonical ordering of both clients' inputs and the
worker's outputs**, in the order the worker actually saw them. Fan-out of one
stream then gives every client a consistent view.

**Injection is solved on the wire, and measured.** Three modes were probed live
against Claude Code `2.1.220`:

1. A plain mid-turn message is **queued**, not steered — turn 1 ran to completion
   unchanged, then turn 2 applied the change.
2. A raw `control_request` with subtype `interrupt` aborted the turn in under
   10 ms, with no SDK involved.
3. **`"priority":"now"` beside `"type":"user"` pre-empts the running turn** —
   observed as `term=aborted_streaming`, a fresh turn, and the model continuing
   the same work with full prior context.

Mode 3 is the one that matters and it is **not in the public CLI reference**.
Zed's official Anthropic adapter uses it and documents the intent in source
([`claude-agent-acp/src/acp-agent.ts#L204-L209`](https://github.com/agentclientprotocol/claude-agent-acp/blob/d7a65ce1d042a90d24a71279a319735cb9200bf8/src/acp-agent.ts#L204-L209)).
Treat it as a real but **undocumented** contract, and pin the CLI.

**What travels is semantics, not rendering.** Tool inputs ride as full `tool_use`
blocks; tool results carry `stdout`/`stderr`/`interrupted`; thinking rides as
`thinking` blocks; and **diffs ride as `structuredPatch`**, so a client
re-renders a diff at any width rather than receiving a picture of one width.

**Losses beyond the three the ticket already names.** The workspace **trust
dialog is silently skipped** in non-interactive mode, and settings that fail
validation are ignored with no error — that is a security-posture change, not
merely a missing dialog. The external-import approval dialog has **no wire
representation** at all. `/login`, `/plugin` and `/resume` do not work. And there
is **no replay and no cursor**: `--resume` reconnects a *conversation*, not a
*stream*, so a restarted broker has lost in-flight stream state.

**Existence proof, not a candidate.** Claude Code already ships a non-PTY
multi-device attach surface — Remote Control, whose documentation states that
*"the conversation ... stay[s] in sync across all connected devices, so you can
send messages from your terminal, browser, and phone interchangeably"*
([`remote-control`](https://code.claude.com/docs/en/remote-control.md)). That is
this ticket's requirement, solved, by the message-timeline model. It cannot be
curia's surface — the clients are Anthropic's own apps, so curia cannot render
its own UI, and it is unavailable on Bedrock/Vertex and to zero-retention orgs.
Cite it as validation of the **shape**.

### B. ACP

**The sources moved and curia's notes are now stale.**
`zed-industries/agent-client-protocol` redirects to
`agentclientprotocol/agent-client-protocol`, `schema/schema.json` split into
`schema/v1/` and `schema/v2/`, and `@zed-industries/claude-code-acp` is
deprecated in favor of `@agentclientprotocol/claude-agent-acp`. #20's paths need
updating.

**Transport is point-to-point.** stdio, one client per agent subprocess. Sessions
multiplex over that one connection, so demultiplexing is trivial and
*multi-client is not*.

**Multi-client observation appears in the spec only as a v2 motivation, never as
a v1 mechanism.** The migration doc names the v1 defect — the old lifecycle
*"made replay, multi-client sessions, background work, and queued messages
awkward to express"* — and the v2 payoff: *"the same message flow works for
history replay ..., multiple clients observing one session, and future
agent-initiated or queued work."* Under v2 the timeline becomes fully
server-authoritative, which is exactly what a fan-out broker wants.

**v2 is not shipping.** It is `2.0.0-alpha.2`; the Rust crate marks it unstable
and sets `LATEST = V1`; and **both official adapters return `protocolVersion: 1`**.

**Mid-turn injection is undefined in both versions** — v2 says *"queueing is
decidedly not part of this RFD"* — so both adapters ship the same out-of-spec
`_session/steering` extension, advertised through `_meta`. The two are not even
byte-identical (`codex-acp` adds a `"failed"` outcome that `claude-agent-acp`
does not define). It is a convention between two implementations, not ratified
protocol.

**Late joiner is v1's strength**: `session/load` *MUST* replay the entire
conversation as `session/update` notifications before responding. v2 replaces it
with an opt-in `replayFrom`, which currently has exactly one concrete variant,
`start` — everything or nothing, with no incremental cursor.

One useful correction for #23: `elicitation/create` **stabilized on 2026-07-24**
and is no longer unstable.

### C. Paseo

**Native multi-client fan-out — the only candidate with it.** Each agent owns one
append-only timeline addressed by `(epoch, seq)`, and dispatch is a plain
observer set; distinct `clientId`s get distinct sessions, and one `clientId`
reconnecting adds a second socket to a `Set<WebSocketLike>`. `paseo agent attach`
is the second-observer case in shipped code.

**Best late-joiner design of the three, by a wide margin.**
`fetch_agent_timeline_request` takes an `{epoch, seq}` cursor with
`direction: tail|before|after`, and the response carries `reset`, `staleCursor`,
`gap`, `hasOlder`, `hasNewer` and a window. The docs state the split: *"Live
stream ... for immediacy. Authoritative history ... for correctness."*

**Two corrections to curia's own record, both against #29.**

1. **Mid-turn steering does not land in the running turn. It replaces it.**
   `sendPromptToAgent` hardcodes `replaceRunning: true`, which cancels and starts
   a fresh turn; the e2e test is named *"send_message while sleep tool call is
   running starts a clean replacement turn."* There is no message queue in the
   server at all. #29's own report saw this from the other side — it recorded the
   injected message aborting an open `ask_human`, which it called a sharp edge.
   The mechanism is now named: it is not an edge case, it is the design.
2. **There is no per-message attribution.** The timeline item union carries no
   author, sender or source field; `clientMessageId` is de-duplication, and the
   schema comment says so. The inbound request carries no client identity either.
   So #29's "with per-message attribution" is wrong. Attribution exists only in
   Paseo's chat-room subsystem, which attributes *agents*, not human clients. If
   curia needs "who said this", that is an upstream patch.

**Agents never run through a PTY** — `node-pty` appears only under the terminal
package, with zero hits in the agent server code. Terminals are a separate
first-class resource, and even there Paseo documents the same wall this ticket
hit: *"Terminal PTY size is last-interacting-client-wins."*

**Costs:** AGPL-3.0-or-later with a network clause; shell tool output truncated
to 64 KiB; and adopting Paseo means adopting a whole daemon — agent lifecycle,
timeline storage, terminals, chat rooms, a relay — most of which curia already
has.

### Side by side

| | A. `stream-json` | B. ACP | C. Paseo |
| --- | --- | --- | --- |
| two clients observe one live turn | broker | broker (v1); v2 goal, alpha | **native** |
| both inject, one canonical timeline | yes via broker; `priority:"now"` **measured** | yes, via an **unratified** `_meta` extension | yes, but injection **replaces** the turn |
| anything geometry-bound | **no** | **no** | **no** (on the agent path) |
| late joiner | **nothing** — broker owns the log | v1 replay-all; v2 `start` only | **best** — `{epoch,seq}` cursor, gap/stale detection |
| biggest extra loss | trust dialog silently skipped | terminal spec bypassed by both real adapters; v2 alpha | no attribution; AGPL; adopt a daemon curia already has |

---

## Leg 3 — replace the PTY, or sit beside it?

### What the PTY is today, precisely

The PTY is not a viewer curia bolted on. It is where the worker **runs**, and it
is two of curia's own signals:

- `newSession` starts the worker CLI inside tmux
  ([`daemon/src/tmux.mjs:66-71`](../../daemon/src/tmux.mjs)). The session *is* the
  worker process.
- The daemon reads that pane for **readiness** — `capturePane` against a
  per-backend regex made required by #39/#57
  ([`tmux.mjs:87-90`](../../daemon/src/tmux.mjs),
  [`dispatch.mjs:506-559`](../../daemon/src/dispatch.mjs)).
- It reads it again for **usage limits** (`parseUsageLimit`, #13/#39).
- One shared ttyd publishes it, argv-asserted every reconcile
  ([`attach.mjs`](../../daemon/src/attach.mjs), #70), behind one Serve rule.

So "replace the PTY" is not a viewer swap. It means changing **how workers are
run**: a new spawn harness per backend against #39's table, a new readiness
signal, a new usage-limit signal, and the loss of the terminal-only recovery
hand that #29 finding 4 and #35 both needed.

### Measured: the geometry fight is caused by viewing, not by working

Three measurements, all in [`prototypes/dual-geometry/`](../../prototypes/dual-geometry/):

1. A curia-shaped session — `new-session -d` with no `-x`/`-y`, exactly
   `newSession`'s argv — runs at **80x24**, the global `default-size`. **A worker
   nobody watches never changes size.**
2. **`send-keys` drives a session with zero attached clients.** A `cat` in a
   client-less session received `hello from a client-less write path` intact. The
   write path needs no geometry at all.
3. Attaching is what resizes. The window went `100x30 → 159x70` on the PC attach,
   then `→ 47x47` the instant the phone attached.

That reframes the ticket. The worker does not want a size. Only a human looking
at it does. #71's mid-word scrollback corruption is a symptom of the resize, and
the resize is a symptom of **rendering the grid to a person**. Take rendering off
the PTY and both go away at the source, with the PTY untouched.

### The sit-beside mechanism curia already has and has not noticed

Every worker already writes a **complete, structured, geometry-free timeline of
its own run** to a path curia owns.

`CLAUDE_CONFIG_DIR` is set per worker ([`workspace.mjs:306-307`](../../daemon/src/workspace.mjs),
#23/#29), and the CLI writes its session transcript beneath it. Verified against
**real curia workers**, not a lab session — eight of the ten config dirs under
`/home/alp/curia-work/cfg/` carry one. Ticket #67's actual run:

```
cfg/curia-67/projects/-home-alp-curia-work-repos-alp82--alperortac-com-wt-67/
  c0fd0554-75d6-4e82-a2f3-c501394bee81.jsonl        (493 KB)
```

Measured contents: 103 `assistant`, 51 `user`, 16 `attachment`, 12 `last-prompt`,
12 `mode`, 12 `permission-mode`, 8 `system`, 6 `queue-operation`. It carries every
curia tool call by name — `ask_human`, `request_review` (3), `open_pull_request`
(3), `publish_preview`, `report_result` — beside `Bash` (29), `Read`, `Edit`,
`Write`. It carries the worker's own prose, and the human's rejection text coming
back in as a `queue-operation/enqueue`.

The measurement that matters: **zero** occurrences of `"columns"`, `"cursor"` or
`"rows"` across all 493 KB. There is nothing in it to reflow.

**It is written live, and incrementally.** Timestamps across that file are
monotonic (1 out-of-order pair in 185), span the run's full 2 h 58 m, and have a
**median gap of 0.99 s**. Its single largest gap is 9647 s — which is #65's
recorded "block held 2h41m across five nudges", visible in the file as the block
it was. Granularity is **per message, not per token**.

**The gpt lane has its own.** `CODEX_HOME` is the whole config dir
([`workspace.mjs:357`](../../daemon/src/workspace.mjs)), and codex writes
`sessions/2026/07/28/rollout-….jsonl` (219 KB measured): also structured, also
geometry-free, with its own vocabulary — `response_item` (54), `event_msg` (29),
`session_meta`, `turn_context`, `world_state`. The mechanism generalises across
both lanes at the price of a **per-backend reader**, which is the same shape as
#39's per-backend harness table.

This is not a new dependency. It is the same artifact `transcript_path` points at
in every hook payload — the payload curia already consumes for `Stop`
([`workspace.mjs:346`](../../daemon/src/workspace.mjs)).

### So a second surface is possible without touching the first

- **Read**: tail the transcript. Append-only, so a late joiner replays the whole
  run for free — the backlog problem a broker normally has to solve is solved by
  the file being a file.
- **Write**: `tmux send-keys`, which measurement 2 shows needs no client and
  therefore no geometry.

Neither path parses a terminal, which is #29's standing bar. Neither resizes the
pane. Two devices on this surface never meet: they read one file at their own
widths and write to one pane, and the pane never learns either exists.

### Is the second surface a second authority?

No, and the map already says why it must not be. #12 allows two surfaces onto one
worker "as long as the second is not a second authority", and sets the conflict
rule in two tiers: raw keystrokes interleave substrate-natively with no lock,
discrete decisions are first-valid-wins and atomic (#11, exercised live in #34).
A `send-keys` surface lands in tier one — it is the keystroke interleave that
tier already sanctions — and #33's `-a` plus the `^curia-` whitelist already
bound which sessions can be reached.

Discord stays the decision surface, untouched: #73 pass-bar item 6, and #71's
point 1. Escalations, the review gate and the merge gate are journal facts
(#31/#54).

### The answer to leg 3: sit beside

Keep tmux as the execution home, the readiness signal and the usage-limit signal.
Keep the ttyd surface for what it uniquely buys — raw TUI viewing and a hand on
terminal-only dialogs (#29 finding 4) — and accept that it is a
**one-device-at-a-time** surface. That is the honest reading of leg 1: it is one
grid, and #71 refused every way of splitting one grid two ways.

Add the timeline as the **everyday, any-device** surface.

In one line: **the timeline is where you drive; the PTY is where you go when you
need to see the terminal itself.**

Cost, stated going in exactly as #71 required: the timeline is not the raw TUI,
and the touch key-bar (#32, landed by #70) stops being the point on it — a
surface with no grid has no Esc key to send. The key-bar stays on the ttyd page,
where the grid still is.

---

## Ranked recommendation for the prototype

**No mechanism exists that lets two different-sized clients drive one live PTY.
Leg 1 settles that structurally, not provisionally.** So #73 should not shop for
a multiplexer. It should build a **non-PTY timeline surface**, and the ranking
below is about which timeline to build first.

### 1. Timeline fed by the worker's own transcript, driven by `send-keys` — build this first

The cheapest thing that can be put in front of the operator's two devices, and
the only candidate that changes **nothing** about how workers are dispatched.

- Read and write paths are both measured on this box, above.
- Works on **both** lanes today, with a per-backend reader.
- The PTY survives untouched, so readiness, usage limits, raw-TUI viewing and the
  dialog hand all keep working — leg 3's whole argument.
- Curia already owns the fan-out point, the durable journal, and #70's
  asserted-config pattern for shipping a committed page.

Known costs, to be judged live rather than argued: the transcript format is
**undocumented**, so pin the CLI (curia already pins for other reasons) and
expect a loud parse failure rather than a silent one; liveness is
**per-message, not per-token**; and `send-keys` gives the TUI's own queue
behavior rather than structured injection, so there is no `priority:"now"`
equivalent.

### 2. Timeline fed by `stream-json`, curia's daemon as the broker — the graduation path

Everything #1 lacks, at the price of **replacing** the PTY.

Gains: a documented, versioned, capability-negotiated contract; token-level
liveness via partial messages; `--replay-user-messages` making stdout the single
canonical ordering of both clients' inputs; and measured `priority:"now"`
pre-emption for real mid-turn steering.

Costs: the TUI is gone, so `capturePane` readiness, the usage-limit pane read,
raw-TUI attach and the terminal-only dialog hand all need replacing; the gpt lane
needs its own headless equivalent, unverified here; and the trust dialog is
**silently skipped**, which is a posture change to decide deliberately.

**Choosing 1 first is not wasted work if 2 later wins.** The client page, the
fan-out, the journal and the sequence numbering are shared. Only the reader and
the writer swap.

### 3. ACP — the right long-term interop bet, the wrong build today

v2's notification-only lifecycle is designed for exactly this problem and the
spec says so out loud. It is `2.0.0-alpha.2`, both shipping adapters are still
`protocolVersion: 1`, and the two behaviors curia needs escape into an unratified
`_meta` extension. Building on v1 means writing the multi-client machinery **and**
a vendor extension. Revisit when v2 stabilizes.

### 4. Paseo — best design, wrong shape for curia

The only native multi-client fan-out found, and the best late-joiner cursor of
the three. Adopting it means adopting a whole daemon — lifecycle, timeline
storage, terminals, chat rooms, a relay — that curia already has, plus AGPL's
network clause, plus an upstream patch for the attribution it lacks and curia
would want.

### 5. `set -g window-size largest` — the fallback if the prototype fails

One config line, available today, and it closes the actual regression #71
reported: the desktop keeps 159 columns, the phone never reflows it, each client
holds a private cursor-following viewport, and both still type. It fails #73's
pass bar, which refuses panning by name, and the phone reads a layout composed
for 159 columns. It is listed so the fallback is a decision rather than a
scramble.

---

## Corrections this report makes to the record

1. **#71 on `window-size largest`** — not "the top-left corner of 159 columns".
   tmux gives the smaller client its own cursor-following viewport offset, and
   the manual states the offset is a property of the client, not the window.
   Measured here at `offset=40,0` with the large client unchanged.
2. **#29 on Paseo attribution** — the timeline item union has no author, sender
   or source field, and `clientMessageId` is de-duplication. "Message-level
   attach with per-message attribution" is wrong; attribution would be an
   upstream patch.
3. **#29 on Paseo steering** — `replaceRunning: true` is hardcoded, and Paseo's
   own e2e test is named "starts a clean replacement turn". #29 saw the symptom
   and called it a sharp edge; it is the design.
4. **#20/#23 on ACP's sources** — the repo moved to the `agentclientprotocol`
   org, `schema/schema.json` split into `schema/v1` and `schema/v2`, and
   `@zed-industries/claude-code-acp` is deprecated. Also,
   `elicitation/create` **stabilized on 2026-07-24** and is no longer unstable.

## Limits of this report

- Legs 1 and 3 are measured on `alppc`. **Nothing was judged on the operator's
  real phone** — that is #73's job, and #69's lesson is that a narrowed desktop
  window is not a phone.
- The transcript-tail surface is **evidence for a design, not a prototype**. No
  timeline page was built, and no two devices were pointed at one.
- Leg 2's `stream-json` probes ran against Claude Code `2.1.220` on this box, not
  against a curia worker under the real harness.
- `priority: "now"` is undocumented publicly. Its status as a supported contract
  is unknown, and the adapter's "slotting in between tool calls" wording did not
  reproduce — the probe measured pre-emption in every case.
- The codex lane's headless/stream equivalent was **not** investigated. If
  recommendation 2 is ever taken, that is an open question.
