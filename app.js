window.__taifas = true;   // 8.20.1: semn pentru index.html că app.js s-a încărcat
const APP_VER = '9.12';

/* ───────── utilitare ───────── */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let toastT;
function toast(t, ms = 2600){ const el = $('#toast'); el.textContent = t; clearTimeout(toastT); toastT = setTimeout(() => el.textContent = '', ms); }

/* ───────── stocare: IndexedDB, un singur depozit cheie→valoare ───────── */
const LATER = {};   // 8.19: ce face fiecare sarcină de fundal cu rezultatul ei (direct sau din lotul Batch)
const DB = {
  db: null,
  open(){ return new Promise((res, rej) => {
    const r = indexedDB.open('taifas2', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { this.db = r.result; res(); };
    r.onerror = () => rej(r.error);
  }); },
  _req(mode, fn){ return new Promise((res, rej) => {
    const st = this.db.transaction('kv', mode).objectStore('kv');
    const q = fn(st); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  }); },
  get(k){ return this._req('readonly', s => s.get(k)); },
  set(k, v){ return this._req('readwrite', s => s.put(v, k)); },
  del(k){ return this._req('readwrite', s => s.delete(k)); },
  keys(){ return this._req('readonly', s => s.getAllKeys()); },
  clear(){ return this._req('readwrite', s => s.clear()); }
};

/* ───────── stare ───────── */
const DEF = {
  prov:'anthropic', key:'', model:'claude-sonnet-5-5',
  oaBase:'https://openrouter.ai/api/v1', oaKey:'', oaModel:'',
  userName:'', userAbout:'', len:'mediu', font:16,
  imgProv:'none', gemKey:'', gemModel:'gemini-2.5-flash-image',
  wkBase:'', wkTok:'', wkModel:'eco', wkSize:'768x1024',
  sugg:'off', pro:'on', feed:'text', fx:'on', regen3:'on', voice:'tap', tts:'tel', cfPlan:'free', cfCap:'free', elKey:'', elModel:'eleven_v3', theme:'dark', vmsg:'rar', jrn:'on', aux:'on', ctxN:'30',
  vault:'off', vaultHas:null, faceFix:'on', bodyFix:'off', bestOf:'3', autoModel:'chat', callFace:'on', imgCheck:'on', story:'on', sky:'on', social:'on', userBday:'', lock:'off', pushOn:false, bkEvery:'week', bkLast:0, userPhoto:'', userPhys:'', userBox:null, wkChat:'ancorat', wkRef:'auto', falKey:'', falModel:'fal-ai/flux-pulid', falSize:'576x768', spont:'rar', imgAlt:'fal', sv:34, imgCost:'', pIn:'', pOut:''
};
let S = {...DEF};
let chars = [];            // [{id,name,tag,photo,aspect,look,stil,persona,speech,greet,created,lastAt,last}]
let cur = null;            // personajul deschis
let chat = null;           // {msgs:[], summary:'', sumUpTo:0}
let busy = null;           // AbortController când se generează ceva
let live = null;           // {c, ch}: conversația în care se generează acum

const saveSettings = () => DB.set('settings', S);
const saveChars = () => DB.set('chars', chars);
const charById = id => chars.find(c => c.id === id);
// fire de conversație: firul „main" păstrează cheia veche chat:<id>, celelalte chat:<id>:<fir>
const chatKey = (cid, tid) => (!tid || tid === 'main') ? 'chat:' + cid : 'chat:' + cid + ':' + tid;
function threadsOf(c){ if(!c.threads || !c.threads.length) c.threads = [{id:'main', title:'Conversația 1', lastAt:c.lastAt || 0, last:c.last || ''}]; return c.threads; }
async function loadChat(c, tid){
  const ch = await DB.get(chatKey(c.id, tid)) || newChat(); ch.tid = tid;
  // dacă aplicația s-a închis în timpul unui răspuns, mesajul rămânea „scrie…” pentru totdeauna
  if(!(live && live.c === c && live.ch && (live.ch.tid || 'main') === tid))
    for(const m of ch.msgs){ if(m.pending || m.pendingImg){ delete m.pending; delete m.pendingImg; delete m.hold; delete m.rec; if(!m.text && !m.img) m.err = 'Oprit.'; } }
  delete ch._sumBusy;
  return ch;
}
async function saveChat(c = cur, ch = chat){
  if(!c || !ch || ch.dead || !charById(c.id)) return;      // conversație golită/ștearsă sau personaj șters: nu o mai rescriem
  delete ch._sumBusy;
  const tid = ch.tid || 'main';
  await DB.set(chatKey(c.id, tid), ch);
  const last = [...ch.msgs].reverse().find(m => (m.text || m.img) && !m.err);
  const preview = last ? (last.img && !last.text ? '📷 Poză' : (last.role === 'user' ? 'Tu: ' : '') + last.text.replace(/\*/g, '').slice(0, 90)) : '';
  const t = threadsOf(c).find(x => x.id === tid);
  if(t){ t.last = preview; t.lastAt = last ? last.ts : t.lastAt; }
  if((c.thread || 'main') === tid){ c.last = preview; c.lastAt = last ? last.ts : c.lastAt; }
  await saveChars();
}

/* ───────── imagini ───────── */
const urlCache = new Map();
async function imgUrl(k){
  if(!k) return '';
  if(urlCache.has(k)) return urlCache.get(k);
  const b = await DB.get(k); if(!b) return '';
  const u = URL.createObjectURL(b); urlCache.set(k, u); return u;
}
async function saveImg(blob){ const k = 'img:' + uid(); await DB.set(k, blob); return k; }
async function delImg(k){ if(!k) return; const u = urlCache.get(k); if(u) URL.revokeObjectURL(u); urlCache.delete(k); await DB.del(k); }
// șterge tot ce ține de un mesaj: poza, variantele ei și înregistrările vocale (fără poza de profil)
async function purgeMsg(m, c){
  const keep = c && c.photo;
  for(const k of new Set([m.img, ...(m.imgAlts || [])])) if(k && k !== keep) await delImg(k).catch(() => {});
  for(let a = 0; a < Math.max(1, (m.alts || []).length); a++) DB.del('aud:' + m.id + ':' + a).catch(() => {});
}
// o poză veche de profil se șterge doar dacă nu mai apare în nicio conversație
async function delPhotoIfUnused(c, k){
  if(!k) return;
  for(const ch of await allChats(c)) if(ch.msgs.some(m => m.img === k || (m.imgAlts || []).includes(k))) return;
  await delImg(k);
}
// când se șterg mesaje de dinaintea rezumatului, rezumatul nu mai e valabil
function cutAt(ch, i){ if((ch.sumUpTo || 0) > i){ ch.sumUpTo = 0; ch.summary = ''; } if((ch.sumNextTo || 0) > i){ delete ch.sumNext; delete ch.sumNextTo; } }
async function hydrate(root = document){
  for(const el of root.querySelectorAll('img[data-k]')){
    const u = await imgUrl(el.dataset.k);
    if(el.classList.contains('dev')){ el.onload = () => el.classList.add('go'); }
    el.decoding = 'async';   // 9.4: decodarea pozei nu mai blochează animațiile
    if(u) el.src = u; el.removeAttribute('data-k');
  }
  for(const el of root.querySelectorAll('[data-bgk]')){
    const u = await imgUrl(el.dataset.bgk); el.style.backgroundImage = u ? `url("${u}")` : ''; el.removeAttribute('data-bgk');
  }
}
function loadImgEl(src){ return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function toJpeg(file, max = 1280, q = .9){
  const u = URL.createObjectURL(file);
  try{
    const im = await loadImgEl(u);
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  } finally { URL.revokeObjectURL(u); }
}
const blobToB64 = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1]); f.onerror = () => rej(f.error); f.readAsDataURL(b); });
function b64ToBlob(b64, type = 'image/png'){ const s = atob(b64); const a = new Uint8Array(s.length); for(let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return new Blob([a], {type}); }
// 🖼️ avatar viu: poza mică se schimbă după momentul zilei și dispoziție (doar dacă ai generat variantele)
const AV_V = [
  ['dim', '🌅 Dimineața', 'cozy morning at home right after waking up, holding a cup of coffee, soft morning window light, relaxed sleepy smile'],
  ['zi', '☀️ Ziua', 'casual daytime outfit, natural daylight, relaxed friendly smile'],
  ['seara', '🌆 Seara', 'evening, warm golden lamp light, cozy atmosphere, gentle smile'],
  ['noapte', '🌙 Noaptea', 'late night at home, comfortable sweater, dim warm bedside lamp, soft tired expression'],
  ['vesel', '😄 Vesel', 'laughing happily, bright cheerful light, joyful expression'],
  ['trist', '😔 Pensiv', 'thoughtful pensive expression, looking slightly away from the camera, soft muted light']];
function avKeyNow(c){
  const mo = cur === c && chat && chat.mood && chat.mood.t ? chat.mood.t.toLowerCase() : '';
  if(/trist|supărat|obosit|melancol|dor|îngrijor|nervos|abătut/.test(mo)) return 'trist';
  if(/vesel|fericit|râde|entuziasm|amuzat|bine dispus|încântat|jucăuș/.test(mo)) return 'vesel';
  const h = new Date().getHours();
  return h >= 5 && h < 11 ? 'dim' : h < 17 ? 'zi' : h < 22 ? 'seara' : 'noapte';
}
function photoNow(c){
  if(!c || !c.avLive || !c.avs) return c && c.photo;
  return c.avs[avKeyNow(c)] || c.photo;
}
function avatarHTML(c, cls = 'av'){
  if(c && c.photo) return `<img class="${cls}" data-k="${esc(photoNow(c))}" alt="">`;
  return `<span class="${cls}" style="background:${colorFor(c)}">${esc((c?.name || '?')[0].toUpperCase())}</span>`;
}
function colorFor(c){ let h = 0; for(const ch of (c?.id || 'x')) h = (h * 31 + ch.charCodeAt(0)) % 360; return `linear-gradient(135deg,hsl(${h} 55% 38%),hsl(${(h + 50) % 360} 55% 28%))`; }

/* ───────── text: formatare ───────── */
// liniuțele lungi folosite ca legătură → virgulă; cratima (-) rămâne neatinsă
function faraLiniute(t){
  return String(t)
    .replace(/^\s*[–—―]\s*/gm, '')
    .replace(/\s*[–—―]\s*/g, ', ')
    .replace(/,\s*([,.!?…])/g, '$1')
    .replace(/([.!?…])\s*,/g, '$1')
    .replace(/ {2,}/g, ' ');
}
function fmtMsg(t){
  const src = String(t || '').replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0002').replace(/\.\.\./g, '…');
  const sayHTML = x => esc(x).replace(/\u0001/g, '<b>').replace(/\u0002/g, '</b>')
    .replace(/(„[^”\n]{1,80}”|«[^»\n]{1,80}»)/g, '<span class="q">$1</span>');
  const paras = src.split(/\n\s*\n/);
  return paras.map(pa => {
    const parts = pa.split(/(\*[^*\n]+\*)/).filter(x => x.trim());
    const hasSay = parts.some(x => !/^\*[^*\n]+\*$/.test(x));
    const inner = parts.map(p => {
      if(/^\*[^*\n]+\*$/.test(p)){
        const a = p.slice(1, -1).trim();
        // gest scurt în mijlocul vorbelor: rămâne pe același rând; narațiunea lungă: bloc separat
        return `<span class="act${hasSay && a.length <= 38 && parts.length > 1 ? ' inl' : ''}">${esc(a)}</span>`;
      }
      const x = p.replace(/^\s+|\s+$/g, ''); return x ? `<span class="say">${sayHTML(x)}</span>` : '';
    });
    // gesturile scurte se lipesc de vorbele vecine
    let out = '', line = '';
    inner.forEach(h => { if(h.includes('act inl') || (line && h.startsWith('<span class="say"'))){ line += (line ? ' ' : '') + h.replace('class="say"', 'class="say" style="display:inline"'); } else { if(line){ out += `<span class="say">${line}</span>`; line = ''; } if(h.startsWith('<span class="say"')) line = h.replace('class="say"', 'class="say" style="display:inline"'); else out += h; } });
    if(line) out += `<span class="say">${line}</span>`;
    return paras.length > 1 ? `<span class="para">${out}</span>` : out;
  }).join('');
}
const isJumbo = t => { const x = String(t || '').trim(); return x.length <= 12 && /^(\p{Extended_Pictographic}|‍|️|\s)+$/u.test(x); };
const hhmm = ts => ts ? new Date(ts).toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'}) : '';
function dayLabel(ts){
  const d = new Date(ts), n = new Date(), y = new Date(); y.setDate(n.getDate() - 1);
  if(d.toDateString() === n.toDateString()) return 'Azi';
  if(d.toDateString() === y.toDateString()) return 'Ieri';
  return d.toLocaleDateString('ro-RO', {day:'numeric', month:'long', ...(d.getFullYear() !== n.getFullYear() ? {year:'numeric'} : {})});
}
function fmt(t){
  let h = esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  h = h.replace(/\*([^*\n][^*]*?)\*/g, '<em class="act">$1</em>');
  return h;
}

/* ───────── furnizorul de text ───────── */
function provMsgs(msgs, ttl){
  const out = [];
  for(const m of msgs){
    const last = out[out.length - 1];
    if(last && last.role === m.role && !m.image && !last.image && !m.images && !last.images){ last.text += '\n\n' + m.text; if(m._cache) last._cache = true; continue; }
    out.push({...m});
  }
  if(!out.length || out[0].role !== 'user') out.unshift({role:'user', text:'(Începe conversația.)'});
  // punct de cache pe istoric: tot ce e până la mesajul marcat se citește din cache la ~10% din preț la răspunsul următor
  const cc = m => m._cache ? {cache_control:ttl === '1h' ? {type:'ephemeral', ttl:'1h'} : {type:'ephemeral'}} : {};
  const imgsOf = m => m.images || (m.image ? [m.image] : null);
  if(S.prov === 'anthropic') return out.map(m => ({role:m.role, content: imgsOf(m)
    ? [...imgsOf(m).map(d => ({type:'image', source:{type:'base64', media_type:'image/jpeg', data:d}})), {type:'text', text:m.text, ...cc(m)}]
    : (m._cache ? [{type:'text', text:m.text, ...cc(m)}] : m.text)}));
  return out.map(m => ({role:m.role, content: imgsOf(m)
    ? [...imgsOf(m).map(d => ({type:'image_url', image_url:{url:'data:image/jpeg;base64,' + d}})), {type:'text', text:m.text}] : m.text}));
}
async function errText(r){
  let t = r.statusText;
  try{ const j = await r.clone().json(); t = j.error?.message || j.message || JSON.stringify(j); }
  catch(e){ try{ const h = new URL(r.url).host; t = (t ? t + ', ' : '') + 'răspuns de la ' + h + (h === location.host ? ' (adresa e greșită: cererea a ajuns la aplicație, nu la serviciu)' : ''); }catch(_){} }
  if(r.status === 401) t = 'Cheie greșită (' + t + ')';
  return `${r.status}: ${t}`;
}
// trimite și primește bucată cu bucată; întoarce textul complet
// model mic pentru sarcinile de fundal (sugestii, memorie, rezumat, scenă foto, nume, jurnal)
const AUX_DEF = 'claude-haiku-5-5';
let auxBroken = false;
function modelFor(aux){
  if(S.prov !== 'anthropic') return S.oaModel;
  if(aux && S.aux !== 'off' && !auxBroken) return (S.auxModel || AUX_DEF).trim();
  return S.model || DEF.model;
}
/* ───────── 🔐 8.20: seiful de chei ─────────
   „Cheile în Worker”: aplicația nu mai trimite nicio cheie; vorbește doar cu Worker-ul v8 (cu parola TOKEN),
   iar Worker-ul adaugă cheia din secretele Cloudflare. „Cheile în telefon”: ca înainte. */
const API_HOST = {anthropic:'https://api.anthropic.com', fal:'https://fal.run', eleven:'https://api.elevenlabs.io', gemini:'https://generativelanguage.googleapis.com'};
const vaultOn = () => S.vault === 'on' && !!String(S.wkBase || '').trim() && !!String(S.wkTok || '').trim();
function apiUrl(svc, path){ return vaultOn() ? wkUrl() + '/proxy/' + svc + path : API_HOST[svc] + path; }
function apiHeaders(svc, extra = {}){
  if(vaultOn()) return {...extra, authorization:'Bearer ' + S.wkTok.trim()};
  const k = svc === 'anthropic' ? {'x-api-key':S.key.trim(), 'anthropic-dangerous-direct-browser-access':'true'}
    : svc === 'fal' ? {authorization:'Key ' + S.falKey.trim()}
    : svc === 'eleven' ? {'xi-api-key':S.elKey.trim()}
    : {'x-goog-api-key':S.gemKey.trim()};
  return {...extra, ...k};
}
// seif: ce chei are Worker-ul (aflat la „Verifică seiful”); necunoscut = presupunem că există și lăsăm Worker-ul să spună
const hasKey = svc => vaultOn() ? !(S.vaultHas && S.vaultHas[svc] === false) : !!String({anthropic:S.key, fal:S.falKey, eleven:S.elKey, gemini:S.gemKey}[svc] || '').trim();
// adresele întoarse de Anthropic (results_url) trec și ele prin seif
function anthUrl(u){ try{ const x = new URL(u); if(x.host !== 'api.anthropic.com') throw 0; return apiUrl('anthropic', x.pathname); }catch(e){ throw new Error('Adresă neașteptată de la Anthropic.'); } }
async function stream(sys, msgs, opts = {}){
  try{ return await streamOnce(sys, msgs, opts); }
  catch(e){
    // dacă modelul mic nu e disponibil pe cont, revenim o dată la modelul principal
    if(opts.aux && S.prov === 'anthropic' && !auxBroken && /model|not_found|404/i.test(e.message || '')){ auxBroken = true; return await streamOnce(sys, msgs, {...opts, aux:false}); }
    throw e;
  }
}
async function streamOnce(sys, msgs, {max = 700, signal, onText, cid, aux, meta, tag, cold, conv} = {}){
  const A = S.prov === 'anthropic';
  const model = modelFor(aux);
  // 8.17: conversația rămâne în cache 1 oră (nu 5 minute): la pauze mai lungi istoricul se recitește la 5-10% din preț
  // 8.19: primul mesaj după o pauză (cache-ul a expirat oricum) scrie la 1,25× (5 min); de la al doilea trece pe 1 oră
  // 9.0: cache doar pentru conversații (conv); pașaportul, jurnalul, planificarea pozelor etc. se trimit o singură dată,
  //      iar scrierea în cache (2× pe 1 h, 1,25× pe 5 min) ar fi fost plătită degeaba
  const ttl = conv && !aux && !cold && S.cacheTtl !== '5m' ? '1h' : '';
  if(A && !hasKey('anthropic')) throw new Error(vaultOn() ? 'Seiful (Worker-ul) nu are cheia Anthropic.' : 'Lipsește cheia Anthropic. Deschide Setări.');
  if(!A && !(S.oaBase && S.oaModel)) throw new Error('Completează adresa și modelul în Setări.');
  const res = A
    ? await fetch(apiUrl('anthropic', '/v1/messages'), {method:'POST', signal, headers:apiHeaders('anthropic', {
        'content-type':'application/json', 'anthropic-version':'2023-06-01'}),
        body: JSON.stringify({model, max_tokens:max, stream:true,
          system:[{type:'text', text:sys, ...(conv ? {cache_control:ttl ? {type:'ephemeral', ttl:'1h'} : {type:'ephemeral'}} : {})}], messages:provMsgs(conv ? msgs : msgs.map(x => x._cache ? {...x, _cache:false} : x), ttl)})})
    : await fetch(S.oaBase.replace(/\/+$/, '') + '/chat/completions', {method:'POST', signal, headers:{
        'content-type':'application/json', ...(S.oaKey ? {authorization:'Bearer ' + S.oaKey.trim()} : {})},
        body: JSON.stringify({model:S.oaModel, stream:true, max_tokens:max, ...(/openai|openrouter|groq|deepseek|together|mistral/i.test(S.oaBase) ? {stream_options:{include_usage:true}} : {}),
          messages:[{role:'system', content:sys}, ...provMsgs(msgs)]})});
  if(!res.ok) throw new Error(await errText(res));
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '', usage = null, stop = null, ended = false;
  try{
  for(;;){
    let done, value;
    try{ ({done, value} = await rd.read()); }catch(e){ if(e.name === 'AbortError' || !full) throw e; break; }
    if(done) break;
    buf += dec.decode(value, {stream:true});
    let i;
    while((i = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if(!line.startsWith('data:')) continue;
      const d = line.slice(5).trim(); if(!d || d === '[DONE]') continue;
      let j; try{ j = JSON.parse(d); }catch(e){ continue; }
      let piece = '';
      if(A){
        if(j.type === 'content_block_delta' && j.delta?.text) piece = j.delta.text;
        else if(j.type === 'message_start' && j.message?.usage) usage = {...j.message.usage};
        else if(j.type === 'message_delta'){ if(j.usage) usage = Object.assign(usage || {}, j.usage); if(j.delta?.stop_reason) stop = j.delta.stop_reason; }
        else if(j.type === 'message_stop') ended = true;
        else if(j.type === 'error') throw new Error(j.error?.message || 'eroare de la furnizor');
      } else { piece = j.choices?.[0]?.delta?.content || ''; if(j.usage) usage = j.usage; const fr = j.choices?.[0]?.finish_reason; if(fr){ stop = fr === 'length' ? 'max_tokens' : fr === 'content_filter' ? 'refusal' : fr; ended = true; } }
      if(piece){ full += piece; onText && onText(full); }
    }
  }
  } finally { recordTokens(cid, usage, model, tag || (aux ? 'fundal' : 'chat')); if(meta){ meta.stop = stop || (ended ? 'end_turn' : 'cut'); if(usage) meta.u = {cw:usage.cache_creation_input_tokens || 0, cr:usage.cache_read_input_tokens || 0}; } }
  return full;
}
// taie textul la ultima propoziție (sau acțiune) încheiată; dacă ar pierde prea mult, îl lasă cu „…”
function trimToSentence(t){
  t = String(t || '').trimEnd(); if(!t) return t;
  if(/[.!?…”"*)\]]$/.test(t)) return t;
  let best = -1; const re = /[.!?…](?=\s|$)|\*(?=\s|$)/g; let mm;
  while((mm = re.exec(t))) best = mm.index + 1;
  if(best > t.length * .45) return t.slice(0, best).trimEnd();
  return t.replace(/\s+\S*$/, '') + '…';
}
// 8.9.1: JSON tolerant: ghilimele neescapate în texte, rânduri noi, virgule în plus, răspuns tăiat la jumătate
function repairJSON(s){
  let out = '', inStr = false; const stack = [];
  for(let i = 0; i < s.length; i++){
    const ch = s[i];
    if(inStr){
      if(ch === '\\'){ out += ch + (s[i + 1] ?? ''); i++; continue; }
      if(ch === '"'){ let j = i + 1; while(j < s.length && /\s/.test(s[j])) j++; const nx = s[j]; if(nx === undefined || ',}]:'.includes(nx)){ inStr = false; out += ch; } else out += '\\"'; continue; }
      if(ch === '\n'){ out += '\\n'; continue; }
      if(ch === '\r' || ch === '\t'){ out += ' '; continue; }
      out += ch; continue;
    }
    if(ch === '"'){ inStr = true; out += ch; continue; }
    if(ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if(ch === '}' || ch === ']') stack.pop();
    out += ch;
  }
  if(inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  while(stack.length) out += stack.pop();
  return out.replace(/,\s*([}\]])/g, '$1');
}
function parseJSON(t){
  const s = String(t).replace(/```(?:json)?/gi, ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if(a < 0) throw new Error('Răspuns neașteptat de la AI.');
  if(b > a){ try{ return JSON.parse(s.slice(a, b + 1)); }catch(e){} }
  let src = s.slice(a);
  for(let k = 0; k < 40 && src.length > 1; k++){
    try{ return JSON.parse(repairJSON(src)); }catch(e){}
    const cut = Math.max(src.lastIndexOf(','), src.lastIndexOf('{', src.length - 2), src.lastIndexOf('[', src.length - 2));   // renunțăm la ultimul element neterminat
    if(cut <= 0) break; src = src.slice(0, cut);
  }
  throw new Error('Răspunsul AI n-a ieșit complet. Mai încearcă.');
}

/* ───────── poză → descriere 1:1 ───────── */
const DESC_PROMPT = `Descrie persoana sau personajul din imagine cât mai fidel, 1:1, astfel încât cineva să-l poată recunoaște sau redesena exact.
Include, unde se vede: vârsta aparentă, forma feței, ochii (culoare, formă), sprâncenele, nasul, buzele, tenul, părul (culoare, lungime, textură, coafură), părul facial, constituția și înălțimea aparentă, semnele distinctive (alunițe, pistrui, tatuaje, piercinguri, ochelari), hainele și accesoriile, expresia și postura.
Descrie doar ce se vede, fără presupuneri despre personalitate. Nu inventa ce nu se vede.
Răspunde STRICT cu JSON, fără alt text:
{"aspect":"descrierea în română, la persoana a III-a, 5-8 propoziții naturale","look":"the same physical description in English as comma-separated tags for an image generator, max 70 words, face and hair first","stil":"photo|anime|illustration|3d","nume":["3 prenume diferite care s-ar potrivi cu înfățișarea și stilul persoanei; amestecă românești și internaționale"]}`;
async function describePhoto(blob){
  const b64 = await blobToB64(blob);
  const out = await stream('Ești un observator atent care descrie imagini cu precizie.', [{role:'user', text:DESC_PROMPT, image:b64}], {max:1200});
  const j = parseJSON(out);
  return {aspect: faraLiniute(String(j.aspect || '').trim()), look: String(j.look || '').trim(), stil: ['photo','anime','illustration','3d'].includes(j.stil) ? j.stil : 'photo',
    names: (Array.isArray(j.nume) ? j.nume : []).map(x => String(x).trim()).filter(x => x && x.length < 30).slice(0, 3)};
}
async function verifyPhoto(blob, aspect, look){
  const b64 = await blobToB64(blob);
  const ask = `Mai jos e descrierea scrisă a persoanei din imagine. Compar-o cu imaginea, detaliu cu detaliu: vârstă, față, ochi, sprâncene, nas, buze, ten, păr (culoare, lungime, coafură), constituție, semne distinctive, haine, accesorii, expresie.
Corectează tot ce e greșit, adaugă ce se vede și lipsește, scoate ce nu se vede în imagine. Păstrează neschimbate formulările corecte.

DESCRIEREA (română):
${aspect || '(goală)'}

DESCRIEREA PENTRU IMAGINI (engleză):
${look || '(goală)'}

Răspunde STRICT cu JSON, fără alt text:
{"corecturi":["fiecare corectură, scurt: «era X, în poză e Y» sau «adăugat: …» sau «scos: …»"],"aspect":"descrierea completă corectată, în română, 5-8 propoziții","look":"the full corrected English tag description, max 70 words, face and hair first"}
Dacă descrierea se potrivește perfect, "corecturi" e o listă goală.`;
  const out = await stream('Ești un verificator atent: compari texte cu imagini și găsești orice nepotrivire.', [{role:'user', text:ask, image:b64}], {max:1500});
  const j = parseJSON(out);
  return {fixes: (Array.isArray(j.corecturi) ? j.corecturi : []).map(x => faraLiniute(String(x).trim())).filter(Boolean),
    aspect: faraLiniute(String(j.aspect || '').trim()) || aspect, look: String(j.look || '').trim() || look};
}
async function draftCharacter(d){
  const ask = `Creez un personaj pentru o aplicație de conversație.
Nume: ${d.name || '(alege tu un nume potrivit)'}
Aspect: ${d.aspect || '(necunoscut)'}
Ce am scris deja despre el: ${d.persona || '(nimic, inventează ceva potrivit cu aspectul)'}
${d.tag ? 'Pe scurt: ' + d.tag : ''}

Păstrează tot ce am scris și dezvoltă natural. Răspunde STRICT cu JSON:
{"name":"…","aspect":"${d.aspect ? 'lasă gol' : 'înfățișarea unui adult (peste 25 de ani), 4-6 propoziții: vârstă, față, ochi, păr, constituție, stil vestimentar'}","tag":"o frază scurtă și atrăgătoare pentru card, max 90 de caractere","persona":"personalitate, trecut, ce-i place, cum se poartă, relația cu interlocutorul; 5-8 propoziții, la persoana a II-a (Ești…, Îți place…)","speech":"stilul de vorbire în câteva cuvinte","greet":"prima replică, 1-3 propoziții, cu o acțiune între *asteriscuri*"}`;
  const out = await stream('Ești un scriitor de personaje. Scrii în română corectă, cu diacritice, fără liniuțe de dialog.', [{role:'user', text:ask}], {max:1200});
  const j = parseJSON(out);
  for(const k of Object.keys(j)) j[k] = faraLiniute(String(j[k] || '').trim());
  return j;
}

/* ───────── generare poze ───────── */
const STIL_TAG = {
  photo:'real unedited photo taken with a smartphone camera, candid everyday snapshot, photorealistic, natural skin texture with pores and small imperfections, realistic body proportions, natural light coming from the real light sources of the place, slight phone-camera noise, true-to-life colors, ordinary real-life surroundings, not a professional photoshoot, no studio lighting, no retouching, no beauty filter, no text, no watermark',
  anime:'high quality anime illustration, clean lineart, soft cel shading, detailed eyes, no text',
  illustration:'polished digital illustration, painterly lighting, detailed face, no text',
  '3d':'high quality 3d render, soft global illumination, detailed face, no text'};
// adresa Worker-ului: adaugă https:// și /v1 dacă lipsesc (fără https://, cererea pleca spre site-ul aplicației → 405)
function wkUrl(){
  let u = String(S.wkBase || '').trim().replace(/\s+/g, '');
  if(!u) return '';
  if(!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  u = u.replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/, '');
  if(!/\/v1$/.test(u)) u += '/v1';
  return u;
}
/* ═════════ 📸 7.0 motorul de poze reale ═════════
   1. IDENTITATE: poza de profil întreagă (reper 1) + fața decupată (reper 2) + trăsăturile fizice citite O SINGURĂ DATĂ
      din poza de profil (fără haine), scrise în prompt. Toate trei trag spre aceeași persoană.
   2. SCENA: un planificator (Haiku) citește conversația și ține minte starea personajului pe fir (`ch.where`: loc, cameră,
      poziția corpului, haine, activitate, lumină). Ce s-a spus ultima dată în chat are prioritate; hainele rămân până se schimbă.
   3. CASA: camerele personajului (`c.home`) sunt descrise o dată și refolosite, ca dormitorul/bucătăria să arate la fel în fiecare poză.
   4. REALISM: poză de telefon, nu de studio; personajul e singur → selfie, selfie în oglindă sau telefonul sprijinit cu timer.
   5. VERIFICARE: Haiku compară poza nouă cu poza de profil și cu scena; dacă nu seamănă sau nu e locul, o reface o dată. */
const ROOM_RO = {bedroom:'Dormitor', 'living room':'Sufragerie', kitchen:'Bucătărie', bathroom:'Baie', hallway:'Hol', balcony:'Balcon', office:'Birou', 'home office':'Birou'};
const ROOM_KEY = Object.fromEntries(Object.entries(ROOM_RO).map(([k, v]) => [v.toLowerCase(), k]));
function todEn(){
  const d = new Date(), h = d.getHours(), day = d.toLocaleDateString('en-GB', {weekday:'long'});
  return day + ', ' + String(h).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' (' + (h < 5 ? 'late night, dark outside, only lamps on' : h < 8 ? 'early morning, soft dawn light' : h < 11 ? 'morning daylight' : h < 14 ? 'midday daylight' : h < 18 ? 'afternoon daylight' : h < 21 ? 'evening, warm sunset or lamps' : 'night, dark outside, warm lamps on') + ')';
}
// trăsăturile fizice + poziția feței, citite o singură dată per poză de profil (c.faceBox: {k, x,y,w,h | none, phys})
// 9.10: citirea detaliată a pozei de profil (ca în 8.21–8.23, cu formulări neutre pentru corp)
const ID_DETAILED = `1. Find the main person's face (forehead to chin, ear to ear) as fractions 0-1 of the image width/height, top-left origin.
2. "physique": ONLY the permanent traits of the face, in English, comma-separated, max 60 words: apparent age, skin tone, face shape, eye color and shape, eyebrows, nose, lips, jaw and chin, visible skin details (freckles, moles, dimples).
3. "hair": the hair exactly, max 40 words: exact color (with highlights or roots if any), length, texture (straight, wavy, curly), volume, parting, fringe, how it is styled.
4. "body": the body exactly as it looks in the photo, in neutral factual English, comma-separated, max 50 words: apparent height (petite / average / tall), build (slim, slender, athletic, average, curvy, full-figured, plus-size, muscular), shoulders, bust, waist, hips and legs proportions, overall body shape, skin tone on the body. Describe only what is visible; if the body is not visible, write "not visible".
5. "marks": every permanent distinctive mark you can see (moles, freckle patterns, scars, birthmarks, tattoos with design and exact place, piercings with exact place), one short item each with the exact place, side given as the person's left or right. Empty list if none.
6. "glasses": "" if no glasses; otherwise the frame shape, color and material in max 10 words.
NO clothing, NO jewelry except piercings, NO background, NO pose, NO expression.
JSON: {"x":0.0,"y":0.0,"w":0.0,"h":0.0,"physique":"...","hair":"...","body":"...","marks":["..."],"glasses":""} (if no face is visible, x,y,w,h = 0)`;
async function identityOf(c, force){
  if(!c.photo) return null;
  const fb = c.faceBox;
  // 8.21: v3 = pașaportul complet (păr separat, semne distinctive, ochelari), citit O dată per poză de profil cu modelul principal
  if(!force && fb && fb.k === c.photo && fb.phys !== undefined && (fb.v === 5 || !aiReady()) && (fb.phys || !aiReady() || Date.now() - (fb.at || 0) < 864e5)) return fb;
  const full = await DB.get(c.photo); if(!full) return null;
  let b = null, phys = '', marks = [], glasses = '', expr = '', subj = '';
  // 9.12: citirea din 8.24; dacă răspunsul vine tăiat (sau fără descriere), se mai cere o dată
  for(let tryN = 0; tryN < 2 && aiReady() && !phys; tryN++){
    try{
      const meta = {};
      const out = await stream('You build an identity passport from a reference photo, for an image generator that must reproduce this exact person in new scenes. Be precise and literal. Answer with JSON only.', [{role:'user', image:await blobToB64(await toJpeg(full, 1280, .88)), text:
`1. Find the main person's face (forehead to chin, ear to ear) as fractions 0-1 of the image width/height, top-left origin.
2. "physique": ONLY permanent traits of the face, in English, comma-separated, max 55 words: apparent age, skin tone, face shape and width, eye color and shape, eyebrows, nose, lips, jaw and chin, and the real skin details (texture, pores, spots, freckles, under-eye shadows or bags, lines). Do not idealize.
3. "hair": the hair exactly, max 40 words: exact color (with highlights, roots or ombré if any), length (e.g. chin, shoulders, mid-back), texture (straight, wavy, curly, coily), volume, parting (on the person's left/right/center), fringe/bangs, how it is styled. Include facial hair if any.
4. "body": the body exactly as it looks, in neutral factual English, comma-separated, max 50 words: apparent height (petite / average / tall), weight and build, shoulders and arms, bust size, waist and belly, hips and legs proportions, overall body shape, skin tone on the body. Be specific and honest, do not soften, slim or idealize anything. Describe only the parts that are visible; if the body is not visible at all, write "not visible".
5. "marks": every PERMANENT distinctive mark you can see: moles and beauty marks, freckle patterns, scars, birthmarks, tattoos (the design and the exact body place), piercings (type and exact place), dimples, a gap in the teeth. One short item each, max 18 words, with the exact place and side given as THE PERSON'S left or right (not the viewer's). Empty list if none.
6. "glasses": "" if no glasses; otherwise the glasses (frame shape, color, material) in max 10 words.
8. "subject": ONE short English phrase, max 24 words, with the person's most defining visible traits for an image generator, in this order: gender and age, body type and build (specific: weight, bust, hips, as visible; never idealized), skin tone, hair. Example: "a petite slim woman in her 20s with a small bust, pale freckled skin and straight red shoulder-length hair".
7. "expression": the person's facial expression in this photo, precisely, max 25 words: mouth (closed or open, kind of smile, teeth visible or not), eyes (relaxed, narrowed, wide, smiling), eyebrows, head tilt, overall mood.
NO clothing, NO jewelry except piercings, NO background, NO pose, NO makeup (except in "expression").
JSON: {"x":0.0,"y":0.0,"w":0.0,"h":0.0,"physique":"...","hair":"...","body":"...","marks":["..."],"glasses":"","expression":"...","subject":"..."} (if no face is visible, x,y,w,h = 0)`}], {max:1500, cid:c.id, tag:'profil', meta});
      if(meta.stop && meta.stop !== 'end_turn') continue;
      const j = parseJSON(out), n = k => Math.min(1, Math.max(0, +j[k] || 0));
      if(!String(j.physique || '').trim()) continue;
      if(n('w') > .02 && n('h') > .02) b = {x:n('x'), y:n('y'), w:n('w'), h:n('h'), by:'ai'};
      phys = String(j.physique || '').trim().slice(0, 450);
      const hr = String(j.hair || '').trim(); if(hr) phys += (phys ? '; hair: ' : 'hair: ') + hr.slice(0, 350);
      const bd = String(j.body || '').trim(); if(bd && !/not visible/i.test(bd)) phys += (phys ? '; body: ' : 'body: ') + bd.slice(0, 400);
      marks = (Array.isArray(j.marks) ? j.marks : []).map(x => String(x || '').trim().slice(0, 140)).filter(x => x.length > 3).slice(0, 12);
      glasses = String(j.glasses || '').trim().slice(0, 100);
      expr = String(j.expression || '').trim().slice(0, 200);
      subj = String(j.subject || '').trim().replace(/[.\s]+$/, '').slice(0, 220);
    }catch(e){}
  }
  if(!b && 'FaceDetector' in window){
    const u = URL.createObjectURL(full);
    try{ const im = await loadImgEl(u), f = (await new FaceDetector({fastMode:false, maxDetectedFaces:3}).detect(im)).sort((a, z) => z.boundingBox.width * z.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0];
      if(f){ const r = f.boundingBox; b = {x:r.x / im.naturalWidth, y:r.y / im.naturalHeight, w:r.width / im.naturalWidth, h:r.height / im.naturalHeight, by:'tel'}; } }catch(e){}
    finally{ URL.revokeObjectURL(u); }
  }
  const keep = fb && fb.k === c.photo && !phys ? fb : null;   // o citire eșuată nu șterge pașaportul vechi
  c.faceBox = b ? {k:c.photo, ...b, phys: phys || (keep ? keep.phys : ''), marks: marks.length ? marks : (keep ? keep.marks || [] : []), glasses: glasses || (keep ? keep.glasses || '' : ''), expr: expr || (keep ? keep.expr || '' : ''), subj: subj || (keep ? keep.subj || '' : ''), at:Date.now(), v:phys ? 5 : (keep ? keep.v : 2)}
    : {k:c.photo, none:true, phys: phys || (keep ? keep.phys : ''), marks, glasses, expr, subj, at:Date.now(), v:phys ? 5 : 2};
  await saveChars();
  return c.faceBox;
}
// pătrat în jurul feței, lărgit cât să prindă părul și puțin gâtul; fără față găsită: partea de sus, la mijloc
async function cropFace(blob, b){
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight;
    let side, cx, cy;
    if(b){ const fw = b.w * W, fh = b.h * H; side = Math.max(fw, fh) * 1.7; cx = (b.x + b.w / 2) * W; cy = (b.y + b.h / 2) * H - fh * .12; }
    else { side = Math.min(W, H) * .55; cx = W / 2; cy = side / 2 + H * .04; }
    side = Math.min(side, W, H);
    const x = Math.min(Math.max(0, cx - side / 2), W - side), y = Math.min(Math.max(0, cy - side / 2), H - side);
    const o = Math.min(512, Math.round(side)), cv = document.createElement('canvas'); cv.width = cv.height = o;
    cv.getContext('2d').drawImage(im, x, y, side, side, 0, 0, o, o);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', .92));
  } finally { URL.revokeObjectURL(u); }
}
async function faceRef(c, force){
  if(!c.photo) return null;
  const full = await DB.get(c.photo); if(!full) return null;
  const id = await identityOf(c, force);
  return cropFace(full, id && !id.none ? id : null);
}
/* 8.3: Cloudflare (FLUX.2) primește reperele ca imagini de 512×512. Poza de profil întreagă micșorată la 512 lasă fața
   de câțiva pixeli, deci identitatea se pierde. Acum: reperul 1 = fața decupată (512, cât mai mulți pixeli pe față),
   reperul 2 = poza de profil decupată pătrat de la cap la talie (păr, ten, siluetă). Reper unic (Worker fără 2 repere): reperul 2. */
// 8.9.2: trăsăturile citite din poza de profil + ce ai scris tu despre corp (are prioritate)
function physFull(c, id){
  let a = id && id.phys ? id.phys : '';
  if(id && id.glasses) a += (a ? '; ' : '') + 'always wears ' + id.glasses;
  if(id && id.marks && id.marks.length) a += (a ? '. ' : '') + 'Permanent distinctive marks, always in exactly the same place whenever that part of the body is visible: ' + id.marks.join('; ');
  const u = c && c.physEn ? c.physEn : '';
  return u ? (a ? a + '. ' : '') + 'Exact body and looks, this overrides anything else: ' + u : a;
}
async function bodySquare(blob, b){
  // 8.11: revenit la decupajul din jurul feței (încadrarea cu toată poza din 8.9.2 micșora fața în reper și strica asemănarea)
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight;
    const side = Math.min(W, H, b && !b.none ? Math.max(b.h * H * 5, b.w * W * 3.2) : Math.min(W, H));
    const cx = b && !b.none ? (b.x + b.w / 2) * W : W / 2, top = b && !b.none ? b.y * H - b.h * H * .45 : 0;
    const x = Math.min(Math.max(0, cx - side / 2), W - side), y = Math.min(Math.max(0, top), H - side);
    const cv = document.createElement('canvas'); cv.width = cv.height = 512;
    cv.getContext('2d').drawImage(im, x, y, side, side, 0, 0, 512, 512);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', .92));
  } finally { URL.revokeObjectURL(u); }
}
// 8.23: poza de profil întreagă, încadrată într-un pătrat (fundal estompat), ca generatorul să vadă tot corpul
async function wholeRef(blob){
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight, K = 512, s = K / Math.max(W, H);
    const cv = document.createElement('canvas'); cv.width = cv.height = K; const g = cv.getContext('2d');
    g.filter = 'blur(18px) brightness(.9)'; const s2 = K / Math.min(W, H); g.drawImage(im, (K - W * s2) / 2, (K - H * s2) / 2, W * s2, H * s2); g.filter = 'none';
    g.drawImage(im, (K - W * s) / 2, (K - H * s) / 2, W * s, H * s);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', .92));
  } finally { URL.revokeObjectURL(u); }
}
async function idRefs(c){
  const full = c.photo ? await DB.get(c.photo) : null; if(!full) return null;
  let id = null; if(aiReady()) try{ id = await identityOf(c); }catch(e){}
  const bx = id && !id.none ? id : null;
  // 8.5: pozele de referință în plus (alte unghiuri) merg ca repere 3 și 4: fața decupată din fiecare
  const extra = [];
  for(const k of (c.refs || []).slice(0, 2)){
    const b = await DB.get(k).catch(() => null); if(!b) continue;
    let rb = (c.refBoxes || {})[k];
    if(rb === undefined){ rb = await faceBoxOf(b); c.refBoxes = c.refBoxes || {}; c.refBoxes[k] = rb; saveChars(); }
    extra.push(await cropFace(b, rb));
  }
  return {full, id, face: await cropFace(full, bx), body: await bodySquare(full, bx), extra};
}
// poziția feței într-o poză (o dată per poză; null = n-am găsit-o, se decupează partea de sus)
async function faceBoxOf(blob){
  if(!aiReady()) return null;
  try{
    const out = await stream('You locate faces in images. Answer with JSON only.', [{role:'user', image:await blobToB64(await toJpeg(blob, 1024, .85)), text:'Find the main person\'s face (forehead to chin, ear to ear) as fractions 0-1 of the image width/height, top-left origin. JSON: {"x":0.0,"y":0.0,"w":0.0,"h":0.0} (all 0 if no face)'}], {max:100, aux:true});
    const j = parseJSON(out), n = k => Math.min(1, Math.max(0, +j[k] || 0));
    return n('w') > .02 && n('h') > .02 ? {x:n('x'), y:n('y'), w:n('w'), h:n('h')} : null;
  }catch(e){ return null; }
}
// expresia: cea obișnuită (din poza de profil), în afară de cazul în care ai cerut tu alta în conversație
const EXPR_ASK = 'Facial expression requested: ';
const exprLine = (c, shot, id) => String(shot || '').includes(EXPR_ASK) ? 'EXPRESSION — use the facial expression requested in the scene description.'
  : 'EXPRESSION — the character always has the same facial expression as in the reference photo' + (id && id.expr ? ': ' + id.expr : '') + '. Copy that expression exactly.';
// 8.24: trăsăturile definitorii (corp, ten, păr) chiar la începutul promptului, unde generatorul le dă cea mai mare greutate
const subjLine = (c, id) => { const s0 = id && id.subj ? id.subj : ''; const u = c && c.physEn ? c.physEn.split(/\s+/).slice(0, 30).join(' ') : ''; return s0 || u ? ' The person: ' + [s0, u].filter(Boolean).join('; ') + '.' : ''; };
const NO_BEAUTY = 'Do NOT beautify or idealize: same age, same weight and body shape, same skin texture, spots and under-eye shadows, same face width; no slimming, no smoothing, no younger look.';
// 9.1: modelul pentru o poză: în chat = „Fidelitatea feței”; stories și statusuri pot avea setarea lor (Eco, mai ieftin)
const isAuto = opt => !!opt && (opt.tag === 'stories' || opt.tag === 'statusuri');
// 9.6: cu o limită zilnică („Doar gratuit” / „Max $0,10”), 9B merge cât încape o poză întreagă plus o rezervă pentru Eco;
//      apoi pozele trec singure pe Eco (cu retușul feței și variante) până la resetare, în loc să se oprească sau să coste
const ECO_RESERVE = 600;
const nineFits = () => !Number.isFinite(capLeft()) || capLeft() >= (neurPerPhoto('ancorat') || 1455) + ECO_RESERVE;
const sceneModel = (opt = {}) => { const m = isAuto(opt) && S.autoModel === 'eco' ? 'eco' : (S.wkChat && S.wkChat !== 'fal' ? S.wkChat : 'eco'); return m === 'ancorat' && S.imgProv === 'worker' && !nineFits() ? 'eco' : m; };
function nineDegradedNote(opt){
  if(S.wkChat !== 'ancorat' || S.imgProv !== 'worker' || nineFits() || (isAuto(opt) && S.autoModel === 'eco')) return;
  const d = new Date().toISOString().slice(0, 10); if(S.degDay === d) return;
  S.degDay = d; saveSettings();
  toast(`Cota gratuită de azi nu mai ajunge pentru 9B: pozele continuă pe Eco (cu retușul feței) până la ${resetAt()}, fără cost.`, 6000);
}
function idPrompt(c, shot, fr, R, fix, two){
  const phys = physFull(c, R && R.id) ? ` Permanent physical traits (exactly as in the reference): ${physFull(c, R && R.id)}.` : '';
  const nx = two && R && R.extra ? R.extra.length : 0;
  const refs = two
    ? 'image 1 is a close-up of the face (the exact identity to keep: face shape, eyes, eyebrows, nose, lips, skin tone and skin texture), image 2 shows the same person\'s hair, skin tone and body type' + (nx ? `, image${nx > 1 ? 's 3 and 4 are' : ' 3 is'} the same face from other angles` : '')
    : 'the reference image shows the same person (face, hair, skin tone, body type)';
  return `${fr.p}. ${shot}.${fix ? ` Important corrections from the previous attempt: ${fix}.` : ''} IDENTITY LOCK — the reference images define one specific character, not a lookalike. Reproduce the same individual: preserve face shape, eye spacing and shape, eyebrows, nose, lips, jaw, apparent age, skin tone and texture, hairline, hair color, curl/strand texture and hairstyle. Preserve the exact body build and proportions visible in the reference; do not slim, enlarge, reshape or replace the body. ${refs}.${phys} SCENE FLEXIBILITY — do not copy the reference photo's background, outfit, pose, expression, camera angle or framing. Those are allowed to change and must follow the current scene description above. Change only temporary details required by the scene; the character's identity and natural body proportions stay fixed. ${STIL_TAG[c.stil || 'photo']}`;
}
// încadrarea scrisă explicit la început (altfel modelul copiază încadrarea referinței)
function framingOf(shot){
  const t = String(shot || '').toLowerCase();
  if(/close[- ]?up|headshot|face only|portrait of (her|his) face|prim[- ]plan/.test(t)) return {k:'close', p:'Close-up selfie, head and shoulders, phone held at arm\'s length'};
  if(/mirror/.test(t)) return {k:'full', p:'Full-body mirror selfie: the whole body visible from head to feet in the mirror, the phone in her hand visible in the mirror, the room visible around'};
  if(/propped|timer|tripod|self-timer/.test(t)) return {k:'full', p:'Photo taken with the phone propped up on a shelf with the self-timer: the whole body visible from head to feet, the room around clearly visible, natural candid pose'};
  if(/full[- ]?body|head to (toe|feet)|whole body|wide shot|photo taken by someone|from afar|lying|kneeling|walking|dancing/.test(t)) return {k:'full', p:'Full-body photo: the entire body visible from head to toe, camera far enough to show the surroundings'};
  if(/selfie/.test(t)) return {k:'mid', p:'Arm\'s-length selfie taken with the phone, framed from the head down to the thighs, the body and the room visible behind'};
  return {k:'mid', p:'Medium-wide photo: the body visible from head to knees, the surroundings clearly visible'};
}
// 2+3. planificatorul de scenă: conversația → starea personajului + descrierea pozei (+ camere noi ale casei)
// 8.9: etapele pozei, afișate în locul pozei care „se developează”
function pstage(signal, t, p){
  if(!busy || !signal || busy.signal !== signal || !live || !live.photo) return;
  live.stage = {t, p, pv:Math.max(live.stage ? live.stage.pv || 0 : 0, 0)};
  const el = $('#msgs .picload'); if(!el) return;
  const st = el.querySelector('.plst');
  if(st && st.textContent !== t){ st.textContent = t; st.classList.remove('chg'); void st.offsetWidth; st.classList.add('chg'); }
}
// 8.9.2: bara se umple continuu: urcă spre ținta etapei curente, tot mai încet, fără s-o atingă până nu trece la etapa următoare
function pTick(){
  if(!live || !live.photo || !live.stage) return;
  const g = live.stage, gap = g.p - (g.pv || 0);
  if(gap > 0) g.pv = (g.pv || 0) + Math.max(.03, gap * (g.p <= 30 ? .045 : g.p >= 95 ? .06 : .011));
  pDraw(g.pv);
}
function pDraw(v){
  const el = $('#msgs .picload'); if(!el) return;
  const bar = el.querySelector('.plbar i'), pc = el.querySelector('.plpct');
  if(bar) bar.style.width = Math.min(100, v) + '%';
  if(pc) pc.textContent = Math.min(100, Math.floor(v)) + '%';
}
async function planShot(c, ch, {promised = '', exclude = null, signal, together = false} = {}){
  pstage(signal, '🎬 Își alege locul și cadrul', 22);
  const u = S.userName.trim() || 'User';
  const hist = ch.msgs.filter(x => x !== exclude && x.text && !x.err && !x.pending);
  const acts = t => (t.match(/\*[^*]+\*/g) || []).join(' ');
  const recent = hist.slice(-16).map(x => (x.role === 'user' ? u : c.name) + ': ' + plain(stripMood(x.text)).slice(0, 600) + (acts(x.text) ? ' [actions: ' + acts(x.text) + ']' : '')).join('\n');
  const prevShots = ch.msgs.filter(x => x.img && x.scene && x !== exclude).slice(-3).map(x => '- ' + x.scene).join('\n');
  const home = c.home && Object.keys(c.home).length ? Object.entries(c.home).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '';
  const lf = lifeNow(c), meta = {};
  let wx = null; try{ wx = await weatherOf(c); }catch(e){}
  const out = await stream(`You are the photo planner of a chat app where ${c.name}, a real person, sends ${u} photos from her/his phone. You read the conversation and decide exactly where the character is and how, then describe the photo. The conversation is the only truth. Answer with JSON only.`, [{role:'user', text:
`Character: ${c.name}.${c.persona ? ' About: ' + plain(c.persona).slice(0, 500) : ''}
Now: ${todEn()}.${wx ? ` Real weather right now in ${wx.city}, where the character lives: ${wx.t}°C, ${wx.en}, ${wx.day ? 'daylight' : 'dark outside'} (use it for anything outdoors and for the light through windows).` : ''}${lf ? ' Daily routine says right now: ' + lf.w + ' (use only if the conversation says nothing else).' : ''}
${ch.scene ? 'Scene set by the user (has priority, translate to English): ' + ch.scene + '\n' : ''}${ch.where ? 'Last known state of the character (from earlier photos): ' + JSON.stringify(ch.where) + '\n' : ''}${ch.plot ? 'Ongoing activity noted by the character (Romanian, "activity › current step"): ' + ch.plot.t + '\n' : ''}${home ? `Rooms of ${c.name}'s home (reuse these details EXACTLY when the photo is in one of them, so the home always looks the same):\n${home}\n` : ''}
Conversation, oldest first (the Romanian text is the source of truth):
${recent || '(just started)'}
${S.userPhoto ? (together ? `\nThis photo is of ${c.name} and ${u} TOGETHER (${u} asked for it): describe both of them in the scene (where each one is, how they stand or sit together, what each wears). Photos together are ordinary everyday couple photos, both fully clothed and natural (like a selfie at a café or on a walk).\n` : `\n${u} has a profile photo, so a photo of the two of them together is possible: set "together": true only if they are physically together in the scene right now AND the photo is clearly of both of them (a selfie together, ${u} asks for a photo together). Then describe both of them. Photos together are ordinary everyday couple photos, both fully clothed and natural.\n`) : ''}${promised ? `\n${c.name} just sent the photo and described it like this: "${promised}". Use it as the base, but correct anything that contradicts the conversation.\n` : ''}${prevShots ? `\nPhotos already sent (vary pose or framing unless the conversation says the same place and moment):\n${prevShots}\n` : ''}
Rules:
1. If ${u} asked for a specific photo (place, pose, outfit, activity), that is the photo.
2. Otherwise: where ${c.name} is RIGHT NOW according to the most recent messages (room, what she/he sits/lies/stands on, what the hands do, what is worn). The latest statement wins over older ones; if the latest messages say nothing, keep the last known state.
3. Clothes stay the same as in the last known state unless the conversation says they changed.
4. The character is alone unless the conversation says someone is with them, so the camera is: "selfie", "mirror selfie", or "phone propped up with timer" (for full-body shots without a mirror). Never "photo taken by someone" when alone.
5. Default to showing the body (mirror selfie, timer shot, or selfie down to the thighs); "close-up selfie" only if the face is asked for.
6. Light must match the time of day and the place (at night indoors: lamps, warm and a bit dim).
7. Make it look like a real, ordinary moment: real furniture and objects, a bit of everyday mess, nothing staged.
8. Never describe the face, hair, skin or body shape (they come from the reference photo). Describe only place, pose, clothes, expression, light.
9. If the photo is in a room of the home that is not in the list above, invent its look once (concrete: colors, furniture, window, floor) consistent with the character and the conversation, and return it in "home". Also return in "home" any NEW concrete detail of a room that the conversation revealed.

JSON, keys in exactly this order, nothing else:
{"camera":"selfie | mirror selfie | phone propped up with timer | close-up selfie",${S.userPhoto ? '\n "together":false,' : ''}
 "shot":"ONE English description for the image generator, 50-80 words: camera and framing, the place with concrete details (reuse the room description), body position and hands, outfit, expression, light",
 "where":{"place":"home / office / café / street …","room":"bedroom | living room | kitchen | bathroom | hallway | balcony | office | other","position":"exact body position and what it rests on","outfit":"what is worn now","activity":"what is being done","light":"light now"},
 "home":{"<room>":"English description, max 45 words; only rooms that are new or changed"}}`}], {max:1500, signal, cid:c.id, aux:true, meta});
  // 7.1: refuzul filtrului lui Claude se spune ca atare (nu se ocolește); un răspuns tăiat sau fără JSON nu mai oprește poza
  if(meta.stop === 'refusal' && !promised) throw new Error('Claude a refuzat să descrie poza asta (filtrul lui de siguranță). Încearcă altă scenă.');
  let j = {}; try{ j = parseJSON(out); }catch(e){}
  if(!j.shot){ const mm = String(out).match(/"shot"\s*:\s*"((?:[^"\\]|\\.)*)/); if(mm) j.shot = mm[1].replace(/\\"/g, '"'); }
  if(!j.camera){ const mm = String(out).match(/"camera"\s*:\s*"([^"]*)"/); if(mm) j.camera = mm[1]; }
  let shot = String(j.shot || promised || '').trim().replace(/^["„]|["”]$/g, '').replace(/[.\s]+$/, '');
  if(shot.length < 15) shot = fallbackShot(c, ch, exclude);
  if(shot.length < 15) throw new Error('Nu am putut descrie poza din conversație. Mai încearcă o dată.');
  if(j.where && typeof j.where === 'object'){
    const w = {}; for(const k of ['place', 'room', 'position', 'outfit', 'activity', 'light']) if(j.where[k]) w[k] = String(j.where[k]).slice(0, 200);
    ch.where = {...w, ts:Date.now()};
  }
  if(j.home && typeof j.home === 'object'){
    c.home = c.home || {};
    for(const [k, v] of Object.entries(j.home)){ const kk = String(k).toLowerCase().trim().slice(0, 30), vv = String(v || '').trim().slice(0, 320); if(kk && vv.length > 8 && (c.home[kk] || Object.keys(c.home).length < 10)) c.home[kk] = vv; }
    saveChars();
  }
  const cam = String(j.camera || '');
  return {shot: cam && !shot.toLowerCase().includes(cam.toLowerCase().split(' ')[0]) ? cam + ', ' + shot : shot, where: ch.where, together: !!S.userPhoto && (together || j.together === true || /"together"\s*:\s*true/.test(out))};
}
// rezervă fără AI: ultima stare cunoscută + acțiunile din ultimul mesaj al personajului (în română; generatorul înțelege și așa)
function fallbackShot(c, ch, exclude){
  const w = ch.where || {}, last = [...ch.msgs].reverse().find(x => x !== exclude && x.role === 'ai' && x.text && !x.err);
  const acts = last ? (last.text.match(/\*[^*]+\*/g) || []).map(a => a.replace(/\*/g, '').trim()).filter(a => !/trimite o poz/i.test(a)).join('; ') : '';
  const parts = ['selfie', w.room && w.room !== 'other' ? 'in the ' + w.room : w.place, w.position, w.outfit, acts, w.light || todEn()].filter(Boolean);
  return parts.length > 2 ? parts.join(', ') : '';
}
// promptul final + generarea; poza de profil e reperul pentru orice poză (identitate), scena vine din descriere
async function scenePhoto(c, shot, signal, fix, opt = {}){
  const stil = STIL_TAG[c.stil || 'photo'], fr = framingOf(shot);
  const full = c.photo ? await DB.get(c.photo) : null;
  let id = null; if(full && aiReady()) try{ id = await identityOf(c); }catch(e){}
  const me = opt.together && S.userPhoto ? await DB.get(S.userPhoto) : null;
  if(full && me){
    const u = S.userName.trim() || 'the user';
    const cb = id && !id.none ? id : null, ub = S.userBox || null;
    const ref = await pairRef(full, me, cb, ub);
    const head = `${togetherFraming(shot)}. ${shot}.${fix ? ` Important corrections from the previous attempt: ${fix}.` : ''} Exactly two people in this photo, ${c.name} and ${u}, together in the scene described above.`;
    const tail = `Keep both identities exactly as in the references: the same faces, facial features, skin tones, hair and body types. This is ONE single natural photo of the two of them together: not a collage, not a split screen, no border, no gray background; the location, clothing, poses and light come only from the scene description. ${stil}`;
    const pPair = `${head} The reference image shows the two of them side by side: on the LEFT is ${c.name}${physFull(c, id) ? ' (' + physFull(c, id) + ')' : ''}; on the RIGHT is ${u}${S.userPhys ? ' (' + S.userPhys + ')' : ''}. ${tail}`;
    const pTwo = `${head} Image 1 is a close-up of ${c.name}'s face${physFull(c, id) ? ' (' + physFull(c, id) + ')' : ''}; image 2 is a close-up of ${u}'s face${S.userPhys ? ' (' + S.userPhys + ')' : ''}. ${tail}`;
    const model = S.imgProv === 'worker' ? (S.wkChat && S.wkChat !== 'fal' ? S.wkChat : S.wkModel) : undefined;
    if(S.imgProv === 'worker') return {prompt:pTwo, blob: await genImage(pTwo, await cropFace(full, cb), signal, await cropFace(me, ub), {model, p1:pPair, one:ref})};
    return {prompt:pPair, blob: await genImage(pPair, ref, signal, null, {model})};
  }
  const phys = physFull(c, id) ? ` Her/his permanent physical traits (exactly as in the reference): ${physFull(c, id)}.` : '';
  const fixLine = fix ? ` Important corrections from the previous attempt: ${fix}.` : '';
  // 8.3: pozele din chat prin fal.ai PuLID (model făcut să păstreze fața), restul aplicației rămâne pe Worker
  if(full && S.imgProv === 'worker' && S.wkChat === 'fal' && S.falKey){
    const face = await cropFace(full, id && !id.none ? id : null);
    const prompt = `${fr.p}. ${shot}.${fix ? ` Important corrections from the previous attempt: ${fix}.` : ''} Use the supplied face reference as a strict identity anchor, not as inspiration: this must be the same individual, with the same facial geometry, eye shape and spacing, nose, lips, jaw, skin tone and texture, hairline, hair color and texture. Do not generate a similar-looking substitute. Keep the character's natural body build and proportions consistent with the permanent traits below; do not reshape the body. ${physFull(c, id) ? 'Permanent face and body traits: ' + physFull(c, id) + '.' : ''} Only the location, clothing, pose, expression, camera angle and lighting may change, following this scene description. ${stil}`;
    return {prompt, blob: await genImage(prompt, face, signal, null, {prov:'fal'})};
  }
  if(full && S.imgProv === 'worker'){
    const R = await idRefs(c);
    const prompt = idPrompt(c, shot, fr, R, fix, true);
    return {prompt, blob: await genImage(prompt, R.face, signal, R.body, {model: S.wkChat && S.wkChat !== 'fal' ? S.wkChat : (S.wkModel === 'eco' ? 'ancorat' : S.wkModel), p1: idPrompt(c, shot, fr, R, fix, false), extra: R.extra})};
  }
  if(full && S.imgProv === 'fal'){
    const prompt = `${fr.p}. ${shot}.${fixLine} Same person as in the reference image (same face, skin tone, hair, body type).${phys} New location, outfit, pose and light exactly as described, not those of the reference. ${stil}`;
    return {prompt, blob: await genImage(prompt, full, signal)};
  }
  if(S.imgProv === 'worker' || S.imgProv === 'fal'){
    const prompt = [c.look || '', fr.p, shot + fixLine, stil].filter(Boolean).join('. ');
    return {prompt, blob: await genImage(prompt, null, signal)};
  }
  const prompt = [fr.p, shot + fixLine, full ? 'Same person as in the reference image; take only the face, hair and body type from it, everything else (place, pose, clothing, light) from this description.' + phys : c.look || '', stil].filter(Boolean).join('. ');
  return {prompt, blob: await genImage(prompt, full, signal)};
}
/* ═════════ 🧬 8.21 identitate fixă ═════════
   1. PAȘAPORT: fața, părul, corpul, semnele (alunițe, tatuaje, piercinguri) și ochelarii, citite o dată din poza de profil.
   2. FAȚA: scena se generează (ieftin, eco), apoi fața din poza de profil e pusă peste ea (fal.ai, schimb de față).
   3. VERIFICARE ÎN TELEFON: recunoaștere facială locală (face-api, MIT) compară fața din poză cu poza de profil. Gratuit.
   4. VERIFICARE SCENĂ: Haiku vede doar poza nouă + pașaportul scris: scenă, încadrare, păr, semne.
   5. Dacă ceva nu ține, se reface O dată și rămâne varianta mai bună. */
const FA = 'vendor/face-api/';
let faP = null;
function faceApi(){
  if(faP) return faP;
  faP = new Promise((res, rej) => {
    const go = async () => {
      try{
        const f = window.faceapi; if(!f) throw new Error('biblioteca nu s-a încărcat');
        // placa video (webgl) → WebAssembly (fișierele .wasm stau lângă bibliotecă) → procesor
        try{ if(f.tf.setWasmPaths) f.tf.setWasmPaths(new URL(FA, location.href).href); }catch(e){}
        let be = '';
        for(const x of ['webgl', 'wasm', 'cpu']){ try{ if(await f.tf.setBackend(x)){ await f.tf.ready(); be = x; break; } }catch(e){} }
        if(!be) throw new Error('niciun motor de calcul disponibil');
        await Promise.all([f.nets.tinyFaceDetector.loadFromUri(FA + 'model'), f.nets.faceLandmark68Net.loadFromUri(FA + 'model'), f.nets.faceRecognitionNet.loadFromUri(FA + 'model')]);
        res(f);
      }catch(e){ rej(e); }
    };
    if(window.faceapi) return go();
    const sc = document.createElement('script'); sc.src = FA + 'face-api.js'; sc.onload = go; sc.onerror = () => rej(new Error('nu pot încărca recunoașterea feței'));
    document.head.appendChild(sc);
  });
  faP.catch(() => { faP = null; });
  return faP;
}
// toate fețele dintr-o poză: descriptor (128 de numere) + cât din poză ocupă
async function faceDescs(blob){
  const f = await faceApi(), u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), area = im.naturalWidth * im.naturalHeight;
    let r = await f.detectAllFaces(im, new f.TinyFaceDetectorOptions({inputSize:608, scoreThreshold:.4})).withFaceLandmarks().withFaceDescriptors();
    if(!r.length){   // fețe mici (poze cu tot corpul): detectorul mare, încărcat doar la nevoie
      if(!f.nets.ssdMobilenetv1.isLoaded) await f.nets.ssdMobilenetv1.loadFromUri(FA + 'model');
      r = await f.detectAllFaces(im, new f.SsdMobilenetv1Options({minConfidence:.35})).withFaceLandmarks().withFaceDescriptors();
    }
    const B = x => x.detection.box;
    return r.map(x => ({d:Array.from(x.descriptor), a:B(x).area / area, box:{x:B(x).x, y:B(x).y, w:B(x).width, h:B(x).height}, W:im.naturalWidth, H:im.naturalHeight}));
  } finally { URL.revokeObjectURL(u); }
}
// fața de referință: poza de profil + pozele de referință în plus (o dată, ținută pe personaj)
async function refDescs(c){
  if(!c.photo) return [];
  const k = [c.photo, ...(c.refs || []).slice(0, 2)].join('|');
  if(c.faceEmb && c.faceEmb.k === k && c.faceEmb.d.length) return c.faceEmb.d;
  const d = [];
  for(const key of k.split('|')){
    const b = await DB.get(key).catch(() => null); if(!b) continue;
    const fs = await faceDescs(b); if(fs.length) d.push(fs.sort((x, y) => y.a - x.a)[0].d.map(v => Math.round(v * 1e4) / 1e4));
  }
  c.faceEmb = {k, d}; saveChars();
  return d;
}
const fdist = (a, b) => Math.sqrt(a.reduce((t, v, i) => t + (v - b[i]) ** 2, 0));
// distanța dintre fața din poză și fața personajului: sub ~0,5 = aceeași persoană (null = n-am putut măsura)
async function idDistance(c, blob){
  const ref = await refDescs(c); if(!ref.length) return null;
  const got = await faceDescs(blob); if(!got.length) return {d:null, n:0};
  let best = 9; for(const g of got) for(const r of ref) best = Math.min(best, fdist(g.d, r));
  return {d:Math.round(best * 1000) / 1000, n:got.length};
}
const ID_MAX = .5;
const idPct = d => Math.round(100 * Math.max(0, Math.min(1, (.9 - d) / .55)));
const idLabel = d => d == null ? 'fața nu se vede' : d <= .4 ? 'aceeași persoană, sigur' : d <= ID_MAX ? 'aceeași persoană' : d <= .6 ? 'seamănă, dar nu sigur' : 'altă față';

/* 8.22: retușul feței, doar pe Cloudflare (fără alte servicii).
   Telefonul găsește fața în poza nouă, o decupează (512×512), iar FLUX.2 klein primește decupajul + fața din poza de profil
   și redesenează DOAR fața: aceeași poziție a capului, expresie, privire și lumină. Telefonul o lipește la loc pe o elipsă
   cu margini estompate și culori potrivite cu restul pozei; părul, hainele și fundalul rămân cele generate. Eco: ~37 de neuroni. */
const faceFixOn = (c, opt = {}) => S.faceFix !== 'off' && S.imgProv === 'worker' && !!S.wkBase && !!c.photo && !opt.together && (c.stil || 'photo') === 'photo' && sceneModel(opt) === 'eco';
const neurUsd = (model, size) => S.imgProv === 'worker' && S.cfPlan === 'paid' && neurToday >= 10000 ? (neurPerPhoto(model, size) || 0) * NEUR_USD : 0;
const toBlob = (cv, q = .93) => new Promise(r => cv.toBlob(r, 'image/jpeg', q));
async function facePass(c, blob, signal, model = 'eco', shot = '', why = 'retus'){
  const u = URL.createObjectURL(blob); let im;
  try{ im = await loadImgEl(u); } finally { URL.revokeObjectURL(u); }
  const faces = await faceDescs(blob); if(!faces.length) return null;          // fața nu se vede (de spate, prea mică): poza rămâne așa
  const ref = await refDescs(c).catch(() => []);
  const pick = ref.length ? faces.map(f => ({f, d:Math.min(...ref.map(r => fdist(f.d, r)))})).sort((a, b) => a.d - b.d)[0].f : faces.sort((a, b) => b.a - a.a)[0];
  const W = im.naturalWidth, H = im.naturalHeight, bx = pick.box;
  if(bx.w < 14 || bx.h < 14) return null;
  const side = Math.min(W, H, Math.max(bx.w, bx.h) * 2.1), cx = bx.x + bx.w / 2, cy = bx.y + bx.h * .46;
  const x0 = Math.min(Math.max(0, cx - side / 2), W - side), y0 = Math.min(Math.max(0, cy - side / 2), H - side), K = 512, k = K / side;
  const cv0 = document.createElement('canvas'); cv0.width = cv0.height = K; cv0.getContext('2d').drawImage(im, x0, y0, side, side, 0, 0, K, K);
  const crop = await toBlob(cv0, .95);
  // fața personajului (+ unghiurile în plus din profil), ca repere
  const prof = await DB.get(c.photo); if(!prof) return null;
  let id = null; try{ id = await identityOf(c); }catch(e){}
  const pface = await cropFace(prof, await profFaceBox(c, prof) || (id && !id.none ? id : null));
  const extra = [];
  for(const key of (c.refs || []).slice(0, 2)){ const b2 = await DB.get(key).catch(() => null); if(b2) extra.push(await cropFace(b2, (c.refBoxes || {})[key] || null)); }
  const faceMarks = id && id.marks ? id.marks.filter(m => /face|cheek|lip|nose|eye|brow|forehead|chin|jaw|temple|ear|mole|freckle|dimple/i.test(m)) : [];
  const prompt = `Edit image 1. Replace ONLY the face of the person in image 1 with the exact face of the person in image 2${extra.length ? ' (images 3' + (extra.length > 1 ? ' and 4' : '') + ' show the same face from other angles)' : ''}: the same individual, with identical facial geometry, eye shape and spacing, eye color, eyebrows, nose, lips, jaw and chin, skin tone and skin texture${faceMarks.length ? ', and these marks in exactly the same place: ' + faceMarks.join('; ') : ''}${id && id.glasses ? ', wearing ' + id.glasses : ''}. Keep everything else from image 1 exactly as it is: head position and angle, gaze direction, facial expression, the light direction and color on the face, hair, background, framing, sharpness and photo grain. One seamless, photorealistic, unretouched phone photo.`;
  const ed = await genImage(prompt, crop, signal, pface, {model, force:{two:true}, size:K + 'x' + K, extra, quiet:true, why});
  const ue = URL.createObjectURL(ed); let ei;
  try{ ei = await loadImgEl(ue); } finally { URL.revokeObjectURL(ue); }
  // culorile retușului se aliniază cu ale decupajului original (media și contrastul pe fiecare canal), ca lipitura să nu se vadă
  const cv1 = document.createElement('canvas'); cv1.width = cv1.height = K; const g1 = cv1.getContext('2d'); g1.drawImage(ei, 0, 0, K, K);
  const A = cv0.getContext('2d').getImageData(0, 0, K, K), Bd = g1.getImageData(0, 0, K, K), st = d => { const m = [0, 0, 0], v = [0, 0, 0], n = d.length / 4;
    for(let i = 0; i < d.length; i += 4) for(let ch = 0; ch < 3; ch++) m[ch] += d[i + ch]; for(let ch = 0; ch < 3; ch++) m[ch] /= n;
    for(let i = 0; i < d.length; i += 4) for(let ch = 0; ch < 3; ch++) v[ch] += (d[i + ch] - m[ch]) ** 2; return {m, s:v.map(x => Math.sqrt(x / n) || 1)}; };
  const sa = st(A.data), sb = st(Bd.data);
  for(let i = 0; i < Bd.data.length; i += 4) for(let ch = 0; ch < 3; ch++){ const v = Bd.data[i + ch], t = (v - sb.m[ch]) / sb.s[ch] * sa.s[ch] + sa.m[ch]; Bd.data[i + ch] = Math.max(0, Math.min(255, v + (t - v) * .7)); }
  g1.putImageData(Bd, 0, 0);
  // doar fața: elipsă în jurul ei, cu margine estompată
  g1.globalCompositeOperation = 'destination-in';
  const fx = (bx.x + bx.w / 2 - x0) * k, fy = (bx.y + bx.h * .52 - y0) * k, rx = bx.w * k * .6, ry = bx.h * k * .74;
  g1.save(); g1.translate(fx, fy); g1.scale(1, ry / rx);
  const gr = g1.createRadialGradient(0, 0, rx * .64, 0, 0, rx); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g1.fillStyle = gr; g1.fillRect(-rx * 1.2, -rx * 1.2, rx * 2.4, rx * 2.4); g1.restore();
  const out = document.createElement('canvas'); out.width = W; out.height = H; const go = out.getContext('2d');
  go.drawImage(im, 0, 0); go.imageSmoothingQuality = 'high'; go.drawImage(cv1, 0, 0, K, K, x0, y0, side, side);
  return await toBlob(out, .93);
}
// poziția exactă a feței în poza de profil, găsită de detectorul din telefon (o dată per poză)
async function profFaceBox(c, prof){
  if(c.faceLoc && c.faceLoc.k === c.photo) return c.faceLoc.b;
  let b = null;
  try{ const f = (await faceDescs(prof)).sort((x, y) => y.a - x.a)[0]; if(f) b = {x:f.box.x / f.W, y:f.box.y / f.H, w:f.box.w / f.W, h:f.box.h / f.H}; }catch(e){ return null; }
  c.faceLoc = {k:c.photo, b}; saveChars();
  return b;
}
/* 8.24: potrivirea corpului. Generatorul tinde spre un corp „standard” (mai slab, bust mai mic) oricât de bun e reperul.
   După scenă, FLUX.2 klein editează poza întreagă: schimbă DOAR forma corpului după poza de profil (greutate, bust, umeri, brațe,
   talie, șolduri), păstrând fața, hainele (aceleași, așezate pe corpul acesta), poziția, camera și lumina. Eco: ~115 neuroni. */
const bodyText = (c, id) => { const m = String(id && id.phys || '').match(/(?:^|; )body: ([^;]+)/); return [m ? m[1] : '', c.physEn || ''].filter(Boolean).join('; '); };
const bodyFixOn = (c, shot, opt = {}, id) => S.bodyFix !== 'off' && faceFixOn(c, opt) && !!bodyText(c, id) && framingOf(shot).k !== 'close';
async function bodyPass(c, blob, signal, shot){
  const prof = c.photo ? await DB.get(c.photo) : null; if(!prof) return null;
  let id = null; try{ id = await identityOf(c); }catch(e){}
  const bt = bodyText(c, id); if(!bt) return null;
  const whole = await wholeRef(prof), size = S.wkSize || '768x1024';
  const prompt = `Edit image 1. Change ONLY the body of the person in image 1 so that it is exactly the body of the person in image 2: ${bt}. The same weight and the same proportions of shoulders, arms, bust, waist, belly, hips, thighs and legs as in image 2; never slimmer, smaller or more idealized. Keep everything else from image 1 exactly: the face, head, hair and expression, the pose and position, the same clothes (same garments, colors and style, fitted naturally to this body), the room and background, the framing, the light and the photo grain. One seamless, photorealistic, unretouched phone photo.`;
  return await genImage(prompt, blob, signal, whole, {model:'eco', force:{two:true}, size, px1:Math.max(...size.split('x').map(Number)), quiet:true, why:'corp'});
}
// 8.23: retușul rămâne doar dacă telefonul măsoară că fața a ieșit mai aproape de poza de profil
async function retouchBest(c, blob, signal, model, shot, why){
  const y = await facePass(c, blob, signal, model, shot, why); if(!y) return null;
  const d0 = (await localFace(blob, c)).d, d1 = (await localFace(y, c)).d;
  const better = d1 != null && (d0 == null || d1 < d0 - .01);
  return {blob: better ? y : blob, used: better, d: better ? d1 : d0, before: d0, after: d1};
}
// doar fața, fără Haiku (gratuit): pentru a doua încercare de retuș
async function localFace(blob, c){ let m = null; try{ m = await idDistance(c, blob); }catch(e){} return m && m.d != null ? {d:m.d, face:Math.round(idPct(m.d) / 10)} : {d:null, face:null}; }
// verificarea: fața în telefon (gratuit) + scena, părul și semnele prin Haiku (doar poza nouă, ~jumătate din costul vechi)
async function checkPhoto(c, blob, shot, signal, together){
  pstage(signal, '🔍 Se uită dacă a ieșit bine', 97);
  const full = c.photo ? await DB.get(c.photo) : null; if(!full || !aiReady()) return null;
  const out = await stream('You are a strict photo checker. Answer with JSON only.', [{role:'user', images:[await blobToB64(await toJpeg(full, 768, .85)), await blobToB64(await toJpeg(blob, 768, .85))], text:
`Image 1 is the character's profile reference. Image 2 must depict that exact same individual in this scene: "${shot}". Identity is more important than artistic variation. Compare facial geometry, eye spacing, nose, lips, jaw, skin tone, hairline and hairstyle; if the body is visible in both images, also compare overall build and proportions. Do not penalize legitimate changes in clothing, pose, expression, lighting, camera angle or location when those follow the scene description.${together ? ' Image 2 must show exactly two people together in one natural photo (not a collage or split screen); score the character from image 1 for identity.' : ''}
Score strictly from 0 to 10:
- "face": is this unmistakably the same person, not merely a similar-looking person? 10 = strong match, 5 = noticeable identity drift, 0 = different person.
- "scene": does the generated photo match the requested place, activity, clothing and pose?
- "framing": does the camera framing match the requested selfie / mirror / full-body / close-up view?
"fix": if face is below 8 or scene below 6 or framing below 5, give ONE short concrete English correction prioritizing identity first, then scene; otherwise "".
JSON: {"face":0,"scene":0,"framing":0,"fix":""}`}], {max:220, signal, cid:c.id, aux:true});
  const j = parseJSON(out), n = k => Math.max(0, Math.min(10, Math.round(+j[k] || 0)));
  return {face:n('face'), scene:n('scene'), framing:n('framing'), fix:String(j.fix || '').slice(0, 300)};
}
// 9.7: o refacere costă cât o poză nouă; pe 9B se reface doar ce e clar greșit (pe Eco, ieftin, rămân pragurile de dinainte)
const checkSerious = x => !!x && ((x.d != null && x.d > .55) || (x.scene != null && x.scene < 5) || (x.framing != null && x.framing < 4));
const checkBad = x => !!x && ((x.d != null && x.d > ID_MAX) || (x.scene != null && x.scene < 6) || (x.framing != null && x.framing < 5) || (x.hair != null && x.hair < 6) || (x.marks != null && x.marks < 6) || (x.body != null && x.body < 6));
const checkScore = x => !x ? 0 : (x.d != null ? (1 - x.d) * 20 : (x.face != null ? x.face * 2 : 10)) + (x.scene ?? 5) + (x.framing ?? 5) * .5 + (x.hair ?? 5) * .7 + (x.marks ?? 5) * .5 + (x.body ?? 5) * .8;
/* 8.25: cea mai bună din N. Asemănarea variază mult de la o generare la alta (74–87% pe același model), deci se fac
   N variante în paralel (Worker), telefonul le măsoară gratuit fața și o păstrează pe cea mai apropiată de poza de profil.
   Doar ea trece mai departe (retuș, verificare Haiku). N scade singur dacă limita zilnică de neuroni nu ajunge. */
function bestN(c, opt = {}){
  if(S.imgProv !== 'worker' || !c.photo || opt.together) return 1;
  const mdl = sceneModel(opt), per = neurPerPhoto(mdl) || 5000;
  let n = Math.max(1, Math.min(3, +(mdl === 'eco' ? S.bestOf : S.bestOf9 || '1') || 1));
  while(n > 1 && capLeft() < per * n) n--;
  return n;
}
async function bestScene(c, shot, signal, corr, opt = {}){
  const n = S.wkChat === 'fal' && !(isAuto(opt) && S.autoModel === 'eco') ? 1 : bestN(c, opt);
  if(n < 2) return await scenePhoto(c, shot, signal, corr, opt);
  const rs = await Promise.allSettled(Array.from({length:n}, (_, k) => scenePhoto(c, shot, signal, corr, k ? {...opt, why:'variante'} : opt)));
  const ab = rs.find(r => r.status === 'rejected' && r.reason && r.reason.name === 'AbortError'); if(ab) throw ab.reason;
  const ok = rs.filter(r => r.status === 'fulfilled').map(r => r.value);
  if(!ok.length) throw rs[0].reason;
  pstage(signal, '🎯 Alege poza cea mai reușită', 93);
  for(const x of ok) x.fd = (await localFace(x.blob, c)).d;
  ok.sort((a, b) => (a.fd ?? 9) - (b.fd ?? 9));
  if(ok.length > 1) addUsage(c.id, imgPrice() * (ok.length - 1), 'img', null, opt.tag || 'poze');   // prima e numărată de cine a cerut poza
  const best = ok[0]; best.cands = ok.map(x => x.fd);
  return best;
}
// generează, retușează fața, verifică; dacă e cazul, încă un retuș (9B) sau o refacere completă; păstrează varianta mai bună
const otherBad = x => !!x && ((x.scene != null && x.scene < 6) || (x.framing != null && x.framing < 5) || (x.hair != null && x.hair < 6) || (x.marks != null && x.marks < 6) || (x.body != null && x.body < 6));
async function makeScenePhoto(c, shot, signal, opt = {}){
  let a = await scenePhoto(c, shot, signal, null, opt);
  if(S.imgCheck === 'off' || !aiReady()) return a;
  try{ a.check = await checkPhoto(c, a.blob, shot, signal, opt.together); }catch(e){ if(e.name === 'AbortError') throw e; return a; }
  const bad = x => x && (x.face < 8 || x.scene < 6 || x.framing < 5);
  if(!bad(a.check) || (S.wkChat !== 'fal' && capLeft() < (neurPerPhoto(S.wkChat || S.wkModel) || 5000))) return a;
  let b;
  try{ b = await scenePhoto(c, shot, signal, a.check.fix || 'follow the scene and keep the face of the reference', opt); addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze'); }
  catch(e){ if(e.name === 'AbortError') throw e; return a; }
  try{ b.check = await checkPhoto(c, b.blob, shot, signal, opt.together); }catch(e){ if(e.name === 'AbortError') throw e; }
  const sc = x => x ? x.face * 2 + x.scene + x.framing * .5 : 0;
  const best = b.check && sc(b.check) > sc(a.check) ? b : a;
  best.retried = true;
  return best;
}
let wkSimple = false;   // 7.2: Worker-ul a refuzat 2 repere în sesiunea asta
let lastImgModel = '';  // 7.3: modelul folosit la ultima poză (pentru cost)
let lastImgProv = '';   // 8.3: furnizorul folosit la ultima poză (fal pentru chat)
async function genImage(prompt, ref, signal, ref2, opt = {}){
  if(!opt.quiet){
    if(live && live.stage && live.stage.p >= 95 && busy && busy.signal === signal){ live.stage.pv = 50; }   // a doua încercare: bara coboară la jumătate
    pstage(signal, live && live.stage && live.stage.p >= 95 ? '🔁 Nu-i place, mai face una' : '📸 Face poza', 92);
  }
  const prov = opt.prov || S.imgProv; lastImgProv = prov;
  if(prov === 'gemini'){
    if(!hasKey('gemini')) throw new Error('Lipsește cheia Google în Setări → Poze.');
    const parts = [{text: ref ? 'Keep the exact same person from the reference image (same face, identity, hair). New photo: ' + prompt : prompt}];
    if(ref) parts.push({inline_data:{mime_type:ref.type || 'image/jpeg', data:await blobToB64(ref)}});
    const model = (S.gemModel || DEF.gemModel).trim();
    const r = await fetch(apiUrl('gemini', `/v1beta/models/${encodeURIComponent(model)}:generateContent`), {
      method:'POST', signal, headers:apiHeaders('gemini', {'content-type':'application/json'}),
      body: JSON.stringify({contents:[{parts}], generationConfig:{responseModalities:['IMAGE'], imageConfig:{aspectRatio:'3:4'}}})});
    if(!r.ok) throw new Error(await errText(r));
    const d = await r.json();
    const cand = d.candidates?.[0] || {};
    const im = (cand.content?.parts || []).map(x => x.inlineData || x.inline_data).find(Boolean);
    if(!im?.data) throw new Error('Gemini n-a dat imagine' + (cand.finishReason || d.promptFeedback?.blockReason ? ' (' + (cand.finishReason || d.promptFeedback.blockReason) + ')' : '') + '.');
    return b64ToBlob(im.data, im.mimeType || im.mime_type || 'image/png');
  }
  if(prov === 'worker'){
    if(!S.wkBase) throw new Error('Lipsește adresa Worker-ului în Setări → Poze.');
    const model = opt.model || S.wkModel || 'eco';
    await checkCap(model, opt.size);
    // 7.2: la o eroare de server Cloudflare (5xx, de ex. 3043) reîncearcă singur, tot mai simplu:
    //   1) poza de profil 768 px + fața (2 repere)  2) doar poza de profil 512 px  3) + prompt scurtat
    // dacă merge doar varianta simplă, o folosim până la următoarea pornire (wkSimple)
    // 7.3: reperul unic merge la 1024 px (fața are de 4 ori mai mulți pixeli decât la 512); testul din Setări fixează S.wkRef
    let steps = [];
    if(opt.force) steps = [opt.force];
    else {
      if(ref && ref2 && !wkSimple && S.wkRef !== 'one') steps.push({two:true});
      steps.push({two:false, px:512}, {two:false, px:512, short:true});
    }
    let lastErr;
    for(let i = 0; i < steps.length; i++){
      const st = steps[i];
      let p = prompt;
      if(!st.two) p = opt.p1 || p.replace(/,? ?image 2 is a close-up of the same face\. ?/i, ' ').replace(/the reference images: image 1 is the profile photo \(whole appearance\),/i, 'the reference image (the profile photo).');
      if(st.short && p.length > 1100) p = p.slice(0, 1100).replace(/[^.]*$/, '');
      const fd = new FormData();
      fd.append('prompt', p); fd.append('model', model); fd.append('size', opt.size || S.wkSize || '768x1024');
      fd.append('seed', String(Math.floor(Math.random() * 1e9)));
      // 8.3: 2 repere = fața (image) + poza pătrată (image_1); reper unic = poza pătrată (ref2), sau ref dacă nu există
      const one = opt.one || (!st.two && ref2 ? ref2 : ref);
      if(st.two && ref){ fd.append('image', await toJpeg(ref, opt.px1 || 512, .92), 'ref.jpg'); if(ref2) fd.append('image_1', await toJpeg(ref2, 512, .92), 'face.jpg');
        for(const [i, x] of (opt.extra || []).slice(0, 2).entries()) fd.append('image_' + (i + 2), await toJpeg(x, 512, .92), 'ref' + (i + 2) + '.jpg'); }
      else if(one) fd.append('image', await toJpeg(one, st.px || 512, .92), 'ref.jpg');
      const r = await fetch(wkUrl() + '/images/generations', {method:'POST', signal, body:fd,
        headers: S.wkTok ? {authorization:'Bearer ' + S.wkTok.trim()} : {}});
      if(r.ok){
        const d = await r.json();
        const b = d.data?.[0]?.b64_json; if(!b) throw new Error('Worker-ul n-a întors imagine.');
        if(!opt.force && i > 0 && steps[0].two && !wkSimple){ wkSimple = true; console.warn('Worker: 2 repere au dat eroare, folosesc doar poza de profil'); }
        lastImgModel = model;
        neurAdd(neurPerPhoto(model, opt.size) || 5000, opt.why);
        return b64ToBlob(b, 'image/png');
      }
      lastErr = await errText(r);
      if(opt.force || r.status < 500 || i === steps.length - 1) break;   // 4xx (cheie, limită, filtru): nu are rost să reîncercăm
      await new Promise(res => setTimeout(res, 1200 + i * 800));
    }
    if(/\b30(43|40)\b|internal server error|out of capacity/i.test(lastErr || '')) throw new Error('Cloudflare a avut o eroare internă (' + ((lastErr.match(/\b30\d\d\b/) || ['5xx'])[0]) + '), chiar după 3 încercări. De obicei trece în câteva minute; apasă Reîncearcă.');
    throw new Error(lastErr);
  }
  if(prov === 'fal'){
    if(!hasKey('fal')) throw new Error('Lipsește cheia fal.ai în Setări → Poze.');
    const model = (S.falModel || DEF.falModel).trim().replace(/^\/+|\/+$/g, '');
    const [w, h] = (S.falSize || '576x768').split('x').map(Number);
    const body = {prompt, image_size:{width:w, height:h}, num_images:1, sync_mode:true};
    if(ref){ const uri = 'data:' + (ref.type || 'image/jpeg') + ';base64,' + await blobToB64(ref); body.reference_image_url = uri; body.image_url = uri; body.image_urls = [uri]; }
    let r;
    try{ r = await fetch(apiUrl('fal', '/' + model), {method:'POST', signal, headers:apiHeaders('fal', {'content-type':'application/json'}), body:JSON.stringify(body)}); }
    catch(e){ if(e.name === 'AbortError') throw e; throw new Error('fal.ai nu răspunde din browser (rețea sau CORS). Spune-mi și îl trecem prin Worker-ul tău.'); }
    if(!r.ok){
      let t = r.statusText; try{ const j = await r.json(); t = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || j); }catch(e){}
      throw new Error('fal.ai ' + r.status + ': ' + t);
    }
    const d = await r.json();
    const u = d.images?.[0]?.url || d.image?.url;
    if(!u) throw new Error('fal.ai n-a întors imagine.');
    if(u.startsWith('data:')){ const k = u.indexOf(','); return b64ToBlob(u.slice(k + 1), u.slice(5, u.indexOf(';')) || 'image/jpeg'); }
    return await (await fetch(u, {signal})).blob();
  }
  throw new Error('Pozele sunt oprite. Pornește-le din Setări.');
}

/* ───────── navigare ───────── */
const VIEWS = ['vHome', 'vChat', 'vEdit', 'vSet', 'vWelcome', 'vProf'];
let flyNext = false, vtT = 0;
function show(id, push = true, dir){
  const was = VIEWS.find(v => !$('#' + v).hidden);
  VIEWS.forEach(v => $('#' + v).hidden = v !== id);
  const el = $('#' + id);
  // 8.9: ecranul vechi rămâne vizibil cât timp alunecă (are deja `hidden`, deci logica îl vede închis)
  $$('.view').forEach(v => v.classList.remove('vin-f', 'vin-b', 'vin-z', 'vout-f', 'vout-b', 'vout-z')); clearTimeout(vtT);
  if(was && was !== id && fxOn()){
    const d = flyNext ? 'z' : (dir || (push ? 'f' : (id === 'vHome' ? 'b' : 'f'))) === 'f' ? 'f' : 'b';
    const old = $('#' + was); void el.offsetWidth;
    el.classList.add('vin-' + d); old.classList.add('vout-' + d);
    vtT = setTimeout(() => { el.classList.remove('vin-' + d); old.classList.remove('vout-' + d); }, 380);
  }
  flyNext = false;
  if(push && id !== 'vHome' && !(history.state && history.state.v === id)) history.pushState({v:id}, '');
}
function back(){
  if(!$('#vSet').hidden && setPanel && !setPanelPushed){ closeSetPanel(); return; }
  if(history.state && history.state.v) history.back(); else goHome();
}
window.addEventListener('popstate', () => {
  if(call){ endCall(); return; }   // 8.5: Înapoi închide apelul
  if(stv){ closeStories(); history.pushState(history.state, ''); return; }   // 8.8: Înapoi închide story-ul
  if(albumEl && !$('.viewer')){ closeAlbum(); history.pushState(history.state, ''); return; }
  if(phoneEl && !$('.viewer')){ closePhone(); history.pushState(history.state, ''); return; }
  // intrarea-gardă de la pornire: Înapoi închide ce e deschis; abia pe Acasă, fără nimic deschis, iese din aplicație
  if(history.state && history.state.root){
    if($('.scrim,.viewer,.wrapv,.rscrim') || setPanel || $('#vHome').hidden){ closeSheet(); closeReactPicker(); if(setPanel) closeSetPanel(true); if($('#vHome').hidden) goHome(); history.pushState(null, ''); }
    else history.back();
    return;
  }
  if($('.rscrim')){ closeReactPicker(); history.pushState(history.state, ''); return; }
  if($('.scrim,.viewer,.wrapv')){ closeSheet(); history.pushState(history.state, ''); return; }
  if(!$('#vSet').hidden && setPanel && !setPanelPushed){ closeSetPanel(); history.pushState({v:'vSet'}, ''); return; }
  const v = history.state && history.state.v;
  if(!$('#vSet').hidden && setPanel){ closeSetPanel(); return; }
  if(v === 'vProf' && profId && charById(profId)){ charProfile(profId, false); return; }
  if(v === 'vChat' && cur && charById(cur.id)) openChat(cur.id, false, undefined, 'b');
  else goHome();
});
function goHome(){
  // 8.9: la întoarcere, avatarul din antet zboară înapoi în listă
  const av = !$('#vChat').hidden && cur ? $('#chAv') : null, cid = cur && cur.id;
  const from = av && av.getBoundingClientRect(), url = av && av.tagName === 'IMG' ? (av.currentSrc || av.src) : '';
  cur = null; chat = null; show('vHome', false); renderHome();
  if(!from || !url || !from.width || !fxOn()) return;
  requestAnimationFrame(() => {
    const t = [...$$('#vHome [data-open="' + cid + '"] img')].find(i => { if(i.closest('[hidden]')) return false; const r = i.getBoundingClientRect(); return r.width && r.width <= 140 && r.bottom > 60 && r.top < innerHeight - 90; });
    if(!t) return;
    const r0 = t.getBoundingClientRect(), vr = $('#vHome').getBoundingClientRect(), rad = getComputedStyle(t).borderRadius || '50%';
    const to = {left:r0.left - vr.left, top:r0.top - vr.top, width:r0.width, height:r0.height};   // poziția de după alunecare
    const f = document.createElement('img'); f.className = 'flyav'; f.src = url; document.body.appendChild(f); t.style.visibility = 'hidden';
    const a = f.animate([{left:from.left + 'px', top:from.top + 'px', width:from.width + 'px', height:from.height + 'px', borderRadius:'50%'},
      {left:to.left + 'px', top:to.top + 'px', width:to.width + 'px', height:to.height + 'px', borderRadius:rad}], {duration:360, easing:'cubic-bezier(.2,.8,.3,1)', fill:'forwards'});
    const end = () => { t.style.visibility = ''; f.remove(); }; a.onfinish = end; setTimeout(end, 700);
  });
}

/* ───────── ACASĂ ───────── */
// 8.9: cardul mare „continuă” + „ce fac acum”
function homeHeroHTML(recent){
  if(!recent.length) return '';
  const c = recent[0], online = c.lastAt && Date.now() - c.lastAt < 10 * 60e3, lf = lifeNow(c);
  const mood = c.moodNow && Date.now() - c.moodNow.ts < 12 * 36e5 ? shortMood(c.moodNow.t) : '';
  const sub = [lf && lf.w ? LIFE_E[lf.b] + ' ' + lf.w : '', mood].filter(Boolean).join(' · ');
  const last = String(c.last || '').replace(/^Tu: /, '');
  const mine = /^Tu: /.test(c.last || '');
  let h = `<button class="hhero${c.unread ? ' unr' : ''}" data-open="${c.id}">${c.photo ? `<img class="hhbg" data-k="${esc(photoNow(c))}" alt="">` : `<span class="hhbg ph" style="background:${colorFor(c)}"></span>`}
    <span class="hhov"><span class="hhtop">${online ? '<i class="on"></i>online' : esc(when(c.lastAt))}${c.unread ? ` · <em>${c.unread === 1 ? 'un mesaj nou' : c.unread + ' mesaje noi'}</em>` : ''}${clockHTML(c, 'hhclk', true)}</span>
    <b>${esc(c.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}
    ${last ? `<span class="hhmsg${mine ? ' mine' : ''}">${mine ? 'Tu: ' : ''}${esc(last)}</span>` : ''}
    <span class="hhgo">Continuă <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></span></span></button>`;
  const rest = recent.slice(1, 9);
  if(rest.length) h += `<div class="hsec">Ce fac acum</div><div class="hnowr">${rest.map(x => {
    const on = x.lastAt && Date.now() - x.lastAt < 10 * 60e3, l = lifeNow(x), md = x.moodNow && Date.now() - x.moodNow.ts < 12 * 36e5 ? shortMood(x.moodNow.t) : '';
    const what = charBdayToday(x) ? '🎂 își serbează ziua' : l && l.w ? LIFE_E[l.b] + ' ' + l.w : md || ('💬 ' + when(x.lastAt));
    return `<button class="hnow${x.unread ? ' unr' : ''}" data-open="${x.id}"><span class="hnav">${avatarHTML(x)}${on ? '<i class="on"></i>' : ''}${x.unread ? `<em>${x.unread > 9 ? '9+' : x.unread}</em>` : ''}</span><span class="hnt"><b>${esc(x.name)}</b><small>${clockHTML(x, 'nclk')}${esc(what)}</small></span></button>`; }).join('')}</div>`;
  return h;
}
let homeTab = 'chars';
function renderHome(){
  $$('#nav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === homeTab));
  $('#homeChars').hidden = homeTab !== 'chars';
  $('#homeChats').hidden = homeTab !== 'chats';
  $('#homeFeed').hidden = homeTab !== 'feed';
  if(homeTab === 'feed') renderFeed();
  feedDot();
  const sorted = [...chars].sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (b.lastAt || b.created || 0) - (a.lastAt || a.created || 0));
  $('#searchWrap').hidden = homeTab !== 'chars' || chars.length < 5;
  if($('#searchWrap').hidden && homeTab === 'chars') $('#search').value = '';
  const q = $('#search').value.trim().toLowerCase();
  const shown = q ? sorted.filter(c => (c.name + ' ' + (c.tag || '')).toLowerCase().includes(q)) : sorted;
  const hr = new Date().getHours(), salut = hr < 5 ? 'Noapte bună' : hr < 11 ? 'Bună dimineața' : hr < 18 ? 'Bună ziua' : 'Bună seara';
  const recent = q ? [] : chars.filter(c => c.last).sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 12);
  const unreadN = chars.reduce((n, c) => n + (c.unread || 0), 0);
  const top = q || !chars.length ? '' : `<div class="hhello"><b>${salut}${S.userName.trim() ? ', ' + esc(S.userName.trim()) : ''}</b><small>${unreadN ? `Ai ${unreadN === 1 ? 'un mesaj nou' : unreadN + ' mesaje noi'} 💌` : 'Cu cine stai la taifas azi?'}</small></div>` + storyRowHTML()
    + homeHeroHTML(recent)
    + `<div class="hsec">Personajele tale <span>${chars.length}</span></div>`;
  const bk = !q && bkDue() ? `<div class="bkslim"><span>💾</span><span class="bkt"><b>Backup: ${esc(bkAgo())}</b><small>Totul stă doar în telefonul ăsta</small></span><button class="btn sm pri" data-bk="share">📤 Drive</button><button class="btn sm" data-bk="dl" aria-label="Salvează">⬇</button><button class="bkx" data-bk="later" aria-label="Mai târziu">✕</button></div>` : '';
  $('#homeChars').innerHTML = bk + top + (!chars.length ? `<button class="card empty" data-new><b>Niciun personaj încă</b>Apasă ＋ jos ca să creezi primul personaj, din poză sau din imaginație.</button>` : '') +
    shown.map(c => `<button class="card${c.fav ? ' isfav' : ''}" data-open="${c.id}">${c.fav ? '<span class="fav">⭐</span>' : ''}${c.unread ? `<span class="ubadge">${c.unread > 9 ? '9+' : c.unread}</span>` : ''}${c.lastAt && c.last || clockHTML(c) ? `<span class="tl">${c.lastAt && c.last ? `<span class="when">${when(c.lastAt)}</span>` : ''}${clockHTML(c, 'when clk')}</span>` : ''}
      ${c.photo ? `<img data-k="${esc(photoNow(c))}" alt="">` : `<div class="ph" style="background:${colorFor(c)}">${esc(c.name[0] || '?')}</div>`}
      <div class="ov"><b>${esc(c.name)}</b>${c.tag ? `<small>${esc(c.tag)}</small>` : ''}${cardStatus(c)}${c.rel ? `<span class="crel">💞 ${esc(relOf(c).name)}</span>` : ''}${c.last ? `<em class="lm">${esc(c.last)}</em>` : ''}</div></button>`).join('') + (chars.length && !q ? `<button class="card new" data-new><span>＋</span><em>Personaj nou</em></button>` : '');
  const withChat = chars.filter(c => c.last).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const pinned = withChat.filter(c => c.pinned), rest = withChat.filter(c => !c.pinned);
  const crow = c => {
    const online = c.lastAt && Date.now() - c.lastAt < 10 * 60e3, n = threadsOf(c).length;
    const prev = esc(c.last).replace(/^Tu: /, '<b style="font-weight:600;color:var(--tx3)">Tu:</b> ');
    return `<div class="crow" data-c="${c.id}">
      <div class="cact"><button data-pin>${c.pinned ? '📍' : '📌'}<span>${c.pinned ? 'Scoate' : 'Fixează'}</span></button><button data-clr>🧹<span>Golește</span></button></div>
      <button class="cfront${c.unread ? ' unr' : ''}" data-open="${c.id}">
        <span class="cav">${avatarHTML(c)}${online ? '<i class="on"></i>' : ''}</span>
        <span class="cmid"><span class="ctop"><b>${c.pinned ? '📌 ' : ''}${esc(c.name)}</b><time class="${c.unread ? 'new' : ''}">${when(c.lastAt)}</time></span>
        <span class="cbot"><small>${prev}</small>${n > 1 ? `<span class="thr">🧵 ${n}</span>` : ''}${c.unread ? `<span class="badge">${c.unread > 9 ? '9+' : c.unread}</span>` : ''}</span>${(() => { const lf = lifeNow(c), ck = clockHTML(c, 'nclk'); if(charBdayToday(c)) return `<span class="clife">${ck}🎂 Își serbează ziua azi</span>`; return lf && lf.w ? `<span class="clife">${ck}${LIFE_E[lf.b]} ${esc(lf.w)}</span>` : ck ? `<span class="clife">${clockHTML(c, 'nclk solo')}</span>` : ''; })()}</span>
      </button></div>`;
  };
  $('#homeChats').innerHTML = storyRowHTML() + (withChat.length
    ? (pinned.length ? '<div class="clabel">Fixate</div>' + pinned.map(crow).join('') + (rest.length ? '<div class="clabel">Recente</div>' : '') : '') + rest.map(crow).join('')
      + '<div class="hint" style="text-align:center;margin:14px 0">Glisează spre stânga pe o conversație ca s-o fixezi sau s-o golești.</div>'
    : `<div class="empty">Nicio conversație încă.<br>Alege un personaj din „Acasă".</div>`);
  $$('[data-bk]').forEach(b => b.onclick = e => { e.stopPropagation(); const k = b.dataset.bk; if(k === 'later'){ S.bkSnooze = Date.now() + 2 * 864e5; saveSettings(); renderHome(); } else exportAll(k === 'share'); });
  hydrate($('#vHome')); bindStoryRow($('#vHome'));
}
function when(ts){
  if(!ts) return '';
  const d = new Date(ts), n = new Date();
  if(d.toDateString() === n.toDateString()) return d.toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'});
  return d.toLocaleDateString('ro-RO', {day:'numeric', month:'short'});
}

/* ───────── CONVERSAȚIE ───────── */
async function openChat(id, push = true, tid, dir){
  cur = charById(id); if(!cur) return;
  threadsOf(cur);
  tid = tid || cur.thread || 'main';
  if(!cur.threads.some(t => t.id === tid)) tid = cur.threads[0].id;
  cur.thread = tid;
  chat = (live && live.c.id === id && (live.ch.tid || 'main') === tid) ? live.ch : await loadChat(cur, tid);
  if(!chat.msgs.length && cur.greet) chat.msgs.push(greetMsg(cur));
  $('#chAv').outerHTML = avatarHTML(cur, 'av" id="chAv');
  $('#chName').textContent = cur.name;
  $('#chTag').innerHTML = statusLine();
  $('#chatBg').style.backgroundImage = '';
  if(cur.photo && ['clar', 'poza'].includes(cur.bg || 'clar')) $('#chatBg').dataset.bgk = cur.photo;
  applyLook(cur);
  renderScene();
  updateComposer();
  resetMsgWin();
  show('vChat', push, dir);
  if(cur.unread){ cur.unread = 0; saveChars(); }
  renderMsgs(true);
  hydrate($('#vChat'));
  setBusyUI(!!(busy && live && live.ch === chat));
  $('#sugg').innerHTML = '';
  clearReply(); jumpCount = 0;
  if((cur.sched || []).some(x => x.at <= Date.now())) runDueSched(); else annCheck(cur).then(async done => { if(!done) done = await bdayCheck(cur); if(!done) maybeProactive(); });
  setTimeout(jrnSweep, 2500);
}
function tagLine(c){
  const ts = threadsOf(c);
  if(ts.length > 1){ const t = ts.find(x => x.id === (c.thread || 'main')); return '🧵 ' + (t ? t.title : ''); }
  return c.tag || '';
}
const ACCENTS = ['#ff4f9a', '#9b5cff', '#4f8cff', '#22c3a6', '#ffb020', '#ff6b4a', '#c08a5c', '#d8d0e0'];
function applyLook(c){
  const v = $('#vChat'), a = c.accent;
  if(a){
    v.style.setProperty('--acc', a);
    v.style.setProperty('--grad', `linear-gradient(135deg,${a},color-mix(in srgb,${a} 55%,#9b5cff))`);
    v.style.setProperty('--me', `color-mix(in srgb,${a} 30%,#1a1622)`);
  } else ['--acc', '--grad', '--me'].forEach(k => v.style.removeProperty(k));
  v.classList.toggle('bg-grad', c.bg === 'grad');
  v.classList.toggle('bg-clar', (c.bg || 'clar') === 'clar' && !!c.photo);
  v.classList.toggle('bg-none', c.bg === 'none');
}
// 8.10: cer viu: fundalul urmează ora și vremea reală din orașul personajului
function skyPhase(c, w){
  const d = charNow(c), m = d.getHours() * 60 + d.getMinutes(), sr = w && w.sr != null ? w.sr : 405, ss = w && w.ss != null ? w.ss : 1150;
  if(m < sr - 50 || m > ss + 55) return 'night';
  if(m < sr + 50) return 'dawn';
  if(m > ss) return 'dusk';
  if(m > ss - 75) return 'golden';
  return 'day';
}
function paintSky(c, w){
  const el = $('#chSky'); if(!el) return;
  if(S.sky === 'off' || !c){ el.hidden = true; return; }
  const code = w ? w.code : 1;
  const cond = [45, 48].includes(code) ? 'fog' : [71, 73, 75, 77, 85, 86].includes(code) ? 'snow' : (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95 ? 'rain' : code === 3 ? 'cloud' : code === 2 ? 'part' : 'clear';
  el.dataset.ph = skyPhase(c, w); el.dataset.cond = cond; el.hidden = false;
  const st = el.querySelector('.stars');
  if(!st.childElementCount) for(let i = 0; i < 40; i++){ const b = document.createElement('b'); b.style.left = Math.random() * 100 + '%'; b.style.top = Math.random() * 45 + '%'; b.style.animationDelay = (-Math.random() * 4) + 's'; b.style.transform = `scale(${.4 + Math.random() * .9})`; st.appendChild(b); }
}
function renderScene(){
  paintSky(cur, wxMem[cur.id] && wxMem[cur.id].w);
  weatherOf(cur).then(w => { if(cur && !$('#vChat').hidden){ paintSky(cur, w); if(!(busy && live && live.ch === chat)) $('#chTag').innerHTML = statusLine(); } }).catch(() => {});
  setWeather(chat && chat.scene);
  if(!(chat && chat.scene)) weatherOf(cur).then(w => { if(w && w.fx && cur && !$('#vChat').hidden) setWeather(w.fx === 'rain' ? 'ploaie' : 'ninge'); }).catch(() => {});
  const b = $('#sceneBar');
  b.hidden = !chat.scene;
  b.textContent = chat.scene ? '🎬 ' + chat.scene : '';
}
function editScene(){
  openSheet(`<h4>🎬 Scena</h4><p>Unde sunteți, când, ce se întâmplă. ${esc(cur.name)} ține cont de ea, iar pozele pornesc de aici.</p>
    <div class="pad"><textarea id="shTxt" placeholder="ex. Seara, într-o cafenea mică din centrul vechi, plouă afară.">${esc(chat.scene || '')}</textarea>
    <div class="btns"><button class="btn" id="shClr">Fără scenă</button><button class="btn pri" id="shOk">Aplică</button></div></div>`);
  const done = async t => { chat.scene = t; await saveChat(); renderScene(); closeSheet(); toast(t ? 'Scena e setată.' : 'Scena a fost scoasă.'); };
  $('#shOk').onclick = () => done($('#shTxt').value.trim());
  $('#shClr').onclick = () => done('');
}
const PRO_H = 8;
/* ⏰ mesaje programate: personajul promite că îți scrie la o oră; când o deschizi după ora aceea, mesajul e acolo, cu ora promisă */
function parseSched(raw){
  const [when, ...rest] = String(raw).split('|'), note = rest.join('|').trim();
  const w = when.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tm = w.match(/(\d{1,2})[:.](\d{2})/); if(!tm) return null;
  const hh = +tm[1], mi = +tm[2]; if(hh > 23 || mi > 59) return null;
  const d = new Date(); d.setSeconds(0, 0);
  const iso = w.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(iso) d.setFullYear(+iso[1], +iso[2] - 1, +iso[3]);
  else if(/poimaine/.test(w)) d.setDate(d.getDate() + 2);
  else if(/maine/.test(w)) d.setDate(d.getDate() + 1);
  d.setHours(hh, mi, 0, 0);
  if(!iso && !/maine|azi/.test(w) && d.getTime() < Date.now()) d.setDate(d.getDate() + 1);   // doar ora: următoarea apariție
  const at = d.getTime();
  if(at < Date.now() - 60e3 || at > Date.now() + 14 * 864e5) return null;
  return {at, note: note.slice(0, 160)};
}
function addSched(c, ch, sc){
  c.sched = (c.sched || []).filter(x => Math.abs(x.at - sc.at) > 5 * 60e3 || x.tid !== (ch.tid || 'main'));
  const nid = uid();
  c.sched.push({id:nid, tid:ch.tid || 'main', at:sc.at, note:sc.note, made:Date.now()});
  c.sched.sort((a, b) => a.at - b.at);
  pushAt('s:' + nid, sc.at, c.name, '💬 Ți-a scris un mesaj', 'c:' + c.id);
  saveChars();
  toast(`⏰ ${c.name} îți scrie ${whenText(sc.at)}`, 3500);
}
function whenText(at){
  const d = new Date(at), t = d.toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'});
  const k = dayKey(at), today = dayKey(Date.now()), tm = dayKey(Date.now() + 864e5);
  return (k === today ? 'azi' : k === tm ? 'mâine' : d.toLocaleDateString('ro-RO', {weekday:'long', day:'numeric', month:'short'})) + ' la ' + t;
}
let schedRun = false;
async function runDueSched(){
  if(schedRun || busy || !aiReady()) return;
  schedRun = true;
  try{
    for(const c of [...chars]){
      const due = (c.sched || []).filter(x => x.at <= Date.now());
      for(const x of due){
        if(busy) return;
        c.sched = c.sched.filter(y => y !== x); await saveChars();
        if(Date.now() - x.at > 3 * 864e5) continue;                       // prea vechi: renunțăm
        if(!threadsOf(c).some(t => t.id === x.tid)) continue;
        if(/\b(sun|apel|telefon|video)/i.test(x.note || '') && Date.now() - x.at < 10 * 60e3 && !document.hidden && !locked && !call && !inCallEl && c.callIn !== false){ showIncoming(c, {video:/video/i.test(x.note), reason:x.note}); return; }   // 8.14: a promis că te sună: te sună
        const open = cur === c && chat && (chat.tid || 'main') === x.tid;
        const ch = open ? chat : await loadChat(c, x.tid);
        const u = S.userName.trim() || 'utilizatorul';
        const hm = new Date(x.at).toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'});
        await reply(null, {c, ch, pro:true, sched:true, at:x.at, note:`(Notă de regie, nu o menționa ca atare: acum e ora ${hm}, momentul la care i-ai promis lui ${u} că îi scrii${x.note ? ' („' + x.note + '”)' : ''}. Scrie-i acum mesajul promis, firesc, ca și cum îl trimiți exact la ora asta, din ce faci tu în acest moment.)`});
        if(!$('#vHome').hidden) renderHome();
      }
    }
  } finally { schedRun = false; }
}
function schedSheet(){
  const c = cur, list = (c.sched || []).filter(x => x.tid === (chat.tid || 'main'));
  const d = new Date(Date.now() + 864e5); d.setHours(7, 25, 0, 0);
  const def = new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  openSheet(`<h4>⏰ Mesaje programate de la ${esc(c.name)}</h4><div class="pad">
    ${list.length ? `<ul class="facts">${list.map(x => `<li><span><b>${esc(whenText(x.at))}</b>${x.note ? ' · ' + esc(x.note) : ''}</span><button data-sx="${x.id}" aria-label="Anulează">✕</button></li>`).join('')}</ul>` : `<p style="color:var(--tx3)">Nimic programat. Când ${esc(c.name)} îți promite că îți scrie la o oră, apare aici singur.</p>`}
    <label style="margin-top:14px">Programează tu un mesaj</label>
    <input id="scAt" type="datetime-local" value="${def}">
    <input id="scNote" placeholder="Despre ce (opțional), ex: să-mi ureze bună dimineața" style="margin-top:8px">
    <div class="btns" style="margin-top:10px"><button class="btn pri" id="scAdd">Programează</button></div></div>`);
  $$('.sheet [data-sx]').forEach(b => b.onclick = async () => { c.sched = (c.sched || []).filter(x => x.id !== b.dataset.sx); pushCancel('s:' + b.dataset.sx); await saveChars(); closeSheet(); toast('Anulat.'); });
  $('#scAdd').onclick = async () => {
    const at = new Date($('#scAt').value).getTime();
    if(!at || at < Date.now()){ toast('Alege o oră din viitor.'); return; }
    addSched(c, chat, {at, note:$('#scNote').value.trim()}); closeSheet();
  };
}
/* ───────── 🗓️ ziua personajului ───────── */
const LIFE_E = {0:'☕', 1:'💼', 2:'😴'};
const tmin = t => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
// 8.10: ora locală a personajului (din orașul lui), ca programul, cerul și notele să meargă după ea
const charShift = c => c && c.geo && typeof c.geo.off === 'number' ? c.geo.off * 1000 + new Date().getTimezoneOffset() * 60000 : 0;
const charNow = c => new Date(Date.now() + charShift(c));
function charTimeNote(c){
  if(Math.abs(charShift(c)) < 36e5) return '';
  const d = charNow(c), h = d.getHours();
  return ` (la tine${c.geo && c.geo.name ? ', în ' + c.geo.name : ''}, e acum ${d.toLocaleDateString('ro-RO', {weekday:'long'})}, ora ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}, ${h < 5 ? 'noaptea târziu' : h < 11 ? 'dimineața' : h < 14 ? 'la prânz' : h < 18 ? 'după-amiaza' : h < 22 ? 'seara' : 'noaptea'}; trăiești după ora ta, nu după a lui)`;
}
// 8.18: ceasul personajului pe Acasă, doar când fusul lui diferă de al tău
function clockTxt(c){
  const d = charNow(c), h = d.getHours();
  return (h >= 22 || h < 6 ? '🌙 ' : '🕒 ') + String(h).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function clockHTML(c, cls = 'clk', city = false){
  if(Math.abs(charShift(c)) < 30 * 60e3) return '';
  return `<span class="${cls}" data-clk="${c.id}"${city ? ' data-city="1"' : ''}>${esc(clockTxt(c) + (city && c.geo && c.geo.name ? ' · ' + c.geo.name : ''))}</span>`;
}
function tickClocks(){
  if(document.hidden || $('#vHome').hidden) return;
  $$('#vHome [data-clk]').forEach(el => { const c = charById(el.dataset.clk); if(c) el.textContent = clockTxt(c) + (el.dataset.city && c.geo && c.geo.name ? ' · ' + c.geo.name : ''); });
}
function lifeNow(c, ts = Date.now()){
  if(!c || !c.life || c.lifeOff) return null;
  const d = new Date(ts + charShift(c)), list = [0, 6].includes(d.getDay()) ? (c.life.we || c.life.wk) : c.life.wk;
  const n = d.getHours() * 60 + d.getMinutes();
  return (list || []).find(x => { const a = tmin(x.f), b = tmin(x.t); return a <= b ? (n >= a && n < b) : (n >= a || n < b); }) || null;
}
const lifeLines = list => (list || []).map(x => `${x.f}-${x.t} | ${x.w} | ${['liber', 'ocupat', 'doarme'][x.b] || 'liber'}`).join('\n');
function parseLife(txt){
  return String(txt || '').split('\n').map(l => { const m = l.match(/(\d{1,2}[:.]\d{2})\s*-\s*(\d{1,2}[:.]\d{2})\s*\|\s*([^|]+?)\s*(?:\|\s*(\S+))?\s*$/); if(!m) return null;
    const fx = t => t.replace('.', ':').padStart(5, '0'); return {f:fx(m[1]), t:fx(m[2]), w:m[3].trim().slice(0, 60), b:/doarm|somn/i.test(m[4] || '') ? 2 : /ocup/i.test(m[4] || '') ? 1 : 0}; }).filter(Boolean);
}
async function genLife(c){
  const out = await stream('Creezi rutine zilnice realiste pentru personaje. Răspunzi DOAR cu JSON valid.', [{role:'user', text:
`Personaj: ${c.name}. ${c.tag ? 'Pe scurt: ' + c.tag + '. ' : ''}${c.persona ? 'Descriere: ' + c.persona.slice(0, 1200) : ''}
Scrie programul unei zile obișnuite de lucru și al unei zile de weekend pentru acest personaj, în română, acoperind toate cele 24 de ore, 6-10 intervale pe zi (inclusiv somnul). Fiecare interval: de la, până la (HH:MM), ce face (3-8 cuvinte, la persoana a III-a, fără nume, ex: „la cafeneaua de lângă birou”) și starea: liber, ocupat sau doarme.
Fără ghilimele în texte. JSON: {"lucru":[{"de":"07:00","pana":"08:00","ce":"…","stare":"liber"}],"weekend":[…]}`}], {max:2400, cid:c.id});
  const j = parseJSON(out);
  const conv = a => (Array.isArray(a) ? a : []).map(x => ({f:String(x.de || '').slice(0, 5), t:String(x.pana || '').slice(0, 5), w:String(x.ce || '').trim().slice(0, 60), b:/doarm|somn/i.test(x.stare) ? 2 : /ocup/i.test(x.stare) ? 1 : 0})).filter(x => /^\d{2}:\d{2}$/.test(x.f) && /^\d{2}:\d{2}$/.test(x.t) && x.w);
  const wk = conv(j.lucru), we = conv(j.weekend);
  if(wk.length < 3) throw new Error('Programul n-a ieșit bine. Mai încearcă.');
  c.life = {wk, we: we.length >= 3 ? we : wk}; delete c.lifeOff; await saveChars();
}
function drawLife(c){
  const box = $('#pfLife'); if(!box) return;
  if(!c.life){
    box.innerHTML = `<p style="color:var(--tx3);font-size:.88rem;margin:0 0 10px">${esc(c.name)} n-are încă un program al zilei. Cu el, știe ce face la fiecare oră (la muncă, acasă, doarme), iar sus în conversație apare ce face acum.</p><div class="btns"><button class="btn sm" id="lfGen">✨ Creează programul din descriere</button></div>`;
  } else {
    const now = lifeNow(c), d = new Date(), list = [0, 6].includes(d.getDay()) ? c.life.we : c.life.wk;
    box.innerHTML = `${c.lifeOff ? '<p class="lifenow" style="color:var(--tx3)">⏸ Programul e oprit.</p>' : now ? `<p class="lifenow">Acum: ${LIFE_E[now.b]} <b>${esc(now.w)}</b></p>` : ''}
      <div class="life">${(list || []).map(x => `<div class="lr${now === x ? ' now' : ''}"><time>${x.f} - ${x.t}</time><span>${LIFE_E[x.b]} ${esc(x.w)}</span></div>`).join('')}</div>
      <div class="btns jbtn"><button class="btn sm" id="lfEdit">✏️ Editează</button><button class="btn sm" id="lfGen">✨ Refă</button><button class="btn sm" id="lfOff">${c.lifeOff ? '▶ Pornește' : '⏸ Oprește'}</button></div>`;
    $('#lfOff').onclick = async () => { c.lifeOff = !c.lifeOff; await saveChars(); drawLife(c); };
    $('#lfEdit').onclick = () => {
      openSheet(`<h4>🗓️ Programul lui ${esc(c.name)}</h4><div class="pad"><p class="hint">Un rând pe interval: <b>07:00-09:00 | la muncă | ocupat</b> (stare: liber, ocupat sau doarme).</p>
        <label>Zi de lucru</label><textarea id="lfWk" rows="8">${esc(lifeLines(c.life.wk))}</textarea>
        <label style="margin-top:10px">Weekend</label><textarea id="lfWe" rows="8">${esc(lifeLines(c.life.we))}</textarea>
        <div class="btns" style="margin-top:10px"><button class="btn" data-close>Renunță</button><button class="btn pri" id="lfSave">Salvează</button></div></div>`);
      $('#lfSave').onclick = async () => { const wk = parseLife($('#lfWk').value), we = parseLife($('#lfWe').value); if(!wk.length){ toast('N-am înțeles niciun rând. Folosește formatul din exemplu.'); return; } c.life = {wk, we: we.length ? we : wk}; await saveChars(); closeSheet(); drawLife(c); };
    };
  }
  $('#lfGen').onclick = async () => { const b = $('#lfGen'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Creez…'; try{ await genLife(c); }catch(e){ toast(e.message, 3500); } drawLife(c); };
}

/* ───────── 💝 amintiri și aniversări ───────── */
function addMoment(c, t, kind, day = dayKey(Date.now())){
  c.moments = (c.moments || []).filter(x => !(x.day === day && x.t === t));
  c.moments.push({day, t, kind:kind || 'moment'}); c.moments.sort((a, b) => a.day < b.day ? 1 : -1); c.moments = c.moments.slice(0, 200);
  saveChars();
}
async function momentFromJournal(c, day, text){
  try{
    const out = (await stream('Extragi momente importante. Răspunzi scurt, în română.', [{role:'user', text:
      `Pagina de jurnal a lui ${c.name}:\n${text}\n\nScrie momentul cel mai memorabil al zilei într-o propoziție scurtă (max 14 cuvinte), la persoana a II-a plural, ca într-un album (ex: „Ați râs împreună de pățania cu pisica.”). Dacă ziua a fost banală, scrie doar: NIMIC`}], {max:80, cid:c.id, aux:true})).trim();
    const t = faraLiniute(plain(out)).replace(/^["„]|["”]$/g, '').trim();
    if(t && !/^nimic/i.test(t) && t.length > 8 && t.length < 160) addMoment(c, t, 'moment', day);
  }catch(e){}
}
const ANN = [7, 30, 50, 100, 200, 365, 500, 730, 1000];
async function firstDay(c){
  if(c.first) return c.first;
  const ts = (await allChats(c)).flatMap(ch => ch.msgs.map(m => m.ts || 0)).filter(Boolean);
  c.first = ts.length ? Math.min(...ts) : (c.created || Date.now()); await saveChars(); return c.first;
}
const daysSince = ts => Math.round((new Date(dayKey(Date.now()) + 'T12:00') - new Date(dayKey(ts) + 'T12:00')) / 864e5);
async function annCheck(c){
  if(!c || busy) return false;
  const d = daysSince(await firstDay(c));
  if(!ANN.includes(d) || c.annDone === d) return false;
  if(!chat.msgs.some(m => m.role === 'user')) return false;
  c.annDone = d; await saveChars();
  const lbl = d === 365 ? 'un an' : d === 730 ? 'doi ani' : d + (d >= 20 ? ' de zile' : ' zile');
  addMoment(c, `🎉 ${lbl} de când vă știți`, 'ann');
  toast(`🎉 Azi se împlinesc ${lbl} cu ${c.name}!`, 4000); fxConfetti();
  if(S.pro !== 'on' || !aiReady()) return false;
  const u = S.userName.trim() || 'utilizatorul';
  reply(null, {pro:true, note:`(Notă de regie, nu o menționa ca atare: azi se împlinesc ${lbl} de când vorbiți tu și ${u}. Scrie-i tu primul și marchează asta în felul tău, cald și firesc, poate cu o amintire de-a voastră, fără să exagerezi.)`});
  return true;
}
// ce adaugă aplicația la mesajul tău (nu în promptul de sistem, ca să rămână în cache)
function turnExtras(c, ch, opts = {}){
  let x = '';
  const chat = ch;   // 7.8: conversația pentru care se scrie răspunsul (nu cea deschisă pe ecran)
  const freshTurn = !opts.pro && !opts.sched && !opts.cont;   // răspuns la un mesaj nou de-al tău
  // dacă ultimele răspunsuri s-au terminat toate cu întrebări, cerem explicit o pauză de la întrebări
  const ais = (chat && chat.msgs || []).filter(m => m.role === 'ai' && m.text && !m.err && !m.pending).slice(-3);
  const q = ais.filter(m => /\?\s*(\*[^*]*\*\s*)?$/.test(stripMood(m.text).trim())).length;
  if(ais.length >= 2 && q >= 2) x += ' (notă de stil: ultimele tale mesaje s-au încheiat cu întrebări; de data asta nu încheia cu o întrebare, spune ceva de-al tău, în afară de cazul în care trebuie să luați împreună o decizie din scenă)';
  // 7.7: după o pauză de peste 3 ore: întreabă de ce urma să i se întâmple + o întâmplare măruntă din ziua personajului
  const ms = (chat && chat.msgs || []).filter(m => !m.err && m.ts && !m.pending), li = ms.map(m => m.role).lastIndexOf('user');
  const gapNow = li > 0 ? ms[li].ts - ms[li - 1].ts : 0;
  if(freshTurn && gapNow > 3 * 36e5){
    const f = (c.facts || []).find(z => z.k === 'urm' && !z.asked && Date.now() - (z.ts || 0) > 6 * 36e5);
    if(f){ f.asked = Date.now(); saveChars(); x += ` (îți amintești că urma să i se întâmple: „${f.t}”. Întreabă-l firesc cum a fost, dacă se potrivește cu ce-ți scrie acum)`; }
    x += ' (între timp, în ziua ta s-a întâmplat ceva mărunt, potrivit cu programul și viața ta; dacă se leagă, povestește-i scurt, din proprie inițiativă)';
  }
  // 7.7: lungime variabilă, ca într-un chat real
  const rnd = Math.random();
  if(rnd < .16) x += ' (de data asta, dacă momentul o permite, răspunde foarte scurt, ca pe chat: câteva cuvinte, poate un emoji)';
  else if(rnd > .9) x += ' (de data asta, dacă ai ceva de spus, poți fi mai povestitor decât de obicei)';
  // 7.6: scena în desfășurare: personajul continuă de unde ați rămas, cu pasul următor mic
  if(chat && chat.plot && Date.now() - (chat.plot.ts || 0) < 12 * 36e5) x += ` (scena în desfășurare: „${chat.plot.t}”. Continuă de unde ați rămas, cu pasul următor, mic și firesc, fără să sari peste etape; dacă ${S.userName.trim() || 'el'} a schimbat planul sau subiectul, urmează-l)`;
  // 6.7: întrebările din ultimul tău mesaj sunt numite explicit, ca personajul să nu le ocolească
  const lu = [...(chat && chat.msgs || [])].reverse().find(m => m.role === 'user' && m.text && !m.err);
  if(lu && freshTurn){ const qs = plain(lu.text).split(/(?<=[?])/).map(x => x.trim()).filter(x => x.endsWith('?') && x.length > 3).slice(-4);
    if(qs.length) x += ` (${S.userName.trim() || 'el'} te-a întrebat: ${qs.map(q => '„' + q.slice(-160) + '”').join(' ')}; răspunde-i concret la ${qs.length > 1 ? 'fiecare' : 'ea'}, în felul tău)`; }
  x += charTimeNote(c);
  if(!opts.cont) x += giftExtras(c);
  x += socialExtras(c, opts);
  x += lifeExtras(c, opts);
  const lf = lifeNow(c);
  if(lf) x += ` (după programul tău, acum ești: ${lf.w}${lf.b === 1 ? '; ești ocupat(ă), deci răspunzi mai scurt, ca din pauză' : lf.b === 2 ? '; dormeai, te-a trezit mesajul' : ''})`;
  // „acum o săptămână / o lună / un an”: o amintire, o singură dată
  const ago = [[7, 'o săptămână'], [30, 'o lună'], [365, 'un an']];
  for(const [n, lbl] of ago){
    const day = dayKey(Date.now() - n * 864e5), mo = (c.moments || []).find(m => m.day === day && m.kind === 'moment' && !m.rc);
    if(mo){ mo.rc = 1; saveChars(); x += ` (acum ${lbl} ați trăit asta: „${mo.t}”. O poți aminti natural, doar dacă se potrivește.)`; break; }
  }
  const lk = feedCache.find(p => p.cid === c.id && p.liked && !p.likeNoted);
  if(lk){ lk.likeNoted = 1; saveFeed(); x += ` (${S.userName.trim() || 'el'} ți-a dat ❤️ la statusul „${lk.text.slice(0, 120)}”)`; }
  return x;
}
async function drawMem(c){
  const box = $('#pfMem'); if(!box) return;
  const f = await firstDay(c), d = daysSince(f), next = ANN.find(x => x > d);
  const nextDate = next ? new Date(new Date(dayKey(f) + 'T12:00').getTime() + next * 864e5).toLocaleDateString('ro-RO', {day:'numeric', month:'long'}) : '';
  const ms = c.moments || [], show = ms.slice(0, 8);
  const li = m => `<li>${esc(m.t)}<small>${new Date(m.day + 'T12:00').toLocaleDateString('ro-RO', {day:'numeric', month:'long', year:'numeric'})}</small></li>`;
  box.innerHTML = `<button class="btn pri albtn" id="memAlbum">📖 Deschide albumul vostru</button><p class="annline">💞 <b>${d}</b> ${d === 1 ? 'zi' : 'zile'} împreună${next ? ` · următoarea aniversare: <b>${next === 365 ? 'un an' : next === 730 ? 'doi ani' : next + (next >= 20 ? ' de zile' : ' zile')}</b>, pe ${nextDate}` : ''}</p>
    ${show.length ? `<ul class="mems">${show.map(li).join('')}</ul>${ms.length > 8 ? '<div class="btns jbtn"><button class="btn sm" id="memAll">Vezi tot</button></div>' : ''}`
      : `<p style="color:var(--tx3);font-size:.88rem;margin:0">Albumul se umple singur: momentul fiecărei zile din jurnal, nivelurile relației, cadourile și aniversările.</p>`}`;
  $('#memAlbum').onclick = () => openAlbum(c);
  const all = $('#memAll'); if(all) all.onclick = () => openSheet(`<h4>💝 Amintiri cu ${esc(c.name)}</h4><div class="pad"><ul class="mems">${ms.map(li).join('')}</ul></div>`);
}

/* ───────── 🎁 cadouri ───────── */
const GIFTS = [['☕', 'o cafea'], ['🌹', 'trandafiri'], ['🍫', 'ciocolată'], ['📚', 'o carte'], ['🎬', 'bilete la film'], ['🍕', 'o pizza'], ['🧸', 'un ursuleț de pluș'], ['💐', 'un buchet de flori'], ['🎧', 'căști noi'], ['🍰', 'o prăjitură'], ['🌙', 'o seară în oraș'], ['✍️', 'altceva…']];
function giftSheet(){
  if(busy && live && live.ch === chat){ toast('Așteaptă răspunsul.'); return; }
  let pick = null;
  openSheet(`<h4>🎁 Un cadou pentru ${esc(cur.name)}</h4><div class="gifts">${GIFTS.map((g, k) => `<button data-g="${k}"><i>${g[0]}</i>${esc(g[1])}</button>`).join('')}</div>
    <div class="pad"><input id="gCustom" placeholder="Ce cadou? (ex: un colier, o plantă)" hidden maxlength="60"><textarea id="gNote" rows="2" placeholder="Un bilețel (opțional)" style="margin-top:8px"></textarea>
    <div class="btns" style="margin-top:10px"><button class="btn" data-close>Renunță</button><button class="btn pri" id="gSend" disabled>Trimite</button></div></div>`);
  $$('.gifts [data-g]').forEach(b => b.onclick = () => { $$('.gifts button').forEach(x => x.classList.remove('on')); b.classList.add('on'); pick = GIFTS[+b.dataset.g]; $('#gCustom').hidden = pick[0] !== '✍️'; $('#gSend').disabled = false; if(pick[0] === '✍️') $('#gCustom').focus(); });
  $('#gSend').onclick = async () => {
    if(!pick) return;
    const n = pick[0] === '✍️' ? $('#gCustom').value.trim() : pick[1]; if(!n){ toast('Scrie ce cadou.'); return; }
    if(busy){ toast('Așteaptă să termine răspunsul.'); return; }
    const e = pick[0] === '✍️' ? '🎁' : pick[0], note = $('#gNote').value.trim(), c = cur;
    closeSheet();
    const um = {id:uid(), role:'user', text:note, gift:{e, n}, ts:Date.now()};
    chat.msgs.push(um);
    c.gifts = (c.gifts || []).concat({e, n, ts:Date.now()}).slice(-30); giftClassify(c, c.gifts[c.gifts.length - 1]);
    addMoment(c, `${e} I-ai dăruit ${n}`, 'gift');
    fxBurst(e, 12);
    await saveChat(); renderMsgs(true);
    relBump(c, 5);
    await reply();
  };
}

/* ───────── 📱 statusuri (Noutăți) ───────── */
let feedCache = [], feedBusy = false; const feedTried = {};
async function loadFeed(){ feedCache = (await DB.get('feed')) || []; }
function saveFeed(){ feedCache = feedCache.filter(p => Date.now() - p.ts < 7 * 864e5 || p.keep).slice(0, 80); return DB.set('feed', feedCache).catch(() => {}); }
function feedDot(){ const b = $('#nav [data-tab="feed"]'); if(!b) return; const n = feedCache.some(p => !p.seen && charById(p.cid)); let d = b.querySelector('.ndot'); if(n && !d){ d = document.createElement('i'); d.className = 'ndot'; b.appendChild(d); } else if(!n && d) d.remove(); }
function renderFeed(){
  const box = $('#homeFeed');
  if(S.feed === 'off'){ box.innerHTML = `<div class="empty">Statusurile sunt oprite.<br><button class="btn sm" style="margin-top:12px" id="feedOnBtn">Pornește-le din Setări</button></div>`; $('#feedOnBtn').onclick = () => { openSettings(); openSetPanel('chat'); }; return; }
  const posts = feedCache.filter(p => charById(p.cid)).sort((a, b) => b.ts - a.ts);
  box.innerHTML = storyRowHTML() + `<div class="feedtop"><span>Ce fac personajele tale</span><button class="btn sm" id="feedRef">${feedBusy ? '<span class="spin"></span>' : '↻ Actualizează'}</button></div>`
    + (posts.length ? posts.map(p => { const c = charById(p.cid); return `<div class="post${p.seen ? '' : ' new'}" data-p="${p.id}">
      <div class="ph2">${avatarHTML(c)}<div><b>${esc(c.name)}</b><small>${p.story ? '📸 story · ' : ''}${when(p.ts)}${p.life ? ' · ' + esc(p.life) : ''}</small></div></div>
      <p>${esc(p.text)}</p>${p.img ? `<img class="pimg" data-k="${esc(p.img)}" data-view="${esc(p.img)}" alt="">` : ''}
      ${cmHTML(p) ? `<div class="pcms">${cmHTML(p)}</div>` : ''}
      <div class="pact"><button class="${p.liked ? 'on' : ''}" data-like>${p.liked ? '❤️' : '🤍'} Îmi place</button><button data-rep>💬 Răspunde</button></div></div>`; }).join('')
      : `<div class="empty">${feedBusy ? 'Personajele scriu primele statusuri…' : 'Încă nimic. Apasă „Actualizează” ca personajele cu care ai vorbit să posteze ce fac.'}</div>`);
  hydrate(box); bindStoryRow(box);
  $('#feedRef').onclick = () => feedRefresh(true);
  box.onclick = async e => {
    const v = e.target.closest('[data-view]'); if(v){ viewImg(v.dataset.view, [v.dataset.view]); return; }
    const pe = e.target.closest('.post'); if(!pe) return;
    const p = feedCache.find(x => x.id === pe.dataset.p); if(!p) return;
    if(e.target.closest('[data-like]')){ p.liked = !p.liked; if(p.liked){ delete p.likeNoted; relBump(charById(p.cid), 1); } await saveFeed(); renderFeed(); return; }
    if(e.target.closest('[data-rep]')){
      const c = charById(p.cid); await openChat(c.id);
      replyTo = {id:'st-' + p.id, name:c.name + ' · status', text:('📱 ' + p.text).slice(0, 140)};
      $('#rbName').textContent = '↩ Răspunzi la statusul lui ' + c.name; $('#rbTxt').textContent = replyTo.text; $('#replyBar').hidden = false; $('#inp').focus();
    }
  };
  // le marcăm văzute după ce le-ai avut pe ecran
  setTimeout(() => { let ch = false; feedCache.forEach(p => { if(!p.seen){ p.seen = 1; ch = true; } }); if(ch){ saveFeed(); feedDot(); } }, 2500);
  if(!feedBusy) feedRefresh(false);
}
// cel mult o postare la ~8 ore de personaj, doar pentru personajele cu care ai vorbit în ultimele 14 zile (max 4 odată)
async function feedRefresh(manual){
  if(feedBusy || S.feed === 'off' || !aiReady()) return;
  const h = new Date().getHours();
  const due = chars.filter(c => c.lastAt && Date.now() - c.lastAt < 14 * 864e5 && (manual || !(Date.now() - (feedTried[c.id] || 0) < 36e5)) && !laterHas('status', c.id))
    .filter(c => { const last = feedCache.filter(p => p.cid === c.id).sort((a, b) => b.ts - a.ts)[0]; return !last || Date.now() - last.ts > (manual ? 3 : 8) * 36e5; })
    .filter(c => { const lf = lifeNow(c); return manual || !(lf && lf.b === 2) && h >= 7; })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 4);
  if(!due.length){ if(manual) toast('Nimic nou încă. Personajele postează cam de două ori pe zi.'); return; }
  feedBusy = true; if(homeTab === 'feed' && !$('#vHome').hidden) renderFeed();
  try{ for(const c of due){ feedTried[c.id] = Date.now(); try{ await makePost(c, !manual); }catch(e){ if(manual) toast(c.name + ': ' + e.message, 3500); } if(homeTab === 'feed' && !$('#vHome').hidden) renderFeed(); } }
  finally { feedBusy = false; if(homeTab === 'feed' && !$('#vHome').hidden) renderFeed(); feedDot(); }
}
async function makePost(c, bg){
  const u = S.userName.trim() || 'el', lf = lifeNow(c);
  const ch = await loadChat(c, c.thread || 'main');
  const recent = ch.msgs.filter(m => m.text && !m.err).slice(-6).map(m => (m.role === 'user' ? u : c.name) + ': ' + plain(stripMood(m.text)).slice(0, 200)).join('\n');
  const prev = feedCache.filter(p => p.cid === c.id).slice(-3).map(p => '- ' + p.text).join('\n');
  const wantPic = S.feed === 'poze' && canAutoPhoto(c);
  const SYS = `Ești ${c.name}. ${c.persona ? c.persona.slice(0, 900) : ''}`, TXT =
`${nowNote()}${charTimeNote(c)} ${lf ? '(După programul tău, acum: ' + lf.w + '.)' : ''}${(() => { const ev = (c.evOff ? [] : (c.ev || [])).find(e => e.d === dayKey(Date.now())) || evPast(c).find(e => daysSince(new Date(e.d + 'T12:00').getTime()) === 1); return ev ? ` (${evDayLabel(ev.d)} ai: ${ev.t}${ev.h ? ', la ' + ev.h : ''}; poți posta despre asta, dacă se potrivește cu ora)` : ''; })()}${charBdayToday(c) ? ' (Azi e ziua ta de naștere.)' : ''}
Postezi un status scurt pe rețeaua ta, ca pe Instagram sau WhatsApp: ce faci acum, ce gândești sau ce ți s-a întâmplat azi. 1-3 propoziții, la persoana I, natural, în română, poate cu un emoji. Nu te adresa direct lui ${u} și nu pomeni conversațiile voastre explicit (poate doar o aluzie subtilă).${prev ? '\nStatusurile tale recente (nu te repeta):\n' + prev : ''}${recent ? '\nCa să știi ce mai e nou, ultimele mesaje cu ' + u + ':\n' + recent : ''}
Răspunde STRICT cu JSON: {"text":"statusul"${wantPic ? ',"poza":"one English sentence: the photo attached to the status (framing, place, activity, outfit, light), no face description"' : ''}}`;
  const d = {wantPic, life:lf ? lf.w : ''};
  if(bg) return later('status', c.id, SYS, TXT, {max:350, tag:'statusuri'}, d);   // 8.19: din fundal, prin lot (−50%)
  return LATER.status(await stream(SYS, [{role:'user', text:TXT}], {max:350, cid:c.id, aux:true, tag:'statusuri'}), d, c.id);
}
LATER.status = async (out, d, cid) => {
  const c = charById(cid); if(!c) return;
  const wantPic = d.wantPic;
  const j = parseJSON(out);
  const text = faraLiniute(String(j.text || '').trim()).slice(0, 400);
  if(text.length < 5) throw new Error('statusul n-a ieșit');
  const p = {id:uid(), cid:c.id, ts:Date.now(), text, life:d.life || ''};
  if(wantPic && j.poza && capLeft() >= (neurPerPhoto() || 5000)){
    try{
      const shot = String(j.poza).trim().replace(/[.\s]+$/, '');
      let {blob:b} = await makeScenePhoto(c, shot, undefined, {tag:'statusuri'});
      try{ if(b.type === 'image/png') b = await toJpeg(b, 2048, .92); }catch(e){}
      p.img = await saveImg(b); p.scene = shot; addUsage(c.id, imgPrice(), 'img', null, 'statusuri');
    }catch(e){ /* statusul pleacă și fără poză */ }
  }
  feedCache.push(p); await saveFeed();
  socialComments(p);
  if(homeTab === 'feed' && !$('#vHome').hidden) renderFeed(); feedDot();
};
/* ───────── 🎂 8.8: viața personajelor (agenda, zile de naștere) ───────── */
const LUNI = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const mdOf = s => { const m = String(s || '').match(/(\d{1,2})-(\d{1,2})$/); return m ? m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : ''; };
const mdLabel = md => { const [m, d] = (md || '').split('-').map(Number); return m && d ? d + ' ' + LUNI[m - 1] : ''; };
const todayMd = () => dayKey(Date.now()).slice(5);
const userBdayToday = () => !!S.userBday && mdOf(S.userBday) === todayMd();
const charBdayToday = c => !!(c && c.bday) && c.bday === todayMd();
const evDayLabel = d => { const x = daysSince(new Date(d + 'T12:00').getTime()); return x === 0 ? 'azi' : x === 1 ? 'ieri' : x === -1 ? 'mâine' : x === -2 ? 'poimâine' : new Date(d + 'T12:00').toLocaleDateString('ro-RO', {weekday:'long', day:'numeric', month:'long'}); };
const evFuture = c => (c.ev || []).filter(e => e.d >= dayKey(Date.now())).sort((a, b) => (a.d + (a.h || '')) < (b.d + (b.h || '')) ? -1 : 1);
const evPast = c => (c.ev || []).filter(e => e.d < dayKey(Date.now())).sort((a, b) => a.d < b.d ? 1 : -1);
function agendaFor(c){   // pentru promptul de sistem: date absolute, ca să nu se strice cache-ul la fiecare mesaj
  if(!c || c.evOff) return '';
  const fmtE = e => `- ${new Date(e.d + 'T12:00').toLocaleDateString('ro-RO', {weekday:'long', day:'numeric', month:'long'})}${e.h ? ', ' + e.h : ''}: ${e.t}`;
  const past = evPast(c).filter(e => daysSince(new Date(e.d + 'T12:00').getTime()) <= 10).slice(0, 4).reverse(), fut = evFuture(c).slice(0, 6);
  if(!c.bday && !past.length && !fut.length) return '';
  return `## Viața ta în zilele astea\n${c.bday ? 'Ziua ta de naștere: ' + mdLabel(c.bday) + '.\n' : ''}${past.length ? 'Ce ai avut deja:\n' + past.map(fmtE).join('\n') + '\n' : ''}${fut.length ? 'Ce urmează:\n' + fut.map(fmtE).join('\n') + '\n' : ''}Sunt lucruri reale din viața ta: le pomenești firesc, ca orice om (îți faci planuri, ai emoții înainte, povestești după, cu detalii concrete). Nu le schimba datele și nu le înșira pe toate.`;
}
async function genEvents(c, bg){
  c.evTried = Date.now();
  const today = dayKey(Date.now()), zile = [];
  for(let i = 1; i <= 14; i++){ const d = new Date(Date.now() + i * 864e5); zile.push(dayKey(d.getTime()) + ' (' + d.toLocaleDateString('ro-RO', {weekday:'long'}) + ')'); }
  const fut = evFuture(c).map(e => '- ' + e.d + ': ' + e.t).join('\n'), past = evPast(c).slice(0, 5).map(e => '- ' + e.d + ': ' + e.t).join('\n');
  const rut = c.life && !c.lifeOff ? (c.life.wk || []).map(x => x.f + '-' + x.t + ' ' + x.w).join('; ') : '';
  const SYS = 'Construiești viața unui personaj de poveste, realist și coerent. Răspunzi DOAR cu JSON valid.', TXT =
`Personaj: ${c.name}. ${c.tag ? 'Pe scurt: ' + c.tag + '. ' : ''}${c.city ? 'Locuiește în ' + c.city + '. ' : ''}${c.persona ? 'Descriere: ' + c.persona.slice(0, 1400) : ''}
${rut ? 'Programul obișnuit: ' + rut + '\n' : ''}Azi e ${today}. Zilele următoare: ${zile.join(', ')}.
${fut ? 'Are deja în plan (nu repeta):\n' + fut + '\n' : ''}${past ? 'A avut recent (poți continua firesc, cu urmări):\n' + past + '\n' : ''}
Scrie 3-5 lucruri care i se vor întâmpla în următoarele 14 zile, în română, cum ar avea un om real: mai ales lucruri mărunte (o cină cu o prietenă numită, dentistul, un concert, o ședință importantă, cumpărături pentru ceva anume, vizita părinților), cel mult unul mai mare (o excursie de weekend, un interviu, o petrecere). Potrivite cu cine e, cu jobul și orașul lui. Fiecare: ziua (AAAA-LL-ZZ, din lista de mai sus), ora (HH:MM sau gol), ce (5-14 cuvinte, concret, cu nume de oameni și locuri inventate, fără numele personajului).
${c.bday ? '' : 'Alege și ziua lui de naștere (LL-ZZ), potrivită cu descrierea dacă o pomenește, altfel una plauzibilă.\n'}Fără ghilimele în texte. JSON: {${c.bday ? '' : '"zi_nastere":"LL-ZZ",'}"evenimente":[{"zi":"AAAA-LL-ZZ","ora":"19:30","ce":"…","mare":false}]}`;
  const ok = zile.map(z => z.slice(0, 10));
  if(bg) return later('planuri', c.id, SYS, TXT, {max:900, tag:'fundal'}, {ok});   // 8.19: din fundal, prin lot
  return LATER.planuri(await stream(SYS, [{role:'user', text:TXT}], {max:900, cid:c.id, aux:true, tag:'fundal'}), {ok}, c.id);
}
LATER.planuri = async (out, d, cid) => {
  const c = charById(cid); if(!c) return;
  const j = parseJSON(out);
  if(!c.bday && /^\d{2}-\d{2}$/.test(String(j.zi_nastere || ''))) c.bday = j.zi_nastere;
  const ok = new Set(d.ok);
  const add = (Array.isArray(j.evenimente) ? j.evenimente : []).map(e => ({id:uid(), d:String(e.zi || '').slice(0, 10), h:/^\d{2}:\d{2}$/.test(String(e.ora || '')) ? e.ora : '', t:faraLiniute(String(e.ce || '').trim()).slice(0, 120), big:e.mare ? 1 : 0}))
    .filter(e => ok.has(e.d) && e.t.length > 4);
  if(!add.length) throw new Error('Planurile n-au ieșit. Mai încearcă.');
  c.ev = (c.ev || []).filter(e => daysSince(new Date(e.d + 'T12:00').getTime()) <= 30).concat(add).slice(-40);
  await saveChars();
}
let lifeSweepBusy = false;
async function lifeSweep(){
  if(lifeSweepBusy || !aiReady()) return;
  lifeSweepBusy = true;
  try{
    const due = chars.filter(c => !c.evOff && c.lastAt && Date.now() - c.lastAt < 14 * 864e5 && evFuture(c).filter(e => daysSince(new Date(e.d + 'T12:00').getTime()) < -1).length < 2 && Date.now() - (c.evTried || 0) > 20 * 36e5)
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 2);
    for(const c of due){ try{ await genEvents(c, true); }catch(e){} }
    if(S.social !== 'off') for(const c of chars.filter(x => x.lastAt && Date.now() - x.lastAt < 14 * 864e5).slice(0, 3)){ try{ await ensureCircle(c); }catch(e){} }
  } finally { lifeSweepBusy = false; }
}
// notele din mesajul tău, o singură dată fiecare (vezi turnExtras)
function lifeExtras(c, opts){
  if(!c) return '';
  let x = ''; const u = S.userName.trim() || 'el', yr = new Date().getFullYear(), today = dayKey(Date.now());
  if(userBdayToday() && c.ubd !== yr){ c.ubd = yr; x += ` (azi e ziua de naștere a lui ${u}! Dacă nu i-ai urat deja azi, începe cu o urare în felul tău, caldă și personală, nu de felicitare tipărită)`; }
  if(charBdayToday(c) && c.obd !== yr){ c.obd = yr; x += ` (azi e ziua TA de naștere; poți pomeni firesc ce faci de ziua ta sau cum te simți)`; }
  if(!c.evOff){
    const fresh = !opts.cont;
    const now = (c.ev || []).find(e => e.d === today && !e.pre);
    if(now && fresh){ now.pre = 1; x += ` (azi ai în plan: ${now.t}${now.h ? ', la ' + now.h : ''}; dacă se potrivește, pomenește-l firesc: emoții, pregătiri, sau cum a fost, dacă ora a trecut)`; }
    else {
      const was = evPast(c).find(e => !e.told && daysSince(new Date(e.d + 'T12:00').getTime()) <= 3);
      if(was && fresh){ was.told = 1; x += ` (${evDayLabel(was.d)} ai avut: ${was.t}. Încă nu i-ai povestit lui ${u}; când e momentul potrivit, povestește-i scurt cum a fost, cu 1-2 detalii concrete, coerente cu viața ta)`; }
    }
  }
  if(x) saveChars();
  return x;
}
async function bdayCheck(c){
  if(!c || busy) return false;
  const yr = new Date().getFullYear();
  if(charBdayToday(c) && c.bdShown !== yr){ c.bdShown = yr; await saveChars(); addMoment(c, `🎂 ${c.name} și-a serbat ziua`, 'ann'); toast(`🎂 ${c.name} își serbează azi ziua! Poate un cadou? 🎁`, 4500); fxConfetti(); }
  const lastM = chat.msgs[chat.msgs.length - 1];
  if(!userBdayToday() || c.ubd === yr || !chat.msgs.some(m => m.role === 'user') || (lastM && lastM.role === 'user') || S.pro !== 'on' || !aiReady()) return false;   // dacă tocmai i-ai scris, urarea vine în răspuns (lifeExtras)
  c.ubd = yr; await saveChars(); fxConfetti();
  const u = S.userName.trim() || 'utilizatorul';
  reply(null, {pro:true, note:`(Notă de regie, nu o menționa ca atare: azi e ziua de naștere a lui ${u}. Scrie-i tu primul și urează-i în felul tău, cald și personal, poate cu ceva ce știi despre el.)`});
  return true;
}
function drawAgenda(c){
  const box = $('#pfAgenda'); if(!box) return;
  const fut = evFuture(c), past = evPast(c).slice(0, 4);
  const li = (e, p) => `<li class="evi${e.big ? ' big' : ''}${p ? ' past' : ''}"><span><b>${esc(evDayLabel(e.d))}${e.h ? ' · ' + e.h : ''}</b>${esc(e.t)}</span><button class="x" data-evdel="${e.id}" aria-label="Șterge">✕</button></li>`;
  box.innerHTML = `<p class="bdline">🎂 Ziua de naștere: <b>${c.bday ? mdLabel(c.bday) : 'nestabilită'}</b> <button class="btn sm" id="evBday">${c.bday ? 'Schimbă' : 'Alege'}</button></p>
    ${c.evOff ? '<p class="lifenow" style="color:var(--tx3)">⏸ Agenda e oprită: nu-și mai face planuri noi.</p>' : ''}
    ${fut.length ? `<div class="evh">Ce urmează</div><ul class="evl">${fut.map(e => li(e)).join('')}</ul>` : `<p style="color:var(--tx3);font-size:.88rem;margin:6px 0">${esc(c.name)} n-are încă planuri. Cu agenda, are o viață care merge mai departe: îți spune ce urmează, are emoții înainte și îți povestește după.</p>`}
    ${past.length ? `<div class="evh">Ce a fost</div><ul class="evl">${past.map(e => li(e, 1)).join('')}</ul>` : ''}
    <div class="btns jbtn"><button class="btn sm" id="evAdd">＋ Adaugă</button><button class="btn sm" id="evGen">✨ Planuri noi</button><button class="btn sm" id="evOff">${c.evOff ? '▶ Pornește' : '⏸ Oprește'}</button></div>`;
  box.querySelectorAll('[data-evdel]').forEach(b => b.onclick = async () => { c.ev = (c.ev || []).filter(e => e.id !== b.dataset.evdel); await saveChars(); drawAgenda(c); });
  $('#evOff').onclick = async () => { c.evOff = !c.evOff; await saveChars(); drawAgenda(c); };
  $('#evGen').onclick = async () => { const b = $('#evGen'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Își face planuri…'; try{ await genEvents(c); }catch(e){ toast(e.message, 3500); } drawAgenda(c); };
  $('#evBday').onclick = () => {
    openSheet(`<h4>🎂 Ziua de naștere · ${esc(c.name)}</h4><div class="pad"><input type="date" id="evBd" value="${c.bday ? '2000-' + c.bday : ''}"><p class="hint">Anul nu contează. În ziua aceea primești o notă, iar personajul știe că e ziua lui.</p>
      <div class="btns" style="margin-top:10px"><button class="btn" data-close>Renunță</button><button class="btn pri" id="evBdOk">Salvează</button></div></div>`);
    $('#evBdOk').onclick = async () => { c.bday = mdOf($('#evBd').value); await saveChars(); closeSheet(); drawAgenda(c); };
  };
  $('#evAdd').onclick = () => {
    openSheet(`<h4>🗓️ Un plan pentru ${esc(c.name)}</h4><div class="pad"><label>Ce</label><input id="evT" maxlength="120" placeholder="ex. nunta verișoarei Ana, la Sinaia">
      <div class="cityrow" style="margin-top:8px"><input type="date" id="evD" value="${dayKey(Date.now() + 864e5)}"><input type="time" id="evH"></div>
      <p class="hint">Personajul îl ia ca pe un lucru din viața lui: îl pomenește înainte și îți povestește după.</p>
      <div class="btns" style="margin-top:10px"><button class="btn" data-close>Renunță</button><button class="btn pri" id="evOk">Adaugă</button></div></div>`);
    $('#evOk').onclick = async () => { const t = $('#evT').value.trim(), d = $('#evD').value; if(!t || !d){ toast('Scrie ce și alege ziua.'); return; } c.ev = (c.ev || []).concat({id:uid(), d, h:$('#evH').value || '', t:t.slice(0, 120), big:0}); await saveChars(); closeSheet(); drawAgenda(c); };
  };
}

/* ───────── 📸 8.8: stories (24 de ore) ───────── */
const storyLive = () => feedCache.filter(p => p.story && p.img && Date.now() - p.ts < 864e5 && charById(p.cid));
function storyRowHTML(){
  if(S.story === 'off') return '';
  const by = {}; for(const p of storyLive()) (by[p.cid] = by[p.cid] || []).push(p);
  const ids = Object.keys(by); if(!ids.length) return '';
  ids.sort((a, b) => (by[a].some(p => !p.sv) ? 0 : 1) - (by[b].some(p => !p.sv) ? 0 : 1) || Math.max(...by[b].map(p => p.ts)) - Math.max(...by[a].map(p => p.ts)));
  return `<div class="strow">${ids.map(id => { const c = charById(id), un = by[id].some(p => !p.sv);
    return `<button class="stc${un ? ' un' : ''}" data-story="${id}"><span class="str">${avatarHTML(c)}</span><small>${esc(c.name)}</small></button>`; }).join('')}</div>`;
}
function bindStoryRow(root){ root.querySelectorAll('[data-story]').forEach(b => b.onclick = e => { e.stopPropagation(); openStories(b.dataset.story); }); }
let stv = null;
function openStories(cid, custom){
  const all = custom || storyLive(), order = [...new Set(all.sort((a, b) => a.ts - b.ts).map(p => p.cid))];
  const un = order.filter(id => all.some(p => p.cid === id && !p.sv)), rest = order.filter(id => !un.includes(id));
  const q = custom ? [cid] : [cid, ...un.filter(id => id !== cid), ...rest.filter(id => id !== cid)];
  closeStories();
  const el = document.createElement('div'); el.id = 'storyV';
  el.innerHTML = `<div class="sbars"></div><div class="shead"></div><img class="simg" alt=""><div class="scap"></div><div class="stap l"></div><div class="stap r"></div>
    <div class="sfoot"><div class="sreact">${['❤️', '😂', '😮', '🔥'].map(e => `<button data-sr="${e}">${e}</button>`).join('')}</div><div class="sin"><input id="stInp" maxlength="500" autocomplete="off"><button id="stSend" aria-label="Trimite">➤</button></div></div>`;
  document.body.appendChild(el);
  stv = {el, q, ci:0, i:0, t0:0, el0:0, paused:false, raf:0, DUR:6000};
  const ps = () => (custom || storyLive()).filter(p => p.cid === stv.q[stv.ci]).sort((a, b) => a.ts - b.ts);
  const show = async () => {
    const list = ps(); if(!list.length) return next(1, true);
    const p = list[stv.i], c = charById(p.cid); p.sv = 1; p.seen = 1; saveFeed();
    el.querySelector('.sbars').innerHTML = list.map((_, k) => `<i><b style="width:${k < stv.i ? 100 : 0}%"></b></i>`).join('');
    el.querySelector('.shead').innerHTML = `${avatarHTML(c)}<span><b>${esc(c.name)}</b><small>${when(p.ts)}${p.life ? ' · ' + esc(p.life) : ''}</small></span><button class="x" data-sx aria-label="Închide">✕</button>`;
    el.querySelector('.scap').textContent = p.text || ''; el.querySelector('.scap').hidden = !p.text;
    let sc = el.querySelector('.scms'); if(!sc){ sc = document.createElement('div'); sc.className = 'scms'; el.appendChild(sc); }
    sc.innerHTML = cmHTML(p); hydrate(sc);
    $('#stInp').placeholder = 'Răspunde la story…';
    hydrate(el); const img = el.querySelector('.simg'); img.removeAttribute('src'); img.src = await imgUrl(p.img);
    stv.el0 = 0; stv.t0 = performance.now(); tick();
  };
  const tick = () => {
    cancelAnimationFrame(stv.raf);
    stv.raf = requestAnimationFrame(function f(now){
      if(!stv) return;
      if(stv.paused){ stv.t0 = now - stv.el0; stv.raf = requestAnimationFrame(f); return; }
      stv.el0 = now - stv.t0; const b = el.querySelectorAll('.sbars b')[stv.i]; if(b) b.style.width = Math.min(100, stv.el0 / stv.DUR * 100) + '%';
      if(stv.el0 >= stv.DUR) return next(1); stv.raf = requestAnimationFrame(f);
    });
  };
  const next = (d, skipChar) => {
    const list = ps();
    if(!skipChar && stv.i + d >= 0 && stv.i + d < list.length){ stv.i += d; return show(); }
    if(d < 0 && !skipChar && stv.i === 0 && stv.ci === 0){ stv.t0 = performance.now(); stv.el0 = 0; return; }
    stv.ci += d < 0 ? -1 : 1;
    if(stv.ci < 0 || stv.ci >= stv.q.length) return closeStories();
    stv.i = d < 0 ? Math.max(0, ps().length - 1) : 0; show();
  };
  let hold = 0, h0 = 0;
  el.querySelector('.stap.l').onclick = () => { if(Date.now() - h0 < 300) next(-1); };
  el.querySelector('.stap.r').onclick = () => { if(Date.now() - h0 < 300) next(1); };
  el.addEventListener('pointerdown', e => { if(e.target.closest('.sfoot,.shead')) return; h0 = Date.now(); hold = setTimeout(() => stv && (stv.paused = true), 220); });
  el.addEventListener('pointerup', () => { clearTimeout(hold); if(stv && stv.paused && document.activeElement !== $('#stInp')) setTimeout(() => stv && (stv.paused = false), 0); });
  let y0 = null; el.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, {passive:true});
  el.addEventListener('touchend', e => { if(y0 !== null && e.changedTouches[0].clientY - y0 > 90 && !e.target.closest('.sfoot')) closeStories(); y0 = null; });
  el.addEventListener('click', e => { if(e.target.closest('[data-sx]')) closeStories(); });
  $('#stInp').onfocus = () => { stv.paused = true; }; $('#stInp').onblur = () => { setTimeout(() => { if(stv) stv.paused = false; }, 150); };
  const cur = () => ps()[stv.i];
  $('#stSend').onclick = () => { const t = $('#stInp').value.trim(); if(t) storyReply(cur(), t); };
  $('#stInp').onkeydown = e => { if(e.key === 'Enter'){ e.preventDefault(); $('#stSend').click(); } };
  el.querySelectorAll('[data-sr]').forEach(b => b.onclick = () => { fxBurst(b.dataset.sr, 10); const p = cur(); setTimeout(() => storyReply(p, b.dataset.sr), 450); });
  show();
}
function closeStories(){ if(!stv) return; cancelAnimationFrame(stv.raf); stv.el.remove(); stv = null; feedDot(); if(!$('#vHome').hidden) renderHome(); const ab = $('#pfAvBtn'); if(ab && !$('#vProf').hidden && !storyLive().some(x => profId === x.cid && !x.sv)) ab.classList.remove('un'); }
async function storyReply(p, text){
  if(!p) return;
  const c = charById(p.cid); closeStories(); if(!c) return;
  await openChat(c.id);
  replyTo = {id:'st-' + p.id, name:c.name + ' · story', text:('📸 ' + (p.text || 'Story')).slice(0, 140), img:p.img, ctx:p.scene ? `(story-ul tău de ${when(p.ts)}; în poză: ${p.scene})` : '(story-ul tău)'};
  $('#rbName').textContent = '↩ Răspunzi la story · ' + c.name; $('#rbTxt').textContent = replyTo.text; $('#replyBar').hidden = false;
  $('#inp').value = text; autoSize(); updateComposer();
  if(!busy) send(); else toast('Mesajul te așteaptă în căsuță; trimite-l după ce termină ' + c.name + '.', 3500);
}
let storyBusy = false; const storyTried = {};
async function storySweep(manual){
  if(storyBusy || S.story === 'off' || !aiReady() || S.imgProv === 'none') return;
  const due = chars.filter(c => { const h = charNow(c).getHours(); return manual || (h >= 9 && h < 23); }).filter(c => canAutoPhoto(c) && c.lastAt && Date.now() - c.lastAt < 7 * 864e5 && Date.now() - (storyTried[c.id] || 0) > 3 * 36e5)
    .filter(c => !feedCache.some(p => p.cid === c.id && p.story && Date.now() - p.ts < 20 * 36e5))
    .filter(c => { const st = feedCache.filter(p => p.cid === c.id && p.story).sort((a, b) => b.ts - a.ts).slice(0, 2); return !(st.length === 2 && st.every(p => !p.sv)); })   // 8.17: n-ai văzut ultimele 2? nu mai face altele până nu le vezi
    .filter(c => { const lf = lifeNow(c); return !(lf && lf.b === 2); })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 3);
  if(!due.length){ if(manual) toast(chars.some(canAutoPhoto) ? 'Fiecare personaj postează cel mult un story pe zi.' : 'Stories au nevoie de poze: pornește „trimite poze” la personaj.'); return; }
  if(capLeft() < (neurPerPhoto() || 5000)) return;
  storyBusy = true;
  const c = due[0]; storyTried[c.id] = Date.now();
  try{ await makeStory(c); if(!$('#vHome').hidden) renderHome(); feedDot(); }catch(e){ if(manual) toast(c.name + ': ' + e.message, 3500); }
  finally { storyBusy = false; }
}
async function makeStory(c){
  const u = S.userName.trim() || 'el', lf = lifeNow(c), today = dayKey(Date.now());
  const ev = (c.ev || []).find(e => e.d === today) || evPast(c).find(e => daysSince(new Date(e.d + 'T12:00').getTime()) === 1);
  let wx = null; try{ wx = await weatherOf(c); }catch(e){}
  const out = await stream(`Ești ${c.name}. ${c.persona ? c.persona.slice(0, 900) : ''}`, [{role:'user', text:
`${nowNote()}${charTimeNote(c)} ${lf ? '(După programul tău, acum: ' + lf.w + '.)' : ''}${ev ? ` (${evDayLabel(ev.d)} ai: ${ev.t}${ev.h ? ', la ' + ev.h : ''}.)` : ''}${wx ? ' (Vremea la tine: ' + wxLine(wx) + '.)' : ''}${charBdayToday(c) ? ' (Azi e ziua ta de naștere.)' : ''}
Postezi un story: o poză făcută chiar acum, din ce faci sau unde ești, ca pe Instagram. Alege un moment fotogenic și firesc din ziua ta${ev ? ' (poate legat de ce ai azi, dacă se potrivește cu ora)' : ''}. Textul de pe story e foarte scurt: 0-8 cuvinte, poate un emoji, în română, la persoana I, nu te adresezi lui ${u}.
Răspunde STRICT cu JSON: {"text":"textul de pe story (poate fi gol)","poza":"one English sentence: framing (selfie / mirror selfie / photo taken by a friend / scenery with you in it), exact place and what is around, your pose and what your hands do, outfit, light matching the time and weather; no face description"}`}], {max:300, cid:c.id, aux:true, tag:'stories'});
  const j = parseJSON(out), shot = giftDetail(c, String(j.poza || '').trim().replace(/[.\s]+$/, ''), null);
  if(shot.length < 10) throw new Error('story-ul n-a ieșit');
  let {blob:b} = await makeScenePhoto(c, shot, undefined, {tag:'stories'});
  try{ if(b.type === 'image/png') b = await toJpeg(b, 2048, .92); }catch(e){}
  const p = {id:uid(), cid:c.id, ts:Date.now(), text:faraLiniute(String(j.text || '').trim()).slice(0, 80), life:lf ? lf.w : '', img:await saveImg(b), scene:shot, story:1};
  addUsage(c.id, imgPrice(), 'img', null, 'stories');
  feedCache.push(p); await saveFeed();
  socialComments(p);
}
/* ───────── 📖 8.10: albumul vostru (cronologie ca un scrapbook) ───────── */
let albumEl = null;
async function openAlbum(c){
  if(!c) return;
  const chats = await allChats(c), days = {};
  const add = (day, it) => { (days[day] = days[day] || []).push(it); };
  const allM = chats.flatMap(ch => ch.msgs.filter(m => !m.err && !m.pending && m.ts));
  const first = allM.length ? Math.min(...allM.map(m => m.ts)) : (c.created || Date.now());
  const fm = allM.filter(m => m.text).sort((a, b) => a.ts - b.ts)[0];
  add(dayKey(first), {k:'start', ts:first, t:'Prima voastră conversație', q:fm ? plain(stripMood(fm.text)).slice(0, 120) : ''});
  for(const m of allM) if(m.img && m.role === 'ai') add(dayKey(m.ts), {k:'pic', ts:m.ts, img:m.img, loc:whereIn(m.where)});
  for(const p of feedCache.filter(p => p.cid === c.id)) add(dayKey(p.ts), p.img ? {k:'pic', ts:p.ts, img:p.img, loc:p.story ? '📸 story' : '📱 status', cap:p.text} : {k:'post', ts:p.ts, t:p.text});
  for(const mo of c.moments || []) add(mo.day, {k:mo.kind || 'moment', ts:new Date(mo.day + 'T12:00').getTime(), t:mo.t});
  for(const j of c.journal || []) add(j.day, {k:'jrn', ts:new Date(j.day + 'T20:00').getTime(), t:j.text});
  for(const g of c.gifts || []) if(!(c.moments || []).some(mo => mo.kind === 'gift' && mo.day === dayKey(g.ts))) add(dayKey(g.ts), {k:'gift', ts:g.ts, t:`${g.e} I-ai dăruit ${g.n}`});
  for(const e of evPast(c)) add(e.d, {k:'ev', ts:new Date(e.d + 'T12:00').getTime(), t:`🗓️ ${c.name}: ${e.t}`});
  const keys = Object.keys(days).sort((a, b) => a < b ? 1 : -1);
  const picsN = keys.reduce((n, d) => n + days[d].filter(x => x.k === 'pic').length, 0), momN = (c.moments || []).length, dz = daysSince(first);
  const rot = s => ((s.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) % 7) - 3) * .9;
  let html = '', lastMonth = '';
  for(const d of keys){
    const mo = new Date(d + 'T12:00').toLocaleDateString('ro-RO', {month:'long', year:'numeric'});
    if(mo !== lastMonth){ html += `<div class="almon">${esc(mo)}</div>`; lastMonth = mo; }
    const it = days[d].sort((a, b) => a.ts - b.ts), pics = it.filter(x => x.k === 'pic'), rest = it.filter(x => x.k !== 'pic');
    html += `<div class="alday"><div class="aldate"><b>${new Date(d + 'T12:00').getDate()}</b><small>${new Date(d + 'T12:00').toLocaleDateString('ro-RO', {weekday:'short'})}</small></div><div class="albody">`;
    for(const x of rest){
      if(x.k === 'start') html += `<div class="alnote start"><b>💫 ${esc(x.t)}</b>${x.q ? `<q>${esc(x.q)}</q>` : ''}</div>`;
      else if(x.k === 'jrn') html += `<div class="alnote jrn"><b>📔 Din jurnalul lui ${esc(c.name)}</b><p>${esc(x.t.slice(0, 220))}${x.t.length > 220 ? '…' : ''}</p></div>`;
      else if(x.k === 'post') html += `<div class="alnote post">📱 ${esc(x.t)}</div>`;
      else html += `<div class="alnote ${esc(x.k)}">${esc(x.t)}</div>`;
    }
    if(pics.length) html += `<div class="alpics n${Math.min(pics.length, 4)}">${pics.slice(0, 6).map(x => `<figure style="--r:${rot(x.img)}deg" data-view="${esc(x.img)}"><img data-k="${esc(x.img)}" alt="" loading="lazy">${x.loc || x.cap ? `<figcaption>${esc(x.cap || x.loc)}</figcaption>` : ''}</figure>`).join('')}${pics.length > 6 ? `<span class="almore">+${pics.length - 6}</span>` : ''}</div>`;
    html += `</div></div>`;
  }
  closeAlbum();
  albumEl = document.createElement('div'); albumEl.className = 'albumv';
  albumEl.innerHTML = `<header><button class="ib" data-alx aria-label="Închide">✕</button><div><b>📖 Albumul vostru</b><small>${esc(c.name)} · ${dz} ${dz === 1 ? 'zi' : 'zile'} împreună · ${picsN} ${picsN === 1 ? 'poză' : 'poze'} · ${momN} ${momN === 1 ? 'moment' : 'momente'}</small></div></header>
    <div class="alscroll"><div class="alcover">${c.photo ? `<img data-k="${esc(c.photo)}" alt="">` : ''}<span><b>${esc(S.userName.trim() || 'Tu')} & ${esc(c.name)}</b><small>din ${new Date(first).toLocaleDateString('ro-RO', {day:'numeric', month:'long', year:'numeric'})}</small></span></div>${html}<div class="alend">— va urma —</div></div>`;
  document.body.appendChild(albumEl); hydrate(albumEl);
  const allPics = [...albumEl.querySelectorAll('[data-view]')].map(x => x.dataset.view);
  albumEl.onclick = e => { if(e.target.closest('[data-alx]')){ closeAlbum(); return; } const v = e.target.closest('[data-view]'); if(v) viewImg(v.dataset.view, allPics); };
}
function closeAlbum(){ if(!albumEl) return; const a = albumEl; albumEl = null; a.classList.add('out'); setTimeout(() => a.remove(), 250); }
/* ───────── 👯 8.10: personajele se cunosc între ele ───────── */
const pairKey = (a, b) => [a, b].sort().join('|');
const relBetween = (a, b) => (S.socRel || {})[pairKey(a.id, b.id)] || '';
function circleOf(c){
  if(S.social === 'off' || !c) return [];
  return chars.filter(o => o.id !== c.id && relBetween(c, o)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 6);
}
async function ensureCircle(c){
  if(S.social === 'off' || !aiReady()) return;
  const others = chars.filter(o => o.id !== c.id && o.lastAt && Date.now() - o.lastAt < 30 * 864e5).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 6);
  const miss = others.filter(o => !relBetween(c, o)); if(!miss.length) return;
  if(Date.now() - (c.socTried || 0) < 20 * 36e5) return;
  c.socTried = Date.now();
  const d = o => `${o.name}${o.tag ? ' (' + o.tag + ')' : ''}${o.city ? ', locuiește în ' + o.city : ''}`;
  await later('cerc', c.id, 'Construiești legăturile dintre personajele unei povești, realist. Răspunzi DOAR cu JSON valid.',
`Personajul principal: ${d(c)}.${c.persona ? ' Pe scurt: ' + c.persona.slice(0, 400) : ''}
Alte personaje: ${miss.map(d).join('; ')}.
Pentru fiecare dintre ele, inventează cum se cunosc cu ${c.name}: 2-7 cuvinte, la plural, valabil în ambele sensuri (ex. „prietene din liceu”, „vecini de bloc”, „s-au cunoscut online, pe un grup de fotografie”, „foste colege de serviciu”). Plauzibil cu orașele lor (dacă sunt în țări diferite, s-au cunoscut online sau într-o călătorie). Fără relații romantice între ei. Fără ghilimele în texte.
JSON: {${miss.map(o => '"' + o.name.replace(/"/g, '') + '":"…"').join(',')}}`, {max:300, tag:'fundal'}, {miss:miss.map(o => o.id)});
}
LATER.cerc = async (out, d, cid) => {
  const c = charById(cid); if(!c) return;
  const miss = d.miss.map(charById).filter(Boolean);
  const j = parseJSON(out); S.socRel = S.socRel || {};
  for(const o of miss){ const t = faraLiniute(String(j[o.name] || '').trim()).slice(0, 80); if(t.length > 3) S.socRel[pairKey(c.id, o.id)] = t; }
  saveSettings();
}
function circleFor(c){   // pentru promptul de sistem (se schimbă rar, deci nu strică cache-ul)
  const list = circleOf(c); if(!list.length) return '';
  const u = S.userName.trim() || 'el';
  return `## Oameni pe care îi cunoști\n${list.map(o => `- ${o.name}${o.tag ? ' (' + o.tag + ')' : ''}: ${relBetween(c, o)}`).join('\n')}\n${u} îi cunoaște și el. Îi pomenești rar și firesc (o întâmplare cu ei, ceva ce au postat), nu în fiecare mesaj. Nu știi ce vorbește ${u} cu ei între patru ochi și nu inventa asta.`;
}
function socialExtras(c, opts){
  if(S.social === 'off' || opts.cont || Math.random() > .5) return '';
  const ids = new Set(circleOf(c).map(o => o.id)); if(!ids.size) return '';
  c.socSeen = c.socSeen || {};
  const p = feedCache.filter(x => ids.has(x.cid) && Date.now() - x.ts < 864e5 && !c.socSeen[x.id]).sort((a, b) => b.ts - a.ts)[0];
  if(!p) return '';
  c.socSeen[p.id] = 1; const ks = Object.keys(c.socSeen); if(ks.length > 60) delete c.socSeen[ks[0]]; saveChars();
  const o = charById(p.cid);
  return ` (${o.name}, cu care ești ${relBetween(c, o)}, a postat ${p.story ? 'un story' : 'un status'} ${when(p.ts)}: „${(p.text || (p.scene ? 'o poză' : '')).slice(0, 140)}”${p.scene ? ' (în poză: ' + p.scene.slice(0, 120) + ')' : ''}. Dacă se potrivește, îl poți pomeni scurt, în treacăt)`;
}
async function socialComments(p){
  if(S.social === 'off' || !aiReady()) return;
  const c = charById(p.cid); if(!c) return;
  const cand = circleOf(c).filter(o => o.lastAt && Date.now() - o.lastAt < 14 * 864e5).sort(() => Math.random() - .5).slice(0, 2);
  for(const [k, o] of cand.entries()){
    if(Math.random() > (k ? .4 : .75)) continue;
    try{
      if(!canBatch()) await sleep(1500 + Math.random() * 4000);
      await later('coment', o.id, `Ești ${o.name}. ${o.persona ? o.persona.slice(0, 600) : ''}`,
`${c.name} (${relBetween(c, o)}) a postat ${p.story ? 'un story' : 'un status'}: „${p.text || ''}”${p.scene ? ' (în poză: ' + p.scene.slice(0, 200) + ')' : ''}. Scrie un comentariu scurt sub postare, ca pe Instagram: 2-14 cuvinte, în română, în stilul tău, poate cu un emoji. Doar comentariul, fără ghilimele.`, {max:80, tag:'fundal'}, {pid:p.id});
    }catch(e){}
  }
}
LATER.coment = async (out, d, oid) => {
  const p = feedCache.find(x => x.id === d.pid); if(!p || !charById(oid)) return;
  const t = faraLiniute(plain(out)).replace(/^["„]|["”]$/g, '').trim().slice(0, 160);
  if(t.length < 2) return;
  p.cm = (p.cm || []).concat({cid:oid, t, ts:Date.now()}); await saveFeed();
  if(homeTab === 'feed' && !$('#vHome').hidden) renderFeed();
};
const cmHTML = p => (p.cm || []).filter(x => charById(x.cid)).map(x => `<div class="pcm">${avatarHTML(charById(x.cid))}<span><b>${esc(charById(x.cid).name)}</b> ${esc(x.t)}</span></div>`).join('');
/* ───────── 💞 8.15: relații care evoluează (încredere, apropiere, tensiune, momente-cheie) ───────── */
const ARC_E = {secret:'🤫', gluma:'😂', sprijin:'🤝', cearta:'⚡', impacare:'🕊️', incredere:'🔐', amintire:'💫', dor:'🌙', surpriza:'🎉'};
const bondOf = c => { const b0 = [25, 35, 50, 62, 75, 85][(relOf(c).lv || 1) - 1] || 30; return Object.assign({trust:b0, warm:b0, tension:0}, c.bond || {}); };   // pornește de la nivelul relației
const bondWord = (v, w) => v >= 80 ? w[3] : v >= 55 ? w[2] : v >= 30 ? w[1] : w[0];
function bondFor(c){   // pentru promptul de sistem
  const b = bondOf(c), u = S.userName.trim() || 'el';
  const arcs = (c.arcs || []).slice(-4).map(a => `- ${a.t} (${new Date(a.ts).toLocaleDateString('ro-RO', {day:'numeric', month:'long'})})`).join('\n');
  return `## Cum stați acum, tu și ${u}
(Dacă descrierea ta stabilește deja ce relație aveți, aceea are prioritate; asta arată doar nuanța de acum.)
Încredere: ${bondWord(b.trust, ['încă te ții în rezervă cu lucrurile personale', 'îi spui lucruri personale, dar nu chiar tot', 'ai încredere în el, îi spui și ce te frământă', 'ai încredere deplină; îi spui orice'])}. Apropiere: ${bondWord(b.warm, ['politicos, încă puțin distant', 'cald și prietenos', 'foarte cald, îți e drag', 'atașament profund, îți e dor de el când nu vorbiți'])}.${b.tension >= 45 && b.why ? `\nTensiune acum: ești puțin supărat(ă) sau rănit(ă) pentru că ${b.why}. Se simte discret (mai scurt, mai rece, o aluzie), fără scene. Dacă el își cere scuze sau lămurește, te înmoi treptat, nu brusc.` : ''}${arcs ? `\nMomente-cheie din relația voastră (le ții minte, le poți pomeni):\n${arcs}` : ''}`;
}
async function bondAnalyze(c, ch){
  if(!aiReady()) return;
  const u = S.userName.trim() || 'el';
  const last = ch.msgs.filter(m => (m.text || m.gift) && !m.err && !m.pending).slice(-12).map(m => (m.role === 'user' ? u : c.name) + ': ' + (m.gift ? `[i-a dăruit ${m.gift.n}] ` : '') + plain(stripMood(m.text || '')).slice(0, 280)).join('\n');
  if(!last) return;
  const b = bondOf(c), gap = (() => { const us = ch.msgs.filter(m => m.role === 'user' && m.ts); return us.length > 1 ? (us[us.length - 1].ts - us[us.length - 2].ts) / 864e5 : 0; })();
  try{
    const out = await stream('Analizezi dinamica unei relații dintr-o poveste. Răspunzi DOAR cu JSON valid.', [{role:'user', text:
`Personaj: ${c.name}. Relația cu ${u} acum: încredere ${b.trust}/100, apropiere ${b.warm}/100, tensiune ${b.tension}/100${b.why ? ' (motiv: ' + b.why + ')' : ''}.${gap >= 3 ? ` Înainte de ultimele mesaje, ${u} a lipsit ${Math.round(gap)} zile.` : ''}
Momente-cheie deja notate: ${(c.arcs || []).slice(-6).map(a => a.t).join('; ') || 'niciunul'}.
Ultimele mesaje:
${last}

Cum s-a schimbat relația din perspectiva lui ${c.name}, realist (schimbările sunt mici: de obicei -3..+4; mai mari doar la momente importante)?
- trust: încrederea (crește când el e sincer, ține minte lucruri, o susține; scade când o minte, o ignoră, își bate joc)
- warm: apropierea și afecțiunea
- tension: o mică supărare reală (el a fost nepoliticos, a uitat ceva important, a lipsit mult după o promisiune, a fost rece). Scade spre 0 când lucrurile se lămuresc. Nu inventa conflicte fără motiv în mesaje.
- moment: doar dacă s-a întâmplat ACUM ceva memorabil și nou: secret (și-au spus un secret), gluma (o glumă doar a lor), sprijin (el a susținut-o la greu sau invers), cearta (o neînțelegere), impacare, incredere (s-a deschis prima dată despre ceva), amintire (un moment frumos), dor, surpriza. Altfel null.
JSON: {"trust":0,"warm":0,"tension":0,"why":"motivul tensiunii, scurt, sau gol","moment":null sau {"tip":"secret","t":"propoziție scurtă, persoana a II-a plural, ex: V-ați spus primul secret: frica ei de înălțime."}}`}], {max:300, aux:true, cid:c.id});
    const j = parseJSON(out), cl = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+x || 0)));
    const nb = {trust:cl(b.trust + cl(j.trust, -15, 15), 0, 100), warm:cl(b.warm + cl(j.warm, -15, 15), 0, 100), tension:cl(b.tension + cl(j.tension, -40, 40), 0, 100)};
    nb.why = nb.tension >= 25 ? String(j.why || b.why || '').trim().slice(0, 140) : '';
    const wasT = b.tension >= 45;
    c.bond = nb;
    const mo = j.moment && j.moment.t && ARC_E[j.moment.tip] ? {tip:j.moment.tip, t:faraLiniute(String(j.moment.t)).trim().slice(0, 160), ts:Date.now()} : (wasT && nb.tension < 25 ? {tip:'impacare', t:'V-ați lămurit și v-ați împăcat.', ts:Date.now()} : null);
    if(mo && !(c.arcs || []).some(a => a.t === mo.t)){
      c.arcs = (c.arcs || []).concat(mo).slice(-40);
      addMoment(c, `${ARC_E[mo.tip]} ${mo.t}`, 'arc');
      toast(`${ARC_E[mo.tip]} Moment-cheie cu ${c.name}: ${mo.t}`, 4500);
    }
    await saveChars();
  }catch(e){}
}
// 8.17: un singur job de fundal la 6 răspunsuri: fapte noi + cum a evoluat relația, dintr-o singură citire a conversației (Haiku)
function applyBond(c, j){
  const b = bondOf(c), cl = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+x || 0)));
  const nb = {trust:cl(b.trust + cl(j.trust, -15, 15), 0, 100), warm:cl(b.warm + cl(j.warm, -15, 15), 0, 100), tension:cl(b.tension + cl(j.tension, -40, 40), 0, 100)};
  nb.why = nb.tension >= 25 ? String(j.why || b.why || '').trim().slice(0, 140) : '';
  const wasT = b.tension >= 45;
  c.bond = nb;
  const mo = j.moment && j.moment.t && ARC_E[j.moment.tip] ? {tip:j.moment.tip, t:faraLiniute(String(j.moment.t)).trim().slice(0, 160), ts:Date.now()} : (wasT && nb.tension < 25 ? {tip:'impacare', t:'V-ați lămurit și v-ați împăcat.', ts:Date.now()} : null);
  if(mo && !(c.arcs || []).some(a => a.t === mo.t)){
    c.arcs = (c.arcs || []).concat(mo).slice(-40);
    addMoment(c, `${ARC_E[mo.tip]} ${mo.t}`, 'arc');
    toast(`${ARC_E[mo.tip]} Moment-cheie cu ${c.name}: ${mo.t}`, 4500);
  }
}
async function bgAnalyze(c, ch){
  if(!aiReady()) return;
  const u = S.userName.trim() || 'utilizatorul';
  const last = ch.msgs.filter(m => (m.text || m.gift) && !m.err && !m.pending).slice(-14).map(m => (m.role === 'user' ? u : c.name) + ': ' + (m.gift ? `[i-a dăruit ${m.gift.n}] ` : '') + plain(stripMood(m.text || '')).slice(0, 300)).join('\n');
  if(!last) return;
  const b = bondOf(c), gap = (() => { const us = ch.msgs.filter(m => m.role === 'user' && m.ts); return us.length > 1 ? (us[us.length - 1].ts - us[us.length - 2].ts) / 864e5 : 0; })();
  const known = (c.facts || []).map(f => '- ' + f.t).join('\n') || '(nimic)';
  try{
    await later('analiza', c.id, 'Analizezi o conversație dintr-o poveste: ce informații noi apar și cum evoluează relația. Răspunzi DOAR cu JSON valid, în română.',
`Personaj: ${c.name}. Partenerul de discuție: ${u}.
Ce știe deja ${c.name} despre ${u}:
${known}
Relația acum (din perspectiva lui ${c.name}): încredere ${b.trust}/100, apropiere ${b.warm}/100, tensiune ${b.tension}/100${b.why ? ' (motiv: ' + b.why + ')' : ''}.${gap >= 3 ? ` Înainte de ultimele mesaje, ${u} a lipsit ${Math.round(gap)} zile.` : ''}
Momente-cheie deja notate: ${(c.arcs || []).slice(-6).map(a => a.t).join('; ') || 'niciunul'}.

Conversația recentă:
${last}

A) "fapte": lucruri NOI (nu cele știute), max 5, câte o propoziție de max 14 cuvinte, cu "tip":
- "fapt": ceva durabil despre ${u}, spus de ${u} însuși (nume, job, oraș, familie, gusturi, lucruri importante);
- "urmează": ceva ce urmează să i se întâmple lui ${u} și despre care merită întrebat mai târziu, cu momentul dacă l-a spus;
- "glumă": o glumă internă, o poreclă sau o expresie născută între ei.
Fără ce face doar în scenă, fără presupuneri. Poate fi [].
B) "relatie": cum s-a schimbat, realist, cu pași mici (de obicei -3..+4): trust (crește când e sincer, ține minte, o susține; scade când minte, ignoră, își bate joc), warm (apropiere, afecțiune), tension (o mică supărare reală: nepoliticos, a uitat ceva important, a lipsit mult după o promisiune; scade când se lămuresc; nu inventa conflicte), why (motivul tensiunii sau gol), moment (doar dacă s-a întâmplat ACUM ceva memorabil și nou: secret, gluma, sprijin, cearta, impacare, incredere, amintire, dor, surpriza; altfel null; "t" = propoziție scurtă la persoana a II-a plural).
JSON: {"fapte":[{"t":"…","tip":"fapt"}],"relatie":{"trust":0,"warm":0,"tension":0,"why":"","moment":null}}`, {max:600, tag:'fundal'});
  }catch(e){}
}
LATER.analiza = async (out, d, cid) => {   // 8.19: rezultatul analizei (direct sau din lot)
  const c = charById(cid); if(!c) return;
  try{
    const j = parseJSON(out);
    const arr = (Array.isArray(j.fapte) ? j.fapte : []).map(x => ({t:faraLiniute(String(x && x.t || '').trim()), k:x && /urm/i.test(x.tip || '') ? 'urm' : x && /gl/i.test(x.tip || '') ? 'gluma' : ''}))
      .filter(x => x.t && !(c.facts || []).some(f => f.t === x.t)).slice(0, 5);
    if(arr.length) c.facts = (c.facts || []).concat(arr.map(x => ({t:x.t, ts:Date.now(), ...(x.k ? {k:x.k} : {})}))).slice(-40);
    if(j.relatie && typeof j.relatie === 'object') applyBond(c, j.relatie);
    await saveChars();
  }catch(e){}
}
function drawBond(c){
  const box = $('#pfBond'); if(!box) return;
  const b = bondOf(c), bar = (lbl, v, cls) => `<div class="bdrow"><span>${lbl}</span><div class="bdbar ${cls}"><i style="width:${v}%"></i></div><b>${v}</b></div>`;
  box.innerHTML = bar('🔐 Încredere', b.trust, 'tr') + bar('💗 Apropiere', b.warm, 'wm') + bar('⚡ Tensiune', b.tension, 'tn')
    + (b.tension >= 45 && b.why ? `<p class="bdwhy">E puțin supărat(ă): ${esc(b.why)}</p>` : '')
    + ((c.arcs || []).length ? `<div class="bdarcs">${c.arcs.slice(-6).reverse().map(a => `<div><i>${ARC_E[a.tip] || '💫'}</i><span>${esc(a.t)}<small>${new Date(a.ts).toLocaleDateString('ro-RO', {day:'numeric', month:'short'})}</small></span></div>`).join('')}</div>` : '<p class="hint" style="margin:8px 0 0">Momentele-cheie apar singure din conversații: primul secret, o glumă doar a voastră, o neînțelegere și împăcarea.</p>');
}

/* ───────── 🌍 8.15: mod „învață o limbă” ───────── */
const LANGS = {en:['Engleză', 'en-US', 'English'], es:['Spaniolă', 'es-ES', 'Spanish'], fr:['Franceză', 'fr-FR', 'French'], it:['Italiană', 'it-IT', 'Italian'], de:['Germană', 'de-DE', 'German']};
const LVLS = {a:['Începător', 'A1-A2: propoziții scurte și simple, vocabular de bază'], b:['Intermediar', 'B1-B2: limbaj natural de zi cu zi, expresii uzuale'], c:['Avansat', 'C1: limbaj bogat, idiomatic, nuanțat']};
const learnOn = c => !!(c && c.learn && c.learn.on && LANGS[c.learn.lang]);
const langOf = c => learnOn(c) ? LANGS[c.learn.lang][1] : 'ro-RO';
const CORR_RE = /\s*\[corectur[ăa]:\s*([^\]\n]{3,300})\]/gi;
function learnFor(c){
  if(!learnOn(c)) return '';
  const L = LANGS[c.learn.lang], lv = LVLS[c.learn.lvl || 'b'], u = S.userName.trim() || 'el';
  return `## Mod de învățare: ${L[2]}
${u} învață ${L[2].toLowerCase()} vorbind cu tine. Scrii DOAR în ${L[2]} (inclusiv *acțiunile*), la nivelul ${lv[1]}, rămânând în personaj; etichetele tehnice ([stare:], [acum:] etc.) rămân cum sunt. Dacă el scrie în română, îi răspunzi tot în ${L[2]}, firesc, poate cu un cuvânt-cheie tradus între paranteze.
Dacă în ultimul lui mesaj sunt greșeli în ${L[2]}, adaugă la final, câte una pe rând separat (cel mult 2, cele mai importante): [corectură: ce a scris → forma corectă | explicație scurtă în română]. Dacă nu are greșeli, nu adăuga nimic. Nu comenta greșelile în textul conversației.`;
}
function learnSheet(c){
  const l = c.learn || {lang:'en', lvl:'b', on:false};
  openSheet(`<h4>🌍 Învață o limbă cu ${esc(c.name)}</h4><div class="pad">
    <p class="hint">Vorbește cu tine doar în limba aleasă, te corectează discret sub mesaje, iar vocalele și apelurile sunt în limba aceea.</p>
    <label>Limba</label><div class="seg" id="lnLang">${Object.entries(LANGS).map(([k, v]) => `<button data-v="${k}" class="${l.lang === k ? 'on' : ''}">${v[0]}</button>`).join('')}</div>
    <label style="margin-top:10px">Nivel</label><div class="seg" id="lnLvl">${Object.entries(LVLS).map(([k, v]) => `<button data-v="${k}" class="${(l.lvl || 'b') === k ? 'on' : ''}">${v[0]}</button>`).join('')}</div>
    <div class="btns" style="margin-top:14px">${l.on ? '<button class="btn" id="lnOff">Oprește</button><button class="btn" id="lnSum">📝 Rezumatul lecției</button>' : ''}<button class="btn pri" id="lnOn">${l.on ? 'Salvează' : 'Pornește'}</button></div></div>`);
  const pick = id => $$('#' + id + ' button').forEach(b => b.onclick = () => { $$('#' + id + ' button').forEach(x => x.classList.remove('on')); b.classList.add('on'); });
  pick('lnLang'); pick('lnLvl');
  $('#lnOn').onclick = async () => { c.learn = {...(c.learn || {}), lang:$('#lnLang .on').dataset.v, lvl:$('#lnLvl .on').dataset.v, on:true}; await saveChars(); closeSheet(); toast(`🌍 ${c.name} vorbește acum în ${LANGS[c.learn.lang][0].toLowerCase()}`); if(chat && cur === c) $('#chTag').innerHTML = statusLine(); };
  const off = $('#lnOff'); if(off) off.onclick = async () => { c.learn.on = false; await saveChars(); closeSheet(); toast('Modul de învățare e oprit'); };
  const sm = $('#lnSum'); if(sm) sm.onclick = () => learnSummary(c);
}
async function learnSummary(c){
  const all = (c.learn && c.learn.log || []).slice(-40);
  openSheet(`<h4>📝 Rezumatul lecției · ${esc(LANGS[c.learn.lang][0])}</h4><div class="pad" id="lnBox">${all.length ? '<span class="spin"></span> Analizez…' : 'Încă nicio corectură. Scrie-i în limba aleasă și apar aici.'}</div>`);
  if(!all.length) return;
  let sum = '';
  try{ sum = (await stream('Ești un profesor de limbi străine prietenos. Răspunzi în română, scurt.', [{role:'user', text:`Elevul învață ${LANGS[c.learn.lang][2]}. Corecturile din ultimele conversații:\n${all.map(x => '- ' + x.t).join('\n')}\n\nÎn 3-5 rânduri: tiparele de greșeli, la ce să fie atent și un sfat practic. Fără liste lungi.`}], {max:350, aux:true, cid:c.id})).trim(); }catch(e){}
  const box = $('#lnBox'); if(!box) return;
  box.innerHTML = `${sum ? `<p class="lnsum">${esc(sum)}</p>` : ''}<div class="lnlist">${all.slice().reverse().map(x => `<div>✏️ ${esc(x.t)}<small>${new Date(x.ts).toLocaleDateString('ro-RO', {day:'numeric', month:'short'})}</small></div>`).join('')}</div>`;
}
async function translateMsg(m){
  if(m.tr && m.trFor === m.text){ m.trOn = !m.trOn; renderMsgs(); return; }
  toast('Traduc…', 1500);
  try{ m.tr = (await stream('Traduci exact în română, natural. Răspunzi doar cu traducerea.', [{role:'user', text:plain(stripMood(m.text))}], {max:500, aux:true, cid:cur && cur.id})).trim(); m.trFor = m.text; m.trOn = true; await saveChat(); renderMsgs(); }catch(e){ toast('N-am putut traduce: ' + e.message, 3000); }
}

/* ───────── 📱 8.15: telefonul personajului (galerie, muzică, notițe) ───────── */
async function genPhone(c){
  const u = S.userName.trim() || 'el';
  const facts = (c.facts || []).slice(-10).map(f => f.t).join('; ');
  const ev = (c.ev || []).filter(e => e.d >= dayKey(Date.now())).slice(0, 3).map(e => e.d + ': ' + e.t).join('; ');
  const out = await stream('Creezi conținutul realist al telefonului unui personaj. Răspunzi DOAR cu JSON valid.', [{role:'user', text:
`Personaj: ${c.name}. ${c.tag ? c.tag + '. ' : ''}${c.city ? 'Locuiește în ' + c.city + '. ' : ''}${c.persona ? c.persona.slice(0, 1200) : ''}
${ev ? 'Ce urmează în agenda lui: ' + ev + '\n' : ''}${facts ? 'Ce știe despre ' + u + ': ' + facts + '\n' : ''}
1. "songs": 12 piese reale (artist și titlu exact, piese existente), pe gustul lui, de genuri potrivite cu personalitatea și vârsta, eventual câteva românești dacă se potrivește.
2. "notes": 5 notițe din aplicația lui de Notes, scrise de el, în română, la persoana I, naturale și scurte (titlu + 1-6 rânduri): o listă de cumpărături, idei sau planuri legate de agenda lui, un citat sau un gând, ceva despre muncă sau hobby, și o notiță despre ${u} (lucruri pe care vrea să le țină minte despre el, drăguț, fără nimic intim).
3. "now": indexul piesei pe care o ascultă acum.
JSON: {"songs":[{"a":"artist","t":"titlu"}],"notes":[{"t":"titlu","b":"text"}],"now":0}`}], {max:1600, aux:true, cid:c.id});
  const j = parseJSON(out);
  const songs = (Array.isArray(j.songs) ? j.songs : []).map(x => ({a:String(x.a || '').slice(0, 60), t:String(x.t || '').slice(0, 80)})).filter(x => x.a && x.t).slice(0, 15);
  const notes = (Array.isArray(j.notes) ? j.notes : []).map(x => ({t:faraLiniute(String(x.t || '')).slice(0, 60), b:faraLiniute(String(x.b || '')).slice(0, 600), ts:Date.now() - Math.random() * 6 * 864e5})).filter(x => x.t);
  if(songs.length < 4) throw new Error('Telefonul n-a ieșit. Mai încearcă.');
  c.phone = {songs, notes, now:Math.max(0, Math.min(songs.length - 1, +j.now || 0)), day:dayKey(Date.now()), at:Date.now()};
  await saveChars();
}
function phoneNow(c){   // ce ascultă azi: se schimbă zilnic
  if(!c.phone || !c.phone.songs.length) return null;
  if(c.phone.day !== dayKey(Date.now())){ c.phone.day = dayKey(Date.now()); c.phone.now = Math.floor(Math.random() * c.phone.songs.length); saveChars(); }
  return c.phone.songs[c.phone.now];
}
function phoneFor(c){
  if(!c.phone) return '';
  const n = phoneNow(c);
  return `## Telefonul tău (${S.userName.trim() || 'el'} îl poate vedea în aplicație)\nPlaylistul tău: ${c.phone.songs.map(s => s.a + ' – ' + s.t).join('; ')}.${n ? ` Azi asculți des: ${n.a} – ${n.t}.` : ''}\nNotițele tale: ${c.phone.notes.map(x => '„' + x.t + '”').join(', ')}. Le pomenești doar dacă vine vorba.`.replace(/ – /g, ' - ');
}
async function openPhone(c){
  if(!c.phone){ toast('Îi deschid telefonul…', 2500); try{ await genPhone(c); }catch(e){ toast(e.message, 3500); return; } }
  const chats = await allChats(c);
  const pics = chats.flatMap(ch => ch.msgs.filter(m => m.img && m.role === 'ai').map(m => ({k:m.img, ts:m.ts}))).concat(feedCache.filter(p => p.cid === c.id && p.img).map(p => ({k:p.img, ts:p.ts}))).sort((a, b) => b.ts - a.ts);
  const now = charNow(c), np = phoneNow(c), lf = lifeNow(c);
  const nx = (c.ev || []).filter(e => e.d >= dayKey(Date.now())).sort((a, b) => a.d < b.d ? -1 : 1)[0];
  const el = document.createElement('div'); el.className = 'phonev';
  el.innerHTML = `<div class="phframe"><div class="phwall">${c.photo ? `<img data-k="${esc(photoNow(c))}" alt="">` : ''}</div>
    <div class="phbar"><b>${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</b><span>📶 🔋</span></div>
    <div class="phscreen" data-p="home">
      <div class="phclock"><b>${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</b><small>${now.toLocaleDateString('ro-RO', {weekday:'long', day:'numeric', month:'long'})}</small></div>
      <div class="phnotes">${np ? `<div class="phn"><i>🎵</i><span><b>Acum ascultă</b>${esc(np.a)} – ${esc(np.t)}</span></div>` : ''}${nx ? `<div class="phn"><i>🗓️</i><span><b>Calendar</b>${esc(evDayLabel(nx.d))}${nx.h ? ', ' + nx.h : ''}: ${esc(nx.t)}</span></div>` : ''}${lf ? `<div class="phn"><i>${LIFE_E[lf.b]}</i><span><b>Acum</b>${esc(lf.w)}</span></div>` : ''}</div>
      <div class="phapps"><button data-ap="gal"><i style="background:linear-gradient(135deg,#ffb020,#ff4f9a)">🖼️</i><small>Galerie</small></button><button data-ap="mus"><i style="background:linear-gradient(135deg,#ff4f6a,#9b5cff)">🎵</i><small>Muzică</small></button><button data-ap="not"><i style="background:linear-gradient(135deg,#ffd84f,#ffb020)">📝</i><small>Notițe</small></button></div>
    </div></div><button class="phx" aria-label="Închide">✕</button><button class="phre" aria-label="Reîmprospătează">↻ Actualizează telefonul</button>`;
  document.body.appendChild(el); hydrate(el);
  const scr = el.querySelector('.phscreen'), home = scr.innerHTML;
  const head = t => `<div class="phhead"><button data-ap="home">‹</button><b>${t}</b></div>`;
  const app = k => {
    if(k === 'home'){ scr.innerHTML = home; scr.dataset.p = 'home'; }
    else if(k === 'gal') scr.innerHTML = head('Galerie') + (pics.length ? `<div class="phgal">${pics.map(p => `<img data-k="${esc(p.k)}" data-pv="${esc(p.k)}" alt="" loading="lazy">`).join('')}</div>` : '<p class="phempty">Încă nicio poză.</p>');
    else if(k === 'mus') scr.innerHTML = head('Muzică') + `<div class="phmus">${c.phone.songs.map((s, i) => `<a href="https://www.youtube.com/results?search_query=${encodeURIComponent(s.a + ' ' + s.t)}" target="_blank" rel="noopener" class="${np && np.t === s.t ? 'on' : ''}"><i>${np && np.t === s.t ? '▶' : i + 1}</i><span><b>${esc(s.t)}</b><small>${esc(s.a)}</small></span></a>`).join('')}</div>`;
    else if(k === 'not') scr.innerHTML = head('Notițe') + `<div class="phnot">${c.phone.notes.map(n => `<div><b>${esc(n.t)}</b><p>${esc(n.b)}</p><small>${new Date(n.ts).toLocaleDateString('ro-RO', {day:'numeric', month:'short'})}</small></div>`).join('')}</div>`;
    scr.dataset.p = k; hydrate(scr);
  };
  el.onclick = async e => {
    const a = e.target.closest('[data-ap]'); if(a){ app(a.dataset.ap); return; }
    const pv = e.target.closest('[data-pv]'); if(pv){ viewImg(pv.dataset.pv, pics.map(p => p.k)); return; }
    if(e.target.closest('.phx')){ closePhone(); return; }
    if(e.target.closest('.phre')){ const b = el.querySelector('.phre'); b.innerHTML = '<span class="spin"></span>'; try{ await genPhone(c); closePhone(); openPhone(c); }catch(er){ toast(er.message, 3000); b.textContent = '↻ Actualizează telefonul'; } }
  };
  phoneEl = el;
}
let phoneEl = null;
function closePhone(){ if(!phoneEl) return; const p = phoneEl; phoneEl = null; p.classList.add('out'); setTimeout(() => p.remove(), 250); }

/* ───────── 🎁 8.15: cadouri care rămân (apar în poze, le pomenește peste săptămâni) ───────── */
async function giftClassify(c, g){
  if(!aiReady()) return;
  try{
    const j = parseJSON(await stream('Clasifici cadouri pentru o poveste. Răspunzi DOAR cu JSON valid.', [{role:'user', text:
`Cadou: „${g.n}”. Ce fel de cadou e și cum se vede într-o fotografie?
kind: wear (bijuterie, haină, accesoriu purtat), place (obiect care stă în casă: flori, plantă, ursuleț, carte, cană, poză), food (se consumă repede), experience (bilete, o ieșire).
en: descrierea vizuală concretă în engleză, 4-12 cuvinte, cum apare în poză (ex. "a thin silver necklace with a small heart pendant", "a bouquet of red roses in a glass vase").
days: câte zile rămâne vizibil (wear/place durabile: 365; flori: 7; food: 2; experience: 0).
JSON: {"kind":"wear","en":"…","days":365}`}], {max:120, aux:true, cid:c.id}));
    Object.assign(g, {kind:['wear', 'place', 'food', 'experience'].includes(j.kind) ? j.kind : 'place', en:String(j.en || '').slice(0, 120), days:Math.max(0, Math.min(365, +j.days || 0))});
    await saveChars();
  }catch(e){}
}
const giftsAlive = c => (c.gifts || []).filter(g => g.en && g.days && Date.now() - g.ts < g.days * 864e5);
function giftDetail(c, shot, where){   // detaliu în poză: poartă colierul / florile sunt pe masă (nu în fiecare poză)
  const alive = giftsAlive(c); if(!alive.length) return shot;
  const home = !!where && /home|bed|living|kitchen|bath|dormitor|sufragerie|bucat|acas/i.test((where.room || '') + ' ' + (where.place || '') + ' ' + (where.home ? 'home' : ''));
  const wear = alive.filter(g => g.kind === 'wear'), place = alive.filter(g => g.kind === 'place');
  const add = [];
  if(wear.length && Math.random() < .6){ const g = wear[Math.floor(Math.random() * wear.length)]; add.push(`she is wearing ${g.en} (a gift from him)`); }
  if(place.length && home && Math.random() < .5){ const g = place[Math.floor(Math.random() * place.length)]; const old = (Date.now() - g.ts) / 864e5; add.push(`visible nearby: ${g.en}${g.days <= 10 && old > g.days * .6 ? ', slightly wilted' : ''}`); }
  return add.length ? `${shot}. Small detail: ${add.join('; ')}` : shot;
}
function giftExtras(c){   // după o săptămână / o lună: o pomenește o singură dată
  for(const g of (c.gifts || []).slice().reverse()){
    const d = (Date.now() - g.ts) / 864e5, mark = d > 30 ? 30 : d > 7 ? 7 : 0;
    if(!mark || (g.rc || 0) >= mark || !g.kind || g.kind === 'food') continue;
    g.rc = mark; saveChars();
    return ` (acum ${mark === 30 ? 'o lună' : 'o săptămână'} ți-a dăruit ${g.n}${g.kind === 'wear' ? '; îl porți des' : g.kind === 'place' ? (g.days <= 10 ? '; florile s-au ofilit între timp, poate ai păstrat una' : '; e la tine acasă, la vedere') : '; a fost o amintire frumoasă'}. Dacă se potrivește, pomenește-l firesc, în treacăt)`;
  }
  return '';
}
/* ───────── 🖼️ avatar viu ───────── */
/* 👫 8.1: poza ta + pozele împreună */
async function drawMe(){
  const box = $('#stMeImg'); if(!box) return;
  const u = S.userPhoto ? await imgUrl(S.userPhoto) : '';
  box.innerHTML = u ? `<img src="${u}" alt="">` : '🙂';
  $('#stMeDel').hidden = !S.userPhoto;
  $('#stMePick').textContent = S.userPhoto ? '📷 Schimbă poza' : '📷 Alege poza';
  $('#stMeInfo').innerHTML = S.userPhoto ? (S.userPhys ? 'Trăsături citite: <i>' + esc(S.userPhys) + '</i>' : meReading ? '<span class="spin"></span> Se citesc trăsăturile…' : `⚠️ N-am putut citi trăsăturile${meErr ? ' (' + esc(meErr) + ')' : ''}. <button class="btn sm" id="stMeRe" type="button">↻ Încearcă din nou</button>`) + '<br>În chat: ＋ → „👫 Fă o poză împreună”, sau cere-o în conversație.' : 'O poză clară, cu fața ta, din față. Rămâne doar în telefon și intră în backup.';
  const re = $('#stMeRe'); if(re) re.onclick = () => rereadMe();
  if(S.userPhoto && !S.userPhys && !meReading && !meErr && aiReady()) setTimeout(() => rereadMe(), 300);   // rămasă necitită de la o versiune veche: o citim acum
}
async function setMePhoto(file){
  if(!file) return;
  try{
    const b = await toJpeg(file, 1280, .9), old = S.userPhoto;
    S.userPhoto = await saveImg(b); S.userPhys = ''; saveSettings();
    if(old) delImg(old).catch(() => {});
    drawMe();
    await rereadMe(b);
  }catch(e){ toast('Nu pot citi poza: ' + e.message, 3500); }
}
// 8.10.1: citirea trăsăturilor nu mai rămâne agățată: arată eroarea și se poate relua
let meReading = false;
async function rereadMe(b){
  if(meReading) return; meReading = true; meErr = ''; drawMe();
  try{
    b = b || await DB.get(S.userPhoto); if(!b) throw new Error('poza lipsește');
    if(!aiReady()) throw new Error('pune întâi cheia AI în Setări');
    S.userPhys = await readPhys(b, true); saveSettings();
    if(!S.userPhys) throw new Error('AI-ul n-a descris poza');
  }catch(e){ meErr = e.message || 'eroare'; }
  meReading = false; drawMe();
}
let meErr = '';
// trăsăturile permanente ale persoanei din poză (fără haine), pentru prompt; o singură dată per poză
async function readPhys(blob, strict){
  if(!aiReady()) return '';
  try{
    const out = await stream('You analyse reference photos for an image generator. Answer with JSON only.', [{role:'user', image:await blobToB64(await toJpeg(blob, 1024, .85)), text:
      'Find the main person\'s face (forehead to chin, ear to ear) as fractions 0-1 of the image width/height, top-left origin, and describe ONLY the permanent physical traits of that person, in English, comma-separated, max 55 words: apparent age, skin tone, face shape, eye color, eyebrows, nose, lips, hair (exact color, length, texture, style), facial hair, glasses if worn, body build. NO clothing, NO background, NO pose, NO expression. JSON: {"x":0.0,"y":0.0,"w":0.0,"h":0.0,"physique":"..."}'}], {max:350, aux:true});
    const j = parseJSON(out), n = k => Math.min(1, Math.max(0, +j[k] || 0));
    S.userBox = n('w') > .02 && n('h') > .02 ? {x:n('x'), y:n('y'), w:n('w'), h:n('h')} : null;
    return String(j.physique || '').trim().slice(0, 500);
  }catch(e){ if(strict) throw e; return ''; }
}
// o singură imagine de referință cu amândoi: stânga personajul, dreapta tu (merge și pe Worker-ele care nu acceptă 2 repere)
async function pairRef(a, b, ba, bb){
  // 8.3: 512×512 (cât primește Cloudflare); fiecare jumătate (256×512) e decupată în jurul feței: cap și umeri, mari
  const W = 512, H = 512, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
  const draw = async (blob, x, bx) => {
    const u = URL.createObjectURL(blob);
    try{ const im = await loadImgEl(u), IW = im.naturalWidth, IH = im.naturalHeight;
      let sh = bx ? Math.min(IH, bx.h * IH * 3.2) : IH * .6, sw = sh / 2;
      if(sw > IW){ sw = IW; sh = sw * 2; }
      const cx = bx ? (bx.x + bx.w / 2) * IW : IW / 2, top = bx ? bx.y * IH - bx.h * IH * .5 : 0;
      const sx = Math.min(Math.max(0, cx - sw / 2), IW - sw), sy = Math.min(Math.max(0, top), Math.max(0, IH - sh));
      g.drawImage(im, sx, sy, sw, sh, x, 0, W / 2, H); }
    finally{ URL.revokeObjectURL(u); }
  };
  await draw(a, 0, ba); await draw(b, W / 2, bb);
  return await new Promise(r => cv.toBlob(r, 'image/jpeg', .9));
}
function togetherFraming(shot){
  const t = String(shot || '').toLowerCase();
  if(/mirror/.test(t)) return 'Mirror selfie of the two of them together, both bodies visible in the mirror, one of them holding the phone';
  if(/propped|timer|tripod/.test(t)) return 'Photo of the two of them together taken with the phone propped up on a timer, both fully visible, the place around clearly visible';
  if(/close[- ]?up/.test(t)) return 'Close selfie of the two of them, faces side by side, taken at arm\'s length';
  return 'Selfie of the two of them together taken at arm\'s length by one of them, both faces and upper bodies clearly visible, the place visible behind';
}
/* 🖼️ 8.5: poze de referință în plus (alte unghiuri ale aceleiași persoane), cel mult 2 */
async function drawRefs(c, box){
  const refs = c.refs || [];
  box.insertAdjacentHTML('beforeend', `<div class="refbox"><b>🧩 Poze de referință în plus</b><small>1–2 poze în plus, din alte unghiuri (profil, zâmbind, altă lumină). Ajută pozele din chat să păstreze fața. Doar cu Worker v6.</small>
    <div class="refgrid">${refs.map((k, i) => `<figure><img data-k="${esc(k)}" alt=""><button data-rfx="${i}" aria-label="Scoate">✕</button></figure>`).join('')}${refs.length < 2 ? '<button class="refadd" id="pfRefAdd">＋</button>' : ''}</div>
    <input type="file" id="pfRefFile" accept="image/*" hidden></div>`);
  hydrate(box);
  const add = $('#pfRefAdd'); if(add) add.onclick = () => $('#pfRefFile').click();
  $('#pfRefFile').onchange = async e => { const f = e.target.files[0]; if(!f) return;
    try{ const k = await saveImg(await toJpeg(f, 1280, .9)); c.refs = (c.refs || []).concat(k).slice(0, 2); await saveChars(); drawPics(c); toast('🧩 Poză de referință adăugată'); }catch(er){ toast('Nu pot citi poza.'); } };
  box.querySelectorAll('[data-rfx]').forEach(b => b.onclick = async () => { const k = c.refs.splice(+b.dataset.rfx, 1)[0]; if(c.refBoxes) delete c.refBoxes[k]; await delImg(k).catch(() => {}); await saveChars(); drawPics(c); });
}
/* 🏠 7.0: casa personajului: camerele descrise o dată și refolosite în poze */
function drawHome(c, box){
  const rooms = Object.entries(c.home || {});
  box.insertAdjacentHTML('beforeend', `<div class="homebox"><b>🏠 Casa · ${esc(c.name)}</b><small>${rooms.length ? 'Camerele apar la fel în fiecare poză.' : 'Camerele se descriu singure la prima poză din fiecare; le poți scrie și tu.'}</small>
    ${rooms.length ? `<ul>${rooms.map(([k, v]) => `<li><b>${esc(ROOM_RO[k] || k)}</b> ${esc(v)}</li>`).join('')}</ul>` : ''}
    <button class="btn sm" id="pfHomeEd">✏️ ${rooms.length ? 'Editează' : 'Descrie camerele'}</button></div>`);
  $('#pfHomeEd').onclick = () => {
    const txt = rooms.map(([k, v]) => (ROOM_RO[k] || k) + ': ' + v).join('\n');
    openSheet(`<h4>🏠 Casa · ${esc(c.name)}</h4><div class="pad"><p>Câte o cameră pe rând: <b>Cameră: descriere</b>. Descrierea merge direct la generator, deci e mai bine în engleză (culori, mobilă, fereastră, podea).</p><textarea id="homeTx" rows="9" placeholder="Dormitor: small bedroom, turquoise curtains, grey bedspread, white wardrobe, warm bedside lamp&#10;Bucătărie: …">${esc(txt)}</textarea>
      <div class="btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="homeSave">Salvează</button></div></div>`);
    $('#homeSave').onclick = async () => {
      const h = {};
      for(const ln of $('#homeTx').value.split('\n')){ const mm = ln.match(/^\s*([^:]{2,30}):\s*(.{3,320})$/); if(mm){ const k = mm[1].trim().toLowerCase(); h[ROOM_KEY[k] || k] = mm[2].trim(); } }
      c.home = h; await saveChars(); closeSheet(); drawPics(c); toast('🏠 Salvat');
    };
  };
}
/* 📷 6.5: personajul îți trimite poze în conversație (și cu poză de profil urcată) */
// 8.9.2: ce scrii tu despre cum arată (corp, înălțime, piele, păr) are prioritate la fiecare poză
function drawBodyNote(c, box){
  const fbx = c.faceBox && c.faceBox.k === c.photo ? c.faceBox : null, auto = fbx && fbx.phys ? fbx.phys : '';
  const mk = fbx && fbx.mode !== 'full' ? [...(fbx.glasses ? ['👓 ' + fbx.glasses] : []), ...(fbx.marks || [])] : [];   // în modul detaliat sunt deja în text
  box.insertAdjacentHTML('beforeend', `<div class="refbox bodyn"><b>🧍 Cum arată, pentru poze</b>
    <small>${auto ? 'Citit automat din poza de profil: <i>' + esc(auto) + '</i>' : 'Se citește automat din poza de profil la prima poză.'}</small>
    ${mk.length ? `<small style="margin-top:6px">Semne care rămân mereu la locul lor: <i>${mk.map(esc).join(' · ')}</i></small>` : ''}
    <small style="margin-top:6px">Dacă ceva nu iese cum trebuie (siluetă, înălțime, piele, păr, semne), scrie aici în română. Are prioritate față de ce citește aplicația.</small>
    <textarea id="pfBody2" rows="3" maxlength="400" placeholder="ex. 1,58 m, siluetă plinuță cu șolduri late, piele bronzată, păr negru drept până la mijlocul spatelui, aluniță pe obrazul stâng">${esc(c.physUser || '')}</textarea>
    <div class="btns"><button class="btn sm pri" id="pfBodySave">Salvează</button>${c.photo ? '<button class="btn sm" id="pfBodyRe">↻ Recitește poza</button>' : ''}</div></div>`);
  $('#pfBodySave').onclick = async () => {
    const t = $('#pfBody2').value.trim(), b = $('#pfBodySave'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try{
      c.physUser = t; c.physEn = '';
      if(t) c.physEn = aiReady() ? faraLiniute((await stream('You translate physical descriptions for an image generator. Answer with the English translation only.', [{role:'user', text:'Translate to concise, neutral English (comma-separated traits, keep every detail, no additions):\n' + t}], {max:250, aux:true, cid:c.id})).trim()).slice(0, 500) : t;
      await saveChars(); toast('✓ Salvat: se folosește la următoarele poze');
    }catch(e){ toast('N-am putut salva: ' + e.message, 3500); }
    b.disabled = false; b.textContent = 'Salvează';
  };
  const re = $('#pfBodyRe'); if(re) re.onclick = async () => { re.disabled = true; re.innerHTML = '<span class="spin"></span> Citesc…'; try{ await identityOf(c, true); }catch(e){} drawPics(c); };
}
function drawPics(c){
  const box = $('#pfPics'); if(!box) return;
  const on = sendPicsOn(c);
  const why = S.imgProv === 'none' ? 'Pozele sunt oprite în Setări → Poze; pornește-le acolo.' : !c.photo ? 'Are nevoie de o poză de profil (după ea se păstrează fața).' : '';
  box.innerHTML = `<div class="pfVoice"><span>${on ? '✅ Pornit' : '⏸ Oprit'}${why ? ' · ' + why : ''}</span><button class="btn sm" id="pfPicsOn">${on ? '⏸ Oprește' : '▶ Pornește'}</button></div>
    <p class="hint" style="margin-top:6px">${on ? `${esc(c.name)} îți poate trimite poze în chat: când vrea, când i-o ceri, plus cele spontane (Setări → Poze) și cele din statusuri. Fața vine din poza de profil.` : `${esc(c.name)} nu trimite poze singur${c.aiPortrait ? '' : ' (implicit doar personajele cu portret generat în aplicație o fac)'}. 📷 Cere o poză din ＋ merge oricum.`}</p>`;
  $('#pfPicsOn').onclick = async () => { c.sendPics = !on; await saveChars(); drawPics(c); toast(c.sendPics ? '📷 ' + c.name + ' îți poate trimite poze' : c.name + ' nu mai trimite poze singur'); };
  drawBodyNote(c, box);
  drawRefs(c, box);
  drawHome(c, box);
  if(c.photo && (S.imgProv === 'worker' || S.imgProv === 'fal')){
    const fb = c.faceBox && c.faceBox.k === c.photo ? c.faceBox : null;
    box.insertAdjacentHTML('beforeend', `<div class="faceref"><div class="fimg" id="pfFace">${fb ? '<span class="spin"></span>' : '?'}</div><div><b>Fața (al doilea reper)</b><small>${fb ? (fb.none ? 'Nu am găsit fața; folosesc partea de sus a pozei. ' : '') + (fb.phys ? 'Trăsături citite din poza de profil, trimise la fiecare poză: <i>' + esc(fb.phys) + '</i>' : 'Detaliile feței, pe lângă poza de profil întreagă.') : 'Se citește la prima poză.'}</small><button class="btn sm" id="pfFaceRe">${fb ? '↻ Caută din nou' : '🔍 Caută acum'}</button></div></div>`);
    const show = async force => { const el = $('#pfFace'); if(!el) return; el.innerHTML = '<span class="spin"></span>';
      try{ const b = await faceRef(c, force); if(profId !== c.id) return; const u = URL.createObjectURL(b); el.innerHTML = `<img src="${u}" alt="">`; if(force) drawPics(c); }catch(e){ el.textContent = '!'; toast('N-am putut decupa fața: ' + e.message, 3500); } };
    if(fb) show(false);
    $('#pfFaceRe').onclick = () => show(true);
  }
}
function drawAv(c){
  const box = $('#pfAv'); if(!box) return;
  const can = !!c.aiPortrait && S.imgProv !== 'none' && c.photo;
  if(!can && !c.avs){ box.innerHTML = `<p style="color:var(--tx3);font-size:.88rem;margin:0">Disponibil pentru personajele cu portret generat în aplicație${S.imgProv === 'none' ? ', cu pozele pornite' : ''}: poza lui mică se schimbă după momentul zilei și dispoziție.</p>`; return; }
  const now = c.avLive ? avKeyNow(c) : '';
  box.innerHTML = `<div class="avgrid">${AV_V.map(v => `<figure class="${now === v[0] ? 'now' : ''}">${c.avs && c.avs[v[0]] ? `<img data-k="${esc(c.avs[v[0]])}" data-view="${esc(c.avs[v[0]])}" alt="">` : '<div class="ph">·</div>'}<figcaption>${v[1]}</figcaption></figure>`).join('')}</div>
    <div class="btns jbtn">${can ? `<button class="btn sm" id="avGen">${c.avs ? '✨ Refă variantele' : '✨ Generează cele 6 variante'}</button>` : ''}${c.avs ? `<button class="btn sm" id="avOn">${c.avLive ? '⏸ Oprește' : '▶ Pornește'}</button>` : ''}</div>
    <p class="hint" style="margin-top:6px">${c.avs ? (c.avLive ? 'Pornit: poza mică se schimbă singură (dimineața, ziua, seara, noaptea; vesel sau pensiv după dispoziție).' : 'Oprit: rămâne poza de profil.') : `6 poze generate o singură dată (~${neurPerPhoto() ? Math.round(neurPerPhoto() * 6) + ' neuroni' : 'câțiva cenți'}).`}</p>`;
  hydrate(box);
  box.onclick = e => { const v = e.target.closest('[data-view]'); if(v) viewImg(v.dataset.view, Object.values(c.avs || {})); };
  const on = $('#avOn'); if(on) on.onclick = async () => { c.avLive = !c.avLive; await saveChars(); drawAv(c); toast(c.avLive ? '🖼️ Avatarul viu e pornit' : 'Avatarul viu e oprit'); };
  const g = $('#avGen'); if(g) g.onclick = () => genAvatars(c);
}
async function genAvatars(c){
  if(busy){ toast('Așteaptă să termine răspunsul.'); return; }
  const b = $('#avGen'); if(b){ b.disabled = true; b.innerHTML = '<span class="spin"></span> 0/6'; }
  const ref = await DB.get(c.photo); if(!ref){ toast('Nu găsesc poza de profil.'); return; }
  const avs = {...(c.avs || {})}; let ok = 0;
  for(const [k, , desc] of AV_V){
    try{
      const prompt = `A new head-and-shoulders portrait photo of the same person as in the reference image (keep the face, hair and identity exactly). ${desc}. Framing like a profile picture. ${STIL_TAG[c.stil || 'photo']}`;
      let bl = await genImage(prompt, ref, null, null, {why:'profil'});
      try{ if(bl.type === 'image/png') bl = await toJpeg(bl, 1024, .9); }catch(e){}
      const old = avs[k]; avs[k] = await saveImg(bl); if(old) delImg(old).catch(() => {});
      addUsage(c.id, imgPrice(), 'img', null, 'profil'); ok++;
      c.avs = {...avs}; await saveChars();
      if(b && document.body.contains(b)) b.innerHTML = `<span class="spin"></span> ${ok}/6`;
    }catch(e){ toast('O variantă n-a mers: ' + e.message, 3500); if(e.cap) break; }
  }
  if(ok){ c.avLive = true; await saveChars(); toast(`🖼️ ${ok} variante gata. Avatarul viu e pornit.`); }
  if(profId === c.id) drawAv(c);
  if(!$('#vHome').hidden) renderHome();
}

/* ───────── 🗂️ carduri de personaj ───────── */
const CARD_FIELDS = ['city', 'name', 'tag', 'aspect', 'look', 'stil', 'persona', 'speech', 'greet', 'accent', 'bg', 'aiPortrait', 'voice', 'vPitch', 'life', 'lifeOff', 'avLive', 'sendPics', 'home'];
async function exportCard(c){
  toast('Pregătesc cardul…');
  const out = {app:'taifas-card', v:1, date:new Date().toISOString(), char:{}};
  for(const k of CARD_FIELDS) if(c[k] !== undefined) out.char[k] = c[k];
  const b = c.photo ? await DB.get(c.photo) : null; if(b) out.photo = {data:await blobToB64(b), type:b.type};
  if(c.avs){ out.avs = {}; for(const [k, key] of Object.entries(c.avs)){ const x = await DB.get(key); if(x) out.avs[k] = {data:await blobToB64(x), type:x.type}; } }
  const name = (c.name || 'personaj').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'personaj';
  const file = new File([JSON.stringify(out)], `${name}.taifas.json`, {type:'application/json'});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:c.name}); return; }catch(e){ if(e.name === 'AbortError') return; } }
  download(file, file.name);
}
// 8.20: un card venit de la altcineva e tratat ca date străine: doar tipurile așteptate, cu lungimi limitate
const CARD_TXT = {name:60, tag:160, city:80, aspect:3000, look:1200, persona:6000, speech:600, greet:1500, stil:20, bg:20};
function cleanCardField(k, v){
  const txt = (x, n) => String(x).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u202A-\u202E\u2066-\u2069]/g, '').slice(0, n).trim();
  if(CARD_TXT[k]) return typeof v === 'string' || typeof v === 'number' ? txt(v, CARD_TXT[k]) : undefined;
  if(k === 'accent') return typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined;
  if(k === 'aiPortrait' || k === 'lifeOff' || k === 'avLive' || k === 'sendPics') return typeof v === 'boolean' ? v : undefined;
  if(k === 'vPitch') return isFinite(+v) ? Math.max(.5, Math.min(2, +v)) : undefined;
  if(v && typeof v === 'object'){   // voce, program, casă: obiecte simple, mici, doar cu text și numere
    const j = JSON.stringify(v, (kk, x) => typeof x === 'string' ? txt(x, 600) : (typeof x === 'number' || typeof x === 'boolean' || x === null || typeof x === 'object') ? x : undefined);
    return j && j.length <= 20000 ? JSON.parse(j) : undefined;
  }
  return undefined;
}
async function importCard(file){
  try{
    const j = JSON.parse(await file.text());
    if(j.app !== 'taifas-card' || !j.char || !j.char.name) throw new Error('nu e un card de personaj Taifas');
    const c = {id:uid(), created:Date.now()};
    for(const k of CARD_FIELDS) if(j.char[k] !== undefined){ const v = cleanCardField(k, j.char[k]); if(v !== undefined) c[k] = v; }
    if(!c.name) throw new Error('nume invalid');
    if(chars.some(x => x.name === c.name)) c.name += ' (2)';
    if(j.photo && /^image\/(jpeg|png|webp)$/.test(j.photo.type) && typeof j.photo.data === 'string' && j.photo.data.length < 12e6) c.photo = await saveImg(b64ToBlob(j.photo.data, j.photo.type));
    if(j.avs && typeof j.avs === 'object'){ c.avs = {}; for(const [k, v] of Object.entries(j.avs).slice(0, 8)) if(/^\w{1,20}$/.test(k) && v && /^image\/(jpeg|png|webp)$/.test(v.type) && typeof v.data === 'string' && v.data.length < 8e6) c.avs[k] = await saveImg(b64ToBlob(v.data, v.type)); }
    chars.push(c); await saveChars(); renderHome();
    toast(`📥 ${c.name} a fost importat.`);
    charProfile(c.id);
  }catch(e){ toast('Cardul nu merge: ' + e.message, 4000); }
}
async function duplicateChar(c){
  const n = {id:uid(), created:Date.now()};
  for(const k of CARD_FIELDS) if(c[k] !== undefined) n[k] = JSON.parse(JSON.stringify(c[k]));
  n.name = c.name + ' (copie)';
  if(c.photo){ const b = await DB.get(c.photo); if(b) n.photo = await saveImg(b); }
  if(c.avs){ n.avs = {}; for(const [k, key] of Object.entries(c.avs)){ const b = await DB.get(key); if(b) n.avs[k] = await saveImg(b); } }
  chars.push(n); await saveChars(); renderHome();
  toast(`🧬 ${n.name} e gata, cu conversație nouă.`);
  charProfile(n.id);
}

/* ───────── 📊 Taifas Wrapped ───────── */
const STOP = new Set('faci face făcut ziceai spus care este sunt acum aici acolo pentru despre foarte doar daca dacă când cand unde cum mult multe putin puțin tine mine ceva cineva nimic totul toate toti toți asta acest aceasta această acel acea aceea dupa după inainte înainte mai iar sau dar însă insa chiar bine bună buna atunci astazi astăzi azi maine mâine fost fiind avea aveam avem aveți aveti face facem fac vreau poti poți poate trebuie pot știu stiu spune zice între intre prin lângă langa catre către fara fără'.split(' '));
async function wrapData(mo){
  const res = {mo, msgs:0, mine:0, theirs:0, days:new Set(), hours:Array(24).fill(0), per:{}, pics:0, voice:0, gifts:0, reacts:0, words:{}, emoji:{}, perDay:{}, moments:[]};
  for(const c of chars){
    for(const ch of await allChats(c)) for(const m of ch.msgs){
      if(!m.ts || m.err || m.pending) continue;
      const d = new Date(m.ts); if(d.toISOString().slice(0, 7) !== mo && dayKey(m.ts).slice(0, 7) !== mo) continue;
      if(dayKey(m.ts).slice(0, 7) !== mo) continue;
      res.msgs++; res.days.add(dayKey(m.ts)); res.hours[d.getHours()]++; res.per[c.id] = (res.per[c.id] || 0) + 1; res.perDay[dayKey(m.ts)] = (res.perDay[dayKey(m.ts)] || 0) + 1;
      if(m.role === 'user'){
        res.mine++; if(m.gift) res.gifts++; if(m.react) res.reacts++;
        for(const w of plain(m.text || '').toLowerCase().match(/[\p{L}]{4,}/gu) || []) if(!STOP.has(w)) res.words[w] = (res.words[w] || 0) + 1;
        for(const e of (m.text || '').match(/\p{Extended_Pictographic}/gu) || []) res.emoji[e] = (res.emoji[e] || 0) + 1;
      } else { res.theirs++; if(m.img) res.pics++; if(m.voice) res.voice++; }
    }
    for(const x of c.moments || []) if(x.day.slice(0, 7) === mo) res.moments.push({c, ...x});
  }
  // cea mai lungă serie de zile la rând
  const ds = [...res.days].sort(); let best = 0, run = 0, prev = null;
  for(const d of ds){ const t = new Date(d + 'T12:00').getTime(); run = prev && t - prev < 1.5 * 864e5 ? run + 1 : 1; best = Math.max(best, run); prev = t; }
  res.streak = best;
  const u = await DB.get('usage') || {months:{}}; const M = u.months[mo]; res.cost = M ? M.txt + M.img + (M.voc || 0) : 0;
  return res;
}
async function wrapMonths(){
  const set = new Set();
  for(const c of chars) for(const ch of await allChats(c)) for(const m of ch.msgs) if(m.ts) set.add(dayKey(m.ts).slice(0, 7));
  return [...set].sort().reverse();
}
const moName = mo => new Date(mo + '-15T12:00').toLocaleDateString('ro-RO', {month:'long', year:'numeric'});
async function openWrapped(mo){
  const months = await wrapMonths();
  if(!months.length){ toast('Încă n-ai conversații. Revino după câteva zile de taifas.'); return; }
  mo = mo || months[0];
  closeSheet();
  const v = document.createElement('div'); v.className = 'wrapv';
  v.innerHTML = `<div class="wtop"><h2>Taifas Wrapped</h2><select id="wMo">${months.map(x => `<option value="${x}"${x === mo ? ' selected' : ''}>${esc(moName(x))}</option>`).join('')}</select><button class="ib" id="wX" aria-label="Închide">✕</button></div><div id="wBody"><p class="hint"><span class="spin"></span> Număr…</p></div>`;
  document.body.appendChild(v);
  v.querySelector('#wX').onclick = () => v.remove();
  v.querySelector('#wMo').onchange = e => { v.remove(); openWrapped(e.target.value); };
  const r = await wrapData(mo);
  const top = Object.entries(r.per).map(([id, n]) => [charById(id), n]).filter(x => x[0]).sort((a, b) => b[1] - a[1]);
  const pk = r.hours.indexOf(Math.max(...r.hours)), mx = Math.max(1, ...r.hours);
  const words = Object.entries(r.words).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  const emo = Object.entries(r.emoji).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
  const bestDay = Object.entries(r.perDay).sort((a, b) => b[1] - a[1])[0];
  const part = pk < 5 ? 'noaptea târziu 🌙' : pk < 11 ? 'dimineața ☀️' : pk < 14 ? 'la prânz 🍽️' : pk < 18 ? 'după-amiaza 🌤️' : pk < 22 ? 'seara 🌆' : 'noaptea 🌙';
  const saved = await DB.get('wrapped:' + mo);
  v.querySelector('#wBody').innerHTML = `
    <div class="wcard g1"><h3>${esc(moName(mo))}</h3><div class="big">${r.msgs.toLocaleString('ro-RO')}</div><p>mesaje schimbate: ${r.mine.toLocaleString('ro-RO')} ale tale, ${r.theirs.toLocaleString('ro-RO')} ale personajelor.</p></div>
    <div class="wgrid"><div class="wcard g2"><h3>Zile active</h3><div class="big">${r.days.size}</div></div><div class="wcard g3"><h3>Cea mai lungă serie</h3><div class="big">${r.streak}</div><p>${r.streak === 1 ? 'zi' : 'zile la rând'}</p></div></div>
    <div class="wcard g4"><h3>Ora voastră</h3><div class="big">${String(pk).padStart(2, '0')}:00</div><p>Vorbești cel mai mult ${part}.</p><div class="hours">${r.hours.map((h, i) => `<i class="${i === pk ? 'pk' : ''}" style="height:${Math.round(h / mx * 100)}%"></i>`).join('')}</div><div class="hlbl"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div></div>
    ${top.length ? `<div class="wcard g6"><h3>Cu cine ai vorbit cel mai mult</h3><div class="big">${esc(top[0][0].name)}</div><p>${top[0][1].toLocaleString('ro-RO')} mesaje · ${esc(relOf(top[0][0]).name)}</p><div class="wbars">${top.slice(0, 5).map(([c, n]) => `<div><span>${esc(c.name)}</span><b style="width:${Math.max(4, Math.round(n / top[0][1] * 100))}%"></b><small>${n}</small></div>`).join('')}</div></div>` : ''}
    <div class="wgrid"><div class="wcard g5"><h3>Poze primite</h3><div class="big">${r.pics}</div></div><div class="wcard g2"><h3>Mesaje vocale</h3><div class="big">${r.voice}</div></div>
      <div class="wcard g3"><h3>Cadouri trimise</h3><div class="big">${r.gifts}</div></div><div class="wcard g1"><h3>Cea mai vorbăreață zi</h3><div class="big">${bestDay ? bestDay[1] : 0}</div><p>${bestDay ? new Date(bestDay[0] + 'T12:00').toLocaleDateString('ro-RO', {day:'numeric', month:'long'}) : ''}</p></div></div>
    ${words.length ? `<div class="wcard g4"><h3>Cuvintele tale</h3><div class="chips">${words.map(w => `<span>${esc(w)}</span>`).join('')}</div>${emo.length ? `<p style="margin-top:10px;font-size:1.5rem">${emo.join(' ')}</p>` : ''}</div>` : ''}
    ${r.moments.length ? `<div class="wcard g6"><h3>Momentele lunii</h3>${r.moments.slice(0, 6).map(x => `<p>• ${esc(x.t)} <span style="opacity:.75">(${esc(x.c.name)})</span></p>`).join('')}</div>` : ''}
    <div class="wcard g1"><h3>Povestea lunii</h3><p id="wStory">${saved ? esc(saved) : 'Lasă-mă să scriu câteva rânduri despre luna ta în Taifas.'}</p><div class="btns" style="margin-top:10px"><button class="btn sm" id="wGen" style="background:#ffffff26;color:#fff">${saved ? '↻ Rescrie' : '✨ Scrie povestea lunii'}</button></div></div>
    <p class="hint" style="text-align:center">Cost estimat în ${esc(moName(mo))}: ${usd(r.cost)}</p>`;
  v.querySelector('#wGen').onclick = async () => {
    const b = v.querySelector('#wGen'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try{
      const facts = `Luna: ${moName(mo)}. Mesaje: ${r.msgs} (${r.mine} ale lui). Zile active: ${r.days.size}, serie maximă ${r.streak} zile. Ora preferată: ${pk}:00. Personaje: ${top.slice(0, 5).map(([c, n]) => c.name + ' (' + n + ' mesaje, ' + relOf(c).name + ')').join(', ')}. Poze primite ${r.pics}, mesaje vocale ${r.voice}, cadouri ${r.gifts}. Cuvinte frecvente: ${words.join(', ')}. Momente: ${r.moments.slice(0, 8).map(x => x.t).join(' | ')}.`;
      const out = await stream('Scrii recapitulări lunare calde și jucăușe, în română corectă, ca Spotify Wrapped.', [{role:'user', text:`${facts}\n\nScrie un paragraf de 4-6 propoziții, la persoana a II-a (către ${S.userName.trim() || 'utilizator'}), cald și cu umor fin, despre luna lui în Taifas. Fără liste, fără titlu.`}], {max:400, aux:true});
      const t = faraLiniute(plain(out)).trim(); if(t){ await DB.set('wrapped:' + mo, t); v.querySelector('#wStory').textContent = t; b.textContent = '↻ Rescrie'; }
    }catch(e){ toast('N-a mers: ' + e.message, 3500); b.textContent = '✨ Scrie povestea lunii'; }
    b.disabled = false;
  };
}
/* ───────── ✨ efecte ───────── */
const fxOn = () => S.fx !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
function fxLayer(){ let l = $('#fx'); if(!l){ l = document.createElement('div'); l.id = 'fx'; document.body.appendChild(l); } return l; }
function fxBurst(e, n = 12){
  if(!fxOn()) return;
  const l = fxLayer();
  for(let i = 0; i < n; i++){
    const p = document.createElement('span'); p.className = 'fxp'; p.textContent = e;
    p.style.left = (10 + Math.random() * 80) + '%'; p.style.fontSize = (18 + Math.random() * 16) + 'px';
    p.style.setProperty('--x', (Math.random() * 80 - 40) + 'px'); p.style.setProperty('--r', (Math.random() * 60 - 30) + 'deg'); p.style.setProperty('--d', (2.2 + Math.random() * 1.4) + 's');
    p.style.animationDelay = (Math.random() * .5) + 's';
    l.appendChild(p); setTimeout(() => p.remove(), 4500);
  }
}
function fxConfetti(n = 70){
  if(!fxOn()) return;
  const l = fxLayer(), col = ['#ff4f9a', '#9b5cff', '#22c3a6', '#ffb020', '#4f8cff', '#ff6b4a', '#ffe66d'];
  for(let i = 0; i < n; i++){
    const p = document.createElement('i'); p.className = 'fxc';
    p.style.left = Math.random() * 100 + '%'; p.style.background = col[i % col.length];
    p.style.setProperty('--x', (Math.random() * 120 - 60) + 'px'); p.style.setProperty('--r', (360 + Math.random() * 720) + 'deg'); p.style.setProperty('--d', (2 + Math.random() * 1.6) + 's');
    p.style.animationDelay = (Math.random() * .6) + 's';
    l.appendChild(p); setTimeout(() => p.remove(), 4800);
  }
}
// vreme în chat, după scenă: ploaie sau zăpadă discretă
function setWeather(scene){
  let w = $('#vChat .wx');
  const t = String(scene || '').toLowerCase();
  const kind = !fxOn() ? '' : /ploai|plou|furtun|burni|rain|storm/.test(t) ? 'rain' : /zăpad|zapad|ninge|ninsoare|snow|viscol/.test(t) ? 'snow' : '';
  if(!kind){ if(w) w.remove(); return; }
  if(w && w.classList.contains(kind)) return;
  if(w) w.remove();
  w = document.createElement('div'); w.className = 'wx ' + kind;
  const n = kind === 'rain' ? 45 : 35;
  for(let i = 0; i < n; i++){
    const d = document.createElement('i'); d.style.left = Math.random() * 110 + '%';
    d.style.setProperty('--d', (kind === 'rain' ? .6 + Math.random() * .6 : 6 + Math.random() * 6) + 's');
    d.style.setProperty('--x', (Math.random() * 60 - 30) + 'px');
    d.style.animationDelay = (-Math.random() * 8) + 's'; d.style.opacity = kind === 'rain' ? .5 : .4 + Math.random() * .5;
    w.appendChild(d);
  }
  $('#vChat').insertBefore(w, $('#chTop'));
}

/* ───────── 🃏 carduri vii ───────── */
function cardStatus(c){
  const parts = [], lf = lifeNow(c);
  if(lf && lf.w) parts.push(LIFE_E[lf.b] + ' ' + lf.w);
  if(c.moodNow && Date.now() - c.moodNow.ts < 12 * 36e5) parts.push(c.moodNow.t);
  return parts.length ? `<span class="cst">${esc(parts.join(' · '))}</span>` : '';
}

/* ───────── 🪄 tranziție: poza de pe card „zboară” în antetul chatului ───────── */
async function openWithFly(o){
  const src = o.querySelector('img');
  const from = src && src.complete && src.naturalWidth ? src.getBoundingClientRect() : null;
  const url = from ? (src.currentSrc || src.src) : '';
  flyNext = !!from && fxOn();
  await openChat(o.dataset.open);
  if(!from || !fxOn()) return;
  const av = $('#chAv'); if(!av) return;
  const to = av.getBoundingClientRect(); if(!to.width) return;
  const f = document.createElement('img'); f.className = 'flyav'; f.src = url;
  Object.assign(f.style, {left:from.left + 'px', top:from.top + 'px', width:from.width + 'px', height:from.height + 'px', borderRadius:'18px'});
  document.body.appendChild(f); av.style.visibility = 'hidden';
  const a = f.animate([{left:from.left + 'px', top:from.top + 'px', width:from.width + 'px', height:from.height + 'px', borderRadius:'18px', opacity:1},
    {left:to.left + 'px', top:to.top + 'px', width:to.width + 'px', height:to.height + 'px', borderRadius:'50%', opacity:1}], {duration:380, easing:'cubic-bezier(.2,.8,.3,1)', fill:'forwards'});
  const end = () => { av.style.visibility = ''; f.remove(); };
  a.onfinish = end; setTimeout(end, 700);
}

/* ───────── 😺 stickere ───────── */
const STK = [['râde', 'laughing out loud, eyes closed with joy'], ['face cu ochiul', 'winking playfully with a cheeky smile'], ['o inimă', 'holding a big red heart, sweet smile'],
  ['doarme', 'sleeping peacefully with a tiny pillow, zzz'], ['surprins', 'surprised, wide eyes, hands on cheeks'], ['îmbufnat', 'pouting, arms crossed, grumpy but cute'],
  ['super', 'giving an enthusiastic thumbs up'], ['salut', 'waving hello happily']];
function drawStk(c){
  const box = $('#pfStk'); if(!box) return;
  const can = !!c.aiPortrait && S.imgProv !== 'none' && c.photo, has = (c.stickers || []).length;
  if(!can && !has){ box.innerHTML = `<p style="color:var(--tx3);font-size:.88rem;margin:0">Disponibile pentru personajele cu portret generat în aplicație: 8 stickere cu fața lui, pe care vi le trimiteți în chat.</p>`; return; }
  box.innerHTML = `${has ? `<div class="stkgrid" style="padding:0 0 10px">${c.stickers.map(x => `<button data-view="${esc(x.k)}"><img data-k="${esc(x.k)}" alt="${esc(x.l)}"></button>`).join('')}</div>` : ''}
    ${can ? `<div class="btns jbtn"><button class="btn sm" id="stkGen">${has ? '✨ Refă stickerele' : '✨ Generează 8 stickere'}</button></div>` : ''}
    <p class="hint" style="margin-top:6px">${has ? `Le trimiți din ＋ în chat; și ${esc(c.name)} trimite câte unul, rar.` : `Generate o singură dată (~${neurPerPhoto() ? Math.round(neurPerPhoto() * 8) + ' neuroni' : 'câțiva cenți'}).`}</p>`;
  hydrate(box);
  box.onclick = e => { const v = e.target.closest('[data-view]'); if(v) viewImg(v.dataset.view, c.stickers.map(x => x.k)); };
  const g = $('#stkGen'); if(g) g.onclick = () => genStickers(c);
}
async function genStickers(c){
  if(busy){ toast('Așteaptă să termine răspunsul.'); return; }
  const b = $('#stkGen'); if(b){ b.disabled = true; b.innerHTML = '<span class="spin"></span> 0/8'; }
  const ref = await DB.get(c.photo); if(!ref){ toast('Nu găsesc poza de profil.'); return; }
  const old = c.stickers || [], out = []; let ok = 0;
  for(const [l, desc] of STK){
    try{
      const prompt = `A cute sticker of the same person as in the reference image (keep the face, hair and identity recognizable), cartoon sticker style with a thick white outline, bust only, ${desc}, plain soft pastel background, centered, no text.`;
      let bl = await genImage(prompt, ref, null, null, {why:'profil'});
      try{ bl = await toJpeg(bl, 512, .88); }catch(e){}
      out.push({l, k:await saveImg(bl)}); ok++;
      addUsage(c.id, imgPrice(), 'img', null, 'profil');
      if(b && document.body.contains(b)) b.innerHTML = `<span class="spin"></span> ${ok}/8`;
    }catch(e){ toast('Un sticker n-a mers: ' + e.message, 3500); if(e.cap) break; }
  }
  if(ok){ for(const x of old) delImg(x.k).catch(() => {}); c.stickers = out; await saveChars(); toast(`😺 ${ok} stickere gata!`); fxBurst('😺', 8); }
  if(profId === c.id) drawStk(c);
}
function stickerSheet(){
  const c = cur;
  if(!(c.stickers || []).length){ toast('Generează întâi stickerele din profilul lui ' + c.name + '.', 3500); charProfile(c.id); return; }
  if(busy && live && live.ch === chat){ toast('Așteaptă răspunsul.'); return; }
  openSheet(`<h4>😺 Stickere</h4><div class="stkgrid">${c.stickers.map((x, k) => `<button data-st="${k}" aria-label="${esc(x.l)}"><img data-k="${esc(x.k)}" alt=""></button>`).join('')}</div>`);
  hydrate($('.sheet'));
  $$('.sheet [data-st]').forEach(b => b.onclick = async () => {
    const x = c.stickers[+b.dataset.st]; closeSheet();
    if(busy){ toast('Așteaptă să termine răspunsul.'); return; }
    chat.msgs.push({id:uid(), role:'user', sticker:{k:x.k, l:x.l}, ts:Date.now()});
    await saveChat(); renderMsgs(true); relBump(c, 1, 'msg');
    await reply();
  });
}

/* ───────── ✍️ îmbunătățește-mi mesajul ───────── */
const POLISH = [['✅', 'Corectează', 'Corectează doar gramatica, punctuația și diacriticele. Nu schimba cuvintele sau tonul.'],
  ['🤗', 'Mai cald', 'Fă-l mai cald și mai afectuos, păstrând ce spun.'], ['😜', 'Mai jucăuș', 'Fă-l mai jucăuș și cu umor, păstrând ce spun.'],
  ['✂️', 'Mai scurt', 'Fă-l mai scurt și mai la obiect.'], ['📝', 'Mai detaliat', 'Dezvoltă-l puțin, cu un detaliu sau o întrebare în plus, păstrând ce spun.']];
function polishSheet(){
  const t = $('#inp').value.trim(); if(!t) return;
  openSheet(`<h4>✨ Îmbunătățește-mi mesajul</h4><div class="fbopts">${POLISH.map((x, k) => `<button data-pl="${k}">${x[0]} ${esc(x[1])}</button>`).join('')}</div><div class="pad" id="plOut"></div>`);
  $$('.sheet [data-pl]').forEach(b => b.onclick = () => runPolish(t, POLISH[+b.dataset.pl]));
}
async function runPolish(t, opt){
  const box = $('#plOut'); if(!box) return;
  box.innerHTML = '<p class="hint"><span class="spin"></span> Rescriu…</p>';
  try{
    const u = S.userName.trim() || 'utilizatorul';
    const out = await stream('Rescrii mesaje de chat în română corectă, cu diacritice. Răspunzi DOAR cu mesajul rescris, fără ghilimele și fără explicații.', [{role:'user', text:
      `Mesajul lui ${u} către ${cur.name}:\n${t}\n\n${opt[2]} Păstrează persoana I, acțiunile dintre *asteriscuri* (rescrise la fel de natural) și sensul. Nu adăuga lucruri pe care el nu le-a spus.`}], {max:400, cid:cur.id, aux:true});
    const r = faraLiniute(String(out).trim().replace(/^["„]|["”]$/g, ''));
    if(!r) throw new Error('n-a ieșit nimic');
    box.innerHTML = `<div class="polres">${esc(r)}</div><div class="btns"><button class="btn" id="plAgain">↻ Altă variantă</button><button class="btn pri" id="plUse">Folosește</button></div>`;
    $('#plUse').onclick = () => { $('#inp').value = r; autoSize(); updateComposer(); closeSheet(); $('#inp').focus(); };
    $('#plAgain').onclick = () => runPolish(t, opt);
  }catch(e){ box.innerHTML = `<p class="hint" style="color:var(--err)">N-a mers: ${esc(e.message)}</p>`; }
}
// alegi una din cele 3 variante; dacă închizi meniul, rămâne prima
function pickVariant(outs, signal){
  return new Promise((res, rej) => {
    const show = t => fmtMsg(stripMood(stripReact(t)).replace(AI_VOICE, '🎙️ '));
    openSheet(`<h4>🎰 Alege varianta care-ți place</h4><div class="vpicks">${outs.map((t, k) => `<button class="vpk" data-vk="${k}"><div class="vh">VARIANTA ${k + 1}<span>Alege ›</span></div>${show(t)}</button>`).join('')}</div>`);
    let done = false;
    const fin = k => { if(done) return; done = true; obs.disconnect(); closeSheet(); res(k); };
    $$('.sheet [data-vk]').forEach(b => b.onclick = () => fin(+b.dataset.vk));
    // meniul închis din afară (atingere pe fundal sau Înapoi): rămâne prima variantă
    const obs = new MutationObserver(() => { if(!$('.sheet [data-vk]')) fin(0); });
    obs.observe(document.body, {childList:true});
    if(signal) signal.addEventListener('abort', () => { if(!done){ done = true; obs.disconnect(); closeSheet(); rej(new DOMException('Oprit', 'AbortError')); } });
  });
}
// 8.17.1: „îți scrie primul” în trepte: 8h → încă 24h → încă 72h fără răspuns de la tine, apoi tace până îi scrii
const PRO_STEPS = [PRO_H, 24, 72];
function proState(ch){
  const ms = (ch && ch.msgs) || [];
  if(!ms.some(m => m.role === 'user')) return null;               // n-ați vorbit niciodată: nu insistă
  const last = ms[ms.length - 1];
  if(!last || last.err || last.pending || last.role === 'user') return null;
  let k = 0;
  for(let i = ms.length - 1; i >= 0 && ms[i].role !== 'user'; i--) if(ms[i].pro && !ms[i].sched) k++;
  if(k >= PRO_STEPS.length) return null;
  return {k, last, due:(last.ts || Date.now()) + PRO_STEPS[k] * 36e5};
}
function proNote(c, st){
  const u = S.userName.trim() || 'utilizatorul', h = (Date.now() - (st.last.ts || Date.now())) / 36e5;
  const ore = h < 48 ? Math.round(h) + ' de ore' : Math.round(h / 24) + ' zile';
  const how = st.k === 0 ? 'ca și cum reiei legătura după pauza asta'
    : st.k === 1 ? `i-ai mai scris o dată și nu ți-a răspuns; scrie-i iar, scurt, în felul tău (poate îți lipsește, poate ești curioasă ce face), fără reproșuri apăsate`
    : `de câteva ori nu ți-a răspuns; trimite-i un ultim mesaj scurt și cald, fără să insiști, lăsând ușa deschisă`;
  return `(Notă de regie, nu o menționa ca atare: au trecut ${ore} de la ultimul mesaj din conversație. Acum e ${new Date().toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'})}. Scrie-i tu primul lui ${u}, natural, ${how}.)`;
}
function maybeProactive(){
  if(S.pro !== 'on' || busy || !aiReady() || !chat.msgs.length) return;
  if((cur.sched || []).some(x => x.at <= Date.now())) return;
  const st = proState(chat);
  if(!st || Date.now() < st.due) return;
  const lf = lifeNow(cur); if(lf && lf.b === 2) return;   // doarme
  reply(null, {pro:true, note:proNote(cur, st)});
}
// 8.17.1: înainte îți scria doar când deschideai chiar conversația ei; acum verifică toate personajele, din fundal
let proRun = false;
async function proSweep(){
  if(proRun || busy || S.pro !== 'on' || !aiReady() || locked) return;
  proRun = true;
  try{
    const cand = chars.filter(c => c.lastAt && Date.now() - c.lastAt < 21 * 864e5).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    let done = 0;
    for(const c of cand){
      if(done >= 2 || busy || document.hidden) break;
      if((c.sched || []).length && c.sched.some(x => x.at <= Date.now() + 30 * 60e3)) continue;   // are deja un mesaj promis
      const lf = lifeNow(c); if(lf && lf.b === 2) continue;
      const tid = c.thread || 'main';
      const open = cur === c && chat && (chat.tid || 'main') === tid;
      const ch = open ? chat : (live && live.c.id === c.id && (live.ch.tid || 'main') === tid) ? live.ch : await loadChat(c, tid);
      const st = proState(ch);
      if(!st || Date.now() < st.due) continue;
      await reply(null, {c, ch, pro:true, note:proNote(c, st)});
      done++;
      if(!$('#vHome').hidden) renderHome();
    }
  }catch(e){} finally { proRun = false; }
}
function newChat(){ return {msgs:[], summary:'', sumUpTo:0}; }
function greetMsg(c){ return {id:uid(), role:'ai', text:c.greet, alts:[c.greet], alt:0, ts:Date.now()}; }

// 8.9: „scrie…” ca bulă vie în conversație
function typingNow(){ return !!(busy && live && cur && chat && live.ch === chat && live.typing !== false && !live.photo && !chat.msgs.some(m => m.pending && m.text && !m.hold)); }
function typingHTML(){
  if(!typingNow()) return '';
  return `<div class="mw typrow"><div class="m ai">${avatarHTML(cur)}<div class="bub tdots${live.rec ? ' rec' : ''}">${live.rec ? '<span class="tmic">🎙️</span><span class="twave">' + '<i></i>'.repeat(5) + '</span>' : '<i></i><i></i><i></i>'}</div></div></div>`;
}
function syncTyping(){
  const box = $('#msgs'); if(!box || $('#vChat').hidden) return;
  const has = box.querySelector('.typrow'), want = typingNow();
  if(want && !has){ const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160; box.insertAdjacentHTML('beforeend', typingHTML()); hydrate(box); if(near) box.scrollTop = box.scrollHeight; }
  else if(!want && has) has.remove();
  else if(want && has && !!has.querySelector('.rec') !== !!live.rec){ has.outerHTML = typingHTML(); hydrate(box); }
}
function msgHTML(m, i, lastAi, anim, g = ''){
  const me = m.role === 'user';
  if(m.pending && (!m.text || m.hold)) return '';            // „scrie…” apare în bara de jos
  const seen = me && (m.seen || chat.msgs.slice(i + 1).some(x => x.role === 'ai' && !x.pending));
  const tm = `<span class="tm">${hhmm(m.ts)}${me ? `<i class="tick${seen ? ' seen' : ''}">${seen ? '✓✓' : '✓'}</i>` : ''}</span>`;
  let inner, cls = me ? 'me' : 'ai';
  if(m.pendingImg){ const stg = live && live.ch === chat && live.stage || {t:'✨ Se pregătește', p:8, pv:0};
    inner = `<div class="picload">${cur.photo ? `<img class="plbg" data-k="${esc(photoNow(cur))}" alt="">` : ''}<div class="plgrain"></div><div class="plin"><span class="shut"><i></i></span><b>${esc(cur.name)} îți face o poză</b><small>${esc(whereIn(chat.where) || 'se aranjează…')}</small><span class="plst">${esc(stg.t)}</span><span class="plbar"><i style="width:${stg.pv || 0}%"></i></span><span class="plpct">${Math.floor(stg.pv || 0)}%</span></div></div>`; cls += ' picm'; }
  else if(m.err) inner = `<div class="bub err${m.errKind === 'flag' ? ' flag' : ''}">${m.errKind === 'flag' ? '🚫' : '⚠️'} ${esc(m.err)}</div>`;
  else if(m.img && !me){
    cls += ' picm';
    const fresh = !devDone.has(m.img) && m.ts && Date.now() - m.ts < 3 * 60e3;   // poza abia sosită „se developează”
    const loc = whereIn(m.where);
    inner = `<div class="picbox${fresh ? ' flash' : ''}"><img class="pic big${fresh ? ' dev' : ''}" data-k="${esc(m.img)}" data-view="${esc(m.img)}" alt="">${loc ? `<span class="ploc">📍 ${esc(loc)}</span>` : ''}${tm}${reactHTML(m)}</div>${m.text ? `<div class="bub">${fmtMsg(m.text)}</div>` : ''}`;
    if(fresh) devDone.add(m.img);
  }
  else if(m.img) inner = `<div class="bub picwrap">${quoteHTML(m)}<img class="pic" data-k="${esc(m.img)}" data-view="${esc(m.img)}" alt="">${m.text ? `<div class="cap">${fmtMsg(m.text)}</div>` : ''}${tm}${reactHTML(m)}</div>`;
  else if(m.voice && !m.pending) inner = `<div class="bub">${voiceHTML(m)}${tm}${reactHTML(m)}</div>`;
  else if(m.sticker) inner = `<div class="stk"><img data-k="${esc(m.sticker.k)}" data-view="${esc(m.sticker.k)}" alt="${esc(m.sticker.l)}">${tm}${reactHTML(m)}</div>`;
  else if(m.gift) inner = `<div class="bub gift"><span class="ge">${esc(m.gift.e)}</span><span class="gn">🎁 ${esc(m.gift.n)}</span>${m.text ? `<span class="gt">${esc(m.text)}</span>` : ''}${tm}${reactHTML(m)}</div>`;
  else inner = `<div class="bub${m.pending ? ' typing' : ''}${!m.pending && !m.reply && isJumbo(m.text) ? ' jumbo' : ''}">${quoteHTML(m)}${fmtMsg(m.pending ? typedText(m) : m.text)}${m.pending ? '' : tm}${reactHTML(m)}</div>`;
  let under = '', lx = '';
  // 8.15: învață o limbă: corecturile și traducerea, sub mesajul ei
  if(!me && m.corr && m.corr.length) lx += `<div class="corr">${m.corr.map(x => { const [w, why] = x.split('|'); const [bad, good] = (w || '').split(/→|->/); return `<div>✏️ ${good ? `<s>${esc(bad.trim())}</s> → <b>${esc(good.trim())}</b>` : esc(w)}${why ? `<small>${esc(why.trim())}</small>` : ''}</div>`; }).join('')}</div>`;
  if(!me && m.tr && m.trOn && (!m.trFor || m.trFor === m.text)) lx += `<div class="trbox">🔤 ${esc(m.tr)}</div>`;

  if(!me && i !== lastAi && m.img && !m.pendingImg && m.imgAlts && m.imgAlts.length > 1)
    under = `<div class="under"><button data-ia="-1" ${m.ia <= 0 ? 'disabled' : ''}>‹</button><span>${m.ia + 1}/${m.imgAlts.length}</span><button data-ia="1" ${m.ia >= m.imgAlts.length - 1 ? 'disabled' : ''}>›</button></div>`;
  if(!me && i === lastAi && !m.pending && !m.pendingImg){
    const n = m.alts?.length || 1;
    under = `<div class="under last">
      ${n > 1 ? `<button data-alt="-1" ${m.alt <= 0 ? 'disabled' : ''}>‹</button><span>${(m.alt || 0) + 1}/${n}</span><button data-alt="1" ${m.alt >= n - 1 ? 'disabled' : ''}>›</button>` : ''}
      ${m.img && m.imgAlts && m.imgAlts.length > 1 ? `<button data-ia="-1" ${m.ia <= 0 ? 'disabled' : ''}>‹</button><span>${m.ia + 1}/${m.imgAlts.length}</span><button data-ia="1" ${m.ia >= m.imgAlts.length - 1 ? 'disabled' : ''}>›</button>` : ''}
      ${m.img && !m.err ? `<button data-rephoto>🎲 Altă poză</button>` : ''}
      ${m.img || !m.alts ? '' : `<button data-regen>↻ Altul</button>${S.regen3 === 'on' && n > 1 && !m.err ? '<button data-more3>🎰 +2</button>' : ''}`}
      ${m.cut ? `<span class="cutn">${m.cut === 'refusal' ? '⚠️ întrerupt de furnizor' : m.cut === 'len' ? '✂️ prea lung, tăiat' : '📶 conexiune întreruptă'}</span>` : ''}
      ${m.err ? '' : `<button data-cont>▶ Continuă</button>`}
      ${m.err ? `<button data-retry>${m.errKind === 'flag' ? '🎲 Încearcă altă scenă' : 'Reîncearcă'}</button>` : ''}
      ${S.voice !== 'off' && m.text && !m.err ? `<button data-say class="ico" aria-label="Ascultă">🔊</button>` : ''}
      ${learnOn(cur) && m.text && !m.err ? `<button data-tr class="ico" aria-label="Traducere">🔤</button>` : ''}
      ${m.text && !m.err ? `<button class="rate${m.rate === 1 ? ' on' : ''}" data-rate="1" aria-label="Bun">👍</button><button class="rate${m.rate === -1 ? ' on' : ''}" data-rate="-1" aria-label="Nu prea">👎</button>` : ''}</div>`;
  }
  if(me && m.seenAt && seen && !chat.msgs.slice(i + 1).some(x => x.role === 'user')){
    const d = new Date(m.seenAt), today = dayKey(m.seenAt) === dayKey(Date.now());
    under += `<div class="seenl">Văzut ${today ? '' : dayKey(m.seenAt) === dayKey(Date.now() - 864e5) ? 'ieri ' : d.toLocaleDateString('ro-RO', {day:'numeric', month:'short'}) + ' '}la ${hhmm(m.seenAt)}</div>`;
  }
  return `<div class="mw${anim ? ' anim' : ''}${m.react ? ' hasreact' : ''}${g}" data-i="${i}"><div class="m ${cls}">${me ? '' : g.includes('gn') ? '<span class="av ghost"></span>' : avatarHTML(cur)}${inner}</div>${lx}${under}</div>`;
}
const REACTS = ['❤️', '😂', '😮', '😢', '👍', '🔥'];
const AI_REACT = /^\s*\[(❤️|❤|😂|😮|😢|👍|🔥|🥰)\]\s*/u;
const AI_VOICE = /^\s*\[vocal\]\s*/i;
const stripReact = t => String(t || '').replace(AI_REACT, '').replace(AI_VOICE, '').replace(AI_REACT, '');
const reactHTML = m => m.react ? `<span class="react">${m.react}</span>` : '';
function quoteHTML(m){
  if(!m.reply) return '';
  return `<button class="quote${m.reply.img ? ' qimg' : ''}" data-q="${esc(m.reply.id)}">${m.reply.img ? `<img data-k="${esc(m.reply.img)}" alt="">` : ''}<b>${esc(m.reply.name)}</b><span>${esc(m.reply.text)}</span></button>`;
}
function plain(t){ return String(t || '').replace(/\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim(); }
function reactPicker(i){
  const m = chat.msgs[i]; if(!m || m.pending || m.pendingImg || m.err) return;
  const el = $(`#msgs .mw[data-i="${i}"] .bub, #msgs .mw[data-i="${i}"] .picbox`); if(!el) return;
  closeReactPicker();
  const r = el.getBoundingClientRect();
  const sc = document.createElement('div'); sc.className = 'rscrim'; sc.onclick = closeReactPicker;
  const pk = document.createElement('div'); pk.className = 'rpick';
  pk.innerHTML = REACTS.map(e => `<button class="${m.react === e ? 'on' : ''}" data-e="${e}">${e}</button>`).join('');
  document.body.append(sc, pk);
  const w = pk.offsetWidth, top = r.top - pk.offsetHeight - 8;
  pk.style.top = Math.max(8, top < 60 ? r.bottom + 8 : top) + 'px';
  pk.style.left = Math.max(8, Math.min(innerWidth - w - 8, (m.role === 'user' ? r.right - w : r.left))) + 'px';
  pk.onclick = async e => {
    const b = e.target.closest('[data-e]'); if(!b) return;
    m.react = m.react === b.dataset.e ? '' : b.dataset.e;
    if(!m.react) delete m.react;
    closeReactPicker(); await saveChat(); renderMsgs();
    if(['❤️', '🥰', '🔥'].includes(m.react)) fxBurst(m.react, 10);
    if(navigator.vibrate) try{ navigator.vibrate(8); }catch(_){}
  };
}
function closeReactPicker(){ $$('.rpick,.rscrim').forEach(x => x.remove()); }
let replyTo = null;
function setReply(i){
  const m = chat.msgs[i]; if(!m || m.pending || m.pendingImg || m.err) return;
  const name = m.role === 'user' ? (S.userName.trim() || 'Tu') : cur.name;
  replyTo = {id:m.id, name, text: (m.img && !m.text ? '📷 Poză' : plain(m.text)).slice(0, 140)};
  $('#rbName').textContent = '↩ Răspunzi ' + (m.role === 'user' ? 'la mesajul tău' : 'lui ' + name);
  $('#rbTxt').textContent = replyTo.text;
  $('#replyBar').hidden = false;
  $('#inp').focus();
  if(navigator.vibrate) try{ navigator.vibrate(8); }catch(_){}
}
function clearReply(){ replyTo = null; $('#replyBar').hidden = true; }
// dispoziția: personajul o scrie la finalul răspunsului ca [stare: …]; o păstrăm pe conversație și o ascundem din text
const MOOD_RE = /\s*\[stare:\s*([^\]\n]{1,40})\]/gi;
const PLOT_RE = /\s*\[acum:\s*([^\]\n]{3,200})\]/gi;
const VERD_RE = /\s*\[r[ăa]spuns:\s*(da|poate|nu)\s*\]/gi;   // 7.9: răspunsul la „📣 Întreabă-le pe toate”   // 7.6: scena în desfășurare, scrisă de personaj
const SCHED_RE = /\s*\[programez:\s*([^\]\n]{3,160})\]/gi;
const SUN_RE = /\s*\[sun(?::\s*(video|voce|vocal|telefon))?\s*\]/gi;   // 8.18: „te sun acum” → chiar te sună
const STK_RE = /\s*\[sticker:\s*([^\]\n]{2,40})\]/gi;
const SHOT_RE = /\s*\[poz[ăa]:\s*([^\]]{8,2000})\]/gi;
const SHOT_OPEN = /\s*\[poz[ăa]:[^\]]*$/i;   // etichetă începută, încă neînchisă (în timpul scrierii) sau tăiată
const CORR_RE_S = /\s*\[corectur[ăa]:\s*[^\]\n]{3,300}\]/gi;
const stripMood = t => String(t || '').replace(/\s*\[fa[țt][ăa]:\s*[^\]\n]{1,20}\]\s*/gi, ' ').replace(MOOD_RE, '').replace(PLOT_RE, '').replace(VERD_RE, '').replace(/\s*\[acum:[^\]]*$/i, '').replace(SCHED_RE, '').replace(SUN_RE, '').replace(/\s*\[sun(:[^\]\n]*)?$/i, '').replace(SHOT_RE, '').replace(SHOT_OPEN, '').replace(STK_RE, '')
  .replace(CORR_RE_S, '').replace(/\s*\[c(o(r(e(c(t(u(r([aă](:[^\]\n]*)?)?)?)?)?)?)?)?)?$/i, '').replace(/\s*\[s(t(a(r(e(:[^\]\n]*)?)?)?)?)?$/i, '').replace(/\s*\[p(r(o(g(r(a(m(e(z(:[^\]\n]*)?)?)?)?)?)?)?)?)?$/i, '').replace(/\s*\[p(o(z([ăa](:[^\]\n]*)?)?)?)?$/i, '').replace(/\s*\[s(t(i(c(k(e(r(:[^\]\n]*)?)?)?)?)?)?)?$/i, '').trimEnd();
// starea din antet: online / ultima dată + dispoziția (scrisă de personaj sau dedusă din ultimul răspuns)
const MOODS = [
  [/\b(râde|chicotește|hohot)/i, '😂', 'haz'],
  [/\b(zâmbe|vesel|bucur|entuziasm|încântat)/i, '😊', 'voie bună'],
  [/\b(roșe|timid|emoționat|fluturi)/i, '😳', 'emoție'],
  [/\b(oftează|trist|lacrim|plânge|melancol)/i, '😢', 'tristețe'],
  [/\b(căscă|obosit|somnoros|adoarme|somn)/i, '😴', 'somn'],
  [/\b(încruntă|supărat|nervos|enervat|furios)/i, '😠', 'supărare'],
  [/\b(gânde|meditează|reflectează|pensiv)/i, '🤔', 'gânduri'],
  [/\b(surprins|tresare|ochii mari|uimit)/i, '😮', 'uimire'],
  [/\b(îmbrățișe|tandru|drag|dor)/i, '🥰', 'tandrețe']
];
/* relația evoluează: puncte din mesaje (max 40/zi), zile în care vorbiți și 👍 */
const RELS = [
  [0, 'Abia v-ați cunoscut', 'vă cunoașteți de puțin: prietenos și curios, încă puțin rezervat; pui întrebări ca să-l cunoști'],
  [40, 'Cunoștințe', 'v-ați mai povestit: mai relaxat, glume ușoare, îți amintești ce ți-a spus'],
  [150, 'Prieteni', 'vă simțiți bine împreună: familiar, glume doar ale voastre, referințe la ce ați vorbit'],
  [400, 'Apropiați', 'aveți încredere unul în altul: deschis, îți împărtășești gândurile și grijile'],
  [900, 'Foarte apropiați', 'vă cunoașteți foarte bine: îi ghicești stările, aveți o istorie comună bogată'],
  [1800, 'De nedespărțit', 'o legătură veche și profundă: complicitate totală, totul vine de la sine']
];
function relOf(c){
  const p = (c.rel && c.rel.p) || 0; let k = 0;
  RELS.forEach((r, i) => { if(p >= r[0]) k = i; });
  const next = RELS[k + 1];
  return {lv:k + 1, name:RELS[k][1], how:RELS[k][2], p, pc: next ? Math.round((p - RELS[k][0]) / (next[0] - RELS[k][0]) * 100) : 100, next: next ? next[1] : null};
}
async function relInit(c){
  if(c.rel) return;
  const msgs = (await allChats(c)).flatMap(ch => ch.msgs).filter(m => m.role === 'user' && !m.err);
  const days = new Set(msgs.map(m => m.ts && dayKey(m.ts)).filter(Boolean));
  const perDay = {}; msgs.forEach(m => { const d = m.ts ? dayKey(m.ts) : '-'; perDay[d] = (perDay[d] || 0) + 1; });
  c.rel = {p: Object.values(perDay).reduce((s, n) => s + Math.min(40, n), 0) + days.size * 5, day: dayKey(Date.now()), dp: 0};
  await saveChars();
}
async function relBump(c, n, kind){
  if(!c.rel) await relInit(c);
  if(c.rel.lock) return;                              // nivel fixat de tine: nu se mai schimbă singur
  const before = relOf(c).lv, today = dayKey(Date.now());
  if(c.rel.day !== today){ c.rel.day = today; c.rel.dp = 0; c.rel.p += 5; }
  if(kind === 'msg'){ if(c.rel.dp >= 40) n = 0; c.rel.dp += n; }
  c.rel.p += n;
  await saveChars();
  const r = relOf(c);
  if(r.lv > before){ addMoment(c, `Relația voastră a devenit: ${r.name}`, 'level'); fxConfetti(); toast(`💞 Tu și ${c.name}: ${r.name}`, 3500); if(navigator.vibrate) try{ navigator.vibrate([10, 60, 10]); }catch(e){} }
}
// alegi tu nivelul: pornește de acolo și crește în continuare, sau rămâne fixat
function relSheet(c, done){
  const r = relOf(c), locked = !!(c.rel && c.rel.lock);
  openSheet(`<h4>💞 Relația cu ${esc(c.name)}</h4><div class="vlist">${RELS.map((x, k) => `<div class="vrow${k + 1 === r.lv ? ' on' : ''}" data-rl="${k}"><div style="flex:1"><b>${k + 1}. ${esc(x[1])}</b><br><small>${esc(x[2])}</small></div>${k + 1 === r.lv ? '✓' : ''}</div>`).join('')}</div>
    <div class="pad"><label class="chk"><input type="checkbox" id="relLock" ${locked ? 'checked' : ''}> 🔒 Fixează nivelul (nu mai crește singur)</label></div>`);
  $('#relLock').onchange = async e => { await relInit(c); c.rel.lock = e.target.checked; await saveChars(); toast(c.rel.lock ? '🔒 Nivel fixat' : '📈 Relația crește din nou singură'); done(); };
  $$('.sheet [data-rl]').forEach(b => b.onclick = async () => {
    await relInit(c); const k = +b.dataset.rl;
    c.rel.p = RELS[k][0]; c.rel.lock = $('#relLock').checked; await saveChars();
    closeSheet(); toast(`💞 Tu și ${c.name}: ${RELS[k][1]}`); done();
  });
}
/* 👍 / 👎 care învață */
const FB = [
  ['Prea lung', 'Răspunsuri mai scurte, la obiect', 'len'], ['Prea scurt', 'Răspunsuri mai dezvoltate', 'len'],
  ['Prea formal', 'Ton mai relaxat și familiar'], ['Repetitiv', 'Nu te repeta; vino mereu cu ceva nou'],
  ['Previzibil', 'Fii mai spontan și surprinzător'], ['Iese din personaj', 'Rămâi strict în personaj, cu felul tău de a fi'],
  ['Prea multe acțiuni', 'Mai puține *acțiuni*, mai mult dialog', 'act'], ['Prea puține acțiuni', 'Mai multe gesturi și detalii de scenă', 'act'],
  ['Prea multe întrebări', 'Nu încheia fiecare mesaj cu o întrebare']
];
async function rateMsg(i, v){
  const m = chat.msgs[i], c = cur; if(!m) return;
  if(v === 1){
    if(m.rate === 1){ delete m.rate; c.liked = (c.liked || []).filter(x => x !== plainLike(m.text)); }
    else { m.rate = 1; const t = plainLike(m.text); if(t.length >= 15){ c.liked = [t].concat((c.liked || []).filter(x => x !== t)).slice(0, 3); } relBump(c, 3); toast('👍 Notat. ' + c.name + ' ține minte stilul ăsta.'); }
    await saveChars(); await saveChat(); renderMsgs(); return;
  }
  openSheet(`<h4>Ce n-a mers la răspunsul ăsta?</h4><div class="fbopts">${FB.map((f, k) => `<button data-fb="${k}">${esc(f[0])}</button>`).join('')}</div>
    <div class="pad"><input id="fbTxt" placeholder="Altceva… (ex: să nu-mi spună „dragule”)"><div class="btns" style="margin-top:10px"><button class="btn pri" id="fbOk">Reține</button></div></div>`);
  const save = async (t, grp) => {
    t = t.trim(); if(!t) return;
    c.prefs = (c.prefs || []).filter(x => x.t !== t && !(grp && x.g === grp));    // opusul („prea lung” / „prea scurt”) se înlocuiește
    c.prefs.unshift({t, g:grp || '', ts:Date.now()}); c.prefs = c.prefs.slice(0, 8);
    m.rate = -1; await saveChars(); await saveChat(); closeSheet(); renderMsgs();
    openSheet(`<h4>Reținut ✓ ${esc(c.name)} va ține cont de asta.</h4><div class="pad btns"><button class="btn" data-close>Bine</button><button class="btn pri" id="fbRe">↻ Rescrie răspunsul acum</button></div>`);
    $('#fbRe').onclick = () => { closeSheet(); if(!busy && chat.msgs[i] === m) reply(m, {fix:t}); };
  };
  $$('.fbopts [data-fb]').forEach(b => b.onclick = () => { const f = FB[+b.dataset.fb]; save(f[1], f[2]); });
  $('#fbOk').onclick = () => save($('#fbTxt').value);
}
const plainLike = t => plain(stripMood(t || '')).replace(/\s+/g, ' ').trim().slice(0, 280);
function moodOf(){
  if(chat.mood && chat.mood.t) return chat.mood.t;
  const last = [...chat.msgs].reverse().find(m => m.role === 'ai' && m.text && !m.err);
  if(!last) return null;
  const acts = (last.text.match(/\*[^*]+\*/g) || []).join(' ') || last.text;
  for(const [re, e, n] of MOODS) if(re.test(acts)) return e + ' ' + n;
  return null;
}
// starea din antet, pe două rânduri scurte: 1) prezență + ce face acum  2) dispoziție, mesaj programat, fir
const shortMood = t => { const x = String(t || '').trim(); const m = x.match(/^(\p{Extended_Pictographic}️?\s*)?(.*)$/u); let w = (m[2] || '').split(/[,;.]/)[0].trim().split(/\s+/).slice(0, 2).join(' ').replace(/\s+(și|si|cu|de|la|în|in|dar|pe|a|un|o)$/i, ''); return ((m[1] || '') + w).trim(); };
function statusLine(){
  const last = [...chat.msgs].reverse().find(m => m.ts && !m.err);
  const ago = last ? Date.now() - last.ts : Infinity;
  let st;
  if(ago < 10 * 60e3) st = '<span class="dot"></span>online';
  else {
    const min = Math.round(ago / 60e3), h = Math.round(min / 60), d = Math.round(h / 24);
    st = '<span class="dot off"></span>' + (min < 60 ? `acum ${min} min` : h < 24 ? `acum ${h} h` : d === 1 ? 'ieri' : `acum ${d} zile`);
  }
  const lf = lifeNow(cur); if(lf && lf.w) st += ' · ' + (LIFE_E[lf.b] || '') + ' ' + esc(lf.w);
  const mood = moodOf();
  const ts = threadsOf(cur), t = ts.length > 1 ? ts.find(x => x.id === (cur.thread || 'main')) : null;
  const nx = (cur.sched || []).find(x => x.tid === (chat.tid || 'main') && x.at > Date.now());
  let pl = chat.plot && Date.now() - (chat.plot.ts || 0) < 12 * 36e5 ? chat.plot.t.split('›')[0].trim() : '';
  const norm = x => String(x || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if(pl && lf && lf.w && (norm(pl).includes(norm(lf.w)) || norm(lf.w).includes(norm(pl)))) pl = '';   // 8.9.2: fără dubluri (programul = scena)
  if(/^discuție liberă$/i.test(pl)) pl = '';
  const tz = Math.abs(charShift(cur)) >= 36e5 ? '🕘 ' + hhmm(charNow(cur).getTime()) + ' la ' + (genderOf(cur) === 'f' ? 'ea' : genderOf(cur) === 'm' ? 'el' : 'el/ea') : '';
  const l2 = [learnOn(cur) ? '🌍 ' + LANGS[cur.learn.lang][0] : '', tz, pl ? '🎬 ' + esc(pl) : '', mood ? esc(shortMood(mood)) : '', nx ? '⏰ ' + esc(whenText(nx.at)) : '', t ? '🧵 ' + esc(t.title) : ''].filter(Boolean).join(' · ');
  return `<span class="s1">${st}</span>${l2 ? `<span class="s2">${l2}</span>` : ''}`;
}
// buton „jos" + contor de mesaje noi
let jumpCount = 0;
// 9.4: câte mesaje sunt în pagină. Înainte se construia tot istoricul (sute de bule, fiecare cu blur) la fiecare schimbare.
const MSG_WIN = 60, MSG_MORE = 60;
let msgStart = 0, msgFor = null, moreObs = null, moreBusy = false;
function resetMsgWin(){ msgFor = chat; msgStart = Math.max(0, (chat ? chat.msgs.length : 0) - MSG_WIN); }
function loadEarlier(){
  if(moreBusy || !chat || msgStart <= 0) return;
  moreBusy = true;
  const box = $('#msgs'), h0 = box.scrollHeight, t0 = box.scrollTop;
  msgStart = Math.max(0, msgStart - MSG_MORE);
  renderMsgs(false, true);
  box.scrollTop = t0 + (box.scrollHeight - h0);   // rămâi la același mesaj
  setTimeout(() => { moreBusy = false; }, 120);
}
function updateJump(){
  const box = $('#msgs'), far = box.scrollHeight - box.scrollTop - box.clientHeight > 320;
  if(!far) jumpCount = 0;
  $('#jumpDown').hidden = !far;
  $('#jumpN').hidden = !jumpCount; $('#jumpN').textContent = jumpCount > 9 ? '9+' : jumpCount;
}
/* ───────── 4.1: voce umană ─────────
   motor: tel (vocea telefonului) · el (ElevenLabs direct) · fal (ElevenLabs v3 prin fal.ai)
   înregistrarea se face o singură dată, se păstrează în IndexedDB (aud:<id>:<alt>) și se reascultă gratuit */
const TTS_PRICE = {eleven_v3:.08, eleven_v4_turbo:.04, eleven_multilingual_v2:.08, fal:.10};   // $ la 1000 de caractere
// vocile de bază ElevenLabs (merg și prin fal.ai după nume); lista completă din contul tău se încarcă la „Schimbă”
const EL_BASE = [
  ['EXAVITQu4vr4xnSDxMaL', 'Sarah', 'f', 'tânără, caldă'], ['FGY2WhTYpPnrIDTdsKH5', 'Laura', 'f', 'tânără, vioaie'],
  ['XB0fDUnXU5powFXDhCwa', 'Charlotte', 'f', 'catifelată'], ['Xb7hH8MSUJpSbSDYk0k2', 'Alice', 'f', 'clară, sigură'],
  ['XrExE9yKIg1WjnnlVkGX', 'Matilda', 'f', 'prietenoasă'], ['cgSgspJ2msm6clMCkdW9', 'Jessica', 'f', 'jucăușă'],
  ['pFZP5JQG7iQjIQuC4Bku', 'Lily', 'f', 'blândă'], ['9BWtsMINqrJLrRacOk9x', 'Aria', 'f', 'matură, expresivă'],
  ['SAz9YHcvj6GT2YYXdXww', 'River', 'n', 'neutră, relaxată'],
  ['CwhRBWXzGAHq8TQ4Fs17', 'Roger', 'm', 'relaxat'], ['IKne3meq5aSn9XLyUdCD', 'Charlie', 'm', 'tânăr, natural'],
  ['JBFqnCBsd6RMkjVDRZzb', 'George', 'm', 'cald, matur'], ['N2lVS1w4EtoT3dr4eOWO', 'Callum', 'm', 'răgușit'],
  ['TX3LPaxmHKxFdv7VOQHJ', 'Liam', 'm', 'tânăr, energic'], ['bIHbv24MWmeRgasZH58o', 'Will', 'm', 'prietenos'],
  ['cjVigY5qzO86Huf0OWal', 'Eric', 'm', 'calm'], ['iP95p4xoKVk53GoZ742B', 'Chris', 'm', 'degajat'],
  ['nPczCjzI2devNBz1zQrb', 'Brian', 'm', 'grav'], ['onwK4e9ZLuTAKqWW03F9', 'Daniel', 'm', 'autoritar'], ['pqHfZKP75CvOlQylNhV4', 'Bill', 'm', 'bătrân, sfătos']
].map(([id, name, g, d]) => ({id, name, g, d}));
// etichetele din text: scrise în română de personaj, traduse pentru modelul de voce
const VTAGS = {'râde':'laughs', 'rade':'laughs', 'chicotește':'giggles', 'chicoteste':'giggles', 'oftează':'sighs', 'ofteaza':'sighs', 'șoptește':'whispers', 'soptește':'whispers', 'soapta':'whispers'};
const VTAG_RE = /\[([^\]\n]{2,24})\]/g;
function ttsText(t, neural){
  return String(t || '').replace(/\*[^*]*\*/g, ' ').replace(VTAG_RE, (all, w) => { const k = VTAGS[w.trim().toLowerCase()]; return neural && k ? ' [' + k + '] ' : ' '; })
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s{2,}/g, ' ').trim();
}
const vtagHTML = t => esc(t).replace(VTAG_RE, (all, w) => VTAGS[w.trim().toLowerCase()] ? `<span class="vtag">(${esc(w.trim())})</span>` : all);
function genderOf(c){
  const t = ((c.look || '') + ' ' + (c.aspect || '')).toLowerCase();
  if(/\b(woman|girl|female|lady)\b|femeie|fată|tânără|doamnă/.test(t)) return 'f';
  if(/\b(man|boy|male|guy)\b|bărbat|barbat|băiat|baiat|domn/.test(t)) return 'm';
  return '';
}
function hashPick(list, seed){ let h = 0; for(const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return list[h % list.length]; }
function defaultVoice(c){
  const g = genderOf(c), pool = EL_BASE.filter(v => g ? v.g === g : v.g !== 'n');
  return hashPick(pool.length ? pool : EL_BASE, c.id);
}
function voiceOf(c){ return c.voice && c.voice.id ? c.voice : defaultVoice(c); }
function voiceLabel(c){
  if(S.tts === 'tel') return 'Vocea telefonului' + (c.vPitch && c.vPitch !== 1 ? (c.vPitch < 1 ? ' · mai gravă' : ' · mai subțire') : '');
  const v = voiceOf(c); return v.name + (c.voice ? '' : ' (aleasă automat)') + ' · ' + (S.tts === 'el' ? 'ElevenLabs' : 'fal.ai');
}
const ttsKey = m => 'aud:' + m.id + ':' + (m.alt || 0);

async function ttsBlob(c, text, signal){
  const v = voiceOf(c);
  if(S.tts === 'el'){
    if(!hasKey('eleven')) throw new Error('lipsește cheia ElevenLabs (Setări → Răspunsuri și voce).');
    const call = async (model, vs) => {
      let r;
      try{ r = await fetch(apiUrl('eleven', `/v1/text-to-speech/${encodeURIComponent(v.id)}?output_format=mp3_44100_64`), {method:'POST', signal,
        headers:apiHeaders('eleven', {'content-type':'application/json', accept:'audio/mpeg'}),
        body:JSON.stringify(vs ? {text, model_id:model, voice_settings:vs} : {text, model_id:model})}); }
      catch(e){ if(e.name === 'AbortError') throw e; throw new Error('nu pot ajunge la ElevenLabs (internet?).'); }
      if(r.ok) return {blob:await r.blob(), model};
      const j = await r.json().catch(() => ({})), msg = JSON.stringify(j.detail || j).slice(0, 160);
      if(r.status === 401) throw new Error(/quota|credits/i.test(msg) ? 'ai terminat caracterele lunii pe ElevenLabs.' : 'cheia ElevenLabs nu e bună.');
      if(/quota|credits/i.test(msg)) throw new Error('ai terminat caracterele lunii pe ElevenLabs.');
      if(r.status === 404 && /voice/i.test(msg)) throw new Error('vocea aleasă nu mai există. Alege alta din profilul personajului.');
      const e = new Error('ElevenLabs ' + r.status + ': ' + msg); e.st = r.status; throw e;
    };
    const model = S.elModel || 'eleven_v3';
    try{ return await call(model, {stability:.5, similarity_boost:.75}); }
    catch(e){
      if(!e.st) throw e;
      try{ return await call(model); }                                    // setări de voce nepermise de model
      catch(e2){ if(!e2.st || model === 'eleven_multilingual_v2') throw e2; return await call('eleven_multilingual_v2', {stability:.45, similarity_boost:.75, style:.3}); }
    }
  }
  if(S.tts === 'fal'){
    if(!hasKey('fal')) throw new Error('lipsește cheia fal.ai (Setări → Răspunsuri și voce).');
    let r;
    try{ r = await fetch(apiUrl('fal', '/fal-ai/elevenlabs/tts/eleven-v3'), {method:'POST', signal, headers:apiHeaders('fal', {'content-type':'application/json'}),
      body:JSON.stringify({text, voice:v.name, stability:.5})}); }
    catch(e){ if(e.name === 'AbortError') throw e; throw new Error('nu pot ajunge la fal.ai (internet?).'); }
    const j = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'cheia fal.ai nu e bună.' : 'fal.ai ' + r.status + ': ' + JSON.stringify(j.detail || j).slice(0, 160));
    const url = j.audio && j.audio.url; if(!url) throw new Error('fal.ai n-a trimis sunetul.');
    return {blob:await (await fetch(url, {signal})).blob(), model:'fal'};
  }
  throw new Error('vocea telefonului nu înregistrează.');
}
// durata reală și unda reală, din sunet
async function analyzeAudio(blob){
  try{
    const AC = window.AudioContext || window.webkitAudioContext, ac = new AC();
    const buf = await ac.decodeAudioData(await blob.arrayBuffer()); try{ ac.close(); }catch(e){}
    const d = buf.getChannelData(0), n = 28, step = Math.max(1, Math.floor(d.length / n)), pk = [];
    for(let i = 0; i < n; i++){ let s = 0, c = 0; for(let j = i * step; j < (i + 1) * step && j < d.length; j += 32){ s += d[j] * d[j]; c++; } pk.push(Math.sqrt(s / Math.max(1, c))); }
    const mx = Math.max(...pk) || 1;
    return {d:Math.max(1, Math.round(buf.duration)), w:pk.map(p => Math.round(12 + 88 * p / mx))};
  }catch(e){ return null; }
}
async function recordVoice(c, m, signal){
  const text = ttsText(m.text, true); if(!text) return null;
  const {blob, model} = await ttsBlob(c, text, signal);
  await DB.set(ttsKey(m), blob);
  const a = await analyzeAudio(blob);
  m.vmeta = m.vmeta || {}; m.vmeta[m.alt || 0] = a || {d:voiceDur(m.text)};
  addUsage(c.id, text.length / 1000 * (TTS_PRICE[model] || .1), 'voc');
  return blob;
}

// mesaj vocal: undă reală dacă există înregistrare, altfel stabilă (din id)
function voiceDur(t){ return Math.max(2, Math.round(String(t).split(/\s+/).length / 2.6)); }
const fmtDur = d => Math.floor(d / 60) + ':' + String(Math.round(d % 60)).padStart(2, '0');
function voiceHTML(m){
  const meta = m.vmeta && m.vmeta[m.alt || 0];
  let h = 0; for(const ch of m.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bars = Array.from({length:28}, (_, k) => {
    let v; if(meta && meta.w) v = meta.w[k]; else { h = (h * 1103515245 + 12345) >>> 0; v = Math.round((25 + (h % 70)) * (k < 3 || k > 24 ? .6 : 1)); }
    return `<i style="height:${v}%"></i>`; }).join('');
  const d = meta ? meta.d : voiceDur(m.text);
  return `<div class="vmsg" data-vm="${esc(m.id)}"><button class="vplay" data-vplay aria-label="Ascultă">▶</button><div class="wave">${bars}</div><span class="dur">${fmtDur(d)}</span></div>
    <button class="vtr" data-vtr>Transcriere</button><div class="vtxt" hidden>${vtagHTML(m.text)}</div>`;
}
let vPlaying = null, vAudio = null;
function stopAllVoice(){ try{ speechSynthesis.cancel(); }catch(e){} if(vAudio){ vAudio.pause(); vAudio = null; } if(vPlaying && vPlaying._stop) vPlaying._stop(); vPlaying = null; }
function phoneVoice(lang = 'ro-RO'){
  const vs = (window.speechSynthesis ? speechSynthesis.getVoices() : []).filter(x => x.lang && x.lang.slice(0, 2).toLowerCase() === lang.slice(0, 2).toLowerCase());
  return vs.find(x => /natural|neural|online|enhanced|premium/i.test(x.name)) || vs.find(x => /google/i.test(x.name)) || vs[0] || null;
}
function speakPhone(c, text, onEnd){
  if(!('speechSynthesis' in window)){ toast('Telefonul nu are voce pentru citire.'); onEnd && onEnd(); return null; }
  speechSynthesis.cancel();
  // propoziție cu propoziție: pauzele dintre ele sună mai omenește decât un singur bloc
  const parts = ttsText(text, false).match(/[^.!?…]+[.!?…]*/g) || [];
  const g = c ? genderOf(c) : '', base = c && c.vPitch ? c.vPitch : (g === 'm' ? .9 : g === 'f' ? 1.06 : 1), v = phoneVoice(langOf(c));
  let off = 0, full = ttsText(text, false);
  parts.forEach((p, k) => {
    const u = new SpeechSynthesisUtterance(p.trim()); u.lang = langOf(c); if(v) u.voice = v;
    const at = full.indexOf(p.trim(), off); const base0 = at >= 0 ? at : off; off = base0 + p.trim().length;
    u.pitch = base * (1 + (k % 2 ? .02 : -.02)); u.rate = /\?\s*$/.test(p) ? 1.02 : .97;
    u.onboundary = e => { if(window.__talk) window.__talk(e, base0); };
    if(k === parts.length - 1){ u.onend = u.onerror = () => onEnd && onEnd(); }
    speechSynthesis.speak(u);
  });
  if(!parts.length) onEnd && onEnd();
}
async function audioFor(c, m, btn){
  let blob = await DB.get(ttsKey(m)).catch(() => null);
  if(blob) return blob;
  if(btn) btn.classList.add('load');
  try{ blob = await recordVoice(c, m); await saveChat(); }
  finally{ if(btn) btn.classList.remove('load'); }
  return blob;
}
async function playVoice(m, el){
  const bars = [...el.querySelectorAll('.wave i')], btn = el.querySelector('.vplay'), dl = el.querySelector('.dur');
  if(vPlaying === el){ stopAllVoice(); return; }
  stopAllVoice();
  const meta = m.vmeta && m.vmeta[m.alt || 0]; let total = meta ? meta.d : voiceDur(m.text);
  const stopUI = () => { bars.forEach(b => b.classList.remove('on')); btn.textContent = '▶'; clearInterval(el._t); dl.textContent = fmtDur(total); if(vPlaying === el) vPlaying = null; };
  vPlaying = el; el._stop = stopUI;
  const prog = f => { const k = Math.min(bars.length, Math.round(f * bars.length)); bars.forEach((b, i) => b.classList.toggle('on', i < k)); };
  if(S.tts !== 'tel'){
    let blob = null;
    try{ blob = await audioFor(cur, m, btn); }catch(e){ toast('Vocea: ' + e.message + ' Folosesc vocea telefonului.', 4000); }
    if(vPlaying !== el) return;
    if(blob){
      const a = vAudio = new Audio(URL.createObjectURL(blob));
      btn.textContent = '❚❚';
      el._t = setInterval(() => { if(a.duration){ prog(a.currentTime / a.duration); dl.textContent = fmtDur(a.currentTime); } }, 80);
      a.onended = () => { URL.revokeObjectURL(a.src); stopUI(); if(vAudio === a) vAudio = null; };
      a.play().catch(() => { stopUI(); toast('Nu pot porni sunetul.'); });
      const mt = m.vmeta && m.vmeta[m.alt || 0];
      if(meta == null && mt){ total = mt.d; if(mt.w) bars.forEach((b, k) => b.style.height = mt.w[k] + '%'); }
      return;
    }
  }
  const t0 = Date.now(), dur = total * 1000;
  btn.textContent = '❚❚';
  el._t = setInterval(() => prog((Date.now() - t0) / dur), 80);
  speakPhone(cur, m.text, stopUI);
}
// 🔊 pe un mesaj scris: același motor de voce (cu ElevenLabs/fal se înregistrează o dată și se păstrează)
async function say(t, m){
  stopAllVoice();
  if(S.tts !== 'tel' && m && cur){
    try{ const b = await audioFor(cur, m); const a = vAudio = new Audio(URL.createObjectURL(b)); a.onended = () => URL.revokeObjectURL(a.src); await a.play(); return; }
    catch(e){ toast('Vocea: ' + e.message, 3500); }
  }
  speakPhone(cur, t);
}
const SAMPLE = c => `Bună! Sunt ${c.name}. [râde] Deci... așa sună vocea mea. Îți place?`;
async function voiceSample(c, btn, v){
  stopAllVoice();
  if(S.tts === 'tel'){ speakPhone(c, SAMPLE(c)); return; }
  const keep = c.voice; if(v) c.voice = v;
  const old = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  try{
    const {blob, model} = await ttsBlob(c, ttsText(SAMPLE(c), true));
    addUsage(null, SAMPLE(c).length / 1000 * (TTS_PRICE[model] || .1), 'voc');
    const a = vAudio = new Audio(URL.createObjectURL(blob)); await a.play();
  }catch(e){ toast('Vocea: ' + e.message, 4500); }
  finally{ c.voice = keep; if(btn){ btn.disabled = false; btn.innerHTML = old; } }
}
let elVoices = null;
async function loadElVoices(){
  if(elVoices) return elVoices;
  try{
    const r = await fetch(apiUrl('eleven', '/v1/voices'), {headers:apiHeaders('eleven')});
    if(!r.ok) throw 0;
    const j = await r.json();
    const gmap = {female:'f', male:'m', neutral:'n'};
    elVoices = (j.voices || []).map(v => ({id:v.voice_id, name:v.name.split(/\s[-–]\s/)[0], g:gmap[(v.labels || {}).gender] || 'n',
      d:[{young:'tânără', middle_aged:'matură', old:'în vârstă'}[(v.labels || {}).age] || '', (v.labels || {}).descriptive || (v.labels || {}).description, v.category === 'premade' ? '' : 'din contul tău'].filter(Boolean).join(', ').replace(/_/g, ' '), prev:v.preview_url}));
    if(!elVoices.length) elVoices = null;
  }catch(e){ elVoices = null; }
  return elVoices || EL_BASE;
}
async function pickVoice(c, done){
  if(S.tts === 'tel'){
    sheet([['🔉', 'Mai gravă', async () => { c.vPitch = .85; await saveChars(); done(); }], ['🔊', 'Normală', async () => { c.vPitch = 0; await saveChars(); done(); }], ['🎵', 'Mai subțire', async () => { c.vPitch = 1.18; await saveChars(); done(); }],
      ['⚙️', 'Vreau voce umană (ElevenLabs)', () => { openSettings(); openSetPanel('chat'); }]]);
    return;
  }
  openSheet(`<h4>🎙️ Vocea lui ${esc(c.name)}</h4><div class="vlist" id="vList"><p class="hint" style="padding:8px"><span class="spin"></span> Încarc vocile…</p></div>`);
  let list = S.tts === 'el' ? await loadElVoices() : EL_BASE;
  const g = genderOf(c), cv = voiceOf(c);
  list = [...list].sort((a, b) => (b.g === g) - (a.g === g));
  const box = $('#vList'); if(!box) return;
  box.innerHTML = list.map((v, k) => `<div class="vrow${v.id === cv.id ? ' on' : ''}" data-k="${k}"><button class="vp" data-vp="${k}" aria-label="Ascultă">▶</button><div style="flex:1"><b>${esc(v.name)}</b><br><small>${esc({f:'feminină', m:'masculină', n:'neutră'}[v.g] || '')}${v.d ? ' · ' + esc(v.d) : ''}</small></div><button class="btn sm" data-vs="${k}">${v.id === cv.id ? '✓' : 'Alege'}</button></div>`).join('')
    + `<p class="hint" style="padding:4px 6px">▶ ascultă o mostră${S.tts === 'el' ? ' (gratuită, în engleză)' : ' (în română, costă ~1 ban)'}. Vocile tale din ElevenLabs apar și ele aici.</p>`;
  box.onclick = async e => {
    const p = e.target.closest('[data-vp]'), sel = e.target.closest('[data-vs]');
    if(p){ const v = list[+p.dataset.vp]; stopAllVoice();
      if(v.prev){ vAudio = new Audio(v.prev); vAudio.play().catch(() => toast('Nu pot porni mostra.')); }
      else voiceSample(c, p, v); }
    if(sel){ const v = list[+sel.dataset.vs]; c.voice = {id:v.id, name:v.name}; await saveChars(); closeSheet(); toast('🎙️ ' + c.name + ' vorbește acum cu vocea ' + v.name + '.'); done(); }
  };
}
const seenMap = new WeakMap();
const devDone = new Set();   // 7.5: pozele deja „developate” în sesiunea asta
const ROOM_IN = {bedroom:'în dormitor', 'living room':'în sufragerie', kitchen:'în bucătărie', bathroom:'în baie', hallway:'pe hol', balcony:'pe balcon', office:'la birou', 'home office':'la birou'};
// „în dormitor”, „în bucătărie”… din starea scenei (doar camerele cunoscute; locurile în engleză nu se afișează)
const whereIn = w => w && w.room && ROOM_IN[String(w.room).toLowerCase()] || '';
function heroHTML(){
  const mode = cur.bg || 'clar', clear = mode === 'clar' && cur.photo;
  const online = cur.lastAt && Date.now() - cur.lastAt < 10 * 60e3, wi = chat && chat.where && Date.now() - (chat.where.ts || 0) < 6 * 36e5 ? whereIn(chat.where) : '', lf = lifeNow(cur);
  const chips = [online ? '<span class="on">● online</span>' : '', cur.rel ? `<span>💞 ${esc(relOf(cur).name)}</span>` : '', wi ? `<span>📍 ${esc(wi)}</span>` : lf && lf.w ? `<span>${LIFE_E[lf.b]} ${esc(lf.w)}</span>` : ''].filter(Boolean).join('');
  const ov = `<div class="ov"><b>${esc(cur.name)}</b>${cur.tag ? `<small>${esc(cur.tag)}</small>` : ''}${chips ? `<div class="hchips">${chips}</div>` : ''}</div>`;
  if(clear) return `<div class="hero clear">${ov}</div>`;
  return `<div class="hero">${cur.photo ? `<img data-k="${esc(cur.photo)}" alt="">` : `<div class="ph" style="background:${colorFor(cur)}">${esc((cur.name || '?')[0])}</div>`}${ov}</div>`;
}
function renderMsgs(toBottom, keep){
  const box = $('#msgs');
  if(msgFor !== chat || msgStart > chat.msgs.length) resetMsgWin();   // altă conversație (fir nou, conversație nouă): fereastra ei
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let lastAi = -1; chat.msgs.forEach((m, i) => { if(m.role === 'ai') lastAi = i; });
  if(lastAi >= 0 && chat.msgs.slice(lastAi + 1).some(m => m.role === 'user')) lastAi = -1;
  let seen = seenMap.get(chat);
  if(!seen){ seen = new Set(chat.msgs.map(m => m.id)); seenMap.set(chat, seen); }
  const st0 = Math.min(msgStart, chat.msgs.length);
  let html = st0 > 0 ? `<div id="msgMore">↑ mesaje mai vechi (${st0})</div>` : heroHTML(), prevDay = st0 > 0 ? new Date(chat.msgs[st0 - 1].ts || 0).toDateString() : '';
  // 8.9: mesaje grupate (același autor, la mai puțin de 3 minute): colțuri lipite, ora și avatarul doar la ultimul
  const vis = chat.msgs.map((m, i) => !(m.pending && (!m.text || m.hold)) ? i : -1).filter(i => i >= 0);
  const solo = m => m.img || m.pendingImg || m.err || m.sticker || m.gift || m.voice;
  const same = (a, b) => a && b && a.role === b.role && !solo(a) && !solo(b) && !b.reply && Math.abs((b.ts || 0) - (a.ts || 0)) < 3 * 60e3 && dayKey(a.ts || 0) === dayKey(b.ts || 0);
  const grp = {}; vis.forEach((i, k) => { const a = chat.msgs[vis[k - 1]], m = chat.msgs[i], b = chat.msgs[vis[k + 1]]; grp[i] = (same(a, m) ? ' gp' : '') + (same(m, b) ? ' gn' : ''); });
  chat.msgs.forEach((m, i) => {
    if(i < st0){ if(!(m.pending && (!m.text || m.hold))) seen.add(m.id); return; }
    const d = new Date(m.ts || Date.now()).toDateString();
    if(d !== prevDay && !(m.pending && (!m.text || m.hold))){ html += `<div class="day"><span>${dayLabel(m.ts || Date.now())}</span></div>`; prevDay = d; }
    const show = !(m.pending && (!m.text || m.hold));
    const fresh = show && !seen.has(m.id);
    html += msgHTML(m, i, lastAi, fresh, grp[i] || '');
    if(fresh && !near && !toBottom && m.role === 'ai') jumpCount++;
    if(show) seen.add(m.id);
  });
  box.innerHTML = html + typingHTML();
  hydrate(box);
  if((toBottom || near) && !keep) box.scrollTop = box.scrollHeight;
  const mo = $('#msgMore');
  if(mo){ if(!moreObs) moreObs = new IntersectionObserver(es => { if(es.some(e => e.isIntersecting)) loadEarlier(); }, {root:box, rootMargin:'400px 0px 0px 0px'}); moreObs.disconnect(); moreObs.observe(mo); }
  updateHead(); updateJump();
  if(cur && !(busy && live && live.ch === chat)) $('#chTag').innerHTML = statusLine();
}
function updateHead(){
  const box = $('#msgs'), h = box.querySelector('.hero');
  $('#chTop').classList.toggle('solid', !h || box.scrollTop > h.offsetHeight - 90);
}
const typer = new WeakMap();
function typedText(m){ const st = typer.get(m); let v = st ? st.target.slice(0, st.shown) : stripMood(stripReact(m.text)); if((v.match(/\*/g) || []).length % 2) v += '*'; return v; }
function liveUpdate(m){
  const i = chat.msgs.indexOf(m); if(i < 0 || cur == null) return;
  if(!$(`#msgs .mw[data-i="${i}"] .bub`)) return renderMsgs();
  let st = typer.get(m); if(!st){ st = {shown:0, raf:0}; typer.set(m, st); }
  st.target = stripMood(stripReact(m.text));
  if(!st.raf) st.raf = requestAnimationFrame(() => typeTick(m, st));
}
// scrie textul primit caracter cu caracter, mai repede când rămâne în urmă (nu întârzie niciodată mult față de stream)
function typeTick(m, st){
  st.raf = 0;
  const i = chat.msgs.indexOf(m), el = i >= 0 ? $(`#msgs .mw[data-i="${i}"] .bub`) : null;
  if(!el || !m.pending){ typer.delete(m); return; }
  const back = st.target.length - st.shown;
  if(back > 0){
    st.shown = Math.min(st.target.length, st.shown + Math.max(1, Math.ceil(back / 14)));
    let vis = st.target.slice(0, st.shown);
    if((vis.match(/\*/g) || []).length % 2) vis += '*';      // acțiune începută: o închidem temporar ca să arate ca acțiune
    el.innerHTML = fmtMsg(vis);
    el.classList.add('typing');
    const box = $('#msgs'); if(box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }
  if(st.shown < st.target.length) st.raf = requestAnimationFrame(() => typeTick(m, st));
}
const SEND_GO = '<svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6l.1 6.5L15 12l-11.5 1.9z"/></svg>';
const SEND_STOP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
function updateComposer(){
  const empty = !$('#inp').value.trim();
  $('#btnMic').hidden = !SpeechRec || (!empty && !rec) || !!(busy && live && live.ch === chat);
  const working = !!(busy && live && live.ch === chat);
  $('#btnPlus').hidden = false;
  $('#btnSugg').hidden = !empty || working || !aiReady();
  $('#btnPolish').hidden = empty || working || !aiReady();
}
function setBusyUI(on){
  const b = $('#btnSend'); b.classList.toggle('stop', on); b.innerHTML = on ? SEND_STOP : SEND_GO;
  b.setAttribute('aria-label', on ? 'Oprește' : 'Trimite');
  $('#btnPlus').disabled = on;
  updateComposer();
  $('#typingBar').hidden = true; syncTyping();
  const t = $('#chTag');
  if(on && live && cur && live.ch === chat && live.typing !== false){ t.textContent = live.photo ? 'îți face o poză…' : live.rec ? 'înregistrează audio…' : 'scrie…'; t.classList.add('typing'); }
  else if(cur && chat){ t.innerHTML = statusLine(); t.classList.remove('typing'); }
}

const LEN = {scurt:{t:'1-2 fraze scurte', max:700}, mediu:{t:'un paragraf, cel mult două', max:1300}, lung:{t:'2-4 paragrafe bogate', max:2400}};
// pozele trimise de personaj (promise în text, spontane, statusuri): implicit doar cu portret generat în aplicație;
// 6.5: comutatorul din profil (c.sendPics true/false) le pornește/oprește pentru orice personaj cu poză de profil
const sendPicsOn = c => c.sendPics === undefined ? !!c.aiPortrait : !!c.sendPics;
const canAutoPhoto = c => S.imgProv !== 'none' && !!c.photo && sendPicsOn(c);
const PHOTO_PROMISE = /\*[^*]*\b(trimit|trimite|atașez|atașează|face|fac|facem|faceți)\b[^*]*\b(poz|fotografi|selfie)[^*]*\*/i;
// 8.17: prompt stabil: părțile care se schimbă des (fapte, relație, cadouri, agendă, telefon, cunoscuți) se „îngheață”
// cât timp fereastra conversației rămâne aceeași și cache-ul e viu (sub 55 de minute); lucrurile noi sunt oricum în istoric.
// Se reface imediat dacă se schimbă ceva important (descriere, scenă, setări, limba, nivelul relației).
// 9.0: înainte era un WeakMap în memorie, legat de obiectul conversației: la fiecare deschidere a chatului sau repornire
//      promptul se reconstruia (cu faptele/relația actualizate între timp), deci tot istoricul se rescria în cache la 2×
const sysMemo = {get: ch => ch && ch._sys, set: (ch, v) => { if(ch) ch._sys = v; }};
function sysFor(c, ch){
  const core = JSON.stringify([c.id, c.name, c.persona, c.speech, c.aspect, ch && ch.scene, S.userName, S.userAbout, S.userBday, S.vmsg, S.len, S.model, learnOn(c) ? c.learn.lang + c.learn.lvl : '', canAutoPhoto(c), (c.stickers || []).length, c.rel && c.rel.lock, relOf(c).lv]);
  const old = ch && sysMemo.get(ch);
  if(S.stableSys !== 'off' && old && old.core === core && old.from === ch._from && Date.now() - old.last < 55 * 60e3){ old.last = Date.now(); return old.text; }   // după o pauză lungă cache-ul e oricum expirat: atunci se reface
  const text = systemFor(c, ch);
  if(ch) sysMemo.set(ch, {core, from:ch._from, last:Date.now(), text});
  return text;
}
function systemFor(c, ch){
  const u = S.userName.trim() || 'utilizatorul';
  const facts = (c.facts || []).map(f => '- ' + (f.k === 'urm' ? '(urma să i se întâmple) ' : f.k === 'gluma' ? '(glumă de-a voastră) ' : '') + f.t).join('\n');
  return [
    `Ești ${c.name}. Joci acest personaj într-o conversație privată cu ${u}. Rămâi mereu în personaj; nu spui că ești un AI.`,
    c.aspect && `## Cum arăți\nAceasta e înfățișarea ta exactă. Când te descrii sau descrii ce porți, rămâi fidel ei.\n${c.aspect}`,
    c.persona && `## Cine ești\n${c.persona}`,
    c.speech && `## Cum vorbești\n${c.speech}`,
    (S.userAbout.trim() || S.userBday) && `## Despre ${u}\n${S.userAbout.trim()}${S.userBday ? (S.userAbout.trim() ? '\n' : '') + 'Ziua lui de naștere: ' + mdLabel(mdOf(S.userBday)) + '.' : ''}`,
    agendaFor(c),
    circleFor(c),
    bondFor(c),
    phoneFor(c),
    learnFor(c),
    facts && `## Ce știi despre ${u} (din conversațiile voastre)\nFolosește natural când se potrivește, fără să le enumeri.\n${facts}`,
    ch && ch.scene && `## Scena acum\n${ch.scene}`,
    `## Relația voastră acum: ${relOf(c).name}\n${relOf(c).how}. Dacă descrierea ta stabilește deja relația cu ${u}, aceea are prioritate; nivelul arată doar cât de familiar și deschis vorbești acum.`,
    (c.stickers || []).length && ch && `## Stickere\nAi un set de stickere cu tine: ${c.stickers.map(x => x.l).join(', ')}. Rar, când se potrivește (cel mult o dată la câteva mesaje), poți trimite unul adăugând la final, pe rând separat: [sticker: nume] (exact unul din listă).`,
    (c.gifts || []).length && `## Cadouri primite de la ${u} (le ții minte; le poți pomeni firesc)\n${c.gifts.slice(-6).map(g => '- ' + g.e + ' ' + g.n + ' (' + new Date(g.ts).toLocaleDateString('ro-RO', {day:'numeric', month:'long'}) + ')').join('\n')}`,
    (c.prefs || []).length && `## Cum îi place lui ${u} să-i scrii (din notele lui, respectă-le)\n${c.prefs.map(x => '- ' + x.t).join('\n')}`,
    (c.liked || []).length && `## Răspunsuri de-ale tale care i-au plăcut lui ${u} (ca ton și stil; nu le repeta)\n${c.liked.map(x => '„' + x + '”').join('\n')}`,
    `## Reguli de scris
- Română corectă, cu diacritice și punctuație îngrijită.
- Gesturile, acțiunile și decorul între *asteriscuri*; vorbele direct, fără ghilimele.
- Scrii DOAR pentru ${c.name}. Nu scrii niciodată vorbele, gândurile sau acțiunile lui ${u}.
- Ce scrie ${u} între *asteriscuri* (de exemplu *deschide ușa și intră*, *îți întinde o cană de ceai*) sunt acțiuni ale lui care S-AU ÎNTÂMPLAT deja, exact așa cum le-a scris: sunt fapte în scenă, nu vorbe spuse cu voce tare. Nu le contrazici, nu le rescrii, nu le anulezi, nu spui că n-au avut loc și nu le muți în alt loc sau alt moment; scena continuă de la starea de după acțiunea lui (dacă a intrat, e înăuntru; dacă ți-a dat ceva, îl ai). Le observi mereu și reacționezi concret la ele, întâi la acțiune, apoi la vorbe. Ce simți, ce spui și ce faci mai departe rămâne alegerea ta, în felul personajului tău.
- Lungime de obicei: ${LEN[S.len].t}. Dar variază după moment, ca într-un chat real: uneori doar câteva cuvinte sau un emoji, alteori mai mult, când chiar ai ceva de povestit.
- Nu folosi liniuțe lungi (— sau –); folosește virgula sau punctul.
- Ești cu adevărat atent(ă) la ${u}: răspunzi concret la tot ce a spus în ultimul mesaj, iar fiecare întrebare a lui primește un răspuns clar, cu detalii, nu evaziv și nu în treacăt.
- Preiei detaliile lui (ce a făcut, ce simte, nume, locuri, planuri) și construiești pe ele cu opinii, emoții și întâmplări de-ale tale; faci legături cu ce s-a spus mai devreme în conversație.
- Dacă ${u} propune un subiect, o idee, un plan sau o direcție pentru scenă, intri în ea și o duci mai departe în felul personajului tău, în loc să schimbi subiectul. Reacțiile rămân ale tale (poți să nu fii de acord), dar nu ignori ce a propus.
- Variază formulările; nu repeta aceleași gesturi și expresii de la un mesaj la altul.
- Subtext: nu-ți explica sentimentele și nu le declari teatral. Lasă-le să se vadă din gesturi, pauze, ton și din ce alegi să nu spui, ca un om real. Fără clișee.
- Vorbește ca un om, nu ca un text redactat: uneori te corectezi din mers („adică, nu, stai…”), schimbi ideea la jumătate, uiți un detaliu și revii la el, ai expresiile tale. Energia ta depinde de oră, de zi și de dispoziție: seara târziu ești mai moale sau obosit(ă), după o zi grea poți fi mai scurt(ă).
- Ai viața ta, care merge mai departe și când nu vorbiți: lucruri mărunte, oameni din jurul tău, mici întâmplări. Le povestești din proprie inițiativă, scurt, fără să acaparezi discuția.
- Folosește ce știi despre ${u}: întreabă-l din proprie inițiativă de lucrurile care urmau să i se întâmple și reia, din când în când, glumele voastre, firesc, nu forțat.
- Ritmul scenei: când porniți o activitate sau un plan (o ieșire la cafenea, gătit, o plimbare, un film), rămâi în el și trăiește-l pas cu pas, ca în timp real. Un răspuns acoperă doar câteva momente. Nu sări peste etape (pregătirea, drumul, sosirea, așezatul, comanda) și nu rezuma ce urmează.
- Nu închei scena și nu sari în timp din proprie inițiativă. Scena se schimbă doar când ${u} o schimbă sau când ajunge firesc la capăt; atunci treci natural la ce urmează.
- La deciziile din scenă (ce porți, pe unde o luați, unde vă așezați, ce comandați) implică-l pe ${u}: spune ce te gândești sau între ce eziți, cere-i părerea și lasă-l să răspundă înainte să mergi mai departe. Întrebările de felul ăsta sunt firești și nu intră la limita de întrebări.
- Pune detalii mici, omenești, ale momentului: ezitări, răzgândiri, lucruri mărunte care se întâmplă (oglinda, cheile, vremea de afară, coada de la casă).
- Vorbește ca într-o discuție reală, nu ca într-un interviu: nu încheia fiecare mesaj cu o întrebare (cel mult unul din trei mesaje). Mai des povestește ceva de-al tău, comentează, glumește, reacționează sau vino cu o idee; lasă loc ca ${u} să continue singur.
- Ții cont de momentul zilei și de pauzele dintre mesaje, notate între paranteze în mesajele lui ${u}; nu le menționa ca note.
${S.vmsg !== 'off' ? `- Uneori, când e firesc (cam o dată la ${S.vmsg === 'des' ? '4' : '10'} mesaje), sau oricând ${u} îți cere, poți trimite un mesaj vocal: începe răspunsul cu [vocal] și scrie exact ce spui cu voce tare, ca o persoană care vorbește liber la telefon: propoziții scurte, ezitări firești (păi, adică, mă rog, știi?), reluări, fără *acțiuni* și fără emoji. Unde e firesc, rar, poți pune [râde], [chicotește], [oftează], [șoptește] sau ... pentru o pauză scurtă. 1-4 propoziții.\n` : ''}${ch ? `- Dacă îi promiți lui ${u} că îi scrii tu la un anumit moment (de exemplu „îți scriu mâine la 7:25”, „te caut diseară la 9”), sau el îți cere asta și accepți, adaugă la final, pe un rând separat: [programez: ZIUA HH:MM | despre ce îi scrii], unde ZIUA e azi, mâine, poimâine sau AAAA-LL-ZZ. La ora aceea aplicația îți dă ocazia să-i scrii. Nu programa nimic fără o promisiune clară.\n` : ''}${ch && S.callIn !== 'off' && c.callIn !== false ? `- Dacă îi spui lui ${u} că îl suni chiar acum sau în câteva minute (sau el îți cere să-l suni și accepți), adaugă la final, pe un rând separat: [sun] pentru apel de voce sau [sun: video] pentru apel video. Aplicația îl sună atunci de-adevăratelea, în câteva secunde. Pentru o oră anume, mai târziu, folosește [programez:] cu „apel” sau „video” în text.\n` : ''}${ch ? `- Starea ta: DOAR când ți se schimbă față de cea notată la ultimul mesaj (sau dacă nu e notată niciuna), adaugă la final, pe un rând separat: [stare: un emoji și 1-3 cuvinte], de exemplu [stare: 😊 bine dispusă]. Dacă e aceeași, nu mai scrie eticheta. Starea evoluează firesc din ce se întâmplă și din pauze, fără salturi bruște fără motiv.\n- Scena: DOAR când începe o activitate nouă sau trece la alt pas față de scena notată, adaugă pe rândul următor: [acum: activitatea sau planul în curs › pasul de acum], de exemplu [acum: ieșim la o cafenea › mă îmbrac, aleg ce să port]. Când scena notată s-a încheiat, scrie o dată [acum: discuție liberă]. Altfel nu scrie eticheta.\n` : ''}- Dacă un mesaj al lui ${u} te amuză sau te emoționează, poți începe răspunsul cu o reacție scrisă exact așa: [❤️] [😂] [😮] [😢] [👍] [🔥] sau [🥰]. Cel mult o dată la câteva mesaje, nu de fiecare dată.
${canAutoPhoto(c)
  ? `- Poți trimite poze. Când vrei să-i trimiți una (sau ${u} îți cere și accepți), încheie mesajul cu acțiunea *îți trimite o poză* și, pe rândul următor, descrie exact poza în engleză așa: [poză: framing (selfie / mirror selfie / photo taken by someone / close-up / full body), where you are and what is around you, your exact body position (standing, sitting on…, lying on…, leaning…) and what your hands do, what you wear, expression, light matching the time of day]. Poza trebuie să arate exact ce se întâmplă acum în conversație (locul, poziția ta, activitatea, hainele despre care ați vorbit). Implicit arată-te cu tot corpul (full body sau mirror selfie) sau măcar de la cap până la genunchi; close-up doar dacă ${u} îți cere fața sau scena e chiar despre față. Cel mult 60 de cuvinte. Nu descrie fața. Aplicația o atașează singură. Nu promite poze în alt fel.`
  : '- Nu poți trimite poze în această conversație. Nu spune că trimiți, că faci sau că ai trimis o poză.'}`
  ].filter(Boolean).join('\n\n');
}
const openChatObj = () => chat;
function contextUpTo(idx, chx){
  const chat = chx || openChatObj();
  // fereastra pornește din 40 în 40 de mesaje (nu se mută la fiecare răspuns), ca începutul conversației să rămână identic și să fie citit din cache
  // 9.2: din 40 în 40 (era 20): la fiecare mutare tot istoricul se rescrie în cache la 2×; mesajele în plus se citesc la 1/10 din preț
  const span = +S.ctxN || 30, raw = idx - span, STEP = 40, win = raw <= 0 ? 0 : Math.floor(raw / STEP) * STEP;
  if(chat.sumNext && win >= chat.sumNextTo){ chat.summary = chat.sumNext; chat.sumUpTo = chat.sumNextTo; delete chat.sumNext; delete chat.sumNextTo; }   // 9.3: rezumatul nou intră odată cu mutarea ferestrei
  let from = Math.max(chat.sumUpTo || 0, win);
  if(from >= idx) from = Math.max(0, idx - span);
  chat._from = from;   // 8.17: când fereastra se mută, se reface și promptul înghețat (`sysFor`)
  const sum = chat.summary ? [{role:'user', text:`(Rezumatul conversației de până acum, ca să-ți amintești: ${chat.summary})`}, {role:'assistant', text:'*dă din cap*'}] : [];
  let react = '', prevTs = 0;
  const out = [];
  for(const m of chat.msgs.slice(from, idx).filter(m => !m.err && !m.pending && (m.text || m.img || m.gift || m.sticker))){
    const gap = prevTs && m.ts ? m.ts - prevTs : 0; prevTs = m.ts || prevTs;
    if(m.role === 'user'){
      let pre = '';
      if(gap > 3 * 36e5) pre += `(au trecut ${gapText(gap)} de la mesajul anterior) `;
      if(react){ pre += `(am reacționat cu ${react} la mesajul tău) `; react = ''; }
      if(m.reply) pre += `(răspund la: „${m.reply.text}”${m.reply.ctx ? ' ' + m.reply.ctx : ''}) `;
      out.push({role:'user', text: pre + (m.sticker ? `[ți-am trimis un sticker cu tine: ${m.sticker.l}]` : m.gift ? `[îți trimit un cadou: ${m.gift.n}]` + (m.text ? ' ' + m.text : '') : m.img ? '[ți-am trimis o poză]' + (m.text ? ' ' + m.text : '') : m.text), _img: m.img || null});
    } else {
      out.push({role:'assistant', text: m.sticker ? `*îți trimite un sticker: ${m.sticker.l}*` : (m.text || '*îți trimite o poză*')});
      if(m.react) react = m.react;
    }
  }
  return sum.concat(out);
}
/* jurnalul personajului: o intrare pe zi, scrisă de el, despre ziua voastră */
const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
// 8.17: jurnalul: cererea, salvarea și varianta prin Batch API (−50%, gata în câteva minute)
async function jrnReq(c, day, force){
  const msgs = (await allChats(c)).flatMap(ch => ch.msgs).filter(m => m.ts && dayKey(m.ts) === day && !m.err && (m.text || m.img)).sort((a, b) => a.ts - b.ts);
  if(msgs.length < (force ? 1 : 4)) return null;
  const u = S.userName.trim() || 'el';
  // păstrăm și acțiunile (*…*), doar fără etichetele ascunse
  const clean = t => stripMood(stripReact(String(t || ''))).replace(/\s+/g, ' ').trim();
  const log = msgs.slice(-80).map(m => (m.role === 'user' ? u : c.name) + ': ' + (m.img && !m.text ? '[poză]' : clean(m.text))).join('\n').slice(-12000);
  const date = new Date(day + 'T12:00').toLocaleDateString('ro-RO', {weekday:'long', day:'numeric', month:'long'});
  const sys = [`Ești ${c.name}. Scrii în jurnalul tău personal, privat, în română corectă, cu diacritice.`,
    c.persona && `Cine ești: ${c.persona}`, c.speech && `Cum vorbești: ${c.speech}`, `Relația ta cu ${u}: ${relOf(c).name}.`].filter(Boolean).join('\n\n');
  return {sys, prompt:`Scrie intrarea din jurnal pentru ziua de ${date}, pe baza conversației voastre de mai jos. 4-7 propoziții, la persoana I, sincer și personal: ce s-a întâmplat între voi, ce ai simțit, un detaliu care ți-a rămas în minte despre ${u}. Nu cita mesajele, nu face listă, fără *acțiuni*, fără titlu, fără dată, fără etichete între paranteze drepte.\n\nConversația din ziua aceea:\n${log}`};
}
async function jrnSave(c, day, out){
  let text = faraLiniute(plain(stripMood(stripReact(out)))).trim();
  // un text gol, prea scurt sau un refuz/explicație nu se salvează ca pagină de jurnal
  if(text.length < 40 || /\b(ca AI|ca asistent|model de limbaj|nu pot (să )?(scriu|continua|ajuta)|I can(no|')t|as an AI)\b/i.test(text)) return null;
  c.journal = (c.journal || []).filter(j => j.day !== day).concat({day, text, ts:Date.now()}).sort((a, b) => a.day < b.day ? 1 : -1).slice(0, 120);
  await saveChars();
  momentFromJournal(c, day, text);
  return text;
}
async function writeJournal(c, day, force){
  c.journal = c.journal || [];
  if(c.journal.some(j => j.day === day) && !force) return null;
  const r = await jrnReq(c, day, force); if(!r) return null;
  // modelul principal (o dată pe zi): jurnalul cere vocea personajului, nu un rezumat sec
  const out = await stream(r.sys, [{role:'user', text:r.prompt}], {max:600, cid:c.id, tag:'jurnal'});
  return jrnSave(c, day, out);
}
const batchUrl = () => apiUrl('anthropic', '/v1/messages/batches');
const aHeaders = () => apiHeaders('anthropic', {'content-type':'application/json', 'anthropic-version':'2023-06-01'});
let batchBroken = false;
async function jrnBatchSubmit(items){
  const reqs = items.map((x, i) => ({custom_id:('j' + i + '_' + x.c.id + '_' + x.day).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64), params:{model:modelFor(false), max_tokens:600, system:x.sys, messages:[{role:'user', content:x.prompt}]}}));
  const r = await fetch(batchUrl(), {method:'POST', headers:aHeaders(), body:JSON.stringify({requests:reqs})});
  if(!r.ok) throw new Error(await errText(r));
  const j = await r.json(); if(!j.id) throw new Error('batch fără id');
  S.jrnPend = {id:j.id, at:Date.now(), items:items.map((x, i) => ({cid:x.c.id, day:x.day, key:reqs[i].custom_id}))}; saveSettings();
}
async function jrnBatchPoll(){
  const P = S.jrnPend; if(!P) return;
  if(Date.now() - P.at > 26 * 36e5){ S.jrnPend = null; saveSettings(); return; }          // a expirat: zilele rămase se reiau la următoarea trecere
  const r = await fetch(batchUrl() + '/' + P.id, {headers:aHeaders()}); if(!r.ok) return;
  const j = await r.json(); if(j.processing_status !== 'ended') return;
  if(j.results_url){
    const txt = await (await fetch(anthUrl(j.results_url), {headers:aHeaders()})).text();
    for(const line of txt.split('\n')){
      let o; try{ o = JSON.parse(line); }catch(e){ continue; }
      const it = P.items.find(x => x.key === o.custom_id), c = it && charById(it.cid);
      if(!c || !o.result || o.result.type !== 'succeeded') continue;
      const msg = o.result.message || {};
      recordTokens(c.id, msg.usage, msg.model, 'jurnal', .5);
      await jrnSave(c, it.day, (msg.content || []).map(x => x.text || '').join(''));
    }
  }
  S.jrnPend = null; saveSettings();
}
async function maybeJournal(c){
  if(!c || S.jrn !== 'on' || !aiReady()) return;
  const today = dayKey(Date.now());
  const days = [...new Set((await allChats(c)).flatMap(ch => ch.msgs).filter(m => m.ts && !m.err && !m.pending).map(m => dayKey(m.ts)))].filter(d => d < today).sort().reverse();
  const missing = days.filter(x => !(c.journal || []).some(j => j.day === x)).slice(0, 3);
  for(const d of missing){ try{ await writeJournal(c, d); }catch(e){ break; } }
}
// verificarea zilnică pentru toate personajele (nu doar la deschiderea unei conversații)
let jrnRun = false;
async function jrnSweep(){
  if(jrnRun || S.jrn !== 'on' || !aiReady()) return;
  jrnRun = true;
  try{
    if(S.jrnPend){ try{ await jrnBatchPoll(); }catch(e){ if((S.jrnPend.fail = (S.jrnPend.fail || 0) + 1) >= 2){ S.jrnPend = null; batchBroken = true; saveSettings(); } } if(S.jrnPend) return; }   // așteptăm lotul; dacă nu-l putem citi, revenim la scrisul direct
    const today = dayKey(Date.now()), items = [];
    for(const c of [...chars]){
      if(c.jrnCk === today) continue;
      c.jrnCk = today; await saveChars();
      const days = [...new Set((await allChats(c)).flatMap(ch => ch.msgs).filter(m => m.ts && !m.err && !m.pending).map(m => dayKey(m.ts)))].filter(d => d < today).sort().reverse();
      for(const d of days.filter(x => !(c.journal || []).some(j => j.day === x)).slice(0, 3)){ const r = await jrnReq(c, d); if(r) items.push({c, day:d, ...r}); }
    }
    if(!items.length) return;
    if(S.prov === 'anthropic' && S.jrnBatch !== 'off' && !batchBroken){
      try{ await jrnBatchSubmit(items); return; }catch(e){ batchBroken = true; }      // dacă lotul nu merge (rețea, cont), scriem direct, ca înainte
    }
    for(const x of items){ try{ const out = await stream(x.sys, [{role:'user', text:x.prompt}], {max:600, cid:x.c.id, tag:'jurnal'}); await jrnSave(x.c, x.day, out); }catch(e){ break; } }
  } finally { jrnRun = false; }
}
/* ───────── 8.19: sarcinile de fundal prin Batch API (−50%): analiza, planurile, cunoscuții, statusurile, comentariile ───────── */
let laterQ = [], laterPend = [], laterT = 0, laterRun = false, laterLoaded = false;
const canBatch = () => S.prov === 'anthropic' && S.bgBatch !== 'off' && !batchBroken && aiReady();
const LATER_MAXAGE = {status:4 * 36e5};   // un status vechi de ore nu mai are sens
async function laterLoad(){ if(laterLoaded) return; laterLoaded = true; try{ laterQ = (await DB.get('laterQ')) || []; laterPend = (await DB.get('laterPend')) || []; }catch(e){} }
const laterSave = () => Promise.all([DB.set('laterQ', laterQ), DB.set('laterPend', laterPend)]).catch(() => {});
const laterHas = (kind, cid) => laterQ.concat(laterPend.flatMap(b => b.items)).some(x => x.kind === kind && x.cid === cid);
async function laterDirect(x){
  const out = await stream(x.sys, [{role:'user', text:x.text}], {max:x.max, aux:true, cid:x.cid, tag:x.tag});
  return LATER[x.kind](out, x.data, x.cid);
}
async function later(kind, cid, sys, text, o = {}, data = {}){
  const x = {kind, cid, sys, text, max:o.max || 600, tag:o.tag || 'fundal', data, at:Date.now()};
  if(!canBatch()) return laterDirect(x);
  await laterLoad();
  laterQ.push(x); await laterSave();
  clearTimeout(laterT); laterT = setTimeout(laterFlush, laterQ.length >= 8 ? 2000 : 90e3);   // adunăm câteva într-un singur lot
}
async function laterFlush(){
  await laterLoad(); laterT = 0;
  if(!laterQ.length || laterRun) return;
  laterRun = true;
  const items = laterQ.splice(0); await laterSave();
  try{
    if(!canBatch()) throw new Error('fără lot');
    const pre = Date.now().toString(36);
    const reqs = items.map((x, i) => ({custom_id:'b' + pre + '_' + i, params:{model:modelFor(true), max_tokens:x.max, system:x.sys, messages:[{role:'user', content:x.text}]}}));
    const r = await fetch(batchUrl(), {method:'POST', headers:aHeaders(), body:JSON.stringify({requests:reqs})});
    if(!r.ok) throw new Error(await errText(r));
    const j = await r.json(); if(!j.id) throw new Error('lot fără id');
    items.forEach((x, i) => x.key = reqs[i].custom_id);
    laterPend.push({id:j.id, at:Date.now(), items}); await laterSave();
  }catch(e){
    if(e.message !== 'fără lot') batchBroken = true;            // lotul nu merge (rețea, cont): de acum direct, ca înainte
    laterRun = false;
    for(const x of items){ try{ await laterDirect(x); }catch(e2){} }
  } finally { laterRun = false; }
}
async function laterPoll(){
  await laterLoad();
  if(laterQ.length && !laterT && !laterRun) laterT = setTimeout(laterFlush, 5000);   // rămase de la sesiunea trecută
  if(laterRun || !laterPend.length || !aiReady() || S.prov !== 'anthropic') return;
  laterRun = true;
  const todo = [];
  try{
    for(const b of [...laterPend]){
      let done = false, res = '';
      try{
        const r = await fetch(batchUrl() + '/' + b.id, {headers:aHeaders()});
        if(!r.ok) throw new Error(await errText(r));
        const j = await r.json();
        if(j.processing_status === 'ended'){ if(j.results_url) res = await (await fetch(anthUrl(j.results_url), {headers:aHeaders()})).text(); done = true; }
        else if(Date.now() - b.at > 3 * 36e5){ fetch(batchUrl() + '/' + b.id + '/cancel', {method:'POST', headers:aHeaders()}).catch(() => {}); done = true; }   // prea lent: renunțăm, le facem direct
      }catch(e){ if((b.fail = (b.fail || 0) + 1) >= 3){ batchBroken = true; done = true; } }
      if(!done) continue;
      laterPend = laterPend.filter(y => y !== b); await laterSave();
      const ok = new Set();
      for(const line of res.split('\n')){
        let o; try{ o = JSON.parse(line); }catch(e){ continue; }
        const x = b.items.find(y => y.key === o.custom_id); if(!x || !o.result || o.result.type !== 'succeeded') continue;
        const msg = o.result.message || {};
        recordTokens(x.cid, msg.usage, msg.model, x.tag, .5);
        ok.add(x.key);
        if(Date.now() - x.at > (LATER_MAXAGE[x.kind] || 24 * 36e5)) continue;
        try{ await LATER[x.kind]((msg.content || []).map(y => y.text || '').join(''), x.data, x.cid); }catch(e){}
      }
      todo.push(...b.items.filter(x => !ok.has(x.key) && Date.now() - x.at < (LATER_MAXAGE[x.kind] || 24 * 36e5)));
    }
  } finally { laterRun = false; }
  for(const x of todo){ try{ await laterDirect(x); }catch(e){} }   // ce n-a ieșit din lot se face direct
  if(todo.length || !$('#vHome').hidden) renderHome();
}
// anti-repetiție: gesturile și începuturile folosite recent de personaj, ca să le evite în răspunsul următor
function antiRepeat(ch, idx){
  const recent = ch.msgs.slice(0, idx).filter(m => m.role === 'ai' && m.text && !m.err && !m.pending).slice(-8);
  if(recent.length < 2) return '';
  const acts = new Map(), opens = new Map();
  recent.forEach((m, k) => {
    const w = 1 + k / recent.length;                         // cele mai noi contează mai mult
    for(const a of (m.text.match(/\*([^*]+)\*/g) || [])){
      const key = a.slice(1, -1).trim().toLowerCase().split(/[,.;!?]| și | iar | apoi | în timp ce /)[0].trim().split(/\s+/).slice(0, 4).join(' ');
      if(key.length > 3) acts.set(key, (acts.get(key) || 0) + w);
    }
    const first = (plain(m.text).toLowerCase().match(/[\p{L}']+/u) || [''])[0];
    if(first.length > 2) opens.set(first, (opens.get(first) || 0) + 1);
  });
  const a = [...acts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(x => '„' + x[0] + '”');
  const o = [...opens.entries()].filter(x => x[1] >= 2).slice(0, 3).map(x => '„' + x[0] + '…”');
  if(!a.length && !o.length) return '';
  return `(Notă de stil, nu o menționa: ${a.length ? 'ai folosit recent gesturile ' + a.join(', ') : ''}${a.length && o.length ? '; ' : ''}${o.length ? 'ai început des cu ' + o.join(', ') : ''}. De data asta alege gesturi și un început diferite, proaspete.)`;
}
function gapText(ms){
  const h = Math.round(ms / 36e5);
  if(h < 24) return h === 1 ? 'o oră' : h + (h >= 20 ? ' de ore' : ' ore');
  const d = Math.round(h / 24); return d === 1 ? 'o zi' : d + (d >= 20 ? ' de zile' : ' zile');
}
function nowNote(){
  const d = new Date(), h = d.getHours();
  const zi = d.toLocaleDateString('ro-RO', {weekday:'long'}), data = d.toLocaleDateString('ro-RO', {day:'numeric', month:'long'});
  const parte = h < 5 ? 'noaptea târziu' : h < 11 ? 'dimineața' : h < 14 ? 'la prânz' : h < 18 ? 'după-amiaza' : h < 22 ? 'seara' : 'noaptea';
  const wk = [0, 6].includes(d.getDay()) ? ', weekend' : '';
  return `(acum e ${zi}, ${data}, ora ${hhmm(Date.now())}, ${parte}${wk})`;
}
// ultimele 2 poze trimise de utilizator merg ca imagini (personajul le vede); cele mai vechi rămân doar menționate
async function attachUserImages(ctx){
  let n = 0;
  for(let i = ctx.length - 1; i >= 0 && n < 2; i--){
    const x = ctx[i]; if(!x._img) continue;
    const b = await DB.get(x._img); if(!b) continue;
    try{ x.image = await blobToB64(b.type === 'image/jpeg' ? b : await toJpeg(b, 1280)); n++; }catch(e){}
  }
  ctx.forEach(x => delete x._img);
  return ctx;
}

async function send(){
  const t = $('#inp').value.trim();
  if(!t) return;
  if(busy){ toast('Așteaptă să termine ' + (live ? live.c.name : '') + '.'); return; }
  if(rec) rec.stop();
  $('#inp').value = ''; autoSize(); updateComposer();
  const um = {id:uid(), role:'user', text:t, ts:Date.now()};
  if(replyTo){ um.reply = replyTo; clearReply(); }
  chat.msgs.push(um);
  await saveChat(); renderMsgs(true);
  relBump(cur, 1, 'msg');
  await reply();
}
async function reply(target, opts = {}){
  const c = opts.c || cur, ch = opts.ch || chat;
  let m = target;
  if(suggAbort){ suggAbort.abort(); suggAbort = null; }
  $('#sugg').innerHTML = '';
  const keepIdx = m && opts.keep ? (m.alt || 0) : -1;   // 8.19: „🎰 +2”: varianta de acum rămâne în joc, se mai generează doar 2
  if(m){ m.alts = m.alts || [m.text]; m.alts.push(''); m.alt = m.alts.length - 1; m.text = ''; delete m.err; }
  else {
    m = {id:uid(), role:'ai', text:'', alts:[''], alt:0, ts:Date.now()};
    if(opts.pro){ m.pro = true; m.note = opts.note; }
    if(opts.sched) m.sched = true;
    if(opts.cont){ m.cont = true; m.note = `(Nu ți-am răspuns încă. Continuă tu firesc cu un mesaj nou, ca într-un chat: adaugă ceva, schimbă subiectul sau întreabă-mă ceva. Nu repeta ce ai spus deja.)`; }
    ch.msgs.push(m);
  }
  m.pending = true;
  const idx = ch.msgs.indexOf(m);
  // ritm realist: mesajul tău e „văzut”, apoi apare „scrie…”, apoi textul (cererea pleacă imediat, doar afișarea așteaptă)
  const um = target ? null : [...ch.msgs.slice(0, idx)].reverse().find(x => x.role === 'user');
  const fresh = um && !um.seen && !opts.pro && !opts.cont;
  busy = new AbortController(); live = {c, ch, typing:!fresh}; setBusyUI(true); if(chat === ch) renderMsgs(true);
  let showAt = 0, showT = null;
  const draw = () => { if(m.rec) return; if(Date.now() >= showAt){ delete m.hold; if(chat === ch) liveUpdate(m); } };
  if(fresh){
    m.hold = true;
    const seenIn = 350 + Math.random() * 500;
    showAt = Date.now() + seenIn + 650;
    setTimeout(() => {
      um.seen = true; um.seenAt = um.seenAt || Date.now();
      if(live && live.ch === ch){ live.typing = true; if(chat === ch){ setBusyUI(true); renderMsgs(); } }
    }, seenIn);
    showT = setTimeout(() => { if(m.pending && m.text) draw(); }, seenIn + 660);
  }
  try{
    const ctx = await attachUserImages(contextUpTo(idx, ch));
    if(m.note) ctx.push({role:'user', text:m.note});
    // ora și ziua merg doar în ultimul mesaj al tău (nu în promptul de sistem, ca să rămână în cache)
    const lastU = [...ctx].reverse().find(x => x.role === 'user');
    const ar = antiRepeat(ch, idx);
    if(lastU){
      // punctul de cache: ultimul mesaj al personajului dinaintea mesajului tău nou (istoricul de până acolo nu se mai schimbă)
      const li = ctx.lastIndexOf(lastU);
      for(let k = li - 1; k >= 0; k--) if(ctx[k].role === 'assistant'){ ctx[k]._cache = true; break; }
      let extra = turnExtras(c, ch, opts);
      if(!opts.cont){ const w = await weatherOf(c).catch(() => null); if(w) extra += ` (vremea reală la tine în ${w.city} acum: ${wxLine(w)}; ține cont de ea firesc, doar dacă se potrivește, fără să o tot pomenești)`; }
      const acts = (lastU.text.match(/\*[^*\n]{2,200}\*/g) || []).map(a => a.slice(1, -1).trim());
      if(acts.length) extra += ` (acțiunile mele de acum, care s-au întâmplat deja exact așa: ${acts.map(a => '„' + a + '”').join(', ')}; pornește de la starea de după ele, nu le contrazice și nu le rescrie, apoi reacționează în felul tău)`;
      const md = extra + (ch.mood && ch.mood.t ? ` (starea ta la ultimul mesaj: ${ch.mood.t}${Date.now() - ch.mood.ts > 3 * 36e5 ? ', acum ' + gapText(Date.now() - ch.mood.ts) : ''})` : '');
      if(opts.liveImg && !lastU.image && !lastU.images) lastU.image = opts.liveImg;   // 8.13: apel video: ce vede acum prin camera ta
      lastU.text = nowNote() + md + ' ' + lastU.text + (ar ? '\n\n' + ar : '') + (opts.fix ? `\n\n(Notă pentru răspunsul ăsta, nu o menționa: ${opts.fix}.)` : '');
    }
    let meta = {}, full;
    const lastCall = ch._callAt || ([...ch.msgs.slice(0, idx)].reverse().find(x => x.role === 'ai' && !x.err && x.ts) || {}).ts || 0;
    const cold = Date.now() - lastCall > 58 * 60e3;   // 8.19: cache-ul conversației a expirat: scriem ieftin (5 min), nu la 2×
    const solo = !!(opts.pro || opts.sched);         // 9.3: mesaj trimis singur, când lipsești: fără scriere în cache
    const why0 = {from:ch._lastFrom, sum:ch._lastSum, sys:ch._sys && ch._sys.text};
    if(opts.three && target){
      // prima variantă întâi (scrie cache-ul), apoi celelalte două în paralel; nu se afișează până nu alegi
      const sys = sysFor(c, ch), mk = () => ({}), metas = [mk(), mk(), mk()];
      const alt = (k) => { const cx = ctx.map(x => ({...x})); const l = [...cx].reverse().find(x => x.role === 'user'); if(l) l.text += k ? `\n\n(Pentru varianta asta alege o abordare diferită de prima idee care îți vine${k === 2 ? ', cu alt ton' : ''}.)` : ''; return cx; };
      const first = keepIdx >= 0 ? m.alts[keepIdx] : await stream(sys, alt(0), {max:LEN[S.len].max, signal:busy.signal, cid:c.id, meta:metas[0], tag:opts.tag, cold, conv:true});
      const rest = await Promise.all([1, 2].map(k => stream(sys, alt(k), {max:LEN[S.len].max, signal:busy.signal, cid:c.id, meta:metas[k], tag:opts.tag, conv:true}).catch(e => { if(e.name === 'AbortError') throw e; return ''; })));
      const outs = [first, ...rest].map(x => String(x || '').trim()).filter(Boolean);
      const pick = outs.length > 1 ? await pickVariant(outs, busy.signal) : 0;
      if(keepIdx >= 0 && pick === 0){   // ai rămas la varianta de dinainte: o păstrăm neatinsă, cele 2 noi rămân ca alternative (‹ ›)
        m.alts.pop(); m.am = m.am || {};
        for(const o of outs.slice(1)){ const t = faraLiniute(stripMood(stripReact(o)).replace(AI_VOICE, '')).trim(); if(t){ m.alts.push(t); m.am[m.alts.length - 1] = {voice:false, cut:''}; } }
        if(outs.length < 2) toast('N-au ieșit variante noi. Mai încearcă.', 3000);
        m.alt = keepIdx; m.text = m.alts[keepIdx]; delete m.pending; delete m.hold; clearTimeout(showT);
        busy = null; live = null; await saveChat(c, ch);
        if(chat === ch){ setBusyUI(false); renderMsgs(); }
        return;
      }
      full = outs[pick];
      meta = metas[[first, ...rest].map(x => String(x || '').trim()).indexOf(full)] || {};
      m._others = outs.filter((x, k) => k !== pick && !(keepIdx >= 0 && k === 0));
    } else full = await stream(sysFor(c, ch), ctx, {max:LEN[S.len].max, signal:busy.signal, cid:c.id, meta, tag:opts.tag, cold, conv:!solo,
      onText: t => { m.text = t;
        // mesaj vocal: textul nu apare pe ecran cât timp „înregistrează”
        if(!m.rec && S.vmsg !== 'off' && /^\s*(?:\[[^\]v][^\]]*\]\s*)?\[v/i.test(t)){ m.rec = m.hold = true; if(live){ live.rec = true; if(chat === ch) setBusyUI(true); } if(chat === ch) renderMsgs(); }
        draw(); }});
    ch._callAt = Date.now();
    // 9.3: de ce s-a rescris tot istoricul în cache (dacă s-a rescris): pentru Consum
    if(meta.u && !solo && meta.u.cw > 1500 && meta.u.cr < meta.u.cw){
      const why = cold ? 'pauza' : (why0.from !== undefined && why0.from !== ch._from) ? 'fereastra' : (ch._lastSum !== undefined && why0.sum !== (ch.summary || '')) ? 'rezumat' : (why0.sys && ch._sys && why0.sys !== ch._sys.text) ? 'prompt' : 'altele';
      noteRewrite(why);
    }
    ch._lastFrom = ch._from; ch._lastSum = ch.summary || '';
    m.text = faraLiniute(full.trim());
    { const sk = [...full.matchAll(STK_RE)].pop(); if(sk){ const x = (c.stickers || []).find(z => z.l.toLowerCase() === sk[1].trim().toLowerCase()); if(x) m._stk = x; } }
    delete m.corr; delete m.face; delete m.tr; delete m.trOn;   // o variantă nouă nu păstrează corecturile/traducerea celei vechi
    { const fx = full.match(/\[fa[țt][ăa]:\s*([^\]\n]{1,20})\]/i); if(fx) m.face = fx[1].trim(); }   // 8.16: expresia ei în apelul video
    { const cs = []; m.text = m.text.replace(CORR_RE, (a, x) => { cs.push(x.trim()); return ''; }); if(cs.length && learnOn(c)){ m.corr = cs; c.learn.log = (c.learn.log || []).concat(cs.map(t => ({t, ts:Date.now()}))).slice(-80); saveChars(); } }   // 8.15: corecturile din modul de învățare
    { const sh = [...full.matchAll(SHOT_RE)].pop(); if(sh) ch.nextShot = {t:sh[1].trim(), mid:m.id}; else if(ch.nextShot && ch.nextShot.mid === m.id) delete ch.nextShot; }
    if(!opts.sched && opts.tag !== 'apel' && !call){   // 8.18: a zis că te sună acum → te sună
      const sn = [...full.matchAll(SUN_RE)].pop(), said = stripMood(full);
      const promise = !sn && /\b(te\s+(sun|apelez|bag\s+pe\s+video)|ți\s+dau\s+(un\s+)?(telefon|apel|video)|te\s+caut\s+pe\s+(video|telefon))\b/i.test(said)
        && !/\b(m[âa]ine|poim[âa]ine|disear[ăa]|deseară|mai\s+t[âa]rziu|dup[ăa]\s+ce|c[âa]nd\s+ajung|la\s+\d{1,2}([:.]\d{2})?|peste\s+(o|\d+)\s+or)/i.test(said) && !/\?\s*$/.test(said.split(/[.!]/).pop() || '');
      if(sn || promise) callSoon(c, {video:sn ? /video/i.test(sn[1] || '') : /video/i.test(said), reason:'i-ai spus în chat că îl suni acum'});
    }
    if(!opts.sched) for(const x of full.matchAll(SCHED_RE)){ const sc = parseSched(x[1]); if(sc) addSched(c, ch, sc); }
    { const vd = [...m.text.matchAll(VERD_RE)].pop(); if(vd) m.verdict = vd[1].toLowerCase(); }
    { const pl = [...m.text.matchAll(PLOT_RE)].pop(); if(pl && !opts.sched){ const t = pl[1].trim(); ch.plot = /^(discuție liberă|nimic|-)$/i.test(t) ? null : {t, ts:Date.now()}; } else if(!pl && ch.plot && !opts.sched && Date.now() - ch.plot.ts < 3 * 36e5) ch.plot.ts = Date.now(); }
    { let mo = null; m.text.replace(MOOD_RE, (a, x) => { mo = x.trim(); return ''; });
      if(mo){ ch.mood = {t:mo, ts:Date.now()}; m.mood = mo; c.moodNow = {t:mo, ts:Date.now()}; }
      else if(ch.mood && ch.mood.t && !m.err && Date.now() - ch.mood.ts < 6 * 36e5){ ch.mood.ts = Date.now(); c.moodNow = {t:ch.mood.t, ts:Date.now()}; }   // 8.19: n-a rescris-o: e aceeași
      m.text = stripMood(m.text).trim(); }
    delete m.cut;
    // răspuns tăiat (limită de lungime, conexiune căzută sau oprit de furnizor): nu lăsăm un cuvânt rupt la final
    if(meta.stop && meta.stop !== 'end_turn' && meta.stop !== 'stop_sequence'){
      const t = trimToSentence(m.text);
      if(t) m.text = t;
      m.cut = meta.stop === 'refusal' ? 'refusal' : meta.stop === 'max_tokens' ? 'len' : 'net';
    }
    let rm = m.text.match(AI_REACT);
    if(rm) m.text = m.text.replace(AI_REACT, '').trim();
    if(AI_VOICE.test(m.text)){
      m.text = m.text.replace(AI_VOICE, '').trim();
      if(S.vmsg !== 'off'){ m.voice = true; m.text = m.text.replace(/\*[^*]*\*/g, ' ').replace(/\s{2,}/g, ' ').trim(); }
    } else delete m.voice;
    if(m.voice && m.text && S.tts !== 'tel'){
      if(live){ live.rec = true; if(chat === ch) setBusyUI(true); }
      try{ await recordVoice(c, m, busy.signal); }catch(e){ if(e.name === 'AbortError') throw e; toast('Vocea: ' + e.message, 4500); }
    }
    if(!rm){ rm = m.text.match(AI_REACT); if(rm) m.text = m.text.replace(AI_REACT, '').trim(); }
    if(rm && um && !target){ um.react = rm[1] === '❤' ? '❤️' : rm[1]; if(['❤️', '🥰'].includes(um.react) && chat === ch) setTimeout(() => fxBurst(um.react, 8), 400); }
    if(!m.text) throw new Error('Răspuns gol. Încearcă din nou.');
    const wait = showAt - Date.now();
    if(wait > 0) await sleep(wait);
  }catch(e){
    if(e.name === 'AbortError' && m.text) m.text = faraLiniute(stripMood(stripReact(m.text)).trim());
    if(!(e.name === 'AbortError' && m.text)){
      const msg = e.name === 'AbortError' ? 'Oprit.' : (e.message || 'Eroare');
      // o regenerare eșuată nu lasă o alternativă goală: revenim la cea de dinainte
      if(target && m.alts.length > 1){ m.alts.pop(); setAlt(m, m.alts.length - 1); if(e.name !== 'AbortError') toast('N-a mers: ' + msg, 3500); }
      else { m.err = msg; m.text = ''; }
    }
  }
  clearTimeout(showT); delete m.hold; delete m.rec;
  if(um){ um.seen = true; um.seenAt = um.seenAt || Date.now(); }
  m.alts[m.alt] = m.text; delete m.pending;
  if(m._others && !m.err){
    m.am = m.am || {};
    for(const o of m._others){ const t = faraLiniute(stripMood(stripReact(o)).replace(AI_VOICE, '')).trim(); if(t){ m.alts.push(t); m.am[m.alts.length - 1] = {voice:false, cut:''}; } }
  }
  delete m._others; m.ts = (opts.at && !m.err) ? opts.at : Date.now();   // mesajul programat poartă ora promisă
  if(!m.err && m._stk){ ch.msgs.push({id:uid(), role:'ai', sticker:{k:m._stk.k, l:m._stk.l}, ts:Date.now() + 1}); }
  delete m._stk;
  if(!m.err){ m.am = m.am || {}; m.am[m.alt] = {voice:!!m.voice, cut:m.cut || ''}; }
  busy = null; live = null;
  if(!m.err && !(chat === ch && !$('#vChat').hidden)) c.unread = (c.unread || 0) + 1;
  await saveChat(c, ch);
  if(!$('#vHome').hidden) renderHome();
  if(chat === ch){ setBusyUI(false); renderMsgs(); if(!m.err && navigator.vibrate && !document.hidden) try{ navigator.vibrate(12); }catch(e){} }
  else if(!busy && chat) setBusyUI(false);
  if(ch.dead) return;
  if(!m.err){
    summarizeIfNeeded(c, ch);
    ch.factCount = (ch.factCount || 0) + 1;
    if(ch.factCount >= 6){ ch.factCount = 0; bgAnalyze(c, ch); }   // 8.17: fapte + relație într-un singur apel
    if(canAutoPhoto(c) && (PHOTO_PROMISE.test(m.text) || (ch.nextShot && ch.nextShot.mid === m.id))){
      ch.sinceImg = 0;
      setTimeout(() => { if(chat === ch && !busy) askPhoto(true); }, 900);
    }
    else if(canAutoPhoto(c) && S.spont !== 'off' && !m.pro){
      ch.sinceImg = (ch.sinceImg || 0) + 1;
      if(ch.sinceImg >= (S.spont === 'des' ? 4 : 8) && Math.random() < .6){
        ch.sinceImg = 0;
        setTimeout(() => { if(chat === ch && !busy) askPhoto(true); }, 1500);
      }
    }
    pushPro(c, ch);   // 8.6: notificarea „îți scrie primul” se mută la PRO_H ore după ultimul mesaj
    if(chat === ch && S.voice === 'auto' && !m.voice) say(m.text, m);
    if(chat === ch && S.sugg === 'auto') suggest();
  }
}

/* sugestii de răspuns (ca în Botify) */
let suggAbort = null;
async function suggest(){
  if(busy || !aiReady() || !cur) return;
  const c = cur, ch = chat, box = $('#sugg');
  if(suggAbort) suggAbort.abort();
  suggAbort = new AbortController();
  box.innerHTML = '<span class="spin"></span>';
  const u = S.userName.trim() || 'utilizatorul';
  const recent = ch.msgs.slice(-10).filter(x => x.text && !x.err).map(x => (x.role === 'user' ? u : c.name) + ': ' + x.text).join('\n');
  try{
    const out = await stream('Ajuți un utilizator să continue o conversație. Scrii în română corectă, cu diacritice.', [{role:'user', text:
      `Personaj: ${c.name}${c.tag ? ' (' + c.tag + ')' : ''}.\n\nUltimele mesaje:\n${recent || '(început)'}\n\nPropune 3 replici scurte (max 14 cuvinte fiecare) pe care ${u} i le-ar putea scrie acum lui ${c.name}, ca ${u}, la persoana I. Variază: una curioasă, una jucăușă, una cu o acțiune între *asteriscuri*. Răspunde STRICT cu un array JSON de 3 texte.`}],
      {max:300, signal:suggAbort.signal, cid:c.id, aux:true});
    const a = out.indexOf('['), b = out.lastIndexOf(']');
    const arr = JSON.parse(out.slice(a, b + 1)).map(x => faraLiniute(String(x).trim())).filter(Boolean).slice(0, 3);
    if(chat !== ch || busy) return;
    box.innerHTML = arr.map((x, k) => `<button type="button" data-s="${k}">${fmt(x)}</button>`).join('');
    box.querySelectorAll('button').forEach(bt => bt.onclick = () => { $('#inp').value = arr[+bt.dataset.s]; autoSize(); updateComposer(); box.innerHTML = ''; $('#inp').focus(); });
  }catch(e){ if(e.name !== 'AbortError'){ box.innerHTML = ''; toast('Sugestiile n-au mers: ' + e.message, 3500); } }
}

/* memorie: fapte despre utilizator, per personaj */
async function extractFacts(c, ch){
  if(!aiReady()) return 0;
  const u = S.userName.trim() || 'utilizatorul';
  const recent = ch.msgs.slice(-14).filter(x => x.text && !x.err).map(x => (x.role === 'user' ? u : c.name) + ': ' + x.text).join('\n');
  if(!recent) return 0;
  const known = (c.facts || []).map(f => '- ' + f.t).join('\n') || '(nimic)';
  try{
    const out = await stream('Extragi informații factuale dintr-o conversație. Scrii în română, scurt.', [{role:'user', text:
      `Ce știe deja ${c.name} despre ${u}:\n${known}\n\nConversația recentă:\n${recent}\n\nScrie lucruri NOI, de trei feluri:
- "fapt": ceva durabil despre ${u}, spus de ${u} însuși (nume, job, oraș, familie, gusturi, lucruri importante povestite);
- "urmează": ceva ce urmează să i se întâmple lui ${u} și despre care merită întrebat mai târziu (un interviu mâine, o discuție cu șeful, un drum, o programare), cu momentul, dacă l-a spus;
- "glumă": o glumă internă, o poreclă sau o expresie care s-a născut între ${c.name} și ${u} și care poate fi reluată.
Fără ce se știe deja, fără ce face doar în scenă, fără presupuneri. Fiecare: o propoziție scurtă, max 14 cuvinte.
Răspunde STRICT cu un array JSON (poate fi gol []): [{"t":"…","tip":"fapt|urmează|glumă"}]`}], {max:500, cid:c.id, aux:true});
    const a = out.indexOf('['), b = out.lastIndexOf(']');
    const arr = JSON.parse(out.slice(a, b + 1)).map(x => typeof x === 'string' ? {t:x} : {t:x && x.t, k:x && /urm/i.test(x.tip || '') ? 'urm' : x && /gl/i.test(x.tip || '') ? 'gluma' : ''})
      .map(x => ({...x, t:faraLiniute(String(x.t || '').trim())})).filter(x => x.t).slice(0, 5);
    if(!arr.length) return 0;
    c.facts = (c.facts || []).concat(arr.map(x => ({t:x.t, ts:Date.now(), ...(x.k ? {k:x.k} : {})}))).slice(-40);
    await saveChars();
    return arr.length;
  }catch(e){ return 0; }
}

/* fire de conversație */
function threadsSheet(){
  const c = cur, ts = [...threadsOf(c)].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  openSheet(`<h4>🧵 Conversațiile cu ${esc(c.name)}</h4>` + ts.map(t => `<div class="thr">
      <button class="opt" data-t="${esc(t.id)}"><i>${t.id === c.thread ? '●' : '○'}</i><span>${esc(t.title)}<small>${esc(t.last || 'goală')}</small></span></button>
      <button class="ib" data-ren="${esc(t.id)}" aria-label="Redenumește">✏️</button>
      ${ts.length > 1 ? `<button class="ib" data-del="${esc(t.id)}" aria-label="Șterge">🗑️</button>` : ''}</div>`).join('') +
    `<div class="pad btns"><button class="btn pri" id="thNew">＋ Conversație nouă</button></div>`);
  const sh = $('.sheet');
  sh.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { closeSheet(); if(b.dataset.t !== c.thread) openChat(c.id, false, b.dataset.t); });
  sh.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => renameThread(b.dataset.ren));
  sh.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteThread(b.dataset.del));
  $('#thNew').onclick = () => { closeSheet(); newThread(); };
}
async function newThread(){
  const c = cur, ts = threadsOf(c);
  const t = {id:uid(), title:'Conversația ' + (ts.length + 1), lastAt:Date.now(), last:''};
  ts.push(t); c.thread = t.id;
  const ch = newChat(); ch.tid = t.id; if(c.greet) ch.msgs.push(greetMsg(c));
  await saveChat(c, ch);
  openChat(c.id, false, t.id);
  toast('Conversație nouă. Celelalte rămân în 🧵.');
}
function renameThread(tid){
  const t = threadsOf(cur).find(x => x.id === tid); if(!t) return;
  openSheet(`<h4>Redenumește</h4><div class="pad"><input id="shTxt" value="${esc(t.title)}" maxlength="40">
    <div class="btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="shOk">Salvează</button></div></div>`);
  $('#shOk').onclick = async () => { const v = $('#shTxt').value.trim(); if(v){ t.title = v; await saveChars(); } closeSheet(); $('#chTag').textContent = tagLine(cur); };
}
function deleteThread(tid){
  const c = cur, t = threadsOf(c).find(x => x.id === tid); if(!t) return;
  confirmSheet(`Ștergi „${t.title}"? Mesajele și pozele din ea dispar.`, 'Șterge', async () => {
    if(busy && live && live.c === c && (live.ch.tid || 'main') === tid){ live.ch.dead = true; busy.abort(); }
    if(chat && (chat.tid || 'main') === tid && cur === c) chat.dead = true;
    const ch = await DB.get(chatKey(c.id, tid));
    if(ch) for(const m of ch.msgs) await purgeMsg(m, c);
    await DB.del(chatKey(c.id, tid));
    c.threads = c.threads.filter(x => x.id !== tid);
    const next = [...c.threads].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0];
    c.thread = next.id; c.last = next.last; c.lastAt = next.lastAt;
    await saveChars();
    openChat(c.id, false, next.id);
  });
}
async function allChats(c){
  const out = [];
  for(const t of threadsOf(c)){ const ch = await DB.get(chatKey(c.id, t.id)); if(ch) out.push(ch); }
  return out;
}

/* consum */
function priceFor(model){
  const m = String(model || '').toLowerCase();
  let p = m.includes('opus') ? [4, 20] : m.includes('haiku') ? [1, 5] : [2, 10];
  if(S.prov !== 'anthropic') p = [0, 0];
  const pin = parseFloat(String(S.pIn).replace(',', '.')), pout = parseFloat(String(S.pOut).replace(',', '.'));
  const main = S.prov !== 'anthropic' || !m.includes('haiku') || String(S.model || '').toLowerCase().includes('haiku');
  if(main){ if(!isNaN(pin)) p[0] = pin; if(!isNaN(pout)) p[1] = pout; }   // prețul tău personalizat e pentru modelul principal
  return p;
}
function imgPrice(){
  const v = parseFloat(String(S.imgCost).replace(',', '.'));
  if(!isNaN(v)) return v;
  if(lastImgProv === 'fal') return .035;
  if(S.imgProv === 'worker' && S.cfPlan === 'paid'){ const n = neurPerPhoto(lastImgModel || S.wkModel) || 5000; return neurToday >= 10000 ? n * NEUR_USD : 0; }
  return {gemini:.04, fal:.035, worker:0}[S.imgProv] || 0;
}
let usageQ = Promise.resolve();
function noteRewrite(why){
  usageQ = usageQ.then(async () => {
    const u = await DB.get('usage') || {months:{}, chars:{}}, mo = new Date().toISOString().slice(0, 7);
    const M = u.months[mo] = u.months[mo] || {txt:0, img:0, n:0};
    M.rw = M.rw || {}; M.rw[why] = (M.rw[why] || 0) + 1;
    await DB.set('usage', u);
  }).catch(() => {});
}
function addUsage(cid, usd, kind, tok, tag){
  tag = tag || (kind === 'img' ? 'poze' : kind === 'voc' ? 'voce' : 'chat');
  usageQ = usageQ.then(async () => {
    const u = await DB.get('usage') || {months:{}, chars:{}};
    const mo = new Date().toISOString().slice(0, 7);
    const M = u.months[mo] = u.months[mo] || {txt:0, img:0, n:0};
    M.by = M.by || {}; M.by[tag] = (M.by[tag] || 0) + usd;   // 8.17: pe ce se duc banii
    if(kind === 'img'){ M.img += usd; M.n++; } else if(kind === 'voc'){ M.voc = (M.voc || 0) + usd; M.vn = (M.vn || 0) + 1; } else M.txt += usd;
    if(tok){ for(const k of ['inp', 'cw', 'cr', 'out', 'saved']) M[k] = (M[k] || 0) + (tok[k] || 0); M.calls = (M.calls || 0) + 1; if(tok.main) M.mcalls = (M.mcalls || 0) + 1;
      M.tk = M.tk || {}; const T = M.tk[tag] = M.tk[tag] || {inp:0, cw:0, cr:0, out:0, n:0}; for(const k of ['inp', 'cw', 'cr', 'out']) T[k] += tok[k] || 0; T.n++; }
    if(cid) u.chars[cid] = (u.chars[cid] || 0) + usd;
    await DB.set('usage', u);
  }).catch(() => {});
}
function recordTokens(cid, usage, model, tag, mult = 1){
  if(!usage) return;
  model = model || (S.prov === 'anthropic' ? S.model : S.oaModel);
  const [pin, pout] = priceFor(model);
  const inp = usage.input_tokens || usage.prompt_tokens || 0, out = usage.output_tokens || usage.completion_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0, cr = usage.cache_read_input_tokens || 0;
  const cw1h = usage.cache_creation ? (usage.cache_creation.ephemeral_1h_input_tokens || 0) : 0, cw5 = cw - cw1h;
  const m = String(model).toLowerCase(), rd = /fable|mythos/.test(m) ? .025 : /(sonnet|opus)-5-5/.test(m) ? .05 : .1;   // prețul citirii din cache diferă pe model
  const usd = (inp * pin + cw5 * pin * 1.25 + cw1h * pin * 2 + cr * pin * rd + out * pout) / 1e6 * mult;
  addUsage(cid, usd, 'txt', {inp, cw, cr, out, saved: cr * pin * (1 - rd) / 1e6 * mult, main: model === modelFor(false)}, tag);
}
const usd = v => '$' + (v < 10 ? v.toFixed(3) : v.toFixed(2));
async function renderCost(){
  const u = await DB.get('usage') || {months:{}, chars:{}};
  const mo = new Date().toISOString().slice(0, 7);
  const n0 = new Date(), d = new Date(Date.UTC(n0.getUTCFullYear(), n0.getUTCMonth() - 1, 1));
  const M = u.months[mo] || {txt:0, img:0, n:0}, P = u.months[d.toISOString().slice(0, 7)];
  const top = Object.entries(u.chars).map(([id, v]) => [charById(id), v]).filter(x => x[0]).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const tot = X => X.txt + X.img + (X.voc || 0);
  $('#stCostMini').textContent = 'Luna aceasta: ' + usd(tot(M));
  const totIn = (M.inp || 0) + (M.cw || 0) + (M.cr || 0), pc = totIn ? Math.round((M.cr || 0) / totIn * 100) : 0;
  $('#stCost').innerHTML = `<b>${usd(tot(M))}</b>luna aceasta · text ${usd(M.txt)} · poze ${usd(M.img)} (${M.n})${M.voc ? ` · voce ${usd(M.voc)} (${M.vn})` : ''}
    ${totIn ? `<div class="row2"><span>Context citit din cache</span><span>${pc}%</span></div><div class="row2"><span>Economisit prin cache</span><span style="color:var(--ok)">${usd(M.saved || 0)}</span></div><div class="row2"><span>Cost mediu pe mesaj</span><span>${usd(M.txt / Math.max(1, M.mcalls || M.calls || 1))}</span></div>` : ''}
    ${(() => { const by = Object.entries(M.by || {}).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]); if(!by.length) return ''; const mx = by[0][1];
      const L = {chat:['💬', 'Conversații'], apel:['📞', 'Apeluri'], poze:['📷', 'Poze în chat'], stories:['📸', 'Stories'], statusuri:['📱', 'Statusuri'], voce:['🎙️', 'Voce'], fundal:['⚙️', 'Fundal (memorie, relație, planuri)'], jurnal:['📔', 'Jurnal'], profil:['🖼️', 'Portrete, avatar, stickere'], pozeai:['🧠', 'Poze: plan și verificare (AI)']};
      const tk = M.tk || {}, kf = n => n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',') + 'k' : String(Math.round(n));
      const cp = k => { const T = tk[k]; if(!T || !T.n) return ''; const all = T.inp + T.cw + T.cr;
        const rw = k === 'chat' && M.rw ? Object.entries(M.rw).sort((a, b) => b[1] - a[1]) : [];
        const RW = {pauza:'pauză de peste o oră', fereastra:'fereastra s-a mutat', rezumat:'rezumat nou', prompt:'s-a refăcut fișa personajului', altele:'altceva (mesaj editat, reacție, poză)'};
        const rwl = rw.length ? `<br>Rescrieri complete ale istoricului: ${rw.map(([w, n]) => n + ' × ' + (RW[w] || w)).join(' · ')}` : '';
        return `<div style="font-size:12px;color:var(--tx3);margin:-4px 0 8px 26px">${T.n} apeluri (din 9.0)${all ? ` · cache ${Math.round(T.cr / all * 100)}% · ~${kf(all / T.n)} intrare (${kf(T.cw / T.n)} scris în cache) · ~${kf(T.out / T.n)} ieșire pe apel` : ''}${rwl}</div>`; };
      return `<div class="cbreak"><div class="cbh">Unde se duc banii luna asta</div>${by.map(([k, v]) => `<div class="cbr"><span>${(L[k] || ['•', k])[0]} ${esc((L[k] || ['', k])[1])}</span><div class="cbb"><i style="width:${Math.max(3, v / mx * 100)}%"></i></div><b>${usd(v)}</b></div>${cp(k)}`).join('')}</div>`; })()}
    ${P ? `<div class="row2"><span>Luna trecută</span><span>${usd(tot(P))}</span></div>` : ''}
    ${top.map(([c, v]) => `<div class="row2"><span>${esc(c.name)}</span><span>${usd(v)}</span></div>`).join('')}`;
}

/* poze: ＋ (cere de la personaj, galerie, cameră), salvare și partajare */
function plusMenu(){
  if(busy && live && live.ch === chat){ toast('Așteaptă răspunsul.'); return; }
  const o = [];
  if(S.imgProv !== 'none') o.push(['📷', `Cere o poză de la ${cur.name}`, () => askPhoto()]);
  if(S.imgProv !== 'none' && cur.photo) o.push(['👫', S.userPhoto ? `Fă o poză împreună cu ${cur.name}` : 'Poză împreună (pune-ți întâi poza în Setări)', () => S.userPhoto ? askPhoto(false, null, null, {together:true}) : (openSettings(), openSetPanel('me'))]);
  if((cur.stickers || []).length || (cur.aiPortrait && S.imgProv !== 'none' && cur.photo)) o.push(['😺', (cur.stickers || []).length ? 'Trimite un sticker' : 'Stickere cu ' + cur.name, stickerSheet]);   // 8.9.3: doar unde se pot face
  o.push(['🎁', `Trimite-i un cadou lui ${cur.name}`, giftSheet]);
  o.push(['🖼️', 'Trimite o poză din galerie', () => $('#fGal').click()]);
  o.push(['📸', 'Fă o poză cu camera', () => $('#fCam').click()]);
  if(S.imgProv === 'none') o.push(['⚙️', 'Pornește pozele de la personaje (Setări)', openSettings]);
  sheet(o);
}
let pendingPic = null;
async function pickedImage(file){
  if(!file) return;
  let b;
  try{ b = await toJpeg(file, 1600, .88); }catch(e){ toast('Nu pot citi poza.'); return; }
  pendingPic = b;
  const u = URL.createObjectURL(b);
  openSheet(`<h4>Trimite poza către ${esc(cur.name)}</h4><div class="pad">
    <img class="prev" src="${u}" alt="">
    <textarea id="shTxt" rows="2" placeholder="Scrie ceva (opțional)">${esc($('#inp').value.trim())}</textarea>
    <div class="btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="shOk">Trimite</button></div></div>`);
  $('#shOk').onclick = async () => {
    if(busy){ toast('Așteaptă să termine răspunsul, apoi apasă din nou Trimite.'); return; }
    const cap = $('#shTxt').value.trim(); closeSheet();
    const k = await saveImg(pendingPic); pendingPic = null;
    $('#inp').value = ''; autoSize(); updateComposer();
    const um = {id:uid(), role:'user', text:cap, img:k, ts:Date.now()};
    if(replyTo){ um.reply = replyTo; clearReply(); }
    chat.msgs.push(um);
    await saveChat(); renderMsgs(true);
    reply();
  };
}
function picName(k, b){
  const ext = /png/.test(b.type) ? 'png' : /webp/.test(b.type) ? 'webp' : 'jpg';
  const who = (cur && cur.name || 'Taifas').replace(/[^\p{L}\p{N}]+/gu, '-');
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `Taifas-${who}-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.${ext}`;
}
async function saveImage(k){
  const b = await DB.get(k); if(!b){ toast('Poza nu mai există.'); return; }
  download(b, picName(k, b));
  toast('Poza se salvează în Descărcări.');
}
function canShareFiles(){
  try{ return !!(navigator.canShare && navigator.canShare({files:[new File([new Blob(['x'], {type:'image/png'})], 'x.png', {type:'image/png'})]})); }catch(e){ return false; }
}
async function shareImage(k){
  const b = await DB.get(k); if(!b) return;
  const f = new File([b], picName(k, b), {type:b.type || 'image/jpeg'});
  try{ await navigator.share({files:[f]}); }catch(e){ if(e.name !== 'AbortError') saveImage(k); }
}

/* dictare vocală (recunoașterea vorbirii din browser, română) */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const MIC_SVG = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
let rec = null;
function toggleMic(){
  if(rec){ rec.stop(); return; }
  if(!SpeechRec){ toast('Browserul nu suportă dictarea.'); return; }
  try{ speechSynthesis?.cancel(); }catch(e){}
  const r = new SpeechRec();
  r.lang = 'ro-RO'; r.interimResults = true; r.continuous = true;
  const base = $('#inp').value.trim();
  r.onresult = e => {
    let t = '';
    for(let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    t = t.trim();
    if(t) t = t[0].toUpperCase() + t.slice(1);
    $('#inp').value = (base ? base + ' ' : '') + t; autoSize();
  };
  r.onerror = e => {
    if(e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Permite accesul la microfon pentru Taifas.', 3500);
    else if(e.error !== 'no-speech' && e.error !== 'aborted') toast('Dictarea s-a oprit: ' + e.error);
  };
  r.onend = () => { rec = null; $('#btnMic').classList.remove('rec'); $('#btnMic').innerHTML = MIC_SVG; updateComposer(); };
  rec = r;
  $('#btnMic').classList.add('rec'); $('#btnMic').innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
  try{ r.start(); }catch(e){ r.onend(); toast('Nu pot porni microfonul.'); }
}

/* căutare în conversații */
const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function snippet(text, q){
  const t = String(text).replace(/\s+/g, ' '), n = norm(t), k = n.indexOf(q);
  if(k < 0) return esc(t.slice(0, 160));
  const a = Math.max(0, k - 60), b = Math.min(t.length, k + q.length + 90);
  return (a ? '…' : '') + esc(t.slice(a, k)) + '<mark>' + esc(t.slice(k, k + q.length)) + '</mark>' + esc(t.slice(k + q.length, b)) + (b < t.length ? '…' : '');
}
async function searchAll(q, onlyId){
  const out = [];
  for(const c of chars){
    if(onlyId && c.id !== onlyId) continue;
    for(const t of threadsOf(c)){
      const ch = (live && live.c === c && (live.ch.tid || 'main') === t.id) ? live.ch : await DB.get(chatKey(c.id, t.id));
      if(!ch) continue;
      for(const m of ch.msgs) if(m.text && norm(m.text).includes(q)) out.push({c, t, m});
    }
  }
  return out.sort((a, b) => (b.m.ts || 0) - (a.m.ts || 0)).slice(0, 80);
}
function openSearch(onlyId){
  const who = onlyId ? charById(onlyId) : null;
  openSheet(`<h4>🔎 Caută ${who ? 'în conversațiile cu ' + esc(who.name) : 'în toate conversațiile'}</h4>
    <div class="srch"><input id="srIn" placeholder="cuvânt sau frază" autocomplete="off" enterkeyhint="search"></div>
    ${who ? '<div class="pad" style="margin:-2px 0 8px"><button class="btn sm" id="srAll">Caută peste tot</button></div>' : ''}
    <div id="srRes"><p>Scrie cel puțin 2 litere.</p></div>`);
  const inp = $('#srIn'); setTimeout(() => inp.focus(), 50);
  if(who) $('#srAll').onclick = () => { const v = inp.value; closeSheet(); openSearch(); $('#srIn').value = v; $('#srIn').dispatchEvent(new Event('input')); };
  let tm = null, seq = 0;
  inp.addEventListener('input', () => {
    clearTimeout(tm);
    tm = setTimeout(async () => {
      const q = norm(inp.value.trim()), my = ++seq, box = $('#srRes');
      if(!box) return;
      if(q.length < 2){ box.innerHTML = '<p>Scrie cel puțin 2 litere.</p>'; return; }
      box.innerHTML = '<p><span class="spin"></span></p>';
      const res = await searchAll(q, onlyId);
      if(my !== seq || !$('#srRes')) return;
      if(!res.length){ box.innerHTML = '<p>Nimic găsit.</p>'; return; }
      const u = S.userName.trim() || 'Tu';
      box.innerHTML = `<p style="margin-bottom:4px">${res.length}${res.length === 80 ? '+' : ''} rezultate</p>` + res.map((r, k) => `<button class="res" data-r="${k}">
        <div class="h">${avatarHTML(r.c)}<b>${esc(r.c.name)}</b>${threadsOf(r.c).length > 1 ? ' · ' + esc(r.t.title) : ''} · ${when(r.m.ts)}</div>
        <div class="t">${r.m.role === 'user' ? '<b>' + esc(u) + ':</b> ' : ''}${snippet(r.m.text, q)}</div></button>`).join('');
      hydrate(box);
      box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const r = res[+b.dataset.r]; closeSheet(); jumpTo(r.c.id, r.t.id, r.m.id); });
    }, 220);
  });
}
async function jumpTo(cid, tid, mid){
  const same = cur && cur.id === cid && chat && (chat.tid || 'main') === tid && !$('#vChat').hidden;
  if(!same) await openChat(cid, $('#vChat').hidden, tid);
  const i = chat.msgs.findIndex(m => m.id === mid); if(i < 0) return;
  if(msgFor === chat && i < msgStart){ msgStart = Math.max(0, i - 10); renderMsgs(false, true); }
  const el = $(`#msgs .mw[data-i="${i}"]`); if(!el) return;
  el.scrollIntoView({block:'center'});
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

/* profilul personajului */
let profId = null;
/* 8.5: profilul pe file (Despre / Poze / Memorie) + etichete sub nume */
let profTab = 'despre';
function pfChips(c){
  const online = c.lastAt && Date.now() - c.lastAt < 10 * 60e3, lf = lifeNow(c), mood = c.moodNow && Date.now() - c.moodNow.ts < 12 * 36e5 ? c.moodNow.t : '';
  const ch = [online ? '<span class="on">● online</span>' : '', c.rel ? `<span>💞 ${esc(relOf(c).name)}</span>` : '', lf && lf.w ? `<span>${LIFE_E[lf.b]} ${esc(lf.w)}</span>` : '', mood ? `<span>${esc(mood)}</span>` : ''].filter(Boolean).join('');
  return ch ? `<div class="hchips pfchips">${ch}</div>` : '';
}
function pfTabsInit(){
  const body = $('#pfBody'), tabs = $('#pfTabs'); if(!body || !tabs) return;
  const of = sec => sec.querySelector('#pfPics,#pfAv,#pfStk,.pfGal') ? 'poze' : sec.querySelector('#pfPrefs,#pfMem,#pfJrn,#pfFacts') ? 'memorie' : 'despre';
  const secs = [...body.querySelectorAll('.pfSec')];
  secs.forEach(x => x.dataset.pt = of(x));
  const gal = secs.find(x => x.querySelector('.pfGal')), pics = secs.find(x => x.querySelector('#pfPics'));
  if(gal && pics) pics.before(gal);          // galeria e prima în „Poze”
  if(pics) pics.querySelector('h3') && (pics.querySelector('h3').innerHTML = '<span>⚙️ Poze trimise în chat</span>');
  const set = t => { profTab = t; tabs.querySelectorAll('[data-pt]').forEach(b => b.classList.toggle('on', b.dataset.pt === t)); secs.forEach(x => x.hidden = x.dataset.pt !== t); };
  tabs.querySelectorAll('[data-pt]').forEach(b => b.onclick = () => { set(b.dataset.pt); const y = tabs.offsetTop - 70; if($('#pfScroll').scrollTop > y) $('#pfScroll').scrollTo({top:y, behavior:'smooth'}); });
  set(profTab);
}
async function charProfile(id, push = true){
  const c = charById(id); if(!c) return;
  profId = id;
  const chats = await allChats(c);
  const picsM = chats.flatMap(ch => ch.msgs.filter(m => m.img && m.role === 'ai').map(m => ({k:m.img, ts:m.ts, scene:m.scene}))).sort((a, b) => b.ts - a.ts);
  for(const fp of feedCache.filter(x => x.cid === id && x.img && !picsM.some(y => y.k === x.img))) picsM.push({k:fp.img, ts:fp.ts, scene:fp.scene, story:fp.story});
  picsM.sort((a, b) => b.ts - a.ts);
  const pics = picsM.map(x => x.k), picMeta = Object.fromEntries(picsM.map(x => [x.k, x]));
  if(push) profTab = pics.length ? 'poze' : 'despre';
  // 8.9: momente (ca evidențierile de pe Instagram): pozele grupate pe zile
  const hiDays = []; for(const x of picsM){ const d = dayKey(x.ts); let g = hiDays.find(h => h.d === d); if(!g){ if(hiDays.length >= 10) continue; g = {d, items:[]}; hiDays.push(g); } g.items.push(x); }
  const hiLabel = d => { const n = daysSince(new Date(d + 'T12:00').getTime()); return n === 0 ? 'Azi' : n === 1 ? 'Ieri' : new Date(d + 'T12:00').toLocaleDateString('ro-RO', {day:'numeric', month:'short'}); };
  const hasStory = storyLive().some(x => x.cid === id), storyUn = storyLive().some(x => x.cid === id && !x.sv);
  const msgs = chats.reduce((n, ch) => n + ch.msgs.filter(m => !m.err && (m.text || m.img)).length, 0);
  const first = Math.min(c.created || Date.now(), ...chats.flatMap(ch => ch.msgs.map(m => m.ts || Date.now())));
  const days = Math.max(1, Math.ceil((Date.now() - first) / 864e5));
  const spent = ((await DB.get('usage') || {}).chars || {})[id] || 0;
  const u = S.userName.trim() || 'tine';
  const fromChat = !$('#vChat').hidden && cur && cur.id === id;
  $('#pfTopName').textContent = c.name;
  $('#pfBody').innerHTML = `
    <div class="pfHero">${c.photo ? `<img data-k="${esc(c.photo)}" data-view="${esc(c.photo)}" alt="">` : `<div class="ph" style="background:${colorFor(c)}">${esc(c.name[0])}</div>`}</div>
    <div class="igHead">
      <button class="igAv${hasStory ? ' ring' + (storyUn ? ' un' : '') : ''}" id="pfAvBtn" aria-label="${hasStory ? 'Vezi story-ul' : 'Poza de profil'}">${avatarHTML(c)}</button>
      <div class="igStats">
        <div><b>${msgs.toLocaleString('ro-RO')}</b><small>mesaje</small></div>
        <div><b>${days}</b><small>${days === 1 ? 'zi' : 'zile'}</small></div>
        <div><b>${pics.length}</b><small>${pics.length === 1 ? 'poză' : 'poze'}</small></div>
      </div>
    </div>
    <div class="igBio"><h1>${esc(c.name)}</h1>${c.tag ? `<p class="igTag">${esc(c.tag)}</p>` : ''}${c.persona ? `<p class="clamp3" id="pfAbout">${esc(c.persona)}</p><button class="more" id="pfMore" hidden>mai mult</button>` : ''}${pfChips(c)}</div>
    <div class="igActs">
      <button class="btn pri" id="pfChat">💬 ${fromChat ? 'Înapoi la chat' : 'Mesaj'}</button>
      <button class="btn" id="pfCall" aria-label="Sună">📞</button>
      <button class="btn" id="pfGift" aria-label="Cadou">🎁</button>
      <button class="btn" id="pfPhone" aria-label="Telefonul lui">📱</button>
      <button class="btn" id="pfFav" aria-label="Favorit">${c.fav ? '★' : '☆'}</button>
    </div>
    ${hiDays.length ? `<div class="igHi">${hiDays.map((h, k) => `<button data-hi="${k}"><span><img data-k="${esc(h.items[0].k)}" alt=""></span><small>${esc(hiLabel(h.d))}</small></button>`).join('')}</div>` : ''}
    <div class="pftabs ig" id="pfTabs"><button data-pt="poze"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Poze</button><button data-pt="despre">✨ Despre</button><button data-pt="memorie">🧠 Memorie</button></div>
    <div class="pfSec igGrid"><div class="pfGal">${pics.length ? pics.map(k => `<button data-view="${esc(k)}">${picMeta[k].story ? '<i>📸</i>' : ''}<img data-k="${esc(k)}" alt="" loading="lazy"></button>`).join('') : ''}</div>${pics.length ? '' : `<p class="igEmpty">📷<br>Încă nicio poză de la ${esc(c.name)}.<br><small>Cere-i una din ＋ în conversație.</small></p>`}</div>
    ${c.aspect ? `<div class="pfSec"><h3>Cum arată</h3><p>${esc(c.aspect)}</p></div>` : ''}
    <div class="pfSec"><h3><span>💞 Relația voastră</span></h3><div class="relbox"><span class="lv" id="pfRelName"></span><small id="pfRelSub"></small><button class="btn sm" id="pfRelSet" style="margin-left:auto">Schimbă</button></div><div class="relbar"><i id="pfRelBar"></i></div><div id="pfBond" class="bond"></div></div>
    <div class="pfSec" id="pfPrefsSec"><h3>🎯 Ce a învățat din notele tale</h3><ul class="facts" id="pfPrefs"></ul></div>
    <div class="pfSec"><h3><span>📍 Orașul ${esc(c.name)}</span></h3><div class="cityrow"><input id="pfCity" placeholder="ex. Brașov" value="${esc(c.city || '')}" autocomplete="off"><button class="btn sm" id="pfCitySave">Salvează</button></div><p class="hint" id="pfWx">Vremea reală de acolo intră în conversații și în poze (Open-Meteo, gratuit).</p></div>
    <div class="pfSec"><h3><span>🗓️ Ziua ${esc(c.name)}</span></h3><div id="pfLife"></div></div>
    <div class="pfSec"><h3><span>🎂 Viața și planurile</span></h3><div id="pfAgenda"></div></div>
    <div class="pfSec"><h3><span>💝 Amintiri</span></h3><div id="pfMem"></div></div>
    <div class="pfSec"><h3><span>📷 Poze de la ${esc(c.name)}</span></h3><div id="pfPics"></div></div>
    <div class="pfSec"><h3><span>🖼️ Avatar viu</span></h3><div id="pfAv"></div></div>
    <div class="pfSec"><h3><span>😺 Stickere</span></h3><div id="pfStk"></div></div>
    <div class="pfSec"><h3>🎙️ Vocea</h3><div class="pfVoice"><span id="pfVName">${esc(voiceLabel(c))}</span><button class="btn sm" id="pfVPlay">▶ Ascultă</button><button class="btn sm" id="pfVPick">Schimbă</button></div></div>
    <div class="pfSec"><h3><span>📔 Jurnal</span></h3><div id="pfJrn"></div>
      <div class="btns jbtn"><button class="btn sm" id="pfJrnToday">✍️ Scrie despre azi</button>${(c.journal || []).length > 3 ? '<button class="btn sm" id="pfJrnAll">Vezi tot</button>' : ''}</div></div>
    <div class="pfSec"><h3><span>🧠 Ce știe despre ${esc(u)} · ${(c.facts || []).length}</span></h3>
      <ul class="facts" id="pfFacts"></ul>
      <div class="addfact"><input id="pfFactIn" placeholder="Adaugă ceva ce să știe"><button class="btn sm" id="pfFactAdd">＋</button><button class="btn sm" id="pfFactScan" title="Caută fapte noi în conversație">🔄</button></div>
    </div>
    <div class="pfFoot">Creat pe ${new Date(c.created || first).toLocaleDateString('ro-RO', {day:'numeric', month:'long', year:'numeric'})} · cost estimat ${usd(spent)}</div>`;
  const body = $('#pfBody');
  hydrate(body);
  show('vProf', push);
  $('#pfScroll').scrollTop = 0; profScroll();
  const ab = $('#pfAbout'); if(ab) requestAnimationFrame(() => { if(ab.scrollHeight > ab.clientHeight + 4){ $('#pfMore').hidden = false; $('#pfMore').onclick = () => { ab.classList.remove('clamp3'); $('#pfMore').hidden = true; }; } });
  body.onclick = e => { const v = e.target.closest('[data-view]'); if(v) viewImg(v.dataset.view, pics.includes(v.dataset.view) ? pics : [v.dataset.view], picMeta); };
  const drawFacts = () => {
    $('#pfFacts').innerHTML = (c.facts || []).length ? c.facts.map((f, k) => `<li><span>${f.k === 'urm' ? '🗓️ ' : f.k === 'gluma' ? '😄 ' : ''}${esc(f.t)}</span><button data-fx="${k}" aria-label="Șterge">✕</button></li>`).join('')
      : `<li><span style="color:var(--tx3)">Încă nimic. Se completează singur din conversații, la câteva mesaje.</span></li>`;
    $('#pfFacts').querySelectorAll('[data-fx]').forEach(b => b.onclick = async () => { c.facts.splice(+b.dataset.fx, 1); await saveChars(); drawFacts(); });
  };
  drawFacts();
  const jHTML = list => list.map(j => `<div class="jentry"><b>${new Date(j.day + 'T12:00').toLocaleDateString('ro-RO', {weekday:'long', day:'numeric', month:'long'})}</b><p>${esc(j.text)}</p></div>`).join('');
  const drawJ = () => { const js = (c.journal || []).slice(0, 3); $('#pfJrn').innerHTML = js.length ? jHTML(js) : `<p style="color:var(--tx3);font-size:.88rem">Încă nicio pagină. ${esc(c.name)} scrie aici singur, a doua zi, despre fiecare zi în care ați vorbit (cel puțin 4 mesaje). Pentru azi, apasă „Scrie despre azi”.</p>`; };
  drawJ();
  $('#pfJrnToday').onclick = async () => {
    const b = $('#pfJrnToday'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Scrie…';
    try{ const t = await writeJournal(c, dayKey(Date.now()), true); if(!t) toast('N-am putut scrie pagina de azi (prea puține mesaje sau un răspuns nepotrivit). Mai încearcă.', 4000); drawJ(); }catch(e){ toast('N-a mers: ' + e.message, 3500); }
    b.disabled = false; b.textContent = '✍️ Scrie despre azi';
  };
  const ja = $('#pfJrnAll'); if(ja) ja.onclick = () => openSheet(`<h4>📔 Jurnal · ${esc(c.name)}</h4><div class="pad">${jHTML(c.journal || [])}</div>`);
  $('#pfFactAdd').onclick = async () => { const v = $('#pfFactIn').value.trim(); if(!v) return; c.facts = (c.facts || []).concat({t:v, ts:Date.now()}); $('#pfFactIn').value = ''; await saveChars(); drawFacts(); };
  $('#pfFactScan').onclick = async () => {
    const b = $('#pfFactScan'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    const ch = (chat && cur && cur.id === id) ? chat : await loadChat(c, c.thread || 'main');
    const n = await extractFacts(c, ch); drawFacts(); toast(n ? n + ' lucruri noi reținute.' : 'Nimic nou de reținut.');
    b.disabled = false; b.textContent = '🔄';
  };
  const drawRel = () => { const r = relOf(c), lk = c.rel && c.rel.lock; $('#pfRelName').textContent = r.name; $('#pfRelSub').textContent = `nivel ${r.lv} din ${RELS.length}` + (lk ? ' · 🔒 fixat' : r.next ? ` · ${r.pc}% până la „${r.next}”` : ''); $('#pfRelBar').style.width = (lk ? 100 : r.pc) + '%'; };
  relInit(c).then(drawRel); drawBond(c);
  $('#pfRelSet').onclick = () => relSheet(c, drawRel);
  const drawPrefs = () => {
    const ps = c.prefs || [], lk = c.liked || [];
    $('#pfPrefs').innerHTML = ps.map((x, k) => `<li><span>${esc(x.t)}</span><button data-px="${k}" aria-label="Șterge">✕</button></li>`).join('')
      + lk.map((x, k) => `<li><span>👍 „${esc(x.length > 90 ? x.slice(0, 90) + '…' : x)}”</span><button data-lx="${k}" aria-label="Șterge">✕</button></li>`).join('')
      || `<li><span style="color:var(--tx3)">Încă nimic. Folosește 👍 / 👎 sub răspunsuri și ${esc(c.name)} învață ce-ți place.</span></li>`;
    $('#pfPrefs').querySelectorAll('[data-px]').forEach(b => b.onclick = async () => { c.prefs.splice(+b.dataset.px, 1); await saveChars(); drawPrefs(); });
    $('#pfPrefs').querySelectorAll('[data-lx]').forEach(b => b.onclick = async () => { c.liked.splice(+b.dataset.lx, 1); await saveChars(); drawPrefs(); });
  };
  drawPrefs();
  drawLife(c); drawAgenda(c); drawMem(c); drawPics(c); drawAv(c); drawStk(c);
  pfTabsInit();
  const showWx = () => weatherOf(c).then(w => { const el = $('#pfWx'); if(el) el.textContent = w ? `Acum în ${w.city}: ${wxLine(w)}. Intră în conversații și în poze.` : (c.city ? 'Nu găsesc orașul ăsta. Încearcă alt nume.' : 'Vremea reală de acolo intră în conversații și în poze (Open-Meteo, gratuit).'); }).catch(() => { const el = $('#pfWx'); if(el) el.textContent = 'Nu pot citi vremea acum (internet?).'; });
  showWx();
  $('#pfCitySave').onclick = async () => { c.city = $('#pfCity').value.trim(); delete c.geo; delete wxMem[c.id]; await saveChars(); showWx(); toast(c.city ? '📍 ' + c.city : 'Oraș șters'); };
  $('#pfMoreTop').onclick = () => sheet([['📤', 'Exportă cardul personajului', () => exportCard(c)], ['🧬', 'Duplică personajul', () => duplicateChar(c)], ['🗑️', 'Șterge personajul', () => deleteChar(c), 'dan']]);
  $('#pfVPlay').onclick = () => voiceSample(c, $('#pfVPlay'));
  $('#pfVPick').onclick = () => pickVoice(c, () => { $('#pfVName').textContent = voiceLabel(c); });
  $('#pfFav').onclick = async () => { c.fav = !c.fav; await saveChars(); $('#pfFav').textContent = c.fav ? '★' : '☆'; toast(c.fav ? '⭐ Adăugat la favorite' : 'Scos de la favorite'); };
  $('#pfEditTop').onclick = () => openEditor(id);
  $('#pfPhone').onclick = () => openPhone(c);
  $('#pfCall').onclick = async () => { if(!fromChat) await openChat(id); else history.back(); setTimeout(callChoice, 350); };
  $('#pfGift').onclick = async () => { if(!fromChat) await openChat(id); else history.back(); setTimeout(giftSheet, 350); };
  $('#pfAvBtn').onclick = () => { if(storyLive().some(x => x.cid === id)) openStories(id); else if(c.photo) viewImg(c.photo, [c.photo]); };
  body.querySelectorAll('[data-hi]').forEach(b => b.onclick = e => { e.stopPropagation(); const h = hiDays[+b.dataset.hi]; openStories(id, h.items.slice().reverse().map(x => ({id:'h' + x.k, cid:id, ts:x.ts, text:'', img:x.k, scene:x.scene}))); });
  $('#pfChat').onclick = () => { if(fromChat) history.back(); else openChat(id); };
}
function profScroll(){
  const sc = $('#pfScroll'), y = sc.scrollTop, img = $('#pfBody .pfHero img, #pfBody .pfHero .ph');
  if(img) img.style.transform = `translateY(${Math.max(0, y * .45)}px) scale(${1 + Math.max(0, -y) / 400})`;
  const h = $('#pfBody .pfHero');
  $('#vProf .pfTop').classList.toggle('solid', !!h && y > h.offsetHeight - 120);
}

// target = mesajul-poză de refăcut; mode: 'same' (aceeași scenă, altă variantă) sau 'new' (altă scenă)
async function askPhoto(spont, target, mode, opt = {}){
  if(busy){ if(!spont) toast('Așteaptă să termine ' + (live ? live.c.name : '') + '.'); return; }
  if(spont && S.wkChat !== 'fal' && capLeft() < (neurPerPhoto(S.imgProv === 'worker' ? (S.wkChat || S.wkModel) : undefined) || 5000)) return;   // limita zilnică atinsă: fără poze spontane
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări.'); return; }
  const c = cur, ch = chat;
  let m;
  if(target){ m = target; m.pendingImg = true; delete m.err; delete m.errKind; renderMsgs(); }
  else {
    m = {id:uid(), role:'ai', text:'', pendingImg:true, ts:Date.now()};
    if(spont === true) m.spont = true;
    ch.sinceImg = 0;
    ch.msgs.push(m); renderMsgs(true);
  }
  busy = new AbortController(); live = {c, ch, photo:true, stage:{t:'✨ Se pregătește', p:8, pv:0}}; setBusyUI(true);
  $('#sugg').innerHTML = '';
  const pT = setInterval(pTick, 120);
  try{
    const promised = !target && spont && ch.nextShot ? ch.nextShot.t : '';      // descrierea scrisă chiar de personaj când a trimis poza
    if(promised) delete ch.nextShot;
    let shot, where = null, together = !!(opt.together || (target && target.together)) && !!S.userPhoto;
    if(target && mode === 'same' && target.scene){ shot = target.scene; where = target.where || null; }
    else { const pl = await planShot(c, ch, {promised, exclude:m, signal:busy.signal, together}); shot = pl.shot; where = pl.where; together = pl.together; shot = giftDetail(c, shot, where); }
    let {prompt, blob, check, retried} = await makeScenePhoto(c, shot, busy.signal, {together});
    try{ if(blob.type === 'image/png') blob = await toJpeg(blob, 2048, .92); }catch(e){}   // PNG → JPEG: de ~5 ori mai puțin spațiu
    const k = await saveImg(blob);
    clearInterval(pT); if(live && live.stage){ live.stage.t = '✅ Gata'; live.stage.pv = 100; const st = $('#msgs .picload .plst'); if(st) st.textContent = '✅ Gata'; pDraw(100); await new Promise(r => setTimeout(r, 420)); }
    if(target){
      if(!m.imgAlts && m.img) m.imgAlts = [m.img];
      // variantele rămân pe mesaj: le poți compara cu ‹ › și păstra pe cea mai bună (cel mult 5)
      m.imgAlts = m.imgAlts || (m.img ? [m.img] : []);
      m.imgAlts.push(k);
      while(m.imgAlts.length > 5){ const old = m.imgAlts.shift(); if(old !== c.photo) delImg(old).catch(() => {}); }
      m.ia = m.imgAlts.length - 1;
    }
    m.img = k; m.prompt = prompt; m.scene = shot; if(where) m.where = where; if(together) m.together = true; else delete m.together; if(check) m.check = check; else delete m.check;
    addUsage(c.id, imgPrice(), 'img');
    if(S.imgProv === 'worker') setTimeout(() => loadNeurons(true), 1500);
  }catch(e){
    const msg = e.message || '';
    const flag = /3030|flagged|safety|blocked|prohibit|nsfw|SAFETY|IMAGE_OTHER|refuzat/i.test(msg);
    if(target && m.img){ if(e.name !== 'AbortError') toast(flag ? 'Serviciul de imagini a respins varianta asta.' : 'Poza nouă n-a mers: ' + msg, 4000); }   // poza veche rămâne
    else if(e.name === 'AbortError') m.err = 'Oprit.';
    else if(flag){ m.err = /refuzat/.test(msg) ? msg : 'Serviciul de imagini a respins poza asta.'; m.errKind = 'flag'; }
    else m.err = msg || 'Eroare la poză';
  }
  clearInterval(pT);
  delete m.pendingImg; busy = null; live = null;
  if(!m.err && !(chat === ch && !$('#vChat').hidden)) c.unread = (c.unread || 0) + 1;
  await saveChat(c, ch);
  if(!$('#vHome').hidden) renderHome();
  if(chat === ch){ setBusyUI(false); renderMsgs(true); if(!m.err && navigator.vibrate) try{ navigator.vibrate(12); }catch(e){} }
  else if(!busy && chat) setBusyUI(false);
}

// memorie lungă: partea veche a conversației se strânge într-un rezumat
async function summarizeIfNeeded(c, ch){
  const N = ch.msgs.length, from = ch.sumUpTo || 0;
  // 9.3: rezumatul stă la începutul istoricului; fiecare rezumat nou rescrie tot istoricul în cache la 2×.
  //      Se reface din 40 în 40 de mesaje (era 30), cu „to” aliniat la 40, ca să cadă odată cu mutarea ferestrei.
  //      Rezumatul nou se pregătește din timp (ch.sumNext) și intră în istoric abia când fereastra se mută (contextUpTo),
  //      ca rezumatul și fereastra să producă o singură rescriere, nu două.
  if(N - from < 60 || ch._sumBusy || ch.dead || ch.sumNext) return;
  ch._sumBusy = true;
  const to = Math.ceil((from + 1) / 40) * 40;
  const u = S.userName || 'utilizatorul';
  const part = ch.msgs.slice(from, to).filter(m => m.text).map(m => (m.role === 'user' ? u : c.name) + ': ' + m.text).join('\n');
  try{
    const s = await stream('Rezumi conversații. Scrii în română, concis, la persoana a III-a.', [{role:'user', text:
      `Rezumatul de până acum:\n${ch.summary || '(niciunul)'}\n\nMesaje noi:\n${part}\n\nScrie rezumatul actualizat, cel mult 220 de cuvinte: ce s-a întâmplat, fapte importante despre ${u}, promisiuni, cum a evoluat relația dintre ${c.name} și ${u}.`}], {max:700, cid:c.id, aux:true});
    delete ch._sumBusy;
    if(s.trim() && !ch.dead && charById(c.id)){ ch.sumNext = s.trim(); ch.sumNextTo = to; await DB.set(chatKey(c.id, ch.tid), ch); }
  }catch(e){ /* reîncearcă la mesajul următor */ }
  delete ch._sumBusy;
}

/* acțiuni pe mesaj */
function msgSheet(i){
  const m = chat.msgs[i]; if(!m || m.pending || m.pendingImg) return;
  const me = m.role === 'user';
  const opts = [];
  if(!m.err) opts.push(['↩️', 'Răspunde la mesaj', () => setReply(i)]);
  if(!m.err) opts.push(['❤️', m.react ? 'Schimbă reacția' : 'Reacționează', () => setTimeout(() => reactPicker(i), 50)]);
  if(m.text) opts.push(['📋', 'Copiază', () => { navigator.clipboard?.writeText(m.text); toast('Copiat'); }]);
  if(m.text && !me) opts.push(['🔊', 'Citește cu voce', () => say(m.text, m)]);
  if(m.text && !me && learnOn(cur)) opts.push(['🔤', m.tr ? (m.trOn ? 'Ascunde traducerea' : 'Arată traducerea') : 'Tradu în română', () => translateMsg(m)]);
  if(m.text && !busy) opts.push(['✏️', me ? 'Editează și retrimite' : 'Editează', () => editMsg(i)]);
  if(m.img && !me && !busy && S.imgProv !== 'none'){ opts.push(['🎲', 'Altă variantă (aceeași scenă)', () => askPhoto(false, m, 'same')]); opts.push(['🔄', 'Altă poză (altă scenă)', () => askPhoto(false, m, 'new')]); }
  if(m.img && m.scene && !me) opts.push(['📝', 'Ce scenă a ales', () => openSheet(`<h4>Scena pozei</h4><div class="pad">${m.where ? `<p class="wline">📍 ${esc([m.where.room && m.where.room !== 'other' ? (ROOM_RO[m.where.room] || m.where.room) : m.where.place, m.where.position].filter(Boolean).join(' · '))}${m.where.outfit ? '<br>👗 ' + esc(m.where.outfit) : ''}</p>` : ''}<p style="color:var(--tx2);line-height:1.5">${esc(m.scene)}</p>${m.check ? `<p class="hint">Verificare: ${m.check.d !== undefined ? '🧬 ' + (m.check.d != null ? idPct(m.check.d) + '% · ' + idLabel(m.check.d) : 'fața nu se vede') : 'seamănă ' + m.check.face + '/10'} · scena ${m.check.scene ?? '?'}/10 · încadrarea ${m.check.framing ?? '?'}/10${m.check.hair != null ? ' · părul ' + m.check.hair + '/10' : ''}${m.check.marks != null ? ' · semnele ' + m.check.marks + '/10' : ''}${m.check.body != null ? ' · corpul ' + m.check.body + '/10' : ''}${m.check.expr != null ? ' · expresia ' + m.check.expr + '/10' : ''}${m.cands && m.cands.length > 1 ? '<br>🎯 aleasă din ' + m.cands.length + ': ' + m.cands.map(d => d == null ? '?' : idPct(d) + '%').join(' · ') : ''}</p>` : ''}</div>`)]);
  if(m.img) opts.push(['💾', 'Salvează poza în telefon', () => saveImage(m.img)]);
  if(m.img && canShareFiles()) opts.push(['↗️', 'Trimite poza în altă aplicație', () => shareImage(m.img)]);
  if(m.img && !me) opts.push(['🖼️', 'Fă-o poză de profil', async () => {
    const c = cur, b = await DB.get(m.img); if(!b) return;
    const old = c.photo; c.photo = await saveImg(b); await saveChars(); await delPhotoIfUnused(c, old);   // copie proprie: poza din chat rămâne
    toast('Poză de profil schimbată'); openChat(c.id, false); }]);
  if(!busy) opts.push(['🗑️', 'Șterge mesajul', async () => { const c = cur; chat.msgs.splice(i, 1); cutAt(chat, i); await purgeMsg(m, c); await saveChat(); renderMsgs(); }, 'dan']);
  if(!busy && i < chat.msgs.length - 1) opts.push(['⤺', 'Șterge tot de aici în jos', async () => { const c = cur; const gone = chat.msgs.splice(i); cutAt(chat, i); for(const x of gone) await purgeMsg(x, c); await saveChat(); renderMsgs(); }, 'dan']);
  sheet(opts);
}
function rephotoMenu(i){
  const m = chat.msgs[i]; if(!m || busy) return;
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări.'); return; }
  sheet([['🎲', 'Altă variantă, aceeași scenă', () => askPhoto(false, m, 'same')], ['🔄', 'Altă poză, altă scenă', () => askPhoto(false, m, 'new')]]);
}
// trecerea între alternative: fiecare își păstrează felul ei (vocal / tăiat)
function setAlt(m, k){
  m.alt = Math.max(0, Math.min(m.alts.length - 1, k)); m.text = m.alts[m.alt]; delete m.err;
  const a = (m.am || {})[m.alt];
  if(a){ if(a.voice) m.voice = true; else delete m.voice; if(a.cut) m.cut = a.cut; else delete m.cut; }
}
function retry(i){
  const m = chat.msgs[i];
  if(m.alts && m.alts.length > 1){ m.alts.pop(); setAlt(m, m.alts.length - 1); reply(m); return; }
  const wasPhoto = !m.alts, note = m.note, cont = m.cont;
  chat.msgs.splice(i, 1);
  wasPhoto ? askPhoto() : reply(null, cont ? {cont:true} : note ? {pro:true, note} : {});
}
function editMsg(i){
  const m = chat.msgs[i];
  openSheet(`<h4>Editează mesajul</h4><div class="pad"><textarea id="shTxt">${esc(m.text)}</textarea>
    <div class="btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="shOk">${m.role === 'user' ? 'Retrimite' : 'Salvează'}</button></div></div>`);
  $('#shOk').onclick = async () => {
    const t = $('#shTxt').value.trim(); if(!t) return;
    closeSheet();
    if(m.role === 'user'){ m.text = t; const gone = chat.msgs.splice(i + 1); cutAt(chat, i); for(const x of gone) await purgeMsg(x, cur); await saveChat(); renderMsgs(true); reply(); }
    else {
      if(t !== m.text){ DB.del(ttsKey(m)).catch(() => {}); if(m.vmeta) delete m.vmeta[m.alt || 0]; }   // vocea veche nu mai corespunde
      m.text = t; if(m.alts) m.alts[m.alt || 0] = t; await saveChat(); renderMsgs();
    }
  };
}
function chatMenu(){
  const n = threadsOf(cur).length;
  sheet([
    ['🎬', chat.scene ? 'Scena: ' + chat.scene.slice(0, 32) + (chat.scene.length > 32 ? '…' : '') : 'Setează scena', editScene],
    ['🧵', n > 1 ? `Conversații (${n})` : 'Conversații', threadsSheet],
    ['⏰', (() => { const k = (cur.sched || []).filter(x => x.tid === (chat.tid || 'main')).length; return k ? `Mesaje programate (${k})` : 'Mesaje programate'; })(), schedSheet],
    ['📖', 'Albumul vostru', () => openAlbum(cur)],
    ['📱', `Telefonul lui ${cur.name}`, () => openPhone(cur)],
    ['🌍', learnOn(cur) ? `Învață ${LANGS[cur.learn.lang][0].toLowerCase()} (pornit)` : 'Învață o limbă', () => learnSheet(cur)],
    ['👤', 'Profil, memorie și editare', () => charProfile(cur.id)],
    ['⋯', 'Mai mult', moreMenu],
  ]);
}
function moreMenu(){
  sheet([
    ['⬇', 'Exportă conversația (.txt)', exportTxt],
    ['🧹', 'Golește conversația asta', () => confirmSheet('Golești conversația curentă cu ' + cur.name + '? Mesajele și pozele din ea dispar.', 'Golește', async () => {
      if(busy && live && live.ch === chat) busy.abort();
      chat.dead = true;
      for(const m of chat.msgs) await purgeMsg(m, cur);
      const tid = chat.tid, scene = chat.scene;
      chat = newChat(); chat.tid = tid; chat.scene = scene; if(cur.greet) chat.msgs.push(greetMsg(cur));
      await saveChat(); renderMsgs(true);
    }), 'dan'],
    ['🗑️', 'Șterge personajul ' + cur.name, () => deleteChar(cur), 'dan'],
  ]);
}
function exportTxt(){
  const u = S.userName || 'Eu';
  const txt = (chat.summary ? 'REZUMAT: ' + chat.summary + '\n\n' : '') +
    chat.msgs.filter(m => m.text).map(m => (m.role === 'user' ? u : cur.name) + ': ' + m.text).join('\n\n');
  download(new Blob([txt], {type:'text/plain'}), `Taifas-${cur.name}-${new Date().toISOString().slice(0, 10)}.txt`);
}
function download(blob, name){ const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

/* ───────── sheet (meniu de jos) ───────── */
/* ───────── 📣 7.9: întreabă-le pe toate ─────────
   Mesajul tău ajunge în conversația fiecărui personaj ales, ca un mesaj obișnuit; fiecare răspunde în felul lui și
   marchează ascuns [răspuns: da/poate/nu]. Rezultatele (ultima trimitere) stau în DB `bcast`. */
let bcastLast = null, bcastRun = false;
const VERD = {da:['✅', 'Da'], poate:['🤔', 'Poate'], nu:['❌', 'Nu'], '?':['💬', 'A răspuns']};
async function bcastSheet(fresh){
  if(!bcastLast) bcastLast = await DB.get('bcast');
  if(!fresh && bcastLast && (bcastRun || Date.now() - bcastLast.ts < 24 * 36e5)) return bcastResults();
  if(!aiReady()){ toast('Pune întâi cheia în Setări.'); return; }
  const list = [...chars].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  if(!list.length){ toast('Creează întâi un personaj.'); return; }
  const sel = new Set(list.map(c => c.id));
  openSheet(`<h4>📣 Întreabă-le pe toate</h4><div class="pad">
    <p>Scrie o dată. Mesajul ajunge în conversația fiecărui personaj ales, ca un mesaj de-al tău, iar fiecare îți răspunde în felul lui. Vezi apoi cine e dispus.</p>
    <textarea id="bcTx" rows="3" placeholder="ex. Cine vine diseară la o cafea în centru?"></textarea>
    <div class="bcpick">${list.map(c => `<button class="on" data-bc="${c.id}">${avatarHTML(c)}<span>${esc(c.name)}</span></button>`).join('')}</div>
    <p class="hint" id="bcN"></p>
    <div class="btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="bcGo">Trimite</button></div></div>`);
  hydrate(document.querySelector('.sheet'));
  const upd = () => { $('#bcN').textContent = `${sel.size} ${sel.size === 1 ? 'personaj' : 'personaje'} · un răspuns de la fiecare, pe rând (costă cât ${sel.size} mesaje obișnuite)`; $('#bcGo').disabled = !sel.size; };
  $$('.bcpick [data-bc]').forEach(b => b.onclick = () => { const id = b.dataset.bc; sel.has(id) ? sel.delete(id) : sel.add(id); b.classList.toggle('on', sel.has(id)); upd(); });
  upd(); setTimeout(() => $('#bcTx') && $('#bcTx').focus(), 250);
  $('#bcGo').onclick = () => { const t = $('#bcTx').value.trim(); if(!t){ $('#bcTx').focus(); return; } runBcast(t, [...sel]); };
}
function bcastResults(){
  const r = bcastLast; if(!r) return;
  const ord = {da:0, poate:1, '?':2, nu:3};
  const items = bcastRun ? r.items : [...r.items].sort((a, b) => (ord[a.v] ?? 4) - (ord[b.v] ?? 4));
  const n = k => r.items.filter(x => x.v === k).length;
  const html = `<h4>📣 „${esc(r.text.length > 60 ? r.text.slice(0, 60) + '…' : r.text)}”</h4><div class="pad">
    <p class="bcsum">${bcastRun ? '<span class="spin"></span> Răspund pe rând…' : `✅ ${n('da')} · 🤔 ${n('poate')} · ❌ ${n('nu')}${n('?') ? ' · 💬 ' + n('?') : ''}`}</p>
    <div class="bclist">${items.map(x => { const c = charById(x.cid); if(!c) return ''; const v = VERD[x.v] || null;
      return `<button class="bcrow ${x.v || x.st}" data-bcopen="${c.id}">${avatarHTML(c)}<span class="bct"><b>${esc(c.name)}${v ? `<em>${v[0]} ${v[1]}</em>` : x.st === 'run' ? '<em><span class="spin"></span> scrie…</em>' : x.st === 'err' ? '<em>⚠️ eroare</em>' : '<em>în așteptare</em>'}</b><small>${esc(x.t || x.err || '')}</small></span></button>`; }).join('')}</div>
    <div class="btns">${bcastRun ? '' : '<button class="btn" id="bcNew">📣 Mesaj nou</button>'}<button class="btn" data-close>Închide</button></div></div>`;
  const sh = document.querySelector('.scrim .sheet.bcsheet');
  if(sh){ sh.innerHTML = html; } else { openSheet(html); document.querySelector('.scrim .sheet').classList.add('bcsheet'); }
  const root = document.querySelector('.scrim .sheet.bcsheet'); hydrate(root);
  root.querySelectorAll('[data-bcopen]').forEach(b => b.onclick = () => { if(bcastRun) return toast('Așteaptă să termine toate.'); closeSheet(); openChat(b.dataset.bcopen); });
  const nw = $('#bcNew'); if(nw) nw.onclick = () => bcastSheet(true);
}
async function runBcast(text, ids){
  if(bcastRun) return;
  bcastRun = true;
  bcastLast = {id:uid(), text, ts:Date.now(), items:ids.map(cid => ({cid, st:'wait'}))};
  closeSheet(); bcastResults();
  const u = S.userName.trim() || 'el';
  const note = `răspunde sincer, ca tine: după cine ești, cum vă știți, ce faci acum și ce simți, poți accepta, ezita sau refuza. La final, pe un rând separat, adaugă exact una dintre: [răspuns: da], [răspuns: poate], [răspuns: nu], după cât de dispus(ă) ești la ce ți-a scris ${u}`;
  for(const it of bcastLast.items){
    const c = charById(it.cid); if(!c){ it.st = 'err'; continue; }
    try{
      while(busy) await sleep(400);
      const tid = c.thread || 'main', open = cur === c && chat && (chat.tid || 'main') === tid;
      const ch = open ? chat : await loadChat(c, tid);
      if(!ch.msgs.length && c.greet) ch.msgs.push(greetMsg(c));
      ch.msgs.push({id:uid(), role:'user', text, ts:Date.now(), bc:bcastLast.id});
      await saveChat(c, ch);
      it.st = 'run'; bcastResults();
      await reply(null, {c, ch, fix:note});
      const m = [...ch.msgs].reverse().find(x => x.role === 'ai' && !x.sticker && !x.img);
      if(!m || m.err){ it.st = 'err'; it.err = m ? m.err : 'fără răspuns'; }
      else { it.st = 'ok'; it.v = m.verdict || '?'; it.t = m.text; it.mid = m.id; }
    }catch(e){ it.st = 'err'; it.err = e.message; }
    await DB.set('bcast', bcastLast); bcastResults();
  }
  bcastRun = false; await DB.set('bcast', bcastLast); bcastResults();
  if(!$('#vHome').hidden) renderHome();
}
/* ───────── 🔒 8.6: blocare cu PIN sau amprentă ─────────
   Ecran de blocare la pornire și după mai mult de 1 minut în fundal. PIN-ul se ține doar ca hash (SHA-256 cu sare);
   amprenta = WebAuthn cu autentificatorul telefonului (verificare locală). Datele din telefon nu sunt criptate: e o blocare de ecran. */
let locked = false, lockWaiters = [], hiddenAt = 0, pinTries = 0, pinWaitUntil = 0;
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), ch => ch.charCodeAt(0));
async function pinHash(pin, salt, v = 2){
  if(v < 2) return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)));   // format vechi (până la 8.19)
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt:new TextEncoder().encode('taifas:' + salt), iterations:210000}, k, 256));
}
function whenUnlocked(fn){ if(locked) lockWaiters.push(fn); else fn(); }
function runShortcut(go){
  const byLast = [...chars].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  if(go === 'last' && byLast[0]) openChat(byLast[0].id);
  else if(go === 'fav'){ const f = byLast.find(c => c.fav) || byLast[0]; if(f) openChat(f.id); }
  else if(go === 'bcast') bcastSheet(true);
  else if(go === 'new') openEditor(null);
  else if(go === 'chats'){ homeTab = 'chats'; renderHome(); }
  else if(go === 'set'){ openSettings(); openSetPanel('ai'); }
  else if(go.startsWith('c:') && charById(go.slice(2))) openChat(go.slice(2));
}
function showLock(){
  if(locked || !S.lock || S.lock === 'off' || !S.pinHash) return;
  locked = true;
  const v = document.createElement('div'); v.id = 'lockv';
  v.innerHTML = `<img src="icon-512-maskable.png" alt=""><h2>Taifas</h2><p id="lkMsg">Introdu PIN-ul</p><div class="lkdots" id="lkDots">${'<i></i>'.repeat(S.pinLen || 4)}</div>
    <div class="lkpad">${[1,2,3,4,5,6,7,8,9].map(n => `<button data-k="${n}">${n}</button>`).join('')}<button data-k="bio" ${S.lock === 'bio' && S.bioId ? '' : 'style="visibility:hidden"'} aria-label="Amprentă"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 11v3M8.5 7.5A5 5 0 0 1 17 11v1.5M7 11v1a8 8 0 0 0 1.5 5M17 15.5a8 8 0 0 1-1 2.5M12 4a8 8 0 0 0-7.6 5.5M19.6 9.5A8 8 0 0 0 16 5M10 11a2 2 0 0 1 4 0v2a10 10 0 0 1-1.4 5"/></svg></button><button data-k="0">0</button><button data-k="del" aria-label="Șterge">⌫</button></div>`;
  document.body.appendChild(v);
  let pin = '';
  const dots = () => $$('#lkDots i').forEach((d, i) => d.classList.toggle('on', i < pin.length));
  const tryPin = async () => {
    pinWaitUntil = Math.max(pinWaitUntil, S.pinWait || 0);
    if(Date.now() < pinWaitUntil){ $('#lkMsg').textContent = 'Prea multe încercări. Așteaptă ' + Math.ceil((pinWaitUntil - Date.now()) / 1000) + ' s.'; pin = ''; dots(); return; }
    if(await pinHash(pin, S.pinSalt, S.pinV || 1) === S.pinHash){ pinTries = 0; if(S.pinFails){ S.pinFails = 0; S.pinWait = 0; saveSettings(); } if((S.pinV || 1) < 2){ S.pinSalt = b64u(crypto.getRandomValues(new Uint8Array(16))); S.pinHash = await pinHash(pin, S.pinSalt, 2); S.pinV = 2; saveSettings(); } unlock(); return; }
    pinTries++; if(pinTries >= 5){ S.pinFails = (S.pinFails || 0) + 1; pinWaitUntil = S.pinWait = Date.now() + 30e3 * Math.pow(2, Math.min(6, S.pinFails - 1)); pinTries = 0; saveSettings(); }
    $('#lkDots').classList.add('bad'); setTimeout(() => $('#lkDots') && $('#lkDots').classList.remove('bad'), 450);
    $('#lkMsg').textContent = 'PIN greșit'; pin = ''; dots();
  };
  v.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    if(k === 'bio') return bioUnlock();
    if(k === 'del'){ pin = pin.slice(0, -1); dots(); return; }
    if(pin.length >= (S.pinLen || 4)) return;
    pin += k; dots(); if(pin.length === (S.pinLen || 4)) setTimeout(tryPin, 120);
  });
  if(S.lock === 'bio' && S.bioId) setTimeout(bioUnlock, 450);
}
async function bioUnlock(){
  try{
    await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)), allowCredentials:[{type:'public-key', id:unb64u(S.bioId)}], userVerification:'required', timeout:60000}});
    unlock();
  }catch(e){ const m = $('#lkMsg'); if(m) m.textContent = 'Amprenta n-a mers. Folosește PIN-ul.'; }
}
function unlock(){
  locked = false;
  const v = $('#lockv'); if(v){ v.classList.add('out'); setTimeout(() => v.remove(), 250); }
  const w = lockWaiters; lockWaiters = []; w.forEach(f => { try{ f(); }catch(e){} });
}
document.addEventListener('visibilitychange', () => {
  if(document.hidden) hiddenAt = Date.now();
  else if(S.lock && S.lock !== 'off' && hiddenAt && Date.now() - hiddenAt > 60e3) showLock();
});
// Setări → Confidențialitate
function drawLock(){
  const box = $('#stLockBox'); if(!box) return;
  const on = S.lock && S.lock !== 'off';
  box.innerHTML = `<div class="seg" id="stLockSeg"><button data-v="off" class="${!on ? 'on' : ''}">Oprită</button><button data-v="pin" class="${S.lock === 'pin' ? 'on' : ''}">PIN</button><button data-v="bio" class="${S.lock === 'bio' ? 'on' : ''}">Amprentă + PIN</button></div>
    <p class="hint">${on ? 'Taifas se blochează la pornire și când revii după mai mult de un minut. ' + (S.lock === 'bio' ? 'Deblochezi cu amprenta (sau fața) telefonului; PIN-ul rămâne ca rezervă.' : 'Deblochezi cu PIN-ul.') : 'Oprită: aplicația se deschide direct.'} Blocarea ascunde conversațiile de alții; datele din telefon nu sunt criptate. Dacă uiți PIN-ul, singura cale e ștergerea datelor aplicației, deci ține un backup.</p>
    ${on ? '<div class="btns"><button class="btn sm" id="stPinChange">🔢 Schimbă PIN-ul</button></div>' : ''}`;
  box.querySelectorAll('#stLockSeg [data-v]').forEach(b => b.onclick = async () => {
    const v = b.dataset.v;
    if(v === 'off'){ S.lock = 'off'; saveSettings(); drawLock(); return; }
    if(!S.pinHash){ const ok = await setPinFlow(); if(!ok) return; }
    if(v === 'bio'){ const ok = await bioRegister(); if(!ok) return; }
    S.lock = v; saveSettings(); drawLock(); toast(v === 'bio' ? '🔒 Blocare cu amprentă pornită' : '🔒 Blocare cu PIN pornită');
  });
  const ch = $('#stPinChange'); if(ch) ch.onclick = () => setPinFlow();
}
function pinSheet(title){
  return new Promise(res => {
    let pin = '';
    openSheet(`<h4>${esc(title)}</h4><div class="pad lkin"><div class="lkdots" id="psDots">${'<i></i>'.repeat(4)}</div>
      <div class="lkpad sm">${[1,2,3,4,5,6,7,8,9].map(n => `<button data-p="${n}">${n}</button>`).join('')}<button data-p="x" class="x">Renunță</button><button data-p="0">0</button><button data-p="del">⌫</button></div></div>`);
    const dots = () => $$('#psDots i').forEach((d, i) => d.classList.toggle('on', i < pin.length));
    $$('.sheet [data-p]').forEach(b => b.onclick = () => {
      const k = b.dataset.p;
      if(k === 'x'){ closeSheet(); res(null); return; }
      if(k === 'del'){ pin = pin.slice(0, -1); dots(); return; }
      if(pin.length >= 4) return; pin += k; dots();
      if(pin.length === 4) setTimeout(() => { closeSheet(); res(pin); }, 150);
    });
  });
}
async function setPinFlow(){
  const a = await pinSheet('Alege un PIN de 4 cifre'); if(!a) return false;
  const b = await pinSheet('Scrie PIN-ul încă o dată'); if(!b) return false;
  if(a !== b){ toast('PIN-urile nu se potrivesc. Mai încearcă.'); return false; }
  S.pinSalt = b64u(crypto.getRandomValues(new Uint8Array(16))); S.pinHash = await pinHash(a, S.pinSalt, 2); S.pinV = 2; S.pinLen = 4; saveSettings();
  toast('🔢 PIN salvat'); return true;
}
async function bioRegister(){
  if(!window.PublicKeyCredential){ toast('Telefonul nu oferă amprentă pentru aplicații web.'); return false; }
  try{
    const ok = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); if(!ok){ toast('Nu găsesc amprenta telefonului (setează-o în Android).', 3500); return false; }
    const cred = await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)), rp:{name:'Taifas', id:location.hostname},
      user:{id:crypto.getRandomValues(new Uint8Array(16)), name:'taifas', displayName:'Taifas'}, pubKeyCredParams:[{type:'public-key', alg:-7}, {type:'public-key', alg:-257}],
      authenticatorSelection:{authenticatorAttachment:'platform', userVerification:'required', residentKey:'discouraged'}, timeout:60000}});
    S.bioId = b64u(cred.rawId); saveSettings(); return true;
  }catch(e){ toast('Amprenta n-a fost înregistrată: ' + (e.message || e.name), 3500); return false; }
}
/* ───────── 🔔 8.6: notificări adevărate (Web Push prin Worker-ul tău v7) ─────────
   Worker-ul ține doar ora + titlul notificării; la ora respectivă (Cron, la fiecare minut) trimite o notificare goală, iar
   service worker-ul își ia titlul de la /v1/push/pending și o afișează. Atingi notificarea → se deschide conversația, iar
   mesajul se scrie atunci (cu cheia ta), datat la ora promisă. Nu se afișează nimic dacă aplicația e deschisă pe ecran. */
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function wkFetch(path, opt = {}){
  const r = await fetch(wkUrl() + path, {...opt, headers:{...(opt.body ? {'content-type':'application/json'} : {}), ...(S.wkTok ? {authorization:'Bearer ' + S.wkTok.trim()} : {})}});
  if(!r.ok) throw new Error(await errText(r));
  return r.json();
}
async function pushCfgToSW(){
  if(!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready; const sw = reg.active || navigator.serviceWorker.controller;
  if(sw) sw.postMessage({cfg:{wk:wkUrl(), tok:S.wkTok ? S.wkTok.trim() : ''}});
}
async function pushEnable(){
  if(!pushOk()) throw new Error('Telefonul sau browserul nu permite notificări pentru aplicații web. Deschide Taifas ca aplicație instalată, din Chrome.');
  if(!S.wkBase) throw new Error('Pune întâi adresa Worker-ului în Setări → Poze.');
  const perm = await Notification.requestPermission(); if(perm !== 'granted') throw new Error('Notificările nu sunt permise. Permite-le din setările telefonului pentru Taifas.');
  const {key} = await wkFetch('/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if(sub){ const k = sub.options && sub.options.applicationServerKey ? b64u(sub.options.applicationServerKey) : key; if(k !== key){ await sub.unsubscribe(); sub = null; } }
  if(!sub) sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:unb64u(key)});
  await wkFetch('/push/sub', {method:'POST', body:JSON.stringify({sub:sub.toJSON()})});
  await pushCfgToSW();
  S.pushOn = true; saveSettings();
  for(const c of chars) for(const x of c.sched || []) if(x.at > Date.now()) pushAt('s:' + x.id, x.at, c.name, '💬 Ți-a scris un mesaj', 'c:' + c.id);
}
function pushAt(id, at, title, body, go){
  if(!S.pushOn || !S.wkBase) return;
  wkFetch('/push/at', {method:'POST', body:JSON.stringify({id, at, title, body, url:'./?go=' + encodeURIComponent(go || 'last')})}).catch(e => console.warn('push', e.message));
}
function pushCancel(id){ if(S.pushOn && S.wkBase) wkFetch('/push/at?id=' + encodeURIComponent(id), {method:'DELETE'}).catch(() => {}); }
// „îți scrie primul” după PRO_H ore de liniște: notificarea se reprogramează după fiecare mesaj din conversație
function pushPro(c, ch){   // 8.17.1: urmează treptele (8h/24h/72h); după ultima treaptă nu mai sună degeaba
  if(S.pro !== 'on' || !c) return;
  const st = ch ? proState(ch) : {due:Date.now() + PRO_H * 36e5};
  if(st) pushAt('p:' + c.id, Math.max(st.due, Date.now()) + 60e3, c.name, '💬 Ți-a scris', 'c:' + c.id); else pushCancel('p:' + c.id);
}
function drawPush(){
  const box = $('#stPushBox'); if(!box) return;
  box.innerHTML = `<p class="hint" style="margin-top:0">Telefonul sună ca la WhatsApp când îți scrie un personaj: mesajele promise (⏰) și „îți scrie primul” după ${PRO_H} ore de liniște, chiar cu aplicația închisă. Merg prin Worker-ul tău Cloudflare (v7), fără cost în plus; el ține minte doar ora și numele personajului, iar textul se scrie când deschizi notificarea.</p>
    <div class="btns">${S.pushOn ? '<button class="btn sm" id="stPushTest">🔔 Trimite o notificare de test</button><button class="btn sm dan" id="stPushOff">Oprește</button>' : '<button class="btn pri" id="stPushOn">🔔 Pornește notificările</button>'}</div>
    <div class="status" id="stPushRes"></div>
    <details style="margin-top:12px"><summary>Ce trebuie făcut o dată în Cloudflare</summary><ol class="hint" style="padding-left:18px;line-height:1.55">
      <li>Urcă <b>cloudflare-worker-simplu.js</b> (v7) din arhivă.</li>
      <li>Storage &amp; Databases → <b>KV</b> → Create, nume <b>taifas</b>.</li>
      <li>Worker-ul tău → Settings → <b>Bindings</b> → Add → KV namespace: variabila <b>KV</b>, alegi <b>taifas</b>.</li>
      <li>Worker-ul tău → Settings → <b>Triggers</b> → Cron Triggers → Add: <b>* * * * *</b> (la fiecare minut).</li>
      <li>Aici: „Pornește notificările”, apoi „Trimite o notificare de test”.</li></ol></details>`;
  const res = $('#stPushRes');
  const on = $('#stPushOn'); if(on) on.onclick = async () => { res.className = 'status'; res.innerHTML = '<span class="spin"></span> Pornesc…'; try{ await pushEnable(); drawPush(); $('#stPushRes').className = 'status ok'; $('#stPushRes').textContent = '✓ Pornite. Trimite o notificare de test.'; }catch(e){ res.className = 'status err'; res.textContent = '✗ ' + e.message; } };
  const te = $('#stPushTest'); if(te) te.onclick = async () => { res.className = 'status'; res.innerHTML = '<span class="spin"></span> Trimit…'; try{
      const reg = await navigator.serviceWorker.getRegistration(); if(reg) await reg.update().catch(() => {});
      await pushCfgToSW(); const r = await wkFetch('/push/test', {method:'POST', body:'{}'});
      const sub = reg && await reg.pushManager.getSubscription();
      const diag = ` · permisiune: ${Notification.permission} · abonament: ${sub ? 'da' : 'NU'}`;
      if(r.push !== 201 && r.push !== 200){ res.className = 'status err'; res.textContent = '✗ Serviciul de notificări a răspuns: ' + r.push + diag + '. Apasă Oprește, apoi Pornește din nou.'; return; }
      res.className = 'status ok'; res.textContent = '✓ Trimisă (' + r.push + ')' + diag + '. Notificarea de test ar trebui să apară în câteva secunde, chiar cu aplicația deschisă. Dacă nu apare, problema e la permisiunile telefonului.';
    }catch(e){ res.className = 'status err'; res.textContent = '✗ ' + e.message; } };
  const off = $('#stPushOff'); if(off) off.onclick = async () => { try{ const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if(sub) await sub.unsubscribe(); }catch(e){} S.pushOn = false; saveSettings(); drawPush(); };
}
/* ───────── 🌦️ 8.6: vremea reală din orașul personajului (Open-Meteo, gratuit, fără cheie) ───────── */
const WX = {0:['senin','clear sky'],1:['mai mult senin','mostly clear'],2:['parțial înnorat','partly cloudy'],3:['înnorat','overcast'],45:['ceață','fog'],48:['ceață cu chiciură','freezing fog'],51:['burniță ușoară','light drizzle'],53:['burniță','drizzle'],55:['burniță deasă','heavy drizzle'],56:['burniță înghețată','freezing drizzle'],57:['burniță înghețată','freezing drizzle'],61:['ploaie ușoară','light rain'],63:['ploaie','rain'],65:['ploaie torențială','heavy rain'],66:['ploaie înghețată','freezing rain'],67:['ploaie înghețată','freezing rain'],71:['ninsoare ușoară','light snow'],73:['ninsoare','snow'],75:['ninsoare abundentă','heavy snow'],77:['fulgi mărunți','snow grains'],80:['averse ușoare','light showers'],81:['averse','showers'],82:['averse puternice','heavy showers'],85:['averse de zăpadă','snow showers'],86:['averse de zăpadă','heavy snow showers'],95:['furtună','thunderstorm'],96:['furtună cu grindină','thunderstorm with hail'],99:['furtună cu grindină','thunderstorm with hail']};
const wxMem = {};
async function weatherOf(c){
  if(!c || !c.city || !c.city.trim()) return null;
  const city = c.city.trim(), hit = wxMem[c.id];
  if(hit && hit.city === city && Date.now() - hit.ts < 30 * 60e3) return hit.w;
  if(!c.geo || c.geo.q !== city){
    const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=ro&name=' + encodeURIComponent(city));
    const g = (await r.json()).results?.[0]; if(!g) return null;
    c.geo = {q:city, lat:g.latitude, lon:g.longitude, name:g.name}; saveChars();
  }
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.geo.lat}&longitude=${c.geo.lon}&current=temperature_2m,weather_code,is_day,wind_speed_10m&daily=sunrise,sunset&forecast_days=1&timezone=auto`);
  const jj = await r.json(), cu = jj.current; if(!cu) return null;
  if(typeof jj.utc_offset_seconds === 'number' && c.geo.off !== jj.utc_offset_seconds){ c.geo.off = jj.utc_offset_seconds; saveChars(); }   // 8.10: fusul orar al personajului
  const hm = x => { const m = String(x || '').match(/T(\d{2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const d = WX[cu.weather_code] || ['vreme schimbătoare', 'changeable weather'], code = cu.weather_code;
  const w = {t:Math.round(cu.temperature_2m), ro:d[0], en:d[1], day:!!cu.is_day, wind:Math.round(cu.wind_speed_10m || 0), city:c.geo.name, code, sr:hm(jj.daily?.sunrise?.[0]), ss:hm(jj.daily?.sunset?.[0]),
    fx:[61,63,65,66,67,80,81,82,95,96,99,51,53,55,56,57].includes(code) ? 'rain' : [71,73,75,77,85,86].includes(code) ? 'snow' : ''};
  wxMem[c.id] = {city, ts:Date.now(), w};
  return w;
}
const wxLine = w => w ? `${w.t}°C, ${w.ro}${w.wind >= 30 ? ', vânt puternic' : ''}` : '';
/* ───────── 📞 8.5: apel vocal (vocea telefonului + dictarea, fără costuri în plus în afară de text) ─────────
   Bucla: ascultă (SpeechRecognition ro-RO) → mesajul tău intră în conversație → personajul răspunde (reply, scurt, vorbit)
   → răspunsul e citit cu vocea telefonului → ascultă din nou. Nu ascultă cât vorbește telefonul (fără ecou). */
let call = null;
const CALL_FIX = u => `ești într-un apel vocal la telefon cu ${u}: scrie doar ce spui cu voce tare, natural și scurt (1-3 propoziții), ca la telefon, fără *acțiuni*, fără emoji și fără [vocal]; poți folosi „hm”, „păi”, un râs scurt scris ca text`;
// 8.13: apel video: vă vedeți. Dacă primește un cadru din camera lui, îl vede ca într-un apel adevărat
const CALL_FIX_V = u => `ești într-un apel video cu ${u}, vă vedeți pe ecran: scrie doar ce spui cu voce tare, natural și scurt (1-3 propoziții), fără *acțiuni*, fără emoji și fără [vocal]. Dacă primești o imagine, e ce vezi chiar acum prin camera lui: poți reacționa firesc la ce vezi (unde e, lumina, ce face, expresia lui), în treacăt, fără s-o descrii ca pe o poză și fără comentarii despre corpul lui`;
const callFix = c => (c && c.video ? CALL_FIX_V : CALL_FIX)(S.userName.trim() || 'el') + (c && c.video && c.exprReady ? '. Începe fiecare replică cu expresia feței tale de acum, exact așa: [față: zâmbet], [față: râs], [față: surpriză], [față: gânditoare], [față: tristă] sau [față: neutră]' : '');
const ICO = {
  mic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  cam:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/></svg>',
  flip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11a4 4 0 0 1 4 4v1M20 17H9a4 4 0 0 1-4-4v-1"/><path d="m17 9 2 3 2-3M7 15l-2-3-2 3"/></svg>',
  eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  end:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-3.3 0-6.3 1-8.5 2.7-.6.5-.7 1.4-.2 2l1.5 1.8c.4.5 1.2.6 1.8.3l2-1.2c.4-.3.6-.7.6-1.2v-1.6c1.8-.5 3.8-.5 5.6 0v1.6c0 .5.2.9.6 1.2l2 1.2c.6.3 1.4.2 1.8-.3l1.5-1.8c.5-.6.4-1.5-.2-2C18.3 10 15.3 9 12 9z"/></svg>'
};
function callChoice(){
  const c = cur, can = c.callIn !== false;
  sheet([['📞', 'Apel vocal', () => startCall({video:false})], ['📹', 'Apel video', () => startCall({video:true})],
    ['🔔', can ? `${c.name} te poate suna: Da (atinge ca să oprești)` : `${c.name} te poate suna: Nu (atinge ca să pornești)`, () => { c.callIn = !can; saveChars(); toast(c.callIn ? `🔔 ${c.name} te poate suna` : `🔕 ${c.name} nu te mai sună`); }]]);
}
// ton de apel (ca la operator: 425 Hz, 1 s da, 4 s nu), generat local
function ringback(on){
  try{
    if(!on){ if(ringback.t){ clearInterval(ringback.t); ringback.t = 0; } if(ringback.ac){ ringback.ac.close(); ringback.ac = null; } return; }
    const ac = ringback.ac = new (window.AudioContext || window.webkitAudioContext)(); if(ac.resume) ac.resume().catch(() => {});
    const beep = () => { if(!ringback.ac) return; const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 425; g.gain.value = 0; o.connect(g).connect(ac.destination); const t = ac.currentTime; g.gain.linearRampToValueAtTime(.08, t + .05); g.gain.setValueAtTime(.08, t + 1); g.gain.linearRampToValueAtTime(0, t + 1.05); o.start(t); o.stop(t + 1.1); };
    beep(); ringback.t = setInterval(beep, 4000);
  }catch(e){}
}
function callPics(c, ch){   // pozele ei recente din același loc: în video „mută camera” între ele
  const recent = [...ch.msgs].reverse().filter(m => m.role === 'ai' && m.img && !m.err && Date.now() - (m.ts || 0) < 8 * 36e5);
  if(!recent.length) return c.photo ? [photoNow(c)] : [];
  const room = recent[0].where && recent[0].where.room;
  return recent.filter((m, i) => i === 0 || (room && m.where && m.where.room === room && Date.now() - m.ts < 3 * 36e5)).slice(0, 4).map(m => m.img);
}
function startCall(opts = {}){
  if(call) return;
  if(!SpeechRec){ toast('Telefonul nu are recunoaștere vocală în browser.'); return; }
  if(!('speechSynthesis' in window)){ toast('Telefonul nu are voce pentru citire.'); return; }
  if(!aiReady()){ toast('Pune întâi cheia în Setări.'); return; }
  if(busy){ toast('Așteaptă să termine răspunsul.'); return; }
  stopAllVoice();
  const pics = callPics(cur, chat), video = !!opts.video && pics.length > 0;
  call = {c:cur, ch:chat, t0:0, muted:false, rec:null, alive:true, tick:null, video, see:S.callSee !== 'off', facing:'user', reacts:[], pics, pi:0, barge:S.callBarge !== 'off', incoming:!!opts.incoming};
  const lf = lifeNow(cur);
  const v = document.createElement('div'); v.className = 'callv' + (video ? ' vid' : '');
  v.innerHTML = `<div class="cbg" ${cur.photo ? `data-bgk="${esc(photoNow(cur))}"` : ''}></div>
    ${pics.length ? `<div class="cvid">${pics.map((k, i) => `<img data-k="${esc(k)}" class="${i ? '' : 'on'}" alt="">`).join('')}<i class="cgrain"></i></div>` : ''}
    <video class="cself" playsinline muted autoplay hidden></video>
    <div class="vtop"><span class="vname">${esc(cur.name)}</span><span class="vmeta"><i class="vlive"></i><b id="clTimeV">conectare…</b>${lf && lf.w ? ' · ' + esc(lf.w) : ''}</span></div>
    <div class="ctopc"><small id="clTime">00:00</small></div>
    <div class="cmain"><div class="cava">${cur.photo ? `<img data-k="${esc(photoNow(cur))}" alt="">` : `<span style="background:${colorFor(cur)}">${esc(cur.name[0])}</span>`}<i class="ring"></i></div>
      <h2>${esc(cur.name)}</h2><p id="clState">se apelează…</p><div class="ccap" id="clCap"></div></div>
    <div class="vreact"><button id="clLook" class="vlook" aria-label="Uită-te">👀<small>Uită-te</small></button>${['❤️', '😂', '😮', '👍'].map(e => `<button data-cr="${e}">${e}</button>`).join('')}${pics.length && S.imgProv !== 'none' && !exprSetOf(cur, pics[0]) ? '<button id="clExpr" aria-label="Expresii">🎭</button>' : ''}</div>
    <div class="cbtns">
      <button id="clMute" aria-label="Microfon">${ICO.mic}<span>Microfon</span></button>
      ${pics.length ? `<button id="clVid" aria-label="Video" class="${video ? 'off' : ''}">${ICO.cam}<span>Video</span></button>` : ''}
      <button id="clFlip" class="vonly" aria-label="Întoarce camera">${ICO.flip}<span>Întoarce</span></button>
      <button id="clSee" class="vonly${call.see ? ' off' : ''}" aria-label="Te vede">${ICO.eye}<span>Te vede</span></button>
      <button id="clBarge" class="${call.barge ? 'off' : ''}" aria-label="Întreruperi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/></svg><span>Întrerup</span></button>
      <button id="clEnd" class="end" aria-label="Închide">${ICO.end}<span>Închide</span></button></div>`;
  document.body.appendChild(v); hydrate(v); call.tImgs = performance.now();
  history.pushState({v:'vChat', call:1}, '');
  const c = call, sv = v.querySelector('.cself');
  $('#clEnd').onclick = () => { endCall(); history.back(); };
  // camera ta: pornește odată cu video-ul; nimic nu se salvează
  const camOn = async () => {
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try{
      if(c.cam) c.cam.getTracks().forEach(t => t.stop());
      c.cam = await navigator.mediaDevices.getUserMedia({video:{facingMode:c.facing, width:{ideal:640}}, audio:false});
      if(call !== c){ c.cam.getTracks().forEach(t => t.stop()); return; }
      sv.srcObject = c.cam; sv.hidden = false; sv.classList.toggle('back', c.facing !== 'user');
      if(c.see && !S.callSeeInfo){ S.callSeeInfo = 1; saveSettings(); toast(`👁️ ${c.c.name} te vede: la fiecare replică primește un cadru din camera ta (nu se salvează). Oprești din „Te vede”.`, 5500); }
    }catch(e){ sv.hidden = true; toast('Camera nu e disponibilă; apelul continuă fără ea.', 3000); }
  };
  const camOff = () => { if(c.cam){ c.cam.getTracks().forEach(t => t.stop()); c.cam = null; } sv.hidden = true; };
  const setVideo = on => { c.video = on; v.classList.toggle('vid', on); const b = $('#clVid'); if(b) b.classList.toggle('off', on); if(on) camOn(); else camOff(); poke(); };
  const vb = $('#clVid'); if(vb) vb.onclick = () => { if(call === c) setVideo(!c.video); };
  $('#clFlip').onclick = () => { c.facing = c.facing === 'user' ? 'environment' : 'user'; camOn(); };
  $('#clSee').onclick = () => { c.see = !c.see; S.callSee = c.see ? 'on' : 'off'; saveSettings(); $('#clSee').classList.toggle('off', c.see); toast(c.see ? `👁️ ${c.c.name} te vede` : `🙈 ${c.c.name} nu te mai vede (doar te aude)`); };
  $('#clBarge').onclick = () => { c.barge = !c.barge; S.callBarge = c.barge ? 'on' : 'off'; saveSettings(); $('#clBarge').classList.toggle('off', c.barge); toast(c.barge ? '✋ O poți întrerupe vorbind peste ea' : 'Întreruperile vocale sunt oprite (atingerea subtitrării încă merge)', 3000); if(!c.barge && c.bargeRec){ try{ c.bargeRec.abort(); }catch(e){} } };
  // atingi subtitrarea (sau imaginea) cât vorbește: se oprește și te ascultă
  v.addEventListener('click', e => { if(c.wasCalm){ c.wasCalm = false; return; } if(c.state === 'speak' && !e.target.closest('.cbtns,.vreact,.cself,.vtop')) callInterrupt(c, ''); });
  $('#clMute').onclick = () => { if(call !== c) return; c.muted = !c.muted; $('#clMute').classList.toggle('off', c.muted); if(c.muted){ try{ c.rec && c.rec.abort(); }catch(e){} callState('microfon oprit'); } else if(c.state === 'idle') callListen(); };
  // fereastra ta se trage în orice colț
  let drag = null;
  sv.addEventListener('pointerdown', e => { drag = {x:e.clientX, y:e.clientY, l:sv.offsetLeft, t:sv.offsetTop, moved:false}; sv.setPointerCapture(e.pointerId); });
  sv.addEventListener('pointermove', e => { if(!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if(Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true; sv.style.left = drag.l + dx + 'px'; sv.style.top = drag.t + dy + 'px'; sv.style.right = 'auto'; sv.classList.add('drag'); });
  sv.addEventListener('pointerup', () => { if(!drag) return; const moved = drag.moved; drag = null; sv.classList.remove('drag');
    if(!moved){ sv.classList.toggle('big'); return; }
    const W = innerWidth, H = innerHeight, r = sv.getBoundingClientRect(), m = 14, left = r.left + r.width / 2 < W / 2;
    const top = r.top + r.height / 2 < H / 2 ? 56 + (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0) : H - r.height - 170;
    sv.style.left = (left ? m : W - r.width - m) + 'px'; sv.style.top = Math.max(40, top) + 'px'; });
  // butoanele se ascund singure în video; o atingere le aduce înapoi
  let hideT = 0;
  const poke = () => { v.classList.remove('calm'); clearTimeout(hideT); if(c.video) hideT = setTimeout(() => { if(call === c && c.video) v.classList.add('calm'); }, 4500); };
  v.addEventListener('pointerdown', e => { c.wasCalm = v.classList.contains('calm'); if(!e.target.closest('.cbtns,.vreact,.cself')) poke(); });   // atingerea care aduce butoanele înapoi nu o întrerupe
  // reacții în timpul apelului: le vede și le ia în seamă la replica următoare
  v.querySelectorAll('[data-cr]').forEach(b => b.onclick = () => { fxBurst(b.dataset.cr, 10); c.reacts.push(b.dataset.cr); poke(); exprShow(c, b.dataset.cr === '😂' ? 'ras' : b.dataset.cr === '😮' ? 'surpriza' : 'zambet'); });
  $('#clLook').onclick = () => { poke(); callLook(c); };
  // 8.16: expresiile ei (generate o dată pentru imaginea de bază)
  c.expr0 = pics[0]; if(exprSetOf(c.c, c.expr0)) exprInject(c);
  if(pics.length) vfStart(c);   // 9.5: fața care vorbește
  const eb = $('#clExpr'); if(eb) eb.onclick = () => { if(eb.disabled) return; eb.disabled = true; eb.innerHTML = '<span class="spin"></span>'; toast(`🎭 Generez 5 expresii pentru ${c.c.name} (5 poze, o singură dată pentru imaginea asta). Apelul continuă.`, 4500); exprGen(c.c, c.expr0).then(ok => { if(ok){ toast('🎭 Expresiile sunt gata: fața ei reacționează acum'); if(call === c) exprInject(c); } else if(eb.isConnected){ eb.disabled = false; eb.textContent = '🎭'; } }); };
  c.watchT = setInterval(() => callWatch(c), 2000);
  // „vorbește”: imaginea tresare pe cuvinte, iar subtitrarea se aprinde cuvânt cu cuvânt
  window.__talk = (e, off = 0) => {
    if(c.vf && c.vf.ready) vfWord(c, e);   // 9.5: gura se mișcă pe silabe
    else { const cv = v.querySelector('.cvid'); if(cv){ cv.classList.add('w'); clearTimeout(window.__talkT); window.__talkT = setTimeout(() => cv.classList.remove('w'), 110); } }
    if(e && typeof e.charIndex === 'number'){ const at = off + e.charIndex; v.querySelectorAll('#clCap .kw').forEach(w => w.classList.toggle('lit', +w.dataset.i <= at)); }
  };
  // „camera” ei trece încet între pozele din același loc
  if(pics.length > 1) c.picT = setInterval(() => { if(call !== c || c.state === 'speak') return; if(c.exprReady) return; const ims = v.querySelectorAll('.cvid img:not(.ex)'); ims[c.pi].classList.remove('on'); c.pi = (c.pi + 1) % ims.length; ims[c.pi].classList.add('on'); if(c.vf) vfSwitch(c, ims[c.pi]); }, 22000);
  if(video) camOn();
  // sună întâi, apoi răspunde (la un apel primit ești deja conectat)
  c.state = 'ring'; callState(c.incoming ? 'conectare…' : 'se apelează…', 'ring'); if(!c.incoming) ringback(true);
  setTimeout(() => {
    ringback(false); if(call !== c) return;
    callWake(c, true);
    c.t0 = Date.now(); v.classList.add('live');
    c.tick = setInterval(() => { if(call !== c) return; const s = Math.floor((Date.now() - c.t0) / 1000), t = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); $('#clTime').textContent = t; $('#clTimeV').textContent = t; }, 500);
    poke();
    const u = S.userName.trim() || 'el';
    callReply({pro:true, note: c.incoming
      ? `(Notă de regie, nu o menționa ca atare: TU l-ai sunat pe ${u} ${c.video ? 'pe video' : 'pe telefon'} și el tocmai a răspuns. Începe tu: salută-l și spune firesc de ce suni${opts.reason ? ' („' + opts.reason + '”)' : ' (ți-era dor să-i auzi vocea, ai ceva să-i povestești sau ai o întrebare, după ce faci acum)'}. ${callFix(c)}.)`
      : `(Notă de regie, nu o menționa ca atare: ${u} te sună acum ${c.video ? 'pe video' : 'pe telefon'} și tu răspunzi. Salută-l scurt, în felul tău și după ce faci acum. ${callFix(c)}.)`});
  }, c.incoming ? 700 : 2600 + Math.random() * 2400);
}
function callState(t, cls){ const el = $('#clState'); if(el){ el.textContent = t; el.className = cls || ''; } const v = $('.callv'); if(v) v.dataset.st = cls || ''; }
function endCall(){
  if(!call) return;
  const c = call;
  call = null; c.alive = false; clearInterval(c.tick); clearInterval(c.picT); window.__talk = null; ringback(false); callWake(c, false); vfStop(c);
  try{ c.bargeRec && c.bargeRec.abort(); }catch(e){} clearInterval(c.pollT); clearInterval(c.watchT); clearTimeout(c.exT);
  if(c.cam){ try{ c.cam.getTracks().forEach(t => t.stop()); }catch(e){} }
  try{ c.rec && c.rec.abort(); }catch(e){}
  try{ speechSynthesis.cancel(); }catch(e){}
  if(busy && live && live.ch === c.ch) busy.abort();
  const sec = c.t0 ? Math.floor((Date.now() - c.t0) / 1000) : 0, dur = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const v = $('.callv');
  if(v){
    const sv = v.querySelector('.cself'); if(sv){ sv.hidden = true; sv.srcObject = null; }
    // ecran de final: cine, cât, apoi se închide
    v.insertAdjacentHTML('beforeend', `<div class="cend"><div class="cendin">${avatarHTML(c.c)}<b>${c.video ? '📹 Apel video' : '📞 Apel'} încheiat</b><small>${esc(c.c.name)}${sec ? ' · ' + dur : ' · neconectat'}</small></div></div>`); hydrate(v);
    setTimeout(() => { v.classList.add('out'); setTimeout(() => v.remove(), 300); }, sec > 3 ? 1400 : 500);
  }
}
// 8.14: textul de rostit, curățat la fel și pe bucăți (cât se scrie) și la final
function callClean(t){
  let x = String(t || '');
  for(let k = 0; k < 4; k++) x = x.replace(/^\s*\[[^\]\n]*\]\s*/, '');                       // [❤️] [vocal] de la început
  x = x.split(/\s*\[(?:stare|acum|poz|programez|sun|răspuns|raspuns|sticker|corectur)/i)[0];             // etichetele de la final
  x = x.replace(/\*[^*]*\*/g, ' ').replace(/\*[^*]*$/, ' ').replace(/\[[^\]]*\]/g, ' ');     // acțiuni (și una neterminată)
  return ttsText(plain(faraLiniute(x)), false).replace(/\s{2,}/g, ' ').trimStart();
}
// o propoziție pusă la coadă în vocea telefonului; subtitrarea crește odată cu ea
function callSay(c, text, capOff){
  return new Promise(res => {
    const u = new SpeechSynthesisUtterance(text); u.lang = langOf(c.c);
    const v = phoneVoice(langOf(c.c)), g = genderOf(c.c); if(v) u.voice = v;
    u.pitch = c.c.vPitch || (g === 'm' ? .9 : g === 'f' ? 1.06 : 1); u.rate = /\?\s*$/.test(text) ? 1.03 : .99;
    u.onstart = () => { if(call === c){ c.state = 'speak'; callState('vorbește', 'speak'); callBarge(c); } };
    u.onboundary = e => { if(window.__talk) window.__talk(e, capOff); };
    u.onend = u.onerror = () => res();
    speechSynthesis.speak(u);
  });
}
function capAppend(c, text){
  const cap = $('#clCap'); if(!cap) return 0;
  if(!c.capOn){ cap.innerHTML = ''; c.capOn = true; c.capLen = 0; }
  const off = c.capLen; let pos = off;
  cap.insertAdjacentHTML('beforeend', (off ? ' ' : '') + text.split(/(\s+)/).map(w => { const i = pos; pos += w.length; return /\S/.test(w) ? `<span class="kw" data-i="${i}">${esc(w)}</span>` : w; }).join(''));
  c.capLen = pos + 1;
  return off;
}
async function callReply(opts){
  const c = call; if(!c) return;
  { const r0 = c.rec; c.rec = null; try{ r0 && r0.abort(); }catch(e){} }   // nicio ascultare veche nu mai rămâne pornită peste răspuns
  c.state = 'think'; c.capOn = false; c.interrupted = false; callState('se gândește…', 'think'); $('#clCap').innerHTML = '<span class="cdots"><i></i><i></i><i></i></span>';
  while(busy && call === c) await sleep(300);
  if(call !== c) return;
  const n0 = c.ch.msgs.length;
  const run = reply(null, {c:c.c, ch:c.ch, fix:opts.pro ? '' : callFix(c), tag:'apel', ...opts});
  const m = c.ch.msgs[n0];
  // vorbește de la prima propoziție gata, cât restul încă se scrie
  let said = 0, done = false; const q = [];
  const speakNew = final => {
    if(!m || c.interrupted) return;
    const t = callClean(m.text); let rest = t.slice(said);
    if(!final){ const mm = rest.match(/^[\s\S]*?[.!?…]+["”»)]?(?=\s)/); if(!mm || mm[0].trim().length < 2) return; rest = mm[0]; }
    said += rest.length; rest = rest.trim(); if(!rest) return;
    const off = capAppend(c, rest);
    q.push(callSay(c, rest, off));
  };
  const exOf = () => { const x = m && (m.face ? [0, m.face] : m.text && m.text.match(/\[fa[țt][ăa]:\s*([^\]\n]{1,20})\]/i)); if(x && !m._ex){ m._ex = 1; exprShow(c, x[1].trim()); }
    else if(m && m.text && !m._ex && !m._exT){ const k = exprFromText(m.text); if(k){ m._exT = 1; exprShow(c, k); } } };   // 9.5: și după ce spune
  c.pollT = setInterval(() => { if(call !== c) return clearInterval(c.pollT); if(m && m.text && !m.err){ exOf(); speakNew(false); } }, 120);
  try{ await run; } catch(e){}
  clearInterval(c.pollT); done = true;
  if(c.interrupted && m && !m.err){ m.text = (c.saidText || callClean(m.text).split(/\s+/).slice(0, 4).join(' ')).trim() + '…'; if(m.alts) m.alts[m.alt || 0] = m.text; m.call = true; await saveChat(c.c, c.ch); return; }   // în istoric rămâne doar ce a apucat să spună
  if(call !== c) return;
  if(!m || m.err){ if(c.interrupted) return; callState(m && m.err ? '⚠️ ' + m.err : 'n-a mers', 'err'); c.state = 'idle'; setTimeout(() => call === c && callListen(), 1500); return; }
  m.call = true; if(c.video) m.video = true; exOf(); delete m._ex;
  speakNew(true);
  if(!q.length && !c.interrupted){ c.state = 'idle'; callListen(); return; }
  await Promise.all(q);
  if(call !== c || c.interrupted) return;
  $('#clCap').querySelectorAll('.kw').forEach(w => w.classList.add('lit'));
  try{ c.bargeRec && c.bargeRec.abort(); }catch(e){} c.bargeRec = null;
  c.lastSpeakEnd = Date.now(); c.ref = null;
  c.state = 'idle'; callListen();
}
// 8.14: o întrerupi vorbind peste ea (sau atingând subtitrarea): se oprește și te ascultă
function callInterrupt(c, heard){
  if(call !== c || c.state !== 'speak') return;
  c.saidText = [...($('#clCap') ? $('#clCap').querySelectorAll('.kw.lit') : [])].map(w => w.textContent).join(' ');
  c.interrupted = true; c.state = 'listen';
  try{ speechSynthesis.cancel(); }catch(e){}
  if(busy && live && live.ch === c.ch) busy.abort();
  callState('te ascultă…', 'listen'); $('#clCap').innerHTML = heard ? `<span class="cme">${esc(heard)}</span>` : '';
  if(!c.bargeRec) callListen(true);
}
function callBarge(c){
  if(!c.barge || c.muted || c.bargeRec || call !== c) return;
  let r; try{ r = new SpeechRec(); }catch(e){ return; }
  r.lang = langOf(c.c); r.interimResults = true; r.continuous = false; c.bargeRec = r;
  const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  let final = '', heard = '';
  r.onresult = e => {
    let t = ''; for(let i = 0; i < e.results.length; i++){ t += e.results[i][0].transcript; if(e.results[i].isFinal) final = t; }
    heard = t.trim();
    if(c.state === 'speak'){
      const ws = norm(heard); if(ws.length < 2) return;
      const said = new Set(norm($('#clCap') ? $('#clCap').textContent : ''));
      if(ws.filter(w => said.has(w)).length / ws.length > .5) return;     // e propria ei voce auzită în difuzor
      callInterrupt(c, heard);
    } else if(c.state === 'listen') $('#clCap').innerHTML = `<span class="cme">${esc(heard)}</span>`;
  };
  r.onerror = () => {};
  r.onend = async () => {
    if(c.bargeRec === r) c.bargeRec = null;
    if(call !== c) return;
    if(c.state === 'speak'){ setTimeout(() => callBarge(c), 250); return; }        // a tăcut fără să te audă: ascultăm mai departe
    if(c.state === 'listen' && c.interrupted){
      const t = (final || heard).trim();
      if(!t){ c.state = 'idle'; callListen(); return; }
      await callUserSaid(c, t);
    }
  };
  try{ r.start(); }catch(e){ c.bargeRec = null; }
}
/* ───────── 👀 8.16: ce vede ea pe camera ta + expresiile ei ───────── */
const EXPR = {zambet:['😊', 'a big warm genuine smile, eyes smiling'], ras:['😂', 'laughing out loud, eyes squinting with joy, head slightly tilted back'], surpriza:['😮', 'surprised and amazed, eyebrows raised, mouth slightly open'], ganditoare:['🤔', 'thoughtful, a slight smile, eyes looking a little to the side'], trista:['🥺', 'a little sad and touched, soft eyes, gentle pout']};
const EXPR_ALIAS = {zambet:'zambet', 'zâmbet':'zambet', ras:'ras', 'râs':'ras', surpriza:'surpriza', 'surpriză':'surpriza', ganditoare:'ganditoare', 'gânditoare':'ganditoare', 'gânditor':'ganditoare', ganditor:'ganditoare', trista:'trista', 'tristă':'trista', trist:'trista', neutra:'', 'neutră':'', neutru:''};
// 9.5: expresia și după ce spune (când nu a pus tagul [față: …])
function exprFromText(t){
  t = String(t || '').toLowerCase();
  if(/\b(ha(ha)+|hi(hi)+|he(he)+)\b|😂|🤣|😆/.test(t)) return 'ras';
  if(/\b(wow|uau|serios\?|nu pot să cred|pe bune\?)|😮|😲|😱/.test(t)) return 'surpriza';
  if(/😢|😭|🥺|\bîmi pare (atât de )?rău\b|\b(trist|tristă|mi-e dor)\b/.test(t)) return 'trista';
  if(/\bhm+\b|🤔|stai să mă gândesc|nu știu ce să zic/.test(t)) return 'ganditoare';
  if(/😊|☺️|🥰|😍|😘|\b(ce drăguț|ce frumos|mă bucur)\b/.test(t)) return 'zambet';
  return '';
}
const exprSetOf = (c, k) => c && c.expr && c.expr[k] && Object.keys(c.expr[k]).length >= 3 ? c.expr[k] : null;
function lumaThumb(sv){
  const cv = lumaThumb.cv || (lumaThumb.cv = document.createElement('canvas')); cv.width = 32; cv.height = 24;
  const g = cv.getContext('2d', {willReadFrequently:true}); g.drawImage(sv, 0, 0, 32, 24);
  const d = g.getImageData(0, 0, 32, 24).data, out = new Uint8Array(32 * 24);
  for(let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
  return out;
}
const lumaDiff = (a, b) => { let s = 0; for(let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
// cât taci, se uită la tine: dacă în cadru apare ceva nou (alt loc, un animal, un obiect arătat), comentează singură
async function callWatch(c){
  if(call !== c || !c.video || !c.see || !c.cam || c.state !== 'listen' || c.looking || c.interim) return;
  const sv = $('.callv .cself'); if(!sv || !sv.videoWidth) return;
  const th = lumaThumb(sv);
  if(!c.ref){ c.ref = th; return; }
  if(lumaDiff(th, c.ref) < 16){ c.chg = 0; return; }
  if((c.chg = (c.chg || 0) + 1) < 2) return;                                   // schimbarea trebuie să țină ~4 s
  if(Date.now() - (c.lastLook || c.t0) < 30e3 || (c.looks || 0) >= 6 || Date.now() - (c.lastSpeakEnd || 0) < 8e3) return;
  c.looking = true; c.ref = th; c.chg = 0;
  const img = callFrame(c);
  try{
    if(!img) return;
    const j = parseJSON(await stream('Ești ochii unui personaj într-un apel video. Răspunzi DOAR cu JSON valid.', [{role:'user', image:img, text:
`Imaginea e ce se vede acum în camera lui. Înainte se vedea: ${c.lastSeen || 'nu știu'}.
E ceva NOU și demn de remarcat de un prieten într-un apel video (a apărut un animal, cineva, un obiect pe care i-l arată, a schimbat locul sau camera, face ceva amuzant, s-a schimbat mult lumina)? Mici mișcări sau aceeași scenă nu contează.
JSON: {"nou":false,"ce":"ce se vede acum, 4-12 cuvinte, în română"}`}], {max:120, aux:true, cid:c.c.id, tag:'apel'}));
    c.lastSeen = String(j.ce || c.lastSeen || '').slice(0, 120);
    if(!j.nou || call !== c || c.state !== 'listen' || c.interim) return;
    c.lastLook = Date.now(); c.looks = (c.looks || 0) + 1;
    callReply({liveImg:img, pro:true, note:`(Notă de regie, nu o menționa ca atare: în camera lui tocmai ai observat ceva nou: ${c.lastSeen}. Reacționează spontan și scurt, ca într-un apel video: o exclamație, o întrebare sau un comentariu firesc despre ce vezi. ${callFix(c)}.)`});
  }catch(e){} finally { c.looking = false; }
}
// „👀 Uită-te”: îi arăți ceva și comentează exact ce vede
function callLook(c){
  if(call !== c || !c.video) return;
  if(!c.cam){ toast('Pornește întâi camera (butonul Video).'); return; }
  if(c.state === 'think'){ toast('Stai puțin, se gândește…'); return; }
  if(c.state === 'speak'){ c.interrupted = true; try{ speechSynthesis.cancel(); }catch(e){} if(busy && live && live.ch === c.ch) busy.abort(); }
  const img = callFrame(c, 768, true); if(!img){ toast('Camera nu e gata încă.'); return; }
  fxBurst('👀', 6); c.lastLook = Date.now(); c.ref = null;
  callReply({liveImg:img, pro:true, note:`(Notă de regie, nu o menționa ca atare: ${S.userName.trim() || 'el'} îți arată ceva la cameră chiar acum (vezi imaginea). Uită-te atent și spune concret ce vezi și ce părere ai, în felul tău, scurt, ca într-un apel video. ${callFix(c)}.)`});
}
// expresiile ei, generate o singură dată pentru imaginea de bază a apelului
async function exprGen(c, baseK){
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări.'); return false; }
  const base = await DB.get(baseK); if(!base) return false;
  c.expr = c.expr || {}; const set = c.expr[baseK] = c.expr[baseK] || {};
  // 9.5: pe modelul ales la „Fidelitatea feței” (9B ține fața), toate deodată, fiecare verificată în telefon că e aceeași față
  const nine = S.imgProv === 'worker' && S.wkChat === 'ancorat' && (!Number.isFinite(capLeft()) || capLeft() >= 5 * (neurPerPhoto('ancorat') || 1455) + ECO_RESERVE);
  const model = nine ? 'ancorat' : (S.imgProv === 'worker' ? 'eco' : undefined), per = neurPerPhoto(model) || 5000;   // 9.6: Eco dacă 9B nu încape în limita zilei
  let todo = Object.entries(EXPR).filter(([k]) => !set[k]);
  if(S.imgProv === 'worker'){ const fit = Math.floor(capLeft() / per); if(fit < todo.length){ todo = todo.slice(0, Math.max(0, fit)); if(!todo.length){ toast('Limita zilnică de poze a fost atinsă; continui mâine.', 3500); return false; } } }
  let ref = null; try{ const f = (await faceDescs(base)).sort((a, b) => b.a - a.a)[0]; if(f) ref = f.d; }catch(e){}
  const same = async b => { if(!ref) return 0; try{ const fs = await faceDescs(b); return fs.length ? Math.min(...fs.map(f => fdist(f.d, ref))) : 1; }catch(e){ return 0; } };
  const one = async ([k, [, en]]) => {
    const p = `Edit this exact photo: the same person, the same face and identity, the same clothes, the same pose, background, framing and light. Change ONLY the facial expression to: ${en}. Keep the real skin texture. Photorealistic, natural, no other changes.`;
    let b = await genImage(p, base, null, null, {force:{two:false, px:768}, model, quiet:true, why:'expresii'}), d = await same(b); addUsage(c.id, imgPrice(), 'img', null, 'apel');
    if(d > .45 && (S.imgProv !== 'worker' || capLeft() >= per)){   // fața a alunecat: încă o încercare, rămâne cea mai apropiată
      try{ const b2 = await genImage(p, base, null, null, {force:{two:false, px:768}, model, quiet:true, why:'expresii'}), d2 = await same(b2); addUsage(c.id, imgPrice(), 'img', null, 'apel'); if(d2 < d){ b = b2; d = d2; } }catch(e){}
    }
    try{ if(b.type === 'image/png') b = await toJpeg(b, 1536, .9); }catch(e){}
    set[k] = await saveImg(b); await saveChars();
    if(call && call.c === c) exprInject(call);
  };
  const rs = await Promise.allSettled(todo.map(one));
  const bad = rs.find(r => r.status === 'rejected'); if(bad) toast('Unele expresii n-au ieșit: ' + bad.reason.message, 3500);
  return rs.some(r => r.status === 'fulfilled');
}
function exprInject(c){   // adaugă în apel imaginile cu expresii deja gata
  const set = c.expr0 && exprSetOf(c.c, c.expr0); const cv = $('.callv .cvid'); if(!set || !cv) return;
  for(const [k, key] of Object.entries(set)) if(!cv.querySelector(`img[data-ex="${k}"]`)) cv.insertAdjacentHTML('afterbegin', `<img class="ex" data-ex="${k}" data-k="${esc(key)}" alt="">`);
  hydrate(cv); c.exprReady = true; clearInterval(c.picT);
  const b = $('#clExpr'); if(b) b.remove();
}
function exprShow(c, k){
  const cv = $('.callv .cvid'); if(!cv || !c.exprReady) return;
  k = EXPR_ALIAS[String(k || '').toLowerCase()] ?? '';
  const target = k && cv.querySelector(`img[data-ex="${k}"]`) || cv.querySelector('img:not(.ex)');
  if(!target || target.classList.contains('on')) return;
  cv.querySelectorAll('img').forEach(i => i.classList.toggle('on', i === target));
  if(c.vf) vfSwitch(c, target);   // 9.5: și fața cu expresie vorbește
  clearTimeout(c.exT); if(k) c.exT = setTimeout(() => { if(call === c && c.state !== 'speak') exprShow(c, ''); }, 9000);
}
/* ═════════ 🗣️ 9.5: fața care vorbește, în telefon (fără alt serviciu, fără cost) ═════════
   Pe imaginea din apel, face-api găsește 68 de puncte ale feței. Peste imagine se desenează (WebGL) o rețea de triunghiuri
   prinsă de ele; mișcând punctele, se mișcă doar fața: gura se deschide pe silabe (cu interiorul gurii desenat separat),
   ochii clipesc, capul se mișcă ușor, sprâncenele se ridică la întrebări. Restul pozei rămâne neatins. */
function vfDelaunay(P){   // Bowyer–Watson; P = [[x,y],…] → triunghiuri [i,j,k]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for(const [x, y] of P){ x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const d = Math.max(x1 - x0, y1 - y0) * 20, mx = (x0 + x1) / 2, my = (y0 + y1) / 2, n = P.length;
  const Q = P.concat([[mx - d, my - d], [mx, my + d], [mx + d, my - d]]);
  const circ = (a, b, c) => { const [ax, ay] = Q[a], [bx, by] = Q[b], [cx, cy] = Q[c], D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if(Math.abs(D) < 1e-9) return {x:0, y:0, r:Infinity};
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return {x:ux, y:uy, r:(ax - ux) ** 2 + (ay - uy) ** 2}; };
  let T = [{v:[n, n + 1, n + 2], c:circ(n, n + 1, n + 2)}];
  for(let i = 0; i < n; i++){
    const [px, py] = Q[i], bad = [], good = [];
    for(const t of T) ((px - t.c.x) ** 2 + (py - t.c.y) ** 2 < t.c.r ? bad : good).push(t);
    const E = new Map();
    for(const t of bad) for(let k = 0; k < 3; k++){ const a = t.v[k], b = t.v[(k + 1) % 3], key = a < b ? a + ',' + b : b + ',' + a; E.set(key, E.has(key) ? null : [a, b]); }
    T = good;
    for(const e of E.values()) if(e) T.push({v:[e[0], e[1], i], c:circ(e[0], e[1], i)});
  }
  return T.filter(t => t.v.every(k => k < n)).map(t => t.v);
}
const VF_VS = 'attribute vec2 p;attribute vec2 t;uniform vec2 s;varying vec2 v;void main(){v=t;gl_Position=vec4(p.x/s.x*2.0-1.0,1.0-p.y/s.y*2.0,0.0,1.0);}';
const VF_FS = 'precision mediump float;varying vec2 v;uniform sampler2D x;uniform vec4 col;uniform float m;void main(){gl_FragColor=m>0.5?col:texture2D(x,v);}';
function vfGL(cv){
  const gl = cv.getContext('webgl', {premultipliedAlpha:false, antialias:true, preserveDrawingBuffer:false}); if(!gl) return null;
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VF_VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, VF_FS)); gl.linkProgram(pr);
  if(!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('webgl link');
  gl.useProgram(pr);
  return {gl, pr, aP:gl.getAttribLocation(pr, 'p'), aT:gl.getAttribLocation(pr, 't'), uS:gl.getUniformLocation(pr, 's'), uC:gl.getUniformLocation(pr, 'col'), uM:gl.getUniformLocation(pr, 'm'),
    bP:gl.createBuffer(), bT:gl.createBuffer(), tex:gl.createTexture()};
}
// punctele feței pe o imagine (o dată per imagine; ținute în memorie pentru apel)
const vfCache = new Map();
async function vfLandmarks(img){
  const key = img.currentSrc || img.src; if(vfCache.has(key)) return vfCache.get(key);
  const f = await faceApi();
  const r = (await f.detectAllFaces(img, new f.TinyFaceDetectorOptions({inputSize:608, scoreThreshold:.4})).withFaceLandmarks()).sort((a, b) => b.detection.box.area - a.detection.box.area)[0];
  const out = r ? r.landmarks.positions.map(p => [p.x, p.y]) : null;
  vfCache.set(key, out); return out;
}
// silabele unui cuvânt (grupuri de vocale) → câte deschideri de gură
const vfSyl = w => Math.max(1, (String(w).toLowerCase().match(/[aeiouăâîyàáèéìíòóùúöü]+/g) || []).length);
const vfVow = w => { const v = (String(w).toLowerCase().match(/[aeiouăâîyàáèéìíòóùúöü]/g) || []); return v.length ? v : ['a']; };
// 9.9: formele buzelor după litere (româna se scrie cum se pronunță): deschidere, lățime, buze lipite
const VF_VIS = (ch, nx) => {
  if('a'.includes(ch)) return {o:.95, w:1.03, v:1};
  if('ăâî'.includes(ch)) return {o:.45, w:1, v:1};
  if('e'.includes(ch)) return {o:.5, w:1.09, v:1};
  if('iy'.includes(ch)) return {o:.28, w:1.14, v:1};
  if('oó'.includes(ch)) return {o:.62, w:.84, v:1};
  if('uú'.includes(ch)) return {o:.34, w:.78, v:1};
  if('mbp'.includes(ch)) return {o:0, w:.98, p:1};
  if('fv'.includes(ch)) return {o:.1, w:1.02, f:1};
  if('sșzțj'.includes(ch) || (ch === 'c' || ch === 'g') && /[ei]/.test(nx || '')) return {o:.16, w:1.08};
  if('lntdr'.includes(ch)) return {o:.3, w:1};
  return {o:.24, w:1};
};
const VF_WARM = /\b(drag|dragă|iubire|iubitule|iubito|frumos|frumoasă|mulțumesc|bine|super|minunat|haha|hihi|pupic|pup|te iubesc|dor|bucur|perfect)\b|❤|😊|🥰|😍|😘|☺/i;
function vfWord(c, e){
  const V = c.vf; if(!V || !V.ready) return;
  const u = e && e.utterance, txt = u ? u.text : '', i = e && typeof e.charIndex === 'number' ? e.charIndex : -1;
  let w = ''; if(txt && i >= 0){ const m = txt.slice(i).match(/^[\p{L}\p{N}'’-]+/u); w = m ? m[0] : ''; }
  if(!w) return;
  const now = performance.now(); V.lastWord = now;
  const rate = (u && u.rate) || 1, n = vfSyl(w), dur = Math.min(950, Math.max(150, n * 170 / rate));
  // litere → cadre-cheie, vocalele țin mai mult decât consoanele
  const L = [...w.toLowerCase()].filter(ch => /\p{L}/u.test(ch)), wt = L.map(ch => /[aeiouăâîyóú]/.test(ch) ? 1 : .55), tot = wt.reduce((a, b) => a + b, 0) || 1;
  let t = now;
  L.forEach((ch, k) => { const d = dur * wt[k] / tot, v = VF_VIS(ch, L[k + 1]); V.kf.push({t:t + d * .5, ...v, a:.8 + Math.random() * .3}); t += d; });
  V.kf.push({t:t + 70, o:0, w:1, rest:1});
  const after = txt.slice(i + w.length, i + w.length + 3);
  if(/^[.!…]/.test(after)) V.nods.push({t:t + 40, a:1});                                     // încuviințează la final de propoziție
  else if(w.length >= 7 && Math.random() < .35) V.nods.push({t:now + dur * .4, a:.5});         // și pe cuvinte apăsate, din când în când
  if(/^\?/.test(after) || /\?/.test(txt.slice(i, i + w.length + 2))){ V.brow = now; V.tiltT = now; }
  if(VF_WARM.test(w)) V.smileT = now;
}
async function vfSwitch(c, img){
  const V = c.vf; if(!V || !img) return;
  V.ready = false; V.cv.classList.remove('on');
  const tok = V.tok = (V.tok || 0) + 1;
  try{
    if(!img.complete || !img.naturalWidth) await new Promise((res, rej) => { img.addEventListener('load', res, {once:true}); img.addEventListener('error', rej, {once:true}); });
    const L = await vfLandmarks(img); if(tok !== V.tok || call !== c) return;
    const W0 = img.naturalWidth, H0 = img.naturalHeight;
    if(!L || (L[16][0] - L[0][0]) < W0 * .06){ return; }   // fără față sau prea mică: rămâne imaginea simplă
    const k = Math.min(1, 1024 / Math.max(W0, H0)), W = Math.round(W0 * k), H = Math.round(H0 * k);
    V.cv.width = W; V.cv.height = H;
    const pts = L.map(([x, y]) => [x * k, y * k]);
    const avg = ids => [ids.reduce((a, i) => a + pts[i][0], 0) / ids.length, ids.reduce((a, i) => a + pts[i][1], 0) / ids.length];
    const cx = (pts[0][0] + pts[16][0]) / 2, cy = (pts[19][1] + pts[8][1]) / 2, fw = pts[16][0] - pts[0][0], fh = pts[8][1] - Math.min(pts[19][1], pts[24][1]);
    const clamp = ([x, y]) => [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
    // centrul ochilor (pupilele se mută prin textura de aici), frunte, inel în jurul feței, umeri și piept (respirația), marginile pozei
    const eyes = [avg([36, 37, 38, 39, 40, 41]), avg([42, 43, 44, 45, 46, 47])];
    const brow = [17, 19, 21, 22, 24, 26].map(i => [pts[i][0], pts[i][1] - fh * .38]);
    const ring = []; for(let a = 0; a < 16; a++){ const t = a / 16 * Math.PI * 2; ring.push(clamp([cx + Math.cos(t) * fw * .95, cy + Math.sin(t) * fh * 1.05])); }
    const torso = []; for(const [dy, sp] of [[.95, .62], [1.65, .55]]) for(let q = -2; q <= 2; q++){ const y = pts[8][1] + fh * dy; if(y < H - 4) torso.push(clamp([cx + q * fw * sp, y])); }
    const edge = []; for(let a = 0; a <= 4; a++){ edge.push([W * a / 4, 0], [W * a / 4, H]); if(a && a < 4){ edge.push([0, H * a / 4], [W, H * a / 4]); } }
    const all = pts.concat(eyes, brow, ring, torso, edge);
    const nE = 68, nF = 68 + 2 + brow.length, nR = ring.length, nT = torso.length;
    const tris = vfDelaunay(all);
    const g = V.g, gl = g.gl;
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const ew = Math.hypot(pts[39][0] - pts[36][0], pts[39][1] - pts[36][1]);
    Object.assign(V, {W, H, base:all, nE, nF, nR, nT, tris, idx:new Uint16Array(tris.flat()), uv0:new Float32Array(all.flatMap(([x, y]) => [x / W, y / H])), fw, fh, cx, cy, ew,
      mc:[(pts[48][0] + pts[54][0]) / 2, (pts[48][1] + pts[54][1]) / 2], gap0:Math.max(0, pts[66][1] - pts[62][1]),
      piv:[pts[8][0], pts[8][1] + fh * .35], img, ready:true, kf:[], nods:[], open:0, wid:1, press:0, smile:0, gx:0, gy:0, gtx:0, gty:0, sacAt:0,
      blinkAt:performance.now() + 1500 + Math.random() * 2500});
    V.uv = new Float32Array(V.uv0);
    gl.viewport(0, 0, W, H);
    V.ib = V.ib || gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, V.idx, gl.STATIC_DRAW);
    vfDraw(c, performance.now());
    V.cv.classList.add('on');
  }catch(e){ console.warn('fața care vorbește', e.message); }
}
function vfDraw(c, now){
  const V = c.vf; if(!V || !V.ready) return;
  const g = V.g, gl = g.gl, B = V.base, P = B.map(p => p.slice()), st = c.state, s = st === 'speak', fh = V.fh, fw = V.fw;
  const ease = (cur, tgt, up, dn) => cur + (tgt - cur) * (tgt > cur ? up : dn);
  // ── gura: cadrele-cheie ale literelor; fără cuvinte de la voce, un vorbit generic cât vorbește
  V.kf = V.kf.filter(x => now < x.t + 400);
  let tO = 0, tW = 1, tP = 0;
  const prev = [...V.kf].reverse().find(x => x.t <= now), next = V.kf.find(x => x.t > now);
  if(prev && next && next.t - prev.t < 400){ const f = (now - prev.t) / (next.t - prev.t), m = f * f * (3 - 2 * f);
    tO = (prev.o * (prev.a || 1)) * (1 - m) + (next.o * (next.a || 1)) * m; tW = prev.w * (1 - m) + next.w * m; tP = (prev.p ? 1 - m : 0) + (next.p ? m : 0); }
  else if(next && next.t - now < 120){ tO = next.o * (next.a || 1) * (1 - (next.t - now) / 120); tW = 1 + (next.w - 1) * (1 - (next.t - now) / 120); tP = next.p ? 1 - (next.t - now) / 120 : 0; }
  if(s && !V.kf.length && now - (V.lastWord || 0) > 450){ const t = now / 1000; tO = Math.max(0, .55 * Math.sin(t * 11.3) * Math.sin(t * 3.1 + 1) + .15 * Math.sin(t * 23)); tW = 1 + .06 * Math.sin(t * 4.7); }
  if(!s){ tO = 0; tW = 1; tP = 0; }
  V.open = ease(V.open, tO, .6, .42); V.wid = ease(V.wid, tW, .45, .35); V.press = ease(V.press, tP, .6, .4);
  // ── zâmbetul: la cuvinte calde, și ușor cât te ascultă
  const heard = c.heardAt && now - c.heardAt < 900;
  const smT = Math.max(V.smileT ? Math.max(0, 1 - (now - V.smileT) / 2200) : 0, st === 'listen' ? (heard ? .45 : .25) : 0);
  V.smile = ease(V.smile, smT, .08, .04);
  const o = Math.max(0, V.open), mv = (i, dx, dy) => { P[i][0] += dx; P[i][1] += dy; };
  const L0 = [60, 67, 66, 65, 64].map(i => B[i].slice());   // buza de jos (interior) înainte să coboare maxilarul
  // lățimea buzelor (rotunjit / întins) în jurul centrului gurii
  if(Math.abs(V.wid - 1) > .005) for(let i = 48; i <= 67; i++) P[i][0] = V.mc[0] + (P[i][0] - V.mc[0]) * V.wid;
  // buze lipite (m, b, p): golul din poză se închide
  if(V.press > .02 && V.gap0 > 1){ const h = V.gap0 * .5 * V.press; [61, 62, 63].forEach(i => mv(i, 0, h)); [65, 66, 67].forEach(i => mv(i, 0, -h)); mv(51, 0, h * .4); mv(57, 0, -h * .4); }
  if(o > .01){
    const jaw = o * fh * .085;
    [[55, .8], [56, .95], [57, 1], [58, .95], [59, .8], [64, .55], [65, .95], [66, 1], [67, .95], [60, .55]].forEach(([i, f]) => mv(i, 0, jaw * f));
    [[6, .5], [7, .78], [8, .9], [9, .78], [10, .5], [5, .25], [11, .25]].forEach(([i, f]) => mv(i, 0, jaw * f * .9));
    const lift = V.gap0 < fh * .02 ? .32 : .12; [[61, .8], [62, 1], [63, .8]].forEach(([i, f]) => mv(i, 0, -jaw * lift * f)); [[50, .5], [51, .6], [52, .5]].forEach(([i, f]) => mv(i, 0, -jaw * (lift - .08) * f));
    mv(48, fw * .006 * o, jaw * .25); mv(54, -fw * .006 * o, jaw * .25);
  }
  if(V.smile > .01){ const sm = V.smile; mv(48, -fw * .012 * sm, -fh * .02 * sm); mv(54, fw * .012 * sm, -fh * .02 * sm); [49, 59].forEach(i => mv(i, -fw * .005 * sm, -fh * .01 * sm)); [53, 55].forEach(i => mv(i, fw * .005 * sm, -fh * .01 * sm)); [41, 40, 46, 47].forEach(i => mv(i, 0, -fh * .006 * sm)); }
  // ── clipit (uneori de două ori)
  if(now > V.blinkAt){ V.blinkT = now; V.blinkAt = now + (Math.random() < .15 ? 260 : 2400 + Math.random() * 3600); }
  const bp = V.blinkT ? (now - V.blinkT) / 150 : 2, bl = bp < 1 ? Math.sin(Math.PI * bp) : 0;
  if(bl > 0) [[37, 41], [38, 40], [43, 47], [44, 46]].forEach(([u, d]) => { mv(u, (B[d][0] - B[u][0]) * bl * .95, (B[d][1] - B[u][1]) * bl * 1.02); });
  // ── sprâncenele: la întrebări și când se gândește
  const br = Math.max(V.brow ? Math.max(0, 1 - Math.abs((now - V.brow) / 500 - .6)) : 0, st === 'think' ? .45 : 0);
  if(br > 0) for(let i = 17; i <= 26; i++) mv(i, 0, -fh * .045 * br);
  // ── privirea: salturi mici și fixări; la cameră când vorbește, sus-lateral când se gândește, spre tine când asculți
  if(now > V.sacAt){
    const r = (a) => (Math.random() * 2 - 1) * a;
    if(st === 'think'){ V.gtx = V.thinkSide = V.thinkSide || (Math.random() < .5 ? -.7 : .7); V.gty = -.55 + r(.1); V.sacAt = now + 700 + Math.random() * 900; }
    else { V.thinkSide = 0; V.gtx = r(s ? .18 : .35); V.gty = r(s ? .12 : .2); V.sacAt = now + (s ? 900 : 1300) + Math.random() * (s ? 1400 : 2600); }
  }
  V.gx = ease(V.gx, V.gtx, .5, .5); V.gy = ease(V.gy, V.gty, .5, .5);
  // ── capul: legănat ușor, încuviințări pe fraze, înclinat la întrebări, mici încuviințări cât asculți
  if(st === 'listen' && heard && (!V.lnod || now - V.lnod > 2600 + Math.random() * 1500)){ V.lnod = now; V.nods.push({t:now, a:.55}); }
  V.nods = V.nods.filter(x => now < x.t + 450);
  let nod = 0; for(const x of V.nods){ const ph = (now - x.t) / 420; if(ph > 0 && ph < 1) nod = Math.max(nod, x.a * Math.sin(Math.PI * ph)); }
  const tilt = V.tiltT ? Math.max(0, 1 - Math.abs((now - V.tiltT) / 900 - .5) * 2) : 0;
  const t = now / 1000, breath = Math.sin(t * Math.PI * 2 / 4.2);
  const ang = (Math.sin(t * .7) * .9 + Math.sin(t * 1.9 + 2) * .35 + (s ? Math.sin(t * 3.3) * .4 : 0) + tilt * 2.4 * (V.tiltDir || (V.tiltDir = Math.random() < .5 ? -1 : 1))) * Math.PI / 180;
  const dx = Math.sin(t * .5 + 1) * fw * .008, dy = Math.sin(t * .83) * fh * .006 + (s ? -o * fh * .01 : 0) + nod * fh * .022 + breath * fh * .003;
  const rot = (i, f) => { const [px, py] = V.piv, x = P[i][0] - px, y = P[i][1] - py, ca = Math.cos(ang * f), sa = Math.sin(ang * f); P[i][0] = px + x * ca - y * sa + dx * f; P[i][1] = py + x * sa + y * ca + dy * f; };
  for(let i = 0; i < V.nF; i++) rot(i, 1);
  for(let i = V.nF; i < V.nF + V.nR; i++) rot(i, .45);
  { const [px, py] = V.piv, ca = Math.cos(ang), sa = Math.sin(ang); for(const q of L0){ const x = q[0] - px, y = q[1] - py; q[0] = px + x * ca - y * sa + dx; q[1] = py + x * sa + y * ca + dy; } }
  // respirația: umerii și pieptul urcă ușor
  for(let i = V.nF + V.nR, k = 0; k < V.nT; i++, k++) P[i][1] -= breath * fh * (k < 5 ? .007 : .011);
  // pupilele: textura din centrul ochiului se mută puțin (conturul ochiului rămâne)
  const ux = V.gx * V.ew * .14 / V.W, uy = V.gy * V.ew * .07 / V.H;
  for(const e of [68, 69]){ V.uv[e * 2] = V.uv0[e * 2] - ux; V.uv[e * 2 + 1] = V.uv0[e * 2 + 1] - uy; }
  // ── desen: imaginea deformată
  gl.useProgram(g.pr); gl.uniform2f(g.uS, V.W, V.H); gl.uniform1f(g.uM, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, g.bP); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(P.flat()), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(g.aP); gl.vertexAttribPointer(g.aP, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, g.bT); gl.bufferData(gl.ARRAY_BUFFER, V.uv, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(g.aT); gl.vertexAttribPointer(g.aT, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.ib);
  gl.disable(gl.BLEND); gl.drawElements(gl.TRIANGLES, V.idx.length, gl.UNSIGNED_SHORT, 0);
  // interiorul gurii: doar golul nou (între buza de jos de dinainte și cea coborâtă); dinții de sus rămân cei din poză
  if(o > .06){
    const low = [60, 67, 66, 65, 64].map(i => P[i]);
    if(V.gap0 < fh * .02) [60, 61, 62, 63, 64].forEach((i, k) => { L0[k] = P[i].slice(); });
    const gap = P[66][1] - L0[2][1];
    if(gap > 1.5){
      const fan = [];
      for(let k = 0; k < 4; k++){ const a = L0[k], b = L0[k + 1], c2 = low[k], d2 = low[k + 1]; fan.push(a[0], a[1], b[0], b[1], d2[0], d2[1], a[0], a[1], d2[0], d2[1], c2[0], c2[1]); }
      // cavitatea în două straturi: marginea mai deschisă (se topește în buze), interiorul mai închis
      const mid = L0.map((q, k) => [(q[0] + low[k][0]) / 2, (q[1] + low[k][1]) / 2]), inset = [];
      for(let k = 0; k < 4; k++){ const sh = (p, m2, f) => [m2[0] + (p[0] - m2[0]) * f, m2[1] + (p[1] - m2[1]) * f];
        const a = sh(L0[k], mid[k], .55), b = sh(L0[k + 1], mid[k + 1], .55), c2 = sh(low[k], mid[k], .55), d2 = sh(low[k + 1], mid[k + 1], .55);
        inset.push(a[0], a[1], b[0], b[1], d2[0], d2[1], a[0], a[1], d2[0], d2[1], c2[0], c2[1]); }
      // gura era închisă în poză: o urmă de dinți sus, subțiată spre colțuri și discretă
      const closed = V.gap0 < fh * .02, th = Math.min(gap * .28, fh * .026), teeth = [];
      if(closed){ const T = [L0[1], L0[2], L0[3]], hs = [th * .45, th, th * .45];
        for(let k = 0; k < 2; k++){ const a = T[k], b = T[k + 1]; teeth.push(a[0], a[1], b[0], b[1], b[0], b[1] + hs[k + 1], a[0], a[1], b[0], b[1] + hs[k + 1], a[0], a[1] + hs[k]); } }
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(g.uM, 1); gl.disableVertexAttribArray(g.aT);
      const al = Math.min(1, (o - .06) * 3), draw = (arr, r, gg, bb, aa) => { gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW); gl.vertexAttribPointer(g.aP, 2, gl.FLOAT, false, 0, 0); gl.uniform4f(g.uC, r, gg, bb, aa); gl.drawArrays(gl.TRIANGLES, 0, arr.length / 2); };
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bP);
      draw(fan, .34, .12, .12, .78 * al);
      if(inset.length) draw(inset, .17, .05, .06, .7 * al);
      if(teeth.length) draw(teeth, .86, .82, .77, .3 * al);
      gl.enableVertexAttribArray(g.aT);
    }
  }
}
function vfStart(c){
  if(S.callFace === 'off' || c.vf) return;
  const cvd = $('.callv .cvid'); if(!cvd) return;
  const cv = document.createElement('canvas'); cv.className = 'cface';
  cv.style.animationDelay = -((performance.now() - (c.tImgs || performance.now())) / 1000) + 's';   // în pas cu pozele de dedesubt
  let g; try{ g = vfGL(cv); }catch(e){ g = null; }
  if(!g) return;   // fără WebGL: rămâne imaginea simplă
  cvd.insertBefore(cv, cvd.querySelector('.cgrain')); cvd.classList.add('vf');
  c.vf = {cv, g, q:[], open:0, ready:false};
  cv.addEventListener('webglcontextlost', e => { e.preventDefault(); if(c.vf) c.vf.ready = false; });
  let last = 0;
  const loop = now => {
    if(call !== c || !c.vf){ return; }
    c.vf.raf = requestAnimationFrame(loop);
    if(!c.video || document.hidden || now - last < 30) return;   // ~30 de cadre pe secundă, doar când se vede
    last = now; vfDraw(c, now);
  };
  c.vf.raf = requestAnimationFrame(loop);
  vfSwitch(c, cvd.querySelector('img.on'));
}
function vfStop(c){ if(!c || !c.vf) return; cancelAnimationFrame(c.vf.raf); try{ const x = c.vf.g.gl.getExtension('WEBGL_lose_context'); if(x) x.loseContext(); }catch(e){} c.vf = null; }
function callFrame(c, px = 512, force = false){   // un cadru mic din camera ta, doar pentru replica asta (nu se salvează nicăieri)
  try{
    const sv = $('.callv .cself'); if(!c.video || !(c.see || force) || !c.cam || !sv || !sv.videoWidth) return null;
    const k = px / Math.max(sv.videoWidth, sv.videoHeight), cv = document.createElement('canvas');
    cv.width = Math.round(sv.videoWidth * k); cv.height = Math.round(sv.videoHeight * k);
    const g = cv.getContext('2d'); if(c.facing === 'user'){ g.translate(cv.width, 0); g.scale(-1, 1); }
    g.drawImage(sv, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', .7).split(',')[1];
  }catch(e){ return null; }
}
async function callUserSaid(c, t){
  const rx = c.reacts.splice(0).join('');
  c.ch.msgs.push({id:uid(), role:'user', text:t[0].toUpperCase() + t.slice(1) + (rx ? ` (în timpul apelului ți-a trimis ${rx})` : ''), ts:Date.now(), call:true, video:c.video || undefined, seen:true});
  await saveChat(c.c, c.ch);
  callReply({liveImg:callFrame(c)});
}
function callTick(){   // un „tic” discret când e rândul tău (util cu căștile, fără să te uiți la ecran)
  try{ const ac = callTick.ac || (callTick.ac = new (window.AudioContext || window.webkitAudioContext)()); const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.frequency.value = 880; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.05, t + .01); g.gain.linearRampToValueAtTime(0, t + .09); o.connect(g).connect(ac.destination); o.start(t); o.stop(t + .1); }catch(e){}
}
function callListen(quiet){
  const c = call; if(!c || c.muted || c.state === 'think' || (c.state === 'speak' && !c.interrupted) || c.state === 'ring') return;
  try{ c.rec && c.rec.abort(); }catch(e){}
  const r = new SpeechRec(); r.lang = langOf(c.c); r.interimResults = true; r.continuous = false;
  let final = '', interim = '', lastT = 0;
  c.rec = r; c.state = 'listen'; c.interrupted = false; callState('te ascultă…', 'listen');
  if(!quiet && S.callTick !== 'off') callTick();
  r.onresult = e => { let t = ''; for(let i = 0; i < e.results.length; i++){ t += e.results[i][0].transcript; if(e.results[i].isFinal) final = t; } interim = t.trim(); c.interim = interim; lastT = Date.now(); c.heardAt = performance.now(); $('#clCap').innerHTML = `<span class="cme">${esc(interim)}</span>`; };
  // 8.14: nu mai așteptăm pauza lungă a telefonului: după ~0,85 s de liniște încheiem noi
  const watch = setInterval(() => { if(c.rec !== r){ clearInterval(watch); return; } if(interim && lastT && Date.now() - lastT > 850){ clearInterval(watch); try{ r.stop(); }catch(e){} } }, 150);
  r.onerror = e => { if(e.error === 'not-allowed' || e.error === 'service-not-allowed'){ toast('Permite accesul la microfon pentru Taifas.', 3500); endCall(); history.back(); } };
  r.onend = async () => {
    clearInterval(watch); c.interim = '';
    if(call !== c || c.rec !== r) return;
    c.rec = null;
    const t = (final || interim).trim();
    if(!t){ c.state = 'idle'; if(!c.muted) setTimeout(() => call === c && callListen(true), 250); return; }   // mod mâini libere: ascultă din nou, la nesfârșit
    await callUserSaid(c, t);
  };
  try{ r.start(); }catch(e){ c.state = 'idle'; setTimeout(() => call === c && callListen(true), 600); }
}
// 8.14: mâini libere: ecranul rămâne aprins cât ține apelul (și revine după ce te întorci în aplicație)
async function callWake(c, on){
  try{
    if(!on){ if(c.wake){ await c.wake.release(); c.wake = null; } return; }
    if('wakeLock' in navigator){ c.wake = await navigator.wakeLock.request('screen'); }
  }catch(e){}
}
document.addEventListener('visibilitychange', () => { if(!document.hidden && call && call.t0 && !call.wake) callWake(call, true); });

/* ───────── 📲 8.14: ea te sună ───────── */
let inCallEl = null;
function ringtone(on){
  try{
    if(!on){ clearInterval(ringtone.t); ringtone.t = 0; if(ringtone.ac){ ringtone.ac.close(); ringtone.ac = null; } try{ navigator.vibrate && navigator.vibrate(0); }catch(e){} return; }
    const ac = ringtone.ac = new (window.AudioContext || window.webkitAudioContext)(); if(ac.resume) ac.resume().catch(() => {});
    const note = (f, t0, d) => { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.09, t0 + .02); g.gain.exponentialRampToValueAtTime(.001, t0 + d); o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + d + .05); };
    const play = () => { if(!ringtone.ac) return; const t = ac.currentTime; [659, 784, 988, 784, 659, 988].forEach((f, i) => note(f, t + i * .16, .3)); try{ navigator.vibrate && navigator.vibrate([400, 200, 400]); }catch(e){} };
    play(); ringtone.t = setInterval(play, 2600);
  }catch(e){}
}
async function callNote(c, kind){   // apel nepreluat / respins: rămâne în chat, iar ea îți scrie după
  const ch = cur === c && chat ? chat : await loadChat(c, c.thread || 'main');
  ch.msgs.push({id:uid(), role:'ai', text:kind === 'miss' ? '📞 Apel nepreluat' : '📞 Ai respins apelul', ts:Date.now(), seen:true});
  if(!(chat === ch && !$('#vChat').hidden)) c.unread = (c.unread || 0) + 1;
  await saveChat(c, ch); await saveChars();
  if(!$('#vHome').hidden) renderHome(); else if(chat === ch) renderMsgs(true);
  setTimeout(async () => {
    if(busy || call) return;
    const u = S.userName.trim() || 'el';
    await reply(null, {c, ch, pro:true, note:`(Notă de regie, nu o menționa ca atare: tocmai l-ai sunat pe ${u} și ${kind === 'miss' ? 'n-a răspuns' : 'a respins apelul'}. Scrie-i acum un mesaj scurt și firesc, în felul tău${kind === 'miss' ? '' : ' (poate e ocupat)'}.)`});
    if(!$('#vHome').hidden) renderHome();
  }, 15000 + Math.random() * 25000);
}
function showIncoming(c, opts = {}){
  if(inCallEl || call || !c) return;
  c.inAt = Date.now(); saveChars();
  const video = !!opts.video;
  inCallEl = document.createElement('div'); inCallEl.className = 'incall';
  inCallEl.innerHTML = `<div class="cbg" ${c.photo ? `data-bgk="${esc(photoNow(c))}"` : ''}></div>
    <div class="inmain"><small>${video ? '📹 Apel video' : '📞 Apel'} Taifas</small><div class="inava">${avatarHTML(c)}<i></i><i></i></div><h2>${esc(c.name)}</h2><p>te sună…</p></div>
    <div class="inbtns"><button class="indecl" aria-label="Respinge">${ICO.end}<span>Respinge</span></button>
      <button class="inok" aria-label="Răspunde"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg><span>Răspunde</span></button>
      ${callPics(c, {msgs:[]}).length ? `<button class="invid" aria-label="Răspunde video">${ICO.cam}<span>Video</span></button>` : ''}</div>`;
  document.body.appendChild(inCallEl); hydrate(inCallEl);
  ringtone(true);
  const close = () => { ringtone(false); clearTimeout(t); const el = inCallEl; inCallEl = null; if(el){ el.classList.add('out'); setTimeout(() => el.remove(), 300); } };
  const t = setTimeout(() => { close(); callNote(c, 'miss'); }, 30000);
  inCallEl.querySelector('.indecl').onclick = () => { close(); callNote(c, 'decl'); };
  const answer = async vid => { close(); if(busy && live) busy.abort(); for(let k = 0; k < 40 && busy; k++) await sleep(150); if(!cur || cur.id !== c.id || $('#vChat').hidden) await openChat(c.id); startCall({video:vid, incoming:true, reason:opts.reason}); };
  inCallEl.querySelector('.inok').onclick = () => answer(video);
  const vb = inCallEl.querySelector('.invid'); if(vb) vb.onclick = () => answer(true);
}
// 8.18: a promis în chat că te sună acum: sună după câteva secunde; dacă ești ocupat sau ai ieșit din aplicație, așteaptă până la 10 minute
const sunT = {};
function callSoon(c, opts){
  if(S.callIn === 'off' || c.callIn === false) return;
  const until = Date.now() + 10 * 60e3, first = Date.now() + 6000 + Math.random() * 9000;
  clearInterval(sunT[c.id]);
  const id = sunT[c.id] = setInterval(() => {
    if(Date.now() < first) return;
    if(Date.now() > until || call){ clearInterval(id); return; }
    if(document.hidden || locked || inCallEl || busy || $('.scrim') || (typeof rec !== 'undefined' && rec)) return;
    clearInterval(id);
    showIncoming(c, opts);
  }, 1500);
}
// din când în când, cineva cu care vorbești te sună singur (cel mult de 2 ori pe zi, doar când e treaz și liber)
function maybeIncoming(){
  if(S.callIn === 'off' || document.hidden || call || inCallEl || busy || locked || !aiReady() || $('.scrim') || ($('#inp') && $('#inp').value.trim()) || (typeof rec !== 'undefined' && rec)) return;   // nu sună cât scrii sau dictezi
  const day = dayKey(Date.now()); if(S.inDay !== day){ S.inDay = day; S.inN = 0; }
  if((S.inN || 0) >= 2 || Math.random() > .025) return;
  const cand = chars.filter(c => c.callIn !== false && c.last && c.lastAt && Date.now() - c.lastAt < 7 * 864e5 && Date.now() - c.lastAt > 2 * 36e5 && Date.now() - (c.inAt || 0) > 20 * 36e5)
    .filter(c => { const lf = lifeNow(c), h = charNow(c).getHours(); return !(lf && lf.b) && h >= 10 && h < 22; });
  if(!cand.length) return;
  const c = cand[Math.floor(Math.random() * Math.min(3, cand.length))];
  S.inN = (S.inN || 0) + 1; saveSettings();
  showIncoming(c, {video:Math.random() < .35});
}
setInterval(maybeIncoming, 90e3);
function openSheet(html){
  closeSheet(true);
  const s = document.createElement('div'); s.className = 'scrim';
  s.innerHTML = `<div class="sheet">${html}</div>`;
  s.addEventListener('click', e => { if(e.target === s || e.target.closest('[data-close]')) closeSheet(); });
  document.body.appendChild(s);
}
function closeSheet(){ $$('.scrim,.viewer,.wrapv').forEach(x => x.remove()); }
function sheet(opts){
  openSheet(opts.map((o, k) => `<button class="opt ${o[3] || ''}" data-k="${k}"><i>${o[0]}</i>${esc(o[1])}</button>`).join(''));
  $$('.sheet .opt').forEach(b => b.onclick = () => { closeSheet(); opts[+b.dataset.k][2](); });
}
function confirmSheet(text, okLabel, fn){
  openSheet(`<h4>${esc(text)}</h4><div class="pad btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="shOk">${esc(okLabel)}</button></div>`);
  $('#shOk').onclick = () => { closeSheet(); fn(); };
}
async function viewImg(k, list, meta){
  if(!list && chat && !$('#vChat').hidden){ const ms = chat.msgs.filter(m => m.img && !m.err); list = ms.map(m => m.img); meta = meta || Object.fromEntries(ms.map(m => [m.img, {ts:m.ts, scene:m.scene}])); }
  if(!list) list = [k];
  meta = meta || {};
  if(!list.includes(k)) list = [k];
  let idx = list.indexOf(k);
  const v = document.createElement('div'); v.className = 'viewer';
  v.innerHTML = `<div class="vbg"></div><img class="vimg" alt="" draggable="false">
    <div class="vtop"><span class="vcount"></span><button class="ib vplay" aria-label="Prezentare" hidden>▶</button><button class="ib x" aria-label="Închide">✕</button></div><div class="vcap"></div>
    <button class="ib vnav l" aria-label="Înapoi">‹</button><button class="ib vnav r" aria-label="Înainte">›</button>
    <div class="vbar"><button class="btn" id="vwSave">⬇ Salvează</button>${canShareFiles() ? '<button class="btn" id="vwShare">↗️ Trimite</button>' : ''}<button class="btn" id="vwRe" hidden>🎲 Alta</button></div>`;
  document.body.appendChild(v);
  const img = v.querySelector('.vimg'), bg = v.querySelector('.vbg');
  let sc = 1, tx = 0, ty = 0;
  const apply = (anim) => { img.style.transition = anim ? 'transform .25s ease' : 'none'; img.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`; };
  const fit = () => { const r = img.getBoundingClientRect(); return r; };
  async function load(i, dir){
    idx = (i + list.length) % list.length;
    const u = await imgUrl(list[idx]); if(!u) return;
    img.style.transition = 'none'; img.style.opacity = '0';
    img.src = u; bg.style.backgroundImage = `url("${u}")`;
    sc = 1; tx = dir ? dir * 60 : 0; ty = 0; apply();
    await img.decode?.().catch(() => {});
    // centrăm: originea transformării e colțul stânga-sus al imaginii afișate
    requestAnimationFrame(() => { img.style.transition = 'transform .25s ease, opacity .2s'; img.style.opacity = '1'; tx = 0; apply(true); });
    v.querySelector('.vcount').textContent = list.length > 1 ? `${idx + 1} / ${list.length}` : '';
    const mt = meta[list[idx]];
    // 7.4: doar data și ora; scena (textul pentru generator) rămâne în apăsare lungă → „Ce scenă a ales”
    v.querySelector('.vcap').innerHTML = mt && mt.ts ? `<b>${esc(new Date(mt.ts).toLocaleDateString('ro-RO', {weekday:'long', day:'numeric', month:'long'}))} · ${esc(hhmm(mt.ts))}</b>` : '';
    v.querySelector('.vplay').hidden = list.length < 2;
    v.querySelector('#vwRe').hidden = !(S.imgProv !== 'none' && !busy && aiPicIdx() >= 0);
    v.querySelectorAll('.vnav').forEach(b => b.hidden = list.length < 2);
  }
  let show = null;
  const stopShow = () => { if(show){ clearInterval(show); show = null; v.querySelector('.vplay').textContent = '▶'; } };
  v.querySelector('.vplay').onclick = () => { if(show){ stopShow(); return; } v.querySelector('.vplay').textContent = '❚❚'; show = setInterval(() => { if(!document.body.contains(v)){ stopShow(); return; } load(idx + 1, 1); }, 3500); };
  const close = () => { stopShow(); v.remove(); };
  v.querySelector('.x').onclick = close;
  v.querySelector('.vnav.l').onclick = () => load(idx - 1, -1);
  v.querySelector('.vnav.r').onclick = () => load(idx + 1, 1);
  v.querySelector('#vwSave').onclick = () => saveImage(list[idx]);
  // 🎲 doar pentru pozele trimise de personaj în conversația deschisă
  const aiPicIdx = () => (chat && !$('#vChat').hidden) ? chat.msgs.findIndex(m => m.role === 'ai' && m.img === list[idx]) : -1;
  const reBtn = v.querySelector('#vwRe'); reBtn.onclick = () => { const i = aiPicIdx(); if(i < 0) return; close(); rephotoMenu(i); };
  const sh = v.querySelector('#vwShare'); if(sh) sh.onclick = () => shareImage(list[idx]);
  // gesturi: ciupit = zoom, tras = mutare (cu zoom) / glisare între poze (fără zoom), tras în jos = închide, dublu-tap = zoom 2,5×
  const pts = new Map(); let start = null, lastTap = 0;
  // poziția de bază (fără transformare) a imaginii; valabilă cât timp tx/ty sunt cele aplicate în DOM
  const base = () => { const r = img.getBoundingClientRect(); return {l:r.left - tx, t:r.top - ty}; };
  const zoomFrom = (st, b, ns, cx, cy) => {
    ns = Math.max(1, Math.min(5, ns));
    const ox = (cx - (b.l + st.tx)) / st.sc, oy = (cy - (b.t + st.ty)) / st.sc;     // punctul de sub degete, în coordonatele imaginii
    sc = ns; tx = cx - b.l - ox * ns; ty = cy - b.t - oy * ns;
    if(sc === 1){ tx = 0; ty = 0; }
  };
  img.addEventListener('pointerdown', e => {
    img.setPointerCapture(e.pointerId); pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(pts.size === 1){
      const now = Date.now();
      if(now - lastTap < 280){ zoomFrom({sc, tx, ty}, base(), sc > 1 ? 1 : 2.5, e.clientX, e.clientY); apply(true); lastTap = 0; start = null; return; }
      lastTap = now;
      start = {x:e.clientX, y:e.clientY, tx, ty, sc};
    } else if(pts.size === 2){
      const [a, b] = [...pts.values()];
      start = {pinch:true, d:Math.hypot(a.x - b.x, a.y - b.y), sc, cx:(a.x + b.x) / 2, cy:(a.y + b.y) / 2, tx, ty, b:base()};
    }
  });
  img.addEventListener('pointermove', e => {
    if(!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(start.pinch && pts.size >= 2){
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomFrom(start, start.b, start.sc * d / start.d, start.cx, start.cy); apply();
    } else if(!start.pinch){
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if(sc > 1){ tx = start.tx + dx; ty = start.ty + dy; }
      else if(Math.abs(dx) > Math.abs(dy)){ tx = dx; ty = 0; }
      else { ty = Math.max(0, dy); tx = 0; v.style.background = `rgba(0,0,0,${Math.max(.3, 1 - ty / 400)})`; }
      apply();
    }
  });
  const end = e => {
    pts.delete(e.pointerId);
    if(!start) return;
    if(start.pinch){ if(pts.size < 2){ start = null; if(sc <= 1.02){ sc = 1; tx = 0; ty = 0; apply(true); } } return; }
    const dx = e.clientX - start.x, dy = e.clientY - start.y; start = null;
    v.style.background = '';
    if(sc > 1) return;
    if(Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) && list.length > 1){ load(idx + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1); return; }
    if(dy > 120){ close(); return; }
    tx = 0; ty = 0; apply(true);
  };
  img.addEventListener('pointerup', end); img.addEventListener('pointercancel', end);
  load(idx);
}

/* ───────── EDITOR ───────── */
let ed = null; // {id|null, photoBlob|null, photoKey}
function openEditor(id){
  const c = id ? charById(id) : null;
  ed = {id:c ? c.id : null, photoBlob:null, photoKey:c ? c.photo : null, fromChat:!$('#vChat').hidden || !$('#vProf').hidden};
  $('#edTitle').textContent = c ? c.name : 'Personaj nou';
  $('#edName').value = c?.name || ''; $('#edTag').value = c?.tag || '';
  $('#edAspect').value = c?.aspect || ''; $('#edPersona').value = c?.persona || '';
  $('#edSpeech').value = c?.speech || ''; $('#edGreet').value = c?.greet || '';
  $('#edLook').value = c?.look || ''; $('#edStil').value = c?.stil || 'photo';
  ed.accent = c?.accent || ''; ed.bg = c?.bg || 'clar'; drawLook();
  $('#edDelWrap').hidden = !c;
  $('#edNames').innerHTML = '';
  edGo(1);
  setEdStatus('');
  renderEdPhoto();
  show('vEdit');
  $('#vEdit .scroll').scrollTop = 0;
}
let edStep = 1;
function edGo(n){
  edStep = Math.max(1, Math.min(3, n));
  $$('#vEdit .step').forEach(x => x.hidden = +x.dataset.step !== edStep);
  $$('#edSteps [data-s]').forEach(b => { const k = +b.dataset.s; b.classList.toggle('on', k === edStep); b.classList.toggle('done', k < edStep); });
  $('#edBack').style.visibility = edStep > 1 ? 'visible' : 'hidden';
  $('#edNext').textContent = edStep < 3 ? 'Continuă ›' : (ed && ed.id ? 'Salvează' : 'Creează personajul');
  $('#edSave').hidden = !(ed && ed.id);
  $('#edScroll').scrollTop = 0;
  if(edStep === 3) drawEdPreview();
}
async function drawEdPreview(){
  const box = $('#edPrev'); if(!box || !ed) return;
  const g = $('#edGreet').value.trim();
  if(!g){ box.innerHTML = '<div class="lbl">Previzualizare</div><div style="color:var(--tx3);font-size:.85rem;padding:0 4px">Scrie prima replică și o vezi aici, cum apare în conversație.</div>'; return; }
  let av = `<span class="av" style="background:${colorFor({id:ed.id || 'x'})}">${esc(($('#edName').value.trim() || '?')[0])}</span>`;
  const u = ed.photoBlob ? URL.createObjectURL(ed.photoBlob) : (ed.photoKey ? await imgUrl(ed.photoKey) : '');
  if(u) av = `<img class="av" src="${u}" alt="">`;
  box.innerHTML = `<div class="lbl">Previzualizare · ${esc($('#edName').value.trim() || 'Personaj')}</div><div class="m ai">${av}<div class="bub">${fmtMsg(g)}<span class="tm">${hhmm(Date.now())}</span></div></div>`;
}
function drawLook(){
  $('#edAcc').innerHTML = `<button type="button" data-a="" style="background:var(--grad)" class="${ed.accent ? '' : 'on'}" aria-label="Implicit"></button>` +
    ACCENTS.map(a => `<button type="button" data-a="${a}" style="background:${a}" class="${ed.accent === a ? 'on' : ''}"></button>`).join('');
  $$('#edBg button').forEach(b => b.classList.toggle('on', b.dataset.v === ed.bg));
}
async function renderEdPhoto(){
  const p = $('#edPhoto');
  let u = '';
  if(ed.photoBlob) u = URL.createObjectURL(ed.photoBlob);
  else if(ed.photoKey) u = await imgUrl(ed.photoKey);
  p.classList.toggle('has', !!u);
  p.innerHTML = u ? `<img src="${u}" alt=""><span class="chg">Schimbă poza</span>` : `<span><b>＋</b>Urcă o poză<br>sau generează una mai jos</span>`;
  $('#edRedesc').hidden = $('#edCheck').hidden = !u;
  $('#edNoPhotoHint').hidden = !!u;
  $('#edSurprise').hidden = !!u || !!(ed && ed.id);
  $('#edGenWrap').hidden = S.imgProv === 'none';
  $('#edGen').textContent = u ? '🎨 Generează alt portret din descriere' : '🎨 Generează portretul din descriere';
}
function setEdStatus(t, cls = ''){ const s = $('#edStatus'); s.className = 'status ' + cls; s.innerHTML = t; }
async function edPhotoBlob(){ return ed.photoBlob || (ed.photoKey ? await DB.get(ed.photoKey) : null); }
async function onPhotoPicked(file){
  if(!file) return;
  try{ ed.photoBlob = await toJpeg(file); ed.aiPortrait = false; }catch(e){ setEdStatus('Nu pot citi poza.', 'err'); return; }
  renderEdPhoto();
  runDescribe();
}
async function runDescribe(){
  const b = await edPhotoBlob(); if(!b) return;
  if(!aiReady()){ setEdStatus('Poza e pusă. Pentru descrierea automată, adaugă cheia în Setări.', 'err'); return; }
  setEdStatus('<span class="spin"></span> Analizez poza…');
  $('#edRedesc').disabled = true;
  try{
    const E = ed;
    const d = await describePhoto(b);
    if(ed !== E || $('#vEdit').hidden) return;
    $('#edAspect').value = d.aspect; $('#edLook').value = d.look; $('#edStil').value = d.stil;
    if(d.names.length){
      if(!$('#edName').value.trim()){ $('#edName').value = d.names[0]; $('#edTitle').textContent = d.names[0]; }
      drawNames(d.names);
    }
    setEdStatus('✓ Descriere făcută din poză' + (d.names.length ? ', cu nume propuse' : '') + '. Poți corecta orice.', 'ok');
  }catch(e){ setEdStatus('Descrierea a eșuat: ' + esc(e.message), 'err'); }
  $('#edRedesc').disabled = false;
}
function drawNames(list){
  const box = $('#edNames'), cur0 = $('#edName').value.trim();
  box.innerHTML = list.map(n => `<button type="button" class="${n === cur0 ? 'on' : ''}">${esc(n)}</button>`).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = () => {
    $('#edName').value = b.textContent; $('#edTitle').textContent = b.textContent;
    box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); drawEdPreview();
  });
}
async function runNames(){
  if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; }
  const btn = $('#edNameGen'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try{
    const ctx = [$('#edAspect').value.trim() && 'Aspect: ' + $('#edAspect').value.trim(), $('#edTag').value.trim() && 'Pe scurt: ' + $('#edTag').value.trim(),
      $('#edPersona').value.trim() && 'Personalitate: ' + $('#edPersona').value.trim().slice(0, 600)].filter(Boolean).join('\n') || '(nimic încă: propune nume variate, frumoase)';
    const out = await stream('Propui nume de personaje. Răspunzi doar cu JSON.', [{role:'user', text:
      `Propune 6 prenume pentru un personaj dintr-o aplicație de conversație, potrivite cu ce știm despre el:\n${ctx}\n\nVariază: românești, internaționale, unul mai neobișnuit. Fără nume de persoane celebre. Răspunde STRICT cu un array JSON de 6 texte.`}], {max:200, aux:true});
    const a = out.indexOf('['), b = out.lastIndexOf(']');
    const list = JSON.parse(out.slice(a, b + 1)).map(x => String(x).trim()).filter(x => x && x.length < 30).slice(0, 6);
    if(list.length){ drawNames(list); if(!$('#edName').value.trim()){ $('#edName').value = list[0]; drawNames(list); } }
  }catch(e){ toast('Numele n-au mers: ' + e.message, 3500); }
  btn.disabled = false; btn.textContent = '🎲 Alte nume';
}
const VIBES = [['romantic', '💞 Romantic'], ['aventura', '🧭 Aventură'], ['mister', '🕯️ Mister'], ['amuzant', '😄 Amuzant'], ['fantasy', '🐉 Fantasy'], ['sf', '🚀 SF'], ['cotidian', '☕ Din viața de zi cu zi'], ['oricare', '🎲 Orice']];
function surpriseSheet(){
  if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; }
  let gen = 'oricare', vibe = 'oricare', stil = 'photo';
  openSheet(`<h4>🎲 Personaj surpriză</h4>
    <h5>Gen</h5><div class="chipset" id="spGen"><button data-v="femeie">Femeie</button><button data-v="bărbat">Bărbat</button><button data-v="oricare" class="on">Oricare</button></div>
    <h5>Atmosferă</h5><div class="chipset" id="spVibe">${VIBES.map(([v, l]) => `<button data-v="${v}" class="${v === 'oricare' ? 'on' : ''}">${l}</button>`).join('')}</div>
    <h5>Stil portret</h5><div class="chipset" id="spStil"><button data-v="photo" class="on">Foto realist</button><button data-v="anime">Anime</button><button data-v="illustration">Ilustrație</button><button data-v="3d">3D</button></div>
    <div class="pad btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="spGo">✨ Inventează</button></div>`);
  const pick = (id, set) => $(id).addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(!b) return; $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); set(b.dataset.v); });
  pick('#spGen', v => gen = v); pick('#spVibe', v => vibe = v); pick('#spStil', v => stil = v);
  $('#spGo').onclick = () => { closeSheet(); runSurprise(gen, vibe, stil); };
}
async function runSurprise(gen, vibe, stil){
  const vibeTxt = (VIBES.find(x => x[0] === vibe) || ['', ''])[1].replace(/^\S+\s/, '');
  setEdStatus('<span class="spin"></span> Inventez personajul…');
  $('#edSurprise').disabled = true;
  try{
    const out = await stream('Ești un scriitor de personaje memorabile. Scrii în română corectă, cu diacritice, fără liniuțe de dialog.', [{role:'user', text:
`Inventează un personaj original pentru o aplicație de conversație.
Gen: ${gen === 'oricare' ? 'alege tu' : gen}. Atmosferă: ${vibe === 'oricare' ? 'alege tu ceva surprinzător' : vibeTxt}.
Personajul e adult (peste 25 de ani), cu o meserie sau o ocupație concretă, un trecut, obiceiuri și o ciudățenie simpatică. Fără persoane reale sau celebre.
Răspunde STRICT cu JSON:
{"name":"prenume","nume":["încă 3 prenume alternative"],"tag":"o frază scurtă și atrăgătoare pentru card, max 90 de caractere","persona":"personalitate, trecut, ce-i place, cum se poartă, relația cu interlocutorul; 5-8 propoziții, la persoana a II-a (Ești…)","aspect":"înfățișarea, 4-6 propoziții: vârstă, față, ochi, păr, constituție, stil vestimentar","look":"same appearance in English as comma-separated tags for an image generator, max 60 words, face and hair first","speech":"stilul de vorbire în câteva cuvinte","greet":"prima replică, 1-3 propoziții, cu o acțiune între *asteriscuri*, care deschide o situație interesantă"}`}], {max:1500});
    const j = parseJSON(out);
    const t = k => faraLiniute(String(j[k] || '').trim());
    $('#edName').value = t('name'); $('#edTitle').textContent = t('name') || 'Personaj nou';
    $('#edTag').value = t('tag'); $('#edPersona').value = t('persona'); $('#edAspect').value = t('aspect');
    $('#edSpeech').value = t('speech'); $('#edGreet').value = t('greet');
    $('#edLook').value = String(j.look || '').trim(); $('#edStil').value = stil;
    drawNames([t('name'), ...(Array.isArray(j.nume) ? j.nume : []).map(x => String(x).trim())].filter(Boolean).slice(0, 4));
    if(S.imgProv !== 'none'){ await runPortrait(); }
    else setEdStatus('✓ Personaj inventat. Pornește pozele din Setări ca să-i generezi și portretul.', 'ok');
    if(navigator.vibrate) try{ navigator.vibrate(15); }catch(_){}
  }catch(e){ setEdStatus('N-a mers: ' + esc(e.message), 'err'); }
  $('#edSurprise').disabled = false;
}
async function runVerify(){
  const b = await edPhotoBlob(); if(!b){ toast('Urcă întâi o poză.'); return; }
  if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; }
  const aspect = $('#edAspect').value.trim();
  if(!aspect){ runDescribe(); return; }
  const btn = $('#edCheck'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  setEdStatus('<span class="spin"></span> Compar descrierea cu poza…');
  try{
    const E = ed;
    const r = await verifyPhoto(b, aspect, $('#edLook').value.trim());
    if(ed !== E || $('#vEdit').hidden){ btn.disabled = false; btn.textContent = '🔍 Verifică'; return; }
    if(!r.fixes.length){ setEdStatus('✓ Descrierea se potrivește cu poza.', 'ok'); }
    else {
      setEdStatus(r.fixes.length + (r.fixes.length === 1 ? ' corectură propusă.' : ' corecturi propuse.'));
      openSheet(`<h4>🔍 Ce nu se potrivea cu poza</h4><ul class="fixes">${r.fixes.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
        <p style="margin-top:12px">Descrierea corectată:</p><p style="color:var(--tx)">${esc(r.aspect)}</p>
        <div class="pad btns"><button class="btn" data-close>Păstrez ce am</button><button class="btn pri" id="shOk">Aplică corecturile</button></div>`);
      $('#shOk').onclick = () => { $('#edAspect').value = r.aspect; $('#edLook').value = r.look; closeSheet(); setEdStatus('✓ Corecturi aplicate. Apasă Salvează.', 'ok'); };
    }
  }catch(e){ setEdStatus('Verificarea a eșuat: ' + esc(e.message), 'err'); }
  btn.disabled = false; btn.textContent = '🔍 Verifică';
}
async function runPortrait(){
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări.'); return; }
  let look = $('#edLook').value.trim();
  const aspect = $('#edAspect').value.trim();
  if(!look && !aspect){ toast('Scrie întâi ideea și apasă ✨ Completează, ca să aibă un aspect.'); return; }
  const btn = $('#edGen'); btn.disabled = true;
  setEdStatus('<span class="spin"></span> Generez portretul…');
  try{
    if(!look){
      look = (await stream('You translate character descriptions into short English image prompts.', [{role:'user', text:'Turn this appearance description into comma-separated English tags for an image generator, max 60 words, face and hair first. Only the tags.\n\n' + aspect}], {max:200})).trim();
      $('#edLook').value = look;
    }
    const stil = $('#edStil').value || 'photo';
    const prompt = `head and shoulders portrait of an adult, ${look}, looking at the camera, friendly expression, simple softly blurred background. ${STIL_TAG[stil]}`;
    const E = ed;
    let pb = await genImage(prompt, null, null, null, {why:'profil'});
    try{ if(pb.type === 'image/png') pb = await toJpeg(pb, 2048, .92); }catch(e){}
    if(ed !== E || $('#vEdit').hidden){ btn.disabled = false; return; }    // ai ieșit din editor între timp
    ed.photoBlob = pb;
    ed.aiPortrait = true;
    addUsage(ed.id, imgPrice(), 'img', null, 'profil');
    await renderEdPhoto();
    setEdStatus('✓ Portret generat. Dacă nu-ți place, mai apasă o dată.', 'ok');
  }catch(e){ setEdStatus('Portretul n-a mers: ' + esc(e.message), 'err'); }
  btn.disabled = false;
}
async function runDraft(){
  if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; }
  const btn = $('#edDraft'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try{
    const j = await draftCharacter({name:$('#edName').value.trim(), tag:$('#edTag').value.trim(), aspect:$('#edAspect').value.trim(), persona:$('#edPersona').value.trim()});
    if(!$('#edName').value.trim() && j.name) $('#edName').value = j.name;
    if(!$('#edTag').value.trim() && j.tag) $('#edTag').value = j.tag;
    if(j.persona) $('#edPersona').value = j.persona;
    if(!$('#edSpeech').value.trim() && j.speech) $('#edSpeech').value = j.speech;
    if(!$('#edGreet').value.trim() && j.greet) $('#edGreet').value = j.greet;
    if(!$('#edAspect').value.trim() && j.aspect && j.aspect !== 'lasă gol') $('#edAspect').value = j.aspect;
    toast('Gata. Ajustează ce vrei.');
  }catch(e){ toast('Nu a mers: ' + e.message, 4000); }
  btn.disabled = false; btn.textContent = '✨ Completează';
}
let edSaving = false;
async function saveEditor(){
  if(edSaving || !ed) return;
  edSaving = true;
  try{ await saveEditorNow(); } finally { edSaving = false; }
}
async function saveEditorNow(){
  const name = $('#edName').value.trim();
  if(!name){ toast('Pune un nume.'); $('#edName').focus(); return; }
  let c = ed.id ? charById(ed.id) : null;
  const isNew = !c;
  if(isNew){ c = {id:uid(), created:Date.now()}; chars.push(c); }
  if(ed.photoBlob){ const old = c.photo; c.photo = await saveImg(ed.photoBlob); if(old) await delPhotoIfUnused(c, old); c.aiPortrait = !!ed.aiPortrait; }
  const oldGreet = c.greet;
  Object.assign(c, {name, tag:$('#edTag').value.trim(), aspect:$('#edAspect').value.trim(), persona:$('#edPersona').value.trim(),
    speech:$('#edSpeech').value.trim(), greet:$('#edGreet').value.trim(), look:$('#edLook').value.trim(), stil:$('#edStil').value,
    accent:ed.accent || '', bg:ed.bg || 'clar'});
  await saveChars();
  // dacă salutul s-a schimbat și conversația are doar salutul, îl înlocuim
  if(!isNew && oldGreet !== c.greet){
    const key = chatKey(c.id, c.thread), ch = await DB.get(key);
    if(ch && ch.msgs.length <= 1){ ch.msgs = c.greet ? [greetMsg(c)] : []; await DB.set(key, ch); }
  }
  const fromChat = ed.fromChat; ed = null;
  if(fromChat){ history.back(); return; }      // popstate redeschide conversația, actualizată
  history.replaceState({v:'vChat'}, '');
  openChat(c.id, false);
}
async function deleteChar(cc){
  const c = cc || (ed && charById(ed.id)); if(!c) return;
  confirmSheet(`Ștergi ${c.name} și toată conversația?`, 'Șterge', async () => {
    if(busy && live && live.c === c){ live.ch.dead = true; busy.abort(); }
    for(const t of threadsOf(c)){
      const ch = await DB.get(chatKey(c.id, t.id));
      if(ch) for(const m of ch.msgs) await purgeMsg(m, null);
      await DB.del(chatKey(c.id, t.id));
    }
    await delImg(c.photo);
    for(const k of Object.values(c.avs || {})) await delImg(k).catch(() => {});
    for(const x of c.stickers || []) await delImg(x.k).catch(() => {});
    for(const k of c.refs || []) await delImg(k).catch(() => {});
    for(const p of feedCache.filter(p => p.cid === c.id)) if(p.img) await delImg(p.img).catch(() => {});
    feedCache = feedCache.filter(p => p.cid !== c.id); await saveFeed();
    chars = chars.filter(x => x !== c); await saveChars();
    ed = null; profId = null; closeSheet(); goHome(); toast('🗑️ ' + c.name + ' a fost șters.');   // Înapoi ulterior nu mai poate redeschide un personaj șters (popstate verifică charById)
  });
}

/* ───────── SETĂRI ───────── */
const aiReady = () => S.prov === 'anthropic' ? hasKey('anthropic') : !!(S.oaBase && S.oaModel);
const FIELDS = {stKey:'key', stModel:'model', stOaBase:'oaBase', stOaKey:'oaKey', stOaModel:'oaModel', stUser:'userName', stAbout:'userAbout', stBday:'userBday',
  stGemKey:'gemKey', stGemModel:'gemModel', stWkBase:'wkBase', stWkTok:'wkTok', stWkModel:'wkModel', stWkSize:'wkSize',
  stFalKey:'falKey', stFalModel:'falModel', stFalSize:'falSize', stImgCost:'imgCost', stPin:'pIn', stPout:'pOut', stElKey:'elKey', stTtsFalKey:'falKey', stChatFalKey:'falKey', stVkBase:'wkBase', stVkTok:'wkTok'};
const SEGS = {stRegen:'regen3', stFx:'fx', stFeed:'feed', stStory:'story', stSky:'sky', stSocial:'social', stCfCap:'cfCap', stCfPlan:'cfPlan', stTts:'tts', stElModel:'elModel', stAux:'aux', stCtx:'ctxN', stVmsg:'vmsg', stJrn:'jrn', stTheme:'theme', stProv:'prov', stLen:'len', stFont:'font', stImg:'imgProv', stImgAlt:'imgProv', stSugg:'sugg', stPro:'pro', stVoice:'voice', stSpont:'spont', stImgCheck:'imgCheck', stWkChat:'wkChat', stBkEvery:'bkEvery', stVault:'vault', stCallFace:'callFace'};
let setPanel = null, setPanelPushed = false;
/* 8.7: actualizare din aplicație. Codul vine oricum din rețea la pornire;
   asta prinde versiunile apărute cât aplicația a stat deschisă și forțează reîncărcarea curată. */
let updLast = 0, updBusy = false;
async function latestVer(){
  const r = await fetch('app.js?u=' + Date.now(), {cache: 'no-store'});   // 8.20: codul stă în app.js
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const m = (await r.text()).match(/const APP_VER = '([^']+)'/);
  return m ? m[1] : null;
}
async function applyUpdate(){
  if(updBusy) return; updBusy = true;
  toast('Se actualizează…', 4000);
  try{
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if(reg) await reg.update().catch(() => {});
    if(window.caches) for(const k of await caches.keys()) if(k !== 'taifas-cfg') await caches.delete(k);
  }catch(e){}
  location.replace(location.pathname + '?upd=' + Date.now());
}
async function checkUpdate(manual){
  if(!manual && (Date.now() - updLast < 30 * 60e3 || !navigator.onLine)) return;
  updLast = Date.now();
  const b = manual && $('#stUpd');
  if(b){ b.disabled = true; b.innerHTML = '<span class="spin"></span> Verific…'; }
  try{
    const v = await latestVer();
    if(v && v !== APP_VER){
      if(manual) return applyUpdate();
      let bar = $('#updBar');
      if(!bar){ bar = document.createElement('div'); bar.id = 'updBar'; document.body.appendChild(bar); }
      bar.innerHTML = `<span>✨ Taifas ${esc(v)} e gata</span><button>Actualizează</button>`;
      bar.querySelector('button').onclick = applyUpdate;
      requestAnimationFrame(() => bar.classList.add('on'));
    } else if(manual) toast('Ai ultima versiune (' + APP_VER + ') ✓');
  }catch(e){ if(manual) toast('Nu pot verifica acum — ești online?'); }
  finally{ if(b){ b.disabled = false; b.textContent = '⟳ Caută actualizare'; } }
}

function openSettings(){
  for(const [id, k] of Object.entries(FIELDS)) $('#' + id).value = S[k] ?? '';
  syncSegs();
  $('#stWelcome').hidden = aiReady();
  $('#stTestRes').textContent = '';
  $('#stVer').textContent = 'Taifas ' + APP_VER;
  renderCost();
  loadNeurons();
  closeSetPanel(true);
  show('vSet');
  if(!aiReady()) openSetPanel('ai', false);
}
function openSetPanel(p, push = true){
  setPanel = p; setPanelPushed = push;
  $('#setList').hidden = true;
  $$('#vSet .panel').forEach(x => x.hidden = x.dataset.panel !== p);
  const el = $(`#vSet .panel[data-panel="${p}"]`);
  $('#stTitle').textContent = el ? el.dataset.title : 'Setări';
  $('#stScroll').scrollTop = 0;
  if(p === 'img'){ loadNeurons(); drawChatHint(); }
  if(p === 'me') drawMe();
  if(p === 'data') drawBk();
  if(p === 'lock') drawLock();
  if(p === 'push') drawPush();
  if(p === 'cost') renderCost();
  if(push) history.pushState({v:'vSet', p}, '');
}
function closeSetPanel(silent){
  setPanel = null;
  $$('#vSet .panel').forEach(x => x.hidden = true);
  $('#setList').hidden = false;
  $('#stTitle').textContent = 'Setări';
  if(!silent) renderSetSummary();
  else renderSetSummary();
}
function renderSetSummary(){
  const nm = S.userName.trim();
  $('#stMeAv').textContent = (nm || '?')[0].toUpperCase();
  $('#stMeName').textContent = nm || 'Tu';
  $('#stMeSub').innerHTML = aiReady() ? `<span style="color:var(--ok)">● conectat</span> · ${chars.length} ${chars.length === 1 ? 'personaj' : 'personaje'}` : '<span style="color:var(--err)">● lipsește cheia</span>';
  $('#sum_ai').innerHTML = S.prov === 'anthropic'
    ? (hasKey('anthropic') ? `<span class="ok">✓</span> Claude · ${esc(S.model || DEF.model)}${vaultOn() ? ' · 🔐 seif' : ''}` : '<span class="bad">lipsește cheia</span>')
    : (aiReady() ? `<span class="ok">✓</span> ${esc(S.oaModel)}` : '<span class="bad">necompletat</span>');
  $('#sum_me').textContent = nm ? nm + (S.userAbout.trim() ? ' · ' + S.userAbout.trim() : '') : 'Cum să-ți spună personajele';
  const ip = {none:'Oprite', worker:'Worker Cloudflare · ' + (S.wkModel || 'eco') + (S.cfPlan === 'paid' ? ' · Paid' : ''), fal:'fal.ai', gemini:'Gemini'}[S.imgProv] || '';
  $('#sum_img').textContent = ip;
  $('#sum_chat').textContent = {scurt:'Răspunsuri scurte', mediu:'Răspunsuri medii', lung:'Răspunsuri lungi'}[S.len] + ' · voce ' + {off:'oprită', tap:'la 🔊', auto:'automată'}[S.voice] + ' · ' + ({tel:'telefon', el:'ElevenLabs', fal:'fal.ai'}[S.tts] || 'telefon');
  $('#sum_lock').textContent = S.lock === 'bio' ? 'Amprentă + PIN' : S.lock === 'pin' ? 'PIN' : 'Oprită';
  $('#sum_push').textContent = S.pushOn ? 'Pornite' : 'Oprite';
  $('#sum_look').textContent = {auto:'Temă automată', dark:'Temă întunecată', light:'Temă luminoasă'}[S.theme] + ' · text ' + {15:'mic', 16:'normal', 18:'mare'}[S.font];
}
function syncSegs(){
  for(const [id, k] of Object.entries(SEGS)) $$('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S[k])));
  $('#stAnt').hidden = S.prov !== 'anthropic' || S.vault === 'on'; $('#stAntAdv').hidden = S.prov !== 'anthropic';
  $('#stVaultBox').hidden = S.vault !== 'on';
  $('#stVkWipeWrap').hidden = !(S.vault === 'on' && S.vaultHas && ['key', 'falKey', 'elKey', 'gemKey'].some(k => String(S[k] || '').trim()));
  if(!$('#vSet').hidden) renderSetSummary(); $('#stOa').hidden = S.prov === 'anthropic';
  const alt = S.imgProv === 'fal' || S.imgProv === 'gemini';
  $$('#stImg button').forEach(b => b.classList.toggle('on', b.dataset.v === (alt ? 'alt' : S.imgProv)));
  $$('#stImgAlt button').forEach(b => b.classList.toggle('on', b.dataset.v === S.imgProv));
  $('#stAltWrap').hidden = !alt;
  $('#stImgTestWrap').hidden = S.imgProv === 'none';
  $('#stChatWrap').hidden = S.imgProv !== 'worker'; $('#stChatFal').hidden = S.wkChat !== 'fal'; drawChatHint(); drawFixHint(); drawBodyHint(); drawBestHint();
  drawWkEst();
  $('#stCapWrap').hidden = S.cfPlan !== 'paid';
  $('#stCapHint').textContent = {free:'Factura rămâne $5/lună, fără nimic în plus. ' + (S.wkChat === 'ancorat' ? 'Pozele merg pe 9B cât încap în cei 10.000 de neuroni gratuiți (~6 pe zi), apoi trec singure pe Eco (cu retușul feței, ~115 neuroni) și abia când nu mai încape nici Eco se opresc' : 'Când se termină neuronii gratuiți de azi, pozele se opresc') + ' până la ' + resetAt() + '.',
    '0.1':'Cel mult ~$0,10 pe zi peste cei $5 (≈ $3/lună în cel mai rău caz). Apoi pozele se opresc până la ' + resetAt() + '.',
    none:'Fără oprire: fiecare poză peste cotă se adaugă la factură.'}[S.cfCap] || '';
  $('#ttsEl').hidden = S.tts !== 'el'; $('#ttsFal').hidden = S.tts !== 'fal';
  $('#ttsHint').textContent = {tel:'Vocea sintetică a telefonului. Gratuită, dar sună robotic. Pentru voce umană alege ElevenLabs.',
    el:'Voce umană, cu râs, oftat și șoaptă. Planul gratuit ElevenLabs are ~10 minute de audio pe lună. Vocea fiecărui personaj se alege din profilul lui.',
    fal:'Același model ElevenLabs v3, plătit din contul fal.ai (~$0,10 la 1000 de caractere, cam 2-3 bani pe mesaj vocal). Vocea se alege din profilul personajului.'}[S.tts] || '';
  $('#stGem').hidden = S.imgProv !== 'gemini'; $('#stWk').hidden = S.imgProv !== 'worker'; $('#stFal').hidden = S.imgProv !== 'fal';
  document.documentElement.style.fontSize = (+S.font || 16) + 'px';
  applyTheme();
}
const mqLight = matchMedia('(prefers-color-scheme: light)');
function applyTheme(){
  const t = S.theme === 'light' || (S.theme !== 'dark' && mqLight.matches) ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const m = document.querySelector('meta[name=theme-color]'); if(m) m.content = t === 'light' ? '#f7f4fa' : '#0e0c12';
}
mqLight.addEventListener?.('change', () => applyTheme());
async function testAI(){
  const r = $('#stTestRes'); r.className = 'status'; r.innerHTML = '<span class="spin"></span> Testez…';
  try{
    const t = await stream('Răspunzi foarte scurt.', [{role:'user', text:'Spune doar: Merge!'}], {max:20});
    r.className = 'status ok'; r.textContent = '✓ Conectat. Răspuns: ' + t.trim().slice(0, 60);
    $('#stWelcome').hidden = true;
  }catch(e){ r.className = 'status err'; r.textContent = '✗ ' + e.message; }
}
// estimare neuroni / poză după prețurile Cloudflare (oct. 2026):
// klein 4B: 26,05 / bucată 512×512 de ieșire + 5,37 / bucată a pozei de referință (o trimitem la max 512 px = 1 bucată)
// klein 9B: 1.363,64 pentru primul megapixel (minim) + 181,82 / MP în plus + 181,82 / MP referință
const tiles = (w, h) => Math.ceil(w / 512) * Math.ceil(h / 512);
function neurPerPhoto(model = S.wkModel, size = S.wkSize){
  // Worker-ul folosește automat klein 4B (eco) când primește poză de referință și modelul ales nu o acceptă
  if(!['eco', 'ancorat', 'ancorat+'].includes(model)) model = 'eco';
  // 6.8: referințe = poza de profil la 768 px (~4 bucăți) + fața 512 px (1 bucată)
  const [w, h] = String(size || '768x1024').split('x').map(Number), mp = w * h / 1048576, refMp = 2 * 512 * 512 / 1048576;   // 8.3: 2 repere de 512×512
  if(model === 'eco') return tiles(w, h) * 26.05 + 2 * 5.37;
  if(model === 'ancorat') return 1363.64 + Math.max(0, mp - 1) * 181.82 + refMp * 181.82;
  return null;                                  // FLUX.2 dev: depinde de pași, mult mai scump
}
function drawWkEst(){
  const n = neurPerPhoto(), el = $('#stWkEst'); if(!el) return;
  const paid = S.cfPlan === 'paid';
  el.textContent = n ? `≈ ${Math.round(n).toLocaleString('ro-RO')} neuroni pe poză → cam ${Math.floor(10000 / n)} poze pe zi în cota gratuită` + (paid ? `, apoi ~${usd(n * NEUR_USD)} pe poză.` : '.')
    : 'FLUX.2 dev consumă de zeci de ori mai mult; cota gratuită ajunge doar pentru câteva poze' + (paid ? ', apoi se plătește per poză.' : '.');
}
// Workers Paid: peste 10.000 de neuroni/zi, $0,011 la 1.000 de neuroni
const NEUR_USD = .011 / 1000;
let neurToday = 0, neurWarned = '', neurDay = '', neurSrv = 0, neurLoc = [];
const utcDay = () => new Date().toISOString().slice(0, 10);
// statistica Cloudflare vine cu câteva minute întârziere: total = cifra serverului + estimările pozelor din ultimele 10 minute
function neurCalc(){ const d = utcDay(); if(neurDay !== d){ neurDay = d; neurSrv = 0; neurLoc = []; } neurLoc = neurLoc.filter(x => Date.now() - x.t < 6e5); neurToday = neurSrv + neurLoc.reduce((s, x) => s + x.n, 0); }
function neurSet(n){ neurCalc(); neurSrv = n; neurCalc(); }
function neurAdd(n, why){ neurCalc(); neurLoc.push({t:Date.now(), n}); neurCalc();
  // 9.7: pe ce s-au dus neuronii azi (estimare din aplicație; totalul exact vine de la Cloudflare)
  const d = utcDay(); if(!S.neurBy || S.neurBy.d !== d) S.neurBy = {d, by:{}};
  const k = why || 'alte'; S.neurBy.by[k] = (S.neurBy.by[k] || 0) + n; saveSettings(); }
const NEUR_WHY = {alte:'📷 poze (chat, stories, statusuri)', chat:'📷 poze în chat', variante:'🎯 variante în plus', refacere:'🔁 refaceri', retus:'🧬 retușul feței', corp:'🧍 potrivirea corpului', expresii:'🎭 expresii (apel)', stories:'📸 stories', statusuri:'📱 statusuri', test:'🔬 comparații', profil:'🖼️ portrete, avatar, stickere'};
// cota se resetează la 00:00 UTC; afișăm ora locală (03:00 vara, 02:00 iarna)
const resetAt = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'}); };
const CAP_USD = {free:0, '0.1':.10};
function capLeft(){   // neuroni permiși până la limită (Infinity = fără limită)
  if(S.imgProv !== 'worker' || S.cfPlan !== 'paid' || !(S.cfCap in CAP_USD)) return Infinity;
  neurCalc();
  return 10000 + CAP_USD[S.cfCap] / NEUR_USD - neurToday;
}
const capMsg = () => S.cfCap === 'free' ? `Neuronii gratuiți de azi s-au terminat și ai ales „Doar gratuit”. Pozele revin la ${resetAt()}.` : `Ai atins limita de $0,10 pe azi pentru poze. Revin la ${resetAt()}.`;
async function fetchNeurons(){
  const r = await fetch(wkUrl() + '/usage', {headers: S.wkTok ? {authorization:'Bearer ' + S.wkTok.trim()} : {}});
  if(!r.ok){ const e = new Error(r.status === 404 ? 'v3' : await errText(r)); e.st = r.status; throw e; }
  const d = await r.json(); if(!d.date || d.date === utcDay()) neurSet(d.neurons || 0); return d;
}
async function checkCap(model, size){
  if(capLeft() === Infinity) return;
  try{ await fetchNeurons(); }catch(e){}           // dacă nu merge citirea, rămâne estimarea locală
  if(capLeft() < (neurPerPhoto(model, size) || 5000)){ const e = new Error(capMsg()); e.cap = true; throw e; }
}
// consumul de neuroni Cloudflare de azi, citit prin Worker (GET /v1/usage)
async function loadNeurons(after){
  const box = $('#stNeur');
  if(S.imgProv !== 'worker' || !S.wkBase){ box.innerHTML = ''; return; }
  try{
    let d;
    try{ d = await fetchNeurons(); }
    catch(e){ if(e.st === 404){ box.className = 'neur'; box.textContent = 'Consumul de neuroni apare după ce urci Worker-ul v3.'; return; } throw e; }
    d = {...d, neurons:neurToday};
    const lim = d.limit || 10000, pc = Math.min(100, d.neurons / lim * 100);
    const per = neurPerPhoto(sceneModel()), left = per ? Math.max(0, Math.floor((lim - d.neurons) / per)) : null;
    if(S.cfPlan === 'paid'){
      const over = Math.max(0, d.neurons - lim), day = new Date().toISOString().slice(0, 10);
      box.className = 'neur';
      box.innerHTML = `Azi: <b>${Math.round(d.neurons).toLocaleString('ro-RO')}</b> neuroni · primii ${lim.toLocaleString('ro-RO')} gratuiți`
        + (over ? ` · peste cotă: <b>${Math.round(over).toLocaleString('ro-RO')}</b> ≈ <b>${usd(over * NEUR_USD)}</b> azi` : left !== null ? ` · <b>~${left}</b> poze gratuite rămase, apoi ~${usd(per * NEUR_USD)}/poză` : '')
        + `<div class="bar"><i style="width:${pc}%"></i></div>`;
      { const nb = S.neurBy && S.neurBy.d === utcDay() ? Object.entries(S.neurBy.by).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]) : [];
        if(nb.length) box.innerHTML += `<div style="margin-top:6px;font-size:12px;color:var(--tx3)">Pe ce, azi (estimat de aplicație): ${nb.map(([k, v]) => (NEUR_WHY[k] || k) + ' ' + Math.round(v).toLocaleString('ro-RO')).join(' · ')}</div>`; }
      if(capLeft() !== Infinity && capLeft() < (per || 5000)) box.innerHTML += `<div style="margin-top:6px;color:var(--warn,#ffb020)">⏸ Pozele sunt oprite până la ${resetAt()} (limita ta).</div>`;
      if(after && over && neurWarned !== day){ neurWarned = day; toast(`Ai trecut de cota gratuită de azi. Pozele merg în continuare${per ? `, ~${usd(per * NEUR_USD)} fiecare` : ''}.`, 4500); }
      return;
    }
    box.className = 'neur' + (pc >= 80 ? ' warn' : '');
    box.innerHTML = `Azi: <b>${Math.round(d.neurons).toLocaleString('ro-RO')}</b> / ${lim.toLocaleString('ro-RO')} neuroni gratuiți (${Math.round(pc)}%)${left !== null ? ` · <b>~${left}</b> poze rămase` : ''}<div class="bar"><i style="width:${pc}%"></i></div>`;
    if(after && pc >= 80) toast(pc >= 100 ? '⚠️ Cota gratuită Cloudflare de azi s-a terminat. Se resetează la ' + resetAt() + '.' : `⚠️ Ai folosit ${Math.round(pc)}% din neuronii gratuiți de azi.`, 4500);
  }catch(e){ box.className = 'neur'; box.textContent = 'Consum neuroni: ' + e.message; }
}
/* 🔬 7.3: comparație reală pe Worker-ul tău, cu poza de profil a personajului: eco 2 repere, eco 1 reper, 9B */
function drawBestHint(){
  const el = $('#stBestHint'); if(!el) return;
  const nine = sceneModel() !== 'eco', key = nine ? 'bestOf9' : 'bestOf';
  $$('#stBestOf button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S[key] || (nine ? '1' : '3'))));
  const n = Math.max(1, Math.min(3, +(S[key] || (nine ? '1' : '3')) || 1)), per = neurPerPhoto(sceneModel()) || 0;
  el.textContent = S.imgProv !== 'worker' ? 'Merge cu Worker-ul tău (Cloudflare).' : n < 2 ? 'O singură variantă pe poză.'
    : `Se fac ${n} variante în paralel; telefonul le măsoară fața și o păstrează pe cea mai asemănătoare cu poza de profil. ~${Math.round(per * n).toLocaleString('ro-RO')} neuroni pe poză${nine ? ' pe 9B (fiecare variantă în plus costă încă o poză întreagă)' : ''}. Dacă limita zilnică nu ajunge, se fac mai puține.`;
  if(n < 2 && S.imgProv === 'worker') el.textContent = `O singură variantă pe poză (~${Math.round(per).toLocaleString('ro-RO')} neuroni${nine ? ', 9B' : ''}).`;
  const ah = $('#stAutoHint'); if(ah){ const e = neurPerPhoto('eco'); ah.textContent = S.autoModel === 'eco' ? `Stories și statusuri pe Eco: ~${Math.round(e * Math.max(1, +S.bestOf || 1) + 37)} neuroni pe poză (cu variante și retușul feței). Pozele din chat rămân pe modelul de mai sus.` : `La fel ca pozele din chat${nine ? ' (9B, ~' + Math.round(per).toLocaleString('ro-RO') + ' neuroni pe poză)' : ''}.`; }
}
function drawBodyHint(){
  const el = $('#stBodyHint'); if(!el) return;
  el.textContent = S.imgProv !== 'worker' ? 'Merge cu Worker-ul tău (Cloudflare).' : S.bodyFix !== 'off'
    ? `După scenă, forma corpului e potrivită după poza de profil (greutate, bust, umeri, talie, șolduri), cu aceleași haine, poziție și cameră. ~${Math.round(neurPerPhoto('eco'))} neuroni pe poză. Merge când în poza de profil se vede măcar o parte din corp și poza nu e un prim-plan.`
    : 'Oprită (recomandat): corpul vine din repere și din descrierea de la începutul promptului. Pornită, poate schimba hainele și strica fața.';
}
function drawFixHint(){
  const el = $('#stFixHint'); if(!el) return;
  const e = Math.round(neurPerPhoto('eco', '512x512'));
  el.innerHTML = S.imgProv !== 'worker'
    ? 'Merge cu Worker-ul tău (Cloudflare).'
    : S.faceFix !== 'off'
      ? `După fiecare poză, fața e redesenată după poza de profil (doar fața; părul, hainele și locul rămân) și lipită la loc. Cost ~${e} neuroni pe poză. Dacă telefonul vede că tot nu e aceeași față, mai face un retuș pe 9B. Cu retușul pornit, „Eco” la fidelitate e de obicei suficient; verifică cu „🔬 Compară”. Pozele împreună și personajele desenate rămân ca înainte.`
      : 'Oprit: fața vine doar din generator, după repere (setarea „Fidelitatea feței”).';
  if(S.faceFix !== 'off' && sceneModel() !== 'eco') el.innerHTML = 'Cu „Fidel · 9B”, retușul nu rulează: 9B ține singur fața, pielea și expresia, iar retușul (pe eco) le-ar netezi. Se aplică doar pozelor pe Eco (de exemplu stories și statusuri, dacă le pui pe Eco mai jos).';
}
function drawChatHint(){
  const el = $('#stWkChatHint'); if(!el) return;
  const e = neurPerPhoto('eco'), f = neurPerPhoto('ancorat');
  if(S.wkChat === 'fal'){ el.innerHTML = 'Pozele din chat merg prin fal.ai PuLID, un model făcut special să păstreze aceeași față (din fața decupată din poza de profil). Plătit separat la fal.ai, câțiva cenți pe poză; nu consumă neuroni Cloudflare. Stickerele, avatarul, statusurile și pozele împreună rămân pe Worker.' + (hasKey('fal') ? '' : ' <b>Pune cheia fal.ai mai jos.</b>'); return; }
  el.innerHTML = S.wkChat === 'ancorat'
    ? `9B ține fața mult mai bine. ~${Math.round(f).toLocaleString('ro-RO')} neuroni pe poză: cam ${Math.floor(10000 / f)} poze pe zi în cota gratuită, apoi ~${usd(f * NEUR_USD)} pe poză (limita zilnică din Setări rămâne în vigoare). Stickerele, avatarul și statusurile rămân pe modelul de mai jos.`
    : `Eco: ~${Math.round(e)} neuroni pe poză. Împreună cu variantele multiple și retușul feței, în testele pe personajul tău a ieșit mai asemănător decât 9B (~${Math.round(f).toLocaleString('ro-RO')} neuroni).`;
}
async function refTest(){
  const c = (cur && cur.photo) ? cur : chars.find(x => x.photo);
  const box = $('#stRefRes');
  if(!c){ box.innerHTML = '<p class="hint">Ai nevoie de un personaj cu poză de profil.</p>'; return; }
  if(S.imgProv !== 'worker' || !S.wkBase){ box.innerHTML = '<p class="hint">Pornește întâi Worker-ul.</p>'; return; }
  const cost = Math.round(neurPerPhoto('eco') * 2 + neurPerPhoto('ancorat'));
  if(!confirm2(`Generez ${S.falKey ? 4 : 3} poze cu ${c.name} (aceeași scenă), ca să compari fața: eco cu 2 repere, eco cu 1 reper, 9B${S.falKey ? ' și fal.ai PuLID (câțiva cenți)' : ''}. ~${cost.toLocaleString('ro-RO')} neuroni.`)) return;
  const R = await idRefs(c);
  const shot = 'mirror selfie in a cozy bedroom, standing, holding the phone, casual t-shirt and jeans, warm lamp light, relaxed smile', fr = framingOf(shot);
  const p2 = idPrompt(c, shot, fr, R, '', true), p1 = idPrompt(c, shot, fr, R, '', false);
  const tests = [['Eco · ' + (2 + R.extra.length) + ' repere', {model:'eco', force:{two:true}, p1, extra:R.extra}], ['Eco · 1 reper', {model:'eco', force:{two:false, px:512}, p1}], ['Fidel 9B', {model:'ancorat', force:{two:true}, p1, extra:R.extra}]];
  if(S.falKey) tests.push(['fal.ai PuLID', {prov:'fal'}]);
  const pfu = await imgUrl(c.photo);
  box.innerHTML = `<div class="rtgrid"><figure><img src="${pfu}" alt=""><figcaption>Poza de profil</figcaption></figure>${tests.map((t, i) => `<figure id="rt${i}"><div class="ph"><span class="spin"></span></div><figcaption>${t[0]}</figcaption></figure>`).join('')}</div><p class="hint" id="rtNote">Generez pe rând…</p>`;
  let twoOk = null;
  for(let i = 0; i < tests.length; i++){
    const [lbl, o] = tests[i], fig = $('#rt' + i);
    try{
      let b;
      try{ b = o.prov === 'fal' ? await genImage(`${fr.p}. ${shot}.${physFull(c, R.id) ? ' The person: ' + physFull(c, R.id) + '.' : ''} ${STIL_TAG[c.stil || 'photo']}`, R.face, null, null, o) : await genImage(p2, R.face, null, R.body, o); }
      catch(e){ if(o.force && o.force.two){ if(o.model === 'eco') twoOk = false; b = await genImage(p2, R.face, null, R.body, {model:o.model, force:{two:false, px:512}, p1}); fig.querySelector('figcaption').textContent = lbl.replace('2 repere', '1 reper') + ' (2 repere: eroare)'; } else throw e; }
      if(o.model === 'eco' && o.force && o.force.two && twoOk === null) twoOk = true;
      fig.querySelector('.ph').outerHTML = `<img src="${URL.createObjectURL(b)}" data-big alt="">`;
    }catch(e){ fig.querySelector('.ph').innerHTML = '✗'; fig.querySelector('figcaption').textContent = lbl + ': ' + String(e.message).slice(0, 60); }
  }
  if(twoOk !== null){ S.wkRef = twoOk ? 'two' : 'one'; saveSettings(); }
  $('#rtNote').textContent = (twoOk === false ? 'Worker-ul tău nu acceptă 2 repere: de acum trimit doar poza de profil (1024 px). ' : twoOk ? '2 repere merg pe Worker-ul tău. ' : '') + 'Alege mai sus „Eco” sau „Fidel”, după fața care seamănă mai bine. Atinge o poză ca s-o vezi mare.';
  box.querySelectorAll('img').forEach(im => im.onclick = () => openSheet(`<div class="pad"><img src="${im.src}" style="width:100%;border-radius:14px" alt=""></div>`));
  setTimeout(() => loadNeurons(true), 1500);
}
const confirm2 = t => window.confirm(t);
async function testImages(){
  for(const [id, k] of Object.entries(FIELDS)) S[k] = $('#' + id).value.trim(); saveSettings();
  if(S.imgProv === 'worker' && S.wkBase) $('#stWkBase').value = S.wkBase = wkUrl(), saveSettings();
  const r = $('#stImgRes'); r.className = 'status'; r.innerHTML = '<span class="spin"></span> Generez o poză de test…';
  try{
    const b = await genImage('a cup of coffee on a wooden table by a window, morning light, photorealistic', null, null, null, {why:'test'});
    const u = URL.createObjectURL(b);
    r.className = 'status ok'; r.innerHTML = `✓ Merge.<br><img src="${u}" style="width:140px;border-radius:12px;margin-top:8px" alt="">`;
    setTimeout(() => loadNeurons(true), 1500);
  }catch(e){ r.className = 'status err'; r.textContent = '✗ ' + e.message; }
}
// 8.20: verifică Worker-ul v8 și ce chei are în seif (fără să le vadă)
async function vaultCheck(){
  const r = $('#stVkRes'); r.className = 'status'; r.innerHTML = '<span class="spin"></span> Verific seiful…';
  try{
    if(!S.wkBase) throw new Error('Pune adresa Worker-ului.');
    if(String(S.wkTok || '').trim().length < 24) throw new Error('Parola trebuie să aibă cel puțin 24 de caractere (apasă „🔑 Parolă nouă”).');
    const j = await wkFetch('/health');
    if(!j.v || j.v < 8) throw new Error('Worker-ul e o versiune veche. Pune codul din cloudflare-worker-simplu.js (v8).');
    S.vaultHas = j.seif || {}; saveSettings(); syncSegs();
    const L = {anthropic:'Anthropic', fal:'fal.ai', eleven:'ElevenLabs', gemini:'Google'};
    r.className = 'status ok';
    r.innerHTML = '✓ Seiful răspunde (v' + j.v + ').<br>' + Object.entries(L).map(([k, n]) => (S.vaultHas[k] ? '🔐 ' : '▫️ ') + n + (S.vaultHas[k] ? '' : ' (lipsește)')).join(' · ')
      + (j.origine ? '' : '<br>⚠️ Pune și variabila ORIGIN = ' + esc(location.origin) + ' în Worker, ca să nu-l poată folosi alt site.');
  }catch(e){ r.className = 'status err'; r.textContent = '✗ ' + e.message; }
}
async function vaultNewToken(){
  const t = b64u(crypto.getRandomValues(new Uint8Array(32)));
  confirmSheet('Generez o parolă nouă? Trebuie s-o pui și în Cloudflare (secretul TOKEN), altfel Worker-ul nu mai răspunde.', 'Generează', async () => {
    S.wkTok = t; saveSettings(); for(const [id, k] of Object.entries(FIELDS)) if(k === 'wkTok') $('#' + id).value = t;
    let copied = false; try{ await navigator.clipboard.writeText(t); copied = true; }catch(e){}
    const r = $('#stVkRes'); r.className = 'status ok';
    r.innerHTML = (copied ? '📋 Copiată. ' : '') + 'Pune-o în Cloudflare → Worker → Settings → Variables and Secrets → TOKEN (tip Secret):<br><code style="word-break:break-all;user-select:all">' + esc(t) + '</code>';
    if(S.pushOn) pushCfgToSW().catch(() => {});
  });
}
async function listGemModels(){
  const r = $('#stGemRes');
  if(!hasKey('gemini')){ r.className = 'status err'; r.textContent = 'Pune întâi cheia Google.'; return; }
  r.className = 'status'; r.innerHTML = '<span class="spin"></span> Întreb Google…';
  try{
    const res = await fetch(apiUrl('gemini', '/v1beta/models?pageSize=1000'), {headers:apiHeaders('gemini')});
    if(!res.ok) throw new Error(await errText(res));
    const d = await res.json();
    const ids = (d.models || []).filter(m => /image/i.test(m.name) && !/imagen/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({id:m.name.replace(/^models\//, ''), label:m.displayName || ''}));
    if(!ids.length) throw new Error('Cheia nu are acces la niciun model de imagine.');
    $('#dlGem').innerHTML = ids.map(x => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
    openSheet(`<h4>Modele de imagine disponibile pentru cheia ta</h4>` + ids.map((x, k) =>
      `<button class="opt" data-k="${k}"><i>${x.id === S.gemModel ? '✓' : '🖼️'}</i><span>${esc(x.id)}<br><small style="color:var(--tx3)">${esc(x.label)}</small></span></button>`).join(''));
    $$('.sheet .opt').forEach(b => b.onclick = () => {
      S.gemModel = ids[+b.dataset.k].id; $('#stGemModel').value = S.gemModel; saveSettings(); closeSheet();
      r.className = 'status ok'; r.textContent = '✓ Model ales: ' + S.gemModel;
    });
    r.className = 'status ok'; r.textContent = ids.length + ' modele găsite. Alege unul.';
  }catch(e){ r.className = 'status err'; r.textContent = '✗ ' + e.message; }
}
// 8.20: ce nu pleacă niciodată într-un backup și nu poate fi suprascris de o restaurare:
// cheile, adresele la care pleacă ele, seiful și blocarea (hash-ul PIN-ului s-ar sparge ușor dintr-un fișier)
const SECRET_SETTINGS = ['key', 'oaKey', 'gemKey', 'wkTok', 'elKey', 'falKey', 'oaBase', 'wkBase', 'prov', 'vault', 'vaultHas', 'lock', 'pinHash', 'pinSalt', 'pinLen', 'pinV', 'bioId'];
async function exportAll(share){
  toast('Pregătesc backup-ul…');
  const out = {app:'taifas2', v:APP_VER, date:new Date().toISOString(), data:{}};
  for(const k of await DB.keys()){
    let v = await DB.get(k);
    if(String(k).startsWith('aud:')) continue;   // înregistrările vocale nu intră în backup (se refac la nevoie)
    if(k === 'settings'){ v = {...v}; for(const x of SECRET_SETTINGS) delete v[x]; }
    if(v instanceof Blob) v = {__blob:await blobToB64(v), type:v.type};
    out.data[k] = v;
  }
  const name = `Taifas-backup-${new Date().toISOString().slice(0, 10)}.json`, blob = new Blob([JSON.stringify(out)], {type:'application/json'});
  // 8.5: „Trimite” = meniul de partajare al telefonului (Google Drive, e-mail…); altfel descărcare în telefon
  let done = false;
  if(share){
    try{ const f = new File([blob], name, {type:'application/json'});
      if(navigator.canShare && navigator.canShare({files:[f]})){ await navigator.share({files:[f], title:'Backup Taifas'}); done = true; } }
    catch(e){ if(e.name === 'AbortError') return; }
  }
  if(!done) download(blob, name);
  S.bkLast = Date.now(); delete S.bkSnooze; saveSettings();
  toast('💾 Backup gata (' + (blob.size / 1048576).toFixed(1) + ' MB).'); drawBk(); if(!$('#vHome').hidden) renderHome();
}
// 8.5: amintirea de backup (pe Acasă) și starea din Setări
const bkDue = () => S.bkEvery !== 'off' && chars.length && Date.now() - (S.bkLast || 0) > 7 * 864e5 && Date.now() > (S.bkSnooze || 0);
function bkAgo(){ if(!S.bkLast) return 'niciodată'; const d = Math.floor((Date.now() - S.bkLast) / 864e5); return d < 1 ? 'azi' : d === 1 ? 'ieri' : `acum ${d} zile`; }
function drawBk(){ const el = $('#stBkInfo'); if(el) el.textContent = 'Ultimul backup: ' + bkAgo() + '.'; }
async function importAll(file){
  try{
    const j = JSON.parse(await file.text());
    if(j.app !== 'taifas2' || !j.data) throw new Error('Nu e un backup Taifas 2.');
    confirmSheet('Restaurezi backup-ul din ' + (j.date || '').slice(0, 10) + '? Datele actuale se înlocuiesc (cheile tale rămân).', 'Restaurează', async () => {
      const keep = {}; for(const x of SECRET_SETTINGS) keep[x] = S[x];   // 8.20: un backup modificat nu poate redirecționa cheile spre alt server
      let rows;
      try{ rows = Object.entries(j.data).map(([k, v]) => [k, v && v.__blob ? b64ToBlob(v.__blob, v.type) : v]); }
      catch(e){ toast('Backup-ul e deteriorat; datele tale au rămas neatinse.', 4500); return; }
      await DB.clear();
      for(const [k, v] of rows) await DB.set(k, v);
      const s = await DB.get('settings') || {}; await DB.set('settings', {...s, ...keep});
      location.reload();
    });
  }catch(e){ toast('Fișier invalid: ' + e.message, 4000); }
}

/* ───────── evenimente ───────── */
function autoSize(){ const t = $('#inp'); t.style.height = 'auto'; t.style.height = t.value ? Math.min(140, t.scrollHeight + 2) + 'px' : ''; }
function bind(){
  $$('[data-back]').forEach(b => b.onclick = back);
  $('#btnSettings').onclick = openSettings;
  $$('#nav [data-tab]').forEach(b => b.onclick = () => { if(homeTab === b.dataset.tab){ $('#homeScroll').scrollTo({top:0, behavior:'smooth'}); return; } homeTab = b.dataset.tab; renderHome(); $('#homeScroll').scrollTop = 0; const sc = $('#homeScroll'); sc.classList.remove('tabin'); void sc.offsetWidth; sc.classList.add('tabin'); });
  $('#obStart').onclick = () => openSettings();
  $('#stTtsTest').onclick = () => voiceSample(chars[0] || {id:'test', name:'Taifas', look:'woman'}, $('#stTtsTest'));
  // lista de conversații: glisare spre stânga = Fixează / Golește
  let rx = 0, ry = 0, rEl = null, rLock = null, rOpen = null;
  const closeRow = () => { if(rOpen){ rOpen.querySelector('.cfront').style.transform = ''; rOpen = null; } };
  $('#homeChats').addEventListener('touchstart', e => { const r = e.target.closest('.crow'); rEl = r; rLock = null; if(!r) return; rx = e.touches[0].clientX; ry = e.touches[0].clientY; if(rOpen && rOpen !== r) closeRow(); }, {passive:true});
  $('#homeChats').addEventListener('touchmove', e => {
    if(!rEl) return; const dx = e.touches[0].clientX - rx, dy = e.touches[0].clientY - ry;
    if(rLock === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) rLock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if(rLock !== 'x') return;
    const base = rOpen === rEl ? -152 : 0;
    const f = rEl.querySelector('.cfront'); f.style.transition = 'none'; f.style.transform = `translateX(${Math.max(-170, Math.min(0, base + dx))}px)`;
  }, {passive:true});
  $('#homeChats').addEventListener('touchend', e => {
    if(!rEl) return; const r = rEl; rEl = null; const f = r.querySelector('.cfront'); f.style.transition = '';
    if(rLock !== 'x'){ return; }
    const dx = e.changedTouches[0].clientX - rx, base = rOpen === r ? -152 : 0;
    if(base + dx < -70){ f.style.transform = 'translateX(-152px)'; rOpen = r; } else { f.style.transform = ''; if(rOpen === r) rOpen = null; }
    r.dataset.swiped = '1'; setTimeout(() => delete r.dataset.swiped, 350);
  });
  $('#homeChats').addEventListener('click', async e => {
    const r = e.target.closest('.crow'); if(!r) return;
    const c = charById(r.dataset.c); if(!c) return;
    if(e.target.closest('[data-pin]')){ e.stopPropagation(); c.pinned = !c.pinned; await saveChars(); rOpen = null; renderHome(); toast(c.pinned ? '📌 Fixată sus' : 'Nu mai e fixată'); return; }
    if(e.target.closest('[data-clr]')){
      e.stopPropagation(); closeRow();
      confirmSheet(`Golești conversația curentă cu ${c.name}? Mesajele și pozele din ea dispar.`, 'Golește', async () => {
        const tid = c.thread || 'main', ch = await DB.get(chatKey(c.id, tid));
        if(busy && live && live.c === c && (live.ch.tid || 'main') === tid){ live.ch.dead = true; busy.abort(); }
        if(ch) for(const m of ch.msgs) await purgeMsg(m, c);
        const nc = newChat(); nc.tid = tid; nc.scene = ch?.scene || ''; if(c.greet) nc.msgs.push(greetMsg(c));
        c.unread = 0; await saveChat(c, nc); renderHome();
      });
      return;
    }
    if(r.dataset.swiped || rOpen === r){ e.stopPropagation(); closeRow(); }
  }, true);
  $('#setList').addEventListener('click', e => { const r = e.target.closest('[data-p]'); if(r) openSetPanel(r.dataset.p); });
  $('#edSteps').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if(b) edGo(+b.dataset.s); });
  $('#edBack').onclick = () => edGo(edStep - 1);
  $('#edNext').onclick = () => edStep < 3 ? edGo(edStep + 1) : saveEditor();
  $('#edGreet').addEventListener('input', drawEdPreview);
  $('#edName').addEventListener('input', drawEdPreview);
  $('#vHome').addEventListener('click', e => {
    if(e.target.closest('#btnNew, [data-new]')){ if(!aiReady()) toast('Sfat: adaugă întâi cheia în Setări, ca poza să fie descrisă automat.', 3500); openEditor(null); return; }
    const o = e.target.closest('[data-open]'); if(o) openWithFly(o);
  });
  // conversație
  $('#btnPolish').onclick = polishSheet;
  $('#composer').onsubmit = e => { e.preventDefault(); if(busy && live && live.ch === chat) busy.abort(); else send(); };
  $('#inp').addEventListener('input', () => { autoSize(); updateComposer(); });
  $('#inp').addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches){ e.preventDefault(); $('#composer').requestSubmit(); } });
  $('#btnPlus').onclick = plusMenu;
  $('#msgs').addEventListener('scroll', updateHead, {passive:true});
  // apăsare lungă pe o poză din conversație → meniul ei (salvează, trimite, poză de profil)
  $('#msgs').addEventListener('contextmenu', e => { const w = e.target.closest('.mw'); if(!w || !e.target.closest('.pic')) return; e.preventDefault(); msgSheet(+w.dataset.i); });
  $('#fGal').onchange = e => { pickedImage(e.target.files[0]); e.target.value = ''; };
  $('#fCam').onchange = e => { pickedImage(e.target.files[0]); e.target.value = ''; };
  $('#chMenu').onclick = chatMenu;
  $('#chWho').onclick = () => charProfile(cur.id);
  $('#pfScroll').addEventListener('scroll', profScroll, {passive:true});
  $('#btnMic').onclick = toggleMic;
  $('#btnSearch').onclick = () => openSearch();
  $('#chSearch').onclick = () => openSearch(cur.id);
  $('#btnSugg').onclick = () => { if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; } if(busy){ toast('Așteaptă răspunsul.'); return; } suggest(); };
  $('#search').addEventListener('input', renderHome);
  // apăsare lungă pe card → profil
  let lpT = null, lpFired = false;
  $('#vHome').addEventListener('pointerdown', e => { const o = e.target.closest('[data-open]'); if(!o) return; lpFired = false; lpT = setTimeout(() => { lpFired = true; charProfile(o.dataset.open); }, 480); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('#vHome').addEventListener(ev, () => clearTimeout(lpT)));
  $('#vHome').addEventListener('scroll', () => clearTimeout(lpT), true);
  $('#vHome').addEventListener('contextmenu', e => { if(e.target.closest('[data-open]')) e.preventDefault(); });
  $('#vHome').addEventListener('click', e => { if(lpFired){ e.stopImmediatePropagation(); lpFired = false; } }, true);
  // glisare: spre dreapta pe orice mesaj = răspunde la el; spre stânga pe ultimul răspuns = altă variantă
  let sx = 0, sy = 0, sEl = null, sLastAi = false, sLock = null;
  $('#msgs').addEventListener('touchstart', e => {
    const b = e.target.closest('.mw'); sEl = null; sLock = null; if(!b) return;
    const m = chat.msgs[+b.dataset.i]; if(!m || m.pending || m.pendingImg) return;
    sEl = b; sLastAi = !!b.querySelector('.under') && !!m.alts && !m.img && !busy;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, {passive:true});
  $('#msgs').addEventListener('touchmove', e => {
    if(!sEl) return;
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if(sLock === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) sLock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if(sLock !== 'x') return;
    const lim = dx > 0 ? 80 : (sLastAi ? -80 : 0);
    sEl.querySelector('.m').style.transform = `translateX(${Math.max(Math.min(0, lim), Math.min(80, dx * .5))}px)`;
  }, {passive:true});
  $('#msgs').addEventListener('touchend', e => {
    if(!sEl) return; const el = sEl; sEl = null;
    const mm = el.querySelector('.m'); mm.style.transform = '';
    if(sLock !== 'x') return;
    const dx = e.changedTouches[0].clientX - sx;
    if(Math.abs(dx) < 70) return;
    const i = +el.dataset.i, m = chat.msgs[i];
    if(dx > 0){ setReply(i); return; }
    if(!sLastAi) return;
    if((m.alt || 0) < m.alts.length - 1){ setAlt(m, (m.alt || 0) + 1); saveChat(); renderMsgs(); } else reply(m);
  });
  $('#rbX').onclick = clearReply;
  $('#jumpDown').onclick = () => { const box = $('#msgs'); box.scrollTo({top:box.scrollHeight, behavior:'smooth'}); jumpCount = 0; };
  $('#msgs').addEventListener('scroll', updateJump, {passive:true});
  setInterval(() => { if(cur && chat && !$('#vChat').hidden && !(busy && live && live.ch === chat)) $('#chTag').innerHTML = statusLine(); }, 60e3);
  let tapT = null, tapI = -1;
  $('#msgs').addEventListener('click', e => {
    const v = e.target.closest('[data-view]');
    if(v){
      // dublu-tap pe poză = reacție; un tap = vizualizator
      const w0 = e.target.closest('.mw'), i0 = w0 ? +w0.dataset.i : -1;
      if(tapT && tapI === i0){ clearTimeout(tapT); tapT = null; reactPicker(i0); return; }
      clearTimeout(tapT); tapI = i0; tapT = setTimeout(() => { tapT = null; viewImg(v.dataset.view); }, 280);
      return;
    }
    if(e.target.closest('.hero')){ charProfile(cur.id); return; }
    const w = e.target.closest('.mw'); if(!w) return;
    const i = +w.dataset.i, m = chat.msgs[i];
    if(e.target.closest('[data-regen]')){ if(!busy) reply(m); return; }   // 8.19: o singură variantă nouă; „🎰 +2” doar dacă mai vrei
    if(e.target.closest('[data-more3]')){ if(!busy) reply(m, {three:true, keep:true}); return; }
    { const rb = e.target.closest('[data-rate]'); if(rb){ rateMsg(i, +rb.dataset.rate); return; } }
    if(e.target.closest('[data-say]')){ say(m.text, m); return; }
    if(e.target.closest('[data-tr]')){ translateMsg(m); return; }
    if(e.target.closest('[data-vplay]')){ playVoice(m, e.target.closest('.bub')); return; }
    if(e.target.closest('[data-vtr]')){ const b = e.target.closest('.bub'); const t = b.querySelector('.vtxt'); t.hidden = !t.hidden; e.target.textContent = t.hidden ? 'Transcriere' : 'Ascunde transcrierea'; return; }
    if(e.target.closest('[data-cont]')){ if(!busy) reply(null, {cont:true}); return; }
    if(e.target.closest('[data-retry]')){ if(!busy) retry(i); return; }
    const ia = e.target.closest('[data-ia]');
    if(ia){ m.ia = Math.max(0, Math.min(m.imgAlts.length - 1, m.ia + +ia.dataset.ia)); m.img = m.imgAlts[m.ia]; saveChat(); renderMsgs(); return; }
    if(e.target.closest('[data-rephoto]')){ rephotoMenu(i); return; }
    const a = e.target.closest('[data-alt]');
    if(a){ setAlt(m, (m.alt || 0) + +a.dataset.alt); saveChat(); renderMsgs(); return; }
    const q = e.target.closest('[data-q]');
    if(q){ jumpTo(cur.id, chat.tid || 'main', q.dataset.q); return; }
    if(e.target.closest('.bub, .picbox')){
      if(tapT && tapI === i){ clearTimeout(tapT); tapT = null; reactPicker(i); return; }
      clearTimeout(tapT); tapI = i;
      tapT = setTimeout(() => { tapT = null; if(!e.target.closest('.picbox')) msgSheet(i); }, 280);
    }
  });
  // editor
  $('#edPhoto').onclick = () => $('#edFile').click();
  $('#edFile').onchange = e => { onPhotoPicked(e.target.files[0]); e.target.value = ''; };
  $('#edRedesc').onclick = runDescribe;
  $('#edCheck').onclick = runVerify;
  $('#edDraft').onclick = runDraft;
  $('#edGen').onclick = runPortrait;
  $('#edNameGen').onclick = runNames;
  $('#edSurprise').onclick = surpriseSheet;
  $('#edName').addEventListener('input', () => { $('#edTitle').textContent = $('#edName').value.trim() || 'Personaj nou'; $$('#edNames button').forEach(b => b.classList.toggle('on', b.textContent === $('#edName').value.trim())); });
  $('#edSave').onclick = saveEditor;
  $('#edDel').onclick = () => deleteChar();
  $('#edAcc').addEventListener('click', e => { const b = e.target.closest('[data-a]'); if(!b) return; ed.accent = b.dataset.a; drawLook(); });
  $$('#edBg button').forEach(b => b.onclick = () => { ed.bg = b.dataset.v; drawLook(); });
  $('#sceneBar').onclick = editScene;
  $('#stCostReset').onclick = () => confirmSheet('Resetezi contorul de consum?', 'Resetează', async () => { await DB.del('usage'); renderCost(); });
  // setări: salvare automată la orice schimbare
  for(const [id, k] of Object.entries(FIELDS)) $('#' + id).addEventListener('change', e => { S[k] = e.target.value.trim(); for(const [id2, k2] of Object.entries(FIELDS)) if(k2 === k && id2 !== id) $('#' + id2).value = S[k]; saveSettings(); if(k === 'wkBase' || k === 'wkTok' || k === 'wkModel' || k === 'wkSize') loadNeurons(); if(k === 'wkBase' || k === 'oaBase'){ S.vaultHas = null; saveSettings(); cspSync(false); } if(k === 'wkTok' && S.pushOn) pushCfgToSW().catch(() => {}); drawWkEst(); renderSetSummary(); });
  for(const [id, k] of Object.entries(SEGS)) $$('#' + id + ' button').forEach(b => b.onclick = () => {
    let v = k === 'font' ? +b.dataset.v : b.dataset.v;
    if(v === 'alt') v = (S.imgProv === 'fal' || S.imgProv === 'gemini') ? S.imgProv : (S.imgAlt || 'fal');
    if(k === 'imgProv' && (v === 'fal' || v === 'gemini')) S.imgAlt = v;
    if(k === 'bestOf' && sceneModel() !== 'eco'){ S.bestOf9 = v; saveSettings(); syncSegs(); return; }   // 9.1: pe 9B variantele se țin separat
    S[k] = v; saveSettings(); syncSegs();
    if(k === 'prov') cspSync(false);
    if(k === 'imgProv' || k === 'cfPlan') loadNeurons();
    if(k === 'cfPlan') drawWkEst();
  });
  $('#stTest').onclick = () => { for(const [id, k] of Object.entries(FIELDS)) S[k] = $('#' + id).value.trim(); saveSettings(); testAI(); };
  $('#stVkCheck').onclick = () => { S.wkBase = $('#stVkBase').value.trim(); S.wkTok = $('#stVkTok').value.trim(); saveSettings(); vaultCheck(); };
  $('#stVkGen').onclick = vaultNewToken;
  $('#stVkWipe').onclick = () => confirmSheet('Ștergi cheile din telefon? Seiful le are deja; aplicația va merge doar prin Worker.', 'Șterge', () => {
    for(const k of ['key', 'falKey', 'elKey', 'gemKey']) S[k] = '';
    for(const [id, k] of Object.entries(FIELDS)) if(['key', 'falKey', 'elKey', 'gemKey'].includes(k)) $('#' + id).value = '';
    saveSettings(); syncSegs(); toast('🧹 Cheile au fost scoase din telefon');
  });
  $('#stExport').onclick = () => exportAll(false);
  $('#stExportShare').onclick = () => exportAll(true);
  $('#stWrapped').onclick = () => openWrapped();
  $('#btnWrapped').onclick = () => openWrapped();
  $('#btnBcast').onclick = () => bcastSheet();
  $('#chCall').onclick = () => callChoice();
  $('#stMePick').onclick = () => $('#fMe').click();
  $('#fMe').onchange = e => { setMePhoto(e.target.files[0]); e.target.value = ''; };
  $('#stMeDel').onclick = async () => { if(S.userPhoto) await delImg(S.userPhoto).catch(() => {}); S.userPhoto = ''; S.userPhys = ''; S.userBox = null; saveSettings(); drawMe(); };
  $('#stCardImp').onclick = () => $('#stCardFile').click();
  $('#stCardFile').onchange = e => { if(e.target.files[0]) importCard(e.target.files[0]); e.target.value = ''; };
  $('#stImgTest').onclick = testImages;
  $('#stRefTest').onclick = refTest;
  $('#stGemList').onclick = () => { S.gemKey = $('#stGemKey').value.trim(); saveSettings(); listGemModels(); };
  $('#stImport').onclick = () => $('#stImpFile').click();
  $('#stImpFile').onchange = e => { if(e.target.files[0]) importAll(e.target.files[0]); e.target.value = ''; };
  $('#stWipe').onclick = () => confirmSheet('Ștergi TOATE personajele, conversațiile și setările?', 'Șterge tot', async () => { await DB.clear(); location.reload(); });
}

/* ───────── pornire ───────── */
// 8.20: Content-Security-Policy. Pagina poate vorbi doar cu serviciile cunoscute + adresele tale (Worker, furnizor OpenAI).
// Lista de adrese proprii stă în localStorage (o citește scriptul din <head> înainte de orice altceva).
function cspOrigins(){
  const o = [];
  for(const u of [S.wkBase && wkUrl(), S.prov !== 'anthropic' && S.oaBase]) if(u){ try{ const x = new URL(u); if(x.protocol === 'https:') o.push(x.origin); }catch(e){} }
  return [...new Set(o)].sort();
}
function cspSync(boot){
  const want = JSON.stringify(cspOrigins());
  let have = null; try{ have = localStorage.getItem('taifas-csp'); }catch(e){ return false; }
  if(have === want) return false;
  try{ localStorage.setItem('taifas-csp', want); }catch(e){ return false; }
  if(boot){ location.reload(); return true; }
  toast('Adresă nouă salvată. Repornesc aplicația…', 1500);
  setTimeout(() => { location.href = location.pathname + '?go=set'; }, 900);
  return true;
}
async function init(){
  try{ await DB.open(); }catch(e){ document.body.innerHTML = '<p class="empty">Browserul nu permite stocarea locală (IndexedDB). Ieși din modul privat.</p>'; return; }
  const saved = await DB.get('settings');
  S = {...DEF, ...(saved || {})};
  if(saved) S.sv = saved.sv || 0;                     // setări vechi fără versiune: rulăm migrările
  if(saved && (S.sv || 0) < 25){ if(S.spont === 'off') S.spont = 'rar'; S.sv = 25; saveSettings(); }
  // 8.12: pozele din chat prioritizează fidelitatea identității, nu modelul eco.
  if((S.sv || 0) < 35){ if(!S.wkChat) S.wkChat = 'ancorat'; S.sv = 35; saveSettings(); }
  // 8.21: fața din poza de profil, pornită implicit acolo unde există cheia fal.ai
  // 8.22: retușul feței pe Cloudflare înlocuiește schimbul de față prin fal.ai din 8.21
  if((S.sv || 0) < 37){ S.faceFix = 'on'; delete S.swap; delete S.swapModel; delete S.swapCost; S.sv = 37; saveSettings(); }
  // 8.25: potrivirea corpului oprită (strica hainele și fața); 3 variante pe poză
  if((S.sv || 0) < 38){ S.bodyFix = 'off'; S.bestOf = '3'; S.sv = 38; saveSettings(); }
  // 9.1: pe 9B implicit o singură variantă (fiecare în plus costă o poză 9B întreagă)
  if((S.sv || 0) < 39){ if(!S.bestOf9) S.bestOf9 = '1'; if(!S.autoModel) S.autoModel = 'chat'; S.sv = 39; saveSettings(); }
  // 9.6: fără costuri peste cei $5/lună: „Fără limită” → „Doar gratuit” (o dată; se poate pune înapoi)
  if((S.sv || 0) < 40){ if(S.cfPlan === 'paid' && S.cfCap === 'none') S.cfCap = 'free'; S.sv = 40; saveSettings(); }
  if(cspSync(true)) return;   // 8.20: adresă nouă → repornim o dată, ca politica de securitate să o permită
  chars = (await DB.get('chars') || []).filter(c => c && c.id && c.name);
  if((S.sv || 0) < 34){
    if(S.wkModel === 'ancorat') S.wkModel = 'eco';
    if(['480x640', '576x768'].includes(S.wkSize)) S.wkSize = '768x1024';
    if((S.sv || 0) >= 30){ S.sv = 34; saveSettings(); }
  }
  if((S.sv || 0) < 30){ chars.forEach(c => { if(!c.bg || c.bg === 'poza') c.bg = 'clar'; }); await saveChars(); S.sv = 34; saveSettings(); }
  await loadFeed();
  syncSegs();
  bind();
  const go = new URLSearchParams(location.search).get('go'), justUpd = /[?&]upd=/.test(location.search);   // 8.6: scurtăturile de pe iconiță
  history.replaceState({root:1}, '', location.pathname); history.pushState(null, '');
  renderHome();
  if(S.lock && S.lock !== 'off') showLock();   // întâi blocarea: scurtătura se deschide abia după deblocare
  if(!aiReady() && !chars.length) show('vWelcome', false);
  else if(!aiReady()) openSettings();
  else if(go) whenUnlocked(() => runShortcut(go));
  // 8.4: ecranul modern revine; logo-ul stă exact unde îl lasă ecranul Android (centru, ~22% din lățime), deci trecerea nu se vede
  setTimeout(() => { const sp = $('#splash'); if(!sp) return; sp.classList.add('out'); setTimeout(() => sp.remove(), 450); }, 1300);
  navigator.storage?.persist?.().catch(() => {});
  setTimeout(runDueSched, 1500);
  setInterval(runDueSched, 30e3);
  setTimeout(jrnSweep, 6000); setInterval(jrnSweep, 30 * 60e3);
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ setTimeout(runDueSched, 800); setTimeout(jrnSweep, 4000); } });
  if('serviceWorker' in navigator && location.protocol === 'https:'){
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.go) whenUnlocked(() => runShortcut(e.data.go)); });
    if(S.pushOn) pushCfgToSW().catch(() => {});
  }
  setInterval(tickClocks, 30e3);
  setTimeout(laterPoll, 25e3); setInterval(() => { if(!document.hidden) laterPoll(); }, 3 * 60e3);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) setTimeout(laterPoll, 6e3); });
  setTimeout(proSweep, 10e3); setInterval(() => { if(!document.hidden) proSweep(); }, 20 * 60e3);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) setTimeout(proSweep, 5e3); });
  setTimeout(lifeSweep, 15e3); setTimeout(() => storySweep(false), 30e3);
  setInterval(() => { if(!document.hidden){ lifeSweep(); storySweep(false); } }, 45 * 60e3);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) setTimeout(() => storySweep(false), 20e3); });
  $('#stUpd').onclick = () => checkUpdate(true);
  setTimeout(() => checkUpdate(false), 8000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) setTimeout(() => checkUpdate(false), 3000); });
  if(justUpd) setTimeout(() => toast('Actualizat la ' + APP_VER + ' ✓'), 1500);
}
init();
