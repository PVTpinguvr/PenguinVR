/**
 * Penguin Tag VR - Core Client
 * WebXR + Three.js + Cannon-es
 * Gorilla-Tag style hand locomotion
 */
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import * as CANNON from 'cannon-es';

// ---------- Config ----------
// Same-origin by default. Override with ?server=wss://other.host if needed.
function getWsUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('server')) return params.get('server');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // When client is served by our Node server, WS is on same host.
  // When client is on static host and server elsewhere, set ?server=
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return `${proto}://${location.hostname}:8080`;
  }
  return `${proto}://${location.host}`;
}
const SERVER_URL = getWsUrl();
const GRAVITY = -14;
const HAND_RADIUS = 0.09;
const BODY_RADIUS = 0.28;
const PUSH_STRENGTH = 2.8;
const MAX_SPEED = 12;
const FRICTION = 0.92;
const AIR_DRAG = 0.985;

// ---------- Globals ----------
let renderer, scene, camera, clock;
let world; // cannon
let playerBody, leftHandBody, rightHandBody;
let leftController, rightController, leftGrip, rightGrip;
let localPlayer = { id: null, username: '', isOwner: false, profile: null };
let remotePlayers = new Map();
let roomState = null;
let ws = null;
let connected = false;
let isVR = false;
let mapMeshes = [];
let currentMap = 'iceberg';
let penguinMesh = null;
let ownerStaff = null;
let lastSent = 0;
let input = { left: { gripping: false, pos: new THREE.Vector3(), prev: new THREE.Vector3() }, right: { gripping: false, pos: new THREE.Vector3(), prev: new THREE.Vector3() } };

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
function setStatus(t) { if (statusEl) statusEl.textContent = t; }

