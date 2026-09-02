# Integration setup

Integration setup is the **Setup** screen of the Curia app. It connects one installation to the four resources the Full loop needs: GitHub, Discord, Tailscale, and one model provider. This page is the reference for the setup frame: what the four cards show, how you move between them, what a reopen restores, and what Curia keeps on disk. The GitHub card's own steps are in [Connect GitHub](#connect-github), the Discord card's in [Connect Discord](#connect-discord), the Tailscale card's in [Connect Tailscale](#connect-tailscale), and the model provider card's OpenAI steps in [Connect OpenAI](#connect-openai). The Anthropic steps are documented when they land.

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

## Connect Tailscale

The Tailscale card verifies the Tailscale node this host already runs, publishes Curia's own Serve route for the app, and records the operator who may open Curia. Curia never installs Tailscale, logs the node in, renames it, or changes the tailnet's policy. Every failed check names the command you run on the host or the page you open in the Tailscale admin console.

### Who may open Curia

Every request that reaches the Curia app through Tailscale Serve carries the login of the tailnet user who sent it, and Serve overwrites a forged one. That login is the identity check in front of the app, the terminal, the chat, and every preview.

On a fresh installation, no operator is recorded, so the app admits the first tailnet identity that opens it, and only to **Setup**. The rest of the app, the terminal, the chat, and every verb stay refused until an operator is confirmed. The **Tailscale** card shows the identity you arrived with: `You opened Curia as <login> through Tailscale`.

### Confirm the operator

1. Open the Curia app at the address `curia install` printed, `https://<node>:8445/`, through Tailscale. A request on loopback carries no identity and can't confirm anything.
2. On the **Tailscale** card, check the identity the panel names. It is the login Tailscale stamped on your request, and the browser can't change it.
3. Keep the machine name or enter the node's current name. The field defaults to `curia.sh`, which reads as `curia-sh` in MagicDNS. The panel names the node's current name beside the field. Curia doesn't rename the node. To rename it, run `sudo tailscale set --hostname <name>` on the host.
4. Select **Confirm operator and verify**.

Curia records the login, when it was confirmed, and the machine name in `state/tailscale.json` in the installation root, mode `0600`. From that moment the recorded login is the whole identity allowlist under an installation root, for the service and the app alike, with no restart. The `identity.allow` list in `curia.yaml` belongs to the source deployment and admits nobody under an installation root.

### What verification proves

Every read of the card runs the same verification, in this order:

1. An operator is recorded. Without one the card is plain, **Ready to connect**.
2. `tailscale` answers on this host.
3. The node is logged in, running, and online.
4. The tailnet issues an HTTPS certificate for the node. Its name is the private address.
5. The node's MagicDNS name is the machine name you expect.
6. Curia's own Serve route stands: the app on port `8445`, proxied to `127.0.0.1:4273`. Curia creates the route when it is missing and records it in `state/tailscale.json`. It creates no other route.
7. The app answers on its own address and admits the recorded login. Curia times this request.

The card connects when steps 1 to 7 pass. The footer shows the private MagicDNS name, then `<login> · admitted in <n> ms`. The panel shows the private address as a link, the operator and when you confirmed, the node's addresses and Tailscale version, the Serve route, and when the operator last arrived through Tailscale since the service started.

A failed step names the failure and one action, for example `This node is named alp-workstation, not curia-sh` with `Run sudo tailscale set --hostname curia.sh on this host, or enter alp-workstation as the machine name in this panel, then try again.` Do what the action says and select **Try again**. The following table lists the checks and their actions.

| Failed check | Action |
|---|---|
| Tailscale isn't installed, or `tailscale` isn't on the path. | Install Tailscale from the Linux download page and log the node in. |
| `tailscaled` doesn't answer. | Run `sudo systemctl start tailscaled`. |
| The node is logged out or offline. | Run `sudo tailscale up` and finish the login in the browser. |
| The tailnet issues no HTTPS certificate. | Enable HTTPS certificates under **DNS** in the Tailscale admin console. |
| The node's name isn't the machine name you entered. | Rename the node with `sudo tailscale set --hostname <name>`, or enter the node's current name. |
| Serve refuses Curia's route. | Run `sudo tailscale set --operator=$USER` so your user may use Serve. |
| The app refuses the recorded login. | Restart Curia so the app reads the recorded operator. |
| The app doesn't answer on `127.0.0.1:4273`. | Check the dashboard service with `docker compose ps`. |

The card remembers only the machine name (`progress.tailscale.machine_name`) for a reopen. The recorded operator and Curia's Serve routes live in `state/tailscale.json`. Nothing in that file is a secret. `curia uninstall` reads the recorded routes to withdraw them.

## Connect OpenAI

The **Model provider** card holds one row per provider, OpenAI and Anthropic. One verified provider is required, and you can add the second one later from the same card. This section is the OpenAI row. It connects the ChatGPT subscription Curia's codex agents run on, through the sign-in Curia already uses, and verifies it with one minimal model request. There is no API-key path: the row has no key field, and Curia holds no API key.

### Sign in

1. On the **Model provider** card, select **Sign in to OpenAI**. Curia opens a sign-in session on this host (`codex login --device-auth` in a session the service drives) and the row shows a link and a one-time code within a few seconds. The first press on a fresh installation can take longer, because the service prepares the agent image first.
2. Open the link on any device, sign in to your ChatGPT account, and enter the code. Nothing is pasted back. The code lives fifteen minutes.
3. Wait for the row to verify. Curia watches for the credential, adopts it the moment it lands, and runs the verification.

The credential lands in `secrets/codex-auth.json` in the installation root, owner-only, mode `0600`, written by the same adoption that `reauth openai` uses. Curia refreshes it from then on. The one-time code and the link exist only in the service's memory while the login runs and in this panel. They reach no file and no log. If the link or the code doesn't show, the row offers **Open the terminal instead**, which is the sign-in session itself.

A login that ends without a credential (the code ran out, the session closed) is said on the row, and **Sign in to OpenAI** starts it again.

### What verification proves

Every read of the card runs the same verification, in this order:

1. The credential is on disk. Without it the row is plain, **Ready to connect**.
2. The credential is within the secret boundary, is a codex credential, and hasn't expired.
3. OpenAI completes one minimal model request on the Codex backend the codex CLI uses with a subscription: a one-line prompt to the routing preset's model, no tools, nothing stored. Curia times this request.
4. Routing is ready: every ticket type routes to an active model whose provider has a credential on disk, and every OpenAI model is on. When it isn't, Curia applies the routing preset, described in the next section.

The card connects when steps 1 to 4 pass. The footer shows `OpenAI`, then `Routing ready · verification request completed in <n> s`. The row shows the plan of the subscription, when the credential expires, the model that answered and how long it took, and the routing preset. Curia records the opaque account ID, the plan, the model, the response ID, the token counts, the timing, and when. It never records the email on the credential or any token.

A failed step names the failure and one action, for example `OpenAI refused the credential (HTTP 401: invalid token)` with `Sign in to OpenAI from this panel, then try again.` Do what the action says and select **Try again**. The following table lists the checks and their actions.

| Failed check | Action |
|---|---|
| The secret file is a link, is owned by another user, or is readable past the owner. | Fix the file as the message says, or sign in again. |
| The file isn't a codex credential, or the credential has expired and Curia couldn't refresh it. | Sign in to OpenAI from this panel. |
| OpenAI refuses the credential (HTTP 401 or 403). | Sign in to OpenAI from this panel. |
| OpenAI answers HTTP 429. | Wait for the usage window to reset, or sign in with another subscription. |
| OpenAI can't be reached, answers another error, or the stream ends without completing. | Check outbound access (`curia doctor`), wait a moment, and try again. |
| The routing preset can't be written. | Fix the routing override file the message names so the service can write it. |

### The routing preset

Routing in `routing.yaml` names a model per ticket type, and the shipped file routes most types to an Anthropic model. On a fresh installation with only OpenAI signed in, that routing can't run. So the first verified read applies a preset: every ticket type whose model can't run moves to the OpenAI model (`gpt`, which is `gpt-5.6-sol`) with the type's own reasoning effort, OpenAI's models switch on, and the models of a provider with no credential switch off. Types that already route to a model that can run stay as they are, and the tracked `routing.yaml` is never edited.

The preset lands in the routing override file, the same file the Settings screen writes: `state/routing.local.yaml` in the installation root, or `config/routing.local.yaml` beside `routing.yaml` in the source deployment. The service applies it at once, with no restart. A routing that is ready is left alone, so a routing choice you make in Settings later isn't rewritten by a read, unless it routes a type to a model that can't run. When you add the second provider, its own verification switches its models back on.

The card remembers only the provider you last signed in (`progress.model.provider`) for a reopen. The credential lives in `secrets/codex-auth.json` and nowhere else.

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

Credentials a step collects go to their secret files under `secrets/`, as [Secrets, mounts, and what survives](secrets.md) describes. The Discord facts that aren't secret go to `state/discord.json`, the recorded Tailscale operator and Curia's Serve routes go to `state/tailscale.json`, and the routing preset a model provider applies goes to `state/routing.local.yaml`.

## Where the frame lives

The Curia app serves the frame at `#setup`. The app reads the record and the four verifications from the service with `GET /setup` through its sidecar, and writes the selected card and safe progress with `POST /setup`. The service refuses a write that names a card or a field outside the lists in the preceding section, and it never prints a secret in the answer.
