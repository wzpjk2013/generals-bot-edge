/*
 * 网络移植回归测试（零依赖，退出码非 0 = 失败）。
 * 运行：node test/net.test.js
 */
'use strict';

global.window = global;
require('../src/net/augment.js');
require('../src/net/transformer.js');
require('../src/net/weights.js');

const G = global.window.GBnet;

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('ok   ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ': ' + (e && e.message));
    console.log('FAIL ' + name + '\n     ' + (e && e.message));
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'eq') + ': 期望 ' + b + '，实得 ' + a);
}
function approx(a, b, eps, msg) {
  if (!(Math.abs(a - b) <= eps)) throw new Error((msg || 'approx') + ': 期望 ' + b + '±' + eps + '，实得 ' + a);
}

const CFG_L = {
  pad_to: 24, patch_size: 3, embed_dim: 448, n_head: 8, depth: 7, ff_factor: 3,
  history_size: 7, temporal_window: 512
};
// 前向用的小配置：保留 pad_to=24 / patch=3（策略头 5184），其余缩小以便快速跑
const CFG_T = {
  pad_to: 24, patch_size: 3, embed_dim: 64, n_head: 4, depth: 2, ff_factor: 2,
  history_size: 7, temporal_window: 8
};

function obs14(h, w) {
  return new Float32Array(14 * h * w);
}
function put(arr, h, w, ch, i, j, v) {
  arr[ch * h * w + i * w + j] = v;
}

// ---------------------------------------------------------------- 1
t('1. 参数总量与手算公式一致', () => {
  const net = G.createNet(CFG_L);
  const d = net.dims;
  eq(d.patch_dim, 38 * 3 * 3, 'patch_dim');
  eq(d.T, 67, 'n_tokens');
  eq(d.n_patches, 64, 'n_patches');

  const E = 448, FF = 1344, depth = 7, patchDim = 342, T = 67, bins = 128, pol = 81, tw = 512;
  // 手算：embedder + depth*(q/k/v/out + ff1 + ff2 + ln1/ln2 各 2E) + norm_out
  //       + value_head + policy_head + 两条 temporal MLP + value_token + pos_encoding + temporal_type_embed
  const perLayer = 4 * (E * E + E) + (E * FF + FF) + (FF * E + E) + 2 * 2 * E;
  const hand = patchDim * E + E
    + depth * perLayer
    + 2 * E
    + (E * bins + bins)
    + (E * pol + pol)
    + 2 * ((tw * tw + tw) + (E * tw + E))
    + E + T * E + 2 * E;

  eq(net.params.length, hand, 'params.length');
  eq(G.countParams(CFG_L), hand, 'countParams');

  // 清单偏移必须首尾相接、无重叠
  let cur = 0;
  const seen = Object.create(null);
  for (const it of net.layout) {
    eq(it.offset, cur, 'layout offset ' + it.name);
    ok(!seen[it.name], 'layout 重名 ' + it.name);
    seen[it.name] = 1;
    cur += it.size;
  }
  eq(cur, net.params.length, 'layout 总长');

  // 与 python count_params 的量级（~15.3M）比对
  const dev = (hand - 15.3e6) / 15.3e6;
  ok(Math.abs(dev) <= 0.03, '与 15.3M 偏差 ' + (dev * 100).toFixed(2) + '% 超出 ±3%');

  console.log('     L 参数总量 = ' + hand.toLocaleString() + ' (15.3M 偏差 ' + (dev * 100).toFixed(2) + '%)');
  // brief 里的公式少了每层 2 个 LayerNorm 和末尾 norm_out，确认差额只来自这两个来源
  const brief = patchDim * E + E + depth * (4 * E * E + 4 * E + 2 * E * FF + FF + E)
    + (E * bins + bins) + (E * pol + pol) + 2 * ((tw * tw + tw) + (E * tw + E)) + E + T * E + 2 * E;
  eq(hand - brief, depth * 2 * 2 * E + 2 * E, 'brief 公式差额应等于 LayerNorm 参数');
});

