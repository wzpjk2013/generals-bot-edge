/*
 * BotCityOps 逐字段比对：同一串服务器数据，Python 原版跑一遍（_research/ekdump_cityops.py）、
 * JS 移植跑一遍，比每个入口的输出。
 *
 * node scripts/ekdiff-cityops.js _research/ekdump/cA.jsonl _research/cityops-cA.json
 *
 * 比的是「纯决策」入口（见 eklump_cityops.py 文件头）：ensure_reachability_matrix_built /
 * find_neutral_city_path / should_proactively_take_cities / should_rapid_capture_neutral_cities /
 * _check_should_wait_city_capture / did_player_just_take_fog_city，外加两边的城市清单与
 * 占位最短路径，用来证明「输入一致」——不然比出来的 null==null 没有信息量。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const E = require(path.join(__dirname, 'ekjs.js'));
E.loadEK();
const EK = global.__EK;

function numEq(a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!isFinite(a) || !isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

function sameList(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* 等代价的绕路（同样长度、同样终点、只是先横后竖/先竖后横）说明的是搜索堆的 tie-break
 * 不一样，不是决策不一样。分开计数，免得把它们和真正的差异混成一个数字。 */
function classifyPathDiff(py, js) {
  if (js === null || js === undefined) return 'null';
  if (py.length !== js.length) return 'len';
  if (py[py.length - 1] !== js[js.length - 1]) return 'endpoint';
  const a = py.slice().sort((x, y) => x - y).join(',');
  const b = js.slice().sort((x, y) => x - y).join(',');
  return a === b ? 'order' : 'route';
}

function pathTiles(p) {
  if (!p) return null;
  return Array.from(p.tileList, (t) => t.tile_index);
}

/* 与 Python greedy_sp 同一算法：每步走将军距离更大的邻格，平手取 tile_index 更小 */
function greedySp(map, general, enGen, maxLen) {
  const dist = map.distance_mapper.get_tile_dist_matrix(general).raw;
  const p = new EK.Path();
  p.add_next(general);
  const seen = new Set([general]);
  let cur = general;
  while (seen.size < maxLen) {
    let best = null;
    let bestKey = null;
    for (const adj of cur.movable) {
      if (seen.has(adj) || adj.isObstacle) continue;
      const key0 = -dist[adj.tile_index];
      if (bestKey === null || key0 < bestKey[0] || (key0 === bestKey[0] && adj.tile_index < bestKey[1])) {
        bestKey = [key0, adj.tile_index];
        best = adj;
      }
    }
    if (!best) break;
    p.add_next(best);
    seen.add(best);
    cur = best;
    if (best === enGen) break;
  }
  return p;
}

