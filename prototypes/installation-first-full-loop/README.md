# Installation and first Full loop prototype

This throwaway prototype keeps the selected guided-path structure. Each fixed-height navigation card owns its service header, setup state, and connection-data footer. Three variants compare brand-color behavior:

- `A`: every card always uses its brand color in the header and a neutral footer.
- `B`: incomplete headers are dimmed; connected headers become vivid and their footers gain a light brand tint.
- `C`: incomplete cards stay neutral; connected cards use brand color across the full surface.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Add `&demo=partial` to preload GitHub and Discord data. Add `&demo=ready` to inspect every populated data product without completing the simulated setup first.

Add `&tickets=none` to model a connected GitHub repository with no tickets. The GitHub card then shows repository-level readiness instead of a fabricated ticket.

Add `&error=tailscale` (or another step key) to inspect the selected red-tinted error treatment. Variant `B` is the selected direction.

Each variant shares one in-memory simulation. The operator may configure integrations in any order. It includes a reward after every connection, close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
