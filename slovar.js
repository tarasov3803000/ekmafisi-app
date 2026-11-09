/* Словарь — общий модуль экрана «Словарь» в Экмафиси и отдельного приложения «Словарь» (slovar-app/).
   Данные: весь свой словарь одним файлом из закрытого хранилища (tools/slovar_telefon.py):
     el/slovar-vse.json — указатель { file, n, gz } (со связью — всякий раз заново);
     el/slovar-vse-<отпечаток>.json.gz — один раз, распаковка DecompressionStream, кладётся распакованным в свой кэш.
   Дальше — без сети. Новый отпечаток — новый файл, старый из кэша вон.
   Поиск: греческий без ударений и по частым формам; латиница (транслитерация); русский — по словам значений вне скобок.
   Звук слова и примера: голос Azure — озвученный заранее (el/zvuk-slov/<голос>/<a>.mp4, el/zvuk-prim/<голос>/<a>.mp4),
   иначе по запросу через функцию golos (el/zvuk-zapros/<голос>/<sha16>.mp3); всё — в кэш при первом нажатии.
   Нет сети, предел месяца или отказ — голос телефона el-GR.
   Хост даёт: EK.remote(путь) → fetch-ответ из хранилища; переходы — onPick(lemma) и onBack(); показ — api.show(lemma | null). */
