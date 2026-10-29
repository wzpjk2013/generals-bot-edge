# Generals AutoPilot（Edge / Chrome 扩展）

generals.io 的浏览器端机器人：读对局状态 → 每个半回合决策一步 → 用官方前端自己的 socket 下发 `attack`。
不修改服务器，不注入游戏文件，纯页面内旁路。

## 装

1. 打开 `edge://extensions`
2. 打开「开发人员模式」
3. 「加载解压缩的扩展」→ 选中本目录（含 `manifest.json` 的那一层）
4. 打开 <https://generals.io/>，右上角出现面板

Chrome 同理（`chrome://extensions`）。需要 Chromium 111+：`content_scripts` 用了 `"world": "MAIN"`。

**改了代码必须回来点「重新加载」**，否则页面里跑的还是旧代码。为了一眼能看出来，
面板标题右边直接显示清单里的版本号（`v1.1.0`）：

| 面板上看到的 | 意思 |
| --- | --- |
| 没有版本号 | 隔离世界的 `bridge.js` 没跑起来（`chrome.runtime` 读不到），设置和版本号都传不过来 |
| 版本号和 `manifest.json` 不一致 | 扩展没重载，跑的是上一版 |
| 加载解压缩失败 | 通常是 `manifest.json` 是 GBK 乱码 —— 这个仓库踩过三次，别用 PowerShell 的 `Get-Content/Set-Content` 改源码 |

每次改完跑一下版本号（`manifest.json` 和 `package.json` 会一起涨）：

```powershell
node scripts/bump-version.js          # 1.1.0 -> 1.1.1
node scripts/bump-version.js minor    # -> 1.2.0
node scripts/bump-version.js --check  # 只校验两边一致
```

## 用

- 进对局就接管：公开匹配、自建房间一视同仁，不需要额外开关。
- 面板上有总开关、每半回合步数（1–2，默认 1），实时显示回合、地块/兵力、已走步数、最近一次走子。
- 关掉总开关随时手动接管。
- **状态行只有四种值**：`未开局`（还没进对局，或者地图还没下发）、`运行中`、`已暂停`、`对局结束`；
  出错时红字覆盖成具体错误。没有「等待连接 / 等开局」这种含糊说法——
  究竟是没连上还是没开局，鼠标停在状态行上看 title。
- **「事件 / 决策 / 下发」三个计数是排障用的**：

  | 现象 | 说明 |
  | --- | --- |
  | 事件一直是 0 | 一个对局包都没收到 → socket 陷阱没命中，或协议事件名改了 |
  | 事件在涨、决策不动 | 包收到了但引擎每回合都返回空 → 引擎问题（看下面的「将军何时出门」） |
  | 决策在涨、下发不动 | 有动作但 `emit('attack')` 抛异常 → 错误写进状态行 |
  | 三个都在涨但棋盘不动 | 下发的格子非法被服务器丢了（多半是本地状态和服务器不同步） |

## 怎么读到对局

官方 bundle 里没有暴露 redux store，但有两条稳定通道：

1. **socket 实例**：bundle 执行 `n.g.socket = io(...)`，把 socket.io 实例挂到 `window.socket`。
   扩展在 `document_start` 用 `Object.defineProperty` 在该属性上装 setter，实例一赋值就到手，
   然后 `sock.on('game_start' | 'game_update' | 'game_over' ...)`。
2. **串行化地图**：

   ```
   [w, h, armies(0..n-1), terrain(0..n-1), tunnelLimits(0..n-1)]
   ```

   首帧全量，之后 `map_diff` / `cities_diff` 是增量，编码为成对的
   `(相同个数, 变化个数, ...变化值)`，和官方 `delta()/patch()` 完全一致，`src/state.js` 复刻了一份。

terrain：`-1` 空地、`-2` 山、`-3` 迷雾、`-4` 雾中山、`-5` 瞭望塔、`-6` 观测站，`>= 0` 是玩家下标；
`generals[p]` 是玩家 p 的将军格（只在视野内有效）。

下子走官方同一个 emit：`socket.emit('attack', from, to, false, attackIndex)`——事件名由官方包装层压成协议下标，
不用维护协议表，也不用绕 bot 服务器。第四个参数是单调递增的动作序号（不是回合号），服务端只做
`attackIndices[p] = Math.max(...)` 推进。每个半回合只下发一条：服务器每 tick 也只消费一条，多发只会排队成过时命令。

## 怎么决策（`src/bot.js`）

每收到一次 `game_update`（= 一个半回合）跑一次，只下发一条，按固定优先级出子，全部在本地乐观状态上提交，保证一格一回合只动一次：

**A. 斩首** — 贴脸的敌方将军且 `我方兵力-1 >= 守军 × 1.5`，直接吃，对局当场结束。1.5 倍是照攻略来的：只强 1 个兵的微弱优势打进去只是给对方送兵，还把自己唯一的主纵队变成对面的养料。

**B. 守将** — 将军被贴脸且兵力不如对方时，依次尝试：将军反打 → 最强邻居代打 → 把最强邻居并进将军硬扛。

