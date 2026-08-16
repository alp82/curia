# The agent's minted GitHub token (#389)

What was measured before the cutover shipped, and what the box must show after it. [ADR-0018](../adr/0018-the-daemon-is-a-github-app.md) carries the decision. The agents are the first holder to move.

Sections 1 to 3 were taken on 2026-08-16 inside a real agent container, against the real `gh` binary and real git. Section 4 is the dispatch reading, and only the box can take it.

## The question

An agent used to get a fine-grained PAT as `GH_TOKEN` in its container environment (#155). A PAT lives a year, so a value handed over at spawn stayed good for the whole ticket. An installation token lives ONE HOUR. So the value cannot ride the environment any more, and the file that replaces it has to serve both `gh` and git with no shim — the agent image build COPYs nothing.

## 1. Which file, and what it must hold

`gh` reads a token from `GH_TOKEN` or from its own `hosts.yml`, and git already reaches GitHub through `credential.helper = !gh auth git-credential`. So `hosts.yml` in a per-agent `GH_CONFIG_DIR` is the one file both tools read, and the env carries the PATH to it.

The first shape written was the obvious one, and it fails:

```yaml
github.com:
    oauth_token: <token>
    user: x-access-token
    git_protocol: https
```

`gh` reads that as a PRE-multi-account config and runs its own migration. The migration calls `GET /user` to learn the login. Two things follow, and both are fatal here.

**It refuses on a token that cannot answer.** An installation token answers `GET /user` with a 403. Measured with a token GitHub rejects outright, which fails the same way:

```
$ printf 'protocol=https\nhost=github.com\n\n' | GH_CONFIG_DIR=... gh auth git-credential get
failed to migrate config: cowardly refusing to continue with multi account migration:
couldn't get user name for "github.com" ... 401 Unauthorized
$ echo $?
1
```

**It rewrites the file.** With a PAT, which does answer, the same command overwrote the daemon's file — `user: x-access-token` became `user: alp82`, and a `users:` block appeared. The daemon-owned file stopped being daemon-owned at the agent's first `gh` command.

## 2. The shape that works

Two files. `config.yml` states the config version, and `hosts.yml` carries a `users:` block. Together they are what `gh` reads as ALREADY migrated.

`config.yml`:

```yaml
version: "1"
```

`hosts.yml`:

```yaml
github.com:
    git_protocol: https
    user: x-access-token
    oauth_token: <token>
    users:
        x-access-token:
            oauth_token: <token>
```

Both places are load-bearing. `gh` reads the token off the top-level `oauth_token`, and it reads the `users:` block to decide no migration is needed. A file with only the `users:` block yields NO credential: exit 1 and no output.

Measured with `gh version 2.97.0 (2026-07-31)`:

```
$ printf 'protocol=https\nhost=github.com\n\n' | GH_CONFIG_DIR=... gh auth git-credential get
protocol=https
host=github.com
username=x-access-token
password=<token>
$ echo $?
0
```

The file was byte-identical afterwards. The same command was then run with a FAKE `ghs_` token, and it answered the same way — which is the proof that matters, because a fake token could not survive one network call. `gh` makes none.

`username=x-access-token` is what `GH_TOKEN` already yields today, on the same measurement. So git's view of the credential does not change across this cutover.

## 3. Both tools, end to end

Against `alp82/curia`, with `GH_TOKEN` unset and only the two files above:

```
$ GH_CONFIG_DIR=... git -c credential.helper='!gh auth git-credential' \
    ls-remote https://github.com/alp82/curia.git HEAD
20d98d8a64f3ea5778921e4ec74118bcaabb0123	HEAD
$ GH_CONFIG_DIR=... gh api /repos/alp82/curia --jq .full_name
alp82/curia
```

One file, both tools, no shim.

Sections 1 to 3 are re-taken by the suite on every run: `daemon/test/agentgh.test.mjs` runs the real `gh` binary against what the daemon writes, and skips where `gh` is not installed. A gh release that changes the migration rule fails there rather than on the box.

## 4. The dispatch

The operator's reading, on the first real dispatch after this merges. The daemon must state the mint at spawn:

```
minted a write GitHub token for curia-<n> on alp82/curia
curia commits as curia-sh[bot] <317489578+curia-sh[bot]@users.noreply.github.com>
```

Then, on the ticket:

| What | Expected |
| --- | --- |
| `<workspace_root>/cfg/curia-<n>/gh/hosts.yml` | present, mode 0600, holding a `ghs_` token |
| the container env file | carries `GH_CONFIG_DIR=/cfg/gh`, and no `GH_TOKEN` |
| the commits on `curia/<n>` | authored by `curia-sh[bot]` |
| the push and the pull request | by `curia-sh[bot]` |
| the merge | by `curia-sh[bot]` |
| after an hour of work | the token in the file has changed, and no `gh` call has failed |
| the ticket's ending | the `gh` directory is gone with the config dir |

A ticket that outlives the hour is what proves the refresh. The file is rewritten on the dispatch tick, every 60 s, and the minter serves its cached token until ten minutes before the hour — so the value turns over about every fifty minutes.

## What this does not prove

- **The overseer and the daemon still hold PATs.** They cut over on [#392](https://github.com/alp82/curia/issues/392) and [#390](https://github.com/alp82/curia/issues/390).
- **`CURIA_AGENT_GH_TOKEN_*` is still live**, as the fallback. An owner the app is not installed on, and a box with no app at all, keep #155's PAT. Retiring the keys waits for this reading.
- **`gh auth status` inside a container fails**, and that is expected rather than a fault: it calls `GET /user`, and an installation token answers 403. Nothing in an agent's standing orders runs it.
- **`.github/workflows/` stays unwritable.** ADR-0018 leaves `workflows` out of both permission sets, so a push touching that path fails naming the permission. The PAT could not write it either.
