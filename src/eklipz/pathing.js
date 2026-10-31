/* Human.exe 的 BotModules/BotPathingUtils.py（717 行）逐函数移植。
 *
 * 为什么这些函数都以 bot 为第一参数：原版里它们全是 staticmethod(bot, ...)，拿的是 bot 的
 * 全局状态（curPath / 距离矩阵 / 将军 / 目标玩家 / board_analysis）。改成传 bot 而不是闭包，
 * 是为了和 Python 侧保持一一对应，出差异时能直接对行号。
 *
 * 依赖宿主要提供的 bot 字段：
 *   bot.general, bot.targetPlayer, bot.player, bot.curPath, bot.curPathPrio,
 *   bot.expansion_plan, bot.armyTracker, bot.territories, bot.board_analysis,
 *   bot.leafMoves, bot.enemyCities, bot.shortest_path_to_target_player,
 *   bot.targetPlayerExpectedGeneralLocation, bot._gen_distances, bot._ally_distances,
 *   bot.is_weird_custom, bot.last_move, bot.viewInfo, bot.history
 * 依赖的兄弟模块（都允许为 null，缺了就走原版的兜底分支）：
 *   EK.BotDefense.general_move_safe / EK.BotStateQueries / EK.BotRepetition / EK.BotCombatOps
 */
