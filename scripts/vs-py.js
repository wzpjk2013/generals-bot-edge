/*
 * 移植版（插件里跑的 JS 引擎，src/eklipz/*）对 **原版 Human.exe**（EklipZgit/generals-bot 的
 * 原样 Python 代码）1v1 对弈，结果追加落盘，随时可以再加局。
 *
 * 为什么要这个脚本：`ekjs.js` 打的是我们自己的参考 bot（gc/szly/kutu…），那是 JS 写的替身；
 * `refpy.js` 打的是"Python 打 JS 替身"。这两个都不回答「我们 vs 真正的原版谁强」。
 * 这里两边都是本体：我方是扩展里同一套 `EK.Bot`（同一份源码、同一条代码路径），
 * 对手是真的 Python 原版（子进程 `gb_bridge.py`，它自己的 Map/Bot 全套）。
 *
 * 用法（在仓库根目录跑，就是 `E:\akcoco6de\generals-bot-edge`）：
 *
 *   node scripts/vs-py.js            默认 10 局，追加到 results/vs-py.jsonl
 *   node scripts/vs-py.js 40         再追加 40 局（自动从上次停的地方往后接，不会重跑老局）
 *   node scripts/vs-py.js 20 --fresh 忽略老记录，从 seed 1000 重新开始（会先备份旧文件）
 *   node scripts/vs-py.js --list     只看已有记录的战绩汇总，不跑棋
 *
 * 每局落一行 JSON（seed / 先后手 / 胜负 / 回合 / 地兵城 / 每步耗时 / 双方异常），
 * 汇总写进 `results/vs-py-summary.md`（每次跑完覆盖），控制台同时打一份。
 *
 * 其它开关：
 *   GB_PY_SRC    原版 Python 源码目录，默认 E:\akcoco6de\_research\generals-bot-cs
 *   GB_PY        Python 解释器，默认 python
 *   GB_PY_TIMEOUT 单回合等待上限（毫秒），默认 20000
 *   GB_VSPY_MAX_TURNS 单局回合上限，默认 1200（超了算和）
 *   GB_EK_TRACE=1 打招法轨迹（很吵，调试用）
 *   GB_EK_DET_TICK 设了就按确定性虚拟时钟跑（默认走真实墙钟，和原版同一时间语义）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./arena.js');
const { PyBot, serialize, fullDiff } = require('./refpy.js');
const { EkBot } = require('./ekjs.js');

const W = A.W;
const H = A.H;
const N = A.N;

const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const JSONL = path.join(RESULTS_DIR, 'vs-py.jsonl');
const SUMMARY = path.join(RESULTS_DIR, 'vs-py-summary.md');

const MAX_TURNS = Number(process.env.GB_VSPY_MAX_TURNS || 1200);
const TRACE = Number(process.env.GB_EK_TRACE || 0);
/* 种子步长沿用擂台口径（1000 + i*7919），这样同一个 seed 在不同脚本之间可以对得上。 */
const SEED_BASE = 1000;
const SEED_STEP = 7919;

function scoresFor(board) {
  const out = [];
  for (const p of [0, 1]) {
    let tiles = 0;
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (board.owner[i] !== p) continue;
      tiles++;
      total += board.armies[i];
    }
    out.push({ i: p, total: total, tiles: tiles, dead: board.owner[board.generals[p]] !== p });
  }
  return out;
}

