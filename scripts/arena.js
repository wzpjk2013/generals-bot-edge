/*
 * 擂台：本扩展的引擎 vs strakam/generals-bots 里的参考 bot。
 *
 * 规则按 generals.io 真实对局来：
 *   - 20x20 全视野 1v1（1v1 本来就没有迷雾）
 *   - 每回合每个地格 +1，自己占的城市额外 +1（隔回合），将军当普通格
 *   - 一格一回合只能动一次；打出去的兵留 1 个在家
 *   - 吃掉对方将军即胜；1000 回合没打完算和
 *
 * 两种赛制：
 *   1 步/回合   bot API 的原生协议（参考 bot 训练时的设定），双方都只走 1 步
 *   6 步/回合   本扩展默认设置，双方都最多走 6 步（参考 bot 每回合被调用多次）
 *
 * 每个种子打两局，双方交换先后手，抵消先手优势。
 *
 * 运行：node scripts/arena.js [每格种子数]
 */
'use strict';

global.window = global;
require('../src/state.js');
require('../src/flow.js');
require('../src/bot.js');

const { makeRefAgent } = require('./refagents.js');

const GB = global.window.__GB;
const T = GB.TILE;

const W = 20;
const H = 20;
const N = W * H;
const MAX_TURNS = 1000;
const MOUNTAIN_P = 0.18;
const CITIES = 5;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function neighbors(i) {
  const out = [];
  const x = i % W;
  const y = (i / W) | 0;
  if (y > 0) out.push(i - W);
  if (y < H - 1) out.push(i + W);
  if (x > 0) out.push(i - 1);
  if (x < W - 1) out.push(i + 1);
  return out;
}

/* 八邻（含斜角）：官方 _precomputeMapVisibilityLookups 里视野是 movableLookup + 四个
 * 斜角 + 自己，也就是「己方格所在 3x3」 */
function neighbors9(i) {
  const out = [i];
  const x = i % W;
  const y = (i / W) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) out.push(ny * W + nx);
    }
  }
  return out;
}

function distField(from, passable) {
  const d = new Int32Array(N).fill(-1);
  const q = [from];
  d[from] = 0;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const j of neighbors(cur)) {
      if (d[j] !== -1 || !passable[j]) continue;
      d[j] = d[cur] + 1;
      q.push(j);
    }
  }
  return d;
}

function makeMap(rng) {
  const owner = new Int16Array(N).fill(T.EMPTY);
  const armies = new Int32Array(N).fill(0);
  const mountains = new Uint8Array(N);
  const cities = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    if (rng() < MOUNTAIN_P) {
      mountains[i] = 1;
      owner[i] = T.MOUNTAIN;
    }
  }

  const passable = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!mountains[i]) passable[i] = 1;

  // 两个将军：互相 BFS 距离 >= 9，且都在通行格上
  let ga = -1;
  let gb = -1;
  for (let tries = 0; tries < 4000 && (ga < 0 || gb < 0); tries++) {
    const a = Math.floor(rng() * N);
    const b = Math.floor(rng() * N);
    if (a === b || !passable[a] || !passable[b]) continue;
    const d = distField(a, passable);
    if (d[b] < 9) continue;
    if (d[b] > N) continue;
    ga = a;
    gb = b;
  }
  if (ga < 0) return null;

  // 城市：离将军至少 3 步，互相不挨着
  const dA = distField(ga, passable);
  const dB = distField(gb, passable);
  let placed = 0;
  for (let tries = 0; tries < 4000 && placed < CITIES; tries++) {
    const i = Math.floor(rng() * N);
    if (!passable[i] || cities[i]) continue;
    if (dA[i] >= 0 && dA[i] < 3) continue;
    if (dB[i] >= 0 && dB[i] < 3) continue;
    let adjCity = false;
    for (const j of neighbors(i)) if (cities[j]) adjCity = true;
    if (adjCity) continue;
    cities[i] = 1;
    armies[i] = 40 + Math.floor(rng() * 12);
    placed++;
  }

  owner[ga] = 0;
  armies[ga] = 1;
  owner[gb] = 1;
  armies[gb] = 1;

  return { owner, armies, mountains, cities, generals: [ga, gb] };
}

