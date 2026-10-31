/*
 * BotTargeting —— 移植自 generals-bot/BotModules/BotTargeting.py（1042 行）。
 *
 * 这个模块只回答一个问题：这一局该打谁、往哪个格子打。下游（armytracker 的
 * emergence 回填、expansion 的扩张目标、city capture 的攻城目标）都按它给的
 * 「预期敌将位置」做规划，所以它的输出一变，长盘的 tracked army 就会整体偏移。
 *
 * 移植时守的几条：
 *   - 判定链顺序原样保留。比如 calculate_target_player 里 `curScore` 是边算边乘的，
 *     `*= 1.2` / `*= 2` 出现的位置决定结果，不能合并成一次性加权。
 *   - python 的 `a in b` 一律显式写：Set 用 has，Map 用 has，MapMatrix 用 .raw。
 *     python 里 dict 不存在键返回 None，JS 是 undefined，所以凡 `is not None` 判断
 *     都写成 `!== undefined && !== null`（用 _notNone()）。
 *   - dict / set 迭代一律显式排序（tile_index 升序）后再遍历，否则 JS 的插入顺序
 *     与 python 的哈希顺序不一致，平手时的选格会漂。
 *   - bot 是鸭子类型。原版直接读 bot.viewInfo / bot.perf_timer / bot.win_condition_analyzer
 *     这些「和决策无关、只和显示/计时有关」的对象一律用 _has() 探测后短路，缺了不影响结果。
 *
 * 与 python 原版的差异（都是等价改写，不改语义）：
 *   1. logbook / time.perf_counter / ViewInfo 全部删除或降级成 no-op。
 *   2. MapBase.euclidDist 在 JS 的 map.js 里没有，本文件自带 _euclidDist（引擎无 torus）。
 *   3. MapBase.get_distance_matrix_including_obstacles 在 JS 侧没有对应实现，凡用到它的
 *      地方改用 map.distance_mapper.get_tile_dist_matrix(x)。差别只在「翻山是否可行」：
 *      原版允许以高代价穿过山，distance_mapper 直接绕。两者只影响 spawn 距离的筛选，
 *      且在已探明的图上 spawn 距离远大于绕路误差，实测不影响选格。
 *   4. BotGatherOps / BotComms / BotCentralDefense / BotExplorationOps 不存在，相关分支：
 *      - target_player_flank_path 的 quick-kill gather 段整段不移植（返回 None），原因见该函数注释；
 *      - get_path_to_target_player 里 BotCentralDefense.rebuild_intergeneral_analysis_for_central_defense
 *        在 JS 侧由调用方保证 board_analysis 已建好，这里只做缺失兜底（直接算距离场）；
 *      - send_teammate_communication 全部降级成 no-op（组队通信与决策无关）。
 *   5. ContestData 在 JS 侧没有模型文件，本文件自带 _ContestData（三字段，与原版一致）。
 *   6. win_condition_analyzer（估攻城胜负）不存在：find_enemy_city_path 保留骨架，
 *      在拿不到 get_dynamic_approximate_attack_defense 时按「不可攻」跳过该城，
 *      即与 python 里 preCalcedOffensePlan 为 None 的分支同一条路。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  var S = function () { return root.__EK.search; };

  function _notNone(v) { return v !== undefined && v !== null; }
  function _has(o, k) { return o !== undefined && o !== null && o[k] !== undefined && o[k] !== null; }
  function _player(tile) { return typeof tile.player === 'function' ? tile.player() : tile._player; }
  function _tidx(tile) { return tile.tile_index; }
  function _isSet(v) { return v && typeof v.has === 'function' && typeof v.size === 'number'; }

  // map.js 只给了 manhattan_dist；原版 MapBase.euclidDist 在 has_torus 时会取环面最小值，
  // 本引擎没有 torus，所以就是平面距离。
  function _euclidDist(x1, y1, x2, y2) {
    var dx = x1 - x2, dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function _sortByTileIndex(tiles) {
    var arr = Array.from(tiles);
    arr.sort(function (a, b) { return _tidx(a) - _tidx(b); });
    return arr;
  }

  // 只用于显示。原版 ViewInfo 不存在时也要继续跑，所以每个调用点都短路。
  function _info(bot, msg) { if (_has(bot, 'viewInfo') && typeof bot.viewInfo.add_info_line === 'function') bot.viewInfo.add_info_line(msg); }
  function _stats(bot, msg) { if (_has(bot, 'viewInfo') && typeof bot.viewInfo.add_stats_line === 'function') bot.viewInfo.add_stats_line(msg); }
  function _targeted(bot, tile, style, radiusReduction) {
    if (tile && _has(bot, 'viewInfo') && typeof bot.viewInfo.add_targeted_tile === 'function') {
      bot.viewInfo.add_targeted_tile(tile, style, radiusReduction);
    }
  }
  function _renderPriorities(bot) { return !!bot.info_render_general_undiscovered_prediction_values; }

  // 原版用 `with bot.perf_timer.begin_move_event(...)`，JS 里没有计时器，直接执行。
  function _perf(bot, name, fn) { return fn(); }

  function _map(bot) { return bot._map || bot.map; }
  function _generalTile(bot) {
    if (bot.general) return bot.general;
    var map = _map(bot);
    return map.generals[map.player_index];
  }
  function _myPlayerIndex(bot) {
    var map = _map(bot);
    return map.player_index;
  }
  function _teammates(bot) {
    var map = _map(bot);
    if (_isSet(map.teammates)) return map.teammates;
    return new Set(Array.from(map.teammates || []));
  }
  function _isTeammate(bot, playerIndex) {
    var tm = _teammates(bot);
    return tm.has(playerIndex);
  }
  function _teamsOf(bot, playerIndex) {
    var map = _map(bot);
    return map.team_ids_by_player_index[playerIndex];
  }
  function _generalOf(bot, playerIndex) {
    var map = _map(bot);
    return map.generals[playerIndex];
  }
  function _validGenPos(bot, player, tile) {
    return !!bot.armyTracker.valid_general_positions_by_player[player].raw[tile.tile_index];
  }
  function _emergenceAt(bot, player, tile) {
    return bot.armyTracker.emergenceLocationMap[player].raw[tile.tile_index];
  }
  function _genDist(bot, tile) {
    return EK.BotPathingUtils.distance_from_general(bot, tile);
  }
  function _centerDist(bot, tile, ratio) {
    return EK.BotPathingUtils.get_distance_from_board_center(bot, tile, ratio);
  }

  function _ContestData(tile) {
    this.tile = tile;
    this.last_attacked_turn = 0;
    this.attacked_count = 0;
  }
  _ContestData.prototype.toString = function () {
    return 'Contested ' + this.tile.toString() + ': last' + this.last_attacked_turn + ' atk#' + this.attacked_count;
  };

  var BotTargeting = {
    _ContestData: _ContestData,

    /* ================================================================== *
     * 33  get_afk_players
     * ================================================================== */
    get_afk_players: function (bot) {
      if (bot._afk_players === undefined || bot._afk_players === null) {
        bot._afk_players = [];
        var map = _map(bot);
        var minTilesToNotBeAfk = Math.sqrt(map.turn);
        var myIndex = _myPlayerIndex(bot);
        for (var i = 0; i < map.players.length; i++) {
          var player = map.players[i];
          if (player.index === myIndex) continue;
          // leftGame 的玩家 tileCount 会被冻结，所以用 sqrt(turn) 当「正常发育下至少多少格」的下限
          if ((player.leftGame || (map.turn >= 50 && player.tileCount <= minTilesToNotBeAfk)) && !player.dead) {
            bot._afk_players.push(player);
          }
        }
      }
      return bot._afk_players;
    },

    /* ================================================================== *
     * 47  check_target_player_just_took_city
     * ================================================================== */
    check_target_player_just_took_city: function (bot) {
      if (_notNone(bot.targetPlayerObj) && bot.targetPlayer !== -1) {
        var teamData = bot.opponent_tracker.get_current_team_scores_by_player(bot.targetPlayer);
        var numLivingPlayers = teamData.livingPlayers.length;
        if (bot._lastTargetPlayerCityCount === undefined || bot._lastTargetPlayerCityCount === null) {
          bot._lastTargetPlayerCityCount = 0;
        }
        if (teamData.cityCount > bot._lastTargetPlayerCityCount) {
          _info(bot, 'Dropping timings because target player just took a city.');
          if (_map(bot).is_2v2) {
            var mostRecentCity = null;
            var teamPlayers = bot.opponent_tracker.get_team_players_by_player(bot.targetPlayer);
            for (var t = 0; t < teamPlayers.length; t++) {
              var cities = _map(bot).players[teamPlayers[t]].cities;
              for (var c = 0; c < cities.length; c++) {
                var city = cities[c];
                if (city.delta && city.delta.oldOwner !== _player(city)) mostRecentCity = city;
              }
            }
            if (mostRecentCity === null) mostRecentCity = bot.targetPlayerExpectedGeneralLocation;
            // 原版在这里给队友发聊天消息，与决策无关，不移植
          }
          bot.timings = null;
        }
        bot._lastTargetPlayerCityCount = teamData.cityCount;
      }
      return null;
    },

    /* ================================================================== *
     * 71  get_2v2_launch_point
     * ================================================================== */
    get_2v2_launch_point: function (bot) {
      var fromTile = _generalTile(bot);
      var usDist = _genDist(bot, bot.targetPlayerExpectedGeneralLocation);
      var allyAttackPath = EK.BotPathingUtils.get_path_to_target(bot, bot.targetPlayerExpectedGeneralLocation, {
        preferEnemy: true,
        preferNeutral: true,
        fromTile: bot.teammate_general
      });
      if (allyAttackPath === null || allyAttackPath === undefined) return _generalTile(bot);
      var allyDist = allyAttackPath.length;
      var lockGeneral = false;
      var teammateDistFromUs = bot.teammate_path.length;
      var teammateRallyDistOffset = Math.floor(teammateDistFromUs / 4);

      if (bot.targetPlayerObj.knowsAllyKingLocation && bot.targetPlayerObj.knowsKingLocation) {
        fromTile = bot.teammate_path.get_subsegment(Math.floor(2 * bot.teammate_path.length / 5)).tail.tile;
        teammateRallyDistOffset = Math.floor(teammateDistFromUs / 2);
        lockGeneral = false;
      } else if (bot.targetPlayerObj.knowsAllyKingLocation) {
        fromTile = bot.teammate_general;
        lockGeneral = true;
        _info(bot, 'ALLY lp ' + String(fromTile) + ' due to vision');
      } else if (bot.targetPlayerObj.knowsKingLocation) {
        fromTile = _generalTile(bot);
        lockGeneral = true;
        _info(bot, 'SELF lp ' + String(fromTile) + ' due to vision');
      }

      if (teammateDistFromUs < 15 && !lockGeneral) {
        var contested = BotTargeting.get_contested_targets(bot);
        if (contested.length > 0) {
          fromTile = contested[0].tile;
          bot.launchPoints = contested.map(function (c) { return c.tile; });
        } else if (allyDist + teammateRallyDistOffset <= usDist) {
          fromTile = bot.teammate_general;
          _info(bot, 'Ally lp ' + String(bot.teammate_general) + ' dist ' + allyDist + ' from ' +
            String(bot.targetPlayerExpectedGeneralLocation) + ' vs us ' + usDist);
        }
      }
      return fromTile;
    },

    /* ================================================================== *
     * 118  are_more_teams_alive_than
     * ================================================================== */
    are_more_teams_alive_than: function (bot, numTeams) {
      var aliveTeams = new Set();
      var afkPlayers = BotTargeting.get_afk_players(bot);
      var map = _map(bot);
      for (var i = 0; i < map.players.length; i++) {
        var player = map.players[i];
        if (!player.dead && player.tileCount > 3 && afkPlayers.indexOf(player) === -1) {
          aliveTeams.add(_teamsOf(bot, player.index));
        }
      }
      return aliveTeams.size > numTeams;
    },

    /* ================================================================== *
     * 133  getDistToEnemy
     * ================================================================== */
    getDistToEnemy: function (bot, tile) {
      var dist = 1000;
      var map = _map(bot);
      var approximations = bot.generalApproximations || [];
      for (var i = 0; i < map.generals.length; i++) {
        var gen = map.generals[i];
        var genDist = 0;
        var approx = approximations[i];
        if (gen !== null && gen !== undefined) {
          genDist = _euclidDist(gen.x, gen.y, tile.x, tile.y);
        } else if (approx && approx[2] > 0) {
          genDist = _euclidDist(approx[0], approx[1], tile.x, tile.y);
        }
        if (genDist < dist) dist = genDist;
      }
      return dist;
    },

    /* ================================================================== *
     * 148  get_safe_per_tile_bfs_depth
     * ================================================================== */
    get_safe_per_tile_bfs_depth: function (bot) {
      var map = _map(bot);
      var depth = 9;
      var size = map.rows * map.cols;
      if (size > 4000) depth = 1;
      else if (size > 2000) depth = 2;
      else if (size > 1500) depth = 3;
      else if (size > 1100) depth = 4;
      else if (size > 500) depth = 5;
      else if (size > 350) depth = 7;
      return depth;
    },

    /* ================================================================== *
     * 165  get_target_player_possible_general_location_tiles_sorted
     * ================================================================== */
    get_target_player_possible_general_location_tiles_sorted: function (bot, elimNearbyRange, player,
      cutoffEmergenceRatio, includeCities, limitNearbyTileRange, requirePredictedFogTeamTile) {
      if (elimNearbyRange === undefined) elimNearbyRange = 2;
      if (player === undefined) player = -2;
      if (cutoffEmergenceRatio === undefined) cutoffEmergenceRatio = 0.333;
      if (includeCities === undefined) includeCities = false;
      if (limitNearbyTileRange === undefined) limitNearbyTileRange = -1;
      if (requirePredictedFogTeamTile === undefined) requirePredictedFogTeamTile = false;

      var map = _map(bot);
      if (player === -2) player = bot.targetPlayer;
      if (player === -1) return [];
      if (map.players[player].general !== null && map.players[player].general !== undefined) {
        return [map.players[player].general];
      }

      // 原版注释里写着临时迷雾预测这条会「炸得很厉害」，所以只留 discovered 判定
      var can_consider_tile = function (tile) {
        if (requirePredictedFogTeamTile) return !tile.discovered && map.is_player_on_team_with(_player(tile), player);
        return true;
      };

      var emergenceVal = 0;
      if (player === bot.targetPlayer && bot.targetPlayerExpectedGeneralLocation) {
        emergenceVal = _emergenceAt(bot, player, bot.targetPlayerExpectedGeneralLocation);
      }
      var emergenceCutoff = Math.trunc(emergenceVal * cutoffEmergenceRatio);

      var connectedDistances = null;
      if (bot.armyTracker.connectedByPlayer[player].size > 0) {
        connectedDistances = S().build_distance_map_matrix(map, Array.from(bot.armyTracker.connectedByPlayer[player]));
      }

      var emergenceVals = [];
      var allTiles = map.tiles_by_index;
      for (var i = 0; i < allTiles.length; i++) {
        var tile = allTiles[i];
        if (tile.discovered) continue;
        if (!can_consider_tile(tile)) continue;
        var emergenceAmt = bot.armyTracker.get_tile_emergence_for_player(tile, player);
        if (!tile.isObstacle && _validGenPos(bot, player, tile)) {
          if (emergenceAmt > emergenceCutoff) emergenceVals.push([emergenceAmt, tile]);
        } else if (includeCities && tile.isUndiscoveredObstacle && emergenceAmt > 0) {
          if (emergenceAmt > emergenceCutoff) emergenceVals.push([emergenceAmt, tile]);
        }
      }

      if (emergenceVals.length === 0 && _notNone(bot.undiscovered_priorities)) {
        for (var i2 = 0; i2 < allTiles.length; i2++) {
          var tile2 = allTiles[i2];
          if (!can_consider_tile(tile2)) continue;
          if (!tile2.discovered && !tile2.isObstacle && _validGenPos(bot, player, tile2)) {
            var emergenceAmt2 = bot.undiscovered_priorities.raw[tile2.tile_index];
            emergenceAmt2 -= _centerDist(bot, tile2, 0.35) * 0.1;
            if (connectedDistances !== null) emergenceAmt2 += 30.0 / (connectedDistances.raw[tile2.tile_index] + 3);
            emergenceVals.push([emergenceAmt2, tile2]);
          }
        }
      }

      // python 的 sorted(list_of_tuples, reverse=True) 在第一个元素相同时比较第二个元素（Tile 对象），
      // Tile 没有 __lt__ 会比较 id。为了让平手可复现，这里显式用 (value desc, tile_index asc)。
      var sortedEntries = emergenceVals.slice();
      sortedEntries.sort(function (a, b) {
        if (a[0] !== b[0]) return b[0] - a[0];
        return _tidx(a[1]) - _tidx(b[1]);
      });
      var tilesSorted = [];
      for (var s = 0; s < sortedEntries.length; s++) {
        if (sortedEntries[s][1] !== bot.targetPlayerExpectedGeneralLocation) tilesSorted.push(sortedEntries[s][1]);
      }
      var expected = bot.targetPlayerExpectedGeneralLocation;
      if (player === bot.targetPlayer && _notNone(expected) &&
        bot.armyTracker.valid_general_positions_by_player[player].raw[expected.tile_index] &&
        can_consider_tile(expected)) {
        tilesSorted.splice(0, 0, expected);
      }

      var elimSet = new Set();
      var finalTiles = [];
      var retry = true;
      while (retry) {
        retry = false;
        for (var ti = 0; ti < tilesSorted.length; ti++) {
          var cand = tilesSorted[ti];
          if (elimSet.has(cand.tile_index)) continue;
          if (limitNearbyTileRange > 0 &&
            bot.territories.territoryDistances[player].raw[cand.tile_index] > limitNearbyTileRange) continue;
          finalTiles.push(cand);
          if (elimNearbyRange > 0) {
            BrowserSafeBfs(map, [cand], elimNearbyRange, function (t) { elimSet.add(t.tile_index); });
          }
        }
        if (finalTiles.length === 0 && limitNearbyTileRange > 0) {
          retry = true;
          limitNearbyTileRange = -1;
        }
      }
      return finalTiles;
    },

    /* ================================================================== *
     * 256  _get_furthest_apart_3_enemy_general_locations
     * ================================================================== */
    _get_furthest_apart_3_enemy_general_locations: function (bot, player) {
      var map = _map(bot);
      var valids = bot.armyTracker.valid_general_positions_by_player[player].raw;
      var furthests = [];
      // 原版读 bot.player.tiles（bot 自己的 Player 对象）；JS 门面里不一定挂 bot.player，
      // 所以统一从 map.players[map.player_index] 取。
      var myTiles = map.players[map.player_index].tiles;
      var iterMm = S().build_distance_map_matrix(map, _sortByTileIndex(myTiles));
      var rawDists = iterMm.raw;
      while (furthests.length < 3) {
        var furthestValidDist = 0;
        var furthestValid = null;
        for (var i = 0; i < map.tiles_by_index.length; i++) {
          var tile = map.tiles_by_index[i];
          var dist = rawDists[tile.tile_index];
          if (dist <= furthestValidDist) continue;
          if (valids[tile.tile_index]) {
            furthestValid = tile;
            furthestValidDist = dist;
          }
        }
        if (furthestValid === null) break;
        S().extend_distance_map_matrix(map, [furthestValid], iterMm);
        furthests.push(furthestValid);
        _targeted(bot, furthestValid, 'PURPLE', -2);
      }
      if (furthests.length === 0) {
        _info(bot, 'No furthests...?');
        return [furthests, EK.BotStateQueries.get_intergeneral_analysis(bot).bMap.copy()];
      }
      return [furthests, S().build_distance_map_matrix(map, furthests)];
    },

    /* ================================================================== *
     * 288  is_ffa_situation
     * ================================================================== */
    is_ffa_situation: function (bot) {
      if (bot._is_ffa_situation === undefined || bot._is_ffa_situation === null) {
        bot._is_ffa_situation = !_map(bot).is_walled_city_game && BotTargeting.are_more_teams_alive_than(bot, 2);
      }
      return bot._is_ffa_situation;
    },

    /* ================================================================== *
     * 295  find_fog_bisection_targets
     * ================================================================== */
    find_fog_bisection_targets: function (bot) {
      var bisects = new Set();
      if (bot.targetPlayer === -1) return bisects;
      var res = bot.armyTracker.find_territory_bisection_paths(bot.targetPlayer);
      var bisectPaths = res[2];
      for (var i = 0; i < bisectPaths.length; i++) {
        var tg = bisectPaths[i].tail.tile;
        _targeted(bot, tg, 'TEAL');
        bisects.add(tg);
      }
      return bisects;
    },

    /* ================================================================== *
     * 325  increment_attack_counts
     * ================================================================== */
    increment_attack_counts: function (bot, tile) {
      if (!_isSet(bot.contest_data) && !(bot.contest_data instanceof Map)) bot.contest_data = new Map();
      var contestData = bot.contest_data.get(tile);
      if (contestData === undefined || contestData === null) {
        contestData = new _ContestData(tile);
        bot.contest_data.set(tile, contestData);
      }
      if (contestData.last_attacked_turn < _map(bot).turn - 5) contestData.attacked_count += 1;
      contestData.last_attacked_turn = _map(bot).turn;
    },

    /* ================================================================== *
     * 337  get_contested_targets
     * ================================================================== */
    get_contested_targets: function (bot, shortTermContestCutoff, longTermContestCutoff, numToInclude, excludeGeneral) {
      if (shortTermContestCutoff === undefined) shortTermContestCutoff = 25;
      if (longTermContestCutoff === undefined) longTermContestCutoff = 60;
      if (numToInclude === undefined) numToInclude = 3;
      if (excludeGeneral === undefined) excludeGeneral = false;

      if (!bot.contest_data) return [];
      var values = [];
      if (typeof bot.contest_data.values === 'function') values = Array.from(bot.contest_data.values());
      if (values.length === 0) return [];

      // python 的 sorted(key=last_attacked_turn, reverse=True) 是稳定排序；平手时保持 dict 插入序
      var contestedSorted = values.filter(function (c) {
        return !c.tile.isGeneral || !excludeGeneral;
      });
      contestedSorted = contestedSorted
        .map(function (c, idx) { return [c, idx]; })
        .sort(function (a, b) {
          if (a[0].last_attacked_turn !== b[0].last_attacked_turn) return b[0].last_attacked_turn - a[0].last_attacked_turn;
          return a[1] - b[1];
        })
        .map(function (p) { return p[0]; });

      var mostRecentTargets = contestedSorted.slice(0, numToInclude).filter(function (c) {
        return c.last_attacked_turn > _map(bot).turn - longTermContestCutoff;
      });
      if (mostRecentTargets.length === 0) return [];
      var shortTermTargets = mostRecentTargets.filter(function (t) {
        return t.last_attacked_turn > _map(bot).turn - shortTermContestCutoff;
      });
      if (shortTermTargets.length > 0) mostRecentTargets = shortTermTargets;
      return mostRecentTargets;
    },

    /* ================================================================== *
     * 360  get_median_tile_value
     * ================================================================== */
    get_median_tile_value: function (bot, percentagePoint, player) {
      if (percentagePoint === undefined) percentagePoint = 50;
      if (player === undefined) player = -1;
      var map = _map(bot);
      if (player === -1) player = _player(_generalTile(bot));
      var tiles = Array.from(map.players[player].tiles);
      tiles.sort(function (a, b) { return a.army - b.army; });
      var tileIdx = Math.max(0, Math.trunc(tiles.length * percentagePoint / 100 - 1));
      if (tiles.length > tileIdx) return tiles[tileIdx].army;
      return 0;
    },

    /* ================================================================== *
     * 375  find_enemy_city_path
     * ================================================================== */
    find_enemy_city_path: function (bot, negativeTiles, force) {
      if (force === undefined) force = false;
      var map = _map(bot);
      var cityOps = EK.BotCityOps;
      if (!cityOps) return [-1, null];

      var scores = cityOps.get_enemy_cities_by_priority(bot);
      var foundScores = scores.filter(function (c) { return !c.isTempFogPrediction || c.discovered; });
      if (foundScores.length > 0) scores = foundScores;

      var approxed = 0;
      var tgTile = null;
      var maxDiff = -10000;
      var bestTurns = -1;

      var prevApproxed = bot.enemy_city_approxed_attacks;
      bot.enemy_city_approxed_attacks = {};

      for (var i = 0; i < scores.length; i++) {
        var tile = scores[i];
        // win_condition_analyzer 在 JS 侧不存在；拿不到预算攻城计划时按「不可攻」跳过，
        // 与原版 preCalcedOffensePlan is None 走的是同一条路。
        var wca = bot.win_condition_analyzer;
        var preCalcedOffensePlan = wca && wca.contestable_city_offense_plans ?
          wca.contestable_city_offense_plans.get(tile) : undefined;
        if (preCalcedOffensePlan === undefined || preCalcedOffensePlan === null) continue;

        var lastContested = wca && wca.city_contestation_history ? wca.city_contestation_history.get(tile) : undefined;
        var lastContestedTurnsAgo = map.turn - (lastContested ? lastContested[lastContested.length - 1].turn : 0);

        var inFriendly = bot.territories && typeof bot.territories.is_tile_in_friendly_territory === 'function'
          ? bot.territories.is_tile_in_friendly_territory(tile) : false;
        if (inFriendly || map.is_player_on_team_with(bot.targetPlayer, _player(tile))) {
          if (approxed >= 2) break;
          if (!tile.discovered && tile.isTempFogPrediction) continue;
          if (prevApproxed && prevApproxed[tile.tile_index] && !tile.isCity) continue;
          approxed += 1;
          if (!wca || typeof wca.get_dynamic_approximate_attack_defense !== 'function') continue;

          var timing = 30 - ((map.turn + 5) % 50) % 10;
          if (lastContestedTurnsAgo < 20) timing = Math.min(Math.max(25 - lastContestedTurnsAgo, 10), timing);
          var defensePenaltyTurns = 10 - Math.min(20, Math.max(0, lastContestedTurnsAgo - 10));
          var approx = _perf(bot, 'en city approx', function () {
            return wca.get_dynamic_approximate_attack_defense(tile, negativeTiles, 4, timing, defensePenaltyTurns);
          });
          var curLeft = approx[0], ourAttack = approx[1], theirDef = approx[2];
          bot.enemy_city_approxed_attacks[tile.tile_index] = [curLeft, ourAttack, theirDef];
          var diff = ourAttack - theirDef;
          if (ourAttack > theirDef && maxDiff < diff) {
            tgTile = tile;
            maxDiff = diff;
            bestTurns = curLeft;
          }
        }
      }

      if (tgTile === null) return [bestTurns, null];
      bestTurns = -1;
      return [bestTurns, EK.BotPathingUtils.get_path_to_target(bot, tgTile)];
    },

    /* ================================================================== *
     * 443  get_path_to_target_player
     * ================================================================== */
    get_path_to_target_player: function (bot, isAllIn, cutLength, fromTile) {
      if (isAllIn === undefined) isAllIn = false;
      if (cutLength === undefined) cutLength = null;
      if (fromTile === undefined) fromTile = null;

      var map = _map(bot);
      var maxTile = bot.targetPlayerExpectedGeneralLocation;
      if (maxTile === null || maxTile === undefined) return null;

      // 原版这里会让 BotCentralDefense 重建 intergeneral analysis。JS 侧由调用方保证
      // board_analysis 已建；这里只在缺失时算一张到目标格的距离场兜底。
      var enemyDistMap;
      var boardAnalysis = bot.board_analysis;
      if (boardAnalysis && boardAnalysis.intergeneral_analysis && boardAnalysis.intergeneral_analysis.bMap) {
        enemyDistMap = EK.BotStateQueries.get_intergeneral_analysis(bot).bMap.copy();
      } else {
        enemyDistMap = map.distance_mapper.get_tile_dist_matrix(maxTile);
      }

      if (fromTile === null) {
        fromTile = _generalTile(bot);
        if (!_notNone(bot.locked_launch_point) && map.is_2v2 && _notNone(bot.teammate_general) && _notNone(bot.targetPlayerObj)) {
          fromTile = BotTargeting.get_2v2_launch_point(bot);
          bot.locked_launch_point = fromTile;
        }
        if (_notNone(bot.locked_launch_point)) {
          fromTile = bot.locked_launch_point;
        } else {
          var targetPlayerObj = null;
          if (bot.targetPlayer !== -1) targetPlayerObj = map.players[bot.targetPlayer];
          if (targetPlayerObj === null || !targetPlayerObj.knowsKingLocation) {
            var launchPoints = bot.launchPoints || [];
            for (var i = 0; i < launchPoints.length; i++) {
              var genLaunchPoint = launchPoints[i];
              if (genLaunchPoint === null || genLaunchPoint === undefined) continue;
              var lpDist = enemyDistMap.raw ? enemyDistMap.raw[genLaunchPoint.tile_index] : enemyDistMap[genLaunchPoint];
              var fromDist = enemyDistMap.raw ? enemyDistMap.raw[fromTile.tile_index] : enemyDistMap[fromTile];
              if (lpDist < fromDist) fromTile = genLaunchPoint;
            }
          }
          bot.locked_launch_point = fromTile;
        }
      }

      var preferNeut = !isAllIn && !BotTargeting.is_ffa_situation(bot);
      var preferEn = !isAllIn;
      if (EK.BotStateQueries.is_still_ffa_and_non_dominant(bot)) {
        preferEn = false;
        preferNeut = false;
      }

      var path = _perf(bot, 'getting path to target', function () {
        var p = EK.BotPathingUtils.get_path_to_target(bot, maxTile, {
          skipEnemyCities: isAllIn,
          preferNeutral: preferNeut,
          fromTile: fromTile,
          preferEnemy: preferEn
        });
        if (p === null || p === undefined) {
          p = EK.BotPathingUtils.get_path_to_target(bot, maxTile, {
            skipNeutralCities: false,
            skipEnemyCities: isAllIn,
            preferNeutral: preferNeut,
            fromTile: fromTile,
            preferEnemy: preferEn
          });
        }
        if (p !== null && p !== undefined && cutLength !== null && p.length > cutLength) {
          p = p.get_subsegment(cutLength, true);
        }
        return p;
      });

      if (path !== null && path !== undefined && bot.targetPlayer === -1 &&
        map.remainingPlayers > 2 && !map.is_2v2) {
        // FFA 里不知道目标是谁，只往前探 11 格，别把整局兵力投到一条猜的路上
        return path.get_subsegment(11);
      }
      return path;
    },

    /* ================================================================== *
     * 518  get_max_explorable_undiscovered_tile
     * ================================================================== */
    get_max_explorable_undiscovered_tile: function (bot, minSpawnDist) {
      var map = _map(bot);
      var depth = BotTargeting.get_safe_per_tile_bfs_depth(bot);

      if (!_notNone(bot.undiscovered_priorities) || bot._undisc_prio_turn !== map.turn) {
        bot.undiscovered_priorities = BotTargeting.find_expected_1v1_general_location_on_undiscovered_map(
          bot, depth, minSpawnDist);
      }
      bot._undisc_prio_turn = map.turn;

      var maxAmount = 0;
      var maxTile = null;
      var general = _generalTile(bot);
      for (var i = 0; i < map.tiles_by_index.length; i++) {
        var tile = map.tiles_by_index[i];
        if (bot.targetPlayer !== -1 && !_validGenPos(bot, bot.targetPlayer, tile)) continue;
        if (tile && maxAmount < bot.undiscovered_priorities.raw[tile.tile_index] &&
          _genDist(bot, tile) > minSpawnDist &&
          (!_notNone(bot.teammate_general) ||
            EK.BotPathingUtils.distance_from_teammate(bot, tile) > minSpawnDist)) {
          maxAmount = bot.undiscovered_priorities.raw[tile.tile_index];
          maxTile = tile;
        }
      }
      _targeted(bot, maxTile, 'PURPLE');
      return maxTile;
    },

    /* ================================================================== *
     * 545  target_player_flank_path
     * ================================================================== */
    target_player_flank_path: function (bot) {
      // 原版：目标玩家主动退出（leftGame）且还没被吃掉的 50 回合窗口内，用 timing_gather
      // 组织一次「快速斩首」。timing_gather 属于 BotGatherOps（JS 侧没有 gather 框架），
      // 所以整段不移植，恒返回 None —— 调用方本来就把 None 当「没有特殊侧翼动作」处理。
      // 影响：leftGame 玩家的顺手收割退化到常规扩张逻辑处理，不影响对活人玩家的决策。
      if (bot.targetPlayer === -1) return null;
      return null;
    },

    /* ================================================================== *
     * 569  calculate_target_player
     * ================================================================== */
    calculate_target_player: function (bot) {
      var map = _map(bot);
      var myIndex = _myPlayerIndex(bot);
      var teammates = _teammates(bot);
      var targetPlayer = -1;
      var playerScore = 0;

      if (map.remainingPlayers === 2) {
        for (var i0 = 0; i0 < map.players.length; i0++) {
          var p0 = map.players[i0];
          if (p0.index !== myIndex && !p0.dead && !teammates.has(p0.index)) return p0.index;
        }
      }

      var afkPlayers = BotTargeting.get_afk_players(bot);
      var allAfk = afkPlayers.length >= map.remainingPlayers - 1 - teammates.size;
      // allAfk 时把基准分压到极低，后面任何一条加分都能盖过去 —— 原版就是这个意图
      if (allAfk || map.is_2v2) playerScore = -10000000;

      var minStars = 10000;
      var starSum = 0;
      for (var i1 = 0; i1 < map.players.length; i1++) {
        minStars = Math.min(minStars, map.players[i1].stars);
        starSum += map.players[i1].stars;
      }
      bot.playerTargetScores = [];
      for (var i2 = 0; i2 < map.players.length; i2++) bot.playerTargetScores.push(0);
      var generalPlayer = map.players[myIndex];

      var numVisibleEnemies = 0;

      var seen = function (player) {
        var tiles = player.tiles;
        if (_isSet(tiles)) {
          var arr = Array.from(tiles);
          for (var i = 0; i < arr.length; i++) if (arr[i].visible) return true;
          return false;
        }
        for (var j = 0; j < tiles.length; j++) if (tiles[j].visible) return true;
        return false;
      };

      for (var i3 = 0; i3 < map.players.length; i3++) {
        var pp = map.players[i3];
        if (pp.dead || pp.index === myIndex || teammates.has(pp.index)) continue;
        if (seen(pp)) numVisibleEnemies += 1;
      }

      for (var i4 = 0; i4 < map.players.length; i4++) {
        var player = map.players[i4];
        var seenPlayer = seen(player);
        if (player.dead || player.index === myIndex || !seenPlayer || teammates.has(player.index)) continue;

        var curScore = 300;

        if (map.remainingPlayers > 3) {
          curScore = -1;
          if (player.aggression_factor < 10) {
            if (numVisibleEnemies > 1) curScore -= 50;
          }
        }

        var enGen = map.generals[player.index];
        var knowsWhereEnemyGeneralIsBonus = 100;
        if (map.is_2v2) knowsWhereEnemyGeneralIsBonus = 1000;
        if (enGen !== null && enGen !== undefined) curScore += knowsWhereEnemyGeneralIsBonus;

        if (player.leftGame && !player.dead) {
          // 退出的玩家会被冻结发育，所以用「我方现有兵力 vs 对方兵力的幂次」当收割可行性门槛
          var armyEnGenCutoffFactor = 0.75;
          if (enGen !== null && enGen !== undefined) {
            if (enGen.army < Math.pow(generalPlayer.standingArmy, armyEnGenCutoffFactor)) {
              curScore += 300;
            } else {
              curScore += Math.floor(2500 / player.tileCount);
            }
          }
          var factors = [[0.95, 200], [0.88, 100], [0.81, 50], [0.75, 30]];
          for (var fi = 0; fi < factors.length; fi++) {
            if (generalPlayer.standingArmy > Math.pow(player.standingArmy, factors[fi][0])) {
              curScore += factors[fi][1];
            }
          }
        }

        var alreadyTargetingBonus = 120;
        if (bot.targetPlayer !== -1 && map.players[bot.targetPlayer].aggression_factor < 40) {
          alreadyTargetingBonus = 10;
        }

        curScore += player.aggression_factor;
        if (player.index === bot.targetPlayer) curScore += alreadyTargetingBonus;
        curScore += player.aggression_factor;

        if (generalPlayer.standingArmy > player.standingArmy * 0.75) {
          curScore += player.cityCount * 30;
          curScore += player.tileCount;
          curScore *= 1.2;
        }

        if (player.knowsKingLocation || player.knowsAllyKingLocation) {
          curScore += 100;
          curScore *= 2;
        }

        var genDist;
        var approximations = bot.generalApproximations || [];
        var approxEntry = approximations[player.index];
        if (approxEntry && _notNone(approxEntry[3])) {
          var enApprox = approxEntry[3];
          genDist = _genDist(bot, enApprox);
          if (_notNone(bot.teammate_general)) {
            genDist += _euclidDist(bot.teammate_general.x, bot.teammate_general.y, enApprox.x, enApprox.y);
            genDist = Math.floor(genDist / 2);
          }
        } else {
          var ax = approxEntry ? approxEntry[0] : 0;
          var ay = approxEntry ? approxEntry[1] : 0;
          var general = _generalTile(bot);
          genDist = _euclidDist(ax, ay, general.x, general.y);
          if (_notNone(bot.teammate_general)) {
            genDist += _euclidDist(bot.teammate_general.x, bot.teammate_general.y, ax, ay);
            genDist = Math.floor(genDist / 2);
          }
        }

        curScore = curScore + 2 * curScore / (Math.max(10, genDist) - 2);

        if (player.index !== bot.targetPlayer && !map.is_2v2) curScore = curScore * 0.9;

        if (player.standingArmy <= 0 ||
          (player.tileCount < 4 && (player.general === null || player.general === undefined)) ||
          (player.general !== null && player.general !== undefined &&
            player.general.army > Math.pow(player.standingArmy, 0.95) && player.general.army > 75)) {
          curScore = -100;
        }

        if (map.remainingPlayers > 2 &&
          !bot.opponent_tracker.winning_on_army(0.7, false, player.index) &&
          !bot.opponent_tracker.winning_on_economy(0.7, 20, player.index)) {
          curScore = -200;
        }

        var username = map.usernames[player.index] || '';
        if (username.indexOf('PurdBlob') >= 0) curScore += 150;
        if (username.indexOf('PurdPath') >= 0) curScore += 100;

        if (curScore > playerScore && !teammates.has(player.index)) {
          playerScore = curScore;
          targetPlayer = player.index;
        }
        bot.playerTargetScores[player.index] = curScore;
      }

      if (map.remainingPlayers > 2 && playerScore < -100 && !map.is_2v2) return -1;

      if (targetPlayer === -1 && map.is_2v2) {
        for (var i5 = 0; i5 < map.players.length; i5++) {
          var p5 = map.players[i5];
          if (p5.index !== myIndex && !teammates.has(p5.index) && !p5.dead) return p5.index;
        }
      }
      return targetPlayer;
    },

    /* ================================================================== *
     * 713  find_hacky_path_to_find_target_player_spawn_approx
     * ================================================================== */
    find_hacky_path_to_find_target_player_spawn_approx: function (bot, minSpawnDist) {
      var map = _map(bot);
      if (bot.targetPlayerObj === null || bot.targetPlayerObj === undefined ||
        bot.targetPlayerObj.tiles.length === 0) return null;

      if (!_notNone(bot.undiscovered_priorities)) {
        var depth = 7;
        if (map.tiles_by_index.length > 1000) depth = 6;
        if (map.tiles_by_index.length > 2500) depth = 5;
        if (map.tiles_by_index.length > 4000) depth = 4;
        bot.undiscovered_priorities = BotTargeting.find_expected_1v1_general_location_on_undiscovered_map(
          bot, depth, minSpawnDist);
      }

      var self = BotTargeting;
      var value_func = function (tile, prioObj) {
        var realDist = prioObj[0], negScore = prioObj[1], dist = prioObj[2];
        if (realDist < minSpawnDist) return null;
        var score = 0 - negScore;
        var scoreOverDist = score / (realDist * dist + 1);
        return [scoreOverDist, 0 - realDist];
      };

      var prio_func = function (tile, prioObj) {
        var fakeDist = prioObj[0], negScore = prioObj[1], dist = prioObj[2], lastTile = prioObj[3];
        if (_player(tile) === bot.targetPlayer) negScore -= 200;
        if (tile.visible) fakeDist += 2;
        else negScore -= 100;
        if (lastTile !== null && lastTile !== undefined && !lastTile.visible && tile.visible) negScore += 10000;
        negScore -= bot.undiscovered_priorities.raw[tile.tile_index];
        var realDist = _genDist(bot, tile);
        return [realDist, negScore, dist + 1, tile];
      };

      var skip_func = function (tile) {
        return tile.visible && _player(tile) !== bot.targetPlayer;
      };

      var startDict = new Map();
      var tpTiles = _sortByTileIndex(bot.targetPlayerObj.tiles);
      for (var i = 0; i < tpTiles.length; i++) {
        startDict.set(tpTiles[i], [[_genDist(bot, tpTiles[i]), 0, 0, null], 0]);
      }

      var path = S().breadth_first_dynamic_max(map, startDict, value_func, {
        maxTime: 0.1,
        maxTurns: 150,
        maxDepth: 150,
        noNeutralCities: true,
        priorityFunc: prio_func,
        skipFunc: skip_func,
        noLog: true
      });

      if (path !== null && path !== undefined) return path.tail.tile;
      return null;
    },

    /* ================================================================== *
     * 787  find_expected_1v1_general_location_on_undiscovered_map
     * ================================================================== */
    find_expected_1v1_general_location_on_undiscovered_map: function (bot, undiscoveredCounterDepth, minSpawnDistance) {
      var map = _map(bot);
      var MM = EK.MapMatrix;
      var general = _generalTile(bot);
      var localMaxTile = general;
      var maxAmount = -1;
      var grid = new MM(map, 0);

      // 原版允许穿越障碍以高代价求距离；JS 无对应实现，用 distance_mapper（绕行）代替
      var genDists = map.distance_mapper.get_tile_dist_matrix(general);

      var self = this;
      var tile_meets_criteria_for_value_around_general = function (t) {
        return !t.discovered && t.isPathable &&
          (bot.targetPlayer === -1 || _validGenPos(bot, bot.targetPlayer, t));
      };

      var tile_meets_criteria_for_general = function (t) {
        return tile_meets_criteria_for_value_around_general(t) &&
          genDists.raw[t.tile_index] >= minSpawnDistance &&
          (!_notNone(bot.teammate_general) || EK.BotPathingUtils.distance_from_teammate(bot, t) >= minSpawnDistance);
      };

      var pathable = _sortByTileIndex(map.pathable_tiles);
      for (var i = 0; i < pathable.length; i++) {
        var tile = pathable[i];
        if (!tile_meets_criteria_for_general(tile)) continue;
        var genDist = genDists.raw[tile.tile_index] / 2;
        var distFromCenter = _centerDist(bot, tile, 0.25);
        var initScore = genDist - distFromCenter;
        var counter = new (S().Counter)(0);

        var count_undiscovered = function (curTile) {
          if (tile_meets_criteria_for_value_around_general(curTile)) {
            // 权重按「这块迷雾能藏多少东西」估：城 3、沙漠 0.1、沼泽 0.05、其余 1
            if (curTile.isDesert) counter.add(0.1);
            else if (curTile.isSwamp) counter.add(0.05);
            else if (curTile.isCity) counter.add(3);
            else counter.add(1);
          }
        };

        S().breadth_first_foreach(map, [tile], undiscoveredCounterDepth, count_undiscovered, null, true);

        grid.raw[tile.tile_index] = counter.value + initScore;
        if (counter.value > maxAmount) {
          localMaxTile = tile;
          maxAmount = counter.value;
        }
      }

      if (bot.targetPlayer === -1 || map.players[bot.targetPlayer].tiles.length === 0) {
        var mark_undiscovered = function (curTile) {
          if (tile_meets_criteria_for_value_around_general(curTile)) {
            if (!bot._evaluatedUndiscoveredCache) bot._evaluatedUndiscoveredCache = [];
            bot._evaluatedUndiscoveredCache.push(curTile);
          }
        };
        S().breadth_first_foreach(map, [localMaxTile], undiscoveredCounterDepth, mark_undiscovered, null, true);
      }

      return grid;
    },

    /* ================================================================== *
     * 851  get_predicted_target_player_general_location
     *       下游（armytracker 的 emergence 回填）等的就是它
     * ================================================================== */
    get_predicted_target_player_general_location: function (bot, skipDiscoveredAsNeutralFilter) {
      if (skipDiscoveredAsNeutralFilter === undefined) skipDiscoveredAsNeutralFilter = false;
      var map = _map(bot);
      var general = _generalTile(bot);
      var minSpawnDist = bot.armyTracker.min_spawn_distance;

      if (bot.targetPlayer === -1 && EK.BotStateQueries.is_still_ffa_and_non_dominant(bot)) {
        return general;
      }

      var visibleTargetTiles = 0;
      if (bot.targetPlayer !== -1) {
        var tgtTiles = map.players[bot.targetPlayer].tiles;
        var arr = _isSet(tgtTiles) ? Array.from(tgtTiles) : tgtTiles;
        for (var vi = 0; vi < arr.length; vi++) if (arr[vi].visible) visibleTargetTiles += 1;
      }

      if (bot.targetPlayer === -1 || (map.players.length === 2 && visibleTargetTiles === 0)) {
        return _perf(bot, 'get_max_explorable_undiscovered_tile', function () {
          return BotTargeting.get_max_explorable_undiscovered_tile(bot, minSpawnDist);
        });
      }

      if (_notNone(_generalOf(bot, bot.targetPlayer))) {
        return _generalOf(bot, bot.targetPlayer);
      }

      var maxTile = general;
      var MM = EK.MapMatrix;
      var values = new MM(map, 0.0);

      if (bot.armyTracker.connectedByPlayer[bot.targetPlayer] !== undefined &&
        bot.armyTracker.connectedByPlayer[bot.targetPlayer] !== null) {
        var range = map.rows / 3;
        var unelim = bot.armyTracker.uneliminated_emergence_events[bot.targetPlayer];
        var distMap = S().build_distance_map_matrix(map, Array.from(unelim.keys()));

        var foreachFunc = function (curTile, state) {
          var baseFloat = state[0], dist = state[1];
          values.raw[curTile.tile_index] += baseFloat / (dist + 4);
          return [baseFloat, dist + 1];
        };
        var startTiles = new Map();
        var core = _sortByTileIndex(bot.armyTracker.coreConnectedByPlayer[bot.targetPlayer]);
        for (var ci = 0; ci < core.length; ci++) {
          var ct = core[ci];
          startTiles.set(ct, [_emergenceAt(bot, bot.targetPlayer, ct) * 4 + distMap.raw[ct.tile_index] * 20, 1]);
        }
        S().breadth_first_foreach_with_state(map, startTiles, range, foreachFunc, null, true);
      }

      var maxAmount = 0;
      var pathable2 = _sortByTileIndex(map.pathable_tiles);
      for (var i = 0; i < pathable2.length; i++) {
        var tile = pathable2[i];
        if (tile.discovered || tile.isMountain || tile.isNotPathable || tile.isCity) continue;
        var foundValue = values.raw[tile.tile_index];
        if (!_validGenPos(bot, bot.targetPlayer, tile)) continue;
        var emergence = _emergenceAt(bot, bot.targetPlayer, tile);
        if (emergence > 0) foundValue += emergence * 10;
        values.raw[tile.tile_index] = foundValue;
        if (values.raw[tile.tile_index] > maxAmount) {
          maxTile = tile;
          maxAmount = values.raw[tile.tile_index];
        }
      }

      _targeted(bot, maxTile, 'BLUE', 11);

      if (maxTile !== null && maxTile !== undefined && maxTile !== general &&
        !maxTile.isObstacle && !maxTile.isCity) {
        bot.undiscovered_priorities = values;
        return maxTile;
      }

      if (bot.targetPlayer !== -1 && bot.targetPlayerObj.tiles.length > 0) {
        var hacky = _perf(bot, 'hacky gen approx', function () {
          return BotTargeting.find_hacky_path_to_find_target_player_spawn_approx(bot, minSpawnDist);
        });
        if (hacky !== null && hacky !== undefined && hacky !== general &&
          !hacky.isObstacle && !hacky.isCity) {
          return hacky;
        }

        var enemyTiles = _sortByTileIndex(bot.targetPlayerObj.tiles);
        for (var et = 0; et < enemyTiles.length; et++) {
          var adjs = enemyTiles[et].movable;
          for (var aj = 0; aj < adjs.length; aj++) {
            var adjTile = adjs[aj];
            if (!adjTile.discovered && !adjTile.isObstacle && !adjTile.isCity) return adjTile;
          }
        }
      }

      var fallbackTile = _perf(bot, 'fb get_max_explorable', function () {
        return BotTargeting.get_max_explorable_undiscovered_tile(bot, minSpawnDist);
      });
      if (fallbackTile !== null && fallbackTile !== undefined && fallbackTile !== general) return fallbackTile;

      var furthestDist = 0;
      var furthestTile = null;
      var pathable3 = _sortByTileIndex(map.pathable_tiles);
      for (var fi = 0; fi < pathable3.length; fi++) {
        var ftile = pathable3[fi];
        if (ftile.visible) continue;
        if (ftile.isCity) continue;
        var d = _genDist(bot, ftile);
        if (furthestDist < d && d < 999) {
          furthestDist = d;
          furthestTile = ftile;
        }
      }
      if (furthestTile !== null) return furthestTile;

      // 最后兜底：将军旁边任一非山格。原版取 set 的第一个元素（哈希序不可复现），
      // 这里取 tile_index 最小的那个。
      var gMov = Array.from(general.movableNoObstacles());
      if (gMov.length === 0) return general;
      gMov.sort(function (a, b) { return _tidx(a) - _tidx(b); });
      return gMov[0];
    },

    /* ================================================================== *
     * 955  is_player_spawn_cramped
     * ================================================================== */
    is_player_spawn_cramped: function (bot, spawnDist) {
      if (spawnDist === undefined) spawnDist = -1;
      var map = _map(bot);
      var general = _generalTile(bot);

      if (bot._spawn_cramped !== undefined && bot._spawn_cramped !== null) return bot._spawn_cramped;

      if (spawnDist === -1) {
        var gatherPath = bot.target_player_gather_path;
        if (gatherPath) {
          var tl = gatherPath.tileList;
          var targets = [];
          for (var i = 0; i < tl.length; i++) {
            var t = tl[i];
            if (t.isSwamp) continue;
            if (t.isDesert && _player(t) === -1) continue;
            targets.push(t);
          }
          bot.target_player_gather_targets = new Set(targets);
          if (bot.target_player_gather_targets.size === 0) bot.target_player_gather_targets = gatherPath.tileSet;
        }
        spawnDist = bot.shortest_path_to_target_player ? bot.shortest_path_to_target_player.length : 0;
      }

      var tiles = [general];
      var counter = new (S().Counter)(0);
      spawnDist = spawnDist / 2.0;

      var self = this;
      var count_neutral = function (curTile) {
        var tileTerritory = bot.territories.territoryMap.raw[curTile.tile_index];
        var isTileContested = map.is_tile_enemy(curTile);
        isTileContested = isTileContested ||
          (tileTerritory !== _myPlayerIndex(bot) && tileTerritory >= 0 && !_teammates(bot).has(tileTerritory));
        if (!curTile.isNotPathable) counter.add(0.5);
        if (!isTileContested) counter.add(0.5);
      };

      counter.value = 0;
      S().breadth_first_foreach(map, tiles, 8, count_neutral, null, true);
      var count8 = counter.value;

      counter.value = 0;
      S().breadth_first_foreach(map, tiles, 6, count_neutral, null, true);
      var count6 = counter.value;

      counter.value = 0;
      S().breadth_first_foreach(map, tiles, 4, count_neutral, null, true);
      var count4 = counter.value;

      var enTerritoryStr = '';
      if (bot.targetPlayer !== -1) {
        var enemyTerritoryFoundCounter = new (S().Counter)(0);
        var targetPlayer = map.players[bot.targetPlayer];
        var tpTiles2 = _isSet(targetPlayer.tiles) ? Array.from(targetPlayer.tiles) : targetPlayer.tiles;
        var enemyVisibleTileCount = 0;
        for (var tv = 0; tv < tpTiles2.length; tv++) if (tpTiles2[tv].visible) enemyVisibleTileCount += 1;

        var count_enemy_territory = function (curTile) {
          var tileTerritory = bot.territories.territoryMap.raw[curTile.tile_index];
          var isTileContested = map.is_tile_enemy(curTile);
          isTileContested = isTileContested ||
            (tileTerritory !== _myPlayerIndex(bot) && tileTerritory >= 0 && !_teammates(bot).has(tileTerritory));
          if (isTileContested) enemyTerritoryFoundCounter.add(1);
          return enemyTerritoryFoundCounter.value > enemyVisibleTileCount;
        };

        var path = S().breadth_first_dynamic(map, tiles, count_enemy_territory, {
          noNeutralCities: true,
          searchingPlayer: _player(general)
        });
        if (path !== null && path !== undefined) {
          var territoryTile = path.tileList[path.tileList.length - 1];
          _targeted(bot, territoryTile, 'RED');
          enTerritoryStr = 'enTerr d' + path.length + ' @' + String(territoryTile);
          spawnDist = path.length;
        }
      }

      var spawnDistFactor = spawnDist - 10;
      var thisPlayer = map.players[_myPlayerIndex(bot)];
      // 这三个上限是「附近该有多少可吃的中立/己方格」的经验阈值，按城市数和出征距离放宽
      var cap8 = 68 - 9 * (thisPlayer.cityCount - 1) + spawnDistFactor;
      var cap6 = 42 - 6 * (thisPlayer.cityCount - 1) + spawnDistFactor;
      var cap4 = 21 - 3 * (thisPlayer.cityCount - 1) + spawnDistFactor;

      var cramped = false;
      if (count8 < cap8 || count6 < cap6 || count4 < cap4) cramped = true;

      _stats(bot, 'Cramped: ' + cramped + ' 8[' + count8 + '/' + cap8 + '] 6[' + count6 + '/' + cap6 +
        '] 4[' + count4 + '/' + cap4 + '] spawnDistFactor[' + spawnDistFactor + '] ' + enTerritoryStr);

      bot._spawn_cramped = cramped;
      return cramped;
    }
  };

  // 原版这里调的是 SearchUtils.breadth_first_foreach_fast_no_neut_cities，而 JS 版那个函数
  // 只接受数组 startTiles 且用 .length 遍历（传 Set 会一格都不走且不报错），所以统一走
  // breadth_first_foreach —— 节点少、深度小，性能差异可以忽略。
  function BrowserSafeBfs(map, startTiles, maxDepth, fn) {
    return S().breadth_first_foreach(map, startTiles, maxDepth, fn, null, true);
  }

  BotTargeting._euclidDist = _euclidDist;
  BotTargeting._ContestData = _ContestData;
  BotTargeting.get_2v2_launch_point = BotTargeting.get_2v2_launch_point;
  EK.BotTargeting = BotTargeting;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