function main() {
  const replayPath = process.argv[2];
  const oraclePath = process.argv[3];
  if (!replayPath || !oraclePath) {
    console.error('usage: node scripts/ekdiff-cityops.js <replay.jsonl> <cityops-oracle.json>');
    return 2;
  }

  const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
  const tileCoords = oracle.tileCoords;
  const byTurn = new Map();
  for (const t of oracle.turns) byTurn.set(t.turn, t);

  const lines = fs.readFileSync(replayPath, 'utf8').split('\n').filter((l) => l.trim());

  let map = null;
  let board = null;
  let ca = null;
  let territories = null;
  let ot = null;
  let at = null;
  let prevMove = null;
  let aligned = false;

  let compared = 0;
  let badTurns = 0;
  let fieldDiffs = 0;
  const pathDiffKinds = new Map();
  const samples = [];

  for (const line of lines) {
    const rec = JSON.parse(line);
    const startData = {
      playerIndex: (rec.dump && rec.dump.player) || 0,
      usernames: ['eklipz_py', 'them'],
      playerColors: ['#111111', '#222222'],
      replay_id: 'cityops',
      game_type: 'custom',
      options: {}
    };

    let lastMove = null;
    if (map === null) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      if (!aligned) {
        let mis = 0;
        for (let i = 0; i < tileCoords.length; i++) {
          const t = map.tiles_by_index[i];
          if (!t || t.x !== tileCoords[i][0] || t.y !== tileCoords[i][1]) mis++;
        }
        console.log(mis === 0
          ? `索引对齐 ok（${tileCoords.length} 格）`
          : `警告: ${mis}/${tileCoords.length} 个格子索引和 Python 不一致`);
        aligned = true;
      }
      ot = new EK.OpponentTracker(map, null);
      at = new EK.ArmyTracker(map, null, ot);
    } else {
      if (prevMove) {
        const src = map.get_tile_by_tile_index(prevMove[1] * map.cols + prevMove[0]);
        const dest = map.get_tile_by_tile_index(prevMove[3] * map.cols + prevMove[2]);
        map.last_player_index_submitted_move = src && dest ? [src, dest, !!prevMove[4]] : null;
        if (src && dest) lastMove = new EK.Move(src, dest, !!prevMove[4]);
      } else {
        map.last_player_index_submitted_move = null;
      }
      map.apply_server_update(rec.data);
    }
    prevMove = rec.move;

    const exp = byTurn.get(map.turn);
    if (!exp) continue;
    if (exp.error) continue;

    const gen = map.generals[map.player_index];
    board = new EK.BoardAnalyzer(map, gen, null);
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

    at.update(lastMove, map.turn, board);
    const possibleSpawns = map.players.map((p) => at.valid_general_positions_by_player[p.index]);
    board.rebuild_intergeneral_analysis(enGen, possibleSpawns, null);

    ca = new EK.CityAnalyzer(map, gen);
    ca.re_scan(board);

    territories = new EK.TerritoryClassifier(map);
    territories.scan();

    ot.analyze_turn(map.player_index);

    /* pathing.js 的 avoidEnemyVision 分支只认 Array/Set（它按 .length 和数字下标遍历），
     * 而 ArmyTracker.visible_tiles_by_player[p] 是 MapMatrixSet，于是那一整段被静默跳过。
     * 这里把可见格摊平成「每玩家一个 tile 数组」喂给 pathing，等价于 Python 原版
     * `for t in armyTracker.visible_tiles_by_player[player]` 的形状，才有可比性。 */
    const trackerProxy = Object.create(at);
    trackerProxy.visible_tiles_by_player = at.visible_tiles_by_player.map(
      (s) => (s && typeof s.toTiles === 'function' ? s.toTiles() : Array.from(s || []))
    );

    let targetPlayer = -1;
    for (const p of map.players) {
      if (p.index !== map.player_index && !p.dead) {
        targetPlayer = p.index;
        break;
      }
    }

    const bot = {
      _map: map,
      map: map,
      player_index: map.player_index,
      general: gen,
      teammate_general: null,
      player: map.players[map.player_index],
      _gen_distances: map.distance_mapper.get_tile_dist_matrix(gen),
      board_analysis: board,
      cityAnalyzer: ca,
      territories: territories,
      armyTracker: trackerProxy,
      opponent_tracker: ot,
      dangerAnalyzer: {
        fastestThreat: null,
        fastestPotentialThreat: null,
        fastestAllyThreat: null,
        fastestCityThreat: null
      },
      targetPlayer: targetPlayer,
      targetPlayerObj: targetPlayer === -1 ? null : map.players[targetPlayer],
      targetPlayerExpectedGeneralLocation: enGen,
      target_player_gather_path: null,
      win_condition_analyzer: {
        contestable_cities: new Set(),
        defend_cities: new Set(),
        viable_win_conditions: new Set()
      },
      defend_economy: false,
      is_weird_custom: !!map.is_walled_city_game,
      enemyCities: map.tiles_by_index.filter((t) => t.isCity && map.is_tile_enemy(t)),
      leafMoves: [],
      _is_ffa_situation: null,
      _afk_players: [],
      is_all_in_army_advantage: false,
      is_all_in_losing: false,
      all_in_city_behind: false,
      is_rapid_capturing_neut_cities: false,
      is_blocking_neutral_city_captures: false,
      threat: null,
      expansion_plan: null,
      curPath: null,
      viewInfo: null,
      perf_timer: { begin_move_event: function () { return { enter: function () {}, exit: function () {} }; } },
      info: function () {}
    };
    bot.shortest_path_to_target_player = greedySp(map, gen, enGen, 60);

    const diffs = [];
    const r = exp.readme;
    compared++;

    // 输入一致性：城市清单 + 占位最短路径
    const jsCities = [];
    ca.city_scores.forEach((score, city) => {
      jsCities.push([city.tile_index, city.army, city.discovered ? 1 : 0,
        score.get_weighted_neutral_value(), score.general_distances_ratio, score.city_relevance_score]);
    });
    jsCities.sort((a, b) => a[0] - b[0]);
    if (r.cities && r.cities.length !== jsCities.length) {
      diffs.push(`cities: 行数 py=${r.cities.length} js=${jsCities.length}`);
    } else if (r.cities) {
      for (let i = 0; i < r.cities.length; i++) {
        const a = r.cities[i];
        const b = jsCities[i];
        if (!sameList(a, b)) {
          diffs.push(`cities[${i}] py=${JSON.stringify(a)} js=${JSON.stringify(b)}`);
          break;
        }
      }
    }
    const spTiles = Array.from(bot.shortest_path_to_target_player.tileList, (t) => t.tile_index);
    if (!sameList(r.spTiles, spTiles)) {
      diffs.push(`spTiles py=${JSON.stringify((r.spTiles || []).slice(0, 6))} js=${JSON.stringify(spTiles.slice(0, 6))} len py=${(r.spTiles || []).length} js=${spTiles.length}`);
    }
    if (r.spLen !== bot.shortest_path_to_target_player.length) {
      diffs.push(`spLen py=${r.spLen} js=${bot.shortest_path_to_target_player.length}`);
    }

    // 入口 1：可达性矩阵
    try {
      EK.BotCityOps.ensure_reachability_matrix_built(bot);
    } catch (e) {
      diffs.push(`ensure_reachability_matrix_built 抛异常: ${e.message}`);
    }
    const reach = ca.reachability_costs_matrix;
    if ((r.reach === null) !== (reach === null || reach === undefined)) {
      diffs.push(`reach: py=${r.reach === null ? 'null' : 'matrix'} js=${reach ? 'matrix' : 'null'}`);
    } else if (r.reach) {
      for (let i = 0; i < r.reach.length; i++) {
        if (!numEq(r.reach[i], reach.raw[i])) {
          const t = tileCoords[i];
          diffs.push(`reach (${t[0]},${t[1]}): py=${r.reach[i]} js=${reach.raw[i]}`);
          break;
        }
      }
    }

    // 入口 2/3：中立城路径
    for (const key of ['neutPath', 'neutPathIgnore']) {
      const py = r[key];
      let js = null;
      try {
        js = pathTiles(EK.BotCityOps.find_neutral_city_path(bot, key === 'neutPathIgnore'));
      } catch (e) {
        diffs.push(`${key} 抛异常: ${e.message}`);
        continue;
      }
      if (py && py.error) {
        diffs.push(`${key}: py 抛异常 ${String(py.error).split('\n').pop()}`);
        continue;
      }
      if (!sameList(py, js)) {
        const kind = classifyPathDiff(py || [], js);
        pathDiffKinds.set(kind, (pathDiffKinds.get(kind) || 0) + 1);
        diffs.push(`${key}[${kind}]: py=${py ? JSON.stringify(py) : 'null'} js=${js ? JSON.stringify(js) : 'null'}`);
      }
    }

    // 入口 4/5：两个布尔
    const pys = r.proactive && !r.proactive.error ? r.proactive : null;
    const jsp = EK.BotCityOps.should_proactively_take_cities(bot);
    if (pys !== null && pys !== jsp) diffs.push(`proactive py=${pys} js=${jsp}`);
    const pyr = r.rapid && !r.rapid.error ? r.rapid : null;
    let jsr = null;
    try {
      jsr = EK.BotCityOps.should_rapid_capture_neutral_cities(bot);
    } catch (e) {
      diffs.push(`rapid 抛异常: ${e.message}`);
    }
    if (pyr !== null && jsr !== null && pyr !== jsr) diffs.push(`rapid py=${pyr} js=${jsr}`);

    // 入口 6：等待捕获
    if (r.waitPath || r.waitFlag !== undefined) {
      let wp = null;
      let wf = null;
      try {
        const res = EK.BotCityOps._check_should_wait_city_capture(bot);
        wp = pathTiles(res[0]);
        wf = res[1];
      } catch (e) {
        diffs.push(`wait 抛异常: ${e.message}`);
      }
      if (!sameList(r.waitPath, wp)) {
        diffs.push(`waitPath py=${r.waitPath ? JSON.stringify(r.waitPath.slice(0, 6)) : 'null'} js=${wp ? JSON.stringify(wp.slice(0, 6)) : 'null'}`);
      }
      if (r.waitFlag !== undefined && r.waitFlag !== wf) diffs.push(`waitFlag py=${r.waitFlag} js=${wf}`);
    }

    // 入口 7：迷雾城
    if (Array.isArray(r.fogCity)) {
      for (let p = 0; p < r.fogCity.length; p++) {
        if (r.fogCity[p] && r.fogCity[p].error) continue;
        let jsf = null;
        try {
          jsf = EK.BotCityOps.did_player_just_take_fog_city(bot, p);
        } catch (e) {
          jsf = 'ERR:' + e.message;
        }
        if (r.fogCity[p] !== jsf) diffs.push(`fogCity[${p}] py=${r.fogCity[p]} js=${jsf}`);
      }
    }

    if (diffs.length > 0) {
      badTurns++;
      fieldDiffs += diffs.length;
      if (samples.length < 20) samples.push(`T${map.turn}: ${diffs.slice(0, 3).join(' | ')}`);
    }
  }

  console.log(`回合数 ${compared}，不一致回合 ${badTurns}，字段级差异 ${fieldDiffs}`);
  const kinds = Array.from(pathDiffKinds.entries()).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`neutPath 差异分类: ${kinds || '无'}`);
  for (const s of samples) console.log('  ' + s);
  console.log(badTurns === 0 ? '全部一致' : `不一致 ${badTurns}，一致率 ${(((compared - badTurns) / compared) * 100).toFixed(1)}%`);
  return badTurns === 0 ? 0 : 1;
}

process.exitCode = main();
