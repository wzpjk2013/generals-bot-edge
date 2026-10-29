/*
 * 移植自 LocalGen-new：src/bots/zlyBot_v3.cpp（AppOfficer，GPL-3.0）
 * 原版文件头自称 ZlyBot v2.2，注册名 "ZlyBot v3-alpha.1"，547 行。
 * 原版路径：E:\akcoco6de\_research\bots\zlyBot_v3.cpp
 *
 * 原版算法（一句话）：给全图每个非己方格算一个价值（地形分 + 敌方加成 - 距离惩罚 -
 * 路线可达性 - 兵数，上一个目标另有加成），取最大者当目标，再从目标反向做一次
 * 「能吸收多少兵」的最优化搜索，找到路线上第一个「兵够、值得推」的己方格，推过去。
 * 三个前置场：getDist（跳数）/ getArmyDist（跳数相同的路径里挑净兵最优）/ getAccessibility
 * （从将军出发的加权代价，雾里山 200、城 2、空地 1 + 兵数）。
 *
 * 改了哪些地方：
 *   1. turn 计数：原版 halfTurn 每 tick +1、turn 每两个 tick +1（`turn += halfTurn & 1`）。
 *      这里 plan() 一次 = 一个 tick，照样 halfTurn++ / turn += halfTurn&1。
 *   2. rank 拿不到（没有对手排名表）：totalArmy / totalLand 改成从自己视野里数。
 *   3. 多步队列：原版 requestMove 每 tick 只 push 一条 Move，所以不需要 queue。
 *   4. 视野：原版是「自己记得的地图」（updateMemory 里可见就刷新、不可见就留记忆），
 *      这里保留同样的语义，类型映射按本引擎的 view：owner -3→空地、-4→障碍、-2→山。
 *   5. 障碍：原版的 TILE_OBSTACLE（= 雾里的山/城）**不是** isImpassableTile，所以它会
 *      把雾里的城当平地一样规划路线、把兵往里撞。移植版把 -4 当障碍（连同看得见的山），
 *      否则在真实迷雾下它每回合都在撞墙。OBSTACLE 的 typeValue（default 0）因此走不到了。
 *   6. 优先级队列：C++ 的 priority_queue 用 RouteNodeLess 比 united()，这里用同一个
 *      Float64Array 堆（sign=-1 是最小堆）。同分时的出队顺序可能和 libstdc++ 不同，
 *      只影响「同样好的两条路选哪条」，不影响判据。
 *   7. 原版的 logGrid / ZLYBOT_LOG 是纯调试输出，没有移植。
 *   8. 原版在 requestMove 末尾会就地改 memory 里的兵数（模拟刚走的那一步），这里照抄，
 *      但下一个 tick 可见格会被 view 覆盖，所以它只影响看不到的格子的估计值。
 *   9. 不用 rng：原版这一步是纯确定的。
 */
'use strict';

/* 原版 delta 顺序 {{-1,0},{0,-1},{1,0},{0,1}}，(dx,dy) 里 x 是行、y 是列 */
var DIR_X = [-1, 0, 1, 0];
var DIR_Y = [0, -1, 0, 1];

/* tile_type_e（tile.hpp） */
var T_GENERAL = 0; // = TILE_SPAWN
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

function isImpassable(type) {
  // 原版 isImpassableTile + 本引擎把雾里的山/城（T_OBSTACLE）也算死路
  return type === T_MOUNTAIN || type === T_LOOKOUT || type === T_OBSERVATORY || type === T_OBSTACLE;
}

/* 本引擎 view → 原版 tile_type_e。visible=false 时按 TileView::updateFrom 的规则退化。
 * gmask 是「这一格是将军」的逐格掩码：arena.js 给的就是掩码，冒烟探针给的是
 * [g0, g1] 位置表，两种都要认。 */
function typeOfView(view, i, gmask) {
  var o = view.owner[i];
  if (o === -3) return T_BLANK; // TILE_FOG：看不见，本图没有沼泽/沙，只能当空地
  if (o === -4) return T_OBSTACLE; // TILE_FOG_OBSTACLE：山或城，分不出来
  if (o === -2) return T_MOUNTAIN;
  if (gmask[i] === 1 && o >= 0) return T_GENERAL;
  if (view.cities[i] === 1) return T_CITY;
  return T_BLANK;
}

/* 把 view.generals 归一化成逐格掩码（两种形态都要能跑） */
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

/* 二叉堆。sign=1 最大堆（findRouteTo 要「united 最高」），sign=-1 最小堆（Dijkstra）。 */
function Heap(cap, sign) {
  this.k = new Float64Array(cap);
  this.v = new Int32Array(cap);
  this.n = 0;
  this.sign = sign;
  this.lastKey = 0;
}

Heap.prototype.clear = function () {
  this.n = 0;
};

