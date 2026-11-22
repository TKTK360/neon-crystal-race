import * as THREE from 'three';

// ============================================================
// ネオンクリスタルレース — 1人用 GitHub Pages版
// 通信は一切なし。全てブラウザ内で完結する (プレイヤー1人 + CPU 3人)
// ============================================================

// ============ キャラ定義 (マルチプレイ版と同一) ============
const CHARACTERS = {
  seven:  { name: 'セブン',   color: '#c0c6ff', skill: 'ポータルワープ (前方へ瞬間移動)', portrait: 'assets/portraits/seven.png', cooldown: 8000 },
  luna:   { name: 'ルナ',     color: '#5ec8ff', skill: '高速移動 (5秒スピードアップ)', portrait: 'assets/portraits/luna.png', cooldown: 9000 },
  crow:   { name: 'クロウ',   color: '#8a5cff', skill: 'ロックオン (近くのクリスタルを回収)', portrait: 'assets/portraits/crow.png', cooldown: 10000 },
  verna:  { name: 'ヴェルナ', color: '#a64dff', skill: 'クリスタル罠 (敵をスローにする罠)', portrait: 'assets/portraits/verna.png', cooldown: 10000 },
  rave:   { name: 'レイヴ',   color: '#ff4d5e', skill: '爆発 (周りの敵を吹き飛ばす)', portrait: 'assets/portraits/rave.png', cooldown: 9000 },
  mint:   { name: 'ミント',   color: '#4dff88', skill: '回復 (スロー解除＋シールド)', portrait: 'assets/portraits/mint.png', cooldown: 12000 },
  azuria: { name: 'アズリア', color: '#ff7ad9', skill: 'バフ (全員スピードアップ)', portrait: 'assets/portraits/azuria.png', cooldown: 12000 },
  selefi: { name: 'セレフィ', color: '#bfefff', skill: '氷シールド (守り＋周りをスロー)', portrait: 'assets/portraits/selefi.png', cooldown: 10000 },
};
const ARENA = 21;              // プレイエリアは -ARENA..ARENA
const GAME_DURATION = 90;      // 1分30秒
const ORB_COUNT = 12;

// ============ キャラ選択画面 ============
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

// ============ ゲーム状態 (ローカル) ============
let racers = [];        // {id,name,charId,isBot,x,z,angle,score,cooldownUntil,boostUntil,shieldUntil,slowUntil,...}
let orbs = [];          // {id,x,z,kind,value}
let traps = [];         // {x,z,ownerId,until}
let phase = 'idle';     // idle | playing | ended
let timeLeft = GAME_DURATION;
let missionSpawned = false;
let nextOrbId = 1;
let state = null;       // 描画用スナップショット (毎フレーム再構築)
const MY_ID = 'player';
const keys = {};
let stamina = 100;

