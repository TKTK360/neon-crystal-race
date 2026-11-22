import * as THREE from 'three';

// ============ キャラ定義 (server.js と対応) ============
const CHARACTERS = {
  seven:  { name: 'セブン',   color: '#c0c6ff', skill: 'ポータルワープ (前方へ瞬間移動)', portrait: 'assets/portraits/seven.png' },
  luna:   { name: 'ルナ',     color: '#5ec8ff', skill: '高速移動 (5秒スピードアップ)', portrait: 'assets/portraits/luna.png' },
  crow:   { name: 'クロウ',   color: '#8a5cff', skill: 'ロックオン (近くのクリスタルを回収)', portrait: 'assets/portraits/crow.png' },
  verna:  { name: 'ヴェルナ', color: '#a64dff', skill: 'クリスタル罠 (敵をスローにする罠)', portrait: 'assets/portraits/verna.png' },
  rave:   { name: 'レイヴ',   color: '#ff4d5e', skill: '爆発 (周りの敵を吹き飛ばす)', portrait: 'assets/portraits/rave.png' },
  mint:   { name: 'ミント',   color: '#4dff88', skill: '回復 (スロー解除＋シールド)', portrait: 'assets/portraits/mint.png' },
  azuria: { name: 'アズリア', color: '#ff7ad9', skill: 'バフ (全員スピードアップ)', portrait: 'assets/portraits/azuria.png' },
  selefi: { name: 'セレフィ', color: '#bfefff', skill: '氷シールド (守り＋周りをスロー)', portrait: 'assets/portraits/selefi.png' },
};
const ARENA = 21;

// ============ 参加画面 ============
let selectedChar = 'seven';
const charGrid = document.getElementById('charGrid');
for (const [id, c] of Object.entries(CHARACTERS)) {
  const card = document.createElement('div');
  card.className = 'charCard' + (id === selectedChar ? ' selected' : '');
  card.innerHTML = `<img src="${c.portrait}" alt="${c.name}"><div class="cname" style="color:${c.color}">${c.name}</div><div class="cskill">${c.skill}</div>`;
  card.onclick = () => {
    selectedChar = id;
    document.querySelectorAll('.charCard').forEach(el => el.classList.remove('selected'));
    card.classList.add('selected');
  };
  charGrid.appendChild(card);
}

// ============ 状態 ============
let ws = null, myId = null, myChar = null;
let state = null; // 最新のサーバースナップショット
const keys = {};
let stamina = 100;

document.getElementById('joinBtn').onclick = () => {
  const name = document.getElementById('nameInput').value.trim() || CHARACTERS[selectedChar].name;
  connect(name, selectedChar);
};
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; if (e.key === ' ') e.preventDefault(); });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

function connect(name, charId) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name, charId }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') {
      myId = msg.id; myChar = charId; state = msg.snapshot;
      document.getElementById('joinScreen').classList.add('hidden');
      document.getElementById('gameScreen').classList.remove('hidden');
      document.getElementById('skillName').textContent = CHARACTERS[charId].skill;
      initThree();
    } else if (msg.type === 'state') {
      state = msg;
    } else if (msg.type === 'event') {
      showEvent(msg.text);
    } else if (msg.type === 'error') {
      document.getElementById('joinError').textContent = msg.text;
    }
  };
  ws.onclose = () => showEvent('サーバーから切断されました');
}

function showEvent(text) {
  const log = document.getElementById('eventLog');
  const div = document.createElement('div');
  div.textContent = text;
  log.prepend(div);
  while (log.children.length > 4) log.lastChild.remove();
  setTimeout(() => div.remove(), 5000);
}

// ============ three.js ============
let scene, camera, renderer, clock;
const avatars = new Map(); // id -> {group, target:Vector3, ring, label}
const orbMeshes = new Map();
let trapMeshes = [];
let localPos = null, localAngle = 0, lastSend = 0, skillSentAt = 0;

function makeNameplate(text, color) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.font = 'bold 30px sans-serif'; g.textAlign = 'center';
  g.fillStyle = 'rgba(10,4,32,0.7)'; g.fillRect(28, 8, 200, 44);
  g.fillStyle = color; g.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set(2.4, 0.6, 1); sp.position.y = 2.15;
  return sp;
}

