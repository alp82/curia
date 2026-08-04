# Live check: what journalctl drops, and why (#190)

Ticket: [alp82/curia#190](https://github.com/alp82/curia/issues/190), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.net` (Ubuntu 20.04, systemd 245.4) on 2026-08-04, from a dev session.

**Result: the ticket's premise is refuted, and a different fault under it is fixed.** The
daemon's warnings already reached journalctl as words. What did not reach it was the
streamed `docker build` output — 64 lines during the first containerized dispatch
([#185](https://github.com/alp82/curia/issues/185)).

## The premise, measured

The ticket said the em dash hides a message, because the box locale is not UTF-8. Both
halves are wrong, and the journal that carried the evidence also carries the refutation.

| Claim | Reading on the box |
| --- | --- |
| The box locale is not UTF-8 | `/etc/default/locale` states `LANG=en_US.UTF-8` |
| The daemon inherits a non-UTF-8 locale | `/proc/<MainPID>/environ` states `LANG=en_US.UTF-8` |
| The warning never reached the log | `journalctl -u curia` shows it in full, at both boots (09:53:08 and 10:37:39), em dash intact |
| The `[433B blob data]` line at 09:53:08 was the warning | The 433 B blobs are at 09:57:30, 09:57:33 and 09:58:42, and each decodes to `(Reading database ... 5%` with carriage returns |
| The `#179` notify lines all hid | Those lines are `[image curia-179] …` — the image build stream, not notify lines |

A `LANG=` line on the unit file would have changed nothing.

Six messages logged through `systemd-cat` settle the rule directly. A short ASCII line, a
short line with an em dash, a 433-byte ASCII line and a 433-byte line with an em dash all
print under `journalctl -o short`. Neither length nor non-ASCII hides a message.

## The real rule

`shall_print` in systemd's `logs-show.c` calls `utf8_is_printable`, and one **control code
point** anywhere in the message renders the whole line `[NNNB blob data]`. Control means C0
except tab and newline, plus DEL and C1 (U+007F-U+009F). Valid UTF-8 above that is
printable, so the daemon's prose keeps the punctuation its writing rules ask for.

Every blob in the journal agrees. Of 64:

- **55 carry ESC** — `\x1b[91m` and `\x1b[0m`, the builder's color.
- **9 carry a carriage return** — `apt` redrawing `(Reading database ... N%` in place.
- **0 are explained by the em dash or by length.**

## The fix, replayed on the box

`readable()` strips ANSI sequences and control code points, applied at the one `log()`
every module is handed. `lastFrame()` collapses a carriage-return redraw at the **stream**,
where the line still has no `[image <session>]` prefix in front of its first frame.

The box was deployed to `28606a4` and restarted. Every dark line in the journal was then
replayed through the **deployed** module, along the real path (`image.mjs` feed →
`dispatch.mjs` prefix → `index.mjs` log), written back with `systemd-cat`, and read with the
box's own `journalctl`:

```
dark lines in the journal: 64
dropped as empty after the color went: 27
replayed: 37
blob lines on read-back: 0
```

```
Aug 04 12:35:59 coinmatica curia190[3068666]: [image curia-179] + apt-get update
Aug 04 12:35:59 coinmatica curia190[3068666]: [image curia-179] debconf: delaying package configuration, since apt-utils is not installed
Aug 04 12:35:59 coinmatica curia190[3068666]: [image curia-179] (Reading database ... 6096 files and directories currently installed.)
```

The 27 dropped lines were bare `\x1b[0m` color resets. Once the color is gone they say
nothing, so the stream reader does not emit them at all.

The daemon's own boot after the deploy carries no blob, and the `→` in
`attach identity proxy on http://127.0.0.1:7682 → ttyd :7681` prints as it always did.

## Not closed

- **A chunk boundary can still cut a redraw.** `feed` splits each stream chunk on newline
  and treats every piece as a whole line, so a redraw split across two reads renders its
  last complete frame — `(Reading database ... 75%` instead of the total. That is the
  pre-existing chunk handling, not the control characters, and it costs a progress figure
  rather than a message.
- **No build ran through the live daemon on this code.** The replay used the deployed
  module and the real bytes, which is why it is a check; the first real in-dispatch build
  is still the first end-to-end reading.
- The check wrote entries under the `curiablobtest` and `curia190` syslog tags. They sit
  outside `-u curia` and age out with the journal.