function startDataFor(me) {
  return {
    playerIndex: me,
    usernames: ['moved_js', 'human_exe_py'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'vspy_' + me,
    game_type: 'custom',
    options: {}
  };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 一局：jsSide 是我们（EK.Bot），另一侧是 Python 原版。规则、迷雾、收入与 arena 完全一致。 */
async function playGameVsPy(seed, jsSide) {
  const board = A.makeMap(mulberry32(seed));
  if (!board) return null;
  const pySide = 1 - jsSide;

  const fogs = [A.makeFog(), A.makeFog()];
  for (const p of [0, 1]) A.updateFog(fogs[p], board, p);

  const ek = new EkBot({});
  const py = new PyBot();

  let winner = -1;
  let turns = 0;
  const illegal = [];
  /* 谁怎么死的要记清楚：只报输赢看不出「被打崩」和「将军自己送掉」的区别。 */
  let deathTurn = -1;
  let genArmyAtDeath = -1;
  let lastPyMove = null;
  let lastJsMove = null;

  try {
    /* ---- 开局：正式服务器 game_start 不带地图，第一包 game_update 才有 ---- */
    const vis0 = A.updateFog(fogs[pySide], board, pySide);
    const st0 = serialize(board, pySide, fogs[pySide], vis0);
    await py.start(startDataFor(pySide), {
      turn: 1,
      map_diff: fullDiff(st0.map),
      cities_diff: fullDiff(st0.cities),
      deserts_diff: fullDiff([]),
      generals: st0.generals,
      scores: scoresFor(board),
      stars: [0, 0]
    });

    const ev0 = A.updateFog(fogs[jsSide], board, jsSide);
    const es0 = serialize(board, jsSide, fogs[jsSide], ev0);
    ek.start(startDataFor(jsSide), {
      turn: 1,
      map_diff: fullDiff(es0.map),
      cities_diff: fullDiff(es0.cities),
      deserts_diff: fullDiff([]),
      generals: es0.generals,
      scores: scoresFor(board),
      stars: [0, 0]
    });

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      turns = turn + 1;
      for (const p of [0, 1]) {
        if (board.owner[board.generals[p]] !== p) continue;
        const vis = A.updateFog(fogs[p], board, p);

        if (p === pySide) {
          const st = serialize(board, p, fogs[p], vis);
          const mv = await py.turn({
            turn: turn + 1,
            map_diff: fullDiff(st.map),
            cities_diff: fullDiff(st.cities),
            deserts_diff: fullDiff([]),
            generals: st.generals,
            scores: scoresFor(board),
            stars: [0, 0]
          });
          if (mv) {
            const from = mv[1] * W + mv[0];
            const to = mv[3] * W + mv[2];
            lastPyMove = [from, to, !!mv[4]];
            const ok = A.applyMove(board, p, from, to, !!mv[4]);
            if (TRACE) {
              console.log('T' + turn + ' py ' + mv[0] + ',' + mv[1] + '>' + mv[2] + ',' + mv[3] +
                (mv[4] ? ' half' : '') + (ok ? '' : ' [非法]'));
            }
          } else if (TRACE) {
            console.log('T' + turn + ' py 过');
          }
        } else {
          const st = serialize(board, p, fogs[p], vis);
          const mv = ek.turn({
            turn: turn + 1,
            map_diff: fullDiff(st.map),
            cities_diff: fullDiff(st.cities),
            deserts_diff: fullDiff([]),
            generals: st.generals,
            scores: scoresFor(board),
            stars: [0, 0]
          });
          if (mv) {
            const ok = A.applyMove(board, p, mv[0], mv[1], mv[2]);
            lastJsMove = [mv[0], mv[1], !!mv[2], ok];
            if (!ok) illegal.push([turn, mv[0], mv[1], mv[2]]);
            if (TRACE) {
              console.log('T' + turn + ' js ' + (mv[0] % W) + ',' + Math.floor(mv[0] / W) +
                '>' + (mv[1] % W) + ',' + Math.floor(mv[1] / W) + (mv[2] ? ' half' : '') +
                (ok ? '' : ' [非法]'));
            }
          } else if (TRACE) {
            console.log('T' + turn + ' js 过');
          }
        }

        if (board.owner[board.generals[1 - p]] === p) {
          winner = p;
          /* 死的是 1-p 方的将军。记下死的那一刻：哪一方动的手、将军格还剩多少兵。 */
          deathTurn = turn;
          genArmyAtDeath = board.armies[board.generals[1 - p]];
          break;
        }
      }
      if (winner >= 0) break;

      /* 收入：官方真规则（将军/城每 2 回合 +1，每 50 回合全格 +1）。 */
      const t1 = turn + 1;
      for (let i = 0; i < N; i++) {
        const o = board.owner[i];
        if (o < 0) continue;
        const isProduce = i === board.generals[o] || board.cities[i];
        if (isProduce && t1 % 2 === 0) board.armies[i] += 1;
        if (t1 % 50 === 0) board.armies[i] += 1;
      }
    }
  } finally {
    py.kill();
  }

  return {
    seed: seed,
    jsSide: jsSide,
    result: winner < 0 ? 'draw' : (winner === jsSide ? 'win' : 'loss'),
    turns: turns,
    land: [A.landCount(board, jsSide), A.landCount(board, pySide)],
    army: [A.armyCount(board, jsSide), A.armyCount(board, pySide)],
    cities: [A.cityCount(board, jsSide), A.cityCount(board, pySide)],
    jsStepMs: turns ? Math.round(ek.turnMs / turns) : 0,
    pyStepMs: turns ? Math.round(py.turnMs / turns) : 0,
    jsErr: ek.errors,
    jsErrMsg: ek.firstError || null,
    pyErr: (py.botErrors || 0),
    illegal: illegal.length,
    illegalFirst: illegal[0] || null,
    deathTurn: deathTurn,
    genArmyAtDeath: genArmyAtDeath,
    lastPyMove: lastPyMove,
    lastJsMove: lastJsMove
  };
}

/* ---------- 记录读写：一行一局，追加式；每次启动先读回来算「从哪继续」 ---------- */
function readRecords() {
  if (!fs.existsSync(JSONL)) return [];
  const out = [];
  for (const line of fs.readFileSync(JSONL, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* 半行/坏行跳过 */ }
  }
  return out;
}

function appendRecord(rec) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.appendFileSync(JSONL, JSON.stringify(rec) + '\n', 'utf8');
}

