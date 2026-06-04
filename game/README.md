# Mini Metropolis 🏙️

A tiny SimCity-style city builder, made to play on your Mac. No installing
anything, no App Store, no developer tools — it runs straight in your web
browser (Safari or Chrome).

## How to play it on your Mac

1. In Finder, open the `game` folder.
2. **Double-click `index.html`.** It opens in your default browser and you're playing.

That's it. Nothing to install. Works offline. Your city auto-saves to that
browser, and there's a **Save / Load** button too.

> Tip: drag `index.html` onto your Dock or make a bookmark so it's one click
> to jump back in.

## The goal

Grow a happy, solvent city. You're the Mayor. Balance three things:

- **R — Residential** (homes / people)
- **C — Commercial** (shops / services)
- **I — Industrial** (factories / jobs)

Watch the **RCI meter** in the top-right. A green-ish bar pushing **up** means
that type is in demand — go zone more of it. A bar pushing **down** means you've
overbuilt it.

## The loop (in 30 seconds)

1. **Lay roads.** Zones only develop within 3 tiles of a road. (Click-drag to paint.)
2. **Drop a Power Plant.** Power flows through roads and buildings. Anything with a
   red ⚡ has no power and won't grow.
3. **Zone Residential** next to your roads. Homes fill in by themselves over time.
4. People need shops and jobs → **Commercial** and **Industrial** demand rises →
   zone those too. Jobs bring in more residents. The city snowballs.
5. **Money:** taxes arrive every month from people + jobs; roads, power and
   services cost upkeep. Use the **tax slider** — too high and approval drops,
   too low and you go broke. Aim for a small positive **/mo** figure.
6. **Parks, Police, Fire** raise land value nearby, so buildings grow taller.

## Controls

| Action | How |
|---|---|
| Pick a tool | Click it in the left palette, or press keys **1–9** |
| Build / paint | Click, or click-and-drag across tiles |
| Bulldoze | The ⛏️ tool, or press **B** |
| Pause / resume | The ⏸ / ▶ buttons, or **Space** |
| Faster time | The ▶▶ / ▶▶▶ buttons |
| What's this tile? | Hover over it |

## Good luck, Mayor

Start small: a square of road, one power plant, a patch of housing. Watch the
RCI meter and follow the demand. Built entirely in one HTML + one JS + one CSS
file — feel free to tweak the numbers at the top of `game.js` if you want a
harder or easier game.
