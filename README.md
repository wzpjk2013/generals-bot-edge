# Generals AutoPilot（Edge / Chrome 扩展）

generals.io 的浏览器端机器人：读对局状态 → 每个半回合决策一步 → 用官方前端自己的 socket 下发 `attack`。
不修改服务器，不注入游戏文件，纯页面内旁路。

## 装

1. 打开 `edge://extensions`
2. 打开「开发人员模式」
3. 「加载解压缩的扩展」→ 选中本目录（含 `manifest.json` 的那一层）
4. 打开 <https://generals.io/>，右上角出现面板

Chrome 同理（`chrome://extensions`）。需要 Chromium 111+：`content_scripts` 用了 `"world": "MAIN"`。

## 用

- 进对局就接管：公开匹配、自建房间一视同仁，不需要额外开关。
- 面板上有总开关、每半回合步数（1–2，默认 1），实时显示回合、地块/兵力、已走步数、最近一次走子。
- 关掉总开关随时手动接管。

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
- **将军攒够了才出门**：目标是没有守军的空地时 2 兵就走（这就是「将军向外推兵」的实际形态，沿 BFS 路径顺手把空地占了），目标有敌人时要攒到 `GENERAL_SEND_MIN = 6`。将军每回合 +1，是唯一的稳定兵源，抽干了就没得补
- **将军不进敌方视野**：将军每一步都必须留在「离最近敌格 ≥ `GEN_SAFE = 2`」的位置。对手能看见的 = 他的领土 + 邻接一圈，所以 2 步刚好在视野外，1 步就已经被看见（见下面的迷雾一节）。打贴脸的敌人不受这条限制
- **将军三阶段**：早期 `[0, 50)` tick 发育；中期 `[50, 480)` 正常当兵源；后期 `480+` 封存，将军只吃不吐，推进全交给地块兵
- **将军留底**：从将军出兵要留下 `min(6, 一半)`；将军隔壁有敌人时**只准直接打它**，别的方向一律不出兵——将军被吃得手整局就结束
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
test/bot.test.js        决策与状态还原的离线回归（16 条）
test/flow.test.js       输送器回归（8 条）
test/net.test.js        网络移植回归（11 条）
scripts/cdp.js          极简 CDP 驱动（零依赖）
scripts/e2e-check.js    真机冒烟：扩展加载、socket 捕获、面板挂载
scripts/e2e-pipeline.js 全链路：注入对局 → 机器人下发 attack
scripts/bench.js        32x32 跑 200 回合的耗时与扩张基准
scripts/bench-ab.js     推土机 vs 最大流的 A/B
scripts/bench-net.js    AverageJoe 网络单次前向延迟
scripts/refagents.js    参考 bot 移植（random / expander / hunter / harvester）
scripts/arena.js        与参考 bot 的 1v1 擂台
scripts/idle-stats.js   空转率统计（整回合一条命令都没出的比例）
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
node scripts/arena.js 40     # 与参考 bot 的 320 局 PK（每格 40 种子 × 先后手）
node scripts/idle-stats.js hunter 40   # 空转率：整回合一条命令都没出的比例
node scripts/e2e-check.js    # 需要本机 Edge，自动起 headless
node scripts/e2e-pipeline.js # 未打包加载 + 合成对局，断言 attack 参数形状
```

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

### 迷雾：有，但只是渲染层

所有模式都有视野限制，1v1 也有。但官方客户端的迷雾是**纯渲染遮罩**，不是数据过滤：

```js
this.rawVisible = this.map.computeVisibility(this.lights, this.cities, this.generals, this.turn)
```

拿到可见性掩码后，渲染时按当前视角过滤：

```js
!f || f[Dt] & e.pov || (Ht = ... ? TILE_FOG : TILE_FOG_OBSTACLE);
```

也就是说 `map` 数组本身永远是完整真相，`computeVisibility` 算出「这一格谁能看见」，
看不见的格子只是被**画成** `FOG` / `FOG_OBSTACLE`。这也是回放里能随便切 `replay_pov`
的原因——数据本来就在。本扩展跑在 MAIN world，读的就是完整 `map`，所以引擎的输入
是全图。

两个后果：

1. `scripts/arena.js` 用全视野是**对的**——它模拟的正是引擎的视角。
2. 「不让将军进敌方视野」要按**对手**的可见范围算：`他的领土 + 邻接一圈`。所以
   `GEN_SAFE = 2`（离最近敌格至少 2 步）才是安全线，1 步就已经被看见了。

## PK：和参考 bot 打

`scripts/arena.js` 起一个 20×20 全视野 1v1 的擂台，对手是
[`generals-bots`](https://github.com/strakam/generals-bots) 里四个 agent 的 JS 移植
（`scripts/refagents.js`，BFS 步数场 / 方向场 / 斩首优先级 / 城市当墙这些判定全部照抄）。

规则按真实对局走：每回合 将军 +1 / 城市 +1、每 25 回合全格 +1、**每方每回合 1 步**、
一格一回合只能动一次、打出去的兵留 1 个在家、吃掉对方将军即胜、1000 回合未分胜负算和。
每个种子打两局（先后手互换），每格 80 局。

```
== 真实赛制：每方每回合 1 步 ==
  对手          局数   胜   负   和    胜率   平均回合   我方地  对方地  我方兵  对方兵
  random         80   80    0    0  100.0%      64      19     12      60      53
  expander       80   78    0    2   97.5%      91      19     36      79     293
  hunter         80   66   12    2   82.5%     123      18     11      58      44
  harvester      80   66   12    2   82.5%     123      18     11      58      44

