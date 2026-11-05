/* Экмафиси — логика приложения (из пробной страницы). Грузится из sync.js, когда вход проверен и список текстов есть:
   EK.lib — тексты, EK.uid — кто вошёл, EK.content(путь) — файл из закрытого хранилища (с кэшем), EK.queue* — отправка. */
const LIB = EK.lib;
const LEVELS = { A1: 1, A2: 2, B1: 3, B2: 4 };
const MODE_NAME = { skor: 'Скороговорка', bt: 'Обратный перевод' };
/* язык материала: текст фразы — поле t (прежние греческие материалы — el), порядок форм глагола и надписи — по языку */
const LANGS = {
  el: { name: 'греческий', chip: 'ΕΛ', say: 'по-гречески', forms: ['present', 'imperfect', 'aorist', 'future'] },
  en: { name: 'английский', chip: 'EN', say: 'по-английски', forms: ['base', 'past', 'participle'] }
};
const LG = m => LANGS[m.lang] || LANGS.el;
const TX = p => p.t ?? p.el;
const TTL = m => m.title_t ?? m.title_el;
const AUTHOR = m => m.source.author_ru || m.source.author;
/* полка: сначала по языку (греческий, английский), внутри — по уровню; одинаковые — в порядке сборки */
const LORD = Object.keys(LANGS);
LIB.sort((a, b) => (LORD.indexOf(a.lang) - LORD.indexOf(b.lang)) || (LEVELS[a.level] || 9) - (LEVELS[b.level] || 9));
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });

/* --- хранение: сначала на устройстве, под id человека; всякое изменение — в очередь на отправку (sync.js) --- */
const SKEY = 'ekmafisi.settings';
const userKey = k => k.replace(/^ekmafisi\./, 'ekmafisi.' + EK.uid + '.');
const read = k => { try { return JSON.parse(localStorage.getItem(userKey(k)) || 'null'); } catch (e) { return null; } };
const write = (k, v) => { try { localStorage.setItem(userKey(k), JSON.stringify(v)); } catch (e) {} };
let G = Object.assign({ rate: 1, input: 'voice', last: null, mode: 'skor', theme: 'auto' }, read(SKEY) || {});
if (![0.8, 1, 1.5].includes(G.rate)) G.rate = G.rate < 1 ? 0.8 : 1;
/* настройки на сервере — по ключу { v, t }: rate, input, mode, theme, last; pos.<текст> — где остановился; flags — «Неверно?» */
/* язык обучения — lang; «Продолжить» — свой у каждого языка: last.el, last.en */
const G_SYNC = ['rate', 'input', 'mode', 'theme', 'lang', ...Object.keys(LANGS).map(l => 'last.' + l)];
if (G.last) { const m0 = LIB.find(m => m.id === G.last); if (m0 && !G['last.' + m0.lang]) G['last.' + m0.lang] = G.last; delete G.last; }  /* прежний общий last */
const lastId = () => G.lang && G['last.' + G.lang];
const TKEY = 'ekmafisi.settings.t';
function setSynced(key, v) {  /* отправить ключ, если значение изменилось с прошлой отправки */
  const T = read(TKEY) || {};
  /* ключ впервые на этом устройстве — значение «давнее»: сервер, если там новее, его заменит, а не наоборот */
  if (!T[key]) { T[key] = { v, t: EPOCH }; write(TKEY, T); return; }
  if (JSON.stringify(T[key].v) === JSON.stringify(v)) return;
  T[key] = { v, t: now() }; write(TKEY, T); EK.queueSettings(key, v, T[key].t);
}
const EPOCH = '1970-01-01T00:00:00.000Z';
G_SYNC.forEach(k => setSynced(k, G[k]));
const saveG = () => { write(SKEY, G); G_SYNC.forEach(k => setSynced(k, G[k])); };
const progOf = m => {  /* прогресс прежней нарезки (cut) к новым фразам не относится — начинаем заново */
  const v = read('ekmafisi.' + m.id);
  return Object.assign({ colors: {}, written: {}, ts: {}, log: [], skorAt: 0, btAt: 0, resetAt: '' }, v && (v.cut || 1) === (m.cut || 1) ? v : {});
};
const writeProg = (m, s) => write('ekmafisi.' + m.id, { cut: m.cut || 1, colors: s.colors, written: s.written, ts: s.ts, log: s.log, skorAt: s.skorAt, btAt: s.btAt, resetAt: s.resetAt });

let M = null, P = [], CHUNKS = [], S = null;
const save = () => { writeProg(M, S); setSynced('pos.' + M.id, { skorAt: S.skorAt, btAt: S.btAt }); };
/* фраза изменилась (цвет или написанное) — строка «человек × текст × фраза» с временем изменения */
function touch(m, s, pid) {
  s.ts[pid] = now();
  EK.queueProgress({ lang: m.lang || 'el', text_id: m.id, phrase_id: pid, cut: m.cut || 1, color: s.colors[pid] || null, written: s.written[pid] || null, updated_at: s.ts[pid] });
}
function logAdd(m, s, e) {  /* журнал: только добавление; id — чтобы два устройства не задвоили запись */
  const id = uuid(), at = now();
  s.log.push(Object.assign({ id, t: at.slice(0, 16) }, e));
  EK.queueLog({ id, at, kind: 'mark', lang: m.lang || 'el', text_id: m.id, phrase_id: e.p, mode: e.m, color: e.c });
}
function mark(i, c, mode) {
  S.colors[P[i].id] = c;
  touch(M, S, P[i].id);
  logAdd(M, S, { p: P[i].id, c, m: mode });
  save();
}

