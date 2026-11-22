'use strict';
/** 2クライアントで参加・移動・オーブ取得を検証する簡易テスト */
const WebSocket = require('ws');
const URL = process.env.TEST_URL || 'ws://127.0.0.1:3000';

function makeClient(name, charId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { ws, name, id: null, state: null, events: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, charId })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'welcome') { c.id = m.id; c.state = m.snapshot; resolve(c); }
      else if (m.type === 'state') c.state = m;
      else if (m.type === 'event') c.events.push(m.text);
    });
    ws.on('error', reject);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const a = await makeClient('テスト1', 'seven');
  const b = await makeClient('テスト2', 'luna');
  console.log('join OK:', a.id, b.id);
  await sleep(300);

  if (!a.state || a.state.players.length !== 2) throw new Error(`Aから見た人数が2でない: ${a.state && a.state.players.length}`);
  if (!b.state || b.state.players.length !== 2) throw new Error('Bから見た人数が2でない');
  console.log('state broadcast OK: 両クライアントに2人見える, phase =', a.state.phase, ', orbs =', a.state.orbs.length);

  // A: 一番近いオーブへ少しずつ移動 (サーバーの移動量制限 1.4 以内)
  const me = () => a.state.players.find(p => p.id === a.id);
  let steps = 0;
  while (me().score === 0 && steps < 200) {
    const target = a.state.orbs[0];
    const cur = me();
    const dx = target.x - cur.x, dz = target.z - cur.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) break;
    const step = Math.min(1.0, d);
    a.ws.send(JSON.stringify({ type: 'move', x: cur.x + (dx / d) * step, z: cur.z + (dz / d) * step, angle: Math.atan2(dx, dz) }));
    steps++;
    await sleep(30);
  }
  await sleep(300);
  console.log(`move/orb: ${steps}ステップ移動, Aのスコア = ${me().score}, イベント =`, a.events.slice(-2));
  if (me().score <= 0) throw new Error('オーブを取得できなかった (スコアが増えていない)');

  // B: スキル発動 (ルナ=ブースト) → 状態に boosted が立つか
  b.ws.send(JSON.stringify({ type: 'skill', angle: 0 }));
  await sleep(250);
  const bMe = b.state.players.find(p => p.id === b.id);
  console.log('skill: B boosted =', bMe.boosted, ', cooldownLeft =', bMe.cooldownLeft);
  if (!bMe.boosted) throw new Error('ルナのスキル (ブースト) が反映されていない');

  console.log('ALL TESTS PASSED');
  a.ws.close(); b.ws.close();
  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
