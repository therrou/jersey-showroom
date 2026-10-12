"""Offline drape solver (numpy, position-based), used instead of Blender cloth.

Same family as the web solver (src/cloth/ClothSolver.ts), tuned for a slow, well-damped
settle rather than real time:
  - stretch: every mesh edge, rest length from the FLAT pattern; much softer in
    compression so the knit buckles into folds instead of staying a flat sheet
  - bending: across interior edges of each piece (not across the seams), weak
  - volume: front↔back pairs at the same pattern point keep a minimum separation and
    softly return toward their start depth, so the garment stays a tube
  - pins: the shoulder band resting on the hanger bar
  - bar: the hanger bar as an elliptical capsule (Hanger.tsx, depth squashed 0.45)
  - sleeves hang in front of the body: sleeve vertices are kept in front of the body's
    front sheet (a height field rebuilt every few steps)

All in Blender coordinates (Z up, front faces -Y). Pure numpy: no bpy here.
"""

import numpy as np

GRAVITY = np.array([0.0, 0.0, -9.81])


class Drape:
    def __init__(self, pos, edges, rest, bends, bend_rest, pairs, pair_rest, pins, sleeve, body_front, bar):
        self.x = pos.astype(np.float64).copy()
        self.prev = self.x.copy()
        self.n = len(pos)
        self.edges = edges
        self.rest = rest
        self.bends = bends
        self.bend_rest = bend_rest
        self.pairs = pairs
        self.pair_rest = pair_rest
        self.inv_m = np.ones(self.n)
        self.inv_m[pins] = 0.0
        self.pinned = self.x[pins].copy()
        self.pins = pins
        self.sleeve = sleeve  # bool mask
        self.body_front = body_front  # bool mask
        self.bars = bar if isinstance(bar, list) else [bar]  # [(polyline Nx3, radius, depth scale)]
        self._hf = None

    # --- constraint projection (Jacobi, averaged) ----------------------------------

    def _distance(self, ij, rest, k_stretch, k_comp, acc, cnt):
        i, j = ij[:, 0], ij[:, 1]
        d = self.x[i] - self.x[j]
        L = np.linalg.norm(d, axis=1) + 1e-12
        C = L - rest
        k = np.where(C > 0, k_stretch, k_comp)
        wi = self.inv_m[i]
        wj = self.inv_m[j]
        ws = wi + wj
        ok = ws > 0
        s = np.zeros_like(L)
        s[ok] = (k[ok] * C[ok] / ws[ok]) / L[ok]
        corr = d * s[:, None]
        np.add.at(acc, i, -corr * wi[:, None])
        np.add.at(acc, j, corr * wj[:, None])
        np.add.at(cnt, i, ok.astype(float))
        np.add.at(cnt, j, ok.astype(float))

    def _pairs(self, k_soft, min_frac, acc, cnt):
        i, j = self.pairs[:, 0], self.pairs[:, 1]
        d = self.x[i] - self.x[j]
        L = np.linalg.norm(d, axis=1) + 1e-12
        lo = self.pair_rest * min_frac
        C = np.where(L < lo, L - lo, (L - self.pair_rest) * k_soft)
        wi, wj = self.inv_m[i], self.inv_m[j]
        ws = wi + wj
        ok = ws > 0
        s = np.zeros_like(L)
        s[ok] = (C[ok] / ws[ok]) / L[ok]
        corr = d * s[:, None]
        np.add.at(acc, i, -corr * wi[:, None])
        np.add.at(acc, j, corr * wj[:, None])
        np.add.at(cnt, i, ok.astype(float))
        np.add.at(cnt, j, ok.astype(float))

    def set_tethers(self, pattern_xy, slack=1.01):
        """Long-range attachments: no vertex may end up farther from its nearest pin than
        it is in the flat pattern (a lower bound on the fabric path), so gravity can't
        stretch the garment however few iterations we run."""
        free = np.where(self.inv_m > 0)[0]
        P = pattern_xy
        pp = P[self.pins]
        d = np.linalg.norm(P[free][:, None, :] - pp[None, :, :], axis=2)
        k = np.argmin(d, axis=1)
        self.teth = (free, self.pins[k], d[np.arange(len(free)), k] * slack)

    def _tethers(self):
        if not hasattr(self, "teth"):
            return
        i, p, L = self.teth
        d = self.x[i] - self.x[p]
        n = np.linalg.norm(d, axis=1) + 1e-12
        over = n > L
        self.x[i[over]] = self.x[p[over]] + d[over] * (L[over] / n[over])[:, None]

    def set_self_collision(self, pattern_xy, radius, exclude):
        """Vertex repulsion between parts of the garment that are far apart in the flat
        pattern (sleeve vs body, fold vs fold), so the drape can't pass through itself."""
        self.sc = (pattern_xy, radius, exclude)
        self.sc_pairs = None

    def _find_close(self, r):
        x = self.x
        c = np.floor(x / r).astype(np.int64) + 2048
        B = np.int64(4096)
        key = (c[:, 0] * B + c[:, 1]) * B + c[:, 2]
        order = np.argsort(key)
        ks = key[order]
        n = self.n
        I, J = [], []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    nk = key + (dx * B + dy) * B + dz
                    lo = np.searchsorted(ks, nk, "left")
                    hi = np.searchsorted(ks, nk, "right")
                    cnt = hi - lo
                    tot = cnt.sum()
                    if tot == 0:
                        continue
                    i = np.repeat(np.arange(n), cnt)
                    within = np.arange(tot) - np.repeat(np.cumsum(cnt) - cnt, cnt)
                    j = order[np.repeat(lo, cnt) + within]
                    m = i < j
                    I.append(i[m])
                    J.append(j[m])
        I = np.concatenate(I)
        J = np.concatenate(J)
        d = np.linalg.norm(x[I] - x[J], axis=1)
        m = d < r
        I, J = I[m], J[m]
        P, _, excl = self.sc
        far = np.linalg.norm(P[I] - P[J], axis=1) > excl
        return np.stack([I[far], J[far]], 1)

    def _self_collide(self, acc, cnt):
        P, r, _ = self.sc
        ij = self.sc_pairs
        if ij is None or len(ij) == 0:
            return
        i, j = ij[:, 0], ij[:, 1]
        d = self.x[i] - self.x[j]
        L = np.linalg.norm(d, axis=1) + 1e-12
        C = np.minimum(L - r, 0.0)
        wi, wj = self.inv_m[i], self.inv_m[j]
        ws = wi + wj
        ok = (ws > 0) & (C < 0)
        s = np.zeros_like(L)
        s[ok] = (C[ok] / ws[ok]) / L[ok]
        corr = d * s[:, None]
        np.add.at(acc, i, -corr * wi[:, None])
        np.add.at(acc, j, corr * wj[:, None])
        np.add.at(cnt, i, ok.astype(float))
        np.add.at(cnt, j, ok.astype(float))

    def set_guides(self, target, weight, k):
        """Soft x/z pull toward a target pose (the sleeves' hang angle is art-directed;
        depth stays free so the underarm buckles out of plane on its own)."""
        self.guide = (target, weight * k)

    def _guides(self):
        if not hasattr(self, "guide"):
            return
        t, w = self.guide
        m = w > 0
        for c in (0, 2):
            self.x[m, c] += (t[m, c] - self.x[m, c]) * w[m]

    def _bar(self):
        for bar in self.bars:
            self._capsule(*bar)

    def _capsule(self, pts, r, sy):
        x = self.x
        # distance to the polyline in a space where the bar's cross-section is round
        q = x / np.array([1.0, sy, 1.0])
        P = pts / np.array([1.0, sy, 1.0])
        best = np.full(self.n, np.inf)
        bestc = np.zeros_like(q)
        for a, b in zip(P[:-1], P[1:]):
            ab = b - a
            t = np.clip(((q - a) @ ab) / (ab @ ab), 0, 1)
            c = a + t[:, None] * ab
            dd = np.linalg.norm(q - c, axis=1)
            m = dd < best
            best[m] = dd[m]
            bestc[m] = c[m]
        R = r + 0.004
        hit = (best < R) & (self.inv_m > 0)
        if hit.any():
            dirn = (q[hit] - bestc[hit]) / (best[hit][:, None] + 1e-12)
            q2 = bestc[hit] + dirn * R
            x[hit] = q2 * np.array([1.0, sy, 1.0])

    def _sleeves_in_front(self, margin, cell, rebuild):
        x = self.x
        if rebuild or self._hf is None:
            b = x[self.body_front]
            ix = np.floor(b[:, 0] / cell).astype(int)
            iz = np.floor(b[:, 2] / cell).astype(int)
            keys = ix * 10007 + iz
            order = np.argsort(keys)
            keys_s = keys[order]
            y_s = b[order, 1]
            uniq, start = np.unique(keys_s, return_index=True)
            ymin = np.minimum.reduceat(y_s, start)
            self._hf = (uniq, ymin)
        uniq, ymin = self._hf
        s = np.where(self.sleeve & (self.inv_m > 0))[0]
        p = x[s]
        ix = np.floor(p[:, 0] / cell).astype(int)
        iz = np.floor(p[:, 2] / cell).astype(int)
        keys = ix * 10007 + iz
        pos = np.searchsorted(uniq, keys)
        pos = np.clip(pos, 0, len(uniq) - 1)
        found = uniq[pos] == keys
        limit = ymin[pos] - margin
        push = found & (p[:, 1] > limit)
        x[s[push], 1] = limit[push]

    # --- integration -----------------------------------------------------------------

    def step(self, dt, iters, damping, k_stretch, k_comp, k_bend, k_pair, min_frac, rebuild_hf):
        v = (self.x - self.prev) * (1 - damping)
        self.prev = self.x.copy()
        free = self.inv_m > 0
        self.x[free] += v[free] + GRAVITY * dt * dt
        if hasattr(self, "sc") and rebuild_hf:
            self.sc_pairs = self._find_close(self.sc[1] * 1.8)
        for _ in range(iters):
            acc = np.zeros_like(self.x)
            cnt = np.zeros(self.n)
            self._distance(self.edges, self.rest, k_stretch, k_comp, acc, cnt)
            self._distance(self.bends, self.bend_rest, k_bend, k_bend, acc, cnt)
            self._pairs(k_pair, min_frac, acc, cnt)
            if hasattr(self, "sc"):
                self._self_collide(acc, cnt)
            m = cnt > 0
            # over-relaxed Jacobi
            self.x[m] += 1.5 * acc[m] / cnt[m][:, None]
            self._guides()
            self.x[self.pins] = self.pinned
            self._tethers()
            self._bar()
            self._sleeves_in_front(0.004, 0.02, rebuild_hf)
            rebuild_hf = False

    def run(self, steps=600, dt=1 / 240, iters=20, damping=0.04, k_stretch=1.0, k_comp=0.6, k_bend=0.06,
            k_pair=0.1, min_frac=0.6, noise=0.001, seed=1, log=None):
        rng = np.random.default_rng(seed)
        # a whisper of noise so buckling picks varied directions (not a perfectly mirrored fold)
        free = self.inv_m > 0
        self.x[free] += rng.normal(0, noise, (free.sum(), 3))
        self.prev = self.x.copy()
        for s in range(steps):
            self.step(dt, iters, damping, k_stretch, k_comp, k_bend, k_pair, min_frac, s % 3 == 0)
            if log and s % 150 == 0:
                log(s, self.x)
        return self.x