总计 320 局：胜 290 / 负 24 / 和 6，胜率 90.6%
```

同一批种子下的四轮演进（每格 80 局）：

| 对手 | Dijkstra + 最大流 | 单栈 focus | 加威胁模型 + 召回 | 加清剿 + 视野线 |
| --- | --- | --- | --- | --- |
| random | 85.0% | 100% | 100% | **100%** |
| expander | 73.8% | 97.5% | 98.8% | **97.5%** |
| hunter | 30.0% | 72.5% | 82.5% | **82.5%** |
| harvester | 30.0% | 72.5% | 82.5% | **82.5%** |
| 合计 | 54.7% | 85.9% | 90.9% | **90.6%** |

四轮做的事：

1. **不扩张，只养一条链**，每回合把最重的那堆朝单一 focus 推一格（→ 85.9%）
2. **威胁判断改用「到达兵力」**：`armies - dist > ga + dist`，而不是「当前比我厚」。原来每送一次兵将军变薄就触发并兵、下一回合又被推出去，两个回合白走一趟；这一步同时消掉了那个来回搬兵的振荡（→ 90.3%）
3. **并兵召回半径覆盖整个预警圈**（5 → 8 步），让远处的兵也能赶回来（→ 90.9%）
4. **清剿内部飞地 + 斩首要 1.5 倍 + 将军不进敌方视野 + 将军三阶段**（→ 90.6%，在统计误差内持平，但清剿单项 +2.5%）

结论：

1. **输的原因从来不是扩张算法不够好，是每回合只有一步却想同时做十件事。** 旧引擎用 Dijkstra 满地图挑目标、用最大流把后排兵摊给所有缺口——账面上每一步都合理，合起来是兵永远散在通往目标的路上，每格 1 兵，被 hunter 的单条纵队逐个吃掉。
2. **改成「搬最重的那一堆」之后，同一批代码的胜率翻了 2.4 倍。** 没有新增任何评估函数，只是把"选哪一格出兵"从按距离改成按兵力。
3. **振荡比不会算更致命。** 一个格子的兵被推出门、再被"预警"召回，一个来回白烧两个回合，还让将军永远攒不厚。这类问题在数据上只表现为"打不过"。
4. 剩下的 12 负几乎是同一种：**开局对冲时我方将军到接触点的路更长**，兵每走一格留 1 个，到撞点时比对方薄。这个用单栈框架很难再压。
5. **「将军不出门」是有价格的。** 将军格的兵只能跟着将军走——这是规则，没有「只搬兵不搬将军」的操作。所以将军一封存，它的兵就锁死了。实测封存阈值 240 tick 是 77.5%、320 是 85.0%、480 和完全不封存一样（92.5%）。要它留在家里守，就得接受前期战力少一大截。

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
| 将军后期封存阈值 240 / 320 tick | 77.5% / 85.0% |



## 已知限制

- 回放/观战不动手（`gameOver`、`playerIndex < 0` 直接跳过）。
- 迷雾只影响**人**看的画面：官方客户端的 `map` 是全量的，`computeVisibility` 算出掩码后只用于渲染。引擎读 `map`，所以它看到的是全图（见上面「迷雾」一节）。
- 人类玩家看不见的地方，引擎看得见——这是扩展相对人的优势，不是 bug。
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
