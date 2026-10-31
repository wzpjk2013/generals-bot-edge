/*
 * ArmyInterceptor 移植
 *
 * 原版：E:\akcoco6de\_research\generals-bot-cs\Behavior\ArmyInterceptor.py（2609 行）
 *
 * 算法一句话：给定一组从同一格出发的敌方威胁路径，先找出这些路径共同经过的「枢纽格」(shared choke)，
 * 再在枢纽格附近找「用最少的兵、最少的回合」能挡住威胁的己方格，逐条模拟两军对撞（四个兜底场景），
 * 最后把「拦截净收益」写成 turnsToIntercept -> 最优方案 的字典，交给上层按回合数做背包选择。
 *
 * 与 JS 框架的差异（为什么这么改）：
 * 1. 原版 map.euclidDist 在 JS 版 Map 上没有实现（只有 manhattan_dist）。本引擎无环面地图，直接 sqrt 就等价，
 *    所以文件内自带 _euclidDist，而不是去改 src/eklipz/map.js（那会连带影响其它已验收模块）。
 * 2. 原版 tile.player 是属性，JS 版 Tile.player() 是方法 —— 全部改成调用；漏掉一处就会把函数对象当数字比较，
 *    表现为「所有格都不属于我」，所以这一处统一走 _playerOf 收口。
 * 3. 原版 tileDistancesLookup 是 dict[int, set[Tile]]，JS 版可能是普通对象也可能是 Map —— _distLookup 统一兼容，
 *    顺便把「键不存在」收敛成 null，对应原版 .get(k, None) 的语义。
 * 4. 原版 chokeWidths / interceptChokes / interceptDistances / aMap / bMap 是 MapMatrix，支持 [] 下标；JS 没这东西，
 *    统一走 .raw[tile_index]，并由 _matGet 把越界/undefined 收敛成 null（原版也是 None 语义），否则
 *    `undefined > 0` 会静默变成 false，把「未知」当成「有值」。
 * 5. 原版 view_info / logbook / DebugHelper 只为输出。这里收口成 this._log（可选回调），非 debug 时零开销。
 * 6. 原版靠 perf_timer 限时；JS 的 search 内部自带 maxTime(0.2s) 与 maxIterations，这里不再重复计时。
 * 7. EK.search.breadth_first_foreach_fast_no_neut_cities 只认数组（它读 .length），传 Set 进去会一格都不遍历、
 *    而且不报错。原版传的是 shortestPathWay.tiles（一个 set），所以这里先转数组再传。
 * 8. JS 的 map.get_teammates 返回数组，且末尾塞了 -1 当「中立」哨兵；原版返回 set 且不含 -1。
 *    统一由 _teamSet 收口成 Set 并剔掉 -1，否则中立格会被当成敌方兵力算进 _advance_enemy_physical_army。
 * 9. 已知唯一的非等价点：等距平手。原版 _get_middlest_intercept_tiles_for_threat_values 从 python set 取
 *    「离质心最近」的格子，距离相等时先遍历到谁就取谁，而 python set 的遍历序由对象 id 决定（不可复现）；
 *    这里固定取 tile_index 最小的那个。影响仅限于「同一跳数上有两格等距」时选中的枢纽格不同，
 *    实测最终 intercept_options（经济值/turns/路径）仍然一致，只有 common_intercept_chokes 的成员偶尔差一格。
 */