function makeAvatar(p) {
  const c = new THREE.Color(CHARACTERS[p.charId].color);
  const group = new THREE.Group();
  // 体 (カプセル)
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.42, 0.7, 6, 14),
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, emissive: c, emissiveIntensity: 0.25 })
  );
  body.position.y = 0.95; group.add(body);
  // 頭
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.36, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xffe9dd, roughness: 0.6 })
  );
  head.position.y = 1.85; group.add(head);
  // 猫耳 (コーン) + ヘッドホンのバンド
  const earMat = new THREE.MeshStandardMaterial({ color: 0x18102e, emissive: 0xff4da6, emissiveIntensity: 0.5 });
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.32, 8), earMat);
    ear.position.set(0.22 * s, 2.18, 0); ear.rotation.z = -0.25 * s; group.add(ear);
    const cup = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), earMat);
    cup.position.set(0.38 * s, 1.85, 0); group.add(cup);
  }
  // 足元の光るリング / ポータル
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.05, 8, 32),
    new THREE.MeshBasicMaterial({ color: c })
  );
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.06; group.add(ring);
  group.add(makeNameplate(p.name, CHARACTERS[p.charId].color));
  scene.add(group);
  return { group, ring, target: new THREE.Vector3(p.x, 0, p.z) };
}

function initThree() {
  if (renderer) return;
  const canvas = document.getElementById('gameCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07031a);
  scene.fog = new THREE.Fog(0x07031a, 30, 80);
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
  clock = new THREE.Clock();

  scene.add(new THREE.AmbientLight(0x8877ff, 0.7));
  const moon = new THREE.DirectionalLight(0xbfa8ff, 1.2); moon.position.set(10, 24, 8); scene.add(moon);
  const pink = new THREE.PointLight(0xff4da6, 60, 60); pink.position.set(0, 8, 0); scene.add(pink);

  // 地面 + グリッド
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA * 2 + 4, ARENA * 2 + 4),
    new THREE.MeshStandardMaterial({ color: 0x0d0630, roughness: 0.9 })
  );
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const grid = new THREE.GridHelper(ARENA * 2 + 4, 22, 0xa64dff, 0x2a1a66);
  grid.position.y = 0.02; scene.add(grid);
  // 外周の壁 (光る枠)
  const wallMat = new THREE.MeshBasicMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0.35 });
  for (const [x, z, w, d] of [[0, -ARENA - 1, ARENA * 2 + 4, 0.3], [0, ARENA + 1, ARENA * 2 + 4, 0.3], [-ARENA - 1, 0, 0.3, ARENA * 2 + 4], [ARENA + 1, 0, 0.3, ARENA * 2 + 4]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1.6, d), wallMat);
    wall.position.set(x, 0.8, z); scene.add(wall);
  }
  // ネオン都市のビル群 (アリーナ外)
  const winColors = [0xff7ad9, 0x5ec8ff, 0xa64dff, 0xffd94d];
  for (let i = 0; i < 70; i++) {
    const h = 3 + Math.random() * 11;
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, h, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x120a33, emissive: winColors[i % 4], emissiveIntensity: 0.12 + Math.random() * 0.25, roughness: 0.8 })
    );
    const ang = Math.random() * Math.PI * 2, r = 30 + Math.random() * 22;
    b.position.set(Math.cos(ang) * r, h / 2, Math.sin(ang) * r);
    scene.add(b);
  }

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  animate();
}

// ============ 移動 & 同期 ============
function updateLocal(dt) {
  if (!state) return;
  const me = state.players.find(p => p.id === myId);
  if (!me) return;
  if (!localPos) localPos = new THREE.Vector3(me.x, 0, me.z);

  let dx = 0, dz = 0;
  if (keys['w'] || keys['arrowup']) dz -= 1;
  if (keys['s'] || keys['arrowdown']) dz += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  const moving = dx !== 0 || dz !== 0;
  const dash = (keys['shift']) && stamina > 0 && moving;
  stamina = THREE.MathUtils.clamp(stamina + (dash ? -38 * dt : 22 * dt), 0, 100);

  let speed = 7;
  if (me.boosted) speed = 11;
  if (me.slowed) speed = 3.5;
  if (dash) speed *= 1.6;

  if (moving) {
    const len = Math.hypot(dx, dz); dx /= len; dz /= len;
    localPos.x = THREE.MathUtils.clamp(localPos.x + dx * speed * dt, -ARENA, ARENA);
    localPos.z = THREE.MathUtils.clamp(localPos.z + dz * speed * dt, -ARENA, ARENA);
    localAngle = Math.atan2(dx, dz);
  }
  // スキル
  if ((keys[' '] || keys['e']) && Date.now() - skillSentAt > 300) {
    skillSentAt = Date.now();
    ws.send(JSON.stringify({ type: 'skill', angle: localAngle }));
  }
  // 位置送信 (~30Hz)
  const now = performance.now();
  if (now - lastSend > 33) {
    lastSend = now;
    ws.send(JSON.stringify({ type: 'move', x: localPos.x, z: localPos.z, angle: localAngle }));
  }
  // サーバー補正 (ワープ/ノックバック等で大きくずれたら合わせる)
  if (Math.hypot(me.x - localPos.x, me.z - localPos.z) > 2.5) {
    localPos.set(me.x, 0, me.z);
  }
}

