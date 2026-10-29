/*
 * 决策引擎。
 *
 * 参考实现（同一套 generals.io 状态机，不同宿主）：
 *   strakam/generals-bots  agents/hunter_agent.py   守家 + 输兵 + 斩首
 *   strakam/generals-bots  agents/expander_agent.py 边境吃掉一切能吃的
 *   vzhou842/generals.io-Node.js-Bot-example        地图/增量协议
 *
 * 这里把它们缝成一个每回合多次出子的计划器：
 *
 *   A. 斩首     贴脸敌将且打得过 → 直接吃，结束对局
 *   B. 守将     将军被贴脸且打不过 → 反打 / 邻居代打 / 并兵
 *   C. 扩张     全图 Dijkstra：cost = 沿路累计（守军+1），按 价值/代价^0.85 选目标，
 *               沿 prev 链一次推进最多 4 步，重复到预算用完
 *   D. 输兵     一个目标都找不到时，朝目标（敌将 > 最近敌军 > 最远迷雾）推进最厚的堆
 *
 * 所有出子都在本地乐观状态上提交，保证一格一回合只动一次。
 */
(function () {
  'use strict';

  var GB = window.__GB;
  var T = GB.TILE;

  var CHAIN_MAX = 4; // 单回合沿一条路径最多推几步
  var GARRISON = 6; // 将军保底兵力（低于此值优先不动将军）
  var POKE_MARGIN = 4; // 进攻敌方地块时，出兵堆要比「打穿代价」多出这么多才动手
  // 将军要攒到这个数才往硬目标送兵。真实产兵规则下将军每回合 +1，是唯一的稳定
  // 兵源；攒着不动才有一拳打出去的兵力，每回合挤一个兵出去只会让兵永远散在路上。
  var GENERAL_SEND_MIN = 6;

  /*
   * 将军作为出兵候选时的权重：小于 1 表示排在同样厚的普通堆后面。
   *
   * 0.2 的意思是「将军是最后一支被调动的部队」——只有当别的兵堆都推不动时，
   * 主纵队的来源才轮到它。镜像 A/B（迷雾，240 局，已分胜负口径）：
   *
   *   genWeight 1.0   42.6%
   *   genWeight 0.6   50.0%   （旧默认）
   *   genWeight 0.3   58.5%
   *   genWeight 0.2   60.3%
   *   genWeight 0.15  60.5%
   *   genWeight 0.0   12.5%   （将军彻底不出兵 → 崩盘）
   *
   * 曲线的两头都说明问题：0 会崩，因为前期只有将军有兵、它是唯一的推力来源；
   * 但把它当普通兵源用（1.0）也会输，因为它一出门就是「把胜负手往前线挪」。
   */
  var GEN_WEIGHT = 0.2;

  /*
   * 将军的三个阶段（S.turn 是服务器 tick，显示回合 = tick/2）：
   *
   *   早期 [0, 50)       发育期。将军每回合 +1，是全图唯一的稳定兵源，家里的兵
   *                      还没攒起来；这时让它往外推兵、领着主纵队铺出去。
   *   中期 [50, 480)     将军停在前线后方当兵源，攒到 6 再送。
   *   后期 [480, ∞)      将军封存：地盘产能已经超过将军，让它出门等于把不可再生
   *                      的兵源挪到敌方视野边上。
   *
   * 阈值是实测出来的。封存阈值 240 tick 是 77.5%、320 是 85.0%、480 和完全不封存
   * 一样是 92.5%——擂台是 20x20 小图只有 5 座城，「每 25 tick 全格 +1」的地盘产能
   * 撑不起推进，将军的兵一封存就等于把主战力锁死。所以只在拖到 240 显示回合以后
   * 才封存。
   */
  var PHASE_EARLY = 50;
  var PHASE_LATE = 480;

  // 将军与敌方领土的最小保持步数。用的是「对手的视野」：官方前端的迷雾是渲染
  // 遮罩（map.computeVisibility → 按 pov 画 FOG），地图数据本身是全量的，所以我们
  // 知道每块敌方领土在哪；对手能看见的 = 他的领土 + 邻接一圈。离敌格 2 步还在对面
  // 视野外，1 步就已经被看见了。实测 2 比 3 好（95.0% vs 92.5%）：留两格等于把
  // 将军关在家里，兵流不出去。
  var GEN_SAFE = 2;
  // 早期将军一次能送出多少：只留 2 个看家，其余全推出去铺地。
  var GEN_KEEP_EARLY = 2;

  // 斩首要攒到对方将军兵力的这个倍数再动手。1 个兵的微弱优势打进去只是给
  // 对方送兵，还把自己唯一的主纵队变成对面的养料。
  var KILL_RATIO = 1.5;
  // 掠食（默认关闭）的上下限：目标敌格不超过这么多兵才吃，出兵堆不超过这个数才动。
  var HARVEST_TARGET_MAX = 6;
  var HARVEST_SRC_MAX = 12;

  function isPassable(terrain, i) {
    var t = terrain[i];
    return t !== T.MOUNTAIN && t !== T.FOG_OBSTACLE;
  }

  function buildNeighbors(w, h) {
    var n = w * h;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      var x = i % w;
      var y = (i / w) | 0;
      var buf = [];
      if (y > 0) buf.push(i - w);
      if (y < h - 1) buf.push(i + w);
      if (x > 0) buf.push(i - 1);
      if (x < w - 1) buf.push(i + 1);
      out[i] = buf;
    }
    return out;
  }

  function neighbors(S) {
    if (!S._nbr || S._nbr.length !== S.n) S._nbr = buildNeighbors(S.w, S.h);
    return S._nbr;
  }

  /* 最小堆：Dijkstra 用，元素是 [cost, index] */
  function MinHeap() {
    this.a = [];
  }
  MinHeap.prototype.push = function (cost, idx) {
    var a = this.a;
    a.push([cost, idx]);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      var tmp = a[p];
      a[p] = a[i];
      a[i] = tmp;
      i = p;
    }
  };
  MinHeap.prototype.pop = function () {
    var a = this.a;
    var top = a[0];
    var last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1;
        var r = l + 1;
        var m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        var tmp = a[m];
        a[m] = a[i];
        a[i] = tmp;
        i = m;
      }
    }
    return top;
  };
  Object.defineProperty(MinHeap.prototype, 'size', {
    get: function () {
      return this.a.length;
    }
  });

  function plan(S, cfg) {
    var out = [];
    if (!S.ready || S.playerIndex < 0 || S.ended) return out;

    // 新开一局时 turn 会回退，用它判定并清掉上一局的 focus 残留
    if (S._focusTurn === undefined || S.turn < S._focusTurn) {
      S._focus = -1;
      S._focusStuck = 0;
      S._focusDir = null;
      S._preferCity = false;
      S._genKnown = false;
    }
    S._focusTurn = S.turn;

    var n = S.n;
    var SW = S.w | 0;
    var SH = S.h | 0;
    var pid = S.playerIndex;
    var nbr = neighbors(S);
    var generals = S.generals;

    // 本地可写副本
    var owner = Int16Array.from(S.terrain);
    var armies = Int32Array.from(S.armies);

    var isCity = new Uint8Array(n);
    for (var c = 0; c < S.cities.length; c++) {
      var ci = S.cities[c];
      if (ci >= 0 && ci < n) isCity[ci] = 1;
    }

    var generalPlayer = new Map();
    for (var p = 0; p < generals.length; p++) {
      var gp = generals[p];
      if (gp >= 0 && gp < n) generalPlayer.set(gp, p);
    }
    var myGeneral = pid < generals.length && generals[pid] >= 0 ? generals[pid] : -1;

    var budget = Math.max(1, Math.min(20, ((cfg && cfg.maxMoves) | 0) || 1));
    var used = new Set();
    var moves = [];
    var reasons = [];

    // 策略开关：默认值就是线上行为，基准脚本可以逐项关掉做单变量对照。
    var C = cfg || {};
    var pEarly = C.phaseEarly === undefined ? PHASE_EARLY : C.phaseEarly | 0;
    var pLate = C.phaseLate === undefined ? PHASE_LATE : C.phaseLate | 0;
    var gSafe = C.genSafe === undefined ? GEN_SAFE : C.genSafe | 0;
    var killR = C.killRatio === undefined ? KILL_RATIO : Number(C.killRatio);
    // 将军后期封存：默认关闭。镜像 A/B 里「不封存」在迷雾 67.2% : 32.8%、
    // 全视野 54.4% : 45.6% 都赢——封存是打弱参考 bot 时得出的假结论，那时候
    // 对面根本惩罚不了将军不出门。留着开关给以后的高延迟场景用。
    var lateFreeze = C.lateFreeze === true;
    var doPurge = C.purge !== false;
    // 掠食实测是负收益（88.4% vs 89.1%），默认关闭，留着开关给以后的图用。
    var doHarvest = C.harvest === true;
    var genSendMin = C.genSendMin === undefined ? GENERAL_SEND_MIN : C.genSendMin | 0;
    var genWeight = C.genWeight === undefined ? GEN_WEIGHT : Number(C.genWeight);
    // 集兵：后方的一堆往前搬一格、跟前面的堆并上，而不是每格轮流送 1 个兵。
    // 关掉它就退回旧行为（任何 >=2 的堆都能往自家格子挪），专门用来做单变量对照。
    var doGather = C.gather !== false;
    /*
     * 将军坐家：将军只往自家格子送兵，不亲自出门占格子。
     *
     * 将军每回合 +1，是全图唯一稳定的兵源；它亲自往外出，等于把兵源一格一格挪到
     * 前线，身后留一条 1 兵的尾巴（回放 Fk12pNja_ 开局那条 (6,5)→(7,5)→(8,5)
     * 就是这么留下的，每格 1 兵，后面还得花回合把尾巴并回来）。
     * 坐家只留一件事：往外送兵。兵堆自己走。
     */
    var genAnchor = C.genAnchor === true;
    /*
     * 长成块，不拉成蛇。
     *
     * 将军是**固定格**（bundle 里 Map.attack 从不改 generals[]，兵走了那格只剩 1 兵），
     * 所以兵源永远在家里，前沿离家的距离就是兵的运输成本。沿一个方向一路推出去，
     * 地盘是条蛇：离家 10 格的前沿，每送一批兵就要 10 个回合在路上——回放 Fk12pNja_
     * 开局就是这么走的，(6,5) 一波一波往东送，每一波都得把整条蛇再走一遍。
     *
     * 块状扩张把「前沿到家」的距离压在 sqrt(地盘) 量级：优先吃那种「几面都贴着
     * 我们」的空格（正好塞进缺口），同分再挑离家近的。
     */
    var doBlob = C.blob !== false;
    /*
     * 扩地优先 + 城市闸门 + 禁止回头。
     *
     * 回放 WWyoWgLmt（我们 88 地 / 对面 149，兵 560 / 对面 1317，t=609 被吃掉）：
     *   - 591 手走子里 398 手（67%）是往自家格子推。兵在自己家里一格一格搬，
     *     地一格没多；
     *   - focus 一看见「打得动的城」就锁死在那儿，整盘兵一格一格喂进去；
     *   - 后院 303 个兵整局没挪窝，前线只有 257，对面前线 457。
     *
     * 地的唯一用处是产能：每格每 50 tick +1 兵，将军和城是每 2 tick +1。
     * 一回合只有一手时，吃格子的收益是立刻到账的，搬兵的收益要再走 N 手才兑现，
     * 所以吃的优先级必须高于搬；城要「攒够余量 + 没格子可吃」才买。
     *
     * 禁止回头：上一步 a→b，这一步又 b→a，两回合净收益 0，兵还各留 1 个在原地。
     * focus 每回合重挑时这种情况会成串出现（regret 里 (10,0)→(10,1) 连下 30 多手）。
     *
     * 「扩地优先」实测是负收益，默认关闭（expand=true 可开）：
     *   40 种子 × 80 局/对手，迷雾：
     *     对手       关（当前）  开
     *     gc          63.7%     41.3%
     *     zlyv21      56.3%     17.5%
     *     szly        45.0%     11.3%
     *     kutu        31.3%      3.8%
     * 原因是「吃格子」和「攒一拳头」抢同一条命令，而每方每回合只有 1 步。
     * supply() 的前锋推（dist==1）本来就是在扩地——只是它用**同一条主纵队**
     * 扩，兵是聚着的；expandStep 是「哪堆厚就从哪堆抽 1 个出去」，全图铺开，
     * 主纵队永远攒不起来，一开打就被对面一拳打穿。
     */
    var doExpand = C.expand === true;
    /*
     * 前锋吃不动时「就近吃空格」默认关闭。
     *
     * 镜像 A/B 里它是赢的（60 种子 120 局，已分胜负里 63.6%，地盘 116 : 60），
     * 但打参考 bot 是输的：40 种子 × 2 对手，gc 58.8% / zlyv21 38.8%（基线
     * 63.7% / 56.3%）。同样的净效应——地多了（142 : 83）兵也多了（1251 : 698），
     * 胜率却掉。参考 bot 是会集中兵力来砸的，全图摊开吃格子的打法守不住。
     * 现在改由 focusNear（目标太远就吃手边的）来解决同一个问题，主纵队不掉头。
     */
    var expandStuck = C.expandStuck === true;
    /*
     * rail 排序默认还是「从厚到薄」，不是「从前沿往后倒灌」。
     *
     * 倒灌版本（railFront=true）镜像 A/B 输得很难看，40 种子 80 局：
     *   候选（从前沿倒灌）vs 基线（从厚到薄）  胜 3 / 负 64 / 和 13，
     *   已分胜负里只有 4.5%，地盘 66.6 vs 183.3。
     * 原因：dist 最小的那格通常就是刚推出去、被抽干的前锋（1~2 兵），先搬它
     * 等于每回合往同一格灌 1 个兵，后面那堆厚的永远不动，纵队彻底断供。
     */
    var railFront = C.railFront === true;
    /*
     * 别往后倒兵：默认关闭。
     *
     * 1.1.7 默认开过一版，用户拿回放 _ZP2mPnew 说「这个版本发癫了」——量出来的
     * 就是这个开关：同一局里空过 13 手 → 47 手，占地 85 手 → 42 手，t=80..121
     * 整整四十多手一步没下（地停在 23 格），因为闸门把主纵队的会合全挡了。
     * 判定条件是「能看见敌格 + 这一步离敌更远 + 目标格 < 4 兵」，而打起来之后
     * 大部分会合都满足前两条——「离敌更远」在包围、绕山、往另一条战线调兵时
     * 都是正常操作，不是白搬。
     */
    var noBackstep = C.noBackstep === true;
    var cityGate = C.cityGate !== false;
    var cityMaxDist = C.cityMaxDist === undefined ? 12 : C.cityMaxDist | 0;
    // 近在眼前的城优先买（8 步内），远城不追——隧道比城本身还贵
    var cityNear = C.cityNear === undefined ? 8 : C.cityNear | 0;
    // focus 离我们超过这么多步，就改吃手边的空格（见 pickFocus 末尾的注释）
    var focusNear = C.focusNear === undefined ? 8 : C.focusNear | 0;
    /*
     * 回头路守卫默认关闭。
     *
     * 目标只有「上一步的逆向不走」一条：a→b 之后不许 b→a。它确实挡住了
     * 「两回合净收益 0、两边各留 1 兵」的摆动，但实测挡的常常是正经的回头补位
     * （把兵调回来打穿后方的入侵者、将军后撤），代价比收益大：
     * 40 种子 gc/zlyv21 各 80 局，antiReverse 单独开是 52.5% / 62.5%（基线
     * 63.7% / 56.3%），合计 57.5% : 60.0%。而同一局的 regret 里，自家格走子
     * 占比几乎没动（29.4% → 29.3%）。留着开关，别默认开。
     */
    var antiReverse = C.antiReverse === true;

    // 本回合各类出子的计数，擂台会把它们累加，用来看「自家来回搬」占多少。
    var STATS = { attack: 0, rail: 0, merge: 0, spread: 0 };
    GB.lastStats = STATS;
    var DBG = (GB.dbg = {});

    // 阶段：0 早期 / 1 中期 / 2 后期（将军封存）
    var tick = S.turn | 0;
    var phase = tick < pEarly ? 0 : tick < pLate ? 1 : 2;
    if (phase === 2 && !lateFreeze) phase = 1;

    var doMem = C.mem !== false;
    var memTtl = C.memTtl === undefined ? 40 : C.memTtl | 0;

    /*
     * 迷雾记忆。
     *
     * 服务器每回合都按当前视野重新序列化地图（Map.serialized），看不见的格子直接
     * 变成 TILE_FOG、兵数抹成 0——客户端自己是一点记忆都没有的。人打游戏不是这样：
     * 你三回合前看见对面 30 个兵往东压，这回合它进了黑区，你仍然知道它往东去了。
     *
     * 这里把那点记忆补回来：每回合把当前看得见的格子记下来（归属 / 兵数 / 时间），
     * 后面用「最近 memTtl 个 tick 内见过的敌格」补进威胁场和目标选择。
     */
    var M = S._mem;
    if (!doMem) {
      M = null;
    } else {
      if (!M || M.n !== n) {
        M = S._mem = {
          n: n,
          owner: new Int16Array(n),
          armies: new Int32Array(n),
          turn: new Int32Array(n).fill(-1000000)
        };
      }
      for (var m = 0; m < n; m++) {
        var mt = S.terrain[m];
        if (mt === T.FOG || mt === T.FOG_OBSTACLE) continue;
        M.owner[m] = mt;
        M.armies[m] = S.armies[m];
        M.turn[m] = tick;
      }
    }

    /*
     * 每格到最近敌方领土的步数（穿过任何可通行格）。将军靠它判断「这一步会不会
     * 进对面视野」。注意这里只有**看得见**的敌格：迷雾是服务器在数据层过滤的，
     * 看不见的敌格根本不下发（generals 里是 -1，map 里是 TILE_FOG）。记忆能补
     * 一点（见上），但补不到「已经进了黑区的部队现在在哪」。
     */
    function enemyDistField() {
      var d = new Int32Array(n).fill(-1);
      var q = [];
      var i;
      for (i = 0; i < n; i++) {
        var eo = owner[i];
        // 看不见的格子用记忆补：最近 memTtl 个 tick 内见过它是敌格，就还算威胁源。
        // 不补的话，敌人在雾里走三步，我们的威胁场就当他消失了。
        if (eo === T.FOG || eo === T.FOG_OBSTACLE) {
          eo = M && tick - M.turn[i] <= memTtl ? M.owner[i] : -1;
        }
        if (eo >= 0 && eo !== pid) {
          d[i] = 0;
          q.push(i);
        }
      }
      for (var h = 0; h < q.length; h++) {
        var cur = q[h];
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (d[j] !== -1 || !isPassable(owner, j)) continue;
          d[j] = d[cur] + 1;
          q.push(j);
        }
      }
      return d;
    }
    var denemy = enemyDistField();

    /*
     * 守备需求（garrison need）。
     *
     * 「将军留几个兵」不该是个常数。harrischristiansen/generals-bot 的算法是：
     *
     *     needed = min(威胁 + 2, 0.5 × 总兵力)
     *
     * 威胁 = 将军 8 步以内最厚的敌方部队（敌将和城里的守备不算——那是坐家产的
     * 兵，不是冲过来的兵）。没被发现、没人来的时候 needed = 0，将军随便动；
     * 一旦有人在 8 步内压过来，留底就跟着涨。封顶 0.5 是防止全副家当缩在将军
     * 脚下——那样前线就断了。
     *
     * 出门门槛取 max(8, 2 × needed)：8 来自 strakam/hunter（GARRISON=4，送到
     * 2×GARRISON 才开始送，而且只送一半）。
     */
    var totalArmy = 0;
    var ti;
    for (ti = 0; ti < n; ti++) if (owner[ti] === pid) totalArmy += armies[ti];

    function garrisonNeed() {
      if (myGeneral < 0 || owner[myGeneral] !== pid) return 0;
      var dg = new Int16Array(n).fill(-1);
      var qq = [myGeneral];
      dg[myGeneral] = 0;
      var threat = 0;
      for (var h = 0; h < qq.length; h++) {
        var cur = qq[h];
        if (dg[cur] >= 8) continue;
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dg[j] !== -1) continue;
          if (!isPassable(owner, j)) continue;
          dg[j] = dg[cur] + 1;
          qq.push(j);
          if (owner[j] >= 0 && owner[j] !== pid) {
            // 敌将本身、城里的守军都是坐家产的兵，不进来袭威胁
            if (j === generals[owner[j]] || isCity[j]) continue;
            if (armies[j] > threat) threat = armies[j];
          } else {
            var nbq = nbr[j];
            for (var k2 = 0; k2 < nbq.length; k2++) {
              var e2 = nbq[k2];
              if (owner[e2] < 0 || owner[e2] === pid) continue;
              if (e2 === generals[owner[e2]] || isCity[e2]) continue;
              if (armies[e2] > threat) threat = armies[e2];
            }
          }
        }
      }
      if (threat <= 0) return 0;
      var need = threat + 2;
      var cap = totalArmy * 0.5;
      return need > cap ? cap : need;
    }
    /*
     * 守备需求公式默认关闭。
     *
     * 这个公式本身是对的（harrischristiansen 的 min(威胁+2, 0.5×总兵)），搬进来
     * 之后确实按设计工作了：只要 8 步内有来敌，将军的出门门槛就抬高。问题是它
     * 抬高的是「将军不出门」——而在这条规则下（半回合 1 步、将军 +1/回合是开局
     * 唯一的稳定兵源）将军不出门等于主推力消失。
     *
     * 实测（全视野 320 局）：开着 84.5%、关着 89.0%；对 hunter 78.8% : 88.8%。
     * 所以保留代码、默认关闭，作为以后换地图/换节奏时的开关。
     */
    var useGarrison = C.garrison === true;
    // 将军出门是否只送一半。默认关：迷雾镜像 A/B 120 局里，留一半 33.0%、只留 1 67.0%。
    // 协议只给了这两种送法（is50），没有「留 N 个」的写法，所以只能二选一。
    var genHalf = C.genHalf === true;
    var need0 = useGarrison ? garrisonNeed() : 0;

    // 将军是否已经被对方看见（粘性）。任一敌格贴着将军，就等于他已经看见了。
    // 一旦暴露，harrischristiansen 会把所有从将军出来的移动降级成「只送一半」。
    if (myGeneral >= 0 && owner[myGeneral] === pid && !S._genKnown) {
      var gadj2 = nbr[myGeneral];
      for (var gi2 = 0; gi2 < gadj2.length; gi2++) {
        var gj2 = gadj2[gi2];
        if (owner[gj2] >= 0 && owner[gj2] !== pid) {
          S._genKnown = true;
          break;
        }
      }
    }

    /*
     * 将军出门门槛 = max(8, 2 × 守备需求)，被对面看见了再 ×1.5。
     *
     * 原来的常数 6 是手调的，没有任何出处。换成两条能查到的：
     *   - 8 = 2 × GARRISON(4)，strakam/hunter_agent 的出门阈值
     *   - 2 × 守备需求：将军送出一半之后，留下的 ceil(a/2) 要盖得住 8 步内的来敌
     *     （harrischristiansen 的 garrison_needed）
     * 被看见之后门槛再抬，因为对面能数着你的兵算什么时候来。
     */
    var genSend = genSendMin;
    if (2 * need0 > genSend) genSend = 2 * need0;
    if (useGarrison && S._genKnown) genSend = Math.ceil(genSend * 1.5);
    /*
     * 早期将军的出门门槛单独一档，默认 3。
     *
     * 开局前 50 tick 里除了将军没有任何兵源，凑到 6 兵要 10 个 tick——这 10 手
     * 全是空过（回放 N7Npym_VP 的真实对局：t=0..9 一手没下，t=15..19 又空五手，
     * 全盘 26 手空过里有 20 手在开局）。空过的机会成本是永远的：那 10 个 tick
     * 本来能铺 10 格地，每格每 50 tick +1 兵。
     *
     * 门槛压到 3 也是「一次送 2 个兵」，不是一滴一滴挤：1 兵格不能动，兵会永远
     * 卡在路上（GEN_WEIGHT 上面的注释记的是同一条）。
     */
    var genSendEarly = C.genSendEarly === undefined ? 3 : C.genSendEarly | 0;
    if (phase === 0 && genSendEarly < genSend) genSend = Math.max(2, genSendEarly);

    function safeForGeneral(idx) {
      if (denemy[idx] < 0) return true; // 视野里根本没有敌格
      return denemy[idx] >= gSafe;
    }

    function move(from, to, why) {
      if (moves.length >= budget) return false;
      if (used.has(from)) return false;
      if (owner[from] !== pid) return false;
      if (!isPassable(owner, to)) return false;
      var a = armies[from];
      if (a < 2) return false;
      var own = owner[to] === pid;
      // 回头路：上一步 a→b，这一步 b→a。两个回合净收益 0，还各在起点留 1 兵。
      if (antiReverse && S._prevKeys && S._prevKeys.indexOf(from + '>' + to) >= 0) return false;
      /*
       * 往自家格子并兵，只挪 1 个兵是纯浪费。
       *
       * 1 兵格里剩下的那个兵自己动不了，等于兵永远卡在半路；回放 Fk12pNja_ 里
       * 开局那段 (6,5)→(7,5)→(8,5)→(9,5) 每格留 1 兵，就是引擎每回合把「最重
       * 的那堆」沿旧路往前挪一格挪出来的——那 6 手的源格全是 1 兵，服务器全部丢掉，
       * 六个回合一个格子都没多。
       *
       * 内部搬运必须挪得动一堆：源格至少 3 个兵（送出去至少 2 个）。
       */
      if (own && a < 3 && doGather) return false;
      var genOut = from === myGeneral && to !== myGeneral;
      // 将军坐家：只往自家格子送兵，不亲自出去占地
      if (genOut && genAnchor && !own) return false;
      // 将军隔壁已经有敌人时，只允许直接打它。把将军的兵送去别的方向等于自杀：
      // 将军被吃得手整局就结束，前面攒多少都没用。
      if (genOut && !(owner[to] >= 0 && owner[to] !== pid)) {
        var gadj = nbr[myGeneral];
        for (var gi = 0; gi < gadj.length; gi++) {
          var gj = gadj[gi];
          if (owner[gj] >= 0 && owner[gj] !== pid) return false;
        }
      }
      // 将军不进敌方视野：走动必须留在安全圈外。打贴脸的敌人不受这条限制
      // （上面的分支已经放行了「目标是敌格」的情况）。
      if (genOut && !(owner[to] >= 0 && owner[to] !== pid) && !safeForGeneral(to)) return false;
      // 将军出兵要留底：一次送光，下一回合被贴脸就没得守了。
      // 早期例外——这时候只有将军有余粮，留着不推等于整局不动。
      var sent = a - 1;

      /*
       * 「将军出门只送一半」必须同时告诉服务器。
       *
       * 协议里只有两种送法（bundle 里 bufferAttack 就这两个分支）：
       *   is50 = 1 → 送 army >> 1，留一半
       *   is50 = 0 → 送 army - 1，只留 1
       * 没有第三种。以前这里本地按一半算账、emit 时写死 false，于是本地以为将军留了
       * 一半、服务器把它送到只剩 1，下一步本地就按「这格还有兵」继续下令——回放里
       * t=22..26、t=33、t=44、t=46 那一串「源 1 兵送 0」全是这么来的空过。
       *
       * 现在 flag 和账必须一致：half 为真时才按一半算。
       * 默认 genHalf 关（只留 1）：迷雾镜像 A/B 120 局，留一半 33.0%、留 1 67.0%——
       * 留一半等于把将军的吞吐砍一半，而将军是开局唯一的稳定兵源。
       * 打敌格（斩首/反打）一律整队出击，抠一半是送死。
       */
      var half = false;
      var atk = owner[to] >= 0 && owner[to] !== pid;
      if (genOut && !atk && genHalf) {
        var h2 = a >> 1;
        if (h2 >= 1) {
          half = true;
          sent = h2;
        }
      }
      if (sent < 1) return false;
      // 往自己的格子并兵永远合法（只损耗 1），往敌人格必须打得过
      if (!own && sent <= armies[to]) return false;
      var wasNeutral = owner[to] < 0;
      armies[to] = own ? sent + armies[to] : sent - armies[to];
      armies[from] = a - sent;
      owner[to] = pid;
      used.add(from);
      moves.push([from, to, half ? 1 : 0]);
      if (own) {
        STATS.rail++;
        if (armies[to] - sent >= 2) STATS.merge++;
      } else if (wasNeutral) {
        STATS.spread++;
      } else {
        STATS.attack++;
      }
      if (why) reasons.push(why + ':' + from + '>' + to);
      return true;
    }

    // A. 斩首
    for (var q = 0; q < generals.length; q++) {
      if (q === pid) continue;
      var eg = generals[q];
      if (!(eg >= 0 && eg < n) || owner[eg] !== q) continue;
      var bestSrc = -1;
      var adj = nbr[eg];
      var need = Math.ceil(armies[eg] * killR);
      for (var k = 0; k < adj.length; k++) {
        var s = adj[k];
        if (owner[s] !== pid || used.has(s)) continue;
        if (armies[s] - 1 < need) continue;
        if (bestSrc < 0 || armies[s] > armies[bestSrc]) bestSrc = s;
      }
      if (bestSrc >= 0) move(bestSrc, eg, 'kill');
      break;
    }

    // B. 守将
    if (myGeneral >= 0 && owner[myGeneral] === pid) {
      var threat = -1;
      var threatArmy = -1;
      var ga = nbr[myGeneral];
      for (var t = 0; t < ga.length; t++) {
        var j = ga[t];
        if (owner[j] >= 0 && owner[j] !== pid && armies[j] > threatArmy) {
          threat = j;
          threatArmy = armies[j];
        }
      }
      if (threat >= 0 && armies[myGeneral] <= threatArmy) {
        if (!move(myGeneral, threat, 'defend')) {
          var killer = -1;
          var u;
          for (u = 0; u < ga.length; u++) {
            var s2 = ga[u];
            if (owner[s2] !== pid || s2 === myGeneral || used.has(s2)) continue;
            if (armies[s2] - 1 <= armies[threat]) continue;
            if (killer < 0 || armies[s2] > armies[killer]) killer = s2;
          }
          if (killer >= 0) {
            move(killer, threat, 'defend');
          } else {
            var res = -1;
            for (u = 0; u < ga.length; u++) {
              var s3 = ga[u];
              if (owner[s3] !== pid || s3 === myGeneral || used.has(s3)) continue;
              if (armies[s3] - 1 <= armies[myGeneral]) continue;
              if (res < 0 || armies[s3] > armies[res]) res = s3;
            }
            if (res >= 0) move(res, myGeneral, 'defend');
          }
        }
      }
    }

    /*
     * B3. 清剿内部入侵者。
     *
     * 敌人钻进我方腹地时要靠「地里的兵」并掉它，而不是抽将军、也不是把主纵队
     * 掉头——每半回合只有一条命令，掉头一次就是推进停两个回合。
     * 判「进了院子」看邻接：四邻里至少两个是我的格，这一格已经是我方腹地里的
     * 飞地，它每待一回合就啃掉一块产兵地。
     * 挑「刚好够用」的那一堆而不是最厚的：厚堆是主纵队，抽它就断了一条补给线。
     */
    function purgeIntruders() {
      var bestFrom = -1;
      var bestTo = -1;
      var bestLeft = 1 << 30;
      for (var i = 0; i < n; i++) {
        if (owner[i] < 0 || owner[i] === pid) continue;
        if (armies[i] < 1) continue;
        var nb2 = nbr[i];
        var ownCnt = 0;
        var hit = -1;
        var hitA = 1 << 30;
        for (var k = 0; k < nb2.length; k++) {
          var j = nb2[k];
          if (owner[j] !== pid) continue;
          ownCnt++;
          // 将军的兵不动：它是产兵点，不是打手。
          if (j === myGeneral || used.has(j)) continue;
          if (armies[j] - 1 <= armies[i]) continue;
          if (armies[j] < hitA) {
            hitA = armies[j];
            hit = j;
          }
        }
        if (ownCnt < 2) continue;
        if (hit < 0) continue; // 手里这点兵吃不下，交给推进阶段去啃
        var left = hitA - 1 - armies[i];
        if (left < bestLeft) {
          bestLeft = left;
          bestFrom = hit;
          bestTo = i;
        }
      }
      if (bestFrom < 0) return false;
      return move(bestFrom, bestTo, 'purge');
    }
    if (doPurge) purgeIntruders();

    /*
     * B4. 掠食（默认关闭）：边境上比我们薄得多的敌格，一口吃掉。
     * 照 expander「边境吃掉一切能吃的」写，但实测是负收益（88.4% vs 89.1%）：
     * 每吃掉一块薄地就占掉一条命令，主纵队就少推一格，和它换来的地不值。
     */
    function harvest() {
      var bestFrom = -1;
      var bestTo = -1;
      var bestGain = 1;
      for (var i = 0; i < n; i++) {
        if (owner[i] < 0 || owner[i] === pid) continue;
        if (armies[i] > HARVEST_TARGET_MAX) continue;
        var nb2 = nbr[i];
        var hit = -1;
        var hitA = 1 << 30;
        for (var k = 0; k < nb2.length; k++) {
          var j = nb2[k];
          if (owner[j] !== pid || used.has(j) || j === myGeneral) continue;
          if (armies[j] - 1 <= armies[i]) continue;
          if (armies[j] > HARVEST_SRC_MAX) continue;
          if (armies[j] < hitA) {
            hitA = armies[j];
            hit = j;
          }
        }
        if (hit < 0) continue;
        var gain = armies[i] + 1;
        if (gain > bestGain) {
          bestGain = gain;
          bestFrom = hit;
          bestTo = i;
        }
      }
      if (bestFrom < 0) return false;
      return move(bestFrom, bestTo, 'harvest');
    }
    if (doHarvest) harvest();

    // B2. 预警：视野内最厚的敌军在 8 步内且比将军厚，先把附近的兵并进将军
    var alarmed = defendWarn();

    // C. 单栈推进（照 hunter 的打法）：只养一个 focus，每回合把「最重的那一堆」
    //    朝它推一格。1 步/回合下的吞吐就是被搬那一格的兵减一，所以搬最重的才有效；
    //    同时最多维持两条战线，为地盘四处开花等于把兵摊成每格 1 的薄片。
    var focus = -1;
    if (!alarmed) {
      // C1. 扩地：一回合只有一手，先吃贴着我们地盘的格子（见 doExpand 的注释）
      var spilled = doExpand ? expandStep() : false;
      if (!spilled) {
        focus = pickFocus();
        if (focus >= 0) {
          if (!supply(focus)) {
            S._focusStuck = (S._focusStuck | 0) + 1;
            // 卡十几回合说明正面啃不动，换目标，别死磕一个啃不动的格
            if (S._focusStuck > 12) {
              S._focus = -1;
              S._focusStuck = 0;
              S._preferCity = true;
            }
          } else {
            S._focusStuck = 0;
          }
        }
      }
    }

    // C2. 将军后撤：已经被压在敌方视野圈里（敌人推到脸上 / 开局贴脸）时朝远离
    //     敌人的方向走一步。这不违反「不进视野」——是往外走。没有这一步，将军
    //     在圈里就一步都不能动，整回合空转。
    function retreatGeneral() {
      if (moves.length || myGeneral < 0 || owner[myGeneral] !== pid) return false;
      // 注意是 <=：正好卡在安全线上（denemy == gSafe）时，朝目标走一步就进圈了，
      // 引擎在这一格既不能进也不能留，整回合空转。这时候往外挪一格是唯一动作。
      if (denemy[myGeneral] < 0 || denemy[myGeneral] > gSafe) return false;
      var best = -1;
      var bestD = denemy[myGeneral];
      var nb2 = nbr[myGeneral];
      for (var k = 0; k < nb2.length; k++) {
        var j = nb2[k];
        if (!isPassable(owner, j)) continue;
        if (owner[j] >= 0 && owner[j] !== pid) continue; // 只往空格 / 自己的地撤
        if (denemy[j] > bestD) {
          bestD = denemy[j];
          best = j;
        }
      }
      if (best < 0) return false;
      return move(myGeneral, best, 'retreat');
    }
    if (moves.length === 0 && !alarmed) retreatGeneral();

    // D. 兜底：完全推不动时朝最近的敌人/最远处挪一步，别整回合空转
    if (moves.length === 0 && !alarmed) conveyor();

    function computeReach(n, nbr, owner, armies, pid) {
      var cost = new Float64Array(n);
      var src = new Int32Array(n);
      var prev = new Int32Array(n);
      var heap = new MinHeap();
      var i;
      for (i = 0; i < n; i++) {
        cost[i] = Infinity;
        src[i] = -1;
        prev[i] = -1;
        if (owner[i] === pid) {
          cost[i] = 0;
          src[i] = i;
          heap.push(0, i);
        }
      }
      while (heap.size) {
        var top = heap.pop();
        var d = top[0];
        var cur = top[1];
        if (d > cost[cur]) continue;
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (!isPassable(owner, j)) continue;
          var nd = owner[j] === pid ? d : d + armies[j] + 1;
          // 代价相同就让兵最多的那格出兵，别让将军去跑腿
          var betterSrc =
            owner[j] !== pid && src[cur] >= 0 && (src[j] < 0 || armies[src[cur]] > armies[src[j]]);
          if (nd < cost[j] || (nd === cost[j] && betterSrc)) {
            cost[j] = nd;
            src[j] = src[cur];
            prev[j] = cur;
            heap.push(nd, j);
          }
        }
      }
      return { cost: cost, src: src, prev: prev };
    }

    function pickTarget(n, nbr, owner, armies, reach, pid, myGeneral, isCity, generalPlayer) {
      var best = -1;
      var bestScore = 0;
      for (var i = 0; i < n; i++) {
        if (owner[i] === pid) continue;
        var c = reach.cost[i];
        if (!(c < Infinity)) continue;
        var s = reach.src[i];
        if (s < 0) continue;
        if (armies[s] < c) continue; // 兵力不够，别白送
        // 打敌方地块要先攒够余量：拿 2 个兵去戳一下只是给对方送兵
        if (owner[i] >= 0 && armies[s] < c + POKE_MARGIN) continue;

        var value;
        if (isCity[i]) value = 6;
        else if (owner[i] >= 0) value = 3;
        else value = 1;
        var ownerOf = generalPlayer.get(i);
        if (ownerOf !== undefined && ownerOf !== pid) value = 60; // 敌将

        var risk = 1;
        var left = armies[s] - c; // 推到这里之后手里还剩多少
        var nb = nbr[i];
        for (var k = 0; k < nb.length; k++) {
          var j = nb[k];
          if (owner[j] >= 0 && owner[j] !== pid && armies[j] > left) {
            risk = 0.55; // 落点旁边有比我们厚的敌人
            break;
          }
        }
        if (s === myGeneral && armies[s] < GARRISON * 3) risk *= 0.5;

        var score = (value / Math.pow(1 + c, 0.85)) * risk;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      return best < 0 ? null : { to: best };
    }

    function advance(target, reach) {
      var to = target.to;
      var s = reach.src[to];
      if (s < 0) return false;
      var path = [];
      var cur = to;
      var guard = 0;
      while (cur !== -1 && cur !== s && guard++ < 200) {
        path.push(cur);
        cur = reach.prev[cur];
      }
      if (!path.length) return false;
      path.reverse();

      var from = s;
      var moved = false;
      for (var k = 0; k < path.length && k < CHAIN_MAX && moves.length < budget; k++) {
        if (!move(from, path[k], moved ? 'chain' : 'grow')) break;
        from = path[k];
        moved = true;
      }
      return moved;
    }

    /*
     * 单栈 focus：跨回合保持同一个目标，只有拿下 / 卡死才换。
     * 优先级照 hunter：敌方将军 > 最近的敌方地块 > 最近的未占城市 > 最远的可探索格。
     * 目标粘性是关键——每回合换目标等于每回合重新铺一条路，兵永远在路上。
     */
    // 最近的未占城市（按从我方领土出发的 BFS 步数）
    function nearestCityGoal() {
      var dist = new Int32Array(n).fill(-1);
      var queue = [];
      var i;
      for (i = 0; i < n; i++) {
        if (owner[i] === pid) {
          dist[i] = 0;
          queue.push(i);
        }
      }
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }
      var best = -1;
      var bd = Infinity;
      // 和主路径同一个闸门：打完必须留本钱，太远的不去
      var maxOur = 0;
      for (i = 0; i < n; i++) {
        if (owner[i] === pid && armies[i] > maxOur) maxOur = armies[i];
      }
      for (i = 0; i < n; i++) {
        if (!isCity[i] || owner[i] === pid || dist[i] < 0) continue;
        if (cityGate && maxOur < armies[i] * 2 + 6) continue;
        if (dist[i] < bd) {
          bd = dist[i];
          best = i;
        }
      }
      return best;
    }

    /*
     * focus 刚被拿下时，沿同一个方向再推一格。
     *
     * 不这么做的话每拿下一格就重选「最近的敌方地块」，而最近的那块每回合都可能
     * 是另一块，主纵队就在几块地之间来回摆。一回合一步的规则下摆动一次等于
     * 两回合白走。方向优先沿用记录下来的推进轴，走不通再退回「朝最近敌人」。
     */
    function extendFocus(prev) {
      if (!(prev >= 0 && prev < n)) return -1;
      var px = prev % SW;
      var py = (prev / SW) | 0;
      var dir = S._focusDir;
      var tries = [];
      if (dir) {
        tries.push([dir[0], dir[1]]);
        if (dir[0]) tries.push([dir[0], 0]);
        if (dir[1]) tries.push([0, dir[1]]);
      }
      if (myGeneral >= 0) {
        var gx = myGeneral % SW;
        var gy = (myGeneral / SW) | 0;
        var sx = px === gx ? 0 : px > gx ? 1 : -1;
        var sy = py === gy ? 0 : py > gy ? 1 : -1;
        if (sx || sy) {
          tries.push([sx, sy]);
          if (sx) tries.push([sx, 0]);
          if (sy) tries.push([0, sy]);
        }
      }
      for (var t = 0; t < tries.length; t++) {
        if (!tries[t][0] && !tries[t][1]) continue;
        var nx = px + tries[t][0];
        var ny = py + tries[t][1];
        if (nx < 0 || nx >= SW || ny < 0 || ny >= SH) continue;
        var ni = ny * SW + nx;
        if (!isPassable(owner, ni)) continue;
        if (owner[ni] === pid) continue;
        S._focusDir = [tries[t][0], tries[t][1]];
        return ni;
      }
      return -1;
    }

    /*
     * 扩地：这一手能吃的空格里，挑最划算的那一格吃掉。
     *
     * 打分（落点 j，出兵格 i）：
     *   +2 × j 周围有几面是我们的地     —— 塞缺口：三面贴我们的空格吃下去不产生新周长，
     *                                    贴着敌人那面也短，不容易被对面拿它当我们视野的洞
     *   +0.6 × 出兵格剩的兵            —— 用厚堆出兵，剩下的兵不会卡成 1
     *   -0.3 × 落点到将军的曼哈顿距离   —— 离家近的格子，后面运兵便宜
     *   +1   已知空格（TILE_EMPTY）优先于雾格（可能真是山，走进去白丢一手）
     *   -2 出兵格只有 2 兵              —— 送 1 兵出去就把它卡成 1 兵的死格
     *
     * 将军要攒到 genSend 才动它（唯一的稳定兵源，见 GEN_WEIGHT 的注释）。
     */
    function expandStep() {
      var bestTo = -1;
      var bestSrc = -1;
      var bestScore = -Infinity;
      var gx = myGeneral >= 0 ? myGeneral % SW : -1;
      var gy = myGeneral >= 0 ? (myGeneral / SW) | 0 : -1;
      for (var i = 0; i < n; i++) {
        if (owner[i] !== pid || used.has(i)) continue;
        var a = armies[i];
        if (a < 2) continue;
        if (i === myGeneral && a < genSend) continue;
        var nb = nbr[i];
        for (var k = 0; k < nb.length; k++) {
          var j = nb[k];
          if (owner[j] >= 0) continue; // 只看空/雾；敌方和我方都不算扩地
          if (!isPassable(owner, j)) continue;
          var nbj = nbr[j];
          var ownN = 0;
          for (var m = 0; m < nbj.length; m++) {
            if (owner[nbj[m]] === pid) ownN++;
          }
          var score = ownN * 2 + 0.6 * a;
          if (gx >= 0) score -= 0.3 * (Math.abs((j % SW) - gx) + Math.abs(((j / SW) | 0) - gy));
          if (owner[j] === T.EMPTY) score += 1;
          // 雾里可能是山，也可能正对着一支敌人；已知空格永远先吃
          if (a < 3) score -= 2;
          if (score > bestScore) {
            bestScore = score;
            bestTo = j;
            bestSrc = i;
          }
        }
      }
      if (bestTo < 0) return false;
      return move(bestSrc, bestTo, 'expand');
    }

    /* 块状扩张的落点：贴着我们的地盘、最好几面都是我们的、离家别太远 */
    function blobTarget(dist) {
      var best = -1;
      var bestScore = -Infinity;
      var gx = myGeneral >= 0 ? myGeneral % SW : -1;
      var gy = myGeneral >= 0 ? ((myGeneral / SW) | 0) : -1;
      /*
       * 打不动的格子不能当目标。
       *
       * 中立格是带兵的（回放里常见 8~12 个），迷雾里只有站到旁边才看得见。
       * 以前 blobTarget 只看「贴着我们 + 几面是我们的」，不看那一格有多少兵：
       * 一旦它挑中一个 12 兵的敌方小堡，supply 的前锋就永远推不动（move() 里
       * 「送出去的兵必须比守军多」），而 stuck 计数每 12 手重挑一次还是挑回同一格——
       * 整局就那么空转。回放 _ZP2mPnew 里我们空过 109 手（32.4%）就是这么来的：
       * 将军 t=0..30 一直憋着，直到别的方向凑出能打的兵才动。
       */
      var maxOur = 0;
      for (var mi = 0; mi < n; mi++) {
        if (owner[mi] === pid && armies[mi] > maxOur) maxOur = armies[mi];
      }
      // 目标要黏：每回合换一个边上的落点，兵就在前沿来回搬（第一版实测过，
      // 155→156→155 这种一步三回头）。
      var last = S._focus;
      var lx = last >= 0 ? last % SW : -1;
      var ly = last >= 0 ? ((last / SW) | 0) : -1;
      for (var i = 0; i < n; i++) {
        if (owner[i] === pid || dist[i] !== 1) continue;
        if (!isPassable(owner, i)) continue;
        if (armies[i] + 1 >= maxOur) continue; // 打不动，换一个落点
        var nb = nbr[i];
        var own = 0;
        for (var k = 0; k < nb.length; k++) if (owner[nb[k]] === pid) own++;
        // 三面是墙、一面是我们的空格最值（塞缺口），一字排开的最不值
        var score = own * 3;
        if (gx >= 0) score -= 0.35 * (Math.abs((i % SW) - gx) + Math.abs(((i / SW) | 0) - gy));
        if (lx >= 0) score -= 1.2 * (Math.abs((i % SW) - lx) + Math.abs(((i / SW) | 0) - ly));
        if (isCity[i] && owner[i] < 0) score += 1.5;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      return best;
    }

    function pickFocus() {
      var prev = S._focus;
      if (prev >= 0 && prev < n) {
        if (owner[prev] !== pid) return prev;
        // 块状模式下不沿原方向续推（那就是蛇），改由下面重挑一个贴边的空格
        if (!doBlob) {
          var nxt = extendFocus(prev);
          if (nxt >= 0) {
            S._focus = nxt;
            S._focusStuck = 0;
            return nxt;
          }
        }
      }

      // 上一次 focus 卡死了：说明正面啃不动敌将，转去吃城市——
      // 城市是除将军外唯一的稳定兵源，多一座就多一条 +1/回合的进项。
      if (S._preferCity) {
        var cg = nearestCityGoal();
        if (cg >= 0) {
          S._preferCity = false;
          S._focus = cg;
          S._focusStuck = 0;
          return cg;
        }
        S._preferCity = false;
      }

      var it = generalPlayer.entries();
      for (var e = it.next(); !e.done; e = it.next()) {
        var gp2 = e.value[0];
        if (e.value[1] !== pid && owner[gp2] === e.value[1]) {
          S._focus = gp2;
          S._focusStuck = 0;
          return gp2;
        }
      }

      var dist = new Int32Array(n).fill(-1);
      var queue = [];
      var i;
      for (i = 0; i < n; i++) {
        if (owner[i] === pid) {
          dist[i] = 0;
          queue.push(i);
        }
      }
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }

      // 最近的敌方地块
      var best = -1;
      var bestD = Infinity;
      for (i = 0; i < n; i++) {
        if (owner[i] < 0 || owner[i] === pid || dist[i] < 0) continue;
        if (dist[i] < bestD) {
          bestD = dist[i];
          best = i;
        }
      }
      if (best < 0) {
        /*
         * 视野里没有敌人。迷雾局里这是常态——服务器按视野过滤，看不见的敌格
         * 根本不发（generals 里是 -1，map 里是 FOG）。这时候的目标只有两个：
         *
         *   1. 城市，但要能打得动。中立城有 40~50 兵，主纵队没攒到 1.5 倍就
         *      往那儿推，等于把整盘兵一格一格喂给城。这正是迷雾局里我们地盘
         *      只有对方四分之一的原因：focus 一开局就锁死在最近的城市上。
         *   2. 最近的未知格。扩张应该朝「边界外的黑」推，不是朝「地图最远
         *      端」推——后者会绕开身边一大片没探过的地。
         */
        /*
         * 0. 记忆里最近见过的敌格。对面看见我们就会动，可我们只要没丢视野就
         *    能一直跟到它进黑区；这时候往「它最后一次出现的地方」推，比随便找
         *    一块黑地推更容易接上火——黑区那么多，接火点只有一个。
         *    分数用 dist + 龄期：远处的旧线索让位给近处的新线索。
         */
        var memBest = -1;
        var memScore = Infinity;
        if (M) {
          for (i = 0; i < n; i++) {
            if (owner[i] !== T.FOG && owner[i] !== T.FOG_OBSTACLE) continue;
            var age = tick - M.turn[i];
            if (age > memTtl * 3) continue;
            var mo = M.owner[i];
            if (!(mo >= 0 && mo !== pid)) continue;
            if (dist[i] < 0) continue;
            var sc = dist[i] + age / 4;
            if (sc < memScore) {
              memScore = sc;
              memBest = i;
            }
          }
        }
        if (memBest >= 0) {
          S._focus = memBest;
          S._focusStuck = 0;
          S._focusDir = null;
          return memBest;
        }

        var maxOur = 0;
        for (i = 0; i < n; i++) {
          if (owner[i] === pid && armies[i] > maxOur) maxOur = armies[i];
        }
        /*
         * 城：近的、打得动的，才买。
         *
         * 产能上城是「每 2 tick +1 兵」，一格地是「每 50 tick +1 兵」——一座城
         * 等于 25 格地的进项，所以只要能便宜拿下就必须拿。不划算的是**跑远路**
         * 去拿：一手命令只能走一格，8 步外的城要先在自家地里铺 8 手隧道
         * （回放 WWyoWgLmt 的 67% 自家格走子就是这些隧道）。
         *
         * 所以两条闸门：
         *   - 打得动且打完剩本钱：手里最厚的一堆 >= 守军 × 2 + 6；
         *   - 够得着：8 步以内。远城不追，等推到旁边再说。
         * 两条都满足才排在扩地前面；否则先吃手边的空格。
         */
        var maxOur = 0;
        for (i = 0; i < n; i++) {
          if (owner[i] === pid && armies[i] > maxOur) maxOur = armies[i];
        }
        var cityBest = -1;
        var cd = Infinity;
        if (cityGate || doBlob) {
          for (i = 0; i < n; i++) {
            if (!isCity[i] || owner[i] === pid || dist[i] < 0) continue;
            if (armies[i] + 1 > maxOur) continue; // 打不动，别把兵喂进去
            if (cityGate && maxOur < armies[i] * 2 + 6) continue; // 打完剩不下本钱
            if (dist[i] > cityNear) continue; // 远城不追，见注释
            if (dist[i] < cd) {
              cd = dist[i];
              cityBest = i;
            }
          }
        }
        if (cityBest >= 0) best = cityBest;
        else if (doBlob) best = blobTarget(dist);
        if (best < 0) {
          // 最近的未探索格（FOG）。全视野局没有 FOG，自动退化成「最远的可通行格」。
          // 试过反过来取最远的那块（让纵队直线插进地图深处找人），结果和取最近
          // 逐局相同——focus 是粘性的，这个 fallback 一局里只走一两次，取哪块
          // 都由后面的 extendFocus 接管。
          var fogBest = -1;
          var fgD = Infinity;
          for (i = 0; i < n; i++) {
            if (owner[i] !== T.FOG || dist[i] < 0) continue;
            if (dist[i] < fgD) {
              fgD = dist[i];
              fogBest = i;
            }
          }
          if (fogBest >= 0) {
            best = fogBest;
          } else {
            var far = -1;
            var fd = -1;
            for (i = 0; i < n; i++) {
              if (owner[i] === pid || !isPassable(owner, i)) continue;
              if (dist[i] > fd) {
                fd = dist[i];
                far = i;
              }
            }
            best = far;
          }
        }
      }
      /*
       * 目标太远就换成一个贴边的空格。
       *
       * 一手命令只能把一堆兵往前挪一格。目标在 15 步开外时，supply() 的
       * 「前锋」够不着目标（dist==1 的格子在那边，我们还没打过去），每一手
       * 都落进 rail 的隧道逻辑：把兵沿链在自家地里挪一格。搬十手换不来一格地，
       * 回放 WWyoWgLmt 的 67% 自家格走子就是这么来的。
       *
       * 远处的目标（城、记忆里的敌格、黑区）留着，等推到近处再打：现在先吃
       * 手边的空格——同样是 1 个兵换 1 格，而且主纵队不用掉头。
       */
      if (doBlob && best >= 0 && dist[best] > focusNear) {
        var nearT = blobTarget(dist);
        if (nearT >= 0) best = nearT;
      }
      S._focus = best;
      S._focusStuck = 0;
      S._focusDir = null;
      if (best >= 0 && myGeneral >= 0) {
        var bx = (best % SW) - (myGeneral % SW);
        var by = ((best / SW) | 0) - ((myGeneral / SW) | 0);
        if (bx || by) S._focusDir = [bx === 0 ? 0 : bx > 0 ? 1 : -1, by === 0 ? 0 : by > 0 ? 1 : -1];
      }
      return best;
    }

    /*
     * 朝目标推一格：反向 BFS 出步数场，然后按「兵最多」挑一个能往目标方向动
     * 的己方格子。这就是主纵队的形成方式——最重的那堆先走，后排把兵补上去，
     * 每回合只花一条命令，但整条链一直在往一个方向流。
     * 按距离挑是错的：那会让每格轮流送 1 个兵，兵永远散在通往目标的路上。
     */
    function supply(goal) {
      if (!(goal >= 0 && goal < n)) return false;
      var dist = new Int32Array(n).fill(-1);
      var queue = [goal];
      dist[goal] = 0;
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }
      /*
       * 分两档挑源格：贴目标的「前锋」先推，推不动再从后方「集兵」。
       *
       * 原来只有一档：全图按兵数排序，最重的一堆往目标挪一格。问题在最重的那堆
       * 往往在后方——它挪一格只是在自己地盘里挪，而前锋那几个兵原地不动，于是
       * 一局里一半的命令都花在自家格子上（regret.js 实测 49.2%）。
       *
       * 现在的规矩：
       *   1. 前锋（dist==1）优先：能直接吃到目标就吃，兵最多的先上。
       *   2. 吃不动就把后方的一堆往前搬一格，但源格必须 >=3 兵（见 move() 里的
       *      内部搬运门槛），而且要优先并到已经有兵的前锋堆上——那样下一回合
       *      前锋才有厚度推出去。
       */
      var front = [];
      var rail = [];
      for (var i = 0; i < n; i++) {
        if (owner[i] !== pid || used.has(i) || armies[i] < 2 || dist[i] <= 0) continue;
        if (i === myGeneral) {
          // 后期将军封存：地块产能已经超过将军，让它出门等于把不可再生的
          // 兵源挪到敌方视野边上。
          if (phase === 2) continue;
          /*
           * 将军攒到 genSendMin 才出门，不管目标是空地还是硬方块。
           *
           * 原来「目标是空地就 2 兵出门」是个陷阱：每回合只抽走 1 个兵，主纵队
           * 链条上每格永远卡着 1 兵——1 兵的格不能动，兵永远到不了前沿。迷雾局
           * 里 focus 几乎总是空地，于是整局在「将军 → 中转格」这两三格之间来回
           * 填兵，一步也没推出去（trace 里 125>105>104 反复 25 回合）。
           * 攒到 6 再送，一次送 3 个，链才有厚度往前推。
           */
          if (armies[i] < genSend) continue;
          // 已经在敌方视野圈边上：确认朝目标方向还有一步是安全的，否则原地攒兵。
          if (!safeForGeneral(i)) {
            var canStep = false;
            var gnb = nbr[i];
            for (var gk = 0; gk < gnb.length; gk++) {
              if (dist[gnb[gk]] === dist[i] - 1 && isPassable(owner, gnb[gk]) && safeForGeneral(gnb[gk])) {
                canStep = true;
                break;
              }
            }
            if (!canStep) continue;
          }
        }
        if (dist[i] === 1) front.push(i);
        else rail.push(i);
      }

      function weight(idx) {
        // 将军的兵要打点折扣：它是唯一兵源，抽空了后面就补不上。
        return idx === myGeneral ? genWeight : 1;
      }
      DBG.front = front.length;
      DBG.rail = rail.length;
      // 每次 supply 调用一行：目标[前锋,后送,将军到目标几步]
      DBG.calls = DBG.calls || [];
      DBG.calls.push(goal + '[f' + front.length + ',r' + rail.length + ',d' + (myGeneral >= 0 ? dist[myGeneral] : -9) + ']');

      // 1. 前锋：紧贴目标，兵最多的先推
      front.sort(function (a, b) {
        return armies[b] * weight(b) - armies[a] * weight(a);
      });
      for (var f = 0; f < front.length; f++) {
        var fstep = -1;
        var fnb = nbr[front[f]];
        for (var fk = 0; fk < fnb.length; fk++) {
          if (dist[fnb[fk]] === 0) {
            fstep = fnb[fk];
            break;
          }
        }
        if (fstep < 0) continue;
        if (move(front[f], fstep, 'push')) return true;
      }

      /*
       * 2. 前锋吃不动时，先吃身边能吃的空格，别沿着通往远处目标的链在自家
       *    格子里一格一格搬。
       *
       * 这是「自家搬 67%」的真正来源：focus 往往是远处的一座城或一片黑，
       * dist==1 的前锋根本够不着它，于是每一手都在 rail 里把兵沿链往目标方向
       * 挪一格——而那一格还是我们自己的地。搬十手换不来一格地。
       *
       * 换成「就近吃一格」之后，同一手命令换来 +1 地（每格每 50 tick +1 兵，
       * 是永久产能），而不是让兵在自家地里多走一步。只有在真的没空格可吃
       * （被山和敌人围住）时，才退回去沿链搬兵。
       */
      if (expandStuck && expandStep()) return true;

      // 3. 集兵：后方一堆往前搬一格，优先并到已经有兵的格子上
      var railScore = new Map();
      var railStep = new Map();
      for (var r = 0; r < rail.length; r++) {
        var ridx = rail[r];
        var rstep = -1;
        var rnb = nbr[ridx];
        for (var rk = 0; rk < rnb.length; rk++) {
          var rj = rnb[rk];
          if (dist[rj] === dist[ridx] - 1 && isPassable(owner, rj)) {
            rstep = rj;
            break;
          }
        }
        if (rstep < 0) continue;
        // 并到已有的堆上比铺一个新 1 兵格值：那个堆下一回合就能继续往前挪。
        var bonus = owner[rstep] === pid && armies[rstep] >= 2 ? 1.6 : 1;
        railScore.set(ridx, armies[ridx] * weight(ridx) * bonus);
        railStep.set(ridx, rstep);
      }
      /*
       * 从前沿往后倒灌，不是从后往前推。
       *
       * 原来按兵数从厚到薄搬：搬的是全图最厚的那堆，而它往往在后方。它挪一格
       * 只是在自己家里挪，前沿那几个兵原地不动——一局一半的命令花在自家格子里
       * （regret 实测 67%）。按 dist 从近到远排，紧贴前沿的那堆先并进去，下一回合
       * 才轮到它后面那堆，前沿每回合净增一层兵，才能真的啃下东西。
       */
      rail.sort(function (a, b) {
        if (railFront && dist[a] !== dist[b]) return dist[a] - dist[b];
        return (railScore.get(b) || 0) - (railScore.get(a) || 0);
      });
      for (var g = 0; g < rail.length; g++) {
        var gidx = rail[g];
        if (armies[gidx] < 3) continue; // 内部搬运门槛，见 move()
        var gstep = railStep.get(gidx);
        if (gstep === undefined) continue;
        /*
         * 别往后倒兵（noBackstep）。
         *
         * 条件很窄，只在三种情况同时成立时才跳过一个候选：
         *   能看见敌格（denemy >= 0）——迷雾里两边都是 -1 时这条不起作用；
         *   这一步让离敌格更远；
         *   目标格只是个薄格（< 4 兵），不是去跟厚堆会合。
         * 回放 N7Npym_VP 的 t=76/84/86/94/96 就是这一种：(16,5) 攒到 18~23 兵，
         * 一次一次往 (16,6) 倒，离敌从 11 步变成 12 步，每倒一次还留 1 兵在原地。
         * 全盘这类手 66 手（11.1%），是「没意思的 turn」里最大的一块。
         */
        if (
          noBackstep &&
          denemy[gidx] >= 0 &&
          denemy[gstep] >= 0 &&
          denemy[gstep] > denemy[gidx] &&
          armies[gstep] < 4
        )
          continue;
        if (move(gidx, gstep, 'gather')) return true;
      }
      return false;
    }

    /*
     * 预警守将：从将军往外 BFS 最多 8 步，找视野内最厚的敌军。
     * 贴着将军的按原值算，远处的要厚一倍才算威胁——真实产兵规则下将军每回合
     * 才 +1，要是「任何比我厚的兵都算威胁」，引擎整局都在回头并兵，一步也推不出去。
     * 并完就继续推进：每回合只有一条命令，站着等死比冲出去更亏。
     */
    function defendWarn() {
      if (myGeneral < 0 || owner[myGeneral] !== pid) return false;
      var dist = new Int32Array(n).fill(-1);
      var queue = [myGeneral];
      var i;
      dist[myGeneral] = 0;
      var threatArmy = -1;
      var bestDelta = -Infinity;
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        if (dist[cur] >= 8) continue;
        if (cur !== myGeneral && owner[cur] >= 0 && owner[cur] !== pid) {
          // 用「到达时还剩多少兵」判断威胁，而不是当前兵数：敌人走过来要 dist
          // 回合，这期间将军也在涨 dist 兵。只有 armies - dist > ga + dist 才算
          // 真威胁——否则每次把兵送出去、将军暂时变薄都会触发并兵，
          // 兵就在将军和前线之间来回搬，两个回合白走一趟。
          var delta = armies[cur] - 2 * dist[cur];
          if (delta > bestDelta) {
            bestDelta = delta;
            threatArmy = armies[cur];
          }
          continue;
        }
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
        }
      }
      if (threatArmy < 0 || bestDelta < armies[myGeneral]) return false;

      var limit = budget;
      while (moves.length < limit) {
        var bestSrc = -1;
        var bestA = 1;
        for (i = 0; i < n; i++) {
          if (owner[i] !== pid || used.has(i) || i === myGeneral) continue;
          if (dist[i] < 1 || dist[i] > 8) continue;
          if (armies[i] > bestA) {
            bestA = armies[i];
            bestSrc = i;
          }
        }
        if (bestSrc < 0) break;
        var step = -1;
        var nb = nbr[bestSrc];
        for (var k2 = 0; k2 < nb.length; k2++) {
          var j2 = nb[k2];
          if (dist[j2] === dist[bestSrc] - 1) {
            step = j2;
            break;
          }
        }
        if (step < 0 || !move(bestSrc, step, 'alert')) break;
      }
      // 并完继续推进：站着等死比冲出去更亏
      return false;
    }

    // 已停用：每回合只有一条命令时，分层最大流的多源并流是负收益
    // （吞吐=被搬那一格的兵减一，同时铺开的战线越多每条越慢）。
    // 保留函数体是为了 bench-ab / 未来多回合规划还能调，主流程不再走这里。
    function transport() {
      if (!GB.flow) return;      var goal = pickGoal();
      var base = {
        n: n,
        nbr: nbr,
        owner: owner,
        armies: armies,
        pid: pid,
        budget: budget,
        myGeneral: myGeneral,
        moves: function () {
          return moves;
        },
        move: move
      };
      // 先集中打一个目标；集中模式下没有可流的兵（比如贴不上那个目标）再看全图
      var res = GB.flow.plan(Object.assign({}, base, { focus: goal }));
      if (!res.moves.length) res = GB.flow.plan(Object.assign({}, base, { focus: -1 }));
      if (res.moves.length) reasons.push('flow:' + res.stats.flow + '/' + res.stats.demand);
    }

    // 目标：敌将 > 最近的敌方地块 > 最远的可探索格
    function pickGoal() {
      var gpIter = generalPlayer.entries();
      for (var e = gpIter.next(); !e.done; e = gpIter.next()) {
        if (e.value[1] !== pid && owner[e.value[0]] === e.value[1]) return e.value[0];
      }
      var dist = new Int32Array(n).fill(-1);
      var queue = [];
      var i;
      for (i = 0; i < n; i++) {
        if (owner[i] === pid) {
          dist[i] = 0;
          queue.push(i);
        }
      }
      var nearestEnemy = -1;
      var far = -1;
      for (var h = 0; h < queue.length; h++) {
        var cur = queue[h];
        if (owner[cur] >= 0 && owner[cur] !== pid) {
          nearestEnemy = cur;
          break;
        }
        var list = nbr[cur];
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (dist[j] !== -1 || !isPassable(owner, j)) continue;
          dist[j] = dist[cur] + 1;
          queue.push(j);
          if (far < 0 || dist[j] > dist[far]) far = j;
        }
      }
      return nearestEnemy >= 0 ? nearestEnemy : far;
    }

    // 兜底：单栈推不动时（目标被山挡死之类）朝最近的敌人/最远处挪一步。
    function conveyor() {
      var goal = pickGoal();
      if (goal >= 0) supply(goal);
    }

    GB.lastReasons = reasons;
    DBG.phase = phase;
    DBG.genSend = genSend;
    DBG.genArmy = myGeneral >= 0 ? armies[myGeneral] : -1;
    DBG.moves = moves.length;
    DBG.front = DBG.front || 0;
    DBG.rail = DBG.rail || 0;
    DBG.focus = S._focus;
    // 记下本回合下发的逆向 key，下一回合不许原路走回来（见 move() 的 antiReverse）
    S._prevKeys = [];
    for (var mk = 0; mk < moves.length; mk++) S._prevKeys.push(moves[mk][1] + '>' + moves[mk][0]);
    return moves;
  }

  GB.bot = { plan: plan, neighbors: neighbors, isPassable: isPassable };
})();

