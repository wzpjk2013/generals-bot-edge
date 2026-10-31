/*
 * 真机冒烟：用 Edge 加载未打包扩展，打开 generals.io，检查
 *   1) MAIN world 脚本执行了（window.__GB）
 *   2) 面板挂上了 DOM，标题上显示的是扩展清单里的版本号
 *   3) 没开局时状态行写的是「未开局」
 *   4) socket 陷阱能抓到 socket（真机连得上才有；连不上时用假 socket 验证陷阱本身）
 *   5) 没有未捕获异常
 * 运行：node scripts/e2e-check.js
 *
 * generals.io 连不上时用 CDP 把首页换成空壳页，URL 仍是 https://generals.io/，
 * 扩展注入不受影响（这台机器外网时通时不通，不能让它决定测试结果）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { launch, getTarget, client, evaluate, serveStub, shutdown, sleep } = require('./cdp');

// GB_EXT 可以指向别的目录——用来验证打包出来的 zip 解压后还能不能加载
const EXT = process.env.GB_EXT ? path.resolve(process.env.GB_EXT) : path.resolve(__dirname, '..');
const PORT = 9333;

const STUB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>generals stub</title></head>
<body><div id="stub">generals.io 空壳页（e2e 用）</div></body></html>`;

const manifestVersion = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;

(async () => {
  let handle;
  let cdp;
  try {
    handle = launch({ port: PORT, extension: EXT, url: 'about:blank' });
    const target = await getTarget(PORT, 'about:blank');
    cdp = await client(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const net = await serveStub(cdp, STUB_HTML);
    await cdp.send('Page.navigate', { url: 'https://generals.io/' });
    await sleep(4000);

    const panel = (id) =>
      `(function(){var h=document.getElementById('gb-autopilot-host');` +
      `if(!h)return null;var s=h.shadowRoot.getElementById('${id}');return s?s.textContent:null})()`;

    const report = {};
    report.page = await evaluate(cdp, 'location.href');
    report.stubbed = net.offline;
    report.gb = await evaluate(cdp, 'typeof window.__GB === "object" && !!window.__GB.bot');
    // 移植版引擎：模块装载 + 驱动层就位。这两个是 1.2.0 的关键路径 ——
    // 缺一个就等于装了个旧扩展（面板照样在，但跑的是老引擎）。
    report.ek = await evaluate(
      cdp,
      'typeof window.__EK === "object" && !!window.__EK.Bot && !!window.__EK.ArmyFlowExpanderV2'
    );
    report.ekrun = await evaluate(
      cdp,
      '!!window.__GB && typeof window.__GB.ekbot === "object" && typeof window.__GB.ekbot.plan === "function"'
    );
    report.ekmods = await evaluate(cdp, 'Object.keys(window.__EK || {}).length');
    report.panel = await evaluate(cdp, '!!document.getElementById("gb-autopilot-host")');
    report.version = await evaluate(cdp, panel('ver'));
    report.status = await evaluate(cdp, panel('st'));
    report.turn = await evaluate(cdp, panel('st2'));
    report.verify = await evaluate(cdp, panel('st7'));
    report.state = await evaluate(
      cdp,
      'window.__GB && window.__GB.state ? ({ready: window.__GB.state.ready, pid: window.__GB.state.playerIndex, n: window.__GB.state.n}) : null'
    );

    // socket 陷阱：真机没连上站点时，塞一个假 socket 看陷阱是否命中
    report.trap = await evaluate(
      cdp,
      `(function(){
         if (window.socket && typeof window.socket.emit === 'function') return 'real';
         var stub = { emit: function(){}, on: function(){ return this; }, handlers: {} };
         window.socket = stub;
         return window.socket === stub && window.__GB.socket === stub ? 'stub-ok' : 'miss';
       })()`
    );

    // 拖动：用真实鼠标事件拖标题栏，看面板是不是真的跟着走
    const rect = await evaluate(
      cdp,
      `(function(){
         var h = document.getElementById('gb-autopilot-host');
         if (!h) return null;
         var b = h.shadowRoot.getElementById('box');
         var hd = h.shadowRoot.getElementById('hd');
         var rb = b.getBoundingClientRect();
         var rh = hd.getBoundingClientRect();
         return { box: { left: rb.left, top: rb.top, w: rb.width, h: rb.height },
                  hd: { x: rh.left + rh.width / 2, y: rh.top + rh.height / 2 } };
       })()`
    );
    if (rect) {
      const from = rect.hd;
      const to = { x: Math.max(20, from.x - 140), y: from.y + 60 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          button: 'left',
          buttons: 1
        });
        await sleep(16);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(200);
      const after = await evaluate(
        cdp,
        `(function(){
           var h = document.getElementById('gb-autopilot-host');
           var b = h.shadowRoot.getElementById('box');
           var r = b.getBoundingClientRect();
           return { left: r.left, top: r.top, inlineLeft: b.style.left, inlineTop: b.style.top,
                    folded: h.shadowRoot.getElementById('body').style.display === 'none' };
         })()`
      );
      report.drag = {
        before: { left: Math.round(rect.box.left), top: Math.round(rect.box.top) },
        after: { left: Math.round(after.left), top: Math.round(after.top) },
        inline: after.inlineLeft + '/' + after.inlineTop,
        moved: Math.abs(after.left - rect.box.left) > 20 || Math.abs(after.top - rect.box.top) > 20,
        accidentallyFolded: after.folded
      };
    }

    report.errors = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text)
      .slice(0, 5);
    report.console = cdp.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled')
      .map((e) => e.params.args.map((a) => a.value || a.description).join(' '))
      .filter((t) => String(t).includes('GBAuto') || String(t).includes('refagents'))
      .slice(0, 10);

    const problems = [];
    if (!report.gb) problems.push('window.__GB 不在：MAIN world 脚本没执行');
    if (!report.ek) problems.push('window.__EK 缺 Bot / ArmyFlowExpanderV2：移植版模块没加载完');
    if (!report.ekrun) problems.push('window.__GB.ekbot 不在：src/ekrun.js 没跑起来');
    if (typeof report.ekmods === 'number' && report.ekmods < 60) {
      problems.push('__EK 导出只有 ' + report.ekmods + ' 个：manifest 的脚本清单漏了模块');
    }
    if (!report.panel) problems.push('面板没挂上');
    if (report.version !== 'v' + manifestVersion) {
      problems.push('版本号应为 v' + manifestVersion + '，实际 ' + JSON.stringify(report.version) + '（扩展没重载？）');
    }
    if (report.status !== '未开局') problems.push('没开局时状态应是「未开局」，实际 ' + JSON.stringify(report.status));
    if (report.verify !== '0 / 0') {
      problems.push('「没生效 / 丢帧」开局应显示 0 / 0，实际 ' + JSON.stringify(report.verify));
    }
    if (report.trap === 'miss') problems.push('socket 陷阱没命中');
    if (report.drag && !report.drag.moved) problems.push('面板拖不动：拖动后位置没变 ' + JSON.stringify(report.drag));
    if (report.drag && report.drag.accidentallyFolded) problems.push('拖动把面板折起来了（点击/拖动没有分开）');
    report.problems = problems;

    console.log(JSON.stringify(report, null, 2));
    if (problems.length) process.exitCode = 1;
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await shutdown(handle, cdp);
  }
})();
