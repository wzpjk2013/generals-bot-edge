/*
 * 移植：EklipZgit/generals-ai —— Human.exe / EklipZ_ai
 *
 *   源码 https://github.com/EklipZgit/generals-ai（Python 2，run_bot.py + helpers.py）
 *   作者说它不用机器学习，纯手写评估，2016~2017 年稳定人类 1v1 前 10。
 *
 * 原版的结构是「一手一评估」：
 *   每回合把本回合所有合法动作（最多 200 条，按出兵格兵数降序截断）逐条**模拟**
 *   （helpers.apply_move：照着服务器规则走一遍，再把这一回合的产兵加上），
 *   在模拟出来的新局面里算一个标量分，取最高分那一条。没有搜索树、没有蒙特卡洛，
 *   就是「动作 → 局面 → 打分函数」。
 *
 * 打分函数随阶段换（这是它比 LocalGen 那批强的原因，也是它比那批「像人」的原因）：
 *
 *   开局 turn<21   探路：让我方兵力尽量铺向「离将军最远的点」，同时扣掉将军自己身上的兵
 *         turn=21+ 贪地：扩张，但保留将军周围的空地（liberties）
 *         ply=24/36 或者 28：将军本人出征一次
 *   中局 turn>25   三档轮换，节奏是它最像人的地方：
 *     attack  敌人在视野里、且到了「这一波该压上去」的窗口：
 *              被我方兵力压着的 targetdist 越小越好；顺带 maximize 并堆（std）、
 *              抢地、追杀敌方将军（distgens2）
 *     expand  窗口外、或者还没看见敌人：抢地 + 探没见过的格子
 *     gather  剩下的时间：把兵往 path（将军→前线那条路）上搬，city 上的兵权重要降
 *     「该压上去」的窗口 = turn%25 的后半段，且 turn>250 之后每 75 回合才放一次总攻
 *
 *   守家：每个回合先算 threat（敌兵 − 2×到我家将军的距离 − 我家将军的兵 − 1），
 *   只留有威胁的那些，再判断「威胁点附近的兵够不够挡」；挡不住就进 defend 分支，
 *   打分函数直接换成「把兵堆到 close 区、把敌人从 ochoke 挤出去」。
 *
 * 和原版的取舍（都写在代码里）：
 *   1. 原版拿得到双方 lands/armies 精确值，我们只有视野。敌方的地盘/兵力用「看得见的」
 *      估计（会偏低），只用在一个量级很粗的差值项上。
 *   2. 原版 bfs 用 numpy 向量化、每回合算十几张距离场；这里用 Int32Array + 手写 BFS。
 *      dist^1.1 这种指数项预计算成表。
 *   3. 原版铁律「从不 split」——它只走 a-1 的全量攻击，这里照抄（返回值永远 split:false）。
 *   4. 产兵照擂台规则对齐：将军/城市每回合 +1，每 25 回合全格 +1。
 *   5. 原版 `turn = state['turn']/2`（服务器 turn 是半回合）。这里 plan() 每回合调一次，
 *      自己数 ply，turn = ply>>1。
 */

'use strict';

const INF = 999999;
const EMPTY = -1;
const MOUNTAIN = -2;
const FOG = -3;
const OBSTACLE = -4;

function geom(w, h) {
  const n = w * h;
  const nb = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = (i / w) | 0;
    const a = [];
    if (y > 0) a.push(i - w);
    if (y < h - 1) a.push(i + w);
    if (x > 0) a.push(i - 1);
    if (x < w - 1) a.push(i + 1);
    nb[i] = a;
  }
  return nb;
}

/* ---------------- 局面 ---------------- */

function makeState(tg, ag, city, gen, egen, turn) {
  return { tg: tg, ag: ag, city: city, gen: gen, egen: egen, turn: turn };
}

function cloneState(S) {
  return { tg: S.tg.slice(), ag: S.ag.slice(), city: S.city, gen: S.gen, egen: S.egen, turn: S.turn };
}

