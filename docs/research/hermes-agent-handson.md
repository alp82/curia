# Hermes Agent — hands-on trial of the adopt branch

Date: 2026-07-23. Ticket: [#21](https://github.com/alp82/curia/issues/21). Feeds the build-posture decision ([#17](https://github.com/alp82/curia/issues/17)). Companion to the source-read eval [hermes-agent.md](./hermes-agent.md).

**What this is:** the [source-read eval](./hermes-agent.md) was code-reading only — hermes had never been booted. This report boots it for real and reports how the *adopt hermes* branch of #17 actually feels to live with. Honesty rules per the shared rubric: claims below are separated into **verified hands-on**, **verified by inspection**, and **not tested**.

## TL;DR

- The install already existed on Alp's PC (`/opt/hermes-agent`, `hermes` on PATH, `~/.hermes` configured back in April/June) — so this is a trial of a *lived-in* install, not a cold one.
- **The dispatcher is real and it works.** I ran a task end-to-end through the kanban dispatcher: `ready → assigned → claimed(lock+expiry) → spawned(pid) → heartbeat → completed(summary+artifacts)`, worker wrote the exact proof file, self-reported `complete`, exited clean. **24 s wall time.** This is curia's frontier→dispatch→worker loop, working, today.
- **Crash recovery works**, with a nuance: I `kill -9`'d a live worker; the dispatcher detected the dead PID (`crashed{pid, claimer}`) and re-spawned a fresh run — but **not on the first tick after spawn** (there's a grace window; an immediate re-dispatch reported 0 crashed). Recovery is a dispatch-tick event, not instantaneous.
- **Footprint is small:** ~388 MB install, ~22 MB state, **~171 MB RSS per active worker** (gpt-4.1, mid-task). An 8 GB Hetzner box runs this comfortably.
- **The big blocker to a live trial is auth, not hermes.** The configured provider (Nous Portal) had **expired in April** (key exp 2026-04-19). I got live turns only by discovering hermes rides the **GitHub Copilot OAuth pool** (`gh auth token`) as a zero-extra-key model source — a fact the source-read missed and one that's directly useful to curia's multi-provider quota story (#13).
- **The Discord HITL round-trip is VERIFIED end-to-end** (Alp wired a bot mid-session): a worker's `clarify` tool rendered **buttons** in Discord, Alp clicked **Yes**, the tool **blocked 14 s** waiting on the human, then resumed the agent — exactly curia's #11 escalation contract, working. Voice-memo **ingestion** is verified (the `.ogg` arrives and the STT path fires) but local Whisper wasn't installed on this box, so transcription itself is unproven (a setup-friction finding, not a design gap).

---

## Environment

- **Version:** Hermes Agent **v0.18.2 (build 2026.7.7.2)**, project at `/opt/hermes-agent`, Python 3.11.14, OpenAI SDK 2.24.0. (One commit behind head at test time.)
  - *Source-read correction:* the eval cited "latest `v2026.7.20`". That calver is the **update channel** tag; the installed pip package reports a **semver `0.18.2`**. Both exist; don't conflate them when pinning.
- **Box status:** Tailscale was **logged out**, so the Hetzner box was unreachable. Per the ticket ("or locally if the box isn't ready"), everything below ran **locally on Alp's PC**.
- **Repo reality check (source-read confirmed):** `NousResearch/hermes-agent` is real — GitHub API at test time: **218,942 stars**, 41,478 forks, ~24.7k open issues, MIT, ~517 MB, pushed same day. The source-read's headline stats hold. (The star count is extraordinary enough that I verified the repo exists before trusting anything downstream; it does.)

## Setup friction (the honest part)

`hermes doctor` on a real, used install still reports **4 issues** and a wall of `⚠`:

- `discord`/`discord_admin` — **missing `DISCORD_BOT_TOKEN`** (bridge inert until a bot is registered).
- `browser-cdp`, `computer_use`, `image_gen`, `vision`, `video`, `web`, `x_search`, `spotify`, `homeassistant`, `feishu_*` — each gated behind a system dep or an API key. Out of the box, **most tool categories are dark** until you feed them keys.
- Model auth expired silently (see below) — nothing warned until a turn failed.

Takeaway for the *adopt* posture: hermes is not "install and it's all lit up." The dispatcher/kanban/terminal/memory core works with zero extra keys, but every *peripheral* (search, vision, browser, Discord) is a separate credential chore. Budget real setup time.

### Auth is short-lived and fails closed

The configured provider was **Nous Portal**, model `xiaomi/mimo-v2-pro`. Its token had **expired months ago**:

```
Access exp: 2026-04-18   Key exp: 2026-04-19    (today: 2026-07-23)
```

The Nous tokens are short-lived (the recorded key had roughly a **1-day** life). Result: **every agent turn failed** with `agent failed: No access token found for Nous Portal login` — and nothing surfaced the expiry until a turn was attempted. For an always-on unattended overseer, **silent model-auth expiry is an operational hazard** worth a health-check/watchdog in curia's own daemon. (Not surfaced in the source-read.)

### Undocumented rescue: the GitHub Copilot credential pool

`hermes auth` revealed a **credential pool** with a `copilot` entry backed by `gh auth token`. This is the lever that made a live trial possible with **no new keys**:

```
hermes --provider copilot -m gpt-4.1 -z "..."   →  live completion
```

So hermes can use **GitHub Copilot's model access via the local `gh` OAuth** as a first-class provider. For curia this is a genuinely useful finding: it's another **provider lane for the #13 routing/quota story** (Copilot models alongside Nous/Anthropic/GPT), available on any box where `gh` is logged in, no extra secret to manage.

## End-to-end dispatch — VERIFIED HANDS-ON

Setup: temporarily pointed the model block at `provider: copilot / gpt-4.1` (backed up and **restored** afterward), created an isolated scratch board `handson`, and a task with a pinned `dir:` workspace so I could inspect the artifact.

Task: *"Create `proof.txt` containing exactly `HERMES_DISPATCH_OK`, then call the kanban complete tool."*

The dispatcher (`hermes kanban dispatch`) refused it until it had an **assignee** (a profile) — `Skipped (unassigned)`. After `assign … default`, dispatch spawned a worker. Event log, verbatim:

```
created {assignee: None, status: ready}
assigned {assignee: default}
[run 1] claimed {lock: alppc:2028325, expires: …, run_id: 1}
[run 1] spawned {pid: 2028351}
[run 1] heartbeat
[run 1] completed {summary: "Created proof.txt containing exactly 'HERMES_DISPATCH_OK'.",
                   artifacts: [".../proof.txt"]}
```

`proof.txt` contained exactly `HERMES_DISPATCH_OK`. Wall time **24 s**. Every piece of the source-read's dispatcher description — atomic claim with lock+expiry, PID recorded at spawn, heartbeat, self-reported completion with artifact capture — **is real and observable**. Curia's "read frontier → dispatch worker on one ticket" maps 1:1 onto `assignee + ready → dispatch_once`.

**The worker spawn line (verbatim), which nails the source-read's `_default_spawn`:**

```
/opt/hermes-agent/venv/bin/hermes -p default --accept-hooks \
  --toolsets browser,clarify,code_execution,cronjob,delegation,file,image_gen,\
kanban,memory,session_search,skills,terminal,todo,tts,vision,web \
  chat -q work kanban task t_330df63f
```

Note `kanban` is injected into the worker's toolset (matches doctor's "kanban runtime-gated; loaded only for dispatcher-spawned workers"). The worker **is a Hermes agent** — confirming the source-read's central caveat: dispatched workers are `hermes chat` processes, **not** Claude Code/Codex. To make a worker *be* Claude Code you still go through the terminal PTY tool (untested here) or run claude-agent-acp separately (see #20/#23).