// ---------- Init ----------
async function init() {
  clock = new THREE.Clock();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b8e0);
  scene.fog = new THREE.Fog(0x87b8e0, 8, 80);

  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
  camera.position.set(0, 1.4, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // Lighting
  const hemi = new THREE.HemisphereLight(0xddeeff, 0x445566, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  scene.add(sun);

  // Physics world
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.4;
  world.defaultContactMaterial.restitution = 0.15;

  // Player physics body (capsule-ish sphere)
  playerBody = new CANNON.Body({
    mass: 70,
    shape: new CANNON.Sphere(BODY_RADIUS),
    linearDamping: 0.05,
    angularDamping: 0.9,
    fixedRotation: true
  });
  playerBody.position.set(0, 2, 0);
  world.addBody(playerBody);

  // Hand sensors (kinematic)
  leftHandBody = new CANNON.Body({ mass: 0, shape: new CANNON.Sphere(HAND_RADIUS), type: CANNON.Body.KINEMATIC });
  rightHandBody = new CANNON.Body({ mass: 0, shape: new CANNON.Sphere(HAND_RADIUS), type: CANNON.Body.KINEMATIC });
  world.addBody(leftHandBody);
  world.addBody(rightHandBody);

  // Controllers
  leftController = renderer.xr.getController(0);
  rightController = renderer.xr.getController(1);
  leftGrip = renderer.xr.getControllerGrip(0);
  rightGrip = renderer.xr.getControllerGrip(1);
  scene.add(leftController, rightController, leftGrip, rightGrip);

  // Visual hands
  const handGeo = new THREE.SphereGeometry(0.07, 12, 12);
  const handMat = new THREE.MeshStandardMaterial({ color: 0xffe0b0, roughness: 0.4 });
  const leftHandMesh = new THREE.Mesh(handGeo, handMat);
  const rightHandMesh = new THREE.Mesh(handGeo, handMat.clone());
  leftController.add(leftHandMesh);
  rightController.add(rightHandMesh);

  // Events for grip
  leftController.addEventListener('selectstart', () => { input.left.gripping = true; });
  leftController.addEventListener('selectend', () => { input.left.gripping = false; });
  rightController.addEventListener('selectstart', () => { input.right.gripping = true; });
  rightController.addEventListener('selectend', () => { input.right.gripping = false; });
  // Also squeeze for better feel
  leftController.addEventListener('squeezestart', () => { input.left.gripping = true; });
  leftController.addEventListener('squeezeend', () => { input.left.gripping = false; });
  rightController.addEventListener('squeezestart', () => { input.right.gripping = true; });
  rightController.addEventListener('squeezeend', () => { input.right.gripping = false; });

  buildPenguinAvatar();
  loadMap('iceberg');

  // XR session
  renderer.xr.addEventListener('sessionstart', () => {
    isVR = true;
    $('lobby').classList.add('hidden');
    $('hud').classList.remove('hidden');
    setStatus('VR active');
  });
  renderer.xr.addEventListener('sessionend', () => {
    isVR = false;
    $('lobby').classList.remove('hidden');
    $('hud').classList.add('hidden');
  });

  // Desktop fallback camera controls (limited)
  window.addEventListener('resize', onResize);
  document.body.appendChild(VRButton.createButton(renderer));

  // UI bindings
  $('btn-enter-vr').addEventListener('click', () => {
    // VRButton already present; this just focuses
    setStatus('Put on headset and press the VR button');
  });
  $('btn-desktop').addEventListener('click', () => {
    $('lobby').classList.add('hidden');
    $('hud').classList.remove('hidden');
    connectAndJoin();
  });
  $('btn-join').addEventListener('click', () => connectAndJoin($('room-code').value.trim()));
  $('btn-create').addEventListener('click', () => connectAndJoin(null, false));
  $('btn-report').addEventListener('click', openReportMenu);

  // Username persistence
  const savedName = localStorage.getItem('pv_username');
  if (savedName) $('username').value = savedName;

  // Start loop
  // loop started at end of file

  // Fetch public servers
  fetchServers();
  setInterval(fetchServers, 15000);
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// ---------- Penguin Avatar ----------
function buildPenguinAvatar() {
  const group = new THREE.Group();
  // Body
  const bodyGeo = new THREE.SphereGeometry(0.32, 16, 16);
  bodyGeo.scale(1, 1.25, 0.9);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.35;
  body.castShadow = true;
  group.add(body);
  // Belly
  const bellyGeo = new THREE.SphereGeometry(0.26, 12, 12);
  bellyGeo.scale(0.85, 1.1, 0.7);
  const belly = new THREE.Mesh(bellyGeo, new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.6 }));
  belly.position.set(0, 0.32, 0.12);
  group.add(belly);
  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 14), bodyMat.clone());
  head.position.y = 0.78;
  group.add(head);
  // Eyes
  const eyeGeo = new THREE.SphereGeometry(0.045, 8, 8);
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const eyeL = new THREE.Mesh(eyeGeo, eyeWhite);
  const eyeR = new THREE.Mesh(eyeGeo, eyeWhite);
  eyeL.position.set(-0.08, 0.82, 0.15);
  eyeR.position.set(0.08, 0.82, 0.15);
  group.add(eyeL, eyeR);
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const pupilL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), pupilMat);
  const pupilR = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), pupilMat);
  pupilL.position.set(-0.08, 0.82, 0.185);
  pupilR.position.set(0.08, 0.82, 0.185);
  group.add(pupilL, pupilR);
  // Beak
  const beak = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.12, 6),
    new THREE.MeshStandardMaterial({ color: 0xff9800, roughness: 0.4 })
  );
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.74, 0.22);
  group.add(beak);
  // Wings (arms)
  const wingGeo = new THREE.BoxGeometry(0.08, 0.35, 0.18);
  const wingL = new THREE.Mesh(wingGeo, bodyMat.clone());
  const wingR = new THREE.Mesh(wingGeo, bodyMat.clone());
  wingL.position.set(-0.32, 0.4, 0);
  wingR.position.set(0.32, 0.4, 0);
  wingL.rotation.z = 0.3;
  wingR.rotation.z = -0.3;
  group.add(wingL, wingR);
  // Feet
  const footGeo = new THREE.BoxGeometry(0.14, 0.04, 0.2);
  const footMat = new THREE.MeshStandardMaterial({ color: 0xff9800 });
  const footL = new THREE.Mesh(footGeo, footMat);
  const footR = new THREE.Mesh(footGeo, footMat);
  footL.position.set(-0.1, 0.02, 0.05);
  footR.position.set(0.1, 0.02, 0.05);
  group.add(footL, footR);

  group.visible = false; // local player is first-person; used for remote
  penguinMesh = group;
  scene.add(group);

  // Owner staff (simple)
  const staff = new THREE.Group();
  const stick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.03, 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0xa0d8ef, emissive: 0x224466, emissiveIntensity: 0.4 })
  );
  stick.position.y = 0.6;
  staff.add(stick);
  const headP = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 10),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
  );
  headP.position.y = 1.25;
  staff.add(headP);
  const glow = new THREE.PointLight(0x4fc3f7, 0.8, 2);
  glow.position.y = 1.25;
  staff.add(glow);
  staff.visible = false;
  ownerStaff = staff;
  scene.add(staff);
}

