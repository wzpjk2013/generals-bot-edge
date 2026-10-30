/*
 * ArmyInterceptor 逐字段比对：同一串服务器数据、同一份「合成威胁」（tile 列表直接来自 Python dump），
 * Python 原版跑一遍 get_interception_plan、JS 移植跑一遍，比 chokes / middlest / intercept_options 三层。
 *
 * node scripts/ekdiff-intercept.js _research/ekdump/g5000.jsonl _research/intercept-g5000.json
 *
 * 为什么威胁要从 dump 里读而不是各算各的：威胁生成走的是 DangerAnalyzer，那条链路已经单独校过，
 * 混在一起比就分不清「威胁不同」还是「拦截算错」。
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
require(path.join(ROOT, 'opponenttracker.js'));
require(path.join(ROOT, 'interceptor.js'));
const EK = global.__EK;

function round6(v) {
  return typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
}

function pathDump(p) {
  if (!p) return null;
  return {
    tiles: p.tileList.map((t) => t.tile_index),
    length: p.length,
    tail: p.tail ? p.tail.tile.tile_index : null,
    value: round6(p.value)
  };
}

function chokeDump(chokes) {
  const out = [];
  chokes.forEach((info, tile) => {
    out.push([
      tile.tile_index,
      info.max_delay_turns,
      info.max_extra_moves_to_capture,
      info.max_choke_width,
      info.max_intercept_turn_offset,
      info.max_search_dist
    ]);
  });
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function optionDump(o) {
  return {
    econValue: round6(o.econValue),
    turns: o.turns,
    length: o.length,
    damageBlocked: round6(o.damage_blocked),
    interceptingArmyRemaining: o.intercepting_army_remaining,
    bestCaseInterceptMoves: o.best_case_intercept_moves,
    worstCaseInterceptMoves: o.worst_case_intercept_moves,
    recaptureTurns: o.recapture_turns,
    requiredDelay: o.requiredDelay,
    friendlyArmyReachingIntercept: o.friendly_army_reaching_intercept,
    path: pathDump(o.path)
  };
}

function planDump(plan) {
  if (!plan) return null;
  const options = [];
  const keys = [];
  plan.intercept_options.forEach((_, dist) => keys.push(dist));
  keys.sort((a, b) => a - b);
  for (const dist of keys) options.push([dist, optionDump(plan.intercept_options.get(dist))]);
  const middlest = [];
  plan.middlest_intercept_tiles.forEach((t) => middlest.push(t.tile_index));
  middlest.sort((a, b) => a - b);
  return {
    targetTile: plan.target_tile.tile_index,
    baseThreatArmy: plan.base_threat_army,
    distanceToContestableCity: plan.distance_from_threat_to_contestable_en_city,
    threats: plan.threats.map((t) => pathDump(t.path)),
    ignored: plan.ignored_threats.map((t) => t.path.start.tile.tile_index),
    killThreat: plan.kill_enemy_threat ? pathDump(plan.kill_enemy_threat.threat.path) : null,
    bestThreat: plan.best_enemy_threat ? pathDump(plan.best_enemy_threat.threat.path) : null,
    chokes: chokeDump(plan.common_intercept_chokes),
    middlest: middlest,
    options: options
  };
}

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
    if (py.length !== js.length) {
      sink.push(`${where}.length: py=${py.length} js=${js.length} pyVal=${JSON.stringify(py).slice(0, 200)} jsVal=${JSON.stringify(js).slice(0, 200)}`);
      return;
    }
    for (let i = 0; i < py.length; i++) diffValues(py[i], js[i], `${where}[${i}]`, sink);
    return;
  }
  if (typeof py === 'object') {
    const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
    for (const k of keys) diffValues(py[k], js[k], `${where}.${k}`, sink);
    return;
  }
  if (py !== js) sink.push(`${where}: py=${JSON.stringify(py)} js=${JSON.stringify(js)}`);
}

function buildPathFromTiles(map, tiles) {
  const p = new EK.Path(0);
  p.add_start(map.tiles_by_index[tiles[0]]);
  for (let i = 1; i < tiles.length; i++) p.add_next(map.tiles_by_index[tiles[i]], false);
  return p;
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  if (!jsonl || !oracleFile) {
    console.log('用法: node scripts/ekdiff-intercept.js <replay.jsonl> <intercept-oracle.json>');
    process.exit(1);
  }
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const byTurn = new Map();
  for (const d of oracle.dumps) byTurn.set(d.turn, d);

  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'intercept',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let prevMove = null;
  let total = 0;
  let bad = 0;
  let planTotal = 0;
  let planBad = 0;
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

    const pyDump = byTurn.get(rec.turn);
    if (!pyDump) continue;
    total++;
    if (pyDump.error) {
      bad++;
      if (!firstBad) firstBad = { turn: rec.turn, why: 'python 侧报错', detail: pyDump.error.slice(0, 500) };
      continue;
    }

    const interceptor = new EK.ArmyInterceptor(map, null, false, null);
    const ot = new EK.OpponentTracker(map);
    const groups = pyDump.groups || [];

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      planTotal++;
      let jsPlan;
      try {
        const threats = [];
        for (const ti of group.threatInputs) {
          const p = buildPathFromTiles(map, ti.tiles);
          p.calculate_value(ti.player, map.team_ids_by_player_index);
          const type = ti.type === 'Kill' ? EK.ThreatType.Kill : ti.type === 'Vision' ? EK.ThreatType.Vision : EK.ThreatType.Econ;
          threats.push(new EK.ThreatObj(ti.turns, ti.threatValue, p, type, null, null));
        }
        const plan = interceptor.get_interception_plan(threats, map.remainingCycleTurns, null, ot, null);
        jsPlan = planDump(plan);
      } catch (e) {
        planBad++;
        bad++;
        if (!firstBad) firstBad = { turn: rec.turn, origin: group.origin, why: 'JS 抛异常: ' + e.message, stack: (e.stack || '').slice(0, 1200) };
        continue;
      }

      const sink = [];
      diffValues(group.plan, jsPlan, `T${rec.turn}O${group.origin}`, sink);
      if (sink.length > 0) {
        planBad++;
        if (!firstBad) firstBad = { turn: rec.turn, origin: group.origin, diffs: sink.slice(0, 8) };
        for (const s of sink) {
          const field = s.split(':')[0].replace(/T\d+O\d+/, '').replace(/\[\d+\]/g, '');
          if (!fieldStats[field]) fieldStats[field] = [];
          if (fieldStats[field].length < 4) fieldStats[field].push(s);
        }
      }
    }
  }

  console.log(`回合 ${total}，威胁组 ${planTotal}，不一致 ${planBad}，一致率 ${planTotal ? (((planTotal - planBad) / planTotal) * 100).toFixed(1) : '0.0'}%`);
  for (const k of Object.keys(fieldStats)) {
    console.log(`  ${k}:`);
    for (const s of fieldStats[k]) console.log(`    ${s.slice(0, 400)}`);
  }
  if (firstBad) console.log('首个不一致:', JSON.stringify(firstBad).slice(0, 2500));
}

main();
