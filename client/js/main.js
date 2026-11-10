/**
 * Penguin Tag VR - Core Client (fixed)
 * WebXR + Three.js + Cannon-es
 */
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import * as CANNON from 'cannon-es';

function getWsUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('server')) return params.get('server');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
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

let renderer, scene, camera, clock;
let world;
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
let input = {
  left: { gripping: false, pos: new THREE.Vector3(), prev: new THREE.Vector3() },
  right: { gripping: false, pos: new THREE.Vector3(), prev: new THREE.Vector3() }
};

const $ = (id) => document.getElementById(id);
function setStatus(t) { const el = $('status'); if (el) el.textContent = t; }

const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup', e => { keys[e.code] = false; });

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
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xddeeff, 0x445566, 0.9));
  const sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  scene.add(sun);

  world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;

  playerBody = new CANNON.Body({
    mass: 70,
    shape: new CANNON.Sphere(BODY_RADIUS),
    linearDamping: 0.05,
    angularDamping: 0.9,
    fixedRotation: true
  });
  playerBody.position.set(0, 2, 0);
  world.addBody(playerBody);

  leftHandBody = new CANNON.Body({ mass: 0, shape: new CANNON.Sphere(HAND_RADIUS), type: CANNON.Body.KINEMATIC });
  rightHandBody = new CANNON.Body({ mass: 0, shape: new CANNON.Sphere(HAND_RADIUS), type: CANNON.Body.KINEMATIC });
  world.addBody(leftHandBody);
  world.addBody(rightHandBody);

  leftController = renderer.xr.getController(0);
  rightController = renderer.xr.getController(1);
  leftGrip = renderer.xr.getControllerGrip(0);
  rightGrip = renderer.xr.getControllerGrip(1);
  scene.add(leftController, rightController, leftGrip, rightGrip);

  const handGeo = new THREE.SphereGeometry(0.07, 12, 12);
  const handMat = new THREE.MeshStandardMaterial({ color: 0xffe0b0 });
  leftController.add(new THREE.Mesh(handGeo, handMat));
  rightController.add(new THREE.Mesh(handGeo, handMat.clone()));

  const gripOn = (side) => () => { input[side].gripping = true; };
  const gripOff = (side) => () => { input[side].gripping = false; };
  leftController.addEventListener('selectstart', gripOn('left'));
  leftController.addEventListener('selectend', gripOff('left'));
  rightController.addEventListener('selectstart', gripOn('right'));
  rightController.addEventListener('selectend', gripOff('right'));
  leftController.addEventListener('squeezestart', gripOn('left'));
  leftController.addEventListener('squeezeend', gripOff('left'));
  rightController.addEventListener('squeezestart', gripOn('right'));
  rightController.addEventListener('squeezeend', gripOff('right'));

  buildPenguinAvatar();
  loadMap('iceberg');

  renderer.xr.addEventListener('sessionstart', () => {
    isVR = true;
    if ($('lobby')) $('lobby').classList.add('hidden');
    if ($('hud')) $('hud').classList.remove('hidden');
    setStatus('VR active');
  });
  renderer.xr.addEventListener('sessionend', () => {
    isVR = false;
    if ($('lobby')) $('lobby').classList.remove('hidden');
    if ($('hud')) $('hud').classList.add('hidden');
  });

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  document.body.appendChild(VRButton.createButton(renderer));

  if ($('btn-enter-vr')) $('btn-enter-vr').onclick = () => setStatus('Use the VR button (bottom) with headset');
  if ($('btn-desktop')) $('btn-desktop').onclick = () => {
    if ($('lobby')) $('lobby').classList.add('hidden');
    if ($('hud')) $('hud').classList.remove('hidden');
    connectAndJoin();
  };
  if ($('btn-join')) $('btn-join').onclick = () => connectAndJoin(($('room-code') && $('room-code').value || '').trim());
  if ($('btn-create')) $('btn-create').onclick = () => connectAndJoin(null, false);
  if ($('btn-report')) $('btn-report').onclick = openReportMenu;

  const saved = localStorage.getItem('pv_username');
  if (saved && $('username')) $('username').value = saved;

  fetchServers();
  setInterval(fetchServers, 15000);
  setStatus('Ready – click Desktop Preview');
}

