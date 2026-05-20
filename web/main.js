import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─── URLs ────────────────────────────────────────────────────────────────────
const IS_DEV = !!window.DREAMAI_DEV;
const SCENE_URL = IS_DEV ? '/api/scene' : './scene.json';
const GLB_URL   = (name) => IS_DEV ? `/api/glb/${name}` : `./glb/${name}`;

// ─── Globals ─────────────────────────────────────────────────────────────────
let scene, camera, renderer, clock;
let player, playerBody;
let keys = {}, yaw = Math.PI, pitch = -0.15;
let isLocked = false;
let sceneData = null;
let toonGradient = null;
let waterMesh = null, waterUniforms = null;
let snowParticles = null, lavaParticles = null, fireflyParticles = null;
let _terrainFn = (x, z) => 0;
let _terrainMeshGeo = null;
const collisionBoxes = [];
const flattenZones = [];
const animatedItems = [];

const WALK_SPEED = 8, RUN_SPEED = 16, GRAVITY = -25, JUMP_VEL = 10;
let velY = 0;

const GATE_KEYWORDS = /gate|arch|gatehouse|entrance|portal|doorway|drawbridge/i;

// ─── Loading progress helper ─────────────────────────────────────────────────
function setProgress(pct, text) {
  const bar = document.getElementById('loading-bar-fill');
  const lbl = document.getElementById('loading-text');
  if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
  if (lbl && text) lbl.textContent = text;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
window.startGame = async function () {
  document.getElementById('overlay').style.display = 'none';
  const loadingEl = document.getElementById('loading');
  loadingEl.style.display = 'flex';

  init();
  try { renderer.domElement.requestPointerLock(); } catch (e) { /* headless / iframe */ }
  animate();

  await loadScene();

  loadingEl.style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  document.getElementById('scene-name').style.display = 'block';
};

// ─── Init ────────────────────────────────────────────────────────────────────
function init() {
  clock = new THREE.Clock();

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1200);

  // Toon gradient (3 bands — sharp Genshin-like)
  toonGradient = makeToonGradient();

  // Note: post-processing (bloom) was removed for stability — was producing
  // colour-banding artefacts on certain GPUs. Cel-shading alone reads well.

  // Player root
  player = new THREE.Object3D();
  player.position.set(0, 5, 80);
  scene.add(player);

  // Player capsule
  playerBody = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.0, 4, 8),
    new THREE.MeshToonMaterial({ color: 0x4488ff, gradientMap: toonGradient }),
  );
  playerBody.position.y = 0.85;
  playerBody.castShadow = true;
  player.add(playerBody);

  // Input
  document.addEventListener('keydown', (e) => (keys[e.code] = true));
  document.addEventListener('keyup', (e) => (keys[e.code] = false));
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', () => {
    isLocked = !!document.pointerLockElement;
  });
  renderer.domElement.addEventListener('click', () => {
    if (!isLocked) renderer.domElement.requestPointerLock();
  });
  window.addEventListener('resize', onResize);
}

