# Diagnostics with `curia doctor`

`curia doctor` reads the state of an installed Curia and prints one line per check: the host, the installation root, the operator configuration, the installed release and its provenance, the secret files, the containers, the service, the four integrations, and the Curia app. This page is the reference for the command: what it checks, in what order, how the output reads, what the exit code means, and what it never prints. The lifecycle topics in the operator guide tell you when to run it.

To run it from the installed launcher:

```sh
curia doctor
```

The command takes no options. It runs as you, never as root, and it holds no lifecycle lock, because it changes nothing.

## What the command does and doesn't do

`curia doctor` reruns every check that applies to the current installation, on every run, and keeps no record of any run. Two runs a minute apart can disagree, and the later one is the current state. Nothing it observes is stored, so there is no history to read and nothing to clear.

The command is read-only. It opens the root, reads files, asks Docker Compose for the state of the project, and sends two reads to the service and one to the app on loopback. It doesn't repair what it finds, ask for privileges, retry in the background, or schedule itself. When a check fails, the line under it names one corrective action, and you take that action.

## The checks

The output has nine sections in the order the following table lists. Every check is one line, and a check that isn't `ok` adds one corrective action on the next line.

| Section | Check | What `ok` means | What fails or warns |
|---|---|---|---|
| `host` | The twelve preflight checks of [Supported hosts and preflight checks](supported-hosts.md#the-checks). | The host carries Curia. | The same conditions preflight refuses or warns about. A refused condition is reported as `refused`; the doctor doesn't stop on it. |
| `installation` | `installation` | The root holds an installation record, `versions/<active version>/` is complete, and the launcher exists. | No installation (the action is the bootstrap command), an incomplete version (`curia reinstall`), or a missing launcher (a warning). |
| `configuration` | `operator configuration` | `config/config.yaml` passes the [operator configuration](configuration.md) contract. The line lists the keys it sets. | The contract's exact message: the path, the line, the key, and the rule. An absent file is a warning, because the shipped defaults apply. |
| `release` | The nine checks of [What `curia doctor` verifies](release-manifest.md#what-curia-doctor-verifies). | The retained artifacts verify, the installed files match them, every image is attested, and the registry records provenance for the package. | A missing, malformed, substituted, mismatched, drifted, or unattested artifact. |
| `secrets` | `secret files` | Each of the four [secret files](secrets.md#the-secret-files) is reported as present or absent. | A file that is a symbolic link, that another user owns, or that other users can read. The line names the `chmod` to run. |
| `secrets` | `environment` | No credential key is set in your shell. | A warning that names the key, such as `GH_TOKEN`, and the secret file to use instead. |
| `containers` | `containers` | The five services are `healthy` in `docker compose ps`. | A service that exited, is unhealthy, or is missing from the project fails, with the `docker compose ... logs <service>` command as the action. A service still starting is a warning. |
| `service` | `service` | The service answers `GET /ping` on `127.0.0.1:4271`. | The service doesn't answer. The integrations section is then skipped, and says so. |
| `integrations` | `GitHub`, `Discord`, `Tailscale`, `model provider` | The card is connected on this read, as the service verified it. The line carries the card's own summary. | A failed verification carries the card's failed check and its action, the same text the Setup screen shows. A card that isn't connected yet is a warning that points at **Setup**. |
| `integrations` | `Full loop` | The [Full-loop gate](integration-setup.md#when-setup-is-ready) is ready on this read. A completed [Full-loop run](integration-setup.md#run-full-loop) is a journal record, not a marker, so this line never reads it. | A warning with the gate's reason, such as `Waiting for Discord.` |
| `integrations` | `admitted operator` | The login the service admits, from `state/tailscale.json`. | A warning while no operator is confirmed, because the app then admits the first tailnet identity to **Setup** only. |
| `app` | `Curia app` | The app answers on `127.0.0.1:4273`. The line names the address on your tailnet, `https://<your node's MagicDNS name>:8445/`. | The app doesn't answer, with the `logs dashboard` command as the action. |

The integration checks are the service's own verifications. `curia doctor` asks the running service for `GET /setup`, which runs every card's verifier fresh, so a card that connected once and lost its authority since reads as failed here and on the Setup screen at the same time. Nothing about readiness is on disk to read.

## The output

A run on a host that is below the recommended profile, whose overseer is still starting, and whose Discord bot left the server prints this, with the sections between left out:

```text
host
ok       operator              uid 1000
ok       operating system      Ubuntu 24.04.2 LTS
warning  host capacity         2 CPUs, 8.0 GiB of memory, 40.0 GiB free on /home/you/.local/share/curia is below the recommended profile, so agents may wait on memory or CPU.
                               For comfortable operation give the host 4 CPU cores, 8 GiB of memory, and 30 GiB of free disk.
...

containers
warning  containers  overseer is starting; the rest are healthy.
                     Wait a minute and run curia doctor again. A service still starting after four minutes is one to read the log of: 'docker compose --env-file /home/you/.local/share/curia/run/compose.env -f /home/you/.local/share/curia/versions/1.2.3/bundle/compose.yaml logs overseer'.

integrations
ok       GitHub             🎫 #12 · Add the thing · ready-for-agent · example/app · 3 open tickets
failed   Discord            The bot is not in the selected server.
                            Add the bot to the server with the invite link on the Discord card, then select Try again.
ok       Tailscale          🔒 curia.tail1234.ts.net · you@example.com · admitted in 12 ms
ok       model provider     OpenAI · Routing ready · verification request completed in 2 s
warning  Full loop          Waiting for Discord.
                            Finish setup in the Curia app; Run Full loop enables when every card is connected on one read.
ok       admitted operator  you@example.com

app
ok       Curia app  the app answers on 127.0.0.1:4273; open it at https://curia.tail1234.ts.net:8445/

30 checks passed, 3 warnings, failed: 1 condition.
```

Each line starts with one of four words. The following table lists them.

| Word | Meaning |
|---|---|
| `ok` | The check passed. The rest of the line is what Curia observed. |
| `warning` | A fact that doesn't block. Curia makes no guarantee for what it names. The next line is the corrective action. |
| `failed` | The check found a problem. The next line is the one corrective action. |
| `refused` | A host condition that preflight refuses, such as another operating-system release. `curia install` and `curia update` stop on it. The doctor reports it and continues. |

The last line is the summary: how many checks passed, how many warnings, and how many failed or refused conditions.

## Exit codes

The command uses the four [exit codes](command-reference.md#exit-codes) of every lifecycle command:

| Code | When |
|---|---|
| `0` | Every check passed, or only warnings were found. |
| `1` | At least one check failed or one host condition is refused. The output names each one and its action. |
| `2` | The command line was wrong, such as an option. Nothing ran. |
| `3` | The installation root refused the command before any check ran, as [When a lifecycle command refuses the root](command-reference.md#when-a-lifecycle-command-refuses-the-root) describes. Nothing was checked. |

A script can run `curia doctor` and branch on `0` against the rest. A warning never changes the exit code.

## What the output never carries

`curia doctor` reads no secret value. The secret files are reported by name and presence, through the same presence check the service uses. Every printed line passes through a redaction step that removes anything shaped like a long-lived secret (a Discord bot token, a provider key, a GitHub token, a private key block), a renewable or session token (a bearer, a JWT, an agent or conversation token), or a one-turn value carried as `code=` or `token=`. A value that reaches the doctor inside an error message from the service, from Docker, or from your shell prints as `[redacted]`. Image digests, checksums, and the installation ID are not secrets and print as they are.

When a credential key such as `GH_TOKEN` is set in your shell, the `environment` check names the key and never its value.

## Provenance and the GitHub CLI

The `image provenance` check asks `gh attestation verify` for each of the four image digests, and needs the GitHub CLI logged in to GitHub. When it isn't, the check fails and its action prints the exact command to run once `gh auth login` is done. Nothing else in Curia depends on that login, and `curia install` and `curia update` don't run this check: the doctor is where publication provenance is verified without weakening the verification that runs before activation. The manual commands are in [The release manifest and release verification](release-manifest.md#what-curia-doctor-verifies).

## When to run it

- After `curia install`, to see the whole installation on one screen before you start integration setup.
- When the Curia app doesn't open, a card on the Setup screen fails, or a container shows `unhealthy` in `docker compose -p curia ps`.
- Before you ask for help. The output names the version, the host, and every failed condition, and it carries no secret, so you can share it as it is.
