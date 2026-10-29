/*
 * 移植自 LocalGen-new 的 KutuBot（pinkHC，GPL-3.0）：
 *   https://github.com/SZXC-WG/LocalGen-new/blob/master/src/bots/KutuBot.cpp
 *   本地副本：E:\akcoco6de\_research\bots\KutuBot.cpp（2776 行 / 111KB）
 *
 * 原版是「统一战略目标规划器」：不像 gc/szly 那样选一个目标格然后朝那儿推，
 * 而是每一回合先把全图变成四张压力/守备图，然后**竞标**——
 *   1. 局势指标（frontierPressure / coreRisk / contactDensity / mobility / conversionAdvantage）
 *   2. 威胁分析：以将军+核心城为目标做三次多源反向 Dijkstra（近/中/远），
 *      找出「哪一支敌军最快能捅到核心、还剩几回合」，威胁够硬就先防守
 *   3. 直接吃子：相邻、打得过就吃；吃将军(+1e6)/城(+290)/敌格(+105) 加权，先手抢
 *   4. 目标候选池：按 防守/强攻/拿城/施压/探雾 五个桶打分，每桶取前几个，
 *      每个目标再做一次反向 Dijkstra（代价 = attackPenalty/planningPenalty），
 *      从中挑 4~9 个出兵格，逐个算出兵路线 + 走廊支援 + 所需兵力，
 *      兵不够就让「后面的兵先靠拢」（rally），最后乘上目标分比总分
 *   5. 经济规划器：从最厚的几堆兵出发做正向 Dijkstra，直接把「目标格+首步」
 *      一起选出来（这一步是原版拉开差距的地方）
 *   6. 兜底：最厚堆往邻格推一格
 *
 * 和原版框架的差异（本目录契约要求每次 plan() 只出一条动作）：
 *   原版 requestMove 里 moveQueue 只 push 一条（这条 bot 一次只下一个 move），
 *   所以不存在队列问题；每 tick 一次 requestMove == 每回合一次 plan()。
 *   原版 turn：halfTurn/fullTurn 从 0 起，每 tick 一次，fullTurn 每两个 tick +1。
 *
 * 坐标：原版 1-based 且 idx = x*W + y（W = col+2）；这里反过来用 0-based 的
 *   node = row*view.w + col，邻居靠 ix/iy 手动判界，mapping 与原版一一对应。
 *
 * ---- 明确简化的部分（不影响主决策链，逐条列出）----
 *  1. rank 表拿不到（框架不给对手排名）。原版用 rankById 取每个玩家的 army/land
 *     和逐回合 delta 来算 conversionAdvantage / targetPlayerScore。这里改成
 *     refreshRank()：自己的 army/land 精确统计，对手的用**记忆里**已见过的
 *     敌方格求和（迷雾下天然偏小），delta 照样逐回合做差。
 *  2. 对手将军位置预测整块删掉（predictedGeneralScore / predictedGeneralScale /
 *     renormalizePredictionPlayer / advancePredictionDecay /
 *     reinforceGeneralNeighborhood / buildBaseGeneralCandidateMask /
 *     refreshGeneralGuessCache 的候选打分）。理由：这套东西是基于「没看见的
 *     格子按可见度加权」的贝叶斯味推测，localgen 里靠全视野数据调过参，
 *     在我们的迷雾视图下没有对应校准数据，留着只会引入噪声。现在
 *     cachedGeneralGuess == knownGenerals（见过就记，没见过就是 -1），
 *     cachedGeneralHasEvidence 的判据保留。
 *  3. multi-player 分支保留数组形状（playerCnt=2）但只对 1 个对手生效；
 *     chooseTargetPlayer / chooseLockedTargetPlayer 保留逻辑（锁 12 回合、
 *     分差 32 才换目标），只是候选只有一个。
 *  4. 决策 trace（traceDecision / traceCompetition，原版 kEnableDecisionTrace=false）
 *     全部删除。
 *  5. 地形 SWAMP / DESERT / LOOKOUT / OBSERVATORY 在我们这张图上不存在：
 *     相关判定（沼泽 +18 代价、-45 目标分、-20/-18 分）原样保留，
 *     但永远走不到；isImpassableTile 只剩 MOUNTAIN。
 *  6. 原版没有用任何随机数，所以本移植也不调 rng()——同一 seed 必然复现。
 *  7. 移动都是 takeHalf=false（留 1 个在家），所以输出恒为 split:false。
 */
'use strict';

var BLANK = 1;
var MOUNTAIN = 2;
var CITY = 3;
var SWAMP = 4;
var OBSTACLE = 8;
var GENERAL = 0;

var INF = 1000000000;
var RECENT_EDGE_WINDOW = 16;
var T_EPS = 1e-9;

var EXPAND = 0;
var ATTACK = 1;
var DEFEND = 2;
var CONVERT = 3;

function KutuBot(rng) {
  this.rng = rng || Math.random;
  this.inited = false;
  this.halfTurn = 0;
  this.fullTurn = 0;

  // 跨回合状态
  this.currentObjective = -1;
  this.lockedObjective = -1;
  this.objectiveLockUntil = -1;
  this.currentTargetPlayer = -1;
  this.targetLockUntil = -1;
  this.lastMoveFrom = -1;
  this.lastMoveTo = -1;
  this.knownGenerals = [-1, -1];
  this.cachedGeneralGuess = [-1, -1];
  this.cachedGeneralHasEvidence = [0, 0];
  this.newlyVisibleEnemyTiles = [0, 0];

  this.hk = null; // int 键最小堆
  this.hv = null;
  this.dk = null; // double 键最小堆
  this.dv = null;
}

KutuBot.prototype.init = function (w, h) {
  var n = w * h;
  this.w = w;
  this.h = h;
  this.n = n;

  // 地图记忆（对应原版 TileMemory 数组）
  this.memArmy = new Int32Array(n);
  this.memOccupier = new Int16Array(n).fill(-1);
  this.memLastSeen = new Int32Array(n).fill(-1);
  this.memEstimated = new Int32Array(n).fill(-1);
  this.memType = new Uint8Array(n).fill(BLANK);
  this.memEverSeen = new Uint8Array(n);
  this.memVisible = new Uint8Array(n);

  // 局势图
  this.enemyPressure = new Float64Array(n);
  this.friendlyPressure = new Float64Array(n);
  this.reserveArmy = new Int32Array(n);
  this.pathFlow = new Int32Array(n);
  this.coreZoneMask = new Uint8Array(n);
  this.chokeMask = new Uint8Array(n);
  this.distFromGeneral = new Int32Array(n).fill(INF);
  this.generalPathParent = new Int32Array(n).fill(-1);
  this.generalBfsOrder = new Int32Array(n);

  // 搜索工作区（正向 / 反向共用，一次只用一种）
  this.sDist = new Int32Array(n);
  this.sParent = new Int32Array(n);
  this.sFirst = new Int32Array(n);
  this.sDepth = new Int32Array(n);
  this.sLead = new Int32Array(n);

  // 威胁搜索工作区
  this.tCost = new Float64Array(n);
  this.tRaw = new Int32Array(n);
  this.tSteps = new Int32Array(n);
  this.tSeed = new Int32Array(n);
  this.tParent = new Int32Array(n);
  this.threatSets = [this.makeThreatSet(n), this.makeThreatSet(n), this.makeThreatSet(n)];

  var cap = n * 6 + 32;
  this.hk = new Int32Array(cap);
  this.hv = new Int32Array(cap);
  this.dk = new Float64Array(cap);
  this.dv = new Int32Array(cap);
  this.hs = 0;
  this.dhs = 0;

  // 压力核：半径 0..6 的曼哈顿圆，扁平化存 dx,dy,距离
  this.kernel = [];
  for (var r = 0; r <= 6; r++) {
    var arr = [];
    for (var dx = -r; dx <= r; dx++) {
      var rem = r - Math.abs(dx);
      for (var dy = -rem; dy <= rem; dy++) {
        arr.push(dx, dy, Math.abs(dx) + Math.abs(dy));
      }
    }
    this.kernel[r] = arr;
  }

  this.inited = true;
};

KutuBot.prototype.makeThreatSet = function (n) {
  return {
    ok: false,
    cost: new Float64Array(n),
    raw: new Int32Array(n),
    steps: new Int32Array(n),
    seed: new Int32Array(n),
    parent: new Int32Array(n)
  };
};

/* ==================== 堆（原版 std::push_heap/pop_heap） ==================== */

KutuBot.prototype.hPushI = function (key, node) {
  var kk = this.hk;
  var vv = this.hv;
  var i = this.hs++;
  kk[i] = key;
  vv[i] = node;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (kk[p] <= kk[i]) break;
    var tk = kk[p];
    kk[p] = kk[i];
    kk[i] = tk;
    var tv = vv[p];
    vv[p] = vv[i];
    vv[i] = tv;
    i = p;
  }
};

KutuBot.prototype.hPopI = function () {
  var kk = this.hk;
  var vv = this.hv;
  var rootV = vv[0];
  this.hKey = kk[0];
  var last = --this.hs;
  if (last > 0) {
    kk[0] = kk[last];
    vv[0] = vv[last];
    var i = 0;
    for (;;) {
      var l = i * 2 + 1;
      if (l >= last) break;
      var r = l + 1;
      var m = r < last && kk[r] < kk[l] ? r : l;
      if (kk[i] <= kk[m]) break;
      var tk = kk[i];
      kk[i] = kk[m];
      kk[m] = tk;
      var tv = vv[i];
      vv[i] = vv[m];
      vv[m] = tv;
      i = m;
    }
  }
  return rootV;
};

KutuBot.prototype.dPush = function (key, node) {
  var kk = this.dk;
  var vv = this.dv;
  var i = this.dhs++;
  kk[i] = key;
  vv[i] = node;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (kk[p] <= kk[i]) break;
    var tk = kk[p];
    kk[p] = kk[i];
    kk[i] = tk;
    var tv = vv[p];
    vv[p] = vv[i];
    vv[i] = tv;
    i = p;
  }
};