function applyMove(board, me, from, to, split) {
  if (board.owner[from] !== me) return false;
  const a = board.armies[from];
  if (a < 2) return false;
  if (from === to) return false;
  if (board.mountains[to]) return false;
  if (!neighbors(from).includes(to)) return false;
  const sent = split ? a >> 1 : a - 1;
  if (sent < 1) return false;
  board.armies[from] = a - sent;
  if (board.owner[to] === me) {
    board.armies[to] += sent;
  } else {
    const left = sent - board.armies[to];
    if (left > 0) {
      board.owner[to] = me;
      board.armies[to] = left;
    } else {
      board.armies[to] = -left;
    }
  }
  return true;
}

function makeView(board, me, fog, vis) {
  const generals = new Uint8Array(N);
  const myGen = board.generals[me];
  const enemyGen = board.generals[1 - me];
  if (myGen >= 0) generals[myGen] = 1;
  // 服务器 t.generals.map(t => mask[t] & bit ? t : -1)：看不见就是 -1
  if (!fog || vis[enemyGen]) generals[enemyGen] = 1;

  // 城市同理：cities_diff 里只下发看得见的城，其余位置在 map 里退化成
  // TILE_FOG_OBSTACLE（和山一模一样），所以客户端既不知道那是不是城，也不知道兵数。
  let cities = board.cities;
  let mountains = board.mountains;
  if (fog) {
    cities = new Uint8Array(N);
    mountains = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (vis[i] && board.cities[i]) cities[i] = 1;
      if (fog.owner[i] === T.FOG_OBSTACLE) mountains[i] = 1;
    }
  }
  return {
    w: W,
    h: H,
    armies: fog ? fog.armies : board.armies,
    owner: fog ? fog.owner : board.owner,
    cities,
    mountains,
    generals,
    me,
    general: myGen
  };
}

function syncState(S, board, pid) {
  S.terrain.set(board.owner);
  S.armies.set(board.armies);
}

/*
 * 迷雾。
 *
 * 官方服务器在 sendGameUpdate 里按视野过滤后才下发（this.map.serialized 里
 * 不可见格写成 TILE_FOG / TILE_FOG_OBSTACLE、兵数抹成 0），客户端拿到的是
 * 「当前这一回合看得见的东西」，没有任何记忆。
 *
 * 视野规则（Map.computeVisibility + _precomputeMapVisibilityLookups）：
 *   自己的每个格，加上它的 3x3（四邻 + 四个斜角）。
 *   城市不额外可见——computeVisibility 里那句 A[lights[i]] = u 是给 lights 的，
 *   不是 cities。看不见的城市在 serialized 末尾被改写成 TILE_FOG_OBSTACLE：
 *
 *     for (A = 0; A < n.length; A++) { … }
 *     for (A = 0; A < cities.length; A++) {
 *       var d = perm[cities[A]];
 *       if (f[d + u] === TILE_FOG) f[d + u] = TILE_FOG_OBSTACLE;
 *     }
 *
 *   所以「没见过的城市」在客户端眼里和山完全一样，只有站到旁边才认得出来。
 */
function makeFog() {
  return {
    owner: new Int16Array(N).fill(T.FOG),
    armies: new Int32Array(N).fill(0),
    seen: new Uint8Array(N) // 只在 bot 侧当「人脑记忆」用，参考 bot 不给
  };
}

function updateFog(fog, board, me) {
  const vis = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (board.owner[i] !== me) continue;
    for (const j of neighbors9(i)) vis[j] = 1;
  }
  for (let i = 0; i < N; i++) {
    if (vis[i]) {
      fog.seen[i] = 1;
      fog.owner[i] = board.owner[i];
      fog.armies[i] = board.armies[i];
    } else {
      // isObstacle() = 山 / 观测站 / 瞭望塔；城市不在里面，是被末尾那段单独改写的
      fog.owner[i] = board.mountains[i] || board.cities[i] ? T.FOG_OBSTACLE : T.FOG;
      fog.armies[i] = 0;
    }
  }
  return vis;
}

