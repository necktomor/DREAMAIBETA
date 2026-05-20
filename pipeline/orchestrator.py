"""
Main pipeline orchestrator.
Runs: Qwen → FLUX → Hunyuan3D → GLB normalize → copy to Unity StreamingAssets
"""

import asyncio
import json
import shutil
from pathlib import Path

from pipeline.qwen_client import QwenClient
from pipeline.flux_client import FluxClient
from pipeline.replicate_client import ReplicateClient
from pipeline.fal_trellis_client import FalTrellisClient
from pipeline.glb_normalizer import normalize_batch
from pipeline.planner_client import PlannerClient

UNITY_GLB_DIR  = Path("unity_project/Assets/StreamingAssets/glb")
UNITY_JSON_DIR = Path("unity_project/Assets/StreamingAssets")
SCENES_DIR = Path("scenes")
IMAGES_DIR = Path("images")
MODELS_RAW_DIR = Path("models/raw")
MODELS_NORM_DIR = Path("models/normalized")


class Pipeline:
    def __init__(self):
        self.qwen    = QwenClient()
        self.planner = PlannerClient()
        self.flux    = FluxClient()
        self.replicate = ReplicateClient()
        self.fal = FalTrellisClient()

    async def run(self, prompt: str, on_progress=None) -> Path:
        """
        Full pipeline. Returns path to the generated scene JSON.
        on_progress(step: str, pct: int) — optional callback for UI.
        """
        def progress(step: str, pct: int):
            print(f"[{pct:3d}%] {step}")
            if on_progress:
                on_progress(step, pct)

        # ------------------------------------------------------------------
        # Step 1: Qwen — parse prompt, generate scene JSON
        # ------------------------------------------------------------------
        progress("Analysing prompt with Qwen...", 5)
        scene: dict = await self.qwen.generate_scene(prompt)

        scene_name: str = scene.get("scene_name", "scene").replace(" ", "_").lower()
        scene_dir = SCENES_DIR / scene_name
        scene_dir.mkdir(parents=True, exist_ok=True)
        scene_json = scene_dir / "scene.json"
        progress("AI planner arranging scene...", 8)
        scene = await self.planner.plan_layout(scene)
        scene_json.write_text(json.dumps(scene, indent=2, ensure_ascii=False))
        progress("Scene JSON saved", 10)

        # ------------------------------------------------------------------
        # Step 2: Collect hero objects (buildings + nature archetypes)
        # ------------------------------------------------------------------
        hero_objects = _collect_hero_objects(scene)
        progress(f"Found {len(hero_objects)} hero objects for Trellis", 12)

        # ------------------------------------------------------------------
        # Step 3: FLUX — generate reference images for hero objects
        # ------------------------------------------------------------------
        img_dir = IMAGES_DIR / scene_name
        img_dir.mkdir(parents=True, exist_ok=True)

        total_images = len(hero_objects)
        for i, obj in enumerate(hero_objects):
            pct = 15 + int(i / max(total_images, 1) * 25)
            progress(f"Generating image: {obj['name']}", pct)
            img_path = img_dir / f"{obj['name']}.png"
            if not img_path.exists():
                await self.flux.generate(obj["flux_prompt"], str(img_path))
            obj["_image_path"] = str(img_path)

        progress("All images generated", 40)

        # ------------------------------------------------------------------
        # Step 4: Trellis — image → 3D (.glb)
        # ------------------------------------------------------------------
        raw_dir = MODELS_RAW_DIR / scene_name
        raw_dir.mkdir(parents=True, exist_ok=True)

        # Collect images that need processing (skip cached)
        to_generate = [
            obj["_image_path"] for obj in hero_objects
            if not (raw_dir / f"{obj['name']}.glb").exists()
        ]

        if to_generate:
            progress(f"3D generation: {len(to_generate)} objects via Replicate A100", 42)
            try:
                await self.replicate.generate_batch(to_generate, str(raw_dir))
            except Exception as e:
                progress(f"Replicate failed ({e}), trying fal.ai...", 45)
                for img in to_generate:
                    name = Path(img).stem
                    out = str(raw_dir / f"{name}.glb")
                    if not Path(out).exists():
                        await self.fal.generate(img, out)

        progress("All 3D models generated", 70)

        # ------------------------------------------------------------------
        # Step 5: Normalize GLB scale
        # ------------------------------------------------------------------
        progress("Normalizing GLB scale...", 72)
        norm_dir = MODELS_NORM_DIR / scene_name
        norm_dir.mkdir(parents=True, exist_ok=True)
        normalize_batch(hero_objects, raw_dir, norm_dir)
        progress("Scale normalized", 80)

        # ------------------------------------------------------------------
        # Step 6: Copy normalized GLBs to Unity StreamingAssets
        # ------------------------------------------------------------------
        progress("Copying to Unity StreamingAssets...", 82)
        UNITY_GLB_DIR.mkdir(parents=True, exist_ok=True)
        UNITY_JSON_DIR.mkdir(parents=True, exist_ok=True)

        for glb in norm_dir.glob("*.glb"):
            shutil.copy2(glb, UNITY_GLB_DIR / glb.name)

        unity_scene_json = UNITY_JSON_DIR / "scene.json"
        shutil.copy2(scene_json, unity_scene_json)

        progress("Done! Launching Unity...", 100)
        _launch_unity()
        return unity_scene_json


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _launch_unity() -> None:
    import subprocess, os

    unity_project = Path("unity_project").resolve()

    candidates = [
        os.environ.get("UNITY_BIN", ""),
        "/Applications/Unity/Hub/Editor/2022.3.62f1/Unity.app/Contents/MacOS/Unity",
        "/Applications/Unity/Hub/Editor/2022.3.0f1/Unity.app/Contents/MacOS/Unity",
    ]
    # Also search Unity Hub installs dynamically
    hub_editors = Path("/Applications/Unity/Hub/Editor")
    if hub_editors.exists():
        for v in sorted(hub_editors.iterdir(), reverse=True):
            candidates.append(str(v / "Unity.app/Contents/MacOS/Unity"))

    unity_bin = next((c for c in candidates if c and Path(c).exists()), None)

    if not unity_bin:
        print("[Unity] Not found. Open unity_project/ manually in Unity Hub.")
        print(f"  Project path: {unity_project}")
        return

    print(f"[Unity] Launching: {unity_bin}")
    subprocess.Popen([unity_bin, "-projectPath", str(unity_project)])