// ---------------------------------------------------------------- 2
t('2. augment 输出形状/坐标/缩放', () => {
  const p = 24, n = p * p;
  const st = G.createAugState({ pad_to: p, history_size: 7, temporal_window: 512 });
  const obs = obs14(p, p);
  put(obs, p, p, 0, 0, 0, 50);   // armies
  put(obs, p, p, 0, 1, 1, 12);   // 敌方格上的兵
  put(obs, p, p, 5, 0, 0, 1);    // owned
  put(obs, p, p, 6, 1, 1, 1);    // opponent
  put(obs, p, p, 4, 0, 0, 1);    // neutral
  obs[9 * n] = 100;              // owned_land_count
  obs[10 * n] = 75;              // owned_army_count
  obs[11 * n] = 10;              // opponent_land_count
  obs[12 * n] = 25;              // opponent_army_count
  obs[13 * n] = 7;               // timestep

  const out = G.augment(obs, st, { h: p, w: p });
  eq(out.length, 38 * n, 'out.length');

  // 坐标通道
  eq(out[22 * n + 0], 0, 'coords_x[0]');
  eq(out[22 * n + (p - 1)], 1, 'coords_x[p-1]');
  eq(out[23 * n + 0], 0, 'coords_y[0]');
  eq(out[23 * n + (p - 1) * p], 1, 'coords_y[p-1]');

  // 被 50 除的通道
  approx(out[0 * n + 0], 1, 1e-6, 'ch0 armies/50');
  approx(out[1 * n + 0], 1, 1e-6, 'ch1 current_army/50');
  approx(out[2 * n + 25], 12 / 50, 1e-6, 'ch2 current_enemy_army/50');
  approx(out[3 * n + 0], 1, 1e-6, 'ch3 armies*neutral/50');
  approx(out[14 * n + 0], 7 / 50, 1e-6, 'ch14 timestep/50');
  approx(out[16 * n + 0], 2, 1e-6, 'ch16 owned_land/50');
  approx(out[17 * n + 0], 1.5, 1e-6, 'ch17 owned_army/50');
  approx(out[18 * n + 0], 0.2, 1e-6, 'ch18 opp_land/50');
  approx(out[19 * n + 0], 0.5, 1e-6, 'ch19 opp_army/50');
  approx(out[20 * n + 25], 12 / 50, 1e-6, 'ch20 last_seen_value/50');
  approx(out[24 * n + 0], 50 / 50, 1e-6, 'ch24 army_stack[0]/50');
  approx(out[31 * n + 25], 12 / 50, 1e-6, 'ch31 enemy_stack[0]/50');

  // 未被缩放的通道保持原值
  eq(out[4 * n + 0], 1, 'ch4 seen 未缩放');
  eq(out[10 * n + 0], 1, 'ch10 owned_cells 未缩放');
  approx(out[15 * n + 0], 7 / 50, 1e-7, 'ch15 (timestep%50)/50');
  approx(out[21 * n + 25], Math.log1p(0) / 5, 1e-7, 'ch21 敌方可见格 ts=0');

  // 其余 24..37 全部落在可解释范围
  for (let ch = 24; ch < 38; ch++) {
    for (let i = 0; i < n; i++) ok(Number.isFinite(out[ch * n + i]), 'ch' + ch + ' 非有限值');
  }
});

