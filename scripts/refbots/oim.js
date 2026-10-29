/*
 * 移植自 LocalGen-new src/bots/oimBot.cpp
 *   https://github.com/SZXC-WG/LocalGen-new/blob/master/src/bots/oimBot.cpp
 *   （oimasterkafuu and contributors，GPL-3.0-or-later，原文件 163284 字节）
 *
 * 算法一句话：这不是「挑一格目标再朝那儿推」，而是一台**记忆驱动的威胁/目标规划器**——
 *   1) 用粘性记忆（TileMemory）维护每格最后一次所见，并按产兵规则推演看不见的兵数，
 *      同时用"对手将军可能在哪儿"的概率场（predictedGeneralScore）猜敌将；
 *   2) 从每条可见敌格出发，在加权代价场上做**反向多源 Dijkstra**，找出"哪股敌人最先
 *      打到我的将军/核心城市、几步之后到"（analyzeThreat）；
 *   3) 生成一批目标候选（防御/攻城/吃兵/扩张/迷雾探索），每个候选再反向 Dijkstra 求
 *      出兵格与路线，按「够不够兵、路顺不顺、风险惩罚」打分，选最高（evaluateObjectivePlan）；
 *   4) 另有直接捕获、开局 rollout、决斗节奏、经济规划器四条快路径插在前面抢答；
 *   5) 所有出兵都过风险闸门（将军留兵、咽喉格、核心区压力），核心是"别为了扩张把将军送掉"。
 *
 * 本适配层做的事：
 *   - 原版 requestMove 里 push 一条 Move，引擎每 tick 取一条；这里 plan() = 一个 tick，
 *     直接返回那一条，所以不需要 queue（原版也只 push 一条）。
 *   - 原版 halfTurn/fullTurn 按 requestMove 调用计数；我们每回合被调用一次，
 *     所以 this.fullTurn 每次 plan 自增，产兵 tick 认为每回合都吃到（真值）。
 *   - rank（对手排名）拿不到：alive 按"1v1 未终局即都在场"处理，双方的兵力/地盘
 *     用**自己视野 + 记忆**估出来填回去（rankArmy/rankLand），这样原版那套
 *     hiddenReserve / conversionAdvantage / targetPlayerScore 才不至于全为 0。
 *   - 坐标：原版 1-based (x=行, y=列)，idx = x*W+y；我们是 row-major 的 i = 行*w + 列，
 *     四邻顺序照抄 kDirs = 上/左/下/右。
 *   - 地形：本图只有 平地 / 山 / 城 / 将军。原版的 SWAMP/DESERT/LOOKOUT/OBSERVATORY
 *     分支保持结构留着（走不到），迷雾格按原版 TileView::updateFrom 退化：
 *     FOG → BLANK，FOG_OBSTACLE → OBSTACLE（不可通行）。
 *
 * 简化清单（丢掉不影响走子主链的东西）：
 *   1. kEnableDecisionTrace 的全部 stderr 日志（traceDecision / traceCompetition / modeName）；
 *   2. RankItem 真的排名表 → 换成上面的视野+记忆估算（原版的 -delta 逻辑保留）；
 *   3. chooseDuelExpansionCaptureMove 整段（原版条件 mapArea()>=500，本图恒 400，永久死代码）；
 *   4. 沼泽衰减（evolveHiddenMemory 的 SWAMP 分支、各处 -swamp 惩罚）保留结构但不会触发；
 *   5. MoveType 只用到 MOVE_ARMY，投降/消息回调不移植；
 *   6. SearchWorkspace / ThreatWorkspace 的 stamp+activeStamp 复用机制 → 直接整表重置
 *      （N=400，fill 比 stamp 分支更快也更好读）；
 *   7. 原版 (height+2)*W 的 padding 数组 → 用 nbr 表挡边界，不需要哨兵行。
 *
 * 随机：原版这个 bot 是确定性的（没有 rand），所以 rng 只存不用。
 */
'use strict';

var BIG = 1e9;
var BIGD = 1e100;
var EPS = 1e-9;

/* 地形编码（对齐 tile_type_e 里我们会遇到的那几个） */
var TY_BLANK = 0;
var TY_CITY = 1;
var TY_GENERAL = 2;
var TY_OBSTACLE = 3; // 迷雾里的山/城：看不见，一律当障碍
var TY_MOUNTAIN = 4;

/* FocusMode */
var M_EXPAND = 0;
var M_ATTACK = 1;
var M_DEFEND = 2;
var M_CONVERT = 3;

var K_RECENT_EDGE_WINDOW = 16;
var K_PREDICTION_DECAY = 0.986;

/* 最小堆：键是整数代价（所有 step cost 都是整数，和原版一致） */
function MinHeap() {
  this.k = new Int32Array(1024);
  this.v = new Int32Array(1024);
  this.n = 0;
  this.lastKey = 0;
}
MinHeap.prototype.clear = function () {
  this.n = 0;
};
MinHeap.prototype.grow = function () {
  var k2 = new Int32Array(this.k.length * 2);
  var v2 = new Int32Array(this.v.length * 2);
  k2.set(this.k);
  v2.set(this.v);
  this.k = k2;
  this.v = v2;
};
MinHeap.prototype.push = function (key, val) {
  if (this.n >= this.k.length) this.grow();
  var k = this.k;
  var v = this.v;
  var i = this.n++;
  k[i] = key;
  v[i] = val;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (k[p] <= k[i]) break;
    var tk = k[p];
    k[p] = k[i];
    k[i] = tk;
    var tv = v[p];
    v[p] = v[i];
    v[i] = tv;
    i = p;
  }
};
/* 弹出最小键；键留在 this.lastKey（键是 int，够用，省一次打包） */
MinHeap.prototype.pop = function () {
  var k = this.k;
  var v = this.v;
  var topK = k[0];
  var topV = v[0];
  var last = --this.n;
  k[0] = k[last];
  v[0] = v[last];
  var i = 0;
  for (;;) {
    var l = 2 * i + 1;
    var r = l + 1;
    var m = i;
    if (l < last && k[l] < k[m]) m = l;
    if (r < last && k[r] < k[m]) m = r;
    if (m === i) break;
    var tk = k[m];
    k[m] = k[i];
    k[i] = tk;
    var tv = v[m];
    v[m] = v[i];
    v[i] = tv;
    i = m;
  }
  this.lastKey = topK;
  return topV;
};

/* 双精度键的最小堆（威胁场用，代价是 -bias/10.5 这种小数） */
function MinHeapD() {
  this.k = new Float64Array(1024);
  this.v = new Int32Array(1024);
  this.n = 0;
  this.lastKey = 0;
}
MinHeapD.prototype.clear = function () {
  this.n = 0;
};
MinHeapD.prototype.grow = function () {
  var k2 = new Float64Array(this.k.length * 2);
  var v2 = new Int32Array(this.v.length * 2);
  k2.set(this.k);
  v2.set(this.v);
  this.k = k2;
  this.v = v2;
};
MinHeapD.prototype.push = function (key, val) {
  if (this.n >= this.k.length) this.grow();
  var k = this.k;
  var v = this.v;
  var i = this.n++;
  k[i] = key;
  v[i] = val;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (k[p] <= k[i]) break;
    var tk = k[p];
    k[p] = k[i];
    k[i] = tk;
    var tv = v[p];
    v[p] = v[i];
    v[i] = tv;
    i = p;
  }
};
MinHeapD.prototype.pop = function () {
  var k = this.k;
  var v = this.v;
  var topK = k[0];
  var topV = v[0];
  var last = --this.n;
  k[0] = k[last];
  v[0] = v[last];
  var i = 0;
  for (;;) {
    var l = 2 * i + 1;
    var r = l + 1;
    var m = i;
    if (l < last && k[l] < k[m]) m = l;
    if (r < last && k[r] < k[m]) m = r;
    if (m === i) break;
    var tk = k[m];
    k[m] = k[i];
    k[i] = tk;
    var tv = v[m];
    v[m] = v[i];
    v[i] = tv;
    i = m;
  }
  this.lastKey = topK;
  return topV;
};

function OimAgent(rng) {
  this.rng = rng || function () {
    return 0.5;
  };
  this.inited = false;
  this.fullTurn = 0;
}

/* ---------------- 初始化 / 几何 ---------------- */

OimAgent.prototype.init = function (view) {
  var w = view.w;
  var h = view.h;
  var n = w * h;
  this.W = w;
  this.H = h;
  this.N = n;
  this.id = view.me;
  this.playerCnt = 2;

  // 行/列缓存：manhattan 是全程最热的调用，别在里面做除法和取模
  this.rowOf = new Int32Array(n);
  this.colOf = new Int32Array(n);

  // 四邻表：上/左/下/右，和原版 kDirs 顺序一致（顺序会影响同分时的择优）
  this.nbr = new Int32Array(n * 4);
  for (var i = 0; i < n; i++) {
    var r = (i / w) | 0;
    var c = i % w;
    this.rowOf[i] = r;
    this.colOf[i] = c;
    this.nbr[i * 4] = r > 0 ? i - w : -1;
    this.nbr[i * 4 + 1] = c > 0 ? i - 1 : -1;
    this.nbr[i * 4 + 2] = r < h - 1 ? i + w : -1;
    this.nbr[i * 4 + 3] = c < w - 1 ? i + 1 : -1;
  }

  // 本回合的实时视野（board.tileAt 的等价物）
  this.tVisible = new Uint8Array(n);
  this.tOcc = new Int16Array(n);
  this.tType = new Uint8Array(n);
  this.tArmy = new Int32Array(n);
  this.genMask = new Uint8Array(n);

  // 粘性记忆（这个 bot 的核心）
  this.memArmy = new Int32Array(n);
  this.memOcc = new Int16Array(n).fill(-9);
  this.memType = new Uint8Array(n);
  this.memLastSeen = new Int32Array(n).fill(-1);
  this.memEstTurn = new Int32Array(n).fill(-1);
  this.memEver = new Uint8Array(n);
  this.memVisible = new Uint8Array(n);

  // 每玩家的推测状态
  this.knownGeneral = new Int32Array(2).fill(-1);
  this.predScore = new Float64Array(2 * n);
  this.predScale = new Float64Array(2).fill(1);
  this.visibleEnemyCount = new Int32Array(2);
  this.visibleArmy = new Int32Array(2);
  this.newlyVisibleEnemy = new Int32Array(2);
  this.hiddenReserveEst = new Int32Array(2);
  this.hiddenReserveDelta = new Int32Array(2);
  this.cachedGuess = new Int32Array(2).fill(-1);
  this.cachedHasEvidence = new Uint8Array(2);
  this.rankArmy = new Int32Array(2);
  this.rankLand = new Int32Array(2);
  this.prevRankArmy = new Int32Array(2);
  this.prevRankLand = new Int32Array(2);
  this.playerArmyDelta = new Int32Array(2);
  this.playerLandDelta = new Int32Array(2);
  this.aliveById = new Uint8Array(2).fill(1);
  this.hasPrevRank = false;

  this.baseCandMask = new Uint8Array(n);
  this.baseCandList = [];

  // 局面图
  this.enemyPressure = new Float64Array(n);
  this.friendlyPressure = new Float64Array(n);
  this.reserveArmy = new Int32Array(n);
  this.pathFlow = new Int32Array(n);
  this.coreZone = new Uint8Array(n);
  this.choke = new Uint8Array(n);
  this.duelHeat = new Float64Array(n);
  this.distFromGeneral = new Int32Array(n).fill(BIG);
  this.generalPathParent = new Int32Array(n).fill(-1);
  this.generalBfsOrder = [];

  // 压力核（半径 0..6 的曼哈顿邻域偏移）
  this.kernels = [];
  for (var rr = 0; rr <= 6; rr++) {
    var list = [];
    for (var dr = -rr; dr <= rr; dr++) {
      var rem = rr - Math.abs(dr);
      for (var dc = -rem; dc <= rem; dc++) list.push(dr, dc, Math.abs(dr) + Math.abs(dc));
    }
    this.kernels.push(list);
  }

  // 搜索工作区
  this.fwd = this.makeWorkspace(n);
  this.rev = this.makeWorkspace(n);
  this.thrClose = this.makeThreatWorkspace(n);
  this.thrLimited = this.makeThreatWorkspace(n);
  this.thrPositive = this.makeThreatWorkspace(n);

  // 状态
  this.myGeneral = -1;
  this.currentObjective = -1;
  this.lockedObjective = -1;
  this.objectiveLockUntil = -1;
  this.currentTargetPlayer = -1;
  this.targetLockUntil = -1;
  this.openingTarget = -1;
  this.openingTargetUntil = -1;
  this.lastMoveFrom = -1;
  this.lastMoveTo = -1;
  this.recentEdges = [];
  this.recentEdgeCounts = new Map();

  // 决斗热力图的复用工作区（每回合 400 次小 BFS，不能每次新建数组）
  this.passDeg = new Int32Array(n);
  this.lepVal = new Float64Array(n);
  this.lepStamp = new Int32Array(n);
  this.turnStamp = 0;
  this._heatDist = new Int32Array(n);
  this._heatStamp = new Int32Array(n);
  this._heatQ = new Int32Array(n);
  this._heatTick = 0;

  this.friendlyTiles = [];
  this.frontierTiles = [];
  this.ownedCities = [];
  this.objectiveCandidates = [];

  this.cachedGeneralAdjacentThreat = 0;
  this.cachedGeneralLocalPressure = 0;
  this.cachedRelaxedGeneralOpening = false;

  this.inited = true;
};

OimAgent.prototype.makeWorkspace = function (n) {
  return {
    dist: new Int32Array(n).fill(BIG),
    parent: new Int32Array(n).fill(-1),
    first: new Int32Array(n).fill(-1),
    depth: new Int32Array(n).fill(BIG),
    lead: new Int32Array(n),
    heap: new MinHeap(),
    reachable: false
  };
};

OimAgent.prototype.makeThreatWorkspace = function (n) {
  return {
    cost: new Float64Array(n).fill(BIGD),
    rawDist: new Int32Array(n).fill(BIG),
    steps: new Int32Array(n).fill(BIG),
    seedIndex: new Int32Array(n).fill(-1),
    parent: new Int32Array(n).fill(-1),
    heap: new MinHeapD(),
    reachable: false
  };
};

/* ---------------- 视野读取 ---------------- */

OimAgent.prototype.readBoard = function (view) {
  var n = this.N;
  var w = this.W;
  var owner = view.owner;
  var armies = view.armies;
  var cities = view.cities;
  var mountains = view.mountains;
  var gm = this.genMask;
  var g = view.generals;
  gm.fill(0);
  var i;
  if (g && g.length === n) {
    for (i = 0; i < n; i++) if (g[i]) gm[i] = 1;
  } else if (g) {
    for (i = 0; i < g.length; i++) if (g[i] >= 0) gm[g[i]] = 1;
  }
  if (view.general !== undefined && view.general >= 0) gm[view.general] = 1;

  for (i = 0; i < n; i++) {
    var o = owner[i];
    if (o === -3) {
      // T.FOG：空白/沙漠/沼泽 —— 原版 TileView 看不见时类型保留成 BLANK
      this.tVisible[i] = 0;
      this.tOcc[i] = -1;
      this.tType[i] = TY_BLANK;
      this.tArmy[i] = 0;
    } else if (o === -4) {
      // T.FOG_OBSTACLE：山或城，分不出来 —— 一律按不可通行
      this.tVisible[i] = 0;
      this.tOcc[i] = -1;
      this.tType[i] = TY_OBSTACLE;
      this.tArmy[i] = 0;
    } else {
      this.tVisible[i] = 1;
      this.tOcc[i] = o; // >=0 是玩家，-1 是空地
      this.tArmy[i] = armies[i];
      if (cities[i]) this.tType[i] = TY_CITY;
      else if (o === -2 || mountains[i]) this.tType[i] = TY_MOUNTAIN;
      else if (gm[i]) this.tType[i] = TY_GENERAL;
      else this.tType[i] = TY_BLANK;
    }
  }
};

OimAgent.prototype.passableType = function (t) {
  return t !== TY_OBSTACLE && t !== TY_MOUNTAIN;
};

