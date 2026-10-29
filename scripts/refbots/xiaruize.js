/*
 * XiaruizeBot 的 JS 移植（PK 对手）。
 *
 * 原版：E:\akcoco6de\_research\bots\xiaruizeBot.cpp（xiaruize0911，GPL-3.0，LocalGen-new
 *      官方标注 High 复杂度，多源战略搜索 O(kn²)）
 * 契约：scripts/refbots/README.md —— 每次 plan(view) = 一个 tick，返回一条动作。
 *
 * ---- 算法一句话总结 ----
 *
 * 多源候选（enumerateSources）：给自己每一格能动的堆打分（兵数×55 + 未知邻格×55 +
 *   敌方邻格×95 - 到将军距离×4 + 兵力优势 120 - 将军 -5000 - 空城 -1200 + 上步落点
 *   350），排序取前 6 个当「出兵源」。这是它和 gc/szly「只挑一个最厚的堆」的根本区别：
 *   同一回合里 6 个源各建一张路线图，全局比价，谁的第一步最划算就走谁。
 *
 * 路线估价（buildPathMap + enterCost）：从每个源跑 Dijkstra，边长 = 12（聚会模式 8）
 *   + 沼泽 +70/+120 + 城 +18/+25 + 沙漠 +4 - 己方兵 6/4 + 中立兵×5/8 + 敌方兵×10/16
 *   + 敌方 40/90 + 没见过的格子 +8。所以「路费」里同时含了距离和吃下去的成本，
 *   兵堆厚的格子自己会变成便宜的路。
 *
 * 评分函数（evaluateTargetValue）：按目标的归属/地形给底分——
 *   敌将 1e9 - 兵×200 / 敌方城 32000 - 兵×60 / 敌方地 7000 - 兵×20 + 敌邻×260
 *   未探明 2500 + 未知邻×140 / 中立城 15000 - 兵×50 / 中立地 1400 - 兵×10 + 未知邻×90
 *   ——再叠加：开局扣城分、目标粘性（lastStrategicTarget +1800）、1v1 时对
 *   「预测敌将位置」的距离加成（enemyHint，3600 - 距离×240，猜中再 +2200）、
 *   减去整条路费、兵不够再扣 5000+、第一步踩不动直接 -Inf、出将军扣 2600、
 *   贴着将军往外走扣 900、第一步陷进敌方火力 -1800-…
 *
 * 敌将预测（updateGeneralPredictions）：见过就定死（heat 1e12）；没见过就在
 * 「看不见 + 可通行 + 不是城 + 离自己将军 ≥8」的格子上维持一张热度图，
 * 每回合 ×0.987 衰减，看到敌方领土就在其 6 格内按 14 - 2×距离 加热——
 * 也就是「敌兵出现的地方附近更可能有他的将」。这是它敢在迷雾里长途奔袭的依据。
 *
 * ---- 移植取舍（都做了等价替换，没有删逻辑）----
 *
 * 1. 原版一次 requestMove 只 push 一条 Move（每个分支都 return），所以不需要
 *    moveQueue；plan() 直接返回那一条。
 * 2. 原版 halfTurn 每个 tick +1、fullTurn 每 2 个 tick +1；本框架一次 plan 就是一个
 *    显示回合，所以 this.turn 每 plan +1 当 fullTurn 用（否则 opening 阈值会被拉长一倍）。
 * 3. rank 表拿不到：alive 用「见过他的地/将，且那个格子还没被我拿下」推，1v1 恒为
 *    1 个活敌人 → duelMode 恒真（原版在有 rank 的 1v1 里也是这个状态）。
 *    chooseCrowdedSkirmishMove 里用 rank 算的 myArmy/bestEnemyArmy 随该函数一起没移植。
 * 4. 原版 rng 声明了 std::mt19937 但整个文件一次都没用过——全流程确定性，所以本移植
 *    不用 rng（留着构造参数满足契约，同 seed 必然同结果）。
 * 5. 迷雾：TileView 的 visible/type/occupier/army 直接映射成 curType/memTerrain/
 *    memOcc/memArmy 四个数组；「看见就记、看不见就按 lastSeenTurn 衰减」照搬。
 *    障碍判定 = curType/memTerrain 是 MOUNTAIN 或 OBSTACLE（视图里 owner -4 的
 *    雾中障碍正好落成 OBSTACLE，owner -2 是可见的山）。
 * 6. 没移植的两个死分支：chooseCrowdedOpeningMove / chooseCrowdedSkirmishMove。
 *    触发条件 crowded(≤60 格/人) 且 aliveEnemies≥4，20x20 1v1（200 格/人）恒不成立，
 *    原版里这两段永远不会进；移过来只会变成没跑过的代码，所以只保留 crowded 标志。
 *    takeHalf（走一半）只出现在 chooseCrowdedSkirmishMove 里，故本移植 split 恒 false。
 * 7. 原版 defenseMode 算出来但从没传给任何函数（传的是 forceDefense），保留同样行为。
 * 8. gatherToward 里 firstStepOnPath(gatherPath, focus, from) 原版返回的是「focus 的
 *    邻格」而不是「from 的邻格」，只有 from 本来就贴着 focus 时才是一条合法走子。
 *    这里加了邻接检查（原版会把非邻格的 Move 交给引擎，被丢弃 = 白掉一个回合）。
 * 9. 地形 SWAMP/DESERT/LOOKOUT/OBSERVATORY 在本引擎不存在，打分分支留着但走不到。
 *
 * 坐标：原版 1-based Coord(i,j)，i 行 j 列；本框架 index = (i-1)*w + (j-1)。
 */
