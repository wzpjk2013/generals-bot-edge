/*
 * 地图级对拍：把原版录下来的服务器数据逐回合灌进 JS 移植版，每回合在
 * apply_server_update 之后、find_move 之前抓一份全图快照，和原版同一时刻的
 * 快照逐格比 army / player。
 *
 * 为什么要和 find_move 一起跑：迷雾推断（ArmyTracker 的雾地填充、OpponentTracker
 * 的兵力预测）都在 find_move 里发生并把结果写回地图。只回放 apply_server_update
 * 会让两边状态越走越远，测出来的"格级差异"全是自己造的。
 *
 *   node scripts/ekdiff-map.js <dump.jsonl> <pyMap.json> [outJsMaps.json]
 *
 * <pyMap.json> 由 _research/ekdump_flowexp.py 产出（<dst>.map.json）。不给就只导 JS 快照。
 *
 * 环境变量（调试用，默认全关）：
 *   GB_LOG_SETPLAYER=1   记录「给未见面格写 owner」的调用点 → GB_PWRITE_OUT
 *   GB_LOG_FOGFILL=1     记录 _fill_land_from_connected_tiles_for_player / update_fog_prediction
 *                        → GB_FOGFILL_OUT (+ .ufp.json)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'eklipz');
const MODULES = [
  'pyrandom', 'clock', 'pysetorder',
  'tile', 'mapmatrix', 'search', 'path', 'map', 'mapmove', 'nx',
  'armyanalyzer', 'territory', 'board', 'danger', 'city',
  'armytracker', 'opponenttracker', 'tileisland', 'gather', 'mapspanning', 'watchman',
  'gatherprune', 'botqueries', 'watchmanroute', 'gathermax', 'fastdisjointset', 'gatherutils',
  'expandutils', 'earlyexpandutils', 'timings', 'killtiming',
  'expansionops', 'combatops', 'gatherops', 'cityops', 'targeting',
  'interceptor', 'defense', 'explorationops', 'centraldefense', 'eventhandlers',
  'wincondition', 'comms', 'rendering', 'pathing', 'repetition',
  'statequeries',
  'flowmodels', 'flowgraph', 'flowmincost', 'flowknapsack', 'flowexpansion',
  'expandhooks', 'botmain',
];

function loadEK() {
  for (const m of MODULES) {
    const p = path.join(ROOT, m + '.js');
    if (!fs.existsSync(p)) continue;
    require(p);
  }
  const ek = global.__EK;
  if (!ek || !ek.Bot) throw new Error('eklipz 模块没挂上（global.__EK 无 Bot）');
  return ek;
}

function readRecords(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      continue;
    }
    out.push(r);
  }
  return out;
}

const playerWrites = [];
const fogFill = [];
const fogFillUfp = [];
const connLog = [];
const detLog = [];

// 把 MapMatrix / Set / MapMatrixSet 统一摊成 Tile 数组（python 侧 list(...) 的对应物）。
function toTileArr(coll) {
  if (!coll) return [];
  if (Array.isArray(coll)) return coll;
  if (coll.raw && Array.isArray(coll.raw)) return coll.raw.filter(Boolean);
  try {
    return Array.from(coll);
  } catch (e) {
    return [];
  }
}
let currentTurn = -1;

/*
 * CPython 的 set 迭代序：hash(Tile) 就是 tile_index，槽位 = hash & mask，
 * 发生增长后按旧槽位顺序重新插入。原版的地图/雾地逻辑大量「把 set 摊成 list
 * 当 BFS 起点」，这个顺序直接决定先填哪一格；JS 的 Set 是插入序，对不上。
 * 这个函数按 CPython 的插入/扩容/探测过程重放一遍，得到同样的迭代序。
 */
function pySetOrder(hashes) {
  let cap = 0;
  let mask = -1;
  let table = null;
  let fill = 0;
  let used = 0;
  function addEntry(h) {
    let perturb = h;
    let i = h & mask;
    while (table[i] !== null) {
      if (table[i] === h) return;
      perturb >>= 5;
      i = (i * 5 + 1 + perturb) & mask;
    }
    table[i] = h;
    fill += 1;
    used += 1;
  }
  function resize(minused) {
    let newcap = 8;
    while (newcap < minused) newcap *= 2;
    const old = table;
    const oldcap = cap;
    table = new Array(newcap).fill(null);
    cap = newcap;
    mask = newcap - 1;
    fill = 0;
    used = 0;
    if (old) {
      for (let i = 0; i < oldcap; i++) if (old[i] !== null) addEntry(old[i]);
    }
  }
  for (let k = 0; k < hashes.length; k++) {
    const h = hashes[k];
    if (cap === 0) resize(8);
    if (fill * 5 >= mask * 3) resize(used > 50000 ? used * 2 : used * 4);
    addEntry(h);
  }
  const out = [];
  for (let i = 0; i < cap; i++) if (table[i] !== null) out.push(table[i]);
  return out;
}

