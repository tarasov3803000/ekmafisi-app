/* Экмафиси — логика приложения (из пробной страницы). Грузится из sync.js, когда вход проверен и список текстов есть:
   EK.lib — тексты, EK.uid — кто вошёл, EK.content(путь) — файл из закрытого хранилища (с кэшем), EK.queue* — отправка. */
const LIB = EK.lib;
const LEVELS = { A1: 1, A2: 2, B1: 3, B2: 4 };
const MODE_NAME = { skor: 'Повторение', bt: 'Обратный перевод', soberi: 'Собери' };  /* ключ skor — прежнее имя «Скороговорки»: так в настройках и адресах */
/* язык материала: текст фразы — поле t (прежние греческие материалы — el), порядок форм глагола и надписи — по языку */
const LANGS = {
  el: { name: 'греческий', chip: 'ΕΛ', say: 'по-гречески', to: 'на греческий', forms: ['present', 'imperfect', 'aorist', 'future'] },
  en: { name: 'английский', chip: 'EN', say: 'по-английски', to: 'на английский', forms: ['base', 'past', 'participle'] }
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
/* скорость — лесенка 0,8 · 1 · 1,5 · 2, везде одна */
const RATES = [0.8, 1, 1.5, 2];
let G = Object.assign({ rate: 1, last: null, mode: 'skor', theme: 'auto', btN: 3 }, read(SKEY) || {});
if (!RATES.includes(G.rate)) G.rate = G.rate < 1 ? 0.8 : 1;
/* настройки на сервере — по ключу { v, t }: rate, mode, theme, last, btN (фраз за раз в «Обратном переводе»); pos.<текст> — где остановился; flags — «Неверно?» */
/* язык обучения — lang; «Продолжить» — свой у каждого языка: last.el, last.en */
const G_SYNC = ['rate', 'mode', 'theme', 'lang', 'btN', ...Object.keys(LANGS).map(l => 'last.' + l)];
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
  return Object.assign({ colors: {}, written: {}, ts: {}, log: [], skorAt: 0, btAt: 0, btI: null, resetAt: '' }, v && (v.cut || 1) === (m.cut || 1) ? v : {});
};
const writeProg = (m, s) => write('ekmafisi.' + m.id, { cut: m.cut || 1, colors: s.colors, written: s.written, ts: s.ts, log: s.log, skorAt: s.skorAt, btAt: s.btAt, btI: s.btI, resetAt: s.resetAt });

let M = null, P = [], CHUNKS = [], S = null;
const save = () => { writeProg(M, S); setSynced('pos.' + M.id, { skorAt: S.skorAt, btAt: S.btAt, btI: S.btI }); };
/* фраза изменилась (цвет или написанное) — строка «человек × текст × фраза» с временем изменения */
function touch(m, s, pid) {
  s.ts[pid] = now();
  EK.queueProgress({ lang: m.lang || 'el', text_id: m.id, phrase_id: pid, cut: m.cut || 1, color: s.colors[pid] || null, written: s.written[pid] || null, updated_at: s.ts[pid] });
}
function logAdd(m, s, e) {  /* журнал: только добавление; id — чтобы два устройства не задвоили запись */
  const id = uuid(), at = now();
  s.log.push(Object.assign({ id, t: at.slice(0, 16) }, e));
  EK.queueLog({ id, at, kind: 'mark', lang: m.lang || 'el', text_id: m.id, phrase_id: e.p, mode: e.m, color: e.c || null });
}
/* «Повторение» → ✓ «пройдено»: отметка без оценки (первая проверка письмом — на следующий день) */
function passed(i) { logAdd(M, S, { p: P[i].id, c: null, m: 'povt' }); save(); }
/* «выучено» — значок на фразе: оценка «легко» (Easy), фраза один раз вернётся проверкой примерно через две недели.
   Снять — та же кнопка: в журнал «unlearn», цвет — каким был до значка */
const isLearned = (s, pid) => { let v = false; s.log.forEach(x => { if (x.p === pid && (x.m === 'learned' || x.m === 'unlearn')) v = x.m === 'learned'; }); return v; };
/* «выучено» и не проваленное с тех пор — режимы её пропускают */
const skipped = (s, pid) => isLearned(s, pid) && s.colors[pid] === 'g';
/* цвет фразы перед последней отметкой m (learned, self) — по журналу, как его ставил mark: снятие возвращает свой цвет, даже пустой */
function colorBefore(pid, m) {
  let cut = -1, col = null;
  S.log.forEach((x, k) => { if (x.p === pid && x.m === m) cut = k; });
  S.log.slice(0, cut).forEach(x => { if (x.p !== pid) return; if (['learned', 'unlearn', 'self', 'unself'].includes(x.m)) col = x.c || null; else if (x.c) col = x.c; });
  return col;
}
function toggleLearned(i) {
  const pid = P[i].id;
  if (!isLearned(S, pid)) { mark(i, 'g', 'learned'); return true; }
  mark(i, colorBefore(pid, 'learned'), 'unlearn'); return false;
}
const ICO_LRN = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9.5 12 5l10 4.5L12 14z"/><path d="M6 11.5V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.5"/><path d="M22 9.5V15"/></svg>';
const lrnBtn = (cls, i) => `<button class="${cls}" data-lrn="${i}" aria-pressed="${isLearned(S, P[i].id)}" aria-label="Выучено — уже знаю">${ICO_LRN}</button>`;
/* «трудно» и «не знаю» — отметки самому себе (Ваше слово, 7 ноября 2026): подсмотрел и перевёл — а сам знает, что не знает.
   Цвет y/r в журнал с режимом self, для FSRS — Hard/Again (не знаю — вернётся завтра). Нажата отметка, поставленная сегодня,
   если после неё не было другой оценки; повторное нажатие снимает (unself) — цвет каким был до неё */
