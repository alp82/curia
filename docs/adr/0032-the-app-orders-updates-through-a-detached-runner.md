# ADR-0032: The app orders updates through a detached runner

**Status**: accepted (2026-09).
**Provenance**: Operator request to check and install updates from Settings without SSH.

## Context

The Settings Update section reports versions but requires the operator to run a host command. Running that command in the service container would kill the updater when it replaces the service. The app holds no installation mounts or Docker socket.

## Decision

- Settings shows installed and recommended stable versions, their release notes, and the last verification result. **Check for updates** reads the signed index immediately. Discovery never installs anything.
- **Update to <version>** is an explicit operator action. The service verifies the signed index again and accepts only its newer recommended version. The existing identity and same-origin checks protect both writes. The browser cannot supply an image, command, path, or operator identity.
- The service records the request and starts one detached sibling on the installed release's immutable daemon image. It runs as the installation owner, with the Docker socket group, without added capabilities. It invokes the installed CLI's existing update implementation. Acquisition, verification, configuration validation, switching, acceptance, and rollback remain the CLI's responsibility.
- The helper mounts the installation root at its host path, the Docker and Tailscale sockets, and host OS and identity files read-only. Host networking supports the existing loopback checks. The host PID namespace makes the lifecycle lock agree with a simultaneous host CLI invocation. Temporary mount probes live inside the installation cache.
- A fixed container name prevents concurrent helpers. Request IDs make repeated submissions idempotent. The CLI lifecycle lock prevents overlapping lifecycle mutations.
- `state/update-run.json` records the selected versions, operator, current step, and outcome. The helper writes it atomically at mode `0600`. Diagnostics stay in `state/update.log`; the browser receives step names and bounded failure messages. A replacement service reads the same record. Missing helpers become interrupted failures; an unavailable Docker daemon remains an unknown observation.
- The UI polls while the panel is visible and reconnects during the switch. An accepted request is not success. Success requires the target to become the active installed version after CLI acceptance.

## Consequences

An operator can update an installed Curia without SSH once this capability is installed. An older installation needs one CLI update to receive it. Source deployments continue using their source deployment flow. Rollback remains available through the CLI. The updater has write access to the installation root for the duration of the explicit update; the app's mounts remain unchanged.
