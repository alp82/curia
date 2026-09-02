# Integration setup

Integration setup is the **Setup** screen of the Curia app. It connects one installation to the four resources the Full loop needs: GitHub, Discord, Tailscale, and one model provider. This page is the reference for the setup frame: what the four cards show, how you move between them, what a reopen restores, and what Curia keeps on disk. The GitHub card's own steps are in [Connect GitHub](#connect-github) and the Discord card's in [Connect Discord](#connect-discord). The other cards' steps are documented as they land.

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

## Connect GitHub

The GitHub card creates a dedicated GitHub App for this installation through GitHub's manifest flow, then verifies that the App can reach at least one watched repository. Curia never asks for your GitHub password, a personal access token, or anything from GitHub's consent page. You sign in and approve on GitHub.

### Create the App

1. On the **GitHub** card, keep the suggested App name or enter your own. GitHub slugifies the name, and Curia posts as `<slug>[bot]`, so the name is read as the author of every commit, pull request, and gate approval. The name must be free across all of GitHub.
2. Select **Create GitHub App**. Curia prepares the manifest (the five repository permissions from [The curia GitHub App](../github-app.md#2-grant-the-permissions), no webhook, installable on any account) and the browser opens GitHub's own page with that manifest.
3. On GitHub, review the App and select **Create GitHub App for &lt;you&gt;**. GitHub sends the browser back to the Curia app with a one-hour conversion code.

The service converts the code itself. It writes the App id and the private key to `secrets/github-app.json` in the installation root, owner-only, mode `0600`, and adopts the App in the running service. The key is never shown, never logged, and never sent to the browser. If the conversion fails, the card says why, and **Create GitHub App** starts the flow again.

### Install the App

After the App exists, the card lists every owner on the watch list with an **Install on &lt;owner&gt;** link. Install the App for each owner whose repositories Curia watches, and grant it the watched repositories. On GitHub, **Only select repositories** with the watched repositories is enough. Then select **Try again**.

### What verification proves

Every read of the card runs the same verification:

1. At least one repository is on the watch list.
2. GitHub accepts the App's own credential and lists its installations.
3. For each installed owner, Curia mints an installation token with the write permissions agents run on. The token is used for this verification and dropped. It reaches no file and no log.
4. The installation grants at least one watched repository.
5. Curia reads the open tickets of the covered repositories with that token.

The card connects when steps 1 to 5 pass. The footer shows a real discovered ticket, one that carries `ready-for-agent` and has no assignee, with its repository and the count of open tickets. When there is no such ticket, the footer names the covered repository, the count of open tickets (or `No open tickets`), and what the minted credential can do: `Issues, pull requests, and contents ready`. Curia never invents a ticket.

A failed step names the failure and one action, for example `curia's GitHub App is not installed on alp82` with `Install the App on alp82 from the link in this panel and grant it alp82/curia, then try again.` Do what the action says and select **Try again**, which runs the whole verification again.

The card remembers only the App name (`progress.github.app_name`) for a reopen. The App id and key live in `secrets/github-app.json` and nowhere else.

## Connect Discord

The Discord card connects a dedicated bot you create in Discord's developer portal, then finds or creates the command channel Curia speaks in. You paste the bot token once. Curia writes it to `secrets/discord-bot-token` in the installation root, owner-only, mode `0600`, and never shows it again.

### Create the bot

1. Open the [Discord developer portal](https://discord.com/developers/applications) and select **New Application**. Name it for this installation, for example `curia-box`.
2. Under **Bot**, turn on **Message Content Intent**. The bridge reads the messages you type in the command channel, and Discord withholds their text without this intent.
3. Select **Reset Token** and copy the token. Discord shows it once.
4. In Discord, turn on **Developer Mode** under **Settings** > **Advanced**, then copy your user ID from your profile menu.
5. On the **Discord** card, paste the token, enter your user ID, and select **Connect bot**.

The token goes to the service and straight into its secret file. The user ID goes to `state/discord.json` as the one allowed user, which is the whole access check: only that account can command Curia. The card then shows the bot's name and lists the servers the bot is in.

### Add the bot and choose the channel

1. If the bot isn't in your server yet, select **Add the bot to a server**. The link opens Discord's own authorization page with the `bot` and `applications.commands` scopes and the permissions Curia uses: View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads, and Manage Channels. Approve it in Discord, then select **Try again**.
2. Select the server and enter the command channel's name. The field suggests `curia`, but any name works.
3. Select **Connect channel**.

Curia reuses a top-level text channel of that name when the bot can use it, and creates one when there is none. A channel of that name under a category isn't the one, because the bridge opens only top-level channels.

### What verification proves

Every read of the card runs the same verification, in this order:

1. The token is on disk. Without it the card is plain, **Ready to connect**.
2. An operator user ID is beside it.
3. Discord accepts the token.
4. The bot is in the selected server.
5. Your user ID is a member of that server.
6. The command channel exists top-level as a text channel, or Curia creates it.
7. In that channel, the bot holds every permission the bridge uses.
8. Curia registers its slash commands on that server.
9. A confirmation message from Curia stands in the channel. Curia posts one when none is there.

The card connects when steps 1 to 9 pass. The footer shows the channel and the server, then `Confirmation delivered · <n> commands registered`. The panel links the channel and the confirmation message, names the operator Curia found, and lists the registered commands.

Curia looks for its own earlier confirmation before posting another, so opening **Setup** doesn't fill the channel with repeated lines. To get a fresh confirmation, delete the earlier one and select **Try again**.

A failed step names the failure and one action, for example `curia can't Send Messages in #curia` with `Allow Send Messages for the bot in #curia's permissions, then try again.` Do what the action says and select **Try again**. When Discord refuses the token, the panel puts the token form first so you can submit a new one.

### After the card connects

The bridge, the part of the service that logs in to Discord, reads the token and `state/discord.json` when the service starts. After the card connects for the first time, the panel says whether the bridge is running and offers **Restart Curia** when it isn't. Until the bridge runs, the card is verified but the bot doesn't answer in the channel.

The card remembers the server id and the channel name (`progress.discord.guild_id` and `progress.discord.channel`) for a reopen. The token lives in `secrets/discord-bot-token` and nowhere else. The token never appears in a log line, a diagnostic, or a browser response, and a refused paste is described by shape rather than echoed.

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
- `progress`: per card, only these fields: `app_name` for GitHub (the name you gave the App), `guild_id` and `channel` for Discord, `machine_name` for Tailscale, `provider` for the model card.

The file never holds a token, a key, or a completion marker. A field outside that list is refused by name. Nothing about setup is stored in the browser. A `state/setup.json` file that can't be read starts setup on the GitHub card with no progress, and the service log says so.

Credentials a step collects go to their secret files under `secrets/`, as [Secrets, mounts, and what survives](secrets.md) describes. The Discord facts that aren't secret go to `state/discord.json`.

## Where the frame lives

The Curia app serves the frame at `#setup`. The app reads the record and the four verifications from the service with `GET /setup` through its sidecar, and writes the selected card and safe progress with `POST /setup`. The service refuses a write that names a card or a field outside the lists in the preceding section, and it never prints a secret in the answer.