'use strict';

var TILE = {
  GENERAL: 0,
  BLANK: 1,
  MOUNTAIN: 2,
  CITY: 3,
  SWAMP: 4,
  DESERT: 5,
  LOOKOUT: 6,
  OBSERVATORY: 7,
  OBSTACLE: 8,
  CAPTURED_GENERAL: 9
};

var T_EMPTY = -1;
var T_FOG = -3;
var T_FOG_OBSTACLE = -4;

var KINF = 1e9;
var NEG_INF = -1e15;

function isImpassable(type) {
  return type === TILE.MOUNTAIN || type === TILE.LOOKOUT || type === TILE.OBSERVATORY;
}

function XiaruizeBot(rng) {
  // 原版的 mt19937 一次都没被调用：全流程确定性。这里留着只为满足构造契约。
  this.rng = rng;
  this.inited = false;
  this.turn = 0; // 原版 fullTurn
  this.me = -1;
  this.myGeneral = -1;
  this.lastMoveFrom = -1;
  this.lastMoveTo = -1;
  this.lastStrategicTarget = -1;
  this.knownGenerals = [-1, -1];
  this.aliveEnemies = 0;
  this.duelEnemy = -1;
  this.w = 0;
  this.h = 0;
  this.n = 0;
  this.mapArea = 0;
  // 二叉堆（Dijkstra 用），跨调用复用
  this.hk = [];
  this.hv = [];
  this.hs = 0;
  this.popKey = 0;
}

XiaruizeBot.prototype.init = function (w, h) {
  var n = w * h;
  this.w = w;
  this.h = h;
  this.n = n;
  this.mapArea = n;

  // 四邻里表。顺序照抄原版 kDirs = {(-1,0),(0,-1),(1,0),(0,1)} 即「上、左、下、右」：
  // 打分并列时先到者胜，顺序一变同 seed 的走法就跟着变。
  this.nbHead = new Int32Array(n + 1);
  this.nbList = new Int32Array(n * 4);
  var c = 0;
  for (var i = 0; i < n; i++) {
    this.nbHead[i] = c;
    var r = (i / w) | 0;
    var col = i - r * w;
    if (r > 0) this.nbList[c++] = i - w;
    if (col > 0) this.nbList[c++] = i - 1;
    if (r < h - 1) this.nbList[c++] = i + w;
    if (col < w - 1) this.nbList[c++] = i + 1;
  }
  this.nbHead[n] = c;

  this.memTerrain = new Int8Array(n).fill(TILE.BLANK);
  this.memOcc = new Int16Array(n).fill(T_EMPTY);
  this.memArmy = new Int32Array(n);
  this.seen = new Uint8Array(n);
  this.vis = new Uint8Array(n);
  this.lastSeen = new Int32Array(n).fill(-1);
  this.curType = new Int8Array(n).fill(TILE.BLANK);
  this.genFlag = new Uint8Array(n);
  this.cityFlag = new Uint8Array(n);

  this.unknownAdj = new Int32Array(n);
  this.enemyAdj = new Int32Array(n);
  this.enemyPressure = new Int32Array(n);
  this.friendlyPressure = new Int32Array(n);
  this.generalDist = new Int32Array(n);

  this.pDist = new Int32Array(n);
  this.pParent = new Int32Array(n);
  this.pFirst = new Int32Array(n);
  this.chHead = new Int32Array(n);
  this.chNext = new Int32Array(n);
  this.stack = new Int32Array(n);

  this.predScore = [new Float64Array(n), new Float64Array(n)];
  this.predMask = [new Uint8Array(n), new Uint8Array(n)];

  this.inited = true;
};

/* ---------------- 基础判定 ---------------- */

XiaruizeBot.prototype.isEnemy = function (o) {
  return o >= 0 && o !== this.me;
};

XiaruizeBot.prototype.isFriendly = function (o) {
  return o >= 0 && o === this.me;
};

XiaruizeBot.prototype.rowOf = function (i) {
  return (i / this.w) | 0;
};

XiaruizeBot.prototype.colOf = function (i) {
  return i - ((i / this.w) | 0) * this.w;
};

XiaruizeBot.prototype.manhattan = function (a, b) {
  if (a < 0 || b < 0) return 1 << 28;
  var wa = this.w;
  var ra = (a / wa) | 0;
  var rb = (b / wa) | 0;
  return Math.abs(ra - rb) + Math.abs(a - ra * wa - (b - rb * wa));
};

/* 能走进去吗：原版 passableForMove 看的是「当前 TileView」，记忆不参与 */
XiaruizeBot.prototype.passableForMove = function (i) {
  if (i < 0 || i >= this.n) return false;
  var t = this.curType[i];
  return !isImpassable(t) && t !== TILE.OBSTACLE;
};

/* 规划用：原版 passableForPlan 用 terrainAt()，也就是「看见的优先，否则用记忆」 */
XiaruizeBot.prototype.passableForPlan = function (i) {
  if (i < 0 || i >= this.n) return false;
  var t = this.memTerrain[i];
  return !isImpassable(t) && t !== TILE.OBSTACLE;
};

