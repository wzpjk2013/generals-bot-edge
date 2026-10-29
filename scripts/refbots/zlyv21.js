/*
 * 移植自 LocalGen-new：src/bots/zlyBot_v2.1.cpp（AppOfficer，GPL-3.0）
 * 原版路径：E:\akcoco6de\_research\bots\zlyBot_v2.1.cpp（633 行）
 *
 * 原版算法（一句话）：三个模式（ATTACK / EXPLORE / DEFEND）轮流接管——
 *   ATTACK   直扑已经见过的敌将，路线用「血量 + 类型代价 + 距离^0.9 惩罚」的 DP 搜出来；
 *   EXPLORE  在全图上挑 value 最高（地形分 60/300、减距离、减兵、减「见过」惩罚）的格子去踩；
 *   DEFEND   把兵往家区里 danger 最高的一格挪。
 *   模式由家区威胁决定：家区平均 danger > 0 / 有比我将军厚的敌堆 → DEFEND，
 *   家区 danger <= 0 → 回 EXPLORE，见到敌将 → ATTACK。
 *   两个 focus 分开：focus0 是「兵最多的己方格」（进攻/探索的出兵点），
 *   focus1 是「家区里兵最多的格」（防守的出兵点）。
 *
 * 改了哪些地方：
 *   1. turn 计数：原版 halfTurn 每 tick +1、turn 每两个 tick +1。这里 plan() 一次 = 一个 tick，
 *      照抄。turn 只用在 value 的「见过惩罚」里（turn - 100000/army），影响很小。
 *   2. rank 拿不到：totalArmy / totalLand 改成从自己视野里数；alive[] 全当活着；
 *      「敌将是否还活着」用「见过敌将」代替（原版里 generals[i] != -1 也是记忆）。
 *   3. 多步队列：原版 leastUsage = std::min(route.size(), 0) 恒为 0，所以
 *      `if (leastUsage != 0)` 那段**从来没执行过** —— 它每 tick 也就一条 Move。
 *      移植版直接把这半段丢掉，plan() 一次一条。
 *   4. prevMoves / recordNewMove：原版 recordNewMove 从来没被调用过，inPrevMoves 恒 false，
 *      findRoute 里的 `if (nt.inPrevMoves) continue` 是死代码，没有移植。
 *   5. 视野 / 障碍：原版的 TILE_OBSTACLE（雾里的山或城）不是 isImpassableTile，规划时会
 *      穿过去。移植版把 -4（FOG_OBSTACLE）和看得见的山都算不可通行，否则它会一直撞墙。
 *      findRoute 的 typeCost(OBSTACLE)=5 因此走不到（保留代码，注释说明）。
 *      迷雾里分不出沼泽/沙（本图也没有），-3 一律当 TILE_BLANK。
 *   6. typeAt 的缓存语义照抄：看不见且是 -4 → 缓存成 OBSTACLE；看不见的 -3 → 返回 BLANK
 *      但不写回缓存（对应原版 else 分支）。
 *   7. 不用 rng：原版这一步是纯确定的。
 */
'use strict';

/* 原版 delta 顺序 {{-1,0},{0,-1},{1,0},{0,1}}，(dx,dy) 里 x 是行、y 是列 */
var DIR_X = [-1, 0, 1, 0];
var DIR_Y = [0, -1, 0, 1];

/* tile_type_e（tile.hpp） */
var T_GENERAL = 0; // TILE_SPAWN
var T_BLANK = 1;
var T_MOUNTAIN = 2;
var T_CITY = 3;
var T_SWAMP = 4;
var T_DESERT = 5;
var T_LOOKOUT = 6;
var T_OBSERVATORY = 7;
var T_OBSTACLE = 8;

var INF = 1e16; // 原版 constexpr int64_t INF
var DIST_INF = 1048576; // 原版 pos_t DIST_INF

var MODE_ATTACK = 0;
var MODE_EXPLORE = 1;
var MODE_DEFEND = 2;

/* 原版 tileTypeWeight[16]，按 tile_type_e 下标 */
var TILE_TYPE_WEIGHT = [];
TILE_TYPE_WEIGHT[T_GENERAL] = 10;
TILE_TYPE_WEIGHT[T_BLANK] = 60;
TILE_TYPE_WEIGHT[T_MOUNTAIN] = -INF;
TILE_TYPE_WEIGHT[T_CITY] = 300;
TILE_TYPE_WEIGHT[T_SWAMP] = -1500000000;
TILE_TYPE_WEIGHT[T_DESERT] = 0;
TILE_TYPE_WEIGHT[T_LOOKOUT] = -INF;
TILE_TYPE_WEIGHT[T_OBSERVATORY] = -INF;
TILE_TYPE_WEIGHT[T_OBSTACLE] = 300;

