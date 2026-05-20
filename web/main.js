import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Static mode (GitHub Pages) vs local dev server
const IS_STATIC = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
const SCENE_URL = IS_STATIC ? './scene.json'  : '/api/scene';
const GLB_URL   = (name)   => IS_STATIC ? `./glb/${name}` : `/api/glb/${name}`;

// ─── Scene globals ────────────────────────────────────────────────────────────
let scene, camera, renderer, clock;
let player, playerBody;
let keys = {};
let yaw = 0, pitch = -0.3;
let isLocked = false;
let sceneData = null;

const WALK_SPEED = 8;
const RUN_SPEED  = 16;
const GRAVITY    = -25;
const JUMP_VEL   = 10;
let velY = 0;
const GROUND_Y = 0;

// ─── Entry point ─────────────────────────────────────────────────────────────
window.startGame = async function() {
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('loading').style.display = 'block';

  init();

  // Request pointer lock immediately (must be synchronous in click handler)
  renderer.domElement.requestPointerLock();

  animate();

  await loadScene();

  document.getElementById('loading').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  document.getElementById('scene-name').style.display = 'block';
};

// ─── Init ────────────────────────────────────────────────────────────────────
function init() {
  clock = new THREE.Clock();

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  document.body.appendChild(renderer.domElement);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d2b); // night sky default
  renderer.setClearColor(0x0d0d2b);

  // Camera (third-person, follows player)
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);

  // Biome built after scene loads (needs biome from JSON)
  // placeholder flat ground so player doesn't fall
  const tempGround = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshLambertMaterial({ color: 0x1a3322 })
  );
  tempGround.rotation.x = -Math.PI / 2;
  scene.add(tempGround);

  // Player (invisible body)
  player = new THREE.Object3D();
  player.position.set(0, 0.9, 20);
  scene.add(player);

  // Player visual (capsule placeholder)
  playerBody = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.0, 4, 8),
    new THREE.MeshToonMaterial({ color: 0x4488ff })
  );
  playerBody.position.y = 0.85;
  playerBody.castShadow = true;
  player.add(playerBody);

  // Input
  document.addEventListener('keydown', e => keys[e.code] = true);
  document.addEventListener('keyup',   e => keys[e.code] = false);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', () => {
    isLocked = !!document.pointerLockElement;
  });
  // Re-lock on canvas click if lost
  renderer.domElement.addEventListener('click', () => {
    if (!isLocked) renderer.domElement.requestPointerLock();
  });
  window.addEventListener('resize', onResize);
}

// ─── Load scene ──────────────────────────────────────────────────────────────
async function loadScene() {
  const resp = await fetch(SCENE_URL);
  sceneData = await resp.json();

  document.getElementById('scene-name').textContent = sceneData.scene_name || 'DreamAI World';

  // Apply environment FIRST so sky/moon/fog appear immediately
  applyEnvironment(sceneData.environment);
  renderer.setClearColor(scene.background);

  // Build landscape from JSON
  if (sceneData.landscape) buildLandscapeFromJSON(sceneData.landscape);

  // Remove temp ground
  const temp = scene.getObjectByName('__tempGround');
  if (temp) scene.remove(temp);

  // Spawn position — place on terrain surface
  if (sceneData.player_spawn?.position) {
    const [x, , z] = sceneData.player_spawn.position;
    player.position.set(x, getTerrainY(x, z), z);
  }

  const loader = new GLTFLoader();

  // Load building GLBs first (they define flatten zones)
  const buildings = sceneData.buildings || [];

  for (const building of buildings) {
    const layout  = building.layout_grid || {};
    const cell    = layout.cell_size || 5;
    const gridMap = {};
    for (const g of (layout.objects || [])) gridMap[g.name] = g;

    for (const mod of (building.exterior_modules || [])) {
      const gdata = gridMap[mod.name] || {};
      await spawnObject(loader, mod, gdata, cell);
    }
  }

  // Rebuild terrain with flatten zones from buildings
  rebuildTerrainMesh();

  // Now load nature archetypes (trees placed on already-flattened terrain)
  await loadNatureArchetypes(loader, sceneData.nature_archetypes || [], sceneData.landscape);

  // Rebuild again after trees register their flatten zones
  rebuildTerrainMesh();
}

