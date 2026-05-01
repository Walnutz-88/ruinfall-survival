import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";

const WORLD_SIZE = 420;
const WORLD_SEGMENTS = 210;
const HALF_WORLD = WORLD_SIZE / 2;
const PLAYER_HEIGHT = 1.75;
const GRAVITY = 24;
const BUILD_RANGE = 9;
const CITY_RADIUS = 140;
const DAY_SECONDS = 120;
const TARGET_DAYS = 14;
const LOOT_PICKUP_RADIUS = 2.85;
const DOOR_ENTER_RADIUS = 4.0;
const DOOR_EXIT_RADIUS = 3.6;

/** Human-readable names for loot prompt and comments in spawn tables. */
const LOOT_LABELS = {
  food: "Canned food",
  water: "Water",
  ammo: "Ammo box",
  medkit: "Medkit",
  rifle: "Assault rifle"
};

let scene;
let camera;
let renderer;
let clock;
let composer;
let bloomPass;

let terrainMesh;
let terrainHeights = [];
let terrainResolution = WORLD_SEGMENTS + 1;

const raycaster = new THREE.Raycaster();
const mouseCenter = new THREE.Vector2(0, 0);
const zombieGroup = new THREE.Group();
const baseGroup = new THREE.Group();
const lootGroup = new THREE.Group();
const cityGroup = new THREE.Group();

const keys = { w: false, a: false, s: false, d: false, shift: false };
const player = {
  position: new THREE.Vector3(0, PLAYER_HEIGHT + 5, 0),
  velocity: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  health: 100,
  hunger: 100,
  thirst: 100,
  grounded: false,
  attackCooldown: 0,
  shootCooldown: 0,
  inventory: { food: 1, water: 1, medkit: 0, ammo: 30 },
  weapon: "pistol",
  hasRifle: false,
  /** When not null, player is inside `game.enterableBuildings[this index]`. */
  interiorIndex: null,
  /** Remember last outdoor position before entering (used if we need to restore). */
  exteriorCheckpoint: new THREE.Vector3()
};

const game = {
  started: false,
  seed: Math.floor(Math.random() * 1_000_000_000),
  zombies: [],
  dayPhase: 0,
  elapsed: 0,
  loot: [],
  over: false,
  won: false,
  /** Populated at city generation time; each entry is one enterable shell + interior. */
  enterableBuildings: []
};

const ui = {
  seedLine: document.getElementById("seedLine"),
  statsLine: document.getElementById("statsLine"),
  startButton: document.getElementById("startButton"),
  interactionPrompt: document.getElementById("interaction-prompt"),
  invFood: document.getElementById("inv-food"),
  invWater: document.getElementById("inv-water"),
  invMedkit: document.getElementById("inv-medkit"),
  invAmmo: document.getElementById("inv-ammo"),
  invWeapon: document.getElementById("inv-weapon")
};

init();
animate();

function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b1018, 0.0055);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1300);
  camera.position.copy(player.position);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById("game"),
    antialias: true,
    powerPreference: "high-performance"
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  clock = new THREE.Clock();

  // Required for physically correct RectAreaLight contribution on MeshStandardMaterial.
  RectAreaLightUniformsLib.init();

  setupImageBasedLighting();

  const hemiLight = new THREE.HemisphereLight(0xa8b8d4, 0x1a1c22, 0.5);
  scene.add(hemiLight);

  const sun = new THREE.DirectionalLight(0xf2e6d0, 1.25);
  sun.position.set(-110, 140, 85);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 520;
  sun.shadow.camera.left = -220;
  sun.shadow.camera.right = 220;
  sun.shadow.camera.top = 220;
  sun.shadow.camera.bottom = -220;
  scene.add(sun);
  scene.add(zombieGroup, baseGroup, lootGroup, cityGroup);

  setupPostProcess();

  generateWorld(game.seed);
  spawnZombies(40);
  hookInput();
  updateUI();
  updateInventoryPanel();
  hideInteractionPrompt();

  ui.startButton.addEventListener("click", () => {
    renderer.domElement.requestPointerLock();
  });

  window.addEventListener("resize", onResize);
}

/**
 * Image-based lighting from a neutral room probe: gives PBR materials believable
 * reflections without shipping HDR files. For film-grade fidelity, swap in an HDR via RGBELoader.
 */
function setupImageBasedLighting() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
}

/** Heavier visual pipeline: bloom + correct output transform. Tune bloom for "dirty lens" city haze. */
function setupPostProcess() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.26, 0.38, 0.92);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

function generateWorld(seed) {
  const terrainGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, WORLD_SEGMENTS, WORLD_SEGMENTS);
  terrainGeo.rotateX(-Math.PI / 2);
  terrainHeights = [];

  const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = getTerrainHeight(x, z, seed);
    pos.setY(i, h);
    terrainHeights.push(h);
  }
  terrainGeo.computeVertexNormals();

  const terrainMat = new THREE.MeshStandardMaterial({
    color: 0x3f4e43,
    roughness: 0.96,
    metalness: 0.03,
    envMapIntensity: 0.35
  });

  terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  makeSkydome();
  const mall = buildRoadNetwork();
  buildCityRuins(seed, mall);
  scatterDebris(seed);
  spawnLoot(seed);
  spawnInteriorLoot(seed + 20431);
}

