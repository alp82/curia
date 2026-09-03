# ADR-0031: The operator authorizes Curia when the App is installed

**Status**: accepted (2026-09). Built. Supersedes the host-login part of [ADR-0018](0018-the-daemon-is-a-github-app.md) for packaged installations. The source deployment keeps its host login.
**Provenance**: [Rehearse the packaged Curia lifecycle (#891)](https://github.com/alp82/curia/issues/891), on [map #863](https://github.com/alp82/curia/issues/863).

## Context

[ADR-0018](0018-the-daemon-is-a-github-app.md) made the review gate's approval a real GitHub approval and kept one job for the host `gh` login: posting it. An App can't approve for a human, and an App-minted approval on an App-authored pull request is the self-approval GitHub refuses. The approval is the operator's judgment, so it needs the operator's identity.

The packaged installation has no host login. The daemon runs in a container with no `~/.config/gh`, and the operator never runs `gh auth login` on the box. The #891 rehearsal reached the review gate of the Test run, the operator approved, and `gh pr review --approve` ran with no credential: `GitHub refused the daemon login`, `gh pr review failed because GitHub CLI has no credentials`. The run stalled on a review nobody could post.

Two facts constrain the replacement:

- The approval must carry the operator's own account. Nothing minted from the App key can stand in for it.
- The operator performs every sign-in and consent on the provider's own site, and Curia collects no password and nothing from a consent page ([#852](https://github.com/alp82/curia/issues/852)). A hand-run `gh auth login` on the box is out.

## Decision

- **Installing the App is the authorization.** The manifest sets `request_oauth_on_install: true` and `setup_on_update: true`, and names the callback in `callback_urls`. When the operator installs the App, GitHub runs its user authorization for the App on the same trip and sends a one-use code to the callback. Every later change to the installation repeats it. The operator signs in nowhere by hand, and the docs carry no `gh auth login` step.

- **The code becomes a user token, exchanged with the App's client id and secret.** Both come back from the manifest conversion, and the daemon stores them beside the private key in `secrets/github-app.json`. The daemon exchanges the code at GitHub's token endpoint, asks `GET /user` who the token stands for, and writes the token, its refresh token, their expiry, and the login to `secrets/github-operator.json`, owner-only, mode `0600`, through `writeSecret`. The token never enters the environment, a log line, or a browser answer. An App converted before this decision has no client secret, and the card says to create the App again.

- **The daemon refreshes the token before it expires.** A user token of an App that expires them lives eight hours and its refresh token six months. `token()` refreshes inside a ten-minute margin before it hands a value out, once for concurrent callers, and rewrites the file. A token GitHub does not expire is kept as it is. The daemon handles both, because GitHub's manifest has no field for the expiry setting.

- **The approval runs as the operator.** `approvePullRequest` asks `gh` with `{ operator: true }`, and `daemongh.mjs` puts the operator token into that one child as `GH_TOKEN`, the way it routes minted tokens. No host login is consulted under a root. The source deployment wires no operator source, and the same call inherits the host login as before.

- **The card proves the authorization.** Once an installation exists, the GitHub card's verification asks the token who it stands for on `GET /user` and reports the login as a fact: `Approvals post as <login>`. A missing token, a refresh GitHub refuses, and a token GitHub no longer accepts are one failed verification at the install step, and the action is to reinstall the App from the panel's link, which repeats the authorization.

- **A root with no authorization refuses the approval, loudly.** There is no host login behind the refusal, so the gate reads it as the approval it could not post, the agent is told not to merge and not to resolve, and the thread names the reinstall. Nothing falls back silently.

- **The default App name is `curia.sh`, and a taken name is read from GitHub first.** App names are unique across GitHub, and GitHub's consent page says so only after the operator has left Curia. The daemon asks `GET /apps/<slug>` before the handoff, refuses the start with GitHub's own fact when the name exists, and the card prefills `curia.sh-<node name>` with one sentence saying why.

## Consequences

- **The host login retreats whole from the packaged daemon.** Its three jobs on the source box stand: dev sessions, the deploy sibling, and the gate approval. The packaged daemon has none of the three.
- **Curia owns five long-lived credentials**, and `secrets/github-operator.json` is the fifth. `curia doctor` reports its presence with the others, and `secrets/github-app.json` carries two more fields.
- **The callback is a redirect anything can send.** GitHub adds no state to an install-triggered authorization. The route sits behind the same Tailscale identity gate as the rest of the app, only the operator or the first identity before one is confirmed can reach it, and a code GitHub refuses stores nothing.
- **The operator token is a second credential to refresh**, on the daemon's own duty, beside the installation tokens. Its expiry is not a calendar item: a dead refresh token is one reinstall away.
- **The attribution stays honest.** Pull requests are the bot's, approvals are the operator's, and the two are different accounts, which is what makes branch protection usable.
- **[ADR-0018](0018-the-daemon-is-a-github-app.md) stands otherwise.** One App, one key, minted tokens for every runtime holder, and the claim assigns a real user.
