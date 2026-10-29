/*
 * 逐回合体检：把一局回放里我们**每一个 turn** 的走子摊开看，标出「没意思的那几手」。
 *
 *   node scripts/turns.js <回放ID> [我方玩家下标]
 *   node scripts/turns.js N7Npym_VP 0 --all      # 连有意义的也打出来
 *
 * 判定标准（都在真值上算，不是引擎自己的状态）：
 *   占地   目标是没人的格子 —— 永远有意义（+1 格产能）
 *   打     目标是敌格 —— 有意义（除非过杀：打完之后剩的兵比目标守军还多一倍）
 *   清剿   目标是敌格、且这一格已经被我方地围住 —— 有意义，但过杀就是浪费
 *   自搬   目标是自家格 —— 只有两种情况下有意义：
 *            a) 往前：搬到「离敌格更近」的格子（兵在往战线走）
 *            b) 并堆：搬过去之后那一格比源格厚（在攒拳头）
 *          剩下的就是「没意思」：原地平移、往后退、把大堆拆成小堆。
 *
 * 面板/引擎的 reasons 给的是「引擎为什么这么下」，这里给的是「这一手到底换来了什么」。
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

function serialize(snap, pid, vis) {
  const n = snap.n;
  const armies = new Array(n);
  const terrain = new Array(n);
  const generals = [];
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
    generals.push(g >= 0 && vis[g] && snap.terrain[g] === p ? g : -1);
  }
  return { map: [snap.w, snap.h].concat(armies, terrain), generals };
}

function nb4(i, w, h) {
  const x = i % w;
  const y = (i / w) | 0;
  const out = [];
  if (y > 0) out.push(i - w);
  if (y < h - 1) out.push(i + w);
  if (x > 0) out.push(i - 1);
  if (x < w - 1) out.push(i + 1);
  return out;
}

/* 到最近敌格的步数（穿可通行格），-1 = 视野里没有敌人 */
function enemyField(snap, pid) {
  const n = snap.n;
  const w = snap.w;
  const h = snap.h;
  const d = new Int32Array(n).fill(-1);
  const q = [];
  for (let i = 0; i < n; i++) {
    if (snap.terrain[i] >= 0 && snap.terrain[i] !== pid) {
      d[i] = 0;
      q.push(i);
    }
  }
  for (let k = 0; k < q.length; k++) {
    const cur = q[k];
    for (const j of nb4(cur, w, h)) {
      if (d[j] !== -1 || snap.terrain[j] === MOUNTAIN) continue;
      d[j] = d[cur] + 1;
      q.push(j);
    }
  }
  return d;
}

