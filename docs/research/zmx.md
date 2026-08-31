# zmx as Curia's terminal host

Date: August 30, 2026. Candidate: [neurosnap/zmx](https://github.com/neurosnap/zmx). Question: can zmx replace Curia's tmux wrapper? Sources: zmx's repository, releases, source, and issue tracker, plus Curia's source and decisions cited inline. The hands-on check used only `/tmp`.

## Recommendation

**Don't replace tmux with zmx now.** zmx matches Curia's one-session-per-conversation model better than a full multiplexer, and its terminal restoration is stronger. However, the replacement would weaken Curia's failure evidence and add lifecycle work at the current release.

Keep zmx on the shortlist. Reconsider it after a bounded adapter spike and upstream releases close the control-contract gaps. The spike should not begin as a migration.

The deciding issue isn't whether zmx can hold a shell. It can. The issue is whether Curia can safely distinguish a live session, an absent session, and a broken control path. Curia treats that distinction as a data-safety boundary. zmx v0.7.1 doesn't provide a dependable machine-facing boundary for it.

## What the current wrapper does

Curia's terminal boundary is [`daemon/src/tmux.mjs`](../../daemon/src/tmux.mjs), not tmux's window manager. The wrapper exports a small, session-oriented contract:

| Responsibility | Current behavior | Why Curia depends on it |
| --- | --- | --- |
| Presence and discovery | `hasSession()` and `listSessions()` classify known absence separately from indeterminate control failures. | Reconcile must not read a broken host as zero live agents and remove their state ([source](../../daemon/src/tmux.mjs#L28-L75)). |
| Detached launch | `newSession()` starts one exact-named session in a working directory, passes environment values, and keeps the pane inspectable after the harness exits. | Dispatch launches the sandbox command inside the terminal host and records a nonce-bound exit marker ([source](../../daemon/src/tmux.mjs#L77-L111), [dispatch use](../../daemon/src/dispatch.mjs#L1718-L1736)). |
| Capture | `capturePane()` returns the active terminal text for one exact session. | The watchdog reads readiness, provider limits, dialogs, and early process death from the terminal tail ([source](../../daemon/src/tmux.mjs#L113-L126), [watchdog](../../daemon/src/dispatch.mjs#L3279-L3350)). |
| Controlled input | `sendText()`, `sendKey()`, and `sendDialogOption()` serialize writers, pace text and Enter, refuse input during an active turn, and confirm activity by reading the pane again. | Timeline, conversation, correction, rewind, and dialog paths all drive the same terminal safely ([source](../../daemon/src/tmux.mjs#L132-L278), [conversation runtime](../../daemon/src/conversationruntime.mjs#L1-L15)). |
| Termination | `killSession()` kills the exact session and clears its write queue. | Cancel, bounded respawn, parking, and cleanup share the operation ([source](../../daemon/src/tmux.mjs#L128-L130)). |
| Browser attach | A whitelisting wrapper attaches ttyd to the named session over a shared socket. Multiple browsers see the same terminal. | The URL session argument is untrusted, and the attach surface must survive daemon restarts ([attach wrapper](../../daemon/bin/curia-attach.sh), [compose services](../../deploy/compose.yaml#L114-L186)). |
| Host survival | A separate `tmux` container owns the server. The daemon and ttyd are clients over a shared socket volume. | Restarting Curia's daemon leaves agent panes running ([deployment decision](../adr/0003-tmux-ttyd-tailscale-worker-host.md), [compose service](../../deploy/compose.yaml#L114-L145)). |

This contract is only 278 lines, but it has 377 lines of focused tests. Most complexity handles Curia-specific correctness, not tmux syntax ([wrapper](../../daemon/src/tmux.mjs), [tests](../../daemon/test/tmux.test.mjs)). Replacing the binary doesn't remove write pacing, active-turn checks, bracketed paste, dialog navigation, exit evidence, or watchdog classifiers.

## Where zmx fits

zmx deliberately provides named attachable sessions without windows, tabs, panes, or splits. It supports detached commands, raw input, plain-text history, multiple clients, and restored terminal state ([zmx features and commands](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/README.md#features)). That scope matches Curia well: Curia gives each conversation one terminal session and doesn't use tmux layouts.

The following mapping is plausible:

| Curia operation | zmx operation | Fit |
| --- | --- | --- |
| Start an exact session | `zmx run <name> -d <command...>` | Good for headless creation. `run` creates a bash session when needed and records task completion ([v0.7.1 changelog](https://github.com/neurosnap/zmx/blob/v0.7.1/CHANGELOG.md#v070---2026-07-23), [implementation](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/src/main.zig#L1826-L1912)). |
| List sessions | `zmx list --short` | Good for exact names. Full `list` output is tab-separated text, not a structured API. An open request asks for machine-readable output ([issue #220](https://github.com/neurosnap/zmx/issues/220)). |
| Capture terminal text | `zmx history <name>` | Promising. It returns plain text from zmx's terminal model and scrollback, which is richer than tmux's visible pane capture ([README](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/README.md#features)). Curia's live classifiers still need verification against this rendering. |
| Send text and keys | `zmx send <name> <bytes...>` | Good primitive. It sends raw PTY input without claiming client leadership as of v0.7.0 ([changelog](https://github.com/neurosnap/zmx/blob/v0.7.1/CHANGELOG.md#v070---2026-07-23)). Curia must keep its queue, pacing, and key-to-byte mapping. |
| Kill | `zmx kill <name>` | Functional, but released error signaling is unsuitable for reconciliation. |
| Attach through ttyd | `zmx attach <name>` | Partial fit. zmx supports multiple clients and restores terminal state ([README](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/README.md#features)). However, `attach` creates a missing session, while Curia's URL path must attach only to an existing one ([upsert behavior](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/README.md#ssh-workflow)). The wrapper must also unset inherited `ZMX_SESSION`, because nested attach switches the caller instead of creating a client ([nested-session warning](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/README.md#nested-sessions)). |

zmx improves multi-device geometry. Its last client to send input becomes the leader and controls terminal size. Other clients stay read-only until they send input ([v0.5.0 changelog](https://github.com/neurosnap/zmx/blob/v0.7.1/CHANGELOG.md#v050---2026-04-16)). Curia's current tmux window has one shared size, and each attach resizes it ([Curia measurement](dual-geometry-attach.md#measured-the-geometry-fight-is-caused-by-viewing-not-by-working)). The zmx policy still changes size between devices, but it prevents a passive viewer from taking control.

zmx also restores terminal state with `libghostty-vt`. Each session has its own daemon and Unix socket. The daemon copies PTY output to clients and the terminal model, then sends a snapshot when a client reconnects ([implementation overview](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/README.md#impl)). That design offers better reattach behavior and native terminal scrollback than tmux's grid.

## Hands-on check

The check used the official `zmx-0.7.1-linux-x86_64.tar.gz` release in an isolated `ZMX_DIR` and `XDG_STATE_HOME` under `/tmp`. The archive's SHA-256 was `ec82d753e12537b79a76bce73399d57698e529f4744eb5a1a9bcfa6fda7c4b25`, which matches the [v0.7.1 release asset](https://github.com/neurosnap/zmx/releases/tag/v0.7.1). The release resolves to commit [`1cea103f`](https://github.com/neurosnap/zmx/commit/1cea103fef83cd53586fcb2c5f90d693fc9f5a30). Source comparison used main commit [`0266042c`](https://github.com/neurosnap/zmx/commit/0266042ca8f399c9d76825739b93443e2d5bf47a).

| Check | Observed result |
| --- | --- |
| Detached launch | `zmx run alpha -d sh -c ...` returned 0, created one session, ran the command, and left `clients=0`. |
| Duplicate exact name | A second detached `run alpha` reused the same session and executed there. `list --short` still returned one `alpha`. |
| Empty and absent state | Empty `list` returned 0, printed nothing to stdout, and wrote “no sessions found” to stderr. Missing `history` returned 1. Missing `send` printed an unresponsive-session error to stdout but returned 0. Missing `kill` returned 0 without output. |
| Raw input | Sending command text did not execute it. Sending a separate carriage return executed it. This is the primitive Curia needs for its paced text-plus-Enter path. |
| History | `history alpha` returned the prompt, commands, output, and zmx task-completion markers as plain text. |
| Two clients | Two pseudo-terminal clients attached simultaneously. `list` reported `clients=2`; both detached with status 0. |
| Client-exit survival | After both clients detached, the session remained present with `clients=0`, and its history remained readable. |

The successful checks show that the data path fits. The absent-state results show that the released control path doesn't. Main's staged changelog says CLI commands now return correct error exit codes, but that change isn't in v0.7.1 yet ([staged changelog](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/CHANGELOG.md#staged)). Even after release, Curia needs a test that distinguishes absence from an unresponsive socket. An exit-code fix alone doesn't establish that three-state contract.

## Migration cost

The product-code change is medium to large, despite the small command mapping.

1. **Replace the adapter and its tests.** Keep Curia's serialization and confirmation logic, but replace tmux targets with zmx commands. Map named keys such as `Escape`, `Up`, and `Enter` to raw bytes. Revalidate every harness classifier against `zmx history` output.
2. **Add a dedicated zmx host service.** A zmx daemon inherits the cgroup of the process that creates it. An open defect documents detached sessions dying with their spawning service ([issue #226](https://github.com/neurosnap/zmx/issues/226)). If the Curia daemon starts zmx locally, a daemon container recreation can kill the session. Curia therefore needs to create each session inside a separate long-lived host container, likely through `docker exec`, while sharing zmx's socket directory with daemon and ttyd clients.
3. **Change the attach image and wrapper.** Install zmx in the host, daemon, and ttyd images. Replace the socket volume and `tmux attach` command. Keep the existing name whitelist and explicitly unset `ZMX_SESSION` before attach. Add an atomic attach-only path. A check followed by `zmx attach` has a race: if the session ends between them, `attach` creates a new session inside the ttyd service instead of refusing the URL.
4. **Change deployment rules.** zmx warns that an IPC-changing upgrade can kill all sessions because a new client can't communicate with an old session daemon ([known issues](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/README.md#known-issues)). Pin one version across all three clients and the host. Upgrade only at zero live conversations.
5. **Re-prove restart and recovery.** Curia's current server has one known socket and one keeper process. zmx has one daemon and socket per session. Boot reconciliation, stale-socket handling, host health, and post-mortem evidence all change.

Using `zmx attach <name> <command>` instead of detached `run` doesn't avoid these costs. Open issues report that an instant command can lose output before the first client connects and that attach doesn't return the child's exit status ([issue #246](https://github.com/neurosnap/zmx/issues/246), [issue #247](https://github.com/neurosnap/zmx/issues/247)). Curia needs early launch output and exit evidence, so the detached bash plus history path is the safer candidate.

## Risks

### The machine contract is still forming

zmx exposes a CLI, not a supported library or protocol. A library discussion remains open, and contributors specifically identify structured discovery, definitive child exit, and atomic headless creation as missing downstream seams ([issue #127](https://github.com/neurosnap/zmx/issues/127)). Structured command-output retrieval is also only a proposal ([issue #244](https://github.com/neurosnap/zmx/issues/244)).

The full `list` schema is already changing from `start_dir` to `cwd` on main, and recent minor releases carry breaking changes ([staged and release changelog](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/CHANGELOG.md)). Curia can parse `--short` for names, but it must not build safety decisions on the full text format without a pinned parser and fixtures.

### Some failures can destroy a session

An open issue traces a nested `attach` with no leader through a daemon error that tears down the session and its PTY process group ([issue #249](https://github.com/neurosnap/zmx/issues/249)). Curia can avoid that exact path by unsetting `ZMX_SESSION`, but the issue notes that daemon message handlers propagate errors through one loop. This raises the cost of depending on an undocumented IPC boundary.

### Terminal rendering changes the watchdog input

`zmx history` serializes `libghostty-vt` state, while tmux `capture-pane` serializes tmux's grid. Curia's readiness and provider-failure matches read the bottom of that text. The smoke test proves ordinary shell text, not Claude Code and Codex composers, trust dialogs, usage-limit screens, or early Docker failures. A replacement needs live fixtures for all of those states.

### The project is active but young

zmx is not abandoned. GitHub records 457 commits, a push on August 30, 2026, and releases on May 29, July 23, and August 27, 2026 ([repository metadata](https://api.github.com/repos/neurosnap/zmx), [releases](https://api.github.com/repos/neurosnap/zmx/releases?per_page=20)). Its contributor list is broad, but the repository credits 360 commits to `neurosnap`; the next contributor has 13 ([contributors](https://api.github.com/repos/neurosnap/zmx/contributors?per_page=100)). The maintenance signal is strong, while the bus factor and rapid 0.x contract changes remain material for Curia's process host.

### Licensing is compatible

zmx uses the MIT License ([license](https://github.com/neurosnap/zmx/blob/0266042ca8f399c9d76825739b93443e2d5bf47a/LICENSE)). Curia can redistribute a pinned binary or source build if it retains the copyright and permission notice. Licensing doesn't block adoption.

## A testable reconsideration gate

Reopen the replacement only when an upstream release and a Curia spike meet all of these gates:

1. **Three-state discovery:** exact live, exact absent, and unresponsive or malformed socket produce distinct, asserted results. No failure path may collapse to “absent.”
2. **Host survival:** create a session through the proposed host service, restart the Curia daemon and ttyd, and prove the harness process, history, and control socket survive. Then recreate the host only at zero sessions.
3. **Launch evidence:** start a missing harness binary and a command that exits 0. In both cases, detect completion and preserve the reason without waiting for the readiness timeout.
4. **Classifier parity:** capture live Claude Code and Codex composers, trust dialogs, usage limits, and active-turn indicators through `zmx history`. Run the existing harness classifiers unchanged or document the minimal required changes.
5. **Input parity:** prove paced text plus Enter, bracketed multiline paste, Escape, cursor navigation, atomic dialog selection, concurrent sends, and post-send active readback.
6. **Attach parity:** attach PC and phone clients through ttyd, verify the name whitelist, and prove that an absent or concurrently ending session can't be created from the URL. Prove passive-client geometry behavior, switch the leader by typing, detach both, and reattach with restored state.
7. **Fault containment:** exercise a stale socket, wrong-version client, inherited `ZMX_SESSION`, and a malformed control request. None may kill a healthy session or authorize cleanup.
8. **Upgrade rule:** pin one zmx artifact and verify its digest in the image. Test a zero-session upgrade and document why a mixed-version deployment is impossible.

If the spike passes all eight gates, zmx becomes a credible replacement. Its simpler session model, terminal restoration, and client-leader geometry would then justify an ADR that supersedes ADR-0003. Until then, tmux remains the better terminal host for Curia because its adapter has already encoded and tested Curia's safety contract.
