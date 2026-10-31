/*
 * EarlyExpandUtils 逐回合比对：同一串服务器数据回放进 Python 原版和 JS 移植版，
 * 比 optimize_first_25 / get_start_expand_captures / __evaluate_plan_value / recalculate_max_plan
 * 的返回结构（路径用 tile_index 序列，保序；浮点原样比）。
 *
 * node scripts/ekdiff-earlyexpand.js _research/ekdump/g1000b.jsonl _research/ee-g1000b.json
 *
 * 两侧都不给时间预算（Python 的 perf_counter 被冻在 0，JS 的 nowSeconds 恒 0），
 * 所以搜索跑满、结果确定。
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
require(path.join(ROOT, 'earlyexpandutils.js'));
const EK = global.__EK;
const EEU = EK.EarlyExpandUtils;

let mismatches = 0;
let printed = 0;
const MAX_PRINT = 30;
const diffCounts = new Map();

function record(where, pv, jv) {
  mismatches++;
  diffCounts.set(where, (diffCounts.get(where) || 0) + 1);
  if (printed < MAX_PRINT) {
    printed++;
    const fmt = (v) => {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s.length > 220 ? s.slice(0, 220) + '…' : s;
    };
    console.log(`  DIFF ${where}\n    py=${fmt(pv)}\n    js=${fmt(jv)}`);
  }
}

function cmpValue(where, pv, jv) {
  if (pv === null || pv === undefined || jv === null || jv === undefined) {
    const pyNull = pv === null || pv === undefined;
    const jsNull = jv === null || jv === undefined;
    if (pyNull !== jsNull) record(where, pv, jv);
    return;
  }
  if (Array.isArray(pv) || Array.isArray(jv)) {
    if (!Array.isArray(pv) || !Array.isArray(jv)) return record(where, pv, jv);
    if (pv.length !== jv.length) return record(where + '.length', pv.length, jv.length);
    for (let i = 0; i < pv.length; i++) cmpValue(where + '[' + i + ']', pv[i], jv[i]);
    return;
  }
  if (typeof pv === 'object' || typeof jv === 'object') {
    if (typeof pv !== 'object' || typeof jv !== 'object') return record(where, pv, jv);
    const keys = new Set(Object.keys(pv).concat(Object.keys(jv)));
    for (const k of Array.from(keys).sort()) cmpValue(where + '.' + k, pv[k], jv[k]);
    return;
  }
  if (pv !== jv) record(where, pv, jv);
}

function planToObj(plan) {
  if (!plan) return null;
  return {
    captures: plan.tile_captures,
    launchTurn: plan.launch_turn,
    core: plan.core_tile === null || plan.core_tile === undefined ? null : plan.core_tile.tile_index,
    paths: plan.plan_paths.map((p) => (p === null || p === undefined ? null : p.tileList.map((t) => t.tile_index))),
    intendedDeserts: Array.from(plan.intended_deserts || [])
      .map((t) => t.tile_index)
      .sort((a, b) => a - b),
  };
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  if (!jsonl || !oracleFile) {
    console.log('用法: node scripts/ekdiff-earlyexpand.js <dump.jsonl> <ee-*.json>');
    process.exit(2);
  }

  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'ee',
    game_type: 'custom',
    options: {},
  };

  let map = null;
  let prevMove = null;
  let checked = 0;

  for (let li = 0; li < lines.length; li++) {
    const rec = JSON.parse(lines[li]);
    if (li === 0 && rec.dump && rec.dump.player !== undefined) startData.playerIndex = rec.dump.player;

    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      let mis = 0;
      for (let i = 0; i < tileCoords.length; i++) {
        const t = map.tiles_by_index[i];
        if (!t || t.x !== tileCoords[i][0] || t.y !== tileCoords[i][1]) mis++;
      }
      if (tileCoords.length !== map.tiles_by_index.length) {
        console.log(`失败: tiles_by_index 长度 ${map.tiles_by_index.length} != python ${tileCoords.length}`);
        process.exit(1);
      }
      if (mis > 0) {
        console.log(`失败: ${mis}/${tileCoords.length} 个格子索引和 Python 不一致，逐格比对无意义`);
        process.exit(1);
      }
      console.log(`索引对齐 ok（${tileCoords.length} 格）`);
    } else {
      if (prevMove) {
        const srcTile = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
        const destTile = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
        map.last_player_index_submitted_move = [srcTile, destTile, !!prevMove[4]];
      } else {
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(rec.data);
    }
    prevMove = rec.move;

    const exp = oracle.turns[checked];
    if (!exp) {
      // oracle 只跑到某个回合时，剩下的不再比（正常只在调试时发生）
      break;
    }
    if (exp.turn !== rec.turn) {
      console.log(`失败: 回合对不齐，oracle turn ${exp.turn} vs js turn ${rec.turn}`);
      process.exit(1);
    }

    const where = `t${exp.turn}`;
    const player = map.player_index;
    const general = map.generals[player];
    const genArmy = general.army;
    const distToGen = map.distance_mapper.get_tile_dist_matrix(general);

    cmpValue(where + '.gen', exp.gen, general.tile_index);
    cmpValue(where + '.genArmy', exp.genArmy, genArmy);

    const ownTiles = map.players[general.player()].tiles;
    cmpValue(where + '.ownTiles', exp.ownTiles, ownTiles.length);

    const alreadyOwned = new Set();
    for (const t of ownTiles) {
      if (t.isCity || t.isGeneral || t.army <= 1) alreadyOwned.add(t);
    }
    cmpValue(where + '.alreadyOwned', exp.alreadyOwned, alreadyOwned.size);

    if (exp.opt25 && exp.opt25.ok === false) {
      record(where + '.opt25', exp.opt25.error, '<js-ran>');
      checked++;
      continue;
    }

    const plan = EEU.optimize_first_25(map, general, distToGen, null, false, null, false, null, null, false, false);
    cmpValue(where + '.opt25', exp.opt25, planToObj(plan));

    if (plan) {
      const gsec = EEU.get_start_expand_captures(map, general, genArmy, map.turn, plan.plan_paths, alreadyOwned, -1, false);
      cmpValue(where + '.gsec', exp.gsec && exp.gsec.ok ? exp.gsec.value : null, gsec);

      const ev = EEU._evaluate_plan_value(map, general, genArmy, map.turn, plan.plan_paths, distToGen, distToGen, alreadyOwned);
      cmpValue(where + '.evalv', exp.evalv && exp.evalv.ok ? exp.evalv.value : null, [ev[0], ev[1], ev[2], ev[3]]);

      const altPaths = plan.plan_paths.slice();
      for (let i = altPaths.length - 1; i >= 0; i--) {
        if (altPaths[i] !== null && altPaths[i] !== undefined) {
          altPaths.splice(i, 1);
          break;
        }
      }
      const altPlan = new EEU.CityExpansionPlan(0, altPaths, plan.launch_turn, plan.core_tile);
      const chosen = EEU.recalculate_max_plan(plan, altPlan, map, distToGen, distToGen, alreadyOwned);
      cmpValue(where + '.recalc', exp.recalc, {
        result: chosen === plan ? 'plan1' : 'plan2',
        caps1: plan.tile_captures,
        caps2: altPlan.tile_captures,
      });
    }

    checked++;
  }

  const totalCells = checked * 8;
  const rate = totalCells === 0 ? 100 : ((totalCells - mismatches) / totalCells) * 100;
  console.log('');
  if (diffCounts.size > 0) {
    console.log('差异分布:');
    for (const k of Array.from(diffCounts.keys()).sort()) console.log(`  ${k}: ${diffCounts.get(k)}`);
  }
  console.log(`回合 ${checked}，不一致 ${mismatches}，一致率 ${rate.toFixed(4)}%`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main();
