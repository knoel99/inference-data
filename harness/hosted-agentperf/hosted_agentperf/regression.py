"""Quantile regression at tau=0.10 and the section 5.7 summaries.

The fit is iteratively reweighted least squares. It uses only the Python
standard library so a checkout can run the pilot reduction without extra
packages.

The protocol's sigma = 200 ms, SE figures, and beta ≈ alpha/100 are not
inputs. Standard errors come from the residual scale of the fitted sample
and from a cell-stratified bootstrap.
"""

from __future__ import annotations

import math
import random
import statistics
from collections import defaultdict


def fit_quantile(
    design: list[list[float]],
    response: list[float],
    tau: float = 0.10,
    max_iter: int = 50,
) -> list[float] | None:
    if not design or len(design) != len(response):
        return None
    width = len(design[0])
    if len(response) < width:
        return None
    beta = _wls(design, response, [1.0] * len(response))
    if beta is None:
        return None
    delta = 1e-4
    for _ in range(max_iter):
        fitted = _predict(design, beta)
        residuals = [response[i] - fitted[i] for i in range(len(response))]
        weights = []
        for residual in residuals:
            if residual >= 0:
                weights.append(tau / max(residual, delta))
            else:
                weights.append((1.0 - tau) / max(-residual, delta))
        updated = _wls(design, response, weights)
        if updated is None:
            return beta
        shift = max(abs(updated[j] - beta[j]) for j in range(width))
        scale = max(1.0, max(abs(value) for value in updated))
        beta = updated
        if shift / scale < 1e-8:
            break
    return beta


def fit_ols(design: list[list[float]], response: list[float]) -> list[float] | None:
    if not design:
        return None
    return _wls(design, response, [1.0] * len(design))


def bootstrap_quantile(
    rows: list[dict],
    names: list[str],
    n_boot: int = 2000,
    tau: float = 0.10,
    seed: int = 0,
) -> dict[str, dict[str, float]]:
    """Percentile intervals, resampling inside each ``cell``."""
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("cell", ""))].append(row)
    rng = random.Random(seed)
    samples: dict[str, list[float]] = {name: [] for name in names}
    for _ in range(n_boot):
        drawn: list[dict] = []
        for group in grouped.values():
            for _pick in range(len(group)):
                drawn.append(group[rng.randrange(len(group))])
        design, response, used_names = design_matrix(drawn)
        if used_names != names:
            continue
        beta = fit_quantile(design, response, tau=tau)
        if beta is None:
            continue
        for name, value in zip(names, beta):
            samples[name].append(value)
    intervals = {}
    for name, values in samples.items():
        if len(values) < 2:
            continue
        ordered = sorted(values)
        intervals[name] = {
            "n": float(len(ordered)),
            "se": statistics.pstdev(ordered),
            "p2_5": _percentile(ordered, 0.025),
            "p97_5": _percentile(ordered, 0.975),
        }
    return intervals


def design_matrix(
    rows: list[dict],
    extra: str | None = None,
) -> tuple[list[list[float]], list[float], list[str]]:
    """TTFT on new tokens, cached tokens, and block indicators.

    The first block in sorted order is the reference, so L0 is that block's
    intercept. ``extra`` adds ``new_sq`` or ``c1_interaction``.
    """
    blocks = sorted({str(row.get("block", "")) for row in rows})
    reference = blocks[0] if blocks else ""
    names = ["L0", "alpha", "beta"]
    for block in blocks:
        if block != reference:
            names.append(f"gamma_{block}")
    if extra == "new_sq":
        names.append("new_sq")
    if extra == "c1_interaction":
        names.append("c1_interaction")
    design: list[list[float]] = []
    response: list[float] = []
    for row in rows:
        new = float(row["new_tokens"])
        cached = float(row["cache_read_tokens"])
        ttft = float(row["ttft_ms"])
        point = [1.0, new, cached]
        for block in blocks:
            if block != reference:
                point.append(1.0 if str(row.get("block", "")) == block else 0.0)
        if extra == "new_sq":
            point.append(new * new)
        if extra == "c1_interaction":
            is_c1 = 1.0 if str(row.get("cell", "")).startswith("C1") else 0.0
            point.append(new * is_c1)
        design.append(point)
        response.append(ttft)
    return design, response, names


def residual_sigma(design: list[list[float]], response: list[float], beta: list[float]) -> float:
    residuals = [response[i] - _dot(design[i], beta) for i in range(len(response))]
    if len(residuals) < 2:
        return 0.0
    return statistics.stdev(residuals)


def formula_se(sigma: float, n: int, sd_predictor: float) -> float | None:
    """SE(coefficient) ≈ sigma / (sqrt(n) * sd(predictor)), from section 5.7."""
    if n <= 0 or sd_predictor <= 0 or math.isnan(sigma):
        return None
    return sigma / (math.sqrt(n) * sd_predictor)


def sd(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return statistics.stdev(values)


def quantile_sorted(values: list[float], q: float) -> float | None:
    if not values:
        return None
    return _percentile(sorted(values), q)


def _percentile(ordered: list[float], q: float) -> float:
    if len(ordered) == 1:
        return ordered[0]
    position = q * (len(ordered) - 1)
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    weight = position - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def _predict(design: list[list[float]], beta: list[float]) -> list[float]:
    return [_dot(row, beta) for row in design]


def _dot(row: list[float], beta: list[float]) -> float:
    return sum(row[j] * beta[j] for j in range(len(beta)))


def _wls(
    design: list[list[float]],
    response: list[float],
    weights: list[float],
) -> list[float] | None:
    n = len(design)
    width = len(design[0])
    scales = [1.0]
    for column in range(1, width):
        peak = max(abs(design[i][column]) for i in range(n))
        scales.append(peak if peak > 0 else 1.0)
    matrix = [[0.0] * width for _ in range(width)]
    vector = [0.0] * width
    for i in range(n):
        weight = weights[i]
        if weight <= 0 or math.isnan(weight):
            continue
        scaled = [design[i][j] / scales[j] for j in range(width)]
        for row in range(width):
            vector[row] += weight * scaled[row] * response[i]
            for col in range(row, width):
                matrix[row][col] += weight * scaled[row] * scaled[col]
    for row in range(width):
        for col in range(row):
            matrix[row][col] = matrix[col][row]
    solved = _solve(matrix, vector)
    if solved is None:
        return None
    return [solved[j] / scales[j] for j in range(width)]


def _solve(matrix: list[list[float]], vector: list[float]) -> list[float] | None:
    width = len(vector)
    aug = [matrix[i][:] + [vector[i]] for i in range(width)]
    for col in range(width):
        pivot = max(range(col, width), key=lambda row: abs(aug[row][col]))
        if abs(aug[pivot][col]) < 1e-12:
            return None
        aug[col], aug[pivot] = aug[pivot], aug[col]
        scale = aug[col][col]
        for j in range(col, width + 1):
            aug[col][j] /= scale
        for row in range(width):
            if row == col:
                continue
            factor = aug[row][col]
            if factor == 0:
                continue
            for j in range(col, width + 1):
                aug[row][j] -= factor * aug[col][j]
    return [aug[i][width] for i in range(width)]
