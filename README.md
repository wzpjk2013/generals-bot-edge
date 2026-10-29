# Generals AutoPilot（Edge / Chrome 扩展）

generals.io 的浏览器端机器人：读对局状态 → 每回合决策 → 用官方前端自己的 socket 下发 `attack`。
不修改游戏文件，不注入代码到服务器，纯页面内旁路。

## 装

1. 打开 `edge://extensions`
2. 打开「开发人员模式」
3. 「加载解压缩的扩展」→ 选中本目录（含 `manifest.json` 的那一层）
4. 打开 <https://generals.io/>，右上角出现面板

Chrome 同理（`chrome://extensions`）。需要 Chromium 111+：`content_scripts` 用了 `"world": "MAIN"`。

## 用

- 进对局后机器人自动接管走子，面板上有开关、每回合步数上限、实时回合/地块/兵力。
- **公开匹配（1v1 / ffa / 2v2 / bigteam）默认拦截**：在有人类对手的房间里自动打就是在作弊。
  要放开就点面板上的「公开对局」开关，默认值是关。
- 自建房间（Custom game，含自定义地图）不需要额外开关。
- 「每回合步数」1–20，默认 6，控制一回合最多下发几条 move。

## 怎么读到对局

官方 bundle 里没有暴露 redux store，但有两条稳定通道：

1. **socket 实例**：bundle 执行 `n.g.socket = io(...)`，也就是把 socket.io 实例挂到 `window.socket`。
   扩展在 `document_start` 用 `Object.defineProperty` 在该属性上装 setter，实例一赋值就到手，
   然后 `sock.on('game_start' | 'game_update' | 'game_over' ...)`。
2. **串行化地图**：服务端地图是

   ```
   [w, h, armies(0..n-1), terrain(0..n-1), tunnelLimits(0..n-1)]
   ```

   首帧全量，之后 `map_diff` / `cities_diff` 是增量，编码为成对的
   `(相同个数, 变化个数, ...变化值)`，和前端 `delta()/patch()` 完全一致，`src/state.js` 里复刻了一份。

terrain 取值（取自 bundle）：`-1` 空地、`-2` 山、`-3` 迷雾、`-4` 雾中山、`-5` 瞭望塔、`-6` 观测站，
`>= 0` 是玩家下标；`generals[p]` 是玩家 p 的将军所在格。

下子走的是官方同一个 emit：`socket.emit('attack', from, to, false, turn)`——事件名会被官方包装层压成协议下标，
所以不用自己维护协议表，也不用绕 bot 服务器。

## 怎么决策（`src/bot.js`，纯函数）

每个 turn 跑一次，顺序固定，每步都在本地乐观状态上提交（保证一格一回合只出一次兵）：

1. **斩首**：贴脸的敌方将军打得过就直接吃，对局当场结束。
2. **守将**：自家将军被贴脸且兵力不如对方时，依次尝试「将军反打」→「邻居代打」→「把最强邻居并进将军」。
3. **主扫描**：对所有我方格子 × 所有可通行邻格算 `价值 - 投入`，排序后逐条执行到预算上限。
   - 价值：城市 9000 / 敌将 12000 / 弱敌 500–800 / 空地 150；贴自家将军额外 +2500
   - 投入：`落子后剩余兵力 * 0.6 + 目标守军 * 0.4`，避免拿一座山头的兵去换一格空地
   - 合法性：必须 `我方兵力 - 1 > 目标守军`，和游戏规则一致
4. **兜底合兵**：一条都走不了时（周围全是打不动的），从「前线格」做多源 BFS，
   把腹地兵力沿最短路一格格推向前线，单回合只推一步。

## 目录

```
manifest.json          MV3 清单
src/state.js           串行化地图 + delta 还原 → GameState
src/bot.js             决策引擎（纯函数，离线可测）
src/hook.js            socket 劫持 / 回合驱动 / Shadow DOM 面板
src/bridge.js          隔离世界：chrome.storage 读写设置
test/bot.test.js       决策与状态还原的离线回归
scripts/cdp.js         极简 CDP 驱动（零依赖）
scripts/e2e-check.js   真机冒烟：扩展加载、socket 捕获、面板挂载
scripts/e2e-pipeline.js 全链路：注入对局 → 机器人下发 attack
```

## 测

```bash
node test/bot.test.js        # 12 条离线断言
node scripts/e2e-check.js    # 需要本机 Edge，会自己起 headless 浏览器
node scripts/e2e-pipeline.js # 未打包加载 + 合成对局，断言 attack 参数形状与公开对局拦截
```

`e2e-pipeline` 用的是 `GB.feed(name, payload)`——和 socket 订阅走同一份 handler，方便在不进对局的情况下验证。

## 已知限制

- 回放/观战不动手（`gameOver`、`playerIndex < 0` 直接跳过）。
- 迷雾里的格子按守军 0 估算，这是所有 generals.io 机器人的共同假设。
- `lookout` / `observatory` 当作可通行普通格，没做加成建模。
- 自定义地图里的特殊机关（tunnel / swamp）只用了服务器给的 `tunnelLimits`，没单独配策略。
- 只在 Edge / Chrome 111+ 生效。

## 参考

GitHub 上同类的 generals.io 机器人项目（本扩展的思路来源，但它们都是走 `botws.generals.io` 的独立客户端，
本扩展是页面内旁路，不需要 bot 服务器）：

- <https://github.com/strakam/generals-bots> — Python bot 框架，官方 bot API 的事实标准
- <https://github.com/strakam/AverageJoe> — 自对弈强化学习训练出的超人类 bot
- <https://github.com/harrischristiansen/generals-bot> — Python 自动客户端
- <https://github.com/vzhou842/generals.io-Node.js-Bot-example> — 官方教程示例，BFS 扩张起手
- <https://github.com/Szpadel/generalsAI> — TypeScript 实现
- <https://github.com/flo-lan/generals.io-Bot> — JS 实现
