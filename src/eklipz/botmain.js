/* Bot.js —— 逐行移植 EklipZgit/generals-bot 的 bot_ek0x45.py（2172 行，类 EklipZBot）
 *
 * 挂载：EK.Bot  （别名 EK.EklipZBot）
 *
 * 用法（对应 gb_bridge.py 的 start / on_turn）：
 *   var bot = new EK.Bot(startData);
 *   map.apply_server_update(data);      // 每回合先更新地图
 *   var move = bot.find_move();         // 原版在这里包 try/except 吞异常
 *
 * 未移植依赖的处理（任务要求：按原版调用点留接口，调不到时明确兜底）：
 *   BotExpansionOps / BotCombatOps / BotCityOps / BotTargeting / BotExplorationOps /
 *   BotKillTiming / BotCentralDefense / BotEventHandlers / BotComms / BotRendering /
 *   BotSerialization / BotTimings 这些模块 JS 侧还不存在，统一走 _call()：
 *     存在 → 直接调；
 *     不存在 → 记入 missingCounts（Bot.missingReport() 可查），返回该调用点的保守默认值。
 *   EK.Bot.strict = true 时改为抛出明确错误，便于模块齐了之后抓漏。
 *
 * 本地内建（原版来自别的文件、这里为了能独立跑而内建，字段/语义照抄）：
 *   Timings(Directives.py)、History(History.py)、ExpansionPotential(StrategyModels.py)、
 *   ViewInfo 空实现、TargetStyle / PathColorer 常量、WinConditionAnalyzer 状态壳、
 *   CaptureLineTracker 状态壳、GatherAnalyzer 空壳、TeammateCommunicator/TileCompressor 空壳。
 *
 * 没搬的东西：所有 render / print / logbook / viewInfo 可视化细节（只保留会写状态的那几行），
 * BotSerialization 的存档逻辑，Engine(MCTS) 分支。
 */