OimAgent.prototype.memPassable = function (i) {
  return this.passableType(this.memType[i]);
};

OimAgent.prototype.isFriendly = function (i) {
  return this.tOcc[i] === this.id;
};

OimAgent.prototype.isEnemy = function (i) {
  return this.tOcc[i] >= 0 && this.tOcc[i] !== this.id;
};

OimAgent.prototype.isEnemyOcc = function (p) {
  return p >= 0 && p !== this.id;
};

OimAgent.prototype.manhattan = function (a, b) {
  return Math.abs(this.rowOf[a] - this.rowOf[b]) + Math.abs(this.colOf[a] - this.colOf[b]);
};

/* 原版 centerDist：|x*2-(height+1)| + |y*2-(width+1)|，x 行 y 列 */
OimAgent.prototype.centerDist = function (i) {
  var r = this.rowOf[i] + 1;
  var c = this.colOf[i] + 1;
  return Math.abs(r * 2 - (this.H + 1)) + Math.abs(c * 2 - (this.W + 1));
};

OimAgent.prototype.estimatedArmyAt = function (i) {
  return this.tVisible[i] ? this.tArmy[i] : this.memArmy[i];
};

OimAgent.prototype.visibleOrRememberedOcc = function (i) {
  return this.tVisible[i] ? this.tOcc[i] : this.memOcc[i];
};

OimAgent.prototype.recentEnemyAt = function (i, maxAge) {
  if (maxAge === undefined) maxAge = 4;
  if (this.tVisible[i]) return false;
  var occ = this.memOcc[i];
  if (!(occ >= 0 && occ !== this.id)) return false;
  return this.memLastSeen[i] >= 0 && this.fullTurn - this.memLastSeen[i] <= maxAge;
};

OimAgent.prototype.duelMode = function () {
  // 1v1 且双方都在场
  var enemy = 0;
  for (var p = 0; p < this.playerCnt; p++) {
    if (p === this.id || !this.aliveById[p]) continue;
    enemy++;
  }
  return enemy <= 1;
};

OimAgent.prototype.intelWeight = function () {
  return this.duelMode() ? 1.0 : 0.0;
};

OimAgent.prototype.mapArea = function () {
  return this.H * this.W;
};

/* ---------------- 产兵时序 ---------------- */

OimAgent.prototype.upcomingMoveGetsGrowthTick = function () {
  // 框架里每一步都发生在"本回合产兵"之前，所以恒吃产兵 tick
  return true;
};

OimAgent.prototype.upcomingMoveGetsGlobalGrowthTick = function () {
  return this.upcomingMoveGetsGrowthTick() && this.fullTurn > 1 && this.fullTurn % 25 === 0;
};

OimAgent.prototype.turnsUntilNextGlobalGrowth = function () {
  var r = this.fullTurn % 25;
  return r === 0 ? 0 : 25 - r;
};

/* ---------------- 记忆 ---------------- */

OimAgent.prototype.evolveHiddenMemory = function (i) {
  if (!this.memEver[i] || this.memVisible[i] || this.memEstTurn[i] < 0) return;
  if (this.fullTurn <= this.memEstTurn[i]) return;
  var type = this.memType[i];
  for (var t = this.memEstTurn[i] + 1; t <= this.fullTurn; t++) {
    if (this.memOcc[i] < 0) break;
    if (type === TY_GENERAL || type === TY_CITY) {
      this.memArmy[i]++;
    } else if (type === TY_BLANK) {
      if (t > 0 && t % 25 === 0) this.memArmy[i]++;
    }
    // 原版还有沼泽衰减（army-- / 归零则易主），本图无沼泽
  }
  this.memEstTurn[i] = this.fullTurn;
};

OimAgent.prototype.reinforceGeneralNeighborhood = function (player, anchor, baseScore, maxDist, fogOnly) {
  var w = this.W;
  var ar = (anchor / w) | 0;
  var ac = anchor % w;
  for (var dr = -maxDist; dr <= maxDist; dr++) {
    var rem = maxDist - Math.abs(dr);
    for (var dc = -rem; dc <= rem; dc++) {
      var r = ar + dr;
      var c = ac + dc;
      if (r < 0 || r >= this.H || c < 0 || c >= this.W) continue;
      var i = r * w + c;
      if (!this.memPassable(i) || this.memType[i] === TY_CITY) continue;
      if (fogOnly && this.memVisible[i]) continue;
      var md = Math.abs(dr) + Math.abs(dc);
      var gain = Math.max(0, baseScore - md * 2.2);
      if (gain !== 0) this.addPredictionScore(player, i, gain);
    }
  }
};

OimAgent.prototype.addPredictionScore = function (player, i, delta) {
  if (delta === 0 || player < 0 || player >= this.playerCnt) return;
  if (this.predScale[player] < 1e-9) this.renormalizePrediction(player);
  this.predScore[player * this.N + i] += delta / this.predScale[player];
};

OimAgent.prototype.renormalizePrediction = function (player) {
  if (player < 0 || player >= this.playerCnt) return;
  var scale = this.predScale[player];
  if (Math.abs(scale - 1) <= 1e-12) return;
  var base = player * this.N;
  if (scale === 0) {
    for (var i = 0; i < this.N; i++) this.predScore[base + i] = 0;
    this.predScale[player] = 1;
    return;
  }
  for (var j = 0; j < this.N; j++) this.predScore[base + j] *= scale;
  this.predScale[player] = 1;
};

OimAgent.prototype.advancePredictionDecay = function () {
  for (var p = 0; p < this.playerCnt; p++) {
    if (p === this.id) continue;
    this.predScale[p] *= K_PREDICTION_DECAY;
    if (this.predScale[p] < 1e-6) this.renormalizePrediction(p);
  }
};

OimAgent.prototype.rememberVisibleBoard = function () {
  var n = this.N;
  var i;
  this.advancePredictionDecay();
  this.newlyVisibleEnemy.fill(0);

  for (i = 0; i < n; i++) {
    var wasVisible = this.memVisible[i];
    var vis = this.tVisible[i];
    this.memVisible[i] = vis;
    if (!vis) {
      if (!this.memEver[i]) {
        // 没见过：类型直接采纳退化后的视野类型（FOG→BLANK / FOG_OBSTACLE→OBSTACLE）
        this.memType[i] = this.tType[i];
        this.memEstTurn[i] = this.fullTurn;
      } else {
        this.evolveHiddenMemory(i);
      }
      continue;
    }
    this.memEver[i] = 1;
    this.memType[i] = this.tType[i];
    this.memArmy[i] = this.tArmy[i];
    this.memOcc[i] = this.tOcc[i];
    this.memLastSeen[i] = this.fullTurn;
    this.memEstTurn[i] = this.fullTurn;

    if (this.tType[i] === TY_GENERAL && this.tOcc[i] >= 0) {
      this.knownGeneral[this.tOcc[i]] = i;
    }
    if (this.tOcc[i] >= 0 && this.tOcc[i] !== this.id && !wasVisible) {
      this.newlyVisibleEnemy[this.tOcc[i]]++;
      this.reinforceGeneralNeighborhood(this.tOcc[i], i, 16.0, 7, true);
    }
  }

  // 看得见的敌格整体再加一层（原版第二遍）
  for (i = 0; i < n; i++) {
    if (!this.tVisible[i] || this.tOcc[i] < 0 || this.tOcc[i] === this.id) continue;
    this.reinforceGeneralNeighborhood(this.tOcc[i], i, 9.0, 4, false);
  }
};

OimAgent.prototype.buildBaseGeneralCandidateMask = function () {
  var n = this.N;
  var list = this.baseCandList;
  this.baseCandMask.fill(0);
  list.length = 0;
  for (var i = 0; i < n; i++) {
    if (!this.memPassable(i) || this.memVisible[i] || this.memType[i] === TY_CITY) continue;
    if (this.myGeneral >= 0 && this.manhattan(i, this.myGeneral) < 9) continue;
    this.baseCandMask[i] = 1;
    list.push(i);
  }
};