(function (root) {
  var EK = (root.__EK = root.__EK || {});

  function bm(bot) {
    return bot.map || bot._map;
  }

  function generalPlayer(bot) {
    return bot.general.player();
  }

  // 原版 map.euclidDist(dx, dy) 是欧氏距离；JS 的 map.js 没搬这个函数（只有 manhattan_dist），
  // 这里就地实现，公式照 base/client/map.py。
  function euclidDist(x1, y1, x2, y2) {
    var dx = Math.abs(x1 - x2);
    var dy = Math.abs(y1 - y2);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function isMoveListPath(path) {
    return EK.MoveListPath && path instanceof EK.MoveListPath;
  }

  function isGatherCapturePlan(path) {
    return EK.GatherCapturePlan && path instanceof EK.GatherCapturePlan;
  }

  function BotPathingUtils() {}

  BotPathingUtils.get_undiscovered_count_on_path = function (bot, path) {
    var numFog = 0;
    var tiles = path.tileList;
    for (var i = 0; i < tiles.length; i++) {
      if (!tiles[i].discovered) numFog += 1;
    }
    return numFog;
  };

  BotPathingUtils.get_first_path_move = function (bot, path) {
    return path.get_first_move();
  };

  BotPathingUtils.is_move_safe_valid = function (bot, move, allowNonKill) {
    if (allowNonKill === undefined) allowNonKill = true;
    if (move === null || move === undefined) return false;
    if (move.source === bot.general) {
      return EK.BotDefense.general_move_safe(bot, move.dest);
    }
    if (move.source.player() !== move.dest.player() && move.source.army - 2 < move.dest.army && !allowNonKill) {
      return false;
    }
    return true;
  };

  /* 返回 [shouldUseMove, move]。move 为 null 但 shouldUseMove 为 true 表示"本回合就是不出招"。 */
  BotPathingUtils.continue_cur_path = function (bot, threat, defenseCriticalTileSet) {
    if (bot.expansion_plan && bot.expansion_plan.includes_intercept) {
      bot.curPath = null;
      return [false, null];
    }

    if (bot.curPath === null || bot.curPath === undefined) return [false, null];

    var nextMove = bot.curPath.get_first_move();

    if (nextMove === null || nextMove === undefined) {
      if (isMoveListPath(bot.curPath)) return [true, null];
      try {
        bot.curPath.pop_first_move();
      } catch (e) {
        bot.curPath = null;
      }
      return [false, null];
    }

    if (nextMove.dest.movable.indexOf(nextMove.source) < 0) {
      bot.curPath = null;
      return [false, null];
    }

    var inc = 0;
    while (
      nextMove &&
      (nextMove.source.army <= 1 || nextMove.source.player() !== bm(bot).player_index)
    ) {
      inc += 1;
      bot.curPath.pop_first_move();
      if (inc > 20) throw new Error('continue_cur_path: ' + inc + ' bad moves in a row, path is nonsense');
      try {
        nextMove = bot.curPath.get_first_move();
      } catch (e) {
        bot.curPath = null;
        return [false, null];
      }
    }

    if (nextMove === null || nextMove === undefined) return [false, null];

    if (nextMove.dest) {
      var dest = nextMove.dest;
      var source = nextMove.source;
      if (source.isGeneral && !EK.BotDefense.general_move_safe(bot, dest)) {
        if (EK.BotDefense.general_move_safe(bot, dest, true)) {
          return [true, new EK.Move(source, dest, true)];
        }
        bot.curPath = null;
        bot.curPathPrio = -1;
      } else {
        while (bot.curPath !== null && bot.curPath !== undefined) {
          if (
            defenseCriticalTileSet.has(nextMove.source) &&
            nextMove.source.army > 5 &&
            !(isMoveListPath(bot.curPath) && nextMove.dest.isCity && nextMove.dest.isNeutral)
          ) {
            bot.curPath = null;
            bot.curPathPrio = -1;
            if (threat !== null && threat !== undefined) {
              var killThreatPath = EK.BotCombatOps ? EK.BotCombatOps.kill_threat(bot, threat) : null;
              if (killThreatPath !== null && killThreatPath !== undefined) {
                bot.targetingArmy = bot.armyTracker.armies.get(threat.path.start.tile);
                return [true, BotPathingUtils.get_first_path_move(bot, killThreatPath)];
              }
            }
          } else if (nextMove.source.player() !== bm(bot).player_index || nextMove.source.army < 2) {
            bot.curPath.pop_first_move();
            try {
              nextMove = bot.curPath.get_first_move();
            } catch (e) {
              bot.curPath = null;
              return [false, null];
            }
          } else {
            break;
          }
        }
        if (bot.curPath !== null && bot.curPath !== undefined && nextMove.dest) {
          if (nextMove.source === bot.general && !EK.BotDefense.general_move_safe(bot, nextMove.dest, nextMove.move_half)) {
            bot.curPath = null;
            bot.curPathPrio = -1;
          } else {
            var move = bot.curPath.get_first_move();
            if (move !== null && move !== undefined) {
              var lastFrom = null;
              var lastTo = null;
              if (bm(bot).last_player_index_submitted_move) {
                lastFrom = bm(bot).last_player_index_submitted_move[0];
                lastTo = bm(bot).last_player_index_submitted_move[1];
              }

              if (move.source === lastFrom && move.dest === lastTo) {
                bot.curPath.pop_first_move();
                move = bot.curPath.get_first_move();
                if (move === null || move === undefined) {
                  bot.curPath = null;
                  bot.curPathPrio = -1;
                }
              }

              if (move !== null && move !== undefined) {
                return [true, EK.BotRepetition.move_half_on_repetition(bot, move, 6, 3)];
              }
            }
          }
        }
      }
    }

    bot.curPath = null;
    return [false, null];
  };

  BotPathingUtils.get_enemy_count_on_path = function (bot, path) {
    var numEn = 0;
    var tiles = path.tileList;
    for (var i = 0; i < tiles.length; i++) {
      if (bm(bot).is_tile_enemy(tiles[i])) numEn += 1;
    }
    return numEn;
  };

  BotPathingUtils.distance_from_general = function (bot, sourceTile) {
    if (sourceTile === bot.general) return 0;
    if (bot._gen_distances) {
      // 原版 _gen_distances 是 MapMatrix（按 tile 索引取值），JS 的 MapMatrix 要 .raw[tile_index]。
      var m = bot._gen_distances;
      var v = m.raw ? m.raw[sourceTile.tile_index] : m[sourceTile.tile_index];
      return v === undefined ? 0 : v;
    }
    return 0;
  };

  BotPathingUtils.distance_from_teammate = function (bot, sourceTile) {
    if (sourceTile === bot.teammate_general) return 0;
    if (EK.BotStateQueries.is_all_in(bot)) {
      var m = bot._ally_distances;
      var v = m.raw ? m.raw[sourceTile.tile_index] : m[sourceTile.tile_index];
      return v === undefined ? 0 : v;
    }
    return 0;
  };

  BotPathingUtils.is_path_moving_mostly_away = function (bot, path, bMap) {
    var tiles = path.tileList;
    var distSum = 0;
    for (var i = 0; i < tiles.length; i++) {
      distSum += bMap.raw ? bMap.raw[tiles[i].tile_index] : bMap[tiles[i].tile_index];
    }

    var distAvg = distSum / path.length;

    var distStart = bMap.raw ? bMap.raw[path.start.tile.tile_index] : bMap[path.start.tile.tile_index];
    var distEnd = bMap.raw ? bMap.raw[path.tail.tile.tile_index] : bMap[path.tail.tile.tile_index];

    var doesntAverageCloserToEnemySlightly = distEnd > distStart - Math.trunc(path.length / 4);
    var notHuntingNearby = distEnd > Math.trunc(bot.shortest_path_to_target_player.length / 6);

    if (notHuntingNearby && doesntAverageCloserToEnemySlightly && distAvg > distStart - Math.trunc(path.length / 4)) {
      return true;
    }
    return false;
  };

  BotPathingUtils.get_path_subsegment_starting_from_last_move = function (bot, launchPath) {
    var lastMoved = -1;
    if (bot.armyTracker.lastMove !== null && bot.armyTracker.lastMove !== undefined) {
      var i = 1;
      var tiles = launchPath.tileList;
      for (var ti = 0; ti < tiles.length; ti++) {
        var t = tiles[ti];
        if (bot.armyTracker.lastMove.source === t) {
          lastMoved = i;
          break;
        }
        if (bot.armyTracker.lastMove.dest === t) {
          lastMoved = i - 1;
          break;
        }
        i += 1;
      }
    }

    var cut = false;
    if (lastMoved >= 0 && lastMoved < launchPath.length) {
      if (lastMoved > 0) {
        var tilePre = launchPath.tileList[lastMoved - 1];
        if (tilePre.army <= 3 && launchPath.tileList[lastMoved].player() === generalPlayer(bot)) cut = true;
      } else {
        cut = true;
      }
    }
    if (cut) launchPath = launchPath.get_subsegment(launchPath.length - lastMoved, true);

    return launchPath;
  };

  BotPathingUtils.check_cur_path = function (bot) {
    if (bot.curPath === null || bot.curPath === undefined) return;
    if (bot.curPath.length === 0) {
      bot.curPath = null;
      return;
    }
    var move = null;
    try {
      move = bot.curPath.get_first_move();
    } catch (e) {
      move = null;
    }

    if (move === null || move === undefined) {
      // MoveListPath 本来就会经常返回 None
      if (isMoveListPath(bot.curPath)) return;
      bot.curPath = null;
      return;
    }

    if (move.source === null || move.dest === null || move.source === undefined || move.dest === undefined) {
      bot.curPath = null;
      return;
    }

    if (bot.curPath instanceof EK.Path && !isMoveListPath(bot.curPath)) {
      if (
        bot.curPath.start === null ||
        bot.curPath.tail === null ||
        bot.curPath.start.tile === null ||
        bot.curPath.start.next === null ||
        bot.curPath.start.next.tile === null ||
        bot.curPath.tail.tile === null
      ) {
        bot.curPath = null;
        return;
      }
      if (bot.curPath.start.tile.player() !== generalPlayer(bot)) {
        bot.curPath = null;
        return;
      }
      if (bot.curPath.length === 0) bot.curPath = null;
    }
  };

  BotPathingUtils.clean_up_path_before_evaluating = function (bot) {
    if (bot.curPath === null || bot.curPath === undefined) return;

    if (bot.curPath.length === 0) {
      bot.curPath = null;
      return;
    }

    if (isGatherCapturePlan(bot.curPath)) {
      var firstMove = bot.curPath.get_first_move();
      var thresh = bot.curPath.gathered_army / bot.curPath.length / 2 + 0.5;
      while (
        firstMove !== null &&
        firstMove !== undefined &&
        (firstMove.source.army < thresh || firstMove.source.player() !== bot.player.index)
      ) {
        bot.curPath.pop_first_move();
        firstMove = bot.curPath.get_first_move();
      }
    }

    if (!(bot.curPath instanceof EK.Path)) return;

    var nextMove = bot.curPath.get_first_move();
    var start = bot.curPath.start;
    if (
      (bot.last_move === null && (nextMove === null || nextMove === undefined)) ||
      (start !== null && start.next !== null && !EK.BotRepetition.dropped_move(bot, start.tile, start.next.tile))
    ) {
      bot.curPath.pop_first_move();
      if (bot.curPath.length <= 0) bot.curPath = null;
      if (bot.curPath !== null && bot.curPath !== undefined) {
        var s = bot.curPath.start;
        if (s !== null && s.next !== null && s.next.next !== null && s.next.next.next !== null &&
            s.tile === s.next.next.tile && s.next.tile === s.next.next.next.tile) {
          bot.curPath.pop_first_move();
          bot.curPath.pop_first_move();
          bot.curPath.pop_first_move();
          bot.curPath.pop_first_move();
        } else if (s !== null && s.next !== null && s.tile.x === s.next.tile.x && s.tile.y === s.next.tile.y) {
          bot.curPath.pop_first_move();
          bot.curPath.pop_first_move();
        }
      }
    }
  };

  /* 原版在这里直接 `return path`（后面的实现是死代码），照抄这个行为，
   * 把死代码留在注释里而不是搬进来 —— 搬进来只会在调试时误导人。 */
  BotPathingUtils.get_value_per_turn_subsegment = function (bot, path, minFactor, minLengthFactor, negativeTiles) {
    return path;
  };

  BotPathingUtils.get_path_to_target = function (bot, target, maxTime, maxDepth, skipNeutralCities, skipEnemyCities, preferNeutral, fromTile, preferEnemy, maxObstacleCost, avoidEnemyVision, avoidUsingExpandables) {
    if (maxTime === undefined) maxTime = 0.1;
    if (maxDepth === undefined) maxDepth = 400;
    if (skipNeutralCities === undefined) skipNeutralCities = true;
    if (skipEnemyCities === undefined) skipEnemyCities = false;
    if (preferNeutral === undefined) preferNeutral = true;
    if (fromTile === undefined) fromTile = null;
    if (preferEnemy === undefined) preferEnemy = false;
    if (maxObstacleCost === undefined) maxObstacleCost = null;
    if (avoidEnemyVision === undefined) avoidEnemyVision = false;
    if (avoidUsingExpandables === undefined) avoidUsingExpandables = true;
    var targets = new Set();
    targets.add(target);
    return BotPathingUtils.get_path_to_targets(bot, targets, maxTime, maxDepth, skipNeutralCities, skipEnemyCities, preferNeutral, fromTile, preferEnemy, maxObstacleCost, null, avoidEnemyVision, avoidUsingExpandables);
  };

  BotPathingUtils.is_move_towards_enemy = function (bot, move) {
    if (move === null || move === undefined) return false;
    if (bot.targetPlayer === null || bot.targetPlayer === undefined) return false;
    var dists = bot.territories.territoryDistances[bot.targetPlayer];
    var srcD = dists.raw ? dists.raw[move.source.tile_index] : dists[move.source.tile_index];
    var dstD = dists.raw ? dists.raw[move.dest.tile_index] : dists[move.dest.tile_index];
    return srcD > dstD;
  };

  BotPathingUtils.is_tile_in_range_from = function (bot, source, target, maxDist, minDist) {
    if (minDist === undefined) minDist = 0;
    var dist = 1000;
    if (target === bot.general) {
      dist = BotPathingUtils.distance_from_general(bot, source);
    } else if (target === bot.targetPlayerExpectedGeneralLocation) {
      dist = BotPathingUtils.distance_from_opp(bot, source);
    } else {
      var captDist = [dist];
      EK.search.breadth_first_foreach_dist(bm(bot), [source], maxDist + 1, function (tile, d) {
        if (tile.x === target.x && tile.y === target.y) captDist[0] = d;
        return tile.isObstacle;
      });
      dist = captDist[0];
    }
    return minDist <= dist && dist <= maxDist;
  };

  BotPathingUtils.get_euclid_shortest_from_tile_towards_target = function (bot, sourceTile, towardsTile) {
    var shortest = 100;
    var shortestTile = null;
    var movable = sourceTile.movable;
    for (var i = 0; i < movable.length; i++) {
      var adj = movable[i];
      if (adj.isObstacle) continue;
      var dist = euclidDist(towardsTile.x, towardsTile.y, adj.x, adj.y);
      if (dist < shortest) {
        shortest = dist;
        shortestTile = adj;
      }
    }
    return new EK.Move(sourceTile, shortestTile);
  };

  BotPathingUtils.get_path_to_targets = function (bot, targets, maxTime, maxDepth, skipNeutralCities, skipEnemyCities, preferNeutral, fromTile, preferEnemy, maxObstacleCost, negativeTiles, avoidEnemyVision, avoidUsingExpandables) {
    if (maxTime === undefined) maxTime = 0.1;
    if (maxDepth === undefined) maxDepth = 400;
    if (skipNeutralCities === undefined) skipNeutralCities = true;
    if (skipEnemyCities === undefined) skipEnemyCities = false;
    if (preferNeutral === undefined) preferNeutral = true;
    if (fromTile === undefined) fromTile = null;
    if (preferEnemy === undefined) preferEnemy = true;
    if (maxObstacleCost === undefined) maxObstacleCost = null;
    if (negativeTiles === undefined) negativeTiles = null;
    if (avoidEnemyVision === undefined) avoidEnemyVision = false;
    if (avoidUsingExpandables === undefined) avoidUsingExpandables = true;

    var map = bm(bot);
    // 原版 goal func 用 `tile in targets`，list/set 都能吃；JS 这里必须统一成 Set，
    // 否则 cityops 传进来的数组会在 targets.has 上炸（.has is not a function）。
    if (!(targets instanceof Set)) targets = new Set(targets || []);
    if (fromTile === null) fromTile = bot.general;
    if (negativeTiles !== null) negativeTiles = new Set(negativeTiles);
    if (skipEnemyCities) {
      if (negativeTiles === null) negativeTiles = new Set();
      for (var ci = 0; ci < bot.enemyCities.length; ci++) negativeTiles.add(bot.enemyCities[ci]);
    }

    if (maxObstacleCost === null && bot.is_weird_custom) maxObstacleCost = map.walled_city_base_value;

    // 优先绕开"还能往外扩张的叶子格"：那些格子留着当扩张口更值钱。
    var avoidExpandables = new Map();

    var teams = map.team_ids_by_player_index;
    var frTeam = bot.player.team;

    if (avoidUsingExpandables) {
      for (var li = 0; li < bot.leafMoves.length; li++) {
        var mv = bot.leafMoves[li];
        if (mv.source.army - 1 <= mv.dest.army) continue;
        var refs = avoidExpandables.get(mv.source.tile_index) || 0;
        avoidExpandables.set(mv.source.tile_index, refs + 1);
        refs = avoidExpandables.get(mv.dest.tile_index) || 0;
        avoidExpandables.set(mv.dest.tile_index, refs + 1);
      }
    }

    // 避开敌人视野：原版用 armyTracker.visible_tiles_by_player[player]（Python 是 MapMatrixSet，
    // 迭代得出格子）；JS 侧同一字段也是 MapMatrixSet，必须走 toTiles，按 length/下标遍历会静默空转。
    if (avoidEnemyVision && bot.targetPlayer !== -1) {
      var vis = bot.armyTracker.visible_tiles_by_player[bot.targetPlayer];
      if (vis) {
        var visArr = typeof vis.toTiles === 'function' ? vis.toTiles() : (vis instanceof Set ? Array.from(vis) : vis);
        for (var vi = 0; vi < visArr.length; vi++) avoidExpandables.set(visArr[vi].tile_index, 1);
      }
    }

    var isFfaSit = EK.BotTargeting ? EK.BotTargeting.is_ffa_situation(bot) : false;

    function path_to_targets_priority_func(nextTile, currentPriorityObject) {
      var dist = currentPriorityObject[0];
      var negEnemyTiles = currentPriorityObject[1];
      var negCityCount = currentPriorityObject[2];
      var negArmySum = currentPriorityObject[3];
      var goalIncrement = currentPriorityObject[4];
      dist += 1;

      if (nextTile.isCity) {
        if (skipEnemyCities && map.is_tile_enemy(nextTile)) return null;
        if (nextTile.player() === -1 && maxObstacleCost !== null && nextTile.army >= maxObstacleCost) return null;
      }

      if (nextTile.army <= 1 && teams[nextTile.player()] === frTeam) {
        negEnemyTiles += 2;
        negArmySum += 2;
      }

      if (preferEnemy && !EK.BotStateQueries.is_all_in(bot)) {
        if (map.is_tile_on_team_with(nextTile, bot.targetPlayer)) {
          negEnemyTiles -= 1;
          if (nextTile.isCity) negCityCount -= 1;
        }

        if (!isFfaSit) {
          if (!nextTile.visible) negEnemyTiles -= 0.2;
          if (!nextTile.discovered) negEnemyTiles -= 0.2;
        }
      }

      if (negativeTiles === null || !negativeTiles.has(nextTile)) {
        if (nextTile.isNeutral) {
          if (nextTile.army <= 0 || (nextTile.isCity && nextTile.army < bot.player.standingArmy)) {
            if (preferNeutral) {
              negEnemyTiles -= 0.5;
              if (nextTile.isCity) negCityCount -= 1;
            }
          } else {
            negEnemyTiles += 2;
            dist += Math.min(nextTile.army + 1, 8);
          }
        }
        if (map.is_tile_friendly(nextTile)) negArmySum -= nextTile.army;
        else negArmySum += nextTile.army;
      }

      var refs2 = avoidExpandables.get(nextTile.tile_index) || 0;
      if (refs2 > 0) {
        // 让那些"还能往外扩的 2"更容易被留下：这一格消耗掉一个出口，但旁边的 2 还有别的口。
        negArmySum += 0.5 * refs2;
        negEnemyTiles += 1.0 * refs2;
      }

      negArmySum += 1 - goalIncrement;
      return [dist, negEnemyTiles, negCityCount, negArmySum, goalIncrement];
    }

    var startPriorityObject = [0, 0, 0, 0, 0.5];
    var startTiles = new Map();
    startTiles.set(fromTile, [startPriorityObject, 0]);

    return EK.search.breadth_first_dynamic(map, startTiles, function (tile) {
      return targets.has(tile);
    }, {
      maxDepth: maxDepth,
      noNeutralCities: skipNeutralCities,
      negativeTiles: negativeTiles,
      priorityFunc: path_to_targets_priority_func
    });
  };

  BotPathingUtils.get_path_subsegment_to_closest_enemy_team_territory = function (bot, path) {
    var idx = 0;
    var team = bot.targetPlayerObj.team;
    var teamDists = bot.territories.territoryTeamDistances[team];

    function td(tile) {
      return teamDists.raw ? teamDists.raw[tile.tile_index] : teamDists[tile.tile_index];
    }

    var minDist = td(path.start.tile);
    var minIdx = 100;
    var tiles = path.tileList;
    for (var i = 0; i < tiles.length; i++) {
      var thisDist = td(tiles[i]);
      if (thisDist < minDist) {
        minDist = thisDist;
        minIdx = idx;
      }
      idx += 1;
    }

    if (minIdx === 100) return null;
    return path.get_subsegment(minIdx);
  };

  BotPathingUtils.distance_from_opp = function (bot, sourceTile) {
    if (sourceTile === bot.targetPlayerExpectedGeneralLocation) return 0;
    if (bot.board_analysis && bot.board_analysis.intergeneral_analysis) {
      var bMap = bot.board_analysis.intergeneral_analysis.bMap;
      var v = bMap.raw ? bMap.raw[sourceTile.tile_index] : bMap[sourceTile.tile_index];
      return v === undefined ? 0 : v;
    }
    return 0;
  };

  BotPathingUtils.distance_from_target_path = function (bot, sourceTile) {
    if (bot.shortest_path_to_target_player && bot.shortest_path_to_target_player.tileSet.has(sourceTile)) return 0;
    if (bot.board_analysis && bot.board_analysis.shortest_path_distances) {
      var m = bot.board_analysis.shortest_path_distances;
      var v = m.raw ? m.raw[sourceTile.tile_index] : m[sourceTile.tile_index];
      return v === undefined ? 0 : v;
    }
    return 0;
  };

  BotPathingUtils.get_distance_from_board_center = function (bot, tile, center_ratio) {
    if (center_ratio === undefined) center_ratio = 0.25;
    var map = bm(bot);
    var distFromCenterX = Math.abs(map.cols / 2 - tile.x);
    var distFromCenterY = Math.abs(map.rows / 2 - tile.y);
    distFromCenterX -= map.cols * center_ratio;
    distFromCenterY -= map.rows * center_ratio;
    if (distFromCenterX < 0) distFromCenterX = 0;
    if (distFromCenterY < 0) distFromCenterY = 0;
    return distFromCenterX + distFromCenterY;
  };

  /* 原版注释：用来保证"本回合剩 3 步，但某条 4 步的抢城路线仍然值得选"这类决策不被回合末截断。
   * 注意它只改 length/econValue，不真的裁 tileList。 */
  BotPathingUtils.get_truncated_expansion_option = function (opt, toTurns) {
    var shortOpt = opt;
    if (opt instanceof EK.Path) {
      shortOpt = opt.get_subsegment(toTurns);
    } else if (EK.InterceptionOptionInfo && opt instanceof EK.InterceptionOptionInfo) {
      shortOpt = opt.path.get_subsegment(toTurns);
    } else if (isGatherCapturePlan(opt)) {
      shortOpt = opt.clone();
      shortOpt._turns = toTurns;
    } else {
      shortOpt = opt.clone ? opt.clone() : opt;
      shortOpt.turns = toTurns;
    }

    // 价值按它在完整路径里占的回合比例折算
    shortOpt.econValue = (toTurns * opt.econValue) / opt.length;
    return shortOpt;
  };

  EK.BotPathingUtils = BotPathingUtils;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
