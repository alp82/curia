# Installation and first Full loop prototype

This throwaway prototype keeps the selected guided-path structure and compares three ways to retain each setup result directly in its navigation rail:

- `A`: the value rail explains what the connected service now enables and what Curia found.
- `B`: the evidence rail retains provider identifiers, verified facts, and timing.
- `C`: the combined rail shows both the operator value and compact technical evidence.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Add `&demo=partial` to preload GitHub and Discord data. Add `&demo=ready` to inspect every populated data product without completing the simulated setup first.

Each variant shares one in-memory simulation. The operator may configure integrations in any order. It includes a reward after every connection, close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
