# Installation and first Full loop prototype

This throwaway prototype keeps the selected guided-path structure and compares five cumulative rewards:

- `A`: verified integrations light a constellation around Curia.
- `B`: every result adds a piece to one mosaic.
- `C`: integrations construct a small operator workspace.
- `D`: verification brings system modules online.
- `E`: each external fact earns a seal on the installation proof.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Each variant shares one in-memory simulation. The operator may configure integrations in any order. It includes a reward after every connection, close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
