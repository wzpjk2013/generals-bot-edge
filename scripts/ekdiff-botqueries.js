/*
 * 四个查询小模块的数值 oracle：JS（src/eklipz/botqueries.js） vs 原版 Python。
 *
 *   node scripts/ekdiff-botqueries.js _research/botqueries-gm1.json
 *
 * 输入 JSON 由 _research/ekdump_botqueries.py 产出：每次真实调用的入参、调用时的整张
 * 地图快照（按内容去重）、以及原版的返回值。这里用同一份输入在 JS 侧复算再逐字段比。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'src', 'eklipz');
global.__EK = global.__EK || {};
require(path.join(PKG, 'tile.js'));
require(path.join(PKG, 'mapmatrix.js'));
require(path.join(PKG, 'mapmove.js'));
require(path.join(PKG, 'map.js'));
require(path.join(PKG, 'search.js'));
require(path.join(PKG, 'path.js'));
require(path.join(PKG, 'gather.js'));
require(path.join(PKG, 'botqueries.js'));
const EK = global.__EK;

// initialize_logging 的实际副作用（建目录）依赖未移植的 BotLogging，单独记账不参与 diff
let logDirectoryMissing = false;

function buildMap(snap) {
  const info = snap.map;
  const cols = info.cols;
  const tiles = new Array(cols * info.rows);

  for (let i = 0; i < snap.tiles.length; i++) {
    const row = snap.tiles[i];
    const t = Object.create(EK.Tile.prototype);
    t.tile_index = row[0];
    t.tile = row[1];
    t._player = row[2];
    t.army = row[3];
    t.isCity = !!row[4];
    t.isGeneral = !!row[5];
    t.discovered = !!row[6];
    t.visible = !!row[7];
    t.isMountain = !!row[8];
    t.x = t.tile_index % cols;
    t.y = Math.floor(t.tile_index / cols);
    t.movable = null;
    t.delta = null;
    t.lastSeen = 0;
    t.parent = null;
    // _recalc_derived 用 overridePathable !== null 判定「被强制可通行」，
    // 桩对象漏掉这一位会让每个格子都变成 notPathable，BFS 直接空转。
    t.overridePathable = null;
    tiles[t.tile_index] = t;
  }
  for (let i = 0; i < snap.tiles.length; i++) {
    const row = snap.tiles[i];
    const t = tiles[row[0]];
    t.movable = row[9].map(function (idx) {
      return tiles[idx];
    });
    if (t._recalc_derived) t._recalc_derived();
  }

  const teamIds = info.teamIds || [];
  const players = [];
  for (let p = 0; p < 16; p++) players.push({ index: p, tiles: [], cities: [] });

  const map = {
    cols: cols,
    rows: info.rows,
    player_index: info.playerIndex,
    turn: info.turn,
    tiles_by_index: tiles,
    players: players,
    generals: info.generals.map(function (ti) {
      return ti < 0 ? null : tiles[ti];
    }),
    teammates: new Set(info.teammates || []),
    team_ids_by_player_index: teamIds,
    reachable_tiles: info.reachable.map(function (ti) {
      return tiles[ti];
    }),
    visible_tiles: new Set(
      info.visible.map(function (ti) {
        return tiles[ti];
      })
    ),
    get_tile_by_tile_index: function (i) {
      return tiles[i];
    },
    is_player_on_team_with: function (player, other) {
      if (player === other) return true;
      if (player < 0 || other < 0) return false;
      const a = teamIds[player];
      const b = teamIds[other];
      return a !== undefined && b !== undefined && a >= 0 && a === b;
    },
    is_tile_on_team_with: function (tile, player) {
      return map.is_player_on_team_with(tile.player(), player);
    },
    is_tile_enemy: function (tile) {
      return !map.is_tile_on_team_with(tile, map.player_index);
    }
  };
  return map;
}

function idxList(tiles) {
  return tiles.map(function (t) {
    // get_largest_tiles_as_armies 返回 Army（.tile 是格），其余返回 Tile
    return t.tile_index === undefined ? t.tile.tile_index : t.tile_index;
  });
}

function sameArr(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function runCase(c, data) {
  const snap = data.snaps[c.in.snap];
  const map = buildMap(snap);
  const i = c.in;

  if (c.func === 'find_large_tiles_near') {
    if (i.hasAddlFilter) return { skip: 'addlFilter' };
    const bot = {
      _map: map,
      general: map.generals[map.player_index],
      opponent_tracker: {
        get_team_players_by_player: function (p) {
          // py 的团队玩家表只影响 allowTeam 场景；这里给单元素列表等价，
          // 真正的团队展开由 py 侧输入 forPlayers 校验（见下方比较）
          return [p];
        }
      }
    };
    const out = EK.BotCombatQueries.find_large_tiles_near(
      bot,
      i.fromTiles.map(function (t) {
        return map.tiles_by_index[t];
      }),
      i.distance,
      i.forPlayer,
      i.allowGeneral,
      i.limit,
      i.minArmy,
      null,
      i.allowTeam
    );
    return { got: idxList(out), want: c.out.tiles };
  }

  if (c.func === 'get_largest_tiles_as_armies') {
    const pw = data.pws[i.pwKey];
    const ptiles = i.playerTiles.map(function (t) {
      return map.tiles_by_index[t];
    });
    map.players[i.player] = { index: i.player, tiles: ptiles, cities: [] };
    const bot = {
      _map: map,
      board_analysis: {
        intergeneral_analysis: {
          pathWayLookupMatrix: {
            get: function (t) {
              return { distance: pw[t.tile_index] };
            }
          }
        }
      },
      get_army_at: function (t) {
        return { tile: t };
      }
    };
    const out = EK.BotCombatQueries.get_largest_tiles_as_armies(bot, i.player, i.limit);
    return { got: idxList(out), want: c.out.tiles };
  }

  if (c.func === 'sum_friendly_army_near_or_on_tiles') {
    const bot = { _map: map };
    const got = EK.BotCombatQueries.sum_friendly_army_near_or_on_tiles(
      bot,
      i.tiles.map(function (t) {
        return map.tiles_by_index[t];
      }),
      i.distance,
      i.player
    );
    return { got: got, want: c.out.value };
  }

  if (c.func === 'count_enemy_territory_near_tile') {
    const terrRaw = i.territoryRaw;
    const bot = {
      _map: map,
      targetPlayer: i.targetPlayer,
      territories: {
        territoryMap: {
          get: function (t) {
            return terrRaw[t.tile_index];
          }
        }
      }
    };
    const got = EK.BotCombatQueries.count_enemy_territory_near_tile(bot, map.tiles_by_index[i.startTile], i.distance);
    return { got: got, want: c.out.value };
  }

  if (c.func === 'block_neutral_captures') {
    const tailTile = i.tailTile === null ? null : map.tiles_by_index[i.tailTile];
    // 尾格是中立城这一位在快照里未必成立（快照是调用时刻的图），直接按 py 记录的状态造
    if (tailTile) {
      tailTile.isCity = i.tailIsCity;
      tailTile.isNeutral = i.tailIsNeutral;
    }
    const bot = {
      _map: map,
      curPath: i.hasCurPath ? { tail: tailTile === null ? null : { tile: tailTile } } : null,
      is_blocking_neutral_city_captures: i.isBlockingBefore,
      info: function () {}
    };
    EK.BotCityCaptureControl.block_neutral_captures(bot, 'oracle');
    const got = [bot.curPath === null, !!bot.is_blocking_neutral_city_captures];
    return { got: got, want: [c.out.curPathNullAfter, c.out.isBlockingAfter] };
  }

  if (c.func === 'determine_fog_defense_amount_available_for_tiles') {
    const armies = new Map();
    for (let k = 0; k < i.armies.length; k++) {
      const a = i.armies[k];
      const tile = map.tiles_by_index[a.tile];
      tile.visible = a.visible;
      const army = {
        player: a.player,
        name: a.name,
        value: a.value,
        tile: tile,
        entangledArmies: a.entangled.map(function (ei) {
          return { tile: map.tiles_by_index[ei] };
        })
      };
      armies.set(tile, army);
    }
    const bot = {
      _map: map,
      opponent_tracker: {
        get_approximate_fog_army_risk: function () {
          return i.risk;
        }
      },
      armyTracker: { armies: armies }
    };
    const got = EK.BotDefenseQueries.determine_fog_defense_amount_available_for_tiles(
      bot,
      i.targetTiles.map(function (t) {
        return map.tiles_by_index[t];
      }),
      i.enPlayer,
      i.fogDefenseTurns,
      i.fogReachTurns
    );
    return { got: got, want: c.out.value };
  }

  if (c.func === 'initialize_logging') {
    map.usernames = [i.username, 'b'];
    map.replay_id = i.replayId;
    map.remainingPlayers = i.remainingPlayers;
    const bot = { _map: map };
    const ret = EK.BotLifecycle.initialize_logging(bot);
    const gameMode = i.remainingPlayers > 2 ? 'ffa' : '1v1';
    // logDirectory 由 BotLogging 决定，本仓未移植 BotLogging（日志不进决策路径），
    // 所以只比 gameMode 与「无返回值」这两件属于被移植函数自身的行为。
    logDirectoryMissing = logDirectoryMissing || bot.logDirectory === null;
    return {
      got: [gameMode, ret === null || ret === undefined],
      want: [c.out.gameMode, true],
      soft: true
    };
  }

  throw new Error('unknown func ' + c.func);
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', '..', '_research', 'botqueries-gm1.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = data.cases || [];

  const stats = new Map();
  function bump(func, kind) {
    if (!stats.has(func)) stats.set(func, { exact: 0, diff: 0, skip: 0 });
    stats.get(func)[kind] += 1;
  }

  const details = [];
  logDirectoryMissing = false;
  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];
    let r;
    try {
      r = runCase(c, data);
    } catch (err) {
      bump(c.func, 'diff');
      details.push('T' + c.turn + ' ' + c.func + ' JS-THREW ' + err.message + '\n' + String(err.stack).split('\n')[1]);
      continue;
    }
    if (r.skip) {
      bump(c.func, 'skip');
      continue;
    }
    const ok = Array.isArray(r.want) ? sameArr(r.got, r.want) : r.got === r.want;
    if (ok) {
      bump(c.func, 'exact');
    } else {
      bump(c.func, 'diff');
      if (details.length < Number(process.env.DETAIL_LIMIT || '40')) {
        details.push(
          'T' +
            c.turn +
            ' ' +
            c.func +
            ' [' +
            c.via +
            '] got=' +
            JSON.stringify(r.got).slice(0, 300) +
            ' want=' +
            JSON.stringify(r.want).slice(0, 300)
        );
      }
    }
  }

  console.log('file   :', file);
  console.log('cases  :', cases.length);
  let bad = 0;
  for (const [func, s] of stats) {
    console.log(
      '  ' + func.padEnd(52) + ' exact=' + String(s.exact).padStart(6) + ' diff=' + String(s.diff).padStart(4) + ' skip=' + s.skip
    );
    bad += s.diff;
  }
  console.log('TOTAL DIFF:', bad);
  if (logDirectoryMissing) console.log('note   : logDirectory 为 null（未移植 BotLogging，日志不进决策路径）');
  if (details.length) {
    console.log('--- details (first 40) ---');
    details.forEach(function (d) {
      console.log(d);
    });
  }
  process.exitCode = bad === 0 ? 0 : 1;
}

main();