async function loadNatureArchetypes(loader, archetypes, landscape) {
  const waterLevel = landscape?.water_level ?? 0;

  for (const arch of archetypes) {
    const url = GLB_URL(arch.name + '.glb');
    let proto = null;

    try {
      const gltf = await new Promise((res, rej) => loader.load(url, res, null, rej));
      proto = gltf.scene;
      // Scale to real_world_size
      if (arch.real_world_size?.length === 3) {
        const box = new THREE.Box3().setFromObject(proto);
        const size = box.getSize(new THREE.Vector3());
        const modelMax  = Math.max(size.x, size.y, size.z);
        const targetMax = Math.max(...arch.real_world_size);
        if (modelMax > 0) proto.scale.setScalar(targetMax / modelMax);
      }
      proto.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
    } catch {
      console.warn(`Nature archetype GLB not found: ${arch.name} — skipping`);
      continue;
    }

    // Distribute clones across terrain
    const dist  = arch.distribute || {};
    const count = dist.count   || 100;
    const minD  = dist.min_dist || 60;
    const maxD  = dist.max_dist || 260;
    const rng   = mulberry32(hashStr(arch.name));

    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const d     = minD + rng() * (maxD - minD);
      const x = Math.cos(angle) * d;
      const z = Math.sin(angle) * d;
      const y = getTerrainY(x, z);
      if (landscape?.water && y < waterLevel + 0.5) continue;

      const clone = proto.clone(true);
      // Lift so bottom sits on ground
      const box = new THREE.Box3().setFromObject(clone);
      clone.position.set(x, y - box.min.y, z);
      clone.rotation.y = rng() * Math.PI * 2;
      // Slight random scale variation
      const sv = 0.7 + rng() * 0.6;
      clone.scale.multiplyScalar(sv);
      scene.add(clone);
      // Trunk-width collision (narrow so you can walk around, not through)
      const trunkR = arch.real_world_size ? Math.min(arch.real_world_size[0], arch.real_world_size[2]) * 0.15 : 0.4;
      collisionBoxes.push(new THREE.Box3(
        new THREE.Vector3(x - trunkR, -999, z - trunkR),
        new THREE.Vector3(x + trunkR,  999, z + trunkR)
      ));
      // Small flatten zone at tree base so it doesn't float
      registerFlattenZone(x, z, trunkR * 3);
    }
    console.log(`Nature: placed ${count}× ${arch.name}`);
  }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

