"""
Deploy current scene to web/ for GitHub Pages.
Run after pipeline generates a scene.
"""
import shutil, json
from pathlib import Path

SRC_JSON = Path("unity_project/Assets/StreamingAssets/scene.json")
SRC_GLB  = Path("unity_project/Assets/StreamingAssets/glb")
WEB_DIR  = Path("web")

def deploy():
    if not SRC_JSON.exists():
        print("No scene.json found. Run pipeline first.")
        return

    # Copy scene.json
    shutil.copy2(SRC_JSON, WEB_DIR / "scene.json")
    print(f"Copied scene.json")

    # Copy GLBs
    glb_out = WEB_DIR / "glb"
    glb_out.mkdir(exist_ok=True)
    count = 0
    for glb in SRC_GLB.glob("*.glb"):
        shutil.copy2(glb, glb_out / glb.name)
        count += 1
    print(f"Copied {count} GLB files to web/glb/")

    scene = json.loads(SRC_JSON.read_text())
    print(f"\nReady for GitHub Pages:")
    print(f"  Scene: {scene.get('scene_name')}")
    print(f"  Biome: {scene.get('environment', {}).get('biome')}")
    print(f"\nCommit and push to deploy.")

if __name__ == "__main__":
    deploy()