KutuBot.prototype.dPop = function () {
  var kk = this.dk;
  var vv = this.dv;
  var rootV = vv[0];
  this.dKey = kk[0];
  var last = --this.dhs;
  if (last > 0) {
    kk[0] = kk[last];
    vv[0] = vv[last];
    var i = 0;
    for (;;) {
      var l = i * 2 + 1;
      if (l >= last) break;
      var r = l + 1;
      var m = r < last && kk[r] < kk[l] ? r : l;
      if (kk[i] <= kk[m]) break;
      var tk = kk[i];
      kk[i] = kk[m];
      kk[m] = tk;
      var tv = vv[i];
      vv[i] = vv[m];
      vv[m] = tv;
      i = m;
    }
  }
  return rootV;
};

/* ==================== 基础几何 / 视图访问 ==================== */

KutuBot.prototype.inside = function (i) {
  return i >= 0 && i < this.n;
};

KutuBot.prototype.ix = function (i) {
  return i % this.w;
};

KutuBot.prototype.iy = function (i) {
  return (i / this.w) | 0;
};

KutuBot.prototype.step = function (i, d) {
  var x = i % this.w;
  var y = (i / this.w) | 0;
  if (d === 0) return y > 0 ? i - this.w : -1;
  if (d === 1) return x > 0 ? i - 1 : -1;
  if (d === 2) return y < this.h - 1 ? i + this.w : -1;
  return x < this.w - 1 ? i + 1 : -1;
};

KutuBot.prototype.manhattan = function (a, b) {
  return Math.abs(this.ix(a) - this.ix(b)) + Math.abs(this.iy(a) - this.iy(b));
};

KutuBot.prototype.adjacent = function (a, b) {
  return this.manhattan(a, b) === 1;
};

/* 原版 board.tileAt(c).visible：我们这边是 owner 是否落进 FOG / FOG_OBSTACLE */
KutuBot.prototype.visible = function (i) {
  var o = this.view.owner[i];
  return o !== -3 && o !== -4;
};

KutuBot.prototype.tileType = function (i) {
  var v = this.view;
  if (!this.visible(i)) return v.owner[i] === -4 || v.mountains[i] ? OBSTACLE : BLANK;
  if (v.mountains[i] || v.owner[i] === -2) return MOUNTAIN;
  if (v.cities[i]) return CITY;
  if (v.generals[i]) return GENERAL;
  return BLANK;
};

/* 原版 board.tileAt(c).occupier：看不见的格是 -1 */
KutuBot.prototype.occupierAt = function (i) {
  return this.visible(i) ? this.view.owner[i] : -1;
};

KutuBot.prototype.armyAt = function (i) {
  return this.visible(i) ? this.view.armies[i] : 0;
};

KutuBot.prototype.isPassable = function (type) {
  return type !== MOUNTAIN && type !== OBSTACLE;
};

KutuBot.prototype.isFriendlyOccupier = function (o) {
  return o === this.id;
};

KutuBot.prototype.isEnemyOccupier = function (o) {
  return o >= 0 && o !== this.id;
};

KutuBot.prototype.estimatedArmyAt = function (i) {
  return this.visible(i) ? this.view.armies[i] : this.memArmy[i];
};

KutuBot.prototype.recentEnemyAt = function (i, maxAge) {
  if (!this.inside(i)) return false;
  if (maxAge === undefined) maxAge = 4;
  return (
    !this.visible(i) &&
    this.isEnemyOccupier(this.memOccupier[i]) &&
    this.memLastSeen[i] >= 0 &&
    this.fullTurn - this.memLastSeen[i] <= maxAge
  );
};

/* ==================== 记忆 ==================== */

KutuBot.prototype.evolveHiddenMemory = function (i) {
  if (!this.memEverSeen[i] || this.memVisible[i] || this.memEstimated[i] < 0) return;
  if (this.fullTurn <= this.memEstimated[i]) return;
  var type = this.memType[i];
  for (var t = this.memEstimated[i] + 1; t <= this.fullTurn; t++) {
    if (this.memOccupier[i] < 0) break;
    if (type === GENERAL || type === CITY) {
      this.memArmy[i] += 1;
    } else if (type === BLANK) {
      if (t > 0 && t % 25 === 0) this.memArmy[i] += 1;
    } else if (type === SWAMP) {
      if (this.memArmy[i] > 0) this.memArmy[i] -= 1;
      if (this.memArmy[i] <= 0) {
        this.memArmy[i] = 0;
        this.memOccupier[i] = -1;
      }
    }
    if (this.memOccupier[i] >= 0 && this.memArmy[i] > 0 && type !== SWAMP) {
      this.memArmy[i] = Math.max(1, this.memArmy[i]);
    }
  }
  this.memEstimated[i] = this.fullTurn;
};

KutuBot.prototype.rememberVisibleBoard = function () {
  var n = this.n;
  this.newlyVisibleEnemyTiles[0] = 0;
  this.newlyVisibleEnemyTiles[1] = 0;

  for (var i = 0; i < n; i++) {
    var vis = this.visible(i);
    var wasVisible = this.memVisible[i];
    this.memVisible[i] = vis ? 1 : 0;
    if (!vis) {
      if (!this.memEverSeen[i]) {
        this.memType[i] = this.tileType(i);
        this.memEstimated[i] = this.fullTurn;
      } else {
        this.evolveHiddenMemory(i);
      }
      continue;
    }
    var type = this.tileType(i);
    var occ = this.view.owner[i];
    this.memEverSeen[i] = 1;
    this.memType[i] = type;
    this.memArmy[i] = this.view.armies[i];
    this.memOccupier[i] = occ;
    this.memLastSeen[i] = this.fullTurn;
    this.memEstimated[i] = this.fullTurn;

    if (type === GENERAL && occ >= 0) this.knownGenerals[occ] = i;
    if (occ >= 0 && occ !== this.id && !wasVisible) {
      if (occ < 2) this.newlyVisibleEnemyTiles[occ] += 1;
    }
  }
};

/* 原版 refreshRank：框架没有 rank 表，自己统计；对手的用记忆里的估计 */
KutuBot.prototype.refreshRank = function () {
  var army = [0, 0];
  var land = [0, 0];
  for (var i = 0; i < this.n; i++) {
    var occ = this.visible(i) ? this.view.owner[i] : this.memOccupier[i];
    if (occ !== 0 && occ !== 1) continue;
    land[occ] += 1;
    army[occ] += this.visible(i) ? this.view.armies[i] : Math.max(0, this.memArmy[i]);
  }
  if (!this.rankArmy) {
    this.rankArmy = army;
    this.rankLand = land;
    this.prevRankArmy = army.slice();
    this.prevRankLand = land.slice();
    this.playerArmyDelta = [0, 0];
    this.playerLandDelta = [0, 0];
    this.hasPrevRank = false;
  }
  if (this.hasPrevRank) {
    for (var p = 0; p < 2; p++) {
      this.playerArmyDelta[p] = army[p] - this.prevRankArmy[p];
      this.playerLandDelta[p] = land[p] - this.prevRankLand[p];
    }
  }
  this.prevRankArmy = army.slice();
  this.prevRankLand = land.slice();
  this.rankArmy = army;
  this.rankLand = land;
  this.hasPrevRank = true;
};

KutuBot.prototype.rebuildTurnCaches = function () {
  var n = this.n;
  this.friendlyTiles = [];
  this.frontierTiles = [];
  this.ownedCities = [];
  this.largestFriendlyArmy = 0;
  this.visibleEnemyCount = [0, 0];

  for (var i = 0; i < n; i++) {
    var occ = this.occupierAt(i);
    var type = this.memType[i];
    if (this.visible(i) && this.isEnemyOccupier(occ) && occ < 2) {
      this.visibleEnemyCount[occ] += 1;
    }
    if (occ !== this.id) continue;
    this.friendlyTiles.push(i);
    this.largestFriendlyArmy = Math.max(this.largestFriendlyArmy, this.armyAt(i));
    if (type === CITY) this.ownedCities.push(i);
    if (i === this.view.general && occ === this.id) this.myGeneral = i;

    var frontier = false;
    for (var d = 0; d < 4; d++) {
      var adj = this.step(i, d);
      if (adj < 0) continue;
      if (this.occupierAt(adj) !== this.id) frontier = true;
      if (!this.visible(adj) && !this.memEverSeen[adj]) frontier = true;
      if (this.recentEnemyAt(adj)) frontier = true;
    }
    if (frontier) this.frontierTiles.push(i);
  }
};

KutuBot.prototype.refreshGeneralGuessCache = function (metrics) {
  for (var p = 0; p < 2; p++) {
    if (p === this.id) continue;
    this.cachedGeneralHasEvidence[p] =
      this.knownGenerals[p] >= 0 ||
      this.visibleEnemyCount[p] > 0 ||
      this.newlyVisibleEnemyTiles[p] > 0 ||
      metrics.contactDensity > 0.035 ||
      metrics.conversionAdvantage > 12.0
        ? 1
        : 0;
    this.cachedGeneralGuess[p] = this.knownGenerals[p];
  }
};

KutuBot.prototype.chooseTargetPlayerGeneral = function (player) {
  if (player < 0 || player > 1) return -1;
  if (this.knownGenerals[player] >= 0) return this.knownGenerals[player];
  return this.cachedGeneralGuess[player];
};

/* ==================== 压力图 / 守备 ==================== */

KutuBot.prototype.addPressure = function (pressure, source, army, mult, stepLoss) {
  if (!this.inside(source) || army <= 0) return;
  var r = Math.floor(Math.sqrt(Math.max(1, army))) + 1;
  if (r < 2) r = 2;
  if (r > 6) r = 6;
  var capped = Math.min(army, 120) * mult;
  var k = this.kernel[r];
  var sx = source % this.w;
  var sy = (source / this.w) | 0;
  for (var t = 0; t < k.length; t += 3) {
    var nx = sx + k[t];
    var ny = sy + k[t + 1];
    if (nx < 0 || nx >= this.w || ny < 0 || ny >= this.h) continue;
    var node = ny * this.w + nx;
    if (!this.isPassable(this.memType[node])) continue;
    var gain = capped - k[t + 2] * stepLoss;
    if (gain <= 0) continue;
    pressure[node] += gain;
  }
};

