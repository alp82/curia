# Paseo hands-on: re-run against the Orca verification rubric

Resolves [#24](https://github.com/alp82/curia/issues/24) — the [Paseo eval](paseo.md) was source-read only; this re-tests it empirically against the same rubric the [Orca verification](orca-headless-verification.md) ran, so the substrate weighing in #17 rests on symmetric evidence. Run 2026-07-23.

## Test environment

- **Box**: Alp's desktop (Arch Linux, 32 cores, 91 GB RAM) standing in for the Hetzner box — same stand-in as the Orca run; footprint numbers are machine-independent RSS.
- **Paseo**: `@getpaseo/cli` **0.1.110** from npm, installed into an isolated prefix; isolated `PASEO_HOME`; daemon started headless (`paseo daemon start --web-ui --no-relay --port 6799`). No display server involved at any point — Paseo is a plain Node daemon, **no Electron, no Xvfb**.
- **Agents**: Claude Code (claude-opus-4-8, bypassPermissions), Codex 0.145.0 (gpt-5.5), pi 0.70.x. Providers auto-detected at boot: Claude, Codex, OpenCode, pi available; copilot not found.
- **Clients**: `paseo` CLI (WS) + the daemon-served web UI in Chrome — two genuinely independent clients on one daemon.

## Rubric result vs Orca, at a glance

| Rubric item | Orca (#19) | Paseo (this run) |
|---|---|---|
| Headless boot | Electron + needs X/Xvfb | plain Node, true headless — **PASS** |
| Base footprint | ~1.0 GB (+Xvfb est.) | **~0.5–0.6 GB** (supervisor ~130 MB + daemon ~300–380 MB + terminal worker ~70 MB) |
| Per Claude worker | ~0.4 GB | ~0.3 GB (`claude` stream-json subprocess) — plus whatever host-config MCPs it inherits (see findings) |
| Multi-client concurrent input | PASS (keystroke interleave, one PTY) | **PASS** (message-level: mid-turn steering from client B lands in client A's running turn; one broadcast timeline) |
| Daemon restart mid-turn | worker survives but **orphaned** — unobservable, undriveable, leaks until killed | worker **dies with daemon**; in-flight turn lost; session **resumes with full history on next prompt** — no orphans, no sweep needed |
| Crash (SIGKILL) recovery | not tested | supervisor **auto-respawns the daemon in seconds**; same clean lose-turn/resume-history behavior |
| Client reconnect after restart | old web client dead (per-instance pairing token); fresh client couldn't render old terminal | old web client **auto-reconnects and re-syncs**, stable URL, no re-pairing (direct/tailnet topology) |
| Non-Claude worker | Codex PASS | Codex **PASS**; pi spawns and streams but blocked by exhausted Anthropic quota (environmental — see below) |
| Voice | dictation-only, host-side STT | dictation + full voice mode surfaces present; daemon-side WS STT confirmed live; audio path untested AFK |

## Boot + footprint

Daemon boots headless in <1 s (bootstrap log: 25 ms to listening), one port serving WS API + HTTP + MCP (`/mcp/agents`) + web UI. Idle footprint ~0.5 GB total across three processes — roughly **half of Orca's ~1 GB**, and with no Xvfb requirement at all, the gap on a real headless box is larger. Local speech models (Parakeet STT + Kokoro TTS) download in the background on first boot (~250 MB+ on disk, one-time).

Per-worker: Claude ~300 MB, Codex `app-server` ~160 MB, pi ~135 MB (lightest). One surprise: the daemon spawned an `opencode serve` (~400–480 MB) on its own at provider detection despite OpenCode never being used — cost of having the provider installed on the box.

## Multi-client concurrent input: PASS (message-level, not keystroke-level)

Setup: one Claude agent; CLI (`paseo send --no-wait`) started a 3-minute bash tick loop; the web client watched the same agent.

- The web client rendered the CLI-initiated turn **live** (running tool, elapsed seconds) with no refresh.
- Mid-turn, the web client sent `MID-TURN-FROM-WEB: … say WEBSAWYOU` — it was **injected into the running turn** (Claude acknowledged it mid-loop), not rejected or queued behind the turn.
- The CLI's `paseo logs` showed the identical merged timeline, both users' messages in order.

Semantics differ from Orca: Orca interleaves **raw keystrokes** into one PTY; Paseo interleaves **structured messages** into one broadcast timeline (agents are message sessions, not TTYs; Paseo terminals are separate shared-PTY objects). For curia's #12 hard filter — multiple devices concurrently driving one live worker, all seeing the same state — the filter **holds**, and arguably in a cleaner form: no lost keystrokes, first-class per-message attribution, and the mid-turn injection is exactly the steering shape curia's escalation flow wants.

## Restart survival: in-flight turn lost, session cleanly resumed — better operational shape than Orca

**Graceful restart** (`paseo daemon stop`, ~30 s downtime, start): the `claude` subprocess **dies with the daemon** (it is a daemon child, unlike Orca's detached PTY daemon). After restart:

- All agent records listed; the mid-turn agent shows `idle` with its **full timeline preserved**, plus an honest marker: *"Background command … was stopped"*.
- Next `paseo send` **resumed the provider session with history intact** — asked what the mid-turn web message told it to say, it answered `WEBSAWYOU` without re-prompting. The interrupted loop itself was gone (LOOPDONE never said) — the in-flight turn is lost, exactly as the source-read predicted.

**Hard crash** (SIGKILL the daemon worker mid-turn): the supervisor process (`DaemonRunner`, "crash restart enabled") **auto-respawned the daemon within seconds** — no external systemd needed for crash recovery. Same recovery shape: turn lost (agent correctly answered NO to "did CRASHLOOPDONE get said"), history-intact resume.

Compare Orca (#19): there the agent process *survives* a serve restart but is permanently unobservable and undriveable — **orphaned, not resumed** — so curia needs an orphan sweep and the API session leaks until killed. Paseo's failure mode is strictly cleaner for curia's already-accepted re-dispatch posture: nothing leaks, nothing needs sweeping, and the conversation context survives for the re-dispatched attempt (`resume-with-history` beats `fresh worker` for continuation prompts).

**Client reconnect**: the pre-restart web client reconnected on its own and re-synced the whole timeline including post-restart turns. URLs are stable across restarts in the direct/tailnet topology — no per-instance pairing token to re-publish (Orca's restart mints a new pairing URL that breaks phone bookmarks). Relay pairing (for non-tailnet access) was not tested; `--no-relay` verified (no relay socket attached).

## Non-Claude worker: Codex PASS; pi plumbing verified, quota-blocked

- **Codex**: `paseo run --provider codex` → booted `codex app-server`, answered, `completed`. The GPT lane works, same as Orca's claim 4.
- **pi** (the ticket's named target): `paseo run --provider pi` spawns pi (~135 MB), forwards the prompt, and streams pi's provider traffic back into the timeline — the integration demonstrably works end-to-end. But every reply died with Anthropic's *"out of extra usage"* 400: pi on this box has only Anthropic auth, and that pool was exhausted account-wide during the run (tried fable-5 default and haiku override; failure is the account, not Paseo — the same error would hit pi standalone). Model/provider **selection** from the dispatch call (`--provider pi --model …`, echoed in `paseo ls` as `pi/anthropic/claude-haiku-4-5`) is confirmed wired. A completed pi turn needs a non-Anthropic key in pi's auth — retry is cheap once one exists.

## Voice: surfaces live, audio path untested

- Web client exposes **Start dictation** and **Enable Voice mode** on every agent composer; daemon logs confirm local STT/TTS providers reconciled at boot (`parakeet-tdt-0.6b-v2-int8`, `kokoro-en-v0_19`, auto-downloading).
- Clicking dictation in the browser opened a real `dictation_stream_start` over the WebSocket and the daemon answered `dictation_stream_error` — expected with no microphone, but it proves the **daemon-side** dictation pipeline is reachable from a plain web client against a headless daemon.
- Not tested AFK: actual speech→text (no mic on the test rig) and the phone app. Paseo's docs make phone dictation + full **voice mode** (two-way conversation w/ TTS) the designed path — a strict superset of Orca's dictation-only if it holds up; needs a HITL phone check to close.

## Incidental findings

- **Host-config inheritance (again)**: the Claude worker is a plain `claude` subprocess with `--setting-sources=user,project,local` — it inherited the host's `~/.claude` wholesale and auto-spawned the host's chrome-devtools MCP (~430 MB extra RSS). Same class of finding as #23's adapter test: curia must give workers a per-worker `CLAUDE_CONFIG_DIR` regardless of substrate.
- `--mode` strings are provider-specific and unvalidated-friendly (`bypass` rejected with the valid list — `bypassPermissions` for Claude); error reporting is clean JSON.
- `paseo run` defaults `--cwd` to the caller's cwd even when `--workspace` is given — a dispatcher should always pass `--cwd`/`--worktree` explicitly.
- The source-read's "idle runtimes are GC'd after 2 minutes" did **not** reproduce: an idle Claude runtime stayed resident ≥8 minutes (still alive when observation ended). Plan RAM as if parked workers stay resident, same as Orca; the lazy `--resume` spawn (observed on the post-restart revive) still means *stopped* workers cost nothing.
- Speech-model downloads restart from zero after a daemon restart and leave orphaned `.tmp` files in `models/local-speech/.downloads` — harmless, but first-boot on a slow link should be left undisturbed.
- The daemon emits rich `ws_runtime_metrics` JSON every 30 s (per-message-type counts, latencies, per-agent stream stats) — free observability for curia's watchdog.
- `paseo run --output-schema` (JSON-schema-forced output) and `--label key=value` exist — useful dispatch primitives the source-read missed.

## Consequences for the #17 weighing

Symmetric evidence now exists, and it does **not** simply confirm the Orca pick:

1. **Both pass the #12 hard filter** empirically — Orca at keystroke level, Paseo at message level. If message-level co-driving satisfies #12's intent (it matches how curia actually drives workers: prompts, steering, escalation answers — not raw keystrokes), Paseo is no longer excluded on the filter.
2. **Restart story favors Paseo**: clean lose-turn/resume-history + supervisor auto-respawn + reconnecting clients + stable URLs, vs Orca's orphaned PTYs, required orphan sweep, and per-restart pairing-URL churn. Under curia's re-dispatch posture, Paseo's recovery is less custom code (no orphan sweep, no URL re-publisher).
3. **Ops profile favors Paseo**: half the base RAM, no Electron/Xvfb, single port, per-message metrics.
4. **Orca's remaining unique strengths**: true PTY semantics (a human can watch the raw TUI exactly as a terminal), native per-worker git worktrees as a first-class CLI verb, mobile app with image attach verified, and `terminal wait --for tui-idle` as a worker-state primitive. Paseo counters with `paseo wait`/`--output-schema` at message level and `--worktree` on run (not exercised this session).
5. Standing Paseo caveats from the source-read remain: AGPL-3.0, bus factor ~1, pre-1.0 churn.

This run does not overturn #15/#19 by itself — but it removes the asymmetry those conclusions leaned on, and on the restart axis Paseo now holds the empirical edge. The substrate call in [#17](https://github.com/alp82/curia/issues/17) should weigh PTY-fidelity + worktrees + mobile app (Orca) against restart hygiene + footprint + resume-with-history (Paseo).
