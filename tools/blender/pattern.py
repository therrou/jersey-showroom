"""Flat pattern pieces for the hockey jersey, mirroring src/jersey/silhouette.ts.

Pattern space: metres, origin at the top of the collar, +x = viewer's right, +y up.
Two pieces, FRONT and BACK, share every boundary point along the sewn seams (so the
garment is a welded tube), and share the interior grid (so front/back particles pair up
exactly for the volume cross-links). The front differs only at the V-neck.

Pure Python + mathutils, no bpy: importable from any build step.
"""

import math
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

# --- silhouette.ts, verbatim ---------------------------------------------------------

RIGHT_HALF = [
    (0.0, -0.02),  # collar dip, centre front
    (0.095, 0.0),  # collar edge
    (0.235, -0.05),  # shoulder point
    (0.556, -0.509),  # cuff, outer
    (0.392, -0.632),  # cuff, inner
    (0.318, -0.335),  # armpit
    (0.326, -0.62),  # side seam
    (0.336, -0.83),  # hem corner
    (0.0, -0.845),  # hem, centre
]
LANDMARKS = {
    "shoulder": RIGHT_HALF[2],
    "cuffOuter": RIGHT_HALF[3],
    "cuffInner": RIGHT_HALF[4],
    "armpit": RIGHT_HALF[5],
    "hemCorner": RIGHT_HALF[7],
}


def chaikin(poly, iterations):
    out = poly
    for _ in range(iterations):
        nxt = []
        for i in range(len(out)):
            a = out[i]
            b = out[(i + 1) % len(out)]
            nxt.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
            nxt.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        out = nxt
    return out


def _silhouette():
    right = RIGHT_HALF
    left = [(-x, y) for (x, y) in reversed(RIGHT_HALF[1:-1])]
    return chaikin(right + left, 2)


SILHOUETTE = _silhouette()
_xs = [p[0] for p in SILHOUETTE]
_ys = [p[1] for p in SILHOUETTE]
BOUNDS = {
    "minX": -max(_xs),
    "maxX": max(_xs),
    "minY": min(_ys),
    "maxY": max(_ys),
}
BOUNDS["width"] = BOUNDS["maxX"] - BOUNDS["minX"]
BOUNDS["height"] = BOUNDS["maxY"] - BOUNDS["minY"]


def kit_uv(x, y, side):
    """The kit painter's atlas (pushVertex in JerseyGeometry.ts), Blender-style v (up).
    FRONT in u∈[0,0.5]; BACK in u∈[0.5,1], mirrored (back art is authored seen from
    behind). The web loader flips v once (glTF stores v down)."""
    u = (x - BOUNDS["minX"]) / BOUNDS["width"]
    v = (y - BOUNDS["minY"]) / BOUNDS["height"]
    return (u * 0.5, v) if side == 0 else (0.5 + (1 - u) * 0.5, v)


# --- geometry helpers ----------------------------------------------------------------


def dist_to_segment(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), t


