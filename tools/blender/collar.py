"""Rib collar band: a separate rolled strip along the draped neckline.

Its UVs land on the rib band the kit painter already draws round the neck
(jerseyTexture.ts, "Collar: rib band, V on the front, scooped on the back"), so every
team's collar colour comes through with no painter change. Built per piece (FRONT strip
along the V, BACK strip along the scoop); the two meet at the shoulder seams.

Cross-section (fabric → hole): lies on the body at the painted band's outer edge, rises
over the cut edge, overhangs the opening to the painted inner edge, then rolls under.
"""

import math

import bmesh
import bpy
import numpy as np

import drape
import pattern
from patmap import PatternMap, strip_coords

# painted band edges (pattern space), from jerseyTexture.ts
FRONT_OUTER = [(-0.105, 0.01), (0.0, -0.12), (0.105, 0.01)]
FRONT_INNER = [(-0.074, 0.01), (0.0, -0.083), (0.074, 0.01)]


def _quad(p0, c, p1, n=24):
    t = np.linspace(0, 1, n)[:, None]
    p0, c, p1 = map(np.array, (p0, c, p1))
    return list(map(tuple, (1 - t) ** 2 * p0 + 2 * (1 - t) * t * c + t ** 2 * p1))


BACK_TOP = _quad((-0.105, 0.01), (0.0, -0.04), (0.105, 0.01))
BACK_BOTTOM = _quad((-0.105, -0.014), (0.0, -0.066), (0.105, -0.014))

# (offset toward the fabric as a fraction of the painted widths / metres, lift off the surface)
LIFT_BODY = 0.005
ROLL_UNDER = 0.007


def _ray_poly(p, d, poly):
    """Distance along ray p + t d (t > 0) to polyline poly, or None."""
    best = None
    for a, b in zip(poly[:-1], poly[1:]):
        a, b = np.array(a), np.array(b)
        e = b - a
        M = np.array([[d[0], -e[0]], [d[1], -e[1]]])
        det = np.linalg.det(M)
        if abs(det) < 1e-12:
            continue
        t, s = np.linalg.solve(M, a - p)
        if t > 0 and 0 <= s <= 1 and (best is None or t < best):
            best = t
    return best


def _smooth_run(P, X, pm, side, step=0.006, iters=30):
    """The drape's cut edge is as jagged as its triangles: smooth the run (pattern and
    3D together, ends fixed) and resample it evenly."""
    P, X = P.copy(), X.copy()
    for _ in range(iters):
        P[1:-1] = 0.25 * P[:-2] + 0.5 * P[1:-1] + 0.25 * P[2:]
        X[1:-1] = 0.25 * X[:-2] + 0.5 * X[1:-1] + 0.25 * X[2:]
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(round(s[-1] / step)) + 1)
    t = np.linspace(0, s[-1], n)
    P2 = np.stack([np.interp(t, s, P[:, i]) for i in range(2)], 1)
    X2 = np.stack([np.interp(t, s, X[:, i]) for i in range(3)], 1)
    return P2, X2, None


def neck_loop(obj):
    """Boundary vertex indices round the neck opening, in order."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    py = me.attributes["pat_y"].data
    bnd = [e for e in bm.edges if e.is_boundary and all(py[v.index].value > -0.15 for v in e.verts)]
    adj = {}
    for e in bnd:
        a, b = (v.index for v in e.verts)
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    start = next(iter(adj))
    loop, prev = [start], None
    while True:
        nxt = [v for v in adj[loop[-1]] if v != prev]
        if not nxt or nxt[0] == start:
            break
        prev = loop[-1]
        loop.append(nxt[0])
    bm.free()
    return loop


def keep_raw(obj):
    """Stash the raw drape (once per sim) so detail passes always start from it."""
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    a = obj.data.attributes.get("raw_co") or obj.data.attributes.new("raw_co", "FLOAT_VECTOR", "POINT")
    a.data.foreach_set("vector", co)


def restore_raw(obj):
    a = obj.data.attributes.get("raw_co")
    if a is None:
        keep_raw(obj)
        return
    co = np.empty(len(obj.data.vertices) * 3)
    a.data.foreach_get("vector", co)
    obj.data.vertices.foreach_set("co", co)
    obj.data.update()


def relax_neck(obj, loop, radius=0.06, iters=25):
    """Smooth the drape round the neck (the cut edge crumples on the triangle grid) so
    the band can sit cleanly on it. Boundary vertices smooth along the boundary only."""
    m = drape.mesh_arrays(obj)
    x = m["co"].copy()
    P = np.stack([m["px"], m["py"]], 1)
    L = P[loop]
    d = np.min(np.linalg.norm(P[:, None, :] - L[None, :, :], axis=2), axis=1)
    w = np.clip(1 - d / radius, 0, 1) ** 0.5
    w[m["pin"]] = 0
    w[loop] = 0  # the cut edge stays put (the band's own curve is smoothed separately)
    e = m["edges"]
    n = len(x)
    deg = np.bincount(e.ravel(), minlength=n).astype(float)

    def lap(x):
        acc = np.zeros_like(x)
        np.add.at(acc, e[:, 0], x[e[:, 1]])
        np.add.at(acc, e[:, 1], x[e[:, 0]])
        return acc / np.maximum(deg, 1)[:, None] - x

    # Taubin λ/μ: smooths without shrinking
    for _ in range(iters):
        x += lap(x) * (0.5 * w)[:, None]
        x += lap(x) * (-0.53 * w)[:, None]
    obj.data.vertices.foreach_set("co", x.ravel())
    obj.data.update()


def sink_under_band(obj, band_pts, depth=0.0025, radius=0.03):
    """Push the body a touch under the band's footprint so no fabric pokes through."""
    m = drape.mesh_arrays(obj)
    x = m["co"].copy()
    B = np.asarray(band_pts)
    d = np.min(np.linalg.norm(x[:, None, :] - B[None, :, :], axis=2), axis=1)
    w = np.clip(1 - d / radius, 0, 1)
    # outward normals of the drape
    me = obj.data
    me.update()
    nrm = np.empty(len(x) * 3)
    me.vertices.foreach_get("normal", nrm)
    x -= nrm.reshape(-1, 3) * (depth * w)[:, None]
    me.vertices.foreach_set("co", x.ravel())
    me.update()


