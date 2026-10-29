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

**D. 输兵** — 一个可吃目标都没有时，按「敌将 > 最近的敌方地块 > 最远的可探索格」选一个目标，
从目标反向 BFS 出步数场，把最厚的堆朝目标推一格。

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
src/hook.js             socket 劫持 / 回合驱动 / Shadow DOM 面板
src/bridge.js           隔离世界：chrome.storage 读写设置
test/bot.test.js        决策与状态还原的离线回归（15 条）
scripts/cdp.js          极简 CDP 驱动（零依赖）
scripts/e2e-check.js    真机冒烟：扩展加载、socket 捕获、面板挂载
scripts/e2e-pipeline.js 全链路：注入对局 → 机器人下发 attack
scripts/bench.js        32x32 跑 200 回合的耗时与扩张基准
```

## 测

```bash
node test/bot.test.js        # 15 条离线断言，含 20 回合自对局合法性
node scripts/bench.js        # 单回合决策耗时 + 200 回合扩张率
node scripts/e2e-check.js    # 需要本机 Edge，自动起 headless
node scripts/e2e-pipeline.js # 未打包加载 + 合成对局，断言 attack 参数形状
```

当前基准（本机，32×32 带山与 12 座城）：

```
总走子     1052（平均 5.3/回合）
单回合平均 0.58 ms
已占地图   897/1024（87.6%）
```

`e2e-pipeline` 用 `GB.feed(name, payload)` 注入——和 socket 订阅走同一份 handler，不用真进对局。

## 已知限制

- 回放/观战不动手（`gameOver`、`playerIndex < 0` 直接跳过）。
- 迷雾里的格子按守军 0 估算，这是所有 generals.io 机器人的共同假设。
- 只看当前视野：敌方将军一旦离开视野就丢跟踪，不会记忆历史位置。
- `lookout` / `observatory` 当作可通行普通格，没做加成建模。
- 只在 Edge / Chrome 111+ 生效。

## 参考

GitHub 上同类的 generals.io 项目（都是走 `botws.generals.io` 的独立客户端，本扩展是页面内旁路）：

- <https://github.com/strakam/generals-bots> — Python bot 框架，官方 bot API 的事实标准（本项目的策略骨架来源）
- <https://github.com/strakam/AverageJoe> — 自对弈强化学习练出来的超人类 bot
- <https://github.com/harrischristiansen/generals-bot> — Python 自动客户端
- <https://github.com/vzhou842/generals.io-Node.js-Bot-example> — 官方教程示例，地图增量协议出处
- <https://github.com/Szpadel/generalsAI> — TypeScript 实现
- <https://github.com/flo-lan/generals.io-Bot> — JS 实现
