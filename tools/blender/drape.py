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
SELF_RADIUS = 0.6  # × edge length
SELF_EXCLUDE = 3.0


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
    spacing = np.median(rest)
    d.set_self_collision(P, SELF_RADIUS * spacing, SELF_EXCLUDE * spacing)
    return d


def run(spacing=RENDER_SPACING, name="JerseyDrape", **solver):
    for n in (name, "HangerCollider"):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o)
    obj, shift = garment.build_tube(spacing, name)
    garment.build_hanger_collider().hide_render = False
    m = mesh_arrays(obj)
    d = build_solver(m)
    t = time.time()
    x = d.run(**solver)
    obj.data.vertices.foreach_set("co", x.ravel())
    obj.data.update()
    return report(obj, time.time() - t, shift)


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
