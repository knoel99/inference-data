#!/usr/bin/env python3
"""Render index.html to out.mp4: 1080x1920, 30 fps, H.264 (libx264), yuv420p, no audio.

Each frame i is drawn with window.__seek(i / fps) in headless Chromium, screenshotted and piped to
ffmpeg. Every frame is also checked for an empty bottom 380 px (the subtitle zone). The video is
then checked with ffprobe and one still per scene is extracted to stills/.

    pip install playwright            # and a Chromium build: python -m playwright install chromium
    python render.py                  # writes out.mp4 and stills/*.png next to this file

Options: --jobs N renders N frame ranges in parallel browser pages and joins them losslessly;
--chromium PATH uses a specific Chromium/Chrome binary. ffmpeg and ffprobe must be on PATH.
"""
import argparse
import json
import multiprocessing
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
W, H, SUBTITLE_ZONE = 1080, 1920, 380

# Representative moment of each scene (s), where everything in it is on screen.
STILL_AT = {'1': 7.0, '1b': 19.0, '2': 36.5, '3': 64.0, '4': 120.0, '5': 158.0, '5b': 164.2, '6': 172.0}
EXTRA_STILLS = {'6-sources': 174.5}

# Seek, then report whether the subtitle zone is still a single flat colour.
SEEK_JS = f"""t => {{
  window.__seek(t);
  const c = document.querySelector('canvas');
  const d = new Uint32Array(c.getContext('2d').getImageData(0, {H - SUBTITLE_ZONE}, {W}, {SUBTITLE_ZONE}).data.buffer);
  for (let i = 1; i < d.length; i++) if (d[i] !== d[0]) return false;
  return true;
}}"""


def ffmpeg_encoder(fps, out):
    return subprocess.Popen([
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'image2pipe', '-framerate', str(fps), '-c:v', 'png', '-i', '-',
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-r', str(fps), '-an', '-movflags', '+faststart', str(out),
    ], stdin=subprocess.PIPE)


def open_page(p, chromium):
    browser = p.chromium.launch(executable_path=chromium) if chromium else p.chromium.launch()
    page = browser.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
    page.goto((HERE / 'index.html').as_uri())
    page.wait_for_function('window.__ready === true')
    return browser, page


def render_range(job):
    """Render frames [start, stop) to an MP4. Returns the frames whose subtitle zone was not empty."""
    start, stop, fps, out, chromium, label = job
    bad = []
    with sync_playwright() as p:
        browser, page = open_page(p, chromium)
        enc = ffmpeg_encoder(fps, out)
        t0 = time.time()
        for i in range(start, stop):
            if not page.evaluate(SEEK_JS, i / fps):
                bad.append(i)
            enc.stdin.write(page.screenshot(type='png'))
            done = i + 1 - start
            if done % 600 == 0:
                print(f'  {label}: {done}/{stop - start} frames, {done / (time.time() - t0):.1f} fps', flush=True)
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError(f'ffmpeg failed on {out}')
        browser.close()
    return bad


def probe(path, frames, duration, fps):
    res = subprocess.run([
        'ffprobe', '-v', 'error', '-count_frames',
        '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames'
                         ':format=duration',
        '-of', 'json', str(path),
    ], capture_output=True, text=True, check=True)
    info = json.loads(res.stdout)
    video = [s for s in info['streams'] if s['codec_type'] == 'video']
    v = video[0] if video else {}
    checks = {
        'one video stream, no audio': len(video) == 1 and len(info['streams']) == 1,
        'codec h264': v.get('codec_name') == 'h264',
        f'{W}x{H}': (v.get('width'), v.get('height')) == (W, H),
        'pix_fmt yuv420p': v.get('pix_fmt') == 'yuv420p',
        f'{fps} fps': v.get('r_frame_rate') == f'{fps}/1',
        f'{frames} frames': int(v.get('nb_read_frames', -1)) == frames,
        f'duration {duration:g} s': abs(float(info['format']['duration']) - duration) < 1.5 / fps,
    }
    print(f"ffprobe: {v.get('codec_name')} {v.get('width')}x{v.get('height')} {v.get('pix_fmt')} "
          f"{v.get('r_frame_rate')} fps, {v.get('nb_read_frames')} frames, {float(info['format']['duration']):.3f} s")
    for name, ok in checks.items():
        print(f"  [{'ok' if ok else 'FAIL'}] {name}")
    return all(checks.values())


def extract_stills(video, scenes, stills_dir):
    stills_dir.mkdir(parents=True, exist_ok=True)
    shots = {}
    for s in scenes:
        slug = s['title'].lower().replace(' ', '-')
        shots[f"scene-{s['id']}-{slug}"] = STILL_AT.get(s['id'], s['end'] - 0.6)
    shots.update({f'scene-{k}': v for k, v in EXTRA_STILLS.items()})
    for name, t in shots.items():
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', str(video),
                        '-frames:v', '1', '-update', '1', str(stills_dir / f'{name}.png')], check=True)
        print(f'  stills/{name}.png  (t = {t:g} s)')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--out', type=Path, default=HERE / 'out.mp4')
    ap.add_argument('--stills', type=Path, default=HERE / 'stills')
    ap.add_argument('--jobs', type=int, default=1, help='parallel browser pages (default 1)')
    ap.add_argument('--chromium', default=os.environ.get('CHROMIUM_PATH'), help='Chromium/Chrome binary')
    args = ap.parse_args()

    scenes = json.loads((HERE / 'scenes.json').read_text())
    with sync_playwright() as p:
        browser, page = open_page(p, args.chromium)
        duration = page.evaluate('window.__duration')
        timeline = page.evaluate('window.__scenes')
        browser.close()
    if timeline != scenes:
        sys.exit('scenes.json does not match window.__scenes in index.html')
    frames = round(duration * args.fps)
    print(f'Rendering {frames} frames ({duration} s at {args.fps} fps) with {args.jobs} job(s) -> {args.out}')

    t0 = time.time()
    jobs = max(1, min(args.jobs, frames))
    if jobs == 1:
        bad = render_range((0, frames, args.fps, args.out, args.chromium, 'frames'))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            bounds = [frames * k // jobs for k in range(jobs + 1)]
            parts = [Path(tmp) / f'part{k:02d}.mp4' for k in range(jobs)]
            work = [(bounds[k], bounds[k + 1], args.fps, parts[k], args.chromium, f'part {k + 1}/{jobs}')
                    for k in range(jobs)]
            with multiprocessing.Pool(jobs) as pool:
                bad = [i for part in pool.map(render_range, work) for i in part]
            listing = Path(tmp) / 'parts.txt'
            listing.write_text(''.join(f"file '{p.name}'\n" for p in parts))
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(listing),
                            '-c', 'copy', '-movflags', '+faststart', str(args.out)], check=True)
    print(f'Encoded in {time.time() - t0:.0f} s')
    if bad:
        print(f'Subtitle zone NOT empty on {len(bad)} frames, first: {bad[:10]}')
    else:
        print(f'Subtitle zone (bottom {SUBTITLE_ZONE} px) empty on all {frames} frames')

    ok = probe(args.out, frames, duration, args.fps)
    extract_stills(args.out, scenes, args.stills)
    if bad or not ok:
        sys.exit(1)


if __name__ == '__main__':
    main()
