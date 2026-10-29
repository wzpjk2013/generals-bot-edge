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

**A. 斩首** — 贴脸的敌方将军且 `我方兵力-1 > 守军`，直接吃，对局当场结束。

**B. 守将** — 将军被贴脸且兵力不如对方时，依次尝试：将军反打 → 最强邻居代打 → 把最强邻居并进将军硬扛。

**C. 扩张（主力）** — 每轮在整张图上跑 Dijkstra：

- 源点是全部我方格，代价 `cost` = 沿路径累计的 `(守军 + 1)`，也就是「打到这格要花多少兵」
- 目标打分 `价值 / (1 + cost)^0.85`，再乘风险系数：

  | 目标 | 价值 |
  | --- | --- |
  | 敌方将军 | 60 |
  | 城市 | 6 |
  | 敌方地块 | 3 |
  | 空地 / 迷雾 / 中立 | 1 |

- 风险系数：落点旁边有比我们更厚的敌兵 ×0.55；需要用将军出兵且将军兵少 ×0.5
- 选中目标后沿 `prev` 链一次性推进（单回合最多 4 步，允许链式连吃），然后重新算一轮，直到步数预算用完
- 代价相同时优先让兵最多的那格出兵，将军不跑腿

**D. 输兵（`src/flow.js`）** — 吃不动之后，用分层最大流把后排兵力送到缺口：

- `d[i]` = 从我方地格到前沿（贴着能打的非我方格）的步数，只走我方地格
- 把每个参与运输的地格拆成 in/out 两个节点建 Dinic：源点 → in、in → out 的容量都是 `army-1`（一格一回合最多能过多少兵），out → 邻居 `d-1` 的边容量无限，前沿格 → 汇点的容量是缺口（打穿那格至少要 `守军+1`）
- 解出来的每条边流量就是这一回合该往哪个邻居推；自己没流量但身后堵着兵的格子，朝 `d-1` 里兵最多的邻居走——一步只能走 6 次，整条管道要一起挪
- 先集中喂一个目标（`focus`，由「敌将 > 最近敌方 > 最远迷雾」选出），集中模式没得可流再退到全图分摊
- 全都流不动（比如前线被山挡死）才用老的推土机兜底

往自己的格子并兵永远合法（只损耗 1 兵），旧版本把「两堆等量兵合流」当成非法，
导致兵力根本流不动——这条是换输送器时暴露出来的。

这套结构对应参考实现里的两个 agent：
[`hunter_agent.py`](https://github.com/strakam/generals-bots/blob/master/generals/agents/hunter_agent.py)
（守家 / 输兵 / 斩首）和
[`expander_agent.py`](https://github.com/strakam/generals-bots/blob/master/generals/agents/expander_agent.py)
（边境吃掉一切能吃的），C 段用 Dijkstra 取代了它们的「只看相邻格」，能绕山、能跨城规划路线。

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
test/bot.test.js        决策与状态还原的离线回归（15 条）
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
```

## 测

```bash
node test/bot.test.js        # 15 条离线断言，含 20 回合自对局合法性
node test/flow.test.js       # 输送器：走廊 / 双前线 / 绕山 / 不动将军 / 合法性
node test/net.test.js        # 网络移植：形状、掩码、patch 映射、确定性
node scripts/bench.js        # 单回合决策耗时 + 200 回合扩张率（每回合 1 步）
node scripts/bench-ab.js     # 推土机 vs 最大流：打穿硬骨头的回合数
node scripts/bench-budget.js # 反事实实验：每回合给 N 条命令会怎样（非真实赛制）
node scripts/bench-net.js    # AverageJoe 单次前向延迟（L / S 两档）
node scripts/arena.js 40     # 与参考 bot 的 320 局 PK（每格 40 种子 × 先后手）
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
  random         80   68    0   12   85.0%     364      82     32    1101     898
  expander       80   59    5   16   73.8%     399      71     93     810    1921
  hunter         80   24   56    0   30.0%     175      27     16     157      68
  harvester      80   24   56    0   30.0%     176      26     16     157      71

总计 320 局：胜 175 / 负 117 / 和 28，胜率 54.7%
```

三条结论：

1. **对 hunter / harvester 是 30%，被反打。** 它们只做一件事：把兵攒在一条线上往前
   推。真实经济下兵源只有将军和城市，而蛇的形态刚好就是把所有产出集中到一点，所以我们
   那种「向四周各推一个薄片」的扩张在真实规则下是纯亏——薄片不产兵，只会被逐个吃掉。
2. **对 random / expander 靠目标选择赢。** Dijkstra 能绕山、能挑价值目标，而 expander
   只看相邻格。共 28 局拖到 1000 回合没打完（和棋），说明收尾能力不够。
3. 上一版 README 里的 6 步/回合数据是**反事实**：服务器根本不会在同一回合执行两条，
   那些数字只说明「假如能下多条命令会怎样」，不能当对局胜率引用。多预算对照实验留在
   `scripts/bench-budget.js`。

已知要改的：引擎的优先级建立在「地盘变多 → 兵变多」这个错误前提上。真实规则下应该
**优先抢城市（唯一的地盘类兵源）**、把兵留在将军和主纵队上、扩张只为连接和视野服务。
这不是调参，是把 phase C 的 Dijkstra 打分函数整个换掉。

## 已知限制

- 回放/观战不动手（`gameOver`、`playerIndex < 0` 直接跳过）。
- 迷雾里的格子按守军 0 估算，这是所有 generals.io 机器人的共同假设。
- 只看当前视野：敌方将军一旦离开视野就丢跟踪，不会记忆历史位置。
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