function clampArena(v) { return Math.max(-ARENA, Math.min(ARENA, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function randPos(margin = 3) {
  return { x: (Math.random() * 2 - 1) * (ARENA - margin), z: (Math.random() * 2 - 1) * (ARENA - margin) };
}
function spawnOrb(kind = 'normal') {
  const p = kind === 'mission' ? { x: 0, z: 0 } : randPos();
  return { id: nextOrbId++, x: p.x, z: p.z, kind, value: kind === 'mission' ? 5 : 1 };
}
function me() { return racers.find(r => r.id === MY_ID); }

function makeRacer(id, name, charId, isBot) {
  const s = randPos(8);
  return {
    id, name, charId, isBot,
    x: s.x, z: s.z, angle: 0, score: 0,
    cooldownUntil: 0, boostUntil: 0, shieldUntil: 0, slowUntil: 0,
    baseSpeed: isBot ? 6.1 + Math.random() * 0.9 : 7,   // CPUは少しだけ遅め
    wanderSeed: Math.random() * 1000,
    nextSkillAt: performance.now() + 5000 + Math.random() * 8000,
  };
}

function setupRace(playerName, playerChar) {
  racers = [makeRacer(MY_ID, playerName, playerChar, false)];
  // 残りキャラから3人をシャッフルしてCPUに割り当て
  const rest = Object.keys(CHARACTERS).filter(c => c !== playerChar);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  rest.slice(0, 3).forEach((charId, i) => {
    racers.push(makeRacer('bot' + (i + 1), CHARACTERS[charId].name + '・CPU', charId, true));
  });
  resetRace();
}

function resetRace() {
  orbs = Array.from({ length: ORB_COUNT }, () => spawnOrb());
  traps = [];
  timeLeft = GAME_DURATION;
  missionSpawned = false;
  stamina = 100;
  for (const r of racers) {
    const s = randPos(8);
    r.x = s.x; r.z = s.z; r.angle = 0; r.score = 0;
    r.cooldownUntil = 0; r.boostUntil = 0; r.shieldUntil = 0; r.slowUntil = 0;
    r.nextSkillAt = performance.now() + 5000 + Math.random() * 8000;
  }
  clearAvatars();
  phase = 'playing';
  document.getElementById('resultPanel').classList.add('hidden');
  document.getElementById('centerMsg').classList.add('hidden');
  buildState();
  showEvent('レース開始！ クリスタルを集めよう');
}

document.getElementById('joinBtn').onclick = () => {
  const name = document.getElementById('nameInput').value.trim() || CHARACTERS[selectedChar].name;
  document.getElementById('joinScreen').classList.add('hidden');
  document.getElementById('gameScreen').classList.remove('hidden');
  document.getElementById('skillName').textContent = CHARACTERS[selectedChar].skill;
  // 左上のプレイヤーパネルに選択キャラを表示
  const pc = CHARACTERS[selectedChar];
  document.getElementById('ppPortrait').src = pc.portrait;
  const ppChar = document.getElementById('ppChar');
  ppChar.textContent = pc.name;
  ppChar.style.color = pc.color;
  document.getElementById('ppName').textContent = name;
  document.getElementById('playerPanel').style.borderColor = pc.color;
  initThree();
  setupRace(name, selectedChar);
};
document.getElementById('restartBtn').onclick = () => resetRace();
document.getElementById('backBtn').onclick = () => location.reload();
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; if (e.key === ' ') e.preventDefault(); });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

// ============ タッチ操作 (仮想ジョイスティック + ボタン) ============
// キーボードと同じ入力経路に流す: 移動は touchVec、ダッシュは keys['shift']、スキルは useSkill()
// スティックはフローティング式: 画面左側のどこを触っても、その場所にスティックが出てドラッグで移動する
const touchVec = { x: 0, z: 0, active: false };

// タッチ端末判定: 初期チェックに加え「実際にタッチされたら有効化」するフォールバックを用意する
// (pointer: coarse が効かない端末・ブラウザでも、最初のタッチで必ず UI が出るように)
function enableTouchUI() { document.body.classList.add('touch'); }
if (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) enableTouchUI();
window.addEventListener('touchstart', enableTouchUI, { once: true, passive: true });
window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') enableTouchUI(); }, { once: true });

const joyEl = document.getElementById('joystick');
const joyKnob = document.getElementById('joystickKnob');
const joyZone = document.getElementById('joyZone');
const btnDash = document.getElementById('btnDash');
const btnSkill = document.getElementById('btnSkill');
const JOY_RADIUS = 42;   // ノブの最大移動量 (px)
const JOY_DEADZONE = 0.12;
let joyId = null;        // 操作中のポインタ/タッチの ID (スティック専用に追跡)
let joyCx = 0, joyCy = 0; // スティック中心 (ビューポート座標)

function setKnob(ox, oy) {
  joyKnob.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
}
// スティックの土台を触れた場所へ移動する (画面端ではみ出さないようクランプ)
function joyPlace(cx, cy) {
  const r = (joyEl.offsetWidth || 136) / 2;
  const x = Math.max(r + 4, Math.min(window.innerWidth - r - 4, cx));
  const y = Math.max(r + 4, Math.min(window.innerHeight - r - 4, cy));
  joyEl.style.left = (x - r) + 'px';
  joyEl.style.top = (y - r) + 'px';
  joyEl.style.right = 'auto';
  joyEl.style.bottom = 'auto';
  joyCx = x; joyCy = y;
}
function joyHome() {
  joyEl.style.left = ''; joyEl.style.top = ''; joyEl.style.right = ''; joyEl.style.bottom = '';
}
function joyStart(id, x, y) {
  if (joyId !== null || phase !== 'playing') return false;
  joyId = id;
  joyPlace(x, y);
  joyEl.classList.add('active');
  joyMove(id, x, y);
  return true;
}
function joyMove(id, x, y) {
  if (id !== joyId) return;
  let ox = x - joyCx, oy = y - joyCy;
  const len = Math.hypot(ox, oy);
  if (len > JOY_RADIUS) { ox = ox / len * JOY_RADIUS; oy = oy / len * JOY_RADIUS; }
  setKnob(ox, oy);
  // 軸対応は WASD と同一: 上へ倒す = 画面奥 (-z) = W
  let vx = ox / JOY_RADIUS, vz = oy / JOY_RADIUS;
  if (Math.hypot(vx, vz) < JOY_DEADZONE) { vx = 0; vz = 0; }
  touchVec.x = vx; touchVec.z = vz; touchVec.active = true;
}
function joyEnd(id) {
  if (id !== joyId) return;
  joyId = null;
  touchVec.x = 0; touchVec.z = 0; touchVec.active = false;
  setKnob(0, 0);
  joyEl.classList.remove('active');
  joyHome();
}

// ---- ダッシュボタン: 押している間だけ Shift と同じ扱い ----
let dashId = null;
function dashStart(id) {
  if (dashId !== null) return false;
  dashId = id;
  keys['shift'] = true;
  btnDash.classList.add('active');
  return true;
}
function dashEnd(id) {
  if (id !== dashId) return;
  dashId = null;
  keys['shift'] = false;
  btnDash.classList.remove('active');
}
function skillTap() {
  const p = me();
  if (p && phase === 'playing' && !useSkill(p)) flashCd();   // クールダウン中なら控えめに知らせる
}

// 入力イベントは Pointer Events を基本にし、無い環境では Touch Events にフォールバックする。
// move/up は window でも受ける (capture が効かなくても指を離せば必ず止まるように)
if (window.PointerEvent) {
  const onDown = el => e => {
    if (e.pointerType === 'mouse') return;
    enableTouchUI();
    if (el === btnDash) { if (dashStart(e.pointerId)) e.preventDefault(); return; }
    if (el === btnSkill) { btnSkill.classList.add('active'); skillTap(); e.preventDefault(); return; }
    if (joyStart(e.pointerId, e.clientX, e.clientY)) {
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* capture 失敗時も window 側で追跡する */ }
      e.preventDefault();
    }
  };
  joyZone.addEventListener('pointerdown', onDown(joyZone));
  joyEl.addEventListener('pointerdown', onDown(joyEl));
  btnDash.addEventListener('pointerdown', onDown(btnDash));
  btnSkill.addEventListener('pointerdown', onDown(btnSkill));
  window.addEventListener('pointermove', e => joyMove(e.pointerId, e.clientX, e.clientY), { passive: true });
  window.addEventListener('pointerup', e => { joyEnd(e.pointerId); dashEnd(e.pointerId); btnSkill.classList.remove('active'); });
  window.addEventListener('pointercancel', e => { joyEnd(e.pointerId); dashEnd(e.pointerId); btnSkill.classList.remove('active'); });
} else {
  const tStart = el => e => {
    enableTouchUI();
    for (const t of e.changedTouches) {
      if (el === btnDash) { if (dashStart(t.identifier)) e.preventDefault(); }
      else if (el === btnSkill) { btnSkill.classList.add('active'); skillTap(); e.preventDefault(); }
      else if (joyStart(t.identifier, t.clientX, t.clientY)) e.preventDefault();
    }
  };
  const tMove = e => { for (const t of e.changedTouches) joyMove(t.identifier, t.clientX, t.clientY); };
  const tEnd = e => {
    for (const t of e.changedTouches) { joyEnd(t.identifier); dashEnd(t.identifier); }
    btnSkill.classList.remove('active');
  };
  for (const el of [joyZone, joyEl]) {
    el.addEventListener('touchstart', tStart(el), { passive: false });
    el.addEventListener('touchmove', tMove, { passive: false });
    el.addEventListener('touchend', tEnd);
    el.addEventListener('touchcancel', tEnd);
  }
  btnDash.addEventListener('touchstart', tStart(btnDash), { passive: false });
  btnDash.addEventListener('touchend', tEnd);
  btnDash.addEventListener('touchcancel', tEnd);
  btnSkill.addEventListener('touchstart', tStart(btnSkill), { passive: false });
  btnSkill.addEventListener('touchend', tEnd);
  btnSkill.addEventListener('touchcancel', tEnd);
  window.addEventListener('touchmove', tMove, { passive: true });
  window.addEventListener('touchend', tEnd);
  window.addEventListener('touchcancel', tEnd);
}
// プレイ中の画面スクロール/引っ張り更新を止める (touch-action: none の保険)
document.getElementById('gameScreen').addEventListener('touchmove', e => { if (phase === 'playing') e.preventDefault(); }, { passive: false });
// 長押しやドラッグでの誤作動・メニュー表示を防ぐ
document.getElementById('touchControls').addEventListener('contextmenu', e => e.preventDefault());

