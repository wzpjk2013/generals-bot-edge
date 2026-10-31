/*
 * BotCityOps 移植
 *
 * 原版：E:\akcoco6de\_research\generals-bot-cs\BotModules\BotCityOps.py（1908 行）
 *
 * 算法一句话：城不是「走一格」，是「先攒够兵再一口气打进城里」—— 这里负责
 * 判断该不该打城（经济/威胁/兵力对比）、挑哪座城（中立按经济分，敌方按
 * 就近一刀）、然后用 gather 把兵集到城边、最后把 gather 树剪成一条能执行的路。
 *
 * bot 需要的字段（鸭子类型，缺哪个就走「信息不存在」那条分支）：
 *   bot.map / bot._map        EK.Map
 *   bot.general               我方将军 Tile
 *   bot.player                EK.Player（standingArmy / cityCount / tileCount）
 *   bot.targetPlayer          int，-1 表示还没锁定对手
 *   bot.targetPlayerObj       EK.Player
 *   bot.cityAnalyzer          EK.CityAnalyzer
 *   bot.board_analysis        EK.BoardAnalyzer
 *   bot.territories           EK.TerritoryClassifier
 *   bot.armyTracker           EK.ArmyTracker
 *   bot.opponent_tracker      EK.OpponentTracker
 *   bot.dangerAnalyzer        EK.DangerAnalyzer
 *   bot.win_condition_analyzer 状态壳（viable_win_conditions / defend_cities / contestable_cities）
 *   bot.timings               get_turn_in_cycle / get_turns_left_in_cycle
 *   bot.viewInfo              可为 null
 *   bot.expansion_plan        可为 null
 *   bot.shortest_path_to_target_player  可为 null
 *
 * 没搬 / 降级的部分，以及为什么（逐条）：
 * 1. BotTargeting / BotCombatOps / BotGatherOps / BotPathingUtils / BotStateQueries /
 *    BotDefense / Gather / ExpandUtils 这些都是 JS 侧已存在的模块，直接按名字解析
 *    （_mod('BotTargeting').find_enemy_city_path(...)）。解析不到就按「信息不存在」降级，
 *    并把名字记进 degrade 表（EK.BotCityOps.report() 可查），不抛异常 ——
 *    一个缺模块不应该让整局崩在城里。
 * 2. BotCombatQueries（find_large_tiles_near / count_enemy_territory_near_tile）没移植。
 *    前者用本地 find_large_tiles_near 复刻（同目标点、同距离、同 limit/minArmy 语义），
 *    后者用本地 count_enemy_territory_near_tile（同队格计数）。
 * 3. BotCityCaptureControl.block_neutral_captures 没移植，直接置
 *    bot.is_blocking_neutral_city_captures = true，语义一样（原版也只做这件事+日志）。
 * 4. Gather.prune_mst_to_army_with_values / prune_mst_to_max_army_per_turn_with_values 在
 *    gather.js 里没有导出（那边只导出了 prune_mst_to_army / prune_mst_to_turns，见 gather.js:2208）。
 *    这里用 prune_to_army_values() 包一层：先 prune_mst_to_army 剪到目标兵力，再自己
 *    累加 turns/value —— 和原版返回的 (turns, value, nodes) 同一口径。城市增量会计没搬，
 *    理由同 gather.js 文件头第 4 条（那份会计在 1e9 调用下恒不生效）。
 * 5. bot.hunt_for_fog_neutral_city（原版在 bot 主循环里）JS 侧没有 → 迷雾猎城分支跳过，
 *    继续走「直接 all-in」的判断。
 * 6. WinConditionAnalyzer 的 get_approximate_attack_against /
 *    get_dynamic_turns_visible_defense_against / recommended_*_plan_turns 在 JS 里是空壳。
 *    缺 get_approximate_attack_against → risk 记 0（保守方向：不因为「算不出的威胁」而
 *    否决拿城，否则会永远不拿城，正是现在终局 0 城的病）；缺
 *    get_dynamic_turns_visible_defense_against → defValue 记 0。
 * 7. BotDefense.get_best_defense / _get_flank_vision_defense_move_internal 在 defense.js 里
 *    没有（见 defense.js 文件头第 5 条），这里降级为「没有更好的防守」→ 不做 bypass。
 *    后果是快杀城时少了「敌方其实更容易防守」这个否决，偏激进。
 * 8. 日志、viewInfo 上色、DebugHelper 分支全部丢弃。viewInfo 只在原版会写
 *    evaluatedGrid 的位置保留（那些值会影响后续搜索的观感，对走子无影响，保留是为了
 *    和原版一样不把同一座城重复评估）。
 * 9. 计时（maxTime）参数照收但不用：移植版必须同输入同输出，时间片会破坏这个性质。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---------------- 收口层 ---------------- */

  function mapOf(bot) {
    return bot.map || bot._map;
  }

  // tile.player 在 JS 侧是方法，在原版是属性；这里统一折成方法调用。
  function playerOf(tile) {
    if (tile === null || tile === undefined) return -1;
    return typeof tile.player === 'function' ? tile.player() : tile._player;
  }

  // EK.Tile 的 player 是方法，将军格也是 Tile；原版写 gplayer(bot.general) 是属性。
  function gplayer(tile) {
    if (!tile) return -1;
    if (typeof tile.player === 'function') return tile.player();
    if (tile._player !== undefined) return tile._player;
    return -1;
  }

  function toArr(coll) {
    if (coll === null || coll === undefined) return [];
    if (Array.isArray(coll)) return coll;
    if (typeof coll === 'function') return [];
    if (typeof coll[Symbol.iterator] === 'function') return Array.from(coll);
    return [];
  }

  function copySet(coll) {
    return new Set(toArr(coll));
  }

  // Python set 的迭代序是哈希序，JS 是全序随机序；凡是要跑搜索/挑第一个的地方
  // 一律按 tile_index 升序，保证同输入同输出。
  function sortedByIndex(coll) {
    var arr = toArr(coll);
    arr.sort(function (a, b) { return a.tile_index - b.tile_index; });
    return arr;
  }

  function anyWhere(coll, fn) {
    var arr = toArr(coll);
    for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return true;
    return false;
  }

  function countWhere(coll, fn) {
    var arr = toArr(coll);
    var n = 0;
    for (var i = 0; i < arr.length; i++) if (fn(arr[i])) n += 1;
    return n;
  }

  function rawAt(mm, tile) {
    if (!mm || !mm.raw) return 0;
    var v = mm.raw[tile.tile_index];
    return v === undefined || v === null ? 0 : v;
  }

  function info(bot, msg) {
    if (bot && typeof bot.info === 'function') bot.info(msg);
  }

  // ---- 缺模块登记 ----
  var _degrade = {};
  function degraded(name) {
    _degrade[name] = (_degrade[name] || 0) + 1;
  }

  function mod(name) {
    return EK[name] || null;
  }

  // 按名字调已移植模块的函数；缺失就登记降级并返回 dflt，绝不抛。
  function call(name, fnName, args, dflt) {
    var m = mod(name);
    if (m && typeof m[fnName] === 'function') return m[fnName].apply(m, args);
    degraded(name + '.' + fnName);
    return dflt;
  }

  // ---- viewInfo 空壳 ----
  function vi(bot) {
    return (bot && bot.viewInfo) || null;
  }
  function viInfo(bot, text) {
    var v = vi(bot);
    if (v && typeof v.add_info_line === 'function') v.add_info_line(text);
  }
  function viStats(bot, text) {
    var v = vi(bot);
    if (v && typeof v.add_stats_line === 'function') v.add_stats_line(text);
  }
  function viTargeted(bot, tile, style) {
    var v = vi(bot);
    if (v && typeof v.add_targeted_tile === 'function') v.add_targeted_tile(tile, style);
  }
  function viEvaluated(bot, x, y, val) {
    var v = vi(bot);
    if (v && v.evaluatedGrid && v.evaluatedGrid[x]) v.evaluatedGrid[x][y] = val;
  }

  function timings(bot) {
    return (bot && bot.timings) || null;
  }
  function cycleTurn(bot) {
    var t = timings(bot);
    if (t && typeof t.get_turn_in_cycle === 'function') return t.get_turn_in_cycle(mapOf(bot).turn);
    return mapOf(bot).turn % 50;
  }
  function turnsLeftInCycle(bot) {
    var t = timings(bot);
    if (t && typeof t.get_turns_left_in_cycle === 'function') return t.get_turns_left_in_cycle(mapOf(bot).turn);
    return 50 - cycleTurn(bot);
  }

  function wca(bot) {
    return (bot && bot.win_condition_analyzer) || null;
  }
  function hasWinCondition(bot, name) {
    var w = wca(bot);
    if (!w) return false;
    var vc = w.viable_win_conditions;
    if (!vc) return false;
    if (typeof vc.has === 'function') return vc.has(name);
    return toArr(vc).indexOf(name) >= 0;
  }

  function distFromGeneral(bot, tile) {
    return call('BotPathingUtils', 'distance_from_general', [bot, tile], 999);
  }

  function distanceBetween(bot, a, b) {
    var map = mapOf(bot);
    if (map && map.distance_mapper && typeof map.distance_mapper.get_distance_between === 'function') {
      return map.distance_mapper.get_distance_between(a, b);
    }
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function isNeutralTile(tile) {
    return playerOf(tile) === -1;
  }

  function teamOfTile(map, tile) {
    return map.team_ids_by_player_index[playerOf(tile)];
  }

  function isOnTeamWith(map, tile, player) {
    return map.is_player_on_team_with(player, playerOf(tile));
  }

  function isEnemyTile(bot, tile) {
    return !isOnTeamWith(mapOf(bot), tile, gplayer(bot.general));
  }

  // BotCombatQueries.find_large_tiles_near 的本地复刻：同目标集合外扩 dist 圈，
  // 收同队且 army >= minArmy 的格，按 army 降序取前 limit。
  function find_large_tiles_near(bot, targets, dist, forPlayer, limit, minArmy) {
    if (limit === undefined) limit = 30;
    if (minArmy === undefined) minArmy = 1;
    var map = mapOf(bot);
    var seen = new Set();
    var out = [];
    var frontier = toArr(targets).slice();
    var depth = 0;
    while (frontier.length > 0 && depth <= dist) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var t = frontier[i];
        if (seen.has(t)) continue;
        seen.add(t);
        if (t.army >= minArmy && map.is_player_on_team_with(forPlayer, playerOf(t))) out.push(t);
        var mov = toArr(t.movable);
        for (var k = 0; k < mov.length; k++) if (!seen.has(mov[k])) next.push(mov[k]);
      }
      frontier = next;
      depth += 1;
    }
    out.sort(function (a, b) {
      if (b.army !== a.army) return b.army - a.army;
      return a.tile_index - b.tile_index;
    });
    return out.slice(0, limit);
  }

  // BotCombatQueries.count_enemy_territory_near_tile 的本地复刻
  function count_enemy_territory_near_tile(bot, tile, dist) {
    var map = mapOf(bot);
    var seen = new Set();
    var n = 0;
    var frontier = [tile];
    var depth = 0;
    while (frontier.length > 0 && depth <= dist) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var t = frontier[i];
        if (seen.has(t)) continue;
        seen.add(t);
        if (!map.is_player_on_team_with(gplayer(bot.general), playerOf(t))) n += 1;
        var mov = toArr(t.movable);
        for (var k = 0; k < mov.length; k++) if (!seen.has(mov[k])) next.push(mov[k]);
      }
      frontier = next;
      depth += 1;
    }
    return n;
  }

  /* ==================================================================
   * BotCityOps
   * ================================================================== */

  function BotCityOps() { }

  BotCityOps._format_city_safety_tiles = function (tiles) {
    var arr = sortedByIndex(tiles);
    var parts = [];
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      parts.push(t.x + ',' + t.y + ':p' + playerOf(t) + ':a' + t.army + ':vis' + t.visible + ':disc' + t.discovered);
    }
    parts.sort();
    return parts.join(' | ');
  };

  // 原版只写日志；保留函数是为了调用点一一对应
  BotCityOps._log_city_capture_negative_tile_state = function (bot, context, targetCity, negativeTiles) { };

  BotCityOps._log_city_defense_tile_contribution = function (bot, tile, targetCity, defTile, defTurns, contribution) { };

  BotCityOps._get_city_defense_tile_contribution = function (bot, tile, targetCity, defTile, defTurns) {
    var spareArmy = Math.max(0, tile.army - 1);
    if (spareArmy <= 0) return 0;

    var cityDist = distanceBetween(bot, targetCity, tile);
    var defDist = distanceBetween(bot, defTile, tile);
    var generalDist = distFromGeneral(bot, tile);
    var cityToDefDist = distanceBetween(bot, targetCity, defTile);
    var reclaimWindow = defTurns - Math.max(cityDist, defDist);
    var reclaimPenalty = Math.max(cityDist, defDist) + Math.max(0, generalDist - cityToDefDist);
    var contribution = Math.max(0, spareArmy - reclaimPenalty);

    if (reclaimWindow <= 0) {
      contribution = 0;
    } else if (reclaimWindow < 4) {
      contribution = Math.min(contribution, Math.max(0, Math.trunc(spareArmy / 3)));
    } else if (reclaimWindow < 7) {
      contribution = Math.min(contribution, Math.max(0, Math.trunc(spareArmy / 2)));
    }

    return contribution;
  };

  // BotCityOps.py:114 capture_cities
  BotCityOps.capture_cities = function (bot, negativeTiles, forceNeutralCapture) {
    var res = BotCityOps.capture_cities_with_plan_option(bot, negativeTiles, forceNeutralCapture);
    return [res[0], res[1]];
  };

  // BotCityOps.py:127 capture_cities_with_plan_option
  BotCityOps.capture_cities_with_plan_option = function (
    bot, negativeTiles, forceNeutralCapture, includeContestOption,
    ignoreContestSuppressionForNeutral, preferNeutralCapture) {

    if (forceNeutralCapture === undefined) forceNeutralCapture = false;
    if (includeContestOption === undefined) includeContestOption = true;
    if (ignoreContestSuppressionForNeutral === undefined) ignoreContestSuppressionForNeutral = false;
    if (preferNeutralCapture === undefined) preferNeutralCapture = false;

    var map = mapOf(bot);
    var general = bot.general;
    negativeTiles = copySet(negativeTiles);

    var isAllIn = call('BotStateQueries', 'is_all_in', [bot], false);
    if (isAllIn && !bot.all_in_city_behind) return [null, null, null];

    var killSearchDist = 3;
    var genDist = Math.min(30, distFromGeneral(bot, bot.targetPlayerExpectedGeneralLocation));
    if (!(distFromGeneral(bot, bot.targetPlayerExpectedGeneralLocation) > 20)) {
      killSearchDist = Math.max(4, Math.trunc(genDist * 0.2));
    }
    var isNeutCity = false;
    var wasCityAllIn = bot.all_in_city_behind;

    var cityAnalyzer = bot.cityAnalyzer;
    var tileScores = cityAnalyzer ? cityAnalyzer.get_sorted_neutral_scores() : [];
    var enemyTileScores = cityAnalyzer ? cityAnalyzer.get_sorted_enemy_scores() : [];

    var rapidCityPath = BotCityOps.find_rapid_city_path(bot);
    if (rapidCityPath !== null) {
      BotCityOps._apply_city_capture_plan_value(bot, rapidCityPath, rapidCityPath.tail.tile);
      return [rapidCityPath, null, rapidCityPath];
    }

    var neutPath = BotCityOps.find_neutral_city_path(bot, ignoreContestSuppressionForNeutral);

    var desiredGatherTurns = -1;
    var defendCities = wca(bot) && wca(bot).defend_cities ? copySet(wca(bot).defend_cities) : new Set();
    var enemyPathRes = call('BotTargeting', 'find_enemy_city_path',
      [bot, defendCities, neutPath === null], [null, null]);
    var path = enemyPathRes ? enemyPathRes[1] : null;
    if (enemyPathRes && enemyPathRes[0] !== null && enemyPathRes[0] !== undefined) desiredGatherTurns = enemyPathRes[0];

    var player = map.players[gplayer(general)];
    var largestTile = general;
    var pTiles = toArr(player.tiles);
    for (var i = 0; i < pTiles.length; i++) {
      if (pTiles[i].army > largestTile.army) largestTile = pTiles[i];
    }

    var mustContestEnemy = false;
    if (path !== null && path !== undefined) {
      var enCity = path.tail.tile;
      var inEnemyTerritory = bot.territories
        ? bot.territories.is_tile_in_enemy_territory(enCity) : false;
      if (!inEnemyTerritory && enCity.discovered) mustContestEnemy = true;
    }

    var ourCityCounts = map.players[gplayer(general)].cityCount;
    if (bot.teammate_general !== null && bot.teammate_general !== undefined) {
      ourCityCounts += map.players[gplayer(bot.teammate_general)].cityCount;
    }

    if (map.is_2v2 && map.remainingPlayers === 3 && bot.targetPlayerObj
      && bot.targetPlayerObj.cityCount <= ourCityCounts) {
      mustContestEnemy = true;
    }

    var shouldAllowNeutralCapture = BotCityOps.should_allow_neutral_city_capture(
      bot, player, forceNeutralCapture,
      neutPath !== null && neutPath !== undefined ? neutPath.tail.tile : null);

    var contestMove = null;
    var contestGatherVal = 0;
    var contestGatherTurns = 100;
    var contestGatherNodes = null;
    if (includeContestOption && hasWinCondition(bot, 'ContestEnemyCity') && shouldAllowNeutralCapture) {
      var contest = BotCityOps.get_city_contestation_all_in_move(bot, negativeTiles);
      contestMove = contest[0];
      contestGatherVal = contest[1];
      contestGatherTurns = contest[2];
      contestGatherNodes = contest[3];
      if (contestMove !== null && contestMove !== undefined) return [null, contestMove, null];
    }

    if (!mustContestEnemy && shouldAllowNeutralCapture) {
      if (neutPath && (preferNeutralCapture || bot.targetPlayer === -1
        || path === null || path === undefined || neutPath.length < path.length / 4)) {
        path = neutPath;
        isNeutCity = true;
      }
    }

    if (path === null || path === undefined) {
      if (bot.quick_kill_city_plan_option !== null && bot.quick_kill_city_plan_option !== undefined) {
        info(bot, 'NO ENEMY CITY FOUND but we already had a quick kill');
        return [null, null, null];
      }

      var downOnCities = true;
      if (bot.opponent_tracker && typeof bot.opponent_tracker.even_or_up_on_cities === 'function') {
        downOnCities = !bot.opponent_tracker.even_or_up_on_cities(bot.targetPlayer);
      } else {
        degraded('OpponentTracker.even_or_up_on_cities');
      }
      if (downOnCities) {
        var cTurn = cycleTurn(bot);

        var cityHuntTurns = 10;
        var moreThanTwoTeams = call('BotTargeting', 'are_more_teams_alive_than', [bot, 2], false);
        if (cTurn < cityHuntTurns && !moreThanTwoTeams && shouldAllowNeutralCapture) {
          // bot.hunt_for_fog_neutral_city 是 bot 主循环里的方法，JS 侧没有
          var hunt = typeof bot.hunt_for_fog_neutral_city === 'function'
            ? bot.hunt_for_fog_neutral_city(negativeTiles, cTurn % cityHuntTurns) : null;
          if (hunt) {
            var revealPath = hunt[0];
            var huntMove = hunt[1];
            if (huntMove || revealPath) {
              info(bot, 'hunting fog neutral city');
              return [revealPath, huntMove, revealPath];
            }
          } else {
            degraded('bot.hunt_for_fog_neutral_city');
          }
        }

        if (!bot.all_in_city_behind) {
          if (cTurn < 5) {
            info(bot, 'Going all in, down on cities and no city path found.');
            bot.is_all_in_army_advantage = true;
            bot.is_all_in_losing = true;
            bot.all_in_city_behind = true;
            if (EK.ExpansionPotential) {
              bot.expansion_plan = new EK.ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);
            }
            bot.city_expand_plan = null;
            bot.enemy_expansion_plan = null;
            call('BotTimings', 'set_all_in_cycle_to_hit_with_current_timings', [bot, 50, 5], null);
            return [null, null, null];
          }
        }
      }

      bot.all_in_city_behind = false;
      return [null, null, null];
    }

    if (bot.all_in_city_behind && (hasWinCondition(bot, 'WinOnEconomy')
      || hasWinCondition(bot, 'DefendEconomicLead')
      || hasWinCondition(bot, 'DefendContestedFriendlyCity'))) {
      info(bot, 'Ceasing all-in, hold');
      bot.all_in_city_behind = false;
      bot.is_all_in_army_advantage = false;
      bot.is_all_in_losing = false;
      bot.all_in_army_advantage_counter = 0;
    }

    var target = path.tail.tile;
    if (player.standingArmy + 5 <= target.army) return [null, null, null];

    var enemyArmyNearDist = 3;
    var enemyArmyNear = call('BotCombatOps', 'sum_enemy_army_near_tile', [bot, target, enemyArmyNearDist], 0);
    var captureNegs = negativeTiles;
    BotCityOps._log_city_capture_negative_tile_state(bot, 'capture_cities_before_enemy_near', target, captureNegs);
    if (enemyArmyNear > 0) {
      captureNegs = copySet(captureNegs);
      var tgPlayer = playerOf(target);
      if (tgPlayer === -1) tgPlayer = bot.targetPlayer;
      var killNegs = find_large_tiles_near(bot, [target], enemyArmyNearDist, tgPlayer, 30, 1);
      for (var ki = 0; ki < killNegs.length; ki++) {
        var kt = killNegs[ki];
        if (kt !== target) captureNegs.add(kt);
      }
    }
    BotCityOps._log_city_capture_negative_tile_state(bot, 'capture_cities_after_enemy_near', target, captureNegs);

    var targetArmy = enemyArmyNear;

    var targetInOurTerritory = bot.territories
      ? map.is_player_on_team_with(gplayer(general), rawAtTerritory(bot, target)) : false;
    if (!isNeutCity && !targetInOurTerritory) {
      targetArmy = Math.max(2, Math.trunc(
        call('BotCombatOps', 'sum_enemy_army_near_tile', [bot, target, 2], 0) * 1.1));
    } else {
      killSearchDist = 3;
      if (wasCityAllIn) targetArmy += 5;
    }

    var targetArmyGather = target.army + targetArmy;

    if (path.length > 1 && playerOf(path.tail.tile) === -1) {
      path = path.get_subsegment(path.length - 1);
    }
    if (path.length > 2) path = path.get_subsegment(2, true);

    if (playerOf(target) >= 0) path = null;

    var allowGather = false;
    var gatherDuration = desiredGatherTurns;
    if (desiredGatherTurns === -1) {
      gatherDuration = 20;
      if (!isNeutralTile(target)) {
        gatherDuration = 20;
      } else if (player.tileCount > 125) {
        gatherDuration = 10;
      }

      if (map.is_walled_city_game) gatherDuration += 5;
      var tileCount = map.tiles_by_index.length;
      if (tileCount > 400) gatherDuration += 5;
      if (tileCount > 800) gatherDuration += 5;
      if (tileCount > 1200) gatherDuration += 5;
      if (tileCount > 1600) gatherDuration += 5;
      if (target.army > 50) gatherDuration += 5;
    }

    var winningOnArmy = bot.opponent_tracker && typeof bot.opponent_tracker.winning_on_army === 'function'
      ? bot.opponent_tracker.winning_on_army() : false;
    var tmg = timings(bot);
    var inGathSplit = tmg && ((typeof tmg.in_gather_split === 'function' && tmg.in_gather_split(map.turn))
      || (typeof tmg.in_quick_expand_split === 'function' && tmg.in_quick_expand_split(map.turn)));
    var evenOrUpOnCities = bot.opponent_tracker && typeof bot.opponent_tracker.even_or_up_on_cities === 'function'
      ? bot.opponent_tracker.even_or_up_on_cities(bot.targetPlayer) : false;
    var longSpawns = genDist > 22;
    var targetCityIsEn = playerOf(target) >= 0;
    if (winningOnArmy || inGathSplit || !evenOrUpOnCities || longSpawns || targetCityIsEn) {
      allowGather = true;
    }

    bot.city_capture_plan_tiles = new Set();
    var res = BotCityOps.plan_city_capture_with_plan_option(
      bot, target, path, allowGather, targetArmy, targetArmyGather,
      killSearchDist, gatherDuration, captureNegs, Math.max(0, desiredGatherTurns - 5));

    if (res[0] === null && res[1] === null) {
      info(bot, 'GATHERING TO CITY FAILED');
    }
    return res;
  };

  function rawAtTerritory(bot, tile) {
    if (!bot.territories || !bot.territories.territoryMap) return -1;
    var v = bot.territories.territoryMap.raw[tile.tile_index];
    return v === null || v === undefined ? -1 : v;
  }

  // BotCityOps.py:369 capture_cities_plan_option
  BotCityOps.capture_cities_plan_option = function (
    bot, negativeTiles, forceNeutralCapture, includeContestOption,
    ignoreContestSuppressionForNeutral, preferNeutralCapture) {
    var res = BotCityOps.capture_cities_with_plan_option(
      bot, negativeTiles, forceNeutralCapture, includeContestOption,
      ignoreContestSuppressionForNeutral, preferNeutralCapture);
    return res[2];
  };

  // BotCityOps.py:390 get_city_contestation_plan_option
  BotCityOps.get_city_contestation_plan_option = function (bot) {
    if (!hasWinCondition(bot, 'ContestEnemyCity')) return null;

    var w = wca(bot);
    if (!w) return null;

    var contestableCities = w.contestable_cities ? copySet(w.contestable_cities) : new Set();
    var options = [];
    var plans = w.contestable_city_offense_plans;
    if (plans && typeof plans.forEach === 'function') {
      plans.forEach(function (plan, tile) {
        if (contestableCities.has(tile) && plan !== null && plan !== undefined) options.push(plan);
      });
    } else {
      degraded('WinConditionAnalyzer.contestable_city_offense_plans');
    }

    var targetPlayerLocation = w.target_player_location || null;
    if (targetPlayerLocation !== null && targetPlayerLocation.isGeneral
      && contestableCities.has(targetPlayerLocation)) {
      var allInPlan = w.our_best_attack_plan || null;
      if (allInPlan !== null) {
        allInPlan.gather_target = targetPlayerLocation;
        if (allInPlan.econValue <= 0.0) {
          allInPlan.econValue = bot.opponent_tracker
            && typeof bot.opponent_tracker.estimate_city_contest_econ_value === 'function'
            ? bot.opponent_tracker.estimate_city_contest_econ_value(
              mapOf(bot).player_index, bot.targetPlayer, allInPlan.gathered_army) : 0;
          if (!(bot.opponent_tracker && typeof bot.opponent_tracker.estimate_city_contest_econ_value === 'function')) {
            degraded('OpponentTracker.estimate_city_contest_econ_value');
          }
        }
        options.push(allInPlan);
      }
    }

    var bestPlan = null;
    var bestScore = -Infinity;
    for (var i = 0; i < options.length; i++) {
      var plan = options[i];
      var score = plan.econValue / Math.max(plan.length, 1);
      if (bestPlan === null || score > bestScore) {
        bestPlan = plan;
        bestScore = score;
      }
    }
    return bestPlan;
  };

  // BotCityOps.py:414 _apply_city_capture_plan_value
  BotCityOps._apply_city_capture_plan_value = function (bot, planOption, targetCity) {
    var map = mapOf(bot);
    var remainingTurnsInCycle = turnsLeftInCycle(bot);

    var cityArmyEconThisRound = Math.trunc(Math.max(0, remainingTurnsInCycle - planOption.length) / 2);

    var largePlayerTiles = toArr(bot.largePlayerTiles).slice(0, 2);
    var largeSum = 0;
    for (var i = 0; i < largePlayerTiles.length; i++) largeSum += largePlayerTiles[i].army - 1;
    var probUnusedStandingArmy = bot.player.standingArmy - largeSum;
    var probStandingArmyNextRound = probUnusedStandingArmy + bot.player.tileCount
      + Math.trunc((bot.player.cityCount * remainingTurnsInCycle) / 2);
    var timeToCity = probStandingArmyNextRound === 0
      ? 0 : (45 * bot.player.tileCount) / probStandingArmyNextRound;
    var cityArmyEconLossByDelayingAfterStartOfNextRound = Math.trunc(Math.max(6, timeToCity) / 2);

    var cityValue = cityArmyEconThisRound + cityArmyEconLossByDelayingAfterStartOfNextRound;

    var baseCityBonus = 6;
    var cityCatchupBonus = 0;
    if (!(bot.opponent_tracker && typeof bot.opponent_tracker.even_or_up_on_cities === 'function'
      && bot.opponent_tracker.even_or_up_on_cities(bot.targetPlayer))) {
      cityCatchupBonus = Math.trunc(Math.max(0, remainingTurnsInCycle - planOption.length) / 2);
    }

    cityValue += baseCityBonus;
    cityValue += cityCatchupBonus;

    if (playerOf(targetCity) !== -1) {
      cityValue += 2;
      cityValue *= 2;
    }

    var bonusCapturePointMatrix = call('BotExpansionOps', 'get_expansion_weight_matrix', [bot], null);
    var pathCaptureValue = 0.0;
    var friendlyPlayers = toArr(map.get_teammates(gplayer(bot.general)));
    var tileList = toArr(planOption.tileList);
    for (var t = 0; t < tileList.length; t++) {
      var tile = tileList[t];
      if (tile === targetCity) continue;
      if (friendlyPlayers.indexOf(playerOf(tile)) < 0) {
        pathCaptureValue += bonusCapturePointMatrix ? rawAt(bonusCapturePointMatrix, tile) : 0;
      }
    }

    planOption.econValue = Math.max(0.0, cityValue + pathCaptureValue);
    planOption.gather_target = targetCity;
  };

  // BotCityOps.py:467 should_proactively_take_cities
  BotCityOps.should_proactively_take_cities = function (bot) {
    var map = mapOf(bot);
    var dist = distFromGeneral(bot, bot.targetPlayerExpectedGeneralLocation);
    if (bot.targetPlayer !== -1) {
      if (bot.targetPlayerObj && toArr(bot.targetPlayerObj.tiles).length === 0
        && map.is_walled_city_game && dist > 20) {
        return true;
      }
    }

    if (bot.defend_economy) return false;

    var cityLeadWeight = 0;
    dist = distFromGeneral(bot, bot.targetPlayerExpectedGeneralLocation);
    if (bot.targetPlayer !== -1) {
      var opp = map.players[bot.targetPlayer];
      var me = map.players[gplayer(bot.general)];
      cityLeadWeight = (me.cityCount - opp.cityCount) * 50;
    }

    var knowsWhereEnemyGenIs = bot.targetPlayer !== -1
      && map.generals[bot.targetPlayer] !== null && map.generals[bot.targetPlayer] !== undefined;
    if (knowsWhereEnemyGenIs && dist < 18) return false;

    var player = map.players[gplayer(bot.general)];
    var targetPlayer = null;
    if (bot.targetPlayer !== -1) targetPlayer = map.players[bot.targetPlayer];
    var safeOnStandingArmy = targetPlayer === null || player.standingArmy > targetPlayer.standingArmy * 0.9;

    var noGatherPath = bot.target_player_gather_path === null || bot.target_player_gather_path === undefined;
    if (safeOnStandingArmy && (
      (player.standingArmy > cityLeadWeight && (noGatherPath || dist > 24))
      || (player.standingArmy > 30 + cityLeadWeight && (noGatherPath || dist > 22))
      || (player.standingArmy > 40 + cityLeadWeight && (noGatherPath || dist > 20))
      || (player.standingArmy > 60 + cityLeadWeight && (noGatherPath || dist > 18))
      || (player.standingArmy > 70 + cityLeadWeight && (noGatherPath || dist > 16))
      || (player.standingArmy > 85 + cityLeadWeight))) {
      return true;
    }
    return false;
  };

  // BotCityOps.py:506 find_neutral_city_path
  BotCityOps.find_neutral_city_path = function (bot, ignoreContestSuppression) {
    if (ignoreContestSuppression === undefined) ignoreContestSuppression = false;

    var map = mapOf(bot);
    var is1v1 = map.remainingPlayers === 2 || map.is_2v2;
    var ot = bot.opponent_tracker || null;
    var wayAheadOnEcon = ot && typeof ot.winning_on_economy === 'function'
      ? ot.winning_on_economy(1.15, 40, undefined, -5) : false;
    var isNotLateGame = map.turn < 500 && bot.player.standingArmy < 220;

    var isWalledNoAggression = map.is_walled_city_game
      && (bot.targetPlayer === -1 || map.players[bot.targetPlayer].aggression_factor === 0.0);

    if (!isWalledNoAggression) {
      var contestable = wca(bot) && wca(bot).contestable_cities ? copySet(wca(bot).contestable_cities) : null;
      var enemyContested = contestable !== null
        && anyWhere(contestable, function (t) { return playerOf(t) !== bot.player.index; });
      if (isNotLateGame && is1v1 && (wayAheadOnEcon
        || (!ignoreContestSuppression && enemyContested))) {
        return null;
      }

      var ffaNonDominant = call('BotStateQueries', 'is_still_ffa_and_non_dominant', [bot], false);
      if (ffaNonDominant && bot.targetPlayer !== -1 && bot.targetPlayerObj
        && bot.targetPlayerObj.aggression_factor > 30) {
        return null;
      }

      if (bot.defend_economy && (bot.targetPlayer === -1
        || (ot && typeof ot.even_or_up_on_cities === 'function' && ot.even_or_up_on_cities(bot.targetPlayer)))) {
        return null;
      }
    }

    var interGenDist = bot.board_analysis ? bot.board_analysis.inter_general_distance : 15;
    var relevanceCutoff = 0.15 * (16 / Math.max(1, interGenDist));
    var distRatioThreshNormal = 0.95;
    var distRatioThreshEnVisionFewCities = 0.35;
    var distRatioThreshEnVisionLotsOfCities = 0.6;
    var winningOnArmyOffset = ot && typeof ot.winning_on_army === 'function' ? ot.winning_on_army(-40) : false;
    if (winningOnArmyOffset) {
      distRatioThreshEnVisionFewCities = 0.55;
      distRatioThreshEnVisionLotsOfCities = 0.8;
      relevanceCutoff = 0.10 * (15 / Math.max(1, interGenDist));
    }

    var cityAnalyzer = bot.cityAnalyzer;
    if (!cityAnalyzer || !cityAnalyzer.city_scores) return null;

    var aMap = bot.board_analysis && bot.board_analysis.intergeneral_analysis
      ? bot.board_analysis.intergeneral_analysis.aMap : null;
    var reachMatrix = cityAnalyzer.reachability_costs_matrix || null;

    var cities = [];
    cityAnalyzer.city_scores.forEach(function (score, city) { cities.push(city); });
    cities.sort(function (c1, c2) {
      var k1 = (10 + rawAt(aMap, c1)) * Math.max(1, c1.army + rawAt(reachMatrix, c1));
      var k2 = (10 + rawAt(aMap, c2)) * Math.max(1, c2.army + rawAt(reachMatrix, c2));
      if (k1 !== k2) return k1 - k2;
      return c1.tile_index - c2.tile_index;
    });

    var baseLimit = 8;
    var spToTarget = bot.shortest_path_to_target_player;
    if (!spToTarget) {
      degraded('bot.shortest_path_to_target_player');
      return null;
    }
    var territoryDistCutoff = Math.max(2, Math.trunc(spToTarget.length / 6));

    var path = null;
    var targetCity = null;
    var maxScore = null;
    var maxScoreNeutVal = -100000.0;
    var obstacleDict = {};
    var toCheck = cities.slice(0, baseLimit);
    var i = 0;
    var toCheckIncluded = new Set(toCheck);
    var terrDistTarget = bot.territories && bot.territories.territoryDistances
      ? bot.territories.territoryDistances[bot.targetPlayer] : null;
    var everOwned = bot.armyTracker && bot.armyTracker.tiles_ever_owned_by_player
      ? bot.armyTracker.tiles_ever_owned_by_player[bot.targetPlayer] : null;

    while (i < toCheck.length) {
      var city = toCheck[i];
      var score = cityAnalyzer.city_scores.get(city);
      if (score === undefined) score = null;
      var scoreVal = 0.0;
      var tryPath = false;
      if (score === null) {
        tryPath = true;
        scoreVal = Math.max(10, city.army) / (obstacleDict[city.tile_index] || 1);
      } else {
        var enemyVision = toArr(city.adjacents).filter(function (t) { return isEnemyTile(bot, t); });
        var cityDistanceRatioThresh = distRatioThreshNormal;
        if (enemyVision.length > 0) {
          if (bot.player.cityCount < 4) cityDistanceRatioThresh = distRatioThreshEnVisionFewCities;
          else cityDistanceRatioThresh = distRatioThreshEnVisionLotsOfCities;
        }

        var tDist = rawAt(terrDistTarget, city);
        var inSafePocket = tDist > territoryDistCutoff;
        inSafePocket = inSafePocket && !anyWhere(city.adjacents, function (a) {
          return everOwned ? !!everOwned[a.tile_index] : false;
        });
        inSafePocket = inSafePocket || tDist > Math.trunc(spToTarget.length / 4);

        var bonus = 4 + (obstacleDict[city.tile_index] || 0);
        var baseScore = typeof score.get_weighted_neutral_value === 'function'
          ? score.get_weighted_neutral_value() : 0;
        scoreVal = baseScore * bonus;

        tryPath = (
          (maxScoreNeutVal < scoreVal)
          && (score.general_distances_ratio < cityDistanceRatioThresh || inSafePocket)
          && (score.city_relevance_score > relevanceCutoff)
        ) || obstacleDict[city.tile_index] !== undefined;
      }
      if (tryPath) {
        var movAbs = toArr(city.movable).filter(function (t) { return !t.isObstacle; });
        path = call('BotPathingUtils', 'get_path_to_targets',
          [bot, movAbs, undefined, distFromGeneral(bot, city) + 5,
            false, undefined, false, undefined, false, undefined, undefined, true, false], null);
        if (path !== null && path !== undefined) {
          maxScore = score;
          targetCity = city;
          maxScoreNeutVal = scoreVal;
        } else {
          for (var key in obstacleDict) {
            if (!Object.prototype.hasOwnProperty.call(obstacleDict, key)) continue;
            var hits = obstacleDict[key];
            var obstacleTile = cities.filter(function (t) { return t.tile_index === Number(key); })[0];
            if (hits > 0 && toCheck.length < baseLimit + 4 && obstacleTile && !toCheckIncluded.has(obstacleTile)) {
              toCheck.push(obstacleTile);
              toCheckIncluded.add(obstacleTile);
            }
          }
        }
      }
      i += 1;
    }

    if (targetCity !== null && path !== null && path !== undefined) {
      path.add_next(targetCity);
    }
    return path;
  };

  // BotCityOps.py:618 _check_should_wait_city_capture
  BotCityOps._check_should_wait_city_capture = function (bot) {
    var map = mapOf(bot);
    var generalArmy = bot.general.army;
    var cityAnalyzer = bot.cityAnalyzer;
    if (!cityAnalyzer || !cityAnalyzer.city_scores) return [null, false];

    var entries = [];
    cityAnalyzer.city_scores.forEach(function (score, city) { entries.push([city, score]); });
    entries.sort(function (a, b) {
      var da = distFromGeneral(bot, a[0]);
      var db = distFromGeneral(bot, b[0]);
      if (da !== db) return da - db;
      return a[0].tile_index - b[0].tile_index;
    });

    var top = entries.slice(0, 10);
    for (var i = 0; i < top.length; i++) {
      var city = top[i][0];
      var qk = EK.search && typeof EK.search.dest_breadth_first_target === 'function'
        ? EK.search.dest_breadth_first_target(map, [city], { preferCapture: true, noNeutralCities: false })
        : null;
      if (qk) return [qk, false];
      if (city.army + distFromGeneral(bot, city) < generalArmy + 30 - map.turn) return [null, true];
    }
    return [null, false];
  };

  // BotCityOps.py:630 did_player_just_take_fog_city
  BotCityOps.did_player_just_take_fog_city = function (bot, player) {
    var map = mapOf(bot);
    var playerObj = map.players[player];
    if (!playerObj) return false;
    if (!playerObj.unexplainedTileDelta) return false;
    var ot = bot.opponent_tracker;
    var unexplainedScoreDelta = ot && typeof ot.get_team_annihilated_fog_by_player === 'function'
      ? ot.get_team_annihilated_fog_by_player(player) : 0;
    if (!(unexplainedScoreDelta >= 3)) return false;
    if (playerObj.cityGainedTurn === map.turn) return true;
    return false;
  };

  // BotCityOps.py:643 get_enemy_cities_by_priority
  BotCityOps.get_enemy_cities_by_priority = function (bot, cutoffDistanceRatio) {
    if (cutoffDistanceRatio === undefined) cutoffDistanceRatio = 100.0;
    var prioTiles = [];
    var da = bot.dangerAnalyzer || null;
    var threats = ['fastestThreat', 'fastestPotentialThreat', 'fastestAllyThreat', 'fastestCityThreat'];
    for (var i = 0; i < threats.length; i++) {
      var threat = da ? da[threats[i]] : null;
      if (!threat || !threat.path || !threat.path.start) continue;
      var tile = threat.path.start.tile;
      if (tile.isCity && prioTiles.indexOf(tile) < 0) prioTiles.push(tile);
    }

    var analyzer = bot.cityAnalyzer;
    var tiles = [];
    if (analyzer && typeof analyzer.get_sorted_enemy_scores === 'function') {
      var sorted = analyzer.get_sorted_enemy_scores();
      for (var s = 0; s < sorted.length; s++) {
        var st = sorted[s][0];
        var score = sorted[s][1];
        if (prioTiles.indexOf(st) < 0 && score.general_distances_ratio < cutoffDistanceRatio) tiles.push(st);
      }
    }
    return prioTiles.concat(tiles);
  };

  // BotCityOps.py:667 get_quick_kill_on_enemy_cities
  BotCityOps.get_quick_kill_on_enemy_cities = function (bot, defenseCriticalTileSet) {
    var planOption = BotCityOps.get_quick_kill_on_enemy_cities_plan_option(bot, defenseCriticalTileSet);
    if (planOption && planOption instanceof EK.Path) return planOption;
    return null;
  };

  // BotCityOps.py:674 get_quick_kill_on_enemy_cities_plan_option
  BotCityOps.get_quick_kill_on_enemy_cities_plan_option = function (bot, defenseCriticalTileSet) {
    var map = mapOf(bot);
    var foundCap = null;
    var enemyCitiesOrderedByPriority = BotCityOps.get_enemy_cities_by_priority(bot);
    var myPlayer = gplayer(bot.general);
    var negs = copySet(defenseCriticalTileSet);

    for (var i = 0; i < enemyCitiesOrderedByPriority.length; i++) {
      var enemyCity = enemyCitiesOrderedByPriority[i];
      var enMovedNear = false;
      var cap = null;
      var movs = toArr(enemyCity.movableNoObstacles);
      for (var m = 0; m < movs.length; m++) {
        var movable = movs[m];
        var mvPlayer = playerOf(movable);
        if (mvPlayer === playerOf(enemyCity)
          && movable.lastMovedTurn > map.turn - 2
          && movable.delta && movable.delta.toTile !== enemyCity) {
          enMovedNear = true;
          break;
        }
        if (mvPlayer === myPlayer && movable.army > enemyCity.army + 1
          && !negs.has(movable) && (cap === null || cap.start.tile.army > movable.army)) {
          cap = new EK.Path();
          cap.add_next(movable);
          cap.add_next(enemyCity);
        }
      }

      if (!enMovedNear && cap !== null
        && (foundCap === null || foundCap.start.tile.army > cap.start.tile.army)) {
        foundCap = cap;
      }
    }

    if (foundCap !== null) {
      info(bot, 'returning 1-move-city-kill ' + foundCap);
      BotCityOps._apply_city_capture_plan_value(bot, foundCap, foundCap.tail.tile);
      return foundCap;
    }

    var ot = bot.opponent_tracker || null;
    if (ot && typeof ot.winning_on_economy === 'function' && ot.winning_on_economy(1.5, 50)) {
      return null;
    }

    var analyzer = bot.cityAnalyzer || null;
    var negCutoff = 0 - Math.trunc(bot.player.standingArmy / 40);
    var highValueNegs = [];
    if (analyzer && analyzer.large_neutral_negatives) {
      highValueNegs = sortedByIndex(analyzer.large_neutral_negatives).filter(function (t) {
        return t.army < negCutoff;
      });
    }
    if (highValueNegs.length > 0) {
      var killPath = EK.search.dest_breadth_first_target(map, highValueNegs, {
        targetArmy: 1, maxDepth: 25, negativeTiles: null,
        preferCapture: true, searchingPlayer: myPlayer, additionalIncrement: 0
      });
      if (killPath) {
        BotCityOps._apply_city_capture_plan_value(bot, killPath, killPath.tail.tile);
        return killPath;
      }
    }

    var possibleNeutralCities = [];
    if (analyzer && analyzer.city_scores) {
      var terrDist = bot.territories && bot.territories.territoryDistances
        ? bot.territories.territoryDistances[bot.targetPlayer] : null;
      analyzer.city_scores.forEach(function (score, c) {
        if (c.visible) return;
        if (bot.territories && bot.territories.is_tile_in_enemy_territory(c)) return;
        var td = rawAt(terrDist, c);
        var seenOpp = bot.armyTracker && bot.armyTracker.seen_player_lookup
          ? bot.armyTracker.seen_player_lookup[bot.targetPlayer] : true;
        if ((c.army < 4 && td > 3)
          || (c.army < 20 && td > 9)
          || (map.is_walled_city_game && !seenOpp)) {
          possibleNeutralCities.push(c);
        }
      });
    }

    if (possibleNeutralCities.length > 0) {
      var neutKill = EK.search.dest_breadth_first_target(map, possibleNeutralCities, {
        targetArmy: 1, maxDepth: 8, negativeTiles: null,
        preferCapture: true, searchingPlayer: myPlayer, additionalIncrement: 0
      });
      if (neutKill) {
        BotCityOps._apply_city_capture_plan_value(bot, neutKill, neutKill.tail.tile);
        return neutKill;
      }
    }

    var tileCountRatio = Math.pow(map.players[myPlayer].tileCount, 0.30);
    var cityDepthCutoffEnTerritory = Math.max(5, Math.trunc(tileCountRatio));

    var singleQuick = EK.search.dest_breadth_first_target(map, enemyCitiesOrderedByPriority, {
      targetArmy: 1.0, maxDepth: 4, negativeTiles: null,
      preferCapture: false, searchingPlayer: myPlayer, additionalIncrement: 0
    });
    if (!singleQuick) {
      singleQuick = EK.search.dest_breadth_first_target(map, enemyCitiesOrderedByPriority, {
        targetArmy: 1.5, maxDepth: 7, negativeTiles: null,
        preferCapture: true, searchingPlayer: myPlayer, additionalIncrement: 0.5
      });
    }

    if (singleQuick) {
      var bestDef = call('BotDefense', 'get_best_defense',
        [bot, singleQuick.tail.tile, singleQuick.length - 1, []], null);
      if (bestDef !== null && bestDef !== undefined && bestDef.value > singleQuick.value) {
        // 原版在这里 bypass；bestDef 只在有 BotDefense.get_best_defense 时存在
      } else {
        BotCityOps._apply_city_capture_plan_value(bot, singleQuick, singleQuick.tail.tile);
        return singleQuick;
      }
    }

    var shortestKill = null;
    var topCities = enemyCitiesOrderedByPriority.slice(0, 8);
    for (var c = 0; c < topCities.length; c++) {
      var city = topCities[c];
      var negTilesToUse = copySet(negs);
      if (negs.has(city)) negTilesToUse = new Set();

      var cityDepthSearch = cityDepthCutoffEnTerritory;
      if (bot.territories && bot.territories.is_tile_in_friendly_territory(city)) {
        cityDepthSearch = cityDepthCutoffEnTerritory + 5;
      } else if (bot.territories && !bot.territories.is_tile_in_enemy_territory(city)) {
        cityDepthSearch = cityDepthCutoffEnTerritory + 2;
      }

      if (!map.is_player_on_team_with(playerOf(city), bot.targetPlayer)) cityDepthSearch -= 1;

      var da = bot.dangerAnalyzer || null;
      if (da && da.fastestThreat && da.fastestThreat.path && da.fastestThreat.path.tileSet.has(city)) {
        negTilesToUse = new Set();
        cityDepthSearch -= 1;
      }
      if (da && da.fastestPotentialThreat && da.fastestPotentialThreat.path
        && da.fastestPotentialThreat.path.tileSet.has(city)) {
        negTilesToUse = new Set();
      }

      var tgt = call('BotStateQueries', 'get_target_army_inc_adjacent_enemy_and_tiles', [bot, city], [1, new Set()]);
      var armyToSearch = tgt[0] + 1.0;
      var enNegs = copySet(tgt[1]);

      var armyToSearchNegs = copySet(negTilesToUse);
      for (var nn = 0; nn < toArr(enNegs).length; nn++) armyToSearchNegs.add(toArr(enNegs)[nn]);

      var addlIncrementing = 0;
      var nearby = countWhereNearby(bot, city, cityDepthSearch);
      addlIncrementing = nearby;

      var killPath = EK.search.dest_breadth_first_target(map, [city], {
        targetArmy: 1.5, maxDepth: 2, negativeTiles: negTilesToUse,
        preferCapture: true, searchingPlayer: myPlayer, additionalIncrement: addlIncrementing / 2
      });
      if (killPath === null) {
        killPath = EK.search.dest_breadth_first_target(map, [city], {
          targetArmy: Math.max(1.5, armyToSearch), maxDepth: cityDepthSearch,
          negativeTiles: armyToSearchNegs, preferCapture: true,
          searchingPlayer: myPlayer, additionalIncrement: addlIncrementing / 2
        });
      }
      if (killPath === null) {
        killPath = EK.search.dest_breadth_first_target(map, [city], {
          targetArmy: Math.max(1.5, armyToSearch), maxDepth: cityDepthSearch,
          negativeTiles: armyToSearchNegs, preferCapture: false,
          searchingPlayer: myPlayer, additionalIncrement: addlIncrementing / 2
        });
      }
      if (killPath !== null) {
        var bestDef2 = call('BotDefense', 'get_best_defense',
          [bot, killPath.tail.tile, killPath.length - 1, killPath.tileList], null);
        if (bestDef2 !== null && bestDef2 !== undefined && bestDef2.value > killPath.value) {
          continue;
        }

        if (killPath.start.tile.isCity
          && call('BotCombatOps', 'should_kill_path_move_half',
            [bot, killPath, Math.trunc(armyToSearch - city.army)], false)) {
          killPath.start.move_half = true;
        }
        if (shortestKill === null || shortestKill.length > killPath.length) shortestKill = killPath;
      }
      if (killPath === null) {
        var w = wca(bot);
        var precomputedPlan = w && w.contestable_city_offense_plans
          && typeof w.contestable_city_offense_plans.get === 'function'
          ? w.contestable_city_offense_plans.get(city) : null;
        if (precomputedPlan !== null && precomputedPlan !== undefined
          && (shortestKill === null || shortestKill.length > precomputedPlan.length)) {
          shortestKill = precomputedPlan;
        }
      }
    }

    if (shortestKill !== null) {
      var tgCity = shortestKill.tail.tile;
      var negTilesFinal = negs;
      if (negs.has(tgCity)) negTilesFinal = new Set();

      var da2 = bot.dangerAnalyzer || null;
      if (da2 && da2.fastestThreat && da2.fastestThreat.path && da2.fastestThreat.path.tileSet.has(tgCity)) {
        negTilesFinal = new Set();
      }

      var armRes = call('BotStateQueries', 'get_target_army_inc_adjacent_enemy_and_tiles', [bot, tgCity], [1, new Set()]);
      var armyToSearch2 = armRes[0] + 1.0;
      var armyToSearchNegs2 = copySet(armRes[1]);
      for (var f = 0; f < toArr(negTilesFinal).length; f++) armyToSearchNegs2.add(toArr(negTilesFinal)[f]);

      if (EK.GatherCapturePlan && shortestKill instanceof EK.GatherCapturePlan) return shortestKill;

      if (shortestKill.value > 0) {
        BotCityOps._apply_city_capture_plan_value(bot, shortestKill, tgCity);
        return shortestKill;
      }

      var cityPath = shortestKill.get_subsegment(3, true);
      var maxDur = Math.trunc(Math.pow(bot.player.tileCount, 0.32)) + 1;
      var res = BotCityOps.plan_city_capture_with_plan_option(
        bot, tgCity, cityPath, true, armyToSearch2 - 1, tgCity.army + armyToSearch2 - 1,
        5, maxDur, armyToSearchNegs2, 0);
      if (res[2] !== null && res[2] !== undefined) {
        BotCityOps._apply_city_capture_plan_value(bot, res[2], tgCity);
        return res[2];
      }
      if (res[1] !== null && res[1] !== undefined) {
        var fakePath = new EK.Path();
        fakePath.add_next(res[1].source);
        fakePath.add_next(res[1].dest);
        BotCityOps._apply_city_capture_plan_value(bot, fakePath, tgCity);
        return fakePath;
      }
      if (res[0] !== null && res[0] !== undefined) {
        var planPath = res[0].get_subsegment(1);
        BotCityOps._apply_city_capture_plan_value(bot, planPath, tgCity);
        return planPath;
      }
      var og = shortestKill.get_subsegment(1);
      BotCityOps._apply_city_capture_plan_value(bot, og, tgCity);
      return og;
    }
    return null;
  };

  // 原版在 city.adjacents 外扩 cityDepthSearch 圈数「别的敌城」个数，
  // 用来加大集的兵量（旁边的敌城会来抢）。这里同口径复刻。
  function countWhereNearby(bot, city, depth) {
    var map = mapOf(bot);
    var seen = new Set();
    var frontier = toArr(city.adjacents).slice();
    var d = 0;
    var n = 0;
    while (frontier.length > 0 && d < depth) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var t = frontier[i];
        if (seen.has(t)) continue;
        seen.add(t);
        if (t.isCity && isEnemyTile(bot, t) && t !== city) n += 1;
        var mov = toArr(t.movable);
        for (var k = 0; k < mov.length; k++) if (!seen.has(mov[k])) next.push(mov[k]);
      }
      frontier = next;
      d += 1;
    }
    return n;
  }

  // gather.js 只导出了 prune_mst_to_army / prune_mst_to_turns（见 gather.js:2208），
  // 原版 prune_mst_to_*_with_values 多返回的 (turns, value) 这里自己累加，
  // 口径和原版一致：turns = sum(gatherTurns)，value = sum(value)。
  function pruneToArmyValues(bot, nodes, army, preferPrune) {
    if (!nodes || nodes.length === 0) return [0, 0, nodes];
    var map = mapOf(bot);
    var pruned = EK.Gather.prune_mst_to_army(
      nodes, army, gplayer(bot.general), map.team_ids_by_player_index, map.turn,
      null, null, null, preferPrune || null, true, false);
    var roots = pruned || nodes;
    var turns = 0;
    var value = 0;
    for (var i = 0; i < roots.length; i++) {
      turns += roots[i].gatherTurns;
      value += roots[i].value;
    }
    return [turns, value, roots];
  }

  function pruneToTurnsValues(bot, nodes, turns, minTurns, preferPrune) {
    if (!nodes || nodes.length === 0) return [0, 0, nodes];
    var map = mapOf(bot);
    var pruned = EK.Gather.prune_mst_to_turns(
      nodes, turns, gplayer(bot.general), map.team_ids_by_player_index, map.turn);
    var roots = pruned || nodes;
    var t = 0;
    var value = 0;
    for (var i = 0; i < roots.length; i++) {
      t += roots[i].gatherTurns;
      value += roots[i].value;
    }
    if (minTurns && t < minTurns) return [t, value, roots];
    return [t, value, roots];
  }

  // BotCityOps.py:994 plan_city_capture
  BotCityOps.plan_city_capture = function (
    bot, targetCity, cityGatherPath, allowGather, targetKillArmy, targetGatherArmy,
    killSearchDist, gatherMaxDuration, negativeTiles, gatherMinDuration) {
    var res = BotCityOps.plan_city_capture_with_plan_option(
      bot, targetCity, cityGatherPath, allowGather, targetKillArmy, targetGatherArmy,
      killSearchDist, gatherMaxDuration, negativeTiles, gatherMinDuration);
    return [res[0], res[1]];
  };

  // BotCityOps.py:1021 plan_city_capture_with_plan_option
  BotCityOps.plan_city_capture_with_plan_option = function (
    bot, targetCity, cityGatherPath, allowGather, targetKillArmy, targetGatherArmy,
    killSearchDist, gatherMaxDuration, negativeTiles, gatherMinDuration) {

    if (gatherMinDuration === undefined) gatherMinDuration = 0;

    var map = mapOf(bot);
    var myPlayer = gplayer(bot.general);

    if (targetGatherArmy < targetKillArmy + targetCity.army) {
      // 原版这里 raise；移植版不能因为「参数不合」把整局打断，按「集不够就不打」返回
      degraded('AssertionError:gather_army_below_kill_requirement');
      return [null, null, null];
    }

    targetKillArmy += 1;
    targetGatherArmy += 1;

    if (cityGatherPath && cityGatherPath.length > killSearchDist) {
      killSearchDist = cityGatherPath.length;
    }

    var inThreatPath = bot.threat && bot.threat.armyAnalysis
      && bot.threat.armyAnalysis.shortestPathWay
      && bot.threat.armyAnalysis.shortestPathWay.tiles
      && bot.threat.armyAnalysis.shortestPathWay.tiles.has
      && bot.threat.armyAnalysis.shortestPathWay.tiles.has(targetCity);
    if (negativeTiles.has(targetCity) || inThreatPath) {
      negativeTiles = new Set();
    } else {
      negativeTiles = copySet(negativeTiles);
    }

    var potentialThreatNegs = call('BotDefense', 'get_potential_threat_movement_negatives', [bot, targetCity], []);
    for (var pi = 0; pi < toArr(potentialThreatNegs).length; pi++) {
      negativeTiles.add(toArr(potentialThreatNegs)[pi]);
    }

    var addlIncrementing = countWhere(targetCity.adjacents, function (tile) {
      return tile.isCity && isEnemyTile(bot, tile);
    });

    var killPath = EK.search.dest_breadth_first_target(map, [targetCity], {
      targetArmy: targetKillArmy, maxDepth: killSearchDist, noNeutralCities: true,
      preferCapture: true, negativeTiles: negativeTiles, searchingPlayer: myPlayer,
      additionalIncrement: addlIncrementing / 2
    });

    if (killPath === null) {
      killPath = EK.search.dest_breadth_first_target(map, [targetCity], {
        targetArmy: targetKillArmy, maxDepth: killSearchDist, noNeutralCities: true,
        preferCapture: false, negativeTiles: negativeTiles, searchingPlayer: myPlayer,
        additionalIncrement: addlIncrementing / 2
      });
    }

    if (playerOf(targetCity) >= 0) {
      var altKillArmy = 1 + call('BotCombatOps', 'sum_enemy_army_near_tile', [bot, targetCity, 1], 0);
      var altKillPath = EK.search.dest_breadth_first_target(map, [targetCity], {
        targetArmy: altKillArmy, maxDepth: 3, noNeutralCities: true,
        preferCapture: true, negativeTiles: negativeTiles, searchingPlayer: myPlayer,
        additionalIncrement: addlIncrementing / 2
      });
      if (altKillPath !== null && (killPath === null || altKillPath.length <= Math.trunc(killPath.length / 2))) {
        killPath = altKillPath;
      }
    }

    if (killPath !== null) {
      viEvaluated(bot, targetCity.x, targetCity.y, 300);
      bot.gatherNodes = null;
      var addlArmy = 0;
      if (playerOf(targetCity) !== -1) addlArmy += killPath.length;
      if (addlIncrementing > 0) addlArmy += killPath.length;
      killPath.start.move_half = call('BotCombatOps', 'should_kill_path_move_half',
        [bot, killPath, targetKillArmy + addlArmy], false);
      bot.city_capture_plan_tiles = bot.city_capture_plan_tiles || new Set();
      var kpTiles = toArr(killPath.tileList);
      for (var k = 0; k < kpTiles.length; k++) bot.city_capture_plan_tiles.add(kpTiles[k]);
      bot.city_capture_plan_last_updated = map.turn;
      BotCityOps._apply_city_capture_plan_value(bot, killPath, targetCity);
      return [killPath, null, killPath];
    }

    if (!allowGather) return [null, null, null];

    var armyAlreadyPrepped = 0;
    targetGatherArmy -= armyAlreadyPrepped;
    if (isNeutralTile(targetCity)) targetGatherArmy = targetCity.army + 1;

    var targets = [targetCity];
    var gatherDist = gatherMaxDuration;
    negativeTiles = copySet(negativeTiles);

    var mePlayer = map.players[myPlayer];
    var cTurn = cycleTurn(bot);
    var turnsLeft = turnsLeftInCycle(bot);
    var notLateGame = mePlayer.tileCount < 150 && (map.remainingPlayers === 2 || map.is_2v2);
    if (isNeutralTile(targetCity) && notLateGame) {
      var genAlreadyInNeg = negativeTiles.has(bot.general);
      var ownedContested = bot.cityAnalyzer && bot.cityAnalyzer.owned_contested_cities
        ? sortedByIndex(bot.cityAnalyzer.owned_contested_cities) : [];
      for (var oc = 0; oc < ownedContested.length; oc++) negativeTiles.add(ownedContested[oc]);
      if (!genAlreadyInNeg && negativeTiles.has(bot.general)) negativeTiles.delete(bot.general);
    }

    if (playerOf(targetCity) >= 0 && cityGatherPath !== null && cityGatherPath !== undefined
      && !cityGatherPath.tileSet.has(targetCity)) {
      addlIncrementing += 1;
    }

    // 原版策略：先跳过敌方视野里的格试一次，失败再放开
    var toSkip = new Set();
    var crystalClear = map.modifiers_by_id && map.modifiers_by_id[6];
    if (!crystalClear && bot.targetPlayer !== -1 && bot.armyTracker
      && bot.armyTracker.visible_tiles_by_player
      && bot.armyTracker.visible_tiles_by_player[bot.targetPlayer]) {
      var visRaw = bot.armyTracker.visible_tiles_by_player[bot.targetPlayer].raw;
      if (!visRaw[targets[0].tile_index]) {
        var assumedAvg = bot.opponent_tracker && bot.opponent_tracker.assumed_player_average_tile_values
          ? bot.opponent_tracker.assumed_player_average_tile_values[bot.player.index] : 0;
        var seen = new Set();
        var frontier = targets.slice();
        var depth = 0;
        while (frontier.length > 0 && depth < 8) {
          var next = [];
          for (var fi = 0; fi < frontier.length; fi++) {
            var ft = frontier[fi];
            if (seen.has(ft)) continue;
            seen.add(ft);
            if (visRaw[ft.tile_index] && (playerOf(ft) !== bot.player.index || assumedAvg + 4 > ft.army)) {
              toSkip.add(ft);
            }
            var fmov = toArr(ft.movable);
            for (var fk = 0; fk < fmov.length; fk++) if (!seen.has(fmov[fk])) next.push(fmov[fk]);
          }
          frontier = next;
          depth += 1;
        }
      }
    }

    var move = null;
    var gatherValue = null;
    var gatherTurns = null;
    var gatherNodes = null;
    for (;;) {
      var gres = call('BotGatherOps', 'get_gather_to_target_tiles',
        [bot, targets, 0.03, gatherDist, negativeTiles, targetGatherArmy,
          true, null, false, false, addlIncrementing, null, null, toSkip, false, false, 0],
        [null, -1, -1, null]);
      move = gres[0];
      gatherValue = gres[1];
      gatherTurns = gres[2];
      gatherNodes = gres[3];
      if ((move !== null && move !== undefined) || toSkip.size === 0) break;
      toSkip.clear();
    }

    if (move === null || move === undefined) return [null, null, null];

    var preferPrune = null;
    var pv;
    if (isNeutralTile(targetCity)) {
      pv = pruneToArmyValues(bot, gatherNodes, targetGatherArmy, preferPrune);
    } else {
      pv = pruneToTurnsValues(bot, gatherNodes, gatherMaxDuration, gatherMinDuration, preferPrune);
    }
    var prunedTurns = pv[0];
    var prunedValue = pv[1];
    var prunedGatherNodes = pv[2];

    if (prunedGatherNodes && prunedGatherNodes.length > 0) {
      if (EK.GatherTreeNode && typeof EK.GatherTreeNode.foreach_tree_node === 'function') {
        EK.GatherTreeNode.foreach_tree_node(prunedGatherNodes, function (n) {
          bot.city_capture_plan_tiles.add(n.tile);
        });
      }
      bot.city_capture_plan_tiles.update ? bot.city_capture_plan_tiles.update(targets) : null;
      for (var ti = 0; ti < targets.length; ti++) bot.city_capture_plan_tiles.add(targets[ti]);
      bot.city_capture_plan_tiles.add(targetCity);
      bot.city_capture_plan_last_updated = map.turn;
    }

    // 同长度快杀路径优先：集兵要 20 回合，而同样回合数能直接打进城的路径更值
    var sameLengthKillPath = EK.search.dest_breadth_first_target(map, [targetCity], {
      targetArmy: targetKillArmy, maxDepth: Math.min(16, prunedTurns),
      noNeutralCities: true, preferCapture: true,
      negativeTiles: negativeTiles, searchingPlayer: myPlayer
    });

    if (sameLengthKillPath !== null) {
      var pathVal = typeof sameLengthKillPath.calculate_value === 'function'
        ? sameLengthKillPath.calculate_value(bot.player.index, map.team_ids_by_player_index, negativeTiles)
        : 0;
      if (pathVal + 4 > prunedValue * 0.8 || sameLengthKillPath.length < prunedTurns) {
        var slTiles = toArr(sameLengthKillPath.tileList);
        for (var sl = 0; sl < slTiles.length; sl++) bot.city_capture_plan_tiles.add(slTiles[sl]);
        bot.city_capture_plan_last_updated = map.turn;
        BotCityOps._apply_city_capture_plan_value(bot, sameLengthKillPath, targetCity);
        return [sameLengthKillPath, null, sameLengthKillPath];
      }
    }

    var treeMove = call('BotGatherOps', 'get_tree_move_default', [bot, prunedGatherNodes, null, false], null);
    var path = null;
    bot.gatherNodes = prunedGatherNodes;
    if (treeMove && treeMove.dest === targetCity) {
      var prunedNodes = EK.GatherTreeNode.clone_nodes(prunedGatherNodes);
      var first = call('BotGatherOps', 'get_tree_move_default', [bot, prunedNodes, null, true], null);
      var moveList = [];
      var nextMove = treeMove;
      while (nextMove !== null && nextMove !== undefined) {
        moveList.push(nextMove);
        nextMove = call('BotGatherOps', 'get_tree_move_default', [bot, prunedNodes, null, true], null);
      }
      if (moveList.length > 0) {
        if (cityGatherPath !== null && cityGatherPath !== undefined) {
          var extra = typeof cityGatherPath.convert_to_move_list === 'function'
            ? cityGatherPath.convert_to_move_list()
            : (typeof cityGatherPath.get_move_list === 'function' ? cityGatherPath.get_move_list() : []);
          for (var el = 0; el < extra.length; el++) moveList.push(extra[el]);
        }
        path = new EK.MoveListPath(moveList);
        bot.curPath = path;
      }
    }

    viEvaluated(bot, targetCity.x, targetCity.y, 300);

    var captures = new Set([targetCity]);
    for (var ct = 0; ct < targets.length; ct++) {
      if (!map.is_player_on_team_with(playerOf(targets[ct]), myPlayer)) captures.add(targets[ct]);
    }
    var planOption = EK.GatherCapturePlan.build_from_root_nodes(
      map, prunedGatherNodes, negativeTiles, myPlayer,
      false, null, false, true, captures, null, true, null, null, null);
    BotCityOps._apply_city_capture_plan_value(bot, planOption, targetCity);
    return [path, treeMove, planOption];
  };

  // BotCityOps.py:1371 block_neutral_captures
  BotCityOps.block_neutral_captures = function (bot, reason) {
    var ctl = mod('BotCityCaptureControl');
    if (ctl && typeof ctl.block_neutral_captures === 'function') {
      ctl.block_neutral_captures(bot, reason);
      return;
    }
    // 原版这个模块最终也只做这一件事
    bot.is_blocking_neutral_city_captures = true;
  };

  // BotCityOps.py:1375 ensure_reachability_matrix_built
  BotCityOps.ensure_reachability_matrix_built = function (bot) {
    if (bot.cityAnalyzer && typeof bot.cityAnalyzer.ensure_reachability_matrix_built === 'function') {
      bot.cityAnalyzer.ensure_reachability_matrix_built(false);
    } else {
      degraded('CityAnalyzer.ensure_reachability_matrix_built');
    }
  };

  // BotCityOps.py:1380 should_rapid_capture_neutral_cities
  BotCityOps.should_rapid_capture_neutral_cities = function (bot) {
    var map = mapOf(bot);
    var myPlayer = gplayer(bot.general);
    if (bot.targetPlayer === -1) return true;

    if (map.is_2v2 && bot.teammate_general) {
      var seenOtherPlayer = false;
      for (var i = 0; i < map.players.length; i++) {
        var p = map.players[i];
        if (!map.is_player_on_team_with(p.index, myPlayer) && toArr(p.tiles).length > 0) seenOtherPlayer = true;
      }
      return !seenOtherPlayer;
    }

    var gatherPath = bot.target_player_gather_path;
    var seenTarget = bot.armyTracker && bot.armyTracker.seen_player_lookup
      ? bot.armyTracker.seen_player_lookup[bot.targetPlayer] : true;
    if ((map.is_walled_city_game || map.is_low_cost_city_game)
      && (!gatherPath || gatherPath.length < 5 || !seenTarget)) {
      return true;
    }

    var mePlayer = map.players[myPlayer];
    var targPlayer = map.players[bot.targetPlayer];
    var unseenTargetPlayerAndMapMassive = bot.targetPlayerObj
      && toArr(bot.targetPlayerObj.tiles).length === 0 && map.is_walled_city_game;

    var haveLotsOfExcessArmy = mePlayer.standingArmy > mePlayer.tileCount * 2;
    var aheadOfOppArmyByHundreds = mePlayer.standingArmy > targPlayer.standingArmy + 100;
    var ot = bot.opponent_tracker || null;
    var notWinningEcon = !(ot && typeof ot.winning_on_economy === 'function' && ot.winning_on_economy(0.8, 40));
    var hasDoubleEcon = targPlayer.cityCount + 2 < Math.trunc(mePlayer.cityCount / 2) && !(map.remainingPlayers > 3);
    var hasTripleEcon = targPlayer.cityCount + 1 < Math.trunc(mePlayer.cityCount / 3);
    if (map.is_2v2) {
      hasDoubleEcon = ot && typeof ot.winning_on_economy === 'function' ? ot.winning_on_economy(2.0, 100) : false;
      hasTripleEcon = ot && typeof ot.winning_on_economy === 'function' ? ot.winning_on_economy(3.0, 100) : false;
    }

    var numberOfTilesEnemyNeedsToExploreToFindUsAvg = Math.trunc(mePlayer.tileCount / 2) - 50;
    if (targPlayer.aggression_factor < 20) {
      numberOfTilesEnemyNeedsToExploreToFindUsAvg = Math.trunc(mePlayer.tileCount / 2);
    }

    if (!bot.is_all_in_army_advantage
      && ((mePlayer.tileCount > 200 && mePlayer.standingArmy > mePlayer.tileCount * 3)
        || (mePlayer.tileCount > 150 && mePlayer.standingArmy > mePlayer.tileCount * 4)
        || (mePlayer.tileCount > 110 && mePlayer.standingArmy > mePlayer.tileCount * 5))
      && mePlayer.standingArmy > targPlayer.standingArmy - numberOfTilesEnemyNeedsToExploreToFindUsAvg
      && !targPlayer.knowsKingLocation
      && (!hasDoubleEcon || (targPlayer.aggression_factor < 30 && !hasTripleEcon))) {
      viInfo(bot, 'RAPID CITY EXPAND due to sheer volume of tiles/army');
      bot.is_rapid_capturing_neut_cities = true;
      return true;
    }

    var haveMinimumArmyAdv = mePlayer.standingArmy > targPlayer.standingArmy * 0.8
      || targPlayer.aggression_factor < 150;
    var haveAchievedEconomicDominance = ot && typeof ot.winning_on_economy === 'function'
      ? ot.winning_on_economy(1.45, 1000) : false;

    if (((aheadOfOppArmyByHundreds && notWinningEcon && targPlayer.aggression_factor < 200)
      || (haveLotsOfExcessArmy && bot.is_rapid_capturing_neut_cities))
      && !targPlayer.knowsKingLocation
      && !hasDoubleEcon) {
      if (!haveMinimumArmyAdv) {
        viInfo(bot, 'Ceasing rapid city expand due to sketchy army amount territory');
      } else if (haveAchievedEconomicDominance) {
        viInfo(bot, 'Ceasing rapid city expand due to economic dominance achieved');
      } else {
        bot.is_rapid_capturing_neut_cities = true;
        return true;
      }
    }

    bot.is_rapid_capturing_neut_cities = false;
    return false;
  };

  // BotCityOps.py:1454 find_rapid_city_path
  BotCityOps.find_rapid_city_path = function (bot) {
    var map = mapOf(bot);
    if (!BotCityOps.should_rapid_capture_neutral_cities(bot)) return null;

    var analyzer = bot.cityAnalyzer;
    if (!analyzer) return null;

    var longDistSearchCities = [];
    var neutCities = analyzer.city_scores ? Array.from(analyzer.city_scores.keys()) : [];
    for (var i = 0; i < neutCities.length; i++) {
      var neutCity = neutCities[i];
      if (!neutCity.discovered) continue;
      if (call('BotCombatOps', 'sum_enemy_army_near_tile', [bot, neutCity, 2], 0) === 0
        && count_enemy_territory_near_tile(bot, neutCity, 3) === 0) {
        longDistSearchCities.push(neutCity);
      }
    }

    var shortDistSearchCities = [];
    if (bot.targetPlayerObj && bot.targetPlayerObj.aggression_factor > 200) {
      var enCities = analyzer.enemy_city_scores ? Array.from(analyzer.enemy_city_scores.keys()) : [];
      for (var e = 0; e < enCities.length; e++) {
        var enCity = enCities[e];
        if (!enCity.discovered) continue;
        shortDistSearchCities.push(enCity);
        if (!(bot.territories && bot.territories.is_tile_in_enemy_territory(enCity))) {
          longDistSearchCities.push(enCity);
        }
      }
    }

    if (shortDistSearchCities.length > 0) {
      var quickestKillPath = EK.search.dest_breadth_first_target(map, shortDistSearchCities, { maxDepth: 4 });
      if (quickestKillPath) return quickestKillPath;
    }

    if (longDistSearchCities.length > 0) {
      var quickestLong = EK.search.dest_breadth_first_target(map, longDistSearchCities, { maxDepth: 9 });
      if (quickestLong) return quickestLong;
    }

    return null;
  };

  // BotCityOps.py:1489 should_allow_neutral_city_capture
  BotCityOps.should_allow_neutral_city_capture = function (bot, genPlayer, forceNeutralCapture, targetCity) {
    if (targetCity === undefined) targetCity = null;
    var map = mapOf(bot);
    var general = bot.general;

    var cityCost = 50;
    if (map.walled_city_base_value !== null && map.walled_city_base_value !== undefined) {
      cityCost = map.walled_city_base_value;
    }
    if (targetCity !== null) cityCost = targetCity.army + 1;

    if (bot.player.standingArmy - 15 < cityCost && !map.is_walled_city_game) return false;

    if (bot.targetPlayer !== -1) {
      var cycleLeft = turnsLeftInCycle(bot);
      var threatTurns = cycleLeft - 20;
      var spToTarget = bot.shortest_path_to_target_player;
      if (!spToTarget) {
        degraded('bot.shortest_path_to_target_player');
        return false;
      }
      var minFogDist = Math.trunc(spToTarget.length / 2) + 3;
      if (bot.enemy_attack_path) {
        var enFogged = typeof bot.enemy_attack_path.get_subsegment_excluding_trailing_visible === 'function'
          ? bot.enemy_attack_path.get_subsegment_excluding_trailing_visible()
          : bot.enemy_attack_path;
        if (enFogged && enFogged.tail) minFogDist = distFromGeneral(bot, enFogged.tail.tile) + 1;
      }
      if (threatTurns < minFogDist) threatTurns = minFogDist;
      if (threatTurns < 6) threatTurns = 6;

      var defTurns = threatTurns;
      var distPenalty = targetCity !== null ? distFromGeneral(bot, targetCity) : 4;
      var interEnemyMap = bot.board_analysis && bot.board_analysis.intergeneral_analysis
        ? bot.board_analysis.intergeneral_analysis.bMap : null;
      var enDistPenalty = targetCity !== null
        ? spToTarget.length - rawAt(interEnemyMap, targetCity) : 0;
      enDistPenalty = Math.max(0, enDistPenalty);
      var generalContribution = Math.max(0, Math.trunc(defTurns / 2) - 2 - distPenalty - enDistPenalty);
      var planTiles = toArr(bot.city_capture_plan_tiles);
      var cityContribution = Math.max(0, Math.trunc((defTurns - planTiles.length) / 2) - 3);

      var cityDefVal = generalContribution + cityContribution;
      if (!bot.was_allowing_neutral_cities_last_turn) cityDefVal -= 10;
      var searchNegs = new Set();
      if (bot.city_capture_plan_last_updated > map.turn - 2
        && bot.city_capture_plan_tiles && bot.city_capture_plan_tiles.has(targetCity)) {
        for (var i = 0; i < planTiles.length; i++) {
          var pt = planTiles[i];
          if (map.team_ids_by_player_index[playerOf(pt)] !== map.friendly_team) continue;
          searchNegs.add(pt);
          cityDefVal += pt.army - 1;
        }
        cityDefVal -= targetCity.army;
      } else {
        var tgCities = targetCity !== null ? [targetCity] : (bot.cityAnalyzer && bot.cityAnalyzer.city_scores
          ? Array.from(bot.cityAnalyzer.city_scores.keys()) : []);
        if (tgCities.length > 0) {
          cityDefVal -= tgCities[0].army;
          var playerTilesNearCity = getPlayerTilesNearUpToArmyAmount(map, tgCities, tgCities[0].army, gplayer(general), 1);
          for (var pt2 = 0; pt2 < playerTilesNearCity.length; pt2++) searchNegs.add(playerTilesNearCity[pt2]);
          var defTile = general;
          if (targetCity !== null && rawAt(interEnemyMap, defTile) > rawAt(interEnemyMap, targetCity)) {
            defTile = targetCity;
          }
          for (var ct = 0; ct < playerTilesNearCity.length; ct++) {
            cityDefVal += BotCityOps._get_city_defense_tile_contribution(
              bot, playerTilesNearCity[ct], tgCities[0], defTile, defTurns);
          }
        } else {
          viStats(bot, 'bypassing neut cities, 0 neut cities available :(');
          return false;
        }
      }

      var defTile2 = general;
      if (targetCity !== null && rawAt(interEnemyMap, defTile2) > rawAt(interEnemyMap, targetCity)) {
        defTile2 = targetCity;
      }
      var attackNegs = copySet(searchNegs);
      var lpt = toArr(bot.largePlayerTiles);
      for (var lp = 0; lp < lpt.length; lp++) attackNegs.add(lpt[lp]);

      var w = wca(bot);
      var risk = 0;
      if (w && typeof w.get_approximate_attack_against === 'function') {
        risk = w.get_approximate_attack_against([defTile2], threatTurns, bot.targetPlayer, true, attackNegs);
      } else {
        // 算不出的威胁按「没有威胁」处理：保守的相反方向反而会永远不拿城
        degraded('WinConditionAnalyzer.get_approximate_attack_against');
        risk = 0;
      }

      var roundTimingOffset = Math.trunc(threatTurns / 2);
      risk += roundTimingOffset;

      var requiredDefenseArmy = risk + cityCost - cityDefVal;
      var defValue = 0;
      if (w && typeof w.get_dynamic_turns_visible_defense_against === 'function') {
        var dv = w.get_dynamic_turns_visible_defense_against([defTile2], defTurns, gplayer(general), requiredDefenseArmy, searchNegs);
        defValue = dv[1];
      } else {
        degraded('WinConditionAnalyzer.get_dynamic_turns_visible_defense_against');
        defValue = 0;
      }

      var armyBonusDefense = 1 * Math.max(0, defTurns - cycleLeft);
      var hackToEnsureCity = bot.was_allowing_neutral_cities_last_turn
        && bot.targetPlayerObj && bot.targetPlayerObj.tileCount > 60 ? 30 : 0;
      var defAfterCity = defValue + cityDefVal + armyBonusDefense;
      var ot = bot.opponent_tracker || null;
      var evenOrUp = ot && typeof ot.even_or_up_on_cities === 'function'
        ? ot.even_or_up_on_cities(bot.targetPlayer) : false;
      if (evenOrUp) {
        if (risk > defAfterCity + hackToEnsureCity && risk > 5) {
          bot.is_blocking_neutral_city_captures = true;
          viStats(bot, 'bypassing neut cities, danger ' + risk + ' in ' + threatTurns + ' > ' + defAfterCity);
          return false;
        }
        if (bot.is_blocking_neutral_city_captures) {
          viStats(bot, 'bypassing neut cities due to is_blocking_neut_city_capt');
          return false;
        }
      }

      if (bot.defend_economy && (bot.targetPlayer === -1 || evenOrUp)) {
        viStats(bot, 'bypassing neut cities due to defend_economy');
        return false;
      }
    }

    var proactivelyTakeCity = BotCityOps.should_proactively_take_cities(bot) || forceNeutralCapture;
    var threat = bot.threat || null;
    var safeFromThreat = threat === null || threat === undefined
      || threat.threatType !== 'Kill'
      || threat.threatValue <= threat.turns
      || (threat.turns > 6 && threat.path && threat.path.start && !threat.path.start.tile.visible)
      || !(threat.path && threat.path.tail && threat.path.tail.tile.isGeneral);
    if (!safeFromThreat) {
      viInfo(bot, 'Will not proactively take cities due to the existing threat....');
      proactivelyTakeCity = false;
      if (threat.threatValue > Math.trunc(cityCost / 2)) {
        forceNeutralCapture = false;
        bot.force_city_take = false;
      }
    }

    var forceCityOffset = 0;
    var sp = bot.shortest_path_to_target_player;
    if (bot.force_city_take || (sp && call('BotTargeting', 'is_player_spawn_cramped', [bot, sp.length], false))) {
      forceCityOffset = 1;
    }

    var targCities = 1;
    var targetPlayer = null;
    if (bot.targetPlayer !== -1) targetPlayer = map.players[bot.targetPlayer];
    if (targetPlayer !== null) targCities = targetPlayer.cityCount;

    var cityTakeThreshold = targCities + forceCityOffset;

    if (bot.targetPlayer === -1 || map.remainingPlayers <= 3 || bot.force_city_take) {
      if (targetPlayer === null
        || ((genPlayer.cityCount < cityTakeThreshold || proactivelyTakeCity) && safeFromThreat)) {
        if (forceNeutralCapture || targetPlayer === null || genPlayer.cityCount < cityTakeThreshold
          || bot.force_city_take || proactivelyTakeCity) {
          return true;
        }
      }
    }
    return false;
  };

  // SearchUtils.get_player_tiles_near_up_to_army_amount 的本地复刻：
  // 从 fromTiles 外扩，收我方格直到累计 army 达到 armyAmount。
  function getPlayerTilesNearUpToArmyAmount(map, fromTiles, armyAmount, asPlayer, tileAmountCutoff) {
    var out = [];
    var sum = 0;
    var seen = new Set(toArr(fromTiles));
    var frontier = toArr(fromTiles).slice();
    while (frontier.length > 0 && sum < armyAmount) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var t = frontier[i];
        if (t.army > 0 && map.is_player_on_team_with(asPlayer, playerOf(t)) && t.army > 1) {
          out.push(t);
          sum += t.army - 1;
          if (out.length >= tileAmountCutoff) return out;
        }
        var mov = toArr(t.movable);
        for (var k = 0; k < mov.length; k++) {
          if (!seen.has(mov[k])) { seen.add(mov[k]); next.push(mov[k]); }
        }
      }
      frontier = next;
    }
    return out;
  }

  // BotCityOps.py:1714 get_city_contestation_all_in_move
  BotCityOps.get_city_contestation_all_in_move = function (bot, defenseCriticalTileSet) {
    var map = mapOf(bot);
    var w = wca(bot);
    var targets = w && w.contestable_cities ? Array.from(w.contestable_cities) : [];

    var negatives = copySet(defenseCriticalTileSet);
    if (w && w.defend_cities) for (var d = 0; d < toArr(w.defend_cities).length; d++) negatives.add(toArr(w.defend_cities)[d]);

    if (targets.length === 0) {
      var possibleGens = call('BotTargeting', 'get_target_player_possible_general_location_tiles_sorted',
        [bot, 7, 0.5], []);
      targets = toArr(possibleGens).slice(0, 3);
    }

    var turns = w && w.recommended_offense_plan_turns ? w.recommended_offense_plan_turns : turnsLeftInCycle(bot);
    var targetPlayerLocation = w ? (w.target_player_location || null) : null;
    if (targetPlayerLocation !== null && targetPlayerLocation.isGeneral
      && w.contestable_cities && w.contestable_cities.has(targetPlayerLocation)) {
      var allInPlan = w.our_best_attack_plan || null;
      if (allInPlan !== null) {
        var move0 = allInPlan.get_first_move();
        if (move0 !== null && move0 !== undefined) {
          viTargeted(bot, targetPlayerLocation, 'ORANGE');
          return [move0, allInPlan.gathered_army, allInPlan.length, allInPlan.root_nodes];
        }
      }
    }

    var gres = call('BotGatherOps', 'get_gather_to_target_tiles',
      [bot, targets, 0.05, turns, defenseCriticalTileSet, -1,
        true, null, false, true, 0, null, null, null, false, false, 0],
      [null, -1, -1, null]);
    var move = gres[0];
    var valGathered = gres[1];
    var gatherTurns = gres[2];
    var gatherNodes = gres[3];

    if (gatherNodes && gatherNodes.length > 0) {
      var prefer = bot.expansion_plan ? bot.expansion_plan.preferred_tiles : null;
      var pv = pruneToTurnsValues(bot, gatherNodes, gatherTurns, 0, prefer);
      var prunedGatherTurns = pv[0];
      var sumPruned = pv[1];
      var prunedGatherNodes = pv[2];

      var rootGatheredTiles = [];
      for (var r = 0; r < prunedGatherNodes.length; r++) rootGatheredTiles.push(prunedGatherNodes[r].tile);
      var defVal = 0;
      if (w && typeof w.get_dynamic_turns_visible_defense_against === 'function' && prunedGatherNodes.length > 0) {
        var dv = w.get_dynamic_turns_visible_defense_against(
          rootGatheredTiles, prunedGatherTurns, playerOf(prunedGatherNodes[0].tile));
        defVal = dv[1];
      } else {
        degraded('WinConditionAnalyzer.get_dynamic_turns_visible_defense_against');
      }
      var fogRisk = bot.opponent_tracker
        && typeof bot.opponent_tracker.get_approximate_fog_army_risk === 'function'
        ? bot.opponent_tracker.get_approximate_fog_army_risk(bot.targetPlayer, 0) : 0;
      if (sumPruned < defVal + fogRisk) return [null, 0, 0, []];

      var numCaptures = call('BotGatherOps', 'get_number_of_captures_in_gather_tree', [bot, prunedGatherNodes], 0);

      var threshold = 3 * bot.player.standingArmy / Math.max(1, bot.player.tileCount) - 1;
      if (sumPruned / Math.max(1, prunedGatherTurns - numCaptures) > threshold) {
        if (prunedGatherNodes.length > 0) {
          move = call('BotGatherOps', 'get_tree_move_default', [bot, gatherNodes, null, false], null);
        }
        for (var tg = 0; tg < targets.length; tg++) viTargeted(bot, targets[tg], 'ORANGE');
        return [move, sumPruned, prunedGatherTurns, prunedGatherNodes];
      }
    }

    return [null, 0, 0, []];
  };

  // BotCityOps.py:1776 get_city_preemptive_defense_move
  BotCityOps.get_city_preemptive_defense_move = function (bot, defenseCriticalTileSet) {
    var map = mapOf(bot);
    if (call('BotStateQueries', 'is_still_ffa_and_non_dominant', [bot], false)) return null;

    var w = wca(bot);
    var sketchyOutOfPlayThresh = Math.trunc(bot.player.standingArmy / 6);
    var sketchyCities = w && w.defend_cities ? sortedByIndex(w.defend_cities) : [];
    var targets = w && w.defend_cities ? sortedByIndex(w.defend_cities) : [];

    if (sketchyCities.length > 0) {
      var sketchyLargeArmyCities = sketchyCities.filter(function (c) {
        return c.army > Math.trunc(sketchyOutOfPlayThresh / 4);
      });
      if (sketchyLargeArmyCities.length > 0) sketchyLargeArmyCities = sketchyCities;
      var sketchyArmy = 0;
      for (var i = 0; i < sketchyCities.length; i++) sketchyArmy += sketchyCities[i].army - 1;

      if (sketchyArmy > sketchyOutOfPlayThresh && bot.sketchiest_potential_inbound_flank_path) {
        var aMap = bot.board_analysis && bot.board_analysis.intergeneral_analysis
          ? bot.board_analysis.intergeneral_analysis.aMap : null;
        var furthestCity = sketchyLargeArmyCities[0];
        for (var f = 1; f < sketchyLargeArmyCities.length; f++) {
          if (rawAt(aMap, sketchyLargeArmyCities[f]) > rawAt(aMap, furthestCity)) furthestCity = sketchyLargeArmyCities[f];
        }
        var furthestDist = rawAt(aMap, furthestCity);
        var flankTail = bot.sketchiest_potential_inbound_flank_path.tail;
        var fogDist = flankTail ? rawAt(aMap, flankTail.tile) : furthestDist + 1;

        if (fogDist <= furthestDist) {
          var negs = copySet(defenseCriticalTileSet);
          for (var s = 0; s < sketchyCities.length; s++) negs.add(sketchyCities[s]);
          var flankDefenseMove = call('BotDefense', '_get_flank_vision_defense_move_internal',
            [bot, bot.sketchiest_potential_inbound_flank_path, negs, furthestDist], null);
          if (flankDefenseMove !== null && flankDefenseMove !== undefined) return flankDefenseMove;
        }
      }
    }

    var ot = bot.opponent_tracker || null;
    var wouldStillBeAheadIfOppTakesCity = ot && typeof ot.winning_on_economy === 'function'
      ? ot.winning_on_economy(1.02, undefined, undefined, -33) : false;

    var spToTarget = bot.shortest_path_to_target_player;
    if (!spToTarget) {
      degraded('bot.shortest_path_to_target_player');
      return null;
    }

    var turnsLeft = turnsLeftInCycle(bot);
    var turnCutoffLowEcon = Math.trunc(spToTarget.length * 1.0);
    var turnCutoffHighEcon = Math.trunc(spToTarget.length * 0.4);
    if (turnsLeft <= turnCutoffHighEcon) {
      viInfo(bot, 'bypassing preemptive city defense t' + turnsLeft + '/' + turnCutoffHighEcon + ' (high econ)');
      return null;
    }

    if (turnsLeft <= turnCutoffLowEcon && !wouldStillBeAheadIfOppTakesCity) {
      viInfo(bot, 'bypassing preemptive city defense t' + turnsLeft + '/' + turnCutoffLowEcon);
      return null;
    }

    var negs2 = copySet(defenseCriticalTileSet);
    for (var t1 = 0; t1 < targets.length; t1++) negs2.add(targets[t1]);
    var ownedContested = bot.cityAnalyzer && bot.cityAnalyzer.owned_contested_cities
      ? sortedByIndex(bot.cityAnalyzer.owned_contested_cities) : [];
    for (var oc = 0; oc < ownedContested.length; oc++) negs2.add(ownedContested[oc]);

    var newTargets = new Set(sortedByIndex(bot.defensive_spanning_tree || []));

    var bonusTurns = bot.defend_economy ? 5 : 0;
    var recommended = w && w.recommended_city_defense_plan_turns ? w.recommended_city_defense_plan_turns : 0;
    if (!(w && w.recommended_city_defense_plan_turns !== undefined)) {
      degraded('WinConditionAnalyzer.recommended_city_defense_plan_turns');
    }
    var gathTurns = recommended > 0 ? Math.min(turnsLeft, recommended + bonusTurns) : turnsLeft;

    var targetArr = Array.from(newTargets);
    var tiebreak = call('BotGatherOps', 'get_gather_tiebreak_matrix', [bot], null);
    var gres = call('BotGatherOps', 'get_gather_to_target_tiles',
      [bot, targetArr, 0.05, gathTurns, negs2, -1,
        true, null, false, false, 0, null, tiebreak, null, false, false, 0],
      [null, -1, -1, null]);
    var move = gres[0];
    var valGathered = gres[1];
    var gatherTurns = gres[2];
    var gatherNodes = gres[3];

    var numCaptures = call('BotGatherOps', 'get_number_of_captures_in_gather_tree', [bot, gatherNodes], 0);

    if (valGathered / Math.max(1, gatherTurns - numCaptures) < bot.player.standingArmy / Math.max(1, bot.player.tileCount)) {
      var cycleTurns = Math.min(turnsLeft, 10);
      var gres2 = call('BotGatherOps', 'get_gather_to_target_tiles',
        [bot, targetArr, 0.05, cycleTurns, negs2, -1,
          true, null, false, false, 0, null, tiebreak, null, false, false, 0],
        [null, -1, -1, null]);
      move = gres2[0];
      valGathered = gres2[1];
      gatherTurns = gres2[2];
      gatherNodes = gres2[3];

      if (gatherNodes && gatherNodes.length > 0) {
        var prefer2 = bot.expansion_plan ? bot.expansion_plan.preferred_tiles : null;
        var pv = pruneToTurnsValues(bot, gatherNodes, cycleTurns, 0, prefer2);
        var prunedGatherTurns = pv[0];
        var sumPruned = pv[1];
        var prunedGatherNodes = pv[2];
        if (prunedGatherNodes && prunedGatherNodes.length > 0) {
          move = call('BotGatherOps', 'get_tree_move_default', [bot, gatherNodes, null, false], null);
          valGathered = sumPruned;
          gatherTurns = prunedGatherTurns;
          gatherNodes = prunedGatherNodes;
        }
      }
    }

    if (move !== null && move !== undefined) {
      if (gatherNodes !== null && gatherNodes !== undefined) {
        var valFunc = function (tile, tuple) { return 0 - tile.army; };
        var moves = EK.Gather.get_tree_moves(gatherNodes, valFunc);
        bot.curPath = new EK.MoveListPath(moves);
      }
      info(bot, 'C preDef ' + move + ' - ' + valGathered + ' in turns ' + gatherTurns);
    }

    return move;
  };

  BotCityOps.report = function () {
    var out = {};
    for (var k in _degrade) {
      if (Object.prototype.hasOwnProperty.call(_degrade, k)) out[k] = _degrade[k];
    }
    return out;
  };
  BotCityOps.resetReport = function () { _degrade = {}; };

  EK.BotCityOps = BotCityOps;
  EK.cityops = BotCityOps;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
