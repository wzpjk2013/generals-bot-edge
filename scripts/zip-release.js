'use strict';
/*
 * 打一个可以直接「加载解压缩的扩展」的 zip。
 *
 *   node scripts/zip-release.js              → dist/generals-autopilot-edge-<版本>.zip
 *   node scripts/zip-release.js --out D:/x   → 指定输出目录
 *
 * 两个讲究：
 *   1. 打进 zip 的只有扩展真正要跑的东西（manifest.json + src/ + 文档），
 *      scripts/、test/、.git 不进包——它们不影响运行，只让包变胖。
 *   2. 自己写 ZIP（zlib + 手工目录），不依赖 Compress-Archive：
 *      PowerShell 的 cmdlet 在文件名编码和目录型条目上历来有坑，而且这样
 *      同一个版本号重打出来的包字节一致，方便对校验和。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EXT = path.join(__dirname, '..');

/* 固定时间戳（DOS 格式），保证可复现 */
const DOS_TIME = (12 << 11) | (0 << 5) | (0 >> 1); // 12:00:00
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1; // 2024-01-01

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* 收集要进包的文件：manifest.json、src/ 全部、根目录的 md */
function collect() {
  const out = [];
  out.push('manifest.json');
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(EXT, rel), { withFileTypes: true })) {
      const r = rel + '/' + ent.name;
      if (ent.name.startsWith('_')) throw new Error('扩展目录里不能有 "_" 开头的名字：' + r);
      if (ent.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('src');
  for (const f of fs.readdirSync(EXT)) {
    if (!f.endsWith('.md')) continue;
    if (fs.statSync(path.join(EXT, f)).isFile()) out.push(f);
  }
  return out.sort();
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const data = fs.readFileSync(path.join(EXT, rel));
    const nameBuf = Buffer.from(rel, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // 文件名按 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // 普通文件 rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const version = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号不像话：' + version);

const outFlag = process.argv.indexOf('--out');
const outDir = outFlag > 0 ? path.resolve(process.argv[outFlag + 1]) : path.join(EXT, 'dist');
fs.mkdirSync(outDir, { recursive: true });

const files = collect();
const zip = buildZip(files);
const outPath = path.join(outDir, 'generals-autopilot-edge-' + version + '.zip');
fs.writeFileSync(outPath, zip);

console.log('打包 ' + files.length + ' 个文件 → ' + outPath);
console.log('  ' + files.join('\n  '));
console.log('大小 ' + (zip.length / 1024).toFixed(1) + ' KB');
