# Live check: previews flow through published container ports (#157)

Ticket: [alp82/curia#157](https://github.com/alp82/curia/issues/157), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the dev workstation
`alppc` (docker 29.6.2) on 2026-08-04, with the docker half re-measured on the deployment box
`coinmatica.net` (docker 20.10.17). The live daemon was not restarted.

The check drives the daemon's own `PreviewRegistry.publish` and `containerPorts` against a real
container, a real `tailscale serve` rule and a real HTTPS request. One rule was published on
`alppc` and withdrawn at the end of each run.

## 1. The probe stopped measuring liveness

The bare path refuses a dev port that nothing answers on. On a published port that refusal cannot
fire, because docker binds the host port for the container's whole life.

A container publishing 9401 with **nothing listening inside**, probed with the daemon's own
`localhostTarget`:

```
$ docker run -d --rm -p 127.0.0.1:9401:9401 --name curia-porttest alpine sleep 120
$ node -e 'localhostTarget(9401)'
{"port":9401,"target":"127.0.0.1"}

$ ss -ltn | grep 9401
LISTEN 0 4096 127.0.0.1:9401 0.0.0.0:*
$ ps aux | grep docker-proxy
root /usr/bin/docker-proxy -proto tcp -host-ip 127.0.0.1 -host-port 9401 -container-ip 172.17.0.3 …
```

The listener is `docker-proxy`, not the worker. The same container on the box:

```
coinmatica $ ss -ltn | grep 9401
LISTEN 0 4096 127.0.0.1:9401 0.0.0.0:*
coinmatica $ python3 -c 'socket().connect(("127.0.0.1", 9401))'
connect: OK (docker-proxy answered)
```

Both docker versions answer the probe with nothing behind it. So the probe is not a weaker check
here, it is a false one, and the allocation replaces it.

## 2. A `localhost` bind inside the container is unreachable

The failure the prompt exists to prevent. A server on `127.0.0.1:9401` **inside** the container:

```
$ docker exec curia-porttest netstat -ltn
tcp 0 0 127.0.0.1:9401 0.0.0.0:* LISTEN

$ curl http://127.0.0.1:9401/
curl: (56) Recv failure: Connection reset by peer
```

`docker-proxy` accepts and then resets, so the daemon still cannot tell. Published through a real
Serve rule, the human is the one who sees it:

```
publish(9401) -> https://alppc.tail3b99f1.ts.net:8500/
GET  https://alppc.tail3b99f1.ts.net:8500/ -> 502 Bad Gateway
```

The same server bound `0.0.0.0` is reachable at once:

```
$ docker exec curia-157-check netstat -ltn
tcp 0 0 0.0.0.0:9402 0.0.0.0:* LISTEN
$ curl http://127.0.0.1:9402/
<h1>curia 157: served from inside the container</h1>
```

## 3. End to end, through the real registry

A container publishing 9401-9403 and serving a page on 9402, read and published by the daemon's
own code:

```
containerPorts(curia-157-check) = [9401,9402,9403]

publish(3000)  -> {"ok":false,"reason":"port 3000 is not one of your published ports
                   (9401, 9402, 9403) — your dev server runs inside a container, and those are the
                   only ports this box can reach it on. Bind it to 0.0.0.0 on one of them, then
                   publish that port"}

publish(9402)  -> {"ok":true,"servePort":8500,"devPort":9402,"target":"127.0.0.1",
                   "path":"/curia-check","url":"https://alppc.tail3b99f1.ts.net:8500/curia-check"}

GET https://alppc.tail3b99f1.ts.net:8500/curia-check -> 200 OK
body: "<h1>curia 157: served from inside the container</h1>"

withdraw -> {"ok":true,"withdrawn":true,"servePort":8500}
```

A refused port writes no rule. The path suffix reaches the container unchanged. `tailscale serve
status` after the run holds no rule in 8500-8599.

## 4. `docker inspect` states the same shape on both versions

The read the daemon rebuilds an adopted worker's bound from:

```
alppc      $ docker inspect curia-porttest --format '{{json .NetworkSettings.Ports}}'
{"9401/tcp":[{"HostIp":"127.0.0.1","HostPort":"9401"}]}

coinmatica $ docker inspect curia-porttest --format '{{json .NetworkSettings.Ports}}'
{"9401/tcp":[{"HostIp":"127.0.0.1","HostPort":"9401"}],"9402/tcp":[{"HostIp":"127.0.0.1","HostPort":"9402"}]}
```

## What this check does not cover

Nothing has been dispatched through the live daemon with `sandbox: docker` on. The claude lane
flips in this ticket and the box gets it at the next restart, so the first real containerized
dispatch is its own check.