## Crash / restart recovery — VERIFIED HANDS-ON (with nuance)

I created a longer task (`sleep 90`), dispatched it, captured the worker PID, and `kill -9`'d it.

- **Immediate re-dispatch:** `Crashed: 0, Reclaimed: 0, Spawned: 0` — the task stayed `running` on a still-valid claim. So crash detection is **not** instantaneous; there's a grace window after spawn before a dead PID is trusted as crashed (sensible — avoids racing a just-forked child).
- **A re-dispatch a bit later:** `Crashed: 1, Spawned: 1`. Event log:

```
[run 2] spawned {pid: 2036777}
[run 2] crashed {pid: 2036777, claimer: alppc:2036625}
[run 3] claimed {lock: alppc:2040259}
[run 3] spawned {pid: 2040320}
```

So: dead worker → detected via PID → task reclaimed → **fresh run re-spawned**, bounded by `max-retries` (default 2). This is the worker-supervision half of the source-read's "restart survival" claim, **confirmed empirically**. The *gateway*-level resume (synthesizing a `MessageEvent` for `resume_pending` sessions) I did **not** test — it needs the long-lived gateway running a live mid-turn session, which in turn wants the platform adapters; deferred.

## Footprint — VERIFIED HANDS-ON

| Thing | Size |
|---|---|
| Install (`/opt/hermes-agent`, incl. venv) | **388 MB** |
| State (`~/.hermes`: sessions, state.db, memories, kanban) | **22 MB** |
| Active worker RSS (gpt-4.1, mid-task) | **~171 MB** (VSZ ~390 MB) |

