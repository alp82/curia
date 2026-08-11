# Live checks: the overseer's checkouts (#312)

Run 2026-08-11 with `daemon/bin/curia-checkouts.mjs` against the real `github.com`, with a real `gh` login and a scratch workspace root. Every number below is a measurement. The unit suite (`daemon/test/checkouts.test.mjs`) drives a local origin, so these are the claims no local fixture can prove.

## 1. What a cold pass costs

| Check | Result |
| --- | --- |
| First pass, `alp82/curia` alone | cloned, `main` at `6820d4a5`, **4.0 s** |
| On-disk size of that checkout | **8.4 MB** |
| `git config remote.origin.partialclonefilter` | `blob:none` |
| Second pass, `alp82/curia` cached plus `alp82/aistack` cold | 4.8 s |
| Third pass, both cached | **1.5 s** |

1.5 s is the per-turn cost for two repos, and it is what ADR-0014's "it costs nothing while nobody asks" buys. A cold clone is seconds, which is what makes it safe to let the container clone a newly watched repo inside a turn rather than have the daemon pre-clone it.

## 2. Every ref, measured against what GitHub actually publishes

| Check | Result |
| --- | --- |
| `refs/remotes/origin/pr/*` in the checkout | **68 heads** |
| `git log -1 origin/pr/325` | `e8f6f4b Point the single-use thread rule at its own ticket (#326)` |
| Branches in the checkout, excluding `pr/*` | `origin/HEAD`, `origin/main` |
| `gh api repos/alp82/curia/branches` | `main` |
| `pr/*/merge` refs | absent, as intended |

**The finding: on this repo the pull-request heads are what answer "what did this agent change".** A merge runs `--delete-branch`, so a finished ticket leaves no `curia/<n>` branch at all — the checkout above holds `main` and nothing else, and it matches GitHub exactly. The branch refspec catches the live ones while an agent is working. The head refspec is what keeps every finished one readable. Neither refspec alone answers the question ADR-0014 says an operator asks first.

## 3. A blobless clone still reads a file

| Check | Result |
| --- | --- |
| `git show origin/pr/325:CONTEXT.md` | the file, first line `# Curia` |

The blob is not in the 8.4 MB. git fetched it on demand from a ref that is not the working tree's own branch. So "read the file this agent changed" works, and it costs one round trip rather than a full history download per repo.

## 4. The read-only posture, refused rather than asked

| Check | Result |
| --- | --- |
| `git commit` in a checkout | `Author identity unknown. *** Please tell me who you are.` |
| `git push origin HEAD:refs/heads/smoke-must-not-land` | `fatal: protocol 'no_push' is not supported` |

Both are manners, not controls: a shell undoes either in one command. ADR-0014 is explicit that the read-only token of [#313](https://github.com/alp82/curia/issues/313) is the control. What these buy is that an accident fails loudly and names itself, and the push never reached the network to be refused by GitHub.

## 5. The pass that could not run

| Check | Result |
| --- | --- |
| A config with no `identity:` section | exit 1, and stdout carries the loader's own message |

The command reads the watch list through `loadCuriaConfig`, the same loader that decides whether the daemon boots, rather than a second parser of its own. A config it refuses is a config the daemon refuses too.