// ---------- Maps (lightweight geometry) ----------
function clearMap() {
  for (const m of mapMeshes) {
    scene.remove(m);
    if (m.geometry) m.geometry.dispose();
    if (m.material) {
      if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose());
      else m.material.dispose();
    }
  }
  mapMeshes = [];
  // Remove static bodies except player/hands
  const toRemove = [];
  world.bodies.forEach(b => {
    if (b !== playerBody && b !== leftHandBody && b !== rightHandBody) toRemove.push(b);
  });
  toRemove.forEach(b => world.removeBody(b));
}

function addStaticBox(x, y, z, w, h, d, color = 0xd0e8ff, ice = true) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: ice ? 0.25 : 0.8, metalness: ice ? 0.15 : 0 })
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  mapMeshes.push(mesh);
  const body = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
    position: new CANNON.Vec3(x, y, z)
  });
  world.addBody(body);
  return mesh;
}

function addStaticSphere(x, y, z, r, color = 0xffffff) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(r, 12, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.3 })
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  scene.add(mesh);
  mapMeshes.push(mesh);
  const body = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Sphere(r),
    position: new CANNON.Vec3(x, y, z)
  });
  world.addBody(body);
}

function loadMap(name) {
  clearMap();
  currentMap = name;
  // Ground plane always
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0xe8f4fc, roughness: 0.5 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  mapMeshes.push(ground);
  const groundBody = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Plane(),
    position: new CANNON.Vec3(0, 0, 0)
  });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  if (name === 'iceberg') {
    scene.background = new THREE.Color(0x87b8e0);
    scene.fog.color.set(0x87b8e0);
    // Giant icebergs
    addStaticBox(0, 1.5, -8, 8, 3, 6, 0xc8e6ff);
    addStaticBox(-12, 2, 5, 6, 4, 5, 0xb0d8f0);
    addStaticBox(14, 1.2, 2, 7, 2.4, 5, 0xd0eaff);
    addStaticBox(5, 3.5, -15, 4, 7, 4, 0xa8d0e8);
    addStaticBox(-6, 0.6, 12, 10, 1.2, 4, 0xd8f0ff); // low platform
    // Climbable ice walls
    addStaticBox(-18, 4, -5, 2, 8, 8, 0xb8d8f0);
    addStaticBox(18, 3, -8, 2, 6, 6, 0xb8d8f0);
    // Snow mounds
    addStaticSphere(3, 0.8, 8, 1.6, 0xffffff);
    addStaticSphere(-4, 0.6, -3, 1.3, 0xffffff);
    addStaticSphere(10, 0.5, 10, 1.1, 0xffffff);
  } else if (name === 'village') {
    scene.background = new THREE.Color(0x9ec8e8);
    // Igloos (simple domes + floors)
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const x = Math.cos(a) * 12;
      const z = Math.sin(a) * 12;
      addStaticSphere(x, 1.2, z, 2.2, 0xeef6ff);
      addStaticBox(x, 0.15, z, 3, 0.3, 3, 0xd0e0f0, false);
    }
    // Shop building
    addStaticBox(0, 1.5, 0, 6, 3, 5, 0xc8d8e8, false);
  } else if (name === 'forest') {
    scene.background = new THREE.Color(0x6a9ab0);
    // Trees (trunks + snowy tops)
    for (let i = 0; i < 18; i++) {
      const x = (Math.random() - 0.5) * 40;
      const z = (Math.random() - 0.5) * 40;
      if (Math.hypot(x, z) < 4) continue;
      addStaticBox(x, 2, z, 0.5, 4, 0.5, 0x4a3020, false);
      addStaticSphere(x, 4.5, z, 1.4, 0xe8f4fc);
    }
    addStaticBox(0, 0.4, 0, 8, 0.8, 8, 0xd0e8f0); // central platform
  } else if (name === 'volcano') {
    scene.background = new THREE.Color(0x2a1810);
    scene.fog.color.set(0x3a2010);
    // Platforms over "lava"
    addStaticBox(0, 1, 0, 5, 0.4, 5, 0x555555, false);
    addStaticBox(6, 2.5, -4, 3, 0.4, 3, 0x666666, false);
    addStaticBox(-5, 3.5, 3, 3, 0.4, 3, 0x666666, false);
    addStaticBox(0, 5, -8, 4, 0.4, 4, 0x777777, false);
    addStaticBox(8, 4, 6, 2.5, 0.4, 2.5, 0x555555, false);
    // Lava visual (no collision, just plane)
    const lava = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 50),
      new THREE.MeshBasicMaterial({ color: 0xff4400 })
    );
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = 0.05;
    scene.add(lava);
    mapMeshes.push(lava);
  } else if (name === 'underwater') {
    scene.background = new THREE.Color(0x0a3050);
    scene.fog.color.set(0x0a3050);
    scene.fog.near = 4;
    scene.fog.far = 40;
    // Coral-ish pillars
    for (let i = 0; i < 12; i++) {
      const x = (Math.random() - 0.5) * 30;
      const z = (Math.random() - 0.5) * 30;
      addStaticBox(x, 1.5, z, 0.8, 3, 0.8, 0xff7a7a, false);
    }
    addStaticBox(0, 0.3, 0, 12, 0.6, 12, 0x3a6a5a, false);
  }
  // Reset player
  playerBody.position.set(0, 2.5, 0);
  playerBody.velocity.set(0, 0, 0);
}

