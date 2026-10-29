/*
 * 把一局真实回放逐帧喂给引擎，做「悔棋分析」：同样的局面，引擎当时会走哪一步？
 *
 *   node scripts/regret.js Fk12pNja_          # 我方 = 玩家 0
 *   node scripts/regret.js <id> 1             # 我方 = 玩家 1
 *
 * 回放里每条走子都是服务器**收到并处理过**的过，所以它就是逐 tick 的真值日志。
 * 这里用 replay.js 的模拟器还原每一 tick 的真实局面，按服务器口径做迷雾裁剪，
 * 塞进真正的 state.js + bot.js，拿到引擎在该局的决策，然后跟真人/真机下的手对账。
 *
 * 能回答的问题：
 *   - 引擎当时想走的那步，在真值下合法吗（源格还有兵吗）？
 *   - 它有多少手是「往自己已经占着的格子推」——兵在自家来回搬？
 *   - 多少兵一直堆在后方不动（集兵/用兵的问题）？
 */
'use strict';

const { load, simulate, MOUNTAIN } = require('./replay.js');

global.window = global;
require('../src/state.js');
require('../src/bot.js');
const GB = global.window.__GB;
const T = GB.TILE;

const FOG = T.FOG;
const FOG_OBSTACLE = T.FOG_OBSTACLE;

/* 3x3 视野：自己每一格领地周围一圈都看得见 */
function visibleSet(snap, pid) {
  const n = snap.n;
  const w = snap.w;
  const h = snap.h;
  const vis = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (snap.terrain[i] !== pid) continue;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        vis[ny * w + nx] = 1;
      }
    }
  }
  return vis;
}

/* 按服务器口径串行化：[w, h, armies(0..n), terrain(0..n)]，迷雾格抹成 FOG(-3/-4) + 兵 0 */
function serialize(snap, pid, vis) {
  const n = snap.n;
  const armies = new Array(n);
  const terrain = new Array(n);
  const generals = [];
  for (let p = 0; p < snap.generals.length; p++) generals.push(-1);
  for (let i = 0; i < n; i++) {
    if (vis[i]) {
      armies[i] = snap.armies[i];
      terrain[i] = snap.terrain[i];
    } else {
      armies[i] = 0;
      terrain[i] = snap.terrain[i] === MOUNTAIN ? FOG_OBSTACLE : FOG;
    }
  }
  for (let p = 0; p < snap.generals.length; p++) {
    const g = snap.gen[p];
    if (g >= 0 && vis[g] && snap.terrain[g] === p) generals[p] = g;
  }
  return { map: [snap.w, snap.h].concat(armies, terrain), generals };
}

function fmt(i, w) {
  return '(' + (i % w) + ',' + Math.floor(i / w) + ')';
}