// ─── Toon gradient texture ───────────────────────────────────────────────────
function makeToonGradient() {
  // 5-band Genshin-style cel gradient with cool shadow + warm midtone bias
  // Each pixel is RGBA. Steps are sharp (NearestFilter) for hard cel bands.
  const data = new Uint8Array([
    72, 76, 92, 255,    // deep cool shadow
    122, 116, 130, 255, // shadow
    180, 168, 158, 255, // half-tone (warm)
    225, 218, 200, 255, // mid-light
    255, 250, 235, 255, // highlight
  ]);
  const tex = new THREE.DataTexture(data, 5, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ─── Load scene ──────────────────────────────────────────────────────────────
async function loadScene() {
  setProgress(2, 'Fetching scene…');
  const resp = await fetch(SCENE_URL);
  sceneData = await resp.json();
  document.getElementById('scene-name').textContent = sceneData.scene_name || 'DreamAI World';

  setProgress(8, 'Building atmosphere…');
  applyEnvironment(sceneData.environment);

  setProgress(15, 'Sculpting terrain…');
  if (sceneData.landscape) buildLandscapeFromJSON(sceneData.landscape);

  // Position player on safe spawn (we recompute after terrain rebuild)
  if (sceneData.player_spawn?.position) {
    const [x, , z] = sceneData.player_spawn.position;
    player.position.set(x, getTerrainY(x, z) + 1, z);
  }

  const loader = new GLTFLoader();
  const buildings = sceneData.buildings || [];
  const totalSteps =
    buildings.reduce((s, b) => s + (b.exterior_modules || []).length, 0) +
    (sceneData.nature_archetypes || []).length;
  let done = 0;

  for (const b of buildings) {
    const layout = b.layout_grid || {};
    const cell = layout.cell_size || 5;
    const gridMap = {};
    for (const g of layout.objects || []) gridMap[g.name] = g;
    for (const mod of b.exterior_modules || []) {
      await spawnObject(loader, mod, gridMap[mod.name] || {}, cell);
      done++;
      setProgress(20 + (done / totalSteps) * 50, `Placing ${mod.name}…`);
    }
  }

  setProgress(72, 'Re-sculpting terrain…');
  rebuildTerrainMesh();

  setProgress(78, 'Planting forest…');
  await loadNatureArchetypes(loader, sceneData.nature_archetypes || [], sceneData.landscape);

  setProgress(94, 'Finalising terrain…');
  rebuildTerrainMesh();

  // Re-snap every tree/rock to current (post-flatten) terrain so nothing floats
  resnapNatureToTerrain();
  // Re-snap building meshes too (their footprint zone might have shifted)
  resnapBuildingsToTerrain();
  // Hard force: any remaining dark-textured TRELLIS materials get re-tinted
  forceFixMaterials();

  // Spawn at angled cinematic viewpoint — see castle in 3/4 perspective, not blocked by gate
  const spawnX = 35;
  const spawnZ = 70;
  // Clear any trees within 12m of spawn so view isn't blocked
  for (let i = collisionBoxes.length - 1; i >= 0; i--) {
    const b = collisionBoxes[i];
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    if (Math.hypot(cx - spawnX, cz - spawnZ) < 12) {
      collisionBoxes.splice(i, 1);
    }
  }
  player.position.set(spawnX, getTerrainY(spawnX, spawnZ) + 1, spawnZ);
  // Face toward origin (castle keep) at a slight downward angle
  yaw = Math.atan2(spawnX, spawnZ) + Math.PI;
  pitch = 0.05;
  window.__dreamai = { scene, camera, player, getTerrainY };
  setProgress(100, 'Ready');
}

// ─── Building objects ────────────────────────────────────────────────────────
async function spawnObject(loader, mod, gdata, cellSize) {
  const url = GLB_URL(mod.name + '.glb');
  try {
    const gltf = await new Promise((res, rej) => loader.load(url, res, null, rej));
    const root = gltf.scene;

    // Cel-shaded materials (convert MeshStandard → MeshToon) with building hint
    root.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = true;
      node.receiveShadow = true;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      const replaced = mats.map((m) => convertToToon(m, 'building'));
      node.material = replaced.length === 1 ? replaced[0] : replaced;
    });

    // Add warm lantern light + glow point lights to keeps/towers
    if (/keep|tower|gatehouse/i.test(mod.name)) {
      const lantern = new THREE.PointLight(0xffaa55, 1.5, 35, 1.6);
      lantern.position.set(0, mod.real_world_size ? mod.real_world_size[1] * 0.55 : 6, 0);
      root.add(lantern);
      // Visible glow sphere so bloom catches it
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffcc77, fog: false }),
      );
      glow.position.copy(lantern.position);
      root.add(glow);
    }

    // Scale to real-world size
    if (mod.real_world_size?.length === 3) {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const modelMax = Math.max(size.x, size.y, size.z);
      const targetMax = Math.max(...mod.real_world_size);
      if (modelMax > 0) root.scale.setScalar(targetMax / modelMax);
    }

    const gx = (gdata.grid_x || 0) * cellSize;
    const gz = (gdata.grid_z || 0) * cellSize;
    const ry = THREE.MathUtils.degToRad(gdata.rotation_y || 0);
    root.position.set(gx, 0, gz);
    root.rotation.y = ry;

    const boxAfter = new THREE.Box3().setFromObject(root);
    const size3d = boxAfter.getSize(new THREE.Vector3());

    // Sample terrain at footprint, take minimum so object never floats
    const fr = Math.max(size3d.x, size3d.z) * 0.4;
    const offsets = [
      [0, 0], [fr, 0], [-fr, 0], [0, fr], [0, -fr],
      [fr * 0.7, fr * 0.7], [-fr * 0.7, fr * 0.7],
      [fr * 0.7, -fr * 0.7], [-fr * 0.7, -fr * 0.7],
    ];
    let minGroundY = Infinity;
    for (const [ox, oz] of offsets) minGroundY = Math.min(minGroundY, getTerrainY(gx + ox, gz + oz));

    // Use actual mesh bottom (no 8% percentile) so it sits flat
    const meshBottomY = boxAfter.min.y;
    // Sink 0.05m into ground to hide any geometry gap from triangle quantisation
    root.position.y = minGroundY - meshBottomY - 0.05 + (gdata.y_offset || 0);

    scene.add(root);
    buildingClones.push({ obj: root, gx, gz, fr, yOffset: gdata.y_offset || 0 });
    addCollisionBox(root, mod.name);
    registerFlattenZone(gx, gz, fr + 12, minGroundY);

    // Genshin-style outline: a slightly larger back-faced dark mesh around the building
    addOutline(root, 0.02);
  } catch (e) {
    console.warn(`Failed: ${mod.name} — ${e.message}`);
    spawnPlaceholder(mod, gdata, cellSize);
  }
}