// ---------------------------------------------------------------- 3
t('3. 历史滚动方向（最新差值在最前）', () => {
  const p = 24, n = p * p, h = 8, w = 8;
  const st = G.createAugState({ pad_to: p, history_size: 7, temporal_window: 512 });
  const f1 = obs14(h, w);
  put(f1, h, w, 0, 0, 7, 1);
  put(f1, h, w, 5, 0, 7, 1);
  const o1 = G.augment(f1, st, { h: h, w: w });
  approx(o1[24 * n + 0 * p + 7], 1 / 50, 1e-6, 'frame1 stack0 = 1');

  const f2 = obs14(h, w);
  put(f2, h, w, 0, 0, 7, 5);
  put(f2, h, w, 5, 0, 7, 1);
  const o2 = G.augment(f2, st, { h: h, w: w });
  approx(o2[24 * n + 0 * p + 7], 4 / 50, 1e-6, 'frame2 stack0 = 4（差值，不是 5）');
  approx(o2[25 * n + 0 * p + 7], 1 / 50, 1e-6, 'frame2 stack1 = 1（上一帧差值）');
  approx(o2[1 * n + 0 * p + 7], 5 / 50, 1e-6, 'frame2 current_army = 5');

  // pad 区域：见过/没见过的地方分别填 mountains / structures_in_fog
  // (0,7) 有兵 -> (1,8) 是 pad 且落在 3x3 视野内
  eq(o2[8 * n + 1 * p + 8], 1, 'pad+seen -> 输出通道 8 (mountains) = 1');
  eq(o2[13 * n + 1 * p + 8], 0, 'pad+seen -> structures_in_fog = 0');
  eq(o2[13 * n + 1 * p + 10], 1, 'pad+unseen -> structures_in_fog = 1');
  eq(o2[8 * n + 1 * p + 10], 0, 'pad+unseen -> mountains = 0');
  // 标量通道在 pad 区域用 obs[ch,0,0] 填充
  approx(o2[19 * n + 1 * p + 20], 0, 1e-6, 'pad 区域 opp_army 标量填充');
  eq(o2[0 * n + 1 * p + 20], 0, 'pad 区域 armies 为 0');
});

// ---------------------------------------------------------------- 4
t('4. temporal 写的是 army=ch12 / land=ch11', () => {
  const p = 24, h = 8, w = 8;
  const st = G.createAugState({ pad_to: p, history_size: 7, temporal_window: 32 });
  const obs = obs14(h, w);
  obs[12 * h * w] = 7;   // opponent_army_count
  obs[11 * h * w] = 40;  // opponent_land_count
  G.augment(obs, st, { h: h, w: w });
  eq(st.opponent_army_history[31], 7, 'army history 末尾 = 通道12');
  eq(st.opponent_land_history[31], 40, 'land history 末尾 = 通道11');
  // 再走一帧，确认左移
  obs[12 * h * w] = 9;
  obs[11 * h * w] = 41;
  G.augment(obs, st, { h: h, w: w });
  eq(st.opponent_army_history[31], 9, '第二帧 army');
  eq(st.opponent_army_history[30], 7, 'army 左移一格');
  eq(st.opponent_land_history[31], 41, '第二帧 land');
  eq(st.opponent_land_history[30], 40, 'land 左移一格');
});

// ---------------------------------------------------------------- 5
t('5. forward 输出形状与 value 范围', () => {
  const net = G.createNet(CFG_T);
  G.initRandom(net, 7);
  const d = net.dims;
  const obs = new Float32Array(38 * d.p * d.p).fill(0.1);
  const mask = new Float32Array(9 * d.p * d.p);
  const temporal = new Float32Array(16).fill(3);
  const r = G.forward(net, obs, mask, temporal);
  eq(r.logits.length, 5184, 'logits.length');
  ok(Number.isFinite(r.value), 'value 有限');
  ok(r.value >= -1 && r.value <= 1, 'value ∈ [-1,1]，实得 ' + r.value);
  for (let i = 0; i < r.logits.length; i++) ok(Number.isFinite(r.logits[i]), 'logits[' + i + '] 非有限');
});

// ---------------------------------------------------------------- 6
t('6. mask 生效：只有一个合法方向', () => {
  const net = G.createNet(CFG_T);
  G.initRandom(net, 11);
  const d = net.dims;
  const p = d.p, n = p * p;
  const obs = new Float32Array(38 * n).fill(0.05);
  const mask = new Float32Array(9 * n).fill(-1e9);
  const legal = 2 * n + 5 * p + 9; // d=2, r=5, c=9
  mask[legal] = 0;
  const temporal = new Float32Array(16).fill(1);
  const r = G.forward(net, obs, mask, temporal);

  let best = 0;
  for (let i = 1; i < r.logits.length; i++) if (r.logits[i] > r.logits[best]) best = i;
  eq(best, legal, 'argmax 落在唯一合法位置');
  ok(r.logits[legal] > -1e6, '合法位置未被掩盖');
  for (let i = 0; i < r.logits.length; i++) {
    if (i === legal) continue;
    ok(r.logits[i] < -1e8, '非法位置 ' + i + ' 应 < -1e8，实得 ' + r.logits[i]);
  }
  const a = G.decodeAction(best, p);
  eq(a[0], false, 'pass=false');
  eq(a[1], 5, 'row');
  eq(a[2], 9, 'col');
  eq(a[3], 2, 'dir');
  eq(a[4], false, 'half=false');
});