XiaruizeBot.prototype.adjacent = function (a, b) {
  if (a < 0 || b < 0 || a === b) return false;
  var h0 = this.nbHead[a];
  var h1 = this.nbHead[a + 1];
  for (var k = h0; k < h1; k++) if (this.nbList[k] === b) return true;
  return false;
};

/* ---------------- 记忆 ---------------- */

XiaruizeBot.prototype.updateMemory = function (view) {
  var n = this.n;
  var me = this.me;
  var owner = view.owner;
  var armies = view.armies;
  var cities = view.cities;
  var gens = view.generals;
  var genLen = gens ? gens.length : 0;
  var denseGen = genLen === n; // smoke 的探针用 [g0,g1]，真实引擎给的是逐格 flags

  var myGeneral = -1;
  var g0 = view.general;
  if (typeof g0 === 'number' && g0 >= 0 && g0 < n) myGeneral = g0;

  for (var i = 0; i < n; i++) {
    var g = 0;
    if (denseGen) {
      g = gens[i] ? 1 : 0;
    } else if (genLen >= 2 && (gens[0] === i || gens[1] === i)) {
      g = 1;
    }
    this.genFlag[i] = g;
    this.cityFlag[i] = cities && cities[i] ? 1 : 0;

    var o = owner[i];
    // 迷雾是真实的：-3 是没见过的空地，-4 是没见过的障碍（山或城，分不出来）
    var visible = o !== T_FOG && o !== T_FOG_OBSTACLE;
    this.vis[i] = visible ? 1 : 0;

    if (visible) {
      var type;
      // owner -2 就是看得见的山；迷雾里的山/城在视图里一律是 -4（不可见），走不到这里
      if (o === -2) type = TILE.MOUNTAIN;
      else if (g && o >= 0) type = TILE.GENERAL;
      else if (this.cityFlag[i]) type = TILE.CITY;
      else type = TILE.BLANK;

      this.curType[i] = type;
      this.seen[i] = 1;
      this.memTerrain[i] = type;
      this.memOcc[i] = o;
      this.memArmy[i] = armies[i];
      this.lastSeen[i] = this.turn;

      if (type === TILE.GENERAL) {
        if (o === me) myGeneral = i;
        else if (o >= 0 && o < 2) this.knownGenerals[o] = i;
      }
    } else {
      this.curType[i] = o === T_FOG_OBSTACLE ? TILE.OBSTACLE : TILE.BLANK;
      if (!this.seen[i]) {
        this.memTerrain[i] = this.curType[i];
        this.memOcc[i] = T_EMPTY;
        this.memArmy[i] = 0;
      } else {
        // 原版的「遗忘」：敌方兵每回合按未知时长衰减，14 回合后连归属都忘掉
        var stale = this.turn - this.lastSeen[i];
        if (stale < 0) stale = 0;
        var mo = this.memOcc[i];
        if (mo >= 0 && mo !== me) {
          if (stale > 0 && this.memArmy[i] > 0) {
            this.memArmy[i] = Math.max(0, this.memArmy[i] - ((stale / 2) | 0));
          }
          if (stale > 14) this.memOcc[i] = T_EMPTY;
        }
      }
    }
  }
  this.myGeneral = myGeneral;
};

XiaruizeBot.prototype.opponentDead = function (view, opp) {
  var g = this.knownGenerals[opp];
  // 见过他的将，现在这一格归我了 —— 1v1 里没有别的死亡信号可靠
  return g >= 0 && view.owner[g] === this.me;
};

/* ---------------- 敌将预测 ---------------- */

XiaruizeBot.prototype.reinforceGeneralNeighborhood = function (player, anchor, base, maxDist) {
  if (player < 0 || player > 1 || player === this.me) return;
  var heat = this.predScore[player];
  var mask = this.predMask[player];
  var mg = this.myGeneral;
  for (var i = 0; i < this.n; i++) {
    var d = this.manhattan(i, anchor);
    if (d > maxDist) continue;
    if (!this.passableForPlan(i) || this.memTerrain[i] === TILE.CITY) continue;
    if (this.vis[i]) continue;
    if (mg >= 0 && this.manhattan(i, mg) < 8) continue;
    mask[i] = 1;
    var gain = base - d * 2.0;
    if (gain > 0) heat[i] += gain;
  }
};

XiaruizeBot.prototype.updateGeneralPredictions = function () {
  var n = this.n;
  var me = this.me;
  var mg = this.myGeneral;
  for (var p = 0; p < 2; p++) {
    if (p === me) continue;
    var heat = this.predScore[p];
    var mask = this.predMask[p];
    var kg = this.knownGenerals[p];
    if (kg >= 0) {
      heat.fill(0);
      mask.fill(0);
      heat[kg] = 1e12;
      mask[kg] = 1;
      continue;
    }
    for (var i = 0; i < n; i++) heat[i] *= 0.987;
    for (var j = 0; j < n; j++) {
      var valid =
        this.passableForPlan(j) &&
        this.memTerrain[j] !== TILE.CITY &&
        !this.vis[j] &&
        (mg < 0 || this.manhattan(j, mg) >= 8);
      mask[j] = valid ? 1 : 0;
      if (!valid) heat[j] = 0.0;
    }
  }

  for (var k = 0; k < n; k++) {
    if (this.vis[k] && this.isEnemy(this.memOcc[k])) {
      this.reinforceGeneralNeighborhood(this.memOcc[k], k, 14.0, 6);
      continue;
    }
    if (!this.vis[k] && this.isEnemy(this.memOcc[k]) && this.turn - this.lastSeen[k] <= 4) {
      this.reinforceGeneralNeighborhood(this.memOcc[k], k, 8.0, 4);
    }
  }
};

