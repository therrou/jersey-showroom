"""Builds the sewn jersey tube and the hanger collider in Blender, and sets up the drape.

Frames: pattern/garment space is metres, origin at the top of the collar, +y up, +x the
viewer's right, front facing +z. In Blender (Z up) that is X = x, Z = y, Y = -z, so the
front faces -Y (Blender's Front view). The glTF exporter converts back to Y-up.

The hanger sits where src/scene/Hanger.tsx draws it relative to the collar origin, so the
draped result can be exported as-is in the frame the web code uses (hook pivot at
y = +JERSEY_DROP).
"""

import math

import bmesh
import numpy as np
import bpy
from mathutils import Vector

import pattern

JERSEY_DROP = 0.13

# Hanger.tsx bar centreline, relative to the collar origin (y = hanger y + JERSEY_DROP).
BAR_POINTS = [(-0.19, -0.066), (-0.1, -0.045), (0.0, -0.034), (0.1, -0.045), (0.19, -0.066)]
BAR_RADIUS = 0.011
BAR_DEPTH_SCALE = 0.45

# Seam points round the neck held by the hanger bar (|x| below this).
PIN_HALF_WIDTH = 0.16
PIN_GAP = 0.004
PIN_BAND = 0.001  # the seam line only: the yoke carries the rest
# The support the drape rests on: a wooden hanger like the reference photos, i.e. the
# Hanger.tsx bar curve extended to the shoulder points, with a thin, wide section
# (the visible bar is thinner; this hides inside the shoulders). Shoulders lie flat and
# slope down over it instead of wrapping a round pad.
YOKE_HALF_WIDTH = 0.235
YOKE_RADIUS = 0.014  # vertical half-thickness
YOKE_DEPTH = 0.022  # front-to-back half depth
PAD_GAP = 0.004
BODY_DEPTH = (0.03, 0.02)
SLEEVE_DEPTH = 0.034  # half depth of the sleeve tubes
ARMPIT_SOFT = (0.05, 0.16)
PREPOSE = True
FOLD_DEPTH = 0.05
FOLD_PHASE = (0.7, 2.1, -1.3)  # phases of the seeded folds (variants.py changes them)
SLEEVE_DROP_DEG = 0
SLEEVE_FORWARD = 0.045  # sleeves start (and settle) in front of the side seams
SLEEVE_BLEND = (0.0, 0.1)
SLEEVE_FORWARD_BLEND = (-0.03, 0.03)
PRESSURE = 0.0
SELF_COLLIDE_SEAM_CLEAR = 0.02


def bar_y(x):
    """Bar centreline height at x (piecewise linear through the control points)."""
    pts = BAR_POINTS
    x = max(pts[0][0], min(pts[-1][0], x))
    for i in range(1, len(pts)):
        if x <= pts[i][0]:
            (x0, y0), (x1, y1) = pts[i - 1], pts[i]
            return y0 + (x - x0) / (x1 - x0) * (y1 - y0)
    return pts[-1][1]


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def half_depth(x, y, d_seam):
    """Initial half-thickness of the tube (front at -h, back at +h): round toward the
    seams, flattened at the shoulders by the hanger."""
    body = BODY_DEPTH[0] + BODY_DEPTH[1] * smoothstep(-0.04, -0.3, y)
    sleeve = smoothstep(0.26, 0.4, abs(x)) * smoothstep(-0.2, -0.32, y)
    # sleeves are their own round tubes, deeper than the flattened body
    depth = body * (1 - sleeve) + SLEEVE_DEPTH * sleeve
    return depth * math.sqrt(smoothstep(0.0, 0.11, d_seam))


