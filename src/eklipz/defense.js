/*
 * BotDefense 移植
 *
 * 原版：E:\akcoco6de\_research\generals-bot-cs\BotModules\BotDefense.py（2661 行）
 *
 * 算法一句话：把「敌人几回合后能从哪杀到我方将军/城」这件事翻译成一组否决条件 ——
 * 对每个威胁格产生一张拦截方案表（ArmyInterceptor 出的 turns->option），再由这里按
 * 「经济值/回合数」挑一条、判断这条会不会送、会不会重复出招、会不会撞上另一条威胁的要道，
 * 最后交给上层去和扩张竞争。
 *
 * bot 需要提供的字段（JS 版全是鸭子类型，缺字段就跳过对应分支）：
 *   bot.map / bot._map        EK.Map
 *   bot.general               Tile（我方将军）
 *   bot.targetPlayer          当前主要对手的 player index
 *   bot.armyTracker           EK.ArmyTracker
 *   bot.opponent_tracker      EK.OpponentTracker
 *   bot.dangerAnalyzer        EK.DangerAnalyzer
 *   bot.army_interceptor      EK.ArmyInterceptor
 *   bot.intercept_plans       Map<Tile, ArmyInterception>（build_intercept_plans 的产物）
 *   bot.history               { move_history, droppedHistory }（BotRepetition 用）
 *   bot.timings               可选，需有 get_turn_in_cycle / get_turns_left_in_cycle / launchTiming
 *   bot.expansion_plan        可选，需有 selected_option / intercept_waiting
 *   bot.territories           可选，需有 is_tile_in_friendly_territory
 *   bot.board_analysis        可选，需有 intergeneral_analysis / inter_general_distance
 *   bot.target_player_gather_path   可选
 *   bot.cityAnalyzer          可选，需有 owned_contested_cities
 * 都可换上你自己名字的字段，只要把别名补进 _alias() 那张表。
 *
 * M3 补全记录：原先这里列了 5 条「没有移植的部分」，依赖（Gather / GatherPrune /
 * BotGatherOps / BotExpansionOps / interceptor / board_analysis 的 flank 矩阵）现在都到位了，
 * 下列函数已按原版逐函数搬进本文件：
 *   get_defense_moves / try_threat_gather / get_gather_to_threat_path(s) /
 *   get_gather_to_threat_path_greedy / check_defense_hybrid_intercept_moves /
 *   _get_defensive_spanning_tree / get_enemy_probable_attack_path /
 *   find_sketchiest_fog_flank_from_enemy / find_sketchiest_fog_flank_from_enemy_in_play_area /
 *   find_flank_opportunity / _get_flank_defense_leafmove /
 *   _get_flank_vision_defense_move_internal / get_best_defense /
 *   set_defensive_blocks_against / check_should_defend_economy_based_on_large_tiles /
 *   determine_should_defend_ally
 *
 * 与原版仍然存在的差异，只有这三条（其余逐字照抄）：
 * a. 没有 BotComms：「告诉队友」只记账，_communicateThreatToAlly 是空操作。
 * b. GatherPrune 的 *_with_values 三个变体 JS 侧没有，本文件用 prune_mst_until 重新组。
 * c. 原版在 BYPASS_TIMEOUTS_FOR_DEBUGGING 下的断言改成不抛（生产路径本来就不抛）。
 *
 * 与框架的差异（为什么这么改）：
 * 6. tile.player 是属性 vs 方法 —— 统一走 _player()。
 * 7. MapMatrix 不支持 [] 下标 —— 统一走 .raw[idx]，并由 _mat() 把越界收敛成 null / 大数，
 *    对应原版 Python 里 `None` 参与比较时的语义（原版在几个地方会因此抛 TypeError，这里换成显式分支）。
 * 8. 原版用 time.perf_counter() 做时间片（build_intercept_plans 的 timeCut）。
 *    这里改用可注入的 now()（默认 Date.now），并且默认只保留 limit 语义，不做时间片 ——
 *    移植后的 plan() 必须在同样的输入下给出同样的输出，时间片会破坏这个性质。
 * 9. bot.expansion_plan / territories / board_analysis 缺失时按「没有该信息」降级，
 *    降级方向一律选保守：宁可少拦一次，也不给出会送掉的招。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---------------- 收口层 ---------------- */

  function _map(bot) {
    return bot.map || bot._map;
  }

  function _player(tile) {
    if (tile === null || tile === undefined) return -1;
    return typeof tile.player === 'function' ? tile.player() : tile._player;
  }

  function _idx(tile) {
    return tile.tile_index;
  }

  // MapMatrix 只有 .raw；普通数组这两种都能命中。undefined -> null，和 Python 的 None 对齐。
  function _mat(mat, tile) {
    if (mat === null || mat === undefined) return null;
    var v = mat.raw ? mat.raw[_idx(tile)] : mat[_idx(tile)];
    return v === undefined ? null : v;
  }

  function _alias(bot, names) {
    for (var i = 0; i < names.length; i++) {
      var v = bot[names[i]];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  }

  function _interceptor(bot) {
    return _alias(bot, ['army_interceptor', 'interceptor', 'armyInterceptor']);
  }

  function _timings(bot) {
    return _alias(bot, ['timings', 'botTimings']);
  }

  function _turnsLeftInCycle(bot) {
    var map = _map(bot);
    var timings = _timings(bot);
    if (timings && typeof timings.get_turns_left_in_cycle === 'function') {
      return timings.get_turns_left_in_cycle(map.turn);
    }
    if (typeof map.remainingCycleTurns === 'number') return map.remainingCycleTurns;
    return 50 - (map.turn % 50);
  }

  function _turnInCycle(bot) {
    var map = _map(bot);
    var timings = _timings(bot);
    if (timings && typeof timings.get_turn_in_cycle === 'function') {
      return timings.get_turn_in_cycle(map.turn);
    }
    return 50 - _turnsLeftInCycle(bot);
  }

  function _army(bot, tile) {
    if (bot.armyTracker) return bot.armyTracker.get_or_create_army_at(tile);
    return null;
  }

  // 原版 BotPathingUtils.distance_from_general 在 _gen_distances 没算出来时返回 0，
  // 那个 0 会让「离将军多远」的判断全部失效（0 比任何值都近），所以这里退到真实距离。
  function _genDist(bot, tile) {
    if (bot._gen_distances) {
      var v = _mat(bot._gen_distances, tile);
      if (v !== null) return v;
    }
    if (bot.general === tile) return 0;
    var map = _map(bot);
    var d = map.distance_mapper.get_distance_between_or_none(bot.general, tile);
    return d === null || d === undefined ? 10000 : d;
  }

  function _euclid(map, x1, y1, x2, y2) {
    var dx = x1 - x2;
    var dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function _isFriendlyTile(bot, tile) {
    return _map(bot).is_tile_friendly(tile);
  }

  function _inFriendlyTerritory(bot, tile) {
    var territories = _alias(bot, ['territories', 'territoryClassifier']);
    if (territories && typeof territories.is_tile_in_friendly_territory === 'function') {
      return !!territories.is_tile_in_friendly_territory(tile);
    }
    // 没有 TerritoryClassifier 时退到「这一格是不是我的」——比原版宽松，但方向一致。
    return _map(bot).is_player_on_team_with(_player(tile), _player(bot.general));
  }

  function _isFfa(bot) {
    var map = _map(bot);
    return map.remainingPlayers > 2 && !map.is_2v2;
  }

  function _aggression(bot, playerId) {
    var map = _map(bot);
    var p = map.players[playerId];
    return p && typeof p.aggression_factor === 'number' ? p.aggression_factor : 0;
  }

  // 原版 BotCombatQueries.count_enemy_territory_near_tile：数「将军周围 distance 跳内」的敌方格。
  // JS 侧没有那个模块，这里用一层 BFS 直接数，语义一致（不数自己队伍的格）。
  function _countEnemyTerritoryNearTile(bot, tile, distance) {
    var map = _map(bot);
    var myTeam = map.team_ids_by_player_index[_player(bot.general)];
    var count = 0;
    var seen = new Set();
    seen.add(tile);
    var frontier = [tile];
    for (var d = 0; d < distance; d++) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var movs = frontier[i].movable;
        for (var j = 0; j < movs.length; j++) {
          var t = movs[j];
          if (seen.has(t)) continue;
          seen.add(t);
          next.push(t);
          var tp = _player(t);
          if (tp >= 0 && map.team_ids_by_player_index[tp] !== myTeam) count += 1;
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return count;
  }

  // 原版 BotCombatQueries.sum_friendly_army_near_or_on_tiles 的等价替代（BFS 半径内我方可用兵力）。
  function _sumFriendlyArmyNearOrOnTiles(bot, tiles, distance) {
    var map = _map(bot);
    var myPlayer = _player(bot.general);
    var seen = new Set();
    var frontier = [];
    var sum = 0;
    var list = tiles || [];
    for (var i = 0; i < list.length; i++) {
      if (seen.has(list[i])) continue;
      seen.add(list[i]);
      frontier.push(list[i]);
    }
    for (var d = 0; d <= distance; d++) {
      var next = [];
      for (var k = 0; k < frontier.length; k++) {
        var t = frontier[k];
        if (map.is_player_on_team_with(_player(t), myPlayer)) sum += Math.max(0, t.army - 1);
        var movs = t.movable;
        for (var m = 0; m < movs.length; m++) {
          if (seen.has(movs[m])) continue;
          seen.add(movs[m]);
          next.push(movs[m]);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return sum;
  }

  function _emptyExpansionPlan() {
    return { selected_option: null, intercept_waiting: [] };
  }

  function _expansionPlan(bot) {
    return _alias(bot, ['expansion_plan', 'expansionPlan']) || _emptyExpansionPlan();
  }

  /* ---------------- BotDefense ---------------- */

  function BotDefense() {}

  /*
   * 敌人还有多少「看不见的兵」会在 fogDefenseTurns 内被用在这片区域上。
   * 原版从 opponent_tracker 的 fog 风险里减掉「够不着这里的已知 army」，
   * 这里保持同样的减项，但 reachable 的判定换成 genReachable 矩阵（原版就是这个）。
   */
  BotDefense.determine_fog_defense_amount_available_for_tiles = function (
    bot,
    targetTiles,
    enPlayer,
    fogDefenseTurns,
    fogReachTurns
  ) {
    if (fogDefenseTurns === undefined) fogDefenseTurns = 0;
    if (fogReachTurns === undefined) fogReachTurns = 8;

    var map = _map(bot);
    var ot = _alias(bot, ['opponent_tracker', 'opponentTracker']);
    var targetArmy = ot.get_approximate_fog_army_risk(enPlayer, null, fogDefenseTurns);

    var tilesArr = Array.isArray(targetTiles) ? targetTiles : Array.from(targetTiles);
    var genReachable = EK.search.build_distance_map_matrix_with_skip(map, tilesArr, map.visible_tiles, fogReachTurns);

    var armies = bot.armyTracker ? bot.armyTracker.armies : null;
    if (armies) {
      var used = new Set();
      var values = typeof armies.values === 'function' ? Array.from(armies.values()) : [];
      for (var i = 0; i < values.length; i++) {
        var army = values[i];
        if (army.player !== enPlayer) continue;
        if (used.has(army.name)) continue;
        if (army.tile.visible) continue;

        var anyReachable = false;
        var cdist = _mat(genReachable, army.tile);
        if (cdist === null || cdist >= fogReachTurns) {
          var entangled = army.entangledArmies || [];
          for (var e = 0; e < entangled.length; e++) {
            var edist = _mat(genReachable, entangled[e].tile);
            if (edist !== null && edist < fogReachTurns) {
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
    }

    return targetArmy;
  };

  /*
   * 这一步走完以后，我方是不是还站在「能拦住那条威胁」的位置上。
   * 只看 Kill 类威胁；只看「从要道撤出来」和「从威胁路径上撤出来」这两种自杀姿势。
   */
  BotDefense.is_move_safe_against_threats = function (bot, move, threat) {
    if (threat === undefined) {
      threat = _alias(bot, ['threat', 'curThreat']);
      if (!threat && bot.dangerAnalyzer) threat = bot.dangerAnalyzer.fastestPotentialThreat;
    }
    if (!threat) return true;
    if (threat.threatType !== EK.ThreatType.Kill) return true;

    var aa = threat.armyAnalysis;
    var threatStart = threat.path.start;
    if (move.dest === threatStart.tile) return true;
    if (threatStart.next && move.dest === threatStart.next.tile) {
      var atOne = aa.tileDistancesLookup && aa.tileDistancesLookup[1];
      if (atOne && atOne.length === 1) return true;
    }
    var bAtSource = _mat(aa.bMap, move.source);
    var aAtSource = _mat(aa.aMap, move.source);
    if (bAtSource !== null && bAtSource < 6 && aAtSource !== 0) {
      if (aa.is_choke(move.source) && !aa.is_choke(move.dest)) return false;
      if (threat.path.tileSet.has(move.source) && !threat.path.tileSet.has(move.dest)) return false;
    }

    return true;
  };

  /*
   * 这条拦截路径是不是「从别处被吓跑的」——如果起点在另一条潜在威胁的路径上、
   * 而下一格已经离开那条路径，那这个起点本身就是在逃，不是去拦。
   */
  BotDefense._is_invalid_defense_intercept_for_threat = function (bot, interceptPath, threat) {
    if (!interceptPath) return false;

    var pathStart = interceptPath.start;
    if (!pathStart || !pathStart.next) return false;

    var potentialThreat = bot.dangerAnalyzer ? bot.dangerAnalyzer.fastestPotentialThreat : null;
    if (potentialThreat && potentialThreat !== threat) {
      if (
        potentialThreat.path.tileSet.has(pathStart.tile) &&
        !potentialThreat.path.tileSet.has(pathStart.next.tile)
      ) {
        return true;
      }
    }

    if (!threat.path.tail.tile.isGeneral) return false;

    return threat.path.tileSet.has(pathStart.tile);
  };

  /*
   * 从「已经选好的拦截方案」或整张方案表里挑一条。优先沿用上层已经决定的那条（保证不抖），
   * 其次挑经济值/回合最高的；经济值全部低于 1 时改挑「到位兵力/回合」最高的。
   * 返回 (path, option)，顺序和原版一致（path 在前）。
   */
  BotDefense.get_defense_path_option_from_options_if_available = function (bot, threatInterceptionPlan, threat) {
    var plan = _expansionPlan(bot);
    var interceptPath = plan.selected_option || null;
    var interceptingOption = null;

    if (interceptPath && interceptPath.constructor === EK.InterceptionOptionInfo) {
      var matching = threatInterceptionPlan.intercept_options.get(interceptPath.length);
      if (matching === interceptPath) {
        interceptingOption = interceptPath;
        interceptPath = interceptingOption.path;
        if (!_mapHasValue(threatInterceptionPlan.intercept_options, matching)) return [null, null];
      }
    }

    if (BotDefense._is_invalid_defense_intercept_for_threat(bot, interceptPath, threat)) {
      interceptPath = null;
      interceptingOption = null;
    }

    if (!interceptingOption) interceptPath = null;

    var includesIntercept = false;
    var waiting = plan.intercept_waiting || [];
    for (var w = 0; w < waiting.length; w++) {
      var delayedOption = waiting[w];
      if (
        threatInterceptionPlan.threats.indexOf(threat) >= 0 &&
        _mapHasValue(threatInterceptionPlan.intercept_options, delayedOption)
      ) {
        if (BotDefense._is_invalid_defense_intercept_for_threat(bot, delayedOption.path, threat)) continue;
        interceptPath = delayedOption.path;
        includesIntercept = true;
        interceptingOption = delayedOption;
        break;
      }
    }

    if (!interceptingOption) {
      var vt = 0;
      var at = 0;
      var entries = Array.from(threatInterceptionPlan.intercept_options.entries());
      for (var i = 0; i < entries.length; i++) {
        var turns = entries[i][0];
        var intercept = entries[i][1];
        if (BotDefense._is_invalid_defense_intercept_for_threat(bot, intercept.path, threat)) continue;

        var optVt = intercept.econValue / turns;
        var optAt = intercept.friendly_army_reaching_intercept / turns;

        if (optVt > vt) {
          vt = optVt;
          at = optAt;
          interceptingOption = intercept;
          interceptPath = interceptingOption.path;
        } else if (vt < 1 && optAt > at) {
          vt = optVt;
          at = optAt;
          interceptingOption = intercept;
          interceptPath = interceptingOption.path;
        }
      }
    }

    if (!includesIntercept && interceptingOption && _mapHasValue(threatInterceptionPlan.intercept_options, interceptingOption)) {
      if (threat.threatValue - interceptingOption.friendly_army_reaching_intercept < 0) {
        includesIntercept = true;
        var byPath = threatInterceptionPlan.get_intercept_option_by_path(interceptPath);
        if (byPath) interceptingOption = byPath;
      } else {
        return [null, null];
      }
    }

    return [interceptPath, interceptingOption];
  };

  function _mapHasValue(map, value) {
    if (!map) return false;
    var it = map.values();
    var cur = it.next();
    while (!cur.done) {
      if (cur.value === value) return true;
      cur = it.next();
    }
    return false;
  }

  /*
   * 只为「敌人在打我将军」这一种情况临时算一份单人拦截方案，挑最早能成的那条。
   * 原版会跳过重复出招的方案；这里保留（重复出招 = 明明能拦却原地抖，比不拦更糟）。
   */
  BotDefense.check_kill_threat_only_defense_interception = function (bot, threat) {
    if (!threat.path.tail.tile.isGeneral) return [null, null, null, false];

    var interceptor = _interceptor(bot);
    if (!interceptor) return [null, null, null, false];

    var map = _map(bot);
    var plan = interceptor.get_interception_plan([threat], map.remainingCycleTurns, null, null, null);
    var bestIsDelayed = false;
    if (!plan || plan.intercept_options.size === 0) return [null, null, null, bestIsDelayed];

    var bestOption = null;
    var bestPath = null;
    var bestMove = null;

    var maxI = Math.floor(threat.turns / 2) + 1;
    for (var i = 0; i < maxI; i++) {
      var option = plan.intercept_options.get(i);
      if (!option) continue;

      var path = option.path;
      if (_hasRepetition(bot, option.path.get_first_move())) continue;

      if (bestOption !== null && bestOption.econValue / Math.max(1, bestOption.length) >= option.econValue / Math.max(1, option.length)) {
        continue;
      }
      if (!path) continue;

      // 原版两个变量取同一个表达式（逐字如此），保留以免和原版的取舍错位。
      var notEnough = option.friendly_army_reaching_intercept < threat.threatValue;

      if (threat.path.tail.tile.isGeneral) {
        if (notEnough) continue;
      }

      bestMove = EK.BotPathingUtils.get_first_path_move(bot, path);
      bestOption = option;
      bestPath = path;
      bestIsDelayed = option.requiredDelay > 0;
    }

    return [bestMove, bestPath, bestOption, bestIsDelayed];
  };

  function _hasRepetition(bot, move, turns, reps) {
    if (!move || !bot.history) return false;
    return !!EK.BotRepetition.detect_repetition(bot, move, turns === undefined ? 4 : turns, reps === undefined ? 2 : reps);
  }

  /*
   * 敌人的兵力影子已经两周没动过 / 那格根本没兵了，就别再为它拦截了。
   * 三条条件是「或」关系，逐字照抄；第二条额外管城市（城市不动也可能在产兵）。
   */
  BotDefense.should_bypass_army_danger_due_to_last_move_turn = function (bot, tile) {
    var map = _map(bot);
    var army = _army(bot, tile);
    if (!army) return false;

    var shouldBypass = army.last_seen_turn < map.turn - 6 && !army.tile.visible;
    shouldBypass = shouldBypass || (army.tile.isCity && army.last_moved_turn < map.turn - 3);
    shouldBypass = shouldBypass || army.last_moved_turn < map.turn - 2;
    return shouldBypass;
  };

  /*
   * 将军附近堆了太多敌方格子：不再扩张，整个回合拿去清场。
   * 阈值 1.3 是「每跳 1.3 个敌方格」的意思，距离越远要求越松（分母变大）。
   */
  BotDefense.should_force_gather_to_enemy_tiles = function (bot) {
    var forceGatherToEnemy = false;
    var scaryDistance = 3;
    var sp = _alias(bot, ['shortest_path_to_target_player', 'shortestPathToTargetPlayer']);
    if (sp) scaryDistance = Math.floor(sp.length / 3) + 2;

    var thresh = 1.3;
    var numEnemyTerritoryNearGen = _countEnemyTerritoryNearTile(bot, bot.general, scaryDistance);
    var enemyTileNearGenRatio = numEnemyTerritoryNearGen / Math.max(1.0, scaryDistance);
    if (enemyTileNearGenRatio > thresh) forceGatherToEnemy = true;

    return forceGatherToEnemy;
  };

  /*
   * 被贴脸的危险格：用一次反向搜索找「刚好够杀掉它」的最小兵力，杀得掉就杀。
   * 只有落点是危险格本身、且这一步不会重复出招时才认。
   */
  BotDefense.check_for_danger_tile_moves = function (bot) {
    var map = _map(bot);
    var dangerTiles = BotDefense.get_danger_tiles(bot);
    if (dangerTiles.size === 0) return null;
    if (bot.all_in_losing_counter > 15) return null;

    var myPlayer = _player(bot.general);
    var negTiles = [];
    var curPath = _alias(bot, ['curPath', 'cur_path']);
    if (curPath) negTiles = Array.from(curPath.tileSet);

    var tilesArr = Array.from(dangerTiles);
    for (var i = 0; i < tilesArr.length; i++) {
      var tile = tilesArr[i];
      var armyToSearch = EK.BotStateQueries.get_target_army_inc_adjacent_enemy(bot, tile) - 2;
      if (tile.army < 5) armyToSearch = Math.max(armyToSearch, 1);

      var killPath = EK.search.dest_breadth_first_target(map, [tile], {
        targetArmy: armyToSearch,
        maxDepth: 3,
        negativeTiles: negTiles,
        searchingPlayer: myPlayer,
        dontEvacCities: false
      });
      if (!killPath) continue;

      var move = EK.BotPathingUtils.get_first_path_move(bot, killPath);
      if (!EK.BotPathingUtils.is_move_safe_valid(bot, move)) continue;

      if (_hasRepetition(bot, move, 4, 2)) return null;

      var targeting = _army(bot, tile);
      if (targeting) bot.targetingArmy = targeting;
      return move;
    }

    return null;
  };

  /*
   * 「潜在威胁」（还没看见但推测得出来）沿着它的路径上，哪些我方格子现在不该把兵挪走 ——
   * 挪走了就等于把补给线让给敌人。将军格和扩张计划里点名的格子额外记日志。
   */
  BotDefense.get_potential_threat_movement_negatives = function (bot, targetTile) {
    var map = _map(bot);
    var potThreat = bot.dangerAnalyzer ? bot.dangerAnalyzer.fastestPotentialThreat : null;
    var potNegs = new Set();
    if (!potThreat) return potNegs;

    if (targetTile && potThreat.armyAnalysis.shortestPathWay.tiles.has(targetTile)) return potNegs;

    if (bot.armyTracker) {
      var threatArmy = bot.armyTracker.armies.get(potThreat.path.start.tile);
      if (threatArmy && !threatArmy.tile.visible) {
        if (potThreat.turns < 7 && !_alias(bot, ['targetingArmy'])) {
          bot.targetingArmy = threatArmy;
        } else if (threatArmy.last_seen_turn < map.turn - 4 && threatArmy.last_moved_turn < map.turn - 1) {
          return potNegs;
        }
      }
    }

    var shortestSet = new Set();
    if (targetTile) {
      var targetAnalysis = new EK.ArmyAnalyzer(map, bot.general, targetTile);
      shortestSet = targetAnalysis.shortestPathWay.tiles;
    }

    var plan = _expansionPlan(bot);
    var preferred = plan.preferred_tiles || new Set();
    var tileList = potThreat.path.tileList;
    for (var i = 0; i < tileList.length; i++) {
      var tile = tileList[i];
      if (!_isFriendlyTile(bot, tile)) continue;
      if (!(potThreat.threatValue + tile.army > potThreat.turns)) continue;
      if (shortestSet.has(tile)) continue;
      if (tile === bot.general || preferred.has(tile)) {
        // 原版只在这里打日志，不影响返回值。
      }
      potNegs.add(tile);
    }

    return potNegs;
  };

  /*
   * 防守主判断（拦截版）：先用拦截方案，没有方案就退到「只救将军」的单人方案。
   * 返回 (move, path, option, isDelayed)。move 为 null 表示这条路不给我方出招。
   */
  BotDefense.check_defense_intercept_move = function (bot, threat) {
    var map = _map(bot);
    var threatTile = threat.path.start.tile;
    var plans = _alias(bot, ['intercept_plans', 'interceptPlans']);
    var plan = plans ? plans.get(threatTile) : null;
    var isDelayed = false;

    var threatArmy = _army(bot, threatTile);
    var isNonAggressor = _aggression(bot, threat.threatPlayer) < 50 && !threatTile.visible;
    var tileNotAttacking =
      threatArmy && (threatArmy.last_moved_turn < map.turn - 2 || threatArmy.last_seen_turn < map.turn - 2);
    if (
      threat.threatPlayer !== bot.targetPlayer &&
      !map.is_2v2 &&
      (isNonAggressor || tileNotAttacking || (threatArmy && threatArmy.last_seen_turn < map.turn - 6))
    ) {
      return [null, null, null, false];
    }

    if (!plan || plan.intercept_options.size === 0) {
      return BotDefense.check_kill_threat_only_defense_interception(bot, threat);
    }

    var pair = BotDefense.get_defense_path_option_from_options_if_available(bot, plan, threat);
    var interceptPath = pair[0];
    var interceptingOption = pair[1];
    if (!interceptPath) {
      return BotDefense.check_kill_threat_only_defense_interception(bot, threat);
    }

    var tookTooLong = interceptPath.length > threat.turns;
    var armyLeftOver = false;
    var abandoningContestedCity = false;

    if (interceptingOption) {
      var cities = bot.cityAnalyzer ? bot.cityAnalyzer.owned_contested_cities : null;
      // owned_contested_cities 在不同模块里既可能是数组也可能是 Set，两种都得认。
      abandoningContestedCity = !!(cities && (typeof cities.has === 'function'
        ? cities.has(interceptPath.start.tile)
        : cities.indexOf(interceptPath.start.tile) >= 0));
      isDelayed = interceptingOption.requiredDelay > 0;
      armyLeftOver = threat.threatValue - interceptingOption.friendly_army_reaching_intercept > 0;

      if (threat.path.tail.tile.isGeneral) {
        if (tookTooLong || armyLeftOver) {
          var anyNonGeneral = false;
          for (var i = 0; i < plan.threats.length; i++) {
            if (!plan.threats[i].path.tail.tile.isGeneral) {
              anyNonGeneral = true;
              break;
            }
          }
          if (anyNonGeneral) return BotDefense.check_kill_threat_only_defense_interception(bot, threat);
          return [null, null, null, false];
        }
      } else if (abandoningContestedCity) {
        return [null, null, null, false];
      }
    }

    var mv = EK.BotPathingUtils.get_first_path_move(bot, interceptPath);
    if (_hasRepetition(bot, mv, 6, 3)) {
      mv = null;
    } else if (_hasRepetition(bot, mv, 4, 2)) {
      // 重复但没那么严重：把路径前 3 格砍掉，让它换个入口。
      bot.curPath = interceptPath.get_subsegment(3);
    }

    if (!mv) return [null, null, null, false];

    var mvNext = mv.dest;
    var threatNext = threat.path.start.next ? threat.path.start.next.tile : null;
    if (threatNext && threat.threatType === EK.ThreatType.Kill) {
      var boardAnalysis = _alias(bot, ['board_analysis', 'boardAnalysis']);
      var intergen = boardAnalysis ? boardAnalysis.intergeneral_analysis : null;
      var isMissing = false;
      if (intergen) {
        var mvDist = _mat(intergen.aMap, mvNext);
        var thDist = _mat(intergen.aMap, threatNext);
        isMissing = mvDist !== null && thDist !== null && mvDist > thDist;
      }
      if (isMissing) isMissing = threatNext.movable.indexOf(mvNext) < 0;
      if (isMissing) return [null, null, null, false];
    }

    return [mv, interceptPath, interceptingOption, isDelayed];
  };

  /*
   * 从「往威胁旁边凑」改成「直接贴上去」。凑的路上如果离开了威胁格的四邻，就等于白走一趟。
   */
  BotDefense.replace_bad_gather_defense_move_with_direct_threat_move = function (bot, threat, move) {
    if (!move) return null;
    var threatTile = threat.path.start.tile;
    if (threatTile.movable.indexOf(move.source) >= 0 && move.dest !== threatTile) {
      return new EK.Move(move.source, threatTile, move.move_half);
    }
    return move;
  };

  /*
   * 往下层搜索用的排序键（对象比较用）。
   * 顺序 = 优先级从高到低：(不是憋着不动的城, 下一回合就能撞上, 在最短路径上, 离威胁近, 兵多, 浅)
   */
  BotDefense.get_defense_tree_move_prio_func = function (bot, threat, anyLeafIsSameDistAsThreat) {
    var aa = threat.armyAnalysis;
    var threatenedTileDistMapRaw = aa.aMap.raw;
    var threatDistMapRaw = aa.bMap.raw;
    var startTile = threat.path.start.tile;
    var threatDist = threatenedTileDistMapRaw[_idx(startTile)];
    var shortestTiles = aa.shortestPathWay.tiles;

    return function (curTile, currentPriorityObject) {
      var toTile = null;
      var lastIsInterceptingIn1 = false;
      var rootDistToThreat = threatDistMapRaw[_idx(curTile)];
      var depth = 0;
      if (currentPriorityObject) {
        lastIsInterceptingIn1 = currentPriorityObject[1];
        depth = currentPriorityObject[6];
        rootDistToThreat = currentPriorityObject[7];
        toTile = currentPriorityObject[8];
      }

      var isMovable = startTile.movable.indexOf(curTile) >= 0;
      var isMovableToThreatButNotIntercepting =
        toTile !== startTile && isMovable && threatenedTileDistMapRaw[_idx(curTile)] < threatDist;

      var closenessToThreat = threatenedTileDistMapRaw[_idx(curTile)];
      var inShortest = shortestTiles.has(curTile);
      if (threatDist > closenessToThreat && inShortest) closenessToThreat = 0 - closenessToThreat;

      var isInterceptingIn1 =
        threatDistMapRaw[_idx(curTile)] === 2 && toTile !== null && threatDistMapRaw[_idx(toTile)] === 1;

      if (isMovableToThreatButNotIntercepting) closenessToThreat += 20;
      else if (isMovable) closenessToThreat = 0;

      var isntDelayableCity = !!anyLeafIsSameDistAsThreat || !curTile.isCity;

      return [
        isntDelayableCity,
        isInterceptingIn1 || lastIsInterceptingIn1,
        !inShortest,
        0 - rootDistToThreat + depth,
        0 - closenessToThreat,
        curTile.army,
        depth + 1,
        rootDistToThreat,
        curTile
      ];
    };
  };

  // 旧版（只差在没缓存 .raw，语义相同），保留是因为原版还在别处引用它做对照。
  BotDefense.get_defense_tree_move_prio_func_old = function (bot, threat, anyLeafIsSameDistAsThreat) {
    return BotDefense.get_defense_tree_move_prio_func(bot, threat, anyLeafIsSameDistAsThreat);
  };

  /*
   * 将军周围一圈里，敌人几回合内能杀进来的路径。
   * 先正向找（谁能在 1 回合内吃掉将军的四邻），再补一条逐格检查的兜底：
   * 如果某个邻居本身就是「够杀将军的敌兵堆」，那不用搜索也知道危险。
   */
  BotDefense.get_danger_paths = function (bot, moveHalf) {
    var map = _map(bot);
    var thresh = 3;
    if (moveHalf) thresh = bot.general.army - Math.floor(bot.general.army / 2) + 2;

    var dangerPaths = [];
    if (bot.targetPlayer !== -1) {
      var dangerPath = EK.search.dest_breadth_first_target(map, bot.general.movable, {
        targetArmy: thresh,
        maxDepth: 1,
        searchingPlayer: bot.targetPlayer,
        ignoreGoalArmy: false
      });
      if (dangerPath) {
        dangerPaths.push(dangerPath);
        var altSet = new Set(dangerPath.tileSet);

        var altPath = EK.search.dest_breadth_first_target(map, bot.general.movable, {
          targetArmy: thresh,
          maxDepth: 1,
          negativeTiles: altSet,
          searchingPlayer: bot.targetPlayer,
          ignoreGoalArmy: false
        });
        if (altPath) {
          dangerPaths.push(altPath);
          altSet.delete(altPath.start.tile);
        }
        altSet.delete(dangerPath.start.tile);

        altPath = EK.search.dest_breadth_first_target(map, bot.general.movable, {
          targetArmy: thresh,
          maxDepth: 1,
          negativeTiles: altSet,
          searchingPlayer: bot.targetPlayer,
          ignoreGoalArmy: false
        });
        if (altPath && String(altPath) !== String(dangerPath)) dangerPaths.push(altPath);
      }
    }

    var movs = bot.general.movable;
    for (var i = 0; i < movs.length; i++) {
      var mv = movs[i];
      if (map.is_tile_enemy(mv) && mv.army >= thresh) {
        var p = new EK.Path(0);
        p.add_next(mv);
        p.add_next(bot.general);
        dangerPaths.push(p);
      }
    }

    return dangerPaths;
  };

  /*
   * 危险路径上「现在就在敌人手里、且有兵」的格子。这些格子是我方下一步不该踩的。
   */
  BotDefense.get_danger_tiles = function (bot, moveHalf) {
    var map = _map(bot);
    var dangerPaths = BotDefense.get_danger_paths(bot, moveHalf);
    var dangerTiles = new Set();
    for (var i = 0; i < dangerPaths.length; i++) {
      var list = dangerPaths[i].tileList;
      for (var j = 0; j < list.length; j++) {
        if (map.is_tile_enemy(list[j]) && list[j].army > 2) dangerTiles.add(list[j]);
      }
    }
    return dangerTiles;
  };

  /*
   * 将军还能往哪走。危险格本身、以及「挡住了将军退路」的危险格，都不算禁走；
   * 剩下的都是「踩上去等于自投罗网」的格子。
   */
  BotDefense.get_general_move_blocking_tiles = function (bot, target, moveHalf) {
    var map = _map(bot);
    var blockingTiles = [];
    var dangerPaths = BotDefense.get_danger_paths(bot, moveHalf);

    for (var i = 0; i < dangerPaths.length; i++) {
      var dangerTile = dangerPaths[i].start.tile;
      var genDist = _euclid(map, dangerTile.x, dangerTile.y, bot.general.x, bot.general.y);
      var dangerTileIsTarget = target && target.x === dangerTile.x && target.y === dangerTile.y;
      if (dangerTileIsTarget) continue;

      var forwardMoves = [];
      for (var m = 0; m < dangerTile.movable.length; m++) {
        var t = dangerTile.movable[m];
        if (_genDist(bot, dangerTile) > _genDist(bot, t)) forwardMoves.push(t);
      }

      var dangerTileCanOnlyMoveToIntercept =
        forwardMoves.length === 1 && genDist > _euclid(map, dangerTile.x, dangerTile.y, target.x, target.y);

      var targetBlocksDangerTile =
        (bot.general.x === target.x && bot.general.x === dangerTile.x) ||
        (bot.general.y === target.y && bot.general.y === dangerTile.y) ||
        dangerTileCanOnlyMoveToIntercept;

      if (targetBlocksDangerTile) continue;

      blockingTiles.push(dangerTile);
    }

    return blockingTiles;
  };

  BotDefense.general_move_safe = function (bot, target, moveHalf) {
    return BotDefense.get_general_move_blocking_tiles(bot, target, moveHalf).length === 0;
  };

  /*
   * 迷雾风险：敌人这个回合周期还能攒出多少「看不见的兵」，比我方防守树上的兵力多，就认高风险。
   * 原版在这里还有一段「因为不知道敌将位置所以不防守」的分支，被注释掉了 —— 保持不生效。
   */
  BotDefense.check_fog_risk = function (bot) {
    bot.high_fog_risk = false;
    if (bot.targetPlayer === -1) return;

    var cycleTurnsLeft = _turnsLeftInCycle(bot);
    var tree = _alias(bot, ['defensive_spanning_tree', 'defensiveSpanningTree']) || [];
    var defenseWorth = EK.BotStateQueries.get_player_army_amount_on_tiles(bot, tree, _player(bot.general));
    var pushRiskTurns = Math.max(1, cycleTurnsLeft - tree.length);
    bot.fog_risk_amount = 0;

    var ot = _alias(bot, ['opponent_tracker', 'opponentTracker']);
    var oppStats = ot.get_current_cycle_stats_by_player(bot.targetPlayer);
    if (oppStats) {
      var fogRisk = ot.get_approximate_fog_army_risk(bot.targetPlayer, null, pushRiskTurns);
      bot.fog_risk_amount = fogRisk;
    }

    if (bot.fog_risk_amount > 0) {
      var gathPath = _alias(bot, ['target_player_gather_path', 'targetPlayerGatherPath']);
      var gathLen = gathPath ? gathPath.length : 0;
      if (cycleTurnsLeft > gathLen + 5 && bot.fog_risk_amount > defenseWorth && _map(bot).turn > 80) {
        bot.high_fog_risk = true;
        return;
      }
    }
  };

  /*
   * 迷雾风险差额：敌人还能攒出的兵 - 我方在集火路径上已有的兵。
   * 原版把 pushRiskTurns 硬置成 0（那一行之后又赋值 0），所以这里等价成「当下这一刻的差额」。
   */
  BotDefense.get_approximate_fog_risk_deficit = function (bot) {
    var gathPath = _alias(bot, ['target_player_gather_path', 'targetPlayerGatherPath']);
    if (!gathPath) return 0;

    var pathWorth = EK.BotStateQueries.get_player_army_amount_on_path(bot, gathPath, _player(bot.general));
    var pushRiskTurns = 0;

    if (bot.targetPlayer !== -1) {
      var ot = _alias(bot, ['opponent_tracker', 'opponentTracker']);
      var fogRisk = ot.get_approximate_fog_army_risk(bot.targetPlayer, null, pushRiskTurns);
      return fogRisk - pathWorth - Math.floor(pushRiskTurns / 2);
    }

    return 0;
  };

  /*
   * 两人局且经济落后到阈值以下时，放弃守将军（守也守不住，不如去换）。
   */
  BotDefense.should_abandon_king_defense = function (bot) {
    var map = _map(bot);
    var ot = _alias(bot, ['opponent_tracker', 'opponentTracker']);
    var threshold = bot.behavior_losing_on_economy_skip_defense_threshold;
    if (typeof threshold !== 'number') threshold = 0.9;
    return map.remainingPlayers === 2 && !ot.winning_on_economy(threshold);
  };

  /*
   * 「这一回合该不该把资源拿去守经济」的主力判断：看双方每周期攒兵效率（cycleDifferential）、
   * 迷雾风险（oppArmy）、我方已经摆好的兵（playerArmy）。
   * 原版还叠了 likely_kill_push 与「不能白守」的一串特例，这里全部保留。
   */
  BotDefense.check_should_defend_economy_based_on_cycle_behavior = function (bot, defenseCriticalTileSet) {
    var map = _map(bot);
    bot.likely_kill_push = false;

    if (_isFfa(bot)) return false;

    var sp = _alias(bot, ['shortest_path_to_target_player', 'shortestPathToTargetPlayer']);
    if (!sp) return false;

    var halfDist = sp.length - Math.floor(sp.length / 2);

    var ot = _alias(bot, ['opponent_tracker', 'opponentTracker']);
    var oppArmy = ot.get_approximate_fog_army_risk(bot.targetPlayer, null, 0);
    var enGathered = 0;
    var enData = ot.get_current_cycle_stats_by_player(bot.targetPlayer);
    if (enData) enGathered = enData.approximate_army_gathered_this_cycle || 0;
    if (oppArmy < enGathered) return false;

    var threatPath = _alias(bot, ['target_player_gather_path', 'targetPlayerGatherPath']);
    var enemyAttackPath = _alias(bot, ['enemy_attack_path', 'enemyAttackPath']);

    if (enemyAttackPath) {
      var enPath = enemyAttackPath.get_subsegment(halfDist + 2, true);
      threatPath = enemyAttackPath;

      var enemyAttackPathVal = 0;
      var enemyAttackPathEnOrFogTiles = 0;
      var enList = enPath.tileList;
      for (var i = 0; i < enList.length; i++) {
        var t = enList[i];
        var onTeam = map.is_tile_on_team_with(t, bot.targetPlayer);
        if (onTeam && t.visible) enemyAttackPathVal += t.army - 1;
        if ((onTeam || !t.visible) && t.army > 2) enemyAttackPathEnOrFogTiles += 1.25;
        else if ((onTeam || !t.visible) && t.army === 2) enemyAttackPathEnOrFogTiles += 0.95;
        else if ((onTeam || !t.visible) && t.army <= 1) enemyAttackPathEnOrFogTiles += 0.55;
      }

      if (enemyAttackPathVal > 5) oppArmy += enemyAttackPathVal;

      if (enemyAttackPathEnOrFogTiles > Math.floor(halfDist / 2)) {
        bot.likely_kill_push = true;
      }
    }

    var boardAnalysis = _alias(bot, ['board_analysis', 'boardAnalysis']);
    var sketchDist = boardAnalysis ? boardAnalysis.within_flank_danger_play_area_threshold : halfDist;
    if (typeof sketchDist !== 'number') sketchDist = halfDist;

    var myStats = ot.get_current_cycle_stats_by_player(_player(bot.general));
    var allowDefendKillPushWhileBehind =
      bot.likely_kill_push &&
      myStats &&
      (myStats.moves_spent_gathering_visible_tiles || 0) < 25 &&
      map.remainingCycleTurns > 10;

    if (!ot.winning_on_economy(1.01, undefined, undefined, 0 - sp.length)) {
      if (!allowDefendKillPushWhileBehind) {
        if (bot.likely_kill_push) bot.likely_kill_push = false;
        return false;
      }
    }

    if (_turnsLeftInCycle(bot) <= Math.max(halfDist, sketchDist)) {
      if (bot.likely_kill_push) bot.likely_kill_push = false;
      return false;
    }

    var cycleDifferential = ot.check_gather_move_differential(_player(bot.general), bot.targetPlayer);

    var playerArmy = 8;
    var armies = bot.armyTracker ? bot.armyTracker.armies : null;
    if (armies) {
      var arr = typeof armies.values === 'function' ? Array.from(armies.values()) : Array.from(armies);
      for (var a = 0; a < arr.length; a++) {
        var army = arr[a];
        var armyTile = army.tile || army;
        if (armyTile === undefined) continue;
        if (_player(armyTile) === _player(bot.general) && armyTile.army > playerArmy) {
          playerArmy = armyTile.army - 1;
        }
      }
    }

    var gathPathSum = 0;
    if (threatPath) {
      var tpList = threatPath.tileList;
      for (var g = 0; g < tpList.length; g++) {
        if (_isFriendlyTile(bot, tpList[g])) gathPathSum += tpList[g].army - 1;
      }
    }
    playerArmy = Math.max(playerArmy, gathPathSum);

    var timings = _timings(bot);
    var inExpandSplit = timings && typeof timings.in_expand_split === 'function' ? timings.in_expand_split(map.turn) : false;
    var defendEconomy = _alias(bot, ['defend_economy', 'defendEconomy']);

    if (oppArmy - gathPathSum > 0 && !inExpandSplit && threatPath === enemyAttackPath && !defendEconomy) {
      var negList = threatPath.tileList;
      for (var n = 0; n < negList.length; n++) {
        if (_isFriendlyTile(bot, negList[n])) defenseCriticalTileSet.add(negList[n]);
      }
    }

    if (oppArmy - halfDist <= playerArmy) {
      if (bot.likely_kill_push) bot.likely_kill_push = false;
      return false;
    }

    if (cycleDifferential < -halfDist && oppArmy >= playerArmy) {
      bot.defend_economy = true;
      return true;
    }

    var turnsRemaining = _turnsLeftInCycle(bot);
    var minimallyWinningOnEcon = ot.winning_on_economy(1.02, undefined, undefined, 0 - Math.floor(sp.length / 2));
    if (!minimallyWinningOnEcon && oppArmy - threatPath.length < playerArmy * 1.25 && turnsRemaining < 13) {
      return !!defendEconomy;
    }

    if (oppArmy >= (playerArmy + 10) * 1.1 && cycleDifferential < 5 && minimallyWinningOnEcon) {
      return true;
    }

    return !!defendEconomy;
  };

  /*
   * 经济防守总开关。两人局 + 对手不是 AFK + 周期行为判定成立，才开。
   * 原版还会先跑 check_should_defend_economy_based_on_large_tiles（依赖大格统计，见文件头第 4 条）。
   */
  BotDefense.should_defend_economy = function (bot, defenseTiles) {
    var map = _map(bot);
    if (map.remainingPlayers > 2) return false;
    if (bot.targetPlayer === -1) return false;

    var alreadyDefEconomy = !!_alias(bot, ['defend_economy', 'defendEconomy']);

    var targetPlayerObj = map.players[bot.targetPlayer];
    if (targetPlayerObj && targetPlayerObj.last_seen_move_turn < map.turn - 100) return false;

    if (BotDefense.check_should_defend_economy_based_on_cycle_behavior(bot, defenseTiles)) {
      bot.defend_economy = true;
      return true;
    }

    return alreadyDefEconomy;
  };

  /*
   * 「一击杀掉威胁源」的机会判断。
   * 注意原版的后半段（savePath 搜索）算完参数后从未被使用 —— 唯一会用到的 saveTile
   * 只在前一个分支里赋值。所以这里只保留前半段，语义与原版实际行为一致。
   */
  BotDefense.get_threat_killer_move = function (bot, threat, searchTurns, negativeTiles) {
    var map = _map(bot);
    var killTiles = [threat.path.start.tile];
    if (threat.path.start.next) killTiles.unshift(threat.path.start.next.tile);

    var threatTile = threat.path.start.tile;
    var sp = _alias(bot, ['shortest_path_to_target_player', 'shortestPathToTargetPlayer']);
    var boardAnalysis = _alias(bot, ['board_analysis', 'boardAnalysis']);
    if (sp && boardAnalysis && boardAnalysis.intergeneral_analysis) {
      var bDist = _mat(boardAnalysis.intergeneral_analysis.bMap, threatTile);
      if (threat.turns > Math.floor(sp.length / 2) && bDist !== null && threat.turns > Math.floor(sp.length / 2)) {
        return null;
      }
    }

    var largestTile = null;
    var source = null;
    for (var k = 0; k < killTiles.length; k++) {
      var threatSource = killTiles[k];
      for (var m = 0; m < threatSource.movable.length; m++) {
        var tile = threatSource.movable[m];
        if (_player(tile) !== map.player_index) continue;
        if (threat.path.tileSet.has(tile)) continue;
        var blocking = bot.expansion_plan ? bot.expansion_plan.blocking_tiles : null;
        if (blocking && (typeof blocking.has === 'function' ? blocking.has(tile) : false)) continue;
        if (tile.army > 1 && (largestTile === null || tile.army > largestTile.army)) {
          largestTile = tile;
          source = threatSource;
        }
      }
    }

    var threatModifier = 3;
    var history = _alias(bot, ['history']);
    var attempted = history ? history.attempted_threat_kills : null;
    if (attempted) {
      var hasPrev = typeof attempted.has === 'function' ? attempted.has(map.turn - 1) : false;
      if (hasPrev) threatModifier = 1;
    }

    if (largestTile === null) return null;
    if (threat.threatValue - largestTile.army + threatModifier >= 0) return null;

    if (attempted && typeof attempted.add === 'function') attempted.add(map.turn);
    return new EK.Move(largestTile, source);
  };

  /*
   * 刷新威胁分析。depth 用「到推测敌将位置的距离」兜底 9：太浅会漏掉长威胁，
   * 太深在这个引擎里纯属浪费（多出一个数量级的搜索）。
   */
  BotDefense.calculate_general_danger = function (bot) {
    var map = _map(bot);
    var expectedGen = _alias(bot, ['targetPlayerExpectedGeneralLocation', 'target_player_expected_general_location']);
    var depth = expectedGen ? _genDist(bot, expectedGen) : 9;
    if (depth < 9) depth = 9;

    var cities = [];
    var myTeam = map.team_ids_by_player_index[_player(bot.general)];
    for (var i = 0; i < map.players.length; i++) {
      var p = map.players[i];
      if (map.team_ids_by_player_index[p.index] === myTeam && !p.dead) cities = cities.concat(p.cities || []);
    }

    var da = bot.dangerAnalyzer;
    da.analyze(cities, depth, bot.armyTracker ? bot.armyTracker.armies : null);
    return da;
  };

  /*
   * 拦截方案表：对「每个可能发起威胁的敌方格」算一份 turns->option。
   * 顺序很关键 —— 先按 (是否有 Kill 类, 最近见过, 最近动过, 兵多) 降序排，
   * 因为 limit=4 意味着排在后面的威胁根本不会算，谁排前面谁就吃掉全部预算。
   */
  BotDefense.build_intercept_plans = function (bot, negTiles) {
    if (negTiles === undefined) negTiles = null;
    var map = _map(bot);
    var interceptions = new Map();
    bot.blocking_tile_info = new Map();
    var interceptor = _interceptor(bot);
    if (!interceptor || !bot.dangerAnalyzer) return interceptions;

    var threatsByTile = bot.dangerAnalyzer.get_threats_grouped_by_tile(
      bot.armyTracker ? bot.armyTracker.armies : null,
      true,
      false,
      _alias(bot, ['targetingArmy']),
      true,
      true
    );

    var tuples = Array.from(threatsByTile.entries());
    tuples.sort(function (a, b) {
      var aKill = 0;
      for (var i = 0; i < a[1].length; i++) {
        if (a[1][i].threatType === EK.ThreatType.Kill) {
          aKill = 1;
          break;
        }
      }
      var bKill = 0;
      for (var j = 0; j < b[1].length; j++) {
        if (b[1][j].threatType === EK.ThreatType.Kill) {
          bKill = 1;
          break;
        }
      }
      if (aKill !== bKill) return bKill - aKill;

      var aArmy = _army(bot, a[0]);
      var bArmy = _army(bot, b[0]);
      var aSeen = a[0].visible ? 100000 : aArmy ? aArmy.last_seen_turn : 0;
      var bSeen = b[0].visible ? 100000 : bArmy ? bArmy.last_seen_turn : 0;
      if (aSeen !== bSeen) return bSeen - aSeen;

      var aMoved = aArmy ? aArmy.last_moved_turn : 0;
      var bMoved = bArmy ? bArmy.last_moved_turn : 0;
      if (aMoved !== bMoved) return bMoved - aMoved;

      return b[0].army - a[0].army;
    });

    var threatsWeCareAbout = [];
    var threatsWeCareAboutByTile = new Map();
    bot.threats_we_care_about_by_tile = threatsWeCareAboutByTile;

    var limit = 4;
    var isFfa = _isFfa(bot);
    var gathPath = _alias(bot, ['target_player_gather_path', 'targetPlayerGatherPath']);
    var gathLen = gathPath ? gathPath.length : 0;
    var boardAnalysis = _alias(bot, ['board_analysis', 'boardAnalysis']);

    for (var ti = 0; ti < tuples.length; ti++) {
      var tile = tuples[ti][0];
      var threats = tuples[ti][1];
      if (!threats || threats.length === 0) continue;

      var threatArmy = _army(bot, tile);
      var threatPlayer = threats[0].threatPlayer;

      if (isFfa && _aggression(bot, threatPlayer) < 200 && threatPlayer !== bot.targetPlayer && !tile.visible) continue;
      if (isFfa && _aggression(bot, threatPlayer) < 50 && !tile.visible) continue;

      var isCloseThreat = false;
      if (gathPath && boardAnalysis && boardAnalysis.intergeneral_analysis) {
        var aDist = _mat(boardAnalysis.intergeneral_analysis.aMap, tile);
        isCloseThreat =
          threats[0].turns <= gathLen / 4 && aDist !== null && aDist < gathLen / 2;
      }

      if (isFfa && threatArmy && threatArmy.last_seen_turn < map.turn - 4 && !isCloseThreat) continue;
      if (threatArmy && map.turn - threatArmy.last_seen_turn > Math.max(1.0, gathLen / 5) && !isCloseThreat) continue;

      if (
        !map.is_player_on_team_with(threatPlayer, bot.targetPlayer) &&
        bot.targetPlayer !== -1 &&
        !_inFriendlyTerritory(bot, tile)
      ) {
        continue;
      }

      if (threatsWeCareAbout.length >= limit) continue;

      var threatsIncluded = [];
      var num = 0;
      for (var thi = 0; thi < threats.length; thi++) {
        var threat = threats[thi];
        if (threat.turns > 40) continue;
        threatsIncluded.push(threat);
        if (interceptor.ensure_threat_army_analysis(threat)) num += 1;
      }
      if (num > 0) {
        threatsWeCareAbout.push([tile, threatsIncluded]);
        threatsWeCareAboutByTile.set(tile, threatsIncluded);
      }
    }

    for (var wi = 0; wi < threatsWeCareAbout.length; wi++) {
      var wtile = threatsWeCareAbout[wi][0];
      var wthreats = threatsWeCareAbout[wi][1];
      if (!wthreats || wthreats.length === 0) continue;

      if (
        !map.is_player_on_team_with(wthreats[0].threatPlayer, bot.targetPlayer) &&
        bot.targetPlayer !== -1 &&
        !_inFriendlyTerritory(bot, wtile)
      ) {
        continue;
      }

      var isDeathThreat = false;
      var blockingTiles = interceptor.get_intercept_blocking_tiles_for_split_hinting(
        wtile,
        threatsWeCareAboutByTile,
        negTiles
      );

      for (var di = 0; di < wthreats.length; di++) {
        var dt = wthreats[di];
        if (dt.threatType === EK.ThreatType.Kill && dt.path.tail.tile.isGeneral && dt.threatValue > 0) {
          isDeathThreat = true;
          bot.blocking_tile_info = blockingTiles;
          break;
        }
      }

      var blocks = blockingTiles;
      if (!blocks) blocks = bot.blocking_tile_info;
      else if (blocks !== bot.blocking_tile_info) {
        var prevEntries = Array.from(bot.blocking_tile_info.entries());
        for (var ki = 0; ki < prevEntries.length; ki++) {
          var prevTile = prevEntries[ki][0];
          var prevInfo = prevEntries[ki][1];
          var existing = blocks.get(prevTile);
          if (!existing) blocks.set(prevTile, prevInfo);
          else {
            for (var bd = 0; bd < prevInfo.blocked_destinations.length; bd++) {
              existing.add_blocked_destination(prevInfo.blocked_destinations[bd]);
            }
          }
        }
      }

      if (!isDeathThreat) {
        if (!blocks) blocks = new Map();        var cities = bot.cityAnalyzer ? bot.cityAnalyzer.owned_contested_cities : null;
        if (cities) {
          for (var ci = 0; ci < cities.length; ci++) {
            var c = cities[ci];
            if (blocks.has(c)) continue;
            // 被争的城必须守满：原版在这里也没给「留一半」的余地（注释里自问过）。
            var blockInfo = new EK.ThreatBlockInfo(c, c.army);
            for (var mi = 0; mi < c.movable.length; mi++) blockInfo.add_blocked_destination(c.movable[mi]);
            blocks.set(c, blockInfo);
          }
        }
      }

      if (BotDefense.should_bypass_army_danger_due_to_last_move_turn(bot, wtile)) continue;

      var plan = interceptor.get_interception_plan(
        wthreats,
        _turnsLeftInCycle(bot),
        blocks,
        _alias(bot, ['opponent_tracker', 'opponentTracker']),
        bot.win_condition_analyzer ? bot.win_condition_analyzer.contestable_cities : null
      );
      if (plan !== null && plan !== undefined) interceptions.set(wtile, plan);
    }

    return interceptions;
  };

  // ===========================================================================
  // 补全：BotDefense.py 76-2661 里之前「依赖缺失」而跳过的部分。
  // gather / gatherops / board(flank 矩阵) / interceptor 现在都到位了，
  // 所以按原文逐函数搬运，不再走近似。
  //
  // 内存：不往 bot 上挂任何会累积的东西 —— per-turn 的矩阵和 Set 都是局部变量，
  // 随栈丢弃；跨回合只写原版自己就有的字段（gatherNodes / redGatherTreeNodes /
  // best_defense_leaves），且每个回合开头都会被覆盖。
  // ===========================================================================

  // Models/GatherTreeNode.get_tree_leaves_further_than_distance：
  // 挑出「已经走到威胁那一跳、并且还得靠它补兵」的叶子。原版的 distOffs 恒 0，
  // 直接内联掉。
  function _leavesFurtherThanDistance(gatherNodes, distMap, dist, minArmy, curArmy) {
    if (minArmy === undefined) minArmy = 1;
    if (curArmy === undefined) curArmy = 0;
    var out = [];
    if (!gatherNodes) return out;
    for (var i = 0; i < gatherNodes.length; i++) {
      var leaves = EK.GatherTreeNode.get_tree_leaves([gatherNodes[i]]);
      var near = [];
      for (var j = 0; j < leaves.length; j++) {
        var g = leaves[j];
        var d1 = _mat(distMap, g.tile);
        var d2 = g.toTile ? _mat(distMap, g.toTile) : null;
        if ((d1 !== null && d1 >= dist) || (d2 !== null && d2 >= dist)) near.push(g);
      }
      for (var k = 0; k < near.length; k++) {
        var contribution = near[k].tile.army - 1;
        if (curArmy - contribution <= minArmy) out.push(near[k]);
        else curArmy -= contribution;
      }
    }
    return out;
  }

  function _cloneNodes(nodes) {
    var out = [];
    if (!nodes) return out;
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i].deep_clone());
    return out;
  }

  function _gatherInvalidMove(searchingPlayer) {
    return function (node) {
      if (node.tile.army <= 1) return true;
      return node.tile.player() !== searchingPlayer;
    };
  }

  /*
   * GatherPrune.prune_mst_to_army_with_values。
   * gather.js 里的 prune_mst_to_army 只回根节点，这里要 (剩余回合, 剩余兵, 树)，
   * 所以直接调底层的 prune_mst_until 自己组。
   */
  function _pruneMstToArmyWithValues(rootNodes, army, searchingPlayer, preferPrune) {
    var untilFunc = function (node, prioObj, count, curValue) {
      return curValue - node.value < army;
    };
    var pruneOrderFunc = function (node) {
      var vpt = node.gatherTurns > 0 ? node.value / node.gatherTurns : 0;
      return [vpt, node.trunkDistance > 0 ? node.trunkValue / node.trunkDistance : 0, node.trunkDistance];
    };
    // 原版这里 pruneBranches=False：整枝剪会把「末端大格」一起剪掉，
    // 而这个函数的用途恰恰是留住末端大格。
    var res = EK.GatherPrune.prune_mst_until(rootNodes, untilFunc, pruneOrderFunc,
      _gatherInvalidMove(searchingPlayer), false, null, null, true, null, null,
      preferPrune || null, null, true, null, null);
    return [res[0], res[1], res[2]];
  }

  /*
   * GatherPrune.prune_mst_to_turns_with_values。
   * forcePrunePreferPrune=True 时原版宁可多留也不剪掉 preferPrune 里的格子，
   * 所以 untilFunc 要等 mustPrune 空了才允许停，并在每次剪枝回调里把该格剔掉。
   */
  function _pruneMstToTurnsWithValues(rootNodes, turns, searchingPlayer, preferPrune, forcePrunePreferPrune) {
    var invalidMoveFunc = function (node) {
      if (node.tile.army <= 1) return true;
      return node.tile.player() !== searchingPlayer && node.children.length === 0;
    };
    var pruneOrderFunc = function (node) {
      var raw = node.gatherTurns > 0 ? node.value / node.gatherTurns : (node.value > 0 ? 0 : -100);
      return [raw, node.value, 0 - node.trunkDistance];
    };
    var overpruneCutoff = turns;
    var pruneOverrideFunc = function (node, prioObj, turnsLeft) {
      return turnsLeft - node.gatherTurns < overpruneCutoff;
    };
    var untilFunc;
    var pruneCallbackFunc = null;
    var mustPrune = null;
    if (forcePrunePreferPrune) {
      mustPrune = new Set(preferPrune || []);
      untilFunc = function (node, prioObj, count) {
        return count <= turns && mustPrune.size === 0;
      };
      pruneCallbackFunc = function (node) {
        mustPrune.delete(node.tile);
      };
    } else {
      untilFunc = function (node, prioObj, count) {
        return count <= turns;
      };
    }
    var res = EK.GatherPrune.prune_mst_until(rootNodes, untilFunc, pruneOrderFunc, invalidMoveFunc,
      true, pruneOverrideFunc, null, true, null, null, preferPrune || null, null, true, null,
      pruneCallbackFunc);
    return [res[0], res[1], res[2]];
  }

  /*
   * GatherPrune.prune_mst_to_max_army_per_turn_with_values。
   * 唯一需要完整复刻的是「城市每两回合 +1 兵」那套增量会计：剪掉一格会让整棵树
   * 的回合数变短，城市就少产兵，所以直到剪完为止 cityCounter 都要跟着变。
   */
  function _pruneMstToMaxArmyPerTurnWithValues(rootNodes, minArmy, searchingPlayer, teams, preferPrune) {
    var GT = EK.GatherTreeNode;
    var totalTurns = 0;
    var totalValue = 0;
    for (var i = 0; i < rootNodes.length; i++) {
      totalTurns += rootNodes[i].gatherTurns;
      totalValue += rootNodes[i].value;
    }
    if (totalTurns === 0) return [0, 0, rootNodes];
    if (totalValue < minArmy) return [totalTurns, totalValue, rootNodes];

    var cityCounter = { value: 0 };
    var cityGatherDepthCounter = { value: 0 };
    GT.foreach_tree_node(rootNodes, function (node) {
      var t = node.tile;
      var mine = teams[_player(t)] === teams[searchingPlayer];
      if ((t.isCity || t.isGeneral) && mine) {
        cityCounter.value += 1;
        cityGatherDepthCounter.value += node.trunkDistance;
      } else if (t.isCity && !mine) {
        cityCounter.value -= 1;
      } else if (t.isSwamp && t.isNeutral === false) {
        cityGatherDepthCounter.value -= node.trunkDistance;
        cityCounter.value += 1;
      }
    });

    var curValuePerTurn = { value: totalValue / totalTurns };
    var minTurns = 0;
    var untilFunc = function (node, prioObj, turnsLeft, curValue) {
      var turnsLeftIfPruned = turnsLeft - node.gatherTurns;
      if (turnsLeftIfPruned <= minTurns) return true;
      var cityIncrementAmount = cityCounter.value * Math.floor((turnsLeftIfPruned - 1) / 2);
      cityIncrementAmount -= Math.floor(cityGatherDepthCounter.value / 2);
      var armyLeftIfPruned = curValue - node.value + cityIncrementAmount;
      var pruneValPerTurn = armyLeftIfPruned / turnsLeftIfPruned;
      if (pruneValPerTurn < curValuePerTurn.value || armyLeftIfPruned < minArmy) return true;

      if (teams[_player(node.tile)] === teams[searchingPlayer]) {
        if (node.tile.isCity || node.tile.isGeneral) {
          cityGatherDepthCounter.value -= node.trunkDistance;
          cityCounter.value -= 1;
        } else if (node.tile.isSwamp) {
          cityGatherDepthCounter.value -= node.trunkDistance;
          cityCounter.value += 1;
        }
      }
      curValuePerTurn.value = pruneValPerTurn;
      return false;
    };
    var pruneOrderFunc = function (node) {
      if (node.gatherTurns === 0 || node.trunkDistance === 0) return [-1, -1, -1];
      return [node.value / node.gatherTurns,
        node.trunkDistance > 0 ? node.trunkValue / node.trunkDistance : 0,
        node.trunkDistance];
    };
    var res = EK.GatherPrune.prune_mst_until(rootNodes, untilFunc, pruneOrderFunc,
      _gatherInvalidMove(searchingPlayer), true, null, null, true, null, null,
      preferPrune || null, null, true, null, null);
    return [res[0], res[1], res[2]];
  }

  function _is2v2TeammateAlive(bot) {
    var map = _map(bot);
    if (!map.is_2v2 || !map.teammates) return false;
    var alive = 0;
    map.teammates.forEach(function (p) {
      if (p === map.player_index) return;
      if (map.players[p] && !map.players[p].dead) alive += 1;
    });
    return alive > 0;
  }

  // 原版走 BotComms 通知队友；这边没有 comms 模块，只能记账不自作主张。
  function _communicateThreatToAlly(bot, threat) {
    if (bot.teammate_communicator && typeof bot.teammate_communicator.add_threat === 'function') {
      try { bot.teammate_communicator.add_threat(threat); } catch (e) { /* comms 只影响队友，失败不影响本地决策 */ }
    }
  }

  // BotCityCaptureControl.block_neutral_captures 的等价动作：不再吃中立城，
  // 并清掉当前的吃城计划（否则这回合还会照着旧 plan 走）。
  function _blockNeutralCaptures(bot) {
    bot.is_blocking_neutral_city_captures = true;
    bot.force_city_take = false;
  }

  function _moveTowardsEnemy(bot, move) {
    if (!move || !EK.BotPathingUtils || typeof EK.BotPathingUtils.is_move_towards_enemy !== 'function') return false;
    return !!EK.BotPathingUtils.is_move_towards_enemy(bot, move);
  }

  function _repetitionTile(bot, tile, turns, reps) {
    if (!tile || !bot.history || !EK.BotRepetition
      || typeof EK.BotRepetition.detect_repetition_tile !== 'function') return false;
    return !!EK.BotRepetition.detect_repetition_tile(bot, tile,
      turns === undefined ? 6 : turns, reps === undefined ? 2 : reps);
  }

  function _firstPathMove(bot, path) {
    if (!path) return null;
    if (EK.BotPathingUtils && typeof EK.BotPathingUtils.get_first_path_move === 'function') {
      return EK.BotPathingUtils.get_first_path_move(bot, path);
    }
    return path.get_first_move();
  }

  // search.js 各 dynamic_max 的返回值形状不统一（Map / 数组 / 单个 Path），
  // 这里统一挑出「以 startTile 为起点的那一条」。
  function _firstPathFromSearch(res, startTile) {
    if (!res) return null;
    if (res instanceof Map) {
      var v = res.get(startTile);
      if (!v) return null;
      return Array.isArray(v) ? (v.length > 0 ? v[0] : null) : v;
    }
    if (Array.isArray(res)) return res.length > 0 ? res[0] : null;
    return res;
  }

  // BotGatherOps 各 gather 函数返回 [move, value, turns, gatherNodes]
  function _gatherTuple(res) {
    if (!res) return [null, -1, -1, null];
    return [res[0], res[1], res[2], res[3]];
  }

  // ---------------------------------------------------------------------------
  // 拦截 + 防守树混合
  // ---------------------------------------------------------------------------

  /*
   * 用「拦截点上的兵」替掉防守树里对应的一段，再按剩余回合剪枝，
   * 谁的 (兵/回合) 更划算就用谁。意义是让拦截和补兵共用同一批兵，
   * 而不是各算各的。
   */
  BotDefense.check_defense_hybrid_intercept_moves = function (bot, threat, defensePlan, missingDefense, defenseNegatives) {
    var plans = _alias(bot, ['intercept_plans', 'interceptions']);
    if (!(plans instanceof Map)) return [null, null, false, defensePlan];
    var plan = plans.get(threat.path.start.tile);
    if (!plan) return [null, null, false, defensePlan];

    var general = bot.general;
    var achievedDefense = 0;
    for (var i = 0; i < defensePlan.length; i++) achievedDefense += Math.trunc(defensePlan[i].value);
    var totalToSurvive = achievedDefense + missingDefense;

    var bestOpt = null;
    var bestTurns = -1;
    var bestAchievedDefense = -1;
    var bestRemainingDefense = defensePlan;
    var defTileSet = new Set();
    for (var di = 0; di < defensePlan.length; di++) defTileSet.add(defensePlan[di].tile);

    var opts = plan.intercept_options;
    if (opts instanceof Map) {
      var keys = Array.from(opts.keys()).sort(function (a, b) { return a - b; });
      for (var ki = 0; ki < keys.length; ki++) {
        var opt = opts.get(keys[ki]);
        if (!opt) continue;
        if (threat.path.tileSet.has(opt.path.start.tile)) continue;
        // 只吃「路径长度 == 方案回合」的那种选项，其余是别的分支的产物
        if (keys[ki] !== opt.path.length) continue;

        var cloned = _cloneNodes(defensePlan);
        var isGeneralThreat = threat.path.tail.tile.isGeneral;
        if (opt.length > threat.turns && isGeneralThreat) continue;

        var forcePrune = new Set();
        opt.tileSet.forEach(function (t) {
          if (!defTileSet.has(t)) forcePrune.add(t);
        });
        var pruned = _pruneMstToTurnsWithValues(cloned,
          threat.turns - opt.worst_case_intercept_moves, _player(general), forcePrune, true);
        var turns = pruned[0];
        var val = pruned[1];
        var remaining = pruned[2];

        var currentAchievedDefense = val + opt.friendly_army_reaching_intercept;
        var currentGatherTurns = turns + opt.worst_case_intercept_moves;
        var betterVt = currentAchievedDefense > totalToSurvive
          && (bestTurns <= 0 || currentAchievedDefense / currentGatherTurns > bestAchievedDefense / bestTurns);
        if (currentAchievedDefense >= bestAchievedDefense || betterVt) {
          bestTurns = currentGatherTurns;
          bestAchievedDefense = currentAchievedDefense;
          bestRemainingDefense = remaining;
          bestOpt = opt;
        }
      }
    }
    if (bestOpt) {
      return [_firstPathMove(bot, bestOpt.path), bestOpt.path, bestOpt.requiredDelay > 0, bestRemainingDefense];
    }
    return [null, null, false, bestRemainingDefense];
  };

  // ---------------------------------------------------------------------------
  // 视野 / 侧翼（fog flank）
  // ---------------------------------------------------------------------------

  /*
   * 反推敌人最可能从雾里打过来的一条路：只在「可被侧翼的雾区 + 敌队格子 +
   * 看不见」的格子上搜，最大化带兵量、最小化跳数。
   */
  BotDefense.get_enemy_probable_attack_path = function (bot, enemyPlayer) {
    var map = _map(bot);
    var board = bot.board_analysis;
    if (!board || !board.flankable_fog_area_matrix) return null;
    var teams = map.team_ids_by_player_index;
    var enTeam = teams[enemyPlayer];
    var flank = board.flankable_fog_area_matrix.raw;
    var general = bot.general;
    if (!general) throw new Error('get_enemy_probable_attack_path requires bot.general');

    var valueFunc = function (curTile, prioObj) {
      if (!prioObj) return null;
      if (!flank[_idx(curTile)]) return null;
      if (teams[_player(curTile)] !== enTeam) return null;
      if (curTile.visible) return null;
      var negArmySum = prioObj[1];
      return [0 - negArmySum, 0 - prioObj[0], prioObj[2], prioObj[3]];
    };
    var priorityFunc = function (nextTile, prioObj) {
      var dist = prioObj[0] + 1;
      var negArmySum = prioObj[1];
      var goalIncrement = prioObj[4] === undefined ? 0 : prioObj[4];
      if (teams[_player(nextTile)] === enTeam) negArmySum -= nextTile.army;
      negArmySum += 1;
      negArmySum -= goalIncrement;
      return [dist, negArmySum, prioObj[2] + nextTile.x, prioObj[3] + nextTile.y, goalIncrement];
    };

    var genSet = new Set();
    var genTargs = [general];
    if (bot.player && bot.player.tiles) {
      var own = Array.from(bot.player.tiles);
      for (var i = 0; i < own.length; i++) genSet.add(own[i]);
    }
    if (map.teammates) {
      map.teammates.forEach(function (p) {
        if (p === map.player_index) return;
        var pl = map.players[p];
        if (!pl || pl.dead) return;
        if (pl.general) { genTargs.push(pl.general); genSet.add(pl.general); }
        if (pl.tiles) {
          var tt = Array.from(pl.tiles);
          for (var j = 0; j < tt.length; j++) genSet.add(tt[j]);
        }
      });
    }

    var searchLen = 15;
    if (bot.shortest_path_to_target_player) searchLen = bot.shortest_path_to_target_player.length + 1;

    var startTiles = new Map();
    for (var gi = 0; gi < genTargs.length; gi++) {
      var gt = genTargs[gi];
      startTiles.set(gt, [[0, 0, gt.x, gt.y, 0], 0]);
    }
    if (startTiles.size === 0) return null;

    var res = EK.search.breadth_first_dynamic_max(map, startTiles, valueFunc, {
      maxDepth: searchLen,
      priorityFunc: priorityFunc,
      noNeutralCities: true,
      noNeutralUndiscoveredObstacles: true,
      negativeTiles: genSet,
      searchingPlayer: enemyPlayer,
      ignoreNonPlayerArmy: true,
      noLog: true
    });
    var enPath = null;
    if (res instanceof Map) {
      var best = null;
      res.forEach(function (v) {
        var p = Array.isArray(v) ? (v.length > 0 ? v[0] : null) : v;
        if (!p) return;
        if (!best || p.value > best.value) best = p;
      });
      enPath = best;
    } else {
      enPath = _firstPathFromSearch(res, genTargs[0]);
    }
    if (!enPath || enPath.length < 3) return null;
    enPath = enPath.get_reversed();
    enPath.calculate_value(enemyPlayer, teams, genSet, true);
    return enPath;
  };

  /*
   * 从「我方已经推进到的那条路」的中段往后找：敌人会从哪片雾里兜出来。
   * 和 get_enemy_probable_attack_path 的差别是只收可见格（已知敌军位置），
   * 也就是「已经露头的包夹」。
   */
  BotDefense.find_sketchy_fog_flank_from_enemy_in_play_area = function (bot, searchPath) {
    if (!searchPath || !searchPath.start) return null;
    var map = _map(bot);
    var board = bot.board_analysis;
    if (!board || !board.flankable_fog_area_matrix) return null;
    var teams = map.team_ids_by_player_index;
    var enPlayer = _player(searchPath.start.tile);
    var enTeam = teams[enPlayer];
    var flank = board.flankable_fog_area_matrix.raw;

    var valueFunc = function (curTile, prioObj) {
      if (!prioObj) return null;
      if (!flank[_idx(curTile)]) return null;
      if (teams[_player(curTile)] !== enTeam) return null;
      if (!curTile.visible) return null;
      var negArmySum = prioObj[1];
      return [0 - negArmySum, 0 - prioObj[0], prioObj[2], prioObj[3]];
    };
    var priorityFunc = function (nextTile, prioObj) {
      var dist = prioObj[0] + 1;
      var negArmySum = prioObj[1];
      if (teams[_player(nextTile)] === enTeam) negArmySum -= nextTile.army;
      negArmySum += 1;
      var goalIncrement = 0;
      if (EK.BotPathingUtils && typeof EK.BotPathingUtils.get_distance_from_board_center === 'function') {
        goalIncrement = 0.0001 * EK.BotPathingUtils.get_distance_from_board_center(bot, nextTile, 0.3);
      }
      return [dist, negArmySum, prioObj[2] + nextTile.x, prioObj[3] + nextTile.y, goalIncrement];
    };

    var tileList = searchPath.tileList;
    var negativeTiles = new Set();
    var negStart = Math.max(0, tileList.length - 2);
    for (var ni = negStart; ni < tileList.length; ni++) negativeTiles.add(tileList[ni]);

    var halfLen = Math.max(1, Math.floor(searchPath.length / 2));
    var startTiles = new Map();
    for (var si = 0; si < halfLen && si < tileList.length; si++) {
      var st = tileList[si];
      startTiles.set(st, [[0, 0, st.x, st.y, 0], 0]);
    }
    if (startTiles.size === 0) return null;

    var res = EK.search.breadth_first_dynamic_max(map, startTiles, valueFunc, {
      maxDepth: halfLen,
      priorityFunc: priorityFunc,
      noNeutralCities: true,
      noNeutralUndiscoveredObstacles: true,
      negativeTiles: negativeTiles,
      searchingPlayer: enPlayer,
      ignoreNonPlayerArmy: true,
      noLog: true
    });
    var enPath = _firstPathFromSearch(res, tileList[0]);
    if (!enPath || enPath.length < 2) return null;
    return enPath.get_reversed();
  };

  /*
   * 全图扫所有「可被侧翼的雾格」，逐格当起点找包夹机会，用
   * flankPath.value + 10*centerDist - pathAbsDist/2 打分取最优。
   */
  BotDefense.find_sketchiest_fog_flank_from_enemy = function (bot) {
    var map = _map(bot);
    var board = bot.board_analysis;
    if (!board || !board.flankable_fog_area_matrix) return null;
    if (!bot.shortest_path_to_target_player) return null;
    var raw = board.flankable_fog_area_matrix.raw;
    var tiles = EK.Gather.sortedByTileIndex(map.get_all_tiles());
    var ourPath = bot.shortest_path_to_target_player;

    // 原版是「逐格开一次 Search」全扫，代价是 O(雾格数 × BFS)。这里先按「离我方进攻路线
    // 的距离」把候选排好序、只留前 10 个：包夹点必然贴着我们的路线，远处的即使算出来
    // 分数也上不去。排序键完全确定（dist 升序 → tile_index 升序），所以仍然可复现。
    var distMap = EK.search.build_distance_map_matrix(map, ourPath.tileList);
    var cand = [];
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!raw[_idx(t)]) continue;
      if (t.visible) continue;
      if (_player(t) !== bot.targetPlayer) continue;
      if (t.isSwamp) continue;
      var d = _mat(distMap, t);
      if (d === null) continue;
      cand.push([d, _idx(t), t]);
    }
    cand.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });

    var bestPath = null;
    var bestScore = -Infinity;
    var limit = Math.min(cand.length, 10);
    for (var ci = 0; ci < limit; ci++) {
      var opp = BotDefense.find_flank_opportunity(bot, cand[ci][2]);
      if (!opp || !opp.flankPath) continue;
      var score = opp.flankPath.value + 10 * opp.centerDist - opp.pathAbsDist / 2;
      if (score > bestScore) { bestScore = score; bestPath = opp.flankPath; }
    }
    return bestPath;
  };

  /*
   * 以某个雾格为起点，往「我方进攻路线」上找包夹落点。
   * 原版用一个 Search 对象边搜边记 centerDist / pathAbsDist，这里返回同样三个量。
   */
  BotDefense.find_flank_opportunity = function (bot, startTile) {
    var map = _map(bot);
    var board = bot.board_analysis;
    if (!startTile || !board) return null;
    if (!bot.shortest_path_to_target_player) return null;
    var playArea = board.flank_danger_play_area_matrix ? board.flank_danger_play_area_matrix.raw : null;
    if (!playArea) return null;
    var ourPath = bot.shortest_path_to_target_player;
    var tileList = ourPath.tileList;
    // 从我们进攻路线的前 1/4 起算「包夹能威胁到我们」的区域
    var quarter = Math.max(1, Math.floor(tileList.length / 4));
    var pathAbsDist = new Map();
    for (var i = 0; i < quarter && i < tileList.length; i++) pathAbsDist.set(tileList[i], i);

    var teams = map.team_ids_by_player_index;
    var enPlayer = bot.targetPlayer;
    var enTeam = teams[enPlayer];
    var flank = board.flankable_fog_area_matrix.raw;

    var valueFunc = function (curTile, prioObj) {
      if (!prioObj) return null;
      if (!flank[_idx(curTile)]) return null;
      if (teams[_player(curTile)] !== enTeam) return null;
      return [0 - prioObj[1], 0 - prioObj[0]];
    };
    var priorityFunc = function (nextTile, prioObj) {
      var dist = prioObj[0] + 1;
      var negArmySum = prioObj[1];
      if (teams[_player(nextTile)] === enTeam) negArmySum -= nextTile.army;
      negArmySum += 1;
      return [dist, negArmySum];
    };

    var startTiles = new Map();
    startTiles.set(startTile, [[0, 0], 0]);
    var res = EK.search.breadth_first_dynamic_max(map, startTiles, valueFunc, {
      maxDepth: Math.max(4, Math.floor(ourPath.length / 2)),
      priorityFunc: priorityFunc,
      noNeutralCities: true,
      negativeTiles: new Set(tileList),
      searchingPlayer: enPlayer,
      ignoreNonPlayerArmy: true,
      noLog: true
    });
    var flankPath = _firstPathFromSearch(res, startTile);
    if (!flankPath || flankPath.length < 2) return null;
    flankPath = flankPath.get_reversed();

    // centerDist：这条路离我们进攻路线前段有多近（越近越危险）
    var centerDist = 10000;
    var ft = flankPath.tileList;
    for (var fi = 0; fi < ft.length; fi++) {
      var d = pathAbsDist.get(ft[fi]);
      if (d !== undefined && d < centerDist) centerDist = d;
    }
    if (centerDist === 10000) centerDist = ourPath.length;
    return { flankPath: flankPath, centerDist: centerDist, pathAbsDist: flankPath.length };
  };

  /*
   * 从 captureLeafMoves 里挑一步去「解视野」：既要往前走（dist>=2），
   * 又要能多揭开几个雾格（revealed 越大越值）。
   */
  BotDefense._get_flank_defense_leafmove = function (bot, flankPath, coreNegs) {
    if (!flankPath || !flankPath.tail) return null;
    var board = bot.board_analysis;
    if (!board || !board.flankable_fog_area_matrix) return null;
    var flankRaw = board.flankable_fog_area_matrix.raw;
    var leafMoves = bot.captureLeafMoves || [];
    var bestWeighted = 3;
    var bestMove = null;
    var map = _map(bot);
    for (var i = 0; i < leafMoves.length; i++) {
      var lm = leafMoves[i];
      if (!lm || !lm.dest) continue;
      if (lm.dest.isSwamp) continue;
      if (coreNegs && coreNegs.has(lm.source)) continue;
      var dist = map.distance_mapper.get_distance_between_or_none(flankPath.tail.tile, lm.dest);
      if (dist === null || dist === undefined) continue;
      var revealed = 0;
      var adj = lm.dest.adjacents;
      for (var a = 0; a < adj.length; a++) {
        if (flankRaw[_idx(adj[a])]) revealed += 1;
      }
      var weighted = dist + revealed;
      if (dist < 2 || weighted < bestWeighted) continue;
      if (flankPath.adjacentSet.has(lm.dest)) {
        bestMove = lm;
        bestWeighted = weighted;
      }
    }
    return bestMove;
  };

  /*
   * 用「贴着我们进攻路线、但还没被敌人占」的雾格做视野防守：宁可浪费几回合
   * 去把雾揭开，也别让敌人从那里兜出来。wasteWeight<=0 说明这几回合纯赚。
   */
  BotDefense._get_flank_vision_defense_move_internal = function (bot, flankThreatPath, negativeTiles, atDist) {
    if (!flankThreatPath || !bot.target_player_gather_path) return null;
    var map = _map(bot);
    var board = bot.board_analysis;
    if (!board || !board.flank_danger_play_area_matrix) return null;
    var playArea = board.flank_danger_play_area_matrix.raw;
    var tileList = flankThreatPath.tileList;
    var includeLimit = Math.floor(tileList.length * 5 / 6);
    var included = new Set();
    for (var i = 0; i < includeLimit && i < tileList.length; i++) {
      var t = tileList[i];
      if (!playArea[_idx(t)]) continue;
      if (t.visible) continue;
      if (t.isSwamp) continue;
      included.add(t);
    }
    if (included.size === 0) return null;

    var flankThreatTiles = new Set();
    for (var j = Math.floor(tileList.length / 2); j < tileList.length; j++) flankThreatTiles.add(tileList[j]);
    var ourAdj = bot.target_player_gather_path.adjacentSet;
    EK.search.breadth_first_foreach(map, Array.from(ourAdj), 2, function (tt) {
      flankThreatTiles.delete(tt);
    });
    if (flankThreatTiles.size < Math.floor(tileList.length / 5) + 1) return null;

    var captureFirstValueFunc = EK.BotGatherOps.get_capture_first_tree_move_prio_func(bot);
    var playerArmyBaseline = bot.player && bot.player.tileCount > 0
      ? Math.trunc(bot.player.standingArmy / bot.player.tileCount) : 1;
    var maxOffs = Math.max(2, Math.floor(bot.target_player_gather_path.length / 4));
    var offset = 0;
    var move = null;
    while (move === null && offset < maxOffs) {
      var gathTurns = offset + (50 - map.turn) % 4;
      var res = EK.BotGatherOps.get_gather_to_target_tiles(bot, Array.from(included), 0.002, gathTurns,
        negativeTiles, 0, true, captureFirstValueFunc, false, false, 0, null, null, null, false, false);
      var tuple = _gatherTuple(res);
      var gatherNodes = tuple[3];
      var valGathered = tuple[1];
      if (gatherNodes) {
        var caps = 0;
        for (var gi = 0; gi < gatherNodes.length; gi++) {
          var gn = gatherNodes[gi];
          if (gn.children.length > 0 && !_isFriendlyTile(bot, gn.tile)) caps += 1;
        }
        var wasteWeight = gathTurns - caps;
        if (wasteWeight <= 0) {
          var prunedRes = _pruneMstToArmyWithValues(gatherNodes, 1, _player(bot.general), null);
          var pruned = prunedRes[2];
          var startNode = null;
          for (var pi = 0; pi < pruned.length; pi++) {
            if (pruned[pi].gatherTurns > 0) { startNode = pruned[pi]; break; }
          }
          if (startNode) {
            var path = new EK.Path(0);
            path.add_start(startNode.tile);
            var cur = startNode;
            while (cur.children.length > 0) {
              cur = cur.children[0];
              path.add_next(cur.tile, false);
            }
            if (path.length > 0) bot.curPath = path;
          }
        } else if (3 * valGathered / wasteWeight < playerArmyBaseline) {
          move = null;
        } else {
          move = EK.BotGatherOps.get_tree_move_default(bot, gatherNodes);
        }
      }
      offset += 2;
    }
    return move;
  };

  // ---------------------------------------------------------------------------
  // 补兵到威胁路径（gather）
  // ---------------------------------------------------------------------------

  /*
   * 沿威胁路径铺一张「每一跳需要多少兵」的表，让 gather 知道该往哪补。
   * allowNonChoke 只在强制往上顶的时候开（否则会绕开所有 choke）。
   */
  /*
   * python 的 gather 目标参数是 {tile: dist} 字典，JS 的 BotGatherOps 只认「tile 集合」，
   * 而且 toArr(Map) 会把 Map 拆成 [key,value] 二元组（下游直接 .player() 就炸）。
   * 所以进 gather 之前统一把字典摊平成 tile 数组；dist 本身由 prioMatrix 承担。
   */
  function _tilesFromDistDict(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d.slice();
    if (d instanceof Set) return Array.from(d);
    var out = [];
    if (d instanceof Map || (typeof d.forEach === 'function' && typeof d.get === 'function')) {
      d.forEach(function (_v, t) { if (t && t.tile_index !== undefined) out.push(t); });
      return out;
    }
    var keys = Object.keys(d);
    for (var i = 0; i < keys.length; i++) {
      var v = d[keys[i]];
      if (v && v.tile_index !== undefined) out.push(v);
    }
    return out;
  }

  BotDefense.try_threat_gather = function (bot, threats, distDict, gatherDepth, force_turns_up_threat_path,
                                          requiredContribution, gatherMax, additionalNegatives, timeLimit,
                                          pruneDepth, shouldLog, fastMode) {
    if (force_turns_up_threat_path === undefined) force_turns_up_threat_path = 0;
    if (gatherMax === undefined) gatherMax = true;
    if (timeLimit === undefined || timeLimit === null) timeLimit = 0.05;
    var map = _map(bot);
    var general = bot.general;
    var threat = threats[0];
    var startTile = threat.path.start.tile;
    if (map.is_player_on_team_with(_player(startTile), _player(general))) {
      throw new Error('threat paths should start with enemy tile, not friendly tile.');
    }
    if (!threat.armyAnalysis) return [null, -1, -1, null];
    var aMap = threat.armyAnalysis.aMap;

    if (force_turns_up_threat_path > 0) {
      var rev = threat.path.tileList.slice().reverse();
      for (var i = 0; i < force_turns_up_threat_path && i < rev.length; i++) distDict.delete(rev[i]);
    }

    var negatives = new Set();
    threat.path.tileSet.forEach(function (t) { negatives.add(t); });
    if (!threat.path.tail.tile.isGeneral) {
      var dangerTiles = BotDefense.get_danger_tiles(bot);
      if (dangerTiles && dangerTiles.length > 0) negatives.add(general);
    }
    if (additionalNegatives) {
      additionalNegatives.forEach(function (t) { negatives.add(t); });
    }
    // 将军会被秒的时候，任何已经被占掉的防守格都别再加兵
    var blocking = bot.blocking_tile_info;
    if (blocking && threat.path.tail.tile.isGeneral) {
      if (blocking instanceof Map) blocking.forEach(function (_, t) { void _; negatives.add(t); });
      else for (var bt in blocking) negatives.add(blocking[bt].tile || bt);
    }

    var prioMatrix = new EK.MapMatrix(map, 0.0);
    var allTiles = EK.Gather.sortedByTileIndex(map.get_all_tiles());
    for (var ti = 0; ti < allTiles.length; ti++) {
      var v = _mat(aMap, allTiles[ti]);
      if (v !== null) prioMatrix.raw[_idx(allTiles[ti])] = 0.0001 * v;
    }

    var targetArmy = requiredContribution === null || requiredContribution === undefined
      ? -1 : requiredContribution;
    if (gatherMax && targetArmy >= 0) targetArmy = -Math.max(targetArmy, threat.threatValue);

    var res = EK.BotGatherOps.get_defensive_gather_to_target_tiles(bot, _tilesFromDistDict(distDict),
      timeLimit, gatherDepth,
      negatives, targetArmy, true, null, false, false, 0, null, null, prioMatrix, null, !!shouldLog, !!fastMode);
    var tuple = _gatherTuple(res);
    var move = EK.BotGatherOps.get_tree_move_default(bot, tuple[3]);
    return [move, tuple[1], tuple[2], tuple[3]];
  };

  BotDefense.get_gather_to_threat_paths = function (bot, threats, force_turns_up_threat_path, gatherMax,
                                                   shouldLog, addlTurns, requiredContribution,
                                                   additionalNegatives, interceptArmy, timeLimit) {
    if (!threats || threats.length === 0) return [null, -1, -1, null];
    if (force_turns_up_threat_path === undefined) force_turns_up_threat_path = 0;
    if (addlTurns === undefined) addlTurns = 0;
    var threat = threats[0];
    var gatherDepth = threat.path.length + addlTurns;
    var distDict = threat.convert_to_dist_dict(force_turns_up_threat_path !== 0, -1 - addlTurns);
    if (bot.has_defenseless_modifier && bot.general && distDict.delete) distDict.delete(bot.general);
    return BotDefense.try_threat_gather(bot, threats, distDict, gatherDepth, force_turns_up_threat_path,
      requiredContribution, gatherMax, additionalNegatives, timeLimit);
  };

  BotDefense.get_gather_to_threat_path = function (bot, threat, force_turns_up_threat_path, gatherMax,
                                                  shouldLog, addlTurns, requiredContribution,
                                                  additionalNegatives, interceptArmy, timeLimit) {
    return BotDefense.get_gather_to_threat_paths(bot, [threat], force_turns_up_threat_path, gatherMax,
      shouldLog, addlTurns, requiredContribution, additionalNegatives, interceptArmy, timeLimit);
  };

  /*
   * 便宜版：不建「每跳要多少兵」的表，直接沿着威胁的 shortestPathWay 走。
   * 用在只想要一个「差不多方向」的时候（例如末段抢城）。
   */
  BotDefense.get_gather_to_threat_path_greedy = function (bot, threat, force_turns_up_threat_path, gatherMax, shouldLog) {
    if (force_turns_up_threat_path === undefined) force_turns_up_threat_path = 0;
    if (gatherMax === undefined) gatherMax = true;
    var map = _map(bot);
    if (!threat.armyAnalysis) return [null, -1, -1, null];
    var gatherDepth = threat.path.length - 1;
    var distDict = threat.convert_to_dist_dict();
    if (force_turns_up_threat_path > 0) {
      var rev = threat.path.tileList.slice().reverse();
      for (var i = 0; i < force_turns_up_threat_path && i < rev.length; i++) distDict.delete(rev[i]);
    }
    var distMap = EK.search.build_distance_map_matrix(map, [threat.path.start.tile]);
    var shortestSet = threat.armyAnalysis.shortestPathWay.tiles;
    var priorityFunc = function (nextTile) {
      return [shortestSet.has(nextTile), _mat(distMap, nextTile)];
    };
    var valueFunc = function (curTile) {
      var d = _mat(distMap, curTile);
      return [!shortestSet.has(curTile), d === null ? -1000 : -d];
    };
    var targetArmy = gatherMax ? -threat.threatValue : threat.threatValue;
    var res = EK.BotGatherOps.get_gather_to_target_tiles_greedy(bot, _tilesFromDistDict(distDict), 0.05,
      gatherDepth, null, targetArmy, true, priorityFunc, valueFunc, true);
    var tuple = _gatherTuple(res);
    return [tuple[0], tuple[1], tuple[2], tuple[3]];
  };

  // ---------------------------------------------------------------------------
  // 防守树 / 防守格登记 / 经济判断
  // ---------------------------------------------------------------------------

  /*
   * MapSpanningUtils.get_max_gather_spanning_tree_set_from_tile_lists：
   * 用「将军 + 己方城」当必连点，在可见格里长出一棵覆盖树。
   * 只连到 distLimit 是为了别把整张图都算成防守区（那会让所有扩张都被判成不防守）。
   */
  BotDefense._get_defensive_spanning_tree = function (bot, negativeTiles, gatherPrioMatrix,
                                                      use_cities_in_play_only, require_min_distance) {
    if (use_cities_in_play_only === undefined) use_cities_in_play_only = true;
    if (require_min_distance === undefined) require_min_distance = false;
    if (!negativeTiles) negativeTiles = new Set();
    var map = _map(bot);
    var general = bot.general;
    if (!general) return new Set();

    var includes = [general];
    if (map.is_2v2 && map.teammates) {
      map.teammates.forEach(function (p) {
        if (p === map.player_index) return;
        var pl = map.players[p];
        if (pl && !pl.dead && pl.general) includes.push(pl.general);
      });
    }

    var distLimit = 50;
    var sketchy = bot.sketchiest_potential_inbound_flank_path;
    if (sketchy && sketchy.tail && sketchy.tail.tile) {
      // py:1774 没有下限 2，负数也照传（maxTurns 为负会让 max_gather 只剩最短连接）
      distLimit = _genDist(bot, sketchy.tail.tile) - 2;
    } else {
      var ia = bot.board_analysis && bot.board_analysis.intergeneral_analysis;
      var spw = ia && ia.shortestPathWay;
      if (spw && spw.tiles) {
        // py:1776-1778：取所有不可见格距离里的**最小**值，不是第一个（顺序无关）
        var minDist = null;
        var it = (spw.tiles instanceof Set) ? spw.tiles.values() : (spw.tiles || [])[Symbol.iterator]();
        var cur = it.next();
        while (!cur.done) {
          var t = cur.value;
          if (t && !t.visible) {
            var d = _genDist(bot, t);
            if (minDist === null || d < minDist) minDist = d;
          }
          cur = it.next();
        }
        if (minDist !== null) distLimit = minDist;
      }
    }

    var cities = [];
    if (use_cities_in_play_only && EK.BotCentralDefense
      && typeof EK.BotCentralDefense._get_central_defense_cities_in_play === 'function') {
      cities = EK.BotCentralDefense._get_central_defense_cities_in_play(bot) || [];
    }
    if (cities.length === 0) {
      for (var p = 0; p < map.players.length; p++) {
        if (!map.is_player_on_team_with(p, map.player_index)) continue;
        var cs = map.players[p].cities;
        if (!cs) continue;
        for (var ci = 0; ci < cs.length; ci++) cities.push(cs[ci]);
      }
    }

    // py:1802 `limit = 12 if not use_cities_in_play_only else 3`（原来这支反了）
    var limit = use_cities_in_play_only ? 3 : 12;
    if (cities.length > limit) {
      var terr = _alias(bot, ['territories', 'territoryClassifier']);
      var tdist = terr && terr.territoryDistances && bot.targetPlayer !== undefined
        ? terr.territoryDistances[bot.targetPlayer] : null;
      cities = cities.slice().sort(function (a, b) {
        var av = tdist ? _mat(tdist, a) : null;
        var bv = tdist ? _mat(tdist, b) : null;
        if (av === null) av = 1000;
        if (bv === null) bv = 1000;
        return av - bv || a.tile_index - b.tile_index;
      }).slice(0, limit);
    }
    for (var cj = 0; cj < cities.length; cj++) includes.push(cities[cj]);

    var maxGenDist = 0;
    for (var k = 0; k < includes.length; k++) {
      var gd = _genDist(bot, includes[k]);
      if (gd > maxGenDist) maxGenDist = gd;
    }
    distLimit = Math.max(distLimit, Math.trunc(maxGenDist * 1.5));

    var banned = new Set();
    var allTiles = EK.Gather.sortedByTileIndex(map.get_all_tiles());
    for (var b = 0; b < allTiles.length; b++) {
      if (!allTiles[b].visible) banned.add(allTiles[b]);
    }

    var valueMatrix = gatherPrioMatrix;
    if (!valueMatrix || !valueMatrix.raw) {
      valueMatrix = new EK.MapMatrix(map, 0.0);
      for (var vm = 0; vm < allTiles.length; vm++) {
        if (allTiles[vm].visible) valueMatrix.raw[_idx(allTiles[vm])] = 1.0;
      }
    }

    // py:1816-1825 → MapSpanningUtils.get_max_gather_spanning_tree_set_from_tile_lists。
    // 原版这里不是 Gather.gath_set_quick：gath_set_quick 返回 GatherCapturePlan，
    // 早先按 Tile 数组取用，空计划时 .length 为 0，防守树永远空。
    var spanRes = EK.MapSpanning.get_max_gather_spanning_tree_set_from_tile_lists(
      map, includes, banned, general.player(), valueMatrix,
      { negativeTiles: negativeTiles, maxTurns: distLimit, require_min_distance: require_min_distance });
    return new Set(spanRes[0]);
  };

  /*
   * 把「这条威胁路上我已经占住的格子」登记成防守格，并标明每格要多少兵才挡得住、
   * 以及哪些格不能走（走了等于给敌人让路）。
   */
  BotDefense.set_defensive_blocks_against = function (bot, threat) {
    var map = _map(bot);
    var blocking = bot.blocking_tile_info;
    if (!(blocking instanceof Map)) { blocking = new Map(); bot.blocking_tile_info = blocking; }

    var defDist = function (tile) {
      var aa = threat.armyAnalysis;
      if (!aa) return 100;
      var v = aa.interceptDistances ? _mat(aa.interceptDistances, tile) : null;
      if (v !== null) return v;
      if (aa.pathWayLookupMatrix) {
        var pw = aa.pathWayLookupMatrix.raw ? aa.pathWayLookupMatrix.raw[_idx(tile)] : aa.pathWayLookupMatrix[tile];
        if (pw && pw.distance !== undefined) return pw.distance;
      }
      return 100;
    };

    var register = function (defensiveTile) {
      if (!defensiveTile) return;
      var block = blocking.get(defensiveTile);
      var amountNecessary = Math.max(0, threat.threatValue - defensiveTile.army);
      if (!block) {
        block = new EK.ThreatBlockInfo(defensiveTile, Math.min(defensiveTile.army, amountNecessary));
        blocking.set(defensiveTile, block);
      } else {
        block.amount_needed_to_block = Math.min(defensiveTile.army,
          Math.max(block.amount_needed_to_block, amountNecessary));
      }
      var baseDist = defDist(defensiveTile);
      var movables = defensiveTile.movable;
      for (var i = 0; i < movables.length; i++) {
        var tt = movables[i];
        if (baseDist < defDist(tt)) block.add_blocked_destination(tt);
      }
    };

    var tileList = threat.path.tileList;
    for (var i = 0; i < tileList.length; i++) {
      var t = tileList[i];
      if (_player(t) !== map.player_index) continue;
      if (t.army < 3) continue;
      if (threat.path.tail && t === threat.path.tail.tile) continue;
      register(t);
    }

    var leaves = bot.best_defense_leaves || [];
    for (var li = 0; li < leaves.length; li++) {
      var leaf = leaves[li];
      var defensiveTile = leaf.tile;
      if (defensiveTile.army <= 2 && leaf.toTile && leaf.toTile.army > defensiveTile.army) {
        defensiveTile = leaf.toTile;
      }
      register(defensiveTile);
    }
  };

  /*
   * 敌人把一个大兵堆推到我方腹地：要么放弃进攻去救经济，要么干脆先啃掉它。
   * 注意原版在 `len(largeEnemyTiles) > 0` 分支末尾无条件 return False，
   * 后面那段（turnsLeft<5 / defend_economy）是死代码，这里保留形状但不执行。
   */
  BotDefense.check_should_defend_economy_based_on_large_tiles = function (bot) {
    var map = _map(bot);
    var board = bot.board_analysis;
    if (!board || !board.intergeneral_analysis || !board.intergeneral_analysis.shortestPathWay) return false;
    var general = bot.general;
    var pathTiles = board.intergeneral_analysis.shortestPathWay.tiles;

    var enemyLarge = EK.BotCombatOps.find_large_tiles_near(bot, pathTiles, 4, {
      forPlayer: bot.targetPlayer, allowGeneral: false, limit: 1, minArmy: 30
    });
    var friendlyLarge = EK.BotCombatOps.find_large_tiles_near(bot, pathTiles, 5, {
      forPlayer: _player(general), allowGeneral: true, limit: 1, minArmy: 1
    });

    bot.is_blocking_neutral_city_captures = false;
    if (enemyLarge && enemyLarge.length > 0) {
      var largeEnTile = enemyLarge[0];
      var largeFriendArmy = friendlyLarge && friendlyLarge.length > 0 ? friendlyLarge[0].army : 0;
      var me = map.players[_player(general)];
      var dist = _genDist(bot, largeEnTile);
      var thresh = Math.trunc(2 * me.standingArmy / 3) + dist;
      var interGenDist = board.inter_general_distance || (board.intergeneral_analysis.shortestPathWay.distance) || 1000;
      if (largeEnTile.army > largeFriendArmy && largeEnTile.army > thresh
        && dist < Math.trunc(2 * interGenDist / 3) && !largeEnTile.isGeneral) {
        bot.defend_economy = true;
        bot.force_city_take = false;
      }
      if (largeEnTile.army > largeFriendArmy + 35
        && largeEnTile.army > Math.trunc(me.standingArmy / 2) - 35 && !map.is_2v2) {
        bot.is_blocking_neutral_city_captures = true;
      }
      var cp = bot.curPath;
      if (bot.is_blocking_neutral_city_captures && cp && cp.tail && cp.tail.tile
        && cp.tail.tile.isCity && cp.tail.tile.isNeutral) {
        bot.curPath = null;
        bot.force_city_take = false;
      }
      return false;
    }
    return false;
  };

  /*
   * 值不值得去救队友：只有「-3 回合能自己搞定」时才不救。
   * 两个 get_best_defense 的差别就是那 2 个回合的余量。
   */
  BotDefense.determine_should_defend_ally = function (bot) {
    var da = _alias(bot, ['dangerAnalyzer', 'danger_analyzer']);
    var threat = da ? da.fastestAllyThreat : null;
    if (!threat) return false;
    if (bot.teammate_communicator && bot.is_defense_lead) return true;
    var saveOnesOwnSkin = BotDefense.get_best_defense(bot, threat.path.tail.tile, threat.turns - 3,
      threat.path.tileList);
    if (saveOnesOwnSkin && threat.threatValue < saveOnesOwnSkin.value) return false;
    var closeOne = BotDefense.get_best_defense(bot, threat.path.tail.tile, threat.turns - 1,
      threat.path.tileList);
    if (closeOne && threat.threatValue < closeOne.value) return true;
    return true;
  };

  /*
   * 从某个格子出发、在 turns 回合内能凑到多少兵（拿来和威胁值比）。
   * ignoreStartTile=True 是原版刻意的：起点自己那点兵不算「攒到的」。
   */
  BotDefense.get_best_defense = function (bot, defendingTile, turns, negativeTileList) {
    if (!defendingTile) return null;
    var map = _map(bot);
    var searchingPlayer = _player(defendingTile);
    var teams = map.team_ids_by_player_index;
    var negativeTiles = new Set();
    if (negativeTileList) for (var i = 0; i < negativeTileList.length; i++) negativeTiles.add(negativeTileList[i]);

    var valueFunc = function (curTile, prioObj) {
      if (!prioObj) return null;
      return [0 - prioObj[1], 0 - prioObj[0]];
    };
    var priorityFunc = function (nextTile, prioObj) {
      var negArmySum = prioObj[1] + 1;
      if (teams[_player(nextTile)] === searchingPlayer) negArmySum -= nextTile.army;
      else negArmySum += nextTile.army;
      return [prioObj[0] + 1, negArmySum, prioObj[2] + nextTile.x, prioObj[3] + nextTile.y];
    };
    var startTiles = new Map();
    startTiles.set(defendingTile, [[0, 0, defendingTile.x, defendingTile.y], 0]);
    var res = EK.search.breadth_first_dynamic_max(map, startTiles, valueFunc, {
      maxDepth: turns,
      maxTurns: turns,
      priorityFunc: priorityFunc,
      noNeutralCities: true,
      negativeTiles: negativeTiles,
      searchingPlayer: searchingPlayer,
      ignoreStartTile: true,
      preferNeutral: false,
      noLog: true
    });
    var savePath = _firstPathFromSearch(res, defendingTile);
    if (!savePath) return null;
    savePath = savePath.get_reversed();
    var negs = new Set();
    if (negativeTileList) for (var n = 0; n < negativeTileList.length; n++) negs.add(negativeTileList[n]);
    negs.add(defendingTile);
    savePath.calculate_value(searchingPlayer, teams, negs);
    return savePath;
  };

  // 原版 ThreatInfo.convert_to_dist_dict(allowNonChoke, offset)。JS 侧的 Threat 若没带这个
  // 方法，就用威胁路径本身按跳数铺一张等价的表；gather 只关心「哪格该在第几回合到位」。
  function _threatDistDict(threat, allowNonChoke, offset) {
    if (threat && typeof threat.convert_to_dist_dict === 'function') {
      return threat.convert_to_dist_dict(!!allowNonChoke, offset);
    }
    var dict = new Map();
    if (!threat || !threat.path || !threat.path.tileList) return dict;
    var list = threat.path.tileList;
    for (var i = 0; i < list.length; i++) {
      dict.set(list[i], Math.max(0, i + (offset || 0)));
    }
    return dict;
  }

  // ---------------------------------------------------------------------------
  // 防守主干
  // ---------------------------------------------------------------------------

  /*
   * BotDefense.get_defense_moves：每回合防守的总入口，返回 [move, savePath]。
   *
   * 顺序不能动，原因写在各段注释里：
   *   1. 先问拦截（check_defense_intercept_move）。拦截值 >1 兵/回合就直接用，
   *      那是「用更少的兵挡住同一条路」，比补兵便宜。
   *   2. 拦截挡不住就补兵（gather 到威胁路径），补到「刚好够活」为止。
   *   3. 补不够（DEAD 分支）才考虑换路子：将军被秒就看能不能反杀，
   *      城被围就多加 6 回合松一点再补。
   *   4. 剩下的威胁再考虑去抢敌人的将（altKingKillPath）。
   *
   * 与原文的差异只有两处：没有 BotComms（「告诉队友」只记账）；
   * 原版的断言在 JS 里不抛（调试期才开）。
   */
  BotDefense.get_defense_moves = function (bot, defenseCriticalTileSet, raceEnemyKingKillPath, raceChance) {
    var map = _map(bot);
    var general = bot.general;
    var teams = map.team_ids_by_player_index;
    var da = _alias(bot, ['dangerAnalyzer', 'danger_analyzer']);
    var outputDefenseCriticalTileSet = defenseCriticalTileSet || new Set();
    bot.best_defense_leaves = [];

    var threats = [];
    if (da) {
      var fastestThreat = da.fastestThreat;
      if (fastestThreat && fastestThreat.turns > -1) threats.push(fastestThreat);
      var allyThreat = da.fastestAllyThreat;
      if (allyThreat) {
        // 队友的威胁如果比「同起点的自家威胁」更快，就顶掉自家那条重算
        if (threats.length === 1
          && threats[0].path.start.tile === allyThreat.path.start.tile
          && threats[0].turns - 1 > allyThreat.turns) threats = [];
        threats.push(allyThreat);
      }
      if (da.fastestCityThreat) threats.push(da.fastestCityThreat);
    }
    if (threats.length === 0) return [null, null];

    // 将军威胁优先：某个城威胁正好压在将军威胁的必经路上，就先处理它
    // （不先拿下它，去动将军等于自断退路）。
    if (threats.length > 1 && da && da.fastestThreat) {
      var generalThreat = da.fastestThreat;
      if (generalThreat.armyAnalysis && generalThreat.armyAnalysis.shortestPathWay) {
        var pathTiles = generalThreat.armyAnalysis.shortestPathWay.tiles;
        for (var pi = 1; pi < threats.length; pi++) {
          var tt = threats[pi].path.tail.tile;
          if (tt.isCity && pathTiles.has(tt)) {
            var moved = threats[pi];
            threats.splice(pi, 1);
            threats.unshift(moved);
            break;
          }
        }
      }
    }

    var negativeTilesIncludingThreat = new Set();
    if (outputDefenseCriticalTileSet.forEach) {
      outputDefenseCriticalTileSet.forEach(function (t) { negativeTilesIncludingThreat.add(t); });
    }
    for (var nt = 0; nt < threats.length; nt++) {
      if (threats[nt].threatType !== EK.ThreatType.Kill) continue;
      var pts = threats[nt].path.tileSet;
      if (pts) pts.forEach(function (t) { negativeTilesIncludingThreat.add(t); });
    }

    var movesToMakeAnyway = [];
    var realThreats = [];
    var savePath = null;
    var is2v2Ally = _is2v2TeammateAlive(bot);

    for (var ti = 0; ti < threats.length; ti++) {
      var threat = threats[ti];
      var threatTile = threat.path.start.tile;

      var interceptRes = BotDefense.check_defense_intercept_move(bot, threat);
      var interceptMove = interceptRes ? interceptRes[0] : null;
      var interceptPath = interceptRes ? interceptRes[1] : null;
      var intOption = interceptRes ? interceptRes[2] : null;
      var interceptDelayed = interceptRes ? !!interceptRes[3] : false;

      if (interceptDelayed) {
        // 拦截要等：这回合不能动这些格，把它们标成本回合禁走
        if (interceptPath && interceptPath.tileList) {
          for (var di = 0; di < interceptPath.tileList.length; di++) {
            negativeTilesIncludingThreat.add(interceptPath.tileList[di]);
            outputDefenseCriticalTileSet.add(interceptPath.tileList[di]);
          }
        }
        continue;
      }
      // 1 兵/回合以上的拦截直接交（原版阈值 1.0）
      if (interceptMove && intOption && intOption.length > 0
        && intOption.econValue / intOption.length > 1.0) {
        return [interceptMove, interceptPath];
      }

      var isRealThreat = true;
      var isEconThreat = !threat.path.tail.tile.isGeneral;

      var trackedArmy = bot.armyTracker ? bot.armyTracker.armies.get(threatTile) : null;
      if (trackedArmy && trackedArmy.visible && trackedArmy.last_moved_turn > map.turn - 2) {
        bot.targetingArmy = trackedArmy;
      }

      var threatMovingWrongWay = false;
      var delta = threatTile.delta;
      if (delta && delta.fromTile && threat.armyAnalysis && threat.armyAnalysis.aMap) {
        var aNow = _mat(threat.armyAnalysis.aMap, threatTile);
        var aFrom = _mat(threat.armyAnalysis.aMap, delta.fromTile);
        if (aNow !== null && aFrom !== null && aNow >= aFrom) threatMovingWrongWay = true;
      }

      var survivalThreshold = 0;
      var saveTurns = 0;
      var move = null;
      var valueGathered = -1;
      var turnsUsed = -1;
      var gatherNodes = null;
      var anyLeafIsSameDistAsThreat = false;
      var additionalNegatives = new Set();

      if (threat.threatType === EK.ThreatType.Kill) {
        survivalThreshold = threat.threatValue;
        saveTurns = threat.turns;
        // 非将军的威胁给的时间更短：补城的兵不值得花掉整回合预算
        var timeLimit = threat.path.tail.tile.isGeneral ? 0.05 : 0.015;
        var gatherRes = BotDefense.get_gather_to_threat_path(bot, threat, 0, true, false, 0,
          survivalThreshold, additionalNegatives, false, timeLimit);
        move = gatherRes[0];
        valueGathered = gatherRes[1];
        turnsUsed = gatherRes[2];
        gatherNodes = gatherRes[3];

        if (gatherNodes && gatherNodes.length > 0 && threat.armyAnalysis) {
          var aMap = threat.armyAnalysis.aMap;
          var leavesFar = _leavesFurtherThanDistance(gatherNodes, aMap, threat.turns, survivalThreshold);
          anyLeafIsSameDistAsThreat = leavesFar.length > 0;

          // 有一片叶子正好能撞到威胁格、且它带的兵够威胁的 20%：直接顶上去，
          // 这比走「default 出招」更早撞车，能抢到一回合。
          var threatTileArmy = threatTile.army;
          for (var lf = 0; lf < leavesFar.length; lf++) {
            var leaf = leavesFar[lf];
            if (leaf.toTile !== threatTile || leaf.children.length !== 0) continue;
            var leafSpareArmy = leaf.tile.army - 1;
            if (threatTileArmy > 0 && leafSpareArmy / threatTileArmy >= 0.20) {
              return [new EK.Move(leaf.tile, leaf.toTile, false), null];
            }
          }
          move = EK.BotGatherOps.get_tree_move_default(bot, gatherNodes,
            BotDefense.get_defense_tree_move_prio_func(bot, threat, anyLeafIsSameDistAsThreat));
        }

        if (move && valueGathered > survivalThreshold) {
          var pruned = _cloneNodes(gatherNodes);
          var prunedRes = _pruneMstToArmyWithValues(pruned, survivalThreshold + 1, _player(general),
            _expansionPlan(bot).preferred_tiles);
          var sumPrunedTurns = prunedRes[0];
          var sumPruned = prunedRes[1];
          pruned = prunedRes[2];

          // 补够了兵就不用再吃中立城：吃掉会把这批兵锁在城里
          if ((bot.is_blocking_neutral_city_captures || valueGathered - sumPruned < 45) && !isEconThreat) {
            _blockNeutralCaptures(bot);
          }

          if (threat.armyAnalysis) {
            var aMap2 = threat.armyAnalysis.aMap;
            var leavesFar2 = _leavesFurtherThanDistance(pruned, aMap2, threat.turns, survivalThreshold, sumPruned);
            anyLeafIsSameDistAsThreat = leavesFar2.length > 0;
            if (!anyLeafIsSameDistAsThreat) {
              // 剪枝后能「刚好卡在敌人前一回合」的叶子，也要求它们别被当成可放弃格
              var blockLeaves = _leavesFurtherThanDistance(pruned, aMap2, saveTurns - 1);
              for (var bl = 0; bl < blockLeaves.length; bl++) outputDefenseCriticalTileSet.add(blockLeaves[bl].tile);
            }
          }

          if (sumPrunedTurns >= threat.turns || anyLeafIsSameDistAsThreat) {
            if (interceptMove) return [interceptMove, interceptPath];
            var minimalDefenseTurns = sumPrunedTurns;

            var pruned2 = _cloneNodes(gatherNodes);
            var maxArmyRes = _pruneMstToMaxArmyPerTurnWithValues(pruned2, survivalThreshold, _player(general),
              teams, _expansionPlan(bot).preferred_tiles);
            sumPrunedTurns = maxArmyRes[0];
            sumPruned = maxArmyRes[1];
            pruned2 = maxArmyRes[2];

            bot.redGatherTreeNodes = gatherNodes;
            bot.gatherNodes = pruned2;
            move = EK.BotGatherOps.get_tree_move_default(bot, pruned2,
              BotDefense.get_defense_tree_move_prio_func(bot, threat, anyLeafIsSameDistAsThreat));
            move = BotDefense.replace_bad_gather_defense_move_with_direct_threat_move(bot, threat, move);

            // 「刚好够活、又没有一片叶子能撞上、还在往后退」= 这条威胁其实不用守
            if (minimalDefenseTurns === threat.turns && !anyLeafIsSameDistAsThreat
              && !_moveTowardsEnemy(bot, move)) {
              _communicateThreatToAlly(bot, threat);
              isRealThreat = false;
              bot.best_defense_leaves = EK.GatherTreeNode.get_tree_leaves(pruned2);
              if (bot.best_defense_leaves.length === 0) BotDefense.set_defensive_blocks_against(bot, threat);
              continue;
            }
            _communicateThreatToAlly(bot, threat);
            return [move, savePath];
          }

          // 剪完还不够回合数：补兵补不赢，只能先占住关键格（不是 choke 的才占，
          // 占 choke 会把自己的补给线堵死）
          _communicateThreatToAlly(bot, threat);
          isRealThreat = false;
          bot.best_defense_leaves = EK.GatherTreeNode.get_tree_leaves(pruned);
          if (bot.best_defense_leaves.length === 0) BotDefense.set_defensive_blocks_against(bot, threat);
          if (sumPrunedTurns >= threat.turns - 2) {
            for (var pn = 0; pn < pruned.length; pn++) {
              var nodeTile = pruned[pn].tile;
              var isChoke = (bot.board_analysis && bot.board_analysis.intergeneral_analysis
                && bot.board_analysis.intergeneral_analysis.is_choke
                && bot.board_analysis.intergeneral_analysis.is_choke(nodeTile))
                || (threat.armyAnalysis && threat.armyAnalysis.is_choke
                  && threat.armyAnalysis.is_choke(nodeTile));
              if (!isChoke) outputDefenseCriticalTileSet.add(nodeTile);
            }
          }
          if (_inFriendlyTerritory(bot, threatTile)) {
            bot.targetingArmy = _army(bot, threatTile);
          }
        }

        // 放弃线：凑不到这么多兵就不算「真威胁」，改走抢将
        var abandonDefenseThreshold = survivalThreshold * 0.8 - 3 - threat.turns;
        if (map.players.length === 2 && map.turn > 250 && !threatMovingWrongWay) {
          abandonDefenseThreshold = survivalThreshold * 0.92 - Math.trunc(threat.turns / 2);
        }
        var thrPlayer = map.players[threat.threatPlayer];
        if (thrPlayer && thrPlayer.knowsKingLocation) {
          abandonDefenseThreshold = survivalThreshold * 0.96 - Math.trunc(threat.turns / 4) - 1;
        }
        if (threat.path.tail.tile.isCity) abandonDefenseThreshold = survivalThreshold;

        if (valueGathered < survivalThreshold - 1) {
          _communicateThreatToAlly(bot, threat);
          var extraTurns = 0;
          var pruneToValuePerTurn = false;
          if (threat.path.tail.tile.isGeneral) {
            // 将军要没了、而抢将这条线跑得赢：直接换
            if (raceChance > 0.1 && raceEnemyKingKillPath) {
              return [_firstPathMove(bot, raceEnemyKingKillPath), raceEnemyKingKillPath];
            }
          } else {
            // 城被围可以多等 6 回合、门槛也放宽 3：城的价大于将军的一条命
            pruneToValuePerTurn = true;
            extraTurns = 6;
            survivalThreshold += 3;
          }
          var altRes = BotDefense.get_gather_to_threat_path(bot, threat, 0, true, false, extraTurns,
            survivalThreshold, additionalNegatives, false, timeLimit);
          var altGatherNodes = altRes[3];
          var altValueGathered = altRes[1];
          var altMove = null;
          if (pruneToValuePerTurn && altGatherNodes) {
            var altPruned = _pruneMstToArmyWithValues(_cloneNodes(altGatherNodes), survivalThreshold + 1,
              _player(general), _expansionPlan(bot).preferred_tiles)[2];
            altMove = EK.BotGatherOps.get_tree_move_default(bot, altPruned,
              BotDefense.get_defense_tree_move_prio_func(bot, threat, true));
          }
          if (altMove && (altMove.dest === threatTile || gatherNodes === null || !is2v2Ally)
            && altValueGathered >= survivalThreshold) {
            bot.redGatherTreeNodes = gatherNodes;
            move = altMove;
            valueGathered = altValueGathered;
            turnsUsed = altRes[2];
            gatherNodes = altGatherNodes;
          }
        }

        // 原版这一段算完 isGatherMoveFromBackwards 就立刻置 False（历史遗留），
        // 所以下面的判断实际恒不成立；照抄形状但不让它生效。
        var isGatherMoveFromBackwards = false;
        if (!isRealThreat && (isGatherMoveFromBackwards || move === null
          || _repetitionTile(bot, move ? move.source : null))) {
          bot.redGatherTreeNodes = gatherNodes;
          bot.gatherNodes = null;
        }

        move = BotDefense.replace_bad_gather_defense_move_with_direct_threat_move(bot, threat, move);
        if (isRealThreat || (move && _repetitionTile(bot, move.source, 8, 3))) realThreats.push(threat);
        if (threat.turns < 7) EK.BotTargeting.increment_attack_counts(bot, threat.path.tail.tile);

        if (valueGathered > abandonDefenseThreshold
          || (is2v2Ally && additionalNegatives.size === 0)) {
          if (isRealThreat) {
            bot.curPath = null;
            bot.gatherNodes = gatherNodes;
            return [move, savePath];
          }
          if (isGatherMoveFromBackwards && move && !_repetitionTile(bot, move.source)) movesToMakeAnyway.push(move);
        }
      }

      if (!isRealThreat || isEconThreat) continue;

      // 防守顾不上，就去抢将：先算「能不能在威胁到达之前赢」
      var tgtGen = bot.targetPlayerExpectedGeneralLocation;
      if (!tgtGen) continue;
      var altKillOffset = 0;
      if (!tgtGen.isGeneral) {
        // 目标将位还没确定：把「不确定成本」按对手地盘大小折算进回合预算
        var tgtPlayerObj = map.players[bot.targetPlayer];
        var tl = tgtPlayerObj && tgtPlayerObj.tiles ? tgtPlayerObj.tiles.length : 1;
        altKillOffset = 5 + Math.trunc(Math.pow(tl, 0.5));
      }
      var altKingKillPath = EK.search.dest_breadth_first_target(map, [tgtGen], {
        targetArmy: 12,
        maxDepth: threat.turns + 1,
        negativeTiles: outputDefenseCriticalTileSet,
        searchingPlayer: _player(general),
        dontEvacCities: false
      });
      var wrpPath = null;
      if (altKingKillPath && !threat.path.tail.tile.isGeneral) {
        wrpPath = EK.BotExpansionOps.get_optimal_exploration(bot, threat.turns, outputDefenseCriticalTileSet,
          null, null, null, null, undefined, 0.020);
        if (wrpPath) {
          // 只有「顺手就把将拆了」的探索才算数，否则它只是条普通扩张线
          var wrpTiles = wrpPath.tileList;
          var hitsGen = false;
          for (var wi = 0; wi < wrpTiles.length; wi++) {
            if (tgtGen.adjacents && tgtGen.adjacents.indexOf(wrpTiles[wi]) >= 0) { hitsGen = true; break; }
          }
          if (!hitsGen) wrpPath = null;
        }
      }
      if (altKingKillPath) {
        var raceTooSlow = !raceEnemyKingKillPath
          || (raceEnemyKingKillPath.length >= threat.turns && !wrpPath);
        if (raceTooSlow && altKingKillPath.length + altKillOffset < threat.turns) {
          return [_firstPathMove(bot, altKingKillPath), savePath];
        }
        if (wrpPath) return [_firstPathMove(bot, wrpPath), savePath];
        if (raceEnemyKingKillPath) return [_firstPathMove(bot, raceEnemyKingKillPath), savePath];
        if (!raceEnemyKingKillPath || raceEnemyKingKillPath.length > threat.turns) {
          return [_firstPathMove(bot, altKingKillPath), savePath];
        }
        return [_firstPathMove(bot, raceEnemyKingKillPath), savePath];
      }
    }

    if (movesToMakeAnyway.length > 0) return [movesToMakeAnyway[movesToMakeAnyway.length - 1], null];
    if (realThreats.length === 0) return [null, null];

    // 真威胁还在但没招了：将军威胁就尝试直接去拆对方的将
    var genLoc = bot.targetPlayerExpectedGeneralLocation;
    for (var ri = 0; ri < realThreats.length; ri++) {
      var rt = realThreats[ri];
      if (!rt.path.tail.tile.isGeneral) continue;
      if (!genLoc) continue;
      if (!genLoc.isGeneral) {
        var explorePath = EK.BotExpansionOps.get_optimal_exploration(bot, Math.max(5, rt.turns),
          outputDefenseCriticalTileSet);
        if (explorePath) {
          var em = _firstPathMove(bot, explorePath);
          if (em) return [em, null];
        }
      } else {
        var killer = EK.BotGatherOps.get_gather_to_target_tile(bot, genLoc, 1.0, rt.turns);
        var killerTuple = _gatherTuple(killer);
        if (killerTuple[0]) return [killerTuple[0], null];
      }
    }
    return [null, null];
  };

  EK.BotDefense = BotDefense;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
