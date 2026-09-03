# Supported hosts and preflight checks

Curia runs on one host that you prepare and Curia checks. This page is the reference for the supported systems, the host profile, the prerequisites you install, and the checks that `curia install`, `curia update`, and `curia doctor` run against the host. [1. Check prerequisites](guide/01-check-prerequisites.md) in the operator guide is where you prepare the host; this page is what Curia checks.

## The supported systems

Curia supports these systems:

- Ubuntu 24.04 LTS on x86-64
- Debian 13 on x86-64

Support covers the vendor's patch releases, the vendor kernel, common cloud kernels, and physical, virtual, or cloud hosts. Every other operating-system release, every derivative, and every other architecture is refused. There is no force flag. Curia adds a system to this list only after it tests the complete lifecycle there.

## The host profile

The following table lists the two profiles. A host below the minimum profile is unsupported: installation continues after a warning, and Curia makes no guarantee that it runs well.

| Profile | CPU cores | Memory | Free disk |
|---|---|---|---|
| Minimum | 2 | 4 GiB | 15 GiB |
| Recommended | 4 | 8 GiB | 30 GiB |

Free disk is measured on the file system that holds the installation root. Every new installation runs four agents at once. You can change that number in the Curia app or in `config/config.yaml`; see [Operator configuration](configuration.md). Curia never lowers it on its own.

## The prerequisites you install

Curia detects and verifies these three, and never installs or reconfigures them:

