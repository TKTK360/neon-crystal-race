'use strict';
/**
 * altare-three-game サーバー
 * - Node 標準 http で public/ を配信し、同じポートで WebSocket を受ける
 * - Altare App Hosting 用に 0.0.0.0 / process.env.PORT || 3000 で待ち受ける
 * - サーバー権威: オーブ取得・スコア・スキルクールダウン・ノックバック・タイマー
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const ARENA = 21;               // プレイエリアは -ARENA..ARENA
const GAME_DURATION = 180;      // 3分
const ORB_COUNT = 12;
const TICK_MS = 50;             // 20Hz 配信

const CHARACTERS = {
  seven:  { name: 'セブン',   color: 0xc0c6ff, cooldown: 8000 },
  luna:   { name: 'ルナ',     color: 0x5ec8ff, cooldown: 9000 },
  crow:   { name: 'クロウ',   color: 0x8a5cff, cooldown: 10000 },
  verna:  { name: 'ヴェルナ', color: 0xa64dff, cooldown: 10000 },
  rave:   { name: 'レイヴ',   color: 0xff4d5e, cooldown: 9000 },
  mint:   { name: 'ミント',   color: 0x4dff88, cooldown: 12000 },
  azuria: { name: 'アズリア', color: 0xff7ad9, cooldown: 12000 },
  selefi: { name: 'セレフィ', color: 0xbfefff, cooldown: 10000 },
};

// ---------------- 静的ファイル配信 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------- ゲーム状態 ----------------
let nextId = 1;
let nextOrbId = 1;
const players = new Map(); // id -> player
let orbs = [];
let traps = [];
let phase = 'waiting'; // waiting | playing | ended
let timeLeft = GAME_DURATION;
let endedAt = 0;
let missionSpawned = false;
let lastTick = Date.now();

function randPos(margin = 3) {
  return {
    x: (Math.random() * 2 - 1) * (ARENA - margin),
    z: (Math.random() * 2 - 1) * (ARENA - margin),
  };
}
function spawnOrb(kind = 'normal') {
  const p = kind === 'mission' ? { x: 0, z: 0 } : randPos();
  return { id: nextOrbId++, x: p.x, z: p.z, kind, value: kind === 'mission' ? 5 : 1 };
}
function resetGame() {
  orbs = Array.from({ length: ORB_COUNT }, () => spawnOrb());
  traps = [];
  timeLeft = GAME_DURATION;
  missionSpawned = false;
  for (const pl of players.values()) { pl.score = 0; }
  phase = players.size > 0 ? 'playing' : 'waiting';
}
resetGame();
phase = 'waiting';

function clampArena(v) { return Math.max(-ARENA, Math.min(ARENA, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

function publicPlayer(pl) {
  const now = Date.now();
  return {
    id: pl.id, name: pl.name, charId: pl.charId,
    x: +pl.x.toFixed(2), z: +pl.z.toFixed(2), angle: +pl.angle.toFixed(2),
    score: pl.score,
    cooldownLeft: Math.max(0, pl.cooldownUntil - now),
    boosted: pl.boostUntil > now,
    shielded: pl.shieldUntil > now,
    slowed: pl.slowUntil > now,
  };
}
function snapshot() {
  return {
    type: 'state', phase, timeLeft: Math.ceil(timeLeft),
    players: [...players.values()].map(publicPlayer),
    orbs, traps: traps.map(t => ({ x: t.x, z: t.z, ownerId: t.ownerId })),
  };
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const pl of players.values()) {
    if (pl.ws.readyState === 1) pl.ws.send(msg);
  }
}

// ---------------- スキル (サーバーで検証・適用) ----------------
function useSkill(pl, angle) {
  const now = Date.now();
  const def = CHARACTERS[pl.charId];
  if (!def || phase !== 'playing') return;
  if (now < pl.cooldownUntil) return; // クールダウン中は無効
  pl.cooldownUntil = now + def.cooldown;
  if (typeof angle === 'number' && Number.isFinite(angle)) pl.angle = angle;
  const fx = Math.sin(pl.angle), fz = Math.cos(pl.angle);

  switch (pl.charId) {
    case 'seven': // ポータルワープ: 前方6
      pl.x = clampArena(pl.x + fx * 6);
      pl.z = clampArena(pl.z + fz * 6);
      checkOrbPickup(pl);
      break;
    case 'luna': // 高速移動 5秒
      pl.boostUntil = now + 5000;
      break;
    case 'crow': { // ロックオン: 10以内で一番近いオーブを回収
      let best = null, bd = 10;
      for (const o of orbs) { const d = dist(pl, o); if (d < bd) { bd = d; best = o; } }
      if (best) collectOrb(pl, best);
      break;
    }
    case 'verna': // クリスタル罠: 10秒残るスローゾーン
      traps.push({ x: pl.x, z: pl.z, ownerId: pl.id, until: now + 10000 });
      break;
    case 'rave': // 爆発ノックバック: 半径5の他者を吹き飛ばす (シールド無効)
      for (const other of players.values()) {
        if (other.id === pl.id || other.shieldUntil > now) continue;
        const d = dist(pl, other);
        if (d < 5 && d > 0.01) {
          other.x = clampArena(other.x + ((other.x - pl.x) / d) * 4);
          other.z = clampArena(other.z + ((other.z - pl.z) / d) * 4);
        }
      }
      break;
    case 'mint': // 回復: 自分と半径6の味方のスローを解除+3秒シールド
      for (const p of players.values()) {
        if (dist(pl, p) < 6) { p.slowUntil = 0; p.shieldUntil = now + 3000; }
      }
      break;
    case 'azuria': // バフ: 全員3秒ブースト (自分含む)
      for (const p of players.values()) p.boostUntil = Math.max(p.boostUntil, now + 3000);
      break;
    case 'selefi': // 氷シールド5秒 + 半径4の他者を1.5秒スロー
      pl.shieldUntil = now + 5000;
      for (const other of players.values()) {
        if (other.id !== pl.id && dist(pl, other) < 4 && other.shieldUntil <= now) {
          other.slowUntil = now + 1500;
        }
      }
      break;
  }
}

function collectOrb(pl, orb) {
  orbs = orbs.filter(o => o.id !== orb.id);
  pl.score += orb.value;
  if (orb.kind !== 'mission') orbs.push(spawnOrb());
  broadcast({ type: 'event', text: `${pl.name} が${orb.kind === 'mission' ? 'ミッション' : ''}クリスタルをゲット！ (+${orb.value})` });
}
function checkOrbPickup(pl) {
  for (const o of [...orbs]) {
    if (dist(pl, o) < 1.3) collectOrb(pl, o);
  }
}

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const id = nextId++;
  let joined = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join' && !joined) {
      if (players.size >= 4) { ws.send(JSON.stringify({ type: 'error', text: '満員です (最大4人)' })); return; }
      const charId = CHARACTERS[msg.charId] ? msg.charId : 'seven';
      const spawn = randPos(8);
      const pl = {
        id, ws, charId,
        name: String(msg.name || CHARACTERS[charId].name).slice(0, 12),
        x: spawn.x, z: spawn.z, angle: 0, score: 0,
        cooldownUntil: 0, boostUntil: 0, shieldUntil: 0, slowUntil: 0,
      };
      players.set(id, pl);
      joined = true;
      ws.send(JSON.stringify({ type: 'welcome', id, snapshot: snapshot() }));
      broadcast({ type: 'event', text: `${pl.name} (${CHARACTERS[charId].name}) が参加しました` });
      if (phase === 'waiting') { phase = 'playing'; if (timeLeft <= 0) resetGame(); }
      return;
    }

    const pl = players.get(id);
    if (!pl) return;

    if (msg.type === 'move') {
      const nx = Number(msg.x), nz = Number(msg.z);
      if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
      // チート対策: 1メッセージでの移動量を制限 (通常移動 ~15Hz * 8unit/s ≒ 0.55)
      const step = Math.hypot(nx - pl.x, nz - pl.z);
      if (step > 1.4) return;
      pl.x = clampArena(nx); pl.z = clampArena(nz);
      if (Number.isFinite(Number(msg.angle))) pl.angle = Number(msg.angle);
      // 罠チェック
      const now = Date.now();
      for (const t of traps) {
        if (t.ownerId !== pl.id && pl.shieldUntil <= now && dist(pl, t) < 2) pl.slowUntil = now + 600;
      }
      if (phase === 'playing') checkOrbPickup(pl);
    } else if (msg.type === 'skill') {
      useSkill(pl, Number(msg.angle));
    }
  });

  ws.on('close', () => {
    const pl = players.get(id);
    if (pl) broadcast({ type: 'event', text: `${pl.name} が退出しました` });
    players.delete(id);
    if (players.size === 0) { phase = 'waiting'; timeLeft = GAME_DURATION; }
  });
});

// ---------------- ゲームループ ----------------
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  traps = traps.filter(t => t.until > now);

  if (phase === 'playing' && players.size > 0) {
    timeLeft -= dt;
    // 中盤ミッション: 残り90秒を切ったら中央に5点クリスタル
    if (!missionSpawned && timeLeft <= 90) {
      missionSpawned = true;
      orbs.push(spawnOrb('mission'));
      broadcast({ type: 'event', text: 'ミッション！ 中央の金クリスタルは5点！' });
    }
    if (timeLeft <= 0) {
      phase = 'ended'; endedAt = now; timeLeft = 0;
      const ranking = [...players.values()].sort((a, b) => b.score - a.score);
      broadcast({ type: 'event', text: `終了！ 勝者は ${ranking[0] ? ranking[0].name : '―'} (${ranking[0] ? ranking[0].score : 0}点)` });
    }
  } else if (phase === 'ended' && now - endedAt > 8000) {
    resetGame();
  }
  if (players.size > 0) broadcast(snapshot());
}, TICK_MS);

httpServer.listen(PORT, HOST, () => {
  console.log(`altare-three-game listening on http://${HOST}:${PORT}`);
});
