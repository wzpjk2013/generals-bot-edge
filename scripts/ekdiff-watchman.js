/*
 * WatchmanRouteUtils 的 JS → Python 逐格比对。
 *
 * 用法：
 *   node scripts/ekdiff-watchman.js <replay.jsonl> <watchman-oracle.json>
 *
 * 数据来源：`_research/ekdump_watchman.py` 用真正的 EklipZBot 跑完整局，在指定回合
 * 按 BotExplorationOps.get_optimal_exploration 的算法算出输入（toReveal / startTile /
 * targetArmyLevel），再调 WatchmanRouteUtils 两个入口，dump 输入与输出。
 *
 * 这里只把「输入」喂给 JS 侧的 EK.Watchman，不重算 BotTargeting / BotDefense ——
 * 那两个模块有自己的 oracle，混进来只会让不一致的来源不可辨。地图本身仍然逐回合
 * 重放（路径选择依赖距离场与迷雾标记）。
 *
 * 输出两行统计：一行是严格比对结果，一行把「长度相同但路线不同」单独计数 ——
 * pivot A* 在等价最优解之间的选择对下游无害，但长度不同就是真错。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
[
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'armyanalyzer',
  'board', 'armytracker', 'opponenttracker', 'danger', 'territory', 'watchman'
].forEach((m) => require(path.join(ROOT, m + '.js')));

const EK = global.__EK;
const WM = EK.Watchman;

function round6(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
}

function tileByIndex(map, idx) {
  if (idx === null || idx === undefined || idx < 0) return null;
  return map.get_tile_by_tile_index(idx);
}

function main() {
  const replayPath = process.argv[2];
  const oraclePath = process.argv[3];
  if (!replayPath || !oraclePath) {
    console.error('usage: node scripts/ekdiff-watchman.js <replay.jsonl> <watchman-oracle.json>');
    return 2;
  }

  const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
  const bigTime = typeof oracle.bigTime === 'number' ? oracle.bigTime : 1e9;
  const byTurn = new Map();
  for (const d of oracle.dumps) byTurn.set(d.turn, d);

  const lines = fs.readFileSync(replayPath, 'utf8').split('\n').filter((l) => l.trim());
  const startData = {
    playerIndex: 0,
    usernames: ['eklipz_py', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'watchman',
    game_type: 'custom',
    options: {}
  };

  let map = null;
  let ot = null;
  let at = null;
  let prevMove = null;

  let turnsCompared = 0;
  let turnsSame = 0;
  let turnsDiff = 0;
  let pathSame = 0;
  let pathTieDifferent = 0;
  let pathLengthDiff = 0;
  const fieldDiffs = [];
  const samples = [];

  for (const line of lines) {
    const rec = JSON.parse(line);
    if (map === null) {
      map = new EK.Map(startData, rec.data, { shuffle: false });
      map.apply_server_update(rec.data);
      ot = new EK.OpponentTracker(map);
      at = new EK.ArmyTracker(map, null, ot);
    } else {
      if (prevMove) {
        const src = tileByIndex(map, prevMove[1] * map.cols + prevMove[0]);
        const dest = tileByIndex(map, prevMove[3] * map.cols + prevMove[2]);
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
      const s = tileByIndex(map, lastMove[1] * map.cols + lastMove[0]);
      const d = tileByIndex(map, lastMove[3] * map.cols + lastMove[2]);
      if (s && d) moveObj = new EK.Move(s, d, !!lastMove[4]);
    }
    try {
      at.update(moveObj, map.turn, null);
    } catch (e) {
      console.error('armyTracker.update threw at turn ' + map.turn + ': ' + e.message);
    }

    const dump = byTurn.get(map.turn);
    if (!dump) continue;

    turnsCompared += 1;
    const wd = dump.watchman || {};
    const inp = wd.inputs || null;
    const pyOut = wd.output || {};

    if (pyOut.error) {
      fieldDiffs.push(`turn ${map.turn}: python oracle errored: ${pyOut.error}`);
      turnsDiff += 1;
      continue;
    }
    if (inp === null) {
      // Python 侧这回合没有可看目标（toReveal 为空 / 无起始兵），JS 不该给出路径
      turnsSame += 1;
      continue;
    }

    const toReveal = inp.toReveal.map((i) => tileByIndex(map, i)).filter(Boolean);
    const startTile = tileByIndex(map, inp.startTile);
    if (!startTile) {
      fieldDiffs.push(`turn ${map.turn}: oracle startTile ${inp.startTile} missing in JS map`);
      turnsDiff += 1;
      continue;
    }

    const jsPath = WM.get_watchman_path(map, startTile, toReveal, bigTime, -1, true);
    const jsTiles = jsPath === null ? null : jsPath.tileList.map((t) => t.tile_index);
    const pyTiles = pyOut.path === null || pyOut.path === undefined ? null : pyOut.path.tiles;

    let turnOk = true;
    if (jsTiles === null && pyTiles !== null) {
      fieldDiffs.push(`turn ${map.turn}: py path len ${pyTiles.length}, js null`);
      pathLengthDiff += 1;
      turnOk = false;
    } else if (jsTiles !== null && pyTiles === null) {
      fieldDiffs.push(`turn ${map.turn}: py null, js path len ${jsTiles.length}`);
      pathLengthDiff += 1;
      turnOk = false;
    } else if (jsTiles !== null && pyTiles !== null) {
      if (jsTiles.length !== pyTiles.length) {
        pathLengthDiff += 1;
        turnOk = false;
        if (fieldDiffs.length < 12) {
          fieldDiffs.push(
            `turn ${map.turn}: path length py=${pyTiles.length} js=${jsTiles.length}`
          );
        }
      } else {
        let same = true;
        for (let i = 0; i < jsTiles.length; i++) {
          if (jsTiles[i] !== pyTiles[i]) {
            same = false;
            break;
          }
        }
        if (same) pathSame += 1;
        else {
          pathTieDifferent += 1;
          if (samples.length < 8) {
            samples.push(
              `turn ${map.turn}: same length ${jsTiles.length}, first diff at ` +
                `${jsTiles.findIndex((v, i) => v !== pyTiles[i])}`
            );
          }
        }
      }

      // 计数只在路径一致时才有意义（不一致的路径自然算出不同 revealed）
      const jsRes = WM.get_revealed_count_and_max_kill_turns_and_positive_path(
        map, jsPath, toReveal, inp.targetArmyLevel
      );
      const pairs = [
        ['revealedCount', jsRes.revealedCount, pyOut.revealedCount],
        ['maxKillTurns', jsRes.maxKillTurns, pyOut.maxKillTurns],
        ['minKillTurns', jsRes.minKillTurns, pyOut.minKillTurns],
        ['avgKillTurns', round6(jsRes.avgKillTurns), round6(pyOut.avgKillTurns)]
      ];
      for (const [name, jsV, pyV] of pairs) {
        if (jsV !== pyV) {
          turnOk = false;
          if (fieldDiffs.length < 12) {
            fieldDiffs.push(`turn ${map.turn}.${name}: py=${pyV} js=${jsV}`);
          }
        }
      }

      const jsPos = jsRes.positivePath === null ? null : jsRes.positivePath.tileList.map((t) => t.tile_index);
      const pyPos = pyOut.positivePath === undefined ? null : pyOut.positivePath;
      const jsPosNorm = jsPos === null ? null : jsPos;
      if (JSON.stringify(jsPosNorm) !== JSON.stringify(pyPos)) {
        const jsLen = jsPosNorm === null ? -1 : jsPosNorm.length;
        const pyLen = pyPos === null ? -1 : pyPos.length;
        if (jsLen !== pyLen) {
          turnOk = false;
          if (fieldDiffs.length < 12) {
            fieldDiffs.push(`turn ${map.turn}.positivePath length: py=${pyLen} js=${jsLen}`);
          }
        } else if (samples.length < 8) {
          samples.push(`turn ${map.turn}: positivePath same length ${jsLen}, tiles differ`);
        }
      }
    }

    if (turnOk) turnsSame += 1;
    else turnsDiff += 1;
  }

  for (const d of fieldDiffs) console.log('  ' + d);
  for (const s of samples) console.log('  (tie) ' + s);
  console.log(
    `回合 ${turnsCompared}，不一致 ${turnsDiff}，一致率 ` +
      `${turnsCompared === 0 ? 0 : ((turnsSame / turnsCompared) * 100).toFixed(2)}%`
  );
  console.log(
    `路径: 完全一致 ${pathSame}，长度不同 ${pathLengthDiff}，长度同仅路线不同 ${pathTieDifferent}`
  );
  return turnsDiff === 0 && pathLengthDiff === 0 ? 0 : 1;
}

process.exit(main());