// ---------- Gorilla-Tag style locomotion ----------
function updateLocomotion(dt) {
  const leftPos = new THREE.Vector3();
  const rightPos = new THREE.Vector3();
  leftController.getWorldPosition(leftPos);
  rightController.getWorldPosition(rightPos);

  leftHandBody.position.copy(leftPos);
  rightHandBody.position.copy(rightPos);

  const leftVel = leftPos.clone().sub(input.left.prev).divideScalar(Math.max(dt, 0.001));
  const rightVel = rightPos.clone().sub(input.right.prev).divideScalar(Math.max(dt, 0.001));
  input.left.prev.copy(leftPos);
  input.right.prev.copy(rightPos);
  input.left.pos.copy(leftPos);
  input.right.pos.copy(rightPos);

  const applyPush = (handPos, handVel, gripping) => {
    if (!gripping) return;
    const handY = handPos.y;
    const playerY = playerBody.position.y;
    // Ground / floor push (classic Gorilla Tag style)
    if (handY < playerY - 0.12 && handY > 0.02) {
      playerBody.velocity.x += -handVel.x * PUSH_STRENGTH * dt * 9;
      playerBody.velocity.y += -handVel.y * PUSH_STRENGTH * 0.55 * dt * 9;
      playerBody.velocity.z += -handVel.z * PUSH_STRENGTH * dt * 9;
    }
    // Climb / pull-up assist
    if (handY > playerY + 0.08) {
      playerBody.velocity.y += Math.max(0, -handVel.y) * PUSH_STRENGTH * 1.15 * dt * 7;
      playerBody.velocity.x += -handVel.x * PUSH_STRENGTH * 0.45 * dt * 6;
      playerBody.velocity.z += -handVel.z * PUSH_STRENGTH * 0.45 * dt * 6;
    }
  };

  applyPush(leftPos, leftVel, input.left.gripping);
  applyPush(rightPos, rightVel, input.right.gripping);

  const v = playerBody.velocity;
  const spd = Math.sqrt(v.x * v.x + v.z * v.z);
  if (spd > MAX_SPEED) {
    const s = MAX_SPEED / spd;
    v.x *= s;
    v.z *= s;
  }
  if (playerBody.position.y < BODY_RADIUS + 0.18) {
    v.x *= FRICTION;
    v.z *= FRICTION;
  } else {
    v.x *= AIR_DRAG;
    v.z *= AIR_DRAG;
  }
}