function showEvent(text) {
  const log = document.getElementById('eventLog');
  if (!log) return;
  const div = document.createElement('div');
  div.textContent = text;
  log.prepend(div);
  while (log.children.length > 4) log.lastChild.remove();
  setTimeout(() => div.remove(), 5000);
}

// ============ トースト (スキル発動・金クリスタルの告知) ============
// タイマーの下に最大3件まで重ねて表示し、約1.8秒で自動消滅する。タッチは透過する
const toastsEl = document.getElementById('toasts');
function pushToast(el) {
  while (toastsEl.children.length >= 3) toastsEl.firstChild.remove();
  toastsEl.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 1800);
}
// スキルの短い名前はキャラ定義の説明文から切り出す (例: 'ポータルワープ (前方へ瞬間移動)' → 'ポータルワープ')
function skillLabel(charId) { return CHARACTERS[charId].skill.split(' (')[0]; }
function showSkillToast(pl) {
  const def = CHARACTERS[pl.charId];
  const el = document.createElement('div');
  el.className = 'toast' + (pl.id === MY_ID ? ' mine' : '');
  el.style.borderColor = def.color;
  el.innerHTML = `<img src="${def.portrait}" alt=""><span><b style="color:${def.color}">${def.name}</b>『${skillLabel(pl.charId)}』発動！</span>`;
  pushToast(el);
}
function showGoldToast(html, charId = null) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = '#ffd94d';
  const icon = charId ? `<img src="${CHARACTERS[charId].portrait}" alt="">` : '<span class="goldIcon">◆</span>';
  el.innerHTML = `${icon}<span>${html}</span>`;
  pushToast(el);
}
// クールダウン中のスキル試行への控えめなフィードバック (自分のスキル表示のみ)
let cdFlashTimer = null;
function flashCd() {
  const box = document.getElementById('skillBox');
  box.classList.remove('cd-flash');
  void box.offsetWidth;
  box.classList.add('cd-flash');
  clearTimeout(cdFlashTimer);
  cdFlashTimer = setTimeout(() => box.classList.remove('cd-flash'), 360);
}

