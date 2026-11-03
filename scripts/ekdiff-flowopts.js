/*
 * flow 扩张计划对拍（隔离上游版）。
 *
 * 为什么不让 JS 自己算输入：bonus 权重图、army override、敌方来路这些都由
 * expansionops / interceptor 算出，那两个模块还有已知的小分叉（bonus 差 0.05、
 * enemyAttackPathTiles 差 1），拿它们的产物对拍会把上游误差算到 flow 头上。
 * 所以这里直接吃原版录下来的**入参快照**，在 JS 侧重建同样的输入对象，只比 flow
 * 自己的输出。上游分叉另行用 ekdiff-move 定位。
 *
 *   node scripts/ekdiff-flowopts.js E:\akcoco6de\_research\ekdump\gm1.jsonl E:\akcoco6de\_research\flowexp-gm1.json [-v] [--turn=40]
 *
 * 判定口径：count 一致 + 每个 plan 的 type / econValue / length / tiles /
 * gathered_army 全一致（econValue 用 float64 逐位比，不加容差）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
const MODULES = [
  'pyrandom', 'clock', 'pysetorder',
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'nx',
  'armyanalyzer', 'territory', 'board', 'danger', 'city',
  'armytracker', 'opponenttracker', 'tileisland', 'gather', 'mapspanning', 'watchman',
  'expandutils', 'earlyexpandutils', 'timings', 'killtiming',
  'expansionops', 'combatops', 'gatherops', 'cityops', 'targeting',
  'interceptor', 'defense', 'explorationops', 'centraldefense', 'eventhandlers',
  'wincondition', 'comms', 'rendering', 'pathing', 'repetition',
  'statequeries',
  'flowmodels', 'flowgraph', 'flowmincost', 'flowknapsack', 'flowexpansion', 'iterativeexpansion',
  'expandhooks', 'botmain'
];

function loadEK() {
  for (const m of MODULES) {
    const p = path.join(ROOT, m + '.js');
    if (!fs.existsSync(p)) continue;
    require(p);
  }
  const EK = global.__EK;
  if (!EK || !EK.Bot) throw new Error('eklipz 模块没挂上（global.__EK 无 Bot）');
  return EK;
}

// 逐弧流量留档：两侧都按「调用序号 + 原 node id」落盘，键对不上就判「不是同一张图」而不是「流量不同」。
// 挂 compute_flow 而不是求解器本身，因为只有这里同时有 idx_to_node 和 flows。
function installSolveRecorder(ek) {
  const Computer = ek.flow.OrToolsFlowComputer;
  if (!Computer || Computer.prototype.__recorderInstalled) return;
  const orig = Computer.prototype.compute_flow;
  Computer.prototype.compute_flow = function (islands, graphData) {
    const out = orig.call(this, islands, graphData);
    const store = (global.__FESOLVES = global.__FESOLVES || []);
    try {
      const idxToNode = graphData.idx_to_node;
      const nodeIds = Array.from(graphData.node_ids || []);
      const starts = [];
      const ends = [];
      for (let a = 0; a < graphData.start_nodes.length; a++) {
        starts.push(idxToNode.get(graphData.start_nodes[a]));
        ends.push(idxToNode.get(graphData.end_nodes[a]));
      }
      const flows = [];
      let totalFlow = 0;
      const nodeSupplies = Array.from(graphData.node_supplies || []);
      if (out) {
        const keys = Array.from(out.keys()).sort((x, y) => x - y);
        for (const src of keys) {
          const targets = out.get(src);
          const dsts = Array.from(targets.keys()).sort((x, y) => x - y);
          for (const dst of dsts) {
            const amount = targets.get(dst);
            flows.push([src, dst, amount]);
            totalFlow += amount;
          }
        }
      }
      // unique_id 两侧分配不同，只能靠「岛内最小 tile_index」canon 对齐后比供给与流量。
      const canon = {};
      try {
        const byUid = islands && islands.tile_islands_by_unique_id;
        if (byUid) {
          const uids = typeof byUid.keys === 'function' ? Array.from(byUid.keys()) : Object.keys(byUid);
          for (const uid of uids) {
            const isl = typeof byUid.get === 'function' ? byUid.get(uid) : byUid[uid];
            if (!isl) continue;
            const tiles = isl.tile_set ? Array.from(isl.tile_set) : [];
            let minIdx = Infinity;
            for (const tt of tiles) minIdx = Math.min(minIdx, tt.tile_index);
            if (minIdx !== Infinity) canon[Number(uid)] = minIdx;
          }
        }
      } catch (e) {
        // canon 只用于对齐，拿不到就退化成按原始 id 比
      }
      // 逐岛原始字段：supply 差到底是「兵算错」还是「格子数/口径错」，只有并排看才能定。
      const islandsRows = [];
      try {
        const byUid = islands && islands.tile_islands_by_unique_id;
        if (byUid) {
          const supplyByUid = new Map();
          for (let i = 0; i < nodeIds.length; i++) supplyByUid.set(nodeIds[i], nodeSupplies[i]);
          const uids = typeof byUid.keys === 'function' ? Array.from(byUid.keys()) : Object.keys(byUid);
          for (const uid of uids) {
            const isl = typeof byUid.get === 'function' ? byUid.get(uid) : byUid[uid];
            if (!isl) continue;
            const c = canon[Number(uid)];
            if (c === undefined) continue;
            islandsRows.push([c, Number(uid), isl.team, isl.sum_army, isl.tile_count,
              supplyByUid.has(Number(uid)) ? supplyByUid.get(Number(uid)) : null]);
          }
          islandsRows.sort((x, y) => x[0] - y[0]);
        }
      } catch (e) {
        // 逐岛表只用于诊断
      }
      store.push({
        call: store.length,
        // 一回合里 compute_flow 被调两次的定位手段：谁在调、调了几次（只读观测，不改 src）。
        stack: (function () {
          var st = new Error().stack || '';
          return st.split('\n').slice(2, 10).map(function (s) { return s.trim().replace(/^at\s+/, ''); });
        })(),
        numNodes: nodeIds.length,
        numArcs: starts.length,
        nodeIds,
        canon,
        islandsRows,
        nodeSupplies,
        startNodes: starts,
        endNodes: ends,
        capacities: Array.from(graphData.capacities || []),
        unitCosts: Array.from(graphData.unit_costs || []),
        fakeNodes: Array.from(graphData.fake_nodes ? Array.from(graphData.fake_nodes) : []).sort((x, y) => x - y),
        cumulativeDemand: graphData.cumulative_demand,
        flowsById: flows,
        totalFlow,
      });
    } catch (e) {
      store.push({ call: store.length, error: String(e && e.message) });
    }
    return out;
  };
  Computer.prototype.__recorderInstalled = true;
}

function readRecords(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      // 半截行（上次 dump 被杀）忽略
    }
  }
  return out;
}

function tileIdxList(coll) {
  if (!coll) return [];
  const idxs = [];
  for (const t of coll) idxs.push(t && typeof t === 'object' ? t.tile_index : t);
  return idxs.sort((a, b) => a - b);
}

function planSnapshot(plan) {
  if (!plan) return null;
  let moves = [];
  try {
    moves = plan.get_move_list() || [];
  } catch (e) {
    moves = [];
  }
  let tiles = [];
  if (plan.tileSet) {
    tiles = tileIdxList(plan.tileSet);
  } else if (plan.root_nodes) {
    const set = new Set();
    const stack = plan.root_nodes.slice();
    while (stack.length) {
      const cur = stack.pop();
      set.add(cur.tile);
      for (const c of (cur.children || [])) stack.push(c);
    }
    tiles = tileIdxList(set);
  }
  const gathered = plan.gathered_army;
  return {
    type: (plan.constructor && plan.constructor.name) || 'Object',
    econValue: Number(plan.econValue || 0),
    length: moves.length,
    tiles: tiles,
    gathered_army: (gathered === undefined || gathered === null) ? null : Number(gathered)
  };
}

function arrEq(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- 中间层记录 -------------------------------------------------------------
// 计划不同有三层可能：border pair 选谁 → lookup 表内容 → knapsack 挑了哪几项。
// 把三层各自记下来逐层比，才能把分歧钉在某一层，否则只能盯着最终计划猜。
function pairCanon(expander, pair) {
  const lookup = expander.island_builder && expander.island_builder.tile_islands_by_unique_id;
  function canon(id) {
    if (!lookup) return null;
    const island = lookup.get ? lookup.get(id) : lookup[id];
    if (!island) return null;
    let min = null;
    for (const t of island.tile_set) {
      if (min === null || t.tile_index < min) min = t.tile_index;
    }
    return min;
  }
  if (!pair) return null;
  if (typeof pair === 'string') {
    // JS 侧 solution 的键是 'fid->tid' 字符串，拆开再翻译成 canonical id
    const parts = pair.split('->');
    if (parts.length !== 2) return pair;
    return [canon(Number(parts[0])), canon(Number(parts[1]))];
  }
  return [canon(pair.friendlyIslandId !== undefined ? pair.friendlyIslandId : pair.friendly_island_id),
    canon(pair.targetIslandId !== undefined ? pair.targetIslandId : pair.target_island_id)];
}

function pairIds(expander, pairs) {
  const out = [];
  for (const p of (pairs || [])) out.push(pairCanon(expander, p));
  return out;
}

function countEntries(entries) {
  let n = 0;
  for (const e of (entries || [])) if (e) n++;
  return n;
}

function wrapLayers(ek) {
  const proto = ek.flow && ek.flow.ArmyFlowExpanderV2 && ek.flow.ArmyFlowExpanderV2.prototype;
  if (!proto || proto.__feWrapped) return;
  proto.__feWrapped = true;

  const origProc = proto._process_flow_into_flow_army_turns;
  proto._process_flow_into_flow_army_turns = function (borderPairs, flowGraph, targetCrossable, turnBudget) {
    const tables = origProc.call(this, borderPairs, flowGraph, targetCrossable, turnBudget);
    const dbg = (global.__FEDBG = global.__FEDBG || {});
    dbg.border_pairs = (borderPairs || []).map((p) => pairCanon(this, p));
    dbg.tables = (tables || []).map((t) => ({
      pair: pairCanon(this, t.border_pair),
      cap: countEntries(t.capture_entries_by_turn),
      gat: countEntries(t.gather_entries_by_turn),
      enr: (t.enriched_capture_entries || []).length
    }));
    // 边权是「流」的唯一产物：friendly 的 sort_score 用 sum(flow_to.edge_army)，
    // 下游势能也沿着同样的边累加，所以先把每个友好节点出去的边录下来。
    try {
      const lookup = flowGraph && flowGraph.flow_node_lookup_by_island_no_neut;
      const edges = [];
      if (lookup) {
        const ids = [];
        if (typeof lookup.keys === 'function') { for (const k of lookup.keys()) ids.push(k); } else { ids.push(...Object.keys(lookup)); }
        ids.sort((a, b) => Number(a) - Number(b));
        for (const id of ids) {
          const node = typeof lookup.get === 'function' ? lookup.get(id) : lookup[id];
          if (!node) continue;
          edges.push([
            pairCanon(this, { friendlyIslandId: Number(id), targetIslandId: Number(id) })[0],
            (node.flow_to || []).map((e) => [pairCanon(this, { friendlyIslandId: e.target_flow_node.island.unique_id, targetIslandId: e.target_flow_node.island.unique_id })[0], Number(e.edge_army)]).sort((a, b) => a[0] - b[0])
          ]);
        }
      }
      dbg.edges = edges;
    } catch (err) {
      dbg.edges = ['ERROR ' + (err && err.stack ? err.stack : err)];
    }
    return tables;
  };

  // py 的 _preprocess_flow_stream_tilecounts 有 borderPair 参数、js 只有 streamData，
  // 所以在这里按对象记一份 pair，贡献度对比才有键可对。
  const streamPairOf = new WeakMap();
  const origBuildStream = proto._build_border_pair_stream_data;
  proto._build_border_pair_stream_data = function (borderPair) {
    const data = origBuildStream.apply(this, arguments);
    if (data) streamPairOf.set(data, borderPair);
    return data;
  };

  const origPre = proto._preprocess_flow_stream_tilecounts;
  proto._preprocess_flow_stream_tilecounts = function (streamData, borderPair) {
    const out = origPre.call(this, streamData, borderPair);
    const dbg = (global.__FEDBG = global.__FEDBG || {});
    const pairArg = borderPair || streamPairOf.get(streamData) || null;
    (dbg.contribs = dbg.contribs || []).push({
      pair: pairCanon(this, pairArg),
      friendly: (out[0] || []).map((c) => [pairCanon(this, { friendlyIslandId: c.island_id, targetIslandId: c.island_id })[0], Number(c.sort_score)]),
      target: (out[1] || []).map((c) => [pairCanon(this, { friendlyIslandId: c.island_id, targetIslandId: c.island_id })[0], Number(c.sort_score)])
    });
    return out;
  };

  const origKnap = proto._solve_grouped_knapsack;
  proto._solve_grouped_knapsack = function (lookupTables, turns, externalOptions) {
    const sol = origKnap.call(this, lookupTables, turns, externalOptions);
    const dbg = (global.__FEDBG = global.__FEDBG || {});
    const keys = [];
    if (sol) {
      for (const k of sol.keys()) keys.push(pairCanon(this, k));
    }
    dbg.solution = keys;
    return sol;
  };
}

// 富化发生在 postprocess 之后，所以表内容只能在调用返回后从 last_lookup_tables 录。
// 只录数值（回合/兵力/经济），tile 集合的差异会体现在最终 plan 上。
function lookupSnapshots(expander) {
  const out = [];
  const tables = expander.last_lookup_tables || [];
  for (const t of tables) {
    const caps = [];
    for (const e of (t.capture_entries_by_turn || [])) {
      if (!e) continue;
      caps.push([e.turns, e.required_army, Number(e.econ_value)]);
    }
    const gats = [];
    for (const e of (t.gather_entries_by_turn || [])) {
      if (!e) continue;
      gats.push([e.turns, e.gathered_army]);
    }
    const enr = [];
    for (const e of (t.enriched_capture_entries || [])) {
      enr.push([e.turns, Number(e.capture_entry ? e.capture_entry.econ_value : 0),
        e.gather_entry ? e.gather_entry.turns : null,
        Number(e.combined_value_density)]);
    }
    out.push({ pair: pairCanon(expander, t.border_pair), caps: caps, gats: gats, enr: enr });
  }
  return out;
}

// 一条记录里表能差几十项，只报第一处分歧的位置和两侧的值
function firstRowDiff(label, a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) === JSON.stringify(b[i])) continue;
    return label + '[' + i + '] py=' + JSON.stringify(a[i]) + ' js=' + JSON.stringify(b[i]);
  }
  return label + ' 长度 ' + a.length + ' != ' + b.length;
}

function diffDbg(pyDbg, jsDbg) {
  const out = [];
  if (!pyDbg || !jsDbg) return out;
  const a = JSON.stringify(pyDbg.border_pairs || []);
  const b = JSON.stringify(jsDbg.border_pairs || []);
  if (a !== b) out.push('border_pairs py=' + a + ' js=' + b);
  const t = JSON.stringify(pyDbg.tables || []);
  const u = JSON.stringify(jsDbg.tables || []);
  if (t !== u) out.push('tables py=' + t + ' js=' + u);
  const s = JSON.stringify(pyDbg.solution || []);
  const v = JSON.stringify(jsDbg.solution || []);
  if (s !== v) out.push('solution py=' + s + ' js=' + v);

  // 边权不同 = 流本身不同，这一层不属于 flowexpansion.js，报出来交给上游。
  // 两侧 unique_id 编号不同，行序必须按 canonical id 归一，否则比的是排序噪声。
  const norm = (rows) => (rows || [])
    .filter((r) => Array.isArray(r))
    .slice()
    .sort((x, y) => (Number(x[0]) || 0) - (Number(y[0]) || 0));
  const pe = norm(pyDbg.edges);
  const je = norm(jsDbg.edges);
  if (pe.length !== je.length) {
    out.push('edges 节点数 py=' + pe.length + ' js=' + je.length);
  } else {
    const bad = [];
    for (let i = 0; i < pe.length; i++) {
      if (JSON.stringify(pe[i]) === JSON.stringify(je[i])) continue;
      bad.push('py=' + JSON.stringify(pe[i]) + ' js=' + JSON.stringify(je[i]));
    }
    if (bad.length) out.push('edges 差 ' + bad.length + '/' + pe.length + ' 处：' + bad.slice(0, 4).join(' ; '));
  }

  // 流内岛顺序（friendly 排过序、target 保持物理顺序）决定采集到哪些格，
  // 顺序一分叉，后面 econ 累积就跟着差，所以单独报
  const pc = pyDbg.contribs || [];
  const jc = jsDbg.contribs || [];
  if (pc.length !== jc.length) {
    out.push('contribs 组数 py=' + pc.length + ' js=' + jc.length);
  } else {
    for (let i = 0; i < pc.length; i++) {
      if (JSON.stringify(pc[i]) === JSON.stringify(jc[i])) continue;
      const seg = ['pair ' + JSON.stringify(pc[i].pair)];
      seg.push('friendly ' + firstRowDiff('f', pc[i].friendly, jc[i].friendly));
      seg.push('target ' + firstRowDiff('t', pc[i].target, jc[i].target));
      out.push('contribs[' + i + '] ' + seg.join(' | '));
      break;
    }
  }

  // 表内容逐张比，且只报第一张不同的表，否则一条记录能刷出几十行
  const pl = pyDbg.lookups || [];
  const jl = jsDbg.lookups || [];
  if (pl.length !== jl.length) {
    out.push('lookups 表数 py=' + pl.length + ' js=' + jl.length);
  } else {
    for (let i = 0; i < pl.length; i++) {
      const a = JSON.stringify(stripCtrail(pl[i]));
      const b = JSON.stringify(stripCtrail(jl[i]));
      if (a === b) continue;
      const seg = [];
      if (JSON.stringify(pl[i].pair) !== JSON.stringify(jl[i].pair)) seg.push('pair ' + JSON.stringify(pl[i].pair) + '!=' + JSON.stringify(jl[i].pair));
      if (JSON.stringify(pl[i].caps) !== JSON.stringify(jl[i].caps)) seg.push('caps ' + firstRowDiff('caps', pl[i].caps, jl[i].caps));
      if (JSON.stringify(pl[i].gats) !== JSON.stringify(jl[i].gats)) seg.push('gats ' + firstRowDiff('gats', pl[i].gats, jl[i].gats));
      if (JSON.stringify(pl[i].enr) !== JSON.stringify(jl[i].enr)) seg.push('enr ' + firstRowDiff('enr', pl[i].enr, jl[i].enr));
      out.push('lookup[' + i + '] ' + seg.join(' | '));
      break;
    }
  }
  return out;
}

// ctrail 是后面单独加的逐格留档（js 侧记在 __FEDBG.ctrails，py 侧塞进 lookups[i]），
// 直接参与 JSON 比较会让「表内容一致」被误判成不同。
function stripCtrail(row) {
  if (!row || typeof row !== 'object') return row;
  const copy = {};
  for (const k of Object.keys(row)) { if (k !== 'ctrail') copy[k] = row[k]; }
  return copy;
}

function diffPlans(pyPlans, jsPlans) {
  const out = [];
  if (pyPlans.length !== jsPlans.length) out.push('count ' + pyPlans.length + ' != ' + jsPlans.length);
  const n = Math.min(pyPlans.length, jsPlans.length);
  for (let i = 0; i < n; i++) {
    const a = pyPlans[i];
    const b = jsPlans[i];
    if (!a || !b) { out.push('plan[' + i + '] 一方为 null'); continue; }
    if (a.type !== b.type) out.push('plan[' + i + '].type ' + a.type + ' != ' + b.type);
    if (a.econValue !== b.econValue) out.push('plan[' + i + '].econValue ' + a.econValue + ' != ' + b.econValue);
    if (a.length !== b.length) out.push('plan[' + i + '].length ' + a.length + ' != ' + b.length);
    if (!arrEq(a.tiles, b.tiles)) {
      out.push('plan[' + i + '].tiles py(' + a.tiles.length + ')=[' + a.tiles.join(',') + ']'
        + ' js(' + b.tiles.length + ')=[' + b.tiles.join(',') + ']');
    }
    if (a.gathered_army !== b.gathered_army) {
      out.push('plan[' + i + '].gathered_army ' + a.gathered_army + ' != ' + b.gathered_army);
    }
  }
  return out;
}

function main() {
  const dumpFile = process.argv[2];
  const oracleFile = process.argv[3];
  if (!dumpFile || !oracleFile) {
    console.error('用法: node scripts/ekdiff-flowopts.js <dump.jsonl> <flow-oracle.json> [-v] [--turn=N]');
    process.exit(2);
  }
  const verbose = process.argv.includes('-v');
  const onlyTurnArg = process.argv.find((a) => a.startsWith('--turn='));
  const onlyTurn = onlyTurnArg ? Number(onlyTurnArg.split('=')[1]) : null;

  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  if (!Array.isArray(oracle) || !oracle.length) throw new Error('oracle 为空: ' + oracleFile);
  const snapByTurn = new Map();
  for (const s of oracle) snapByTurn.set(s.turn, s);
  const maxTurn = Math.max.apply(null, oracle.map((s) => s.turn));

  const ek = loadEK();
  installSolveRecorder(ek);
  const recs = readRecords(dumpFile);
  if (!recs.length) throw new Error('记录为空: ' + dumpFile);
  let startRec = null;
  let firstTurnRec = null;
  for (const r of recs) {
    if (r.start) startRec = r;
    else if (!firstTurnRec) firstTurnRec = r;
  }
  const startData = startRec ? startRec.startData : {
    playerIndex: 0,
    usernames: ['ek', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'diffflowopts',
    game_type: 'custom',
    options: {}
  };
  const startPacket = startRec ? startRec.data : firstTurnRec.data;
  const map = new ek.Map(startData, startPacket, { shuffle: false });
  map.apply_server_update(startPacket);
  const bot = new ek.Bot(startData);
  bot.initialize_from_map_for_first_time(map);

  let snaps = 0;
  let clean = 0;
  const diffs = [];
  const trace = [];
  wrapLayers(ek);

  for (const rec of recs) {
    if (rec.start) continue;
    if (rec.err) continue;
    try {
      map.apply_server_update(rec.data);
    } catch (e) {
      console.log('T' + rec.turn + ' 应用服务器数据失败（前序招法已分叉，之后的快照无法对拍）: ' + e.message);
      break;
    }
    bot.perf_timer.record_update(map.turn, Date.now());
    try {
      bot.find_move();
    } catch (e) {
      if (process.env.GB_EK_RAISE) throw e;
      console.log('T' + rec.turn + ' find_move 抛错: ' + e.message);
      break;
    }

    const turn = map.turn;
    const snap = snapByTurn.get(turn);    if (!snap) {
      if (turn > maxTurn) break;
      continue;
    }
    if (onlyTurn !== null && turn !== onlyTurn) continue;

    snaps++;
    const inp = snap.inputs;
    const notes = [];
    let jsPlans = [];
    let err = null;
    global.__FEDBG = {};
    global.__FESOLVES = [];
    try {
      const expander = new ek.flow.ArmyFlowExpanderV2(map, bot.perf_timer || null);
      expander.friendlyGeneral = bot.general;
      expander.enemyGeneral = bot.targetPlayerExpectedGeneralLocation;

      const bonus = new ek.MapMatrix(map, 0);
      for (const pair of inp.bonus_nonzero) bonus.raw[pair[0]] = pair[1];
      const override = new ek.MapMatrix(map, 0);
      for (const pair of inp.army_override_nonzero) override.raw[pair[0]] = pair[1];

      const negTiles = new Set(inp.negativeTiles.map((i) => map.tiles_by_index[i]));
      const attackTiles = inp.enemyAttackPathTiles && inp.enemyAttackPathTiles.length
        ? new Set(inp.enemyAttackPathTiles.map((i) => map.tiles_by_index[i])) : null;
      const threatTiles = inp.threatBlockingTiles === null ? null
        : new Set(inp.threatBlockingTiles.map((i) => map.tiles_by_index[i]));

      const additional = inp.additional_options.map((o) => {
        const p = new ek.Path(o.armyRemaining || 0);
        for (const ti of o.tiles) p.add_next(map.tiles_by_index[ti]);
        p.econValue = o.econValue;
        return p;
      });

      /* 真实 bot 的 hook（expandhooks.js）在同一回合已经跑过一次 get_expansion_options，
       * 那次才是对拍目标；这里的对比调用如果照常消耗随机流，js 每回合会比 py 多抽一次
       * fake_node（randint(1000000,9000000)），此后逐回合累积漂移。观测脚本不动 src，
       * 只在本地一次调用前后把 EK.rng 的状态存回。 */
      const rngState = (ek.rng && ek.rng.getstate) ? ek.rng.getstate() : null;
      const collection = expander.get_expansion_options(
        bot.tileIslandBuilder,
        inp.asPlayer,
        inp.targetPlayer,
        inp.turns,
        bot.board_analysis,
        bot.territories ? bot.territories.territoryMap : null,
        negTiles,
        null,
        null,
        bonus,
        bot.perf_timer || null,
        null,
        additional,
        override,
        threatTiles,
        null,
        attackTiles
      );
      if (rngState && ek.rng && ek.rng.setstate) ek.rng.setstate(rngState);
      jsPlans = (collection && collection.expansion_options) ? Array.from(collection.expansion_options) : [];
      // 同一时刻的全图状态：供给差异到底是「雾里未知」还是「真的不同框」，先看这张表
      try {
        const tiles = [];
        for (const tt of map.tiles_by_index) {
          const pl = typeof tt.player === 'function' ? tt.player() : tt.player;
          tiles.push([tt.tile_index, tt.army, pl === undefined || pl === null ? -2 : pl,
            !!tt.isMountain, !!tt.isCity, !!tt.isGeneral, !!tt.isObstacle,
            !!tt.visible, tt.lastSeen === undefined ? -1 : tt.lastSeen, !!tt.discovered]);
        }
        tiles.sort((x, y) => x[0] - y[0]);
        global.__FEDBG.mapTiles = { W: map.cols, H: map.rows, tiles };
      } catch (e) {
        global.__FEDBG.mapTiles = { error: String(e && e.message) };
      }
      global.__FEDBG.lookups = lookupSnapshots(expander);
      global.__FEDBG.jsEnemyGeneral = expander.enemyGeneral ? expander.enemyGeneral.tile_index : null;
    } catch (e) {
      err = e;
      if (process.env.GB_EK_RAISE) throw e;
    }

    if (err) {
      diffs.push('T' + turn + ' JS 抛异常: ' + err.message);
      if (verbose) console.log('  ' + diffs[diffs.length - 1]);
      continue;
    }
    const pyPlans = snap.output.plans || [];
    const genDiff = [];
    // 敌将位置决定整张 flow 图的 demand，两侧不同格就没法比计划
    const jsEnemyGen = global.__FEDBG.jsEnemyGeneral;
    if (inp.enemyGeneral !== jsEnemyGen) {
      genDiff.push('enemyGeneral py=' + inp.enemyGeneral + ' js=' + jsEnemyGen);
    }
    const planDiffs = diffPlans(pyPlans, jsPlans.map(planSnapshot));
    const layerDiffs = diffDbg(snap.output.dbg, global.__FEDBG);
    // 逐回合原始数值留档：势能/贡献的 1~2 回合位移靠这张表定性，不靠人眼翻日志
    trace.push({
      turn: turn,
      py: snap.output.dbg,
      js: {
        contribs: global.__FEDBG.contribs || [],
        lookups: global.__FEDBG.lookups || [],
        ctrails: global.__FEDBG.ctrails || [],
        edges: global.__FEDBG.edges || [],
        solves: global.__FESOLVES || [],
        mapTiles: global.__FEDBG.mapTiles || null,
      },
      pyPlans: (pyPlans || []).map(function (p) { return p.type + ':' + p.length; }),
      jsPlans: jsPlans.map(planSnapshot).map(function (p) { return p.type + ':' + p.length; }),
    });
    notes.length = 0;
    if (planDiffs.length || layerDiffs.length || genDiff.length) {
      const head = layerDiffs.concat(genDiff).length
        ? ('[层] ' + layerDiffs.concat(genDiff).join(' ; ')) : '';
      const tail = planDiffs.length ? planDiffs.join(' | ') : '';
      diffs.push('T' + turn + ' ' + head + (head && tail ? ' || ' : '') + tail);
      if (verbose) console.log('  ' + diffs[diffs.length - 1]);
    } else {
      clean++;
      if (verbose) console.log('T' + turn + ' ok  plans=' + pyPlans.length);
    }
  }

  if (!verbose) {
    for (const d of diffs.slice(0, 25)) console.log('  ' + d);
  }
  console.log('flow 快照 ' + snaps);
  console.log('一致 ' + clean + '  不一致 ' + (snaps - clean) + '  一致率 '
    + (snaps ? ((clean / snaps) * 100).toFixed(2) : '0.00') + '%');
  if (process.env.GB_TRACE) {
    const outPath = process.env.GB_TRACE;
    fs.writeFileSync(outPath, JSON.stringify(trace));
    console.log('trace 写入 ' + outPath + '（' + trace.length + ' 回合）');
  }
}

main();
