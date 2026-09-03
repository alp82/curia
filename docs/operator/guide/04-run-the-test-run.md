# 4. Run the Test run

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · **4. Run the Test run (this topic)**
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** Curia creates a small map with two tickets in your repository and takes each through all eight legs of the Full loop, then closes the map on your verdict. The panel reads **Test run verified** with links to the map, the tickets, the pull requests, and the Discord threads, and the repository is left as it was. This is the installation's acceptance. There is no separate report.

**Starting state:** **Start Test run** enabled from [3. Connect services](03-connect-services.md). A covered watched repository where Curia can create issues and merge a pull request. Discord open on your phone or desktop, signed in as the user ID you gave the Discord card.

**Active operator time:** About 7 minutes: two answers and one review per ticket, and one verdict on the map. The agents' own work is a wait of 15 to 60 minutes per ticket, depending on the model.

## What the run changes

The run creates one wayfinder map in the covered repository, **Test run &lt;date&gt;**, with two child tickets:

1. **Add a line to the README.** The agent appends one line to the bottom of `README.md`, creating the file if the repository has none. The line names the Test run and the date.
2. **Remove the Test run line from the README.** Blocked by ticket 1 through GitHub's native dependency. The agent removes the line again, and deletes the file when ticket 1 created it.

Both tickets carry the `rehearsal` label. Each agent claims its ticket, works in a clone under `work/`, opens a real pull request, and merges it into the default branch after your approval. When both tickets are closed, Curia asks whether the map is done, and closes it on your answer. Curia stores nothing but the journal rows the work already writes. The connected integrations aren't touched. You don't write a ticket: the run makes its own, and a second Test run makes a new map.

## Do this

On the Setup screen, select **Start Test run**. The **Test run** panel names the map and the ticket in flight (**ticket 1 of 2**, then **ticket 2 of 2**), shows one row per leg with the elapsed time, and follows the service every 5 seconds. The running leg says what it waits for and, when a question is open, how long it has been open.

Your part is five answers, two per ticket and one for the map. Whenever the run reaches a step that waits for you, the panel shows the message Curia posted in Discord, as Discord shows it, with the answer controls under it. Answer on the panel or in Discord; both reach the same place, and the first valid answer wins.

1. When the agent asks its question, answer it. The ticket asks the agent to confirm the wording of the line with you.
2. When the agent asks for review, read the pull request, then select **Approve · merge**. A rejection sends the agent back to work on the same pull request and completes nothing.
3. Ticket 2 starts on its own once ticket 1 is closed. Answer its question and approve its review the same way.
4. When both tickets are closed, Curia asks what to do with the empty map. Select **Clear fog and close**.

To watch an agent work, open a terminal from the **Terminals** row: one per live session, in a new tab. You can leave Setup at any time; the run keeps going, Home shows it with its current leg, and **Open** brings you back to the panel.

Everything else is the agents' and the service's. The following table lists the legs and what completes each one. The first eight run once per ticket.

| Leg | What completes it |
|---|---|
| Frontier discovery | The ticket is listed as takeable. |
| Dispatch | The agent session is spawned. |
| Escalation and answer | The agent asked, and your answer reached it. |
| Pull request | The agent opened the pull request. |
| Review | You approved the review gate. |
| Merge | The pull request is merged. |
| Ticket resolution | The resolution comment stands and the ticket is closed. |
| Map update | The pointer line stands on the Test run's map. |
| Map closed | Curia closed the map on your verdict. |

## What you should see

The panel reads **Test run verified** and names the repository, the last ticket, and the elapsed time, with links to the ticket, the pull request, the map, the Discord thread, and the command channel. The map and both tickets are closed on GitHub, and the README is as it was. Select **Open Curia** to leave setup. The run's start and completion are on the Feed.

If you're timing the installation, the stopwatch stops here. The four topics from prerequisites to this one are the 30-minute active-work budget; report the download and agent waits separately.

## If a leg fails

The panel names the failed leg, one cause, and one corrective action, and offers **Try again**. Completed legs, the map, the tickets, and every connected integration stay as they are. Do the action, then select **Try again**, which reruns the failed leg on the same map and ticket: a failed creation creates only what is missing, frontier discovery reads the frontier again, every later ticket leg dispatches the same ticket again and counts only the new dispatch's legs, and the map close reads the map again. The causes by leg are under [Test run](troubleshooting.md#test-run) in Troubleshooting.

## Next

[5. Daily operation](05-daily-operation.md).