function syncWorld(dt, t) {
  if (!state) return;
  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    if (!avatars.has(p.id)) avatars.set(p.id, makeAvatar(p));
    const av = avatars.get(p.id);
    if (p.id === myId && localPos) {
      av.group.position.copy(localPos);
    } else {
      av.target.set(p.x, 0, p.z);
      av.group.position.lerp(av.target, 1 - Math.pow(0.0001, dt)); // 補間
    }
    av.group.rotation.y = p.angle;
    av.ring.rotation.z = t * 2;
    const s = p.shielded ? 1.18 : 1;
    av.group.scale.setScalar(s);
  }
  for (const [id, av] of avatars) {
    if (!seen.has(id)) { scene.remove(av.group); avatars.delete(id); }
  }
  // カメラは自分を追従 (少し上・後ろ)
  const mine = avatars.get(myId);
  if (mine) {
    const tp = mine.group.position;
    camera.position.lerp(new THREE.Vector3(tp.x, 15, tp.z + 13), 0.08);
    camera.lookAt(tp.x, 0, tp.z - 2);
  }
  // オーブ
  const seenOrb = new Set();
  for (const o of state.orbs) {
    seenOrb.add(o.id);
    if (!orbMeshes.has(o.id)) {
      const isM = o.kind === 'mission';
      const m = new THREE.Mesh(
        new THREE.IcosahedronGeometry(isM ? 0.65 : 0.42, 0),
        new THREE.MeshStandardMaterial({ color: isM ? 0xffd94d : 0x5ec8ff, emissive: isM ? 0xffd94d : 0x5ec8ff, emissiveIntensity: 1.6, roughness: 0.2 })
      );
      scene.add(m); orbMeshes.set(o.id, m);
    }
    const m = orbMeshes.get(o.id);
    m.position.set(o.x, 0.9 + Math.sin(t * 3 + o.id) * 0.18, o.z);
    m.rotation.y = t * 2 + o.id;
  }
  for (const [id, m] of orbMeshes) if (!seenOrb.has(id)) { scene.remove(m); orbMeshes.delete(id); }
  // 罠
  for (const m of trapMeshes) scene.remove(m);
  trapMeshes = state.traps.map(tr => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.08, 24),
      new THREE.MeshBasicMaterial({ color: 0xa64dff, transparent: true, opacity: 0.4 }));
    m.position.set(tr.x, 0.05, tr.z); scene.add(m); return m;
  });
}

// ============ HUD ============
function updateHUD() {
  if (!state) return;
  const t = Math.max(0, state.timeLeft);
  document.getElementById('timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  document.getElementById('scores').innerHTML =
    '🏆 スコア<br>' + sorted.map(p =>
      `<div class="${p.id === myId ? 'me' : ''}" style="color:${CHARACTERS[p.charId].color}">${CHARACTERS[p.charId].name} / ${p.name}: ${p.score}点</div>`).join('');
  const me = state.players.find(p => p.id === myId);
  if (me) {
    const cd = document.getElementById('skillCd');
    cd.textContent = me.cooldownLeft > 0 ? `あと ${(me.cooldownLeft / 1000).toFixed(1)}秒` : '準備OK (Space)';
    document.getElementById('barMp').style.width = `${me.cooldownLeft > 0 ? 100 - (me.cooldownLeft / 120) : 100}%`;
    document.getElementById('barEn').style.width = `${stamina}%`;
    document.getElementById('barHp').style.width = me.shielded ? '100%' : '82%';
  }
  const cm = document.getElementById('centerMsg');
  if (state.phase === 'ended') {
    const win = sorted[0];
    cm.textContent = win ? `👑 Quest Complete!\n勝者: ${win.name} (${win.score}点)` : '';
    cm.classList.remove('hidden');
  } else cm.classList.add('hidden');
  drawMinimap();
}
function drawMinimap() {
  const cv = document.getElementById('minimap'), g = cv.getContext('2d');
  const S = cv.width, W2 = ARENA * 2;
  g.fillStyle = '#0a0620'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#a64dff'; g.strokeRect(4, 4, S - 8, S - 8);
  const px = (x) => ((x + ARENA) / W2) * (S - 12) + 6;
  g.fillStyle = '#5ec8ff';
  for (const o of state.orbs) { g.beginPath(); g.arc(px(o.x), px(o.z), o.kind === 'mission' ? 5 : 3, 0, 7); g.fill(); }
  for (const p of state.players) {
    g.fillStyle = CHARACTERS[p.charId].color;
    g.beginPath(); g.arc(px(p.x), px(p.z), p.id === myId ? 6 : 4, 0, 7); g.fill();
    if (p.id === myId) { g.strokeStyle = '#fff'; g.stroke(); }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  updateLocal(dt);
  syncWorld(dt, t);
  updateHUD();
  renderer.render(scene, camera);
}
