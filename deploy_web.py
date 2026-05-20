"""
Legacy compat: the pipeline already writes to web/ directly.
Kept as a no-op + sanity check for old scripts.
"""
import json
from pathlib import Path

WEB_DIR = Path("web")
SCENE_JSON = WEB_DIR / "scene.json"

def deploy():
    if not SCENE_JSON.exists():
        print("No web/scene.json found. Run pipeline first.")
        return
    glbs = list((WEB_DIR / "glb").glob("*.glb"))
    scene = json.loads(SCENE_JSON.read_text())
    print(f"Ready for GitHub Pages — web/ contains {len(glbs)} GLB(s)")
    print(f"  Scene: {scene.get('scene_name')}")
    print(f"  Biome: {scene.get('environment', {}).get('biome')}")
    print(f"\nCommit and push to deploy.")

if __name__ == "__main__":
    deploy()
