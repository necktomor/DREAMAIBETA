"""
fal.ai trellis-2 client (TRELLIS 2, 4B params, PBR materials).
Quality: 16x better than Replicate v1 (21 MB vs 1.3 MB GLB).
Cost: $0.30/call, ~5-6 min with queue.
Use as fallback when Replicate fails.
"""

import asyncio
import base64
import os
import time
import httpx
from pathlib import Path

FAL_BASE = "https://queue.fal.run/fal-ai/trellis-2"


class FalTrellisClient:
    def __init__(self):
        self._key = os.environ.get("FAL_KEY")
        self._available = bool(self._key)
        if self._available:
            self._headers = {
                "Authorization": f"Key {self._key}",
                "Content-Type": "application/json",
            }
            print("[fal.ai] TRELLIS-2 available as fallback")
        else:
            print("[fal.ai] FAL_KEY not set — fallback disabled")

    async def generate(self, image_path: str, output_glb: str) -> None:
        if not self._available:
            raise RuntimeError("fal.ai not available (no FAL_KEY)")
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._sync_generate, image_path, output_glb)

    def _sync_generate(self, image_path: str, output_glb: str) -> None:
        name = Path(image_path).name
        print(f"[fal.ai] generating {name} (PBR, ~5 min)...")
        t0 = time.time()

        b64 = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
        data_uri = f"data:image/png;base64,{b64}"

        with httpx.Client(timeout=30.0) as client:
            # Submit
            resp = client.post(
                FAL_BASE,
                headers=self._headers,
                json={"image_url": data_uri},
            )
            resp.raise_for_status()
            request_id = resp.json()["request_id"]

            # Poll up to 10 min
            for _ in range(120):
                time.sleep(5)
                status_resp = client.get(
                    f"{FAL_BASE}/requests/{request_id}/status",
                    headers=self._headers,
                    timeout=10.0,
                )
                status = status_resp.json().get("status")
                if status == "COMPLETED":
                    result = client.get(
                        f"{FAL_BASE}/requests/{request_id}",
                        headers=self._headers,
                        timeout=10.0,
                    )
                    glb_url = result.json()["model_glb"]["url"]
                    glb_resp = client.get(glb_url, timeout=120.0)
                    glb_resp.raise_for_status()
                    Path(output_glb).parent.mkdir(parents=True, exist_ok=True)
                    Path(output_glb).write_bytes(glb_resp.content)
                    elapsed = time.time() - t0
                    size_kb = Path(output_glb).stat().st_size // 1024
                    print(f"[fal.ai] {name} → {size_kb} KB in {elapsed:.0f}s")
                    return
                if status in ("FAILED", "ERROR", "CANCELLED"):
                    raise RuntimeError(f"fal.ai failed for {name}: {status}")

            raise RuntimeError(f"fal.ai timeout for {name}")
