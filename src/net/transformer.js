/*
 * AverageJoe HistoryTransformer 的 JS 前向移植（networks/common.py + networks/layers.py）。
 *
 * 纯 ES5 循环 + Float32Array，无依赖、无 IO、单样本前向。
 * 数值上与 JAX 版对齐的边界：全部按 float32 存储激活，LayerNorm eps=1e-5（分母 n），
 * softmax 在 float32 缓冲区里算（exp 用 double 求值后写回 f32），不模拟 bf16。
 *
 * 参数布局定义在 weights.js（GBnet.paramLayout），这里只做消费。
 */
(function (root) {
  'use strict';

  var G = root.GBnet || (root.GBnet = {});

  var DEFAULT_CFG = {
    pad_to: 24,
    patch_size: 3,
    embed_dim: 448,
    n_head: 8,
    depth: 7,
    ff_factor: 3,
    history_size: 7,
    temporal_window: 512,
    n_channels: 38,
    n_dirs: 9,
    value_bins: 128,
    allow_pass: true
  };

  var LN_EPS = 1e-5;
  var MASK_NEG = -1e9;

  function f32(n) { return new Float32Array(n); }

  function mergeCfg(cfg) {
    var out = {};
    var k;
    for (k in DEFAULT_CFG) if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) out[k] = DEFAULT_CFG[k];
    if (cfg) for (k in cfg) if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = cfg[k];
    return out;
  }

  /** 由 cfg 推导全部维度（供 createNet / bench / test 共用）。 */
  G.deriveDims = function (cfg) {
    var c = mergeCfg(cfg);
    var gp = c.pad_to / c.patch_size;
    if (gp !== Math.floor(gp)) throw new Error('pad_to 必须是 patch_size 的整数倍');
    if (c.embed_dim % c.n_head !== 0) throw new Error('embed_dim 必须能被 n_head 整除');
    return {
      cfg: c,
      p: c.pad_to,
      M: c.patch_size,
      gp: gp,
      n_patches: gp * gp,
      C: c.n_channels,
      patch_dim: c.n_channels * c.patch_size * c.patch_size,
      E: c.embed_dim,
      H: c.n_head,
      D: c.embed_dim / c.n_head,
      FF: c.embed_dim * c.ff_factor,
      T: gp * gp + 3,
      policy_out: c.n_dirs * c.patch_size * c.patch_size,
      bins: c.value_bins
    };
  };

  /**
   * 参数总量手算公式（与 createNet 分配的长度必须逐位相等）。
   * 注意：层内的 3 个 LayerNorm（ln1/ln2 各 2E、norm_out 2E）在 JAX 版里也是有参数的，
   * brief 里的公式漏了它们（L 配置差 19,712 个，占 0.13%）。这里算全。
   */
  G.countParams = function (cfg) {
    var d = G.deriveDims(cfg);
    var E = d.E, F = d.FF, tw = d.cfg.temporal_window;
    var perLayer = 4 * (E * E + E)          // q/k/v/out 四个 Linear
      + (E * F + F) + (F * E + E)           // ff1 / ff2
      + 2 * 2 * E;                          // ln1/ln2 各 weight+bias
    return d.patch_dim * E + E              // embedder
      + d.cfg.depth * perLayer
      + 2 * E                               // norm_out
      + (E * d.bins + d.bins)               // value_head
      + (E * d.policy_out + d.policy_out)   // policy_head
      + 2 * ((tw * tw + tw) + (E * tw + E)) // 两条 temporal MLP
      + E                                   // value_token
      + d.T * E                             // pos_encoding
      + 2 * E;                              // temporal_type_embed
  };

  // ---- 基础算子 ----

  /** y[yo+i] = W[i][k]·x[xo+k] + b[i]，W 行优先 (nOut, nIn)。 */
  function linear(W, b, x, xo, y, yo, nIn, nOut) {
    var o;
    if (b) {
      for (o = 0; o < nOut; o++) y[yo + o] = b[o];
    } else {
      for (o = 0; o < nOut; o++) y[yo + o] = 0;
    }
    for (o = 0; o < nOut; o++) {
      var base = o * nIn;
      var s = y[yo + o];
      for (var k = 0; k < nIn; k++) s += W[base + k] * x[xo + k];
      y[yo + o] = s;
    }
  }

  /**
   * 多 token 版 Linear：一次遍历把权重喂给 4 个 token（4 个 token × 4 个输出行 = 16 个累加器）。
   * 单 token 逐个算时 W 每层要被扫 67 遍（每遍 ~2.4MB），这里降到 1/4，实测 3 倍左右。
   * X/Y 都是 token 优先：X[t*nIn + k]，Y[t*nOut + o]。
   */
  function linearBatch(W, b, X, xo, nt, nIn, Y, yo, nOut) {
    var t = 0, o, k;
    for (; t + 3 < nt; t += 4) {
      var x0 = xo + t * nIn, x1 = x0 + nIn, x2 = x1 + nIn, x3 = x2 + nIn;
      var y0 = yo + t * nOut, y1 = y0 + nOut, y2 = y1 + nOut, y3 = y2 + nOut;
      o = 0;
      for (; o + 3 < nOut; o += 4) {
        var b0 = o * nIn, b1 = b0 + nIn, b2 = b1 + nIn, b3 = b2 + nIn;
        var c0 = b ? b[o] : 0, c1 = b ? b[o + 1] : 0, c2 = b ? b[o + 2] : 0, c3 = b ? b[o + 3] : 0;
        var s00 = c0, s01 = c0, s02 = c0, s03 = c0;
        var s10 = c1, s11 = c1, s12 = c1, s13 = c1;
        var s20 = c2, s21 = c2, s22 = c2, s23 = c2;
        var s30 = c3, s31 = c3, s32 = c3, s33 = c3;
        for (k = 0; k < nIn; k++) {
          var w0 = W[b0 + k], w1 = W[b1 + k], w2 = W[b2 + k], w3 = W[b3 + k];
          var v0 = X[x0 + k], v1 = X[x1 + k], v2 = X[x2 + k], v3 = X[x3 + k];
          s00 += w0 * v0; s01 += w0 * v1; s02 += w0 * v2; s03 += w0 * v3;
          s10 += w1 * v0; s11 += w1 * v1; s12 += w1 * v2; s13 += w1 * v3;
          s20 += w2 * v0; s21 += w2 * v1; s22 += w2 * v2; s23 += w2 * v3;
          s30 += w3 * v0; s31 += w3 * v1; s32 += w3 * v2; s33 += w3 * v3;
        }
        Y[y0 + o] = s00; Y[y1 + o] = s01; Y[y2 + o] = s02; Y[y3 + o] = s03;
        Y[y0 + o + 1] = s10; Y[y1 + o + 1] = s11; Y[y2 + o + 1] = s12; Y[y3 + o + 1] = s13;
        Y[y0 + o + 2] = s20; Y[y1 + o + 2] = s21; Y[y2 + o + 2] = s22; Y[y3 + o + 2] = s23;
        Y[y0 + o + 3] = s30; Y[y1 + o + 3] = s31; Y[y2 + o + 3] = s32; Y[y3 + o + 3] = s33;
      }
      for (; o < nOut; o++) {
        var base = o * nIn;
        var bb = b ? b[o] : 0;
        var r0 = bb, r1 = bb, r2 = bb, r3 = bb;
        for (k = 0; k < nIn; k++) {
          var wk = W[base + k];
          r0 += wk * X[x0 + k];
          r1 += wk * X[x1 + k];
          r2 += wk * X[x2 + k];
          r3 += wk * X[x3 + k];
        }
        Y[y0 + o] = r0; Y[y1 + o] = r1; Y[y2 + o] = r2; Y[y3 + o] = r3;
      }
    }
    for (; t < nt; t++) linear(W, b, X, xo + t * nIn, Y, yo + t * nOut, nIn, nOut);
  }

  function layernorm(x, xo, w, b, n, y, yo) {
    var i, s = 0;
    for (i = 0; i < n; i++) s += x[xo + i];
    var mean = s / n;
    var v = 0;
    for (i = 0; i < n; i++) {
      var d = x[xo + i] - mean;
      v += d * d;
    }
    var inv = 1 / Math.sqrt(v / n + LN_EPS);
    for (i = 0; i < n; i++) y[yo + i] = (x[xo + i] - mean) * inv * w[i] + b[i];
  }

  function siluInPlace(a, off, n) {
    for (var i = 0; i < n; i++) {
      var v = a[off + i];
      a[off + i] = v / (1 + Math.exp(-v));
    }
  }

  /** 行内 softmax，原地，float32 缓冲。 */
  function softmaxInPlace(a, off, n) {
    var i, m = -Infinity;
    for (i = 0; i < n; i++) if (a[off + i] > m) m = a[off + i];
    var s = 0;
    for (i = 0; i < n; i++) {
      var e = Math.exp(a[off + i] - m);
      a[off + i] = e;
      s += e;
    }
    var inv = s > 0 ? 1 / s : 0;
    for (i = 0; i < n; i++) a[off + i] *= inv;
  }

  // ---- patchify / unpatchify ----

  /**
   * (C,p,p) -> (n_patches, C*M*M)。
   * patch = (i*gp + j)，内部偏移 k = ch*M*M + a*M + b。
   */
  G.patchify = function (obs, cfg, outArr) {
    var d = G.deriveDims(cfg);
    var p = d.p, M = d.M, gp = d.gp, C = d.C, n = p * p;
    var out = outArr || f32(d.n_patches * d.patch_dim);
    for (var i = 0; i < gp; i++) {
      for (var j = 0; j < gp; j++) {
        var po = (i * gp + j) * d.patch_dim;
        for (var ch = 0; ch < C; ch++) {
          var co = ch * n;
          for (var a = 0; a < M; a++) {
            var row = (i * M + a) * p + j * M;
            var bo = po + (ch * M + a) * M;
            for (var b = 0; b < M; b++) out[bo + b] = obs[co + row + b];
          }
        }
      }
    }
    return out;
  };

  /**
   * (n_patches, n_dirs*M*M) -> (n_dirs, p, p)。
   * 与 patchify 相反：patch 内偏移 k = d*M*M + a*M + b，
   * 目标下标 d*p*p + (i*M+a)*p + (j*M+b)。
   */
  G.unpatchify = function (patchLogits, cfg, outArr) {
    var d = G.deriveDims(cfg);
    var p = d.p, M = d.M, gp = d.gp, nDirs = d.cfg.n_dirs, n = p * p;
    var per = nDirs * M * M;
    var out = outArr || f32(nDirs * n);
    for (var i = 0; i < gp; i++) {
      for (var j = 0; j < gp; j++) {
        var po = (i * gp + j) * per;
        for (var dd = 0; dd < nDirs; dd++) {
          var lo = dd * n;
          for (var a = 0; a < M; a++) {
            var row = (i * M + a) * p + j * M;
            var kl = po + dd * M * M + a * M;
            for (var b = 0; b < M; b++) out[lo + row + b] = patchLogits[kl + b];
          }
        }
      }
    }
    return out;
  };

  // ---- 网络 ----

  G.createNet = function (cfg) {
    var d = G.deriveDims(cfg);
    if (typeof G.paramLayout !== 'function') {
      throw new Error('GBnet.paramLayout 缺失：请先加载 src/net/weights.js');
    }
    var layout = G.paramLayout(d.cfg);
    var total = 0;
    for (var i = 0; i < layout.length; i++) total += layout[i].size;
    var net = {
      cfg: d.cfg,
      dims: d,
      layout: layout,
      params: f32(total),
      v: {},
      scr: {}
    };
    var T = d.T, E = d.E, FF = d.FF;
    var scr = net.scr;
    scr.in = f32(d.n_patches * d.patch_dim);
    scr.x = f32(T * E);
    scr.ln = f32(T * E);
    scr.q = f32(T * E);
    scr.k = f32(T * E);
    scr.v = f32(T * E);
    scr.ctx = f32(T * E);
    scr.proj = f32(T * E);
    scr.ffAll = f32(T * FF);   // 批量 FF：token 优先
    scr.scores = f32(T * T);
    scr.patchLogits = f32(d.n_patches * d.policy_out);
    scr.valLogits = f32(d.bins);
    scr.tempo = f32(E);
    G.bindWeights(net);
    return net;
  };

  /** 把 params 切成命名视图（wb: weights.js）。 */
  G.bindWeights = function (net) {
    var v = net.v;
    for (var key in v) if (Object.prototype.hasOwnProperty.call(v, key)) delete v[key];
    for (var i = 0; i < net.layout.length; i++) {
      var it = net.layout[i];
      v[it.name] = net.params.subarray(it.offset, it.offset + it.size);
    }
    net.v = v;
    return v;
  };

  /** 确定性初始化：mulberry32；权重 U(-0.02,0.02)，bias 0，LayerNorm 权重 1。 */
  G.initRandom = function (net, seed) {
    var s = (seed === undefined ? 1 : seed) >>> 0;
    function rnd() {
      s |= 0;
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (var i = 0; i < net.layout.length; i++) {
      var it = net.layout[i];
      var a = net.params.subarray(it.offset, it.offset + it.size);
      if (it.init === 'zero') {
        a.fill(0);
      } else if (it.init === 'one') {
        a.fill(1);
      } else if (it.init === 'unit') {
        // 位置编码 / token 向量类，量级稍大一点但仍是确定性随机
        for (var j = 0; j < a.length; j++) a[j] = rnd() * 2 - 1;
      } else {
        for (var k = 0; k < a.length; k++) a[k] = (rnd() * 2 - 1) * 0.02;
      }
    }
    return net;
  };

  /** 单样本前向。 */
  G.forward = function (net, obs38, mask9, temporal) {
    var d = net.dims;
    var cfg = net.cfg;
    var p = d.p, M = d.M, gp = d.gp, n = p * p, C = d.C;
    var E = d.E, H = d.H, D = d.D, FF = d.FF, T = d.T;
    var nPatches = d.n_patches;
    var v = net.v, scr = net.scr;
    var i, j, l, t, o;

    // 1. patchify
    var pin = G.patchify(obs38, cfg, scr.in);

    // 2. token 序列
    var x = scr.x;
    var ln = scr.ln;
    // token 0: value_token
    var vt = v['value_token'];
    for (i = 0; i < E; i++) x[i] = vt[i];
    // token 1/2: temporal（两条独立 MLP：tw->tw(silu)->E）
    var tw = cfg.temporal_window;
    var tin = scr.tempoIn || (scr.tempoIn = f32(tw));
    var thid = scr.tempoHid || (scr.tempoHid = f32(tw));
    for (t = 0; t < 2; t++) {
      var hoff = t * tw;
      for (i = 0; i < tw; i++) tin[i] = temporal[hoff + i] / 50;
      var fc1w = v['tempo' + t + '.fc1.w'], fc1b = v['tempo' + t + '.fc1.b'];
      var fc2w = v['tempo' + t + '.fc2.w'], fc2b = v['tempo' + t + '.fc2.b'];
      linear(fc1w, fc1b, tin, 0, thid, 0, tw, tw);
      siluInPlace(thid, 0, tw);
      linear(fc2w, fc2b, thid, 0, x, (t + 1) * E, tw, E);
      var tte = v['temporal_type_embed'];
      for (i = 0; i < E; i++) x[(t + 1) * E + i] += tte[t * E + i];
    }
    // token 3..: patch embedding（64 个 token 批量，权重只扫 16 遍）
    var embW = v['embed.w'], embB = v['embed.b'];
    linearBatch(embW, embB, pin, 0, nPatches, d.patch_dim, x, 3 * E, E);
    var pos = v['pos_encoding'];
    for (t = 0; t < T; t++) {
      for (i = 0; i < E; i++) x[t * E + i] += pos[t * E + i];
    }

    // 3. transformer blocks（pre-norm）
    for (l = 0; l < cfg.depth; l++) {
      var pre = 'block' + l + '.';
      var ln1w = v[pre + 'ln1.w'], ln1b = v[pre + 'ln1.b'];
      var ln2w = v[pre + 'ln2.w'], ln2b = v[pre + 'ln2.b'];
      var qw = v[pre + 'attn.q.w'], qb = v[pre + 'attn.q.b'];
      var kw = v[pre + 'attn.k.w'], kb = v[pre + 'attn.k.b'];
      var vw = v[pre + 'attn.v.w'], vb = v[pre + 'attn.v.b'];
      var ow = v[pre + 'attn.out.w'], ob = v[pre + 'attn.out.b'];
      var f1w = v[pre + 'ff1.w'], f1b = v[pre + 'ff1.b'];
      var f2w = v[pre + 'ff2.w'], f2b = v[pre + 'ff2.b'];

      for (t = 0; t < T; t++) layernorm(x, t * E, ln1w, ln1b, E, ln, t * E);
      var q = scr.q, kk = scr.k, vv = scr.v, ctx = scr.ctx;
      linearBatch(qw, qb, ln, 0, T, E, q, 0, E);
      linearBatch(kw, kb, ln, 0, T, E, kk, 0, E);
      linearBatch(vw, vb, ln, 0, T, E, vv, 0, E);
      var scores = scr.scores;
      var scale = 1 / Math.sqrt(D);
      for (var h = 0; h < H; h++) {
        var ho = h * D;
        for (i = 0; i < T; i++) {
          var qo = i * E + ho;
          for (j = 0; j < T; j++) {
            var ko = j * E + ho;
            var s = 0;
            for (var dd = 0; dd < D; dd++) s += q[qo + dd] * kk[ko + dd];
            scores[i * T + j] = s * scale;
          }
          softmaxInPlace(scores, i * T, T);
        }
        // ctx = P @ V
        for (i = 0; i < T; i++) {
          var co = i * E + ho;
          for (var dd2 = 0; dd2 < D; dd2++) ctx[co + dd2] = 0;
          for (j = 0; j < T; j++) {
            var pw = scores[i * T + j];
            if (pw === 0) continue;
            var vo = j * E + ho;
            for (var dd3 = 0; dd3 < D; dd3++) ctx[co + dd3] += pw * vv[vo + dd3];
          }
        }
      }
      var proj = scr.proj;
      linearBatch(ow, ob, ctx, 0, T, E, proj, 0, E);
      for (i = 0; i < T * E; i++) x[i] += proj[i];

      for (t = 0; t < T; t++) layernorm(x, t * E, ln2w, ln2b, E, ln, t * E);
      var ffAll = scr.ffAll;
      linearBatch(f1w, f1b, ln, 0, T, E, ffAll, 0, FF);
      siluInPlace(ffAll, 0, T * FF);
      linearBatch(f2w, f2b, ffAll, 0, T, FF, proj, 0, E);
      for (i = 0; i < T * E; i++) x[i] += proj[i];
    }

    // 4. norm_out
    var now = v['norm_out.w'], nob = v['norm_out.b'];
    for (t = 0; t < T; t++) layernorm(x, t * E, now, nob, E, ln, t * E);

    // 5. value head
    var vlw = v['value_head.w'], vlb = v['value_head.b'];
    var valLogits = scr.valLogits;
    linear(vlw, vlb, ln, 0, valLogits, 0, E, d.bins);
    softmaxInPlace(valLogits, 0, d.bins);
    var value = 0;
    for (i = 0; i < d.bins; i++) {
      var center = d.bins > 1 ? -1 + (2 * i) / (d.bins - 1) : 0;
      value += valLogits[i] * center;
    }

    // 6. policy head（64 个 patch token 批量）
    var plw = v['policy_head.w'], plb = v['policy_head.b'];
    var pl = scr.patchLogits;
    linearBatch(plw, plb, ln, 3 * E, nPatches, E, pl, 0, d.policy_out);

    // 7. unpatchify + mask
    var logits = G.unpatchify(pl, cfg);
    if (mask9) {
      for (i = 0; i < logits.length; i++) {
        var m = mask9[i];
        if (m === 0) continue;
        logits[i] += m > 0 ? MASK_NEG : m;
      }
    }

    return { logits: logits, value: value, valueProbs: valLogits };
  };

  // ---- 动作编码 ----

  G.decodeAction = function (idx, padTo) {
    var p = padTo === undefined ? 24 : padTo;
    var area = p * p;
    var dcase = Math.floor(idx / area);
    var pos = idx % area;
    var row = Math.floor(pos / p);
    var col = pos % p;
    var isPass = dcase === 8;
    var isHalf = dcase >= 4 && dcase < 8;
    var dir = isPass ? -1 : (isHalf ? dcase - 4 : dcase);
    return [isPass, row, col, dir, isHalf];
  };

  /**
   * encodeAction(idx 的逆)。两种调用方式：
   *   encodeAction([isPass,row,col,dir,isHalf], padTo)
   *   encodeAction(isPass, row, col, dir, isHalf, padTo)
   */
  G.encodeAction = function () {
    var a = arguments[0];
    var isPass, row, col, dir, isHalf, p;
    if (a !== null && typeof a === 'object' && typeof a.length === 'number') {
      isPass = a[0]; row = a[1]; col = a[2]; dir = a[3]; isHalf = a[4];
      p = arguments[1] === undefined ? 24 : arguments[1];
    } else {
      isPass = a; row = arguments[1]; col = arguments[2];
      dir = arguments[3]; isHalf = arguments[4];
      p = arguments[5] === undefined ? 24 : arguments[5];
    }
    if (isPass) return 8 * p * p + row * p + col;
    var dcase = isHalf ? dir + 4 : dir;
    return dcase * p * p + row * p + col;
  };

  G.DEFAULT_CFG = DEFAULT_CFG;
})(typeof window !== 'undefined' ? window : globalThis);
