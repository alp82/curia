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

## 7. Turn on branch protection (optional, dev session)

**This step is yours to skip.** Curia requires no setting in a watched repo, and nothing in the daemon reads this rule. A repo without it keeps everything else, including the approval itself.

What it buys is enforcement. Since [#391](https://github.com/alp82/curia/issues/391) the ✅ press posts a real GitHub approval on the pull request, under your own `gh` login. An agent holds a write token and runs `gh pr merge` itself, so without protection its standing orders are the only thing that stops it merging code you did not approve. One required review on `main` makes GitHub refuse that merge. The app is not an administrator, so it cannot bypass the rule.

Run it only on a daemon that carries the #391 code. Turned on earlier it blocks every curia pull request behind an approval nobody posts.

**This box protects NOTHING**, decided on [#479](https://github.com/alp82/curia/issues/479). The operator ruled the rule out on every watched repo, `alp82/curia` included. So the standing orders are the only guard on all four, and GitHub refuses no merge of curia's. [The live check](live-checks/391-gate-approval.md) section 4 carries the reading. The command above stays here, and any repo takes it whenever you want it.

Run this once per protected repo, with your own `gh` login:

```
gh api -X PUT repos/alp82/curia/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Four of those keys carry the decision.

| Key | Value | Why |
| --- | --- | --- |
| `required_approving_review_count` | `1` | Your press, and nothing else, lets a pull request merge. |
| `enforce_admins` | `false` | You keep pushing to `main` yourself. Dev sessions commit straight to `main`, and the deploy sibling pushes as you. The app is not an administrator, so agents stay behind the gate. |
| `dismiss_stale_reviews` | `false` | A commit pushed after the approval keeps it. The gate already refuses to replay an answer over a changed diff ([#369](https://github.com/alp82/curia/issues/369)). |
| `allow_force_pushes`, `allow_deletions` | `false` | `main` cannot be rewritten or removed by anyone. |

Read it back with `gh api repos/alp82/curia/branches/main/protection --jq .required_pull_request_reviews.required_approving_review_count`. It answers `1`.

Take it off again with `gh api -X DELETE repos/alp82/curia/branches/main/protection`. Nothing in curia depends on the rule being there. The approval is posted either way.

An agent never runs this. The minted token holds no **Administration** permission, so branch protection is yours alone.

## What is NOT on this list yet

**The agents have cut over.** [#389](https://github.com/alp82/curia/issues/389) moved them: an agent gets a per-agent `gh` config dir the daemon rewrites, and it commits, pushes and merges as `curia-sh[bot]`. `CURIA_AGENT_GH_TOKEN_*` is retired ([#466](https://github.com/alp82/curia/issues/466)). Delete any key left in `daemon/.env.daemon`, and revoke the PAT. **A dispatch now needs this app**: a mint that fails refuses the dispatch and releases the ticket, because an agent with no GitHub credential cannot read its own ticket. So install it on every owner you watch, and grant it every watched repo. See [the live check](live-checks/389-agent-minted-token.md).

**The daemon has cut over.** [#390](https://github.com/alp82/curia/issues/390) moved it: every `gh` child the daemon spawns for a named repo carries that owner's minted write token, so the frontier reads, the claims, the clones, the pull requests and the branch pushes run as `curia-sh[bot]`. Two things came with it. `config/curia.yaml` gains a required `dispatch.claim_login`, because GitHub does not let an App be an issue assignee. And the host `gh` login keeps exactly three jobs: dev sessions, the deploy sibling, and the gate approval.

**The overseer has cut over.** [#392](https://github.com/alp82/curia/issues/392) moved it: the daemon mints one read-only token per watched owner and writes it to `<workspace_root>/overseer/tokens/<owner>`, which the container mounts read-only. `CURIA_OVERSEER_GH_TOKEN_*` is retired — delete any key left in `daemon/.env.overseer`, and revoke the PAT. An owner the app is not installed on now reads public repositories only, and the overseer names it in the chat once per turn. See [the live check](live-checks/392-overseer-minted-token.md).

**The gate is a real approval.** [#391](https://github.com/alp82/curia/issues/391) made the ✅ press post `gh pr review --approve` on the agent's pull request, under the host login and never under a minted token. GitHub refuses a self-approval, so the approval is the operator's own or it is nothing. A press whose approval call fails does not read as approved anywhere: the agent is told not to merge and not to resolve, the thread carries the reason, and the journal keeps the press beside the failure. Branch protection is step 7 above.

**Every holder is on the app, and every PAT is retired.** What is left of the host `gh` login is the three jobs above. No `CURIA_*_GH_TOKEN_*` key is read by anything, and boot names each one it finds so the operator can delete the line and revoke the token.

## If something is wrong

- **The boot says the JWT was refused (401).** The app id and the key file belong to different apps, or the box clock is wrong.
- **The Install App page does not list `getalfredo`.** The app is set to **Only on this account**. An organization is a different account. Set **Where can this GitHub App be installed?** to **Any account** on the **General** page, then reload the Install App page.
- **The boot lists no installation for a watched owner.** Step 4 was not run for that owner. Every dispatch to it is refused until it is.
- **`#curia` says curia cannot reach a watched repo.** The installation covers the owner but not that repo. Open the installation's **Repository access** and grant it, or set **All repositories**. The watch re-reads every six hours and says when it comes good.
- **A mint answers 422.** The app grants less than curia asked for. Fix the level on the app's **Permissions & events** page, then accept the new grant on EACH installation — GitHub holds a widened permission until the installation approves it.
- **The key is lost.** Generate a second one on the **General** page and delete the old one. The app id does not change, and no installation has to be redone.
- **A ticket thread says GitHub refused the approval as a self-approval.** The app is not installed on that owner, so the daemon fell back to the host login and opened the pull request as you. Run step 4 for that owner. Nothing else broke: the press stood, and the thread holds the record of it.
- **A ✅ press says curia could not post the approval.** The agent was told not to merge and not to resolve, so nothing is lost. Read the reason in the thread, fix it on GitHub, and press again at the gate the agent opens next.