XiaruizeBot.prototype.choosePredictedGeneral = function (player) {
  if (player < 0 || player > 1 || player === this.me) return -1;
  var kg = this.knownGenerals[player];
  if (kg >= 0) return kg;
  var heat = this.predScore[player];
  var mask = this.predMask[player];
  var bestScore = 0.0;
  var best = -1;
  for (var i = 0; i < this.n; i++) {
    if (!mask[i]) continue;
    if (heat[i] <= bestScore) continue;
    bestScore = heat[i];
    best = i;
  }
  return best;
};

/* ---------------- 各种全图统计 ---------------- */

XiaruizeBot.prototype.computeBorderStats = function () {
  var n = this.n;
  var unknownAdj = this.unknownAdj;
  var enemyAdj = this.enemyAdj;
  unknownAdj.fill(0);
  enemyAdj.fill(0);
  for (var i = 0; i < n; i++) {
    var h0 = this.nbHead[i];
    var h1 = this.nbHead[i + 1];
    var u = 0;
    var e = 0;
    for (var k = h0; k < h1; k++) {
      var nb = this.nbList[k];
      if (!this.seen[nb] && this.curType[nb] !== TILE.OBSTACLE) u++;
      if (this.isEnemy(this.memOcc[nb])) e++;
    }
    unknownAdj[i] = u;
    enemyAdj[i] = e;
  }
};

/* 火力图：把每个可见堆的兵摊到半径内，靠近自己越值钱 */
XiaruizeBot.prototype.computePressure = function (enemySide, out) {
  var n = this.n;
  var w = this.w;
  var h = this.h;
  var me = this.me;
  out.fill(0);
  var radius = enemySide ? 5 : 4;
  var cap = enemySide ? 100 : 120;
  var dec = enemySide ? 14 : 12;
  for (var i = 0; i < n; i++) {
    if (!this.vis[i]) continue;
    var o = this.memOcc[i];
    var matches = enemySide ? this.isEnemy(o) : o === me;
    if (!matches) continue;
    var power = this.memArmy[i];
    if (power > cap) power = cap;
    if (power <= 0) continue;
    var r0 = (i / w) | 0;
    var c0 = i - r0 * w;
    for (var dx = -radius; dx <= radius; dx++) {
      var rr = r0 + dx;
      if (rr < 0 || rr >= h) continue;
      var base = rr * w;
      var adx = dx < 0 ? -dx : dx;
      for (var dy = -radius; dy <= radius; dy++) {
        var cc = c0 + dy;
        if (cc < 0 || cc >= w) continue;
        var ady = dy < 0 ? -dy : dy;
        var d = adx + ady;
        if (d > radius) continue;
        var gain = power - d * dec;
        if (gain > 0) out[base + cc] += gain;
      }
    }
  }
};

XiaruizeBot.prototype.computeGeneralDist = function () {
  var n = this.n;
  var dist = this.generalDist;
  dist.fill(KINF);
  if (this.myGeneral < 0) return;
  var q = this.stack; // 复用：BFS 队列不会超过 n
  var qh = 0;
  var qt = 0;
  dist[this.myGeneral] = 0;
  q[qt++] = this.myGeneral;
  while (qh < qt) {
    var cur = q[qh++];
    var cd = dist[cur] + 1;
    var h0 = this.nbHead[cur];
    var h1 = this.nbHead[cur + 1];
    for (var k = h0; k < h1; k++) {
      var nx = this.nbList[k];
      if (!this.passableForPlan(nx)) continue;
      if (dist[nx] <= cd) continue;
      dist[nx] = cd;
      q[qt++] = nx;
    }
  }
};

XiaruizeBot.prototype.assessGeneralThreat = function () {
  var out = { present: false, source: -1, army: 0, dist: 1 << 28 };
  var mg = this.myGeneral;
  if (mg < 0) return out;
  for (var i = 0; i < this.n; i++) {
    if (!this.vis[i] || !this.isEnemy(this.memOcc[i])) continue;
    var d = this.manhattan(i, mg);
    if (d > 5) continue;
    if (!out.present || d < out.dist || (d === out.dist && this.memArmy[i] > out.army)) {
      out.present = true;
      out.source = i;
      out.army = this.memArmy[i];
      out.dist = d;
    }
  }
  return out;
};

/* ---------------- 路线估价 ---------------- */

XiaruizeBot.prototype.enterCost = function (i, gatherMode) {
  var terrain = this.memTerrain[i];
  var occ = this.memOcc[i];
  var army = this.memArmy[i];
  var cost = gatherMode ? 8 : 12;
  if (terrain === TILE.SWAMP) cost += gatherMode ? 120 : 70;
  if (terrain === TILE.CITY) cost += gatherMode ? 25 : 18;
  if (terrain === TILE.DESERT) cost += 4;
  if (this.isFriendly(occ)) {
    cost -= Math.min(army, gatherMode ? 4 : 6);
  } else if (occ === T_EMPTY) {
    cost += army * (gatherMode ? 8 : 5);
  } else if (this.isEnemy(occ)) {
    cost += army * (gatherMode ? 16 : 10) + (gatherMode ? 90 : 40);
  }
  if (!this.vis[i] && !this.seen[i]) cost += 8;
  if (cost < 1) cost = 1;
  return cost;
};

