/* Экмафиси — вход, содержимое и синхронизация.
   Порядок: вход (Google через Supabase) → допуск по списку адресов → список текстов → загрузка app.js.
   Без входа или с адресом не из списка — гость (EK.guest, решение 25.11.2026): открытые тексты (library-open.json),
   словарь, «Слова»; прогресс только на устройстве, без «Собери» и озвучки по запросу.
   Всё пишется сначала на устройстве (localStorage), отправляется при изменении, подтягивается при открытии и возвращении.
   Спор двух устройств по фразе — побеждает позднее изменение; журнал сливается по id.
   Тот же файл — вход и хранилище отдельного приложения «Словарь» (slovar-app/, EKM_CONFIG.app = 'slovar'):
   там нет списка текстов и синхронизации, вместо app.js грузится EKM_CONFIG.main. */
(() => {
  const C = window.EKM_CONFIG;
  const ONLY_LEX = C.app === 'slovar';
  const $ = id => document.getElementById(id);
  const DEV = ['localhost', '127.0.0.1'].includes(location.hostname) && (new URLSearchParams(location.search).has('dev') || sessionStorage.getItem('ekmafisi.dev') === '1');
  if (DEV) sessionStorage.setItem('ekmafisi.dev', '1');
  const sb = DEV ? null : supabase.createClient(C.url, C.key, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });
  const UKEY = 'ekmafisi.user';  /* кто вошёл на этом устройстве — чтобы без сети открыть приложение без запроса к серверу */
  const readJ = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const writeJ = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const iso = x => new Date(x).toISOString();  /* время сервера и устройства — к одному виду, чтобы сравнивать строками */

  const EK = window.EK = { DEV, uid: null, email: null, guest: false, lib: [], status: '', onRemote: null, onStatus: null };
  const K = k => 'ekmafisi.' + EK.uid + '.' + k;  /* данные каждого человека — под его id: двое на одном телефоне не смешиваются */

  function screen(id) {
    ['login', 'gate'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  }
  function setStatus(s) { EK.status = s; EK.onStatus && EK.onStatus(s); }

  /* --- содержимое: тексты, словарь, звук — из закрытого хранилища по ссылке с подписью; хранится в своём кэше --- */
  const CC = 'ekmafisi-content-v1';
  const ckey = path => new URL('c/' + path, location.origin + location.pathname).href;
  async function fetchRemote(path) {
    if (DEV) return fetch((C.devContent || '../build/content/') + path, { cache: 'no-store' });
    const { data, error } = await sb.storage.from(C.bucket).createSignedUrl(path, 600);
    if (error) throw error;
    return fetch(data.signedUrl);
  }
  EK.remote = fetchRemote;  /* мимо кэша: словарь (slovar.js) держит свой кэш */
  /* fresh — сначала из сети (список текстов), иначе — из кэша (звук и словарь: имя файла меняется вместе с содержимым) */
  EK.content = async (path, fresh) => {
    const c = await caches.open(CC), k = ckey(path), hit = await c.match(k);
    if (hit && !fresh) return hit;
    try {
      const r = await fetchRemote(path);
      if (!r.ok) throw new Error(r.status);
      await c.put(k, r.clone());
      return r;
    } catch (e) { if (hit) return hit; throw e; }
  };
  async function loadLibrary() {
    const r = await EK.content(EK.guest ? 'library-open.json' : 'library.json', navigator.onLine);
    const lib = await r.json();
    /* старые версии звука и словаря — из кэша вон */
    const keep = new Set([ckey('library.json'), ckey('library-open.json'), ckey('el/slovar2-primery.json')]);  /* примеры словаря — режим «На слух» */
    lib.forEach(m => { keep.add(ckey(m.audio.file)); if (m.slovar) keep.add(ckey(m.slovar)); });
    caches.open(CC).then(c => c.keys().then(ks => ks.forEach(q => keep.has(q.url) || c.delete(q))));
    return lib;
  }

  /* --- очередь на отправку --- */
  const emptyOut = () => ({ p: {}, l: [], s: {} });
  const out = () => Object.assign(emptyOut(), readJ(K('outbox')) || {});
  const saveOut = o => writeJ(K('outbox'), o);
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = setTimeout(sync, 1500); };
  EK.queueProgress = row => { if (EK.guest) return; const o = out(); o.p[row.text_id + '/' + row.phrase_id] = row; saveOut(o); later(); };
  EK.queueLog = row => { if (EK.guest) return; const o = out(); o.l.push(row); saveOut(o); later(); };
  EK.queueSettings = (key, v, t) => { if (EK.guest) return; const o = out(); o.s[key] = { v, t }; saveOut(o); later(); };
  EK.pending = () => { const o = out(); return Object.keys(o.p).length + o.l.length + Object.keys(o.s).length; };

  /* --- синхронизация: отправить очередь, затем подтянуть изменённое с прошлого раза --- */
  let busy = false, again = false;
  async function sync() {
    if (DEV || !EK.uid || ONLY_LEX || EK.guest) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (busy) { again = true; return; }
    busy = true; clearTimeout(timer);
    try {
      const o = out(), pRows = Object.values(o.p), lRows = o.l.slice(), sKeys = Object.assign({}, o.s);
      if (pRows.length) { const { error } = await sb.rpc('push_progress', { rows: pRows }); if (error) throw error; }
      if (lRows.length) { const { error } = await sb.from('log').upsert(lRows, { onConflict: 'id', ignoreDuplicates: true }); if (error) throw error; }
      if (Object.keys(sKeys).length) { const { error } = await sb.rpc('push_settings', { patch: sKeys }); if (error) throw error; }
      /* убрать отправленное; то, что добавилось за время отправки, остаётся */
      const n = out();
      pRows.forEach(r => { const k = r.text_id + '/' + r.phrase_id; if (n.p[k] && n.p[k].updated_at === r.updated_at) delete n.p[k]; });
      const sent = new Set(lRows.map(r => r.id)); n.l = n.l.filter(r => !sent.has(r.id));
      Object.keys(sKeys).forEach(k => { if (n.s[k] && n.s[k].t === sKeys[k].t) delete n.s[k]; });
      saveOut(n);

      const cur = Object.assign({ p: '1970-01-01T00:00:00.000Z', l: '1970-01-01T00:00:00.000Z' }, readJ(K('cursor')) || {});
      const back = t => iso(new Date(t).getTime() - 120000);  /* запас на запись, что закончилась позже соседней */
      const [pr, lg, st] = await Promise.all([
        sb.from('progress').select('lang,text_id,phrase_id,cut,color,written,updated_at,synced_at').gt('synced_at', back(cur.p)).order('synced_at').limit(10000),
        sb.from('log').select('id,at,kind,lang,text_id,phrase_id,mode,color,lemma,created_at').gt('created_at', back(cur.l)).order('created_at').limit(10000),
        sb.from('settings').select('data').maybeSingle()
      ]);
      if (pr.error) throw pr.error; if (lg.error) throw lg.error; if (st.error) throw st.error;
      const P = pr.data.map(r => Object.assign(r, { updated_at: iso(r.updated_at) }));
      const L = lg.data.map(r => Object.assign(r, { at: iso(r.at) }));
      if (P.length) cur.p = iso(P[P.length - 1].synced_at);
      if (L.length) cur.l = iso(L[L.length - 1].created_at);
      writeJ(K('cursor'), cur);
      if (EK.onRemote) EK.onRemote({ progress: P, log: L, settings: (st.data && st.data.data) || {} });
      setStatus(EK.pending() ? 'pending' : 'synced');
    } catch (e) {
      console.warn('sync', e);
      setStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      busy = false;
      if (again) { again = false; later(); }
    }
  }
  EK.sync = sync;
  /* «Собери»: цепочки человека (таблица soberi_chains) и функция soberi — пополнить запас, «Моё тоже верно?» */
  EK.chains = async () => {
    if (DEV || EK.guest || !navigator.onLine) return null;
    const { data, error } = await sb.from('soberi_chains').select('id,lang,step,chain,state,created_at').eq('state', 'ready').order('created_at').limit(200);
    if (error) throw error;
    return data;
  };
  EK.chainState = (id, state) => DEV ? Promise.resolve() : sb.from('soberi_chains').update({ state }).eq('id', id).then(({ error }) => { if (error) throw error; });
  /* озвучка по запросу (функция golos): { url } — подписанная ссылка на mp3; без сети, в ?dev и при отказе — ошибка */
  EK.golos = async (text) => {
    if (DEV || !navigator.onLine) throw new Error('нет связи');
    if (EK.guest) throw new Error('только своим');
    const { data, error } = await sb.functions.invoke('golos', { body: { text } });
    if (error) throw error;
    return data;
  };
  EK.fn = async (body) => {
    if (DEV) throw new Error('dev');
    if (EK.guest) throw new Error('только своим');
    const { data, error } = await sb.functions.invoke('soberi', { body });
    if (error) throw error;
    return data;
  };
  /* Настройки → «Пользователи» (только у admin в allowed): список допуска с расходом, добавить человека, поправить имя.
     В ?dev — пример, чтобы проверить вёрстку без сервера. */
  EK.admin = false;
  const DEV_USERS = [{ email: 'antoni@example.com', note: 'Антон', added_at: '2026-11-05T21:52:55Z', signed_in_at: '2026-11-24T22:29:51Z', ai_usd: 0.13957, golos_znaki: 293 },
    { email: 'drug@example.com', note: null, added_at: '2026-11-25T14:56:27Z', signed_in_at: null, ai_usd: null, golos_znaki: null }];
  EK.users = async () => {
    if (DEV) return DEV_USERS.map(u => Object.assign({}, u));
    const { data, error } = await sb.rpc('admin_users');
    if (error) throw error;
    return data;
  };
  EK.userPut = async (email, note) => {
    if (DEV) { const e = email.trim().toLowerCase(), u = DEV_USERS.find(x => x.email === e); if (u) u.note = note || null; else DEV_USERS.push({ email: e, note: note || null, added_at: new Date().toISOString(), signed_in_at: null, ai_usd: null, golos_znaki: null }); return; }
    const { error } = await sb.rpc('admin_user_put', { p_email: email, p_note: note });
    if (error) throw error;
  };
  /* --- «Фразы на блокировке» (27.11.2026): история с телефона — в таблице fraza_istoriya; родная часть Android пишет её по
     ключу устройства (fraza_kluch), который ей передаёт ссылка из PWA (andrUrl). Кэш — на устройстве, под id человека.
     ?dev — пример из набора фраз (build/fraza), чтобы проверить без сервера --- */
  EK.frazaKluch = async () => {
    const k = K('fraza.kluch'), v = readJ(k);
    if (v || DEV || EK.guest || !navigator.onLine) return v || (DEV ? '00000000-0000-4000-8000-000000000000' : null);
    const { data, error } = await sb.rpc('fraza_kluch');
    if (error) { console.warn('fraza_kluch', error); return null; }
    writeJ(k, data); return data;
  };
  EK.frazaIstKesh = () => (EK.uid ? readJ(K('fraza.ist')) : null) || [];
  EK.frazaIst = async () => {
    if (EK.guest) return [];
    if (DEV) {
      const s = await (await fetch('../build/fraza/slovar-el.json')).json(), t0 = Date.parse('2026-11-20T08:00:00Z');
      return s.slice(200, 260).map((x, i) => ({ id: 'dev' + i, lang: 'el', f: x.f, ru: x.ru, podpis: x.l, ist: 'slovar', zv: x.z,
        pokazov: 1 + i % 3, zvukov: i % 4 === 0 ? 2 : 0, zvezda: i % 9 === 0, pervyj: new Date(t0 + i * 36e5).toISOString(), poslednij: new Date(t0 + i * 36e5).toISOString() }));
    }
    if (!navigator.onLine) return EK.frazaIstKesh();
    const { data, error } = await sb.from('fraza_istoriya').select('id,lang,f,ru,podpis,ist,zv,pokazov,zvukov,zvezda,pervyj,poslednij').order('pervyj').limit(5000);
    if (error) { console.warn('fraza_istoriya', error); return EK.frazaIstKesh(); }
    writeJ(K('fraza.ist'), data); return data;
  };
  async function checkAdmin() {
    const k = K('admin');
    EK.admin = DEV || readJ(k) === true;
    if (DEV || EK.guest || !navigator.onLine) return;
    const { data, error } = await sb.rpc('is_admin');
    if (!error) { EK.admin = data === true; writeJ(k, EK.admin); }
  }
  document.addEventListener('visibilitychange', () => sync());  /* вернулся — подтянуть; ушёл — отправить */
  addEventListener('online', () => sync());
  addEventListener('offline', () => setStatus('offline'));

  EK.signOut = async () => {
    try { await sync(); } catch (e) {}
    localStorage.removeItem(UKEY);
    if (sb) await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    sessionStorage.removeItem('ekmafisi.dev');
    location.replace(location.pathname);
  };

  /* --- запуск --- */
  function runApp() {
    screen('none');
    const s = document.createElement('script'); s.src = C.main || 'app.js';
    document.body.appendChild(s);
  }
  function gate(msg, withOut) {
    screen('gate'); $('gateMsg').textContent = msg;
    $('gateOut').classList.toggle('hidden', !withOut);
  }
  $('gateOut').onclick = () => EK.signOut();
  $('gateRetry').onclick = () => location.reload();
  /* вход Google — с экрана входа «Словаря» (#loginBtn) и из настроек Экмафиси (EK.signIn); вернётся сюда же с ?code= */
  EK.signIn = async () => {
    if (DEV) return;
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } });
    if (error) throw error;
  };
  if ($('loginBtn')) $('loginBtn').onclick = async () => {
    $('loginBtn').disabled = true;
    try { await EK.signIn(); } catch (e) { $('loginBtn').disabled = false; $('loginErr').textContent = 'Не вышло: ' + e.message; }
  };

  /* гость: email — вошёл, но адреса нет в списке (null — не входил); прогресс — под общим id «gost» на этом устройстве */
  function guest(email) {
    EK.guest = true;
    return start({ id: 'gost', email: email || null });
  }
  async function start(u) {
    EK.uid = u.id; EK.email = u.email;
    if (ONLY_LEX) return runApp();
    checkAdmin().catch(() => {});
    try { EK.lib = await loadLibrary(); }
    catch (e) {
      console.warn('library', e);
      return gate(navigator.onLine ? 'Тексты не загрузились. Попробуйте ещё раз.' : 'Нет сети, а тексты на этом телефоне ещё не загружались. Откройте приложение один раз со связью.', !EK.guest || !!EK.email);
    }
    runApp();
  }

  (async () => {
    if (DEV) return start({ id: 'dev', email: 'проверка без входа' });
    const known = readJ(UKEY);
    const hasCode = new URLSearchParams(location.search).has('code');
    if (!navigator.onLine && known && !hasCode) return start(known);  /* без сети — тем, кто уже входил здесь */
    const timeout = new Promise(r => setTimeout(() => r({ data: { session: null }, timeout: true }), 8000));
    const res = await Promise.race([sb.auth.getSession(), timeout]);
    if (hasCode) history.replaceState(history.state, '', location.pathname + location.hash);  /* ?code= после входа — из адреса вон */
    const session = res.data && res.data.session;
    if (!session) {
      if (known && (res.timeout || !navigator.onLine)) return start(known);
      return guest(null);
    }
    const u = { id: session.user.id, email: session.user.email };
    if (!known || known.id !== u.id) {  /* первый вход этого человека здесь — допуск спросить у сервера */
      const { data: ok, error } = await sb.rpc('is_allowed');
      if (error) return gate('Сервер не ответил. Попробуйте ещё раз.', true);
      if (!ok) return guest(u.email);
    }
    writeJ(UKEY, u);
    start(u);
  })();
})();
