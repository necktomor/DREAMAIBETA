"""
Qwen API client — parses user prompt and returns structured scene JSON.
"""

import json
import os
from openai import AsyncOpenAI  # Qwen API is OpenAI-compatible

QWEN_BASE_URL = "https://llm.alem.ai/v1"
QWEN_MODEL = "qwen3-6"

SYSTEM_PROMPT = """You are a 3D scene designer for a Genshin Impact-style game.
Given a user prompt, output ONLY valid JSON (no markdown, no explanation) describing the scene.

JSON schema:
{
  "scene_name": "string",
  "style": "string — Genshin Impact art style description",
  "environment": {
    "time_of_day": "day | sunset | night",
    "fog": true | false,
    "fog_density": 0.01-0.1,
    "biome": "dark_forest | ocean | desert | tundra | volcanic | meadow"
  },
  "nature_archetypes": [
    {
      "name": "string — snake_case id e.g. dark_pine_tree",
      "flux_prompt": "string — isolated object on white background for 3D conversion",
      "real_world_size": [w, h, d],
      "use_trellis": true,
      "distribute": {
        "count": 100-400,
        "min_dist": 50,
        "max_dist": 280
      }
    }
  ],
  "landscape": {
    "ground_color_low": "#hex — color of low areas",
    "ground_color_high": "#hex — color of high areas (hills, peaks)",
    "hill_scale": 0.5-2.0,
    "center_elevation": 0-8,
    "water": false,
    "water_color": "#hex",
    "water_level": 0.0,
    "particles": "none | snow | ash | fireflies | rain",
    "particle_color": "#hex",
    "vegetation": [
      {
        "type": "pine | palm | oak | cactus | dead_tree | bush | bamboo | mushroom",
        "count": 50-400,
        "min_dist": 40-80,
        "max_dist": 100-300,
        "height_min": 4,
        "height_max": 18,
        "color_trunk": "#hex",
        "color_leaves": "#hex"
      }
    ],
    "rocks": {
      "count": 20-120,
      "color": "#hex",
      "min_dist": 20,
      "max_dist": 280
    }
  },
  "player_spawn": {
    "location": "exterior",
    "position": [x, y, z]
  },
  "buildings": [
    {
      "name": "string",
      "layout_grid": {
        "cell_size": 5,
        "objects": [
          {"name": "string", "grid_x": 0, "grid_z": 0, "rotation_y": 0, "y_offset": 0}
        ]
      },
      "exterior_modules": [
        {
          "name": "string — unique snake_case id",
          "flux_prompt": "string — detailed Genshin style image prompt for FLUX",
          "real_world_size": [width_m, height_m, depth_m],
          "use_trellis": true
        }
      ]
    }
  ]
}

Rules:
- Maximum 6 hero objects total (use_trellis: true). These are the most visually important unique structures.
- Map size: 300-600 meters. Keep positions realistic.
- Exterior only for now — no interiors.
- player_spawn.position should be near the main entrance of the first building, y=1.
- biome must match the scene: forest/dark forest → dark_forest, sea/ocean/yacht/island → ocean, desert/ruins/sand → desert, snow/ice/winter → tundra, volcano/lava/fire → volcanic, grass/plains/meadow → meadow.
- landscape MUST be realistic for the scene. Ocean scenes need water:true, forest needs pine/oak trees, desert needs cactus, tundra needs dead_tree + snow particles, volcanic needs ash particles + no vegetation.
- center_elevation must be ≥ water_level + 2 to keep objects above water.
- vegetation count 150-350 for forests, 40-100 for deserts, 0 for volcanic.
- nature_archetypes: 2-3 objects max (tree type + rock/bush). These become real 3D GLB models. Each gets cloned many times by distribute.count. flux_prompt must show isolated single object on white background.

CRITICAL — flux_prompt format for 3D reconstruction:
Each flux_prompt must show ONE isolated object for image-to-3D conversion.
REQUIRED format: "[object], single object, isolated, pure white background, 3/4 angle view, full object visible, Genshin Impact style, cel-shaded, vibrant colors, clean edges, no shadows, no other objects, product photography lighting"

Example good prompt: "medieval stone castle tower, single object, isolated, pure white background, 3/4 angle view, full object visible, Genshin Impact style, cel-shaded, vibrant colors, clean edges, no shadows, product photography lighting"

BAD (never do this): "dark forest with castle on hill, fog, moonlight" — this is a scene, not an isolated object.
"""


class QwenClient:
    def __init__(self):
        api_key = os.environ.get("QWEN_API_KEY")
        if not api_key:
            raise EnvironmentError("Set QWEN_API_KEY env variable")
        self._client = AsyncOpenAI(api_key=api_key, base_url=QWEN_BASE_URL)

    async def generate_scene(self, prompt: str) -> dict:
        response = await self._client.chat.completions.create(
            model=QWEN_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt + " /no_think"},
            ],
            temperature=0.7,
            max_tokens=8192,
            extra_body={"enable_thinking": False},
        )
        raw = (response.choices[0].message.content or "").strip()

        # Strip markdown code fences if model wrapped the JSON
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        # Auto-repair common JSON issues (unescaped quotes in strings etc.)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            from json_repair import repair_json
            repaired = repair_json(raw)
            return json.loads(repaired)
