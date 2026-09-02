# Release images and the Compose bundle

Every long-running Curia process runs in a container from a published image, and one Compose bundle per release names those images by digest. This page is the reference for what a release ships, what each service is, how each one reports health, and how the containers run as you. The lifecycle topics in the operator guide tell you when to install, update, or roll back; this page tells you what those commands put on the host.

## What a release ships

A Curia release is one version, such as `1.2.3`, made of three kinds of artifact that name each other:

| Artifact | Where it lives | What it is |
|---|---|---|
| Four service images | `ghcr.io/alp82/curia-daemon`, `curia-tmux`, `curia-dashboard`, `curia-overseer` | The Curia service, the tmux runtime (which also serves the attach surface), the Curia app, and the overseer. Each is built once per release from the `release` stage of its Dockerfile and identified by its digest. |
| The Compose bundle | `curia-bundle-<version>.tar.gz` on the GitHub release, unpacked to `versions/<version>/bundle/` in the installation root | One `compose.yaml` that names the four images by exact digest. |
| The digest set | `curia-images-<version>.json` on the GitHub release | The image names and digests the bundle was rendered against, for reading. |
| The release manifest | `curia-manifest-<version>.json` on the GitHub release, and `manifest.json` inside the `@curia-sh/cli` package | The one file that binds the package version, the bundle checksum, the four digests, and the source commit into one release. See [The release manifest and release verification](release-manifest.md). |

The release workflow (`.github/workflows/release-images.yml`) runs when the release tag is created. It pushes each image, records the digest the registry returned, attests the build provenance of that digest, renders the bundle against the four digests, writes the release manifest from the bundle's checksum and the digests, runs the bundle and manifest tests against the rendered files, and attaches the bundle, its SHA-256 checksum (`curia-bundle-<version>.tar.gz.sha256`), the digest set, and the manifest to the release.

The version tag on an image, such as `curia-daemon:1.2.3`, is for browsing the registry. Nothing Curia installs reads a tag: the bundle and the release manifest name images by digest, so `docker pull` gets exactly the bytes the release tested. Before a version is activated, Curia proves that the bundle's digests are the manifest's, as [What Curia verifies before activation](release-manifest.md#what-curia-verifies-before-activation) describes.

Each image carries the checkout at `/opt/curia`: the daemon's code and pinned dependency tree, the lifecycle interface's source, the shipped `curia.yaml` and `routing.yaml`, and, in the service image, the vendored skills and the agent image recipe. The files are root-owned and read-only to the user that runs the container, so an installed version can't drift. The images contain no operator path, no credential, and no state. What a container may see of the installation root is in [Secrets, mounts, and what survives](secrets.md).

The agent image is not a release image. The service builds it on the host from the recipe in the service image and the pins in `curia.yaml`, once per set of pins, and agents start from that content-addressed image.

## The bundle

The bundle is one Compose file and nothing else. It has these properties, and the test suite checks each one on every change:

- **One fixed project name.** The Compose project is `curia`. One host runs one Curia, and `docker compose -p curia ps` lists it.
- **Exact digests.** Every `image:` is `ghcr.io/alp82/<name>@sha256:<digest>`. There is no build stanza and no tag.
- **Labelled resources.** Every container, the Compose network, and the tmux socket volume carry the label `sh.curia.installation=<installation ID>`, the ID from `state/installation.json`. `curia purge` removes Docker resources by that label and never by a name.
- **Health checks.** Every service declares one. See [Health checks](#health-checks).
- **Your numeric user and group.** Every container runs as `<your uid>:<your gid>`, and the two that reach the Docker socket also join the host's `docker` group. Nothing in the bundle or the images assumes user ID 1000.
- **No secret, no env file, no operator path.** The bundle interpolates five values, all paths or numbers, that the lifecycle interface writes into an env file under `run/` when it starts the project: `CURIA_ROOT`, `CURIA_UID`, `CURIA_GID`, `DOCKER_GID`, and `CURIA_INSTALLATION_ID`. Credentials are files under `secrets/`, mounted into the service only.

To read the bundle of the active version:

```sh
cat "$(curia version | sed -n 's/^installation root: //p')/versions/$(curia version | sed -n 's/^active version: //p')/bundle/compose.yaml"
```

## The services

The following table lists the five services, in the order the bundle declares them.

| Service | Image | Network | Role |
|---|---|---|---|
| `daemon` | `curia-daemon` | host | The Curia service: the agent-facing surface on `127.0.0.1:4271`, the timeline on `4272`, the Discord bridge, the journal, and the dispatch loop. It restarts on failure, which is how `POST /restart` works. |
| `tmux` | `curia-tmux` | host | The tmux server that holds every agent pane, parked on a `keeper` session. It lives outside the service's lifecycle, so a service restart never touches a running agent. Stopping it is a deliberate act at zero live agents. |
| `ttyd` | `curia-tmux` | host | The attach surface on `127.0.0.1:7681`, behind the identity proxy. It runs `tmux attach` over the shared socket and holds nothing else. |
| `dashboard` | `curia-dashboard` | host | The Curia app on `127.0.0.1:4273`, published to your tailnet through Tailscale Serve. It reads the service and holds no secret. |
| `overseer` | `curia-overseer` | bridge | The overseer, the one container that holds a shell. It stays off the host network and reaches the service at `host.docker.internal`. The service reaches it on `127.0.0.1:4274`. |

The service and the attach surface wait for a healthy tmux runtime before they start, so a start settles in order.

## Health checks

Each service's health check asks the process the one question that means it is serving. Docker runs the check every 30 seconds with a 5-second timeout, and marks the container unhealthy after three failures in a row. The following table lists them.

| Service | Check | Start period |
|---|---|---|
| `daemon` | `GET http://127.0.0.1:4271/ping` answers. The service answers only after the configuration loaded, the journal opened, and the listener bound. | 60 s |
| `tmux` | `tmux has-session -t keeper` on the shared socket succeeds. | 10 s |
| `ttyd` | `GET http://127.0.0.1:7681/` answers with the attach index. | 10 s |
| `dashboard` | `GET http://127.0.0.1:4273/` answers. A local request carries no Tailscale identity and gets a 403, which still proves the listener; the app exits when it can't bind the port. | 30 s |
| `overseer` | `GET http://127.0.0.1:4274/ping` answers inside the container. | 30 s |

To read the state of every service:

```sh
docker compose -p curia ps
```

A container that shows `unhealthy` is one whose process answers nothing. Read its log with `docker compose -p curia logs <service>`, then run `curia doctor`, which reruns the reachability checks and names the corrective action.

## User and group

The lifecycle interface records your numeric user ID and group ID when it starts the project and passes them to every container as `user: <uid>:<gid>`. Files the containers write under the installation root are yours, and the containers can read what you own. The `daemon` and `tmux` containers also join the host's `docker` group by its numeric ID, because their processes run agent containers through the Docker socket.

The images create no user of their own. A process that looks its user up, such as `tmux`, runs with `HOME` set to `cache/home/` inside the installation root and a default shell of `/bin/sh`, which no pane uses.

## The source deployment

The current source deployment on one box runs `deploy/compose.yaml`, which builds the same Dockerfiles at their `box` stage and mounts the checkout. It doesn't use the bundle. The cutover runbook moves that box onto an installed version.
