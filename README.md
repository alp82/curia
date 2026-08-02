# Curia

Curia is a personal orchestration daemon. It watches GitHub issue trackers, dispatches AI coding agents on tickets, and keeps the human in the loop from any device, a phone included.

## The problem

Coding agents can now work alone for an hour. The human is still the bottleneck, but the bottleneck moved. It is no longer typing code. It is presence: answering the one question that blocks a worker, judging a preview, approving a merge. Each of those moments takes a minute. Each of them normally demands a desk and a terminal, so the whole pipeline waits until you are back at one.

Curia removes the desk. The tracker holds the work. A daemon watches the tracker, sends workers, and routes every human moment to wherever you are.

## The shape

Five ideas carry the design.

1. **The tracker is the only brain.** GitHub issues hold every ticket, claim, decision, and dependency edge. The daemon owns no authoritative state. It can die at any moment and re-derive everything from GitHub, tmux, and an append-only journal.
2. **Dispatch is a rule, not a model.** A routing table maps ticket labels to models. No intelligence sits in the dispatch path, so dispatch is cheap, predictable, and auditable.
3. **Workers are disposable, questions are durable.** A worker is one agent CLI process in one git worktree. If the box reboots, curia re-dispatches. An open question to the human is a durable record that survives crashes and waits for hours.
4. **Resolved means merged.** A worker cannot finish by talking. It opens a pull request, publishes a live preview, and asks one gate question: is this done? A rejection loops the human's own words back into new commits on the same pull request. An approval merges. Only then does the ticket close and the map update.
5. **Any device is a full seat.** Discord carries commands and questions. Two attach surfaces carry live sessions. Previews carry results. Everything travels over a private tailnet, and everything works on a phone.

## What it does

- **Frontier awareness.** Curia reads what is takeable across watched repos, in dependency order, straight from GitHub.
- **One-command dispatch.** `start` claims the ticket, cuts a worktree, picks the model by rule, and spawns a worker that runs the same skills a hand session runs.
- **Blocking escalations.** A worker asks a human over a Discord thread and stays blocked until the answer arrives: buttons for choices, replies for free text, images in both directions. A question held open for almost eight hours has resumed cleanly.
- **Merge-gated endings.** Commit, pull request, preview, review gate, merge, resolution, map update. A stop hook refuses a worker that tries to stop early.
- **Live previews.** A worker's dev server becomes a per-ticket HTTPS link on the tailnet, so the result is judged on your screen, not described.
- **Two attach surfaces.** A timeline that a phone and a desktop can drive at the same time, each at its own width, and a raw terminal for the TUI itself.
- **Two backends.** Claude Code and Codex CLI workers run under one contract: same tools, same stop hook, same ending.

## What runs where

One box runs a single Node daemon plus tmux. The daemon carries the Discord bridge, the command router, the escalation store, and the dispatch loop. Workers are agent CLI processes in per-ticket git worktrees. A shared ttyd serves the terminal, and the daemon serves the timeline. Tailscale Serve publishes both, plus every preview. GitHub stores the truth. Phones, laptops, and PCs are pure clients.

## Status

Curia is a proof of concept, and it works. A scripted rehearsal proved the full loop end to end on real repos: a phone command dispatched a worker, the worker escalated, a preview opened on the phone, a rejection looped into new commits, an approval merged, and the map updated. Since then the overseer moved into the daemon: every `#curia` thread is a persistent agent session that turns prose into the verb catalogue, and a second full-loop rehearsal (`docs/live-checks/96-overseer-rehearsal.md`) verified the build with two daemon restarts inside the pass. The decision record lives in this repo's issue tracker and is distilled into `docs/adr/`. Agents get their vocabulary from `CONTEXT.md`.

Curia is not packaged for reuse. It runs on one person's box, accounts, and conventions, and several of them are baked in. `docs/self-hosting.md` is the setup path for your own machine, honest about the manual parts; `daemon/README.md` and `docs/deploy.md` describe the operator's box. Read the code, the ADRs, and the research notes as a record of decisions.
