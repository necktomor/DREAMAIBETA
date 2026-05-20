"""
Main pipeline orchestrator.
Runs: Qwen → Gemma planner → FLUX → TRELLIS (Replicate / fal fallback) → normalize → web/ deploy
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

WEB_DIR        = Path("web")
WEB_GLB_DIR    = WEB_DIR / "glb"
SCENES_DIR     = Path("scenes")
IMAGES_DIR     = Path("images")
MODELS_RAW_DIR = Path("models/raw")
MODELS_NORM_DIR = Path("models/normalized")


class Pipeline:
    def __init__(self):
        self.qwen      = QwenClient()
        self.planner   = PlannerClient()
        self.flux      = FluxClient()
        self.replicate = ReplicateClient()
        self.fal       = FalTrellisClient()

    async def run(self, prompt: str, on_progress=None) -> Path:
        """
        Full pipeline. Returns path to the deployed scene JSON in web/.
        on_progress(step, pct) — optional callback (UI updates).
        """
        def progress(step: str, pct: int):
            print(f"[{pct:3d}%] {step}")
            if on_progress:
                on_progress(step, pct)

        # Step 1: Qwen — parse prompt, generate scene JSON
        progress("Analysing prompt with Qwen...", 5)
        scene: dict = await self.qwen.generate_scene(prompt)

        scene_name = scene.get("scene_name", "scene").replace(" ", "_").lower()
        scene_dir = SCENES_DIR / scene_name
        scene_dir.mkdir(parents=True, exist_ok=True)
        scene_json = scene_dir / "scene.json"

        progress("AI planner arranging scene...", 8)
        scene = await self.planner.plan_layout(scene)
        scene_json.write_text(json.dumps(scene, indent=2, ensure_ascii=False))
        progress("Scene JSON saved", 10)

        # Step 2: Collect hero objects (buildings + nature archetypes)
        hero_objects = _collect_hero_objects(scene)
        progress(f"Found {len(hero_objects)} hero objects for Trellis", 12)

        # Step 3: FLUX — generate reference images
        img_dir = IMAGES_DIR / scene_name
        img_dir.mkdir(parents=True, exist_ok=True)
        for i, obj in enumerate(hero_objects):
            pct = 15 + int(i / max(len(hero_objects), 1) * 25)
            progress(f"Generating image: {obj['name']}", pct)
            img_path = img_dir / f"{obj['name']}.png"
            if not img_path.exists():
                await self.flux.generate(obj["flux_prompt"], str(img_path))
            obj["_image_path"] = str(img_path)
        progress("All images generated", 40)

        # Step 4: TRELLIS — image → 3D
        raw_dir = MODELS_RAW_DIR / scene_name
        raw_dir.mkdir(parents=True, exist_ok=True)
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

        # Step 5: Normalize GLB scale
        progress("Normalizing GLB scale...", 72)
        norm_dir = MODELS_NORM_DIR / scene_name
        norm_dir.mkdir(parents=True, exist_ok=True)
        normalize_batch(hero_objects, raw_dir, norm_dir)
        progress("Scale normalized", 82)

        # Step 6: Deploy directly to web/ (single source of truth)
        progress("Deploying to web/ ...", 88)
        WEB_GLB_DIR.mkdir(parents=True, exist_ok=True)
        for glb in norm_dir.glob("*.glb"):
            shutil.copy2(glb, WEB_GLB_DIR / glb.name)
        web_scene_json = WEB_DIR / "scene.json"
        shutil.copy2(scene_json, web_scene_json)
        progress("Done — open web/index.html or commit to deploy.", 100)
        return web_scene_json


def _collect_hero_objects(scene: dict) -> list[dict]:
    """Return all objects with use_trellis=true — buildings AND nature archetypes."""
    result = []
    for building in scene.get("buildings", []):
        for mod in building.get("exterior_modules", []):
            if mod.get("use_trellis", False):
                result.append(mod)
    for arch in scene.get("nature_archetypes", []):
        if arch.get("use_trellis", False):
            result.append(arch)
    return result