XiaruizeBot.prototype.heapPush = function (key, val) {
  var i = this.hs;
  this.hk[i] = key;
  this.hv[i] = val;
  this.hs = i + 1;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (this.hk[p] <= this.hk[i]) break;
    var tk = this.hk[p];
    var tv = this.hv[p];
    this.hk[p] = this.hk[i];
    this.hv[p] = this.hv[i];
    this.hk[i] = tk;
    this.hv[i] = tv;
    i = p;
  }
};

XiaruizeBot.prototype.heapPop = function () {
  var key = this.hk[0];
  var val = this.hv[0];
  var last = --this.hs;
  if (last > 0) {
    this.hk[0] = this.hk[last];
    this.hv[0] = this.hv[last];
    var i = 0;
    for (;;) {
      var l = i * 2 + 1;
      var r = l + 1;
      var m = i;
      if (l < last && this.hk[l] < this.hk[m]) m = l;
      if (r < last && this.hk[r] < this.hk[m]) m = r;
      if (m === i) break;
      var tk = this.hk[m];
      var tv = this.hv[m];
      this.hk[m] = this.hk[i];
      this.hv[m] = this.hv[i];
      this.hk[i] = tk;
      this.hv[i] = tv;
      i = m;
    }
  }
  this.popKey = key;
  return val;
};

XiaruizeBot.prototype.buildPathMap = function (start, gatherMode) {
  var dist = this.pDist;
  var parent = this.pParent;
  dist.fill(KINF);
  parent.fill(-1);
  if (start < 0 || start >= this.n || !this.passableForPlan(start)) return;
  dist[start] = 0;
  this.hs = 0;
  this.heapPush(0, start);
  while (this.hs > 0) {
    var cur = this.heapPop();
    if (this.popKey !== dist[cur]) continue; // 堆里的旧价，跳过
    var cd = this.popKey;
    var h0 = this.nbHead[cur];
    var h1 = this.nbHead[cur + 1];
    for (var k = h0; k < h1; k++) {
      var nx = this.nbList[k];
      if (!this.passableForPlan(nx)) continue;
      var nd = cd + this.enterCost(nx, gatherMode);
      if (nd >= dist[nx]) continue;
      dist[nx] = nd;
      parent[nx] = cur;
      this.heapPush(nd, nx);
    }
  }
};

/*
 * firstStepOnPath(path, start, x) 一次算全表：parent 树里 x 所属的「start 的子节点」。
 * 原版对每个目标单独爬链，这里 O(n) 铺一遍，否则 6 源 × 400 目标 × 400 步太贵。
 */
XiaruizeBot.prototype.buildFirstSteps = function (start) {
  var n = this.n;
  var fs = this.pFirst;
  fs.fill(-1);
  if (start < 0 || start >= n || this.pDist[start] !== 0) return;
  var parent = this.pParent;
  var chHead = this.chHead;
  var chNext = this.chNext;
  chHead.fill(-1);
  for (var i = 0; i < n; i++) {
    var p = parent[i];
    if (p < 0) continue;
    chNext[i] = chHead[p];
    chHead[p] = i;
  }
  fs[start] = start;
  var st = this.stack;
  var top = 0;
  for (var c = chHead[start]; c >= 0; c = chNext[c]) {
    fs[c] = c;
    st[top++] = c;
    while (top > 0) {
      var cur = st[--top];
      var f = fs[cur];
      for (var d = chHead[cur]; d >= 0; d = chNext[d]) {
        fs[d] = f;
        st[top++] = d;
      }
    }
  }
};

/* ---------------- 战术分支 ---------------- */

XiaruizeBot.prototype.chooseForcedWinMove = function () {
  var me = this.me;
  var bestScore = NEG_INF;
  var bestFrom = -1;
  var bestTo = -1;
  for (var i = 0; i < this.n; i++) {
    if (this.memOcc[i] !== me || this.memArmy[i] <= 1) continue;
    var h0 = this.nbHead[i];
    var h1 = this.nbHead[i + 1];
    for (var k = h0; k < h1; k++) {
      var to = this.nbList[k];
      if (!this.passableForMove(to)) continue;
      if (!this.vis[to] || this.curType[to] !== TILE.GENERAL) continue;
      if (!this.isEnemy(this.memOcc[to])) continue;
      if (this.memArmy[i] - 1 <= this.memArmy[to]) continue;
      var score = 1000000000 + (this.memArmy[i] - 1 - this.memArmy[to]);
      if (score > bestScore) {
        bestScore = score;
        bestFrom = i;
        bestTo = to;
      }
    }
  }
  if (bestFrom < 0) return null;
  return { from: bestFrom, to: bestTo, split: false };
};

