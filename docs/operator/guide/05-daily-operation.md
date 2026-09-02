# 5. Daily operation

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** **5. Daily operation (this topic)** · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** You send agents at tickets, answer them, approve their work, and adjust Curia from Discord and the Curia app, with the terminal only for a restart or a log.

**Starting state:** A verified installation from [4. Run your first Full loop](04-run-your-first-full-loop.md), or any installation whose four cards are connected.

**Active operator time:** As long as your tickets need. Each action on this page takes under a minute.

## Where Curia talks to you

- **The command channel in Discord.** Curia answers slash commands there, opens one thread per ticket, and asks its questions and for its reviews in that thread. Only the user ID you gave the Discord card can command it.
- **The Curia app** at `https://<your node's MagicDNS name>:8445/`, from any device on your tailnet: **Home**, **Maps**, **Agents**, **Feed**, **Chat**, **Settings**, and **Setup**. Only the login you confirmed on the Tailscale card is admitted.

## Send an agent

In the command channel, run `/tickets` to see what is takeable per watched repository, then `/start` with the ticket number to dispatch an agent on it, or `/next` for the first takeable ticket that needs no human in the loop. `/status` lists the live agents, `/attach` opens an agent's terminal in your browser, `/cancel` tears one down, and `/resume` starts a fresh agent on a ticket whose worktree survived. The complete vocabulary, with what each verb refuses, is in [The verb catalogue](../../../daemon/README.md#the-verb-catalogue-discord-slash-commands-post-command-or-overseer-prose).

You should see Curia answer in the channel and, for a dispatch, a thread for the ticket. If a verb refuses, its answer names the way out, for example a ticket that is assigned or blocked. Fix that on GitHub and run the verb again.

## Answer questions and approve work

Reply in the ticket's thread. A question waits for your answer, and a review gate waits for your approval or rejection; both take the first valid answer. A rejection sends the agent back with your feedback. Every ticket ends the same way: a pull request, your approval, and a merge.

## Change a setting

Open **Settings** in the Curia app. The screen holds the operator configuration: how many agents run at once (`max_concurrent`, `4` on a fresh installation), whether Curia dispatches on its own, the poll interval, and the watched repositories, plus the model routing. Select **Save**. The service validates the file before it writes it and applies it at once; a setting the running service can't apply, such as a port, offers **Restart to apply** beside **Save**.

To edit by hand instead, change `config/config.yaml` in the installation root and then save any setting from the app or restart the service. An invalid file is refused with the path, the line, the key, and the rule, and the running service keeps what it loaded. The keys are in [Operator configuration](../configuration.md).

## Restart the service

Select **Restart service** on the Settings screen, or run:

```sh
docker compose -p curia restart daemon
```

The tmux runtime, the attach surface, and every agent keep running through it, and the service adopts the live sessions back when it boots. The Discord card and the Tailscale card offer the same restart when a connection needs one.

To stop Curia entirely, at zero live agents, run `docker compose -p curia stop`, and `docker compose -p curia start` to bring it back. Stopping the `tmux` service ends every agent pane, so cancel or finish the agents first.

## Read a log

```sh
docker compose -p curia logs --tail 200 daemon
```

Replace `daemon` with `dashboard`, `overseer`, `tmux`, or `ttyd`. A healthy boot logs `ready:` with the guild and channel. Every failure message from a lifecycle command prints the exact `logs` command for the service it names.

## Watch for updates

The **Update** section of the Settings screen shows the installed version, the recommended stable release, whether an update is available, and a warning when the installed version was withdrawn. The service reads the signed index once a day and never updates on its own. When an update is available, go to [7. Update or roll back](07-update-or-roll-back.md).

## What survives a restart

Everything: `config/`, `secrets/`, `state/`, and `work/` are untouched by a service or host restart, running agents keep their worktrees, and nothing in setup has to be repeated. The complete table is in [What survives](../secrets.md#what-survives).

## Next

When something looks wrong, [6. Check the installation](06-check-the-installation.md) with `curia doctor` first.