def prepose(x, y):
    """Swing a sleeve point down toward hanging, and a little forward so the sleeve
    starts in front of the body instead of inside it. Returns (dx, dy, dz) in
    garment space (dz = toward the viewer)."""
    sx, sy = pattern.LANDMARKS["shoulder"]
    axp, ayp = pattern.LANDMARKS["armpit"]
    ax = abs(x)
    # signed distance outward from the shoulder→armpit line (sleeve side positive)
    lx, ly = axp - sx, ayp - sy
    L = math.hypot(lx, ly)
    s = ((ax - sx) * ly - (y - sy) * lx) / L * -1
    w = smoothstep(SLEEVE_BLEND[0], SLEEVE_BLEND[1], s)
    # forward first (the sleeve clears the body), then the swing down
    wf = smoothstep(SLEEVE_FORWARD_BLEND[0], SLEEVE_FORWARD_BLEND[1], s)
    if w <= 0 and wf <= 0:
        return 0.0, 0.0, 0.0
    a = -math.radians(SLEEVE_DROP_DEG) * w
    rx, ry = ax - sx, y - sy
    nx = sx + rx * math.cos(a) - ry * math.sin(a)
    ny = sy + rx * math.sin(a) + ry * math.cos(a)
    sign = 1 if x >= 0 else -1
    return (nx - ax) * sign, ny - y, SLEEVE_FORWARD * wf


def fold_seed(x, y):
    """Soft vertical drape folds seeded into the body (toward the viewer = positive),
    deepening toward the hem: from the hanger's shoulder ends, plus a few irregular ones.
    Both sheets move together so the tube keeps its depth. The solver keeps them as the
    bending rest shape, so they re-form after the cloth is disturbed (like the web
    solver's drapeRest)."""
    hang = smoothstep(-0.12, -0.8, y)
    body = 1 - smoothstep(0.28, 0.36, abs(x))
    p0, p1, p2 = FOLD_PHASE
    f = (math.sin(x * 34.0 + p0 + y * 2.0) * 0.45 + math.sin(x * 57.0 + y * 6.0 + p1) * 0.25
         + math.sin(x * 19.0 + p2) * 0.3)
    return FOLD_DEPTH * hang * body * f


def fold_take_up(x, y, n=40):
    """How far x moves toward the centre so the seeded folds keep the fabric's true
    width (arc length): folded cloth is narrower, not stretched. Otherwise the stretch
    constraints would just pull the folds flat again."""
    if x == 0:
        return 0.0
    us = np.linspace(0.0, x, n + 1)
    f = np.array([fold_seed(u, y) for u in us])
    du = x / n
    slope = np.diff(f) / du
    excess = np.sum(np.sqrt(1 + slope ** 2) - 1) * du  # signed with x
    return excess


def place_yoke():
    """Hanger centreline (x, y) in the garment frame: the bar, extended along its end
    slope out to the shoulder points."""
    pts = list(BAR_POINTS)
    (x0, y0), (x1, y1) = pts[-2], pts[-1]
    slope = (y1 - y0) / (x1 - x0)
    end = (YOKE_HALF_WIDTH, y1 + slope * (YOKE_HALF_WIDTH - x1))
    xs = np.linspace(-YOKE_HALF_WIDTH, YOKE_HALF_WIDTH, 25)
    px = [-end[0]] + [p[0] for p in pts] + [end[0]]
    py = [end[1]] + [p[1] for p in pts] + [end[1]]
    return [(float(x), float(np.interp(x, px, py))) for x in xs]


def pad_half_depth(yoke, x, y):
    """Half-depth of the yoke at pattern point (x, y), 0 outside it."""
    best = 1e9
    for a, b in zip(yoke[:-1], yoke[1:]):
        best = min(best, pattern.dist_to_segment(x, y, a, b)[0])
    if best >= YOKE_RADIUS:
        return 0.0
    return YOKE_DEPTH / YOKE_RADIUS * math.sqrt(YOKE_RADIUS ** 2 - best ** 2)


def _key(p):
    return (round(p[0], 7), round(p[1], 7))


