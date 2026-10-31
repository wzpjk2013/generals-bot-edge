/*
 * Gather 背包迭代族对拍：同一份回放，Python 原版在真 bot 里跑一遍录下
 * 「矩阵 + 参数 + 结果」，这里用同样的矩阵和参数调 JS 移植版，逐项比。
 *
 * node scripts/ekdiff-gathermax.js _research/ekdump/gm1.jsonl _research/gathermax3-gm1.json [-v]
 *
 * 三个入口（oracle 的 kind 字段）：
 *   max_set      gather_max_set_iterative_plan → 比 plan.length / tile 集合 / root 树 parent
 *   max_gather   knapsack_max_gather           → 比节点树 (parent, gatherTurns, value, trunkValue, trunkDistance)
 *   depth_gather knapsack_depth_gather         → 同上
 * max_set 还要按重连分支（steiner / dynamic / pcst）分组出数字 —— pcst 是近似实现，必须
 * 单独看，否则它会把精确对齐的 steiner/dynamic 分支掩盖掉。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
for (const m of ['tile.js', 'mapmatrix.js', 'nx.js', 'search.js', 'path.js', 'map.js', 'mapmove.js',
  'fastdisjointset.js', 'gather.js', 'gatherprune.js', 'expandutils.js', 'gathermax.js']) {
  require(path.join(ROOT, m));
}
const EK = global.__EK;

const JI_KIND = {
  max_set: 'GatherMaxSet',
  max_gather: 'GatherMaxIterative',
  depth_gather: 'GatherDepthIterative'
};
const JI_FUNC = {
  max_set: 'gather_max_set_iterative_plan',
  max_gather: 'knapsack_max_gather',
  depth_gather: 'knapsack_depth_gather'
};

function readRecords(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function fmtList(arr, max) {
  if (!arr) return String(arr);
  if (arr.length <= max) return '[' + arr.join(',') + ']';
  return '[' + arr.slice(0, max).join(',') + ',…(' + arr.length + ')]';
}

function mapMatrixFromRaw(ek, map, raw) {
  const m = new ek.MapMatrix(map, 0);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    m.raw[i] = v === null || v === undefined ? 0 : v;
  }
  return m;
}

function tileSet(map, list) {
  if (!list || list.length === 0) return null;
  return new Set(list.map((i) => map.tiles_by_index[i]));
}

function rootTreeMap(nodes) {
  // rootNodes 是树根数组，把整棵树拍平成 tile -> 父 tile（GatherTreeNode.toTile）
  const out = new Map();
  const stack = [];
  for (const n of nodes || []) stack.push(n);
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n || !n.tile) continue;
    out.set(n.tile.tile_index, n.toGather ? n.toGather.tile_index : null);
    for (const c of n.children || []) stack.push(c);
  }
  return out;
}

function nodeRowMap(nodes) {
  // max_gather / depth_gather 的节点快照：tile -> [parent, gatherTurns, value, trunkValue, trunkDistance]
  const out = new Map();
  const stack = [];
  for (const n of nodes || []) stack.push(n);
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n || !n.tile) continue;
    out.set(n.tile.tile_index, [
      n.toGather ? n.toGather.tile_index : null,
      Number(n.gatherTurns) || 0,
      Math.round((Number(n.value) || 0) * 1e6) / 1e6,
      Math.round((Number(n.trunkValue) || 0) * 1e6) / 1e6,
      Number(n.trunkDistance) || 0
    ]);
    for (const c of n.children || []) stack.push(c);
  }
  return out;
}

function main() {
  const dumpFile = process.argv[2];
  const oracleFile = process.argv[3];
  if (!dumpFile || !oracleFile) {
    console.error('用法: node scripts/ekdiff-gathermax.js <dump.jsonl> <gathermax-oracle.json> [-v]');
    process.exit(2);
  }
  const verbose = process.argv.includes('-v');

  const oracleAll = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const oracle = oracleAll.filter((o) => o.kind !== 'pcst');
  if (!Array.isArray(oracle) || oracle.length === 0) throw new Error('oracle 里没有被对拍的条目: ' + oracleFile);

  const byTurn = new Map();
  for (const o of oracle) {
    if (!byTurn.has(o.turn)) byTurn.set(o.turn, []);
    byTurn.get(o.turn).push(o);
  }
  const maxTurn = Math.max.apply(null, oracle.map((o) => o.turn));

  const records = readRecords(dumpFile);
  let startRec = null;
  let firstTurnRec = null;
  for (const r of records) {
    if (r.startData !== undefined && r.data === undefined) startRec = r;
    else if (!firstTurnRec) firstTurnRec = r;
  }
  const startData = startRec ? startRec.startData : {
    playerIndex: 0,
    usernames: ['ek', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'diffgathermax',
    game_type: 'custom',
    options: {}
  };
  const startPacket = startRec ? startRec.data : firstTurnRec.data;
  const map = new EK.Map(startData, startPacket, { shuffle: false });
  map.apply_server_update(startPacket);

  const used = new Set();
  const stats = {};
  let calls = 0;
  let mismatches = 0;
  let printed = 0;

  function bucket(kind, name) {
    const key = kind + '/' + name;
    if (!stats[key]) stats[key] = { calls: 0, bad: 0 };
    return stats[key];
  }

  function note(field, py, js) {
    mismatches++;
    if (printed < 30) {
      printed++;
      console.log('  DIFF ' + field + '\n    py=' + py + '\n    js=' + js);
    }
  }

  function runMaxSet(o, idx) {
    const mm = mapMatrixFromRaw(EK, map, o.value);
    const armyCost = mapMatrixFromRaw(EK, map, o.armyCost);
    const startTiles = o.startTiles.map((i) => map.tiles_by_index[i]);
    const skipTiles = tileSet(map, o.skipTiles);

    const t0 = process.hrtime.bigint();
    let plan = null;
    let err = null;
    try {
      plan = EK.GatherMaxSet.gather_max_set_iterative_plan(
        map, startTiles, o.turns, mm, armyCost, o.targetArmy === undefined ? null : o.targetArmy,
        null, null, null, skipTiles, o.searchingPlayer, null, null, null, null,
        false, true, false, null, null, false, false, null, o.fastMode, false, false,
        o.maximizeValuePerTurn, o.useTrueValueGathered);
    } catch (e) {
      err = e;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const branchStats = EK.GatherMaxSet.last_branch_stats || {};
    let branch = 'none';
    let bestCount = -1;
    for (const k of Object.keys(branchStats)) {
      if (branchStats[k] > bestCount) {
        bestCount = branchStats[k];
        branch = k;
      }
    }
    if (o.out === null || o.out === undefined) branch = 'none';
    const st = bucket('max_set', branch);
    st.calls++;
    calls++;

    const label = 'T' + o.turn + '#' + idx + ' [max_set/' + branch + ']';
    if (err) {
      st.bad++;
      mismatches++;
      if (verbose || printed < 30) {
        printed++;
        console.log('  ' + label + ' JS 抛错: ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
      }
      return;
    }

    const pyOut = o.out;
    if (pyOut === null || pyOut === undefined) {
      if (plan !== null && plan !== undefined) note(label + ' plan', 'null', 'GCP(len=' + plan.length + ')');
      return;
    }
    if (plan === null || plan === undefined) {
      note(label + ' plan', 'GCP(len=' + pyOut.length + ')', 'null');
      st.bad++;
      return;
    }

    let bad = false;
    if (Number(plan.length) !== Number(pyOut.length)) {
      note(label + ' length', pyOut.length, plan.length);
      bad = true;
    }
    const jsTiles = Array.from(plan.tiles()).map((t) => t.tile_index).sort((a, b) => a - b);
    const pyTiles = pyOut.tiles || [];
    if (fmtList(jsTiles, 9999) !== fmtList(pyTiles, 9999)) {
      const onlyPy = pyTiles.filter((t) => jsTiles.indexOf(t) === -1);
      const onlyJs = jsTiles.filter((t) => pyTiles.indexOf(t) === -1);
      note(label + ' tiles', '|' + pyTiles.length + '| -' + fmtList(onlyPy, 8),
        '|' + jsTiles.length + '| -' + fmtList(onlyJs, 8));
      bad = true;
    }
    const jsRoots = rootTreeMap(plan.root_nodes);
    const pyRoots = new Map();
    for (const row of pyOut.roots) pyRoots.set(row[0], row[1]);
    const rootDiffs = [];
    for (const [tile, parent] of pyRoots) {
      if (!jsRoots.has(tile)) rootDiffs.push(tile + ':missing');
      else if (jsRoots.get(tile) !== parent) rootDiffs.push(tile + ':' + parent + '->' + jsRoots.get(tile));
    }
    for (const [tile] of jsRoots) if (!pyRoots.has(tile)) rootDiffs.push(tile + ':extra');
    if (rootDiffs.length > 0) {
      note(label + ' roots', pyRoots.size + ' nodes', jsRoots.size + ' nodes; ' + fmtList(rootDiffs, 8));
      bad = true;
    }
    if (bad) st.bad++;
    else if (verbose) console.log('  ok ' + label + ' len=' + plan.length + ' tiles=' + jsTiles.length + ' ' + ms.toFixed(2) + 'ms');
    if (ms > 200) console.log('  SLOW ' + label + ' ' + ms.toFixed(0) + 'ms');
  }

  function runNodes(o, idx) {
    const ns = EK[JI_KIND[o.kind]];
    const fn = ns && ns[JI_FUNC[o.kind]];
    const label = 'T' + o.turn + '#' + idx + ' [' + o.kind + ']';
    const st = bucket(o.kind, 'all');
    st.calls++;
    calls++;
    if (typeof fn !== 'function') {
      st.bad++;
      mismatches++;
      console.log('  ' + label + ' JS 缺 ' + JI_KIND[o.kind] + '.' + JI_FUNC[o.kind]);
      return;
    }
    // dict 形式的起点带初始距离：py 用 list 时是 tile->0，用 dict 时是 tile->distance
    const startTiles = o.startDist
      ? new Map(o.startTiles.map((i, k) => [map.tiles_by_index[i], o.startDist[k]]))
      : o.startTiles.map((i) => map.tiles_by_index[i]);
    const skipTiles = tileSet(map, o.skipTiles);
    const negativeTiles = tileSet(map, o.negativeTiles);
    const prio = o.priorityMatrix ? mapMatrixFromRaw(EK, map, o.priorityMatrix) : null;
    const distPrio = o.distPriorityMap ? mapMatrixFromRaw(EK, map, o.distPriorityMap) : null;
    const depthPrio = o.depthPriorityMap ? mapMatrixFromRaw(EK, map, o.depthPriorityMap) : null;

    const t0 = process.hrtime.bigint();
    let out = null;
    let err = null;
    try {
      // 两个入口的形参表不一样（depth 版多 depthPriorityMap、pathValueFunc、priorityTiles），
      // 全部按名传，免得位置错位把布尔塞进矩阵参数里。
      out = fn.call(ns, {
        map: map,
        startTiles: startTiles,
        turns: o.turns,
        targetArmy: o.targetArmy === undefined ? null : o.targetArmy,
        negativeTiles: negativeTiles,
        skipTiles: skipTiles,
        searchingPlayer: o.searchingPlayer,
        ignoreStartTile: true,
        incrementBackward: o.incrementBackward,
        preferNeutral: false,
        useTrueValueGathered: o.useTrueValueGathered,
        includeGatherTreeNodesThatGatherNegative: o.includeGatherTreeNodesThatGatherNegative,
        priorityMatrix: prio,
        distPriorityMap: distPrio,
        depthPriorityMap: depthPrio,
        shouldLog: false,
        fastMode: o.fastMode
      });
    } catch (e) {
      err = e;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    if (err) {
      st.bad++;
      mismatches++;
      console.log('  ' + label + ' JS 抛错: ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
      return;
    }
    const pyRows = o.out;
    if (!pyRows) {
      // python 返回空列表/null：JS 也必须空
      if (out && out.length) note(label + ' nodes', '[]', '[' + out.length + ']');
      return;
    }
    const jsRows = nodeRowMap(out);
    const pyMap = new Map();
    for (const row of pyRows) pyMap.set(row[0], [row[1], row[3], row[4], row[5], row[6]]);
    const diffs = [];
    for (const [tile, row] of pyMap) {
      const j = jsRows.get(tile);
      if (!j) { diffs.push(tile + ':missing'); continue; }
      for (let k = 0; k < row.length; k++) {
        if (row[k] !== j[k]) diffs.push(tile + '[' + k + ']' + row[k] + '->' + j[k]);
      }
    }
    for (const [tile] of jsRows) if (!pyMap.has(tile)) diffs.push(tile + ':extra');
    if (diffs.length > 0) {
      note(label + ' nodes', pyMap.size + ' nodes', jsRows.size + ' nodes; ' + fmtList(diffs, 10));
      st.bad++;
    } else if (verbose) {
      console.log('  ok ' + label + ' nodes=' + pyMap.size + ' ' + ms.toFixed(2) + 'ms');
    }
    if (ms > 200) console.log('  SLOW ' + label + ' ' + ms.toFixed(0) + 'ms');
  }

  function runRecord(o, idx) {
    if (o.kind === 'max_set') runMaxSet(o, idx);
    else runNodes(o, idx);
  }

  for (const rec of records) {
    if (rec.startData !== undefined && rec.data === undefined) continue;
    if (rec.err) continue;
    try {
      map.apply_server_update(rec.data);
    } catch (e) {
      console.log('T' + rec.turn + ' 应用服务器数据失败: ' + e.message);
      break;
    }
    const turn = map.turn;
    const list = byTurn.get(turn);
    if (!list) {
      if (turn > maxTurn) break;
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      const key = turn + ':' + i;
      if (used.has(key)) continue;
      used.add(key);
      runRecord(list[i], i);
    }
    if (turn >= maxTurn) break;
  }

  console.log('gather 调用 ' + calls + ' 次，总不一致 ' + mismatches);
  console.log('按 入口/分支 分组:');
  for (const k of Object.keys(stats).sort()) {
    const s = stats[k];
    const ok = s.calls - s.bad;
    console.log('  ' + k.padEnd(20) + ' 调用 ' + String(s.calls).padStart(3) +
      '  不一致 ' + String(s.bad).padStart(3) + '  一致率 ' +
      (s.calls ? ((ok / s.calls) * 100).toFixed(2) : '0.00') + '%');
  }
}

main();