function makeSkydome() {
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1100, 48, 32),
    new THREE.MeshBasicMaterial({
      color: 0x121824,
      side: THREE.BackSide
    })
  );
  scene.add(dome);
}

/** Streets and a mall anchor; returns the mall mesh for interior generation. */
function buildRoadNetwork() {
  const asphalt = makeTiledTexture([42, 44, 48], [64, 66, 72], 256, 0.14);
  asphalt.wrapS = THREE.RepeatWrapping;
  asphalt.wrapT = THREE.RepeatWrapping;
  asphalt.repeat.set(12, 48);
  const roadMat = new THREE.MeshStandardMaterial({
    map: asphalt,
    roughness: 0.94,
    metalness: 0.04,
    envMapIntensity: 0.25
  });

  const roadWidth = 16;
  for (let i = -2; i <= 2; i += 1) {
    const x = i * 52;
    const y = sampleTerrainHeight(x, 0) + 0.06;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(roadWidth, CITY_RADIUS * 2.05), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(x, y, 0);
    road.receiveShadow = true;
    cityGroup.add(road);
  }
  for (let i = -2; i <= 2; i += 1) {
    const z = i * 52;
    const y = sampleTerrainHeight(0, z) + 0.06;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(CITY_RADIUS * 2.05, roadWidth), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, y, z);
    road.receiveShadow = true;
    cityGroup.add(road);
  }

  const concrete = makeTiledTexture([104, 103, 98], [139, 136, 132], 256, 0.22);
  concrete.wrapS = THREE.RepeatWrapping;
  concrete.wrapT = THREE.RepeatWrapping;
  concrete.repeat.set(6, 2);
  const mallMat = new THREE.MeshStandardMaterial({
    map: concrete,
    roughness: 0.9,
    metalness: 0.06,
    envMapIntensity: 0.45
  });
  const mall = new THREE.Mesh(new THREE.BoxGeometry(68, 14, 38), mallMat);
  mall.position.set(-18, sampleTerrainHeight(-18, 12) + 7, 12);
  mall.castShadow = true;
  mall.receiveShadow = true;
  cityGroup.add(mall);

  createMallInterior(mall, game.seed);
  return mall;
}

/**
 * Procedural city blocks: some are solid ruins, others are enterable shells with interior volumes.
 * @param {THREE.Mesh} mallMesh - used only to avoid overlapping footprints with the mall.
 */
function buildCityRuins(seed, mallMesh) {
  const rng = seededRandom(seed + 311);
  const concrete = makeTiledTexture([95, 95, 96], [145, 145, 150], 256, 0.2);
  concrete.wrapS = THREE.RepeatWrapping;
  concrete.wrapT = THREE.RepeatWrapping;
  const windowTex = makeWindowTexture();
  windowTex.wrapS = THREE.RepeatWrapping;
  windowTex.wrapT = THREE.RepeatWrapping;

  const wallMat = new THREE.MeshStandardMaterial({
    map: concrete,
    roughness: 0.9,
    metalness: 0.08,
    envMapIntensity: 0.5
  });
  const glassMat = new THREE.MeshStandardMaterial({
    map: windowTex,
    roughness: 0.32,
    metalness: 0.12,
    transparent: true,
    opacity: 0.58,
    envMapIntensity: 0.85
  });

  const mallCx = mallMesh.position.x;
  const mallCz = mallMesh.position.z;

  for (let bx = -2; bx <= 2; bx += 1) {
    for (let bz = -2; bz <= 2; bz += 1) {
      const cx = bx * 52 + (rng() - 0.5) * 10;
      const cz = bz * 52 + (rng() - 0.5) * 10;
      if (Math.hypot(cx, cz) > CITY_RADIUS) continue;
      if (Math.abs(cx - mallCx) < 42 && Math.abs(cz - mallCz) < 32) continue;

      const y = sampleTerrainHeight(cx, cz);
      const asEnterable = rng() < 0.4;

      if (asEnterable) {
        createEnterableBuilding(cx, cz, y, rng, wallMat);
        continue;
      }

      const floors = 2 + Math.floor(rng() * 6);
      const width = 16 + rng() * 16;
      const depth = 16 + rng() * 16;
      const floorHeight = 3.2;
      const totalHeight = floors * floorHeight;

      const shell = new THREE.Mesh(new THREE.BoxGeometry(width, totalHeight, depth), wallMat);
      shell.position.set(cx, y + totalHeight / 2, cz);
      shell.castShadow = true;
      shell.receiveShadow = true;
      cityGroup.add(shell);

      const missingCount = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < missingCount; i += 1) {
        const slab = new THREE.Mesh(
          new THREE.BoxGeometry(width * (0.35 + rng() * 0.45), floorHeight * (1 + rng() * 1.6), depth * (0.3 + rng() * 0.4)),
          new THREE.MeshStandardMaterial({ color: 0x282a2f, roughness: 0.98 })
        );
        slab.position.set(
          cx + (rng() - 0.5) * width * 0.45,
          y + totalHeight * (0.28 + rng() * 0.55),
          cz + (rng() - 0.5) * depth * 0.45
        );
        slab.rotation.y = rng() * Math.PI * 2;
        cityGroup.add(slab);
      }

      const facade = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.9, totalHeight * 0.9), glassMat);
      facade.position.set(cx, y + totalHeight / 2, cz + depth / 2 + 0.03);
      cityGroup.add(facade);
    }
  }
}

