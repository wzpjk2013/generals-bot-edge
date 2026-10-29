/*
 * 参考 bot 的 JS 移植，用于 PK。原版是 strakam/generals-bots 里的 JAX agent：
 *
 *   random_agent.py     随机合法走子
 *   expander_agent.py   边境能吃的就吃，按兵力加权随机
 *   hunter_agent.py     守住将军，多余的兵做成一条推进的蛇，够得着敌将就斩
 *   harvester_agent.py  hunter + 顺路收编吃得起的中立城市
 *
 * 全部保持原逻辑：每个 agent 每回合只提议一个动作，split 语义照抄
 * （hunter 在「喂兵」时走一半）。视野是完整的（1v1 没有迷雾，和原 env 一致）。
 *
 * 约定：
 *   view = {w, h, armies:Int32Array, owner:Int16Array, cities:Uint8Array,
 *           mountains:Uint8Array, me:number, general:number}
 *   action = {from, to, split} | null
 */
'use strict';

var DIRS = [-1, 1, -1, 1]; // 占位，实际用下面的 neighbors()
var INF = 1e9;

function idxOf(w, h, x, y) {
  return y * w + x;
}

function neighborsOf(view, i, passableOnly) {
  var w = view.w;
  var h = view.h;
  var out = [];
  var x = i % w;
  var y = (i / w) | 0;
  if (y > 0 && (!passableOnly || !view.mountains[i - w])) out.push(i - w);
  if (y < h - 1 && (!passableOnly || !view.mountains[i + w])) out.push(i + w);
  if (x > 0 && (!passableOnly || !view.mountains[i - 1])) out.push(i - 1);
  if (x < w - 1 && (!passableOnly || !view.mountains[i + 1])) out.push(i + 1);
  return out;
}

/* 4 邻里的方向序：0=UP 1=DOWN 2=LEFT 3=RIGHT，和原版 DIRECTIONS 一致 */
function stepOf(view, i, dir) {
  var w = view.w;
  var x = i % w;
  var y = (i / w) | 0;
  if (dir === 0) return y > 0 ? i - w : -1;
  if (dir === 1) return y < view.h - 1 ? i + w : -1;
  if (dir === 2) return x > 0 ? i - 1 : -1;
  return x < view.w - 1 ? i + 1 : -1;
}

/** 从 sources 出发在 passable 上做 BFS 步数场，源点恒为 0 */
function bfsField(view, passable, sources) {
  var n = view.w * view.h;
  var big = n + 5;
  var d = new Int32Array(n).fill(big);
  var q = [];
  var i;
  for (i = 0; i < n; i++) {
    if (sources[i]) {
      d[i] = 0;
      q.push(i);
    }
  }
  for (var h = 0; h < q.length; h++) {
    var cur = q[h];
    var nb = neighborsOf(view, cur, false);
    for (var k = 0; k < nb.length; k++) {
      var j = nb[k];
      if (!passable[j]) continue;
      if (d[cur] + 1 < d[j]) {
        d[j] = d[cur] + 1;
        q.push(j);
      }
    }
  }
  return d;
}

/** 每格朝向「field 值最低的可通行邻居」的方向与其值 */
function toward(view, field, passable) {
  var n = view.w * view.h;
  var dirOut = new Int8Array(n);
  var nbrOut = new Int32Array(n).fill(INF);
  for (var i = 0; i < n; i++) {
    var best = INF;
    var bestDir = 0;
    for (var dir = 0; dir < 4; dir++) {
      var j = stepOf(view, i, dir);
      if (j < 0 || !passable[j]) continue;
      if (field[j] < best) {
        best = field[j];
        bestDir = dir;
      }
    }
    dirOut[i] = bestDir;
    nbrOut[i] = best;
  }
  return { dir: dirOut, nbr: nbrOut };
}

function ownerArrays(view) {
  var n = view.w * view.h;
  var mine = new Uint8Array(n);
  var enemy = new Uint8Array(n);
  var neutral = new Uint8Array(n);
  for (var i = 0; i < n; i++) {
    var o = view.owner[i];
    if (o === view.me) mine[i] = 1;
    else if (o >= 0) enemy[i] = 1;
    else if (o === -1) neutral[i] = 1;
  }
  return { mine: mine, enemy: enemy, neutral: neutral };
}

function argmaxWhere(arr) {
  var best = -1;
  var bestVal = -1;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] > bestVal) {
      bestVal = arr[i];
      best = i;
    }
  }
  return best;
}

/* ---------------- random ---------------- */

function RandomAgent(rng) {
  this.rng = rng;
  this.splitProb = 0.25;
  this.idleProb = 0.05;
}

RandomAgent.prototype.plan = function (view) {
  var n = view.w * view.h;
  var valid = [];
  for (var i = 0; i < n; i++) {
    if (view.owner[i] !== view.me || view.armies[i] <= 1) continue;
    var nb = neighborsOf(view, i, true);
    for (var k = 0; k < nb.length; k++) valid.push([i, nb[k]]);
  }
  if (!valid.length || this.rng() < this.idleProb) return null;
  var pick = valid[(this.rng() * valid.length) | 0];
  return { from: pick[0], to: pick[1], split: this.rng() < this.splitProb };
};