async function spawnObject(loader, mod, gdata, cellSize) {
  const url = GLB_URL(mod.name + '.glb');

  try {
    const gltf = await new Promise((res, rej) => loader.load(url, res, null, rej));
    const root = gltf.scene;

    // Keep original GLB materials — just enable shadows
    root.traverse(node => {
      if (node.isMesh) {
        node.castShadow    = true;
        node.receiveShadow = true;
        // Boost brightness on standard materials
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach(m => {
          if (m?.isMeshStandardMaterial) {
            m.roughness  = Math.min(m.roughness + 0.1, 1.0);
            m.metalness  = Math.max(m.metalness - 0.1, 0.0);
          }
        });
      }
    });

    // Scale to real-world size
    if (mod.real_world_size?.length === 3) {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const modelMax  = Math.max(size.x, size.y, size.z);
      const targetMax = Math.max(...mod.real_world_size);
      if (modelMax > 0) root.scale.setScalar(targetMax / modelMax);
    }

    // Position from grid — lift model so its bottom sits on ground
    const gx = (gdata.grid_x || 0) * cellSize;
    const gz = (gdata.grid_z || 0) * cellSize;
    const ry = THREE.MathUtils.degToRad(gdata.rotation_y || 0);
    root.position.set(gx, 0, gz);
    root.rotation.y = ry;

    // Re-measure after scale
    const boxAfter = new THREE.Box3().setFromObject(root);
    const size3d   = boxAfter.getSize(new THREE.Vector3());

    // Sample terrain at multiple footprint points → use the MINIMUM height
    // so the object never floats above the lowest terrain point under it
    const fr = Math.max(size3d.x, size3d.z) * 0.4;
    const sampleOffsets = [
      [0, 0], [fr, 0], [-fr, 0], [0, fr], [0, -fr],
      [fr*0.7, fr*0.7], [-fr*0.7, fr*0.7], [fr*0.7, -fr*0.7], [-fr*0.7, -fr*0.7]
    ];
    let minGroundY = Infinity;
    for (const [ox, oz] of sampleOffsets) {
      minGroundY = Math.min(minGroundY, getTerrainY(gx + ox, gz + oz));
    }

    // Use 80th percentile of bounding box bottom — ignore stray geometry
    // that dips far below the actual base (roots, decorations, etc.)
    const meshBottomY = boxAfter.min.y + size3d.y * 0.08;

    root.position.y = minGroundY - meshBottomY + (gdata.y_offset || 0);

    scene.add(root);
    addCollisionBox(root, mod.name);

    // Flatten zone: bring ALL terrain in footprint to minGroundY
    const footprint = fr + 12;
    registerFlattenZone(gx, gz, footprint, minGroundY);

    console.log(`Loaded: ${mod.name} at (${gx}, 0, ${gz})`);
  } catch (e) {
    console.warn(`Failed to load ${mod.name}:`, e);
    spawnPlaceholder(mod, gdata, cellSize);
  }
}

function spawnPlaceholder(mod, gdata, cellSize) {
  const [w, h, d] = mod.real_world_size || [4, 4, 4];
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshToonMaterial({ color: 0x6633aa, transparent: true, opacity: 0.5 })
  );
  const px = (gdata.grid_x || 0) * cellSize;
  const pz = (gdata.grid_z || 0) * cellSize;
  mesh.position.set(px, getTerrainY(px, pz) + h / 2, pz);
  scene.add(mesh);
}

// ─── Toon gradient texture ────────────────────────────────────────────────────
let _toonGrad = null;
function makeToonGradient() {
  if (_toonGrad) return _toonGrad;
  const data = new Uint8Array([80, 120, 200, 255]);
  _toonGrad = new THREE.DataTexture(data, 4, 1);
  _toonGrad.needsUpdate = true;
  return _toonGrad;
}

// ─── Environment ─────────────────────────────────────────────────────────────
let skyDome = null;

function applyEnvironment(env) {
  const tod = env?.time_of_day || 'night';

  // ── Sky dome (big sphere, no fog, always around camera) ──
  const skyTop    = { night: 0x05051a, sunset: 0x1a0805, day: 0x0a1840 };
  const skyHoriz  = { night: 0x0d1030, sunset: 0x3d1208, day: 0x1a3060 };
  scene.background = new THREE.Color(skyTop[tod] || skyTop.night);
  renderer.setClearColor(scene.background);

  skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(500, 32, 16),
    new THREE.MeshBasicMaterial({
      color: skyHoriz[tod] || skyHoriz.night,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
  );
  scene.add(skyDome);

  // ── Moon (attached to sky dome so fog never hides it) ──
  const moonColor = { night: 0xeeeeff, sunset: 0xff8833, day: 0xffffcc };
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(12, 20, 20),
    new THREE.MeshBasicMaterial({ color: moonColor[tod] || moonColor.night, fog: false })
  );
  // Put moon on sky dome surface in upper-right direction
  moon.position.set(200, 350, -300);
  scene.add(moon);

  // Moon halo
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(18, 20, 20),
    new THREE.MeshBasicMaterial({
      color: moonColor[tod] || moonColor.night,
      transparent: true, opacity: 0.12,
      fog: false
    })
  );
  halo.position.copy(moon.position);
  scene.add(halo);

  // ── Lights ──
  scene.add(new THREE.AmbientLight(0xffffff, tod === 'night' ? 2.5 : 3.5));

  const hemi = new THREE.HemisphereLight(0xaaaaff, 0x113311, 1.0);
  scene.add(hemi);

  const dirColors = { night: 0xaaaaff, sunset: 0xff8844, day: 0xfffae0 };
  const dir = new THREE.DirectionalLight(dirColors[tod] || dirColors.night, 2.0);
  dir.position.set(80, 150, 60);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 1; dir.shadow.camera.far = 600;
  dir.shadow.camera.left = -250; dir.shadow.camera.right = 250;
  dir.shadow.camera.top  = 250; dir.shadow.camera.bottom = -250;
  scene.add(dir);

  // ── Stars ──
  if (tod === 'night') addStars();

  // ── Clouds ──
  addClouds(tod);

  // ── Fog (reduced density so it doesn't swallow everything) ──
  if (env?.fog) {
    const fogColors = { night: 0x0a0a25, sunset: 0x1a0808, day: 0x102030 };
    scene.fog = new THREE.FogExp2(fogColors[tod] || fogColors.night, 0.008);
  }
}