/**
 * One enterable ruin: outer broken shell + inner room with door gap, floor, ceiling slab gaps, props.
 * Door faces +Z so prompts align with approaching from the street.
 */
function createEnterableBuilding(cx, cz, baseTerrainY, rng, wallMat) {
  const innerW = 10 + rng() * 5;
  const innerD = 8 + rng() * 4;
  const wallH = 4.1;
  const t = 0.28;
  const doorW = 2.9;
  const halfW = innerW / 2;
  const halfD = innerD / 2;
  const floorY = baseTerrainY + 0.1;

  const floorMap = makeWoodTileTexture();
  floorMap.wrapS = THREE.RepeatWrapping;
  floorMap.wrapT = THREE.RepeatWrapping;
  floorMap.repeat.set(Math.max(2, innerW / 4), Math.max(2, innerD / 4));
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorMap,
    roughness: 0.88,
    metalness: 0.02,
    envMapIntensity: 0.3
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(innerW, innerD), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, floorY + 0.02, cz);
  floor.receiveShadow = true;
  cityGroup.add(floor);

  const addWall = (geom, px, py, pz) => {
    const m = new THREE.Mesh(geom, wallMat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    cityGroup.add(m);
  };

  addWall(new THREE.BoxGeometry(innerW, wallH, t), cx, floorY + wallH / 2, cz - halfD);
  const southLeftW = (innerW - doorW) / 2;
  addWall(new THREE.BoxGeometry(southLeftW, wallH, t), cx - halfW + southLeftW / 2, floorY + wallH / 2, cz + halfD);
  addWall(new THREE.BoxGeometry(southLeftW, wallH, t), cx + halfW - southLeftW / 2, floorY + wallH / 2, cz + halfD);
  addWall(new THREE.BoxGeometry(t, wallH, innerD), cx - halfW, floorY + wallH / 2, cz);
  addWall(new THREE.BoxGeometry(t, wallH, innerD), cx + halfW, floorY + wallH / 2, cz);

  const ceiling = new THREE.Mesh(
    new THREE.BoxGeometry(innerW * 0.92, 0.35, innerD * 0.92),
    new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.92, metalness: 0.05 })
  );
  ceiling.position.set(cx, floorY + wallH - 0.1, cz);
  ceiling.castShadow = true;
  ceiling.receiveShadow = true;
  cityGroup.add(ceiling);

  const interiorLight = new THREE.PointLight(0xffe8c9, 0.55, 20, 2);
  interiorLight.position.set(cx, floorY + wallH - 0.6, cz);
  interiorLight.castShadow = false;
  cityGroup.add(interiorLight);

  const propMat = new THREE.MeshStandardMaterial({ color: 0x5c5348, roughness: 0.95 });
  for (let i = 0; i < 3; i += 1) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9 + rng(), 0.7 + rng() * 0.5, 0.9 + rng()), propMat);
    crate.position.set(
      cx + (rng() - 0.5) * (innerW - 2),
      floorY + 0.45,
      cz + (rng() - 0.5) * (innerD - 2)
    );
    crate.rotation.y = rng() * Math.PI;
    crate.castShadow = true;
    crate.receiveShadow = true;
    cityGroup.add(crate);
  }

  const colMat = wallMat.clone();
  for (let k = 0; k < 4; k += 1) {
    const ang = (k / 4) * Math.PI * 2;
    const ox = Math.cos(ang) * (halfW + 1.1);
    const oz = Math.sin(ang) * (halfD + 1.1);
    const col = new THREE.Mesh(new THREE.BoxGeometry(1.2, wallH * 1.2, 1.2), colMat);
    col.position.set(cx + ox * 0.95, baseTerrainY + (wallH * 1.2) / 2, cz + oz * 0.95);
    col.rotation.y = rng() * 0.2;
    col.castShadow = true;
    col.receiveShadow = true;
    cityGroup.add(col);
  }

  const enterPromptWorld = new THREE.Vector3(
    cx,
    sampleTerrainHeight(cx, cz + halfD + 2.0) + PLAYER_HEIGHT,
    cz + halfD + 2.0
  );
  const interiorSpawnWorld = new THREE.Vector3(cx, floorY + PLAYER_HEIGHT + 0.02, cz + halfD - 1.4);
  const exitPromptWorld = new THREE.Vector3(cx, floorY + PLAYER_HEIGHT, cz + halfD - 1.35);
  const exitSpawnWorld = new THREE.Vector3(
    cx,
    sampleTerrainHeight(cx, cz + halfD + 2.4) + PLAYER_HEIGHT,
    cz + halfD + 2.4
  );

  game.enterableBuildings.push({
    cx,
    cz,
    floorY,
    innerW,
    innerD,
    enterPromptWorld,
    exitPromptWorld,
    interiorSpawnWorld,
    exitSpawnWorld
  });
}

