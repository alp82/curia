# The gate approval, proven live (#391)

[#391](https://github.com/alp82/curia/issues/391) made the ✅ press post a real GitHub approval, and
[#478](https://github.com/alp82/curia/pull/478) merged it. Nothing in that ticket ran against GitHub.
The daemon that answered its own gate still carried the old build, so the approval it recorded was the
old code approving itself. This note is the live reading, taken on
[#479](https://github.com/alp82/curia/issues/479) on 2026-08-17.

[ADR-0018](../adr/0018-the-daemon-is-a-github-app.md) carries the decision. The agents
([#389](389-agent-minted-token.md)) and the overseer ([#392](392-overseer-minted-token.md)) were proven
the same way. This is the third of the three.

## The question

An App cannot approve for a human. An App-minted approval on an App-authored pull request is a
self-approval, and GitHub refuses it. So the press has to reach GitHub on the operator's OWN `gh`
login, and no minted token may stand in for it. Two facts state whether the pair works.

1. The pull request is authored by `curia-sh[bot]`, and it carries an approving review by `alp82`.
2. The agent then merges it into a protected `main`, and GitHub lets that merge through.

Only the box produces either one. The operator's own press makes the first, and only the operator can
turn on the rule the second reads. **The first is proven here. The second is not**, and section 4 says
why.

## 1. When the new build took over

`#478` merged at 22:35 on 2026-08-16. The deploy came later, and the pull requests either side of it
say when.

| Pull request | Merged (UTC) | Approving review |
| --- | --- | --- |
| 490 | 2026-08-16 23:46:51 | none |
| 491 | 2026-08-16 23:49:32 | none |
| **493** | **2026-08-16 23:56:33** | **`alp82`, at 23:56:18** |

Every press before 491 posted nothing, and every press from 493 on posted an approval. So the deploy
landed in the seven minutes between 23:49 and 23:56, and pull request 493 carries the FIRST live gate
approval.

## 2. The first live approval

Read with `gh api repos/alp82/curia/pulls/493` and `gh api repos/alp82/curia/pulls/493/reviews`:

| What | Reading |
| --- | --- |
| pull request | [493](https://github.com/alp82/curia/pull/493), "How often a codex model re-reads a skill it triggers" |
| author | `curia-sh[bot]` |
| base branch | `main` |
| review state | `APPROVED` |
| reviewer | `alp82`, association `OWNER` |
| approval time | 2026-08-16 23:56:18 |
| merged by | `curia-sh[bot]`, at 23:56:33 |
| merge commit | `0dd1f5c49ff39a5123e488dd3cb5666911ccace6` |

Two logins, and they differ. That is the whole point: GitHub accepted the review because the daemon
posted it on the host login, and it accepted the merge because the agent ran it on the minted token.
A self-approval would have failed the first call.

The approval arrives 15 seconds before the merge. That is the order #391 built: the daemon submits the
review on the press, and it tells the agent to merge only after the submission stands.

## 3. Every press since

The pattern repeats on every ticket worked since the deploy. Each row is one `curia-sh[bot]` pull
request into `main`, approved by `alp82` and merged by `curia-sh[bot]`.

| Pull request | Approved (UTC) | Merged (UTC) | Gap |
| --- | --- | --- | --- |
| 493 | 2026-08-16 23:56:18 | 23:56:33 | 15 s |
| 495 | 2026-08-17 00:21:30 | 00:21:37 | 7 s |
| 494 | 2026-08-17 00:22:57 | 00:23:23 | 26 s |
| 496 | 2026-08-17 05:42:10 | 05:42:26 | 16 s |
| 498 | 2026-08-17 06:02:37 and 06:13:37 | 06:13:44 | 7 s |
| 500 | 2026-08-17 08:29:01 | 08:29:07 | 6 s |
| 497 | 2026-08-17 08:45:42 | 08:45:49 | 7 s |

Seven pull requests, and no press has failed. **Pull request 498 carries TWO approvals.** The gate
re-reads the pull request at each press, so a second round over a changed diff submits a second review.
Both stand, because `dismiss_stale_reviews` is off wherever the rule is on at all.

**No `approval-failed` outcome appeared.** The fault path of #391 stayed unwalked, so this note proves
the success path only.

## 4. The protected merge, which did not happen

**The rule is off, and the operator decided so on this ticket.** `main` on `alp82/curia` carries no
branch protection:

```
$ gh api repos/alp82/curia/branches/main --jq .protected
false
```

So the second half of the pair is UNPROVEN, and it is unproven by choice rather than by fault. Every
merge in section 3 went into an unprotected `main`. The agent's standing orders are what held it behind
the press, and GitHub enforced nothing. That is the state this box runs in.

Nothing breaks. Curia requires no setting in a watched repo, and nothing in the daemon reads the rule.
The approval is posted either way, which is what section 3 measures. The command stays on the page:
[docs/github-app.md](../github-app.md) step 7 is one call whenever the operator wants it, and this note
is the reading to re-take after it.

**An agent can neither set the rule nor read it.** The minted token holds no **Administration**
permission:

```
$ gh api repos/alp82/curia/branches/main/protection
Resource not accessible by integration (HTTP 403)
```

The branch object answers `protected` off Contents alone, which is how the reading above was taken.
That is also why #479 could not walk its own ticket text: it asked for the rule to go on first, and an
agent cannot do it. The agent asked instead, and the answer is the paragraph above.

## What this does not prove

- **Enforcement.** GitHub has refused no merge of curia's, because there is no rule to refuse it by. The
  gate is binding on the agent's standing orders and on nothing else. Re-take section 4 if the rule
  ever goes on.
- **The fault path never ran.** No press answered "curia could NOT post the GitHub approval", so the
  refusal handling of #391 is proven by its tests and not by the box.
- **An owner with no installation is not measured here.** There the daemon falls back to the host login
  and opens the pull request as `alp82`, and GitHub refuses the self-approval as one account reviewing
  itself. `alp82/curia` carries the installation, so this note never reached that path.
- **Only `alp82/curia` is read.** The other three watched repos take the same dispatches and the same
  presses, and none of them is measured here.
