# Live check: worker becomes agent, on the box

[#184](https://github.com/alp82/curia/issues/184). Run on `coinmatica.net` on 2026-08-04, straight
after the deploy that carried the rename. Auto-dispatch was off throughout and no agent was live
when the daemon restarted, which is the condition the hard cutover was taken under.

The rename touches three things that outlive a restart: the wire an already-spawned agent talks on,
the journal every boot replays, and the image name a dispatch resolves. Each is checked below.

## 1. The daemon replays a journal written in the old words

The box's journal held 994 lines, all of them written before the rename. Boot reconcile ran over it
with no error:

```
Aug 04 20:14:12 curia daemon listening on http://127.0.0.1:4271
Aug 04 20:14:12 curia daemon also listening on http://10.0.1.1:4271 — the side channel for claude, codex containers
Aug 04 20:14:13 boot reconcile done
Aug 04 20:14:13 auto-dispatch OFF — the 60s tick still runs the agent-liveness sweep
```

Not throwing is weak evidence, so the deployed module was run against the box's own file:

```
journal lines: 994
legacy types: 147 | legacy worker field: 446 | legacy backend field: 45
still legacy after normalize: 0
in : {"ts":"2026-08-01T15:52:44.044Z","type":"worker_spawned","repo":"alp82/curia","ticket":"106",
      "worker":"curia-106","instance":"curia-106@1785599564043","model":"opus","backend":"claude"}
out: {"ts":"2026-08-01T15:52:44.044Z","type":"agent_spawned","repo":"alp82/curia","ticket":"106",
      "instance":"curia-106@1785599564043","model":"opus","agent":"curia-106","harness":"claude"}
```

446 legacy `worker` fields and 45 legacy `backend` fields, and none survives the read edge. The file
itself was not touched. It still says `worker_spawned` on line 1 and says `agent_spawned` on the
lines written since, which is the point: a record you rewrite is not a record.

## 2. The wire moved, and the old spellings are gone rather than tolerated

What the deployed code writes into an agent's connection settings, both harnesses:

```
--- claude .mcp.json ---
"url": "http://10.0.1.1:4271/mcp?agent=curia-184&ticket=184",
"headers": { "x-curia-agent-token": "aaaa…" }

--- claude Stop hook ---
curl -s -X POST 'http://10.0.1.1:4271/agent_done?agent=curia-184' \
  -H 'Content-Type: application/json' -H 'x-curia-agent-token: aaaa…' -d @-

--- codex config.toml ---
[mcp_servers.curia]
url = "http://10.0.1.1:4271/mcp?agent=curia-184&ticket=184"
http_headers = { "x-curia-agent-token" = "aaaa…" }
```

What the daemon answers to each old spelling. No aliases, and each refusal is a different one, which
is what says the route, the parameter and the header all moved rather than one of them:

| request | answer |
|---|---|
| `POST /worker_done?agent=curia-184` | **404** — the route is gone |
| `POST /agent_done?agent=curia-184`, no token | **403** `no valid curia agent token for "curia-184"` |
| `POST /agent_done?worker=curia-184` + valid header | **403** `no valid curia agent token for "unknown"` |
| `POST /agent_done?agent=curia-184` + `x-curia-worker-token` | **403** |

Row three is the one worth reading twice. The name is spelled `curia-184` on the request and the
daemon reports `unknown`, because it no longer looks at `?worker=` at all. An agent spawned before
the restart would land exactly there.

The refusals journalled in the new words, directly under the old ones:

```
{"ts":"2026-08-04T20:15:28.164Z","type":"agent_token_refused","agent":"curia-184","path":"/agent_done","from":"loopback","presented":false}
{"ts":"2026-08-04T20:15:28.183Z","type":"agent_token_refused","agent":"unknown","path":"/agent_done","from":"loopback","presented":true}
```

## 3. The image builds from its moved path, under its new name

`deploy/worker/Dockerfile` moved to `deploy/agent/Dockerfile` and `config/curia.yaml` now names
`curia-agent`. Built on the box through the renamed npm script:

```
$ npm run build-agent-image --prefix daemon
Successfully tagged curia-agent:2.1.220-0.146.0-fc78bbbf
built curia-agent:2.1.220-0.146.0-fc78bbbf
```

The digest moved with the Dockerfile's own text, which is the content address working as designed.

## 4. A real agent connects over `?agent=`

The checks above are curia talking to itself. This one is an agent doing it. One dispatch on
[#169](https://github.com/alp82/curia/issues/169), everything real — the container, the token, the
docker bridge gateway:

```
{"type":"dispatch_claimed","ticket":"169","agent":"curia-169","by":"rest","kind":"ticket"}
{"type":"side_channel_ready","agent":"curia-169","ticket":"169","gateway":"10.0.1.1"}
{"type":"agent_spawned","ticket":"169","agent":"curia-169","model":"opus","harness":"claude",
 "sandbox":"docker","image":"curia-agent:2.1.220-0.146.0-fc78bbbf","ports":[9000,9001,9002]}
{"type":"agent_mcp_first","ticket":"169","agent":"curia-169","harness":"claude","model":"opus",
 "since_spawn_ms":3894,"since_ready_ms":null,"state":"spawning"}
{"type":"agent_ready","ticket":"169","agent":"curia-169","model":"opus"}
```

`agent_mcp_first` is the proof. The daemon stamps it only after the [#159](https://github.com/alp82/curia/issues/159)
token gate, so that request carried `?agent=curia-169` and a matching `x-curia-agent-token` — the
whole new wire, written by the daemon and read back from a container. 3894 ms after spawn with
`since_ready_ms: null` sits inside the 2.7–3.7 s band [#194](https://github.com/alp82/curia/issues/194)
measured, so the rename moved no timing.

Cancelled after its handshake rather than left to work the ticket:

```
⚰️ `curia-169` cancelled — session killed, worktree removed, ticket re-frontiered
{"type":"agent_cancelled","ticket":"169","agent":"curia-169","by":"rest","tracked":true}
```

`#169` came back with no assignee, no worktree and no container.

## Not closed, and said so

**The Stop hook was never fired by a real agent.** `/agent_done` is proven to exist, to gate, and to
refuse all three old spellings, and the curl the daemon writes is shown above — but the agent was
cancelled mid-turn, so nothing has posted to it for real since the rename. It is the same host,
port, token header and hex token as the MCP call that did land, which is why this was judged a gap
worth naming rather than one worth holding the ticket open for.

**Attach was not re-checked, because it did not change.** Sessions were already `curia-<n>` and
`bin/curia-attach.sh` whitelists that prefix. The file has no diff.
