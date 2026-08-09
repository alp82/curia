# The dashboard sidecar image (#249, #260). Secret-free: node plus the
# tailscale CLI — the sidecar asserts its own Serve rule over the host
# tailscaled socket. No credentials on disk or in env.
#
# #263 stands the sidecar itself up; until then compose runs a placeholder.

ARG NODE_VERSION=22.17.1
ARG TAILSCALE_VERSION=v1.98.10

FROM tailscale/tailscale:${TAILSCALE_VERSION} AS tailscale

FROM node:${NODE_VERSION}-bookworm-slim

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale

# HOME for uid 1000 (see daemon Dockerfile).
RUN mkdir -p /home/alp && chown 1000:1000 /home/alp
