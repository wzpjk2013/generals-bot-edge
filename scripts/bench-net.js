/*
 * 网络前向延迟基准。
 * 运行：node scripts/bench-net.js
 *
 * 目标：回答「浏览器扩展里跑得动吗」——所以打印的是单线程纯 JS 的真实 ms/次（warmup 后 20 次），
 * 不是理论值，也不做多线程/WebGPU 外推。
 */
'use strict';

global.window = global;
require('../src/net/augment.js');
require('../src/net/transformer.js');
require('../src/net/weights.js');

const G = global.window.GBnet;

const CFG_L = {
  pad_to: 24,
  patch_size: 3,
  embed_dim: 448,
  n_head: 8,
  depth: 7,
  ff_factor: 3,
  history_size: 7,
  temporal_window: 512
};

// configs/S.yaml 量级
const CFG_S = {
  pad_to: 12,
  patch_size: 2,
  embed_dim: 352,
  n_head: 8,
  depth: 4,
  ff_factor: 2,
  history_size: 7,
  temporal_window: 512
};

let seed = 20240607;
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

function randArr(n, scale) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (rnd() * 2 - 1) * (scale || 1);
  return a;
}

/** 前向 MACs（手算，与实现里的矩阵乘法逐项对应）。 */
function countMacs(cfg) {
  const d = G.deriveDims(cfg);
  const E = d.E, FF = d.FF, T = d.T, tw = cfg.temporal_window;
  let macs = 0;
  macs += d.n_patches * d.patch_dim * E; // patch embedder
  macs += cfg.depth * (T * 4 * E * E); // q/k/v/out
  macs += cfg.depth * (T * 2 * E * FF); // ff1 + ff2
  macs += cfg.depth * (2 * T * T * E); // qk^T + P@V
  macs += 2 * (tw * tw + tw * E); // temporal MLP x2
  macs += E * d.bins; // value head
  macs += d.n_patches * E * d.policy_out; // policy head
  return macs;
}

function percentile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function bench(label, cfg, warmup, iters) {
  const net = G.createNet(cfg);
  G.initRandom(net, 12345);
  const d = net.dims;
  const obs = randArr(d.C * d.p * d.p, 0.5);
  const mask = new Float32Array(d.cfg.n_dirs * d.p * d.p);
  for (let i = 0; i < mask.length; i++) mask[i] = rnd() < 0.5 ? 0 : -1e9;
  const temporal = randArr(cfg.temporal_window * 2, 30);

  for (let i = 0; i < warmup; i++) G.forward(net, obs, mask, temporal);

  const times = [];
  let last = null;
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    last = G.forward(net, obs, mask, temporal);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const macs = countMacs(cfg);
  return {
    label,
    dims: d,
    net,
    params: net.params.length,
    analytic: G.countParams(cfg),
    mean,
    median: percentile(sorted, 0.5),
    max: sorted[sorted.length - 1],
    min: sorted[0],
    macs,
    flops: macs * 2,
    out: last
  };
}

function fmtM(x) {
  return (x / 1e6).toFixed(3) + ' M';
}

function report(r) {
  const d = r.dims;
  console.log('');
  console.log('=== ' + r.label + ' ===');
  console.log(
    '  尺寸: pad_to=' + d.p + ' patch=' + d.M + ' gp=' + d.gp + ' n_patches=' + d.n_patches +
    ' patch_dim=' + d.patch_dim + ' T=' + d.T + ' embed=' + d.E + ' head_dim=' + d.D +
    ' ff=' + d.FF + ' depth=' + d.cfg.depth
  );
  console.log('  参数总量: 实分配 ' + r.params.toLocaleString() + ' / 公式 ' + r.analytic.toLocaleString() +
    (r.params === r.analytic ? ' (一致)' : ' (不一致!)'));
  console.log('  等效计算量: ' + fmtM(r.macs) + ' MACs ≈ ' + fmtM(r.flops) + ' FLOPs (2*MACs)');
  console.log('  前向延迟 (' + r.label + ', warmup 后 ' + 20 + ' 次):');
  console.log('    平均 ' + r.mean.toFixed(1) + ' ms   中位数 ' + r.median.toFixed(1) +
    ' ms   最慢 ' + r.max.toFixed(1) + ' ms   最快 ' + r.min.toFixed(1) + ' ms');
  console.log('    有效算力 ≈ ' + (r.macs / (r.median / 1000) / 1e9).toFixed(2) + ' GMAC/s');
  console.log('    若一回合预算 1000ms: 最多 ' + Math.floor(1000 / r.median) + ' 次前向');
  console.log('    若一回合预算 250ms : 最多 ' + Math.floor(250 / r.median) + ' 次前向');
  console.log('    value=' + r.out.value.toFixed(4) + '  logits[0..2]=' +
    Array.prototype.slice.call(r.out.logits, 0, 3).map((v) => v.toFixed(3)).join(', '));
}

function benchAugment() {
  const st = G.createAugState({ pad_to: 24, history_size: 7, temporal_window: 512 });
  const h = 16, w = 16;
  const obs = new Float32Array(14 * h * w);
  for (let c = 0; c < 14; c++) for (let i = 0; i < h * w; i++) obs[c * h * w + i] = rnd();
  for (let i = 0; i < 50; i++) G.augment(obs, st, { h: h, w: w });
  const times = [];
  for (let i = 0; i < 200; i++) {
    const t0 = process.hrtime.bigint();
    G.augment(obs, st, { h: h, w: w });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const sorted = times.sort((a, b) => a - b);
  return { mean: times.reduce((a, b) => a + b, 0) / times.length, median: percentile(sorted, 0.5), max: sorted[sorted.length - 1] };
}

console.log('AverageJoe HistoryTransformer JS 前向基准');
console.log('node ' + process.version + '  ' + process.platform + '/' + process.arch);

const rL = bench('L (configs/L.yaml 量级)', CFG_L, 3, 20);
const rS = bench('S (configs/S.yaml 量级)', CFG_S, 3, 20);
report(rL);
report(rS);

const aug = benchAugment();
console.log('');
console.log('=== 观测增强 augment（16x16 输入 → 38x24x24）===');
console.log('  平均 ' + aug.mean.toFixed(3) + ' ms   中位数 ' + aug.median.toFixed(3) + ' ms   最慢 ' + aug.max.toFixed(3) + ' ms');

const py = 15.3e6;
console.log('');
console.log('=== 对照 python count_params ≈ 15.3M ===');
console.log('  L 实分配 ' + rL.params.toLocaleString() + '，偏差 ' +
  (((rL.params - py) / py) * 100).toFixed(2) + '%（允许 ±3%）');
console.log('');
console.log('结论口径：上面是中位数单次前向耗时，一回合内能做的前向次数 = floor(回合预算 / 中位数)。');
