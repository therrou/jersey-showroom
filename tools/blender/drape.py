"""Step 1 of the build: pattern → sewn tube → drape on the hanger.

Run inside Blender (MCP, or `blender -b assets-src/jersey.blend --python-expr "import drape; drape.run()"`
with tools/blender on sys.path). Leaves 'JerseyDrape' (draped positions written into the
mesh) and 'HangerCollider' in the scene.
"""

import math
import time

import bpy
import numpy as np

import garment
import pattern
import xpbd

RENDER_SPACING = 0.011
SELF_RADIUS = 0.75  # × edge length
SELF_EXCLUDE = 1.2
SLEEVE_HANG_DEG = 24
SLEEVE_GUIDE_K = 0.02
SLEEVE_GAP = 0.016  # sleeve hangs this far off the body
SLEEVE_ROUND = 0.75  # sleeves keep at least this much of their tube depth


def mesh_arrays(obj):
    me = obj.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    attr = lambda name: np.array([d.value for d in me.attributes[name].data])
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    tris = np.array([tuple(p.vertices) for p in me.polygons], dtype=np.int64)
    uv = me.uv_layers["kit"].data
    face_front = np.array([uv[p.loop_start].uv[0] < 0.5 for p in me.polygons])
    return dict(co=co, px=attr("pat_x"), py=attr("pat_y"), side=attr("side").astype(int),
                pin=attr("pin") > 0.5, edges=e.reshape(-1, 2), tris=tris, face_front=face_front)


def sleeve_coordinate(px, py):
    """Signed distance outward from the hinge line shoulder → between cuff and side seam
    (positive = sleeve), and distance from the shoulder point."""
    sx, sy = pattern.LANDMARKS["shoulder"]
    ex = (pattern.LANDMARKS["cuffInner"][0] + 0.326) / 2
    ey = (pattern.LANDMARKS["cuffInner"][1] - 0.62) / 2
    lx, ly = ex - sx, ey - sy
    L = math.hypot(lx, ly)
    ax = np.abs(px)
    s = -((ax - sx) * ly - (py - sy) * lx) / L
    return s, np.hypot(ax - sx, py - sy)


def build_solver(m):
    P = np.stack([m["px"], m["py"]], 1)
    edges = m["edges"]
    rest = np.linalg.norm(P[edges[:, 0]] - P[edges[:, 1]], axis=1)

    # bending: opposite vertices across interior edges within one piece
    opp = {}
    for f, (a, b, c) in enumerate(m["tris"]):
        for u, v, o in ((a, b, c), (b, c, a), (c, a, b)):
            k = (min(u, v), max(u, v))
            opp.setdefault(k, []).append((o, m["face_front"][f]))
    bends = [(l[0][0], l[1][0]) for l in opp.values() if len(l) == 2 and l[0][1] == l[1][1]]
    bends = np.array(bends, dtype=np.int64)
    # rest = the start shape (flat pattern + seeded folds), so the folds persist
    bend_rest = np.linalg.norm(m["co"][bends[:, 0]] - m["co"][bends[:, 1]], axis=1)
    bend_rest = np.minimum(bend_rest, np.linalg.norm(P[bends[:, 0]] - P[bends[:, 1]], axis=1))

    # volume pairs: same pattern point on the front and on the back
    key = lambda i: (round(m["px"][i], 6), round(m["py"][i], 6))
    back = {key(i): i for i in np.where(m["side"] == 1)[0]}
    pairs = [(i, back[key(i)]) for i in np.where(m["side"] == 0)[0] if key(i) in back]
    pairs = np.array(pairs, dtype=np.int64)
    pair_rest = np.linalg.norm(m["co"][pairs[:, 0]] - m["co"][pairs[:, 1]], axis=1)

    s, r = sleeve_coordinate(m["px"], m["py"])
    # (the old height-field 'sleeves in front' constraint is superseded by self-collision)
    sleeve = np.zeros(len(s), dtype=bool)
    body_front = (s < -0.03) & (m["side"] == 0)

    bar = np.array([[x, 0.0, y] for x, y in garment.BAR_POINTS])
    pins = np.where(m["pin"])[0]
    d = xpbd.Drape(m["co"], edges, rest, bends, bend_rest, pairs, pair_rest, pins, sleeve, body_front,
                   (bar, garment.BAR_RADIUS, garment.BAR_DEPTH_SCALE))
    d.set_tethers(P)
    if "yoke" in m:
        d.bars.append((np.array(m["yoke"]), garment.YOKE_RADIUS, garment.YOKE_DEPTH / garment.YOKE_RADIUS))
    # sleeves: pulled (x/z only) toward the pattern pose swung down by SLEEVE_HANG_DEG
    # about the shoulder point
    if SLEEVE_HANG_DEG:
        sx, sy = pattern.LANDMARKS["shoulder"]
        ax_, ay_ = pattern.LANDMARKS["armpit"]
        lx, ly = ax_ - sx, ay_ - sy
        hs = -((np.abs(m["px"]) - sx) * ly - (m["py"] - sy) * lx) / math.hypot(lx, ly)
        w = np.clip((hs - 0.0) / 0.06, 0, 1) ** 2
        a = -math.radians(SLEEVE_HANG_DEG)
        rx, ry = np.abs(m["px"]) - sx, m["py"] - sy
        tx = (sx + rx * math.cos(a) - ry * math.sin(a)) * np.sign(m["px"])
        ty = sy + rx * math.sin(a) + ry * math.cos(a)
        target = m["co"].copy()
        target[:, 0] = tx
        target[:, 2] = ty - (m["py"] - m["co"][:, 2])  # same vertical offset (garment shift)
        d.set_guides(target, w, SLEEVE_GUIDE_K)
    spacing = np.median(rest)
    sl = (s > 0.02) & (r > 0.12)
    bd = s < -0.02
    d.set_self_collision(P, SELF_RADIUS * spacing, SELF_EXCLUDE * spacing, sl, bd, SLEEVE_GAP)
    d.pair_min = np.where(sl[pairs[:, 0]], SLEEVE_ROUND, 0.0)
    return d