function addStars() {
  const pos = [];
  for (let i = 0; i < 3000; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.random() * Math.PI * 0.5;
    const r     = 400;
    pos.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, sizeAttenuation: true })));
}

function addClouds(tod = 'night') {
  const cloudColor = { night: 0x1a1a40, sunset: 0x3d1a10, day: 0x334466 };
  const mat = new THREE.MeshBasicMaterial({
    color: cloudColor[tod] || cloudColor.night,
    transparent: true, opacity: 0.5, fog: false
  });
  for (let i = 0; i < 8; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const s = 8 + Math.random() * 12;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(s, 6, 6), mat);
      puff.position.set((j - n/2) * 10 + Math.random() * 5, Math.random() * 4, Math.random() * 4);
      cloud.add(puff);
    }
    cloud.position.set(
      (Math.random() - 0.5) * 300,
      60 + Math.random() * 40,
      (Math.random() - 0.5) * 300
    );
    scene.add(cloud);
  }
}

// ─── Dynamic landscape from JSON ──────────────────────────────────────────────

function hexToRgb(hex) {
  const n = parseInt((hex||'#888888').replace('#',''), 16);
  return { r: ((n>>16)&255)/255, g: ((n>>8)&255)/255, b: (n&255)/255 };
}

function buildLandscapeFromJSON(ls) {
  const hillScale    = ls.hill_scale    || 1.0;
  const centerElev   = ls.center_elevation ?? 2;
  const waterLevel   = ls.water_level   ?? 0;
  const colorLow  = hexToRgb(ls.ground_color_low  || '#1a3322');
  const colorHigh = hexToRgb(ls.ground_color_high || '#2a5533');

  // Terrain
  makeTerrain(600, 120,
    (x, z) => {
      const d = Math.sqrt(x*x + z*z);
      const flat = Math.max(0, 1 - d / 65);
      const base = noise(x, z) * hillScale;
      // Always lift center so objects aren't underwater
      return base * (1 - flat * 0.9) + flat * centerElev;
    },
    (x, y) => {
      const t = Math.max(0, Math.min(1, (y - waterLevel) / 12));
      return {
        r: colorLow.r + (colorHigh.r - colorLow.r) * t,
        g: colorLow.g + (colorHigh.g - colorLow.g) * t,
        b: colorLow.b + (colorHigh.b - colorLow.b) * t,
      };
    }
  );

  // Water
  if (ls.water) {
    const wColor = parseInt((ls.water_color || '#1a5a8a').replace('#',''), 16);
    const wgeo = new THREE.PlaneGeometry(600, 600, 60, 60);
    wgeo.rotateX(-Math.PI/2);
    waterMesh = new THREE.Mesh(wgeo,
      new THREE.MeshLambertMaterial({ color: wColor, transparent: true, opacity: 0.82 })
    );
    waterMesh.position.y = waterLevel + 0.1;
    scene.add(waterMesh);
  }

  // Vegetation and rocks are handled by TRELLIS nature_archetypes (see loadNatureArchetypes)

  // Particles
  if (ls.particles === 'snow')       addSnowParticles();
  else if (ls.particles === 'ash')   addLavaParticles();
  else if (ls.particles === 'fireflies') addFireflies(ls.particle_color);
  else if (ls.particles === 'rain')  addRainParticles();
}

