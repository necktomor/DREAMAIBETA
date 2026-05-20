"""
Local dev server for DreamAI 3D viewer.
Serves the static web/ folder + exposes scene.json/GLB through /api/* for the
pipeline's "live regenerate" mode (sets window.DREAMAI_DEV=true in HTML).

Usage:  python web_server.py
        open http://localhost:8080
"""

import json
import os
from pathlib import Path
from http.server import HTTPServer, SimpleHTTPRequestHandler

WEB_DIR    = Path("web")
SCENE_JSON = WEB_DIR / "scene.json"
GLB_DIR    = WEB_DIR / "glb"


class DreamAIHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/scene":
            if SCENE_JSON.exists():
                data = SCENE_JSON.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_error(404, "scene.json not found — run the pipeline first")
            return

        if self.path.startswith("/api/glb/"):
            name = self.path[len("/api/glb/"):]
            glb_path = GLB_DIR / name
            if glb_path.exists():
                data = glb_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "model/gltf-binary")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_error(404, f"GLB not found: {name}")
            return

        if self.path == "/":
            self.path = "/index.html"

        file_path = WEB_DIR / self.path.lstrip("/")
        if file_path.exists() and file_path.is_file():
            data = file_path.read_bytes()
            content_types = {
                ".html": "text/html",
                ".js":   "application/javascript",
                ".css":  "text/css",
                ".json": "application/json",
                ".glb":  "model/gltf-binary",
                ".png":  "image/png",
                ".jpg":  "image/jpeg",
            }
            ct = content_types.get(file_path.suffix, "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404, f"Not found: {self.path}")

    def log_message(self, fmt, *args):
        pass  # suppress request logs


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    server = HTTPServer(("0.0.0.0", port), DreamAIHandler)
    print(f"DreamAI viewer running at http://localhost:{port}")
    print(f"Scene: {SCENE_JSON}")
    server.serve_forever()