def run(spacing=RENDER_SPACING, name="JerseyDrape", **solver):
    for n in (name, "HangerCollider"):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o)
    obj, shift = garment.build_tube(spacing, name)
    garment.build_hanger_collider().hide_render = False
    m = mesh_arrays(obj)
    m["yoke"] = [list(p) for p in obj["yoke"]]
    d = build_solver(m)
    t = time.time()
    x = d.run(**solver)
    x = smooth_shoulders(x, m)
    obj.data.vertices.foreach_set("co", x.ravel())
    obj.data.update()
    import collar

    collar.keep_raw(obj)
    return report(obj, time.time() - t, shift)


def smooth_shoulders(x, m, iters=12, alpha=0.5):
    """The pinned shoulder band ends on the triangle grid as a staircase; relax the
    positions across that band (and the band itself) so the shoulders read round."""
    me_d = np.array([d.value for d in bpy.data.objects["JerseyDrape"].data.attributes["seam_dist"].data]) \
        if "JerseyDrape" in bpy.data.objects else None
    ds = me_d if me_d is not None else np.zeros(len(x))
    w = np.where((m["py"] > -0.16) & (np.abs(m["px"]) < 0.3), 1.0, 0.0)
    w *= np.clip(1 - (ds - 0.06) / 0.03, 0, 1)
    w[ds == 0] *= 0.3  # the seam line itself only a little
    e = m["edges"]
    n = len(x)
    deg = np.bincount(e.ravel(), minlength=n).astype(float)
    x = x.copy()
    for _ in range(iters):
        acc = np.zeros_like(x)
        np.add.at(acc, e[:, 0], x[e[:, 1]])
        np.add.at(acc, e[:, 1], x[e[:, 0]])
        avg = acc / np.maximum(deg, 1)[:, None]
        x += (avg - x) * (alpha * w)[:, None]
    return x


def evaluated_coords(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    me = obj.evaluated_get(dg).data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def report(obj, seconds, shift):
    co = evaluated_coords(obj)
    lines = [f"sim {seconds:.1f}s shift {shift:.4f} bbox {co.min(0).round(3)} {co.max(0).round(3)}"]
    for z in (-0.1, -0.25, -0.4, -0.55, -0.7):
        sel = (abs(co[:, 0]) < 0.15) & (abs(co[:, 2] - z) < 0.02)
        if sel.any():
            lines.append(f"  z {z}: depth {np.ptp(co[sel, 1]):.3f}")
    return "\n".join(lines)