- **Docker Engine**, rootful, running, enabled at boot, with your user in the `docker` group. Oldest tested version: 24.0. Versions older than 20.10 are refused.
- **Docker Compose v2**, as the `docker compose` plugin. Oldest tested version: 2.20. Compose v1 (`docker-compose`) is refused.
- **Tailscale**, installed, with `tailscaled` running. Oldest tested version: 1.80. The node doesn't have to be logged in: `curia install` joins the tailnet in its `tailnet` step and prints the login link. That step also needs your user to be the Tailscale operator and HTTPS certificates to be enabled for the tailnet, and it refuses with the exact command or setting when they aren't. See [The tailnet step](install.md#the-tailnet-step).

A version newer than the tested range produces a warning, not a refusal. A supported host also needs `bash`, `curl`, `tar`, `gzip`, the coreutils checksum tools (`sha256sum`, `sha512sum`, `base64`, `od`), and CA certificates for [the bootstrap](bootstrap.md), and `ss` from `iproute2` for the port check to name a process. All of these ship with both supported systems.

You run every lifecycle command as your own user, never as root. Curia never escalates privileges.

## Network

Curia needs no public inbound port. The Curia app, the terminal, and previews reach you over Tailscale only.

Preflight verifies outbound HTTPS to the three release origins, and nothing else. Each integration step verifies its own destination when you set it up. The following table lists the outbound endpoints a complete installation uses, so you can set firewall policy up front.

| Destination | Used for |
|---|---|
| `registry.npmjs.org` | The lifecycle interface package. |
| `github.com`, `api.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com` | The bootstrap script, the release assets, the stable-release index (`raw.githubusercontent.com`), and the GitHub App. |
| `nodejs.org` | The pinned Node.js runtime and its `SHASUMS256.txt`, downloaded by the bootstrap. |
| `ghcr.io`, `pkg-containers.githubusercontent.com` | The service images. |
| `discord.com`, `gateway.discord.gg` | The Discord bot. |
| `controlplane.tailscale.com`, `login.tailscale.com`, and the DERP relays | Tailscale. |
| `api.anthropic.com`, `api.openai.com`, `chatgpt.com` | The model providers. |

Keep the host clock synchronized. Certificate and signature checks fail when the clock is more than five minutes off, so leave `systemd-timesyncd` or another Network Time Protocol client enabled.

## The local ports

The services bind these loopback ports on the host network: `4272` (the timeline), `4273` (the Curia app), `4274` (the overseer), `7681` (the attach surface), and `7682` (the identity proxy). Agent containers publish into `9000` to `9299`, three ports per agent. Tailscale Serve listens on `8443` to `8445` and `8500` to `8599` on the tailnet side.

## The checks

Preflight runs before `curia install` and `curia update` change anything, and `curia doctor` runs the same checks. Every check prints one line: `ok`, `warning`, or `refused`, the check name, and what Curia observed. A warning or a refusal adds one corrective action on the next line.

A **refused** condition stops `curia install` and `curia update` with exit code `3`. Nothing has changed on the host. Remove the condition and run the command again. `curia doctor` prints the same line, continues with its other checks, and exits with code `1`; see [Diagnostics with `curia doctor`](doctor.md). A **warning** is a fact that doesn't block: the command continues, and Curia makes no lifecycle guarantee for what the warning names.

Preflight may create temporary probe resources: a short-lived listener on each port it tests, one temporary directory, and one probe container named `curia-preflight-<id>` from the `busybox:stable` image. It removes all of them before the command continues, whether the probe passed or failed. The image stays in Docker's image store like any other pulled image.

The following table lists every check, what it can do, the condition it reports, and the corrective action.

| Check | Can | Condition | Corrective action |
|---|---|---|---|
| operator | Refuse | The command runs as root. | Run it as the operator that owns the installation. |
| operating system | Refuse | `/etc/os-release` names a release other than Ubuntu 24.04 or Debian 13, or can't be read. | Install Curia on Ubuntu 24.04 LTS or Debian 13. |
| architecture | Refuse | The processor is not x86-64. | Install Curia on an x86-64 host. |
| host capacity | Warn | CPU, memory, or free disk is below the minimum or the recommended profile. | Give the host the named profile. |
| required ports | Refuse | One of the five loopback ports is held by another program, named when `ss` can see it. | Stop that program or move it to another port. |
| required ports | Refuse | Fewer than 12 ports are free in `9000` to `9299`. | Free at least 12 ports in that range. |
| Docker Engine | Refuse | Docker is not installed. | Install Docker Engine 24.0 or later from the [Docker Engine install page](https://docs.docker.com/engine/install/). |
| Docker Engine | Refuse | Your user can't open `/var/run/docker.sock`. | Run `sudo usermod -aG docker $USER`, then log out and in. |
| Docker Engine | Refuse | The Docker daemon is not running. | Run `sudo systemctl start docker`. |
| Docker Engine | Refuse | Docker Engine is older than 20.10. | Install Docker Engine 24.0 or later. |
| Docker Engine | Warn | Docker runs rootless. | For a supported host, use rootful Docker Engine. |
| Docker Engine | Warn | The `docker` service is not enabled at boot, so Curia doesn't return after a reboot. | Run `sudo systemctl enable docker`. |
| Docker Engine | Warn | Docker Engine is older than 24.0 or newer than major version 29. | Update to the tested range, or watch for behavior changes. |
| Docker capabilities | Refuse | A probe container couldn't read a bind mount from the host, or couldn't reach a listener on the host network. | Fix the Docker Engine installation. |
| Docker Compose | Refuse | `docker compose` is not available, or is Compose v1. | Install the Compose v2 plugin, 2.20 or later. |
| Docker Compose | Warn | Compose is older than 2.20 or newer than major version 5. | Update to the tested range, or watch for behavior changes. |
| Tailscale | Refuse | Tailscale is not installed. | Install Tailscale from the [Tailscale Linux download page](https://tailscale.com/download/linux). |
| Tailscale | Refuse | `tailscaled` is not running. | Run `sudo systemctl start tailscaled`. |
| Tailscale | Warn | Tailscale is older than 1.80 or newer than major version 1. | Update to the tested range, or watch for behavior changes. |
| outbound access | Refuse | One of `registry.npmjs.org`, `github.com`, or `ghcr.io` didn't answer over HTTPS. | Allow outbound HTTPS to the release origins, or fix DNS or the proxy. |
| release verification | Refuse | A release origin's certificate didn't verify. | Run `sudo apt-get install --reinstall ca-certificates` and remove any intercepting proxy. |
| release verification | Refuse | The host clock is more than five minutes from the release origins. | Run `sudo timedatectl set-ntp true` and wait for the clock to sync. |
| Docker socket group | Refuse | No `docker` group exists. The service and tmux containers join it to reach the socket. | Run `sudo groupadd docker`, then `sudo usermod -aG docker $USER`, then log out and in. |

The node's login, the Tailscale operator permission, and the tailnet's HTTPS certificate are not preflight checks. They belong to the `tailnet` step of `curia install`, which logs the node in when it isn't and refuses on the other two with the exact command or setting; `curia reinstall`, `curia update`, and `curia rollback` inspect the same three facts in their `preflight` step and refuse without logging in. See [The tailnet step](install.md#the-tailnet-step).

The unsupported categories that the specification names, such as Windows Subsystem for Linux, nested containers, immutable hosts, hosts without systemd, and rootless Docker, are not refused by name. When every functional check passes, installation continues, with a warning where the check can tell.

## What preflight doesn't check

Preflight checks the host and nothing more. The installation root's ownership and permissions are checked separately, before preflight, as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes. The tailnet is joined and checked after preflight, in the `tailnet` step of `curia install`. Release artifacts are verified when they're downloaded, as [The release manifest and release verification](release-manifest.md) describes. Each integration verifies its own account and connection during setup. `curia doctor` adds the configuration, integration, container, and reachability checks on top of the host checks.