function isImpassable(type) {
  // 原版 isImpassableTile + 本引擎把雾里的山/城（T_OBSTACLE）也算死路
  return type === T_MOUNTAIN || type === T_LOOKOUT || type === T_OBSERVATORY || type === T_OBSTACLE;
}

/* 本引擎 view → 原版 tile_type_e。gmask 是逐格将军掩码（arena 给掩码，探针给 [g0,g1]） */
function typeOfView(view, i, gmask) {
  var o = view.owner[i];
  if (o === -3) return T_BLANK;
  if (o === -4) return T_OBSTACLE;
  if (o === -2) return T_MOUNTAIN;
  if (gmask[i] === 1 && o >= 0) return T_GENERAL;
  if (view.cities[i] === 1) return T_CITY;
  return T_BLANK;
}

function buildGeneralMask(view, out) {
  var n = view.w * view.h;
  var g = view.generals;
  out.fill(0);
  var i;
  if (!g) return out;
  if (g.length === n) {
    for (i = 0; i < n; i++) if (g[i]) out[i] = 1;
  } else {
    for (i = 0; i < g.length; i++) {
      var p = g[i];
      if (p >= 0 && p < n && view.owner[p] >= 0) out[p] = 1;
    }
  }
  return out;
}

/* 最小堆：Dijkstra 用它（原版 std::priority_queue + std::greater） */
function MinHeap(cap) {
  this.k = new Float64Array(cap);
  this.v = new Int32Array(cap);
  this.n = 0;
  this.lastKey = 0;
}

MinHeap.prototype.clear = function () {
  this.n = 0;
};

MinHeap.prototype.push = function (key, val) {
  var k = this.k;
  var v = this.v;
  var i = this.n;
  if (i >= k.length) {
    var nk = new Float64Array(k.length * 2);
    var nv = new Int32Array(v.length * 2);
    nk.set(k);
    nv.set(v);
    this.k = k = nk;
    this.v = v = nv;
  }
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (k[p] <= key) break;
    k[i] = k[p];
    v[i] = v[p];
    i = p;
  }
  k[i] = key;
  v[i] = val;
  this.n++;
};

MinHeap.prototype.pop = function () {
  var n = this.n;
  if (n === 0) {
    this.lastKey = 0;
    return -1;
  }
  var k = this.k;
  var v = this.v;
  var topK = k[0];
  var topV = v[0];
  n--;
  var lastK = k[n];
  var lastV = v[n];
  var i = 0;
  while (true) {
    var c = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && k[c + 1] < k[c]) c++;
    if (k[c] >= lastK) break;
    k[i] = k[c];
    v[i] = v[c];
    i = c;
  }
  if (n > 0) {
    k[i] = lastK;
    v[i] = lastV;
  }
  this.n = n;
  this.lastKey = topK;
  return topV;
};

