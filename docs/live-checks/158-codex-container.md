# Live check: the codex lane in a container (#158)

Ticket: [alp82/curia#158](https://github.com/alp82/curia/issues/158), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.net` on 2026-08-04, from a dev session. Three real dispatches of
[#170](https://github.com/alp82/curia/issues/170) on `model=gpt` (`gpt-5.6-sol`, effort high).

The claude lane went first by [#148](https://github.com/alp82/curia/issues/148)'s rollout rule
and soaked through [#156](https://github.com/alp82/curia/issues/156),
[#157](https://github.com/alp82/curia/issues/157) and
[#185](https://github.com/alp82/curia/issues/185). This is the second lane.

## The credential was the whole ticket

`workspace.mjs` seeded `auth.json` as a **symlink** to `~/.codex/auth.json`, and that link was
the fix rather than the trap: codex rewrites the file in place, so a refresh through the link
lands on the host's own file and the two share one lineage (#39, verified by strace at the
time).

A container has no host HOME, so the link resolves to nothing inside it. Worse, it fails the
way [#156](https://github.com/alp82/curia/issues/156) found with skills — silently, at the
first turn rather than at the spawn. And `modelCredential` answers `{}` for anything that is
not the claude backend, so this lane had no container credential path at all.

**The copy is read-only, and that is the decision.** The host file on this box states its
contents plainly:

```
$ jq -r '.tokens|keys' ~/.codex/auth.json
["access_token", "account_id", "id_token", "refresh_token"]
```

A `refresh_token`, and providers rotate those. A worker refreshing a writable copy would
invalidate the token the **host** still holds — [#53](https://github.com/alp82/curia/issues/53)'s
stranding, arriving by the other lane. So the container worker is frozen on the token it
started with, which is the bound #156 accepted for claude and stated. `0400` makes an ordinary
in-place refresh fail rather than rotate silently. It is a bound against accident and not
against the agent: the container runs as uid 1000 and owns the file.

## The container, measured

```
$ docker inspect curia-170 --format '{{json .Mounts}}' | jq -r '.[] | "\(.Source) -> \(.Destination) rw=\(.RW)"'
/home/alp/curia-work/repos/alp82__curia/wt/170 -> /workspace rw=true
/home/alp/curia-work/cfg/curia-170            -> /cfg       rw=true
/var/lib/docker/volumes/curia-worker-npm-cache/_data  -> /cache/npm rw=true
/var/lib/docker/volumes/curia-worker-browsers/_data   -> /cache/playwright-browsers rw=true

$ docker inspect curia-170 --format '{{.Config.User}}'
1000:1000

$ docker exec curia-170 sh -c 'ls -l /cfg/auth.json; echo $CODEX_HOME'
-r-------- 1 agent agent 4223 Aug  4 18:12 /cfg/auth.json
/cfg

$ docker exec curia-170 sh -c 'ls /home/alp; ls /var/run/docker.sock'
ls: cannot access '/home/alp': No such file or directory
ls: cannot access '/var/run/docker.sock': No such file or directory
```

`CODEX_HOME` needed no sandbox branch: it already **is** the config dir, and the config dir is
already the mount. That is why delivery was the easy half and sharing was the hard one.

Codex writes its own state into the same dir and was not blocked by the read-only credential
beside it — `installation_id`, `models_cache.json`, `history.jsonl`, `logs_2.sqlite`,
`memories_1.sqlite` and `goals_1.sqlite` all appeared under `/cfg` during the run.

The agent reaches GitHub as itself, with no host login to fall back to
([#155](https://github.com/alp82/curia/issues/155)):

```
$ docker exec curia-170 gh auth status
  ✓ Logged in to github.com account alp82 (GH_TOKEN)
    Token: github_pat_***
$ docker exec curia-170 ls ~/.config/gh
ls: cannot access '/home/agent/.config/gh': No such file or directory
```

## The credential works, which only a model turn can prove

The composer proves nothing about auth — the pane draws it either way. The worker ran real
turns:

```
• Ran git status --short --branch && git log --oneline --decorate -8
  └ ## curia/170...origin/main
    755f184 (HEAD -> curia/170, origin/main) The codex lane runs in a container
• Explored
  └ Read bridge.mjs, workernotes.test.mjs, index.mjs
  gpt-5.6-sol high · /workspace
```

And it called a curia tool, which lands in the journal as the daemon's own record of the side
channel working in both directions from a codex container:

```json
{"type":"notify","worker":"curia-170","ticket":"170",
 "message":"The fix for ticket #170 already exists on main. I am checking its tests and tracker records."}
```

## The tool-channel window: this lane is not the claude lane

Measured the way [#194](https://github.com/alp82/curia/issues/194) measured the claude one —
`worker_mcp_first` against `worker_ready`:

| Run | spawn → first `/mcp` | spawn → composer marker | handshake, relative to the marker |
| --- | --- | --- | --- |
| 18:12:07 | 3189 ms | 4033 ms | 844 ms **ahead** |
| 18:17:39 | 1929 ms | 2011 ms | 82 ms **ahead** |
| 18:17:59 | 2116 ms | 2011 ms | **106 ms behind** (`since_ready_ms: 106`, `state: "ready"`) |

**The two events land within about 100 ms of each other, in either order.** The claude lane led
by 1.3–2.9 s in all four of its samples; this one straddles the marker. So the window is
**20 s**, more than the claude lane's 15 s — not because codex is slower, but because its
ordering is not established. It still catches a mute worker about 22 s after spawn.

Run 3 is also the case that would have broken a tighter design. The detector asks whether the
stamp has ARRIVED, never whether it arrived before readiness, so a handshake 106 ms after the
marker is a healthy worker and reads as one. A rule keyed on the order would have called it
mute.

## Not closed, and said so

- **The review gate, the Stop hook and `publish_preview` were not exercised on this lane.** The
  worker was cancelled before its first turn ended, because finishing #170 would have resolved
  a ticket nobody asked for. The tool channel, the credential, the mounts and the GitHub
  identity are proved; the ending is not.
- **The bare path is still there.** Retiring it is [#195](https://github.com/alp82/curia/issues/195),
  after the soak.
- **The lane's own faults keep their tickets** — [#171](https://github.com/alp82/curia/issues/171),
  [#172](https://github.com/alp82/curia/issues/172), [#173](https://github.com/alp82/curia/issues/173),
  [#174](https://github.com/alp82/curia/issues/174), [#176](https://github.com/alp82/curia/issues/176),
  [#177](https://github.com/alp82/curia/issues/177). This ticket was the container, not the backlog.
- **A frozen credential has not been outlived.** No container worker has yet run long enough for
  its copied access token to expire, so what codex does at that moment is untested.

## A correction to the #194 check

The teardown after #194's induced fault was read with `tmux -L curia ls`. **The daemon uses the
DEFAULT tmux socket**, so that command answered about a socket nobody writes and would have
said "no such file" with a live worker on the pane. Re-read here on the right socket — `tmux ls`
says `no server running`, `docker ps` lists no `curia-*` container — so the conclusion held and
the evidence for it did not. That live check now carries the correction.