function spawnPlaceholder(mod, gdata, cellSize) {
  const [w, h, d] = mod.real_world_size || [4, 4, 4];
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshToonMaterial({ color: 0x6633aa, gradientMap: toonGradient }),
  );
  const px = (gdata.grid_x || 0) * cellSize;
  const pz = (gdata.grid_z || 0) * cellSize;
  mesh.position.set(px, getTerrainY(px, pz) + h / 2, pz);
  mesh.castShadow = true;
  scene.add(mesh);
}

function convertToToon(m, hint = null) {
  if (!m) return new THREE.MeshToonMaterial({ color: 0xaaaaaa, gradientMap: toonGradient });
  if (m.isMeshToonMaterial) return m;
  let col;
  if (m.color) {
    col = m.color.clone();
    const lum = col.r * 0.3 + col.g * 0.59 + col.b * 0.11;
    // Lift dark albedos. If we know it's foliage → green; stone → warm grey.
    const target =
      hint === 'tree' ? new THREE.Color(0x6ea63a) :   // vibrant foliage green
      hint === 'rock' ? new THREE.Color(0x8a7a6a) :   // warm stone
      hint === 'building' ? new THREE.Color(0xc4b8a4) : // light tan stone
      new THREE.Color(0xb09680);
    if (lum < 0.2) col.lerp(target, 0.78);
    else if (lum < 0.45) col.lerp(target, 0.4);
    // Boost saturation for Genshin look
    const hsl = { h: 0, s: 0, l: 0 };
    col.getHSL(hsl);
    hsl.s = Math.min(1, hsl.s * 1.5 + 0.2);
    hsl.l = Math.max(hsl.l, 0.32);  // never let it stay too dark
    col.setHSL(hsl.h, hsl.s, hsl.l);
  } else {
    col = new THREE.Color(0xcccccc);
  }
  // If hint says foliage/rock and original has a texture, IGNORE it (TRELLIS
  // textures bake the prompt's dark background into trees → black silhouettes).
  // For buildings keep the map (gives wall/stone detail).
  const useMap = m.map && hint === 'building';
  const toon = new THREE.MeshToonMaterial({
    color: col,
    map: useMap ? m.map : null,
    gradientMap: toonGradient,
    transparent: !!m.transparent,
    opacity: m.opacity ?? 1,
    side: m.side ?? THREE.FrontSide,
  });
  // Emissive lift so silhouettes never go pure black in shadow
  toon.emissive = col.clone().multiplyScalar(0.4);
  if (m.emissive && m.emissive.getHex() !== 0) {
    toon.emissive.add(m.emissive.clone().multiplyScalar(m.emissiveIntensity ?? 1));
  }
  return toon;
}

// ─── Nature: InstancedMesh per archetype ─────────────────────────────────────
// Track every placed nature clone so we can re-snap to terrain after final rebuild
const natureClones = [];
// Track buildings the same way
const buildingClones = [];

