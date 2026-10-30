/*
 * OpponentTracker 逐回合逐字段比对：同一串服务器数据回放进 Python 原版和 JS 移植版，
 * 比 cycle stats / team stats / gather queue / 派生读数 / attack timings。
 *
 * node scripts/ekdiff-ot.js _research/ekdump/g1000b.jsonl _research/ot-g1000b.json
 *
 * 顺序必须和 ekdump_ot.py 一致：先 dump 状态再 analyze_turn，否则整体差一回合。
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
require(path.join(ROOT, 'opponenttracker.js'));
const EK = global.__EK;

const CYCLE_FIELDS = [
  'tiles_gained',
  'score_gained',
  'cities_gained',
  'moves_spent_capturing_fog_tiles',
  'moves_spent_capturing_visible_tiles',
  'moves_spent_gathering_fog_tiles',
  'moves_spent_gathering_visible_tiles',
  'moves_spent_gathering_neutral_city_capture',
  'neutral_city_army_spent',
  'approximate_army_gathered_this_cycle',
  'army_annihilated_visible',
  'army_annihilated_fog',
  'army_annihilated_total',
  'approximate_fog_army_available_total',
  'approximate_fog_army_available_total_true',
  'number_assumed_two_expansions_that_may_be_fog_distance',
  'approximate_fog_city_army',
  'fog_city_count'
];

const TEAM_SCORE_FIELDS = [
  'tileCount',
  'score',
  'standingArmy',
  'cityCount',
  'fightingDiff',
  'unexplainedTileDelta',
  'teamId',
  'turn',
  'deserts'
];

const diffCounts = new Map();
let mismatches = 0;
let printed = 0;
let bothThrew = 0;
const bothThrewLogs = [];
const MAX_PRINT = 40;

function record(where, pv, jv) {
  mismatches++;
  const cur = diffCounts.get(where) || 0;
  diffCounts.set(where, cur + 1);
  if (printed < MAX_PRINT) {
    printed++;
    console.log(`  DIFF ${where}\n    py=${JSON.stringify(pv)}\n    js=${JSON.stringify(jv)}`);
  }
}

function eq(pv, jv) {
  if (typeof pv === 'number' && typeof jv === 'number') {
    if (Number.isNaN(pv) && Number.isNaN(jv)) return true;
    return pv === jv;
  }
  return pv === jv;
}

/** 字段级比较：null / 标量 / 数组 / 平面对象 都按同一套规则递归。 */
function cmpValue(where, pv, jv) {
  if (pv === null || pv === undefined || jv === null || jv === undefined) {
    if (!(pv === null || pv === undefined) || !(jv === null || jv === undefined)) record(where, pv, jv);
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
    const sorted = Array.from(keys).sort();
    for (const k of sorted) cmpValue(where + '.' + k, pv[k], jv[k]);
    return;
  }
  if (!eq(pv, jv)) record(where, pv, jv);
}

function teamStatsDict(ts) {
  if (ts === null || ts === undefined) return null;
  const out = {};
  for (const f of TEAM_SCORE_FIELDS) out[f] = ts[f];
  out.teamPlayers = Array.from(ts.teamPlayers || []);
  out.livingPlayers = Array.from(ts.livingPlayers || []);
  return out;
}

function cycleStatsDict(cs) {
  if (cs === null || cs === undefined) return null;
  const out = {};
  for (const f of CYCLE_FIELDS) out[f] = cs[f];
  out.team = cs.team;
  out.players = Array.from(cs.players || []);
  return out;
}

/** python 的 safe(lambda)：抛错就塞成 {error: ...}，两边都抛算一致。 */
function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

function safeCmp(where, oracleVal, fn) {
  const jv = safe(fn);
  const pyErr = oracleVal !== null && typeof oracleVal === 'object' && !Array.isArray(oracleVal) && 'error' in oracleVal;
  const jsErr = jv !== null && typeof jv === 'object' && !Array.isArray(jv) && 'error' in jv;
  if (pyErr || jsErr) {
    // 错误文本肯定不一样，只比"是不是都抛了"。
    if (pyErr !== jsErr) record(where + '.<threw>', pyErr, jsErr);
    else {
      bothThrew++;
      if (bothThrewLogs.length < 5) bothThrewLogs.push(where + ' :: ' + jv.error);
    }
    return;
  }
  cmpValue(where, oracleVal, jv);
}

