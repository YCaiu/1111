/* ===========================================================
   NeepWords Mobile · 应用逻辑
   原项目：elanzuo/NeepWords（MIT）本地考研英语词库工具集
   本文件把其 CLI 的 lookup / search / list-versions 语义搬到浏览器，
   并补上移动端学习功能（生词本、间隔复习听写、A4 背诵表）。
   =========================================================== */
(function () {
  'use strict';

  /* ==================== 常量（对齐原 CLI） ==================== */
  var MAX_WORD_LENGTH = 64;
  var MAX_LOOKUP = 200;
  var MAX_SEARCH = 200;
  var STORE_KEY = 'neepwords.mobile.v1';
  var STAGES = [
    { label: 'D0', d: 0 },
    { label: 'D1', d: 1 },
    { label: 'D2', d: 2 },
    { label: 'D4', d: 4 },
    { label: 'D7', d: 7 },
    { label: 'D15', d: 15 },
    { label: 'D30', d: 30 }
  ];
  var DAY = 86400000;
  var MODE_HINTS = {
    prefix: '前缀匹配：以该字母组合开头的单词，等价 SQL 的 LIKE \'关键词%\'。',
    suffix: '后缀匹配：以该字母组合结尾的单词，等价 LIKE \'%关键词\'。',
    contains: '包含匹配：只要词中含该组合即命中，等价 LIKE \'%关键词%\'。',
    fuzzy: '模糊匹配：字符按顺序出现即可（trans 能匹配 translate、transmit），等价在字符间插入 % 的 LIKE。',
    wildcard: '通配匹配：只允许字母与 - % _，其中 % 代表任意长度、_ 代表单个字符。'
  };

  /* ==================== 数据解析 ==================== */
  var DATA = window.NEEP_VOCAB || { meta: {}, raw: '' };
  var META = DATA.meta || {};
  var WORDS = [];          // [{w,p,c,l,t}]
  var BY_WORD = new Map(); // word -> index
  var BY_LETTER = new Map();
  var BY_PAGE = new Map();
  var LETTERS = [];
  var PAGES = [];
  var NOISE = new Set((META.noiseWords || []).map(function (n) { return n.word; }));

  (function parse() {
    if (!DATA.raw) return;
    var lines = DATA.raw.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var parts = line.split('|');
      var entry = {
        w: parts[0] || '',
        p: parts[1] || '',
        c: parts[2] || '',
        l: parts[3] || '',
        t: parts[4] || ''
      };
      if (!entry.w) continue;
      var idx = WORDS.length;
      WORDS.push(entry);
      BY_WORD.set(entry.w, idx);
      var k = entry.w.charAt(0);
      if (!BY_LETTER.has(k)) BY_LETTER.set(k, []);
      BY_LETTER.get(k).push(idx);
      if (entry.p) {
        var pg = parseInt(entry.p, 10);
        if (!BY_PAGE.has(pg)) BY_PAGE.set(pg, []);
        BY_PAGE.get(pg).push(idx);
      }
    }
    LETTERS = Array.from(BY_LETTER.keys()).sort();
    PAGES = Array.from(BY_PAGE.keys()).sort(function (a, b) { return a - b; });
  })();

  /* ==================== 通用工具 ==================== */
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1900);
  }

  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? (okMsg || '已复制') : '复制失败，请手动选择文本');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg || '已复制'); }, fallback);
    } else {
      fallback();
    }
  }

  /* 复刻 CLI 的 sanitize_token：取最长英文 token 并小写 */
  function normalizeToken(raw) {
    if (raw == null) return { value: null, warn: 'empty_input' };
    var s = String(raw).trim();
    if (!s) return { value: null, warn: 'empty_input' };
    var tokens = s.match(/[A-Za-z-]+/g);
    if (!tokens || !tokens.length) return { value: null, warn: 'no_english_tokens' };
    var warn = null;
    if (tokens.length > 1) warn = 'multiple_tokens_found_using_longest';
    var longest = tokens.slice().sort(function (a, b) { return b.length - a.length; })[0];
    var cleaned = longest.replace(/[^A-Za-z-]+/g, '').toLowerCase();
    if (!cleaned) return { value: null, warn: 'no_english_tokens' };
    if (cleaned.length > MAX_WORD_LENGTH) return { value: null, warn: 'too_long' };
    if (cleaned !== s.toLowerCase() && !warn) warn = 'normalized_input';
    return { value: cleaned, warn: warn };
  }

  /* 复刻 CLI 的 sanitize_wildcard */
  function normalizeWildcard(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { value: null, warn: 'empty_input' };
    var out = '';
    var hasLetter = false;
    var normalized = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch >= 'A' && ch <= 'Z') { out += ch.toLowerCase(); hasLetter = true; normalized = true; }
      else if (ch >= 'a' && ch <= 'z') { out += ch; hasLetter = true; }
      else if (ch === '-' || ch === '%' || ch === '_') { out += ch; }
      else { return { value: null, warn: 'invalid_characters' }; }
    }
    if (!out) return { value: null, warn: 'empty_input' };
    if (!hasLetter) return { value: null, warn: 'no_english_tokens' };
    if (out.length > MAX_WORD_LENGTH) return { value: null, warn: 'too_long' };
    return { value: out, warn: normalized ? 'normalized_input' : null };
  }

  /* CLI 的 fuzzy 模式生成 '%' + 't%r%a%n%s' + '%'，即字符按序出现即可，
     首尾都有 %，因此这里不能加 ^ / $ 锚点。 */
  function fuzzyRe(q) {
    return new RegExp(q.split('').map(escapeRegExp).join('.*'));
  }
  function wildcardRe(q) {
    var src = '';
    for (var i = 0; i < q.length; i++) {
      var ch = q.charAt(i);
      if (ch === '%') src += '.*';
      else if (ch === '_') src += '.';
      else src += escapeRegExp(ch);
    }
    return new RegExp('^' + src + '$');
  }
  /* 搜索：完全复刻 CLI 的 LIKE 语义 */
  function searchWords(query, mode, limit, offset) {
    var cleaned, warn;
    if (mode === 'wildcard') {
      var wc = normalizeWildcard(query);
      cleaned = wc.value; warn = wc.warn;
    } else {
      var tk = normalizeToken(query);
      cleaned = tk.value; warn = tk.warn;
    }
    if (cleaned == null) return { ok: false, error: mode === 'wildcard' ? 'invalid_query' : 'invalid_query', warn: warn };

    limit = Math.max(1, Math.min(parseInt(limit, 10) || 10, MAX_SEARCH));
    offset = Math.max(0, parseInt(offset, 10) || 0);

    var match;
    if (mode === 'prefix') match = function (w) { return w.lastIndexOf(cleaned, 0) === 0; };
    else if (mode === 'suffix') match = function (w) { return w.length >= cleaned.length && w.slice(-cleaned.length) === cleaned; };
    else if (mode === 'contains') match = function (w) { return w.indexOf(cleaned) !== -1; };
    else if (mode === 'fuzzy') { var fr = fuzzyRe(cleaned); match = function (w) { return fr.test(w); }; }
    else { var wr = wildcardRe(cleaned); match = function (w) { return wr.test(w); }; }

    var hits = [];
    for (var i = 0; i < WORDS.length; i++) {
      if (match(WORDS[i].w)) hits.push(i);
    }
    return {
      ok: true, query: cleaned, mode: mode, limit: limit, offset: offset,
      total: hits.length,
      items: hits.slice(offset, offset + limit).map(function (i) { return WORDS[i]; }),
      warn: warn
    };
  }

  /* 查词：完全复刻 CLI 的 lookup 语义 */
  function lookupWords(list) {
    if (!list.length) return { error: 'missing_words' };
    if (list.length > MAX_LOOKUP) return { error: 'too_many_words' };
    var warns = [];
    var results = list.map(function (input) {
      var tk = normalizeToken(input);
      if (tk.warn) warns.push(tk.warn);
      if (tk.value == null) return { input: input, status: 'invalid_input' };
      var idx = BY_WORD.get(tk.value);
      if (idx == null) return { input: input, query: tk.value, status: 'not_found' };
      return { input: input, query: tk.value, status: 'found', entry: WORDS[idx] };
    });
    return { results: results, warnings: Array.from(new Set(warns)) };
  }

  function fmtSource(e) {
    return META.sourcePrefix + '-' + e.p + '-' + e.c + '-' + e.l + '-' + e.t;
  }
  function colLabel(c) { return c === 'L' ? '左栏' : (c === 'R' ? '右栏' : c + ' 栏'); }
  function posTag(e) { return 'P' + e.p + ' · ' + colLabel(e.c) + ' · 第 ' + e.l + ' 行'; }
  /* 短词不露首字母，否则等于直接给答案 */
  function hintStart(word) {
    var letters = String(word == null ? '' : word).replace(/[^A-Za-z]/g, '').length;
    return letters <= 3 ? 0 : 1;
  }

  /* ==================== 本地存储 ==================== */
  var state = {
    book: {},                    // word -> {at, lastAt, stage, seen, wrong, note}
    settings: { theme: 'auto', mode: 'prefix', limit: 50 }
  };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          state.book = obj.book || {};
          state.settings = Object.assign(state.settings, obj.settings || {});
        }
      }
    } catch (e) { /* 忽略损坏数据 */ }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ book: state.book, settings: state.settings }));
    } catch (e) { toast('本地存储写入失败'); }
  }

  function bookEntries() {
    return Object.keys(state.book).map(function (w) { return { word: w, m: state.book[w] }; });
  }
  function isInBook(word) { return Object.prototype.hasOwnProperty.call(state.book, word); }
  function addToBook(word, silent) {
    if (!BY_WORD.has(word)) return false;
    if (isInBook(word)) { if (!silent) toast('「' + word + '」已在生词本'); return false; }
    state.book[word] = { at: Date.now(), lastAt: Date.now(), stage: 0, seen: 0, wrong: 0, note: '' };
    save();
    if (!silent) toast('已加入生词本：' + word);
    renderStudy(); renderBrowsePicks();
    return true;
  }
  function removeFromBook(word, silent) {
    if (!isInBook(word)) return;
    delete state.book[word];
    save();
    if (!silent) toast('已移出生词本：' + word);
    renderStudy(); renderBrowsePicks();
  }

  /* 间隔复习调度：复用原背诵表的 D0/D1/D2/D4/D7/D15/D30 列 */
  function dueAt(m) {
    var stage = Math.min(m.stage || 0, STAGES.length); // 7 = 毕业
    if (stage >= STAGES.length) return Infinity;
    if (stage === 0) return m.lastAt || m.at || 0;      // 新词：今天就要过
    return (m.lastAt || m.at || 0) + STAGES[stage].d * DAY;
  }
  function isDue(m) { return dueAt(m) <= Date.now(); }
  function isMastered(m) { return (m.stage || 0) >= STAGES.length; }

  function dueCount() {
    var n = 0;
    var keys = Object.keys(state.book);
    for (var i = 0; i < keys.length; i++) if (isDue(state.book[keys[i]])) n++;
    return n;
  }
  function masteredCount() {
    var n = 0;
    var keys = Object.keys(state.book);
    for (var i = 0; i < keys.length; i++) if (isMastered(state.book[keys[i]])) n++;
    return n;
  }
  function markResult(word, good) {
    var m = state.book[word];
    if (!m) return;
    m.seen = (m.seen || 0) + 1;
    m.lastAt = Date.now();
    if (good) m.stage = Math.min((m.stage || 0) + 1, STAGES.length);
    else { m.stage = 0; m.wrong = (m.wrong || 0) + 1; }
    save();
  }

  /* ==================== 语音朗读 ==================== */
  var speechOK = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
  function speak(text, rate) {
    if (!speechOK) { toast('当前浏览器不支持语音朗读，可看下方拼写提示'); return; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = rate || 0.85;
      var voices = window.speechSynthesis.getVoices() || [];
      var pick = null;
      for (var i = 0; i < voices.length; i++) {
        if (/^en(-|_)?(US|GB)?/i.test(voices[i].lang || '')) { pick = voices[i]; break; }
      }
      if (pick) u.voice = pick;
      window.speechSynthesis.speak(u);
    } catch (e) { toast('朗读失败'); }
  }

  /* ==================== 视图切换 ==================== */
  var currentView = 'lookup';
  function goto(view) {
    currentView = view;
    $$('.view').forEach(function (s) { s.classList.toggle('is-active', s.dataset.view === view); });
    $$('.tab').forEach(function (b) { b.classList.toggle('is-on', b.dataset.goto === view); });
    window.scrollTo(0, 0);
    if (view === 'study') renderStudy();
    if (view === 'list') renderBrowse();
    if (view === 'mine') renderMine();
  }

  /* ==================== 查词视图 ==================== */
  var lookupState = { results: null };

  function renderLookup(results, warnings) {
    var box = $('#lookupResults');
    lookupState.results = results;
    if (!results) { box.innerHTML = ''; return; }
    if (!results.length) { box.innerHTML = '<div class="empty">没有可用的查询结果</div>'; return; }
    var hits = results.filter(function (r) { return r.status === 'found'; }).length;
    var html = '<p class="hint" style="margin-bottom:4px">共 ' + results.length + ' 条输入，命中大纲 <b>' +
      hits + '</b> 条 · 词库版本 ' + esc(META.version) + '</p>';
    html += results.map(function (r) {
      if (r.status === 'invalid_input') {
        return '<div class="row is-miss"><div class="row-main">' +
          '<div class="row-word">' + esc(r.input || '(空)') + '</div>' +
          '<div class="row-sub">无法解析出有效英文单词（仅接受字母与连字符，长度上限 64）</div></div>' +
          '<div class="row-right"><span class="row-status na">无效输入</span></div></div>';
      }
      if (r.status === 'not_found') {
        return '<div class="row is-miss"><div class="row-main">' +
          '<div class="row-word">' + esc(r.query) + '</div>' +
          '<div class="row-sub">未收录于 ' + esc(META.version) + ' 考研英语（一）大纲词库</div></div>' +
          '<div class="row-right"><span class="row-status no">不在大纲</span></div></div>';
      }
      var e = r.entry;
      var starred = isInBook(e.w);
      return '<div class="row is-hit"><div class="row-main">' +
        '<div class="row-word" data-detail="' + esc(e.w) + '">' + esc(e.w) + '</div>' +
        '<div class="row-sub"><span class="tag">大纲 ' + esc(posTag(e)) + '</span>' +
        (NOISE.has(e.w) ? '<span class="tag" style="color:var(--warn)">OCR 可疑</span>' : '') +
        '</div></div>' +
        '<div class="row-right">' +
        '<button class="star ' + (starred ? 'is-on' : '') + '" data-star="' + esc(e.w) + '" type="button" aria-label="生词本">★</button>' +
        '<span class="row-status ok">在大纲</span></div></div>';
    }).join('');
    if (warnings && warnings.length) {
      html += '<p class="hint">提示：' + esc(warnings.join('、')) + '</p>';
    }
    box.innerHTML = html;
  }

  function doLookup() {
    var raw = $('#lookupInput').value || '';
    var parts = raw.split(/[\s,，;；、]+/).filter(function (s) { return s.length; });
    if (!parts.length) { toast('请输入要查询的单词'); return; }
    var res = lookupWords(parts);
    if (res.error === 'too_many_words') { toast('一次最多查询 ' + MAX_LOOKUP + ' 个词'); return; }
    renderLookup(res.results, res.warnings);
    hideSuggest();
  }

  var suggestTimer = null;
  function showSuggest(q) {
    var box = $('#suggestBox');
    var tk = normalizeToken(q);
    if (!tk.value) { hideSuggest(); return; }
    var r = searchWords(tk.value, 'prefix', 6, 0);
    if (!r.ok || !r.items.length) { hideSuggest(); return; }
    box.innerHTML = r.items.map(function (e) {
      return '<button type="button" data-suggest="' + esc(e.w) + '">' + esc(e.w) +
        '<em>P' + esc(e.p) + '</em></button>';
    }).join('');
    box.hidden = false;
  }
  function hideSuggest() { $('#suggestBox').hidden = true; }

  /* ==================== 检索视图 ==================== */
  var searchState = { result: null, page: 0 };

  function renderSearch() {
    var r = searchState.result;
    var box = $('#searchResults');
    if (!r) { box.innerHTML = '<div class="empty">选择模式并输入关键词后开始检索</div>'; $('#searchPager').hidden = true; return; }
    if (!r.ok) {
      box.innerHTML = '<div class="empty">' + (r.error === 'invalid_query' ? '关键词无效：通配模式只允许字母与 - % _' : '检索失败') + '</div>';
      $('#searchPager').hidden = true;
      $('#searchCount').textContent = '0 条';
      return;
    }
    $('#searchCount').textContent = r.total + ' 条';
    $('#searchTitle').textContent = '“' + r.query + '” 的检索结果';
    if (!r.items.length) {
      box.innerHTML = '<div class="empty">没有匹配的单词</div>';
      $('#searchPager').hidden = true;
      return;
    }
    box.innerHTML = r.items.map(function (e) {
      var w = esc(e.w);
      var hl = w.replace(new RegExp(escapeRegExp(esc(r.query)), 'i'), '<span class="hl">$&</span>');
      return '<div class="row"><div class="row-main">' +
        '<div class="row-word" data-detail="' + esc(e.w) + '">' + hl + '</div>' +
        '<div class="row-sub"><span class="tag">' + esc(posTag(e)) + '</span></div>' +
        '</div><div class="row-right">' +
        '<button class="star ' + (isInBook(e.w) ? 'is-on' : '') + '" data-star="' + esc(e.w) + '" type="button" aria-label="生词本">★</button>' +
        '</div></div>';
    }).join('');
    var totalPages = Math.max(1, Math.ceil(r.total / r.limit));
    $('#searchPager').hidden = r.total <= r.limit;
    $('#pageInfo').textContent = (searchState.page + 1) + ' / ' + totalPages;
    $('#prevPage').disabled = searchState.page === 0;
    $('#nextPage').disabled = searchState.page >= totalPages - 1;
  }

  function doSearch(resetPage) {
    if (resetPage) searchState.page = 0;
    var mode = $('#modeSeg .is-on').dataset.mode;
    var limit = parseInt($('#searchLimit').value, 10);
    state.settings.mode = mode; state.settings.limit = limit; save();
    var r = searchWords($('#searchInput').value, mode, limit, searchState.page * limit);
    if (!r.ok) { toast('请输入有效的关键词'); searchState.result = null; renderSearch(); return; }
    searchState.result = r;
    renderSearch();
  }

  /* ==================== 背词视图 ==================== */
  function stageBar(m) {
    var filled = Math.min(m.stage || 0, STAGES.length);
    var html = '<div class="stage" title="复习进度">';
    for (var i = 0; i < STAGES.length; i++) {
      html += '<i class="' + (i < filled ? 'on' : '') + '"></i>';
    }
    return html + '</div>';
  }

  function renderStudy() {
    var entries = bookEntries();
    $('#statTotal').textContent = entries.length;
    var due = dueCount();
    $('#statDue').textContent = due;
    $('#statMastered').textContent = masteredCount();
    $('#bookCount').textContent = entries.length + ' 词';

    var sort = $('#bookSort').value;
    entries.sort(function (a, b) {
      if (sort === 'added') return (b.m.at || 0) - (a.m.at || 0);
      if (sort === 'word') return a.word < b.word ? -1 : 1;
      if (sort === 'wrong') return (b.m.wrong || 0) - (a.m.wrong || 0);
      var da = dueAt(a.m), db = dueAt(b.m);
      if (da === Infinity && db === Infinity) return a.word < b.word ? -1 : 1;
      if (da === db) return a.word < b.word ? -1 : 1;
      return da - db;
    });

    var box = $('#bookList');
    if (!entries.length) {
      box.innerHTML = '<div class="empty">生词本还是空的。<br>在「查词」或「检索」里点 ★ 收藏单词，就会出现在这里。</div>';
      return;
    }
    box.innerHTML = entries.map(function (it) {
      var w = it.word, m = it.m;
      var idx = BY_WORD.get(w);
      var e = idx == null ? null : WORDS[idx];
      var dueTag = isMastered(m) ? '<span class="tag" style="color:var(--ok)">已掌握</span>'
        : (isDue(m) ? '<span class="tag" style="color:var(--warn)">待复习</span>' : '');
      return '<div class="row"><div class="row-main">' +
        '<div class="row-word" data-detail="' + esc(w) + '">' + esc(w) + '</div>' +
        '<div class="row-sub">' + dueTag +
        '<span class="tag">正确 ' + (m.seen || 0) + '</span>' +
        (m.wrong ? '<span class="tag" style="color:var(--err)">错 ' + m.wrong + '</span>' : '') +
        (e ? '<span class="tag">P' + esc(e.p) + '</span>' : '') +
        '</div>' + stageBar(m) +
        '</div><div class="row-right">' +
        '<button class="star" data-speak="' + esc(w) + '" type="button" aria-label="朗读">🔊</button>' +
        '<button class="star is-on" data-star="' + esc(w) + '" type="button" aria-label="移除">★</button>' +
        '</div></div>';
    }).join('');
  }

  function renderBrowsePicks() {
    var n = browseState.picked.size;
    $('#pickedChip').textContent = '已选 ' + n;
    $('#pickedChip').className = 'chip ' + (n ? 'chip-brand' : '');
  }

  /* ==================== 听写 ==================== */
  var quiz = null;

  function buildQuizQueue(source, size) {
    var pool = [];
    if (source === 'book' || source === 'due' || source === 'wrong') {
      var entries = bookEntries();
      if (source === 'due') entries = entries.filter(function (it) { return isDue(it.m); });
      if (source === 'wrong') entries = entries.filter(function (it) { return (it.m.wrong || 0) > 0; });
      pool = entries.map(function (it) { return it.word; });
      // 同一层级先复习错得多的
      pool.sort(function (a, b) {
        return (state.book[b].wrong || 0) - (state.book[a].wrong || 0);
      });
    } else {
      pool = WORDS.filter(function (e) { return !NOISE.has(e.w); }).map(function (e) { return e.w; });
      // 随机抽样，避免每次都是 a 开头
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
    }
    return pool.slice(0, size);
  }

  function startQuiz() {
    var source = $('#quizSource').value;
    var size = parseInt($('#quizSize').value, 10);
    var queue = buildQuizQueue(source, size);
    if (!queue.length) {
      if (source === 'due') toast('今天没有到期的词，换个题目来源试试');
      else if (source === 'book') toast('生词本还是空的');
      else if (source === 'wrong') toast('还没有答错过的词');
      else toast('没有可用的词');
      return;
    }
    quiz = { queue: queue, i: 0, ok: 0, bad: 0, wrong: [], phase: 'ask', hintLevel: hintStart(queue[0]), judged: false };
    $('#quiz').hidden = false;
    document.body.style.overflow = 'hidden';
    renderQuiz();
  }

  function hintFor(word, level) {
    var chars = word.split('');
    var shown = 0;
    var out = chars.map(function (ch) {
      if (ch === ' ') return ' ';      // 词组保留空格
      if (ch === '-') return '-';      // 连字符是答案的一部分
      shown++;
      if (shown <= level) return ch;
      return '_';
    }).join('');
    return out;
  }

  function renderQuiz() {
    if (!quiz) return;
    var total = quiz.queue.length;
    $('#quizProgress').textContent = Math.min(quiz.i + 1, total) + ' / ' + total;
    $('#quizScore').textContent = '✓ ' + quiz.ok + '   ✗ ' + quiz.bad;
    var main = $('#quizMain');

    if (quiz.i >= total) { renderQuizSummary(); return; }

    var word = quiz.queue[quiz.i];
    var m = state.book[word];
    var idx = BY_WORD.get(word);
    var e = idx == null ? null : WORDS[idx];

    main.innerHTML =
      '<button class="btn btn-primary" id="playBtn" type="button" style="min-width:150px">🔊 播放读音</button>' +
      '<div class="quiz-hint" id="quizHint">' + esc(hintFor(word, quiz.phase === 'judged' ? 99 : quiz.hintLevel)) + '</div>' +
      '<div class="quiz-meta">' + word.replace(/[A-Za-z]/g, '·').length + ' 个字符' +
      (e ? ' · 大纲 P' + esc(e.p) : '') +
      (m ? ' · 第 ' + ((m.seen || 0) + 1) + ' 次练习' : ' · 未收藏') + '</div>' +
      '<input class="quiz-input" id="quizInput" type="text" inputmode="latin" autocomplete="off" ' +
      'autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="听音拼写…">' +
      '<div class="quiz-verdict" id="quizVerdict"></div>' +
      '<div class="quiz-btns">' +
      '<button class="btn btn-ghost" id="hintBtn" type="button">再露一个字母</button>' +
      '<button class="btn btn-primary" id="submitBtn" type="button">提交</button>' +
      '</div>' +
      '<button class="btn btn-ghost" id="skipBtn" type="button" style="width:100%;max-width:420px">不知道，看答案</button>';

    var input = $('#quizInput');
    if (quiz.phase === 'ask') {
      input.value = '';
      setTimeout(function () {
        input.focus();
        speak(word, quiz.i === 0 ? 0.8 : 0.85);
      }, 120);
    } else {
      input.value = word;
      input.classList.add('ok');
      input.readOnly = true;
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); quiz.phase === 'ask' ? submitQuiz() : nextQuestion(); }
    });
  }

  function submitQuiz() {
    if (!quiz || quiz.i >= quiz.queue.length || quiz.phase !== 'ask') return;
    var word = quiz.queue[quiz.i];
    var input = $('#quizInput');
    var val = (input.value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    // 空答案不判卷：避免答对后自动跳题时误触「提交」把下一题判错、重置复习进度
    if (!val) {
      toast('先输入拼写，或点「不知道，看答案」');
      input.focus();
      return;
    }
    var expect = word.toLowerCase().replace(/\s+/g, ' ');
    var good = val === expect;

    input.readOnly = true;
    input.classList.add(good ? 'ok' : 'bad');
    $('#quizVerdict').className = 'quiz-verdict ' + (good ? 'ok' : 'bad');
    $('#quizVerdict').textContent = good ? '✓ 拼写正确' : '✗ 正确拼写：' + word;

    if (good) quiz.ok++; else { quiz.bad++; quiz.wrong.push(word); }
    if (isInBook(word)) markResult(word, good);
    else addToBook(word, true);
    quiz.phase = 'judged';
    $('#quizHint').textContent = word;
    $('#submitBtn').textContent = '下一题';
    $('#skipBtn').hidden = true;
    $('#hintBtn').hidden = true;
    $('#quizScore').textContent = '✓ ' + quiz.ok + '   ✗ ' + quiz.bad;
    // 记录定时器，避免用户手动点「下一题」与自动跳题叠加导致跳两题
    if (good) { clearTimeout(quiz.timer); quiz.timer = setTimeout(nextQuestion, 700); }
  }

  function revealAnswer() {
    if (!quiz || quiz.phase !== 'ask') return;
    var word = quiz.queue[quiz.i];
    quiz.bad++; quiz.wrong.push(word);
    if (isInBook(word)) markResult(word, false); else addToBook(word, true);
    quiz.phase = 'judged';
    $('#quizInput').value = word;
    $('#quizInput').classList.add('bad');
    $('#quizInput').readOnly = true;
    $('#quizVerdict').className = 'quiz-verdict bad';
    $('#quizVerdict').textContent = '没答上来 · 正确拼写：' + word;
    $('#quizHint').textContent = word;
    $('#quizScore').textContent = '✓ ' + quiz.ok + '   ✗ ' + quiz.bad;
    $('#submitBtn').textContent = '下一题';
    $('#skipBtn').hidden = true;
    $('#hintBtn').hidden = true;
  }

  function nextQuestion() {
    if (!quiz) return;
    clearTimeout(quiz.timer);
    quiz.i++;
    quiz.phase = 'ask';
    // 最后一题之后直接出总结，不能在越界索引上取单词
    if (quiz.i >= quiz.queue.length) { renderQuizSummary(); return; }
    quiz.hintLevel = hintStart(quiz.queue[quiz.i]);
    renderQuiz();
  }

  function renderQuizSummary() {
    var total = quiz.queue.length;
    var rate = total ? Math.round(quiz.ok / total * 100) : 0;
    var box = $('#quizMain');
    if (!quiz.wrong.length) {
      box.innerHTML = '<div class="quiz-hint">🎉</div>' +
        '<p style="font-size:17px;font-weight:650">全部答对！</p>' +
        '<p class="quiz-meta">本轮 ' + total + ' 词，正确率 100%，复习阶段已推进。</p>' +
        '<div class="quiz-btns"><button class="btn btn-primary" id="againBtn" type="button">再来一轮</button>' +
        '<button class="btn btn-ghost" id="exitBtn" type="button">返回</button></div>';
    } else {
      box.innerHTML = '<p style="font-size:17px;font-weight:650">本轮结束</p>' +
        '<p class="quiz-meta">共 ' + total + ' 词 · 正确 ' + quiz.ok + ' · 错误 ' + quiz.bad + ' · 正确率 ' + rate + '%</p>' +
        '<div class="quiz-summary"><div class="sec-title">需要再练的词（' + quiz.wrong.length + '）</div><div class="results results-tight">' +
        quiz.wrong.map(function (w) {
          return '<div class="row is-miss"><div class="row-main"><div class="row-word">' + esc(w) + '</div></div>' +
            '<div class="row-right"><button class="star" data-speak="' + esc(w) + '" type="button">🔊</button></div></div>';
        }).join('') + '</div></div>' +
        '<div class="quiz-btns" style="margin-top:14px">' +
        '<button class="btn btn-primary" id="retryWrong" type="button">只练错词</button>' +
        '<button class="btn btn-ghost" id="againBtn" type="button">再来一轮</button></div>' +
        '<button class="btn btn-ghost" id="exitBtn" type="button" style="width:100%;max-width:420px">返回</button>';
    }
  }

  function closeQuiz() {
    if (quiz) clearTimeout(quiz.timer);
    $('#quiz').hidden = true;
    document.body.style.overflow = '';
    quiz = null;
    renderStudy();
  }

  /* ==================== 词表浏览 ==================== */
  var browseState = { kind: 'letter', key: null, picked: new Set(), filter: '' };

  function renderBrowse() {
    var nav = browseState.kind === 'letter' ? $('#letterNav') : $('#pageNav');
    $('#letterNav').hidden = browseState.kind !== 'letter';
    $('#pageNav').hidden = browseState.kind !== 'page';
    nav.innerHTML = (browseState.kind === 'letter' ? LETTERS : PAGES).map(function (k) {
      var isOn = browseState.key === k;
      var label = browseState.kind === 'letter' ? String(k).toUpperCase() : 'P' + k;
      var count = (browseState.kind === 'letter' ? BY_LETTER.get(k) : BY_PAGE.get(k)).length;
      return '<button class="idx' + (isOn ? ' is-on' : '') + '" data-key="' + k + '" type="button">' +
        esc(label) + '<span>' + count + '</span></button>';
    }).join('');

    var arr = browseState.key == null ? []
      : (browseState.kind === 'letter' ? (BY_LETTER.get(browseState.key) || []) : (BY_PAGE.get(browseState.key) || []));
    var items = arr.map(function (i) { return WORDS[i]; });
    if (browseState.filter) {
      var f = browseState.filter;
      items = items.filter(function (e) { return e.w.indexOf(f) !== -1; });
    }
    $('#listCount').textContent = items.length + ' 词';
    var box = $('#browseList');
    if (!browseState.key) { box.innerHTML = '<div class="empty">上面选一个字母或页码开始浏览</div>'; renderBrowsePicks(); return; }
    if (!items.length) { box.innerHTML = '<div class="empty">该分组下没有匹配的单词</div>'; renderBrowsePicks(); return; }
    box.innerHTML = items.map(function (e) {
      var picked = browseState.picked.has(e.w);
      return '<div class="row' + (picked ? ' is-hit' : '') + '">' +
        '<button class="star ' + (picked ? 'is-on' : '') + '" data-pick="' + esc(e.w) + '" type="button" aria-label="选择">' +
        (picked ? '✓' : '+') + '</button>' +
        '<div class="row-main">' +
        '<div class="row-word" data-detail="' + esc(e.w) + '">' + esc(e.w) + '</div>' +
        '<div class="row-sub"><span class="tag">' + esc(posTag(e)) + '</span>' +
        (NOISE.has(e.w) ? '<span class="tag" style="color:var(--warn)">OCR 可疑</span>' : '') +
        (isInBook(e.w) ? '<span class="tag" style="color:var(--brand)">已在生词本</span>' : '') +
        '</div></div>' +
        '<div class="row-right"><button class="star" data-speak="' + esc(e.w) + '" type="button" aria-label="朗读">🔊</button></div>' +
        '</div>';
    }).join('');
    renderBrowsePicks();
  }

  /* ==================== 背诵表 / 导出 ==================== */
  function buildSheetHtml(words) {
    var now = new Date();
    var stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');
    var head = '<tr><th>#</th><th>单词</th><th>音标(美)</th><th>释义</th><th>助记</th><th>笔记</th>' +
      STAGES.map(function (s) { return '<th>' + s.label + '</th>'; }).join('') + '</tr>';
    var body = words.map(function (w, i) {
      return '<tr><td>' + (i + 1) + '</td><td class="w">' + esc(w) + '</td>' +
        '<td></td><td></td><td></td><td></td>' +
        STAGES.map(function () { return '<td></td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="sheet-doc">' +
      '<h1>考研英语大纲词汇背诵表 · ' + esc(META.version) + '</h1>' +
      '<p class="sheet-sub">共 ' + words.length + ' 词 · 生成时间 ' + stamp +
      ' · 词库来源：NeepWords（2026 考研英语一考试大纲，' + META.totalWords + ' 词）' +
      ' · D0/D1/D2/D4/D7/D15/D30 为间隔复习打勾栏</p>' +
      '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function printSheet() {
    var words = Array.from(browseState.picked);
    if (!words.length) { toast('请先在词表里勾选单词'); return; }
    if (words.length > 200) { toast('一次最多导出 200 词，当前 ' + words.length); return; }
    words.sort();
    $('#printArea').innerHTML = buildSheetHtml(words);
    toast('正在唤起打印，可「存储为 PDF」');
    setTimeout(function () { window.print(); }, 260);
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function sheetCsv(words) {
    var head = ['序号', '单词', '音标(美)', '释义', '助记', '笔记'].concat(STAGES.map(function (s) { return s.label; }));
    var lines = [head.join(',')];
    words.forEach(function (w, i) {
      lines.push([i + 1, '"' + w + '"', '', '', '', ''].concat(STAGES.map(function () { return ''; })).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }

  /* ==================== 单词详情弹层 ==================== */
  function openSheet(word) {
    var idx = BY_WORD.get(word);
    var e = idx == null ? null : WORDS[idx];
    var body = $('#sheetBody');
    if (!e) { toast('词库中没有这个词'); return; }
    var m = state.book[word];
    var starred = !!m;
    body.innerHTML =
      '<div class="sheet-word">' + esc(e.w) + '</div>' +
      '<div class="row-sub" style="margin-top:8px">' +
      '<span class="tag">大纲 P' + esc(e.p) + '</span>' +
      '<span class="tag">' + esc(colLabel(e.c)) + ' 第 ' + esc(e.l) + ' 行</span>' +
      '<span class="tag">版本 ' + esc(META.version) + '</span>' +
      (NOISE.has(e.w) ? '<span class="tag" style="color:var(--warn)">OCR 可疑</span>' : '') +
      '</div>' +
      '<div class="sheet-actions">' +
      '<button class="btn btn-ghost" data-speak="' + esc(e.w) + '" type="button">🔊 朗读</button>' +
      '<button class="btn ' + (starred ? 'btn-ghost' : 'btn-primary') + '" id="sheetStar" type="button">' +
      (starred ? '移出生词本' : '加入生词本') + '</button>' +
      '</div>' +
      (starred ? '<div class="sec"><div class="sec-title">复习进度</div>' + stageBar(m) +
        '<p class="hint">正确 ' + (m.seen || 0) + ' 次 · 错误 ' + (m.wrong || 0) + ' 次 · ' +
        (isMastered(m) ? '已掌握' : (isDue(m) ? '今天待复习' : '下次复习 ' + new Date(dueAt(m)).toLocaleDateString())) +
        '</p></div>' : '') +
      '<div class="sec"><div class="sec-title">大纲定位</div>' +
      '<div class="dl-box"><div style="word-break:break-all">' + esc(fmtSource(e)) + '</div>' +
      '<div class="ph" style="margin-top:6px">解析：' + esc(META.sourcePrefix) + ' · 第 ' + esc(e.p) +
      ' 页 · ' + esc(colLabel(e.c)) + ' · 第 ' + esc(e.l) + ' 行 · 原始识别词 “' + esc(e.t) + '”</div></div></div>' +
      '<div class="sec"><div class="sec-title">在线释义（需联网）</div>' +
      '<div id="dictBox" class="dl-box">点下面的按钮从免费词典接口获取英文释义、音标与例句。</div>' +
      '<button class="btn btn-ghost btn-block" id="dictBtn" type="button">查询英文释义</button></div>' +
      '<div class="sheet-actions" style="margin-top:16px">' +
      '<button class="btn btn-ghost" id="copyWord" type="button">复制单词</button>' +
      '<button class="btn btn-ghost" id="copySrc" type="button">复制来源标记</button>' +
      '</div>';

    $('#backdrop').hidden = false;
    $('#sheet').hidden = false;
    document.body.style.overflow = 'hidden';

    $('#sheetStar').addEventListener('click', function () {
      if (isInBook(word)) { removeFromBook(word); closeSheet(); }
      else { addToBook(word, true); toast('已加入生词本'); openSheet(word); }
    });
    $('#copyWord').addEventListener('click', function () { copyText(e.w, '已复制单词'); });
    $('#copySrc').addEventListener('click', function () { copyText(fmtSource(e), '已复制来源标记'); });
    $('#dictBtn').addEventListener('click', function () { fetchDict(e.w); });
  }

  function closeSheet() {
    $('#backdrop').hidden = true;
    $('#sheet').hidden = true;
    document.body.style.overflow = '';
  }

  function fetchDict(word) {
    var box = $('#dictBox');
    box.innerHTML = '查询中…';
    fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word))
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (data) {
        var entry = data && data[0];
        if (!entry) throw new Error('empty');
        var phon = '';
        if (entry.phonetic) phon = entry.phonetic;
        else if (entry.phonetics && entry.phonetics.length) {
          for (var i = 0; i < entry.phonetics.length; i++) if (entry.phonetics[i].text) { phon = entry.phonetics[i].text; break; }
        }
        var out = phon ? '<div class="ph">' + esc(phon) + '</div>' : '';
        var meanings = entry.meanings || [];
        if (!meanings.length) { box.innerHTML = out + '该词条没有可用的英文释义。'; return; }
        out += '<ol>';
        meanings.slice(0, 3).forEach(function (mn) {
          (mn.definitions || []).slice(0, 2).forEach(function (d) {
            out += '<li><span class="pos">' + esc(mn.partOfSpeech || '') + '</span>' + esc(d.definition || '') +
              (d.example ? '<div class="eg">例：' + esc(d.example) + '</div>' : '') + '</li>';
          });
        });
        out += '</ol><div class="ph" style="margin-top:8px">来源：dictionaryapi.dev（免费开源词典接口，英文释义）</div>';
        box.innerHTML = out;
      })
      .catch(function () {
        box.innerHTML = '没有取到释义（可能离线、被网络拦截，或该词不在该词典中）。' +
          '本应用的词库只包含大纲词表，本身不内置释义。';
      });
  }

  /* ==================== 我的 ==================== */
  function renderMine() {
    var kv = [
      ['词库版本', META.version + '（' + META.label + '）'],
      ['收录词数', META.totalWords + ' 词'],
      ['大纲页码', 'P' + META.pageMin + ' – P' + META.pageMax + '（' + META.pageCount + ' 页）'],
      ['来源前缀', META.sourcePrefix],
      ['数据导入', (META.importedAt || '').slice(0, 10)],
      ['提取自', META.generatedFrom || '—']
    ];
    $('#metaList').innerHTML = kv.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');

    var counts = LETTERS.map(function (k) { return BY_LETTER.get(k).length; });
    var max = Math.max.apply(null, counts);
    $('#letterBars').innerHTML = LETTERS.map(function (k, i) {
      var h = Math.max(5, Math.round(counts[i] / max * 76));
      return '<div class="bar" title="' + k.toUpperCase() + '：' + counts[i] + ' 词">' +
        '<i style="height:' + h + 'px"></i><span>' + k.toUpperCase() + '</span></div>';
    }).join('');

    var noise = META.noiseWords || [];
    $('#noiseChip').textContent = noise.length;
    $('#noiseList').innerHTML = noise.map(function (n) {
      return '<div class="row"><div class="row-main">' +
        '<div class="row-word" data-detail="' + esc(n.word) + '">' + esc(n.word) + '</div>' +
        '<div class="row-sub">' + esc(n.reason) + '</div></div>' +
        '<div class="row-right"><span class="row-status na">待核对</span></div></div>';
    }).join('');

    $('#appVer').textContent = META.appVersion || '1.0.0';
    $('#genAt').textContent = (META.importedAt || '').slice(0, 10) || '—';
  }

  function exportData() {
    var payload = {
      app: 'NeepWords Mobile',
      version: META.appVersion || '1.0.0',
      exportedAt: new Date().toISOString(),
      lexicon: { version: META.version, total: META.totalWords },
      book: state.book,
      settings: state.settings
    };
    var d = new Date();
    var name = 'neepwords-backup-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '.json';
    downloadText(name, JSON.stringify(payload, null, 2), 'application/json');
    toast('已导出学习数据');
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(String(reader.result));
        if (!obj || typeof obj !== 'object' || !obj.book) throw new Error('bad');
        var n = 0;
        Object.keys(obj.book).forEach(function (w) {
          if (BY_WORD.has(w)) { state.book[w] = obj.book[w]; n++; }
        });
        if (obj.settings) state.settings = Object.assign(state.settings, obj.settings);
        save();
        toast('已导入 ' + n + ' 个生词');
        renderStudy(); renderLookup(lookupState.results); renderBrowse();
      } catch (e) {
        toast('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
  }

  /* ==================== 主题 ==================== */
  function applyTheme() {
    var t = state.settings.theme;
    if (t === 'auto') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0e1116' : '#0f766e');
  }

  /* ==================== 事件绑定 ==================== */
  function bind() {
    $$('.tab').forEach(function (b) {
      b.addEventListener('click', function () { goto(b.dataset.goto); });
    });

    $('#themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      state.settings.theme = cur === 'dark' ? 'light' : 'dark';
      save(); applyTheme();
      toast(state.settings.theme === 'dark' ? '已切到深色' : '已切到浅色');
    });

    // 查词
    $('#lookupBtn').addEventListener('click', doLookup);
    $('#lookupInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doLookup(); });
    $('#lookupInput').addEventListener('input', function () {
      clearTimeout(suggestTimer);
      var v = $('#lookupInput').value;
      suggestTimer = setTimeout(function () { showSuggest(v); }, 140);
    });
    $('#lookupInput').addEventListener('blur', function () { setTimeout(hideSuggest, 180); });
    $('#suggestBox').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-suggest]');
      if (!btn) return;
      $('#lookupInput').value = btn.dataset.suggest;
      hideSuggest(); doLookup();
    });
    $$('.quick').forEach(function (b) {
      b.addEventListener('click', function () {
        $('#lookupInput').value = b.dataset.lookup;
        doLookup();
      });
    });

    // 检索
    $('#searchBtn').addEventListener('click', function () { doSearch(true); });
    $('#searchInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSearch(true); });
    $('#modeSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('.seg-item');
      if (!b) return;
      $$('#modeSeg .seg-item').forEach(function (x) { x.classList.toggle('is-on', x === b); });
      $('#modeHint').textContent = MODE_HINTS[b.dataset.mode] || '';
      if ($('#searchInput').value.trim()) doSearch(true);
    });
    $('#prevPage').addEventListener('click', function () { searchState.page = Math.max(0, searchState.page - 1); doSearch(false); });
    $('#nextPage').addEventListener('click', function () { searchState.page++; doSearch(false); });
    $('#searchAll').addEventListener('click', function () {
      var r = searchState.result;
      if (!r || !r.ok || !r.items.length) { toast('先检索出结果再收藏'); return; }
      var n = 0;
      r.items.forEach(function (e) { if (addToBook(e.w, true)) n++; });
      toast(n ? '已把本页 ' + n + ' 词加入生词本' : '本页单词都已在生词本');
      renderSearch();
    });

    // 背词
    $('#startQuiz').addEventListener('click', startQuiz);
    $('#bookSort').addEventListener('change', renderStudy);
    $('#clearBook').addEventListener('click', function () {
      if (!Object.keys(state.book).length) { toast('生词本已经是空的'); return; }
      if (!window.confirm('确定清空生词本与全部复习进度？此操作不可撤销。')) return;
      state.book = {}; save();
      toast('生词本已清空'); renderStudy(); renderBrowsePicks();
    });

    // 词表
    $('#browseSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('.seg-item');
      if (!b) return;
      $$('#browseSeg .seg-item').forEach(function (x) { x.classList.toggle('is-on', x === b); });
      browseState.kind = b.dataset.browse;
      browseState.key = browseState.kind === 'letter' ? LETTERS[0] : PAGES[0];
      renderBrowse();
    });
    $('#letterNav').addEventListener('click', function (ev) {
      var b = ev.target.closest('.idx'); if (!b) return;
      browseState.key = b.dataset.key; renderBrowse();
    });
    $('#pageNav').addEventListener('click', function (ev) {
      var b = ev.target.closest('.idx'); if (!b) return;
      browseState.key = parseInt(b.dataset.key, 10); renderBrowse();
    });
    $('#filterInput').addEventListener('input', function () {
      browseState.filter = $('#filterInput').value.trim().toLowerCase();
      renderBrowse();
    });
    $('#selectAllGroup').addEventListener('change', function (ev) {
      var on = ev.target.checked;
      var arr = browseState.key == null ? [] : (browseState.kind === 'letter'
        ? (BY_LETTER.get(browseState.key) || []) : (BY_PAGE.get(browseState.key) || []));
      arr.forEach(function (i) {
        var w = WORDS[i].w;
        if (browseState.filter && w.indexOf(browseState.filter) === -1) return;
        if (on) browseState.picked.add(w); else browseState.picked.delete(w);
      });
      renderBrowse();
    });
    $('#pickedToBook').addEventListener('click', function () {
      if (!browseState.picked.size) { toast('先勾选单词'); return; }
      var n = 0;
      browseState.picked.forEach(function (w) { if (addToBook(w, true)) n++; });
      toast(n ? '已加入 ' + n + ' 词到生词本' : '这些词都已在生词本');
      renderBrowse();
    });
    $('#pickedToSheet').addEventListener('click', printSheet);

    // 我的
    $('#exportBtn').addEventListener('click', exportData);
    $('#importBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function (ev) {
      if (ev.target.files && ev.target.files[0]) importData(ev.target.files[0]);
      ev.target.value = '';
    });
    $('#copyWordsBtn').addEventListener('click', function () {
      var ws = Object.keys(state.book);
      if (!ws.length) { toast('生词本还是空的'); return; }
      copyText(ws.join('\n'), '已复制 ' + ws.length + ' 个单词');
    });
    $('#copyNoise').addEventListener('click', function () {
      var lines = (META.noiseWords || []).map(function (n) { return n.word + '\t' + n.reason; });
      copyText(lines.join('\n'), '已复制 ' + lines.length + ' 条可疑词');
    });
    $('#resetBtn').addEventListener('click', function () {
      if (!window.confirm('这会清空生词本、复习进度和设置，且无法恢复。确定继续？')) return;
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* noop */ }
      state.book = {};
      state.settings = { theme: 'auto', mode: 'prefix', limit: 50 };
      applyTheme(); renderStudy(); renderBrowse(); renderMine(); renderLookup(null);
      toast('已重置');
    });

    // 全局委托：★ 收藏 / 详情 / 朗读 / 勾选
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      var star = t.closest('[data-star]');
      if (star) {
        var w = star.dataset.star;
        if (isInBook(w)) { removeFromBook(w); } else { addToBook(w); }
        renderStudy(); renderLookup(lookupState.results); renderSearch(); renderBrowse();
        return;
      }
      var pick = t.closest('[data-pick]');
      if (pick) {
        var pw = pick.dataset.pick;
        if (browseState.picked.has(pw)) browseState.picked.delete(pw); else browseState.picked.add(pw);
        renderBrowse();
        return;
      }
      var sp = t.closest('[data-speak]');
      if (sp) { speak(sp.dataset.speak, 0.85); return; }
      var dt = t.closest('[data-detail]');
      if (dt) { openSheet(dt.dataset.detail); return; }
    });

    // 弹层关闭
    $('#backdrop').addEventListener('click', closeSheet);

    // 听写面板委托
    $('#quiz').addEventListener('click', function (ev) {
      var t = ev.target;
      if (t.closest('#playBtn')) { speak(quiz.queue[quiz.i], 0.85); return; }
      if (t.closest('#submitBtn')) { quiz.phase === 'ask' ? submitQuiz() : nextQuestion(); return; }
      if (t.closest('#hintBtn')) {
        quiz.hintLevel = Math.min(quiz.hintLevel + 1, quiz.queue[quiz.i].replace(/[^a-z]/gi, '').length);
        $('#quizHint').textContent = hintFor(quiz.queue[quiz.i], quiz.hintLevel);
        return;
      }
      if (t.closest('#skipBtn')) { revealAnswer(); return; }
      if (t.closest('#quizClose')) { closeQuiz(); return; }
      if (t.closest('#exitBtn')) { closeQuiz(); return; }
      if (t.closest('#againBtn')) {
        var src = $('#quizSource').value;
        var size = parseInt($('#quizSize').value, 10);
        var q = buildQuizQueue(src === 'wrong' ? 'wrong' : src, size);
        if (!q.length) { toast('没有可用的词'); return; }
        quiz = { queue: q, i: 0, ok: 0, bad: 0, wrong: [], phase: 'ask', hintLevel: hintStart(q[0]) };
        renderQuiz();
        return;
      }
      if (t.closest('#retryWrong')) {
        quiz = { queue: quiz.wrong.slice(), i: 0, ok: 0, bad: 0, wrong: [], phase: 'ask', hintLevel: 0 };
        renderQuiz();
        return;
      }
    });

    // 系统主题变化
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (state.settings.theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    // 键盘 Esc
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!$('#quiz').hidden) closeQuiz();
      else if (!$('#sheet').hidden) closeSheet();
    });
  }

  /* ==================== 初始化 ==================== */
  function init() {
    load();
    applyTheme();

    $('#dbLabel').textContent = META.version + ' 考研英语（一）大纲';
    $('#dbChip').textContent = META.totalWords + ' 词';
    $('#dbNote').textContent = 'P' + META.pageMin + '–P' + META.pageMax + ' 共 ' + META.pageCount +
      ' 页 · 数据导入于 ' + (META.importedAt || '').slice(0, 10) +
      ' · 全库 ' + META.totalWords + ' 词收录于本 APP，可离线查询';

    // 恢复设置
    var modeB = $('#modeSeg [data-mode="' + state.settings.mode + '"]');
    if (modeB) {
      $$('#modeSeg .seg-item').forEach(function (x) { x.classList.toggle('is-on', x === modeB); });
    }
    $('#modeHint').textContent = MODE_HINTS[state.settings.mode] || MODE_HINTS.prefix;
    if (state.settings.limit) $('#searchLimit').value = String(state.settings.limit);

    browseState.key = LETTERS[0] || null;
    bind();
    renderLookup(null);
    renderSearch();
    renderStudy();
    renderBrowse();
    renderMine();
    goto('lookup');

    // 离线缓存
    // 离线缓存：套壳 App 的资源本来就在安装包内，无需再注册 SW；
    // 只在真正的网页环境（http/https 且非 Capacitor 容器）启用
    var isNativeShell = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if ('serviceWorker' in navigator && !isNativeShell && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 离线能力不可用时静默降级 */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
