/*
 * GatherUtils 逐位比对：同一串服务器数据，Python 原版 Gather/GatherUtils.py 跑一遍做
 * oracle（_research/ekdump_gatherutils.py），JS 移植版（src/eklipz/gatherutils.js）跑
 * 同样的四条链，比树的每个节点 / plan 的每个数值 / 首招与出招序列。
 *
 * node scripts/ekdiff-gatherutils.js _research/ekdump/gm1.jsonl _research/gu-gm1.json
 *
 * 三条严格链：greedy / capmst / plan
 * 两条参考链：pruned（prune_raw_connected_nodes_to_turns__dfs）与 planFromPySteiner —— 后者
 * 的输入用 python 那边 pcst 选出的格子集合，两边同输入，比的仍然是「选格之后」这一层
 * （JS 的 _pcst_greedy 与原版 C++ pcst_fast 选的格子不同，选格那一层天然不可比）。
 *
 * build_capture_mst_from_root_and_contiguous_tiles_old 不比：原版把每个非我方格都当种子塞
 * 进 HeapQueue，种子顺序来自 python set 迭代序，树形本来就不可复现（而且那是死代码）。
 *
 * 另外跑一遍 FastDisjointSet 的 doctest 断言（Algorithms/FastDisjointSet.py 模块
 * docstring 里的例子，pytest --doctest-modules 会执行它们）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
require(path.join(ROOT, 'tile.js'));
require(path.join(ROOT, 'mapmatrix.js'));
require(path.join(ROOT, 'search.js'));
require(path.join(ROOT, 'path.js'));
require(path.join(ROOT, 'map.js'));
require(path.join(ROOT, 'mapmove.js'));
require(path.join(ROOT, 'gather.js'));
require(path.join(ROOT, 'gatherutils.js'));
require(path.join(ROOT, 'fastdisjointset.js'));
const EK = global.__EK;

function sameNum(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return a === b;
}

function sameArr(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (!Array.isArray(a)) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Array.isArray(a[i]) || Array.isArray(b[i])) {
      if (!sameArr(a[i], b[i])) return false;
    } else if (!sameNum(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function moveTuple(m) {
  if (!m) return null;
  return [m.source.tile_index, m.dest.tile_index, m.move_half ? 1 : 0];
}

// 与 GatherTreeNode.iterate_tree_nodes 一致：BFS 序。
function treeRows(rootNodes) {
  const rows = [];
  const q = rootNodes.slice();
  let guard = 0;
  while (q.length) {
    if (++guard > 20000) throw new Error('tree rows infinite loop');
    const cur = q.shift();
    rows.push([
      cur.tile.tile_index,
      cur.toTile === null || cur.toTile === undefined ? -1 : cur.toTile.tile_index,
      cur.value || 0,
      cur.gatherTurns || 0,
      cur.trunkValue || 0,
      cur.trunkDistance || 0,
      cur.children.length
    ]);
    for (const c of cur.children) q.push(c);
  }
  return rows;
}

function round6(v) {
  if (v === null || v === undefined) return v;
  return Math.round(v * 1e6) / 1e6;
}

function planRow(plan) {
  if (!plan) return null;
  return {
    turns: plan._turns,
    econValue: round6(plan._econ_value),
    gathered_army: plan.gathered_army,
    gather_capture_points: round6(plan.gather_capture_points),
    gather_turns: plan.gather_turns,
    friendly_city_count: plan.friendly_city_count || 0,
    enemy_city_count: plan.enemy_city_count || 0,
    tileList: plan.tileList.map((t) => t.tile_index),
    tileSetSorted: Array.from(plan.tileSet, (t) => t.tile_index).sort((a, b) => a - b),
    firstMove: moveTuple(plan.get_first_move()),
    moveList: plan.get_move_list().map(moveTuple),
    tree: treeRows(plan.root_nodes)
  };
}

function checkFastDisjointSet() {
  const FDS = EK.FastDisjointSet;
  const ds = new FDS([1, 2, 3, 'a', 'b']);
  const checks = [];
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    checks.push([name, ok, got, want]);
  };
  t('merge(1,2)', ds.merge(1, 2), true);
  t('merge(3,a)', ds.merge(3, 'a'), true);
  t('merge(a,b)', ds.merge('a', 'b'), true);
  t('merge(b,b)', ds.merge('b', 'b'), false);
  t('ds[2]', ds.find(2), 1);
  t("ds['b']", ds.find('b'), 3);
  t('connected(1,2)', ds.connected(1, 2), true);
  t("connected(1,'b')", ds.connected(1, 'b'), false);
  t('toArray()', ds.toArray(), [1, 2, 3, 'a', 'b']);
  t("subset('a')", Array.from(ds.subset('a')).sort(), [3, 'a', 'b']);
  t("subset_size('a')", ds.subset_size('a'), 3);

  // Sum 变体：值在 add 时抓（valueLookup.raw[tile_index]），merge 时相加。
  // 元素必须是带 tile_index 的 tile 对象，Sum 变体按索引取值。
  const mm = { raw: [10, 20, 30, 40] };
  const fakeTiles = [0, 1, 2, 3].map((i) => ({ tile_index: i }));
  const sum = new EK.FastDisjointTileSetSum(mm, fakeTiles);
  sum.merge(fakeTiles[0], fakeTiles[1]);
  sum.merge(fakeTiles[1], fakeTiles[2]);
  t('sum subset_value', sum.subset_value(fakeTiles[0]), 60);
  t('sum subset_size', sum.subset_size(fakeTiles[0]), 3);

  const bad = checks.filter((c) => !c[1]);
  console.log(`FastDisjointSet 断言 ${checks.length - bad.length}/${checks.length} 通过`);
  for (const b of bad) console.log(`  失败 ${b[0]}: got=${JSON.stringify(b[2])} want=${JSON.stringify(b[3])}`);
  return bad.length === 0;
}

/* 冒充 ArmyAnalyzer：只给 .aMap（从我方将军出发的跳数矩阵）。
 * capture-mst 只用 intergeneral_analysis.aMap.raw 一处当 genDistsRaw。这里必须和
 * python 一样走 map.distance_mapper —— 手写 BFS 在山/中立城上的梯度不一样，
 * 会让「最远格」选出不同起点，后面整棵树都跟着歪。
 */
