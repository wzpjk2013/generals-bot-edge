/*
 * expectedGen 对拍：拿 eklump_expectedgen.py 的 oracle，在 JS 侧重放同一份回放，
 * 逐回合对齐「预期敌方将军位置」这条链上的每一个中间量。
 *
 *   node scripts/ekdiff-expectedgen.js ..\_research\ekdump\gm1.jsonl ..\_research\expectedgen-gm1.json
 *
 * 为什么比中间量而不是只比最终位置：最终位置错可能是 armytracker 的候选将军位错了，
 * 也可能是候选对了但打分/取值错了。分字段看第一个错的那个，才知道该改哪。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { EkBot } = require('./ekjs.js');

function readJsonl(p) {
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function num(v) {
  return typeof v === 'number' ? v : v === null || v === undefined ? null : Number(v);
}

function eq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}

function eqArr(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
  return true;
}

function eqPairs(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i][0], b[i][0]) || !eq(a[i][1], b[i][1])) return false;
  }
  return true;
}

function cmpScalar(diff, field, py, js) {
  if (!eq(num(py), num(js))) diff.push({ field, py: py === undefined ? null : py, js: js === undefined ? null : js });
}

function cmpList(diff, field, py, js) {
  if (!eqArr(py || [], js || [])) diff.push({ field, py: py || [], js: js || [], kind: 'list' });
}

function cmpPairs(diff, field, py, js) {
  if (!eqPairs(py || [], js || [])) diff.push({ field, py: py || [], js: js || [], kind: 'pairs' });
}

/* ---- JS 侧取同一批量 ---- */
function dumpJs(bot, map) {
  // EkBot 包装类自己持有 map（bot 对象上不一定有），统一由调用方传进来
  map = map || bot.map || bot._map;
  const at = bot.armyTracker;
  const ot = bot.opponent_tracker;
  const out = { state: {}, validGenPos: {}, validGenPosCount: {}, uneliminatedEmergenceEvents: {}, emergenceLocationMap: {}, opTracker: {}, maxExplorable: {}, expected1v1Grid: null, predictedAgain: null };

  const safe = (fn, dflt) => {
    try {
      return fn();
    } catch (e) {
      return dflt === undefined ? { error: String((e && e.message) || e) } : dflt;
    }
  };

  const gen = bot.general;
  out.state = {
    turn: map.turn,
    targetPlayer: bot.targetPlayer,
    general: gen ? gen.tile_index : null,
    generals: (map.generals || []).map((g) => (g ? g.tile_index : null)),
    minSpawnDistance: at.min_spawn_distance,
    expectedGeneral: bot.targetPlayerExpectedGeneralLocation ? bot.targetPlayerExpectedGeneralLocation.tile_index : null,
    safeBfsDepth: safe(() => EK().BotTargeting.get_safe_per_tile_bfs_depth(bot), null)
  };

  const nPlayers = map.players.length;
  for (let p = 0; p < nPlayers; p++) {
    const mat = at.valid_general_positions_by_player[p];
    const idxs = [];
    if (mat && mat.raw) for (let i = 0; i < mat.raw.length; i++) if (mat.raw[i]) idxs.push(i);
    out.validGenPos[String(p)] = idxs;
    out.validGenPosCount[String(p)] = idxs.length;

    const unelim = at.uneliminated_emergence_events[p];
    const rows = [];
    if (unelim && typeof unelim.forEach === 'function') {
      unelim.forEach((v, t) => rows.push([t.tile_index, v]));
      rows.sort((x, y) => x[0] - y[0]);
    }
    out.uneliminatedEmergenceEvents[String(p)] = rows;

    const em = at.emergenceLocationMap && at.emergenceLocationMap[p];
    const erows = [];
    if (em && em.raw) {
      for (let i = 0; i < em.raw.length; i++) if (em.raw[i]) erows.push([i, Math.round(em.raw[i] * 1e6) / 1e6]);
    }
    out.emergenceLocationMap[String(p)] = erows;
  }

  out.opTracker = safe(() => {
    const d = { unknownCityCount: {}, fogArmyRisk: {}, maxPossibleGenArmyAfterEmergence0: {} };
    for (let p = 0; p < nPlayers; p++) {
      d.unknownCityCount[String(p)] = typeof ot.get_team_unknown_city_count_by_player === 'function'
        ? ot.get_team_unknown_city_count_by_player(p) : null;
      d.fogArmyRisk[String(p)] = typeof ot.get_approximate_fog_army_risk === 'function'
        ? ot.get_approximate_fog_army_risk(p) : null;
      d.maxPossibleGenArmyAfterEmergence0[String(p)] = typeof ot.get_max_possible_general_army_after_emergence === 'function'
        ? ot.get_max_possible_general_army_after_emergence(p, 0) : null;
    }
    return d;
  }, {});

  // 这一步会重算（或复用本回合已算好的）undiscovered_priorities —— 全链路第二个可对拍点
  out.maxExplorable = safe(() => {
    const depth = EK().BotTargeting.get_safe_per_tile_bfs_depth(bot);
    const msd = at.min_spawn_distance;
    const picked = EK().BotTargeting.get_max_explorable_undiscovered_tile(bot, msd);
    const prio = bot.undiscovered_priorities;
    const d = { depth, minSpawnDistance: msd, result: picked ? picked.tile_index : null };
    if (prio && prio.raw) {
      const top = [];
      for (let i = 0; i < prio.raw.length; i++) if (prio.raw[i]) top.push([prio.raw[i], i]);
      top.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
      d.top = top.slice(0, 12).map(([v, i]) => [i, Math.round(v * 1e6) / 1e6]);
      if (picked) d.valueAtResult = Math.round(prio.raw[picked.tile_index] * 1e6) / 1e6;
    }
    return d;
  }, {});

  out.predictedAgain = safe(
    () => {
      const t = EK().BotTargeting.get_predicted_target_player_general_location(bot);
      return t ? t.tile_index : null;
    },
    null
  );
  return out;
}