/**
 * Large single-city landmark: collapsed mall with an interior concourse (pillars, debris, lights).
 */
function createMallInterior(mallMesh, seed) {
  const rng = seededRandom(seed + 9001);
  const mx = mallMesh.position.x;
  const mz = mallMesh.position.z;
  const floorWorldY = mallMesh.position.y - 7 + 0.14;
  const innerW = 50;
  const innerD = 34;
  const wallH = 5.2;
  const halfW = innerW / 2;
  const halfD = innerD / 2;
  const t = 0.35;

  const tile = makePolishedConcreteTexture();
  tile.wrapS = THREE.RepeatWrapping;
  tile.wrapT = THREE.RepeatWrapping;
  tile.repeat.set(10, 7);
  const floorMat = new THREE.MeshStandardMaterial({
    map: tile,
    roughness: 0.82,
    metalness: 0.07,
    envMapIntensity: 0.55
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(innerW, innerD), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(mx, floorWorldY + 0.03, mz);
  floor.receiveShadow = true;
  cityGroup.add(floor);

  const innerWall = new THREE.MeshStandardMaterial({
    color: 0x6a6d72,
    roughness: 0.91,
    metalness: 0.05,
    envMapIntensity: 0.4
  });

  const addWall = (w, h, d, px, py, pz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), innerWall);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    cityGroup.add(m);
  };

  // Main entrance on +Z (street side) to match exterior prompts and smaller enterable lots.
  const doorW = 6.0;
  const southLeft = (innerW - doorW) / 2;
  addWall(southLeft, wallH, t, mx - halfW + southLeft / 2, floorWorldY + wallH / 2, mz + halfD);
  addWall(southLeft, wallH, t, mx + halfW - southLeft / 2, floorWorldY + wallH / 2, mz + halfD);
  addWall(innerW, wallH, t, mx, floorWorldY + wallH / 2, mz - halfD);
  addWall(t, wallH, innerD, mx - halfW, floorWorldY + wallH / 2, mz);
  addWall(t, wallH, innerD, mx + halfW, floorWorldY + wallH / 2, mz);

  for (let gx = -1; gx <= 1; gx += 1) {
    for (let gz = -1; gz <= 1; gz += 1) {
      if (gx === 0 && gz === 0) continue;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, wallH - 0.4, 10), innerWall);
      pillar.position.set(mx + gx * 12, floorWorldY + wallH / 2, mz + gz * 10);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      cityGroup.add(pillar);
    }
  }

  for (let i = 0; i < 14; i += 1) {
    const rub = new THREE.Mesh(
      new THREE.BoxGeometry(1 + rng() * 2, 0.4 + rng(), 1 + rng() * 2),
      new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 1 })
    );
    rub.position.set(mx + (rng() - 0.5) * (innerW - 4), floorWorldY + 0.3, mz + (rng() - 0.5) * (innerD - 4));
    rub.rotation.y = rng() * Math.PI;
    rub.castShadow = true;
    rub.receiveShadow = true;
    cityGroup.add(rub);
  }

  const strip = new THREE.RectAreaLight(0xcfe0ff, 2.2, innerW * 0.7, 1.2);
  strip.position.set(mx, floorWorldY + wallH - 0.2, mz);
  strip.lookAt(mx, floorWorldY, mz);
  cityGroup.add(strip);

  const enterPromptWorld = new THREE.Vector3(
    mx,
    sampleTerrainHeight(mx, mz + halfD + 3.5) + PLAYER_HEIGHT,
    mz + halfD + 3.5
  );
  const interiorSpawnWorld = new THREE.Vector3(mx, floorWorldY + PLAYER_HEIGHT + 0.02, mz + halfD - 2.2);
  const exitPromptWorld = new THREE.Vector3(mx, floorWorldY + PLAYER_HEIGHT, mz + halfD - 2.0);
  const exitSpawnWorld = new THREE.Vector3(
    mx,
    sampleTerrainHeight(mx, mz + halfD + 3.8) + PLAYER_HEIGHT,
    mz + halfD + 3.8
  );

  game.enterableBuildings.push({
    cx: mx,
    cz: mz,
    floorY: floorWorldY,
    innerW,
    innerD,
    enterPromptWorld,
    exitPromptWorld,
    interiorSpawnWorld,
    exitSpawnWorld
  });
}

