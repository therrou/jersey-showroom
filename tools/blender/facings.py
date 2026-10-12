"""Turned-under rib facings at the hem and both cuffs.

A real hem is folded fabric, not a paper edge: from each open edge a short strip rolls
round and runs back up inside the garment. Its UVs continue the pattern just inside the
edge, i.e. the painted rib (jerseyTexture.ts "Rib-knit hem and cuffs"), so the inside of
a cuff shows rib in the team's colour.
"""

import bmesh
import bpy
import numpy as np

import drape
import pattern
from patmap import PatternMap, strip_coords

FACING = 0.016  # how far the facing runs back up inside
THICK = 0.0025  # fabric thickness at the fold


def open_loops(obj):
    """Ordered boundary loops other than the neck."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    py = me.attributes["pat_y"].data
    bnd = [e for e in bm.edges if e.is_boundary and not all(py[v.index].value > -0.15 for v in e.verts)]
    adj = {}
    for e in bnd:
        a, b = (v.index for v in e.verts)
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    bm.free()
    loops, seen = [], set()
    for start in adj:
        if start in seen:
            continue
        loop, prev = [start], None
        seen.add(start)
        while True:
            nxt = [v for v in adj[loop[-1]] if v != prev]
            if not nxt or nxt[0] == start:
                break
            prev = loop[-1]
            loop.append(nxt[0])
            seen.add(nxt[0])
        loops.append(loop)
    return loops


def _runs(loop, side):
    """Split a closed loop at its seam vertices into single-piece runs (seams included)."""
    idx = [i for i, v in enumerate(loop) if side[v] == 2]
    runs = []
    for a, b in zip(idx, idx[1:] + [idx[0] + len(loop)]):
        run = [loop[i % len(loop)] for i in range(a, b + 1)]
        inner = [v for v in run[1:-1] if side[v] != 2]
        if inner:
            runs.append((int(np.bincount(side[inner]).argmax()), run))
    return runs


def build(obj_name="JerseyDrape", name="RibFacings"):
    obj = bpy.data.objects[obj_name]
    m = drape.mesh_arrays(obj)
    pm = PatternMap(m["co"], m["px"], m["py"], m["tris"], m["face_front"])
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("kit")
    uvb = bm.loops.layers.uv.new("bake")
    for loop in open_loops(obj):
        for s, run in _runs(loop, m["side"]):
            P = np.stack([m["px"][run], m["py"][run]], 1)
            X = m["co"][run]
            c = P.mean(0)
            rows = []
            for k in range(len(run)):
                t = P[min(k + 1, len(P) - 1)] - P[max(k - 1, 0)]
                t /= np.linalg.norm(t) + 1e-12
                nrm = np.array([-t[1], t[0]])
                # into the fabric: toward the piece, i.e. away from the opening's outside
                probe = P[k] + nrm * 0.01
                if pattern.signed_distance(probe[0], probe[1], pattern.SILHOUETTE) < pattern.signed_distance(
                    P[k][0] - nrm[0] * 0.01, P[k][1] - nrm[1] * 0.01, pattern.SILHOUETTE
                ):
                    nrm = -nrm
                _, n3, J = pm.frame(s, P[k])
                prof = [  # (along the fabric from the edge, offset along the outward normal)
                    (0.004, 0.0),
                    (0.0, -THICK * 0.2),
                    (-0.0015, -THICK * 0.7),
                    (0.0, -THICK * 1.2),
                    (0.004, -THICK * 1.3),
                    (FACING, -THICK * 1.2),
                ]
                row = []
                for along, off in prof:
                    q = P[k] + nrm * abs(along)  # UVs keep walking into the rib
                    row.append((q, X[k] + J @ (nrm * along) + n3 * off))
                rows.append(row)
            verts = [[bm.verts.new(x) for _, x in row] for row in rows]
            strip = strip_coords(rows)
            for k in range(len(rows) - 1):
                for j in range(len(rows[k]) - 1):
                    quad = [verts[k][j], verts[k][j + 1], verts[k + 1][j + 1], verts[k + 1][j]]
                    try:
                        f = bm.faces.new(quad)
                    except ValueError:
                        continue
                    for lp in f.loops:
                        kk = k if lp.vert in verts[k] else k + 1
                        jj = verts[kk].index(lp.vert)
                        q = rows[kk][jj][0]
                        lp[uvl].uv = pattern.kit_uv(q[0], q[1], s)
                        lp[uvb].uv = strip[kk][jj]
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
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
    return o
