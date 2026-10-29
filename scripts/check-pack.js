'use strict';
/*
 * 打包前的体检：这个目录能不能被 Edge/Chrome 当扩展加载。
 *
 *   node scripts/check-pack.js
 *
 * 起因：把擂台输出写到仓库根目录 `_arena_blob_on.txt`，Edge 直接拒绝加载整个扩展：
 *   Cannot load extension with file or directory name _arena_blob_on.txt.
 *   Filenames starting with "_" are reserved for use by the system.
 * `_` 开头是浏览器保留给系统用的，扩展目录里出现任何 `_` 开头的文件/目录都会让
 * 加载失败——而且是在你点「重新加载」那一刻才发现。所以拿进 CI。
 */
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..');
const problems = [];

function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.name === '.git') continue;
    if (ent.name.startsWith('_')) {
      problems.push('以 "_" 开头（浏览器保留名，会让整个扩展加载失败）：' + r);
      continue;
    }
    if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
  }
}
walk(EXT, '');

/* manifest 里点名的文件必须都在，少一个也是加载时就报错 */
const manifestPath = path.join(EXT, 'manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  problems.push('manifest.json 解析失败：' + e.message);
}

if (manifest) {
  const expect = [];
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) expect.push(f);
    for (const f of cs.css || []) expect.push(f);
  }
  for (const f of (manifest.web_accessible_resources || []).flatMap((w) =>
    typeof w === 'string' ? [w] : w.resources || []
  )) {
    if (f.includes('*')) continue;
    expect.push(f);
  }
  if (manifest.background && manifest.background.service_worker) expect.push(manifest.background.service_worker);
  if (manifest.background && Array.isArray(manifest.background.scripts)) {
    for (const f of manifest.background.scripts) expect.push(f);
  }
  for (const f of expect) {
    if (!fs.existsSync(path.join(EXT, f))) problems.push('manifest 引用了不存在的文件：' + f);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) {
    problems.push('manifest.version 不是 x.y.z：' + manifest.version);
  }
  if ((manifest.manifest_version | 0) !== 3) problems.push('manifest_version 应该是 3');
}

/* 版本号两处一致（面板显示的是 runtime.getManifest().version，跟 package 对不上就会误导） */
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  if (manifest && pkg.version !== manifest.version) {
    problems.push('manifest ' + manifest.version + ' 和 package ' + pkg.version + ' 版本不一致');
  }
} catch (e) {
  problems.push('package.json 解析失败：' + e.message);
}

if (problems.length) {
  console.log('扩展目录体检不通过：');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('扩展目录体检通过：v' + (manifest && manifest.version) + '，没有保留名文件，manifest 引用的文件都在');