/* helpers.apply_move：一条动作 + 这一回合的产兵。from < 0 表示不走子（只产兵）。 */
function doMove(base, pi, from, to) {
  const S = cloneState(base);
  const tg = S.tg;
  const ag = S.ag;
  if (from >= 0) {
    if (tg[from] !== pi || ag[from] < 2) return null;
    const t = tg[to];
    if (t === MOUNTAIN || t === OBSTACLE) return null;
    const send = ag[from] - 1;
    if (send < 1) return null;
    const neutralCity = S.city[to] === 1 && t === EMPTY;
    if (neutralCity || (t >= 0 && t !== pi)) {
      // 中立城 / 敌格：吃得下就翻面，吃不下只是互耗
      if (send > ag[to]) {
        ag[from] -= send;
        ag[to] = send - ag[to];
        tg[to] = pi;
      } else {
        ag[from] -= send;
        ag[to] -= send;
      }
    } else if (t === pi) {
      ag[from] -= send;
      ag[to] += send;
    } else if (t === EMPTY) {
      ag[from] -= send;
      ag[to] += send;
      tg[to] = pi;
    } else {
      return null;
    }
  }
  S.turn += 1;
  const all = S.turn % 25 === 0;
  for (let i = 0; i < ag.length; i++) {
    if (tg[i] !== pi) continue;
    if (i === S.gen || S.city[i]) ag[i] += 1;
    if (all) ag[i] += 1;
  }
  return S;
}

/* 模拟局面里的一眼统计：地盘 / 兵力 / 并堆程度（std） */
function stats(S, pi) {
  let myLand = 0;
  let myArmy = 0;
  let mySq = 0;
  let oppLand = 0;
  let oppArmy = 0;
  for (let i = 0; i < S.tg.length; i++) {
    const o = S.tg[i];
    if (o === pi) {
      const a = S.ag[i];
      myLand++;
      myArmy += a;
      mySq += a * a;
    } else if (o >= 0) {
      oppLand++;
      oppArmy += S.ag[i];
    }
  }
  let sd = 0;
  if (myLand > 1) {
    const mean = myArmy / myLand;
    const v = mySq / myLand - mean * mean;
    sd = v > 0 ? Math.sqrt(v) : 0;
  }
  return { myLand: myLand, myArmy: myArmy, oppLand: oppLand, oppArmy: oppArmy, sd: sd };
}

/* Σ(我方兵 × 权重) —— 对应 numpy 里的 (ag * p1 * X).sum() */
function dot(S, pi, w) {
  let s = 0;
  for (let i = 0; i < S.tg.length; i++) {
    if (S.tg[i] === pi) s += S.ag[i] * w[i];
  }
  return s;
}

/* ---------------- 距离场 ---------------- */

/* collections.deque 版 bfs 的等价物：
 *   - 只穿过非山非障碍格
 *   - 中立城：给距离，但不继续从它扩（原版的「城是墙」）
 *   - filt 限制可落地格 */
function bfs(S, sources, filt, nb) {
  const n = S.tg.length;
  const dist = new Int32Array(n).fill(INF);
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    if (seen[s]) continue;
    seen[s] = 1;
    dist[s] = 0;
    q[tail++] = s;
  }
  while (head < tail) {
    const cur = q[head++];
    const nbs = nb[cur];
    for (let k = 0; k < nbs.length; k++) {
      const j = nbs[k];
      if (seen[j]) continue;
      if (filt && !filt[j]) continue;
      seen[j] = 1;
      const t = S.tg[j];
      if (t === MOUNTAIN || t === OBSTACLE) continue;
      dist[j] = dist[cur] + 1;
      if (!(S.city[j] && t === EMPTY)) q[tail++] = j;
    }
  }
  return dist;
}

function allSources(maskPred, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (maskPred[i]) out.push(i);
  return out;
}

/* minwhere / maxwhere：返回「在 mask 里、且取到极值」的全部下标 */
function minWhere(arr, mask) {
  let best = INF;
  for (let i = 0; i < arr.length; i++) if (mask[i] && arr[i] < best) best = arr[i];
  const out = [];
  if (best >= INF) return out;
  for (let i = 0; i < arr.length; i++) if (mask[i] && arr[i] === best) out.push(i);
  return out;
}