KutuBot.prototype.computeGeneralDistances = function () {
  this.distFromGeneral.fill(INF);
  this.generalBfsOrderLen = 0;
  if (this.myGeneral < 0) return;
  var q = [this.myGeneral];
  this.distFromGeneral[this.myGeneral] = 0;
  for (var h = 0; h < q.length; h++) {
    var cur = q[h];
    this.generalBfsOrder[this.generalBfsOrderLen++] = cur;
    var curDist = this.distFromGeneral[cur];
    for (var d = 0; d < 4; d++) {
      var nxt = this.step(cur, d);
      if (nxt < 0) continue;
      if (!this.isPassable(this.memType[nxt])) continue;
      if (this.distFromGeneral[nxt] !== INF) continue;
      this.distFromGeneral[nxt] = curDist + 1;
      q.push(nxt);
    }
  }
};

KutuBot.prototype.passableDegree = function (i) {
  var deg = 0;
  for (var d = 0; d < 4; d++) {
    var nxt = this.step(i, d);
    if (nxt >= 0 && this.isPassable(this.memType[nxt])) deg++;
  }
  return deg;
};

KutuBot.prototype.adjacentEnemyThreat = function (origin) {
  if (!this.inside(origin)) return 0;
  var threat = 0;
  for (var d = 0; d < 4; d++) {
    var adj = this.step(origin, d);
    if (adj < 0) continue;
    if (this.visible(adj) && this.isEnemyOccupier(this.view.owner[adj])) {
      threat = Math.max(threat, this.view.armies[adj]);
    } else if (this.recentEnemyAt(adj)) {
      threat = Math.max(threat, this.memArmy[adj]);
    }
  }
  return threat;
};

KutuBot.prototype.refreshGeneralSafetyCache = function () {
  this.cachedGeneralAdjacentThreat = 0;
  this.cachedGeneralLocalPressure = 0;
  this.cachedRelaxedGeneralOpening = false;
  if (this.myGeneral < 0) return;

  this.cachedGeneralAdjacentThreat = this.adjacentEnemyThreat(this.myGeneral);
  this.cachedGeneralLocalPressure = Math.max(
    0,
    this.enemyPressure[this.myGeneral] - this.friendlyPressure[this.myGeneral] * 0.55
  );
  if (
    this.fullTurn >= 40 ||
    this.cachedGeneralAdjacentThreat > 0 ||
    this.cachedGeneralLocalPressure > 4.0
  ) {
    return;
  }
  var visibleEnemyTiles = 0;
  for (var p = 0; p < 2; p++) {
    if (p === this.id) continue;
    visibleEnemyTiles += this.visibleEnemyCount[p];
  }
  this.cachedRelaxedGeneralOpening = visibleEnemyTiles === 0;
};

KutuBot.prototype.relaxedGeneralOpening = function () {
  return this.cachedRelaxedGeneralOpening;
};

KutuBot.prototype.recomputeSituationMaps = function () {
  var n = this.n;
  var i;
  this.enemyPressure.fill(0);
  this.friendlyPressure.fill(0);
  this.reserveArmy.fill(0);
  this.pathFlow.fill(0);
  this.coreZoneMask.fill(0);
  this.chokeMask.fill(0);

  for (i = 0; i < n; i++) {
    if (this.visible(i)) {
      var a = this.view.armies[i];
      if (a <= 0) continue;
      var occ = this.view.owner[i];
      if (this.isEnemyOccupier(occ)) {
        this.addPressure(this.enemyPressure, i, a, 1.0, 15.0);
      } else if (occ === this.id) {
        this.addPressure(this.friendlyPressure, i, a, 0.9, 13.0);
      }
      continue;
    }
    if (!this.memEverSeen[i] || this.memArmy[i] <= 0 || this.memLastSeen[i] < 0) continue;
    var age = this.fullTurn - this.memLastSeen[i];
    if (age > 4) continue;
    var seenArmy = Math.max(1, this.memArmy[i] - age);
    if (this.isEnemyOccupier(this.memOccupier[i])) {
      this.addPressure(this.enemyPressure, i, seenArmy, 0.75, 16.0);
    } else if (this.memOccupier[i] === this.id) {
      this.addPressure(this.friendlyPressure, i, seenArmy, 0.7, 14.0);
    }
  }

  this.computeGeneralDistances();
  if (this.myGeneral < 0) return;

  var area = this.h * this.w;
  var coreRadius = Math.floor(Math.sqrt(area) / 1.8);
  if (coreRadius < 5) coreRadius = 5;
  if (coreRadius > 12) coreRadius = 12;

  for (i = 0; i < n; i++) {
    if (this.distFromGeneral[i] <= coreRadius) this.coreZoneMask[i] = 1;
  }
  for (var ci = 0; ci < this.ownedCities.length; ci++) {
    var city = this.ownedCities[ci];
    if (this.distFromGeneral[city] <= coreRadius + 3) this.coreZoneMask[city] = 1;
  }

  this.refreshGeneralSafetyCache();

  this.generalPathParent.fill(-1);
  var orderLen = this.generalBfsOrderLen;
  for (var oi = 0; oi < orderLen; oi++) {
    var c = this.generalBfsOrder[oi];
    if (c === this.myGeneral) continue;
    var curDist = this.distFromGeneral[c];
    if (curDist === INF) continue;
    var best = -1;
    var bestPressure = 0;
    var found = false;
    for (var d = 0; d < 4; d++) {
      var cand = this.step(c, d);
      if (cand < 0) continue;
      if (!this.isPassable(this.memType[cand])) continue;
      if (this.distFromGeneral[cand] !== curDist - 1) continue;
      var candPressure = this.enemyPressure[cand];
      if (!found || candPressure < bestPressure) {
        found = true;
        best = cand;
        bestPressure = candPressure;
      }
    }
    this.generalPathParent[c] = best;
  }

  for (var fi = 0; fi < this.frontierTiles.length; fi++) {
    var frontier = this.frontierTiles[fi];
    if (this.distFromGeneral[frontier] === INF) continue;
    this.pathFlow[frontier] += 1;
  }
  for (var ri = orderLen - 1; ri >= 0; ri--) {
    var cur = this.generalBfsOrder[ri];
    if (cur === this.myGeneral) continue;
    var parent = this.generalPathParent[cur];
    if (parent >= 0) this.pathFlow[parent] += this.pathFlow[cur];
  }

  for (var ti = 0; ti < this.friendlyTiles.length; ti++) {
    var tile = this.friendlyTiles[ti];
    var reserve = 0;
    if (tile === this.myGeneral) {
      if (this.relaxedGeneralOpening()) {
        reserve = 1;
      } else {
        reserve = Math.max(2, 2 + this.enemyPressure[tile] * 0.08);
        if (this.fullTurn >= 60) reserve = Math.max(reserve, 3);
      }
    }
    if (
      this.coreZoneMask[tile] &&
      this.enemyPressure[tile] > this.friendlyPressure[tile] * 0.55 + 6.0
    ) {
      reserve = Math.max(
        reserve,
        (this.enemyPressure[tile] - this.friendlyPressure[tile] * 0.55) * 0.05
      );
    }
    if (this.memType[tile] === CITY && this.coreZoneMask[tile]) {
      reserve = Math.max(reserve, 2 + this.enemyPressure[tile] * 0.04);
    }
    var flow = this.pathFlow[tile];
    var degree = this.passableDegree(tile);
    if (
      flow >= 2 &&
      degree <= 2 &&
      this.distFromGeneral[tile] >= 2 &&
      this.distFromGeneral[tile] <= coreRadius + 6
    ) {
      this.chokeMask[tile] = 1;
      reserve = Math.max(reserve, 1 + flow / 3 + this.enemyPressure[tile] * 0.03);
    }
    var army = this.armyAt(tile);
    var movableFloor = army <= 1 ? 0 : Math.max(0, army - 2);
    this.reserveArmy[tile] = Math.min(Math.floor(reserve), movableFloor);
  }
};

KutuBot.prototype.computeSituationMetrics = function () {
  var m = {
    frontierPressure: 0,
    coreRisk: 0,
    contactDensity: 0,
    mobilityScore: 0,
    conversionAdvantage: 0
  };
  var i;
  var d;

  if (this.frontierTiles.length) {
    var frontierLoad = 0;
    var contactEdges = 0;
    for (var fi = 0; fi < this.frontierTiles.length; fi++) {
      var c = this.frontierTiles[fi];
      frontierLoad += Math.max(
        0,
        this.enemyPressure[c] - this.friendlyPressure[c] * 0.65
      );
      for (d = 0; d < 4; d++) {
        var adj = this.step(c, d);
        if (adj < 0) continue;
        if (
          (this.visible(adj) && this.isEnemyOccupier(this.view.owner[adj])) ||
          this.recentEnemyAt(adj)
        ) {
          contactEdges += 1;
        }
      }
    }
    m.frontierPressure = frontierLoad / this.frontierTiles.length;
    m.contactDensity = contactEdges / Math.max(1, this.frontierTiles.length * 4.0);
  }

  if (this.myGeneral >= 0) {
    m.coreRisk = Math.max(
      0,
      this.enemyPressure[this.myGeneral] - this.friendlyPressure[this.myGeneral] * 0.55
    );
    for (var ci = 0; ci < this.ownedCities.length; ci++) {
      var city = this.ownedCities[ci];
      if (!this.coreZoneMask[city]) continue;
      m.coreRisk +=
        Math.max(0, this.enemyPressure[city] - this.friendlyPressure[city] * 0.7) * 0.2;
    }
  }

  var mobileArmy = 0;
  var mobileSources = 0;
  for (i = 0; i < this.friendlyTiles.length; i++) {
    var t = this.friendlyTiles[i];
    var available = Math.max(0, this.armyAt(t) - 1 - this.reserveArmy[t]);
    if (available <= 0) continue;
    mobileArmy += available;
    mobileSources++;
  }
  m.mobilityScore = mobileSources
    ? mobileArmy / mobileSources + this.frontierTiles.length * 0.25
    : 0;

  var strongestEnemyArmy = 0;
  var averageEnemyLand = 0;
  var enemyCnt = 0;
  for (var p = 0; p < 2; p++) {
    if (p === this.id) continue;
    strongestEnemyArmy = Math.max(strongestEnemyArmy, this.rankArmy[p]);
    averageEnemyLand += this.rankLand[p];
    enemyCnt++;
  }
  if (enemyCnt) averageEnemyLand /= enemyCnt;
  m.conversionAdvantage =
    (this.rankArmy[this.id] - strongestEnemyArmy) * 0.12 +
    (this.rankLand[this.id] - averageEnemyLand) * 0.7 -
    m.frontierPressure * 0.25 -
    m.coreRisk * 0.18;
  return m;
};

