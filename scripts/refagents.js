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

/* ---------------- 出厂 ---------------- */

function makeRefAgent(name, rng) {
  if (name === 'random') return new RandomAgent(rng);
  if (name === 'expander') return new ExpanderAgent(rng);
  if (name === 'hunter') return new HunterAgent(rng);
  if (name === 'harvester') return new HarvesterAgent(rng);
  throw new Error('未知 agent: ' + name);
}

module.exports = { makeRefAgent: makeRefAgent, neighborsOf: neighborsOf, bfsField: bfsField };