function scatterDebris(seed) {
  const rng = seededRandom(seed + 17);
  const mat = new THREE.MeshStandardMaterial({ color: 0x595754, roughness: 1.0, envMapIntensity: 0.2 });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 620; i += 1) {
    const x = (rng() - 0.5) * (WORLD_SIZE - 10);
    const z = (rng() - 0.5) * (WORLD_SIZE - 10);
    const y = sampleTerrainHeight(x, z);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + 0.22, z);
    m.rotation.set(rng() * 2, rng() * 2, rng() * 2);
    const s = 0.18 + rng() * 1.2;
    m.scale.set(s * 2.5, s * 0.6, s * 1.4);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

function spawnLoot(seed) {
  const rng = seededRandom(seed + 999);
  const types = ["food", "water", "ammo", "medkit", "rifle"];
  const colors = {
    food: 0xb59f62,
    water: 0x4f83ca,
    ammo: 0x9d8b6d,
    medkit: 0xc14848,
    rifle: 0x444444
  };
  for (let i = 0; i < 85; i += 1) {
    let x = (rng() - 0.5) * CITY_RADIUS * 1.7;
    let z = (rng() - 0.5) * CITY_RADIUS * 1.7;
    if (Math.hypot(x, z) > CITY_RADIUS) {
      x *= 0.72;
      z *= 0.72;
    }
    const y = sampleTerrainHeight(x, z);
    const type = types[Math.floor(rng() * types.length)];
    addLootPickup(new THREE.Vector3(x, y + 0.25, z), type, colors[type]);
  }
}

/** Extra pickups inside enterable volumes so scavenging rewards exploration. */
function spawnInteriorLoot(seed) {
  const rng = seededRandom(seed);
  const types = ["food", "water", "ammo", "medkit"];
  const colors = {
    food: 0xb59f62,
    water: 0x4f83ca,
    ammo: 0x9d8b6d,
    medkit: 0xc14848,
    rifle: 0x444444
  };
  for (const b of game.enterableBuildings) {
    const count = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i += 1) {
      const type = types[Math.floor(rng() * types.length)];
      const lx = b.cx + (rng() - 0.5) * (b.innerW - 3);
      const lz = b.cz + (rng() - 0.5) * (b.innerD - 3);
      const y = b.floorY + 0.28;
      addLootPickup(new THREE.Vector3(lx, y, lz), type, colors[type]);
    }
  }
}

function addLootPickup(position, type, colorHex) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(type === "rifle" ? 1.1 : 0.6, 0.35, type === "rifle" ? 0.2 : 0.6),
    new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.65,
      metalness: type === "rifle" ? 0.55 : 0.12,
      envMapIntensity: 0.6
    })
  );
  mesh.position.copy(position);
  mesh.castShadow = true;
  lootGroup.add(mesh);
  game.loot.push({ mesh, type, picked: false, label: LOOT_LABELS[type] });
}

function spawnZombies(count) {
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x70806a, roughness: 0.94, envMapIntensity: 0.25 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff4d4d });

  for (let i = 0; i < count; i += 1) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.0, 4, 8), bodyMat);
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.05), eyeMat);
    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.05), eyeMat);
    eyeL.position.set(-0.1, 0.9, 0.24);
    eyeR.position.set(0.1, 0.9, 0.24);
    body.castShadow = true;
    group.add(body, eyeL, eyeR);

    let x = (Math.random() - 0.5) * (WORLD_SIZE - 20);
    let z = (Math.random() - 0.5) * (WORLD_SIZE - 20);
    if (Math.hypot(x, z) > CITY_RADIUS * 0.95) {
      x *= 0.5;
      z *= 0.5;
    }
    const y = sampleTerrainHeight(x, z) + 0.95;
    group.position.set(x, y, z);
    zombieGroup.add(group);

    game.zombies.push({
      mesh: group,
      speed: 0.8 + Math.random() * 0.95,
      hp: 100
    });
  }
}

function hookInput() {
  document.addEventListener("pointerlockchange", () => {
    game.started = document.pointerLockElement === renderer.domElement;
  });

  window.addEventListener("mousemove", (ev) => {
    if (!game.started) return;
    player.yaw -= ev.movementX * 0.0022;
    player.pitch -= ev.movementY * 0.0022;
    player.pitch = THREE.MathUtils.clamp(player.pitch, -1.42, 1.42);
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.code === "KeyW") keys.w = true;
    if (ev.code === "KeyA") keys.a = true;
    if (ev.code === "KeyS") keys.s = true;
    if (ev.code === "KeyD") keys.d = true;
    if (ev.code === "ShiftLeft") keys.shift = true;
    if (ev.code === "Space" && player.grounded) {
      player.velocity.y = 8.8;
      player.grounded = false;
    }
    if (ev.code === "KeyR") removeNearestWall();
    if (ev.code === "KeyB") placeWall();
    if (ev.code === "Digit1") consumeItem("food");
    if (ev.code === "Digit2") consumeItem("water");
    if (ev.code === "Digit3") consumeItem("medkit");
    if (ev.code === "KeyQ") swapWeapon();
    if (ev.code === "KeyE") tryEnterOrExitBuilding();
    if (ev.code === "KeyF") tryPickupLoot();
  });

  window.addEventListener("keyup", (ev) => {
    if (ev.code === "KeyW") keys.w = false;
    if (ev.code === "KeyA") keys.a = false;
    if (ev.code === "KeyS") keys.s = false;
    if (ev.code === "KeyD") keys.d = false;
    if (ev.code === "ShiftLeft") keys.shift = false;
  });

  window.addEventListener("mousedown", (ev) => {
    if (!game.started || ev.button !== 0) return;
    shootWeapon();
  });
}