/* --- звук: файл текста — из закрытого хранилища при первом открытии, дальше — из кэша устройства --- */
const audio = new Audio(); audio.preload = 'auto';
const blobs = {};
let audioReady = Promise.resolve();
function loadAudio(m) {
  const show = on => $('loading').classList.toggle('hidden', !on);
  if (blobs[m.id]) { audio.src = blobs[m.id]; show(false); return (audioReady = Promise.resolve()); }
  show(true); $('loading').textContent = 'Загружаю звук…';
  return (audioReady = EK.content(m.audio.file).then(r => r.blob())
    .then(b => { blobs[m.id] = URL.createObjectURL(b); if (M === m) audio.src = blobs[m.id]; show(false); })
    .catch(() => { $('loading').textContent = navigator.onLine ? 'Звук не загрузился. Откройте текст снова.' : 'Нет сети: звук этого текста ещё не загружался.'; }));
}
let stopAt = null, onEnd = null, raf = 0, seqToken = 0;
/* «▶» — и пауза: owner — кнопка или строка, что сейчас звучит; повторное нажатие на неё ставит паузу, ещё одно — продолжает с того же места */
let owner = null, paused = false, seqActive = false, heldNext = null;
/* кнопка звука — значок без слова: ▶ или, пока звучит, ⏸ */
const ICO = d => `<svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICO_PLAY = ICO('<path d="M6.5 3.2v17.6L21 12z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>');
const ICO_PAUSE = ICO('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>');
function paintOwner() {
  document.querySelectorAll('.ic.play').forEach(b => {
    const on = b === owner && (stopAt !== null || seqActive) && !paused;
    if (b.dataset.on !== String(on)) { b.dataset.on = String(on); b.innerHTML = on ? ICO_PAUSE : ICO_PLAY; }
  });
}
function tick() {
  if (stopAt !== null && audio.currentTime >= stopAt) {
    audio.pause(); stopAt = null; const f = onEnd; onEnd = null; f && f();
    if (!seqActive && stopAt === null) owner = null;
    paintOwner(); return;
  }
  if (stopAt !== null && !paused) raf = requestAnimationFrame(tick);
}
/* запасная остановка: rAF спит в фоне и на погасшем экране, timeupdate — нет; опоздание ≤ 0,25 с уходит в тишину после фразы */
audio.addEventListener('timeupdate', () => { if (stopAt !== null && audio.currentTime >= stopAt) { cancelAnimationFrame(raf); tick(); } });
function stop() {
  seqToken++; cancelAnimationFrame(raf); audio.pause(); stopAt = null; onEnd = null;
  owner = null; paused = false; seqActive = false; heldNext = null; paintOwner();
  document.querySelectorAll('.playing').forEach(e => e.classList.remove('playing'));
}
function pause() { paused = true; cancelAnimationFrame(raf); audio.pause(); paintOwner(); }
function resume() {
  paused = false;
  if (heldNext) { const f = heldNext; heldNext = null; f(); }
  else if (stopAt !== null) { const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {}); raf = requestAnimationFrame(tick); }
  paintOwner();
}
/* нажатие на el: звучит el — пауза; на паузе — дальше; иначе — начать заново (start) */
function toggle(el, start) {
  if (owner === el && (stopAt !== null || seqActive)) { paused ? resume() : pause(); return; }
  start();
}
function playBy(el, i, rate, done) { stop(); owner = el; playOne(i, rate, done); paintOwner(); }
function playOne(i, rate, done) {
  cancelAnimationFrame(raf); audio.pause(); paused = false;
  if (!blobs[M.id]) { done && done(); return; }
  audio.defaultPlaybackRate = rate; audio.playbackRate = rate;
  audio.preservesPitch = true; audio.webkitPreservesPitch = true;
  /* фразы лежат в файле подряд, каждая с затуханием и тишиной после: at — начало фразы в файле */
  audio.currentTime = P[i].at;
  stopAt = P[i].at + (P[i].end - P[i].start); onEnd = done || null;
  const pr = audio.play();
  if (pr && pr.catch) pr.catch(() => {});
  raf = requestAnimationFrame(tick);
}
function playSeq(el, idx, rate, markFn) {
  stop(); const tok = seqToken; let k = 0;
  owner = el; seqActive = true;
  const next = () => {
    if (tok !== seqToken) return;
    if (paused) { heldNext = next; return; }  /* пауза пришлась на промежуток между фразами */
    document.querySelectorAll('.playing').forEach(e => e.classList.remove('playing'));
    if (k >= idx.length) { seqActive = false; owner = null; paintOwner(); return; }
    const i = idx[k++]; markFn && markFn(i);
    playOne(i, rate, () => setTimeout(next, 450));
  };
  next(); paintOwner();
}

/* --- общее --- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11) ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? b : c;
const RATE_LBL = r => r === 1 ? 'оригинал' : String(r).replace('.', ',') + '×';
function counts(m, colors) {
  const c = { g: 0, y: 0, r: 0 };
  m.phrases.forEach(p => { const v = colors[p.id]; if (v) c[v]++; });
  return c;
}
/* счёт по цветам — цифрой рядом с квадратиком своего цвета; пустой квадратик — без цвета */
const squaresHtml = (c, n) => `<span class="sqs">${['g', 'y', 'r'].map(k => `<span class="sq"><i class="${k}"></i>${c[k]}</span>`).join('')}<span class="sq"><i></i>${n - c.g - c.y - c.r}</span></span>`;
const tallyHtml = (c, n) => ['g', 'y', 'r'].map(k => `<span style="width:${c[k] / n * 100}%;background:var(--${k})"></span>`).join('');

function show(id) {
  stop();
  ['shelf', 'settings', 'home', 'skor', 'bt'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  window.scrollTo(0, 0);
  if (id === 'shelf') { if (window.EK_UPDATE) return location.reload(); renderShelf(); }
  if (id === 'home') renderHome();
  if (id === 'settings') renderSettings();
}
const shown = id => !$(id).classList.contains('hidden');

/* --- переходы: каждый экран и окно — шаг в истории браузера, системное «назад» и «←» идут на шаг выше:
   полка ← текст (#id) ← режим (#id-skor, #id-bt) ← окно слова (значения, происхождение, история) */
const MODES = ['skor', 'bt'];
const urlOf = h => h ? '#' + h : location.pathname + location.search;
const depth = () => (history.state && history.state.d) || 0;
const curHash = () => location.hash.slice(1);
function push(hash, sheet) { history.pushState({ d: depth() + 1, sheet: sheet || null }, '', urlOf(hash)); }
function goBack(fallback) {  /* открыто ссылкой прямо сюда — шага назад в странице нет: подменяем запись на экран выше */
  if (depth() > 0) history.back();
  else { history.replaceState({ d: 0, sheet: null }, '', urlOf(fallback)); applyLoc(); }
}
function parseHash(h) {
  if (h === 'settings') return { v: 'settings' };
  for (const v of MODES) if (h.endsWith('-' + v)) { const id = h.slice(0, -v.length - 1); if (LIB.some(m => m.id === id)) return { v, id }; }
  return LIB.some(m => m.id === h) ? { v: 'home', id: h } : { v: 'shelf' };
}
function applyLoc(force) {  /* force — первый вход: экран рисуется, даже если уже виден */
  const t = parseHash(curHash()), sh = history.state && history.state.sheet;
  if (t.v === 'shelf' || t.v === 'settings') { if (force || !shown(t.v)) show(t.v); }
  else {
    const fresh = !M || M.id !== t.id;
    if (fresh) setText(t.id);
    if (force || fresh || !shown(t.v)) t.v === 'home' ? show('home') : t.v === 'bt' ? btOpen(S.btAt) : skorOpen(S.skorAt);
  }
  sh ? openSheet(sh) : closeSheet();
}
window.addEventListener('popstate', () => applyLoc());

/* --- полка --- */
function renderShelf() {
  /* язык не выбран — сначала выбор; выбран — на полке только его тексты */
  $('langPick').classList.toggle('hidden', !!G.lang);
  $('shelfList').classList.toggle('hidden', !G.lang);
  $('texts').innerHTML = LIB.filter(m => m.lang === G.lang).map(m => {
    const pr = progOf(m), c = counts(m, pr.colors), n = m.phrases.length;
    const done = c.g + c.y + c.r;
    return `<button class="text${lastId() === m.id ? ' last' : ''}" data-id="${m.id}">
      <span class="top"><span class="row" style="gap:6px"><span class="chip lang" title="${esc(LG(m).name)}">${esc(LG(m).chip)}</span><span class="chip">${esc(m.level)}</span></span><span class="meta2">${n} ${plural(n, 'фраза', 'фразы', 'фраз')}</span></span>
      <span class="t">${esc(m.title)}</span>
      <span class="tel">${esc(TTL(m))}</span>
      <span class="meta2">${esc(AUTHOR(m))}, «${esc(m.source.channel)}»</span>
      ${done ? squaresHtml(c, n) : ''}
      <span class="tally" aria-hidden="true">${tallyHtml(c, n)}</span>
    </button>`;
  }).join('');
  document.querySelectorAll('#texts .text').forEach(b => b.onclick = () => openText(b.dataset.id));
  const last = LIB.find(m => m.id === lastId());
  $('resume').classList.toggle('hidden', !last);
  if (last) $('resume').innerHTML = `<span>Продолжить · ${esc(MODE_NAME[G.mode] || MODE_NAME.skor)}</span><small>${esc(last.title)}</small>`;
}
$('resume').onclick = () => { openText(lastId()); start(G.mode); };
document.querySelectorAll('#langPick [data-lang]').forEach(b => b.onclick = () => { G.lang = b.dataset.lang; saveG(); renderShelf(); });
/* --- настройки: всё, что не учёба — язык, тема, учётная запись, итог --- */
$('setOpen').onclick = () => { push('settings'); show('settings'); };
function renderSettings() {
  document.querySelectorAll('#setLang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === G.lang)));
  document.querySelectorAll('#setTheme button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === (G.theme || 'auto'))));
}
document.querySelectorAll('#setLang button').forEach(b => b.onclick = () => { G.lang = b.dataset.lang; saveG(); renderSettings(); });
/* крупный шрифт: +3 px ко всем текстам; только на этом устройстве (экраны телефона и Мака разные), ключ вне учётной записи — читается до входа */
const BIG = 'ekmafisi-big';
const paintBig = () => { const on = document.documentElement.classList.contains('big'); $('setBig').setAttribute('aria-checked', String(on)); };
$('setBig').onclick = () => { const on = document.documentElement.classList.toggle('big'); try { localStorage.setItem(BIG, on ? '1' : '0'); } catch (e) {} paintBig(); };
paintBig();
document.querySelectorAll('#setTheme button').forEach(b => b.onclick = () => { G.theme = b.dataset.t; saveG(); paintTheme(); renderSettings(); });

function setText(id) {
  const m = LIB.find(x => x.id === id);
  M = m; P = m.phrases; CHUNKS = m.chunks; S = progOf(m);
  G['last.' + (m.lang || 'el')] = m.id; saveG();
  loadAudio(m); loadLex(m);
}
function openText(id) { setText(id); push(id); show('home'); }

/* --- текст --- */
function renderHome() {
  const c = counts(M, S.colors), n = P.length;
  $('hSrc').textContent = `${LG(M).name} · ${M.level} · ${AUTHOR(M)}, «${M.source.channel}»`;
  $('hTitle').textContent = M.title; $('hTitleEl').textContent = TTL(M);
  $('ytLink').classList.toggle('hidden', !M.source.url); if (M.source.url) $('ytLink').href = M.source.url;
  $('stat').innerHTML = `${n} ${plural(n, 'фраза', 'фразы', 'фраз')}` + squaresHtml(c, n);
  $('tally').innerHTML = tallyHtml(c, n);
  $('run').textContent = 'Запустить · ' + MODE_NAME[G.mode];
  $('list').innerHTML = P.map((p, i) => `<div class="ph" data-i="${i}"><button class="ph-play"><span class="dot ${S.colors[p.id] || ''}"></span><span class="el">${esc(TX(p))}</span><span class="ru">${esc(p.ru)}</span></button><button class="ph-go" aria-label="Учить с этой фразы">›</button></div>`).join('');
  document.querySelectorAll('#list .ph').forEach(r => {
    const i = +r.dataset.i;
    r.querySelector('.ph-play').onclick = () => toggle(r, () => { playBy(r, i, G.rate, () => r.classList.remove('playing')); r.classList.add('playing'); });
    r.querySelector('.ph-go').onclick = () => start(G.mode, i);  /* любая фраза, не по очереди; «Обратный перевод» — с куска, где она есть */
  });
}
document.querySelectorAll('.mode').forEach(b => b.onclick = () => start(b.dataset.mode));
$('run').onclick = () => start(G.mode);
function start(mode, i) {  /* i — с какой фразы; без него — с того места, где остановились */
  G.mode = mode; saveG(); push(M.id + '-' + mode);
  if (mode === 'bt') btOpen(i === undefined ? S.btAt : Math.max(0, CHUNKS.findIndex(c => c.includes(i))));
  else skorOpen(i === undefined ? S.skorAt : i);
}

$('copy').onclick = () => {
  const lines = [`Экмафиси · ${new Date().toISOString().slice(0, 10)} · скорость скороговорки: ${RATE_LBL(G.rate)}`];
  LIB.forEach(m => {
    const pr = progOf(m); if (!pr.log.length) return;
    lines.push('', `## ${m.id} — ${m.title}`);
    m.phrases.forEach(p => {
      const c = pr.colors[p.id], w = pr.written[p.id];
      if (c || w) lines.push(`${p.id} ${c ? { g: 'зел', y: 'жёл', r: 'кр' }[c] : '—'}${w ? ' | написал: ' + w : ''}`);
    });
    lines.push('Журнал:'); pr.log.forEach(l => lines.push(`${l.t} ${l.p} ${l.m} ${l.c}`));
  });
  const flags = read('ekmafisi.etymflags') || {};
  if (Object.keys(flags).length) { lines.push('', '## Происхождение — «Неверно?»'); Object.keys(flags).forEach(l => lines.push(`${flags[l].t} ${l}: ${flags[l].text}`)); }
  if (lines.length === 1) lines.push('Пока ничего не отмечено.');
  const txt = lines.join('\n');
  const fallback = () => { $('copyWrap').classList.remove('hidden'); $('copyText').value = txt; $('copyText').select(); };
  try { navigator.clipboard.writeText(txt).then(() => { $('copy').textContent = 'Скопировано'; setTimeout(() => $('copy').textContent = 'Скопировать итог', 2000); }, fallback); } catch (e) { fallback(); }
};
$('reset').onclick = () => $('resetWrap').classList.remove('hidden');
$('resetNo').onclick = () => $('resetWrap').classList.add('hidden');
$('resetYes').onclick = () => {
  const ids = new Set([...Object.keys(S.colors), ...Object.keys(S.written)]);
  const at = now(), id = uuid();
  S = { colors: {}, written: {}, ts: S.ts, log: [], skorAt: 0, btAt: 0, resetAt: at };
  ids.forEach(pid => touch(M, S, pid));
  EK.queueLog({ id, at, kind: 'reset', lang: M.lang || 'el', text_id: M.id });
  save();
  $('resetWrap').classList.add('hidden'); renderHome();
};