(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // Map._apply_server_patch / mapmove 用的 modifier 下标（照 base/client/map.py 的顺序）
  var MODIFIER_CITY_STATE = 8;

  // ---- 缺失依赖记录 -------------------------------------------------------

  var missingCounts = {};

  function noteMissing(name) {
    missingCounts[name] = (missingCounts[name] || 0) + 1;
  }

  // ---- 本地支撑类 ---------------------------------------------------------

  // 原版 PerformanceTimer 会记时间戳、写文件。这里只保留调用点需要的空实现。
  function NullPerfTimer() {
    this.updates = {};
    this.moveEvents = [];
  }
  NullPerfTimer.prototype.record_update = function (turn, timeStamp) {
    this.updates[turn] = timeStamp;
  };
  NullPerfTimer.prototype.begin_move = function (turn) {
    return { turn: turn };
  };
  NullPerfTimer.prototype.end_move = function () { };
  NullPerfTimer.prototype.get_elapsed_since_update = function (turn) { return 0; };
  NullPerfTimer.prototype.begin_move_event = function (name) {
    return { name: name, end: function () { } };
  };
  NullPerfTimer.prototype.get_elapsed_move = function () { return 0; };

  // Directives.py:47 class Timings
  function Timings(cycleTurns, quickExpandSplitTurns, splitTurns, launchTiming, offsetTurns, recalcTurn, disallowEnemyGather) {
    this.cycleTurns = cycleTurns;
    this.quickExpandTurns = quickExpandSplitTurns;
    this.splitTurns = splitTurns;
    this.offsetTurns = offsetTurns;
    this.launchTiming = launchTiming;
    this.nextRecalcTurn = recalcTurn;
    this.disallowEnemyGather = disallowEnemyGather;
    this.is_early_flank_launch = false;
  }
  Timings.prototype.should_recalculate = function (turn) { return turn === this.nextRecalcTurn; };
  Timings.prototype.in_quick_expand_split = function (turn) {
    var adjTurn = this.get_turn_in_cycle(turn);
    return adjTurn <= this.quickExpandTurns;
  };
  Timings.prototype.in_gather_split = function (turn) {
    var adjTurn = this.get_turn_in_cycle(turn);
    return adjTurn > this.quickExpandTurns && adjTurn < this.splitTurns;
  };
  Timings.prototype.in_expand_split = function (turn) {
    return this.get_turn_in_cycle(turn) >= this.splitTurns;
  };
  Timings.prototype.in_launch_split = function (turn) {
    return this.get_turn_in_cycle(turn) >= this.launchTiming;
  };
  Timings.prototype.in_launch_timing = function (turn) {
    var adjTurn = this.get_turn_in_cycle(turn);
    var turnInLaunchTiming = adjTurn - this.launchTiming;
    return adjTurn >= this.launchTiming && turnInLaunchTiming < 5;
  };
  Timings.prototype.get_turn_in_cycle = function (turn) {
    return (turn + this.offsetTurns) % this.cycleTurns;
  };
  Timings.prototype.get_turns_left_in_cycle = function (turn) {
    return this.cycleTurns - (turn + this.offsetTurns) % this.cycleTurns;
  };

  // History.py
  function History() {
    this.move_history = {};
    // History.py:26 —— dropped_move 会把「上一回合的招被服务器吞了」记在这里，
    // 重复出招检测靠它区分「玩家长按同一个方向」和「我们以为出了招」
    this.droppedHistory = {};
    // History.py:23 —— BotEventHandlers.handle_player_captures 会往里追加
    this.player_captures = [];
  }
  History.prototype.get_move = function (turn) {
    var l = this.move_history[turn];
    return l && l.length > 0 ? l[0] : null;
  };
  // History.py:35
  History.prototype.captured_player = function (turn, capturedPlayer, capturingPlayer) {
    this.player_captures.push(new PlayerCapture(turn, capturedPlayer, capturingPlayer));
  };

  // History.py:57 PlayerCapture
  function PlayerCapture(turn, capturedPlayer, capturingPlayer) {
    this.turn = turn;
    this.capturedPlayer = capturedPlayer;
    this.capturingPlayer = capturingPlayer;
  }

  // StrategyModels.py ExpansionPotential：只有字段，逻辑在 BotExpansionOps 里
  function ExpansionPotential(econValue, turnsUsed, armyRemaining, selectedOption, allPaths, valuePerTurn, turnCreated, includesIntercept) {
    this.econValue = econValue;
    this.turnsUsed = turnsUsed;
    this.armyRemaining = armyRemaining;
    this.selected_option = selectedOption;
    this.all_paths = allPaths || [];
    this.valuePerTurn = valuePerTurn;
    this.turn_created = turnCreated;
    this.includes_intercept = !!includesIntercept;
    this.blocking_tiles = new Set();
    this.preferred_tiles = new Set();
  }
  ExpansionPotential.prototype.get_first_move = function () {
    return this.selected_option ? this.selected_option.get_first_move() : null;
  };

  // ViewInfo.py：原版负责渲染。这里只记录，保证调用点不炸。
  function ViewInfo(renderStep, map) {
    this.renderStep = renderStep;
    this.map = map;
    this.infoText = '';
    this.lines = [];
    this.infoLines = [];
  }
  ViewInfo.prototype.clear_for_next_turn = function () {
    this.infoText = '';
    this.lines.length = 0;
    this.infoLines.length = 0;
  };
  ViewInfo.prototype.add_info_line = function (line) {
    this.infoText = line;
    this.infoLines.push(line);
  };
  ViewInfo.prototype.add_stats_line = function (line) { this.infoLines.push(line); };
  ViewInfo.prototype.color_path = function (c) { };
  ViewInfo.prototype.color_tile = function (t) { };
  ViewInfo.prototype.mark_tile = function (t) { };
  ViewInfo.prototype.add_targeted_tile = function (t) { };
  ViewInfo.prototype.add_targeted_tiles = function (t) { };
  ViewInfo.prototype.add_targeted_tiles_with_legend = function (t) { };
  ViewInfo.prototype.add_map_zone = function (m) { };

  var TargetStyle = {
    BLUE: 1, GREEN: 2, RED: 3, WHITE: 4, TEAL: 5, PURPLE: 6, ORANGE: 7, YELLOW: 8, BLACK: 9
  };

  function PathColorer(path) {
    this.path = path;
  }

  // GatherAnalyzer.py 在 JS 侧没有对应文件（原版也很薄）。留字段壳。
  function GatherAnalyzer(map) {
    this.map = map;
    this.relevant_tiles_by_turn = {};
  }
  GatherAnalyzer.prototype.re_scan = function () { };

  // WinConditionAnalyzer：真正的分析逻辑（analyze / calculate_basic_defense_*）没搬，
  // 因为它依赖 BotExpansionOps / EnemyExpansionPlan 一整套。字段壳保证 pick_move 里的读取不炸。
  function WinConditionAnalyzer(map, opponentTracker, cityAnalyzer, territories, boardAnalysis) {
    this.map = map;
    this.opponent_tracker = opponentTracker;
    this.city_analyzer = cityAnalyzer;
    this.territories = territories;
    this.board_analysis = boardAnalysis;
    this.info = null;
    this.viable_win_conditions = new Set();
    this.defend_cities = new Set();
    this.contestable_cities = new Set();
    this.basic_defense_general_army = 0;
    this.basic_defense_general_tiles = new Set();
    this.most_forward_defense_city = null;
    this.best_target_player_attack_target = null;
    this.projected_loss_all_in_active = false;
    this.projected_loss_all_in_target = null;
    this.all_in_plan = null;
    this.last_analyze_turn = -1;
  }
  WinConditionAnalyzer.prototype.analyze = function (targetPlayer, expectedGeneral, perfTimer) {
    this.last_analyze_turn = this.map.turn;
  };
  WinConditionAnalyzer.prototype.calculate_basic_defense_against_general = function (tree, general, flankPath) { };
  WinConditionAnalyzer.prototype.calculate_basic_defense_against_forward_spanning_tree = function (tree, forwardPoint) { };
  WinConditionAnalyzer.prototype.force_kill_all_in_if_projected_round_loss = function (bot, plan, enemyPlan) { };
  WinConditionAnalyzer.prototype.was_city_recently_contested = function (city, capture_cutoff_ago_turns) { return false; };

  // CaptureLineTracker：process_plan 只维护内部状态，没搬。
  function CaptureLineTracker(map) {
    this.map = map;
    this.line_assignments = [];
  }
  CaptureLineTracker.prototype.process_plan = function (targetPlayer, expansionPlan) { };

  // BotComms.py 的 TileCompressor / TeammateCommunicator：原版负责压缩地图并和队友交换信息。
  function TileCompressor(map) { this.map = map; }
  TileCompressor.prototype.compress = function () { return null; };

  function TeammateCommunicator(map, tileCompressor, boardAnalysis) {
    this.map = map;
    this.tile_compressor = tileCompressor;
    this.board_analysis = boardAnalysis;
  }
  TeammateCommunicator.prototype.begin_next_turn = function () { };
  TeammateCommunicator.prototype.determine_leads = function () { };
  TeammateCommunicator.prototype.produce_teammate_communications = function () { return []; };

  // ---- 派发器 -------------------------------------------------------------

  function _resolve(moduleName) {
    var mod = EK[moduleName];
    return mod || null;
  }

  function _call(bot, moduleName, fnName, args, dflt) {
    var mod = _resolve(moduleName);
    if (mod && typeof mod[fnName] === 'function') {
      return mod[fnName].apply(mod, args);
    }
    noteMissing(moduleName + '.' + fnName);
    if (bot && bot.constructor && bot.constructor.strict) {
      throw new Error('EK.Bot.strict: 依赖模块缺失 ' + moduleName + '.' + fnName);
    }
    return dflt;
  }

  // ---- Bot ---------------------------------------------------------------

  function Bot(startData) {
    var self = this;

    this.startData = startData || null;

    // perf_timer：原版 PerformanceTimer()，JS 侧空实现
    this.perf_timer = new NullPerfTimer();

    // ---- bot_ek0x45.py:86 __init__ 的字段，逐个照抄默认值 ----
    this.blocking_tile_info = {};
    this.behavior_end_of_turn_scrim_army_count = 5;
    this.teams = [];
    this.contest_data = {};
    this.army_out_of_play = false;
    this._lastTargetPlayerCityCount = 0;
    this.armies_moved_this_turn = [];
    this.logDirectory = null;
    this.player = EK.Player ? new EK.Player(-1) : { index: -1, dead: false, tiles: new Set(), cities: [], standingArmy: 0, tileCount: 0, team: -1, aggression_factor: 1 };

    this.cities_gathered_this_cycle = new Set();
    this.tiles_gathered_to_this_cycle = new Set();
    this.tiles_captured_this_cycle = new Set();
    this.tiles_evacuated_this_cycle = new Set();

    this.targetPlayerObj = null;
    this.city_expand_plan = null;
    this.force_city_take = false;
    this._gen_distances = null;
    this._ally_distances = null;
    this.defend_economy = false;
    this.was_defending_economy = false;
    this._spawn_cramped = false;
    this.general_safe_func_set = {};
    this.clear_moves_func = null;
    this.surrender_func = null;
    this._map = null;
    this.curPath = null;
    this.last_move = null;
    this.curPathPrio = -1;
    this.gathers = 0;
    this.attacks = 0;
    this.leafMoves = [];
    this.captureLeafMoves = [];
    this.targetPlayerLeafMoves = [];
    this.attackFailedTurn = 0;
    this.countFailedQuickAttacks = 0;
    this.countFailedHighDepthAttacks = 0;
    this.largeTilesNearEnemyKings = new Map();
    this.no_file_logging = false;
    this.enemyCities = [];
    this.enemy_city_approxed_attacks = {};
    this.dangerAnalyzer = null;
    this.cityAnalyzer = null;
    this.gatherAnalyzer = null;
    this.lastTimingFactor = -1;
    this.lastTimingTurn = 0;
    this._evaluatedUndiscoveredCache = [];
    this.lastTurnStartTime = 0;
    this.currently_forcing_out_of_play_gathers = false;
    this.force_far_gathers = false;
    this.force_far_gathers_turns = 0;
    this.force_far_gathers_sleep_turns = 50;
    this.out_of_play_tiles = new Set();
    this.is_rapid_capturing_neut_cities = false;
    this.is_winning_gather_cyclic = false;
    this.is_all_in_losing = false;
    this.all_in_army_advantage_counter = 0;
    this.all_in_army_advantage_cycle = 35;
    this.is_all_in_army_advantage = false;
    this.all_in_city_behind = false;
    this.trigger_player_capture_re_eval = false;
    this.giving_up_counter = 0;
    this.all_in_losing_counter = 0;
    this.approximate_greedy_turns_avail = 0;
    this.lastTargetAttackTurn = 0;
    this.gather_kill_priorities = new Set();
    this.threat_kill_path = null;
    this.expansion_plan = null;
    this.enemy_expansion_plan = null;
    this._flow_expander = null;
    // 原版是 dict[Tile, int]；用它的地方调 .get(tile)，所以得是 Map（键是 Tile 对象）
    this.enemy_expansion_plan_tile_path_cap_values = new Map();
    this.intercept_plans = {};
    this.generalApproximations = [];
    this.opponent_tracker = null;
    this.lastGeneralGatherTurn = -2;
    this.is_blocking_neutral_city_captures = false;
    this.was_allowing_neutral_cities_last_turn = true;
    this.city_capture_plan_tiles = new Set();
    this.city_capture_plan_last_updated = 0;
    this.city_capture_plan_option = null;
    this.contest_city_plan_option = null;
    this.quick_kill_city_plan_option = null;
    this._expansion_value_matrix = null;
    this.targetPlayer = -1;
    this.failedUndiscoveredSearches = 0;
    this.largePlayerTiles = [];
    this.largeNegativeNeutralTiles = [];
    this.playerTargetScores = new Array(16).fill(0);
    this.general = null;
    this.gatherNodes = null;
    this.redGatherTreeNodes = null;
    this.isInitialized = false;
    this.last_init_turn = 0;
    this.is_pre_resume_init_turn = false;
    this.teammate = null;
    this.teammate_path = null;
    this.teammate_general = null;

    this._outbound_team_chat = [];
    this._outbound_all_chat = [];
    this._tile_ping_queue = [];
    this._chat_messages_received = [];
    this._tiles_pinged_by_teammate = [];
    this._communications_sent_cooldown_cache = {};
    this.tiles_pinged_by_teammate_this_turn = new Set();
    this._tiles_pinged_by_teammate_first_25 = new Set();
    this.teamed_with_bot = false;
    this.teammate_communicator = null;
    this.tile_compressor = null;
    this.oldAllyThreat = null;
    this.oldThreat = null;
    this.makingUpTileDeficit = false;
    this.territories = null;
    this.target_player_gather_targets = new Set();
    this.target_player_gather_path = null;
    this.shortest_path_to_target_player = null;
    this.defensive_spanning_tree = new Set();
    this.last_central_defense_signature = null;
    this.friendly_city_spanning_tree = new Set();
    this.enemy_attack_path = null;
    this.likely_kill_push = false;
    this.viewInfo = null;
    this._minAllowableArmy = -1;
    this.threat = null;
    this.threats_we_care_about_by_tile = null;
    this.best_defense_leaves = [];
    this.has_defenseless_modifier = false;
    this.has_watchtower_modifier = false;
    this.has_misty_veil_modifier = false;
    this.is_weird_custom = false;
    this.history = new History();
    this.timings = null;
    this.tileIslandBuilder = null;
    this._should_recalc_tile_islands = false;
    this.last_flow_expander = null;
    this.last_flow_opt_collection = null;
    this.armyTracker = null;
    this.army_interceptor = null;
    this.win_condition_analyzer = null;
    this.capture_line_tracker = null;
    this.finishing_exploration = true;
    this.targetPlayerExpectedGeneralLocation = null;
    this.alt_en_gen_positions = [];
    this._alt_en_gen_position_distances = [];
    this.lastPlayerKilled = null;
    this.launchPoints = [];
    this.locked_launch_point = null;
    this.high_fog_risk = false;
    this.fog_risk_amount = 0;
    this.flanking = false;
    this.sketchiest_potential_inbound_flank_path = null;
    this.completed_first_100 = false;
    this.is_lag_massive_map = false;
    this.undiscovered_priorities = null;
    this._undisc_prio_turn = -1;
    this._afk_players = null;
    this._is_ffa_situation = null;
    this.explored_this_turn = false;
    this.board_analysis = null;
    this.targetingArmy = null;
    this.cached_scrims = {};
    this.next_scrimming_army_tile = null;

    // ---- 配置（只列会影响决策的；渲染开关全按原版默认，逻辑里不读） ----
    this.disable_engine = true;
    this.gather_use_pcst = false;
    this.gather_use_max_set = true;
    this.gather_include_shortest_pathway_as_negatives = false;
    this.gather_include_distance_from_enemy_TERRITORY_as_negatives = 2;
    this.gather_include_distance_from_enemy_TILES_as_negatives = 2;
    this.gather_include_distance_from_enemy_general_as_negatives = 0.0;
    this.gather_include_distance_from_enemy_general_large_map_as_negatives = 0.0;
    this.expansion_force_no_global_visited = false;
    this.expansion_force_global_visited_stage_1 = true;
    this.expansion_use_iterative_negative_tiles = true;
    this.expansion_allow_leaf_moves = true;
    this.expansion_use_leaf_moves_first = false;
    this.expansion_enemy_expansion_plan_inbound_penalty = 0.55;
    this.expansion_single_iteration_time_cap = 0.03;
    this.expansion_length_weight_offset = 0.5;
    this.expansion_allow_gather_plan_extension = true;
    this.expansion_always_include_non_terminating_leafmoves_in_iteration = true;
    this.expansion_use_iterative_flow = true;
    this.expansion_use_legacy = false;
    // FlowExpansion（ArmyFlowExpanderV2）是原版 turn>=50 的默认扩张路径，我们还没移植完。
    // 调试/过渡期用 GB_EK_LEGACY=1 切回已移植的 ExpandUtils 老路径，先让引擎能长地。
    if (typeof process !== 'undefined' && process.env && process.env.GB_EK_LEGACY === '1') {
      this.expansion_use_iterative_flow = false;
      this.expansion_use_legacy = true;
    }
    this.expansion_use_tile_islands = false;
    this.expansion_full_time_limit = 0.1;
    this.expansion_use_cutoff = true;
    this.expansion_small_tile_time_ratio = 1.0;
    this.behavior_out_of_play_defense_threshold = 0.40;
    this.behavior_losing_on_economy_skip_defense_threshold = 0.0;
    this.behavior_early_retake_bonus_gather_turns = 0;
    this.behavior_max_allowed_quick_expand = 0;
    this.behavior_out_of_play_distance_over_shortest_ratio = 0.45;
    this.behavior_launch_timing_offset = 3;
    this.behavior_flank_launch_timing_offset = -4;
    this.behavior_allow_defense_army_scrim = false;
    this.behavior_allow_pre_gather_greedy_leaves = true;
    this.behavior_pre_gather_greedy_leaves_army_ratio_cutoff = 0.97;
    this.behavior_pre_gather_greedy_leaves_offset = 0;

    // 原版会在构造后由 bridge 调 initialize_from_map_for_first_time(map)，
    // 但 startData 有时候就是完整的 start 包，这里给个便利路径。
    if (startData && startData.turn !== undefined && startData.map_diff) {
      // 交给调用方按 gb_bridge 的顺序处理（先 new Map 再 initialize），避免这里猜包格式
    }
  }

  Bot.strict = false;
  Bot.missingReport = function () {
    var out = {};
    for (var k in missingCounts) {
      if (Object.prototype.hasOwnProperty.call(missingCounts, k)) out[k] = missingCounts[k];
    }
    return out;
  };
  Bot.resetMissingReport = function () {
    missingCounts = {};
  };

  var P = Bot.prototype;

  P.__toString = function () { return '[eklipz_bot ' + this._map + ']'; };

  P.get_elapsed = function () {
    return Math.round(this.perf_timer.get_elapsed_since_update(this._map.turn) * 1000) / 1000;
  };

  function mapOf(bot) { return bot._map || bot.map; }

  // ---- bot_ek0x45.py:2019 initialize_from_map_for_first_time --------------
  P.initialize_from_map_for_first_time = function (map) {
    this._map = map;

    if (EK.ViewInfo) this.viewInfo = new EK.ViewInfo(2, map);
    else this.viewInfo = new ViewInfo(2, map);

    this.is_lag_massive_map = map.rows * map.cols > 1000;
    this.completed_first_100 = map.turn > 85;
    // BotLifecycle.initialize_logging：原版会建日志目录；这里只记录依赖缺失
    noteMissing('BotLifecycle.initialize_logging');

    this.general = map.generals[map.player_index];
    if (!this.general) {
      throw new Error('initialize_from_map_for_first_time: map.generals[player_index] 为空（turn=' + map.turn + '）');
    }
    this.player = map.players[this.general.player()];
    this.targetPlayerObj = map.players[this.targetPlayer];

    this.alt_en_gen_positions = [];
    this._alt_en_gen_position_distances = [];
    for (var pi = 0; pi < map.players.length; pi++) {
      this.alt_en_gen_positions.push([]);
      this._alt_en_position_distances_placeholder = null;
      this._alt_en_gen_position_distances.push(null);
    }

    // 原版是 MapBase.get_teams_array(map)（bot_ek0x45.py:2033），不是 map.teams —— map.js 没这个字段
    this.teams = EK.Map.get_teams_array(map);

    this.opponent_tracker = new EK.OpponentTracker(map, this.viewInfo);

    this.expansion_plan = new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);

    // teammate 分支（2v2 时才有）
    var teammates = map.teammates ? Array.from(map.teammates) : [];
    for (var ti = 0; ti < teammates.length; ti++) {
      var tmIdx = teammates[ti];
      var tmPlayer = map.players[tmIdx];
      if (!tmPlayer || tmPlayer.dead) continue;
      var tmGeneral = map.generals[tmIdx];
      if (!tmGeneral) continue;
      this.teammate = tmIdx;
      this.teammate_general = tmGeneral;
      this._ally_distances = map.distance_mapper.get_tile_dist_matrix(tmGeneral);
      var uname = (map.usernames && map.usernames[tmIdx]) || '';
      if (uname.indexOf('Teammate.exe') >= 0 || uname.indexOf('Human.exe') >= 0 || uname.indexOf('Exe.human') >= 0) {
        this.teamed_with_bot = true;
      }
      break;
    }

    this._gen_distances = map.distance_mapper.get_tile_dist_matrix(this.general);

    this.dangerAnalyzer = new EK.DangerAnalyzer(map);
    this.cityAnalyzer = new EK.CityAnalyzer(map, this.general);
    this.gatherAnalyzer = EK.GatherAnalyzer ? new EK.GatherAnalyzer(map) : new GatherAnalyzer(map);
    this.isInitialized = true;

    this.has_defenseless_modifier = !!map.modifiers_by_id[12];
    this.has_watchtower_modifier = !!map.modifiers_by_id[13];
    this.has_misty_veil_modifier = !!map.modifiers_by_id[9];

    // map 回调 —— 原版在 bot_ek0x45.py:2059-2069 注册，这里必须等
    // armyTracker / territories / board_analysis 都建好之后才能挂（见下方 BotEventHandlers.initialize_callbacks）
    if (map.notify_city_found === undefined) noteMissing('map.notify_city_found callback');
    if (map.notify_tile_captures === undefined) noteMissing('map.notify_tile_captures callback');
    if (map.notify_tile_discovered === undefined) noteMissing('map.notify_tile_discovered callback');
    if (map.notify_tile_vision_changed === undefined) noteMissing('map.notify_tile_vision_changed callback');
    if (map.notify_player_captures === undefined) noteMissing('map.notify_player_captures callback');

    if (!this.territories) this.territories = new EK.TerritoryClassifier(map);

    this.armyTracker = new EK.ArmyTracker(map, this.perf_timer, this.opponent_tracker);

    this.targetPlayerExpectedGeneralLocation = this.general.movable && this.general.movable.length > 0
      ? this.general.movable[0]
      : this.general;

    this.board_analysis = new EK.BoardAnalyzer(map, this.general, this.teammate_general);

    this.tileIslandBuilder = new EK.TileIslandBuilder(map, this.board_analysis.intergeneral_analysis);
    this.tileIslandBuilder.recalculate_tile_islands(this.targetPlayerExpectedGeneralLocation);

    this.launchPoints.push(this.general);

    this.army_interceptor = new EK.ArmyInterceptor(map, this.board_analysis, false, this.viewInfo);

    var WCA = EK.WinConditionAnalyzer;
    this.win_condition_analyzer = WCA
      ? new WCA(map, this.opponent_tracker, this.cityAnalyzer, this.territories, this.board_analysis)
      : new WinConditionAnalyzer(map, this.opponent_tracker, this.cityAnalyzer, this.territories, this.board_analysis);
    if (!(this.win_condition_analyzer instanceof WinConditionAnalyzer) && !EK.WinConditionAnalyzer) {
      noteMissing('WinConditionAnalyzer');
    }
    this.win_condition_analyzer.info = function (text) { };
    if (this.cityAnalyzer) this.cityAnalyzer.win_condition_analyzer = this.win_condition_analyzer;

    var CLT = EK.CaptureLineTracker;
    this.capture_line_tracker = CLT ? new CLT(map) : new CaptureLineTracker(map);

    // bot_ek0x45.py:2059-2069 —— 到这一步 armyTracker / territories / board_analysis /
    // win_condition_analyzer / cityAnalyzer 全部就位，回调里用到的东西都有了
    if (EK.BotEventHandlers && typeof EK.BotEventHandlers.initialize_callbacks === 'function') {
      EK.BotEventHandlers.initialize_callbacks(this);
    } else {
      noteMissing('BotEventHandlers.initialize_callbacks');
    }

    this._timing_cycle_ended();

    if (this.opponent_tracker.outbound_emergence_notifications) {
      this.opponent_tracker.outbound_emergence_notifications.push(
        this.armyTracker.notify_concrete_emergence.bind(this.armyTracker));
    }

    this.is_weird_custom = !!map.is_walled_city_game || !!map.is_low_cost_city_game
      || map.cols < 13 || map.rows < 13;

    return this;
  };

  // ---- BotTimings 派发（模块不在时用保守默认，保证 timings 非空） ----
  P._timing_cycle_ended = function () {
    if (EK.BotTimings && typeof EK.BotTimings.timing_cycle_ended === 'function') {
      return EK.BotTimings.timing_cycle_ended(this);
    }
    noteMissing('BotTimings.timing_cycle_ended');
    return this._default_timings();
  };

  P._default_timings = function () {
    var map = this._map;
    var turn = map ? map.turn : 0;
    // 原版 BotTimings.get_timings 会读玩家历史行为来推周期；这里给一个安全默认值：
    // 50 回合周期、前 10 回合快扩、30 回合后进入扩张、40 回合后进入 launch。
    this.timings = new Timings(
      50,
      10,
      30,
      40 + this.behavior_launch_timing_offset,
      0,
      turn + 50,
      false
    );
    return this.timings;
  };

  P._get_timings = function () {
    if (EK.BotTimings && typeof EK.BotTimings.get_timings === 'function') {
      return EK.BotTimings.get_timings(this);
    }
    noteMissing('BotTimings.get_timings');
    return this._default_timings();
  };

  P._get_remaining_move_time = function () {
    if (EK.BotTimings && typeof EK.BotTimings.get_remaining_move_time === 'function') {
      return EK.BotTimings.get_remaining_move_time(this);
    }
    noteMissing('BotTimings.get_remaining_move_time');
    return 1e6;
  };

  // ---- bot_ek0x45.py:1744 distance_from_general --------------------------
  P.distance_from_general = function (sourceTile) {
    if (sourceTile === this.general) return 0;
    if (!this._gen_distances) return 1000;
    var v = this._gen_distances.raw[sourceTile.tile_index];
    return v === undefined || v === null ? 1000 : v;
  };

  P.distance_from_teammate = function (sourceTile) {
    if (sourceTile === this.teammate_general) return 0;
    if (!this._ally_distances) return 1000;
    var v = this._ally_distances.raw[sourceTile.tile_index];
    return v === undefined || v === null ? 1000 : v;
  };

  P.getDistToEnemy = function (tile) {
    var dist = 1000;
    var map = this._map;
    for (var i = 0; i < map.generals.length; i++) {
      var gen = map.generals[i];
      if (gen) {
        dist = Math.min(dist, map.euclidDist(gen.x, gen.y, tile.x, tile.y));
      } else if (this.generalApproximations[i] && this.generalApproximations[i][2] > 0) {
        var approx = this.generalApproximations[i];
        var avgX = approx[0] / approx[2];
        var avgY = approx[1] / approx[2];
        dist = Math.min(dist, map.euclidDist(avgX, avgY, tile.x, tile.y));
      }
    }
    return dist;
  };

  P.info = function (text) {
    if (!this.viewInfo) return;
    this.viewInfo.infoText = text;
    this.viewInfo.add_info_line(text);
  };

  P.get_army_at = function (tile, no_expected_path) {
    return this.armyTracker.get_or_create_army_at(tile, !!no_expected_path);
  };

  P.get_army_at_x_y = function (x, y) {
    return this.get_army_at(this._map.GetTile(x, y));
  };

  P.get_army_at_x_y_or_none = function (x, y) {
    return this.armyTracker.armies.get(this._map.GetTile(x, y)) || null;
  };

  // ---- bot_ek0x45.py:473 find_move ---------------------------------------
  P.find_move = function (is_lag_move) {
    var map = this._map;
    var move;
    var turn = map.turn;
    try {
      move = this.select_move(is_lag_move);

      // 将军的招如果不安全（会自杀 / 送头），换成顺手能吃的格或安全的第一步
      if (move !== null && move !== undefined && move.source.isGeneral
        && !EK.BotPathingUtils.is_move_safe_valid(this, move, true)) {
        this.info('general move not safe, finding alternative');
        var dangerTiles = _call(this, 'BotDefense', 'get_danger_tiles', [this], []);
        var replaced = false;
        for (var i = 0; i < dangerTiles.length; i++) {
          var dangerTile = dangerTiles[i];
          if (dangerTile.movable && dangerTile.movable.indexOf(this.general) >= 0) {
            var altMove = new EK.Move(this.general, dangerTile);
            if (EK.BotPathingUtils.is_move_safe_valid(this, altMove, true)) {
              move = altMove;
              replaced = true;
              break;
            }
            altMove.move_half = true;
            if (EK.BotPathingUtils.is_move_safe_valid(this, altMove, true)) {
              move = altMove;
              replaced = true;
              break;
            }
          }
        }
        if (!replaced && this.expansion_plan) {
          var allPaths = this.expansion_plan.all_paths || [];
          for (var ap = 0; ap < allPaths.length; ap++) {
            var optMove = allPaths[ap].get_first_move();
            if (optMove && EK.BotPathingUtils.is_move_safe_valid(this, optMove, true)) {
              move = optMove;
              replaced = true;
              break;
            }
          }
        }
        if (!replaced) move = null;
      }
    } catch (err) {
      if (this.viewInfo) {
        this.viewInfo.add_info_line('BOT ERROR');
        var tb = (err && err.stack) ? err.stack : String(err);
        this.viewInfo.add_info_line(tb);
      }
      throw err; // 原版 rethrow=True，异常交给 bridge 吞
    } finally {
      EK.BotPathingUtils.check_cur_path(this);

      if (this.curPath && move && this.curPath.get_first_move()) {
        var pathFirst = this.curPath.get_first_move();
        if (move.source === pathFirst.source && move.dest !== pathFirst.dest) {
          this.curPath = null;
          this.curPathPrio = -1;
        }
      }

      if (!this.history.move_history[turn]) this.history.move_history[turn] = [];
      this.history.move_history[turn].push(move);

      _call(this, 'BotRendering', 'prep_view_info_for_render', [this, move], null);
    }

    if (this.teammate_communicator) {
      this.teammate_communicator.produce_teammate_communications();
    }
    _call(this, 'BotComms', 'send_teammate_communication', [this], null);

    // 下一回合 mapmove 要用它推断自己的移动
    map.last_player_index_submitted_move = null;
    if (move) {
      if (move.source.player() !== this.general.player()) {
        throw new Error('find_move: move.source.player() ' + move.source.player()
          + ' != general.player ' + this.general.player());
      }
      map.last_player_index_submitted_move = [move.source, move.dest, !!move.move_half];
    }

    return move;
  };

  // ---- bot_ek0x45.py:573 init_turn ---------------------------------------
  P.init_turn = function (secondAttempt) {
    var map = this._map;
    if (this.last_init_turn === map.turn) return;

    this.quick_kill_city_plan_option = null;
    this.contest_city_plan_option = null;

    this.was_defending_economy = this.defend_economy;
    this.defend_economy = false;

    this._alt_en_gen_position_distances = [];
    for (var p1 = 0; p1 < map.players.length; p1++) this._alt_en_gen_position_distances.push(null);

    this._afk_players = null;
    this._is_ffa_situation = null;
    this.gathers = null;
    this.gatherNodes = null;
    this.expansion_plan = new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);
    this._expansion_value_matrix = null;
    this.lastTurnStartTime = Date.now();

    if (!secondAttempt && this.viewInfo) this.viewInfo.clear_for_next_turn();

    this.was_allowing_neutral_cities_last_turn = !this.is_blocking_neutral_city_captures;
    this.is_blocking_neutral_city_captures = false;

    if (map.is_2v2 || map.get_teammates_no_self && map.get_teammates_no_self(map.player_index).length > 0) {
      if (this.teammate_general) {
        this.teammate = this.teammate_general.player;
        this.teammate_path = EK.BotPathingUtils.get_path_to_target(
          this, this.teammate_general, undefined, undefined, undefined, undefined, undefined, true, true);
      }
      // TeammateCommunicator / TileCompressor：原版用于和队友交换信息，JS 侧没搬
      if (!this.tile_compressor) {
        var TC = EK.TileCompressor;
        this.tile_compressor = TC ? new TC(map) : new TileCompressor(map);
        noteMissing('TileCompressor');
      }
      if (!this.teammate_communicator) {
        var TMC = EK.TeammateCommunicator;
        this.teammate_communicator = TMC
          ? new TMC(map, this.tile_compressor, this.board_analysis)
          : new TeammateCommunicator(map, this.tile_compressor, this.board_analysis);
        noteMissing('TeammateCommunicator');
      }
      this.teammate_communicator.begin_next_turn();
    }

    while (this._chat_messages_received.length > 0) {
      var msg = this._chat_messages_received.shift();
      _call(this, 'BotComms', 'handle_chat_message', [this, msg], null);
    }

    _call(this, 'BotTargeting', 'check_target_player_just_took_city', [this], null);

    this._spawn_cramped = null;

    this.last_init_turn = map.turn;

    if (map.is_army_bonus_turn) {
      for (var bp = 0; bp < map.players.length; bp++) {
        var bpObj = map.players[bp];
        if (bpObj && typeof bpObj.aggression_factor === 'number') {
          bpObj.aggression_factor = Math.floor(bpObj.aggression_factor / 2);
        }
      }
    }

    if (!secondAttempt) this.explored_this_turn = false;

    this.threat_kill_path = null;
    this.redGatherTreeNodes = null;

    if (this.general) {
      this._gen_distances = map.distance_mapper.get_tile_dist_matrix(this.general);
    }
    if (this.teammate_general) {
      this._ally_distances = map.distance_mapper.get_tile_dist_matrix(this.teammate_general);
    }

    if (!this.isInitialized && map) {
      this.initialize_from_map_for_first_time(map);
    }

    if (this.trigger_player_capture_re_eval) {
      _call(this, 'BotEventHandlers', 'reevaluate_after_player_capture', [this], null);
      this.trigger_player_capture_re_eval = false;
    }

    this._minAllowableArmy = -1;
    this.enemyCities = [];

    if (map.turn - 3 > this.lastTimingTurn) this.lastTimingFactor = -1;

    var lastMove = null;
    if (this.history.move_history[map.turn - 1]) {
      lastMove = this.history.move_history[map.turn - 1][0];
    }

    this.armies_moved_this_turn = [];
    this.perf_timer.begin_move_event('ArmyTracker Move/Emerge');
    this.armyTracker.scan_movement_and_emergences(lastMove, map.turn, this.board_analysis);
    this._analyze_army_emergences();

    if (this.board_analysis && this.board_analysis.central_defense_point
      && this.board_analysis.intergeneral_analysis
      && (this.locked_launch_point === null || this.locked_launch_point === this.general)) {
      var centralPoint = this.board_analysis.central_defense_point;
      var igd = this.board_analysis.inter_general_distance;
      if (this.board_analysis.intergeneral_analysis.bMap.raw[centralPoint.tile_index] < igd) {
        this.locked_launch_point = centralPoint;
        this.recalculate_player_paths(true);
      }
    }

    _call(this, 'BotCityOps', 'ensure_reachability_matrix_built', [this], null);

    if (this.board_analysis && this.board_analysis.intergeneral_analysis) {
      this.cityAnalyzer.re_scan(this.board_analysis);
    }

    this.opponent_tracker.analyze_turn(this.targetPlayer);

    for (var tIdx = 0; tIdx < this.teams.length; tIdx++) {
      var team = this.teams[tIdx];
      var annihilatedFog = this.opponent_tracker.get_team_annihilated_fog(team);
      if (annihilatedFog > 0) {
        for (var pl = 0; pl < map.players.length; pl++) {
          var plObj = map.players[pl];
          if (!plObj || plObj.team !== team) continue;
          var tookNeutCity = _call(this, 'BotCityOps', 'did_player_just_take_fog_city', [this, pl], false);
          if (this.armyTracker.try_find_army_sink(pl, annihilatedFog, tookNeutCity)) break;
        }
      }
    }

    if (!this.is_lag_massive_map || map.turn < 3 || (map.turn + 3) % 5 === 0) {
      _call(this, 'BotCentralDefense', 'rebuild_intergeneral_analysis_for_central_defense', [this], null);
    }

    if (!this.is_pre_resume_init_turn) {
      var fogTileCounts = this.opponent_tracker.get_all_player_fog_tile_count_dict();
      for (var fp = 0; fp < map.players.length; fp++) {
        var counts = fogTileCounts[fp] !== undefined ? fogTileCounts[fp] : 0;
        this.armyTracker.update_fog_prediction(fp, counts, this.targetPlayerExpectedGeneralLocation);
      }
    }

    this._evaluatedUndiscoveredCache = [];
    this._refresh_expected_general_location();
    this._refresh_alt_en_gen_positions();

    if (this.tileIslandBuilder) {
      this.tileIslandBuilder.intergeneral_analysis = this.board_analysis.intergeneral_analysis;
      if (map.is_army_bonus_turn || this._should_recalc_tile_islands) {
        this.tileIslandBuilder.recalculate_tile_islands(this.targetPlayerExpectedGeneralLocation);
        this._should_recalc_tile_islands = false;
      } else {
        this.tileIslandBuilder.update_tile_islands(this.targetPlayerExpectedGeneralLocation);
      }
    }

    this.armyTracker.verify_player_tile_and_army_counts_valid();

    if (map.is_army_bonus_turn || !this.defensive_spanning_tree || this.defensive_spanning_tree.size === 0) {
      this.defensive_spanning_tree = _call(this, 'BotDefense', '_get_defensive_spanning_tree',
        [this, new Set(), this._gatherTiebreakMatrix(), true, true], this.defensive_spanning_tree || new Set());
      this.friendly_city_spanning_tree = _call(this, 'BotDefense', '_get_defensive_spanning_tree',
        [this, new Set(), this._gatherTiebreakMatrix(), false, undefined], this.friendly_city_spanning_tree || new Set());
    }

    if (!this._is_all_in() && (!this.is_lag_massive_map || map.turn < 3 || (map.turn + 5) % 5 === 0)) {
      this.win_condition_analyzer.analyze(this.targetPlayer, this.targetPlayerExpectedGeneralLocation, this.perf_timer);
      if (this.targetPlayer !== -1) {
        var fogRiskTuple = this.opponent_tracker.get_immediate_fog_risk(
          this.targetPlayer, (this.friendly_city_spanning_tree || new Set()).size);
        this.win_condition_analyzer.calculate_basic_defense_against_general(
          this.defensive_spanning_tree, this.general, this.sketchiest_potential_inbound_flank_path);
        var forwardPoint = this.board_analysis.central_defense_point
          || this.win_condition_analyzer.most_forward_defense_city;
        this.win_condition_analyzer.calculate_basic_defense_against_forward_spanning_tree(
          this.defensive_spanning_tree, forwardPoint);
      }
    }

    if (!this.is_lag_massive_map || map.turn < 3 || (map.turn + 4) % 5 === 0) {
      if (this.territories.should_recalculate(map.turn)) this.territories.scan();
    }

    if (this.armyTracker.fogPaths && this.viewInfo) {
      for (var fpg = 0; fpg < this.armyTracker.fogPaths.length; fpg++) {
        this.viewInfo.color_path(new PathColorer(this.armyTracker.fogPaths[fpg]));
      }
    }

    this.cached_scrims = {};
  };

  P._analyze_army_emergences = function () {
    var map = this._map;
    var emergences = map.army_emergences || {};
    // JS 侧 map.army_emergences 是 {tile_index: [army, player]}
    var keys = Object.keys(emergences);
    keys.sort(function (a, b) { return Number(a) - Number(b); });
    for (var i = 0; i < keys.length; i++) {
      var tile = map.get_tile_by_tile_index(Number(keys[i]));
      var tuple = emergences[keys[i]];
      var emergedAmount = tuple[0];
      var emergingPlayer = tuple[1];
      if (emergedAmount > 0 || !map.is_player_on_team_with(tile.delta.oldOwner, tile.player())) {
        this.opponent_tracker.notify_emerged_army(tile, emergingPlayer, emergedAmount);
      }
    }
  };

  P._refresh_expected_general_location = function () {
    var expected = this.targetPlayerExpectedGeneralLocation;
    var predicted = null;

    if (expected === null || expected === undefined) {
      predicted = _call(this, 'BotTargeting', 'get_predicted_target_player_general_location', [this], null);
      if (predicted) {
        this.targetPlayerExpectedGeneralLocation = predicted;
        this.recalculate_player_paths(true);
      } else {
        this.targetPlayerExpectedGeneralLocation = this.general;
      }
      return;
    }

    if (expected.visible && !expected.isGeneral) {
      predicted = _call(this, 'BotTargeting', 'get_predicted_target_player_general_location', [this], null);
      if (predicted && predicted !== expected) {
        this.targetPlayerExpectedGeneralLocation = predicted;
        this.recalculate_player_paths(true);
      }
      return;
    }

    // 原版是 valid_general_positions_by_player[player][tile]（MapMatrixSet.__getitem__
    // 会折成 raw[tile_index]）。JS 侧没有对象索引，写成 validGeneralPositions[expected]
    // 恒得 undefined ⇒ 每回合都重算预测，把 t=1 那次 FFA 猜出来的位置冲掉。
    var vgp = this.targetPlayer !== -1 && this.armyTracker.valid_general_positions_by_player
      ? this.armyTracker.valid_general_positions_by_player[this.targetPlayer] : null;
    if (vgp && !vgp.has(expected)) {
      predicted = _call(this, 'BotTargeting', 'get_predicted_target_player_general_location', [this], null);
      if (predicted) {
        this.targetPlayerExpectedGeneralLocation = predicted;
        this.recalculate_player_paths(true);
      }
      return;
    }

    if (this.shortest_path_to_target_player === null) {
      this.recalculate_player_paths(true);
    }
  };

  P._refresh_alt_en_gen_positions = function () {
    var map = this._map;
    // 大图不必每回合都重算敌方将军候选位
    if (this.is_lag_massive_map && (map.turn + 2) % 5 !== 0) return;

    for (var i = 0; i < map.players.length; i++) {
      var pObj = map.players[i];
      if (!pObj || pObj.team === this.player.team) continue;
      if (!this.armyTracker.seen_player_lookup || !this.armyTracker.seen_player_lookup[i]) {
        var furthest = _call(this, 'BotTargeting', '_get_furthest_apart_3_enemy_general_locations', [this, i], null);
        if (furthest) {
          this.alt_en_gen_positions[i] = furthest[0];
          this._alt_en_gen_position_distances[i] = furthest[1];
        }
      } else {
        var limitNearbyTileRange = map.players.length > 4 ? 12 : -1;
        // 原版参数序是 (elimNearbyRange, player, cutoffEmergenceRatio, includeCities,
        // limitNearbyTileRange, requirePredictedFogTeamTile)，返回的是**格子列表**本身，
        // 不是 (list, dist) 元组 —— 按元组解会把第一格当成整张列表。
        var possibles = _call(this, 'BotTargeting', 'get_target_player_possible_general_location_tiles_sorted',
          [this, 2, i, 0.3, false, limitNearbyTileRange, true], null);
        if (possibles) {
          this.alt_en_gen_positions[i] = possibles;
          this._alt_en_gen_position_distances[i] = null;
        }
      }
    }
  };

  P._gatherTiebreakMatrix = function () {
    if (EK.BotGatherOps && EK.BotGatherOps.get_gather_tiebreak_matrix) {
      return EK.BotGatherOps.get_gather_tiebreak_matrix(this);
    }
    return new EK.MapMatrix(this._map, 0.0);
  };

  P._is_all_in = function () {
    return !!EK.BotStateQueries.is_all_in(this);
  };

  // ---- bot_ek0x45.py:858 perform_move_prep -------------------------------
  P.perform_move_prep = function (is_lag_move) {
    var map = this._map;
    var turn = map.turn;

    this.scan_map_for_large_tiles_and_leaf_moves();

    if (this.timings && this.timings.get_turn_in_cycle(turn) === 0) {
      this._timing_cycle_ended();
    }

    if (this.curPath) {
      var firstMove = this.curPath.get_first_move();
      if (!firstMove) {
        this.curPath = null;
      } else if (firstMove.dest.isMountain) {
        this.curPath = null;
      }
    }

    var wasFlanking = this.flanking;

    if (this.target_player_gather_path === null || !this.target_player_gather_path.tail
      || this.target_player_gather_path.tail.tile !== this.targetPlayerExpectedGeneralLocation) {
      this.recalculate_player_paths(true);
    }

    if (this.timings === null) this.timings = this._get_timings();

    var oldOutOfPlay = this.army_out_of_play;
    var cycleRemaining = this.timings.get_turns_left_in_cycle(turn);
    var allowSwapToOutOfPlay = cycleRemaining > 15
      || (this.opponent_tracker.winning_on_army(1.2) && this.opponent_tracker.winning_on_economy(1.2))
      || this.army_out_of_play;

    this.army_out_of_play = allowSwapToOutOfPlay
      && _call(this, 'BotExpansionOps', 'check_army_out_of_play_ratio', [this], false);

    if (!is_lag_move && !wasFlanking && this.army_out_of_play !== oldOutOfPlay) {
      this.recalculate_player_paths(true);
    }

    if (this.timings === null || this.timings.should_recalculate(turn)) {
      this.timings = this._get_timings();
    }

    if (_call(this, 'BotCombatOps', 'determine_should_winning_all_in', [this], false)) {
      var wasAllIn = this.is_all_in_army_advantage;
      this.is_all_in_army_advantage = true;
      if (!wasAllIn) {
        this.expansion_plan = new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn);
        this.city_expand_plan = null;
        this.enemy_expansion_plan = null;

        var cycle = 50;
        var gatherPathLen = this.target_player_gather_path ? this.target_player_gather_path.length : 0;
        if (map.players[this.general.player()].tileCount - gatherPathLen < 60) cycle = 30;

        _call(this, 'BotTimings', 'set_all_in_cycle_to_hit_with_current_timings', [this, cycle], null);

        if (this.targetPlayerObj && this.targetPlayerObj.general && !this.targetPlayerObj.general.visible) {
          this.targetPlayerObj.general.army = 3;
          _call(this, 'BotEventHandlers', 'clear_fog_armies_around', [this, this.targetPlayerObj.general], null);
        }

        if (!is_lag_move) this.recalculate_player_paths(true);
      }
    } else if (this.is_all_in_army_advantage && !this.all_in_city_behind) {
      this.is_all_in_army_advantage = false;
      this.all_in_army_advantage_counter = 0;
    }

    if (this.history.move_history[turn - 1]) {
      if (EK.BotRepetition.dropped_move(this)) {
        this.info('(Dropped move)... Sending clear_moves...');
        if (this.clear_moves_func) this.clear_moves_func();
      } else {
        var lastMove = this.history.move_history[turn - 1][0];
        var curPathNext = this.curPath !== null ? this.curPath.get_first_move() : null;
        if (lastMove) {
          var gatheredTilesBeforeMove = new Set(this.tiles_gathered_to_this_cycle);

          if (map.is_player_on_team_with(lastMove.dest.delta.oldOwner, this.general.player())) {
            this.tiles_gathered_to_this_cycle.add(lastMove.dest);
            if (lastMove.dest.isCity) this.cities_gathered_this_cycle.delete(lastMove.dest);
          } else if (lastMove.dest.player() === this.general.player()) {
            this.tiles_captured_this_cycle.add(lastMove.dest);
            if (lastMove.dest.isCity) {
              this.friendly_city_spanning_tree = null;
              this.defensive_spanning_tree = null;
              if (lastMove.dest.delta.oldOwner === -1) this.was_allowing_neutral_cities_last_turn = false;
            }
          }

          if (!lastMove.move_half) {
            this.tiles_gathered_to_this_cycle.delete(lastMove.source);
            this.tiles_evacuated_this_cycle.add(lastMove.source);
            if (lastMove.source.isCity) this.cities_gathered_this_cycle.add(lastMove.source);
          }

          if (lastMove.dest.isCity && lastMove.dest.delta.oldOwner === -1) {
            var amountSpentToCapCity = Math.min(lastMove.army_moved, lastMove.dest.delta.oldArmy);
            this.opponent_tracker.record_neutral_city_capture_army_spent(this.general.player(), amountSpentToCapCity);
            var ourCycleStats = this.opponent_tracker.get_current_cycle_stats_by_player(this.general.player());
            if (ourCycleStats) {
              var gatherMoveCount = ourCycleStats.moves_spent_gathering_fog_tiles
                + ourCycleStats.moves_spent_gathering_visible_tiles;
              var gatheredArmyAmount = 0;
              gatheredTilesBeforeMove.forEach(function (t) { gatheredArmyAmount += t.army; });
              gatheredArmyAmount -= gatheredTilesBeforeMove.size;
              this.opponent_tracker.record_neutral_city_capture_gather_time(
                this.general.player(), amountSpentToCapCity, gatherMoveCount, gatheredArmyAmount);
            }
          }

          if (this.curPath && curPathNext && curPathNext.source === lastMove.source) {
            this.curPath.pop_first_move();
          }
        } else if (this.curPath !== null && curPathNext === null) {
          this.curPath.pop_first_move();
        }

        if (this.force_far_gathers) this.force_far_gathers_turns -= 1;
        else this.force_far_gathers_sleep_turns -= 1;
      }
    }
  };

  // ---- bot_ek0x45.py:986 select_move ------------------------------------
  P.select_move = function (is_lag_move) {
    var map = this._map;

    this.init_turn();

    this.tiles_pinged_by_teammate_this_turn = new Set();
    while (this._tiles_pinged_by_teammate.length > 0) {
      var pingedTile = this._tiles_pinged_by_teammate.shift();
      if (this.viewInfo) this.viewInfo.add_targeted_tile(pingedTile, TargetStyle.GREEN);
      this.tiles_pinged_by_teammate_this_turn.add(pingedTile);
      if (map.turn < 50) this._tiles_pinged_by_teammate_first_25.add(pingedTile);
    }

    if (map.turn <= 1) return null;
    if (map.remainingPlayers === 1) return null;

    this.perform_move_prep(is_lag_move);

    if (is_lag_move && this.curPath && this.is_lag_massive_map) {
      var plannedMoves = this.curPath.get_move_list();
      for (var i = 0; i < plannedMoves.length; i++) {
        var pm = plannedMoves[i];
        if (pm === null || pm === undefined) return null;
        if (pm.source.player() === this.general.player() && pm.source.army > 3) return pm;
      }
    }

    if (this.history.move_history[map.turn - 1]) {
      var lastMove = this.history.move_history[map.turn - 1][0];
      if (EK.BotRepetition.dropped_move(this) && map.turn <= 50 && lastMove) {
        if (lastMove.source !== this.general) {
          return lastMove;
        }
        this.city_expand_plan = null;
      }
    }

    if ((!is_lag_move && !this.is_lag_massive_map) || map.turn < 3 || (map.turn + 2) % 5 === 0) {
      this.recalculate_player_paths(false);
    }

    if (!EK.BotStateQueries.is_still_ffa_and_non_dominant(this)) {
      _call(this, 'BotTimings', 'prune_timing_split_if_necessary', [this], null);
    }

    var move = this.pick_move_after_prep(is_lag_move);
    this.last_move = move;

    if (move && this.curPath && this.curPath.tileSet && this.curPath.tileSet.has(move.source)) {
      var pathNext = this.curPath.get_first_move();
      if (move !== pathNext && pathNext && move.dest !== pathNext.source) {
        this.curPath = null;
      }
    }

    return move;
  };

  // ---- bot_ek0x45.py:1049 pick_move_after_prep --------------------------
  P.pick_move_after_prep = function (is_lag_move) {
    var map = this._map;
    var self = this;

    _call(this, 'BotDefense', 'calculate_general_danger', [this], null);

    if (map.turn <= 4 && map.has_city_state) {
      var genMovable = this.general.movable || [];
      for (var ct = 0; ct < genMovable.length; ct++) {
        var cityTile = genMovable[ct];
        if (cityTile.isCity && cityTile.isNeutral && cityTile.army === -1) {
          return new EK.Move(this.general, cityTile);
        }
      }
    }

    EK.BotPathingUtils.clean_up_path_before_evaluating(this);

    var threat = null;
    if (this.dangerAnalyzer) {
      if (this.dangerAnalyzer.fastestThreat !== null && this.dangerAnalyzer.fastestThreat !== undefined) {
        threat = this.dangerAnalyzer.fastestThreat;
      }
      var allyThreat = this.dangerAnalyzer.fastestAllyThreat;
      if (allyThreat && (threat === null || allyThreat.turns < threat.turns)) {
        if (_call(this, 'BotDefense', 'determine_should_defend_ally', [this], false)) threat = allyThreat;
      }
      if (this.dangerAnalyzer.fastestCityThreat && threat === null) {
        threat = this.dangerAnalyzer.fastestCityThreat;
      }
      if (threat === null && !(this.giving_up_counter > 30) && this.dangerAnalyzer.fastestVisionThreat) {
        threat = this.dangerAnalyzer.fastestVisionThreat;
      }
    }

    var kingKillPath = null;
    var raceChance = 0;
    var killRes = _call(this, 'BotCombatOps', 'check_for_king_kills_and_races', [this, threat], [null, null, 0]);
    if (killRes && killRes[0]) return killRes[0];
    if (killRes) {
      kingKillPath = killRes[1];
      raceChance = killRes[2];
    }

    var defenseCriticalTileSet = new Set();
    if (this.teammate_general && map.teammates && map.teammates.has(this.teammate_general.player)) {
      var armies = this.armyTracker.armies;
      var armyIter = armies.values();
      var armyObj = armyIter.next();
      while (!armyObj.done) {
        var army = armyObj.value;
        if (map.teammates.has(army.player)) {
          if (army.last_moved_turn > map.turn - 3) defenseCriticalTileSet.add(army.tile);
          if (army.tile.delta.armyDelta !== 0
            && (army.tile.delta.oldOwner !== army.player || army.tile.delta.oldArmy < army.tile.army)) {
            defenseCriticalTileSet.add(army.tile);
          }
        }
        armyObj = armyIter.next();
      }
    }

    this.threat = threat;

    _call(this, 'BotCombatOps', 'check_should_be_all_in_losing', [this], null);

    if (!this._is_all_in() && ((!is_lag_move && !this.is_lag_massive_map) || map.turn < 3 || (map.turn + 2) % 5 === 0)) {
      this.enemy_expansion_plan = _call(this, 'BotExpansionOps', 'build_enemy_expansion_plan', [this, 0.007, [255, 150, 130]], null);
    }

    this.intercept_plans = _call(this, 'BotDefense', 'build_intercept_plans', [this, defenseCriticalTileSet], {});

    if (!this._is_all_in() && !is_lag_move) {
      var redoTimings = this.expansion_plan === null || this.timings === null
        || map.turn >= this.timings.nextRecalcTurn;

      var negs = new Set();
      defenseCriticalTileSet.forEach(function (t) { if (!map.is_tile_on_team_with(t, self.targetPlayer)) negs.add(t); });
      _call(this, 'BotExpansionOps', '_add_expansion_threat_negs', [this, negs], null);

      var checkCityRoundEndPlans = map.is_army_bonus_turn;

      this.quick_kill_city_plan_option = null;
      var quickKillNegs = new Set(defenseCriticalTileSet);
      var contested = this.cityAnalyzer.owned_contested_cities;
      if (contested) {
        (contested instanceof Set ? contested : new Set(contested)).forEach(function (t) { quickKillNegs.add(t); });
      }
      this.quick_kill_city_plan_option = _call(this, 'BotCityOps', 'get_quick_kill_on_enemy_cities_plan_option', [this, quickKillNegs], null);
      this.contest_city_plan_option = _call(this, 'BotCityOps', 'get_city_contestation_plan_option', [this], null);
      this.city_capture_plan_option = _call(this, 'BotCityOps', 'capture_cities_plan_option',
        [this, negs, false, true, true], null);

      this.expansion_plan = _call(this, 'BotExpansionOps', 'build_expansion_plan',
        // 原版是关键字调用 includeExtraGenAndCityArmy=checkCityRoundEndPlans（bot_ek0x45.py:1149）；
        // 第 5 位是 overrideTurns，照位置传会把 true/false 塞进 overrideTurns
        [this, 0.01, negs, [150, 100, 150], -1, checkCityRoundEndPlans],
        new ExpansionPotential(0, 0, 0, null, [], 0.0, map.turn));

      this.capture_line_tracker.process_plan(this.targetPlayer, this.expansion_plan);

      if (this.enemy_expansion_plan !== null) {
        this.win_condition_analyzer.force_kill_all_in_if_projected_round_loss(
          this, this.expansion_plan, this.enemy_expansion_plan);
      }

      if (redoTimings) this.timings = this._get_timings();
    }

    // ---- 威胁防御
    var defenseSavePath = null;
    if (!this.is_all_in_losing && threat && threat.threatType !== EK.ThreatType.Vision) {
      var defRes = _call(this, 'BotDefense', 'get_defense_moves',
        [this, defenseCriticalTileSet, kingKillPath, raceChance], [null, null]);
      var defenseMove = defRes ? defRes[0] : null;
      defenseSavePath = defRes ? defRes[1] : null;

      if (defenseMove) {
        var isRep = _call(this, 'BotRepetition', 'detect_repetition', [this, defenseMove, 6, 3], false);
        if (!isRep || (threat.threatType === EK.ThreatType.Kill
          && threat.path && threat.path.tail && threat.path.tail.tile.isGeneral)) {
          if (this.largePlayerTiles.indexOf(defenseMove.source) >= 0 && this.targetingArmy === null) {
            this.targetingArmy = this.get_army_at(threat.path.start.tile);
          }
          return defenseMove;
        }
      }
    }

    // ---- 城局 / 无扩张局
    if (map.turn < 100) {
      var unexpandableRatio = _call(this, 'BotExpansionOps', 'get_unexpandable_ratio', [this], 0);
      var isNoExpansionGame = ((map.swamps.size > 0 || map.deserts.size > 0) && unexpandableRatio > 0.7);
      if (isNoExpansionGame || map.is_low_cost_city_game) {
        if (map.turn < 30) {
          var qkRes = _call(this, 'BotCityOps', '_check_should_wait_city_capture', [this], [null, false]);
          var qkPath = qkRes ? qkRes[0] : null;
          var shouldWait = qkRes ? qkRes[1] : false;
          if (qkPath) return qkPath.get_first_move();
          if (shouldWait) return null;
        }
        if (!this.army_out_of_play) {
          var capRes = _call(this, 'BotCityOps', 'capture_cities', [this, new Set(), true], [null, null]);
          var capPath = capRes ? capRes[0] : null;
          var capMove = capRes ? capRes[1] : null;
          if (capMove) {
            this.city_expand_plan = null;
            return capMove;
          }
          if (capPath) {
            this.city_expand_plan = null;
            return EK.BotPathingUtils.get_first_path_move(this, capPath);
          }
        }
      }
    }

    if (map.turn < 50) {
      if (!map.is_low_cost_city_game && !map.modifiers_by_id[MODIFIER_CITY_STATE]) {
        return _call(this, 'BotExpansionOps', 'make_first_25_move', [this], null);
      }
    }

    if (map.turn < 250 && map.remainingPlayers > 3) {
      var turtleMove = _call(this, 'BotExpansionOps', 'look_for_ffa_turtle_move', [this], null);
      if (turtleMove) return turtleMove;
    }

    if (this.expansion_plan && this.expansion_plan.blocking_tiles) {
      this.expansion_plan.blocking_tiles.forEach(function (t) { defenseCriticalTileSet.add(t); });
    }

    if (this.win_condition_analyzer.defend_cities) {
      this.win_condition_analyzer.defend_cities.forEach(function (t) { defenseCriticalTileSet.add(t); });
    }

    var mostForward = this.win_condition_analyzer.most_forward_defense_city;
    if (mostForward && this.armyTracker.has_player_seen(this.targetPlayer, mostForward)) {
      var closeToEnemyThresh = this.board_analysis.inter_general_distance * 2 / 3;
      var forwardDist = this.board_analysis.intergeneral_analysis.bMap.raw[mostForward.tile_index];
      if (closeToEnemyThresh > forwardDist) defenseCriticalTileSet.add(mostForward);
    }

    if (map.is_army_bonus_turn || this.defensive_spanning_tree === null) {
      this.defensive_spanning_tree = _call(this, 'BotDefense', '_get_defensive_spanning_tree',
        [this, defenseCriticalTileSet, this._gatherTiebreakMatrix(), true, true], new Set());
      this.friendly_city_spanning_tree = _call(this, 'BotDefense', '_get_defensive_spanning_tree',
        [this, defenseCriticalTileSet, this._gatherTiebreakMatrix(), false, undefined], new Set());
    }

    _call(this, 'BotCentralDefense', 'calculate_central_defense_point_if_needed', [this], null);

    if (kingKillPath !== null && threat && threat.threatType === EK.ThreatType.Kill) {
      var attackingWithSavePath = defenseSavePath !== null && defenseSavePath.start.tile === kingKillPath.start.tile;
      var attackingWithSelectedExpansionPlan = this.expansion_plan !== null
        && this.expansion_plan.selected_option !== null
        && this.expansion_plan.selected_option.start
        && this.expansion_plan.selected_option.start.tile === kingKillPath.start.tile;
      var attackingWithRestrictedArmyMovement = false;
      var blocks = this.blocking_tile_info[kingKillPath.start.tile.tile_index];
      if (blocks && blocks.blocked_destinations && blocks.blocked_destinations.indexOf(kingKillPath.start.next.tile) >= 0) {
        attackingWithRestrictedArmyMovement = true;
      }
      if (!attackingWithSavePath && !attackingWithSelectedExpansionPlan && !attackingWithRestrictedArmyMovement) {
        return new EK.Move(kingKillPath.start.tile, kingKillPath.start.next.tile);
      }
    }

    var dangerTileKillMove = _call(this, 'BotDefense', 'check_for_danger_tile_moves', [this], null);
    if (dangerTileKillMove) return dangerTileKillMove;

    var flankDefMove = _call(this, 'BotExplorationOps', 'find_flank_defense_move',
      [this, defenseCriticalTileSet, true], null);
    if (flankDefMove) {
      if (this.timings && this.timings.in_gather_split(map.turn)) {
        this.timings.splitTurns += 1;
        if (this.timings.splitTurns > this.timings.launchTiming) {
          this.timings.launchTiming = this.timings.splitTurns;
        }
      }
      return flankDefMove;
    }

    var fogRiskTuple = this.opponent_tracker.get_immediate_fog_risk(
      this.targetPlayer, (this.friendly_city_spanning_tree || new Set()).size);

    // ---- force_far_gathers
    if (this.force_far_gathers && this.force_far_gathers_turns > 0) {
      var roughTurns = this.force_far_gathers_turns;
      var targets = null;

      if (this.enemy_attack_path) {
        var subseg = this.enemy_attack_path.get_subsegment(Math.floor(this.enemy_attack_path.length / 2));
        targets = subseg.tileList.filter(function (t) { return map.is_tile_enemy(t) || !t.visible; });
      }
      if ((!targets || targets.length === 0) && this.win_condition_analyzer.contestable_cities) {
        targets = Array.from(toArr(this.win_condition_analyzer.contestable_cities));
      }
      if ((!targets || targets.length === 0) && this.win_condition_analyzer.defend_cities) {
        targets = Array.from(toArr(this.win_condition_analyzer.defend_cities));
      }
      if ((!targets || targets.length === 0) && this.target_player_gather_path) {
        var tailSeg = this.target_player_gather_path.get_subsegment(
          Math.floor(this.target_player_gather_path.length / 2), true);
        targets = tailSeg.tileList.filter(function (t) { return map.is_tile_enemy(t) || !t.visible; });
      }
      if (!targets || targets.length === 0) targets = [this.general];

      var minTurns = roughTurns - 10;
      var maxTurns = roughTurns + 10;

      if (EK.GatherCapturePlan && this.curPath instanceof EK.GatherCapturePlan) {
        var ffFirst = this.curPath.get_first_move();
        if ((ffFirst && ffFirst.source.isSwamp) || (maxTurns >= this.curPath.length && this.curPath.length >= minTurns)) {
          EK.BotPathingUtils.clean_up_path_before_evaluating(this);
          return this.curPath.get_first_move();
        }
      }

      var gcp = _call(this, 'Gather', 'gather_approximate_turns_to_tiles', [map, targets, roughTurns, this.player.index], null);
      if (!gcp) {
        var gathMat = this._gatherTiebreakMatrix();
        var ggRes = EK.BotGatherOps.get_gather_to_target_tiles(this, targets, 0.05, maxTurns,
          defenseCriticalTileSet, -1, false, null, false, true, 0, null, gathMat, null, false, false);
        var ggNodes = ggRes[3];
        if (ggNodes) {
          gcp = EK.GatherCapturePlan.build_from_root_nodes(map, ggNodes, defenseCriticalTileSet,
            this.general.player(), false, gathMat, true, true);
        }
      }
      if (gcp) {
        var ffMove = gcp.get_first_move();
        this.gatherNodes = gcp.root_nodes;
        this.curPath = gcp;
        return ffMove;
      }
    }

    if (!this.is_weird_custom) {
      var second = _call(this, 'BotExpansionOps', 'make_second_25_move', [this], null);
      if (second) return second;
    }

    // ---- 将军邻格的敌方视野格：能一口吃掉就打
    var genAdj = this.general.adjacents || [];
    var numTilesAdjKing = 0;
    for (var ga = 0; ga < genAdj.length; ga++) {
      if (genAdj[ga].army > 2 && map.is_tile_enemy(genAdj[ga])) numTilesAdjKing += 1;
    }
    if (numTilesAdjKing === 1) {
      for (var vt = 0; vt < genAdj.length; vt++) {
        var annoyingTile = genAdj[vt];
        if (!(map.is_tile_enemy(annoyingTile) && annoyingTile.army > 2)) continue;
        var annoyingMov = annoyingTile.movable || [];
        var largestAdjTile = null;
        for (var am = 0; am < annoyingMov.length; am++) {
          var cand = annoyingMov[am];
          if (cand.player() === this.general.player() && cand.army > Math.floor(annoyingTile.army / 2) && cand.army > 1) {
            if (!largestAdjTile || cand.army > largestAdjTile.army) largestAdjTile = cand;
          }
        }
        if (largestAdjTile && largestAdjTile.army - 1 > annoyingTile.army) {
          this.targetingArmy = this.get_army_at(annoyingTile);
          return new EK.Move(largestAdjTile, annoyingTile);
        }
      }
    }

    var afkPlayerMove = _call(this, 'BotExplorationOps', 'get_move_if_afk_player_situation', [this], null);
    if (afkPlayerMove) return afkPlayerMove;

    EK.BotPathingUtils.check_cur_path(this);

    _call(this, 'BotDefense', 'check_fog_risk', [this], null);

    this.defend_economy = _call(this, 'BotDefense', 'should_defend_economy', [this, defenseCriticalTileSet], false);

    this.approximate_greedy_turns_avail = _call(this, 'BotTimings', 'calculate_greedy_turns_available', [this], 0);

    if (this.win_condition_analyzer.viable_win_conditions.has('DefendContestedFriendlyCity')) {
      var cityDefenseMove = _call(this, 'BotCityOps', 'get_city_preemptive_defense_move',
        [this, defenseCriticalTileSet], null);
      if (cityDefenseMove) return cityDefenseMove;
    }

    // ---- 扩张计划里选中的是城 → 直接走
    if (this.expansion_plan && this.expansion_plan.selected_option) {
      var selectedCityOption = this.expansion_plan.selected_option;

      var selectedTargetCity = null;
      if (selectedCityOption instanceof EK.GatherCapturePlan) {
        selectedTargetCity = selectedCityOption.gather_target;
      } else if (selectedCityOption.tail) {
        selectedTargetCity = selectedCityOption.tail.tile;
        if (!selectedTargetCity && selectedCityOption.tail.prev) {
          selectedTargetCity = selectedCityOption.tail.prev.tile;
        }
      }

      var cityCaptureTarget = optionTargetCity(this.city_capture_plan_option);
      var contestCityTarget = optionTargetCity(this.contest_city_plan_option);
      var quickKillTarget = optionTargetCity(this.quick_kill_city_plan_option);

      var selectedMatchesCityOption = selectedCityOption === this.city_capture_plan_option
        || selectedCityOption === this.contest_city_plan_option
        || selectedCityOption === this.quick_kill_city_plan_option
        || (selectedTargetCity !== null && selectedTargetCity === cityCaptureTarget)
        || (selectedTargetCity !== null && selectedTargetCity === contestCityTarget)
        || (selectedTargetCity !== null && selectedTargetCity === quickKillTarget);

      var selMove = selectedCityOption.get_first_move();
      if (selectedMatchesCityOption && selMove && !_call(this, 'BotRepetition', 'detect_repetition', [this, selMove, 6, 3], false)) {
        var targetCity = selectedTargetCity;
        if (targetCity && (targetCity.isCity || targetCity.isGeneral)) {
          if (targetCity.isNeutral) this.cityAnalyzer.last_targeted_neut_city = targetCity;
          return selMove;
        }
      }
    }

    if (this.expansion_plan && this.expansion_plan.includes_intercept && !this.is_all_in_losing
      && !this.win_condition_analyzer.projected_loss_all_in_active) {
      var intMove = this.expansion_plan.selected_option.get_first_move();
      if (intMove && !_call(this, 'BotRepetition', 'detect_repetition', [this, intMove, 6, 3], false)) {
        return intMove;
      }
    }

    var expNegs = new Set(defenseCriticalTileSet);
    if (this.win_condition_analyzer.viable_win_conditions.has('DefendEconomicLead')) {
      toArr(this.win_condition_analyzer.defend_cities).forEach(function (t) { expNegs.add(t); });
      toArr(this.win_condition_analyzer.contestable_cities).forEach(function (t) { expNegs.add(t); });
    }
    var largeArmyExpContinuationMove = _call(this, 'BotExplorationOps',
      'try_get_enemy_territory_exploration_continuation_move', [this, expNegs], null);
    if (largeArmyExpContinuationMove
      && !_call(this, 'BotRepetition', 'detect_repetition', [this, largeArmyExpContinuationMove, 6, 3], false)) {
      return largeArmyExpContinuationMove;
    }

    var projectedLossAllInMove = _call(this, 'BotKillTiming', 'get_projected_loss_all_in_move',
      [this, defenseCriticalTileSet], null);
    if (projectedLossAllInMove) return projectedLossAllInMove;

    if (map.turn >= 50 && map.turn < 75) {
      var tendrilMove = _call(this, 'BotExpansionOps', 'try_gather_tendrils_towards_enemy', [this], null);
      if (tendrilMove) return tendrilMove;
    }

    if (this.win_condition_analyzer.projected_loss_all_in_active) this.curPath = null;

    if (this.curPath !== null) {
      var contRes = _call(this, 'BotPathingUtils', 'continue_cur_path',
        [this, threat, defenseCriticalTileSet], [false, null]);
      if (contRes && contRes[0]) return contRes[1];
    }

    var exploreMove = _call(this, 'BotExplorationOps', 'try_find_exploration_move',
      [this, defenseCriticalTileSet], null);
    if (exploreMove) return exploreMove;

    var allInMove = _call(this, 'BotCombatOps', 'get_all_in_move', [this, defenseCriticalTileSet], null);
    if (allInMove) return allInMove;

    if (!this.defend_economy && !this.likely_kill_push) {
      var mainExpMove = _call(this, 'BotExpansionOps',
        'try_find_main_timing_expansion_move_if_applicable', [this, defenseCriticalTileSet], null);
      if (mainExpMove) return mainExpMove;
    }

    // ---- needToKillTiles / leaf moves
    var needToKillTiles = [];
    if (!this.timings.disallowEnemyGather && !this.is_all_in_losing) {
      needToKillTiles = _call(this, 'BotCombatOps', 'find_key_enemy_vision_tiles', [this], []) || [];
    }

    var timingTurn = this.timings.get_turn_in_cycle(map.turn);
    var quickExpTimingTurns = this.timings.quickExpandTurns - map.turn % this.timings.cycleTurns;
    var earlyRetakeTurns = quickExpTimingTurns + this.behavior_early_retake_bonus_gather_turns
      - map.turn % this.timings.cycleTurns;

    if (!this._is_all_in() && map.remainingPlayers <= 3 && earlyRetakeTurns > 0
      && needToKillTiles.length > 0 && timingTurn >= this.timings.quickExpandTurns) {
      var actualGatherTurns = earlyRetakeTurns;
      var gatherNodes = _call(this, 'Gather', 'knapsack_depth_gather',
        [map, needToKillTiles.slice(), actualGatherTurns, defenseCriticalTileSet, this.general.player(),
          false, null, true, true], null);
      if (!gatherNodes) {
        // Gather.knapsack_depth_gather 未移植 → 退化到 BotGatherOps 的 build_mst 路径
        var erRes = EK.BotGatherOps.get_gather_to_target_tiles(this, needToKillTiles, 0.05,
          actualGatherTurns, defenseCriticalTileSet, -1, true, null, false, false, 0, null, null, null, false, false);
        gatherNodes = erRes[3];
      }
      this.gatherNodes = gatherNodes;
      var erMove = EK.BotGatherOps.get_tree_move_default(this, gatherNodes);
      if (erMove) return erMove;
    }

    var flankDefMoveLow = _call(this, 'BotExplorationOps', 'find_flank_defense_move',
      [this, defenseCriticalTileSet, false], null);
    if (flankDefMoveLow) {
      if (this.timings.in_gather_split(map.turn)) {
        this.timings.splitTurns += 1;
        if (this.timings.splitTurns > this.timings.launchTiming) {
          this.timings.launchTiming = this.timings.splitTurns;
        }
      }
      return flankDefMoveLow;
    }

    var cyclicAllInMove = _call(this, 'BotCombatOps', 'try_get_cyclic_all_in_move',
      [this, defenseCriticalTileSet], null);
    if (cyclicAllInMove) return cyclicAllInMove;

    if (!this._is_all_in() && !this.defend_economy && quickExpTimingTurns > 0) {
      var tendrilMove2 = _call(this, 'BotExpansionOps', 'try_gather_tendrils_towards_enemy',
        [this, quickExpTimingTurns], null);
      if (tendrilMove2) return tendrilMove2;

      var prioLeaves = _call(this, 'BotExpansionOps', 'prioritize_expansion_leaves', [this, this.leafMoves], []);
      if (prioLeaves && prioLeaves.length > 0) return prioLeaves[0];
    }

    var quickCapMove = _call(this, 'BotExpansionOps', '_get_expansion_plan_quick_capture_move',
      [this, defenseCriticalTileSet], null);
    if (quickCapMove) return quickCapMove;

    // ---- 主 gather
    var gathMove = EK.BotGatherOps.try_find_gather_move(
      this, threat, defenseCriticalTileSet, this.leafMoves, needToKillTiles);
    if (gathMove) return gathMove;

    var isFfaAfkScenario = map.remainingCycleTurns > 14
      && EK.BotStateQueries.is_still_ffa_and_non_dominant(this)
      && map.cycleTurn < this.timings.launchTiming
      && !map.is_walled_city_game;
    if (isFfaAfkScenario) return null;

    // 下面这段原版注释就写着「NOTHING PAST THIS POINT CAN TAKE ANY EXTRA TIME」
    if (this.expansion_plan && this.expansion_plan.selected_option) {
      var deferred = [];
      var deferring = this.expansion_plan.turns_used < map.remainingCycleTurns - 1;

      var fbMove = this.expansion_plan.selected_option.get_first_move();
      if (fbMove) {
        if (fbMove.source.player() === map.player_index && fbMove.source.army > 1
          && EK.BotPathingUtils.is_move_safe_valid(this, fbMove)) {
          return fbMove;
        }
      }

      var allPaths = this.expansion_plan.all_paths || [];
      for (var fap = 0; fap < allPaths.length; fap++) {
        var opt = allPaths[fap];
        var optMove = opt.get_first_move();
        if (optMove && optMove.source.player() === map.player_index && optMove.source.army > 1) {
          var hasGenOrCity = false;
          if (deferring) {
            var optTiles = opt.tileList || [];
            for (var ot = 0; ot < optTiles.length; ot++) {
              var ott = optTiles[ot];
              if (ott.player === map.player_index && (ott.isGeneral || ott.isCity)) { hasGenOrCity = true; break; }
            }
          }
          if (deferring && hasGenOrCity) deferred.push(optMove);
          else return optMove;
        }
      }
      if (deferred.length > 0) return deferred[0];
    }

    if (!this._is_all_in()) {
      var leafMove = _call(this, 'BotExpansionOps', 'find_leaf_move', [this, this.leafMoves], null);
      if (leafMove) return leafMove;
    }

    this.curPathPrio = -1;
    if (this._get_remaining_move_time() > 0.01) {
      var targets2 = [];
      if (this.targetPlayer >= 0 && this.targetPlayerObj) {
        toArr(this.targetPlayerObj.tiles).forEach(function (t) { targets2.push(t); });
      } else {
        var allTiles = map.get_all_tiles();
        for (var at2 = 0; at2 < allTiles.length; at2++) {
          if (allTiles[at2].player === -1 && !allTiles[at2].isObstacle) targets2.push(allTiles[at2]);
        }
      }
      var negatives2 = new Set(defenseCriticalTileSet);
      toArr(this.target_player_gather_targets).forEach(function (t) { negatives2.add(t); });
      var turns2 = this.timings.launchTiming - this.timings.get_turn_in_cycle(map.turn);
      var gathMove2 = EK.BotGatherOps.timing_gather(this, targets2, negatives2, null, true, null, turns2,
        false, true, true, null, null, true);
      if (gathMove2) return gathMove2;
    }

    return null;
  };

  function optionTargetCity(option) {
    if (!option) return null;
    if (EK.GatherCapturePlan && option instanceof EK.GatherCapturePlan) return option.gather_target;
    return option.tail ? option.tail.tile : null;
  }

  function toArr(coll) {
    if (!coll) return [];
    if (Array.isArray(coll)) return coll;
    if (coll instanceof Set) return Array.from(coll);
    if (typeof coll[Symbol.iterator] === 'function') return Array.from(coll);
    return [];
  }

  // ---- bot_ek0x45.py:1935 recalculate_player_paths ----------------------
  P.recalculate_player_paths = function (force) {
    var map = this._map;
    var turn = map.turn;

    _call(this, 'BotCityOps', 'ensure_reachability_matrix_built', [this], null);

    var reevaluate = !!force;

    if (this._evaluatedUndiscoveredCache && this._evaluatedUndiscoveredCache.length > 0) {
      for (var i = 0; i < this._evaluatedUndiscoveredCache.length; i++) {
        if (this._evaluatedUndiscoveredCache[i].discovered) { reevaluate = true; break; }
      }
    }

    if (this.targetPlayerExpectedGeneralLocation && this.targetPlayerExpectedGeneralLocation.visible
      && !this.targetPlayerExpectedGeneralLocation.isGeneral) {
      reevaluate = true;
    }

    var justTookCity = false;
    var allTiles = map.get_all_tiles();
    for (var j = 0; j < allTiles.length; j++) {
      var tile = allTiles[j];
      if (tile.isCity && tile.player() >= 0 && tile.delta && tile.delta.oldOwner === -1) { justTookCity = true; break; }
    }
    if (justTookCity) reevaluate = true;

    var gatherPathTail = this.target_player_gather_path && this.target_player_gather_path.tail
      ? this.target_player_gather_path.tail.tile : null;
    var intentionallyGatheringAtNonGeneralTarget = this.target_player_gather_path === null
      || (gatherPathTail && !gatherPathTail.isGeneral && map.generals[this.targetPlayer] !== null);

    var shouldRecalc = this.target_player_gather_path === null
      || reevaluate
      || (gatherPathTail && gatherPathTail.isCity)
      || turn % 50 < 2
      || (this.timings && this.timings.in_launch_split(turn - 3))
      || turn < 100
      || intentionallyGatheringAtNonGeneralTarget
      || this.curPath === null;

    if (shouldRecalc) {
      this.shortest_path_to_target_player = _call(this, 'BotTargeting', 'get_path_to_target_player',
        [this, this._is_all_in(), null, this.general], null);

      if (this.shortest_path_to_target_player === null || this.shortest_path_to_target_player === undefined) {
        // 原版：路径找不到就造一条「将军 -> 第一个可走格」的假路径，保证下游 .length/.tail 不炸
        var fakePath = EK.Path ? new EK.Path() : null;
        if (fakePath) {
          fakePath.add_next(this.general);
          var movable = this.general.movableNoObstacles || this.general.movable;
          if (movable && movable.length > 0) fakePath.add_next(movable[0]);
          this.shortest_path_to_target_player = fakePath;
        }
      }

      this.enemy_attack_path = _call(this, 'BotDefense', 'get_enemy_probable_attack_path',
        [this, this.targetPlayer], null);

      this.target_player_gather_path = _call(this, 'BotTargeting', 'get_path_to_target_player',
        [this, this._is_all_in(), null], null);
      if (this.target_player_gather_path === null || this.target_player_gather_path === undefined) {
        this.target_player_gather_path = this.shortest_path_to_target_player;
      }

      if (this.teammate_communicator) {
        this.teammate_communicator.determine_leads(
          this._gen_distances, this._ally_distances, this.targetPlayerExpectedGeneralLocation);
      }
    }

    if (this.targetPlayer !== -1 && this.target_player_gather_path) {
      this.sketchiest_potential_inbound_flank_path = _call(this, 'BotDefense',
        'find_sketchiest_fog_flank_from_enemy', [this], null);
    }

    var spawnDist = 12;
    if (this.target_player_gather_path) {
      var pathTillVisibleToTarget = this.target_player_gather_path;

      if (_call(this, 'BotTargeting', 'is_ffa_situation', [this], false)) {
        var teammatesOfTarget = map.get_teammates(this.targetPlayer);
        if (typeof pathTillVisibleToTarget.get_subsegment_until_visible_to_player === 'function') {
          pathTillVisibleToTarget = pathTillVisibleToTarget.get_subsegment_until_visible_to_player(teammatesOfTarget);
        }
      }

      var newTargets = new Set();
      var ptl = pathTillVisibleToTarget.tileList || [];
      for (var k = 0; k < ptl.length; k++) {
        var pt = ptl[k];
        if (!pt.isSwamp && (!pt.isDesert || map.is_tile_friendly(pt))) newTargets.add(pt);
      }
      if (newTargets.size === 0 && pathTillVisibleToTarget.tileSet) {
        newTargets = new Set(toArr(pathTillVisibleToTarget.tileSet));
      }
      this.target_player_gather_targets = newTargets;

      spawnDist = this.shortest_path_to_target_player
        ? this.shortest_path_to_target_player.length
        : spawnDist;
    } else {
      this.target_player_gather_targets = null;
    }

    this.force_city_take = _call(this, 'BotTargeting', 'is_player_spawn_cramped', [this, spawnDist], false)
      && map.turn > 150;
  };

  // ---- bot_ek0x45.py:1764 scan_map_for_large_tiles_and_leaf_moves -------
  P.scan_map_for_large_tiles_and_leaf_moves = function () {
    var map = this._map;
    var self = this;
    var genPlayer = map.players[this.general.player()];

    this.general_safe_func_set[this.general.tile_index] = function (target, moveHalf) {
      return _call(self, 'BotDefense', 'general_move_safe', [self, target, !!moveHalf], false);
    };

    this.leafMoves = [];
    this.captureLeafMoves = [];
    this.targetPlayerLeafMoves = [];
    this.largeTilesNearEnemyKings = new Map();
    this.largePlayerTiles = [];

    var largePlayerTileThreshold = genPlayer.tileCount > 0
      ? genPlayer.standingArmy / genPlayer.tileCount * 5
      : 0;

    this.generalApproximations = [];
    for (var gi = 0; gi < map.generals.length; gi++) this.generalApproximations.push([0, 0, 0, null]);

    // 将军邻格有敌人 → 对方知道我的将军位置
    var genAdj = this.general.adjacents || [];
    for (var ga = 0; ga < genAdj.length; ga++) {
      var adj = genAdj[ga];
      if (adj.player() >= 0 && adj.player() !== this.general.player()) {
        var seenPlayer = map.players[adj.player()];
        if (seenPlayer) {
          seenPlayer.knowsKingLocation = true;
          var sameTeam = map.get_teammates(adj.player());
          for (var st = 0; st < sameTeam.length; st++) {
            if (map.players[sameTeam[st]]) map.players[sameTeam[st]].knowsKingLocation = true;
          }
        }
      }
    }

    if (this.teammate_general) {
      var tmAdj = this.teammate_general.adjacents || [];
      for (var ta = 0; ta < tmAdj.length; ta++) {
        var tAdj = tmAdj[ta];
        if (tAdj.player >= 0 && tAdj.player !== this.teammate_general.player) {
          var tmSame = map.get_teammates(this.teammate_general.player);
          for (var ts = 0; ts < tmSame.length; ts++) {
            if (map.players[tmSame[ts]]) map.players[tmSame[ts]].knowsAllyKingLocation = true;
          }
        }
      }
    }

    var enemyGenerals = [];
    for (var eg = 0; eg < map.generals.length; eg++) {
      var egTile = map.generals[eg];
      if (egTile && eg !== map.player_index) {
        enemyGenerals.push(egTile);
        this.largeTilesNearEnemyKings.set(egTile, []);
      }
    }
    var expectedGen = this.targetPlayerExpectedGeneralLocation;
    if (expectedGen && !expectedGen.isGeneral) {
      this.largeTilesNearEnemyKings.set(expectedGen, []);
    }

    var largeNegativeHeap = [];
    var allTiles = map.get_all_tiles();

    for (var i = 0; i < allTiles.length; i++) {
      var tile = allTiles[i];

      if (tile.player() >= 0 && tile.player() !== map.player_index && map.generals[tile.player()] === null) {
        // 未知将军位置：用已发现的敌方格做重心近似
        var approx = this.generalApproximations[tile.player()];
        var tileAdj = tile.adjacents || [];
        for (var aj = 0; aj < tileAdj.length; aj++) {
          if (!tileAdj[aj].discovered) {
            approx[0] += tileAdj[aj].x;
            approx[1] += tileAdj[aj].y;
            approx[2] += 1;
          }
        }
      }

      if (tile.player() === map.player_index) {
        var nexts = tile.movable || [];
        for (var n = 0; n < nexts.length; n++) {
          var nextTile = nexts[n];
          if (!map.is_tile_friendly(nextTile) && !nextTile.isObstacle && !nextTile.isSwamp
            && (!nextTile.isDesert || nextTile.player() >= 0)) {
            this.leafMoves.push(new EK.Move(tile, nextTile));
          }
          if (tile.army - 1 > nextTile.army && tile.army > 1
            && !map.is_tile_friendly(nextTile) && !nextTile.isObstacle && !nextTile.isSwamp
            && (!nextTile.isDesert || nextTile.player() >= 0)) {
            this.captureLeafMoves.push(new EK.Move(tile, nextTile));
          }
        }
        if (tile.army > largePlayerTileThreshold) this.largePlayerTiles.push(tile);

        if (tile.army > 5) {
          for (var ek = 0; ek < enemyGenerals.length; ek++) {
            var enemyGen = enemyGenerals[ek];
            if (tile.army > enemyGen.army && map.euclidDist(enemyGen.x, enemyGen.y, tile.x, tile.y) < 11) {
              this.largeTilesNearEnemyKings.get(enemyGen).push(tile);
            }
          }
        }
      } else if (tile.player() !== -1) {
        if (tile.player() === this.targetPlayer) {
          var tNexts = tile.movable || [];
          for (var tn = 0; tn < tNexts.length; tn++) {
            var tNext = tNexts[tn];
            if (!map.is_tile_on_team_with(tNext, this.targetPlayer) && !tNext.isObstacle
              && tile.army - 1 > tNext.army && tile.army > 1) {
              this.targetPlayerLeafMoves.push(new EK.Move(tile, tNext));
            }
          }
        }
        if (tile.isCity && map.is_tile_enemy(tile)) this.enemyCities.push(tile);
      } else if (tile.army < -1) {
        largeNegativeHeap.push(tile);
      }
    }

    largeNegativeHeap.sort(function (a, b) { return a.army - b.army; });
    this.largeNegativeNeutralTiles = largeNegativeHeap;

    // 未知将军位置的重心外推
    for (var gi2 = 0; gi2 < map.generals.length; gi2++) {
      var g2 = map.generals[gi2];
      if (g2) continue;
      var approx2 = this.generalApproximations[gi2];
      if (!approx2 || approx2[2] <= 0) continue;

      var avgX = approx2[0] / approx2[2];
      var avgY = approx2[1] / approx2[2];
      var deltaX = (avgX - this.general.x) * 1.1;
      var deltaY = (avgY - this.general.y) * 1.1;
      var targetX = this.general.x + deltaX;
      var targetY = this.general.y + deltaY;

      var best = null;
      var bestDist = 1e9;
      var pathable = map.pathable_tiles || map.get_all_tiles();
      for (var pIdx = 0; pIdx < pathable.length; pIdx++) {
        var pTile = pathable[pIdx];
        if (pTile.discovered || pTile.isObstacle) continue;
        if (this.distance_from_general(pTile) >= 1000) continue;
        var d = map.euclidDist(targetX, targetY, pTile.x, pTile.y);
        if (d < bestDist) { bestDist = d; best = pTile; }
      }
      if (best) approx2[3] = best;
    }

    this.generalApproximations = this.generalApproximations;

    var oldTgPlayer = this.targetPlayer;
    this.targetPlayer = this._calculate_target_player_considering_dead_current_target();
    this.opponent_tracker.targetPlayer = this.targetPlayer;
    this.targetPlayerObj = map.players[this.targetPlayer];

    if (this.targetPlayer !== oldTgPlayer) {
      this._reset_all_in_state_after_target_player_change(oldTgPlayer, this.targetPlayer);
      if (this.targetPlayer >= 0) {
        var scores = this.opponent_tracker.get_current_team_scores_by_player(this.targetPlayer);
        this._lastTargetPlayerCityCount = scores ? scores.cityCount : 0;
      }
    }
  };

  P._calculate_target_player_considering_dead_current_target = function () {
    var map = this._map;
    if (this.targetPlayer !== -1 && map.players[this.targetPlayer] && map.players[this.targetPlayer].dead) {
      var livingTeammate = this._get_living_teammate_for_dead_target_player(this.targetPlayer);
      if (livingTeammate !== -1) return livingTeammate;
    }
    return _call(this, 'BotTargeting', 'calculate_target_player', [this], this.targetPlayer === -1 ? -1 : this.targetPlayer);
  };

  P._get_living_teammate_for_dead_target_player = function (deadTargetPlayer) {
    var map = this._map;
    var targetTeam = map.team_ids_by_player_index[deadTargetPlayer];
    for (var i = 0; i < map.players.length; i++) {
      var p = map.players[i];
      if (!p || p.dead) continue;
      if (i === this.general.player()) continue;
      if (map.teammates && map.teammates.has(i)) continue;
      if (map.team_ids_by_player_index[i] === targetTeam) return i;
    }
    return -1;
  };

  P._reset_all_in_state_after_target_player_change = function (oldTargetPlayer, newTargetPlayer) {
    this.is_all_in_losing = false;
    this.all_in_losing_counter = 0;
    this.is_all_in_army_advantage = false;
    this.all_in_army_advantage_counter = 0;
    this.all_in_city_behind = false;
    if (this.win_condition_analyzer) {
      this.win_condition_analyzer.projected_loss_all_in_active = false;
      this.win_condition_analyzer.projected_loss_all_in_target = null;
      this.win_condition_analyzer.all_in_plan = null;
    }
    this.shortest_path_to_target_player = null;
    this.target_player_gather_path = null;
    this.target_player_gather_targets = new Set();
  };

  EK.Bot = Bot;
  EK.EklipZBot = Bot;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
