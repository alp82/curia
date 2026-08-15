# Live checks: a transcript is found by key (#332)

Run 2026-08-15, inside an agent container on the deployment box. Harness: `claude` 2.1.220 with `@anthropic-ai/claude-agent-sdk` 0.3.220. These are the versions `config/curia.yaml` pins and `daemon/package.json` names. Every turn below ran through the SDK `query()` call, the same call `OverseerHost.#turn` makes. Every turn used one config dir and one fixed cwd, which is the overseer posture.

[ADR-0016](../adr/0016-the-conversation-key.md) left one check to the build. It stated that a resumed session mints a fresh session id. It did not verify whether the new file carries the whole prior history. If the new file is short, the file a key names is short too. Then #332 must say so, and must not ship a shorter Chat screen.

## 1. A resume keeps the session id and appends to the one file

Three turns. Each turn after the first resumed the id the last turn stated.

| Turn | `resume` | session id the turn states | file | lines |
| --- | --- | --- | --- | --- |
| 1 | none | `2751dfab-…78ac40` | `2751dfab-…78ac40.jsonl` | 10 |
| 2 | `2751dfab-…78ac40` | `2751dfab-…78ac40` | `2751dfab-…78ac40.jsonl` | 17 |
| 3 | `2751dfab-…78ac40` | `2751dfab-…78ac40` | `2751dfab-…78ac40.jsonl` | 23 |

The id does not move. No second file appears. The one file grows.

Turn 3 asked what the earlier turns had said. The answer named both words. So the one file holds every turn of the conversation:

```
user      | Reply with exactly: ALPHA
assistant | ALPHA
user      | Reply with exactly: BRAVO
assistant | BRAVO
user      | What two words have I asked you to reply with so far? List them.
assistant | 1. ALPHA
          | 2. BRAVO
```

The `claude --resume` CLI path behaves the same way. It also keeps the id and appends to the same file.

**So the file a key names is the whole conversation.** The Chat screen loses nothing. The open check of ADR-0016 is answered, and the mtime path can go.

## 2. Two conversations in one config dir, and mtime picks the wrong one

A second conversation started in the SAME config dir and the same cwd, with no `resume`. It minted its own id and its own file.

| Ask | Answer |
| --- | --- |
| files in the dir | `04f605d1-…e544b8460.jsonl`, `2751dfab-…78ac40.jsonl` |
| `findTranscript('claude', cfgDir)`, newest by mtime | `04f605d1-…e544b8460.jsonl` |
| `transcriptForSession('claude', cfgDir, '2751dfab-…78ac40')` | `2751dfab-…78ac40.jsonl` |
| `transcriptForSession('claude', cfgDir, '04f605d1-…e544b8460')` | `04f605d1-…e544b8460.jsonl` |

**This is the live defect, reproduced.** The first conversation asked for its own transcript. It got the second one, because the second one answered last. That is the browser chat hidden by a Discord turn. That is also the context percent reporting another conversation.

The session id names the file, so the key finds it. This is the whole fix.

## What this pins

1. The claude harness names a transcript after the session id, and after nothing else.
2. A resume keeps that id. One conversation is one file for its whole life.
3. The daemon journals the id per key on every turn, in `store.bindOverseerSession`. So the key names the file across a daemon restart.
4. A key with no journalled id has no file. The honest answer there is nothing. It is never the newest file in the dir.