(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  var DEBUG_BYPASS_BAD_INTERCEPTIONS = true;

  // 这几个常数是「值不值」的标尺，改动会直接改变 intercept 和 expand 的取舍，别随手调。
  var TARGET_CAP_VALUE = 2.1;
  var OTHER_PARTY_CAP_VALUE = 0.5;
  var NEUTRAL_CAP_VALUE = 1.0;
  var GENERAL_CAP_VALUE = 8.0;
  var OWNED_CITY_CAP_VALUE_BONUS = 5;
  // 必须比普通扩张的点值高，否则 bot 会宁可去抢中立城也不拦截（原版注释里踩过这个坑）。
  var RECAPTURE_VALUE = 2.1;

  function _euclidDist(x1, y1, x2, y2) {
    var dx = x1 - x2;
    var dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function _playerOf(tile) {
    if (tile === null || tile === undefined) return -1;
    if (typeof tile.player === 'function') return tile.player();
    return tile.player;
  }

  function _matGet(mat, tile) {
    if (mat === null || mat === undefined) return null;
    var raw = mat.raw;
    if (raw === undefined) raw = mat;
    var v = raw[tile.tile_index];
    return v === undefined ? null : v;
  }

  /* PathWay.tiles 在 JS 是 Set（原版是 set），不能按数组用 indexOf */
  function _setHas(coll, item) {
    if (coll === null || coll === undefined) return false;
    if (typeof coll.has === 'function') return coll.has(item);
    if (Array.isArray(coll)) return coll.indexOf(item) >= 0;
    return false;
  }

  function _distLookup(lookup, dist) {
    if (lookup === null || lookup === undefined) return null;
    var v;
    if (typeof lookup.get === 'function') v = lookup.get(dist);
    else v = lookup[dist];
    return v === undefined ? null : v;
  }

  function _teamSet(map, player) {
    // JS 的 map.get_teammates 返回数组（末尾还塞了个 -1 当「中立」哨兵），
    // 原版返回的是 set，且不含 -1；这里统一成 Set 并剔掉哨兵，否则中立格会被当成敌方算兵。
    var tm = map.get_teammates(player);
    if (tm === null || tm === undefined) return new Set();
    var out = new Set();
    if (typeof tm.forEach === 'function' && typeof tm.has === 'function') {
      tm.forEach(function (p) {
        if (p !== -1) out.add(p);
      });
      return out;
    }
    for (var i = 0; i < tm.length; i++) {
      if (tm[i] !== -1) out.add(tm[i]);
    }
    return out;
  }

  function _isOnTeamWith(map, tile, player) {
    if (player === null || player === undefined || player < 0) return false;
    return _playerOf(tile) === player || map.is_player_on_team_with(_playerOf(tile), player);
  }

  function _sortTilesByIndex(tiles) {
    var arr = Array.from(tiles);
    arr.sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    return arr;
  }

  /* ==================================================================
   * ThreatValueInfo
   * ================================================================== */

  function ThreatValueInfo(threat, econValue, turns, positiveSubsegmentTileSet) {
    this.threat = threat;
    this.econ_value = econValue;
    this.turns_used_by_enemy = turns;
    this.econ_value_per_turn = econValue / Math.max(1, turns);
    this.positive_subsegment_tileset = positiveSubsegmentTileSet;
  }

  ThreatValueInfo.prototype.toString = function () {
    return (
      'Threat ' + this.threat.path.start.tile + '-->' + this.threat.path.tail.tile +
      ' (econ ' + this.econ_value.toFixed(2) + ', turns ' + this.turns_used_by_enemy +
      ', vt ' + this.econ_value_per_turn.toFixed(2) + ') ' + this.threat
    );
  };

  /* ==================================================================
   * ThreatBlockInfo —— 「这格需要多少兵才挡得住，挡住后哪些目的地被堵」
   * ================================================================== */

  function ThreatBlockInfo(tile, amountNeededToBlock) {
    this.tile = tile;
    this.amount_needed_to_block = amountNeededToBlock;
    // 原版用 list 不用 set：最多 4 个元素时 list 的查找更快，且要保序。
    this.blocked_destinations = [];
  }

  ThreatBlockInfo.prototype.add_blocked_destination = function (tile) {
    if (this.blocked_destinations.indexOf(tile) < 0) this.blocked_destinations.push(tile);
  };

  ThreatBlockInfo.prototype.toString = function () {
    var names = [];
    for (var i = 0; i < this.blocked_destinations.length; i++) names.push('' + this.blocked_destinations[i]);
    return this.tile + ':' + this.amount_needed_to_block + '@' + names.join('|');
  };

  /* ==================================================================
   * InterceptCollisionResult / InterceptPointTileInfo
   * ================================================================== */

  function InterceptCollisionResult(
    turnsLeft,
    friendlyArmyAtIntercept,
    bestCaseInterceptTurn,
    worstCaseInterceptTurn,
    enemyInterceptPointNode,
    enemyPhysicalArmyAtIntercept
  ) {
    this.turns_left = turnsLeft;
    this.friendly_army_at_intercept = friendlyArmyAtIntercept;
    this.best_case_intercept_turn = bestCaseInterceptTurn;
    this.worst_case_intercept_turn = worstCaseInterceptTurn;
    this.enemy_intercept_point_node = enemyInterceptPointNode;
    this.enemy_physical_army_at_intercept = enemyPhysicalArmyAtIntercept;
  }

  function InterceptPointTileInfo(tile, maxDelayTurns, maxExtraMoves, maxChokeWidth, maxInterceptTurnOffset) {
    this.tile = tile;
    // 最晚必须在这个回合前到达此格，否则后续损失挡不住
    this.max_delay_turns = maxDelayTurns;
    // 从这格出发补刀，最坏情况还要多走几步
    this.max_extra_moves_to_capture = maxExtraMoves;
    this.max_choke_width = maxChokeWidth;
    this.max_intercept_turn_offset = maxInterceptTurnOffset;
    // 原版初值 30：用来砍掉「搜下去也没意义」的枢纽格，控制搜索时间
    this.max_search_dist = 30;
  }

  InterceptPointTileInfo.prototype.toString = function () {
    return (
      this.tile + ' - it' + this.max_delay_turns + ', cw' + this.max_choke_width +
      ', ic' + this.max_intercept_turn_offset + ', im' + this.max_extra_moves_to_capture
    );
  };

  /* ==================================================================
   * InterceptionOptionInfo —— 一条具体拦截方案的账本
   * 原版继承 TilePlanInterface，这里只保留被 interceptor / defense 实际用到的成员。
   * ================================================================== */

  function InterceptionOptionInfo(
    path,
    econValue,
    turns,
    damageBlocked,
    interceptingArmyRemaining,
    bestCaseInterceptMoves,
    worstCaseInterceptMoves,
    recaptureTurns,
    requiredDelay,
    friendlyArmyReachingIntercept
  ) {
    if (path === null || path === undefined || path.start === null || path.start === undefined) {
      throw new Error('Wtf, dont pass interception a bad path :V ' + path);
    }
    this.path = path;
    this._econ_value = econValue;
    this._turns = turns;
    this.damage_blocked = damageBlocked;
    this.intercepting_army_remaining = interceptingArmyRemaining;
    this.recapture_turns = recaptureTurns;
    this.best_case_intercept_moves = bestCaseInterceptMoves;
    this.worst_case_intercept_moves = worstCaseInterceptMoves;
    this._requiredDelay = requiredDelay;
    this.friendly_army_reaching_intercept = friendlyArmyReachingIntercept;
    this.intercept = null;
    this._tileSet = null;
    this._tileList = null;
  }

  Object.defineProperty(InterceptionOptionInfo.prototype, 'post_intercept_implied_moves', {
    get: function () {
      return this._turns - this.path.length;
    }
  });

  Object.defineProperty(InterceptionOptionInfo.prototype, 'length', {
    get: function () {
      return Math.max(this._turns, this.path.length + this.recapture_turns, this.best_case_intercept_moves);
    }
  });

  Object.defineProperty(InterceptionOptionInfo.prototype, 'turns', {
    get: function () {
      return this._turns;
    }
  });

  Object.defineProperty(InterceptionOptionInfo.prototype, 'econValue', {
    get: function () {
      return this._econ_value;
    },
    set: function (v) {
      this._econ_value = v;
    }
  });

  Object.defineProperty(InterceptionOptionInfo.prototype, 'requiredDelay', {
    get: function () {
      return this._requiredDelay;
    }
  });

  Object.defineProperty(InterceptionOptionInfo.prototype, 'tiles', {
    get: function () {
      return this.path.tiles;
    }
  });

  Object.defineProperty(InterceptionOptionInfo.prototype, 'tileList', {
    get: function () {
      if (this._tileList === null) {
        this._tileList = this.path.tileList.slice();
        this._tileList.push(this.intercept.target_tile);
      }
      return this._tileList;
    }
  });

  Object.defineProperty(InterceptionOptionInfo.prototype, 'tileSet', {
    get: function () {
      if (this._tileSet === null) this._tileSet = new Set(this.tileList);
      return this._tileSet;
    }
  });

  InterceptionOptionInfo.prototype.get_move_list = function () {
    return this.path.get_move_list();
  };

  InterceptionOptionInfo.prototype.get_first_move = function () {
    return this.path.get_first_move();
  };

  InterceptionOptionInfo.prototype.pop_first_move = function () {
    return this.path.pop_first_move();
  };

  InterceptionOptionInfo.prototype.str_start = function () {
    var tgTile = 'NONE';
    if (this.intercept !== null) tgTile = '' + this.intercept.target_tile;
    return (
      this.path.tileList[0] + '>' + this.path.tileList[1] + '..' + this.path.tail.tile + '@' + tgTile
    );
  };

  InterceptionOptionInfo.prototype.str_details = function () {
    return (
      'del' + this.requiredDelay + ', rc' + this.recapture_turns +
      ', blk' + this.damage_blocked.toFixed(1) + ', ear' + this.intercepting_army_remaining +
      ', bct' + this.best_case_intercept_moves + ', wct' + this.worst_case_intercept_moves
    );
  };

  InterceptionOptionInfo.prototype.toString = function () {
    return (
      'int ' + this.str_start() + ': ' + this.econValue.toFixed(2) + 'v/' + this._turns + 't (' +
      (this._econ_value / Math.max(1, this._turns)).toFixed(2) + 'vt), ' + this.str_details()
    );
  };

  InterceptionOptionInfo.prototype.clone = function () {
    var c = new InterceptionOptionInfo(
      this.path.clone(),
      this.econValue,
      this._turns,
      this.damage_blocked,
      this.intercepting_army_remaining,
      this.best_case_intercept_moves,
      this.worst_case_intercept_moves,
      this.recapture_turns,
      this._requiredDelay,
      this.friendly_army_reaching_intercept
    );
    c.intercept = this.intercept;
    c._tileList = this._tileList;
    c._tileSet = this._tileSet;
    return c;
  };

  /* ==================================================================
   * ArmyInterception —— 一次「多威胁 -> 一个公共拦截点」的分析结果容器
   * ================================================================== */

  function ArmyInterception(threats, ignoredThreats) {
    this.threat_values = threats;
    this.threats = [];
    for (var i = 0; i < threats.length; i++) this.threats.push(threats[i].threat);

    this.ignored_threats = ignoredThreats || [];

    this.base_threat_army = 0;
    this.common_intercept_chokes = new Map();
    this.middlest_intercept_tiles = new Set();
    this.furthest_common_intercept_distances = null;
    this.target_tile = threats[0].threat.path.start.tile;

    // 早期回合的拦截除了挡伤害，还逼对面来回折返，额外白赚 4+ 伤害，所以给一点点奖励
    this.sparse_recapture_bonus = 1.0;

    var maxValPerTurn = -100000;
    var maxThreatInfo = null;
    var isMaxThreatKill = false;

    var killThreats = [];
    // 先扫「能杀我们」的威胁，让它们优先占据 best 位
    for (var k = 0; k < threats.length; k++) {
      var ti = threats[k];
      if (ti.threat.threatType !== EK.ThreatType.Kill || ti.threat.threatValue < 0) continue;
      killThreats.push(ti);

      var valPerTurn = ti.econ_value_per_turn;
      // 平手时偏好更短的路径（原版此处是 -=1 的诡异写法，照抄以免改变取舍）
      if (valPerTurn === maxValPerTurn && ti.threat.path.length < maxThreatInfo.threat.path.length) {
        maxValPerTurn -= 1;
      }
      if (valPerTurn > maxValPerTurn) {
        maxValPerTurn = valPerTurn;
        maxThreatInfo = ti;
        isMaxThreatKill = true;
      }
    }

    this.kill_enemy_threat = maxThreatInfo;

    this.positive_threat_subsegment_negative_tile_indexes = new Set();

    // 再扫非 kill 的：它们的「正收益子段」是绝不能当成可走路过的格
    for (var n = 0; n < threats.length; n++) {
      var info = threats[n];
      info.positive_subsegment_tileset.forEach(function (t) {
        this.positive_threat_subsegment_negative_tile_indexes.add(t);
      }, this);
      if (killThreats.indexOf(info) >= 0) continue;

      var vpt = info.econ_value_per_turn;
      if (
        vpt > maxValPerTurn ||
        (vpt === maxValPerTurn &&
          info.threat.path.length > maxThreatInfo.threat.path.length &&
          !isMaxThreatKill)
      ) {
        isMaxThreatKill = false;
        maxValPerTurn = vpt;
        maxThreatInfo = info;
      }
    }

    this.best_enemy_threat = maxThreatInfo;
    if (this.kill_enemy_threat === null) this.kill_enemy_threat = this.best_enemy_threat;

    this.distance_from_threat_to_contestable_en_city = -1;

    this.intercept_options = new Map();
  }

  ArmyInterception.prototype.get_intercept_plan_values_by_path = function (path) {
    var ret = [null, null];
    this.intercept_options.forEach(function (optionInfo, dist) {
      if (ret[0] !== null) return;
      var p = optionInfo.path;
      if (p.start.tile === path.start.tile && p.tail.tile === path.tail.tile) {
        ret[0] = dist;
        ret[1] = optionInfo.econValue;
      }
    });
    return ret;
  };

  ArmyInterception.prototype.get_intercept_option_by_path = function (path) {
    if (path instanceof InterceptionOptionInfo) return path;
    if (!(path instanceof EK.Path)) return null;
    var found = null;
    this.intercept_options.forEach(function (optionInfo) {
      if (found !== null) return;
      var p = optionInfo.path;
      if (p.start.tile === path.start.tile && p.tail.tile === path.tail.tile) found = optionInfo;
    });
    return found;
  };

  /* ==================================================================
   * ArmyInterceptor
   * ================================================================== */

  function ArmyInterceptor(map, boardAnalysis, useDebugLogging, viewInfo) {
    this.map = map;
    this.board_analysis = boardAnalysis || null;
    this.log_debug = !!useDebugLogging;
    this._log = null;
    this.view_info = viewInfo || null;
  }

  ArmyInterceptor.prototype.get_interception_plan = function (
    threats,
    turnsLeftInCycle,
    otherThreatsBlockingTiles,
    opponentTracker,
    contestableEnemyCities
  ) {
    if (otherThreatsBlockingTiles === undefined || otherThreatsBlockingTiles === null) otherThreatsBlockingTiles = null;
    if (contestableEnemyCities === undefined) contestableEnemyCities = null;

    var pruned = this._prune_threats_to_valuable_threat_info(threats, turnsLeftInCycle);
    var threatValues = pruned[0];
    var ignoredThreats = pruned[1];

    if (opponentTracker === null || opponentTracker === undefined) {
      opponentTracker = new EK.OpponentTracker(this.map);
      // 原版在这里现算一个 tracker；没有威胁时不能取 threats[0]
      if (threats.length > 0) opponentTracker.analyze_turn(threats[0].threatPlayer);
    }

    if (threatValues.length === 0) return null;

    var interception = new ArmyInterception(threatValues, ignoredThreats);
    interception.distance_from_threat_to_contestable_en_city = this._get_distance_from_threat_to_contestable_enemy_city(
      interception,
      contestableEnemyCities
    );

    interception.common_intercept_chokes = this.get_shared_chokes(interception.threat_values, interception);

    interception.base_threat_army = this._get_threats_army_amount(threats);

    interception.intercept_options = this._get_intercept_plan_options(
      interception,
      turnsLeftInCycle,
      opponentTracker,
      otherThreatsBlockingTiles
    );

    if (interception.intercept_options.size === 0) {
      // 全部砍光就没得拦了；放宽到「不是从自己脚下出发的威胁」再试一次
      var altThreatValues = [];
      for (var i = 0; i < threatValues.length; i++) {
        var t = threatValues[i];
        var firstMoveDest = t.threat.path.get_first_move().dest;
        var fromTile = t.threat.path.start.tile.delta ? t.threat.path.start.tile.delta.fromTile : null;
        if (firstMoveDest !== fromTile) altThreatValues.push(t);
      }

      if (threatValues.length > altThreatValues.length && altThreatValues.length > 0) {
        var newIgnored = [];
        for (var j = 0; j < threatValues.length; j++) {
          if (altThreatValues.indexOf(threatValues[j]) < 0) newIgnored.push(threatValues[j].threat);
        }
        Array.prototype.push.apply(newIgnored, ignoredThreats);
        interception = new ArmyInterception(altThreatValues, newIgnored);
        interception.common_intercept_chokes = this.get_shared_chokes(interception.threat_values, interception);
        interception.base_threat_army = this._get_threats_army_amount(interception.threats);
        interception.intercept_options = this._get_intercept_plan_options(
          interception,
          turnsLeftInCycle,
          opponentTracker,
          otherThreatsBlockingTiles
        );
      }
    }

    if (interception.intercept_options.size === 0) {
      // 最后兜底：允许用非「middlest」的深度为正的拦截点
      interception.intercept_options = this._get_intercept_plan_options(
        interception,
        turnsLeftInCycle,
        opponentTracker,
        otherThreatsBlockingTiles,
        true
      );
    }

    return interception;
  };

  ArmyInterceptor.prototype.get_shared_chokes = function (threats, interceptData) {
    var self = this;
    var commonChokesCounts = new Map();
    var commonMinDelayTurns = new Map();
    var commonMaxExtraMoves = new Map();

    for (var ti = 0; ti < threats.length; ti++) {
      var threatValueInfo = threats[ti];
      var threat = threatValueInfo.threat;
      var intChokes = threat.armyAnalysis.interceptChokes;
      var intTurnsMat = threat.armyAnalysis.interceptTurns;
      var intDistMat = threat.armyAnalysis.interceptDistances;

      var foreachFunc = (function (curThreat) {
        return function (tile) {
          var interceptMoves = _matGet(intChokes, tile);
          if (interceptMoves === null) return;

          var delayTurns = _matGet(intTurnsMat, tile);
          if (delayTurns === null || delayTurns > 800 || delayTurns > curThreat.turns + 1) return;

          var worstCaseExtraMoves = _matGet(intDistMat, tile);

          var curCount = commonChokesCounts.has(tile) ? commonChokesCounts.get(tile) : 0;
          var curExtraMoves = commonMaxExtraMoves.has(tile) ? commonMaxExtraMoves.get(tile) : 0;
          var curMinDelayTurns = commonMinDelayTurns.has(tile) ? commonMinDelayTurns.get(tile) : 1000;
          commonChokesCounts.set(tile, curCount + 1);
          commonMaxExtraMoves.set(tile, Math.max(worstCaseExtraMoves, curExtraMoves));
          commonMinDelayTurns.set(tile, Math.min(curMinDelayTurns, delayTurns));
        };
      })(threat);

      this.ensure_threat_army_analysis(threat);
      // shortestPathWay.tiles 是 Set；EK.search 的那个 foreach 只认数组（它读 .length），
      // 传 Set 进去会静默一格都不遍历，所以这里先转数组并按 tile_index 排序保证确定性。
      EK.search.breadth_first_foreach_fast_no_neut_cities(
        this.map,
        _sortTilesByIndex(threat.armyAnalysis.shortestPathWay.tiles),
        1,
        foreachFunc
      );
    }

    var sharedThreshold = 0;
    var validChokeOptCount = 0;
    var validThresh = Math.min(threats.length - 1, 1);

    // 威胁起点自身和它的两跳邻域不能算「公共」枢纽：它们对每个威胁都成立，没有信息量
    var skips = new Set();
    var startMovable = threats[0].threat.path.start.tile.movable;
    for (var sm = 0; sm < startMovable.length; sm++) {
      var twoHop = startMovable[sm].movable;
      for (var th = 0; th < twoHop.length; th++) skips.add(twoHop[th].tile_index);
    }

    commonChokesCounts.forEach(function (num, tile) {
      if (skips.has(tile.tile_index)) return;
      if (num > validThresh) validChokeOptCount += 1;
      if (num > sharedThreshold) sharedThreshold = num;
    });

    var countMaxShared = 0;
    var minChokesThresh = Math.floor(validChokeOptCount / 3);

    for (;;) {
      commonChokesCounts.forEach(function (num, tile) {
        if (skips.has(tile.tile_index)) return;
        if (num >= sharedThreshold) countMaxShared += 1;
      });

      if (countMaxShared > minChokesThresh) break;
      if (sharedThreshold <= 0) break;
      sharedThreshold -= 1;
      countMaxShared = 0;
    }

    var middlestInterceptTiles = this._get_middlest_intercept_tiles_for_threat_values(threats);

    var potentialSharedChokes = new Set();
    middlestInterceptTiles.forEach(function (tile) {
      if (!commonMinDelayTurns.has(tile) || !commonMaxExtraMoves.has(tile)) return;
      potentialSharedChokes.add(tile);
    });

    var sharedChokes = this._build_shared_chokes(
      potentialSharedChokes,
      commonMaxExtraMoves,
      commonMinDelayTurns,
      threats
    );

    var indexesToKeepIfBad = 1;
    if (
      sharedChokes.size === 1 &&
      threats.length > indexesToKeepIfBad &&
      sharedChokes.has(threats[0].threat.path.start.tile)
    ) {
      // 只剩威胁自己脚下那一格，说明公共枢纽根本没找到；退化成只拦第一个威胁，别硬拦
      for (var oi = indexesToKeepIfBad; oi < threats.length; oi++) {
        interceptData.ignored_threats.push(threats[oi].threat);
      }
      return this.get_shared_chokes(threats.slice(0, indexesToKeepIfBad), interceptData);
    }

    return sharedChokes;
  };

  ArmyInterceptor.prototype._build_shared_chokes = function (
    potentialSharedChokes,
    commonMaxExtraMoves,
    commonMinDelayTurns,
    threats
  ) {
    var sharedChokes = new Map();
    var genBlockTile = null;
    var threatenedGen = null;

    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i].threat;
      if (!threat.path.tail.tile.isGeneral || !this.map.is_tile_friendly(threat.path.tail.tile)) continue;
      if (threat.threatValue < 0) continue;

      threatenedGen = threat.path.tail.tile;

      // 原版切片 tileList[-2:1] = 去掉最后两个之后的全部（看着像笔误，但线上行为就是它，照抄）
      var list = threat.path.tileList;
      var end = Math.max(0, list.length - 2);
      for (var li = 0; li < end; li++) {
        var tile = list[li];
        if (tile.isGeneral) continue;
        var cw = _matGet(threat.armyAnalysis.chokeWidths, tile);
        if (cw === 1) {
          genBlockTile = tile;
          break;
        }
      }

      if (genBlockTile !== null) break;
      if (threat.saveTile !== null && threat.saveTile !== undefined) {
        genBlockTile = threat.saveTile;
        break;
      }
    }

    var blockDist = 1000;
    if (threatenedGen !== null) {
      blockDist = 0;
      if (genBlockTile !== null) {
        blockDist = this.map.distance_mapper.get_distance_between(threatenedGen, genBlockTile);
      }
    }

    potentialSharedChokes.forEach(function (tile) {
      var maxDelayTurns = commonMinDelayTurns.get(tile);
      var maxExtraMoves = commonMaxExtraMoves.get(tile);

      var maxChokeWidth = 0;
      var maxInterceptTurnOffset = 0;
      for (var t = 0; t < threats.length; t++) {
        var th = threats[t].threat;
        var isGenThreat = th.path.tail.tile.isGeneral;
        var ito = _matGet(th.armyAnalysis.interceptChokes, tile);
        var cw2 = _matGet(th.armyAnalysis.chokeWidths, tile);
        // 有将军威胁时，choke 宽度只按将军威胁算：别的威胁的宽窄不影响将军能不能跑掉
        if (cw2 !== null && (threatenedGen === null || isGenThreat)) {
          maxChokeWidth = Math.max(cw2, maxChokeWidth);
        }
        if (ito !== null) maxInterceptTurnOffset = Math.max(ito, maxInterceptTurnOffset);
      }

      sharedChokes.set(
        tile,
        new InterceptPointTileInfo(tile, maxDelayTurns, maxExtraMoves, maxChokeWidth, maxInterceptTurnOffset)
      );
    }, this);

    return sharedChokes;
  };

  ArmyInterceptor.prototype._get_middlest_intercept_tiles_for_threat_values = function (threat_values) {
    var middlestTiles = new Set();

    var tileDistancesLookup = new Map();
    for (var i = 0; i < threat_values.length; i++) {
      var threat = threat_values[i].threat;
      if (threat.armyAnalysis === null || threat.armyAnalysis === undefined) continue;
      var lookup = threat.armyAnalysis.tileDistancesLookup;
      if (lookup === null || lookup === undefined) continue;

      var keys = [];
      if (typeof lookup.forEach === 'function' && typeof lookup.get === 'function') {
        lookup.forEach(function (v, k) {
          keys.push(k);
        });
      } else {
        for (var kk in lookup) {
          if (Object.prototype.hasOwnProperty.call(lookup, kk)) keys.push(Number(kk));
        }
      }

      for (var k = 0; k < keys.length; k++) {
        var dist = keys[k];
        var tiles = _distLookup(lookup, dist);
        if (tiles === null || tiles.length === 0) continue;
        if (!tileDistancesLookup.has(dist)) tileDistancesLookup.set(dist, new Set());
        var distTiles = tileDistancesLookup.get(dist);
        for (var tv = 0; tv < tiles.length; tv++) distTiles.add(tiles[tv]);
      }
    }

    var distKeys = Array.from(tileDistancesLookup.keys());
    distKeys.sort(function (a, b) {
      return a - b;
    });

    for (var di = 0; di < distKeys.length; di++) {
      var tilesAtDist = tileDistancesLookup.get(distKeys[di]);
      if (tilesAtDist.size === 0) continue;

      if (tilesAtDist.size === 1) {
        // 只有一格的距离（起点、终点）无条件收
        tilesAtDist.forEach(function (t) {
          middlestTiles.add(t);
        });
        continue;
      }

      var sorted = _sortTilesByIndex(tilesAtDist);
      var sumX = 0;
      var sumY = 0;
      for (var s = 0; s < sorted.length; s++) {
        sumX += sorted[s].x;
        sumY += sorted[s].y;
      }
      var avgX = sumX / sorted.length;
      var avgY = sumY / sorted.length;

      var bestTile = null;
      var bestDist = 10000;
      for (var b = 0; b < sorted.length; b++) {
        var tileDist = Math.abs(sorted[b].x - avgX) + Math.abs(sorted[b].y - avgY);
        if (tileDist < bestDist) {
          bestDist = tileDist;
          bestTile = sorted[b];
        }
      }
      middlestTiles.add(bestTile);
    }

    return middlestTiles;
  };

  ArmyInterceptor.prototype._get_middlest_intercept_tiles_by_distance = function (interception) {
    return this._get_middlest_intercept_tiles_for_threat_values(interception.threat_values);
  };

  ArmyInterceptor.prototype._get_threats_army_amount = function (threats) {
    var maxAmount = 0;
    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i];
      var curAmount = 0;
      var curTurn = this.map.turn + 1;
      var curOffset = 1;
      var list = threat.path.tileList;
      for (var j = 0; j < list.length; j++) {
        var tile = list[j];
        if (this.map.is_tile_on_team_with(tile, threat.threatPlayer)) {
          curAmount += tile.army - curOffset;
        } else if (tile.army < Math.trunc(threat.threatValue / 5)) {
          curAmount -= tile.army + curOffset;
        }
        if (curTurn % 50 === 0) curOffset += 1;
        curTurn += 1;
      }
      if (curAmount > maxAmount) maxAmount = curAmount;
    }
    return maxAmount;
  };

  ArmyInterceptor.prototype._get_potential_intercept_table = function (turnsLeftInCycle, baseThreatArmy) {
    var table = [];
    for (var i = 0; i < turnsLeftInCycle; i++) table.push(baseThreatArmy + 1.8 * i);
    if (turnsLeftInCycle < 15) {
      for (var j = 0; j < 10; j++) table.push(baseThreatArmy + 3 * j);
    }
    return table;
  };

  ArmyInterceptor.prototype._prune_threats_to_valuable_threat_info = function (threats, turnsLeftInCycle) {
    if (threats.length === 0) throw new Error('Threat list was empty.');

    var outThreats = [];
    var ignoredThreats = [];

    var threatTile = threats[0].path.start.tile;
    var countCity = 0;
    var countGen = 0;
    var countExpansion = 0;

    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i];
      if (threat.path.length <= 0) {
        ignoredThreats.push(threat);
        continue;
      }
      if (threat.path.start.tile.lastMovedTurn < this.map.turn - 2) {
        ignoredThreats.push(threat);
        continue;
      }

      if (threat.path.tail.tile.isGeneral) {
        countGen += 1;
        if (countGen > 2) {
          ignoredThreats.push(threat);
          continue;
        }
      } else if (threat.path.tail.tile.isCity) {
        countCity += 1;
        if (countCity > 2) {
          ignoredThreats.push(threat);
          continue;
        }
      } else {
        countExpansion += 1;
        if (countExpansion > 3) {
          ignoredThreats.push(threat);
          continue;
        }
      }

      this.ensure_threat_army_analysis(threat);
      if (threat.path.start.tile !== threatTile) {
        throw new Error(
          'Can only get an interception plan for threats from one tile at a time. ' +
            threat.path.start.tile + ' vs ' + threatTile
        );
      }
      outThreats.push(threat);
    }

    if (outThreats.length === 0) return [[], ignoredThreats];

    var threatValues = this._determine_threat_values(outThreats, turnsLeftInCycle);
    var maxLen = 0;
    var avgLen = 0;
    var maxEconPerTurn = 0.0;
    var maxBalancedThreat = null;
    var maxBalancedThreatHeur = -10;

    for (var v = 0; v < threatValues.length; v++) {
      var tv = threatValues[v];
      maxLen = Math.max(tv.turns_used_by_enemy, maxLen);
      avgLen += tv.turns_used_by_enemy;

      if (maxEconPerTurn < tv.econ_value_per_turn) maxEconPerTurn = tv.econ_value_per_turn;

      var heurVal = tv.econ_value_per_turn - tv.econ_value_per_turn / (tv.turns_used_by_enemy + 1);
      if (heurVal > maxBalancedThreatHeur) {
        maxBalancedThreat = tv;
        maxBalancedThreatHeur = heurVal;
      }
    }

    avgLen = avgLen / threatValues.length;

    var lenCutoffIfNotCompliant = Math.max(Math.floor(maxLen / 4) + 1, Math.trunc(0.5 + (2.0 * avgLen) / 3));
    lenCutoffIfNotCompliant = Math.min(turnsLeftInCycle - 2, lenCutoffIfNotCompliant);

    var econVtCutoff = Math.min(2.0, maxEconPerTurn * 0.85);
    var finalThreats = [];
    for (var f = 0; f < threatValues.length; f++) {
      var threatV = threatValues[f];
      var tailIsGen = threatV.threat.path.tail.tile.isGeneral;
      var tailIsCity = threatV.threat.path.tail.tile.isCity;

      if (!tailIsGen && !tailIsCity && threatV.turns_used_by_enemy < lenCutoffIfNotCompliant) {
        ignoredThreats.push(threatV.threat);
        continue;
      }
      if (!tailIsGen && !tailIsCity && threatV.econ_value_per_turn <= econVtCutoff) {
        ignoredThreats.push(threatV.threat);
        continue;
      }
      finalThreats.push(threatV);
    }

    if (finalThreats.length === 0 && maxBalancedThreat !== null) {
      // 全砍光等于放弃防守，必须留一个「性价比最均衡」的
      finalThreats.push(maxBalancedThreat);
      var idx = ignoredThreats.indexOf(maxBalancedThreat.threat);
      if (idx >= 0) ignoredThreats.splice(idx, 1);
    }

    return [finalThreats, ignoredThreats];
  };

  ArmyInterceptor.prototype._is_intercept_from_threatened_friendly_city = function (interception, path) {
    var startTile = path.start.tile;
    if (!startTile.isCity) return false;
    if (!this.map.is_tile_friendly(startTile)) return false;

    for (var i = 0; i < interception.threats.length; i++) {
      var threat = interception.threats[i];
      if (threat.path.tail.tile === startTile && threat.threatValue > Math.trunc(threat.turns / 2)) return true;
    }
    return false;
  };

  ArmyInterceptor.prototype.ensure_threat_army_analysis = function (threat) {
    if (threat.path.value === 0) {
      threat.path.calculate_value(threat.threatPlayer, this.map.team_ids_by_player_index);
    }
    if (threat.armyAnalysis === null || threat.armyAnalysis === undefined) {
      var distBetween = this.map.distance_mapper.get_distance_between(threat.path.start.tile, threat.path.tail.tile);
      var maxDist = Math.max(Math.trunc(6 + threat.turns / 2), distBetween === null ? 0 : distBetween);
      threat.armyAnalysis = EK.ArmyAnalyzer.build_from_path(
        this.map,
        threat.path,
        threat.threatType === EK.ThreatType.Econ,
        maxDist
      );
      return true;
    }
    return false;
  };

  ArmyInterceptor.prototype._determine_threat_values = function (threats, turnsLeftInCycle) {
    var maxValPerTurn = -100000;
    var maxThreatInfo = null;
    var maxThreatKills = false;

    var threatValues = [];

    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i];
      var enPlayer = threat.threatPlayer;
      var frPlayer = this.map.player_index;
      var econRes = this._get_path_econ_values_for_player(threat.path, enPlayer, frPlayer, turnsLeftInCycle);
      var turnsWithRecap = econRes[1];
      var recapTurns = econRes[2];
      var rawNoRecaptures = econRes[3];
      var threatLen = turnsWithRecap - recapTurns;

      var isKillThreat = threat.threatType === EK.ThreatType.Kill && threat.threatValue > 0;

      // 尾部是我方将军且不是真杀威胁时，原版会扣掉将军价值（假设能跑），但真正存下来的是 rawNoRecaptures，
      // 所以这一扣只影响局部变量 —— 照抄，别"顺手修好"。
      var threatInfo = new ThreatValueInfo(
        threat,
        rawNoRecaptures,
        threatLen,
        threat.path.get_positive_subsegment(enPlayer, this.map.team_ids_by_player_index).tileSet
      );

      var valPerTurn = threatInfo.econ_value_per_turn;
      if (
        valPerTurn === maxValPerTurn &&
        maxThreatInfo !== null &&
        threat.path.length > maxThreatInfo.threat.path.length
      ) {
        maxValPerTurn -= 0.0000001;
      }

      if ((maxThreatKills === isKillThreat && valPerTurn > maxValPerTurn) || (maxThreatKills === false && isKillThreat)) {
        maxValPerTurn = valPerTurn;
        maxThreatInfo = threatInfo;
        maxThreatKills = isKillThreat;
      }

      threatValues.push(threatInfo);
    }

    return threatValues;
  };

  ArmyInterceptor.prototype._get_path_econ_values_for_player = function (
    interceptionPath,
    searchingPlayer,
    targetPlayer,
    turnsLeftInCycle,
    friendlyRemainingArmy,
    includeRecaptureEffectiveStartDist
  ) {
    if (friendlyRemainingArmy === undefined) friendlyRemainingArmy = null;
    if (includeRecaptureEffectiveStartDist === undefined) includeRecaptureEffectiveStartDist = -1;

    var val = 0;
    var cityCaps = 0;
    var curTurn = this.map.turn;
    var cycleEnd = this.map.turn + turnsLeftInCycle;
    var armyLeft = 0;
    var pathNode = interceptionPath.start;
    var cityHoldTurns = 0;

    while (pathNode !== null && pathNode !== undefined) {
      var tile = pathNode.tile;
      // 兵打光了又已经过上回合，就没法继续算收益，直接收尾
      if (armyLeft <= 0 && curTurn > this.map.turn) {
        curTurn += 1;
        break;
      }

      if (!this.map.is_tile_on_team_with(tile, searchingPlayer)) {
        armyLeft -= tile.army;

        if (armyLeft > 0) {
          var isTarget = this.map.is_tile_on_team_with(tile, targetPlayer);
          if (tile.isGeneral) {
            if (isTarget) val += GENERAL_CAP_VALUE;
          }
          if (tile.isCity) {
            cityHoldTurns += cycleEnd - curTurn;
            if (isTarget) {
              // 抢下对面的城是双倍收益：多一份加成，且再假设多守一段
              val += OWNED_CITY_CAP_VALUE_BONUS;
              cityHoldTurns += cycleEnd - curTurn;
            }
          }
          if (isTarget) val += TARGET_CAP_VALUE;
          else if (_playerOf(tile) >= 0) val += OTHER_PARTY_CAP_VALUE;
          else val += NEUTRAL_CAP_VALUE;
        }
      } else {
        armyLeft += tile.army;
        if (pathNode.move_half) {
          // 半兵出发：剩下一半还要留在原地继续扩张，所以兵不减，但要多费一回合
          curTurn += 1;
        }
      }

      armyLeft -= 1;
      curTurn += 1;

      // cityCaps 恒为 0（原版把 cityCaps += 1 注释掉了），保留这个分支是为了逐字对齐
      if ((curTurn & 1) === 0) val += cityCaps;

      pathNode = pathNode.next;

      if (curTurn > cycleEnd) break;
    }

    // 列表头是起点不是走了一步，所以把多算的那一回合退回来
    curTurn -= 1;
    if (friendlyRemainingArmy !== null) armyLeft = friendlyRemainingArmy;

    var rawValNoRecaptures = val;
    var valWithRecaptures = val;
    var recaps = 0;

    if (cycleEnd > curTurn && armyLeft > 0) {
      var left = cycleEnd - curTurn;
      valWithRecaptures += Math.floor(cityHoldTurns / 2);

      if (includeRecaptureEffectiveStartDist >= 0) {
        left -= includeRecaptureEffectiveStartDist;
        curTurn += includeRecaptureEffectiveStartDist;
        recaps = Math.max(0, Math.min(left, Math.floor(armyLeft / 2)));
        curTurn += recaps;
        valWithRecaptures += recaps * RECAPTURE_VALUE;
      }
    }

    return [valWithRecaptures, curTurn - this.map.turn, recaps, rawValNoRecaptures];
  };

  ArmyInterceptor.prototype._get_distance_from_threat_to_contestable_enemy_city = function (
    interception,
    contestableEnemyCities
  ) {
    if (contestableEnemyCities === null || contestableEnemyCities === undefined) return -1;

    var closestDist = 100000;
    var threatTile = interception.best_enemy_threat.threat.path.start.tile;
    var cities = Array.isArray(contestableEnemyCities) ? contestableEnemyCities : Array.from(contestableEnemyCities);
    for (var i = 0; i < cities.length; i++) {
      var city = cities[i];
      if (city === null || city === undefined) continue;
      if (!city.isCity) continue;
      if (!this.map.is_tile_on_team_with(city, interception.best_enemy_threat.threat.threatPlayer)) continue;

      var dist = this.map.distance_mapper.get_distance_between(threatTile, city);
      if (dist === null || dist === undefined || dist < 0) continue;
      if (dist < closestDist) closestDist = dist;
    }

    if (closestDist === 100000) return -1;
    return closestDist;
  };

  ArmyInterceptor.prototype._get_intercept_plan_options = function (
    interception,
    turnsLeftInCycle,
    opponentTracker,
    otherThreatsBlockingTiles,
    includeNonMiddlestPositiveDepthFallback
  ) {
    if (otherThreatsBlockingTiles === undefined) otherThreatsBlockingTiles = null;
    if (includeNonMiddlestPositiveDepthFallback === undefined) includeNonMiddlestPositiveDepthFallback = false;

    if (interception.common_intercept_chokes.size === 0) return new Map();

    var self = this;
    var threats0 = interception.threats[0];

    var furthestBackCommonIntercept = null;
    var furthestBVal = -Infinity;
    interception.common_intercept_chokes.forEach(function (info, tile) {
      var val = _matGet(threats0.armyAnalysis.bMap, tile);
      if (val === null) val = -Infinity;
      if (furthestBackCommonIntercept === null || val > furthestBVal) {
        furthestBVal = val;
        furthestBackCommonIntercept = tile;
      }
    });

    interception.furthest_common_intercept_distances = this.map.distance_mapper.get_tile_dist_matrix(
      furthestBackCommonIntercept
    );
    var threatDistFromCommon = _matGet(interception.furthest_common_intercept_distances, interception.target_tile);
    var maxDepth = this._get_max_interception_search_depth(interception.threats);

    // 允许搜索的区域 = 各公共枢纽格「自己的漏斗」之并集。原版踩过坑：用单个最远枢纽格画界，
    // 会让另一条分叉威胁的拦截区被整片裁掉，直接 0 条路径。
    var bMapRaw = threats0.armyAnalysis.bMap.raw;
    var numTiles = interception.furthest_common_intercept_distances.raw.length;
    var allowedSearchRegion = new Uint8Array(numTiles);
    var bfsDist = new Int32Array(numTiles);
    for (var bi = 0; bi < numTiles; bi++) bfsDist[bi] = -1;

    var maxRadius = 0;
    var seeds = [];
    interception.common_intercept_chokes.forEach(function (info, chokeTile) {
      var rawDist = bMapRaw[chokeTile.tile_index];
      var chokeFunnelRadius = (rawDist === undefined || rawDist === null ? 0 : rawDist) + 1;
      seeds.push([chokeTile, chokeFunnelRadius]);
      if (chokeFunnelRadius > maxRadius) maxRadius = chokeFunnelRadius;
    });

    // 半径大的先入队，保证队列里的 offset 单调不减（多源 BFS 的等价前提）
    seeds.sort(function (a, b) {
      return b[1] - a[1];
    });

    var frontier = [];
    var head = 0;
    for (var s = 0; s < seeds.length; s++) {
      var seedTile = seeds[s][0];
      var offset = maxRadius - seeds[s][1];
      if (bfsDist[seedTile.tile_index] === -1) {
        bfsDist[seedTile.tile_index] = offset;
        allowedSearchRegion[seedTile.tile_index] = 1;
        frontier.push([seedTile, offset]);
      }
    }

    while (head < frontier.length) {
      var cur = frontier[head];
      head += 1;
      var curTile = cur[0];
      var dist = cur[1];
      if (dist >= maxRadius) continue;
      var newDist = dist + 1;
      var adj = curTile.movable;
      for (var a = 0; a < adj.length; a++) {
        var n = adj[a];
        if (bfsDist[n.tile_index] !== -1) continue;
        bfsDist[n.tile_index] = newDist;
        allowedSearchRegion[n.tile_index] = 1;
        // 障碍也标进区域（它可能在边界上），但不继续扩散
        if (n.isObstacle) continue;
        frontier.push([n, newDist]);
      }
    }

    var posLen = Math.max(interception.kill_enemy_threat.threat.path.length + 1, maxDepth);
    var averageEnemyPositionByTurn = new Array(posLen);
    for (var pi = 0; pi < posLen; pi++) averageEnemyPositionByTurn[pi] = null;

    var killLen = interception.kill_enemy_threat.threat.path.length;
    for (var i = 0; i < killLen; i++) {
      var numThreatsAtThisDist = 0;
      var allThreatsX = 0;
      var allThreatsY = 0;
      for (var tv = 0; tv < interception.threat_values.length; tv++) {
        var tvInfo = interception.threat_values[tv];
        var mult = 1;
        if (tvInfo.threat.threatType === EK.ThreatType.Kill && tvInfo.threat.path.tail.tile.isGeneral) mult = 3;
        var distances = _distLookup(tvInfo.threat.armyAnalysis.tileDistancesLookup, i);
        if (distances === null || distances.length === 0) continue;

        numThreatsAtThisDist += mult;
        var xSum = 0;
        var ySum = 0;
        var numTilesAtThisDist = 0;
        for (var dt = 0; dt < distances.length; dt++) {
          xSum += distances[dt].x;
          ySum += distances[dt].y;
          numTilesAtThisDist += 1;
        }
        if (numTilesAtThisDist === 0) continue;
        allThreatsX += (xSum / numTilesAtThisDist) * mult;
        allThreatsY += (ySum / numTilesAtThisDist) * mult;
      }

      if (numThreatsAtThisDist === 0) continue;
      averageEnemyPositionByTurn[i] = [allThreatsX / numThreatsAtThisDist, allThreatsY / numThreatsAtThisDist];
    }

    this.filter_interception_best_points(interception, maxDepth, averageEnemyPositionByTurn);

    var middlestTiles = this._get_middlest_intercept_tiles_by_distance(interception);
    interception.middlest_intercept_tiles = middlestTiles;

    var bestInterceptTable = new Map();

    var chokeEntries = [];
    interception.common_intercept_chokes.forEach(function (info, tile) {
      chokeEntries.push([tile, info]);
    });

    for (var ci = 0; ci < chokeEntries.length; ci++) {
      var tile = chokeEntries[ci][0];
      var interceptInfo = chokeEntries[ci][1];

      // 中立城不能当拦截点：走进去还要先打下来，代价完全没算进模型
      if (tile.isCity && tile.isNeutral) continue;

      var isNonMiddlestPositiveDepthFallback =
        includeNonMiddlestPositiveDepthFallback && !middlestTiles.has(tile) && interceptInfo.max_search_dist > 0;
      if (!middlestTiles.has(tile) && !isNonMiddlestPositiveDepthFallback) continue;

      var depth = interceptInfo.max_search_dist;
      if (isNonMiddlestPositiveDepthFallback) depth += 1;
      if (depth <= 0) continue;

      var interceptPaths = this._get_intercept_paths(
        tile,
        interception,
        depth,
        turnsLeftInCycle,
        threatDistFromCommon,
        this.map.player_index,
        averageEnemyPositionByTurn,
        allowedSearchRegion,
        otherThreatsBlockingTiles
      );

      var debugBadCutoff = Math.max(1, Math.floor(interception.base_threat_army / 10));

      // 同一枢纽格的多条路径按长度升序处理，保证 break 的位置可复现
      var pathKeys = Array.from(interceptPaths.keys());
      pathKeys.sort(function (a, b) {
        return a - b;
      });

      for (var pk = 0; pk < pathKeys.length; pk++) {
        var path = interceptPaths.get(pathKeys[pk]);

        var interceptPointDist = _matGet(threats0.armyAnalysis.bMap, path.tail.tile);
        if (interceptPointDist === null) interceptPointDist = 0;

        if (this._is_intercept_from_threatened_friendly_city(interception, path)) continue;

        var addlTurnsToReachThreatWorstCase = interceptPointDist;
        if (!interception.target_tile.isCity) {
          addlTurnsToReachThreatWorstCase = Math.max(0, interceptPointDist - path.length);
        }

        var shouldDelaySplit = this._should_delay_or_split(tile, path, interception.threat_values, turnsLeftInCycle);
        var shouldDelay = shouldDelaySplit[0];
        var shouldSplit = shouldDelaySplit[1];
        var splittingForSafetyOnSingleIntercept = shouldSplit;

        // 兵太少又不需要拖/不需要分兵，这条路纯粹是浪费回合
        if (
          DEBUG_BYPASS_BAD_INTERCEPTIONS &&
          path.start.tile.army <= debugBadCutoff &&
          !shouldDelay &&
          !shouldSplit
        ) {
          continue;
        }

        var blockedRes = this._get_value_of_threat_blocked(
          interception,
          path,
          interception.best_enemy_threat,
          turnsLeftInCycle
        );
        var enemyArmyLeftAfterIntercept = blockedRes[2];
        var enemyArmyCollidedWithAtIntercept = blockedRes[3];
        var bestCaseInterceptMoves = blockedRes[4];
        var worstCaseInterceptMoves = blockedRes[5];
        var blockedDamage = blockedRes[1];

        if (bestCaseInterceptMoves === 1000) {
          // 这条路连「最好情况」都撞不上，后面更长的路只会更差
          break;
        }

        if (otherThreatsBlockingTiles !== null && otherThreatsBlockingTiles !== undefined) {
          var invalid = false;
          var frTeam = this.map.players[this.map.player_index].team;
          var pathNode = path.start;
          var army = 0;
          var split = false;
          while (pathNode !== null && pathNode !== undefined) {
            var t = pathNode.tile;
            if (this.map.is_tile_on_team(t, frTeam)) army += t.army - 1;
            else army -= t.army + 1;

            var tileHold = otherThreatsBlockingTiles instanceof Map
              ? otherThreatsBlockingTiles.get(t)
              : otherThreatsBlockingTiles[t.tile_index];
            if (tileHold !== undefined && tileHold !== null && pathNode.next !== null && pathNode.next !== undefined) {
              if (tileHold.blocked_destinations.indexOf(pathNode.next.tile) >= 0) {
                if (tileHold.amount_needed_to_block > Math.floor(army / 2)) {
                  invalid = true;
                  break;
                }
                // 要同时守住别的威胁，这里只能分兵过去；代价重算一遍
                if (enemyArmyLeftAfterIntercept > 0) {
                  pathNode.move_half = true;
                  split = true;
                  army = Math.floor(army / 2);
                }
              }
            }
            pathNode = pathNode.next;
          }
          if (invalid) continue;

          if (split) {
            blockedRes = this._get_value_of_threat_blocked(
              interception,
              path,
              interception.best_enemy_threat,
              turnsLeftInCycle
            );
            enemyArmyLeftAfterIntercept = blockedRes[2];
            enemyArmyCollidedWithAtIntercept = blockedRes[3];
            bestCaseInterceptMoves = blockedRes[4];
            worstCaseInterceptMoves = blockedRes[5];
            blockedDamage = blockedRes[1];
          }
        }

        var fullAddlTurnsToGuaranteedIntercept = addlTurnsToReachThreatWorstCase;
        if (splittingForSafetyOnSingleIntercept) fullAddlTurnsToGuaranteedIntercept += 1;

        var econRes = this._get_path_econ_values_for_player(
          path,
          this.map.player_index,
          interception.threats[0].threatPlayer,
          turnsLeftInCycle,
          0 - enemyArmyLeftAfterIntercept,
          fullAddlTurnsToGuaranteedIntercept
        );
        var turnsUsedWithRecap = econRes[1];
        var recapTurnsUsed = econRes[2];
        var rawValueNoRecap = econRes[3];
        var newValue = rawValueNoRecap;

        // 必须在上面算完价值之后才标 move_half：我们只打算用半兵担保安全，
        // 真到要追的时候还会把整支拉上来，价值按整支算。
        if (shouldSplit) path.start.move_half = true;

        turnsUsedWithRecap += interceptInfo.max_extra_moves_to_capture;
        newValue += blockedDamage;

        var baseLen = turnsUsedWithRecap - recapTurnsUsed;
        var sparseLenCutoff = averageEnemyPositionByTurn.length / 2;
        if (addlTurnsToReachThreatWorstCase === 0 && worstCaseInterceptMoves < 5 && baseLen < sparseLenCutoff) {
          newValue += interception.sparse_recapture_bonus;
        }

        for (var curDist = baseLen; curDist <= turnsUsedWithRecap; curDist++) {
          var recapTurns = curDist - baseLen;
          var thisValue = newValue + recapTurns * RECAPTURE_VALUE;

          if (
            interception.distance_from_threat_to_contestable_en_city >= 0 &&
            recapTurns >= interception.distance_from_threat_to_contestable_en_city
          ) {
            var armyReachingContestableCity = Math.max(
              0,
              enemyArmyCollidedWithAtIntercept -
                enemyArmyLeftAfterIntercept -
                2 * interception.distance_from_threat_to_contestable_en_city
            );
            if (armyReachingContestableCity > 0 && opponentTracker && opponentTracker.estimate_city_contest_econ_value) {
              thisValue += opponentTracker.estimate_city_contest_econ_value(
                this.map.player_index,
                interception.threats[0].threatPlayer,
                armyReachingContestableCity
              );
            }
          }

          // 同样挡住伤害时，强制偏好更短的拦截，否则会莫名其妙跟威胁並排走好几回合
          thisValue -= 0.06 * baseLen;

          var existing = bestInterceptTable.has(curDist) ? bestInterceptTable.get(curDist) : null;
          var opt = new InterceptionOptionInfo(
            path,
            thisValue,
            curDist,
            blockedDamage,
            enemyArmyLeftAfterIntercept,
            bestCaseInterceptMoves,
            worstCaseInterceptMoves,
            recapTurns,
            shouldDelay ? 1 : 0,
            enemyArmyCollidedWithAtIntercept - enemyArmyLeftAfterIntercept
          );
          opt.intercept = interception;

          if (existing === null) {
            bestInterceptTable.set(curDist, opt);
            continue;
          }
          if (this._should_replace_best_intercept_option(interception, existing, opt)) {
            bestInterceptTable.set(curDist, opt);
          }
        }
      }
    }

    return bestInterceptTable;
  };

  ArmyInterceptor.prototype._should_replace_best_intercept_option = function (interception, existing, candidate) {
    if (candidate.econValue < existing.econValue) return false;
    if (candidate.econValue > existing.econValue) return true;

    if (candidate.worst_case_intercept_moves < existing.worst_case_intercept_moves) return true;
    if (candidate.worst_case_intercept_moves > existing.worst_case_intercept_moves) return false;

    var targetMap = this.map.distance_mapper.get_tile_dist_matrix(interception.target_tile);
    var candidateDist = _matGet(targetMap, candidate.path.tail.tile);
    var existingDist = _matGet(targetMap, existing.path.tail.tile);
    if (candidateDist === null) candidateDist = 100000;
    if (existingDist === null) existingDist = 100000;
    return candidateDist < existingDist;
  };

  ArmyInterceptor.prototype.filter_interception_best_points = function (interception, maxDepth, positionsByTurn) {
    interception.common_intercept_chokes.forEach(function (interceptInfo, tile) {
      if (tile.isCity && tile.isNeutral) return;
      interceptInfo.max_search_dist = Math.min(maxDepth, interceptInfo.max_delay_turns);
    });

    var targetMap = this.map.distance_mapper.get_tile_dist_matrix(interception.target_tile);
    var toBypassFullSearch = [];

    var entries = [];
    interception.common_intercept_chokes.forEach(function (info, tile) {
      entries.push([tile, info]);
    });
    // 原版按 targetMap 距离升序（稳定排序）遍历，平手顺序会影响谁被裁掉，必须保持一致
    entries.sort(function (a, b) {
      var da = _matGet(targetMap, a[0]);
      var db = _matGet(targetMap, b[0]);
      if (da === null) da = 100000;
      if (db === null) db = 100000;
      return da - db;
    });

    for (var e = 0; e < entries.length; e++) {
      var tile = entries[e][0];
      var interceptInfo = entries[e][1];
      if (tile.isCity && tile.isNeutral) continue;

      var currentDist = _matGet(targetMap, tile);
      if (currentDist === null) currentDist = 100000;
      var euclidIntDist = 5;
      if (currentDist < positionsByTurn.length && positionsByTurn[currentDist] !== null) {
        euclidIntDist = _euclidDist(positionsByTurn[currentDist][0], positionsByTurn[currentDist][1], tile.x, tile.y);
      }

      var adjs = tile.movable;
      for (var a = 0; a < adjs.length; a++) {
        var adj = adjs[a];
        var adjIntInfo = interception.common_intercept_chokes.get(adj);
        if (adjIntInfo === undefined) continue;

        var altDist = _matGet(targetMap, adj);
        if (altDist === null) altDist = 100000;
        var euclidAdjIntDist = 5;
        if (altDist < positionsByTurn.length && positionsByTurn[altDist] !== null) {
          euclidAdjIntDist = _euclidDist(
            positionsByTurn[altDist][0],
            positionsByTurn[altDist][1],
            adj.x,
            adj.y
          );
        }

        // 更靠后的点不因为更近的点更好就被砍掉：更近的点未必到得了
        var offs = altDist < currentDist ? 1 : 0;

        if (euclidAdjIntDist + offs < euclidIntDist) {
          // 邻格在几何上永远比我好 -> 我这条线没必要深搜
          toBypassFullSearch.push(interceptInfo);
          break;
        }
      }
    }

    for (var b = 0; b < toBypassFullSearch.length; b++) {
      var intInfo = toBypassFullSearch[b];
      intInfo.max_search_dist = Math.min(intInfo.max_search_dist, 2 - intInfo.max_choke_width);
    }
  };

  ArmyInterceptor.prototype._get_max_interception_search_depth = function (threats) {
    var maxThreatLen = 0;
    var minLen = 0;
    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i];
      maxThreatLen = Math.max(threat.turns, maxThreatLen);
      if (threat.path.tail.tile.isGeneral || threat.path.tail.tile.isCity) {
        minLen = Math.max(minLen, threat.turns);
      }
    }
    // 纯经济威胁只搜到 2/3 深度够用；将军/城市威胁必须搜满
    var lengthToCheck = Math.trunc((maxThreatLen * 2) / 3) + 1;
    return Math.max(lengthToCheck, minLen);
  };

  ArmyInterceptor.prototype._get_intercept_paths = function (
    interceptAtTile,
    interception,
    maxDepth,
    turnsLeftInCycle,
    threatDistFromCommon,
    searchingPlayer,
    positionsByTurn,
    allowedSearchRegion,
    otherThreatsBlockingTiles
  ) {
    if (otherThreatsBlockingTiles === undefined) otherThreatsBlockingTiles = null;

    var startArmy = 0;
    if (this.map.is_tile_on_team_with(interceptAtTile, searchingPlayer)) {
      startArmy = 0 - interceptAtTile.army;
    }

    var threatTile = interception.threats[0].path.start.tile;
    var map = this.map;

    function valueFunc(curTile, prioObj) {
      var negTileCapPoints = prioObj[2];
      var negArmy = prioObj[3];
      if (_playerOf(curTile) !== searchingPlayer) return null;
      if (curTile.army <= 1) return null;
      if (negArmy > 0) return null;
      return [0 - (negTileCapPoints + negArmy), 0 - negTileCapPoints, 0 - negArmy];
    }

    var threatDistMap = this.map.distance_mapper.get_tile_dist_matrix(threatTile);
    var numPositions = positionsByTurn.length;

    function prioFunc(nextTile, prioObj) {
      var dist = prioObj[0] + 1;
      var negTileCapPoints = prioObj[2];
      var negArmy = prioObj[3];
      var toTile = prioObj[4];
      var fromEuclidCur = 100;

      if (!allowedSearchRegion[nextTile.tile_index]) return null;
      if (nextTile.isCity && nextTile.isNeutral) return null;

      if (_isOnTeamWith(map, nextTile, searchingPlayer)) {
        negArmy -= nextTile.army;
      } else {
        negArmy += nextTile.army;
        negTileCapPoints += 1;
        if (!nextTile.isNeutral) negTileCapPoints += 1;
      }
      negArmy += 1;

      var nextTileDistToThreat = _matGet(threatDistMap, nextTile);
      var toTileDistToThreat = _matGet(threatDistMap, toTile);
      if (nextTileDistToThreat === null || toTileDistToThreat === null) return null;

      var nextDistTuple = nextTileDistToThreat > 0 && nextTileDistToThreat <= numPositions
        ? positionsByTurn[nextTileDistToThreat - 1]
        : null;
      var toDistTuple = toTileDistToThreat >= 0 && toTileDistToThreat < numPositions
        ? positionsByTurn[toTileDistToThreat]
        : null;

      if (nextDistTuple !== null && nextDistTuple !== undefined) {
        fromEuclidCur = _euclidDist(nextDistTuple[0], nextDistTuple[1], nextTile.x, nextTile.y);

        if (toDistTuple !== null && toDistTuple !== undefined && toTile !== null && toTile !== undefined) {
          var approxX = Math.round(toDistTuple[0]);
          var approxY = Math.round(toDistTuple[1]);
          var isApproxMtn = false;
          if (approxY >= 0 && approxY < map.rows && approxX >= 0 && approxX < map.cols) {
            var approxTile = map.grid[approxY][approxX];
            isApproxMtn = !!(approxTile && approxTile.isObstacle);
          }
          if (!isApproxMtn && toTileDistToThreat > nextTileDistToThreat) {
            var toLastEuclid = _euclidDist(toDistTuple[0], toDistTuple[1], toTile.x, toTile.y);
            // 往威胁的估计位置走一步反而离它更远，说明这条线在绕圈
            if (fromEuclidCur < toLastEuclid + 0.5) return null;
          }
        }
      } else if (toTileDistToThreat > nextTileDistToThreat) {
        return null;
      }

      return [dist, fromEuclidCur, negTileCapPoints, negArmy, nextTile];
    }

    var startDist = _matGet(threatDistMap, interceptAtTile);
    if (startDist === null) startDist = 0;
    var startEuclid = startDist;
    if (startDist >= 0 && startDist < numPositions && positionsByTurn[startDist] !== null) {
      startEuclid = _euclidDist(
        positionsByTurn[startDist][0],
        positionsByTurn[startDist][1],
        interceptAtTile.x,
        interceptAtTile.y
      );
    }

    var startTiles = new Map();
    startTiles.set(interceptAtTile, [[0, startEuclid, 0, startArmy, interceptAtTile], 0]);

    var results = EK.search.breadth_first_dynamic_max_per_tile_per_distance(this.map, startTiles, valueFunc, {
      maxDepth: maxDepth,
      noNeutralCities: true,
      priorityFunc: prioFunc,
      negativeTiles: interception.positive_threat_subsegment_negative_tile_indexes
    });

    var byDist = new Map();
    var paths = results.get(interceptAtTile);
    if (paths === undefined || paths === null) return byDist;

    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      // 搜索出的路径 tail 是起点，先做正向校验再反转
      if (interception.positive_threat_subsegment_negative_tile_indexes.has(path.tail.tile)) {
        var allThreatsContain = true;
        for (var t = 0; t < interception.threats.length; t++) {
          if (!interception.threats[t].path.tileSet.has(path.tail.tile)) {
            allThreatsContain = false;
            break;
          }
        }
        if (allThreatsContain) continue;
        var armyFact = Math.floor((interception.base_threat_army * (path.length + 1)) / (path.length + 2));
        if (path.tail.tile.army < armyFact) continue;
      }
      var revPath = path.get_reversed();
      byDist.set(revPath.length, revPath);
    }

    return byDist;
  };

  ArmyInterceptor.prototype._get_value_of_threat_blocked = function (
    interception,
    interceptPath,
    bestEnemyThreatInfo,
    turnsLeftInCycle
  ) {
    var bestEnemyThreat = bestEnemyThreatInfo.threat;

    var collision = this._get_result_of_executing_paths_to_intercept_point(
      interception,
      bestEnemyThreat,
      interceptPath,
      turnsLeftInCycle
    );
    var enInterceptPointNode = collision.enemy_intercept_point_node;
    var enPhysicalArmyAtTile = collision.enemy_physical_army_at_intercept;
    var armyAccumulatedByInterceptPath = collision.friendly_army_at_intercept;
    var enInterceptPointTile = enInterceptPointNode === null ? null : enInterceptPointNode.tile;

    var enArmy = Math.trunc(bestEnemyThreat.path.value);
    var interceptDistFromTarget = _matGet(bestEnemyThreat.armyAnalysis.bMap, interceptPath.tail.tile);
    if (interceptDistFromTarget === null) interceptDistFromTarget = 0;
    var enLen = bestEnemyThreat.path.length;
    var turnsLeft = turnsLeftInCycle;

    var enemyTailNode = bestEnemyThreat.path.tail;

    // 先往回剥掉威胁尾巴上「本来就打不过我们」的那几格，剩下才是真正会伤到我们的部分
    while (enemyTailNode !== null && enemyTailNode !== undefined && enArmy < 0 && enLen > interceptDistFromTarget) {
      var tileT = enemyTailNode.tile;
      if (this.map.is_tile_friendly(tileT)) enArmy -= tileT.army;
      else enArmy += tileT.army;
      enArmy += 1;
      enemyTailNode = enemyTailNode.prev;
      enLen -= 1;
    }

    enArmy -= armyAccumulatedByInterceptPath;

    var econValueBlocked = 0;
    var mainEconDamageComplete = false;

    while (enemyTailNode !== null && enemyTailNode !== undefined) {
      if (turnsLeft <= 0) mainEconDamageComplete = true;
      if (enArmy > 0) break;
      if (enLen <= interceptDistFromTarget) break;

      var tile = enemyTailNode.tile;
      if (this.map.is_tile_friendly(tile)) {
        enArmy -= tile.army;
      } else {
        enArmy += tile.army;

        if (this.map.is_tile_friendly(tile)) {
          // 原版这里再判一次 friendly：只有「敌人走过来时顺手把我们的将军/城市打下来」才算价
          if (tile.isGeneral && enArmy < 0) enArmy += GENERAL_CAP_VALUE;
          if (tile.isCity) {
            if (!mainEconDamageComplete) econValueBlocked += turnsLeftInCycle - enLen;
            if (enArmy < 0) econValueBlocked += OWNED_CITY_CAP_VALUE_BONUS;
          }
        }

        if (!mainEconDamageComplete) {
          if (_playerOf(tile) >= 0) econValueBlocked += NEUTRAL_CAP_VALUE;
          else econValueBlocked += OTHER_PARTY_CAP_VALUE;
          econValueBlocked += TARGET_CAP_VALUE;
        }
      }

      enArmy += 1;
      enemyTailNode = enemyTailNode.prev;
      enLen -= 1;
      turnsLeft -= 1;
    }

    var enemyArmyLeftAtInterceptPointBeforeRemainingCapture = enPhysicalArmyAtTile - armyAccumulatedByInterceptPath;

    return [
      enInterceptPointTile,
      econValueBlocked,
      enemyArmyLeftAtInterceptPointBeforeRemainingCapture,
      enPhysicalArmyAtTile,
      collision.best_case_intercept_turn,
      collision.worst_case_intercept_turn
    ];
  };

  ArmyInterceptor.prototype._get_result_of_executing_paths_to_intercept_point = function (
    interception,
    bestEnemyThreat,
    interceptPath,
    turnsLeftInCycle
  ) {
    var map = this.map;
    var threatPlayers = _teamSet(map, bestEnemyThreat.threatPlayer);

    var enPathNode = bestEnemyThreat.path.start;
    var enPhysicalArmy = 0;
    var armyAccumulatedByInterceptPath = 0;
    var bestCaseInterceptTurn = 1000;
    var worstCaseInterceptTurn = 1000;
    var enInterceptPointPathNode = null;
    var turnsLeft = turnsLeftInCycle;
    var turnsUsed = 0;

    var closestApproachManhattanDist = 1000;
    var closestApproachTile = null;
    var closestApproachEnemyPathNode = null;
    var closestApproachFriendlyArmy = 0;
    var closestApproachEnemyPhysicalArmy = 0;
    var closestApproachTurnsUsed = 0;

    var directTailAdjacentTile = null;
    var directTailAdjacentEnemyPhysicalArmy = null;
    var directTailAdjacentFriendlyArmy = null;

    var directConcreteAdjacentEnemyPathNode = null;
    var directConcreteAdjacentPhysicalArmy = null;
    var directConcreteAdjacentFriendlyArmy = null;

    var directSameTileEnemyPhysicalArmy = null;
    var directSameTileFriendlyArmy = null;

    var node = interceptPath.start;
    var i = 0;

    while (node !== null && node !== undefined) {
      if (turnsLeft === 0) break;
      if (enPathNode === null || enPathNode === undefined) break;

      var tile = node.tile;
      var enemyPhysicalArmyBeforeCurrentTile = enPhysicalArmy;
      var friendlyArmyBeforeCurrentTile = armyAccumulatedByInterceptPath;

      enPhysicalArmy = this._advance_enemy_physical_army(enPhysicalArmy, enPathNode.tile, threatPlayers);
      enInterceptPointPathNode = enPathNode;
      turnsLeft -= 1;

      armyAccumulatedByInterceptPath = this._advance_friendly_intercept_army(armyAccumulatedByInterceptPath, tile);

      var tilesAtDist = _distLookup(bestEnemyThreat.armyAnalysis.tileDistancesLookup, i);
      var directIntercept = false;

      if (tilesAtDist !== null && tilesAtDist.length > 0) {
        var sumX = 0;
        var sumY = 0;
        for (var tx = 0; tx < tilesAtDist.length; tx++) {
          sumX += tilesAtDist[tx].x;
          sumY += tilesAtDist[tx].y;
        }
        var avgX = sumX / tilesAtDist.length;
        var avgY = sumY / tilesAtDist.length;

        var closestEnemyTileAtDist = null;
        var closestEnemyDist = 100000;
        for (var tt = 0; tt < tilesAtDist.length; tt++) {
          var cand = tilesAtDist[tt];
          var d = Math.abs(cand.x - avgX) + Math.abs(cand.y - avgY);
          if (d < closestEnemyDist) {
            closestEnemyDist = d;
            closestEnemyTileAtDist = cand;
          }
        }

        var manhattanDist = Math.abs(tile.x - closestEnemyTileAtDist.x) + Math.abs(tile.y - closestEnemyTileAtDist.y);
        if (manhattanDist < closestApproachManhattanDist) {
          closestApproachManhattanDist = manhattanDist;
          closestApproachTile = tile;
          closestApproachEnemyPathNode = enPathNode;
          closestApproachFriendlyArmy = armyAccumulatedByInterceptPath;
          closestApproachEnemyPhysicalArmy = enPhysicalArmy;
          closestApproachTurnsUsed = i;
        }

        if (i === 0) {
          if (
            tilesAtDist.length === 1 &&
            node.next !== null &&
            node.next !== undefined &&
            node.next.tile === tilesAtDist[0] &&
            (node.next.next === null || node.next.next === undefined)
          ) {
            bestCaseInterceptTurn = Math.min(i + 1, bestCaseInterceptTurn);
            worstCaseInterceptTurn = Math.min(i + 1, worstCaseInterceptTurn);
            directIntercept = true;
          }
        } else if (i > 0) {
          var allInMovable = tilesAtDist.length < 4;
          var foundAtDist = false;

          for (var mt = 0; mt < tilesAtDist.length; mt++) {
            var t = tilesAtDist[mt];

            if (tile.movable.indexOf(t) >= 0) {
              var offs = 1;
              bestCaseInterceptTurn = Math.min(bestCaseInterceptTurn, i + offs);
            }

            if (t === enPathNode.tile && directConcreteAdjacentEnemyPathNode === null) {
              directConcreteAdjacentEnemyPathNode = enPathNode;
              directConcreteAdjacentPhysicalArmy = enPhysicalArmy;
              directConcreteAdjacentFriendlyArmy = armyAccumulatedByInterceptPath;
            }

            if (tile === interceptPath.tail.tile) {
              directTailAdjacentTile = t;
              directTailAdjacentEnemyPhysicalArmy = enPhysicalArmy;
              directTailAdjacentFriendlyArmy = armyAccumulatedByInterceptPath;
            } else if (t === tile) {
              foundAtDist = true;

              if (tile === interceptPath.tail.tile && map.is_tile_friendly(tile)) {
                directSameTileEnemyPhysicalArmy = enemyPhysicalArmyBeforeCurrentTile;
                directSameTileFriendlyArmy = friendlyArmyBeforeCurrentTile + tile.army;
              }
              if (tilesAtDist.length === 1) {
                directIntercept = true;
                worstCaseInterceptTurn = Math.min(i, worstCaseInterceptTurn);
              }
              bestCaseInterceptTurn = Math.min(bestCaseInterceptTurn, i);
            } else {
              if (allInMovable) allInMovable = false;
            }
          }

          if (!foundAtDist && bestEnemyThreat.path.tileSet.has(tile)) {
            var threatDist = _matGet(bestEnemyThreat.armyAnalysis.bMap, tile);
            if (threatDist !== null && threatDist > 0) {
              bestCaseInterceptTurn = Math.min(bestCaseInterceptTurn, threatDist);
            }
          }

          if (allInMovable) {
            var offs2 = directIntercept ? 0 : 1;
            worstCaseInterceptTurn = Math.min(i + offs2, worstCaseInterceptTurn);
          }
        }
      }

      if (directIntercept) break;

      enPathNode = enPathNode.next;
      node = node.next;
      i += 1;
    }

    // 场景 1：只在「我方尾格恰好是最近的接敌点」时能锁定 worst case
    if (
      worstCaseInterceptTurn === 1000 &&
      bestCaseInterceptTurn < 1000 &&
      closestApproachTile === interceptPath.tail.tile
    ) {
      worstCaseInterceptTurn = bestCaseInterceptTurn;
      if (directSameTileEnemyPhysicalArmy !== null && directSameTileFriendlyArmy !== null) {
        enPhysicalArmy = directSameTileEnemyPhysicalArmy;
        armyAccumulatedByInterceptPath = directSameTileFriendlyArmy;
      }
    }

    // 场景 2a：敌方必须路过我旁边那一格
    if (worstCaseInterceptTurn === 1000 && directConcreteAdjacentEnemyPathNode !== null) {
      worstCaseInterceptTurn = bestCaseInterceptTurn;
      if (directConcreteAdjacentPhysicalArmy !== null) enPhysicalArmy = directConcreteAdjacentPhysicalArmy;
      if (directConcreteAdjacentFriendlyArmy !== null) armyAccumulatedByInterceptPath = directConcreteAdjacentFriendlyArmy;
      enInterceptPointPathNode = directConcreteAdjacentEnemyPathNode;
      enPathNode = directConcreteAdjacentEnemyPathNode.next;
    }

    // 场景 2b：守株待兔 —— 我停在尾格不动，等敌方走进相邻格
    if (worstCaseInterceptTurn === 1000 && (enPathNode !== null && enPathNode !== undefined) && interceptPath.tail !== null) {
      var tailTile = interceptPath.tail.tile;
      var waitingEnemyPathNode = enPathNode;
      var waitingTurn = turnsLeftInCycle - turnsLeft;

      while (waitingEnemyPathNode !== null && waitingEnemyPathNode !== undefined && waitingTurn < turnsLeftInCycle) {
        enPhysicalArmy = this._advance_enemy_physical_army(enPhysicalArmy, waitingEnemyPathNode.tile, threatPlayers);
        if (tailTile.movable.indexOf(waitingEnemyPathNode.tile) >= 0) {
          bestCaseInterceptTurn = waitingTurn;
          worstCaseInterceptTurn = waitingTurn;
          turnsLeft = turnsLeftInCycle - waitingTurn;
          enInterceptPointPathNode = waitingEnemyPathNode;
          enPathNode = waitingEnemyPathNode.next;
          break;
        }
        waitingEnemyPathNode = waitingEnemyPathNode.next;
        waitingTurn += 1;
      }
    }

    // 场景 3：谁都不进邻居，那就按「敌方多走几步才被追上」逼近
    if (worstCaseInterceptTurn === 1000 && closestApproachEnemyPathNode !== null) {
      var extraEnemyMoves = 0;
      var chaseNode = closestApproachEnemyPathNode;
      while (extraEnemyMoves < closestApproachManhattanDist && chaseNode.next !== null && chaseNode.next !== undefined) {
        chaseNode = chaseNode.next;
        enPhysicalArmy = this._advance_enemy_physical_army(enPhysicalArmy, chaseNode.tile, threatPlayers);
        extraEnemyMoves += 1;
      }

      var fallbackInterceptTurn = closestApproachTurnsUsed + extraEnemyMoves;
      bestCaseInterceptTurn = fallbackInterceptTurn;
      worstCaseInterceptTurn = fallbackInterceptTurn;
      turnsLeft = turnsLeftInCycle - fallbackInterceptTurn;
      armyAccumulatedByInterceptPath = closestApproachFriendlyArmy;
      enInterceptPointPathNode = chaseNode;
      enPathNode = chaseNode.next;
    }

    turnsUsed = turnsLeftInCycle - turnsLeft;
    while (turnsUsed < worstCaseInterceptTurn && enPathNode !== null && enPathNode !== undefined) {
      turnsUsed += 1;
      turnsLeft -= 1;
      enPhysicalArmy = this._advance_enemy_physical_army(enPhysicalArmy, enPathNode.tile, threatPlayers);
      enInterceptPointPathNode = enPathNode;
      enPathNode = enPathNode.next;
    }

    bestCaseInterceptTurn = Math.min(bestCaseInterceptTurn, worstCaseInterceptTurn);

    return new InterceptCollisionResult(
      turnsLeft,
      armyAccumulatedByInterceptPath,
      bestCaseInterceptTurn,
      worstCaseInterceptTurn,
      enInterceptPointPathNode,
      enPhysicalArmy
    );
  };

  ArmyInterceptor.prototype._advance_enemy_physical_army = function (enemyPhysicalArmy, tile, threatPlayers) {
    if (threatPlayers.has(_playerOf(tile))) return enemyPhysicalArmy + tile.army - 1;
    return enemyPhysicalArmy - tile.army - 1;
  };

  ArmyInterceptor.prototype._advance_friendly_intercept_army = function (friendlyArmy, tile) {
    if (this.map.is_tile_friendly(tile)) return friendlyArmy + tile.army - 1;
    return friendlyArmy - tile.army - 1;
  };

  ArmyInterceptor.prototype.get_intercept_blocking_tiles_for_split_hinting = function (
    tile,
    threatsByTile,
    negativeTiles
  ) {
    if (negativeTiles === undefined) negativeTiles = null;
    var self = this;
    var blockedTiles = new Map();

    if (negativeTiles !== null) {
      var negArr = negativeTiles instanceof Map ? Array.from(negativeTiles.keys()) : Array.from(negativeTiles);
      for (var n = 0; n < negArr.length; n++) {
        var chokeTile = negArr[n];
        var info = new ThreatBlockInfo(chokeTile, chokeTile.army);
        var mv = chokeTile.movable;
        for (var m = 0; m < mv.length; m++) info.add_blocked_destination(mv[m]);
        blockedTiles.set(chokeTile, info);
      }
    }

    var otherTiles = [];
    if (threatsByTile instanceof Map) {
      threatsByTile.forEach(function (threats, otherTile) {
        otherTiles.push([otherTile, threats]);
      });
    } else {
      for (var key in threatsByTile) {
        if (Object.prototype.hasOwnProperty.call(threatsByTile, key)) {
          otherTiles.push([threatsByTile[key].tile || threatsByTile[key], threatsByTile[key]]);
        }
      }
    }

    for (var ot = 0; ot < otherTiles.length; ot++) {
      var otherTile = otherTiles[ot][0];
      var threatList = otherTiles[ot][1];
      if (!Array.isArray(threatList)) threatList = [threatList];

      for (var i = 0; i < threatList.length; i++) {
        var threat = threatList[i];
        if (threat === null || threat === undefined) continue;

        var realThreatVal = threat.path.calculate_value(
          threat.threatPlayer,
          this.map.team_ids_by_player_index,
          null,
          false,
          true,
          false,
          true
        );
        this.ensure_threat_army_analysis(threat);
        if (threat.armyAnalysis.shortestPathWay === null) continue;

        var gen = this.map.generals[this.map.player_index];
        var towardsUs =
          this.map.distance_mapper.get_distance_between(gen, threat.path.start.tile) -
            this.map.distance_mapper.get_distance_between(gen, threat.path.tail.tile) >
          0;
        if (!towardsUs) continue;

        var threatTiles = threat.path.tileList;
        for (var tl = 0; tl < threatTiles.length; tl++) {
          var chokeTile2 = threatTiles[tl];
          if (!this.map.is_tile_friendly(chokeTile2)) continue;
          if (chokeTile2.army < Math.floor(otherTile.army / 3)) continue;

          var blockAmount = realThreatVal + chokeTile2.army;
          if (blockAmount < 0) break;

          if (!blockedTiles.has(chokeTile2)) blockedTiles.set(chokeTile2, new ThreatBlockInfo(chokeTile2, blockAmount));
          var blockInfo = blockedTiles.get(chokeTile2);

          var canDie = realThreatVal > Math.trunc(threat.turns / 2) && threat.threatType === EK.ThreatType.Kill;

          var chokesMovable = chokeTile2.movable;
          for (var cm = 0; cm < chokesMovable.length; cm++) {
            var moveable = chokesMovable[cm];
            var bMapMoveable = _matGet(threat.armyAnalysis.bMap, moveable);
            var bMapChoke = _matGet(threat.armyAnalysis.bMap, chokeTile2);
            if (
              canDie ||
              (bMapMoveable !== null && bMapChoke !== null && bMapMoveable > bMapChoke) ||
              (!threat.path.tileSet.has(moveable) && !_setHas(threat.armyAnalysis.shortestPathWay.tiles, moveable))
            ) {
              blockInfo.add_blocked_destination(moveable);
            }
          }

          if (blockInfo.amount_needed_to_block < blockAmount) blockInfo.amount_needed_to_block = blockAmount;
        }
      }
    }

    return blockedTiles;
  };

  ArmyInterceptor.prototype._should_delay_or_split = function (
    interceptEndTile,
    interceptionPath,
    threats,
    turnsLeftInCycle
  ) {
    var firstThreat = threats[0].threat;
    var startB = _matGet(firstThreat.armyAnalysis.bMap, interceptionPath.start.tile);
    var isTwoAway = startB === 2;

    if (!isTwoAway && interceptionPath.start.tile.isGeneral) {
      // 将军被两格外顶住、兵又少：原地不动比出门找死好
      var lowGeneralArmyCutoff = Math.max(1, Math.floor(firstThreat.threatValue / 10));
      var tilesAtDist1 = _distLookup(firstThreat.armyAnalysis.tileDistancesLookup, 1);
      if (
        tilesAtDist1 !== null &&
        tilesAtDist1.length === 1 &&
        interceptionPath.start.tile.army <= lowGeneralArmyCutoff
      ) {
        return [true, false];
      }
    }

    if (!isTwoAway) return [false, false];

    var allowSplit = true;
    var threatNexts = new Set();
    var usNexts = new Set();

    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i].threat;
      var tilesAtDist = _distLookup(threat.armyAnalysis.tileDistancesLookup, 1);
      var threatBase = threat.path.start.tile.army;
      if (tilesAtDist === null) continue;

      for (var t = 0; t < tilesAtDist.length; t++) {
        var threatNext = tilesAtDist[t];
        var threatArmy;
        if (this.map.is_tile_friendly(threatNext)) threatArmy = threatBase + threatNext.army - 1;
        else threatArmy = threatBase - threatNext.army - 1;

        var halfLower = Math.floor(interceptionPath.start.tile.army / 2);
        if (halfLower < threatArmy - 1) allowSplit = false;

        threatNexts.add(threatNext);
        if (interceptionPath.start.tile.movable.indexOf(threatNext) >= 0) usNexts.add(threatNext);
      }
    }

    var shouldDelay = false;
    var shouldSplit = false;

    if (threatNexts.size > 1 && usNexts.size > 1) {
      var isSubset = true;
      threatNexts.forEach(function (t) {
        if (!usNexts.has(t)) isSubset = false;
      });
      if (isSubset) {
        // 威胁的所有下一步都在我旁边：分兵能守住多条线，分不了就只能拖
        shouldDelay = !allowSplit;
        shouldSplit = allowSplit;
      }
    }

    if (shouldDelay) shouldSplit = false;
    return [shouldDelay, shouldSplit];
  };

  EK.ThreatValueInfo = ThreatValueInfo;
  EK.ThreatBlockInfo = ThreatBlockInfo;
  EK.InterceptCollisionResult = InterceptCollisionResult;
  EK.InterceptPointTileInfo = InterceptPointTileInfo;
  EK.InterceptionOptionInfo = InterceptionOptionInfo;
  EK.ArmyInterception = ArmyInterception;
  EK.ArmyInterceptor = ArmyInterceptor;
  EK.interceptor_util = {
    euclidDist: _euclidDist,
    TARGET_CAP_VALUE: TARGET_CAP_VALUE,
    OTHER_PARTY_CAP_VALUE: OTHER_PARTY_CAP_VALUE,
    NEUTRAL_CAP_VALUE: NEUTRAL_CAP_VALUE,
    GENERAL_CAP_VALUE: GENERAL_CAP_VALUE,
    OWNED_CITY_CAP_VALUE_BONUS: OWNED_CITY_CAP_VALUE_BONUS,
    RECAPTURE_VALUE: RECAPTURE_VALUE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