// ---------------------------------------------------------------- 7
t('7. encodeAction / decodeAction 回环', () => {
  const p = 24;
  const cases = [
    [true, 0, 0, -1, false],
    [false, 0, 0, 0, false],
    [false, 23, 23, 3, false],
    [false, 10, 4, 1, true],
    [false, 7, 19, 0, true],
    [false, 3, 17, 2, true],
    [false, 22, 1, 3, true]
  ];
  // 注意：d 面 4..7 = 半兵方向 0..3，8 = pass；没有「dir>3 且 half=false」的编码，属预期内的不可表示组合
  for (const c of cases) {
    const idx = G.encodeAction(c, p);
    ok(idx >= 0 && idx < 9 * p * p, 'idx 越界 ' + idx);
    const back = G.decodeAction(idx, p);
    eq(back[0], c[0], 'pass 回环');
    eq(back[1], c[1], 'row 回环');
    eq(back[2], c[2], 'col 回环');
    eq(back[3], c[3], 'dir 回环');
    eq(back[4], c[4], 'half 回环');
    // 位置参数形式也要一致
    eq(G.encodeAction(c[0], c[1], c[2], c[3], c[4], p), idx, '位置参数形式');
  }
  // pass 用 d=8，全图 9 个方向面
  eq(G.encodeAction(true, 0, 0, -1, false, p), 8 * p * p, 'pass 下标');
});

// ---------------------------------------------------------------- 8
t('8. unpatchify 索引映射：logit(d,r,c) -> patch/offset', () => {
  const M = 3, gp = 8, p = 24, nDirs = 9, per = nDirs * M * M;
  const patchLogits = new Float32Array(gp * gp * per);
  for (let i = 0; i < patchLogits.length; i++) patchLogits[i] = i + 1; // 唯一值
  const cfg = { pad_to: p, patch_size: M, embed_dim: 64, n_head: 4, depth: 1, ff_factor: 2 };
  const flat = G.unpatchify(patchLogits, cfg);
  eq(flat.length, 9 * p * p, 'unpatchify 长度');
  for (let dcase = 0; dcase < nDirs; dcase++) {
    for (let r = 0; r < p; r++) {
      for (let c = 0; c < p; c++) {
        const pi = Math.floor(r / M) * gp + Math.floor(c / M);
        const k = (dcase * M + (r % M)) * M + (c % M);
        const expected = patchLogits[pi * per + k];
        const got = flat[dcase * p * p + r * p + c];
        if (got !== expected) {
          throw new Error('映射错误 d=' + dcase + ' r=' + r + ' c=' + c + ' 期望 ' + expected + ' 实得 ' + got);
        }
      }
    }
  }
  // patchify 是它的逆：obs 上任意位置 -> 同一个 (pi,k)
  const obs = new Float32Array(38 * p * p);
  for (let ch = 0; ch < 38; ch++) {
    for (let idx = 0; idx < p * p; idx++) obs[ch * p * p + idx] = ch * 10000 + idx + 1;
  }
  const patches = G.patchify(obs, cfg);
  eq(patches.length, 64 * 342, 'patchify 长度');
  for (let ch = 0; ch < 38; ch++) {
    for (let idx = 0; idx < p * p; idx++) {
      const r = Math.floor(idx / p), c = idx % p;
      const pi = Math.floor(r / M) * gp + Math.floor(c / M);
      const k = (ch * M + (r % M)) * M + (c % M);
      const got = patches[pi * 342 + k];
      const expected = obs[ch * p * p + idx];
      if (got !== expected) throw new Error('patchify 映射错误 ch=' + ch + ' r=' + r + ' c=' + c);
    }
  }
});