function pyOrderedTiles(tiles) {
  const arr = Array.from(tiles);
  const order = pySetOrder(arr.map((t) => t.tile_index));
  const byIdx = new Map(arr.map((t) => [t.tile_index, t]));
  return order.map((idx) => byIdx.get(idx));
}

function installHooks(ek) {
  if (process.env.GB_PYSETORDER && ek.ArmyTracker) {
    const P = ek.ArmyTracker.prototype;
    const origFill2 = P._fill_land_from_connected_tiles_for_player;
    P._fill_land_from_connected_tiles_for_player = function (
      player, bannedTiles, connectedDark, connectedTiles, numStartTilesToFill,
      numTilesToFillIn, ourGen, pathToPotentialEnGeneral, playerExpectedFogTileCounts,
      outputTilesToBeConverted
    ) {
      const darkOrdered = Array.isArray(connectedDark) ? pyOrderedTiles(connectedDark) : connectedDark;
      const connOrdered = new Set(pyOrderedTiles(connectedTiles));
      return origFill2.call(this, player, bannedTiles, darkOrdered, connOrdered, numStartTilesToFill,
        numTilesToFillIn, ourGen, pathToPotentialEnGeneral, playerExpectedFogTileCounts,
        outputTilesToBeConverted);
    };
  }

  if (process.env.GB_LOG_SETPLAYER && ek.Tile && ek.Tile.prototype.setPlayer) {
    const orig = ek.Tile.prototype.setPlayer;
    ek.Tile.prototype.setPlayer = function (value) {
      const before = this.player();
      orig.call(this, value);
      if (before !== value && !this.visible) {
        const frames = new Error().stack.split('\n').slice(2, 4)
          .map((s) => s.trim().replace(/^at\s+/, ''));
        playerWrites.push([currentTurn, this.tile_index, value, this.army, frames.join(' <- ')]);
      }
    };
  }
  if (process.env.GB_LOG_FOGFILL && ek.ArmyTracker) {
    const P = ek.ArmyTracker.prototype;
    const origFill = P._fill_land_from_connected_tiles_for_player;
    P._fill_land_from_connected_tiles_for_player = function (
      player, bannedTiles, connectedDark, connectedTiles, numStartTilesToFill,
      numTilesToFillIn, ourGen, pathToPotentialEnGeneral, playerExpectedFogTileCounts,
      outputTilesToBeConverted
    ) {
      const before = outputTilesToBeConverted.size;
      const beforeSet = new Set(outputTilesToBeConverted);
      const tilesBefore = this.map.players[player].tiles.slice(0, 80).map((t) => t.tile_index);
      const tileCountBefore = this.map.players[player].tileCount;
      const inConn = connectedTiles ? Array.from(connectedTiles).map((t) => t.tile_index).slice(0, 40) : null;
      const inDark = connectedDark ? Array.from(connectedDark).map((t) => t.tile_index).slice(0, 40) : null;
      const inBan = bannedTiles && bannedTiles.size !== undefined
        ? Array.from(bannedTiles).map((t) => t.tile_index).slice(0, 40)
        : null;
      if (process.env.GB_ORDERCHECK && inConn && inConn.length > 1) {
        const expect = pySetOrder(inConn);
        if (JSON.stringify(expect) !== JSON.stringify(inConn)) {
          console.log('ORDER NOT PY at T' + currentTurn + ' got ' + JSON.stringify(inConn) + ' want ' + JSON.stringify(expect)
            + ' stack=' + new Error().stack.split('\n').slice(3, 8).map((s) => s.trim()).join(' | '));
        }
      }
      const out = origFill.apply(this, arguments);
      const added = [];
      outputTilesToBeConverted.forEach((t) => {
        if (!beforeSet.has(t)) added.push(t.tile_index);
      });
      fogFill.push([currentTurn, player, before, outputTilesToBeConverted.size, numTilesToFillIn,
        out.length, pathToPotentialEnGeneral ? 1 : 0,
        playerExpectedFogTileCounts ? Object.keys(playerExpectedFogTileCounts).length : -1,
        added, inConn, inDark, numStartTilesToFill, inBan,
        this.map.players[player].tiles.slice(0, 80).map((t) => t.tile_index),
        tilesBefore, tileCountBefore]);
      return out;
    };
    const origUfp = P.update_fog_prediction;
    P.update_fog_prediction = function (playerIndex, counts, genLoc, force) {
      const p = this.map.players[playerIndex];
      const pre = [currentTurn, playerIndex, p ? p.tileDelta : null,
        this.players_with_incorrect_tile_predictions.has(playerIndex) ? 1 : 0,
        force ? 1 : 0, this.should_recalc_fog_land_by_player[playerIndex] ? 1 : 0,
        p ? p.tiles.length : -1, counts ? Object.keys(counts).length : -1];
      const out = origUfp.apply(this, arguments);
      fogFillUfp.push(pre);
      return out;
    };
  }
  if (process.env.GB_LOG_DET && ek.ArmyTracker) {
    // determine_tiles_to_fill_in 的选择过程：起点序 + 结果，用来定位「落点平局」。
    const R = ek.ArmyTracker.prototype;
    const origDet = R.determine_tiles_to_fill_in;
    R.determine_tiles_to_fill_in = function (connectedDark, bannedTiles, tilesToConvertToAddTo, numTilesToFillIn) {
      const beforeSet2 = new Set(toTileArr(tilesToConvertToAddTo));
      const darkIds = toTileArr(connectedDark).map((t) => t.tile_index).slice(0, 60);
      const out = origDet.apply(this, arguments);
      const added2 = toTileArr(tilesToConvertToAddTo).filter((t) => !beforeSet2.has(t)).map((t) => t.tile_index);
      detLog.push([currentTurn, numTilesToFillIn, darkIds, added2]);
      return out;
    };
  }

  if (process.env.GB_LOG_CONN && ek.ArmyTracker) {
    // 只记「连通集合」这一个出口：banned/connected/core 的长度 + 成员，用来判定上游是
    // 哪个集合先长歪，而不必逐层 dump 整张图。
    const Q = ek.ArmyTracker.prototype;
    const origConn = Q.get_fog_connected_based_on_emergences;
    Q.get_fog_connected_based_on_emergences = function (player, genLoc, extra) {
      const res = origConn.apply(this, arguments);
      const ids = (coll) => {
        if (!coll) return null;
        const raw = coll.raw ? coll.raw : coll;
        const out2 = [];
        try {
          raw.forEach((t) => {
            if (t && t.tile_index !== undefined) out2.push(t.tile_index);
          });
        } catch (e) {
          return null;
        }
        return out2;
      };
      connLog.push([currentTurn, player,
        (res[0] && res[0].size !== undefined) ? res[0].size : (ids(res[0]) || []).length,
        (res[1] && res[1].size !== undefined) ? res[1].size : (ids(res[1]) || []).length,
        ids(res[1]), genLoc ? genLoc.tile_index : null]);
      return res;
    };
  }
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/ekdiff-map.js <dump.jsonl> [pyMap.json] [outJsMaps.json]');
    process.exit(2);
  }
  const pyMapPath = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  const outPath = process.argv[4] || null;

  const recs = readRecords(file);
  if (!recs.length) throw new Error('记录为空: ' + file);

  let startRec = null;
  let firstTurnRec = null;
  for (const r of recs) {
    if (r.start) startRec = r;
    else if (!firstTurnRec) firstTurnRec = r;
  }

  const ek = loadEK();
  installHooks(ek);

  const startData = startRec ? startRec.startData : {
    playerIndex: (firstTurnRec.dump || {}).player || 0,
    usernames: ['ek', 'them'],
    playerColors: ['#111111', '#222222'],
    replay_id: 'diffmap',
    game_type: 'custom',
    options: {},
  };
  const startPacket = startRec ? startRec.data : firstTurnRec.data;

  const map = new ek.Map(startData, startPacket, { shuffle: false });
  if (startRec) map.apply_server_update(startPacket);
  const bot = new ek.Bot(startData);
  bot.initialize_from_map_for_first_time(map);

  function snap() {
    const rows = [];
    for (const row of map.grid) {
      for (const t of row) {
        rows.push([t.tile_index, t.army, typeof t.player === 'function' ? t.player() : t.player,
          !!t.visible, typeof t.lastSeen === 'number' ? t.lastSeen : -1, !!t.discovered]);
      }
    }
    return { turn: map.turn, rows: rows };
  }

  const jsMaps = [];
  // 和 python harness 同序：apply → 快照 → find_move。find_move 会写回地图状态
  // （雾里推断），漏掉它会让后续回合的快照整体漂移。
  for (const rec of recs) {
    if (rec.start) continue;
    if (rec.err) continue;
    try {
      map.apply_server_update(rec.data);
    } catch (e) {
      console.log('T' + rec.turn + ' 应用服务器数据失败: ' + e.message);
      break;
    }
    currentTurn = map.turn;
    jsMaps.push(snap());
    bot.perf_timer.record_update(map.turn, Date.now());
    try {
      bot.find_move();
    } catch (e) {
      if (process.env.GB_EK_RAISE) throw e;
    }
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(jsMaps));
    console.log('js maps -> ' + outPath);
  }

  if (process.env.GB_LOG_SETPLAYER) {
    const p = process.env.GB_PWRITE_OUT || 'pwrite-js.json';
    fs.writeFileSync(p, JSON.stringify(playerWrites));
    console.log('unseen-tile owner writes=' + playerWrites.length + ' -> ' + p);
  }
  if (process.env.GB_LOG_DET) {
    const p = process.env.GB_DET_OUT || 'det-js.json';
    fs.writeFileSync(p, JSON.stringify(detLog));
    console.log('determine-tiles calls=' + detLog.length + ' -> ' + p);
  }
  if (process.env.GB_LOG_CONN) {
    const p = process.env.GB_CONN_OUT || 'conn-js.json';
    fs.writeFileSync(p, JSON.stringify(connLog));
    console.log('fog-connected calls=' + connLog.length + ' -> ' + p);
  }
  if (process.env.GB_LOG_FOGFILL) {
    const p = process.env.GB_FOGFILL_OUT || 'fogfill-js.json';
    fs.writeFileSync(p, JSON.stringify(fogFill));
    fs.writeFileSync(p + '.ufp.json', JSON.stringify(fogFillUfp));
    console.log('fog-fill calls=' + fogFill.length
      + ' totalOut=' + fogFill.reduce((a, r) => a + r[5], 0)
      + '  update_fog_prediction calls=' + fogFillUfp.length + ' -> ' + p);
  }

  if (!pyMapPath) return;
  if (!fs.existsSync(pyMapPath)) {
    console.log('py map snapshot 不存在，跳过对比: ' + pyMapPath);
    return;
  }
  const pyMaps = JSON.parse(fs.readFileSync(pyMapPath, 'utf8'));
  const byTurn = new Map(pyMaps.map((m) => [m.turn, m]));
  let diffTurns = 0;
  let totalDiffs = 0;
  let firstDiff = null;
  for (const jm of jsMaps) {
    const pm = byTurn.get(jm.turn);
    if (!pm) continue;
    const P = new Map(pm.rows.map((r) => [r[0], r]));
    const diffs = [];
    for (const r of jm.rows) {
      const a = P.get(r[0]);
      if (!a) continue;
      if (a[1] !== r[1] || a[2] !== r[2]) {
        diffs.push({ idx: r[0], py: [a[1], a[2], a[3] ? 1 : 0, a[4]], js: [r[1], r[2], r[3] ? 1 : 0, r[4]] });
      }
    }
    if (diffs.length) {
      diffTurns++;
      totalDiffs += diffs.length;
      if (!firstDiff) firstDiff = { turn: jm.turn, diffs: diffs };
    }
  }
  console.log('map snapshots compared: ' + jsMaps.length
    + ', divergent turns: ' + diffTurns
    + ', divergent tiles: ' + totalDiffs);
  if (firstDiff) {
    console.log('first divergent turn: T' + firstDiff.turn + ' (' + firstDiff.diffs.length + ' tiles)');
    for (const d of firstDiff.diffs.slice(0, 20)) {
      console.log('  tile ' + d.idx + ' py=' + JSON.stringify(d.py) + ' js=' + JSON.stringify(d.js));
    }
  } else {
    console.log('no tile-level divergence');
  }
}

main();