function summarize(records) {
  const n = records.length;
  const wins = records.filter((r) => r.result === 'win').length;
  const draws = records.filter((r) => r.result === 'draw').length;
  const losses = n - wins - draws;
  const avg = (f) => (n ? records.reduce((s, r) => s + f(r), 0) / n : 0);
  const bySide = [0, 1].map((side) => {
    const rs = records.filter((r) => r.jsSide === side);
    const w = rs.filter((r) => r.result === 'win').length;
    const d = rs.filter((r) => r.result === 'draw').length;
    return { side, n: rs.length, w, d, l: rs.length - w - d };
  });
  return {
    n, wins, draws, losses,
    rate: n ? (wins / n) * 100 : 0,
    decidedRate: n - draws ? (wins / (n - draws)) * 100 : 0,
    turns: avg((r) => r.turns),
    land: [avg((r) => r.land[0]), avg((r) => r.land[1])],
    army: [avg((r) => r.army[0]), avg((r) => r.army[1])],
    cities: [avg((r) => r.cities[0]), avg((r) => r.cities[1])],
    jsStepMs: avg((r) => r.jsStepMs),
    pyStepMs: avg((r) => r.pyStepMs),
    jsErr: records.reduce((s, r) => s + (r.jsErr || 0), 0),
    pyErr: records.reduce((s, r) => s + (r.pyErr || 0), 0),
    illegal: records.reduce((s, r) => s + (r.illegal || 0), 0),
    bySide
  };
}

function fmtSummary(s) {
  const L = [];
  const f = (x) => x.toFixed(1);
  L.push('总 ' + s.n + ' 局：' + s.wins + ' 胜 / ' + s.losses + ' 负 / ' + s.draws + ' 和');
  L.push('胜率 ' + f(s.rate) + '%（去掉和棋 ' + f(s.decidedRate) + '%）');
  L.push('先后手：我方先手 ' + s.bySide[0].w + '-' + s.bySide[0].l + '-' + s.bySide[0].d +
    '（' + s.bySide[0].n + ' 局），后手 ' + s.bySide[1].w + '-' + s.bySide[1].l + '-' + s.bySide[1].d +
    '（' + s.bySide[1].n + ' 局）');
  L.push('平均：回合 ' + f(s.turns) + '  地 ' + f(s.land[0]) + ':' + f(s.land[1]) +
    '  兵 ' + f(s.army[0]) + ':' + f(s.army[1]) + '  城 ' + f(s.cities[0]) + ':' + f(s.cities[1]));
  L.push('每步：我们 ' + Math.round(s.jsStepMs) + 'ms  原版 ' + Math.round(s.pyStepMs) + 'ms');
  L.push('异常：我们 ' + s.jsErr + ' 次，原版 ' + s.pyErr + ' 次；我方非法招 ' + s.illegal + ' 条');
  return L;
}

function writeSummary(records, extra) {
  const s = summarize(records);
  const lines = ['# 插件版 vs 原版 Human.exe', ''];
  lines.push('结果文件：`results/vs-py.jsonl`（一行一局，可随时删掉重来）。');
  lines.push('口径：20×20、真迷雾（3×3 视野）、每方每回合 1 步、官方真收入（将军/城每 2 回合 +1，'
    + '每 50 回合全格 +1）、单局上限 ' + MAX_TURNS + ' 回合（超了算和）。');
  lines.push('');
  for (const l of fmtSummary(s)) lines.push('- ' + l);
  if (extra) { lines.push(''); lines.push(extra); }
  lines.push('');
  lines.push('## 逐局');
  lines.push('');
  lines.push('| # | seed | 我方 | 结果 | 回合 | 地 | 兵 | 城 | 我 ms | 原版 ms | 死因 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  records.forEach((r, i) => {
    const why = r.result !== 'loss' ? '—'
      : (r.deathTurn >= 0
        ? 'T' + r.deathTurn + ' 将军格 ' + r.genArmyAtDeath + ' 兵，敌方一手 ' +
          (r.lastPyMove ? r.lastPyMove[0] + '>' + r.lastPyMove[1] : '?')
        : '?');
    lines.push('| ' + (i + 1) + ' | ' + r.seed + ' | ' + (r.jsSide === 0 ? '先手' : '后手') + ' | ' +
      r.result + ' | ' + r.turns + ' | ' + r.land.join(':') + ' | ' + r.army.join(':') + ' | ' +
      r.cities.join(':') + ' | ' + r.jsStepMs + ' | ' + r.pyStepMs + ' | ' + why + ' |');
  });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY, lines.join('\n') + '\n', 'utf8');
  return s;
}

