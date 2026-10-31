/* Human.exe 的 BotModules/BotExpansionOps.py（2292 行）逐函数移植到 JS。
 *
 * 算法一句话：每回合给「扩张」这条线算一份带权地图，再从若干候选窗口里挑一条
 * 本轮收益最大的路径，取它的第一步交给上层当扩张动作。
 *
 * 为什么写成一个独立文件：这些函数只依赖 bot 对象上的字段，把它从 bot 主循环里
 * 摘出来之后，Python 与 JS 可以用同一份输入逐函数对拍。
 *
 * 约定：所有函数第一个参数都是 bot（鸭子类型），其余参数顺序、函数名保持原版
 * snake_case；缺字段一律本地 helper 兜住，绝不反过来改别的模块。
 * 数值语义照 Python：整除用 pyFloorDiv，`a // b` 对负数向下取整。
 *
 * 简化清单（原版有、这里没有的东西，以及替代路径）：
 *  1. `ExpandUtils.get_round_plan_with_expansion` / `EarlyExpandUtils.*` 整块上游没移植
 *     （它们是独立的搜索器，不属于本模块）。这里通过注入取用：
 *     bot.hooks.get_round_plan_with_expansion / bot.hooks.optimize_first_25 /
 *     bot.hooks.get_start_expand_captures / bot.hooks.recalculate_max_plan，
 *     或全局 EK.ExpandHooks 里的同名函数。取不到就按原版语义降级：
 *     build_expansion_plan 返回空 plan（selected_option=None），
 *     get_optimal_city_or_general_plan_move 返回 None。
 *  2. `BehaviorAlgorithms.FlowExpansion.ArmyFlowExpanderV2` 没移植 → 走
 *     bot.hooks.get_flow_expansion_options；没有就跳过该分支（等于本轮不开迭代流扩张）。
 *  3. `BotTargeting.is_ffa_situation` / `get_target_player_possible_general_location_tiles_sorted`
 *     / `_get_furthest_apart_3_enemy_general_locations` 没移植 → 本地按原版判据重写
 *     is_ffa_situation（看 map.players 的存活数与队伍关系），另两个走 bot.hooks，缺失返回 []。
 *  4. `BotComms` / `BotTimings` / `BotCombatOps` / `BotCityOps` / `BotDefenseQueries`
 *     / `BotRendering` / `WatchmanRouteUtils` / `WinCondition` 全部没移植：
 *     通信与渲染直接丢掉（对决策无影响，原版也只是发 ping / 画色）；
 *     timings 改成读 bot.timings 上的同名字段，缺字段用 cycleTurns=50 与
 *     turn%50 兜底；combatOps.check_for_attack_launch_move 走 hooks，缺失返回 None。
 *  5. `random.choice(sources)`（原版第 127 行选起点）在这里走 bot.rng.choice，
 *     没注入 rng 时取第一个（确定性优先；对拍时 oracle 用 random.seed(0) 固定）。
 *  6. 日志（logbook / bot.info / viewInfo）全部丢弃；`viewInfo` 参数保留在签名里只是为了
 *     对齐调用点，内部一律不碰。
 *  7. 死代码按原版照写但保持恒等：check_launch_against_expansion_plan 直接 return 入参、
 *     timing_expand 返回 None、try_gather_tendrils_towards_enemy 返回 None、
 *     look_for_ffa_turtle_move 恒 None（原版 neutCity 就是 None）。
 */