The source-read listed footprint as an unknown; this closes it. Base + a couple of concurrent workers is a few hundred MB — an **8 GB Hetzner box is comfortable**, even running several workers alongside the gateway and local whisper.

## Discord HITL round-trip — VERIFIED HANDS-ON (buttons); voice partial

Alp registered a bot mid-session and dropped `DISCORD_BOT_TOKEN` into `~/.hermes/.env`. From a cold `hermes gateway run` the bridge came up clean: `[Discord] Connected as CuriaBot#1524`, registered a `/skill` command with 68 skills, synced **55 slash commands** into the guild, built a **12-target channel directory**, and the **embedded kanban dispatcher held its singleton lock and ticked** — i.e. the *entire adopt-branch stack* (dispatcher + bridge) runs in one gateway process, confirmed live.

**Auth gating (map Notes: "bot obeys only Alp's user ID") — verified by failure then success.** With no allowlist, an inbound DM was **denied**: `Discord messages are being denied because no allowlist is configured`. After setting `DISCORD_ALLOWED_USERS=<Alp's id>` and restarting, the same user's commands went through with **no "Unauthorized" warning**. So the gate is a real, enforced env allowlist keyed to the numeric Discord user ID — exactly the shape curia's Notes call for. (An unknown user is *denied outright*; this build did **not** auto-issue a pairing code on a cold DM — `hermes pairing` exists but is a separate opt-in flow.)

