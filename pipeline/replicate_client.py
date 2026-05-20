"""
TRELLIS via Replicate API (A100 80GB, ~18-25s, $0.026/call).
Model: firtoz/trellis — verified 2026-05-20 (prediction 1vqp9qa39hrna0cy8aha8jvcvg)
"""

import asyncio
import base64
import os
import time
import httpx
from pathlib import Path

REPLICATE_API = "https://api.replicate.com/v1"
MODEL_VERSION  = "e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c"


class ReplicateClient:
    def __init__(self):
        self._token = os.environ.get("REPLICATE_API_TOKEN")
        if not self._token:
            raise EnvironmentError("Set REPLICATE_API_TOKEN env variable")
        self._headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }
        print("[Replicate] TRELLIS on A100 — ~20s per model, $0.026/call")

    async def generate(self, image_path: str, output_glb: str) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._sync_generate, image_path, output_glb)

    async def generate_batch(self, image_paths: list[str], output_dir: str) -> list[str]:
        """Run images sequentially with delay to avoid rate limits."""
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        results = []
        for i, img in enumerate(image_paths):
            out = str(Path(output_dir) / f"{Path(img).stem}.glb")
            if Path(out).exists():
                print(f"[Replicate] skip (cached): {Path(img).name}")
                results.append(out)
                continue
            if i > 0:
                await asyncio.sleep(3)  # avoid rate limit
            await self.generate(img, out)
            results.append(out)
        return results

    def _sync_generate(self, image_path: str, output_glb: str) -> None:
        name = Path(image_path).name
        print(f"[Replicate] generating {name}...")
        t0 = time.time()

        b64 = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
        data_uri = f"data:image/png;base64,{b64}"

        body = {
            "version": MODEL_VERSION,
            "input": {
                "images": [data_uri],
                "ss_sampling_steps": 12,
                "slat_sampling_steps": 12,
                "mesh_simplify": 0.95,
                "texture_size": 1024,
                "generate_color": True,
                "generate_model": True,
                "return_no_background": True,
            },
        }

        with httpx.Client(timeout=120.0) as client:
            for attempt in range(5):
                resp = client.post(
                    f"{REPLICATE_API}/predictions",
                    headers=self._headers,
                    json=body,
                )
                if resp.status_code == 429:
                    wait = 15 * (attempt + 1)
                    print(f"[Replicate] rate limited, waiting {wait}s...")
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                break
            else:
                raise RuntimeError("Replicate rate limited after 5 attempts")
            prediction = resp.json()
            get_url = prediction["urls"]["get"]

            # Poll until done (85s timeout per handoff doc)
            deadline = time.time() + 85
            while time.time() < deadline:
                time.sleep(2)
                poll = client.get(get_url, headers=self._headers)
                poll.raise_for_status()
                data = poll.json()
                if data["status"] == "succeeded":
                    glb_url = data["output"]["model_file"]
                    glb_resp = client.get(glb_url, timeout=60.0)
                    glb_resp.raise_for_status()
                    Path(output_glb).parent.mkdir(parents=True, exist_ok=True)
                    Path(output_glb).write_bytes(glb_resp.content)
                    elapsed = time.time() - t0
                    size_kb = Path(output_glb).stat().st_size // 1024
                    print(f"[Replicate] {name} → {size_kb} KB in {elapsed:.1f}s")
                    return
                if data["status"] in ("failed", "canceled"):
                    raise RuntimeError(f"Replicate failed: {data.get('error')}")

            raise RuntimeError(f"Replicate timeout for {name}")