async function loadNatureArchetypes(loader, archetypes, landscape) {
  const waterLevel = landscape?.water_level ?? 0;
  const hasWater = !!landscape?.water;

  for (const arch of archetypes) {
    const url = GLB_URL(arch.name + '.glb');
    let proto = null;
    try {
      const gltf = await new Promise((res, rej) => loader.load(url, res, null, rej));
      proto = gltf.scene;
    } catch {
      console.warn(`Archetype skipped: ${arch.name}`);
      continue;
    }

    // Cel-shading materials with hint (tree/rock for better default tinting)
    const archHint =
      /tree|pine|oak|palm|bush|bamboo|fir|cypress/i.test(arch.name) ? 'tree' :
      /rock|stone|boulder|pebble/i.test(arch.name) ? 'rock' : null;
    proto.traverse((n) => {
      if (!n.isMesh) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      n.material = mats.length === 1
        ? convertToToon(mats[0], archHint)
        : mats.map((mm) => convertToToon(mm, archHint));
    });

    // Uniformly scale proto to target real_world_size
    let baseScale = 1;
    if (arch.real_world_size?.length === 3) {
      const box = new THREE.Box3().setFromObject(proto);
      const size = box.getSize(new THREE.Vector3());
      const modelMax = Math.max(size.x, size.y, size.z);
      const targetMax = Math.max(...arch.real_world_size);
      if (modelMax > 0) baseScale = targetMax / modelMax;
    }
    proto.scale.setScalar(baseScale);
    proto.updateMatrixWorld(true);

    const dist = arch.distribute || {};
    const count = dist.count || 100;
    const minD = Math.max(dist.min_dist || 60, 55);
    const maxD = dist.max_dist || 260;
    const rng = mulberry32(hashStr(arch.name));
    const trunkR = arch.real_world_size
      ? Math.min(arch.real_world_size[0], arch.real_world_size[2]) * 0.15
      : 0.4;

    const spawnX = 35, spawnZ = 70, spawnClearR = 18;
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const d = minD + rng() * (maxD - minD);
      const x = Math.cos(angle) * d;
      const z = Math.sin(angle) * d;
      if (Math.hypot(x - spawnX, z - spawnZ) < spawnClearR) continue;
      const y = getTerrainY(x, z);
      if (hasWater && y < waterLevel + 0.5) continue;

      const clone = proto.clone(true);
      const variation = 0.8 + rng() * 0.4;
      clone.scale.multiplyScalar(variation);
      clone.position.set(x, 0, z);
      clone.rotation.y = rng() * Math.PI * 2;
      clone.traverse((n) => {
        if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
      });
      scene.add(clone);
      // Outlines disabled for trees — TRELLIS geometry doesn't shell cleanly

      // Measure THIS clone's bottom in world space (handles any model layout)
      clone.updateMatrixWorld(true);
      const cloneBox = new THREE.Box3().setFromObject(clone);
      const meshBottom = cloneBox.min.y;
      // Bury slightly into terrain so trunk is never floating (0.15m sink)
      clone.position.y = y - meshBottom - 0.15;

      natureClones.push({ obj: clone, gx: x, gz: z, sink: 0.15 });

      const r = trunkR * variation;
      collisionBoxes.push(new THREE.Box3(
        new THREE.Vector3(x - r, -999, z - r),
        new THREE.Vector3(x + r, 999, z + r),
      ));
      registerFlattenZone(x, z, r * 3);
    }
    console.log(`Placed ${arch.name}`);
  }
}

// Re-snap every placed tree/rock to current terrain height (called after the
// final rebuildTerrainMesh, so flatten zones around buildings/trees are applied)
function resnapNatureToTerrain() {
  for (const item of natureClones) {
    const { obj, gx, gz, sink } = item;
    obj.position.y = 0;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const meshBottom = box.min.y;
    const groundY = getTerrainY(gx, gz);
    obj.position.y = groundY - meshBottom - sink;
  }
}

function resnapBuildingsToTerrain() {
  for (const item of buildingClones) {
    const { obj, gx, gz, fr, yOffset } = item;
    obj.position.y = 0;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    // Sample at footprint to find lowest terrain point under building
    const offsets = [
      [0, 0], [fr, 0], [-fr, 0], [0, fr], [0, -fr],
      [fr * 0.7, fr * 0.7], [-fr * 0.7, fr * 0.7],
      [fr * 0.7, -fr * 0.7], [-fr * 0.7, -fr * 0.7],
    ];
    let minY = Infinity;
    for (const [ox, oz] of offsets) minY = Math.min(minY, getTerrainY(gx + ox, gz + oz));
    obj.position.y = minY - box.min.y - 0.05 + yOffset;
  }
}

// Walk every mesh material in the scene and force-fix dark/textured ones.
// TRELLIS-generated GLBs often ship with white color + dark baked texture →
// they read as pure black silhouettes. We strip the texture and tint by size.
function forceFixMaterials() {
  scene.traverse((n) => {
    if (!n.isMesh || !n.material) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) {
      if (!m || m.type !== 'MeshToonMaterial') continue;
      if (!m.map) continue;  // already stripped
      // Get size from geometry
      let size = 10;
      if (n.geometry) {
        n.geometry.computeBoundingBox();
        if (n.geometry.boundingBox) {
          const s = n.geometry.boundingBox.getSize(new THREE.Vector3());
          size = Math.max(s.x, s.y, s.z);
        }
      }
      m.map = null;
      if (size < 8) {
        // small → foliage
        m.color.setHex(0x6ea63a);
        m.emissive.setHex(0x2a4015);
      } else if (size < 20) {
        // medium → stone/rock
        m.color.setHex(0x9a8870);
        m.emissive.setHex(0x3a3025);
      } else {
        // large → building / wall
        m.color.setHex(0xc4b8a4);
        m.emissive.setHex(0x3a3328);
      }
      m.emissiveIntensity = 1;
      m.needsUpdate = true;
    }
  });
}

