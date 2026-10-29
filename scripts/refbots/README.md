# refbots/ — 从 LocalGen-new 移植过来的对手

本目录的每个 `.js` 文件会自动注册成同名对手（`scripts/refagents.js` 启动时扫描），
所以加对手不用改任何现有文件，也不会和别人撞车。

## 契约

文件导出**一个构造函数**（`module.exports = class Foo { ... }`），
实例只需要一个方法：

```js
plan(view) -> { from, to, split } | null
```

- 每次调用返回**一条**动作（真实赛制：每方每回合 1 条）。
- `null` / `undefined` = 这回合不动作。
- `split: true` 表示走一半兵（`Math.floor(armies / 2)`），和官方 `attack(from, to, is50)` 一致。
- `from` / `to` 必须是**相邻**的四邻格下标（`to` 可以越界？不可以，越界直接算非法）。
- `from` 必须是自己的格子。

构造函数会收到 `rng()`（`() => [0,1)` 的确定性随机源，同一个 seed 结果可复现），
随机走子必须用它，否则同一个 seed 打不出同一局、A/B 结果不可比。

## view 字段

```js
view = {
  w, h,                       // 20 x 20
  armies: Int32Array(N),      // 兵数；迷雾里没看见的格是 0
  owner: Int16Array(N),       // 格子归属：>=0 是玩家下标，负数见下面 T
  cities: Uint8Array(N),      // 1 = 自己**看得见**的城市
  mountains: Uint8Array(N),   // 1 = 障碍（山，或迷雾里看不见的城——区分不出来）
  generals: [g0, g1],         // 看不见的对手将军是 -1
  me,                         // 自己在这一局里的玩家下标，0 或 1
  general                     // 自己将军的下标
}
```

`owner` 里的负数常量：

```
T.EMPTY = -1, T.MOUNTAIN = -2, T.FOG = -3, T.FOG_OBSTACLE = -4,
T.LOOKOUT = -5, T.OBSERVATORY = -6
```

注意：**迷雾是真的**。对手看到的和你我一样——只有自己领土的 3×3 范围，
看不见的城市在 `owner` 里是 `T.FOG_OBSTACLE`、和山长得一模一样，
没见过的敌将 `generals[q] === -1`。原版 C++ bot 是在全视野下写的，
所以移植时凡是「按 id 查地图」的地方都要先过 `owner[i] < 0` 这道闸。

## 移植约定

- 原版是 LocalGen 框架里的 `Bot::play()`：**一个 tick 里可以下多步**。这里改成一调用一步，
  所以内部状态机（当前目标、上次位置、路线）跨调用保留在 `this` 上，不要每步重算。
- 原版用 `turn`（tick 计数）做阶段判断，框架没给。按 `plan()` 被调用次数自增一个
  `this.turn`（`gc` / `szly` 的移植就是这么做的）。
- 原版常把「全图扫一遍」放在初始化里。这里地图会随视野变化，扫描放到 `plan()` 里按需做，
  但记得缓存，别每回合重建整张图（一次 PK 是几百局 × 上千回合）。
- RNG 一律用传入的 `rng`。

## 自测

```powershell
$env:GB_BOT='你的文件名不带 .js'; node scripts/refbots/smoke.js 20
```

会打印这个 bot 对 `gc` 的胜率 / 平均回合 / 终局地盘兵力。跑得动、不报错、胜负分布合理
（不是 100% 也不是 0%）才算移植成功。

## 原始出处

`https://raw.githubusercontent.com/SZXC-WG/LocalGen-new/master/src/bots/<文件名>.cpp`