function landCount(board, me) {
  let c = 0;
  for (let i = 0; i < N; i++) if (board.owner[i] === me) c++;
  return c;
}

function armyCount(board, me) {
  let c = 0;
  for (let i = 0; i < N; i++) if (board.owner[i] === me) c += board.armies[i];
  return c;
}

/* 一局。opponent 是参考 bot 名字，oursSide 0/1 决定谁先手，engineCfg 透传给 plan */
function playGame(seed, opponent, ourBudget, refBudget, oursSide, trace, engineCfg, opts) {
  if (refBudget === undefined) refBudget = ourBudget;
  const useFog = !!(opts && opts.fog);
  const rng = mulberry32(seed);
  const board = makeMap(rng);
  if (!board) return null;

  const s0 = new GB.GameState();
  const s1 = new GB.GameState();
  const map = [W, H, ...Array.from(board.armies), ...Array.from(board.owner)];
  for (const [S, pid] of [
    [s0, 0],
    [s1, 1]
  ]) {
    S.applyStart({
      playerIndex: pid,
      generals: board.generals,
      cities: Array.from(board.cities)
        .map((v, i) => (v ? i : -1))
        .filter((i) => i >= 0),
      usernames: ['us', 'them'],
      map,
      game_type: 'custom'
    });
    S.turn = 0;
  }
  const states = [s0, s1];
  const fogs = useFog ? [makeFog(), makeFog()] : null;
  if (fogs) {
    // 开局就要过滤：官方 game_start 不带 map，地图是随后第一个 game_update 里按视野下的
    for (const p of [0, 1]) updateFog(fogs[p], board, p);
  }

  const refRng = mulberry32(seed ^ 0x9e3779b9);
  const ref = opponent === 'engine' ? null : makeRefAgent(opponent, refRng);

  let winner = -1;
  let turns = 0;
  let idleTurns = 0; // 我们整回合一条命令都没出：引擎空转的回合数

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    turns = turn + 1;

    // 走子顺序按玩家下标固定，和服务器 getPlayerMovesPriorityV2 一致（每个 tick
    // 按下标依次各取一条命令）。以前按「我方先走」排，等于每一局都在让先手——
    // 后手能看着你这步回应，实测先手方只赢 42.6%，白白吃了个系统性偏差。
    const order = [0, 1];
    for (const p of order) {
      const me = p;
      if (board.owner[board.generals[me]] !== me) continue; // 已经死了
      const enemy = 1 - me;
      // 迷雾下先按这一方当前的视野刷新 lastSeen，再让双方各自读自己的那份
      const vis = fogs ? updateFog(fogs[p], board, p) : null;
      const view = makeView(board, me, fogs ? fogs[p] : null, vis);

      if (p === oursSide || opponent === 'engine') {
        // 引擎侧：一次给出整回合的计划（opponent === 'engine' 时两边都是引擎，镜像局）
        if (fogs) {
          states[p].terrain.set(fogs[p].owner);
          states[p].armies.set(fogs[p].armies);
          // 服务器的 generals 数组里，看不见的对手将军就是 -1；看见过就永久记住
          // （官方客户端也是这么处理的，灰掉的将军位置会一直留着）。
          states[p].generals = [0, 1].map((q) => {
            const g = board.generals[q];
            if (q === p) return g;
            return vis[g] ? g : -1;
          });
          // 城市同理：cities_diff 只给当前看得见的城，看不见的从表的里摘掉，
          // 那一格在 map 里退化成 FOG_OBSTACLE。引擎要是还拿着全量城市表，
          // 就等于作弊知道五座城在哪。
          states[p].cities = [];
          for (let ci = 0; ci < N; ci++) {
            if (board.cities[ci] && vis[ci]) states[p].cities.push(ci);
          }
        } else {
          syncState(states[p], board, p);
        }
        // 引擎里的 S.turn 是服务器 tick（半个显示回合一个 tick），这里对齐成
        // tick 单位，否则按阶段划分的阈值会被慢放一倍。
        states[p].turn = turn * 2;
        // 镜像 AB 用：非我方那半边可以吃一套不同的参数（opts.cfg2）
        const baseCfg = p === oursSide ? engineCfg : (opts && opts.cfg2) || engineCfg;
        const enginePlan = Object.assign({}, baseCfg, { maxMoves: ourBudget });
        const moves = GB.bot.plan(states[p], enginePlan);
        if (!moves.length) idleTurns++;
        if (trace) {
          console.log(
            'T' + turn + ' 我方 gen=' + board.generals[oursSide] + ' 兵=' + board.armies[board.generals[oursSide]] +
            ' 走=' + JSON.stringify(moves)
          );
        }
        for (const [from, to] of moves) {
          applyMove(board, me, from, to, false);
          if (board.owner[board.generals[enemy]] === me) {
            winner = me;
            break;
          }
        }
      } else {
        // 参考 bot：每回合只有 1 个动作，多步赛制下反复问它
        for (let k = 0; k < refBudget; k++) {
          const act = ref.plan(view);
          if (!act) break;
          if (!applyMove(board, me, act.from, act.to, act.split)) break;
          if (trace) console.log('T' + turn + ' 对方 ' + act.from + '>' + act.to + ' split=' + act.split);
          if (board.owner[board.generals[enemy]] === me) {
            winner = me;
            break;
          }
        }
      }
      if (winner >= 0) break;
    }
    if (winner >= 0) break;

    // 真实产兵（官方 bundle 常量 RECRUIT_RATE=2 / FARM_RATE=50）：
    //   每 2 个半回合（=1 个显示回合）将军 +1、城市 +1、沼泽 -1；
    //   每 50 个半回合（=25 个显示回合，即"一轮"）每个已占格 +1。
    // 也就是说地盘本身几乎不产兵，兵源是将军和城市——这是 generals.io 的经济核心。
    for (let i = 0; i < N; i++) {
      const o = board.owner[i];
      if (o < 0) continue;
      if (i === board.generals[o] || board.cities[i]) board.armies[i] += 1;
      if (turn % 25 === 24) board.armies[i] += 1;
    }
  }

  return {
    winner,
    turns,
    idleTurns,
    ourLand: landCount(board, oursSide),
    enemyLand: landCount(board, 1 - oursSide),
    ourArmy: armyCount(board, oursSide),
    enemyArmy: armyCount(board, 1 - oursSide)
  };
}