/* --- подсказка по слову --- */
function wordsHtml(p) {  /* слова из words — в настоящем тексте фразы, со всей пунктуацией */
  let h = '', at = 0;
  p.words.forEach((w, k) => {
    const pos = TX(p).indexOf(w.t, at);
    if (pos < 0) return;
    h += esc(TX(p).slice(at, pos)) + (w.l ? `<span class="w" data-k="${k}" data-l="${esc(w.l)}">${esc(w.t)}</span>` : esc(w.t));
    at = pos + w.t.length;
  });
  return h + esc(TX(p).slice(at));
}
/* пометка к слову в контексте без повтора перевода: часть «X — …», где X уже есть в переводе леммы, не показывается */
function noteOf(w, L) {
  if (!w.g) return '';
  const ru = base(L.ru || '');
  return w.g.split(/;\s*/).filter(s => { const head = s.split(' — ')[0]; return !(s.includes(' — ') && /\p{Script=Greek}/u.test(head) && ru.includes(base(head))); }).join('; ');
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const formsOf = (L, D) => L.forms ? LG(M).forms.map(k => (L.forms[k] || '—').replace(/ /g, '\u00a0')).join(' · ') : (D && D.dict.forms) || '';
function glossHtml(w) {
  const L = M.lexicon[w.l] || {}, D = LEX[w.l];
  let h = `<div>${esc(cap(L.ru || (D && D.dict.senses[0] && D.dict.senses[0].ru) || ''))}</div>`;
  const g = noteOf(w, L);
  if (g) h += `<div class="small muted">${esc(cap(g))}</div>`;
  /* формы строкой, без названий времён: el — настоящее · παρατατικός · аорист · будущее; en — base · past · participle, только у неправильных */
  const f = formsOf(L, D);
  if (f) h += `<div class="el">${esc(f)}</div>` + (L.note ? `<div class="small muted">${esc(cap(L.note))}</div>` : '');
  else if (base(w.t) !== base(w.l)) h += `<div class="el">${esc(w.l)}</div>`;
  const a = [];
  if (D && D.dict.senses.length) a.push(`<button class="link" data-senses="${esc(w.l)}">Значения</button>`);
  if (D && D.etym) a.push(`<button class="link" data-etym="${esc(w.l)}">Происхождение</button>`);
  if (a.length) h += `<div class="gl-links">${a.join('<span class="muted">·</span>')}</div>`;
  return h;
}
/* нажатое слово подсвечено в предложении, пока открыта его карточка */
function pickWord(scope, el) { scope.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); }
function sensesHtml(d) {
  let h = '<ol class="senses">' + d.senses.map(s => `<li>${s.label ? `<i>${esc(s.label)}</i> ` : ''}${esc(s.ru)}${s.ex.map(x => `<span class="ex"><span class="el">${esc(x.el)}</span> — ${esc(x.ru)}</span>`).join('')}</li>`).join('') + '</ol>';
  if (d.phrases.length) h += '<div class="phr"><span class="small muted">Выражения</span>' + d.phrases.map(x => `<div><span class="el">${esc(x.el)}</span> — ${esc(x.ru)}</div>`).join('') + '</div>';
  return h;
}

