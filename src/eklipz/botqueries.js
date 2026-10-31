/*
 * BotModules 里那四个「纯查询」小模块的移植：
 *   BotCombatQueries.py (93) / BotCityCaptureControl.py (19)
 *   BotDefenseQueries.py (47) / BotLifecycle.py (20)
 *
 * 它们被 botmain / cityops / combatops / defense 各自就地复制过一份近似实现，
 * 这里提供唯一一份逐行对齐原版的版本，供 oracle 与后续接线使用。
 * 签名（含默认参数）逐个照抄 py，参数顺序不许改。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---------------------------------------------------------------- 内部取值 */

  // py 里 bot._map / bot.opponent_tracker 是属性；JS 侧两种命名都出现过。
  function _counter(v) {
    return new EK.search.Counter(v);
  }

  function _map(bot) {
    return bot._map || bot.map;
  }

  function _ot(bot) {
    return bot.opponent_tracker || bot.opponentTracker || null;
  }

  function _tracker(bot) {
    return bot.armyTracker || bot.army_tracker || null;
  }

  function _player(tile) {
    return typeof tile.player === 'function' ? tile.player() : tile.player;
  }

  function _isNone(v) {
    return v === null || v === undefined;
  }

  function _toArr(x) {
    if (_isNone(x)) return [];
    if (Array.isArray(x)) return x;
    // py 那边是 dict.values()/set，JS 对应物可能是 Map（Array.from 会给 entry 对）
    if (typeof x.values === 'function') return Array.from(x.values());
    if (typeof x.toArray === 'function') return x.toArray();
    return Array.from(x);
  }

  // Python 的 set 迭代序对 int 哈希来说等价于 tile_index 升序；JS 里集合/数组
  // 的插入序不一定一致，凡是要「稳定排序里保留原集合顺序」的地方都先归一。
  function _sortedByTileIndex(arr) {
    var out = arr.slice();
    out.sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    return out;
  }

  /* --------------------------------------------------- BotCombatQueries.py */

  function BotCombatQueries() {}

  // py:BotCombatQueries.find_large_tiles_near
  //
  // 从 fromTiles 出发 redis 圈内找「够大」的己方格。
  // 注意 sorted(key=army, reverse=True) 是稳定排序：等兵的格子保留 BFS 距离序，
  // 所以这里只比 army，不许拿 tile_index 兜底（那会打乱等兵的选择，见 g1000 T46）。
  BotCombatQueries.find_large_tiles_near = function (
    bot,
    fromTiles,
    distance,
    forPlayer,
    allowGeneral,
    limit,
    minArmy,
    addlFilterFunc,
    allowTeam
  ) {
    if (forPlayer === undefined) forPlayer = -2;
    if (allowGeneral === undefined) allowGeneral = true;
    if (limit === undefined) limit = 5;
    if (minArmy === undefined) minArmy = 10;
    if (addlFilterFunc === undefined) addlFilterFunc = null;
    if (allowTeam === undefined) allowTeam = false;

    var map = _map(bot);
    var largeTilesNearTargets = [];

    if (forPlayer === -2) forPlayer = _player(bot.general);

    var forPlayers = [forPlayer];
    if (allowTeam) {
      var ot = _ot(bot);
      forPlayers = ot ? ot.get_team_players_by_player(forPlayer) : [forPlayer];
    }

    EK.search.breadth_first_foreach_dist_fast_incl_neut_cities(map, _toArr(fromTiles), distance, function (tile, dist) {
      if (
        forPlayers.indexOf(_player(tile)) >= 0 &&
        tile.army > minArmy &&
        (_isNone(addlFilterFunc) || addlFilterFunc(tile, dist)) &&
        (!tile.isGeneral || allowGeneral)
      ) {
        largeTilesNearTargets.push(tile);
      }
    });

    largeTilesNearTargets.sort(function (a, b) {
      return b.army - a.army;
    });
    return largeTilesNearTargets.slice(0, limit);
  };

  // py:BotCombatQueries.get_largest_tiles_as_armies
  //
  // 按「(army-1)/(到敌方战区路径长度+5)」给玩家的格子打分，取前 limit 个
  // 转成 Army。pathWayLookupMatrix 缺项时 dist 退化成 100（原版如此）。
  BotCombatQueries.get_largest_tiles_as_armies = function (bot, player, limit) {
    var map = _map(bot);
    var p = map.players[player];
    if (!p) return [];

    var ba = bot.board_analysis || bot.boardAnalysis;
    var inter = ba ? ba.intergeneral_analysis || ba.intergeneralAnalysis : null;
    var lookup = inter ? inter.pathWayLookupMatrix || inter.path_way_lookup_matrix : null;

    function sortFunc(t) {
      var pw = null;
      if (lookup) {
        pw = typeof lookup.get === 'function' ? lookup.get(t) : lookup.raw[t.tile_index];
      }
      var dist = _isNone(pw) ? 100 : pw.distance;
      return (t.army - 1) / (dist + 5);
    }

    var tiles = _sortedByTileIndex(_toArr(p.tiles));
    tiles.sort(function (a, b) {
      return sortFunc(b) - sortFunc(a);
    });

    var out = [];
    var top = tiles.slice(0, limit);
    for (var i = 0; i < top.length; i++) {
      if (top[i].army > 1) out.push(bot.get_army_at(top[i], true));
    }
    return out;
  };

  // py:BotCombatQueries.sum_friendly_army_near_or_on_tiles
  BotCombatQueries.sum_friendly_army_near_or_on_tiles = function (bot, tiles, distance, player) {
    if (distance === undefined) distance = 2;
    if (player === undefined) player = null;

    var map = _map(bot);
    if (_isNone(player)) player = map.player_index;

    var armyNear = _counter(0);
    EK.search.breadth_first_foreach(map, _toArr(tiles), distance, function (tile) {
      if (map.is_tile_on_team_with(tile, player)) armyNear.add(tile.army - 1);
    });
    return armyNear.value;
  };

  // py:BotCombatQueries.count_enemy_territory_near_tile
  BotCombatQueries.count_enemy_territory_near_tile = function (bot, startTile, distance) {
    if (distance === undefined) distance = 2;

    var map = _map(bot);
    var terrs = bot.territories;
    var enemyNear = _counter(0);

    EK.search.breadth_first_foreach(
      map,
      [startTile],
      distance,
      function (tile) {
        var territoryPlayer = -1;
        if (terrs && terrs.territoryMap) {
          var raw = terrs.territoryMap.get ? terrs.territoryMap.get(tile) : terrs.territoryMap.raw[tile.tile_index];
          if (!_isNone(raw)) territoryPlayer = raw;
        }
        var tileIsNeutAndNotEnemyTerritory = tile.isNeutral && (tile.visible || territoryPlayer !== bot.targetPlayer);
        if (!tileIsNeutAndNotEnemyTerritory && map.is_tile_enemy(tile)) enemyNear.add(1);
        return tile.isObstacle && tile !== startTile;
      },
      null,
      true,
      true
    );

    return enemyNear.value;
  };

  /* ----------------------------------------------- BotCityCaptureControl.py */

  function BotCityCaptureControl() {}

  // py:BotCityCaptureControl.block_neutral_captures
  //
  // 发现当前路径终点是个中立城时把路径丢掉，并置位「正在拦截中立城」。
  // 置位是无条件的：只要调用过就认为本回合不允许再吃中立城。
  BotCityCaptureControl.block_neutral_captures = function (bot, reason) {
    if (reason === undefined) reason = '';

    var cur = bot.curPath || bot.cur_path;
    if (cur && !_isNone(cur.tail) && cur.tail.tile.isCity && cur.tail.tile.isNeutral) {
      if (bot.is_blocking_neutral_city_captures) {
        if (typeof bot.info === 'function') {
          bot.info('forcibly stopped taking neutral city ' + String(cur.tail.tile) + ' ' + reason);
        }
        bot.curPath = null;
      }
    }
    bot.is_blocking_neutral_city_captures = true;
  };

  /* --------------------------------------------------- BotDefenseQueries.py */

  function BotDefenseQueries() {}

  // py:BotDefenseQueries.determine_fog_defense_amount_available_for_tiles
  //
  // 敌人迷雾里「够不到这片区域」的已知 army 不该算进防守压力，从 fog 风险里扣掉。
  BotDefenseQueries.determine_fog_defense_amount_available_for_tiles = function (
    bot,
    targetTiles,
    enPlayer,
    fogDefenseTurns,
    fogReachTurns
  ) {
    if (fogDefenseTurns === undefined) fogDefenseTurns = 0;
    if (fogReachTurns === undefined) fogReachTurns = 8;

    var map = _map(bot);
    var ot = _ot(bot);
    var targetArmy = ot.get_approximate_fog_army_risk(enPlayer, null, fogDefenseTurns);
    if (_isNone(targetArmy)) targetArmy = 0;

    // 原版这里只传 skipTiles，maxDepth 用默认 1000；把它误写成 fogReachTurns 会让
    // 超过 fogReachTurns 的格子根本进不了矩阵，被当成「够不着」而多扣兵力。
    var genReachable = EK.search.build_distance_map_matrix_with_skip(map, _toArr(targetTiles), map.visible_tiles, 1000);

    var tracker = _tracker(bot);
    if (!tracker || !tracker.armies) return targetArmy;

    var used = new Set();
    var values = _toArr(tracker.armies);
    for (var i = 0; i < values.length; i++) {
      var army = values[i];
      if (army.player !== enPlayer) continue;
      if (used.has(army.name)) continue;
      if (army.tile.visible) continue;

      var anyReachable = false;
      var cd = genReachable.raw[army.tile.tile_index];
      if (_isNone(cd) || cd >= fogReachTurns) {
        var entangled = army.entangledArmies || [];
        for (var e = 0; e < entangled.length; e++) {
          var ed = genReachable.raw[entangled[e].tile.tile_index];
          if (!_isNone(ed) && ed < fogReachTurns) {
            anyReachable = true;
            break;
          }
        }
      } else {
        anyReachable = true;
      }

      if (!anyReachable) {
        targetArmy -= army.value;
        used.add(army.name);
      }
    }
    return targetArmy;
  };

  /* ------------------------------------------------------- BotLifecycle.py */

  function BotLifecycle() {}

  // py:BotLifecycle.initialize_logging
  //
  // 原版委托 BotLogging 建目录/挂文件输出。仓库里 BotLogging 还没移植，
  // 这里保持「设置 logDirectory」这一可观测语义，缺依赖时降级为 null 并记账，
  // 绝不抛 —— 日志不是决策路径，不该把整局带崩。
  var _lifecycleMissing = [];

  BotLifecycle.missing = function () {
    return _lifecycleMissing.slice();
  };

  BotLifecycle.initialize_logging = function (bot) {
    var map = _map(bot);
    var logging = EK.BotLogging || null;
    if (!logging) {
      bot.logDirectory = null;
      if (_lifecycleMissing.indexOf('BotLogging') < 0) _lifecycleMissing.push('BotLogging');
      return null;
    }

    var userName = map.usernames[map.player_index];
    var replayId = map.replay_id;
    bot.logDirectory = logging.get_file_logging_directory(userName, replayId);
    var fileSafeUserName = logging.get_file_safe_username(userName);
    var gameMode = map.remainingPlayers > 2 ? 'ffa' : '1v1';
    logging.add_file_log_output(fileSafeUserName, gameMode, replayId, bot.logDirectory);
    return bot.logDirectory;
  };

  EK.BotCombatQueries = BotCombatQueries;
  EK.BotCityCaptureControl = BotCityCaptureControl;
  EK.BotDefenseQueries = BotDefenseQueries;
  EK.BotLifecycle = BotLifecycle;

  root.__EK = EK;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof globalThis !== 'undefined' ? globalThis : this);
