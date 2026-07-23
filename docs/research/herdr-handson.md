# herdr hands-on: empirical re-run against the Orca verification rubric

Resolves [#25](https://github.com/alp82/curia/issues/25) — the [herdr eval](herdr.md) was source-read only; this run boots it and tests the same axes the Orca ([#19](https://github.com/alp82/curia/issues/19)) and Paseo ([#24](https://github.com/alp82/curia/issues/24)) verifications used. Run 2026-07-23.

## Test environment

- **Box**: Alp's desktop (Arch Linux, 32 cores, 91 GB RAM) standing in for the Hetzner box — same stand-in as the Orca/Paseo runs; footprint numbers are machine-independent RSS.
- **herdr**: v0.7.3 stable (system install; source-read covered v0.7.4 — no rubric-relevant changes in between per CHANGELOG).
- **Agents**: Claude Code v2.1.217/218 as the worker CLI, spawned via the socket API.
- **Clients**: full-app `herdr` TUIs hosted in tmux panes (standing in for independent devices) + `herdr agent attach` direct-attach clients + the `herdr <subcommand>` socket-API CLI.
- **Not exercised**: true SSH-loopback attach (`herdr --remote`) — sshd is inactive on this box and starting it needs root. The transport is stock ssh (herdr generates an ssh config wrapping `~/.ssh/config`), so the writer-model results below carry over; the *ergonomics* of phone-over-SSH vs a URL is a HITL question this AFK run can't answer.

## Summary table

| Rubric axis | Orca (#19) | Paseo (#24) | herdr (this run) |
|---|---|---|---|
| Headless boot + footprint | ~1 GB base, Electron (+Xvfb on true headless) | ~0.5 GB base, plain Node | **~12–22 MB base, single Rust binary** |
| Concurrent multi-writer input (#12 filter) | PASS (PTY keystroke level) | PASS (message level) | **PASS** (PTY keystroke level, full-app clients); direct attach is exclusive |
| Server restart mid-turn | FAIL — worker orphaned, unobservable | Worker dies; session resumes with history on next prompt | **Worker dies cleanly (no orphans); auto-relaunches `claude --resume`, full history back; in-flight turn lost** |
| Dispatcher-driveable API | terminal send/read/wait | WS API / CLI / MCP | **PASS — JSON CLI over Unix socket; blocking `agent wait --status` events** |
| Web/URL surface for phone | web client URL (pairing churn) | stable web URLs | **None — SSH only** |
| Voice | host-side STT dictation | daemon-side dictation stream | **None** |

## Exercise 1 — Boot + footprint: lightest substrate candidate by ~25–50×

`herdr server` boots in ~1 s as a **single process at ~12 MB RSS idle**, growing to ~22 MB with six panes, three Claude workers' history, and an attached client. No Electron, no Xvfb, no Node runtime. Per-worker cost is purely the agent CLI (~350–400 MB for Claude Code, same as under any substrate). On an 8 GB Hetzner box the substrate overhead is effectively zero; worker count is bounded by the agents alone.

## Exercise 2 — Multi-device concurrent attach: PASS, with a two-mode writer model

The source-read reported "single-writer per terminal." Hands-on splits that claim in two:

- **Full-app clients are unrestricted multi-writers.** Two independent `herdr` TUI clients focused on the same pane, alternating keystrokes ~0.4 s apart, produced `cli1a cli2a cli1b cli2b` in the pane's input line — every keystroke from both clients, interleaved in send order, no lock, no takeover, no error. A third *direct-attach* client interleaved with them the same way. **The #12 hard filter (concurrent multi-client PTY attach, substrate-native interleave) holds empirically**, at the same keystroke level Orca passed at.
- **Direct attach (`herdr agent attach <target>`) is exclusive.** A second direct attach onto the same terminal is refused: `terminal attach failed: terminal <id> already has an attached client; retry with --takeover`. So the exclusive mode exists but only governs the scoped single-pane attach; the normal client path is fully concurrent.

Practical device model: PC + laptop run full-app clients (co-driving works); the phone needs an SSH terminal app — there is **no URL/web surface** (nothing listens on TCP; the socket is a Unix domain socket reached over ssh). This remains herdr's biggest surface gap vs Orca/Paseo, unchanged from the source-read.

## Exercise 3 — Detach-survival and restart: cleaner than Orca, resume verified live

- **Detach survival: PASS.** Killing every client (tmux server included) left workers running and driveable via the socket API.
- **Server stop kills workers — no orphans, either way.** Workers are direct children of `herdr server`. A graceful `herdr server stop` terminates them; so does `kill -9` of the server (PTY hangup). **Orca's orphaned-worker problem does not exist here** — there is nothing for an orphan sweep to sweep, after graceful stop *and* after a hard crash.
- **Restart restores layout and genuinely resumes agents.** On restart, all panes return with their ids, labels, and cwds. When a client attaches, herdr relaunches each agent pane as `claude --resume <session-id>` — verified live: the resumed worker recalled a codeword from before the kill and correctly reported that its killed-mid-turn bash loop had only completed 4 of 24 iterations. **Resume-with-history is real; the in-flight turn is lost** — exactly the claimed model, and the same recovery class as Paseo (Orca is strictly worse: orphaned + unobservable). Post-SIGKILL recovery behaves identically to graceful-stop recovery.

Three caveats that gate the resume in practice:

1. **Resume is client-attach-triggered, not boot-triggered.** After a server restart, socket-API calls (`workspace list`, `agent list`) return restored metadata but **no agent processes spawn until a full-app client attaches**. A headless dispatcher that wants resume must attach a client (a throwaway `herdr` in a detached tmux works) — or simply keep curia's standing posture: restart ⇒ re-dispatch, and treat resume as a bonus for human-driven sessions.
2. **Resume silently degrades without a current integration hook.** herdr learns the agent's session id via a per-agent hook (`herdr integration install claude` → `~/.claude/hooks/herdr-agent-state.sh`). This box had the hook at v3 (current: v7); with the stale hook, no session ref was reported and restart restored panes as **bare shells at the saved cwd — no resume attempt, no error**. After `herdr integration install claude`, session ids appeared in the API snapshot and resume worked. curia needs an **integration-version preflight** (`herdr integration status --outdated-only`) in the same watchdog family as the auth-health check from #21.
3. **Environment inheritance can silently break resume.** Panes inherit the server's env; a server started from a Claude Code session leaked `CLAUDE_CODE_CHILD_SESSION`/`CLAUDECODE` into workers, which **turned transcript saving off** — resume then relaunched `claude --resume <id>` and fell to a shell with "No conversation found." Sibling of the host-config-inheritance findings (#23/#24): the daemon must scrub worker env and set a per-worker `CLAUDE_CONFIG_DIR`.

## Exercise 4 — Socket API as a dispatcher: PASS, the cleanest driving surface tested so far

Every CLI subcommand is a thin JSON RPC over the Unix socket — trivially parseable, no PTY scraping for control flow:

- **Spawn**: `herdr agent start <name> --cwd PATH --env K=V -- claude ...` returns the pane/terminal ids as JSON. `--env` per spawn makes per-worker `CLAUDE_CONFIG_DIR` isolation first-class.
- **Dispatch**: `agent send <target> "<prompt>"` + `pane send-keys <pane> enter`. Full loop measured: spawn → prompt → `working` event ~0.1 s after Enter → `idle` at 10.5 s → proof file on disk.
- **Wait**: `agent wait <target> --status idle|working|blocked [--timeout MS]` is a **blocking event subscription** (returns the `pane.agent_status_changed` event), and `herdr wait output <pane> --match <regex>` waits on pane content — together the equivalent of Orca's `terminal wait --for tui-idle`, with a real state machine on top.
- **HITL round-trip**: with an isolated config dir (no inherited allowlist), a real permission prompt flipped the agent to **`blocked`** — the event a bridge would subscribe to — and answering via `pane send-keys enter` resumed it to `idle` with the command executed. The escalate→answer→resume primitive works over the socket API with zero custom code.

**But `blocked` detection is permission-prompt-shaped, not HITL-complete.** Two false-idles observed on current Claude Code: the **folder-trust prompt** reports `idle` (a dispatcher waiting on `idle` would dispatch into a dialog — auto-answer on first spawn per cwd, same requirement as Orca #19), and an open **AskUserQuestion dialog** reports `idle` (a grilling worker's question would be invisible to a status-watching bridge). This strengthens the #11 design: HITL must ride curia's own `ask_human` MCP tools, not herdr's screen-derived state; `blocked` is a useful safety net for unexpected permission prompts, not the escalation channel.

Incidentals: `herdr worktree create/list/remove` exists (native git-worktree helpers, like Orca's — untested this run, relevant to the workspace-isolation fog item); `herdr notification show` is local toast only; per-pane env, cwd, split geometry, and labels are all settable at spawn; `herdr api schema` dumps the full RPC schema.

## Verdict for #17

The evidence asymmetry the ticket flagged is gone: herdr now has empirical results on every axis Orca and Paseo were tested on. Hands-on **strengthened** herdr's case on three axes — the multi-writer claim it was partly ruled out on actually **passes** at keystroke level for full-app clients; footprint is ~25–50× below both rivals; restart semantics are the cleanest of the three (no orphans even on SIGKILL, plus real resume-with-history). It **confirmed** the standing gaps: no URL/web surface (phone = SSH terminal app), no voice, no dispatcher/bridge machinery, AGPL, bus factor ~1, and it **added** new operational caveats (attach-triggered restore, silent resume degradation via stale hooks or leaked env, incomplete `blocked` detection). This does not by itself overturn #15/#19 — Orca keeps the browser/mobile surface, dictation, and worktree-native flow; Paseo keeps stable URLs and supervisor auto-respawn — but the substrate weighing in [#17](https://github.com/alp82/curia/issues/17) should now treat herdr as a fully-verified contender whose losses are all *surface* (URL, voice), not *core PTY semantics*, where it is now empirically the strongest.