function buildVegShape(type, h, trunkM, leafM, g, rng) {
  switch (type) {
    case 'pine': case 'dead_tree':
      g.add(cyl(0.15, 0.28, h*0.45, trunkM, h*0.22));
      if (type === 'pine') {
        for (let l=0; l<3; l++) g.add(cone(h*0.25*(1-l*0.18), h*0.5, leafM, h*0.38+l*h*0.2));
      } else {
        for (let i=0; i<4; i++) {
          const b = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.12,h*0.3,4), trunkM);
          b.position.set(Math.cos(i*1.57)*h*0.22, h*0.4+rng()*h*0.2, Math.sin(i*1.57)*h*0.22);
          b.rotation.z = (rng()-0.5)*1.0; g.add(b);
        }
      }
      break;
    case 'palm':
      g.add(cyl(0.25, 0.4, h, trunkM, h/2));
      for (let i=0; i<6; i++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(2+rng()*1.5, 5, 5), leafM);
        leaf.position.set(Math.cos(i*1.05)*2.5, h+0.5, Math.sin(i*1.05)*2.5);
        leaf.rotation.z = 0.7; g.add(leaf);
      }
      break;
    case 'oak': case 'bamboo':
      g.add(cyl(0.25, 0.38, h*0.55, trunkM, h*0.27));
      const crown = new THREE.Mesh(new THREE.SphereGeometry(h*0.32, 7, 7), leafM);
      crown.position.y = h*0.72; g.add(crown);
      if (type === 'bamboo') {
        for (let s=0; s<5; s++) {
          const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.12,h*0.2,6), trunkM);
          seg.position.y = s*h*0.22+h*0.1; g.add(seg);
        }
      }
      break;
    case 'cactus':
      g.add(cyl(0.3, 0.4, h, trunkM, h/2));
      if (rng()>0.4) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.25,h*0.5,6), trunkM);
        arm.position.set(h*0.35, h*0.45, 0); arm.rotation.z = 0.5; g.add(arm);
      }
      break;
    case 'mushroom':
      g.add(cyl(0.15, 0.2, h*0.6, trunkM, h*0.3));
      const cap = new THREE.Mesh(new THREE.SphereGeometry(h*0.5, 8, 4), leafM);
      cap.scale.y = 0.5; cap.position.y = h*0.7; g.add(cap);
      break;
    default: // bush
      g.add(new THREE.Mesh(new THREE.SphereGeometry(h*0.5, 6, 5), leafM));
      g.children[0].position.y = h*0.5;
      break;
  }
}

function addFireflies(colorHex) {
  const color = parseInt((colorHex||'#88ff44').replace('#',''), 16);
  const geo = new THREE.BufferGeometry();
  const pos = [];
  for (let i=0; i<500; i++)
    pos.push((Math.random()-0.5)*200, 1+Math.random()*8, (Math.random()-0.5)*200);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const ff = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 0.6 }));
  scene.add(ff);
  // Animate in render loop via userData
  ff.userData.isFirefly = true;
  ff.userData.time = 0;
}

function addRainParticles() {
  const geo = new THREE.BufferGeometry();
  const pos = [], vel = [];
  for (let i=0; i<3000; i++) {
    pos.push((Math.random()-0.5)*300, Math.random()*60, (Math.random()-0.5)*300);
    vel.push(0.5, -(8+Math.random()*4), 0.2);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('velocity', new THREE.Float32BufferAttribute(vel, 3));
  snowParticles = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaaaacc, size: 0.2 }));
  scene.add(snowParticles);
}

// ─── Biome system ─────────────────────────────────────────────────────────────

let waterMesh = null; // animated