// ---------- Network ----------
function connectAndJoin(code = null, isPrivate = false) {
  const username = ($('username').value || 'Penguin').trim().slice(0, 16);
  localStorage.setItem('pv_username', username);
  setStatus('Connecting...');

  if (ws && ws.readyState <= 1) {
    ws.close();
  }

  const userId = localStorage.getItem('pv_userid') || null;

  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    connected = true;
    setStatus('Authenticating...');
    ws.send(JSON.stringify({ type: 'auth', userId, username }));
  };
  ws.onclose = () => {
    connected = false;
    setStatus('Disconnected');
  };
  ws.onerror = () => setStatus('Connection error – is the server running?');
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };

  // After auth we join
  window._pendingJoin = { code, isPrivate, username };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'authOk':
      localPlayer.id = msg.userId;
      localPlayer.username = msg.profile.username;
      localPlayer.isOwner = msg.isOwner;
      localPlayer.profile = msg.profile;
      localStorage.setItem('pv_userid', msg.userId);
      $('pb').textContent = `PB: ${msg.profile.pb}`;
      setStatus(msg.isOwner ? 'You are the permanent OWNER' : 'Authenticated');
      // Join room
      const j = window._pendingJoin || {};
      ws.send(JSON.stringify({ type: 'join', code: j.code || null, private: j.isPrivate, color: '#ffffff' }));
      break;
    case 'joined':
      roomState = msg.room;
      setStatus(`Room ${msg.room.code} • ${msg.room.mode}`);
      $('mode-label').textContent = msg.room.mode;
      if (msg.room.map !== currentMap) loadMap(msg.room.map);
      // Spawn remotes
      msg.room.players.forEach(p => {
        if (p.id !== localPlayer.id) spawnRemote(p);
      });
      break;
    case 'playerJoined':
      if (msg.player.id !== localPlayer.id) spawnRemote(msg.player);
      break;
    case 'playerLeft':
      removeRemote(msg.id);
      break;
    case 'state':
      updateRemote(msg);
      break;
    case 'tagged':
      setStatus(`Tagged! New tagger: ${msg.tagger.slice(0, 6)}`);
      break;
    case 'roundStart':
      setStatus(`Round started • ${msg.mode}`);
      $('mode-label').textContent = msg.mode;
      break;
    case 'modeChanged':
      $('mode-label').textContent = msg.mode;
      break;
    case 'mapChanged':
      loadMap(msg.map);
      break;
    case 'bought':
      localPlayer.profile.pb = msg.pb;
      $('pb').textContent = `PB: ${msg.pb}`;
      break;
    case 'error':
      setStatus('Error: ' + (msg.code || msg.reason || 'unknown'));
      break;
    case 'kicked':
    case 'banned':
      setStatus(msg.reason || msg.type);
      break;
    case 'reportSubmitted':
      setStatus('Report submitted. Thank you.');
      break;
    case 'newReport':
      if (localPlayer.isOwner) setStatus('New report received');
      break;
  }
}

function spawnRemote(p) {
  if (remotePlayers.has(p.id)) return;
  const clone = penguinMesh.clone();
  clone.visible = true;
  clone.traverse(c => { if (c.isMesh) c.castShadow = true; });
  scene.add(clone);
  remotePlayers.set(p.id, { mesh: clone, data: p, targetPos: new THREE.Vector3(), targetRot: new THREE.Euler() });
}

function removeRemote(id) {
  const r = remotePlayers.get(id);
  if (r) {
    scene.remove(r.mesh);
    remotePlayers.delete(id);
  }
}

function updateRemote(msg) {
  const r = remotePlayers.get(msg.id);
  if (!r) return;
  if (msg.pos) r.targetPos.set(msg.pos.x, msg.pos.y, msg.pos.z);
  // simple lerp later
}

function sendState() {
  if (!ws || ws.readyState !== 1 || !localPlayer.id) return;
  const now = performance.now();
  if (now - lastSent < 50) return; // 20 Hz
  lastSent = now;
  const pos = {
    x: playerBody.position.x,
    y: playerBody.position.y,
    z: playerBody.position.z
  };
  const hands = {
    left: input.left.pos.toArray(),
    right: input.right.pos.toArray()
  };
  ws.send(JSON.stringify({
    type: 'state',
    pos,
    hands,
    vel: { x: playerBody.velocity.x, y: playerBody.velocity.y, z: playerBody.velocity.z }
  }));
}

// ---------- Report menu (simple DOM for now; VR spatial UI later) ----------
function openReportMenu() {
  const reason = prompt('Report reason:\ncheating, exploiting, harassment, bullying, hate speech, inappropriate voice chat, inappropriate username, inappropriate behaviour, spamming, other');
  if (!reason) return;
  const target = prompt('Target player ID (or username fragment)');
  if (!target) return;
  const details = prompt('Optional details') || '';
  // Find id
  let reportedId = target;
  for (const [id, r] of remotePlayers) {
    if (id.includes(target) || (r.data.username || '').toLowerCase().includes(target.toLowerCase())) {
      reportedId = id;
      break;
    }
  }
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'report', reportedId, reason, details }));
  }
}