OimAgent.prototype.refreshGeneralGuessCache = function (metrics) {
  var n = this.N;
  var p;
  this.cachedGuess.fill(-1);
  this.cachedHasEvidence.fill(0);
  for (p = 0; p < this.playerCnt; p++) {
    if (p === this.id) continue;
    this.cachedHasEvidence[p] =
      this.knownGeneral[p] >= 0 ||
      this.visibleEnemyCount[p] > 0 ||
      this.newlyVisibleEnemy[p] > 0 ||
      metrics.contactDensity > 0.035 ||
      metrics.conversionAdvantage > 12.0;
    if (this.knownGeneral[p] >= 0) {
      this.cachedGuess[p] = this.knownGeneral[p];
      continue;
    }
    var best = -1;
    var bestScore = -1e100;
    var base = p * n;
    var scale = this.predScale[p];
    var list = this.baseCandList;
    for (var k = 0; k < list.length; k++) {
      var c = list[k];
      var score = this.predScore[base + c] * scale;
      if (this.myGeneral >= 0) score -= this.manhattan(c, this.myGeneral) * 0.18;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    this.cachedGuess[p] = best;
  }
};

OimAgent.prototype.chooseTargetPlayerGeneral = function (p) {
  if (p < 0 || p >= this.playerCnt) return -1;
  if (this.knownGeneral[p] >= 0) return this.knownGeneral[p];
  return this.cachedGuess[p];
};

/* ---------------- 每回合缓存 ---------------- */

/*
 * 原版这里有 RankItem（总兵力/地盘/存活）。擂台赛拿不到，所以：
 *   - 自己的兵力地盘从视野精确算；
 *   - 对手从"看得见的 + 记忆里最后所见的"估（不会低估到低于 visibleArmy，
 *     否则 hiddenReserveEstimate 会变成负数）。
 */
OimAgent.prototype.refreshRank = function () {
  var n = this.N;
  var me = this.id;
  var enemy = 1 - me;
  var i;
  var myLand = 0;
  var myArmy = 0;
  var enLand = 0;
  var enArmy = 0;
  for (i = 0; i < n; i++) {
    var occ = this.tOcc[i];
    if (this.tVisible[i]) {
      if (occ === me) {
        myLand++;
        myArmy += this.tArmy[i];
      } else if (occ === enemy) {
        enLand++;
        enArmy += this.tArmy[i];
      }
      continue;
    }
    if (this.memOcc[i] === me && this.memEver[i]) {
      myLand++;
      myArmy += this.memArmy[i];
    } else if (this.memOcc[i] === enemy && this.memEver[i]) {
      enLand++;
      enArmy += this.memArmy[i];
    }
  }
  if (this.hasPrevRank) {
    this.prevRankArmy[me] = this.rankArmy[me];
    this.prevRankLand[me] = this.rankLand[me];
    this.prevRankArmy[enemy] = this.rankArmy[enemy];
    this.prevRankLand[enemy] = this.rankLand[enemy];
  }
  this.rankArmy[me] = myArmy;
  this.rankLand[me] = myLand;
  this.rankArmy[enemy] = enArmy;
  this.rankLand[enemy] = enLand;
  for (var p = 0; p < this.playerCnt; p++) {
    if (this.hasPrevRank) {
      this.playerArmyDelta[p] = this.rankArmy[p] - this.prevRankArmy[p];
      this.playerLandDelta[p] = this.rankLand[p] - this.prevRankLand[p];
    } else {
      this.playerArmyDelta[p] = 0;
      this.playerLandDelta[p] = 0;
    }
  }
  this.hasPrevRank = true;
};

OimAgent.prototype.rebuildTurnCaches = function () {
  var n = this.N;
  var i;
  var prevHidden = this.hiddenReserveEst.slice();

  this.friendlyTiles.length = 0;
  this.frontierTiles.length = 0;
  this.ownedCities.length = 0;
  this.objectiveCandidates.length = 0;
  this.visibleEnemyCount.fill(0);
  this.visibleArmy.fill(0);

  for (i = 0; i < n; i++) {
    if (this.tVisible[i] && this.isEnemy(i)) {
      var eo = this.tOcc[i];
      if (eo < this.visibleEnemyCount.length) {
        this.visibleEnemyCount[eo]++;
        this.visibleArmy[eo] += this.tArmy[i];
      }
    }
    if (this.tOcc[i] !== this.id) continue;
    this.friendlyTiles.push(i);
    if (this.tType[i] === TY_CITY) this.ownedCities.push(i);
    if (this.tType[i] === TY_GENERAL) this.myGeneral = i;

    var frontier = false;
    var base = i * 4;
    for (var k = 0; k < 4; k++) {
      var adj = this.nbr[base + k];
      if (adj < 0) continue;
      if (this.tOcc[adj] !== this.id) frontier = true;
      if (!this.tVisible[adj] && !this.memEver[adj]) frontier = true;
      if (this.recentEnemyAt(adj)) frontier = true;
    }
    if (frontier) this.frontierTiles.push(i);
  }

  for (var p = 0; p < this.playerCnt; p++) {
    this.hiddenReserveEst[p] = Math.max(0, this.rankArmy[p] - this.visibleArmy[p]);
    this.hiddenReserveDelta[p] = this.hiddenReserveEst[p] - prevHidden[p];
  }
};

/* ---------------- 压力场 / 局面图 ---------------- */

OimAgent.prototype.passableDegree = function (i) {
  return this.passDeg[i];
};

/* 每回合算一次每格的可通行度（热力图/守备/咽喉判定都吃它） */
OimAgent.prototype.buildPassableDegrees = function () {
  var n = this.N;
  var nbr = this.nbr;
  var deg = this.passDeg;
  for (var i = 0; i < n; i++) {
    var passable = this.passableType(this.memType[i]);
    var d = 0;
    if (passable) {
      var base = i * 4;
      for (var k = 0; k < 4; k++) {
        var j = nbr[base + k];
        if (j >= 0 && this.passableType(this.memType[j])) d++;
      }
    }
    deg[i] = d;
  }
};

OimAgent.prototype.addPressure = function (arr, source, army, mult, stepLoss) {
  if (army <= 0) return;
  var radius = Math.sqrt(Math.max(1, army)) | 0;
  radius = Math.max(2, Math.min(6, radius + 1));
  var capped = Math.min(army, 120) * mult;
  var kernel = this.kernels[radius];
  var w = this.W;
  var sr = (source / w) | 0;
  var sc = source % w;
  for (var t = 0; t < kernel.length; t += 3) {
    var r = sr + kernel[t];
    var c = sc + kernel[t + 1];
    if (r < 0 || r >= this.H || c < 0 || c >= this.W) continue;
    var i = r * w + c;
    if (!this.memPassable(i)) continue;
    var gain = capped - kernel[t + 2] * stepLoss;
    if (gain > 0) arr[i] += gain;
  }
};

OimAgent.prototype.computeGeneralDistances = function () {
  var n = this.N;
  this.distFromGeneral.fill(BIG);
  this.generalBfsOrder.length = 0;
  if (this.myGeneral < 0) return;
  var dist = this.distFromGeneral;
  var q = [this.myGeneral];
  dist[this.myGeneral] = 0;
  for (var h = 0; h < q.length; h++) {
    var cur = q[h];
    this.generalBfsOrder.push(cur);
    var base = cur * 4;
    for (var k = 0; k < 4; k++) {
      var nx = this.nbr[base + k];
      if (nx < 0) continue;
      if (!this.memPassable(nx)) continue;
      if (dist[nx] !== BIG) continue;
      dist[nx] = dist[cur] + 1;
      q.push(nx);
    }
  }
};

OimAgent.prototype.adjacentEnemyThreat = function (origin) {
  if (origin < 0) return 0;
  var threat = 0;
  var base = origin * 4;
  for (var k = 0; k < 4; k++) {
    var adj = this.nbr[base + k];
    if (adj < 0) continue;
    if (this.isEnemy(adj)) {
      if (this.tArmy[adj] > threat) threat = this.tArmy[adj];
    } else if (this.recentEnemyAt(adj)) {
      if (this.memArmy[adj] > threat) threat = this.memArmy[adj];
    }
  }
  return threat;
};

OimAgent.prototype.refreshGeneralSafetyCache = function () {
  this.cachedGeneralAdjacentThreat = 0;
  this.cachedGeneralLocalPressure = 0;
  this.cachedRelaxedGeneralOpening = false;
  if (this.myGeneral < 0) return;
  this.cachedGeneralAdjacentThreat = this.adjacentEnemyThreat(this.myGeneral);
  this.cachedGeneralLocalPressure = Math.max(
    0,
    this.enemyPressure[this.myGeneral] - this.friendlyPressure[this.myGeneral] * 0.55
  );
  if (this.fullTurn >= 40 || this.cachedGeneralAdjacentThreat > 0 || this.cachedGeneralLocalPressure > 4.0) {
    return;
  }
  var visible = 0;
  for (var p = 0; p < this.playerCnt; p++) {
    if (p === this.id) continue;
    visible += this.visibleEnemyCount[p];
  }
  this.cachedRelaxedGeneralOpening = visible === 0;
};

OimAgent.prototype.relaxedGeneralOpening = function () {
  return this.cachedRelaxedGeneralOpening;
};

OimAgent.prototype.recomputeSituationMaps = function () {
  var n = this.N;
  var i;
  this.buildPassableDegrees();
  this.enemyPressure.fill(0);
  this.friendlyPressure.fill(0);
  this.reserveArmy.fill(0);
  this.pathFlow.fill(0);
  this.coreZone.fill(0);
  this.choke.fill(0);

  for (i = 0; i < n; i++) {
    if (this.tVisible[i]) {
      if (this.tArmy[i] <= 0) continue;
      if (this.isEnemy(i)) this.addPressure(this.enemyPressure, i, this.tArmy[i], 1.0, 15.0);
      else if (this.tOcc[i] === this.id) this.addPressure(this.friendlyPressure, i, this.tArmy[i], 0.9, 13.0);
      continue;
    }
    if (!this.memEver[i] || this.memArmy[i] <= 0 || this.memLastSeen[i] < 0) continue;
    var age = this.fullTurn - this.memLastSeen[i];
    if (age > 4) continue;
    var seenArmy = Math.max(1, this.memArmy[i] - age);
    if (this.isEnemyOcc(this.memOcc[i])) this.addPressure(this.enemyPressure, i, seenArmy, 0.75, 16.0);
    else if (this.memOcc[i] === this.id) this.addPressure(this.friendlyPressure, i, seenArmy, 0.7, 14.0);
  }

  this.computeGeneralDistances();
  if (this.myGeneral < 0) return;

  var area = this.mapArea();
  var coreRadius = Math.max(5, Math.min(12, (Math.sqrt(area) / 1.8) | 0));
  this.coreRadius = coreRadius;
  var dg = this.distFromGeneral;
  for (i = 0; i < n; i++) if (dg[i] <= coreRadius) this.coreZone[i] = 1;
  for (var ci = 0; ci < this.ownedCities.length; ci++) {
    var city = this.ownedCities[ci];
    if (dg[city] <= coreRadius + 3) this.coreZone[city] = 1;
  }

  this.refreshGeneralSafetyCache();

  this.generalPathParent.fill(-1);
  var order = this.generalBfsOrder;
  for (var oi = 0; oi < order.length; oi++) {
    var c = order[oi];
    if (c === this.myGeneral) continue;
    var curDist = dg[c];
    if (curDist === BIG) continue;
    var best = -1;
    var bestP = 0;
    var found = false;
    var base = c * 4;
    for (var k = 0; k < 4; k++) {
      var cand = this.nbr[base + k];
      if (cand < 0) continue;
      if (!this.memPassable(cand)) continue;
      if (dg[cand] !== curDist - 1) continue;
      var cp = this.enemyPressure[cand];
      if (!found || cp < bestP) {
        found = true;
        best = cand;
        bestP = cp;
      }
    }
    this.generalPathParent[c] = best;
  }

  for (var fi = 0; fi < this.frontierTiles.length; fi++) {
    var f = this.frontierTiles[fi];
    if (dg[f] === BIG) continue;
    this.pathFlow[f]++;
  }
  for (var oi2 = order.length - 1; oi2 >= 0; oi2--) {
    var cur = order[oi2];
    if (cur === this.myGeneral) continue;
    var par = this.generalPathParent[cur];
    if (par >= 0) this.pathFlow[par] += this.pathFlow[cur];
  }

  for (var f2 = 0; f2 < this.friendlyTiles.length; f2++) {
    var t2 = this.friendlyTiles[f2];
    var reserve = 0;
    if (t2 === this.myGeneral) {
      if (this.relaxedGeneralOpening()) {
        reserve = 1;
      } else {
        reserve = Math.max(2, 2 + ((Math.max(0, this.enemyPressure[t2] * 0.08)) | 0));
        if (this.fullTurn >= 60) reserve = Math.max(reserve, 3);
      }
    }
    if (
      this.coreZone[t2] &&
      this.enemyPressure[t2] > this.friendlyPressure[t2] * 0.55 + 6.0
    ) {
      reserve = Math.max(
        reserve,
        Math.max(0, (this.enemyPressure[t2] - this.friendlyPressure[t2] * 0.55) * 0.05) | 0
      );
    }
    if (this.tType[t2] === TY_CITY && this.coreZone[t2]) {
      reserve = Math.max(reserve, 2 + ((Math.max(0, this.enemyPressure[t2] * 0.04)) | 0));
    }
    var flow = this.pathFlow[t2];
    var degree = this.passableDegree(t2);
    if (flow >= 2 && degree <= 2 && dg[t2] >= 2 && dg[t2] <= coreRadius + 6) {
      this.choke[t2] = 1;
      reserve = Math.max(
        reserve,
        1 + ((flow / 3) | 0) + ((Math.max(0, this.enemyPressure[t2] * 0.03)) | 0)
      );
    }
    var movableFloor = this.tArmy[t2] <= 1 ? 0 : Math.max(0, this.tArmy[t2] - 2);
    this.reserveArmy[t2] = Math.min(reserve, movableFloor);
  }
};

OimAgent.prototype.computeSituationMetrics = function () {
  var m = {
    frontierPressure: 0,
    coreRisk: 0,
    contactDensity: 0,
    mobilityScore: 0,
    conversionAdvantage: 0
  };
  var i;
  var k;
  var ft = this.frontierTiles;

  if (ft.length) {
    var load = 0;
    var edges = 0;
    for (i = 0; i < ft.length; i++) {
      var c = ft[i];
      load += Math.max(0, this.enemyPressure[c] - this.friendlyPressure[c] * 0.65);
      var base = c * 4;
      for (k = 0; k < 4; k++) {
        var adj = this.nbr[base + k];
        if (adj < 0) continue;
        if (this.isEnemy(adj) || this.recentEnemyAt(adj)) edges += 1;
      }
    }
    m.frontierPressure = load / ft.length;
    m.contactDensity = edges / Math.max(1, ft.length * 4);
  }

  if (this.myGeneral >= 0) {
    m.coreRisk = Math.max(
      0,
      this.enemyPressure[this.myGeneral] - this.friendlyPressure[this.myGeneral] * 0.55
    );
    for (i = 0; i < this.ownedCities.length; i++) {
      var city = this.ownedCities[i];
      if (!this.coreZone[city]) continue;
      m.coreRisk +=
        Math.max(0, this.enemyPressure[city] - this.friendlyPressure[city] * 0.7) * 0.2;
    }
  }

  var mobileArmy = 0;
  var mobileSources = 0;
  for (i = 0; i < this.friendlyTiles.length; i++) {
    var t = this.friendlyTiles[i];
    var avail = Math.max(0, this.tArmy[t] - 1 - this.reserveArmy[t]);
    if (avail <= 0) continue;
    mobileArmy += avail;
    mobileSources++;
  }
  m.mobilityScore =
    mobileSources === 0 ? 0 : mobileArmy / mobileSources + ft.length * 0.25;

  var strongestEnemyArmy = 0;
  var avgEnemyLand = 0;
  var enemyCnt = 0;
  for (var p = 0; p < this.playerCnt; p++) {
    if (p === this.id || !this.aliveById[p]) continue;
    strongestEnemyArmy = Math.max(strongestEnemyArmy, this.rankArmy[p]);
    avgEnemyLand += this.rankLand[p];
    enemyCnt++;
  }
  if (enemyCnt > 0) avgEnemyLand /= enemyCnt;
  m.conversionAdvantage =
    (this.rankArmy[this.id] - strongestEnemyArmy) * 0.12 +
    (this.rankLand[this.id] - avgEnemyLand) * 0.7 -
    m.frontierPressure * 0.25 -
    m.coreRisk * 0.18;
  return m;
};

/* ---------------- 扩张直觉 ---------------- */

OimAgent.prototype.expansionUrgency = function (m) {
  var duel = this.duelMode();
  var urgency = 0;
  var areaFactor = Math.max(0, this.mapArea() - 380) / 50;
  urgency += Math.min(8, areaFactor);
  if (!duel) urgency += 1.5;
  if (this.playerCnt > 2) urgency += 1.5;
  if (this.mapArea() >= 500 && this.fullTurn < 140) {
    urgency += (140 - this.fullTurn) * 0.035;
  }
  if (!duel || this.mapArea() >= 520) {
    urgency += Math.max(0, 0.055 - m.contactDensity) * 90;
    urgency += Math.max(0, 4 - m.conversionAdvantage) * 0.35;
  }
  urgency -= Math.max(0, m.coreRisk - 8) * 0.18;
  return Math.max(0, Math.min(12, urgency));
};

OimAgent.prototype.inDuelTempoPhase = function (m) {
  if (!this.duelMode()) return false;
  if (this.mapArea() > 450) return false;
  if (m.contactDensity > (this.mapArea() >= 520 ? 0.05 : 0.065)) return false;
  if (m.coreRisk > 10) return false;
  var limit = this.mapArea() >= 650 ? 130 : this.mapArea() >= 500 ? 105 : 64;
  return this.fullTurn <= limit;
};

OimAgent.prototype.shouldBuildDuelExpansionHeat = function (m) {
  if (!this.duelMode()) return false;
  if (m.contactDensity > 0.06) return false;
  if (m.coreRisk > 10.5) return false;
  var limit = this.mapArea() >= 650 ? 135 : this.mapArea() >= 500 ? 115 : 70;
  return this.fullTurn <= limit;
};

OimAgent.prototype.duelExpansionPlanningWeight = function () {
  return this.duelMode() && this.mapArea() <= 450 ? 1.0 : 0.0;
};

OimAgent.prototype.duelExpansionHeatAt = function (i) {
  if (i < 0) return 0;
  return this.duelHeat[i];
};

/*
 * 局部扩张潜力。注意：它只依赖本回合的视野/记忆（回合内不变），而 rollout 的
 * DFS 会对同一格反复问上百次，所以按回合缓存 —— 语义完全一致，纯提速。
 */
OimAgent.prototype.localExpansionPotential = function (c) {
  if (this.lepStamp[c] === this.turnStamp) return this.lepVal[c];
  var score = 0;
  var k;
  var base = c * 4;
  var memType = this.memType;
  var tOcc = this.tOcc;
  var tVisible = this.tVisible;
  var memEver = this.memEver;
  var passableType = this.passableType;
  var me = this.id;
  for (k = 0; k < 4; k++) {
    var adj = this.nbr[base + k];
    if (adj < 0) continue;
    if (!passableType(memType[adj])) continue;
    if (tOcc[adj] === me) {
      score -= 0.8;
      continue;
    }
    if (!memEver[adj]) score += 8.0;
    else if (!tVisible[adj]) score += 4.0;
    else if (tOcc[adj] < 0) score += 2.5;
    else score += 1.5; // 看得见的敌格
  }
  // 两跳：更远的未探索价值（弱一些）
  for (k = 0; k < 4; k++) {
    var mid = this.nbr[base + k];
    if (mid < 0) continue;
    if (!passableType(memType[mid])) continue;
    var mb = mid * 4;
    for (var k2 = 0; k2 < 4; k2++) {
      var far = this.nbr[mb + k2];
      if (far < 0 || far === c) continue;
      if (!passableType(memType[far])) continue;
      if (tOcc[far] === me) continue;
      if (!memEver[far]) score += 1.2;
      else if (!tVisible[far]) score += 0.7;
    }
  }
  this.lepStamp[c] = this.turnStamp;
  this.lepVal[c] = score;
  return score;
};

OimAgent.prototype.captureTimingBonus = function (from, to) {
  if (from < 0 || to < 0 || !this.upcomingMoveGetsGrowthTick()) return 0;
  if (this.tOcc[from] !== this.id || this.tArmy[from] <= 1) return 0;
  var occ = this.visibleOrRememberedOcc(to);
  if (occ === this.id) return 0;
  if (this.tArmy[from] - 1 <= this.estimatedArmyAt(to)) return 0;

  var bonus = 4.0;
  if (this.isEnemyOcc(occ)) bonus += 10.0;
  var type = this.tVisible[to] ? this.tType[to] : this.memType[to];
  var memType = this.memType[to];
  if (type === TY_CITY || memType === TY_CITY) bonus += 12.0;
  if (type === TY_GENERAL || memType === TY_GENERAL) bonus += 18.0;
  if (!this.memEver[to] || !this.tVisible[to]) bonus += 2.0;
  if (this.upcomingMoveGetsGlobalGrowthTick()) {
    bonus += 7.0;
    if (this.isEnemyOcc(occ)) bonus += 8.0;
    if (
      type !== TY_CITY &&
      memType !== TY_CITY &&
      type !== TY_GENERAL &&
      memType !== TY_GENERAL
    ) {
      bonus += 2.5;
    }
    bonus += Math.min(8, Math.max(0, this.localExpansionPotential(to) * 0.75));
  }
  return bonus;
};

/* ---------------- 风险 / 安全闸门 ---------------- */

OimAgent.prototype.moveRemainingArmy = function (move) {
  var from = move.from;
  if (from < 0) return 0;
  if (this.tOcc[from] !== this.id || this.tArmy[from] <= 1) return 0;
  // 原版这里也有 takeHalf 分支，本移植全部出整手（army-1），留 1 个在家
  return 1;
};

OimAgent.prototype.availableArmy = function (c) {
  if (c < 0) return 0;
  if (this.tOcc[c] !== this.id || this.tArmy[c] <= 1) return 0;
  return Math.max(0, this.tArmy[c] - 1 - this.reserveArmy[c]);
};

OimAgent.prototype.movePassesHardSafety = function (move) {
  var from = move.from;
  var to = move.to;
  if (from < 0 || to < 0) return false;
  if (this.tOcc[from] !== this.id || this.tArmy[from] <= 1) return false;
  var remain = this.moveRemainingArmy(move);
  if (remain <= 0) return false;
  if (from === this.myGeneral) {
    if (remain <= this.cachedGeneralAdjacentThreat) return false;
    if (
      !this.cachedRelaxedGeneralOpening &&
      this.cachedGeneralLocalPressure > 8.0 &&
      remain <= this.cachedGeneralAdjacentThreat + 1
    ) {
      return false;
    }
  }
  return true;
};

OimAgent.prototype.moveLooksSafe = function (move) {
  return this.movePassesHardSafety(move);
};

OimAgent.prototype.moveRiskPenalty = function (move, m) {
  if (!this.movePassesHardSafety(move)) return 1e9;
  var from = move.from;
  var to = move.to;
  var remain = this.moveRemainingArmy(move);
  var reserve = this.reserveArmy[from];
  var penalty = 0;

  if (remain < reserve) {
    penalty +=
      (reserve - remain) *
      (from === this.myGeneral ? (this.cachedRelaxedGeneralOpening ? 4.0 : 10.0) : 7.5);
  }
  var localPressure = Math.max(
    0,
    this.enemyPressure[from] - this.friendlyPressure[from] * 0.6
  );
  if (this.coreZone[from]) penalty += localPressure * 0.35;
  if (this.choke[from]) penalty += 5.0 + localPressure * 0.18;
  if (from === this.myGeneral) {
    penalty += Math.max(0, this.cachedGeneralAdjacentThreat + 1 - remain) * 18.0;
    penalty += Math.max(0, m.coreRisk - remain * 0.9) * 0.4;
  } else if (this.coreZone[from] && remain <= 2) {
    penalty += 6.0;
  }
  // 原版这里还有「踏入沼泽 +4」，本图没有沼泽
  return penalty;
};

OimAgent.prototype.immediateAdvancePossible = function (from, to) {
  if (from < 0 || to < 0) return false;
  if (this.tOcc[from] !== this.id || this.tArmy[from] <= 1) return false;
  var occ = this.visibleOrRememberedOcc(to);
  if (occ === this.id) return true;
  return this.tArmy[from] - 1 > this.estimatedArmyAt(to);
};

OimAgent.prototype.shouldBlockOscillation = function (from, to) {
  if (from === this.lastMoveTo && to === this.lastMoveFrom) return true;
  var key = this.edgeKey(from, to);
  var seen = this.recentEdgeCounts.get(key) || 0;
  return seen >= 3 && this.tOcc[to] === this.id;
};

OimAgent.prototype.edgeKey = function (a, b) {
  var lo = a < b ? a : b;
  var hi = a < b ? b : a;
  return lo * 100000 + hi;
};

OimAgent.prototype.pushRecentMove = function (from, to) {
  var key = this.edgeKey(from, to);
  this.recentEdges.push(key, from, to);
  this.recentEdgeCounts.set(key, (this.recentEdgeCounts.get(key) || 0) + 1);
  if (this.recentEdges.length / 3 > K_RECENT_EDGE_WINDOW) {
    var oldKey = this.recentEdges.shift();
    this.recentEdges.shift();
    this.recentEdges.shift();
    var n = (this.recentEdgeCounts.get(oldKey) || 0) - 1;
    if (n <= 0) this.recentEdgeCounts.delete(oldKey);
    else this.recentEdgeCounts.set(oldKey, n);
  }
  this.lastMoveFrom = from;
  this.lastMoveTo = to;
};

OimAgent.prototype.strongestFriendlyTile = function (includeGeneral, near, nearWeight) {
  var best = -1;
  var bestScore = -1e100;
  for (var k = 0; k < this.friendlyTiles.length; k++) {
    var c = this.friendlyTiles[k];
    var army = this.tArmy[c];
    if (army <= 1) continue;
    if (!includeGeneral && c === this.myGeneral) continue;
    var score = this.availableArmy(c) * 3.0 + army;
    if (this.tType[c] === TY_CITY) score -= 4.0;
    if (c === this.myGeneral) score -= 8.0;
    if (this.choke[c]) score -= 5.0;
    if (near !== undefined && near >= 0) score -= this.manhattan(c, near) * nearWeight;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
};

OimAgent.prototype.friendlyLeadSteps = function (route) {
  var lead = 0;
  for (var i = 0; i < route.length; i++) {
    var step = route[i];
    if (step < 0) break;
    if (this.tOcc[step] !== this.id) break;
    lead++;
  }
  return lead;
};

OimAgent.prototype.supportAlongRoute = function (source, route) {
  // 走 3x3 打点再扫我的格，比每个格子算 4 次曼哈顿快一个量级
  if (!this._corridorMark) {
    this._corridorMark = new Int32Array(this.N);
    this._corridorStamp = 0;
  }
  var mark = this._corridorMark;
  var stamp = ++this._corridorStamp;
  var w = this.W;
  var h = this.H;
  for (var i = 0; i < route.length && i < 4; i++) {
    var t = route[i];
    var r = this.rowOf[t];
    var c = this.colOf[t];
    for (var dr = -1; dr <= 1; dr++) {
      var rr = r + dr;
      if (rr < 0 || rr >= h) continue;
      for (var dc = -1; dc <= 1; dc++) {
        var cc = c + dc;
        if (cc < 0 || cc >= w) continue;
        mark[rr * w + cc] = stamp;
      }
    }
  }
  var support = 0;
  for (var k = 0; k < this.friendlyTiles.length; k++) {
    var f = this.friendlyTiles[k];
    if (f === source) continue;
    if (mark[f] !== stamp) continue;
    var avail = this.availableArmy(f);
    if (avail <= 0) continue;
    support += avail;
  }
  return Math.min(support, 48);
};

OimAgent.prototype.estimateObjectiveNeed = function (objective, distance, mode) {
  var need = this.estimatedArmyAt(objective) + 1;
  if (this.isEnemyOcc(this.memOcc[objective])) need += 1;
  if (this.memType[objective] === TY_CITY) need += 3;
  if (this.memType[objective] === TY_GENERAL) need += 2;
  if (mode === M_DEFEND) need += 1;
  if (mode === M_CONVERT && this.isEnemyOcc(this.memOcc[objective])) need += 1;
  need += Math.max(1, (distance / 4) | 0);
  need += Math.max(
    0,
    (this.enemyPressure[objective] - this.friendlyPressure[objective]) * 0.015
  ) | 0;
  return need;
};

OimAgent.prototype.shouldPreferRally = function (plan, m) {
  if (!plan || !plan.rally) return false;
  var gap = plan.need - (plan.commitArmy + plan.corridorSupport);
  if (plan.mode === M_DEFEND) return gap > 0;
  return gap > 2 || plan.pathCost >= 8 || m.coreRisk > 12;
};

OimAgent.prototype.chooseRallyMove = function (plan, m) {
  if (!plan || plan.source < 0) return null;
  var corR = [];
  var corC = [];
  for (var i = 0; i < plan.route.length && corR.length < 4; i++) {
    var step = plan.route[i];
    if (this.tOcc[step] !== this.id) continue;
    corR.push(this.rowOf[step]);
    corC.push(this.colOf[step]);
  }
  var rowOf = this.rowOf;
  var colOf = this.colOf;
  var srcR = rowOf[plan.source];
  var srcC = colOf[plan.source];
  var corridorDistance = function (idx) {
    var best = Math.abs(rowOf[idx] - srcR) + Math.abs(colOf[idx] - srcC);
    for (var j = 0; j < corR.length; j++) {
      var dd = Math.abs(rowOf[idx] - corR[j]) + Math.abs(colOf[idx] - corC[j]);
      if (dd < best) best = dd;
    }
    return best;
  };

  var bestMove = null;
  var bestScore = -1e100;
  for (var k = 0; k < this.friendlyTiles.length; k++) {
    var from = this.friendlyTiles[k];
    if (from === plan.source) continue;
    if (this.availableArmy(from) <= 0) continue;
    var before = corridorDistance(from);
    if (before <= 0) continue;
    var base = from * 4;
    for (var d2 = 0; d2 < 4; d2++) {
      var to = this.nbr[base + d2];
      if (to < 0) continue;
      if (this.tOcc[to] !== this.id) continue;
      if (this.shouldBlockOscillation(from, to)) continue;
      var after = corridorDistance(to);
      if (after >= before) continue;

      var move = { from: from, to: to, split: false };
      var risk = this.moveRiskPenalty(move, m);
      if (risk >= 1e8) continue;
      var score = this.availableArmy(from) * 11 + (before - after) * 30;
      if (to === plan.source) score += 50;
      if (this.tType[from] === TY_CITY) score -= 18;
      if (from === this.myGeneral) score -= 45 + m.coreRisk * 0.8;
      if (this.choke[from]) score -= 14;
      score -= risk;
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }
  }
  return bestMove;
};

/* ---------------- 加权最短路 ---------------- */

/* 从 start 出发的 Dijkstra；costFn(i) 是"进入 i"的代价 */
OimAgent.prototype.weightedPath = function (start, costFn) {
  var ws = this.fwd;
  var dist = ws.dist;
  var parent = ws.parent;
  var first = ws.first;
  var depth = ws.depth;
  var lead = ws.lead;
  var heap = ws.heap;
  dist.fill(BIG);
  parent.fill(-1);
  first.fill(-1);
  depth.fill(BIG);
  lead.fill(0);
  heap.clear();
  if (start < 0) {
    ws.reachable = false;
    return ws;
  }
  dist[start] = 0;
  depth[start] = 0;
  heap.push(0, start);
  var nbr = this.nbr;
  var memType = this.memType;
  var self = this;
  while (heap.n > 0) {
    var cur = heap.pop();
    var cd = heap.lastKey;
    if (cd !== dist[cur]) continue;
    var curDepth = depth[cur];
    var curLead = lead[cur];
    var curFirst = first[cur];
    var base = cur * 4;
    for (var k = 0; k < 4; k++) {
      var nx = nbr[base + k];
      if (nx < 0) continue;
      if (!self.passableType(memType[nx])) continue;
      var nd = cd + costFn(nx);
      if (nd < dist[nx]) {
        dist[nx] = nd;
        parent[nx] = cur;
        first[nx] = cur === start ? nx : curFirst;
        depth[nx] = curDepth + 1;
        lead[nx] = curLead === curDepth && self.tOcc[nx] === self.id ? curDepth + 1 : curLead;
        heap.push(nd, nx);
      }
    }
  }
  ws.reachable = true;
  return ws;
};

/* 从 goal 反向 Dijkstra；边代价 = 靠近 goal 那一端的 costFn（照抄原版语义） */
OimAgent.prototype.weightedReversePath = function (goal, costFn) {
  var ws = this.rev;
  var dist = ws.dist;
  var parent = ws.parent;
  var heap = ws.heap;
  dist.fill(BIG);
  parent.fill(-1);
  heap.clear();
  if (goal < 0) {
    ws.reachable = false;
    return ws;
  }
  dist[goal] = 0;
  heap.push(0, goal);
  var nbr = this.nbr;
  var memType = this.memType;
  var self = this;
  while (heap.n > 0) {
    var cur = heap.pop();
    var cd = heap.lastKey;
    if (cd !== dist[cur]) continue;
    var stepCost = costFn(cur);
    var base = cur * 4;
    for (var k = 0; k < 4; k++) {
      var prev = nbr[base + k];
      if (prev < 0) continue;
      if (!self.passableType(memType[prev])) continue;
      var nd = cd + stepCost;
      if (nd < dist[prev]) {
        dist[prev] = nd;
        parent[prev] = cur;
        heap.push(nd, prev);
      }
    }
  }
  ws.reachable = true;
  return ws;
};

/* parent 链从 goal 回到 start，返回 start 之后的顺序路线 */
OimAgent.prototype.reconstructPath = function (start, goal, ws) {
  var rev = [];
  if (start < 0 || goal < 0) return rev;
  var cur = goal;
  var guard = this.N + 5;
  while (cur >= 0 && cur !== start && guard-- > 0) {
    rev.push(cur);
    cur = ws.parent[cur];
  }
  if (cur !== start) return [];
  rev.reverse();
  return rev;
};

/* 反向场：从 start 顺着 parent 走到 goal */
OimAgent.prototype.reconstructReversePath = function (start, goal, ws) {
  var route = [];
  if (start < 0 || goal < 0) return route;
  var cur = start;
  var guard = this.N + 5;
  while (cur >= 0 && cur !== goal && guard-- > 0) {
    cur = ws.parent[cur];
    if (cur < 0) return [];
    route.push(cur);
  }
  if (cur !== goal) return [];
  return route;
};

/*
 * 多源反向威胁场：从"我的将军/核心城市"出发往敌人方向走，代价是步数（沼泽 +5，
 * 本图没有沼泽），种子的 bias 折进起点代价 → 到我的将军越"重"的种子越贵，
 * 于是同一片区域会被判给最危险的那股敌人。
 */
OimAgent.prototype.multiSourceThreatReversePath = function (seeds, maxRawDist, ws) {
  var N = this.N;
  ws.cost.fill(BIGD);
  ws.rawDist.fill(BIG);
  ws.steps.fill(BIG);
  ws.seedIndex.fill(-1);
  ws.parent.fill(-1);
  var heap = ws.heap;
  heap.clear();
  ws.reachable = false;
  if (!seeds.length) return ws;

  var s;
  for (s = 0; s < seeds.length; s++) {
    var seed = seeds[s];
    if (seed.target < 0) continue;
    var adj = -seed.bias / 10.5;
    if (!this.betterThreatCandidate(ws, seed.target, adj, 0, 0, s, seeds)) continue;
    ws.cost[seed.target] = adj;
    ws.rawDist[seed.target] = 0;
    ws.steps[seed.target] = 0;
    ws.seedIndex[seed.target] = s;
    ws.parent[seed.target] = -1;
    heap.push(adj, seed.target);
  }

  var nbr = this.nbr;
  var memType = this.memType;
  while (heap.n > 0) {
    var cur = heap.pop();
    var curCost = heap.lastKey;
    if (curCost > ws.cost[cur] + EPS) continue;
    var curRaw = ws.rawDist[cur];
    if (curRaw >= maxRawDist) continue;
    var stepCost = 1; // 原版：沼泽 +5
    var base = cur * 4;
    var curSteps = ws.steps[cur];
    var curSeed = ws.seedIndex[cur];
    for (var k = 0; k < 4; k++) {
      var prev = nbr[base + k];
      if (prev < 0) continue;
      if (!this.passableType(memType[prev])) continue;
      var candRaw = curRaw + stepCost;
      if (candRaw > maxRawDist) continue;
      var candSteps = curSteps + 1;
      var candCost = curCost + stepCost;
      if (!this.betterThreatCandidate(ws, prev, candCost, candRaw, candSteps, curSeed, seeds)) {
        continue;
      }
      ws.cost[prev] = candCost;
      ws.rawDist[prev] = candRaw;
      ws.steps[prev] = candSteps;
      ws.seedIndex[prev] = curSeed;
      ws.parent[prev] = cur;
      heap.push(candCost, prev);
    }
  }
  ws.reachable = true;
  return ws;
};

OimAgent.prototype.betterThreatCandidate = function (ws, node, cost, rawDist, steps, seedIndex, seeds) {
  var current = ws.cost[node];
  if (cost + EPS < current) return true;
  if (current + EPS < cost) return false;
  var curSeed = ws.seedIndex[node];
  var curRank = curSeed >= 0 ? seeds[curSeed].rank : BIG;
  var candRank = seeds[seedIndex].rank;
  if (candRank !== curRank) return candRank < curRank;
  if (rawDist !== ws.rawDist[node]) return rawDist < ws.rawDist[node];
  return steps < ws.steps[node];
};

OimAgent.prototype.reconstructThreatRoute = function (start, ws) {
  var route = [];
  if (start < 0) return route;
  var cur = start;
  var guard = this.N + 5;
  while (cur >= 0 && guard-- > 0) {
    var nxt = ws.parent[cur];
    if (nxt < 0) break;
    route.push(nxt);
    cur = nxt;
  }
  return route;
};

/* ---------------- 威胁分析 ---------------- */

OimAgent.prototype.analyzeThreat = function () {
  if (this.myGeneral < 0) return null;

  var keyTargets = [this.myGeneral];
  for (var i = 0; i < this.ownedCities.length; i++) {
    if (this.coreZone[this.ownedCities[i]]) keyTargets.push(this.ownedCities[i]);
  }
  var allSeeds = [];
  var limitedSeeds = [];
  var positiveSeeds = [];
  for (var rank = 0; rank < keyTargets.length; rank++) {
    var target = keyTargets[rank];
    var tp = this.enemyPressure[target] - this.friendlyPressure[target];
    var seed = {
      bias: tp * 0.9 + (target === this.myGeneral ? 55.0 : 24.0),
      target: target,
      rank: rank
    };
    allSeeds.push(seed);
    if (tp > 0) positiveSeeds.push(seed);
    else limitedSeeds.push(seed);
  }

  var closePath = this.multiSourceThreatReversePath(allSeeds, 4, this.thrClose);
  var limitedPath = this.multiSourceThreatReversePath(limitedSeeds, 5, this.thrLimited);
  var positivePath = this.multiSourceThreatReversePath(positiveSeeds, 14, this.thrPositive);

  var best = null;
  var self = this;
  var consider = function (path, seeds, source, sourceArmy, out) {
    if (!path.reachable) return;
    var sIdx = path.seedIndex[source];
    if (sIdx < 0 || sIdx >= seeds.length) return;
    var dist = path.rawDist[source];
    if (dist >= BIG) return;
    var turns = path.steps[source];
    if (turns >= BIG || turns <= 0) return;
    var sd = seeds[sIdx];
    var pressure = sourceArmy * 2.2 - dist * 10.5 + sd.bias;
    if (self.isEnemyOcc(out.sourcePlayer)) {
      var intel = self.intelWeight();
      pressure +=
        Math.min(self.hiddenReserveEst[out.sourcePlayer], 40) *
        (sd.target === self.myGeneral ? 0.16 : 0.09) *
        intel;
      pressure +=
        Math.max(0, self.hiddenReserveDelta[out.sourcePlayer]) *
        (sd.target === self.myGeneral ? 0.45 : 0.2) *
        intel;
    }
    if (
      out.bestPath === null ||
      pressure > out.bestPressure + EPS ||
      (Math.abs(pressure - out.bestPressure) <= EPS && sd.rank < out.bestRank)
    ) {
      out.bestPath = path;
      out.bestSeed = sd;
      out.bestPressure = pressure;
      out.bestRank = sd.rank;
    }
  };

  var n = this.N;
  for (var src = 0; src < n; src++) {
    var sourceArmy = 0;
    var visibleSource = false;
    var recentSource = false;
    var sourcePlayer = -1;
    var valid = false;
    if (this.isEnemy(src) && this.tArmy[src] > 1) {
      sourceArmy = this.tArmy[src];
      valid = true;
      visibleSource = true;
      sourcePlayer = this.tOcc[src];
    } else if (this.recentEnemyAt(src, 2) && this.memArmy[src] > 1) {
      sourceArmy = this.memArmy[src];
      valid = true;
      recentSource = true;
      sourcePlayer = this.memOcc[src];
    }
    if (!valid) continue;

    var out = {
      bestPath: null,
      bestSeed: null,
      bestPressure: -1e100,
      bestRank: BIG,
      sourcePlayer: sourcePlayer
    };
    if (recentSource && !this.coreZone[src]) {
      consider(closePath, allSeeds, src, sourceArmy, out);
    } else {
      consider(limitedPath, limitedSeeds, src, sourceArmy, out);
      consider(positivePath, positiveSeeds, src, sourceArmy, out);
    }
    if (!out.bestPath || !out.bestSeed) continue;

    var route = this.reconstructThreatRoute(src, out.bestPath);
    if (!route.length) continue;

    var info = {
      source: src,
      target: out.bestSeed.target,
      route: route,
      intercept: route[Math.min(1, route.length - 1)],
      sourceArmy: sourceArmy,
      turns: out.bestPath.steps[src],
      visibleSource: visibleSource,
      recentSource: recentSource,
      pressure: out.bestPressure,
      valid: true
    };
    if (!best || info.pressure > best.pressure + EPS) best = info;
  }
  return best;
};

OimAgent.prototype.shouldDefend = function (threat, m) {
  if (!threat || !threat.valid) return false;
  var targetPressure = this.enemyPressure[threat.target] - this.friendlyPressure[threat.target];
  if (threat.target === this.myGeneral) {
    if (threat.turns <= 3) return true;
    if (m.coreRisk > 8 && threat.turns <= 6) return true;
    if (targetPressure > 8 && threat.turns <= 5 && threat.sourceArmy + 2 >= this.tArmy[threat.target]) {
      return true;
    }
    return false;
  }
  return (
    m.frontierPressure > 8 &&
    targetPressure > 5 &&
    threat.turns <= 4 &&
    threat.pressure > 30
  );
};

/* 敌将已知且我们能在它到达前先斩首 → 不打防守，直接对攻 */
OimAgent.prototype.chooseCounterRacePlan = function (threat, m, fallbackTargetPlayer) {
  if (!threat || this.myGeneral < 0 || threat.target !== this.myGeneral) return null;
  if (!this.duelMode()) return null;
  var threatPlayer = this.visibleOrRememberedOcc(threat.source);
  if (!this.isEnemyOcc(threatPlayer)) threatPlayer = fallbackTargetPlayer;
  if (!this.isEnemyOcc(threatPlayer)) return null;

  var target = this.chooseTargetPlayerGeneral(threatPlayer);
  if (target < 0 || this.knownGeneral[threatPlayer] !== target) return null;

  var counter = {
    score: 360 + Math.max(0, m.conversionAdvantage * 2),
    target: target,
    targetPlayer: threatPlayer,
    attack: true,
    defend: false,
    city: false,
    exploration: false
  };
  var plan = this.evaluateObjectivePlan(counter, m);
  if (!plan || plan.usingRally) return null;
  if (!plan.route.length) return null;
  if (plan.route.length >= threat.turns) return null;
  if (plan.commitArmy + plan.corridorSupport < plan.need + 1) return null;
  if (!this.moveLooksSafe(plan.move)) return null;
  return plan;
};

OimAgent.prototype.chooseDefensiveMove = function (m, threat) {
  if (!threat || !this.shouldDefend(threat, m)) return null;

  var counterRace = this.chooseCounterRacePlan(threat, m, this.currentTargetPlayer);
  if (counterRace) {
    this.currentObjective = counterRace.target;
    this.currentTargetPlayer = counterRace.targetPlayer;
    this.lockedObjective = counterRace.target;
    this.objectiveLockUntil = this.fullTurn + 6;
    return counterRace.move;
  }

  var base = threat.intercept * 4;
  for (var k = 0; k < 4; k++) {
    var from = this.nbr[base + k];
    if (from < 0) continue;
    if (this.tOcc[from] !== this.id) continue;
    if (this.tArmy[from] <= this.estimatedArmyAt(threat.intercept) + 1) continue;
    var mv = { from: from, to: threat.intercept, split: false };
    if (this.moveLooksSafe(mv)) return mv;
  }

  var defenseObjectives = [];
  defenseObjectives.push(this.objective(240, threat.intercept, this.currentTargetPlayer, true, true, false, false));
  defenseObjectives.push(this.objective(210, threat.source, this.currentTargetPlayer, true, true, false, false));
  for (var i = 0; i < threat.route.length && i < 3; i++) {
    defenseObjectives.push(
      this.objective(190 - i * 14, threat.route[i], this.currentTargetPlayer, true, true, false, false)
    );
  }

  var best = null;
  for (var d = 0; d < defenseObjectives.length; d++) {
    var plan = this.evaluateObjectivePlan(defenseObjectives[d], m);
    if (plan && (!best || plan.totalScore > best.totalScore)) best = plan;
  }
  if (!best) return null;
  this.currentObjective = best.target;
  this.lockedObjective = best.target;
  this.objectiveLockUntil = this.fullTurn + 6;
  return best.move;
};

OimAgent.prototype.objective = function (score, target, targetPlayer, attack, defend, city, exploration) {
  return {
    score: score,
    target: target,
    targetPlayer: targetPlayer,
    attack: attack,
    defend: defend,
    city: city,
    exploration: exploration
  };
};

/* ---------------- 目标评估（核心） ---------------- */

OimAgent.prototype.attackPenalty = function (c, allowGeneralDive) {
  var penalty = 2;
  var type = this.memType[c];
  if (type === TY_CITY) penalty += 10;
  if (!this.memEver[c]) penalty += 3;
  if (this.isEnemyOcc(this.memOcc[c])) {
    penalty += Math.min(this.estimatedArmyAt(c), 120) | 0;
    if (type === TY_GENERAL && allowGeneralDive) penalty -= 22;
  } else if (this.memOcc[c] === this.id) {
    penalty -= 3;
  }
  return Math.max(1, penalty);
};

OimAgent.prototype.planningPenalty = function (c, mode, m) {
  var cost = this.attackPenalty(c, true);
  var memType = this.memType[c];
  var netPressure = this.enemyPressure[c] - this.friendlyPressure[c];
  if (mode === M_EXPAND) {
    if (!this.memEver[c]) cost = Math.max(1, cost - 1);
    if (netPressure > 8) cost += (netPressure * 0.06) | 0;
  } else if (mode === M_ATTACK) {
    if (this.isEnemyOcc(this.memOcc[c])) cost = Math.max(1, cost - 2);
    if (this.memOcc[c] === this.id) cost = Math.max(1, cost - 1);
  } else if (mode === M_DEFEND) {
    if (this.myGeneral >= 0 && this.distFromGeneral[c] < BIG) {
      cost -= Math.min(3, (this.distFromGeneral[c] / 2) | 0);
    }
  } else if (mode === M_CONVERT) {
    if (this.isEnemyOcc(this.memOcc[c])) cost = Math.max(1, cost - 3);
    if (!this.memVisible[c]) cost += 1;
    if (m.conversionAdvantage > 0) {
      cost = Math.max(1, cost - Math.floor(Math.min(3, m.conversionAdvantage * 0.08)));
    }
  }
  return Math.max(1, cost);
};

OimAgent.prototype.modeForObjective = function (objective, m) {
  if (objective.defend) return M_DEFEND;
  if (objective.attack && objective.targetPlayer >= 0 && m.conversionAdvantage > 6) {
    return M_CONVERT;
  }
  if (objective.attack) return M_ATTACK;
  return M_EXPAND;
};

OimAgent.prototype.evaluateObjectivePlan = function (objective, m) {
  if (objective.target < 0) return null;
  var self = this;
  var mode = this.modeForObjective(objective, m);
  var expansionBias = this.expansionUrgency(m);
  var revPath = this.weightedReversePath(objective.target, function (c) {
    return self.planningPenalty(c, mode, m);
  });
  if (!revPath.reachable) return null;

  var seeds = [];
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var source = this.friendlyTiles[fi];
    var available = this.availableArmy(source);
    if (available <= 0) continue;
    var dist = revPath.dist[source];
    if (dist >= BIG) continue;
    var score = available * 9.6 - dist * 3.3 - this.reserveArmy[source] * 0.8;
    if (source === this.myGeneral) {
      score -= this.relaxedGeneralOpening() ? 0.2 : 1.5 + m.coreRisk * 0.08;
    }
    if (this.choke[source]) score -= 6;
    if (objective.defend && this.distFromGeneral[source] < BIG) {
      score += Math.max(0, 8 - this.distFromGeneral[source]) * 3;
    }
    if (objective.attack && this.isEnemyOcc(this.memOcc[objective.target])) score += 18;
    seeds.push({
      source: source,
      available: available,
      reserve: this.reserveArmy[source],
      dist: dist,
      score: score
    });
  }
  if (!seeds.length) return null;
  seeds.sort(function (a, b) {
    return b.score - a.score;
  });
  var sourceLimit = Math.max(
    4,
    Math.min(10, 4 + ((m.mobilityScore * 0.08) | 0) + ((expansionBias * 0.12) | 0))
  );
  if (seeds.length > sourceLimit) seeds.length = sourceLimit;

  var best = null;
  for (var si = 0; si < seeds.length; si++) {
    var seed = seeds[si];
    var route = this.reconstructReversePath(seed.source, objective.target, revPath);
    if (!route.length) continue;
    var firstStep = route[0];
    if (this.shouldBlockOscillation(seed.source, firstStep)) continue;

    var plan = {
      source: seed.source,
      target: objective.target,
      firstStep: firstStep,
      route: route,
      targetPlayer: objective.targetPlayer,
      mode: mode,
      sourceArmy: this.tArmy[seed.source],
      commitArmy: seed.available,
      reserve: seed.reserve,
      corridorSupport: this.supportAlongRoute(seed.source, route),
      need: this.estimateObjectiveNeed(objective.target, route.length, mode),
      objectiveScore: objective.score,
      pathCost: seed.dist,
      move: { from: seed.source, to: firstStep, split: false },
      usingRally: false,
      valid: true
    };
    plan.rally = plan.commitArmy + plan.corridorSupport < plan.need;
    var lead = this.friendlyLeadSteps(route);

    var routeGain = 0;
    for (var ri = 0; ri < route.length && ri < 4; ri++) {
      var step = route[ri];
      if (this.isEnemy(step) || this.isEnemyOcc(this.memOcc[step])) {
        routeGain += 22 - ri * 3;
      }
      if (!this.memEver[step] || !this.tVisible[step]) {
        routeGain += 12 - ri * 1.5;
      }
      if (this.tType[step] === TY_CITY || this.memType[step] === TY_CITY) routeGain += 24;
    }

    var score2 = objective.score * 1.2 + seed.score;
    score2 += plan.corridorSupport * 2.8;
    score2 += routeGain;
    score2 -= seed.dist * 2.4;
    if (mode === M_EXPAND) {
      score2 -= lead * 26;
      if (lead === 0) score2 += 24;
      else if (lead === 1) score2 += 6;
    } else if (lead >= 2) {
      score2 -= lead * 8;
    }
    if (plan.commitArmy + plan.corridorSupport >= plan.need) score2 += 96;
    else score2 -= (plan.need - (plan.commitArmy + plan.corridorSupport)) * 0.8;
    if (objective.attack) score2 += 28;
    if (objective.attack && (m.contactDensity > 0.045 || m.conversionAdvantage > 8)) score2 += 32;
    if (objective.city) {
      score2 += 42 + expansionBias * 2.4;
      if (m.contactDensity < 0.08) score2 += 24;
      if (lead === 0) score2 += 18;
    }
    if (objective.exploration) score2 += 12 + expansionBias * 1.6;
    if (
      mode === M_ATTACK &&
      expansionBias > 8 &&
      m.contactDensity < 0.08 &&
      m.conversionAdvantage < 8
    ) {
      score2 -= expansionBias * 2.1;
    }
    if (this.currentObjective === objective.target) score2 += 8;
    if (this.lockedObjective === objective.target && this.fullTurn <= this.objectiveLockUntil) {
      score2 += 10;
    }
    if (seed.source === this.myGeneral && !objective.defend) {
      score2 -= 1 + m.coreRisk * 0.08;
    }

    var directFeasible = this.immediateAdvancePossible(seed.source, firstStep);
    if (!directFeasible || this.shouldPreferRally(plan, m)) {
      var rallyMove = this.chooseRallyMove(plan, m);
      if (rallyMove) {
        plan.move = rallyMove;
        plan.usingRally = true;
        score2 += 12;
      } else if (!directFeasible) {
        continue;
      } else if (plan.commitArmy + plan.corridorSupport < plan.need) {
        score2 -= 12;
      }
    } else {
      score2 += 10;
    }

    score2 += this.captureTimingBonus(seed.source, firstStep);

    if (objective.city && plan.commitArmy + plan.corridorSupport + 2 < plan.need && !plan.usingRally) {
      continue;
    }
    var risk = this.moveRiskPenalty(plan.move, m);
    if (risk >= 1e8) continue;
    score2 -= risk;

    plan.totalScore = score2;
    if (!best || plan.totalScore > best.totalScore) best = plan;
  }
  return best;
};

/* ---------------- 四个快路径 ---------------- */

OimAgent.prototype.chooseDirectCaptureMove = function (targetPlayer, m) {
  var best = null;
  var bestScore = -1e100;
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var from = this.friendlyTiles[fi];
    var srcArmy = this.tArmy[from];
    if (srcArmy <= 1) continue;
    var base = from * 4;
    for (var k = 0; k < 4; k++) {
      var to = this.nbr[base + k];
      if (to < 0) continue;
      // 原版这里用的是 tile.type（不是记忆类型），迷雾里的障碍在这一步不算山
      if (this.tVisible[to] && this.tType[to] === TY_MOUNTAIN) continue;
      if (this.tOcc[to] === this.id) continue;
      if (this.shouldBlockOscillation(from, to)) continue;

      var attack = srcArmy - 1;
      var defense = this.estimatedArmyAt(to);
      if (attack <= defense) continue;

      var move = { from: from, to: to, split: false };
      var risk = this.moveRiskPenalty(move, m);
      if (risk >= 1e8) continue;

      var margin = attack - defense;
      var enemyTile = this.isEnemy(to);
      var relievesCore =
        this.coreZone[to] === 1 && (enemyTile || this.recentEnemyAt(to) || defense >= 2);
      var tileType = this.tVisible[to] ? this.tType[to] : this.memType[to];
      var tactical =
        tileType === TY_GENERAL ||
        tileType === TY_CITY ||
        (enemyTile && margin >= 3) ||
        relievesCore;
      var score = 0;
      if (tileType === TY_GENERAL) score += 1e6;
      if (tileType === TY_CITY) score += 290 + margin * 8.5;
      if (enemyTile) score += 105 + margin * 5.5;
      if (this.tOcc[to] === targetPlayer) score += 45;
      if (this.currentObjective === to) score += tactical ? 18 : 6;
      if (relievesCore) score += 45;
      if (tileType === TY_MOUNTAIN) score -= 20;
      if (!this.tVisible[to] && !this.memEver[to]) score += tactical ? 6 : -8;
      if (!enemyTile && tileType !== TY_CITY) score -= 26;
      score += this.captureTimingBonus(from, to);
      score -= risk;

      if (score > bestScore) {
        bestScore = score;
        best = {
          from: from,
          to: to,
          score: score,
          riskPenalty: risk,
          source: from,
          target: to,
          mode: enemyTile ? M_ATTACK : M_EXPAND,
          tactical: tactical,
          relievesCore: relievesCore,
          valid: true
        };
      }
    }
  }
  return best;
};

