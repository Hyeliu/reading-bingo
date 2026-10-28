/* ===========================================================
   阅读大挑战 BINGO —— 应用逻辑
   纯前端，单个页面；本地用 localStorage，联网时自动和 server.js 同步
   =========================================================== */
(function () {
  'use strict';

  const LS_KEY = 'bingo.v1';
  const LS_ME = 'bingo.me';
  const LS_VIEW = 'bingo.view';
  const LS_SOUND = 'bingo.sound';

  const FREE_INDEX = Math.max(0, CELLS.findIndex(function (c) { return c.free; }));

  const store = {
    get: function (k) { try { return store.get(k); } catch (e) { return null; } },
    set: function (k, v) { try { store.set(k, v); } catch (e) {} }
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad = (n) => String(n).padStart(2, '0');
  function todayStr() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /* ---------------- 状态 ---------------- */
  let state = { boards: {} };
  let me = null;
  let syncMode = 'local';
  let caps = { ocr: true };

  /* ---------- 当前班级（体现在 URL 上：?c=三年二班） ---------- */
  let classSlug = (function () {
    const u = new URLSearchParams(location.search).get('c');
    if (u) { store.set('bingo.class', u); return u; }
    return store.get('bingo.class') || '';
  })();
  let classInfo = null;
  let classListCache = [];

  function apiUrl(p) {
    if (!classSlug) return p;
    return p + (p.indexOf('?') >= 0 ? '&' : '?') + 'c=' + encodeURIComponent(classSlug);
  }
  function shareLink(slug) {
    return location.origin + location.pathname + '?c=' + encodeURIComponent(slug);
  }
  function goClass(slug) {
    const base = location.origin + location.pathname;
    location.href = base + '?c=' + encodeURIComponent(slug);
  }
  let viewMode = store.get(LS_VIEW) || 'book';   // book | theme
  let soundOn = store.get(LS_SOUND) !== '0';
  let currentView = 'entry';

  function loadLocal() {
    try {
      const raw = store.get(LS_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (!v.mission) v.mission = null;
        return v;
      }
    } catch (e) {}
    return { boards: {}, mission: null };
  }
  function persist() {
    try { store.set(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function mergeRemote(remote) {
    if (!remote || !remote.boards) return false;
    let changed = false;
    if (remote.mission && (!state.mission || (remote.mission.updatedAt || 0) > (state.mission.updatedAt || 0))) {
      state.mission = remote.mission;
      changed = true;
    }
    for (const id in remote.boards) {
      const r = remote.boards[id], l = state.boards[id];
      if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { state.boards[id] = r; changed = true; }
    }
    return changed;
  }

  let pushTimer = null;
  function pushBoard(b) {
    if (syncMode !== 'server' || !b) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      fetch(apiUrl('api/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: b })
      }).catch(function () {});
    }, 300);
  }

  /* 服务器重启/重部署会丢数据：把本机手上的板子补回去 */
  function recoverBoards(remoteBoards) {
    if (syncMode !== 'server') return 0;
    let n = 0;
    Object.keys(state.boards).forEach(function (id) {
      const b = state.boards[id], rB = (remoteBoards || {})[id];
      if (!rB || (b.updatedAt || 0) > (rB.updatedAt || 0)) { pushBoardNow(b); n++; }
    });
    return n;
  }

  function pushBoardNow(b) {
    if (syncMode !== 'server' || !b) return;
    fetch(apiUrl('api/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board: b })
    }).catch(function () {});
  }

  function pushMission(m) {
    if (syncMode !== 'server') return;
    fetch(apiUrl('api/mission'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission: m })
    }).catch(function () {});
  }

  async function pull() {
    if (syncMode !== 'server') return;
    try {
      const r = await fetch(apiUrl('api/state'), { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      classInfo = data['class'] || classInfo;
      classListCache = data.classes || classListCache;
      if (data.caps) caps.ocr = !!data.caps.ocr;
      recoverBoards(data.boards);
      if (mergeRemote(data)) {
        persist();
        if (currentView === 'wall') renderWall(true);
        else if (currentView === 'books') renderBooks();
      }
    } catch (e) {}
  }

  /* ---------------- 声音 ---------------- */
  let actx = null;
  function ac() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    return actx;
  }
  function tone(freq, dur, type, vol, delay) {
    const a = ac(); if (!a) return;
    const t0 = a.currentTime + (delay || 0);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol == null ? 0.07 : vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function sfx(kind) {
    if (!soundOn) return;
    if (kind === 'pop') { tone(660, 0.12, 'triangle', 0.06); tone(990, 0.16, 'triangle', 0.05, 0.06); }
    else if (kind === 'bingo') { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.28, 'triangle', 0.07, i * 0.09)); }
    else if (kind === 'tap') { tone(440, 0.06, 'sine', 0.03); }
    else if (kind === 'sad') { tone(300, 0.14, 'sine', 0.05); tone(220, 0.2, 'sine', 0.05, 0.1); }
  }

  /* ---------------- 彩纸 ---------------- */
  const fx = document.getElementById('fx');
  const fxc = fx.getContext('2d');
  let parts = [], rafId = null, dpr = 1;

  function fxResize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.width = innerWidth * dpr; fx.height = innerHeight * dpr;
    fx.style.width = innerWidth + 'px'; fx.style.height = innerHeight + 'px';
    fxc.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fxResize();
  addEventListener('resize', fxResize);

  const CONF_COLORS = ['#E23B2E', '#F2C230', '#1D5FA6', '#1E7B45', '#EE7B25', '#2E8FCB', '#8E7CC3'];

  function burst(x, y, n) {
    n = n || 60;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 7;
      parts.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3,
        w: 5 + Math.random() * 7, h: 7 + Math.random() * 9,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35,
        c: CONF_COLORS[(Math.random() * CONF_COLORS.length) | 0], life: 1
      });
    }
    if (!rafId) loop();
  }
  function rain(n) {
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * innerWidth, y: -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3,
        w: 5 + Math.random() * 8, h: 8 + Math.random() * 10,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        c: CONF_COLORS[(Math.random() * CONF_COLORS.length) | 0], life: 1
      });
    }
    if (!rafId) loop();
  }
  function loop() {
    fxc.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vy += 0.18; p.vx *= 0.995; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if (p.y > innerHeight + 30 || p.life <= 0) { parts.splice(i, 1); continue; }
      fxc.save(); fxc.translate(p.x, p.y); fxc.rotate(p.rot);
      fxc.fillStyle = p.c; fxc.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      fxc.restore();
    }
    if (parts.length) { rafId = requestAnimationFrame(loop); }
    else { rafId = null; fxc.clearRect(0, 0, innerWidth, innerHeight); }
  }

  /* ---------------- 提示 ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /* ---------------- 数据操作 ---------------- */
  function newBoard(name, avatar) {
    const cells = CELLS.map(function (c) {
      return { theme: c.short, book: null, lit: false, color: c.color, poolId: 'c' + c.no };
    });
    const seat = Object.keys(state.boards).length + 1;
    const b = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name, avatar: avatar, seat: seat,
      cells: cells, linesDone: [],
      createdAt: Date.now(), updatedAt: Date.now()
    };
    state.boards[b.id] = b;
    persist(); pushBoard(b);
    return b;
  }
  function getBoard(id) { return state.boards[id] || null; }

  /* 旧数据（5×5 / 25 格）迁移到 4×4 */
  function migrateBoards() {
    let changed = false;
    Object.keys(state.boards).forEach(function (id) {
      const b = state.boards[id];
      if (!b || !Array.isArray(b.cells) || b.cells.length === TOTAL) return;
      const byPool = {}, byTheme = {};
      b.cells.forEach(function (c) {
        if (c.poolId) byPool[c.poolId] = c;
        if (c.theme) byTheme[c.theme] = c;
      });
      b.cells = CELLS.map(function (c) {
        const base = { theme: c.short, book: null, lit: false, color: c.color, poolId: 'c' + c.no };
        const src = byPool[base.poolId] || byTheme[c.short];
        if (src && src.book) { base.book = src.book; base.lit = true; }
        return base;
      });
      b.linesDone = [];
      b.updatedAt = Date.now();
      if (syncMode === 'server') pushBoard(b);
      changed = true;
    });
    if (changed) persist();
  }
  function cellColor(cell, idx) { return COLORS[(cell && cell.color) || CELLS[idx].color]; }
  function poolOf(cell, idx) {
    if (cell && cell.poolId === null) return null;            // 自己写的题目
    if (cell && cell.poolId && POOL_BY_ID[cell.poolId]) return POOL_BY_ID[cell.poolId];
    return POOL_BY_ID['c' + (idx + 1)] || null;               // 老数据 / 经典格
  }
  function booksFor(cell, idx) { const p = poolOf(cell, idx); return (p && p.books) || []; }
  function saveBoard(b) { b.updatedAt = Date.now(); state.boards[b.id] = b; persist(); pushBoard(b); }

  function boardStats(b) {
    const lit = b.cells.filter(function (c) { return c.lit; }).length;
    const lines = [];
    LINES.forEach(function (l, i) {
      if (l.every(function (x) { return b.cells[x].lit; })) lines.push(i);
    });
    return { lit: lit, lines: lines };
  }
  function lineOfCell(b, idx) {
    const out = [];
    LINES.forEach(function (l, i) { if (l.indexOf(idx) >= 0 && l.every(function (x) { return b.cells[x].lit; })) out.push(i); });
    return out;
  }

  /* ---------------- 通用片段 ---------------- */
  function ringHTML(pct, color) {
    const r = 13, c = 2 * Math.PI * r;
    return '<svg class="ring" viewBox="0 0 30 30">' +
      '<circle cx="15" cy="15" r="' + r + '" fill="none" stroke="#EDE4D3" stroke-width="5"/>' +
      '<circle cx="15" cy="15" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="5" stroke-linecap="round" ' +
      'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - pct)).toFixed(1) + '" transform="rotate(-90 15 15)"/>' +
      '</svg>';
  }

  /* ---------------- 路由 ---------------- */
  if (/[?&]list=1/.test(location.search)) store.set('bingo.list', '1');

  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    if (h.indexOf('/board/') === 0) renderBoard(h.slice(7));
    else if (h.indexOf('/design/') === 0) renderDesign(h.slice(8));
    else if (h === '/admin') renderAdmin();
    else if (h === '/books') renderBooks();
    else if (h === '/wall') renderWall();
    else renderEntry();
    window.scrollTo(0, 0);
  }
  addEventListener('hashchange', route);

  /* ===========================================================
     入场页
     =========================================================== */
  function renderEntry() {
    currentView = 'entry';
    const boards = Object.values(state.boards).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    const mine = me && state.boards[me];

    let seatHTML = '';
    for (let i = 0; i < SEATS; i++) {
      const b = boards[i];
      if (b) {
        const st = boardStats(b);
        seatHTML += '<button class="seat" data-id="' + b.id + '">' +
          '<span class="num">' + (i + 1) + '</span>' +
          '<span class="em">' + b.avatar + '</span>' +
          '<span class="nm">' + esc(b.name) + '</span>' +
          '<span class="pg">' + st.lit + '/' + TOTAL + ' · ' + st.lines.length + ' 线</span></button>';
      } else {
        seatHTML += '<div class="seat empty"><span class="num">' + (i + 1) + '</span>' +
          '<span class="em">＋</span><span class="nm">空位</span><span class="pg">等你来</span></div>';
      }
    }

    const avHTML = AVATARS.map(function (a, i) {
      return '<button class="avatar-pick' + (i === 0 ? ' on' : '') + '" data-av="' + a + '">' + a + '</button>';
    }).join('');

    $('#app').innerHTML =
      '<div class="entry">' +
        '<div class="logo"><span>B</span><span>i</span><span>N</span><span>G</span><span>O</span></div>' +
        '<div class="logo-title">阅读大挑战</div>' +
        '<div class="logo-sub">' + TOTAL + ' 个格子 · 读完就点亮 · 连成一条线就 BINGO！</div>' +
        (classInfo ? '<div class="class-badge">📚 ' + esc(classInfo.name) + '</div>' : '') +

        (mine ? '<div style="text-align:center;margin-bottom:18px">' +
          '<button class="btn green" id="continue" style="font-size:17px;padding:14px 26px">继续我的挑战 · ' + mine.avatar + ' ' + esc(mine.name) + ' →</button>' +
        '</div>' : '') +

        '<div class="card">' +
          '<div class="field"><label>你的名字</label>' +
            '<input id="name" type="text" placeholder="写上名字或小名（2-8 个字）" maxlength="8" autocomplete="off" enterkeyhint="done"></div>' +
          '<div class="field"><label>挑一个头像</label><div class="avatar-row" id="avs">' + avHTML + '</div></div>' +
          '<button class="btn red" id="start" style="width:100%;font-size:17px;padding:14px">开始我的阅读挑战 →</button>' +
        '</div>' +

        '<div class="card">' +
          '<div class="field" style="margin-bottom:10px"><label style="margin:0">已有座位（' + boards.length + '/' + SEATS + '）</label></div>' +
          '<div class="seats" id="seats">' + seatHTML + '</div>' +
          '<div class="hint" style="margin-top:12px">' +
            (syncMode === 'server'
              ? '已经有人坐下的座位，点一下就能接着玩；用同一台设备时数据会自动保存。'
              : '点自己的座位就能接着玩。数据存在这台设备上；想 15 台设备一起玩，用 <b>启动同步服务</b> 的方式打开。') +
          '</div>' +
        '</div>' +

        '<div style="text-align:center;margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
          '<button class="btn ghost small" id="wallLink">看看全班大屏 👥</button>' +
          '<button class="btn ghost small" id="adminLink">老师后台 ⚙️</button>' +
          '<button class="btn ghost small" id="soundBtn">' + (soundOn ? '🔊 声音开' : '🔇 声音关') + '</button>' +
        '</div>' +
      '</div>';

    let picked = AVATARS[0];
    $$('.avatar-pick').forEach(function (el) {
      el.addEventListener('click', function () {
        $$('.avatar-pick').forEach((x) => x.classList.remove('on'));
        el.classList.add('on'); picked = el.dataset.av; sfx('tap');
      });
    });

    $('#start').addEventListener('click', function () {
      const name = ($('#name').value || '').trim();
      if (!name) { $('#name').focus(); toast('先写上你的名字吧'); return; }
      const exist = Object.values(state.boards).filter(function (b) { return b.name === name; })[0];
      if (exist) { enterBoard(exist.id); return; }
      if (Object.keys(state.boards).length >= SEATS) { toast('座位满了，可以先用「看主题」模式玩'); }
      const b = newBoard(name, picked);
      enterBoard(b.id);
    });

    $('#name').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#start').click(); });

    if (mine) $('#continue').addEventListener('click', function () { enterBoard(mine.id); });

    $$('.seat[data-id]').forEach(function (el) {
      el.addEventListener('click', function () { enterBoard(el.dataset.id); });
    });

    $('#wallLink').addEventListener('click', function () { location.hash = '/wall'; });
    $('#adminLink').addEventListener('click', function () { location.hash = '/admin'; });
    $('#soundBtn').addEventListener('click', function () {
      soundOn = !soundOn; store.set(LS_SOUND, soundOn ? '1' : '0');
      this.textContent = soundOn ? '🔊 声音开' : '🔇 声音关'; if (soundOn) sfx('tap');
    });
  }

  function enterBoard(id) {
    me = id; store.set(LS_ME, id);
    sfx('tap');
    location.hash = '/board/' + id;
  }

  /* ===========================================================
     棋盘页
     =========================================================== */
  function cellHTML(cell, i) {
    const col = cellColor(cell, i);
    const lit = !!cell.lit;
    const flipped = lit && viewMode === 'book';
    const theme = esc(cell.theme);
    const book = cell.book;

    const backInner = lit && book
      ? '<span class="num">' + (i + 1) + '</span>' +
        '<span class="bt">《' + esc(book.t) + '》</span>' +
        '<span class="tiny">' + theme + '</span>' +
        '<span class="stamp">✅</span>'
      : '<span class="num">' + (i + 1) + '</span>' +
        '<span class="bt" style="opacity:.55">还没读</span>' +
        '<span class="tiny">' + theme + '</span>';

    return '<button class="cell' + (lit ? ' lit' : '') + '" data-i="' + i + '" aria-pressed="' + lit + '" ' +
      'style="--main:' + col.main + ';--soft:' + col.soft + ';--ink-on:' + col.ink + '">' +
      '<div class="inner' + (flipped ? ' flipped' : '') + '">' +
        '<div class="face front">' +
          '<span class="num">' + (i + 1) + '</span>' +
          '<span class="theme">' + theme + '</span>' +
          (lit && book ? '<span class="bt">《' + esc(book.t) + '》</span>' : '') +
          (lit ? '' : '<span class="dots">· · ·</span>') +
        '</div>' +
        '<div class="face back">' + backInner + '</div>' +
      '</div>' +
    '</button>';
  }

  function applyMissionToBoard(b, m, onlyUnread) {
    (m.cells || []).forEach(function (mc, i) {
      const c = b.cells[i];
      if (!c) return;
      if (onlyUnread && c.lit) return;
      c.theme = mc.theme;
      c.poolId = mc.poolId || null;
      c.color = c.color || CELLS[i].color;
    });
    b.missionId = m.id;
    b.missionAt = m.updatedAt || 0;
    b.missionTitle = m.title || '班级书单';
    saveBoard(b);
  }

  function renderBoard(id) {
    const b = getBoard(id);
    if (!b) { location.hash = ''; return; }
    me = id; store.set(LS_ME, id);
    currentView = 'board';

    // 老师布置的任务：还没开始就直接换上；已经在读的给一条提示
    let pendingMission = null;
    const mission = (state.mission && Array.isArray(state.mission.cells) && state.mission.cells.length === TOTAL)
      ? state.mission : null;
    if (mission && (b.missionAt || 0) < (mission.updatedAt || 0)) {
      if (boardStats(b).lit === 0) {
        applyMissionToBoard(b, mission, false);
        setTimeout(function () { toast('老师布置了「' + (mission.title || '班级书单') + '」'); }, 300);
      } else if (b.missionDismiss !== mission.id) {
        pendingMission = mission;
      }
    }

    const st = boardStats(b);
    const pct = st.lit / TOTAL;

    $('#app').innerHTML =
      '<div class="topbar">' +
        '<button class="icon-btn" id="back" title="回到入口">←</button>' +
        '<div class="who"><div class="avatar">' + b.avatar + '</div>' +
          '<div><div class="nm">' + esc(b.name) + '</div><div class="sub">第 ' + (b.seat || 1) + ' 号座位</div></div>' +
        '</div>' +
        '<div class="spacer"></div>' +
        '<div class="progress-pill">' + ringHTML(pct, pct >= 1 ? '#F5B301' : '#1E7B45') +
          '<span id="pillText">' + st.lit + '/' + TOTAL + '</span></div>' +
        '<button class="icon-btn" id="shelf" title="我的书单">📚</button>' +
        '<button class="icon-btn" id="wall" title="全班大屏">👥</button>' +
      '</div>' +

      '<div class="board-wrap">' +
        '<div class="board-head">' +
          '<h2>我的阅读大挑战</h2>' +
          (b.missionTitle ? '<span class="mission-chip">📌 ' + esc(b.missionTitle) + '</span>' : '') +
          '<div class="chip-row">' +
            '<button class="chip" id="designBtn">✏️ 换题</button>' +
            '<button class="chip' + (viewMode === 'book' ? ' on' : '') + '" data-mode="book">看书名</button>' +
            '<button class="chip' + (viewMode === 'theme' ? ' on' : '') + '" data-mode="theme">看主题</button>' +
            '<button class="chip" id="soundToggle">' + (soundOn ? '🔊' : '🔇') + '</button>' +
            '<button class="chip" id="listToggle">☰ 清单</button>' +
            '<button class="chip" id="printBtn">打印</button>' +
          '</div>' +
        '</div>' +
        (store.get('bingo.tip') === '1' ? '' :
          '<div class="tip" id="boardTip"><span>题目都能换：点「✏️ 换题」自己设计，或者随机来一套。</span>' +
          '<button id="tipClose">知道了</button></div>') +
        (pendingMission
          ? '<div class="mission-bar">' +
              '<span>📌 老师布置了「' + esc(pendingMission.title || '班级书单') + '」</span>' +
              '<button class="btn small red" id="mApply">换成新题目</button>' +
              '<button class="btn small ghost" id="mLater">先不了</button>' +
            '</div>'
          : '') +
        '<div class="grid">' + b.cells.map(cellHTML).join('') + '</div>' +
        '<div class="board-foot">' +
          '<span class="legend"><i style="background:#F5B301"></i> 金边 = 这条线已经连成</span>' +
          '<span>·</span>' +
          '<span>点一下格子，记下你读的书</span>' +
          '<span style="margin-left:auto" id="linesText">' + st.lines.length + ' 条 BINGO</span>' +
        '</div>' +
      '</div>';

    $$('.cell').forEach(function (el) {
      el.addEventListener('click', function () { openSheet(b, parseInt(el.dataset.i, 10), el); });
    });
    $('#back').addEventListener('click', function () { location.hash = ''; });
    $('#shelf').addEventListener('click', function () { openShelf(b); });
    $('#wall').addEventListener('click', function () { location.hash = '/wall'; });
    $('#printBtn').addEventListener('click', function () { window.print(); });
    $('#designBtn').addEventListener('click', function () { location.hash = '/design/' + b.id; });
    const tipClose = $('#tipClose');
    if (tipClose) tipClose.addEventListener('click', function () {
      store.set('bingo.tip', '1');
      const t = $('#boardTip'); if (t) t.remove();
    });
    const listBtn = $('#listToggle');
    if (listBtn) {
      const on = store.get('bingo.list') === '1';
      document.body.classList.toggle('list-mode', on);
      listBtn.classList.toggle('on', on);
      listBtn.addEventListener('click', function () {
        const now = !document.body.classList.contains('list-mode');
        document.body.classList.toggle('list-mode', now);
        store.set('bingo.list', now ? '1' : '0');
        listBtn.classList.toggle('on', now);
      });
    }
    $('#soundToggle').addEventListener('click', function () {
      soundOn = !soundOn; store.set(LS_SOUND, soundOn ? '1' : '0');
      this.textContent = soundOn ? '🔊' : '🔇'; if (soundOn) sfx('tap');
    });
    $$('.chip[data-mode]').forEach(function (el) {
      el.addEventListener('click', function () {
        viewMode = el.dataset.mode; store.set(LS_VIEW, viewMode);
        $$('.chip[data-mode]').forEach((x) => x.classList.toggle('on', x === el));
        applyViewMode();
        sfx('tap');
      });
    });

    if (pendingMission) {
      $('#mApply').addEventListener('click', function () {
        applyMissionToBoard(b, pendingMission, true);
        sfx('pop');
        toast('换上啦，已经读过的书都保留着');
        renderBoard(b.id);
      });
      $('#mLater').addEventListener('click', function () {
        b.missionDismiss = pendingMission.id;
        saveBoard(b);
        const bar = $('.mission-bar'); if (bar) bar.remove();
      });
    }

    refreshLines(b);

    requestAnimationFrame(function () {
      // 首次进入时，已点亮的格子轻微错峰翻转，像翻书
      const lit = $$('.cell.lit');
      lit.forEach(function (el, i) {
        const inner = el.querySelector('.inner');
        inner.style.transitionDelay = (i * 22) + 'ms';
        setTimeout(function () { inner.style.transitionDelay = ''; }, 800);
      });
    });
  }

  function applyViewMode() {
    $$('.cell').forEach(function (el) {
      const inner = el.querySelector('.inner');
      if (!inner) return;
      const lit = el.classList.contains('lit');
      inner.classList.toggle('flipped', lit && viewMode === 'book');
    });
  }

  function refreshCell(b, idx) {
    const el = $('.cell[data-i="' + idx + '"]');
    if (!el) return;
    const cell = b.cells[idx];
    const col = cellColor(cell, idx);
    el.classList.toggle('lit', !!cell.lit);
    el.setAttribute('aria-pressed', !!cell.lit);
    el.style.setProperty('--main', col.main);
    el.style.setProperty('--soft', col.soft);
    el.style.setProperty('--ink-on', col.ink);

    const front = el.querySelector('.front');
    const back = el.querySelector('.back');
    front.innerHTML = '<span class="num">' + (idx + 1) + '</span>' +
      '<span class="theme">' + esc(cell.theme) + '</span>' +
      (cell.lit && cell.book ? '<span class="bt">《' + esc(cell.book.t) + '》</span>' : '') +
      (cell.lit ? '' : '<span class="dots">· · ·</span>');
    if (cell.lit && cell.book) {
      back.innerHTML = '<span class="num">' + (idx + 1) + '</span>' +
        '<span class="bt">《' + esc(cell.book.t) + '》</span>' +
        '<span class="tiny">' + esc(cell.theme) + '</span>' +
        '<span class="stamp">✅</span>';
    } else {
      back.innerHTML = '<span class="num">' + (idx + 1) + '</span>' +
        '<span class="bt" style="opacity:.55">还没读</span>' +
        '<span class="tiny">' + esc(cell.theme) + '</span>';
    }
    const inner = el.querySelector('.inner');
    inner.classList.toggle('flipped', cell.lit && viewMode === 'book');

    el.classList.remove('flash');
    void el.offsetWidth;
    if (cell.lit) el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 900);

    refreshLines(b);
  }

  function refreshLines(b) {
    const st = boardStats(b);
    $$('.cell').forEach(function (el) {
      const i = parseInt(el.dataset.i, 10);
      el.classList.toggle('in-line', lineOfCell(b, i).length > 0);
    });
    const pill = $('#pillText');
    if (pill) pill.textContent = st.lit + '/' + TOTAL;
    const lt = $('#linesText');
    if (lt) lt.textContent = st.lines.length + ' 条 BINGO';
    const ring = $('.progress-pill .ring');
    if (ring) {
      const pct = st.lit / TOTAL, r = 13, c = 2 * Math.PI * r;
      const circles = ring.querySelectorAll('circle');
      circles[1].setAttribute('stroke', pct >= 1 ? '#F5B301' : '#1E7B45');
      circles[1].setAttribute('stroke-dashoffset', (c * (1 - pct)).toFixed(1));
    }
  }

  /* ===========================================================
     记录一本书的底部抽屉
     =========================================================== */
  let sheetEl = null;

  function closeSheet() {
    if (!sheetEl) return;
    const s = sheetEl;
    sheetEl = null;
    s.classList.remove('show');
    $('#backdrop').classList.remove('show');
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 320);
  }


  /* ===========================================================
     拍照 / 认字
     =========================================================== */
  function readAndShrink(dataUrl, max, cb) {
    const img = new Image();
    img.onload = function () {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
  }

  function shrinkToThumb(dataUrl, max) {
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  function pickImage(mode, cb, allowLive) {
    const secure = location.protocol === 'https:' ||
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (mode === 'camera' && allowLive !== false && secure &&
        navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      openCameraLive(cb);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (mode === 'camera') input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      const f = input.files && input.files[0];
      setTimeout(function () { input.remove(); }, 0);
      if (!f) return;
      const fr = new FileReader();
      fr.onload = function () { readAndShrink(fr.result, 1500, cb); };
      fr.readAsDataURL(f);
    });
    input.click();
  }

  function openCameraLive(cb) {
    const ov = document.createElement('div');
    ov.className = 'cam';
    ov.innerHTML =
      '<video autoplay playsinline muted></video>' +
      '<div class="cam-tip">把书的封面放进取景框</div>' +
      '<div class="cam-bar">' +
        '<button class="cam-x">✕ 取消</button>' +
        '<button class="cam-snap" aria-label="拍照"></button>' +
        '<button class="cam-album">相册</button>' +
      '</div>';
    document.body.appendChild(ov);
    const video = ov.querySelector('video');
    let stream = null;
    let done = false;

    function close() {
      if (done) return;
      done = true;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      ov.remove();
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } })
      .then(function (s) { stream = s; video.srcObject = s; video.play().catch(function () {}); })
      .catch(function () { close(); pickImage('camera', cb, false); });

    ov.querySelector('.cam-x').addEventListener('click', close);
    ov.querySelector('.cam-album').addEventListener('click', function () {
      close(); setTimeout(function () { pickImage('album', cb); }, 60);
    });
    ov.querySelector('.cam-snap').addEventListener('click', function () {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return;
      const scale = Math.min(1, 1500 / Math.max(vw, vh));
      const c = document.createElement('canvas');
      c.width = Math.round(vw * scale);
      c.height = Math.round(vh * scale);
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.86);
      close();
      cb(url);
    });
  }

  async function ocrImage(dataUrl) {
    if (syncMode !== 'server') {
      toast('认字要连上同步服务；照片先留着');
      return null;
    }
    try {
      const r = await fetch(apiUrl('api/ocr'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl })
      });
      if (!r.ok) { toast('没认出来，换张清楚点的试试'); return null; }
      return await r.json();
    } catch (e) {
      toast('认字服务没连上');
      return null;
    }
  }

  async function uploadPhoto(dataUrl) {
    if (syncMode === 'server') {
      try {
        const r = await fetch(apiUrl('api/photo'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl })
        });
        if (r.ok) { const j = await r.json(); return j.url; }
      } catch (e) {}
    }
    return dataUrl;
  }

  function showOcrResult(out, lines, input) {
    if (!lines) {
      out.innerHTML = '<div class="ocr-fail">没认出字，换个光线再拍一次？</div>';
      return;
    }
    const cands = titleCandidates(lines);
    if (!cands.length) {
      out.innerHTML = '<div class="ocr-fail">照片里没找到书名，试着只拍封面中间的大字</div>';
      return;
    }
    out.innerHTML = '<div class="ocr-label">照片里读到：</div><div class="ocr-cands">' +
      cands.map(function (t) { return '<button class="ocr-cand" type="button">《' + esc(t) + '》</button>'; }).join('') +
      '</div>';
    $$('.ocr-cand', out).forEach(function (b) {
      b.addEventListener('click', function () {
        if (input) input.value = b.textContent.replace(/^《/, '').replace(/》$/, '');
        out.innerHTML = '<div class="ocr-ok">书名填好啦 ✓ 不对的话直接改上面的字</div>';
        sfx('pop');
      });
    });
  }

  /* 从识别结果里猜书名：挑大字号的行，相邻的拼起来 */
  function titleCandidates(lines) {
    if (!lines || !lines.length) return [];
    const clean = lines.filter(function (l) { return l.text && l.text.trim(); });
    if (!clean.length) return [];
    let maxH = 0;
    clean.forEach(function (l) { maxH = Math.max(maxH, l.h || 0); });
    const noise = /(著|绘|译|编|出版社|出版|ISBN|定价|第.{1,3}版|丛书|系列|图书|版权所有)/;

    const big = clean
      .filter(function (l) { return (l.h || 0) >= maxH * 0.45; })
      .filter(function (l) { return !noise.test(l.text) && !/^\d+$/.test(l.text.trim()); })
      .sort(function (a, b) { return a.y - b.y; });

    const groups = [];
    big.forEach(function (l) {
      const g = groups[groups.length - 1];
      if (g) {
        const last = g[g.length - 1];
        const gap = l.y - (last.y + last.h);
        const ratio = (l.h || 0.01) / (last.h || 0.01);
        if (gap < last.h * 0.95 && ratio > 0.6 && ratio < 1.7) { g.push(l); return; }
      }
      groups.push([l]);
    });

    const out = [];
    groups.forEach(function (g) {
      const t = g.map(function (x) { return x.text.trim(); }).join('').replace(/\s+/g, '');
      if (t) out.push(t);
    });
    big.forEach(function (l) {
      const t = l.text.trim().replace(/\s+/g, '');
      if (t) out.push(t);
    });

    const seen = {};
    return out
      .filter(function (t) { return t.length >= 2 && t.length <= 24; })
      .filter(function (t) { if (seen[t]) return false; seen[t] = 1; return true; })
      .slice(0, 3);
  }

  function openSheet(b, idx, cellEl) {
    const cell = b.cells[idx];
    const meta = CELLS[idx];
    const col = cellColor(cell, idx);
    const pool = poolOf(cell, idx);
    const isFree = !!meta.free && !pool;
    const suggestions = booksFor(cell, idx).filter(function (x) { return x.t; });

    closeSheet();

    const s = document.createElement('div');
    s.className = 'sheet';
    s.innerHTML =
      '<div class="grip"></div>' +
      '<div class="sheet-head">' +
        '<div class="tag" style="background:' + col.main + ';color:' + col.ink + '">' + (idx + 1) + '</div>' +
        '<div><div class="ttl">' + esc(cell.theme) + '</div>' +
        '<div class="sub">' + (pool ? esc(pool.full) : '你自己定的题目') +
          (cell.lit ? ' · 已经点亮' : '') + '</div></div>' +
        '<button class="icon-btn close" id="sheetClose">✕</button>' +
      '</div>' +

      '<div class="field"><label>这一格的主题（可以自己改）</label>' +
        '<input id="fTheme" type="text" maxlength="14" value="' + esc(cell.theme) + '" placeholder="' + (isFree ? '这一格由你定题，比如「一本关于朋友的书」' : '写一个你自己的题目') + '">' +
      '</div>' +

      '<div class="divider">我读的书</div>' +

      '<div class="field">' +
        '<div class="label-row"><label>书名</label>' +
          ((syncMode === 'server' && caps.ocr)
            ? '<button class="shot-btn" id="ocrBtn" type="button">📷 拍封面识字</button>'
            : '') + '</div>' +
        '<input id="fTitle" type="text" maxlength="30" value="' + (cell.book ? esc(cell.book.t) : '') + '" placeholder="比如：团圆">' +
        '<div class="ocr-out" id="ocrOut"></div>' +
        (suggestions.length ? '<div class="suggest"><span class="sug-label">推荐</span>' + suggestions.map(function (x, i) {
          return '<button class="sug" data-t="' + esc(x.t) + '" data-a="' + esc(x.a || '') + '">《' + esc(x.t) + '》</button>';
        }).join('') + '</div>' : '') +
      '</div>' +

      '<div class="field" style="display:flex;gap:10px">' +
        '<div style="flex:1"><label>作者 / 绘者</label><input id="fAuthor" type="text" maxlength="24" value="' + (cell.book && cell.book.a ? esc(cell.book.a) : '') + '" placeholder="可以不填"></div>' +
        '<div style="width:44%"><label>读完的日子</label><input id="fDate" type="date" value="' + (cell.book && cell.book.d ? esc(cell.book.d) : todayStr()) + '"></div>' +
      '</div>' +

      '<div class="field"><label>一句话感受（不写也行，也可以拍下来）</label>' +
        '<textarea id="fNote" maxlength="60" placeholder="最喜欢哪一页？">' + (cell.book && cell.book.note ? esc(cell.book.note) : '') + '</textarea>' +
        '<div class="photo-row">' +
          '<button class="shot-btn" id="photoBtn" type="button">📷 拍下这一页</button>' +
          '<div class="photo-prev" id="photoPrev"></div>' +
        '</div>' +
      '</div>' +

      '<div class="field"><label>打几颗星</label><div class="stars" id="stars">' +
        [1, 2, 3, 4, 5].map(function (n) {
          const on = cell.book && cell.book.stars ? n <= cell.book.stars : false;
          return '<button class="star' + (on ? ' on' : '') + '" data-n="' + n + '">★</button>';
        }).join('') +
      '</div></div>' +

      '<div class="sheet-actions">' +
        (cell.lit ? '<button class="btn ghost" id="unlight">取消点亮</button>' : '') +
        '<button class="btn red" id="lightUp">' + (cell.lit ? '保存修改' : '点亮这一格 ✨') + '</button>' +
      '</div>';

    document.body.appendChild(s);
    sheetEl = s;
    $('#backdrop').classList.add('show');
    requestAnimationFrame(function () { s.classList.add('show'); });

    let stars = cell.book && cell.book.stars ? cell.book.stars : 0;
    let photoUrl = (cell.book && cell.book.photo) || '';

    function renderPhoto() {
      const box = $('#photoPrev', s);
      if (!box) return;
      box.innerHTML = photoUrl
        ? '<img src="' + esc(photoUrl) + '" alt="拍下的这一页"><button class="photo-x" id="photoX" type="button">✕</button>'
        : '';
      const x = $('#photoX', s);
      if (x) x.addEventListener('click', function () { photoUrl = ''; renderPhoto(); });
    }
    renderPhoto();

    $('#photoBtn', s).addEventListener('click', function () {
      pickImage('camera', function (dataUrl) {
        shrinkToThumb(dataUrl, 420).then(function (thumb) {
          return uploadPhoto(thumb).then(function (url) {
            photoUrl = url; renderPhoto(); sfx('pop'); toast('照片放好啦');
          });
        });
      });
    });

    const ocrBtnEl = $('#ocrBtn', s);
    if (ocrBtnEl) ocrBtnEl.addEventListener('click', function () {
      pickImage('camera', function (dataUrl) {
        const out = $('#ocrOut', s);
        out.innerHTML = '<div class="ocr-loading">正在认字…</div>';
        ocrImage(dataUrl).then(function (res) {
          showOcrResult(out, res ? res.lines : null, $('#fTitle', s));
        });
      });
    });

    $$('.star', s).forEach(function (el) {
      el.addEventListener('click', function () {
        const n = parseInt(el.dataset.n, 10);
        stars = (stars === n) ? 0 : n;
        $$('.star', s).forEach(function (x) {
          x.classList.toggle('on', parseInt(x.dataset.n, 10) <= stars);
        });
        sfx('tap');
      });
    });

    $$('.sug', s).forEach(function (el) {
      el.addEventListener('click', function () {
        $('#fTitle', s).value = el.dataset.t;
        if (el.dataset.a) $('#fAuthor', s).value = el.dataset.a;
        sfx('tap');
      });
    });

    $('#sheetClose', s).addEventListener('click', closeSheet);
    $('#backdrop').addEventListener('click', closeSheet, { once: true });

    if (cell.lit) {
      $('#unlight', s).addEventListener('click', function () {
        cell.lit = false;
        cell.book = null;
        saveBoard(b);
        closeSheet();
        refreshCell(b, idx);
        sfx('sad');
        toast('这一格又空出来啦');
      });
    }

    $('#lightUp', s).addEventListener('click', function () {
      const t = ($('#fTitle', s).value || '').trim();
      if (!t) { $('#fTitle', s).focus(); toast('先写上书名吧'); return; }
      const theme = ($('#fTheme', s).value || '').trim() || CELLS[idx].short;
      const curPool = poolOf(cell, idx);
      if (!curPool || theme !== curPool.short) cell.poolId = null;

      cell.theme = theme;
      cell.book = {
        t: t,
        a: ($('#fAuthor', s).value || '').trim(),
        d: $('#fDate', s).value || todayStr(),
        note: ($('#fNote', s).value || '').trim(),
        photo: photoUrl || '',
        stars: stars
      };
      const wasLit = cell.lit;
      cell.lit = true;

      const prevLines = (b.linesDone || []).slice();
      const st = boardStats(b);
      const added = st.lines.filter(function (x) { return prevLines.indexOf(x) < 0; });
      b.linesDone = st.lines;
      saveBoard(b);
      closeSheet();
      refreshCell(b, idx);

      const r = cellEl ? cellEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
      burst(r.left + r.width / 2, r.top + r.height / 2, 34);
      sfx('pop');

      if (added.length) {
        setTimeout(function () { celebrate(added, b); }, 420);
      } else if (!wasLit && st.lit === TOTAL) {
        setTimeout(function () { celebrateAll(b); }, 420);
      }
    });
  }

  /* ===========================================================
     庆祝
     =========================================================== */
  function celebrate(lines, b) {
    const all = boardStats(b).lit === TOTAL;
    if (all) { celebrateAll(b); return; }
    const names = lines.map(function (i) { return LINE_NAMES[i]; }).join('、');
    showCelebrate({
      word: 'BINGO!',
      small: '连成线啦',
      emoji: '🎉',
      msg: '你连成了 <b>' + names + '</b><br>已经读完 <b>' + boardStats(b).lit + '</b> 本，还有 ' + (TOTAL - boardStats(b).lit) + ' 格',
      btn: '再来一条！'
    });
    sfx('bingo');
    rain(90);
  }

  function celebrateAll(b) {
    showCelebrate({
      word: '全部读完!',
      small: TOTAL + ' / ' + TOTAL,
      emoji: '🏆',
      msg: '<b>' + esc(b.name) + '</b> 读完了 ' + TOTAL + ' 本书<br>这张卡，是你的了。',
      btn: '看看我的书单',
      onBtn: function () { openShelf(b); }
    });
    sfx('bingo');
    setTimeout(function () { rain(140); }, 200);
  }

  function showCelebrate(o) {
    const el = $('#celebrate');
    el.innerHTML = '<div class="box">' +
      '<div class="emoji">' + (o.emoji || '🎉') + '</div>' +
      '<div class="word">' + o.word + '<small>' + (o.small || '') + '</small></div>' +
      '<div class="msg">' + (o.msg || '') + '</div>' +
      '<button class="btn gold" id="celBtn">' + (o.btn || '继续') + '</button>' +
      '</div>';
    el.classList.add('show');
    const close = function () { el.classList.remove('show'); };
    $('#celBtn').addEventListener('click', function () { close(); if (o.onBtn) o.onBtn(); });
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
  }

  /* ===========================================================
     我的书单
     =========================================================== */
  function openShelf(b) {
    const rows = b.cells.map(function (c, i) { return { c: c, i: i }; })
      .filter(function (x) { return x.c.lit && x.c.book; });
    const st = boardStats(b);

    const listHTML = rows.length
      ? '<div class="booklist">' + rows.map(function (x) {
          const col = cellColor(x.c, x.i);
          return '<div class="bk">' +
            '<div class="n" style="background:' + col.main + ';color:' + col.ink + '">' + (x.i + 1) + '</div>' +
            (x.c.book.photo ? '<img class="bk-photo" src="' + esc(x.c.book.photo) + '" alt="">' : '') +
            '<div><div class="t">《' + esc(x.c.book.t) + '》</div>' +
            '<div class="a">' + esc(x.c.book.a || '') + (x.c.book.note ? ' · ' + esc(x.c.book.note) : '') + '</div></div>' +
            '<div class="d">' + esc(x.c.book.d || '') + '</div>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="hint" style="text-align:center;padding:26px 0">还没有记录，去点亮第一格吧 ✨</div>';

    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.innerHTML = '<div class="panel">' +
      '<h3>📚 ' + esc(b.name) + ' 的阅读书单</h3>' +
      '<div class="meta">已读 ' + st.lit + ' 本 · 连成 ' + st.lines.length + ' 条线 · 完成 ' + Math.round(st.lit / TOTAL * 100) + '%</div>' +
      '<div class="scroll">' + listHTML + '</div>' +
      '<div class="acts">' +
        '<button class="btn small green" id="copyBtn">复制文字</button>' +
        '<button class="btn small ghost" id="csvBtn">下载 CSV</button>' +
        '<button class="btn small ghost" id="prnBtn">打印</button>' +
        '<button class="btn small ghost" id="closeModal" style="margin-left:auto">关闭</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(modal);

    const close = function () { modal.remove(); };
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    $('#closeModal', modal).addEventListener('click', close);

    const text = function () {
      return b.name + ' 的阅读书单（' + st.lit + '/' + TOTAL + '）\n' + rows.map(function (x) {
        return (x.i + 1) + '. 《' + x.c.book.t + '》' + (x.c.book.a ? ' ' + x.c.book.a : '') + ' ' + (x.c.book.d || '');
      }).join('\n');
    };
    $('#copyBtn', modal).addEventListener('click', function () {
      const t = text();
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast('已复制'); }, function () { toast('复制失败'); });
      else toast('这台设备不支持复制');
    });
    $('#csvBtn', modal).addEventListener('click', function () {
      let csv = '\ufeff格子,主题,书名,作者,日期,感受,星星\n';
      csv += rows.map(function (x) {
        const f = function (s) { return '"' + String(s || '').replace(/"/g, '""') + '"'; };
        return [x.i + 1, f(x.c.theme), f(x.c.book.t), f(x.c.book.a), f(x.c.book.d), f(x.c.book.note), x.c.book.stars || 0].join(',');
      }).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = b.name + '_阅读书单.csv';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    $('#prnBtn', modal).addEventListener('click', function () { window.print(); });
  }


  /* ===========================================================
     设计我的棋盘（换题 / 自己组合）
     =========================================================== */
  function designCellHTML(b, i) {
    const cell = b.cells[i];
    const col = cellColor(cell, i);
    return '<button class="cell' + (cell.lit ? ' lit' : '') + '" data-i="' + i + '" ' +
      'style="--main:' + col.main + ';--soft:' + col.soft + ';--ink-on:' + col.ink + '">' +
      '<div class="inner"><div class="face front">' +
        '<span class="num">' + (i + 1) + '</span>' +
        '<span class="theme">' + esc(cell.theme) + '</span>' +
        '<span class="edit-badge">✎</span>' +
      '</div></div></button>';
  }

  function renderDesign(id) {
    const b = getBoard(id);
    if (!b) { location.hash = ''; return; }
    me = id; store.set(LS_ME, id);
    currentView = 'design';

    $('#app').innerHTML =
      '<div class="topbar">' +
        '<button class="icon-btn" id="back">←</button>' +
        '<div class="who"><div class="nm">设计我的棋盘</div><div class="sub">' + esc(b.name) + '</div></div>' +
        '<div class="spacer"></div>' +
        '<button class="btn small green" id="done">完成</button>' +
      '</div>' +
      '<div class="board-wrap">' +
        '<div class="board-head"><h2>点一格，换一个题目</h2></div>' +
        '<div class="tip" style="margin-bottom:12px">从题库里挑，或者自己写一句；已经读完的格子，随机时不会被换掉。</div>' +
        '<div class="grid design-grid" id="dgrid">' +
          b.cells.map(function (c, i) { return designCellHTML(b, i); }).join('') +
        '</div>' +
        '<div class="design-actions">' +
          '<button class="btn ghost small" id="rndAll">🎲 随机换一套</button>' +
          '<button class="btn ghost small" id="resetAll">↩ 恢复经典版</button>' +
        '</div>' +
      '</div>';

    $$('.cell').forEach(function (el) {
      const ii = parseInt(el.dataset.i, 10);
      el.addEventListener('click', function () {
        openPicker(b.cells[ii], ii, b.cells, function () { saveBoard(b); updateDesignCell(b, ii); });
      });
    });
    $('#back').addEventListener('click', function () { location.hash = '/board/' + b.id; });
    $('#done').addEventListener('click', function () { location.hash = '/board/' + b.id; });

    $('#rndAll').addEventListener('click', function () {
      shuffleBoard(b); saveBoard(b); renderDesign(b.id); sfx('pop');
      toast('换好啦，看看喜不喜欢');
    });
    $('#resetAll').addEventListener('click', function () {
      if (!confirm('把 ' + TOTAL + ' 个题目都换回经典版？已读的书记录会保留。')) return;
      b.cells.forEach(function (c, i) { c.theme = CELLS[i].short; c.poolId = 'c' + (i + 1); });
      saveBoard(b); renderDesign(b.id); sfx('tap'); toast('已恢复经典版');
    });
  }

  function shuffleBoard(b) {
    const used = {};
    b.cells.forEach(function (c) { if (c.poolId) used[c.poolId] = 1; });
    const pool = POOL.filter(function (p) { return p.tag !== '自由'; });
    let bag = [];
    function refill() {
      bag = pool.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
      }
    }
    refill();
    b.cells.forEach(function (c, i) {
      if (i === FREE_INDEX) { c.theme = '自由格'; c.poolId = 'c' + CELLS[i].no; return; }
      if (c.lit) return;
      let p = null;
      while (bag.length) {
        const cand = bag.pop();
        if (!used[cand.id]) { p = cand; break; }
      }
      if (!p) { refill(); p = bag.pop(); }
      if (!p) return;
      used[p.id] = 1;
      c.theme = p.short; c.poolId = p.id;
    });
  }

  function updateDesignCell(b, idx) {
    const el = $('.cell[data-i="' + idx + '"]');
    if (!el) return;
    const cell = b.cells[idx];
    const t = el.querySelector('.theme');
    if (t) t.textContent = cell.theme;
    el.classList.toggle('lit', !!cell.lit);
  }

  function openPicker(cell, idx, cells, onChange) {
    onChange = onChange || function () {};
    cells = cells || [];
    const col = cellColor(cell, idx);
    let tag = '全部';

    const s = document.createElement('div');
    s.className = 'sheet picker';
    s.innerHTML =
      '<div class="grip"></div>' +
      '<div class="sheet-head">' +
        '<div class="tag" style="background:' + col.main + ';color:' + col.ink + '">' + (idx + 1) + '</div>' +
        '<div><div class="ttl">换一个题目</div><div class="sub">点一下就换上</div></div>' +
        '<button class="icon-btn close" id="pClose">✕</button>' +
      '</div>' +
      '<div class="field"><label>自己写一句</label>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="pTheme" type="text" maxlength="14" value="' + esc(cell.theme) + '" placeholder="比如：读一本有猫的书">' +
          '<button class="btn small blue" id="pUse" style="flex:none">用这个</button>' +
        '</div>' +
      '</div>' +
      '<div class="divider">或者从题库里挑</div>' +
      '<div class="chip-row" id="pTags" style="margin:0 0 10px">' +
        POOL_TAGS.map(function (t) {
          return '<button class="chip' + (t === '全部' ? ' on' : '') + '" data-tag="' + t + '">' + t + '</button>';
        }).join('') +
      '</div>' +
      '<div class="pool-list" id="pList"></div>' +
      '<div class="sheet-actions" style="margin-top:12px">' +
        '<button class="btn ghost small" id="pRand">🎲 随机这个</button>' +
        '<button class="btn ghost small" id="pClassic">↩ 经典版这格</button>' +
      '</div>';

    document.body.appendChild(s);
    $('#backdrop').classList.add('show');
    requestAnimationFrame(function () { s.classList.add('show'); });

    function close() {
      s.classList.remove('show');
      $('#backdrop').classList.remove('show');
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 320);
    }

    function apply(pid) {
      const p = POOL_BY_ID[pid];
      if (!p) return;
      cell.theme = p.short; cell.poolId = p.id;
      onChange(); close(); sfx('pop');
    }

    function drawList() {
      const box = $('#pList', s);
      const items = POOL.filter(function (p) { return tag === '全部' || p.tag === tag; });
      box.innerHTML = items.map(function (p) {
        const on = (cell.poolId === p.id) ? ' on' : '';
        const bk = p.books && p.books[0] ? '《' + p.books[0].t + '》' : p.full;
        return '<button class="pool-item' + on + '" data-pid="' + p.id + '">' +
          '<span class="pi-t">' + esc(p.short) + '</span>' +
          '<span class="pi-b">' + esc(bk) + '</span></button>';
      }).join('');
      $$('.pool-item', box).forEach(function (el) {
        el.addEventListener('click', function () { apply(el.dataset.pid); });
      });
    }
    drawList();

    $$('.chip[data-tag]', s).forEach(function (el) {
      el.addEventListener('click', function () {
        tag = el.dataset.tag;
        $$('.chip[data-tag]', s).forEach(function (x) { x.classList.toggle('on', x === el); });
        drawList();
      });
    });

    $('#pUse', s).addEventListener('click', function () {
      const v = ($('#pTheme', s).value || '').trim();
      if (!v) { $('#pTheme', s).focus(); return; }
      cell.theme = v; cell.poolId = null;
      onChange(); close(); sfx('pop');
    });

    $('#pRand', s).addEventListener('click', function () {
      const used = {};
      cells.forEach(function (c, i) { if (i !== idx && c.poolId) used[c.poolId] = 1; });
      const cands = POOL.filter(function (p) { return p.tag !== '自由' && !used[p.id]; });
      const p = cands[(Math.random() * cands.length) | 0];
      if (p) apply(p.id);
    });

    $('#pClassic', s).addEventListener('click', function () {
      cell.theme = CELLS[idx].short; cell.poolId = 'c' + (idx + 1);
      onChange(); close(); sfx('tap');
    });

    $('#pClose', s).addEventListener('click', close);
    $('#backdrop').addEventListener('click', close, { once: true });
  }


  /* ===========================================================
     老师后台
     =========================================================== */
  function csvField(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }

  function downloadCSV(filename, rows) {
    const csv = '\ufeff' + rows.map(function (r) { return r.map(csvField).join(','); }).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function allBoards() {
    return Object.values(state.boards).sort(function (a, b) { return (a.seat || 99) - (b.seat || 99); });
  }

  function lastBookOf(b) {
    let best = null;
    b.cells.forEach(function (c) {
      if (c.lit && c.book && (!best || (c.book.d || '') >= (best.d || ''))) best = c.book;
    });
    return best;
  }

  function adminNav(active) {
    const tab = function (href, label, key) {
      return '<a class="chip' + (active === key ? ' on' : '') + '" href="#' + href + '">' + label + '</a>';
    };
    return '<div class="chip-row" style="margin:0 0 12px">' +
      tab('/wall', '班级进度', 'wall') +
      tab('/books', '班级书架', 'books') +
      tab('/admin', '老师后台', 'admin') +
    '</div>';
  }

  function renderAdmin() {
    currentView = 'admin';
    const boards = allBoards();
    const totalBooks = boards.reduce(function (s, b) { return s + boardStats(b).lit; }, 0);
    const totalLines = boards.reduce(function (s, b) { return s + boardStats(b).lines.length; }, 0);
    const active = boards.filter(function (b) { return boardStats(b).lit > 0; }).length;

    const missionDraft = missionDraftFromState();
    const rows = boards.map(function (b) {
      const st = boardStats(b);
      const last = lastBookOf(b);
      return '<tr>' +
        '<td class="c">' + (b.seat || '-') + '</td>' +
        '<td><span class="em">' + b.avatar + '</span> ' + esc(b.name) + '</td>' +
        '<td class="c"><b>' + st.lit + '</b>/' + TOTAL + '</td>' +
        '<td class="c">' + st.lines.length + '</td>' +
        '<td class="c">' + Math.round(st.lit / TOTAL * 100) + '%</td>' +
        '<td class="last">' + (last ? '《' + esc(last.t) + '》' : '—') + '</td>' +
      '</tr>';
    }).join('');

    $('#app').innerHTML =
      '<div class="topbar">' +
        '<button class="icon-btn" id="back">←</button>' +
        '<div class="who"><div class="nm">老师后台</div><div class="sub">' +
          (syncMode === 'server' ? '已连接班级数据' : '本机数据') + '</div></div>' +
        '<div class="spacer"></div>' +
        '<button class="icon-btn" id="refresh" title="刷新">⟳</button>' +
      '</div>' +
      '<div class="wall">' +
        adminNav('admin') +
        '<div class="stat-row">' +
          statBox('参与小朋友', active + ' / ' + boards.length + ' 人') +
          statBox('一共读了', totalBooks + ' 本') +
          statBox('连成线', totalLines + ' 条') +
          statBox('人均', (boards.length ? (totalBooks / boards.length).toFixed(1) : '0') + ' 本') +
        '</div>' +

        '<div class="panel classes">' +
          '<div class="panel-head"><h3>班级</h3>' +
            '<span class="hint" style="margin-left:4px">每个班有独立的座位、题目和书架</span>' +
            '<div class="acts"><button class="btn small green" id="newClass">+ 新建班级</button></div>' +
          '</div>' +
          '<div class="cls-list" id="clsList">' +
            classListCache.map(function (c) {
              const on = classInfo && c.id === classInfo.id;
              const cnt = on ? Object.keys(state.boards).length : c.count;
              return '<div class="cls-row' + (on ? ' on' : '') + '">' +
                '<div class="cls-main"><b>' + esc(c.name) + '</b>' +
                  (c.isDefault ? '<span class="cls-tag">默认</span>' : '') +
                  '<span class="cls-meta">' + cnt + ' 人 · /?c=' + esc(c.slug) + '</span></div>' +
                '<div class="cls-acts">' +
                  (on ? '<span class="cls-here">当前</span>' : '<button class="btn small ghost" data-act="switch" data-slug="' + esc(c.slug) + '">进入</button>') +
                  '<button class="btn small ghost" data-act="copy" data-slug="' + esc(c.slug) + '">复制链接</button>' +
                  '<button class="btn small ghost" data-act="rename" data-id="' + esc(c.id) + '" data-name="' + esc(c.name) + '">改名</button>' +
                  (c.isDefault ? '' : '<button class="btn small ghost" data-act="default" data-id="' + esc(c.id) + '">设为默认</button>') +
                  '<button class="btn small ghost" data-act="del" data-id="' + esc(c.id) + '" data-name="' + esc(c.name) + '">删除</button>' +
                '</div>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>' +

        '<div class="panel backup">' +
          '<div class="panel-head"><h3>备份 / 迁移</h3>' +
            '<span class="hint" style="margin-left:4px">换电脑、换服务器、搬到云上都用它</span></div>' +
          '<p class="hint">导出一个 JSON，换到新地方后点「导入」，座位、书单、任务原样搬过去。</p>' +
          '<div class="acts" style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn small green" id="expJson">导出班级</button>' +
            '<button class="btn small ghost" id="expJsonPhoto">导出（含照片）</button>' +
            '<button class="btn small blue" id="impJson">导入备份…</button>' +
            '<input type="file" id="impFile" accept="application/json,.json" style="display:none">' +
          '</div>' +
        '</div>' +

        '<div class="panel mission">' +
          '<div class="panel-head"><h3>布置任务</h3>' +
            '<span class="hint" style="margin-left:4px">发一套题目，全班的棋盘都会换上</span></div>' +
          '<div class="field"><label>书单名字</label>' +
            '<input id="mTitle" type="text" maxlength="20" value="' + esc(missionDraft.title) + '" placeholder="比如：十月 · 秋天的书">' +
          '</div>' +
          '<div class="m-grid" id="mGrid">' + missionGridHTML(missionDraft) + '</div>' +
          '<div class="panel-head" style="margin-top:14px">' +
            '<div class="acts" style="margin-left:0">' +
              '<button class="btn small ghost" id="mRandom">🎲 随机一套</button>' +
              '<button class="btn small ghost" id="mClassic">经典 16 格</button>' +
              (state.mission ? '<button class="btn small ghost" id="mClear">撤销布置</button>' : '') +
            '</div>' +
            '<button class="btn small red" id="mPublish" style="margin-left:auto">发给全班 →</button>' +
          '</div>' +
        '</div>' +

        '<div class="panel">' +
          '<div class="panel-head"><h3>全班一览</h3>' +
            '<div class="acts">' +
              '<button class="btn small green" id="expSum">导出汇总表</button>' +
              '<button class="btn small ghost" id="expDetail">导出明细表</button>' +
              '<button class="btn small ghost" id="printAdmin">打印</button>' +
            '</div>' +
          '</div>' +
          (boards.length
            ? '<div class="table-wrap"><table class="adm"><thead><tr>' +
                '<th class="c">座位</th><th>姓名</th><th class="c">已读</th><th class="c">连线</th>' +
                '<th class="c">完成</th><th class="last">最近一本</th>' +
              '</tr></thead><tbody>' + rows + '</tbody></table></div>'
            : '<div class="hint" style="padding:24px 0;text-align:center">还没有小朋友开始，先去首页建一个座位吧。</div>') +
        '</div>' +

        '<div class="panel danger">' +
          '<div class="panel-head"><h3>重置</h3></div>' +
          '<p class="hint">清空全班 ' + boards.length + ' 个座位的所有记录，无法撤销。' +
          '做之前请先让所有平板关掉页面，否则它们会把旧数据再推回来。</p>' +
          '<button class="btn small red" id="resetAll">一键重置全班</button>' +
        '</div>' +
      '</div>';

    $('#back').addEventListener('click', function () { location.hash = ''; });
    $('#refresh').addEventListener('click', function () { pull().then(function () { renderAdmin(); }); });

    $('#expSum').addEventListener('click', function () {
      const out = [['座位', '姓名', '已读本数', '连成线', '完成率', '最近一本', '最近日期']];
      boards.forEach(function (b) {
        const st = boardStats(b), last = lastBookOf(b);
        out.push([b.seat || '', b.name, st.lit, st.lines.length, Math.round(st.lit / TOTAL * 100) + '%',
          last ? last.t : '', last ? (last.d || '') : '']);
      });
      downloadCSV('阅读大挑战_全班汇总_' + todayStr() + '.csv', out);
      toast('汇总表已导出');
    });

    $('#expDetail').addEventListener('click', function () {
      const out = [['姓名', '座位', '格子', '主题', '书名', '作者', '读完日期', '星级', '感受']];
      boards.forEach(function (b) {
        b.cells.forEach(function (c, i) {
          if (!c.lit || !c.book) return;
          out.push([b.name, b.seat || '', i + 1, c.theme, c.book.t, c.book.a || '',
            c.book.d || '', c.book.stars || 0, c.book.note || '']);
        });
      });
      downloadCSV('阅读大挑战_读书记录_' + todayStr() + '.csv', out);
      toast('明细表已导出');
    });

    $('#printAdmin').addEventListener('click', function () { window.print(); });

    function paintMissionGrid() {
      const box = $('#mGrid');
      if (!box) return;
      box.innerHTML = missionGridHTML(missionDraft);
      $$('.m-cell', box).forEach(function (el) {
        const i = parseInt(el.dataset.i, 10);
        el.addEventListener('click', function () {
          openPicker(missionDraft.cells[i], i, missionDraft.cells, function () {
            paintMissionGrid();
          });
        });
      });
    }
    paintMissionGrid();

    $('#mRandom').addEventListener('click', function () {
      const used = {};
      const pool = POOL.filter(function (p) { return p.tag !== '自由'; });
      const bag = pool.slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
      missionDraft.cells.forEach(function (c, i) {
        if (i === FREE_INDEX) { c.theme = '自由格'; c.poolId = 'c' + CELLS[i].no; return; }
        let p = null;
        while (bag.length) { const cand = bag.pop(); if (!used[cand.id]) { p = cand; break; } }
        if (!p) return;
        used[p.id] = 1;
        c.theme = p.short; c.poolId = p.id;
      });
      paintMissionGrid();
      sfx('pop');
    });

    $('#mClassic').addEventListener('click', function () {
      missionDraft.cells = CELLS.map(function (c) { return { theme: c.short, poolId: 'c' + c.no }; });
      paintMissionGrid();
      sfx('tap');
    });

    $('#expJson').addEventListener('click', function () { exportClass(false); });
    $('#expJsonPhoto').addEventListener('click', function () { exportClass(true); });
    $('#impJson').addEventListener('click', function () { $('#impFile').click(); });
    $('#impFile').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) importClass(f);
    });

    $('#newClass').addEventListener('click', async function () {
      const name = prompt('新班级叫什么？（比如：三年二班）');
      if (!name) return;
      try {
        const r = await fetch(apiUrl('api/classes'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        });
        const data = await r.json();
        if (data['class']) goClass(data['class'].slug);
      } catch (e) { toast('新建失败，检查一下网络'); }
    });

    $$('#clsList [data-act]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const act = btn.dataset.act;
        if (act === 'switch') { goClass(btn.dataset.slug); return; }
        if (act === 'copy') {
          const link = shareLink(btn.dataset.slug);
          try { await navigator.clipboard.writeText(link); toast('链接已复制：' + link); }
          catch (e) { prompt('复制这个链接发给小朋友：', link); }
          return;
        }
        if (act === 'rename') {
          const name = prompt('改成什么名字？', btn.dataset.name);
          if (!name) return;
          await fetch(apiUrl('api/classes/update'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: btn.dataset.id, name: name })
          });
          renderAdmin();
          return;
        }
        if (act === 'del') {
          if (!confirm('删除班级「' + btn.dataset.name + '」？这个班的所有记录都会没掉。')) return;
          if (!confirm('再确认一次：删了就找不回来了。')) return;
          const r = await fetch(apiUrl('api/classes/delete'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: btn.dataset.id })
          });
          if (!r.ok) { toast('至少要保留一个班级'); return; }
          const data = await r.json();
          if (classInfo && classInfo.id === btn.dataset.id) {
            const fallback = (data.classes && data.classes[0]) || null;
            goClass(fallback ? fallback.slug : 'default');
          } else {
            classListCache = data.classes || classListCache;
            renderAdmin();
          }
          return;
        }
        if (act === 'default') {
          await fetch(apiUrl('api/classes/update'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: btn.dataset.id, isDefault: true })
          });
          renderAdmin();
          toast('已设为默认班级（不带参数的链接会进入这里）');
          return;
        }
      });
    });

    const clearBtn = $('#mClear');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      if (!confirm('撤销后，小朋友刷新页面就会回到自己的题目（已经读过的记录不受影响）。')) return;
      state.mission = null;
      persist();
      pushMission(null);
      toast('已撤销');
      renderAdmin();
    });

    $('#mPublish').addEventListener('click', function () {
      const title = ($('#mTitle').value || '').trim() || '班级书单';
      const m = {
        id: 'm' + Date.now(),
        title: title,
        cells: missionDraft.cells.map(function (c) { return { theme: c.theme, poolId: c.poolId || null }; }),
        updatedAt: Date.now()
      };
      state.mission = m;
      persist();
      pushMission(m);
      toast('已发给全班 ' + boards.length + ' 位小朋友');
      renderAdmin();
    });

    $('#resetAll').addEventListener('click', function () {
      if (!confirm('确定要清空全班 ' + boards.length + ' 个座位的记录吗？\n这个操作不能撤销。')) return;
      if (!confirm('再确认一次：所有小朋友的进度都会被删掉。')) return;
      (async function () {
        if (syncMode === 'server') {
          try { await fetch(apiUrl('api/reset'), { method: 'POST' }); } catch (e) {}
        }
        state = { boards: {} };
        me = null; store.set(LS_ME, '');
        persist();
        toast('已清空');
        setTimeout(function () { location.hash = ''; route(); }, 400);
      })();
    });
  }


  /* ===========================================================
     备份 / 迁移（导出、导入整个班级）
     =========================================================== */
  function blobToDataURL(blob) {
    return new Promise(function (resolve) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { resolve(''); };
      fr.readAsDataURL(blob);
    });
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  async function exportClass(includePhotos) {
    const boards = JSON.parse(JSON.stringify(state.boards || {}));
    let photoCount = 0;

    if (includePhotos) {
      toast('正在打包照片…');
      for (const id in boards) {
        for (const c of boards[id].cells) {
          const p = c.book && c.book.photo;
          if (p && p.indexOf('data:') !== 0) {
            try {
              const r = await fetch(p);
              if (r.ok) { c.book.photo = await blobToDataURL(await r.blob()); photoCount++; }
              else c.book.photo = '';
            } catch (e) { c.book.photo = ''; }
          } else if (p) { photoCount++; }
        }
      }
    } else {
      for (const id in boards) {
        for (const c of boards[id].cells) {
          if (c.book && c.book.photo) c.book.photo = '';
        }
      }
    }

    const name = (classInfo && classInfo.name) || '班级';
    downloadJSON(
      '阅读BINGO_' + name + '_' + todayStr() + '.json',
      {
        type: 'bingo-class', version: 1,
        exportedAt: new Date().toISOString(),
        name: name,
        slug: (classInfo && classInfo.slug) || '',
        mission: state.mission || null,
        boards: boards
      }
    );
    toast('已导出 ' + Object.keys(boards).length + ' 个座位' + (includePhotos ? '、' + photoCount + ' 张照片' : ''));
  }

  async function importClass(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) { toast('这个文件打不开'); return; }

    if (!data || data.type !== 'bingo-class' || !data.boards) {
      toast('不是阅读 BINGO 的备份文件');
      return;
    }

    const incoming = Object.values(data.boards);
    const overwrite = incoming.filter(function (b) { return !!state.boards[b.id]; }).length;
    const msg = '导入到当前班级「' + ((classInfo && classInfo.name) || '默认班级') + '」？\n\n' +
      '文件：' + (data.name || '未命名') + '（' + incoming.length + ' 个座位）\n' +
      (overwrite ? '其中 ' + overwrite + ' 个座位会覆盖现有记录。\n' : '') +
      '导入后刷新页面即可看到。';
    if (!confirm(msg)) return;

    if (syncMode !== 'server') { toast('导入需要连着同步服务'); return; }

    toast('正在导入…');
    let photoCount = 0, ok = 0;

    for (const id in data.boards) {
      const b = data.boards[id];
      if (!b || !Array.isArray(b.cells)) continue;
      for (const c of b.cells) {
        const p = c.book && c.book.photo;
        if (p && p.indexOf('data:') === 0) {
          try { c.book.photo = await uploadPhoto(p); photoCount++; } catch (e) {}
        }
      }
      b.updatedAt = Math.max(b.updatedAt || 0, Date.now());
      const r = await fetch(apiUrl('api/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: b })
      });
      if (r.ok) { state.boards[b.id] = b; ok++; }
    }

    if (data.mission) {
      state.mission = data.mission;
      try {
        await fetch(apiUrl('api/mission'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mission: data.mission })
        });
      } catch (e) {}
    }

    persist();
    toast('导入完成：' + ok + ' 个座位' + (photoCount ? '、' + photoCount + ' 张照片' : ''));
    setTimeout(function () { renderAdmin(); }, 400);
  }

  function missionDraftFromState() {
    const m = state.mission;
    if (m && Array.isArray(m.cells) && m.cells.length === TOTAL) {
      return {
        title: m.title || '',
        cells: m.cells.map(function (c) { return { theme: c.theme, poolId: c.poolId || null }; })
      };
    }
    return {
      title: '',
      cells: CELLS.map(function (c) { return { theme: c.short, poolId: 'c' + c.no }; })
    };
  }

  function missionGridHTML(draft) {
    return draft.cells.map(function (c, i) {
      const col = COLORS[(CELLS[i] && CELLS[i].color) || 'cream'];
      const lit = state.mission && state.mission.cells && state.mission.cells[i] &&
        state.mission.cells[i].theme === c.theme;
      return '<button class="m-cell" data-i="' + i + '" style="border-color:' + col.main + (lit ? ';background:' + col.soft : '') + '">' +
        '<span class="m-no" style="background:' + col.main + ';color:' + col.ink + '">' + (i + 1) + '</span>' +
        '<span class="m-t">' + esc(c.theme) + '</span>' +
      '</button>';
    }).join('');
  }

  function statBox(label, value) {
    return '<div class="stat"><div class="stat-v">' + value + '</div><div class="stat-l">' + label + '</div></div>';
  }

  /* ===========================================================
     班级书架墙
     =========================================================== */
  function renderBooks() {
    currentView = 'books';
    const entries = [];
    Object.values(state.boards).forEach(function (b) {
      b.cells.forEach(function (c, i) {
        if (c.lit && c.book && (c.book.t || '').trim()) {
          entries.push({ b: b, c: c, i: i, date: c.book.d || '' });
        }
      });
    });

    const map = {};
    entries.forEach(function (e) {
      const key = e.c.book.t.trim();
      if (!map[key]) map[key] = { title: key, author: e.c.book.a || '', readers: [], ts: '', color: cellColor(e.c, e.i) };
      map[key].readers.push({
        name: e.b.name, avatar: e.b.avatar, date: e.date || '',
        note: e.c.book.note || '', photo: e.c.book.photo || ''
      });
      if ((e.date || '') >= map[key].ts) map[key].ts = e.date || '';
    });

    const list = Object.values(map).sort(function (a, b) {
      return (b.ts || '').localeCompare(a.ts || '');
    });

    const cards = list.map(function (bk) {
      const readers = bk.readers.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      const photos = readers.filter(function (r) { return r.photo; }).slice(0, 3);
      return '<article class="bw-card">' +
        '<div class="bw-spine" style="background:' + bk.color.main + '"></div>' +
        '<div class="bw-body">' +
          '<h3>' + esc(bk.title) + '</h3>' +
          (bk.author ? '<p class="bw-author">' + esc(bk.author) + '</p>' : '') +
          '<div class="bw-readers">' + readers.map(function (r) {
            return '<span class="bw-r" title="' + esc(r.date) + '">' + r.avatar + ' ' + esc(r.name) +
              (r.date ? '<i>' + esc(r.date.slice(5)) + '</i>' : '') + '</span>';
          }).join('') + '</div>' +
          (photos.length ? '<div class="bw-photos">' + photos.map(function (p) {
            return '<img src="' + esc(p.photo) + '" alt="">';
          }).join('') + '</div>' : '') +
        '</div>' +
      '</article>';
    }).join('');

    const totalReads = entries.length;

    $('#app').innerHTML =
      '<div class="topbar">' +
        '<button class="icon-btn" id="back">←</button>' +
        '<div class="who"><div class="nm">班级书架</div><div class="sub">' +
          list.length + ' 本书 · ' + totalReads + ' 人次</div></div>' +
        '<div class="spacer"></div>' +
        '<button class="icon-btn" id="refresh" title="刷新">⟳</button>' +
      '</div>' +
      '<div class="wall">' +
        adminNav('books') +
        (list.length
          ? '<div class="book-wall">' + cards + '</div>'
          : '<div class="hint" style="text-align:center;padding:60px 0">还没有书入架，等第一个小朋友点亮格子吧 📚</div>') +
      '</div>';

    $('#back').addEventListener('click', function () { location.hash = ''; });
    $('#refresh').addEventListener('click', function () { pull().then(function () { renderBooks(); }); });
  }

  /* ===========================================================
     大屏
     =========================================================== */
  function renderWall(soft) {
    currentView = 'wall';
    const boards = Object.values(state.boards).sort(function (a, b) {
      const sa = boardStats(a), sb = boardStats(b);
      if (sb.lit !== sa.lit) return sb.lit - sa.lit;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    const total = boards.reduce(function (s, b) { return s + boardStats(b).lit; }, 0);
    const totalLines = boards.reduce(function (s, b) { return s + boardStats(b).lines.length; }, 0);

    const cards = boards.map(function (b, rank) {
      const st = boardStats(b);
      const dots = b.cells.map(function (c, ci) {
        const col = cellColor(c, ci);
        return '<i style="background:' + (c.lit ? col.main : '#EDE4D3') + '"></i>';
      }).join('');
      const lastBook = b.cells.filter(function (c) { return c.lit && c.book; })
        .sort(function (x, y) { return (y.book.d || '').localeCompare(x.book.d || ''); })[0];
      return '<div class="pcard' + (rank === 0 && st.lit > 0 ? ' rank-1' : '') + '">' +
        '<div class="top"><span class="em">' + b.avatar + '</span><span class="nm">' + esc(b.name) + '</span>' +
        '<span class="cnt">' + st.lit + '/' + TOTAL + '</span></div>' +
        '<div class="dots">' + dots + '</div>' +
        '<div class="foot"><span>' + st.lines.length + ' 条线</span>' +
        '<span class="last">' + (lastBook ? '《' + esc(lastBook.book.t) + '》' : '还没开始') + '</span></div>' +
      '</div>';
    }).join('');

    const empties = [];
    for (let i = boards.length; i < SEATS; i++) {
      empties.push('<div class="pcard" style="opacity:.4;border-style:dashed"><div class="top">' +
        '<span class="em">＋</span><span class="nm">空位</span><span class="cnt">--</span></div>' +
        '<div class="dots">' + '<i></i>'.repeat(TOTAL) + '</div>' +
        '<div class="foot"><span>等你来</span><span class="last"></span></div></div>');
    }

    $('#app').innerHTML =
      '<div class="topbar">' +
        '<button class="icon-btn" id="back">←</button>' +
        '<div class="who"><div class="nm">全班阅读大屏</div></div>' +
        '<div class="spacer"></div>' +
        '<button class="icon-btn" id="refresh" title="刷新">⟳</button>' +
        '<button class="icon-btn" id="printWall" title="打印">🖨</button>' +
      '</div>' +
      '<div class="wall">' +
        adminNav('wall') +
        '<div class="wall-head">' +
          '<h1>我们班的阅读大挑战</h1>' +
          '<p>' + boards.length + ' 位小朋友 · 一共读了 <b style="color:#E23B2E;font-size:16px">' + total + '</b> 本 · ' +
          '连成 <b style="color:#1D5FA6;font-size:16px">' + totalLines + '</b> 条线' +
          (syncMode === 'server' ? '' : ' · 本机数据') + '</p>' +
        '</div>' +
        '<div class="wall-grid">' + cards + empties.join('') + '</div>' +
      '</div>';

    $('#back').addEventListener('click', function () { location.hash = ''; });
    $('#refresh').addEventListener('click', function () { pull().then(function () { renderWall(); }); });
    $('#printWall').addEventListener('click', function () { window.print(); });
    if (!soft) window.scrollTo(0, 0);
  }

  function runSelfTest() {
    if (!/[?&]auto=/.test(location.search)) return;
    const m = /[?&]cell=(\d+)/.exec(location.search);
    const id = location.hash.indexOf('/board/') === 0 ? location.hash.slice(7) : me;
    const b = getBoard(id);
    if (!b) return;
    const idx = Math.min(24, Math.max(0, parseInt(m ? m[1] : '1', 10) - 1));
    if (/auto=ocrtest/.test(location.search)) {
      setTimeout(function () {
        openSheet(b, idx, $('.cell[data-i="' + idx + '"]'));
        setTimeout(function () {
          fetch('tools/test_cover.jpg').then(function (r) { return r.blob(); }).then(function (blob) {
            const fr = new FileReader();
            fr.onload = function () {
              const out = $('#ocrOut');
              if (!out) return;
              out.innerHTML = '<div class="ocr-loading">正在认字…</div>';
              ocrImage(fr.result).then(function (res) {
                showOcrResult(out, res ? res.lines : null, $('#fTitle'));
              });
            };
            fr.readAsDataURL(blob);
          });
        }, 400);
      }, 300);
      return;
    }
    if (/auto=mission/.test(location.search)) {
      setTimeout(function () {
        const btn = $('#mApply');
        if (btn) btn.click();
      }, 500);
      return;
    }
    if (/auto=design/.test(location.search)) {
      location.hash = '/design/' + b.id;
      return;
    }
    if (/auto=pick/.test(location.search)) {
      location.hash = '/design/' + b.id;
      setTimeout(function () { openPicker(b.cells[idx], idx, b.cells, function () { saveBoard(b); updateDesignCell(b, idx); }); }, 400);
      return;
    }
    if (/auto=shelf/.test(location.search)) {
      setTimeout(function () { openShelf(b); }, 400);
      return;
    }
    setTimeout(function () {
      const el = $('.cell[data-i="' + idx + '"]');
      openSheet(b, idx, el);
      setTimeout(function () {
        const t = $('#fTitle');
        if (t) { t.value = '测试书名'; $('#fAuthor').value = '测试作者'; }
        const btn = $('#lightUp');
        if (btn) btn.click();
      }, 300);
    }, 300);
  }

  function maybeAutoSheet() {
    const m = /[?&]sheet=(\d+)/.exec(location.search);
    if (!m) return;
    const id = location.hash.indexOf('/board/') === 0 ? location.hash.slice(7) : me;
    const b = getBoard(id);
    if (!b) return;
    const idx = Math.min(24, Math.max(0, parseInt(m[1], 10) - 1));
    setTimeout(function () { openSheet(b, idx, $('.cell[data-i="' + idx + '"]')); }, 350);
  }

  /* ===========================================================
     演示数据（?demo=1 时用，方便看效果）
     =========================================================== */
  function seedDemo() {
    const names = ['小满', '阿禾', '元宝', '朵朵', '一诺', '小树', '果果', '南南', '阿布', '米粒', '小舟', '豆豆', '舟舟', '小鹿', '圆圆'];
    let seed = 20261027;
    const rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const books = ['团圆', '花格子大象艾玛', '好饿的毛毛虫', '雪人', '月亮的味道', '云朵面包', '纸袋公主', '牙齿大街的新鲜事', '晚安，月亮', '勇气', '是谁嗯嗯在我的头上', '我爸爸'];
    state = { boards: {} };
    names.forEach(function (name, i) {
      const b = newBoard(name, AVATARS[i % AVATARS.length]);
      const n = [13, 14, 11, 9, 7, 12, 6, 10, 8, 5, 11, 4, 3, 2, 1][i];
      const order = b.cells.map(function (_, k) { return k; });
      for (let k = order.length - 1; k > 0; k--) { const j = (rnd() * (k + 1)) | 0; const t = order[k]; order[k] = order[j]; order[j] = t; }
      order.slice(0, n).forEach(function (idx, j) {
        b.cells[idx].lit = true;
        b.cells[idx].book = { t: books[(i + j) % books.length], a: '', d: '2026-10-' + pad(1 + ((i + j) % 20)), note: '', stars: 3 + ((i + j) % 3) };
      });
      if (i === 0) {
        [0, 1, 2, 3, 7, 9].forEach(function (idx, j) {
          b.cells[idx].lit = true;
          b.cells[idx].book = { t: books[j], a: '', d: '2026-10-0' + (1 + j), note: '', stars: 4 };
        });
      }
      b.linesDone = boardStats(b).lines;
      b.updatedAt = Date.now();
      state.boards[b.id] = b;
    });
    persist();
    return Object.values(state.boards)[0].id;
  }

  /* ===========================================================
     启动
     =========================================================== */
  async function boot() {
    state = loadLocal();
    me = store.get(LS_ME) || null;
    migrateBoards();

    if (/^https?:/.test(location.protocol)) {
      try {
        const r = await fetch(apiUrl('api/state'), { cache: 'no-store' });
        if (r.ok) {
          const data = await r.json();
          syncMode = 'server';
          classInfo = data['class'] || null;
          classListCache = data.classes || [];
          if (!classSlug && classInfo) { classSlug = classInfo.slug; store.set('bingo.class', classSlug); }
          if (data.caps) caps.ocr = !!data.caps.ocr;
          mergeRemote(data);
          migrateBoards();
          persist();
          recoverBoards(data.boards);
        }
      } catch (e) {}
    }

    if (/demo=1/.test(location.search) && !Object.keys(state.boards).length) {
      const first = seedDemo();
      if (/mission=1/.test(location.search)) {
        const pool = POOL.filter(function (p) { return p.tag !== '自由'; });
        state.mission = {
          id: 'm' + Date.now(), title: '十月 · 秋天的书', updatedAt: Date.now(),
          cells: CELLS.map(function (c, i) {
            const p = pool[(i * 7) % pool.length];
            return i === FREE_INDEX ? { theme: '自由格', poolId: 'c' + c.no } : { theme: p.short, poolId: p.id };
          })
        };
        persist();
      }
      if (!location.hash) location.hash = '/board/' + first;
    }

    route();
    maybeAutoSheet();
    runSelfTest();

    if (syncMode === 'server') {
      setInterval(function () { if (!document.hidden) pull(); }, 2500);
    }
    // 其它标签页改了数据时，本页也跟着更新
    addEventListener('storage', function (e) {
      if (e.key !== LS_KEY) return;
      try {
        const s = JSON.parse(e.newValue);
        if (mergeRemote(s) && currentView === 'wall') renderWall(true);
      } catch (err) {}
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();

  // 调试用
  window.__bingo = { get state() { return state; }, get me() { return me; }, get sync() { return syncMode; } };
})();