def build_tube(spacing, name, drop_shift=None):
    """Sewn FRONT+BACK tube as a Blender mesh object.

    Per-vertex attributes: pat_x, pat_y (flat pattern position), side (0 front, 1 back,
    2 on a seam), open_edge (1 on the neck/hem/cuff openings), pin (1 = held by the hanger).
    UV map 'kit' is the painter's atlas.
    Returns (object, shift) where shift is the vertical offset applied so the shoulders
    rest on the bar (reuse it for every resolution so they line up)."""
    front, back = pattern.build_pieces(spacing)

    seam_pts = set()
    for piece in (front, back):
        o = piece.outline
        for i in range(len(o)):
            if not piece.open[i]:
                seam_pts.add(_key(o[i]))
                seam_pts.add(_key(o[(i + 1) % len(o)]))
    open_pts = set()
    for piece in (front, back):
        o = piece.outline
        for i in range(len(o)):
            if piece.open[i]:
                open_pts.add((piece is back, _key(o[i])))
                open_pts.add((piece is back, _key(o[(i + 1) % len(o)])))

    segs = pattern.sewn_segments(back) + pattern.sewn_segments(front)

    def d_seam(x, y):
        return min(pattern.dist_to_segment(x, y, a, b)[0] for a, b in segs)

    yoke = place_yoke()  # garment frame (fixed, like the hanger)
    if drop_shift is None:
        # lower (or raise) the garment until its shoulder seam rests on top of the hanger
        top = lambda x: np.interp(x, [p[0] for p in yoke], [p[1] for p in yoke]) + YOKE_RADIUS
        gaps = [y - top(x) for x, y in seam_pts if abs(x) < YOKE_HALF_WIDTH and y > -0.12]
        drop_shift = min(gaps) - PAD_GAP

    pads = [(x, y + drop_shift) for x, y in yoke]  # in pattern space (before the shift)

    bm = bmesh.new()
    lay_px = bm.verts.layers.float.new("pat_x")
    lay_py = bm.verts.layers.float.new("pat_y")
    lay_side = bm.verts.layers.int.new("side")
    lay_open = bm.verts.layers.int.new("open_edge")
    lay_pin = bm.verts.layers.float.new("pin")
    lay_ds = bm.verts.layers.float.new("seam_dist")
    uv = bm.loops.layers.uv.new("kit")

    shared = {}

    def make_vert(p, side):
        k = _key(p)
        if k in seam_pts and k in shared:
            return shared[k]
        x, y = p
        on_seam = k in seam_pts
        ds = 0.0 if on_seam else d_seam(x, y)
        h = half_depth(x, y, ds)
        if 0 < ds < PIN_BAND and abs(x) < PIN_HALF_WIDTH and y > -0.1:
            h = max(h, BAR_RADIUS * BAR_DEPTH_SCALE + 0.003)
        if not on_seam:
            h = max(h, pad_half_depth(pads, x, y) + 0.006)  # start clear of the pads
        Y = (h if side == 1 else -h) - fold_seed(x, y)
        dx, dy, dz = prepose(x, y) if PREPOSE else (0.0, 0.0, 0.0)
        v = bm.verts.new((x + dx - fold_take_up(x, y), Y - dz, y + dy - drop_shift))
        v[lay_px] = x
        v[lay_py] = y
        v[lay_side] = 2 if on_seam else side
        v[lay_open] = 1 if (side == 1, k) in open_pts else 0
        v[lay_ds] = ds
        # the shoulder cap resting on the bar: the seam plus a band either side of it
        v[lay_pin] = 1.0 if (ds < PIN_BAND and abs(x) < PIN_HALF_WIDTH and y > -0.1) else 0.0
        if on_seam:
            shared[k] = v
        return v

    for side, piece in ((0, front), (1, back)):
        verts = [make_vert(p, side) for p in piece.points]
        for a, b, c in piece.tris:
            tri = (verts[a], verts[b], verts[c]) if side == 0 else (verts[a], verts[c], verts[b])
            try:
                f = bm.faces.new(tri)
            except ValueError:
                continue  # degenerate duplicate (shouldn't happen)
            for loop in f.loops:
                vx = loop.vert
                loop[uv].uv = pattern.kit_uv(vx[lay_px], vx[lay_py], side)

    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.uv_layers["kit"].active_render = True
    obj = bpy.data.objects.get(name)
    if obj:
        bpy.data.objects.remove(obj)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)

    # pins as a vertex group too (the cloth modifier wants one)
    vg = obj.vertex_groups.new(name="pins")
    pin_attr = me.attributes["pin"].data
    vg.add([i for i in range(len(me.vertices)) if pin_attr[i].value > 0.5], 1.0, "REPLACE")
    # no self-collision along the seams: there front and back are welded together and
    # closer than any collision distance, which would blow the tube apart. (Blender skips
    # triangles whose vertices are all in this group.)
    px_attr = me.attributes["pat_x"].data
    py_attr = me.attributes["pat_y"].data
    sc = obj.vertex_groups.new(name="no_self_collide")
    ds_attr = me.attributes["seam_dist"].data
    sc.add([i for i in range(len(me.vertices)) if ds_attr[i].value < SELF_COLLIDE_SEAM_CLEAR], 1.0, "REPLACE")
    # stiffness map: the fabric is stiff everywhere except round the underarm, which has
    # to buckle into folds for a kimono sleeve to drop from the pattern's 55° to hanging
    st = obj.vertex_groups.new(name="stiffness")
    ax, ay = pattern.LANDMARKS["armpit"]
    for i in range(len(me.vertices)):
        d = math.hypot(abs(px_attr[i].value) - ax, py_attr[i].value - ay)
        st.add([i], smoothstep(ARMPIT_SOFT[0], ARMPIT_SOFT[1], d), "REPLACE")
    for poly in me.polygons:
        poly.use_smooth = True

    # pads in Blender coordinates for the drape solver
    obj["yoke"] = [[x, 0.0, y - drop_shift] for x, y in pads]
    return obj, drop_shift