KutuBot.prototype.targetPlayerScore = function (player, m) {
  if (player < 0 || player > 1 || player === this.id) return -1e100;
  var score = 0;
  var guess = this.chooseTargetPlayerGeneral(player);
  var hasEvidence = this.cachedGeneralHasEvidence[player] !== 0;
  if (this.knownGenerals[player] >= 0) score += 120;
  else if (guess >= 0 && hasEvidence) score += 30;
  if (guess >= 0 && hasEvidence && this.myGeneral >= 0) {
    score += Math.max(0, 72 - this.manhattan(guess, this.myGeneral) * 1.8);
  }
  score += this.newlyVisibleEnemyTiles[player] * 12;
  score += this.visibleEnemyCount[player] * 9;
  score += Math.max(0, this.rankArmy[this.id] - this.rankArmy[player]) * 0.08;
  score += Math.max(0, this.rankLand[this.id] - this.rankLand[player]) * 0.55;
  score += Math.max(0, -this.playerArmyDelta[player]) * 1.4;
  score += Math.max(0, -this.playerLandDelta[player]) * 4.5;
  score += m.conversionAdvantage * 1.2;
  if (guess >= 0) {
    var localPressure = this.enemyPressure[guess] - this.friendlyPressure[guess];
    var term = -localPressure * 0.18;
    if (term > 20) term = 20;
    if (term < -20) term = -20;
    score += term * (hasEvidence ? 1.0 : 0.25);
  }
  return score;
};

KutuBot.prototype.chooseLockedTargetPlayer = function (m) {
  var suggested = -1;
  var bestScore = -1e100;
  for (var p = 0; p < 2; p++) {
    var score = this.targetPlayerScore(p, m);
    if (score > bestScore) {
      bestScore = score;
      suggested = p;
    }
  }
  if (suggested < 0) return -1;
  if (
    this.currentTargetPlayer < 0 ||
    this.fullTurn > this.targetLockUntil
  ) {
    this.currentTargetPlayer = suggested;
    this.targetLockUntil = this.fullTurn + 12;
    return this.currentTargetPlayer;
  }
  var currentScore = this.targetPlayerScore(this.currentTargetPlayer, m);
  var nextScore = this.targetPlayerScore(suggested, m);
  if (suggested !== this.currentTargetPlayer && nextScore > currentScore + 32) {
    this.currentTargetPlayer = suggested;
    this.targetLockUntil = this.fullTurn + 12;
  }
  return this.currentTargetPlayer;
};

KutuBot.prototype.shouldPersistObjective = function (obj) {
  if (obj < 0) return false;
  if (!this.inside(obj)) return false;
  return this.occupierAt(obj) !== this.id;
};

/* ==================== 惩罚 / 安全 ==================== */

KutuBot.prototype.attackPenalty = function (i, allowGeneralDive) {
  var type = this.memType[i];
  var penalty = 2;
  if (type === SWAMP) penalty += 18;
  if (type === CITY) penalty += 10;
  if (!this.memEverSeen[i]) penalty += 3;
  if (this.isEnemyOccupier(this.memOccupier[i])) {
    penalty += Math.min(this.estimatedArmyAt(i), 120);
    if (type === GENERAL && allowGeneralDive) penalty -= 22;
  } else if (this.memOccupier[i] === this.id) {
    penalty -= 3;
  }
  return Math.max(1, penalty);
};

KutuBot.prototype.planningPenalty = function (i, mode, m) {
  var cost = this.attackPenalty(i, true);
  var type = this.memType[i];
  var netPressure = this.enemyPressure[i] - this.friendlyPressure[i];
  if (mode === EXPAND) {
    if (!this.memEverSeen[i]) cost = Math.max(1, cost - 1);
    if (type === SWAMP) cost += 12;
    if (netPressure > 8) cost += Math.floor(netPressure * 0.06);
  } else if (mode === ATTACK) {
    if (this.isEnemyOccupier(this.memOccupier[i])) cost = Math.max(1, cost - 2);
    if (this.memOccupier[i] === this.id) cost = Math.max(1, cost - 1);
  } else if (mode === DEFEND) {
    if (this.myGeneral >= 0 && this.distFromGeneral[i] < INF) {
      cost -= Math.min(3, Math.floor(this.distFromGeneral[i] / 2));
    }
  } else if (mode === CONVERT) {
    if (this.isEnemyOccupier(this.memOccupier[i])) cost = Math.max(1, cost - 3);
    if (!this.memVisible[i]) cost += 1;
    if (m.conversionAdvantage > 0) {
      cost = Math.max(1, cost - Math.floor(Math.min(3, m.conversionAdvantage * 0.08)));
    }
  }
  return Math.max(1, cost);
};

KutuBot.prototype.availableArmy = function (i) {
  if (!this.inside(i)) return 0;
  if (this.view.owner[i] !== this.id || this.view.armies[i] <= 1) return 0;
  return Math.max(0, this.view.armies[i] - 1 - this.reserveArmy[i]);
};