/* 小图决斗的"贴脸压迫"：目标只有一格，出兵格按兵力-距离选 */
OimAgent.prototype.chooseTinyDuelPressureMove = function (targetPlayer, m) {
  if (!this.duelMode() || this.mapArea() > 400) return null;
  if (this.fullTurn < 14 || this.fullTurn > 70) return null;
  if (m.coreRisk > 10) return null;

  var target = this.chooseTargetPlayerGeneral(targetPlayer);
  if (target < 0) {
    var cr = (((this.H + 1) / 2) | 0) - 1;
    var cc = (((this.W + 1) / 2) | 0) - 1;
    target = cr * this.W + cc;
  }
  if (target < 0 || !this.memPassable(target)) return null;

  var self = this;
  var seeds = [];
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var source = this.friendlyTiles[fi];
    var available = this.availableArmy(source);
    if (available <= 0) continue;
    var score = available * 8.4 - this.reserveArmy[source] * 1.0;
    score -= this.manhattan(source, target) * 1.4;
    if (source === this.myGeneral) score -= this.relaxedGeneralOpening() ? 1 : 3;
    if (this.choke[source]) score -= 5;
    seeds.push({ source: source, score: score });
  }
  if (!seeds.length) return null;
  seeds.sort(function (a, b) {
    return b.score - a.score;
  });
  if (seeds.length > 5) seeds.length = 5;

  var best = null;
  var bestScore = -1e100;
  for (var si = 0; si < seeds.length; si++) {
    var seed = seeds[si];
    var src = seed.source;
    var path = this.weightedPath(src, function (c) {
      var cost = 2;
      if (!self.memEver[c]) cost -= 1;
      if (!self.tVisible[c]) cost -= 1;
      if (self.memType[c] === TY_CITY || (self.tVisible[c] && self.tType[c] === TY_CITY)) {
        cost += Math.max(5, (self.estimatedArmyAt(c) / 4) | 0);
      }
      if (self.isEnemyOcc(self.visibleOrRememberedOcc(c))) {
        cost += Math.max(0, (self.estimatedArmyAt(c) / 6) | 0);
      }
      return Math.max(1, cost);
    });

    var dist = path.dist[target];
    var firstStep = path.first[target];
    if (dist >= BIG || firstStep < 0) continue;
    if (!this.immediateAdvancePossible(src, firstStep)) continue;

    var move = { from: src, to: firstStep, split: false };
    var risk = this.moveRiskPenalty(move, m);
    if (risk >= 1e8) continue;

    var sc = seed.score - dist * 8.2;
    sc += this.duelExpansionHeatAt(firstStep) * 1.0;
    sc += this.localExpansionPotential(firstStep) * 2.0;
    sc += this.captureTimingBonus(src, firstStep);
    sc += Math.max(0, m.conversionAdvantage) * 2.8;
    if (this.currentObjective >= 0) sc -= this.manhattan(firstStep, this.currentObjective) * 0.7;
    var occ = this.visibleOrRememberedOcc(firstStep);
    if (this.isEnemyOcc(occ)) sc += 18;
    if (!this.memEver[firstStep]) sc += 8;

    if (sc > bestScore) {
      bestScore = sc;
      best = {
        from: src,
        to: firstStep,
        score: sc - risk,
        riskPenalty: risk,
        source: src,
        target: target,
        mode: M_ATTACK,
        tactical: true,
        relievesCore: false,
        valid: true
      };
    }
  }
  if (!best || best.score < 95) return null;
  this.currentObjective = best.target;
  return best;
};

