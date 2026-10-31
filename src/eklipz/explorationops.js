/* Human.exe 的 BotModules/BotExplorationOps.py（621 行）逐函数移植到 JS。
 *
 * 这一块管的是「地图上还有没看见的地方，要不要派人去看一眼，以及往哪看」：
 * 迷雾里将军可能在的格子 → 挑起点 → 走一条揭示覆盖最大的路线；
 * 另外还有侧翼被打之前的那几种「视野扩张」小招。
 *
 * 为什么单独成文件：这些函数只吃 bot 对象上的字段，摘出来之后 Python 与 JS
 * 能拿同一份输入逐函数对拍；放进主循环里就再也拆不开了。
 *
 * 约定：第一个参数永远是 bot（鸭子类型），函数名与参数顺序照原版 snake_case。
 *
 * 依赖现状（原版有、这里没有的，以及替代路径）：
 *  1. `WatchmanRouteUtils.get_watchman_path` /
 *     `get_revealed_count_and_max_kill_turns_and_positive_path` 没移植 →
 *     走注入：bot.hooks.<name> 或 EK.ExplorationHooks.<name>。
 *     取不到就按原版「算不出路径」的分支返回 None，不编一条假路线。
 *  2. `BotCombatQueries.get_largest_tiles_as_armies` 没移植 → 同样走注入。
 *  3. `BotTimings` 没移植 → 本地读 bot.timings 上的同名字段，缺字段用
 *     cycleTurns=50、turn%50 兜底（与 expansionops.js 的兜底一致）。
 *  4. `BotRendering.mark_tile` / `ViewInfo.color_path` / `PathColorer` 只影响画面，
 *     直接丢弃；`viewInfo.add_info_line` 有就写、没有就跳过。
 *  5. `BotDefense._get_flank_defense_leafmove` / `_get_flank_vision_defense_move_internal`
 *     没移植 → 派发到 EK.BotDefense，缺函数返回 None。
 *  6. `BotCityOps.get_quick_kill_on_enemy_cities` 没移植 → 派发，缺函数返回 None。
 *  7. `BotDefenseQueries.*` 已并进 defense.js，用 EK.BotDefense 的同名函数。
 *  8. `WinCondition.ContestEnemyCity` 在 JS 侧是字符串化的可行胜利条件集合，见 vwc_has()。
 *
 * 数值语义照 Python：`//` 用 py_floor_div（负数向下取整），int() 用 Math.trunc。
 * 内存：本模块不跨回合缓存任何东西，所有临时 Set / 数组都在函数返回后即可回收。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /* ---------------- 收口层 ---------------- */

  // 原版到处是 bot._map，JS 侧 botmain 同时暴露 map 与 _map，取到哪个用哪个
  function bm(bot) {
    return (bot && (bot.map || bot._map)) || null;
  }

  function player_of(tile) {
    if (tile === null || tile === undefined) return -1;
    return typeof tile.player === 'function' ? tile.player() : tile._player;
  }

  // Python `a // b`：向下取整
  function py_floor_div(a, b) {
    return Math.floor(a / b);
  }

  function len_of(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v.size === 'number') return v.size;
    if (typeof v.length === 'number') return v.length;
    return 0;
  }

  function has_of(container, x) {
    if (container === null || container === undefined) return false;
    if (typeof container.has === 'function') return container.has(x);
    if (typeof container.indexOf === 'function') return container.indexOf(x) !== -1;
    return false;
  }

  function copy_tile_set(s) {
    var out = new Set();
    if (s === null || s === undefined) return out;
    if (typeof s.forEach === 'function') {
      s.forEach(function (v) {
        out.add(v);
      });
    }
    return out;
  }

  // Tile -> bool 的 MapMatrixSet：原版 `tile in matrix`
  function mat_has(mat, tile) {
    if (mat === null || mat === undefined || tile === null || tile === undefined) return false;
    if (typeof mat.has === 'function') return !!mat.has(tile);
    if (mat.raw) return !!mat.raw[tile.tile_index];
    return false;
  }

  // Tile -> number 的 MapMatrix：原版 mat[tile]
  function mat_at(mat, tile) {
    if (mat === null || mat === undefined) return null;
    var v = mat.raw ? mat.raw[tile.tile_index] : mat[tile.tile_index];
    return v === undefined ? null : v;
  }

  function info(bot, msg) {
    if (bot && typeof bot.info === 'function') bot.info(msg);
  }

  function add_info_line(bot, msg) {
    if (bot && bot.viewInfo && typeof bot.viewInfo.add_info_line === 'function') {
      bot.viewInfo.add_info_line(msg);
    }
  }

  // 记录降级过哪些外部依赖，方便上层一局结束后一次性报出来；条数受依赖个数限制
  var MISSING = new Set();

  function note_missing(name) {
    MISSING.add(name);
  }

  // 仓库里注入函数的注册表是 EK.ExpandHooks（expandhooks.js 建立，expansionops 也读它）；
  // bot.hooks / EK.ExplorationHooks 只是逃生口，别只查后者否则每次都判成缺失
  function hooks_registry(bot) {
    if (bot && bot.hooks) return bot.hooks;
    if (EK.ExpandHooks) return EK.ExpandHooks;
    return EK.ExplorationHooks || null;
  }

  function hook(bot, name) {
    var h = hooks_registry(bot);
    if (h && typeof h[name] === 'function') return h[name];
    return null;
  }

  function call_hook(bot, name, fallback, args) {
    var f = hook(bot, name);
    if (f === null) {
      note_missing('hook.' + name);
      return fallback;
    }
    var h = hooks_registry(bot);
    return f.apply(h, [bot].concat(args || []));
  }

  // 有些依赖已经是本仓库的模块（watchman 就是），那就别逼上层再注册一遍 hook：
  // 先问 hook，没有就直接调 EK.<module>.<name>，两边都没有才算缺失
  function call_hook_or_module(bot, name, moduleName, args, fallback) {
    if (hook(bot, name) !== null) return call_hook(bot, name, fallback, args);
    var mod = EK[moduleName];
    if (!mod || typeof mod[name] !== 'function') {
      note_missing('hook.' + name);
      return fallback;
    }
    return mod[name].apply(mod, args || []);
  }

  // 派发到 EK.<ns>.<fn>，缺函数时降级而不是抛
  function call_ns(ns, fn, fallback, args) {
    var mod = EK[ns];
    if (!mod || typeof mod[fn] !== 'function') {
      note_missing(ns + '.' + fn);
      return fallback;
    }
    return mod[fn].apply(mod, args || []);
  }

  function cycle_turns(bot) {
    var t = bot && bot.timings;
    if (t && typeof t.cycleTurns === 'number') return t.cycleTurns;
    return 50;
  }

  function turn_in_cycle(bot, turn) {
    var t = bot && bot.timings;
    if (t && typeof t.get_turn_in_cycle === 'function') return t.get_turn_in_cycle(turn);
    return turn % cycle_turns(bot);
  }

  function turns_left_in_cycle(bot, turn) {
    var t = bot && bot.timings;
    if (t && typeof t.get_turns_left_in_cycle === 'function') return t.get_turns_left_in_cycle(turn);
    return cycle_turns(bot) - turn_in_cycle(bot, turn);
  }

  function remaining_move_time(bot) {
    var t = bot && bot.timings;
    if (t && typeof t.get_remaining_move_time === 'function') return t.get_remaining_move_time(bot);
    if (bot && typeof bot._get_remaining_move_time === 'function') return bot._get_remaining_move_time();
    return 0;
  }

  function distance_from_general(bot, tile) {
    if (bot && typeof bot.distance_from_general === 'function') return bot.distance_from_general(tile);
    return call_ns('BotPathingUtils', 'distance_from_general', 0, [bot, tile]);
  }

  // WinCondition.ContestEnemyCity：JS 侧可行胜利条件存的是字符串，兼容枚举数值
  function vwc_has(bot, name) {
    var wca = bot && bot.win_condition_analyzer;
    if (!wca) return false;
    var vwc = wca.viable_win_conditions;
    if (!vwc) return false;
    if (has_of(vwc, name)) return true;
    if (EK.WinCondition && typeof EK.WinCondition[name] !== 'undefined') {
      return has_of(vwc, EK.WinCondition[name]);
    }
    return false;
  }

  function army_tracker(bot) {
    return (bot && (bot.armyTracker || bot.army_tracker)) || null;
  }

  function expansion_plan(bot) {
    return (bot && bot.expansion_plan) || null;
  }

  // 原版 Path 至少两格；JS 侧 tail 可能是 null（空路径 / 只有起点），
  // 下游所有 `pathToCheck.tail.tile` 都靠这个收口，免得把 null 传给 gather 之类的模块
  function path_tail_tile(path) {
    if (!path || !path.tail) return null;
    return path.tail.tile || null;
  }

  function is_tile(t) {
    return !!t && typeof t.tile_index === 'number' && typeof t.player === 'function';
  }

  var BotExplorationOps = {};

  /* ---------------- 侧翼：超小心流扩张 ---------------- */

  BotExplorationOps._try_get_super_careful_flank_flow_expansion_move = function (bot, pathToCheck, turns) {
    var startTiles = pathToCheck.convert_to_dist_dict(0 - pathToCheck.length);

    var swampKeys = [];
    startTiles.forEach(function (val, t) {
      var swampy = t.isSwamp;
      if (!swampy) {
        for (var i = 0; i < t.movable.length; i++) {
          if (t.movable[i].isSwamp) {
            swampy = true;
            break;
          }
        }
      }
      if (swampy) swampKeys.push(t);
    });
    for (var s = 0; s < swampKeys.length; s++) startTiles.delete(swampKeys[s]);

    var collection = bot && bot.last_flow_opt_collection;
    if (startTiles.size === 0 || collection === null || collection === undefined) {
      info(bot, 'could not find a super careful flank gath move');
      return null;
    }

    var options = collection.expansion_options || [];
    var bestOption = null;
    var bestValuePerTurn = 0.0;
    for (var o = 0; o < options.length; o++) {
      var flowOption = options[o];
      if (flowOption.requiredDelay > 0 || flowOption.length > turns) continue;
      var overlap = false;
      startTiles.forEach(function (val, t) {
        if (has_of(flowOption.tileSet, t)) overlap = true;
      });
      if (!overlap) continue;
      var move = flowOption.get_first_move();
      if (move === null || move === undefined) continue;
      if (call_ns('BotPathingUtils', 'is_move_safe_valid', false, [bot, move]) !== true) continue;
      var valuePerTurn = flowOption.econValue / Math.max(flowOption.length, 1);
      if (bestOption === null || valuePerTurn > bestValuePerTurn) {
        bestOption = flowOption;
        bestValuePerTurn = valuePerTurn;
      }
    }

    if (bestOption === null) {
      info(bot, 'could not find a super careful flank gath move');
      return null;
    }

    return bestOption.get_first_move();
  };

  /* ---------------- 迷雾探索主搜索 ---------------- */

  BotExplorationOps.get_optimal_exploration = function (
    bot,
    turns,
    negativeTiles,
    valueFunc,
    priorityFunc,
    initFunc,
    skipFunc,
    minArmy,
    maxTime,
    emergenceRatio,
    includeCities
  ) {
    void turns;
    void valueFunc;
    void priorityFunc;
    void initFunc;
    void skipFunc;
    void minArmy;
    if (negativeTiles === undefined) negativeTiles = null;
    if (emergenceRatio === undefined) emergenceRatio = 0.15;

    var at = army_tracker(bot);
    if (includeCities === undefined || includeCities === null) {
      var perfectCities = at && typeof at.has_perfect_information_of_player_cities === 'function'
        ? at.has_perfect_information_of_player_cities(bot.targetPlayer)
        : false;
      includeCities = !perfectCities && vwc_has(bot, 'ContestEnemyCity');
    }

    var toReveal = call_ns('BotTargeting', 'get_target_player_possible_general_location_tiles_sorted', [],
      [bot, 0, bot.targetPlayer, emergenceRatio, includeCities, undefined, true]);
    if (toReveal === null || toReveal === undefined) toReveal = [];

    // 原版先算威胁军队量再判空，顺序保留（determine_fog_defense_amount_available_for_tiles 有副作用之外无依赖）
    var targetArmyLevel = call_ns('BotDefense', 'determine_fog_defense_amount_available_for_tiles', 0,
      [bot, toReveal, bot.targetPlayer]);

    if (toReveal.length === 0) return null;

    var map = bm(bot);
    var expectedGen = bot.targetPlayerExpectedGeneralLocation;
    var startArmies = call_hook(bot, 'get_largest_tiles_as_armies', [], [bot.general.player(), 3]);
    if (!startArmies || startArmies.length === 0) return null;

    // Python 的 sorted 稳定：同距离保持原顺序，所以带上下标兜底
    var keyed = [];
    for (var i = 0; i < startArmies.length; i++) {
      keyed.push({
        a: startArmies[i],
        d: expectedGen === null || expectedGen === undefined ? 0 : map.get_distance_between(expectedGen, startArmies[i].tile),
        i: i,
      });
    }
    keyed.sort(function (x, y) {
      if (x.d !== y.d) return x.d - y.d;
      return x.i - y.i;
    });

    var bestArmy = null;
    var bestThresh = null;
    for (var k = 0; k < keyed.length; k++) {
      var startArmy = keyed[k].a;
      if (negativeTiles && has_of(negativeTiles, startArmy.tile)) continue;
      var armyDiff = startArmy.value - targetArmyLevel;
      var dist = keyed[k].d;
      if (dist <= 0) dist = 1;
      var thisThresh = armyDiff <= 0 ? 0 - dist + armyDiff : armyDiff / dist;
      if (bestArmy === null || bestThresh < thisThresh) {
        bestThresh = thisThresh;
        bestArmy = startArmy;
      }
    }
    if (bestArmy === null) return null;

    var startTile = bestArmy.tile;
    if (maxTime === undefined || maxTime === null) maxTime = remaining_move_time(bot) / 2;

    var path = call_hook_or_module(bot, 'get_watchman_path', 'Watchman',
      [map, startTile, toReveal, maxTime], null);
    if (path === null || path === undefined || path.length === 0) return null;

    var revealRes = call_hook_or_module(bot, 'get_revealed_count_and_max_kill_turns_and_positive_path',
      'Watchman', [map, path, toReveal, targetArmyLevel], null);
    if (revealRes === null || revealRes === undefined) return null;

    // Python 返回 6 元组；注入实现可以给数组或对象，两种都认
    var bestRevealedPath = null;
    if (Array.isArray(revealRes)) bestRevealedPath = revealRes.length > 5 ? revealRes[5] : null;
    else if (revealRes.bestRevealedPath !== undefined) bestRevealedPath = revealRes.bestRevealedPath;
    else if (revealRes.positivePath !== undefined) bestRevealedPath = revealRes.positivePath;

    return bestRevealedPath === undefined ? null : bestRevealedPath;
  };

  /* ---------------- AFK 玩家的抢收 ---------------- */

  BotExplorationOps.get_move_if_afk_player_situation = function (bot) {
    var map = bm(bot);
    var afkPlayers = call_ns('BotTargeting', 'get_afk_players', null, [bot]);
    var allOtherPlayersAfk = len_of(afkPlayers) + 1 === map.remainingPlayers;
    var numTilesVisible = 0;
    if (bot.targetPlayer !== -1) numTilesVisible = len_of(map.players[bot.targetPlayer].tiles);

    if (allOtherPlayersAfk && numTilesVisible === 0) {
      var path = BotExplorationOps.get_optimal_exploration(bot, 30, null, undefined, undefined, undefined, undefined, 0, 0.04);
      if (path !== null && path !== undefined) {
        info(bot, 'Rapid EXPLORE due to AFK player ' + bot.targetPlayer);
        bot.finishing_exploration = true;
        add_info_line(bot, 'Setting finishingExploration to True because allOtherPlayersAfk and found an explore path');
        return call_ns('BotPathingUtils', 'get_first_path_move', null, [bot, path]);
      }

      var expansionNegatives = new Set();
      var territoryMap = bot.territories ? bot.territories.territoryMap : null;
      if (bot.teammate_general !== null && bot.teammate_general !== undefined) expansionNegatives.add(bot.teammate_general);

      var plan = null;
      if (EK.ExpandUtils && typeof EK.ExpandUtils.get_round_plan_with_expansion === 'function') {
        plan = EK.ExpandUtils.get_round_plan_with_expansion(
          map,
          bot.general.player(),
          bot.targetPlayer,
          15,
          bot.board_analysis,
          territoryMap,
          bot.tileIslandBuilder,
          {
            negativeTiles: expansionNegatives,
            leafMoves: bot.captureLeafMoves,
            allowLeafMoves: false,
            includeExpansionSearch: true,
            viewInfo: bot.viewInfo,
            time_limit: 0.03,
          }
        );
      } else {
        note_missing('ExpandUtils.get_round_plan_with_expansion');
      }

      path = plan ? plan.selected_option : null;
      if (path !== null && path !== undefined) {
        bot.finishing_exploration = true;
        info(bot, 'Rapid EXPAND due to AFK player ' + bot.targetPlayer);
        return call_ns('BotPathingUtils', 'get_first_path_move', null, [bot, path]);
      }
    }

    if (bot.targetPlayer !== -1) {
      var tp = bot.targetPlayerObj;
      if (tp && tp.leftGame && map.turn < tp.leftGameTurn + 50) {
        var remainingTurns = tp.leftGameTurn + 50 - map.turn;
        var genOut = tp.general !== null && tp.general !== undefined && tp.general.army + py_floor_div(remainingTurns, 2) < 42;
        // 目标将位置未知时不进 gather：把 null 塞进 startTiles 会让下游 MST 拿到非 Tile
        if ((tp.tileCount > 10 || tp.cityCount > 1 || genOut) && is_tile(bot.targetPlayerExpectedGeneralLocation)) {
          var turns = Math.max(8, remainingTurns - 15);
          var move = call_ns('BotGatherOps', 'timing_gather', null,
            [bot, [bot.targetPlayerExpectedGeneralLocation], null, null, true, null, turns, undefined, undefined, true]);
          if (move !== null && move !== undefined) {
            info(bot, 'quick-kill gather to opposing player who left!');
            return move;
          }
        }
      }

      if (allOtherPlayersAfk && is_tile(bot.targetPlayerExpectedGeneralLocation) &&
          bot.targetPlayerExpectedGeneralLocation.isGeneral) {
        var move2 = call_ns('BotGatherOps', 'timing_gather', null,
          [bot, [bot.targetPlayerExpectedGeneralLocation], null, null, true, null, undefined, undefined, undefined, true]);
        if (move2 !== null && move2 !== undefined) {
          info(bot, 'quick-kill gather to opposing player!');
          return move2;
        }
      }
    }

    return null;
  };

  /* ---------------- 侧翼防守 ---------------- */

  BotExplorationOps.find_flank_defense_move = function (bot, defenseCriticalTileSet, highPriority) {
    if (highPriority === undefined) highPriority = false;
    var board = bot.board_analysis;
    var pathToCheck = bot.sketchiest_potential_inbound_flank_path;

    if (bot.enemy_attack_path !== null && bot.enemy_attack_path !== undefined && bot.likely_kill_push) {
      info(bot, '~~risk threat - replacing flank with risk threat BC likely_kill_push');
      pathToCheck = bot.enemy_attack_path;
    } else if (call_ns('BotTargeting', 'is_ffa_situation', false, [bot]) === true) {
      bump('flank:ffa');
      return null;
    }

    var checkFlank = false;
    if (pathToCheck !== null && pathToCheck !== undefined) {
      var checkTail = path_tail_tile(pathToCheck);
      checkFlank = checkTail !== null && board
        ? (mat_has(board.flank_danger_play_area_matrix, checkTail) ||
           mat_has(board.core_play_area_matrix, checkTail))
        : false;
    }

    if (pathToCheck !== null && pathToCheck !== undefined) {
      pathToCheck = pathToCheck.get_subsegment_excluding_trailing_visible();
      // 全是可见格时子段会退化成空路径，后面的 tail.tile 就没意义了
      if (path_tail_tile(pathToCheck) === null) pathToCheck = null;
    }

    var coreNegs = copy_tile_set(defenseCriticalTileSet);
    var wca = bot.win_condition_analyzer;
    if (wca) {
      copy_tile_set(wca.defend_cities).forEach(function (t) {
        coreNegs.add(t);
      });
      copy_tile_set(wca.contestable_cities).forEach(function (t) {
        coreNegs.add(t);
      });
    }

    if (highPriority && pathToCheck !== null && pathToCheck !== undefined) {
      var ot = bot.opponent_tracker;
      var winningMassivelyOnArmy = ot.winning_on_army(1.4) && ot.winning_on_economy(1.15);
      var winningMassivelyOnEcon = ot.winning_on_army(1.1) && ot.winning_on_economy(1.4);
      var winningInTheMiddle = ot.winning_on_army(1.25) && ot.winning_on_economy(1.05, undefined, undefined, -25);
      var winningByEnoughToBeSuperCareful = winningMassivelyOnArmy || winningMassivelyOnEcon || winningInTheMiddle;

      var sp = bot.shortest_path_to_target_player;
      var flankTile = path_tail_tile(pathToCheck);
      var flankIsCloserThanThreeFifths = flankTile !== null &&
        distance_from_general(bot, flankTile) < py_floor_div(3 * (sp ? sp.length : 0), 5);
      if (winningByEnoughToBeSuperCareful && flankIsCloserThanThreeFifths) {
        if (bot.likely_kill_push) {
          info(bot, 'bypassing superCareful flank gath because we think a kill push is incoming');
          return null;
        }
        var turns = 3 + ((turns_left_in_cycle(bot, bm(bot).turn) + 1) % 4);
        var move = BotExplorationOps._try_get_super_careful_flank_flow_expansion_move(bot, pathToCheck, turns);
        if (move) return move;
      }

      return null;
    }

    if (call_ns('BotStateQueries', 'is_still_ffa_and_non_dominant', false, [bot]) === true) {
      bump('flank:still_ffa');
      return null;
    }

    var leafMove = BotExplorationOps._get_vision_expanding_available_move(bot, coreNegs, pathToCheck);
    if (leafMove !== null && leafMove !== undefined) return leafMove;
    bump('flank:no_vision_leaf');

    if (!checkFlank) { bump('flank:not_checkflank'); return null; }

    leafMove = call_ns('BotDefense', '_get_flank_defense_leafmove', null, [bot, pathToCheck, coreNegs]);
    if (leafMove !== null && leafMove !== undefined) {
      info(bot, 'LEAF proactive flank vision defense');
      return leafMove;
    }
    bump('flank:defense_null');

    // 已经被扩张计划覆盖的起点不该再当侧翼防守的落点
    var negs = copy_tile_set(coreNegs);
    var ep = expansion_plan(bot);
    var allPaths = ep ? ep.all_paths || [] : [];
    for (var i = 0; i < allPaths.length; i++) {
      var fm = allPaths[i].get_first_move ? allPaths[i].get_first_move() : null;
      if (fm !== null && fm !== undefined && fm.source.delta && fm.source.delta.armyDelta === 0) {
        negs.add(fm.source);
      }
    }

    var atDist = board ? board.within_flank_danger_play_area_threshold : 4;
    var flankDefMove = call_ns('BotDefense', '_get_flank_vision_defense_move_internal', null,
      [bot, pathToCheck, negs, atDist]);
    if (flankDefMove !== null && flankDefMove !== undefined) {
      info(bot, 'proactive flank vision defense');
      return flankDefMove;
    }

    flankDefMove = call_ns('BotDefense', '_get_flank_vision_defense_move_internal', null,
      [bot, pathToCheck, coreNegs, atDist]);
    if (flankDefMove !== null && flankDefMove !== undefined) {
      info(bot, 'No exp negs proactive flank vision defense');
      return flankDefMove;
    }

    return null;
  };

  /* ---------------- 敌占区探索 ---------------- */

  BotExplorationOps.explore_target_player_undiscovered = function (bot, negativeTiles, onlyHuntGeneral, maxTime) {
    if (onlyHuntGeneral === undefined) onlyHuntGeneral = null;
    if (maxTime === undefined) maxTime = null;
    var negs = negativeTiles ? copy_tile_set(negativeTiles) : negativeTiles;

    var map = bm(bot);
    if (map.turn < 50 || bot.targetPlayer === -1) return null;

    var at = army_tracker(bot);
    var turnInCycle = turn_in_cycle(bot, map.turn);
    var exploringUnknown = map.generals[bot.targetPlayer] === null || map.generals[bot.targetPlayer] === undefined;

    var genPlayer = map.players[bot.general.player()];
    var behindOnCities = genPlayer.cityCount < map.players[bot.targetPlayer].cityCount;

    if (call_ns('BotStateQueries', 'is_all_in', false, [bot]) !== true) {
      if (bot.explored_this_turn) return null;
      if (!bot.finishing_exploration && behindOnCities) return null;
    }

    var enGenPositions = at ? at.valid_general_positions_by_player[bot.targetPlayer] : null;
    if (!enGenPositions) return null;

    var tpObj = bot.targetPlayerObj;
    if (at && tpObj) {
      for (var p = 0; p < map.players.length; p++) {
        var player = map.players[p];
        if (!player.dead && player.team === tpObj.team && player.index !== bot.targetPlayer) {
          var other = at.valid_general_positions_by_player[player.index];
          // MapMatrixSet 没有 copy()，原版这里是真复制（后续只读合并结果，不能污染 tracker 的矩阵）
          var merged = new EK.MapMatrixSet(map);
          for (var i = 0; i < other.raw.length; i++) {
            merged.raw[i] = !!(enGenPositions.raw[i] || other.raw[i]);
          }
          enGenPositions = merged;
        }
      }
    }

    if (onlyHuntGeneral === null) {
      onlyHuntGeneral = at && typeof at.has_perfect_information_of_player_cities === 'function'
        ? at.has_perfect_information_of_player_cities(bot.targetPlayer)
        : false;
    }

    if (onlyHuntGeneral) {
      // 只在找将军时，把「不可能是将军」的格子全拉黑；原版这里假定调用方一定传了 set
      if (!negs) negs = new Set();
      var allTiles = map.get_all_tiles();
      for (var a = 0; a < allTiles.length; a++) {
        var tile = allTiles[a];
        if (!map.is_tile_friendly(tile) && !enGenPositions.raw[tile.tile_index]) negs.add(tile);
      }
    }

    bot.explored_this_turn = true;
    var turns = cycle_turns(bot) - turnInCycle - 7;
    var minArmy = Math.max(12, Math.trunc(Math.pow(genPlayer.standingArmy, 0.75)) - 10);

    if (call_ns('BotStateQueries', 'is_all_in', false, [bot]) === true &&
        !bot.is_all_in_army_advantage && !bot.all_in_city_behind) {
      turns = 15;
      minArmy = Math.trunc(Math.pow(genPlayer.standingArmy, 0.83)) - 10;
    } else if (turns < 6) {
      turns = 5;
    } else if (turnInCycle < 6 && exploringUnknown) {
      turns = 6;
    }

    if (map.turn < 100) return null;

    var path = BotExplorationOps.get_optimal_exploration(bot, turns, negs, undefined, undefined, undefined,
      undefined, minArmy, maxTime);
    if (!path) return null;

    var tilesRevealed = new Set();
    var score = 0;
    var node = path.start;
    while (node !== null && node !== undefined) {
      var em = at && at.emergenceLocationMap ? at.emergenceLocationMap[bot.targetPlayer] : null;
      var emVal = em ? mat_at(em, node.tile) : null;
      if (!node.tile.discovered && emVal !== null && emVal > 0 &&
          (!onlyHuntGeneral || enGenPositions.raw[node.tile.tile_index])) {
        score += Math.pow(emVal, 0.5);
      }
      for (var j = 0; j < node.tile.adjacents.length; j++) {
        var adj = node.tile.adjacents[j];
        if (!adj.discovered && (!onlyHuntGeneral || enGenPositions.raw[adj.tile_index])) tilesRevealed.add(adj);
      }
      node = node.next;
    }

    var revealedPerMove = tilesRevealed.size / path.length;
    var scorePerMove = score / path.length;
    add_info_line(bot, 'hunting tilesRevealed ' + tilesRevealed.size + ' score ' + score + ' path.length ' + path.length);

    if ((revealedPerMove > 0.5 && scorePerMove > 4) ||
        (revealedPerMove > 0.8 && scorePerMove > 1) ||
        revealedPerMove > 1.5) {
      bot.finishing_exploration = true;
      info(bot, 'NEW hunting search turns ' + turns + ' minArmy ' + minArmy);
      return path;
    }

    return null;
  };

  /* ---------------- 探索招的总入口 ---------------- */

  BotExplorationOps.try_find_exploration_move = function (bot, defenseCriticalTileSet) {
    var map = bm(bot);
    var genPlayer = map.players[bot.general.player()];

    var largeTileThresh = (15 * genPlayer.standingArmy) / genPlayer.tileCount;

    var ot = bot.opponent_tracker;
    var demolishingTargetPlayer = ot.winning_on_army(1.5, false, bot.targetPlayer) &&
      ot.winning_on_economy(1.5, 10, bot.targetPlayer);

    var expectedGen = bot.targetPlayerExpectedGeneralLocation;
    var tpObj = bot.targetPlayerObj;
    var allInAndKnowsGenPosition =
      (bot.is_all_in_army_advantage || bot.all_in_losing_counter > py_floor_div(tpObj.tileCount, 3)) &&
      expectedGen !== null && expectedGen !== undefined && expectedGen.isGeneral &&
      !bot.all_in_city_behind;

    var targetPlayer = map.players[bot.targetPlayer];
    if (!targetPlayer) return null;
    var stillDontKnowAboutEnemyCityPosition = targetPlayer.cities.length + 1 < targetPlayer.cityCount;
    var stillHaveSomethingToSearchFor =
      (call_ns('BotStateQueries', 'is_all_in', false, [bot]) === true ||
       bot.finishing_exploration || demolishingTargetPlayer) &&
      (!(expectedGen && expectedGen.isGeneral) || stillDontKnowAboutEnemyCityPosition);

    if (!allInAndKnowsGenPosition && stillHaveSomethingToSearchFor && !bot.defend_economy) {
      var undiscNeg = copy_tile_set(defenseCriticalTileSet);

      if (bot.all_in_city_behind ||
          (bot.is_all_in_army_advantage && ot.winning_on_economy(0.8, 50))) {
        var cityPath = call_ns('BotCityOps', 'get_quick_kill_on_enemy_cities', null, [bot, defenseCriticalTileSet]);
        if (cityPath !== null && cityPath !== undefined) {
          info(bot, 'ALL IN ARMY ADVANTAGE CITY CONTEST');
          return call_ns('BotPathingUtils', 'get_first_path_move', null, [bot, cityPath]);
        }

        var ca = bot.cityAnalyzer || bot.city_analyzer;
        if (ca) {
          copy_tile_set(ca.owned_contested_cities).forEach(function (t) {
            undiscNeg.add(t);
          });
        }
      }

      var timeCap = allInAndKnowsGenPosition ? 0.06 : 0.03;

      add_info_line(bot, 'exp: unknownEnCity: ' + stillDontKnowAboutEnemyCityPosition);

      var myCities = map.players[bot.general.player()].cities;
      for (var c = 0; c < myCities.length; c++) undiscNeg.add(myCities[c]);

      if (bot.target_player_gather_path !== null && bot.target_player_gather_path !== undefined) {
        var halfTargetPath = bot.target_player_gather_path.get_subsegment(
          py_floor_div(bot.target_player_gather_path.length, 2));
        undiscNeg.add(bot.general);
        for (var t = 0; t < halfTargetPath.tileList.length; t++) undiscNeg.add(halfTargetPath.tileList[t]);
      }

      var path = BotExplorationOps.explore_target_player_undiscovered(bot, undiscNeg, undefined, timeCap);
      if (path === null || path === undefined) bump('explore_null');
      if (path !== null && path !== undefined) {
        var board = bot.board_analysis;
        var bMap = board && board.intergeneral_analysis ? board.intergeneral_analysis.bMap : null;
        if (call_ns('BotPathingUtils', 'is_path_moving_mostly_away', false, [bot, path, bMap]) !== true) {
          var valueSubsegment = call_ns('BotPathingUtils', 'get_value_per_turn_subsegment', path,
            [bot, path, undefined, 0]);
          if (valueSubsegment && valueSubsegment.length !== path.length) path = valueSubsegment;
          var move = call_ns('BotPathingUtils', 'get_first_path_move', null, [bot, path]);
          if (move !== null && move !== undefined) {
            if (call_ns('BotRepetition', 'detect_repetition', false, [bot, move, 7, 2]) !== true) {
              if (bot.is_all_in_army_advantage) bot.all_in_army_advantage_counter -= 2;
              return move;
            }
            bump('repetition');
            info(bot, 'bypassed hunting due to repetitions.');
          } else {
            bump('no_first_move');
          }
        } else {
          bump('moving_away');
          info(bot, 'IGNORING BAD HUNTING PATH BECAUSE MOVES AWAY FROM GEN APPROX');
        }
      }
    } else {
      bump('gate');
    }

    return null;
  };

  BotExplorationOps.try_get_enemy_territory_exploration_continuation_move = function (bot, defenseCriticalTileSet) {
    if (bot.targetPlayer === -1) return null;

    if (call_ns('BotStateQueries', 'is_all_in', false, [bot]) === true) {
      var path = BotExplorationOps.explore_target_player_undiscovered(bot, defenseCriticalTileSet, true);
      if (path !== null && path !== undefined) {
        info(bot, 'all-in exploration move...?');
        return call_ns('BotPathingUtils', 'get_first_path_move', null, [bot, path]);
      }
      return null;
    }

    var map = bm(bot);
    if (turns_left_in_cycle(bot, map.turn) < 42) return null;

    var at = army_tracker(bot);
    if (at && typeof at.has_perfect_information_of_player_cities_and_general === 'function' &&
        at.has_perfect_information_of_player_cities_and_general(bot.targetPlayer)) {
      return null;
    }

    var me = bot.player;
    var armyCutoff = 4 + 4 * Math.trunc(me.standingArmy / me.tileCount);
    if (bot.defend_economy) {
      armyCutoff *= 2;
      armyCutoff += 10;
    }

    var move = call_ns('BotExpansionOps', '_get_expansion_plan_exploration_move', null,
      [bot, armyCutoff, defenseCriticalTileSet]);

    if (move !== null && move !== undefined) {
      call_ns('BotExpansionOps', 'try_find_expansion_move', null, [bot, defenseCriticalTileSet, remaining_move_time(bot)]);
      move = call_ns('BotExpansionOps', '_get_expansion_plan_exploration_move', null,
        [bot, armyCutoff, defenseCriticalTileSet]);
      if (move !== null && move !== undefined) {
        info(bot, 'EN TERRITORY CONT EXP! armyCutoff ' + armyCutoff);
        return move;
      }
    }

    return null;
  };

  /* ---------------- 视野扩张（用现有叶子招去踩迷雾） ---------------- */

  BotExplorationOps._get_vision_expanding_available_move = function (bot, coreNegs, pathToCheckForVisionOf) {
    if (pathToCheckForVisionOf === undefined) pathToCheckForVisionOf = null;
    var bestWeighted = 3;
    var bestMove = null;
    var map = bm(bot);
    var board = bot.board_analysis;

    if (pathToCheckForVisionOf === null || pathToCheckForVisionOf === undefined) {
      pathToCheckForVisionOf = bot.sketchiest_potential_inbound_flank_path;
    }
    if (pathToCheckForVisionOf === null || pathToCheckForVisionOf === undefined) return null;

    var hidden = new Set();
    var tileList = pathToCheckForVisionOf.tileList;
    for (var i = 0; i < tileList.length; i++) if (!tileList[i].visible) hidden.add(tileList[i]);

    var ep = expansion_plan(bot);
    var planTiles = ep ? ep.plan_tiles : null;
    var alreadyInExpPlan = false;
    if (planTiles) {
      hidden.forEach(function (t) {
        if (has_of(planTiles, t)) alreadyInExpPlan = true;
      });
    }

    if (turn_in_cycle(bot, map.turn) >= 6 && !alreadyInExpPlan) return null;

    if (alreadyInExpPlan) {
      var lastNonVisibleTile = null;
      var lenWithFog = 0;
      for (var d = 0; d < tileList.length; d++) {
        if (!tileList[d].visible) {
          lastNonVisibleTile = tileList[d];
          lenWithFog = d;
        }
      }

      var ia = board ? board.intergeneral_analysis : null;
      var fullDist = lenWithFog + (ia ? mat_at(ia.aMap, lastNonVisibleTile) : 0);
      var midDist = py_floor_div(fullDist, 2);
      void midDist;
      var closestToMid = null;
      var closestToMidDist = 100000;

      var allPaths = ep ? ep.all_paths || [] : [];
      for (var p = 0; p < allPaths.length; p++) {
        var pp = allPaths[p];
        if (!(pp instanceof EK.Path)) continue;
        if ((pp.value > 10 || pp.length > 10 || (pp.length > 5 && pp.econValue / pp.length < 1.5)) &&
            !bot.is_all_in_army_advantage && !bot.is_winning_gather_cyclic && !bot.defend_economy) {
          continue;
        }
        if (bot.likely_kill_push && pp.length > 2) continue;

        var gatherPath = bot.target_player_gather_path;
        if ((gatherPath && has_of(gatherPath.tileSet, pp.start.tile)) ||
            pp.start.tile.isCity || pp.start.tile.isGeneral) {
          continue;
        }

        for (var h = 0; h < pp.tileList.length; h++) {
          var ht = pp.tileList[h];
          if (!hidden.has(ht)) continue;
          var tDist = Math.abs(mat_at(ia.aMap, ht) - mat_at(ia.bMap, ht));
          if (tDist < closestToMidDist) {
            closestToMid = pp;
            closestToMidDist = tDist;
          }
        }
      }

      if (closestToMid !== null) {
        var move = closestToMid.get_first_move();
        info(bot, 'EXP plan included vision expansion');
        bot.curPath = closestToMid;
        return move;
      }
    }

    if (turn_in_cycle(bot, map.turn) >= 6) return null;

    var leaves = bot.captureLeafMoves || [];
    for (var l = 0; l < leaves.length; l++) {
      var leafMove = leaves[l];
      if (leafMove.dest.isSwamp) continue;
      var dist = map.get_distance_between(bot.general, leafMove.dest);
      if (has_of(coreNegs, leafMove.source)) continue;

      var revealed = 0;
      var anyFog = false;
      for (var a = 0; a < leafMove.dest.adjacents.length; a++) {
        var adj = leafMove.dest.adjacents[a];
        if (!adj.discovered && player_of(adj) !== -1) revealed += 2;
        if (board && mat_has(board.flankable_fog_area_matrix, adj)) anyFog = true;
      }

      if (!anyFog || revealed === 0) continue;

      var weighted = dist + revealed;
      if (dist < 2 || weighted < bestWeighted) continue;
      bestMove = leafMove;
      bestWeighted = weighted;
    }

    if (bestMove !== null) info(bot, 'vision expansion leaf');
    return bestMove;
  };

  BotExplorationOps._missing_dependencies = function () {
    return Array.from(MISSING);
  };

  // GB_EXPLORE_DEBUG=1 时在进程退出打印一次降级清单与入口命中率；
  // 计数是有界小对象，与回合数无关，不会随对局增长。
  var STATS = { calls: 0, moves: 0, reasons: {}, by_name: {} };

  // GB_EXPLORE_DEBUG 的诊断计数：定位「入口被调用却总返回 null」的原因分布
  function bump(reason) {
    if (!process.env || !process.env.GB_EXPLORE_DEBUG) return;
    STATS.reasons[reason] = (STATS.reasons[reason] || 0) + 1;
  }

  if (typeof process !== 'undefined' && process.env && process.env.GB_EXPLORE_DEBUG) {
    process.on('exit', function () {
      console.error('[explorationops] degraded: ' + (Array.from(MISSING).join(', ') || '(none)'));
      console.error('[explorationops] entry calls ' + STATS.calls + ', returned move ' + STATS.moves);
      if (process.env.GB_EXPLORE_DEBUG) {
        console.error('[explorationops] reasons ' + JSON.stringify(STATS.reasons));
        console.error('[explorationops] by_name ' + JSON.stringify(STATS.by_name));
      }
    });
  }

  function entry_finished(name, move) {
    STATS.calls += 1;
    if (move !== null && move !== undefined) STATS.moves += 1;
    if (process.env && process.env.GB_EXPLORE_DEBUG) {
      var s = STATS.by_name[name] || (STATS.by_name[name] = { calls: 0, moves: 0 });
      s.calls += 1;
      if (move !== null && move !== undefined) s.moves += 1;
    }
    return move;
  }

  (function wrap_entries() {
    var names = [
      'try_find_exploration_move',
      'try_get_enemy_territory_exploration_continuation_move',
      'get_move_if_afk_player_situation',
      'find_flank_defense_move',
    ];
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        var orig = BotExplorationOps[name];
        if (typeof orig !== 'function') return;
        BotExplorationOps[name] = function () {
          return entry_finished(name, orig.apply(BotExplorationOps, arguments));
        };
      })(names[i]);
    }
  })();

  EK.BotExplorationOps = BotExplorationOps;
})(typeof window !== 'undefined' ? window : global);