let _EK = null;
function EK() {
  if (!_EK) _EK = global.__EK;
  return _EK;
}

/*
 * GB_EG_FIXGUARD=1：把 botmain.js:1019-1021 的第三个守卫从
 *「valid_general_positions_by_player[targetPlayer][expected]」换成 `.has(expected)`。
 * 原写法拿 Tile 对象去索引 MapMatrixSet —— JS 侧没有 __getitem__，取到 undefined，
 * `!undefined` 恒真，于是每回合都重算；Python 的 MapMatrixSet.__getitem__ 会折成 raw[tile_index]。
 * 这个开关只为验证这一点，不改 src。
 */
function installGuardFix() {
  const P = EK().Bot.prototype;
  P._refresh_expected_general_location = function () {
    const expected = this.targetPlayerExpectedGeneralLocation;
    const genPred = () => {
      const t = EK().BotTargeting.get_predicted_target_player_general_location(this);
      return t || null;
    };
    if (expected === null || expected === undefined) {
      const predicted = genPred();
      if (predicted) {
        this.targetPlayerExpectedGeneralLocation = predicted;
        this.recalculate_player_paths(true);
      } else {
        this.targetPlayerExpectedGeneralLocation = this.general;
      }
      return;
    }
    if (expected.visible && !expected.isGeneral) {
      const predicted = genPred();
      if (predicted && predicted !== expected) {
        this.targetPlayerExpectedGeneralLocation = predicted;
        this.recalculate_player_paths(true);
      }
      return;
    }
    const mat = this.armyTracker.valid_general_positions_by_player &&
      this.armyTracker.valid_general_positions_by_player[this.targetPlayer];
    if (this.targetPlayer !== -1 && mat && !mat.has(expected)) {
      const predicted = genPred();
      if (predicted) {
        this.targetPlayerExpectedGeneralLocation = predicted;
        this.recalculate_player_paths(true);
      }
      return;
    }
    if (this.shortest_path_to_target_player === null) this.recalculate_player_paths(true);
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.log('usage: node scripts/ekdiff-expectedgen.js <replay.jsonl> <oracle.json>');
    process.exit(2);
  }
  const recs = readJsonl(argv[0]);
  const oracle = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  const byTurn = new Map();
  for (const d of oracle.dumps) if (!byTurn.has(d.turn)) byTurn.set(d.turn, d);

  // 索引对齐自检：两边 tile_index 必须指同一格
  const firstOracle = oracle.dumps[0];
  if (firstOracle && firstOracle.state && firstOracle.state.generals) {
    // 只做长度级校验，具体对齐在 state.general 上逐回合比
    if (firstOracle.state.generals.length !== 2) console.log('WARN: oracle generals 长度异常');
  }

  const startData = {
    playerIndex: 0,
    usernames: ['ekjs', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'ekdiff_expectedgen',
    game_type: 'custom',
    options: {}
  };

  const ek = new EkBot();
  ek.start(startData, recs[0].data);
  if (process.env.GB_EG_FIXGUARD === '1') {
    installGuardFix();
    console.log('（已启用 GB_EG_FIXGUARD：守卫改 .has(expected)）');
  }

  let prevMove = recs[0].move || null;
  let turnCount = 0;
  let badTurns = 0;
  let fieldDiffs = 0;
  const diffCounts = {};
  const firstTurnByField = {};
  const firstSampleByField = {};
  const firstBad = [];

  for (let i = 1; i < recs.length; i++) {
    const rec = recs[i];
    const mp = ek.map;
    if (prevMove) {
      const src = mp.GetTile(prevMove[0], prevMove[1]);
      const dest = mp.GetTile(prevMove[2], prevMove[3]);
      mp.last_player_index_submitted_move = [src, dest, !!prevMove[4]];
    } else {
      mp.last_player_index_submitted_move = null;
    }
    prevMove = rec.move || null;

    ek.turn(rec.data);
    turnCount++;

    const py = byTurn.get(ek.map.turn);
    if (!py) continue;
    const js = dumpJs(ek.bot, ek.map);

    const diff = [];
    cmpScalar(diff, 'state.general', py.state.general, js.state.general);
    cmpScalar(diff, 'state.targetPlayer', py.state.targetPlayer, js.state.targetPlayer);
    cmpScalar(diff, 'state.minSpawnDistance', py.state.minSpawnDistance, js.state.minSpawnDistance);
    cmpScalar(diff, 'state.safeBfsDepth', py.state.safeBfsDepth, js.state.safeBfsDepth);
    cmpScalar(diff, 'state.expectedGeneral', py.state.expectedGeneral, js.state.expectedGeneral);
    cmpScalar(diff, 'maxExplorable.result', py.maxExplorable.result, js.maxExplorable.result);
    cmpScalar(diff, 'maxExplorable.valueAtResult', py.maxExplorable.valueAtResult, js.maxExplorable.valueAtResult);
    cmpScalar(diff, 'predictedAgain', py.predictedAgain, js.predictedAgain);

    const players = Object.keys(py.validGenPos || {});
    for (const p of players) {
      cmpList(diff, 'validGenPos.' + p, py.validGenPos[p], js.validGenPos[p]);
      cmpPairs(diff, 'unelimEmergence.' + p, py.uneliminatedEmergenceEvents[p], js.uneliminatedEmergenceEvents[p]);
      cmpPairs(diff, 'emergenceLocMap.' + p, py.emergenceLocationMap[p], js.emergenceLocationMap[p]);
    }
    const otPy = py.opTracker || {};
    const otJs = js.opTracker || {};
    for (const p of players) {
      cmpScalar(diff, 'ot.unknownCityCount.' + p,
        otPy.unknownCityCount && otPy.unknownCityCount[p], otJs.unknownCityCount && otJs.unknownCityCount[p]);
      cmpScalar(diff, 'ot.fogArmyRisk.' + p,
        otPy.fogArmyRisk && otPy.fogArmyRisk[p], otJs.fogArmyRisk && otJs.fogArmyRisk[p]);
      cmpScalar(diff, 'ot.maxPossibleGenArmy.' + p,
        otPy.maxPossibleGenArmyAfterEmergence0 && otPy.maxPossibleGenArmyAfterEmergence0[p],
        otJs.maxPossibleGenArmyAfterEmergence0 && otJs.maxPossibleGenArmyAfterEmergence0[p]);
    }
    if (py.maxExplorable && py.maxExplorable.top && js.maxExplorable.top) {
      cmpPairs(diff, 'maxExplorable.top', py.maxExplorable.top, js.maxExplorable.top);
    }

    if (diff.length) {
      badTurns++;
      fieldDiffs += diff.length;
      for (const d of diff) {
        diffCounts[d.field] = (diffCounts[d.field] || 0) + 1;
        if (firstTurnByField[d.field] === undefined) {
          firstTurnByField[d.field] = ek.map.turn;
          firstSampleByField[d.field] = d;
        }
      }
      if (firstBad.length < 3) firstBad.push({ turn: ek.map.turn, diff: diff.slice(0, 6) });
    }
  }

  for (const fb of firstBad) {
    console.log('--- 首错回合 t=' + fb.turn);
    for (const d of fb.diff) {
      const shrink = (v) => {
        if (Array.isArray(v)) return '[' + v.length + '] ' + JSON.stringify(v.slice(0, 8));
        return JSON.stringify(v);
      };
      console.log('  ' + d.field + '\n    py=' + shrink(d.py) + '\n    js=' + shrink(d.js));
    }
  }

  const rate = turnCount ? ((turnCount - badTurns) / turnCount) * 100 : 0;
  console.log('--- 每个字段首个错的回合（按回合升序）');
  const ordered = Object.keys(firstTurnByField).sort((a, b) => firstTurnByField[a] - firstTurnByField[b]);
  for (const f of ordered) {
    const s = firstSampleByField[f];
    let extra = '';
    if (s && s.kind === 'list') extra = ' py=' + s.py.length + '项 js=' + s.js.length + '项';
    else if (s && s.kind === 'pairs') extra = ' py=' + JSON.stringify(s.py.slice(0, 4)) + ' js=' + JSON.stringify(s.js.slice(0, 4));
    else if (s) extra = ' py=' + JSON.stringify(s.py) + ' js=' + JSON.stringify(s.js);
    console.log('  t=' + firstTurnByField[f] + '  ' + f + extra);
  }
  console.log('回合数 ' + turnCount + '，不一致回合 ' + badTurns + '，字段级差异 ' + fieldDiffs);
  console.log('字段分布：' + JSON.stringify(diffCounts));
  console.log('不一致 ' + badTurns + '，一致率 ' + rate.toFixed(1) + '%');
}

main();
