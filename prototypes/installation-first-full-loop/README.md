# Installation and first Full loop prototype

This throwaway prototype compares eight structures for Curia's setup connections:

- `A`: a focused wizard with a persistent progress rail.
- `B`: a verification console that emphasizes status and evidence.
- `C`: a compact field checklist that keeps the whole journey visible.
- `D`: a reward-led bento launchpad.
- `E`: a keyboard-style command palette.
- `F`: a non-linear connection map around Curia.
- `G`: parallel identity and intelligence lanes.
- `H`: a capability receipt that fills in as setup progresses.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Each variant shares one in-memory simulation. The operator may configure integrations in any order. It includes a reward after every connection, close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