KutuBot.prototype.strongestFriendlyTile = function (includeGeneral, near, nearWeight) {
  var best = -1;
  var bestScore = -1e100;
  for (var k = 0; k < this.friendlyTiles.length; k++) {
    var c = this.friendlyTiles[k];
    var army = this.view.armies[c];
    if (army <= 1) continue;
    if (!includeGeneral && c === this.myGeneral) continue;
    var score = this.availableArmy(c) * 3.0 + army;
    if (this.memType[c] === CITY) score -= 4.0;
    if (c === this.myGeneral) score -= 8.0;
    if (this.chokeMask[c]) score -= 5.0;
    if (near !== undefined && near >= 0) score -= this.manhattan(c, near) * nearWeight;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
};

/* 原版用 unordered_map<uint64,int> 记最近 16 条边；这里用 Map + 队列 */
KutuBot.prototype.pushRecentMove = function (from, to) {
  var key = from * 100000 + to;
  this.recentEdges.push({ from: from, to: to, key: key });
  this.recentEdgeCounts.set(key, (this.recentEdgeCounts.get(key) || 0) + 1);
  if (this.recentEdges.length > RECENT_EDGE_WINDOW) {
    var old = this.recentEdges.shift();
    var cnt = this.recentEdgeCounts.get(old.key) || 0;
    cnt -= 1;
    if (cnt <= 0) this.recentEdgeCounts.delete(old.key);
    else this.recentEdgeCounts.set(old.key, cnt);
  }
  this.lastMoveFrom = from;
  this.lastMoveTo = to;
};

KutuBot.prototype.shouldBlockOscillation = function (from, to) {
  if (from === this.lastMoveTo && to === this.lastMoveFrom) return true;
  var seen = this.recentEdgeCounts.get(from * 100000 + to) || 0;
  return seen >= 3 && this.occupierAt(to) === this.id;
};

KutuBot.prototype.moveRemainingArmy = function (mv) {
  if (!this.inside(mv.from)) return 0;
  if (this.view.owner[mv.from] !== this.id) return 0;
  var army = this.view.armies[mv.from];
  if (army <= 1) return 0;
  return 1; // 恒为 takeHalf=false：留 1 个在家，其余全走
};

KutuBot.prototype.movePassesHardSafety = function (mv) {
  if (mv === null || mv === undefined) return false;
  if (!this.inside(mv.from) || !this.inside(mv.to)) return false;
  if (this.view.owner[mv.from] !== this.id || this.view.armies[mv.from] <= 1) return false;
  if (this.moveRemainingArmy(mv) <= 0) return false;
  if (mv.from === this.myGeneral) {
    if (this.view.armies[mv.from] - 1 <= this.cachedGeneralAdjacentThreat) return false;
    if (
      !this.cachedRelaxedGeneralOpening &&
      this.cachedGeneralLocalPressure > 8.0 &&
      this.view.armies[mv.from] - 1 <= this.cachedGeneralAdjacentThreat + 1
    ) {
      return false;
    }
  }
  return true;
};

KutuBot.prototype.moveLooksSafe = function (mv) {
  return this.movePassesHardSafety(mv);
};

KutuBot.prototype.moveRiskPenalty = function (mv, m) {
  if (!this.movePassesHardSafety(mv)) return 1e9;
  var from = mv.from;
  var remain = this.moveRemainingArmy(mv);
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
  if (this.coreZoneMask[from]) penalty += localPressure * 0.35;
  if (this.chokeMask[from]) penalty += 5.0 + localPressure * 0.18;
  if (from === this.myGeneral) {
    penalty += Math.max(0, this.cachedGeneralAdjacentThreat + 1 - remain) * 18.0;
    penalty += Math.max(0, m.coreRisk - remain * 0.9) * 0.4;
  } else if (this.coreZoneMask[from] && remain <= 2) {
    penalty += 6.0;
  }
  if (this.memType[mv.to] === SWAMP) penalty += 4.0;
  return penalty;
};

KutuBot.prototype.immediateAdvancePossible = function (from, to) {
  if (!this.inside(from) || !this.inside(to)) return false;
  if (this.view.owner[from] !== this.id || this.view.armies[from] <= 1) return false;
  var occupier = this.occupierAt(to);
  if (this.isFriendlyOccupier(occupier)) return true;
  return this.view.armies[from] - 1 > this.estimatedArmyAt(to);
};

KutuBot.prototype.friendlyLeadSteps = function (route) {
  var lead = 0;
  for (var i = 0; i < route.length; i++) {
    if (!this.inside(route[i])) break;
    if (this.occupierAt(route[i]) !== this.id) break;
    lead++;
  }
  return lead;
};

KutuBot.prototype.supportAlongRoute = function (source, route) {
  var support = 0;
  var corridor = [];
  var len = Math.min(route.length, 4);
  for (var i = 0; i < len; i++) corridor.push(route[i]);
  for (var k = 0; k < this.friendlyTiles.length; k++) {
    var friendly = this.friendlyTiles[k];
    if (friendly === source) continue;
    var available = this.availableArmy(friendly);
    if (available <= 0) continue;
    var near = false;
    for (var j = 0; j < corridor.length; j++) {
      if (this.manhattan(friendly, corridor[j]) <= 1) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    support += available;
  }
  return Math.min(support, 48);
};

KutuBot.prototype.estimateObjectiveNeed = function (objective, distance, mode) {
  var type = this.memType[objective];
  var need = this.estimatedArmyAt(objective) + 1;
  if (this.isEnemyOccupier(this.memOccupier[objective])) need += 1;
  if (type === CITY) need += 3;
  if (type === GENERAL) need += 2;
  if (mode === DEFEND) need += 1;
  if (mode === CONVERT && this.isEnemyOccupier(this.memOccupier[objective])) need += 1;
  need += Math.max(1, Math.floor(distance / 4));
  need += Math.max(
    0,
    (this.enemyPressure[objective] - this.friendlyPressure[objective]) * 0.015
  );
  return Math.floor(need);
};

/* ==================== 路径搜索 ==================== */

KutuBot.prototype.weightedPath = function (start, costFn) {
  var n = this.n;
  var w = this.w;
  var h = this.h;
  var dist = this.sDist;
  var parent = this.sParent;
  var first = this.sFirst;
  var depth = this.sDepth;
  var lead = this.sLead;
  dist.fill(INF);
  parent.fill(-1);
  first.fill(-1);
  depth.fill(INF);
  lead.fill(0);
  this.hs = 0;
  dist[start] = 0;
  depth[start] = 0;
  lead[start] = 0;
  this.hPushI(0, start);

  while (this.hs > 0) {
    var cur = this.hPopI();
    var curDist = this.hKey;
    if (curDist !== dist[cur]) continue;
    var curDepth = depth[cur];
    var curLead = lead[cur];
    var curFirst = first[cur];
    var cx = cur % w;
    var cy = (cur / w) | 0;
    for (var d = 0; d < 4; d++) {
      var nx = cx + (d === 1 ? -1 : d === 3 ? 1 : 0);
      var ny = cy + (d === 0 ? -1 : d === 2 ? 1 : 0);
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      var nxt = ny * w + nx;
      if (!this.isPassable(this.memType[nxt])) continue;
      var nd = curDist + costFn(nxt);
      if (nd < dist[nxt]) {
        dist[nxt] = nd;
        parent[nxt] = cur;
        first[nxt] = cur === start ? nxt : curFirst;
        depth[nxt] = curDepth + 1;
        lead[nxt] = curLead === curDepth && this.view.owner[nxt] === this.id ? curDepth + 1 : curLead;
        this.hPushI(nd, nxt);
      }
    }
  }
  return true;
};

KutuBot.prototype.weightedReversePath = function (goal, costFn) {
  var w = this.w;
  var h = this.h;
  var dist = this.sDist;
  var parent = this.sParent;
  dist.fill(INF);
  parent.fill(-1);
  this.hs = 0;
  dist[goal] = 0;
  this.hPushI(0, goal);
  while (this.hs > 0) {
    var cur = this.hPopI();
    var curDist = this.hKey;
    if (curDist !== dist[cur]) continue;
    var stepInto = costFn(cur);
    var cx = cur % w;
    var cy = (cur / w) | 0;
    for (var d = 0; d < 4; d++) {
      var nx = cx + (d === 1 ? -1 : d === 3 ? 1 : 0);
      var ny = cy + (d === 0 ? -1 : d === 2 ? 1 : 0);
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      var prev = ny * w + nx;
      if (!this.isPassable(this.memType[prev])) continue;
      var nd = curDist + stepInto;
      if (nd < dist[prev]) {
        dist[prev] = nd;
        parent[prev] = cur;
        this.hPushI(nd, prev);
      }
    }
  }
  return true;
};

/* 从 start 顺着反向搜索的 parent 链走到 goal */
KutuBot.prototype.reconstructReversePath = function (start, goal) {
  var route = [];
  if (!this.inside(start) || !this.inside(goal)) return route;
  var cur = start;
  var guard = this.n + 5;
  while (cur >= 0 && cur !== goal && guard-- > 0) {
    cur = this.sParent[cur];
    if (cur < 0) return [];
    route.push(cur);
  }
  if (cur !== goal) return [];
  return route;
};

/* ==================== 威胁分析（多源反向 Dijkstra） ==================== */

KutuBot.prototype.betterThreat = function (node, candCost, candRaw, candSteps, candSeedIdx, seeds) {
  var cur = this.tCost[node];
  if (candCost + T_EPS < cur) return true;
  if (cur + T_EPS < candCost) return false;
  var curSeed = this.tSeed[node];
  var curRank = curSeed >= 0 ? seeds[curSeed].rank : 2147483647;
  var candRank = seeds[candSeedIdx].rank;
  if (candRank !== curRank) return candRank < curRank;
  if (candRaw !== this.tRaw[node]) return candRaw < this.tRaw[node];
  return candSteps < this.tSteps[node];
};

KutuBot.prototype.threatSearch = function (seeds, maxRawDist, out) {
  var w = this.w;
  var h = this.h;
  this.tCost.fill(1e100);
  this.tRaw.fill(INF);
  this.tSteps.fill(INF);
  this.tSeed.fill(-1);
  this.tParent.fill(-1);
  this.dhs = 0;
  out.ok = false;
  if (!seeds.length) return out;

  for (var si = 0; si < seeds.length; si++) {
    var seed = seeds[si];
    if (!this.inside(seed.target)) continue;
    var adj = -seed.bias / 10.5;
    if (!this.betterThreat(seed.target, adj, 0, 0, si, seeds)) continue;
    this.tCost[seed.target] = adj;
    this.tRaw[seed.target] = 0;
    this.tSteps[seed.target] = 0;
    this.tSeed[seed.target] = si;
    this.tParent[seed.target] = -1;
    this.dPush(adj, seed.target);
  }

  while (this.dhs > 0) {
    var cur = this.dPop();
    var curCost = this.dKey;
    if (curCost > this.tCost[cur] + T_EPS) continue;
    var curRaw = this.tRaw[cur];
    if (curRaw >= maxRawDist) continue;
    var stepCost = 1 + (this.memType[cur] === SWAMP ? 5 : 0);
    var seedIdx = this.tSeed[cur];
    var curSteps = this.tSteps[cur];
    var cx = cur % w;
    var cy = (cur / w) | 0;
    for (var d = 0; d < 4; d++) {
      var nx = cx + (d === 1 ? -1 : d === 3 ? 1 : 0);
      var ny = cy + (d === 0 ? -1 : d === 2 ? 1 : 0);
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      var prev = ny * w + nx;
      if (!this.isPassable(this.memType[prev])) continue;
      var candRaw = curRaw + stepCost;
      if (candRaw > maxRawDist) continue;
      var candSteps = curSteps + 1;
      var candCost = curCost + stepCost;
      if (!this.betterThreat(prev, candCost, candRaw, candSteps, seedIdx, seeds)) continue;
      this.tCost[prev] = candCost;
      this.tRaw[prev] = candRaw;
      this.tSteps[prev] = candSteps;
      this.tSeed[prev] = seedIdx;
      this.tParent[prev] = cur;
      this.dPush(candCost, prev);
    }
  }

  out.ok = true;
  out.cost.set(this.tCost);
  out.raw.set(this.tRaw);
  out.steps.set(this.tSteps);
  out.seed.set(this.tSeed);
  out.parent.set(this.tParent);
  return out;
};

KutuBot.prototype.reconstructThreatRoute = function (start, set) {
  var route = [];
  if (!this.inside(start)) return route;
  var cur = start;
  var guard = this.n + 5;
  while (cur >= 0 && guard-- > 0) {
    var nxt = set.parent[cur];
    if (nxt < 0) break;
    route.push(nxt);
    cur = nxt;
  }
  return route;
};

KutuBot.prototype.threatConsider = function (set, seeds, source, srcArmy, cur) {
  if (!set.ok) return cur;
  var si = set.seed[source];
  if (si < 0 || si >= seeds.length) return cur;
  var dist = set.raw[source];
  if (dist >= INF) return cur;
  var turns = set.steps[source];
  if (turns >= INF || turns <= 0) return cur;
  var seed = seeds[si];
  var pressure = srcArmy * 2.2 - dist * 10.5 + seed.bias;
  if (
    cur === null ||
    pressure > cur.pressure + T_EPS ||
    (Math.abs(pressure - cur.pressure) <= T_EPS && seed.rank < cur.rank)
  ) {
    return {
      set: set,
      seed: seed,
      pressure: pressure,
      rank: seed.rank,
      turns: turns
    };
  }
  return cur;
};

KutuBot.prototype.analyzeThreat = function () {
  if (this.myGeneral < 0) return null;

  var keyTargets = [this.myGeneral];
  for (var ci = 0; ci < this.ownedCities.length; ci++) {
    var city = this.ownedCities[ci];
    if (this.coreZoneMask[city]) keyTargets.push(city);
  }

  var allSeeds = [];
  var limitedSeeds = [];
  var positiveSeeds = [];
  for (var r = 0; r < keyTargets.length; r++) {
    var target = keyTargets[r];
    var targetPressure = this.enemyPressure[target] - this.friendlyPressure[target];
    var seed = {
      bias: targetPressure * 0.9 + (target === this.myGeneral ? 55.0 : 24.0),
      target: target,
      rank: r
    };
    allSeeds.push(seed);
    if (targetPressure > 0) positiveSeeds.push(seed);
    else limitedSeeds.push(seed);
  }

  var closeSet = this.threatSearch(allSeeds, 4, this.threatSets[0]);
  var limitedSet = this.threatSearch(limitedSeeds, 5, this.threatSets[1]);
  var positiveSet = this.threatSearch(positiveSeeds, 14, this.threatSets[2]);

  var best = null;
  for (var i = 0; i < this.n; i++) {
    var sourceArmy = 0;
    var valid = false;
    var visibleSource = false;
    var recentSource = false;
    if (this.visible(i) && this.isEnemyOccupier(this.view.owner[i]) && this.view.armies[i] > 1) {
      sourceArmy = this.view.armies[i];
      valid = true;
      visibleSource = true;
    } else if (this.recentEnemyAt(i, 2) && this.memArmy[i] > 1) {
      sourceArmy = this.memArmy[i];
      valid = true;
      recentSource = true;
    }
    if (!valid) continue;

    var cur = null;
    if (recentSource && !this.coreZoneMask[i]) {
      cur = this.threatConsider(closeSet, allSeeds, i, sourceArmy, cur);
    } else {
      cur = this.threatConsider(limitedSet, limitedSeeds, i, sourceArmy, cur);
      cur = this.threatConsider(positiveSet, positiveSeeds, i, sourceArmy, cur);
    }
    if (cur === null) continue;

    var route = this.reconstructThreatRoute(i, cur.set);
    if (!route.length) continue;

    var info = {
      source: i,
      target: cur.seed.target,
      route: route,
      intercept: route[Math.min(1, route.length - 1)],
      sourceArmy: sourceArmy,
      turns: cur.turns,
      visibleSource: visibleSource,
      recentSource: recentSource,
      pressure: cur.pressure,
      valid: true
    };
    if (best === null || info.pressure > best.pressure + T_EPS) best = info;
  }
  return best;
};

KutuBot.prototype.shouldDefend = function (threat, m) {
  if (!threat || !threat.valid) return false;
  var targetArmy = this.estimatedArmyAt(threat.target);
  var targetPressure =
    this.enemyPressure[threat.target] - this.friendlyPressure[threat.target];
  if (threat.target === this.myGeneral) {
    if (threat.turns <= 3) return true;
    if (m.coreRisk > 8.0 && threat.turns <= 6) return true;
    if (targetPressure > 8.0 && threat.turns <= 5 && threat.sourceArmy + 2 >= targetArmy) {
      return true;
    }
    return false;
  }
  return (
    m.frontierPressure > 8.0 &&
    targetPressure > 5.0 &&
    threat.turns <= 4 &&
    threat.pressure > 30.0
  );
};

/* ==================== 目标评估 ==================== */

KutuBot.prototype.modeForObjective = function (obj, m) {
  if (obj.defend) return DEFEND;
  if (obj.attack && obj.targetPlayer >= 0 && m.conversionAdvantage > 6.0) return CONVERT;
  if (obj.attack) return ATTACK;
  return EXPAND;
};

KutuBot.prototype.shouldPreferRally = function (plan, m) {
  if (!plan.valid || !plan.rally) return false;
  var gap = plan.need - (plan.commitArmy + plan.corridorSupport);
  if (plan.mode === DEFEND) return gap > 0;
  return gap > 2 || plan.pathCost >= 8 || m.coreRisk > 12.0;
};

KutuBot.prototype.chooseRallyMove = function (plan, m) {
  if (!plan.valid || plan.source < 0) return null;

  var corridor = [];
  for (var i = 0; i < plan.route.length && corridor.length < 4; i++) {
    if (this.occupierAt(plan.route[i]) !== this.id) continue;
    corridor.push(plan.route[i]);
  }
  var self = this;
  var corridorDistance = function (c) {
    var bestDist = self.manhattan(c, plan.source);
    for (var k = 0; k < corridor.length; k++) {
      bestDist = Math.min(bestDist, self.manhattan(c, corridor[k]));
    }
    return bestDist;
  };

  var bestScore = -1e100;
  var bestMove = null;
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var from = this.friendlyTiles[fi];
    if (from === plan.source) continue;
    var avail = this.availableArmy(from);
    if (avail <= 0) continue;
    var before = corridorDistance(from);
    if (before <= 0) continue;
    var base = avail * 11.0;
    if (this.memType[from] === CITY) base -= 18.0;
    if (from === this.myGeneral) base -= 45.0 + m.coreRisk * 0.8;
    if (this.chokeMask[from]) base -= 14.0;
    for (var d = 0; d < 4; d++) {
      var to = this.step(from, d);
      if (to < 0) continue;
      if (this.occupierAt(to) !== this.id) continue;
      if (this.shouldBlockOscillation(from, to)) continue;
      var after = corridorDistance(to);
      if (after >= before) continue;
      var score = base + (before - after) * 30.0;
      if (to === plan.source) score += 50.0;
      // 风险罚分只减不加：不成立就已经赢不了，省掉一次安全检查
      if (score <= bestScore) continue;
      var mv = { from: from, to: to };
      var riskPenalty = this.moveRiskPenalty(mv, m);
      if (riskPenalty >= 1e8) continue;
      score -= riskPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestMove = mv;
      }
    }
  }
  return bestMove;
};