// ─────── Shared terrain helper ────────────────────────────────────────────────

// ─── Terrain ─────────────────────────────────────────────────────────────────

// Active terrain height function — updated when terrain is built
let _terrainFn = (x, z) => 0;

function noise(x, z) {
  // Multi-octave sine noise (no library needed)
  return (
    Math.sin(x * 0.03 + 1.2) * Math.cos(z * 0.025) * 8 +
    Math.sin(x * 0.07 + z * 0.05) * 4 +
    Math.cos(x * 0.12 - z * 0.09 + 2.1) * 2 +
    Math.sin(x * 0.2 + z * 0.15) * 1
  );
}

// Flatten zones — registered when objects are placed
const flattenZones = []; // {x, z, r, y}

function registerFlattenZone(x, z, radius, targetY = null) {
  const y = targetY !== null ? targetY : _terrainFn(x, z);
  flattenZones.push({ x, z, r: radius, y });
}

function getTerrainY(x, z) {
  const base = _terrainFn(x, z);
  if (flattenZones.length === 0) return base;

  let maxInfluence = 0;
  let blendY = base;

  for (const zone of flattenZones) {
    const d = Math.sqrt((x - zone.x) ** 2 + (z - zone.z) ** 2);
    if (d < zone.r * 2.5) {
      const t = 1 - Math.min(1, d / zone.r);
      const smooth = t * t * (3 - 2 * t); // smoothstep
      if (smooth > maxInfluence) {
        maxInfluence = smooth;
        blendY = zone.y;
      }
    }
  }

  return base * (1 - maxInfluence) + blendY * maxInfluence;
}

let _terrainMeshGeo = null; // reference for rebuild

function rebuildTerrainMesh() {
  if (!_terrainMeshGeo) return;
  const pos = _terrainMeshGeo.attributes.position;
  const col = _terrainMeshGeo.attributes.color;
  const hasColor = !!col;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = getTerrainY(x, z);
    pos.setY(i, y);

    // Update vertex color to match new height (darker = lower)
    if (hasColor) {
      const t = Math.max(0, Math.min(1, (y + 2) / 14));
      col.setXYZ(i,
        0.04 + t * 0.08,
        0.10 + t * 0.16,
        0.04 + t * 0.04
      );
    }
  }
  pos.needsUpdate = true;
  if (hasColor) col.needsUpdate = true;
  _terrainMeshGeo.computeVertexNormals();
  console.log(`Terrain rebuilt: ${flattenZones.length} flatten zones`);
}

// ─── Terrain mesh builder (shared) ───────────────────────────────────────────

function makeTerrain(SIZE, SEGS, heightFn, colorFn) {
  _terrainFn = heightFn; // ← physics uses this same function
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
  _terrainMeshGeo = geo; // save for rebuild after object placement
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function spawnObjects(count, minDist, maxDist, seed, fn) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const d = minDist + rng() * (maxDist - minDist);
    fn(Math.cos(a) * d, Math.sin(a) * d, rng);
  }
}


// Biome template functions removed — terrain from JSON landscape + TRELLIS nature_archetypes


// ─── Shared helpers ──────────────────────────────────────────────────────────

function cyl(rt, rb, h, mat, py=0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,7), mat);
  m.position.y = py; m.castShadow = true; return m;
}
function cone(r, h, mat, py=0) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r,h,7), mat);
  m.position.y = py; m.castShadow = true; return m;
}
function spawnRocks(count, minD, maxD, color, seed) {
  const mat = new THREE.MeshLambertMaterial({ color });
  const rng = mulberry32(seed);
  for (let i=0; i<count; i++) {
    const a = rng()*Math.PI*2, d = minD+rng()*(maxD-minD);
    const x = Math.cos(a)*d, z = Math.sin(a)*d;
    const s = 0.5+rng()*2.5;
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(s,0), mat);
    r.position.set(x, getTerrainY(x,z)+s*0.4, z);
    r.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
    r.castShadow = true; scene.add(r);
  }
}

// ─── Particles ───────────────────────────────────────────────────────────────

