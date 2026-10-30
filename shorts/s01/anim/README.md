# Short 01 animation

`index.html` is the whole animation in one self-contained file with no network access. It draws a
1080x1920 canvas and runs 175 s (2:55) at 30 fps. Every figure on screen comes from
`../script.en.md`.

## Files

- `index.html`: the animation. It opens paused on frame 0.
- `scenes.json`: each scene's id, title, start and end in seconds. It matches the timeline in
  `index.html`.
- `vo_cues.json`: when each voice-over sentence of the script is meant to start, in seconds. The
  visual beats inside each scene are timed to these. It is optional, finer than `scenes.json`.
- `render.py`: renders `out.mp4` (not committed) and `stills/`.
- `stills/`: one frame per scene taken from the render, plus the sources card.

## Timeline API

- `window.__duration` (alias `window.DURATION`): 175.
- `window.__seek(t)` (alias `window.renderAt(t)`): draws the exact frame at `t` seconds. Nothing
  depends on the wall clock. There are no timers and no CSS animations, and the randomness is
  seeded, so frames come out the same in any seek order.
- `window.__scenes`, `window.__cues`, and `window.__ready` (true once the first frame is drawn).

## Preview

Open `index.html` in a browser.

- Click or press Space to play or pause.
- Left/Right steps 1 s back or forward (Shift: 5 s); Home and End jump to the ends.
- `index.html?t=80` opens at 80 s, and `index.html?autoplay` plays on load.

## Render

```
pip install playwright && python -m playwright install chromium
python render.py              # --jobs 3 renders three frame ranges in parallel
```

This writes `out.mp4`: 1080x1920, 30 fps, H.264, yuv420p, BT.709, no audio. It checks the subtitle
zone of every frame, checks the file with ffprobe, then extracts `stills/`. ffmpeg and ffprobe must
be on PATH.

## Layout and timings

The bottom 380 px (y ≥ 1540) are never drawn: that zone is left for burned-in subtitles. Text uses
the system sans-serif (Inter if installed, else SF Pro, Segoe UI, Roboto, Helvetica or Arial), and
any line that would overflow is shrunk to fit.

| id | scene | start | end |
|----|-------|-------|-----|
| 1 | Hook | 0:00 | 0:08 |
| 1b | Mixture of experts | 0:08 | 0:20 |
| 2 | The path of a weight | 0:20 | 0:40 |
| 3 | The mechanism | 0:40 | 1:20 |
| 4 | The red kimi budget | 1:20 | 2:05 |
| 5 | Why 16 drives in 4 groups | 2:05 | 2:42 |
| 5b | Recall question | 2:42 | 2:45 |
| 6 | Takeaway; sources card from 2:53 | 2:45 | 2:55 |

## On-screen text beyond the script

The frames carry the script's on-screen text verbatim. They also carry non-numeric labels: scene
names, diagram parts ("host RAM", "IO hub", "GPU"), "slowest hop", "waiting on memory" and
"misses". Two figures are repeated from elsewhere in the script:

- the "16 of 896 experts + 2 shared" legend in scene 1b, from the sources line;
- the "≈ 52 GB read per token" marker on the scene 4 bars, from scene 1b.

The PCIe math, the 52 GB line and the formula are split across lines to fit 9:16, and the formula
is drawn as a fraction.
