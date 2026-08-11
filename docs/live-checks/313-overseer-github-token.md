# Live checks: the overseer's read-only GitHub token (#313)

Run 2026-08-11. Sections 1 to 3 are measurements against the real API and against real git. They were taken from inside an agent container, which carries the agent token `CURIA_AGENT_GH_TOKEN_ALP82`. The overseer's own tokens did not exist when these ran, because no agent can mint one. Section 4 is the mint record the operator reported.

## 1. The org lifetime cap is a refusal, not a narrowing

| Check | Result |
| --- | --- |
| `gh api repos/getalfredo/landing-page` with the alp82 agent token | `403` — the `getalfredo` organization forbids access via a fine-grained personal access token if the token's lifetime is greater than 366 days |
| the same repo, with no credential at all (`curl`) | `200` |

The alp82 agent token has no expiration, which is why the org refuses it. [#155](https://github.com/alp82/curia/issues/155) measured that refusal on a private org repo. This run shows it also refuses a **public** one.

**So a token that lives longer than 366 days reads less of that org than no token at all.** The overseer's `getalfredo` token therefore carries a 366-day life. Its `alp82` token has no expiration, and it never touches an org repo, because the routing in section 3 picks by owner.

## 2. Every watched repo is public today

| Repo | `private` |
| --- | --- |
| `alp82/curia` | `false` |
| `alp82/aistack` | `false` |
| `alp82/alperortac.com` | `false` |
| `getalfredo/landing-page` | `false` (read with no credential — the alp82 token is refused by the cap above) |

Every fine-grained PAT reads public repositories, whether or not they are in its selection ([#155](https://github.com/alp82/curia/issues/155) section 4). So one token would read the whole watch list today, except at the `getalfredo` org, where the lifetime cap decides instead of the selection. One token per owner is what keeps the read working when a private repo joins the list.

## 3. git picks the owner's token by itself

git 2.39.5, two helpers, one per owner, and no `credential.useHttpPath`:

```
git config --global 'credential.https://github.com/alp82.helper'      '!<prints the alp82 token>'
git config --global 'credential.https://github.com/getalfredo.helper' '!<prints the org token>'
```

| Check | Helper consulted |
| --- | --- |
| `git credential fill` for `path=alp82/curia.git` | alp82 |
| `git credential fill` for `path=getalfredo/landing-page.git` | org |
| `git credential fill` for `path=stranger/repo.git` | none — no helper answers |
| a real `git ls-remote https://github.com/alp82/curia-private-probe.git` | alp82, and only alp82 |
| a real `git ls-remote https://github.com/getalfredo/private-probe.git` | org, and only org |

The last two rows are the ones that matter. They are a real network fetch, so the path git matches on is the one it parses out of the remote URL, not one typed into a test. git prefix-matches the owner and never offers the other owner's token.

**So git needs no shim, and `credential.useHttpPath` is not needed either.** One config line per owner routes every clone and every fetch in the overseer's checkouts.

`gh` is the other half, and it does need one: it reads a single `GH_TOKEN`. [#327](https://github.com/alp82/curia/issues/327) installs both halves, because it owns the image.

## 4. The mint record

<!-- filled in when the operator reports -->
