# Mini Metropolis 🏙️

A tiny SimCity-style city builder that runs entirely in your browser — no install,
no build step, no dependencies. Just open it and play.

**▶ Play it:** open [`game/index.html`](game/index.html) in any modern browser
(Safari or Chrome on a Mac work great).

## What it is

Pure vanilla **HTML + CSS + JavaScript** on a single `<canvas>`. You're the Mayor:
lay roads, drop a power plant, zone Residential / Commercial / Industrial, and
keep the city solvent while it grows itself.

- **High-res renderer** — full device-pixel-ratio canvas, smooth gradient terrain,
  a meandering river with banks, detailed buildings whose windows light up when
  powered.
- **Street life** — pedestrians stroll the pavements, dogs trot to lampposts and
  pee, and cars drive the roads. Toggle it with the **🚶 Street life** switch.
- **Zoom & pan camera** — scroll to zoom in on the action, right-drag (or arrow
  keys) to pan, `0` to reset the view.
- **Auto-save** to your browser, plus manual Save / Load.

See [`game/README.md`](game/README.md) for the full how-to-play.

## Project layout

```
game/          the whole game — index.html, game.js, style.css, README.md
.claude/       local preview tooling (a tiny Node static server + launch config)
```

## Run a local server (optional)

Opening `game/index.html` directly is enough. If you'd rather serve it:

```sh
node .claude/preview-server.js   # serves game/ at http://localhost:8745
```
