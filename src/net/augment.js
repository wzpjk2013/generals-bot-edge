/*
 * AverageJoe 观测增强移植（networks/common.py: AugmentedObsState / augment_obs / normalize_observations）。
 *
 * 输入：14 通道 (h,w) 的 float32 平面，行优先拼接。
 * 输出：38 通道 (pad_to,pad_to) 的行优先 Float32Array，已归一化，喂给 transformer 的 patch 嵌入。
 *
 * 通道序（输入，与 python 一致）：
 *   0 armies        1 generals     2 cities       3 mountains     4 neutral_cells
 *   5 owned_cells   6 opponent_cells 7 fog_cells   8 structures_in_fog
 *   9 owned_land_count  10 owned_army_count  11 opponent_land_count
 *   12 opponent_army_count  13 timestep          （9..13 是标量，广播到全图）
 *
 * 每个对局调用 createAugState 一次；每帧调用 augment，state 内部按 python 的顺序就地更新。
 */
(function (root) {
  'use strict';

  var G = root.GBnet || (root.GBnet = {});

  var NCH_IN = 14;
  var NCH_OUT = 38;

  // 输入通道号
  var IN_ARMIES = 0;
  var IN_GENERALS = 1;
  var IN_CITIES = 2;
  var IN_MOUNTAINS = 3;
  var IN_NEUTRAL = 4;
  var IN_OWNED = 5;
  var IN_OPPONENT = 6;
  var IN_FOG = 7;
  var IN_STRUCT_FOG = 8;
  var IN_OWNED_LAND = 9;
  var IN_OWNED_ARMY = 10;
  var IN_OPP_LAND = 11;
  var IN_OPP_ARMY = 12;
  var IN_TIMESTEP = 13;

  function f32(n) { return new Float32Array(n); }
  function u8(n) { return new Uint8Array(n); }

  /** 每局重置的状态（对应 AugmentedObsState）。 */
  G.createAugState = function (cfg) {
    cfg = cfg || {};
    var p = cfg.pad_to === undefined ? 24 : cfg.pad_to;
    var hs = cfg.history_size === undefined ? 7 : cfg.history_size;
    var tw = cfg.temporal_window === undefined ? 512 : cfg.temporal_window;
    var n = p * p;
    var st = {
      pad_to: p,
      history_size: hs,
      temporal_window: tw,
      h: 0,
      w: 0,
      army_stack: f32(hs * n),
      enemy_stack: f32(hs * n),
      last_army: f32(n),
      last_enemy_army: f32(n),
      cities: u8(n),
      generals: u8(n),
      mountains: u8(n),
      seen: u8(n),
      enemy_seen: u8(n),
      last_enemy_army_seen_value: f32(n),
      last_enemy_army_seen_timestep: f32(n),
      opponent_army_history: f32(tw),
      opponent_land_history: f32(tw),
      // 复用的 scratch，避免每帧分配
      _pad: null,
      _padMask: null,
      _maskH: -1,
      _maskW: -1,
      _rowA: u8(n),
      _rowB: u8(n),
      _vis: u8(n),
      _visE: u8(n),
      _spm: u8(n),
      _curA: f32(n),
      _curE: f32(n)
    };
    return st;
  };

  /** 同一对象在新对局里清零（等价于 python 里新建 AugmentedObsState）。 */
  G.resetAugState = function (st) {
    st.army_stack.fill(0);
    st.enemy_stack.fill(0);
    st.last_army.fill(0);
    st.last_enemy_army.fill(0);
    st.cities.fill(0);
    st.generals.fill(0);
    st.mountains.fill(0);
    st.seen.fill(0);
    st.enemy_seen.fill(0);
    st.last_enemy_army_seen_value.fill(0);
    st.last_enemy_army_seen_timestep.fill(0);
    st.opponent_army_history.fill(0);
    st.opponent_land_history.fill(0);
    return st;
  };

  /**
   * 3x3 SAME maxpool 的 ">0" 版本：out[i][j] = 1 当且仅当窗口内存在 >0 的值。
   * 越界在 python 里 maxpool 的 padding 是 -inf，等价于只取图内单元格，
   * 所以这里对非 0 值取布尔或即可（布尔或可分：先横向 3 格，再纵向 3 行）。
   */
  function poolGt0(src, off, p, rowA, rowB, out) {
    var i, j;
    for (i = 0; i < p; i++) {
      var b = off + i * p;
      var r = i * p;
      for (j = 0; j < p; j++) rowA[r + j] = src[b + j] > 0 ? 1 : 0;
      for (j = 0; j < p; j++) {
        var v = rowA[r + j];
        if (j > 0) v |= rowA[r + j - 1];
        if (j < p - 1) v |= rowA[r + j + 1];
        rowB[r + j] = v;
      }
    }
    for (i = 0; i < p; i++) {
      var r2 = i * p;
      var up = i > 0 ? r2 - p : -1;
      var dn = i < p - 1 ? r2 + p : -1;
      for (j = 0; j < p; j++) {
        var w = rowB[r2 + j];
        if (up >= 0) w |= rowB[up + j];
        if (dn >= 0) w |= rowB[dn + j];
        out[r2 + j] = w;
      }
    }
  }

  /**
   * 一帧的观测增强。
   * @param {Float32Array} obsArr 14*h*w，行优先
   * @param {object} state createAugState 的产物
   * @param {{h:number,w:number}=} shape 显式给出 h/w；否则用 state.h/state.w，再否则按正方形推断
   * @returns {Float32Array} 38*p*p，已归一化
   */
  G.augment = function (obsArr, state, shape) {
    var p = state.pad_to;
    var n = p * p;
    var hs = state.history_size;
    var tw = state.temporal_window;

    var h = state.h;
    var w = state.w;
    if (shape) { h = shape.h; w = shape.w; }
    if (!h || !w) {
      var cells = obsArr.length / NCH_IN;
      h = w = Math.round(Math.sqrt(cells));
    }
    if (h > p || w > p) {
      throw new Error('augment: obs ' + h + 'x' + w + ' exceeds pad_to ' + p);
    }
    var hw = h * w;

    // ---- 1. pad 到 (p,p) ----
    var pad = state._pad;
    if (!pad) pad = state._pad = f32(NCH_IN * n);
    else pad.fill(0);
    var ch, i, j, idx;
    for (ch = 0; ch < NCH_IN; ch++) {
      var so = ch * hw;
      var dof = ch * n;
      for (i = 0; i < h; i++) {
        var sr = so + i * w;
        var dr = dof + i * p;
        for (j = 0; j < w; j++) pad[dr + j] = obsArr[sr + j];
      }
    }
    // pad 区域的标量通道用 obs[ch,0,0] 填充（9..13）
    for (ch = IN_OWNED_LAND; ch <= IN_TIMESTEP; ch++) {
      var val = obsArr[ch * hw];
      var base = ch * n;
      for (i = h; i < p; i++) {
        var rb = base + i * p;
        for (j = 0; j < p; j++) pad[rb + j] = val;
      }
      for (i = 0; i < h; i++) {
        var rb2 = base + i * p;
        for (j = w; j < p; j++) pad[rb2 + j] = val;
      }
    }

    var padMask = state._padMask;
    if (!padMask || state._maskH !== h || state._maskW !== w) {
      padMask = state._padMask = u8(n);
      for (i = 0; i < p; i++) {
        for (j = 0; j < p; j++) padMask[i * p + j] = (i >= h || j >= w) ? 1 : 0;
      }
      state._maskH = h;
      state._maskW = w;
    }

    var oArmies = IN_ARMIES * n;
    var oGenerals = IN_GENERALS * n;
    var oCities = IN_CITIES * n;
    var oMount = IN_MOUNTAINS * n;
    var oNeutral = IN_NEUTRAL * n;
    var oOwned = IN_OWNED * n;
    var oOpp = IN_OPPONENT * n;
    var oFog = IN_FOG * n;
    var oStruct = IN_STRUCT_FOG * n;

    // ---- 2. visible = maxpool3x3(owned) > 0 ----
    poolGt0(pad, oOwned, p, state._rowA, state._rowB, state._vis);
    var vis = state._vis;
    var spm = state._spm;
    for (idx = 0; idx < n; idx++) spm[idx] = (state.mountains[idx] | (padMask[idx] & vis[idx])) ? 1 : 0;

    // mountains 通道：pad_mask & seen_pad_mountains -> 1.0，其余保持
    for (idx = 0; idx < n; idx++) {
      if (padMask[idx] && spm[idx]) pad[oMount + idx] = 1.0;
    }
    // structures_in_fog：pad_mask & ~seen_pad_mountains -> 1.0，其余保持
    for (idx = 0; idx < n; idx++) {
      if (padMask[idx] && !spm[idx]) pad[oStruct + idx] = 1.0;
    }

    // ---- 3. 当前兵力 ----
    var curA = state._curA;
    var curE = state._curE;
    for (idx = 0; idx < n; idx++) {
      var a = pad[oArmies + idx];
      curA[idx] = a * pad[oOwned + idx];
      curE[idx] = a * pad[oOpp + idx];
    }

    // ---- 4. 兵力历史：最新差值放第 0 行 ----
    var stA = state.army_stack;
    var stE = state.enemy_stack;
    if (hs > 1) {
      stA.copyWithin(n, 0, (hs - 1) * n);
      stE.copyWithin(n, 0, (hs - 1) * n);
    }
    for (idx = 0; idx < n; idx++) {
      stA[idx] = curA[idx] - state.last_army[idx];
      stE[idx] = curE[idx] - state.last_enemy_army[idx];
    }
    state.last_army.set(curA);
    state.last_enemy_army.set(curE);

    // ---- 5. seen / enemy_seen ----
    poolGt0(pad, oOpp, p, state._rowA, state._rowB, state._visE);
    var visE = state._visE;
    for (idx = 0; idx < n; idx++) {
      if (vis[idx]) state.seen[idx] = 1;
      if (visE[idx]) state.enemy_seen[idx] = 1;
    }

    // ---- 6. 静态地图记忆 ----
    for (idx = 0; idx < n; idx++) {
      if (pad[oCities + idx] > 0) state.cities[idx] = 1;
      if (pad[oGenerals + idx] > 0) state.generals[idx] = 1;
      if (pad[oMount + idx] > 0 || spm[idx]) state.mountains[idx] = 1;
    }

    // ---- 7. 敌人最后可见兵力 / 经过的回合数 ----
    var lv = state.last_enemy_army_seen_value;
    var lt = state.last_enemy_army_seen_timestep;
    for (idx = 0; idx < n; idx++) {
      if (curE[idx] > 0) {
        lv[idx] = curE[idx];
        lt[idx] = 0;
      } else {
        lt[idx] = lt[idx] + 1;
      }
    }

    // ---- 8. 时间序列：左移一格，写对方兵力 / 领地 ----
    var oaH = state.opponent_army_history;
    var olH = state.opponent_land_history;
    oaH.copyWithin(0, 1);
    olH.copyWithin(0, 1);
    // 注意：army 历史写通道 12（opponent_army_count），land 历史写通道 11（opponent_land_count）
    oaH[tw - 1] = obsArr[IN_OPP_ARMY * hw];
    olH[tw - 1] = obsArr[IN_OPP_LAND * hw];

    // ---- 9/10. 组装 38 通道 ----
    var out = f32(NCH_OUT * n);
    var timestep = pad[IN_TIMESTEP * n];
    var invP = p > 1 ? 1 / (p - 1) : 0;

    for (i = 0; i < p; i++) {
      var coordY = i * invP;
      for (j = 0; j < p; j++) {
        idx = i * p + j;
        out[idx] = pad[oArmies + idx];
        out[n + idx] = curA[idx];
        out[2 * n + idx] = curE[idx];
        out[3 * n + idx] = pad[oArmies + idx] * pad[oNeutral + idx];
        out[4 * n + idx] = state.seen[idx];
        out[5 * n + idx] = state.enemy_seen[idx];
        out[6 * n + idx] = state.generals[idx];
        out[7 * n + idx] = state.cities[idx];
        out[8 * n + idx] = state.mountains[idx];
        out[9 * n + idx] = pad[oNeutral + idx];
        out[10 * n + idx] = pad[oOwned + idx];
        out[11 * n + idx] = pad[oOpp + idx];
        out[12 * n + idx] = pad[oFog + idx];
        out[13 * n + idx] = pad[oStruct + idx];
        out[14 * n + idx] = timestep;
        out[15 * n + idx] = ((timestep % 50) + 50) % 50 / 50;
        out[16 * n + idx] = pad[IN_OWNED_LAND * n + idx];
        out[17 * n + idx] = pad[IN_OWNED_ARMY * n + idx];
        out[18 * n + idx] = pad[IN_OPP_LAND * n + idx];
        out[19 * n + idx] = pad[IN_OPP_ARMY * n + idx];
        out[20 * n + idx] = lv[idx];
        out[21 * n + idx] = Math.log1p(lt[idx]) / 5;
        out[22 * n + idx] = j * invP;
        out[23 * n + idx] = coordY;
      }
    }
    for (var k = 0; k < hs; k++) {
      var sb = k * n;
      for (idx = 0; idx < n; idx++) {
        out[(24 + k) * n + idx] = stA[sb + idx];
        out[(24 + hs + k) * n + idx] = stE[sb + idx];
      }
    }

    // ---- 11. 归一化 ----
    // 通道 0,1,2,3,14,16,17,18,19,20 与 24..37（含 7 层两份历史）除以 50。
    var scaled = [0, 1, 2, 3, 14, 16, 17, 18, 19, 20];
    for (var s = 0; s < scaled.length; s++) {
      var off = scaled[s] * n;
      for (idx = 0; idx < n; idx++) out[off + idx] *= 0.02;
    }
    for (ch = 24; ch < NCH_OUT; ch++) {
      var off2 = ch * n;
      for (idx = 0; idx < n; idx++) out[off2 + idx] *= 0.02;
    }

    return out;
  };

  /**
   * prepare_action_mask 的等价实现。
   * @param {object} a {owned, armies, mountains: 平面数组; mine: 我的玩家号（owned 已是 0/1 时可省）;
   *                    h, w, pad_to, allow_pass}
   * direction_mask[r][c][d] = 源格属于我 && 兵>1 && 目标在界内 && 目标非山
   * mask_t = 1 - transpose(direction_mask)，pad 到 (p,p) 边界填 1，pass 面填 0（allow_pass）
   * @returns {Float32Array} 9*p*p，非法为 -1e9
   */
  G.actionMask = function (a) {
    var p = a.pad_to === undefined ? 24 : a.pad_to;
    var h = a.h, w = a.w;
    var owned = a.owned, armies = a.armies, mountains = a.mountains;
    var allowPass = a.allow_pass === undefined ? true : !!a.allow_pass;
    var n = p * p;
    var dm = new Uint8Array(n * 4); // direction_mask (p,p,4)
    var dr = [0, -1, 1, 0];
    var dc = [1, 0, 0, -1];
    var i, j, d;
    for (i = 0; i < h; i++) {
      for (j = 0; j < w; j++) {
        var src = i * w + j;
        if (!owned[src] || !(armies[src] > 1)) continue;
        for (d = 0; d < 4; d++) {
          var ti = i + dr[d], tj = j + dc[d];
          if (ti < 0 || tj < 0 || ti >= h || tj >= w) continue;
          if (mountains && mountains[ti * w + tj]) continue;
          dm[(i * p + j) * 4 + d] = 1;
        }
      }
    }
    var mask = f32(9 * n).fill(-1e9); // 默认非法，后面把合法位置抹成 0
    for (var layer = 0; layer < 9; layer++) {
      var lo = layer * n;
      var isHalf = layer >= 4 && layer < 8;
      var dd = isHalf ? layer - 4 : layer;
      if (layer === 8) {
        if (allowPass) {
          for (i = 0; i < p; i++) {
            for (j = 0; j < p; j++) {
              if (i < h && j < w && owned[i * w + j] && armies[i * w + j] > 1) mask[lo + i * p + j] = 0;
            }
          }
        }
        continue;
      }
      // mask_t = 1 - transpose(direction_mask)：目标格 (r,c) 合法 <=> 相邻源格 (r-dr, c-dc) 有该方向
      for (i = 0; i < h; i++) {
        for (j = 0; j < w; j++) {
          var si = i - dr[dd], sj = j - dc[dd];
          if (si < 0 || sj < 0 || si >= h || sj >= w) continue;
          if (dm[(si * p + sj) * 4 + dd]) mask[lo + i * p + j] = 0;
        }
      }
    }
    return mask;
  };

  G.NCH_IN = NCH_IN;
  G.NCH_OUT = NCH_OUT;
})(typeof window !== 'undefined' ? window : globalThis);
