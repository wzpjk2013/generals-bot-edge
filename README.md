# Generals AutoPilot（Edge / Chrome 扩展）

generals.io 的浏览器端机器人：读对局状态 → 每回合决策 → 用官方前端自己的 socket 下发 `attack`。
不修改服务器，不注入游戏文件，纯页面内旁路。

## 装

1. 打开 `edge://extensions`
2. 打开「开发人员模式」
3. 「加载解压缩的扩展」→ 选中本目录（含 `manifest.json` 的那一层）
4. 打开 <https://generals.io/>，右上角出现面板

Chrome 同理（`chrome://extensions`）。需要 Chromium 111+：`content_scripts` 用了 `"world": "MAIN"`。

## 用

- 进对局就接管：公开匹配、自建房间一视同仁，不需要额外开关。
- 面板上有总开关、每回合步数上限（1–20，默认 6），实时显示回合、地块/兵力、已走步数、最近一次走子。
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

下子走官方同一个 emit：`socket.emit('attack', from, to, false, turn)`——事件名由官方包装层压成协议下标，
不用维护协议表，也不用绕 bot 服务器。

## 怎么决策（`src/bot.js`）

每回合（turn）跑一次，按固定优先级出子，全部在本地乐观状态上提交，保证一格一回合只动一次：

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
```

## 测

```bash
node test/bot.test.js        # 15 条离线断言，含 20 回合自对局合法性
node test/flow.test.js       # 输送器：走廊 / 双前线 / 绕山 / 不动将军 / 合法性
node test/net.test.js        # 网络移植：形状、掩码、patch 映射、确定性
node scripts/bench.js        # 单回合决策耗时 + 200 回合扩张率
node scripts/bench-ab.js     # 推土机 vs 最大流：打穿硬骨头的回合数
node scripts/bench-net.js    # AverageJoe 单次前向延迟（L / S 两档）
node scripts/e2e-check.js    # 需要本机 Edge，自动起 headless
node scripts/e2e-pipeline.js # 未打包加载 + 合成对局，断言 attack 参数形状
```

当前基准（本机，32×32 带山与 12 座城）：

```
总走子     1052（平均 5.3/回合）
单回合平均 0.66 ms
已占地图   897/1024（87.6%）
```

A/B（`bench-ab.js`，200 回合，指标是那块硬骨头被打穿的回合数，越小越好）：

```
围死的三个口子   推土机 24/29/38   →  最大流 20/28/36
32x32 常规开局   推土机 151/151/168 → 最大流 147/147/157
单回合耗时       0.08 ms / 0.09 ms，0.55 ms / 0.49 ms
```

`e2e-pipeline` 用 `GB.feed(name, payload)` 注入——和 socket 订阅走同一份 handler，不用真进对局。

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