function buildPenguinAvatar() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
  const bodyGeo = new THREE.SphereGeometry(0.32, 16, 16);
  bodyGeo.scale(1, 1.25, 0.9);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.35;
  group.add(body);
  const bellyGeo = new THREE.SphereGeometry(0.26, 12, 12);
  bellyGeo.scale(0.85, 1.1, 0.7);
  const belly = new THREE.Mesh(bellyGeo, new THREE.MeshStandardMaterial({ color: 0xf5f5f0 }));
  belly.position.set(0, 0.32, 0.12);
  group.add(belly);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 14), bodyMat.clone());
  head.position.y = 0.78;
  group.add(head);
  const eyeGeo = new THREE.SphereGeometry(0.045, 8, 8);
  const eyeL = new THREE.Mesh(eyeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  const eyeR = new THREE.Mesh(eyeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  eyeL.position.set(-0.08, 0.82, 0.15);
  eyeR.position.set(0.08, 0.82, 0.15);
  group.add(eyeL, eyeR);
  const pupilL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  const pupilR = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  pupilL.position.set(-0.08, 0.82, 0.185);
  pupilR.position.set(0.08, 0.82, 0.185);
  group.add(pupilL, pupilR);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 6), new THREE.MeshStandardMaterial({ color: 0xff9800 }));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.74, 0.22);
  group.add(beak);
  const wingGeo = new THREE.BoxGeometry(0.08, 0.35, 0.18);
  const wingL = new THREE.Mesh(wingGeo, bodyMat.clone());
  const wingR = new THREE.Mesh(wingGeo, bodyMat.clone());
  wingL.position.set(-0.32, 0.4, 0); wingR.position.set(0.32, 0.4, 0);
  wingL.rotation.z = 0.3; wingR.rotation.z = -0.3;
  group.add(wingL, wingR);
  const footMat = new THREE.MeshStandardMaterial({ color: 0xff9800 });
  const footL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.2), footMat);
  const footR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.2), footMat);
  footL.position.set(-0.1, 0.02, 0.05); footR.position.set(0.1, 0.02, 0.05);
  group.add(footL, footR);
  group.visible = false;
  penguinMesh = group;
  scene.add(group);

  const staff = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.2, 8), new THREE.MeshStandardMaterial({ color: 0xa0d8ef, emissive: 0x224466, emissiveIntensity: 0.4 }));
  stick.position.y = 0.6; staff.add(stick);
  const headP = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }));
  headP.position.y = 1.25; staff.add(headP);
  staff.visible = false;
  ownerStaff = staff;
  scene.add(staff);
}

function clearMap() {
  for (const m of mapMeshes) {
    scene.remove(m);
    if (m.geometry) m.geometry.dispose();
  }
  mapMeshes = [];
  const toRemove = [];
  world.bodies.forEach(b => { if (b !== playerBody && b !== leftHandBody && b !== rightHandBody) toRemove.push(b); });
  toRemove.forEach(b => world.removeBody(b));
}

function addStaticBox(x, y, z, w, h, d, color = 0xd0e8ff) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.3 }));
  mesh.position.set(x, y, z);
  scene.add(mesh);
  mapMeshes.push(mesh);
  world.addBody(new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(w/2, h/2, d/2)), position: new CANNON.Vec3(x, y, z) }));
}

function addStaticSphere(x, y, z, r, color = 0xffffff) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(x, y, z);
  scene.add(mesh);
  mapMeshes.push(mesh);
  world.addBody(new CANNON.Body({ mass: 0, shape: new CANNON.Sphere(r), position: new CANNON.Vec3(x, y, z) }));
}

function loadMap(name) {
  clearMap();
  currentMap = name;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0xe8f4fc }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  mapMeshes.push(ground);
  const gb = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  gb.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(gb);

  if (name === 'iceberg' || !name) {
    scene.background = new THREE.Color(0x87b8e0);
    addStaticBox(0, 1.5, -8, 8, 3, 6, 0xc8e6ff);
    addStaticBox(-12, 2, 5, 6, 4, 5, 0xb0d8f0);
    addStaticBox(14, 1.2, 2, 7, 2.4, 5, 0xd0eaff);
    addStaticBox(5, 3.5, -15, 4, 7, 4, 0xa8d0e8);
    addStaticBox(-6, 0.6, 12, 10, 1.2, 4, 0xd8f0ff);
    addStaticBox(-18, 4, -5, 2, 8, 8, 0xb8d8f0);
    addStaticSphere(3, 0.8, 8, 1.6);
  } else if (name === 'village') {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      addStaticSphere(Math.cos(a) * 12, 1.2, Math.sin(a) * 12, 2.2, 0xeef6ff);
    }
    addStaticBox(0, 1.5, 0, 6, 3, 5, 0xc8d8e8);
  } else if (name === 'forest') {
    for (let i = 0; i < 14; i++) {
      const x = (Math.random() - 0.5) * 40, z = (Math.random() - 0.5) * 40;
      if (Math.hypot(x, z) < 4) continue;
      addStaticBox(x, 2, z, 0.5, 4, 0.5, 0x4a3020);
      addStaticSphere(x, 4.5, z, 1.4, 0xe8f4fc);
    }
  } else if (name === 'volcano') {
    scene.background = new THREE.Color(0x2a1810);
    addStaticBox(0, 1, 0, 5, 0.4, 5, 0x555555);
    addStaticBox(6, 2.5, -4, 3, 0.4, 3, 0x666666);
    addStaticBox(-5, 3.5, 3, 3, 0.4, 3, 0x666666);
  } else if (name === 'underwater') {
    scene.background = new THREE.Color(0x0a3050);
    for (let i = 0; i < 10; i++) addStaticBox((Math.random()-0.5)*30, 1.5, (Math.random()-0.5)*30, 0.8, 3, 0.8, 0xff7a7a);
  }
  playerBody.position.set(0, 2.5, 0);
  playerBody.velocity.set(0, 0, 0);
}

