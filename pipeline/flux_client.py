"""
FLUX.1-schnell via Replicate API.
Uses same token as TRELLIS — no extra cost setup.
"""

import asyncio
import base64
import io
import os
import time
import httpx
from pathlib import Path
from PIL import Image

REPLICATE_API = "https://api.replicate.com/v1"
FLUX_MODEL_VERSION = "5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637"


class FluxClient:
    def __init__(self):
        self._token = os.environ.get("REPLICATE_API_TOKEN")
        if not self._token:
            raise EnvironmentError("Set REPLICATE_API_TOKEN env variable")
        self._headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    async def generate(self, prompt: str, output_path: str, size: str = "1024x1024") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._sync_generate, prompt, output_path)

    def _sync_generate(self, prompt: str, output_path: str) -> None:
        body = {
            "version": FLUX_MODEL_VERSION,
            "input": {
                "prompt": prompt,
                "num_outputs": 1,
                "aspect_ratio": "1:1",
                "output_format": "png",
                "output_quality": 90,
            },
        }

        with httpx.Client(timeout=60.0) as client:
            # Retry on 429 rate limit
            for attempt in range(5):
                resp = client.post(
                    f"{REPLICATE_API}/predictions",
                    headers=self._headers,
                    json=body,
                )
                if resp.status_code == 429:
                    wait = 10 * (attempt + 1)
                    print(f"[FLUX] rate limited, waiting {wait}s...")
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                break
            else:
                raise RuntimeError("FLUX rate limited after 5 attempts")
            get_url = resp.json()["urls"]["get"]

            # Poll until done
            for _ in range(30):
                time.sleep(2)
                poll = client.get(get_url, headers=self._headers)
                poll.raise_for_status()
                data = poll.json()
                if data["status"] == "succeeded":
                    img_url = data["output"][0]
                    img_resp = client.get(img_url, timeout=30.0)
                    img_resp.raise_for_status()
                    img = Image.open(io.BytesIO(img_resp.content)).convert("RGB")
                    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                    img.save(output_path, format="PNG")
                    print(f"[FLUX] saved {output_path} ({Path(output_path).stat().st_size // 1024} KB)")
                    return
                if data["status"] in ("failed", "canceled"):
                    raise RuntimeError(f"FLUX Replicate failed: {data.get('error')}")

            raise RuntimeError("FLUX Replicate timeout")
