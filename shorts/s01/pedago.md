# Short 01 — teaching notes

- Target concept: in single-request decoding, max throughput is bounded by memory bandwidth.
  Rule to remember: max tok/s = bandwidth (GB/s) / bytes read per token (GB).
- Assumed prerequisites: knowing what a weight, a token and VRAM are. No PCIe prerequisite.
- Vocabulary introduced (to revisit in later Shorts): mixture of experts (active parameters), arithmetic intensity, memory-bound.
- Recall question (scene 5b, picked up at the start of Short 02): "Bandwidth doubles. What happens?"
  Expected answer: the ceiling doubles, as long as decoding stays memory-bound.
- Misconception to watch: "more cores / more TFLOPS = more tokens/s in decoding".
- Next: Short 02 = prefill bound by compute; later, batching raises arithmetic intensity.
