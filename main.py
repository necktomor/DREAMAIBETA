"""
Entry point — run the full pipeline from CLI.
Usage:
    python main.py "Dark forest with a medieval castle on a hill, fog, moonlight"
"""

import asyncio
import sys
from pipeline.orchestrator import Pipeline


async def main():
    if len(sys.argv) < 2:
        print("Usage: python main.py \"your scene prompt\"")
        sys.exit(1)

    prompt = " ".join(sys.argv[1:])
    print(f"Prompt: {prompt}\n")

    pipeline = Pipeline()
    scene_json = await pipeline.run(prompt)
    print(f"\nScene JSON written to: {scene_json}")
    print("Open Godot 4, load godot_project/, and press F5 to play.")


if __name__ == "__main__":
    asyncio.run(main())