KutuBot.prototype.evaluateObjectivePlan = function (obj, m) {
  var best = { valid: false, totalScore: -1e100 };
  if (!this.inside(obj.target)) return best;

  var mode = this.modeForObjective(obj, m);
  var self = this;
  this.weightedReversePath(obj.target, function (c) {
    return self.planningPenalty(c, mode, m);
  });

  var seeds = [];
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var source = this.friendlyTiles[fi];
    var available = this.availableArmy(source);
    if (available <= 0) continue;
    var dist = this.sDist[source];
    if (dist >= INF) continue;
    var score = available * 9.6 - dist * 3.3 - this.reserveArmy[source] * 0.8;
    if (source === this.myGeneral) {
      score -= this.relaxedGeneralOpening() ? 0.2 : 1.5 + m.coreRisk * 0.08;
    }
    if (this.chokeMask[source]) score -= 6.0;
    if (obj.defend && this.distFromGeneral[source] < INF) {
      score += Math.max(0, 8 - this.distFromGeneral[source]) * 3.0;
    }
    if (obj.attack && this.isEnemyOccupier(this.memOccupier[obj.target])) score += 18.0;
    seeds.push({ source: source, available: available, dist: dist, score: score });
  }
  seeds.sort(function (a, b) {
    return b.score - a.score;
  });
  var sourceLimit = 4 + Math.floor(m.mobilityScore * 0.08);
  if (sourceLimit < 4) sourceLimit = 4;
  if (sourceLimit > 9) sourceLimit = 9;
  if (seeds.length > sourceLimit) seeds.length = sourceLimit;

  for (var si = 0; si < seeds.length; si++) {
    var seed = seeds[si];
    var route = this.reconstructReversePath(seed.source, obj.target);
    if (!route.length) continue;
    var firstStep = route[0];
    if (this.shouldBlockOscillation(seed.source, firstStep)) continue;

    var plan = {
      valid: true,
      source: seed.source,
      target: obj.target,
      firstStep: firstStep,
      route: route,
      targetPlayer: obj.targetPlayer,
      mode: mode,
      sourceArmy: this.view.armies[seed.source],
      commitArmy: seed.available,
      reserve: this.reserveArmy[seed.source],
      corridorSupport: 0,
      need: 0,
      objectiveScore: obj.score,
      pathCost: seed.dist,
      rally: false,
      usingRally: false,
      move: { from: seed.source, to: firstStep }
    };
    plan.corridorSupport = this.supportAlongRoute(seed.source, route);
    plan.need = this.estimateObjectiveNeed(obj.target, route.length, mode);
    plan.rally = plan.commitArmy + plan.corridorSupport < plan.need;
    var friendlyLead = this.friendlyLeadSteps(route);

    var routeGain = 0;
    var scan = Math.min(route.length, 4);
    for (var ri = 0; ri < scan; ri++) {
      var stepNode = route[ri];
      if (
        (this.visible(stepNode) && this.isEnemyOccupier(this.view.owner[stepNode])) ||
        this.isEnemyOccupier(this.memOccupier[stepNode])
      ) {
        routeGain += 22.0 - ri * 3.0;
      }
      if (!this.memEverSeen[stepNode] || !this.visible(stepNode)) {
        routeGain += 12.0 - ri * 1.5;
      }
      if (this.memType[stepNode] === CITY) routeGain += 24.0;
    }

    var score = obj.score * 1.2 + seed.score;
    score += plan.corridorSupport * 2.8;
    score += routeGain;
    score -= seed.dist * 2.4;
    if (mode === EXPAND) {
      score -= friendlyLead * 26.0;
      if (friendlyLead === 0) score += 24.0;
      else if (friendlyLead === 1) score += 6.0;
    } else if (friendlyLead >= 2) {
      score -= friendlyLead * 8.0;
    }
    if (plan.commitArmy + plan.corridorSupport >= plan.need) score += 96.0;
    else score -= (plan.need - (plan.commitArmy + plan.corridorSupport)) * 0.8;
    if (obj.attack) score += 28.0;
    if (obj.attack && (m.contactDensity > 0.045 || m.conversionAdvantage > 8.0)) {
      score += 32.0;
    }
    if (obj.city) {
      score += 42.0;
      if (m.contactDensity < 0.08) score += 24.0;
      if (friendlyLead === 0) score += 18.0;
    }
    if (obj.exploration) score += 12.0;
    if (this.currentObjective === obj.target) score += 8.0;
    if (this.lockedObjective === obj.target && this.fullTurn <= this.objectiveLockUntil) {
      score += 10.0;
    }
    if (seed.source === this.myGeneral && !obj.defend) {
      score -= 1.0 + m.coreRisk * 0.08;
    }

    var directFeasible = this.immediateAdvancePossible(seed.source, firstStep);
    if (!directFeasible || this.shouldPreferRally(plan, m)) {
      var rallyMove = this.chooseRallyMove(plan, m);
      if (rallyMove !== null) {
        plan.move = rallyMove;
        plan.usingRally = true;
        score += 12.0;
      } else if (!directFeasible) {
        continue;
      } else if (plan.commitArmy + plan.corridorSupport < plan.need) {
        score -= 12.0;
      }
    } else {
      score += 10.0;
    }

    if (obj.city && plan.commitArmy + plan.corridorSupport + 2 < plan.need && !plan.usingRally) {
      continue;
    }
    var riskPenalty = this.moveRiskPenalty(plan.move, m);
    if (riskPenalty >= 1e8) continue;
    score -= riskPenalty;

    plan.totalScore = score;
    if (!best.valid || plan.totalScore > best.totalScore) best = plan;
  }
  return best;
};

/* ==================== 吃子 / 防守 ==================== */