Heap.prototype.push = function (key, val) {
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
  var s = key * this.sign;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (k[p] >= s) break;
    k[i] = k[p];
    v[i] = v[p];
    i = p;
  }
  k[i] = s;
  v[i] = val;
  this.n++;
};

Heap.prototype.pop = function () {
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
    if (c + 1 < n && k[c + 1] > k[c]) c++;
    if (k[c] <= lastK) break;
    k[i] = k[c];
    v[i] = v[c];
    i = c;
  }
  if (n > 0) {
    k[i] = lastK;
    v[i] = lastV;
  }
  this.n = n;
  this.lastKey = topK * this.sign;
  return topV;
};

module.exports = class ZlyBotV3 {
  constructor(rng) {
    this.rng = rng; // 原版不掷骰子
    this.inited = false;
    this.w = -1;
    this.h = -1;
    this.n = -1;
    this.halfTurn = 0;
    this.turn = 0;
    this.me = -1;
    this.spawn = -1;
    this.lastTarget = -1;
    this.lastMovedArmy = 0;
    this.totalArmy = 0;
    this.totalLand = 0;
  }

  _init(view) {
    var w = view.w;
    var h = view.h;
    var n = w * h;
    this.w = w;
    this.h = h;
    this.n = n;

    // 记忆地图（原版 TileInfo 的字段）
    this.mType = new Int8Array(n).fill(-1); // tile_type_e(-1) = 未知
    this.mArmy = new Float64Array(n);
    this.mOccupier = new Int8Array(n).fill(-1);
    this.mVisible = new Uint8Array(n);
    this.mSeen = new Uint8Array(n); // isSeenBefore
    this.gMask = new Uint8Array(n);

    // findRouteTo 的 routeDp 缓存
    this.rDist = new Float64Array(n);
    this.rFriend = new Float64Array(n);
    this.rOppo = new Float64Array(n);
    this.rTypeCost = new Float64Array(n);
    this.rVis = new Uint8Array(n);
    this.toTile = new Int32Array(n);

    // 每次 plan 复用的场
    this.distToSpawn = new Float64Array(n);
    this.armyDist = new Float64Array(n);
    this.acc = new Float64Array(n);
    this.accVis = new Uint8Array(n);
    this.hop = new Int32Array(n);
    this.q = new Int32Array(n);

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

    var cap = n * 8 + 32;
    this.hMax = new Heap(cap, 1);
    this.hMin = new Heap(cap, -1);
    this.inited = true;
  }

  _netArmy(i) {
    return this.mOccupier[i] === this.me ? this.mArmy[i] : -this.mArmy[i];
  }

  /* 原版 updateMemory：可见就刷新，不可见就保留记忆（isSeenBefore 是粘性的） */
  _updateMemory(view, gmask) {
    var me = this.me;
    var n = this.n;
    for (var i = 0; i < n; i++) {
      var o = view.owner[i];
      var vis = o !== -3 && o !== -4;
      var tt = typeOfView(view, i, gmask);
      if (vis || tt === T_SWAMP) this.mSeen[i] = 1;
      if (vis) {
        this.mType[i] = tt;
        this.mArmy[i] = view.armies[i];
        this.mOccupier[i] = o;
        this.mVisible[i] = 1;
      } else {
        this.mVisible[i] = 0;
        this.mOccupier[i] = -1;
        if (!this.mSeen[i]) {
          this.mType[i] = tt;
          this.mArmy[i] = 0; // 原版：view.army，迷雾下恒为 0
        }
      }
    }
    /* 原版 spawn = generals[id]（记忆里的我方将军）。这里直接用 view.general：
     * 自己的将军格永远可见，语义一样但不受「雾里将军格 type 退化成空地」影响。 */
    var gen = view.general;
    if (gen >= 0 && gen < n && view.owner[gen] === me) {
      this.spawn = gen;
    } else if (this.spawn < 0 || this.mOccupier[this.spawn] !== me) {
      this.spawn = -1;
      for (var j = 0; j < n; j++) {
        if (this.mOccupier[j] === me && gmask[j] === 1) {
          this.spawn = j;
          break;
        }
      }
      if (this.spawn < 0) {
        for (var k = 0; k < n; k++) {
          if (this.mOccupier[k] === me) {
            this.spawn = k;
            break;
          }
        }
      }
    }
  }

  /* 原版 getDist：从 start 出发的跳数 BFS（不可通行格跳过） */
  _getDist(start) {
    var n = this.n;
    var d = this.distToSpawn;
    var q = this.q;
    var nbrs = this.nbrs;
    var mType = this.mType;
    d.fill(INF);
    if (start < 0) return d;
    d[start] = 0;
    var head = 0;
    var tail = 0;
    q[tail++] = start;
    while (head < tail) {
      var cur = q[head++];
      var dc = d[cur] + 1;
      for (var k = 0; k < 4; k++) {
        var next = nbrs[cur * 4 + k];
        if (next < 0 || d[next] !== INF) continue;
        if (isImpassable(mType[next])) continue;
        d[next] = dc;
        q[tail++] = next;
      }
    }
    return d;
  }

  /* 原版 getArmyDist：先求跳数，再在「最短跳数 DAG」上做 DP，取净兵最优的那条路 */
  _getArmyDist(start) {
    const HOP_INF = 1 << 30;
    var n = this.n;
    var hop = this.hop;
    var nbrs = this.nbrs;
    var mType = this.mType;
    var i;
    hop.fill(HOP_INF);
    if (start < 0) {
      this.armyDist.fill(INF);
      return this.armyDist;
    }
    var q = this.q;
    var head = 0;
    var tail = 0;
    hop[start] = 0;
    q[tail++] = start;
    while (head < tail) {
      var cur = q[head++];
      var hd = hop[cur] + 1;
      for (var k = 0; k < 4; k++) {
        var next = nbrs[cur * 4 + k];
        if (next < 0 || hop[next] !== HOP_INF) continue;
        if (isImpassable(mType[next])) continue;
        hop[next] = hd;
        q[tail++] = next;
      }
    }

    var dist = this.armyDist;
    dist.fill(INF);
    dist[start] = 0;
    var maxHop = 0;
    for (i = 0; i < n; i++) if (hop[i] < HOP_INF && hop[i] > maxHop) maxHop = hop[i];
    for (var hh = 0; hh <= maxHop; hh++) {
      for (i = 0; i < n; i++) {
        if (hop[i] !== hh) continue;
        if (dist[i] === INF) continue;
        var w = dist[i];
        for (var k2 = 0; k2 < 4; k2++) {
          var nx = nbrs[i * 4 + k2];
          if (nx < 0 || hop[nx] !== hh + 1) continue;
          var nd = w + this._netArmy(nx) - 1;
          if (nd < dist[nx]) dist[nx] = nd;
        }
      }
    }
    return dist;
  }

  /* 原版 getAccessibility：从将军出发的 Dijkstra，代价按「进入 cur 的代价」累加 */
  _getAccessibility() {
    var n = this.n;
    var acc = this.acc;
    var vis = this.accVis;
    var mType = this.mType;
    var mOccupier = this.mOccupier;
    var mArmy = this.mArmy;
    var nbrs = this.nbrs;
    var me = this.me;
    acc.fill(INF);
    vis.fill(0);
    if (this.spawn < 0) return acc;
    var heap = this.hMin;
    heap.clear();
    acc[this.spawn] = 0;
    heap.push(0, this.spawn);
    while (true) {
      var cur = heap.pop();
      if (cur < 0) break;
      var ac = heap.lastKey;
      if (ac !== acc[cur]) continue;
      if (vis[cur]) continue;
      vis[cur] = 1;
      var inc = 0;
      if (mOccupier[cur] !== me) {
        var tt = mType[cur];
        if (tt === T_DESERT || tt === T_BLANK) inc = 1;
        else if (tt === T_CITY || tt === T_GENERAL) inc = 2;
        else if (tt === T_SWAMP) inc = 5;
        else if (tt === T_OBSTACLE) inc = 200;
        else if (tt === T_MOUNTAIN || tt === T_LOOKOUT || tt === T_OBSERVATORY) inc = INF;
        else inc = 0;
        inc += mArmy[cur];
      }
      for (var k = 0; k < 4; k++) {
        var next = nbrs[cur * 4 + k];
        if (next < 0) continue;
        if (isImpassable(mType[next])) continue;
        var nd = ac + inc;
        if (nd < acc[next]) {
          acc[next] = nd;
          heap.push(nd, next);
        }
      }
    }
    return acc;
  }

  /* 原版 findRouteTo：从目标反向搜「路线上的兵够不够」，返回从 start 到 desti 的路径 */
  _findRouteTo(desti) {
    var n = this.n;
    var me = this.me;
    var i;
    var rDist = this.rDist;
    var rFriend = this.rFriend;
    var rOppo = this.rOppo;
    var rTypeCost = this.rTypeCost;
    var rVis = this.rVis;
    var toTile = this.toTile;

    for (i = 0; i < n; i++) {
      rDist[i] = DIST_INF;
      rFriend[i] = -INF;
      rOppo[i] = INF;
      rTypeCost[i] = 0;
      rVis[i] = 0;
      toTile[i] = -1;
    }
    rDist[desti] = 0;
    rFriend[desti] = 0;
    rOppo[desti] = 1;

    var heap = this.hMax;
    heap.clear();
    heap.push((-1) * 1, desti); // united(desti) = (0 - 1) - 0
    var start = desti;
    var netDesti = this._netArmy(desti);
    var mType = this.mType;
    var mArmy = this.mArmy;
    var mOccupier = this.mOccupier;
    var nbrs = this.nbrs;

    while (true) {
      var cur = heap.pop();
      if (cur < 0) break;
      var curU = heap.lastKey;
      if (rVis[cur]) continue;
      rVis[cur] = 1;
      if (curU > 0 && curU + netDesti > 0 && mOccupier[cur] === me) {
        start = cur;
        break;
      }
      var cd = rDist[cur] + 1;
      var cf = rFriend[cur];
      var co = rOppo[cur];
      var ct = rTypeCost[cur];
      for (var k = 0; k < 4; k++) {
        var next = nbrs[cur * 4 + k];
        if (next < 0 || rVis[next]) continue;
        if (isImpassable(mType[next])) continue;
        var nf = cf;
        var no = co;
        if (mOccupier[next] === me) nf += mArmy[next] - 1;
        else no += mArmy[next] + 1;
        if (mType[next] === T_SWAMP) no += 1;
        var nu = nf - no - ct;
        var oldU = rFriend[next] - rOppo[next] - rTypeCost[next];
        if (nu > oldU) {
          rDist[next] = cd;
          rFriend[next] = nf;
          rOppo[next] = no;
          toTile[next] = cur;
          heap.push(nu, next);
        }
      }
    }

    var route = [start];
    var guard = 0;
    while (toTile[route[route.length - 1]] >= 0) {
      route.push(toTile[route[route.length - 1]]);
      if (++guard > n) break; // 防御：toTile 理论上无环，但不允许它把 plan() 卡死
    }
    return route;
  }

  _typeValue(tt) {
    if (tt === T_DESERT) return -1;
    if (tt === T_BLANK) return 0;
    if (tt === T_CITY) return 35;
    if (tt === T_GENERAL) return 100;
    if (tt === T_SWAMP) return -100;
    if (tt === T_MOUNTAIN || tt === T_LOOKOUT || tt === T_OBSERVATORY) return -INF;
    return 0;
  }

  plan(view) {
    if (!this.inited || this.w !== view.w || this.h !== view.h) this._init(view);
    this.halfTurn++;
    this.turn += this.halfTurn & 1;
    this.me = view.me;
    var n = this.n;
    var me = this.me;
    var i;

    this._updateMemory(view, buildGeneralMask(view, this.gMask));

    // rank 拿不到：总兵 / 地盘从自己视野里数
    var totalArmy = 0;
    var totalLand = 0;
    for (i = 0; i < n; i++) {
      if (this.mOccupier[i] !== me) continue;
      if (this.mArmy[i] > 0) totalArmy += this.mArmy[i];
      totalLand++;
    }
    this.totalArmy = totalArmy;
    this.totalLand = totalLand;
    if (this.spawn < 0) return null;

    var dist = this._getDist(this.spawn);
    var adist = this._getArmyDist(this.spawn);
    var acc = this._getAccessibility();

    var self = this;
    var lastTargetBonus = 100;
    var calcValue = function (pos) {
      var res = 0;
      if (pos === self.lastTarget) res += lastTargetBonus + self.lastMovedArmy;
      res -= self.mArmy[pos];
      var occ = self.mOccupier[pos];
      if (occ !== -1 && occ !== me) res += -4 * dist[pos] - 2 * adist[pos];
      res -= 2 * dist[pos];
      res += self._typeValue(self.mType[pos]);
      res -= acc[pos];
      return res;
    };

    var target = this.spawn;
    var targetValue = -INF;
    for (i = 0; i < n; i++) {
      if (this.mOccupier[i] === me) continue;
      var tt = this.mType[i];
      if (isImpassable(tt)) continue;
      if (tt === T_SWAMP && this.mOccupier[i] === -1) continue;
      var v = calcValue(i);
      if (v > targetValue) {
        targetValue = v;
        target = i;
      }
    }
    this.lastTarget = target;

    var route = this._findRouteTo(target);
    if (route.length < 2) return null;

    var from = route[0];
    var to = route[1];
    var fromArmy = this.mArmy[from];
    var half = false;
    if (
      this.mType[from] !== T_SWAMP &&
      this.rFriend[from] - this.rOppo[from] + this._netArmy(target) - 1 - this.rDist[from] >=
        Math.floor(fromArmy / 2)
    ) {
      half = true;
    }

    var taken = half ? Math.floor(fromArmy / 2) : fromArmy;
    if (this.mOccupier[to] !== me) this.mArmy[to] -= taken;
    else this.mArmy[to] += taken;
    this.mArmy[from] -= taken;
    this.lastMovedArmy = taken;

    return { from: from, to: to, split: half };
  }
};
