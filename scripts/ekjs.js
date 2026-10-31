/*
 * 移植版 JS 引擎（src/eklipz 全套）直接上擂台。
 *
 * 为什么单独一个脚本：arena.js 里我方走的是自制引擎 GB.bot.plan(state)，
 * 吃的是 arena 内部的对象；而移植版是原版 Human.exe 的形状 —— 它自己拥有一张
 * EK.Map，吞服务器串行化数据（map_diff / cities_diff / generals / scores），
 * 吐一条 move。所以这里照 refpy.js 的路子（同一套 serialize / fullDiff /
 * 规则 / 迷雾），只把 Python 子进程换成本进程的 EK.Bot。
 *
 * 这样离线验证的代码路径 == 扩展里要跑的代码路径，不再有两份实现。
 *
 *   node scripts/ekjs.js gc 8            对 gc 打 8 局（4 种子 × 先后手）
 *   GB_EK_TRACE=1 node scripts/ekjs.js gc 2
 *   GB_EK_JOBS=4 node scripts/ekjs.js gc 40
 */
'use strict';

const path = require('path');
const A = require('./arena.js');
const { makeRefAgent } = require('./refagents.js');
const { serialize, fullDiff } = require('./refpy.js');

const W = A.W;
const H = A.H;
const N = A.N;
const MAX_TURNS = 1200;

/* 装载顺序 = 依赖顺序：底层的先来。botmain 最后（它 _call 找 EK.* 上的兄弟模块）。 */
const MODULES = [
  'pyrandom',
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'nx',
  'armyanalyzer', 'territory', 'board', 'danger', 'city',
  'armytracker', 'opponenttracker', 'tileisland', 'gather', 'mapspanning', 'watchman',
  'expandutils', 'earlyexpandutils', 'expansionops', 'combatops', 'gatherops',
  'targeting', 'interceptor', 'defense', 'centraldefense', 'eventhandlers', 'pathing', 'repetition', 'statequeries',
  'timings', 'killtiming', 'cityops', 'wincondition', 'comms', 'rendering',
  'explorationops',
  // 迭代流扩张：models 先于求解器，flowgraph 提供有向图与 A/BC，flowmincost 是
  // 原版默认的 OrToolsSimpleMinCost 实现，flowknapsack 供 flowexpansion 装箱
  'flowmodels', 'flowgraph', 'flowmincost', 'flowknapsack', 'flowexpansion',
  'expandhooks', 'botmain'
];

