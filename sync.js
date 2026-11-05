/* Экмафиси — вход, содержимое и синхронизация.
   Порядок: вход (Google через Supabase) → допуск по списку адресов → список текстов → загрузка app.js.
   Всё пишется сначала на устройстве (localStorage), отправляется при изменении, подтягивается при открытии и возвращении.
   Спор двух устройств по фразе — побеждает позднее изменение; журнал сливается по id. */
(() => {
  const C = window.EKM_CONFIG;
  const $ = id => document.getElementById(id);
  const DEV = location.hostname === 'localhost' && (new URLSearchParams(location.search).has('dev') || sessionStorage.getItem('ekmafisi.dev') === '1');
  if (DEV) sessionStorage.setItem('ekmafisi.dev', '1');
  const sb = DEV ? null : supabase.createClient(C.url, C.key, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });
  const UKEY = 'ekmafisi.user';  /* кто вошёл на этом устройстве — чтобы без сети открыть приложение без запроса к серверу */
  const readJ = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const writeJ = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const iso = x => new Date(x).toISOString();  /* время сервера и устройства — к одному виду, чтобы сравнивать строками */

  const EK = window.EK = { DEV, uid: null, email: null, lib: [], status: '', onRemote: null, onStatus: null };
  const K = k => 'ekmafisi.' + EK.uid + '.' + k;  /* данные каждого человека — под его id: двое на одном телефоне не смешиваются */

  function screen(id) {
    ['login', 'gate'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  }
  function setStatus(s) { EK.status = s; EK.onStatus && EK.onStatus(s); }

  /* --- содержимое: тексты, словарь, звук — из закрытого хранилища по ссылке с подписью; хранится в своём кэше --- */
  const CC = 'ekmafisi-content-v1';
  const ckey = path => new URL('c/' + path, location.origin + location.pathname).href;
  async function fetchRemote(path) {
    if (DEV) return fetch('../build/content/' + path, { cache: 'no-store' });
    const { data, error } = await sb.storage.from(C.bucket).createSignedUrl(path, 600);
    if (error) throw error;
    return fetch(data.signedUrl);
  }
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
    const r = await EK.content('library.json', navigator.onLine);
    const lib = await r.json();
    /* старые версии звука и словаря — из кэша вон */
    const keep = new Set([ckey('library.json')]);
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
  EK.queueProgress = row => { const o = out(); o.p[row.text_id + '/' + row.phrase_id] = row; saveOut(o); later(); };
  EK.queueLog = row => { const o = out(); o.l.push(row); saveOut(o); later(); };
  EK.queueSettings = (key, v, t) => { const o = out(); o.s[key] = { v, t }; saveOut(o); later(); };
  EK.pending = () => { const o = out(); return Object.keys(o.p).length + o.l.length + Object.keys(o.s).length; };

  /* --- синхронизация: отправить очередь, затем подтянуть изменённое с прошлого раза --- */
  let busy = false, again = false;
  async function sync() {
    if (DEV || !EK.uid) return;
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
    const s = document.createElement('script'); s.src = 'app.js';
    document.body.appendChild(s);
  }
  function gate(msg, withOut) {
    screen('gate'); $('gateMsg').textContent = msg;
    $('gateOut').classList.toggle('hidden', !withOut);
  }
  $('gateOut').onclick = () => EK.signOut();
  $('gateRetry').onclick = () => location.reload();
  $('loginBtn').onclick = async () => {
    $('loginBtn').disabled = true;
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } });
    if (error) { $('loginBtn').disabled = false; $('loginErr').textContent = 'Не вышло: ' + error.message; }
  };

  async function start(u) {
    EK.uid = u.id; EK.email = u.email;
    try { EK.lib = await loadLibrary(); }
    catch (e) {
      console.warn('library', e);
      return gate(navigator.onLine ? 'Тексты не загрузились. Попробуйте ещё раз.' : 'Нет сети, а тексты на этом телефоне ещё не загружались. Откройте приложение один раз со связью.', true);
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
      $('loginBtn').disabled = false; return screen('login');
    }
    const u = { id: session.user.id, email: session.user.email };
    if (!known || known.id !== u.id) {  /* первый вход этого человека здесь — допуск спросить у сервера */
      const { data: ok, error } = await sb.rpc('is_allowed');
      if (error) return gate('Сервер не ответил. Попробуйте ещё раз.', true);
      if (!ok) return gate(`Адрес ${u.email} пока не в списке. Напишите Антону — он добавит.`, true);
    }
    writeJ(UKEY, u);
    start(u);
  })();
})();