/* ---------------- expander ---------------- */

function ExpanderAgent(rng) {
  this.rng = rng;
}

ExpanderAgent.prototype.plan = function (view) {
  var n = view.w * view.h;
  var o = ownerArrays(view);
  var entries = [];
  var scores = [];
  var total = 0;
  for (var i = 0; i < n; i++) {
    if (!o.mine[i] || view.armies[i] <= 1) continue;
    for (var dir = 0; dir < 4; dir++) {
      var j = stepOf(view, i, dir);
      if (j < 0 || view.mountains[j]) continue;
      var a = view.armies[i];
      var d = view.armies[j];
      var canCapture = a > d + 1;
      var isExpansion = !o.mine[j] && (o.enemy[j] || o.neutral[j]);
      var score = 0;
      if (canCapture) {
        score = a;
        if (isExpansion) {
          score *= 10;
          if (o.enemy[j]) score *= 2;
        }
      }
      entries.push([i, j]);
      scores.push(score);
      total += score;
    }
  }
  if (!entries.length) return null;
  var pickIdx = -1;
  if (total > 0) {
    var r = this.rng() * total;
    var acc = 0;
    for (var k = 0; k < scores.length; k++) {
      acc += scores[k];
      if (r <= acc) {
        pickIdx = k;
        break;
      }
    }
    if (pickIdx < 0) pickIdx = scores.length - 1;
  } else {
    pickIdx = (this.rng() * entries.length) | 0;
  }
  return { from: entries[pickIdx][0], to: entries[pickIdx][1], split: false };
};

/* ---------------- hunter ---------------- */

var GARRISON = 4;

function hunterCore(view, opt) {
  var n = view.w * view.h;
  var o = ownerArrays(view);
  var i, k;
  var gen = -1;
  for (i = 0; i < n; i++) if (o.mine[i] && view.generals[i]) gen = i;
  if (gen < 0) return null;

  // 吃得起的中立城市（只有 harvester 有）
  var affordable = new Uint8Array(n);
  var biggest = 0;
  for (i = 0; i < n; i++) if (o.mine[i] && view.armies[i] > biggest) biggest = view.armies[i];
  if (opt.cities) {
    for (i = 0; i < n; i++) {
      if (view.cities[i] && o.neutral[i] && biggest - 1 > view.armies[i]) affordable[i] = 1;
    }
  }

  var passable = new Uint8Array(n);
  for (i = 0; i < n; i++) {
    if (view.mountains[i]) continue;
    if (view.cities[i] && !o.mine[i] && !affordable[i]) continue; // 城是墙
    passable[i] = 1;
  }

  var srcGen = new Uint8Array(n);
  srcGen[gen] = 1;
  var fromGen = bfsField(view, passable, srcGen);
  var reach = n;

  var egen = new Uint8Array(n);
  var enemyLand = new Uint8Array(n);
  var anyEgen = false;
  var anyEnemy = false;
  var egenArmy = 0;
  for (i = 0; i < n; i++) {
    if (o.enemy[i] && view.generals[i]) {
      egen[i] = 1;
      anyEgen = true;
      egenArmy += view.armies[i];
    }
    if (o.enemy[i] && !view.cities[i]) {
      enemyLand[i] = 1;
      anyEnemy = true;
    }
  }

  var goal = new Uint8Array(n);
  var anyAffordable = false;
  if (opt.cities) for (i = 0; i < n; i++) if (affordable[i]) anyAffordable = true;

  if (anyEgen) {
    goal = egen;
  } else if (opt.cities && anyAffordable) {
    goal = affordable;
  } else if (anyEnemy) {
    goal = enemyLand;
  } else {
    // 最远的迷雾格（全视野下就是最远的可通行非我方格）
    var far = -1;
    var farD = -1;
    for (i = 0; i < n; i++) {
      if (!passable[i] || o.mine[i] || fromGen[i] >= reach) continue;
      if (fromGen[i] > farD) {
        farD = fromGen[i];
        far = i;
      }
    }
    if (far < 0) return null;
    goal[far] = 1;
  }

  var toGoal = bfsField(view, passable, goal);
  var tw = toward(view, toGoal, passable);

  var movable = new Uint8Array(n);
  for (i = 0; i < n; i++) if (o.mine[i] && view.armies[i] > 1) movable[i] = 1;

  // kill
  var killScore = new Int32Array(n).fill(-1);
  var anyKill = false;
  if (anyEgen) {
    for (i = 0; i < n; i++) {
      if (!killCandidate(i)) continue;
      killScore[i] = view.armies[i];
      anyKill = true;
    }
  }
  function killCandidate(i) {
    if (!movable[i]) return false;
    if (toGoal[i] !== 1) return false;
    if (!(tw.nbr[i] < toGoal[i])) return false;
    if (!(view.armies[i] - 1 > egenArmy)) return false;
    var target = stepOf(view, i, tw.dir[i]);
    return target >= 0 && egen[target] === 1;
  }
  var ki = anyKill ? argmaxWhere(killScore) : -1;

  // feed：将军兵够多就往目标方向走一半
  var genArmy = view.armies[gen];
  var feed = genArmy >= 2 * GARRISON && tw.nbr[gen] < toGoal[gen];

  // conveyor：非将军、能动、朝目标
  var fwdScore = new Int32Array(n).fill(-1);
  var anyFwd = false;
  for (i = 0; i < n; i++) {
    if (!movable[i] || i === gen) continue;
    if (!(tw.nbr[i] < toGoal[i])) continue;
    fwdScore[i] = view.armies[i];
    anyFwd = true;
  }
  var ci = anyFwd ? argmaxWhere(fwdScore) : -1;

  if (anyKill && ki >= 0) {
    return { from: ki, to: stepOf(view, ki, tw.dir[ki]), split: false };
  }
  if (feed) {
    return { from: gen, to: stepOf(view, gen, tw.dir[gen]), split: true };
  }
  if (anyFwd && ci >= 0) {
    return { from: ci, to: stepOf(view, ci, tw.dir[ci]), split: false };
  }
  return null;
}

