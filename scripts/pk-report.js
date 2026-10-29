/*
 * 全对手 PK 报告：一次跑完所有参考 bot，输出一张可以直接贴进文档的表。
 *
 * 默认真实迷雾（服务器在数据层按视野过滤，见 README「迷雾」一节）。全视野只剩
 * 一个用途：和旧数据对比，要它得显式写 GB_FOG=0。
 *
 * 表格口径：
 *   局数   = 种子数 × 2（同一张图打两局，双方各先手一次）
 *   胜率   = 胜 / 局数
 *   分出率 = (胜 + 负) / 局数。迷雾下大量对局 1000 回合打不完，胜率会被和棋稀释，
 *            所以两项一起看
 *   地盘/兵力 = 终局我方 vs 对方
 *
 * 运行：
 *   node scripts/pk-report.js            # 每格 40 种子 = 每个对手 80 局
 *   node scripts/pk-report.js 100        # 每格 100 种子
 *   GB_FOG=0 node scripts/pk-report.js   # 作弊的全视野（只用于对比）
 *   GB_CFG='{"genWeight":0.3}' node scripts/pk-report.js   # 带参数覆盖
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { runCell } = require('./arena.js');

const seeds = Number(process.argv[2] || 40);
const fog = process.env.GB_FOG !== '0';
let engineCfg = null;
if (process.env.GB_CFG) engineCfg = JSON.parse(process.env.GB_CFG);

// 只跑有意义的对手。strakam / harrischristiansen 那五个在迷雾下几乎不动
// （它们没有迷雾处理），打出来的 97% 只证明"对手更菜"，不进合计；
// 想看它们就显式 GB_WEAK=1。
//   LocalGen-new 血统的对手：scripts/refbots/ 下每放一个文件就自动多一行。
const { listRefAgents } = require('./refagents.js');

const NOTES = {
  random: 'strakam/generals-bots — 随机合法走子',
  expander: 'strakam/generals-bots — 边境能吃的就吃',
  hunter: 'strakam/generals-bots — 守将 + 单纵队 + 斩首',
  harvester: 'strakam/generals-bots — hunter + 顺路吃城',
  ladder: 'harrischristiansen/generals-bot — 距离折扣 + 守备需求',
  gc: 'LocalGen-new — GcBot，路线估价 + 目标黏性 + 25% 分位探索',
  szly: 'LocalGen-new — SzlyBot，块价值 + 收兵概率',
  zlyv21: 'LocalGen-new — ZlyBot v2.1，双焦点防守搜索',
  zlyv3: 'LocalGen-new — ZlyBot v3，记忆感知加权搜索',
  ktq: 'LocalGen-new — KtqBot，单焦点局部贪心',
  xiaruize: 'LocalGen-new — XiaRuizeBot，多源并行路线比价',
  kutu: 'LocalGen-new — KutuBot，统一战略目标规划',
  oim: 'LocalGen-new — oimBot，记忆感知威胁/目标规划'
};

const picked = process.env.GB_OPP
  ? process.env.GB_OPP.split(',').map((s) => s.trim()).filter(Boolean)
  : listRefAgents(process.env.GB_WEAK ? 'all' : 'strong');
const OPPONENTS = picked.map((n) => [n, NOTES[n] || '本地移植（scripts/refbots/）']);

// 单独一行、不进合计：同一份代码打自己，用来检查阵营 / 先后手有没有系统性偏差
const MIRROR = ['engine', '本引擎镜像（同代码同参数，已分胜负里应为 50%）'];

const rows = [];
let G = 0;
let W = 0;
let L = 0;
let D = 0;
let landUs = 0;
let landThem = 0;
let armyUs = 0;
let armyThem = 0;

const mirrors = [];
for (const [name, note] of OPPONENTS.concat([MIRROR])) {
  const acc = runCell(name, 1, 1, seeds, engineCfg, { fog });
  if (name === 'engine') {
    mirrors.push({ name, note, acc });
    const m = acc.games || 1;
    console.log(
      '  ' + name.padEnd(10) + String(acc.games).padStart(5) + String(acc.wins).padStart(6) +
        String(acc.losses).padStart(6) + String(acc.draws).padStart(6) +
        '  已分胜负 ' + (((acc.wins / (acc.wins + acc.losses || 1)) * 100)).toFixed(1) + '%'
    );
    continue;
  }
  rows.push({ name, note, acc });
  G += acc.games;
  W += acc.wins;
  L += acc.losses;
  D += acc.draws;
  landUs += acc.ourLand;
  landThem += acc.enemyLand;
  armyUs += acc.ourArmy;
  armyThem += acc.enemyArmy;
  const pct = (acc.wins / (acc.games || 1)) * 100;
  console.log(
    '  ' + name.padEnd(10) + String(acc.games).padStart(5) + String(acc.wins).padStart(6) +
      String(acc.losses).padStart(6) + String(acc.draws).padStart(6) + pct.toFixed(1).padStart(8) + '%'
  );
}

function table(rows, totals) {
  const head =
    '| 对手 | 出处 | 局数 | 胜 | 负 | 和 | 胜率 | 分出率 | 平均回合 | 我方地 | 对方地 | 我方兵 | 对方兵 |\n' +
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n';
  const body = rows
    .map((r) => {
      const a = r.acc;
      const g = a.games || 1;
      return (
        '| `' + r.name + '` | ' + r.note + ' | ' + a.games + ' | ' + a.wins + ' | ' + a.losses +
        ' | ' + a.draws + ' | ' + ((a.wins / g) * 100).toFixed(1) + '%' +
        ' | ' + (((a.wins + a.losses) / g) * 100).toFixed(1) + '%' +
        ' | ' + (a.turns / g).toFixed(0) +
        ' | ' + (a.ourLand / g).toFixed(0) + ' | ' + (a.enemyLand / g).toFixed(0) +
        ' | ' + (a.ourArmy / g).toFixed(0) + ' | ' + (a.enemyArmy / g).toFixed(0) + ' |'
      );
    })
    .join('\n');
  const g = totals.G || 1;
  const total =
    '\n| **合计** | | ' + totals.G + ' | ' + totals.W + ' | ' + totals.L + ' | ' + totals.D +
    ' | **' + ((totals.W / g) * 100).toFixed(1) + '%**' +
    ' | ' + (((totals.W + totals.L) / g) * 100).toFixed(1) + '%' +
    ' | | ' + (totals.landUs / g).toFixed(0) + ' | ' + (totals.landThem / g).toFixed(0) +
    ' | ' + (totals.armyUs / g).toFixed(0) + ' | ' + (totals.armyThem / g).toFixed(0) + ' |\n';
  return head + body + total;
}

const totals = { G, W, L, D, landUs, landThem, armyUs, armyThem };
let mirrorRow = '';
if (mirrors.length) {
  const a = mirrors[0].acc;
  const g = a.games || 1;
  mirrorRow =
    '| `engine` | ' + mirrors[0].note + ' | ' + a.games + ' | ' + a.wins + ' | ' + a.losses + ' | ' + a.draws +
    ' | ' + (((a.wins / (a.wins + a.losses || 1)) * 100).toFixed(1)) + '% 已分胜负' +
    ' | ' + (a.turns / g).toFixed(0) +
    ' | ' + (a.ourLand / g).toFixed(0) + ' | ' + (a.enemyLand / g).toFixed(0) +
    ' | ' + (a.ourArmy / g).toFixed(0) + ' | ' + (a.enemyArmy / g).toFixed(0) + ' |\n';
}
console.log('\n' + table(rows, totals) + (mirrorRow ? '\n### 对照：镜像局\n\n' + mirrorRow : ''));

if (process.env.GB_WRITE) {
  const out = process.env.GB_WRITE === '1' ? 'PK.md' : process.env.GB_WRITE;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const md =
    '# PK 结果\n\n' +
    '视野：' + (fog ? '**真实迷雾**（服务器按视野过滤：己方格 3×3、看不见的城退化成障碍、无记忆）' : '⚠️ 全视野（作弊版，只用于对比）') +
    '\n\n赛制：20×20，每方每回合 1 步，将军 +1 / 城 +1 / 每 25 回合全格 +1，1000 回合未分胜负算和。\n' +
    '每格 ' + seeds + ' 个种子 × 先后手互换。\n' +
    (engineCfg ? '\n引擎参数覆盖：`' + JSON.stringify(engineCfg) + '`\n' : '') +
    '\n' + table(rows, totals) +
    (mirrorRow
      ? '\n### 对照：镜像局\n\n| 对手 | 出处 | 局数 | 胜 | 负 | 和 | 胜率 | 平均回合 | 我方地 | 对方地 | 我方兵 | 对方兵 |\n' +
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n' + mirrorRow
      : '') +
    '\n> 生成于 ' + stamp + '，命令：`node scripts/pk-report.js ' + seeds + '`\n';
  fs.writeFileSync(path.join(__dirname, '..', out), md, 'utf8');
  console.log('\n已写入 ' + out);
}