function sortedPairs(dict) {
  const keys = Object.keys(dict).map(Number);
  keys.sort((a, b) => a - b);
  return keys.map((k) => [k, dict[k]]);
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  if (!jsonl || !oracleFile) {
    console.log('用法: node scripts/ekdiff-ot.js <dump.jsonl> <oracle-ot.json>');
    process.exit(2);
  }

  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'ot',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let ot = null;
  let prevMove = null;
  let checkedTurns = 0;

  for (let li = 0; li < lines.length; li++) {
    const rec = JSON.parse(lines[li]);
    if (li === 0 && rec.dump && rec.dump.player !== undefined) startData.playerIndex = rec.dump.player;

    if (!map) {
      // 构造器内部已经 apply 过一次和 python Map.__init__ 一样，不要再补一次：
      // 补一次会让首包第二次比较时 tileDelta 归零，unexplainedTileDelta 被抹平成 0。
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
      ot = new EK.OpponentTracker(map);
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

    const exp = oracle.turns[checkedTurns];
    if (!exp) {
      console.log(`失败: JS 多出第 ${checkedTurns} 回合（turn ${rec.turn}）`);
      process.exit(1);
    }
    if (exp.turn !== rec.turn) {
      console.log(`失败: 回合对不齐，oracle turn ${exp.turn} vs js turn ${rec.turn}`);
      process.exit(1);
    }

    const where = `t${exp.turn}`;
    const target = map.player_index;

    cmpValue(where + '.playerIndex', exp.playerIndex, target);
    cmpValue(where + '.teamIndexes', exp.teamIndexes, Array.from(ot._team_indexes));

    for (const team of ot._team_indexes) {
      const key = String(team);
      const eTeam = exp.teams[key];
      if (!eTeam) {
        record(where + '.teams.' + key, '<missing>', 'present');
        continue;
      }
      cmpValue(where + '.teams.' + key + '.currentCycle', eTeam.currentCycle, cycleStatsDict(ot.current_team_cycle_stats[team]));
      cmpValue(where + '.teams.' + key + '.currentScore', eTeam.currentScore, teamStatsDict(ot.current_team_scores[team]));
      cmpValue(where + '.teams.' + key + '.lastScore', eTeam.lastScore, teamStatsDict(ot.last_team_scores[team]));
    }

    for (let pi = 0; pi < map.players.length; pi++) {
      const eP = exp.players[String(pi)];
      const jsP = {
        avgTileValue: ot.assumed_player_average_tile_values[pi],
        moveType: ot.last_player_move_type[pi] === null || ot.last_player_move_type[pi] === undefined ? null : ot.last_player_move_type[pi].name,
        gatherQueue: sortedPairs(ot.get_player_gather_queue(pi).get_amount_dict()),
        gatherList: ot.get_player_gather_queue(pi).as_tile_list(),
        fogTileCounts: sortedPairs(ot.get_player_fog_tile_count_dict(pi))
      };
      cmpValue(where + '.players.' + pi, eP, jsP);
    }

    const r = exp.readings;
    safeCmp(where + '.readings.lastCycleEndTurn', r.lastCycleEndTurn, () => ot.get_last_cycle_end_turn());
    safeCmp(where + '.readings.lastCycleEndTurnRaw0', r.lastCycleEndTurnRaw0, () => ot.get_last_cycle_end_turn_raw(0));
    safeCmp(where + '.readings.lastCycleEndTurnRaw1', r.lastCycleEndTurnRaw1, () => ot.get_last_cycle_end_turn_raw(1));
    safeCmp(where + '.readings.cycleIndex', r.cycleIndex, () => ot.get_cycle_index());
    safeCmp(where + '.readings.econRatio', r.econRatio, () => ot.get_current_econ_ratio());
    safeCmp(where + '.readings.winningEconomy', r.winningEconomy, () => ot.winning_on_economy());
    safeCmp(where + '.readings.winningTiles', r.winningTiles, () => ot.winning_on_tiles());
    safeCmp(where + '.readings.winningArmy', r.winningArmy, () => ot.winning_on_army());
    safeCmp(where + '.readings.tileDifferential', r.tileDifferential, () => ot.get_tile_differential());
    safeCmp(where + '.readings.evenCities', r.evenCities, () => ot.even_or_up_on_cities());
    safeCmp(where + '.readings.upOnCities', r.upOnCities, () => ot.up_on_cities());
    safeCmp(where + '.readings.greedyTurnsTarget', r.greedyTurnsTarget, () => ot.get_approximate_greedy_turns_available(target, 5));
    safeCmp(where + '.readings.greedyTurnsOther', r.greedyTurnsOther, () => ot.get_approximate_greedy_turns_available(1 - target, 5));
    safeCmp(where + '.readings.fogRiskTarget', r.fogRiskTarget, () => ot.get_approximate_fog_army_risk(target));
    safeCmp(where + '.readings.fogRiskOther', r.fogRiskOther, () => ot.get_approximate_fog_army_risk(1 - target));
    safeCmp(where + '.readings.maxGenArmyEmergeTarget', r.maxGenArmyEmergeTarget, () =>
      ot.get_max_possible_general_army_after_emergence(target, 10)
    );
    safeCmp(where + '.readings.fogTileDataTarget', r.fogTileDataTarget, () => ot.calculate_team_fog_tile_data(target));
    safeCmp(where + '.readings.fogTileDataOther', r.fogTileDataOther, () => ot.calculate_team_fog_tile_data(1 - target));
    safeCmp(where + '.readings.immediateFogRiskTarget', r.immediateFogRiskTarget, () => ot.get_immediate_fog_risk(target, 10));
    safeCmp(where + '.readings.nextFogCityAmountsTarget', r.nextFogCityAmountsTarget, () => ot.get_next_fog_city_amounts(target, 3));
    safeCmp(where + '.readings.fogCityUsageTarget', r.fogCityUsageTarget, () => ot.estimate_fog_city_usage_count_by_cycle_behavior(target));
    safeCmp(where + '.readings.unknownCityCountTarget', r.unknownCityCountTarget, () => ot.get_team_unknown_city_count_by_player(target));
    safeCmp(where + '.readings.teamAnnihilatedFogTarget', r.teamAnnihilatedFogTarget, () => ot.get_team_annihilated_fog(target));
    safeCmp(where + '.readings.attackedThisRoundTarget', r.attackedThisRoundTarget, () =>
      ot.did_player_already_attack_this_round(target)
    );
    safeCmp(where + '.readings.checkGatherDiff', r.checkGatherDiff, () => ot.check_gather_move_differential(target, 1 - target));
    safeCmp(where + '.readings.predictedAttackTurn', r.predictedAttackTurn, () => ot.get_predicted_attack_turn_by_dist_to_fog(target, 6));

    const jsTimings = {};
    for (let t = 0; t < ot.team_attack_cycle_timings.length; t++) {
      jsTimings[String(t)] = ot.team_attack_cycle_timings[t].map((x) => (x && typeof x.serialize === 'function' ? x.serialize() : String(x)));
    }
    cmpValue(where + '.attackTimings', exp.attackTimings, jsTimings);

    ot.analyze_turn(target);
    checkedTurns++;
  }

  if (checkedTurns !== oracle.turns.length) {
    console.log(`失败: JS 只回放了 ${checkedTurns} 回合，oracle 有 ${oracle.turns.length}`);
    process.exit(1);
  }

  // 两边都抛的读数算"一致"，但必须报出来：全靠抛错对上就是假绿。
  console.log(`两边都抛错的读数: ${bothThrew} 处`);
  for (const line of bothThrewLogs) console.log(`  ${line}`);
  console.log(`回放 ${checkedTurns} 回合，不一致 ${mismatches} 处`);
  if (mismatches > 0) {
    const rows = Array.from(diffCounts.entries()).sort((a, b) => b[1] - a[1]);
    console.log('按字段汇总（最多 40 行）:');
    for (const [k, v] of rows.slice(0, 40)) console.log(`  ${v}\t${k}`);
    process.exit(1);
  }
  console.log('全字段一致');
}

main();
