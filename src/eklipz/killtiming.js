/**
 * BotKillTiming.py 的 JS 移植（原版 E:\akcoco6de\_research\generals-bot-cs\BotModules\BotKillTiming.py，205 行）。
 *
 * 算法一句话：当「经济上要输了、只能一波打死对手」这个判断成立时，先试聚兵直扑敌方将军估算位置，
 * 再退化到一条全军直推的 path；find_all_in_option 则对那条 path 做「路径攻击力 + 沿途支援 + 加成线」
 * 三项估价，跟「对手在我们推到的回合数内能变出的兵力」比较，超过才算这一波可行。
 *
 * 与原版的差异（都是 JS 侧依赖缺失导致的降级，不是逻辑简化）：
 *  - bot.win_condition_analyzer.projected_loss_all_in_active 在 JS 版恒为 false（WinConditionAnalyzer
 *    还没移植），所以 get_projected_loss_all_in_move 会在第一行就返回 null —— 这是忠实的：原版在
 *    active 为假时做的也是这件事。等 WCA 移植完成后本文件无需改动就能接上。
 *  - WCA 上没有 target_player 字段，_estimate_all_in_kill 里用 bot.targetPlayer 兜底。
 *  - logbook 的日志改成 bot.info；数值结果与日志文字无关。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  function mapOf(bot) { return bot._map || bot.map; }

  function botInfo(bot, text) {
    if (typeof bot.info === 'function') bot.info(text);
  }

  function pathLength(path) {
    return path && typeof path.length === 'number' ? path.length : 0;
  }

  // Python 的 Tile.__eq__ 比 tile_index，所以原版的 `tile == bot.general` 是值比较不是对象身份比较。
  function sameTile(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.tile_index === b.tile_index;
  }

  function wcaTargetPlayer(bot) {
    var wca = bot.win_condition_analyzer;
    if (wca && typeof wca.target_player === 'number') return wca.target_player;
    return bot.targetPlayer;
  }

  // StrategyModels / dataclass(slots=True)
  function AllInKillEstimate(path, pathAttackValue, supportAttackValue, lineBonusAttackValue, totalAttackValue, enemyGeneralEstimate, remainingCycleTurns, interGeneralDistance) {
    this.path = path;
    this.path_attack_value = pathAttackValue;
    this.support_attack_value = supportAttackValue;
    this.line_bonus_attack_value = lineBonusAttackValue;
    this.total_attack_value = totalAttackValue;
    this.enemy_general_estimate = enemyGeneralEstimate;
    this.remaining_cycle_turns = remainingCycleTurns;
    this.inter_general_distance = interGeneralDistance;
  }
  Object.defineProperty(AllInKillEstimate.prototype, 'is_viable', {
    get: function () { return this.total_attack_value > this.enemy_general_estimate; },
    enumerable: true,
    configurable: true
  });

  var BotKillTiming = {};
  BotKillTiming.AllInKillEstimate = AllInKillEstimate;

  // BotKillTiming.py:38
  BotKillTiming.get_projected_loss_all_in_move = function (bot, defenseCriticalTileSet) {
    var wca = bot.win_condition_analyzer;
    if (!wca || !wca.projected_loss_all_in_active) return null;

    var map = mapOf(bot);
    var altPositions = (bot.alt_en_gen_positions && bot.alt_en_gen_positions[bot.targetPlayer]) || [];
    if (altPositions.length > 6) {
      botInfo(bot, 'Skipping WCA projected-loss all-in gather because targetPlayer ' + bot.targetPlayer
        + ' has ' + altPositions.length + ' alt enemy general positions');
      return null;
    }

    if (bot.targetPlayerExpectedGeneralLocation !== null && bot.targetPlayerExpectedGeneralLocation !== undefined
      && !sameTile(wca.projected_loss_all_in_target, bot.targetPlayerExpectedGeneralLocation)) {
      botInfo(bot, 'Updating WCA projected-loss all-in target from ' + wca.projected_loss_all_in_target
        + ' to ' + bot.targetPlayerExpectedGeneralLocation);
      wca.projected_loss_all_in_target = bot.targetPlayerExpectedGeneralLocation;
    }

    var target = wca.projected_loss_all_in_target;
    if (target === null || target === undefined) return null;

    bot.curPath = null;

    var gatherOps = EK.BotGatherOps;
    var repetition = EK.BotRepetition;
    if (!gatherOps || typeof gatherOps.get_gather_to_target_tiles !== 'function') return null;

    if (bot.perf_timer && typeof bot.perf_timer.begin_move_event === 'function') {
      bot.perf_timer.begin_move_event('WCA projected-loss all-in gather');
    }

    var priorityMatrix = typeof gatherOps.get_gather_tiebreak_matrix === 'function'
      ? gatherOps.get_gather_tiebreak_matrix(bot)
      : null;

    var gatherRes = gatherOps.get_gather_to_target_tiles(
      bot,
      [target],
      0.05,
      map.remainingCycleTurns + 5,
      defenseCriticalTileSet,
      1,            // targetArmy
      false,        // useTrueValueGathered
      null,         // leafMoveSelectionValueFunc
      true,         // includeGatherTreeNodesThatGatherNegative
      true,         // maximizeArmyGatheredPerTurn
      null,         // additionalIncrement
      null,         // distPriorityMap
      priorityMatrix,
      null,         // skipTiles
      true          // shouldLog
    );

    var allInMove = gatherRes ? gatherRes[0] : null;
    var valueGathered = gatherRes ? gatherRes[1] : -1;
    var turnsUsed = gatherRes ? gatherRes[2] : -1;
    var gatherNodes = gatherRes ? gatherRes[3] : null;

    var isRepeat = allInMove !== null && allInMove !== undefined && repetition && typeof repetition.detect_repetition === 'function'
      ? repetition.detect_repetition(bot, allInMove)
      : false;
    if (allInMove !== null && allInMove !== undefined && !isRepeat) {
      botInfo(bot, 'Pass thru WCA projected-loss all-in gather! ' + allInMove + ' target ' + target
        + ' value ' + valueGathered + ' turns ' + turnsUsed);
      bot.gatherNodes = gatherNodes;
      return allInMove;
    }

    var allInPath = BotKillTiming._get_all_in_path(bot);
    if (allInPath !== null && allInPath !== undefined && allInPath.length <= map.remainingCycleTurns) {
      var fallbackMove = allInPath.get_first_move();
      var fbRepeat = fallbackMove !== null && fallbackMove !== undefined && repetition && typeof repetition.detect_repetition === 'function'
        ? repetition.detect_repetition(bot, fallbackMove)
        : false;
      if (fallbackMove !== null && fallbackMove !== undefined && !fbRepeat) {
        botInfo(bot, 'Pass thru WCA projected-loss all-in fallback path! ' + fallbackMove + ' ' + allInPath);
        return fallbackMove;
      }
    }

    return null;
  };

  // BotKillTiming.py:86
  BotKillTiming.find_all_in_option = function (bot) {
    if (bot.targetPlayer === -1) return null;
    if (bot.targetPlayerExpectedGeneralLocation === null || bot.targetPlayerExpectedGeneralLocation === undefined) return null;

    var path = BotKillTiming._get_all_in_path(bot);
    if (path === null || path === undefined) return null;

    var estimate = BotKillTiming._estimate_all_in_kill(bot, path);
    botInfo(bot, 'ALL_IN_KILL_TIMING turn=' + mapOf(bot).turn
      + ' path=' + path
      + ' pathAttack=' + estimate.path_attack_value
      + ' supportAttack=' + estimate.support_attack_value
      + ' lineBonusAttack=' + estimate.line_bonus_attack_value
      + ' totalAttack=' + estimate.total_attack_value
      + ' enemyGeneralEstimate=' + estimate.enemy_general_estimate
      + ' remainingCycleTurns=' + estimate.remaining_cycle_turns
      + ' interGeneralDistance=' + estimate.inter_general_distance
      + ' viable=' + estimate.is_viable);

    if (!estimate.is_viable) return null;

    return path;
  };

  // BotKillTiming.py:114
  BotKillTiming._get_all_in_path = function (bot) {
    var targeting = EK.BotTargeting;
    var pathing = EK.BotPathingUtils;

    if (targeting && typeof targeting.get_path_to_target_player === 'function') {
      var path = targeting.get_path_to_target_player(bot, true, null, bot.general);
      if (path !== null && path !== undefined) return path;
    }

    if (pathing && typeof pathing.get_path_to_target === 'function') {
      // 关键字参数按位置摆：maxTime / maxDepth 用默认（null），其余照原版传。
      return pathing.get_path_to_target(
        bot,
        bot.targetPlayerExpectedGeneralLocation,
        null,   // maxTime
        null,   // maxDepth
        false,  // skipNeutralCities（原版未传 → 默认）
        true,   // skipEnemyCities
        false,  // preferNeutral
        bot.general,
        false,  // preferEnemy
        null,   // maxObstacleCost
        true,   // avoidEnemyVision
        null    // avoidUsingExpandables
      );
    }

    return null;
  };

  // BotKillTiming.py:130
  BotKillTiming._estimate_all_in_kill = function (bot, path) {
    var map = mapOf(bot);
    var remainingCycleTurns = map.remainingCycleTurns;
    var interGeneralDistance = pathLength(path);

    var targetPlayer = wcaTargetPlayer(bot);
    var ot = bot.opponent_tracker;
    var targetTeam = ot && ot._team_lookup_by_player ? ot._team_lookup_by_player[targetPlayer] : -1;

    var enemyGeneralEstimate = 0;
    if (ot && typeof ot.get_fog_city_risk_in_turns_by_cycle_behavior === 'function') {
      enemyGeneralEstimate = ot.get_fog_city_risk_in_turns_by_cycle_behavior(
        targetPlayer,
        Math.max(0, pathLength(path)),
        1 // cityLimit
      );
    }

    var pathAttackValue = BotKillTiming._estimate_path_attack_value(bot, path);
    var supportAttackValue = BotKillTiming._estimate_near_path_support_attack_value(bot, path);
    var lineBonusAttackValue = BotKillTiming._estimate_post_bonus_line_attack_value(bot, path, remainingCycleTurns);
    var totalAttackValue = pathAttackValue + supportAttackValue + lineBonusAttackValue;

    return new AllInKillEstimate(
      path,
      pathAttackValue,
      supportAttackValue,
      lineBonusAttackValue,
      totalAttackValue,
      enemyGeneralEstimate,
      remainingCycleTurns,
      interGeneralDistance
    );
  };

  // BotKillTiming.py:168
  BotKillTiming._estimate_path_attack_value = function (bot, path) {
    var map = mapOf(bot);
    var expectedGeneral = bot.targetPlayerExpectedGeneralLocation;
    var attackValue = 0;
    var tileList = path.tileList || [];
    for (var i = 0; i < tileList.length; i++) {
      var tile = tileList[i];
      if (sameTile(tile, expectedGeneral)) continue;
      if (map.is_tile_friendly(tile)) {
        attackValue += Math.max(0, tile.army - 1);
      } else if (!tile.isObstacle) {
        attackValue -= tile.army;
      }
    }
    return Math.max(0, attackValue);
  };

  // BotKillTiming.py:180
  BotKillTiming._estimate_near_path_support_attack_value = function (bot, path) {
    var map = mapOf(bot);
    var expectedGeneral = bot.targetPlayerExpectedGeneralLocation;
    var pathSet = path.tileSet || new Set();
    var candidateTiles = new Set();
    var adj = path.adjacentSet;
    if (adj) {
      adj.forEach(function (tile) {
        if (!pathSet.has(tile)) candidateTiles.add(tile);
      });
    }

    var supportTiles = new Set();
    candidateTiles.forEach(function (tile) {
      if (sameTile(tile, expectedGeneral)) return;
      if (map.is_tile_friendly(tile) && tile.army > 1) {
        supportTiles.add(tile);
      }
    });

    var supportAttackValue = 0;
    supportTiles.forEach(function (tile) {
      supportAttackValue += Math.max(0, tile.army - 1);
    });
    return supportAttackValue;
  };

  // BotKillTiming.py:195
  BotKillTiming._estimate_post_bonus_line_attack_value = function (bot, path, remainingCycleTurns) {
    if (pathLength(path) > remainingCycleTurns) return 0;

    var expectedGeneral = bot.targetPlayerExpectedGeneralLocation;
    var lineAttackValue = 0;
    var tileList = path.tileList || [];
    for (var i = 0; i < tileList.length; i++) {
      var tile = tileList[i];
      if (sameTile(tile, bot.general) || sameTile(tile, expectedGeneral)) continue;
      lineAttackValue += 1;
    }
    return lineAttackValue;
  };

  EK.BotKillTiming = BotKillTiming;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