function wald(wins, games, success, total) {
  // 只看胜率，和棋按半局算
  return games ? (wins + 0.5 * (games - wins - total)) / games : 0;
}

function runCell(opponent, ourBudget, refBudget, seeds, engineCfg, opts) {
  const acc = {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    turns: 0,
    ourLand: 0,
    enemyLand: 0,
    ourArmy: 0,
    enemyArmy: 0,
    skipped: 0
  };
  for (let s = 0; s < seeds; s++) {
    const seed = 1000 + s * 7919;
    for (const oursSide of [0, 1]) {
      const r = playGame(seed, opponent, ourBudget, refBudget, oursSide, false, engineCfg, opts);
      if (!r) {
        acc.skipped++;
        continue;
      }
      acc.games++;
      acc.turns += r.turns;
      acc.ourLand += r.ourLand;
      acc.enemyLand += r.enemyLand;
      acc.ourArmy += r.ourArmy;
      acc.enemyArmy += r.enemyArmy;
      if (r.winner < 0) acc.draws++;
      else if (r.winner === oursSide) acc.wins++;
      else acc.losses++;
    }
  }
  return acc;
}

function pad(s, n) {
  s = String(s);
  let out = s;
  while (out.length < n) out = ' ' + out;
  return out;
}
function padEnd(s, n) {
  s = String(s);
  let out = s;
  while (out.length < n) out += ' ';
  return out;
}

function show(label, acc) {
  const g = acc.games || 1;
  const wr = (acc.wins / g) * 100;
  const dr = (acc.draws / g) * 100;
  const lr = (acc.losses / g) * 100;
  console.log(
    '  ' +
      padEnd(label, 12) +
      pad(acc.games, 5) +
      pad(acc.wins, 6) +
      pad(acc.losses, 6) +
      pad(acc.draws, 6) +
      pad(wr.toFixed(1) + '%', 8) +
      pad((acc.turns / g).toFixed(0), 8) +
      pad((acc.ourLand / g).toFixed(0), 8) +
      pad((acc.enemyLand / g).toFixed(0), 9) +
      pad((acc.ourArmy / g).toFixed(0), 9) +
      pad((acc.enemyArmy / g).toFixed(0), 9)
  );
}

