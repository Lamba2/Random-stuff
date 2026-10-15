# Dashline

A one-file arcade game: dash through enemies, every kill refunds your dash, so you chain from one to the next. Don't get touched.

**Stack:** plain HTML5 canvas and WebAudio. No engine, no dependencies, no asset files. The whole game is `index.html`.

**Run it:** open `index.html` in any browser, desktop or phone.

**Controls:** move with the mouse, WASD/arrows, or by dragging on touch. Dash with click, space, or tap. P pauses, M mutes.

## Files

| File | What it's for |
|------|---------------|
| `index.html` | the game |
| `dashline-itch.zip` | upload this to itch.io (it's just `index.html` zipped) |
| `itch/cover.png` | itch cover image (630×500 @2x) |
| `itch/title.png`, `itch/gameplay-1.png` | page screenshots |
| `itch/gameplay-clip.mp4` | 14-second clip for TikTok, Reddit, or the itch page |

## Putting it on itch.io (about 10 minutes)

1. Make an account at itch.io, then go to **Dashboard → Create new project**.
2. **Title:** Dashline. **Kind of project:** HTML.
3. **Uploads:** upload `dashline-itch.zip` and tick **"This file will be played in the browser"**.
4. **Embed options:** viewport `960 × 600`, tick **Mobile friendly** (orientation: landscape) and **Fullscreen button**.
5. **Pricing:** pick **$0 or donate** with a suggested donation of **$2**. Keep it playable for free: nobody pays for a browser game they haven't tried, but people tip one they liked.
6. **Download donation prompt (optional but worth it):** upload `dashline-itch.zip` a second time *without* the browser box ticked, labeled "Offline version". The download button shows the donate popup.
7. **Payouts:** Settings → Payment, connect PayPal (or Stripe).
8. **Cover image:** `itch/cover.png`. **Screenshots:** the files in `itch/`.
9. **Genre:** Action. **Tags:** `arcade`, `score-attack`, `neon`, `fast-paced`, `one-file`, `short`, `minimalist`, `dash`.
10. Set visibility to **Public** and save.

### Page description (paste this)

> **dash through them. don't let them touch you.**
>
> Dashline is a fast neon score-attack game. Your only attack is a dash, and every kill refunds it instantly, so a good run is one long chain from body to body. Break the chain and the multiplier resets.
>
> - **Hunters** chase you down.
> - **Chargers** lock on, telegraph, then fire across the arena.
> - **Splitters** burst into two when you hit them.
> - Every 40 seconds a **surge** surrounds you.
>
> Three hits and you're done. Runs last a minute or five, depending on how good you are.
>
> **Controls:** mouse, WASD, or touch to move. Click, space, or tap to dash. P pauses, M mutes.
>
> Free to play. If it ate your lunch break, a couple of bucks keeps me making more.

## Getting people to see it

itch doesn't push new games to anyone by default. Traffic comes from posting the clip:

- **r/WebGames:** post the itch link directly; that sub exists for exactly this.
- **r/IndieGaming** and **r/playmygame:** post `itch/gameplay-clip.mp4` with the link in a comment.
- **TikTok / YouTube Shorts:** the clip as-is with the caption "every kill refunds your dash". Gameplay clips with a clear hook do better than trailers.
- **itch devlog:** post one short devlog after launch. It bumps the game in the "recently updated" feeds.