XiaruizeBot.prototype.chooseImmediateTacticalMove = function (crowded) {
  var me = this.me;
  var bestScore = NEG_INF;
  var bestFrom = -1;
  var bestTo = -1;
  for (var i = 0; i < this.n; i++) {
    if (this.memOcc[i] !== me || this.memArmy[i] <= 1) continue;
    var h0 = this.nbHead[i];
    var h1 = this.nbHead[i + 1];
    for (var k = h0; k < h1; k++) {
      var to = this.nbList[k];
      if (!this.passableForMove(to)) continue;
      var toOcc = this.memOcc[to];
      if (toOcc === me) continue;
      var score = NEG_INF;
      var moved = this.memArmy[i] - 1;
      if (this.vis[to]) {
        var tType = this.curType[to];
        var dArmy = this.memArmy[to];
        if (tType === TILE.GENERAL && this.isEnemy(toOcc) && moved > dArmy) {
          score = 1000000000 + moved - dArmy;
        } else if (tType === TILE.CITY && moved > dArmy) {
          score = 200000 + moved - dArmy;
          if (this.isEnemy(toOcc)) score += 150000;
        } else if (this.isEnemy(toOcc) && moved > dArmy + (crowded ? 1 : 2)) {
          score = 50000 + (moved - dArmy) * 20 + (crowded ? 2000 : 0);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestFrom = i;
        bestTo = to;
      }
    }
  }
  if (bestScore < 30000) return null;
  return { from: bestFrom, to: bestTo, split: false };
};

XiaruizeBot.prototype.chooseDefenseMove = function (threat, forceDefense) {
  var me = this.me;
  var mg = this.myGeneral;
  if (mg < 0) return null;
  if (!forceDefense && this.enemyPressure[mg] <= this.friendlyPressure[mg] + 30) return null;

  var bestScore = NEG_INF;
  var bestFrom = -1;
  var bestTo = -1;
  for (var i = 0; i < this.n; i++) {
    if (this.memOcc[i] !== me || this.memArmy[i] <= 1) continue;
    var h0 = this.nbHead[i];
    var h1 = this.nbHead[i + 1];
    for (var k = h0; k < h1; k++) {
      var to = this.nbList[k];
      if (!this.passableForMove(to)) continue;
      var score = 0;
      if (this.generalDist[to] < this.generalDist[i]) score += 700;
      if (to === mg) score += 1400;
      if (i === mg) score -= 4500;
      score += this.enemyPressure[to] - this.enemyPressure[i];
      score -= (this.friendlyPressure[i] / 6) | 0;
      if (threat.present) {
        var fd = this.manhattan(i, threat.source);
        var td = this.manhattan(to, threat.source);
        if (td < fd) score += 450;
        if (td <= 1) score += 300;
      }
      if (this.vis[to] && this.isEnemy(this.memOcc[to]) && this.memArmy[i] - 1 > this.memArmy[to]) {
        score += 1800 + (this.memArmy[i] - 1 - this.memArmy[to]) * 20;
      }
      if (score > bestScore) {
        bestScore = score;
        bestFrom = i;
        bestTo = to;
      }
    }
  }
  if (bestScore > 0 && bestFrom >= 0) return { from: bestFrom, to: bestTo, split: false };
  return null;
};

/* ---------------- 多源战略搜索 ---------------- */

XiaruizeBot.prototype.enumerateSources = function (crowded) {
  var me = this.me;
  var n = this.n;
  var list = [];
  for (var i = 0; i < n; i++) {
    if (this.memOcc[i] !== me || this.memArmy[i] <= 1) continue;
    var score = this.memArmy[i] * 55;
    score += this.unknownAdj[i] * (crowded ? 18 : 55);
    score += this.enemyAdj[i] * (crowded ? 130 : 95);
    if (this.generalDist[i] < KINF) score -= this.generalDist[i] * 4;
    if (this.friendlyPressure[i] > this.enemyPressure[i]) score += 120;
    if (this.enemyPressure[i] > this.friendlyPressure[i] + this.memArmy[i] * 10) score -= 1800;
    if (i === this.myGeneral) score -= 5000;
    if (this.curType[i] === TILE.CITY && this.memArmy[i] <= 4) score -= 1200;
    if (i === this.lastMoveTo) score += 350;
    list.push([i, score]);
  }
  list.sort(function (a, b) {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0] - b[0];
  });
  var limit = crowded ? 4 : 6;
  var out = [];
  for (var q = 0; q < list.length && out.length < limit; q++) out.push(list[q][0]);
  return out;
};

