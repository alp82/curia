# Installation and first Full loop prototype

This throwaway prototype keeps the selected guided-path structure and compares five cumulative data products:

- `A`: an operator briefing combines live facts from every service.
- `B`: an attention inbox finds work and requests that the operator can act on.
- `C`: a first-action composer shows how each service contributes to useful work.
- `D`: a live activity feed shows what Curia discovers as each service connects.
- `E`: a Full-loop trace joins provider identifiers, timing, and delivery evidence.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Add `&demo=partial` to preload GitHub and Discord data. Add `&demo=ready` to inspect every populated data product without completing the simulated setup first.

Each variant shares one in-memory simulation. The operator may configure integrations in any order. It includes a reward after every connection, close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
