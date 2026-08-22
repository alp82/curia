# GitHub App manifest flow for curia

Date: 2026-08-22. Ticket: [One-click app setup from the dashboard](https://github.com/alp82/curia/issues/608).

The manifest flow can create curia's GitHub App from the tailnet dashboard. It does not require a public redirect URL.

The flow does not install the app on an account or repository. The operator must still grant each installation its repositories.

## The flow

The flow must finish within one hour. It uses an unguessable `state` value to prevent cross-site request forgery.

1. Post a JSON-encoded `manifest` field to GitHub from the operator's browser.
2. Let the operator confirm the app name on GitHub.
3. Receive GitHub's redirect at the manifest `redirect_url`.
4. Check the returned `state` against the stored value.
5. Post the temporary `code` to GitHub's conversion endpoint.

Use this target for a personal account:

```text
POST https://github.com/settings/apps/new?state=<unguessable-value>
```

Use this target for an organization account:

```text
POST https://github.com/organizations/<organization>/settings/apps/new?state=<unguessable-value>
```

GitHub redirects the browser to `redirect_url?code=<temporary-code>&state=<state>`. The server then calls this endpoint:

```text
POST https://api.github.com/app-manifests/<temporary-code>/conversions
```

GitHub documents the POST targets, redirect parameters, one-hour limit, and conversion endpoint in its [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

The conversion returns HTTP 201 and the full app configuration. Important fields include these values:

| Field | Use for curia |
|---|---|
| `id` | Save as `CURIA_GH_APP_ID`. |
| `pem` | Save as the GitHub App private key. |
| `slug` | Identify the bot login and app page. |
| `permissions` | Confirm the requested permission set. |
| `events` | Confirm that the event list is empty. |
| `client_id` and `client_secret` | curia does not use user authorization. Do not save these values. |
| `webhook_secret` | curia does not use webhooks. Do not save this value. |

GitHub shows these fields in the [conversion endpoint response](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest).

## Private key delivery

The conversion response delivers the `pem` private key once. GitHub stores only the public portion of a GitHub App key.

GitHub cannot return the same private key later. If curia loses it, the operator must generate a new private key.

GitHub states this storage rule in [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps#generating-private-keys).

## Tailnet redirect URL

GitHub requires a full `redirect_url`. Its manifest documentation does not require public network access to that URL.

GitHub calls this field the redirect URL. It is not the app's OAuth callback URL.

GitHub redirects the operator's browser. GitHub does not send a server callback to the `redirect_url`.

GitHub's official Probot setup uses `http://localhost:3000` for this flow. The local process receives the returned app values after the browser redirect.

The [Probot development guide](https://github.com/probot/probot/blob/master/docs/development.md#configuring-a-github-app) records this local flow. GitHub's manifest guide also says an app can [run locally or anywhere](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest#using-probot-to-implement-the-github-app-manifest-flow).

This evidence supports an inference. A Tailscale HTTPS address works when the operator's browser can reach it.

GitHub's servers do not need tailnet access for the redirect.

This conclusion assumes that curia keeps webhooks inactive. An active webhook would require a URL that GitHub's servers can reach.

## curia permissions and events

The manifest can set permissions through `default_permissions`. It can set webhook subscriptions through `default_events`.

curia's [current app setup](../github-app.md#2-grant-the-permissions) requires these repository permissions:

| Manifest permission | GitHub settings name | Level |
|---|---|---|
| `contents` | Contents | Write |
| `issues` | Issues | Write |
| `pull_requests` | Pull requests | Write |
| `statuses` | Commit statuses | Read |
| `metadata` | Metadata | Read |

GitHub grants Metadata read access automatically. The manifest must not request Workflows, organization, or account permissions.

Set `default_events` to an empty list. Set the webhook as inactive because curia polls GitHub.

If the manifest supplies `hook_attributes`, set `active` to `false`. GitHub defaults this value to `true` inside that object.

GitHub defines these fields in the [manifest parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest#github-app-manifest-parameters). GitHub also recommends the [minimum required permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#about-github-app-permissions).

The app must use `public: true` for curia's current personal-account design. A private app can only install on its owner account.

The public setting lets one personal app install on watched organizations. Marketplace publishing remains a separate choice.

GitHub documents the installation limit in [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private). Its [sharing guide](https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app) separates public links from Marketplace publishing.

## App owner

The manifest flow supports personal and organization ownership. The first POST target selects the owner type.

GitHub says a user can register an app under a personal account or an owned organization. An organization App Manager can also create organization-owned apps.

The manifest flow does not support enterprise-owned GitHub Apps.

See GitHub's [registration overview](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app) and [organization role permissions](https://docs.github.com/en/organizations/managing-peoples-access-to-your-organization-with-roles/permissions-of-predefined-organization-roles).

curia does not need organization ownership. Its current design creates a public app under the operator's personal account.

## Installation remains separate

The conversion creates an app registration. It does not create an installation or select repositories.

After conversion, the owner can install the app on permitted accounts. The operator must then select every watched repository.

The [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) describes installation as a later owner action. curia's [installation checklist](../github-app.md#4-install-it-on-both-owners) defines the required repository grants.

## Key storage in curia

The browser must never receive the conversion response. The response contains the private key, client secret, and webhook secret.

The [dashboard sidecar](../../deploy/compose.yaml) currently holds no secret. It cannot read the environment file or the private key file.

A daemon-owned conversion handler should exchange the temporary code and store the returned `pem`. The dashboard sidecar should pass only the temporary code and state.

Store the PEM at `daemon/.curia-app.pem` with mode 0600. Store these two lines in `daemon/.env.daemon`:

```dotenv
CURIA_GH_APP_ID=<returned id>
CURIA_GH_APP_KEY_FILE=.curia-app.pem
```

Do not put the multiline PEM in `daemon/.env.daemon`. The file path keeps the PEM out of child process environments.

The [accepted app decision](../adr/0018-the-daemon-is-a-github-app.md) defines this storage pattern. The [operator checklist](../github-app.md#6-put-the-key-on-the-box-dev-session) defines the file mode and environment fields.

Git ignores both files. The root [ignore file](../../.gitignore) covers `.env.*` and `*.pem`.

## Finding

The manifest flow is a small dashboard feature. The tailnet address does not block app creation.

The feature needs one GitHub form POST, one redirect route, one conversion request, and a daemon-owned secret write.

The flow can reproduce curia's permissions and empty event list. It can also create the app under a personal account or organization.

The feature does not remove the installation step. The operator must still install the app and select repositories on GitHub.
