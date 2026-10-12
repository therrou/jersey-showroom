"""Quick checks on the drape: self-intersections and where the cuffs ended up."""

import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

import drape


def intersections(name="JerseyDrape"):
    obj = bpy.data.objects[name]
    co = drape.evaluated_coords(obj)
    polys = [tuple(p.vertices) for p in obj.data.polygons]
    t = BVHTree.FromPolygons([tuple(c) for c in co], polys)
    return sum(1 for a, b in t.overlap(t) if a < b and not set(polys[a]) & set(polys[b]))


def cuffs(name="JerseyDrape"):
    m = drape.mesh_arrays(bpy.data.objects[name])
    s, r = drape.sleeve_coordinate(m["px"], m["py"])
    return [m["co"][(s > 0.05) & (r > 0.45) & (np.sign(m["px"]) == g)].mean(0).round(3).tolist() for g in (-1, 1)]
