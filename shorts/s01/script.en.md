# Short 01 — Why LLM decoding is bound by memory bandwidth
Course: mastering-compute-infrastructure, module m01 (device memory, PCIe). Format: 9:16, 1080×1920, 30 fps, ~2:45. All on-screen text and voice in English. Keep bottom 380 px empty for burned-in subtitles. Every number on screen comes from this file; nothing else.

## Scene 1 — Hook (0:00–0:08)
On screen: 4 GPUs. "2,560 GB/s". "40 tok/s". Question mark.
VO: "Four GPUs. 2.5 terabytes a second. Why only forty tokens per second?"

## Scene 1b — Mixture of experts (0:08–0:20) [visual change every 5–8 s]
On screen: 896 small expert tiles; per token only 16 light up (+2 shared). "2.8T total → 104B active per token".
  104B active × ~0.5 byte per weight (4-bit) ≈ 52 GB read per token (lower bound; parts kept in higher precision push it up)
VO: "2.8 trillion weights, but each token wakes only 104 billion. At four bits, that's 52 gigabytes per token, minimum."


## Scene 2 — The path of a weight (0:20–0:40) — trimmed to ~20 s
On screen: pipeline NVMe → host RAM → PCIe → GPU memory (VRAM) → compute cores. Each hop lights up in turn.
VO: "A weight starts on an NVMe drive. It's read into host RAM, copied across the PCIe bus, and lands in GPU memory. The cores only ever compute on bytes that are already in VRAM. Every hop has its own speed, and the slowest hop sets the pace for everything else."

## Scene 3 — The mechanism (0:40–1:20)
On screen: label "arithmetic intensity ≈ 1 multiply-add per weight read". One token generated; all active weights stream past the cores once; cores mostly idle. Then the formula:
  max tokens/s = memory bandwidth (GB/s) / bytes read per token (GB)
VO: "When you decode one request at a time, every new token forces the GPU to read every active weight once. For each weight it reads, it does roughly one multiply-add. That's almost no math per byte — low arithmetic intensity — so the cores spend their time waiting on memory. The ceiling is simple: bandwidth divided by the bytes you read per token."

## Scene 4 — The red kimi budget (1:20–2:05)
On screen: "Target: 40 tok/s = 25 ms per token". Two bars.
  - VRAM: 4 × 640 GB/s = 2,560 GB/s → 2,560 / 40 = 64 GB per token
  - NVMe RAID: 225 GB/s measured → 225 / 40 = 5.6 GB per token
VO: "Take tiny corp's red kimi box, built to run Kimi K3. Forty tokens per second means twenty-five milliseconds per token. From VRAM — four GPUs at 640 gigabytes per second each — you can read 64 gigabytes in that window. From the NVMe array, at 225 gigabytes per second measured, only 5.6. So the experts a token needs have to sit mostly in VRAM, and the drives only serve the misses."

## Scene 5 — Why 16 drives in 4 groups (2:05–2:42)
Pacing: ONE line at a time, each result stays on screen before the next; highlight "89%". 
On screen: PCIe math, then topology: 4 columns, each = 1 GPU on x16 + 4 NVMe on x4, one per IO hub.
  PCIe 5.0 x4: 32 GT/s × 4 lanes × 128/130 ÷ 8 ≈ 15.75 GB/s per drive
  × 16 drives ≈ 252 GB/s peak → 225 GB/s measured = 89%
  4 drives ≈ 63 GB/s ≈ one x16 link
VO: "Each drive sits on four PCIe 5 lanes: about 15.75 gigabytes per second. Sixteen of them give about 252 peak, and tiny corp measured 225, eighty-nine percent. Four drives roughly fill one sixteen-lane link, which is why they're split into four groups, one per IO hub, each next to its GPU."

## Scene 5b — Recall question (2:42–2:45)
VO: "Quick check: bandwidth doubles. What happens?" then 1 s pause.
On screen only: "Bandwidth doubles. Max tok/s?" (answer opens Short 02: it doubles, as long as decode stays memory-bound)

## Scene 6 — Takeaway (2:45–2:55)
On screen: "Decode = a memory problem." Next: "Prefill: bound by compute. Why?"
VO: "Decode is a memory problem. Tomorrow: why prefill, on the same hardware, is bound by compute instead."

Sources (credit card, last 2 s): Kimi K3 model card (2.8T total, 104B active, 16 of 896 experts + 2 shared); tiny corp posts, 29 Oct 2026 (red kimi specs, 225 GB/s measured); PCIe 5.0 spec (32 GT/s, 128b/130b).


Global rule: a visual change every 5–8 s, especially during the long voice-over in scenes 3 and 4.
