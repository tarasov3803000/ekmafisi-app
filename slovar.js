/* Словарь — общий модуль экрана «Словарь» в Экмафиси и отдельного приложения «Словарь» (slovar-app/).
   Данные: весь свой словарь из закрытого хранилища, формат 2 (tools/slovar_telefon.py, 17.11.2026):
     el/slovar2.json — версия { index, stati, gzI, gzS, tablicy… }: из кэша сразу, со связью — в фоне после открытия;
       проверяется ещё при каждом возврате в приложение и раз в три часа; новое скачивается в фоне, тихо, и вступает
       со следующего открытия слова — без перезапуска и без сообщений (решение 18.11.2026, tools/vykladka.py);
     el/slovar2-i-<отп>.bin.gz — указатель поиска, готовый (ключи по порядку байтов, номера — Uint32), и строки списка;
     el/slovar2-s-<отп>.txt.gz — статьи, по одной в строке. Это основа: качается целиком, редко;
     el/slovar2-p-<отп>.bin.gz — поправка: статьи, изменённые, новые и удалённые с основы, тем же форматом в одном файле
       (маленькая, при каждой выкладке). Номера статей поправки — после основы (D.n + j); статьи основы, которые она
       заменяет или удаляет (X), поиск пропускает; место «по частоте» — между соседями основы (O).
   Оба — один раз, распаковка DecompressionStream, распакованными в свой кэш. Открытие — только чтение байтов из кэша:
   ни JSON.parse всего словаря, ни построения указателя (было 1,5 с на телефоне); статья разбирается, когда открыта.
   Поэтому и Web Worker не понадобился: разбирать в нём нечего. Замер по шагам — Slovar.zamer (видно в шестерёнке «Словаря»).
   Поиск: греческий без ударений и по всем формам; латиница (транслитерация); русский — по словам значений вне скобок.
   Звук слова и примера: голос Azure — озвученный заранее (el/zvuk-slov/<голос>/<a>.mp4, el/zvuk-prim/<голос>/<a>.mp4),
   иначе по запросу через функцию golos (el/zvuk-zapros/<голос>/<sha16>.mp3); всё — в кэш при первом нажатии.
   Нет сети, предел месяца или отказ — голос телефона el-GR.
   Происхождение слова: el/etim.json → el/etim-<отп>.txt.gz (tools/etim_telefon.py) — свой файл и кэш; в статье — строка
   «Происхождение ›», долгое нажатие на слово — его статья (#<лемма>/etym). Экмафиси берёт то же: etimLoad, etimHtml, etimRow.
   Хост даёт: EK.remote(путь) → fetch-ответ из хранилища; переходы — onPick(lemma) и onBack(); показ — api.show(lemma | null). */