def point_in_polygon(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def signed_distance(x, y, poly):
    d = min(dist_to_segment(x, y, poly[j - 1], poly[j])[0] for j in range(len(poly)))
    return d if point_in_polygon(x, y, poly) else -d


def resample(poly, spacing):
    """Outline resampled to ~spacing, keeping every corner (resampleOutline in TS)."""
    out = []
    for i in range(len(poly)):
        a = poly[i]
        b = poly[(i + 1) % len(poly)]
        n = max(1, round(math.hypot(b[0] - a[0], b[1] - a[1]) / spacing))
        for k in range(n):
            out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
    return out


# --- neck ----------------------------------------------------------------------------

# Front V-neck: the body is cut between the inner (y=-0.083) and outer (y=-0.12) edge of
# the rib band the painter draws (jerseyTexture.ts, "Collar"), so the separate 3D collar
# band can cover the cut with the painted band's own UVs.
NECK_X = 0.088  # where the neck opening meets the shoulder seam
V_DEPTH = -0.102


def _is_neck(p):
    return abs(p[0]) < NECK_X and p[1] > -0.035


def _is_hem(p):
    return p[1] < BOUNDS["minY"] + 0.012


def _is_cuff(p):
    a = LANDMARKS["cuffOuter"]
    b = LANDMARKS["cuffInner"]
    x = abs(p[0])
    d, t = dist_to_segment(x, p[1], a, b)
    return d < 0.012 and 0.0 < t < 1.0


# --- pieces --------------------------------------------------------------------------


class Piece:
    """One pattern piece: outline points, interior points, triangles, edge flags."""

    def __init__(self, outline, open_flags, interior):
        self.outline = outline  # list[(x,y)] counter-clockwise
        self.open = open_flags  # per outline edge i→i+1: True if not sewn
        self.points = outline + interior
        self.n_outline = len(outline)
        self.tris = []


def _ccw(poly):
    area = sum(poly[i - 1][0] * poly[i][1] - poly[i][0] * poly[i - 1][1] for i in range(len(poly)))
    return poly if area > 0 else list(reversed(poly))


def _hex_interior(spacing, poly):
    """Equilateral grid kept clear of the outline. Anchored at a fixed origin so front and
    back get identical interior points."""
    out = []
    dy = spacing * math.sqrt(3) / 2
    minx, maxx = BOUNDS["minX"], BOUNDS["maxX"]
    miny, maxy = BOUNDS["minY"], BOUNDS["maxY"]
    j0 = math.floor(miny / dy) - 1
    j1 = math.ceil(maxy / dy) + 1
    for j in range(j0, j1 + 1):
        y = j * dy
        off = spacing * 0.5 if j % 2 else 0.0
        i0 = math.floor((minx - off) / spacing) - 1
        i1 = math.ceil((maxx - off) / spacing) + 1
        for i in range(i0, i1 + 1):
            x = i * spacing + off
            if signed_distance(x, y, poly) > spacing * 0.6:
                out.append((x, y))
    return out


def _triangulate(piece):
    pts = [Vector(p) for p in piece.points]
    face = list(range(piece.n_outline))
    verts, _edges, faces, orig_v, _oe, _of = delaunay_2d_cdt(pts, [], [face], 1, 1e-7)
    # map back to our point indices (CDT may reorder / merge)
    remap = []
    for k, origs in enumerate(orig_v):
        remap.append(origs[0] if origs else None)
    tris = []
    for f in faces:
        idx = [remap[i] for i in f]
        if None in idx:
            raise RuntimeError("CDT invented a vertex; spacing too fine near the outline?")
        if len(idx) == 3:
            tris.append(tuple(idx))
        else:  # fan anything bigger (shouldn't happen with output_type 1)
            for k in range(1, len(idx) - 1):
                tris.append((idx[0], idx[k], idx[k + 1]))
    # counter-clockwise in pattern space
    P = piece.points
    fixed = []
    for a, b, c in tris:
        cross = (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[c][0] - P[a][0]) * (P[b][1] - P[a][1])
        fixed.append((a, b, c) if cross > 0 else (a, c, b))
    piece.tris = fixed


def build_pieces(spacing):
    """FRONT and BACK pieces at roughly `spacing` metres between points."""
    back_outline = _ccw(resample(SILHOUETTE, spacing))

    # FRONT: same outline, the neck replaced by a V (rounded at the bottom).
    # Walk the back outline; when we hit the neck run, splice in the V.
    n = len(back_outline)
    neck_idx = [i for i, p in enumerate(back_outline) if _is_neck(p)]
    # neck run is contiguous (possibly wrapping); find its two ends on the outline
    neck_set = set(neck_idx)
    start = next(i for i in neck_idx if (i - 1) % n not in neck_set)
    end = next(i for i in neck_idx if (i + 1) % n not in neck_set)
    a = back_outline[(start - 1) % n]  # last shoulder point before the neck
    b = back_outline[(end + 1) % n]  # first shoulder point after the neck
    v_pts = []
    bottom = (0.0, V_DEPTH)
    # two straight legs, with a small round at the bottom
    for leg_from, leg_to in ((a, bottom), (bottom, b)):
        L = math.hypot(leg_to[0] - leg_from[0], leg_to[1] - leg_from[1])
        m = max(2, round(L / spacing))
        for k in range(1, m + (1 if leg_to is bottom else 0)):
            t = k / m
            v_pts.append((leg_from[0] + (leg_to[0] - leg_from[0]) * t, leg_from[1] + (leg_to[1] - leg_from[1]) * t))
    # soften the V's tip: pull the point at the bottom up a touch
    v_pts = [(x, y + 0.006 * max(0.0, 1 - abs(x) / 0.02)) for (x, y) in v_pts]
    # does the outline run a → neck → b in increasing index order?
    front_outline = []
    i = (end + 1) % n
    while True:
        front_outline.append(back_outline[i])
        if i == (start - 1) % n:
            break
        i = (i + 1) % n
    # front_outline now runs b … a (the long way round, avoiding the neck); close with the V
    # going a → bottom → b. Orientation: back_outline is CCW, so after a comes the neck.
    front_outline = front_outline + v_pts
    front_outline = _ccw(front_outline)

    def flags(outline, neck_pred):
        out = []
        for i in range(len(outline)):
            p = outline[i]
            q = outline[(i + 1) % len(outline)]
            mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            out.append(neck_pred(mid) or _is_hem(mid) or _is_cuff(mid))
        return out

    # the back's neck opening runs a → … → b, exactly like the front's V
    back_neck = lambda m: abs(m[0]) < abs(a[0]) - 1e-6 and m[1] > -0.035
    back = Piece(back_outline, flags(back_outline, back_neck), [])
    front_neck = lambda m: abs(m[0]) < abs(a[0]) - 1e-6 and m[1] > V_DEPTH - 0.004 and m[1] < 0.0
    front = Piece(front_outline, flags(front_outline, front_neck), [])

    interior_back = _hex_interior(spacing, back_outline)
    interior_front = [p for p in interior_back if signed_distance(p[0], p[1], front_outline) > spacing * 0.6]
    back.points = back_outline + interior_back
    front.points = front_outline + interior_front
    _triangulate(back)
    _triangulate(front)
    return front, back


def sewn_segments(piece):
    """The sewn outline edges as segments, for distance-to-seam queries."""
    segs = []
    o = piece.outline
    for i in range(len(o)):
        if not piece.open[i]:
            segs.append((o[i], o[(i + 1) % len(o)]))
    return segs
