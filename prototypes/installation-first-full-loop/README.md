# Installation and first Full loop prototype

This throwaway prototype keeps the selected guided-path structure and compares three ways to combine a service-native surface with useful metrics in fixed-height navigation cards:

- `A`: a metric strip sits below the native surface.
- `B`: the native surface and a vertical metric column sit side by side.
- `C`: the native surface and metric footer form one unified card.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Add `&demo=partial` to preload GitHub and Discord data. Add `&demo=ready` to inspect every populated data product without completing the simulated setup first.

Add `&tickets=none` to model a connected GitHub repository with no tickets. The GitHub card then shows repository-level readiness instead of a fabricated ticket.

Each variant shares one in-memory simulation. The operator may configure integrations in any order. It includes a reward after every connection, close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
