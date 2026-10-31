/*
 * WatchmanRouteUtils 的 JS 侧 oracle 比对（task-2）。
 *
 * 输入：回放 jsonl + eklump_watchmanroute.py 产出的 JSON
 *   node scripts/ekdiff-watchmanroute.js ..\_research\ekdump\gm1.jsonl ..\_research\watchmanroute-gm1.json
 *
 * 比对方式：逐采样回合把地图重放到「Python dump 那一刻」，再用 Python 侧当回合的
 * 每格状态（player/army/discovered/visible/isTempFogPrediction）覆盖 JS 的地图，
 * 保证两边输入完全一致——移植版引擎还没有迷雾预测写回，不覆盖就比的是上游进度。
 * 然后喂同一组 (startTile, toReveal, targetArmyLevel)：
 *   get_watchman_path + get_revealed_count_and_max_kill_turns_and_positive_path
 * 逐项比：路线 tile 顺序（长度不同单独计数）、revealedCount、max/min/avgKillTurns、
 * positivePath 及其 value。
 *
 * 末两行固定格式：
 *   回合 N，不一致 M，一致率 X%
 *   路径: 完全一致 A，长度不同 B，长度同仅路线不同 C
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
function load(name) {
  require(path.join(REPO, 'src/eklipz', name));
}
load('tile.js');
load('mapmatrix.js');
load('search.js');
load('path.js');
load('map.js');
load('mapmove.js');
load('armyanalyzer.js');
load('board.js');
load('armytracker.js');
load('opponenttracker.js');
load('danger.js');
load('territory.js');
load('watchmanroute.js');

const EK = globalThis.__EK;
const WRP = EK.WatchmanRouteUtils;

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function approx(a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!isFinite(a) || !isFinite(b)) return a === b;
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function applySnapshot(map, snap) {
  const tiles = map.tiles_by_index;
  const n = Math.min(tiles.length, snap.length);
  for (let i = 0; i < n; i++) {
    const s = snap[i];
    const t = tiles[i];
    if (!t) continue;
    if (t.player() !== s[0]) {
      if (typeof t.setPlayer === 'function') t.setPlayer(s[0]);
      else t.player = s[0];
    }
    t.army = s[1];
    t.discovered = !!s[2];
    t.visible = !!s[3];
    t.isTempFogPrediction = !!s[4];
  }
}

function compareTurn(map, exp) {
  const out = { turn: exp.turn, diffs: [], pathKind: null };
  const inp = exp.inputs;
  const expected = exp.output;
  if (!inp || !expected) {
    // 原版这一回合没有可探索目标，属于 skipped，不计入一致率
    out.skipped = true;
    out.diffs.push('skipped (no toReveal / no startArmy)');
    return out;
  }

  applySnapshot(map, exp.snapshot);
  if (exp.flags) {
    map.is_walled_city_game = !!exp.flags.isWalled;
    map.is_low_cost_city_game = !!exp.flags.isLowCost;
  }

  const toReveal = inp.toReveal.map((i) => map.tiles_by_index[i]);
  const startTile = map.tiles_by_index[inp.startTile];

  let path = null;
  try {
    path = WRP.get_watchman_path(map, startTile, toReveal, exp.bigTime || 1e9, -1, true);
  } catch (e) {
    out.diffs.push('get_watchman_path threw: ' + e.message);
    return out;
  }

  const expPath = expected.watchmanPath;
  if ((path === null) !== (expPath === null)) {
    out.diffs.push(`watchmanPath null mismatch py=${expPath === null ? 'null' : 'path'} js=${path === null ? 'null' : 'path'}`);
    return out;
  }

  if (path !== null) {
    const jsTiles = path.tileList.map((t) => t.tile_index);
    const pyTiles = expPath.tiles;
    if (jsTiles.length !== pyTiles.length) {
      out.pathKind = 'len';
      out.diffs.push(`path length py=${pyTiles.length} js=${jsTiles.length}`);
    } else if (jsTiles.join(',') !== pyTiles.join(',')) {
      out.pathKind = 'route';
      out.diffs.push('path route differs (same length)');
    } else {
      out.pathKind = 'exact';
    }

    let res;
    try {
      res = WRP.get_revealed_count_and_max_kill_turns_and_positive_path(
        map,
        path,
        toReveal,
        inp.targetArmyLevel
      );
    } catch (e) {
      out.diffs.push('get_revealed threw: ' + e.message);
      return out;
    }

    if (res.revealedCount !== expected.revealedCount) {
      out.diffs.push(`revealedCount py=${expected.revealedCount} js=${res.revealedCount}`);
    }
    if (!approx(res.maxKillTurns, expected.maxKillTurns)) {
      out.diffs.push(`maxKillTurns py=${expected.maxKillTurns} js=${res.maxKillTurns}`);
    }
    if (!approx(res.minKillTurns, expected.minKillTurns)) {
      out.diffs.push(`minKillTurns py=${expected.minKillTurns} js=${res.minKillTurns}`);
    }
    if (!approx(res.avgKillTurns, expected.avgKillTurns)) {
      out.diffs.push(`avgKillTurns py=${expected.avgKillTurns} js=${res.avgKillTurns}`);
    }

    const jsPos = res.positivePath === null ? null : res.positivePath.tileList.map((t) => t.tile_index);
    const pyPos = expected.positivePath;
    if ((jsPos === null) !== (pyPos === null)) {
      out.diffs.push(`positivePath null mismatch py=${pyPos === null ? 'null' : 'path'} js=${jsPos === null ? 'null' : 'path'}`);
    } else if (jsPos !== null && jsPos.join(',') !== pyPos.join(',')) {
      out.diffs.push(`positivePath route py=${pyPos.length} js=${jsPos.length}`);
    } else if (jsPos !== null && !approx(res.positivePath.value, expected.positivePathValue)) {
      out.diffs.push(`positivePath.value py=${expected.positivePathValue} js=${res.positivePath.value}`);
    }
  }

  return out;
}

function main() {
  const replayPath = process.argv[2];
  const oraclePath = process.argv[3];
  if (!replayPath || !oraclePath) {
    console.log('usage: node scripts/ekdiff-watchmanroute.js <replay.jsonl> <oracle.json>');
    return 2;
  }

  const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
  const recs = readJsonl(replayPath);
  const byTurn = new Map();
  for (const d of oracle.dumps) byTurn.set(d.turn, d);

  const startData = Object.assign(
    {
      playerIndex: 0,
      usernames: ['eklipz_py', 'them'],
      playerColors: ['#111111', '#222222'],
      replay_id: 'watchmanroute',
      game_type: 'custom',
      options: {},
    },
    (recs[0] && recs[0].startData) || {}
  );

  let map = null;
  let prevMove = null;
  const results = [];
  const maxTurn = Math.max(...oracle.dumps.map((d) => d.turn));

  for (const rec of recs) {
    const data = rec.data;
    if (map === null) {
      map = new EK.Map(startData, data, { shuffle: false });
      map.apply_server_update(data);
    } else {
      if (prevMove) {
        const src = map.GetTile(prevMove[0], prevMove[1]);
        const dest = map.GetTile(prevMove[2], prevMove[3]);
        map.last_player_index_submitted_move = [src, dest, !!prevMove[4]];
      } else {
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(data);
    }
    prevMove = rec.move;

    const exp = byTurn.get(map.turn);
    if (exp) {
      const r = compareTurn(map, Object.assign({ bigTime: oracle.bigTime }, exp));
      if (r.skipped) {
        console.log(`turn ${r.turn}: skipped (oracle 无目标)`);
        continue;
      }
      results.push(r);
      if (r.diffs.length > 0) {
        console.log(`turn ${r.turn}: ${r.diffs.join(' | ')}`);
      }
    }

    if (map.turn >= maxTurn) break;
  }

  const bad = results.filter((r) => r.diffs.length > 0).length;
  const checked = results.length;
  const rate = checked === 0 ? 0 : ((checked - bad) / checked) * 100;
  const kinds = { exact: 0, len: 0, route: 0 };
  for (const r of results) if (r.pathKind) kinds[r.pathKind] += 1;
  console.log(`回合 ${checked}，不一致 ${bad}，一致率 ${rate.toFixed(2)}%`);
  console.log(`路径: 完全一致 ${kinds.exact}，长度不同 ${kinds.len}，长度同仅路线不同 ${kinds.route}`);
  return bad === 0 ? 0 : 1;
}

process.exit(main());