function HunterAgent() {}
HunterAgent.prototype.plan = function (view) {
  return hunterCore(view, { cities: false });
};

function HarvesterAgent() {}
HarvesterAgent.prototype.plan = function (view) {
  return hunterCore(view, { cities: true });
};

/* ---------------- ladder：移植 harrischristiansen/generals-bot ---------------- */

/*
 * https://github.com/harrischristiansen/generals-bot
 *
 * 这个 bot 和 strakam 的三个基线不是一个量级：它有天梯实战成绩，最完整的是
 * 「目标距离折扣」和「守备需求」。原版是 Python，这里按同一套判据重写：
 *
 *   目标挑选（base/client/tile.py: calculateTargetDistance / map.py）
 *     敌将            距离 × 0.09    （显得近 11 倍）
 *     城              距离 × clamp(0.17, 守军/(3.2×我方最大堆), 20)
 *     空地            距离 × 4.3     （铺地最不值钱）
 *     兵力比我厚      距离 × 1.6 × (敌兵/我兵)
 *     打不动的目标    max_target_army = 4×最大堆 + 14 以上直接跳过
 *
 *   守备需求（base/bot_moves.py: garrison_needed）
 *     needed = min(威胁 + 2, 0.5 × 总兵)
 *     locked ⟺ 将军兵 − ⌊将军兵/2⌋ ≤ needed
 *     一旦 generalKnownToEnemy（粘性），将军所有出子降级成 half
 *
 *   出兵格挑选（map.py: get_biggest_tile）
 *     将军要参与「最厚堆」评选，得先 army×0.5 ≥ 场上最大堆（且 army ≥ 12）
 *
 * 迷雾上它没有特殊处理，和原版一致：FOG 格当成可通行、可吃。
 */
function LadderAgent(rng) {
  this.rng = rng;
  this.turn = 0;
  this.genKnown = false;
}

LadderAgent.prototype.plan = function (view) {
  var w = view.w;
  var h = view.h;
  var n = w * h;
  this.turn++;

  var me = view.me;
  var i;
  var k;
  var gen = -1;
  for (i = 0; i < n; i++) if (view.generals[i] && view.owner[i] === me) gen = i;

  // 可见敌格 / 敌将 / 雾格
  var enemy = new Uint8Array(n);
  var egen = -1;
  var biggest = 0;
  var totalArmy = 0;
  for (i = 0; i < n; i++) {
    if (view.owner[i] === me) {
      totalArmy += view.armies[i];
      if (view.armies[i] > biggest) biggest = view.armies[i];
    } else if (view.owner[i] >= 0) {
      enemy[i] = 1;
      if (view.generals[i]) egen = i;
    }
  }

  // generalKnownToEnemy：贴着我将军的敌格 = 他看得见我
  if (gen >= 0) {
    for (var dir = 0; dir < 4; dir++) {
      var gj = stepOf(view, gen, dir);
      if (gj >= 0 && enemy[gj]) this.genKnown = true;
    }
  }

  // 守备需求
  var need = 0;
  if (gen >= 0 && this.genKnown) {
    var dg = bfsField(view, allPassable(view), (function () {
      var s = new Uint8Array(n);
      s[gen] = 1;
      return s;
    })());
    var threat = 0;
    for (i = 0; i < n; i++) {
      if (!enemy[i] || dg[i] > 8) continue;
      if (view.generals[i] || view.cities[i]) continue; // 坐家产的守备不算来袭
      if (view.armies[i] > threat) threat = view.armies[i];
    }
    if (threat > 0) need = Math.min(threat + 2, totalArmy * 0.5);
  }
  var locked = gen >= 0 && need > 0 && view.armies[gen] - (view.armies[gen] >> 1) <= need;

  // 目标距离折扣
  var passable = allPassable(view);
  var src = new Uint8Array(n);
  src[gen >= 0 ? gen : 0] = 1;
  var dist = bfsField(view, passable, src);
  var maxTargetArmy = biggest * 4 + 14;
  var best = -1;
  var bestScore = INF;
  for (i = 0; i < n; i++) {
    if (view.owner[i] === me || !passable[i]) continue;
    if (dist[i] >= INF) continue;
    if (view.armies[i] > maxTargetArmy) continue;
    var d = dist[i];
    if (enemy[i]) {
      d = view.generals[i] ? d * 0.09 : d * 0.5;
      if (biggest > 0 && view.armies[i] > biggest) d *= (1.6 * view.armies[i]) / biggest;
    } else if (view.cities[i]) {
      var f = view.armies[i] / (3.2 * (biggest || 1));
      if (f < 0.17) f = 0.17;
      if (f > 20) f = 20;
      d = d * f;
    } else {
      d = d * 4.3; // 空地最不值钱
    }
    if (d < bestScore) {
      bestScore = d;
      best = i;
    }
  }
  if (best < 0) return null;

  // 朝目标推：目标方向场 + 选最厚的可动堆
  var tf = bfsField(view, passable, (function () {
    var s = new Uint8Array(n);
    s[best] = 1;
    return s;
  })());
  var tw = toward(view, tf, passable);

  var from = -1;
  var fromA = 0;
  for (i = 0; i < n; i++) {
    if (view.owner[i] !== me || view.armies[i] <= 1) continue;
    if (view.armies[i] < tf[i]) continue; // 走不到更近
    if (i === gen) {
      // 将军要够厚、且没被锁，才当主力堆
      if (locked) continue;
      if (this.genKnown && view.armies[i] * 0.5 < fromA) continue;
      if (view.armies[i] * 0.5 < fromA) continue;
    }
    if (view.armies[i] > fromA) {
      fromA = view.armies[i];
      from = i;
    }
  }
  if (from < 0) return null;
  var to = stepOf(view, from, tw.dir[from]);
  if (to < 0 || view.mountains[to]) return null;
  if (view.armies[from] - 1 <= view.armies[to]) return null;
  return { from: from, to: to, split: from === gen && this.genKnown };
};