async function main() {
  const idOrPath = process.argv[2];
  const pid = process.argv[3] !== undefined && !process.argv[3].startsWith('--') ? Number(process.argv[3]) : 0;
  const showAll = process.argv.includes('--all');
  const real = process.argv.includes('--real');
  // 单变量对照：GB_CFG='{"noBackstep":false}' node scripts/turns.js <id> 1
  const cfgExtra = process.env.GB_CFG ? JSON.parse(process.env.GB_CFG) : {};
  if (!idOrPath) {
    console.error('用法: node scripts/turns.js <回放ID 或 .gior> [我方下标] [--all]');
    process.exit(2);
  }
  const R = await load(idOrPath);
  const w = R.w;
  const h = R.h;

  const S = new GB.GameState();
  S.applyStart({ playerIndex: pid, usernames: R.usernames, generals: R.generals.slice(), cities: [] });
  const seenCities = new Set();
  const lines = [];
  const cat = {};
  let total = 0;

  simulate(R, (t, snap) => {
    if (snap.gen[pid] < 0) return;
    if (snap.terrain[snap.generals[pid]] !== pid) return;
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

    const denemy = enemyField(snap, pid);
    let plan = [];
    try {
      plan = GB.bot.plan(S, Object.assign({ maxMoves: 1 }, cfgExtra)) || [];
    } catch (e) {
      lines.push({ t, text: 'plan 抛异常 ' + ((e && e.message) || e) });
      return;
    }

    let ownLand = 0;
    let ownArmy = 0;
    for (let i = 0; i < snap.n; i++) {
      if (snap.terrain[i] === pid) {
        ownLand++;
        ownArmy += snap.armies[i];
      }
    }

    /*
     * --real：分析**真实下的那一手**（回放里记录的手），而不是引擎的反事实决策。
     *
     * 反事实模式有天然缺陷：模拟器是按回放里的真实手推进局面的，引擎自己的打算
     * 不会落到盘上，跑几十手之后引擎的状态和真值就分叉了——它以为某个格子攒了
     * 20 兵，其实那里只有 1 兵。所以「引擎这一手有没有意义」只能在真值上评判真实
     * 走子；要看引擎的决策质量，用擂台（arena）或者以后的自对弈模式。
     */
    const realMove = real ? snap.movesThisTurn.find((m) => m.player === pid) : null;
    if (real) {
      if (!realMove) {
        total++;
        cat['空过'] = (cat['空过'] || 0) + 1;
        lines.push({ t, text: '空过（这一手什么都没下）', kind: '空过', waste: true, dbg: GB.dbg, land: ownLand, army: ownArmy });
        return;
      }
      plan = [[realMove.start, realMove.end, realMove.is50 ? 1 : 0]];
    } else if (!plan.length) {
      total++;
      cat['空过'] = (cat['空过'] || 0) + 1;
      lines.push({ t, text: '空过（这一手什么都没下）', kind: '空过', waste: true, dbg: GB.dbg, land: ownLand, army: ownArmy });
      return;
    }

    const [from, to] = plan[0];
    const why = real ? 'real' : ((GB.lastReasons && GB.lastReasons[0]) || '?').split(':')[0];
    const aSrc = snap.terrain[from] === pid ? snap.armies[from] : 0;
    const sent = aSrc - 1;
    const dstOwn = snap.terrain[to] === pid;
    const dstArmy = snap.armies[to];
    const toPassable = snap.terrain[to] !== MOUNTAIN;

    let kind;
    let waste = false;
    let note = '';
    if (!toPassable) {
      kind = '撞山';
      waste = true;
      note = '目标是山（引擎以为能走）';
    } else if (!dstOwn) {
      const atk = snap.terrain[to] >= 0;
      if (atk) {
        // 敌格：打穿之后手里还剩多少
        const left = sent - dstArmy;
        let surrounded = true;
        for (const j of nb4(to, w, h)) if (snap.terrain[j] !== pid) surrounded = false;
        kind = surrounded ? '清剿' : '打';
        if (left > dstArmy * 2 + 4) {
          // 一大堆兵砸一小块敌地：兵是往前挪了，不算浪费，只是记一笔
          note = '强打：送 ' + sent + ' 打 ' + dstArmy + '，剩 ' + left;
        } else if (left < 1) {
          kind = '打崩';
          waste = true;
          note = '打不穿：送 ' + sent + ' 打 ' + dstArmy;
        }
      } else {
        kind = '占地';
      }
    } else {
      kind = '自搬';
      const dFrom = denemy[from];
      const dTo = denemy[to];
      const merged = dstArmy + sent;
      const forward = dFrom >= 0 && (dTo < 0 || dTo < dFrom);
      const grow = merged > aSrc;
      if (forward) {
        kind = '自搬·前送';
      } else if (grow && dstArmy >= 2) {
        kind = '自搬·并堆';
      } else {
        waste = true;
        kind = '自搬·白搬';
        note =
          '源 ' + aSrc + ' 兵 → 目标原有 ' + dstArmy + '，' +
          (dFrom >= 0 ? '离敌 ' + dFrom + '→' + (dTo < 0 ? '∞' : dTo) : '视野无敌格');
      }
      if (aSrc <= 3 && !forward) {
        waste = true;
        note = (note ? note + '；' : '') + '小堆搬：源只有 ' + aSrc + ' 兵';
      }
    }

    total++;
    cat[kind] = (cat[kind] || 0) + 1;
    if (waste) cat['__waste'] = (cat['__waste'] || 0) + 1;

    lines.push({
      t,
      kind,
      waste,
      from,
      to,
      text:
        fmt(from) + '→' + fmt(to) +
        ' 源' + String(aSrc).padStart(3) + '→留1' +
        ' 目标' + (dstOwn ? '我' : snap.terrain[to] < 0 ? '空' : '敌') + String(dstArmy).padStart(3) +
        ' 离敌 ' + (denemy[from] < 0 ? '∞' : denemy[from]) + '→' + (denemy[to] < 0 ? '∞' : denemy[to]) +
        ' [' + why + ']' +
        (note ? '   ← ' + note : ''),
      dbg: GB.dbg,
      land: ownLand,
      army: ownArmy
    });
  });

  function fmt(i) {
    return '(' + (i % w) + ',' + Math.floor(i / w) + ')';
  }

  console.log('回放 ' + R.id + '  我方=玩家' + pid + '(' + R.usernames[pid] + ')  ' + w + 'x' + h);
  console.log('共 ' + total + ' 手\n');
  const rate = (k) => ((cat[k] || 0) / (total || 1)) * 100;
  const order = ['占地', '打', '清剿', '自搬·前送', '自搬·并堆', '自搬·白搬', '打崩', '撞山', '空过'];
  console.log('走子构成：');
  for (const k of order) {
    if (!cat[k]) continue;
    console.log('  ' + k.padEnd(10) + String(cat[k]).padStart(5) + ' 手 = ' + rate(k).toFixed(1) + '%');
  }
  console.log('  ' + '没意思'.padEnd(9) + String(cat['__waste'] || 0).padStart(5) + ' 手 = ' + rate('__waste').toFixed(1) + '%\n');

  console.log('逐手（只列没意思的；加 --all 看全部）：');
  for (const l of lines) {
    if (!showAll && !l.waste) continue;
    console.log(
      '  t=' + String(l.t).padStart(4) + '  ' + String(l.kind).padEnd(10) + l.text +
        (l.dbg && showAll ? '  [阶段' + l.dbg.phase + ' 门槛' + l.dbg.genSend + ' 将兵' + l.dbg.genArmy +
          ' 目标' + l.dbg.focus + ' 前锋' + l.dbg.front + ' 后送' + l.dbg.rail + ' 出子' + l.dbg.moves +
          ' 调用' + (l.dbg.calls || []).join(' ') + ']' : '') +
        (l.land !== undefined ? '   地' + l.land + ' 兵' + l.army : '')
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
