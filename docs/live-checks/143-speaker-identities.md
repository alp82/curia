# Live check: speaker identities under a real webhook (#143)

Ticket: [alp82/curia#143](https://github.com/alp82/curia/issues/143), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.net` on 2026-08-03, against the live Discord API with the daemon's own bot token.
The daemon was not restarted, and the two check messages were deleted after the operator
looked at them.

The fault: speaker identities ([#108 item 15](https://github.com/alp82/curia/issues/108)) post
worker prose under a channel webhook. The bot never had **Manage Webhooks**, so every send fell
back to the bot voice and said so in the daemon log alone. The identities had never rendered.

## 1. The permission was missing, and the journal proves the cost

```
$ curl -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    https://discord.com/api/v10/channels/<#curia>/webhooks
{"message": "Missing Permissions", "code": 50013}      http=403

$ journalctl -u curia -n 2000 | grep -ci "missing permissions"
43
```

`CuriaBot` held one role, `Curia`. Neither it, nor `@everyone`, nor `Admin` carried
`MANAGE_WEBHOOKS` (`1 << 29`), and no role was administrator. A bot cannot grant itself a
permission it lacks, so this half was the operator's: Server Settings → Roles → `Curia` →
**Manage Webhooks**.

## 2. Beware Cloudflare, not Discord

After the grant, the same request from a Python client answered `403 error code: 1010` — a
**Cloudflare** rejection of the default `python-urllib` user agent, not a Discord permission.
It reads exactly like the fault under investigation. Discord requires the documented shape:

```
User-Agent: DiscordBot (https://github.com/alp82/curia, 0.1.0)
```

With that header the same call answers `200`.

## 3. The grant, verified end to end

Each step is the daemon's own path in `bridge.mjs`, run by hand:

| Step | Call | Result |
|---|---|---|
| `#webhook()` read | `GET /channels/<#curia>/webhooks` | 200 |
| `#webhook()` mint | `POST /channels/<#curia>/webhooks` `{"name":"curia-speakers"}` | 200 |
| `#sendAs()` | `POST /webhooks/<id>/<token>?wait=true` | 200, `author.username` = `curia-143 · Speaker identities: grant Manage Webhooks` |
| cleanup | `DELETE .../messages/<id>` | 204 |

## 4. The avatar had never worked either, and the API cannot tell you

`#avatarFor` built `https://github.com/identicons/<worker>.png`. That endpoint answers for
**real GitHub accounts only**:

| URL | Status |
|---|---|
| `github.com/identicons/curia-9.png` | 404 |
| `github.com/identicons/curia-143.png` | 404 |
| `github.com/identicons/zzqqxx123.png` | 404 |
| `github.com/identicons/alp82.png` | 200 (redirects to the user's avatar) |

So Discord had nothing to fetch and drew the default face for every worker since #108 item 15
shipped.

**The API is no witness here.** A webhook message returns `author.avatar: null` whether the
`avatar_url` override 404s or resolves — measured against the dead URL, a URL that exists, and
a third service, all three `null`. Only the rendered client says. So the check ended with the
operator looking at two live messages, and it is the reason this file exists rather than a
test.

The fix seeds a Gravatar identicon from the worker name (`d=identicon` generates one from any
hash, `f=y` forces the generated face over a real account's picture). Curia still hosts no
asset:

```
https://www.gravatar.com/avatar/<md5(worker)>?d=identicon&f=y&s=128   200 image/png
```

## 5. What the operator saw

Two messages posted into `#curia`, then deleted:

- `curia-143 · Speaker identities: grant Manage Webhooks`
- `curia-99 · another worker, another face`

Each carried its own name and its own identicon, and the two faces differed. That is the
ticket's bar: a worker message renders under its own name and avatar.

## Still open after this check

- The startup notice needs a daemon restart to go live. The identities themselves do not: the
  send path is never disabled, so the running daemon healed on its first speaker send after the
  grant.
- The `curia-speakers` webhook now exists in `#curia`. The daemon finds it by name and does not
  mint a second one.