// Genshin-style inverted-hull outline (dark teal — softer than pure black)
function addOutline(root, thickness = 0.025) {
  const outlineMat = new THREE.MeshBasicMaterial({
    color: 0x101418,
    side: THREE.BackSide,
    depthWrite: true,
    fog: true,
  });
  const outlines = [];
  root.traverse((n) => {
    if (!n.isMesh || !n.geometry) return;
    const out = new THREE.Mesh(n.geometry, outlineMat);
    out.scale.setScalar(1 + thickness);
    out.position.copy(n.position);
    out.rotation.copy(n.rotation);
    out.renderOrder = -1;
    outlines.push({ src: n, out });
  });
  for (const { src, out } of outlines) src.parent.add(out);
}

// ─── Environment / Sky ───────────────────────────────────────────────────────
function applyEnvironment(env) {
  const tod = env?.time_of_day || 'night';
  const palette = {
    night:  { top: 0x101840, horiz: 0x2a3a70, light: 0xaaaaff, ambient: 0x4a5680, fog: 0x1a1f3a },
    sunset: { top: 0x6a4070, horiz: 0xff9a55, light: 0xffd098, ambient: 0xc5a070, fog: 0xc88060 },
    day:    { top: 0x4a8edb, horiz: 0x9ccfff, light: 0xfff3dc, ambient: 0xccddff, fog: 0xa0c0e0 },
  };
  const P = palette[tod] || palette.night;

  // Simple solid background + gradient sky using vertex colors (more reliable than shader)
  const skyGeo = new THREE.SphereGeometry(800, 32, 16);
  const colors = [];
  const posAttr = skyGeo.attributes.position;
  const topC = new THREE.Color(P.top);
  const horC = new THREE.Color(P.horiz);
  for (let i = 0; i < posAttr.count; i++) {
    const y = posAttr.getY(i);
    const t = Math.max(0, Math.min(1, (y + 200) / 1000));  // 0 at bottom, 1 at top
    colors.push(
      horC.r + (topC.r - horC.r) * t,
      horC.g + (topC.g - horC.g) * t,
      horC.b + (topC.b - horC.b) * t,
    );
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const skyMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -1;
  scene.add(sky);
  scene.background = new THREE.Color(P.horiz);
  renderer.setClearColor(P.horiz, 1);

  // Moon (glow handled by bloom)
  const moonColor = tod === 'sunset' ? 0xffd07a : tod === 'day' ? 0xffffff : 0xffffee;
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(14, 24, 24),
    new THREE.MeshBasicMaterial({ color: moonColor, fog: false }),
  );
  moon.position.set(220, 380, -320);
  scene.add(moon);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(22, 24, 24),
    new THREE.MeshBasicMaterial({
      color: moonColor, transparent: true, opacity: 0.18, fog: false,
    }),
  );
  halo.position.copy(moon.position);
  scene.add(halo);

  // Three-point lighting (Genshin uses sun + warm fill + cool rim)
  scene.add(new THREE.AmbientLight(0xc8d8f0, tod === 'night' ? 2.4 : 1.6));
  const hemi = new THREE.HemisphereLight(0xfff2dd, 0x4a6b3a, tod === 'night' ? 1.4 : 1.8);
  scene.add(hemi);

  // Key light — warm sun
  const dir = new THREE.DirectionalLight(P.light, tod === 'night' ? 1.6 : 3.0);
  dir.position.set(90, 180, 70);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 1;
  dir.shadow.camera.far = 500;
  dir.shadow.camera.left = -180;
  dir.shadow.camera.right = 180;
  dir.shadow.camera.top = 180;
  dir.shadow.camera.bottom = -180;
  dir.shadow.bias = -0.0005;
  scene.add(dir);

  // Rim light — cool back-light for cel-shaded silhouettes (Genshin signature)
  const rim = new THREE.DirectionalLight(0x88aaff, tod === 'night' ? 1.2 : 1.4);
  rim.position.set(-120, 80, -150);
  scene.add(rim);

  // Fill light — warm ground bounce
  const fill = new THREE.DirectionalLight(0xffd9a8, 0.6);
  fill.position.set(0, -40, 80);
  scene.add(fill);

  if (tod === 'night') addStars();
  addClouds(tod);

  if (env?.fog) {
    scene.fog = new THREE.FogExp2(P.fog, 0.0055);
  }
}

function addStars() {
  const pos = [];
  for (let i = 0; i < 2500; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.45;
    const r = 600;
    pos.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff, size: 0.9, sizeAttenuation: true, transparent: true, opacity: 0.85, fog: false,
  });
  scene.add(new THREE.Points(geo, mat));
}