function allPassable(view) {
  var n = view.w * view.h;
  var p = new Uint8Array(n);
  for (var i = 0; i < n; i++) if (!view.mountains[i]) p[i] = 1;
  return p;
}

/* ---------------- gc：移植 LocalGen-new 的 GcBot ---------------- */

/*
 * https://github.com/SZXC-WG/LocalGen-new/blob/master/src/bots/gcBot.cpp
 *（GoodCoder666，GPL-3.0）
 *
 * 这是目前能找到的开源启发式里最强的一个，也是结构最不一样的一个：它不选「目标格」
 * 然后朝那儿推，而是给每格算一个**路线估价**，再在整张图上找价值最高的块。
 *
 *   evaluateRouteCosts(st)：从 st 出发 BFS，沿路累加 gv()
 *     gv = 沼泽 -2 / 未知障碍 0 / 没见过的格子 +2 / 自己的格 army-1
 *          城 -army/2 + (出发格兵/12) / 敌格 -army
 *     同一距离下有两条路时取 eval 更高的那条 → 相当于「走富矿那条路」
 *
 *   目标分块价值
 *     tileValue = tileTypeValue[type] + eval/5 - (dist + army/2) - √(40·曼哈顿距将军)
 *     tileTypeValue 随兵力变形（armyStrength = log(min(3000, 总兵)+1)）：
 *       平原 55-5s、沼泽 -500+50s、城 s²、未知障碍 35+4s
 *
 *   迷雾探索
 *     needExploration = 没见过の平原，或者邻接「没见过的障碍」（可能是城）
 *     取这些格子里距离的第 25 百分位（不是最近的那个，避免所有兵挤同一个角），
 *     再和常规目标按 max(4·√总兵 - dist·3, …) 比一比
 *
 *   出兵
 *     从 lastPos 出发沿 par 链走一步；有 7% 概率改成「重新选一个更靠近目标的出发格」
 *     （A/B 里这一步是它拉开差距的地方：它会把后排积压的兵调上来）
 *
 *   将军
 *     maxArmyPos 里将军的兵打 3/4 折、城打 5/6 折：将军要比最强地块厚 4/3 才会被
 *     当成推土机；`distPenalty[d] = √(40d)` 把兵拴在将军周围
 *
 * 目标粘性：新目标的分数要超过旧目标 max(100, 0.03·army^0.86) 才换。
 *
 * 和原版的取舍：原版能一次下发多条（moveQueue），这里按擂台赛制每回合只回一条；
 * rank 表拿不到，总兵力/地盘从自己的视野里算。
 */
var GC_INF = 1e15;

function tileTypeOf(view, i) {
  var o = view.owner[i];
  if (o === -3) return 'plain'; // TILE_FOG：没见过的普通格
  if (o === -4) return 'obstacle'; // TILE_FOG_OBSTACLE：山或城，看不见就分不出
  if (o === -2) return 'mountain';
  if (view.cities[i]) return 'city';
  if (view.generals[i]) return 'general';
  return 'plain';
}

function GcBotAgent() {
  this.inited = false;
  this.turn = 0;
  this.tiles = null;
  this.seenGeneral = null;
  this.prevTarget = -1;
  this.lastPos = -1;
  this.distPenalty = null;
  this.tv = { plain: 0, swamp: 0, city: 0, obstacle: 0, general: 0, mountain: 0 };
}

