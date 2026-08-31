# Installation and first Full loop prototype

This throwaway prototype keeps the selected guided-path structure and compares three visual ways to retain each setup result directly in fixed-height navigation cards:

- `A`: the proposed hybrid puts useful metrics beneath each GitHub ticket, Discord message, Tailscale device, model-provider surface, and Full-loop path.
- `B`: visual metrics summarize three concrete results from every connection.
- `C`: service-native surfaces retain compact technical evidence underneath.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Add `&demo=partial` to preload GitHub and Discord data. Add `&demo=ready` to inspect every populated data product without completing the simulated setup first.

Each variant shares one in-memory simulation. The operator may configure integrations in any order. It includes a reward after every connection, close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