function nextSeedIndex(records) {
  let mx = -1;
  for (const r of records) if (typeof r.seedIndex === 'number' && r.seedIndex > mx) mx = r.seedIndex;
  return mx + 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const fresh = argv.includes('--fresh');
  const countArg = argv.find((a) => /^\d+$/.test(a));
  const games = Number(countArg || 10);

  if (fresh && fs.existsSync(JSONL)) {
    const bak = JSONL + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(JSONL, bak);
    console.log('旧记录已备份到 ' + bak);
  }

  if (listOnly) {
    const recs = readRecords();
    if (!recs.length) { console.log('还没有记录（' + JSONL + ' 不存在或为空）'); return; }
    const s = writeSummary(recs, null);
    console.log(fmtSummary(s).join('\n'));
    console.log('汇总写到 ' + SUMMARY);
    return;
  }

  const records = readRecords();
  let idx = nextSeedIndex(records);
  /* 每局索引 i 对应 seed = 1000 + i*7919、我方先手(i 偶数) / 后手(i 奇数)，
   * 和 ekjs.js / refpy.js 的种子口径一致。*/
  const tasks = [];
  for (let k = 0; k < games; k++, idx++) {
    tasks.push({ seedIndex: idx, seed: SEED_BASE + idx * SEED_STEP, jsSide: idx % 2 });
  }

  const have = records.length;
  console.log((have ? '已有 ' + have + ' 局，' : '还没有记录，') + '本次追加 ' + tasks.length +
    ' 局（seed 从 ' + tasks[0].seed + ' 起，我方' + (tasks[0].jsSide === 0 ? '先手' : '后手') + '开局）');
  console.log('对手：原版 Python（' + (process.env.GB_PY_SRC || 'E:\\akcoco6de\\_research\\generals-bot-cs') + '）');

  const t0 = Date.now();
  let done = 0;
  for (const t of tasks) {
    let rec = null;
    try {
      const r = await playGameVsPy(t.seed, t.jsSide);
      if (!r) { console.log('[skip] seed ' + t.seed + ' 出图失败'); continue; }
      rec = Object.assign({ seedIndex: t.seedIndex, ts: new Date().toISOString() }, r);
      appendRecord(rec);
      records.push(rec);
      done++;
      console.log('[game] seed=' + rec.seed + ' ' + (rec.jsSide === 0 ? '先手' : '后手') + ' ' +
        rec.result + ' turns=' + rec.turns + ' 地' + rec.land.join(':') + ' 兵' + rec.army.join(':') +
        ' js=' + rec.jsStepMs + 'ms py=' + rec.pyStepMs + 'ms' +
        (rec.jsErr ? ' jsErr=' + rec.jsErr : '') + (rec.illegal ? ' illegal=' + rec.illegal : '') +
        (rec.result === 'loss' && rec.deathTurn >= 0
          ? ' 死于T' + rec.deathTurn + '(将军格' + rec.genArmyAtDeath + '兵, 敌方最后一手' +
            (rec.lastPyMove ? rec.lastPyMove[0] + '>' + rec.lastPyMove[1] : '无') + ')'
          : ''));
    } catch (e) {
      console.error('[game] seed ' + t.seed + ' 崩了：' + (e && e.stack ? e.stack : e));
    }
    if (done % 5 === 0 && done > 0) {
      const s = summarize(records);
      console.log('  —— 累计 ' + s.n + ' 局：' + s.wins + '-' + s.losses + '-' + s.draws +
        '，胜率 ' + s.rate.toFixed(1) + '%');
    }
  }

  const s = writeSummary(records, '本次追加 ' + done + ' 局，墙钟 ' +
    ((Date.now() - t0) / 1000).toFixed(0) + 's（' + new Date().toISOString() + '）。');
  console.log('');
  console.log(fmtSummary(s).join('\n'));
  console.log('');
  console.log('结果：' + JSONL);
  console.log('汇总：' + SUMMARY);
}

module.exports = { playGameVsPy, summarize, readRecords };

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