/* 决斗节奏：种子出兵格 × 可达目标扫描（这是它拉开差距的地方之一） */
OimAgent.prototype.chooseDuelTempoMove = function (targetPlayer, m) {
  if (!this.inDuelTempoPhase(m)) return null;
  var self = this;
  var seeds = [];
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var source = this.friendlyTiles[fi];
    var available = this.availableArmy(source);
    if (available <= 0) continue;
    var score = available * 7.3 - this.reserveArmy[source] * 0.9;
    if (source === this.myGeneral) score -= this.relaxedGeneralOpening() ? 1 : 4.5;
    if (this.choke[source]) score -= 5.5;
    seeds.push({ source: source, available: available, score: score });
  }
  if (!seeds.length) return null;
  var isFrontier = this.frontierMask();
  for (var si = 0; si < seeds.length; si++) {
    if (isFrontier[seeds[si].source]) seeds[si].score += 9;
    seeds[si].score += this.duelExpansionHeatAt(seeds[si].source) * 0.2;
  }
  seeds.sort(function (a, b) {
    return b.score - a.score;
  });
  var seedLimit = Math.max(5, Math.min(8, this.mapArea() >= 520 ? 8 : 6));
  if (seeds.length > seedLimit) seeds.length = seedLimit;

  var targetGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var hasTargetGuess =
    targetGuess >= 0 &&
    targetPlayer >= 0 &&
    !!this.cachedHasEvidence[targetPlayer];
  var turnsUntil = this.turnsUntilNextGlobalGrowth();
  var landTempo = turnsUntil === 0 ? 1.25 : turnsUntil <= 3 ? 1.12 : 1.0;

  var best = null;
  var bestScore = -1e100;
  for (var s2 = 0; s2 < seeds.length; s2++) {
    var seed = seeds[s2];
    var src = seed.source;
    var path = this.weightedPath(src, function (c) {
      var cost = 2;
      if (!self.memEver[c]) cost -= 1;
      else if (!self.tVisible[c]) cost -= 1;
      if (self.memType[c] === TY_CITY || (self.tVisible[c] && self.tType[c] === TY_CITY)) {
        cost += Math.max(3, (self.estimatedArmyAt(c) / 6) | 0);
      }
      if (self.isEnemyOcc(self.visibleOrRememberedOcc(c))) {
        cost += Math.max(0, (self.estimatedArmyAt(c) / 8) | 0);
      }
      return Math.max(1, cost);
    });
    var reach = Math.max(
      8,
      Math.min(
        this.mapArea() >= 650 ? 14 : 12,
        8 + ((seed.available / 6) | 0) + (this.mapArea() >= 520 ? 2 : 0)
      )
    );

    for (var t = 0; t < this.N; t++) {
      var dist = path.dist[t];
      if (dist >= BIG || dist > reach) continue;
      if (!this.memPassable(t) || this.tOcc[t] === this.id) continue;
      var occ = this.visibleOrRememberedOcc(t);
      var enemy = this.isEnemyOcc(occ);
      var typeT = this.tVisible[t] ? this.tType[t] : this.memType[t];
      var city = typeT === TY_CITY || this.memType[t] === TY_CITY;
      var exploration = !this.memEver[t] || !this.tVisible[t];
      var firstStep = path.first[t];
      if (firstStep < 0) continue;
      if (!this.immediateAdvancePossible(src, firstStep)) continue;

      var sc = seed.score - dist * 5;
      sc += this.duelExpansionHeatAt(t) * 3;
      sc += this.localExpansionPotential(t) * 1.8;
      if (exploration) sc += 20 * landTempo;
      if (!this.tVisible[t]) sc += 12 * landTempo;
      if (enemy) {
        sc -= 20 + this.estimatedArmyAt(t) * 0.35;
        if (occ === targetPlayer && this.fullTurn >= 36) sc += 24;
      }
      if (city) {
        sc += 84 - this.estimatedArmyAt(t) * 2;
        if (this.fullTurn < 26) sc -= 14;
      }
      if (hasTargetGuess) sc += Math.max(0, 18 - this.manhattan(t, targetGuess) * 1.35);
      var leadHere = path.lead[t];
      if (leadHere === 0) sc += 14;
      else if (leadHere > 2) sc -= 18;

      var move = { from: src, to: firstStep, split: false };
      var risk = this.moveRiskPenalty(move, m);
      if (risk >= 1e8) continue;
      sc += this.captureTimingBonus(src, firstStep);
      sc -= risk;

      if (sc > bestScore) {
        bestScore = sc;
        best = {
          from: src,
          to: firstStep,
          score: sc,
          riskPenalty: risk,
          source: src,
          target: t,
          mode: enemy ? M_ATTACK : M_EXPAND,
          tactical: city || enemy,
          relievesCore: false,
          valid: true
        };
      }
    }
  }
  if (!best || best.score < 140) return null;
  this.currentObjective = best.target;
  return best;
};

