# Live check: a worker runs in its own container (#156)

Ticket: [alp82/curia#156](https://github.com/alp82/curia/issues/156), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the dev workstation
(docker 29.6.2) on 2026-08-04, with the docker-capability half re-measured on the deployment box
`coinmatica.net` (docker 20.10.17). The live daemon was not restarted and no ticket was
dispatched through it: the switch ships off, and previews reach a container at
[#157](https://github.com/alp82/curia/issues/157).

The check drives the real functions — `createPrivateClone`, `seedConfigDir`, `writeHarness`,
`writePrompt`, `writeEnvFile`, `dockerRunCmd`, `tmux.newSession` — in the order the dispatch path
calls them, against a scratch workspace root.

## 1. The workspace

```
clone    …/work/repos/alp82__curia/wt/9042
branch   curia/9042
remote   origin  https://github.com/alp82/curia.git (fetch) [blob:none]
identity alportac@gmail.com
helper   !gh auth git-credential
size     4.3M
```

Blobless, on the ticket branch, HTTPS remote, and the box's own git identity copied in — the
container HOME carries no gitconfig, so an unset identity would fail the worker's first commit
with "please tell me who you are".

## 2. The container reaches its composer

`tmux new-session` running the generated `docker run` line, captured 20 seconds later:

```
● Understood — spawn check acknowledged. Standing by.

● Ran 1 stop hook (ctrl+o to expand)
  ⎿  Stop hook error: Failed with non-blocking status code: No stderr output
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login for PR status
```

Three facts in one screen. The composer marker the readiness watchdog keys on is in the pane
tail, so `worker_ready` fires with no change to the watchdog. The prompt was read from
`/cfg/prompt.md` inside the container, which is what proves the single-quoting: `$(cat …)`
expanded in the container's shell, not on the host. And the Stop hook RAN — it failed only
because nothing was listening on the gateway in this check, which is the next item.

## 3. The boundary

From inside the live container:

```
id: uid=1000(agent) gid=1000(agent) groups=1000(agent)
cwd-write: ok            # /workspace
cfg-write: ok            # /cfg
ls /home/alp          -> No such file or directory
ls /tmp/tmux-1000     -> No such file or directory
ls ~/.claude          -> No such file or directory
ls /var/run/docker.sock -> No such file or directory
git -C /workspace log --oneline -1 -> 718f0a9 …
```

Host HOME, the tmux socket, the host credential store and the docker socket are all absent, and
the two mounts are writable by the agent uid. A repeat of [#141](https://github.com/alp82/curia/issues/141)
is not possible from here: there is no socket to kill a server on.

## 4. The side channel, both directions

A test listener on `172.17.0.1:4271`, then from inside the container:

```
$ curl -s -X POST "http://host.docker.internal:4271/worker_done?worker=curia-9042" -d '{"hook_event_name":"Stop"}'
daemon got: POST /worker_done?worker=curia-9042 {"hook_event_name":"Stop"}
{}
$ getent hosts host.docker.internal
172.17.0.1      host.docker.internal
```

That listener was a stub with no auth. Against the real daemon the same call now needs the worker's own token, and reaches only these two routes — see [the #159 checks](159-worker-token.md).

The CSRF gate lets it through: a container sends no `Origin` and no `Sec-Fetch-Site`, exactly
like the loopback tooling the gate was written for.

## 5. The published ports

A server bound inside the container on 9001, read from the host:

```
127.0.0.1:9001 -> 200
127.0.0.1:9003 (unpublished) -> 000
```

Published means reachable, unpublished means not. That is the bound
[#157](https://github.com/alp82/curia/issues/157) will validate `publish_preview` against.

## 6. `gh` and git, with the worker's own token

With `CURIA_AGENT_GH_TOKEN_ALP82` in the env file:

```
✓ Logged in to github.com account alp82 (GH_TOKEN)
$ gh issue view 156 --repo alp82/curia --json title -q .title
Containerize dispatch: docker run replaces the bare pane
$ git fetch origin main            -> exit 0
$ git push --dry-run origin HEAD:refs/heads/curia-livecheck-9042
 * [new branch]      HEAD -> curia-livecheck-9042
```

So [#155](https://github.com/alp82/curia/issues/155)'s token works unchanged inside the
container, and the credential helper the clone carries resolves through it. The push is proved
possible and was not taken: who pushes is a doctrine question, not a mechanism one — the daemon
still does it, from the host side of the same clone.

## 7. A dead container command still reads as a death (#169)

```
docker: ... requested access to the resource is denied
[curia] the backend command exited — curia-exit-abc123 125
```

The exit marker fires with docker's own status, and the pane excerpt carries docker's reason.
[#169](https://github.com/alp82/curia/issues/169)'s fail-fast path needed no change.

## 8. A container can outlive its pane — sometimes

Measured both ways, because the teardown rule rests on it:

| What happened to the pane | The container |
|---|---|
| `tmux kill-session` | **gone** — the `docker run` client forwards the signal |
| the client killed with SIGKILL | **still running**, holding its ports |

So the explicit `docker rm --force` on every ordered teardown is a belt, not the mechanism, and
the reconcile sweep is what covers the second row. Both are in.

## 9. The deployment box

Re-measured there, because its docker is nine years older than the workstation's:

```
$ docker --version
Docker version 20.10.17, build 100c701
$ docker run --rm --init --add-host host.docker.internal:host-gateway <image> \
    sh -c 'grep host.docker /etc/hosts; cat /proc/1/comm'
10.0.1.1  host.docker.internal
docker-init
```

Both flags work. The finding worth having is the address: the box's default bridge states **no
gateway at all** in `docker network inspect` —

```
{"Driver":"default","Options":null,"Config":[{"Subnet":"10.0.1.0/24"}]}
```

— while `host-gateway` inside a container resolves to `10.0.1.1`, which is `docker0`'s own
address on the host. A daemon that read only the `Gateway` field would have bound nothing there
and every sandboxed worker would have lost `ask_human` and the Stop hook. So `dockerGateway()`
falls back to the host interface sitting inside the stated subnet, rather than to the
first-address-in-the-subnet guess, which is right today and is not a fact.

**The worker image is not on the box.** [#154](https://github.com/alp82/curia/issues/154) built
it and [#181](https://github.com/alp82/curia/issues/181) confirmed the tag as `alp`; `docker
images` shows no `curia-worker` now. Nothing here depends on it — the daemon builds on demand,
which is what the content-address tag is for — but the first sandboxed dispatch on the box will
wait about two minutes for the build, and the thread now says so while it waits.