**B3. 清剿内部入侵者** — 四邻里至少两个是我方格、且我方有邻居 `兵-1 > 守军` 的敌格，就地用地块兵吃掉。挑「刚好够用」的那一堆而不是最厚的（厚堆是主纵队）。这一条是唯一有实测正收益的新增项：**+2.5%**（关掉 90.0% → 开着 92.5%，80 局口径）。

**B2. 预警** — 从将军 BFS 8 步，用「到达时还剩多少兵」判断威胁：敌人走过来要 `dist` 回合，这期间将军也在涨 `dist` 兵，所以只有 `armies - dist > ga + dist` 才算真威胁。并兵召回半径为整个预警圈（8 步），并完**照常推进**，不站着等。

**C. 单栈推进（主力）** — 只养一个 focus，每回合把「最重的己方堆」朝它推一格。

这是整套引擎的核心，规则来自一个硬约束：**每回合只有一步，所以吞吐 = 被搬那一格的兵减一**。想同时推进三条战线，每条就都只能每三回合动一次，有效运兵还是 1/回合，但每一格都被抽成了 1 兵的薄片。hunter 赢就是因为它什么都不扩张，只养一条链。

- **focus 单栈**：跨回合保持，只有拿下 / 卡 12 回合才换。优先级 `敌方将军 > 最近敌方格 > 最近未占城市 > 最远可探索格`。目标粘性是关键——每回合换目标等于每回合重新铺一条路，兵永远在路上
- **选格子按兵多，不按距离近**：反向 BFS 出步数场后，在「能朝目标方向动一步」的己方格里挑**兵最多**的那个。按距离挑是错的，那会让每格轮流送 1 个兵，永远是流水线不是拳头
- **迷雾记忆**（`S._mem`）：服务器每回合重新序列化、不给任何记忆，客户端看到的是「这一回合看得见的东西」。所以引擎自己记一份「最近见过的敌格（归属 / 兵数 / 时刻）」，`memTtl = 40` tick 内算有效线索：威胁场里补上这些格子，找不到敌人时优先往「它最后一次出现的地方」推，而不是随便挑一块黑地
- **将军是最后一支被调动的部队**（`GEN_WEIGHT = 0.2`）：候选出兵格按 `兵力 × 权重` 排序，将军只有 0.2，也就是同样厚的普通堆排它前面。它只在「别的兵堆都推不动」时才当主纵队。这一条是镜像 A/B 实测出来的，见下面「将军何时出门」
- **将军攒够了才出门**：`GENERAL_SEND_MIN = 6` 兵起步，出兵只送一半（`sent = a >> 1`，留 `ceil(a/2)`）
- **将军不进敌方视野**：将军每一步都必须留在「离最近**已知**敌格 ≥ `GEN_SAFE = 2`」的位置。对手能看见的 = 他的领土 + 邻接一圈，所以 2 步刚好在视野外，1 步就已经被看见（见下面的迷雾一节）。打贴脸的敌人不受这条限制。注意 `denemy` 只算**看得见**的敌格——迷雾里藏着敌人它不知道，这是这一条在实战里的真实上限
- **将军不封存**（`lateFreeze` 默认关）：曾经有一条「480 tick 之后将军只吃不吐」，那是打弱参考 bot 得出的假结论。镜像 A/B 里关掉它，迷雾 69.5%、全视野 59.5%（都是 200 局、已分胜负口径）
- **将军隔壁有敌人时只准直接打它**，别的方向一律不出兵——将军被吃得手整局就结束
- 走子的合法性全部在本地乐观状态上提交：一格一回合只动一次，往自己格子并兵永远合法（只损耗 1），打敌人格要求 `送出去的兵 > 守军`

**C2. 将军后撤** — 将军被压在 `denemy <= GEN_SAFE` 时朝远离敌人一侧挪一格。没有这一步会有死锁：将军正好卡在安全线上（`denemy == 2`）时，朝目标走一步就进圈（被拒），停下又不算推进，整回合一条命令都出不了。

**D. 兜底** — 单栈推不动（目标被山挡死之类）时朝最近的敌人 / 最远处挪一步，避免整回合空转。

### 被弃用的：分层最大流输兵（`src/flow.js`）

前一版的主力是 Dinic 最大流多源并流（把后排兵分摊到所有缺口）。它在「每回合多步」的假设下有效，但在真实的 1 步约束下是**负收益**：同时铺开的战线越多，每条战线分到的回合越少，回合利用率反而降低。代码保留在 `src/flow.js` 并有独立测试，主流程不再调用。

### 参考实现

