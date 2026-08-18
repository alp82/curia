# A browser terminal inside the dashboard

Date: 2026-08-18. Ticket: [A browser terminal inside the dashboard](https://github.com/alp82/curia/issues/536).

Sources: Curia source, official upstream source and documentation, and one local ttyd 1.7.7 check. No secondary source contributed a claim.

## Answer

A fit exists. [The embedded terminal](https://github.com/alp82/curia/issues/537) should keep ttyd and use the dashboard's existing Serve rule.

The dashboard terminal should use a same-origin `/terminal/` route and a terminal subpage. Port 8443 can retire after the prototype passes.

The prototype should not replace ttyd with a custom xterm.js relay. It should not use tmux control mode.

All three paths keep tmux's one-window geometry limit. The chat remains the surface for two devices with different widths.

## Current boundary

The dashboard sidecar listens on loopback port 4273. Tailscale Serve publishes it on port 8445.

The sidecar applies the shared identity check to every HTTP request. The check uses `Host`, `Tailscale-User-Login`, and the Funnel marker.

[Tailscale documents](https://tailscale.com/docs/features/tailscale-serve#identity-headers) that Serve adds identity headers and removes client copies. It recommends a loopback backend.

The [identity decision](../adr/0011-tailscale-identity-in-front-of-every-attach-surface.md) requires this check on reads and writes. It also requires a fail-closed result.

The current sidecar has no WebSocket upgrade handler. Its [chat proxy](../../daemon/src/dashboard.mjs) only handles ordinary HTTP requests and streams.

Current ttyd listens on loopback port 7681. The [compose command](../../deploy/compose.yaml) keeps `-W`, `-a`, `-O`, and the wrapper.

The daemon runs a separate identity proxy on port 7682. Serve port 8443 points at that proxy today.

The dashboard Serve rule verifies the dashboard listener and page. A failed terminal backend must not withdraw the whole dashboard.

Instead, the terminal route must refuse its request. The dashboard and its other routes must stay available.

## Comparison

| Path | Identity behind Serve | Geometry cost | Curia must run | Verdict |
|---|---|---|---|---|
| Embedded ttyd | The dashboard sidecar checks HTTP and WebSocket requests. ttyd keeps its origin check. | The embedded viewport sets one attached tmux client's size. Other clients still share one tmux window size. | The existing tmux and ttyd services. The sidecar adds an HTTP and WebSocket proxy. | Prototype this path. |
| Custom xterm.js relay | The dashboard sidecar checks the WebSocket upgrade and its origin. | xterm.js fits its element. A custom resize message still changes one attached tmux client. | An xterm.js bundle, a WebSocket server, a PTY relay, and one `tmux attach` child per connection. | It duplicates ttyd without a geometry gain. |
| tmux control mode relay | The dashboard sidecar checks the WebSocket upgrade and its origin. | `refresh-client -C` changes the same shared tmux window size. Omitting it causes crop or padding. | An xterm.js bundle, a WebSocket server, a control-mode parser, and one tmux control client per connection. | It adds a protocol and loses tmux-rendered modes. |

## Embedded ttyd

### Identity

The target request path is:

```text
browser -> Serve :8445 -> dashboard sidecar :4273 -> ttyd :7681
                                                    -> curia-attach.sh -> tmux
```

The dashboard sidecar must check the identity before it opens an upstream connection. This check must cover the page and the WebSocket upgrade.

The sidecar must also check the upgrade `Origin`. The [xterm.js security guide](https://xtermjs.org/docs/guides/security/#3-websockets) requires secure transport, authentication, and authorization.

The dashboard already supplies secure transport. Its identity check supplies authentication and authorization.

ttyd should keep `-O` behind the sidecar. Its [source compares `Origin` with `Host`](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/protocol.c#L50-L70) during the WebSocket upgrade.

The sidecar should forward `Host` and `Origin` unchanged. A same-origin dashboard request then passes ttyd's check.

ttyd's `-H` option is not an allowlist. The [HTTP check only tests header presence](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/http.c#L28-L43).

The WebSocket check has the [same presence rule](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/protocol.c#L183-L195). The prototype must not use `-H` as the identity check.

Use ttyd's `-b /terminal` option. ttyd documents this option for a [reverse-proxy base path](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/README.md#L67-L88).

The [server builds its page and WebSocket endpoints from that base](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/server.c#L443-L454). The session stays in `?arg=curia-<n>`.

An iframe can separate ttyd's document from the dashboard layout. It is a layout boundary, not an identity boundary.

### Geometry

ttyd creates one PTY process for each WebSocket. Its [server starts that process with the browser's rows and columns](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/protocol.c#L328-L350).

The ttyd client fits xterm.js to its container. It [sends each resize to the server](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/html/src/components/terminal/xterm/index.ts#L150-L197).

The server [resizes the PTY](https://github.com/tsl0922/ttyd/blob/40e79c706be14029b391f369bee6613c31667abb/src/protocol.c#L307-L321). That PTY runs `tmux attach`, so tmux sees one attached client.

Dashboard chrome reduces the available rows and columns. A full-height terminal route limits this cost.

The dashboard must remove the iframe when the terminal closes. A hidden attached client can keep an old size in tmux.

A second terminal client can still resize the shared tmux window. The [existing geometry research](dual-geometry-attach.md) proves this limit.

This path changes the terminal's location, not its geometry contract. One device gets a correct grid, and chat serves mixed device sizes.

### Runtime

The tmux service stays unchanged. The ttyd service stays loopback-only and keeps the wrapper and current built page.

The dashboard sidecar adds one terminal proxy. It must proxy ordinary HTTP and WebSocket upgrades without buffering terminal output.

The sidecar needs a separate `upgrade` handler. [Node handles an upgraded socket outside the regular request handler](https://nodejs.org/docs/latest-v24.x/api/http.html#event-upgrade).

A local ttyd 1.7.7 check used `-b /terminal`. `/terminal/` returned 200, and `/` returned 404.

ttyd declared `/terminal/ws` as its WebSocket endpoint. This confirms that the base path covers both protocol parts.

The daemon can stop the terminal identity proxy after the prototype passes. It can also stop its Serve port 8443 reconcile work.

If ttyd stops, the terminal route must return an error. The dashboard Serve rule must remain because the dashboard listener stays verified.

The terminal still survives a daemon restart. The dashboard sidecar, ttyd service, and tmux service already have separate lifecycles.

## Custom xterm.js relay

### Identity

The browser opens a same-origin WebSocket under the dashboard address. The sidecar must apply the identity check during the upgrade.

The sidecar must also require a same-origin `Origin`. The [xterm.js security guide](https://xtermjs.org/docs/guides/security/#3-websockets) states this browser limit.

xterm.js adds no server identity mechanism. It only renders a terminal and connects input and output.

### Geometry

The [fit addon](https://github.com/xtermjs/xterm.js/blob/29a738423349b75d40732f4cd12a5a0326e03fed/addons/addon-fit/typings/addon-fit.d.ts#L8-L54) computes rows and columns from the container. It does not resize a server process.

The [attach addon](https://github.com/xtermjs/xterm.js/blob/29a738423349b75d40732f4cd12a5a0326e03fed/addons/addon-attach/src/AttachAddon.ts#L15-L83) only copies WebSocket data between xterm.js and a process. It has no resize protocol.

Curia must define a resize message and apply it to the PTY. A `tmux attach` process then changes the shared tmux window size.

An ignored resize avoids geometry changes but crops or pads the browser terminal. This option cannot give two fitted grids.

### Runtime

xterm.js is only the browser terminal. Its [README places a PTY API behind it](https://github.com/xtermjs/xterm.js/blob/29a738423349b75d40732f4cd12a5a0326e03fed/README.md#L33-L46).

A practical Node server needs a PTY library such as node-pty. The [node-pty API](https://github.com/microsoft/node-pty/blob/56c6ac3b8abd523f09749a0ade9c69cd35e7d514/README.md) supports spawn, read, write, and resize.

Curia must also define framing, flow control, reconnect behavior, cleanup, and resize messages. ttyd already supplies these functions.

The daemon should host this relay because it already has the tmux socket. The secret-free dashboard sidecar does not have that socket.

This choice disconnects the terminal during a daemon restart. Moving the tmux socket into the sidecar would widen that process's authority.

## tmux control mode relay

### Identity

The browser still needs xterm.js and a same-origin WebSocket. The sidecar must apply the same upgrade identity and origin checks.

Control mode changes the server transport only. It does not change the Serve identity story.

### Geometry

tmux control mode uses a text protocol over standard input and output. The [tmux manual defines its command blocks and notifications](https://github.com/tmux/tmux/blob/e5a2058c7ca350cda9436720b4e76a2224b8681f/tmux.1#L9006-L9048).

The relay can set its client size with `refresh-client -C`. The [manual defines one width and height for that control client](https://github.com/tmux/tmux/blob/e5a2058c7ca350cda9436720b4e76a2224b8681f/tmux.1#L1485-L1496).

That client still contributes one size to the shared tmux window. Control mode does not create a second pane rendering.

If the relay omits the size command, the browser must show the current grid. A different container size then causes crop or padding.

### Runtime

The daemon must start `tmux -CC attach-session` for each browser connection. It must keep each child alive until that connection closes.

The daemon must parse command blocks, notifications, pane IDs, and octal escapes. The [`%output` format](https://github.com/tmux/tmux/blob/e5a2058c7ca350cda9436720b4e76a2224b8681f/tmux.1#L9101-L9108) requires this decoding.

The daemon must translate browser input into tmux commands. It must also correlate replies with commands while notifications arrive.

Flow control adds pause, continue, and screen recovery. The [control-mode documentation](https://github.com/tmux/tmux/wiki/Control-Mode#flow-control) requires the client to recover paused pane content.

Control mode omits output that tmux draws for copy and choose modes. The [official documentation states this limit](https://github.com/tmux/tmux/wiki/Control-Mode#pane-output).

This fidelity gap conflicts with the terminal's job as the raw TUI. A reconnect also needs an initial screen reconstruction path.

Control mode removes the PTY relay and ttyd service. It replaces them with a larger Curia protocol implementation.

## Prototype shape

The prototype should use this route:

```text
GET /terminal/?arg=curia-537
WS  /terminal/ws?arg=curia-537
```

The dashboard terminal screen should embed the GET route. The sidecar should proxy both routes to ttyd with unchanged request headers.

ttyd should start with `-b /terminal`. Its other current security and session-selection flags should remain.

The prototype should prove these facts:

1. The dashboard address serves the terminal without port 8443.
2. The sidecar refuses an upgrade with no allowed Tailscale identity.
3. The sidecar refuses a cross-origin upgrade from an allowed browser.
4. The wrapper accepts a valid `curia-<n>` session and refuses any other command.
5. Input, paste, touch keys, native dialogs, and reconnect still work.
6. A container resize reaches ttyd and tmux without a blank terminal.
7. A daemon restart leaves the terminal connection available.
8. The old Serve rule stays until the human approves the prototype.

The prototype does not need a new terminal protocol. It tests one new boundary, the dashboard's same-origin WebSocket proxy.