(() => {
  const CACHE = 'ekmafisi-slovar-v1', ZCACHE = 'ekmafisi-slovar-zvuk-v1', PTR = 'el/slovar-vse.json', RECENT = 'ekmafisi.slovar.nedavno';
  const ckey = p => new URL('slovar/' + p, location.origin + '/').href;  /* ключ кэша — один на оба приложения (один адрес github.io) */
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = n => Number(n).toLocaleString('ru-RU');
  const gr = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ');
  const ru = s => s.toLowerCase().replace(/ё/g, 'е');
  const lat = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const isGr = s => /[Ͱ-Ͽἀ-῿]/.test(s), isRu = s => /[а-яё]/i.test(s);
  const STOP = new Set('и в во на с со к ко о об от по для из за у при до под над без про как что кто то или а но не ни же ли бы кого чего кому чему кем чем ком нибудь либо т п д др'.split(' '));
  const SRC = { opensubtitles: 'субтитры', tatoeba: 'tatoeba' };
  const readJ = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };

  /* --- данные --- */
  let D = null, loading = null;
  async function pointer() {
    const c = await caches.open(CACHE), k = ckey(PTR), hit = await c.match(k);
    if (navigator.onLine) try {
      /* связь плохая, а словарь уже есть — ждать не дольше 4 с, дальше открыть, что есть */
      const net = EK.remote(PTR).then(async r => { if (!r.ok) throw new Error(r.status); const p = await r.json(); await c.put(k, new Response(JSON.stringify(p))); return p; });
      return await (hit ? Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error('медленно')), 4000))]) : net);
    } catch (e) { console.warn('slovar: указатель', e); }
    if (hit) return hit.json();
    throw new Error(navigator.onLine ? 'Словарь не загрузился. Попробуйте ещё раз.' : 'Нет сети, а словарь на этом телефоне ещё не загружался. Откройте один раз со связью.');
  }
  async function fetchData(p, onProgress) {
    const c = await caches.open(CACHE), k = ckey(p.file.replace(/\.gz$/, ''));
    let hit = await c.match(k);
    if (!hit) {
      const r = await EK.remote(p.file);
      if (!r.ok) throw new Error('Словарь не загрузился: ' + r.status);
      let got = 0;
      const count = new TransformStream({ transform(ch, ctl) { got += ch.byteLength; onProgress && onProgress(got / (p.gz || 6e6)); ctl.enqueue(ch); } });
      const txt = await new Response(r.body.pipeThrough(count).pipeThrough(new DecompressionStream('gzip'))).text();
      await c.put(k, new Response(txt, { headers: { 'Content-Type': 'application/json' } }));
      c.keys().then(ks => ks.forEach(q => (q.url === k || q.url === ckey(PTR)) || c.delete(q)));  /* прежние версии — вон */
      hit = new Response(txt);
    }
    return hit.json();
  }
  function index(d) {
    const S = d.S, grI = new Map(), ruI = new Map(), laI = new Map();
    const add = (m, key, i) => { if (!key) return; const a = m.get(key); if (!a) m.set(key, [i]); else if (a[a.length - 1] !== i) a.push(i); };
    S.forEach((s, i) => {
      add(grI, gr(s.l), i);
      for (const w of s.s.split(/[\s/]+/)) if (w.length > 2) add(grI, gr(w), i);  /* «ο άνθρωπος», «ο/η γιατρός» — и по второму слову */
      for (const f of s.c || []) add(grI, gr(f), i);
      if (s.t) add(laI, lat(s.t), i);
      for (const z of s.z) {
        const bez = ru(z.ru).replace(/\([^)]*\)/g, ' ');  /* «ставить (вертикально)» ищется по «ставить», не по «вертикально» */
        for (const w of bez.split(/[^а-яa-z-]+/)) { const key = w.replace(/^-+|-+$/g, ''); if (key.length > 1 && !STOP.has(key)) add(ruI, key, i); }
      }
    });
    const keys = m => [...m.keys()].sort();
    return { S, n: S.length, zvuk: d.zvuk, zvukP: d.zvukP, golos: d.golos || 'athina', by: new Map(S.map((s, i) => [s.l, i])), grI, ruI, laI, grK: keys(grI), ruK: keys(ruI), laK: keys(laI) };
  }
  function load(onProgress) {
    if (D) return Promise.resolve(D);
    return loading || (loading = pointer().then(p => fetchData(p, onProgress)).then(d => (D = index(d)))
      .catch(e => { loading = null; throw e; }));
  }

  /* --- поиск --- */
  function prefix(keys, q, lim) {
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < q) lo = m + 1; else hi = m; }
    const out = []; for (let i = lo; i < keys.length && keys[i].startsWith(q) && out.length < lim; i++) out.push(keys[i]);
    return out;
  }
  function search(q) {
    q = q.trim(); if (!q) return [];
    const byRank = (a, b) => a - b;
    if (isGr(q)) {  /* сначала точное (заголовок, затем форма), потом начало слова — всё по частоте */
      const k = gr(q), exact = (D.grI.get(k) || []).slice().sort((a, b) => (gr(D.S[b].l) === k) - (gr(D.S[a].l) === k) || a - b);
      const pre = new Set(); for (const key of prefix(D.grK, k, 600)) if (key !== k) for (const i of D.grI.get(key)) pre.add(i);
      return [...new Set([...exact, ...[...pre].sort(byRank)])];
    }
    if (isRu(q)) {
      const words = ru(q).split(/[^а-яa-z-]+/).filter(w => w.length > 1 && !STOP.has(w));
      if (!words.length) return [];
      let common = null;
      for (const w of words) {
        const s = new Set(); for (const key of prefix(D.ruK, w, 400)) for (const i of D.ruI.get(key)) s.add(i);
        common = common ? new Set([...common].filter(i => s.has(i))) : s;
      }
      const w = words[0], whole = new RegExp('(^|[^а-яa-z])' + w.replace(/[-]/g, '\\-') + '($|[^а-яa-z])');
      const score = i => {  /* 0 — слово стоит первым в первом значении; 1 — первым в каком-то значении; 2 — целым словом; 3 — началом слова */
        const z = D.S[i].z; let best = 3;
        for (let j = 0; j < z.length; j++) {
          const t = ru(z[j].ru).replace(/\([^)]*\)/g, '').trim();
          const first = t.split(/[,;]/)[0].trim();
          if (first === w || first.startsWith(w + ' ')) return j === 0 ? 0 : 1;
          if (best > 2 && whole.test(t)) best = 2;
        }
        return best;
      };
      const sc = new Map([...(common || [])].map(i => [i, score(i)]));
      return [...sc.keys()].sort((a, b) => sc.get(a) - sc.get(b) || a - b);
    }
    const s = new Set(); for (const key of prefix(D.laK, lat(q), 600)) for (const i of D.laI.get(key)) s.add(i);
    const k = lat(q);
    return [...s].sort((a, b) => (lat(D.S[b].t || '') === k) - (lat(D.S[a].t || '') === k) || a - b);
  }

  /* --- звук: Azure из хранилища (в кэш), иначе голос телефона --- */
  const elVoice = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []).find(v => /^el(-|_|$)/i.test(v.lang));
  let audio = null;
  const sayText = t => t.replace(/\//g, ' ').normalize('NFC').replace(/\s+/g, ' ').trim();  /* «ο/η γιατρός» → «ο η γιατρός»; так же — функция golos */
  function phoneVoice(text) {
    const v = elVoice(); if (!v) return false;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = 0.9;
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
.slv-art { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; display: grid; gap: 12px; }
.slv.android .slv-back { display: none; }  /* на Android — системный жест «назад» */
.slv-link { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.slv-back { justify-self: start; border: 0; background: none; color: var(--accent); font: 600 calc(15px + var(--up, 0px)) var(--f-ui); padding: 0; cursor: pointer; }
.slv-head { display: flex; align-items: center; gap: 10px; }
.slv-head h1 { flex: 1; margin: 0; font: 600 calc(32px + var(--up, 0px))/1.15 var(--f-el); text-wrap: balance; }
.slv-say { flex: none; width: calc(48px + 2 * var(--up, 0px)); height: calc(48px + 2 * var(--up, 0px)); border: 0; border-radius: 14px; background: var(--accent-soft); color: var(--accent); display: inline-grid; place-items: center; padding: 0; cursor: pointer; }
.slv-say svg { width: 58%; height: 58%; }
.slv-say.on { background: var(--accent); color: var(--accent-ink); }
.slv-meta { margin: -6px 0 0; font-size: calc(14px + var(--up, 0px)); color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 10px; }
.slv-meta .ipa { font-family: var(--f-el); }
.slv-note { margin: 0; font-size: calc(15px + var(--up, 0px)); background: var(--paper); border-radius: 10px; padding: 8px 12px; }
.slv-z { margin: 0; padding-left: 24px; display: grid; gap: 12px; }
.slv-z .ru { font-size: calc(17px + var(--up, 0px)); font-weight: 600; }
.slv-z .lb { font-style: italic; color: var(--muted); font-weight: 400; margin-right: 4px; }
.slv-ex { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 4px; }
.slv-ex li { padding-left: 10px; border-left: 2px solid var(--line); }
.slv-ex .e { font: calc(16px + var(--up, 0px))/1.4 var(--f-el); }
.slv-exsay { border: 0; background: var(--accent-soft); color: var(--accent); width: calc(30px + var(--up, 0px)); height: calc(30px + var(--up, 0px)); border-radius: 8px; padding: 0; margin-left: 6px; display: inline-grid; place-items: center; vertical-align: -6px; cursor: pointer; }
.slv-exsay svg { width: 62%; height: 62%; }
.slv-exsay.on { background: var(--accent); color: var(--accent-ink); }
.slv-ex .r { display: block; color: var(--muted); font-size: calc(15px + var(--up, 0px)); }
.slv-src { font-size: calc(11px + var(--up, 0px)); font-weight: 700; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 6px; white-space: nowrap; vertical-align: 1px; }
.slv-art h2 { margin: 6px 0 0; font-size: calc(13px + var(--up, 0px)); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.slv-ph { display: grid; gap: 6px; }
.slv-ph div { font-size: calc(15px + var(--up, 0px)); }
.slv-ph .e { font: calc(16px + var(--up, 0px)) var(--f-el); }
.slv-forms { font: calc(16px + var(--up, 0px))/1.5 var(--f-el); color: var(--muted); }
`;
  const ANDROID = /android/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent);
  const SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  const brief = s => s.z.slice(0, 3).map(z => z.ru).join('; ');

  function mount(root, opts) {
    if (!document.getElementById('slv-css')) { const st = document.createElement('style'); st.id = 'slv-css'; st.textContent = CSS; document.head.appendChild(st); }
    /* поле без подсказок: нестандартное name/id, autocomplete/autocorrect выкл. — Chrome не подставляет прошлые вводы, клавиатура не правит */
    root.innerHTML = `<div class="slv${ANDROID ? ' android' : ''}">
      <input class="slv-q" type="search" name="slv-poisk-x" id="slv-poisk-${Math.random().toString(36).slice(2, 8)}" placeholder="Греческое или русское слово" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Поиск по словарю" data-lpignore="true" data-form-type="other">
      <p class="slv-st"></p><div class="slv-bar hidden"><i></i></div>
      <div class="slv-list"></div>
      <article class="slv-art hidden"></article></div>`;
    const $ = sel => root.querySelector(sel), q = $('.slv-q'), st = $('.slv-st'), list = $('.slv-list'), art = $('.slv-art');
    let res = [], shown = 100, cur = null, want = null, listY = 0;

    const status = () => { st.textContent = D ? `${num(D.n)} статей · ищется по-гречески, латиницей и по-русски` : ''; };
    function drawList() {
      if (!D) return;
      const val = q.value.trim(), row = i => { const s = D.S[i]; return `<button data-i="${i}"><span class="w">${esc(s.s)}</span><span class="t">${esc(brief(s))}</span></button>`; };
      if (!val) {
        const rec = (readJ(RECENT) || []).map(l => D.by.get(l)).filter(i => i !== undefined);
        list.innerHTML = rec.length ? '<h3>Недавние</h3>' + rec.map(row).join('')
          : '<h3>Самые частые</h3>' + D.S.slice(0, 50).map((_, i) => row(i)).join('');
        return;
      }
      if (!res.length) { list.innerHTML = `<h3>Ничего не нашлось</h3>`; return; }
      list.innerHTML = res.slice(0, shown).map(row).join('') + (res.length > shown ? `<button class="more" data-more="1">ещё ${num(Math.min(100, res.length - shown))} из ${num(res.length - shown)}</button>` : '');
    }
    const run = () => { if (!D) return; res = search(q.value); shown = 100; drawList(); };
    let t = 0;
    q.addEventListener('input', () => {
      if (cur) { cur = null; art.classList.add('hidden'); list.classList.remove('hidden'); st.classList.remove('hidden'); opts.onBack && opts.onBack(); }  /* печатает поверх статьи — к списку, один шаг назад */
      clearTimeout(t); t = setTimeout(run, 120);
    });
    q.addEventListener('keydown', e => { if (e.key === 'Enter' && res.length) { q.blur(); pick(D.S[res[0]].l); } });
    list.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.more) { shown += 100; drawList(); return; }
      pick(D.S[+b.dataset.i].l);
    });
    const pick = l => opts.onPick ? opts.onPick(l) : api.show(l);
    art.addEventListener('click', e => {
      if (e.target.closest('.slv-back')) { opts.onBack ? opts.onBack() : api.show(null); return; }
      const lk = e.target.closest('.slv-link'); if (lk) { pick(lk.dataset.l); return; }
      if (!cur) return;
      const s = D.S[D.by.get(cur)];
      const b = e.target.closest('.slv-say');
      if (b) { play(sayText(s.s), s.a && D.zvuk ? D.zvuk + s.a + '.mp4' : null, b); return; }
      const x = e.target.closest('.slv-exsay');
      if (x) { const ex = s.z[+x.dataset.z].ex[+x.dataset.x]; play(sayText(ex.el), ex.a && D.zvukP ? D.zvukP + ex.a + '.mp4' : null, x); }
    });

    function article(l) {
      const i = D.by.get(l); if (i === undefined) return false;
      const s = D.S[i];
      let h = `<button class="slv-back">← ${q.value.trim() ? 'к списку' : 'к поиску'}</button>
        <div class="slv-head"><h1 lang="el">${esc(s.s)}</h1><button class="slv-say" aria-label="Произнести">${SPK}</button></div>
        <p class="slv-meta">${s.i ? `<span class="ipa">${esc(s.i)}</span>` : ''}${s.p ? `<span>${esc(s.p)}</span>` : ''}${s.v ? `<span>№ ≈ ${num(s.v[0])} по частоте, вместе с <button class="slv-link" lang="el" data-l="${esc(s.v[1])}">${esc(s.v[1])}</button></span>` : s.r ? `<span>№ ${num(s.r)} по частоте</span>` : ''}</p>`;
      if (s.n) h += `<p class="slv-note">${esc(s.n)}</p>`;
      h += '<ol class="slv-z">' + s.z.map((z, zi) => `<li><span class="ru">${z.lb ? `<span class="lb">${esc(z.lb)}</span>` : ''}${esc(z.ru)}</span>${z.ex ? '<ul class="slv-ex">' + z.ex.map((x, xi) =>
        `<li><span class="e" lang="el">${esc(x.el)}</span><button class="slv-exsay" data-z="${zi}" data-x="${xi}" aria-label="Произнести пример">${SPK}</button>${SRC[x.src] ? `<span class="slv-src">${SRC[x.src]}</span>` : ''}<span class="r">${esc(x.ru)}</span></li>`).join('') + '</ul>' : ''}</li>`).join('') + '</ol>';
      if (s.f) h += '<h2>Выражения</h2><div class="slv-ph">' + s.f.map(x => `<div><span class="e" lang="el">${esc(x.el)}</span> — ${esc(x.ru)}</div>`).join('') + '</div>';
      if (s.c && s.c.length) h += `<h2>Частые формы</h2><div class="slv-forms" lang="el">${s.c.map(esc).join(', ')}</div>`;
      art.innerHTML = h;
      const rec = (readJ(RECENT) || []).filter(x => x !== l); rec.unshift(l);
      try { localStorage.setItem(RECENT, JSON.stringify(rec.slice(0, 30))); } catch (e) {}
      return true;
    }

    const api = {
      show(l) {  /* l — статья; null — список */
        want = l;
        if (!D) return;
        const was = cur, y = window.scrollY;
        cur = l && article(l) ? l : null;
        if (cur && !was) listY = y;  /* уходим со списка в статью — запомнить прокрутку */
        art.classList.toggle('hidden', !cur); list.classList.toggle('hidden', !!cur); st.classList.toggle('hidden', !!cur);
        if (!cur) drawList();
        if (cur) window.scrollTo(0, 0);
        else if (was) {  /* назад к списку — на прежнее место; запрос в поле остаётся */
          const y = listY; window.scrollTo(0, y);
          requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));  /* браузер после popstate восстанавливает свою прокрутку — поверх неё */
        }
        /* список → список (повторный вызов маршрута) — прокрутку не трогаем */
      },
      focus() { if (D && !cur) q.focus({ preventScroll: true }); },
      ready: null
    };
    st.textContent = 'Загружаю словарь…';
    const bar = $('.slv-bar');
    api.ready = load(f => { bar.classList.remove('hidden'); bar.firstElementChild.style.width = Math.min(100, f * 100).toFixed(0) + '%'; st.textContent = `Загружаю словарь — один раз, дальше без сети · ${Math.min(99, Math.round(f * 100))} %`; })
      .then(() => { bar.classList.add('hidden'); status(); if (q.value.trim()) run(); api.show(want); })
      .catch(e => { bar.classList.add('hidden'); st.textContent = e.message || String(e); });
    return api;
  }

  window.Slovar = { mount, load, search: q => (D ? search(q) : []), get data() { return D; } };
})();