// ---------- Servers list ----------
async function fetchServers() {
  try {
    const res = await fetch('/api/servers');
    const list = await res.json();
    const el = $('server-list');
    if (!el) return;
    el.innerHTML = list.length ? list.map(s =>
      `<div class="server-item" data-code="${s.code}">${s.code} • ${s.mode} • ${s.players}/12 • ${s.map}</div>`
    ).join('') : '<div style="opacity:0.6">No public rooms – create one!</div>';
    el.querySelectorAll('.server-item').forEach(item => {
      item.onclick = () => {
        $('room-code').value = item.dataset.code;
        connectAndJoin(item.dataset.code);
      };
    });
  } catch (e) {}
}

// ---------- Main loop ----------
// Desktop keyboard helper for testing only (WASD + Space). Real play is VR hand locomotion.
const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup', e => { keys[e.code] = false; });

// Replace the animation loop with a single clean version that includes desktop helpers
renderer.setAnimationLoop(function gameLoop() {
  const dt = Math.min(clock.getDelta(), 0.05);

  // Desktop movement (preview only)
  if (!isVR) {
    if (keys['KeyW']) playerBody.velocity.z -= 7 * dt;
    if (keys['KeyS']) playerBody.velocity.z += 7 * dt;
    if (keys['KeyA']) playerBody.velocity.x -= 7 * dt;
    if (keys['KeyD']) playerBody.velocity.x += 7 * dt;
    if (keys['Space'] && playerBody.position.y < BODY_RADIUS + 0.5) playerBody.velocity.y = 5.5;
  }

  world.step(1 / 60, dt, 3);
  updateLocomotion(dt);

  if (!isVR) {
    camera.position.x = playerBody.position.x;
    camera.position.y = playerBody.position.y + 0.95;
    camera.position.z = playerBody.position.z;
  } else {
    const xrCamera = renderer.xr.getCamera();
    const headPos = new THREE.Vector3();
    xrCamera.getWorldPosition(headPos);
    playerBody.position.x += (headPos.x - playerBody.position.x) * 0.4;
    playerBody.position.z += (headPos.z - playerBody.position.z) * 0.4;
    if (playerBody.position.y < -5) {
      playerBody.position.set(0, 3, 0);
      playerBody.velocity.set(0, 0, 0);
    }
  }

  for (const [, r] of remotePlayers) {
    r.mesh.position.lerp(r.targetPos, 0.22);
  }

  if (localPlayer.isOwner && ownerStaff) {
    if (input.right.gripping) {
      ownerStaff.visible = true;
      rightController.getWorldPosition(ownerStaff.position);
      ownerStaff.position.y += 0.25;
    } else {
      ownerStaff.visible = false;
    }
  }

  sendState();
 init().then(() => {
  renderer.setAnimationLoop(function gameLoop() {
    const dt = Math.min(clock.getDelta(), 0.05);

    if (!isVR) {
      if (keys['KeyW']) playerBody.velocity.z -= 7 * dt;
      if (keys['KeyS']) playerBody.velocity.z += 7 * dt;
      if (keys['KeyA']) playerBody.velocity.x -= 7 * dt;
      if (keys['KeyD']) playerBody.velocity.x += 7 * dt;
      if (keys['Space'] && playerBody.position.y < BODY_RADIUS + 0.5) playerBody.velocity.y = 5.5;
    }

    world.step(1 / 60, dt, 3);
    updateLocomotion(dt);

    if (!isVR) {
      camera.position.x = playerBody.position.x;
      camera.position.y = playerBody.position.y + 0.95;
      camera.position.z = playerBody.position.z;
    } else {
      const xrCamera = renderer.xr.getCamera();
      const headPos = new THREE.Vector3();
      xrCamera.getWorldPosition(headPos);
      playerBody.position.x += (headPos.x - playerBody.position.x) * 0.4;
      playerBody.position.z += (headPos.z - playerBody.position.z) * 0.4;
      if (playerBody.position.y < -5) {
        playerBody.position.set(0, 3, 0);
        playerBody.velocity.set(0, 0, 0);
      }
    }

    for (const [, r] of remotePlayers) {
      r.mesh.position.lerp(r.targetPos, 0.22);
    }

    if (localPlayer.isOwner && ownerStaff) {
      if (input.right.gripping) {
        ownerStaff.visible = true;
        rightController.getWorldPosition(ownerStaff.position);
        ownerStaff.position.y += 0.25;
      } else {
        ownerStaff.visible = false;
      }
    }

    sendState();
    renderer.render(scene, camera);
  });
});