def _launch_godot() -> None:
    import subprocess, sys, os

    godot_project = Path("godot_project").resolve()

    # Common Godot 4 locations on macOS
    candidates = [
        os.environ.get("GODOT_BIN", ""),
        str(Path.home() / "Downloads/Godot.app/Contents/MacOS/Godot"),
        "/Applications/Godot.app/Contents/MacOS/Godot",
        "/Applications/Godot_v4.3-stable_macos.universal.app/Contents/MacOS/Godot",
        "/Applications/Godot_v4.4-stable_macos.universal.app/Contents/MacOS/Godot",
        "/usr/local/bin/godot",
        "godot",
    ]

    godot_bin = next((c for c in candidates if c and Path(c).exists()), None)

    if not godot_bin:
        # Try 'godot' from PATH
        try:
            subprocess.run(["godot", "--version"], capture_output=True, check=True)
            godot_bin = "godot"
        except Exception:
            print("[Godot] Not found. Open godot_project/ manually in Godot 4.")
            return

    print(f"[Godot] Launching: {godot_bin}")
    subprocess.Popen([godot_bin, "--path", str(godot_project)])


def _collect_hero_objects(scene: dict) -> list[dict]:
    """Return all objects with use_trellis=true — buildings AND nature archetypes."""
    result = []
    for building in scene.get("buildings", []):
        for mod in building.get("exterior_modules", []):
            if mod.get("use_trellis", False):
                result.append(mod)
    # Nature archetypes (trees, rocks, bushes generated by TRELLIS)
    for arch in scene.get("nature_archetypes", []):
        if arch.get("use_trellis", False):
            result.append(arch)
    return result
