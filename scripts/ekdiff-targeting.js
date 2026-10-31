/*
 * BotTargeting 的 JS ↔ Python 逐字段比对。
 *
 * 用法：
 *   node scripts/ekdiff-targeting.js <replay.jsonl> <targeting-oracle.json>
 *
 * 数据来源：_research/ekdump_targeting.py 用真正的 EklipZBot 跑完整局，每 N 回合
 * dump BotTargeting 每个入口的输入摘要 + 返回值。这个脚本用 JS 侧的 EK.BotTargeting
 * 在同一份回放、同一回合上把同样的入口再算一遍，逐字段比。
 *
 * 为了让两边的输入一致，JS 侧的 bot 门面必须自己搭起来（armyTracker 逐回合喂、
 * territory 每回合重扫、board_analysis 建 intergeneral_analysis）。targetPlayer 和
 * targetPlayerExpectedGeneralLocation 直接取 oracle state 里的值 —— 它们本身也是
 * BotTargeting 算出来的，但在这里当「已知输入」，否则一处上游漂移会把所有下游入口
 * 一起带偏，看不出真正坏在哪。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
[
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'armyanalyzer',
  'board', 'armytracker', 'danger', 'opponenttracker', 'pathing', 'repetition',
  'statequeries', 'territory', 'interceptor', 'defense', 'targeting'
].forEach((m) => require(path.join(ROOT, m + '.js')));

const EK = global.__EK;
const BT = EK.BotTargeting;

function round6(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
}

function diffValues(py, js, where, sink) {
  if (sink.length >= 20) return;
  const pyNull = py === null || py === undefined;
  const jsNull = js === null || js === undefined;
  if (pyNull && jsNull) return;
  if (pyNull || jsNull) {
    sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
    return;
  }
  if (typeof py === 'number' && typeof js === 'number') {
    if (round6(py) !== round6(js)) sink.push(`${where}: py=${py} js=${js}`);
    return;
  }
  if (Array.isArray(py) || Array.isArray(js)) {
    if (!Array.isArray(py) || !Array.isArray(js)) {
      sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
      return;
    }
    if (py.length !== js.length) sink.push(`${where}.length: py=${py.length} js=${js.length}`);
    const n = Math.min(py.length, js.length);
    for (let i = 0; i < n && sink.length < 20; i++) diffValues(py[i], js[i], `${where}[${i}]`, sink);
    return;
  }
  if (typeof py === 'object' && typeof js === 'object') {
    const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
    for (const k of Array.from(keys).sort()) {
      if (sink.length >= 20) return;
      diffValues(py[k], js[k], `${where}.${k}`, sink);
    }
    return;
  }
  if (py !== js) sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
}

function tileByIndex(map, idx) {
  if (idx === null || idx === undefined || idx < 0) return null;
  return map.get_tile_by_tile_index(idx);
}

function pathDump(p) {
  if (p === null || p === undefined) return null;
  return {
    tiles: p.tileList.map((t) => t.tile_index),
    length: p.length,
    tail: p.tail.tile.tile_index,
    value: round6(p.value)
  };
}

function gridDigest(mm) {
  const raw = mm.raw;
  let total = 0;
  const peaks = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v === 'number') {
      total += v;
      peaks.push([i, v]);
    }
  }
  peaks.sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  return { sum: round6(total), peaks: peaks.slice(0, 12).map(([i, v]) => [i, round6(v)]) };
}

function tilesDump(arr, limit) {
  const out = [];
  for (let i = 0; i < arr.length && out.length < limit; i++) {
    const t = arr[i];
    out.push(t === null || t === undefined ? null : t.tile_index);
  }
  return out;
}

function safe(name, fn, out) {
  try {
    out[name] = fn();
  } catch (e) {
    out[name] = { error: String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ') };
  }
}

function main() {
  const replayPath = process.argv[2];
  const oraclePath = process.argv[3];
  if (!replayPath || !oraclePath) {
    console.error('usage: node scripts/ekdiff-targeting.js <replay.jsonl> <targeting-oracle.json>');
    return 2;
  }

  const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
  const byTurn = new Map();
  for (const d of oracle.dumps) byTurn.set(d.turn, d);

  const lines = fs.readFileSync(replayPath, 'utf8').split('\n').filter((l) => l.trim());
  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'targeting',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let ot = null;
  let at = null;
  let territories = null;
  let boardAnalysis = null;
  let prevMove = null;

  /** contest_data 必须整局累积：get_contested_targets 读的是历史交战记录 */
  const contest_data = new Map();

  let turnsCompared = 0;
  let turnsWithDiff = 0;
  const fieldCounts = new Map();
  const samples = [];
  let firstBad = null;

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (map === null) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      ot = new EK.OpponentTracker(map);
      at = new EK.ArmyTracker(map, null, ot);
      territories = new EK.TerritoryClassifier(map);
    } else {
      if (prevMove) {
        const src = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
        const dest = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
        map.last_player_index_submitted_move = src && dest ? [src, dest, !!prevMove[4]] : null;
      } else {
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(rec.data);
    }
    const lastMove = prevMove;
    prevMove = rec.move;

    ot.analyze_turn(-1);
    let moveObj = null;
    if (lastMove) {
      const s = map.get_tile_by_tile_index(lastMove[1] * map.cols + lastMove[0]);
      const d = map.get_tile_by_tile_index(lastMove[3] * map.cols + lastMove[2]);
      if (s && d) moveObj = new EK.Move(s, d, !!lastMove[4]);
    }
    try {
      at.update(moveObj, map.turn, null);
    } catch (e) {
      // tracker 出问题不该静默：这条记下来，diff 结果里会体现成一整片不一致
      console.error('armyTracker.update threw at turn ' + map.turn + ': ' + e.message);
    }
    territories.scan();

    const oracleEntry = byTurn.get(map.turn);
    if (!oracleEntry) continue;

    const pyState = oracleEntry.targeting.state;
    const general = map.generals[map.player_index];
    const targetPlayer = pyState.targetPlayer;
    const expectedGeneral = tileByIndex(map, pyState.expectedGeneral);

    boardAnalysis = new EK.BoardAnalyzer(map, general, null);
    if (expectedGeneral) {
      try {
        boardAnalysis.rebuild_intergeneral_analysis(expectedGeneral, null, []);
      } catch (e) {
        boardAnalysis = null;
      }
    }

    const bot = {
      _map: map,
      map: map,
      general: general,
      armyTracker: at,
      opponent_tracker: ot,
      territories: territories,
      board_analysis: boardAnalysis,
      targetPlayer: targetPlayer,
      targetPlayerObj: targetPlayer === -1 ? null : map.players[targetPlayer],
      targetPlayerExpectedGeneralLocation: expectedGeneral,
      generalApproximations: [],
      teammate_general: null,
      teammate_path: null,
      launchPoints: [],
      locked_launch_point: null,
      contest_data: contest_data,
      // 原版 bot 在 init 阶段就把将军距离场挂到 _gen_distances；distance_from_general
      // 靠它算「离将军多远」，不挂就全返回 0，会把所有距离筛选判成全近。
      _gen_distances: map.distance_mapper.get_tile_dist_matrix(general),
      _ally_distances: null,
      leafMoves: (oracleEntry.targeting.leafMoves || [])
        .filter((mv) => Array.isArray(mv))
        .map((mv) => {
          const s = tileByIndex(map, mv[0]);
          const d = tileByIndex(map, mv[1]);
          return s && d ? new EK.Move(s, d, false) : null;
        })
        .filter(Boolean),
      player: map.players[map.player_index],
      enemyCities: (oracleEntry.targeting.enemyCities || [])
        .map((i) => tileByIndex(map, i))
        .filter(Boolean),
      armyTracker_visible_tiles_by_player: null,
      playerTargetScores: null,
      info_render_general_undiscovered_prediction_values: false
    };

    const js = {};
    safe('afkPlayers', () => BT.get_afk_players(bot).map((p) => p.index), js);
    safe('moreTeamsAliveThan3', () => (BT.are_more_teams_alive_than(bot, 3) ? 1 : 0), js);
    safe('safeBfsDepth', () => BT.get_safe_per_tile_bfs_depth(bot), js);
    safe('medianTileValue', () => BT.get_median_tile_value(bot, 50, -1), js);
    safe('isFfa', () => (BT.is_ffa_situation(bot) ? 1 : 0), js);
    safe('distToEnemyAtGeneral', () => round6(BT.getDistToEnemy(bot, general)), js);
    safe('spawnCramped', () => (BT.is_player_spawn_cramped(bot) ? 1 : 0), js);
    safe('contestedTargets', () => BT.get_contested_targets(bot).map((c) => c.tile.tile_index), js);
    safe('calculateTargetPlayer', () => BT.calculate_target_player(bot), js);
    safe('targetScores', () => (bot.playerTargetScores || []).map((v) => (v === null ? null : round6(v))), js);
    safe('possibleGeneralTiles', () => tilesDump(
      BT.get_target_player_possible_general_location_tiles_sorted(bot), 40), js);
    safe('possibleGeneralTilesNoElim', () => tilesDump(
      BT.get_target_player_possible_general_location_tiles_sorted(bot, 0, -2, 0.333, false, 12), 40), js);
    safe('maxExplorableUndiscovered', () => {
      const t = BT.get_max_explorable_undiscovered_tile(bot, at.min_spawn_distance);
      return t === null || t === undefined ? null : t.tile_index;
    }, js);
    safe('expected1v1Grid', () => gridDigest(
      BT.find_expected_1v1_general_location_on_undiscovered_map(
        bot, BT.get_safe_per_tile_bfs_depth(bot), at.min_spawn_distance)), js);
    safe('hackySpawnApprox', () => {
      const t = BT.find_hacky_path_to_find_target_player_spawn_approx(bot, at.min_spawn_distance);
      return t === null || t === undefined ? null : t.tile_index;
    }, js);
    if (targetPlayer !== -1) {
      safe('furthestApart', () => BT._get_furthest_apart_3_enemy_general_locations(bot, targetPlayer)[0]
        .map((t) => t.tile_index), js);
    }
    safe('predictedGeneral', () => {
      const t = BT.get_predicted_target_player_general_location(bot);
      return t === null || t === undefined ? null : t.tile_index;
    }, js);
    safe('predictedGeneralSkipFilter', () => {
      const t = BT.get_predicted_target_player_general_location(bot, true);
      return t === null || t === undefined ? null : t.tile_index;
    }, js);
    safe('pathToTargetPlayer', () => pathDump(BT.get_path_to_target_player(bot)), js);
    safe('pathToTargetPlayerAllIn', () => pathDump(BT.get_path_to_target_player(bot, true, 9)), js);
    safe('incrementAttackCounts', () => {
      const before = bot.contest_data.size;
      BT.increment_attack_counts(bot, general);
      const cd = bot.contest_data.get(general);
      return {
        contestDataSizeBefore: before,
        contestDataSizeAfter: bot.contest_data.size,
        attackedCount: cd ? cd.attacked_count : null,
        lastAttackedTurn: cd ? cd.last_attacked_turn : null
      };
    }, js);

    turnsCompared += 1;
    const py = oracleEntry.targeting;
    const sink = [];
    const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
    for (const k of Array.from(keys).sort()) {
      if (k === 'state') continue;
      if (k === 'flankPath' || k === 'launchPoint2v2') continue;
      diffValues(py[k], js[k], k, sink);
    }
    if (sink.length > 0) {
      turnsWithDiff += 1;
      for (const s of sink) {
        const field = s.split(':')[0].split('.')[0];
        fieldCounts.set(field, (fieldCounts.get(field) || 0) + 1);
      }
      if (samples.length < 6) samples.push({ turn: map.turn, diffs: sink.slice(0, 6) });
      if (firstBad === null) firstBad = { turn: map.turn, py, js };
    }
  }

  console.log(`回放 ${path.basename(replayPath)}  oracle ${path.basename(oraclePath)}`);
  console.log(`比对回合 ${turnsCompared}，不一致 ${turnsWithDiff}，一致率 ` +
    `${turnsCompared ? (((turnsCompared - turnsWithDiff) / turnsCompared) * 100).toFixed(1) : '0.0'}%`);
  if (fieldCounts.size > 0) {
    console.log('按字段聚合差异：');
    const sorted = Array.from(fieldCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [f, c] of sorted) console.log(`  ${f}: ${c} 条`);
    for (const s of samples) {
      console.log(`  --- turn ${s.turn}`);
      for (const d of s.diffs) console.log(`      ${d}`);
    }
  }
  if (firstBad) {
    fs.writeFileSync(path.join(__dirname, '..', '..', '_research', 'targeting-firstbad.json'),
      JSON.stringify(firstBad, null, 1));
  }
  return 0;
}

process.exit(main());
