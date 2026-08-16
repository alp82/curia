# ADR-0018: The daemon is a GitHub App

**Status**: accepted (2026-08). Partly built. The minting core ships with this ADR. Each holder cuts over on its own ticket.
**Provenance**: [A GitHub App replaces the PAT (#338)](https://github.com/alp82/curia/issues/338), [The daemon becomes a GitHub App: one key, minted tokens (#352)](https://github.com/alp82/curia/issues/352)

## Context

Curia reaches GitHub four ways, and every one of them is a secret the operator makes by hand.

- **Agents** carry a read-write fine-grained PAT, one per resource owner, as `GH_TOKEN` in the container environment ([#155](https://github.com/alp82/curia/issues/155)).
- **The overseer** carries a read-only fine-grained PAT, one per resource owner, in a second env file ([#313](https://github.com/alp82/curia/issues/313)). That file is the boundary, because compose hands a container an env file whole.
- **The daemon** uses the operator's own `gh` login for frontier reads, claims, pull-request creation and branch pushes.
- **A dev session** uses the same host login again.

Five costs come out of that shape.

1. **The minting cost.** A fine-grained PAT has one resource-owner dropdown, so the count is holders times owners. Two holders and two owners is four tokens, made by hand and made again on expiry.
2. **The expiry is a calendar item.** An organization can cap fine-grained PAT lifetime, and `getalfredo` caps it at 366 days. An expired token does not degrade. It answers every call with a 401.
3. **The second env file is a boundary made of files.** `.env.overseer` exists because a container reads its env file whole, and `.env.daemon` carries the read-write tokens. The operator objected to the pair, and no narrower shape was available.
4. **The gate is not a gate on GitHub.** An agent's pull request is authored by the operator's own token today. GitHub refuses a self-approval, so branch protection with one required review would block every curia pull request behind an approval nobody can post.
5. **Attribution lies.** A push the daemon performs for an agent reads as the operator.

## Decision

- **One GitHub App replaces every PAT.** The operator creates one app under their own account and installs it on each watched owner (`alp82` and `getalfredo`). The app is per-operator. It is never a central shared app, and stranger distribution stays out of scope.

- **The private key is curia's one durable secret.** It sits at `daemon/.curia-app.pem`, mode 0600, uncommitted, named by `CURIA_GH_APP_KEY_FILE` beside `CURIA_GH_APP_ID` in `daemon/.env.daemon`. The key is a FILE and never a value in the env file: a PEM carries newlines, docker reads a newline in an env file as a second variable, and a path keeps the key out of every child process environment the daemon spawns.

- **The daemon mints, and nothing else does.** `daemon/src/githubapp.mjs` signs the app JWT with `node:crypto`, reads the installation list, and mints installation tokens. No container asks a daemon endpoint for a token: a shell that can mint is the capability [ADR-0014](0014-the-overseer-in-its-own-container.md) removed.

- **One key, two permission sets.** A minted installation token may scope DOWN from what the installation grants, so agents get `contents:write, issues:write, pull_requests:write, metadata:read` and the overseer gets [#313](https://github.com/alp82/curia/issues/313)'s read set unchanged: `contents, issues, pull_requests, statuses, metadata`, all read. ADR-0014's boundary now holds with no second secret.

- **Neither set carries `workflows`.** GitHub gates `.github/workflows/` behind its own permission, and an app that holds it lets any agent rewrite CI. That is a path from a ticket's text to whatever secret the next workflow run holds. The PATs of [#155](https://github.com/alp82/curia/issues/155) do not carry it either, so the reach stays exactly what it is today. The cost is stated rather than hidden: an agent cannot push a change under `.github/workflows/`.

- **A holder reads a file the daemon rewrites.** An installation token lives one hour, and a ticket outlives it. So no holder is handed a value at spawn. The daemon refreshes a per-holder file, and the existing credential-helper path reads it. `GH_TOKEN` leaves the container environment.

- **The claim assigns the operator, not the bot.** A claim is an issue assignee, and GitHub does not let an App be one. `gh api user` also answers nothing under an installation token, which is where `viewerLogin()` reads the name today. So the daemon calls as `curia-sh[bot]` and assigns a login it reads from `dispatch.claim_login` in `config/curia.yaml`.

- **The gate approval is the operator's own.** On the ✅ press the daemon submits a real GitHub approval with the host `gh` login. An app cannot approve for a human, and an app-minted approval on an app-authored pull request is a self-approval again. So the host login does not retreat whole. It keeps exactly one job on the daemon, beside dev sessions and the deploy sibling.

- **The agent keeps `gh pr merge`.** The merge is the one write to the remote an agent owns, in the standing orders, in the Stop hook and in [ADR-0008](0008-resolved-means-merged.md). Branch protection is satisfied by the operator's approval, so the bot's merge goes through and nothing about the ending changes.

- **Branch protection turns on with the gate cutover, and not before.** One required review on the watched repos, turned on in the same act that starts posting the approval. Turned on earlier it blocks every curia pull request behind an approval nobody posts.

- **No PAT comes out ahead of its replacement.** The minting core ships first and swaps no holder. Each holder cuts over on its own ticket, provable live on the box, and its PAT retires only after that.

## Consequences

- **The hour is the price.** A PAT was set once and stayed good for a year. An installation token dies inside a long ticket, so every holder gains a refresh path, and the daemon gains a duty it did not have.
- **The private key never expires**, so nothing here is a calendar item any more. The 366-day cap stops mattering.
- **Attribution becomes honest.** A push the daemon performs for an agent reads as `curia-sh[bot]`.
- **The gate becomes a real GitHub approval**, which is what makes branch protection usable at all.
- **`.env.overseer` retires as a token file** when the overseer cuts over. What is left in it is the model credential, which is the one host secret ADR-0014 lets into that container.
- **One-click setup from the dashboard** rides GitHub's app manifest flow. It stays fog on [#244](https://github.com/alp82/curia/issues/244) until the app is real.
- **[ADR-0007](0007-shared-credential-store.md) is untouched.** That one shares the MODEL credential, and nothing here reads it.
