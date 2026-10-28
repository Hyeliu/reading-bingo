#!/usr/bin/env node
/* ===========================================================
   阅读大挑战 BINGO —— 同步服务（支持多个班级）
   零依赖，只用 Node 内置模块。

   node server.js            默认 4321 端口
   PORT=8080 node server.js  换端口

   班级用链接区分：  /?c=三年二班
   不带 c 参数时，显示「默认班级」（老链接继续有效）
   =========================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const OCR_BIN = path.join(ROOT, 'tools', 'ocr');
const OCR_SRC = path.join(ROOT, 'tools', 'ocr.m');
const PORT = parseInt(process.env.PORT || '4321', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ---------------- 状态 ---------------- */
let state = null;

function emptyClass(name, slug) {
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  return {
    id: id, name: name, slug: slug,
    boards: {}, mission: null, createdAt: Date.now()
  };
}

function migrate(raw) {
  // 老版本：{ boards, mission } —— 整个装进「默认班级」
  if (raw && raw.boards && !raw.classes) {
    const cls = emptyClass('默认班级', 'default');
    cls.boards = raw.boards || {};
    cls.mission = raw.mission || null;
    return { version: 2, teacherPin: '', defaultId: cls.id, classes: { [cls.id]: cls } };
  }
  return raw;
}

function loadState() {
  let backupDone = false;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const needsMigration = raw && raw.boards && !raw.classes;
    if (needsMigration) {
      try {
        const bak = path.join(DATA_DIR, 'state.backup-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.json');
        fs.copyFileSync(STATE_FILE, bak);
        backupDone = true;
        console.log('  已自动备份旧数据 →', path.basename(bak));
      } catch (e) {}
    }
    state = migrate(raw);
  } catch (e) {
    state = null;
  }
  if (!state || !state.classes) {
    const cls = emptyClass('默认班级', 'default');
    state = { version: 2, teacherPin: '', defaultId: cls.id, classes: { [cls.id]: cls } };
  }
  if (backupDone) saveStateNow();
}

let writeTimer = null;
function saveState() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(saveStateNow, 150);
}
function saveStateNow() {
  clearTimeout(writeTimer);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('保存失败：', e.message);
  }
}

function classList() {
  return Object.keys(state.classes).map(function (id) {
    const c = state.classes[id];
    return { id: c.id, name: c.name, slug: c.slug, count: Object.keys(c.boards).length, isDefault: id === state.defaultId };
  }).sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'zh'); });
}

function findClass(ref) {
  if (!ref) return state.classes[state.defaultId] || Object.values(state.classes)[0];
  const bySlug = Object.values(state.classes).filter(function (c) { return c.slug === ref; })[0];
  if (bySlug) return bySlug;
  return state.classes[ref] || null;
}

function slugify(input) {
  let s = String(input || '').trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '').slice(0, 24);
  return s;
}
function uniqueSlug(base) {
  let s = base || ('c' + Math.random().toString(36).slice(2, 7));
  let n = 1;
  while (Object.values(state.classes).some(function (c) { return c.slug === s; })) {
    s = base + '-' + (++n);
  }
  return s;
}

