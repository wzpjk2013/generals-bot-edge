/*
 * 页面主世界（MAIN world）的接线层：
 *   - 拦截 window.socket（generals.io 在 bundle 里执行 n.g.socket = io(...)），
 *     拿到 socket.io 实例后订阅 game_start / game_update，并在每回合下发 attack。
 *   - attack 走的是官方前端自己用的同一个 emit，事件名会被官方包装层压成协议下标，
 *     所以不需要自己维护协议表。
 *   - 面板用 Shadow DOM，避免和站点样式打架。
 */
(function () {
  'use strict';

  var GB = window.__GB;
  if (!GB) return;

  var state = new GB.GameState();
  GB.state = state;

  var settings = {
    enabled: true,
    maxMoves: 6
  };
  GB.settings = settings;

  var stats = { moves: 0, last: '-', blocked: '', error: '' };
  var lastDrive = { turn: -1, at: 0 };
  var socketRef = null;
  var ui = null;

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[GBAuto]');
    console.log.apply(console, args);
  }

  function postSettings() {
    try {
      window.postMessage({ __gb: 'save', settings: settings }, '*');
    } catch (e) {
      /* 忽略：bridge 不在也能跑 */
    }
  }

  // 公开匹配和自建房间一视同仁：进对局就接管
  function drive() {
    var S = state;
    stats.blocked = '';
    if (!S.ready || S.playerIndex < 0 || S.ended) return;
    if (!settings.enabled) {
      stats.blocked = '已暂停';
      return;
    }
    if (S.turn === lastDrive.turn) return;

    var now = performance.now();
    if (now - lastDrive.at < 100) return;
    lastDrive.turn = S.turn;
    lastDrive.at = now;

    var turn = S.turn;
    var moves;
    try {
      moves = GB.bot.plan(S, settings);
    } catch (e) {
      stats.error = String((e && e.message) || e);
      log('plan failed', e);
      return;
    }
    if (!moves.length || !socketRef) return;

    // 同回合内错开发包，避免瞬间打爆 socket
    moves.forEach(function (mv, k) {
      setTimeout(function () {
        try {
          socketRef.emit('attack', mv[0], mv[1], false, turn);
        } catch (e) {
          stats.error = 'emit: ' + ((e && e.message) || e);
        }
      }, k * 35);
    });

    stats.moves += moves.length;
    stats.last = moves
      .slice(0, 3)
      .map(function (m) {
        return m[0] + '>' + m[1];
      })
      .join(' ');
  }

  // 事件处理集中在这里：socket 订阅和 GB.feed（调试/自动化注入）走同一份
  var handlers = {
    game_start: function (m) {
      state.applyStart(m);
      lastDrive.turn = -1;
      stats.last = '-';
      stats.error = '';
    },
    game_update: function (m) {
      state.applyUpdate(m);
      drive();
    },
    game_over: function () {
      state.end();
    },
    game_won: function () {
      state.end();
    },
    game_lost: function () {
      state.end();
    }
  };

  GB.feed = function (name, payload) {
    var h = handlers[name];
    if (!h) return false;
    h(payload);
    return true;
  };

  function attach(sock) {
    if (!sock || sock === socketRef) return;
    if (typeof sock.emit !== 'function' || typeof sock.on !== 'function') return;
    socketRef = sock;
    GB.socket = sock;
    log('socket attached');

    Object.keys(handlers).forEach(function (name) {
      try {
        sock.on(name, handlers[name]);
      } catch (e) {
        log('subscribe failed: ' + name, e);
      }
    });
  }

  try {
    Object.defineProperty(window, 'socket', {
      configurable: true,
      enumerable: true,
      get: function () {
        return socketRef;
      },
      set: function (v) {
        attach(v);
      }
    });
  } catch (e) {
    log('socket trap failed', e);
  }

  // 兜底：万一站点换成交互式赋值方式，直接轮询
  setInterval(function () {
    if (socketRef) return;
    var s = window.socket;
    if (s && typeof s.emit === 'function') attach(s);
  }, 300);

  /* ---------------- 面板 ---------------- */

  var PANEL = [
    '<style>',
    ':host{all:initial}',
    '.box{position:fixed;top:70px;right:12px;z-index:2147483646;width:206px;',
    'background:rgba(16,20,24,.92);color:#e6edf3;border:1px solid #39424d;border-radius:10px;',
    'padding:9px 11px;font:12px/1.55 "Segoe UI",system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)}',
    '.hd{display:flex;justify-content:space-between;align-items:center;cursor:pointer;',
    'font-weight:600;color:#7fd1ff;letter-spacing:.02em}',
    '.row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:5px}',
    '.k{color:#8c99a6;white-space:nowrap}',
    '.v{color:#dbe6ef;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sw{flex:0 0 auto;width:34px;height:18px;border-radius:9px;background:#3a434d;position:relative;',
    'cursor:pointer;transition:background .15s}',
    '.sw.on{background:#2f9e52}',
    '.sw i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;',
    'background:#fff;transition:left .15s}',
    '.sw.on i{left:18px}',
    'input{width:42px;background:#0b0f13;color:#e6edf3;border:1px solid #4a5560;border-radius:4px;',
    'padding:1px 4px;font:inherit;text-align:right}',
    '.err{color:#ff8a80}',
    '.ok{color:#5ddc85}',
    '.warn{color:#ffc857}',
    '</style>',
    '<div class="box">',
    '  <div class="hd"><span>Generals AutoPilot</span><span id="fold">−</span></div>',
    '  <div id="body">',
    '    <div class="row"><span class="k">启用</span><span class="sw" id="sw-enable"><i></i></span></div>',
    '    <div class="row"><span class="k">每回合步数</span><input id="in-max" type="number" min="1" max="20" step="1"></div>',
    '    <div class="row"><span class="k">状态</span><span class="v" id="st">等待连接</span></div>',
    '    <div class="row"><span class="k">回合</span><span class="v" id="st2">-</span></div>',
    '    <div class="row"><span class="k">地块 / 兵力</span><span class="v" id="st3">-</span></div>',
    '    <div class="row"><span class="k">已走</span><span class="v" id="st4">0</span></div>',
    '    <div class="row"><span class="k">最近</span><span class="v" id="st5">-</span></div>',
    '  </div>',
    '</div>'
  ].join('');

  function el(root, id) {
    return root.getElementById(id);
  }

  function setSwitch(node, on) {
    if (!node) return;
    node.classList.toggle('on', !!on);
  }

  function ensureUI() {
    if (ui || !document.body) return;
    var host = document.createElement('div');
    host.id = 'gb-autopilot-host';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = PANEL;
    document.body.appendChild(host);

    ui = {
      root: root,
      enabled: el(root, 'sw-enable'),
      max: el(root, 'in-max'),
      st: el(root, 'st'),
      st2: el(root, 'st2'),
      st3: el(root, 'st3'),
      st4: el(root, 'st4'),
      st5: el(root, 'st5'),
      body: el(root, 'body'),
      fold: el(root, 'fold')
    };

    ui.enabled.addEventListener('click', function () {
      settings.enabled = !settings.enabled;
      postSettings();
      refresh();
    });
    ui.max.addEventListener('change', function () {
      var v = parseInt(ui.max.value, 10);
      if (!(v >= 1 && v <= 20)) v = 6;
      settings.maxMoves = v;
      postSettings();
      refresh();
    });
    var folded = false;
    el(root, 'fold').parentNode.addEventListener('click', function () {
      folded = !folded;
      ui.body.style.display = folded ? 'none' : '';
      ui.fold.textContent = folded ? '+' : '−';
    });

    refresh();
  }

  function refresh() {
    if (!ui) return;
    setSwitch(ui.enabled, settings.enabled);
    if (document.activeElement !== ui.max) ui.max.value = settings.maxMoves;

    var S = state;
    var status;
    var cls = '';
    if (!socketRef) status = '等待连接';
    else if (!S.ready) status = '已连接，等开局';
    else if (S.ended) status = '对局结束';
    else if (stats.blocked) {
      status = stats.blocked;
      cls = 'warn';
    } else status = '运行中';

    ui.st.textContent = stats.error || status;
    ui.st.className = 'v ' + (stats.error ? 'err' : cls);
    ui.st.title = status + (stats.error ? ' / ' + stats.error : '');

    if (!S.ready) {
      ui.st2.textContent = '-';
      ui.st3.textContent = '-';
    } else {
      var tiles = 0;
      var army = 0;
      for (var i = 0; i < S.n; i++) {
        if (S.terrain[i] === S.playerIndex) {
          tiles++;
          army += S.armies[i];
        }
      }
      ui.st2.textContent = String(S.turn);
      ui.st3.textContent = tiles + ' / ' + army;
    }
    ui.st4.textContent = String(stats.moves);
    ui.st5.textContent = stats.last;
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.__gb !== 'settings') return;
    var s = d.settings || {};
    if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
    if (Number.isInteger(s.maxMoves) && s.maxMoves >= 1 && s.maxMoves <= 20) {
      settings.maxMoves = s.maxMoves;
    }
    refresh();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }
  setInterval(refresh, 400);
})();
