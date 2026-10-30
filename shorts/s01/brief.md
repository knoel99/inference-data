# Short 01 — Why LLM decoding is bound by memory bandwidth (original brief)

> English translation of the original brief. Where it differs from `script.en.md` (language, timings, voice-over, extra scenes 1b and 5b), **`script.en.md` wins**: it is the only source of truth for on-screen text, figures and timings.

Course: mastering-compute-infrastructure, module m01 "Anatomy of a Linux and GPU node" (sections "The device and the two memories", "PCIe").
Format: 9:16, 1080×1920, 2 to 3 min, animation written as code (HTML/SVG/Canvas), "explainer" style of the yihui-dev/awesome-opus5-5-videos repo. (Superseded: on-screen text is now in English, and there is an English voice-over with burned-in subtitles.)
Audience: engineers, not a general-public explainer. Every figure on screen comes from the script, nothing else.

## Scenes (indicative durations; see script.en.md for the real ones)
1. Hook: "4 GPUs, 2,560 GB/s. Why doesn't Kimi K3 go past 40 tok/s?"
2. The path of a weight: NVMe → host RAM → PCIe → VRAM → cores. Each hop lights up with its throughput. Compute only happens on bytes already in VRAM.
3. The mechanism: in single-request decoding, each token re-reads every active weight once; ~1 multiply-add per weight read → the cores wait on memory. Show the formula: max tok/s = bandwidth (GB/s) / bytes read per token (GB).
4. The red kimi math: target 40 tok/s = 25 ms per token.
   - VRAM: 4 × 640 GB/s = 2,560 GB/s → 2,560 / 40 = 64 GB readable per token.
   - NVMe RAID: 225 GB/s measured → 225 / 40 = 5.6 GB per token.
   - Compared bars 64 GB vs 5.6 GB. Conclusion: experts must mostly stay in VRAM (expert cache); NVMe only serves the misses.
5. The PCIe detail: NVMe PCIe 5 x4 = 32 GT/s × 4 × 128/130 / 8 ≈ 15.75 GB/s; ×16 drives ≈ 252 GB/s peak; 225 measured = 89%. 4 drives ≈ 63 GB/s ≈ one x16 link → 4 groups, one per IO hub (diagram: 4 GPU columns + 4 NVMe each).
6. Takeaway: "Decode = a memory problem. Tomorrow: why prefill is bound by compute."
On-screen credit: tinybox red kimi figures, tiny corp posts of 29 Oct 2026; PCIe formula: PCIe 5.0 spec.

## Deliverables
- Animation: `anim/index.html` (deterministic seekable timeline, fixed duration, 1080×1920) and `anim/scenes.json`.
- Clip Editor: MP4 capture (headless, 30 fps), duration/legibility check, voice-over and subtitles.
- Inference Lead: review of the figures on the final render.