(function (root) {
  var EK = (root.__EK = root.__EK || {});

  function bm(bot) {
    return bot.map || bot._map;
  }

  // Python 的 `a // b`：向下取整，不是向零截断
  function pyFloorDiv(a, b) {
    var q = Math.floor(a / b);
    if (a % b !== 0 && (a < 0) !== (b < 0)) q = Math.floor(a / b);
    return q;
  }

  function hooks(bot) {
    if (bot && bot.hooks) return bot.hooks;
    if (EK.ExpandHooks) return EK.ExpandHooks;
    return {};
  }

  function hook(bot, name) {
    var h = hooks(bot);
    if (h && typeof h[name] === 'function') return h[name];
    return null;
  }

  function call_hook(bot, name, fallback) {
    var f = hook(bot, name);
    if (f === null) return fallback;
    var args = Array.prototype.slice.call(arguments, 3);
    return f.apply(hooks(bot), [bot].concat(args));
  }

  // 原版 map.is_tile_on_team_with(tile, player)
  function is_team_tile(map, tile, player) {
    return map.is_tile_on_team_with(tile, player);
  }

  function is_friendly(map, tile) {
    return map.is_tile_friendly(tile);
  }

  // 按 tile_index 升序：Python set 迭代序不可复现，凡是遍历集合都先排序
  // map.teammates 在 map.js 里是 Set（原版也是 set），调用点却当数组用；
  // 统一按 tile_index 无关的确定序（升序玩家号）折成数组
  function teammates_of(map) {
    var t = map ? map.teammates : null;
    if (!t) return [];
    var arr = Array.isArray(t) ? t.slice() : Array.from(t);
    arr.sort(function (a, b) { return a - b; });
    return arr;
  }

  function sorted_by_index(iterable) {
    var arr = Array.isArray(iterable) ? iterable.slice() : Array.from(iterable);
    arr.sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    return arr;
  }

  function pyPow(a, b) {
    return Math.pow(a, b);
  }

  // CPython heapq 的最小堆：并列时「相等不交换」，出堆序由堆结构决定。
  // 加序号 tie-break 会让并列键的出堆顺序跟 Python 分叉（gather 移植踩过一次）。
  function Heap() {
    this.queue = [];
  }

  Heap.prototype._pyLt = function (a, b) {
    return cmpAny(a, b) < 0;
  };

  Heap.prototype._siftdown = function (startpos, pos) {
    var newitem = this.queue[pos];
    while (pos > startpos) {
      var parentpos = (pos - 1) >> 1;
      var parent = this.queue[parentpos];
      if (this._pyLt(newitem, parent)) {
        this.queue[pos] = parent;
        pos = parentpos;
        continue;
      }
      break;
    }
    this.queue[pos] = newitem;
  };

  Heap.prototype._siftup = function (pos) {
    var endpos = this.queue.length;
    var startpos = pos;
    var newitem = this.queue[pos];
    var childpos = 2 * pos + 1;
    while (childpos < endpos) {
      var rightpos = childpos + 1;
      if (rightpos < endpos && !this._pyLt(this.queue[childpos], this.queue[rightpos])) {
        childpos = rightpos;
      }
      this.queue[pos] = this.queue[childpos];
      pos = childpos;
      childpos = 2 * pos + 1;
    }
    this.queue[pos] = newitem;
    this._siftdown(startpos, pos);
  };

  Heap.prototype.put = function (item) {
    this.queue.push(item);
    this._siftdown(0, this.queue.length - 1);
  };

  Heap.prototype.get = function () {
    var lastelt = this.queue.pop();
    if (this.queue.length) {
      var returnitem = this.queue[0];
      this.queue[0] = lastelt;
      this._siftup(0);
      return returnitem;
    }
    return lastelt;
  };

  Heap.prototype.isEmpty = function () {
    return this.queue.length === 0;
  };

  // 元组比较：Python 逐项比，bool 当 1/0；路径/Move 对象按 army 差比较
  function cmpAny(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i++) {
        var c = cmpAny(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length - b.length;
    }
    if (a === b) return 0;
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    if (typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    // Move.__lt__ 比的是 source.army - dest.army
    if (a && b && a.source && b.source) {
      var da = a.source.army - a.dest.army;
      var db = b.source.army - b.dest.army;
      return da < db ? -1 : da > db ? 1 : 0;
    }
    // GatherTreeNode 的 __lt__ 比 value
    var va = a.value === undefined ? 0 : a.value;
    var vb = b.value === undefined ? 0 : b.value;
    return va < vb ? -1 : va > vb ? 1 : 0;
  }

  function any_where(arr, func) {
    for (var i = 0; i < arr.length; i++) {
      if (func(arr[i])) return true;
    }
    return false;
  }

  function sum_where(arr, func) {
    var total = 0;
    for (var i = 0; i < arr.length; i++) {
      if (func(arr[i])) total += 1;
    }
    return total;
  }

  function where(arr, func) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (func(arr[i])) out.push(arr[i]);
    }
    return out;
  }

  function BotExpansionOps() {}

  var O = BotExpansionOps.prototype;
  void O;

  /* ------------------------------------------------------------------ */
  /* 小工具：超小心 flank 奖励                                            */
  /* ------------------------------------------------------------------ */

  BotExpansionOps._add_super_careful_flank_gath_capture_bonuses = function (bot, matrix) {
    var pathToCheck = bot.sketchiest_potential_inbound_flank_path;
    var targetPlayerObj = bot.targetPlayerObj || null;
    if (pathToCheck === null || pathToCheck === undefined) return;
    if (targetPlayerObj === null || targetPlayerObj.tiles.length === 0) return;
    if (bot.enemy_attack_path !== null && bot.enemy_attack_path !== undefined && bot.likely_kill_push) return;
    if (BotExpansionOps.is_ffa_situation(bot)) return;

    pathToCheck = pathToCheck.get_subsegment_excluding_trailing_visible();
    if (pathToCheck === null || pathToCheck === undefined) return;
    if (pathToCheck.tail === null || pathToCheck.tail === undefined) return;

    var ot = bot.opponent_tracker;
    var winningMassivelyOnArmy = ot.winning_on_army(1.4) && ot.winning_on_economy(1.15);
    var winningMassivelyOnEcon = ot.winning_on_army(1.1) && ot.winning_on_economy(1.4);
    var winningInTheMiddle = ot.winning_on_army(1.25) && ot.winning_on_economy(1.05, undefined, undefined, -25);
    var winningByEnoughToBeSuperCareful = winningMassivelyOnArmy || winningMassivelyOnEcon || winningInTheMiddle;
    var targetPath = bot.shortest_path_to_target_player;
    var targetLen = targetPath === null || targetPath === undefined ? 0 : targetPath.length;
    var flankIsCloserThanThreeFifths =
      EK.BotPathingUtils.distance_from_general(bot, pathToCheck.tail.tile) < pyFloorDiv(3 * targetLen, 5);
    if (!winningByEnoughToBeSuperCareful || !flankIsCloserThanThreeFifths) return;

    var candidateTiles = [];
    var tl = pathToCheck.tileList;
    for (var i = 0; i < tl.length; i++) {
      var tile = tl[i];
      if (tile.visible) continue;
      if (tile.isSwamp || any_where(tile.movable, function (m) { return m.isSwamp; })) continue;
      candidateTiles.push(tile);
    }

    // 原版 key=lambda t: bot.distance_from_general(t)，稳定排序
    var withDist = candidateTiles.map(function (t, idx) {
      return { t: t, d: EK.BotPathingUtils.distance_from_general(bot, t), i: idx };
    });
    withDist.sort(function (a, b) {
      if (a.d !== b.d) return a.d - b.d;
      return a.i - b.i;
    });
    candidateTiles = withDist.map(function (x) { return x.t; });

    var limit = Math.min(4, candidateTiles.length);
    for (var k = 0; k < limit; k++) {
      matrix.raw[candidateTiles[k].tile_index] += 0.08;
    }
  };

  /* ------------------------------------------------------------------ */
  /* intercept option 辅助                                               */
  /* ------------------------------------------------------------------ */

  BotExpansionOps._get_intercept_option_path_key = function (option) {
    var s = option.path.start.tile;
    var t = option.path.tail.tile;
    return [s.x, s.y, t.x, t.y];
  };

  BotExpansionOps._get_condensed_intercept_options_for_info = function (options) {
    var optionByPathKey = new Map();
    var keys = [];
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var pathKey = BotExpansionOps._get_intercept_option_path_key(option);
      var keyStr = pathKey.join(',');
      var pair = optionByPathKey.get(keyStr);
      var shortestOption, longestOption;
      if (pair === undefined) {
        shortestOption = option;
        longestOption = option;
      } else {
        shortestOption = pair[0];
        longestOption = pair[1];
        if (option.length < shortestOption.length) shortestOption = option;
        if (option.length > longestOption.length) longestOption = option;
      }
      if (pair === undefined) keys.push(keyStr);
      optionByPathKey.set(keyStr, [shortestOption, longestOption]);
    }

    var condensedOptions = [];
    var seenOptions = new Set();
    for (var j = 0; j < keys.length; j++) {
      var pr = optionByPathKey.get(keys[j]);
      if (!seenOptions.has(pr[0])) {
        condensedOptions.push(pr[0]);
        seenOptions.add(pr[0]);
      }
      if (!seenOptions.has(pr[1])) {
        condensedOptions.push(pr[1]);
        seenOptions.add(pr[1]);
      }
    }

    // 原版 key=lambda option: option.econValue / option.length, reverse=True
    var keyed = condensedOptions.map(function (o, idx) {
      return { o: o, k: o.econValue / o.length, i: idx };
    });
    keyed.sort(function (a, b) {
      if (a.k !== b.k) return b.k - a.k;
      return a.i - b.i;
    });
    return keyed.map(function (x) { return x.o; });
  };

  BotExpansionOps._log_intercept_option_info = function (bot, option, useBotInfo) {
    // 日志丢弃（见文件头第 6 条）
    void bot;
    void option;
    void useBotInfo;
  };

  /* ------------------------------------------------------------------ */
  /* FFA 判定：原版在 BotTargeting，这里按同一判据本地实现                 */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.is_ffa_situation = function (bot) {
    var map = bm(bot);
    var alive = 0;
    for (var i = 0; i < map.players.length; i++) {
      var p = map.players[i];
      if (p && p.dead !== true) alive += 1;
    }
    if (alive <= 2) return false;
    var teammates = teammates_of(map);
    return teammates.length <= 1;
  };

  /* ------------------------------------------------------------------ */
  /* 前 25 回合 / 城市或将军起手扩张                                       */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.get_optimal_city_or_general_plan_move = function (bot, timeLimit) {
    if (timeLimit === undefined) timeLimit = 4.0;
    var map = bm(bot);
    if (map.turn < 50 && map.is_2v2) {
      // BotComms.send_2v2_tip_to_ally：只有通信副作用，丢弃
    }

    var source = bot.general;
    var player = bot.player;
    if (player.cities.length > 0) {
      var sources = [bot.general];
      for (var i = 0; i < player.cities.length; i++) sources.push(player.cities[i]);
      if (bot.rng && typeof bot.rng.choice === 'function') {
        source = bot.rng.choice(sources);
      } else {
        // 原版是 random.choice(sources)，默认必须走 EK.rng（random.seed(0) 复刻），
        // 取固定第一个会让随机序列错位、后续所有 choice/shuffle 都对不上。
        var gsrng = EK.rng;
        source = (gsrng && typeof gsrng.choice === 'function') ? gsrng.choice(sources) : sources[0];
      }
    }

    var distMap, skipTiles;
    if (map.turn > 50) {
      distMap = BotExpansionOps.get_expansion_weight_matrix(bot, false, 10);
      skipTiles = new Set();
    } else {
      var pair = BotExpansionOps.get_first_25_expansion_distance_priority_map(bot);
      distMap = pair[0];
      skipTiles = pair[1];
    }
    var displayDistMap = Array.isArray(distMap) ? distMap[0] : distMap;

    var calcedThisTurn = false;
    var plan = bot.city_expand_plan;
    if (plan === null || plan === undefined || plan.plan_paths.length === 0) {
      calcedThisTurn = true;
      plan = call_hook(bot, 'optimize_first_25', null, source, distMap, skipTiles, timeLimit, bot._spawn_cramped);
      bot.city_expand_plan = plan;
      if (plan && skipTiles.size > 0) {
        var totalTiles = plan.tile_captures + player.tiles.length;
        if (totalTiles < 17 && map.turn < 50) {
          var plan2 = call_hook(bot, 'optimize_first_25', null, source, distMap, null, timeLimit, bot._spawn_cramped);
          if (plan2) bot.city_expand_plan = plan2;
        }
      }
      if (plan) {
        while (plan.plan_paths.length > 0 && (plan.plan_paths[0] === null || plan.plan_paths[0] === undefined)) {
          plan.plan_paths.shift();
        }
      }
    }

    plan = bot.city_expand_plan;
    if (plan === null || plan === undefined) {
      if (process.env.GB_EK_DEBUG) console.error('[dbg] f25 plan null, turn=' + map.turn);
      return null;
    }
    if (process.env.GB_EK_DEBUG) {
      console.error('[dbg] f25 turn=' + map.turn
        + ' calced=' + calcedThisTurn
        + ' launchTurn=' + plan.launch_turn
        + ' captures=' + plan.tile_captures
        + ' paths=' + plan.plan_paths.length
        + ' skip=' + (skipTiles ? skipTiles.size : '-'));
    }

    // 计划还没到 launch_turn、且本轮没重新算过：先按当前局面重估捕获数，必要时换掉计划
    if (!calcedThisTurn) {
      var needsRecalc =
        plan.launch_turn > map.turn ||
        (plan.launch_turn < map.turn &&
          !any_where(player.tiles, function (tile) {
            return (
              !tile.isGeneral &&
              any_where(tile.movable, function (mv) {
                return !mv.isObstacle && tile.army - 1 > mv.army && !map.is_tile_friendly(mv);
              })
            );
          }));
      if (needsRecalc) {
        plan.tile_captures = call_hook(
          bot,
          'get_start_expand_captures',
          plan.tile_captures,
          plan.core_tile,
          plan.core_tile.army,
          map.turn,
          plan.plan_paths,
          plan.launch_turn
        );
        // 原版 BotExpansionOps.py:166 在这块里现算 distToGenMap（到敌方可能将军位置的距离），
        // 与扩张权重矩阵 distMap 是两个不同的矩阵，recalculate_max_plan 的第 4 参要的是它
        var possibleGeneralTiles = call_hook(
          bot,
          'get_target_player_possible_general_location_tiles_sorted',
          [],
          7,
          bot.targetPlayer
        ).slice(0, 3);
        var distToGenMap = EK.search.build_distance_map_matrix(map, possibleGeneralTiles);
        var optionalNewExpandPlan = call_hook(bot, 'optimize_first_25', null, source, distMap, skipTiles, timeLimit, plan.tile_captures);
        if (optionalNewExpandPlan !== null && optionalNewExpandPlan !== undefined) {
          var visited = new Set(player.tiles);
          var tms = teammates_of(map);
          if (tms) {
            for (var tmi = 0; tmi < tms.length; tmi++) {
              var tTiles = map.players[tms[tmi]].tiles;
              for (var ti = 0; ti < tTiles.length; ti++) visited.add(tTiles[ti]);
            }
          }
          skipTiles.forEach(function (t) { visited.add(t); });
          var maxPlan = call_hook(bot, 'recalculate_max_plan', null, plan, optionalNewExpandPlan, distToGenMap, displayDistMap, visited);
          if (maxPlan === optionalNewExpandPlan) {
            calcedThisTurn = true;
            bot.city_expand_plan = optionalNewExpandPlan;
            plan = optionalNewExpandPlan;
          }
        }
      }
    }

    if (plan.launch_turn > map.turn) return null;

    if (plan.plan_paths.length > 0) {
      var countNone = 0;
      for (var pi = 0; pi < plan.plan_paths.length; pi++) {
        if (plan.plan_paths[pi] !== null && plan.plan_paths[pi] !== undefined) break;
        countNone += 1;
      }

      if (map.turn === plan.launch_turn) {
        while (plan.plan_paths.length > 0 && (plan.plan_paths[0] === null || plan.plan_paths[0] === undefined)) {
          plan.plan_paths.shift();
        }
      }
      if (plan.plan_paths.length === 0) return null;
      var curPath = plan.plan_paths[0];
      if (curPath === null || curPath === undefined) {
        plan.plan_paths.shift();
        return null;
      }

      var move = EK.BotPathingUtils.get_first_path_move(bot, curPath);
      if (move === null || move === undefined) return null;

      var teams = teammates_of(map);
      var collidedWithEnemyAndWastingArmy =
        (move.source.player() !== move.dest.player() &&
          (move.dest.player() !== -1 || move.dest.isCity) &&
          move.source.army - 1 <= move.dest.army) ||
        teams.indexOf(move.dest.player()) >= 0;
      if (move.dest.isMountain) collidedWithEnemyAndWastingArmy = true;
      if (move.dest.isDesert && !plan.intended_deserts.has(move.dest)) collidedWithEnemyAndWastingArmy = true;

      if (collidedWithEnemyAndWastingArmy && move.source.player() === bot.general.player()) {
        var collisionCapsOrPreventsEnemy =
          move.source.army === move.dest.army && move.source.army > 2 && teams.indexOf(move.dest.player()) < 0;
        if (!collisionCapsOrPreventsEnemy) {
          var newPath = BotExpansionOps.attempt_first_25_collision_reroute(bot, curPath, move, displayDistMap);
          if (newPath === null || newPath === undefined) {
            var ia = bot.board_analysis.intergeneral_analysis;
            var bMapBackup = ia.bMap;
            ia.bMap = displayDistMap;
            var expansionNegatives = new Set();
            if (bot.teammate_general !== null && bot.teammate_general !== undefined) {
              var tmTiles = map.players[bot.teammate_general.player()].tiles;
              for (var mi = 0; mi < tmTiles.length; mi++) expansionNegatives.add(tmTiles[mi]);
            }
            expansionNegatives.add(bot.general);
            var expUtilPlan = call_hook(bot, 'get_round_plan_with_expansion', null, 50 - (map.turn % 50), expansionNegatives);
            var path = expUtilPlan === null || expUtilPlan === undefined ? null : expUtilPlan.selected_option;
            ia.bMap = bMapBackup;

            if (path !== null && path !== undefined) {
              curPath.pop_first_move();
              if (curPath.length === 0) plan.plan_paths.shift();
              return EK.BotPathingUtils.get_first_path_move(bot, path);
            }

            curPath.pop_first_move();
            if (curPath.length === 0) plan.plan_paths.shift();
            return null;
          }
          move = EK.BotPathingUtils.get_first_path_move(bot, newPath);
          curPath = newPath;
          if (move === null || move === undefined) return null;
        }
      }

      curPath.pop_first_move();
      if (curPath.length === 0) plan.plan_paths.shift();
      return move;
    }
    return null;
  };

  /* ------------------------------------------------------------------ */
  /* bot 主循环回调：主时序扩张                                            */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.try_find_main_timing_expansion_move_if_applicable = function (bot, defenseCriticalTileSet) {
    if (bot.is_all_in_losing) return null;

    var map = bm(bot);
    var turnsLeft = get_turns_left_in_cycle(bot, map.turn);
    var utilizationCutoff = turnsLeft - pyFloorDiv(turnsLeft, 7);
    var expPlan = bot.expansion_plan;
    if (expPlan === null || expPlan === undefined) return null;

    var value = expPlan.en_tiles_captured * 2 + expPlan.neut_tiles_captured;
    var haveFullExpPlanAlready = false;
    if (
      expPlan.turns_used >= turnsLeft - bot.player.cityCount * 2 &&
      expPlan.en_tiles_captured > pyFloorDiv(expPlan.neut_tiles_captured, 3) &&
      expPlan.en_tiles_captured * 2 + expPlan.neut_tiles_captured > turnsLeft - 2 &&
      value > utilizationCutoff &&
      greedy_turns_available(bot) > 0
    ) {
      haveFullExpPlanAlready = true;
    }

    var havePotentialIntercept = expPlan.includes_intercept;

    var curPath = bot.curPath;
    var curPathEmpty = curPath === null || curPath === undefined || curPath.start === null || curPath.start === undefined || curPath.start.next === null;
    if (
      haveFullExpPlanAlready ||
      havePotentialIntercept ||
      ((curPathEmpty && !bot.defend_economy) || map.turn < 100)
    ) {
      var expNegs = new Set(defenseCriticalTileSet || []);

      if (!haveFullExpPlanAlready || EK.BotStateQueries.is_all_in(bot)) {
        var attackLaunchMove = call_hook(bot, 'check_for_attack_launch_move', null, expNegs);
        if (attackLaunchMove !== null && attackLaunchMove !== undefined && !haveFullExpPlanAlready) {
          return attackLaunchMove;
        }
      }

      var timeLimit = Math.min(get_remaining_move_time(bot), bot.expansion_full_time_limit);
      var move = BotExpansionOps.try_find_expansion_move(
        bot,
        expNegs,
        timeLimit,
        haveFullExpPlanAlready || havePotentialIntercept
      );

      if (move !== null && move !== undefined) {
        if (!in_expand_split(bot, map.turn) && haveFullExpPlanAlready) {
          var cycleTurn = get_turn_in_cycle(bot, map.turn);
          if (bot.timings) {
            bot.timings.launchTiming = Math.max(20, cycleTurn);
            bot.timings.splitTurns = cycleTurn;
          }
        }
        return move;
      }
    }

    return null;
  };

  /* bot.timings 上的字段：原版 BotTimings 没移植，这里按同语义读字段 */
  function cycle_turns(bot) {
    var t = bot.timings;
    if (t && typeof t.cycleTurns === 'number') return t.cycleTurns;
    return 50;
  }

  function get_turn_in_cycle(bot, turn) {
    var t = bot.timings;
    if (t && typeof t.get_turn_in_cycle === 'function') return t.get_turn_in_cycle(turn);
    var ct = cycle_turns(bot);
    if (t && typeof t.cycleTurns === 'number') return turn % ct;
    return turn % 50;
  }

  function get_turns_left_in_cycle(bot, turn) {
    var t = bot.timings;
    if (t && typeof t.get_turns_left_in_cycle === 'function') return t.get_turns_left_in_cycle(turn);
    return cycle_turns(bot) - get_turn_in_cycle(bot, turn);
  }

  function in_expand_split(bot, turn) {
    var t = bot.timings;
    if (t && typeof t.in_expand_split === 'function') return t.in_expand_split(turn);
    return true;
  }

  function in_launch_split(bot, turn) {
    var t = bot.timings;
    if (t && typeof t.in_launch_split === 'function') return t.in_launch_split(turn);
    return get_turn_in_cycle(bot, turn) < 8;
  }

  function in_launch_timing(bot) {
    var turn = bm(bot).turn;
    var t = bot.timings;
    if (t && typeof t.in_launch_timing === 'function') return t.in_launch_timing(turn);
    return in_launch_split(bot, turn);
  }

  function get_remaining_move_time(bot) {
    var t = bot.timings;
    if (t && typeof t.get_remaining_move_time === 'function') return t.get_remaining_move_time();
    return 0.2;
  }

  function greedy_turns_available(bot) {
    var t = bot.timings;
    if (t && typeof t.calculate_greedy_turns_available === 'function') return t.calculate_greedy_turns_available();
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* 扩张执行：try_find_expansion_move                                    */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.try_find_expansion_move = function (bot, defenseCriticalTileSet, timeLimit, forceBypassLaunch, overrideTurns) {
    if (forceBypassLaunch === undefined) forceBypassLaunch = false;
    if (overrideTurns === undefined) overrideTurns = -1;
    var map = bm(bot);
    var skipForAllIn = bot.is_all_in_losing || bot.all_in_city_behind;

    if (!forceBypassLaunch && !in_expand_split(bot, map.turn) && overrideTurns < 0) return null;

    if (bot.targetPlayer !== -1 && EK.BotStateQueries.is_still_ffa_and_non_dominant(bot)) {
      var ot = bot.opponent_tracker;
      var targetPlayerObj = bot.targetPlayerObj;
      if (ot.winning_on_army(1.1) && ot.winning_on_economy(1.1) && targetPlayerObj.aggression_factor > 30) {
        return null;
      }
      if (ot.winning_on_army(1.3, undefined, undefined, -30)) return null;
    }

    if (bot.defend_economy) return null;
    if (skipForAllIn) return null;

    var expansionNegatives = new Set(defenseCriticalTileSet || []);
    var splitTurn = get_turn_in_cycle(bot, map.turn);
    var gatherPath = bot.target_player_gather_path;
    if (
      gatherPath !== null &&
      gatherPath !== undefined &&
      gatherPath.start !== null &&
      gatherPath.start !== undefined &&
      expansionNegatives.has(gatherPath.start.tile)
    ) {
      var gatherTargets = bot.target_player_gather_targets || [];
      for (var i = 0; i < gatherTargets.length; i++) {
        var tile = gatherTargets[i];
        if (map.is_tile_friendly(tile) && !expansionNegatives.has(tile)) expansionNegatives.add(tile);
      }
    }
    void splitTurn;

    var playerTiles = map.players[bot.general.player()].tiles;
    var tilesWithArmy = where(playerTiles, function (t) {
      return (
        (t.army > 2 ||
          any_where(t.movable, function (mv) {
            return !map.is_tile_friendly(mv) && t.army - 1 > mv.army;
          })) &&
        !t.isCity &&
        !t.isGeneral
      );
    });

    var turnsLeft = get_turns_left_in_cycle(bot, map.turn);
    var expPlan = bot.expansion_plan;
    var expPlanTurnsUsed = expPlan === null || expPlan === undefined ? 0 : expPlan.turns_used;
    if (
      (bot.city_expand_plan !== null && bot.city_expand_plan !== undefined || tilesWithArmy.length === 0) &&
      (expPlanTurnsUsed < turnsLeft ||
        (2 * (expPlan ? expPlan.en_tiles_captured : 0) + (expPlan ? expPlan.neut_tiles_captured : 0) < turnsLeft - 4)) &&
      !EK.BotStateQueries.is_still_ffa_and_non_dominant(bot)
    ) {
      var remainingTime = get_remaining_move_time(bot);
      var f25move = BotExpansionOps.get_optimal_city_or_general_plan_move(bot, remainingTime);
      if (f25move !== null && f25move !== undefined) {
        if (f25move.source.army === 1 || f25move.source.player() !== bot.general.player()) {
          bot.city_expand_plan = null;
        } else {
          var cityPlan = bot.city_expand_plan;
          if (cityPlan === null || cityPlan === undefined) return null;
          if (map.turn < cityPlan.launch_turn) return null;

          var moveListPath = new EK.MoveListPath([]);
          for (var pp = 0; pp < cityPlan.plan_paths.length; pp++) {
            var planPath = cityPlan.plan_paths[pp];
            if (planPath === null || planPath === undefined) {
              moveListPath.add_next_move(null);
              continue;
            }
            var ml = planPath.get_move_list();
            for (var mi = 0; mi < ml.length; mi++) moveListPath.add_next_move(ml[mi]);
          }

          bot.curPath = moveListPath.get_first_move() !== null ? moveListPath : null;
          bot.city_expand_plan = null;
          return f25move;
        }
      }
    }

    BotExpansionOps._add_expansion_threat_negs(bot, expansionNegatives);
    if (
      timeLimit > 0.05 ||
      bot.expansion_plan === null ||
      bot.expansion_plan === undefined ||
      bot.expansion_plan.calculated_turn !== map.turn
    ) {
      bot.expansion_plan = BotExpansionOps.build_expansion_plan(bot, timeLimit, expansionNegatives, [50, 30, 255], overrideTurns);
    }

    var plan = bot.expansion_plan;
    if (plan === null || plan === undefined) return null;
    var path = plan.selected_option;
    var allPaths = plan.all_paths || [];

    if (plan.intercept_waiting && plan.intercept_waiting.length > 0) return null;

    if (path !== null && path !== undefined) {
      var pathMove = path.get_first_move();
      if (pathMove === null || pathMove === undefined) return null;
      var launchSplit = in_launch_split(bot, map.turn);
      if (pathMove.source.isGeneral && !launchSplit && allPaths.length > 1 && !plan.includes_intercept) {
        path = allPaths[1];
      }

      var move = path.get_first_move();
      if (move === null || move === undefined) return null;
      if (EK.BotStateQueries.is_all_in(bot) && move.move_half) move.move_half = false;
      if (EK.BotPathingUtils.is_move_safe_valid(bot, move)) return move;
      return null;
    }

    return null;
  };

  /* ------------------------------------------------------------------ */
  /* ExpansionPotential 模型（StrategyModels/ExpansionPotential.py）      */
  /* ------------------------------------------------------------------ */

  function ExpansionPotential(turnsUsed, enTilesCaptured, neutTilesCaptured, selectedOption, allOptions, cumulativeEconVal, turn) {
    this.turns_used = turnsUsed;
    this.en_tiles_captured = enTilesCaptured;
    this.neut_tiles_captured = neutTilesCaptured;
    this.selected_option = selectedOption;
    this.all_paths = allOptions;
    this.plan_tiles = new Set();
    this.preferred_tiles = new Set();
    this.blocking_tiles = new Set();
    this.intercept_waiting = [];
    this.includes_intercept = false;
    for (var i = 0; i < allOptions.length; i++) {
      var ts = allOptions[i].tileSet;
      ts.forEach(function (t) { this.plan_tiles.add(t); }, this);
    }
    this.cumulative_econ_value = cumulativeEconVal;
    this.calculated_turn = turn;
  }

  /* ------------------------------------------------------------------ */
  /* 扩张计划主体                                                         */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.build_expansion_plan = function (bot, timeLimit, expansionNegatives, pathColor, overrideTurns, includeExtraGenAndCityArmy) {
    if (overrideTurns === undefined) overrideTurns = -1;
    if (includeExtraGenAndCityArmy === undefined) includeExtraGenAndCityArmy = false;
    var map = bm(bot);
    var territoryMap = bot.territories.territoryMap;

    var numDanger = 0;
    var genMoves = bot.general.movable;
    for (var d = 0; d < genMoves.length; d++) {
      var dt = genMoves[d];
      if (map.is_tile_enemy(dt) && dt.army > 5) {
        numDanger += 1;
        if (dt.army > bot.general.army - 1) numDanger += 1;
      }
    }
    if (numDanger > 1) expansionNegatives.add(bot.general);

    var blocking = bot.blocking_tile_info || new Map();
    blocking.forEach(function (v, tile) {
      expansionNegatives.add(tile);
    });

    // botmain 按位置把 includeExtraGenAndCityArmy 传成了第 5 个参数；
    // 布尔值不可能是回合数，按原版意思折回去，否则 turns=false 会一路传到
    // get_round_plan_with_expansion 里 raise。
    if (typeof overrideTurns === 'boolean') {
      includeExtraGenAndCityArmy = overrideTurns;
      overrideTurns = -1;
    }

    var remainingCycleTurns = cycle_turns(bot) - get_turn_in_cycle(bot, map.turn);
    if (overrideTurns > -1) remainingCycleTurns = overrideTurns;

    if (bot.city_expand_plan !== null && bot.city_expand_plan !== undefined && bot.city_expand_plan.plan_paths.length === 0) {
      bot.city_expand_plan = null;
    }

    var bonusCapturePointMatrix = BotExpansionOps.get_expansion_weight_matrix(bot);

    var remainingMoveTime = get_remaining_move_time(bot);
    if (remainingMoveTime < timeLimit) {
      timeLimit = remainingMoveTime;
      if (remainingMoveTime < 0.05) timeLimit = 0.05;
    }

    if (bot.teammate_general !== null && bot.teammate_general !== undefined) {
      expansionNegatives.add(bot.teammate_general);
      var armies = bot.armyTracker.armies;
      var teams = teammates_of(map);
      armies.forEach(function (army) {
        if (teams.indexOf(army.player) >= 0 && army.last_moved_turn > map.turn - 3) {
          expansionNegatives.add(army.tile);
        }
      });
      var threat = bot.threat;
      if (threat !== null && threat !== undefined && threat.turns < 2 && threat.path.tail.tile === bot.general) {
        expansionNegatives.add(bot.general);
      }
    }

    var interceptOptionsSet = new Set();
    var addlOptions = [];
    var interceptOptionsToLog = [];
    var interceptPlans = bot.intercept_plans || new Map();
    interceptPlans.forEach(function (interceptPlan) {
      interceptPlan.intercept_options.forEach(function (option) {
        if (option.turns + option.requiredDelay > remainingCycleTurns) return;
        option = option.clone();
        if (bot.cityAnalyzer.owned_contested_cities.has(option.path.start.tile)) {
          option.econValue -= 20;
        }
        addlOptions.push(option);
        interceptOptionsSet.add(option);
        interceptOptionsToLog.push(option);
      });
    });

    // _get_condensed_intercept_options_for_info / _log_intercept_option_info 只有日志用途

    var cityOpt = bot.city_capture_plan_option;
    if (cityOpt !== null && cityOpt !== undefined) addlOptions.push(cityOpt);
    var contestOpt = bot.contest_city_plan_option;
    if (contestOpt !== null && contestOpt !== undefined) addlOptions.push(contestOpt);
    var qkOpt = bot.quick_kill_city_plan_option;
    if (qkOpt !== null && qkOpt !== undefined) {
      if (qkOpt.length > map.remainingCycleTurns) {
        addlOptions.push(EK.BotPathingUtils.get_truncated_expansion_option(qkOpt, map.remainingCycleTurns));
      } else {
        addlOptions.push(qkOpt);
      }
    }

    if (bot.expansion_use_iterative_flow) {
      var flowOptions = call_hook(bot, 'get_flow_expansion_options', null, {
        remainingCycleTurns: remainingCycleTurns,
        timeLimit: timeLimit,
        bonusCapturePointMatrix: bonusCapturePointMatrix,
        negativeTiles: expansionNegatives,
        additional_options: addlOptions.slice(),
        leafMoves: bot.captureLeafMoves || [],
        allowLeafMoves: bot.expansion_allow_leaf_moves,
        bonusMatrixForLeafEcon: bonusCapturePointMatrix,
        islandBuilder: bot.tileIslandBuilder,
        blocking_tile_info: bot.blocking_tile_info,
        enemy_attack_path: bot.enemy_attack_path,
      });
      if (flowOptions !== null && flowOptions !== undefined) {
        addlOptions = flowOptions;
      }
    }

    var flow_expansion_did_knapsacking = bot.expansion_use_iterative_flow && addlOptions.length > 0;

    var expUtilPlan = call_hook(bot, 'get_round_plan_with_expansion', null, {
      searchingPlayer: bot.player.index,
      targetPlayer: bot.targetPlayer,
      turns: remainingCycleTurns,
      negativeTiles: expansionNegatives,
      leafMoves: bot.captureLeafMoves || [],
      useLeafMovesFirst: bot.expansion_use_leaf_moves_first,
      includeExpansionSearch: bot.expansion_use_legacy,
      singleIterationPathTimeCap: Math.min(bot.expansion_single_iteration_time_cap, timeLimit / 3),
      forceNoGlobalVisited: bot.expansion_force_no_global_visited,
      forceGlobalVisitedStage1: bot.expansion_force_global_visited_stage_1,
      useIterativeNegTiles: BotExpansionOps._should_use_iterative_negative_expand(bot),
      allowLeafMoves: bot.expansion_allow_leaf_moves && !bot.expansion_use_iterative_flow,
      allowGatherPlanExtension: bot.expansion_allow_gather_plan_extension,
      alwaysIncludeNonTerminatingLeavesInIteration: bot.expansion_always_include_non_terminating_leafmoves_in_iteration,
      time_limit: timeLimit,
      lengthWeightOffset: bot.expansion_length_weight_offset,
      useCutoff: bot.expansion_use_cutoff,
      threatBlockingTiles: bot.blocking_tile_info,
      colors: pathColor,
      smallTileExpansionTimeRatio: bot.expansion_small_tile_time_ratio,
      bonusCapturePointMatrix: bonusCapturePointMatrix,
      additionalOptionValues: addlOptions,
      includeExtraGenAndCityArmy: includeExtraGenAndCityArmy,
      skipKnapsacking: flow_expansion_did_knapsacking,
    });

    if (expUtilPlan === null || expUtilPlan === undefined) {
      // 上游搜索器没注入：按空计划降级（文件头第 1 条）
      return new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);
    }

    var path = expUtilPlan.selected_option;
    var otherPaths = expUtilPlan.all_paths;

    var plan = new ExpansionPotential(
      expUtilPlan.turns_used,
      expUtilPlan.en_tiles_captured,
      expUtilPlan.neut_tiles_captured,
      path,
      otherPaths,
      expUtilPlan.cumulative_econ_value,
      map.turn
    );

    var anyIntercept = isInterceptionOption(plan.selected_option) !== null;
    var foundNonDelayedIntercept = false;
    var interceptVtCutoff = 1.99;
    if (remainingCycleTurns > 35) interceptVtCutoff = 2.6;
    else if (remainingCycleTurns > 28) interceptVtCutoff = 2.3;
    else if (remainingCycleTurns > 22) interceptVtCutoff = 2.04;

    if (addlOptions.length > 0) {
      for (var oi = 0; oi < plan.all_paths.length; oi++) {
        var otherPath = plan.all_paths[oi];
        if (interceptOptionsSet.has(otherPath)) {
          var ipIter = interceptPlans.values();
          var ipIt = ipIter.next();
          while (!ipIt.done) {
            var planOpt = ipIt.value;
            var interceptOption = planOpt.get_intercept_option_by_path(otherPath);
            if (interceptOption !== null && interceptOption !== undefined) {
              var isOneMoveLargeIntercept = interceptOption.length < 2 || otherPath.length === 1;
              var isGeneralDefenseIntercept = any_where(planOpt.threats, function (threatObj) {
                return threatObj.path.tail.tile.isGeneral;
              });
              if (
                isOneMoveLargeIntercept ||
                isGeneralDefenseIntercept ||
                interceptOption.econValue / interceptOption.length > interceptVtCutoff
              ) {
                if (interceptOption.requiredDelay > 0) {
                  interceptOption.tileSet.forEach(function (t) { plan.blocking_tiles.add(t); });
                  plan.intercept_waiting.push(interceptOption);
                } else {
                  plan.includes_intercept = true;
                  anyIntercept = true;
                  foundNonDelayedIntercept = true;
                  plan.selected_option = otherPath;
                  break;
                }
              }
            }
            ipIt = ipIter.next();
          }
        }

        var tileList = sorted_by_index(otherPath.tileSet);
        for (var ti2 = 0; ti2 < tileList.length; ti2++) {
          var t = tileList[ti2];
          var planOpt2 = interceptPlans.get(t);
          if (planOpt2 === null || planOpt2 === undefined) continue;
          var bestReplacementOption = null;
          var bestReplacementVt = 0.0;
          var firstMoveOfOther = otherPath.get_first_move();
          var optsIter = planOpt2.intercept_options.entries();
          var optsIt = optsIter.next();
          while (!optsIt.done) {
            var turns = optsIt.value[0];
            var option = optsIt.value[1];
            if (option === planOpt2) {
              optsIt = optsIter.next();
              continue;
            }
            var econValue = option.econValue;
            var p = option.path;
            var isOneMoveLargeIntercept2 = p.length === 1 || turns < 2;
            var isGeneralDefenseIntercept2 = any_where(planOpt2.threats, function (threatObj) {
              return threatObj.path.tail.tile.isGeneral;
            });
            if (
              firstMoveOfOther !== null &&
              p.start.tile === firstMoveOfOther.source &&
              (isOneMoveLargeIntercept2 || isGeneralDefenseIntercept2 || econValue / turns > interceptVtCutoff)
            ) {
              var optionVt = option.econValue / Math.max(option.length, 1);
              var worstCase = option.worst_case_intercept_moves;
              if (worstCase === undefined) worstCase = option.worstCaseInterceptMoves;
              var bestWorst = bestReplacementOption === null ? 0 : bestReplacementOption.worst_case_intercept_moves;
              if (bestReplacementOption === null) bestWorst = bestReplacementOption === null ? 0 : 0;
              if (
                bestReplacementOption === null ||
                optionVt > bestReplacementVt ||
                (optionVt === bestReplacementVt && worstCase < bestWorst)
              ) {
                bestReplacementOption = option;
                bestReplacementVt = optionVt;
              }
            }
            optsIt = optsIter.next();
          }

          if (bestReplacementOption !== null) {
            if (bestReplacementOption.requiredDelay > 0) {
              bestReplacementOption.tileSet.forEach(function (t2) { plan.blocking_tiles.add(t2); });
              plan.intercept_waiting.push(bestReplacementOption);
            } else {
              plan.includes_intercept = true;
              anyIntercept = true;
              foundNonDelayedIntercept = true;
              plan.selected_option = bestReplacementOption;
              plan.all_paths[oi] = bestReplacementOption;
            }
          }

          if (foundNonDelayedIntercept) break;
        }

        if (anyIntercept) break;
      }
    }

    if (!anyIntercept) {
      plan = BotExpansionOps.check_launch_against_expansion_plan(bot, plan, expansionNegatives);
    }

    for (var ap = 0; ap < plan.all_paths.length; ap++) {
      plan.all_paths[ap].tileSet.forEach(function (t3) { plan.preferred_tiles.add(t3); });
    }

    return plan;
  };

  function isInterceptionOption(option) {
    if (option === null || option === undefined) return null;
    return option;
  }

  BotExpansionOps.build_enemy_expansion_plan = function (bot, timeLimit, pathColor) {
    var map = bm(bot);
    if (bot.targetPlayer === -1) return new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);
    var seenLookup = bot.armyTracker.seen_player_lookup;
    if (!seenLookup || !seenLookup[bot.targetPlayer]) {
      return new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);
    }

    var territoryMap = bot.territories.territoryMap;
    var remainingCycleTurns = cycle_turns(bot) - get_turn_in_cycle(bot, map.turn);

    var remainingMoveTime = get_remaining_move_time(bot);
    if (remainingMoveTime < timeLimit) {
      timeLimit = remainingMoveTime;
      if (remainingMoveTime < 0.02) timeLimit = 0.02;
    }

    var enFrTiles = map.get_teammates(bot.targetPlayer);
    var negativeTiles = new Set();
    map.reachable_tiles.forEach(function (tile) {
      if (!tile.discovered && enFrTiles.indexOf(tile.player()) >= 0 && !bot.armyTracker.armies.has(tile)) {
        negativeTiles.add(tile);
      }
    });

    var ia = bot.board_analysis.intergeneral_analysis;
    var oldA = ia.aMap;
    var oldB = ia.bMap;
    ia.aMap = oldB;
    ia.bMap = oldA;
    var expUtilPlan;
    try {
      expUtilPlan = call_hook(bot, 'get_round_plan_with_expansion', null, {
        searchingPlayer: bot.targetPlayer,
        targetPlayer: bot.player.index,
        turns: remainingCycleTurns,
        negativeTiles: negativeTiles,
        leafMoves: bot.targetPlayerLeafMoves || [],
        useLeafMovesFirst: bot.expansion_use_leaf_moves_first,
        includeExpansionSearch: bot.expansion_use_legacy,
        singleIterationPathTimeCap: Math.min(bot.expansion_single_iteration_time_cap, timeLimit / 3),
        forceNoGlobalVisited: bot.expansion_force_no_global_visited,
        forceGlobalVisitedStage1: bot.expansion_force_global_visited_stage_1,
        useIterativeNegTiles: BotExpansionOps._should_use_iterative_negative_expand(bot),
        allowLeafMoves: bot.expansion_allow_leaf_moves,
        allowGatherPlanExtension: bot.expansion_allow_gather_plan_extension,
        alwaysIncludeNonTerminatingLeavesInIteration: bot.expansion_always_include_non_terminating_leafmoves_in_iteration,
        time_limit: timeLimit,
        lengthWeightOffset: bot.expansion_length_weight_offset,
        useCutoff: bot.expansion_use_cutoff,
        smallTileExpansionTimeRatio: bot.expansion_small_tile_time_ratio,
        threatBlockingTiles: bot.blocking_tile_info,
        colors: pathColor,
        bonusCapturePointMatrix: null,
      });
    } finally {
      ia.aMap = oldA;
      ia.bMap = oldB;
    }

    if (expUtilPlan === null || expUtilPlan === undefined) {
      return new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);
    }

    var path = expUtilPlan.selected_option;
    var otherPaths = expUtilPlan.all_paths;
    if (path !== null && path !== undefined) otherPaths.splice(0, 0, path);

    for (var i = 0; i < otherPaths.length; i++) {
      var otherPath = otherPaths[i];
      var fm = otherPath.get_first_move();
      if (fm === null || fm === undefined) continue;
      var army = bot.armyTracker.armies.get(fm.source);
      if (army !== null && army !== undefined && otherPath.tileList && typeof army.include_path === 'function') {
        army.include_path(otherPath);
      }
    }

    bot.enemy_expansion_plan_tile_path_cap_values = new Map();

    return new ExpansionPotential(
      expUtilPlan.turns_used,
      expUtilPlan.en_tiles_captured,
      expUtilPlan.neut_tiles_captured,
      path,
      otherPaths,
      expUtilPlan.cumulative_econ_value,
      map.turn
    );
  };

  /* ------------------------------------------------------------------ */
  /* F25 碰撞改道                                                         */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.attempt_first_25_collision_reroute = function (bot, curPath, move, distMap) {
    void distMap;
    var map = bm(bot);
    var cityPlan = bot.city_expand_plan;
    if (cityPlan === null || cityPlan === undefined) return null;

    var countExtraUseableMoves = 0;
    for (var i = 0; i < cityPlan.plan_paths.length; i++) {
      if (cityPlan.plan_paths[i] === null || cityPlan.plan_paths[i] === undefined) countExtraUseableMoves += 1;
    }

    var negExpandTiles = new Set();
    negExpandTiles.add(bot.general);
    if (bot.teammate_general !== null && bot.teammate_general !== undefined) {
      var tmTiles = map.players[bot.teammate_general.player()].tiles;
      for (var ti = 0; ti < tmTiles.length; ti++) negExpandTiles.add(tmTiles[ti]);
    }

    var lengthToReplaceCurrentPlan = curPath.length;
    var rePlanLength = lengthToReplaceCurrentPlan + countExtraUseableMoves;

    var expUtilPlan = call_hook(bot, 'get_round_plan_with_expansion', null, {
      searchingPlayer: bot.general.player(),
      targetPlayer: bot.targetPlayer,
      turns: rePlanLength,
      negativeTiles: negExpandTiles,
      bonusCapturePointMatrix: BotExpansionOps.get_expansion_weight_matrix(bot),
      includeExpansionSearch: true,
    });
    if (expUtilPlan === null || expUtilPlan === undefined) return null;

    var newPath = expUtilPlan.selected_option;

    var curVals = BotExpansionOps.calculate_path_capture_econ_values(bot, curPath, 50);
    var econVal = curVals[4];

    if (newPath !== null && newPath !== undefined && newPath.tileList && newPath.get_move_list) {
      var newVals = BotExpansionOps.calculate_path_capture_econ_values(bot, newPath, 50);
      var newEconVal = newVals[4];
      if (newEconVal <= econVal) return null;

      var segments = newPath.break_overflow_into_one_move_path_subsegments(lengthToReplaceCurrentPlan);
      cityPlan.plan_paths[0] = null;
      if (segments[0] !== null && segments[0] !== undefined) {
        for (var s = segments[0].length; s < lengthToReplaceCurrentPlan; s++) {
          cityPlan.plan_paths.splice(0, 0, null);
        }
      }

      var curSegIndex = 0;
      for (var pp = 0; pp < cityPlan.plan_paths.length; pp++) {
        if (
          (cityPlan.plan_paths[pp] === null || cityPlan.plan_paths[pp] === undefined) &&
          curSegIndex < segments.length
        ) {
          cityPlan.plan_paths[pp] = segments[curSegIndex];
          curSegIndex += 1;
        }
      }

      return segments[0] === undefined ? null : segments[0];
    }
    return null;
  };

  /* ------------------------------------------------------------------ */
  /* 叶子走子                                                             */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.find_leaf_move = function (bot, allLeaves) {
    var leafMoves = BotExpansionOps.prioritize_expansion_leaves(bot, allLeaves);
    var gatherPath = bot.target_player_gather_path;
    if (gatherPath !== null && gatherPath !== undefined) {
      leafMoves = where(leafMoves, function (move) { return !gatherPath.tileSet.has(move.source); });
    }
    if (leafMoves.length > 0) {
      var move = leafMoves[0];
      var i = 0;
      var valid = true;
      while (
        move.source.isGeneral &&
        !EK.BotDefense.general_move_safe(bot, move.dest)
      ) {
        if (EK.BotDefense.general_move_safe(bot, move.dest, true)) {
          move.move_half = true;
          break;
        }
        // 原版 random.choice(leafMoves)（BotExpansionOps.py:1143）
        if (bot.rng && typeof bot.rng.choice === 'function') {
          move = bot.rng.choice(leafMoves);
        } else {
          var lmrng = EK.rng;
          move = (lmrng && typeof lmrng.choice === 'function') ? lmrng.choice(leafMoves) : leafMoves[0];
        }
        i += 1;
        if (i > 10) {
          valid = false;
          break;
        }
      }

      if (valid) {
        bot.curPath = null;
        bot.curPathPrio = -1;
        return move;
      }
    }
    return null;
  };

  BotExpansionOps.prioritize_expansion_leaves = function (bot, allLeaves, allowNonKill, distPriorityMap) {
    if (allowNonKill === undefined) allowNonKill = false;
    if (distPriorityMap === undefined) distPriorityMap = null;
    var map = bm(bot);
    var queue = new Heap();
    var analysis = bot.board_analysis.intergeneral_analysis;
    var expansionMap = BotExpansionOps.get_expansion_weight_matrix(bot);
    if (distPriorityMap === null) distPriorityMap = analysis.bMap;

    var leaves = allLeaves === null || allLeaves === undefined ? [] : allLeaves;
    for (var i = 0; i < leaves.length; i++) {
      var leafMove = leaves[i];
      if (!allowNonKill && leafMove.source.army - leafMove.dest.army <= 1) continue;
      if (!allowNonKill && (leafMove.dest.isDesert || leafMove.dest.isSwamp)) continue;
      if (leafMove.source.army < 2) continue;
      if (map.is_tile_friendly(leafMove.dest)) continue;
      if (leafMove.dest.isCity && leafMove.dest.player() === -1 && leafMove.dest.army > 25) continue;

      var dest = leafMove.dest;
      var source = leafMove.source;
      var terrPlayer = bot.territories.territoryMap.raw[dest.tile_index];
      if (
        terrPlayer !== -1 &&
        !map.is_player_on_team_with(terrPlayer, bot.general.player()) &&
        !map.is_player_on_team_with(terrPlayer, bot.targetPlayer) &&
        dest.player() !== -1
      ) {
        continue;
      }

      var points = 0;
      if (bot.board_analysis.innerChokes.raw[dest.tile_index]) points += 0.1;
      if (!bot.board_analysis.outerChokes.raw[dest.tile_index]) points += 0.05;
      if (analysis.is_choke(dest)) points += 0.15;

      var towardsEnemy = distPriorityMap.raw[dest.tile_index] < distPriorityMap.raw[source.tile_index];
      if (towardsEnemy) points += 0.2;

      var awayFromUs = analysis.aMap.raw[dest.tile_index] > analysis.aMap.raw[source.tile_index];
      if (awayFromUs) points += 0.1;

      if (dest.player() === bot.targetPlayer) points += 1.5;

      points += expansionMap.raw[dest.tile_index] * 5;

      var distEnemyPoints = (analysis.aMap.raw[dest.tile_index] + 1) / (distPriorityMap.raw[dest.tile_index] + 1);
      points += distEnemyPoints / 3;

      queue.put([0 - points, leafMove]);
    }

    var vals = [];
    while (queue.queue.length) {
      var entry = queue.get();
      vals.push(entry[1]);
    }
    return vals;
  };

  BotExpansionOps.timing_expand = function (bot) {
    void bot;
    // 原版两个分支都 return None（死代码）
    return null;
  };

  BotExpansionOps.make_first_25_move = function (bot) {
    var map = bm(bot);
    var timeLimit = get_remaining_move_time(bot);

    var cityIter = bot.cityAnalyzer.city_scores.keys();
    var cityIt = cityIter.next();
    while (!cityIt.done) {
      if (cityIt.value.army < 30) {
        return BotExpansionOps.try_find_expansion_move(bot, new Set(), 0.15);
      }
      cityIt = cityIter.next();
    }

    if (bot.city_expand_plan !== null && bot.city_expand_plan !== undefined && timeLimit > 0) {
      var used = 0;
      if (bot.perf_timer && typeof bot.perf_timer.get_elapsed_since_update === 'function') {
        used = bot.perf_timer.get_elapsed_since_update(map.turn);
      }
      var moveCycleTime = 0.5;
      var latencyBuffer = 0.22;
      var allowedLatest = moveCycleTime - latencyBuffer;
      timeLimit = allowedLatest - used;
      var i = 0;
      while (map.turn + i < 12) {
        i += 1;
        timeLimit += moveCycleTime - 0.1;
      }
      timeLimit = Math.min(2.0, timeLimit);
    } else if (map.turn < 7) {
      timeLimit = 3.75;
      if (map.is_2v2) {
        if (bot.city_expand_plan === null || bot.city_expand_plan === undefined) {
          timeLimit = bot.teamed_with_bot ? 0.75 : 2.75;
        } else {
          timeLimit = 1.75;
        }
      }
      if (map.cols * map.rows > 1000 || map.players.length > 8) timeLimit = 0.75;
    }

    var move = BotExpansionOps.get_optimal_city_or_general_plan_move(bot, timeLimit);
    if (move !== null && move !== undefined) {
      if (move.source.player() === bot.general.player()) return move;
    }
    return null;
  };

  /* ------------------------------------------------------------------ */
  /* 迷雾探索（依赖 WatchmanRouteUtils / BotCombatOps，走注入）             */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.get_optimal_exploration = function (bot, turns, negativeTiles, valueFunc, priorityFunc, initFunc, skipFunc, minArmy, maxTime) {
    void turns;
    void valueFunc;
    void priorityFunc;
    void initFunc;
    void skipFunc;
    void minArmy;
    if (negativeTiles === undefined) negativeTiles = null;

    var toReveal = call_hook(bot, 'get_target_player_possible_general_location_tiles_sorted', [], 0, bot.targetPlayer);
    if (toReveal === null || toReveal === undefined || toReveal.length === 0) return null;

    var targetArmyLevel = call_hook(bot, 'determine_fog_defense_amount_available_for_tiles', 0, toReveal, bot.targetPlayer);
    var startArmies = call_hook(bot, 'get_largest_tiles_as_armies', [], bot.general.player(), 3);
    if (!startArmies || startArmies.length === 0) return null;

    var expectedGen = bot.targetPlayerExpectedGeneralLocation;
    var map = bm(bot);
    var withDist = [];
    for (var i = 0; i < startArmies.length; i++) {
      withDist.push({
        a: startArmies[i],
        d: expectedGen === null || expectedGen === undefined ? 0 : map.get_distance_between(expectedGen, startArmies[i].tile),
        i: i,
      });
    }
    withDist.sort(function (x, y) {
      if (x.d !== y.d) return x.d - y.d;
      return x.i - y.i;
    });

    var bestArmy = null;
    var bestThresh = null;
    for (var k = 0; k < withDist.length; k++) {
      var startArmy = withDist[k].a;
      if (negativeTiles && negativeTiles.has(startArmy.tile)) continue;
      var armyDiff = startArmy.value - targetArmyLevel;
      var dist = withDist[k].d;
      if (dist <= 0) dist = 1;
      var thisThresh = armyDiff <= 0 ? -dist + armyDiff : armyDiff / dist;
      if (bestArmy === null || bestThresh < thisThresh) {
        bestThresh = thisThresh;
        bestArmy = startArmy;
      }
    }
    if (bestArmy === null) return null;

    var startTile = bestArmy.tile;
    if (maxTime === undefined || maxTime === null) maxTime = get_remaining_move_time(bot) / 2;

    var path = call_hook(bot, 'get_watchman_path', null, startTile, toReveal, maxTime);
    if (path === null || path === undefined || path.length === 0) return null;

    var revealRes = call_hook(bot, 'get_revealed_count_and_max_kill_turns_and_positive_path', null, path, toReveal, targetArmyLevel);
    if (revealRes === null || revealRes === undefined) return null;
    return revealRes.bestRevealedPath === undefined ? null : revealRes.bestRevealedPath;
  };

  BotExpansionOps.check_launch_against_expansion_plan = function (bot, existingPlan, expansionNegatives) {
    void bot;
    void expansionNegatives;
    // 原版第一行就 return existingPlan，后面全部不可达
    return existingPlan;
  };

  /* ------------------------------------------------------------------ */
  /* 路径经济值                                                           */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.calculate_path_capture_econ_values = function (bot, launchPath, turnsLeftInCycle, negativeTiles) {
    void negativeTiles;
    var map = bm(bot);
    var econMatrix = BotExpansionOps.get_expansion_weight_matrix(bot);

    var army = 0;
    var turns = -1;
    var enCaps = 0;
    var neutCaps = 0;
    var distToFirstCap = -1;
    var distToFirstFogTile = -1;
    var friendlyArmy = 0;
    var econVal = 0;

    var tileList = launchPath.tileList;
    for (var i = 0; i < tileList.length; i++) {
      var tile = tileList[i];
      turns += 1;
      var isFriendly = map.is_tile_friendly(tile);
      if (isFriendly) {
        army += tile.army - 1;
        friendlyArmy += tile.army - 1;
      } else {
        army -= tile.army + 1;

        if (distToFirstFogTile === -1 && !tile.visible) distToFirstFogTile = turns;
        if (army < 0) break;
        if (distToFirstCap === -1) distToFirstCap = turns;

        econVal += econMatrix.raw[tile.tile_index];

        if (tile.isSwamp) {
          army -= 1;
          econVal -= 1;
        } else if (!tile.isDesert) {
          if (map.is_player_on_team_with(bot.targetPlayer, tile.player())) enCaps += 1;
          else neutCaps += 1;
        }
      }

      if (army <= 0) break;
      if (turns >= turnsLeftInCycle) break;
    }

    if (distToFirstCap === -1) distToFirstCap = launchPath.length;
    if (distToFirstFogTile === -1) distToFirstFogTile = launchPath.length;

    econVal += 2 * enCaps + neutCaps;
    void distToFirstCap;

    return [distToFirstFogTile, enCaps, neutCaps, turns, econVal, army, friendlyArmy];
  };

  /* ------------------------------------------------------------------ */
  /* 前 100 回合的 flow 复用                                              */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.make_second_25_move = function (bot) {
    var map = bm(bot);
    if (map.turn >= 100 || BotExpansionOps.is_ffa_situation(bot) || bot.completed_first_100 || map.is_2v2 || bot.targetPlayer === -1) {
      return null;
    }

    var cutoff = 67;
    if (map.turn > cutoff) return null;

    if (bot.curPath !== null && bot.curPath !== undefined) {
      if (bot.curPath.tileSet.has(bot.general)) {
        bot.curPath = null;
      } else if (
        bot.curPath.start !== null &&
        bot.curPath.start.next !== null &&
        bot.curPath.start.tile.army - 1 > bot.curPath.start.next.tile.army
      ) {
        var res = EK.BotPathingUtils.continue_cur_path(bot, null, new Set());
        if (res && res.foundMove) return res.move;
      }
    }

    var expansionMap = BotExpansionOps.get_expansion_weight_matrix(bot);
    var leafMoves = bot.captureLeafMoves || [];
    var nearbyGeneralCapturePaths = [];
    for (var i = 0; i < leafMoves.length; i++) {
      var mv = leafMoves[i];
      if (
        mv.source === bot.general &&
        mv.source.army - 1 > mv.dest.army &&
        !mv.dest.isObstacle &&
        !map.is_tile_friendly(mv.dest)
      ) {
        nearbyGeneralCapturePaths.push(mv.dest);
      }
    }

    var reservedGeneralCapture = null;
    if (nearbyGeneralCapturePaths.length > 0) {
      var best = nearbyGeneralCapturePaths[0];
      for (var b = 1; b < nearbyGeneralCapturePaths.length; b++) {
        if (expansionMap.raw[nearbyGeneralCapturePaths[b].tile_index] > expansionMap.raw[best.tile_index]) {
          best = nearbyGeneralCapturePaths[b];
        }
      }
      reservedGeneralCapture = best;
    }

    var expPlan = bot.expansion_plan;
    if (expPlan === null || expPlan === undefined || expPlan.calculated_turn !== map.turn) return null;

    var selectedPath = expPlan.selected_option;
    var allPaths = where(expPlan.all_paths, function (path) {
      return reservedGeneralCapture === null || !path.tileSet.has(reservedGeneralCapture);
    });
    if (selectedPath !== null && selectedPath !== undefined && reservedGeneralCapture !== null && selectedPath.tileSet.has(reservedGeneralCapture)) {
      selectedPath = allPaths.length > 0 ? allPaths[0] : null;
    }

    for (var pi = 0; pi < allPaths.length; pi++) {
      var move = allPaths[pi].get_first_move();
      if (move !== null && move !== undefined && !move.source.isGeneral && EK.BotPathingUtils.is_move_safe_valid(bot, move)) {
        selectedPath = allPaths[pi];
        break;
      }
    }

    if (selectedPath !== null && selectedPath !== undefined) {
      var selectedMove = selectedPath.get_first_move();
      if (selectedMove !== null && selectedMove !== undefined && selectedMove.source.isGeneral) {
        for (var pj = 0; pj < allPaths.length; pj++) {
          var mv2 = allPaths[pj].get_first_move();
          if (mv2 !== null && mv2 !== undefined && !mv2.source.isGeneral && EK.BotPathingUtils.is_move_safe_valid(bot, mv2)) {
            selectedPath = allPaths[pj];
            selectedMove = mv2;
            break;
          }
        }
      }

      if (selectedMove !== null && selectedMove !== undefined && EK.BotPathingUtils.is_move_safe_valid(bot, selectedMove)) {
        return selectedMove;
      }
      return null;
    }

    bot.completed_first_100 = true;
    return null;
  };

  /* ------------------------------------------------------------------ */
  /* 兵力在play区外的比例                                                 */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.check_army_out_of_play_ratio = function (bot) {
    var map = bm(bot);
    bot.out_of_play_tiles = new Set();

    if (bot.force_far_gathers && bot.force_far_gathers_turns <= 0) {
      bot.force_far_gathers_turns = 0;
      bot.force_far_gathers_sleep_turns = 50;
      bot.force_far_gathers = false;
    }

    if (map.is_2v2 && bot.teammate_general !== null && bot.teammate_general !== undefined) return false;
    if (map.turn < 100 && !bot.is_weird_custom) return false;
    if (bot.targetPlayer === -1 || bot.shortest_path_to_target_player === null || bot.shortest_path_to_target_player === undefined) {
      return false;
    }

    var inPlaySum = 0;
    var medPlaySum = 0;
    var outOfPlaySum = 0;
    var outOfPlayCount = 0;
    var nearOppSum = 0;

    var genPlayer = map.players[bot.general.player()];
    var analysis = bot.board_analysis.intergeneral_analysis;
    var pathLen = analysis.shortestPathWay.distance;
    var ratio = bot.behavior_out_of_play_distance_over_shortest_ratio;
    var inPlayCutoff = pathLen + (pathLen * ratio) / 2;
    var mediumRangeCutoff = pathLen + pathLen * ratio;

    var outOfPlayTiles = bot.out_of_play_tiles;
    var genTiles = genPlayer.tiles;
    for (var i = 0; i < genTiles.length; i++) {
      var tile = genTiles[i];
      var genDist = analysis.aMap.raw[tile.tile_index];
      var enDist = analysis.bMap.raw[tile.tile_index];
      if (genDist > enDist * 2) {
        nearOppSum += tile.army - 1;
        continue;
      }
      if (tile.isGeneral) continue;

      var pathWay = analysis.pathWayLookupMatrix.raw[tile.tile_index];
      if (pathWay !== null && pathWay !== undefined && pathWay.distance <= inPlayCutoff) {
        inPlaySum += tile.army - 1;
      } else if (pathWay !== null && pathWay !== undefined && pathWay.distance < mediumRangeCutoff) {
        medPlaySum += tile.army - 1;
      } else {
        outOfPlaySum += tile.army - 1;
        outOfPlayCount += 1;
        outOfPlayTiles.add(tile);
      }
    }

    var total = medPlaySum + inPlaySum + outOfPlaySum + nearOppSum;
    if (total === 0) return false;

    var hugeGameOffset = 0;
    var realTotal = total;
    var incMedium = pyFloorDiv(medPlaySum, 2);
    if (total > 90) {
      hugeGameOffset = Math.trunc(pyPow(total - 90, 0.8));
      total = 90 + hugeGameOffset;
      incMedium = 0;
    }

    var outOfPlaySumFactored = outOfPlaySum - pyFloorDiv(nearOppSum, 3) + incMedium;
    var outOfPlayRat = outOfPlaySumFactored / total;

    var aboveOutOfPlay = outOfPlayRat > bot.behavior_out_of_play_defense_threshold;

    var deserts = bot.player.deserts;
    var tilesMinusDeserts = bot.player.tileCount - (deserts ? deserts.size : 0);
    if (outOfPlayRat > 1.4 && (tilesMinusDeserts > 150 || bot.player.cityCount > 5 || bot.defensive_spanning_tree.length > 50)) {
      if (bot.force_far_gathers_sleep_turns <= 0 && !bot.force_far_gathers) {
        bot.force_far_gathers = true;
        bot.force_far_gathers_turns = map.remainingCycleTurns;
        var minTurns =
          Math.max(pyFloorDiv(tilesMinusDeserts, 2), bot.defensive_spanning_tree.length + pyFloorDiv(outOfPlayCount, 2), outOfPlayCount) +
          bot.board_analysis.inter_general_distance * outOfPlayRat;
        while (bot.force_far_gathers_turns <= minTurns) bot.force_far_gathers_turns += 50;
        var cap = outOfPlayCount;
        if (bot.target_player_gather_path) cap += pyFloorDiv(bot.target_player_gather_path.length, 2);
        if (bot.force_far_gathers_turns > cap) bot.force_far_gathers_turns = cap;
      }
    }

    void realTotal;
    return aboveOutOfPlay;
  };

  BotExpansionOps._should_use_iterative_negative_expand = function (bot) {
    if (bm(bot).turn < 150) return false;
    return !!bot.expansion_use_iterative_negative_tiles;
  };

  BotExpansionOps._add_expansion_threat_negs = function (bot, negs) {
    var map = bm(bot);
    var threat = bot.threat;
    if (threat === null || threat === undefined) return;

    var killType = EK.ThreatType ? EK.ThreatType.Kill : 'Kill';
    if (threat.threatType === killType) {
      var turn = map.turn;
      var tl = threat.path.tileList;
      var teams = map.team_ids_by_player_index;
      for (var i = 0; i < tl.length; i++) {
        var tile = tl[i];
        if (turn % 50 === 0 && turn !== map.turn) break;
        turn += 1;
        if (teams[tile.player()] !== teams[bot.general.player()] || threat.threatValue > 0) {
          negs.add(tile);
        }
      }
    }

    if (bot.army_interceptor && typeof bot.army_interceptor.ensure_threat_army_analysis === 'function') {
      bot.army_interceptor.ensure_threat_army_analysis(threat);
    }
  };

  /* ------------------------------------------------------------------ */
  /* 前 25 回合距离优先级                                                  */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.get_first_25_expansion_distance_priority_map = function (bot) {
    var map = bm(bot);
    if (BotExpansionOps.is_ffa_situation(bot)) {
      return [BotExpansionOps._get_avoid_other_players_expansion_matrix(bot), new Set()];
    }

    var numberStartTargets = 2;
    var tgs, enDistMap;

    if (bot.targetPlayer !== -1) {
      var farApart = call_hook(bot, '_get_furthest_apart_3_enemy_general_locations', null, bot.targetPlayer);
      if (farApart === null || farApart === undefined) return [EK.search.build_distance_map_matrix(map, [bot.general]), new Set()];
      tgs = farApart[0];
      enDistMap = farApart[1];

      var validGeneralPositions = bot.armyTracker.valid_general_positions_by_player[bot.targetPlayer].raw;
      var targetCounts = new Map();
      for (var ti = 0; ti < tgs.length; ti++) {
        var tg = tgs[ti];
        var tgDistMap = EK.search.build_distance_map_matrix(map, [tg]);
        var count = 0;
        for (var k = 0; k < map.tiles_by_index.length; k++) {
          var tile = map.tiles_by_index[k];
          if (validGeneralPositions[tile.tile_index] && tgDistMap.raw[tile.tile_index] <= 7) count += 1;
        }
        targetCounts.set(tg, count);
      }
      var ordered = tgs.map(function (t, idx) { return { t: t, c: targetCounts.get(t), i: idx }; });
      ordered.sort(function (a, b) {
        if (a.c !== b.c) return b.c - a.c;
        return a.i - b.i;
      });
      tgs = ordered.map(function (x) { return x.t; });
    } else {
      tgs = call_hook(bot, 'get_target_player_possible_general_location_tiles_sorted', [], 12);
      if (tgs.length < numberStartTargets) {
        tgs = call_hook(bot, 'get_target_player_possible_general_location_tiles_sorted', [], 8);
      }
      tgs = tgs.slice(0, numberStartTargets);
      enDistMap = EK.search.build_distance_map_matrix(map, tgs);
    }

    var distMaps = [];
    for (var d = 0; d < tgs.length; d++) distMaps.push(EK.search.build_distance_map_matrix(map, [tgs[d]]));
    if (distMaps.length === 0) distMaps = [enDistMap];
    var skipTiles = new Set();

    var allTiles = map.get_all_tiles();
    if (map.is_2v2 && bot.teammate_general !== null && bot.teammate_general !== undefined) {
      var usDist = map.distance_mapper.get_tile_dist_matrix(bot.general);
      for (var dm = 0; dm < distMaps.length; dm++) {
        var m = distMaps[dm];
        for (var a = 0; a < allTiles.length; a++) {
          var t2 = allTiles[a];
          m.raw[t2.tile_index] -= pyFloorDiv(usDist.raw[t2.tile_index], 2);
          m.raw[t2.tile_index] += EK.BotPathingUtils.get_distance_from_board_center(bot, t2, 0.75);
        }
      }

      var teammateDistanceDropoffPoint = 9;
      var tms = teammates_of(map);
      for (var tmI = 0; tmI < tms.length; tmI++) {
        var teammateDistances = EK.search.build_distance_map_matrix(map, [map.generals[tms[tmI]]]);
        for (var dm2 = 0; dm2 < distMaps.length; dm2++) {
          var m2 = distMaps[dm2];
          for (var a2 = 0; a2 < allTiles.length; a2++) {
            var t3 = allTiles[a2];
            if (teammateDistances.raw[t3.tile_index] < usDist.raw[t3.tile_index]) {
              m2.raw[t3.tile_index] += 3 * teammateDistanceDropoffPoint - 3 * teammateDistances.raw[t3.tile_index];
            }
          }
        }
      }

      if (skipTiles.size === 0) {
        if (!bot._spawn_cramped) {
          var teammateAnalysis = new EK.ArmyAnalyzer(map, bot.general, bot.teammate_general);
          var spw = teammateAnalysis.shortestPathWay;
          var spTiles = spw.tiles;
          var isTeamLead = bot.teammate_communicator ? bot.teammate_communicator.is_team_lead : true;
          for (var sp = 0; sp < spTiles.length; sp++) {
            var spTile = spTiles[sp];
            if (spTile === bot.general) continue;
            var aMapV = teammateAnalysis.aMap.raw[spTile.tile_index];
            var bMapV = teammateAnalysis.bMap.raw[spTile.tile_index];
            if (aMapV > bMapV || (aMapV === bMapV && !isTeamLead)) skipTiles.add(spTile);
          }
        } else {
          var tmMoves = bot.teammate_general.movable;
          for (var mm = 0; mm < tmMoves.length; mm++) skipTiles.add(tmMoves[mm]);
        }
      }
    } else if (map.remainingPlayers === 2) {
      var usDist2 = map.distance_mapper.get_tile_dist_matrix(bot.general);
      var aggregateDistMap = EK.search.build_distance_map_matrix(map, [bot.general]);
      for (var a3 = 0; a3 < allTiles.length; a3++) {
        var t4 = allTiles[a3];
        aggregateDistMap.raw[t4.tile_index] = 0 - aggregateDistMap.raw[t4.tile_index];
        aggregateDistMap.raw[t4.tile_index] += enDistMap.raw[t4.tile_index];
        aggregateDistMap.raw[t4.tile_index] += EK.BotPathingUtils.get_distance_from_board_center(bot, t4, 0.85);
      }
      for (var dm3 = 0; dm3 < distMaps.length; dm3++) {
        var m3 = distMaps[dm3];
        for (var a4 = 0; a4 < allTiles.length; a4++) {
          var t5 = allTiles[a4];
          m3.raw[t5.tile_index] -= usDist2.raw[t5.tile_index];
          m3.raw[t5.tile_index] += EK.BotPathingUtils.get_distance_from_board_center(bot, t5, 0.85);
        }
      }
      distMaps.splice(0, 0, aggregateDistMap);
    } else if (map.remainingPlayers > 2) {
      for (var dm4 = 0; dm4 < distMaps.length; dm4++) {
        var m4 = distMaps[dm4];
        for (var a5 = 0; a5 < allTiles.length; a5++) {
          var t6 = allTiles[a5];
          m4.raw[t6.tile_index] -= EK.BotPathingUtils.get_distance_from_board_center(bot, t6, 0.15);
        }
      }
    } else {
      throw new Error('The fuck?');
    }

    return [distMaps, skipTiles];
  };

  /* ------------------------------------------------------------------ */
  /* 扩张权重矩阵                                                         */
  /* ------------------------------------------------------------------ */

  BotExpansionOps.get_expansion_weight_matrix = function (bot, copy, mult) {
    if (mult === undefined) mult = 1;
    if (bot._expansion_value_matrix === null || bot._expansion_value_matrix === undefined) {
      if (EK.BotStateQueries && EK.BotStateQueries.is_still_ffa_and_non_dominant(bot)) {
        bot._expansion_value_matrix = BotExpansionOps._get_avoid_other_players_expansion_matrix(bot);
      } else {
        bot._expansion_value_matrix = BotExpansionOps._get_standard_expansion_capture_weight_matrix(bot);
      }
    }

    if (mult !== 1) {
      var copyMat = bot._expansion_value_matrix.copy();
      var raw = copyMat.raw;
      for (var i = 0; i < raw.length; i++) raw[i] *= mult;
      return copyMat;
    }
    if (copy) return bot._expansion_value_matrix.copy();
    return bot._expansion_value_matrix;
  };

  BotExpansionOps.look_for_ffa_turtle_move = function (bot) {
    void bot;
    // 原版 neutCity 恒为 None，后面全部不可达
    return null;
  };

  BotExpansionOps.try_gather_tendrils_towards_enemy = function (bot, turns) {
    void bot;
    void turns;
    return null;
  };

  BotExpansionOps._get_expansion_plan_exploration_move = function (bot, armyCutoff, negativeTiles) {
    var plan = bot.expansion_plan;
    if (plan === null || plan === undefined) return null;
    var map = bm(bot);

    var maxPath = null;
    var paths = plan.all_paths;
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var firstMove = path.get_first_move();
      if (firstMove === null || firstMove === undefined) continue;
      if (firstMove.source.army < armyCutoff) continue;

      var skip = false;
      var containsFogCount = 0;
      var tiles = sorted_by_index(path.tileSet);
      for (var t = 0; t < tiles.length; t++) {
        var tile = tiles[t];
        if (negativeTiles.has(tile)) {
          skip = true;
          break;
        }
        if (EK.BotPathingUtils.distance_from_general(bot, tile) < 7) {
          skip = true;
          break;
        }
        var tgDists = bot.territories.territoryDistances[bot.targetPlayer];
        if (
          tgDists.raw[tile.tile_index] > 2 &&
          !bot.armyTracker.valid_general_positions_by_player[bot.targetPlayer].raw[tile.tile_index]
        ) {
          skip = true;
          break;
        }
        for (var a = 0; a < tile.adjacents.length; a++) {
          if (!tile.adjacents[a].discovered) containsFogCount += 1;
        }
      }

      if (skip || containsFogCount < path.length) continue;

      if (maxPath === null) {
        maxPath = path;
      } else {
        var maxMove = maxPath.get_first_move();
        if (maxMove === null || maxMove.source.army < firstMove.source.army) maxPath = path;
      }
    }

    if (maxPath === null) return null;
    void map;
    return maxPath.get_first_move();
  };

  BotExpansionOps._get_expansion_plan_quick_capture_move = function (bot, defenseCriticalTileSet) {
    if (!bot.behavior_allow_pre_gather_greedy_leaves) return null;
    if (bot.currently_forcing_out_of_play_gathers) return null;
    var map = bm(bot);
    if ((map.remainingPlayers !== 2 && !map.is_2v2) || bot.approximate_greedy_turns_avail <= 0) return null;

    var ot = bot.opponent_tracker;
    if (ot.winning_on_economy(1.35, 5, undefined, bot.behavior_pre_gather_greedy_leaves_offset)) return null;

    var plan = bot.expansion_plan;
    if (plan === null || plan === undefined) return null;

    var negativeTiles = new Set(defenseCriticalTileSet);
    if (!in_launch_timing(bot)) {
      var gp = bot.target_player_gather_path;
      if (gp !== null && gp !== undefined) {
        for (var gi = 0; gi < gp.tileList.length; gi++) negativeTiles.add(gp.tileList[gi]);
      }
    }

    var flankable = bot.board_analysis.flankable_fog_area_matrix;
    var highValueSet = new Set();
    map.reachable_tiles.forEach(function (tile) {
      if (map.is_tile_on_team_with(tile, bot.targetPlayer)) {
        highValueSet.add(tile);
        return;
      }
      var expands = flankable.raw[tile.tile_index] ? true : false;
      if (!expands) {
        for (var m = 0; m < tile.movable.length; m++) {
          if (flankable.raw[tile.movable[m].tile_index]) {
            expands = true;
            break;
          }
        }
      }
      if (expands) highValueSet.add(tile);
    });

    var maxScoreVt = -100;
    var maxPath = null;
    var paths = plan.all_paths;
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var anyInHighValue = false;
      var anyInNeg = false;
      var hasArmyOneFriendly = false;
      for (var t = 0; t < path.tileList.length; t++) {
        var pt = path.tileList[t];
        if (highValueSet.has(pt)) anyInHighValue = true;
        if (negativeTiles.has(pt)) anyInNeg = true;
        if (pt.army === 1 && map.is_tile_friendly(pt)) hasArmyOneFriendly = true;
      }
      if (!anyInHighValue) continue;
      if (anyInNeg) continue;
      if (path.length > bot.approximate_greedy_turns_avail) continue;
      if (hasArmyOneFriendly) continue;

      var scoreVt = path.econValue / path.length;
      if (scoreVt > maxScoreVt) {
        maxScoreVt = scoreVt;
        maxPath = path;
      }
    }

    if (maxPath === null) return null;
    if (maxScoreVt > 0.99) return maxPath.get_first_move();
    return null;
  };

  BotExpansionOps._get_avoid_other_players_expansion_matrix = function (bot) {
    var map = bm(bot);
    var matrix = new EK.MapMatrix(map, 0.0);
    var territoryMap = bot.territories.territoryMap;
    var analysis = bot.board_analysis.intergeneral_analysis;
    var shortestTiles = null;

    var allTiles = map.get_all_tiles();
    for (var i = 0; i < allTiles.length; i++) {
      var tile = allTiles[i];
      if (bot.targetPlayer !== -1 && (tile.player() === bot.targetPlayer || territoryMap.raw[tile.tile_index] === bot.targetPlayer)) {
        if (shortestTiles === null) {
          shortestTiles = new Set(analysis.shortestPathWay.tileList);
        }
        if (shortestTiles.has(tile)) continue;
      }

      if (tile.player() !== -1) matrix.raw[tile.tile_index] -= 0.6;

      for (var a = 0; a < tile.adjacents.length; a++) {
        var adj = tile.adjacents[a];
        if (!adj.discovered && !adj.isObstacle) matrix.raw[tile.tile_index] -= 0.1;
        if (
          bot.targetPlayer !== -1 &&
          (adj.player() === bot.targetPlayer || territoryMap.raw[adj.tile_index] === bot.targetPlayer)
        ) {
          matrix.raw[tile.tile_index] = 0.0;
          break;
        }
      }
    }

    return matrix;
  };

  BotExpansionOps.get_unexpandable_ratio = function (bot) {
    var map = bm(bot);
    var fromTiles = map.players[bot.general.player()].tiles;
    var nearby = [];

    EK.search.breadth_first_foreach_dist_fast_incl_neut_cities(map, fromTiles, 8, function (tile) {
      var isFriendly = map.is_tile_friendly(tile);
      if (tile.isCity && !isFriendly && tile.army > 0) return true;
      if (!isFriendly) nearby.push(tile);
      return false;
    });

    if (nearby.length === 0) return 1.0;

    var remainingCycleTurns = map.remainingCycleTurns;
    if (nearby.length < remainingCycleTurns) {
      return 0.4 + (remainingCycleTurns - nearby.length) / remainingCycleTurns;
    }

    var numDesert = 0;
    var numSwamp = 0;
    var numVisible = 0;
    for (var i = 0; i < nearby.length; i++) {
      var t = nearby[i];
      if (t.visible) numVisible += 1;
      if (t.isDesert) numDesert += 1;
      if (t.isSwamp) numSwamp += 1;
    }

    var ratioBad = numSwamp / nearby.length + numDesert / Math.max(1, numVisible);
    return ratioBad;
  };

  BotExpansionOps._get_standard_expansion_capture_weight_matrix = function (bot) {
    var map = bm(bot);
    var matrix = new EK.MapMatrix(map, 0.0);
    var analysis = bot.board_analysis.intergeneral_analysis;
    var innerChokes = bot.board_analysis.innerChokes;

    var dontRevealCities =
      bot.targetPlayer !== -1 &&
      bot.opponent_tracker.winning_on_economy(1.05) &&
      !bot.opponent_tracker.winning_on_army(1.10);

    var genPosesToConsider = (bot.alt_en_gen_positions[bot.targetPlayer] || []).slice();
    var numEnGenPos = genPosesToConsider.length;
    var enPotentialGenDistances = bot._alt_en_gen_position_distances[bot.targetPlayer];

    var searchingForFirstContact = false;
    if (bot.targetPlayer !== -1 && !bot.armyTracker.seen_player_lookup[bot.targetPlayer]) {
      searchingForFirstContact = true;
    }

    var emergenceCount = 0;
    if (bot.targetPlayerObj !== null && bot.targetPlayerObj !== undefined) {
      var events = bot.armyTracker.uneliminated_emergence_events[bot.targetPlayer];
      emergenceCount = events ? events.length : 0;
    }
    var searchingForEnemyLand = bot.targetPlayer !== -1 && emergenceCount < 2;

    if (numEnGenPos > 5) {
      var sum = 0;
      for (var s = 0; s < genPosesToConsider.length; s++) sum += analysis.aMap.raw[genPosesToConsider[s].tile_index];
      var avgDist = sum / genPosesToConsider.length;
      genPosesToConsider = genPosesToConsider.filter(function (t) {
        return analysis.aMap.raw[t.tile_index] >= avgDist;
      });
      numEnGenPos = genPosesToConsider.length;
      enPotentialGenDistances = null;
    }

    if (enPotentialGenDistances === null || enPotentialGenDistances === undefined) {
      enPotentialGenDistances = EK.search.build_distance_map_matrix(map, genPosesToConsider);
      bot._alt_en_gen_position_distances[bot.targetPlayer] = enPotentialGenDistances;
    }
    var tgPlayerTerritoryDists = bot.territories.territoryDistances[bot.targetPlayer];

    if (dontRevealCities) {
      var defendCities = (bot.win_condition_analyzer && bot.win_condition_analyzer.defend_cities) || [];
      for (var c = 0; c < defendCities.length; c++) {
        var city = defendCities[c];
        var cityDist = tgPlayerTerritoryDists.raw[city.tile_index];
        for (var cm = 0; cm < city.movable.length; cm++) {
          var ct = city.movable[cm];
          if (ct.isNeutral && tgPlayerTerritoryDists.raw[ct.tile_index] < cityDist) {
            matrix.raw[ct.tile_index] -= 100;
          }
        }
      }
    }

    if (bot.enemy_attack_path !== null && bot.enemy_attack_path !== undefined) {
      var gp = bot.target_player_gather_path;
      var gpSet = gp ? gp.tileSet : new Set();
      for (var e = 0; e < bot.enemy_attack_path.tileList.length; e++) {
        var et = bot.enemy_attack_path.tileList[e];
        if (!et.visible && !gpSet.has(et)) matrix.raw[et.tile_index] += 0.2;
      }
    }

    if (
      bot.sketchiest_potential_inbound_flank_path !== null &&
      bot.sketchiest_potential_inbound_flank_path !== undefined &&
      bot.targetPlayerObj !== null &&
      bot.targetPlayerObj !== undefined &&
      bot.targetPlayerObj.tiles.length > 0
    ) {
      var cutoff = pyFloorDiv(2 * bot.board_analysis.inter_general_distance, 5);
      var flank = bot.sketchiest_potential_inbound_flank_path;
      var genLoc = bot.targetPlayerExpectedGeneralLocation;

      flank.adjacentSet.forEach(function (tile) {
        if (genLoc !== null && genLoc !== undefined && map.get_distance_between(genLoc, tile) < cutoff) return;
        if (!tile.visible) matrix.raw[tile.tile_index] += 0.03;
        else matrix.raw[tile.tile_index] += 0.015;
      });

      flank.tileSet.forEach(function (tile) {
        if (genLoc !== null && genLoc !== undefined && map.get_distance_between(genLoc, tile) < cutoff) return;
        matrix.raw[tile.tile_index] += 0.05;
      });
    }

    BotExpansionOps._add_super_careful_flank_gath_capture_bonuses(bot, matrix);

    var endOfCyclePenaltyRatio = 35 / (map.cycleTurn + 5);
    if (searchingForFirstContact) endOfCyclePenaltyRatio = 0;

    var neutralScores = bot.cityAnalyzer.get_sorted_neutral_scores().slice(0, 2);
    for (var ns = 0; ns < neutralScores.length; ns++) {
      var cityTile = neutralScores[ns][0];
      var scoreData = neutralScores[ns][1];
      if (scoreData.general_distances_ratio < 1.1) {
        for (var adjI = 0; adjI < cityTile.adjacents.length; adjI++) {
          var adj2 = cityTile.adjacents[adjI];
          if (map.is_tile_enemy(adj2)) matrix.raw[adj2.tile_index] += 0.5;
          if (adj2.isNeutral && !adj2.isUndiscoveredObstacle && scoreData.general_distances_ratio > 0.6) {
            matrix.raw[adj2.tile_index] += Math.max(0.0, 0.05 * (scoreData.general_distances_ratio - 0.1));
            if (!adj2.discovered) {
              matrix.raw[adj2.tile_index] += Math.max(0.0, 0.05 * (scoreData.general_distances_ratio - 0.1));
            }
          }
        }
      }
    }

    var numOpts = bot.threats_we_care_about_by_tile !== null && bot.threats_we_care_about_by_tile !== undefined
      ? bot.threats_we_care_about_by_tile.size
      : 0;
    if (bot.enemy_expansion_plan !== null && bot.enemy_expansion_plan !== undefined) {
      numOpts += bot.enemy_expansion_plan.all_paths.length;
      for (var ep = 0; ep < bot.enemy_expansion_plan.all_paths.length; ep++) {
        var enPath = bot.enemy_expansion_plan.all_paths[ep];
        matrix.raw[enPath.start.tile.tile_index] += enPath.econValue / numOpts;
        for (var ptI = 1; ptI < enPath.tileList.length; ptI++) {
          var ptTile = enPath.tileList[ptI];
          if (map.is_tile_friendly(ptTile)) {
            matrix.raw[ptTile.tile_index] -= bot.expansion_enemy_expansion_plan_inbound_penalty * endOfCyclePenaltyRatio;
          }
        }
      }
    }

    map.lookouts.forEach(function (lookout) {
      for (var m = 0; m < lookout.movableNoObstacles().length; m++) {
        var tile = lookout.movableNoObstacles()[m];
        if (
          (bot.targetPlayer === -1 && !map.is_tile_friendly(tile)) ||
          (bot.targetPlayer >= 0 && map.is_tile_on_team_with(tile, bot.targetPlayer))
        ) {
          matrix.raw[tile.tile_index] += 0.5;
        } else if (tile.player() === -1) {
          matrix.raw[tile.tile_index] += 0.25;
        }
      }
    });

    map.observatories.forEach(function (observatory) {
      for (var m = 0; m < observatory.movableNoObstacles().length; m++) {
        var tile = observatory.movableNoObstacles()[m];
        if (
          (bot.targetPlayer === -1 && !map.is_tile_friendly(tile)) ||
          (bot.targetPlayer >= 0 && map.is_tile_on_team_with(tile, bot.targetPlayer))
        ) {
          matrix.raw[tile.tile_index] += 0.5;
        } else if (tile.player() === -1) {
          matrix.raw[tile.tile_index] += 0.25;
        }
      }
    });

    var flankableFog = bot.board_analysis.flankable_fog_area_matrix;
    var flankDanger = bot.board_analysis.flank_danger_play_area_matrix;
    var validGenPos = bot.armyTracker.valid_general_positions_by_player[bot.targetPlayer];
    var remainingCycleTurns = map.remainingCycleTurns;
    var withinExtended = bot.board_analysis.within_extended_play_area_threshold;
    var interGenDist = bot.board_analysis.inter_general_distance;
    var turn = map.turn;

    var allTiles = map.get_all_tiles();
    for (var i = 0; i < allTiles.length; i++) {
      var tile = allTiles[i];
      var bonus = matrix.raw[tile.tile_index];
      if (innerChokes.raw[tile.tile_index]) bonus += 0.002;

      var enDist = enPotentialGenDistances.raw[tile.tile_index];
      var genDist = map.get_distance_between(bot.general, tile);

      var isCloserToEn = enDist < genDist * 0.8;
      var enDistRatio = ((genDist + 5) / Math.max(1, enDist + pyFloorDiv(numEnGenPos, 3))) * 0.8;

      var enExpVal = bot.enemy_expansion_plan_tile_path_cap_values.get(tile);
      if (enExpVal !== null && enExpVal !== undefined) bonus += enExpVal / 2;

      // 原版是 bot.board_analysis.intergeneral_analysis.is_choke(tile)（BotExpansionOps.py:2175）
      if (bot.board_analysis.intergeneral_analysis
        && bot.board_analysis.intergeneral_analysis.is_choke(tile)) bonus += 0.01;

      var isNeutral = tile.isNeutral;
      var isFriendly = !isNeutral && map.is_tile_friendly(tile);
      var isTarget = !isNeutral && map.is_player_on_team_with(tile.player(), bot.targetPlayer);

      if (isFriendly && tile.army < 2) bonus -= 0.02;

      if (tile.isSwamp) {
        if (isTarget) bonus -= 4.0;
        else if (isNeutral) bonus -= 2.0;
      }

      if (tile.isDesert) {
        if (isTarget) bonus -= 2.0;
        else if (isNeutral) bonus -= 1.0;
      }

      var anyFlankVis = false;
      for (var vi = 0; vi < tile.adjacents.length; vi++) {
        if (flankableFog.raw[tile.adjacents[vi].tile_index]) {
          anyFlankVis = true;
          break;
        }
      }
      if (anyFlankVis) bonus += 0.02;

      if (tile.player() === -1 && tgPlayerTerritoryDists.raw[tile.tile_index] < 2) bonus += 0.02;

      if (searchingForEnemyLand && (isNeutral || isTarget)) {
        var fogContactBonus = 0.0;
        if (!tile.discovered) fogContactBonus += 0.05;
        if (validGenPos.raw[tile.tile_index]) fogContactBonus += 0.18;
        if (enDist < genDist) {
          var fogContactEnDistBonus = (0.2 * (genDist - enDist)) / Math.max(1, interGenDist);
          fogContactBonus += Math.min(0.25, fogContactEnDistBonus);
        }
        if (anyFlankVis) fogContactBonus += 0.05;
        bonus += fogContactBonus;
      }

      if (tile.isCity) {
        var cityScore = bot.cityAnalyzer.city_scores.get(tile);
        var isCityGapping =
          (cityScore === null || cityScore === undefined || cityScore.intergeneral_distance_differential > 0) &&
          !map.is_tile_friendly(tile);
        for (var ci = 0; ci < tile.adjacents.length; ci++) {
          var cvis = tile.adjacents[ci];
          if (cvis.isNotPathable || map.is_tile_friendly(cvis)) continue;
          if (
            isCloserToEn ||
            !isCityGapping ||
            enPotentialGenDistances.raw[tile.tile_index] <= enPotentialGenDistances.raw[cvis.tile_index]
          ) {
            matrix.raw[cvis.tile_index] += 0.05;
          }
        }
      }

      if (isTarget) {
        if (tile.army > 1) bonus += 0.02 + Math.min(50, tile.army) * 0.02;
      }

      if (isTarget && bot.territories.is_tile_in_friendly_territory(tile)) bonus += 0.05;

      if (isNeutral || isTarget) {
        var libertyCount = 0;
        for (var mi = 0; mi < tile.movable.length; mi++) {
          var mv = tile.movable[mi];
          if (!mv.isObstacle && !(mv.isNeutral && mv.army > 1)) libertyCount += 1;
        }
        if (libertyCount === 1) {
          bonus += 0.1;
          if (isTarget) bonus += 0.3;
        }
      }

      var pathway = analysis.pathWayLookupMatrix.raw[tile.tile_index];
      if (pathway !== null && pathway !== undefined) {
        var extendedDist = pathway.distance - withinExtended;
        var outsideExtendedPlay = extendedDist > 0;
        var inFlankDanger = flankDanger.raw[tile.tile_index] ? true : false;
        var anyFogOnPath = false;
        if (inFlankDanger) {
          for (var pw = 0; pw < pathway.tiles.length; pw++) {
            var pwt = pathway.tiles[pw];
            if (!pwt.visible && flankableFog.raw[pwt.tile_index]) {
              anyFogOnPath = true;
              break;
            }
          }
        }
        if (outsideExtendedPlay && !(inFlankDanger && anyFogOnPath)) {
          var isEnTile = map.is_player_on_team_with(bot.targetPlayer, tile.player());
          if (isEnTile) {
            var factor = 0.25;
            if (!tile.discovered) factor = 0.15;
            bonus -= factor / Math.max(4, 15 - extendedDist);
          } else {
            bonus -= 0.4 / Math.max(4, 15 - extendedDist);
          }
        }
      } else {
        bonus -= 10;
      }

      if (remainingCycleTurns > 8 && !searchingForFirstContact && turn > 150) {
        var cappedRat = Math.max(1.1, enDistRatio);
        if (tile.player() === -1) bonus += 0.1 - 0.05 * cappedRat;
        else bonus += 0.06 - 0.03 * cappedRat;
      }

      var excessDist = enPotentialGenDistances.raw[tile.tile_index] - interGenDist - numEnGenPos;
      if (excessDist > 0) bonus -= (0.1 * excessDist) / Math.max(2, genPosesToConsider.length);

      if (map.is_tile_friendly(tile)) {
        if (tile.army < 2) bonus -= 0.05;
        matrix.raw[tile.tile_index] = Math.min(bonus, 0.0);
      } else {
        matrix.raw[tile.tile_index] = bonus;
      }
    }

    return matrix;
  };

  // 供 diff / 上层使用
  EK.ExpansionPotential = ExpansionPotential;
  EK.BotExpansionOps = BotExpansionOps;
  EK.expansionops = BotExpansionOps;
})(typeof globalThis !== 'undefined' ? globalThis : this);
