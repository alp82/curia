# Integration setup

Integration setup is the **Setup** screen of the Curia app. It connects one installation to the four resources the Full loop needs: GitHub, Discord, Tailscale, and one AI login. This page is the reference for the setup frame: what the four cards show, how you move between them, what a reopen restores, and what Curia keeps on disk. The GitHub card's own steps are in [Connect GitHub](#connect-github), the Discord card's in [Connect Discord](#connect-discord), the Tailscale card's in [Connect Tailscale](#connect-tailscale), and the model provider card's OpenAI steps in [Connect OpenAI](#connect-openai) and Anthropic steps in [Connect Anthropic](#connect-anthropic). When setup is ready and what the Test run runs on is in [The Test run](#the-test-run). The operator guide walks the same screen in [3. Connect services](guide/03-connect-services.md) and [4. Run the Test run](guide/04-run-the-test-run.md); this page is the reference behind those topics.

After `curia install` finishes, open the address it printed, `https://<your node's MagicDNS name>:8445/`, and open **Setup**. Home also points at **Setup** while an integration isn't connected.

## The four cards

The rail on the left holds one card per integration, in this order: **GitHub**, **Discord**, **Tailscale**, **AI logins**. Select any card to open its configuration on the right. You can connect the four in any order.

Every card has the same height in every state, so a verification never moves the rail. Each card has a header with the service's logo, its name, and a state badge, and a footer with the card's data. The following table lists the states.

| State | Badge | Header and footer | Footer shows |
|---|---|---|---|
| Not connected | **Ready to connect** | Dimmed header, plain footer. | The data that will appear after the integration verifies. |
| Not available | **Not available** | Dimmed header, plain footer. | The same line. The configuration panel says the step isn't available in this release yet. |
| Connected | **Connected and verified** (**Provider verified** or **Two providers verified** on the model card) | Full brand color on the header, a light brand tint on the footer. | One real fact and one supporting line, such as a discovered ticket and its repository, the command channel and the registered commands, the private address and the verified operator, or the connected providers and the verification timing. |
| Failed | **Action required** | Red border, red-tinted header and footer. | The verification that failed and the one corrective action. |

The footer never shows a decorative number. Before a card verifies, it names the data that will appear. After, it shows what Curia found.

The GitHub and Discord cards are guides of three steps. While such a card is on its way, its badge counts the step, for example **Step 2 of 3**, and its footer names what the step waits for. An expected state on the way, no App yet, no installation yet, nothing watched yet, the bot in no server yet, is a step with its next action, never the red **Action required** state. That state, and **Try again**, appear on a real failure only: GitHub refused the App, a token failed, a watched repository lost its coverage, Discord refused the token, or the bot lost a permission.

## Connect GitHub

The GitHub card creates a dedicated GitHub App for this installation through GitHub's manifest flow, then verifies that the App can reach at least one watched repository. Curia never asks for your GitHub password, a personal access token, or anything from GitHub's consent page. You sign in and approve on GitHub.

The card is a guide of three steps, and the panel shows which one you're at: **1 Create the App**, **2 Install the App**, **3 Choose repositories and continue**. Each step has one action, and the card moves to the next step on its own when the action is done.

### Step 1: Create the App

1. On the **GitHub** card, keep the suggested App name or enter your own. GitHub slugifies the name, and Curia posts as `<slug>[bot]`, so the name is read as the author of every commit, pull request, and gate approval. The name must be free across all of GitHub.
2. Select **Create GitHub App**. Curia prepares the manifest (the five repository permissions from [The curia GitHub App](../github-app.md#2-grant-the-permissions), no webhook, installable on any account) and the browser opens GitHub's own page with that manifest.
3. On GitHub, review the App and select **Create GitHub App for &lt;you&gt;**. GitHub sends the browser back to the Curia app with a one-hour conversion code.

The service converts the code itself. It writes the App id and the private key to `secrets/github-app.json` in the installation root, owner-only, mode `0600`, and adopts the App in the running service. The key is never shown, never logged, and never sent to the browser. If the conversion fails, the card says why, and **Create GitHub App** starts the flow again.

### Step 2: Install the App

After the App exists, the card is at step 2 and the badge reads **Step 2 of 3**. On a fresh installation nothing is watched yet, so the panel shows one **Install the App on GitHub** link. Install the App on the account that owns your repositories and grant it the repositories Curia may work on. On GitHub, **Only select repositories** is enough. There is nothing to press afterwards: the panel says `Waiting for an installation that covers a repository` and reads the installations again on the Setup page's refresh interval (`poll_interval_s`, 5 seconds by default), so the card moves to step 3 within seconds of the installation, with no reload and no press.

Once a repository is on the watch list, the panel lists every watched owner instead, each with this read's installation state and an **Install on &lt;owner&gt;** or **Manage installation** link. The state comes from the same verification that turns the card, so an owner the card calls installed is installed on this read.

### Step 3: Choose repositories and continue

When an installation covers at least one repository, the card is at step 3 and the panel lists every repository the App's installations cover, each with a checkbox. On a fresh installation every repository is ticked. Untick the ones Curia shouldn't work on, then select **Watch these repositories and continue**. The service writes the ticked repositories into `watch` in [`config/config.yaml`](configuration.md#the-watch-list-is-yours-alone) through the same validated save the settings screen uses, applies the list to the running service, and the card verifies again on the new list. When that verification connects the card, setup continues to the next card that isn't connected, in rail order. That one press is the whole step.

A connected card keeps the same list under **Change the watched repositories**, with the watched repositories ticked, and the press there is **Watch these repositories**, which verifies again and stays on the card. A watched repository that no installation covers stays on the list and is marked `not covered by an installation`; grant it on GitHub or untick it. A repository can't leave the list while an agent runs on it, and the card says so.

Curia doesn't remember the choice anywhere else. The watch list in `config/config.yaml` is the choice.

### What verification proves

Every read of the card runs the same verification:

1. GitHub accepts the App's own credential and lists its installations.
2. For each installation, Curia mints an installation token with the write permissions agents run on and reads the repositories the installation grants. The token is used for this verification and dropped. It reaches no file and no log.
3. At least one repository is on the watch list. With none, the card is at step 2 while no installation covers a repository and at step 3 once one does. Neither is a failure.
4. At least one watched repository is covered by an installation.
5. Curia reads the open tickets of the covered repositories with that token.

The card connects when steps 1 to 5 pass. One covered watched repository is enough: a watched owner without an installation is shown as `missing access` in the owner rows and doesn't fail the card while another owner covers a watched repository. The footer shows a real discovered ticket, one that carries `ready-for-agent` and has no assignee, with its repository and the count of open tickets. When there is no such ticket, the footer names the covered repository, the count of open tickets (or `No open tickets`), and what the minted credential can do: `Issues, pull requests, and contents ready`. Curia never invents a ticket.

A failed check is a real failure: GitHub refused the App's credential, a token failed to mint, an installation can't be read, or a watched repository lost its coverage, for example `curia's GitHub App is not installed on alp82` with `Install the App on alp82 from the link in this panel and grant it alp82/curia, then try again.` The failure names only the owners this read found missing. The panel keeps the guide at the step the failure belongs to, so the install link or the repository list stays at hand beside the failure. Do what the action says and select **Try again**, which runs the whole verification again. The panel shows the result of the latest read only: a failure from an earlier read disappears when the new read connects the card.

The card remembers only the App name (`progress.github.app_name`) for a reopen. The App id and key live in `secrets/github-app.json` and nowhere else.

## Connect Discord

The Discord card connects a dedicated bot you create in Discord's developer portal, then finds or creates the command channel Curia speaks in. You paste the bot token once. Curia writes it to `secrets/discord-bot-token` in the installation root, owner-only, mode `0600`, and never shows it again.

The card is a guide of three steps, in this order: the token, a wait until the bot is in a server, and the channel. Nothing is created in Discord until you select **Connect channel**. Two presses connect the card, **Connect bot** and **Connect channel**. Each press verifies on its own, and the one press left after the card connects is **Continue**.

### Create the bot

1. Open the [Discord developer portal](https://discord.com/developers/applications) and select **New Application**. Name it for this installation, for example `curia-box`.
2. Under **Bot**, turn on **Message Content Intent**. The bridge reads the messages you type in the command channel, and Discord withholds their text without this intent.
3. Select **Reset Token** and copy the token. Discord shows it once.
4. In Discord, turn on **Developer Mode** under **Settings** > **Advanced**, then copy your user ID from your profile menu.
5. On the **Discord** card, paste the token, enter your user ID, and select **Connect bot**.

The token goes to the service and straight into its secret file. The user ID goes to `state/discord.json` as the one allowed user, which is the whole access check: only that account can command Curia. The card then shows the bot's name and the invite link.

### Add the bot to a server

Until the bot is in at least one server, the card is at step 2, the badge reads **Step 2 of 3**, and the panel says `Waiting for the bot to join a server` and shows only the invite link. There is no server to select and no channel to name yet, so the panel offers neither field. The wait is a step of the guide, not a failure: the card stays plain and offers no **Try again**.

1. Select **Add the bot to a server**. The link opens Discord's own authorization page with the `bot` and `applications.commands` scopes and every permission Curia uses.
2. Approve it in Discord, with all of the permissions. The following table names each one and why the bot needs it.

| Permission | Why the bot needs it |
| --- | --- |
| View Channel | Read the command channel. |
| Send Messages | Post in the command channel. |
| Send Messages in Threads | Post in ticket threads. |
| Create Public Threads | Open a thread per ticket. |
| Manage Threads | Rename, archive, and delete ticket threads. |
| Embed Links | Post escalation embeds and links. |
| Attach Files | Attach files and images. |
| Read Message History | Find earlier messages and its own confirmation. |
| Add Reactions | Mark a message as read or refused. |
| Use Application Commands | Serve the slash commands. |
| Manage Webhooks | Speaker identity: agent prose posts under the curia name through a channel webhook. Without it, the bridge posts `Speaker identity is off` and agent prose uses the bot identity. |
| Manage Channels | Create the command channel when it does not exist. Needed on the server, not in the channel. |

The invite link, the card's channel verification, and the bridge's own check at start read one list, `BOT_PERMISSIONS` in `daemon/src/bridge.mjs`, so a permission the bridge starts to use is asked for by the invite and checked by the card in the same change. The #891 rehearsal found an invite that omitted Manage Webhooks: the card connected, and the first word of the gap was the bridge's notice in the channel.

While the panel waits, it reads the bot's servers again on the Setup page's refresh interval (`poll_interval_s`, 5 seconds by default), so the server appears within seconds of the approval, with no reload and no press. The moment a server is there, the card verifies fresh and the panel shows the server select and the channel field.

### Choose the channel

1. Select the server.
2. Enter the command channel's name. The field suggests `curia`, but any name works, and you can change it before anything exists.
3. Select **Connect channel**.

The card is at step 3 while a server is there and none is chosen; the badge reads **Step 3 of 3**.

**Connect channel** writes the server and the channel name to `state/discord.json`, then reuses a top-level text channel of that name when there is one and creates one when there is none, and registers Curia's slash commands on that server once. The card verifies fresh as part of the same press and shows the result: the connected state with **Continue**, or the failure with its action. This press is the only step that creates anything in Discord: a verification read, whether on arrival, on the refresh, or on **Try again**, never picks a server for you, never creates a channel, and never registers the commands. A channel of that name under a category isn't the one, because the bridge opens only top-level channels. When Discord refuses the creation, the panel says why under the button, keeps your choice, and names the fix: give the bot Manage Channels, or create the text channel yourself, then select **Connect channel** again.

### What verification proves

Every read of the card runs the same verification, in this order:

1. The token is on disk. Without it the card is plain, **Ready to connect**.
2. An operator user ID is beside it.
3. Discord accepts the token.
4. The bot is in at least one server, and you selected one of them.
5. Your user ID is a member of that server.
6. The command channel exists top-level as a text channel. Verification never creates it; **Connect channel** does.
7. In that channel, the bot holds every permission the bridge uses: the table under [Add the bot to a server](#add-the-bot-to-a-server), Manage Channels aside.
8. The slash commands registered on that server match Curia's, by name and description. Verification reads them and never registers them; **Connect channel** and the bridge's start do, and **Register commands** does it again.
9. A confirmation message from Curia stands in the channel. Curia posts one when none is there.

Each read makes only reads against Discord: the bot, its servers, the operator's membership, the channels, the bot's roles, the registered commands, and the channel's last 50 messages. The one write a read can make is the confirmation message, and only when none of Curia's stands in the channel. This matters because the Setup page reads the card every few seconds while it's open, and Discord counts every command registration against a daily limit per server. A version that registered on every read hit that limit within minutes of connecting (found in the #891 rehearsal).

The card connects when steps 1 to 9 pass. The footer shows the channel and the server, then `Confirmation delivered · <n> commands registered`. The panel links the channel and the confirmation message, names the operator Curia found, and lists the registered commands.

Curia looks for its own earlier confirmation before posting another, so opening **Setup** doesn't fill the channel with repeated lines. To get a fresh confirmation, delete the earlier one and select **Try again**.

A failed step names the failure and one action, for example `curia can't Send Messages in #curia` with `Allow Send Messages for the bot in #curia's permissions, then try again.` When Manage Webhooks is what's missing, the action says that it is for speaker identity. Do what the action says and select **Try again**. The bridge runs the same check when it starts and posts the same words in the channel when a permission was withdrawn after the card connected. When Discord refuses the token, the panel puts the token form first so you can submit a new one. The bot in no server yet and no server chosen yet are steps 2 and 3 of the guide, not failures.

When the registered commands differ from Curia's, for example after an update that added a command or when another tool replaced them, the card reads `The commands registered in <server> differ from curia's: /tickets is not registered`, and the panel offers **Register commands**. That press registers the current manifest on the selected server, replacing what's there, and verifies fresh. The invite link is the fix only when Discord refuses the registration itself, which means the bot was added without the `applications.commands` scope.

When Discord rate limits the bot, on any call, the card doesn't fail. It reports the fact and the wait, `Discord is rate limiting this bot; it answers again in 12 s`, keeps the state of its last verification (a connected card stays connected with that line as its footer, a failed one keeps its failure with the wait as the action), and the action is to wait. Don't add the bot again for a rate limit. The panel's own read says the same and keeps the token form behind its fold.

### After the card connects

The bridge, the part of the service that logs in to Discord, starts on its own when the token is on disk. **Connect channel** starts it and waits for its login before the card answers, so the connected panel says `The bridge is running`. The service also starts the bridge on any Discord read that finds the token and no bridge, so a token that landed while the bridge was down is picked up by the next read, with no restart. If the panel says the bridge isn't running, the service log names the cause; a login Discord refuses is retried on a growing ladder, up to once a minute.

The card remembers the server id and the channel name (`progress.discord.guild_id` and `progress.discord.channel`) for a reopen. The token lives in `secrets/discord-bot-token` and nowhere else. The token never appears in a log line, a diagnostic, or a browser response, and a refused paste is described by shape rather than echoed.

## Connect Tailscale

The Tailscale card verifies the Tailscale node this host already runs, publishes Curia's own Serve route for the app, and records the operator who may open Curia. The node joined your tailnet during `curia install`, under the name you gave it there; see [The tailnet step](install.md#the-tailnet-step). Curia never installs Tailscale, renames the node, or changes the tailnet's policy, and the card has no field: the node's name and address are facts it shows. Every failed check names the command you run on the host or the page you open in the Tailscale admin console.

### Who may open Curia

Every request that reaches the Curia app through Tailscale Serve carries the login of the tailnet user who sent it, and Serve overwrites a forged one. That login is the identity check in front of the app, the terminal, the chat, and every preview.

On a fresh installation, no operator is recorded, so the app admits the first tailnet identity that opens it, and only to **Setup**. The rest of the app, the terminal, the chat, and every verb stay refused until an operator is confirmed. The **Tailscale** card shows the identity you arrived with: `You opened Curia as <login> through Tailscale`.

### Confirm the operator

1. Open the Curia app at the address `curia install` printed, `https://<node>:8445/`, through Tailscale. A request on loopback carries no identity and can't confirm anything.
2. On the **Tailscale** card, check the identity the panel names. It is the login Tailscale stamped on your request, and the browser can't change it. The panel also names the node and its address as facts. The name was chosen at installation with `--name`, and the card doesn't change it. To change it, reinstall with another `--name`, or run `sudo tailscale set --hostname <name>` on the host and then select **Restart Curia** on the card; the app is served under the name the sidecar read when it started. See [The tailnet step](install.md#the-tailnet-step).
3. Select **Confirm operator and verify**. That one press records the operator and verifies the card. The panel then shows the result, the connected state with **Continue** or the failure with its action, and asks for nothing else.

Curia records the login, when it was confirmed, and the node's machine name, read from the node, in `state/tailscale.json` in the installation root, mode `0600`. From that moment the recorded login is the whole identity allowlist under an installation root, for the service and the app alike, with no restart. The `identity.allow` list in `curia.yaml` belongs to the source deployment and admits nobody under an installation root.

### What verification proves

Every read of the card runs the same verification, in this order:

1. An operator is recorded. Without one the card is plain, **Ready to connect**.
2. `tailscale` answers on this host.
3. The node is logged in, running, and online.
4. The tailnet issues an HTTPS certificate for the node. Its name is the private address, and its first label is the machine name the record keeps, refreshed when the node was renamed by hand.
5. Curia's own Serve route stands: the app on port `8445`, proxied to `127.0.0.1:4273`. Curia creates the route when it is missing and records it in `state/tailscale.json`. It creates no other route.
6. The app answers on its own address and admits the recorded login. Curia times this request.

The card connects when steps 1 to 6 pass. The footer shows the private MagicDNS name, then `<login> · admitted in <n> ms`. The panel shows the private address as a link, the operator and when you confirmed, the node's addresses and Tailscale version, the Serve route, and when the operator last arrived through Tailscale since the service started.

A failed step names the failure and one action, for example `The tailnet issues no HTTPS certificate for this node, so Serve can't publish the Curia app` with `Enable HTTPS certificates under DNS in the Tailscale admin console at https://login.tailscale.com/admin/dns, then try again.` Do what the action says and select **Try again**. While you are the recorded operator, **Try again** is the one press on a failed card: confirming the same identity again would only repeat that read. When you open the card as another identity, the panel says who the recorded operator is and offers **Confirm &lt;login&gt; as the operator**, which is a real change. The following table lists the checks and their actions.

| Failed check | Action |
|---|---|
| Tailscale isn't installed, or `tailscale` isn't on the path. | Install Tailscale from the Linux download page and log the node in. |
| `tailscaled` doesn't answer. | Run `sudo systemctl start tailscaled`. |
| The node is logged out or offline. | Run `sudo tailscale up` and finish the login in the browser. |
| The tailnet issues no HTTPS certificate. | Enable HTTPS certificates under **DNS** in the Tailscale admin console. |
| Serve refuses Curia's route. | Run `sudo tailscale set --operator=$USER` so your user may use Serve. |
| The app refuses the recorded login. | Restart Curia so the app reads the recorded operator. |
| The app doesn't answer on `127.0.0.1:4273`. | Check the dashboard service with `docker compose ps`. |

The card has no field, so it remembers nothing for a reopen. The recorded operator, the node's machine name, and Curia's Serve routes live in `state/tailscale.json`. Nothing in that file is a secret. `curia uninstall` reads the recorded routes to withdraw them.

## Connect OpenAI

The **AI logins** card holds one row per provider, OpenAI and Anthropic. One verified login is required, and you can add the second one later from the same card. This section is the OpenAI row; [Connect Anthropic](#connect-anthropic) is the other. It connects the ChatGPT subscription Curia's codex agents run on, through the sign-in Curia already uses, and verifies it with one minimal model request. There is no API-key path: the row has no key field, and Curia holds no API key.

### Sign in

1. On the **AI logins** card, select **Sign in to OpenAI**. Curia opens a sign-in session on this host (`codex login --device-auth` in a session the service drives) and the row shows a link and a one-time code within a few seconds. The session runs in the agent image the release ships, which `curia install` pulled; nothing is built. Opening the row prepares that image, so the press has nothing left to pull.
2. Open the link on any device, sign in to your ChatGPT account, and enter the code. Each of the link and the code has a **Copy** button. Nothing is pasted back. The code lives fifteen minutes.
3. Wait for the row to verify. Curia watches for the credential, adopts it the moment it lands, and runs the verification.

The row shows what the sign-in is doing, in this order:

| State | What the row shows |
|---|---|
| Starting | `openai · starting the sign-in session`. Curia is ensuring the agent image and starting the session. No press is offered. |
| Waiting for the link | `Waiting for the sign-in link`. The session runs and Curia reads its pane every few seconds. **Open the terminal instead** links the session itself. |
| Signing in | The link, the one-time code, their **Copy** buttons, the time left on the code, and the terminal link. |
| The pane printed nothing | After 3 minutes without a link, the row says "curia could not read the login off the pane", with one action: open the terminal and finish the sign-in there. |
| Connected | The row verifies on the next read after the credential lands, within one refresh of the card. |

A failure never precedes progress: the row reports the wait as a wait, and the one failure it can report on its own comes only after the 3 minutes. While the panel is open, Curia polls the sign-in session on the panel's own cadence, so the link, the code, and the adoption don't wait for the service's 60 second tick.

One sign-in runs at a time. Selecting **Sign in to Anthropic** while the OpenAI sign-in runs answers that the OpenAI sign-in is still running, and the Anthropic sign-in starts once that one has ended.

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

The preset covers the cross-check rows under `review` too. A review row names the model that reads a builder's diff on the other provider, so with one provider signed in the row that would review that provider has no model to move to: the preset drops it (`review.openai: null` in the override, which the service reads as no pairing), and a cross-check request for that provider is refused by name until the second provider signs in. The row the signed-in provider can review stays. Connecting the second provider restores every review row of the tracked file.

The preset lands in the routing override file, the same file the Settings screen writes: `state/routing.local.yaml` in the installation root, or `config/routing.local.yaml` beside `routing.yaml` in the source deployment. The service applies it at once, with no restart. A routing that is ready is left alone, so a routing choice you make in Settings later isn't rewritten by a read, unless it routes a type to a model that can't run. When you add the second provider, its own verification switches its models back on.

The card remembers only the provider you last signed in (`progress.model.provider`) for a reopen. The credential lives in `secrets/codex-auth.json` and nowhere else.

## Connect Anthropic

This section is the Anthropic row of the **AI logins** card. It connects the Claude subscription Curia's claude agents and the overseer run on, through the sign-in Curia already uses (`claude setup-token`), and verifies it with one minimal model request. There is no API-key path: the row has no key field, and Curia holds no API key. You can connect Anthropic alone, or beside OpenAI.

### Sign in

1. On the **AI logins** card, select **Sign in to Anthropic**. Curia opens a sign-in session on this host (`claude setup-token` in a session the service drives) and the row shows a link within a few seconds. The session runs in the agent image the release ships, which `curia install` pulled; nothing is built. Opening the row prepares that image.
2. Open the link, sign in to your Claude subscription, and approve the request. The browser shows a code. The link has a **Copy** button.
3. Paste the code into the **Code** field on the row and select **Submit**. Curia types it into the sign-in session for you. The row says `Code delivered` when it lands.
4. Wait for the row to verify. The session prints the token once, Curia reads it off the session, asks Anthropic whether it authenticates, adopts it on a yes, and runs the verification.

The credential lands in `secrets/anthropic.json` in the installation root, owner-only, mode `0600`, written by the same adoption that `reauth anthropic` uses. The record holds the token and the instant Curia adopted it. The link exists only in the service's memory while the login runs and in this panel. The code crosses once, from the field to the sign-in session, and reaches no file, no log line, and no answer. The token reaches the secret file and nothing else: not this page, not a log, not the service's own login state. The session closes after thirty minutes when nobody finishes it.

If the sign-in refuses the code (a wrong paste, or a code that ran out), the row says `The login refused the code` with the sign-in's own sentence, and Curia asks the sign-in for a fresh link. Open the new link, approve again, and paste the new code. A login that ends without a credential (the session closed, or Anthropic rejected the token Curia read) is said on the row, and **Sign in to Anthropic** starts it again.

#### The terminal fallback

The row also links **Open the terminal instead**, which is the sign-in session itself in a terminal, where you can paste the code by hand. On an installed Curia the terminal is the app's own `/terminal/` path, `https://<address>:8445/terminal/?arg=curia-auth-anthropic`, served by the app through the same Tailscale Serve route and the same identity check as the page. There is no second route for it: `state/tailscale.json` records the one app route, and `curia uninstall` withdraws that one. The page shows a blank terminal when the session it names has already ended; the row says so, and **Sign in to Anthropic** starts a new one.

The automation guard is unchanged. The service's own write path refuses every `curia-auth-` session, so nothing that types into agent panes (the stall ladder, the chat) can reach a login prompt. The code delivery is the sign-in flow writing into its own session, and it writes nowhere else.

The row moves through the same states as the OpenAI row: starting the session, waiting for the link, signing in (the link, its **Copy** button, the paste-back step, and the terminal link), the failure after 3 minutes without a link, and connected within one refresh of the card after the token is adopted. One sign-in runs at a time: while the OpenAI sign-in runs, the press answers that it is still running, and the Anthropic sign-in starts once that one has ended.

### What verification proves

Every read of the card runs the same verification, in this order:

1. The credential is on disk. Without it the row is plain, **Ready to connect**.
2. The credential is within the secret boundary, is a subscription credential (`sk-ant-…`), and is inside its documented one-year lifetime, counted from the adoption. The token states no dates, so this is an estimate, and the row says so.
3. Anthropic completes one minimal Messages request with the subscription credential, the same request Curia's account-usage probe makes: the cheapest model the service's `usage.probe_model` names, a one-line prompt, a few output tokens, no tools. Curia times this request.
4. Routing is ready: every ticket type routes to an active model whose provider has a credential on disk, and every Anthropic model is on. When it isn't, Curia applies the routing preset, described in the next section.

The card connects when steps 1 to 4 pass. The footer shows `Anthropic`, then `Routing ready · verification request completed in <n> s`. The row shows when the credential was adopted and the estimated time left, the model that answered and how long it took, and the routing preset. Curia records the adoption instant, the estimated expiry, the model, the message ID, the request ID Anthropic stamped, the stop reason, the token counts, the timing, and when. A subscription token carries no account identity, and Curia records none. It never records the token.

A failed step names the failure and one action, for example `Anthropic refused the credential (HTTP 401: invalid x-api-key)` with `Sign in to Anthropic from this panel, then try again.` Do what the action says and select **Try again**. The following table lists the checks and their actions.

| Failed check | Action |
|---|---|
| The secret file is a link, is owned by another user, or is readable past the owner. | Fix the file as the message says, or sign in again. |
| The file isn't a subscription credential, or the credential passed its documented lifetime. | Sign in to Anthropic from this panel. |
| Anthropic refuses the credential (HTTP 401 or 403). | Sign in to Anthropic from this panel. |
| Anthropic answers HTTP 429. | Wait for the usage window to reset, or sign in with another subscription. |
| Anthropic can't be reached, answers another error, answers something that isn't a message, or the message ends with a refusal. | Check outbound access (`curia doctor`), wait a moment, and try again. |
| The routing preset can't be written. | Fix the routing override file the message names so the service can write it. |

### The routing preset with Anthropic

The preset is the one described under [Connect OpenAI](#the-routing-preset), applied for Anthropic. The shipped `routing.yaml` routes most ticket types to Anthropic models already, so with only Anthropic signed in, the rows that can't run (the `research` type, on `gpt`) move to the first Anthropic model routing names (`fable`) with their own reasoning effort, Anthropic's models switch on, and OpenAI's switch off. The review row that would read an Anthropic builder's diff on `gpt` is dropped until OpenAI signs in; the row that reviews an OpenAI builder on `opus` stays. A type that routes to `fable` on an account without Fable usage credits falls down the chain `routing.yaml` names under `fallbacks`, the way any dispatch does.

With both providers signed in, the preset covers both: every ticket type stays on the model it has when that model can run, and every model of both providers is on. Connecting the second provider switches its models back on and moves nothing that already runs. The override lands in the same `state/routing.local.yaml`, and the tracked `routing.yaml` is never edited.

The card remembers only the provider you last signed in (`progress.model.provider`) for a reopen. The credential lives in `secrets/anthropic.json` and nowhere else.

## Verification is fresh

A card's state comes from a verification that Curia runs when you open **Setup** and every time you select **Try again**. Curia doesn't keep a "connected" marker. A card that verified yesterday and doesn't verify today shows as failed today, with the reason and the action.

The rail's count, `n/4 verified`, and the Home pointer read the same fresh result.

## When a verification fails

A failed card names the verification that failed and exactly one corrective action, on the card and in the configuration panel. Do what the action says, then select **Try again**. **Try again** runs the verification again for every card. There is no background retry.

A card on its way through its steps isn't failed. The GitHub card waiting for an installation and the Discord card waiting for the bot to join a server re-read on their own and offer no **Try again**, because the read they'd take is the one the panel already takes.

While Curia can't reach the service at all, **Setup** says so instead of showing four unconnected cards, and offers **Try again**.

## What you see while Curia works

Every action on a card, **Confirm operator and verify**, **Connect bot**, **Connect channel**, **Sign in**, **Submit** for a code, **Watch these repositories and continue**, and **Try again**, switches the card and its panel to an in-progress state the moment you select it. The card's badge reads **Working**, its footer names what Curia is doing (`Verifying the operator`, `Registering commands and posting the confirmation`, `Completing one minimal model request and applying the routing preset`), and the panel shows the same sentence over a thin moving line. Nothing that stood before stays: not the sign-in steps and not a previous failure. The state lasts until the next read for that card lands. A read that fails shows the failure and its action. A read that connects shows the connected state. A write the service refuses shows the refusal beside the form.

## Moving through setup

- Every write on a card verifies the card on its own. There is no separate check to press: after **Connect bot**, **Connect channel**, **Confirm operator and verify**, or **Watch these repositories and continue**, the panel shows the result of that verification.
- A connected panel has one press, **Continue**. It opens the next card that isn't connected, in rail order. When every card is connected, **Continue** opens the Test run panel. A connected card you reopen shows its facts and the same **Continue**.
- When GitHub, Discord, Tailscale, and at least one AI login are connected on the current read, the action under the rail becomes **Start Test run**. Nothing else turns it: not the count on the rail, and not a saved result.
- There is no close button. To leave Setup, select **Home** or any other screen; a running Test run keeps going.

## The Test run

The Test run is the one dependent step. Under the rail, the **Test run** card names what it's waiting for or, when setup is ready, what the run runs on. A Test run runs one Full loop, the eight-leg cycle, on each of two tickets it creates for itself.

### When setup is ready

Setup is ready when all of the following hold on the current read:

- The GitHub card is connected and names a covered watched repository.
- The Discord card is connected and names the server and the command channel.
- The Tailscale card is connected and names the private address the app answers on.
- At least one AI login is connected and its routing preset is ready.

Curia computes readiness from those verifications every time the service is asked: when you open **Setup**, when you select **Try again**, and after a service restart or a reconnection. Curia keeps no "ready" marker and no workflow state, so there is nothing to resume and nothing to reset. A card that verified on the last read and fails on this one, for example because the GitHub App was uninstalled or a model credential expired, closes the gate on this read. The card names the failure and the one action. Fix it, select **Try again**, and the next read that passes opens the gate again. A connected card that hands no fact the loop needs is named the same way, for example `GitHub verified without a covered repository. Select Try again.`

### One login is enough

OpenAI and Anthropic are both supported. One verified login is sufficient, and the second stays optional. When both are connected, the AI logins card says **Two providers verified**, and the leading provider is the one you last signed in from this card, when it verified, or the first connected provider in card order. A second login that fails verification is shown as failed on its row and blocks nothing while the other is connected.

### What the panel shows

When setup is ready, the panel says `Every integration is connected and verified.` and names the facts the run runs on: the covered repository, the command channel, the private address, and the leading provider with the model its preset routes to. Those facts come from the current read's verifications and from nothing stored. The service hands the same facts to the Test run: the repository, the server, the channel, the confirmation message, and whether the Discord bridge runs, the address and the admitted operator, and the provider with its routing rows. None of them is a secret.

### Start Test run

**Start Test run** enables only when setup is ready. Selecting it runs the Test run, and that run is the installation's acceptance: setup succeeds when every leg completes in one pass on both tickets and the map is closed, and not before. There is no separate evidence report. The completion state links the GitHub and Discord artifacts the run produced and reports the elapsed time.

#### The map and the tickets the run makes

You don't prepare a ticket. When you select **Start Test run**, Curia creates a wayfinder map in the covered repository, **Test run &lt;date&gt;**, with two child tickets:

1. **Add a line to the README.** Append one line to the bottom of `README.md`, creating the file if the repository has none. The line names the Test run and the date.
2. **Remove the Test run line from the README.** Blocked by ticket 1 through GitHub's native issue dependency. Remove the line again, and delete the file when ticket 1 created it.

Both tickets carry the `rehearsal` label, and each asks the agent to confirm the line's wording with you, so the escalation leg has a real question and a real answer. The writes are real GitHub issues under the App's token, and Curia journals each one as it lands, so **Try again** after a failed creation creates only what is missing on the same map. A second Test run creates a new map. The repository is left as it was: the line is added and removed, both pull requests are merged, and the map and its tickets are closed.

#### What the run covers

The run walks the eight legs of the Full loop on ticket 1, then the same eight on ticket 2, then one last leg for the map. Each leg is observed through the record Curia already keeps while an agent works, never through a marker the run writes for itself. The following table lists the legs and what completes each one.

| Leg | What completes it |
|---|---|
| Frontier discovery | The dispatcher's own frontier read of the repository lists the ticket as takeable. Ticket 2 is takeable once ticket 1 is closed. |
| Dispatch | The dispatcher claims the ticket and spawns the agent session (`agent_spawned`). |
| Escalation and answer | The agent asks a question through Discord and your answer reaches it. The review gate doesn't count as this leg. |
| Pull request | The agent's `open_pull_request` opens or updates the pull request. |
| Review | You approve the review gate in the ticket's thread. A rejection sends the agent back and completes nothing. |
| Merge | The resolution receipt finds the pull request merged. |
| Ticket resolution | The receipt finds the resolution comment and the closed ticket. |
| Map update | The receipt finds the pointer line on the Test run map's **Decisions so far**. |
| Map closed | Curia asked what to do with the empty map, you answered **Clear fog and close**, and Curia closed it. |

Selecting **Start Test run** or **Try again** makes the run the selected panel, in the main area where a card's panel renders, and scrolls it into view. The panel first says `Starting the Test run` (or `Retrying <leg>`), then, from the service's answer on, the map, the ticket in flight (`ticket 1 of 2`, then `ticket 2 of 2`), one row per leg with its state as a word, the elapsed time, and the links as they appear. The rail's **Test run** card shows the run's state and brings the panel back after you select a card. The page follows the service's read every 5 seconds. Everything but your answers is the agents' and the daemon's.

#### Your part: the questions, the review gates, and the map

The running leg says what it waits for, so a wait is never mistaken for a hang: `waiting for the agent's question`, `waiting for your answer · open 3m ago`, `waiting for your approval of the review gate · open 12m ago`, `waiting for Curia's question about the empty map`, or `waiting for your verdict on the map · open 1m ago`. The time is since the question opened.

Whenever the run reaches a step that waits for you, the panel shows the message Curia posted in Discord, drawn the way Discord draws it: the bot's name and avatar, then the embed with its title, its description, its fields, and its footer. It is the same message, built from the same text the bridge sent, so what you read on the panel is what your phone shows. Under it are this page's answer controls: the question with an answer field or its option buttons, the review gate with **Approve · merge**, **Cross-check**, and **Reject** with a field for your words, or the map question with **Clear fog and close** and **Keep map open**. The answer goes through the service's own answer route, the one the Discord bridge uses, so the ticket's thread in Discord keeps working in parallel and whichever surface answers first wins. The journal records one answer either way.

#### Follow the sessions

While the run lives, the panel lists a terminal per live session under **Terminals**: the agent's session (`curia-<ticket>`) while it runs, and the overseer's session while it is in a turn. Each opens the app's own `/terminal/` page for that session in a new tab, behind the same Tailscale identity check as the page.

#### Leaving Setup during a run

Leaving Setup never cancels or detaches the run. The service drives the run and judges it from its journal, and the page only reads it. Home shows the running acceptance with its current leg and what it waits for, and **Open** returns to the run panel. Reopening Setup any other way lands on the run panel while the run lives. The panel says so: `Leaving Setup keeps the run going`. There is no close button; select any other screen.

#### When the run completes

The panel says **Test run verified** and names the repository, the last ticket, and the total elapsed time from the press to the map's close. It links the ticket, the pull request, the map, the Discord thread, and the command channel. Select **Open Curia** to leave setup. The run's start and completion are also on the Feed as journal events, which is the only record Curia keeps of it. `curia doctor` keeps reporting the gate, not the run: a completed run is not a readiness marker, and the next `Setup` read verifies the four cards fresh, as always.

#### When a leg fails

A run fails when a write to GitHub fails while the map is made, when the ticket isn't on the frontier, when the dispatcher refuses the dispatch, when the agent ends with a leg outstanding, or when the map is kept open. The panel names the failed leg, one cause, and one corrective action, and offers **Try again**. The completed legs, the map, the tickets, and every connected integration stay as they are.

- **Frontier discovery** fails when Curia couldn't create the map or a ticket, when the frontier can't be read, or when the ticket isn't listed as takeable. Check the GitHub card and the repository, then select **Try again**. The retry creates what is missing on the same map and reads the frontier again.
- **Dispatch** fails when the dispatcher refuses the ticket, for example over a clone an earlier agent left on disk, or a missing model credential. The cause is the dispatcher's own sentence. Fix what it names, then select **Try again**. The retry dispatches the same ticket again.
- **Every later ticket leg** fails when the agent ends before that leg: it exited, died, or was cancelled. Read the ticket's thread in the command channel, fix what stopped the agent, then select **Try again**. The retry dispatches the same ticket again, and only the new dispatch's legs count.
- **Map closed** fails when you answer **Keep map open**. Close the map on GitHub, then select **Try again**. The retry reads the map again.

A rejected review is not a failure. The agent takes your feedback, commits again, and asks for review again on the same pull request.

## What a reopen restores

Closing and reopening **Setup** restores the card you were on and any safe progress a step kept. Curia keeps that in `state/setup.json` in the installation root, written by the service, mode `0600`. The file holds:

- `step`: the selected card, one of `github`, `discord`, `tailscale`, `model`.
- `progress`: per card, only these fields: `app_name` for GitHub (the name you gave the App), `guild_id` and `channel` for Discord, `machine_name` for Tailscale, `provider` for the model card.

The file never holds a token, a key, or a completion marker. A field outside that list is refused by name. Nothing about setup is stored in the browser. A `state/setup.json` file that can't be read starts setup on the GitHub card with no progress, and the service log says so.

Credentials a step collects go to their secret files under `secrets/`, as [Secrets, mounts, and what survives](secrets.md) describes. The Discord facts that aren't secret go to `state/discord.json`, the recorded Tailscale operator and Curia's Serve routes go to `state/tailscale.json`, and the routing preset a model provider applies goes to `state/routing.local.yaml`.

## Where the frame lives

The Curia app serves the frame at `#setup`. The app reads the record and the four verifications from the service with `GET /setup` through its sidecar, and writes the selected card and safe progress with `POST /setup`. The service refuses a write that names a card or a field outside the lists in the preceding section, and it never prints a secret in the answer.
