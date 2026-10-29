/*
 * 参数清单与权重灌入。
 *
 * 所有参数拉平到一个 Float32Array 里，layout 记录 (name, shape, offset, size)。
 * 以后有 .eqx / ONNX / safetensors 权重时，写个转换脚本按 name 对位 memcpy 进来即可，
 * 这个文件本身不做任何文件 IO。
 *
 * shape 约定：Linear 的 weight 记为 [out, in]（行优先存储，y = x·Wᵀ + b）。
 * JAX/Equinox 的 nn.Linear 权重形状是 (in, out)，转换时需要转置一次。
 */
(function (root) {
  'use strict';

  var G = root.GBnet || (root.GBnet = {});

  /**
   * 生成参数清单。
   * init 字段给 initRandom 用：'rand'(U(-0.02,0.02)) / 'zero' / 'one' / 'unit'(U(-1,1))
   * @returns {Array<{name:string, shape:number[], offset:number, size:number, init:string}>}
   */
  G.paramLayout = function (cfg) {
    var d = G.deriveDims(cfg);
    var E = d.E, FF = d.FF, tw = d.cfg.temporal_window;
    var list = [];
    var off = 0;

    function add(name, shape, init) {
      var size = 1;
      for (var i = 0; i < shape.length; i++) size *= shape[i];
      list.push({ name: name, shape: shape.slice(), offset: off, size: size, init: init });
      off += size;
    }

    add('embed.w', [E, d.patch_dim], 'rand');
    add('embed.b', [E], 'zero');

    for (var l = 0; l < d.cfg.depth; l++) {
      var pre = 'block' + l + '.';
      add(pre + 'ln1.w', [E], 'one');
      add(pre + 'ln1.b', [E], 'zero');
      add(pre + 'attn.q.w', [E, E], 'rand');
      add(pre + 'attn.q.b', [E], 'zero');
      add(pre + 'attn.k.w', [E, E], 'rand');
      add(pre + 'attn.k.b', [E], 'zero');
      add(pre + 'attn.v.w', [E, E], 'rand');
      add(pre + 'attn.v.b', [E], 'zero');
      add(pre + 'attn.out.w', [E, E], 'rand');
      add(pre + 'attn.out.b', [E], 'zero');
      add(pre + 'ln2.w', [E], 'one');
      add(pre + 'ln2.b', [E], 'zero');
      add(pre + 'ff1.w', [FF, E], 'rand');
      add(pre + 'ff1.b', [FF], 'zero');
      add(pre + 'ff2.w', [E, FF], 'rand');
      add(pre + 'ff2.b', [E], 'zero');
    }

    add('norm_out.w', [E], 'one');
    add('norm_out.b', [E], 'zero');
    add('value_head.w', [d.bins, E], 'rand');
    add('value_head.b', [d.bins], 'zero');
    add('policy_head.w', [d.policy_out, E], 'rand');
    add('policy_head.b', [d.policy_out], 'zero');

    for (var t = 0; t < 2; t++) {
      add('tempo' + t + '.fc1.w', [tw, tw], 'rand');
      add('tempo' + t + '.fc1.b', [tw], 'zero');
      add('tempo' + t + '.fc2.w', [E, tw], 'rand');
      add('tempo' + t + '.fc2.b', [E], 'zero');
    }

    add('value_token', [E], 'unit');
    add('pos_encoding', [d.T, E], 'unit');
    add('temporal_type_embed', [2, E], 'unit');
    return list;
  };

  /** 清单 + 总量，方便转换脚本和自检。 */
  G.weightManifest = function (net) {
    var total = 0;
    var items = [];
    for (var i = 0; i < net.layout.length; i++) {
      var it = net.layout[i];
      total += it.size;
      items.push({ name: it.name, shape: it.shape.slice(), offset: it.offset, size: it.size });
    }
    return { total: total, buffers: net.params.length, items: items };
  };

  /**
   * 把外部权重灌进 net。
   * 顺序必须与 weightManifest().items 的 offset 一致（即纯拼接的扁平数组）。
   * @param {object} net
   * @param {Float32Array|number[]} arr 长度必须等于 net.params.length
   * @returns {object} net
   */
  G.loadWeights = function (net, arr) {
    if (arr.length !== net.params.length) {
      throw new Error('loadWeights: 长度不符，期望 ' + net.params.length + '，实得 ' + arr.length);
    }
    net.params.set(arr);
    G.bindWeights(net);
    return net;
  };

  /** 按名字单独取一个参数视图（调试/测试用，热路径不要用）。 */
  G.paramOf = function (net, name) {
    var w = net.v[name];
    if (!w) throw new Error('paramOf: 未知参数 ' + name);
    return w;
  };

  /** 把某条清单项的名字填进一个 Float32Array（占位实现：以后接转换器用）。 */
  G.weightsToObject = function (net) {
    var m = G.weightManifest(net);
    var out = {};
    for (var i = 0; i < m.items.length; i++) {
      var it = m.items[i];
      out[it.name] = { shape: it.shape, data: net.params.subarray(it.offset, it.offset + it.size) };
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
