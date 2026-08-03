# Live check: the worker image builds and runs on the box (#154)

Ticket: [alp82/curia#154](https://github.com/alp82/curia/issues/154), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Built on the deployment box
`coinmatica.net` on 2026-08-03, and on the dev workstation before it. Nothing was restarted and
no worker ran under it — the container reaches the dispatch path at
[#156](https://github.com/alp82/curia/issues/156).

## 1. The build is green on both machines

Same Dockerfile, same five build args, and the tag the daemon derives from
`config/curia.yaml`:

| Machine | docker | builder | Time | Size |
|---|---|---|---|---|
| dev workstation | 29.6.2 | BuildKit | ~4 min cold | 1.59 GB |
| `coinmatica.net` | **20.10.17** | **classic** | 1 m 59 s cold | 1.59 GB |

```
Successfully tagged curia-worker:2.1.220-0.146.0-c6c38f36
```

The box matters on its own: docker 20.10 predates BuildKit-by-default, so the Dockerfile has to
build on the classic builder. It does, and the test suite pins that — no `RUN --mount`, no
heredoc, no `COPY`.

## 2. What the image holds

Run as the image's own user, on the box:

```
$ docker run --rm curia-worker:2.1.220-0.146.0-c6c38f36 bash -lc 'id; claude --version; codex --version; gh --version'
uid=1000(agent) gid=1000(agent) groups=1000(agent)
2.1.220 (Claude Code)
codex-cli 0.146.0
gh version 2.97.0 (2026-07-31)
```

Both CLIs are the versions the box itself runs, so a worker and a hand session meet the same
tool. `gh` is three years ahead of Debian 12's own package (2.23), which is why it is fetched
from the upstream release and pinned too.

`LANG=C.UTF-8` is set: both backends are TUIs, and a container with no locale draws their box
characters as question marks.

## 3. uid 1000 is load-bearing

The daemon prepares the clone on the host as `alp` (uid 1000) and bind-mounts it. So the
container user must be uid 1000 or the worker cannot write its own worktree. `node:lts-slim`
already holds uid 1000 as `node`, so the build renames that user rather than adding a second
one.

Measured with a host directory owned by uid 1000:

```
$ docker run --rm -v <hostdir>:/workspace curia-worker:... bash -lc 'echo written by the container >> a.txt'
$ cat <hostdir>/a.txt
hi
written by the container
```

## 4. The cache volumes work, and the browser deps were needed

Both volumes inherit the `agent` ownership on first mount:

```
drwxr-xr-x 1 agent agent /cache/npm
drwxr-xr-x 1 agent agent /cache/playwright-browsers
```

An npm install put its cache in the volume (40 K), not in the container.

The browser half is the finding. [#148](https://github.com/alp82/curia/issues/148) keeps
browsers out of the image and installs them on demand, and the on-demand half cannot install
its own OS libraries: `playwright install --with-deps` runs apt-get, which needs the root the
agent user does not have. So the image carries chromium's libraries and not chromium. With them
in place the stated path works end to end:

```
$ npx --yes playwright@1.62.1 install chromium
Chrome Headless Shell 151.0.7922.34 downloaded to /cache/playwright-browsers/chromium_headless_shell-1234
$ node -e 'launch, set content, read it back'
title:  | text: curia worker image
version: 151.0.7922.34
```

Without the libraries the download would have succeeded and the launch would have failed, which
is the failure that hides until a worker hits it.

## 5. Where the 1.59 GB is

| Layer | Size |
|---|---|
| both agent CLIs | 643 MB |
| apt: build-essential, git, curl, ripgrep, python3 | 376 MB |
| chromium OS libraries | 307 MB |
| gh | 41 MB |
| `node:lts-slim` base | ~230 MB |

The CLI layer is a single native binary each — claude ships one 275 MB `claude.exe`, codex one
platform package — so there is nothing to prune there. The box has 132 GB free.

## 6. The daemon user could not reach docker

**Closed the same day** by [#181](https://github.com/alp82/curia/issues/181). What follows is
what this check found, kept as the record of why the grant was needed.


```
$ ssh alp@coinmatica.net docker ps
Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock
$ id
uid=1000(alp) gid=1000(alp) groups=1000(alp),101(systemd-journal)
$ getent group docker
docker:x:998:vector
```

`alp` is not in the `docker` group, and its sudo rights reach only `cp` of the unit file and
`systemctl` on `curia`. Docker is installed on the box, as
[#148](https://github.com/alp82/curia/issues/148) recorded, but the daemon user cannot use it.
Every build and run above went through root over ssh.

Rootful Docker is still the answer, and the grant is the cost:

```
sudo usermod -aG docker alp     # root, once
```

Anyone who reaches the socket can mount `/` into a container, so this makes `alp` root on the
box. Rootless Docker does not avoid it here: it maps a container uid to a subordinate host uid,
so an agent at uid 1000 could not write the bind-mounted clone (§3), and the container-root that
does map to `alp` is the one user Claude Code refuses to run as.

The worker never reaches the socket either way. It is denied inside the container, which is what
the boundary is for.

### The grant, and what it proved

The operator approved it in session. After the grant and a service restart, the daemon process
carries the group:

```
$ grep ^Groups /proc/$(systemctl show -p MainPID --value curia)/status
Groups: 101 998 1000
```

Then the check worth having. Run as `alp`, not as root:

```
$ npm run build-worker-image --prefix daemon
image       curia-worker:2.1.220-0.146.0-c6c38f36
already built — nothing to do (use --force to rebuild it anyway)
```

The tag the daemon derives from `config/curia.yaml` is the tag root's build produced. So the
content address agrees across two machines, two docker versions and two builders — which is the
property the whole rebuild rule rests on.

The restart was taken with `curia-160` live. `KillMode=process` left it standing and boot
reconcile re-adopted it: `reconcile: re-adopted live worker curia-160 (alp82/curia#160)`.