GcBotAgent.prototype.init = function (n, w, h) {
  this.w = w;
  this.h = h;
  this.n = n;
  this.tiles = new Array(n);
  for (var i = 0; i < n; i++) {
    this.tiles[i] = { army: -1, par: -1, eval: 0, dist: 0, occupier: -1, type: 'plain', known: false };
  }
  this.seenGeneral = [-1, -1];
  this.distPenalty = new Int32Array(w + h);
  for (var d = 0; d < w + h; d++) this.distPenalty[d] = Math.floor(Math.sqrt(d * 40));
  this.inited = true;
};

GcBotAgent.prototype.accessible = function (i) {
  if (i < 0 || i >= this.n) return false;
  var t = this.tiles[i].type;
  return t !== 'mountain' && t !== 'obstacle';
};

/* updateMemory：看见就记，看不见就保留记忆（GcBot 的 known 是粘性的） */
GcBotAgent.prototype.updateMemory = function (view, me) {
  for (var i = 0; i < this.n; i++) {
    var tile = this.tiles[i];
    var type = tileTypeOf(view, i);
    var visible = view.owner[i] !== -3 && view.owner[i] !== -4;
    if (visible) {
      tile.known = true;
      tile.type = type;
      tile.occupier = view.owner[i];
      if (type === 'general' && tile.occupier >= 0) this.seenGeneral[tile.occupier] = i;
      var seen = view.armies[i];
      tile.army =
        tile.army < 0 || tile.occupier === me || tile.occupier === -1
          ? seen
          : ((seen + tile.army) / 2) | 0;
    } else if (!tile.known) {
      tile.type = type;
    }
  }
};

/* 从 st 出发的路线估价 BFS（GcBot::evaluateRouteCosts） */
GcBotAgent.prototype.evaluateRouteCosts = function (st, view, me) {
  var n = this.n;
  var w = this.w;
  var cityBonus = ((this.tiles[st].army / 12) | 0);
  var self = this;
  var gv = function (t) {
    if (t.type === 'obstacle') return 0;
    if (!t.known) return 2;
    if (t.occupier === me) return t.army - 1;
    if (t.type === 'city') return -((t.army / 2) | 0) + cityBonus;
    return -t.army;
  };
  var i;
  for (i = 0; i < n; i++) {
    this.tiles[i].dist = 32767;
    this.tiles[i].eval = -GC_INF;
    this.tiles[i].par = -1;
  }
  var q = [st];
  this.tiles[st].dist = 0;
  this.tiles[st].eval = 0;
  for (var h = 0; h < q.length; h++) {
    var cur = q[h];
    var tile = this.tiles[cur];
    tile.eval += gv(tile);
    var nb = neighborsOf(view, cur, false);
    for (var k = 0; k < nb.length; k++) {
      var nx = nb[k];
      if (!self.accessible(nx)) continue;
      var nTile = self.tiles[nx];
      var nd = tile.dist + 1;
      if (nd < nTile.dist) {
        nTile.dist = nd;
        nTile.eval = tile.eval;
        nTile.par = cur;
        q.push(nx);
      } else if (nd === nTile.dist && tile.eval > nTile.eval) {
        nTile.eval = tile.eval;
        nTile.par = cur;
      }
    }
  }
};

GcBotAgent.prototype.moveTowards = function (st, dest) {
  var guard = 0;
  while (this.tiles[dest].par !== st) {
    var nx = this.tiles[dest].par;
    if (nx < 0) return st;
    dest = nx;
    if (++guard > this.n) return st;
  }
  return dest;
};

GcBotAgent.prototype.maxArmyPos = function (me) {
  var best = this.seenGeneral[me] >= 0 ? this.seenGeneral[me] : 0;
  var maxArmy = 0;
  for (var i = 0; i < this.n; i++) {
    var t = this.tiles[i];
    if (t.occupier !== me) continue;
    var wa = t.army;
    if (t.type === 'general') wa -= (wa / 4) | 0;
    else if (t.type === 'city') wa -= (wa / 6) | 0;
    if (wa > maxArmy) {
      maxArmy = wa;
      best = i;
    }
  }
  return best;
};