XiaruizeBot.prototype.evaluateTargetValue = function (
  source,
  target,
  firstStep,
  crowded,
  huge,
  opening,
  enemyGeneralKnown,
  duelMode,
  enemyHint
) {
  if (firstStep < 0) return NEG_INF;
  if (this.pDist[target] >= KINF / 8) return NEG_INF;
  if (!this.passableForMove(firstStep)) return NEG_INF;

  var sourceArmy = this.memArmy[source];
  if (sourceArmy <= 1) return NEG_INF;

  var occupier = this.memOcc[target];
  var defense = this.memArmy[target];
  var terrain = this.memTerrain[target];
  var score = NEG_INF;

  if (this.isEnemy(occupier)) {
    if (this.knownGenerals[occupier] === target) {
      score = 1000000000 - defense * 200;
    } else if (terrain === TILE.CITY) {
      score = 32000 - defense * 60;
    } else {
      score = 7000 - defense * 20 + this.enemyAdj[target] * 260;
      if (duelMode) score += 1800;
    }
  } else if (occupier === T_EMPTY) {
    if (!this.seen[target] && this.curType[target] !== TILE.OBSTACLE) {
      score = 2500 + this.unknownAdj[target] * 140;
    } else if (terrain === TILE.CITY) {
      score = 15000 - defense * 50;
    } else if (terrain === TILE.SWAMP) {
      score = 80;
    } else if (terrain === TILE.DESERT) {
      score = 900 - defense * 4 + this.unknownAdj[target] * 35;
    } else {
      score = 1400 - defense * 10 + this.unknownAdj[target] * (opening ? 90 : 50);
    }
  }
  if (score <= NEG_INF / 8) return score;

  if (terrain === TILE.CITY) {
    if (opening) score -= crowded ? 1600 : 4200;
    if (duelMode && this.turn < 18) score -= this.mapArea >= 700 ? 3600 : 1800;
  }

  score += this.enemyAdj[target] * 70;
  score += this.unknownAdj[target] * (opening ? 16 : 8);
  if (target === this.lastStrategicTarget) score += duelMode ? 1800 : 600;
  if (huge && !enemyGeneralKnown) {
    var ch = (this.h + 1) >> 1;
    var cw = (this.w + 1) >> 1;
    var tr = (target / this.w) | 0;
    var tc = target - tr * this.w;
    score -= (Math.abs(tr - ch) + Math.abs(tc - cw)) * 3;
  }
  if (duelMode && enemyHint >= 0) {
    var hintDist = this.manhattan(target, enemyHint);
    var bonus = 3600 - hintDist * 240;
    score += bonus > 0 ? bonus : 0;
    if (target === enemyHint) score += 2200;
    if (occupier === T_EMPTY && this.seen[target] && terrain !== TILE.CITY && hintDist > 6) {
      score -= 1200;
    }
  }

  score -= this.pDist[target];

  var requiredArmy = defense + 1 + (terrain === TILE.CITY ? 2 : 0);
  if (sourceArmy <= requiredArmy && score < 100000000) {
    score -= 5000 + (requiredArmy - sourceArmy + 1) * 90;
  }

  if (this.vis[firstStep] && !this.isFriendly(this.memOcc[firstStep])) {
    if (
      sourceArmy - 1 <= this.memArmy[firstStep] &&
      !(this.memTerrain[firstStep] === TILE.GENERAL && this.isEnemy(this.memOcc[firstStep]))
    ) {
      return NEG_INF;
    }
  }

  if (source === this.myGeneral) score -= crowded ? 800 : 2600;
  if (this.curType[source] === TILE.CITY && sourceArmy <= 4) score -= 1800;
  if (this.generalDist[source] <= 2 && this.generalDist[firstStep] > this.generalDist[source]) {
    score -= 900;
  }
  if (
    this.enemyPressure[firstStep] >
    this.friendlyPressure[firstStep] + (sourceArmy - 1) * 6
  ) {
    score -=
      1800 +
      (this.enemyPressure[firstStep] -
        this.friendlyPressure[firstStep] -
        (sourceArmy - 1) * 6) *
        8;
  }
  if (source === this.lastMoveTo && firstStep === this.lastMoveFrom) score -= 400;
  if (this.memTerrain[firstStep] === TILE.SWAMP) score -= 1200;

  return score;
};

XiaruizeBot.prototype.chooseGlobalStrategicMove = function (
  crowded,
  huge,
  opening,
  enemyGeneralKnown,
  duelMode,
  enemyHint
) {
  var sources = this.enumerateSources(crowded);
  var bestScore = NEG_INF;
  var bestFrom = -1;
  var bestTo = -1;
  var bestTarget = -1;

  for (var s = 0; s < sources.length; s++) {
    var source = sources[s];
    this.buildPathMap(source, false);
    this.buildFirstSteps(source);
    var fs = this.pFirst;
    var pd = this.pDist;
    for (var t = 0; t < this.n; t++) {
      if (!this.passableForPlan(t)) continue;
      if (this.isFriendly(this.memOcc[t])) continue;
      var firstStep = fs[t];
      if (firstStep < 0 || firstStep === source) continue;
      if (pd[t] >= KINF / 8) continue;
      var score = this.evaluateTargetValue(
        source,
        t,
        firstStep,
        crowded,
        huge,
        opening,
        enemyGeneralKnown,
        duelMode,
        enemyHint
      );
      if (score > bestScore) {
        bestScore = score;
        bestFrom = source;
        bestTo = firstStep;
        bestTarget = t;
      }
    }
    if (pd[source] !== 0) break; // 路都建不起来就没必要再比
  }

  if (bestScore <= 0 || bestFrom < 0) return null;
  return { from: bestFrom, to: bestTo, split: false, target: bestTarget };
};

/* ---------------- 收兵 / 兜底 ---------------- */

XiaruizeBot.prototype.gatherToward = function (focus, crowded) {
  if (focus < 0) return null;
  this.buildPathMap(focus, true);
  this.buildFirstSteps(focus);
  var me = this.me;
  var bestScore = NEG_INF;
  var bestFrom = -1;
  var bestTo = -1;
  for (var i = 0; i < this.n; i++) {
    if (this.memOcc[i] !== me || this.memArmy[i] <= 1 || i === focus) continue;
    var step = this.pFirst[i];
    if (step < 0 || step === i || !this.passableForMove(step)) continue;
    if (!this.isFriendly(this.memOcc[step]) && step !== focus) continue;
    // 原版把 firstStepOnPath 的起点写成了 focus，所以 step 是 focus 的邻格；
    // 只有 i 本身贴着 focus 时才是一条真能走的子。这里挡掉非法的那部分。
    if (!this.adjacent(i, step)) continue;
    var score = this.memArmy[i] * 40;
    score -= this.pDist[i] * (crowded ? 4 : 2);
    if (step === focus) score += 600;
    if (i === this.myGeneral) score -= 2500;
    if (i === this.lastMoveTo && step === this.lastMoveFrom) score -= 250;
    if (score > bestScore) {
      bestScore = score;
      bestFrom = i;
      bestTo = step;
    }
  }
  if (bestScore > 0 && bestFrom >= 0) return { from: bestFrom, to: bestTo, split: false };
  return null;
};