主要照 [`hunter_agent.py`](https://github.com/strakam/generals-bots/blob/master/generals/agents/hunter_agent.py) 的单栈 + 四档优先级（斩首 / 喂兵 / 输送 / 不动）重写。另外核对过：
[`LocalGen-new`](https://github.com/SZXC-WG/LocalGen-new) 的 KtqBot/GcBot（focus 持久化、`army_strength = log(1+army)` 的缩放）、
[`dwaltrip/generals-ai`](https://github.com/dwaltrip/generals-ai) 的 `arriving_army = Σarmy - (|集合|-1)` 与「余量随距离增长」、
[`harrischristiansen/generals-bot`](https://github.com/harrischristiansen/generals-bot) 的驻军公式 `min(threat+2, 0.5*total_army)`。


## 目录

```
manifest.json           MV3 清单
src/state.js            串行化地图 + delta 还原 → GameState
src/bot.js              决策引擎（纯函数，离线可测）
src/flow.js             兵力输送：分层最大流（Dinic）
src/hook.js             socket 劫持 / 回合驱动 / Shadow DOM 面板
src/bridge.js           隔离世界：chrome.storage 读写设置
src/net/augment.js      AverageJoe 观测编码移植（38 通道 + 归一化）
src/net/transformer.js  AverageJoe 网络前向移植（patchify / attention / unpatchify）
src/net/weights.js      参数清单与扁平权重灌入
test/bot.test.js        决策与状态还原的离线回归（17 条）
test/flow.test.js       输送器回归（8 条）
test/net.test.js        网络移植回归（11 条）
scripts/cdp.js          极简 CDP 驱动（零依赖；serveStub 可在断网时把首页换成空壳页）
scripts/e2e-check.js    真机冒烟：扩展加载、面板挂载、版本号、「未开局」、socket 陷阱
scripts/e2e-pipeline.js 全链路：注入对局 → 机器人下发 attack
scripts/bench.js        32x32 跑 200 回合的耗时与扩张基准
scripts/bench-ab.js     推土机 vs 最大流的 A/B
scripts/bench-net.js    AverageJoe 网络单次前向延迟
scripts/refagents.js    参考 bot 移植（random / expander / hunter / harvester / ladder / gc / szly）
scripts/refbots/        从 LocalGen-new 源码逐个移植的强对手（放进来就自动注册）
scripts/refbots/smoke.js 单个移植对手的冒烟：$env:GB_BOT='oim'; node scripts/refbots/smoke.js 20
scripts/arena.js        与参考 bot 的 1v1 擂台（GB_FOG=0 切全视野，GB_OPP='gc,oim' 只跑指定对手）
scripts/ab.js           镜像 A/B：同一份代码、不同参数对打，50% 就是没差别
scripts/mirror.js       引擎打自己，查走子顺序 / 阵营有没有系统性偏差
scripts/pk-report.js    强对手 PK 报告（Markdown 表格，GB_WRITE=1 写 PK.md，GB_WEAK=1 加弱基线）
scripts/sweep.js        单变量扫描：对指定对手逐个参数跑，看谁真的动了
scripts/bump-version.js manifest + package 版本号同步自增（--check 校验）
PK.md                   最近一次 PK 结果（脚本生成，别手改）
scripts/idle-stats.js   空转率统计（整回合一条命令都没出的比例）
scripts/trace-fog.js    单局迷雾 trace（逐回合打印走子）
```

## 测

```bash
node test/bot.test.js        # 16 条离线断言，含 20 回合自对局合法性
node test/flow.test.js       # 输送器：走廊 / 双前线 / 绕山 / 不动将军 / 合法性
node test/net.test.js        # 网络移植：形状、掩码、patch 映射、确定性
node scripts/bench.js        # 单回合决策耗时 + 200 回合扩张率（每回合 1 步）
node scripts/bench-ab.js     # 推土机 vs 最大流：打穿硬骨头的回合数
node scripts/bench-budget.js # 反事实实验：每回合给 N 条命令会怎样（非真实赛制）
node scripts/bench-net.js    # AverageJoe 单次前向延迟（L / S 两档）
node scripts/pk-report.js 40 # 强对手 PK 表（默认迷雾），GB_WRITE=1 写 PK.md
node scripts/arena.js 40     # 只跑擂台、逐行打印（13 个对手 × 40 种子 × 先后手）
node scripts/ab.js 100       # 镜像 A/B（GB_CFG / GB_CFG2 传参数，PowerShell 里用环境变量最稳）
node scripts/sweep.js 60 gc,szly,oim  # 单变量扫描
$env:GB_BOT='oim'; node scripts/refbots/smoke.js 20   # 单个移植对手的冒烟
GB_FOG=0 node scripts/arena.js 40        # ⚠️ 全视野作弊版，只用于和旧数据对比
node scripts/idle-stats.js hunter 40   # 空转率：整回合一条命令都没出的比例
node scripts/e2e-check.js    # 需要本机 Edge，自动起 headless
node scripts/e2e-pipeline.js # 未打包加载 + 合成对局，断言 attack 参数形状
```

`e2e-check` / `e2e-pipeline` 不依赖外网：CDP 的 Fetch 域会把 `https://generals.io/*`
换成自带的空壳 HTML，页面的 URL 仍然是 `generals.io`，`content_scripts` 照常注入，
所以扩展注入、面板、版本号、socket 陷阱、下发形状全都能测。
断网时 `e2e-check` 的输出里 `stubbed: true`。

当前基准（本机，32×32 带山与 12 座城，每回合 1 步 = 真实节拍）：

```
总走子     199（平均 1.0/回合）
单回合平均 0.35 ms
已占地图   200/1024（19.5%）
```

A/B（`bench-ab.js`，指标是那块硬骨头被打穿的回合数，越小越好）：

```
围死的三个口子   推土机 36/449/404 →  最大流 36/66/74
32x32 常规开局   600 回合内两边都没打穿（每回合只有 1 步，这个场景给的时间不够）
单回合耗时       0.17 ms / 0.16 ms，0.41 ms / 0.28 ms
```

围死场景是最能说明问题的一行：同样的时间预算，推土机要 400+ 回合才啃下来的口子，
最大流 66 回合就打穿——因为推土机的兵全压在第一线，最大流会把后方积压的兵调过去。

`e2e-pipeline` 用 `GB.feed(name, payload)` 注入——和 socket 订阅走同一份 handler，不用真进对局。

## 服务器规则（从官方 bundle 里核出来的）

官方的 `/generals-main-prod-v31.4.5-e5c53eb3.js` 里带着完整对局引擎（本地对战和回放
都用它），规则可以直接读，不用猜：

**一个半回合一个玩家只能走一步。** `getPlayerMovesPriorityV2` 对每个玩家先取队列里
最早的一条，校验通过就 `break`：

```js
for (; this.inputBuffer[n].length; ) {
  const [e, r, i, o] = this.inputBuffer[n].splice(0, 1)[0];   // start,end,is50,attackIndex
  if (this.checkAttackValidAndIncrementAttackIndex(n, e, r, i, o)) {
    t.push({ playerIndex: n, start: e, end: r, is50: i, attackIndex: o });
    break;
  }
}
```

所以客户端连着点 N 个格子，并不是同一回合发 N 条，而是**排队**：`inputBuffer` 每个
半回合被消费一条。这也解释了 `attack` 的第四个参数是 `attackIndex`（单调递增序号）
而不是回合号。

**屏幕上的回合 = 2 个半回合。** 内部 `turn` 每 tick +1，UI 显示
`Math.floor(t.turn / 2)`，奇数 tick 后面补一个点（`12` / `12.` 交替）。

**产出也是按半回合计的**（常量 `RECRUIT_RATE: 2`、`FARM_RATE: 50`）：
每个显示回合你的将军 +1、城市 +1、沼泽 -1；每 25 个显示回合（一轮）每个已占格 +1。
换句话说**地盘本身几乎不产兵，兵源只有将军和城市**——这是这个游戏的经济核心。

### 迷雾：真实存在，而且服务器在数据层就过滤了

所有模式都有视野限制，1v1 也有。**服务器在 `sendGameUpdate` 里按视野过滤后才下发**，
不是渲染遮罩（这一节之前写错过，在这里更正）：

```js
// sendGameUpdate(payload, visibilityMask, socket, playerIndex)
var d = this.map.serialized(deadOrOver ? -1 : r, h, visibilityMask, c, f, lookups);
```

`serialized` 里逐格判断：

```js
if (r[A] & h) {                       // 这一格对当前玩家可见
  f[a+u] = this._map[A];              // 真实地形
  f[a+2] = this._armies[A];           // 真实兵数
} else {
  f[a+u] = this.isObstacle(A) ? TILE_FOG_OBSTACLE : TILE_FOG;
  f[a+2] = 0;                         // 兵数抹成 0
}
```

同一段里还会按掩码裁掉「看不见的敌将位置」（`generals` 里是 `-1`）和「看不见的城市」
（`cities.filter(t => u || e[t] & o)`）。`computeVisibility` 是在**服务器**上跑的；客户端
那份同名函数只用于本地对局、回放和观战。

**视野规则**（`Map._precomputeMapVisibilityLookups` + `computeVisibility`）：

```js
var s = this.movableLookup[o].slice();   // 四邻
… push 四个斜角 …                        // 再补 (row±1, col±1)
s.push(o);                               // 还有自己
```

也就是**己方每一个格的 3×3**。不是四邻，含斜角。

**城市没有特权。** 上一版这里写着「城市对所有玩家永久可见」，引的是
`for (U = 0; U < cities.length; U++) A[cities[U]] = u`——但那一句的 `n` 是
`computeVisibility(lights, cities, generals, turn)` 的第一个参数 **lights**，不是 cities。
真正处理城市的在 `serialized` 的结尾：

```js
for (A = 0; A < cities.length; A++) {
  var d = perm[cities[A]];
  if (f[d + u] === TILE_FOG) f[d + u] = TILE_FOG_OBSTACLE;
}
```

**看不懂的格子如果是城，就写成 `TILE_FOG_OBSTACLE`——和山一模一样。**
（`isObstacle` 只认山 / 观测站 / 瞭望塔，城是被这段单独改写的。）所以：

- 障碍物的位置从第 0 回合起就是公开信息（服务器每格都下发，只是不可见的写成 FOG）
- 但「这个障碍是山还是城」要站到它 3×3 里才知道；没看懂之前只能当墙绕
- `cities_diff` 只下发当前看得见的城，城一旦出视野就从表里消失

**迷雾没有记忆。** `map_diff` 是「上一回合的序列化结果 → 这一回合的序列化结果」的差，
每回合都重新按当前视野序列化，所以看不见的格子会被改回 `TILE_FOG`、兵数抹成 0。
客户端（和扩展读到的 `map`）能知道的，只有这一回合看得见的东西。

**所有跑分默认就是迷雾**，全视野是作弊版，只有显式写 `GB_FOG=0` 才给。迷雾模型按上面
三条实现：3×3 视野、看不见的城退化成障碍、无记忆。引擎侧另外自己维护了一份「最近见过
的敌格」（`S._mem`）——那是人脑，不是客户端。

## PK：和参考 bot 打

`scripts/arena.js` 起一个 20×20 的 1v1 擂台。对手全部是 GitHub 上开源 bot 的 JS 移植
（`scripts/refagents.js`）：

| 名字 | 档 | 出处 | 说明 |
| --- | --- | --- | --- |
| `gc` | 强 | **SZXC-WG/LocalGen-new** | GcBot：路线估价 BFS + 随兵力变形的格价值 + 25% 分位探索 + 目标黏性 |
| `szly` | 强 | **SZXC-WG/LocalGen-new** | SzlyBot：块价值图 + 概率「收兵」把后排并上来 |
| `oim` | 强 | **SZXC-WG/LocalGen-new** | oimBot：记忆推演 + 三档威胁反向 Dijkstra + 逐目标双向评估 |
| `kutu` | 强 | **SZXC-WG/LocalGen-new** | KutuBot：四张压力/守备图 + 五桶目标候选 + 走廊支援 |
| `xiaruize` | 强 | **SZXC-WG/LocalGen-new** | XiaRuizeBot：6 个出兵源各建一张带成本的路线图，全局挑最划算的一步 |
| `zlyv21` | 强 | **SZXC-WG/LocalGen-new** | ZlyBot v2.1：双焦点防守搜索，有模式机（攻击/探索/防守）+ 家区防守 |
| `ktq` | 弱 | **SZXC-WG/LocalGen-new** | KtqBot：单焦点局部贪心，纯扩张、不设防 |
| `zlyv3` | 弱 | **SZXC-WG/LocalGen-new** | ZlyBot v3：记忆感知加权搜索，只会往最高价值格全押 |
| `random` | 弱 | strakam/generals-bots | 随机合法走子 |
| `expander` | 弱 | strakam/generals-bots | 边境能吃的就吃，按兵力加权随机 |
| `hunter` | 弱 | strakam/generals-bots | 守将 + 单条纵队推进 + 够得着就斩首 |
| `harvester` | 弱 | strakam/generals-bots | hunter + 顺路收编吃得起的中立城 |
| `ladder` | 弱 | harrischristiansen/generals-bot | 目标距离折扣 + 守备需求 + 最厚堆评选 |

**强档才进 PK 合计**，弱档只作「会动的基线」，要跑得显式写 `GB_WEAK=1`——
它们要么没有迷雾处理（strakam/harris 那五个在迷雾下几乎不动），要么不会护将也不经营
城市（`ktq` / `zlyv3` 全视野下 100% 输），赢它们不说明任何问题。

新移植的对手都是 C++ 原版逐行搬过来的，每个一个文件放在 `scripts/refbots/`
（`scripts/refagents.js` 启动时自动扫描注册，加对手不用改共享文件）。
各文件头注释写明了被简化/丢弃的分支和原因，自测用：

```powershell
$env:GB_BOT='oim'; node scripts/refbots/smoke.js 20
```

几个关键实现差别：

- `gc` 不选「目标格」，而是给整张图算**路线估价**：从出兵格 BFS 沿路累加（自己格 +army−1、
  敌格 −army、城 −army/2、没见过的格子 +2），同距离取 eval 高的那条路；格价值 = 类型价值
  （随兵力变形）+ eval/5 − 距离 − √(40·离将军距离)；探索取「未探索格距离的第 25 百分位」
  而不是最近那个；有 7% 概率重选出兵格，把后排积压的兵调上来
- `szly` 用块价值图（空白 30 / 城 35 / 障碍 25 / 沼泽 −1000）减距离挑目标，另有一手概率
  「收兵」：按 `tanh(邻居兵·0.015)` 的概率把邻居并进当前格，而不是自己往前走
- `oim` 有**真记忆**：看不见的敌方城/将按产兵速率推兵数；威胁是从我方将军/核心城做多源
  **反向 Dijkstra**，算得出「这股敌人 3 步后到、带 40 兵」；每个候选目标再做一次反向加权
  Dijkstra 找真实出兵格和拥挤度，乘「兵够了没有」的阈值奖励；将军留兵 / 核心区压力 /
  咽喉格 / 回撤流四项进守备需求，直接作为硬否决
- `kutu` 把局面压成四张图（敌方压力 / 我方压力 / 储备兵 / 路径流+核心区+咽喉），
  三档（4/5/14 步）威胁反向 Dijkstra 选最急那一路，目标候选分五桶（防守/强攻/拿城/施压/探雾）
  各限额，每个目标再算走廊支援与所需兵力，另有一套经济规划器（5 个最厚堆各做正向 Dijkstra）
  直接选「目标+首步」
- `xiaruize` 是**多源并行比价**：6 个出兵源各建一张带成本的路线图，全局比「第一步值不值」，
  所以找敌将效率高，但节奏慢（平均 373 回合、8.8% 和棋）

**强档把我们打下去了。** 480 局、真实迷雾、6 个强对手，**合计 41.0%**。

规则按真实对局走：每回合 将军 +1 / 城市 +1、每 25 回合全格 +1、**每方每回合 1 步**、
一格一回合只能动一次、打出去的兵留 1 个在家、吃掉对方将军即胜、1000 回合未分胜负算和。
每个种子打两局（先后手互换），每个对手 80 局。

**走子顺序固定按玩家下标**（`[0, 1]`），和服务器 `getPlayerMovesPriorityV2` 一致。
之前按「我方先走」排，等于每一局都在让先——后手能看着你先走那一步回应。实测先手方
在已分胜负的局里只赢 42.6%，这是一笔白送出去的 7 个点。

**所有跑分默认都是迷雾**，全视野是作弊版，只有显式写 `GB_FOG=0` 才给。

完整结果在 [`PK.md`](PK.md)（`node scripts/pk-report.js 40` 生成）：

| 对手 | 局数 | 胜 | 负 | 和 | 胜率 | 平均回合 | 我方地 | 对方地 | 我方兵 | 对方兵 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gc` | 80 | 40 | 39 | 1 | 50.0% | 202 | 71 | 67 | 427 | 350 |
| `szly` | 80 | 32 | 48 | 0 | 40.0% | 243 | 57 | 88 | 283 | 707 |
| `zlyv21` | 80 | 41 | 39 | 0 | 51.2% | 239 | 75 | 69 | 486 | 533 |
| `xiaruize` | 80 | 42 | 31 | 7 | 52.5% | 373 | 69 | 44 | 696 | 408 |
| `kutu` | 80 | 24 | 52 | 4 | **30.0%** | 449 | 27 | 119 | 235 | 1512 |
| `oim` | 80 | 18 | 56 | 6 | **22.5%** | 447 | 32 | 109 | 335 | 1382 |
| **合计** | **480** | **197** | **265** | **18** | **41.0%** | | 55 | 83 | 410 | 815 |

镜像对照 80 局：34 胜 34 负 12 和，已分胜负里 50.0%——同一份代码打自己一半一半，
说明擂台、先后手、迷雾都没有系统性偏向。

读法：

1. **能打过的是三个「一步一算」型**（`gc` / `zlyv21` / `xiaruize` 都在 50% 上下）。
   它们的共同点是只看当前这一步的性价比，没有跨回合的记忆和时序。
2. **打不过的是两个「有记忆 + 有守备」型**（`kutu` 30.0%、`oim` 22.5%），终局是
   32 地对 109 地、335 兵对 1382 兵——被运营碾了，不是被斩首。
3. **`szly`（40.0%）输在发育**：88 地对 57 地、707 兵对 283 兵。它靠块价值图一路吃厚，
   我们的单栈 focus 只看「到目标几步」，不看「这条路值不值」。
4. 上一轮那 82.9% 是假的：合计里塞了五个在迷雾下几乎不动的对手。**去掉它们就剩 41.0%**，
   这才是当前引擎的真实水位。

参数层面已经试过了，调不动：`genWeight` 0.75 / 0.5 / 0.2 对 `gc` 是 36.7% / 45.8% / 49.2%，
对 `szly` 是 34.2% / 41.7% / 40.8%——现默认 0.2 已经是最优。`genSafe`、`genSendMin`、
`killRatio`、`purge`、`memTtl` 全部落在噪声里。**差距是结构性的。**

单变量扫描用这个（对指定对手）：

```powershell
node scripts/sweep.js 60 gc,szly,oim
$env:GB_SWEEP='{"genWeight":0.5}'; node scripts/sweep.js 60 oim
```

### 镜像 A/B：唯一能证明「变强了」的对照

打参考 bot 只会告诉你「它们更菜」。所以加了 `scripts/ab.js`：**同一份代码、同一个种子，
两边参数不同，对打**。胜率 50% 就是没差别；先手劣势靠「每组种子跑两遍、交换先手」抵消。

```
$ node scripts/ab.js 100     # 候选 = 现默认，基线 = 上一版默认 {"lateFreeze":true,"genWeight":0.6}
  胜 121 / 负 53 / 和 26   已分胜负里 69.5%     # 迷雾 200 局
```

## 将军何时出门

上一版这里是「将军攒到 6 兵才出门」，6 是手调出来的，没有依据。这一轮把 GitHub 上
能找到的实现都读了一遍，出门判据一共四种范式：

| 范式 | 代表 | 判据 |
| --- | --- | --- |
| 盈余型 | strakam/hunter | `军队 ≥ 2 × GARRISON(4)` 就出，且**只送一半** |
| 威胁型 | harrischristiansen | `needed = min(威胁+2, 0.5×总兵)`；`army − ⌊army/2⌋ ≤ needed` 就锁死 |
| 折扣型 | LocalGen GcBot / Szpadel | 将军兵打 75 折或 1/8 折参与竞选，要赢过别的堆才动 |
| 相位型 | flo-lan / 本引擎 | 按时间窗开关 |

四种都试过，结论是**折扣型在这条规则下最好，威胁型直接有害**：

| 实验 | 结果（迷雾镜像，已分胜负口径） |
| --- | --- |
| 将军权重 1.0（当普通兵源用） | 42.6% |
| 将军权重 0.6（上一版） | 50.0% |
| **将军权重 0.3** | **58.5%** |
| **将军权重 0.2（现默认）** | **60.3%** |
| 将军权重 0.15 | 60.5% |
| 将军权重 0（彻底不出兵） | 12.5%，崩盘 |
| 守备需求公式开着（威胁型） | 全视野 84.5% vs 关掉 89.0%；对 hunter 78.8% : 88.8% |
| 将军后期封存开着（旧默认） | 62.8%（迷雾）/ 40.5%（全视野） |

读法：

1. **两头都崩。** 权重 0 时将军彻底不动，开局只有它有兵，主推力直接消失（12.5%）。
2. **当普通兵源用也输**（1.0 → 42.6%），因为它一出门就是把胜负手往前线挪。
3. **0.2 的意思是「将军是最后一支被调动的部队」**：同样厚的堆里普通格优先，只有当
   别的兵堆都推不动时，主纵队的来源才轮到将军。它是预备队，不是主力。
4. **威胁型公式在这个场地里是有害的**，虽然公式本身没错。`garrison_needed` 抬高的是
   「将军不出门」的门槛，而这条规则下将军 +1/半回合是开局唯一的稳定兵源——把将军
   按住等于把主推力关掉。harrischristiansen 的 bot 扛得住，因为它有别的地盘产能。
   代码保留成开关（`garrison: true`），默认关。
5. **「后期封存将军」是打弱 bot 打出来的假结论。** 打参考 bot 时 480 tick 封存和不封存
   都是 92.5%，因为那些 bot 根本惩罚不了将军不出门；镜像 A/B 里一开就掉到 40.5%。

演进（每格 80 局，全视野口径，参考 bot 只用 strakam 那三个 + harvester）：

| 对手 | Dijkstra + 最大流 | 单栈 focus | 加威胁模型 + 召回 | 加清剿 + 视野线 |
| --- | --- | --- | --- | --- |
| random | 85.0% | 100% | 100% | 100% |
| expander | 73.8% | 97.5% | 98.8% | 97.5% |
| hunter | 30.0% | 72.5% | 82.5% | 82.5% |
| harvester | 30.0% | 72.5% | 82.5% | 82.5% |
| 合计 | 54.7% | 85.9% | 90.9% | 90.6% |

四轮做的事：

1. **不扩张，只养一条链**，每回合把最重的那堆朝单一 focus 推一格（→ 85.9%）
2. **威胁判断改用「到达兵力」**：`armies - dist > ga + dist`，而不是「当前比我厚」。原来每送一次兵将军变薄就触发并兵、下一回合又被推出去，两个回合白走一趟；这一步同时消掉了那个来回搬兵的振荡（→ 90.3%）
3. **并兵召回半径覆盖整个预警圈**（5 → 8 步），让远处的兵也能赶回来（→ 90.9%）
4. **清剿内部飞地 + 斩首要 1.5 倍 + 将军不进敌方视野**（→ 90.6%，在统计误差内持平，但清剿单项 +2.5%）

第五轮（这一轮）做的是**把迷雾模型改对，然后重新测所有将军规则**，结果见上面两节。
迷雾那一栏从 52.8% 变成 97.5% 不是算法变强了，是**模型变对了**：旧模型里两边都有
「最后已知状态」的记忆和全图城市，参考 bot 靠那份记忆追着我们打；真实服务器不给记忆，
它们就只会瞎推。

结论：

1. **输的原因从来不是扩张算法不够好，是每回合只有一步却想同时做十件事。** 旧引擎用 Dijkstra 满地图挑目标、用最大流把后排兵摊给所有缺口——账面上每一步都合理，合起来是兵永远散在通往目标的路上，每格 1 兵，被 hunter 的单条纵队逐个吃掉。
2. **改成「搬最重的那一堆」之后，同一批代码的胜率翻了 2.4 倍。** 没有新增任何评估函数，只是把"选哪一格出兵"从按距离改成按兵力。
3. **振荡比不会算更致命。** 一个格子的兵被推出门、再被"预警"召回，一个来回白烧两个回合，还让将军永远攒不厚。这类问题在数据上只表现为"打不过"。
4. **「将军不出门」是有价格的，而且比想象中贵。** 将军格的兵只能跟着将军走——这是规则，没有「只搬兵不搬将军」的操作。所以将军一封存，它的兵就锁死了。
5. **同一个配置，两种测法能差出 50 个点。** 打参考 bot 时「将军封存 480 tick」和「不封存」都是 92.5%，看着毫无区别；换成镜像 A/B，封存那一边只剩 40.5%。**弱对手验证不了任何东西**——这是这一轮最大的教训，也是 `scripts/ab.js` 存在的理由。
6. **迷雾里我们赢的是「不会玩迷雾的对手」，不是「会玩迷雾」。** 五个移植里没有一个在
   迷雾下做任何事。真正的问题是：对面也是会记位置、会绕黑区的 bot 时怎么办。这一条
   还没答案，`ladder` 在全视野能赢我们 28.7%，是对手质量的下限参考。

试过但**没有变好**、已经回退的：

| 实验 | 结果 |
| --- | --- |
| 开局前 8 回合放宽将军出兵 | 72.5%（兵被摊薄） |
| 把敌方地块当墙绕行 | random 掉到 **5%**，开阔图传不过去 |
| 预警半径放大到 6 步 | 47.5%（并兵太频繁，抽干前线） |
| 将军出门阈值 8 / 5 | 72.5% / 77.5%，只有 6 能到 87.5% |
| 敌人 5 步外不迎击、先吃城 | 2.5%（等于放弃战场） |
| 早期每回合把将军抽 1 兵出门 | 89.1%（将军永久变薄）；改成攒 3/4/5 兵再出是 88.8% / 89.4% / 88.1%，都不如不抽 |
| 早期 focus 改成「先拿最近的城」 | **10%**（46 地 221 兵，全被 hunter 斩首） |
| 边境掠食：吃掉比我们薄的敌格 | 88.4% vs 89.1%，每吃一块就占掉一条命令，主纵队少推一格 |
| 将军出门阈值 4 / 8（新版权重下） | 52.9% / 51.4%，和 6 在误差内 |
| 守备需求公式（harrischristiansen） | 全视野 84.5% vs 关掉 89.0%，将军被按住就没了主推力 |
| 将军后期封存 | 迷雾 62.8%，全视野 40.5% |



## 已知限制

- 回放/观战不动手（`gameOver`、`playerIndex < 0` 直接跳过）。
- **迷雾是数据层的，扩展绕不过去。** 服务器在 `sendGameUpdate` 里就把不可见格写成 `TILE_FOG`、兵数抹 0，敌将位置给 `-1`。扩展跑在 MAIN world 读到的已经是过滤后的 `map`，看到的和人一样多（见上面「迷雾」一节）。
- 因为看不到迷雾里的敌人，`defendWarn` 的威胁判断和 `denemy` 的距离场都只对**已知**敌格有效。敌人从黑区推出来时，预警会晚一步。
- **看不见的城市和山长得一样。** 服务器把不可见的城市写成 `TILE_FOG_OBSTACLE`，和山同一个值。所以「哪儿有城」是一格一格探出来的，不是读出来的；`cities` 表里只有当前看得见的城。
- `lookout` / `observatory` 当作可通行普通格，没做加成建模。
- 只在 Edge / Chrome 111+ 生效。

## AverageJoe 能不能直接用

[AverageJoe](https://github.com/strakam/AverageJoe) 是自对弈 RL 练到 generals.io 天梯第一的 bot。
把它的网络搬进扩展这件事，我把前向整个移植过来了（`src/net/`），结论是**网络搬不动，行为搬得动**。

挡路的三件事，按致命程度排：

1. **权重没公开。** 仓库只有 3 个 commit、没有 release、HuggingFace 上也没有对应的 checkpoint；
   README 说的是「一条命令复现」，即 `python main.py --config configs/custom/L_7d_gae90.yaml`
   自己训：512 个环境 × 512 步 × 10 万轮迭代，单卡按周算。没有权重，网络就是个空壳。
2. **纯 JS 推理太慢。** `node scripts/bench-net.js` 实测（本机，Node 24，单线程）：

   | 配置 | 参数 | 等效计算量 | 单次前向中位 | 一回合 1s 内能做几次 |
   | --- | --- | --- | --- | --- |
   | L（官方发布版：pad 24 / patch 3 / embed 448 / depth 7） | 15,351,633 | 982.6 MMACs | 666 ms | 1 |
   | S（`configs/S.yaml`：pad 12 / patch 2 / embed 352 / depth 4） | 4,994,116 | 162.2 MMACs | 112 ms | 8 |

   观测增强（38 通道）只要 0.2 ms，可以忽略。666 ms 意味着浏览器主线程每回合卡一次，
   掉帧、可能漏回合——不能这么跑。
3. **游戏规则对不上。** 它训练的 env 一回合只下一个动作（`[pass, row, col, dir, split]`），
   我们这边一回合下 6 个 attack；观测是 1v1 双人（只有一条对手通道），FFA 喂不进去；
   `pad_to 24` 也只覆盖 17–23 格的图。

所以能搬的是它的**行为特征**。「在复杂局面里把兵流动起来」是它最显眼的一手，这一手不用神经网络也能做：
现在阶段 D 的分层最大流（`src/flow.js`）就是照这个思路重写的，A/B 里确实比原来的单目标推土机快
（见上一节）。

真要把它跑起来，缺的是权重和算力，不是代码：`src/net/weights.js` 已经把参数清单
（名字 / 形状 / 扁平偏移）留好了，拿到 `.eqx` 后写个转换脚本（Equinox 的 `nn.Linear`
是 `[in, out]`，这里按 `[out, in]` 存，要转置一次）灌进去，再把 `linearBatch` 换成 WebGPU 的
matmul——1.97 GFLOP 扔给核显是几毫秒的事。这两步都得有权重才有意义，所以没做。

## 参考

GitHub 上同类的 generals.io 项目（都是走 `botws.generals.io` 的独立客户端，本扩展是页面内旁路）：

- <https://github.com/strakam/generals-bots> — Python bot 框架，官方 bot API 的事实标准（本项目的策略骨架来源）
- <https://github.com/strakam/AverageJoe> — 自对弈强化学习练出来的超人类 bot
- <https://github.com/harrischristiansen/generals-bot> — Python 自动客户端
- <https://github.com/vzhou842/generals.io-Node.js-Bot-example> — 官方教程示例，地图增量协议出处
- <https://github.com/Szpadel/generalsAI> — TypeScript 实现
- <https://github.com/flo-lan/generals.io-Bot> — JS 实现