OimAgent.prototype.frontierMask = function () {
  if (!this._frontierMask) this._frontierMask = new Uint8Array(this.N);
  var mask = this._frontierMask;
  mask.fill(0);
  for (var i = 0; i < this.frontierTiles.length; i++) mask[this.frontierTiles[i]] = 1;
  return mask;
};

/* ---------------- 开局 ---------------- */

OimAgent.prototype.inOpeningPhase = function (m) {
  if (!this.duelMode()) return false;
  if (this.mapArea() > 450) return false;
  var limit = this.mapArea() >= 500 ? 26 : 20;
  if (this.fullTurn > limit) return false;
  if (m.contactDensity > 0.06) return false;
  if (m.coreRisk > 9) return false;
  return true;
};

OimAgent.prototype.shouldAvoidOpeningSwamp = function (c) {
  // 本图没有沼泽，恒 false（留结构）
  return false;
};

/* 开局 rollout：从最肥的几个出兵格各走一步，向后 DFS 3~5 层给这一步估价 */
OimAgent.prototype.chooseOpeningRolloutMove = function (targetPlayer, m) {
  if (!this.inOpeningPhase(m) || this.myGeneral < 0) return null;
  var self = this;
  var N = this.N;

  var seeds = [];
  var isFrontier = this.frontierMask();
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var source = this.friendlyTiles[fi];
    if (this.tArmy[source] <= 1) continue;
    var score = this.tArmy[source] * 7 - this.reserveArmy[source] * 1.4;
    if (source === this.myGeneral) score += this.relaxedGeneralOpening() ? 8 : 2;
    score += this.duelExpansionHeatAt(source) * 0.2;
    score += this.localExpansionPotential(source) * 1.2;
    if (isFrontier[source]) score += 12;
    seeds.push({ source: source, score: score });
  }
  if (!seeds.length) return null;
  seeds.sort(function (a, b) {
    return b.score - a.score;
  });
  if (seeds.length > 5) seeds.length = 5;

  var enemyGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var hasGuess = enemyGuess >= 0;
  var guessWeight = hasGuess
    ? targetPlayer >= 0 && this.cachedHasEvidence[targetPlayer]
      ? 1.0
      : 0.55
    : 0.0;
  var horizon = Math.max(3, Math.min(5, 3 + ((this.fullTurn / 6) | 0)));
  var pathMark = new Uint8Array(N);
  var fullTurn = this.fullTurn;

  var stepGetsGlobalGrowthTick = function (offset) {
    return (fullTurn + offset) % 25 === 0;
  };

  var dfs = function (cur, movingArmy, depth) {
    if (depth >= horizon || movingArmy <= 1) {
      var tail = movingArmy * 5.5;
      tail += self.localExpansionPotential(cur) * 5;
      tail += self.duelExpansionHeatAt(cur) * 1.6;
      return tail;
    }
    var bestFuture = movingArmy * 4 + self.duelExpansionHeatAt(cur) * 1.2;
    var base = cur * 4;
    for (var k = 0; k < 4; k++) {
      var nxt = self.nbr[base + k];
      if (nxt < 0) continue;
      if (pathMark[nxt]) continue;
      if (!self.memPassable(nxt)) continue;
      var occ = self.tVisible[nxt] ? self.tOcc[nxt] : self.memOcc[nxt];
      if (occ === self.id) continue;
      var defense = self.estimatedArmyAt(nxt);
      if (movingArmy - 1 <= defense) continue;
      var after = movingArmy - 1 - defense;
      if (after <= 0) continue;

      var enemy = self.isEnemyOcc(occ);
      var typeN = self.tVisible[nxt] ? self.tType[nxt] : self.memType[nxt];
      var city = typeN === TY_CITY || self.memType[nxt] === TY_CITY;
      var gain = 0;
      if (!self.memEver[nxt]) gain += 44;
      else if (!self.tVisible[nxt]) gain += 24;
      else if (occ < 0) gain += 12;
      if (enemy) gain += 9;
      gain += self.localExpansionPotential(nxt) * 7.8;
      gain += self.duelExpansionHeatAt(nxt) * 2.1;
      gain += Math.max(0, 20 - self.centerDist(nxt) * 0.55);
      if (hasGuess) {
        gain += Math.max(0, 26 - self.manhattan(nxt, enemyGuess) * 1.7) * guessWeight;
      }
      if (city) {
        gain += 38 - self.estimatedArmyAt(nxt) * 1.1;
        if (fullTurn + depth < 18) gain -= 18;
      }
      if (stepGetsGlobalGrowthTick(depth)) gain += 12;
      if (after <= 2) gain -= 10;

      var frontierOptions = 0;
      var nb2 = nxt * 4;
      for (var k2 = 0; k2 < 4; k2++) {
        var adj = self.nbr[nb2 + k2];
        if (adj < 0) continue;
        if (!self.memPassable(adj)) continue;
        var adjOcc = self.tVisible[adj] ? self.tOcc[adj] : self.memOcc[adj];
        if (adjOcc !== self.id && !pathMark[adj]) frontierOptions++;
      }
      gain += frontierOptions * 4.5;

      pathMark[nxt] = 1;
      gain += 0.82 * dfs(nxt, after, depth + 1);
      pathMark[nxt] = 0;
      if (gain > bestFuture) bestFuture = gain;
    }
    return bestFuture;
  };

  var best = null;
  var bestScore = -1e100;
  for (var si = 0; si < seeds.length; si++) {
    var src = seeds[si].source;
    var srcArmy = this.tArmy[src];
    var base2 = src * 4;
    for (var d = 0; d < 4; d++) {
      var to = this.nbr[base2 + d];
      if (to < 0) continue;
      if (this.shouldBlockOscillation(src, to)) continue;
      if (!this.memPassable(to)) continue;
      var occ2 = this.tVisible[to] ? this.tOcc[to] : this.memOcc[to];
      if (occ2 === this.id) continue;
      var defense2 = this.estimatedArmyAt(to);
      if (srcArmy - 1 <= defense2) continue;
      var after2 = srcArmy - 1 - defense2;
      if (after2 <= 0) continue;

      var move = { from: src, to: to, split: false };
      var risk = this.moveRiskPenalty(move, m);
      if (risk >= 1e8) continue;

      var sc = seeds[si].score;
      sc += this.captureTimingBonus(src, to);
      sc += this.localExpansionPotential(to) * 7.5;
      sc += this.duelExpansionHeatAt(to) * 2.6;
      if (!this.memEver[to]) sc += 52;
      else if (!this.tVisible[to]) sc += 28;
      if (hasGuess) sc += Math.max(0, 32 - this.manhattan(to, enemyGuess) * 1.9) * guessWeight;
      pathMark[src] = 1;
      pathMark[to] = 1;
      sc += 0.84 * dfs(to, after2, 1);
      pathMark[to] = 0;
      pathMark[src] = 0;
      sc -= risk;

      if (sc > bestScore) {
        bestScore = sc;
        best = {
          from: src,
          to: to,
          score: sc,
          riskPenalty: risk,
          source: src,
          target: to,
          mode: M_EXPAND,
          tactical: false,
          relievesCore: false,
          valid: true
        };
      }
    }
  }
  if (!best || best.score < 110) return null;
  this.currentObjective = best.target;
  this.openingTarget = best.target;
  this.openingTargetUntil = this.fullTurn + 3;
  return best;
};