function addClouds(tod) {
  const cloudColor = { night: 0x2a2a55, sunset: 0xffc4a8, day: 0xfff8f0 }[tod] || 0x2a2a55;
  const mat = new THREE.MeshBasicMaterial({
    color: cloudColor, transparent: true, opacity: tod === 'day' ? 0.85 : 0.7, fog: false, depthWrite: false,
  });
  for (let i = 0; i < 10; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const s = 10 + Math.random() * 14;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(s, 7, 7), mat);
      puff.position.set((j - n / 2) * 11 + Math.random() * 5, Math.random() * 4, Math.random() * 4);
      cloud.add(puff);
    }
    cloud.position.set(
      (Math.random() - 0.5) * 400,
      80 + Math.random() * 40,
      (Math.random() - 0.5) * 400,
    );
    cloud.userData.driftSpeed = 0.3 + Math.random() * 0.3;
    scene.add(cloud);
    animatedItems.push({ type: 'cloud', obj: cloud });
  }
}

// ─── Landscape ───────────────────────────────────────────────────────────────
function hexToColor(hex) { return new THREE.Color(hex || '#888888'); }

function buildLandscapeFromJSON(ls) {
  const hillScale = ls.hill_scale || 1.0;
  const centerElev = ls.center_elevation ?? 2;
  const waterLevel = ls.water_level ?? 0;
  const cLow = hexToColor(ls.ground_color_low || '#1a3322');
  const cHigh = hexToColor(ls.ground_color_high || '#2a5533');

  makeTerrain(600, 140,
    (x, z) => {
      const d = Math.sqrt(x * x + z * z);
      const flat = Math.max(0, 1 - d / 70);
      const base = noise(x, z) * hillScale;
      return base * (1 - flat * 0.9) + flat * centerElev;
    },
    (x, y, z) => {
      // Height-based + procedural mottling
      const t = Math.max(0, Math.min(1, (y - waterLevel) / 12));
      const mottle = (Math.sin(x * 0.5) * Math.cos(z * 0.4) + Math.sin(x * 0.13 + z * 0.11) * 0.6) * 0.06;
      const r = cLow.r + (cHigh.r - cLow.r) * t + mottle;
      const g = cLow.g + (cHigh.g - cLow.g) * t + mottle;
      const b = cLow.b + (cHigh.b - cLow.b) * t + mottle;
      return { r, g, b };
    },
  );

  if (ls.water) {
    const wColor = new THREE.Color(ls.water_color || '#1a5a8a');
    const wgeo = new THREE.PlaneGeometry(800, 800, 1, 1);
    wgeo.rotateX(-Math.PI / 2);
    waterUniforms = {
      time:        { value: 0 },
      waterColor:  { value: wColor },
      shallowColor:{ value: new THREE.Color(wColor.r * 1.4, wColor.g * 1.6, wColor.b * 1.4) },
    };
    const wmat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      vertexShader: `
        uniform float time;
        varying vec3 vWorldPosition;
        varying float vWave;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float w =
            sin(wp.x * 0.07 + time * 0.9) * 0.35 +
            cos(wp.z * 0.05 + time * 0.7) * 0.30 +
            sin((wp.x + wp.z) * 0.03 + time * 0.5) * 0.20;
          vWave = w;
          wp.y += w;
          vWorldPosition = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 waterColor;
        uniform vec3 shallowColor;
        uniform float time;
        varying vec3 vWorldPosition;
        varying float vWave;
        void main() {
          float foam = smoothstep(0.45, 0.55, vWave);
          float shimmer = sin(vWorldPosition.x * 0.4 + time * 2.0) *
                          cos(vWorldPosition.z * 0.35 + time * 1.6);
          shimmer = max(0.0, shimmer) * 0.18;
          vec3 col = mix(waterColor, shallowColor, foam + shimmer);
          gl_FragColor = vec4(col, 0.88);
        }`,
      transparent: true,
      side: THREE.DoubleSide,
    });
    waterMesh = new THREE.Mesh(wgeo, wmat);
    waterMesh.position.y = waterLevel + 0.1;
    scene.add(waterMesh);
  }

  if (ls.particles === 'snow') addSnowParticles();
  else if (ls.particles === 'ash') addLavaParticles();
  else if (ls.particles === 'fireflies') addFireflies(ls.particle_color);
  else if (ls.particles === 'rain') addRainParticles();
}

// ─── Terrain helpers ─────────────────────────────────────────────────────────
function noise(x, z) {
  return (
    Math.sin(x * 0.03 + 1.2) * Math.cos(z * 0.025) * 8 +
    Math.sin(x * 0.07 + z * 0.05) * 4 +
    Math.cos(x * 0.12 - z * 0.09 + 2.1) * 2 +
    Math.sin(x * 0.2 + z * 0.15) * 1
  );
}

function registerFlattenZone(x, z, radius, targetY = null) {
  const y = targetY !== null ? targetY : _terrainFn(x, z);
  flattenZones.push({ x, z, r: radius, y });
}

