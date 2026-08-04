# Live check: the side channel is up before a worker is (#188)

Ticket: [alp82/curia#188](https://github.com/alp82/curia/issues/188), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.net` (docker 20.10.17) on 2026-08-04, from a dev session.

[The first live containerized dispatch](https://github.com/alp82/curia/issues/185) found the
daemon looking for its docker gateway at the one moment it cannot find it, and found a second
fault behind it: a bound listener that ufw dropped every packet of. This ticket settles both,
and the box was in the failing state for the whole check — `docker0` `NO-CARRIER`, no container
on the default bridge, no worker anywhere.

## What the box states before the fix

The daemon deployed at 12:35 logged this and ran on with no side channel at all:

```
WARNING: no container-facing listener (docker's default bridge network states no gateway
address, and no interface on this box sits in its subnet — the daemon has nowhere to listen
for its containers)
```

Measured against that live daemon, from a container:

```
$ docker run --rm --add-host host.docker.internal:host-gateway --entrypoint curl \
    curia-worker:… -sS -m 5 http://host.docker.internal:4271/state
curl: (7) Failed to connect to host.docker.internal port 4271 after 1 ms
```

A **refusal at 1 ms**, not a timeout. So ufw was passing the traffic (fault 2 stayed fixed) and
the daemon was simply not listening. Any dispatch in that window would have run blind.

## The bind was never the problem

The ticket assumed the daemon could not bind until a container held the bridge up. It can:

| Reading, with `docker0` `NO-CARRIER` and nothing attached | Result |
| --- | --- |
| `ip -o link show docker0` | `<NO-CARRIER,BROADCAST,MULTICAST,UP> … state DOWN` |
| `ip -4 -o addr show dev docker0` | `inet 10.0.1.1/24` — the address never left |
| `os.networkInterfaces().docker0` | `undefined` — libuv needs IFF_UP **and** IFF_RUNNING |
| `net.createServer().listen(4271, '10.0.1.1')` | **binds** |
| `ip -4 route show dev docker0` | `10.0.1.0/24 proto kernel scope link src 10.0.1.1 linkdown` |

So only the READ was broken, and the kernel had the answer the whole time. The route states
`src 10.0.1.1`, and a connected UDP socket asks for exactly that: `connect` sends no datagram,
it is a route lookup plus a local bind, and the socket's own address is then the source the
kernel would use toward that subnet.

```
$ node -e 'dgram.createSocket("udp4").connect(9,"10.0.1.2",function(){console.log(this.address())})'
{ address: '10.0.1.1', family: 'IPv4', port: 52303 }
```

One hazard came out of writing the test for it, and it is why the answer is checked rather than
taken: **a box with a default route answers for almost any target.** Ask about a subnet this box
does not route and the kernel replies with the address behind the default route — the box's
public one. Binding the worker routes there would publish them to the internet. So the source
address counts only when it sits inside the subnet that was asked about.

## After the deploy, in the same state

`670ac25`, deployed 14:01, with `docker0` still `NO-CARRIER` and no container on the box:

```
[14:01:47.788Z] curia daemon listening on http://127.0.0.1:4271
[14:01:47.866Z] curia daemon also listening on http://10.0.1.1:4271 — the side channel for claude containers

$ ss -ltn | grep 4271
LISTEN 0 511    10.0.1.1:4271
LISTEN 0 511   127.0.0.1:4271
```

The bind is also lazy now. Boot still tries, and a boot that fails no longer costs the daemon
its side channel for the rest of the run: every sandboxed dispatch binds again, single flight,
and rebinds if the gateway moved.

## A bind is not reachability

#185's fault 2 is the reason this is two checks and not one: the daemon was bound on the gateway
while ufw dropped every packet from the bridge, and the worker's request timed out with nothing
on the host able to see it. Only a request FROM A CONTAINER crosses the path a worker crosses,
so each sandboxed dispatch sends one.

Run against the live daemon, through the deployed module rather than by hand:

```
dockerGateway()          = 10.0.1.1
sourceAddressFor(…)      = 10.0.1.1
probeSideChannel(4271)   = true
probeSideChannel(4999)  THREW: a container cannot reach the daemon: the request timed out,
  so this box drops traffic from the docker bridge — see the ufw rule in docs/deploy.md
```

| Reading | Result |
| --- | --- |
| The probe, over the real path | `{"curia":"curia-side-channel","port":4271}` |
| Cost, three runs | 0.88 s, 0.90 s, 0.91 s |
| Containers left behind | 0 (`--rm`) |
| Journal lines naming `/ping` | 0 |
| `/ping` on loopback | answers the operator too |
| `/ping` with an `Origin` header | refused by the #151 CSRF gate, like every other route |
| Port 4999 (outside the ufw rule) | curl exit **28**, timeout — the rule is narrow, and the drop is named |
| Port 4271 with no listener (measured pre-deploy) | curl exit **7**, refusal |

The two exit codes point at different fixes, so the refusal says them differently: 28 names the
ufw rule in `docs/deploy.md`, 7 says the traffic arrives and the daemon is not listening.

`/ping` is the one container-reachable route that needs no worker token, because the probe runs
before any worker exists and so can carry none. It reads nothing, writes nothing and journals
nothing, and the marker in its answer is what says curia holds the port rather than something
else.

## Not closed, and said so

- **No dispatch has run through the new check on the live daemon.** The check itself is proved
  end to end, and `assertSideChannel` is unit-tested against a refused dispatch, but the next
  containerized dispatch is the first to exercise the path in a real `#prepareContainer`.
- **The probe runs on every sandboxed dispatch**, at about 0.9 s and one throwaway container.
  Judged worth it over caching a success for the daemon's life, because ufw rules, docker
  restarts and bridge changes all happen under a running daemon. The alternative is one line.
- **The refusal costs a claim and a release.** The check sits after the image build, because the
  probe is a container and needs one. A box facing a cold build pays the four minutes before it
  can be told the channel is down.
- **The codex lane is still `sandbox: none`**, so none of this reaches it yet.
