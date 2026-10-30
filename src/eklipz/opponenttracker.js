/*
 * OpponentTracker —— 逐行移植自 generals-bot/Strategy/OpponentTracker.py（2310 行）。
 *
 * 它回答的是 Human.exe 最核心的那个问题：「对手在迷雾里到底干了什么、还剩多少兵」。
 * 整个 bot 的进攻时机、迷雾风险评估、经济胜负判断全部从这里读数字，所以这文件的
 * 口径必须和原版一字不差，任何「顺手改得更合理」的地方都会让下游策略漂。
 *
 * 结构：
 *   FogGatherQueue        —— 每个玩家一条「迷雾里还攒着多少兵」的队列（按兵量分桶计数）
 *   TeamAttackData        —— 一个队伍每个循环的进攻时机/效率历史
 *   CycleStatsData        —— 一个队伍当前循环的 18 项统计
 *   UnresolvedEmergenceData —— 还没解释清楚的一次迷雾出兵
 *   OpponentTracker       —— 上面全部的账本 + 每回合 analyze_turn 推进
 *
 * 三条必须保住的原版怪癖（看着像 bug，其实是算出来的口径，改了 oracle 就对不上）：
 *   1. FogGatherQueue.remove_queued_gather_closest_to_amount 在向小找的时候，
 *      命中后赋的是 bestMax 而不是 bestMin —— 原版就是这么写的，照抄。
 *   2. get_tile_differential / get_current_econ_ratio 在 againstPlayer == -1 时
 *      返回 True 而不是数字（原版 bug），保留。
 *   3. 集合迭代一律按 tile_index 升序：Python 的 set 对小整数 tile.__hash__ == tile_index
 *      就是升序遍历，JS 的 Set 是插入序，不 sort 就会和 oracle 差出随机的一两格。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  var M = root.Map; // 本文件不定义同名 Map，这里只为以后好读，实际不用

  var SAFE_PLAYERS_CAP = 20;
  var UNRESOLVED_EMERGENCE_HISTORY_ROUNDS_TO_SERIALIZE = 10;

  // PLAYER_CHAR_BY_INDEX（base/client/map.py 同名常量），dump/load 的 key 用它。
  var PLAYER_CHARS = 'abcdefghijklmnop';

  function playerChar(p) {
    if (p < 0 || p >= PLAYER_CHARS.length) return String(p);
    return PLAYER_CHARS.charAt(p);
  }

  // 原版 SearchUtils.fast_sum：1..n 的和，用移位就是 int 除法。
  function fast_sum(n) {
    return (n * (n + 1)) >> 1;
  }

  // Python 的 round 是银行家舍入（.5 取偶），JS 的 Math.round 不是。
  // estimate_fog_city_usage_count_by_cycle_behavior 全靠它，差一就整条迷雾风险链都差。
  function pyRound(x) {
    var f = Math.floor(x);
    var diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  // 原版 set 的迭代序按 tile_index 升序（tile.__hash__ == tile_index）。
  function sortedTiles(setLike) {
    var arr = [];
    setLike.forEach(function (t) {
      arr.push(t);
    });
    arr.sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    return arr;
  }

  function qAt(arr, i) {
    if (i < 0 || i >= arr.length) return 0;
    return arr[i];
  }

  /* ============================ FogGatherQueue ============================ */

  function FogGatherQueue(player) {
    this.player = player;
    this.length = 0; // 队列里的迷雾格总数（含 1）
    this.gatherable_length = 0; // 可采集的迷雾格数（不含 1 和 0）
    this.total_sum = 0; // 队列里所有迷雾格兵量之和
    this._gather_amts = []; // 下标 = 兵量，值 = 该兵量的格子数
    this._gather_amt_max = 0;
  }

  var FQ = FogGatherQueue.prototype;

  Object.defineProperty(FQ, 'cur_max_tile_size', {
    get: function () {
      return this._gather_amt_max;
    }
  });

  FQ.get_amount_dict = function () {
    var out = {};
    for (var size = 0; size < this._gather_amts.length; size++) {
      if (this._gather_amts[size] > 0) out[size] = this._gather_amts[size];
    }
    return out;
  };

  FQ.get_amount_list = function () {
    return [this._gather_amt_max, this._gather_amts.slice()];
  };

  FQ.set_amount_for_size = function (tileSize, numTiles) {
    var existingAmt = this.get_or_create_count(tileSize);
    if (existingAmt === numTiles) return;

    this.total_sum -= tileSize * existingAmt;
    this.total_sum += tileSize * numTiles;
    this.length -= existingAmt;
    if (tileSize > 1) this.gatherable_length -= existingAmt;

    this._gather_amts[tileSize] = numTiles;

    if (numTiles > 0) {
      if (tileSize > this._gather_amt_max) this._gather_amt_max = tileSize;
    } else {
      if (this._gather_amt_max === tileSize) this._gather_amt_max = this.find_next_max_amount_under(tileSize);
    }

    this.length += numTiles;
    if (tileSize > 1) this.gatherable_length += numTiles;
  };

  FQ.append = function (tileSize) {
    if (tileSize > this._gather_amt_max) {
      this.get_or_create_count(tileSize);
      this._gather_amt_max = tileSize;
    }

    this._gather_amts[tileSize] += 1;
    this.total_sum += tileSize;
    this.length += 1;
    if (tileSize > 1) this.gatherable_length += 1;
  };

  FQ.increment_army_bonus = function () {
    if (this.length === 0) return;

    this._gather_amt_max += 1;
    this.gatherable_length += qAt(this._gather_amts, 1);

    this.get_or_create_count(this._gather_amt_max);
    // 原版注释也说了：这里不会产生 i = 0
    for (var i = this._gather_amt_max; i > 0; i--) {
      this._gather_amts[i] = Math.max(0, qAt(this._gather_amts, i - 1));
    }

    this._gather_amts[0] = 0;
    // length 不变，但每个格子的兵量都 +1
    this.total_sum += this.length;
  };

  FQ.pop_next_highest = function (leaveOne) {
    if (leaveOne === undefined) leaveOne = true;
    if (this._gather_amt_max === 0) return 0;

    var amtLeft = this._gather_amts[this._gather_amt_max];
    if (amtLeft <= 0) {
      throw new Error(
        '_gather_amt_max was ' + this._gather_amt_max + ', however the count for that tile is ' + amtLeft + '... Should never happen.'
      );
    }

    if (leaveOne) this.append(1);

    var oldMax = this._gather_amt_max;
    this.remove_queued_gather_for_exact_unchecked(oldMax);

    return oldMax;
  };

  FQ.peek_next_highest = function () {
    return this._gather_amt_max;
  };

  FQ.remove_queued_gather_closest_to_amount = function (tileAmount, leaveOne) {
    if (this.length === 0) return 0;

    var bestMax = Math.min(this._gather_amt_max, tileAmount);
    var bestMin = bestMax - 1;

    var maxValid = bestMax <= this._gather_amt_max;
    var minValid = bestMin > -1;
    var toRemove = this._gather_amt_max;

    var amt = 0;

    while (maxValid || minValid) {
      if (maxValid) {
        amt = qAt(this._gather_amts, bestMax);
        if (amt > 0) {
          toRemove = bestMax;
          break;
        }
      }
      if (minValid) {
        amt = qAt(this._gather_amts, bestMin);
        if (amt > 0) {
          // 原版这里赋的是 bestMax（不是 bestMin）。照抄，别修。
          toRemove = bestMax;
          break;
        }
      }

      bestMax += 1;
      bestMin -= 1;
      maxValid = bestMax <= this._gather_amt_max;
      minValid = bestMin > 0;
    }

    if (amt <= 0) return -1; // 原版这里 logbook.error 后返回 -1

    var minActionable = leaveOne ? 1 : -1;
    if (toRemove > minActionable) {
      this.remove_queued_gather_for_exact_unchecked(toRemove);
      if (leaveOne) this.append(1);
    }

    return toRemove;
  };

  FQ.try_remove_queued_gather_for_exact_amount = function (tileAmount, leaveOne) {
    if (tileAmount > this._gather_amt_max) return false;
    var amt = qAt(this._gather_amts, tileAmount);
    if (!amt) return false;

    this.remove_queued_gather_for_exact_unchecked(tileAmount);
    if (leaveOne) this.append(1);

    return true;
  };

  FQ.as_tile_list = function (includeOnesAndZeros) {
    var l = [];
    var minAmt = 1;
    if (includeOnesAndZeros) minAmt = -1;
    for (var tileSize = this._gather_amt_max; tileSize > minAmt; tileSize--) {
      var amt = qAt(this._gather_amts, tileSize);
      if (!amt) continue;
      for (var i = 0; i < amt; i++) l.push(tileSize);
    }
    return l;
  };

  FQ.get_count = function (tileSize) {
    if (tileSize >= this._gather_amts.length) return 0;
    return this._gather_amts[tileSize];
  };

  FQ.get_or_create_count = function (tileSize) {
    while (tileSize >= this._gather_amts.length) this._gather_amts.push(0);
    return this._gather_amts[tileSize];
  };

  FQ.find_next_max_amount_under = function (tileSize) {
    tileSize = tileSize - 1;
    var nextMaxSize = 0;
    while (tileSize > -1) {
      if (qAt(this._gather_amts, tileSize) > 0) {
        nextMaxSize = tileSize;
        break;
      }
      tileSize -= 1;
    }
    return nextMaxSize;
  };

  FQ.remove_queued_gather_for_exact_unchecked = function (toRemoveSize) {
    var amt = qAt(this._gather_amts, toRemoveSize);
    this.length -= 1;
    if (amt > 0) {
      if (toRemoveSize > 1) this.gatherable_length -= 1;
      this._gather_amts[toRemoveSize] = amt - 1;
    } else {
      // 原版 logbook.error 后 return，不改 total_sum
      return;
    }

    this.total_sum -= toRemoveSize;

    if (amt === 1 && toRemoveSize === this._gather_amt_max) {
      this._gather_amt_max = this.find_next_max_amount_under(this._gather_amt_max);
    }
  };

  /* ============================ TeamAttackData ============================ */

  function TeamAttackData(team, expectedAttackTurn, expectedEfficiency, expectedTrueEfficiency) {
    this.team = team;
    this.expected_attack_cycle_turn = Math.trunc(expectedAttackTurn);
    this.expected_efficiency = expectedEfficiency;
    this.expected_true_efficiency = expectedTrueEfficiency;
    this.actual_attack_cycle_turn = -1;
    this.actual_true_efficiency = -1.0;
    this.actual_efficiency = -1.0;
    // python 里构造函数 int() 过、parse 却是 float()，序列化时 43 和 43.0 是两个不同字符串。
    this._turnFieldsAreFloat = false;
  }

  var TAD = TeamAttackData.prototype;

  // 原版 f-string 里 attack turn 是 int，两个效率是 .6f。oracle 直接比这串文本。
  function f6(v) {
    return v.toFixed(6);
  }

  // python 的 str(float)：整数值也要带 .0
  function pyNum(v, isFloat) {
    if (!isFloat) return String(v);
    if (Number.isInteger(v)) return v.toFixed(1);
    return String(v);
  }

  TAD.serialize = function () {
    return (
      '{ t' +
      this.team +
      ': attk e' +
      pyNum(this.expected_attack_cycle_turn, this._turnFieldsAreFloat) +
      '/a' +
      pyNum(this.actual_attack_cycle_turn, this._turnFieldsAreFloat) +
      ', eff e' +
      f6(this.expected_efficiency) +
      '/a' +
      f6(this.actual_efficiency) +
      ', effTr e' +
      f6(this.expected_true_efficiency) +
      '/a' +
      f6(this.actual_true_efficiency) +
      ' }'
    );
  };

  TAD.toString = TAD.serialize;

  // 解析 " { t0: attk e43/a-1, eff e0.500000/a-1.000000, effTr e0.500000/a-1.000000 } "
  TeamAttackData.parse = function (input) {
    var data = new TeamAttackData(0, 0, 0, 0);
    // 原版 input.strip('{} t') 会从头尾剥掉所有 '{' '}' ' ' 't' 字符
    input = String(input).replace(/^[{}\st]+/, '').replace(/[{}\st]+$/, '');

    var split = input.split(' ');

    data.team = parseInt(split[0].replace(/:/g, ''), 10);
    var attkTurnSplit = split[2].split('/');
    data.expected_attack_cycle_turn = parseFloat(attkTurnSplit[0].replace(/e/g, ''));
    data.actual_attack_cycle_turn = parseFloat(attkTurnSplit[1].replace(/[a,]/g, ''));

    var efficiencySplit = split[4].split('/');
    data.expected_efficiency = parseFloat(efficiencySplit[0].replace(/e/g, ''));
    data.actual_efficiency = parseFloat(efficiencySplit[1].replace(/[a,]/g, ''));

    var efficiencyTrueSplit = split[6].split('/');
    data.expected_true_efficiency = parseFloat(efficiencyTrueSplit[0].replace(/e/g, ''));
    data.actual_true_efficiency = parseFloat(efficiencyTrueSplit[1].replace(/[a,]/g, ''));
    data._turnFieldsAreFloat = true;

    return data;
  };

  /* ============================ CycleStatsData ============================ */

  function CycleStatsData(team, players) {
    this.team = team;
    this.players = players;

    this.tiles_gained = 0;
    this.score_gained = 0;
    this.cities_gained = 0;
    this.moves_spent_capturing_fog_tiles = 0;
    this.moves_spent_capturing_visible_tiles = 0;
    this.moves_spent_gathering_fog_tiles = 0;
    this.moves_spent_gathering_visible_tiles = 0;
    this.moves_spent_gathering_neutral_city_capture = 0;
    this.neutral_city_army_spent = 0;
    this.approximate_army_gathered_this_cycle = 0;
    this.army_annihilated_visible = 0;
    this.army_annihilated_fog = 0;
    this.army_annihilated_total = 0;
    this.approximate_fog_army_available_total = 0;
    this.approximate_fog_army_available_total_true = 0;
    this.number_assumed_two_expansions_that_may_be_fog_distance = 0;
    this.approximate_fog_city_army = 0;
    this.fog_city_count = 0;
  }

  var CSD = CycleStatsData.prototype;

  // 原版有个 _approximate_fog_army_available_total 私有字段挂 property，这里直接用公开名，
  // 但保留私有别名访问（did_player_already_attack_this_round 原文读的是私有字段）。
  Object.defineProperty(CSD, '_approximate_fog_army_available_total', {
    get: function () {
      return this.approximate_fog_army_available_total;
    }
  });
  Object.defineProperty(CSD, '_approximate_fog_army_available_total_true', {
    get: function () {
      return this.approximate_fog_army_available_total_true;
    }
  });

  CSD.clone = function () {
    var c = new CycleStatsData(this.team, this.players);
    c.tiles_gained = this.tiles_gained;
    c.score_gained = this.score_gained;
    c.cities_gained = this.cities_gained;
    c.moves_spent_capturing_fog_tiles = this.moves_spent_capturing_fog_tiles;
    c.moves_spent_capturing_visible_tiles = this.moves_spent_capturing_visible_tiles;
    c.moves_spent_gathering_fog_tiles = this.moves_spent_gathering_fog_tiles;
    c.moves_spent_gathering_visible_tiles = this.moves_spent_gathering_visible_tiles;
    c.moves_spent_gathering_neutral_city_capture = this.moves_spent_gathering_neutral_city_capture;
    c.neutral_city_army_spent = this.neutral_city_army_spent;
    c.approximate_army_gathered_this_cycle = this.approximate_army_gathered_this_cycle;
    c.army_annihilated_visible = this.army_annihilated_visible;
    c.army_annihilated_fog = this.army_annihilated_fog;
    c.army_annihilated_total = this.army_annihilated_total;
    c.approximate_fog_army_available_total = this.approximate_fog_army_available_total;
    c.approximate_fog_army_available_total_true = this.approximate_fog_army_available_total_true;
    c.approximate_fog_city_army = this.approximate_fog_city_army;
    c.fog_city_count = this.fog_city_count;
    return c;
  };

  CSD.toString = function () {
    return (
      'g:' +
      this.approximate_army_gathered_this_cycle +
      '  Δt:' +
      this.tiles_gained +
      '  Δc:' +
      this.cities_gained +
      '   a:' +
      this.approximate_fog_army_available_total +
      '/c:' +
      this.approximate_fog_city_army +
      ' (true ' +
      this.approximate_fog_army_available_total +
      ')'
    );
  };

  /* ========================== PlayerMoveCategory ========================== */

  function mkMoveCategory(name, value) {
    return { name: name, value: value };
  }

  // 原版是 Enum，成员是单例，比较靠身份；这里每个成员也只有一个对象实例。
  var PlayerMoveCategory = {
    FogGather: mkMoveCategory('FogGather', 1),
    FogCapture: mkMoveCategory('FogCapture', 2),
    VisibleGather: mkMoveCategory('VisibleGather', 3),
    VisibleCapture: mkMoveCategory('VisibleCapture', 4),
    Wasted: mkMoveCategory('Wasted', 5),
    byValue: function (v) {
      if (v === 1) return PlayerMoveCategory.FogGather;
      if (v === 2) return PlayerMoveCategory.FogCapture;
      if (v === 3) return PlayerMoveCategory.VisibleGather;
      if (v === 4) return PlayerMoveCategory.VisibleCapture;
      if (v === 5) return PlayerMoveCategory.Wasted;
      return null;
    }
  };

  /* ======================= UnresolvedEmergenceData ======================= */

  function UnresolvedEmergenceData(amount, tile) {
    this.amount = amount;
    this.tile = tile;
  }

  UnresolvedEmergenceData.prototype.serialize = function () {
    return this.amount + ':' + this.tile.x + ',' + this.tile.y;
  };

  UnresolvedEmergenceData.parse = function (map, data) {
    var parts = String(data).split(':');
    var amountRaw = parts[0];
    var tileRaw = parts[1];
    var xy = tileRaw.split(',');
    return new UnresolvedEmergenceData(parseInt(amountRaw, 10), map.GetTile(parseInt(xy[0], 10), parseInt(xy[1], 10)));
  };

  /* ============================ OpponentTracker ============================ */

  function OpponentTracker(map, viewInfo) {
    this.outbound_emergence_notifications = [];
    this.map = map;
    this.team_score_data_history = [];
    for (var i = 0; i < SAFE_PLAYERS_CAP; i++) this.team_score_data_history.push({});
    this.targetPlayer = -1;
    this.skip_this_turn = false;

    this.current_team_scores = [];
    var teamRange = Math.max.apply(null, map.unique_teams) + 2;
    for (var t0 = 0; t0 < teamRange; t0++) this.current_team_scores.push(map.get_team_stats_by_team_id(t0));

    this.last_team_scores = [];
    for (var t1 = 0; t1 < SAFE_PLAYERS_CAP; t1++) this.last_team_scores.push(null);

    this.team_cycle_stats_history = [];
    for (var t2 = 0; t2 < SAFE_PLAYERS_CAP; t2++) this.team_cycle_stats_history.push(null);

    this.current_team_cycle_stats = [];
    for (var t3 = 0; t3 < SAFE_PLAYERS_CAP; t3++) this.current_team_cycle_stats.push(null);

    this.assumed_player_average_tile_values = [];
    for (var p0 = 0; p0 < map.players.length; p0++) this.assumed_player_average_tile_values.push(0.0);
    this.assumed_player_average_tile_values.push(0.0);

    this.team_attack_cycle_timings = [];
    var attackRange = Math.max.apply(null, map.team_ids_by_player_index) + 2;
    for (var t4 = 0; t4 < attackRange; t4++) {
      this.team_attack_cycle_timings.push([new TeamAttackData(t4, 43, 0.5, 0.5)]);
    }

    this.last_player_move_type = [];
    for (var p1 = 0; p1 < map.players.length; p1++) this.last_player_move_type.push(null);

    this._team_indexes = [];
    this._team_lookup_by_player = EK.Map.get_teams_array(map);
    this._players_lookup_by_team = [];
    for (var t5 = 0; t5 < SAFE_PLAYERS_CAP; t5++) this._players_lookup_by_team.push([]);

    this._gather_queues_new_by_player = [];
    for (var p2 = 0; p2 < map.players.length; p2++) this._gather_queues_new_by_player.push(new FogGatherQueue(map.players[p2].index));

    this._emergences = [];
    this.current_largest_unresolved_emergence_by_player = [];
    this.largest_unresolved_emergence_history_by_player = [];
    for (var p3 = 0; p3 < map.players.length; p3++) {
      this.current_largest_unresolved_emergence_by_player.push(null);
      this.largest_unresolved_emergence_history_by_player.push({});
    }
    this.approximate_per_city_gather_distance = 6.0;
    this._revealed = new Set();
    this._moves_into_fog = [];
    this._vision_losses = new Set();
    this.view_info = viewInfo === undefined ? null : viewInfo;

    for (var ti = 0; ti < map.unique_teams.length; ti++) {
      var team = map.unique_teams[ti];
      for (var pi = 0; pi < map.players.length; pi++) {
        var player = map.players[pi];
        if (player.team === team) {
          var playerList = this._players_lookup_by_team[team];
          playerList.push(player.index);
          this._players_lookup_by_team[team] = playerList;
          this.assumed_player_average_tile_values[player.index] = 1.0;
          this.last_player_move_type[player.index] = PlayerMoveCategory.FogGather;
        }
      }

      this.team_score_data_history[team] = {};
      var teamPlayers = this.get_team_players(team);
      var turn0Stats = new CycleStatsData(team, teamPlayers);
      this.team_score_data_history[team][0] = new EK.TeamStats(
        0,
        0,
        0,
        turn0Stats.players.length,
        0,
        0,
        team,
        teamPlayers,
        teamPlayers,
        this.map.turn - 1,
        0
      );
      this.current_team_cycle_stats[team] = turn0Stats;
      this.team_cycle_stats_history[team] = {};
      this._team_indexes.push(team);
      this.current_team_scores[team] = null;
      this.last_team_scores[team] = null;
    }
  }

  var OT = OpponentTracker.prototype;

  OT.analyze_turn = function (targetPlayer) {
    this.targetPlayer = targetPlayer;

    for (var pi = 0; pi < this.map.players.length; pi++) {
      // 每回合先一律记成迷雾采集，后面再被真实动作覆盖
      this.last_player_move_type[this.map.players[pi].index] = PlayerMoveCategory.FogGather;
    }

    if (this.skip_this_turn) {
      this.skip_this_turn = false;
      return;
    }

    for (var ti = 0; ti < this._team_indexes.length; ti++) {
      var team = this._team_indexes[ti];
      var curTurnTeamScore = this.map.get_team_stats_by_team_id(team);

      var teamStats = this.calculate_cycle_stats(team, curTurnTeamScore);

      // 初始化/恢复存档时可能在循环历史还没建好就分析，原版保留已初始化的 current 统计而不覆盖
      if (teamStats !== null) this.current_team_cycle_stats[team] = teamStats;

      if (this.map.turn === 2) {
        // 伪造 turn 0 的数据，让第一个循环也能算东西
        curTurnTeamScore.score -= curTurnTeamScore.cityCount;
        this.team_score_data_history[team][0] = curTurnTeamScore;
        curTurnTeamScore = this.map.get_team_stats_by_team_id(team);
      }

      this.last_team_scores[team] = this.current_team_scores[team];
      this.current_team_scores[team] = curTurnTeamScore;
    }

    this._emergences = [];
    this._moves_into_fog = [];
    this._revealed = new Set();
    this._vision_losses = new Set();

    this.recalculate_average_tile_values();
  };

  OT.get_current_cycle_end_turn = function () {
    var remainingCycleTurns = 50 - (this.map.turn % 50);
    return this.map.turn + remainingCycleTurns;
  };

  OT.get_last_cycle_end_turn_raw = function (cyclesToGoBack) {
    if (cyclesToGoBack === undefined) cyclesToGoBack = 0;
    var cycleTurn = this.map.turn % 50;
    if (cycleTurn === 0) cyclesToGoBack += 1;

    var turn = this.map.turn - cycleTurn - 50 * cyclesToGoBack;
    if (turn < 0) return null;
    return turn;
  };

  OT.get_last_cycle_end_turn = function (cyclesToGoBack) {
    if (cyclesToGoBack === undefined) cyclesToGoBack = 0;
    var turn = this.get_last_cycle_end_turn_raw(cyclesToGoBack);

    var exampleTeamStats = this.team_score_data_history[this._team_indexes[0]];

    if (exampleTeamStats[turn] === undefined || exampleTeamStats[turn] === null) return null;
    return turn;
  };

  OT.get_last_cycle_stats_per_team = function () {
    var lastCycleEndTurn = this.get_last_cycle_end_turn();
    var ret = {};
    for (var ti = 0; ti < this._team_indexes.length; ti++) {
      var team = this._team_indexes[ti];
      var v = this.team_cycle_stats_history[team][lastCycleEndTurn];
      ret[team] = v === undefined ? null : v;
    }
    return ret;
  };

  OT.get_last_cycle_stats_by_team = function (team, cyclesToGoBack) {
    if (cyclesToGoBack === undefined) cyclesToGoBack = 0;
    var lastCycleTurn = this.get_last_cycle_end_turn(cyclesToGoBack);
    var v = this.team_cycle_stats_history[team][lastCycleTurn];
    return v === undefined ? null : v;
  };

  OT.get_last_cycle_stats_by_player = function (player, cyclesToGoBack) {
    return this.get_last_cycle_stats_by_team(this._team_lookup_by_player[player], cyclesToGoBack);
  };

  OT.get_last_cycle_score_by_team = function (team, cyclesToGoBack) {
    if (cyclesToGoBack === undefined) cyclesToGoBack = 0;
    var lastCycleTurn = this.get_last_cycle_end_turn(cyclesToGoBack);
    var v = this.team_score_data_history[team][lastCycleTurn];
    return v === undefined ? null : v;
  };

  OT.get_last_cycle_score_by_player = function (player, cyclesToGoBack) {
    return this.get_last_cycle_score_by_team(this._team_lookup_by_player[player], cyclesToGoBack);
  };

  OT.get_player_gather_queue = function (player) {
    if (player === -1) throw new Error('Player p' + player + ' is not a valid player to retrieve a gather queue for');
    return this._gather_queues_new_by_player[player];
  };

  OT.get_cycle_index = function (overrideTurn) {
    var t = overrideTurn === undefined || overrideTurn === null ? this.map.turn : overrideTurn;
    return Math.floor(t / 50);
  };

  OT.get_team_players = function (team) {
    if (team === -1) return [-1];
    return this._players_lookup_by_team[team];
  };

  OT.get_team_players_by_player = function (player) {
    if (player === -1) return [-1];
    return this._players_lookup_by_team[this._team_lookup_by_player[player]];
  };

  OT.get_current_cycle_stats_by_player = function (player) {
    return this.current_team_cycle_stats[this._team_lookup_by_player[player]];
  };

  OT.get_current_team_scores_by_player = function (player) {
    return this.current_team_scores[this._team_lookup_by_player[player]];
  };

  OT.did_player_make_fog_capture_move = function (player) {
    return this.last_player_move_type[player] === PlayerMoveCategory.FogCapture;
  };

  OT.did_player_make_fog_gather_move = function (player) {
    return this.last_player_move_type[player] === PlayerMoveCategory.FogGather;
  };

  /* ====================== 每回合的循环统计推进 ====================== */

  // Python 的 team_ids_by_player_index[-1] 取最后一个元素（伪中立团队 -1）；
  // JS 数组下标 -1 是 undefined，所以凡是用 player 喂 team 的地方都走这里。
  function teamOfPlayer(map, player) {
    if (player < 0) return map.team_ids_by_player_index[map.team_ids_by_player_index.length - 1];
    return map.team_ids_by_player_index[player];
  }

  function isPlayerOnTeamWith(map, a, b) {
    return teamOfPlayer(map, a) === teamOfPlayer(map, b);
  }

  OT.calculate_cycle_stats = function (team, curTurnScores) {
    var lastCycleEndTurn = this.get_last_cycle_end_turn();
    if (lastCycleEndTurn === null) return null;

    var res = this._update_cycle_stats_and_moves_no_checks(team, curTurnScores, lastCycleEndTurn);
    var currentCycleStats = res[0];
    var lastCycleScores = res[1];

    var isCycleEnd = this.map.is_army_bonus_turn;
    var isCityBonus = this.map.is_city_bonus_turn;
    if (isCityBonus) this._include_city_bonus(currentCycleStats);

    if (isCycleEnd) {
      this.team_score_data_history[team][this.map.turn] = curTurnScores;
      this.team_cycle_stats_history[team][this.map.turn] = currentCycleStats;
      for (var ei = 0; ei < currentCycleStats.players.length; ei++) {
        var player = currentCycleStats.players[ei];
        var emergenceData = this.current_largest_unresolved_emergence_by_player[player];
        if (emergenceData !== null && emergenceData !== undefined) {
          this.largest_unresolved_emergence_history_by_player[player][this.map.turn] = emergenceData;
          this.current_largest_unresolved_emergence_by_player[player] = null;
        }
        var history = this.largest_unresolved_emergence_history_by_player[player];
        var histTurns = Object.keys(history).map(Number);
        if (histTurns.length > UNRESOLVED_EMERGENCE_HISTORY_ROUNDS_TO_SERIALIZE) {
          histTurns.sort(function (a, b) {
            return b - a;
          });
          var toDrop = histTurns.slice(UNRESOLVED_EMERGENCE_HISTORY_ROUNDS_TO_SERIALIZE);
          for (var di = 0; di < toDrop.length; di++) delete history[toDrop[di]];
        }
      }

      // 记完循环末数据之后再重置
      currentCycleStats = this._start_next_cycle_stats_and_gather_queue(currentCycleStats, currentCycleStats, curTurnScores, lastCycleScores);
      this.current_team_cycle_stats[currentCycleStats.team] = currentCycleStats;

      for (var gi = 0; gi < currentCycleStats.players.length; gi++) {
        var gatherQueue = this.get_player_gather_queue(currentCycleStats.players[gi]);
        gatherQueue.increment_army_bonus();
      }

      this._start_team_score_next_cycle_and_record_efficiencies(curTurnScores, team, currentCycleStats);
    }

    this._check_missing_fog_gather_tiles(currentCycleStats);

    this._validate_army_totals(curTurnScores, currentCycleStats);

    return currentCycleStats;
  };

  OT._update_cycle_stats_and_moves_no_checks = function (team, curTurnScores, lastCycleEndTurn, skipTurn) {
    var lastTurnScores = this.current_team_scores[team];
    var currentCycleStats = this.current_team_cycle_stats[team];
    if (currentCycleStats === null || currentCycleStats === undefined) currentCycleStats = this.initialize_cycle_stats(team);

    var lastCycleScores = this.team_score_data_history[team][lastCycleEndTurn];
    if (lastCycleScores === undefined) lastCycleScores = null;

    if (!skipTurn) {
      this._handle_reveals(currentCycleStats);
      this._handle_emergences(currentCycleStats);
      this._handle_moves_into_fog(currentCycleStats);
      this._update_team_cycle_stats_based_on_turn_deltas(currentCycleStats, curTurnScores, lastTurnScores);
      this._handle_vision_losses(currentCycleStats);
    }

    currentCycleStats.fog_city_count = curTurnScores.cityCount;
    for (var pi = 0; pi < currentCycleStats.players.length; pi++) {
      var pIdx = currentCycleStats.players[pi];
      var p = this.map.players[pIdx];
      if (p.tileCount === 0) continue;
      for (var ci = 0; ci < p.cities.length; ci++) {
        if (p.cities[ci].visible) currentCycleStats.fog_city_count -= 1;
      }
      if (p.general !== null && p.general !== undefined && p.general.isGeneral && p.general.visible) {
        currentCycleStats.fog_city_count -= 1;
      }
    }

    this._update_team_cycle_stats_relative_to_last_cycle(currentCycleStats, curTurnScores, lastCycleScores);

    return [currentCycleStats, lastCycleScores];
  };

  OT._update_team_cycle_stats_based_on_turn_deltas = function (currentCycleStats, currentTeamStats, lastTurnTeamStats) {
    for (var pi = 0; pi < currentCycleStats.players.length; pi++) {
      var playerIdx = currentCycleStats.players[pi];
      var player = this.map.players[playerIdx];
      if (player.dead) continue;

      if (player.last_move === null || player.last_move === undefined) {
        this._check_missing_move(player, currentCycleStats, currentTeamStats);
      } else {
        this._check_visible_move(player, currentCycleStats);
      }
    }
  };

  OT.initialize_cycle_stats = function (team) {
    var players = this.get_team_players(team);
    return new CycleStatsData(team, players);
  };

  OT._update_team_cycle_stats_relative_to_last_cycle = function (currentCycleStats, currentTeamStats, lastCycleScores) {
    var calculatedTilesGained = currentTeamStats.tileCount - lastCycleScores.tileCount;
    if (calculatedTilesGained !== currentCycleStats.tiles_gained) currentCycleStats.tiles_gained = calculatedTilesGained;

    currentCycleStats.score_gained = currentTeamStats.score - lastCycleScores.score;
    currentCycleStats.cities_gained = currentTeamStats.cityCount - lastCycleScores.cityCount;
  };

  OT._start_next_cycle_stats_and_gather_queue = function (currentCycleStats, lastCycleStats, currentTeamStats, lastCycleTeamStats) {
    var nextStats = new CycleStatsData(currentCycleStats.team, currentCycleStats.players);

    nextStats.approximate_fog_army_available_total = currentCycleStats.approximate_fog_army_available_total;
    nextStats.approximate_fog_army_available_total_true = currentCycleStats.approximate_fog_army_available_total_true;
    nextStats.approximate_fog_city_army = currentCycleStats.approximate_fog_city_army;
    nextStats.fog_city_count = currentCycleStats.fog_city_count;
    var fogData = this.calculate_team_fog_tile_data(currentCycleStats.team);
    var fogCityCount = fogData[2];
    // 迷雾城也会吃兵量加成，而这里正是循环加成那一回合
    nextStats.approximate_fog_city_army += fogCityCount;

    return nextStats;
  };

  /* ------------------- 各种「这一步到底是啥动作」推断 ------------------- */

  OT._check_missing_move = function (player, currentCycleStats, currentTeamStats) {
    var knownDelta = player.knownScoreDelta;
    var playerAnnihilated = knownDelta - player.actualScoreDelta;

    var hasPerfectPlayerInfo = this.map.remainingPlayers === 2 || this.map.is_2v2;
    var isPotentialMultiPartFogCap =
      player.tileCount > 0 &&
      ((player.standingArmy > 30 && playerAnnihilated > Math.floor(player.standingArmy / player.tileCount)) ||
        (playerAnnihilated > 1 && hasPerfectPlayerInfo));

    var predeterminedLastMove = this.last_player_move_type[player.index];
    if (predeterminedLastMove !== PlayerMoveCategory.FogGather) return;

    if (player.unexplainedTileDelta > 0 && currentTeamStats.unexplainedTileDelta >= 0) {
      var teamAnnihilatedFog = this._get_team_annihilated_fog_internal(currentTeamStats, player);

      if (teamAnnihilatedFog > 0) {
        var tookCity = player.lastCityCount < player.cityCount;
        if (tookCity) {
          if (currentCycleStats.team !== this.map.team_ids_by_player_index[this.map.player_index]) {
            currentCycleStats.neutral_city_army_spent += teamAnnihilatedFog;
            var gatherMoveCount =
              currentCycleStats.moves_spent_gathering_fog_tiles + currentCycleStats.moves_spent_gathering_visible_tiles;
            this.record_neutral_city_capture_gather_time(
              player.index,
              teamAnnihilatedFog,
              gatherMoveCount,
              currentCycleStats.approximate_army_gathered_this_cycle
            );
          }
        }

        this._assume_fog_player_capture_move(player, currentCycleStats, teamAnnihilatedFog, false);
        teamAnnihilatedFog = 0;
      } else if (teamAnnihilatedFog < 0) {
        // 原版这里报 "This should be impossible"：他们吃了自己人的地
        this._assume_fog_gather_move(player, currentCycleStats, true);
      } else {
        this._assume_fog_empty_tile_capture_move(player, currentCycleStats);
      }
    } else if (player.unexplainedTileDelta < 0) {
      if (currentTeamStats.unexplainedTileDelta < 0) {
        this._assume_fog_under_attack_move(player, currentCycleStats, true, playerAnnihilated);
      } else {
        this._assume_fog_gather_move(player, currentCycleStats, false);
      }
    } else if (isPotentialMultiPartFogCap) {
      this._assume_fog_player_capture_move(player, currentCycleStats, playerAnnihilated, true);
    } else if (playerAnnihilated > 0) {
      this._assume_fog_gather_move(player, currentCycleStats, false);

      this.consume_fog_army_no_move(player.index, playerAnnihilated, true, currentCycleStats);
    } else {
      this._assume_fog_gather_move(player, currentCycleStats, false);
    }
  };

  OT._check_visible_move = function (player, currentCycleStats) {
    var source = player.last_move[0];
    var dest = player.last_move[1];

    if (isPlayerOnTeamWith(this.map, player.index, dest.delta.oldOwner)) {
      if (dest.visible) {
        if (dest.delta.oldArmy > 1 || !dest.delta.gainedSight) {
          currentCycleStats.moves_spent_gathering_visible_tiles += 1;
          this.last_player_move_type[player.index] = PlayerMoveCategory.VisibleGather;
        } else {
          this.last_player_move_type[player.index] = PlayerMoveCategory.Wasted;
        }
      } else {
        currentCycleStats.moves_spent_gathering_fog_tiles += 1;
        this.last_player_move_type[player.index] = PlayerMoveCategory.FogGather;
      }
    } else {
      currentCycleStats.moves_spent_capturing_visible_tiles += 1;
      currentCycleStats.army_annihilated_visible -= source.delta.armyDelta;
      if (dest.player() === player.index) {
        currentCycleStats.army_annihilated_visible -= dest.army - dest.delta.expectedDelta;
      }

      if (dest.delta.oldOwner === -1 && dest.isCity) {
        currentCycleStats.neutral_city_army_spent += dest.delta.oldArmy;
        var gatherMoveCount =
          currentCycleStats.moves_spent_gathering_fog_tiles + currentCycleStats.moves_spent_gathering_visible_tiles;
        this.record_neutral_city_capture_gather_time(
          player.index,
          dest.delta.oldArmy,
          gatherMoveCount,
          currentCycleStats.approximate_army_gathered_this_cycle
        );
      }

      this.last_player_move_type[player.index] = PlayerMoveCategory.VisibleCapture;
    }
  };

  OT._assume_fog_gather_move = function (player, currentCycleStats, gatheringAllyTile) {
    var playerToGatherFromQueue = player.index;
    if (gatheringAllyTile) {
      for (var pi = 0; pi < currentCycleStats.players.length; pi++) {
        var pIdx = currentCycleStats.players[pi];
        if (pIdx === player.index) continue;
        playerToGatherFromQueue = pIdx;
      }
    }

    var gatherQueueSource = this.get_player_gather_queue(playerToGatherFromQueue);
    var gatherVal = gatherQueueSource.pop_next_highest(false);
    if (gatherVal) {
      var gatherQueueDest = this.get_player_gather_queue(player.index);
      gatherQueueDest.append(1);

      currentCycleStats.approximate_army_gathered_this_cycle += gatherVal - 1;
      currentCycleStats.approximate_fog_army_available_total += gatherVal - 1;
      currentCycleStats.approximate_fog_army_available_total_true += gatherVal - 1;
    }

    currentCycleStats.moves_spent_gathering_fog_tiles += 1;
    this.last_player_move_type[player.index] = PlayerMoveCategory.FogGather;
  };

  OT._assume_fog_empty_tile_capture_move = function (player, currentCycleStats) {
    var gatherQueue = this.get_player_gather_queue(player.index);

    if (!this._try_remove_queued_gather_for_amount(player.index, 2, true)) {
      currentCycleStats.approximate_army_gathered_this_cycle -= 1;
      currentCycleStats.approximate_fog_army_available_total -= 1;
      currentCycleStats.approximate_fog_army_available_total_true -= 1;
      currentCycleStats.number_assumed_two_expansions_that_may_be_fog_distance += 1;
    }

    this._check_available_fog_army(currentCycleStats, true);

    currentCycleStats.moves_spent_capturing_fog_tiles += 1;
    currentCycleStats.tiles_gained += 1;
    gatherQueue.append(1);

    this.last_player_move_type[player.index] = PlayerMoveCategory.FogCapture;
  };

  OT._assume_fog_player_capture_move = function (player, currentCycleStats, annihilatedFogArmy, noCapture) {
    currentCycleStats.army_annihilated_fog += annihilatedFogArmy;
    currentCycleStats.approximate_army_gathered_this_cycle -= annihilatedFogArmy;
    currentCycleStats.approximate_fog_army_available_total -= annihilatedFogArmy;
    currentCycleStats.approximate_fog_army_available_total_true -= annihilatedFogArmy;
    var gatherQueue = this.get_player_gather_queue(player.index);

    // 吃掉的兵超过了我们的估算，而队列里还压着一张更大的牌：用那张牌来顶这一刀
    if (
      currentCycleStats.approximate_fog_army_available_total < 0 &&
      gatherQueue.peek_next_highest() > annihilatedFogArmy + 2
    ) {
      this._remove_queued_gather_closest_to_amount(player.index, annihilatedFogArmy + 2, true);
      currentCycleStats.approximate_army_gathered_this_cycle += annihilatedFogArmy;
      currentCycleStats.approximate_fog_army_available_total += annihilatedFogArmy;
      currentCycleStats.approximate_fog_army_available_total_true += annihilatedFogArmy;
    }

    this._check_available_fog_army(currentCycleStats, true);

    currentCycleStats.moves_spent_capturing_fog_tiles += 1;

    if (!noCapture) {
      currentCycleStats.approximate_army_gathered_this_cycle -= 1;
      currentCycleStats.approximate_fog_army_available_total -= 1;
      currentCycleStats.approximate_fog_army_available_total_true -= 1;
      currentCycleStats.tiles_gained += 1;
      gatherQueue.append(1);
    }

    this.last_player_move_type[player.index] = PlayerMoveCategory.FogCapture;
  };

  OT._assume_fog_under_attack_move = function (player, currentCycleStats, tileCapturedBySomeoneElse, annihilated) {
    if (tileCapturedBySomeoneElse) {
      currentCycleStats.tiles_gained -= 1;
    } else {
      this._assume_fog_gather_move(player, currentCycleStats, false);
    }

    if (annihilated <= this.assumed_player_average_tile_values[player.index] * 1.5) {
      // 我们判断他们没动用攒下来的兵去顶，只是单纯地被吃地
      var removed = this._remove_queued_gather_closest_to_amount(player.index, annihilated, false);
      if (removed !== -1) annihilated -= removed;
    }

    currentCycleStats.approximate_fog_army_available_total -= annihilated;
    currentCycleStats.approximate_fog_army_available_total_true -= annihilated;
    currentCycleStats.approximate_army_gathered_this_cycle -= annihilated;
  };

  /* ----------------------- 迷雾格均值 & 循环重置 ----------------------- */

  OT.recalculate_average_tile_values = function () {
    for (var ti = 0; ti < this._team_indexes.length; ti++) {
      var team = this._team_indexes[ti];
      var curCycleStats = this.current_team_cycle_stats[team];
      var curTeamStats = this.current_team_scores[team];
      var lastCycleStats = this.get_last_cycle_stats_by_team(team, 0);

      if (curCycleStats === null || curCycleStats === undefined) continue;
      if (curTeamStats === null || curTeamStats === undefined) continue;

      var teamHasGatheredAllTiles =
        curCycleStats.approximate_army_gathered_this_cycle >= curTeamStats.standingArmy - curCycleStats.approximate_fog_city_army;

      var teamAverageUngatheredTileVal = this._calculate_tile_average_value(curCycleStats, curTeamStats, lastCycleStats);

      for (var pi = 0; pi < this._players_lookup_by_team[team].length; pi++) {
        var playerIndex = this._players_lookup_by_team[team][pi];
        var player = this.map.players[playerIndex];
        if (player.dead) {
          this.assumed_player_average_tile_values[player.index] = 0.0;
          continue;
        }

        if (teamHasGatheredAllTiles) teamAverageUngatheredTileVal = 1.0;

        this.assumed_player_average_tile_values[player.index] = teamAverageUngatheredTileVal;
      }
    }
  };

  OT._calculate_tile_average_value = function (curCycleStats, curTeamStats, lastCycleStats) {
    var fogData = this.calculate_team_fog_tile_data(curCycleStats.team);
    var fogTileCount = fogData[0];
    var fogArmyAmount = fogData[1];
    var fogCityCount = fogData[2];

    var relevantFogArmy =
      fogArmyAmount - curCycleStats.approximate_army_gathered_this_cycle - curCycleStats.approximate_fog_city_army;

    var ungatheredTileCount = fogTileCount - curCycleStats.moves_spent_gathering_fog_tiles - fogCityCount;

    var average = 0.0;
    if (ungatheredTileCount > 0) average = relevantFogArmy / ungatheredTileCount;

    return average;
  };

  OT._start_team_score_next_cycle_and_record_efficiencies = function (curTurnTeamScore, team, teamStats) {
    this.team_score_data_history[team][this.map.turn] = curTurnTeamScore;
    var probableLeftoverUngatheredTileArmyAmts = 0;
    if (teamStats !== null && teamStats !== undefined) {
      this.team_cycle_stats_history[team][this.map.turn] = teamStats.clone();
      if (this.map.turn > 99) {
        var oldTotal = teamStats.approximate_fog_army_available_total;
        var toReduceTo = pyRound(0.96 * teamStats.approximate_fog_army_available_total + 0.49);
        var diff = oldTotal - toReduceTo;
        if (diff > 0) {
          probableLeftoverUngatheredTileArmyAmts = diff;
          teamStats.approximate_fog_army_available_total = toReduceTo;
          if (this.view_info) {
            this.view_info.add_info_line(
              'Updated team ' +
                team +
                ' approx fog army from ' +
                oldTotal +
                ' to ' +
                teamStats.approximate_fog_army_available_total +
                ' (true total ' +
                teamStats.approximate_fog_army_available_total_true +
                ')'
            );
          }
        }
      }
    }

    var expectedEfficiency = 0.9;
    var expectedTrueEfficiency = 0.85;
    var expectedAttackTurn = 40;
    var attackHist = this.team_attack_cycle_timings[team];
    var curCycle = this.get_cycle_index();

    if (curCycle > 1) {
      var start = Math.max(1, curCycle - 4);
      var numIncluded = 0;
      var sumAttackTurn = 0;
      var sumEfficiency = 0.0;
      var sumTrueEfficiency = 0.0;
      for (var hi = start; hi < attackHist.length; hi++) {
        var hist = attackHist[hi];
        if (hist.actual_attack_cycle_turn !== -1) {
          numIncluded += 1;
          sumAttackTurn += hist.actual_attack_cycle_turn;
          sumEfficiency += hist.actual_efficiency;
          sumTrueEfficiency += hist.actual_true_efficiency;
        }
      }

      if (numIncluded > 0) {
        expectedAttackTurn = sumAttackTurn / numIncluded;
        expectedEfficiency = sumEfficiency / numIncluded;
        expectedTrueEfficiency = sumTrueEfficiency / numIncluded;
      }
    }

    attackHist.push(new TeamAttackData(team, expectedAttackTurn, expectedEfficiency, expectedTrueEfficiency));

    if (probableLeftoverUngatheredTileArmyAmts !== 0) {
      var actions = [];
      var guard = 0;
      while (probableLeftoverUngatheredTileArmyAmts > 0 && guard < 10000) {
        guard += 1;
        for (var li = 0; li < curTurnTeamScore.livingPlayers.length; li++) {
          var player = curTurnTeamScore.livingPlayers[li];
          var q = this._gather_queues_new_by_player[player];
          var qMax = q.cur_max_tile_size;
          var toPutBackIntoRotation = Math.min(Math.floor(qMax / 2) + 2, probableLeftoverUngatheredTileArmyAmts);
          var actualTile = q.remove_queued_gather_closest_to_amount(1, false);
          if (actualTile === -1) continue;
          var incorrectAmt = actualTile - 2;
          var actualToQueue = toPutBackIntoRotation - incorrectAmt;
          actions.push('p' + player + ' ' + actualTile + ':' + actualToQueue);
          probableLeftoverUngatheredTileArmyAmts -= actualToQueue;
          q.append(actualToQueue);
        }
      }
      void actions;
    }
  };

  /* ---------------------- 回调入口：揭示 / 视野丢失 ---------------------- */

  OT.notify_emerged_army = function (tile, emergingPlayer, emergenceAmount) {
    this._emergences.push([tile, emergingPlayer, emergenceAmount]);
  };

  OT.notify_unresolved_emerged_army = function (tile, emergingPlayer, emergenceAmount) {
    var existing = this.current_largest_unresolved_emergence_by_player[emergingPlayer];
    if (existing !== null && existing !== undefined && existing.amount >= emergenceAmount) return;

    this.current_largest_unresolved_emergence_by_player[emergingPlayer] = new UnresolvedEmergenceData(emergenceAmount, tile);
  };

  OT.get_last_attacked_from_locations = function (forPlayer, lastNRounds) {
    if (lastNRounds === undefined) lastNRounds = 1;
    var ret = [];
    var currentEmergence = this.current_largest_unresolved_emergence_by_player[forPlayer];
    if (currentEmergence === null || currentEmergence === undefined) {
      ret.push(null);
    } else {
      ret.push([currentEmergence.amount, currentEmergence.tile]);
    }

    var history = this.largest_unresolved_emergence_history_by_player[forPlayer];
    for (var cyclesToGoBack = 0; cyclesToGoBack < lastNRounds - 1; cyclesToGoBack++) {
      var cycleTurn = this.get_last_cycle_end_turn_raw(cyclesToGoBack);
      if (cycleTurn === null) {
        ret.push(null);
        continue;
      }

      var historicalEmergence = history[cycleTurn];
      if (historicalEmergence === undefined || historicalEmergence === null) {
        ret.push(null);
      } else {
        ret.push([historicalEmergence.amount, historicalEmergence.tile]);
      }
    }

    return ret;
  };

  OT.get_last_attacked_from_location = function (forPlayer) {
    return this.get_last_attacked_from_locations(forPlayer, 1)[0];
  };

  OT.notify_player_tile_revealed = function (tile) {
    this._revealed.add(tile);
  };

  OT.notify_player_tile_vision_lost = function (tile) {
    if (tile.player() >= 0) this._vision_losses.add(tile);
  };

  OT.notify_tile_flipped_for_player = function (tile) {
    // 原版就是空实现，留着占位好让调用方统一接
    void tile;
  };

  OT.notify_army_moved = function (army) {
    if (!army.visible && army.path && army.path.length) this._moves_into_fog.push(army);
  };

  OT._handle_emergences = function (currentCycleStats) {
    var toKeep = new Map();
    for (var i = 0; i < this._emergences.length; i++) {
      var tile = this._emergences[i][0];
      var emergingPlayer = this._emergences[i][1];
      var emergence = this._emergences[i][2];
      var key = tile.tile_index * 100 + emergingPlayer;
      var exist = toKeep.get(key);
      if (exist !== undefined) {
        if (emergence <= exist[2]) continue;
      }
      toKeep.set(key, [tile, emergingPlayer, emergence]);
    }

    var vals = [];
    toKeep.forEach(function (v) {
      vals.push(v);
    });
    // 原版 sorted(key=tup[2])，稳定升序
    vals.sort(function (a, b) {
      return a[2] - b[2];
    });

    for (var vi = 0; vi < vals.length; vi++) {
      var t = vals[vi][0];
      var ePlayer = vals[vi][1];
      var amt = vals[vi][2];

      if (amt < 0) amt = Math.abs(amt);

      if (currentCycleStats.players.indexOf(ePlayer) >= 0) {
        this._execute_emergence(currentCycleStats, t, amt, ePlayer);
      }
    }
  };

  OT._handle_moves_into_fog = function (currentCycleStats) {
    var used = new Set();
    for (var i = 0; i < this._moves_into_fog.length; i++) {
      var army = this._moves_into_fog[i];
      if (currentCycleStats.players.indexOf(army.player) < 0) continue;
      if (used.has(army.name)) continue;
      if (army.last_seen_turn < this.map.turn - 1) continue;

      var stats = this.get_current_cycle_stats_by_player(army.player);
      stats.approximate_fog_army_available_total += army.value;
      stats.approximate_fog_army_available_total_true += army.value;
      used.add(army.name);
    }
  };

  OT._handle_reveals = function (currentCycleStats) {
    var tiles = sortedTiles(this._revealed);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (currentCycleStats.players.indexOf(tile.player()) < 0) continue;

      var fogData = this.calculate_player_fog_tile_data(tile.player());
      var fogTileCount = fogData[0];
      var fogCityCount = fogData[2];

      var delta = Math.abs(tile.delta.unexplainedDelta);
      var armyToUse = Math.max(delta, tile.army);

      if (tile.delta.gainedSight && tile.army < armyToUse) {
        // 我们以为它是个 5，结果视野一亮发现是 1
        armyToUse = tile.army;
        delta = tile.army - 1;
      }

      var gathQueue = this.get_player_gather_queue(tile.player());
      var armyThresh = Math.max(1, gathQueue.peek_next_highest());

      if (tile.isCity || tile.isGeneral) {
        currentCycleStats.approximate_fog_city_army -= armyToUse;
      } else if (gathQueue.length > fogTileCount - fogCityCount) {
        this._remove_queued_gather_closest_to_amount(tile.player(), armyToUse, false);
      }

      if (armyToUse > armyThresh) {
        var emergenceArmy = Math.max(delta, armyToUse - 1);
        this.notify_emerged_army(tile, tile.player(), emergenceArmy);
      }
    }
  };

  OT._handle_vision_losses = function (currentCycleStats) {
    // 视野丢失的格子，兵量增量已经被 map 类补过了，所以必须放在「兵量加成 / 采集队列推进」之后入队
    var tiles = sortedTiles(this._vision_losses);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (currentCycleStats.players.indexOf(tile.player()) < 0) continue;

      var playerGathQueue = this.get_player_gather_queue(tile.player());

      var gathCutoff = 2;
      if (playerGathQueue.gatherable_length > 0) gathCutoff = playerGathQueue.peek_next_highest() * 1.5;

      if (tile.isCity || tile.isGeneral) {
        currentCycleStats.approximate_fog_city_army += tile.army - 1;
      } else if (tile.army > gathCutoff) {
        // 直接当成已经采集完的兵，队列里补一个 1
        currentCycleStats.approximate_fog_army_available_total += tile.army - 1;
        currentCycleStats.approximate_fog_army_available_total_true += tile.army - 1;

        playerGathQueue.append(1);
      } else {
        this.insert_amount_into_player_gather_queue(tile.player(), tile.army);
      }
    }
  };

  OT._remove_queued_gather_closest_to_amount = function (player, tileAmount, leaveOne) {
    return this.get_player_gather_queue(player).remove_queued_gather_closest_to_amount(tileAmount, leaveOne);
  };

  OT._try_remove_queued_gather_for_amount = function (player, tileAmount, leaveOne) {
    return this.get_player_gather_queue(player).try_remove_queued_gather_for_exact_amount(tileAmount, leaveOne);
  };

  OT.insert_amount_into_player_gather_queue = function (player, tileAmount) {
    this.get_player_gather_queue(player).append(tileAmount);
  };

  /* --------------------------- 迷雾格/城的数据 --------------------------- */

  OT.calculate_team_fog_tile_data = function (team) {
    var fogTileCount = 0;
    var fogArmyAmount = 0;
    var playerCountAliveOnTeam = 0;
    var fogCityCount = 0;
    for (var pi = 0; pi < this.map.players.length; pi++) {
      var player = this.map.players[pi];
      if (player.dead) continue;
      if (this._team_lookup_by_player[player.index] !== team) continue;

      playerCountAliveOnTeam += 1;
      var playerData = this.calculate_player_fog_tile_data(player.index);

      fogTileCount += playerData[0];
      fogArmyAmount += playerData[1];
      fogCityCount += playerData[2];
    }

    return [fogTileCount, fogArmyAmount, fogCityCount, playerCountAliveOnTeam];
  };

  OT.calculate_player_fog_tile_data = function (playerIndex) {
    var player = this.map.players[playerIndex];
    var playerFogTileCount = player.tileCount;
    var playerFogArmyAmount = player.score;
    var playerFogCityCount = player.cityCount;
    for (var i = 0; i < player.tiles.length; i++) {
      var tile = player.tiles[i];
      if (tile.visible) {
        playerFogTileCount -= 1;
        playerFogArmyAmount -= tile.army;
        if (tile.isGeneral || tile.isCity) playerFogCityCount -= 1;
      }
    }

    return [playerFogTileCount, playerFogArmyAmount, playerFogCityCount];
  };

  OT._include_city_bonus = function (currentCycleStats) {
    var fogData = this.calculate_team_fog_tile_data(currentCycleStats.team);
    currentCycleStats.approximate_fog_city_army += fogData[2];
  };

  OT._check_available_fog_army = function (currentCycleStats, forceFullArmyUsageFirst) {
    if (currentCycleStats.approximate_fog_army_available_total >= 0) return;

    var pulled = this.pull_team_fog_army_from_fog_cities(
      currentCycleStats.team,
      0 - currentCycleStats.approximate_fog_army_available_total,
      !forceFullArmyUsageFirst
    );

    currentCycleStats.approximate_fog_army_available_total += pulled;
    currentCycleStats.approximate_fog_army_available_total_true += pulled;
  };

  OT.pull_team_fog_army_from_fog_cities = function (team, amount, pullFullCityWorth) {
    var currentCycleStats = this.current_team_cycle_stats[team];
    return this._internal_pull_team_fog_army_from_fog_cities(currentCycleStats, amount, pullFullCityWorth);
  };

  OT.pull_player_fog_army_from_fog_cities = function (player, amount, pullFullCityWorth) {
    // 原版这里写的是 self._team_indexes[player]（拿玩家下标当 team 下标用），照抄
    return this.pull_team_fog_army_from_fog_cities(this._team_indexes[player], amount, pullFullCityWorth);
  };

  OT._internal_pull_team_fog_army_from_fog_cities = function (currentCycleStats, amount, pullFullCityWorth) {
    var fogCityOriginalAmount = currentCycleStats.approximate_fog_city_army;

    if (fogCityOriginalAmount <= 0) return 0;

    if (fogCityOriginalAmount <= amount) {
      currentCycleStats.approximate_fog_city_army = 0;
      return fogCityOriginalAmount;
    }

    if (!pullFullCityWorth) {
      currentCycleStats.approximate_fog_city_army -= amount;
      return amount;
    }

    // 否则要整座城的兵量一起拉出来
    var fogData = this.calculate_team_fog_tile_data(currentCycleStats.team);
    var fogCityCount = fogData[2];

    if (fogCityCount <= 0) return 0;

    var armyPerFogCity = Math.floor(fogCityOriginalAmount / fogCityCount);

    for (var i = 0; i < fogCityCount; i++) {
      if (currentCycleStats.approximate_fog_army_available_total >= 0) break;

      currentCycleStats.approximate_fog_army_available_total += armyPerFogCity;
      currentCycleStats.approximate_fog_army_available_total_true += armyPerFogCity;
      currentCycleStats.approximate_fog_city_army -= armyPerFogCity;
    }

    return 0; // 原版没有 return，等价于 None；调用方只在 _check_available_fog_army 里用，走不到这里
  };

  OT.get_all_player_fog_tile_count_dict = function () {
    var out = {};
    for (var pi = 0; pi < this.map.players.length; pi++) {
      var player = this.map.players[pi];
      out[player.index] = this.get_player_gather_queue(player.index).get_amount_dict();
    }
    return out;
  };

  OT.get_player_fog_tile_count_dict = function (playerIndex) {
    var player = this.map.players[playerIndex];
    return this.get_player_gather_queue(player.index).get_amount_dict();
  };

  OT._check_missing_fog_gather_tiles = function (currentCycleStats) {
    for (var pi = 0; pi < currentCycleStats.players.length; pi++) {
      var playerIdx = currentCycleStats.players[pi];
      var playerData = this.calculate_player_fog_tile_data(playerIdx);
      // 迷雾城不算可采集格
      var playerFogGathTileCount = playerData[0] - playerData[2];
      var queue = this.get_player_gather_queue(playerIdx);
      var guard = 0;
      while (queue.length < playerFogGathTileCount && guard < 10000) {
        guard += 1;
        queue.append(1);
      }
    }
  };

  /* --------------------------- 记录类回调入口 --------------------------- */

  OT.record_neutral_city_capture_army_spent = function (player, armySpent) {
    var stats = this.get_current_cycle_stats_by_player(player);
    if (stats === null || stats === undefined) return;
    if (armySpent <= 0) return;
    stats.neutral_city_army_spent += armySpent;
  };

  OT.record_neutral_city_capture_gather_time = function (player, amountSpentToCapCity, gatherMoveCount, gatheredArmyAmount) {
    var stats = this.get_current_cycle_stats_by_player(player);
    if (stats === null || stats === undefined) return;

    if (amountSpentToCapCity <= 0 || gatherMoveCount <= 0 || gatheredArmyAmount <= 0) return;

    var howMuchGatherTimeWasForCity = Math.min(1.0, amountSpentToCapCity / gatheredArmyAmount);
    stats.moves_spent_gathering_neutral_city_capture += Math.ceil(gatherMoveCount * howMuchGatherTimeWasForCity);
  };

  OT.get_max_possible_general_army_after_emergence = function (playerIndex, emergenceAmount) {
    var currentCycleStats = this.get_current_cycle_stats_by_player(playerIndex);
    if (currentCycleStats === null || currentCycleStats === undefined) return -1;

    var fogArmy = currentCycleStats.approximate_fog_army_available_total - Math.abs(emergenceAmount);
    var fogCityArmy = currentCycleStats.approximate_fog_city_army;
    while (fogArmy < 0 && fogCityArmy > 1) {
      var cityArmyPulled = Math.floor(fogCityArmy / 2);
      fogArmy += cityArmyPulled;
      fogCityArmy -= cityArmyPulled;
    }

    if (fogArmy < 0) fogArmy = 0;
    if (fogCityArmy < 0) fogCityArmy = 0;

    var playerData = this.calculate_player_fog_tile_data(playerIndex);
    var fogCityCount = playerData[2];
    return fogArmy + Math.max(0, fogCityArmy - fogCityCount);
  };

  OT._execute_emergence = function (currentCycleStats, tile, emergence, player) {
    if (player === -2) player = tile.player();

    var teamScores = this.current_team_scores[currentCycleStats.team];
    var cityDistanceWasteApprox = Math.max(0, 3 * (teamScores.cityCount - 1)) - Math.max(0, 6 * (teamScores.cityCount - 2));
    var cityOffset = currentCycleStats.approximate_fog_city_army - cityDistanceWasteApprox;
    var teamTotalFogEmergenceEstAvailableTrue = currentCycleStats.approximate_fog_army_available_total_true + cityOffset;
    var teamTotalFogEmergenceEstAvailable = currentCycleStats.approximate_fog_army_available_total + cityOffset;

    var visibleArmyLarge = 0;
    for (var li = 0; li < teamScores.livingPlayers.length; li++) {
      var pIdx = teamScores.livingPlayers[li];
      var teamPlayer = this.map.players[pIdx];
      var tileCutoff = this.assumed_player_average_tile_values[pIdx] * 1.5 + 1.0;
      for (var ti = 0; ti < teamPlayer.tiles.length; ti++) {
        var t = teamPlayer.tiles[ti];
        if (!t.visible) continue;
        if (t.army <= tileCutoff) continue;
        if (t.isCity) continue;
        if (t === tile) {
          visibleArmyLarge += Math.max(1, tile.army - emergence) - 1;
          continue;
        }

        // 原版这里写的是 tile.army（不是 t.army）。口径如此，照抄。
        visibleArmyLarge += tile.army - 1;
      }
    }

    var possibleArmyTrue = teamTotalFogEmergenceEstAvailableTrue + visibleArmyLarge;
    var possibleArmy = teamTotalFogEmergenceEstAvailable + visibleArmyLarge;

    var efficiencyRatio = 1.0;
    if (possibleArmy > 0) efficiencyRatio = (emergence + visibleArmyLarge) / possibleArmy;
    var efficiencyRatioTrue = 1.0;
    if (possibleArmyTrue > 0) efficiencyRatioTrue = (emergence + visibleArmyLarge) / possibleArmyTrue;

    if (this.view_info) {
      this.view_info.add_info_line(
        'team' + teamScores.teamId + ' emg ' + emergence + ' from ' + String(tile) + ': ' + visibleArmyLarge +
          ' visArmy, effRat ' + efficiencyRatio.toFixed(3) + ' (' + efficiencyRatioTrue.toFixed(3) + '), possibleArmy ' +
          possibleArmy + ' (true ' + possibleArmyTrue + ')'
      );
    }
    if (!tile.delta.gainedSight && tile.delta.oldOwner !== tile.delta.newOwner) {
      this.set_player_known_move_type(tile.delta.newOwner, PlayerMoveCategory.VisibleCapture);
    }

    var gen = this.map.players[this.map.player_index].general;
    if (efficiencyRatio > 0.7) {
      this.set_player_attack_timing(
        player,
        this.map.turn,
        this.map.distance_mapper.get_distance_between(gen, tile),
        efficiencyRatio,
        efficiencyRatioTrue
      );
    }

    // .90 看起来太高了，原版试出来 0.87
    var thresh = (teamTotalFogEmergenceEstAvailable - 1) * 0.87;
    var fullFogReset = false;
    if (emergence > thresh && (!tile.delta.gainedSight || emergence > 4)) {
      if (emergence > teamTotalFogEmergenceEstAvailable) {
        var msg =
          'UNDEREST OppTrack BY ' + (emergence - teamTotalFogEmergenceEstAvailable) + '! E+: fullFogReset - emergence ' +
          emergence + ' > thresh ' + thresh.toFixed(1) + ' (based on teamTotalFogEmergenceEst ' + teamTotalFogEmergenceEstAvailable + ')';
        if (this.view_info) this.view_info.add_info_line(msg);
      }
      fullFogReset = true;
      if (
        emergence >= teamTotalFogEmergenceEstAvailable + cityDistanceWasteApprox - 4 &&
        !(tile.delta.gainedSight && tile.army < emergence)
      ) {
        var maxDist = Math.max(1, teamTotalFogEmergenceEstAvailable + cityDistanceWasteApprox - emergence + 2) * 2;
        if (this.view_info) {
          this.view_info.add_info_line(
            'BC emgnce ' + emergence + ' VS teamTotalFogEmergenceEst ' + teamTotalFogEmergenceEstAvailable + '+cityWaste' +
              cityDistanceWasteApprox + ', CONF WITHIN ' + maxDist + ' general limit to ' + String(tile)
          );
        }
        this.send_general_distance_notification(maxDist, tile, teamScores.cityCount === 1);
      }
    }

    currentCycleStats.approximate_fog_army_available_total -= emergence;
    currentCycleStats.approximate_fog_army_available_total_true -= emergence;

    while (currentCycleStats.approximate_fog_army_available_total < 0 && currentCycleStats.approximate_fog_city_army > 1) {
      var halfCity = Math.floor(currentCycleStats.approximate_fog_city_army / 2);
      currentCycleStats.approximate_fog_army_available_total += halfCity;
      currentCycleStats.approximate_fog_army_available_total_true += halfCity;
      currentCycleStats.approximate_fog_city_army -= halfCity;
    }

    if (fullFogReset) {
      if (
        currentCycleStats.approximate_fog_army_available_total + currentCycleStats.approximate_fog_city_army - 6 * teamScores.cityCount >
        teamTotalFogEmergenceEstAvailable * 0.1
      ) {
        currentCycleStats.approximate_fog_army_available_total = 0;
        currentCycleStats.approximate_fog_city_army = 3 * teamScores.cityCount + Math.max(0, 10 * teamScores.cityCount - 2);
      }
    }

    if (currentCycleStats.approximate_fog_army_available_total < 0) currentCycleStats.approximate_fog_army_available_total = 0;
    if (currentCycleStats.approximate_fog_army_available_total_true < 0) currentCycleStats.approximate_fog_army_available_total_true = 0;
    if (currentCycleStats.approximate_fog_city_army < 0) currentCycleStats.approximate_fog_city_army = teamScores.cityCount;
  };

  OT._estimate_neutral_city_capture_gather_turns = function (stats) {
    if (stats.moves_spent_gathering_neutral_city_capture > 0) return stats.moves_spent_gathering_neutral_city_capture;

    if (stats.neutral_city_army_spent <= 0 || stats.approximate_army_gathered_this_cycle <= 0) return 0;

    var turnsSpentGathering = stats.moves_spent_gathering_fog_tiles + stats.moves_spent_gathering_visible_tiles;
    if (turnsSpentGathering <= 0) return 0;

    var estimatedTurns = Math.floor(
      (stats.neutral_city_army_spent * turnsSpentGathering + stats.approximate_army_gathered_this_cycle - 1) /
        stats.approximate_army_gathered_this_cycle
    );
    return Math.min(turnsSpentGathering, estimatedTurns);
  };

  OT.check_gather_move_differential = function (player, otherPlayer) {
    var playerStats = this.get_current_cycle_stats_by_player(player);
    var otherPlayerStats = this.get_current_cycle_stats_by_player(otherPlayer);
    if (playerStats === null || playerStats === undefined) return 0;
    if (otherPlayerStats === null || otherPlayerStats === undefined) return 0;

    var playerTurnsSpentGathering =
      playerStats.moves_spent_gathering_fog_tiles +
      playerStats.moves_spent_gathering_visible_tiles -
      this._estimate_neutral_city_capture_gather_turns(playerStats);
    var otherPlayerTurnsSpentGathering =
      otherPlayerStats.moves_spent_gathering_fog_tiles +
      otherPlayerStats.moves_spent_gathering_visible_tiles -
      this._estimate_neutral_city_capture_gather_turns(otherPlayerStats);

    return playerTurnsSpentGathering - otherPlayerTurnsSpentGathering;
  };

  /* --------------------------- 派生读数（策略直接读） --------------------------- */

  OT.get_approximate_greedy_turns_available = function (againstPlayer, ourArmyNonIncrement, opponentArmyOffset) {
    if (opponentArmyOffset === undefined) opponentArmyOffset = 0;
    var stats = this.get_current_cycle_stats_by_player(againstPlayer);
    var ourScores = this.get_current_team_scores_by_player(this.map.player_index);

    var ourCities = ourScores.cityCount;

    if (stats === null || stats === undefined) return 20;

    // 这里不能调 get_approximate_fog_army_risk：我们要逐回合推进去找那条交叉线
    var armyRisk = stats.approximate_fog_army_available_total + opponentArmyOffset;

    var inTurns = this.map.remainingCycleTurns;
    var cityLimitByNow = this.estimate_fog_city_usage_count_by_cycle_behavior(againstPlayer, 0);
    var cityLimitByEnd = this.estimate_fog_city_usage_count_by_cycle_behavior(againstPlayer, inTurns);

    var cityTotalArmyStart = this.get_next_fog_city_amounts(againstPlayer, cityLimitByNow);
    var cityTotalArmyEnd = this.get_next_fog_city_amounts(againstPlayer, cityLimitByEnd);

    var perMissingCityArmyDiff = 0;
    if (cityLimitByEnd !== cityLimitByNow) {
      perMissingCityArmyDiff = (cityTotalArmyEnd - cityTotalArmyStart) / (cityLimitByEnd - cityLimitByNow);
    }

    armyRisk += cityTotalArmyStart;

    var gatherOffset = 0;

    var turn = this.map.turn;
    var remainingCycleTime = this.map.remainingCycleTurns;
    var enScores = this.get_current_team_scores_by_player(againstPlayer);
    var queueLists = [];
    for (var qi = 0; qi < stats.players.length; qi++) {
      queueLists.push(this._gather_queues_new_by_player[stats.players[qi]].as_tile_list());
    }

    var i = 0;
    var addlCityTurn = this.map.turn % this.approximate_per_city_gather_distance;
    var enCurrentCitiesUsed = cityLimitByNow;
    while (turn < this.map.turn + 100) {
      if ((turn & 1) === 0) {
        armyRisk += enCurrentCitiesUsed;
        ourArmyNonIncrement += ourCities;
      }

      if (addlCityTurn >= this.approximate_per_city_gather_distance) {
        addlCityTurn -= this.approximate_per_city_gather_distance;
        if (enCurrentCitiesUsed < cityLimitByEnd) {
          enCurrentCitiesUsed += 1;
          armyRisk += perMissingCityArmyDiff;
        }
      }

      if (remainingCycleTime === 0) {
        gatherOffset += 1;
        remainingCycleTime = 50;
      }

      for (var qj = 0; qj < queueLists.length; qj++) {
        var q = queueLists[qj];
        if (i < q.length) {
          armyRisk += q[i] - 1 + gatherOffset;
        } else {
          armyRisk += gatherOffset;
        }
      }

      if (armyRisk > ourArmyNonIncrement) break;

      i += 1;
      turn += 1;
      addlCityTurn += 1;
    }

    var ourStats = this.get_current_cycle_stats_by_player(this.map.player_index);
    if (ourStats !== null && ourStats !== undefined) {
      var turnsWeSpentCappingCities = this._estimate_neutral_city_capture_gather_turns(ourStats);
      if (turnsWeSpentCappingCities !== 0) i -= turnsWeSpentCappingCities;
    }
    if (i < 0) i = 0;

    void enScores;
    return i;
  };

  OT.get_approximate_fog_army_risk = function (player, cityLimit, inTurns) {
    if (cityLimit === undefined) cityLimit = null;
    if (inTurns === undefined) inTurns = 0;
    var stats = this.get_current_cycle_stats_by_player(player);
    if (stats === null || stats === undefined) return 0;

    var armyRisk = stats.approximate_fog_army_available_total;
    var startingArmyRisk = armyRisk;
    var requestedCityLimit = cityLimit;
    if (cityLimit === null || cityLimit === undefined) {
      // 我们假设每 6 回合采集换 1 座城
      cityLimit = this.estimate_fog_city_usage_count_by_cycle_behavior(player, inTurns);
    } else {
      cityLimit = Math.min(cityLimit, stats.fog_city_count);
    }

    var cityTotal = this.get_fog_city_risk_in_turns_by_cycle_behavior(player, inTurns, cityLimit);

    armyRisk += cityTotal;

    var gatherOffset = 0;
    var cityIncomeTotal = 0;
    var gatherQueueTotal = 0;

    var pTileQueueLists = [];
    for (var qi = 0; qi < stats.players.length; qi++) {
      pTileQueueLists.push(this.get_player_gather_queue(stats.players[qi]).as_tile_list(false));
    }

    if (inTurns > 0) {
      var remainingCycleTime = this.map.remainingCycleTurns;
      var enScores = this.get_current_team_scores_by_player(player);
      for (var i = 0; i < inTurns; i++) {
        if ((i + remainingCycleTime) & 1) {
          // 奇数回合不加城收入
        } else {
          var cityIncome = Math.min(cityLimit, enScores.cityCount);
          cityIncomeTotal += cityIncome;
          armyRisk += cityIncome;
        }

        if (i > remainingCycleTime) {
          // 原版注释：这两个看起来都不对，别再动它们
          gatherOffset += 1;
          remainingCycleTime += 50;
        }

        for (var ti = 0; ti < pTileQueueLists.length; ti++) {
          var tList = pTileQueueLists[ti];
          if (i < tList.length) {
            var gatherQueueValue = tList[i] - 1 + gatherOffset;
            gatherQueueTotal += gatherQueueValue;
            armyRisk += gatherQueueValue;
          }
        }
      }
    }

    void startingArmyRisk;
    void requestedCityLimit;
    return armyRisk;
  };

  OT.get_next_fog_city_amounts = function (player, cityLimit) {
    var cycleStats = this.get_current_cycle_stats_by_player(player);
    if (cycleStats === null || cycleStats === undefined) throw new Error('Player ' + player + ' has no cycle stats available');

    var totalAmt = cycleStats.approximate_fog_city_army;

    var cityCount = cycleStats.fog_city_count;
    if (cityCount === 0) return 0;
    if (cityCount <= cityLimit) {
      // 每座城约 6 步采集，每 2 步留 1 兵，所以 cityLimit * 3 兵要留在身后
      var cityDistanceLeftBehindArmy = Math.trunc((fast_sum(cityCount) * this.approximate_per_city_gather_distance) / 2);
      return Math.max(0, totalAmt - cityDistanceLeftBehindArmy);
    }

    var amtPerCity = Math.floor(totalAmt / cityCount);
    var leftBehind = Math.trunc((fast_sum(cityLimit) * this.approximate_per_city_gather_distance) / 2);

    return amtPerCity * cityLimit - leftBehind;
  };

  OT.get_predicted_attack_turn_by_dist_to_fog = function (forPlayer, distToEnemyFog) {
    void forPlayer;
    return this.map.remainingCycleTurns - distToEnemyFog - 5;
  };

  OT.even_or_up_on_cities = function (againstPlayer) {
    if (againstPlayer === undefined) againstPlayer = -2;
    return this.up_on_cities(againstPlayer, 0);
  };

  OT.up_on_cities = function (againstPlayer, byNumber) {
    if (againstPlayer === undefined) againstPlayer = -2;
    if (byNumber === undefined) byNumber = 1;
    if (againstPlayer === -2) againstPlayer = this.targetPlayer;
    if (againstPlayer === -1) return true;

    var ourStats = this.map.get_team_stats(this.map.player_index);
    var enStats = this.map.get_team_stats(againstPlayer);

    return ourStats.cityCount - byNumber >= enStats.cityCount;
  };

  OT.winning_on_economy = function (byRatio, cityValue, againstPlayer, offset) {
    if (byRatio === undefined) byRatio = 1.0;
    if (cityValue === undefined) cityValue = 30;
    if (againstPlayer === undefined) againstPlayer = -2;
    if (offset === undefined) offset = 0;
    if (againstPlayer === -2) againstPlayer = this.targetPlayer;
    if (againstPlayer === -1) return true;

    var ourStats = this.map.get_team_stats(this.map.player_index);
    var enStats = this.map.get_team_stats(againstPlayer);

    var playerEconValue = ourStats.tileCount - ourStats.deserts + ourStats.cityCount * cityValue + offset;
    var oppEconValue = (enStats.tileCount - enStats.deserts + enStats.cityCount * cityValue) * byRatio;
    return playerEconValue >= oppEconValue;
  };

  OT.get_current_econ_ratio = function (cityValue, againstPlayer, offset) {
    if (cityValue === undefined) cityValue = 25;
    if (againstPlayer === undefined) againstPlayer = -2;
    if (offset === undefined) offset = 0;
    if (againstPlayer === -2) againstPlayer = this.targetPlayer;
    // 原版 bug：对面是 -1（没有对手）时直接返回 True 而不是比例
    if (againstPlayer === -1) return true;

    var ourStats = this.map.get_team_stats(this.map.player_index);
    var enStats = this.map.get_team_stats(againstPlayer);

    var playerEconValue = ourStats.tileCount + ourStats.cityCount * cityValue + offset;
    var oppEconValue = enStats.tileCount + enStats.cityCount * cityValue;

    return playerEconValue / oppEconValue;
  };

  OT.winning_on_tiles = function (byRatio, againstPlayer, offset) {
    if (byRatio === undefined) byRatio = 1.0;
    if (againstPlayer === undefined) againstPlayer = -2;
    if (offset === undefined) offset = 0;
    return this.winning_on_economy(byRatio, 0, againstPlayer, offset);
  };

  OT.get_tile_differential = function (againstPlayer) {
    if (againstPlayer === undefined) againstPlayer = -2;
    if (againstPlayer === -2) againstPlayer = this.targetPlayer;
    // 原版 bug：return True
    if (againstPlayer === -1) return true;

    var ourStats = this.map.get_team_stats(this.map.player_index);
    var enStats = this.map.get_team_stats(againstPlayer);

    return ourStats.tileCount - enStats.tileCount;
  };

  OT.winning_on_army = function (byRatio, useFullArmy, againstPlayer, offset) {
    if (byRatio === undefined) byRatio = 1.0;
    if (useFullArmy === undefined) useFullArmy = false;
    if (againstPlayer === undefined) againstPlayer = -2;
    if (offset === undefined) offset = 0;
    if (againstPlayer === -2) againstPlayer = this.targetPlayer;
    if (againstPlayer === -1) return true;

    var ourStats = this.map.get_team_stats(this.map.player_index);
    var enStats = this.map.get_team_stats(againstPlayer);

    var targetArmy = enStats.standingArmy;
    var playerArmy = ourStats.standingArmy;

    if (useFullArmy) {
      targetArmy = enStats.score;
      playerArmy = ourStats.score;
    }

    return playerArmy + offset >= targetArmy * byRatio;
  };

  OT.get_team_annihilated_fog = function (team) {
    if (team === -1) return 0;
    return this.get_team_annihilated_fog_by_player(this._players_lookup_by_team[team][0]);
  };

  OT.get_team_annihilated_fog_by_player = function (player) {
    if (player === -1) return 0;

    var currentTeamStats = this.get_current_team_scores_by_player(player);
    var playerObj = this.map.players[player];

    return this._get_team_annihilated_fog_internal(currentTeamStats, playerObj);
  };

  OT._get_team_annihilated_fog_internal = function (currentTeamStats, playerObj) {
    var teamAnnihilatedFog = 0 - currentTeamStats.fightingDiff;
    if (isPlayerOnTeamWith(this.map, this.map.player_index, playerObj.fighting_with_player)) {
      // 那说明我们吃掉了他们的东西
      var ourStats = this.map.players[playerObj.fighting_with_player];
      var ourFightingDiff = ourStats.actualScoreDelta - ourStats.expectedScoreDelta;
      teamAnnihilatedFog += ourFightingDiff;
    }

    return teamAnnihilatedFog;
  };

  OT.did_player_already_attack_this_round = function (player) {
    if (player === null || player === undefined || player < 0 || player >= this.map.team_ids_by_player_index.length) return false;

    var team = this.map.team_ids_by_player_index[player];
    if (team === null || team === undefined || team < 0 || team >= this.current_team_cycle_stats.length) return false;

    var stats = this.current_team_cycle_stats[team];
    if (stats === null || stats === undefined) return false;

    var gathered = stats.approximate_army_gathered_this_cycle;
    gathered -= stats.army_annihilated_visible + stats.army_annihilated_fog;

    if (stats.approximate_fog_army_available_total + Math.floor(stats.approximate_fog_city_army / 2) <= gathered) return true;
    return false;
  };

  OT._validate_army_totals = function (curTurnScores, currentCycleStats) {
    var team = currentCycleStats.team;
    var sumArmy = 0;

    for (var pi = 0; pi < currentCycleStats.players.length; pi++) {
      var playerIdx = currentCycleStats.players[pi];
      var playerSumArmy = 0;
      var tiles = this.map.players[playerIdx].tiles;
      for (var ti = 0; ti < tiles.length; ti++) {
        if (tiles[ti].visible) playerSumArmy += tiles[ti].army;
      }

      playerSumArmy += this.get_player_gather_queue(playerIdx).total_sum;
      sumArmy += playerSumArmy;
    }

    var sumWithFog = sumArmy + currentCycleStats.approximate_fog_city_army + currentCycleStats.approximate_fog_army_available_total;

    var guard = 0;
    while (sumWithFog < curTurnScores.score && guard < 100000) {
      guard += 1;
      var badDiff = curTurnScores.score - sumWithFog;
      if (currentCycleStats.approximate_fog_army_available_total < 0) {
        sumWithFog -= currentCycleStats.approximate_fog_army_available_total;
        currentCycleStats.approximate_fog_army_available_total = 0;
      } else if (currentCycleStats.approximate_fog_city_army < curTurnScores.cityCount) {
        sumWithFog -= currentCycleStats.approximate_fog_city_army;
        sumWithFog += curTurnScores.cityCount;
        currentCycleStats.approximate_fog_city_army = curTurnScores.cityCount;
      } else {
        currentCycleStats.approximate_fog_army_available_total += badDiff;
        sumWithFog += badDiff;
      }
    }

    guard = 0;
    while (sumWithFog > curTurnScores.score && guard < 100000) {
      guard += 1;
      var overDiff = sumWithFog - curTurnScores.score;
      if (currentCycleStats.approximate_fog_city_army < curTurnScores.cityCount) {
        sumWithFog -= currentCycleStats.approximate_fog_city_army;
        sumWithFog -= curTurnScores.cityCount;
        currentCycleStats.approximate_fog_city_army = curTurnScores.cityCount;
      } else {
        currentCycleStats.approximate_fog_army_available_total -= overDiff;
        sumWithFog -= overDiff;
      }
    }
  };

  OT.send_general_distance_notification = function (maxDist, tile, generalConfidence) {
    for (var i = 0; i < this.outbound_emergence_notifications.length; i++) {
      this.outbound_emergence_notifications[i](maxDist, tile, generalConfidence);
    }
  };

  OT.get_team_unknown_city_count_by_player = function (player) {
    var team = this.get_current_team_scores_by_player(player);
    var unkCount = team.cityCount;
    for (var li = 0; li < team.livingPlayers.length; li++) {
      var pIdx = team.livingPlayers[li];
      var p = this.map.players[pIdx];
      // 将军不算城
      unkCount -= 1;
      for (var ci = 0; ci < p.cities.length; ci++) {
        var city = p.cities[ci];
        if (city.discovered && !city.isTempFogPrediction) unkCount -= 1;
      }
    }

    return unkCount;
  };

  OT.set_player_attack_timing = function (player, turn, distance, efficiencyRatio, efficiencyRatioTrue) {
    var cycleIndex = this.get_cycle_index(turn - 1);
    if (player === -1) return;

    var cycleTurn = turn % 50;
    var team = this.map.players[player].team;

    var teamHistory = this.team_attack_cycle_timings[team];
    if (cycleIndex >= teamHistory.length) {
      throw new Error(
        'p' + player + ' tm' + team + ' cycleIndex ' + cycleIndex + ' (turn ' + turn + ') was oob teamHistory len' +
          teamHistory.length + ' (last ' + teamHistory[teamHistory.length - 1].serialize() + ')'
      );
    }

    var thisCycleTiming = teamHistory[cycleIndex];
    var turnWithDist = cycleTurn + distance;

    if (thisCycleTiming.actual_attack_cycle_turn < turnWithDist && efficiencyRatio >= thisCycleTiming.actual_efficiency) {
      thisCycleTiming.actual_efficiency = efficiencyRatio;
      thisCycleTiming.actual_true_efficiency = efficiencyRatioTrue;
      thisCycleTiming.actual_attack_cycle_turn = turnWithDist;
    }
  };

  OT.set_player_known_move_type = function (player, moveCategory) {
    this.last_player_move_type[player] = moveCategory;
  };

  OT.consume_fog_army_no_move = function (playerIndex, annihilatedArmy, allowConsumeGatherTile, currentCycleStats) {
    if (allowConsumeGatherTile === undefined) allowConsumeGatherTile = false;
    if (currentCycleStats === undefined) currentCycleStats = null;
    if (currentCycleStats === null || currentCycleStats === undefined) {
      currentCycleStats = this.get_current_cycle_stats_by_player(playerIndex);
    }

    if (!allowConsumeGatherTile || annihilatedArmy >= this._gather_queues_new_by_player[playerIndex].cur_max_tile_size) {
      currentCycleStats.approximate_fog_army_available_total -= annihilatedArmy;
      currentCycleStats.approximate_fog_army_available_total_true -= annihilatedArmy;
      currentCycleStats.approximate_army_gathered_this_cycle -= annihilatedArmy;
    } else {
      var removed = this._remove_queued_gather_closest_to_amount(playerIndex, annihilatedArmy + 1, true);
      if (removed === -1) removed = 0;
      currentCycleStats.approximate_fog_army_available_total -= annihilatedArmy - removed;
      currentCycleStats.approximate_fog_army_available_total_true -= annihilatedArmy - removed;
      currentCycleStats.approximate_army_gathered_this_cycle -= annihilatedArmy - removed;
    }
  };

  OT.get_immediate_fog_risk = function (player, our_city_spanning_tree_tile_count) {
    var stats = this.get_current_cycle_stats_by_player(player);
    if (stats === null || stats === undefined) return [0, 0, 0, 0];

    var enScores = this.get_current_team_scores_by_player(player);
    if (enScores === null || enScores === undefined) return [0, 0, 0, 0];

    var fog_army_component = stats.approximate_fog_army_available_total;
    var city_component = stats.approximate_fog_city_army;

    // 原版这里算了 cityLimit 又算了一遍 nextFogCityAmounts 但没用返回值。副作用一样，照抄。
    var cityLimit = this.estimate_fog_city_usage_count_by_cycle_behavior(player);
    this.get_next_fog_city_amounts(player, cityLimit);
    var expected_city_spanning_offset = Math.trunc((enScores.cityCount / 4) * our_city_spanning_tree_tile_count);

    var total_fog_risk = fog_army_component + city_component - expected_city_spanning_offset;

    return [total_fog_risk, fog_army_component, city_component, expected_city_spanning_offset];
  };

  OT.estimate_fog_city_usage_count_by_cycle_behavior = function (player, inTurns) {
    if (inTurns === undefined) inTurns = 0;
    var stats = this.get_current_cycle_stats_by_player(player);
    var cityPotentialCount = pyRound(
      Math.max(stats.moves_spent_gathering_fog_tiles, stats.moves_spent_gathering_fog_tiles + inTurns) /
        this.approximate_per_city_gather_distance
    );
    return Math.max(0, Math.min(stats.fog_city_count, cityPotentialCount));
  };

  OT.get_fog_city_risk_in_turns_by_cycle_behavior = function (player, inTurns, cityLimit) {
    if (inTurns === undefined) inTurns = 0;
    if (cityLimit === undefined) cityLimit = -1;
    if (cityLimit === -1) cityLimit = this.estimate_fog_city_usage_count_by_cycle_behavior(player, inTurns);

    return this.get_next_fog_city_amounts(player, cityLimit);
  };

  OT.estimate_city_contest_econ_value = function (asPlayer, enPlayer, armyReachingContestableCity) {
    void asPlayer;
    var enemyTeamCityCount = this.get_current_team_scores_by_player(enPlayer).cityCount;
    // 他们要被扣两座城（我们争的那座在涨，他们那座不涨）
    var cityContestedIncrementPenalty = 2;
    var cityContestBonus = armyReachingContestableCity / Math.max(0.1, enemyTeamCityCount - cityContestedIncrementPenalty);

    return cityContestBonus;
  };

  /* ------------------------------ 存档 / 读档 ------------------------------ */

  OT.dump_to_string_data = function () {
    var data = [];

    for (var ti = 0; ti < this._team_indexes.length; ti++) {
      var team = this._team_indexes[ti];
      var stats = this.current_team_cycle_stats[team];
      if (stats === null || stats === undefined) continue;
      data.push('ot_' + team + '_stats_moves_spent_capturing_fog_tiles=' + stats.moves_spent_capturing_fog_tiles);
      data.push('ot_' + team + '_stats_moves_spent_capturing_visible_tiles=' + stats.moves_spent_capturing_visible_tiles);
      data.push('ot_' + team + '_stats_moves_spent_gathering_fog_tiles=' + stats.moves_spent_gathering_fog_tiles);
      data.push('ot_' + team + '_stats_moves_spent_gathering_visible_tiles=' + stats.moves_spent_gathering_visible_tiles);
      data.push('ot_' + team + '_stats_moves_spent_gathering_neutral_city_capture=' + stats.moves_spent_gathering_neutral_city_capture);
      data.push('ot_' + team + '_stats_neutral_city_army_spent=' + stats.neutral_city_army_spent);
      data.push('ot_' + team + '_stats_approximate_army_gathered_this_cycle=' + stats.approximate_army_gathered_this_cycle);
      data.push('ot_' + team + '_stats_army_annihilated_visible=' + stats.army_annihilated_visible);
      data.push('ot_' + team + '_stats_army_annihilated_fog=' + stats.army_annihilated_fog);
      data.push('ot_' + team + '_stats_army_annihilated_total=' + stats.army_annihilated_total);
      data.push('ot_' + team + '_stats_approximate_fog_army_available_total=' + stats.approximate_fog_army_available_total);
      data.push('ot_' + team + '_stats_approximate_fog_army_available_total_true=' + stats.approximate_fog_army_available_total_true);
      data.push(
        'ot_' + team + '_stats_number_assumed_two_expansions_that_may_be_fog_distance=' +
          stats.number_assumed_two_expansions_that_may_be_fog_distance
      );
      data.push('ot_' + team + '_stats_approximate_fog_city_army=' + stats.approximate_fog_city_army);
    }

    var tileCountsByPlayer = this.get_all_player_fog_tile_count_dict();
    var playerKeys = Object.keys(tileCountsByPlayer).map(Number);
    playerKeys.sort(function (a, b) {
      return a - b;
    });
    for (var pk = 0; pk < playerKeys.length; pk++) {
      var player = playerKeys[pk];
      if (player === this.map.player_index || this.map.teammates.has(player)) continue;
      var tileCounts = tileCountsByPlayer[player];
      var sizes = Object.keys(tileCounts).map(Number);
      sizes.sort(function (a, b) {
        return b - a;
      });
      var parts = [];
      for (var si = 0; si < sizes.length; si++) parts.push(tileCounts[sizes[si]] + 'x' + sizes[si]);
      data.push('ot_' + playerChar(player) + '_tcs=' + parts.join('|'));
    }

    for (var pi = 0; pi < this.map.players.length; pi++) {
      var p = this.map.players[pi];
      if (p.index === this.map.player_index || this.map.teammates.has(p.index)) continue;

      var currentEmergence = this.current_largest_unresolved_emergence_by_player[p.index];
      if (currentEmergence !== null && currentEmergence !== undefined) {
        data.push('ot_' + playerChar(p.index) + '_current_largest_unresolved_emergence=' + currentEmergence.serialize());
      }

      var history = this.largest_unresolved_emergence_history_by_player[p.index];
      var turns = Object.keys(history).map(Number);
      turns.sort(function (a, b) {
        return b - a;
      });
      var historicalEmergences = [];
      for (var hi = 0; hi < Math.min(turns.length, UNRESOLVED_EMERGENCE_HISTORY_ROUNDS_TO_SERIALIZE); hi++) {
        var turn = turns[hi];
        historicalEmergences.push(turn + ':' + history[turn].serialize());
      }
      if (historicalEmergences.length > 0) {
        data.push('ot_' + playerChar(p.index) + '_largest_unresolved_emergence_history=' + historicalEmergences.join('|'));
      }
    }

    for (var ci = 0; ci < 3; ci++) {
      var cycleTurn = this.get_last_cycle_end_turn(ci);
      for (var ti2 = 0; ti2 < this._team_indexes.length; ti2++) {
        var team2 = this._team_indexes[ti2];
        var score = this.team_score_data_history[team2][cycleTurn];
        if (score !== undefined && score !== null) {
          data.push('ot_' + team2 + '_c_' + cycleTurn + '_tileCount=' + score.tileCount);
          data.push('ot_' + team2 + '_c_' + cycleTurn + '_score=' + score.score);
          data.push('ot_' + team2 + '_c_' + cycleTurn + '_standingArmy=' + score.standingArmy);
          data.push('ot_' + team2 + '_c_' + cycleTurn + '_cityCount=' + score.cityCount);
          data.push('ot_' + team2 + '_c_' + cycleTurn + '_fightingDiff=' + score.fightingDiff);
          data.push('ot_' + team2 + '_c_' + cycleTurn + '_unexplainedTileDelta=' + score.unexplainedTileDelta);
        }

        var cycleStats = this.team_cycle_stats_history[team2][cycleTurn];
        if (cycleStats !== undefined && cycleStats !== null) {
          var pfx = 'ot_' + team2 + '_c_' + cycleTurn + '_stats_';
          data.push(pfx + 'moves_spent_capturing_fog_tiles=' + cycleStats.moves_spent_capturing_fog_tiles);
          data.push(pfx + 'moves_spent_capturing_visible_tiles=' + cycleStats.moves_spent_capturing_visible_tiles);
          data.push(pfx + 'moves_spent_gathering_fog_tiles=' + cycleStats.moves_spent_gathering_fog_tiles);
          data.push(pfx + 'moves_spent_gathering_visible_tiles=' + cycleStats.moves_spent_gathering_visible_tiles);
          data.push(pfx + 'moves_spent_gathering_neutral_city_capture=' + cycleStats.moves_spent_gathering_neutral_city_capture);
          data.push(pfx + 'neutral_city_army_spent=' + cycleStats.neutral_city_army_spent);
          data.push(pfx + 'approximate_army_gathered_this_cycle=' + cycleStats.approximate_army_gathered_this_cycle);
          data.push(pfx + 'army_annihilated_visible=' + cycleStats.army_annihilated_visible);
          data.push(pfx + 'army_annihilated_fog=' + cycleStats.army_annihilated_fog);
          data.push(pfx + 'army_annihilated_total=' + cycleStats.army_annihilated_total);
          data.push(pfx + 'approximate_fog_army_available_total=' + cycleStats.approximate_fog_army_available_total);
          data.push(pfx + 'approximate_fog_army_available_total_true=' + cycleStats.approximate_fog_army_available_total_true);
          data.push(
            pfx + 'number_assumed_two_expansions_that_may_be_fog_distance=' + cycleStats.number_assumed_two_expansions_that_may_be_fog_distance
          );
          data.push(pfx + 'approximate_fog_city_army=' + cycleStats.approximate_fog_city_army);
        }
      }
    }

    var curCycle = this.get_cycle_index();
    for (var at = 0; at < this.team_attack_cycle_timings.length; at++) {
      var hist = this.team_attack_cycle_timings[at];
      for (var i = 0; i < 6; i++) {
        var cycle = curCycle - i;
        if (cycle < 0) break;
        if (cycle >= hist.length) continue;

        var ahCycleTurn = this.get_last_cycle_end_turn(i);
        data.push('ot_' + at + '_ah_' + pyStr(ahCycleTurn) + '=' + hist[cycle].serialize());
      }
    }

    return data.join('\n');
  };

  // f-string 里 None 排版成 "None"，JS 的 null 排成 "null"。存档键必须逐字一致。
  function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    return String(v);
  }

  function dv(data, key) {
    if (data === null || data === undefined) return undefined;
    if (typeof data.get === 'function' && typeof data.has === 'function') return data.get(key);
    var v = data[key];
    return v;
  }

  function hasKey(data, key) {
    if (data === null || data === undefined) return false;
    if (typeof data.has === 'function') return data.has(key);
    return Object.prototype.hasOwnProperty.call(data, key);
  }

  OT.load_from_map_data = function (data) {
    for (var c = 0; c < this.get_cycle_index(); c++) {
      for (var ai = 0; ai < this.team_attack_cycle_timings.length; ai++) {
        this.team_attack_cycle_timings[ai].push(new TeamAttackData(ai, 0, 0.0, 0.0));
      }
    }

    for (var i = 0; i < 6; i++) {
      var cycleTurn = this.get_last_cycle_end_turn_raw(i);
      if (cycleTurn === null) break;
      for (var ti = 0; ti < this._team_indexes.length; ti++) {
        var team = this._team_indexes[ti];
        var teamPlayers = this.get_team_players(team);
        var teamScore = new EK.TeamStats(0, 0, 0, 0, 0, 0, team, teamPlayers, teamPlayers, 0, 0);
        this.team_score_data_history[team][cycleTurn] = teamScore;
        if (hasKey(data, 'ot_' + team + '_c_' + cycleTurn + '_tileCount')) {
          teamScore.tileCount = parseInt(dv(data, 'ot_' + team + '_c_' + cycleTurn + '_tileCount'), 10);
          teamScore.score = parseInt(dv(data, 'ot_' + team + '_c_' + cycleTurn + '_score'), 10);
          teamScore.standingArmy = parseInt(dv(data, 'ot_' + team + '_c_' + cycleTurn + '_standingArmy'), 10);
          teamScore.cityCount = parseInt(dv(data, 'ot_' + team + '_c_' + cycleTurn + '_cityCount'), 10);
          teamScore.fightingDiff = parseInt(dv(data, 'ot_' + team + '_c_' + cycleTurn + '_fightingDiff'), 10);
          teamScore.unexplainedTileDelta = parseInt(dv(data, 'ot_' + team + '_c_' + cycleTurn + '_unexplainedTileDelta'), 10);
        }

        var statsPrefix = 'ot_' + team + '_c_' + cycleTurn + '_stats_';
        if (hasKey(data, statsPrefix + 'moves_spent_capturing_fog_tiles')) {
          var cs = new CycleStatsData(team, teamPlayers);
          cs.moves_spent_capturing_fog_tiles = parseInt(dv(data, statsPrefix + 'moves_spent_capturing_fog_tiles'), 10);
          cs.moves_spent_capturing_visible_tiles = parseInt(dv(data, statsPrefix + 'moves_spent_capturing_visible_tiles'), 10);
          cs.moves_spent_gathering_fog_tiles = parseInt(dv(data, statsPrefix + 'moves_spent_gathering_fog_tiles'), 10);
          cs.moves_spent_gathering_visible_tiles = parseInt(dv(data, statsPrefix + 'moves_spent_gathering_visible_tiles'), 10);
          if (hasKey(data, statsPrefix + 'moves_spent_gathering_neutral_city_capture')) {
            cs.moves_spent_gathering_neutral_city_capture = parseInt(dv(data, statsPrefix + 'moves_spent_gathering_neutral_city_capture'), 10);
          } else if (hasKey(data, 'ot_' + team + '_c_' + cycleTurn + '_stats_neutral_city_capture_gather_time')) {
            cs.moves_spent_gathering_neutral_city_capture = Math.ceil(
              parseFloat(dv(data, 'ot_' + team + '_c_' + cycleTurn + '_stats_neutral_city_capture_gather_time'))
            );
          }
          if (hasKey(data, statsPrefix + 'neutral_city_army_spent')) {
            cs.neutral_city_army_spent = parseInt(dv(data, statsPrefix + 'neutral_city_army_spent'), 10);
          }
          cs.approximate_army_gathered_this_cycle = parseInt(dv(data, statsPrefix + 'approximate_army_gathered_this_cycle'), 10);
          cs.army_annihilated_visible = parseInt(dv(data, statsPrefix + 'army_annihilated_visible'), 10);
          cs.army_annihilated_fog = parseInt(dv(data, statsPrefix + 'army_annihilated_fog'), 10);
          cs.army_annihilated_total = parseInt(dv(data, statsPrefix + 'army_annihilated_total'), 10);
          cs.approximate_fog_army_available_total = parseInt(dv(data, statsPrefix + 'approximate_fog_army_available_total'), 10);
          if (hasKey(data, statsPrefix + 'approximate_fog_army_available_total_true')) {
            cs.approximate_fog_army_available_total_true = parseInt(dv(data, statsPrefix + 'approximate_fog_army_available_total_true'), 10);
          } else {
            cs.approximate_fog_army_available_total_true = parseInt(dv(data, statsPrefix + 'approximate_fog_army_available_total'), 10);
          }
          if (hasKey(data, statsPrefix + 'number_assumed_two_expansions_that_may_be_fog_distance')) {
            cs.number_assumed_two_expansions_that_may_be_fog_distance = parseInt(
              dv(data, statsPrefix + 'number_assumed_two_expansions_that_may_be_fog_distance'),
              10
            );
          } else {
            cs.number_assumed_two_expansions_that_may_be_fog_distance = cs.moves_spent_capturing_fog_tiles;
          }
          cs.approximate_fog_city_army = parseInt(dv(data, statsPrefix + 'approximate_fog_city_army'), 10);
          this.team_cycle_stats_history[team][cycleTurn] = cs;
        }

        if (hasKey(data, 'ot_' + team + '_ah_' + pyStr(cycleTurn))) {
          // python 的 hist[idx] 在 idx == -1 时是「最后一个元素」，JS 的 [-1] 只是挂属性
          var ahIdx = this.get_cycle_index(cycleTurn - 1);
          var ahHist = this.team_attack_cycle_timings[team];
          if (ahIdx < 0) ahIdx = ahHist.length + ahIdx;
          ahHist[ahIdx] = TeamAttackData.parse(dv(data, 'ot_' + team + '_ah_' + pyStr(cycleTurn)));
        }
      }
    }

    for (var ti2 = 0; ti2 < this._team_indexes.length; ti2++) {
      var team2 = this._team_indexes[ti2];
      var cur = this.current_team_cycle_stats[team2];
      if (cur === null || cur === undefined) {
        cur = new CycleStatsData(team2, this.get_team_players(team2));
        this.current_team_cycle_stats[team2] = cur;
      }

      var pfx = 'ot_' + team2 + '_stats_';
      if (hasKey(data, pfx + 'moves_spent_capturing_fog_tiles')) {
        cur.moves_spent_capturing_fog_tiles = parseInt(dv(data, pfx + 'moves_spent_capturing_fog_tiles'), 10);
        cur.moves_spent_capturing_visible_tiles = parseInt(dv(data, pfx + 'moves_spent_capturing_visible_tiles'), 10);
        cur.moves_spent_gathering_fog_tiles = parseInt(dv(data, pfx + 'moves_spent_gathering_fog_tiles'), 10);
        cur.moves_spent_gathering_visible_tiles = parseInt(dv(data, pfx + 'moves_spent_gathering_visible_tiles'), 10);
        if (hasKey(data, pfx + 'moves_spent_gathering_neutral_city_capture')) {
          cur.moves_spent_gathering_neutral_city_capture = parseInt(dv(data, pfx + 'moves_spent_gathering_neutral_city_capture'), 10);
        } else if (hasKey(data, 'ot_' + team2 + '_stats_neutral_city_capture_gather_time')) {
          cur.moves_spent_gathering_neutral_city_capture = Math.ceil(
            parseFloat(dv(data, 'ot_' + team2 + '_stats_neutral_city_capture_gather_time'))
          );
        }
        if (hasKey(data, pfx + 'neutral_city_army_spent')) {
          cur.neutral_city_army_spent = parseInt(dv(data, pfx + 'neutral_city_army_spent'), 10);
        }
        cur.approximate_army_gathered_this_cycle = parseInt(dv(data, pfx + 'approximate_army_gathered_this_cycle'), 10);
        cur.army_annihilated_visible = parseInt(dv(data, pfx + 'army_annihilated_visible'), 10);
        cur.army_annihilated_fog = parseInt(dv(data, pfx + 'army_annihilated_fog'), 10);
        cur.army_annihilated_total = parseInt(dv(data, pfx + 'army_annihilated_total'), 10);
        cur.approximate_fog_army_available_total = parseInt(dv(data, pfx + 'approximate_fog_army_available_total'), 10);
        if (hasKey(data, pfx + 'approximate_fog_army_available_total_true')) {
          cur.approximate_fog_army_available_total_true = parseInt(dv(data, pfx + 'approximate_fog_army_available_total_true'), 10);
        } else {
          cur.approximate_fog_army_available_total_true = parseInt(dv(data, pfx + 'approximate_fog_army_available_total'), 10);
        }
        if (hasKey(data, pfx + 'number_assumed_two_expansions_that_may_be_fog_distance')) {
          cur.number_assumed_two_expansions_that_may_be_fog_distance = parseInt(
            dv(data, pfx + 'number_assumed_two_expansions_that_may_be_fog_distance'),
            10
          );
        } else {
          cur.number_assumed_two_expansions_that_may_be_fog_distance = cur.moves_spent_capturing_fog_tiles;
        }
        cur.approximate_fog_city_army = parseInt(dv(data, pfx + 'approximate_fog_city_army'), 10);
      }
    }

    for (var pi = 0; pi < this.map.players.length; pi++) {
      var player = this.map.players[pi];
      if (player.index === this.map.player_index || this.map.teammates.has(player.index)) continue;

      var pch = playerChar(player.index);
      var currentEmergenceKey = 'ot_' + pch + '_current_largest_unresolved_emergence';
      if (hasKey(data, currentEmergenceKey)) {
        this.current_largest_unresolved_emergence_by_player[player.index] = UnresolvedEmergenceData.parse(this.map, dv(data, currentEmergenceKey));
      }

      var emergenceHistoryKey = 'ot_' + pch + '_largest_unresolved_emergence_history';
      if (hasKey(data, emergenceHistoryKey)) {
        this.largest_unresolved_emergence_history_by_player[player.index] = {};
        var chunks = String(dv(data, emergenceHistoryKey)).split('|');
        for (var hi = 0; hi < chunks.length; hi++) {
          if (chunks[hi] === '') continue;
          // split(':', 1) 的行为：只切第一个冒号
          var idx = chunks[hi].indexOf(':');
          var turnRaw = chunks[hi].substring(0, idx);
          var emergenceRaw = chunks[hi].substring(idx + 1);
          this.largest_unresolved_emergence_history_by_player[player.index][parseInt(turnRaw, 10)] =
            UnresolvedEmergenceData.parse(this.map, emergenceRaw);
        }
      }

      var tcsKey = 'ot_' + pch + '_tcs';
      if (hasKey(data, tcsKey)) {
        var fq = new FogGatherQueue(player.index);
        this._gather_queues_new_by_player[player.index] = fq;
        var countsSplit = String(dv(data, tcsKey)).split('|');
        for (var ci = 0; ci < countsSplit.length; ci++) {
          var sizeCountStr = countsSplit[ci];
          if (sizeCountStr.indexOf('x') < 0) continue;
          var pieces = sizeCountStr.trim().replace(/^s+/, '').split('x');
          if (pieces.length < 2) continue;
          var num = parseInt(pieces[0], 10);
          var size = parseInt(pieces[1], 10);
          fq.set_amount_for_size(size, num);
        }
      }
    }

    for (var ti3 = 0; ti3 < this._team_indexes.length; ti3++) {
      var team3 = this._team_indexes[ti3];
      this._update_cycle_stats_and_moves_no_checks(
        team3,
        this.map.get_team_stats_by_team_id(team3),
        this.get_last_cycle_end_turn(),
        true
      );
    }

    if (this.map.is_army_bonus_turn) {
      for (var ti4 = 0; ti4 < this._team_indexes.length; ti4++) {
        var team4 = this._team_indexes[ti4];
        this.team_score_data_history[team4][this.map.turn] = this.map.get_team_stats_by_team_id(team4);
      }
    }

    this.skip_this_turn = true;
  };

  /* -------------------------------- 导出 -------------------------------- */

  EK.FogGatherQueue = FogGatherQueue;
  EK.TeamAttackData = TeamAttackData;
  EK.CycleStatsData = CycleStatsData;
  EK.PlayerMoveCategory = PlayerMoveCategory;
  EK.UnresolvedEmergenceData = UnresolvedEmergenceData;
  EK.OpponentTracker = OpponentTracker;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : globalThis);