// ============ オーブ取得 / スキル (サーバー版のロジックをローカル化) ============
function collectOrb(r, orb) {
  orbs = orbs.filter(o => o.id !== orb.id);
  r.score += orb.value;
  if (orb.kind === 'mission') {
    // 金クリスタル取得はトーストで告知 (通常クリスタルは従来どおりイベントログ)
    showGoldToast(`<b style="color:${CHARACTERS[r.charId].color}">${CHARACTERS[r.charId].name}</b> が金クリスタルをゲット！ (+${orb.value})`, r.charId);
  } else {
    orbs.push(spawnOrb());
    showEvent(`${r.name} がクリスタルをゲット！ (+${orb.value})`);
  }
}
function checkOrbPickup(r) {
  for (const o of [...orbs]) if (dist(r, o) < 1.3) collectOrb(r, o);
}

function useSkill(pl) {
  const now = Date.now();
  const def = CHARACTERS[pl.charId];
  if (!def || phase !== 'playing' || now < pl.cooldownUntil) return false;
  pl.cooldownUntil = now + def.cooldown;
  showSkillToast(pl);   // 発動成功した時だけトースト (クールダウン中は出さない)
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
    case 'crow': { // ロックオン: 半径10で一番近いオーブを回収
      let best = null, bd = 10;
      for (const o of orbs) { const d = dist(pl, o); if (d < bd) { bd = d; best = o; } }
      if (best) collectOrb(pl, best);
      break;
    }
    case 'verna': // クリスタル罠: 10秒残るスローゾーン
      traps.push({ x: pl.x, z: pl.z, ownerId: pl.id, until: now + 10000 });
      break;
    case 'rave': // 爆発ノックバック: 半径5の他者を吹き飛ばす (シールド無効)
      for (const other of racers) {
        if (other.id === pl.id || other.shieldUntil > now) continue;
        const d = dist(pl, other);
        if (d < 5 && d > 0.01) {
          other.x = clampArena(other.x + ((other.x - pl.x) / d) * 4);
          other.z = clampArena(other.z + ((other.z - pl.z) / d) * 4);
        }
      }
      break;
    case 'mint': // 回復: 自分と半径6の全員のスロー解除＋3秒シールド
      for (const p of racers) {
        if (dist(pl, p) < 6) { p.slowUntil = 0; p.shieldUntil = now + 3000; }
      }
      break;
    case 'azuria': // バフ: 全員3秒ブースト (自分含む)
      for (const p of racers) p.boostUntil = Math.max(p.boostUntil, now + 3000);
      break;
    case 'selefi': // 氷シールド5秒 + 半径4の他者を1.5秒スロー
      pl.shieldUntil = now + 5000;
      for (const other of racers) {
        if (other.id !== pl.id && dist(pl, other) < 4 && other.shieldUntil <= now) {
          other.slowUntil = now + 1500;
        }
      }
      break;
  }
  return true;
}

