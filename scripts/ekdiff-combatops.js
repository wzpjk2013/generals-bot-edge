/*
 * BotCombatOps 逐字段比对：同一个服务器数据串，Python 原版跑一遍、JS 移植跑一遍，
 * 比每个入口的返回值。输入（采样格 / 注入的 bot 状态 / 威胁路径）全部取自 Python dump，
 * 保证两边喂的是同一份东西，差异只可能来自 BotCombatOps 本身。
 *
 * node scripts/ekdiff-combatops.js _research/ekdump/g1000b.jsonl _research/combatops-py1000b.json
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
require(path.join(ROOT, 'danger.js'));
require(path.join(ROOT, 'pathing.js'));
require(path.join(ROOT, 'statequeries.js'));
require(path.join(ROOT, 'repetition.js'));
require(path.join(ROOT, 'defense.js'));
require(path.join(ROOT, 'board.js'));
require(path.join(ROOT, 'territory.js'));
require(path.join(ROOT, 'city.js'));
require(path.join(ROOT, 'combatops.js'));
const EK = global.__EK;

const R6 = 1e6;

function round6(v) {
  return typeof v === 'number' ? Math.round(v * R6) / R6 : v;
}

// 逐层比对，报出「哪个字段 / 哪个格子」不一致，而不是只知道整体不同
function diffValues(py, js, where, sink) {
  if (sink.length >= 20) return;
  if (py === null || py === undefined) {
    if (js !== null && js !== undefined) sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
    return;
  }
  if (js === null || js === undefined) {
    sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
    return;
  }
  if (Array.isArray(py) || Array.isArray(js)) {
    if (!Array.isArray(py) || !Array.isArray(js)) {
      sink.push(`${where}: 一边是数组 py=${typeof py} js=${typeof js}`);
      return;
    }
    if (py.length !== js.length) sink.push(`${where}.length: py=${py.length} js=${js.length}`);
    const n = Math.min(py.length, js.length);
    for (let i = 0; i < n; i++) diffValues(py[i], js[i], `${where}[${i}]`, sink);
    return;
  }
  if (typeof py === 'object') {
    const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
    for (const k of keys) diffValues(py[k], js[k], `${where}.${k}`, sink);
    return;
  }
  if (typeof py === 'number' && typeof js === 'number') {
    if (Math.abs(round6(py) - round6(js)) > 1e-6) sink.push(`${where}: py=${py} js=${js}`);
    return;
  }
  if (py !== js) sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
}

function tileAt(map, idx) {
  if (idx === null || idx === undefined) return null;
  return map.get_tile_by_tile_index(idx);
}

function buildPath(map, indices) {
  const p = new EK.Path();
  for (const i of indices) p.add_next(tileAt(map, i));
  return p;
}

function pathIndices(p) {
  if (!p) return null;
  return p.tileList.map((t) => t.tile_index);
}

function makeBot(map, pyDump, territories) {
  const bot = {
    _map: map,
    map: map,
    info: function () {},
    viewInfo: null,
    perf_timer: { begin_move_event: function () { return { enter: function () {}, exit: function () {} }; } },
    timings: {
      cycleTurns: 50,
      offsetTurns: 0,
      launchTiming: 0,
      get_turns_left_in_cycle: function (turn) { return 50 - (turn % 50); },
      get_turn_in_cycle: function (turn) { return turn % 50; },
      in_launch_timing: function () { return true; }
    },
    armyTracker: { armies: new Map(), player_targets: [], tiles_ever_owned_by_player: new Map() },
    cached_scrims: {},
    targetingArmy: null,
    curPath: null,
    gatherNodes: [],
    territories: territories,
    general: tileAt(map, pyDump.general),
    player: map.players[map.player_index],
    targetPlayer: pyDump.targetPlayer,
    targetPlayerObj: pyDump.targetPlayer >= 0 ? map.players[pyDump.targetPlayer] : null,
    targetPlayerExpectedGeneralLocation: tileAt(map, pyDump.genLoc),
    target_player_gather_path: buildPath(map, pyDump.gather),
    target_player_gather_targets: pyDump.targets.map((i) => tileAt(map, i)),
    alt_en_gen_positions: {},
    largeTilesNearEnemyKings: new Map(),
    is_all_in_losing: false,
    all_in_losing_counter: 0,
    is_all_in_army_advantage: false,
    all_in_army_advantage_counter: 0,
    all_in_city_behind: false,
    is_winning_gather_cyclic: false,
    lastTimingFactor: -1,
    lastTimingTurn: -1,
    lastTargetAttackTurn: Math.max(0, pyDump.turn - 10),
    is_weird_custom: false,
    force_far_gathers: false,
    giving_up_counter: 0,
    teammate_general: null,
    flanking: false,
    shortest_path_to_target_player: buildPath(map, pyDump.gather),
    has_defenseless_modifier: false,
    surrender_func: null,
    cityAnalyzer: {
      enemy_contested_cities: new Set(),
      owned_contested_cities: new Set()
    },
    get_army_at: function (tile) {
      return {
        tile: tile,
        player: tile.player(),
        value: tile.army - 1,
        expectedPaths: [],
        name: 'stub'
      };
    }
  };

  for (const k of Object.keys(pyDump.altGen)) {
    bot.alt_en_gen_positions[Number(k)] = pyDump.altGen[k].map((i) => tileAt(map, i));
  }
  for (const pair of pyDump.largeKings) {
    bot.largeTilesNearEnemyKings.set(tileAt(map, pair[0]), pair[1].map((i) => tileAt(map, i)));
  }

  return bot;
}

function moveDump(move) {
  if (!move) return null;
  return [move.source.tile_index, move.dest.tile_index, !!move.move_half];
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));

  const byTurn = new Map();
  for (const d of oracle) byTurn.set(d.turn, d);

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'combatops',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let prevMove = null;
  let total = 0;
  let bad = 0;
  let skipped = 0;
  const fieldStats = {};
  let firstBad = null;

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.dump && rec.dump.player !== undefined && startData.playerIndex !== rec.dump.player) {
      startData.playerIndex = rec.dump.player;
    }
    if (!map) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
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

    const pyDump = byTurn.get(rec.turn);
    if (!pyDump) continue;
    total++;
    if (pyDump.error) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: 'python 侧报错' };
      continue;
    }

    let jsRes;
    try {
      const territories = new EK.TerritoryClassifier(map);
      territories.scan();
      const bot = makeBot(map, pyDump, territories);
      const samples = pyDump.samples.map((i) => tileAt(map, i));

      jsRes = {
        should_kill: samples.map((t) => [t.tile_index, !!EK.BotCombatOps.should_kill(bot, t)]),
        just_moved: samples.map((t) => [t.tile_index, !!EK.BotCombatOps.just_moved(bot, t)]),
        sum_enemy_army_near_tile: samples.map((t) => [
          t.tile_index, EK.BotCombatOps.sum_enemy_army_near_tile(bot, t, 2)]),
        sum_player_army_near_tile: samples.map((t) => [
          t.tile_index, EK.BotCombatOps.sum_player_army_near_tile(bot, t, 2, map.player_index)]),
        sum_friendly_army_near_tile: samples.map((t) => [
          t.tile_index, EK.BotCombatOps.sum_friendly_army_near_tile(bot, t, 2, map.player_index)]),
        sum_friendly_army_near_or_on_tiles: samples.map((t) => [
          t.tile_index, EK.BotCombatOps.sum_friendly_army_near_or_on_tiles(bot, [t], 3, map.player_index)]),
        sum_player_standing_army_near_or_on_tiles: samples.map((t) => [
          t.tile_index, EK.BotCombatOps.sum_player_standing_army_near_or_on_tiles(bot, [t], 3, map.player_index)]),
        count_enemy_tiles_near_tile: samples.map((t) => [
          t.tile_index, EK.BotCombatOps.count_enemy_tiles_near_tile(bot, t, 3)]),
        count_enemy_territory_near_tile: samples.map((t) => [
          t.tile_index, EK.BotCombatOps.count_enemy_territory_near_tile(bot, t, 3)]),
        find_large_tiles_near: samples.slice(0, 2).map((t) => EK.BotCombatOps.find_large_tiles_near(
          bot, [t], 12, { forPlayer: map.player_index, allowGeneral: true, limit: 5, minArmy: 10 }
        ).map((x) => x.tile_index)),
        determine_should_winning_all_in: !!EK.BotCombatOps.determine_should_winning_all_in(bot),
        worth_attacking_target: !!EK.BotCombatOps.worth_attacking_target(bot),
        worth_attacking_target_state: [bot.lastTimingFactor, bot.lastTimingTurn],
        check_should_be_all_in_losing: !!EK.BotCombatOps.check_should_be_all_in_losing(bot),
        all_in_state: [bot.is_all_in_losing, bot.all_in_losing_counter, bot.giving_up_counter],
        kill_enemy_path: null,
        check_for_attack_launch_move: null
      };

      if (pyDump.threatPath) {
        const threatPath = buildPath(map, pyDump.threatPath);
        jsRes.kill_enemy_path = pathIndices(EK.BotCombatOps.kill_enemy_path(bot, threatPath, false));
      }

      jsRes.check_for_attack_launch_move = moveDump(
        EK.BotCombatOps.check_for_attack_launch_move(bot, new Set()));

      jsRes.scale = [0, 7, 24, 25, 26, 40, 50, 63].map((v) => [
        EK.BotCombatOps.scale(v, 0, 50, 0, 0.4),
        EK.BotCombatOps.scale(v, 25, 50, 0.3, 0)
      ]);
    } catch (e) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: 'JS 抛异常: ' + e.message + '\n' + (e.stack || '') };
      continue;
    }

    // kill_enemy_paths 走到「用别处兵力拦截威胁路径」时依赖 BotDefense.get_gather_to_threat_paths，
    // 那个函数在 defense.js 里是故意留空的（原版它要 Gather + DangerAnalyzer + 拦截器整套）。
    // Python 侧因此抛 AttributeError、JS 侧按约定返回 null —— 这种条目是**已知未覆盖**，
    // 既不算通过也不算失败，单独计数，避免把「没有实现」混进一致率里。
    if (pyDump.res && pyDump.res.kill_enemy_path && pyDump.res.kill_enemy_path.error) {
      skipped++;
      delete pyDump.res.kill_enemy_path;
      delete jsRes.kill_enemy_path;
    }

    const sink = [];
    diffValues(pyDump.res, jsRes, `T${rec.turn}`, sink);
    if (sink.length > 0) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, diffs: sink.slice(0, 8) };
      for (const s of sink) {
        const field = s.split(':')[0].replace(/\[\d+\]/g, '');
        if (!fieldStats[field]) fieldStats[field] = [];
        if (fieldStats[field].length < 4) fieldStats[field].push(s);
      }
    }
  }

  console.log(`回合总数 ${total}，不一致 ${bad}，一致率 ${(((total - bad) / total) * 100).toFixed(1)}%`);
  if (skipped > 0) {
    console.log(`  另有 ${skipped} 条 kill_enemy_path 属已知未覆盖（BotDefense.get_gather_to_threat_paths 未移植），未计入一致率`);
  }
  for (const k of Object.keys(fieldStats)) {
    console.log(`  ${k}:`);
    for (const line2 of fieldStats[k]) console.log(`    ${line2.slice(0, 300)}`);
  }
  if (firstBad) console.log('首个不一致:', JSON.stringify(firstBad).slice(0, 3000));
}

main();