def build_hanger_collider(name="HangerCollider"):
    """The wooden bar from Hanger.tsx as a collision mesh (garment frame)."""
    obj = bpy.data.objects.get(name)
    if obj:
        bpy.data.objects.remove(obj)
    curve = bpy.data.curves.new(name + "Curve", "CURVE")
    curve.dimensions = "3D"
    spl = curve.splines.new("NURBS")
    spl.points.add(len(BAR_POINTS) - 1)
    for p, (x, y) in zip(spl.points, BAR_POINTS):
        p.co = (x, 0.0, y, 1.0)
    spl.order_u = 4
    spl.use_endpoint_u = True
    curve.bevel_depth = BAR_RADIUS
    curve.bevel_resolution = 4
    curve.use_fill_caps = True
    cobj = bpy.data.objects.new(name + "Tmp", curve)
    bpy.context.scene.collection.objects.link(cobj)
    deps = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(cobj.evaluated_get(deps))
    bpy.data.objects.remove(cobj)
    bpy.data.curves.remove(curve)
    for v in me.vertices:
        v.co.y *= BAR_DEPTH_SCALE
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    col = obj.modifiers.new("Collision", "COLLISION")
    obj.collision.thickness_outer = 0.003
    obj.collision.cloth_friction = 20
    return obj


def setup_cloth(obj, frames=150):
    """Blender cloth: knit polyester-ish, sewn, held by the hanger, with internal springs
    across the tube so it keeps real depth instead of collapsing into two sheets."""
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    mod = obj.modifiers.get("Cloth") or obj.modifiers.new("Cloth", "CLOTH")
    s = mod.settings
    s.quality = 12
    s.mass = 0.004
    s.air_damping = 3
    # values are the soft (underarm) end; *_max apply where the 'stiffness' group is 1
    s.vertex_group_structural_stiffness = "stiffness"
    s.vertex_group_shear_stiffness = "stiffness"
    s.vertex_group_bending = "stiffness"
    s.tension_stiffness = 30
    s.tension_stiffness_max = 40
    s.compression_stiffness = 1.0
    s.compression_stiffness_max = 15
    s.shear_stiffness = 2
    s.shear_stiffness_max = 12
    s.bending_stiffness = 0.1
    s.bending_stiffness_max = 1.5
    s.tension_damping = 5
    s.compression_damping = 2
    s.shear_damping = 5
    s.bending_damping = 0.5
    s.vertex_group_mass = "pins"
    s.pin_stiffness = 1
    s.use_internal_springs = False
    # a little air inside keeps the tube's depth (open at hem/neck/cuffs, so it is gentle)
    s.use_pressure = PRESSURE > 0
    s.uniform_pressure_force = PRESSURE
    s.use_pressure_volume = False
    c = mod.collision_settings
    c.use_collision = True
    c.distance_min = 0.003
    c.use_self_collision = True
    c.self_distance_min = 0.003
    c.vertex_group_self_collisions = "no_self_collide"
    c.self_friction = 5
    c.collision_quality = 3
    mod.point_cache.frame_start = 1
    mod.point_cache.frame_end = frames
    return mod