// ============ 移動 ============
function speedOf(r, now) {
  let s = r.baseSpeed;
  if (r.boostUntil > now) s = 11;
  if (r.slowUntil > now) s = 3.5;
  return s;
}

function updatePlayer(dt, now) {
  const p = me();
  if (!p) return;
  let dx = 0, dz = 0;
  if (keys['w'] || keys['arrowup']) dz -= 1;
  if (keys['s'] || keys['arrowdown']) dz += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  // 仮想ジョイスティックが倒れていればそちらを優先 (アナログ量つき)
  if (touchVec.active && (touchVec.x !== 0 || touchVec.z !== 0)) { dx = touchVec.x; dz = touchVec.z; }
  const moving = dx !== 0 || dz !== 0;
  const dash = keys['shift'] && stamina > 0 && moving;
  stamina = THREE.MathUtils.clamp(stamina + (dash ? -38 * dt : 22 * dt), 0, 100);

  let speed = speedOf(p, now);
  if (dash) speed *= 1.6;
  if (moving) {
    const len = Math.hypot(dx, dz);
    const mag = Math.min(1, len);   // キーボードは常に1、ジョイスティックは倒し具合
    dx /= len; dz /= len;
    p.x = clampArena(p.x + dx * speed * mag * dt);
    p.z = clampArena(p.z + dz * speed * mag * dt);
    p.angle = Math.atan2(dx, dz);
  }
  const skillKey = keys[' '] || keys['e'];
  if (skillKey && !updatePlayer._skillKeyDown && now < p.cooldownUntil) flashCd();
  updatePlayer._skillKeyDown = !!skillKey;
  if (skillKey) useSkill(p);
}

