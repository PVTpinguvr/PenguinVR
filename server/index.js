/**
 * Penguin VR - Zero-dependency multiplayer server (Node built-ins only)
 * Authoritative rooms, owner, bans, reports, cosmetics, Penguin Bucks
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const files = {
  owner: path.join(DATA, 'owner.json'),
  players: path.join(DATA, 'players.json'),
  reports: path.join(DATA, 'reports.json'),
  bans: path.join(DATA, 'bans.json'),
  cosmetics: path.join(DATA, 'cosmetics.json')
};

function load(f, fb = {}) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  return typeof fb === 'function' ? fb() : fb;
}
function save(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }

let ownerData = load(files.owner, { userId: null, username: null, claimedAt: null });
let playerStore = load(files.players, {});
let reportStore = load(files.reports, []);
let banStore = load(files.bans, {});
let cosmeticsDef = load(files.cosmetics, null);

if (!cosmeticsDef) {
  cosmeticsDef = {
    hats: [
      { id: 'hat_crown', name: 'Penguin Crown', cost: 0, ownerOnly: true, rarity: 'legendary' },
      { id: 'hat_beanie', name: 'Winter Beanie', cost: 50, rarity: 'common' },
      { id: 'hat_top', name: 'Top Hat', cost: 200, rarity: 'rare' },
      { id: 'hat_santa', name: 'Santa Hat', cost: 150, seasonal: 'christmas', rarity: 'rare' },
      { id: 'hat_pumpkin', name: 'Pumpkin Hat', cost: 150, seasonal: 'halloween', rarity: 'rare' }
    ],
    scarves: [
      { id: 'scarf_red', name: 'Red Scarf', cost: 30, rarity: 'common' },
      { id: 'scarf_stripe', name: 'Striped Scarf', cost: 80, rarity: 'uncommon' }
    ],
    glasses: [
      { id: 'glasses_round', name: 'Round Specs', cost: 40, rarity: 'common' },
      { id: 'glasses_cool', name: 'Cool Shades', cost: 120, rarity: 'rare' }
    ],
    backpacks: [
      { id: 'bp_fish', name: 'Fish Backpack', cost: 100, rarity: 'uncommon' },
      { id: 'bp_egg', name: 'Egg Carrier', cost: 250, rarity: 'rare' }
    ],
    trails: [
      { id: 'trail_snow', name: 'Snow Trail', cost: 200, rarity: 'rare' },
      { id: 'trail_ice', name: 'Ice Sparkle', cost: 300, rarity: 'epic' }
    ],
    companions: [
      { id: 'comp_chick', name: 'Baby Chick', cost: 500, rarity: 'epic' },
      { id: 'comp_owner', name: 'Staff Companion', cost: 0, ownerOnly: true, rarity: 'legendary' }
    ],
    staff: [
      { id: 'staff_penguin', name: 'Penguin Staff', cost: 0, ownerOnly: true, rarity: 'legendary' }
    ]
  };
  save(files.cosmetics, cosmeticsDef);
}

const MAPS = ['iceberg', 'village', 'forest', 'volcano', 'underwater'];
const MODES = ['tag', 'infection', 'hide', 'freeze', 'casual', 'battle', 'hunt', 'paintbrawl'];
const rooms = new Map();
const clients = new Map();

class Room {
  constructor(code, isPrivate = false) {
    this.code = code;
    this.isPrivate = isPrivate;
    this.players = new Map();
    this.map = 'iceberg';
    this.mode = 'casual';
    this.phase = 'lobby';
    this.tagger = null;
    this.scores = {};
    this.createdAt = Date.now();
  }
  broadcast(msg, excludeId = null) {
    const data = JSON.stringify(msg);
    for (const [id, p] of this.players) {
      if (id !== excludeId && p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  }
  getPublicState() {
    return {
      code: this.code, map: this.map, mode: this.mode, phase: this.phase,
      playerCount: this.players.size,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id, username: p.username, color: p.color, cosmetics: p.cosmetics,
        isOwner: p.id === ownerData.userId, isTagger: p.id === this.tagger, frozen: !!p.frozen,
        score: this.scores[p.id] || 0
      }))
    };
  }
}

function createRoom(isPrivate = false) {
  let code;
  do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); } while (rooms.has(code));
  const room = new Room(code, isPrivate);
  rooms.set(code, room);
  return room;
}

function isBanned(userId) {
  const b = banStore[userId];
  if (!b) return false;
  if (b.permanent) return true;
  if (b.until && Date.now() < b.until) return true;
  if (b.until && Date.now() >= b.until) { delete banStore[userId]; save(files.bans, banStore); return false; }
  return false;
}

function getOrCreatePlayer(userId, username) {
  if (!playerStore[userId]) {
    playerStore[userId] = {
      userId, username: username || ('Penguin' + Math.floor(Math.random() * 9999)),
      pb: 100, level: 1, xp: 0, totalTags: 0, wins: 0, gamesPlayed: 0, playtime: 0,
      cosmeticsOwned: ['hat_beanie'],
      equipped: { hat: null, scarf: null, glasses: null, backpack: null, trail: null, companion: null },
      friends: [], createdAt: Date.now(), lastLogin: Date.now()
    };
    if (!ownerData.userId) {
      ownerData = { userId, username: playerStore[userId].username, claimedAt: Date.now() };
      save(files.owner, ownerData);
      playerStore[userId].cosmeticsOwned.push('hat_crown', 'staff_penguin', 'comp_owner');
      playerStore[userId].equipped.hat = 'hat_crown';
      playerStore[userId].pb += 1000;
      console.log('[OWNER] Permanent owner set:', userId, playerStore[userId].username);
    }
    save(files.players, playerStore);
  } else {
    playerStore[userId].lastLogin = Date.now();
    if (username) playerStore[userId].username = username;
    save(files.players, playerStore);
  }
  return playerStore[userId];
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function parseFrames(buffer, onMsg) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hdr = 2;
    if (len === 126) { if (offset + 4 > buffer.length) break; len = buffer.readUInt16BE(offset + 2); hdr = 4; }
    else if (len === 127) { if (offset + 10 > buffer.length) break; len = Number(buffer.readBigUInt64BE(offset + 2)); hdr = 10; }
    const maskOffset = offset + hdr;
    const dataOffset = maskOffset + (masked ? 4 : 0);
    if (dataOffset + len > buffer.length) break;
    let payload = buffer.slice(dataOffset, dataOffset + len);
    if (masked) {
      const mask = buffer.slice(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    offset = dataOffset + len;
    if (opcode === 0x1) onMsg(payload.toString('utf8'));
    else if (opcode === 0x8) return 'close';
  }
  return buffer.slice(offset);
}

function sendWs(socket, text) {
  if (!socket || socket.destroyed) return;
  const payload = Buffer.from(text);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

function makeWsWrapper(socket) {
  return {
    readyState: 1,
    send(data) { sendWs(socket, typeof data === 'string' ? data : JSON.stringify(data)); },
    close() { try { socket.end(); } catch {} },
    _socket: socket
  };
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host);
  if (u.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: clients.size }));
  }
  if (u.pathname === '/api/owner') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ hasOwner: !!ownerData.userId, username: ownerData.username }));
  }
  if (u.pathname === '/api/cosmetics') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(cosmeticsDef));
  }
  if (u.pathname === '/api/servers') {
    const list = [];
    for (const [code, room] of rooms) {
      if (!room.isPrivate) list.push({ code, map: room.map, mode: room.mode, phase: room.phase, players: room.players.size, max: 12 });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(list));
  }
  let filePath = path.join(CLIENT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!filePath.startsWith(CLIENT)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = acceptKey(key);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ws = makeWsWrapper(socket);
  const client = { id: null, ws, room: null, authenticated: false, buf: Buffer.alloc(0) };
  clients.set(ws, client);
  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    const result = parseFrames(client.buf, (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      handleMessage(client, msg);
    });
    if (result === 'close') { socket.end(); return; }
    if (Buffer.isBuffer(result)) client.buf = result;
  });
  socket.on('close', () => {
    if (client.room && client.id) {
      const room = rooms.get(client.room);
      if (room) {
        room.players.delete(client.id);
        room.broadcast({ type: 'playerLeft', id: client.id });
        if (room.players.size === 0) rooms.delete(client.room);
      }
    }
    clients.delete(ws);
  });
  socket.on('error', () => {});
});

function handleMessage(client, msg) {
  switch (msg.type) {
    case 'auth': {
      const userId = msg.userId || uuid();
      if (isBanned(userId)) {
        client.ws.send(JSON.stringify({ type: 'error', code: 'BANNED', reason: banStore[userId] && banStore[userId].reason || 'Banned' }));
        client.ws.close();
        return;
      }
      const profile = getOrCreatePlayer(userId, msg.username);
      client.id = userId;
      client.authenticated = true;
      client.ws.send(JSON.stringify({
        type: 'authOk', userId, profile, isOwner: userId === ownerData.userId,
        ownerUsername: ownerData.username, cosmetics: cosmeticsDef
      }));
      break;
    }
    case 'join': {
      if (!client.authenticated) return;
      let room = msg.code ? rooms.get(String(msg.code).toUpperCase()) : null;
      if (!room) room = createRoom(!!msg.private);
      if (room.players.size >= 12) {
        client.ws.send(JSON.stringify({ type: 'error', code: 'FULL' }));
        return;
      }
      const profile = playerStore[client.id];
      const playerState = {
        id: client.id, username: profile.username, color: msg.color || '#ffffff',
        cosmetics: profile.equipped, ws: client.ws,
        pos: { x: 0, y: 1.2, z: 0 }, rot: { x: 0, y: 0, z: 0 },
        hands: { left: null, right: null }, vel: { x: 0, y: 0, z: 0 },
        frozen: false, isOwner: client.id === ownerData.userId
      };
      room.players.set(client.id, playerState);
      client.room = room.code;
      client.ws.send(JSON.stringify({ type: 'joined', room: room.getPublicState(), selfId: client.id }));
      room.broadcast({ type: 'playerJoined', player: {
        id: playerState.id, username: playerState.username, color: playerState.color,
        cosmetics: playerState.cosmetics, isOwner: playerState.isOwner
      }}, client.id);
      break;
    }
    case 'state': {
      if (!client.room) return;
      const room = rooms.get(client.room);
      if (!room) return;
      const p = room.players.get(client.id);
      if (!p) return;
      if (msg.pos) p.pos = msg.pos;
      if (msg.rot) p.rot = msg.rot;
      if (msg.hands) p.hands = msg.hands;
      if (msg.vel) p.vel = msg.vel;
      room.broadcast({ type: 'state', id: client.id, pos: p.pos, rot: p.rot, hands: p.hands, vel: p.vel }, client.id);
      break;
    }
    case 'tag': {
      if (!client.room) return;
      const room = rooms.get(client.room);
      if (!room || room.phase !== 'playing') return;
      const target = room.players.get(msg.targetId);
      if (!target) return;
      if (room.mode === 'tag' || room.mode === 'infection') {
        room.tagger = msg.targetId;
        room.broadcast({ type: 'tagged', tagger: msg.targetId, by: client.id });
        const taggerProfile = playerStore[client.id];
        if (taggerProfile) { taggerProfile.totalTags = (taggerProfile.totalTags || 0) + 1; taggerProfile.pb += 5; save(files.players, playerStore); }
      } else if (room.mode === 'freeze') {
        target.frozen = true;
        room.broadcast({ type: 'frozen', id: msg.targetId });
      }
      break;
    }
    case 'setMode': {
      if (client.id !== ownerData.userId) return;
      const room = rooms.get(client.room);
      if (room && MODES.includes(msg.mode)) { room.mode = msg.mode; room.phase = 'lobby'; room.broadcast({ type: 'modeChanged', mode: room.mode }); }
      break;
    }
    case 'setMap': {
      if (client.id !== ownerData.userId) return;
      const room = rooms.get(client.room);
      if (room && MAPS.includes(msg.map)) { room.map = msg.map; room.broadcast({ type: 'mapChanged', map: room.map }); }
      break;
    }
    case 'startRound': {
      if (client.id !== ownerData.userId) return;
      const room = rooms.get(client.room);
      if (!room) return;
      room.phase = 'playing';
      room.roundTime = msg.time || 180;
      const ids = Array.from(room.players.keys());
      if (ids.length && ['tag', 'infection', 'freeze'].includes(room.mode)) room.tagger = ids[Math.floor(Math.random() * ids.length)];
      room.broadcast({ type: 'roundStart', mode: room.mode, tagger: room.tagger, time: room.roundTime });
      break;
    }
    case 'kick':
    case 'ban': {
      if (client.id !== ownerData.userId) return;
      const room = rooms.get(client.room);
      if (!room) return;
      const targetId = msg.targetId;
      if (msg.type === 'ban') {
        banStore[targetId] = { reason: msg.reason || 'Banned by owner', permanent: !!msg.permanent, until: msg.permanent ? null : Date.now() + (msg.durationMs || 3600000), by: client.id, at: Date.now() };
        save(files.bans, banStore);
      }
      const t = room.players.get(targetId);
      if (t && t.ws) {
        t.ws.send(JSON.stringify({ type: msg.type === 'ban' ? 'banned' : 'kicked', reason: msg.reason || msg.type }));
        t.ws.close();
      }
      room.players.delete(targetId);
      room.broadcast({ type: 'playerLeft', id: targetId });
      client.ws.send(JSON.stringify({ type: 'adminOk', action: msg.type, targetId }));
      break;
    }
    case 'report': {
      const report = { id: uuid(), reporterId: client.id, reportedId: msg.reportedId, reason: msg.reason, details: msg.details || '', timestamp: Date.now(), room: client.room, status: 'open', notes: [] };
      reportStore.push(report);
      save(files.reports, reportStore);
      client.ws.send(JSON.stringify({ type: 'reportSubmitted', id: report.id }));
      for (const [, c] of clients) {
        if (c.id === ownerData.userId && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'newReport', report }));
      }
      break;
    }
    case 'modAction': {
      if (client.id !== ownerData.userId) return;
      const report = reportStore.find(r => r.id === msg.reportId);
      if (!report) return;
      report.status = 'resolved';
      report.action = msg.action;
      report.notes.push({ by: client.id, text: msg.note || '', at: Date.now() });
      const durationMap = { mute5: 300000, mute30: 1800000, ban1h: 3600000, ban24h: 86400000, ban7d: 604800000, ban30d: 2592000000, banperm: null };
      if (msg.action && msg.action !== 'warning') {
        if (msg.action.startsWith('mute')) {
          banStore[report.reportedId] = banStore[report.reportedId] || {};
          banStore[report.reportedId].mutedUntil = Date.now() + (durationMap[msg.action] || 0);
        } else if (msg.action.startsWith('ban')) {
          banStore[report.reportedId] = { reason: report.reason, permanent: msg.action === 'banperm', until: durationMap[msg.action] ? Date.now() + durationMap[msg.action] : null, by: client.id, at: Date.now() };
        }
        save(files.bans, banStore);
      }
      save(files.reports, reportStore);
      client.ws.send(JSON.stringify({ type: 'modActionOk', reportId: report.id }));
      break;
    }
    case 'buyCosmetic': {
      const profile = playerStore[client.id];
      if (!profile) return;
      const all = Object.values(cosmeticsDef).flat();
      const item = all.find(i => i.id === msg.itemId);
      if (!item) return;
      if (item.ownerOnly && client.id !== ownerData.userId) { client.ws.send(JSON.stringify({ type: 'error', code: 'OWNER_ONLY' })); return; }
      if (profile.cosmeticsOwned.includes(item.id)) { client.ws.send(JSON.stringify({ type: 'error', code: 'ALREADY_OWNED' })); return; }
      if (profile.pb < item.cost) { client.ws.send(JSON.stringify({ type: 'error', code: 'NOT_ENOUGH_PB' })); return; }
      profile.pb -= item.cost;
      profile.cosmeticsOwned.push(item.id);
      save(files.players, playerStore);
      client.ws.send(JSON.stringify({ type: 'bought', itemId: item.id, pb: profile.pb }));
      break;
    }
    case 'equip': {
      const profile = playerStore[client.id];
      if (!profile) return;
      if (msg.itemId && !profile.cosmeticsOwned.includes(msg.itemId)) return;
      if (profile.equipped.hasOwnProperty(msg.slot)) {
        profile.equipped[msg.slot] = msg.itemId;
        save(files.players, playerStore);
        const room = rooms.get(client.room);
        if (room) {
          const p = room.players.get(client.id);
          if (p) p.cosmetics = profile.equipped;
          room.broadcast({ type: 'cosmeticsUpdated', id: client.id, cosmetics: profile.equipped });
        }
        client.ws.send(JSON.stringify({ type: 'equipped', slot: msg.slot, itemId: msg.itemId }));
      }
      break;
    }
    case 'webrtc-signal': {
      if (!client.room) return;
      const room = rooms.get(client.room);
      if (!room) return;
      const target = room.players.get(msg.to);
      if (target && target.ws && target.ws.readyState === 1) {
        target.ws.send(JSON.stringify({ type: 'webrtc-signal', from: client.id, signal: msg.signal }));
      }
      break;
    }
    case 'ping':
      client.ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      break;
  }
}

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && Date.now() - room.createdAt > 60000) rooms.delete(code);
  }
}, 30000);

server.listen(PORT, () => {
  console.log('Penguin VR server http://localhost:' + PORT);
  console.log('Owner: ' + (ownerData.userId ? ownerData.username + ' (' + ownerData.userId + ')' : 'UNCLAIMED – first player becomes permanent owner'));
});