// ---------------------------------------------------------------- 9
t('9. 同输入两次 forward 逐位相同', () => {
  const net = G.createNet(CFG_T);
  G.initRandom(net, 99);
  const d = net.dims;
  const obs = new Float32Array(38 * d.p * d.p);
  for (let i = 0; i < obs.length; i++) obs[i] = ((i * 37) % 100) / 100;
  const mask = new Float32Array(9 * d.p * d.p);
  const temporal = new Float32Array(16);
  for (let i = 0; i < 16; i++) temporal[i] = (i * 7) % 50;

  const a = G.forward(net, obs, mask, temporal);
  const b = G.forward(net, obs, mask, temporal);
  eq(a.value, b.value, 'value 位级相同');
  for (let i = 0; i < a.logits.length; i++) {
    if (a.logits[i] !== b.logits[i]) throw new Error('logits[' + i + '] 不一致: ' + a.logits[i] + ' vs ' + b.logits[i]);
  }
  // 两次 initRandom 同 seed 也要一致
  const n2 = G.createNet(CFG_T);
  G.initRandom(n2, 99);
  for (let i = 0; i < net.params.length; i += 997) eq(net.params[i], n2.params[i], 'initRandom 确定性 @' + i);
});

// ---------------------------------------------------------------- 10
t('10. weights.loadWeights / manifest 与参数视图一致', () => {
  const net = G.createNet(CFG_T);
  G.initRandom(net, 3);
  const m = G.weightManifest(net);
  eq(m.total, net.params.length, 'manifest total');
  eq(m.buffers, net.params.length, 'manifest buffers');
  const copy = new Float32Array(net.params.length);
  for (const it of m.items) {
    copy.set(net.params.subarray(it.offset, it.offset + it.size), it.offset);
  }
  const net2 = G.createNet(CFG_T);
  G.loadWeights(net2, copy);
  for (let i = 0; i < copy.length; i++) if (net2.params[i] !== copy[i]) throw new Error('loadWeights 不一致 @' + i);
  // 灌完权重后视图必须重新绑定到 params
  eq(net2.v['embed.w'].buffer, net2.params.buffer, '视图未重新绑定');
  // 长度不符必须报错
  let threw = false;
  try { G.loadWeights(net2, new Float32Array(3)); } catch (e) { threw = true; }
  ok(threw, '长度不符应抛错');
});

// ---------------------------------------------------------------- 11
t('11. actionMask 基本形状与语义', () => {
  const p = 8, h = 4, w = 4;
  const owned = new Uint8Array(h * w);
  const armies = new Uint8Array(h * w);
  const mountains = new Uint8Array(h * w);
  owned[1 * w + 1] = 1;
  armies[1 * w + 1] = 5; // 兵>1，四方向全在界内
  const mask = G.actionMask({ owned, armies, mountains, h, w, pad_to: p, allow_pass: true });
  eq(mask.length, 9 * p * p, 'mask 长度');
  // 源格 (1,1) 的四个方向都已合法：d=0 -> (1,2)，d=2 -> (0,1)，d=1 -> (2,1)，d=3 -> (1,0)
  for (const target of [[1, 2], [0, 1], [2, 1], [1, 0]]) {
    let found = false;
    for (let dcase = 0; dcase < 5; dcase++) {
      if (mask[dcase * p * p + target[0] * p + target[1]] === 0) found = true;
    }
    ok(found, '目标格 (1,' + target[1] + ') 至少有一个合法方向');
  }
  // 别的格都非法
  let legalCount = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 0) legalCount++;
  ok(legalCount >= 5, '合法位置数 ' + legalCount);
  eq(mask[8 * p * p + 1 * p + 1], 0, 'pass 面在我方格上合法');
  eq(mask[8 * p * p + 0], -1e9, 'pass 面在空地非法');
});

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log(failures.join('\n'));
  process.exit(1);
}