/* 开局单目标：找一个 reach 内、中心度高、扩张潜力大的格子 */
OimAgent.prototype.chooseOpeningMove = function (targetPlayer, m) {
  if (!this.inOpeningPhase(m) || this.myGeneral < 0) return null;
  var self = this;
  var source = this.myGeneral;
  if (this.tArmy[source] <= 1) source = this.strongestFriendlyTile(true, -1, 0);
  if (source < 0 || this.tArmy[source] <= 1) return null;

  var enemyGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var canChaseGuess =
    targetPlayer >= 0 && !!this.cachedHasEvidence[targetPlayer];
  var reach = Math.max(
    4,
    Math.min(7, 4 + ((this.tArmy[source] / 8) | 0) + (this.mapArea() >= 500 ? 1 : 0))
  );

  var path = this.weightedPath(source, function (c) {
    var cost = 2;
    if (!self.memEver[c]) cost -= 1;
    if (!self.tVisible[c]) cost -= 1;
    var typeC = self.tVisible[c] ? self.tType[c] : self.memType[c];
    if (typeC === TY_CITY || self.memType[c] === TY_CITY) {
      cost += Math.max(4, (self.estimatedArmyAt(c) / 3) | 0);
    }
    if (self.isEnemy(c)) cost += Math.max(0, (self.estimatedArmyAt(c) / 4) | 0);
    return Math.max(1, cost);
  });

  var bestTarget = -1;
  var bestScore = -1e100;
  for (var t = 0; t < this.N; t++) {
    var dist = path.dist[t];
    if (dist >= BIG || dist > reach) continue;
    if (!this.memPassable(t)) continue;
    if (this.tOcc[t] === this.id) continue;
    var enemy = this.isEnemy(t);
    var typeT = this.tVisible[t] ? this.tType[t] : this.memType[t];
    var city = typeT === TY_CITY || this.memType[t] === TY_CITY;

    var sc = 0;
    if (!this.memEver[t]) sc += 120;
    if (!this.tVisible[t]) sc += 36;
    if (this.tOcc[t] < 0 && !city) sc += 18;
    sc += this.localExpansionPotential(t) * 8.5;
    sc += this.captureTimingBonus(source, path.first[t]);
    sc -= dist * 9;
    sc += Math.max(0, 18 - this.centerDist(t) * 0.45);

    if (city) {
      var need = this.estimatedArmyAt(t) + 2;
      if (this.tArmy[source] - 1 < need) continue;
      sc += 220 - this.estimatedArmyAt(t) * 5.5;
    }
    if (enemy) {
      if (this.tArmy[source] - 1 <= this.estimatedArmyAt(t)) continue;
      sc += 46 + this.estimatedArmyAt(t) * 0.8;
    }
    if (t === this.openingTarget && this.fullTurn <= this.openingTargetUntil) sc += 28;
    if (enemyGuess >= 0 && canChaseGuess && this.fullTurn >= 8) {
      sc += Math.max(0, 28 - this.manhattan(t, enemyGuess) * 1.6);
    }
    if (sc > bestScore) {
      bestScore = sc;
      bestTarget = t;
    }
  }

  if (bestTarget < 0) return null;
  var firstStep = path.first[bestTarget];
  if (firstStep < 0) return null;
  var move = { from: source, to: firstStep, split: false };
  if (!this.moveLooksSafe(move)) return null;
  this.openingTarget = bestTarget;
  this.openingTargetUntil = this.fullTurn + 4;
  this.currentObjective = bestTarget;
  return move;
};

/* ---------------- 目标候选生成 ---------------- */

OimAgent.prototype.buildObjectiveCandidates = function (targetPlayer, m, threat) {
  var self = this;
  var defenseOptions = [];
  var assaultOptions = [];
  var cityOptions = [];
  var pressureOptions = [];
  var expandOptions = [];

  var addObjective = function (option) {
    if (option.target < 0) return;
    if (!self.memPassable(option.target)) return;
    if (self.tOcc[option.target] === self.id) return;
    if (option.defend) defenseOptions.push(option);
    else if (option.city) cityOptions.push(option);
    else if (option.attack) assaultOptions.push(option);
    else if (option.exploration) expandOptions.push(option);
    else pressureOptions.push(option);
  };

  if (threat && threat.valid) {
    addObjective(this.objective(250, threat.intercept, targetPlayer, true, true, false, false));
    addObjective(this.objective(220, threat.source, targetPlayer, true, true, false, false));
  }

  var targetGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var duelSmallAggression = this.duelMode() && this.mapArea() <= 450 ? 1 : 0;
  var enemyContactSignal =
    targetPlayer >= 0
      ? this.visibleEnemyCount[targetPlayer] + this.newlyVisibleEnemy[targetPlayer]
      : 0;
  var shouldPressureTarget =
    enemyContactSignal > 0 ||
    m.contactDensity > 0.045 ||
    (duelSmallAggression > 0 && this.fullTurn >= 16) ||
    m.conversionAdvantage > 8;
  var expansionBias = this.expansionUrgency(m);
  var expansionIntel = this.duelMode() ? 1 : 0;
  var canChaseGuess =
    targetPlayer >= 0 &&
    (!!this.cachedHasEvidence[targetPlayer] ||
      (duelSmallAggression > 0 && this.fullTurn >= 12 && targetGuess >= 0));
  if (targetGuess >= 0 && canChaseGuess) {
    addObjective(
      this.objective(
        230 - expansionBias * 2.6 + duelSmallAggression * 36,
        targetGuess,
        targetPlayer,
        true,
        false,
        false,
        false
      )
    );
    var gbase = targetGuess * 4;
    for (var gk = 0; gk < 4; gk++) {
      var adj = this.nbr[gbase + gk];
      if (adj < 0) continue;
      addObjective(
        this.objective(
          180 - expansionBias * 2 + duelSmallAggression * 28,
          adj,
          targetPlayer,
          true,
          false,
          false,
          false
        )
      );
    }
  }

  for (var c = 0; c < this.N; c++) {
    if (!this.memPassable(c)) continue;
    if (this.tOcc[c] === this.id) continue;
    var occ = this.tVisible[c] ? this.tOcc[c] : this.memOcc[c];
    var enemy = this.isEnemyOcc(occ);
    var typeC = this.tVisible[c] ? this.tType[c] : this.memType[c];
    var city = typeC === TY_CITY || this.memType[c] === TY_CITY;
    var exploration = !this.memEver[c] || !this.tVisible[c];
    var score = 0;
    if (enemy) {
      score += 62 + Math.min(this.estimatedArmyAt(c), 80) * 0.45;
      if (shouldPressureTarget) score += 24;
      score += duelSmallAggression * 14;
    } else {
      score += 22;
    }
    if (occ === targetPlayer) {
      score += shouldPressureTarget
        ? 92 + duelSmallAggression * 24
        : 50 + duelSmallAggression * 16;
    }
    if (city) {
      score += 236 - this.estimatedArmyAt(c) * 2.8;
      score += expansionBias * 3.6;
      if (m.contactDensity < 0.08) score += 32;
      if (m.conversionAdvantage < 6) score += Math.max(0, 12 - m.conversionAdvantage);
      if (enemy) score += shouldPressureTarget ? 32 : 12;
    }
    if (!this.memEver[c]) {
      score += 86 - m.contactDensity * 12 + Math.max(0, -m.conversionAdvantage * 1.2);
      score += expansionBias * 2.8;
      if (shouldPressureTarget) score -= 22;
    }
    if (!enemy) score += this.duelExpansionHeatAt(c) * 0.95 * expansionIntel * this.duelExpansionPlanningWeight();
    if (!enemy) score += this.localExpansionPotential(c) * 2.8 * expansionIntel;
    if (!this.tVisible[c]) score += 20;
    if (this.currentObjective === c) score += 10;
    if (this.lockedObjective === c && this.fullTurn <= this.objectiveLockUntil) score += 12;
    if (targetGuess >= 0 && canChaseGuess) {
      score += Math.max(0, 52 - this.manhattan(c, targetGuess) * 3.2);
    }
    if (this.myGeneral >= 0) {
      score -= this.manhattan(c, this.myGeneral) * (m.coreRisk > 12 ? 0.85 : 0.35);
    }
    var netPressure = this.enemyPressure[c] - this.friendlyPressure[c];
    if (!enemy && netPressure > 0) score -= netPressure * 0.25;
    if (enemy && m.conversionAdvantage > 0) {
      score += Math.min(30, m.conversionAdvantage * 2.5);
    } else if (enemy && m.conversionAdvantage < 0) {
      score -= Math.min(42, -m.conversionAdvantage * 2.6);
    }
    if (!enemy && shouldPressureTarget && !city && !exploration) {
      score -= 26 + expansionBias * 1.4;
    }
    if (enemy && !city && !exploration && m.contactDensity < 0.08 && m.conversionAdvantage < 4) {
      score -= 48 + expansionBias * 2;
    }

    var option = this.objective(
      score,
      c,
      occ >= 0 ? occ : targetPlayer,
      enemy,
      false,
      city,
      exploration
    );
    var nearGuess =
      targetGuess >= 0 && canChaseGuess && this.manhattan(c, targetGuess) <= 4;
    if (enemy && (occ === targetPlayer || nearGuess)) {
      option.score += 18 + duelSmallAggression * 22;
      assaultOptions.push(option);
    } else if (city) {
      cityOptions.push(option);
    } else if (enemy) {
      pressureOptions.push(option);
    } else if (exploration) {
      expandOptions.push(option);
    } else {
      pressureOptions.push(option);
    }
  }

  var byScore = function (a, b) {
    return b.score - a.score;
  };
  defenseOptions.sort(byScore);
  assaultOptions.sort(byScore);
  cityOptions.sort(byScore);
  pressureOptions.sort(byScore);
  expandOptions.sort(byScore);

  var objectiveLimit = Math.max(
    8,
    Math.min(18, 8 + ((m.mobilityScore * 0.12 - m.coreRisk * 0.04 + expansionBias * 0.22) | 0))
  );
  var unique = [];
  var seen = new Uint8Array(this.N);
  var appendBucket = function (bucket, limit) {
    var taken = 0;
    for (var i = 0; i < bucket.length; i++) {
      if (taken >= limit || unique.length >= objectiveLimit) break;
      var node = bucket[i].target;
      if (seen[node]) continue;
      seen[node] = 1;
      unique.push(bucket[i]);
      taken++;
    }
  };
  appendBucket(defenseOptions, 4);
  appendBucket(assaultOptions, 5);
  appendBucket(cityOptions, 4 + (expansionBias >= 7 ? 1 : 0));
  appendBucket(pressureOptions, 4);
  appendBucket(expandOptions, 5 + (expansionBias >= 9 ? 1 : 0));

  this.objectiveCandidates = unique;
  return unique;
};

OimAgent.prototype.chooseBestStrategicMove = function (objectives, m) {
  var best = null;
  var bestPlan = null;
  for (var i = 0; i < objectives.length; i++) {
    var plan = this.evaluateObjectivePlan(objectives[i], m);
    if (!plan) continue;
    if (!best || plan.totalScore > best.score) {
      best = {
        from: plan.move.from,
        to: plan.move.to,
        split: false,
        score: plan.totalScore,
        riskPenalty: 0,
        source: plan.source,
        target: plan.target,
        mode: plan.mode,
        tactical: false,
        relievesCore: false,
        valid: true
      };
      bestPlan = plan;
    }
  }
  if (!best) return null;
  this.currentObjective = bestPlan.target;
  if (bestPlan.targetPlayer >= 0) this.currentTargetPlayer = bestPlan.targetPlayer;
  if (bestPlan.mode !== M_EXPAND || bestPlan.objectiveScore >= 170) {
    this.lockedObjective = bestPlan.target;
    this.objectiveLockUntil = this.fullTurn + 12;
  }
  best.riskPenalty = this.moveRiskPenalty(best, m);
  best.tactical = bestPlan.mode !== M_EXPAND || bestPlan.objectiveScore >= 180;
  best.relievesCore = bestPlan.mode === M_DEFEND;
  return best;
};

/* 经济规划器：出兵格 × 全图扫描，看"哪一步之后能滚出最大的雪球" */
OimAgent.prototype.chooseEconomicPlannerMove = function (targetPlayer, m) {
  var self = this;
  var best = null;
  var bestScore = -1e100;
  var targetGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var expansionBias = this.expansionUrgency(m);
  var expansionIntel = this.duelMode() ? 1 : 0;
  var duelSmallAggression = this.duelMode() && this.mapArea() <= 450 ? 1 : 0;

  var seeds = [];
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var source = this.friendlyTiles[fi];
    var available = this.availableArmy(source);
    if (available <= 0) continue;
    var score = available * 6.8 - this.reserveArmy[source] * 1.0;
    if (source === this.myGeneral) score -= this.relaxedGeneralOpening() ? 0.5 : 2.5;
    if (this.choke[source]) score -= 6;
    if (this.currentObjective >= 0) score -= this.manhattan(source, this.currentObjective) * 0.7;
    seeds.push({ source: source, score: score });
  }
  if (!seeds.length) return null;
  seeds.sort(function (a, b) {
    return b.score - a.score;
  });
  var seedLimit = Math.max(5, Math.min(8, 5 + ((expansionBias * 0.18) | 0)));
  if (seeds.length > seedLimit) seeds.length = seedLimit;

  for (var si = 0; si < seeds.length; si++) {
    var seed = seeds[si];
    var src = seed.source;
    var path = this.weightedPath(src, function (c) {
      var cost = self.attackPenalty(c, true);
      var net = self.enemyPressure[c] - self.friendlyPressure[c];
      if (net > 6) cost += (net * 0.05) | 0;
      return Math.max(1, cost);
    });

    for (var t = 0; t < this.N; t++) {
      if (!this.memPassable(t) || this.tOcc[t] === this.id) continue;
      var dist = path.dist[t];
      if (dist >= BIG) continue;
      var firstStep = path.first[t];
      if (firstStep < 0) continue;
      var occ = this.visibleOrRememberedOcc(t);
      var enemy = this.isEnemyOcc(occ);
      var typeT = this.tVisible[t] ? this.tType[t] : this.memType[t];
      var city = typeT === TY_CITY || this.memType[t] === TY_CITY;
      var exploration = !this.memEver[t] || !this.tVisible[t];

      var sc = seed.score - dist * 6.4;
      if (exploration) {
        sc += 80 - m.contactDensity * 12 + Math.max(0, -m.conversionAdvantage);
        sc += expansionBias * 3.2;
      }
      if (!enemy) {
        sc += this.duelExpansionHeatAt(t) * 1.1 * expansionIntel * this.duelExpansionPlanningWeight();
      }
      if (!enemy) sc += this.localExpansionPotential(t) * 3 * expansionIntel;
      if (!this.tVisible[t]) sc += 22;
      if (enemy) sc += 28 + this.estimatedArmyAt(t) * 0.1;
      if (occ === targetPlayer) sc += 18;
      if (city) {
        sc += 224 - this.estimatedArmyAt(t) * 2.5;
        sc += expansionBias * 4;
        if (m.contactDensity < 0.08) sc += 36;
        if (m.conversionAdvantage < 6) sc += Math.max(0, 10 - m.conversionAdvantage);
      }
      if (this.currentObjective === t) sc += 8;
      if (targetGuess >= 0) {
        sc += Math.max(
          0,
          32 + duelSmallAggression * 16 - expansionBias * 1.2 - this.manhattan(t, targetGuess) * 2
        );
      }
      if (this.myGeneral >= 0) {
        sc -= this.manhattan(t, this.myGeneral) * (m.coreRisk > 10 ? 0.6 : 0.2);
      }
      var netPressure = this.enemyPressure[t] - this.friendlyPressure[t];
      if (!enemy && netPressure > 0) sc -= netPressure * 0.18;
      if (!city && !enemy && !exploration) sc -= 28;
      if (enemy && !city && !exploration) {
        sc -= 24 + expansionBias * 1.4 - duelSmallAggression * 16;
      }
      if (enemy && !city && m.contactDensity < 0.08 && m.conversionAdvantage < 4) {
        sc -= 38 + expansionBias * 1.8 - duelSmallAggression * 20;
      }

      var leadHere = path.lead[t];
      sc -= leadHere * 20;
      if (leadHere === 0) sc += 18;
      if (leadHere > 2 && !city) sc -= 20;
      if (!this.immediateAdvancePossible(src, firstStep)) continue;
      var move = { from: src, to: firstStep, split: false };
      var risk = this.moveRiskPenalty(move, m);
      if (risk >= 1e8) continue;
      sc += this.captureTimingBonus(src, firstStep);
      sc -= risk;

      if (sc > bestScore) {
        bestScore = sc;
        best = {
          from: src,
          to: firstStep,
          split: false,
          score: sc,
          riskPenalty: risk,
          source: src,
          target: t,
          mode: enemy ? M_ATTACK : M_EXPAND,
          tactical: city || enemy,
          relievesCore: false,
          valid: true
        };
      }
    }
  }
  return best;
};