KutuBot.prototype.chooseDirectCaptureMove = function (targetPlayer, m) {
  var best = { valid: false, score: -1e100 };
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var from = this.friendlyTiles[fi];
    var srcArmy = this.view.armies[from];
    if (srcArmy <= 1) continue;
    for (var d = 0; d < 4; d++) {
      var to = this.step(from, d);
      if (to < 0) continue;
      var dstType = this.tileType(to);
      if (dstType === MOUNTAIN || dstType === OBSTACLE) continue;
      if (this.occupierAt(to) === this.id) continue;
      if (this.shouldBlockOscillation(from, to)) continue;
      var attack = srcArmy - 1;
      var defense = this.estimatedArmyAt(to);
      if (attack <= defense) continue;

      var mv = { from: from, to: to };

      var margin = attack - defense;
      var enemyTile = this.isEnemyOccupier(this.occupierAt(to));
      var relievesCore =
        this.coreZoneMask[to] && (enemyTile || this.recentEnemyAt(to) || defense >= 2);
      var tactical =
        dstType === GENERAL ||
        dstType === CITY ||
        (enemyTile && margin >= 3) ||
        relievesCore;
      var score = 0;
      if (dstType === GENERAL) score += 1e6;
      if (dstType === CITY) score += 290.0 + margin * 8.5;
      if (enemyTile) score += 105.0 + margin * 5.5;
      if (this.occupierAt(to) === targetPlayer) score += 45.0;
      if (this.currentObjective === to) score += tactical ? 18.0 : 6.0;
      if (relievesCore) score += 45.0;
      if (dstType === SWAMP) score -= 20.0;
      if (!this.visible(to) && !this.memEverSeen[to]) score += tactical ? 6.0 : -8.0;
      if (!enemyTile && dstType !== CITY) score -= 26.0;
      if (score <= best.score) continue;
      var riskPenalty = this.moveRiskPenalty(mv, m);
      if (riskPenalty >= 1e8) continue;
      score -= riskPenalty;

      if (score > best.score) {
        best.valid = true;
        best.score = score;
        best.riskPenalty = riskPenalty;
        best.move = mv;
        best.source = from;
        best.target = to;
        best.mode = enemyTile ? ATTACK : EXPAND;
        best.tactical = tactical;
        best.relievesCore = relievesCore;
      }
    }
  }
  return best;
};

KutuBot.prototype.chooseDefensiveMove = function (m, threat) {
  if (!threat || !this.shouldDefend(threat, m)) return null;

  var interceptArmy = this.estimatedArmyAt(threat.intercept);
  for (var d = 0; d < 4; d++) {
    var from = this.step(threat.intercept, d);
    if (from < 0) continue;
    if (this.view.owner[from] !== this.id) continue;
    if (this.view.armies[from] <= interceptArmy + 1) continue;
    var mv = { from: from, to: threat.intercept };
    if (this.moveLooksSafe(mv)) return mv;
  }

  var objectives = [];
  objectives.push(this.defenseObjective(240.0, threat.intercept));
  objectives.push(this.defenseObjective(210.0, threat.source));
  for (var i = 0; i < threat.route.length && i < 3; i++) {
    objectives.push(this.defenseObjective(190.0 - i * 14.0, threat.route[i]));
  }

  var best = { valid: false, totalScore: -1e100 };
  for (var oi = 0; oi < objectives.length; oi++) {
    var plan = this.evaluateObjectivePlan(objectives[oi], m);
    if (plan.valid && (!best.valid || plan.totalScore > best.totalScore)) best = plan;
  }
  if (!best.valid) return null;
  this.currentObjective = best.target;
  this.lockedObjective = best.target;
  this.objectiveLockUntil = this.fullTurn + 6;
  return best.move;
};

KutuBot.prototype.defenseObjective = function (score, target) {
  return {
    score: score,
    target: target,
    targetPlayer: this.currentTargetPlayer,
    attack: true,
    defend: true,
    city: false,
    exploration: false
  };
};

/* ==================== 目标候选池 ==================== */