module.exports = class ZlyBotV21 {
  constructor(rng) {
    this.rng = rng; // 原版不掷骰子
    this.inited = false;
    this.w = -1;
    this.h = -1;
    this.n = -1;
    this.halfTurn = 0;
    this.turn = 0;
    this.me = -1;
    this.mode = MODE_EXPLORE;
    this.focus0 = -1;
    this.focus1 = -1;
    this.spawn = -1;
    this.egen = -1; // 见过的敌将位置（原版 generals[其它玩家]，粘性记忆）
    this.totalArmy = 0;
    this.totalLand = 0;
    this.homeZoneMaxRange = 10;
    this.hzCount = 0;
  }

  _init(view) {
    var w = view.w;
    var h = view.h;
    var n = w * h;
    this.w = w;
    this.h = h;
    this.n = n;
    this.me = view.me;

    this.mType = new Int8Array(n).fill(-1);
    this.mArmy = new Float64Array(n);
    this.mOccupier = new Int8Array(n).fill(-1);
    this.mVisible = new Uint8Array(n);
    this.mSeen = new Uint8Array(n); // isSeenBefore
    this.gMask = new Uint8Array(n);
    this.mInPrevMoves = new Uint8Array(n); // 原版恒 false，见文件头第 4 条

    this.value = new Float64Array(n);
    this.danger = new Float64Array(n);
    this.dist0 = new Float64Array(n);
    this.dist1 = new Float64Array(n);
    this.distToSpawn = new Float64Array(n);

    this.routePrev = new Int32Array(n);
    this.routeVis = new Uint8Array(n);
    this.rFriend = new Float64Array(n);
    this.rOppo = new Float64Array(n);
    this.rTypeCost = new Float64Array(n);
    this.rDist = new Float64Array(n);
    this.rU = new Float64Array(n);

    this.homeZone = new Int32Array(n);
    this.q = new Int32Array(n);
    this.heap = new MinHeap(n * 8 + 32);

    var nbrs = new Int32Array(n * 4).fill(-1);
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

    this.homeZoneMaxRange = Math.max(10, Math.max(h, w) >> 1);
    this.inited = true;
  }

  /* 原版 typeAt：先查记忆，再按可视情况推断；推断结果按原版规则决定是否写回缓存 */
  typeAt(i) {
    var t = this.mType[i];
    if (t !== -1) return t;
    var o = this.view.owner[i];
    if (o !== -3 && o !== -4) {
      this.mType[i] = typeOfView(this.view, i, this.gMask);
      return this.mType[i];
    }
    if (o === -4) return (this.mType[i] = T_OBSTACLE);
    return T_BLANK; // 看不见的空地：原版同样不写回缓存
  }

  /* 原版 dijkstra()：按 weight(next) 做最短路 */
  _dijkstra(start, dist, weightOf) {
    dist.fill(DIST_INF);
    if (start < 0) return;
    var heap = this.heap;
    heap.clear();
    dist[start] = 0;
    heap.push(0, start);
    var nbrs = this.nbrs;
    while (true) {
      var cur = heap.pop();
      if (cur < 0) break;
      var cd = heap.lastKey;
      if (cd > dist[cur]) continue;
      for (var k = 0; k < 4; k++) {
        var next = nbrs[cur * 4 + k];
        if (next < 0) continue;
        if (isImpassable(this.typeAt(next))) continue;
        var nd = cd + weightOf(next);
        if (nd < dist[next]) {
          dist[next] = nd;
          heap.push(nd, next);
        }
      }
    }
  }

  /* 原版 dijkstraBFS：从将军出发的无权 BFS */
  _bfsSpawn() {
    var d = this.distToSpawn;
    d.fill(DIST_INF);
    if (this.spawn < 0) return;
    var nbrs = this.nbrs;
    var q = this.q;
    var head = 0;
    var tail = 0;
    d[this.spawn] = 0;
    q[tail++] = this.spawn;
    while (head < tail) {
      var cur = q[head++];
      var dc = d[cur] + 1;
      for (var k = 0; k < 4; k++) {
        var next = nbrs[cur * 4 + k];
        if (next < 0 || d[next] !== DIST_INF) continue;
        if (isImpassable(this.typeAt(next))) continue;
        d[next] = dc;
        q[tail++] = next;
      }
    }
  }

  _calcData(f0, f1) {
    var self = this;
    var me = this.me;
    var n = this.n;
    var i;
    var edgeWeight = function (j) {
      var a = self.mArmy[j];
      return 10 + (a > 0 ? a : 0) + (self.typeAt(j) === T_SWAMP ? 100 : 0);
    };

    this._dijkstra(f0, this.dist0, edgeWeight);
    this._dijkstra(f1, this.dist1, edgeWeight);

    // 家区
    this._bfsSpawn();
    var defenseDist = Math.min(
      this.homeZoneMaxRange,
      Math.max(3, Math.trunc(Math.sqrt(this.totalLand) - 4))
    );
    var hz = this.homeZone;
    this.hzCount = 0;
    for (i = 0; i < n; i++) {
      if (this.distToSpawn[i] > defenseDist) continue;
      if (this.typeAt(i) === T_SWAMP && (!this.mVisible[i] || this.mOccupier[i] === -1)) continue;
      hz[this.hzCount++] = i;
    }

    var seenPenalty = this.turn - 100000.0 / Math.max(1, this.totalArmy);
    for (i = 0; i < n; i++) {
      if (this.mOccupier[i] === me) {
        this.value[i] = -INF;
        this.danger[i] = -INF;
        continue;
      }
      var tt = this.typeAt(i);
      var tw = TILE_TYPE_WEIGHT[tt];
      if (tw === undefined) tw = 0;
      var v = tw - this.dist0[i] - this.mArmy[i];
      var dg = -tw - this.distToSpawn[i] * 2 - Math.floor(this.dist1[i] / 2);
      if (this.mSeen[i]) v -= seenPenalty;
      if (this.mVisible[i] && this.mOccupier[i] !== -1) {
        var adjMin = INF;
        for (var k = 0; k < 4; k++) {
          var nx = this.nbrs[i * 4 + k];
          if (nx < 0) continue;
          if (this.mVisible[nx] && this.mOccupier[nx] === this.mOccupier[i] && this.mArmy[nx] < adjMin) {
            adjMin = this.mArmy[nx];
          }
        }
        if (adjMin === INF) adjMin = this.mArmy[i];
        v += 2 * (this.mArmy[i] - adjMin);
      }
      if (this.mVisible[i]) {
        if (this.mOccupier[i] !== -1) dg += 2 * this.mArmy[i];
        else dg -= Math.floor(this.mArmy[i] / 2);
      }
      this.value[i] = v;
      this.danger[i] = dg;
    }
  }

  /* 原版 findRoute：从 start 到 desti 的路线（返回中间路径，不含 start） */
  _findRoute(start, desti) {
    var me = this.me;
    var n = this.n;
    var i;
    var typeCost = function (tt) {
      if (tt === T_BLANK) return 0;
      if (tt === T_SWAMP) return 10;
      if (tt === T_GENERAL) return 0;
      if (tt === T_CITY) return 1;
      if (tt === T_DESERT) return 0;
      if (tt === T_OBSTACLE) return 5; // 移植后 OBSTACLE 不可通行，这一档走不到
      return INF;
    };

    for (i = 0; i < n; i++) {
      this.rFriend[i] = -INF;
      this.rOppo[i] = INF;
      this.rTypeCost[i] = 0;
      this.rDist[i] = 0;
      this.rU[i] = INF * 2;
      this.routePrev[i] = -1;
      this.routeVis[i] = 0;
    }
    var out = [];
    if (start < 0 || desti < 0) return out;

    // 起点节点：{totalArmy, start, dist 0, friend = 本格兵, oppo 0, typeCost 0, distPenalty 0}
    // united = 0 - (friend > oppo*20 ? totalArmy : friend - oppo) + 0
    this.rFriend[start] = this.mArmy[start];
    this.rOppo[start] = 0;
    this.rDist[start] = 0;
    this.rU[start] = -(this.mArmy[start] > 0 ? this.totalArmy : this.mArmy[start]);

    var heap = this.heap;
    heap.clear();
    heap.push(this.rU[start], start);
    var halveFromSpawn = this.mode === MODE_EXPLORE || this.mode === MODE_DEFEND;
    var totalArmy = this.totalArmy;

    while (true) {
      var cur = heap.pop();
      if (cur < 0) break;
      var curU = heap.lastKey;
      if (this.routeVis[cur]) continue;
      if (curU > this.rU[cur]) continue;
      this.routeVis[cur] = 1;
      if (cur === desti) break;
      var cd = this.rDist[cur] + 1;
      var cf = this.rFriend[cur];
      var co = this.rOppo[cur];
      var ctc = this.rTypeCost[cur];
      // 原版：`if (ori.pos == spawnCoord && (EXPLORE || DEFEND)) ori.friendArmy >>= 1`
      if (cur === this.spawn && halveFromSpawn) cf = Math.floor(cf / 2);
      var cdp = Math.pow(cd, 0.9) * 200;
      for (var k = 0; k < 4; k++) {
        var next = this.nbrs[cur * 4 + k];
        if (next < 0 || this.routeVis[next] || this.mInPrevMoves[next]) continue;
        var tt = this.typeAt(next);
        if (isImpassable(tt)) continue;
        var nf = cf;
        var no = co;
        if (this.mOccupier[next] === me) nf += this.mArmy[next] - 1;
        else no += this.mArmy[next] + 1;
        var ntc = ctc + typeCost(tt);
        var nu = cdp - (nf > no * 20 ? totalArmy : nf - no) + ntc;
        if (nu < this.rU[next]) {
          this.rU[next] = nu;
          this.rFriend[next] = nf;
          this.rOppo[next] = no;
          this.rTypeCost[next] = ntc;
          this.rDist[next] = cd;
          this.routePrev[next] = cur;
          heap.push(nu, next);
        }
      }
    }

    // 原版：从 desti 沿 routePrev 倒推到 -1，再 pop_front 去掉 start
    var chain = [];
    var cur2 = desti;
    var guard = 0;
    while (cur2 >= 0) {
      chain.push(cur2);
      cur2 = this.routePrev[cur2];
      if (++guard > n) break;
    }
    chain.reverse();
    if (chain.length && chain[0] === start) chain.shift();
    else chain = []; // 没走到 desti（routePrev 断链）→ 视作没路
    if (chain.length === 0 && start !== desti) {
      // 原版兜底：随便挑一个 start 的非障碍邻居
      for (var k2 = 0; k2 < 4; k2++) {
        var nb = this.nbrs[start * 4 + k2];
        if (nb < 0) continue;
        if (isImpassable(this.typeAt(nb))) continue;
        chain.push(nb);
        break;
      }
    }
    return chain;
  }

  _findMaxArmyPos() {
    var me = this.me;
    var maxArmy = 0;
    var best = this.spawn;
    for (var i = 0; i < this.n; i++) {
      if (this.mOccupier[i] !== me) continue;
      if (this.mArmy[i] > maxArmy) {
        maxArmy = this.mArmy[i];
        best = i;
      }
    }
    return best;
  }

  _findMaxArmyPosInHomeZone() {
    var me = this.me;
    var maxArmy = 0;
    var best = this.spawn;
    for (var h = 0; h < this.hzCount; h++) {
      var i = this.homeZone[h];
      if (!this.mVisible[i] || this.mOccupier[i] !== me) continue;
      if (this.mArmy[i] > maxArmy) {
        maxArmy = this.mArmy[i];
        best = i;
      }
    }
    return best;
  }

  _updateMode(aver, threat, danger) {
    if (
      (this.mode === MODE_ATTACK && aver > 5) ||
      (this.mode === MODE_EXPLORE && aver > 0) ||
      threat
    ) {
      return MODE_DEFEND;
    }
    if (this.mode === MODE_DEFEND && danger <= 0) return MODE_EXPLORE;
    return this.mode;
  }

  /* 模拟这一步（原版 requestMove 里的就地改 memory 兵数），并返回动作 */
  _applyMove(from, to, half) {
    var a = this.mArmy[from];
    var taken = half ? Math.floor(a / 2) : a;
    if (this.mOccupier[to] !== this.me) this.mArmy[to] -= taken;
    else this.mArmy[to] += taken;
    this.mArmy[from] -= taken;
    return { from: from, to: to, split: half };
  }

  plan(view) {
    if (!this.inited || this.w !== view.w || this.h !== view.h) this._init(view);
    this.halfTurn++;
    this.turn += this.halfTurn & 1;
    this.view = view;
    var me = view.me;
    var n = this.n;
    var i;
    this.me = me;

    var gmask = buildGeneralMask(view, this.gMask);

    /* rank 拿不到：总兵 / 地盘从自己视野里数 */
    var totalArmy = 0;
    var totalLand = 0;
    for (i = 0; i < n; i++) {
      if (view.owner[i] !== me) continue;
      totalLand++;
      if (view.armies[i] > 0) totalArmy += view.armies[i];
    }
    this.totalArmy = totalArmy;
    this.totalLand = totalLand;

    /* 记忆更新（含原版那句「每 tick 先把没有视野的格子兵数 -1」） */
    for (i = 0; i < n; i++) {
      if (this.mArmy[i] > 0) this.mArmy[i] -= 1;
      var o = view.owner[i];
      var vis = o !== -3 && o !== -4;
      var tt = typeOfView(view, i, gmask);
      if (vis || tt === T_SWAMP) this.mSeen[i] = 1;
      if (vis) {
        this.mType[i] = tt;
        this.mArmy[i] = view.armies[i];
        this.mOccupier[i] = o;
        this.mVisible[i] = 1;
        if (gmask[i] === 1 && o === me) this.spawn = i;
        else if (gmask[i] === 1 && o !== me) this.egen = i;
      } else {
        this.mVisible[i] = 0;
        this.mOccupier[i] = -1;
        if (!this.mSeen[i]) {
          var cy = this.typeAt(i);
          if (cy === T_BLANK || cy === T_SWAMP) this.mArmy[i] = 0;
          else if (cy === T_MOUNTAIN || cy === T_LOOKOUT || cy === T_OBSERVATORY) this.mArmy[i] = INF;
          else if (cy === T_GENERAL) this.mArmy[i] = -INF;
          else if (cy === T_CITY || cy === T_DESERT || cy === T_OBSTACLE) this.mArmy[i] = 40;
        }
      }
    }
    /* 原版 spawnCoord = generals[id]；自己的将军格永远可见，直接用 view.general 兜底 */
    if (view.general >= 0 && view.owner[view.general] === me) this.spawn = view.general;
    if (this.spawn < 0) {
      for (i = 0; i < n; i++) {
        if (this.mOccupier[i] === me) {
          this.spawn = i;
          break;
        }
      }
    }
    if (this.egen >= 0 && this.mVisible[this.egen] && this.mOccupier[this.egen] !== 1 - me) {
      // 敌将被吃掉了（那一格已经不是他的），记忆作废
      this.egen = -1;
    }

    if (this.mOccupier[this.focus0] !== me || this.mArmy[this.focus0] === 0) {
      this.focus0 = this._findMaxArmyPos();
    }
    if (this.mOccupier[this.focus1] !== me || this.mArmy[this.focus1] === 0) {
      this.focus1 = this._findMaxArmyPosInHomeZone();
    }

    /* 见到敌将 → ATTACK（原版：generals[其它玩家] != -1 就置 ATTACK） */
    if (this.egen >= 0) this.mode = MODE_ATTACK;
    else if (this.mode === MODE_ATTACK) this.mode = MODE_EXPLORE;

    this._calcData(this.focus0, this.focus1);

    var homeZoneThreat = false;
    var homeZoneDanger = 0;
    var spawnArmy = this.spawn >= 0 ? this.mArmy[this.spawn] : 0;
    for (var hz = 0; hz < this.hzCount; hz++) {
      var hp = this.homeZone[hz];
      if (!this.mVisible[hp] || this.mOccupier[hp] !== me) {
        homeZoneDanger += this.danger[hp] + 10;
      }
      if (
        this.mVisible[hp] &&
        this.mOccupier[hp] !== -1 &&
        this.mOccupier[hp] !== me &&
        this.mArmy[hp] > spawnArmy
      ) {
        homeZoneThreat = true;
      }
    }
    var aver = Math.trunc(homeZoneDanger / Math.max(1, this.hzCount));

    this.mode = this._updateMode(aver, homeZoneThreat, homeZoneDanger);
    if (this.mode === MODE_DEFEND) {
      var newFocus1 = this._findMaxArmyPosInHomeZone();
      if (this.focus1 !== newFocus1) {
        if (
          !(
            this.mOccupier[this.focus1] === me &&
            this.mArmy[this.focus1] > this.mArmy[newFocus1]
          )
        ) {
          this.focus1 = newFocus1;
        }
      }
    }

    if (this.focus0 < 0) return null;

    if (this.mode === MODE_ATTACK) {
      if (this.egen < 0) return null;
      var routeA = this._findRoute(this.focus0, this.egen);
      if (!routeA.length) return null;
      var fromA = this.focus0;
      var toA = routeA[0];
      var actA = this._applyMove(fromA, toA, false);
      this.focus0 = toA;
      return actA;
    }

    if (this.mode === MODE_EXPLORE) {
      var bestTarget = this.focus0;
      var bestValue = -INF;
      for (i = 0; i < n; i++) {
        if (isImpassable(this.typeAt(i))) continue;
        if (this.value[i] > bestValue) {
          bestValue = this.value[i];
          bestTarget = i;
        }
      }
      var routeE = this._findRoute(this.focus0, bestTarget);
      if (!routeE.length) return null;
      var fromE = this.focus0;
      var toE = routeE[0];
      var actE = this._applyMove(fromE, toE, fromE === this.spawn);
      this.focus0 = toE;
      return actE;
    }

    // MODE_DEFEND
    var bestD = this.focus1;
    var bestDanger = -INF;
    for (var h2 = 0; h2 < this.hzCount; h2++) {
      var p2 = this.homeZone[h2];
      if (this.danger[p2] > bestDanger) {
        bestDanger = this.danger[p2];
        bestD = p2;
      }
    }
    var routeD = this._findRoute(this.focus1, bestD);
    if (!routeD.length) return null;
    var fromD = this.focus1;
    var toD = routeD[0];
    var actD = this._applyMove(fromD, toD, fromD === this.spawn);
    this.focus1 = toD;
    return actD;
  }
};
