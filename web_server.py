"""
Simple web server for DreamAI 3D viewer.
Serves Three.js frontend + scene.json + GLB files.

Usage: python web_server.py
Then open: http://localhost:8080
"""

import json
import os
from pathlib import Path
from http.server import HTTPServer, SimpleHTTPRequestHandler

WEB_DIR      = Path("web")
SCENE_JSON   = Path("unity_project/Assets/StreamingAssets/scene.json")
GLB_DIR      = Path("unity_project/Assets/StreamingAssets/glb")


class DreamAIHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # API: scene.json
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

        # API: GLB files
        if self.path.startswith("/api/glb/"):
            name = self.path[9:]  # strip /api/glb/
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

        # Static files from web/
        if self.path == "/":
            self.path = "/index.html"

        # Serve from web/ directory
        file_path = WEB_DIR / self.path.lstrip("/")
        if file_path.exists() and file_path.is_file():
            data = file_path.read_bytes()
            content_types = {
                ".html": "text/html",
                ".js":   "application/javascript",
                ".css":  "text/css",
                ".json": "application/json",
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
    print(f"GLBs:  {list(GLB_DIR.glob('*.glb')) if GLB_DIR.exists() else 'none'}")
    server.serve_forever()