def build(obj_name="JerseyDrape", name="CollarBand", keep_current=False):
    obj = bpy.data.objects[obj_name]
    if not keep_current:
        restore_raw(obj)
    relax_neck(obj, neck_loop(obj))
    m = drape.mesh_arrays(obj)
    pm = PatternMap(m["co"], m["px"], m["py"], m["tris"], m["face_front"])
    loop = neck_loop(obj)
    side = m["side"][loop]
    # split the loop at the two seam vertices into the FRONT run and the BACK run
    seams = [i for i, s in enumerate(side) if s == 2]
    assert len(seams) == 2, f"expected 2 seam points on the neck, got {len(seams)}"
    i0, i1 = seams
    run_a = loop[i0 : i1 + 1]
    run_b = loop[i1:] + loop[: i0 + 1]
    runs = {}
    for run in (run_a, run_b):
        inner = [v for v in run[1:-1]]
        s = int(np.bincount(m["side"][inner]).argmax())
        runs[s] = run

    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("kit")
    uvb = bm.loops.layers.uv.new("bake")
    for s, run in runs.items():
        P, X, N = _smooth_run(np.stack([m["px"][run], m["py"][run]], 1), m["co"][run], pm, s)
        hole = np.array([0.0, -0.045]) if s == 0 else np.array([0.0, 0.03])
        outer, inner = (FRONT_OUTER, FRONT_INNER) if s == 0 else (BACK_BOTTOM, BACK_TOP)
        rows = []  # per vertex: list of (pattern point, 3D point)
        last = (0.02, 0.01)
        for k in range(len(P)):
            p = P[k]
            t = P[min(k + 1, len(P) - 1)] - P[max(k - 1, 0)]
            t /= np.linalg.norm(t) + 1e-12
            nrm = np.array([-t[1], t[0]])
            if np.dot(nrm, p - hole) < 0:
                nrm = -nrm  # toward the fabric
            w_out = _ray_poly(p, nrm, outer)
            w_in = _ray_poly(p, -nrm, inner)
            if s == 1 and w_in is None:  # back: the cut may already be inside the band
                w_in = -(_ray_poly(p, nrm, inner) or 0.0)
            if w_out is None or w_in is None or w_out > 0.045 or w_in > 0.04:
                w_out, w_in = last
            last = (w_out, w_in)
            w_in = max(w_in, 0.004)  # always overhang the cut a little
            _, n3, J = pm.frame(s, p)
            pos = X[k]
            # cross-section: (offset toward fabric in pattern metres, lift along normal)
            prof = [
                (w_out, 0.0008),
                (w_out * 0.55, LIFT_BODY * 0.85),
                (0.0, LIFT_BODY),
                (-w_in * 0.6, LIFT_BODY * 0.95),
                (-w_in, LIFT_BODY * 0.45),
                (-w_in - 0.002, -0.0015),
                (-w_in + 0.001, -ROLL_UNDER * 0.5),
            ]
            row = []
            for o, lift in prof:
                q = p + nrm * o
                row.append((q, pos + J @ (nrm * o) + n3 * lift))
            rows.append(row)
        verts = [[bm.verts.new(x) for _, x in row] for row in rows]
        strip = strip_coords(rows)
        for k in range(len(rows) - 1):
            for j in range(len(rows[k]) - 1):
                quad = [verts[k][j], verts[k + 1][j], verts[k + 1][j + 1], verts[k][j + 1]]
                try:
                    f = bm.faces.new(quad)
                except ValueError:
                    continue
                for lp in f.loops:
                    kk = next(i for i in (k, k + 1) if lp.vert in verts[i])
                    jj = verts[kk].index(lp.vert)
                    q = rows[kk][jj][0]
                    lp[uvl].uv = pattern.kit_uv(q[0], q[1], s)
                    lp[uvb].uv = strip[kk][jj]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    footprint = [v.co.copy() for v in bm.verts]
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    o = bpy.data.objects.get(name)
    if o:
        bpy.data.objects.remove(o)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    sink_under_band(obj, footprint)
    return o
