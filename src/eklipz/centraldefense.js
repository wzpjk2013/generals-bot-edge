/* BotModules/BotCentralDefense.py 逐函数移植（229 行）。
 *
 * 为什么必须搬它：bot_ek0x45.py:716 每回合都会调
 * rebuild_intergeneral_analysis_for_central_defense(bot)，而它是**唯一**把
 * armyTracker.valid_general_positions_by_player 传进
 * BoardAnalyzer.rebuild_intergeneral_analysis 的调用方 —— 少了它，
 * board_analysis.flankable_fog_area_matrix 永远是 None，BotExpansionOps
 * 的 does_tile_capture_expand_our_vision 在 python 侧不可能为 None、在 js 侧
 * 一取就炸。所以它不是可选的"渲染辅助"，是扩张逻辑的前置条件。
 */
(function (root) {
  'use strict';

  var EK = root.__EK = root.__EK || {};

  function S() {
    return EK.search;
  }

  /* 原版是 tuple 比较（float,int,int），JS 没有元组比较，这里显式复用字典序 */
  function cmpTuple(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  /* 渲染层的 TargetStyle.ORANGE；本模块不搬渲染，留常量占位 */
  var TARGET_STYLE_ORANGE = 'ORANGE';

  var BotCentralDefense = {};

  BotCentralDefense.rebuild_intergeneral_analysis_for_central_defense = function (bot) {
    var citiesInPlay = BotCentralDefense._get_central_defense_cities_in_play(bot);
    bot.board_analysis.rebuild_intergeneral_analysis(
      bot.targetPlayerExpectedGeneralLocation,
      bot.armyTracker.valid_general_positions_by_player,
      citiesInPlay
    );
  };

  BotCentralDefense.calculate_central_defense_point_if_needed = function (bot, force) {
    if (force === undefined) force = false;
    if (bot.cityAnalyzer.last_scan_turn !== bot._map.turn) return;

    var citiesInPlay = BotCentralDefense._get_central_defense_cities_in_play(bot);
    var signature = BotCentralDefense._get_central_defense_signature(bot, citiesInPlay);
    if (!force && bot.last_central_defense_signature === signature && bot.board_analysis.central_defense_point !== null) {
      return;
    }

    bot.last_central_defense_signature = signature;
    BotCentralDefense.rebuild_defensive_chokes(bot);
    BotCentralDefense.calculate_central_defense_point(bot);
  };

  BotCentralDefense.rebuild_defensive_chokes = function (bot) {
    var board = bot.board_analysis;
    board.defensive_chokes_by_tile = new Map();
    board.defensive_furthest_choke_tiles_by_defensive_tile = new Map();
    var chokeTiles = new Set();

    var defensiveChokePoint = board._get_defensive_choke_point(bot.general);
    defensiveChokePoint.choke_tiles.forEach(function (t) {
      chokeTiles.add(t);
    });

    board.friendly_city_distances.forEach(function (distMap, city) {
      void distMap;
      var point = board._get_defensive_choke_point(city);
      point.choke_tiles.forEach(function (t) {
        chokeTiles.add(t);
      });
    });

    if (bot.viewInfo && typeof bot.viewInfo.add_targeted_tiles_with_legend === 'function') {
      bot.viewInfo.add_targeted_tiles_with_legend(chokeTiles, 'Defensive choke tiles', TARGET_STYLE_ORANGE, 12);
    }
  };

  BotCentralDefense.calculate_central_defense_point = function (bot) {
    var board = bot.board_analysis;
    var defensePoints = Array.from(board.defensive_chokes_by_tile.values());
    if (defensePoints.length === 0) {
      bot.info('WHAT THE FUCK, NOT EVEN THE GENERAL HAS A CHOKE?');
      board.central_defense_point = bot.general;
      return;
    }

    board.defense_centrality_sums = new EK.MapMatrix(bot._map, 1000000);
    var averagePointCount = defensePoints.length + 1;
    var averageX = bot.general.x;
    var averageY = bot.general.y;
    for (var i = 0; i < defensePoints.length; i++) {
      averageX += defensePoints[i].x;
      averageY += defensePoints[i].y;
    }
    averageX = averageX / averagePointCount;
    averageY = averageY / averagePointCount;

    var emergenceAverage = BotCentralDefense._get_recent_emergence_average(bot);
    if (emergenceAverage !== null) {
      averageX = averageX * 0.6 + emergenceAverage[0] * 0.4;
      averageY = averageY * 0.6 + emergenceAverage[1] * 0.4;
    }

    var attackPathFogExitTile = BotCentralDefense._get_enemy_attack_path_fog_exit_tile(bot);
    var distanceToFogExit = attackPathFogExitTile !== null
      ? bot._map.distance_mapper.get_tile_dist_matrix(attackPathFogExitTile)
      : null;

    var lowestScore = null;
    var lowestAvgTile = bot.general;
    var topCentralityTiles = [];

    var centralDefenseCandidateTiles = new Set(bot.defensive_spanning_tree);
    board.defensive_chokes_by_tile.forEach(function (chokeInfo) {
      chokeInfo.choke_tiles.forEach(function (t) {
        centralDefenseCandidateTiles.add(t);
      });
    });
    if (centralDefenseCandidateTiles.size < 3 && bot.shortest_path_to_target_player !== null) {
      var pathList = bot.shortest_path_to_target_player.tileList;
      var cap = Math.max(1, Math.floor(bot.shortest_path_to_target_player.length / 3));
      centralDefenseCandidateTiles = new Set(pathList.slice(0, cap));
    }

    centralDefenseCandidateTiles.forEach(function (tile) {
      var distSum = Math.abs(tile.x - averageX) + Math.abs(tile.y - averageY);
      var interceptDist = 0;
      if (distanceToFogExit !== null) {
        var rawInterceptDist = distanceToFogExit.raw[tile.tile_index];
        if (rawInterceptDist === null || rawInterceptDist === undefined) return;
        interceptDist = rawInterceptDist;
      }

      var tileEnemyDist = board.intergeneral_analysis !== null
        ? board.intergeneral_analysis.bMap.raw[tile.tile_index]
        : 0;
      var score = [distSum + interceptDist * 0.5, interceptDist, tileEnemyDist];

      if (lowestScore === null || cmpTuple(score, lowestScore) < 0) {
        lowestAvgTile = tile;
        lowestScore = score;
      }

      board.defense_centrality_sums.raw[tile.tile_index] = score[0];
      topCentralityTiles.push([score, tile]);
      topCentralityTiles.sort(function (a, b) {
        return cmpTuple(a[0], b[0]);
      });
      if (topCentralityTiles.length > 10) topCentralityTiles.pop();
    });

    board.central_defense_point = lowestAvgTile;
  };

  BotCentralDefense._get_central_defense_cities_in_play = function (bot) {
    if (bot.cityAnalyzer === null) return null;

    var citiesInPlay = bot.cityAnalyzer.cities_in_play;
    if (!citiesInPlay || citiesInPlay.size === 0) return citiesInPlay;

    var enemyLandDistanceMap = BotCentralDefense._get_enemy_land_distance_map(bot);
    var filteredCities = new Set();
    var everOwnedByTarget = bot.armyTracker.tiles_ever_owned_by_player[bot.targetPlayer];
    var ig = bot.board_analysis.intergeneral_analysis;

    citiesInPlay.forEach(function (city) {
      if (!bot._map.is_tile_on_team_with(city, bot.general.player())) return;

      var enemyHasSeen = false;
      if (city.visibleTo) {
        city.visibleTo.forEach(function (t) {
          if (!enemyHasSeen && everOwnedByTarget && everOwnedByTarget.has && everOwnedByTarget.has(t)) enemyHasSeen = true;
        });
        if (!enemyHasSeen && Array.isArray(city.visibleTo)) {
          for (var i = 0; i < city.visibleTo.length; i++) {
            if (everOwnedByTarget && everOwnedByTarget.has && everOwnedByTarget.has(city.visibleTo[i])) {
              enemyHasSeen = true;
              break;
            }
          }
        }
      }

      var nearestEnemyLandDist = enemyLandDistanceMap !== null
        ? enemyLandDistanceMap.raw[city.tile_index]
        : null;
      if (nearestEnemyLandDist === undefined) nearestEnemyLandDist = null;

      var shouldExclude = !enemyHasSeen
        && (nearestEnemyLandDist === null || nearestEnemyLandDist >= 4)
        && ig.bMap.raw[city.tile_index] >= 2 * ig.aMap.raw[city.tile_index];
      if (!shouldExclude) filteredCities.add(city);
    });

    return filteredCities;
  };

  /* 原版签名是个 tuple，JS 里要按值比较就得给出同样的三元组 */
  BotCentralDefense._get_central_defense_signature = function (bot, citiesInPlay) {
    var expectedGeneralIndex = bot.targetPlayerExpectedGeneralLocation !== null
      ? bot.targetPlayerExpectedGeneralLocation.tile_index
      : null;
    var citySignature = [];
    if (citiesInPlay) {
      citiesInPlay.forEach(function (city) {
        citySignature.push([city.tile_index, city.player()]);
      });
      citySignature.sort(function (a, b) {
        if (a[0] !== b[0]) return a[0] - b[0];
        return a[1] - b[1];
      });
    }
    var emergenceSignature = BotCentralDefense._get_recent_emergence_signature(bot);
    return JSON.stringify([expectedGeneralIndex, citySignature, emergenceSignature]);
  };

  BotCentralDefense._get_recent_emergence_signature = function (bot) {
    var recentEmergences = bot.opponent_tracker.get_last_attacked_from_locations(bot.targetPlayer, 6);
    var ret = [];
    for (var i = 0; i < recentEmergences.length; i++) {
      var emergence = recentEmergences[i];
      if (emergence === null || emergence === undefined) continue;
      ret.push([emergence[0], emergence[1].x, emergence[1].y]);
    }
    return ret;
  };

  BotCentralDefense._get_recent_emergence_average = function (bot) {
    var sig = BotCentralDefense._get_recent_emergence_signature(bot);
    if (sig.length === 0) return null;
    var sx = 0;
    var sy = 0;
    for (var i = 0; i < sig.length; i++) {
      sx += sig[i][1];
      sy += sig[i][2];
    }
    return [sx / sig.length, sy / sig.length];
  };

  BotCentralDefense._get_enemy_land_distance_map = function (bot) {
    var map = bot._map;
    var enemyLandTiles = [];
    for (var i = 0; i < map.players.length; i++) {
      var player = map.players[i];
      if (player.index === bot.general.player()) continue;
      if (!map.is_player_on_team_with(player.index, bot.targetPlayer)) continue;
      if (!player.tiles) continue;
      player.tiles.forEach(function (tile) {
        enemyLandTiles.push(tile);
      });
    }
    if (enemyLandTiles.length === 0) return null;
    return S().build_distance_map_matrix(map, enemyLandTiles);
  };

  BotCentralDefense._can_enemy_see_tile = function (bot, tile) {
    if (!tile.visibleTo) return false;
    var list = Array.from(tile.visibleTo);
    for (var i = 0; i < list.length; i++) {
      var visibleSource = list[i];
      if (visibleSource.player() >= 0 && bot._map.is_player_on_team_with(visibleSource.player(), bot.targetPlayer)) return true;
    }
    return false;
  };

  BotCentralDefense._get_enemy_attack_path_fog_exit_tile = function (bot) {
    if (bot.enemy_attack_path === null || bot.enemy_attack_path.length <= 1) return null;

    var sawFog = false;
    var tileList = bot.enemy_attack_path.tileList;
    for (var i = 0; i < tileList.length; i++) {
      var tile = tileList[i];
      if (!tile.visible) {
        sawFog = true;
        continue;
      }
      if (sawFog) return tile;
    }
    return null;
  };

  EK.BotCentralDefense = BotCentralDefense;
  EK.centraldefense = BotCentralDefense;
})(typeof globalThis !== 'undefined' ? globalThis : this);
