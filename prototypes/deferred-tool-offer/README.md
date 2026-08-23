# deferred-tool-offer

This rig measures [the deferred Curia tool offer](../../docs/research/codex-deferred-curia-tools.md).
It uses a real Codex model and a local MCP stand-in.

The stand-in records each tool call.
The runner reads each Codex rollout for token counts and discovery actions.

Run one sample with the active Codex credential:

```sh
node run.mjs sample pane
node run.mjs sample-exec exec
```

Run the two five-pair matrices:

```sh
RUNS=5 PREFIX=sol node matrix.mjs
RUNS=5 PREFIX=report TASK=report node matrix.mjs
```

Each run writes temporary evidence under `out/<name>/`.
The repository keeps only the two reduced matrix files.

Use `MODEL` and `EFFORT` to test a different route.
Use `CODEX_AUTH` when the active credential is outside `CODEX_HOME`.
