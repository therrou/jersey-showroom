"""Pattern space → draped surface.

Every point of the flat pattern (FRONT or BACK piece) has a place on the draped garment.
Given the draped tube ('JerseyDrape': positions + pat_x/pat_y + kit UVs), this finds it by
barycentric lookup in the piece's triangles, and extends the surface affinely just past
its edges (for the collar band's lip). Used for the collar band, the low-poly render
mesh and the simulation cages, so they all sit exactly on the same drape.
"""

import numpy as np

CELL = 0.03


class PatternMap:
    def __init__(self, co, px, py, tris, face_front):
        self.co = co
        P = np.stack([px, py], 1)
        self.P = P
        self.sides = {}
        for side in (0, 1):
            T = tris[face_front == (side == 0)]
            a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
            # pattern-space inverse of [b-a, c-a] per triangle
            e1, e2 = b - a, c - a
            det = e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]
            inv = np.stack([np.stack([e2[:, 1], -e2[:, 0]], 1), np.stack([-e1[:, 1], e1[:, 0]], 1)], 1) / det[:, None, None]
            # buckets for candidate lookup
            lo = np.floor(np.minimum(np.minimum(a, b), c) / CELL).astype(int)
            hi = np.floor(np.maximum(np.maximum(a, b), c) / CELL).astype(int)
            buckets = {}
            for t in range(len(T)):
                for i in range(lo[t, 0], hi[t, 0] + 1):
                    for j in range(lo[t, 1], hi[t, 1] + 1):
                        buckets.setdefault((i, j), []).append(t)
            centroid = (a + b + c) / 3
            self.sides[side] = dict(T=T, a=a, inv=inv, buckets=buckets, centroid=centroid)

    def locate(self, side, q):
        """(triangle index into the side's T, barycentrics (3,)) for pattern point q.
        Outside the piece: the nearest triangle, barycentrics extrapolated."""
        s = self.sides[side]
        key = (int(np.floor(q[0] / CELL)), int(np.floor(q[1] / CELL)))
        best, best_bc, best_err = None, None, np.inf
        cands = s["buckets"].get(key)
        if cands is None:
            d = np.linalg.norm(s["centroid"] - q, axis=1)
            cands = np.argsort(d)[:12]
        for t in cands:
            uv = s["inv"][t] @ (q - s["a"][t])
            bc = np.array([1 - uv[0] - uv[1], uv[0], uv[1]])
            err = -min(bc.min(), 0.0)
            if err < best_err:
                best, best_bc, best_err = t, bc, err
                if err == 0:
                    break
        if best_err > 0 and cands is not None:
            # maybe a closer triangle sits in a neighbouring bucket
            d = np.linalg.norm(s["centroid"] - q, axis=1)
            for t in np.argsort(d)[:12]:
                uv = s["inv"][t] @ (q - s["a"][t])
                bc = np.array([1 - uv[0] - uv[1], uv[0], uv[1]])
                err = -min(bc.min(), 0.0)
                if err < best_err:
                    best, best_bc, best_err = t, bc, err
        return best, best_bc

    def point(self, side, q):
        t, bc = self.locate(side, np.asarray(q, float))
        tri = self.sides[side]["T"][t]
        return bc @ self.co[tri]

    def frame(self, side, q):
        """3D position, outward normal, and the 3x2 Jacobian d(position)/d(pattern)."""
        t, bc = self.locate(side, np.asarray(q, float))
        s = self.sides[side]
        tri = s["T"][t]
        X = self.co[tri]
        E = np.stack([X[1] - X[0], X[2] - X[0]], 1)  # 3x2
        J = E @ s["inv"][t]  # 3x2: pattern → 3D
        n = np.cross(X[1] - X[0], X[2] - X[0])
        n /= np.linalg.norm(n) + 1e-12
        return bc @ X, n, J


def strip_coords(rows):
    """Unfolded (along, across) metres for a strip given as rows of 3D points (one row
    per station along the strip, one point per profile sample): for bake UVs, where the
    kit UVs fold back on themselves round a rolled edge."""
    X = np.array([[x for _, x in row] for row in rows])  # (stations, profile, 3)
    along = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(X.mean(1), axis=0), axis=1))])
    across = np.concatenate([np.zeros((len(X), 1)), np.cumsum(np.linalg.norm(np.diff(X, axis=1), axis=2), axis=1)], 1)
    across = across.mean(0)  # one profile for the whole strip keeps the island rectangular
    return np.stack(np.broadcast_arrays(along[:, None], across[None, :]), -1)