// ============ CPUボット ============
function updateBot(b, dt, now, t) {
  // 目標: 金クリスタル優先、なければ一番近いオーブ
  let target = null, bd = Infinity;
  for (const o of orbs) {
    const d = dist(b, o);
    if (o.kind === 'mission') { target = o; break; }
    if (d < bd) { bd = d; target = o; }
  }
  if (target) {
    let dx = target.x - b.x, dz = target.z - b.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    // 少しだけ蛇行させて機械っぽさを消す
    const wob = Math.sin(t * 1.7 + b.wanderSeed) * 0.25;
    const rx = dx * Math.cos(wob) - dz * Math.sin(wob);
    const rz = dx * Math.sin(wob) + dz * Math.cos(wob);
    const speed = speedOf(b, now);
    b.x = clampArena(b.x + rx * speed * dt);
    b.z = clampArena(b.z + rz * speed * dt);
    b.angle = Math.atan2(rx, rz);
  }
  // たまにスキルを使う (簡易版: 条件が合うときだけ)
  if (now >= b.nextSkillAt && Date.now() >= b.cooldownUntil) {
    b.nextSkillAt = performance.now() + 6000 + Math.random() * 9000;
    let want = true;
    if (b.charId === 'crow') want = orbs.some(o => dist(b, o) < 10);
    if (b.charId === 'rave') want = racers.some(r => r.id !== b.id && dist(b, r) < 5);
    if (b.charId === 'selefi') want = racers.some(r => r.id !== b.id && dist(b, r) < 4);
    if (want) useSkill(b);
  }
}

// ============ ゲーム進行 ============
function updateGame(dt) {
  if (phase !== 'playing') return;
  const now = Date.now();
  timeLeft -= dt;
  if (!missionSpawned && timeLeft <= 45) {
    missionSpawned = true;
    orbs.push(spawnOrb('mission'));
    showGoldToast('ミッション！ 中央に<b>金クリスタル</b>出現（5点）');
  }
  // 罠の期限切れ & 効果
  traps = traps.filter(tr => tr.until > now);
  for (const r of racers) {
    for (const tr of traps) {
      if (tr.ownerId !== r.id && r.shieldUntil <= now && dist(r, tr) < 2) r.slowUntil = now + 600;
    }
  }
  updatePlayer(dt, now);
  const t = clock ? clock.elapsedTime : 0;
  for (const r of racers) if (r.isBot) updateBot(r, dt, now, t);
  for (const r of racers) checkOrbPickup(r);

  if (timeLeft <= 0) {
    timeLeft = 0;
    phase = 'ended';
    showResults();
  }
  buildState();
}

function showResults() {
  const sorted = [...racers].sort((a, b) => b.score - a.score);
  const win = sorted[0];
  const cm = document.getElementById('centerMsg');
  cm.textContent = win ? `👑 Quest Complete!\n勝者: ${win.name} (${win.score}点)` : '';
  cm.classList.remove('hidden');
  const medals = ['🥇', '🥈', '🥉', '4位'];
  document.getElementById('resultTitle').textContent = '🏆 最終結果';
  document.getElementById('resultList').innerHTML = sorted.map((r, i) =>
    `<div class="${r.id === MY_ID ? 'me' : ''}" style="color:${CHARACTERS[r.charId].color}">${medals[i]} ${CHARACTERS[r.charId].name} / ${r.name}: ${r.score}点</div>`).join('');
  document.getElementById('resultPanel').classList.remove('hidden');
  showEvent(`終了！ 勝者は ${win ? win.name : '―'} (${win ? win.score : 0}点)`);
}