/* --- словарь и статьи о происхождении: свой файл у каждого текста (m.slovar), грузится при первом открытии текста --- */
let LEX = {};
const lexLoaded = {};
function loadLex(m) {
  if (!m.slovar || lexLoaded[m.id]) return;
  lexLoaded[m.id] = true;
  EK.content(m.slovar).then(r => r.json()).then(d => Object.assign(LEX, d || {})).catch(() => { lexLoaded[m.id] = false; });
}
const lexOf = l => { for (const m of LIB) if ((!M || m.lang === M.lang) && m.lexicon[l]) return m.lexicon[l]; return null; };
const phraseOf = l => { for (const m of [M, ...LIB].filter(x => x && (!M || x.lang === M.lang))) for (const p of m.phrases) if (p.words.some(w => w.l === l)) return p; return null; };
const EKEY = 'ekmafisi.etym', FKEY = 'ekmafisi.etymflags';
let sheetNow = null;
function openEtym(l) {
  const log = read(EKEY) || [];
  if (LEX[l]) { const id = uuid(), at = now(); log.push({ id, l, t: at.slice(0, 16) }); write(EKEY, log); EK.queueLog({ id, at, kind: 'etym', lang: (M && M.lang) || 'el', lemma: l }); }
  push(curHash(), { k: 'etym', l }); openSheet(history.state.sheet);
}
function openSheet(sh) {
  sheetNow = sh; $('etym').scrollTop = 0;
  sh.k === 'hist' ? renderHist() : sh.k === 'senses' ? renderSenses(sh.l) : renderEtym(sh.l);
  $('etym').classList.remove('hidden'); document.body.style.overflow = 'hidden';
}
function closeSheet() { sheetNow = null; $('etym').classList.add('hidden'); document.body.style.overflow = ''; }
$('eHist').onclick = () => { if (!sheetNow || sheetNow.k !== 'hist') { push(curHash(), { k: 'hist' }); openSheet(history.state.sheet); } };
const elLink = s => { const cur = sheetNow && sheetNow.l; const k = Object.keys(LEX).find(l => base(l) === base(s) && l !== cur); return k ? `<button class="link el" data-etym="${esc(k)}">${esc(s)}</button>` : `<span class="el">${esc(s)}</span>`; };
const sec = (t, body) => body ? `<section class="e-sec"><h2>${t}</h2>${body}</section>` : '';
function headHtml(l, D) {
  const L = lexOf(l) || {}, p = phraseOf(l), forms = formsOf(L, D);
  return `<div class="e-head"><span class="lem">${esc(l)}</span><span>${esc(cap(L.ru || D.dict.senses[0]?.ru || ''))}</span>
      ${forms ? `<span class="el muted">${esc(forms)}</span>` : ''}
      ${p ? `<span class="small muted"><span class="el">${esc(TX(p))}</span></span>` : ''}</div>`;
}
function renderSenses(l) {
  const D = LEX[l];
  $('eTtl').textContent = 'Значения';
  if (!D) { $('eBody').innerHTML = `<div class="e-head"><span class="lem">${esc(l)}</span></div><p class="muted">Статьи пока нет.</p>`; return; }
  $('eBody').innerHTML = headHtml(l, D) + sensesHtml(D.dict) + `<div class="e-foot"><span>Значения написаны ИИ (Claude) по Викисловарю (CC BY-SA); человеком — не проверено.</span></div>`;
}
function renderEtym(l) {
  const D = LEX[l];
  $('eTtl').textContent = 'Происхождение';
  if (!D) { $('eBody').innerHTML = `<div class="e-head"><span class="lem">${esc(l)}</span></div><p class="muted">${M && M.lang !== 'el' ? 'Статей о происхождении для этого языка пока нет.' : 'Статьи пока нет: в пробе — 50 слов «Ёлки» и βάζω.'}</p>`; return; }
  const e = D.etym;
  const END = { unknown: 'Дальше происхождение неизвестно.', reconstruction_only: 'Дальше — только реконструкции; их не приводим.' };
  $('eBody').innerHTML = headHtml(l, D) + `
    ${sec('Состав', e.parts && `<p>${esc(e.parts)}</p>`)}
    ${sec('Происхождение', (e.chain.length ? '<ul class="chain">' + e.chain.map(c => `<li><span class="st">${esc(c.stage)}</span><span>${elLink(c.form)} — ${esc(c.meaning)}</span></li>`).join('') + '</ul>' : '')
      + (END[e.chain_end] ? `<p class="muted small">${END[e.chain_end]}</p>` : '') + (e.shift ? `<p>${esc(e.shift)}</p>` : ''))}
    ${sec('Семья в греческом', e.family.length && '<ul>' + e.family.map(f => `<li>${elLink(f.el)} — ${esc(f.ru)}</li>`).join('') + '</ul>')}
    ${sec('В русском и европейских', e.loans.length && '<ul>' + e.loans.map(x => `<li><b>${esc(x.word)}</b> <span class="muted small">${esc(x.lang)}</span>${x.via ? ` ← <span class="el">${esc(x.via)}</span>` : ''}</li>`).join('') + '</ul>')}
    ${sec('В церковном языке', e.church && `<p>${esc(e.church)}</p>`)}
    ${sec('Зацепка', e.hook && `<p>${esc(e.hook)}</p>`)}
    <div class="e-foot"><span>Достоверность: ${esc(D.confidence)}. Написано ИИ (Claude) по источникам и проверено кодом; человеком — не проверено.</span>
      <span>Источники: ${D.sources.map(esc).join('; ')}. По материалам Викисловаря (CC BY-SA).</span></div>
    <div class="e-sec"><button class="link" id="eFlag" style="justify-self:start">Неверно?</button>
      <div id="eFlagBox" class="hidden" style="display:grid;gap:8px"><textarea id="eFlagText" placeholder="Что не так — коротко"></textarea><button class="btn" id="eFlagSave">Сохранить</button></div></div>`;
  const flags = read(FKEY) || {};
  if (flags[l]) { $('eFlagText').value = flags[l].text; $('eFlag').textContent = 'Отмечено: неверно — изменить'; }
  $('eFlag').onclick = () => $('eFlagBox').classList.remove('hidden');
  $('eFlagSave').onclick = () => {
    const f = read(FKEY) || {}, t = $('eFlagText').value.trim();
    if (t) f[l] = { text: t, t: new Date().toISOString().slice(0, 16) }; else delete f[l];
    write(FKEY, f); setSynced('flags', f); $('eFlagBox').classList.add('hidden'); $('eFlag').textContent = t ? 'Отмечено: неверно — изменить' : 'Неверно?';
  };
}
function renderHist() {
  $('eTtl').textContent = 'История';
  const log = read(EKEY) || [], seen = {};
  log.forEach(x => { seen[x.l] = seen[x.l] || { n: 0, t: '' }; seen[x.l].n++; seen[x.l].t = x.t; });
  const items = Object.keys(seen).sort((a, b) => seen[b].t.localeCompare(seen[a].t));
  $('eBody').innerHTML = `<div class="hist" style="display:grid;gap:8px"><input id="hQ" type="search" placeholder="Поиск" autocomplete="off"><div id="hList"></div></div>`;
  const draw = q => {
    const qq = base(q || '');
    const rows = items.filter(l => !qq || base(l).includes(qq) || base((lexOf(l) || {}).ru || '').includes(qq));
    $('hList').innerHTML = rows.length ? rows.map(l => `<button data-etym="${esc(l)}"><span><span class="el">${esc(l)}</span> <span class="muted small">${esc((lexOf(l) || {}).ru || '')}</span></span><span class="small muted">${esc(LEX[l]?.etym.gist || '')} · ${seen[l].n} ${plural(seen[l].n, 'раз', 'раза', 'раз')}</span></button>`).join('')
      : `<p class="muted small">${items.length ? 'Ничего не найдено.' : 'Пока пусто: откройте статью долгим нажатием на слово.'}</p>`;
  };
  $('hQ').oninput = e => draw(e.target.value); draw('');
}
/* нажатия внутри карточки и окон — одним слушателем: «Значения» и data-etym открывают своё окно */
document.addEventListener('click', e => {
  const s = e.target.closest('[data-senses]');
  if (s) { push(curHash(), { k: 'senses', l: s.dataset.senses }); openSheet(history.state.sheet); return; }
  const a = e.target.closest('[data-etym]');
  if (a) { e.stopPropagation(); openEtym(a.dataset.etym); }
});
/* долгое нажатие на слово (≈ 450 мс) — сразу статья; обычное — карточка, как прежде */
let lp = null;
document.addEventListener('pointerdown', e => {
  const w = e.target.closest('.w'); if (!w || e.button > 0) return;
  w.classList.add('hold');
  lp = { w, x: e.clientX, y: e.clientY, fired: false, t: setTimeout(() => { lp.fired = true; w.classList.remove('hold'); openEtym(w.dataset.l); }, 450) };
});
const lpCancel = () => {  /* после сработавшего долгого нажатия глотаем только ближайший click: на телефоне его может и не быть */
  if (!lp) return; clearTimeout(lp.t); lp.w.classList.remove('hold');
  if (!lp.fired) lp = null; else { const cur = lp; setTimeout(() => { if (lp === cur) lp = null; }, 400); }
};
document.addEventListener('pointermove', e => { if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpCancel(); });
document.addEventListener('pointerup', lpCancel);
document.addEventListener('pointercancel', lpCancel);
document.addEventListener('click', e => { if (lp && lp.fired) { e.stopPropagation(); e.preventDefault(); lp = null; } }, true);
document.addEventListener('contextmenu', e => { if (e.target.closest('.w')) e.preventDefault(); });

