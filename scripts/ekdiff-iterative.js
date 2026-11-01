/**
 * ekdiff-iterative.js —— EK.ArmyFlowExpander（legacy IterativeExpansion）与 python 原版的逐回合对拍。
 *
 * oracle 由 _research/ekdump_iterative.py 生成：
 *   cd E:\akcoco6de\_research\generals-bot-cs
 *   $env:PYTHONPATH='E:\akcoco6de\_research\generals-bot-cs'
 *   python ..\ekdump_iterative.py E:\akcoco6de\_research\ekdump\gm1.jsonl E:\akcoco6de\_research\iterative-gm1.json
 *
 * 比对三样（与 oracle 同一口径）：
 *   root tile 集合（排序）、tiles 集合（排序）、econValue（1e-9）+ turns
 *
 * 为什么两边口径要一模一样：legacy 扩张器的输入全部由上游 bot 算出，只有回放同一局、
 * 在同样的时点（apply_server_update -> record_update -> find_move 之后）调用，
 * 才是同一组输入。两边都复用同一个 expander 实例、每回合刷 friendlyGeneral/enemyGeneral。
 *
 * 用法:
 *   node scripts/ekdiff-iterative.js <dump.jsonl> <oracle.json> [--from=20] [--verbose]
 * 退出码：0 = 全部一致；1 = 有不一致；2 = 用法/文件问题。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DUMP = process.argv[2];
const ORACLE = process.argv[3];
const FROM = Number((process.argv.find((a) => a.startsWith('--from=')) || '--from=0').slice(7));
const VERBOSE = process.argv.includes('--verbose');
const ECON_TOL = 1e-9;

if (!DUMP || !ORACLE) {
  console.error('用法: node scripts/ekdiff-iterative.js <dump.jsonl> <oracle.json> [--from=0] [--verbose]');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
// iterativeexpansion 还没进 ekjs.js 的 MODULES（默认路径走 ArmyFlowExpanderV2），
// 所以这里单独列一遍加载序；其余顺序与 scripts/ekdiff-move.js 保持一致。
const MODULES = [
  'pyrandom', 'clock', 'pysetorder',
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'nx',
  'armyanalyzer', 'territory', 'board', 'danger', 'city',
  'armytracker', 'opponenttracker', 'tileisland', 'gather', 'mapspanning', 'watchman',
  'gatherprune', 'botqueries', 'watchmanroute', 'gathermax', 'fastdisjointset', 'gatherutils',
  'expandutils', 'earlyexpandutils', 'timings', 'killtiming',
  'expansionops', 'combatops', 'gatherops', 'cityops', 'targeting',
  'interceptor', 'defense', 'explorationops', 'centraldefense', 'eventhandlers',
  'wincondition', 'comms', 'rendering', 'pathing', 'repetition',
  'statequeries',
  'flowmodels', 'flowgraph', 'flowmincost', 'flowknapsack', 'flowexpansion',
  'iterativeexpansion',
  'expandhooks', 'botmain'
];

for (const m of MODULES) {
  const p = path.join(ROOT, m + '.js');
  if (!fs.existsSync(p)) {
    console.error('缺模块: ' + p);
    process.exit(2);
  }
  require(p);
}
const EK = global.__EK;
if (!EK || !EK.Bot) throw new Error('模块没挂上（global.__EK 无 Bot）');
if (typeof EK.ArmyFlowExpander !== 'function') throw new Error('EK.ArmyFlowExpander 没导出');

const oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
const oracleByTurn = new Map();
for (const rec of oracle) oracleByTurn.set(rec.turn, rec.options);

const recs = fs.readFileSync(DUMP, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
  .filter(Boolean);

let startRec = null;
let firstTurnRec = null;
for (const r of recs) {
  if (r.start) startRec = r;
  else if (!firstTurnRec) firstTurnRec = r;
}
const startData = startRec ? startRec.startData : {
  playerIndex: 0, usernames: ['ek', 'them'], playerColors: ['#111111', '#222222'],
  replay_id: 'ekdiff-iterative', game_type: 'custom', options: {}
};
const startPacket = startRec ? startRec.data : firstTurnRec.data;

const map = new EK.Map(startData, startPacket, { shuffle: false });
if (startRec) map.apply_server_update(startPacket);
const bot = new EK.Bot(startData);
bot.initialize_from_map_for_first_time(map);

const expander = new EK.ArmyFlowExpander(map, bot.perf_timer || null);

// 同时录 filter 之前的 plan 列表：区分「find_flow_plans 就分叉」还是「只是 superset 过滤/排序分叉」。
// 只观测不干预（包装后原样调用原函数）。
const PRE_OUT = process.env.GB_PRE_OUT || null;
const preLog = [];
const origFilter = EK.ArmyFlowExpander.prototype.filter_plans_by_common_supersets_and_sort;
EK.ArmyFlowExpander.prototype.filter_plans_by_common_supersets_and_sort = function (plans) {
  try {
    preLog.push({
      turn: this.map.turn,
      n: plans.length,
      opts: plans.map(optSnapshot)
    });
  } catch (e) {
    preLog.push({ turn: this.map.turn, error: String(e && e.message) });
  }
  return origFilter.call(this, plans);
};

// 记每次 _is_flow_allowed 的判定：播种阶段用它筛 (targetIsland, adjacentFriendlyIsland)，
// 两侧判定不同就会直接少播 pair。canon 用岛内最小 tile_index（unique_id 两侧不保证一致）。
const IFA_OUT = process.env.GB_IFA_OUT || null;
const ifaLog = [];
function islandCanon(island) {
  let best = Infinity;
  const arr = island.tile_set && (island.tile_set.raw || island.tile_set);
  if (arr) {
    for (const t of arr) {
      if (t && t.tile_index < best) best = t.tile_index;
    }
  }
  if (best === Infinity) best = island.unique_id;
  return best;
}
const origIfa = EK.ArmyFlowExpander.prototype._is_flow_allowed;
// canon 空间 dump flow dict（带符号端口），用于和 oracle 的 flow 直接比
const FLOW_OUT = process.env.GB_FLOW_OUT || null;
const flowLog = [];
const origCfd3 = EK.flow.NetworkXFlowDirectionFinder.prototype.compute_flow_dict;
EK.flow.NetworkXFlowDirectionFinder.prototype.compute_flow_dict = function (islands, graphData, method) {
  const res = origCfd3.apply(this, arguments);
  if (FLOW_OUT) {
    try {
      const tileOfUid = new Map();
      for (const isl of islands.all_tile_islands.items()) {
        let m = Infinity;
        for (const t of isl.tile_set.raw || isl.tile_set) if (t.tile_index < m) m = t.tile_index;
        if (m !== Infinity) tileOfUid.set(isl.unique_id, m);
      }
      const fakeSet = graphData.fake_nodes instanceof Set ? graphData.fake_nodes : new Set();
      const cn = function (id) {
        const v = Number(id);
        if (fakeSet.has(v) || fakeSet.has(-v)) return 'FAKE';
        const c = tileOfUid.get(Math.abs(v));
        const base = c === undefined ? '?' + Math.abs(v) : c;
        return (v < 0 ? '-' : '') + base;
      };
      const edges = [];
      res.forEach(function (targets, src) {
        targets.forEach(function (val, dst) { if (val) edges.push(cn(src) + '>' + cn(dst) + ':' + val); });
      });
      flowLog.push({ turn: this.map.turn, edges: edges.sort() });
    } catch (e) {
      flowLog.push({ turn: this.map.turn, error: String(e && e.message) });
    }
  }
  return res;
};
// dump 实际喂给求解器的两张图，判定「图不同」还是「同图多解」
const GRAPH_OUT = process.env.GB_GRAPH_OUT || null;
const graphLog = [];
const origCfd = EK.flow.NetworkXFlowDirectionFinder.prototype.compute_flow_dict;
EK.flow.NetworkXFlowDirectionFinder.prototype.compute_flow_dict = function (islands, graphData, method) {
  if (GRAPH_OUT) {
    try {
      const canon = {};
      for (const isl of islands.all_tile_islands.items()) {
        let m = Infinity;
        for (const t of isl.tile_set.raw || isl.tile_set) if (t.tile_index < m) m = t.tile_index;
        canon[isl.unique_id] = m;
      }
      const g = graphData.graph;
      const nodeIds = g.nodes();
      const nodes = nodeIds.map((n) => [n, graphData.node_demand(n) | 0]);
      const edges = g.edges(true).map((e) => {
        const at = e[2] || {};
        return [e[0], e[1], at.capacity === undefined ? 1e9 : at.capacity, at.weight === undefined ? 1 : at.weight];
      });
      graphLog.push({ turn: this.map.turn, nodes, edges, canon });
    } catch (e) {
      graphLog.push({ turn: this.map.turn, error: String(e && e.message) });
    }
  }
  return origCfd.call(this, islands, graphData, method);
};

// graft：用 oracle 的 flowDict 顶替 JS 求解结果，用来把「求解器选解差异」与
// 「JS 逻辑 bug」分开。只在本脚本内生效，仓库代码零改动。
const GRAFT_PATH = process.env.GB_GRAFT_FLOW || null;
let graftByTurn = null;
if (GRAFT_PATH) {
  const raw = JSON.parse(fs.readFileSync(GRAFT_PATH, 'utf8'));
  graftByTurn = new Map();
  for (const e of raw) {
    const k = String(e.turn);
    if (!graftByTurn.has(k)) graftByTurn.set(k, new Map());
    graftByTurn.get(k).set(e.which, e);
  }
}
function isWithNeut(graphData) {
  // python：with_neut 的 fakeNode→neutSink 边 weight=10，no_neut 为 0
  const g = graphData.graph;
  const fakes = graphData.fake_nodes;
  const isFake = function (n) {
    if (fakes && typeof fakes.has === 'function') return fakes.has(n);
    return Math.abs(n) >= 1000000;
  };
  const edges = g.edges(true);
  for (const e of edges) {
    const at = e[2] || {};
    if (isFake(e[0]) && at.weight === 10) return true;
  }
  return false;
}
function graftFlowDict(finder, islands, graphData) {
  const turn = String(finder.map.turn);
  const perTurn = graftByTurn.get(turn);
  if (!perTurn) return null;
  const which = isWithNeut(graphData) ? 'with_neut' : 'no_neut';
  const entry = perTurn.get(which);
  if (!entry) return null;
  const g = graphData.graph;
  const nodeIds = g.nodes();
  const nodeSet = new Set(nodeIds.map(Number));
  let jsFake = null;
  const fakes = graphData.fake_nodes;
  if (fakes && typeof fakes.forEach === 'function') {
    fakes.forEach(function (f) { if (jsFake === null) jsFake = f; });
  }
  // py 与 js 的 island.unique_id 分配不同（差一位），只能通过 canon=tile_set 最小 tile_index 对齐
  const pyCanon = entry.canon || {};
  const jsUidByTile = new Map();
  for (const isl of islands.all_tile_islands.items()) {
    let m = Infinity;
    for (const t of isl.tile_set.raw || isl.tile_set) if (t.tile_index < m) m = t.tile_index;
    if (m !== Infinity && !jsUidByTile.has(m)) jsUidByTile.set(m, isl.unique_id);
  }
  const remap = function (n) {
    const v = Number(n);
    if (nodeSet.has(v)) return v;
    const canon = pyCanon[String(Math.abs(v))];
    if (canon !== undefined && jsUidByTile.has(canon)) {
      const uid = jsUidByTile.get(canon);
      return v < 0 ? -uid : uid;
    }
    const a = Math.abs(v);
    if (nodeSet.has(a)) return v < 0 ? -a : a;
    return jsFake === null ? v : jsFake;
  };
  const flowBySource = new Map();
  for (const e of entry.edges) {
    const u = remap(e[0]);
    const v = remap(e[1]);
    if (!flowBySource.has(u)) flowBySource.set(u, new Map());
    flowBySource.get(u).set(v, (flowBySource.get(u).get(v) || 0) + e[2]);
  }
  const flowDict = new Map();
  for (const nid of nodeIds) {
    const targets = new Map();
    const outEdges = g.out_edges_of ? g.out_edges_of(nid) : (g._adj instanceof Map && g._adj.get(nid) ? Array.from(g._adj.get(nid).keys()) : []);
    const srcMap = flowBySource.get(Number(nid));
    for (const t of outEdges) {
      let val = 0;
      if (srcMap) {
        if (srcMap.has(t)) val = srcMap.get(t);
        else if (srcMap.has(Number(t))) val = srcMap.get(Number(t));
      }
      targets.set(t, val);
    }
    flowDict.set(nid, targets);
  }
  return flowDict;
}
const origCfd2 = EK.flow.NetworkXFlowDirectionFinder.prototype.compute_flow_dict;
let graftHits = 0;
let graftMisses = 0;
EK.flow.NetworkXFlowDirectionFinder.prototype.compute_flow_dict = function (islands, graphData, method) {
  if (graftByTurn) {
    const gd = graftFlowDict(this, islands, graphData);
    if (gd) { graftHits++; return gd; }
    graftMisses++;
  }
  return origCfd2.call(this, islands, graphData, method);
};

const IFA_DBG = process.env.GB_IFA_DBG || null;
EK.ArmyFlowExpander.prototype._is_flow_allowed = function (fromIsland, toIsland, armyAmount) {
  const res = origIfa.apply(this, arguments);
  if (IFA_DBG) {
    const want = IFA_DBG.split(',').map(Number);
    if (islandCanon(fromIsland) === want[0] && islandCanon(toIsland) === want[1]) {
      const fg = this.flow_graph;
      console.log('[ifa-dbg] js turn=' + this.map.turn + ' pair=' + JSON.stringify(want) + ' res=' + res);
      for (const which of ['no_neut', 'inc_neut']) {
        const lk = fg['flow_node_lookup_by_island_' + which];
        const fn = lk.get(fromIsland.unique_id);
        const tn = lk.get(toIsland.unique_id);
        if (!fn || !tn) { console.log('  ' + which + ': from=' + !!fn + ' to=' + !!tn); continue; }
        const targets = (fn.flow_to || []).map((e) => (e.target_flow_node && e.target_flow_node.island ? islandCanon(e.target_flow_node.island) : '?'));
        const ident = (fn.flow_to || []).map((e) => e.target_flow_node === tn);
        console.log('  ' + which + ': from.uid=' + fromIsland.unique_id + ' to.uid=' + toIsland.unique_id
          + ' flow_to=' + JSON.stringify(targets) + ' identity=' + JSON.stringify(ident));
      }
    }
  }
  if (IFA_OUT) {
    ifaLog.push([this.map.turn, islandCanon(fromIsland), islandCanon(toIsland),
      armyAmount | 0, !!res, !!arguments[3], !!arguments[4]]);
  }
  return res;
};

function optSnapshot(option) {
  const roots = option.root_nodes.map((n) => n.tile.tile_index).sort((a, b) => a - b);
  const tiles = [];
  for (const t of option.tileSet) tiles.push(t.tile_index);
  tiles.sort((a, b) => a - b);
  return [roots, tiles, option.econValue, option.length];
}

function eqIntArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compareTurn(turn, pyOpts, jsOpts) {
  const problems = [];
  if (pyOpts.length !== jsOpts.length) {
    problems.push('count ' + pyOpts.length + ' != ' + jsOpts.length);
  }
  const n = Math.min(pyOpts.length, jsOpts.length);
  for (let i = 0; i < n; i++) {
    const p = pyOpts[i];
    const j = jsOpts[i];
    if (!eqIntArr(p[0], j[0])) {
      problems.push('opt[' + i + '] roots py=' + JSON.stringify(p[0]) + ' js=' + JSON.stringify(j[0]));
    }
    if (!eqIntArr(p[1], j[1])) {
      const ps = new Set(p[1]);
      const js2 = new Set(j[1]);
      const onlyPy = p[1].filter((t) => !js2.has(t)).slice(0, 6);
      const onlyJs = j[1].filter((t) => !ps.has(t)).slice(0, 6);
      problems.push('opt[' + i + '] tiles pyN=' + p[1].length + ' jsN=' + j[1].length
        + ' onlyPy=' + JSON.stringify(onlyPy) + ' onlyJs=' + JSON.stringify(onlyJs));
    }
    if (p[3] !== j[3]) problems.push('opt[' + i + '] turns py=' + p[3] + ' js=' + j[3]);
    if (Math.abs(p[2] - j[2]) > ECON_TOL) problems.push('opt[' + i + '] econ py=' + p[2] + ' js=' + j[2]);
  }
  return problems;
}

let compared = 0;
let diverged = 0;
let skipped = 0;
let crashedAt = null;
const report = [];

for (const rec of recs) {
  if (rec.start) continue;
  const turn = rec.turn;
  try {
    map.apply_server_update(rec.data);
  } catch (e) {
    crashedAt = { turn: turn, phase: 'apply_server_update', msg: e.message };
    break;
  }
  if (typeof bot.perf_timer.record_update === 'function') bot.perf_timer.record_update(map);
  try {
    bot.find_move();
  } catch (e) {
    crashedAt = { turn: turn, phase: 'find_move', msg: e.message };
    break;
  }
  if (turn < FROM) continue;
  const islands = bot.tileIslandBuilder;
  if (!islands) continue;
  let jsOpts = null;
  try {
    expander.friendlyGeneral = bot.general;
    expander.enemyGeneral = bot.targetPlayerExpectedGeneralLocation;
    const plans = expander.get_expansion_options(
      islands,
      bot.player.index,
      bot.targetPlayer,
      map.remainingCycleTurns,
      bot.board_analysis,
      bot.territories ? bot.territories.territoryMap : null,
      null,
      null,
      null,
      null,
      bot.perf_timer || null,
      null
    );
    jsOpts = plans && plans.expansion_options ? plans.expansion_options.map(optSnapshot) : [];
  } catch (e) {
    const stack = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : String(e);
    report.push({ turn: turn, problems: ['JS 抛错: ' + stack] });
    diverged++;
    continue;
  }
  const pyOpts = oracleByTurn.get(turn);
  if (!pyOpts) {
    skipped++;
    if (VERBOSE) console.log('[T' + turn + '] oracle 无此回合，跳过');
    continue;
  }
  compared++;
  const problems = compareTurn(turn, pyOpts, jsOpts);
  if (problems.length) {
    diverged++;
    report.push({ turn: turn, problems: problems });
    if (VERBOSE) console.log('[T' + turn + '] 不一致:\n  ' + problems.join('\n  '));
  } else if (VERBOSE) {
    console.log('[T' + turn + '] 一致 (' + jsOpts.length + ' options)');
  }
}

console.log('对拍回合 ' + compared + '（跳过 ' + skipped + '，oracle 无数据）');
console.log('一致 ' + (compared - diverged) + '  不一致 ' + diverged
  + (compared ? '  一致率 ' + (((compared - diverged) / compared) * 100).toFixed(2) + '%' : ''));
if (crashedAt) {
  console.log('T' + crashedAt.turn + ' ' + crashedAt.phase + ' 失败（前序招法已分叉或原版自己抛异常）: ' + crashedAt.msg);
}
if (report.length) {
  console.log('前 ' + Math.min(report.length, 25) + ' 处不一致：');
  for (const r of report.slice(0, 25)) {
    console.log('  T' + r.turn);
    for (const p of r.problems.slice(0, 6)) console.log('    ' + p);
  }
}
if (PRE_OUT) {
  fs.writeFileSync(PRE_OUT, JSON.stringify(preLog));
  console.log('wrote ' + preLog.length + ' pre-filter plan lists to ' + PRE_OUT);
}
if (IFA_OUT) {
  fs.writeFileSync(IFA_OUT, JSON.stringify(ifaLog));
  console.log('wrote ' + ifaLog.length + ' _is_flow_allowed calls to ' + IFA_OUT);
}
if (GRAPH_OUT) {
  fs.writeFileSync(GRAPH_OUT, JSON.stringify(graphLog));
  console.log('wrote ' + graphLog.length + ' nx flow graphs to ' + GRAPH_OUT);
}
if (graftByTurn) {
  console.log('graft hits=' + graftHits + ' misses=' + graftMisses);
}
if (FLOW_OUT) {
  fs.writeFileSync(FLOW_OUT, JSON.stringify(flowLog));
  console.log('wrote ' + flowLog.length + ' js flow dicts to ' + FLOW_OUT);
}
process.exit(diverged === 0 ? 0 : 1);
