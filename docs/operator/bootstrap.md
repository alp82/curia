# The bootstrap

The bootstrap is one Bash script, `curia-install.sh`, that puts a verified Curia on a supported host that has no Node.js, or removes one. This page is the reference for the command, what the script downloads and proves before it runs anything, why it stops, and its purge mode. The lifecycle topics in the operator guide tell you when to run it; this page tells you what it does.

## The command

Download the script to a file, then run it as the user that will own the installation:

```sh
curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh
```

That's the whole installation command. Don't pipe `curl` into `bash`: the script refuses to run from a pipe, because it can't check that a piped copy downloaded completely. Downloading it to a file first is what lets it check, and it's also what lets `curia purge` ask you for confirmation on your terminal.

The script takes the following options.

| Option | What it does |
|---|---|
| `--root <dir>` | Installs into, or purges, this installation root instead of the default. The root must be an absolute path. It's written into the launcher, so you pass it here once and never again. The default follows [The installation root](command-reference.md#the-installation-root): `CURIA_ROOT`, else `$XDG_DATA_HOME/curia`, else `~/.local/share/curia`. |
| `--version <version>` | Installs an exact published version instead of the stable release the signed index names. A withdrawn version is refused. |
| `--prerelease` | Allows `--version` to name a prerelease, which is never selected otherwise. |
| `--purge` | Purge mode. See [Purge mode](#purge-mode). |
| `--help` | Prints the options and exit codes. |

The script is published with every release, under its one fixed name, so `releases/latest/download/curia-install.sh` is always the current one. It doesn't pin a Curia version: which version it installs comes from the stable-release index, as [How a version is selected](command-reference.md#how-a-version-is-selected) describes. Its own version is stamped inside, and it prints it first, so a support question can name the bootstrap that ran.

## What the bootstrap does

The script runs one linear sequence and prints each step. Nothing runs until everything is downloaded, and nothing is installed until everything is proven.

1. **Checks itself and the host.** The file must end with its completion marker, or the download was cut short. The script must not run as root. The host must be Linux on x86_64 with `curl`, `tar`, `gzip`, and the coreutils checksum tools on the path. Everything else about the host is checked by the lifecycle interface's own preflight, which runs after the hand-off; see [Supported hosts and preflight checks](supported-hosts.md).
2. **Selects the version.** It downloads the stable-release index and reads the stable release from it, or takes the version you passed. At this point the index is a hint: the signature is verified in step 5, by code that carries the key.
3. **Downloads everything into one temporary stage.** From the npm registry: the registry's record of `@curia-sh/cli@<version>` and the package tarball, at the registry's fixed tarball address, never at an address read from a download. From nodejs.org: `SHASUMS256.txt` for the Node.js version the package pins and the Linux x64 tarball. From the GitHub release: the Compose bundle, its `.sha256` file, and the release manifest. Each file lands under a temporary name and is renamed only when `curl` reports a complete transfer, so a partial file is never read as a whole one. The stage lives under `$TMPDIR` (`/tmp` by default) and is removed when the script exits, whatever happens.
4. **Proves the downloads in the shell.** The tarball's SHA-512 must equal the integrity value the registry records. The package's `package.json` must name the selected version. The Node.js tarball's SHA-256 must equal the one `SHASUMS256.txt` lists for it. The bundle's SHA-256 must equal both its `.sha256` file and the checksum the release manifest binds, and the manifest must be for the selected version. Then the runtime is unpacked, and `node --version` must report the pinned version.
5. **Has the staged lifecycle interface prove the rest.** On the staged runtime, the staged package's own code verifies the stable-release index against the key the package ships, selects the version again and requires it to be the one staged, and runs every check in [What Curia verifies before activation](release-manifest.md#what-curia-verifies-before-activation): the manifest, the version, the package integrity, the bundle checksum, the image digests, and the release copy of the manifest. It reads the files already on disk and reaches no network.
6. **Hands off.** It runs `curia install` (or `curia purge`) from the stage, on the staged runtime, with `CURIA_ROOT` set to the root and, for an installation, `CURIA_STAGE` set to the stage. The lifecycle interface owns the root, the record, the launcher, and every confirmation from there. The script exits with the interface's own exit code. What `curia install` does from the hand-off to a running Curia is in [Install and reinstall](install.md).

The stage holds the unpacked runtime at `node/` and the unpacked package at `cli/`, plus the retained `cli.tgz`, `bundle.tar.gz`, and `bundle.tar.gz.sha256`, the same names an installed version keeps under `versions/<version>/`, so `curia doctor` can re-verify them later.

## When the bootstrap refuses

A refusal exits with code `3`, prints the condition and one corrective action, and leaves nothing behind: no root is created, no launcher is written, and the stage is removed. The exit codes are the lifecycle interface's, listed in [Exit codes](command-reference.md#exit-codes). The following conditions are refused.

| Condition | What you see | What to do |
|---|---|---|
| Root execution | `this script runs as root` | Run it as your own user, without `sudo`. There is no force flag. |
| A pipe or an incomplete file | `running from a pipe`, or `is incomplete` | Download the script to a file with the command above and run it again. |
| An unsupported host | The operating system, the architecture, or a missing tool is named. | Curia publishes artifacts for Linux on x86_64 only. Install the named tool. |
| An interrupted download | `the download of <file> was interrupted` | Run the script again. Nothing was unpacked. |
| A missing artifact | `<file> is not at <URL>` | The version isn't published there. Check the version, and check outbound access to the origin. |
| A substituted or damaged artifact | `package integrity`, `bundle checksum`, or `Node.js <version> checksum` | Don't use the download. Run the script again; if it repeats, report it at the Curia repository. |
| A version mismatch | `version mismatch`, or the interface's `version` check | The package, the manifest, or the runtime names another version than the one selected. The release is inconsistent; report it. |
| A withdrawn version, an unsigned or foreign-signed index, or no stable release | The interface's own message | Withdrawal and the index are described in [Releases, the stable-release index, and version selection](releases.md). |
| A relative root, or a root with a single quote in it | `must be an absolute path`, or `must not contain a single quote` | Pass an absolute path. |

A failure (exit code `1`) after the hand-off belongs to the lifecycle interface, whose message says what to do next.

## Purge mode

`bash curia-install.sh --purge` removes one installation without installing anything, for a host where the launcher is gone or the installed version can't run. It's the bootstrap's one other job:

```sh
bash curia-install.sh --purge --root /srv/curia
```

The script acquires and proves the lifecycle interface exactly as an installation does, in a temporary stage, and then runs `curia purge` from it with `CURIA_ROOT` set to the root. `curia purge` shows the root, asks for the one confirmation, and removes the installation root and every Docker resource that carries the installation's label, as [Commands](command-reference.md#commands) describes. The script writes no launcher, creates no root, and removes the stage when the interface returns. A nondefault root stays explicit in the command: with no `--root`, the default root is purged.

## Origins

The bootstrap reads from four origins, all over HTTPS with certificate verification: `registry.npmjs.org` (the package and its integrity record), `nodejs.org` (the runtime and its checksums), `github.com` with `objects.githubusercontent.com` (the release assets), and `raw.githubusercontent.com` (the stable-release index). They're listed with the rest of an installation's outbound endpoints in [Network](supported-hosts.md#network).

The environment variables `CURIA_BOOTSTRAP_NPM_REGISTRY`, `CURIA_BOOTSTRAP_RELEASE_DOWNLOADS`, `CURIA_BOOTSTRAP_NODE_DIST`, and `CURIA_BOOTSTRAP_STABLE_INDEX_URL` point the script at other origins. They exist so the test suite can run the script against a local artifact server, and they work for a mirror. Every check still applies, and the script prints the origins it was pointed at, so a substituted origin is never silent.