function getTerrainY(x, z) {
  const base = _terrainFn(x, z);
  if (flattenZones.length === 0) return base;
  let maxInf = 0, blendY = base;
  for (const zone of flattenZones) {
    const d = Math.sqrt((x - zone.x) ** 2 + (z - zone.z) ** 2);
    if (d < zone.r * 2.5) {
      const t = 1 - Math.min(1, d / zone.r);
      const smooth = t * t * (3 - 2 * t);
      if (smooth > maxInf) { maxInf = smooth; blendY = zone.y; }
    }
  }
  return base * (1 - maxInf) + blendY * maxInf;
}

function makeTerrain(SIZE, SEGS, heightFn, colorFn) {
  _terrainFn = heightFn;
  _terrainColorFn = colorFn;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const cols = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = heightFn(x, z);
    pos.setY(i, y);
    const c = colorFn(x, y, z);
    cols.push(c.r, c.g, c.b);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  _terrainMeshGeo = geo;
  const mat = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: toonGradient,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  scene.add(mesh);
}

let _terrainColorFn = null;

function rebuildTerrainMesh() {
  if (!_terrainMeshGeo) return;
  const pos = _terrainMeshGeo.attributes.position;
  const col = _terrainMeshGeo.attributes.color;
  const hasColor = !!col;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = getTerrainY(x, z);
    pos.setY(i, y);
    if (hasColor && _terrainColorFn) {
      const c = _terrainColorFn(x, y, z);
      col.setXYZ(i, c.r, c.g, c.b);
    }
  }
  pos.needsUpdate = true;
  if (hasColor) col.needsUpdate = true;
  _terrainMeshGeo.computeVertexNormals();
}

// ─── Particles ───────────────────────────────────────────────────────────────
function makeParticleTexture(color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, color);
  g.addColorStop(0.4, color.length === 7 ? color + '88' : color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function addSnowParticles() {
  const geo = new THREE.BufferGeometry();
  const pos = [], vel = [];
  for (let i = 0; i < 2000; i++) {
    pos.push((Math.random() - 0.5) * 500, Math.random() * 80, (Math.random() - 0.5) * 500);
    vel.push((Math.random() - 0.5) * 0.5, -(0.5 + Math.random() * 1.5), (Math.random() - 0.5) * 0.5);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('velocity', new THREE.Float32BufferAttribute(vel, 3));
  snowParticles = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xeef2ff, size: 0.8, map: makeParticleTexture('#ffffff'), transparent: true,
    depthWrite: false, alphaTest: 0.1,
  }));
  scene.add(snowParticles);
}