function generalDistAnalysis(map, general) {
  return { aMap: map.distance_mapper.get_tile_dist_matrix(general) };
}

function firstRowTileIndex(treeRowsPy) {
  return treeRowsPy && treeRowsPy.length ? treeRowsPy[0][0] : null;
}

function connectedFriendlyRegion(map, root, asPlayer) {
  const out = new Set();
  const q = [root];
  while (q.length) {
    const tile = q.pop();
    if (out.has(tile)) continue;
    if (!map.is_tile_on_team_with(tile, asPlayer)) continue;
    out.add(tile);
    for (const adj of tile.movable) {
      if (!out.has(adj) && map.is_tile_on_team_with(adj, asPlayer)) q.push(adj);
    }
  }
  return out;
}

function main() {
  const fdsOk = checkFastDisjointSet();

  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const byTurn = new Map();
  for (const g of oracle.groups) {
    const key = g.turn;
    if (!byTurn.has(key)) byTurn.set(key, g);
  }

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'gatherutils',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let prevMove = null;
  let turnNo = 0;
  let total = 0;
  let bad = 0;
  let skipped = 0;
  const fieldStats = {};
  const worsts = [];

  function note(field, msg) {
    if (!fieldStats[field]) fieldStats[field] = [];
    if (fieldStats[field].length < 4) fieldStats[field].push(msg);
  }

  function cmpArr(field, turn, py, js) {
    if (sameArr(py, js)) return 0;
    let n = 0;
    const len = Math.max((py || []).length, (js || []).length);
    let sample = null;
    for (let i = 0; i < len; i++) {
      if (!sameArr((py || [])[i], (js || [])[i])) {
        n++;
        if (!sample) sample = `#${i} py=${JSON.stringify((py || [])[i])} js=${JSON.stringify((js || [])[i])}`;
      }
    }
    note(field, `T${turn} 差 ${n}/${len}, 首例 ${sample}`);
    return n || 1;
  }

  for (const line of lines) {
    turnNo++;
    const rec = JSON.parse(line);
    if (rec.dump && rec.dump.player !== undefined) startData.playerIndex = rec.dump.player;
    if (rec.startData) startData.playerIndex = rec.startData.playerIndex;
    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      let mis = 0;
      for (let i = 0; i < tileCoords.length; i++) {
        const t = map.tiles_by_index[i];
        if (!t || t.x !== tileCoords[i][0] || t.y !== tileCoords[i][1]) mis++;
      }
      if (mis > 0) console.log(`警告: ${mis}/${tileCoords.length} 个格子索引和 Python 不一致`);
      else console.log(`索引对齐 ok（${tileCoords.length} 格）`);
    } else {
      if (prevMove) {
        const src = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
        const dest = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
        map.last_player_index_submitted_move = [src, dest, !!prevMove[4]];
      } else {
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(rec.data);
    }
    prevMove = rec.move;

    const g = byTurn.get(rec.turn !== undefined ? rec.turn : turnNo);
    if (!g) continue;

    const asPlayer = map.player_index;
    const general = map.generals[asPlayer];
    if (!general) continue;

    const valueMatrix = EK.Gather.build_gather_capture_pure_value_matrix(
      map, asPlayer, null, null, null, false, false, false);

    total++;
    let diffs = 0;
    let firstWhy = null;
    const why = (m) => {
      if (!firstWhy) firstWhy = m;
      diffs++;
    };

    const region = connectedFriendlyRegion(map, general, asPlayer);
    const regionSorted = Array.from(region, (t) => t.tile_index).sort((a, b) => a - b);
    if (cmpArr('region', g.turn, g.regionSorted, regionSorted)) why('友方连通域不一致');

    // 逐格对账：先证明两边回放的是同一帧，否则后面所有差异都没意义
    if (g.armies) {
      const bad = [];
      for (let i = 0; i < g.armies.length; i++) {
        const t = map.tiles_by_index[i];
        const owner = t.player();
        if (t.army !== g.armies[i] || owner !== g.owners[i]) {
          bad.push(`#${i}(${t.x},${t.y}) py=${g.armies[i]}/${g.owners[i]} js=${t.army}/${owner}`);
        }
      }
      if (bad.length) note('state.armies', `T${g.turn} 差 ${bad.length} 格: ${bad.slice(0, 8).join(' ')}`);
    }

    let thickest = null;
    for (const t of region) {
      if (!thickest || t.army > thickest.army || (t.army === thickest.army && t.tile_index < thickest.tile_index)) {
        thickest = t;
      }
    }

    // ---- greedy
    try {
      const startTiles = (!thickest || thickest === general) ? [general] : [general, thickest];
      const res = EK.GatherUtils.greedy_backpack_gather_values(
        map, startTiles, 6, null, null, null, null, null, asPlayer,
        null, null, null, false, false, false, null, null, true, false, false);
      const jsGreedy = { value: round6(res[0]), turns: res[1], tree: treeRows(res[2]) };
      if (!sameNum(g.greedy.value, jsGreedy.value)) {
        note('greedy.value', `T${g.turn} py=${g.greedy.value} js=${jsGreedy.value}`);
        why('greedy 总兵值不一致');
      }
      if (!sameNum(g.greedy.turns, jsGreedy.turns)) {
        note('greedy.turns', `T${g.turn} py=${g.greedy.turns} js=${jsGreedy.turns}`);
        why('greedy 回合数不一致');
      }
      if (cmpArr('greedy.tree', g.turn, g.greedy.tree, jsGreedy.tree)) why('greedy 树不一致');
    } catch (e) {
      note('greedy.throw', `T${g.turn} ${e.message}`);
      why('greedy 抛异常: ' + e.message);
    }

    // ---- capmst / plan / pruned（region 太小时 python 那边也跳过，这里同步跳过）
    if (region.size > 1) {
      const capSet = new Set(g.capSetSorted.map((i) => map.tiles_by_index[i]));
      const genDist = generalDistAnalysis(map, general);

      // capold 不比：原版把每个非我方格都当种子塞进 HeapQueue，种子顺序来自 python
      // set 迭代序，树形本来就不可复现（而且那是死代码，全仓没有调用方）。
      try {
        const forced = firstRowTileIndex(g.capmst && g.capmst.tree);
        const roots = EK.GatherUtils.build_capture_mst_from_root_and_contiguous_tiles(
          map, new Set(capSet), asPlayer, null, null, false, genDist,
          forced === null ? null : map.tiles_by_index[forced]);
        if (cmpArr('capmst.tree', g.turn, g.capmst.tree, treeRows(roots))) why('capmst 树不一致');
      } catch (e) {
        note('capmst.throw', `T${g.turn} ${e.message}`);
        why('capmst 抛异常: ' + e.message);
      }

      try {
        const forcedPlan = firstRowTileIndex(g.plan && g.plan.tree);
        const plan = EK.GatherUtils.convert_contiguous_capture_tiles_to_gather_capture_plan(
          map, new Set([general]), new Set(capSet), null, asPlayer, valueMatrix,
          true, false, true, null, null, null, genDist,
          forcedPlan === null ? null : map.tiles_by_index[forcedPlan]);
        const jsPlan = planRow(plan);
        for (const k of Object.keys(jsPlan)) {
          if (k === 'tree') {
            if (cmpArr('plan.tree', g.turn, g.plan.tree, jsPlan.tree)) why('plan.tree 不一致');
          } else if (!sameArr(g.plan[k], jsPlan[k])) {
            note('plan.' + k, `T${g.turn} py=${JSON.stringify(g.plan[k]).slice(0, 140)} js=${JSON.stringify(jsPlan[k]).slice(0, 140)}`);
            why('plan.' + k + ' 不一致');
          }
        }
      } catch (e) {
        note('plan.throw', `T${g.turn} ${e.message}`);
        why('plan 抛异常: ' + e.message);
      }

      try {
        const tiles = new Set(region);
        EK.Gather.prune_raw_connected_nodes_to_turns__dfs(
          new Set([general]), tiles, 15, asPlayer, valueMatrix, null, false);
        const jsPruned = Array.from(tiles, (t) => t.tile_index).sort((a, b) => a - b);
        if (cmpArr('pruned', g.turn, g.prunedSorted, jsPruned)) why('pruned 集合不一致');
      } catch (e) {
        note('pruned.throw', `T${g.turn} ${e.message}`);
        why('pruned 抛异常: ' + e.message);
      }

      // ---- planFromPySteiner：输入用 python 的 pcst 选格，比「选格之后」这一层
      if (g.approxSteinerSorted) {
        try {
          const steinerSet = new Set(g.approxSteinerSorted.map((i) => map.tiles_by_index[i]));
          const genDist2 = generalDistAnalysis(map, general);
          const forcedSteiner = firstRowTileIndex(g.planFromPySteiner && g.planFromPySteiner.tree);
          const plan = EK.GatherUtils.convert_contiguous_capture_tiles_to_gather_capture_plan(
            map, new Set([general]), steinerSet, null, asPlayer, valueMatrix,
            true, false, true, null, null, null, genDist2,
            forcedSteiner === null ? null : map.tiles_by_index[forcedSteiner]);
          const jsPlan = planRow(plan);
          for (const k of Object.keys(jsPlan)) {
            if (k === 'tree') {
              if (cmpArr('steiner.tree', g.turn, g.planFromPySteiner.tree, jsPlan.tree)) why('steiner 计划树不一致');
            } else if (!sameArr(g.planFromPySteiner[k], jsPlan[k])) {
              note('steiner.' + k, `T${g.turn} py=${JSON.stringify(g.planFromPySteiner[k]).slice(0, 140)} js=${JSON.stringify(jsPlan[k]).slice(0, 140)}`);
              why('steiner.' + k + ' 不一致');
            }
          }
        } catch (e) {
          note('steiner.throw', `T${g.turn} ${e.message}`);
          why('planFromPySteiner 抛异常: ' + e.message);
        }
      }
    } else {
      if (skipped < 3 && process.env.GB_VERBOSE) {
        console.log(`跳过 T${g.turn}: js region=${region.size} player=${asPlayer} general=${general.tile_index} | py player=${g.player} general=${g.general} region=${g.regionSorted && g.regionSorted.length}`);
      }
      skipped++;
      total--;
    }

    if (g.greedy && g.greedy.error) {
      // python 那边该臂就失败了，JS 不该「成功」——上面已按抛出计过，这里只登记。
      skipped++;
    }

    if (diffs > 0) {
      bad++;
      if (worsts.length < 6) worsts.push({ turn: g.turn, why: firstWhy, diffs: diffs });
    }
  }

  console.log(`比对回合 ${total}，跳过 ${skipped}，不一致 ${bad}，一致率 ${(((total - bad) / Math.max(1, total)) * 100).toFixed(1)}%`);
  for (const k of Object.keys(fieldStats)) {
    console.log(`  ${k}:`);
    for (const s of fieldStats[k]) console.log(`    ${s}`);
  }
  if (worsts.length) console.log('前几个不一致:', JSON.stringify(worsts, null, 1));
  if (!fdsOk) process.exitCode = 2;
  if (bad > 0) process.exitCode = 1;
}

main();