function tryEnterOrExitBuilding() {
  if (!game.started || game.over) return;
  const door = getDoorContext();
  if (!door) return;

  if (door.mode === "enter") {
    player.exteriorCheckpoint.copy(player.position);
    player.interiorIndex = door.index;
    player.position.copy(door.building.interiorSpawnWorld);
    player.velocity.set(0, 0, 0);
  } else {
    player.position.copy(door.building.exitSpawnWorld);
    player.interiorIndex = null;
    player.velocity.set(0, 0, 0);
  }
}

function getDoorContext() {
  if (player.interiorIndex !== null) {
    const b = game.enterableBuildings[player.interiorIndex];
    if (!b) {
      player.interiorIndex = null;
      return null;
    }
    if (player.position.distanceTo(b.exitPromptWorld) <= DOOR_EXIT_RADIUS) {
      return { mode: "exit", building: b, index: player.interiorIndex };
    }
    return null;
  }

  let bestIdx = -1;
  let bestDist = DOOR_ENTER_RADIUS;
  for (let i = 0; i < game.enterableBuildings.length; i += 1) {
    const b = game.enterableBuildings[i];
    const d = player.position.distanceTo(b.enterPromptWorld);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) return { mode: "enter", building: game.enterableBuildings[bestIdx], index: bestIdx };
  return null;
}

function getNearestLootContext() {
  let best = null;
  let bestDist = LOOT_PICKUP_RADIUS;
  for (const item of game.loot) {
    if (item.picked) continue;
    const d = item.mesh.position.distanceTo(player.position);
    if (d < bestDist) {
      bestDist = d;
      best = item;
    }
  }
  return best ? { item: best, dist: bestDist } : null;
}

function tryPickupLoot() {
  if (!game.started || game.over) return;
  const ctx = getNearestLootContext();
  if (!ctx) return;
  const item = ctx.item;
  item.picked = true;
  lootGroup.remove(item.mesh);
  item.mesh.geometry.dispose();
  item.mesh.material.dispose();
  if (item.type === "food") player.inventory.food += 1;
  if (item.type === "water") player.inventory.water += 1;
  if (item.type === "medkit") player.inventory.medkit += 1;
  if (item.type === "ammo") player.inventory.ammo += 12;
  if (item.type === "rifle") player.hasRifle = true;
  updateInventoryPanel();
}

function updateInteractionPrompt() {
  if (!game.started) {
    hideInteractionPrompt();
    return;
  }
  const lootCtx = getNearestLootContext();
  if (lootCtx) {
    showInteractionPrompt(`[F] Pick up ${lootCtx.item.label}`);
    return;
  }
  const door = getDoorContext();
  if (door) {
    showInteractionPrompt(door.mode === "enter" ? "[E] Enter building" : "[E] Exit building");
    return;
  }
  hideInteractionPrompt();
}

function showInteractionPrompt(text) {
  ui.interactionPrompt.textContent = text;
  ui.interactionPrompt.classList.remove("hidden");
}

function hideInteractionPrompt() {
  ui.interactionPrompt.classList.add("hidden");
}

function updateInventoryPanel() {
  ui.invFood.textContent = String(player.inventory.food);
  ui.invWater.textContent = String(player.inventory.water);
  ui.invMedkit.textContent = String(player.inventory.medkit);
  ui.invAmmo.textContent = String(player.inventory.ammo);
  const w = player.hasRifle ? `${player.weapon} (+rifle)` : player.weapon;
  ui.invWeapon.textContent = w;
}

function placeWall() {
  if (player.interiorIndex !== null) return;
  raycaster.setFromCamera(mouseCenter, camera);
  const hits = raycaster.intersectObject(terrainMesh);
  if (!hits.length) return;
  const hit = hits[0];
  if (hit.distance > BUILD_RANGE) return;

  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 2.4, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x9f8873, roughness: 0.98, metalness: 0.02, envMapIntensity: 0.25 })
  );
  wall.position.copy(hit.point);
  wall.position.y += 1.2;
  wall.rotation.y = player.yaw;
  wall.castShadow = true;
  wall.receiveShadow = true;
  baseGroup.add(wall);
}

function removeNearestWall() {
  let nearest = null;
  let dist = Infinity;
  for (const wall of baseGroup.children) {
    const d = wall.position.distanceTo(player.position);
    if (d < dist) {
      dist = d;
      nearest = wall;
    }
  }
  if (nearest && dist < 4.4) {
    baseGroup.remove(nearest);
    nearest.geometry.dispose();
    nearest.material.dispose();
  }
}

