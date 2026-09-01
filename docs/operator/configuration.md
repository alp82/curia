# Operator configuration

`config/config.yaml` inside the installation root is the one file that holds your operator configuration: how many agents run at once, whether Curia dispatches on its own, and which repositories it watches. This page is the reference for that file. The lifecycle topics in the operator guide tell you when to change a setting and what to check afterwards.

Three things write the file, and they all check it the same way:

- You, with a text editor. Curia reads the file when the service starts and when you save from the Curia app.
- The Curia app, from the settings screen. It validates the file before it writes it.
- `curia install`, once, into a fresh installation root.

The file holds operator intent and nothing else. Generated state lives in `state/`, release metadata in the release manifest, and credentials in `secrets/`. None of those ever appears in `config/config.yaml`, and Curia refuses a key it doesn't know.

## The keys

Every key is optional. A key you leave out takes Curia's shipped default. The following table lists the keys in the order the file carries them.

| Key | Accepts | Meaning |
|---|---|---|
| `max_concurrent` | A positive whole number. | How many agents may run at once. `curia install` writes `4`. An agent that waits for your review keeps its slot until the review ends. |
| `auto_dispatch` | `true` or `false`. | Whether Curia starts tickets on its own. The shipped default is `false`, so Curia starts a ticket only when you ask. |
| `poll_interval_s` | A positive number of seconds. | How often Curia reads the watched repositories for tickets to start. |
| `prototype_variations` | A positive whole number. | How many variations a prototype ticket produces in one round. |
| `messages_per_send` | A whole number from 1 through 4. | How many Discord messages one send may carry. |
| `live_pane_cap` | A positive whole number. | How many overseer conversations may hold a live terminal pane at once. Separate from `max_concurrent`, which counts agents. |
| `watch` | A list of `repo` entries, each with an optional `mode`. | The repositories Curia dispatches against. `repo` is `owner/name`. `mode` is `auto`, `map`, or `ready-for-agent`, and `auto` is the default. |

Curia checks the file as a whole, not only key by key. For example, the sandbox port range has to hold three ports for every concurrent agent, so a `max_concurrent` that the range can't serve is refused even though the number itself is valid.

## The file

A fresh installation writes this file, and nothing more:

```yaml
# Curia operator configuration.
# ...
max_concurrent: 4
```

A file with every key set looks like this:

```yaml
max_concurrent: 4
auto_dispatch: false
poll_interval_s: 60
prototype_variations: 5
messages_per_send: 4
live_pane_cap: 3
watch:
  - repo: example/app
  - repo: example/roadmap
    mode: map
```

Curia reads a plain subset of YAML: one `key: value` per line, comments after `#`, and the `watch` list as `- repo: owner/name` entries with an indented `mode` line. Anchors, flow collections such as `[a, b]`, and multi-line values are refused with a message that names the line. Indent with spaces, not tabs.

When you save from the Curia app, the app rewrites the whole file with the keys it holds plus the keys you changed. It keeps your settings and drops your comments. If you keep notes about your configuration, keep them outside this file.

## Direct edits

To change a setting by hand, edit `config/config.yaml` and save it. Then either:

- Save any setting from the Curia app, which asks the running service to reload the file, or
- Restart the service, which reads the file when it starts.

If the file is invalid, the running service rejects the reload, keeps the configuration it already loaded in memory, and reports the exact error: the path, the line, the key, and the rule the value broke. The Curia app shows that error on the settings screen and draws the shipped defaults in place of the file's values until you fix the file. Curia never rewrites your edit into a different meaning.

After a restart there's no loaded configuration to keep. An invalid file stops the service from starting, and the service prints the same diagnostic. `curia doctor` reports it too. Fix or revert the file, then start the service again.

## Writes are atomic

Every write of `config/config.yaml`, whether from the Curia app or from a lifecycle command, checks the whole configuration first and then writes a temporary file beside the target and renames it into place in one step. A reader sees the old file or the new one, never a half-written one. The file is owned by you with mode `0600`.

Two saves that race each other both land whole, and the later one wins. A lifecycle command additionally holds the [lifecycle lock](command-reference.md#the-lifecycle-lock) while it writes.

## Where the file lives across the lifecycle

The file lives in `config/`, one of the preserved directories of the [installation root](command-reference.md#the-installation-root). Update, reinstall, rollback, and ordinary uninstall keep it. Only `curia purge` removes it.
