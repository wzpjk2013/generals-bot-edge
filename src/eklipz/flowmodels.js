/*
 * IterativeExpansion 的模型外壳（JS port）
 * 原版：E:\akcoco6de\_research\generals-bot-cs\BehaviorAlgorithms\IterativeExpansion.py
 *
 * 只搬被 FlowExpansion.py 引用的三个符号（其余是 legacy 迭代扩张路径，JS 侧走 flow 版本，
 * 搬过来没有任何调用者）：
 *   ITERATIVE_EXPANSION_EN_CAP_VAL   —— 常量 2.05（IterativeExpansion.py:36）
 *   FlowExpansionPlanOptionCollection —— get_expansion_options 的返回容器
 *   ArmyFlowExpanderLastRun          —— 上一轮的 flow 图统计，供对比/复用
 *
 * 依赖的 FlowGraphDebugStats 原版也在 IterativeExpansion.py 里（:129），
 * ArmyFlowExpanderLastRun 的两个字段就是这个类型，所以一并搬，没有别的用途。
 *
 * 为什么字段名和 Python 一模一样（snake_case）：flowexpansion.js 和 oracle 都按原名取值，
 * 改名等于两边各写一套映射表，一处漏改就是静默 0 值。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});
  var flow = (EK.flow = EK.flow || {});

  // FlowExpansion 用它当价值倍数（value_multiple），改这个数会直接改变出招
  var ITERATIVE_EXPANSION_EN_CAP_VAL = 2.05;

  // IterativeExpansion.py:129 FlowGraphDebugStats
  function FlowGraphDebugStats(redArmy, blueArmy, enemyGeneralBalance) {
    this.red_army_total = redArmy === undefined ? 0 : redArmy;
    this.blue_army_total = blueArmy === undefined ? 0 : blueArmy;
    this.enemy_general_balance = enemyGeneralBalance === undefined ? 0 : enemyGeneralBalance;
  }

  // 原版按 enemy_general_balance 的正负分 backpressure / sink 两种模式打印
  FlowGraphDebugStats.prototype.summary_line = function (label) {
    if (label === undefined) label = '';
    var mode = this.enemy_general_balance < 0 ? 'backpressure' : 'sink';
    return label + ': redArmy=' + this.red_army_total + ', blueArmy=' + this.blue_army_total +
      ', enGen' + mode + '=' + this.enemy_general_balance;
  };

  // IterativeExpansion.py:94 FlowExpansionPlanOptionCollection
  function FlowExpansionPlanOptionCollection() {
    this.expansion_options = [];
    this.total_turns = 0;
    this.total_econ = 0.0;
    this.total_en_caps = 0;
    this.total_neut_caps = 0;
    this.total_en_city_caps = 0;
    this.total_neut_city_caps = 0;
    this.total_gather_tiles = 0;
    this.total_gathered = 0;
    this.true_total_gathered = 0;
    this.total_en_army_capped = 0;
  }

  FlowExpansionPlanOptionCollection.prototype.toString = function () {
    var vt = this.total_econ / Math.max(1, this.total_turns);
    return 'turns=' + this.total_turns + ', econ=' + this.total_econ +
      ' (' + vt.toFixed(2) + 'vt), enCaps=' + this.total_en_caps +
      ', neutCaps=' + this.total_neut_caps + ', enCityCaps=' + this.total_en_city_caps +
      ', neutCityCaps=' + this.total_neut_city_caps + ', gatherTiles=' + this.total_gather_tiles +
      ', gathered=' + this.total_gathered + ', trueGathered=' + this.true_total_gathered +
      ', enArmyCapped=' + this.total_en_army_capped;
  };

  // IterativeExpansion.py:140 ArmyFlowExpanderLastRun
  function ArmyFlowExpanderLastRun() {
    this.flow_stats_no_neut = new FlowGraphDebugStats();
    this.flow_stats_inc_neut = new FlowGraphDebugStats();
  }

  EK.ITERATIVE_EXPANSION_EN_CAP_VAL = ITERATIVE_EXPANSION_EN_CAP_VAL;
  EK.FlowGraphDebugStats = FlowGraphDebugStats;
  EK.FlowExpansionPlanOptionCollection = FlowExpansionPlanOptionCollection;
  EK.ArmyFlowExpanderLastRun = ArmyFlowExpanderLastRun;

  // 同一份东西也挂在 EK.flow 下：flow 系列模块统一从 EK.flow 取，免得混着两个入口
  flow.ITERATIVE_EXPANSION_EN_CAP_VAL = ITERATIVE_EXPANSION_EN_CAP_VAL;
  flow.FlowGraphDebugStats = FlowGraphDebugStats;
  flow.FlowExpansionPlanOptionCollection = FlowExpansionPlanOptionCollection;
  flow.ArmyFlowExpanderLastRun = ArmyFlowExpanderLastRun;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
