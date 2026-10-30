/*
 * CityAnalyzer 逐字段比对：同一串服务器数据，Python 原版跑一遍、JS 移植跑一遍，
 * 比 neutral/enemy 分数序列（顺序 + 14 个字段）、三个城市集合、cities_in_play、
 * large_neutral_negatives、is_contested 判定，以及沼泽图的可达性矩阵。
 *
 * node scripts/ekdiff-city.js _research/ekdump/cA.jsonl _research/city_py_cA.json
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
require(path.join(ROOT, 'city.js'));
const EK = global.__EK;

// 浮点按 1e-9 相对容差比：两边都是 float64，正常应逐位相等，留着容差只为
// 区分“运算次序不同”和“语义不同”。
function numEq(a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!isFinite(a) || !isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

function flattenMatrix(matrix, map) {
  const out = [];
  for (let i = 0; i < map.rows * map.cols; i++) out.push(matrix.raw[i]);
  return out;
}

function sameList(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function main() {
  const jsonl = process.argv[2];
  const oracleFile = process.argv[3];
  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  const tileCoords = oracle.tileCoords;

  const byTurn = new Map();
  for (const e of oracle.turns) byTurn.set(e.turn, e);

  const FIELD_COUNT = 14;
  let map = null;
  let prevMove = null;
  let totalCities = 0;
  let badTurns = 0;
  let fieldDiffs = 0;
  const samples = [];

  for (const line of lines) {
    const rec = JSON.parse(line);
    const startData = rec.startData
      ? JSON.parse(JSON.stringify(rec.startData))
      : {
          playerIndex: 0,
          usernames: ['eklipz_py', 'them'],
          playerColors: ['#111111', '#222222'],
          replay_id: 'city',
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

    const exp = byTurn.get(rec.turn);
    if (!exp) continue;
    if (exp.error) continue;

    const gen = map.generals[map.player_index];
    const board = new EK.BoardAnalyzer(map, gen, null);
    board.rescan_chokes();

    // 敌将不可见时的退化规则必须和 oracle 完全一致
    let enGen = null;
    for (let i = 0; i < rec.dump.generals.length; i++) {
      if (i !== map.player_index && rec.dump.generals[i] >= 0) {
        enGen = map.get_tile_by_tile_index(rec.dump.generals[i]);
        break;
      }
    }
    if (!enGen) {
      const genDist = map.distance_mapper.get_tile_dist_matrix(gen).raw;
      let best = -1;
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

    const ca = new EK.CityAnalyzer(map, gen);
    // 和 oracle 同规则：tile_index 最小的中立城
    ca.last_targeted_neut_city = map.tiles_by_index.find((t) => t.isCity && t.player() === -1) || null;
    ca.re_scan(board);

    const diffs = [];

    for (const key of ['neutral', 'enemy']) {
      const pyro = exp[key];
      const jsro = (key === 'neutral' ? ca.get_sorted_neutral_scores() : ca.get_sorted_enemy_scores()).map(
        (pair) => pair[1].to_list(pair[0])
      );
      totalCities += pyro.length;
      if (pyro.length !== jsro.length) {
        diffs.push(`${key}: 行数 py=${pyro.length} js=${jsro.length}`);
        continue;
      }
      for (let i = 0; i < pyro.length; i++) {
        const p = pyro[i];
        const j = jsro[i];
        if (p[0] !== j[0]) {
          const tp = tileCoords[p[0]];
          const tj = tileCoords[j[0]];
          diffs.push(`${key}[${i}]: 顺序不同 py=(${tp})#${p[0]} js=(${tj})#${j[0]}`);
          continue;
        }
        for (let f = 0; f < FIELD_COUNT; f++) {
          if (!numEq(p[f + 1], j[f + 1])) {
            const t = tileCoords[p[0]];
            diffs.push(
              `${key}[${i}] (${t[0]},${t[1]}) ${EK.city.CityScoreFields[f]}: py=${p[f + 1]} js=${j[f + 1]}`
            );
            break;
          }
        }
      }
    }

    const setOf = (s) => Array.from(s, (t) => t.tile_index).sort((a, b) => a - b);
    const compares = [
      ['playerCities', setOf(new Set(ca.player_city_scores.keys()))],
      ['citiesInPlay', setOf(ca.cities_in_play)],
      ['ownedContested', setOf(ca.owned_contested_cities)],
      ['enemyContested', setOf(ca.enemy_contested_cities)],
      ['largeNegatives', setOf(ca.large_neutral_negatives)]
    ];
    for (const [name, jsVal] of compares) {
      if (!sameList(exp[name], jsVal)) {
        const a = exp[name].slice(0, 8).join(',');
        const b = jsVal.slice(0, 8).join(',');
        diffs.push(`${name}: py=[${a}] js=[${b}]`);
      }
    }

    if (exp.contested) {
      const jsContested = [];
      map.tiles_by_index.forEach((t) => {
        if (t.isCity && t.isNeutral) jsContested.push([t.tile_index, ca.is_contested(t) ? 1 : 0]);
      });
      if (jsContested.length !== exp.contested.length) {
        diffs.push(`contested: 行数 py=${exp.contested.length} js=${jsContested.length}`);
      } else {
        for (let i = 0; i < jsContested.length; i++) {
          if (jsContested[i][0] !== exp.contested[i][0] || jsContested[i][1] !== exp.contested[i][1]) {
            const t = tileCoords[jsContested[i][0]];
            diffs.push(
              `contested (${t[0]},${t[1]}): py=${exp.contested[i][1]} js=${jsContested[i][1]}`
            );
          }
        }
      }
    }

    if (exp.reachability) {
      if (ca.reachability_costs_matrix === null) {
        diffs.push('reachability: py 有矩阵，js 为 null');
      } else {
        const jsReach = flattenMatrix(ca.reachability_costs_matrix, map);
        for (let i = 0; i < exp.reachability.length; i++) {
          if (exp.reachability[i] !== jsReach[i]) {
            const t = tileCoords[i];
            diffs.push(`reachability (${t[0]},${t[1]}): py=${exp.reachability[i]} js=${jsReach[i]}`);
            break;
          }
        }
        const jsFrom = [];
        for (let i = 0; i < map.rows * map.cols; i++) {
          const v = ca.reachable_from_matrix.raw[i];
          jsFrom.push(v === null || v === undefined ? null : v.tile_index);
        }
        for (let i = 0; i < exp.reachableFrom.length; i++) {
          if (exp.reachableFrom[i] !== jsFrom[i]) {
            const t = tileCoords[i];
            diffs.push(`reachableFrom (${t[0]},${t[1]}): py=${exp.reachableFrom[i]} js=${jsFrom[i]}`);
            break;
          }
        }
      }
    }

    // ensure_reachability_matrix_built 的沼泽分支在真实回放里永远走不到
    // （apply_server_update 每回合清空 map.swamps），所以这里照 oracle 的做法
    // 手动还原沼泽集合后直接比对 build_reachability_cost_map_matrix 的输出。
    if (exp.extraReach) {
      const swampIdxs = (rec.startData && rec.startData.swamps) || [];
      for (const i of swampIdxs) {
        const t = map.tiles_by_index[i];
        t.isSwamp = true;
        map.swamps.add(t);
      }
      const built = EK.city.build_reachability_cost_map_matrix(map, [gen]);
      for (let i = 0; i < exp.extraReach.length; i++) {
        if (exp.extraReach[i] !== built.costMap.raw[i]) {
          const t = tileCoords[i];
          diffs.push(`extraReach (${t[0]},${t[1]}): py=${exp.extraReach[i]} js=${built.costMap.raw[i]}`);
          break;
        }
      }
      for (let i = 0; i < exp.extraThrough.length; i++) {
        const v = built.throughMap.raw[i];
        const jsThrough = v === null || v === undefined ? null : v.tile_index;
        if (exp.extraThrough[i] !== jsThrough) {
          const t = tileCoords[i];
          diffs.push(`extraThrough (${t[0]},${t[1]}): py=${exp.extraThrough[i]} js=${jsThrough}`);
          break;
        }
      }
      map.swamps.clear();
    }

    if (diffs.length > 0) {
      badTurns++;
      fieldDiffs += diffs.length;
      if (samples.length < 25) samples.push(`T${rec.turn}: ${diffs.slice(0, 4).join(' | ')}`);
    }
  }

  console.log(`回合数 ${byTurn.size}，城市分数行总数 ${totalCities}，不一致回合 ${badTurns}，字段级差异 ${fieldDiffs}`);
  for (const s of samples) console.log('  ' + s);
  if (badTurns === 0) console.log('全部一致');
}

main();
