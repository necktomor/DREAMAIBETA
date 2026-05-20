"""
Normalizes GLB files from Trellis to match real-world dimensions from scene JSON.
Uses trimesh to read bounding box, applies uniform scale, saves back to GLB.
"""

import trimesh
import numpy as np
from pathlib import Path

# Godot imports comfortably up to ~50k faces per mesh
MAX_FACES = 50_000


def normalize_glb(
    input_path: str | Path,
    output_path: str | Path,
    target_size: list[float],
    axis: str = "largest",
) -> dict:
    """
    Scale a GLB file so its bounding box matches target_size.

    Args:
        input_path:  Path to the source .glb
        output_path: Path to write the normalized .glb
        target_size: [width, height, depth] in meters (X, Y, Z)
        axis:        "largest" = uniform scale by the largest dimension (keeps proportions)
                     "all"     = non-uniform scale to exactly match all three axes

    Returns:
        dict with original_size, final_size, scale_factor
    """
    scene = trimesh.load(str(input_path), force="scene")

    # Merge all meshes to get a single bounding box
    combined = trimesh.util.concatenate(
        [g for g in scene.geometry.values()]
    )
    bounds = combined.bounds  # [[min_x, min_y, min_z], [max_x, max_y, max_z]]
    original_size = (bounds[1] - bounds[0]).tolist()

    if axis == "largest":
        # Uniform scale — preserve proportions, fit inside target_size box
        scale_factors = [
            target_size[i] / original_size[i] if original_size[i] > 0 else 1.0
            for i in range(3)
        ]
        scale = min(scale_factors)
        matrix = np.eye(4) * scale
        matrix[3, 3] = 1.0
    else:
        # Non-uniform scale — stretch to exact dimensions
        sx = target_size[0] / original_size[0] if original_size[0] > 0 else 1.0
        sy = target_size[1] / original_size[1] if original_size[1] > 0 else 1.0
        sz = target_size[2] / original_size[2] if original_size[2] > 0 else 1.0
        matrix = np.diag([sx, sy, sz, 1.0])
        scale = (sx + sy + sz) / 3  # approximate for reporting

    # Apply transform to every mesh in the scene
    scene.apply_transform(matrix)

    # Re-center at origin (bottom center)
    combined_after = trimesh.util.concatenate(
        [g for g in scene.geometry.values()]
    )
    bounds_after = combined_after.bounds
    center_xz = [(bounds_after[0][0] + bounds_after[1][0]) / 2,
                 0,
                 (bounds_after[0][2] + bounds_after[1][2]) / 2]
    translation = np.eye(4)
    translation[0, 3] = -center_xz[0]
    translation[1, 3] = -bounds_after[0][1]  # floor at y=0
    translation[2, 3] = -center_xz[2]
    scene.apply_transform(translation)

    # Simplify to MAX_FACES so Godot imports fast and runs smoothly
    combined_final = trimesh.util.concatenate(
        [g for g in scene.geometry.values()]
    )
    if len(combined_final.faces) > MAX_FACES:
        ratio = 1.0 - (MAX_FACES / len(combined_final.faces))
        try:
            import fast_simplification
            sv, sf = fast_simplification.simplify(
                combined_final.vertices,
                combined_final.faces,
                ratio,
            )
            simplified = trimesh.Trimesh(vertices=sv, faces=sf)
            scene = trimesh.scene.scene.Scene(geometry={"mesh": simplified})
            print(f"  simplified {len(combined_final.faces):,} → {len(sf):,} faces")
        except Exception as e:
            print(f"  simplify skipped: {e}")

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    scene.export(str(output_path))

    final_size = (bounds_after[1] - bounds_after[0]).tolist()

    return {
        "original_size": original_size,
        "final_size": final_size,
        "scale_factor": scale,
        "input": str(input_path),
        "output": str(output_path),
    }


def normalize_batch(objects: list[dict], raw_dir: Path, out_dir: Path) -> list[dict]:
    """
    Normalize a list of objects from scene JSON.

    Each object must have:
        name            str
        real_world_size [w, h, d]  in meters

    Expects raw GLBs at raw_dir/<name>.glb
    Writes normalized GLBs to out_dir/<name>.glb

    Returns list of result dicts (one per object).
    """
    results = []
    for obj in objects:
        name = obj["name"]
        src = raw_dir / f"{name}.glb"
        dst = out_dir / f"{name}.glb"

        if not src.exists():
            print(f"[WARN] GLB not found, skipping: {src}")
            results.append({"name": name, "status": "missing"})
            continue

        try:
            result = normalize_glb(src, dst, obj["real_world_size"])
            result["name"] = name
            result["status"] = "ok"
            print(f"[OK] {name}: {result['original_size']} → {result['final_size']}")
            results.append(result)
        except Exception as e:
            print(f"[ERROR] {name}: {e}")
            results.append({"name": name, "status": "error", "error": str(e)})

    return results


if __name__ == "__main__":
    import json, sys

    if len(sys.argv) < 4:
        print("Usage: python glb_normalizer.py scene.json raw_glb_dir/ out_glb_dir/")
        sys.exit(1)

    scene_json = Path(sys.argv[1])
    raw_dir = Path(sys.argv[2])
    out_dir = Path(sys.argv[3])

    with open(scene_json) as f:
        scene = json.load(f)

    # Collect all objects that have real_world_size
    objects = []
    for building in scene.get("buildings", []):
        for mod in building.get("exterior_modules", []):
            if "real_world_size" in mod:
                objects.append(mod)

    results = normalize_batch(objects, raw_dir, out_dir)
    print(f"\nDone: {sum(1 for r in results if r['status'] == 'ok')}/{len(results)} normalized")
