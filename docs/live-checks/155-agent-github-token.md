# Live checks: the agent's scoped GitHub token (#155)

Run 2026-08-04 against the real API with the two real tokens, `curia-agent-alp82` and `curia-agent-getalfredo`. Every claim below is a measurement, not a reading of the documentation. Token values never left `daemon/.env`.

Both tokens carry the same five permissions: Contents read/write, Issues read/write, Pull requests read/write, Commit statuses read, Metadata read.

## 1. The token is the operator, and `@me` resolves

| Check | Result |
| --- | --- |
| `gh api user --jq .login` | `alp82` |
| `gh api graphql -f 'query={viewer{login}}'` | `{"data":{"viewer":{"login":"alp82"}}}` |

This one mattered. The wayfinder claim step runs `gh issue edit --add-assignee @me`, and `@me` resolves through the GraphQL viewer. A fine-grained PAT answers both, so the claim needs no change.

## 2. The wayfinder machinery works on the watched repo

All with `CURIA_AGENT_GH_TOKEN_ALP82`.

| Check | Result |
| --- | --- |
| `gh issue view 155 --repo alp82/curia` | the title |
| `gh api repos/alp82/curia/issues/147/sub_issues` | 30 children |
| `gh api repos/alp82/curia/issues/184/dependencies/blocked_by` | 2 blockers |
| `gh pr list --repo alp82/curia` | answers |
| `gh api repos/alp82/curia/commits/main/status` | `pending` |
| `gh issue edit 155 --add-assignee @me` (a real write) | the issue URL |

Sub-issues and issue dependencies both ride the Issues permission, so the whole map surface works with no extra grant.

## 3. What the token cannot do

| Check | Result |
| --- | --- |
| `gh api repos/alp82/curia/actions/secrets` | `403 Resource not accessible by personal access token` |
| `gh api repos/alp82/curia/hooks` | `403 Resource not accessible by personal access token` |
| `gh api -X PATCH repos/alp82/curia -f description=probe` | `403 Resource not accessible by personal access token` |

Secrets, webhooks and repository settings are all refused by GitHub rather than by a standing order. That is the amendment to ADR-0006.

## 4. Public read is NOT scoped — the finding that shaped the boot probe

| Check | Result |
| --- | --- |
| `gh api repos/cli/cli` with the alp82 token | `cli/cli` |
| `gh api repos/cli/cli/issues` with the alp82 token | 30 issues |
| `gh api user/repos` with the alp82 token | **34** repos |
| `gh api user/repos` with the host login | **83** repos |
| `gh api repos/alp82/backendcn` with the alp82 token | `404 Not Found` |

Every fine-grained PAT reads public repositories, whether or not they are in its selection. So research on a stranger's repo keeps working, which is what agents need, and a **public** repo left off the token's selection cannot be detected by any read.

Worse for detection: the repo payload's `permissions` object describes the underlying **user**, not the token grant. The `getalfredo` token reports `{"admin":true,"push":true}` on `alp82/curia`, a repo it cannot possibly write, because a fine-grained PAT has exactly one resource owner.

A **private** repo outside the selection does answer `404`, which is a usable signal. That is the case the boot probe catches.

## 5. The org caps token lifetime at 366 days

`gh api repos/getalfredo/landing-page` with the **alp82** token:

```
The 'getalfredo' organization forbids access via a fine-grained personal
access tokens if the token's lifetime is greater than 366 days.
```

The alp82 token has no expiration, so the org refuses it. The org's own token was minted inside the cap and works.

Read the expiry off the response header, which is present only when there is one:

| Token | `Github-Authentication-Token-Expiration` |
| --- | --- |
| `curia-agent-alp82` | absent — the token never expires |
| `curia-agent-getalfredo` | `2027-08-05 06:20:31 UTC` |

So org resources cannot be reached by a permanent PAT. The `getalfredo` token will die on 2027-08-05, and an expired token does **not** fall back to the host login. It fails every `gh` call with a 401. That is what the boot probe's expiry warning exists for.

## 6. The boot probe, on the real watch list

Real `config/curia.yaml`, real tokens, a temporary data dir and ports:

```
worker GitHub token CURIA_AGENT_GH_TOKEN_ALP82 (…AWE0)
worker GitHub token CURIA_AGENT_GH_TOKEN_GETALFREDO (…0NpR)
CURIA_AGENT_GH_TOKEN_GETALFREDO reaches getalfredo/landing-page, expires in 365 days
```

The two `alp82` repos say nothing, because they are reachable and their token never expires. The probe speaks only when there is something to act on.

With the `getalfredo` key removed, the same boot says:

```
WARNING: no CURIA_AGENT_GH_TOKEN_GETALFREDO — workers on getalfredo/* inherit the host gh login (account-wide)
```