function consumeItem(type) {
  if (player.inventory[type] <= 0) return;
  player.inventory[type] -= 1;
  if (type === "food") player.hunger = Math.min(100, player.hunger + 34);
  if (type === "water") player.thirst = Math.min(100, player.thirst + 38);
  if (type === "medkit") player.health = Math.min(100, player.health + 45);
  updateInventoryPanel();
}

function swapWeapon() {
  if (!player.hasRifle) return;
  player.weapon = player.weapon === "pistol" ? "rifle" : "pistol";
  updateInventoryPanel();
}

function shootWeapon() {
  if (player.shootCooldown > 0 || player.inventory.ammo <= 0 || game.over) return;
  player.inventory.ammo -= 1;
  player.shootCooldown = player.weapon === "rifle" ? 0.09 : 0.28;
  updateInventoryPanel();
  raycaster.setFromCamera(mouseCenter, camera);
  const targets = game.zombies.filter((z) => z.hp > 0).map((z) => z.mesh);
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length) {
    const root = getZombieRoot(hits[0].object);
    const hitZombie = game.zombies.find((z) => z.mesh === root);
    if (hitZombie) {
      hitZombie.hp -= player.weapon === "rifle" ? 70 : 34;
      if (hitZombie.hp <= 0) {
        hitZombie.mesh.visible = false;
        hitZombie.mesh.position.set(9999, -999, 9999);
      }
    }
  }
}

function getZombieRoot(obj) {
  let p = obj;
  while (p.parent && p.parent !== zombieGroup) p = p.parent;
  return p;
}

function updatePlayer(dt) {
  const speed = keys.shift ? 9.2 : 5.1;
  const move = new THREE.Vector3();
  const forward = new THREE.Vector3(Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);

  if (keys.w) move.add(forward);
  if (keys.s) move.sub(forward);
  if (keys.d) move.add(right);
  if (keys.a) move.sub(right);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

  player.velocity.x = move.x;
  player.velocity.z = move.z;
  player.velocity.y -= GRAVITY * dt;
  player.position.addScaledVector(player.velocity, dt);

  player.position.x = THREE.MathUtils.clamp(player.position.x, -HALF_WORLD + 2, HALF_WORLD - 2);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -HALF_WORLD + 2, HALF_WORLD - 2);

  let groundY;
  if (player.interiorIndex !== null) {
    const b = game.enterableBuildings[player.interiorIndex];
    if (!b) {
      player.interiorIndex = null;
      groundY = sampleTerrainHeight(player.position.x, player.position.z) + PLAYER_HEIGHT;
    } else {
      const margin = 0.45;
      player.position.x = THREE.MathUtils.clamp(player.position.x, b.cx - b.innerW / 2 + margin, b.cx + b.innerW / 2 - margin);
      player.position.z = THREE.MathUtils.clamp(player.position.z, b.cz - b.innerD / 2 + margin, b.cz + b.innerD / 2 - margin);
      groundY = b.floorY + PLAYER_HEIGHT;
    }
  } else {
    groundY = sampleTerrainHeight(player.position.x, player.position.z) + PLAYER_HEIGHT;
  }

  if (player.position.y <= groundY) {
    player.position.y = groundY;
    player.velocity.y = 0;
    player.grounded = true;
  }

  camera.position.copy(player.position);
  camera.rotation.order = "YXZ";
  camera.rotation.y = player.yaw;
  camera.rotation.x = player.pitch;
}

function updateZombies(dt) {
  const target = player.position;
  for (const z of game.zombies) {
    if (z.hp <= 0) continue;
    const p = z.mesh.position;
    const dir = new THREE.Vector3(target.x - p.x, 0, target.z - p.z);
    const dist = dir.length();
    if (dist > 0.001) {
      dir.normalize();
      p.x += dir.x * z.speed * dt;
      p.z += dir.z * z.speed * dt;
      z.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    }

    p.y = sampleTerrainHeight(p.x, p.z) + 0.95;

    if (dist < 1.6 && player.attackCooldown <= 0) {
      player.health = Math.max(0, player.health - 8);
      player.attackCooldown = 0.65;
    }
  }
}

function updateSurvival(dt) {
  player.attackCooldown = Math.max(0, player.attackCooldown - dt);
  player.shootCooldown = Math.max(0, player.shootCooldown - dt);
  player.hunger = Math.max(0, player.hunger - dt * 0.28);
  player.thirst = Math.max(0, player.thirst - dt * 0.36);

  if (player.hunger <= 0 || player.thirst <= 0) {
    player.health = Math.max(0, player.health - dt * 2.8);
  }

  game.elapsed += dt;
  game.dayPhase += dt * 0.024;
  const days = game.elapsed / DAY_SECONDS;
  if (!game.over && days >= TARGET_DAYS) {
    game.over = true;
    game.won = true;
  }
  if (!game.over && player.health <= 0) {
    game.over = true;
  }
  const day = 0.28 + (Math.sin(game.dayPhase) + 1) * 0.33;
  scene.fog.density = 0.004 + (1 - day) * 0.0052;
}