GcBotAgent.prototype.plan = function (view) {
  var n = view.w * view.h;
  if (!this.inited) this.init(n, view.w, view.h);
  this.turn++;
  var me = view.me;
  this.updateMemory(view, me);

  var self = this;
  var i;

  var myArmy = 0;
  var myLand = 0;
  for (i = 0; i < n; i++) {
    if (this.tiles[i].occupier === me) {
      myArmy += Math.max(0, this.tiles[i].army);
      myLand++;
    }
  }

  // 开局：将军第一步踩最便宜的邻格
  if (this.turn < 13 && myLand === 1) {
    var gen = this.seenGeneral[me];
    if (gen < 0) return null;
    var minArmy = this.tiles[gen].army - 1;
    var pick = gen;
    var nb0 = neighborsOf(view, gen, false);
    for (i = 0; i < nb0.length; i++) {
      var j0 = nb0[i];
      if (!this.accessible(j0)) continue;
      var t0 = this.tiles[j0];
      if (t0.type !== 'city' && !(t0.army < 0)) continue;
      if (t0.army < minArmy) {
        minArmy = t0.army;
        pick = j0;
      }
    }
    if (pick === gen) return null;
    this.lastPos = pick;
    return { from: gen, to: pick, split: false };
  }

  var s = Math.log(Math.min(3000, myArmy) + 1);
  this.tv.plain = 55 - ((5 * s) | 0);
  this.tv.swamp = -500 + ((50 * s) | 0);
  this.tv.city = (s * s) | 0;
  this.tv.obstacle = 35 + ((4 * s) | 0);

  var coo = this.lastPos;
  if (coo < 0 || !this.accessible(coo) || this.tiles[coo].occupier !== me || this.tiles[coo].army < 2) {
    coo = this.maxArmyPos(me);
    this.prevTarget = -1;
  } else if (coo === this.prevTarget || (this.prevTarget >= 0 && this.tiles[this.prevTarget].occupier === me)) {
    this.prevTarget = -1;
  }

  this.evaluateRouteCosts(coo, view, me);

  var targetPos = -1;
  // 见过敌将 → 直接奔那儿；1v1 只有一个对手
  var opp = 1 - me;
  if (this.seenGeneral[opp] >= 0 && this.tiles[this.seenGeneral[opp]].occupier === opp) {
    targetPos = this.seenGeneral[opp];
  } else if (
    this.prevTarget < 0 ||
    this.tiles[this.prevTarget].type !== 'plain' ||
    this.tiles[this.prevTarget].known
  ) {
    var maxBlockValue = -GC_INF;

    // 探索：没见过的平原，或邻接没见过的障碍
    var unknown = [];
    for (i = 0; i < n; i++) {
      var t = this.tiles[i];
      if (t.dist >= 500 || t.eval <= -100) continue;
      if (t.type !== 'plain' && t.type !== 'swamp') continue;
      var need = t.type === 'plain' && !t.known;
      if (!need) {
        var nb1 = neighborsOf(view, i, false);
        for (var k1 = 0; k1 < nb1.length; k1++) {
          var j1 = nb1[k1];
          if (!self.accessible(j1)) continue;
          if (self.tiles[j1].type === 'obstacle' && !self.tiles[j1].known) {
            need = true;
            break;
          }
        }
      }
      if (need) unknown.push([t.dist, i]);
    }
    if (unknown.length) {
      unknown.sort(function (a, b) {
        return a[0] - b[0];
      });
      var kk = (unknown.length / 4) | 0;
      targetPos = unknown[kk][1];
      maxBlockValue = Math.floor(4 * Math.sqrt(myArmy)) - this.tiles[targetPos].dist * 3;
    }

    var genMe = this.seenGeneral[me];
    var computeTileValue = function (pos) {
      var tt = self.tiles[pos];
      var v = self.tv[tt.type] + tt.eval / 5 - (tt.dist + ((tt.army / 2) | 0));
      if (genMe >= 0) {
        var dx = Math.abs((pos % self.w) - (genMe % self.w));
        var dy = Math.abs(((pos / self.w) | 0) - ((genMe / self.w) | 0));
        v -= self.distPenalty[Math.min(self.w + self.h - 1, dx + dy)];
      }
      return v;
    };

    for (i = 0; i < n; i++) {
      var ti = this.tiles[i];
      if (ti.occupier === me || ti.dist >= 500) continue;
      if (!this.accessible(i) || ti.type === 'general') continue;
      var bv = computeTileValue(i);
      if (bv > maxBlockValue) {
        maxBlockValue = bv;
        targetPos = i;
      }
    }

    // 目标粘性
    if (this.prevTarget >= 0) {
      var pt = this.tiles[this.prevTarget];
      if (pt.occupier !== me && this.accessible(this.prevTarget)) {
        var prevValue = computeTileValue(this.prevTarget);
        var margin = Math.max(100, 0.03 * Math.pow(myArmy, 0.86));
        if (maxBlockValue - prevValue < margin) targetPos = this.prevTarget;
      }
    }
  } else {
    targetPos = this.prevTarget;
  }

  this.prevTarget = targetPos;
  if (targetPos < 0) {
    this.lastPos = -1;
    return null;
  }

  // 95% 直接推一步；剩下 5% 左右重选一个更靠近目标的出发格（把后方积压的兵调上来）
  if (
    this.tiles[coo].type === 'swamp' ||
    this.rngThreshold() > 0.07 ||
    this.tiles[targetPos].eval > 150
  ) {
    var next = this.moveTowards(coo, targetPos);
    if (next === coo) {
      this.lastPos = -1;
      return null;
    }
    this.lastPos = next;
    return { from: coo, to: next, split: false };
  }

  this.evaluateRouteCosts(targetPos, view, me);
  var maxWeight = -GC_INF;
  var newFocus = -1;
  for (i = 0; i < n; i++) {
    var tf = this.tiles[i];
    if (tf.occupier !== me || tf.army <= 1) continue;
    var weight = tf.eval - 30 * tf.dist;
    if (tf.type === 'general') weight -= (weight / 4) | 0;
    if (weight > maxWeight) {
      maxWeight = weight;
      newFocus = i;
    }
  }
  if (newFocus < 0) {
    this.lastPos = -1;
    return null;
  }
  this.evaluateRouteCosts(newFocus, view, me);
  var np = this.moveTowards(newFocus, targetPos);
  if (np === newFocus) {
    this.lastPos = -1;
    return null;
  }
  this.lastPos = np;
  return { from: newFocus, to: np, split: false };
};

