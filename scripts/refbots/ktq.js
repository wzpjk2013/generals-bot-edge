/*
 * 移植自 LocalGen-new：src/bots/ktqBot.cpp（ktq1124298818 / GoodCoder666，GPL-3.0）
 * 原版路径：E:\akcoco6de\_research\bots\ktqBot.cpp（103 行）
 *
 * 原版算法（一句话）：盯住自己兵最多的一格 focus，每回合挑四邻里「最便宜」的一格推过去。
 * 权重是 pair<首要, 门槛> 的字典序最小者，优先级从高到低：
 *   自己 / 敌将 / 中立城 / 空地、雾里空地 / 自己的普通格（合兵）。
 * 门槛条件是「目标兵数 < 手上兵数」，不够就这回合不下（EMPTY）。
 *
 * 改了哪些地方（都是框架差异，不是改算法）：
 *   - 原版每 tick 只 push 一条 Move，这里 plan() 一次出一条，不需要 moveQueue。
 *   - 坐标：原版 1-based tileAt(x=行, y=列)；这里 index = x*w + y，四邻用预计算的 nbrs。
 *   - 障碍判定：原版 TILE_OBSTACLE 不算 isImpassableTile，所以 ktq 会把雾里的山/城当空地
 *     一头撞上去（引擎拒掉这一步，白白丢一回合）。移植版把 owner===-4（FOG_OBSTACLE）、
 *     -2（看得见的山）都当障碍跳过 —— 这是唯一的行为改动，不改的话它在真实迷雾下几乎不动。
 *   - 原版把 -1e15 / -1e18 塞进 army_t（int32 系列），实际是溢出后的垃圾值；这里按原意
 *     用 double，city/general 的优先级排序才真的是作者想表达的那个。
 *   - rank 拿不到，所以只用「目标兵数 < 手上兵数」这个门槛，和原版一致。
 *   - 不用 rng：原版这一步是纯确定的（同 rng 同结果，满足可复现要求）。
 */
'use strict';

/* 原版 delta 顺序：{{0,1},{1,0},{0,-1},{-1,0}}，(dx,dy) 里 x 是行、y 是列。
 * 权重比较是严格小于，同分取先扫到的那个，所以顺序必须和原版一致。 */
var DIR_X = [0, 1, 0, -1];
var DIR_Y = [1, 0, -1, 0];

var IMPASSABLE_OWNER = { '-2': 1, '-4': 1, '-5': 1, '-6': 1 };

/* arena.js 给的是逐格掩码，冒烟探针给的是 [g0, g1] 位置表，两种都要认 */
function isGeneralAt(view, i) {
  var g = view.generals;
  if (!g) return false;
  if (g.length === view.w * view.h) return g[i] === 1;
  return g.indexOf(i) >= 0;
}

module.exports = class KtqBot {
  constructor(rng) {
    this.rng = rng; // 原版不掷骰子；留着是为了和别的移植保持同一个构造签名
    this.focus = -1;
    this.n = -1;
    this.w = -1;
    this.nbrs = null;
  }

  _layout(w, h) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    var nbrs = new Int32Array(this.n * 4).fill(-1);
    for (var x = 0; x < h; x++) {
      for (var y = 0; y < w; y++) {
        var i = x * w + y;
        for (var k = 0; k < 4; k++) {
          var nx = x + DIR_X[k];
          var ny = y + DIR_Y[k];
          if (nx < 0 || nx >= h || ny < 0 || ny >= w) continue;
          nbrs[i * 4 + k] = nx * w + ny;
        }
      }
    }
    this.nbrs = nbrs;
  }

  /* 山 / 雾里的城山 / 瞭望塔 / 观测站：走不进去 */
  _blocked(view, i) {
    return IMPASSABLE_OWNER[view.owner[i]] === 1 || view.mountains[i] === 1;
  }

  plan(view) {
    var w = view.w;
    var h = view.h;
    if (this.w !== w || this.h !== h) this._layout(w, h);
    var n = this.n;
    var me = view.me;
    var i;

    /* focus 失效（被吃 / 兵不够动）就重选：兵最多且 > 1 的己方格。
     * 原版 determineMaxArmyPos 的 maxArmy 从 1 起步，所以兵只有 1 的格子选不上。 */
    if (this.focus < 0 || view.owner[this.focus] !== me || view.armies[this.focus] <= 1) {
      this.focus = -1;
      var maxArmy = 1;
      var pick = -1;
      for (i = 0; i < n; i++) {
        if (view.owner[i] !== me) continue;
        var a0 = view.armies[i];
        if (a0 > maxArmy) {
          maxArmy = a0;
          pick = i;
        }
      }
      if (pick < 0) return null;
      this.focus = pick;
    }

    var from = this.focus;
    var armyInHand = view.armies[from];
    var bestTarget = -1;
    var bestFirst = Infinity;
    var bestSecond = 0;

    for (var k = 0; k < 4; k++) {
      var to = this.nbrs[from * 4 + k];
      if (to < 0) continue;
      if (this._blocked(view, to)) continue;

      var o = view.owner[to] >= 0 ? view.owner[to] : -1; // 雾格当无主
      var army = view.armies[to];
      var first;
      var second;

      if (o === me) {
        first = -army;
        second = -army;
      } else if (view.cities[to] === 1) {
        // 看得见的中立/敌方城市：2*army - 1e15（原版的 -1e15 是 army_t 溢出，这里用 double）
        first = 2 * army - 1e15;
        second = army;
      } else if (isGeneralAt(view, to) && o >= 0) {
        // 看得见的敌将：最高优先（原版分支写在最后，但值最小）
        first = -1e18;
        second = army;
      } else {
        // 空地 / 雾里的空地 / 敌方普通格：army - 1e15
        first = army - 1e15;
        second = army;
      }

      if (second < armyInHand && (first < bestFirst || (first === bestFirst && second < bestSecond))) {
        bestFirst = first;
        bestSecond = second;
        bestTarget = to;
      }
    }

    if (bestTarget < 0) return null;
    // 原版是「先 push 再改 focus」：这一步走完，兵堆就落在了 bestTarget
    this.focus = bestTarget;
    return { from: from, to: bestTarget, split: false };
  }
};
