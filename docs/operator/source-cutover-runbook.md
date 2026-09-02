# The source cutover runbook

Runbook version 1, written September 2, 2026. This runbook moves one deployment, the source deployment on the box `coinmatica`, into a packaged Curia on a separate Ubuntu 24.04 host, once. It implements [Define the isolated legacy migration contract](https://github.com/alp82/curia/issues/856) and is kept in version control as the record of that cutover. It is not a migration product: it knows one layout at one commit, it refuses everything else by name, and `curia install` contains none of it. The guide topic that sends you here is [8. Migrate the current deployment](guide/08-migrate-the-current-deployment.md).

| Fact | Value |
|---|---|
| Accepted source commit | `2be76653451ee4f5f4dd63c7b84d46735d79c293` (`feat: create and start tickets from chats`, daemon `0.4.1`) |
| Source host | `coinmatica` (Ubuntu 20.04.6, x86-64), operator `alp`, uid 1000, gid 1000, in the `docker` group (gid 998) |
| Target host | A separate Ubuntu 24.04 host on x86-64, prepared as in [1. Check prerequisites](guide/01-check-prerequisites.md), with SSH from the source |
| Target release | `TARGET_VERSION`: the first stable release, the version [Promote the rehearsed candidate as Curia's first stable release](https://github.com/alp82/curia/issues/893) names. Replace the placeholder in every command before you run it. |
| Target root | `~/.local/share/curia` on the target, the default the bootstrap chooses |
| Script | `deploy/cutover/cutover.mjs`, run from a checkout of this repository at or after the commit this runbook merged in |

**Active operator time:** about 60 minutes, in one maintenance window. The waits are separate: the copy over SSH (about 5 GB, mostly native session data), the target's Setup screen verifications, and the Full loop's own run. The source is stopped from the evidence step until the target's Full loop passes or you roll back, so plan the window when no agent work is due.

**When the box moves past the accepted commit** before the cutover, revise this runbook first: update `ACCEPTED_SOURCE_COMMIT` in `deploy/cutover/cutover.mjs` and the fact table, run the daemon suite, and merge. Admission compares the checkout against the commit you pass, and this page tells you which commit to pass. A cutover from an unrevised commit is a cutover from a layout nobody checked.

## What the script does and doesn't do

`deploy/cutover/cutover.mjs` has four verbs, and the runbook runs them in this order:

| Verb | Runs on | What it does | Changes |
|---|---|---|---|
| `admit` | Source | Checks the commit, the clean tree, the layout, the env file's keys, the override file's keys, that automatic dispatch is off, and that no agent container or live session exists. | Nothing. |
| `inventory` | Source, stopped | Refuses while any `curia-*` container runs. Records the source identity, the journal's integrity and row bounds, the SHA-256 of every preserved file, and the four credentials by name, size, and mode. | Writes the manifest file you name, mode `0600`. |
| `transform` | Target, stopped | Refuses a running target, an existing journal or secret file in the root, and an override key with no place in `config/config.yaml`. Then writes the operator configuration, the four secret files, `state/discord.json`, the checkpointed journal, the data, the native sessions, and the migration marker. | The root's `config/`, `secrets/`, `state/`, `work/`. |
| `validate` | Target | Compares the root against the manifest: boundaries, configuration, secrets, Discord facts, journal, every file hash, the marker, the absence of source-layout files inside the root, and the absence of the source paths you name. | Nothing. |

Exit codes are the lifecycle interface's: `0` ok, `1` failed, `2` usage, `3` refused with nothing changed. No verb prints a credential. The manifest carries hashes of non-secret files only; a secret is listed by name, size, and mode.

The script doesn't stop or start anything, copy anything between hosts, talk to GitHub, Discord, or Tailscale, or run the Full loop. Those are your steps, and this runbook names each one.

## The source layout the runbook accepts

These facts were read off the box on September 2, 2026, read-only, and by name only for anything secret. The daemon suite dry-runs every step against a fixture built from this table (`daemon/test/cutover.test.mjs`).

| Path on the source | Owner and mode | Holds | Cutover |
|---|---|---|---|
| `/home/alp/curia` | `alp:alp` `0775` | The checkout, on `main`, clean | Admission checks it. Stays in Git. |
| `/home/alp/curia/deploy/compose.yaml` | | The source Compose project `curia`: `curia-daemon-1`, `curia-tmux-1`, `curia-ttyd-1`, `curia-dashboard-1`, `curia-overseer-1`, built with `target: box` | Stopped, then removed at cleanup. |
| `/home/alp/curia/deploy/.env` | `0664` | `DOCKER_GID` | Not migrated. `curia install` writes its own `run/compose.env`. |
| `/home/alp/curia/daemon/.env.daemon` | `0600` | `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`, `CURIA_GH_APP_ID`, `CURIA_GH_APP_KEY_FILE`, and, on September 2, the retired keys `CLAUDE_CODE_OAUTH_TOKEN`, `CURIA_AGENT_GH_TOKEN_ALP82`, `CURIA_AGENT_GH_TOKEN_GETALFREDO` | The four live keys move to `secrets/` and `state/discord.json`. Admission refuses the retired keys. |
| `/home/alp/curia/daemon/.env.overseer` | `0600` | The retired keys `CURIA_OVERSEER_GH_TOKEN_ALP82`, `CURIA_OVERSEER_GH_TOKEN_GETALFREDO`, `CLAUDE_CODE_OAUTH_TOKEN` | Admission refuses the file while it holds a key. |
| `/home/alp/curia/daemon/.curia-app.pem` | `0600` | The GitHub App private key | Into `secrets/github-app.json` with the App ID. |
| `/home/alp/curia/config/curia.local.yaml` | `0644` | `dispatch.max_concurrent: 10` and six `watch` entries | Into `config/config.yaml`. |
| `/home/alp/curia/config/routing.local.yaml` | `0644` | The routing override | Into `state/routing.local.yaml`, verbatim. |
| `/home/alp/curia/daemon/data/events.db` (+ `-wal`, `-shm`) | `0644` | The journal, 11 MB plus a 4 MB write-ahead log | Into `state/events.db`, checkpointed, integrity checked, IDs unchanged. |
| `/home/alp/curia/daemon/data/attachments/` | | 47 files in `esc-<n>/` directories, 13 MB | Into `state/attachments/`. |
| `/home/alp/curia/daemon/data/results/` | | 281 files, 1.2 MB | Into `state/results/`. |
| `/home/alp/curia/daemon/data/backups/` | | 14 journal backups, 18 MB | Into `state/backups/`. |
| `/home/alp/curia/daemon/data/verdicts/` | | 2 files | Into `state/verdicts/`. |
| `/home/alp/curia/daemon/data/tokens/` | `0700` | Agent token records | Not migrated: session-bound. |
| `/home/alp/curia/daemon/data/previews.json`, `deploy.log`, `deploy-last.json`, `overseer/` | | Preview state, the deploy verb's files, the dead in-daemon overseer tree | Not migrated: runtime state and dead paper. |
| `/home/alp/curia-work` | `alp:alp` `0775` | `dispatch.workspace_root` | |
| `/home/alp/curia-work/credentials/anthropic.json` | `0600` | The Anthropic credential store | Into `secrets/anthropic.json`, verbatim. |
| `/home/alp/curia-work/home/.codex/auth.json` | `0600` | The Codex credential | Into `secrets/codex-auth.json`, verbatim. |
| `/home/alp/curia-work/home/` (the rest) | | Curia's `HOME`: `.claude`, `.config/gh`, `.gitconfig`, `.npm`, `.docker`, `.local` | Not migrated: `HOME` is `cache/home` under a root, and the host `gh` login has no place there. |
| `/home/alp/curia-work/cfg/` | | 284 per-session config directories `curia-<n>` and `curia-overseer`, 3.3 GB, the native Claude and Codex sessions | Into `work/cfg/`, without every `.credentials.json` and `gh/` directory, which the service rewrites. |
| `/home/alp/curia-work/repos/` | | Per-session clones and worktrees, 1.6 GB | Into `work/repos/`. |
| `/home/alp/curia-work/archive/` | | Archived worktrees | Into `work/archive/`. |
| `/home/alp/curia-work/overseer/repos/`, `overseer/tokens/` | | The overseer's mirrors and renewable tokens | Not migrated: rebuilt by the overseer and the service. |
| `/home/alp/curia-work/tmux-1000/` | `0700` | tmux runtime | Not migrated. |
| Docker | | Images `curia-daemon`, `curia-tmux`, `curia-dashboard`, `curia-overseer`, `curia-agent:2.1.220-0.146.0-e8f5fc4e`; volumes `curia_tmux-sock`, `curia-agent-browsers`, `curia-agent-npm-cache`, `curia-worker-browsers`, `curia-worker-npm-cache`; network `curia_default` | Removed at cleanup. |
| Tailscale | | Node `coinmatica`, Serve `https://coinmatica.<tailnet>.ts.net:8445` to `127.0.0.1:4273`; the operator login is `identity.allow` in `curia.yaml` | The target's Tailscale card records the operator on the new node and creates the new node's route. The source route is turned off at cleanup. |
| Host firewall | | Two `ufw` rules for the agent side channel and the overseer's MCP seam ([Deployment: the Hetzner box](../deploy.md)) | Host state, not migrated. The target's own rules are the target's prerequisite. |

Facts not verified on September 2: whether `DISCORD_ALLOWED_USERS` names one user or several, whether `CURIA_GUILD_ID` and `CURIA_CHANNEL` are set (neither appeared, so the channel defaults to `curia`), and the current state of `ufw` (the read needed `sudo`). Admission and the transformation read the first three at run time; the firewall is yours to check.

## Before the window

1. Install the target as in [2. Install Curia](guide/02-install-curia.md), with the target release: `bash curia-install.sh --version TARGET_VERSION`. Don't connect any service on the Setup screen: the cutover brings the credentials, and a Discord card connected here would put the bot token in a second running service.
2. On the target, run `curia doctor`. The host preflight and installation sections must read `ok`; the integration cards read as unconnected, which is right at this point.
3. Put a checkout of this repository on each host for the script, outside the source checkout: `git clone https://github.com/alp82/curia ~/curia-cutover/src` on both hosts, at or after the commit this runbook merged in. Make the directory owner-only first: `mkdir -m 0700 ~/curia-cutover`.
4. On the source, confirm the host Node.js can open the journal: `node -e "import('node:sqlite').then(() => console.log('ok'))"` must print `ok` (the box's `/usr/local/bin/node` is 22.17.1, and `node:sqlite` needs 22.13 or later). On the target, use the installed runtime: `NODE=~/.local/share/curia/versions/TARGET_VERSION/node/bin/node`.
5. On the source, delete the retired keys from `daemon/.env.daemon` and `daemon/.env.overseer`, and delete `.env.overseer` once it is empty, as [Deployment: the Hetzner box](../deploy.md#the-env-file-daemonenvdaemon) says. Revoke each deleted token where it was issued. Admission refuses while any retired key remains.
6. Confirm automatic dispatch is off on the source's Settings screen. It shipped off, and the override on September 2 didn't turn it on.

## Step A: admission, on the source

Run this while the source is still up:

```sh
cd ~/curia-cutover/src
node deploy/cutover/cutover.mjs admit \
  --checkout /home/alp/curia --workspace /home/alp/curia-work \
  --commit 2be76653451ee4f5f4dd63c7b84d46735d79c293
```

**What you should see:** the checkout and its commit, the env files with their keys by name, and `admitted: the source is at the accepted commit, clean, in the expected layout, with no live session`.

**When it refuses** (exit `3`), every line names one thing. Fix it and run the same command again:

| Refusal | What to do |
|---|---|
| `not the accepted source commit` | Revise the runbook as described at the top, or, if the box is behind, deploy to the accepted commit. Don't pass another commit. |
| `the checkout is dirty: <files>` | Somebody hand-edited a tracked file on the box. Restore it (`git checkout -- <file>`) or commit and deploy it. |
| `expected <path> is missing` or `belongs to another layout` | The box isn't in the layout of the table above. Stop and find out why before anything else. |
| `carries the retired key <KEY>` | Delete the line and revoke the credential. |
| `is a symbolic link, which makes the path ambiguous` | Name the real directory. |
| `sets dispatch.auto_dispatch: true` | Turn automatic dispatch off on the Settings screen. |
| `holds keys with no place in config/config.yaml` | The override carries a key the packaged configuration doesn't have. Move the setting where the target keeps it, or remove the override line. |
| `agent containers are running` or `live sessions` | Wait until every agent, review, and operator turn has ended, then run admission again. |

The last check is the hard one: nothing runs during the window. The runbook doesn't migrate live containers or tmux panes, and stopping the tmux service ends every pane.

## Step B: stop the source and take the evidence

1. Stop the whole source project. At zero live sessions this ends nothing that matters:

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml stop
   docker ps --filter name=curia- --format '{{.Names}} {{.Status}}'
   ```

   The second command must print nothing with `Up`. From this point the source holds the Discord bot token and doesn't use it, which is what lets the target use it later.

2. Take the inventory. The manifest is evidence that the source was stopped, because the verb refuses while any `curia-*` container runs:

   ```sh
   cd ~/curia-cutover/src
   umask 077
   node deploy/cutover/cutover.mjs inventory \
     --checkout /home/alp/curia --workspace /home/alp/curia-work \
     --host coinmatica --out ~/curia-cutover/manifest.json
   ```

   **What you should see:** `journal: integrity ok, <n> rows, ids <lo> to <hi>, <first> to <last>`, the file and byte counts with the number of config directories, the four secrets by name, and the manifest path with the first 16 characters of its identity. Write those lines into the cutover ticket. A journal that isn't `ok` stops the cutover here: restart the source (`docker compose -f /home/alp/curia/deploy/compose.yaml start`) and diagnose the journal before another attempt.

3. Stage the copy on the target over SSH, into an owner-only directory, excluding what the table doesn't migrate. Replace `TARGET` with the target host:

   ```sh
   ssh TARGET 'mkdir -p -m 0700 ~/curia-cutover/stage'
   rsync -a --chmod=D0700,F0600 \
     /home/alp/curia/daemon/.env.daemon /home/alp/curia/daemon/.curia-app.pem \
     TARGET:~/curia-cutover/stage/curia/daemon/
   rsync -a --chmod=D0700,F0600 --exclude 'tokens' --exclude 'overseer' \
     /home/alp/curia/daemon/data TARGET:~/curia-cutover/stage/curia/daemon/
   rsync -a --chmod=D0700,F0600 /home/alp/curia/config TARGET:~/curia-cutover/stage/curia/
   rsync -a --chmod=D0700,F0600 \
     /home/alp/curia-work/credentials /home/alp/curia-work/cfg /home/alp/curia-work/repos \
     /home/alp/curia-work/archive TARGET:~/curia-cutover/stage/curia-work/
   ssh TARGET 'mkdir -p -m 0700 ~/curia-cutover/stage/curia-work/home/.codex'
   rsync -a --chmod=F0600 \
     /home/alp/curia-work/home/.codex/auth.json TARGET:~/curia-cutover/stage/curia-work/home/.codex/
   rsync -a --chmod=F0600 ~/curia-cutover/manifest.json TARGET:~/curia-cutover/
   ```

   This is the wait. Nothing leaves the two hosts' SSH session, every file lands owner-only, and the only file of Curia's `HOME` that travels is the Codex credential.

4. Prove the copy on the target before you touch the root. `inventory` on the staged copy must describe the same journal and the same files as the manifest from the source. The staged copy has no Docker project, and no `git` checkout, so hand the verb the commit and an empty container list:

   ```sh
   cd ~/curia-cutover/src
   NODE=~/.local/share/curia/versions/TARGET_VERSION/node/bin/node
   printf 'export const containers = async () => []\nexport const head = async () => "2be76653451ee4f5f4dd63c7b84d46735d79c293"\n' > ~/curia-cutover/staged-probes.mjs
   CURIA_CUTOVER_PROBES=~/curia-cutover/staged-probes.mjs $NODE deploy/cutover/cutover.mjs inventory \
     --checkout ~/curia-cutover/stage/curia --workspace ~/curia-cutover/stage/curia-work \
     --host coinmatica --out ~/curia-cutover/manifest-staged.json
   diff <(jq 'del(.source)' ~/curia-cutover/manifest.json) <(jq 'del(.source)' ~/curia-cutover/manifest-staged.json) && echo copy-proven
   ```

   `copy-proven` means every preserved file arrived with its hash and the journal reads the same bounds. Anything else means the copy is incomplete: run the `rsync` commands again, they are idempotent, and prove it again.

## Step C: stop the target and transform

1. Stop the target's project. It has never used a credential, so this is quiet:

   ```sh
   docker compose -p curia stop
   ```

2. Transform the staged copy into the root:

   ```sh
   cd ~/curia-cutover/src
   $NODE deploy/cutover/cutover.mjs transform \
     --checkout ~/curia-cutover/stage/curia --workspace ~/curia-cutover/stage/curia-work \
     --root ~/.local/share/curia --manifest ~/curia-cutover/manifest.json \
     --host "$(hostname)"
   ```

   **What you should see:** one `wrote <path>` line per item, ending with `transformed into <root>`. The verb writes, in order: `config/config.yaml` (from the override's `max_concurrent` and `watch`), `secrets/discord-bot-token`, `secrets/github-app.json`, `secrets/anthropic.json`, `secrets/codex-auth.json`, `state/discord.json`, `state/events.db` (checkpointed, then checked against the manifest's bounds), `state/attachments/`, `state/results/`, `state/backups/`, `state/verdicts/`, `state/routing.local.yaml`, `work/cfg/`, `work/repos/`, `work/archive/`, and `state/migration.json` (source host, checkout, workspace, commit, target host, the time, and the manifest's identity). The installation ID stays the one `curia install` created: the source had none.

   **When it refuses**, nothing was written. `the target is running` means stop it. `state/events.db exists` or `secrets/<name> exists` means this root already went through a transformation or a setup: this is a retry, see [Rollback and retry](#rollback-and-retry). `holds keys with no place` is the same override refusal as admission and has the same fix, applied to the staged `config/curia.local.yaml`.

3. Start the target and watch it come up:

   ```sh
   docker compose -p curia start
   docker compose -p curia ps
   ```

   The service reads the secret files, `state/discord.json`, and the journal at boot, so the Discord bridge starts on the migrated token, and the Feed shows the history.

## Step D: validate

1. Run the script's validation, naming the source paths that must not exist on this host:

   ```sh
   cd ~/curia-cutover/src
   $NODE deploy/cutover/cutover.mjs validate \
     --root ~/.local/share/curia --manifest ~/curia-cutover/manifest.json \
     --absent /home/alp/curia --absent /home/alp/curia-work
   ```

   **What you should see:** nine `passed` lines, `boundaries`, `configuration`, `secrets`, `discord`, `journal`, `files`, `migration`, `source-layout`, `source-paths`, then `validated: every check passed`. A `failed` line names the file, the mode, or the path. The most likely one after a fresh transformation is `source-paths`, when the target host happens to carry a `/home/alp/curia` of its own: remove or rename it, it isn't the deployment.

2. Run `curia doctor`. Every section must read `ok`, including the installed release with provenance and the secret files by presence. See [6. Check the installation](guide/06-check-the-installation.md).

3. Open the Setup screen and let every card verify fresh, as in [3. Connect services](guide/03-connect-services.md). Nothing is re-registered:
   - **GitHub** proves the existing App's installations cover the watched repositories on a fresh token. Nothing to type.
   - **Discord** proves the migrated token, the operator's membership, and the command channel `curia`. Press nothing on this card before the source is confirmed stopped, which Step B did.
   - **Tailscale** detects the target's node. Confirm the operator login that was `identity.allow` on the source, and the target node's machine name. This records `state/tailscale.json` and creates the target's Serve route. The source route on `coinmatica` stays until cleanup.
   - **Model provider** proves `secrets/anthropic.json` and `secrets/codex-auth.json` with one minimal request each. Repeat a provider's sign-in only when the card proves the imported credential unusable.

4. Open Settings. The values that were in `curia.local.yaml` are there: `max_concurrent` 10 and the six watched repositories, plus the routing override.

5. Run one Full loop as in [4. Run your first Full loop](guide/04-run-your-first-full-loop.md). **Full loop verified** is the acceptance, and it ends rollback support. Until it reads that, the source is the deployment of record and the target is an attempt.

## Rollback and retry

Before acceptance, any failed host, transformation, service, or integration check is a rollback, and a rollback is restarting the unchanged source:

```sh
docker compose -p curia stop                                      # on the target
docker compose -f /home/alp/curia/deploy/compose.yaml start       # on the source
```

The source was never transformed, so nothing is reversed. Validation-only events the target wrote (its journal rows, its Serve route) are discarded with the attempt. Two things must not stand at once: never start the source while the target's service runs, because both would hold the Discord bot token.

To retry, the target needs a root without the first attempt's journal and secrets, because `transform` never overwrites either. The attempt held nothing of value, so remove it whole and reinstall: `curia purge` (type the root when asked), then `bash curia-install.sh --version TARGET_VERSION`, then Step C again from the staged copy, which is still in `~/curia-cutover/stage`. The manifest stays valid as long as the source stays stopped and unchanged.

## After acceptance: cleanup

Do this only after **Full loop verified** on the target.

1. On the target, run the validation from Step D once more, so the record ends with a manifest that matched after the loop.

2. On the source, remove the old runtime resources by their exact names. Nothing else on `coinmatica` is touched:

   ```sh
   docker compose -f /home/alp/curia/deploy/compose.yaml down --remove-orphans
   docker volume rm curia_tmux-sock curia-agent-browsers curia-agent-npm-cache curia-worker-browsers curia-worker-npm-cache
   docker rm -f curia-agent-pin
   docker image rm curia-daemon curia-tmux curia-dashboard curia-overseer curia-agent:2.1.220-0.146.0-e8f5fc4e
   tailscale serve --https=8445 off
   ```

   The `ufw` rules for the agent side channel and the overseer are host state and grant nothing without the containers; remove them if the box has no other use for them.

3. On the source, delete the duplicate secrets, then the workspace and the data directory. Two live copies of one credential must not remain, and this is the step that makes it true:

   ```sh
   shred -u /home/alp/curia/daemon/.env.daemon /home/alp/curia/daemon/.curia-app.pem
   shred -u /home/alp/curia-work/credentials/anthropic.json /home/alp/curia-work/home/.codex/auth.json
   rm -rf /home/alp/curia-work /home/alp/curia/daemon/data
   ```

   Keep `/home/alp/curia` if you want the checkout on the box; it holds no secret after this step. The `.env.overseer` file went before admission.

4. On the target, delete the staged copy, which holds a second copy of every secret, and the script checkout:

   ```sh
   rm -rf ~/curia-cutover
   ```

   Do the same for `~/curia-cutover` on the source. The manifest's identity is in `state/migration.json` on the target; keep a copy of `manifest.json` in the cutover ticket if you want the hashes on record, it holds no secret.

5. Nothing external changes. The GitHub App, the Discord bot and channel, the Tailscale account, and the provider logins are in use by the target and are not deleted or revoked.

## What the cutover ticket records

[Cut over the current Curia deployment to the first stable release](https://github.com/alp82/curia/issues/894) records, in its resolution:

- the source commit admission accepted and the target release installed;
- the `inventory` lines: journal integrity, row count and bounds, first and last timestamps, file and byte counts, config directory count, and the manifest identity;
- `copy-proven` from Step B;
- the `transform` output and the `validate` output before the loop and after it;
- the four cards' verification facts and the `curia doctor` result;
- the Full loop's ticket, pull request, map, Discord thread, and elapsed time;
- the cleanup commands run on the source, with the date;
- the stopwatch: active operator time, the copy wait, and the loop wait.