GcBotAgent.prototype.rngThreshold = function () {
  return Math.random();
};

/* ---------------- szly：移植 LocalGen-new 的 SzlyBot ---------------- */

/*
 * https://github.com/SZXC-WG/LocalGen-new/blob/master/src/bots/szlyBot.cpp
 *
 * 比 GcBot 老一代，但结构清爽，是 LocalGen v5 的遗物。核心是「块价值」：
 *
 *   computeRoutes(st)：从出兵格 BFS，沿路累加 gv（自己的格 +army、看得见的敌格 -army、
 *                     没见过按类型给分：空白 -5 / 城 -40 / 沼泽 -10 / 障碍 0）
 *   blockValue = 类型权重 - 距离     空白 30 / 城 35 / 沼泽 -1000 / 障碍 25 / 将军 6
 *   目标 = 全局 blockValue 最大的一格（见过敌将就直接奔敌将）
 *
 *   出兵之外还有一手「收兵」：看四位邻居，按 army - 250/(到将军距离+0.5) 打分，
 *   沼泽 +1、将军 ×0.6、城 ×0.8；用 tanh(分数·0.015) 的概率把邻居并进来，
 *   而不是自己往前走。这就是它把后排兵往前挪的方式。
 *
 * 迷雾：没见过的格子在 blockType 里记成「空白 / 障碍」，障碍按不可通行处理，
 * 所以它不会往雾里的山/城上撞，但也从不主动去探。
 */
function SzlyBotAgent() {
  this.inited = false;
  this.lastPos = -1;
  this.myGeneral = -1;
  this.seenGeneral = [-1, -1];
  this.blockType = null;
  this.known = null;
  this.blockValue = null;
  this.evalArr = null;
  this.parent = null;
  this.dist = null;
}

var SZ_INF = 1e15;
var SZ_BLOCK_WEIGHT = {
  blank: 30,
  swamp: -1000,
  mountain: -SZ_INF,
  general: 6,
  city: 35,
  obstacle: 25
};
var SZ_TYPE_VALUE = { blank: -5, mountain: -SZ_INF, city: -40, swamp: -10, general: -5, obstacle: 0 };

SzlyBotAgent.prototype.init = function (n, w, h) {
  this.n = n;
  this.w = w;
  this.h = h;
  this.blockType = new Array(n).fill('blank');
  this.known = new Uint8Array(n);
  this.blockValue = new Float64Array(n);
  this.evalArr = new Float64Array(n);
  this.parent = new Int32Array(n).fill(-1);
  this.dist = new Int32Array(n).fill(0x3f3f3f3f);
  this.inited = true;
};

SzlyBotAgent.prototype.impassable = function (i) {
  return this.blockType[i] === 'mountain' || this.blockType[i] === 'obstacle';
};

SzlyBotAgent.prototype.computeRoutes = function (st, view, me) {
  var n = this.n;
  var self = this;
  for (var i = 0; i < n; i++) {
    this.dist[i] = 0x3f3f3f3f;
    this.evalArr[i] = -SZ_INF;
    this.parent[i] = -1;
  }
  var gv = function (j) {
    if (self.impassable(j)) return -SZ_INF;
    var o = view.owner[j];
    if (o === me) return view.armies[j];
    if (o !== -3 && o !== -4) return -view.armies[j];
    var v = SZ_TYPE_VALUE[self.blockType[j]];
    return v === undefined ? 0 : v;
  };
  var q = [st];
  this.dist[st] = 0;
  this.evalArr[st] = 0;
  for (var h = 0; h < q.length; h++) {
    var cur = q[h];
    var curDist = this.dist[cur];
    var curEval = (this.evalArr[cur] += gv(cur));
    var nb = neighborsOf(view, cur, false);
    for (var k = 0; k < nb.length; k++) {
      var nx = nb[k];
      if (this.impassable(nx)) continue;
      var nd = curDist + 1;
      if (nd < this.dist[nx]) {
        this.dist[nx] = nd;
        this.evalArr[nx] = curEval;
        this.parent[nx] = cur;
        q.push(nx);
      } else if (nd === this.dist[nx] && curEval > this.evalArr[nx]) {
        this.evalArr[nx] = curEval;
        this.parent[nx] = cur;
      }
    }
  }
  for (var i2 = 0; i2 < n; i2++) {
    var w = SZ_BLOCK_WEIGHT[this.blockType[i2]];
    if (w === undefined) w = 0;
    this.blockValue[i2] = view.owner[i2] === me ? -SZ_INF : w - this.dist[i2];
  }
};

