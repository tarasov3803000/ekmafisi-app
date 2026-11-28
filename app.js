/* Экмафиси — логика приложения (из пробной страницы). Грузится из sync.js, когда вход проверен и список текстов есть:
   EK.lib — тексты, EK.uid — кто вошёл, EK.content(путь) — файл из закрытого хранилища (с кэшем), EK.queue* — отправка. */
const LIB = EK.lib;
const LEVELS = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
const MODE_NAME = { skor: 'Повторение', bt: 'Обратный перевод', ves: 'Весь текст', soberi: 'Собери' };  /* ключ skor — прежнее имя «Скороговорки»: так в настройках и адресах */
/* язык материала: текст фразы — поле t (прежние греческие материалы — el), порядок форм глагола и надписи — по языку */
const LANGS = {
  el: { name: 'греческий', chip: 'ΕΛ', say: 'по-гречески', to: 'на греческий', forms: ['present', 'imperfect', 'aorist', 'future'] },
  en: { name: 'английский', chip: 'EN', say: 'по-английски', to: 'на английский', forms: ['base', 'past', 'participle'] }
};
const LG = m => LANGS[m.lang] || LANGS.el;
const SLV_YAZ = ['el', 'en'];  /* языки со своим словарём (app/slovar.js: Slovar — греческий, Slovar.yazyk('en') — английский, 27.11.2026) */
const TX = p => p.t ?? p.el;
const TTL = m => m.title_t ?? m.title_el;
const AUTHOR = m => m.source.author_ru || m.source.author;
/* полка: сначала по языку (греческий, английский), внутри — по уровню; одинаковые — в порядке сборки */
const LORD = Object.keys(LANGS);
LIB.sort((a, b) => (LORD.indexOf(a.lang) - LORD.indexOf(b.lang)) || (LEVELS[a.level] || 9) - (LEVELS[b.level] || 9));
/* фразы с экрана блокировки в тренировке (Ваше слово 27.11.2026) — свой «блок» на каждый язык, не на полке (раздел «Фразы с блокировки») */
const BLOK = Object.keys(LANGS).map(lang => ({ id: 'blok-' + lang, lang, blok: true, cut: 1, level: '', title: 'Фраза с блокировки', title_t: 'Фраза с блокировки',
  source: { author: '', channel: '' }, audio: { layer: 'blok' }, phrases: [], lexicon: {}, chunks: [[]], idioms: [] }));
const blokOf = lang => BLOK.find(b => b.lang === (lang || 'el'));
const findMat = id => LIB.find(m => m.id === id) || BLOK.find(m => m.id === id);
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
/* язык обучения — lang; последний текст (карточка сверху полки) — свой у каждого языка: last.el, last.en */
/* lvOff.<язык> — уровни, выключенные учеником: на полке их нет (хранятся выключенные, не включённые — новый уровень появится сам) */
const G_SYNC = ['rate', 'mode', 'theme', 'lang', 'btN', ...Object.keys(LANGS).flatMap(l => ['last.' + l, 'lvOff.' + l])];
if (G.last) { const m0 = LIB.find(m => m.id === G.last); if (m0 && !G['last.' + m0.lang]) G['last.' + m0.lang] = G.last; delete G.last; }  /* прежний общий last */
const lastId = () => G.lang && G['last.' + G.lang];
const levelsOf = lang => [...new Set(LIB.filter(m => m.lang === lang).map(m => m.level))].sort((a, b) => (LEVELS[a] || 9) - (LEVELS[b] || 9));
const lvOff = lang => G['lvOff.' + lang] || [];
const onShelf = m => m.lang === G.lang && !lvOff(m.lang).includes(m.level);
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
  if (m.blok) { show(false); return (audioReady = Promise.resolve()); }  /* у фраз с блокировки звук свой у каждой — blokSrc */
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
audio.addEventListener('ended', () => { if (stopAt !== null && !tts) { stopAt = 0; cancelAnimationFrame(raf); tick(); } });  /* фраза — целый файл (пример словаря) */
function stop() {
  if (tts || ttsHeld) { tts = ttsHeld = null; speechSynthesis.cancel(); }
  seqToken++; cancelAnimationFrame(raf); audio.pause(); stopAt = null; onEnd = null;
  owner = null; paused = false; seqActive = false; heldNext = null; paintOwner();
  document.querySelectorAll('.playing').forEach(e => e.classList.remove('playing'));
}
function pause() {
  paused = true; cancelAnimationFrame(raf); audio.pause();
  if (tts) { ttsHeld = tts; tts = null; speechSynthesis.cancel(); }  /* голос телефона на паузе ненадёжен — продолжаем фразу заново */
  paintOwner();
}
function resume() {
  paused = false;
  if (heldNext) { const f = heldNext; heldNext = null; f(); }
  else if (ttsHeld) { const t = ttsHeld; ttsHeld = null; ttsSay(t.i, t.rate, t.done); }
  else if (stopAt !== null) { const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {}); raf = requestAnimationFrame(tick); }
  paintOwner();
}
/* нажатие на el: звучит el — пауза; на паузе — дальше; иначе — начать заново (start) */
function toggle(el, start) {
  if (owner === el && (stopAt !== null || seqActive)) { paused ? resume() : pause(); return; }
  start();
}
function playBy(el, i, rate, done) { stop(); owner = el; playOne(i, rate, done); paintOwner(); }
/* звук текста загружен и файл открыт (есть длительность): раньше ▶ сразу после открытия нового текста, пока звук
   грузился, считал фразы сыгранными — терялась первая фраза или её начало (Ваше замечание, 25.11.2026); ждём
   загрузку, а метаданные — не дольше 1,5 с (iOS без касания может не открыть файл до play) */
function audioOpen() {
  return audioReady.then(() => audio.readyState >= 1 ? null : new Promise(r => {
    const f = () => { audio.removeEventListener('loadedmetadata', f); clearTimeout(t); r(); };
    const t = setTimeout(f, 1500); audio.addEventListener('loadedmetadata', f);
  }));
}
/* «Голос: телефона» (настройка, 27.11.2026) — тексты своей озвучки (audio.layer 'golos': «Кино», пересказы) читаются голосом
   телефона; записи блогеров — записью. stopAt = Infinity — «звучит» для всей машины ▶/⏸, конец — по концу реплики */