async function main() {
  const idOrPath = process.argv[2];
  const pid = process.argv[3] !== undefined ? Number(process.argv[3]) : 0;
  if (!idOrPath) {
    console.error('用法: node scripts/regret.js <回放ID 或 .gior 文件> [我方玩家下标]');
    process.exit(2);
  }
  const R = await load(idOrPath);
  const w = R.w;

  const S = new GB.GameState();
  S.applyStart({
    playerIndex: pid,
    usernames: R.usernames,
    generals: R.generals.slice(),
    cities: []
  });

  const seenCities = new Set();
  let ticks = 0;
  let planned = 0;
  let matched = 0; // 引擎的决策和真实那一手一致
  let planDead = 0; // 引擎想走的源格在真值下兵不够
  let realDead = 0; // 真实那一手在真值下就是空过
  let realIntoOwn = 0;
  let planIntoOwn = 0;
  let realMoves = 0;
  const streaks = [];
  let curStreak = { key: '', n: 0 };
  const samples = [];
  const armySnap = [];

  const cfg = { maxMoves: 1 };

  simulate(R, (t, snap) => {
    if (snap.terrain[snap.generals[pid]] !== pid && snap.gen[pid] < 0) return;
    ticks++;
    const vis = visibleSet(snap, pid);
    const ser = serialize(snap, pid, vis);
    for (const c of R.cities) if (vis[c]) seenCities.add(c);
    S.applyUpdate({
      turn: t,
      playerIndex: pid,
      map: ser.map,
      generals: ser.generals,
      cities: Array.from(seenCities)
    });
    if (!S.ready) return;

    let plan = [];
    try {
      plan = GB.bot.plan(S, cfg) || [];
    } catch (e) {
      console.error('plan 抛异常 t=' + t + ': ' + ((e && e.message) || e));
      return;
    }
    const pv = plan[0];
    if (pv) {
      planned++;
      // 真值校验：源格在这一 tick 前属于我们、且兵 >= 2
      if (!(snap.terrain[pv[0]] === pid && snap.armies[pv[0]] >= 2)) planDead++;
      if (snap.terrain[pv[1]] === pid) planIntoOwn++;
    }

    const real = snap.movesThisTurn.find((m) => m.player === pid);
    if (real) {
      realMoves++;
      const avail = snap.terrain[real.start] === pid ? snap.armies[real.start] : 0;
      const sent = real.is50 ? avail >> 1 : avail - 1;
      if (sent < 1) realDead++;
      if (snap.terrain[real.end] === pid) realIntoOwn++;
      if (pv && pv[0] === real.start && pv[1] === real.end) matched++;
      const key = real.start + '>' + real.end;
      if (key === curStreak.key) curStreak.n++;
      else {
        if (curStreak.n) streaks.push(curStreak);
        curStreak = { key, n: 1, t };
      }
      if (samples.length < 40 && pv && (pv[0] !== real.start || pv[1] !== real.end)) {
        samples.push({
          t,
          real: fmt(real.start, w) + '→' + fmt(real.end, w),
          plan: fmt(pv[0], w) + '→' + fmt(pv[1], w),
          avail: snap.armies[real.start],
          pop: snap.armies[pv[0]]
        });
      }
    }

    if (t % 50 === 0) {
      let total = 0;
      let atGen = 0;
      let nearEnemy = 0;
      let own = 0;
      for (let i = 0; i < snap.n; i++) {
        if (snap.terrain[i] !== pid) continue;
        own++;
        total += snap.armies[i];
        if (i === snap.gen[pid]) atGen += snap.armies[i];
      }
      const denemy = new Int32Array(snap.n).fill(-1);
      const q = [];
      for (let i = 0; i < snap.n; i++) {
        if (snap.terrain[i] >= 0 && snap.terrain[i] !== pid) {
          denemy[i] = 0;
          q.push(i);
        }
      }
      for (let h = 0; h < q.length; h++) {
        const cur = q[h];
        if (denemy[cur] >= 4) continue;
        const x = cur % w;
        const y = (cur / w) | 0;
        const nb = [];
        if (y > 0) nb.push(cur - w);
        if (y < snap.h - 1) nb.push(cur + w);
        if (x > 0) nb.push(cur - 1);
        if (x < w - 1) nb.push(cur + 1);
        for (const j of nb) {
          if (denemy[j] !== -1) continue;
          if (snap.terrain[j] === MOUNTAIN) continue;
          denemy[j] = denemy[cur] + 1;
          q.push(j);
        }
      }
      for (let i = 0; i < snap.n; i++) {
        if (snap.terrain[i] !== pid) continue;
        if (denemy[i] >= 0 && denemy[i] <= 3) nearEnemy += snap.armies[i];
      }
      armySnap.push({ t, own, total, atGen, nearEnemy, rear: total - nearEnemy });
    }
  });
  if (curStreak.n) streaks.push(curStreak);

  const pct = (a, b) => ((a / (b || 1)) * 100).toFixed(1) + '%';
  console.log('回放 ' + R.id + '  我方=玩家' + pid + '(' + R.usernames[pid] + ')  ' + R.w + 'x' + R.h);
  console.log('喂帧 ' + ticks + ' tick，引擎出决策 ' + planned + ' 次');
  console.log('');
  console.log('跟真实操作对账（' + realMoves + ' 手真实走子）：');
  console.log('  完全一致              ' + matched + ' 手 = ' + pct(matched, realMoves));
  console.log('  真实那手是空过        ' + realDead + ' 手 = ' + pct(realDead, realMoves));
  console.log('  引擎这步在真值下空过  ' + planDead + ' 手 = ' + pct(planDead, planned) + '   ← 状态漂移/账不对就会涨');
  console.log('  真实那手推进自家格    ' + realIntoOwn + ' 手 = ' + pct(realIntoOwn, realMoves));
  console.log('  引擎这步推进自家格    ' + planIntoOwn + ' 手 = ' + pct(planIntoOwn, planned) + '   ← 兵在自家来回搬');

  streaks.sort((a, b) => b.n - a.n);
  if (streaks.length) {
    console.log('\n最长「同一手反复下」：');
    for (const s of streaks.slice(0, 5)) {
      const p = s.key.split('>');
      console.log('  ' + fmt(Number(p[0]), w) + '→' + fmt(Number(p[1]), w) + '  连续 ' + s.n + ' 次（从 t=' + s.t + '）');
    }
  }

  if (samples.length) {
    console.log('\n决策差异样本（t / 真实 / 引擎 / 真实源格兵 / 引擎源格兵）：');
    for (const s of samples) {
      console.log('  t=' + String(s.t).padStart(4) + '  真实 ' + s.real.padEnd(16) + ' 引擎 ' + s.plan.padEnd(16) + ' 兵 ' + String(s.avail).padStart(3) + ' / ' + String(s.pop).padStart(3));
    }
  }

  console.log('\n兵力分布（t：地 / 总兵 / 将军身上 / 贴着敌人 / 后方搁着）：');
  for (const a of armySnap) {
    console.log(
      '  t=' + String(a.t).padStart(5) + '  地 ' + String(a.own).padStart(3) + '  兵 ' + String(a.total).padStart(4) +
        '  将军 ' + String(a.atGen).padStart(4) + '  前线 ' + String(a.nearEnemy).padStart(4) + '  后方 ' + String(a.rear).padStart(4)
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