function updateLocomotion(dt) {
  const leftPos = new THREE.Vector3(), rightPos = new THREE.Vector3();
  leftController.getWorldPosition(leftPos);
  rightController.getWorldPosition(rightPos);
  leftHandBody.position.copy(leftPos);
  rightHandBody.position.copy(rightPos);
  const leftVel = leftPos.clone().sub(input.left.prev).divideScalar(Math.max(dt, 0.001));
  const rightVel = rightPos.clone().sub(input.right.prev).divideScalar(Math.max(dt, 0.001));
  input.left.prev.copy(leftPos); input.right.prev.copy(rightPos);
  input.left.pos.copy(leftPos); input.right.pos.copy(rightPos);

  const push = (handPos, handVel, gripping) => {
    if (!gripping) return;
    const hy = handPos.y, py = playerBody.position.y;
    if (hy < py - 0.12 && hy > 0.02) {
      playerBody.velocity.x += -handVel.x * PUSH_STRENGTH * dt * 9;
      playerBody.velocity.y += -handVel.y * PUSH_STRENGTH * 0.55 * dt * 9;
      playerBody.velocity.z += -handVel.z * PUSH_STRENGTH * dt * 9;
    }
    if (hy > py + 0.08) {
      playerBody.velocity.y += Math.max(0, -handVel.y) * PUSH_STRENGTH * 1.15 * dt * 7;
      playerBody.velocity.x += -handVel.x * PUSH_STRENGTH * 0.45 * dt * 6;
      playerBody.velocity.z += -handVel.z * PUSH_STRENGTH * 0.45 * dt * 6;
    }
  };
  push(leftPos, leftVel, input.left.gripping);
  push(rightPos, rightVel, input.right.gripping);

  const v = playerBody.velocity;
  const spd = Math.sqrt(v.x * v.x + v.z * v.z);
  if (spd > MAX_SPEED) { const s = MAX_SPEED / spd; v.x *= s; v.z *= s; }
  if (playerBody.position.y < BODY_RADIUS + 0.18) { v.x *= FRICTION; v.z *= FRICTION; }
  else { v.x *= AIR_DRAG; v.z *= AIR_DRAG; }
}

function connectAndJoin(code = null) {
  const username = (($('username') && $('username').value) || 'Penguin').trim().slice(0, 16);
  localStorage.setItem('pv_username', username);
  setStatus('Connecting...');
  if (ws && ws.readyState <= 1) try { ws.close(); } catch(e) {}
  const userId = localStorage.getItem('pv_userid') || null;
  ws = new WebSocket(SERVER_URL);
  ws.onopen = () => {
    setStatus('Authenticating...');
    ws.send(JSON.stringify({ type: 'auth', userId, username }));
  };
  ws.onclose = () => setStatus('Disconnected');
  ws.onerror = () => setStatus('Connection error');
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };
  window._pendingJoin = { code, username };
}

function handleServerMessage(msg) {
  if (msg.type === 'authOk') {
    localPlayer.id = msg.userId;
    localPlayer.username = msg.profile.username;
    localPlayer.isOwner = msg.isOwner;
    localPlayer.profile = msg.profile;
    localStorage.setItem('pv_userid', msg.userId);
    if ($('pb')) $('pb').textContent = 'PB: ' + msg.profile.pb;
    setStatus(msg.isOwner ? 'You are the permanent OWNER' : 'Authenticated');
    const j = window._pendingJoin || {};
    ws.send(JSON.stringify({ type: 'join', code: j.code || null, color: '#ffffff' }));
  } else if (msg.type === 'joined') {
    roomState = msg.room;
    setStatus('Room ' + msg.room.code + ' • ' + msg.room.mode);
    if ($('mode-label')) $('mode-label').textContent = msg.room.mode;
    if (msg.room.map !== currentMap) loadMap(msg.room.map);
    msg.room.players.forEach(p => { if (p.id !== localPlayer.id) spawnRemote(p); });
  } else if (msg.type === 'playerJoined' && msg.player.id !== localPlayer.id) spawnRemote(msg.player);
  else if (msg.type === 'playerLeft') removeRemote(msg.id);
  else if (msg.type === 'state') updateRemote(msg);
  else if (msg.type === 'error') setStatus('Error: ' + (msg.code || msg.reason || 'unknown'));
  else if (msg.type === 'mapChanged') loadMap(msg.map);
  else if (msg.type === 'modeChanged' && $('mode-label')) $('mode-label').textContent = msg.mode;
  else if (msg.type === 'reportSubmitted') setStatus('Report submitted');
}

