import * as THREE from "three";

const WORLD_SIZE = 420;
const WORLD_SEGMENTS = 210;
const HALF_WORLD = WORLD_SIZE / 2;
const PLAYER_HEIGHT = 1.75;
const GRAVITY = 24;
const BUILD_RANGE = 9;

let scene;
let camera;
let renderer;
let clock;

let terrainMesh;
let terrainHeights = [];
let terrainResolution = WORLD_SEGMENTS + 1;

const raycaster = new THREE.Raycaster();
const mouseCenter = new THREE.Vector2(0, 0);
const zombieGroup = new THREE.Group();
const baseGroup = new THREE.Group();

const keys = { w: false, a: false, s: false, d: false, shift: false };
const player = {
  position: new THREE.Vector3(0, PLAYER_HEIGHT + 5, 0),
  velocity: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  health: 100,
  hunger: 100,
  grounded: false,
  attackCooldown: 0
};

const game = {
  started: false,
  seed: Math.floor(Math.random() * 1_000_000_000),
  zombies: [],
  dayPhase: 0,
  elapsed: 0
};

const ui = {
  seedLine: document.getElementById("seedLine"),
  statsLine: document.getElementById("statsLine"),
  startButton: document.getElementById("startButton")
};

init();
animate();

function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b1018, 0.006);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1300);
  camera.position.copy(player.position);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById("game"),
    antialias: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  clock = new THREE.Clock();

  const hemiLight = new THREE.HemisphereLight(0x93a6c4, 0x1b1b21, 0.56);
  scene.add(hemiLight);

  const sun = new THREE.DirectionalLight(0xe6d6bb, 1.1);
  sun.position.set(-90, 120, 70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  scene.add(zombieGroup);
  scene.add(baseGroup);

  generateWorld(game.seed);
  spawnZombies(28);
  hookInput();
  updateUI();

  ui.startButton.addEventListener("click", () => {
    renderer.domElement.requestPointerLock();
  });

  window.addEventListener("resize", onResize);
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
    roughness: 0.97,
    metalness: 0.02
  });

  terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  makeSkydome();
  scatterDebris(seed);
  scatterRuins(seed);
}

function makeSkydome() {
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1100, 32, 20),
    new THREE.MeshBasicMaterial({
      color: 0x141a27,
      side: THREE.BackSide
    })
  );
  scene.add(dome);
}

function scatterDebris(seed) {
  const rng = seededRandom(seed + 17);
  const mat = new THREE.MeshStandardMaterial({ color: 0x595754, roughness: 1.0 });
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

function scatterRuins(seed) {
  const rng = seededRandom(seed + 311);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6e6f6f, roughness: 0.95, metalness: 0.08 });

  // Ruins are assembled as fragmented walls and slabs, rather than perfect cubes.
  for (let i = 0; i < 48; i += 1) {
    const centerX = (rng() - 0.5) * (WORLD_SIZE - 40);
    const centerZ = (rng() - 0.5) * (WORLD_SIZE - 40);
    const baseY = sampleTerrainHeight(centerX, centerZ);
    const count = 3 + Math.floor(rng() * 6);

    for (let j = 0; j < count; j += 1) {
      const w = 2 + rng() * 7;
      const h = 1.4 + rng() * 6;
      const d = 0.35 + rng() * 2;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      mesh.position.set(centerX + (rng() - 0.5) * 12, baseY + h / 2, centerZ + (rng() - 0.5) * 12);
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.rotation.z = (rng() - 0.5) * 0.2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }
}

function spawnZombies(count) {
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x70806a, roughness: 0.94 });
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
    if (Math.abs(x) < 16 && Math.abs(z) < 16) {
      x += 24;
      z += 24;
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
    placeWall();
  });
}

function placeWall() {
  // Place walls where the center reticle intersects terrain so players can build a base.
  raycaster.setFromCamera(mouseCenter, camera);
  const hits = raycaster.intersectObject(terrainMesh);
  if (!hits.length) return;
  const hit = hits[0];
  if (hit.distance > BUILD_RANGE) return;

  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 2.4, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x9f8873, roughness: 0.98, metalness: 0.01 })
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

function updatePlayer(dt) {
  const speed = keys.shift ? 9.2 : 5.1;
  const move = new THREE.Vector3();
  const forward = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
  const right = new THREE.Vector3(forward.z, 0, -forward.x);

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

  const ground = sampleTerrainHeight(player.position.x, player.position.z) + PLAYER_HEIGHT;
  if (player.position.y <= ground) {
    player.position.y = ground;
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
  player.hunger = Math.max(0, player.hunger - dt * 0.28);

  // Hunger pressure steadily lowers health to enforce survival gameplay.
  if (player.hunger <= 0) {
    player.health = Math.max(0, player.health - dt * 2.1);
  }

  game.elapsed += dt;
  game.dayPhase += dt * 0.024;
  const day = 0.28 + (Math.sin(game.dayPhase) + 1) * 0.33;
  scene.fog.density = 0.004 + (1 - day) * 0.0052;
}

function updateUI() {
  ui.seedLine.textContent = `Seed: ${game.seed} (new each reload)`;
  ui.statsLine.textContent = `Health ${player.health.toFixed(0)} | Hunger ${player.hunger.toFixed(0)} | Walls ${baseGroup.children.length}`;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.04);

  if (game.started && player.health > 0) {
    updatePlayer(dt);
    updateZombies(dt);
    updateSurvival(dt);
    updateUI();
  }

  renderer.render(scene, camera);
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
