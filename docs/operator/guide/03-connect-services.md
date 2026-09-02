# 3. Connect services

Operator guide · [Index](../README.md)

- **Get Curia running:** [1. Check prerequisites](01-check-prerequisites.md) · [2. Install Curia](02-install-curia.md) · **3. Connect services (this topic)** · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** GitHub, Discord, Tailscale, and one model provider connected and verified on the Setup screen, and **Run Full loop** enabled.

**Starting state:** Curia installed and healthy from [2. Install Curia](02-install-curia.md). A browser on a device that is on your tailnet. The four accounts from [1. Check prerequisites](01-check-prerequisites.md).

**Active operator time:** About 15 minutes across the four cards. The GitHub App creation and the model provider's sign-in are the longest.

## What setup changes

Each card writes one credential to an owner-only file under `secrets/` in the installation root and its non-secret facts under `state/`. Nothing goes to the browser's storage, and no card keeps a token in the page. A card's connected state is a fresh verification on every read, never a saved marker, so a card that loses its authority later shows as failed with the reason. What each file holds is in [Secrets, mounts, and what survives](../secrets.md#the-secret-files).

## Open the Setup screen

From a device on your tailnet, open the address `curia install` printed, `https://<your node's MagicDNS name>:8445/`. Open it through Tailscale: a request on the host's loopback carries no identity and can't confirm an operator. On a fresh installation the app admits the first tailnet identity that arrives, and only to **Setup**. Select **Setup** if the app doesn't open on it.

The rail on the left holds four cards, **GitHub**, **Discord**, **Tailscale**, and **Model provider**. Connect them in any order. After a card connects, **Continue setup** opens the next card that isn't connected. The frame, the card states, and what a reopen restores are in [Integration setup](../integration-setup.md).

## Connect GitHub

1. On the **GitHub** card, keep the suggested App name or enter your own, then select **Create GitHub App**. The browser opens GitHub's own page with the App's manifest.
2. On GitHub, select **Create GitHub App for &lt;you&gt;**. GitHub sends the browser back to the Setup screen, and the service converts the code into the App's key.
3. The card lists every watched owner with an **Install on &lt;owner&gt;** link. Install the App for each one and grant it the watched repositories, then select **Try again**.

The card connects when it shows **Connected and verified** and the footer names a real ticket that carries `ready-for-agent` and no assignee, or the covered repository with its open-ticket count. What the verification proves is in [Connect GitHub](../integration-setup.md#connect-github).

## Connect Discord

1. In the [Discord developer portal](https://discord.com/developers/applications), select **New Application** and name it. Under **Bot**, turn on **Message Content Intent**, select **Reset Token**, and copy the token. Discord shows it once.
2. In Discord, turn on **Developer Mode** under **Settings** > **Advanced**, then copy your user ID from your profile menu.
3. On the **Discord** card, paste the token, enter your user ID, and select **Connect bot**.
4. Select **Add the bot to a server** and approve it in Discord. The panel waits and checks again on the page's refresh interval, so the server appears on its own within seconds. Until then there is no server to select and no channel field.
5. Select the server, keep the channel name `curia` or enter another, and select **Connect channel**.

The card connects when the footer shows the channel and the server, then `Confirmation delivered · <n> commands registered`, and Curia's confirmation message stands in the channel. The panel says whether the bridge is running. Until the service restarts once after the first connection, the card is verified and the bot doesn't answer yet: select **Restart Curia** in the panel. The details are in [Connect Discord](../integration-setup.md#connect-discord).

## Connect Tailscale

1. On the **Tailscale** card, read the identity the panel names, `You opened Curia as <login> through Tailscale`. It's the login Tailscale stamped on your request. The panel also names the node and its address, the name `curia install` joined the tailnet under. There is nothing to type: Curia never renames the node. To rename it, run `sudo tailscale set --hostname <name>` on the host.
2. Select **Confirm operator and verify**.

From that moment the recorded login is the only identity the app and every published surface admit. The card connects when the footer shows the node's MagicDNS name, then `<login> · admitted in <n> ms`. The details are in [Connect Tailscale](../integration-setup.md#connect-tailscale).

## Connect a model provider

The **Model provider** card holds one row per provider. One verified provider is enough. Add the second later from the same card.

- **OpenAI.** Select **Sign in to OpenAI**. The row shows a link and a one-time code. Open the link on any device, sign in to your ChatGPT account, and enter the code. The code lives fifteen minutes. See [Connect OpenAI](../integration-setup.md#connect-openai).
- **Anthropic.** Select **Sign in to Anthropic**. The row shows a link. Open it, sign in to your Claude subscription, approve, and copy the code the browser shows. Select **Open the terminal instead** on the row and paste the code into that terminal, because the sign-in refuses every write the service could make. See [Connect Anthropic](../integration-setup.md#connect-anthropic).

The first press on a fresh installation can take a minute, because the service prepares the agent image first. The card connects when the footer shows the provider, then `Routing ready · verification request completed in <n> s`. The verified provider applies a routing preset so every ticket type routes to a model that can run.

## What you should see

The rail reads `4/4 verified` (or `3/4` with one provider row unconnected, which is fine), the action under the rail reads **Run Full loop**, and the **Full loop** panel says `Every integration is connected and verified.` and names the ticket or repository, the command channel, the private address, and the leading provider.

To see the same facts on one terminal screen, run `curia doctor`; its `integrations` section carries every card's own result.

## If a card fails

A failed card reads **Action required**, names the check that failed, and gives one corrective action, for example `curia's GitHub App is not installed on alp82` with the install link. Do what the action says, then select **Try again**, which runs every card's verification again. There is no background retry. The failed checks and their actions, card by card, are under [Connect services](troubleshooting.md#connect-services) in Troubleshooting.

## Next

[4. Run your first Full loop](04-run-your-first-full-loop.md).