function spawnRemote(p) {
  if (remotePlayers.has(p.id) || !penguinMesh) return;
  const clone = penguinMesh.clone();
  clone.visible = true;
  scene.add(clone);
  remotePlayers.set(p.id, { mesh: clone, data: p, targetPos: new THREE.Vector3() });
}
function removeRemote(id) {
  const r = remotePlayers.get(id);
  if (r) { scene.remove(r.mesh); remotePlayers.delete(id); }
}
function updateRemote(msg) {
  const r = remotePlayers.get(msg.id);
  if (r && msg.pos) r.targetPos.set(msg.pos.x, msg.pos.y, msg.pos.z);
}
function sendState() {
  if (!ws || ws.readyState !== 1 || !localPlayer.id || !playerBody) return;
  const now = performance.now();
  if (now - lastSent < 50) return;
  lastSent = now;
  ws.send(JSON.stringify({
    type: 'state',
    pos: { x: playerBody.position.x, y: playerBody.position.y, z: playerBody.position.z },
    hands: { left: input.left.pos.toArray(), right: input.right.pos.toArray() },
    vel: { x: playerBody.velocity.x, y: playerBody.velocity.y, z: playerBody.velocity.z }
  }));
}
function openReportMenu() {
  const reason = prompt('Report reason (cheating, harassment, etc.)');
  if (!reason) return;
  const target = prompt('Target player id/name');
  if (!target) return;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'report', reportedId: target, reason, details: '' }));
}
async function fetchServers() {
  try {
    const res = await fetch('/api/servers');
    const list = await res.json();
    const el = $('server-list');
    if (!el) return;
    el.innerHTML = list.length
      ? list.map(s => '<div class="server-item" data-code="'+s.code+'">'+s.code+' • '+s.mode+' • '+s.players+'/12</div>').join('')
      : '<div style="opacity:0.6">No public rooms</div>';
    el.querySelectorAll('.server-item').forEach(item => {
      item.onclick = () => { if ($('room-code')) $('room-code').value = item.dataset.code; connectAndJoin(item.dataset.code); };
    });
  } catch (e) {}
}

function gameLoop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!isVR) {
    if (keys['KeyW']) playerBody.velocity.z -= 7 * dt;
    if (keys['KeyS']) playerBody.velocity.z += 7 * dt;
    if (keys['KeyA']) playerBody.velocity.x -= 7 * dt;
    if (keys['KeyD']) playerBody.velocity.x += 7 * dt;
    if (keys['Space'] && playerBody.position.y < BODY_RADIUS + 0.5) playerBody.velocity.y = 5.5;
  }
  world.step(1/60, dt, 3);
  updateLocomotion(dt);
  if (!isVR) {
    camera.position.set(playerBody.position.x, playerBody.position.y + 0.95, playerBody.position.z);
  } else {
    const headPos = new THREE.Vector3();
    renderer.xr.getCamera().getWorldPosition(headPos);
    playerBody.position.x += (headPos.x - playerBody.position.x) * 0.4;
    playerBody.position.z += (headPos.z - playerBody.position.z) * 0.4;
    if (playerBody.position.y < -5) { playerBody.position.set(0, 3, 0); playerBody.velocity.set(0, 0, 0); }
  }
  for (const [, r] of remotePlayers) r.mesh.position.lerp(r.targetPos, 0.22);
  if (localPlayer.isOwner && ownerStaff && input.right.gripping) {
    ownerStaff.visible = true;
    rightController.getWorldPosition(ownerStaff.position);
    ownerStaff.position.y += 0.25;
  } else if (ownerStaff) ownerStaff.visible = false;
  sendState();
  renderer.render(scene, camera);
}

init().then(() => {
  renderer.setAnimationLoop(gameLoop);
}).catch(err => {
  console.error(err);
  setStatus('Start failed: ' + err.message);
});