(() => {
  const CACHE = 'ekmafisi-slovar-v1', ZCACHE = 'ekmafisi-slovar-zvuk-v1', PTR = 'el/slovar2.json', RECENT = 'ekmafisi.slovar.nedavno';
  const RECENT2 = 'ekmafisi.slovar.nedavno2';  /* недавние со строкой списка { l, s, b } — видны, пока словарь открывается */
  const SKOR = 'slovar-skorost';  /* скорость голоса 0,8 · 0,9 · 1 (решение 17.11.2026: по умолчанию 0,9), общая с Экмафиси */
  const ckey = p => new URL('slovar/' + p, location.origin + '/').href;  /* ключ кэша — один на оба приложения (один адрес github.io) */
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = n => Number(n).toLocaleString('ru-RU');
  const gr = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ');
  const ru = s => s.toLowerCase().replace(/ё/g, 'е');
  const lat = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const isGr = s => /[Ͱ-Ͽἀ-῿]/.test(s), isRu = s => /[а-яё]/i.test(s);
  /* запрос: знаки по краям долой (диктовка ставит точку), в том числе греческие ; и · */
  const chist = q => q.replace(/^[\s.,;:!?«»"'()…·\u037e\u0387\u2019\u2018\u201c\u201d-]+|[\s.,;:!?«»"'()…·\u037e\u0387\u2019\u2018\u201c\u201d-]+$/g, '');
  /* составные формы: θα πάμε, να πάω, έχω πάει — ищется смысловая часть */
  const AUX = new Set('θα να ας δεν μην μη έχω έχεις έχει έχουμε έχετε έχουν έχουνε είχα είχες είχε είχαμε είχατε είχαν είχανε'.split(' ').map(w => w.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ς/g, 'σ')));
  const STOP = new Set('и в во на с со к ко о об от по для из за у при до под над без про как что кто то или а но не ни же ли бы кого чего кому чему кем чем ком нибудь либо т п д др'.split(' '));
  const SRC = { opensubtitles: 'субтитры', tatoeba: 'tatoeba' };
  const readJ = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };

  /* --- данные --- */
  const enc = new TextEncoder(), dec = new TextDecoder();
  const zamer = {};  /* замер по шагам, мс от начала страницы: ptr — версия, i — указатель поиска прочитан, ready — поиск готов, s — статьи */
  const mark = k => { zamer[k] = Math.round(performance.now()); };
  let D = null, loading = null;
  async function pointer(c) {  /* версия словаря: из кэша сразу; нет — со связью (в кэш ляжет, когда оба файла скачаны) */
    const hit = await c.match(ckey(PTR));
    if (hit) return hit.json();
    if (!navigator.onLine) throw new Error('Нет сети, а словарь на этом телефоне ещё не загружался. Откройте один раз со связью.');
    const r = await EK.remote(PTR);
    if (!r.ok) throw new Error('Словарь не загрузился. Попробуйте ещё раз.');
    return r.json();
  }
  const raspak = path => path.replace(/\.gz$/, '');
  async function fayl(c, path, got) {  /* распакованный файл: из кэша; нет — со связью, распаковка потоком прямо в кэш */
    const k = ckey(raspak(path));
    let hit = await c.match(k);
    if (!hit) {
      const r = await EK.remote(path);
      if (!r.ok) throw new Error('Словарь не загрузился: ' + r.status);
      const count = new TransformStream({ transform(ch, ctl) { got && got(ch.byteLength); ctl.enqueue(ch); } });
      await c.put(k, new Response(r.body.pipeThrough(count).pipeThrough(new DecompressionStream('gzip'))));
      hit = await c.match(k);
    }
    return hit;
  }
  /* указатель поиска — как есть, байтами: заголовок JSON и части по 4 байта (tools/slovar_telefon.py, dvoichnyj) */
  function razobrat(buf, p) {
    const hl = new DataView(buf).getUint32(0, true), h = JSON.parse(dec.decode(new Uint8Array(buf, 4, hl))), base = 4 + hl;
    const u8 = n => new Uint8Array(buf, base + h.sec[n][0], h.sec[n][1]), u32 = n => new Uint32Array(buf, base + h.sec[n][0], h.sec[n][1] / 4);
    const ix = n => ({ K: u8(n + 'K'), Ko: u32(n + 'Ko'), Po: u32(n + 'Po'), P: u32(n + 'P') });
    const d = { n: h.n, zvuk: h.zvuk, zvukP: h.zvukP, golos: h.golos || 'athina', ptr: p, g: ix('g'), ru: ix('ru'), la: ix('la'),
      rB: u8('rB'), rO: u32('rO'), sO: u32('sO'), s: null, sP: null, art: new Map(), pp: null };
    if (h.sec.S) Object.assign(d, { s: u8('S'), O: u32('O'), X: new Set(u32('X')) });  /* поправка: статьи — тут же */
    return d;
  }
  /* основа и поправка: из кэша, а нет — со связью; статьи основы — следом, поиск их не ждёт */
  async function otkryt(c, p, prog, zam) {  /* zam — замер открытия (фоновое обновление его не трогает) */
    const sP = fayl(c, p.stati, prog), pP = p.popravka ? fayl(c, p.popravka).then(r => r.arrayBuffer()) : null;
    const buf = await (await fayl(c, p.index, prog)).arrayBuffer(); zam && mark('i');
    const d = razobrat(buf, p);
    if (pP) d.pp = razobrat(await pP, p);
    d.sP = sP.then(r => r.arrayBuffer()).then(b => { d.s = new Uint8Array(b); zam && mark('s'); return d.s; });
    return d;
  }
  function load(onProgress) {
    if (D) return Promise.resolve(D);
    return loading || (loading = (async () => {
      const c = await caches.open(CACHE), p = await pointer(c); mark('ptr');
      let got = 0; const prog = n => { got += n; onProgress && onProgress(got / ((p.gzI + p.gzS) || 2.3e7)); };
      D = await otkryt(c, p, prog, true); mark('ready');
      D.sP.then(async () => {
        await c.put(ckey(PTR), new Response(JSON.stringify(p)));  /* версия — в кэш, когда все файлы там */
        console.info('slovar: открыт, мс от начала страницы', JSON.stringify(zamer));
        await uborka(c, p);
        if (navigator.onLine) { proverit(); setTimeout(() => tbVse().catch(() => {}), 1500); }  /* таблицы — в фоне: без сети они тоже нужны */
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') proverit(); });
        setInterval(() => { if (document.visibilityState === 'visible') proverit(); }, 3 * 3600e3);
      }).catch(e => console.warn('slovar: статьи', e));
      return D;
    })().catch(e => { loading = null; D = null; throw e; }));
  }
  /* новая версия словаря — в фоне, тихо: при открытии, при каждом возврате в приложение (не чаще раза в 5 минут) и раз
     в три часа. Изменилась только поправка — качается она одна (килобайты-мегабайты), основа — целиком (редко).
     Скачанное подменяет словарь сразу: следующее открытое слово и следующий поиск — уже по новой версии */
  let checking = null, checked = 0;
  function proverit(sejchas) {
    if (!D || checking || !navigator.onLine || (!sejchas && Date.now() - checked < 5 * 60e3)) return checking;
    return checking = (async () => {
      try {
        const r = await EK.remote(PTR); if (!r.ok) return;
        const n = await r.json(), p = D.ptr;
        checked = Date.now();
        if (n.index === p.index && n.stati === p.stati && (n.popravka || '') === (p.popravka || '') && String(n.tablicyF) === String(p.tablicyF)) return;
        const c = await caches.open(CACHE), d = await otkryt(c, n);
        await d.sP;
        await c.put(ckey(PTR), new Response(JSON.stringify(n)));
        if (String(n.tablicyF) !== String(p.tablicyF)) { TB.clear(); tbLoading.clear(); }
        D = d;
        await uborka(c, n);
        tbVse().catch(() => {});
        console.info('slovar: новая версия —', n.index, n.popravka || 'без поправки', `(${n.popravkaN || 0} статей)`);
        window.dispatchEvent(new Event('slovar-novoe'));
      } catch (e) { console.warn('slovar: обновление', e); } finally { checking = null; }
    })();
  }
  /* в кэше — только нынешние файлы (и уже скачанной новой версии): прошлый словарь на телефоне не копится */
  async function uborka(c, p) {
    const hit = await c.match(ckey(PTR)), q = hit ? await hit.json().catch(() => null) : null;
    for (const r of await c.keys()) if (!nuzhen(r.url, [p, q])) c.delete(r);
  }
  const nuzhen = (url, ps) => url === ckey(PTR) || ps.some(p => p && p.index && [p.index, p.stati, p.popravka, ...(p.tablicyF || [])]
    .some(f => f && url === ckey(raspak(f)) || f && url === ckey(f) && /tablicy-/.test(f)));
  /* номер статьи: основа — 0…D.n−1, поправка — D.n + j */
  const src = i => i < D.n ? [D, i] : [D.pp, i - D.n];
  const ubrana = i => i < D.n && !!D.pp && D.pp.X.has(i);  /* статья основы, которую поправка заменила или удалила */
  const rk = i => i < D.n ? i : D.pp.O[i - D.n] - 1 + (i - D.n + 1) / (D.pp.n + 1);  /* место по частоте */
  const byRk = (a, b) => rk(a) - rk(b);
  /* строка списка: лемма, заголовок, значения — из указателя, без разбора статьи */
  function row(i) {
    const [d, j] = src(i);
    const t = dec.decode(d.rB.subarray(d.rO[j], d.rO[j + 1])), a = t.indexOf('\t'), b = t.indexOf('\t', a + 1);
    return { l: t.slice(0, a), s: t.slice(a + 1, b), z: t.slice(b + 1).split('\x1f') };
  }
  const brief = z => z.slice(0, 3).join('; ');
  function by(l) {  /* лемма → номер: заголовок всегда есть среди греческих ключей */
    for (const i of exactAll('g', gr(l))) if (row(i).l === l) return i;
    return undefined;
  }
  async function stat(i) {  /* статья целиком — разбирается при открытии; статьи ещё читаются — подождать */
    const d0 = D;
    if (d0.art.has(i)) return d0.art.get(i);
    const [d, j] = src(i), s = d.s || await d.sP;
    const x = JSON.parse(dec.decode(s.subarray(d.sO[j], d.sO[j + 1] - 1)));
    if (d0.art.size > 50) d0.art.delete(d0.art.keys().next().value);
    d0.art.set(i, x); return x;
  }
  /* самые частые k статей — с поправкой */
  function chastye(k) {
    const out = [];
    for (let i = 0; i < D.n && out.length < k; i++) if (!ubrana(i)) out.push(i);
    if (D.pp) for (let j = 0; j < D.pp.n; j++) if (D.pp.O[j] <= k) out.push(D.n + j);
    return out.sort(byRk).slice(0, k);
  }
  /* таблицы спряжения и склонения — 16 частей по слову (tools/slovar_telefon.py): разбирается только часть открытого
     слова (весь файл — 86 МБ JSON, телефону тяжело), все части — в фоне в кэш, сжатыми: без сети тоже работают */
  const TB = new Map(), tbLoading = new Map();
  const tbPart = l => [...l].reduce((a, ch) => a + ch.codePointAt(0), 0) % D.ptr.tablicyN;  /* то же — chast_tablic в tools/slovar_telefon.py */
  const tbFile = i => D.ptr.tablicyF ? D.ptr.tablicyF[i] : `${D.ptr.tablicy}-${String(i).padStart(2, '0')}.json.gz`;  /* у части — свой отпечаток */
  async function tbGz(i) {  /* сжатая часть: из кэша, а нет — со связью и в кэш */
    const c = await caches.open(CACHE), k = ckey(tbFile(i));
    let hit = await c.match(k);
    if (!hit) {
      const r = await EK.remote(tbFile(i));
      if (!r.ok) throw new Error('Таблицы не загрузились: ' + r.status);
      await c.put(k, new Response(await r.blob(), { headers: { 'Content-Type': 'application/gzip' } }));
      hit = await c.match(k);
    }
    return hit;
  }
  function tablicy(l) {  /* → блоки таблиц слова или null */
    if (!D || !(D.ptr.tablicyF || D.ptr.tablicy) || !D.ptr.tablicyN) return Promise.reject(new Error('нет таблиц'));
    const i = tbPart(l);
    if (TB.has(i)) return Promise.resolve(TB.get(i)[l] || null);
    if (!tbLoading.has(i)) tbLoading.set(i, tbGz(i).then(r => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json())
      .then(o => { TB.set(i, o); tbLoading.delete(i); if (TB.size > 3) TB.delete(TB.keys().next().value); return o; },  /* в памяти — три последние части */
        e => { tbLoading.delete(i); throw e; }));
    return tbLoading.get(i).then(o => o[l] || null);
  }
  const tbSync = l => { const i = tbPart(l); return TB.has(i) ? (TB.get(i)[l] || null) : undefined; };
  async function tbVse() { for (let i = 0; i < (D.ptr.tablicyN || 0); i++) await tbGz(i); }

  /* --- происхождение слова (tools/etim_telefon.py, решение 24.11.2026): el/etim.json → el/etim-<отп>.txt.gz, строки
     «лемма \t JSON». Отдельно от словаря: свой указатель, свой кэш, качается целиком один раз (≈ 1,7 МБ), без сети работает.
     Открытие — пробег по байтам за строками (лемма → [начало, конец]), статья разбирается, когда открыта.
     Новая версия — как у словаря: при первом обращении, при возврате в приложение (не чаще раза в 5 минут); подменяет сразу.
     Экмафиси зовёт etimLoad() сам, без словаря: строке «Происхождение ›» в карточке слова словарь на 24 МБ не нужен. */
  const ECACHE = 'ekmafisi-etim-v1', EPTR = 'el/etim.json';
  let E = null, eLoading = null, eChecking = null, eChecked = 0, eListen = false;
  function eRazobrat(buf, p) {
    const u8 = new Uint8Array(buf), ix = new Map(), bx = new Map();
    for (let a = 0, i = 0; i < u8.length; i++) if (u8[i] === 10) {
      let t = a; while (t < i && u8[t] !== 9) t++;
      const l = dec.decode(u8.subarray(a, t)); ix.set(l, [t + 1, i]);
      const b = gr(l); if (!bx.has(b)) bx.set(b, l);
      a = i + 1;
    }
    return { p, u8, ix, bx, art: new Map() };
  }
  async function eOtkryt(c, p) { const r = await fayl(c, p.etim); return eRazobrat(await r.arrayBuffer(), p); }
  async function eUborka(c, p) { for (const r of await c.keys()) if (r.url !== ckey(EPTR) && r.url !== ckey(raspak(p.etim))) c.delete(r); }
  function etimLoad() {
    if (E) return Promise.resolve(E);
    return eLoading || (eLoading = (async () => {
      const c = await caches.open(ECACHE), hit = await c.match(ckey(EPTR));
      let p = hit ? await hit.json() : null;
      if (!p) {
        if (!navigator.onLine) throw new Error('Статьи о происхождении ещё не загружались на этот телефон — откройте один раз со связью.');
        const r = await EK.remote(EPTR); if (!r.ok) throw new Error('Статьи о происхождении не загрузились.');
        p = await r.json();
      }
      E = await eOtkryt(c, p);
      if (!hit) await c.put(ckey(EPTR), new Response(JSON.stringify(p)));  /* указатель — в кэш, когда файл уже там */
      eUborka(c, p);
      if (!hit) eChecked = Date.now(); else if (navigator.onLine) etimCheck(true);
      if (!eListen) { eListen = true; document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') etimCheck(); }); }
      return E;
    })().catch(e => { eLoading = null; E = null; throw e; }));
  }
  function etimCheck(sejchas) {
    if (!E || eChecking || !navigator.onLine || (!sejchas && Date.now() - eChecked < 5 * 60e3)) return eChecking;
    return eChecking = (async () => {
      try {
        const r = await EK.remote(EPTR); if (!r.ok) return;
        const n = await r.json(); eChecked = Date.now();
        if (n.etim === E.p.etim) return;
        const c = await caches.open(ECACHE), e = await eOtkryt(c, n);
        await c.put(ckey(EPTR), new Response(JSON.stringify(n)));
        E = e; await eUborka(c, n);
        console.info('slovar: новые статьи о происхождении —', n.etim, `(${n.n})`);
        window.dispatchEvent(new Event('etim-novoe'));
      } catch (e) { console.warn('slovar: обновление этимологии', e); } finally { eChecking = null; }
    })();
  }
  const eLemma = l => !E || !l ? null : E.ix.has(l) ? l : E.ix.has(l.normalize('NFC')) ? l.normalize('NFC') : null;
  function etimSync(l) {  /* статья или null (нет); undefined — файл ещё не открыт */
    if (!E) return undefined;
    const k = eLemma(l); if (!k) return null;
    if (E.art.has(k)) return E.art.get(k);
    const [a, b] = E.ix.get(k), x = JSON.parse(dec.decode(E.u8.subarray(a, b)));
    if (E.art.size > 50) E.art.delete(E.art.keys().next().value);
    E.art.set(k, x); return x;
  }
  const etim = l => etimLoad().then(() => etimSync(l));
  /* слово из статьи → лемма, у которой есть своя статья: точно, иначе без ударений («στολ(ίζω)» → στολίζω) */
  const eSsylka = w => { if (!E) return null; const k = eLemma(w); return k || E.bx.get(gr(w)) || null; };

  /* вид статьи — оформление, одобренное 18.11.2026 (страница-образец, docs/etimologiya.md «Оформление»): тёплый фон, белая
     карточка, слово и главный абзац — Literata, подписи блоков — мелкими прописными, достоверность — цветной пилюлей,
     другая версия — тёплая плашка с полосой слева, зацепка — голубая. Пустой блок не выводится.
     Греческое слово, у которого есть своя статья, — ссылка data-ety (хозяин открывает её статью). */
  const ECONF = { 'высокая': 'hi', 'средняя': 'mid', 'спорно': 'lo' };
  const GRWS = /[\u0370-\u03ff\u1f00-\u1fff]+(?:\([\u0370-\u03ff\u1f00-\u1fff]+\)[\u0370-\u03ff\u1f00-\u1fff]*)?/g;  /* и «στολ(ίζω)» — одним словом */
  function eSlova(t, own) {
    /* часть слова («κειμ-», «-ήλιος») — не ссылка: суффикс -ήλιος не слово ήλιος «солнце» */
    return esc(t).replace(GRWS, (w, i, s) => { const k = s[i - 1] !== '-' && s[i + w.length] !== '-' && eSsylka(w.replace(/[()]/g, '')); return k && k !== own ? `<span class="ety-w" data-ety="${esc(k)}">${w}</span>` : `<span lang="el">${w}</span>`; });
  }
  function eIst(s) {  /* «en.wiktionary: στολίζω (Greek)» → ссылка на статью Викисловаря */
    const m = s.match(/^(en|el)\.wiktionary: (.+?)(?: \([^)]*\))?$/);
    if (!m) return `<li>${/^ru\.wiktionary/.test(s) ? 'ru.wiktionary — русские статьи, где упомянуто слово' : esc(s)}</li>`;
    return `<li><a href="https://${m[1]}.wiktionary.org/wiki/${encodeURIComponent(m[2])}" target="_blank" rel="noopener">${esc(s)}</a></li>`;
  }
  function etimHtml(l, e, slovo) {  /* slovo — заголовок, когда статьи нет (слово с артиклем из словаря) */
    if (!e) return `<article class="ety"><header class="ety-shapka"><h2 lang="el">${esc(slovo || l)}</h2></header><p class="ety-net">Статьи пока нет.</p></article>`;
    const sec = (t, body) => body ? `<section><h3>${t}</h3>${body}</section>` : '';
    return `<article class="ety"><header class="ety-shapka"><h2 lang="el">${esc(e.s || l)}</h2>
        ${e.z ? `<p class="ety-znach">${e.p ? `<span class="ety-pos">${esc(e.p)}</span> ` : ''}${esc(e.z)}</p>` : ''}
        ${e.d ? `<span class="ety-conf ${ECONF[e.d] || 'mid'}">достоверность: ${esc(e.d)}</span>` : ''}</header>
      ${e.r ? `<p class="ety-razbor">${eSlova(e.r, l)}</p>` : ''}
      ${e.a ? `<p class="ety-alt">${eSlova(e.a, l)}</p>` : ''}
      ${sec('Семья в греческом', e.f && `<ul class="ety-fam">${e.f.map(([w, ru]) => `<li>${eSlova(w, l)}${ru ? ' — ' + esc(ru) : ''}</li>`).join('')}</ul>`)}
      ${sec('В русском, английском, латыни', e.v && `<ul class="ety-fam">${e.v.map(([w, lg, n]) => `<li><b>${esc(w)}</b> <span class="ety-lng">${esc([lg, n].filter(Boolean).join(', '))}</span></li>`).join('')}</ul>`)}
      ${sec('В церковном языке', e.c && `<p>${eSlova(e.c, l)}</p>`)}
      ${e.h ? `<aside class="ety-hook"><h3>Зацепка</h3><p>${eSlova(e.h, l)}</p></aside>` : ''}
      <details class="ety-ist"><summary>Источники</summary>${e.i ? `<ol>${e.i.map(eIst).join('')}</ol>` : ''}
        <p>Написано ИИ (Claude) по материалам Викисловаря (CC BY-SA) и проверено кодом; человеком не проверено.</p></details></article>`;
  }
  /* строка «Происхождение ›» с выжимкой — в статье словаря и в карточке слова Экмафиси */
  const etimRow = (l, e) => e && e.g ? `<button class="ety-row" data-ety="${esc(l)}"><span class="k">Происхождение ›</span><span class="g">${esc(e.g)}</span></button>` : '';

  /* --- поиск: двоичный по ключам-байтам UTF-8 (порядок байтов = порядок, в котором их сложил tools/slovar_telefon.py) --- */
  function cmp(ix, j, q) {  /* ключ j против запроса q (байты) */
    const a = ix.Ko[j], n = ix.Ko[j + 1] - a, m = Math.min(n, q.length), K = ix.K;
    for (let x = 0; x < m; x++) { const d = K[a + x] - q[x]; if (d) return d; }
    return n - q.length;
  }
  function lower(ix, q) { let lo = 0, hi = ix.Ko.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(ix, m, q) < 0) lo = m + 1; else hi = m; } return lo; }
  const ids = (ix, j) => ix.P.subarray(ix.Po[j], ix.Po[j + 1]);
  function exact(ix, key) { const q = enc.encode(key), j = lower(ix, q); return j < ix.Ko.length - 1 && cmp(ix, j, q) === 0 ? ids(ix, j) : null; }
  function prefix(ix, key, lim) {  /* ключи, что начинаются с key, кроме него самого → номера ключей */
    const q = enc.encode(key), out = [], N = ix.Ko.length - 1;
    for (let j = lower(ix, q); j < N && out.length < lim; j++) {
      const a = ix.Ko[j], n = ix.Ko[j + 1] - a;
      if (n < q.length) break;
      let ok = true; for (let x = 0; x < q.length; x++) if (ix.K[a + x] !== q[x]) { ok = false; break; }
      if (!ok) break;
      if (n > q.length) out.push(j);
    }
    return out;
  }
  /* точное совпадение ключа в основе и поправке → номера (без убранных); у поправки — с её порядком внутри */
  function exactAll(name, key) {
    const a = exact(D[name], key), out = [];
    if (a) for (const i of a) if (!ubrana(i)) out.push(i);
    const b = D.pp && exact(D.pp[name], key);
    if (b) for (const j of b) out.push(D.n + j);
    return out;
  }
  function prefixAll(name, key, lim, set) {  /* номера статей по ключам, что начинаются с key, — в set */
    for (const j of prefix(D[name], key, lim)) for (const i of ids(D[name], j)) if (!ubrana(i)) set.add(i);
    if (D.pp) for (const j of prefix(D.pp[name], key, lim)) for (const i of ids(D.pp[name], j)) set.add(D.n + i);
    return set;
  }
  function search(q) {
    q = chist(q.trim()); if (!q) return [];
    if (isGr(q)) {  /* сначала точное (заголовок, затем форма — так сложено в файле), потом начало слова — всё по частоте */
      let k = gr(q);
      if (/\s/.test(k) && !exactAll('g', k).length) { const w = k.split(/\s+/).map(chist).filter(x => x && !AUX.has(x)); if (w.length) k = w[w.length - 1]; }
      let ex = exactAll('g', k);
      if (D.pp && ex.some(i => i >= D.n)) {  /* есть статьи поправки — заново: сначала заголовок, потом по частоте */
        const z = new Map(ex.map(i => [i, gr(row(i).l) !== k]));
        ex = ex.sort((a, b) => z.get(a) - z.get(b) || byRk(a, b));
      }
      return [...new Set([...ex, ...[...prefixAll('g', k, 600, new Set())].sort(byRk)])];
    }
    if (isRu(q)) {
      const words = ru(q).split(/[^а-яa-z-]+/).filter(w => w.length > 1 && !STOP.has(w));
      if (!words.length) return [];
      let common = null;
      for (const w of words) {
        const s = prefixAll('ru', w, 400, new Set(exactAll('ru', w)));
        common = common ? new Set([...common].filter(i => s.has(i))) : s;
      }
      const w = words[0], whole = new RegExp('(^|[^а-яa-z])' + w.replace(/[-]/g, '\\-') + '($|[^а-яa-z])');
      const score = i => {  /* 0 — слово стоит первым в первом значении; 1 — первым в каком-то значении; 2 — целым словом; 3 — началом слова */
        const z = row(i).z; let best = 3;
        for (let j = 0; j < z.length; j++) {
          const t = ru(z[j]).replace(/\([^)]*\)/g, '').trim();
          const first = t.split(/[,;]/)[0].trim();
          if (first === w || first.startsWith(w + ' ')) return j === 0 ? 0 : 1;
          if (best > 2 && whole.test(t)) best = 2;
        }
        return best;
      };
      const sc = new Map([...(common || [])].map(i => [i, score(i)]));
      return [...sc.keys()].sort((a, b) => sc.get(a) - sc.get(b) || byRk(a, b));
    }
    const k = lat(q), ex = new Set(exactAll('la', k)), s = prefixAll('la', k, 600, new Set(ex));
    return [...s].sort((a, b) => ex.has(b) - ex.has(a) || byRk(a, b));
  }

  /* --- звук: Azure из хранилища (в кэш), иначе голос телефона --- */
  /* скорость голоса: Azure — playbackRate с сохранением высоты (как у фраз Экмафиси), голос телефона — rate */
  const skorost = () => { const v = +readJ(SKOR); return [0.8, 0.9, 1].includes(v) ? v : 0.9; };
  const elVoice = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []).find(v => /^el(-|_|$)/i.test(v.lang));
  let audio = null;
  /* что сказать: два-три артикля на выбор — один, мужской, если есть (ο/η γιατρός → ο γιατρός); так же — tools/azure_golos.py skazat и функция golos */
  const ART = /^((?:ο|η|το|οι|τα)(?:\/(?:ο|η|το|οι|τα))+)\s/;
  const sayText = t => {
    t = t.normalize('NFC').replace(/\s+/g, ' ').trim();
    const m = t.match(ART);
    if (m) { const v = m[1].split('/'); t = ['ο', 'οι', 'η', 'το', 'τα'].find(a => v.includes(a)) + t.slice(m[1].length); }
    return t.replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
  };
  function phoneVoice(text) {
    const v = elVoice(); if (!v) return false;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = skorost();
    speechSynthesis.speak(u); return true;
  }
  async function zaprosKey(text) {  /* тот же отпечаток считает функция golos (supabase/functions/golos) */
    const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(D.golos + '|' + text)));
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  async function cached(k, get) {  /* из кэша звука; нет — get() из сети и в кэш */
    const c = await caches.open(ZCACHE);
    let r = await c.match(k);
    if (!r) {
      if (!navigator.onLine) return null;
      try { r = await get(); } catch (e) { console.warn('slovar: звук', e); return null; }
      if (!r || !r.ok) return null;
      await c.put(k, r.clone());
    }
    return r.blob();
  }
  async function azureBlob(text, path) {
    if (path) { const b = await cached(ckey(path), () => EK.remote(path)); if (b) return b; }
    if (!window.EK || !EK.golos || !window.crypto || !crypto.subtle) return null;
    const k = ckey(`el/zvuk-zapros/${D.golos}/${await zaprosKey(text)}.mp3`);
    return cached(k, async () => fetch((await EK.golos(text)).url));
  }
  async function play(text, path, btn) {  /* text — что сказать; path — заранее озвученный файл в хранилище или null */
    if (audio) { audio.pause(); audio = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    btn && btn.classList.add('on');
    const done = () => btn && btn.classList.remove('on');
    try {
      const b = await azureBlob(text, path);
      if (b) {
        audio = new Audio(URL.createObjectURL(b));
        audio.preservesPitch = audio.webkitPreservesPitch = true;
        audio.defaultPlaybackRate = audio.playbackRate = skorost();
        audio.onended = audio.onerror = done;
        await audio.play(); return;
      }
    } catch (e) { console.warn('slovar: звук', e); }
    if (!phoneVoice(text)) { done(); btn && (btn.title = 'Нет голоса Azure и греческого голоса на телефоне'); return; }
    setTimeout(done, 900);
  }

  /* --- вид --- */
  const CSS = `
.slv { display: grid; gap: 14px; }
.slv > *, .slv-art > *, .slv-art li, .slv-ph > div { min-width: 0; }  /* ни одно длинное слово не делает страницу шире экрана: сетка ужимается, слово переносится */
.slv-q { width: 100%; font: calc(18px + var(--up, 0px)) var(--f-ui); padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink); }
.slv-q:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
.slv-st { font-size: calc(14px + var(--up, 0px)); color: var(--muted); margin: 0; }
.slv-bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.slv-bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
.slv-list { display: grid; background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.slv-list:empty { display: none; }
.slv-list h3 { margin: 0; padding: 10px 14px 4px; font-size: calc(12px + var(--up, 0px)); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.slv-list button { display: grid; gap: 1px; text-align: left; border: 0; border-top: 1px solid var(--line); background: none; color: var(--ink); padding: 10px 14px; font: inherit; cursor: pointer; }
.slv-list h3 + button { border-top: 0; }
.slv-list button:active { background: var(--accent-soft); }
.slv-list .w { font: calc(19px + var(--up, 0px))/1.25 var(--f-el); }
.slv-list .t { font-size: calc(14px + var(--up, 0px)); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slv-list .more { text-align: center; color: var(--accent); font-weight: 600; }
.slv-art { overflow-wrap: break-word; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; display: grid; gap: 12px; }
.slv.android .slv-back { display: none; }  /* на Android — системный жест «назад» */
.slv-link { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.slv-back { justify-self: start; border: 0; background: none; color: var(--accent); font: 600 calc(15px + var(--up, 0px)) var(--f-ui); padding: 0; cursor: pointer; }
.slv-row { display: flex; gap: 8px; align-items: center; }
.slv-row .slv-q { flex: 1; min-width: 0; }
/* заголовок — всегда одна строка (решение 16.11.2026): слово с артиклями, значок таблиц и 🔊. Значки — в em от строки;
   кегль слова растёт с масштабом, пока влезает, дальше его ужимает fitHead — не мельче основного текста.
   min-width: 0 и contain: inline-size — иначе слово в одну строку распирает сетку страницы шире экрана (на 375 px с шрифтом +5
   было 457–581 px), и Chrome показывает её «увеличенной». То же у строки под словом (.slv-meta) */
.slv-head { contain: inline-size; display: flex; align-items: center; gap: .3em; font: 600 calc(32px + var(--up, 0px))/1.15 var(--f-el); }
.slv-head h1 { flex: 1; min-width: 0; margin: 0; font: inherit; white-space: nowrap; overflow: hidden; }
.slv-head h1.wrap { white-space: normal; overflow-wrap: break-word; }  /* сначала по пробелу после артикля */
.slv-say { flex: none; width: 1.3em; height: 1.3em; border: 0; border-radius: .3em; background: var(--accent-soft); color: var(--accent); display: inline-grid; place-items: center; padding: 0; cursor: pointer; font-size: inherit; }
.slv-say svg { width: 62%; height: 62%; }
.slv-say.on { background: var(--accent); color: var(--accent-ink); }
/* строка под словом — всегда одна: часть речи (цветная подложка), транскрипция, частота; не влезает — кегль не растёт */
.slv-meta { contain: inline-size; margin: -4px 0 0; font-size: calc(14px + var(--up, 0px)); color: var(--muted); display: flex; align-items: center; gap: 10px; white-space: nowrap; overflow: hidden; }
.slv-meta.fit { font-size: 14px; }
.slv-meta > * { flex: none; }
.slv-meta.cut .ipa { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.slv-meta .ipa { font-family: var(--f-el); }
.slv-meta .fr { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
.slv-meta .fr svg { width: 1.05em; height: 1.05em; }
.slv-pos { border-radius: 6px; padding: 1px 7px; font-weight: 700; background: var(--paper); color: var(--ink); }
.slv-pos[data-c=v] { background: light-dark(#dcf1e3, #173a28); color: light-dark(#1c6a3a, #86dca8); }
.slv-pos[data-c=n] { background: light-dark(#fbe1de, #42201d); color: light-dark(#a8322a, #f4a097); }
.slv-pos[data-c=a] { background: light-dark(#fbefc4, #3f3413); color: light-dark(#6e5100, #f0cd5c); }
.slv-pos[data-c=d] { background: light-dark(#dcecf7, #15334a); color: light-dark(#145a85, #7cc3ec); }
.slv-pos[data-c=p] { background: light-dark(#ece3f8, #2f2442); color: light-dark(#5b3596, #c4a8f0); }
.slv-pos[data-c=r] { background: light-dark(#d9f1ee, #13383a); color: light-dark(#11655c, #7dd8cc); }
.slv-pos[data-c=c] { background: light-dark(#e5e9ef, #273140); color: light-dark(#3f4d5e, #b6c3d3); }
.slv-pos[data-c=q] { background: light-dark(#fde6d4, #42291a); color: light-dark(#93460d, #f4b07c); }
.slv-pos[data-c=m] { background: light-dark(#e2e5fb, #23284a); color: light-dark(#33409a, #a9b4f2); }
.slv-pos[data-c=t] { background: light-dark(#efe8e1, #362d25); color: light-dark(#5e4a37, #d6c2ad); }
.slv-pos[data-c=i] { background: light-dark(#fbe1ee, #43202f); color: light-dark(#9a2b62, #f2a3c8); }
.slv-pos[data-c=pp] { background: light-dark(#ecf0d8, #2f3519); color: light-dark(#56651a, #c6d886); }
.slv-tbbtn { flex: none; height: 1.3em; border: 0; border-radius: .3em; background: var(--accent-soft); color: var(--accent); display: inline-flex; align-items: center; gap: .2em; padding: 0 .35em; cursor: pointer; font: 600 calc(15px + var(--up, 0px)) var(--f-ui); }
.slv-head .slv-tbbtn { width: 1.3em; height: 1.3em; padding: 0; border-radius: .3em; font-size: inherit; justify-content: center; }
.slv-head .slv-tbbtn svg { width: 62%; height: 62%; }
/* подсказка по долгому нажатию на значок («Склонение», «Спряжение», «Статья») */
.slv-tip { position: fixed; z-index: 30; max-width: 70vw; background: var(--ink); color: var(--paper); font: 600 calc(14px + var(--up, 0px)) var(--f-ui); padding: 6px 10px; border-radius: 8px; pointer-events: none; box-shadow: 0 4px 16px rgb(0 0 0 / .25); }
/* греческое в статье и списке — без выделения: касание не зовёт подсказки Google (Touch to Search), как .w в Экмафиси */
.slv-art [lang="el"], .slv-list .w { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
/* греческое слово в примере и выражении — касание открывает его статью (решение 17.11.2026); без подчёркивания, нажатие — подложкой */
.slv-w { cursor: pointer; border-radius: 3px; -webkit-tap-highlight-color: transparent; }
.slv-w:active, .slv-w.on { background: var(--accent-soft); }
.slv-head button { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
.slv-tbbtn svg { width: 1.3em; height: 1.3em; }
.slv-tbbtn.on { background: var(--accent); color: var(--accent-ink); }
.slv-tbs { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
.slv-tbs h2.slv-voice { grid-column: 1 / -1; margin: 8px 0 -4px; }
.slv-tb { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; overflow-x: auto; }
.slv-tb h3 { margin: 0 0 6px; font: 700 calc(16px + var(--up, 0px)) var(--f-el); }
.slv-tb h3 span { font: 400 calc(13px + var(--up, 0px)) var(--f-ui); color: var(--muted); margin-left: 4px; }
.slv-tb table { border-collapse: collapse; width: 100%; font: calc(16px + var(--up, 0px))/1.35 var(--f-el); }
.slv-tb th { text-align: left; font: 600 calc(12px + var(--up, 0px)) var(--f-ui); color: var(--muted); padding: 5px 8px 3px 0; white-space: nowrap; vertical-align: top; }
.slv-tb tbody th { width: 5.6em; }  /* столбец форм — на одном месте во всех блоках */
.slv-tb thead th { font-weight: 700; }
.slv-tb td { padding: 3px 8px 3px 0; vertical-align: top; }
.slv-tb small { font-size: .8em; color: var(--muted); }
.slv-tbwait { color: var(--muted); }
.slv-tbnote { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: calc(14px + var(--up, 0px)); }
.slv-var { margin: -6px 0 0; font-size: calc(14px + var(--up, 0px)); color: var(--muted); }
.slv-note { margin: 0; font-size: calc(15px + var(--up, 0px)); background: var(--paper); border-radius: 10px; padding: 8px 12px; }
.slv-z { margin: 0; padding-left: 24px; display: grid; gap: 12px; }
.slv-z .ru { font-size: calc(17px + var(--up, 0px)); font-weight: 600; }
.slv-z .lb { font-style: italic; color: var(--muted); font-weight: 400; margin-right: 4px; }
.slv-ex { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 4px; }
.slv-ex li { padding-left: 10px; border-left: 2px solid var(--line); }
.slv-ex .e { font: calc(16px + var(--up, 0px))/1.4 var(--f-el); }
.slv-exsay { border: 0; background: var(--accent-soft); color: var(--accent); width: 1.6em; height: 1.6em; border-radius: .35em; padding: 0; margin-left: .35em; display: inline-grid; place-items: center; vertical-align: -.4em; cursor: pointer; font-size: calc(16px + var(--up, 0px)); }
.slv-exsay svg { width: 62%; height: 62%; }
.slv-exsay.on { background: var(--accent); color: var(--accent-ink); }
.slv-ex .r { display: block; color: var(--muted); font-size: calc(15px + var(--up, 0px)); }
.slv-src { font-size: calc(11px + var(--up, 0px)); font-weight: 700; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 6px; white-space: nowrap; vertical-align: 1px; }
.slv-art h2 { margin: 6px 0 0; font-size: calc(13px + var(--up, 0px)); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.slv-ph { display: grid; gap: 6px; }
.slv-ph div { font-size: calc(15px + var(--up, 0px)); }
.slv-ph .e { font: calc(16px + var(--up, 0px)) var(--f-el); }
.slv-forms { font: calc(16px + var(--up, 0px))/1.5 var(--f-el); color: var(--muted); }
/* --- происхождение: токены страницы-образца (одобрено 18.11.2026), свои имена --ety-*, тёмная тема — те же роли --- */
:root { --ety-bg: #f7f6f2; --ety-card: #ffffff; --ety-fg: #1f2124; --ety-mut: #686b70; --ety-line: #e2e0d9; --ety-acc: #2c5f7c;
  --ety-alt: #fbf3e2; --ety-alt-line: #e3c98d; --ety-hook: #eaf1f4; --ety-ok: #2f7a4b; --ety-mid: #9a6a10; --ety-lo: #a3402f;
  --ety-disp: "Literata", Georgia, "Times New Roman", serif; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ety-bg: #17191b; --ety-card: #1f2225; --ety-fg: #e8e7e3;
  --ety-mut: #9da1a6; --ety-line: #34383c; --ety-acc: #8cc1dc; --ety-alt: #2b2518; --ety-alt-line: #6e5a2c; --ety-hook: #1d2a31;
  --ety-ok: #7fcf9b; --ety-mid: #e2b45b; --ety-lo: #ef8f7d; } }
:root[data-theme="dark"] { --ety-bg: #17191b; --ety-card: #1f2225; --ety-fg: #e8e7e3; --ety-mut: #9da1a6; --ety-line: #34383c;
  --ety-acc: #8cc1dc; --ety-alt: #2b2518; --ety-alt-line: #6e5a2c; --ety-hook: #1d2a31; --ety-ok: #7fcf9b; --ety-mid: #e2b45b; --ety-lo: #ef8f7d; }
html.ety-page body, .ety-page, .sheet.ety-page { background: var(--ety-bg); }
.ety { background: var(--ety-card); color: var(--ety-fg); border: 1px solid var(--ety-line); border-radius: 10px; padding: 18px 18px 14px;
  display: grid; gap: 14px; min-width: 0; overflow-wrap: break-word; font-size: calc(16px + var(--up, 0px)); line-height: 1.6; text-align: left; }
.ety p, .ety ul, .ety ol { margin: 0; }
.ety-shapka { display: grid; gap: 4px; }
.ety h2 { font: 600 calc(32px + var(--up, 0px))/1.1 var(--ety-disp); margin: 0; letter-spacing: 0; text-transform: none; color: var(--ety-fg); }
.ety-pos { color: var(--ety-mut); font-size: .9em; margin-right: 4px; }
.ety h3 { font: 600 calc(11.5px + var(--up, 0px))/1.3 var(--f-ui, system-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ety-mut); margin: 0 0 6px; }
.ety-conf { justify-self: start; font-size: calc(12.5px + var(--up, 0px)); padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; }
.ety-conf.hi { color: var(--ety-ok); } .ety-conf.mid { color: var(--ety-mid); } .ety-conf.lo { color: var(--ety-lo); }
.ety-razbor { font: 400 calc(17px + var(--up, 0px))/1.6 var(--ety-disp); }
.ety-alt { font-size: .95em; background: var(--ety-alt); border-left: 3px solid var(--ety-alt-line); padding: 6px 10px; border-radius: 0 6px 6px 0; }
.ety-fam { padding-left: 1.1em; columns: 2; column-gap: 24px; } .ety-fam li { break-inside: avoid; }
@media (max-width: 520px) { .ety-fam { columns: 1; } }
.ety-lng { color: var(--ety-mut); font-size: .88em; }
.ety-hook { background: var(--ety-hook); border-radius: 8px; padding: 10px 12px; }
.ety-ist { font-size: .88em; color: var(--ety-mut); } .ety-ist summary { cursor: pointer; }
.ety-ist ol { margin: 6px 0 0; padding-left: 1.4em; overflow-wrap: anywhere; } .ety-ist p { margin-top: 6px; } .ety a { color: var(--ety-acc); }
.ety-net { color: var(--ety-mut); }
.ety [lang="el"], .ety-w { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
.ety-w { color: var(--ety-acc); cursor: pointer; border-radius: 3px; -webkit-tap-highlight-color: transparent; }
.ety-w:active, .ety-w.on { background: var(--ety-hook); }
/* строка «Происхождение ›» с выжимкой: в статье словаря и в карточке слова Экмафиси */
.ety-row { display: grid; gap: 2px; width: 100%; text-align: left; border: 0; border-top: 1px solid var(--line); background: none; color: var(--ink); padding: 10px 0 0; font: inherit; cursor: pointer; }
.ety-row .k { color: var(--accent); font-weight: 600; font-size: calc(15px + var(--up, 0px)); }
.ety-row .g { font: calc(15px + var(--up, 0px))/1.45 var(--f-el); color: var(--muted); }
.slv-art.ety-on { background: none; border: 0; padding: 0; }
.slv-w.hold, .slv-head h1.hold, .slv-list button.hold, .ety-w.hold { background: var(--accent-soft); }
`;
  const ANDROID = /android/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent);
  const SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  const TBI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18M3 15h18M10 4v16"/></svg>';
  const ARTI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 19h4"/></svg>';
  const tbName = s => (s.p || '').startsWith('глагол') ? 'Спряжение' : 'Склонение';
  function tbHtml(bloki) {
    let h = '<div class="slv-tbs">', voice = null;
    for (const [zag, ru, cols, rows] of bloki) {
      if (!rows.length) { h += `<p class="slv-tbnote" lang="ru">${esc(ru)}</p>`; continue; }  /* «составлено по образцу …», «таблица слова …» */
      const glagol = cols.length === 1;
      if (glagol && cols[0] && cols[0] !== voice) { voice = cols[0]; h += `<h2 class="slv-voice">${esc(voice)}</h2>`; }
      const cell = c => c.map(f => f.startsWith('~') ? `<small>${esc(f.slice(1))}</small>` : esc(f)).join(', ');
      h += `<section class="slv-tb"><h3 lang="el">${esc(zag)}<span>${esc(ru)}</span></h3><table lang="el">`
        + (!glagol ? `<thead><tr><th></th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : '')
        + '<tbody>' + rows.map(([r, cells]) => `<tr><th>${esc(r)}</th>${cells.map(c => `<td>${cell(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table></section>';
    }
    return h + '</div>';
  }
  const FR = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1.5" y="9" width="3" height="5.5" rx="1"/><rect x="6.5" y="5.5" width="3" height="9" rx="1"/><rect x="11.5" y="2" width="3" height="12.5" rx="1"/></svg>';
  const POS = [['глагол', 'v'], ['сущ', 'n'], ['прил', 'a'], ['нареч', 'd'], ['местоим', 'p'], ['предлог', 'r'], ['союз', 'c'], ['частица', 'q'],
    ['числит', 'm'], ['порядк', 'm'], ['артикль', 't'], ['межд', 'i'], ['прич', 'pp']];
  const posC = p => (POS.find(([k]) => p.startsWith(k)) || [, ''])[1];

  function fitMeta(m) {  /* одна строка: не влезает с крупным кеглем — обычный кегль; всё ещё нет — транскрипция с многоточием */
    if (!m) return;
    m.classList.remove('fit', 'cut');
    if (m.scrollWidth > m.clientWidth) m.classList.add('fit');
    if (m.scrollWidth > m.clientWidth) m.classList.add('cut');
  }
  /* заголовок — одна строка: слово не влезает рядом со значками — кегль меньше, но не мельче основного текста статьи;
     и тогда не влезает (очень длинное слово) — перенос, но страница шире экрана не становится */
  function fitHead(h, art) {
    const h1 = h && h.querySelector('h1'); if (!h1) return;
    h1.style.fontSize = ''; h1.classList.remove('wrap');
    if (h1.scrollWidth <= h1.clientWidth) return;
    const full = parseFloat(getComputedStyle(h1).fontSize), min = parseFloat(getComputedStyle(art).fontSize);
    let fs = Math.max(min, Math.floor(full * h1.clientWidth / h1.scrollWidth * 10) / 10);
    h1.style.fontSize = fs + 'px';
    while (h1.scrollWidth > h1.clientWidth && fs > min) { fs = Math.max(min, fs - 1); h1.style.fontSize = fs + 'px'; }
    if (h1.scrollWidth > h1.clientWidth) h1.classList.add('wrap');
  }
  /* греческие слова — каждое в <span class="slv-w">: касание открывает статью (текст уже экранирован, греческие буквы esc не трогает) */
  const GRW = /[\u0370-\u03ff\u1f00-\u1fff]+/g;
  const slova = t => esc(t).replace(GRW, w => `<span class="slv-w">${w}</span>`);
  /* слово → лемма его статьи: точное совпадение по заголовку и всем формам, как в search(). Несколько — заголовок буква
     в букву с ударением («Ο» → ο, «θα» → θα), иначе самая частая (номера идут по частоте): «μου» → εγώ, не редкое μού */
  function slovoLemma(w) {
    const c = D && exactAll('g', gr(w)); if (!c || !c.length) return null;
    const lw = w.normalize('NFC').toLowerCase();
    for (const i of c) { const l = row(i).l; if (l.normalize('NFC').toLowerCase() === lw) return l; }
    return row(c.reduce((a, b) => rk(b) < rk(a) ? b : a)).l;
  }
  const rowHtml = r => `<button data-l="${esc(r.l)}"><span class="w" lang="el">${esc(r.s)}</span><span class="t">${esc(r.b)}</span></button>`;
  const rowOf = i => { const r = row(i); return { l: r.l, s: r.s, b: brief(r.z) }; };
  /* вид — сразу при загрузке модуля: статья о происхождении и строка «Происхождение ›» нужны Экмафиси и без экрана «Словарь» */
  const css = () => { if (!document.getElementById('slv-css')) { const st = document.createElement('style'); st.id = 'slv-css'; st.textContent = CSS; document.head.appendChild(st); } };
  css();
  function mount(root, opts) {
    css();
    /* поле без подсказок: нестандартное name/id, autocomplete/autocorrect выкл. — Chrome не подставляет прошлые вводы, клавиатура не правит */
    root.innerHTML = `<div class="slv${ANDROID ? ' android' : ''}">
      <div class="slv-row"><input class="slv-q" type="search" name="slv-poisk-x" id="slv-poisk-${Math.random().toString(36).slice(2, 8)}" placeholder="Греческое или русское слово" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Поиск по словарю" data-lpignore="true" data-form-type="other"></div>
      <p class="slv-st"></p><div class="slv-bar hidden"><i></i></div>
      <div class="slv-list"></div>
      <article class="slv-art hidden"></article></div>`;
    root.style.minWidth = '0';  /* и в сетке страницы-хозяина */
    if (opts.aside) root.querySelector('.slv-row').appendChild(opts.aside);  /* шестерёнка приложения — в строку поиска, справа */
    const $ = sel => root.querySelector(sel), q = $('.slv-q'), st = $('.slv-st'), list = $('.slv-list'), art = $('.slv-art');
    const artY = new Map();  /* статья → прокрутка, когда ушли из неё в другую: «назад» — на то же место */
    let res = [], shown = 100, cur = null, curS = null, want = null, listY = 0, mode = null, wantM = null, showTok = 0;
    /* шрифт сменили, экран повернули, шрифт догрузился — заголовок и строку под ним заново */
    const refit = () => { if (cur) { fitHead(art.querySelector('.slv-head'), art); fitMeta(art.querySelector('.slv-meta')); } };
    if (window.ResizeObserver) new ResizeObserver(refit).observe($('.slv-row')); else addEventListener('resize', refit);  /* строка поиска меняется с шириной и шрифтом, но не от подбора кегля */
    if (document.fonts) document.fonts.ready.then(refit);

    const status = () => { st.textContent = D ? `${num(D.ptr.n || D.n)} статей · ищется по-гречески, латиницей и по-русски` : ''; };
    function drawList() {
      const val = q.value.trim();
      if (!val) {  /* «Недавние» — из памяти телефона, видны и пока словарь открывается */
        let rec = readJ(RECENT2) || [];
        if (!rec.length && D) {  /* прежний список (только леммы) — один раз в новый */
          rec = (readJ(RECENT) || []).map(by).filter(i => i !== undefined).map(rowOf);
          if (rec.length) try { localStorage.setItem(RECENT2, JSON.stringify(rec)); } catch (e) {}
        }
        list.innerHTML = rec.length ? '<h3>Недавние</h3>' + rec.map(rowHtml).join('')
          : D ? '<h3>Самые частые</h3>' + chastye(50).map(i => rowHtml(rowOf(i))).join('') : '';
        return;
      }
      if (!D) return;
      if (!res.length) { list.innerHTML = `<h3>Ничего не нашлось</h3>`; return; }
      list.innerHTML = res.slice(0, shown).map(i => rowHtml(rowOf(i))).join('') + (res.length > shown ? `<button class="more" data-more="1">ещё ${num(Math.min(100, res.length - shown))} из ${num(res.length - shown)}</button>` : '');
    }
    const run = () => { if (!D) return; res = search(q.value); shown = 100; drawList(); };
    /* словарь обновился в фоне (proverit) — номера статей другие: список заново, тихо; открытая статья остаётся */
    window.addEventListener('slovar-novoe', () => { status(); if (!cur) { if (q.value.trim()) { res = search(q.value); drawList(); } else drawList(); } });
    let t = 0;
    q.addEventListener('input', () => {
      if (cur) { cur = null; curS = null; showTok++; etyPage(false); art.classList.add('hidden'); list.classList.remove('hidden'); st.classList.remove('hidden'); opts.onBack && opts.onBack(); }  /* печатает поверх статьи — к списку, один шаг назад */
      clearTimeout(t); t = setTimeout(run, 120);
    });
    q.addEventListener('keydown', e => { if (e.key === 'Enter' && res.length) { q.blur(); pick(row(res[0]).l); } });
    list.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.more) { shown += 100; drawList(); return; }
      pick(b.dataset.l);
    });
    const pick = (l, m) => opts.onPick ? opts.onPick(l, m) : api.show(l, m);

    /* долгое нажатие на значок — подсказка словом (title на телефоне не виден); отпустил — нажатие не срабатывает */
    let lp = 0, lpDone = false, tipT = 0;
    const tip = $('.slv').appendChild(Object.assign(document.createElement('div'), { className: 'slv-tip hidden', role: 'tooltip' }));
    function showTip(b) {
      tip.textContent = b.dataset.tip; tip.classList.remove('hidden');
      const r = b.getBoundingClientRect(), w = tip.offsetWidth;
      tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
      tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + 'px';
      clearTimeout(tipT); tipT = setTimeout(() => tip.classList.add('hidden'), 1600);
    }
    art.addEventListener('pointerdown', e => {
      const b = e.target.closest('[data-tip]'); lpDone = false; clearTimeout(lp);
      if (b) lp = setTimeout(() => { lpDone = true; showTip(b); }, 450);
    });
    ['pointerup', 'pointercancel'].forEach(ev => art.addEventListener(ev, () => clearTimeout(lp)));  /* прокрутка пальцем — pointercancel */
    art.addEventListener('contextmenu', e => { if (e.target.closest('[data-tip]')) e.preventDefault(); });

    /* долгое нажатие на слово (≈ 450 мс) — сразу его статья о происхождении (решение 5.11.2026, как в Экмафиси): заголовок
       статьи, греческое слово примера или выражения, строка списка; обычное нажатие — как прежде. Палец сдвинулся — не в счёт */
    let wl = null;
    const wLemma = el => el.matches('.slv-list button') ? el.dataset.l : el.matches('h1') ? cur : el.matches('.ety-w') ? el.dataset.ety : slovoLemma(el.textContent);
    root.addEventListener('pointerdown', e => {
      const el = e.target.closest('.slv-w, .slv-head h1, .slv-list button[data-l], .ety-w'); if (!el || e.button > 0) return;
      el.classList.add('hold');
      wl = { el, x: e.clientX, y: e.clientY, fired: false, t: setTimeout(() => {
        wl.fired = true; el.classList.remove('hold');
        const l = wLemma(el); if (l && !(l === cur && mode === 'etym')) pick(l, 'etym');
      }, 450) };
    });
    const wlCancel = () => {  /* после сработавшего — глотаем ближайший click (на телефоне его может и не быть) */
      if (!wl) return; clearTimeout(wl.t); wl.el.classList.remove('hold');
      if (!wl.fired) wl = null; else { const w0 = wl; setTimeout(() => { if (wl === w0) wl = null; }, 400); }
    };
    root.addEventListener('pointermove', e => { if (wl && !wl.fired && Math.hypot(e.clientX - wl.x, e.clientY - wl.y) > 10) wlCancel(); });
    ['pointerup', 'pointercancel'].forEach(ev => root.addEventListener(ev, wlCancel));
    root.addEventListener('click', e => { if (wl && wl.fired) { e.stopPropagation(); e.preventDefault(); wl = null; } }, true);
    root.addEventListener('contextmenu', e => { if (e.target.closest('.slv-w, .slv-head h1, .slv-list button, .ety-w')) e.preventDefault(); });

    art.addEventListener('click', e => {
      if (lpDone && e.target.closest('[data-tip]')) { lpDone = false; return; }
      if (e.target.closest('.slv-back')) { opts.onBack ? opts.onBack() : api.show(null); return; }
      const ey = e.target.closest('[data-ety]');
      if (ey) { e.stopPropagation(); ey.classList.add('on'); setTimeout(() => pick(ey.dataset.ety, 'etym'), 90); return; }  /* строка «Происхождение ›» и слова статьи */
      const lk = e.target.closest('.slv-link'); if (lk) { pick(lk.dataset.l); return; }
      const sw = e.target.closest('.slv-w');
      if (sw) {  /* слово примера → его статья; не нашлось или это та же статья — ничего */
        const l = slovoLemma(sw.textContent);
        if (l && l !== cur) { sw.classList.add('on'); setTimeout(() => pick(l), 90); }  /* подложка успевает мелькнуть */
        return;
      }
      if (e.target.closest('.slv-tbbtn')) { pick(cur, mode === 'tab' ? null : 'tab'); return; }  /* рубильник «таблицы / статья» */
      if (!cur || !curS) return;
      const s = curS;
      const b = e.target.closest('.slv-say');
      if (b) { play(sayText(s.s), s.a && D.zvuk ? D.zvuk + s.a + '.mp4' : null, b); return; }
      const x = e.target.closest('.slv-exsay');
      if (x) { const ex = s.z[+x.dataset.z].ex[+x.dataset.x]; play(sayText(ex.el), ex.a && D.zvukP ? D.zvukP + ex.a + '.mp4' : null, x); }
    });

    const etyPage = on => document.documentElement.classList.toggle('ety-page', !!on);
    function article(l, m, s) {
      curS = s;
      art.classList.toggle('ety-on', m === 'etym'); etyPage(m === 'etym');
      if (m === 'etym') {  /* статья о происхождении — отдельным экраном той же статьи: «←» — к статье словаря */
        mode = 'etym';
        const draw = e => { art.innerHTML = `<button class="slv-back">← ${esc(s.s)}</button>` + etimHtml(l, e, s.s); };
        const e0 = etimSync(l);
        if (e0 !== undefined) draw(e0);
        else {
          art.innerHTML = `<button class="slv-back">← ${esc(s.s)}</button><p class="slv-tbwait">Открываю статьи о происхождении…</p>`;
          etim(l).then(e => cur === l && mode === 'etym' && draw(e), e => { const w = art.querySelector('.slv-tbwait'); if (w) w.textContent = e.message; });
        }
        return;
      }
      const tab = m === 'tab' && s.tb;
      const tbBtn = s.tb ? (tab ? `<button class="slv-tbbtn on" aria-label="Статья" title="Статья" data-tip="Статья">${ARTI}</button>`
        : `<button class="slv-tbbtn" aria-label="${tbName(s)}" title="${tbName(s)}" data-tip="${tbName(s)}">${TBI}</button>`) : '';
      let h = `<button class="slv-back">← ${q.value.trim() ? 'к списку' : 'к поиску'}</button>
        <div class="slv-head"><h1 lang="el">${esc(s.s)}</h1>${tbBtn}<button class="slv-say" aria-label="Произнести">${SPK}</button></div>`;
      if (tab) {  /* таблицы — отдельным экраном той же статьи */
        mode = 'tab';
        const t = D.ptr.tablicyN ? tbSync(l) : null;
        art.innerHTML = h + (t === undefined ? '<p class="slv-tbwait">Загружаю таблицы…</p>' : t ? tbHtml(t) : '<p class="slv-tbwait">Таблицы для этого слова нет.</p>');
        fitHead(art.querySelector('.slv-head'), art);
        if (t === undefined) tablicy(l).then(() => cur === l && mode === 'tab' && article(l, m, s)).catch(e => { const w = art.querySelector('.slv-tbwait'); if (w) w.textContent = navigator.onLine ? e.message : 'Таблицы ещё не загружались на этот телефон — откройте один раз со связью.'; });
        return;
      }
      mode = null;
      h += `
        <p class="slv-meta">${s.p ? `<span class="slv-pos" data-c="${posC(s.p)}">${esc(s.p)}</span>` : ''}${s.i ? `<span class="ipa">${esc(s.i)}</span>` : ''}${s.r ? `<span class="fr" title="место по частоте${s.v ? ' — вместе с ' + esc(s.v) : ''}">${FR}${num(s.r)}</span>` : ''}</p>
        ${s.v ? `<p class="slv-var">та же лексема: <button class="slv-link" lang="el" data-l="${esc(s.v)}">${esc(s.v)}</button></p>` : ''}`;
      if (s.n) h += `<p class="slv-note">${esc(s.n)}</p>`;
      h += '<ol class="slv-z">' + s.z.map((z, zi) => `<li><span class="ru">${z.lb ? `<span class="lb">${esc(z.lb)}</span>` : ''}${esc(z.ru)}</span>${z.ex ? '<ul class="slv-ex">' + z.ex.map((x, xi) =>
        `<li><span class="e" lang="el">${slova(x.el)}</span><button class="slv-exsay" data-z="${zi}" data-x="${xi}" aria-label="Произнести пример">${SPK}</button>${SRC[x.src] ? `<span class="slv-src">${SRC[x.src]}</span>` : ''}<span class="r">${esc(x.ru)}</span></li>`).join('') + '</ul>' : ''}</li>`).join('') + '</ol>';
      if (s.f) h += '<h2>Выражения</h2><div class="slv-ph">' + s.f.map(x => `<div><span class="e" lang="el">${slova(x.el)}</span> — ${esc(x.ru)}</div>`).join('') + '</div>';
      if (s.c && s.c.length && !s.tb) h += `<h2>Частые формы</h2><div class="slv-forms" lang="el">${s.c.map(esc).join(', ')}</div>`;
      const e0 = etimSync(l);  /* «Происхождение ›» с выжимкой; файл ещё открывается — строка встанет, когда откроется */
      h += `<div class="slv-ety">${e0 ? etimRow(l, e0) : ''}</div>`;
      art.innerHTML = h;
      if (e0 === undefined) etim(l).then(e => { const b = cur === l && mode === null && art.querySelector('.slv-ety'); if (b && e) b.innerHTML = etimRow(l, e); }).catch(() => {});
      fitHead(art.querySelector('.slv-head'), art);  /* до отрисовки: страница ни на миг не шире экрана */
      requestAnimationFrame(() => fitMeta(art.querySelector('.slv-meta')));
      const rec = (readJ(RECENT2) || []).filter(x => x.l !== l); rec.unshift({ l, s: s.s, b: brief(s.z.map(z => z.ru)) });
      try { localStorage.setItem(RECENT2, JSON.stringify(rec.slice(0, 30))); } catch (e) {}
    }

    const api = {
      show(l, m) {  /* l — статья; null — список; m — 'tab': таблицы этой статьи */
        want = l; wantM = m || null;
        const tok = ++showTok, was = cur, y = window.scrollY;
        if (!D) { if (!l) drawList(); return; }  /* словарь ещё открывается: список «Недавних» уже виден, статья — когда готов */
        const i = l ? by(l) : undefined;
        const put = s => {
          if (tok !== showTok) return;  /* пока разбиралась, открыли другое */
          if (s) article(l, m, s);
          cur = s ? l : null; if (!s) curS = null;
          if (cur && !was) listY = y;  /* уходим со списка в статью — запомнить прокрутку */
          if (cur && was && was !== cur) artY.set(was, y);  /* из статьи в статью (слово примера) */
          art.classList.toggle('hidden', !cur); list.classList.toggle('hidden', !!cur); st.classList.toggle('hidden', !!cur);
          if (!cur) { drawList(); art.classList.remove('ety-on'); etyPage(false); }
          if (cur) {
            refit();
            const ay = was !== cur && artY.has(cur) ? artY.get(cur) : 0; artY.delete(cur);
            window.scrollTo(0, ay);
            if (ay) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, ay)));  /* поверх прокрутки браузера после popstate */
          }
          else if (was) {  /* назад к списку — на прежнее место; запрос в поле остаётся */
            const y = listY; window.scrollTo(0, y);
            requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));  /* браузер после popstate восстанавливает свою прокрутку — поверх неё */
          }
          /* список → список (повторный вызов маршрута) — прокрутку не трогаем */
        };
        if (i === undefined) put(null);
        else stat(i).then(put, e => { console.warn('slovar: статья', e); put(null); });
      },
      focus() { if (!cur) q.focus({ preventScroll: true }); },
      ready: null
    };
    drawList();
    const bar = $('.slv-bar'), slow = setTimeout(() => { if (!D) st.textContent = 'Открываю словарь…'; }, 400);  /* из кэша — доли секунды, надпись не мелькает */
    api.ready = load(f => { bar.classList.remove('hidden'); bar.firstElementChild.style.width = Math.min(100, f * 100).toFixed(0) + '%'; st.textContent = `Загружаю словарь — один раз, дальше без сети · ${Math.min(99, Math.round(f * 100))} %`; })
      .then(() => { clearTimeout(slow); bar.classList.add('hidden'); status(); if (q.value.trim()) run(); api.show(want, wantM); etimLoad().catch(e => console.warn('slovar: этимология', e)); })
      .catch(e => { clearTimeout(slow); bar.classList.add('hidden'); st.textContent = e.message || String(e); });
    return api;
  }

  window.Slovar = { mount, load, search: q => (D ? search(q) : []), get data() { return D; }, zamer, proverit: () => proverit(true),
    etimLoad, etim, etimSync, etimHtml, etimRow, etimProverit: () => etimCheck(true) };
})();