function maxWhere(arr, mask) {
  let best = -INF;
  for (let i = 0; i < arr.length; i++) if (mask[i] && arr[i] > best) best = arr[i];
  const out = [];
  if (best <= -INF) return out;
  for (let i = 0; i < arr.length; i++) if (mask[i] && arr[i] === best) out.push(i);
  return out;
}

function adjMask(mask, nb) {
  const n = mask.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    const nbs = nb[i];
    for (let k = 0; k < nbs.length; k++) {
      if (mask[nbs[k]]) {
        out[i] = 1;
        break;
      }
    }
  }
  return out;
}

/* get_path：从 (i) 顺着 dist 一路下坡到 0，把路标成 1 */
function pathMask(start, dist, nb) {
  const n = dist.length;
  const path = new Uint8Array(n);
  if (dist[start] >= INF) return path;
  let cur = start;
  path[cur] = 1;
  let guard = n + 4;
  while (dist[cur] > 0 && guard-- > 0) {
    let next = -1;
    const nbs = nb[cur];
    for (let k = 0; k < nbs.length; k++) {
      if (dist[nbs[k]] === dist[cur] - 1) {
        next = nbs[k];
        break;
      }
    }
    if (next < 0) break;
    cur = next;
    path[cur] = 1;
  }
  return path;
}

