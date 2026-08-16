# The curia GitHub App: the operator checklist

Curia authenticates to GitHub as one GitHub App. [ADR-0018](adr/0018-the-daemon-is-a-github-app.md) says why. This file is what the operator does by hand, once.

Nothing on this page can be done by an agent. An app is created under a human account, and its private key is downloaded exactly once.

## Before you start

The daemon runs fine with no app. Every PAT keeps working until its holder cuts over, so you can stop after any step here and nothing breaks.

## What this box registered

Run on 2026-08-16, as [#352](https://github.com/alp82/curia/issues/352). The cutover tickets read these facts from here.

| Fact | Value |
| --- | --- |
| App name | `curia.sh` |
| Settings page | <https://github.com/settings/apps/curia-sh> |
| App ID | `4610603` |
| Bot login | `curia-sh[bot]` |
| Installed on | `alp82` and `getalfredo` |

None of this is secret. The app id travels in every JWT the daemon signs. The private key is the secret, and it is never in this repo.

## 1. Create the app

1. Open <https://github.com/settings/apps/new>.
2. Set **GitHub App name**. GitHub slugifies it, and the bot posts as `<slug>[bot]`, so the name is read as the author of every commit, pull request and gate approval. Nothing in the daemon reads it. The name must be free across the whole of GitHub, and `curia` is taken.
3. Set **Homepage URL** to `https://github.com/alp82/curia`.
4. Clear the **Webhook** → **Active** checkbox. Curia polls. It listens for no webhook.
5. Set **Where can this GitHub App be installed?** to **Any account**.
6. Press **Create GitHub App**.

**Any account, and not "Only on this account".** The app is owned by the user `alp82`, and `getalfredo` is an organization. An organization is a different account, so "Only on this account" leaves it off the **Install App** page and there is no way to install there. "Any account" is what makes one app cover both owners, which is what [#338](https://github.com/alp82/curia/issues/338) decided. The app is not listed on the Marketplace, so it is reachable only through its own install URL, and a stranger who installed it would grant it their repos and reach none of curia's. The setting is on the **General** page and can be changed after the app exists.

## 2. Grant the permissions

On the app's **Permissions & events** page, under **Repository permissions**, set these five and nothing else.

| Permission | Level | Who needs it |
| --- | --- | --- |
| Contents | Read and write | agents push branches, the overseer reads files |
| Issues | Read and write | claims, resolution comments, map updates |
| Pull requests | Read and write | pull-request creation, the gate approval, the merge |
| Commit statuses | Read-only | the overseer reads check results |
| Metadata | Read-only | mandatory, and GitHub sets it for you |

Leave **Workflows** at **No access**. ADR-0018 says why: an app that can write `.github/workflows/` lets any agent rewrite CI, and today's PATs cannot do it either.

Set no **Organization permissions** and no **Account permissions**. Subscribe to no events.

Press **Save changes**.

## 3. Generate the private key

1. On the app's **General** page, scroll to **Private keys** and press **Generate a private key**.
2. The browser downloads one `.pem` file. **GitHub never shows it again.** Keep it until step 6 puts it on the box.
3. Note the **App ID** from the same page. It is digits. It is not the app slug and not the client id.

## 4. Install it on both owners

Do this twice, once per resource owner.

1. Open the app's **Install App** page.
2. Press **Install** beside `alp82`.
3. Choose **Only select repositories** and pick every repo on the watch list for that owner: `alp82/curia`, `alp82/alperortac.com`, `alp82/aistack`.
4. Press **Install**.
5. Repeat for `getalfredo`, picking `getalfredo/landing-page`.

The watch list lives in `config/curia.yaml`. A repo added there later must be added to its installation too, or every dispatch on it fails to authenticate.

## 5. Report the facts back

Three facts resolve [#352](https://github.com/alp82/curia/issues/352) and the cutover tickets read them:

- the **App ID**,
- the **bot login** GitHub gave the app: the slug in the settings URL, plus `[bot]`,
- that **both installations** exist.

## 6. Put the key on the box (dev session)

The key never travels through an agent. This step happens in a dev session on the box.

1. Copy the downloaded `.pem` to `daemon/.curia-app.pem`.
2. `chmod 600 daemon/.curia-app.pem`, owned by the box user the daemon runs as.
3. Add two lines to `daemon/.env.daemon`:

   ```
   CURIA_GH_APP_ID=<the digits from step 3>
   CURIA_GH_APP_KEY_FILE=.curia-app.pem
   ```

4. Restart the daemon. Its boot log then states one line per installation it can see. An app it cannot read refuses the boot naming the file, rather than failing a dispatch hours later.

`.curia-app.pem` is git-ignored. Never commit it.

## What is NOT on this list yet

**Branch protection stays off.** One required review on the watched repos is the gate cutover's own act, and it turns on in the same change that starts posting the approval. Turned on now it blocks every curia pull request behind an approval nobody posts.

**The agents have cut over.** [#389](https://github.com/alp82/curia/issues/389) moved them: an agent gets a per-agent `gh` config dir the daemon rewrites, and it commits, pushes and merges as `curia-sh[bot]`. `CURIA_AGENT_GH_TOKEN_*` stays as the fallback for an owner the app is not installed on, and retires once the box has run a dispatch on the minted path. See [the live check](live-checks/389-agent-minted-token.md).

**The overseer has cut over.** [#392](https://github.com/alp82/curia/issues/392) moved it: the daemon mints one read-only token per watched owner and writes it to `<workspace_root>/overseer/tokens/<owner>`, which the container mounts read-only. `CURIA_OVERSEER_GH_TOKEN_*` is retired — delete any key left in `daemon/.env.overseer`, and revoke the PAT. An owner the app is not installed on now reads public repositories only, and the overseer names it in the chat once per turn. See [the live check](live-checks/392-overseer-minted-token.md).

**One PAT stays.** The daemon's own host `gh` login keeps working until it cuts over on its own ticket.

## If something is wrong

- **The boot says the JWT was refused (401).** The app id and the key file belong to different apps, or the box clock is wrong.
- **The Install App page does not list `getalfredo`.** The app is set to **Only on this account**. An organization is a different account. Set **Where can this GitHub App be installed?** to **Any account** on the **General** page, then reload the Install App page.
- **The boot lists no installation for a watched owner.** Step 4 was not run for that owner.
- **A mint answers 422.** The app grants less than curia asked for. Fix the level on the app's **Permissions & events** page, then accept the new grant on EACH installation — GitHub holds a widened permission until the installation approves it.
- **The key is lost.** Generate a second one on the **General** page and delete the old one. The app id does not change, and no installation has to be redone.