let tts = null, ttsHeld = null;
const ttsOn = (m, i) => telGolos() && (m.blok ? !!(m.phrases[i] && m.phrases[i].golos) : m.audio && m.audio.layer === 'golos') && !!voiceOf(m.lang || 'el');
function ttsSay(i, rate, done) {
  const tok = seqToken, v = voiceOf(M.lang || 'el'), text = TX(P[i]), u = new SpeechSynthesisUtterance(text);
  u.voice = v; u.lang = v.lang; u.rate = rate;
  const me = tts = { i, rate, done, u };
  stopAt = Infinity; onEnd = done || null;
  let t = 0;
  const fin = () => {
    clearTimeout(t); if (tts !== me || tok !== seqToken) return;
    tts = null; stopAt = null; const f = onEnd; onEnd = null; f && f();
    if (!seqActive && stopAt === null) owner = null;
    paintOwner();
  };
  u.onend = u.onerror = fin;
  t = setTimeout(fin, (1500 + text.length * 90 / rate) * 2);  /* onend в Chrome на Android бывает не приходит */
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
function playOne(i, rate, done, waited) {
  cancelAnimationFrame(raf); audio.pause(); paused = false;
  if (ttsOn(M, i)) { ttsHeld = null; return ttsSay(i, rate, done); }
  if (M.blok) return blokPlay(i, rate, done);
  if (!blobs[M.id] || (audio.readyState < 1 && !waited)) {
    const tok = seqToken, m = M;
    audioOpen().then(() => {
      if (tok !== seqToken || M !== m) return;   /* пока ждали — остановили или открыли другой текст */
      if (blobs[M.id]) playOne(i, rate, done, true); else stop();   /* звук не загрузился — сообщение уже на экране */
    });
    return;
  }
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
/* голос телефона для языка (el, en, ru) */
const voiceOf = lang => (window.speechSynthesis ? speechSynthesis.getVoices() : []).find(v => new RegExp('^' + lang + '(-|_|$)', 'i').test(v.lang));
/* «Голос»: Azure или телефона (Ваша просьба 27.11.2026) — на этом устройстве, вне учётной записи (тот же ключ читает slovar.js) */
const GOLOS = 'ekmafisi-golos';
const telGolos = () => { try { return localStorage.getItem(GOLOS) === 'tel'; } catch (e) { return false; } };
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
  if (id !== 'skor' && sk.back) { const b = sk.back; sk.back = null; if (M && M.blok) setText(b.id, true); }
  if (id !== 'nasluh') { nsStop(); NS.wasOn = false; nsDict(null); nsPopClose(); }
  ['shelf', 'settings', 'about', 'nasluh', 'home', 'skor', 'bt', 'ves', 'check', 'words', 'slovar', 'soberi', 'sbgo', 'fraza'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  window.scrollTo(0, 0); topY = 0; $('top').classList.remove('away');
  /* на полке вместо домика — флаг изучаемого языка (нажатие — другой язык) */
  $('goHome').classList.toggle('hidden', id === 'shelf'); $('langFlag').classList.toggle('hidden', id !== 'shelf');
  /* ⓘ и учётная запись — только на экране настроек (26.11.2026) */
  $('aboutOpen').classList.toggle('hidden', id !== 'settings'); $('acctOpen').parentNode.classList.toggle('hidden', id !== 'settings');
  paintWok();
  if (id === 'shelf') renderShelf();
  if (id === 'home') renderHome();
  if (id === 'settings') renderSettings();
  if (id === 'words') renderWords();
  if (id === 'fraza') renderFraza();
  if (id === 'nasluh') nsOpen();
  $('acctPop').classList.add('hidden');
}
const shown = id => !$(id).classList.contains('hidden');

/* --- переходы: каждый экран и окно — шаг в истории браузера, системное «назад» и «←» идут на шаг выше:
   полка ← текст (#id) ← режим (#id-skor, #id-bt) ← окно слова (значения, происхождение, история) */
const MODES = ['skor', 'bt', 'ves'];
const urlOf = h => h ? '#' + h : location.pathname + location.search;
const depth = () => (history.state && history.state.d) || 0;
const curHash = () => location.hash.slice(1);
function push(hash, sheet) { history.pushState({ d: depth() + 1, sheet: sheet || null }, '', urlOf(hash)); }
function goBack(fallback) {  /* открыто ссылкой прямо сюда — шага назад в странице нет: подменяем запись на экран выше */
  if (depth() > 0) history.back();
  else { history.replaceState({ d: 0, sheet: null }, '', urlOf(fallback)); applyLoc(); }
}
function parseHash(h) {
  if (['settings', 'about', 'nasluh', 'check', 'words', 'soberi', 'sbgo', 'fraza'].includes(h)) return { v: h };
  if (h === 'slovar' || h.startsWith('slovar/')) {  /* #slovar/<лемма>[/tab|/etym] — статья, её таблицы или происхождение */
    const r = h.length > 7 ? decodeURIComponent(h.slice(7)) : null, m = r && r.match(/\/(tab|etym|hist)$/);
    return { v: 'slovar', l: m ? r.slice(0, -m[0].length) : r, m: m ? m[1] : null };
  }
  for (const v of MODES) if (h.endsWith('-' + v)) { const id = h.slice(0, -v.length - 1); if (LIB.some(m => m.id === id)) return { v, id }; }
  return LIB.some(m => m.id === h) ? { v: 'home', id: h } : { v: 'shelf' };
}
function applyLoc(force) {  /* force — первый вход: экран рисуется, даже если уже виден */
  const t = parseHash(curHash()), sh = history.state && history.state.sheet;
  if (['shelf', 'settings', 'about', 'nasluh', 'words', 'fraza'].includes(t.v)) { if (force || !shown(t.v)) show(t.v); }
  else if (t.v === 'check') { if (force || !shown('check')) checkOpen(); }
  else if (t.v === 'slovar') { if (force || !shown('slovar')) show('slovar'); slvPokaz().show(t.l, t.m); }
  else if (t.v === 'soberi') { if (force || !shown('soberi')) soberiOpen(); }
  else if (t.v === 'sbgo') { if (force || !shown('sbgo')) sbGo(SB.step); }
  else {
    const fresh = (!M || M.id !== t.id) && !(t.v === 'skor' && sk.back && sk.back.id === t.id && shown('skor'));  /* открыта фраза с блокировки внутри «Повторения» */
    if (fresh) setText(t.id);
    if (force || fresh || !shown(t.v)) t.v === 'home' ? show('home') : t.v === 'bt' ? btOpenAt(btPos()) : t.v === 'ves' ? vesOpen() : skorOpen(S.skorAt);
  }
  const nsd = sh && sh.k === 'nsd';
  nsDict(nsd ? sh : null);
  sh && !nsd ? openSheet(sh) : closeSheet();
}
window.addEventListener('popstate', () => applyLoc());

/* --- полка --- */
function renderShelf() {
  /* язык не выбран — сначала выбор; выбран — на полке только его тексты */
  $('langPick').classList.toggle('hidden', !!G.lang);
  $('shelfList').classList.toggle('hidden', !G.lang);
  const textHtml = (m, top) => {  /* top — карточка сверху полки: самого обычного вида, без рамки «последний» (Ваше слово 27.11.2026) */
    const pr = progOf(m), c = counts(m, pr.colors), n = m.phrases.length;
    const done = c.g + c.y + c.r;
    return `<button class="text${!top && lastId() === m.id ? ' last' : ''}" data-id="${m.id}">
      <span class="top"><span class="row" style="gap:6px"><span class="chip lang" title="${esc(LG(m).name)}">${esc(LG(m).chip)}</span><span class="chip">${esc(m.level)}</span></span><span class="meta2">${n} ${plural(n, 'фраза', 'фразы', 'фраз')}</span></span>
      <span class="t">${esc(TTL(m))}</span>
      <span class="tru">${esc(m.title)}</span>
      <span class="meta2">${esc(AUTHOR(m))}, «${esc(m.source.channel)}»</span>
      ${done ? squaresHtml(c, n) : ''}
      <span class="tally" aria-hidden="true">${tallyHtml(c, n)}</span>
    </button>`;
  };
  /* «Тексты» свёрнуты — список рисуется, только когда раскрыт (по уровням, включённым в настройках: onShelf) */
  const open = txOpen();
  $('txFold').setAttribute('aria-expanded', String(open)); $('texts').classList.toggle('hidden', !open);
  $('texts').innerHTML = open ? LIB.filter(onShelf).map(textHtml).join('') : '';
  /* сверху — текст, с которым работали последним (Ваше слово 26.11.2026: вместо «Продолжить»); нажатие — сам текст */
  const last = G.lang && LIB.find(m => m.id === lastId() && (m.lang || 'el') === G.lang);
  $('lastText').classList.toggle('hidden', !last);
  $('lastText').innerHTML = last ? textHtml(last, true) : '';
  document.querySelectorAll('#texts .text, #lastText .text').forEach(b => b.onclick = () => openText(b.dataset.id));
  /* плитки — одним шрифтом, только название (26.11.2026); «Проверка · N» — фразы, которым подошёл срок */
  $('shelfTools').classList.toggle('hidden', !G.lang);
  if (G.lang) {
    const n = dueList().length;
    $('chkOpen').textContent = `Проверка · ${n}`;
    $('chkOpen').disabled = !n;
  }
  /* «Фразы на блокировке» — история показанных на экране блокировки (27.11.2026 — и на компьютере): в Android-приложении —
     родной экран (★, 🔊), иначе — экран «Фразы · N» из истории на сервере */
  $('frazaOpen').classList.toggle('hidden', !G.lang || EK.guest);
  $('frazaOpen').href = isAndr() ? andrUrl('fraza/istoriya') : '#fraza';
  $('langFlag').textContent = { el: '🇬🇷', en: '🇬🇧' }[G.lang] || '🌐';
  $('langFlag').setAttribute('aria-label', 'Язык: ' + (G.lang ? LANGS[G.lang].name : 'не выбран') + '. Сменить');
  /* «Собрать фразу» (режим «Собери») — только у греческого; «Словарь» — у греческого и английского (27.11.2026); плитка — без ступени (26.11.2026) */
  const sbOn = G.lang === 'el' && !EK.guest;  /* гость: «Собери» нет (ИИ — только своим), «Словарь» есть */
  $('slvOpen').classList.toggle('hidden', !SLV_YAZ.includes(G.lang));
  $('sbCard').classList.toggle('hidden', !sbOn);
  /* гость: открыто своё (пересказы, своя озвучка); прочие тексты — по ролику или фильму — только своим, после входа */
  const gn = EK.guest && G.lang;
  $('guestNote').classList.toggle('hidden', !gn);
  if (gn) $('guestNote').textContent = (LIB.some(onShelf) ? 'Остальные тексты' : 'Тексты') + ' — по чужим роликам и фильмам, они открыты только своим. Войти — в настройках.';
  paintWok();
}
const TXF = 'ekmafisi-teksty';  /* «Тексты» раскрыты или свёрнуты — как оставили, на этом устройстве */
const txOpen = () => { try { return localStorage.getItem(TXF) === '1'; } catch (e) { return false; } };
$('txFold').onclick = () => {
  const on = !txOpen(); try { localStorage.setItem(TXF, on ? '1' : '0'); } catch (e) {}
  renderShelf();
  if (on) requestAnimationFrame(() => $('txFold').scrollIntoView({ block: 'start', behavior: 'smooth' }));
};
/* число освоенных слов — в верхней строке рядом с темой, на всех экранах (26.11.2026; плитка «Слова» убрана) */
function paintWok() {
  const on = !!G.lang && (!!LIB.length), n = on ? wordStats().ok : 0;
  $('wOk').classList.toggle('hidden', !on);
  $('wOk').textContent = n; $('wOk').setAttribute('aria-label', `Освоено ${n} ${plural(n, 'слово', 'слова', 'слов')}`);
}
$('wOk').onclick = () => { if (!shown('words')) { push('words'); show('words'); } };
document.querySelectorAll('#langPick [data-lang]').forEach(b => b.onclick = () => { G.lang = b.dataset.lang; saveG(); renderShelf(); });
/* --- настройки: всё, что не учёба — язык, тема, учётная запись, итог --- */
$('setOpen').onclick = () => { push('settings'); show('settings'); };
$('langFlag').onclick = () => { const k = Object.keys(LANGS); G.lang = k[(k.indexOf(G.lang) + 1) % k.length]; saveG(); renderShelf(); };
/* Настройки → «Пользователи» (только Антону, EK.admin): список подгружается, когда карточку раскрыли */
const dmy = t => t ? new Date(t).toLocaleDateString('ru-RU') : '';
async function renderUsers() {
  const box = $('usList');
  if (!navigator.onLine && !EK.DEV) { box.innerHTML = '<p class="small muted">Нужна сеть.</p>'; return; }
  let list;
  try { list = await EK.users(); }
  catch (e) { box.innerHTML = `<p class="small muted">Не загрузилось: ${esc(e.message || e)}</p>`; return; }
  box.innerHTML = list.map((u, i) => {
    const spent = [u.ai_usd != null && `ИИ $${(+u.ai_usd).toFixed(2).replace('.', ',')}`, u.golos_znaki != null && `озвучка ${u.golos_znaki} зн.`].filter(Boolean).join(' · ');
    return `<div class="u"><input data-i="${i}" value="${esc(u.note || '')}" placeholder="имя" aria-label="Имя"><span class="em">${esc(u.email)}</span>
      <span class="st">с ${dmy(u.added_at)} · ${u.signed_in_at ? 'входил ' + dmy(u.signed_in_at) : 'ещё не входил'}${spent ? ' · ' + spent : ''}</span></div>`;
  }).join('') || '<p class="small muted">Список пуст.</p>';
  box.querySelectorAll('input').forEach(inp => inp.onchange = async () => {
    const u = list[+inp.dataset.i];
    try { await EK.userPut(u.email, inp.value); u.note = inp.value.trim() || null; }
    catch (e) { inp.value = u.note || ''; alert('Имя не сохранилось: ' + (e.message || e)); }
  });
}
$('setUsers').ontoggle = () => { if ($('setUsers').open) renderUsers(); };
$('usAdd').onsubmit = async ev => {
  ev.preventDefault();
  const email = $('usEmail').value.trim(), note = $('usNote').value.trim();
  $('usMsg').textContent = '';
  try {
    await EK.userPut(email, note);
    $('usEmail').value = $('usNote').value = '';
    $('usMsg').textContent = `${email} добавлен — может входить.`;
    renderUsers();
  } catch (e) { $('usMsg').textContent = 'Не вышло: ' + (e.message || e); }
};

/* Android-приложение Экмафиси (TWA + родная часть): ссылки в его родные экраны; тема и голос — как здесь, родная часть их запоминает
   (тема — для ярлыка и уведомления, голос — для 🔊 фразы на блокировке) */
const isAndr = () => { try { return localStorage.getItem('ekmafisi.android') === '1'; } catch (e) { return false; } };
/* k — ключ устройства: по нему родная часть отправляет историю фраз на сервер (fraza_istoriya_put) */
let FK = null;
const andrUrl = path => `intent://${path}?tema=${themeNow()}&golos=${telGolos() ? 'tel' : 'azure'}${FK ? '&k=' + FK : ''}#Intent;scheme=ekmafisi;package=pro.antontarasov.ekmafisi;end`;
$('frazaOpen').onclick = e => { if (isAndr()) return; e.preventDefault(); if (!shown('fraza')) { push('fraza'); show('fraza'); } };
function renderSettings() {
  $('setUsers').classList.toggle('hidden', !EK.admin);
  /* «Фраза на экране блокировки» и «Обновление программы» (родная часть: фраза, значок) — только в Android-приложении */
  $('setFraza').classList.toggle('hidden', !isAndr()); $('setObn').classList.toggle('hidden', !isAndr());
  $('setFraza').href = andrUrl('fraza'); $('setObn').href = andrUrl('fraza/obnovlenie');
  document.querySelectorAll('#setGolos button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.g === 'tel') === telGolos())));
  /* число статей словаря — здесь, не под полем поиска (Ваше слово 27.11.2026) */
  const so = window.Slovar && Slovar.opisanie ? Slovar.opisanie() : ''; $('setSlv').textContent = so; $('setSlvRow').classList.toggle('hidden', !so);
  document.querySelectorAll('#setLang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === G.lang)));
  $('setBtN').value = G.btN || 3; $('setBtNV').textContent = G.btN || 3;
  closePops();
  paintBig();
  /* уровни на полке — свои у каждого языка; последний включённый не выключается (полка не бывает пустой) */
  const lv = G.lang ? levelsOf(G.lang) : [];
  $('setLevelCard').classList.toggle('hidden', lv.length < 2);
  $('setLevel').innerHTML = lv.map(l => `<button data-lv="${esc(l)}" aria-pressed="${!lvOff(G.lang).includes(l)}">${esc(l)}</button>`).join('');
  document.querySelectorAll('#setLevel button').forEach(b => b.onclick = () => {
    const off = lvOff(G.lang), l = b.dataset.lv;
    if (off.includes(l)) G['lvOff.' + G.lang] = off.filter(x => x !== l);
    else if (lv.length - off.length > 1) G['lvOff.' + G.lang] = [...off, l];
    else return;
    saveG(); renderSettings();
  });
}
$('setBtN').oninput = () => { G.btN = +$('setBtN').value; $('setBtNV').textContent = G.btN; };
$('setBtN').onchange = () => { G.btN = +$('setBtN').value; saveG(); };
document.querySelectorAll('#setLang button').forEach(b => b.onclick = () => { G.lang = b.dataset.lang; saveG(); renderSettings(); });
/* «Голос»: Azure (своя озвучка) или голос телефона — для всего синтезированного: словарь, «На слух» (и русский), тексты своей
   озвучки («Кино», пересказы); записи блогеров звучат записью. На этом устройстве: голоса у телефона и компьютера разные */
document.querySelectorAll('#setGolos button').forEach(b => b.onclick = () => {
  try { localStorage.setItem(GOLOS, b.dataset.g); } catch (e) {}
  if (b.dataset.g === 'tel' && !voiceOf((G.lang || 'el'))) alert('На этом устройстве нет голоса для этого языка — останется Azure. Голос ставится в настройках телефона: «Синтез речи» → Google → языки.');
  renderSettings();
});
/* крупный шрифт: +1…+5 px ко всем текстам, как в читалке (+4 и +5 — для планшета); только на этом устройстве (экраны телефона и Мака разные),
   ключ вне учётной записи — читается до входа (index.html). Ползунок — кегль меняется сразу, пока тянете */
const UP = 'ekmafisi-up';
const upNow = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--up')) || 0;
const paintBig = () => { const u = upNow(); $('setBig').value = u; $('setBigV').textContent = u ? '+' + u : 'обычный'; };
$('setBig').oninput = () => {
  const u = +$('setBig').value;
  document.documentElement.style.setProperty('--up', u + 'px');
  try { localStorage.setItem(UP, String(u)); localStorage.removeItem('ekmafisi-big'); } catch (e) {}
  paintBig();
};
paintBig();
/* окошко с ползунком: нажатие на значение — открыть/закрыть, нажатие мимо — закрыть */
const closePops = except => document.querySelectorAll('.rng').forEach(r => { if (r === except) return; r.querySelector('.pop').classList.add('hidden'); r.querySelector('.val').setAttribute('aria-expanded', 'false'); });
document.querySelectorAll('.rng .val').forEach(b => b.onclick = () => {
  const r = b.closest('.rng'), open = r.querySelector('.pop').classList.toggle('hidden') === false;
  closePops(r); b.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!e.target.closest('.rng')) closePops(); });
/* ⓘ — о программе (как пользоваться, итог) */
$('aboutOpen').onclick = () => { if (!shown('about')) { push('about'); show('about'); } };
/* значок учётной записи: адрес и «Выйти» (или «Войти через Google») — окошком под значком */
$('acctOpen').onclick = e => { e.stopPropagation(); const h = !$('acctPop').classList.toggle('hidden'); $('acctOpen').setAttribute('aria-expanded', String(h)); };
document.addEventListener('click', e => { if (!e.target.closest('.acct')) { $('acctPop').classList.add('hidden'); $('acctOpen').setAttribute('aria-expanded', 'false'); } });

function setText(id, quiet) {  /* quiet — для «Проверки»: текст нужен, последний текст полки не трогаем */
  const m = findMat(id);
  if (M !== m) { M = m; P = m.phrases; CHUNKS = m.chunks; S = progOf(m); }
  if (!quiet) { G['last.' + (m.lang || 'el')] = m.id; saveG(); }
  loadAudio(m); loadLex(m);
}
function openText(id) { setText(id); push(id); show('home'); }

/* --- текст --- */
function renderHome() {
  const c = counts(M, S.colors), n = P.length;
  $('hSrc').textContent = `${M.level} · ${AUTHOR(M)}, «${M.source.channel}»`;  /* без языка — в одну строку; язык и так один на полке */
  $('hTitle').textContent = TTL(M); $('hTitleRu').textContent = M.title;  /* оригинал крупно, перевод мелко */
  $('ytLink').classList.toggle('hidden', !M.source.url); if (M.source.url) $('ytLink').href = M.source.url;
  $('stat').innerHTML = `${n} ${plural(n, 'фраза', 'фразы', 'фраз')}` + squaresHtml(c, n);
  $('tally').innerHTML = tallyHtml(c, n);
  paintFold(); paintSpeed();
  $('btSub').textContent = `Переведите фразу ${LG(M).to}, не глядя на оригинал.`;
  /* точка — только «трудно» и «не знаю»; зелёное показывает шапочка */
  const dot = c => c === 'y' || c === 'r' ? `<span class="dot ${c}" aria-label="${c === 'y' ? 'трудно' : 'не знаю'}"></span>` : '';
  $('list').innerHTML = P.map((p, i) => `<div class="ph" data-i="${i}"><button class="ph-play"><span class="el">${esc(TX(p))}</span><span class="ru">${esc(p.ru)}</span></button><span class="ph-mk">${dot(S.colors[p.id])}${lrnBtn('ph-lrn', i)}</span><button class="ph-go" aria-label="Учить с этой фразы">›</button></div>`).join('');
  document.querySelectorAll('#list .ph').forEach(r => {
    const i = +r.dataset.i;
    r.querySelector('.ph-play').onclick = () => toggle(r, () => { playBy(r, i, G.rate, () => r.classList.remove('playing')); r.classList.add('playing'); });
    r.querySelector('.ph-go').onclick = () => start(G.mode === 'bt' ? 'bt' : 'skor', i);  /* любая фраза, не по очереди; «Обратный перевод» — с куска, где она есть */
  });
}
/* «Фразы» свёрнуты или развёрнуты — как оставили (на этом устройстве, для всех текстов) */
const FOLD = 'ekmafisi-phrases';
const foldOpen = () => { try { return localStorage.getItem(FOLD) === '1'; } catch (e) { return false; } };
function paintFold() { const on = foldOpen(); $('phFold').setAttribute('aria-expanded', String(on)); $('phBody').classList.toggle('hidden', !on); }
$('phFold').onclick = () => { try { localStorage.setItem(FOLD, foldOpen() ? '0' : '1'); } catch (e) {} paintFold(); };
document.querySelectorAll('.mode[data-mode]').forEach(b => b.onclick = () => start(b.dataset.mode));
function start(mode, i) {  /* i — с какой фразы; без него — с того места, где остановились */
  G.mode = mode; saveG(); push(M.id + '-' + mode);
  if (mode === 'bt') btOpenAt(i === undefined ? btPos() : i, i !== undefined);
  else if (mode === 'ves') vesOpen();
  else skorOpen(i === undefined ? S.skorAt : i);
}

/* --- Весь текст: абзацы по смыслу (chunks), без перевода; ▶ — весь текст подряд, звучащее предложение подсвечено;
   нажатие на предложение — его звук (Ваш выбор, 22.11.2026) --- */
function vesOpen() {
  show('ves');
  $('vText').innerHTML = CHUNKS.map(ch => `<p>${ch.map(i => `<span class="vs" data-i="${i}">${esc(TX(P[i]))}</span>`).join(' ')}</p>`).join('');
  $('vText').lang = M.lang || 'el';
  $('vText').querySelectorAll('.vs').forEach(e => e.onclick = () => {
    const i = +e.dataset.i;
    toggle(e, () => { playBy(e, i, G.rate, () => e.classList.remove('playing')); e.classList.add('playing'); });
  });
  paintSpeed(); paintOwner();
}
$('vPlay').onclick = () => toggle($('vPlay'), () => playSeq($('vPlay'), P.map((p, i) => i), G.rate, i => {
  const e = document.querySelector(`#vText .vs[data-i="${i}"]`);
  if (e) { e.classList.add('playing'); e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}));

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
/* выражение (idioms материала), куда входит слово k фразы p: at — [фраза, с, по] включительно, номера в p.words от 0 */
const idiomOf = (p, k) => (M.idioms || []).find(d => (d.at || []).some(([pid, a, b]) => pid === p.id && k >= a && k <= b)) || null;
const idiomRange = (p, d) => d.at.find(([pid]) => pid === p.id).slice(1);
/* артикль существительного — по помете части речи («сущ. ср.» → το; «сущ. м./ж.» → ο/η) */
const ARTS = { 'м.': 'ο', 'ж.': 'η', 'ср.': 'το' };
const artOf = pos => { const m = /^сущ\.\s*(.+)$/.exec(pos || ''); return m ? m[1].split('/').map(g => ARTS[g.trim()]).filter(Boolean).join('/') : ''; };
function glossHtml(w, p, k) {
  const L = M.lexicon[w.l] || {}, D = LEX[w.l], d = p && idiomOf(p, k), isEl = (M.lang || 'el') === 'el';
  /* нажатое слово внутри выражения — выражение целиком над статьёй слова */
  let h = d ? `<div class="idm"><div><span class="el">${esc(d.t)}</span> — ${esc(d.ru)}</div>${d.note ? `<div class="small muted">${esc(cap(d.note))}</div>` : ''}</div>` : '';
  /* первая строка (Ваше слово 27.11.2026): слово — существительное с артиклем — синим; нажатие — статья словаря, как
     «Происхождение ›» — статья о происхождении; справа — свой 🔊. У английского словаря нет — слово ведёт к «Значениям» */
  const head = isEl ? [artOf(L.pos), w.l].filter(Boolean).join(' ') : w.l;
  const to = isEl ? `data-slv="${esc(w.l)}"` : D && D.dict.senses.length ? `data-senses="${esc(w.l)}"` : '';
  h += `<div class="gl-head"><${to ? 'button' : 'span'} class="gl-w el" lang="${isEl ? 'el' : 'en'}" ${to}>${esc(head)}</${to ? 'button' : 'span'}>`
    + `<button class="gl-say" data-say="${esc(head)}" aria-label="Произнести">${Slovar.SPK}</button></div>`;
  h += `<div>${esc(cap(L.ru || (D && D.dict.senses[0] && D.dict.senses[0].ru) || ''))}</div>`;
  const g = noteOf(w, L);
  if (g) h += `<div class="small muted">${esc(cap(g))}</div>`;
  /* формы строкой, без названий времён: el — настоящее · παρατατικός · аорист · будущее; en — base · past · participle, только у неправильных */
  /* греческое имя (у глагола форм L.forms нет — тоже): краткая таблица — три падежа без звательного или четыре формы
     (Ваш ответ 26.11.2026, Slovar.kratko); таблицы нет — формы строкой, как было */
  const f = formsOf(L, D), note = L.note ? `<div class="small muted">${esc(cap(L.note))}</div>` : '';
  if (f && (L.forms || !isEl)) h += `<div class="el">${esc(f)}</div>` + note;
  else {
    if (isEl) h += `<div class="kr" data-kr="${esc(w.l)}"${f ? ` data-alt="${esc(f)}"` : ''}></div>`;
    if (f) h += note;
  }
  /* английское слово — статья своего словаря, если есть (enFill): транскрипция, три формы; слово в заголовке ведёт к «Значениям» */
  if (!isEl) h += enSlHtml(w.l, L);
  /* «Происхождение ›» с выжимкой — второй путь к статье, для тех, кто про долгое нажатие не знает (решение 5.11.2026) */
  if (!M || M.lang === 'el') h += Slovar.etimRow(w.l, Slovar.etimSync(w.l));
  return h;
}
/* нажатое слово подсвечено в предложении, пока открыта его карточка */
function pickWord(scope, el, p) {
  scope.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
  const d = p && idiomOf(p, +el.dataset.k); if (!d) return;  /* слово выражения — подсвечено всё выражение */
  const [a, b] = idiomRange(p, d), box = el.closest('.el') || scope;
  box.querySelectorAll('.w').forEach(x => { if (+x.dataset.k >= a && +x.dataset.k <= b) x.classList.add('sel'); });
}
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
  if ((!M || M.lang === 'el') && Slovar.etimSync(l) !== null) { const id = uuid(), at = now(); log.push({ id, l, t: at.slice(0, 16) }); write(EKEY, log); EK.queueLog({ id, at, kind: 'etym', lang: (M && M.lang) || 'el', lemma: l }); }
  const box = inlineBox(src);
  if (box) return showInline(box, src, b => renderEtym(l, b));
  push(curHash(), { k: 'etym', l }); openSheet(history.state.sheet);
}
/* статья словаря из карточки слова (Ваше слово 27.11.2026) — окном поверх, на любом экране: тот же «Словарь», без поиска и списка;
   слово примера и «Происхождение ›» внутри — шаги истории, «назад» — на шаг выше */
/* словарь своего языка в общем месте (окно поверх, «На слух»; 28.11.2026): у каждого языка — свой ящик внутри, виден нужный */
function yazBox(root, opts) {
  const A = {};
  return (lang = 'el') => {
    const a = A[lang] || (A[lang] = (() => { const b = document.createElement('div'); b.dataset.lang = lang; root.appendChild(b); return Slovar.yazyk(lang).mount(b, opts(lang)); })());
    [...root.children].forEach(b => b.classList.toggle('hidden', b.dataset.lang !== lang));
    return a;
  };
}
const slvE = yazBox($('eSlv'), lang => ({
  backLbl: 'назад',
  onPick: (l, m) => { push(curHash(), { k: 'slv', l, m: m || null, lang }); openSheet(history.state.sheet); },
  onBack: () => history.back()
}));
function openSheet(sh) {
  sheetNow = sh; $('etym').scrollTop = 0;
  const slv = sh.k === 'slv';
  $('eBody').classList.toggle('hidden', slv); $('eSlv').classList.toggle('hidden', !slv); $('eHist').classList.toggle('hidden', slv);
  if (slv) { $('eTtl').textContent = 'Словарь'; slvE(sh.lang).show(sh.l, sh.m); }
  else sh.k === 'hist' ? renderHist() : sh.k === 'senses' ? renderSenses(sh.l) : sh.k === 'word' ? renderWord(sh.l) : renderEtym(sh.l);
  $('etym').classList.remove('hidden'); document.body.style.overflow = 'hidden';
}
function closeSheet() { sheetNow = null; $('etym').classList.add('hidden'); document.body.style.overflow = ''; }
/* от 1000 px окно поверх — панель справа (27.11.2026): нажатие на затемнённую часть слева закрывает его, как «назад» */
$('etym').addEventListener('click', e => { if (e.target === $('etym') && e.clientX < $('etym').getBoundingClientRect().left) history.back(); });
$('eHist').onclick = () => { if (!sheetNow || sheetNow.k !== 'hist') { push(curHash(), { k: 'hist' }); openSheet(history.state.sheet); } };
let etymCur = null;  /* чья статья на виду: пока грузится, могли открыть другую */
function headHtml(l, D) {
  const L = lexOf(l) || {}, p = phraseOf(l), forms = formsOf(L, D);
  return `<div class="e-head"><span class="lem">${esc(l)}</span><span>${esc(cap(L.ru || D.dict.senses[0]?.ru || ''))}</span>
      ${forms ? `<span class="el muted">${esc(forms)}</span>` : ''}
      ${p ? `<span class="small muted"><span class="el">${esc(TX(p))}</span></span>` : ''}</div>`;
}
/* box — место под фразой (широкий экран); без него — окно поверх */
const boxOf = (box, ttl) => { if (box) return [box, `<h2>${ttl}</h2>`]; $('eTtl').textContent = ttl; return [$('eBody'), '']; };
/* английский (27.11.2026): «Значения» — статья своего словаря (Slovar.yazyk('en')), тем же видом, что у греческого словаря текста */
const enDict = s => s && { dict: { senses: s.z.map(z => ({ label: z.lb || '', ru: z.ru, ex: (z.ex || []).map(x => ({ el: x.el, ru: x.ru || '' })) })),
  phrases: (s.f || []).map(x => ({ el: x.el, ru: x.ru || '' })), forms: s.f3 ? s.f3.join(' · ') : '' } };
function renderSenses(l, inl) {
  const yaz = (M && M.lang) || G.lang || 'el';
  if (yaz !== 'el' && SLV_YAZ.includes(yaz) && !LEX[l]) {
    const [box, top] = boxOf(inl, 'Значения');
    box.innerHTML = top + `<div class="e-head"><span class="lem">${esc(l)}</span></div><p class="muted">Открываю словарь…</p>`;
    Slovar.yazyk(yaz).statya(l).then(s => { if (s) LEX[l] = enDict(s); renderSenses2(l, inl); }, () => renderSenses2(l, inl));
    return;
  }
  renderSenses2(l, inl);
}
function renderSenses2(l, inl) {
  const D = LEX[l], [box, top] = boxOf(inl, 'Значения');
  if (!D) { box.innerHTML = top + `<div class="e-head"><span class="lem">${esc(l)}</span></div><p class="muted">Статьи пока нет.</p>`; return; }
  box.innerHTML = top + headHtml(l, D) + sensesHtml(D.dict) + `<div class="e-foot"><span>Значения написаны ИИ (Claude) по Викисловарю (CC BY-SA); человеком — не проверено.</span></div>`;
}
/* статья о происхождении — общий вид с «Словарём» (app/slovar.js, etimHtml; файл el/etim-<отп>.txt.gz, tools/etim_telefon.py) */
function renderEtym(l, inl) {
  const [box, top] = boxOf(inl, 'Происхождение'), q = id => box.querySelector('#' + id);
  etymCur = l;
  if (M && M.lang !== 'el') { box.innerHTML = top + `<div class="e-head"><span class="lem">${esc(l)}</span></div><p class="muted">Статей о происхождении для этого языка пока нет.</p>`; return; }
  const draw = e => {
    if (etymCur !== l) return;
    box.innerHTML = top + Slovar.etimHtml(l, e) + (e ? `<div class="e-sec"><button class="link" id="eFlag" style="justify-self:start">Неверно?</button>
      <div id="eFlagBox" class="hidden" style="display:grid;gap:8px"><textarea id="eFlagText" placeholder="Что не так — коротко"></textarea><button class="btn" id="eFlagSave">Сохранить</button></div></div>` : '');
    if (!e) return;
    const flags = read(FKEY) || {};
    if (flags[l]) { q('eFlagText').value = flags[l].text; q('eFlag').textContent = 'Отмечено: неверно — изменить'; }
    q('eFlag').onclick = () => q('eFlagBox').classList.remove('hidden');
    q('eFlagSave').onclick = () => {
      const f = read(FKEY) || {}, t = q('eFlagText').value.trim();
      if (t) f[l] = { text: t, t: new Date().toISOString().slice(0, 16) }; else delete f[l];
      write(FKEY, f); setSynced('flags', f); q('eFlagBox').classList.add('hidden'); q('eFlag').textContent = t ? 'Отмечено: неверно — изменить' : 'Неверно?';
    };
  };
  const e0 = Slovar.etimSync(l);
  if (e0 !== undefined) return draw(e0);
  box.innerHTML = top + '<p class="muted">Открываю статьи о происхождении…</p>';
  Slovar.etim(l).then(draw, err => { if (etymCur === l) box.innerHTML = top + `<p class="muted">${esc(err.message || String(err))}</p>`; });
}
function renderHist() {
  $('eTtl').textContent = 'История';
  const log = read(EKEY) || [], seen = {};
  log.forEach((x, i) => { seen[x.l] = seen[x.l] || { n: 0, t: '', i: 0 }; seen[x.l].n++; if (x.t >= seen[x.l].t) { seen[x.l].t = x.t; seen[x.l].i = i; } });
  const items = Object.keys(seen).sort((a, b) => seen[b].t.localeCompare(seen[a].t) || seen[b].i - seen[a].i);  /* время — до минуты: в одну минуту — по порядку записи */
  $('eBody').innerHTML = `<div class="hist" style="display:grid;gap:8px"><input id="hQ" type="search" placeholder="Поиск" autocomplete="off"><div id="hList"></div></div>`;
  const draw = q => {
    const qq = base(q || '');
    const rows = items.filter(l => !qq || base(l).includes(qq) || base((lexOf(l) || {}).ru || '').includes(qq));
    $('hList').innerHTML = rows.length ? rows.map(l => `<button data-etym="${esc(l)}"><span><span class="el">${esc(l)}</span> <span class="muted small">${esc((lexOf(l) || {}).ru || '')}</span></span><span class="small muted">${esc((Slovar.etimSync(l) || {}).g || '')} · ${seen[l].n} ${plural(seen[l].n, 'раз', 'раза', 'раз')}</span></button>`).join('')
      : `<p class="muted small">${items.length ? 'Ничего не найдено.' : 'Пока пусто: откройте статью долгим нажатием на слово.'}</p>`;
  };
  $('hQ').oninput = e => draw(e.target.value); draw('');
}
/* нажатия внутри карточки и окон — одним слушателем: «Значения» и data-etym открывают своё окно */
document.addEventListener('click', e => {
  const v = e.target.closest('[data-slv]');
  if (v && !v.closest('.slv')) { e.stopPropagation(); push(curHash(), { k: 'slv', l: v.dataset.slv, m: null, lang: v.dataset.lang || 'el' }); openSheet(history.state.sheet); return; }
  const z = e.target.closest('[data-say]');
  if (z) {
    e.stopPropagation();
    const yz = (M && M.lang) || 'el';
    if (SLV_YAZ.includes(yz)) Slovar.yazyk(yz).skazat(z.dataset.say, z);  /* свой голос по запросу (кэш), нет — голос телефона */
    else { const vc = voiceOf(M.lang); if (vc) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(z.dataset.say); u.voice = vc; u.lang = vc.lang; speechSynthesis.speak(u); } }
    return;
  }
  const s = e.target.closest('[data-senses]');
  if (s) { const box = inlineBox(s); if (box) showInline(box, null, b => renderSenses(s.dataset.senses, b)); else { push(curHash(), { k: 'senses', l: s.dataset.senses }); openSheet(history.state.sheet); } return; }
  const a = e.target.closest('[data-etym], [data-ety]');
  if (a && !a.closest('.slv')) { e.stopPropagation(); openEtym(a.dataset.etym || a.dataset.ety, a); }
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
  $('sCnt').textContent = M.blok ? (p.star ? '★ ' : '') + 'с блокировки' : `${sk.i + 1} / ${P.length}`;
  $('sText').innerHTML = wordsHtml(p);
  $('sText').classList.toggle('vh', sk.hide);
  paintEye($('sEye'), sk.hide, 'текст');
  $('sRu').textContent = p.ru;
  $('sGloss').classList.add('hidden');
  $('sLrn').dataset.lrn = sk.i; paintLrn();
  document.querySelectorAll('#sText .w').forEach(e => e.onclick = () => {
    if (sk.hide) return;
    const g = $('sGloss'); g.innerHTML = glossHtml(p.words[+e.dataset.k], p, +e.dataset.k); g.classList.remove('hidden'); pickWord($('sText'), e, p);
  });
  paintSpeed(); paintOwner();
  /* звук — только по «▶»: автозапуска нет (Ваше слово, 5 ноября 2026) */
}
$('sPlay').onclick = () => toggle($('sPlay'), () => playBy($('sPlay'), sk.i, G.rate));
/* свайп влево — следующая карточка, вправо — предыдущая; с последней — к первой и наоборот (по кругу).
   Отметки «пройдено» свайп не ставит — это ✓; «выучено» пропускаются, как и при ✓ */
function onSwipe(el, fn) {
  let st = null;
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    st = e.touches.length === 1 && !e.target.closest('textarea, input') && t.clientX > 20 && t.clientX < innerWidth - 20 ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!st) return; const t = e.changedTouches[0], dx = t.clientX - st.x, dy = t.clientY - st.y, ok = Date.now() - st.t < 800; st = null;
    if (ok && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) fn(dx < 0 ? 1 : -1);
  }, { passive: true });
}
const slideIn = (el, d) => { el.classList.remove('sw-n', 'sw-p'); void el.offsetWidth; el.classList.add(d > 0 ? 'sw-n' : 'sw-p'); };
onSwipe($('skor'), d => {
  if (sk.back) { stop(); return blokBack(); }  /* со фразы с блокировки свайп — назад к блоку */
  stop(); sk.i = nextIdx(sk.i, d); S.skorAt = sk.i; save();
  skorRender(); slideIn(document.querySelector('#skor .pcard'), d);
});
onSwipe($('bt'), d => {
  const K = btPieces(); let c = bt.c;
  for (let k = 0; k < K.length; k++) { c = (c + d + K.length) % K.length; if (!K[c].every(i => skipped(S, P[i].id))) break; }
  S.btI = K[c][0]; S.btAt = Math.max(0, CHUNKS.findIndex(ch => ch.includes(S.btI))); save();
  btOpen(c, true); slideIn(document.querySelector('#bt .card'), d);
});
$('sEye').onclick = () => { sk.hide = !sk.hide; $('sText').classList.toggle('vh', sk.hide); paintEye($('sEye'), sk.hide, 'текст'); if (sk.hide) $('sGloss').classList.add('hidden'); };
$('sDone').onclick = () => {
  stop(); passed(sk.i);
  if (sk.back) return blokBack();  /* фраза с блокировки пройдена — назад к блоку, к следующей его фразе */
  S.skorAt = nextIdx(sk.i, 1); save();
  sk.i = S.skorAt;
  if (blokTurn()) return;
  skorRender(); window.scrollTo(0, 0);
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
      if (w) { const g = l.querySelector('.gloss'); g.innerHTML = glossHtml(p.words[+w.dataset.k], p, +w.dataset.k); g.classList.remove('hidden'); pickWord($('bLines'), w, p); return; }
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
/* тексты и фразы с блокировки языка — для счётчика слов: освоенная фраза с блокировки отдаёт слова так же, как фраза текста */
const langAll = () => [...langTexts(), ...BLOK.filter(b => b.lang === G.lang)];
/* фразы, которым подошёл срок: сначала давние */
function dueList() {
  const today = dayOf(Date.now()).getTime(), out = [];
  langTexts().forEach(m => { const C = cardsOf(stateOf(m)); m.phrases.forEach((p, i) => { const c = C[p.id]; if (c && c.due && c.due <= today) out.push({ id: m.id, i, due: c.due }); }); });
  out.sort((a, b) => a.due - b.due);
  /* фразы с блокировки — 10 % очереди (Ваше слово 27.11.2026), вперемежку: сначала подошедшие по сроку, потом новые
     по порядку тренировки (★, потом 🔊, потом вразброс) */
  const b = blokOf(G.lang), k = Math.ceil(out.length * BLOK_DOLYA);
  if (!b || !k) return out;
  const add = blokOchered(b).slice(0, k).map(i => ({ id: b.id, i, due: 0 }));
  const step = out.length / add.length;
  add.forEach((x, j) => out.splice(Math.round(step * (j + 1)) + j, 0, x));
  return out;
}
/* освоенные фразы и слова: слово освоено, если оно есть в освоенной фразе */
function wordStats() {
  const ok = new Set(), seen = new Set();
  langAll().forEach(m => {
    const C = cardsOf(stateOf(m));
    m.phrases.forEach(p => { const good = C[p.id] && C[p.id].s >= MASTER; (p.lem || p.words.map(w => w.l)).forEach(l => { if (!l) return; seen.add(l); if (good) ok.add(l); }); });
  });
  return { ok: ok.size, okSet: ok, seen };
}

/* --- Фразы с экрана блокировки в тренировке (Ваше слово 27.11.2026) ---
   История с телефона (EK.frazaIst, таблица fraza_istoriya) → свой блок на каждый язык (BLOK, id «blok-<язык>», на полке
   его нет). Порядок тренировки: со звёздочкой (★ в шторке — «хорошая, хочу запомнить»), потом со 🔊, потом прочие
   вразброс (порядок вразброс — постоянный, по отпечатку фразы). Прогресс, журнал и FSRS — обычные, как у текстов:
   освоенная фраза (стабильность ≥ 21 дня) отдаёт слова в счётчик освоенных.
   «Повторение» блока: 10 % от числа его фраз — после каждых n / k пройденных ✓ одна фраза с блокировки (новая или
   подошедшая по сроку); ✓ на ней — назад к блоку. «Проверка»: 10 % очереди (dueList).
   Слова: у фраз текстов — разметка текста (леммы и значения); у примеров словаря — форма → лемма по частотному
   списку (первая тысяча) и слово статьи; прочие слова — формой (статья словаря находит её сама), в счётчик не идут. */
const BLOK_DOLYA = 0.1;
let IST = [];
const fnv = t => { let h = 2166136261; for (const c of t) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
/* фразы блока, которым пора: подошедшие по сроку, потом новые (без карточки) — в порядке тренировки; «выучено» — мимо */
function blokOchered(b, check) {
  const today = dayOf(Date.now()).getTime(), s = stateOf(b), C = cardsOf(s), due = [], nw = [];
  b.phrases.forEach((p, i) => {
    if (skipped(s, p.id)) return;
    const c = C[p.id];
    if (!c) nw.push(i); else if (c.due && c.due <= today) due.push({ i, due: c.due });
  });
  return [...due.sort((x, y) => x.due - y.due).map(x => x.i), ...nw].filter(i => !check || !blokSeen.has(b.phrases[i].id));
}
const blokSeen = new Set();  /* показанные в этом заходе — второй раз не подсовывать */
function blokTurn() {  /* пора ли после этой ✓ фразы блока показать фразу с блокировки; да — показать */
  if (M.blok) return false;
  const b = blokOf(M.lang); if (!b || !b.phrases.length) return false;
  sk.n = (sk.n || 0) + 1;
  const k = Math.max(1, Math.round(P.length * BLOK_DOLYA)), step = Math.max(1, Math.floor(P.length / k));
  if (sk.n % step) return false;
  const i = blokOchered(b).find(j => !blokSeen.has(b.phrases[j].id)); if (i === undefined) return false;
  blokSeen.add(b.phrases[i].id);
  sk.back = { id: M.id, i: sk.i }; setText(b.id, true);
  sk.i = i; skorRender(); window.scrollTo(0, 0); slideIn(document.querySelector('#skor .pcard'), 1);
  return true;
}
function blokBack() {
  const bk = sk.back; sk.back = null; setText(bk.id, true);
  sk.i = bk.i; skorRender(); window.scrollTo(0, 0); slideIn(document.querySelector('#skor .pcard'), 1);
}
/* звук фразы с блокировки: пример словаря — свой файл (el/zvuk-prim/<голос>/<sha8>.mp4), фраза текста — отрезок файла текста */
async function blokSrc(p) {
  const z = p.zv; if (!z) return null;
  if (z.m) {
    const m = LIB.find(x => x.id === z.m); if (!m) return null;
    if (!blobs[m.id]) blobs[m.id] = URL.createObjectURL(await (await EK.content(m.audio.file)).blob());
    return { url: blobs[m.id], at: z.at, dl: z.dl };
  }
  return { url: await nsBlob({ z: z.u }), at: 0, dl: null };
}
function blokPlay(i, rate, done) {
  const tok = seqToken, m = M;
  blokSrc(P[i]).then(src => {
    if (tok !== seqToken || M !== m) return;
    if (!src) { if (voiceOf(m.lang || 'el')) ttsSay(i, rate, done); else stop(); return; }  /* звука нет — голосом телефона */
    const go = () => {
      if (tok !== seqToken || M !== m) return;
      audio.defaultPlaybackRate = audio.playbackRate = rate; audio.preservesPitch = audio.webkitPreservesPitch = true;
      audio.currentTime = src.at; stopAt = src.dl === null ? Infinity : src.at + src.dl; onEnd = done || null;
      const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {});
      raf = requestAnimationFrame(tick); paintOwner();
    };
    if (audio.src !== src.url) { audio.src = src.url; audio.addEventListener('loadedmetadata', go, { once: true }); }
    else audio.readyState >= 1 ? go() : audio.addEventListener('loadedmetadata', go, { once: true });
  }).catch(e => { console.warn('фраза с блокировки: звук', e); if (tok !== seqToken) return; if (voiceOf(m.lang || 'el')) ttsSay(i, rate, done); else stop(); });
}
/* строки истории → фразы блоков */
const F2L = {};  /* язык → форма (без ударений) → лемма, первая тысяча частотного списка */
async function blokF2L(lang) {
  if (F2L[lang]) return F2L[lang];
  const mp = new Map();
  try { (await (await EK.content(lang + '/chastoty.json')).json()).lemmas.forEach(x => [x.lemma, ...(x.forms || [])].forEach(f => mp.has(nsNorm(f)) || mp.set(nsNorm(f), x.lemma))); } catch (e) {}
  return (F2L[lang] = mp);
}
async function blokBuild(rows) {
  const src = new Map();  /* текст фразы → фраза и её текст (на полке) */
  LIB.forEach(m => m.phrases.forEach(p => src.set((m.lang || 'el') + '|' + TX(p), { m, p })));
  for (const b of BLOK) {
    const rs = rows.filter(r => (r.lang || 'el') === b.lang);
    const ord = r => r.zvezda ? 0 : r.zvukov > 0 ? 1 : 2;
    rs.sort((x, y) => ord(x) - ord(y) || (ord(x) < 2 ? String(y.poslednij).localeCompare(String(x.poslednij)) : fnv(x.id) - fnv(y.id)));
    const f2l = rs.length ? await blokF2L(b.lang) : new Map();
    b.lexicon = {};
    b.phrases = rs.map(r => {
      const p = { id: 'b' + r.id, t: r.f, ru: r.ru, at: 0, start: 0, end: 0, star: !!r.zvezda, podp: r.podpis || '' };
      const o = src.get(b.lang + '|' + r.f);
      if (o) {  /* фраза текста: разметка и звук — того текста */
        p.words = o.p.words; p.zv = { m: o.m.id, at: o.p.at, dl: o.p.end - o.p.start }; p.golos = o.m.audio.layer === 'golos';
        o.p.words.forEach(w => { if (w.l && o.m.lexicon[w.l]) b.lexicon[w.l] = o.m.lexicon[w.l]; });
      } else {  /* пример словаря: слова — формами, леммы — что знает частотный список, и слово статьи */
        const head = (r.podpis || '').split(' — ')[0].replace(/^(?:ο|η|το|οι|τα|ο\/η)\s+/, '').trim();
        p.words = (r.f.match(/[\p{L}’']+/gu) || []).map(t => ({ t, l: f2l.get(nsNorm(t)) || t.toLowerCase() }));
        p.lem = [...new Set([head, ...p.words.map(w => f2l.get(nsNorm(w.t))).filter(Boolean)].filter(Boolean))];
        if (head && !b.lexicon[head]) b.lexicon[head] = { ru: (r.podpis || '').split(' — ').slice(1).join(' — ') };
        p.zv = r.ist !== 'teksty' && r.zv ? { u: `${b.lang}/zvuk-prim/athina/${r.zv}.mp4` } : null; p.golos = true;
      }
      return p;
    });
    if (M === b) P = b.phrases;
  }
}
async function blokLoad() {
  IST = EK.frazaIstKesh(); await blokBuild(IST);
  try { IST = await EK.frazaIst(); await blokBuild(IST); } catch (e) { console.warn('фразы с блокировки', e); }
  if (shown('shelf')) renderShelf(); if (shown('fraza')) renderFraza(); paintWok();
}

/* --- экран «Фразы · N» (плитка «Фразы на блокировке» вне Android-приложения; там — родной экран с ★ и 🔊) --- */
const FRS = 'ekmafisi-fraza-novye';  /* порядок: старые сверху (как на телефоне) или новые — на этом устройстве */
function renderFraza() {
  const novye = (() => { try { return localStorage.getItem(FRS) === '1'; } catch (e) { return false; } })();
  const rows = IST.filter(r => (r.lang || 'el') === (G.lang || 'el')).slice().sort((a, b) => String(a.poslednij).localeCompare(String(b.poslednij)) * (novye ? -1 : 1));
  const b = blokOf(G.lang), st = b ? stateOf(b) : null, C = st ? cardsOf(st) : {};
  $('frN').textContent = `Фразы · ${rows.length}`;
  $('frSort').textContent = (novye ? 'новые сверху' : 'старые сверху') + ' ⇅';
  const dt = t => t ? new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '';
  $('frList').innerHTML = rows.length ? rows.map(r => {
    const c = C['b' + r.id], sost = !c ? '' : c.s >= MASTER ? ' · освоена' : ' · в тренировке';
    return `<div class="fr-row"><div class="fr-f el">${r.zvezda ? '<span class="fr-star" aria-label="со звёздочкой">★</span> ' : ''}${esc(r.f)}</div><div>${esc(r.ru)}</div>
      <div class="small muted">${{ el: '🇬🇷', en: '🇬🇧' }[r.lang] || ''} · ${dt(r.poslednij)}${r.pokazov > 1 ? ` · показана ${r.pokazov} ${plural(r.pokazov, 'раз', 'раза', 'раз')}` : ''}${r.zvukov ? ` · 🔊 ${r.zvukov}` : ''}${sost}</div></div>`;
  }).join('') : `<p class="muted">Пока пусто. Фразы приходят с телефона: Android-приложение Экмафиси, «Фраза на экране блокировки» — после первого открытия плитки «Фразы на блокировке» на телефоне.</p>`;
  if (!novye) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));  /* старые сверху — открыть у свежих */
}
$('frSort').onclick = () => { try { localStorage.setItem(FRS, localStorage.getItem(FRS) === '1' ? '0' : '1'); } catch (e) {} renderFraza(); };

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
/* у каждого языка — свой словарь (Slovar.yazyk, 27.11.2026) в своём ящике внутри #slvBox: виден словарь языка полки,
   поиск и открытая статья другого языка остаются на месте до возвращения к нему. Адрес #slovar/<лемма> — у языка полки */
const SLV = {};
const slvLang = () => G.lang === 'en' ? 'en' : 'el';
const slv = (lang = slvLang()) => SLV[lang] || (SLV[lang] = (() => {
  const box = document.createElement('div'); box.dataset.lang = lang; $('slvBox').appendChild(box);
  const api = Slovar.yazyk(lang).mount(box, {
    dve: true,  /* от 1000 px — две панели: список слева, статья справа (27.11.2026) */
    onPick: (l, m) => { push('slovar/' + encodeURIComponent(l) + (m ? '/' + m : '')); api.show(l, m); },
    onBack: () => goBack('slovar')
  });
  return api;
})());
function slvPokaz() {
  const lang = slvLang(), api = slv(lang);
  [...$('slvBox').children].forEach(b => b.classList.toggle('hidden', b.dataset.lang !== lang));
  return api;
}
$('slvOpen').onclick = () => { const a = slvPokaz(); push('slovar'); show('slovar'); a.show(null); a.focus(); a.ready.then(() => shown('slovar') && a.focus()); };

/* --- «Слова»: сверху — сколько освоено; ниже первая тысяча частотных лемм языка (material/<lang>/chastoty) --- */
let FREQ = {};
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
      ${(G.lang || 'el') === 'el' ? `<div class="kr" data-kr="${esc(l)}"${x.forms ? ` data-alt="${esc(x.forms.join(' · '))}"` : ''}></div>`
        : x.forms ? `<span class="el muted">${esc(x.forms.join(' · '))}</span>` : ''}
      ${p ? `<span class="small muted"><span class="el">${esc(TX(p))}</span><br>${esc(p.ru)}</span>` : ''}</div>
    ${D && D.dict.senses.length ? `<div class="gl-links"><button class="link" data-senses="${esc(l)}">Значения</button></div>` : (G.lang || 'el') !== 'el' ? enSlHtml(l, { ru: L.ru, forms: x.forms }) : ''}
    ${(G.lang || 'el') === 'el' ? Slovar.etimRow(l, Slovar.etimSync(l)) : ''}`;
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
  if (EK.guest) return show('shelf');  /* «Собери» — ИИ, только своим */
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

/* --- краткая таблица слова (Slovar.kratko, Ваш ответ 26.11.2026): <div class="kr" data-kr="лемма" [data-head="заголовок"]
   [data-alt="что показать, если таблицы нет"]> заполняется сам, как только появился в странице — в карточке слова текстов,
   в окне слова экрана «Слова», в подсказке «На слух». Таблицы — части по слову (≈ 0,5 МБ), без всего словаря --- */
function krFill(el) {
  el.dataset.krd = '1';
  const alt = () => { if (el.dataset.alt) el.innerHTML = `<span class="${el.dataset.head ? '' : 'el muted'}">${esc(el.dataset.alt)}</span>`; };
  Slovar.kratko(el.dataset.kr).then(h => {
    if (!h) return alt();
    el.innerHTML = (el.dataset.head ? `<span class="lem" lang="el">${esc(el.dataset.head)}</span>` : '') + h;
    krFit(el);
  }, alt);
}
/* таблица шире своего места (крупный шрифт, прилагательное в три рода) — не вбок, а построчно вниз (Ваше слово 27.11.2026):
   строка на столбец — «ед. м.  τελευταίος · τελευταίου · τελευταίο»; ширина вернулась — снова таблица */
function krFit(el) {
  const v = el.querySelector('.kr-v'); if (v) v.outerHTML = el._kr;
  const t = el.querySelector('table.kr'); if (!t) return;
  el._kr = t.outerHTML;
  if (t.offsetWidth <= el.clientWidth + 1) return;
  const rows = [...t.rows], cols = [...rows[0].cells].slice(1).map(c => c.textContent), out = [];
  let grp = '', lines = null;
  const flush = () => { if (lines) cols.forEach((c, j) => out.push(`<p><b lang="ru">${esc([grp, c].filter(Boolean).join(' '))}</b> ${lines[j].map(esc).join(' · ')}</p>`)); lines = null; };
  rows.slice(1).forEach(r => {
    if (r.cells.length - 1 !== cols.length) return;
    const g = r.cells[0].querySelector('span');
    if (g || !lines) { flush(); grp = g ? g.textContent : grp; lines = cols.map(() => []); }
    [...r.cells].slice(1).forEach((c, j) => lines[j].push(c.textContent));
  });
  flush();
  t.outerHTML = `<div class="kr-v" lang="el">${out.join('')}</div>`;
}
addEventListener('resize', () => document.querySelectorAll('[data-krd]').forEach(krFit));
new MutationObserver(() => {
  document.querySelectorAll('[data-kr]:not([data-krd])').forEach(krFill);
  document.querySelectorAll('[data-ensl]:not([data-ensld])').forEach(enFill);
}).observe(document.body, { childList: true, subtree: true });
/* --- английское слово (27.11.2026): <div data-ensl="лемма" data-ru="0|1" data-f3="0|1"> — статья своего словаря
   (Slovar.yazyk('en').statya), если есть: значения (когда в lexicon текста перевода нет, data-ru="0"), транскрипция, три формы
   неправильного глагола (когда их нет в lexicon, data-f3="0") и «Значения» — вся статья. Статьи или словаря нет — пусто:
   карточка как была, из lexicon. Словарь открывается при первом слове (≈ 1–3 МБ на 5 000 статей), дальше из кэша */
const enSlHtml = (l, L) => `<div class="ensl" data-ensl="${esc(l)}" data-ru="${L && L.ru ? 1 : 0}" data-f3="${L && L.forms ? 1 : 0}"></div>`;
function enFill(el) {
  el.dataset.ensld = '1';
  Slovar.yazyk('en').statya(el.dataset.ensl).then(s => {
    if (!s || !el.isConnected) return;
    const h = [];
    if (el.dataset.ru === '0' && s.z.length) h.push(`<div>${esc(cap(s.z.slice(0, 3).map(z => z.ru).join('; ')))}</div>`);
    if (s.i) h.push(`<div class="small muted" lang="en">${esc(s.i)}</div>`);
    if (s.f3 && el.dataset.f3 === '0') h.push(`<div class="el">${esc(s.f3.join(' · '))}</div>`);
    /* слово в заголовке карточки — вся статья словаря окном поверх, как у греческого (28.11.2026); в окне «Слово»
       заголовка-кнопки нет — ссылкой «Значения» */
    const hw = el.parentElement.querySelector('.gl-w');
    if (hw) hw.outerHTML = `<button class="gl-w el" lang="en" data-slv="${esc(s.l)}" data-lang="en">${hw.innerHTML}</button>`;
    else if (!el.parentElement.querySelector(`[data-senses="${CSS.escape(el.dataset.ensl)}"]`)) h.push(`<div class="gl-links"><button class="link" data-senses="${esc(s.l)}">Значения</button></div>`);
    el.innerHTML = h.join('');
  }, () => {});
}

/* --- «На слух» (Ваше задание 26.11.2026): фраза на языке → 1 с → по-русски → 1 с → снова на языке → пауза (G.nsPause, 10–120 с) → следующая.
   На экране — фраза и перевод крупно, звучащая строка подсвечена. Откуда фразы — выбор, запоминается (G.nsSrc):
   «из словаря» — примеры статей со звуком Azure, тот же отбор, что у фразы на блокировке (tools/fraza_nabor.py:
   без служебных слов, от 5 слов, от частых) — el/slovar2-primery.json, звук el/zvuk-prim/<голос>/<z>.mp4; только греческий;
   «из обучения» — фразы начатых текстов полки (есть журнал; не начато ни одного — все тексты полки), звук — отрезок
   файла текста. Русский — Azure ru-RU-DmitryNeural, озвучен заранее (tools/azure_golos.py russkij → el/slovar2-ru.json,
   el/zvuk-prim/ru-dmitry/); не озвучен — голос телефона ru-RU; нет и его — пауза по длине перевода.
   Порядок — вперемешку; экран не гаснет, пока звучит (Wake Lock). Прогресс и цвета не трогает.
   «Только сложные» (G.nsHard, Ваша просьба 26.11): во фразе не меньше трёх слов вне первой тысячи частотного списка
   языка (<язык>/chastoty.json, все формы; ударения не в счёт). Доля: словарь ≈ 21 %, греческие тексты ≈ 40 %, английские ≈ 27 %. */
const NS_REDKIH = 3;
const nsNorm = w => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ς/g, 'σ');
const nsChast = {};  /* язык → Set форм первой тысячи */
async function nsChastoty(lang) {
  if (!nsChast[lang]) {
    const d = await (await EK.content(lang + '/chastoty.json')).json();
    nsChast[lang] = new Set(d.lemmas.flatMap(x => [x.lemma, ...(x.forms || [])]).map(nsNorm));
  }
  return nsChast[lang];
}
const nsRedkih = (t, S) => (t.match(/\p{L}+/gu) || []).filter(w => !S.has(nsNorm(w))).length;
const NS = { list: null, src: null, k: 0, tok: 0, on: false, a: new Audio(), wake: null, prim: null, ru: undefined, urls: new Map() };
NS.a.preload = 'auto';
/* паузы: после фразы 1 с, после перевода 1 с, после повтора — настройкой 10–120 с, шаг 10 (G.nsPause; Ваше слово 26.11.2026:
   «если повторяешь по несколько раз — нужно много времени») */
const nsPause = () => Math.min(120, Math.max(10, +G.nsPause || 10));
const NS_RATES = [1, 0.9, 0.8];  /* скорость речи на языке (G.nsRate); перевод — всегда 1,0 */
const nsRate = () => NS_RATES.includes(+G.nsRate) ? +G.nsRate : 1;
const nsSleep = (ms, tok) => new Promise((ok, no) => setTimeout(() => tok === NS.tok ? ok() : no('stop'), ms));
const nsShuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
/* «из словаря» — у языков со своим словарём (английский — 28.11.2026); файла примеров ещё нет (звук не озвучен) — NS.primNet */
const nsSrcOk = s => s === 'slovar' ? SLV_YAZ.includes(G.lang || 'el') && !(NS.primNet || {})[G.lang || 'el'] : true;
const nsZvKey = p => new URL('slovar/' + p, location.origin + '/').href;  /* кэш звука словаря — общий с экраном «Словарь» (slovar.js) */
async function nsRuIndex() {  /* указатель русской озвучки; нет файла или сети — undefined → null, голос телефона */
  if (NS.ru === undefined) NS.ru = await EK.content('el/slovar2-ru.json', navigator.onLine).then(r => r.ok ? r.json() : null).catch(() => null);
  return NS.ru;
}
async function nsList(src) {
  nsRuIndex();
  const lang = G.lang || 'el';
  if (src === 'slovar') {
    NS.prim = NS.prim || {}; NS.primNet = NS.primNet || {};
    if (!NS.prim[lang]) {
      const r = await EK.content(lang + '/slovar2-primery.json', navigator.onLine).catch(() => null);
      if (r && r.ok) NS.prim[lang] = await r.json();
      else { NS.primNet[lang] = true; return nsList('teksty'); }  /* примеров со звуком у языка пока нет — фразы обучения */
    }
    const P = NS.prim[lang];
    return nsShuffle(P.p.map(x => ({ f: x.f, ru: x.ru, podp: x.l, lem: x.l.split(' — ')[0].replace(/^(?:ο|η|το|οι|τα|ο\/η)\s+/, ''), z: `${lang}/zvuk-prim/${P.g}/${x.z}.mp4` })));
  }
  const all = LIB.filter(onShelf), started = all.filter(m => progOf(m).log.length);
  return nsShuffle((started.length ? started : all).flatMap(m => m.phrases.map(p => ({ f: TX(p), ru: p.ru, podp: TTL(m), m, p }))));
}
async function nsListHard(src) {  /* весь список или только сложные фразы */
  const l = await nsList(src);
  if (!G.nsHard) return l;
  try { const S = await nsChastoty(G.lang || 'el'); return l.filter(x => nsRedkih(x.f, S) >= NS_REDKIH); }
  catch (e) { console.warn('на слух: частоты', e); return l; }  /* без частотного списка — все */
}
async function nsBlob(x) {  /* звук фразы: файл примера словаря или файл текста целиком (отрезок — в nsSay) */
  if (x.m) {
    if (!blobs[x.m.id]) blobs[x.m.id] = URL.createObjectURL(await (await EK.content(x.m.audio.file)).blob());
    return blobs[x.m.id];
  }
  if (NS.urls.has(x.z)) return NS.urls.get(x.z);
  const c = await caches.open('ekmafisi-slovar-zvuk-v1'), k = nsZvKey(x.z);
  let r = await c.match(k);
  if (!r) { r = await EK.remote(x.z); if (!r.ok) throw new Error(r.status); await c.put(k, r.clone()); }
  const url = URL.createObjectURL(await r.blob());
  NS.urls.set(x.z, url);
  if (NS.urls.size > 12) { const [z0, u0] = NS.urls.entries().next().value; NS.urls.delete(z0); URL.revokeObjectURL(u0); }  /* держим последние — память телефона */
  return url;
}
function nsSay(x, tok) {  /* фраза на языке: целый файл примера или отрезок файла текста [at, at + длительность] */
  /* «Голос: телефона» — своя озвучка (примеры словаря, тексты «Кино» и пересказы) голосом телефона; записи блогеров — записью */
  const lang = (x.m && x.m.lang) || 'el';
  if (x.f && telGolos() && (!x.m || x.m.audio.layer === 'golos') && voiceOf(lang)) return nsPhone(x.f, lang, x.rate || nsRate(), tok);
  return nsBlob(x).then(url => new Promise((ok, no) => {
    if (tok !== NS.tok) return no('stop');
    const a = NS.a, rate = x.rate || nsRate();
    if (a.src !== url) a.src = url;
    a.defaultPlaybackRate = a.playbackRate = rate; a.preservesPitch = a.webkitPreservesPitch = true;
    const end = x.p ? x.p.at + (x.p.end - x.p.start) : null;
    let t = 0;
    const fin = () => { clearTimeout(t); a.onended = a.ontimeupdate = null; a.pause(); tok === NS.tok ? ok() : no('stop'); };
    a.onended = fin;
    if (end !== null) a.ontimeupdate = () => { if (a.currentTime >= end) fin(); };
    const go = () => {
      const pr = a.play(); if (pr && pr.catch) pr.catch(() => fin());
      /* запас: timeupdate редок (≈ 4 раза в секунду), rAF спит на погасшем экране */
      if (end !== null) t = setTimeout(fin, ((end - x.p.at) / rate) * 1000 + 300);
    };
    if (x.p) { const seek = () => { a.currentTime = x.p.at; go(); }; a.readyState >= 1 ? seek() : a.addEventListener('loadedmetadata', seek, { once: true }); }
    else { a.currentTime = 0; go(); }
  }));
}
const ruVoice = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []).find(v => /^ru(-|_|$)/i.test(v.lang));
async function nsRu(text, tok) {
  if (telGolos()) return nsRuPhone(text, tok);
  const ri = await nsRuIndex(), z = ri && ri.i[text.split(/\s+/).join(' ').trim()];
  if (tok !== NS.tok) throw 'stop';
  if (z) {
    try { return await nsSay({ z: `el/zvuk-prim/${ri.g}/${z}.mp4`, rate: 1 }, tok); }
    catch (e) { if (e === 'stop') throw e; console.warn('на слух: русский', e); }  /* не скачался — голосом телефона */
  }
  return nsRuPhone(text, tok);
}
const nsRuPhone = (text, tok) => nsPhone(text, 'ru', 1, tok);
function nsPhone(text, lang, rate, tok) {  /* голосом телефона; onend в Chrome на Android бывает не приходит — страховка по длине */
  return new Promise((ok, no) => {
    const fin = () => { clearTimeout(t); tok === NS.tok ? ok() : no('stop'); };
    const v = voiceOf(lang), est = 600 + text.length * 75 / rate;
    let t = setTimeout(fin, v ? est * 2 + 2000 : est);
    if (!v) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = rate;
    u.onend = u.onerror = fin;
    speechSynthesis.speak(u);
  });
}
/* фраза — словами: у фраз текстов слово знает свою лемму (words), у фраз словаря — только форму: статья ищется по форме,
   как в поиске «Словаря». Словарь — греческий; у английского слова не нажимаются */
const NS_GRW = /[\u0370-\u03ff\u1f00-\u1fff]+/g, NS_ENW = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
function nsFHtml(x) {
  const lang = G.lang || 'el';
  if (!SLV_YAZ.includes(lang)) return esc(x.f);
  if (lang !== 'el') {  /* английский (28.11.2026): слово фразы текста — его лемма из words; фразы словаря — форма, статья по поиску */
    const RW = NS_ENW, sp = (t, l) => `<span class="nsw" data-l="${esc(l)}" lang="en">${esc(t)}</span>`;
    if (!x.p) return esc(x.f).replace(RW, w => sp(w, w));
    let h = '', at = 0;
    x.p.words.forEach(w => {
      const pos = x.f.indexOf(w.t, at); if (pos < 0) return;
      h += esc(x.f.slice(at, pos)) + (w.l && /[A-Za-z]/.test(w.t) ? sp(w.t, w.l) : esc(w.t));
      at = pos + w.t.length;
    });
    return h + esc(x.f.slice(at));
  }
  const sp = (t, l) => `<span class="nsw" data-l="${esc(l)}">${esc(t)}</span>`;
  if (!x.p) return esc(x.f).replace(NS_GRW, w => sp(w, w));
  let h = '', at = 0;
  x.p.words.forEach(w => {
    const pos = x.f.indexOf(w.t, at); if (pos < 0) return;
    h += esc(x.f.slice(at, pos)) + (w.l && NS_GRW.test(w.t) ? sp(w.t, w.l) : esc(w.t)); NS_GRW.lastIndex = 0;
    at = pos + w.t.length;
  });
  return h + esc(x.f.slice(at));
}
/* подсказка снизу (Ваш ответ 26.11.2026): у фразы словаря — не значение (оно и так в переводе), а склонение слова статьи —
   три падежа без звательного, у глагола — четыре формы; таблицы нет — «слово — значение», как было. У фразы текста — название */
function nsHintHtml(x) {
  if (x.lem && (G.lang || 'el') === 'el') return `<div class="kr" data-kr="${esc(x.lem)}" data-head="${esc(x.podp.split(' — ')[0])}" data-alt="${esc(x.podp)}"></div>`;
  return `<span>${esc(x.podp || '')}</span>`;
}
function nsPaint() {
  const x = NS.list && NS.list[NS.k], k = x ? NS.list.length + ':' + NS.k + ':' + x.f : '';
  if ($('nsF').dataset.k !== k) {  /* та же фраза — не перерисовывать: подсветка слова и таблица остаются */
    $('nsF').dataset.k = k;
    $('nsF').innerHTML = x ? nsFHtml(x) : ''; $('nsRu').textContent = x ? x.ru : ''; $('nsPodp').innerHTML = x ? nsHintHtml(x) : '';
  }
  $('nsF').lang = G.lang || 'el';
  $('nsPlay').innerHTML = (NS.on ? ICO_PAUSE : ICO_PLAY).replace(/40/g, '34');
  $('nsPlay').setAttribute('aria-label', NS.on ? 'Пауза' : 'Слушать');
  nsBar();
}
const nsMark = w => { $('nsF').classList.toggle('on', w === 'f'); $('nsRu').classList.toggle('on', w === 'ru'); };
async function nsWake(on) {
  try {
    if (on && !NS.wake && navigator.wakeLock) { NS.wake = await navigator.wakeLock.request('screen'); NS.wake.onrelease = () => { NS.wake = null; }; }
    if (!on && NS.wake) { await NS.wake.release(); NS.wake = null; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && NS.on) nsWake(true); });
async function nsLoop() {
  const tok = ++NS.tok; NS.on = true; nsPaint(); nsWake(true); $('nsMsg').textContent = '';
  try {
    while (tok === NS.tok) {
      const x = NS.list[NS.k]; nsPaint();
      nsMark('f'); await nsSay(x, tok); nsMark(''); await nsSleep(1000, tok);
      nsMark('ru'); await nsRu(x.ru, tok); nsMark(''); await nsSleep(1000, tok);
      nsMark('f'); await nsSay(x, tok); nsMark(''); await nsSleep(nsPause() * 1000, tok);
      NS.k = (NS.k + 1) % NS.list.length;
    }
  } catch (e) {
    if (e === 'stop') return;
    console.warn('на слух:', e);
    $('nsMsg').textContent = navigator.onLine ? 'Звук не загрузился — нажмите ▶ ещё раз.' : 'Нет сети: звук этой фразы ещё не загружался.';
    nsStop();
  }
}
function nsStop() {
  NS.tok++; NS.on = false; NS.a.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
  nsWake(false); nsMark(''); if (shown('nasluh')) nsPaint();
}
async function nsSetSrc(src) {
  nsStop(); NS.src = src; NS.k = 0; NS.list = null; nsPaint();
  $('nsMsg').textContent = 'Загружаю…';
  try { NS.list = await nsListHard(src); }
  catch (e) { console.warn('на слух:', e); $('nsMsg').textContent = navigator.onLine ? 'Фразы не загрузились.' : 'Нет сети: фразы словаря ещё не загружались.'; return; }
  if (NS.src !== src) return;
  $('nsMsg').textContent = NS.list.length ? '' : 'Фраз нет.';
  nsPaint();
}
function nsOpen() {
  const want = nsSrcOk(G.nsSrc) ? G.nsSrc || 'slovar' : 'teksty', src = nsSrcOk(want) ? want : 'teksty';
  if (NS.src !== src || !NS.list || NS.lang !== G.lang) { NS.lang = G.lang; nsSetSrc(src); } else nsPaint();
}
$('nsOpen').onclick = () => { push('nasluh'); show('nasluh'); };
$('nsPlay').onclick = () => { if (NS.on) nsStop(); else if (NS.list && NS.list.length) nsLoop(); };
function nsGo(d) {  /* следующая (+1) или предыдущая (−1) фраза; играло — играет дальше с неё */
  if (!NS.list || !NS.list.length) return;
  const was = NS.on; nsStop(); NS.k = (NS.k + d + NS.list.length) % NS.list.length; nsPaint(); if (was) nsLoop();
}
$('nsNext').onclick = () => nsGo(1);

/* нижняя строка (Ваше слово 26.11.2026): скорость · откуда фразы · сложность · пауза — значок со значением; нажатие — окошко
   выбора над строкой, нажатие мимо — закрыть */
const NB = {
  rate: { t: 'Скорость речи на языке', v: () => nsRate().toFixed(1).replace('.', ',') + '×',
    o: () => NS_RATES.map(r => [r, r.toFixed(1).replace('.', ',')]), cur: () => nsRate(), set: v => { G.nsRate = v; } },
  src: { t: 'Фразы', v: () => NS.src === 'slovar' ? 'словарь' : 'тексты',
    o: () => [['slovar', 'из словаря'], ['teksty', 'из обучения']], cur: () => NS.src, off: v => !nsSrcOk(v),
    set: v => { if (v === NS.src) return; G.nsSrc = v; nsSetSrc(v); } },
  hard: { t: 'Только сложные', v: () => 'сложные',
    o: () => [[false, 'обычные'], [true, 'только сложные']], cur: () => !!G.nsHard, set: v => { if (v === !!G.nsHard) return; G.nsHard = v; nsSetSrc(NS.src); } },
  pause: { t: 'Пауза после повтора', v: () => nsPause() + ' с' }
};
function nsBar() {
  document.querySelectorAll('.nsbar .nb').forEach(b => { b.querySelector('b').textContent = NB[b.dataset.nb].v(); });
  document.querySelector('.nsbar [data-nb="hard"]').setAttribute('aria-pressed', String(!!G.nsHard));
}
function nsPopClose() { $('nsPop').classList.add('hidden'); document.querySelectorAll('.nsbar .nb').forEach(b => b.setAttribute('aria-expanded', 'false')); }
function nsPopOpen(b) {
  const k = b.dataset.nb, d = NB[k], pop = $('nsPop'), was = b.getAttribute('aria-expanded') === 'true';
  nsPopClose(); if (was) return;
  b.setAttribute('aria-expanded', 'true');
  pop.setAttribute('aria-label', d.t);
  if (k === 'pause') {
    pop.innerHTML = `<h3>${d.t}</h3><div class="pv"><input type="range" min="10" max="120" step="10" value="${nsPause()}" aria-label="${d.t}"><b></b></div>`;
    const r = pop.querySelector('input'), out = pop.querySelector('b');
    const put = () => { G.nsPause = +r.value; out.textContent = r.value + ' с'; nsBar(); };
    r.oninput = put; r.onchange = () => { put(); saveG(); }; put();
  } else {
    pop.innerHTML = `<h3>${d.t}</h3><div class="seg" role="group">${d.o().map(([v, t], i) => `<button data-i="${i}" aria-pressed="${v === d.cur()}"${d.off && d.off(v) ? ' disabled' : ''}>${t}</button>`).join('')}</div>`;
    pop.querySelectorAll('button').forEach(x => x.onclick = () => { d.set(d.o()[+x.dataset.i][0]); saveG(); nsBar(); nsPopClose(); });
  }
  pop.classList.remove('hidden');
  const r = b.getBoundingClientRect(), w = pop.offsetWidth;
  pop.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
}
/* «сложные» — просто переключатель, без окошка (Ваше слово 27.11.2026): нажал — гора синяя, только сложные; ещё раз — все */
document.querySelectorAll('.nsbar .nb').forEach(b => b.onclick = e => {
  e.stopPropagation();
  if (b.dataset.nb !== 'hard') return nsPopOpen(b);
  nsPopClose(); NB.hard.set(!G.nsHard); saveG(); nsBar();
});
document.addEventListener('click', e => { if (!e.target.closest('#nsPop, .nsbar')) nsPopClose(); });

/* слово фразы (Ваше слово 26.11.2026): нажать — статья словаря в этом же окне (фраза уезжает вверх, перевод уходит, ниже —
   статья целиком), подержать — происхождение тем же путём; второе нажатие в любом месте фразы — назад к исходному виду.
   Каждое открытие — шаг истории (sheet { k: 'nsd' }): системное «назад» и «← к фразе» идут на шаг выше. Пока открыт словарь,
   звук стоит; вернулись — играет дальше, если играл */
const nsDictApi = yazBox($('nsDict'), lang => ({
  backLbl: 'к фразе',
  onPick: (l, m) => { push('nasluh', { k: 'nsd', l, m: m || null, lang }); nsDictApi(lang).show(l, m); },
  onBack: () => history.back()
}));
function nsDictOpen(l, m) {
  if (!$('nasluh').classList.contains('dict')) NS.d0 = depth();
  const lang = G.lang || 'el';
  if (lang !== 'el' && m === 'etym') m = null;  /* происхождения у английского пока нет (бэклог 28.11.2026) — долгое касание = статья */
  if (m === 'etym' && Slovar.etimSync(l)) Slovar.etimZapis(l);
  push('nasluh', { k: 'nsd', l, m: m || null, lang }); nsDict(history.state.sheet);
}
function nsDictClose() {
  const n = depth() - (NS.d0 ?? depth());
  if (n > 0) history.go(-n);
  else { history.replaceState({ d: depth(), sheet: null }, '', location.href); nsDict(null); }
}
function nsDict(sh) {
  const box = $('nasluh'), on = !!sh && shown('nasluh');
  if (on) {
    if (!box.classList.contains('dict')) { NS.wasOn = NS.on; nsStop(); nsPopClose(); }
    box.classList.add('dict'); $('nsDict').classList.remove('hidden');
    nsDictApi(sh.lang).show(sh.l, sh.m);
    $('nsF').querySelectorAll('.nsw').forEach(w => w.classList.toggle('sel', w.dataset.l === sh.l));
  } else if (box.classList.contains('dict')) {
    box.classList.remove('dict'); $('nsDict').classList.add('hidden');
    $('nsF').querySelectorAll('.nsw.sel').forEach(w => w.classList.remove('sel'));
    window.scrollTo(0, 0);
    if (NS.wasOn && shown('nasluh')) { NS.wasOn = false; nsLoop(); }
  }
  NS.wasOn = on ? NS.wasOn : false;
}
/* касания фразы: долгое на слове — происхождение; сдвиг пальца вбок — свайп (влево — следующая, вправо — предыдущая) */
let nsT = null;
$('nsCard').addEventListener('pointerdown', e => {
  if (e.button > 0) return;
  const w = !$('nasluh').classList.contains('dict') && e.target.closest('.nsw');
  if (w) w.classList.add('hold');
  nsT = { x: e.clientX, y: e.clientY, w, fired: false, swipe: false, t: w ? setTimeout(() => {
    nsT.fired = true; w.classList.remove('hold'); nsDictOpen(w.dataset.l, 'etym');
  }, 450) : 0 };
});
$('nsCard').addEventListener('pointermove', e => {
  if (!nsT || nsT.fired) return;
  if (Math.hypot(e.clientX - nsT.x, e.clientY - nsT.y) > 10) { clearTimeout(nsT.t); if (nsT.w) nsT.w.classList.remove('hold'); }
});
const nsUp = e => {
  if (!nsT) return;
  clearTimeout(nsT.t); if (nsT.w) nsT.w.classList.remove('hold');
  const dx = e.clientX - nsT.x, dy = e.clientY - nsT.y;
  if (!nsT.fired && e.type === 'pointerup' && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && !$('nasluh').classList.contains('dict')) {
    nsT.swipe = true; nsGo(dx < 0 ? 1 : -1);
  }
  const t0 = nsT; setTimeout(() => { if (nsT === t0) nsT = null; }, 350);  /* ближайший click — глотаем, если это был свайп или долгое */
};
$('nsCard').addEventListener('pointerup', nsUp);
$('nsCard').addEventListener('pointercancel', nsUp);
$('nsCard').addEventListener('contextmenu', e => { if (e.target.closest('.nsw')) e.preventDefault(); });
$('nsF').addEventListener('click', e => {
  if (nsT && (nsT.fired || nsT.swipe)) { nsT = null; return; }
  if ($('nasluh').classList.contains('dict')) { nsDictClose(); return; }
  const w = e.target.closest('.nsw'); if (w) nsDictOpen(w.dataset.l, null);
});

/* --- тема: светлая · тёмная (26.11.2026 — без «как в системе»; не выбрана — пока как в системе, первое нажатие выбирает) --- */
const THEMES = { light: 'светлая', dark: 'тёмная' };
const themeNow = () => THEMES[G.theme] ? G.theme : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function paintTheme() {
  const t = themeNow();
  document.documentElement.dataset.theme = t;
  const svg = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  $('theme').innerHTML = svg({
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
  }[t]);
  $('theme').setAttribute('aria-label', 'Тема: ' + THEMES[t]);
  /* строка состояния (Chrome, установленная PWA) — цвета фона выбранной темы, а не только системной */
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach(x => { x.content = paper; x.removeAttribute('media'); });
  if (shown('settings')) renderSettings();
}
$('theme').onclick = () => { G.theme = themeNow() === 'dark' ? 'light' : 'dark'; saveG(); paintTheme(); };
paintTheme();

/* --- подтянутое с сервера: по фразе — позднее изменение; журнал — по id; настройки — по ключу --- */
EK.onRemote = ({ progress, log, settings }) => {
  const byId = Object.fromEntries([...LIB, ...BLOK].map(m => [m.id, m]));
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
    else if (k === 'izbr') write('ekmafisi.izbr', r.v || []);  /* → ekmafisi.<id>.izbr, избранные слова словаря (app/slovar.js) */
    else if (k === 'izbr-en') write('ekmafisi.izbr-en', r.v || []);  /* английский словарь — свой список (27.11.2026) */
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
EK.onStatus = st => { $('acctSync').textContent = EK.guest ? 'прогресс хранится только на этом устройстве' : SYNC_LBL[st] ? '· ' + SYNC_LBL[st]() : ''; };
/* гость: не входил — «Войти через Google»; вошёл, но адреса нет в списке — адрес и «Выйти» */
$('acctWho').textContent = !EK.guest ? EK.email || '' : EK.email ? `${EK.email} — адреса нет в списке своих` : 'Без входа';
$('signOut').textContent = EK.guest && !EK.email ? 'Войти через Google' : 'Выйти';
$('signOut').onclick = () => {
  if (!(EK.guest && !EK.email)) return EK.signOut();
  $('signOut').disabled = true;
  EK.signIn().catch(e => { $('signOut').disabled = false; $('signInErr').textContent = 'Не вышло: ' + e.message; });
};
EK.onStatus(EK.status || (navigator.onLine ? '' : 'offline'));

/* --- верхняя строка: на всех экранах; прокрутка вниз — уезжает, вверх — возвращается --- */
let topY = 0;
$('top').classList.remove('hidden'); document.body.classList.add('has-top');
addEventListener('scroll', () => {
  const y = scrollY, d = y - topY;
  if (Math.abs(d) < 8 && y > 0) return;  /* дрожь пальца — не в счёт */
  $('top').classList.toggle('away', d > 0 && y > 60);
  topY = y;
}, { passive: true });
/* домик — на полку: шаги истории назад до неё (системное «назад» потом не вернёт в занятие) */
$('goHome').onclick = () => { const n = depth(); if (n > 0) history.go(-n); else { history.replaceState({ d: 0, sheet: null }, '', urlOf('')); applyLoc(); } };

/* --- вход: ссылка прямо на текст или режим (#id, #id-skor) — достраиваем шаги назад: полка ← текст ← режим --- */
if (!history.state || history.state.d === undefined) {
  const t = parseHash(curHash());
  history.replaceState({ d: 0, sheet: null }, '', urlOf(''));
  if (t.v !== 'shelf') push(t.id);
  if (MODES.includes(t.v)) push(t.id + '-' + t.v);
}
applyLoc(true);
EK.sync();
blokLoad();  /* фразы с блокировки: из кэша сразу, с сервера — следом */
if (isAndr() && !EK.guest) EK.frazaKluch().then(k => { FK = k; if (shown('shelf')) renderShelf(); if (shown('settings')) renderSettings(); });
/* статьи о происхождении — в фоне: строка «Происхождение ›» в карточке слова и долгое нажатие без ожидания (≈ 1,7 МБ один раз) */
if (LIB.some(m => (m.lang || 'el') === 'el')) setTimeout(() => Slovar.etimLoad().catch(e => console.warn('этимология:', e)), 1500);  /* подтянуть с сервера то, что изменилось на других устройствах */