SzlyBotAgent.prototype.moveTowards = function (st, dest) {
  var guard = this.n;
  while (this.parent[dest] !== st) {
    var nx = this.parent[dest];
    if (nx < 0 || --guard <= 0) return st;
    dest = nx;
  }
  return dest;
};

SzlyBotAgent.prototype.plan = function (view) {
  var n = view.w * view.h;
  if (!this.inited) this.init(n, view.w, view.h);
  var me = view.me;
  var i;

  for (i = 0; i < n; i++) {
    var o = view.owner[i];
    var visible = o !== -3 && o !== -4;
    if (visible) {
      this.known[i] = 1;
      if (view.generals[i] && o >= 0) {
        if (o === me) this.myGeneral = i;
        else if (o < this.seenGeneral.length) this.seenGeneral[o] = i;
      }
      this.blockType[i] = view.cities[i] ? 'city' : view.generals[i] && o >= 0 ? 'general' : o === -2 ? 'mountain' : 'blank';
    } else if (!this.known[i]) {
      this.blockType[i] = o === -4 ? 'obstacle' : 'blank';
    }
  }

  var coo = -1;
  if (this.lastPos >= 0 && view.owner[this.lastPos] === me && view.armies[this.lastPos] > 1) {
    coo = this.lastPos;
  }
  if (coo < 0) {
    var maxArmy = 0;
    coo = this.myGeneral >= 0 ? this.myGeneral : -1;
    for (i = 0; i < n; i++) {
      if (view.owner[i] !== me || view.armies[i] <= 0) continue;
      var wa = view.armies[i];
      if (this.blockType[i] === 'general') wa -= (wa / 4) | 0;
      else if (this.blockType[i] === 'city') wa -= (wa / 6) | 0;
      if (wa > maxArmy) {
        maxArmy = wa;
        coo = i;
      }
    }
  }
  if (coo < 0 || view.armies[coo] <= 1) return null;

  var modeAttack = false;
  var opp = 1 - me;
  if (this.seenGeneral[opp] >= 0 && view.owner[this.seenGeneral[opp]] === opp) modeAttack = true;
  else if (this.seenGeneral[opp] >= 0) modeAttack = true; // 记忆里的位置也照打

  this.computeRoutes(coo, view, me);

  var target = coo;
  var pMul = 1.0;
  if (modeAttack && this.seenGeneral[opp] >= 0) {
    target = this.seenGeneral[opp];
  } else {
    var best = -SZ_INF;
    for (i = 0; i < n; i++) {
      if (this.blockValue[i] > best) {
        best = this.blockValue[i];
        target = i;
      }
    }
    pMul *= 0.85;
  }
  if (this.parent[target] < 0) {
    var minD = 0x3f3f3f3f;
    for (i = 0; i < n; i++) {
      if (this.parent[i] >= 0 && this.dist[i] < minD) {
        minD = this.dist[i];
        target = i;
      }
    }
  }

  var fastest = this.moveTowards(coo, target);
  if (fastest === coo) return null;

  if (this.blockType[coo] === 'swamp') {
    this.lastPos = fastest;
    return { from: coo, to: fastest, split: false };
  }

  var gather = -1;
  var maxWeight = -1e18;
  var nb = neighborsOf(view, coo, false);
  for (var k = 0; k < nb.length; k++) {
    var nc = nb[k];
    if (nc === fastest) continue;
    if (view.owner[nc] !== me || view.armies[nc] <= 2) continue;
    var weight = view.armies[nc];
    if (this.myGeneral >= 0) {
      var dx = Math.abs((nc % this.w) - (this.myGeneral % this.w));
      var dy = Math.abs(((nc / this.w) | 0) - ((this.myGeneral / this.w) | 0));
      weight -= 250.0 / (dx + dy + 0.5);
    } else {
      weight -= 3;
    }
    if (this.blockType[nc] === 'swamp') weight += 1;
    else if (this.blockType[nc] === 'general') weight *= 0.6;
    else if (this.blockType[nc] === 'city') weight *= 0.8;
    if (weight > maxWeight) {
      maxWeight = weight;
      gather = nc;
    }
  }
  if (gather < 0 || Math.random() * 2 - 1 > pMul * Math.tanh(maxWeight * 0.015)) {
    this.lastPos = fastest;
    return { from: coo, to: fastest, split: false };
  }
  this.lastPos = coo;
  return { from: gather, to: coo, split: false };
};

/* ---------------- 出厂 ---------------- */

function makeRefAgent(name, rng) {
  if (name === 'random') return new RandomAgent(rng);
  if (name === 'expander') return new ExpanderAgent(rng);
  if (name === 'hunter') return new HunterAgent(rng);
  if (name === 'harvester') return new HarvesterAgent(rng);
  if (name === 'ladder') return new LadderAgent(rng);
  if (name === 'gc') return new GcBotAgent(rng);
  if (name === 'szly') return new SzlyBotAgent(rng);
  throw new Error('未知 agent: ' + name);
}

module.exports = { makeRefAgent: makeRefAgent, neighborsOf: neighborsOf, bfsField: bfsField };