function addLavaParticles() {
  const geo = new THREE.BufferGeometry();
  const pos = [], vel = [];
  for (let i = 0; i < 800; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * 120;
    pos.push(Math.cos(a) * d, Math.random() * 5, Math.sin(a) * d);
    vel.push((Math.random() - 0.5) * 0.3, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 0.3);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('velocity', new THREE.Float32BufferAttribute(vel, 3));
  lavaParticles = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xff7733, size: 1.2, map: makeParticleTexture('#ff8855'),
    transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(lavaParticles);
}

function addFireflies(colorHex) {
  const color = new THREE.Color(colorHex || '#aaff77');
  const geo = new THREE.BufferGeometry();
  const pos = [], phase = [];
  for (let i = 0; i < 500; i++) {
    pos.push((Math.random() - 0.5) * 280, 1 + Math.random() * 10, (Math.random() - 0.5) * 280);
    phase.push(Math.random() * Math.PI * 2);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
  fireflyParticles = new THREE.Points(geo, new THREE.PointsMaterial({
    color, size: 1.4, map: makeParticleTexture('#ddffaa'),
    transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  scene.add(fireflyParticles);
}

function addRainParticles() {
  const geo = new THREE.BufferGeometry();
  const pos = [], vel = [];
  for (let i = 0; i < 3000; i++) {
    pos.push((Math.random() - 0.5) * 400, Math.random() * 80, (Math.random() - 0.5) * 400);
    vel.push(0.5, -(10 + Math.random() * 5), 0.2);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('velocity', new THREE.Float32BufferAttribute(vel, 3));
  snowParticles = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xaaaacc, size: 0.3, transparent: true, opacity: 0.6, depthWrite: false,
  }));
  scene.add(snowParticles);
}

// ─── Player + camera ─────────────────────────────────────────────────────────
function addCollisionBox(object3d, name = '') {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  if (GATE_KEYWORDS.test(name)) {
    const openingHalf = Math.max(size.x, size.z) * 0.20;
    if (size.x >= size.z) {
      const left = box.clone(); left.max.x = cx - openingHalf; left.min.x += size.x * 0.02;
      const right = box.clone(); right.min.x = cx + openingHalf; right.max.x -= size.x * 0.02;
      collisionBoxes.push(left, right);
    } else {
      const front = box.clone(); front.max.z = cz - openingHalf; front.min.z += size.z * 0.02;
      const back = box.clone(); back.min.z = cz + openingHalf; back.max.z -= size.z * 0.02;
      collisionBoxes.push(front, back);
    }
  } else {
    box.min.x += size.x * 0.02; box.max.x -= size.x * 0.02;
    box.min.z += size.z * 0.02; box.max.z -= size.z * 0.02;
    collisionBoxes.push(box);
  }
}

function isBlocked(x, z) {
  const tb = new THREE.Box3(
    new THREE.Vector3(x - 0.35, -999, z - 0.35),
    new THREE.Vector3(x + 0.35, 999, z + 0.35),
  );
  return collisionBoxes.some((b) => b.intersectsBox(tb));
}

function onMouseMove(e) {
  if (!isLocked) return;
  yaw -= e.movementX * 0.002;
  pitch -= e.movementY * 0.002;
  pitch = Math.max(-0.8, Math.min(1.0, pitch));
}

function updatePlayer(dt) {
  if (!sceneData) return;
  const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? RUN_SPEED : WALK_SPEED;
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const move = new THREE.Vector3();
  if (keys['KeyW'] || keys['ArrowUp']) move.add(forward);
  if (keys['KeyS'] || keys['ArrowDown']) move.sub(forward);
  if (keys['KeyA'] || keys['ArrowLeft']) move.sub(right);
  if (keys['KeyD'] || keys['ArrowRight']) move.add(right);
  if (move.length() > 0) {
    move.normalize().multiplyScalar(speed * dt);
    const nx = player.position.x + move.x;
    const nz = player.position.z + move.z;
    if (!isBlocked(nx, nz)) { player.position.x = nx; player.position.z = nz; }
    else if (!isBlocked(nx, player.position.z)) player.position.x = nx;
    else if (!isBlocked(player.position.x, nz)) player.position.z = nz;
    const angle = Math.atan2(move.x, move.z);
    playerBody.rotation.y = THREE.MathUtils.lerp(playerBody.rotation.y, angle, 0.2);
  }
  const terrainY = getTerrainY(player.position.x, player.position.z);
  velY += GRAVITY * dt;
  if (keys['Space'] && player.position.y <= terrainY + 0.1) velY = JUMP_VEL;
  player.position.y += velY * dt;
  if (player.position.y < terrainY) { player.position.y = terrainY; velY = 0; }
}

function updateCamera() {
  const dist = 8;
  const offset = new THREE.Vector3(
    -Math.sin(yaw) * Math.cos(pitch) * dist,
    Math.sin(pitch) * dist + 2.5,
    -Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  const target = player.position.clone().add(new THREE.Vector3(0, 1.6, 0));
  let camPos = target.clone().add(offset);
  const minCamY = getTerrainY(camPos.x, camPos.z) + 2.0;
  camPos.y = Math.max(camPos.y, minCamY);
  camera.position.copy(camPos);
  camera.lookAt(target);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Animation loop ──────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  updatePlayer(dt);
  updateCamera();

  if (waterUniforms) waterUniforms.time.value = t;

  if (snowParticles) {
    const p = snowParticles.geometry.attributes.position;
    const v = snowParticles.geometry.attributes.velocity;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + v.getY(i) * dt;
      if (y < 0) y = 80;
      p.setX(i, p.getX(i) + v.getX(i) * dt);
      p.setY(i, y);
      p.setZ(i, p.getZ(i) + v.getZ(i) * dt);
    }
    p.needsUpdate = true;
  }

  if (lavaParticles) {
    const p = lavaParticles.geometry.attributes.position;
    const v = lavaParticles.geometry.attributes.velocity;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + v.getY(i) * dt;
      if (y > 30) { y = 0; p.setX(i, (Math.random() - 0.5) * 200); p.setZ(i, (Math.random() - 0.5) * 200); }
      p.setY(i, y);
    }
    p.needsUpdate = true;
  }

  if (fireflyParticles) {
    const p = fireflyParticles.geometry.attributes.position;
    const ph = fireflyParticles.geometry.attributes.phase;
    for (let i = 0; i < p.count; i++) {
      const phase = ph.getX(i);
      p.setY(i, p.getY(i) + Math.sin(t * 2 + phase) * 0.02);
      p.setX(i, p.getX(i) + Math.cos(t * 1.3 + phase) * 0.03);
    }
    p.needsUpdate = true;
    fireflyParticles.material.opacity = 0.6 + Math.sin(t * 3) * 0.3;
  }

  for (const item of animatedItems) {
    if (item.type === 'cloud') {
      item.obj.position.x += item.obj.userData.driftSpeed * dt;
      if (item.obj.position.x > 250) item.obj.position.x = -250;
    }
  }

  renderer.render(scene, camera);
}

// ─── Utils ───────────────────────────────────────────────────────────────────
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
