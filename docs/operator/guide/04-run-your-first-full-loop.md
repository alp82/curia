# 4. Run your first Full loop

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · **4. Run your first Full loop (this topic)**
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** One real ticket runs through all eight legs of the Full loop in one pass, and the panel reads **Full loop verified** with links to the pull request, the ticket, and the Discord thread. This is the installation's acceptance. There is no separate report.

**Starting state:** **Run Full loop** enabled from [3. Connect services](03-connect-services.md). A covered watched repository where you can create a ticket and merge a pull request. Discord open on your phone or desktop, signed in as the user ID you gave the Discord card.

**Active operator time:** About 7 minutes: writing the ticket, answering the agent's one question, and approving the review gate. The agent's own run is a wait of 15 to 60 minutes, depending on the ticket and the model.

## What the run changes

The run dispatches one agent on the ticket you marked. That agent claims the ticket, works in a clone under `work/`, opens a real pull request, and merges it into the repository's default branch after your approval. Curia stores nothing but the journal rows the agent's work already writes. The connected integrations aren't touched.

## Prepare the rehearsal ticket

1. In the covered repository, create or pick an open ticket that Curia can take: unassigned, unblocked, and either a child of an open map or labelled `ready-for-agent` when the repository has no open map.
2. Add the `rehearsal` label to it. Create the label first if the repository doesn't have one, for example with `gh label create rehearsal --repo <owner>/<name>`. Curia runs the Full loop only on a ticket that carries this label, so the run never spends a ticket you didn't choose.
3. Write the ticket so the agent has to ask you one question it can't answer from the repository. The escalation leg needs a real question and a real answer.
4. Keep the ticket small. The merge is real.

When several tickets carry the label, Curia takes the first one on its frontier. The rest of the contract is in [Prepare the rehearsal ticket](../integration-setup.md#prepare-the-rehearsal-ticket).

## Do this

On the Setup screen, select **Run Full loop**. The **Full loop** panel shows one row per leg and the elapsed time, and follows the service every 5 seconds.

Your part happens in Discord, in the ticket's thread in the command channel:

1. When the agent asks its question, answer it in the thread.
2. When the agent asks for review, read the pull request and approve at the review gate. A rejection sends the agent back to work on the same pull request and completes nothing.

Everything else is the agent's and the service's. The following table lists the legs and what completes each one.

| Leg | What completes it |
|---|---|
| Frontier discovery | The marked ticket is listed as takeable. |
| Dispatch | The agent session is spawned. |
| Escalation and answer | The agent asked, and your answer reached it. |
| Pull request | The agent opened the pull request. |
| Review | You approved the review gate. |
| Merge | The pull request is merged. |
| Ticket resolution | The resolution comment stands and the ticket is closed. |
| Map update | The pointer line stands on the parent map, when there is one. |

## What you should see

The panel reads **Full loop verified** and names the repository, the ticket, and the elapsed time, with links to the ticket, the pull request, the parent map, the Discord thread, and the command channel. Select **Open Curia** to leave setup. The run's start and completion are on the Feed.

If you're timing the installation, the stopwatch stops here. The four topics from prerequisites to this one are the 30-minute active-work budget; report the download and agent waits separately.

## If a leg fails

The panel names the failed leg, one cause, and one corrective action, and offers **Try again**. Completed legs and every connected integration stay as they are. Do the action, then select **Try again**, which reruns the failed leg: frontier discovery reads the frontier again, and every later leg dispatches the same ticket again and counts only the new run's legs. The causes by leg are under [Full loop](troubleshooting.md#full-loop) in Troubleshooting.

## Next

[5. Daily operation](05-daily-operation.md).