OimAgent.prototype.fallbackMove = function (targetPlayer, m) {
  var source = this.strongestFriendlyTile(true, this.currentObjective, 1);
  if (source < 0) return null;
  var expansionIntel = this.duelMode() ? 1 : 0;
  var base = source * 4;
  var bestTarget = -1;
  var bestScore = -1e100;
  for (var k = 0; k < 4; k++) {
    var to = this.nbr[base + k];
    if (to < 0) continue;
    if (this.tVisible[to] && this.tType[to] === TY_MOUNTAIN) continue;
    if (this.shouldBlockOscillation(source, to)) continue;
    var move = { from: source, to: to, split: false };
    var risk = this.moveRiskPenalty(move, m);
    if (risk >= 1e8) continue;

    var occ = this.visibleOrRememberedOcc(to);
    var typeT = this.tVisible[to] ? this.tType[to] : this.memType[to];
    var sc = 0;
    if (!this.memEver[to]) sc += 42;
    if (occ !== this.id) sc += this.localExpansionPotential(to) * 1.6 * expansionIntel;
    if (!this.tVisible[to]) sc += 18;
    if (typeT === TY_CITY) sc += 75 - this.estimatedArmyAt(to) * 2.5;
    if (occ !== this.id) sc += 24;
    if (occ === targetPlayer) sc += 18;
    if (this.currentObjective === to) sc += 12;
    sc += this.captureTimingBonus(source, to);
    sc -= risk;
    if (sc > bestScore) {
      bestScore = sc;
      bestTarget = to;
    }
  }
  if (bestTarget < 0) return null;
  var mv = { from: source, to: bestTarget, split: false };
  if (!this.movePassesHardSafety(mv)) return null;
  return mv;
};

/* ---------------- 决斗扩张热力图 ---------------- */

/*
 * 只在"小图决斗、还没打起来"的阶段算：对每个非后方格做半径 5~8 的 BFS，
 * 累计未探索/空地/城的价值（越近越值钱），再和敌将方向做争夺折扣。
 * 这是 oim 原版独有的东西——它让 bot 早期主动铺向"还没人占的高价值区域"。
 */
OimAgent.prototype.rebuildDuelExpansionHeat = function (targetPlayer, m) {
  var n = this.N;
  this.duelHeat.fill(0);
  if (!this.shouldBuildDuelExpansionHeat(m)) return;
  var kStepDiscount = [0, 1.0, 0.87, 0.75, 0.64, 0.54, 0.46, 0.39, 0.33];
  var radius = this.mapArea() >= 650 ? 8 : this.mapArea() >= 520 ? 7 : 6;
  var turnsUntil = this.turnsUntilNextGlobalGrowth();
  var landTempo = turnsUntil === 0 ? 1.34 : turnsUntil <= 3 ? 1.18 : turnsUntil <= 6 ? 1.08 : 1.0;

  var enemyGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var hasEnemyGuess =
    enemyGuess >= 0 && targetPlayer >= 0 && !!this.cachedHasEvidence[targetPlayer];

  var enemyDist = null;
  if (hasEnemyGuess) {
    enemyDist = new Int32Array(n).fill(-1);
    var q0 = [enemyGuess];
    enemyDist[enemyGuess] = 0;
    for (var h0 = 0; h0 < q0.length; h0++) {
      var cur0 = q0[h0];
      var cd0 = enemyDist[cur0];
      var b0 = cur0 * 4;
      for (var k0 = 0; k0 < 4; k0++) {
        var nx0 = this.nbr[b0 + k0];
        if (nx0 < 0) continue;
        if (enemyDist[nx0] !== -1 || !this.memPassable(nx0)) continue;
        enemyDist[nx0] = cd0 + 1;
        q0.push(nx0);
      }
    }
  }

  var dist = this._heatDist;
  var stampArr = this._heatStamp;
  var q = this._heatQ;
  for (var start = 0; start < n; start++) {
    if (!this.memPassable(start)) continue;
    var startFrontier = this.tOcc[start] !== this.id;
    if (!startFrontier) {
      var sb = start * 4;
      for (var sk = 0; sk < 4; sk++) {
        var adj = this.nbr[sb + sk];
        if (adj < 0) continue;
        if (
          this.tOcc[adj] !== this.id ||
          !this.tVisible[adj] ||
          !this.memEver[adj] ||
          this.recentEnemyAt(adj)
        ) {
          startFrontier = true;
          break;
        }
      }
    }
    if (this.tOcc[start] === this.id && !startFrontier) {
      this.duelHeat[start] = -12;
      continue;
    }

    var tick = ++this._heatTick;
    var qn = 0;
    q[qn++] = start;
    stampArr[start] = tick;
    dist[start] = 0;
    var score = 0;
    if (!this.memEver[start]) score += 14 * landTempo;
    if (!this.tVisible[start]) score += 5;
    if (this.tOcc[start] < 0) score += 3;
    var startType = this.tVisible[start] ? this.tType[start] : this.memType[start];
    if (startType === TY_CITY || this.memType[start] === TY_CITY) {
      score += Math.max(0, 18 - this.estimatedArmyAt(start) * 0.18);
    }

    for (var qi = 0; qi < qn; qi++) {
      var cur = q[qi];
      var curDist = dist[cur];
      if (curDist >= radius) continue;
      var base = cur * 4;
      for (var k = 0; k < 4; k++) {
        var nx = this.nbr[base + k];
        if (nx < 0) continue;
        if (stampArr[nx] === tick || !this.memPassable(nx)) continue;
        stampArr[nx] = tick;
        dist[nx] = curDist + 1;
        q[qn++] = nx;
        if (this.tOcc[nx] === this.id) continue;

        var cell = 0;
        if (!this.memEver[nx]) cell += 8.8 * landTempo;
        else if (!this.tVisible[nx]) cell += 5.0 * landTempo;
        else if (this.tOcc[nx] < 0) cell += 2.6 * landTempo;
        else if (this.isEnemyOcc(this.tOcc[nx])) cell += 3.0;
        var typeN = this.tVisible[nx] ? this.tType[nx] : this.memType[nx];
        if (typeN === TY_CITY || this.memType[nx] === TY_CITY) {
          cell += Math.max(0, 10 - this.estimatedArmyAt(nx) * 0.08);
        }
        cell += Math.max(0, this.passableDegree(nx) - 2) * 0.85;

        var contest = 1.0;
        if (hasEnemyGuess && enemyDist[nx] >= 0) {
          contest = Math.max(
            0.5,
            Math.min(1.65, 1 + (enemyDist[nx] - dist[nx] - 2) * 0.08)
          );
        }
        score += cell * kStepDiscount[Math.min(dist[nx], 8)] * contest;
      }
    }

    score += Math.max(0, 26 - this.centerDist(start) * 0.4);
    if (this.myGeneral >= 0) {
      score -= this.manhattan(start, this.myGeneral) * (this.mapArea() >= 520 ? 0.14 : 0.09);
    }
    if (this.tOcc[start] === this.id) score -= 6;
    this.duelHeat[start] = score;
  }
};

/* ---------------- 主决策链 ---------------- */

OimAgent.prototype.targetPlayerScore = function (p, m) {
  if (p < 0 || p >= this.playerCnt || p === this.id || !this.aliveById[p]) return -1e100;
  var score = 0;
  var guess = this.chooseTargetPlayerGeneral(p);
  var hasEvidence = !!this.cachedHasEvidence[p];
  if (this.knownGeneral[p] >= 0) score += 120;
  else if (guess >= 0 && hasEvidence) score += 30;
  if (guess >= 0 && hasEvidence && this.myGeneral >= 0) {
    score += Math.max(0, 72 - this.manhattan(guess, this.myGeneral) * 1.8);
  }
  score += this.newlyVisibleEnemy[p] * 12;
  score += this.visibleEnemyCount[p] * 9;
  score += Math.max(0, this.rankArmy[this.id] - this.rankArmy[p]) * 0.08;
  score += Math.max(0, this.rankLand[this.id] - this.rankLand[p]) * 0.55;
  score += Math.max(0, -this.playerArmyDelta[p]) * 1.4;
  score += Math.max(0, -this.playerLandDelta[p]) * 4.5;
  score += m.conversionAdvantage * 1.2;
  var intel = this.intelWeight();
  score += Math.max(0, 36 - this.hiddenReserveEst[p]) * 0.9 * intel;
  score -= Math.max(0, this.hiddenReserveEst[p] - 48) * 0.12 * intel;
  score += Math.max(0, -this.hiddenReserveDelta[p]) * 0.55 * intel;
  score -= Math.max(0, this.hiddenReserveDelta[p]) * 0.25 * intel;
  if (guess >= 0) {
    var localPressure = this.enemyPressure[guess] - this.friendlyPressure[guess];
    score += Math.max(-20, Math.min(20, -localPressure * 0.18)) * (hasEvidence ? 1 : 0.25);
  }
  return score;
};

OimAgent.prototype.chooseLockedTargetPlayer = function (m) {
  var suggested = -1;
  var bestScore = -1e100;
  for (var p = 0; p < this.playerCnt; p++) {
    var score = this.targetPlayerScore(p, m);
    if (score > bestScore) {
      bestScore = score;
      suggested = p;
    }
  }
  if (suggested < 0) return -1;
  if (
    this.currentTargetPlayer < 0 ||
    !this.aliveById[this.currentTargetPlayer] ||
    this.fullTurn > this.targetLockUntil
  ) {
    this.currentTargetPlayer = suggested;
    this.targetLockUntil = this.fullTurn + 12;
    return this.currentTargetPlayer;
  }
  var curScore = this.targetPlayerScore(this.currentTargetPlayer, m);
  var nextScore = this.targetPlayerScore(suggested, m);
  if (suggested !== this.currentTargetPlayer && nextScore > curScore + 32) {
    this.currentTargetPlayer = suggested;
    this.targetLockUntil = this.fullTurn + 12;
  }
  return this.currentTargetPlayer;
};

OimAgent.prototype.shouldPersistObjective = function (objective) {
  if (objective < 0) return false;
  return this.tOcc[objective] !== this.id;
};

OimAgent.prototype.selectStrategicMove = function (m) {
  var targetPlayer = this.chooseLockedTargetPlayer(m);
  var threat = this.analyzeThreat();
  var expansionBias = this.expansionUrgency(m);
  this.rebuildDuelExpansionHeat(targetPlayer, m);

  var direct = this.chooseDirectCaptureMove(targetPlayer, m);
  if (direct && direct.score > 600000) return direct;

  var defense = this.chooseDefensiveMove(m, threat);
  if (defense) return defense;

  if (
    direct &&
    direct.tactical &&
    (direct.score > 300 || direct.relievesCore) &&
    m.coreRisk <= 18
  ) {
    return direct;
  }

  var rollout = this.chooseOpeningRolloutMove(targetPlayer, m);
  if (rollout) return rollout;

  var opening = this.chooseOpeningMove(targetPlayer, m);
  if (opening) return opening;

  var tinyPressure = this.chooseTinyDuelPressureMove(targetPlayer, m);
  if (tinyPressure) return tinyPressure;

  var tempo = this.chooseDuelTempoMove(targetPlayer, m);
  if (tempo) return tempo;

  // 原版这里还有 chooseDuelExpansionCaptureMove，条件 mapArea>=500，本图 400 恒不触发

  var objectives = this.buildObjectiveCandidates(targetPlayer, m, threat);

  if (
    this.lockedObjective >= 0 &&
    this.fullTurn <= this.objectiveLockUntil &&
    this.shouldPersistObjective(this.lockedObjective)
  ) {
    var present = false;
    for (var i = 0; i < objectives.length; i++) {
      if (objectives[i].target === this.lockedObjective) {
        present = true;
        break;
      }
    }
    if (!present) {
      objectives.unshift(
        this.objective(
          220,
          this.lockedObjective,
          targetPlayer,
          true,
          false,
          this.tVisible[this.lockedObjective] && this.tType[this.lockedObjective] === TY_CITY,
          false
        )
      );
    }
  }

  var planned = this.chooseBestStrategicMove(objectives, m);
  var economic = this.chooseEconomicPlannerMove(targetPlayer, m);
  var plannedMargin = 18;
  if (planned && planned.mode === M_EXPAND) {
    plannedMargin -= expansionBias * 2.2;
  } else if (
    planned &&
    planned.mode === M_ATTACK &&
    m.contactDensity < 0.08 &&
    m.conversionAdvantage < 8
  ) {
    plannedMargin -= expansionBias * 0.9;
  }
  if (
    planned &&
    (!economic ||
      planned.score + plannedMargin >= economic.score ||
      planned.mode === M_ATTACK ||
      planned.mode === M_CONVERT)
  ) {
    return planned;
  }
  if (economic) {
    this.currentObjective = economic.target;
    return economic;
  }
  if (direct && direct.tactical && this.movePassesHardSafety(direct)) return direct;
  var fb = this.fallbackMove(targetPlayer, m);
  return fb ? { from: fb.from, to: fb.to, split: false, score: 0, valid: true } : null;
};

/* ---------------- 入口 ---------------- */

OimAgent.prototype.plan = function (view) {
  if (!view || !view.w || !view.h) return null;
  var n = view.w * view.h;
  if (!this.inited || this.W !== view.w || this.N !== n) this.init(view);

  this.fullTurn++;
  this.turnStamp++;
  this.id = view.me;
  this.readBoard(view);
  this.refreshRank();
  this.myGeneral = -1;
  this.rememberVisibleBoard();
  this.rebuildTurnCaches();
  this.buildBaseGeneralCandidateMask();
  this.recomputeSituationMaps();
  var metrics = this.computeSituationMetrics();
  this.refreshGeneralGuessCache(metrics);

  var move = this.selectStrategicMove(metrics);
  if (!move || !this.movePassesHardSafety(move) || !this.isLegalMove(move, n)) {
    move = this.fallbackMove(this.currentTargetPlayer, metrics);
  }
  if (!move || !this.isLegalMove(move, n)) return null;

  this.pushRecentMove(move.from, move.to);
  return { from: move.from, to: move.to, split: false };
};

/*
 * 最后一道闸：引擎会拒绝的走子在这里先挡掉（越界 / 非自己格 / 兵不足 / 不相邻 /
 * 目标其实是山）。迷雾里看不见的山和城长得一样，路径层已经绕开了，这层只是保险。
 */
OimAgent.prototype.isLegalMove = function (move, n) {
  var from = move.from;
  var to = move.to;
  if (from === undefined || to === undefined) return false;
  if (!(from >= 0 && from < n && to >= 0 && to < n)) return false;
  if (this.tOcc[from] !== this.id) return false;
  if (this.tArmy[from] < 2) return false;
  if (this.tVisible[to] && this.tType[to] === TY_MOUNTAIN) return false;
  var nb = this.nbr;
  for (var k = 0; k < 4; k++) {
    if (nb[from * 4 + k] === to) return true;
  }
  return false;
};

module.exports = OimAgent;
