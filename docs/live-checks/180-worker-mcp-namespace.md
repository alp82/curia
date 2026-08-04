# Live check: bounding a worker's MCP namespace (#180)

Ticket: [alp82/curia#180](https://github.com/alp82/curia/issues/180), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-04 inside a live
containerized worker on the deployment box. Every check reads. Nothing on the account was
written.

The fault this answers is measured in
[docs/research/worker-context-budget.md](../research/worker-context-budget.md) §4 (#166). A live
worker listed 38 MCP tools. Six belong to curia. The rest are the operator's account-level
claude.ai connectors: Notion, Gmail, Google Drive and Google Calendar. A worker could read and
write the operator's mail, documents and calendar.

## 1. The connectors do not come through the config dir

`#23`/`#29` isolate a worker with `CLAUDE_CONFIG_DIR`, and that holds for every server named in
a config file. Account connectors arrive another way. The pinned CLI (`2.1.220`, the version
`config/curia.yaml` pins) fetches them over the wire, from the account behind the credential:

```
GET https://api.anthropic.com/v1/mcp_servers?limit=1000
```

Before it asks, it runs an eligibility chain. The chain, in its own order, is:

1. the `ENABLE_CLAUDEAI_MCP_SERVERS` environment variable
2. the `disableClaudeAiConnectors` setting
3. safe mode
4. a third-party model provider
5. API-key auth precedence
6. no access token
7. a credential without the `user:mcp_servers` scope

The setting is **second, ahead of every auth branch**. That is the whole answer to the ticket:
the namespace can be bounded without touching the credential `#53` shares on purpose.

## 2. The setting is read from the worker's own config dir

Two runs, same container, same CLI, same credential. Only `settings.json` differs.

```
$ CLAUDE_CONFIG_DIR=<dir without the key>  claude --debug-to-stderr -p '…'
[claudeai-mcp] Missing user:mcp_servers scope (scopes=user:inference)

$ CLAUDE_CONFIG_DIR=<dir with the key>     claude --debug-to-stderr -p '…'
[claudeai-mcp] Disabled via disableClaudeAiConnectors setting
```

The CLI names the setting. `CLAUDE_CONFIG_DIR/settings.json` is the user settings source, and
the setting is true in any source, so the file curia already writes is enough.

## 3. What the container lane carries today

The first line above is the second finding. A container worker gets its credential as
`CLAUDE_CODE_OAUTH_TOKEN` (#156), and that token states one scope:

```
scopes=user:inference
```

The API agrees with the CLI. The same token, against the same endpoint:

```
HTTP 403
{"type":"error","error":{"type":"permission_error",
 "message":"OAuth token does not meet scope requirement user:mcp_servers"}}
```

So the container lane was already closed on 2026-08-04, before this change. It was closed by
accident. The bound rides on how #156 delivers the credential, not on a decision anyone made.
A container put back on the shared store, or a token minted with wider scopes, opens it again
with nothing to say so.

The bare-pane lane is the open one. It points `CLAUDE_SECURESTORAGE_CONFIG_DIR` at the host
store, so it holds the operator's interactive-login credential, and that credential carries
`user:mcp_servers`. That is the 38-tool session #166 measured. It could not be re-measured from
inside a container, because the container has no host store to read.

## 4. The second belt, and the trap inside it

`allowedMcpServers` bounds the whole namespace, not one source. Only the named server is
admitted, whatever route another one arrives by. Measured against a worktree carrying two
servers, `curia` and `evil`:

| `settings.json` | `claude mcp list` |
|---|---|
| no allowlist | `curia` and `evil` |
| `"allowedMcpServers": ["curia"]` | **nothing, not even `curia`** |
| `"allowedMcpServers": [{"serverName": "curia"}]` | `curia` only |

The middle row is the trap. An entry is an object, not a string. A string fails schema
validation, and an invalid allowlist enforces an empty one, which takes curia's own server down
with it. A worker with no curia tools looks exactly like a slow worker, which is fault 3 of
[#185](https://github.com/alp82/curia/issues/185).

The allowlist and the server name are one constant in `workspace.mjs` for that reason. A test
asserts that the allowlist names the very server the harness writes.

## 5. The sandbox does not cover this

[#148](https://github.com/alp82/curia/issues/148) draws a filesystem and process boundary. A
connector call is an ordinary outbound HTTPS request, and #148 leaves the network open because
wayfinder needs `gh` and the web. So no container boundary reaches this, and the settings file
is the only place to put the bound.

## 6. What shipped

`seedConfigDir` writes both keys into every claude worker's `settings.json`:

```json
{
  "skipDangerousModePermissionPrompt": true,
  "disableClaudeAiConnectors": true,
  "allowedMcpServers": [{ "serverName": "curia" }]
}
```

Checked end to end against the shipped code, not against a hand-written file. `seedConfigDir`
and `writeHarness` produced a real config dir and worktree. A rogue server was then planted in
that worktree's `.mcp.json` under a connector-looking name:

```
$ claude mcp list
curia: http://127.0.0.1:4271/mcp?worker=curia-180x&ticket=180 (HTTP) - …
```

`claude.ai Gmail` is gone. `curia` stands. (The health line reports a refused connection because
no daemon listens on that address inside the probe container. The listing is the check.)

The codex lane has the same shape of fault under a different name
([#172](https://github.com/alp82/curia/issues/172)) and is untouched here.