/* --- Скороговорка --- */
const STEPS = [
  { lbl: '0,8×', rate: 0.8, hint: 'Говорите вместе с автором' },
  { lbl: 'оригинал', rate: 1, hint: 'Вместе, в темпе оригинала' },
  { lbl: 'по памяти', rate: 1, hint: 'Текст скрыт. Скажите по памяти, потом сверьтесь со звуком' },
  { lbl: 'быстро', rate: 1.15, hint: 'Скороговоркой, быстрее оригинала — три раза подряд без запинки' }
];
/* выбрано 1,5× — ступень «вместе» идёт в 1,5×, сверка по памяти и «быстро» — не медленнее её */
const stepRate = k => k === 0 ? 0.8 : k === 3 ? Math.max(STEPS[3].rate, G.rate) : Math.max(1, G.rate);
const stepLbl = k => k === 1 && G.rate > 1 ? RATE_LBL(G.rate) : STEPS[k].lbl;
let sk = { i: 0, step: 0, reps: 0, first: 0 };
function skorOpen(i) {
  show('skor');
  sk = { i: i % P.length, first: G.rate < 1 ? 0 : 1 };  /* скорость — последняя выбранная на фразе (0,6× прежней версии → 0,8×) */
  sk.step = sk.first; sk.reps = 0;
  skorRender();
}
function skorRender() {
  const p = P[sk.i], st = STEPS[sk.step];
  $('sCnt').textContent = `${sk.i + 1} / ${P.length}`;
  $('ladder').innerHTML = STEPS.map((s, k) => `<div class="${k < sk.first ? 'skip' : k < sk.step ? 'done' : k === sk.step ? 'now' : ''}">${stepLbl(k)}</div>`).join('');
  $('sText').innerHTML = wordsHtml(p);
  const hide = sk.step >= 2;
  $('sText').classList.toggle('hidden', hide);
  $('sVeil').classList.toggle('hidden', !hide);
  $('sPeek').classList.toggle('hidden', !hide);
  $('sRu').textContent = p.ru;
  $('sGloss').classList.add('hidden');
  $('sHint').textContent = (sk.step === 1 && G.rate > 1 ? 'Вместе, в полтора раза быстрее оригинала' : st.hint).replace('с автором', M.source.with_ru || 'с автором');
  const fast = sk.step === 3;
  $('sSpeed').classList.toggle('hidden', sk.step > 1);
  paintSpeed();
  $('sCtl').classList.toggle('hidden', fast);
  $('sFast').classList.toggle('hidden', !fast);
  $('sReps').classList.toggle('hidden', !fast);
  $('sRate').classList.add('hidden');
  [...$('sReps').children].forEach((e, k) => e.classList.toggle('on', k < sk.reps));
  document.querySelectorAll('#sText .w').forEach(e => e.onclick = () => {
    const g = $('sGloss'); g.innerHTML = glossHtml(p.words[+e.dataset.k]); g.classList.remove('hidden'); pickWord($('sText'), e);
  });
  /* звук — только по «▶»: автозапуска нет (Ваше слово, 5 ноября 2026) */
}
['sPlay', 'sPlay2'].forEach(id => $(id).onclick = () => toggle($(id), () => playBy($(id), sk.i, stepRate(sk.step))));
/* скорость одна на всё прослушивание и запоминается: 0,8× — ступень «вместе медленно», оригинал и 1,5× — сразу в темпе */
/* скорость — три значка под кнопкой звука:  <  1,0  >  (0,8× · оригинал · 1,5×); вжатая — светло-синим контуром */
const CHEV = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
document.querySelectorAll('.speed').forEach(el => el.innerHTML =
  `<button data-r="0.8" aria-label="Медленнее, 0,8×">${CHEV('M15 5l-7 7 7 7')}</button><button data-r="1" aria-label="Оригинал">1,0</button><button data-r="1.5" aria-label="Быстрее, 1,5×">${CHEV('M9 5l7 7-7 7')}</button>`);
