# Integration setup

Integration setup is the **Setup** screen of the Curia app. It connects one installation to the four resources the Full loop needs: GitHub, Discord, Tailscale, and one model provider. This page is the reference for the setup frame: what the four cards show, how you move between them, what a reopen restores, and what Curia keeps on disk. Each integration's own connect steps are documented on that integration's card as it lands.

After `curia install` finishes, open the address it printed, `https://<your node's MagicDNS name>:8445/`, and open **Setup**. Home also points at **Setup** while an integration isn't connected.

## The four cards

The rail on the left holds one card per integration, in this order: **GitHub**, **Discord**, **Tailscale**, **Model provider**. Select any card to open its configuration on the right. You can connect the four in any order.

Every card has the same height in every state, so a verification never moves the rail. Each card has a header with the service's logo, its name, and a state badge, and a footer with the card's data. The following table lists the states.

| State | Badge | Header and footer | Footer shows |
|---|---|---|---|
| Not connected | **Ready to connect** | Dimmed header, plain footer. | The data that will appear after the integration verifies. |
| Not available | **Not available** | Dimmed header, plain footer. | The same line. The configuration panel says the step isn't available in this release yet. |
| Connected | **Connected and verified** (**Provider verified** or **Two providers verified** on the model card) | Full brand color on the header, a light brand tint on the footer. | One real fact and one supporting line, such as a discovered ticket and its repository, the command channel and the registered commands, the private address and the verified operator, or the connected providers and the verification timing. |
| Failed | **Action required** | Red border, red-tinted header and footer. | The verification that failed and the one corrective action. |

The footer never shows a decorative number. Before a card verifies, it names the data that will appear. After, it shows what Curia found.

## Verification is fresh

A card's state comes from a verification that Curia runs when you open **Setup** and every time you select **Try again**. Curia doesn't keep a "connected" marker. A card that verified yesterday and doesn't verify today shows as failed today, with the reason and the action.

The rail's count, `n/4 verified`, and the Home pointer read the same fresh result.

## When a verification fails

A failed card names the verification that failed and exactly one corrective action, on the card and in the configuration panel. Do what the action says, then select **Try again**. **Try again** runs the verification again for every card. There is no background retry.

While Curia can't reach the service at all, **Setup** says so instead of showing four unconnected cards, and offers **Try again**.

## Moving through setup

- After a card connects, **Continue setup** opens the next card that isn't connected, in rail order.
- When all four cards are connected, the action becomes **Run Full loop**.
- **Close setup** returns to Home. Closing the tab does the same.

## The Full loop

The Full loop is the one dependent step. Under the rail, the **Full loop** panel names what it's waiting for: the cards that aren't connected, or, when all four are, whether the loop is available. **Run Full loop** stays unavailable until GitHub, Discord, Tailscale, and one model provider pass fresh verification and the service has the verified facts the loop runs on. This release doesn't run the Full loop yet.

## What a reopen restores

Closing and reopening **Setup** restores the card you were on and any safe progress a step kept. Curia keeps that in `state/setup.json` in the installation root, written by the service, mode `0600`. The file holds:

- `step`: the selected card, one of `github`, `discord`, `tailscale`, `model`.
- `progress`: per card, only these fields: `app_name` for GitHub, `guild_id` and `channel` for Discord, `machine_name` for Tailscale, `provider` for the model card.

The file never holds a token, a key, or a completion marker. A field outside that list is refused by name. Nothing about setup is stored in the browser. A `state/setup.json` file that can't be read starts setup on the GitHub card with no progress, and the service log says so.

Credentials a step collects go to their secret files under `secrets/`, as [Secrets, mounts, and what survives](secrets.md) describes. The Discord facts that aren't secret go to `state/discord.json`.

## Where the frame lives

The Curia app serves the frame at `#setup`. The app reads the record and the four verifications from the service with `GET /setup` through its sidecar, and writes the selected card and safe progress with `POST /setup`. The service refuses a write that names a card or a field outside the lists in the preceding section, and it never prints a secret in the answer.