/* ---------------- 小工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, function (err, buf) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.indexOf('/photos/') === 0) {
    return sendFile(res, path.join(PHOTO_DIR, rel.slice('/photos/'.length)));
  }
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  sendFile(res, filePath);
}

function readBody(req, limit, cb) {
  let body = '';
  let over = false;
  req.on('data', function (c) {
    body += c;
    if (body.length > limit && !over) { over = true; req.destroy(); }
  });
  req.on('end', function () { cb(over ? null : body); });
}

function decodeImage(dataUrl) {
  const m = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(function (req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const ref = parsed.searchParams.get('c') || '';
  const cls = findClass(ref);

  if (pathname === '/healthz') { json(res, 200, { ok: true, classes: Object.keys(state.classes).length }); return; }

  if (pathname === '/api/state' && req.method === 'GET') {
    if (!cls) { json(res, 404, { error: 'no such class' }); return; }
    json(res, 200, {
      class: { id: cls.id, name: cls.name, slug: cls.slug },
      classes: classList(),
      boards: cls.boards,
      mission: cls.mission,
      caps: { ocr: ocrAvailable() }
    });
    return;
  }

  // 新建班级
  if (pathname === '/api/classes' && req.method === 'POST') {
    readBody(req, 64 * 1024, function (raw) {
      let data = {};
      try { data = JSON.parse(raw || '{}'); } catch (e) {}
      const name = String(data.name || '').trim().slice(0, 20) || ('班级 ' + (Object.keys(state.classes).length + 1));
      const slug = uniqueSlug(slugify(data.slug) || slugify(name));
      const c = emptyClass(name, slug);
      state.classes[c.id] = c;
      saveState();
      json(res, 200, { class: { id: c.id, name: c.name, slug: c.slug }, classes: classList() });
    });
    return;
  }

  // 改名 / 改短名 / 设为默认
  if (pathname === '/api/classes/update' && req.method === 'POST') {
    readBody(req, 64 * 1024, function (raw) {
      let data = {};
      try { data = JSON.parse(raw || '{}'); } catch (e) {}
      const c = findClass(data.id);
      if (!c) { json(res, 404, { error: 'no such class' }); return; }
      if (data.name) c.name = String(data.name).trim().slice(0, 20);
      if (data.slug) {
        const s = slugify(data.slug);
        if (s && !Object.values(state.classes).some(function (x) { return x.slug === s && x.id !== c.id; })) c.slug = s;
      }
      if (data.isDefault) state.defaultId = c.id;
      saveState();
      json(res, 200, { class: { id: c.id, name: c.name, slug: c.slug }, classes: classList() });
    });
    return;
  }

  // 删除班级
  if (pathname === '/api/classes/delete' && req.method === 'POST') {
    readBody(req, 64 * 1024, function (raw) {
      let data = {};
      try { data = JSON.parse(raw || '{}'); } catch (e) {}
      const id = data.id;
      if (!state.classes[id]) { json(res, 404, { error: 'no such class' }); return; }
      if (Object.keys(state.classes).length <= 1) { json(res, 400, { error: 'last class' }); return; }
      delete state.classes[id];
      if (state.defaultId === id) state.defaultId = Object.keys(state.classes)[0];
      saveState();
      json(res, 200, { ok: true, classes: classList() });
    });
    return;
  }

  // 布置任务
  if (pathname === '/api/mission' && req.method === 'POST') {
    readBody(req, 1024 * 1024, function (raw) {
      if (!cls) { json(res, 404, { error: 'no such class' }); return; }
      if (!raw) { json(res, 413, { error: 'too large' }); return; }
      let data;
      try { data = JSON.parse(raw); } catch (e) { json(res, 400, { error: 'bad json' }); return; }
      const m = data.mission;
      if (m === null) { cls.mission = null; saveState(); json(res, 200, { ok: true }); return; }
      if (!m || !m.id || !Array.isArray(m.cells)) { json(res, 400, { error: 'bad mission' }); return; }
      if (!cls.mission || (m.updatedAt || 0) >= (cls.mission.updatedAt || 0)) {
        cls.mission = m;
        saveState();
      }
      json(res, 200, { ok: true });
    });
    return;
  }

  // 同步一个孩子的棋盘
  if (pathname === '/api/state' && req.method === 'POST') {
    readBody(req, 2 * 1024 * 1024, function (raw) {
      if (!cls) { json(res, 404, { error: 'no such class' }); return; }
      if (!raw) { json(res, 413, { error: 'too large' }); return; }
      try {
        const data = JSON.parse(raw);
        const b = data.board;
        if (!b || !b.id || !Array.isArray(b.cells)) { json(res, 400, { error: 'bad board' }); return; }
        const cur = cls.boards[b.id];
        if (!cur || (b.updatedAt || 0) >= (cur.updatedAt || 0)) {
          cls.boards[b.id] = b;
          saveState();
        }
        json(res, 200, { ok: true, boards: Object.keys(cls.boards).length });
      } catch (e) {
        json(res, 400, { error: 'bad json' });
      }
    });
    return;
  }

  // 拍照识字：图片 → mac 自带的视觉识别
  if (pathname === '/api/ocr' && req.method === 'POST') {
    readBody(req, 12 * 1024 * 1024, function (raw) {
      if (!raw) { json(res, 413, { error: 'too large' }); return; }
      let data;
      try { data = JSON.parse(raw); } catch (e) { json(res, 400, { error: 'bad json' }); return; }
      const buf = decodeImage(data.image);
      if (!buf) { json(res, 400, { error: 'bad image' }); return; }
      if (!ocrAvailable()) { json(res, 501, { error: 'ocr unavailable' }); return; }

      const tmpDir = path.join(DATA_DIR, 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, 'ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.jpg');
      fs.writeFileSync(tmp, buf);

      execFile(OCR_BIN, [tmp], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout) {
        try { fs.unlink(tmp, function () {}); } catch (e) {}
        if (err) { json(res, 500, { error: 'ocr failed' }); return; }
        try { json(res, 200, JSON.parse(stdout)); }
        catch (e) { json(res, 500, { error: 'bad ocr output' }); }
      });
    });
    return;
  }

  // 保存照片
  if (pathname === '/api/photo' && req.method === 'POST') {
    readBody(req, 12 * 1024 * 1024, function (raw) {
      if (!raw) { json(res, 413, { error: 'too large' }); return; }
      let data;
      try { data = JSON.parse(raw); } catch (e) { json(res, 400, { error: 'bad json' }); return; }
      const buf = decodeImage(data.image);
      if (!buf) { json(res, 400, { error: 'bad image' }); return; }
      fs.mkdirSync(PHOTO_DIR, { recursive: true });
      const name = 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.jpg';
      fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
      json(res, 200, { url: 'photos/' + name });
    });
    return;
  }

  // 清空某个班的记录
  if (pathname === '/api/reset' && req.method === 'POST') {
    if (!cls) { json(res, 404, { error: 'no such class' }); return; }
    cls.boards = {};
    saveState();
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') { serveStatic(req, res, pathname); return; }

  res.writeHead(405); res.end('method not allowed');
});

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    nets[name].forEach(function (net) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    });
  });
  return out;
}

function ocrAvailable() { return fs.existsSync(OCR_BIN); }

function ensureOcr() {
  if (process.platform !== 'darwin') return;   // 云端没有 mac 的文字识别
  if (fs.existsSync(OCR_BIN)) return;
  if (!fs.existsSync(OCR_SRC)) return;
  console.log('  首次运行：正在编译文字识别组件（约 3 秒）…');
  const r = spawnSync('clang', [
    '-fobjc-arc', '-O2',
    '-framework', 'Foundation', '-framework', 'Vision', '-framework', 'AppKit',
    '-o', OCR_BIN, OCR_SRC
  ], { encoding: 'utf8' });
  if (r.status === 0) console.log('  文字识别组件就绪');
  else console.log('  文字识别组件编译失败（不影响玩，只是不能拍照认书名）');
}

loadState();
ensureOcr();
server.listen(PORT, '0.0.0.0', function () {
  const addrs = lanAddresses();
  const classes = classList();
  console.log('');
  console.log('  阅读大挑战 BINGO 已启动');
  console.log('  ────────────────────────────');
  console.log('  这台电脑：  http://localhost:' + PORT);
  addrs.forEach(function (a) {
    console.log('  同一 Wi-Fi： http://' + a + ':' + PORT);
  });
  console.log('  共 ' + classes.length + ' 个班级：');
  classes.forEach(function (c) {
    console.log('    · ' + c.name + '（' + c.count + ' 人）  /?c=' + c.slug);
  });
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
