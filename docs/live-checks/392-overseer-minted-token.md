# The overseer's minted read-only token (#392)

What was measured before the cutover shipped, and what the box must show after it. [ADR-0018](../adr/0018-the-daemon-is-a-github-app.md) carries the decision, and [#313](313-overseer-github-token.md) carries the routing this replaces the credential inside of. The overseer is the second holder to move, after the agents ([#389](389-agent-minted-token.md)).

Sections 1 to 3 were taken on 2026-08-16 in a curia agent container, against real git and `gh version 2.97.0`. Section 4 is the box's own reading, and only the box can take it.

## The question

The container held one fine-grained PAT per resource owner, in `daemon/.env.overseer`, and compose handed that file over at container CREATE. Two things follow, and both are fatal for an installation token.

1. **An installation token lives one hour.** The overseer is a long-lived service, so a value frozen at container create dies inside the first afternoon.
2. **An owner the container never held needed a recreate.** Every other thing this container reads from the config runs per turn since [#361](https://github.com/alp82/curia/issues/361): the config, the checkout pass and the per-owner git routing. The token was the one exception.

A file the daemon writes answers both. The shape has to serve `gh` and git, and `gh` reads one `GH_TOKEN` while the container holds one token per owner — so the shim of [#327](https://github.com/alp82/curia/issues/327) stays, and what changes inside it is a variable read becoming a file read.

## 1. The shape

One file per owner, named by the owner in lower case, under `<workspace_root>/overseer/tokens/`. The daemon writes it at mode 0600 through a rename, and compose mounts the tree read-only at the same path on both sides.

Lower case, and not the uppercase slug the env key used: a GitHub login is unique without regard to case, and the shim has to build this name from whatever spelling a command line carried. `overseertoken.mjs` and the shim state that one rule.

The helper line git gets carries the PATH and never the token:

```
$ git config --global --get credential.https://github.com/alp82.helper
!f() { [ "$1" = get ] || exit 0; t="$(cat '<tokens>/alp82' 2>/dev/null)"; [ -n "$t" ] || exit 0; printf 'username=x-access-token\npassword=%s\n' "$t"; }; f
```

`username=x-access-token` is what the container's git already got before this change, so git's view of the credential does not move.

## 2. git reads the file, and reads it again

With no `GH_TOKEN` and no `GITHUB_TOKEN` in the environment, against real git:

```
$ git credential fill <<< 'protocol=https
host=github.com
path=alp82/curia.git
'
protocol=https
host=github.com
username=x-access-token
password=<the contents of <tokens>/alp82>

$ grep -c '<that token>' ~/.gitconfig
0
```

The token is in the file and in no config. A read of a real remote over the same helper:

```
$ git ls-remote https://github.com/alp82/curia.git HEAD
7f82fcb746df26ba59511fcb5c717f152433f1e4	HEAD
```

The suite re-takes this on every run (`daemon/test/overseercreds.test.mjs`), including the two rows that matter most:

- **The refresh.** The file is rewritten under a live routing, and the next `git credential fill` prints the new value. Nothing is restarted, and no config is rewritten.
- **The empty case.** A file that is missing prints NOTHING rather than an empty password. git reads an empty password as a credential and stops asking other helpers, so "no answer" and "no password" must not look alike. The row asserts git exits nonzero with no `password=` line.

## 3. `gh` reads the same file, through the shim

The real `gh`, with every inherited token unset, and the owner taken off the command line:

```
$ CURIA_OVERSEER_TOKEN_DIR=<tokens> gh api -i repos/alp82/curia | head -2
HTTP/2.0 200 OK
X-Ratelimit-Limit: 5000
```

`5000` is the authenticated limit, which is the proof the credential was used rather than the call merely succeeding — `alp82/curia` is public, so an unauthenticated read of it also answers 200.

The same command from inside a checkout directory, with no owner on the command line at all — rule 4 of the shim, which is the `<owner>__<repo>` directory name:

```
$ cd <checkouts>/alp82__curia
$ CURIA_OVERSEER_TOKEN_DIR=<tokens> gh api -i user | head -2
HTTP/2.0 200 OK
X-Ratelimit-Limit: 5000
```

With no token file for that owner, `gh` refuses rather than reaching GitHub as somebody else:

```
$ CURIA_OVERSEER_TOKEN_DIR=<empty dir> gh api -i repos/alp82/curia
To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.
```

That is louder than the git half, which falls through to an anonymous read. Both are safe in the same way: no owner means no token, never another owner's.

The suite runs the real shim against a fake `gh` for every one of its four owner rules, plus the traversal case (`repos/../../etc/passwd` reads nothing) and the refresh case (a rewritten file changes what the next call carries).

## 4. The box

The operator's reading, after the deploy. Before the first `up`, `~/curia-work/overseer/tokens` must exist and be owned by uid 1000 — docker creates a missing bind-mount source as root ([docs/deploy.md](../deploy.md)).

The daemon states the arming once per owner, on the first pass:

```
the overseer reads alp82/* through /home/alp/curia-work/overseer/tokens/alp82
```

Then, on the box:

| What | Expected |
| --- | --- |
| `~/curia-work/overseer/tokens/` | one file per watched owner, mode 0600, each holding a `ghs_` token |
| `daemon/.env.overseer` | the model credential only; boot names any `CURIA_OVERSEER_GH_TOKEN_*` left in it |
| the overseer container's `~/.gitconfig` | one helper line per owner, each naming a path and no token |
| **a real turn** | it reads a PRIVATE file out of a checkout, and writes nothing |
| a turn an hour later | the token in the file has changed, and no read has failed |
| a repo watched under a BRAND NEW owner | the next turn routes it, with no edit of an env file and no `docker compose up` |

The last row is the one that proves what #361 could not finish. The new owner needs the app installed on it, and nothing else.

## What this does not prove

- **The daemon's own `gh` still uses the operator's host login.** It cuts over on [#390](https://github.com/alp82/curia/issues/390).
- **An owner the app is not installed on has no fallback here.** The agents kept `CURIA_AGENT_GH_TOKEN_*` for that case (#389). The overseer keeps nothing: it reads public repositories only, and it names the owner in the chat once per turn. That was the operator's decision on this ticket, and the reason is that a per-owner PAT kept alive forever is the cost ADR-0018 exists to remove.
- **`gh auth status` inside the container fails**, as it does for an agent: it calls `GET /user`, which an installation token answers 403. Nothing in the overseer's standing orders runs it.
- **The read set did not change**, so nothing here re-measures what #313 measured about reach. A repo left off the installation answers 404 exactly as a PAT missing it did.