KutuBot.prototype.buildObjectiveCandidates = function (targetPlayer, m, threat) {
  var defenseOptions = [];
  var assaultOptions = [];
  var cityOptions = [];
  var pressureOptions = [];
  var expandOptions = [];
  var self = this;

  var addObjective = function (option) {
    if (option.target < 0 || option.target >= self.n) return;
    if (!self.isPassable(self.memType[option.target])) return;
    if (self.occupierAt(option.target) === self.id) return;
    if (option.defend) defenseOptions.push(option);
    else if (option.city) cityOptions.push(option);
    else if (option.attack) assaultOptions.push(option);
    else if (option.exploration) expandOptions.push(option);
    else pressureOptions.push(option);
  };

  if (threat) {
    addObjective(this.defenseObjective(250.0, threat.intercept));
    addObjective(this.defenseObjective(220.0, threat.source));
  }

  var targetGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var enemyContactSignal =
    targetPlayer >= 0
      ? this.visibleEnemyCount[targetPlayer] + this.newlyVisibleEnemyTiles[targetPlayer]
      : 0;
  var shouldPressureTarget =
    enemyContactSignal > 0 || m.contactDensity > 0.045 || m.conversionAdvantage > 8.0;
  var canChaseGuess = targetPlayer >= 0 && this.cachedGeneralHasEvidence[targetPlayer] !== 0;
  if (targetGuess >= 0 && canChaseGuess) {
    addObjective({
      score: 230.0,
      target: targetGuess,
      targetPlayer: targetPlayer,
      attack: true,
      defend: false,
      city: false,
      exploration: false
    });
    for (var d = 0; d < 4; d++) {
      var adj = this.step(targetGuess, d);
      if (adj < 0) continue;
      addObjective({
        score: 180.0,
        target: adj,
        targetPlayer: targetPlayer,
        attack: true,
        defend: false,
        city: false,
        exploration: false
      });
    }
  }

  for (var i = 0; i < this.n; i++) {
    if (!this.isPassable(this.memType[i])) continue;
    if (this.occupierAt(i) === this.id) continue;
    var occ = this.occupierAt(i);
    var enemy = this.isEnemyOccupier(occ);
    var city = this.memType[i] === CITY || (this.visible(i) && this.view.cities[i]);
    var exploration = !this.memEverSeen[i] || !this.visible(i);
    var score = 0;
    if (enemy) {
      score += 62.0 + Math.min(this.estimatedArmyAt(i), 80) * 0.45;
      if (shouldPressureTarget) score += 24.0;
    } else {
      score += 22.0;
    }
    if (occ === targetPlayer) score += shouldPressureTarget ? 92.0 : 50.0;
    if (city) {
      score += 236.0 - this.estimatedArmyAt(i) * 2.8;
      if (m.contactDensity < 0.08) score += 32.0;
      if (m.conversionAdvantage < 6.0) {
        score += Math.max(0, 12.0 - m.conversionAdvantage);
      }
      if (enemy) score += shouldPressureTarget ? 32.0 : 12.0;
    }
    if (!this.memEverSeen[i]) {
      score += 86.0 - m.contactDensity * 12.0 + Math.max(0, -m.conversionAdvantage * 1.2);
      if (shouldPressureTarget) score -= 22.0;
    }
    if (!this.visible(i)) score += 20.0;
    if (this.memType[i] === SWAMP) score -= 42.0;
    if (this.currentObjective === i) score += 10.0;
    if (this.lockedObjective === i && this.fullTurn <= this.objectiveLockUntil) score += 12.0;
    if (targetGuess >= 0 && canChaseGuess) {
      score += Math.max(0, 52.0 - this.manhattan(i, targetGuess) * 3.2);
    }
    if (this.myGeneral >= 0) {
      score -= this.manhattan(i, this.myGeneral) * (m.coreRisk > 12.0 ? 0.85 : 0.35);
    }
    var netPressure = this.enemyPressure[i] - this.friendlyPressure[i];
    if (!enemy && netPressure > 0) score -= netPressure * 0.25;
    if (enemy && m.conversionAdvantage > 0) score += Math.min(30.0, m.conversionAdvantage * 2.5);
    else if (enemy && m.conversionAdvantage < 0) {
      score -= Math.min(42.0, -m.conversionAdvantage * 2.6);
    }
    if (!enemy && shouldPressureTarget && !city && !exploration) score -= 26.0;
    if (
      enemy &&
      !city &&
      !exploration &&
      m.contactDensity < 0.08 &&
      m.conversionAdvantage < 4.0
    ) {
      score -= 48.0;
    }
    if (score <= -1e90) continue;

    var option = {
      score: score,
      target: i,
      targetPlayer: occ >= 0 ? occ : targetPlayer,
      attack: enemy,
      defend: false,
      city: city,
      exploration: exploration
    };
    var nearTargetGuess =
      targetGuess >= 0 && canChaseGuess && this.manhattan(i, targetGuess) <= 4;
    if (enemy && (occ === targetPlayer || nearTargetGuess)) {
      option.score += 18.0;
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

  var sortByScore = function (bucket) {
    bucket.sort(function (a, b) {
      return b.score - a.score;
    });
  };
  sortByScore(defenseOptions);
  sortByScore(assaultOptions);
  sortByScore(cityOptions);
  sortByScore(pressureOptions);
  sortByScore(expandOptions);

  var unique = [];
  var seen = new Uint8Array(this.n);
  var objectiveLimit = Math.floor(8 + (m.mobilityScore * 0.12 - m.coreRisk * 0.04));
  if (objectiveLimit < 8) objectiveLimit = 8;
  if (objectiveLimit > 16) objectiveLimit = 16;
  var appendBucket = function (bucket, limit) {
    var taken = 0;
    for (var k = 0; k < bucket.length; k++) {
      if (taken >= limit || unique.length >= objectiveLimit) break;
      var node = bucket[k].target;
      if (seen[node]) continue;
      seen[node] = 1;
      unique.push(bucket[k]);
      taken++;
    }
  };
  appendBucket(defenseOptions, 4);
  appendBucket(assaultOptions, 5);
  appendBucket(cityOptions, 4);
  appendBucket(pressureOptions, 4);
  appendBucket(expandOptions, 5);
  return unique;
};

KutuBot.prototype.chooseBestStrategicMove = function (objectives, m) {
  var best = { valid: false, score: -1e100 };
  var bestPlan = null;
  for (var i = 0; i < objectives.length; i++) {
    var plan = this.evaluateObjectivePlan(objectives[i], m);
    if (!plan.valid) continue;
    if (!best.valid || plan.totalScore > best.score) {
      best.valid = true;
      best.score = plan.totalScore;
      best.move = plan.move;
      best.source = plan.source;
      best.target = plan.target;
      best.mode = plan.mode;
      bestPlan = plan;
    }
  }
  if (!best.valid) return best;

  this.currentObjective = bestPlan.target;
  if (bestPlan.targetPlayer >= 0) this.currentTargetPlayer = bestPlan.targetPlayer;
  if (bestPlan.mode !== EXPAND || bestPlan.objectiveScore >= 170.0) {
    this.lockedObjective = bestPlan.target;
    this.objectiveLockUntil = this.fullTurn + 12;
  }
  best.riskPenalty = this.moveRiskPenalty(best.move, m);
  best.tactical = bestPlan.mode !== EXPAND || bestPlan.objectiveScore >= 180.0;
  best.relievesCore = bestPlan.mode === DEFEND;
  return best;
};

KutuBot.prototype.chooseEconomicPlannerMove = function (targetPlayer, m) {
  var best = { valid: false, score: -1e100 };
  var targetGuess = this.chooseTargetPlayerGeneral(targetPlayer);
  var self = this;
  var seeds = [];
  for (var fi = 0; fi < this.friendlyTiles.length; fi++) {
    var source = this.friendlyTiles[fi];
    var available = this.availableArmy(source);
    if (available <= 0) continue;
    var score = available * 6.8 - this.reserveArmy[source] * 1.0;
    if (source === this.myGeneral) score -= this.relaxedGeneralOpening() ? 0.5 : 2.5;
    if (this.chokeMask[source]) score -= 6.0;
    if (this.currentObjective >= 0) score -= this.manhattan(source, this.currentObjective) * 0.7;
    seeds.push({ source: source, score: score });
  }
  seeds.sort(function (a, b) {
    return b.score - a.score;
  });
  if (seeds.length > 5) seeds.length = 5;

  for (var si = 0; si < seeds.length; si++) {
    var seed = seeds[si];
    var src = seed.source;
    this.weightedPath(src, function (c) {
      var cost = self.attackPenalty(c, true);
      if (self.memType[c] === SWAMP) cost += 18;
      var netPressure = self.enemyPressure[c] - self.friendlyPressure[c];
      if (netPressure > 6) cost += Math.floor(netPressure * 0.05);
      return Math.max(1, cost);
    });

    for (var i = 0; i < this.n; i++) {
      if (!this.isPassable(this.memType[i])) continue;
      if (this.occupierAt(i) === this.id) continue;
      var dist = this.sDist[i];
      if (dist >= INF) continue;
      var occ = this.occupierAt(i);
      var enemy = this.isEnemyOccupier(occ);
      var city = this.memType[i] === CITY || (this.visible(i) && this.view.cities[i]);
      var exploration = !this.memEverSeen[i] || !this.visible(i);
      var score = seed.score - dist * 6.4;
      if (exploration) {
        score += 80.0 - m.contactDensity * 12.0 + Math.max(0, -m.conversionAdvantage);
      }
      if (!this.visible(i)) score += 22.0;
      if (enemy) score += 28.0 + this.estimatedArmyAt(i) * 0.1;
      if (occ === targetPlayer) score += 18.0;
      if (city) {
        score += 224.0 - this.estimatedArmyAt(i) * 2.5;
        if (m.contactDensity < 0.08) score += 36.0;
        if (m.conversionAdvantage < 6.0) {
          score += Math.max(0, 10.0 - m.conversionAdvantage);
        }
      }
      if (this.memType[i] === SWAMP) score -= 45.0;
      if (this.currentObjective === i) score += 8.0;
      if (targetGuess >= 0) {
        score += Math.max(0, 32.0 - this.manhattan(i, targetGuess) * 2.0);
      }
      if (this.myGeneral >= 0) {
        score -= this.manhattan(i, this.myGeneral) * (m.coreRisk > 10.0 ? 0.6 : 0.2);
      }
      var netPressure = this.enemyPressure[i] - this.friendlyPressure[i];
      if (!enemy && netPressure > 0) score -= netPressure * 0.18;
      if (!city && !enemy && !exploration) score -= 28.0;
      if (enemy && !city && !exploration) score -= 24.0;
      if (enemy && !city && m.contactDensity < 0.08 && m.conversionAdvantage < 4.0) {
        score -= 38.0;
      }

      var firstStep = this.sFirst[i];
      if (firstStep < 0) continue;
      var lead = this.sLead[i];
      score -= lead * 20.0;
      if (lead === 0) score += 18.0;
      if (lead > 2 && !city) score -= 20.0;
      if (score <= best.score) continue;
      if (!this.immediateAdvancePossible(src, firstStep)) continue;
      var mv = { from: src, to: firstStep };
      var riskPenalty = this.moveRiskPenalty(mv, m);
      if (riskPenalty >= 1e8) continue;
      score -= riskPenalty;

      if (score > best.score) {
        best.valid = true;
        best.score = score;
        best.riskPenalty = riskPenalty;
        best.move = mv;
        best.source = src;
        best.target = i;
        best.mode = enemy ? ATTACK : EXPAND;
        best.tactical = city || enemy;
        best.relievesCore = false;
      }
    }
  }
  return best;
};

KutuBot.prototype.fallbackMove = function (targetPlayer, m) {
  var source = this.strongestFriendlyTile(true, this.currentObjective, 1);
  if (source < 0) return null;

  var bestTarget = -1;
  var bestScore = -1e100;
  for (var d = 0; d < 4; d++) {
    var to = this.step(source, d);
    if (to < 0) continue;
    var type = this.tileType(to);
    if (type === MOUNTAIN || type === OBSTACLE) continue;
    if (this.shouldBlockOscillation(source, to)) continue;
    var mv = { from: source, to: to };
    var score = 0;
    var occ = this.occupierAt(to);
    if (!this.memEverSeen[to]) score += 42.0;
    if (!this.visible(to)) score += 18.0;
    if (type === CITY) score += 75.0 - this.estimatedArmyAt(to) * 2.5;
    if (type === SWAMP) score -= 18.0;
    if (occ !== this.id) score += 24.0;
    if (occ === targetPlayer) score += 18.0;
    if (this.currentObjective === to) score += 12.0;
    if (score <= bestScore) continue;
    var riskPenalty = this.moveRiskPenalty(mv, m);
    if (riskPenalty >= 1e8) continue;
    score -= riskPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestTarget = to;
    }
  }
  if (bestTarget < 0) return null;
  var move = { from: source, to: bestTarget };
  if (!this.movePassesHardSafety(move)) return null;
  return move;
};

/* ==================== 主决策 ==================== */

KutuBot.prototype.selectStrategicMove = function (m) {
  var targetPlayer = this.chooseLockedTargetPlayer(m);
  var threat = this.analyzeThreat();

  var direct = this.chooseDirectCaptureMove(targetPlayer, m);
  if (direct.valid && direct.score > 600000) return direct.move;

  var defense = this.chooseDefensiveMove(m, threat);
  if (defense !== null) return defense;

  if (
    direct.valid &&
    direct.tactical &&
    (direct.score > 300 || direct.relievesCore) &&
    m.coreRisk <= 18.0
  ) {
    return direct.move;
  }

  var objectives = this.buildObjectiveCandidates(targetPlayer, m, threat);

  if (
    this.lockedObjective >= 0 &&
    this.fullTurn <= this.objectiveLockUntil &&
    this.shouldPersistObjective(this.lockedObjective)
  ) {
    var alreadyPresent = false;
    for (var i = 0; i < objectives.length; i++) {
      if (objectives[i].target === this.lockedObjective) alreadyPresent = true;
    }
    if (!alreadyPresent) {
      objectives.unshift({
        score: 220.0,
        target: this.lockedObjective,
        targetPlayer: targetPlayer,
        attack: true,
        defend: false,
        city: this.memType[this.lockedObjective] === CITY,
        exploration: false
      });
    }
  }

  var planned = this.chooseBestStrategicMove(objectives, m);
  var economic = this.chooseEconomicPlannerMove(targetPlayer, m);
  if (
    planned.valid &&
    (!economic.valid ||
      planned.score + 18 >= economic.score ||
      planned.mode === ATTACK ||
      planned.mode === CONVERT)
  ) {
    return planned.move;
  }
  if (economic.valid) {
    this.currentObjective = economic.target;
    return economic.move;
  }
  if (direct.valid && direct.tactical && this.movePassesHardSafety(direct.move)) {
    return direct.move;
  }
  return this.fallbackMove(targetPlayer, m);
};

KutuBot.prototype.legalMove = function (mv) {
  if (mv === null || mv === undefined) return false;
  if (!this.inside(mv.from) || !this.inside(mv.to)) return false;
  if (this.view.owner[mv.from] !== this.id) return false;
  if (this.view.armies[mv.from] <= 1) return false;
  if (mv.from === mv.to) return false;
  if (!this.adjacent(mv.from, mv.to)) return false;
  // 引擎里 mountains[to] 是「山 + 看不见的城」，两者都不许进
  if (this.view.mountains[mv.to]) return false;
  return true;
};

KutuBot.prototype.plan = function (view) {
  if (!this.inited || this.w !== view.w || this.h !== view.h) this.init(view.w, view.h);
  this.view = view;
  this.id = view.me;
  this.halfTurn++;
  this.fullTurn += this.halfTurn & 1;

  // 最近边记录（原版在 init 里建，这里跟着 init 一起，维度变了要重来）
  if (!this.recentEdges) {
    this.recentEdges = [];
    this.recentEdgeCounts = new Map();
    this.lastMoveFrom = -1;
    this.lastMoveTo = -1;
    this.currentObjective = -1;
    this.lockedObjective = -1;
    this.objectiveLockUntil = -1;
    this.currentTargetPlayer = -1;
    this.targetLockUntil = -1;
    this.knownGenerals = [-1, -1];
    this.cachedGeneralGuess = [-1, -1];
    this.cachedGeneralHasEvidence = [0, 0];
    this.newlyVisibleEnemyTiles = [0, 0];
  }

  this.myGeneral = -1;
  this.rememberVisibleBoard();
  this.refreshRank();
  this.rebuildTurnCaches();
  this.recomputeSituationMaps();
  var metrics = this.computeSituationMetrics();
  this.refreshGeneralGuessCache(metrics);

  var candidate = this.selectStrategicMove(metrics);
  if (candidate === null || !this.movePassesHardSafety(candidate)) {
    candidate = this.fallbackMove(this.currentTargetPlayer, metrics);
  }
  if (candidate === null || !this.legalMove(candidate)) {
    candidate = this.fallbackMove(this.currentTargetPlayer, metrics);
    if (candidate === null || !this.legalMove(candidate)) return null;
  }

  this.pushRecentMove(candidate.from, candidate.to);
  return { from: candidate.from, to: candidate.to, split: false };
};

module.exports = KutuBot;