function paintSpeed() { document.querySelectorAll('.speed button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.r === G.rate))); }
document.querySelectorAll('.speed button').forEach(b => b.onclick = () => {
  G.rate = +b.dataset.r; saveG(); paintSpeed();
  if (b.parentNode.id === 'sSpeed') { sk.first = sk.step = G.rate < 1 ? 0 : 1; sk.reps = 0; skorRender(); if (owner) audio.playbackRate = audio.defaultPlaybackRate = stepRate(sk.step); }
  else if (owner) audio.playbackRate = audio.defaultPlaybackRate = G.rate;  /* звучащее ускоряется на ходу */  /* в списке и «Обратном переводе» звучащее ускоряется на ходу */
});
paintSpeed(); paintOwner();
$('sPeek').onclick = () => { $('sText').classList.remove('hidden'); $('sVeil').classList.add('hidden'); };
$('sNext').onclick = () => { sk.step++; sk.reps = 0; skorRender(); };
$('sSlip').onclick = () => { sk.reps = 0; skorRender(false); };
$('sClean').onclick = () => {
  sk.reps++; skorRender(false);
  if (sk.reps >= 3) { $('sFast').classList.add('hidden'); $('sRate').classList.remove('hidden'); $('sText').classList.remove('hidden'); $('sVeil').classList.add('hidden'); $('sHint').textContent = 'Натренирована.'; }
};
document.querySelectorAll('#sColors button').forEach(b => b.onclick = () => {
  mark(sk.i, b.dataset.c, 'skor');
  S.skorAt = (sk.i + 1) % P.length; save();
  sk.i = S.skorAt; sk.step = sk.first; sk.reps = 0; skorRender();
});

/* --- Обратный перевод --- */
let bc = 0, bColors = {};
function btOpen(c) {
  show('bt'); bc = c % CHUNKS.length; bColors = {};
  $('bCnt').textContent = `кусок ${bc + 1} / ${CHUNKS.length}`;
  ['b1', 'b2', 'b3'].forEach((x, k) => $(x).classList.toggle('hidden', k !== 0));
  $('b1Lines').innerHTML = CHUNKS[bc].map(i => `<div class="line" data-i="${i}"><span class="el">${wordsHtml(P[i])}</span><span class="ru-line">${esc(P[i].ru)}</span><div class="gloss hidden"></div></div>`).join('');
  document.querySelectorAll('#b1Lines .line').forEach(l => {
    const i = +l.dataset.i;
    l.querySelector('.el').onclick = ev => {
      const w = ev.target.closest('.w');
      if (w) { const g = l.querySelector('.gloss'); g.innerHTML = glossHtml(P[i].words[+w.dataset.k]); g.classList.remove('hidden'); pickWord($('b1Lines'), w); return; }
      toggle(l, () => { playBy(l, i, G.rate, () => l.classList.remove('playing')); l.classList.add('playing'); });
    };
  });
  window.scrollTo(0, 0);
}
$('b1Play').onclick = () => toggle($('b1Play'), () => playSeq($('b1Play'), CHUNKS[bc], G.rate, i => { const l = document.querySelector(`#b1Lines .line[data-i="${i}"]`); l && l.classList.add('playing'); }));
$('b1Next').onclick = () => { stop(); $('b1').classList.add('hidden'); $('b2').classList.remove('hidden'); renderB2(); window.scrollTo(0, 0); };
function renderB2() {
  document.querySelectorAll('#inMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.i === G.input)));
  const text = G.input === 'text';
  $('b2Lines').innerHTML = CHUNKS[bc].map(i => `<div class="line"><span class="ru">${esc(P[i].ru)}</span>${text ? `<textarea id="in-${i}" lang="${esc(M.lang || 'el')}" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="${esc(P[i].ru)}"></textarea>` : ''}</div>`).join('');
  $('b2Next').textContent = text ? 'Сверить' : 'Сказал(а) — сверить';
  $('b2Hint').textContent = 'Скажите ' + LG(M).say;
}
document.querySelectorAll('#inMode button').forEach(b => b.onclick = () => {
  const keep = {}; document.querySelectorAll('#b2Lines textarea').forEach(t => keep[t.id] = t.value);
  G.input = b.dataset.i; saveG(); renderB2();
  Object.keys(keep).forEach(id => { const t = $(id); if (t) t.value = keep[id]; });
});
$('b2Next').onclick = () => {
  const answers = {};
  CHUNKS[bc].forEach(i => { const t = $('in-' + i); if (t && t.value.trim()) { answers[i] = t.value.trim(); S.written[P[i].id] = answers[i]; touch(M, S, P[i].id); } });
  save();
  $('b2').classList.add('hidden'); $('b3').classList.remove('hidden'); renderB3(answers); window.scrollTo(0, 0);
};

/* сверка написанного: слова сводятся с оригиналом (одинаковые — и похожие, если совпадает хотя бы половина букв),
   в похожих выделяются только ошибочные буквы; ударение — отдельной пометкой, регистр не в счёт */
const tok = s => s.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
/* английский: слово с апострофом — одно (don't, bug's), ’ и ' — одно и то же; для сверки слово раскладывается на части:
   сокращение — на полную форму (I'm = I am, don't = do not, can't = can not = cannot), британское — на американское (colour = color) */
const tokEn = s => s.replace(/[’‘ʼ`]/g, "'").match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) || [];
const EN_WHOLE = { "can't": 'can not', cannot: 'can not', "won't": 'will not', "shan't": 'shall not', "ain't": 'is not', "let's": 'let us', "y'all": 'you all', outta: 'out of', gonna: 'going to', wanna: 'want to', gotta: 'got to' };
const EN_IS = new Set(['he', 'she', 'it', 'that', 'there', 'here', 'what', 'who', 'where', 'how', 'when', 'this']);  /* 's после них — is; у прочих — притяжательное */
const EN_TAIL = { "n't": ' not', "'m": ' am', "'re": ' are', "'ve": ' have', "'ll": ' will', "'d": ' would' };
const EN_BR = { colour: 'color', colours: 'colors', favourite: 'favorite', favourites: 'favorites', neighbour: 'neighbor', neighbours: 'neighbors', honour: 'honor', centre: 'center', theatre: 'theater', metre: 'meter', litre: 'liter', grey: 'gray', mum: 'mom', mummy: 'mommy', travelling: 'traveling', travelled: 'traveled', realise: 'realize', organise: 'organize', practise: 'practice', programme: 'program', jewellery: 'jewelry', pyjamas: 'pajamas', cheque: 'check', tyre: 'tire', aeroplane: 'airplane' };
function partsEn(w) {
  let x = w.toLowerCase();
  if (EN_WHOLE[x]) return EN_WHOLE[x].split(' ');
  for (const k in EN_TAIL) if (x.endsWith(k) && x.length > k.length) return (x.slice(0, -k.length) + EN_TAIL[k]).split(' ').map(y => EN_BR[y] || y);
  if (x.endsWith("'s") && EN_IS.has(x.slice(0, -2))) return [x.slice(0, -2), 'is'];
  return [EN_BR[x] || x];
}
const base = w => w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ');  /* без ударений и регистра — для карточки слова и статьи */
const gl =w => w.normalize('NFD').match(/\P{M}\p{M}*/gu) || [];  /* буква со своими знаками */
const gb = g => g[0].toLowerCase().replace(/ς/g, 'σ');
const gm = g => g.slice(1).split('').sort().join('');
function lev(A, B) {  /* таблица расстояний правки по буквам (без знаков) */
  const D = Array.from({ length: A.length + 1 }, (_, i) => [i, ...new Array(B.length).fill(0)]);
  for (let j = 1; j <= B.length; j++) D[0][j] = j;
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++)
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  return D;
}
function charDiff(u, o) {  /* слово человека и верное → разметка букв в обоих */
  const a = gl(u), b = gl(o), A = a.map(gb), B = b.map(gb), D = lev(A, B);
  const ca = new Array(a.length).fill(''), cb = new Array(b.length).fill('');
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)) {
      if (A[i - 1] !== B[j - 1]) ca[i - 1] = cb[j - 1] = 'cx';
      else if (gm(a[i - 1]) !== gm(b[j - 1])) ca[i - 1] = cb[j - 1] = 'ca';
      i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) ca[--i] = 'cx';
    else cb[--j] = 'cx';
  }
  const html = (g, c) => g.map((x, k) => c[k] ? `<span class="${c[k]}">${esc(x.normalize('NFC'))}</span>` : esc(x.normalize('NFC'))).join('');
  return [html(a, ca), html(b, cb)];
}
function sim(u, o) {  /* 2 — то же слово (без ударений), иначе доля совпавших букв, если не меньше половины */
  const A = gl(u).map(gb), B = gl(o).map(gb);
  if (A.join('') === B.join('')) return 2;
  const v = 1 - lev(A, B)[A.length][B.length] / Math.max(A.length, B.length);
  return v >= .5 ? v : -1;
}
function diff(user, orig, lang) {
  /* слова раскладываются на части (у греческого часть — само слово); части сводятся с оригиналом; слово, все части которого
     совпали, — верное; слово из одной части против слова из одной части — с разметкой букв; иначе — целиком лишнее/пропущенное */
  const split = s => lang === 'en' ? tokEn(s).map(w => ({ w, parts: partsEn(w) })) : tok(s).map(w => ({ w, parts: [w] }));
  const A = split(user), B = split(orig);
  const pa = A.flatMap((x, k) => x.parts.map(p => ({ p, k }))), pb = B.flatMap((x, k) => x.parts.map(p => ({ p, k })));
  const n = pa.length, m = pb.length;
  const S = Array.from({ length: n }, (_, i) => pb.map(y => sim(pa[i].p, y.p)));
  const T = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    T[i][j] = Math.max(T[i + 1][j], T[i][j + 1], S[i][j] > 0 ? T[i + 1][j + 1] + S[i][j] : -1);
  const ma = new Array(n).fill(null), mb = new Array(m).fill(null);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (S[i][j] > 0 && T[i][j] === T[i + 1][j + 1] + S[i][j]) { ma[i] = j; mb[j] = i; i++; j++; }
    else if (T[i][j] === T[i + 1][j]) i++;
    else j++;
  }
  const U = A.map(x => `<span class="bad">${esc(x.w)}</span>`), O = B.map(x => `<span class="miss">${esc(x.w)}</span>`);
  const own = (P, k) => P.map((x, q) => x.k === k ? q : -1).filter(q => q >= 0);
  B.forEach((x, k) => {
    const qs = own(pb, k), q0 = mb[qs[0]], ka0 = q0 !== null ? pa[q0].k : -1;
    if (qs.length === 1 && q0 !== null && A[ka0].parts.length === 1) {  /* слово против слова — по буквам (ударение — пометкой) */
      if (lang === 'en' && pa[q0].p === pb[qs[0]].p) { U[ka0] = esc(A[ka0].w); O[k] = esc(x.w); }  /* colour = color, I = i */
      else [U[ka0], O[k]] = charDiff(A[ka0].w, x.w);
    } else if (qs.every(q => mb[q] !== null && pa[mb[q]].p === pb[q].p)) {  /* все части совпали — верно, как бы ни было записано (I'm = I am) */
      O[k] = esc(x.w);
      qs.forEach(q => { const ka = pa[mb[q]].k; if (own(pa, ka).every(r => ma[r] !== null && pa[r].p === pb[ma[r]].p)) U[ka] = esc(A[ka].w); });
    } else {  /* сокращение без апострофа (doesnt) — по буквам: выделяется только недостающий апостроф */
      const bare = w => w.toLowerCase().replace(/'/g, '');
      const ka = qs.map(q => mb[q]).filter(r => r !== null).map(r => pa[r].k).find(t => bare(A[t].w) === bare(x.w));
      if (ka !== undefined) [U[ka], O[k]] = charDiff(A[ka].w, x.w);
    }
  });
  return { u: U.join(' '), o: O.join(' ') };
}
function renderB3(answers) {
  $('b3Lines').innerHTML = CHUNKS[bc].map(i => {
    const p = P[i], a = answers[i];
    const d = a ? diff(a, TX(p), M.lang) : null;
    return `<div class="cmp" data-i="${i}">
      <span class="ru">${esc(p.ru)}</span>
      ${a ? `<span class="el you">${d.u}</span>` : ''}
      <span class="el">${d ? d.o : esc(TX(p))}</span>
      <div class="colors sm"><button class="g" data-c="g" aria-pressed="false">Знаю</button><button class="y" data-c="y" aria-pressed="false">Повторить</button><button class="r" data-c="r" aria-pressed="false">Трудно</button></div>
    </div>`;
  }).join('');
  document.querySelectorAll('#b3Lines .cmp').forEach(row => {
    const i = +row.dataset.i;
    row.querySelectorAll('.colors button').forEach(b => b.onclick = () => {
      bColors[i] = b.dataset.c;
      row.querySelectorAll('.colors button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      updB3();
    });
  });
  updB3();
}
function updB3() {
  const left = CHUNKS[bc].filter(i => !bColors[i]).length;
  $('b3Next').disabled = left > 0;
  $('b3Next').textContent = left ? `Поставьте цвет: осталось ${left}` : (bc + 1 < CHUNKS.length ? 'Следующий кусок' : 'Готово — к тексту');
}
$('b3Next').onclick = () => {
  CHUNKS[bc].forEach(i => mark(i, bColors[i], 'bt' + (G.input === 'text' ? '-письмо' : '-голос')));
  const last = bc + 1 >= CHUNKS.length;
  S.btAt = (bc + 1) % CHUNKS.length; save();
  last ? goBack(M.id) : btOpen(S.btAt);
};

/* --- тема: авто (как в системе) · светлая · тёмная --- */
const THEMES = { auto: 'авто', light: 'светлая', dark: 'тёмная' };
function paintTheme() {
  if (G.theme === 'auto' || !THEMES[G.theme]) document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = G.theme;
  const t = THEMES[G.theme] ? G.theme : 'auto';
  const svg = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  $('theme').innerHTML = svg({
    auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
  }[t]);
  $('theme').setAttribute('aria-label', 'Тема: ' + THEMES[t]);
  if (shown('settings')) renderSettings();
}
$('theme').onclick = () => { const k = Object.keys(THEMES); G.theme = k[(k.indexOf(G.theme) + 1) % k.length]; saveG(); paintTheme(); };
paintTheme();

/* --- подтянутое с сервера: по фразе — позднее изменение; журнал — по id; настройки — по ключу --- */
EK.onRemote = ({ progress, log, settings }) => {
  const byId = Object.fromEntries(LIB.map(m => [m.id, m]));
  const touched = {};
  const progFor = id => touched[id] || (touched[id] = byId[id] === M ? S : progOf(byId[id]));
  progress.forEach(r => {
    const m = byId[r.text_id]; if (!m || (r.cut || 1) !== (m.cut || 1)) return;
    const s = progFor(r.text_id);
    if (s.ts[r.phrase_id] && s.ts[r.phrase_id] >= r.updated_at) return;
    s.ts[r.phrase_id] = r.updated_at;
    if (r.color) s.colors[r.phrase_id] = r.color; else delete s.colors[r.phrase_id];
    if (r.written) s.written[r.phrase_id] = r.written; else delete s.written[r.phrase_id];
  });
  const elog = read(EKEY) || [], eseen = new Set(elog.map(x => x.id).filter(Boolean));
  let eadd = false;
  log.forEach(r => {
    if (r.kind === 'etym') { if (!eseen.has(r.id)) { elog.push({ id: r.id, l: r.lemma, t: r.at.slice(0, 16) }); eadd = true; } return; }
    const m = byId[r.text_id]; if (!m) return;
    const s = progFor(r.text_id);
    if (r.kind === 'reset') {  /* сброс на другом устройстве: всё, что раньше него, — вон */
      if (!s.resetAt || s.resetAt < r.at) {
        s.resetAt = r.at; s.log = s.log.filter(x => (x.t || '') >= r.at.slice(0, 16));
        Object.keys(s.ts).forEach(pid => { if (s.ts[pid] < r.at) { delete s.colors[pid]; delete s.written[pid]; } });
      }
      return;
    }
    if (r.kind !== 'mark' || (s.resetAt && r.at < s.resetAt) || s.log.some(x => x.id === r.id)) return;
    s.log.push({ id: r.id, p: r.phrase_id, c: r.color, m: r.mode, t: r.at.slice(0, 16) });
  });
  if (eadd) { elog.sort((a, b) => a.t.localeCompare(b.t)); write(EKEY, elog); }
  const T = read(TKEY) || {};
  Object.keys(settings).forEach(k => {
    const r = settings[k]; if (!r || (T[k] && T[k].t >= r.t)) return;
    T[k] = r;
    if (G_SYNC.includes(k)) G[k] = r.v;
    else if (k === 'flags') write(FKEY, r.v || {});
    else if (k.startsWith('pos.') && byId[k.slice(4)]) Object.assign(progFor(k.slice(4)), r.v || {});
  });
  write(TKEY, T); write(SKEY, G);
  Object.keys(touched).forEach(id => { touched[id].log.sort((a, b) => a.t.localeCompare(b.t)); writeProg(byId[id], touched[id]); });
  /* перерисовать то, что видно и не мешает занятию: полку и экран текста */
  paintTheme(); paintSpeed();
  if (shown('shelf')) renderShelf();
  else if (shown('home')) renderHome();
};

/* --- кто вошёл и состояние отправки --- */
const SYNC_LBL = { synced: () => 'сохранено на сервере', pending: () => 'ждёт отправки', offline: () => 'без сети — хранится здесь', error: () => 'не отправилось — повторю' };
EK.onStatus = st => { $('acctSync').textContent = SYNC_LBL[st] ? '· ' + SYNC_LBL[st]() : ''; };
$('acctWho').textContent = EK.email || '';
$('signOut').onclick = () => EK.signOut();
EK.onStatus(EK.status || (navigator.onLine ? '' : 'offline'));

/* --- вход: ссылка прямо на текст или режим (#id, #id-skor) — достраиваем шаги назад: полка ← текст ← режим --- */
if (!history.state || history.state.d === undefined) {
  const t = parseHash(curHash());
  history.replaceState({ d: 0, sheet: null }, '', urlOf(''));
  if (t.v !== 'shelf') push(t.id);
  if (MODES.includes(t.v)) push(t.id + '-' + t.v);
}
applyLoc(true);
EK.sync();  /* подтянуть с сервера то, что изменилось на других устройствах */

/* --- новая версия оболочки встала: на полке — перезапуск сразу, в занятии — полоска; вернулся на полку — перезапуск --- */
window.EK_APP = true;
const updNow = () => { if (shown('shelf') && !sheetNow) location.reload(); else $('upd').classList.remove('hidden'); };
window.addEventListener('ekmafisi-update', updNow);
if (window.EK_UPDATE) updNow();