let snowParticles = null, lavaParticles = null;

function addSnowParticles() {
  const geo = new THREE.BufferGeometry();
  const pos = [], vel = [];
  for (let i=0; i<2000; i++) {
    pos.push((Math.random()-0.5)*400, Math.random()*80, (Math.random()-0.5)*400);
    vel.push((Math.random()-0.5)*0.5, -(0.5+Math.random()*1.5), (Math.random()-0.5)*0.5);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('velocity', new THREE.Float32BufferAttribute(vel, 3));
  snowParticles = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xeeeeff, size: 0.4 }));
  scene.add(snowParticles);
}

function addLavaParticles() {
  const geo = new THREE.BufferGeometry();
  const pos = [], vel = [];
  for (let i=0; i<1000; i++) {
    const a = Math.random()*Math.PI*2, d = Math.random()*100;
    pos.push(Math.cos(a)*d, Math.random()*5, Math.sin(a)*d);
    vel.push((Math.random()-0.5)*0.3, 0.5+Math.random()*2, (Math.random()-0.5)*0.3);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('velocity', new THREE.Float32BufferAttribute(vel, 3));
  const cols = [0xff4400, 0xff8800, 0xffcc00];
  lavaParticles = new THREE.Points(geo,
    new THREE.PointsMaterial({ color: cols[Math.floor(Math.random()*3)], size: 0.8, fog: false }));
  scene.add(lavaParticles);
}

// Simple seedable RNG (no Math.random so terrain is reproducible)
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── Mouse look ──────────────────────────────────────────────────────────────
function onMouseMove(e) {
  if (!isLocked) return;
  yaw   -= e.movementX * 0.002;
  pitch -= e.movementY * 0.002;
  pitch  = Math.max(-0.8, Math.min(1.0, pitch));
}

// ─── Game loop ───────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  updatePlayer(dt);
  updateCamera();
  if (skyDome) skyDome.position.copy(camera.position);

  const t = clock.elapsedTime;

  // Animate water waves
  if (waterMesh) {
    const p = waterMesh.geometry.attributes.position;
    for (let i=0; i<p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, Math.sin(x*0.05+t)*0.4 + Math.cos(z*0.04+t*0.8)*0.3);
    }
    p.needsUpdate = true;
    waterMesh.geometry.computeVertexNormals();
  }

  // Animate snow
  if (snowParticles) {
    const p = snowParticles.geometry.attributes.position;
    const v = snowParticles.geometry.attributes.velocity;
    for (let i=0; i<p.count; i++) {
      let y = p.getY(i) + v.getY(i)*dt;
      if (y < 0) y = 80;
      p.setX(i, p.getX(i) + v.getX(i)*dt);
      p.setY(i, y);
      p.setZ(i, p.getZ(i) + v.getZ(i)*dt);
    }
    p.needsUpdate = true;
  }

  // Animate lava embers
  if (lavaParticles) {
    const p = lavaParticles.geometry.attributes.position;
    const v = lavaParticles.geometry.attributes.velocity;
    for (let i=0; i<p.count; i++) {
      let y = p.getY(i) + v.getY(i)*dt;
      if (y > 30) { y = 0; p.setX(i,(Math.random()-0.5)*200); p.setZ(i,(Math.random()-0.5)*200); }
      p.setY(i, y);
    }
    p.needsUpdate = true;
  }

  renderer.render(scene, camera);
}

// Collision bounding boxes — filled when GLBs load
const collisionBoxes = [];

const GATE_KEYWORDS = /gate|arch|gatehouse|entrance|portal|doorway|drawbridge/i;

