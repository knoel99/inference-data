# Atlas tables

Compiled for the explorer's hardware charts, outside the `datapackage.json` contract.

| File | One row is |
| --- | --- |
| `gpus.csv` | A GPU or single-chip system: price, memory, bandwidth, dense 16-bit TFLOPS, power |
| `systems.csv` | A complete machine, capacities summed over its GPUs |
| `measures.csv` | A published single-user decode and prefill result, with its URL |
| `models.csv` | An open model's Artificial Analysis index (consulted 2026-10-26) and weight size |

Unlike `data/hardware.csv` and `data/measurements.csv`, rows in `gpus.csv`, `systems.csv`, and `models.csv` carry no per-row source URL: treat them as unverified. `price_basis` says what each price is (MSRP, street price, market or analyst estimate, supplier quote converted at 1.12 $/€). `tflops_basis` is `published` or `derived` (scaled from a sibling chip). Values were recorded in October 2026.