**The button round-trip (the #11 escalation contract), from the logs, verbatim:**

```
13:42:49  inbound message: platform=discord user=Alper msg='Use the clarify tool to ask me: proceed with deploy? yes or no'
13:42:55  conversation turn: model=gpt-4.1 provider=copilot platform=discord   (agent calls clarify → buttons render in Discord)
13:43:12  [Discord] Discord clarify button resolved (id=a768126eaa, choice='yes', user=Alper, ok=True)
13:43:12  agent.tool_executor: tool clarify completed (14.05s, 94 chars)     (blocked 14s on the human, then resumed)
13:43:17  [Discord] Sending response (184 chars)
```

This is precisely the escalation shape curia's #11 specifies — worker calls a **blocking** `ask_human` (here `clarify`), the question renders as **buttons** in Discord, the human's click resolves it, and the answer resumes the same agent turn. **The "bridge is free" claim from the source-read holds where it matters most: the HITL button loop works with zero custom code.**

**Voice memo — ingestion PASS, transcription UNPROVEN (setup, not design).** A voice memo sent to the bot was received as `~/.hermes/cache/audio/audio_*.ogg` and the gateway invoked its STT path — but `stt.provider: local` had **no faster-whisper installed**; hermes tried to *lazy-install* it on the fly, that didn't land in time, and the turn fell back to `[voice message could not be transcribed]`. Installing faster-whisper needs a **sudo** write into the root-owned `/opt/hermes-agent/venv`, so a clean pass was deferred by operator call. Net: the voice *pipeline* (attach → cache → transcribe-attempt → feed agent) is wired and fires; the local Whisper *backend* is a separate install step this box lacked. `doctor` does not flag it because STT is runtime-lazy — another silent-gap trap for an unattended deploy.

## Two corrections / additions to the source-read

1. **`hermes serve` exists** — a headless **JSON-RPC/WebSocket backend on :9119** that "the desktop app and remote clients connect to" (June-2026 hardening: a public bind *requires* an auth provider; the intended pattern is bind `127.0.0.1` + tunnel — i.e. exactly curia's `serve + Tailscale` model). This **softens** the source-read's "multi-device viewing is delegated to Discord": there *is* a remote-client server. **But** it does not overturn the #12 ruling — this is a desktop-app/client protocol, not verified to be concurrent multi-*writer* PTY attach to one live session (the #12 hard filter). It remains a viewing/control API, not tmux-grade co-driving. Untested here beyond reading the CLI contract.
2. **`hermes acp` is hermes-as-agent, not hermes-as-orchestrator.** It starts hermes **in ACP mode for editor integration** (VS Code / Zed / JetBrains) — i.e. an ACP *agent* an editor drives. It is **not** a seam for hermes to drive Claude-Code-as-worker over ACP. Don't mistake its presence for "hermes speaks ACP to its workers." (The claude-agent-acp worker path is #20's territory, orthogonal to hermes.)

Also worth flagging for #17: this install already has **`herdr-agent-state` and `orca-status` plugins enabled** — hermes has a live plugin system and Alp has already bridged it to two other candidates. If the posture lands on "hermes as dispatcher + Orca as substrate," hermes reading Orca/herdr worker state via plugins is a real, already-present integration point.

## Verdict for the #17 adopt branch

**The dispatcher half of "adopt hermes" is de-risked.** The kanban dispatcher — claims, heartbeats, PID-crash reclaim, retries, artifact capture, isolated per-task workspaces — is not a promise in a README; I watched it run and recover. Curia's frontier→dispatch loop genuinely already exists inside hermes.

**What adopting hermes still costs curia, now with hands-on weight:**

- **Workers are Hermes agents, full stop.** Claude Code/Codex enter one level down (PTY terminal tool) or not through hermes at all (claude-agent-acp, #20). Confirmed by the spawn line.
- **Peripherals are a credential slog** and **model-auth can expire silently and fail closed** — an always-on overseer needs its own auth-health watchdog. (New, from this trial.)
- **No tmux-grade multi-writer session attach** — `serve` is a client/server API, not the concurrent-PTY co-drive #12 requires. Consistent with #12 having already ruled hermes out of the worker/overseer-host slot; this trial gives no reason to reopen that. Hermes stays a **dispatcher + Discord-bridge** candidate, not a substrate.
- **GitHub sync is still curia's to build** — hermes's board is SQLite; curia's truth is GitHub issues (#7/#9/#10). Adopting hermes means either syncing GH↔kanban or driving `dispatch_once` from a custom frontier feed.

**The bridge half is also de-risked now.** The Discord HITL button loop — hermes's headline "you don't build the bridge" claim — ran end-to-end with zero custom code: blocking `clarify` → buttons → human click → resume, plus an enforced user-ID allowlist matching curia's gating requirement. That's two of curia's three roles (dispatch + bridge) demonstrated live in a single gateway process.

Net: nothing here weakens hermes as the strongest **dispatcher+bridge** anchor; the trial *strengthens* it on both halves (dispatcher and Discord HITL both demonstrably work, footprint is fine). The open question #17 must still weigh is **thin-custom vs adopt** given the "workers are Hermes agents" tax and the GH-sync work — not whether the dispatcher or bridge is trustworthy. They are.

## Not tested (honest gaps)

- Voice-memo **transcription** (the STT backend) — pipeline fires but faster-whisper wasn't installed (root-owned venv, sudo required); deferred by operator call.
- Gateway-level restart *resume* (the `resume_pending` MessageEvent replay) — needs the long-lived gateway + a live platform session.
- Claude Code driven as a worker via the PTY terminal tool — the "how rough in practice" question; not exercised (would be a trial in its own right; partly overlaps #23's ACP path).
- Cron catch-up after downtime — no cron jobs configured; not exercised.
- Security posture under prompt injection — untouched.

## Reproduction notes / state hygiene

- Model config: the `config.yaml` model block was pointed at `copilot/gpt-4.1` for the trial and **restored to `provider: nous`** afterward. Nous auth is still expired, so any re-run needs `hermes --provider copilot …` or a fresh `hermes login`.
- Kanban: the scratch `handson` board was **deleted**; all spawned workers were killed; no stray processes remain.
- Gateway: started with `hermes gateway run` for the Discord trial, **stopped** afterward — no gateway is left running.
- **Discord bridge left wired:** `~/.hermes/.env` retains `DISCORD_BOT_TOKEN` (bot **CuriaBot#1524**) and `DISCORD_ALLOWED_USERS=<Alp's id>`, so the bridge is ready to bring back up with a single `hermes gateway run` (rotate the token if that's a concern). To make the voice path pass next time: `sudo uv pip install --python /opt/hermes-agent/venv/bin/python faster-whisper==1.2.1`, then resend a memo.

The only durable repo change is this report.
