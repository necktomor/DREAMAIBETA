"""
AI Layout Planner — uses Qwen to think about spatial arrangement.
Takes all scene objects and asks Qwen to place them logically.
"""

import json
import os
from openai import AsyncOpenAI

PLANNER_API_URL = "https://llm.alem.ai/v1"
PLANNER_MODEL   = "gemma4"

PLANNER_PROMPT = """You are a 3D game level designer. Given a list of objects and the scene context, assign each object a position (x, z) in world space.

Rules:
- The player always spawns facing the main entrance (positive Z direction)
- Gates/entrances go at positive Z (+30 to +50), facing the player
- The main keep/castle goes at (0, 0) — center
- Corner towers go at (±30-40, ±20-30)
- Walls go at the sides (±45, 0)
- Decorations (fountains, altars, wells) go in the courtyard (-20 to +20 range)
- For ocean/sea biome: the main vessel (yacht/ship) goes at (0, 0), player spawns ON it at y=4
- Trees/nature objects must be placed outside the castle area (distance > 55 from center)
- No two large objects should overlap (keep 10+ meters between buildings)
- Rotation: gates face toward player (rotation_y=180), towers face outward

Output ONLY valid JSON, no explanation:
{
  "player_spawn": {"x": 0, "y": 1, "z": 70},
  "objects": [
    {"name": "object_name", "x": 0, "z": 0, "rotation_y": 0, "y_offset": 0}
  ]
}
"""


class PlannerClient:
    def __init__(self):
        api_key = os.environ.get("GEMMA_API_KEY", "sk-6ZlXpjRHKS2LtU8_cPz_og")
        self._client = AsyncOpenAI(api_key=api_key, base_url=PLANNER_API_URL)

    async def plan_layout(self, scene: dict) -> dict:
        """
        Takes scene JSON, returns updated scene with AI-planned positions.
        """
        biome = scene.get("environment", {}).get("biome", "unknown")
        tod   = scene.get("environment", {}).get("time_of_day", "day")

        # Collect all objects that need placement
        objects = []
        for building in scene.get("buildings", []):
            for mod in building.get("exterior_modules", []):
                objects.append({
                    "name": mod["name"],
                    "size": mod.get("real_world_size", [5, 5, 5]),
                    "type": "building"
                })

        if not objects:
            return scene

        user_msg = f"""Scene: {scene.get('scene_name', 'unknown')}
Biome: {biome}
Time: {tod}
Scene description: {scene.get('style', '')}

Objects to place:
{json.dumps(objects, indent=2)}

Think about the scene carefully:
- What is the most important object? (main building, vessel)
- Where should the player appear to feel immersed?
- What is the logical spatial flow? (approach path, entrance, main area)
- Are there any objects that shouldn't be near others?

Place all objects. /no_think"""

        try:
            resp = await self._client.chat.completions.create(
                model=PLANNER_MODEL,
                messages=[
                    {"role": "system", "content": PLANNER_PROMPT},
                    {"role": "user",   "content": user_msg},
                ],
                temperature=0.3,
                max_tokens=2048,
            )
            raw = (resp.choices[0].message.content or "").strip()
            if not raw:
                raise ValueError("Empty response from Qwen")

            if raw.startswith("```"):
                raw = raw.split("```")[1]
                if raw.startswith("json"):
                    raw = raw[4:]

            try:
                layout = json.loads(raw)
            except json.JSONDecodeError:
                from json_repair import repair_json
                layout = json.loads(repair_json(raw))

            print(f"[Planner] AI layout: {len(layout.get('objects', []))} objects placed")
            return _apply_layout(scene, layout)

        except Exception as e:
            print(f"[Planner] AI planning failed ({e}), using rule-based fallback")
            from pipeline.layout_fixer import fix_layout
            return fix_layout(scene)


def _apply_layout(scene: dict, layout: dict) -> dict:
    """Apply AI-generated positions to scene JSON."""
    pos_map = {o["name"]: o for o in layout.get("objects", [])}

    for building in scene.get("buildings", []):
        grid_objs  = building.get("layout_grid", {}).get("objects", [])
        grid_index = {g["name"]: g for g in grid_objs}

        for mod in building.get("exterior_modules", []):
            name = mod["name"]
            if name in pos_map:
                p = pos_map[name]
                if name in grid_index:
                    grid_index[name].update({
                        "grid_x":     p.get("x", 0),
                        "grid_z":     p.get("z", 0),
                        "rotation_y": p.get("rotation_y", 0),
                        "y_offset":   p.get("y_offset", 0),
                    })
                else:
                    grid_objs.append({
                        "name":       name,
                        "grid_x":     p.get("x", 0),
                        "grid_z":     p.get("z", 0),
                        "rotation_y": p.get("rotation_y", 0),
                        "y_offset":   p.get("y_offset", 0),
                    })

        building["layout_grid"]["cell_size"] = 1
        building["layout_grid"]["objects"]   = list(grid_index.values())

    # Player spawn from planner
    sp = layout.get("player_spawn", {})
    if sp:
        scene["player_spawn"] = {
            "location": "exterior",
            "position": [sp.get("x", 0), sp.get("y", 1), sp.get("z", 70)],
        }

    # Enforce tree clearance
    if "landscape" in scene:
        for veg in scene["landscape"].get("vegetation", []):
            veg["min_dist"] = max(veg.get("min_dist", 55), 55)
    for arch in scene.get("nature_archetypes", []):
        if "distribute" in arch:
            arch["distribute"]["min_dist"] = max(arch["distribute"].get("min_dist", 55), 55)

    return scene
