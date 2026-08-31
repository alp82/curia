# Installation and first Full loop prototype

This throwaway prototype compares three structures for Curia's fixed setup sequence:

- `A`: a focused wizard with a persistent progress rail.
- `B`: a verification console that emphasizes status and evidence.
- `C`: a compact field checklist that keeps the whole journey visible.

Start it from the repository root:

```bash
python3 -m http.server 8090
```

Open `http://localhost:8090/prototypes/installation-first-full-loop/?variant=A`. Use the floating switcher or the left and right arrow keys to compare variants.

Each variant shares one in-memory simulation. It includes close-and-reopen resumption, a failed Tailscale check with one corrective action and **Try again**, and the verified first Full loop.