// 描画用スナップショット (マルチプレイ版の state と同じ形)
function buildState() {
  const now = Date.now();
  state = {
    phase, timeLeft: Math.ceil(timeLeft),
    players: racers.map(r => ({
      id: r.id, name: r.name, charId: r.charId,
      x: r.x, z: r.z, angle: r.angle, score: r.score,
      cooldownLeft: Math.max(0, r.cooldownUntil - now),
      boosted: r.boostUntil > now,
      shielded: r.shieldUntil > now,
      slowed: r.slowUntil > now,
    })),
    orbs, traps,
  };
}

// ============ three.js ============
let scene, camera, renderer, clock;
const avatars = new Map(); // id -> {group, target:Vector3, ring}
const orbMeshes = new Map();
let trapMeshes = [];

function clearAvatars() {
  if (!scene) return;
  for (const [, av] of avatars) scene.remove(av.group);
  avatars.clear();
}

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

// 表示領域に合わせてレンダラとカメラをリサイズする
// (スマホのアドレスバー伸縮・画面回転でも追従するよう複数イベントで呼ぶ)
function resizeRenderer() {
  if (!renderer || !camera) return;
  const el = document.getElementById('gameScreen');
  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || window.innerHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
}

function initThree() {
  if (renderer) return;
  const canvas = document.getElementById('gameCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07031a);
  scene.fog = new THREE.Fog(0x07031a, 30, 80);
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  resizeRenderer();
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

  window.addEventListener('resize', resizeRenderer);
  window.addEventListener('orientationchange', () => setTimeout(resizeRenderer, 120));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeRenderer);
  animate();
}

// ============ 描画同期 ============
function syncWorld(dt, t) {
  if (!state) return;
  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    if (!avatars.has(p.id)) avatars.set(p.id, makeAvatar(p));
    const av = avatars.get(p.id);
    if (p.id === MY_ID) {
      av.group.position.set(p.x, 0, p.z);
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
  const mine = avatars.get(MY_ID);
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
  document.getElementById('timer').textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  document.getElementById('scores').innerHTML =
    '🏆 スコア<br>' + sorted.map(p =>
      `<div class="${p.id === MY_ID ? 'me' : ''}" style="color:${CHARACTERS[p.charId].color}">${CHARACTERS[p.charId].name} / ${p.name}: ${p.score}点</div>`).join('');
  const mp = state.players.find(p => p.id === MY_ID);
  if (mp) {
    const cd = document.getElementById('skillCd');
    cd.textContent = mp.cooldownLeft > 0 ? `あと ${(mp.cooldownLeft / 1000).toFixed(1)}秒` : (document.body.classList.contains('touch') ? '準備OK' : '準備OK (Space)');
    const cdMax = CHARACTERS[mp.charId].cooldown;
    document.getElementById('barMp').style.width = `${mp.cooldownLeft > 0 ? 100 * (1 - mp.cooldownLeft / cdMax) : 100}%`;
    document.getElementById('barEn').style.width = `${stamina}%`;
    document.getElementById('barHp').style.width = mp.shielded ? '100%' : '82%';
  }
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
    g.beginPath(); g.arc(px(p.x), px(p.z), p.id === MY_ID ? 6 : 4, 0, 7); g.fill();
    if (p.id === MY_ID) { g.strokeStyle = '#fff'; g.stroke(); }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  updateGame(dt);
  syncWorld(dt, t);
  updateHUD();
  renderer.render(scene, camera);
}