function addCollisionBox(object3d, name = '') {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;

  if (GATE_KEYWORDS.test(name)) {
    // Gate/arch — split into two pillars with walkable gap in the middle
    // Opening width ~40% of the narrower side, minimum 3m
    const openingHalf = Math.max(size.x, size.z) * 0.20;

    if (size.x >= size.z) {
      // Gate wider along X → split left/right pillar, gap in center X
      const left = box.clone();
      left.max.x = cx - openingHalf;
      left.min.x += size.x * 0.02;

      const right = box.clone();
      right.min.x = cx + openingHalf;
      right.max.x -= size.x * 0.02;

      collisionBoxes.push(left, right);
    } else {
      // Gate wider along Z → split front/back pillar
      const front = box.clone();
      front.max.z = cz - openingHalf;
      front.min.z += size.z * 0.02;

      const back = box.clone();
      back.min.z = cz + openingHalf;
      back.max.z -= size.z * 0.02;

      collisionBoxes.push(front, back);
    }

    console.log(`Gate collision: 2 pillars with ${(openingHalf*2).toFixed(1)}m gap — ${name}`);
  } else {
    // Normal solid object — very small shrink so player can get close
    box.min.x += size.x * 0.02; box.max.x -= size.x * 0.02;
    box.min.z += size.z * 0.02; box.max.z -= size.z * 0.02;
    collisionBoxes.push(box);
  }
}

function isBlocked(x, z) {
  const testBox = new THREE.Box3(
    new THREE.Vector3(x - 0.35, -999, z - 0.35),
    new THREE.Vector3(x + 0.35,  999, z + 0.35)
  );
  return collisionBoxes.some(b => b.intersectsBox(testBox));
}

function updatePlayer(dt) {
  if (!sceneData) return;
  const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? RUN_SPEED : WALK_SPEED;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right   = new THREE.Vector3( Math.cos(yaw), 0, -Math.sin(yaw));
  const move    = new THREE.Vector3();

  if (keys['KeyW'] || keys['ArrowUp'])    move.add(forward);
  if (keys['KeyS'] || keys['ArrowDown'])  move.sub(forward);
  if (keys['KeyA'] || keys['ArrowLeft'])  move.sub(right);
  if (keys['KeyD'] || keys['ArrowRight']) move.add(right);

  if (move.length() > 0) {
    move.normalize().multiplyScalar(speed * dt);
    const nx = player.position.x + move.x;
    const nz = player.position.z + move.z;

    // Collision: try full move, then X-only, then Z-only
    if (!isBlocked(nx, nz)) {
      player.position.x = nx;
      player.position.z = nz;
    } else if (!isBlocked(nx, player.position.z)) {
      player.position.x = nx;
    } else if (!isBlocked(player.position.x, nz)) {
      player.position.z = nz;
    }

    const angle = Math.atan2(move.x, move.z);
    playerBody.rotation.y = THREE.MathUtils.lerp(playerBody.rotation.y, angle, 0.2);
  }

  // Terrain gravity
  const terrainY = getTerrainY(player.position.x, player.position.z);
  velY += GRAVITY * dt;
  if (keys['Space'] && player.position.y <= terrainY + 0.1) velY = JUMP_VEL;
  player.position.y += velY * dt;
  if (player.position.y < terrainY) { player.position.y = terrainY; velY = 0; }
}

function updateCamera() {
  const dist = 6;
  const offset = new THREE.Vector3(
    -Math.sin(yaw) * Math.cos(pitch) * dist,
    Math.sin(pitch) * dist + 1.6,
    -Math.cos(yaw) * Math.cos(pitch) * dist
  );
  const target = player.position.clone().add(new THREE.Vector3(0, 1.6, 0));
  let camPos = target.clone().add(offset);

  // Prevent camera from going below terrain
  const minCamY = getTerrainY(camPos.x, camPos.z) + 1.0;
  camPos.y = Math.max(camPos.y, minCamY);

  // Pull camera in if terrain blocks line of sight
  const dir = camPos.clone().sub(target).normalize();
  const ray = new THREE.Raycaster(target, dir, 0.5, dist);
  const hits = ray.intersectObjects(scene.children, true)
    .filter(h => h.object !== playerBody && !(h.object.material?.fog === false));
  if (hits.length > 0) {
    camPos = target.clone().add(dir.multiplyScalar(hits[0].distance - 0.3));
  }

  camera.position.copy(camPos);
  camera.lookAt(target);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
