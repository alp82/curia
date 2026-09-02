# 1. Check prerequisites

Operator guide · [Index](../README.md)

- **Get Curia running:** **1. Check prerequisites (this topic)** · [2. Install Curia](02-install-curia.md) · [3. Connect services](03-connect-services.md) · [4. Run your first Full loop](04-run-your-first-full-loop.md)
- **Run Curia:** [5. Daily operation](05-daily-operation.md) · [6. Check the installation](06-check-the-installation.md)
- **Change the installation:** [7. Update or roll back](07-update-or-roll-back.md) · [8. Migrate the current deployment](08-migrate-the-current-deployment.md) · [9. Uninstall or purge](09-uninstall-or-purge.md)
- **When something fails:** [Troubleshooting](troubleshooting.md)

**Outcome:** A supported host that passes every preflight check, with Tailscale installed and ready to join your tailnet, and the four accounts Curia connects to, ready to sign in.

**Starting state:** A Linux host you can log in to as a user who isn't `root`. Nothing from Curia is on it yet.

**Active operator time:** About 5 minutes when Docker Engine, Docker Compose, and Tailscale are already installed. Installing them from their official pages adds about 10 minutes, which the rehearsals record as host preparation, outside the 30-minute installation budget.

## Confirm the host

Curia installs on Ubuntu 24.04 LTS or Debian 13 on x86-64 and refuses every other release and architecture. There is no force flag. To confirm the system, run:

```sh
cat /etc/os-release
uname -m
```

`PRETTY_NAME` names Ubuntu 24.04 or Debian 13, and `uname -m` prints `x86_64`.

The following table lists the host profile. A host below the minimum is unsupported: installation continues after a warning, and Curia makes no guarantee that it runs well.

| Profile | CPU cores | Memory | Free disk |
|---|---|---|---|
| Minimum | 2 | 4 GiB | 15 GiB |
| Recommended | 4 | 8 GiB | 30 GiB |

Free disk is measured on the file system that holds the installation root, `~/.local/share/curia` by default. The full list of supported systems and the profile are in [Supported hosts and preflight checks](../supported-hosts.md#the-supported-systems).

## Install the host prerequisites

Curia detects and verifies these three and never installs or reconfigures them. Install each one from its official page, as the user who will own the installation:

1. **Docker Engine 24.0 or later**, rootful, from the [Docker Engine install page](https://docs.docker.com/engine/install/). Then put your user in the `docker` group and enable the service at boot:

   ```sh
   sudo usermod -aG docker $USER
   sudo systemctl enable --now docker
   ```

   Log out and in so the group applies.
2. **Docker Compose v2, 2.20 or later**, as the `docker compose` plugin. The Docker Engine install page includes it. Compose v1 (`docker-compose`) is refused.
3. **Tailscale 1.80 or later**, from the [Tailscale Linux download page](https://tailscale.com/download/linux). Don't log the node in: `curia install` joins your tailnet in the next topic and prints the login link on the terminal. Make your user the Tailscale operator, and enable HTTPS certificates for your tailnet under **DNS** in the [Tailscale admin console](https://login.tailscale.com/admin/dns):

   ```sh
   sudo tailscale set --operator=$USER
   ```

   A node that is already logged in is fine too. `curia install` reports its name and never renames it.

Keep the host clock synchronized. Certificate and signature checks fail when the clock is more than five minutes off, so leave `systemd-timesyncd` or another Network Time Protocol client enabled. Both supported systems enable one by default.

Curia needs no public inbound port. It needs outbound HTTPS to the release origins, GitHub, Discord, Tailscale, and the model providers. The full endpoint list for a firewall policy is in [Network](../supported-hosts.md#network).

## Prepare the accounts

Curia connects four services after installation, in the browser. Have an account for each one that can do the following:

| Service | What the account must be able to do |
|---|---|
| GitHub | Create a GitHub App, and install it on every owner whose repositories Curia watches. |
| Discord | Create an application in the developer portal, and add its bot to the server you choose. |
| Tailscale | Enroll this host in your tailnet, use Tailscale Serve, and issue HTTPS certificates. |
| Model provider | Sign in to a ChatGPT subscription (for codex agents) or a Claude subscription (for claude agents and the overseer). One is required. Both are recommended, for fallback and independent review. |

Curia holds no API key. Each provider row signs in through the provider's own device or browser flow, and the credential lands in a file only the service reads.

## What you should see

Run the three verification commands as your own user, without `sudo`:

```sh
docker version
docker compose version
tailscale version
```

`docker version` prints a server section (your user can reach the daemon), `docker compose version` prints a v2 version, and `tailscale version` prints 1.80 or later. `tailscale status` may print `Logged out.`: that's the state `curia install` starts from. You know the sign-in for each of the four accounts.

## If a check fails

Each command names what is missing. The one corrective action for every condition Curia checks is in [The checks](../supported-hosts.md#the-checks): for example, a Docker daemon your user can't reach is `sudo usermod -aG docker $USER` and a new login, and a `tailscale` command that can't reach its daemon is `sudo systemctl start tailscaled`. Do that action and run the same verification command again.

The bootstrap in the next topic runs every one of these checks again as preflight and stops at the first refused condition with the same action, so nothing you miss here changes the host.

## Next

[2. Install Curia](02-install-curia.md).
