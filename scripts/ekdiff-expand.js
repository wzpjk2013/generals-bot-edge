/*
 * ExpandUtils 逐字段比对：同一串服务器数据，Python 原版跑一遍 get_round_plan_with_expansion、
 * JS 移植跑一遍，比 RoundPlan 的全部对外字段（选中路径、候选路径顺序、tile 序列、
 * move 序列、turns_used、捕获计数、plan_tiles、cumulative_econ_value）。
 *
 * node scripts/ekdiff-expand.js _research/ekdump/g1000b.jsonl _research/exp-g1000b.json
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
require(path.join(ROOT, 'armyanalyzer.js'));
require(path.join(ROOT, 'board.js'));
require(path.join(ROOT, 'territory.js'));
require(path.join(ROOT, 'tileisland.js'));
require(path.join(ROOT, 'gather.js'));
require(path.join(ROOT, 'expandutils.js'));
const EK = global.__EK;

const BIG_TIME = 1e9;

function numEq(a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!isFinite(a) || !isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

function sameList(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function pathJson(p) {
  if (!p) return null;
  const out = { len: p.length, econ: p.econValue };
  try {
    const moves = p.get_move_list();
    out.moves = moves.map((m) => [m.source.tile_index, m.dest.tile_index, !!m.move_half]);
  } catch (e) {
    out.moves = null;
  }
  const tiles = p.tileList
    ? p.tileList
    : Array.from(p.tileSet || []).sort((a, b) => a.tile_index - b.tile_index);
  out.tiles = tiles.map((t) => t.tile_index);
  out.delay = p.requiredDelay || 0;
  return out;
}

function planJson(plan) {
  if (!plan) return null;
  return {
    turnsUsed: plan.turns_used,
    enCaps: plan.en_tiles_captured,
    neutCaps: plan.neut_tiles_captured,
    cumulativeEcon: plan.cumulative_econ_value,
    includesIntercept: plan.includes_intercept,
    planTiles: Array.from(plan.plan_tiles, (t) => t.tile_index).sort((a, b) => a - b),
    selected: pathJson(plan.selected_option),
    paths: plan.all_paths.map(pathJson)
  };
}

function comparePaths(label, py, js, diffs, coords) {
  if ((py === null) !== (js === null)) {
    diffs.push(`${label}: py=${py ? 'path' : 'null'} js=${js ? 'path' : 'null'}`);
    return;
  }
  if (py === null) return;
  if (py.len !== js.len) diffs.push(`${label}.len: py=${py.len} js=${js.len}`);
  if (!numEq(py.econ, js.econ)) diffs.push(`${label}.econ: py=${py.econ} js=${js.econ}`);
  if (py.delay !== js.delay) diffs.push(`${label}.delay: py=${py.delay} js=${js.delay}`);
  if (!sameList(py.tiles, js.tiles)) {
    const head = (arr) => arr.slice(0, 6).map((i) => `${i}(${coords[i] ? coords[i].join(',') : '?'})`).join(' ');
    diffs.push(`${label}.tiles: py=[${head(py.tiles)}] js=[${head(js.tiles)}]`);
  }
  const fm = (m) => (m && m.length ? `${m[0][0]}->${m[0][1]}` : 'none');
  if (py.moves === null || js.moves === null) {
    if ((py.moves === null) !== (js.moves === null)) diffs.push(`${label}.moves: py=${py.moves === null ? 'null' : 'ok'} js=${js.moves === null ? 'null' : 'ok'}`);
    return;
  }
  if (py.moves.length !== js.moves.length) {
    diffs.push(`${label}.moves 条数: py=${py.moves.length} js=${js.moves.length} first ${fm(py.moves)} vs ${fm(js.moves)}`);
    return;
  }
  for (let i = 0; i < py.moves.length; i++) {
    const a = py.moves[i];
    const b = js.moves[i];
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
      diffs.push(`${label}.moves[${i}]: py=${a.join('/')} js=${b.join('/')}`);
      return;
    }
  }
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const byTurn = new Map();
  for (const e of oracle.turns) byTurn.set(e.turn, e);

  let map = null;
  let prevMove = null;
  let territories = null;
  let islands = null;
  let compared = 0;
  let badTurns = 0;
  let fieldDiffs = 0;
  let pyErrors = 0;
  let jsErrors = 0;
  const samples = [];

  for (const line of lines) {
    const rec = JSON.parse(line);
    const startData = rec.startData
      ? JSON.parse(JSON.stringify(rec.startData))
      : {
          playerIndex: 0,
          usernames: ['eklipz_py', 'them'],
          playerColors: ['#111111', '#222222'],
          replay_id: 'expand',
          game_type: 'custom',
          options: {}
        };
    if (rec.dump && rec.dump.player !== undefined) startData.playerIndex = rec.dump.player;

    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      let mis = 0;
      for (let i = 0; i < tileCoords.length; i++) {
        const t = map.tiles_by_index[i];
        if (!t || t.x !== tileCoords[i][0] || t.y !== tileCoords[i][1]) mis++;
      }
      if (mis > 0) console.log(`警告: ${mis}/${tileCoords.length} 个格子索引和 Python 不一致`);
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

    const exp = byTurn.get(rec.turn);
    if (!exp) continue;
    if (exp.error) {
      pyErrors++;
      continue;
    }

    const gen = map.generals[map.player_index];
    const board = new EK.BoardAnalyzer(map, gen, null);
    board.rescan_chokes();

    let enGen = null;
    for (let i = 0; i < rec.dump.generals.length; i++) {
      if (i !== map.player_index && rec.dump.generals[i] >= 0) {
        enGen = map.get_tile_by_tile_index(rec.dump.generals[i]);
        break;
      }
    }
    if (!enGen) {
      const genDist = map.distance_mapper.get_tile_dist_matrix(gen).raw;
      let best = gen.tile_index;
      let bestDist = -1;
      map.tiles_by_index.forEach((t) => {
        if (!map.reachable_tiles.has(t)) return;
        const d = genDist[t.tile_index];
        if (d < 0 || d >= 1000) return;
        if (d > bestDist) {
          bestDist = d;
          best = t.tile_index;
        }
      });
      enGen = map.get_tile_by_tile_index(best);
    }
    board.rebuild_intergeneral_analysis(enGen, null, null);

    if (!territories) territories = new EK.TerritoryClassifier(map);
    territories.scan();

    if (!islands) islands = new EK.TileIslandBuilder(map, board.intergeneral_analysis);
    islands.intergeneral_analysis = board.intergeneral_analysis;
    islands.recalculate_tile_islands(enGen);

    let jsPlan = null;
    let jsError = null;
    try {
      jsPlan = EK.ExpandUtils.get_round_plan_with_expansion(
        map,
        gen.player(),
        exp.targetPlayer,
        exp.turns,
        board,
        territories.territoryMap,
        islands,
        {
          includeExpansionSearch: true,
          negativeTiles: new Set([gen]),
          time_limit: BIG_TIME,
          singleIterationPathTimeCap: BIG_TIME
        }
      );
    } catch (e) {
      jsError = e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e);
      jsErrors++;
    }

    const diffs = [];
    if (jsError) {
      diffs.push(`JS 抛错: ${jsError}`);
    } else {
      const pyPlan = exp.plan;
      const jsP = planJson(jsPlan);
      compared++;
      if (pyPlan.turnsUsed !== jsP.turnsUsed) diffs.push(`turnsUsed: py=${pyPlan.turnsUsed} js=${jsP.turnsUsed}`);
      if (pyPlan.enCaps !== jsP.enCaps) diffs.push(`enCaps: py=${pyPlan.enCaps} js=${jsP.enCaps}`);
      if (pyPlan.neutCaps !== jsP.neutCaps) diffs.push(`neutCaps: py=${pyPlan.neutCaps} js=${jsP.neutCaps}`);
      if (!numEq(pyPlan.cumulativeEcon, jsP.cumulativeEcon)) {
        diffs.push(`cumulativeEcon: py=${pyPlan.cumulativeEcon} js=${jsP.cumulativeEcon}`);
      }
      if (pyPlan.includesIntercept !== jsP.includesIntercept) {
        diffs.push(`includesIntercept: py=${pyPlan.includesIntercept} js=${jsP.includesIntercept}`);
      }
      if (!sameList(pyPlan.planTiles, jsP.planTiles)) {
        diffs.push(`planTiles: py=${pyPlan.planTiles.length} 个 js=${jsP.planTiles.length} 个`);
      }
      comparePaths('selected', pyPlan.selected, jsP.selected, diffs, tileCoords);
      if (pyPlan.paths.length !== jsP.paths.length) {
        diffs.push(`paths 条数: py=${pyPlan.paths.length} js=${jsP.paths.length}`);
      } else {
        for (let i = 0; i < pyPlan.paths.length; i++) {
          comparePaths(`paths[${i}]`, pyPlan.paths[i], jsP.paths[i], diffs, tileCoords);
        }
      }
    }

    if (diffs.length > 0) {
      badTurns++;
      fieldDiffs += diffs.length;
      if (samples.length < 25) samples.push(`T${rec.turn}: ${diffs.slice(0, 3).join(' | ')}`);
    }
  }

  const rate = compared === 0 ? 0 : ((compared - badTurns) / compared) * 100;
  console.log(`回合数 ${byTurn.size}，不一致 ${badTurns}，一致率 ${rate.toFixed(2)}%`);
  if (pyErrors || jsErrors) console.log(`（python 侧错误 ${pyErrors} 回合，js 侧错误 ${jsErrors} 回合）`);
  for (const s of samples) console.log('  ' + s);
  if (badTurns === 0) console.log('全部一致');
}

main();