function header() {
  console.log(
    '  ' +
      padEnd('对手', 12) +
      pad('局数', 4) +
      pad('胜', 5) +
      pad('负', 5) +
      pad('和', 5) +
      pad('胜率', 7) +
      pad('回合', 7) +
      pad('我方地', 7) +
      pad('对方地', 8) +
      pad('我方兵', 8) +
      pad('对方兵', 8)
  );
}

module.exports = { playGame: playGame, makeMap: makeMap, runCell: runCell };

if (require.main === module) {
  const seeds = Number(process.argv[2] || 40);
  // 单变量对照用：GB_CFG='{"earlyPush":false}' node scripts/arena.js 40
  // （Windows PowerShell 会把命令行里的引号吃掉，用环境变量最稳）
  let engineCfg = null;
  for (const a of process.argv.slice(3)) {
    if (a.startsWith('--cfg=')) engineCfg = JSON.parse(a.slice(6));
  }
  if (process.env.GB_CFG) engineCfg = JSON.parse(process.env.GB_CFG);
  // 默认就是真实迷雾（服务器在数据层按视野过滤）。全视野是作弊版，只有显式
  // 写 GB_FOG=0 才给——它唯一还能用的地方是和旧数据对比。
  const opts = { fog: process.env.GB_FOG !== '0' };
  // ladder = harrischristiansen/generals-bot 的移植，比 strakam 的三个基线强一个档；
  // 它没有迷雾处理，所以迷雾下比全视野下弱得多（见 PK.md）。
  const OPPONENTS = ['random', 'expander', 'hunter', 'harvester', 'ladder', 'gc', 'szly'];
  // 服务器每个半回合只从队列里消费一条攻击，所以每方每回合 1 条是唯一的真实赛制。
  // 多预算对照留给 scripts/bench-budget.js，那里明确标注了是反事实实验。
  const MODES = [{ our: 1, ref: 1, label: '真实赛制：每方每回合 1 步' }];

  console.log(
    '擂台：本扩展引擎 vs generals.io 参考 bot（' +
      W +
      'x' +
      H +
      '，每格 ' +
      seeds +
      ' 个种子 × 先后手 = ' +
      seeds * 2 +
      ' 局）'
  );
  console.log(
    '规则：1v1 全视野，格 +1/回合，城市隔回合 +1，一格一回合一动，将军死即败，' + MAX_TURNS + ' 回合未分胜负算和\n'
  );
  if (engineCfg) console.log('引擎参数覆盖：' + JSON.stringify(engineCfg) + '\n');
  console.log(
    '视野：' +
      (opts.fog
        ? '真实迷雾（每方只能看自己领土的 3x3；看不见的城市退化成和山一样的障碍；无记忆）'
        : '全视野（作弊版，官方服务器实际会按视野过滤）') +
      '\n'
  );

  const summary = [];
  for (const mode of MODES) {
    console.log('== ' + mode.label + ' ==');
    header();
    for (const opp of OPPONENTS) {
      const acc = runCell(opp, mode.our, mode.ref, seeds, engineCfg, opts);
      show(opp, acc);
      summary.push({ mode: mode.label, opp, acc });
    }
    console.log('');
  }

  const totalGames = summary.reduce((s, x) => s + x.acc.games, 0);
  const totalWins = summary.reduce((s, x) => s + x.acc.wins, 0);
  const totalLoss = summary.reduce((s, x) => s + x.acc.losses, 0);
  const totalDraw = summary.reduce((s, x) => s + x.acc.draws, 0);
  console.log(
    '总计 ' +
      totalGames +
      ' 局：胜 ' +
      totalWins +
      ' / 负 ' +
      totalLoss +
      ' / 和 ' +
      totalDraw +
      '，胜率 ' +
      ((totalWins / totalGames) * 100).toFixed(1) +
      '%'
  );
}