const selfOf = (s, pid) => {
  let v = null, t = '';
  s.log.forEach(x => { if (x.p !== pid) return; if (x.m === 'self') { v = x.c; t = x.t; } else if (x.c || ['unself', 'learned', 'unlearn'].includes(x.m)) v = null; });
  return v && dayOf(tOf({ t })).getTime() === dayOf(Date.now()).getTime() ? v : null;
};
function toggleSelf(i, c) {
  const pid = P[i].id;
  if (selfOf(S, pid) === c) { mark(i, colorBefore(pid, 'self'), 'unself'); return; }
  if (isLearned(S, pid)) toggleLearned(i);  /* «выучено» и «не знаю» вместе не бывают */
  mark(i, c, 'self');
}
function paintMarks() {
  document.querySelectorAll('[data-lrn]').forEach(b => b.setAttribute('aria-pressed', String(isLearned(S, P[+b.dataset.lrn].id))));
  document.querySelectorAll('[data-self]').forEach(b => b.setAttribute('aria-pressed', String(selfOf(S, P[+b.dataset.self].id) === b.dataset.c)));
}
const paintLrn = paintMarks;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-lrn]'), y = e.target.closest('[data-self]'); if ((!b && !y) || !M) return;
  e.stopPropagation();
  if (b) toggleLearned(+b.dataset.lrn);
  else {
    const i = +y.dataset.self; toggleSelf(i, y.dataset.c);
    if (shown('bt')) {  /* отметку сняли после сверки — в силе снова оценка сверки */
      bt.self[i] = true;
      if (bt.held[i] && !selfOf(S, P[i].id)) { delete bt.held[i]; mark(i, bt.res[i].g, 'bt'); }
    }
  }
  paintMarks();
  if (shown('home')) renderHome();
});
function mark(i, c, mode) {  /* c — g/y/r; null — без цвета («выучено» снято, а цвета до него не было) */
  if (c) S.colors[P[i].id] = c; else delete S.colors[P[i].id];
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
    if (b.dataset.on !== String(on)) { b.dataset.on = String(on); b.innerHTML = playInner(on); }
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
  ['shelf', 'settings', 'home', 'skor', 'bt', 'check', 'words', 'slovar', 'soberi', 'sbgo'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  window.scrollTo(0, 0);
  if (id === 'shelf') { if (window.EK_UPDATE) return location.reload(); renderShelf(); }
  if (id === 'home') renderHome();
  if (id === 'settings') renderSettings();
  if (id === 'words') renderWords();
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
  if (['settings', 'check', 'words', 'soberi', 'sbgo'].includes(h)) return { v: h };
  if (h === 'slovar' || h.startsWith('slovar/')) return { v: 'slovar', l: h.length > 7 ? decodeURIComponent(h.slice(7)) : null };
  for (const v of MODES) if (h.endsWith('-' + v)) { const id = h.slice(0, -v.length - 1); if (LIB.some(m => m.id === id)) return { v, id }; }
  return LIB.some(m => m.id === h) ? { v: 'home', id: h } : { v: 'shelf' };
}
function applyLoc(force) {  /* force — первый вход: экран рисуется, даже если уже виден */
  const t = parseHash(curHash()), sh = history.state && history.state.sheet;
  if (t.v === 'shelf' || t.v === 'settings' || t.v === 'words') { if (force || !shown(t.v)) show(t.v); }
  else if (t.v === 'check') { if (force || !shown('check')) checkOpen(); }
  else if (t.v === 'slovar') { if (force || !shown('slovar')) show('slovar'); slv().show(t.l); }
  else if (t.v === 'soberi') { if (force || !shown('soberi')) soberiOpen(); }
  else if (t.v === 'sbgo') { if (force || !shown('sbgo')) sbGo(SB.step); }
  else {
    const fresh = !M || M.id !== t.id;
    if (fresh) setText(t.id);
    if (force || fresh || !shown(t.v)) t.v === 'home' ? show('home') : t.v === 'bt' ? btOpenAt(btPos()) : skorOpen(S.skorAt);
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
  /* «Проверка · N» — фразы, которым подошёл срок, со всех текстов языка; «Слова» — сколько освоено */
  $('shelfTools').classList.toggle('hidden', !G.lang);
  if (G.lang) {
    const n = dueList().length, w = wordStats();
    $('chkOpen').innerHTML = `<span>Проверка · ${n}</span><small>${n ? 'пора проверить' : 'на сегодня всё'}</small>`;
    $('chkOpen').disabled = !n;
    $('wordsOpen').innerHTML = `<span>Слова · ${w.ok}</span><small>освоено</small>`;
  }
  /* «Собери» и «Словарь» — только у греческого: карточка над текстами с текущей ступенью */
  const sbOn = G.lang === 'el';
  $('slvOpen').classList.toggle('hidden', !sbOn);
  $('sbCard').classList.toggle('hidden', !sbOn);
  if (sbOn) $('sbCard').innerHTML = `<span class="t">Собери · ${esc(SB.step)}</span><span class="meta2">${esc(ladderOf(SB.step).t)}</span>`;
  const sbLast = sbOn && G.mode === 'soberi';
  $('resume').classList.toggle('hidden', !last && !sbLast);
  if (sbLast) $('resume').innerHTML = `<span>Продолжить · Собери</span><small>ступень ${esc(SB.step)} — ${esc(ladderOf(SB.step).t)}</small>`;
  else if (last) $('resume').innerHTML = `<span>Продолжить · ${esc(MODE_NAME[G.mode] || MODE_NAME.skor)}</span><small>${esc(last.title)}</small>`;
}
$('resume').onclick = () => { if (G.lang === 'el' && G.mode === 'soberi') { push('soberi'); push('sbgo'); sbGo(SB.step); return; } openText(lastId()); start(G.mode); };
document.querySelectorAll('#langPick [data-lang]').forEach(b => b.onclick = () => { G.lang = b.dataset.lang; saveG(); renderShelf(); });
/* --- настройки: всё, что не учёба — язык, тема, учётная запись, итог --- */
$('setOpen').onclick = () => { push('settings'); show('settings'); };
function renderSettings() {
  document.querySelectorAll('#setLang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === G.lang)));
  document.querySelectorAll('#setTheme button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === (G.theme || 'auto'))));
  document.querySelectorAll('#setBtN button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.n === (G.btN || 3))));
}
document.querySelectorAll('#setBtN button').forEach(b => b.onclick = () => { G.btN = +b.dataset.n; saveG(); renderSettings(); });
document.querySelectorAll('#setLang button').forEach(b => b.onclick = () => { G.lang = b.dataset.lang; saveG(); renderSettings(); });
/* крупный шрифт: +1…+5 px ко всем текстам, как в читалке (+4 и +5 — для планшета); только на этом устройстве (экраны телефона и Мака разные),
   ключ вне учётной записи — читается до входа (index.html) */
const UP = 'ekmafisi-up';
const upNow = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--up')) || 0;
const paintBig = () => document.querySelectorAll('#setBig button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.up === upNow())));
document.querySelectorAll('#setBig button').forEach(b => b.onclick = () => {
  document.documentElement.style.setProperty('--up', b.dataset.up + 'px');
  try { localStorage.setItem(UP, b.dataset.up); localStorage.removeItem('ekmafisi-big'); } catch (e) {}
  paintBig();
});
paintBig();
document.querySelectorAll('#setTheme button').forEach(b => b.onclick = () => { G.theme = b.dataset.t; saveG(); paintTheme(); renderSettings(); });

function setText(id, quiet) {  /* quiet — для «Проверки»: текст нужен, «Продолжить» не трогаем */
  const m = LIB.find(x => x.id === id);
  if (M !== m) { M = m; P = m.phrases; CHUNKS = m.chunks; S = progOf(m); }
  if (!quiet) { G['last.' + (m.lang || 'el')] = m.id; saveG(); }
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
  $('btSub').textContent = `Переведите фразу ${LG(M).to}, не глядя на оригинал.`;
  $('list').innerHTML = P.map((p, i) => `<div class="ph" data-i="${i}"><button class="ph-play"><span class="dot ${S.colors[p.id] || ''}"></span><span class="el">${esc(TX(p))}</span><span class="ru">${esc(p.ru)}</span></button>${lrnBtn('ph-lrn', i)}<button class="ph-go" aria-label="Учить с этой фразы">›</button></div>`).join('');
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
  if (mode === 'bt') btOpenAt(i === undefined ? btPos() : i, i !== undefined);
  else skorOpen(i === undefined ? S.skorAt : i);
}

$('copy').onclick = () => {
  const lines = [`Экмафиси · ${new Date().toISOString().slice(0, 10)} · скорость: ${RATE_LBL(G.rate)}`];
  LIB.forEach(m => {
    const pr = progOf(m); if (!pr.log.length) return;
    lines.push('', `## ${m.id} — ${m.title}`);
    m.phrases.forEach(p => {
      const c = pr.colors[p.id], w = pr.written[p.id];
      if (c || w) lines.push(`${p.id} ${c ? { g: 'зел', y: 'жёл', r: 'кр' }[c] : '—'}${w ? ' | написал: ' + w : ''}`);
    });
    lines.push('Журнал:'); pr.log.forEach(l => lines.push(`${l.t} ${l.p} ${l.m}${l.c ? ' ' + l.c : ''}`));
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
  S = { colors: {}, written: {}, ts: S.ts, log: [], skorAt: 0, btAt: 0, btI: 0, resetAt: at };
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
/* на широком экране (от 720 px) статья открывается здесь же, под фразой — в месте карточки слова; на узком — окном поверх */
const WIDE = matchMedia('(min-width: 720px)');
function inlineBox(src) {
  if (!WIDE.matches || !src || src.closest('.sheet')) return null;
  const l = src.closest('.line'); if (l && l.querySelector('.gloss')) return l.querySelector('.gloss');
  return src.closest('.gloss') || (src.closest('#sText') ? $('sGloss') : null);
}
function showInline(box, src, fn) {
  fn(box); box.classList.remove('hidden');
  const w = src && src.closest('.w'); if (w) pickWord(w.closest('main') || document, w);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function openEtym(l, src) {  /* src — откуда открыто: слово или ссылка; по нему — место статьи на широком экране */
  const log = read(EKEY) || [];
  if (LEX[l]) { const id = uuid(), at = now(); log.push({ id, l, t: at.slice(0, 16) }); write(EKEY, log); EK.queueLog({ id, at, kind: 'etym', lang: (M && M.lang) || 'el', lemma: l }); }
  const box = inlineBox(src);
  if (box) return showInline(box, src, b => renderEtym(l, b));
  push(curHash(), { k: 'etym', l }); openSheet(history.state.sheet);
}
function openSheet(sh) {
  sheetNow = sh; $('etym').scrollTop = 0;
  sh.k === 'hist' ? renderHist() : sh.k === 'senses' ? renderSenses(sh.l) : sh.k === 'word' ? renderWord(sh.l) : renderEtym(sh.l);
  $('etym').classList.remove('hidden'); document.body.style.overflow = 'hidden';
}
function closeSheet() { sheetNow = null; $('etym').classList.add('hidden'); document.body.style.overflow = ''; }
$('eHist').onclick = () => { if (!sheetNow || sheetNow.k !== 'hist') { push(curHash(), { k: 'hist' }); openSheet(history.state.sheet); } };
let etymCur = null;  /* чья статья на виду — на себя ссылкой не ведёт */
const elLink = s => { const cur = etymCur; const k = Object.keys(LEX).find(l => base(l) === base(s) && l !== cur); return k ? `<button class="link el" data-etym="${esc(k)}">${esc(s)}</button>` : `<span class="el">${esc(s)}</span>`; };
const sec = (t, body) => body ? `<section class="e-sec"><h2>${t}</h2>${body}</section>` : '';
function headHtml(l, D) {
  const L = lexOf(l) || {}, p = phraseOf(l), forms = formsOf(L, D);
  return `<div class="e-head"><span class="lem">${esc(l)}</span><span>${esc(cap(L.ru || D.dict.senses[0]?.ru || ''))}</span>
      ${forms ? `<span class="el muted">${esc(forms)}</span>` : ''}
      ${p ? `<span class="small muted"><span class="el">${esc(TX(p))}</span></span>` : ''}</div>`;
}
/* box — место под фразой (широкий экран); без него — окно поверх */
const boxOf = (box, ttl) => { if (box) return [box, `<h2>${ttl}</h2>`]; $('eTtl').textContent = ttl; return [$('eBody'), '']; };
function renderSenses(l, inl) {
  const D = LEX[l], [box, top] = boxOf(inl, 'Значения');
  if (!D) { box.innerHTML = top + `<div class="e-head"><span class="lem">${esc(l)}</span></div><p class="muted">Статьи пока нет.</p>`; return; }
  box.innerHTML = top + headHtml(l, D) + sensesHtml(D.dict) + `<div class="e-foot"><span>Значения написаны ИИ (Claude) по Викисловарю (CC BY-SA); человеком — не проверено.</span></div>`;
}
function renderEtym(l, inl) {
  const D = LEX[l], [box, top] = boxOf(inl, 'Происхождение'), q = id => box.querySelector('#' + id);
  etymCur = l;
  if (!D) { box.innerHTML = top + `<div class="e-head"><span class="lem">${esc(l)}</span></div><p class="muted">${M && M.lang !== 'el' ? 'Статей о происхождении для этого языка пока нет.' : 'Статьи пока нет: в пробе — 50 слов «Ёлки» и βάζω.'}</p>`; return; }
  const e = D.etym;
  const END = { unknown: 'Дальше происхождение неизвестно.', reconstruction_only: 'Дальше — только реконструкции; их не приводим.' };
  box.innerHTML = top + headHtml(l, D) + `
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
  if (flags[l]) { q('eFlagText').value = flags[l].text; q('eFlag').textContent = 'Отмечено: неверно — изменить'; }
  q('eFlag').onclick = () => q('eFlagBox').classList.remove('hidden');
  q('eFlagSave').onclick = () => {
    const f = read(FKEY) || {}, t = q('eFlagText').value.trim();
    if (t) f[l] = { text: t, t: new Date().toISOString().slice(0, 16) }; else delete f[l];
    write(FKEY, f); setSynced('flags', f); q('eFlagBox').classList.add('hidden'); q('eFlag').textContent = t ? 'Отмечено: неверно — изменить' : 'Неверно?';
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
  if (s) { const box = inlineBox(s); if (box) showInline(box, null, b => renderSenses(s.dataset.senses, b)); else { push(curHash(), { k: 'senses', l: s.dataset.senses }); openSheet(history.state.sheet); } return; }
  const a = e.target.closest('[data-etym]');
  if (a) { e.stopPropagation(); openEtym(a.dataset.etym, a); }
});
/* карточка слова и статья под фразой закрываются нажатием мимо них (нажатие, перерисовавшее экран, — не в счёт) */
document.addEventListener('click', e => {
  if (!e.target.isConnected || e.target.closest('.gloss, .w, .sheet')) return;
  document.querySelectorAll('.gloss:not(.hidden)').forEach(g => g.classList.add('hidden'));
  document.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel'));
});
/* долгое нажатие на слово (≈ 450 мс) — сразу статья; обычное — карточка, как прежде */
let lp = null;
document.addEventListener('pointerdown', e => {
  const w = e.target.closest('.w'); if (!w || e.button > 0) return;
  w.classList.add('hold');
  lp = { w, x: e.clientX, y: e.clientY, fired: false, t: setTimeout(() => { lp.fired = true; w.classList.remove('hold'); openEtym(w.dataset.l, w); }, 450) };
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

/* --- скорость: лесенка 0,8 · 1 · 1,5 · 2; «<» и «>» — ступенью ниже и выше; текущая — внутри кнопки звука (и в списке фраз между стрелками) --- */
const CHEV = d => `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const CH_L = 'M15 5l-7 7 7 7', CH_R = 'M9 5l7 7-7 7';
const RATE_IN = r => (r === 1 || r === 2 ? r.toFixed(1) : String(r)).replace('.', ',');
document.querySelectorAll('.ic.slower').forEach(b => b.innerHTML = CHEV(CH_L));
document.querySelectorAll('.ic.faster').forEach(b => b.innerHTML = CHEV(CH_R));
document.querySelectorAll('.speed').forEach(el => el.innerHTML =
  `<button class="slower" aria-label="Медленнее">${CHEV(CH_L).replace(/40/g, '22')}</button><b aria-live="polite"></b><button class="faster" aria-label="Быстрее">${CHEV(CH_R).replace(/40/g, '22')}</button>`);
function paintSpeed() {
  const k = RATES.indexOf(G.rate);
  document.querySelectorAll('.slower').forEach(b => b.disabled = k <= 0);
  document.querySelectorAll('.faster').forEach(b => b.disabled = k >= RATES.length - 1);
  document.querySelectorAll('.speed b, .ic.play .rt').forEach(e => e.textContent = RATE_IN(G.rate));
  document.querySelectorAll('.speed b').forEach(e => e.setAttribute('aria-label', 'Скорость ' + RATE_LBL(G.rate)));
}
function setRate(d) {
  const k = RATES.indexOf(G.rate) + d; if (k < 0 || k >= RATES.length) return;
  G.rate = RATES[k]; saveG(); paintSpeed();
  if (owner) audio.playbackRate = audio.defaultPlaybackRate = G.rate;  /* звучащее ускоряется на ходу */
}
document.querySelectorAll('.slower').forEach(b => b.onclick = () => setRate(-1));
document.querySelectorAll('.faster').forEach(b => b.onclick = () => setRate(1));
/* кнопка звука: значок + скорость под ним; paintOwner меняет только значок */
const playInner = on => (on ? ICO_PAUSE : ICO_PLAY).replace(/40/g, '34') + `<span class="rt">${RATE_IN(G.rate)}</span>`;
const EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>';
const eyeSvg = d => `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
/* глаз — переключатель: открыт — текст виден (нажать — скрыть), перечёркнут — скрыт (нажать — показать) */
function paintEye(b, hidden, what) { b.innerHTML = eyeSvg(hidden ? EYE_OFF : EYE); b.setAttribute('aria-pressed', String(hidden)); b.setAttribute('aria-label', (hidden ? 'Показать ' : 'Скрыть ') + what); }
$('sDone').innerHTML = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>';
$('sLrn').innerHTML = ICO_LRN;

/* --- Повторение: один экран; ряд кнопок ✓ · < · ▶ · > · глаз; оценки нет — первая проверка письмом на следующий день --- */
let sk = { i: 0, hide: false };
/* следующая фраза, которую не пропускаем («выучено»); все выучены — просто следующая */
const nextIdx = (i, step) => { for (let k = 1; k <= P.length; k++) { const j = (i + k * step + P.length * 2) % P.length; if (!skipped(S, P[j].id)) return j; } return (i + step + P.length) % P.length; };
function skorOpen(i) {
  show('skor');
  sk = { i: i % P.length, hide: sk.hide };  /* скрыт текст или нет — как было на прошлой фразе */
  skorRender();
}
function skorRender() {
  const p = P[sk.i];
  $('sCnt').textContent = `${sk.i + 1} / ${P.length}`;
  $('sText').innerHTML = wordsHtml(p);
  $('sText').classList.toggle('vh', sk.hide);
  paintEye($('sEye'), sk.hide, 'текст');
  $('sRu').textContent = p.ru;
  $('sGloss').classList.add('hidden');
  $('sLrn').dataset.lrn = sk.i; paintLrn();
  document.querySelectorAll('#sText .w').forEach(e => e.onclick = () => {
    if (sk.hide) return;
    const g = $('sGloss'); g.innerHTML = glossHtml(p.words[+e.dataset.k]); g.classList.remove('hidden'); pickWord($('sText'), e);
  });
  paintSpeed(); paintOwner();
  /* звук — только по «▶»: автозапуска нет (Ваше слово, 5 ноября 2026) */
}
$('sPlay').onclick = () => toggle($('sPlay'), () => playBy($('sPlay'), sk.i, G.rate));
$('sEye').onclick = () => { sk.hide = !sk.hide; $('sText').classList.toggle('vh', sk.hide); paintEye($('sEye'), sk.hide, 'текст'); if (sk.hide) $('sGloss').classList.add('hidden'); };
$('sDone').onclick = () => {
  stop(); passed(sk.i);
  S.skorAt = nextIdx(sk.i, 1); save();
  sk.i = S.skorAt; skorRender(); window.scrollTo(0, 0);
};

/* --- Обратный перевод: один экран — шаг 1 (читать и слушать), шаг 2 (поле на каждую фразу), шаг 3 — сверка ---
   Русский и греческий не двигаются: на месте греческого — точки (по одной на слово), потом поля, потом сверка.
   Справа у фразы столбец: «выучено» · «трудно» · «не знаю» · глаз. Глаз на шаге 2 — «или-или»: виден оригинал — поля нет,
   скрыт — поле с написанным (Ваше слово, 7 ноября 2026). Под фразами — звук на всех шагах, ниже — кнопки шага.
   Оценку ставит сверка, по первой попытке; «Ещё раз» её не меняет; «трудно»/«не знаю», нажатые в этом куске, сверка не перебивает.
   Фразы с «выучено» полей не получают. */
let bt = { c: 0, step: 1, hid: {}, tries: 0, res: {}, self: {}, held: {} };  /* held — оценка сверки, уступившая своей отметке */
/* куски по настройке «фраз за раз» (1–3): кусок текста (по смыслу) режется ровно, не больше N фраз, через свою границу не переходит */
let btK = [], btKey = '';
function btPieces() {
  const n = G.btN || 3, key = M.id + ':' + n;
  if (btKey !== key) {
    btK = []; btKey = key;
    CHUNKS.forEach(ch => {
      const parts = Math.ceil(ch.length / n), b = Math.floor(ch.length / parts), x = ch.length % parts;
      for (let k = 0, at = 0; k < parts; k++) { const len = b + (k < x ? 1 : 0); btK.push(ch.slice(at, at + len)); at += len; }
    });
  }
  return btK;
}
/* где остановился — номер фразы (btI): не зависит от «фраз за раз»; прежний btAt — номер куска текста, его держим для старых версий */
const btPos = () => S.btI ?? ((CHUNKS[S.btAt] || CHUNKS[0])[0]);
function btOpenAt(i, exact) { const c = btPieces().findIndex(k => k.includes(i)); btOpen(Math.max(0, c), exact); }
const btCur = () => btPieces()[bt.c];
const btIdx = () => btCur().filter(i => !skipped(S, P[i].id));
const dotsOf = p => (TX(p).match(/\S+/g) || []).map(() => '•').join(' ');
const GRADE_LBL = { g: 'знаю', y: 'с трудом', r: 'не знаю' };
const ICO_HARD = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v6"/><path d="M12 16.8v.2"/></svg>';
const ICO_DUNNO = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4"/><path d="M12 17.2v.1"/></svg>';
const marksHtml = i => `<div class="marks">${lrnBtn('mk', i)}<button class="mk y" data-self="${i}" data-c="y" aria-pressed="false" aria-label="Трудно — пусть вернётся пораньше">${ICO_HARD}</button><button class="mk r" data-self="${i}" data-c="r" aria-pressed="false" aria-label="Не знаю — пусть вернётся завтра">${ICO_DUNNO}</button><button class="mk eye" data-eye="${i}"></button></div>`;
function btOpen(c, exact) {  /* exact — открыт «›» у фразы: кусок с ней, даже если вся она «выучено» */
  show('bt');
  const K = btPieces();
  c = c % K.length;
  if (!exact) for (let k = 0; k < K.length && K[c].every(i => skipped(S, P[i].id)); k++) c = (c + 1) % K.length;
  bt = { c, step: 1, hid: {}, tries: 0, res: {}, self: {}, held: {} };
  $('bCnt').textContent = `${(G.btN || 3) === 1 ? 'фраза' : 'кусок'} ${c + 1} / ${K.length}`;
  $('bSub').textContent = `Переведите фразу ${LG(M).to}, не глядя на оригинал`;
  $('bLines').innerHTML = K[c].map(i => `<div class="line has-mk" data-i="${i}"><div class="slot"></div><span class="ru-line">${esc(P[i].ru)}</span>${marksHtml(i)}<div class="gloss hidden"></div></div>`).join('');
  btRender(); window.scrollTo(0, 0);
}
/* верное из сверки — со словами, на которые можно нажать (карточка слова, статья) */
function origTap(d, p) {
  let at = 0;
  return d.os.map((h, k) => {
    const j = p.words.findIndex((w, q) => q >= at && w.t.replace(/[’‘ʼ`]/g, "'") === d.ob[k]);  /* английский: сверка видит ’ как ' */
    if (j < 0) return h;
    at = j + 1;
    return p.words[j].l ? `<span class="w" data-k="${j}" data-l="${esc(p.words[j].l)}">${h}</span>` : h;
  }).join(' ');
}
function btRender(keep) {  /* keep — что оставить в полях при «Ещё раз»; иначе в полях остаётся написанное */
  const live = new Set(btIdx()), cur = {};
  document.querySelectorAll('#bLines textarea').forEach(t => cur[t.dataset.i] = t.value);
  document.querySelectorAll('#bLines .line').forEach(l => {
    const i = +l.dataset.i, p = P[i], slot = l.querySelector('.slot'), hid = !!bt.hid[i];
    l.querySelector('.gloss').classList.add('hidden');
    const eye = l.querySelector('[data-eye]');
    eye.classList.toggle('off', bt.step === 3 || (bt.step === 2 && !live.has(i)));
    paintEye(eye, hid, 'оригинал');
    if (bt.step === 1) slot.innerHTML = hid ? `<span class="dots">${esc(dotsOf(p))}</span>` : `<span class="el">${wordsHtml(p)}</span>`;
    else if (!live.has(i)) slot.innerHTML = `<span class="el known">${wordsHtml(p)}</span>`;
    else if (bt.step === 2) {
      slot.innerHTML = `<span class="el${hid ? ' hidden' : ''}">${wordsHtml(p)}</span><textarea class="${hid ? '' : 'hidden'}" data-i="${i}" id="in-${i}" lang="${esc(M.lang || 'el')}" rows="2" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="${esc(p.ru)}"></textarea>`;
      const v = keep ? keep[i] : cur[i]; if (v) slot.querySelector('textarea').value = v;
    } else {
      const r = bt.res[i];
      slot.innerHTML = `<div class="cmp">${r.a ? `<span class="el you">${r.d.u}</span>` : ''}<span class="el">${r.a ? origTap(r.d, p) : `<span class="miss">${wordsHtml(p)}</span>`}</span><span class="grade ${r.g}">${GRADE_LBL[r.g]}</span></div>`;
    }
    /* оригинал: слово — карточка (долгое нажатие — статья), мимо слов — звук фразы */
    const el = slot.querySelector('.el:not(.you)');
    if (el) el.onclick = ev => {
      const w = ev.target.closest('.w');
      if (w) { const g = l.querySelector('.gloss'); g.innerHTML = glossHtml(p.words[+w.dataset.k]); g.classList.remove('hidden'); pickWord($('bLines'), w); return; }
      toggle(l, () => { playBy(l, i, G.rate, () => l.classList.remove('playing')); l.classList.add('playing'); });
    };
  });
  paintMarks();
  const all = btCur().filter(i => bt.step === 1 || live.has(i));
  paintEye($('bEye'), all.length > 0 && all.every(i => bt.hid[i]), 'оригинал');
  $('bEye').disabled = bt.step === 3 || !all.length;
  $('bNext').classList.toggle('hidden', bt.step !== 1);
  $('bCheck').classList.toggle('hidden', bt.step !== 2);
  $('bS3').classList.toggle('hidden', bt.step !== 3);
  $('bOn').textContent = bt.c + 1 < btPieces().length ? 'Далее' : 'Готово';
  paintSpeed(); paintOwner();
}
const btFocus = i => { const t = i === undefined ? [...document.querySelectorAll('#bLines textarea:not(.hidden)')].find(x => !x.value) : $('in-' + i); if (t && !t.classList.contains('hidden')) t.focus({ preventScroll: true }); };
/* глаз у фразы — её оригинал; глаз в ряду звука — все сразу (есть видимый — скрыть все, иначе показать все) */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-eye]'); if (!b || !shown('bt')) return;
  const i = +b.dataset.eye; bt.hid[i] = !bt.hid[i]; btRender();
  if (bt.step === 2 && bt.hid[i]) btFocus(i);
});
$('bEye').onclick = () => {
  const all = btCur().filter(i => bt.step === 1 || btIdx().includes(i)), on = !all.every(i => bt.hid[i]);
  all.forEach(i => bt.hid[i] = on); btRender();
};
$('bPlay').onclick = () => toggle($('bPlay'), () => playSeq($('bPlay'), btCur(), G.rate, i => { const l = document.querySelector(`#bLines .line[data-i="${i}"]`); l && l.classList.add('playing'); }));
$('bNext').onclick = () => {
  stop(); bt.step = 2; bt.hid = {}; btIdx().forEach(i => bt.hid[i] = true); btRender(); btFocus();
  if (!btIdx().length) $('bCheck').click();  /* весь кусок «выучено» — сверять нечего */
};
$('bCheck').onclick = () => {
  const first = bt.tries === 0;
  stop();
  btIdx().forEach(i => {
    const t = $('in-' + i), a = t ? t.value.trim() : '';
    const d = a ? diff(a, TX(P[i]), M.lang) : null;
    bt.res[i] = { a, d, g: d ? d.g : 'r' };
    if (first) {  /* оценка — по первой попытке: цвет, написанное, журнал; своя отметка в этом куске — главнее */
      if (a) S.written[P[i].id] = a;
      if (bt.self[i] && selfOf(S, P[i].id)) bt.held[i] = true; else mark(i, bt.res[i].g, 'bt');
    }
  });
  bt.tries++; save();
  bt.step = 3; btRender(); window.scrollTo(0, 0);
};
/* «Ещё раз»: поля фраз с ошибками пустеют, верные («знаю») остаются заполненными */
$('bAgain').onclick = () => {
  stop();
  const keep = {}; btIdx().forEach(i => { if (bt.res[i].g === 'g') keep[i] = bt.res[i].a; });
  bt.step = 2; bt.hid = {}; btIdx().forEach(i => bt.hid[i] = true); btRender(keep); window.scrollTo(0, 0); btFocus();
};
/* «Далее» — всегда: идти дальше, не выучив фразу, — выбор человека */
$('bOn').onclick = () => {
  const K = btPieces(), last = bt.c + 1 >= K.length;
  S.btI = K[(bt.c + 1) % K.length][0];
  S.btAt = Math.max(0, CHUNKS.findIndex(ch => ch.includes(S.btI))); save();
  last ? goBack(M.id) : btOpenAt(S.btI);
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
/* служебные слова длиннее трёх букв: ошибка в них — «не знаю», одна буква меняет слово (στον / στην); короче четырёх — служебные все */
const FUNC = new Set(['στον', 'στην', 'στουσ', 'στισ', 'στων', 'αυτοσ', 'αυτη', 'αυτο', 'αυτου', 'αυτησ', 'αυτον', 'αυτην', 'αυτοι', 'αυτεσ', 'αυτα', 'αυτων', 'αυτουσ',
  'εμεισ', 'εσεισ', 'εμενα', 'εσενα', 'ενασ', 'εναν', 'ενοσ', 'μιασ', 'μιαν', 'τουσ', 'προσ', 'χωρισ', 'μεχρι', 'κατα', 'μετα', 'παρα', 'αντι', 'οποιοσ', 'οποια', 'οποιο', 'ποιοσ', 'ποια', 'ποιο',
  'this', 'that', 'these', 'those', 'them', 'they', 'their', 'theirs', 'your', 'yours', 'with', 'from', 'into', 'onto', 'over', 'about', 'what', 'which', 'whom', 'whose']);
/* оценка слова: 0 — верно (ошибки только в ударениях — тоже верно), 1 — одна буква в смысловом слове длиннее трёх букв, 2 — иначе */
function wordGrade(u, o) {
  const A = gl(u).map(gb), B = gl(o).map(gb), d = lev(A, B)[A.length][B.length];
  if (!d) return 0;
  return d === 1 && B.length > 3 && !FUNC.has(B.join('')) ? 1 : 2;
}
/* сверка письма → { u, o — разметка своего и верного; g — оценка фразы: g «знаю», y «с трудом», r «не знаю» }
   «не знаю» — пропущенное слово, своё вместо верного, лишнее, две и больше ошибки в слове, ошибка в служебном слове */
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
  const okU = new Array(A.length).fill(false), gw = new Array(B.length).fill(2), uw = new Array(A.length).fill(2);
  const own = (P, k) => P.map((x, q) => x.k === k ? q : -1).filter(q => q >= 0);
  B.forEach((x, k) => {
    const qs = own(pb, k), q0 = mb[qs[0]], ka0 = q0 !== null ? pa[q0].k : -1;
    if (qs.length === 1 && q0 !== null && A[ka0].parts.length === 1) {  /* слово против слова — по буквам (ударение — пометкой) */
      if (lang === 'en' && pa[q0].p === pb[qs[0]].p) { U[ka0] = esc(A[ka0].w); O[k] = esc(x.w); gw[k] = 0; }  /* colour = color, I = i */
      else { [U[ka0], O[k]] = charDiff(A[ka0].w, x.w); gw[k] = wordGrade(A[ka0].w, x.w); }
      okU[ka0] = true; uw[ka0] = gw[k];
    } else if (qs.every(q => mb[q] !== null && pa[mb[q]].p === pb[q].p)) {  /* все части совпали — верно, как бы ни было записано (I'm = I am) */
      O[k] = esc(x.w); gw[k] = 0;
      qs.forEach(q => { const ka = pa[mb[q]].k; okU[ka] = true; uw[ka] = 0; if (own(pa, ka).every(r => ma[r] !== null && pa[r].p === pb[ma[r]].p)) U[ka] = esc(A[ka].w); });
    } else {  /* сокращение без апострофа (doesnt) — по буквам: выделяется только недостающий апостроф */
      const bare = w => w.toLowerCase().replace(/'/g, '');
      const ka = qs.map(q => mb[q]).filter(r => r !== null).map(r => pa[r].k).find(t => bare(A[t].w) === bare(x.w));
      if (ka !== undefined) { [U[ka], O[k]] = charDiff(A[ka].w, x.w); gw[k] = wordGrade(A[ka].w, x.w); okU[ka] = true; uw[ka] = gw[k]; }
    }
  });
  /* часть слова-сокращения, сведённая с верным словом, — не лишнее */
  pa.forEach((x, q) => { if (ma[q] !== null) okU[x.k] = true; });
  const worst = Math.max(0, ...gw, ...okU.map(v => v ? 0 : 2));
  /* uw — своё слово: 0 верно, 1–2 с ошибкой, 2 и не сведено — лишнее (extra); miss — сколько верных слов не написано */
  return { u: U.join(' '), o: O.join(' '), os: O, ob: B.map(x => x.w), g: ['g', 'y', 'r'][worst], words: A.map((x, k) => ({ w: x.w, e: uw[k], extra: !okU[k] })), miss: gw.filter((v, k) => v === 2 && !O[k].startsWith('<span class="cx') && O[k].includes('class="miss"')).length, err: worst ? (U.join('').match(/class="(cx|bad)"/g) || []).length + (O.join('').match(/class="miss"/g) || []).length : 0 };
}
/* --- FSRS (FSRS-5, веса по умолчанию): состояние фразы пересчитывается из журнала — схема базы не меняется ---
   Оценка: сверка письма (bt, check; прежние bt-письмо, bt-голос) — не знаю → Again, с трудом → Hard, знаю → Good; «выучено» → Easy;
   свои отметки (self) — «трудно» → Hard, «не знаю» → Again.
   ✓ «пройдено» в «Повторении» (и прежняя «Скороговорка») оценки не ставит: новая фраза получает срок — следующий день.
   Освоена — стабильность ≥ 21 дня. */
const FW = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const F_DECAY = -0.5, F_FACTOR = 19 / 81, MASTER = 21, DAY = 864e5;
const RATING = { r: 1, y: 2, g: 3 };
const clampD = d => Math.min(10, Math.max(1, d));
const d0 = g => clampD(FW[4] - Math.exp(FW[5] * (g - 1)) + 1);
const tOf = x => Date.parse(x.t + (x.t.length === 16 ? ':00Z' : ''));
const dayOf = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
const addDays = (ms, n) => { const d = dayOf(ms); d.setDate(d.getDate() + n); return d.getTime(); };
function fsrsStep(c, g, t) {
  if (c.s === null) { c.s = FW[g - 1]; c.d = d0(g); }
  else {
    const days = (t - c.last) / DAY;
    if (dayOf(t).getTime() === dayOf(c.last).getTime()) c.s = c.s * Math.exp(FW[17] * (g - 3 + FW[18]));  /* в тот же день */
    else {
      const R = Math.pow(1 + F_FACTOR * days / c.s, F_DECAY);
      c.s = g === 1
        ? Math.min(c.s, FW[11] * Math.pow(c.d, -FW[12]) * (Math.pow(c.s + 1, FW[13]) - 1) * Math.exp(FW[14] * (1 - R)))
        : c.s * (1 + Math.exp(FW[8]) * (11 - c.d) * Math.pow(c.s, -FW[9]) * (Math.exp(FW[10] * (1 - R)) - 1) * (g === 2 ? FW[15] : 1) * (g === 4 ? FW[16] : 1));
    }
    const dd = c.d + (-FW[6] * (g - 3)) * (10 - c.d) / 9;
    c.d = clampD(FW[7] * d0(4) + (1 - FW[7]) * dd);
  }
  c.last = t; c.reps++;
  c.due = addDays(t, g === 1 ? 1 : Math.max(1, Math.round(c.s)));  /* удержание 0,9: интервал = стабильность */
}
/* карточки текста: { фраза: { s, d, last, due, reps } } — по журналу, «unlearn» снимает последнее «выучено», «unself» — последнее «трудно»/«не знаю» */
function cardsOf(s) {
  const ev = s.log.filter(x => x.p && x.t).slice().sort((a, b) => a.t.localeCompare(b.t));
  const drop = new Set();
  const UNDO = { unlearn: 'learned', unself: 'self' };  /* снятая отметка в расчёт не идёт */
  ev.forEach((x, k) => { const u = UNDO[x.m]; if (u) { for (let j = k - 1; j >= 0; j--) if (ev[j].p === x.p && ev[j].m === u && !drop.has(j)) { drop.add(j); break; } } });
  const C = {};
  ev.forEach((x, k) => {
    if (drop.has(k) || UNDO[x.m]) return;
    const t = tOf(x); if (!t) return;
    const c = C[x.p] || (C[x.p] = { s: null, d: null, last: 0, due: 0, reps: 0 });
    if (x.m === 'learned') fsrsStep(c, 4, t);
    else if (x.m === 'povt' || x.m === 'skor') { if (c.s === null && !c.due) c.due = addDays(t, 1); }
    else if (RATING[x.c]) fsrsStep(c, RATING[x.c], t);
  });
  return C;
}
const stateOf = m => (M === m ? S : progOf(m));
const langTexts = () => LIB.filter(m => m.lang === G.lang);
/* фразы, которым подошёл срок: сначала давние */
function dueList() {
  const today = dayOf(Date.now()).getTime(), out = [];
  langTexts().forEach(m => { const C = cardsOf(stateOf(m)); m.phrases.forEach((p, i) => { const c = C[p.id]; if (c && c.due && c.due <= today) out.push({ id: m.id, i, due: c.due }); }); });
  return out.sort((a, b) => a.due - b.due);
}
/* освоенные фразы и слова: слово освоено, если оно есть в освоенной фразе */
function wordStats() {
  const ok = new Set(), seen = new Set();
  langTexts().forEach(m => {
    const C = cardsOf(stateOf(m));
    m.phrases.forEach(p => { const good = C[p.id] && C[p.id].s >= MASTER; p.words.forEach(w => { if (!w.l) return; seen.add(w.l); if (good) ok.add(w.l); }); });
  });
  return { ok: ok.size, okSet: ok, seen };
}

/* --- «Проверка · N»: русский → поле → «Сверить»; оценка и кнопки — как в «Обратном переводе» --- */
let ck = { q: [], k: 0, tries: 0, res: null };
$('chkOpen').onclick = () => { push('check'); checkOpen(); };
function checkOpen() { show('check'); ck = { q: dueList(), k: 0, tries: 0, res: null }; checkRender(); }
function checkRender() {
  const done = ck.k >= ck.q.length;
  $('cDone').classList.toggle('hidden', !done);
  document.querySelector('#check .card').classList.toggle('hidden', done);
  $('cCnt').textContent = done ? '' : `${ck.k + 1} / ${ck.q.length}`;
  if (done) { $('cSub').textContent = ''; return; }
  const it = ck.q[ck.k]; setText(it.id, true);
  const p = P[it.i];
  $('cSub').textContent = `Переведите фразу ${LG(M).to}`;
  $('cSrc').textContent = M.title;
  $('cRu').textContent = p.ru;
  const res = ck.res;
  if (!res) {
    $('cSlot').innerHTML = `<textarea id="cIn" lang="${esc(M.lang || 'el')}" rows="2" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="${esc(p.ru)}"></textarea>`;
    if (ck.keep) $('cIn').value = ck.keep;
  } else $('cSlot').innerHTML = `<div class="cmp">${res.a ? `<span class="el you">${res.d.u}</span>` : ''}<span class="el">${res.a ? res.d.o : `<span class="miss">${esc(TX(p))}</span>`}</span><span class="grade ${res.g}">${GRADE_LBL[res.g]}</span></div>`;
  $('cCheck').classList.toggle('hidden', !!res);
  $('cPlayRow').classList.toggle('hidden', !res);
  $('cS3').classList.toggle('hidden', !res);
  if (res) $('cOn').classList.toggle('hidden', res.g === 'r');
  paintOwner(); paintSpeed();
}
$('cCheck').onclick = () => {
  const it = ck.q[ck.k], p = P[it.i], a = $('cIn').value.trim();
  const d = a ? diff(a, TX(p), M.lang) : null;
  ck.res = { a, d, g: d ? d.g : 'r' };
  if (!ck.tries) { if (a) S.written[p.id] = a; mark(it.i, ck.res.g, 'check'); }  /* оценка — по первой попытке */
  ck.tries++; ck.keep = null; checkRender();
};
$('cAgain').onclick = () => { stop(); ck.keep = ck.res.g === 'g' ? ck.res.a : ''; ck.res = null; checkRender(); $('cIn').focus({ preventScroll: true }); };
$('cOn').onclick = () => { stop(); ck.k++; ck.tries = 0; ck.res = null; ck.keep = null; checkRender(); window.scrollTo(0, 0); };
$('cPlay').onclick = () => toggle($('cPlay'), () => playBy($('cPlay'), ck.q[ck.k].i, G.rate));

/* --- «Словарь»: весь свой словарь, общий модуль с приложением «Словарь» (app/slovar.js); #slovar — поиск, #slovar/<лемма> — статья --- */
let SLV = null;
const slv = () => SLV || (SLV = Slovar.mount($('slvBox'), {
  onPick: l => { push('slovar/' + encodeURIComponent(l)); SLV.show(l); },
  onBack: () => goBack('slovar')
}));
$('slvOpen').onclick = () => { push('slovar'); show('slovar'); slv().show(null); slv().focus(); slv().ready.then(() => shown('slovar') && slv().focus()); };

/* --- «Слова»: сверху — сколько освоено; ниже первая тысяча частотных лемм языка (material/<lang>/chastoty) --- */
let FREQ = {};
$('wordsOpen').onclick = () => { push('words'); show('words'); };
function renderWords() {
  const w = wordStats(), lang = G.lang || 'el';
  langTexts().forEach(loadLex);  /* значения и происхождение — из словарей всех текстов языка */
  $('wN').textContent = `Освоено ${w.ok} ${plural(w.ok, 'слово', 'слова', 'слов')}`;
  const draw = list => {
    const top = list.slice(0, 1000), okTop = top.filter(x => w.okSet.has(x.lemma)).length;
    $('wTop').textContent = `из первой тысячи — ${Math.round(okTop / 10)} %` + (okTop && okTop < 10 ? ` (${okTop})` : '');
    $('wGrid').innerHTML = top.map(x => `<button class="${w.okSet.has(x.lemma) ? 'ok' : w.seen.has(x.lemma) ? 'seen' : ''}" data-word="${esc(x.lemma)}">${esc(x.lemma)}</button>`).join('');
  };
  if (FREQ[lang]) return draw(FREQ[lang]);
  $('wTop').textContent = ''; $('wGrid').innerHTML = ''; $('wLoad').classList.remove('hidden');
  EK.content(lang + '/chastoty.json', navigator.onLine).then(r => r.json()).then(d => { FREQ[lang] = d.lemmas; $('wLoad').classList.add('hidden'); if (shown('words')) draw(d.lemmas); })
    .catch(() => { $('wLoad').textContent = 'Частотного списка для этого языка пока нет.'; });
}
const POS_RU = { NOUN: 'существительное', VERB: 'глагол', ADJ: 'прилагательное', ADV: 'наречие', PRON: 'местоимение', DET: 'артикль, определитель', ADP: 'предлог', CCONJ: 'союз', SCONJ: 'союз', NUM: 'числительное', PART: 'частица', INTJ: 'междометие', AUX: 'вспомогательный глагол', PROPN: 'имя собственное' };
function renderWord(l) {
  const x = (FREQ[G.lang || 'el'] || []).find(y => y.lemma === l) || { lemma: l };
  const L = lexOf(l) || {}, D = LEX[l], p = phraseOf(l), w = wordStats();
  $('eTtl').textContent = 'Слово';
  const st = w.okSet.has(l) ? 'освоено' : w.seen.has(l) ? 'встречалось в текстах' : 'в текстах пока не встречалось';
  $('eBody').innerHTML = `<div class="e-head"><span class="lem">${esc(x.slovo || l)}</span>
      ${L.ru || D ? `<span>${esc(cap(L.ru || D.dict.senses[0]?.ru || ''))}</span>` : ''}
      <span class="small muted">${x.rank ? `№ ${x.rank} по частоте · ` : ''}${esc(POS_RU[x.pos] || '')}${x.pos ? ' · ' : ''}${st}</span>
      ${x.forms ? `<span class="el muted">${esc(x.forms.join(' · '))}</span>` : ''}
      ${p ? `<span class="small muted"><span class="el">${esc(TX(p))}</span><br>${esc(p.ru)}</span>` : ''}</div>
    ${D && D.dict.senses.length ? `<div class="gl-links"><button class="link" data-senses="${esc(l)}">Значения</button>${D.etym ? `<span class="muted">·</span><button class="link" data-etym="${esc(l)}">Происхождение</button>` : ''}</div>` : ''}`;
}
document.addEventListener('click', e => { const b = e.target.closest('[data-word]'); if (b) { push(curHash(), { k: 'word', l: b.dataset.word }); openSheet(history.state.sheet); } });

/* --- «Собери» (docs/soberi.md): цепочки по 8 шагов, каждый шаг меняет одну вещь; ответ письмом, сверка с вариантами ---
   Источник цепочек: первый пакет (content el/soberi-start.json) и запас человека (soberi_chains, функция soberi).
   Оценка: верно с первой попытки — «знаю»; со второй, после подсказки, — «с трудом»; иначе — «не знаю» (шаг повторяется в конце цепочки).
   Строка progress: text_id «soberi», phrase_id «цепочка:шаг»; отметка в log с режимом soberi. Настройки — ключ soberi. */
const LADDER = [
  { k: 'И1', t: 'имена: именительный и винительный, ед. ч.', ex: 'ο μεγάλος σκύλος → τον μεγάλο σκύλο' },
  { k: 'Г1', t: 'глаголы группы А (-ω), четыре формы', ex: 'γράφω, έγραφα, έγραψα, θα γράψω' },
  { k: 'И2', t: 'имена: им. и вин., мн. ч.', ex: 'οι / τους / τις / τα' },
  { k: 'Г2', t: 'глаголы группы Β (-άω / -ώ)', ex: 'μιλάω, μιλούσα, μίλησα, θα μιλήσω' },
  { k: 'И3', t: 'имена: родительный падеж', ex: 'του / της / των' },
  { k: 'Г3', t: 'глаголы группы Γ (-ομαι, -άμαι)', ex: 'ντύνομαι, ντυνόμουν, ντύθηκα, θα ντυθώ' },
  { k: 'И4', t: 'имена: трудные типы', ex: '-ης / -ας, ж. р. на -ος, πολύς, -ύς' },
  { k: 'Г4', t: 'слабые местоимения и повелительное', ex: 'το έφαγα · δώσ’ το μου' }
];
const ladderOf = k => LADDER.find(x => x.k === k) || LADDER[0];
const SBKEY = 'ekmafisi.soberi', SBCKEY = 'ekmafisi.soberi.chains';
let SB = Object.assign({ step: 'И1', opora: true, played: [], flags: {}, mine: {} }, read(SBKEY) || {});
const saveSB = () => { write(SBKEY, SB); setSynced('soberi', SB); };
setSynced('soberi', SB);
let SBSTART = null;  /* первый пакет */
let SBC = read(SBCKEY) || [];  /* запас с сервера: [{ id, step, chain }] */
async function sbLoad() {
  if (!SBSTART) try { SBSTART = (await (await EK.content('el/soberi-start.json', navigator.onLine)).json()).chains; } catch (e) { SBSTART = []; }
  try { const rows = await EK.chains(); if (rows) { SBC = rows.filter(r => r.lang === 'el').map(r => ({ id: r.id, step: r.step, chain: Object.assign({}, r.chain, { id: r.id, step: r.step }) })); write(SBCKEY, SBC); } } catch (e) { console.warn('chains', e); }
}
const sbStock = step => [...(SBSTART || []).filter(c => c.step === step), ...SBC.filter(r => r.step === step).map(r => r.chain)].filter(c => !SB.played.includes(c.id));
/* пополнить запас ступени в фоне: слова — из зелёных и жёлтых фраз греческих текстов, первый шаг — фраза блогера */
let sbAsked = {};
function sbRefill(step) {
  if (EK.DEV || !navigator.onLine || sbAsked[step] || sbStock(step).length >= 2) return;
  sbAsked[step] = true;
  const words = {}, phrases = [];
  LIB.filter(m => m.lang === 'el').forEach(m => {
    const st = stateOf(m);
    m.phrases.forEach(p => {
      const c = st.colors[p.id]; if (c !== 'g' && c !== 'y') return;
      phrases.push({ id: m.id + ':' + p.id, t: TX(p), ru: p.ru });
      p.words.forEach(w => { if (w.l && !words[w.l]) { const L = m.lexicon[w.l] || {}; words[w.l] = { l: w.l, ru: L.ru || '', pos: L.pos || '' }; } });
    });
  });
  EK.fn({ action: 'refill', lang: 'el', step, words: Object.values(words), phrases: phrases.slice(-60) })
    .then(() => sbLoad()).catch(e => { console.warn('refill', e); setTimeout(() => { sbAsked[step] = false; }, 600000); });
}
$('sbCard').onclick = () => { push('soberi'); soberiOpen(); };
async function soberiOpen() {
  show('soberi'); G.mode = 'soberi'; saveG();
  renderSteps(); await sbLoad(); if (shown('soberi')) renderSteps();
}
function renderSteps() {
  $('sbSteps').innerHTML = LADDER.map(x => `<button data-step="${x.k}" aria-pressed="${x.k === SB.step}"><b>${x.k}</b><span>${esc(x.t)}</span><span class="n">${SBSTART ? sbStock(x.k).length : ''}</span><span class="ex">${esc(x.ex)}</span></button>`).join('');
  $('sbStock').textContent = SBSTART ? 'Число справа — сколько готовых цепочек в запасе.' : 'Загружаю цепочки…';
  document.querySelectorAll('#sbSteps button').forEach(b => b.onclick = () => { SB.step = b.dataset.step; saveSB(); push('sbgo'); sbGo(SB.step); });
}
/* --- шаг --- */
let go = null;
const shuffle = a => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [r[i], r[j]] = [r[j], r[i]]; } return r; };
async function sbGo(step) {
  show('sbgo'); G.mode = 'soberi'; saveG();
  if (!SBSTART) await sbLoad();
  const chain = sbStock(step)[0];
  $('gTtl').textContent = `Собери · ${step}`;
  $('gEnd').classList.add('hidden');
  document.querySelector('#sbgo .card').classList.toggle('hidden', !chain);
  if (!chain) {
    $('gEnd').classList.remove('hidden'); $('gMore').classList.add('hidden');
    $('gEndTxt').textContent = navigator.onLine ? 'Готовлю занятие… Цепочки этой ступени кончились, новые придут через минуту-другую.' : 'Цепочки этой ступени кончились. Новые готовятся со связью.';
    sbRefill(step); setTimeout(() => { if (shown('sbgo') && go === null) sbLoad().then(() => shown('sbgo') && sbStock(step).length && sbGo(step)); }, 60000);
    go = null; return;
  }
  sbRefill(step);
  const flagged = SB.flags[chain.id] || {};
  go = { chain, step, q: chain.items.map((_, k) => k).filter(k => !flagged[chain.items[k].n]), k: 0, tries: 0, res: null, grades: {}, again: new Set() };
  goRender();
}
function goRender() {
  const it = go.chain.items[go.q[go.k]];
  $('gCnt').textContent = `${go.k + 1} / ${go.q.length}`;
  $('gRu').textContent = it.ru;
  $('gBlocks').innerHTML = SB.opora ? shuffle(it.blocks || []).map(b => `<span>${esc(b)}</span>`).join('') : '';
  $('gBlocks').classList.toggle('hidden', !SB.opora);
  $('gOpora').textContent = SB.opora ? 'без опоры' : 'показать опору';
  const r = go.res, final = r && (r.g === 'g' || go.tries >= 2);
  if (!r) {
    $('gSlot').innerHTML = `<textarea id="gIn" lang="el" rows="2" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="${esc(it.ru)}"></textarea>`;
    if (go.keep) $('gIn').value = go.keep;
  } else if (!final) {  /* первая ошибка: свои неверные слова подчёркнуты, намёк, верного ответа нет */
    $('gSlot').innerHTML = `<div class="cmp"><span class="el you">${r.d.words.map(w => w.e || w.extra ? `<span class="und">${esc(w.w)}</span>` : esc(w.w)).join(' ')}</span></div>`;
  } else {
    $('gSlot').innerHTML = `<div class="cmp"><span class="el you">${r.d.u}</span><span class="el">${r.d.o}</span><span class="grade ${go.grades[go.q[go.k]] || r.g}">${GRADE_LBL[go.grades[go.q[go.k]] || r.g]}</span></div>`
      + (r.alt && r.g === 'g' ? `<p class="muted">Другой порядок слов — тоже верно. Эталон: ${esc(it.el[0])}</p>` : '');
  }
  $('gHint').classList.toggle('hidden', !(r && !final));
  if (r && !final) {
    const kinds = new Set();
    r.d.words.forEach(w => { if (w.extra) kinds.add('лишнее слово'); else if (w.e) kinds.add(w.w.length <= 3 ? 'артикль или служебное слово' : 'окончание'); });
    if (r.d.miss) kinds.add('не хватает слова');
    $('gHint').innerHTML = `<span class="hint">Исправьте сами: ${esc([...kinds].join(', ') || 'проверьте форму')}</span>` + (it.change ? `<span class="muted">Что поменялось от прошлого шага: ${esc(it.change)}</span>` : '');
  }
  $('gCheck').classList.toggle('hidden', !!r);
  $('gPlayRow').classList.toggle('hidden', !final);
  $('gNoVoice').classList.toggle('hidden', !(final && !elVoice()));
  $('gS3').classList.toggle('hidden', !r);
  $('gOn').classList.toggle('hidden', !final || r.g === 'r');  /* «не знаю» — только «Ещё раз» */
  $('gMine').classList.toggle('hidden', !(r && r.g !== 'g' && r.a));
  $('gJudge').classList.add('hidden');
  $('gFlagBox').classList.add('hidden');
  $('gFlag').textContent = 'Неверно?';
  paintSpeed(); paintOwner();
}
/* Порядок слов в греческом свободный («Πάντα φεύγει η τέλεια στιγμή» = «Η τέλεια στιγμή πάντα φεύγει», 7 ноября 2026).
   Эталон el[0] режется по разметке words на части: именная группа (предлог, указательное, артикль, прилагательные,
   существительное, слабое притяжательное после него), глагол с δεν/μην/θα/να и слабыми местоимениями, наречие (наречие
   перед прилагательным, наречием или предлогом — с ними), прочее по слову. Части переставляются во все порядки.
   Не переставляем: вопрос, запятую, союз, больше одного глагола, больше 6 частей. Две именные группы без предлога
   меняются местами, только если артикли у них разные (το σκυλί … το παιδί — кто кого, по форме не понять). */
const sbPlain = s => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ');
const SB_PT = new Set(['δεν', 'δε', 'μην', 'μη', 'θα', 'να']), SB_STOP = new Set(['και', 'αλλα', 'που', 'οτι', 'οταν', 'γιατι', 'αν', 'πωσ', 'ποτε', 'τι', 'ποιοσ', 'ομωσ', 'η']);
function sbKind(w) {
  const g = w.g || '', l = sbPlain(w.l || '');
  if (/^предл/.test(g) || /\+/.test(w.l || '')) return 'prep';
  if (/^артикль/.test(g)) return 'art';
  if (/^частиц|^част\./.test(g) || SB_PT.has(l)) return 'pt';
  if (/союз|вопр|относ/.test(g) || (SB_STOP.has(l) && !/^артикль/.test(g))) return 'stop';
  if (/слаб/.test(g)) return 'cl';
  if (/^сущ/.test(g)) return 'n';
  if (/^прил|указ|^числ|притяж/.test(g)) return 'adj';
  if (/^нареч/.test(g)) return 'adv';
  if (/^гл|наст|аор|буд|παρατ|повел|сосл/.test(g)) return 'v';
  return 'x';
}
const SB_ORD = new Map();
function sbOrders(it) {
  const src = it.el[0] || '', key = src + '|' + JSON.stringify(it.words || []);
  if (SB_ORD.has(key)) return SB_ORD.get(key);
  const out = [], W = it.words || [];
  SB_ORD.set(key, out);
  if (W.length < 2 || /[;;,·]/.test(src) || tok(src).length !== W.flatMap(w => tok(w.t)).length) return out;
  const K = W.map(sbKind);
  if (K.includes('stop') || K.filter(k => k === 'v').length !== 1) return out;
  const grp = new Array(W.length).fill(-1); let ng = 0;
  // именные группы: предлог, артикль, прилагательное, существительное подряд; новое начало — артикль или предлог после существительного
  for (let i = 0; i < W.length; i++) {
    const nom = k => k === 'prep' || k === 'art' || k === 'adj' || k === 'n';
    if (!nom(K[i])) continue;
    const g = ng++; let seenN = false;
    for (; i < W.length && nom(K[i]); i++) {
      // после существительного новая группа — с артикля или предлога; родительный (τα κλαδιά του δέντρου) остаётся при нём
      if (seenN && (K[i] === 'art' || K[i] === 'prep') && !(K[i] === 'art' && /род\.\s*(ед|мн)/.test(W[i].g || ''))) break;
      grp[i] = g; if (K[i] === 'n') seenN = true;
    }
    if (i < W.length && seenN && K[i] === 'cl') grp[i++] = g;  // ο σκύλος μου
    if (i < W.length && !seenN && K[i] === 'adv' && K[i - 1] === 'prep') grp[i++] = g;  // από πάνω
    i--;
  }
  // глагол с частицами и слабыми местоимениями до и после
  const v = K.indexOf('v'), gv = ng++; grp[v] = gv;
  for (let j = v - 1; j >= 0 && grp[j] < 0 && (K[j] === 'pt' || K[j] === 'cl'); j--) grp[j] = gv;
  for (let j = v + 1; j < W.length && grp[j] < 0 && K[j] === 'cl'; j++) grp[j] = gv;
  if (K.some((k, j) => (k === 'pt' || k === 'cl') && grp[j] < 0)) return out;  // частица не у глагола — не трогаем
  // наречие перед прилагательным, наречием или предлогом — с ним; остальное — по слову
  for (let j = W.length - 1; j >= 0; j--) if (grp[j] < 0) grp[j] = K[j] === 'adv' && j + 1 < W.length && ['adj', 'adv', 'prep'].includes(K[j + 1]) ? grp[j + 1] : ng++;
  const parts = []; grp.forEach((g, j) => { if (j && grp[j - 1] === g) parts[parts.length - 1].push(j); else parts.push([j]); });
  if (parts.length < 2 || parts.length > 6 || new Set(grp).size !== parts.length) return out;
  // именные части без предлога: ключ — артикль; две без артикля или с одинаковым артиклем меняться местами не могут
  const nomKey = p => { const k0 = K[p[0]]; if (k0 === 'prep' || !p.some(j => K[j] === 'n' || K[j] === 'adj' || K[j] === 'x')) return undefined; return k0 === 'art' ? sbPlain(W[p[0]].t) : null; };
  const keys = parts.map(nomKey), proper = j => /собств/.test(W[j].g || '');
  const end = (src.match(/[.!…]+\s*$/) || [''])[0].trim();
  const perm = (rest, acc) => {
    if (!rest.length) {
      for (let a = 0; a < acc.length; a++) for (let b = a + 1; b < acc.length; b++) {
        const ka = keys[acc[a]], kb = keys[acc[b]];
        if (acc[a] > acc[b] && ka !== undefined && kb !== undefined && (ka === null || kb === null || ka === kb)) return;
      }
      if (acc.every((p, k) => p === k)) return;
      const ws = acc.flatMap(p => parts[p]).map((j, k) => {
        let t = W[j].t;
        if (j === 0 && !proper(j)) t = t.charAt(0).toLowerCase() + t.slice(1);
        return k === 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t;
      });
      out.push(ws.join(' ') + end);
      return;
    }
    rest.forEach((p, k) => perm(rest.filter((_, q) => q !== k), [...acc, p]));
  };
  perm(parts.map((_, k) => k), []);
  return out;
}
/* сверка с ближайшим: эталоны, их перестановки и признанные «Моё тоже верно?»; меньше оценка, потом меньше ошибок, при равенстве — эталон */
function sbBest(a, it, cid) {
  const mine = ((SB.mine || {})[cid] || {})[it.n] || [];
  const cand = [...new Set([...it.el, ...mine, ...sbOrders(it)])];
  let best = null;
  cand.forEach(v => { const d = diff(a, v, 'el'), sc = 'gyr'.indexOf(d.g) * 1000 + d.err; if (!best || sc < best.sc) best = { d, v, sc }; });
  best.alt = !it.el.includes(best.v);
  return best;
}
$('gOpora').onclick = () => { SB.opora = !SB.opora; saveSB(); const keep = $('gIn') && $('gIn').value; goRender(); if (keep && $('gIn')) $('gIn').value = keep; };
$('gCheck').onclick = () => {
  const k = go.q[go.k], it = go.chain.items[k], a = $('gIn').value.trim();
  const b = a ? sbBest(a, it, go.chain.id) : { d: diff('', it.el[0], 'el'), v: it.el[0] };
  go.tries++;
  go.res = { a, d: b.d, v: b.v, alt: !!b.alt, g: a ? b.d.g : 'r' };
  if (go.tries === 1 && go.res.g === 'g') sbMark(k, 'g', a);
  else if (go.tries === 2) sbMark(k, go.res.g === 'g' ? 'y' : 'r', a);
  goRender();
};
function sbMark(k, c, a) {
  if (go.grades[k]) return;  /* повтор «не знаю» в конце цепочки оценку не меняет */
  go.grades[k] = c;
  const pid = go.chain.id + ':' + go.chain.items[k].n, at = now(), id = uuid();
  EK.queueProgress({ lang: 'el', text_id: 'soberi', phrase_id: pid, cut: 1, color: c, written: a || null, updated_at: at });
  EK.queueLog({ id, at, kind: 'mark', lang: 'el', text_id: 'soberi', phrase_id: pid, mode: 'soberi', color: c });
}
$('gAgain').onclick = () => {
  stop(); speechSynthesis.cancel();
  if (go.tries >= 2 && go.res.g !== 'g') go.tries = 1;  /* после образца — ещё попытка, оценка уже стоит */
  go.keep = ''; go.res = null; goRender(); $('gIn').focus({ preventScroll: true });
};
$('gOn').onclick = () => {
  speechSynthesis.cancel();
  const k = go.q[go.k];
  if (go.grades[k] === 'r' && !go.again.has(k)) { go.again.add(k); go.q.push(k); }  /* «не знаю» — ещё раз в конце цепочки */
  go.k++; go.tries = 0; go.res = null; go.keep = '';
  if (go.k >= go.q.length) return sbEnd();
  goRender(); window.scrollTo(0, 0);
};
function sbEnd() {
  SB.played = [...SB.played.filter(id => id !== go.chain.id), go.chain.id].slice(-500); saveSB();
  if (!String(go.chain.id).startsWith('start-')) EK.chainState(go.chain.id, 'played').catch(() => {});
  document.querySelector('#sbgo .card').classList.add('hidden');
  const c = Object.values(go.grades), n = x => c.filter(y => y === x).length;
  $('gEndTxt').textContent = `Цепочка пройдена: знаю — ${n('g')}, с трудом — ${n('y')}, не знаю — ${n('r')}.`;
  $('gMore').classList.remove('hidden'); $('gEnd').classList.remove('hidden');
  sbRefill(go.step);
}
$('gMore').onclick = () => sbGo(SB.step);
$('gExit').onclick = () => goBack('');
/* «Неверно?» — пометка; шаг уходит из запаса, текст — в журнал и настройки */
$('gFlag').onclick = () => $('gFlagBox').classList.toggle('hidden');
$('gFlagSave').onclick = () => {
  const it = go.chain.items[go.q[go.k]], t = $('gFlagText').value.trim(); if (!t) return;
  (SB.flags[go.chain.id] = SB.flags[go.chain.id] || {})[it.n] = { text: t, t: now().slice(0, 16), ru: it.ru, el: it.el[0] };
  saveSB();
  EK.queueLog({ id: uuid(), at: now(), kind: 'mark', lang: 'el', text_id: 'soberi', phrase_id: go.chain.id + ':' + it.n, mode: 'soberi-flag', color: null });
  $('gFlagText').value = ''; $('gFlagBox').classList.add('hidden');
  go.q = go.q.filter((k, j) => j <= go.k || go.chain.items[k].n !== it.n);
  $('gOn').classList.remove('hidden'); $('gFlag').textContent = 'Отмечено';
  if (!go.res) $('gOn').onclick();
};
/* «Моё тоже верно?» — суждение ИИ (Sonnet) по кнопке; верно — оценка «знаю» поверх, вариант запоминается в цепочке на этом устройстве */
$('gMine').onclick = async () => {
  const k = go.q[go.k], it = go.chain.items[k];
  $('gJudge').classList.remove('hidden'); $('gJudge').textContent = 'Спрашиваю…';
  try {
    const r = await EK.fn({ action: 'judge', ru: it.ru, answer: go.res.a, variants: it.el });
    $('gJudge').textContent = (r.ok ? 'Верно. ' : 'Неверно. ') + (r.note || '');
    if (r.ok) {  /* признанный вариант запоминается в настройках (синхронно на всех устройствах) — сверка примет его и в следующий раз */
      const m = ((SB.mine = SB.mine || {})[go.chain.id] = SB.mine[go.chain.id] || {});
      m[it.n] = [...new Set([...(m[it.n] || []), go.res.a])]; saveSB();
      const note = $('gJudge').textContent;
      go.grades[k] = null; sbMark(k, go.tries <= 1 ? 'g' : 'y', go.res.a);
      go.res = { ...go.res, d: diff(go.res.a, go.res.a, 'el'), v: go.res.a, alt: false, g: 'g' };
      goRender(); $('gJudge').classList.remove('hidden'); $('gJudge').textContent = note;
    }
  } catch (e) { $('gJudge').textContent = EK.DEV ? 'В режиме проверки без входа ИИ не спрашиваем.' : navigator.onLine ? 'Не вышло спросить — попробуйте позже.' : 'Нет сети.'; }
};
/* голос телефона: synthesis el-GR; скорость — та же лесенка */
const elVoice = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []).find(v => /^el(-|_|$)/i.test(v.lang));
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { if (shown('sbgo') && go && go.res) goRender(); };
$('gPlay').onclick = () => {
  const v = elVoice(); if (!v || !go.res) return;
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
  const u = new SpeechSynthesisUtterance(go.res.v); u.voice = v; u.lang = v.lang; u.rate = G.rate;
  speechSynthesis.speak(u);
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
    else if (k === 'soberi') { SB = Object.assign(SB, r.v || {}); write(SBKEY, SB); }
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