module.exports = class Eklipz {
  constructor(rng) {
    this.rng = rng || Math.random;
    this.ply = 0;
    this.nb = null;
    this.pow11 = null;
    this.pow09 = null;
    this.maxD = 1;
    this.explored = null;
    this.gens2 = null;
    this.trace = !!process.env.GB_EK_TRACE;
    this.dumpPath = process.env.GB_EK_DUMP || null;
    this.dump = null;
    if (this.dumpPath) {
      this.dump = [];
      const self = this;
      process.once('exit', function () {
        const fs = require('fs');
        fs.writeFileSync(self.dumpPath, self.dump.join('\n') + '\n');
      });
    }
  }

  /*
   * 一回合的准备：从 view 造出「真实局面」，再把这一回合所有要用到的距离场算齐。
   * 原版每个 ply 都重算这些（numpy 很快），这里一样，只是 BFS 换成手写。
   */
  prep(view) {
    const w = view.w;
    const h = view.h;
    const n = w * h;
    if (!this.nb) {
      this.nb = geom(w, h);
      this.maxD = n;
      this.pow11 = new Float64Array(n + 1);
      this.pow09 = new Float64Array(n + 1);
      for (let d = 0; d <= n; d++) {
        this.pow11[d] = Math.pow(d, 1.1);
        this.pow09[d] = Math.pow(d, 0.9);
      }
      this.explored = new Uint8Array(n);
      this.gens2 = [];
    }
    const nb = this.nb;
    const pi = view.me;

    const tg = Int16Array.from(view.owner);
    const ag = Int32Array.from(view.armies);
    const city = view.cities;

    let gen = view.general;
    if (gen < 0) {
      for (let i = 0; i < n; i++) if (view.generals[i] && tg[i] === pi) gen = i;
    }

    let egen = -1;
    for (let i = 0; i < n; i++) if (view.generals[i] && tg[i] >= 0 && tg[i] !== pi) egen = i;

    const S = makeState(tg, ag, city, gen, egen, this.ply);
    return { S: S, pi: pi, n: n, nb: nb, w: w, h: h };
  }

  plan(view) {
    const P = this.prep(view);
    const S = P.S;
    const pi = P.pi;
    const n = P.n;
    const nb = P.nb;
    const tg = S.tg;
    const ag = S.ag;
    const gen = S.gen;
    const T = this;
    const turn = this.ply >> 1;
    this.ply += 1;

    const isMine = new Uint8Array(n);
    const isEnemy = new Uint8Array(n);
    const isEmpty = new Uint8Array(n);
    const isCityNotMine = new Uint8Array(n);
    const city = S.city;
    let cityMine = 0;
    for (let i = 0; i < n; i++) {
      const o = tg[i];
      if (o === pi) isMine[i] = 1;
      else if (o >= 0) isEnemy[i] = 1;
      else if (o === EMPTY) isEmpty[i] = 1;
      if (city[i] && o !== pi) isCityNotMine[i] = 1;
      else if (city[i]) cityMine++;
    }
    const empty = new Uint8Array(n);
    for (let i = 0; i < n; i++) empty[i] = isEmpty[i] && !isCityNotMine[i] ? 1 : 0;

    // 合法动作：自己、兵 >= 2、目标不是山/雾中障碍
    const moves = [];
    for (let i = 0; i < n; i++) {
      if (tg[i] !== pi || ag[i] < 2) continue;
      const nbs = nb[i];
      for (let k = 0; k < nbs.length; k++) {
        const j = nbs[k];
        if (tg[j] === MOUNTAIN || tg[j] === OBSTACLE) continue;
        moves.push([i, j]);
      }
    }
    moves.sort(function (a, b) {
      return ag[b[0]] - ag[a[0]];
    });
    if (moves.length > 200) moves.length = 200;

    if (gen < 0) return null;
    if (!moves.length) return null;

    /* ---- 每回合都要重算的距离场 ---- */

    for (let i = 0; i < n; i++) if (tg[i] !== FOG) this.explored[i] = 1;

    // 敌将记忆（见过的），被吃掉就从表里划掉
    for (let k = 0; k < this.gens2.length; k++) {
      const g = this.gens2[k];
      if (tg[g] === pi) this.gens2.splice(k--, 1);
    }
    if (S.egen >= 0 && this.gens2.indexOf(S.egen) < 0) this.gens2.push(S.egen);
    const gens2 = this.gens2;

    const distgen1 = bfs(S, [gen], null, nb);
    const farGen = maxWhere(distgen1, maskAll(n));
    const distfarGen = bfs(S, farGen.length ? [farGen[0]] : [gen], null, nb);

    const exploredSrc = [gen];
    for (let i = 0; i < n; i++) if (this.explored[i]) exploredSrc.push(i);
    const distExplored = bfs(S, exploredSrc, null, nb);
    const farExplored = maxWhere(distExplored, maskAll(n));
    const distfarExplored = bfs(S, farExplored.length ? [farExplored[0]] : [gen], null, nb);

    const mineSrc = allSources(isMine, n);
    const distp1 = bfs(S, mineSrc, null, nb);
    const farP1 = maxWhere(distp1, isMine);
    const distfarP1 = bfs(S, farP1.length ? [farP1[0]] : [gen], null, nb);
    const distp2 = bfs(S, allSources(isEnemy, n), null, nb);

    let distgens2 = null;
    if (gens2.length) distgens2 = bfs(S, gens2, null, nb);

    /* ---- 威胁 ---- */
    const genArmy = ag[gen];
    const threat = new Float64Array(n);
    let anyThreat = false;
    for (let i = 0; i < n; i++) {
      if (!isEnemy[i]) continue;
      const v = ag[i] - 2 * distgen1[i] - genArmy - 1;
      if (v <= 0) continue;
      if (distgens2) {
        if (!(distgen1[i] < distgens2[i])) continue;
      } else if (!(distgen1[i] <= 16)) continue;
      threat[i] = v;
      anyThreat = true;
    }

    let isthreat = false;
    let typh = -1;
    let threatPath = null;
    let distNearThreat = null;
    let close = null;
    let close2 = null;
    let ochoke = null;
    if (anyThreat) {
      const cand = minWhere(distgen1, uint8FromFloat(threat));
      typh = cand.length ? cand[0] : -1;
      if (typh >= 0) {
        threatPath = pathMask(typh, distgen1, nb);
        threatPath[typh] = 0;
        const th = distgen1[typh];
        const filt = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (distgen1[i] <= th) filt[i] = 1;
        distNearThreat = bfs(S, [typh], filt, nb);
        close = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const a = distgen1[i] < th - 1 || distgen1[i] === 0;
          const b = distgen1[i] <= th - 1 && distgen1[i] + th > distNearThreat[i];
          close[i] = a || b ? 1 : 0;
        }
        close2 = adjMask(close, nb);
        let covered = 0;
        for (let i = 0; i < n; i++) if (close2[i] && isMine[i]) covered += ag[i];
        if (threat[typh] <= covered) isthreat = true;
      }
    }

    // ochoke：出将口最窄的那圈（原版初始化时算一次，这里按当前 distgen1 重算）
    ochoke = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (tg[i] === MOUNTAIN || tg[i] === OBSTACLE) continue;
      let oc = 0;
      const nbs = nb[i];
      for (let k = 0; k < nbs.length; k++) {
        const j = nbs[k];
        if (tg[j] === MOUNTAIN || tg[j] === OBSTACLE) continue;
        if (distgen1[j] === distgen1[i] - 1) oc++;
      }
      if (oc <= 1) ochoke[i] = 1;
    }

    const pow11 = this.pow11;
    const pow09 = this.pow09;
    const MAXD = this.maxD;
    const explored = this.explored;

    /* ---- 通用：把候选动作全评一遍取最高分 ---- */
    const realStats = stats(S, pi);

    function defendOf(sm, darmy) {
      // python 里 defend 在 isthreat 分支才换公式，且它是「减分项」
      if (isthreat && typh >= 0) {
        const agS = sm.ag;
        let chokeCover = 0;
        for (let i = 0; i < n; i++) if (threatPath[i] && ochoke[i]) chokeCover += agS[i] + 1;
        let pathLen = 0;
        for (let i = 0; i < n; i++) if (threatPath[i]) pathLen++;
        if (agS[typh] > chokeCover || pathLen <= 2) {
          let m2 = 0;
          for (let i = 0; i < n; i++) if (ochoke[i] && threat[i] > 0 && sm.tg[i] >= 0 && sm.tg[i] !== pi) m2++;
          let num = 0;
          let den = 0;
          for (let i = 0; i < n; i++) {
            if (sm.tg[i] !== pi || !close2[i]) continue;
            num += agS[i] * (distNearThreat[i] >= INF ? MAXD : distNearThreat[i]);
            den += agS[i];
          }
          const avg = den > 0 ? num / den : 0;
          let inner = 0;
          for (let i = 0; i < n; i++) {
            if (!close[i]) continue;
            if (sm.tg[i] === pi) inner += agS[i];
            else if (sm.tg[i] >= 0) inner -= agS[i];
          }
          return -1000000 * m2 - avg + 1000 * inner;
        }
      }
      let near = 0;
      for (let i = 0; i < n; i++) if (sm.tg[i] >= 0 && sm.tg[i] !== pi && distgen1[i] <= 2) near++;
      return 1e8 - 10 * near;
    }

    function canwinOf(sm) {
      if (!distgens2) return 0;
      let mine = 0;
      let opp = 0;
      for (let i = 0; i < n; i++) {
        if (distgens2[i] === 1 && sm.tg[i] === pi) mine++;
        else if (distgens2[i] === 0 && sm.tg[i] >= 0 && sm.tg[i] !== pi) opp++;
      }
      return mine * pi > opp * (1 - pi) + 2 ? 1 : 0;
    }

    /* ---- 中局：targetdist / path / distpath ---- */
    let seenEnemy = false;
    for (let i = 0; i < n; i++) if (isEnemy[i]) { seenEnemy = true; break; }

    let path = new Uint8Array(n);
    path[gen] = 1;
    let targetdist = null;
    let distpath = null;
    let timeAttack = true;
    if (turn >= 25) {
      if (seenEnemy) {
        const fogMask = new Uint8Array(n);
        for (let i = 0; i < n; i++) fogMask[i] = tg[i] === FOG || tg[i] === OBSTACLE ? 1 : 0;
        const eedge = adjMask(fogMask, nb);
        const edgeMask = new Uint8Array(n);
        let anyEdge = false;
        for (let i = 0; i < n; i++) {
          if (isEnemy[i] && eedge[i]) { edgeMask[i] = 1; anyEdge = true; }
        }
        let targets = anyEdge ? minWhere(distgen1, edgeMask) : minWhere(distgen1, isEnemy);
        targetdist = bfs(S, targets.length ? [targets[0]] : [gen], null, nb);
        path = pathMask(gen, targetdist, nb);
      }
      distpath = bfs(S, allSources(path, n), null, nb);

      const turn3 = Math.floor(turn / 25) % 3;
      if (turn > 250 && turn3 === 0) timeAttack = false;
      else if (turn > 250 && turn3 === 2) timeAttack = true;
      else {
        let pathLen = 0;
        for (let i = 0; i < n; i++) if (path[i]) pathLen++;
        timeAttack = turn % 25 >= 25 - 2 - Math.floor((pathLen + 1) / 2);
      }
    }

    let best = null;
    let bestScore = -Infinity;
    let phase = 'none';

    const consider = function (from, to, fn) {
      const sm = from < 0 ? doMove(S, pi, -1, -1) : doMove(S, pi, from, to);
      if (!sm) return;
      const sc = fn(sm);
      if (sc > bestScore) {
        bestScore = sc;
        best = from < 0 ? null : [from, to];
      }
    };

    const aliveSum = function (sm) {
      return sm.egen >= 0 && sm.tg[sm.egen] !== pi ? 1 : 2;
    };

    /* ---- 开局 ---- */
    if (turn < 25) {
      let numChokes = Infinity;
      for (let d = 3; d <= 9; d++) {
        let c = 0;
        for (let i = 0; i < n; i++) if (distgen1[i] === d) c++;
        if (c < numChokes) numChokes = c;
      }
      const launch = numChokes > 1 ? [24, 36] : [28];

      const genMoves = [];
      for (let k = 0; k < moves.length; k++) if (moves[k][0] === gen) genMoves.push(moves[k]);

      if (launch.indexOf(this.ply - 1) >= 0) {
        phase = 'launch';
        // 将军出征：兵力留得住，别一头扎进空地
        const f = function (sm) {
          const st = stats(sm, pi);
          let num = 0;
          let den = 0;
          for (let i = 0; i < n; i++) {
            if (sm.tg[i] !== pi) continue;
            const d = distfarP1[i] >= INF ? MAXD : distfarP1[i];
            num += sm.ag[i] * d;
            den += sm.ag[i];
          }
          const explore = den > 0 ? num / den : 0;
          return st.myArmy - explore - 10 * st.myLand;
        };
        for (let k = 0; k < genMoves.length; k++) consider(genMoves[k][0], genMoves[k][1], f);
      } else if (turn >= 21) {
        phase = 'greedy';
        // 贪地：抢，但将军周围留空地（genliberties）
        const empties = allSources(empty, n);
        const nearEmpty = empties.length ? minWhere(distgen1, empty) : [];
        const distEmpty = nearEmpty.length ? bfs(S, nearEmpty, null, nb) : null;
        const f = function (sm) {
          const st = stats(sm, pi);
          const dland = 2 * st.myLand - (st.myLand + st.oppLand);
          let x = 0;
          if (distEmpty) {
            let num = 0;
            let den = 0;
            for (let i = 0; i < n; i++) {
              if (sm.tg[i] !== pi) continue;
              num += sm.ag[i] * (distEmpty[i] >= INF ? MAXD : distEmpty[i]);
              den += sm.ag[i];
            }
            x = den > 0 ? num / den : 0;
          }
          let libs = 0;
          for (let i = 0; i < n; i++) if (distgen1[i] <= 1 && empty[i] && sm.tg[i] !== pi) libs++;
          return st.myArmy + 10 * dland - x + 0.01 * libs;
        };
        for (let k = 0; k < moves.length; k++) consider(moves[k][0], moves[k][1], f);
      } else {
        // 探路：不派将军
        phase = 'explore-open';
        const f = function (sm) {
          const st = stats(sm, pi);
          let num = 0;
          let den = 0;
          for (let i = 0; i < n; i++) {
            if (sm.tg[i] !== pi) continue;
            const d = distfarGen[i] >= INF ? MAXD : distfarGen[i];
            num += sm.ag[i] * d;
            den += sm.ag[i];
          }
          const explore = den > 0 ? num / den : 0;
          let libs = 0;
          for (let i = 0; i < n; i++) if (distgen1[i] <= 1 && empty[i] && sm.tg[i] !== pi) libs++;
          let cityHit = 0;
          for (let i = 0; i < n; i++) if (isCityNotMine[i] && sm.tg[i] >= 0 && sm.tg[i] !== pi) cityHit++;
          return st.myArmy + 10 * st.myLand - explore - 10 * genArmy + 100 * -cityHit + 2 * libs;
        };
        for (let k = 0; k < moves.length; k++) {
          if (moves[k][0] === gen) continue;
          consider(moves[k][0], moves[k][1], f);
        }
      }
    } else if (seenEnemy && timeAttack) {
      /* ---- 进攻 ---- */
      phase = 'attack';
      const powT = new Float64Array(n);
      for (let i = 0; i < n; i++) powT[i] = pow11[targetdist[i] >= INF ? MAXD : targetdist[i]];
      const f = function (sm) {
        const st = stats(sm, pi);
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
          if (sm.tg[i] !== pi) continue;
          num += sm.ag[i] * powT[i];
          den += sm.ag[i];
        }
        const attack = den > 0 ? num / den : 0;
        const merge = st.sd;
        const darmy = st.myArmy - st.oppArmy;
        const capture = st.myLand - st.oppLand;
        let numP = 0;
        let denP = 0;
        for (let i = 0; i < n; i++) {
          if (sm.tg[i] !== pi) continue;
          numP += sm.ag[i] * path[i];
          denP += sm.ag[i];
        }
        const staypath = denP > 0 ? numP / denP : 0;
        let cityHit = 0;
        for (let i = 0; i < n; i++) if (isCityNotMine[i] && sm.tg[i] >= 0 && sm.tg[i] !== pi) cityHit++;
        const takecity = -cityHit;

        let a;
        let canwin;
        let mine;
        let opp;
        if (distgens2) {
          let numG = 0;
          for (let i = 0; i < n; i++) {
            if (sm.tg[i] !== pi) continue;
            numG += sm.ag[i] * pow11[distgens2[i] >= INF ? MAXD : distgens2[i]];
          }
          a = -2 * (den > 0 ? numG / den : 0);
          mine = 0;
          opp = 0;
          for (let i = 0; i < n; i++) {
            if (distgens2[i] === 1 && sm.tg[i] === pi) mine++;
            else if (distgens2[i] === 0 && sm.tg[i] >= 0 && sm.tg[i] !== pi) opp++;
          }
          canwin = mine * pi > opp * (1 - pi) + 2 ? 1 : 0;
        } else {
          let oldP2adj = 0;
          const adjP1 = adjMask(oneMask(sm, pi), nb);
          for (let i = 0; i < n; i++) {
            if (!explored[i] && adjP1[i] && isEnemy[i]) oldP2adj++;
          }
          let numF = 0;
          for (let i = 0; i < n; i++) {
            if (sm.tg[i] !== pi) continue;
            numF += sm.ag[i] * pow09[distfarExplored[i] >= INF ? MAXD : distfarExplored[i]];
          }
          a = 2 * oldP2adj - 0.03 * (den > 0 ? numF / den : 0);
          canwin = 0;
        }
        const defend = defendOf(sm, darmy);
        return (
          -1000000 * aliveSum(sm) +
          500000 * canwin +
          10 * darmy +
          2 * capture -
          attack +
          a +
          100 * takecity +
          0.01 * merge +
          0.02 * staypath +
          defend
        );
      };
      consider(-1, -1, f);
      for (let k = 0; k < moves.length; k++) consider(moves[k][0], moves[k][1], f);
    } else if (
      (seenEnemy && turn < 50 && turn % 25 < 6) ||
      (seenEnemy && turn < 100 && turn % 25 < 4) ||
      (seenEnemy && turn < 150 && turn % 25 < 2) ||
      (seenEnemy && turn % 25 < 1) ||
      !seenEnemy
    ) {
      /* ---- 扩地 / 探路（中局版） ---- */
      phase = 'expand';
      const f = function (sm) {
        const st = stats(sm, pi);
        const darmy = st.myArmy - st.oppArmy;
        const dland = st.myLand - st.oppLand;
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
          if (sm.tg[i] !== pi) continue;
          num += sm.ag[i] * pow11[distfarP1[i] >= INF ? MAXD : distfarP1[i]];
          den += sm.ag[i];
        }
        const explore = den > 0 ? num / den : 0;
        const canwin = canwinOf(sm);
        let cityHit = 0;
        for (let i = 0; i < n; i++) if (isCityNotMine[i] && sm.tg[i] >= 0 && sm.tg[i] !== pi) cityHit++;
        const takecity = -cityHit;
        const defend = defendOf(sm, darmy);
        return -1000000 * aliveSum(sm) + 500000 * canwin + 10 * darmy + dland + 100 * takecity - explore + defend;
      };
      consider(-1, -1, f);
      for (let k = 0; k < moves.length; k++) consider(moves[k][0], moves[k][1], f);
    } else {
      /* ---- 集兵：往 path 上搬，城里的兵权重降 5 倍 ---- */
      phase = 'gather';
      const c = new Float64Array(n);
      for (let i = 0; i < n; i++) c[i] = 1 + 4 * isCityNotMine[i];
      const powD = new Float64Array(n);
      for (let i = 0; i < n; i++) powD[i] = pow11[distpath[i] >= INF ? MAXD : distpath[i]];
      const f = function (sm) {
        const st = stats(sm, pi);
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
          if (sm.tg[i] !== pi) continue;
          const wgt = sm.ag[i] / c[i];
          num += wgt * powD[i];
          den += wgt;
        }
        const groupup = den > 0 ? num / den : 0;
        const canwin = canwinOf(sm);
        const defend = defendOf(sm, 0);
        return -1000000 * aliveSum(sm) + 500000 * canwin + 10 * st.myArmy + 0.01 * st.sd - groupup + defend;
      };
      consider(-1, -1, f);
      for (let k = 0; k < moves.length; k++) consider(moves[k][0], moves[k][1], f);
    }

    if (this.trace) {
      console.log(
        '[ek] ply=' + (this.ply - 1) + ' turn=' + turn + ' ' + phase +
        ' seen=' + seenEnemy + ' ta=' + timeAttack + ' isthreat=' + isthreat +
        ' moves=' + moves.length + ' best=' + (best ? best[0] + '>' + best[1] : 'null')
      );
    }
    if (this.dump) {
      const cities = [];
      for (let i = 0; i < n; i++) if (city[i]) cities.push(i);
      const gens = [];
      for (let i = 0; i < n; i++) if (view.generals[i]) gens.push(i);
      this.dump.push(
        JSON.stringify({
          ply: this.ply - 1,
          turn: turn,
          w: view.w,
          h: view.h,
          me: pi,
          tg: Array.prototype.slice.call(tg),
          ag: Array.prototype.slice.call(ag),
          city: cities,
          gens: gens,
          move: best
        })
      );
    }
    if (!best) return null;
    return { from: best[0], to: best[1], split: false };
  }
};

function maskAll(n) {
  const m = new Uint8Array(n);
  m.fill(1);
  return m;
}

function uint8FromFloat(arr) {
  const m = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) if (arr[i] > 0) m[i] = 1;
  return m;
}

function oneMask(S, pi) {
  const m = new Uint8Array(S.tg.length);
  for (let i = 0; i < S.tg.length; i++) if (S.tg[i] === pi) m[i] = 1;
  return m;
}