function updateUI() {
  ui.seedLine.textContent = `Seed: ${game.seed} (new each reload)`;
  const day = Math.min(TARGET_DAYS, Math.floor(game.elapsed / DAY_SECONDS) + 1);
  const objective = game.won ? "You survived two weeks." : game.over ? "You died in the city ruins." : `Day ${day}/${TARGET_DAYS}`;
  ui.statsLine.textContent = `${objective} | HP ${player.health.toFixed(0)} | Hunger ${player.hunger.toFixed(0)} | Thirst ${player.thirst.toFixed(
    0
  )}`;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.04);

  if (game.started && !game.over) {
    updatePlayer(dt);
    updateZombies(dt);
    updateSurvival(dt);
  }
  updateUI();
  updateInteractionPrompt();
  composer.render();
}

function getTerrainHeight(x, z, seed) {
  const n1 = fbmNoise(x * 0.008, z * 0.008, seed) * 22;
  const n2 = fbmNoise((x + 999) * 0.02, (z - 333) * 0.02, seed + 7) * 6;
  const crater = Math.max(0, 1 - Math.hypot(x * 0.004, z * 0.004)) * -9;
  return n1 + n2 + crater;
}

function sampleTerrainHeight(x, z) {
  const fx = ((x + HALF_WORLD) / WORLD_SIZE) * WORLD_SEGMENTS;
  const fz = ((z + HALF_WORLD) / WORLD_SIZE) * WORLD_SEGMENTS;
  const x0 = THREE.MathUtils.clamp(Math.floor(fx), 0, WORLD_SEGMENTS);
  const z0 = THREE.MathUtils.clamp(Math.floor(fz), 0, WORLD_SEGMENTS);
  const x1 = Math.min(x0 + 1, WORLD_SEGMENTS);
  const z1 = Math.min(z0 + 1, WORLD_SEGMENTS);
  const tx = fx - x0;
  const tz = fz - z0;

  const h00 = terrainHeights[z0 * terrainResolution + x0] ?? 0;
  const h10 = terrainHeights[z0 * terrainResolution + x1] ?? h00;
  const h01 = terrainHeights[z1 * terrainResolution + x0] ?? h00;
  const h11 = terrainHeights[z1 * terrainResolution + x1] ?? h00;

  const h0 = THREE.MathUtils.lerp(h00, h10, tx);
  const h1 = THREE.MathUtils.lerp(h01, h11, tx);
  return THREE.MathUtils.lerp(h0, h1, tz);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

function seededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function fbmNoise(x, z, seed) {
  let value = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < 5; i += 1) {
    value += valueNoise2D(x * freq, z * freq, seed + i * 19) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return value / norm;
}

function valueNoise2D(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const xf = x - x0;
  const zf = z - z0;
  const u = fade(xf);
  const v = fade(zf);

  const v00 = hash2(x0, z0, seed);
  const v10 = hash2(x0 + 1, z0, seed);
  const v01 = hash2(x0, z0 + 1, seed);
  const v11 = hash2(x0 + 1, z0 + 1, seed);
  const xA = THREE.MathUtils.lerp(v00, v10, u);
  const xB = THREE.MathUtils.lerp(v01, v11, u);
  return THREE.MathUtils.lerp(xA, xB, v) * 2 - 1;
}

function hash2(x, z, seed) {
  let h = seed ^ (x * 374761393) ^ (z * 668265263);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

function makeTiledTexture(baseRgb, speckRgb, size, speckAmount) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${baseRgb[0]}, ${baseRgb[1]}, ${baseRgb[2]})`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size * speckAmount; i += 1) {
    const x = Math.floor(Math.random() * size);
    const y = Math.floor(Math.random() * size);
    const alpha = 0.15 + Math.random() * 0.4;
    ctx.fillStyle = `rgba(${speckRgb[0]}, ${speckRgb[1]}, ${speckRgb[2]}, ${alpha})`;
    ctx.fillRect(x, y, 2, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWindowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1c212b";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "rgba(160, 176, 191, 0.65)";
  ctx.lineWidth = 5;
  for (let i = 0; i <= 8; i += 1) {
    const x = i * 32;
    const y = i * 32;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }
  for (let i = 0; i < 60; i += 1) {
    ctx.fillStyle = "rgba(248, 254, 255, 0.05)";
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 20, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWoodTileTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#4a3c2e";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "rgba(20, 16, 12, 0.45)";
  for (let x = 0; x < 256; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  for (let y = 0; y < 256; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }
  for (let i = 0; i < 400; i += 1) {
    ctx.fillStyle = `rgba(${90 + Math.floor(Math.random() * 30)}, ${70 + Math.floor(Math.random() * 25)}, ${45 + Math.floor(Math.random() * 20)}, 0.12)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 3, 10);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePolishedConcreteTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#7d7f82";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i += 1) {
    const g = 120 + Math.floor(Math.random() * 40);
    ctx.fillStyle = `rgba(${g}, ${g}, ${g + 4}, 0.08)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