XiaruizeBot.prototype.chooseFallback = function (focus, crowded) {
  var me = this.me;
  if (focus < 0) {
    var best = -1;
    var bestA = 0;
    for (var i = 0; i < this.n; i++) {
      if (this.memOcc[i] !== me || this.memArmy[i] <= 1) continue;
      if (this.memArmy[i] > bestA) {
        bestA = this.memArmy[i];
        best = i;
      }
    }
    focus = best;
  }
  if (focus < 0 || this.memArmy[focus] <= 1) return null;

  var srcArmy = this.memArmy[focus];
  var bestScore = NEG_INF;
  var bestTo = -1;
  var h0 = this.nbHead[focus];
  var h1 = this.nbHead[focus + 1];
  for (var k = h0; k < h1; k++) {
    var to = this.nbList[k];
    if (!this.passableForMove(to)) continue;
    var score = 0;
    if (!this.vis[to]) {
      score += 320;
    } else if (this.memOcc[to] === T_EMPTY) {
      if (srcArmy - 1 > this.memArmy[to]) {
        score += 220 - this.memArmy[to] * 10;
        if (this.curType[to] === TILE.DESERT) score += 30;
        if (this.curType[to] === TILE.SWAMP) score -= 500;
      }
    } else if (this.isFriendly(this.memOcc[to])) {
      score += crowded ? 40 : 80;
    } else if (srcArmy - 1 > this.memArmy[to]) {
      score += 550 + (srcArmy - 1 - this.memArmy[to]) * 20;
    }
    if (to === this.lastMoveFrom) score -= 120;
    if (score > bestScore) {
      bestScore = score;
      bestTo = to;
    }
  }
  if (bestScore > 0 && bestTo >= 0) return { from: focus, to: bestTo, split: false };
  return null;
};

/* ---------------- 一次 tick ---------------- */

XiaruizeBot.prototype.emit = function (mv) {
  if (!mv || mv.from < 0 || mv.to < 0 || mv.from === mv.to) return null;
  this.lastMoveFrom = mv.from;
  this.lastMoveTo = mv.to;
  return { from: mv.from, to: mv.to, split: !!mv.split };
};

XiaruizeBot.prototype.plan = function (view) {
  var w = view.w | 0;
  var h = view.h | 0;
  var n = w * h;
  if (!this.inited || this.w !== w || this.h !== h) this.init(w, h);

  this.turn++;
  this.me = view.me | 0;
  this.updateMemory(view);

  var me = this.me;
  var opp = 1 - me;
  this.aliveEnemies = 0;
  this.duelEnemy = -1;
  if (!this.opponentDead(view, opp)) {
    this.aliveEnemies = 1;
    this.duelEnemy = opp;
  }

  this.updateGeneralPredictions();

  var crowded = false; // 20x20 / 2 人 = 200 格/人，原版阈值 60，进不去
  var huge = this.mapArea >= 2500;
  var opening = this.turn < (crowded ? 10 : 14);

  this.computeBorderStats();
  this.computePressure(true, this.enemyPressure);
  this.computePressure(false, this.friendlyPressure);
  this.computeGeneralDist();
  var threat = this.assessGeneralThreat();

  var forceDefense = false; // crowded && playerCount>=6 才可能为真
  var mv = this.chooseForcedWinMove();
  if (mv) return this.emit(mv);

  mv = this.chooseDefenseMove(threat, forceDefense);
  if (mv) return this.emit(mv);

  var enemyGeneralKnown = false;
  for (var p = 0; p < 2; p++) {
    if (p === me) continue;
    if (this.knownGenerals[p] >= 0) enemyGeneralKnown = true;
  }
  var duelMode = this.aliveEnemies === 1;
  var enemyHint = -1;
  if (duelMode && this.duelEnemy >= 0) {
    enemyHint = this.choosePredictedGeneral(this.duelEnemy);
    if (enemyHint >= 0) enemyGeneralKnown = true;
  }

  mv = this.chooseImmediateTacticalMove(crowded);
  if (mv) return this.emit(mv);

  var strategic = this.chooseGlobalStrategicMove(
    crowded,
    huge,
    opening,
    enemyGeneralKnown,
    duelMode,
    enemyHint
  );
  if (strategic) {
    this.lastStrategicTarget = strategic.target;
    return this.emit(strategic);
  }

  var focus = -1;
  var sources = this.enumerateSources(crowded);
  if (sources.length) focus = sources[0];

  mv = this.gatherToward(focus, crowded);
  if (mv) return this.emit(mv);

  mv = this.chooseFallback(focus, crowded);
  if (mv) return this.emit(mv);

  return null;
};

module.exports = XiaruizeBot;