let EK = null;
function loadEK() {
  if (EK) return EK;
  const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
  // GB_EK_SKIP=wincondition,cityops 用来二分"哪个模块引入回归"
  const skip = new Set(
    (process.env.GB_EK_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  for (const m of MODULES) {
    if (skip.has(m)) continue;
    require(path.join(ROOT, m + '.js'));
  }
  // 跳过的模块如果被别处 require 过，__EK 上仍然有实现；这里显式摘掉，
  // 让 botmain 的 _call 记成缺失依赖，等价于"没移植"
  EK = global.__EK;
  for (const m of skip) {
    if (skipToExport[m]) delete EK[skipToExport[m]];
  }
  if (!EK || !EK.Bot) throw new Error('eklipz 模块没挂上（global.__EK 无 Bot）');
  return EK;
}

// 模块名 -> 它在 EK 上挂的导出名，供 GB_EK_SKIP 精确摘除
const skipToExport = {
  timings: 'BotTimings',
  killtiming: 'BotKillTiming',
  cityops: 'BotCityOps',
  wincondition: 'WinConditionAnalyzer',
  explorationops: 'BotExplorationOps',
  defense: 'BotDefense',
  centraldefense: 'BotCentralDefense',
  expandhooks: 'ExpandHooks',
  flowexpansion: 'ArmyFlowExpanderV2'
};

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

function startDataFor(board, me) {
  return {
    playerIndex: me,
    usernames: ['ekjs', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'ekjs_' + me,
    game_type: 'custom',
    options: {}
  };
}

/* 为什么回放器要区分非法招的原因：applyMove 只回 bool，出招被吞掉时看不出是
 * 「兵不够 / 不是自己的格 / 目标不是邻居」哪一类，擂台统计就没法定位。 */
function illegalReason(board, me, mv) {
  const from = mv[0];
  const to = mv[1];
  if (board.owner[from] !== me) return 'notOwned(owner=' + board.owner[from] + ')';
  if (board.armies[from] < 2) return 'army1';
  if (from === to) return 'sameTile';
  if (board.mountains[to]) return 'mountain';
  return 'notAdjacent';
}

function updatePacket(board, turn, st) {
  return {
    turn: turn,
    map_diff: fullDiff(st.map),
    cities_diff: fullDiff(st.cities),
    deserts_diff: fullDiff([]),
    generals: st.generals,
    scores: scoresFor(board),
    stars: [0, 0]
  };
}

/* 一个进程内的 EK.Bot。接口特意和 refpy.js 的 PyBot 对齐（start / turn），
 * 这样两边可以互相当对手、逐回合比招。 */
class EkBot {
  constructor(opts) {
    const ek = loadEK();
    this.map = null;
    this.bot = null;
    this.errors = 0;
    this.lastError = null;
    this.turnMs = 0;
    this.missing = null;
    this.opts = opts || {};
  }

  start(startData, data) {
    const ek = loadEK();
    this.startData = startData;
    // 原版 Map.__init__(start_data, data) 已经把首包吞掉一次；JS 侧构造器同样吞过，
    // 但 oracle 口径要求再补一次（ekdiff/ekdump 一直这么做），否则首回合 delta 差一格。
    this.map = new ek.Map(startData, data, { shuffle: false });
    this.map.apply_server_update(data);
    this.bot = new ek.Bot(startData);
    this.bot.initialize_from_map_for_first_time(this.map);
    ek.Bot.resetMissingReport();
  }

  /* 返回 [fromIdx, toIdx, isHalf] 或 null */
  turn(data) {
    const ek = loadEK();
    const t0 = Date.now();
    this.map.apply_server_update(data);
    this.bot.perf_timer.record_update(this.map.turn, t0);
    let move = null;
    try {
      move = this.bot.find_move();
    } catch (e) {
      // 原版线上 rethrow=False：这回合不出招，别把整局打废
      this.errors++;
      this.lastError = e && e.message ? e.message : String(e);
      // 没有栈就只能看到最后一条消息，分不清是哪一路分支抛的
      if (!this.firstError) {
        this.firstError = this.lastError;
        this.firstStack = (e && e.stack) || '';
      }
      if (process.env.GB_EK_RAISE) { this.lastStack = e && e.stack; throw e; }
      move = null;
    }
    this.turnMs += Date.now() - t0;
    if (process.env.GB_EK_STATE) {
      const b = this.bot;
      const ep = b.expansion_plan;
      console.log('  state: turn=' + this.map.turn +
        ' expPlan=' + (ep ? (ep.selected_option ? 'sel' : 'empty') : 'null') +
        ' incIntercept=' + (ep ? !!ep.includes_intercept : '-') +
        ' curPath=' + (b.curPath ? ('len' + (b.curPath.length || 0)) : 'null') +
        ' timings=' + (b.timings ? 'yes' : 'null') +
        ' defTree=' + (b.defensive_spanning_tree ? b.defensive_spanning_tree.size : '-') +
        ' threat=' + (b.threat ? b.threat.threatType : '-') +
        ' allIn=' + (b._is_all_in ? b._is_all_in() : '-') +
        ' board=' + (b.board_analysis ? 'yes' : 'null'));
    }
    if (move && move.source && move.dest) {
      return [move.source.tile_index, move.dest.tile_index, !!move.move_half];
    }
    return null;
  }
}

/* 一局：移植版 JS vs 参考 bot（ref）。规矩照 arena.js：20×20、真实迷雾、
 * 每方每回合 1 步、收入按官方真规则。 */
function playGameEk(seed, opponent, ekSide, opts) {
  opts = opts || {};
  const rng = mulberry32(seed);
  const board = A.makeMap(rng);
  if (!board) return null;

  const fogs = [A.makeFog(), A.makeFog()];
  for (const p of [0, 1]) A.updateFog(fogs[p], board, p);

  const ek = new EkBot(opts);
  const ref = makeRefAgent(opponent, mulberry32(seed ^ 0x9e3779b9));

  let winner = -1;
  let turns = 0;
  let idle = 0;
  const illegal = [];

  const vis0 = A.updateFog(fogs[ekSide], board, ekSide);
  const st0 = serialize(board, ekSide, fogs[ekSide], vis0);
  ek.start(startDataFor(board, ekSide), updatePacket(board, 1, st0));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    turns = turn + 1;
    for (const p of [0, 1]) {
      if (board.owner[board.generals[p]] !== p) continue;
      const vis = A.updateFog(fogs[p], board, p);
      if (p === ekSide) {
        const st = serialize(board, p, fogs[p], vis);
        const mv = ek.turn(updatePacket(board, turn + 1, st));
        if (mv) {
          const okMove = A.applyMove(board, p, mv[0], mv[1], mv[2]);
          if (!okMove) illegal.push([turn, mv, illegalReason(board, p, mv)]);
          if (opts.trace) {
            console.log('T' + turn + ' ek ' + (mv[0] % W) + ',' + Math.floor(mv[0] / W) +
              '>' + (mv[1] % W) + ',' + Math.floor(mv[1] / W) + (mv[2] ? ' half' : '') +
              (okMove ? '' : ' [非法 ' + illegal[illegal.length - 1][2] + ']'));
          }
        } else if (opts.trace) {
          console.log('T' + turn + ' ek 过');
        }
      } else {
        const view = A.makeView(board, p, fogs[p], vis);
        const act = ref.plan(view);
        if (act) A.applyMove(board, p, act.from, act.to, act.split);
      }
      if (board.owner[board.generals[1 - p]] === p) {
        winner = p;
        break;
      }
    }
    if (winner >= 0) break;

    if (process.env.GB_EK_LAND && turn % 25 === 0) {
      console.log('T' + turn + ' 地 ' + A.landCount(board, ekSide) + ':' + A.landCount(board, 1 - ekSide) +
        ' 兵 ' + A.armyCount(board, ekSide) + ':' + A.armyCount(board, 1 - ekSide) +
        ' 城 ' + A.cityCount(board, ekSide) + ':' + A.cityCount(board, 1 - ekSide));
    }

    const t1 = turn + 1;
    const fast = process.env.GB_INCOME === 'fast';
    for (let i = 0; i < N; i++) {
      const o = board.owner[i];
      if (o < 0) continue;
      const isProduce = i === board.generals[o] || board.cities[i];
      if (fast) {
        if (isProduce) board.armies[i] += 1;
        if (t1 % 25 === 0) board.armies[i] += 1;
      } else {
        if (isProduce && t1 % 2 === 0) board.armies[i] += 1;
        if (t1 % 50 === 0) board.armies[i] += 1;
      }
    }
  }

  ek.missing = EK.Bot.missingReport();
  return {
    seed: seed,
    ekSide: ekSide,
    winner: winner,
    win: winner === ekSide,
    draw: winner < 0,
    turns: turns,
    ekLand: A.landCount(board, ekSide),
    refLand: A.landCount(board, 1 - ekSide),
    ekArmy: A.armyCount(board, ekSide),
    refArmy: A.armyCount(board, 1 - ekSide),
    ekCities: A.cityCount(board, ekSide),
    refCities: A.cityCount(board, 1 - ekSide),
    ekMs: ek.turnMs,
    ekErrors: ek.errors,
    ekLastError: ek.lastError,
    ekFirstError: ek.firstError,
    ekFirstStack: ek.firstStack,
    illegal: illegal.length,
    illegalList: illegal,
    idle: idle,
    missing: ek.missing
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

function main() {
  const opponent = process.argv[2] || 'gc';
  const games = Number(process.argv[3] || 4);
  const trace = !!process.env.GB_EK_TRACE;
  const seeds = Math.ceil(games / 2);

  const tasks = [];
  for (let s = 0; s < seeds; s++) {
    for (const side of [0, 1]) {
      if (tasks.length >= games) break;
      tasks.push({ seed: 1000 + s * 7919, side: side });
    }
  }

  console.log('移植版 JS vs ' + opponent + '：' + tasks.length + ' 局（真迷雾、真规则）');
  const t0 = Date.now();
  const results = [];
  for (const t of tasks) {
    let r = null;
    try {
      r = playGameEk(t.seed, opponent, t.side, { trace: trace });
    } catch (e) {
      console.error('seed ' + t.seed + ' side ' + t.side + ' 崩了：' + (e && e.stack ? e.stack : e));
    }
    if (r) results.push(r);
  }

  if (!results.length) {
    console.log('  一局都没跑完');
    return;
  }
  const wins = results.filter((r) => r.win).length;
  const draws = results.filter((r) => r.draw).length;
  const losses = results.length - wins - draws;
  const avg = (k) => (results.reduce((s, r) => s + r[k], 0) / results.length).toFixed(1);
  console.log('  ' + wins + ' 胜 / ' + losses + ' 负 / ' + draws + ' 和   胜率 ' +
    ((wins / results.length) * 100).toFixed(1) + '%');
  console.log('  平均：回合 ' + avg('turns') + '  地 ' + avg('ekLand') + ':' + avg('refLand') +
    '  兵 ' + avg('ekArmy') + ':' + avg('refArmy') + '  城 ' + avg('ekCities') + ':' + avg('refCities'));
  const errs = results.reduce((s, r) => s + r.ekErrors, 0);
  const bad = results.reduce((s, r) => s + r.illegal, 0);
  const totalTurns = results.reduce((s, r) => s + r.turns, 0);
  console.log('  每步 ' + (results.reduce((s, r) => s + r.ekMs, 0) / Math.max(1, totalTurns)).toFixed(0) +
    'ms  出招异常 ' + errs + '  非法招 ' + bad + '  墙钟 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  const lastErr = results.find((r) => r.ekLastError);
  if (lastErr) console.log('  最近一次异常：' + lastErr.ekLastError);
  /* 非法招按原因聚合：同一原因反复出现说明是引擎侧系统性偏差，不是偶发 */
  if (bad > 0) {
    const why = {};
    for (const r of results) for (const it of (r.illegalList || [])) why[it[2]] = (why[it[2]] || 0) + 1;
    console.log('  非法招原因：' + JSON.stringify(why));
    const one = results.find((r) => r.illegalList && r.illegalList.length);
    if (one) console.log('  首个非法招：' + JSON.stringify(one.illegalList[0]));
  }
  const firstErr = results.find((r) => r.ekFirstStack);
  if (firstErr) console.log('  首次异常栈：\n' + firstErr.ekFirstStack);
  const missing = results.find((r) => r.missing && Object.keys(r.missing).length);
  if (missing) console.log('  缺失依赖：' + JSON.stringify(missing.missing));
}

module.exports = { EkBot: EkBot, playGameEk: playGameEk, loadEK: loadEK };

if (require.main === module) {
  main();
}
