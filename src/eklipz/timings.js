/**
 * BotTimings.py 的 JS 移植（原版 E:\akcoco6de\_research\generals-bot-cs\BotModules\BotTimings.py，479 行）。
 *
 * 算法一句话：把「我们离目标多近、路上有多少敌方/中立/己方格、经济扩张要花多少回合、
 * 对手被灭周期的剩余回合」揉成一组每周期的阶段切点（cycleTurns / quickExpandTurns /
 * splitTurns / launchTiming），决定这回合是应该继续聚兵、扩张，还是发动总攻。
 *
 * 没移植的部分：
 *  - get_timings_old（原版 170-332 行）。全仓 grep 无任何调用者，是死代码。
 *  - BotPathingUtils.distance_from_general / get_undiscovered_count_on_path 等在 JS 侧已有同名实现，直接调。
 *  - 原版 SentryView / logbook / BotComms 的队友 ping（原版 get_timings 末尾的 send_teammate_communication
 *    在 1v1 里恒不触发；这边也不发）。
 *
 * 与墙钟的关系：只有 get_remaining_move_time 真的读时间，读的是 perf_timer 的已用毫秒，
 * 默认 now()=Date.now 只用于 perf_timer 缺失时兜底。其余所有决策都是回合数学，不依赖时钟。
 * random.randint(-2, 2) 保留为 BotTimings.rng（可注入），默认 Math.random —— 与 Python 全局 random 同语义。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  function mapOf(bot) { return bot._map || bot.map; }

  // 原版 Tile.player 是字段，JS 的 tile.player 是方法（tile.player()）。
  // 写成兼容两者，免得 General 这类壳对象半路换实现时静默取到函数本身。
  function playerOf(tile) {
    if (!tile) return -1;
    return typeof tile.player === 'function' ? tile.player() : tile.player;
  }

  function viewInfoOf(bot) { return bot.viewInfo || null; }

  function addInfo(bot, text) {
    var vi = viewInfoOf(bot);
    if (vi && typeof vi.add_info_line === 'function') vi.add_info_line(text);
  }

  function addStats(bot, text) {
    var vi = viewInfoOf(bot);
    if (vi && typeof vi.add_stats_line === 'function') vi.add_stats_line(text);
  }

  function botInfo(bot, text) {
    if (typeof bot.info === 'function') bot.info(text);
  }

  // Python 的 // 是向下取整，JS 的 / 是浮点；负数时两者不同（tileDiff 可能为负）。
  function floorDiv(a, b) { return Math.floor(a / b); }

  // Python 的 set.isdisjoint 在 JS 的 Set 上没有对应方法。
  function isDisjoint(setA, setB) {
    if (!setA || !setB) return true;
    var small = setA, large = setB;
    if (setA.size > setB.size) { small = setB; large = setA; }
    var hit = false;
    small.forEach(function (v) { if (large.has(v)) hit = true; });
    return !hit;
  }

  function teammatesOf(map) {
    if (map.teammates instanceof Set) return map.teammates;
    if (Array.isArray(map.teammates)) return new Set(map.teammates);
    return new Set();
  }

  // EK.search.count 只按 .length 下标遍历（数组专用），对 Set 会静默返回 0。
  // 原版这里数的是 map.pathable_tiles（Set），所以必须自带一个能走 Set 的版本。
  function countWhere(enumerable, filterFunc) {
    if (!enumerable) return 0;
    var matched = 0;
    if (typeof enumerable.length === 'number') {
      for (var i = 0; i < enumerable.length; i++) if (filterFunc(enumerable[i])) matched += 1;
      return matched;
    }
    enumerable.forEach(function (v) { if (filterFunc(v)) matched += 1; });
    return matched;
  }

  function pathLength(path) {
    return path && typeof path.length === 'number' ? path.length : 0;
  }

  // ---- Directives.py:47 Timings ----
  // 优先用宿主的实现（botmain.js 里那份是模块私有的，没导出，所以这里必须自带一份等价类）。
  function makeTimings(cycleTurns, quickExpandSplitTurns, splitTurns, launchTiming, offsetTurns, recalcTurn, disallowEnemyGather) {
    if (typeof EK.Timings === 'function') {
      return new EK.Timings(cycleTurns, quickExpandSplitTurns, splitTurns, launchTiming, offsetTurns, recalcTurn, disallowEnemyGather);
    }
    var t = {
      cycleTurns: cycleTurns,
      quickExpandTurns: quickExpandSplitTurns,
      splitTurns: splitTurns,
      offsetTurns: offsetTurns,
      launchTiming: launchTiming,
      nextRecalcTurn: recalcTurn,
      disallowEnemyGather: disallowEnemyGather,
      is_early_flank_launch: false
    };
    t.should_recalculate = function (turn) { return turn === this.nextRecalcTurn; };
    t.get_turn_in_cycle = function (turn) { return (turn + this.offsetTurns) % this.cycleTurns; };
    t.get_turns_left_in_cycle = function (turn) { return this.cycleTurns - (turn + this.offsetTurns) % this.cycleTurns; };
    t.in_quick_expand_split = function (turn) {
      var adjTurn = this.get_turn_in_cycle(turn);
      return adjTurn <= this.quickExpandTurns;
    };
    t.in_gather_split = function (turn) {
      var adjTurn = this.get_turn_in_cycle(turn);
      return adjTurn > this.quickExpandTurns && adjTurn < this.splitTurns;
    };
    t.in_expand_split = function (turn) { return this.get_turn_in_cycle(turn) >= this.splitTurns; };
    t.in_launch_split = function (turn) { return this.get_turn_in_cycle(turn) >= this.launchTiming; };
    t.in_launch_timing = function (turn) {
      var adjTurn = this.get_turn_in_cycle(turn);
      return adjTurn >= this.launchTiming && adjTurn - this.launchTiming < 5;
    };
    return t;
  }

  var BotTimings = {};

  // 原版 DebugHelper.IS_DEBUGGING 只在挂调试器时为真；这里固定假。
  BotTimings.IS_DEBUGGING = false;
  BotTimings.now = function () { return Date.now(); };
  // py BotTimings.py:389 是 `random.randint(-2, 2)`（走 getrandbits，不是 random()），
  // 所以这里默认接 EK.rng（MT19937 逐位复刻 random.seed(0)），对拍才能逐回合一致。
  BotTimings.rng = function () {
    var r = EK.rng;
    if (r && typeof r.random === 'function') return r.random();
    return Math.random();
  };
  BotTimings.randint = function (a, b) {
    var r = EK.rng;
    if (r && typeof r.randint === 'function') return r.randint(a, b);
    return a + Math.floor(Math.random() * (b - a + 1));
  };

  BotTimings.Timings = function (cycleTurns, quickExpandSplitTurns, splitTurns, launchTiming, offsetTurns, recalcTurn, disallowEnemyGather) {
    return makeTimings(cycleTurns, quickExpandSplitTurns, splitTurns, launchTiming, offsetTurns, recalcTurn, disallowEnemyGather);
  };

  // BotTimings.py:24
  BotTimings.is_player_aggressive = function (bot, player, turnPeriod) {
    var map = mapOf(bot);
    if (teammatesOf(map).has(player)) return false;

    var pObj = map.players[player];
    if (!pObj) return false;
    if (pObj.dead) return false;
    if (pObj.leftGame) return false;

    if (pObj.aggression_factor > 120) return true;

    return false;
  };

  // BotTimings.py:40
  BotTimings.set_all_in_cycle_to_hit_with_current_timings = function (bot, cycle, bufferTurnsEndOfCycle) {
    if (bufferTurnsEndOfCycle === undefined) bufferTurnsEndOfCycle = 5;
    var map = mapOf(bot);
    var timings = bot.timings;
    if (!timings) return;
    var turnsLeftInCurrentCycle = timings.cycleTurns - timings.get_turn_in_cycle(map.turn);
    bot.all_in_army_advantage_counter = cycle - turnsLeftInCurrentCycle + bufferTurnsEndOfCycle;
    bot.all_in_army_advantage_cycle = cycle;
  };

  // BotTimings.py:46
  BotTimings.get_opponent_cycle_stats = function (bot) {
    if (bot.targetPlayer === -1) return null;
    var ot = bot.opponent_tracker;
    if (!ot || typeof ot.get_current_cycle_stats_by_player !== 'function') return null;
    return ot.get_current_cycle_stats_by_player(bot.targetPlayer);
  };

  // BotTimings.py:53
  BotTimings.calculate_greedy_turns_available = function (bot) {
    var map = mapOf(bot);
    var gatherPath = bot.target_player_gather_path;
    if (bot.targetPlayer === -1 || gatherPath === null || gatherPath === undefined) {
      addStats(bot, 'Approx greedT: 5 early targetPath? target=' + bot.targetPlayer + ' path=' + (gatherPath !== null && gatherPath !== undefined));
      return 5;
    }

    if (bot.defend_economy) {
      addStats(bot, 'Approx greedT: 0 defend_economy');
      return 0;
    }

    var defensiveTiles = new Set(gatherPath.tileList || []);
    if (bot.defensive_spanning_tree) {
      var span = bot.defensive_spanning_tree;
      if (typeof span.forEach === 'function') span.forEach(function (t) { defensiveTiles.add(t); });
    }

    // 除防御链之外，还要把我们最大的一支攻击兵力算进防御盘（它离敌方将军近，本身就是筹码）。
    var largePlayerTiles = bot.largePlayerTiles;
    if (largePlayerTiles && typeof largePlayerTiles.length === 'number') {
      for (var i = 0; i < largePlayerTiles.length; i++) {
        var largeTile = largePlayerTiles[i];
        if (!defensiveTiles.has(largeTile)) { defensiveTiles.add(largeTile); break; }
      }
    }

    var combatOps = EK.BotCombatOps;
    if (!combatOps || typeof combatOps.sum_friendly_army_near_or_on_tiles !== 'function') {
      // 缺这个模块时只能退化成 5：宁可保守也不要把总攻时机算早。
      addStats(bot, 'Approx greedT: 5 missing BotCombatOps.sum_friendly_army_near_or_on_tiles');
      return 5;
    }
    var frArmy = combatOps.sum_friendly_army_near_or_on_tiles(bot, defensiveTiles, 0, playerOf(bot.general));

    var enArmyOffset = 0;
    if (bot.enemy_attack_path) {
      var enPathTiles = bot.enemy_attack_path.tileList || [];
      for (var e = 0; e < enPathTiles.length; e++) {
        var t = enPathTiles[e];
        if (t.visible && map.is_tile_on_team_with(t, bot.targetPlayer)) {
          enArmyOffset += t.army - 1;
        }
      }
    }

    var ot = bot.opponent_tracker;
    if (!ot || typeof ot.get_approximate_greedy_turns_available !== 'function') {
      addStats(bot, 'Approx greedT: 5 missing opponent_tracker.get_approximate_greedy_turns_available');
      return 5;
    }

    var prevGreed = bot.approximate_greedy_turns_avail;
    var approxGreedyTurnsAvail = ot.get_approximate_greedy_turns_available(
      bot.targetPlayer,
      frArmy + floorDiv(pathLength(bot.shortest_path_to_target_player), 2),
      enArmyOffset
    );

    var finalGreedTurnsAvail = approxGreedyTurnsAvail;
    if (approxGreedyTurnsAvail === prevGreed) {
      addInfo(bot, 'greed stayed same, decrementing by 1 from ' + approxGreedyTurnsAvail + ' to ' + finalGreedTurnsAvail);
      finalGreedTurnsAvail -= 1;
    } else if (approxGreedyTurnsAvail < prevGreed - 1) {
      addInfo(bot, 'GREED TURNS DROPPED FROM ' + prevGreed + ' TO ' + approxGreedyTurnsAvail);
    } else if (approxGreedyTurnsAvail > prevGreed) {
      if (approxGreedyTurnsAvail > prevGreed + 1) {
        addInfo(bot, 'greed increase from ' + prevGreed + ' to ' + approxGreedyTurnsAvail);
      } else {
        addInfo(bot, 'greed increase BY 1 from ' + prevGreed + ' to ' + approxGreedyTurnsAvail);
      }
    }

    addStats(bot, 'Approx greedT: ' + finalGreedTurnsAvail + ' (our def ' + frArmy + ' opp enArmyOffset ' + enArmyOffset + ' -> ' + approxGreedyTurnsAvail + ')');

    return finalGreedTurnsAvail;
  };

  // BotTimings.py:108
  BotTimings.prune_timing_split_if_necessary = function (bot) {
    var gatherPath = bot.target_player_gather_path;
    if (gatherPath === null || gatherPath === undefined) return;

    var targeting = EK.BotTargeting;
    if (targeting && typeof targeting.is_ffa_situation === 'function' && targeting.is_ffa_situation(bot)) {
      if (mapOf(bot).turn < 150) return;
    }

    var map = mapOf(bot);
    var timings = bot.timings;
    if (!timings) return;

    var splitTurn = timings.get_turn_in_cycle(map.turn);
    var gatherTileSet = gatherPath.tileSet || new Set();
    var genPlayerIdx = playerOf(bot.general);
    var tilesUngathered = countWhere(map.pathable_tiles, function (tile) {
      return tile.player() === genPlayerIdx
        && !gatherTileSet.has(tile)
        && tile.army > 1;
    });

    var player = map.players[genPlayerIdx];
    if (!player) return;
    if (tilesUngathered - player.cityCount - 1 < 1) {
      var timingAdjusted = splitTurn + tilesUngathered;
      if (timingAdjusted < timings.launchTiming) {
        addInfo(bot, 'Moving up launch timing from ' + timings.launchTiming + ' to splitTurn ' + splitTurn + ' + tilesUngathered ' + tilesUngathered + ' = (' + timingAdjusted + ')');
        timings.launchTiming = timingAdjusted;
        timings.splitTurns = timingAdjusted;
      }
    }
  };

  // BotTimings.py:134
  BotTimings.get_remaining_move_time = function (bot) {
    var map = mapOf(bot);
    var used = 0;
    if (bot.perf_timer && typeof bot.perf_timer.get_elapsed_since_update === 'function') {
      used = bot.perf_timer.get_elapsed_since_update(map.turn);
      if (typeof used !== 'number' || !isFinite(used)) used = 0;
    }
    var moveCycleTime = 0.5;
    var latencyBuffer = 0.3;
    var allowedLatest = moveCycleTime - latencyBuffer;
    var remaining = allowedLatest - used;
    if (BotTimings.IS_DEBUGGING) {
      return Math.max(remaining, 0.1);
    }
    return remaining;
  };

  // BotTimings.py:145
  BotTimings.timing_cycle_ended = function (bot) {
    var map = mapOf(bot);
    bot.is_winning_gather_cyclic = false;
    addInfo(bot, 'Timing cycle ended, turn ' + map.turn);
    bot.cities_gathered_this_cycle = new Set();
    bot.tiles_gathered_to_this_cycle = new Set();
    bot.tiles_captured_this_cycle = new Set();
    bot.tiles_evacuated_this_cycle = new Set();
    bot.city_expand_plan = null;
    bot.curPath = null;
    var player = map.players[playerOf(bot.general)];
    if (!player) return;
    var cityCount = player.cityCount;

    var citiesAvoided = 0;
    if (player.cityCount > 4) {
      // Python 的 sorted(key=army) 是稳定排序；JS 的 Array.sort 在现代 V8 上也是稳定排序。
      var cities = (player.cities || []).slice();
      cities.sort(function (a, b) { return a.army - b.army; });
      for (var i = 0; i < cities.length; i++) {
        if (citiesAvoided >= floorDiv(cityCount, 2) - 2) break;
        citiesAvoided += 1;
        addInfo(bot, 'AVOIDING CITY ' + cities[i]);
        bot.cities_gathered_this_cycle.add(cities[i]);
      }
    }

    bot.locked_launch_point = null;
    bot.flanking = false;
  };

  // BotTimings.py:335
  BotTimings.get_timings = function (bot) {
    var map = mapOf(bot);

    if (bot.perf_timer && typeof bot.perf_timer.begin_move_event === 'function') {
      bot.perf_timer.begin_move_event('GatherAnalyzer scan');
    }
    if (bot.gatherAnalyzer && typeof bot.gatherAnalyzer.scan === 'function') bot.gatherAnalyzer.scan();

    if (bot.target_player_gather_path === null || bot.target_player_gather_path === undefined) {
      if (typeof bot.recalculate_player_paths === 'function') bot.recalculate_player_paths(true);
    }

    var countFrOnPath = 0;
    var countEnOnPath = 0;
    var countNeutOnPath = 0;

    var launchTiming = 16;
    var gatherSplit = 16;

    var stateQueries = EK.BotStateQueries;
    function isStillFfaNonDominant() {
      return !!(stateQueries && typeof stateQueries.is_still_ffa_and_non_dominant === 'function'
        && stateQueries.is_still_ffa_and_non_dominant(bot));
    }

    if (isStillFfaNonDominant() && bot.targetPlayer !== -1) {
      gatherSplit = 32;
    }

    var timeOutsideLaunchAndGath = 0;

    var cycle = 50;
    var expValue = 20.0;
    var bypass = true;
    if (bot.expansion_plan !== null && bot.expansion_plan !== undefined
      && bot.target_player_gather_targets !== null && bot.target_player_gather_targets !== undefined) {
      bypass = false;
      expValue = bot.expansion_plan.cumulative_econ_value;
      var allPaths = bot.expansion_plan.all_paths || [];
      for (var oi = 0; oi < allPaths.length; oi++) {
        var opt = allPaths[oi];
        if (!(opt.length >= 1)) continue;
        if (opt.econValue / opt.length > 0.99 && isDisjoint(opt.tileSet, bot.target_player_gather_targets)) {
          timeOutsideLaunchAndGath += opt.length;
        }
      }
    }

    var gatherPath = bot.target_player_gather_path;
    var shortPathLen = pathLength(bot.shortest_path_to_target_player);
    if (gatherPath !== null && gatherPath !== undefined) {
      var pathTiles = gatherPath.tileList || [];
      for (var i = 0; i < pathTiles.length; i++) {
        var t = pathTiles[i];
        if (map.is_tile_friendly(t)) {
          countFrOnPath += 1;
        } else if (map.is_tile_on_team(t, bot.targetPlayer)) {
          countEnOnPath += 1;
        } else if (t.player() === -1) {
          countNeutOnPath += 1;
        }
      }
      cycle = 50;
      if (bot.timings !== null && bot.timings !== undefined) {
        cycle = bot.timings.cycleTurns;
      }
      launchTiming = cycle - shortPathLen - 1 + bot.behavior_launch_timing_offset;
      launchTiming += floorDiv(countEnOnPath, 2);
      launchTiming += floorDiv(countNeutOnPath, 2);
      launchTiming -= floorDiv(countFrOnPath, 2);

      var xPweight = Math.trunc(expValue * 0.5);
      var minExpWeighted = 32;
      var expGatherTiming = Math.max(15, Math.min(minExpWeighted, 50 - timeOutsideLaunchAndGath));
      gatherSplit = Math.min(launchTiming, expGatherTiming);
      if (!bypass) {
        addInfo(bot,
          'timingsBase: g' + gatherSplit + ' <- min(launch ' + launchTiming + ', max(15, min(' + minExpWeighted
          + ', 50-timeAv ' + timeOutsideLaunchAndGath + ' (' + (50 - timeOutsideLaunchAndGath) + '))), en'
          + countEnOnPath + ', fr' + countFrOnPath + ', nt' + countNeutOnPath + ', expW ' + xPweight);
      }
    }

    // Python random.randint(-2, 2) 是闭区间整数，且走 getrandbits ——
    // 用 rng()*5 取整会消耗不同的随机位，后面所有随机序列都会错位。
    var randomVal = BotTimings.randint(-2, 2);
    var pathingUtils = EK.BotPathingUtils;
    var spawnDist = 0;
    if (pathingUtils && typeof pathingUtils.distance_from_general === 'function') {
      spawnDist = pathingUtils.distance_from_general(bot, bot.targetPlayerExpectedGeneralLocation);
    }
    var longSpawns = gatherPath !== null && gatherPath !== undefined && spawnDist > 22;
    var genPlayer = map.players[playerOf(bot.general)];

    gatherSplit = Math.min(gatherSplit, genPlayer.tileCount - countFrOnPath);

    gatherSplit += randomVal;

    var quickExpandSplit = 0;

    if (bot.defend_economy) {
      gatherSplit += 2;
    }

    if (bot.currently_forcing_out_of_play_gathers) {
      gatherSplit += 2;
    }

    if (isStillFfaNonDominant()) {
      var oldGath = gatherSplit;
      gatherSplit = 38;

      if (bot.targetPlayer !== -1) {
        gatherSplit = 50 - shortPathLen;
      }

      if (bot.targetPlayer !== -1 && bot.targetPlayerObj && bot.targetPlayerObj.aggression_factor > 150) {
        gatherSplit = 50 - shortPathLen - 4;
      }

      botInfo(bot, 'FFA gath split adjust ' + oldGath + ' -> ' + gatherSplit);
    }

    var disallowEnemyGather = false;

    if (bot.flanking) {
      addInfo(bot, 'gathSplit flanking += ' + bot.behavior_flank_launch_timing_offset);
      gatherSplit += bot.behavior_flank_launch_timing_offset;
      launchTiming = gatherSplit;
    }

    if (bot.teammate_path !== null && bot.teammate_path !== undefined
      && gatherPath !== null && gatherPath !== undefined
      && gatherPath.start && gatherPath.start.tile === bot.teammate_general) {
      gatherSplit -= floorDiv(bot.teammate_path.length, 2) + 2;
      launchTiming = gatherSplit;
    }

    var isOurPathAMostlyFogAltPath = false;
    if (gatherPath !== null && gatherPath !== undefined) {
      var pathCheck = gatherPath;
      if (pathCheck.length > 25) {
        pathCheck = pathCheck.get_subsegment(25);
      }
      var numFog = 0;
      var numEn = 0;
      if (pathingUtils) {
        if (typeof pathingUtils.get_undiscovered_count_on_path === 'function') {
          numFog = pathingUtils.get_undiscovered_count_on_path(bot, pathCheck);
        }
        if (typeof pathingUtils.get_enemy_count_on_path === 'function') {
          numEn = pathingUtils.get_enemy_count_on_path(bot, pathCheck);
        }
      }
      if (numEn > 0 || gatherPath.length < 20) {
        var overage = 2 * numFog - floorDiv(pathCheck.length, 2) - numEn;
        if (overage > 0 && map.turn > 85 && numEn < floorDiv(pathCheck.length, 3)) {
          isOurPathAMostlyFogAltPath = true;
          if (!bypass) {
            addInfo(bot, 'launch reduc ' + overage + ' bc fog ' + numFog + ' vs pathlen ' + pathCheck.length);
          }
          launchTiming -= overage;
          gatherSplit -= overage;
        }
      }
    }

    // 路径长到把 launchTiming 压成负数时，只能把整个周期往后推，直到它回到正数。
    var guard = 0;
    while (launchTiming < 0 && guard < 1000) {
      botInfo(bot, 'increasing launch timing ' + launchTiming + ' by increasing cycle duration');
      cycle += 50;
      launchTiming += 50;
      gatherSplit += 50;
      guard += 1;
    }

    if (launchTiming > 32) {
      launchTiming = 32;
    }
    if (gatherSplit > 24) {
      gatherSplit = 24;
    }

    if (launchTiming < gatherSplit) {
      if (!bypass) {
        addInfo(bot, 'adjusting launchTiming (was ' + launchTiming + ') to be same as gatherSplit ' + gatherSplit + ', targetLen ' + shortPathLen);
      }
      launchTiming = gatherSplit;
    } else {
      if (!bypass) {
        addInfo(bot, 'launchTiming ' + launchTiming + ', targetLen ' + shortPathLen);
      }
    }

    var correction = map.turn % 50;
    if (launchTiming % 2 === 1) {
      launchTiming += 1;
    }
    var timings = makeTimings(cycle, quickExpandSplit, gatherSplit, launchTiming, 0, map.turn + cycle - correction, disallowEnemyGather);
    timings.is_early_flank_launch = isOurPathAMostlyFogAltPath;

    return timings;
  };

  EK.BotTimings = BotTimings;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
