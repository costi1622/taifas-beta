window.__taifas = true;   // 8.20.1: semn pentru index.html că app.js s-a încărcat
const APP_VER = '9.88';

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
  userName:'', userAbout:'', len:'mediu', font:16,
  imgProv:'none',
  wkBase:'', wkTok:'', wkModel:'eco', wkSize:'768x1024',
  sugg:'off', pro:'on', feed:'text', smart:'echilibrat', idSheet:'on', drafts:'on', localFix:'on', callFill:'on', lenAuto:'on', cacheTtl:'1h', ctxCompact:'on', callLife:'on', callCam:'on', callGlitch:'on', callBg:'on', callSprites:'on', callMirror:'on', fx:'on', regen3:'on', voice:'tap', tts:'tel', cfPlan:'free', cfCap:'free', theme:'dark', vmsg:'rar', jrn:'on', aux:'on', ctxN:'30',
  vault:'off', vaultHas:null, faceFix:'on', bodyFix:'on', bestOf:'3', autoModel:'chat', callFace:'on', handCheck:'off', crHands:'on', crAngles:'off', callAmb:'on', callBack:'on', callDepth:'on', callLight:'on', callPres:'on', autoRefs:'on', autoFull:'on', imgRoute:'mix', cfFallback:'off', photoEngine:'creator', photoModel:'klein', people:'on', typeReal:'on', chatMode:'rp', rpStyle:'open', imgCheck:'on', story:'on', sky:'on', social:'on', userBday:'', lock:'off', pushOn:false, bkEvery:'week', bkLast:0, userPhoto:'', userPhys:'', userBox:null, wkChat:'ancorat', wkRef:'auto', rw:'off', rwKey:'', rwCap:'0.5', rwAvg:0, idBoost:'on', spont:'rar', sv:34, imgCost:'', pIn:'', pOut:''
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
  if(urlCache.has(k)){ const u = urlCache.get(k); urlCache.delete(k); urlCache.set(k, u); return u; }   // 9.13.1: ordinea = ultima folosire
  const b = await DB.get(k); if(!b) return '';
  const u = URL.createObjectURL(b); urlCache.set(k, u); return u;
}
async function saveImg(blob){ const k = 'img:' + uid(); await DB.set(k, blob); return k; }
/* 9.13: miniaturi. În bule și la avatare se decodează o poză pe măsura ecranului (~1.300 / 192 px), nu poza întreagă (de la cameră, 10+ MP);
   poza întreagă se deschide doar când o atingi. Pozele care sunt deja la mărimea ecranului (de ex. cele generate, 768×1024) rămân întregi. Miniaturile stau în baza de date cu prefixul thm:/ths: (nu intră în backup,
   se refac singure); dimensiunile și o versiune de ~24 px (pentru locul rezervat, estompat) stau în `imeta`. */
let imeta = {}, imetaT = 0;
// pozele din bule: cât are nevoie ecranul (bula are până la ~460 px; telefonul are 2–3 pixeli fizici pe pixel) → fără pierdere vizibilă
const TH = {m:Math.min(1440, Math.max(900, Math.round(460 * (window.devicePixelRatio || 2)))), s:192};
async function imetaLoad(){ try{ imeta = (await DB.get('imeta')) || {}; }catch(e){ imeta = {}; } }
function imetaSave(){ clearTimeout(imetaT); imetaT = setTimeout(() => { DB.set('imeta', imeta).catch(() => {}); }, 1500); }
const thKey = (t, k) => 'th' + t + ':' + k;
const thBusy = new Set();
// 9.13.1: lucrul de fundal (miniaturi, eliberarea memoriei) se face doar când telefonul e liber: nu în timpul deschiderii unui chat
//         sau al derulării (în 9.13 se făcea chiar la deschidere, pentru fiecare poză, și încetinea animația)
let busyUntil = 0; const idleQ = []; let idleOn = false;
const markBusy = (ms = 1800) => { busyUntil = Math.max(busyUntil, performance.now() + ms); };
function idleJob(fn){ idleQ.push(fn); if(!idleOn){ idleOn = true; idleTick(); } }
function idleTick(){
  const go = d => {
    if(performance.now() < busyUntil || (d && d.timeRemaining && d.timeRemaining() < 8)){ setTimeout(idleTick, 400); return; }
    const fn = idleQ.shift(); if(!fn){ idleOn = false; return; }
    Promise.resolve().then(fn).catch(() => {}).finally(() => setTimeout(idleTick, 120));
  };
  if('requestIdleCallback' in window) requestIdleCallback(go, {timeout:4000}); else setTimeout(go, 300);
}
// 9.15: și fără un <img> încărcat: dimensiunile vin din fișier (decodat în afara firului principal)
function thumbsFor(k){ if(k && !thBusy.has(k) && !(imeta[k] && imeta[k].m && imeta[k].s && imeta[k].lq)) makeThumbs(k, null); }
function makeThumbs(k, im){
  if(!k || thBusy.has(k) || (im && !im.naturalWidth)) return;
  let W = im ? im.naturalWidth : 0, H = im ? im.naturalHeight : 0; thBusy.add(k);
  idleJob(async () => {
    try{
      const blob = await DB.get(k); if(!blob) return;
      if(!W){ const bm = await createImageBitmap(blob); W = bm.width; H = bm.height; bm.close(); }
      const meta = imeta[k] = imeta[k] || {}; meta.w = W; meta.h = H;
      // redimensionare în afara firului principal; fără createImageBitmap, prin canvas (ca înainte)
      const shrink = async px => {
        const s = Math.min(1, px / Math.max(W, H)), w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
        let src = null; try{ src = await createImageBitmap(blob, {resizeWidth:w, resizeHeight:h, resizeQuality:'high'}); }catch(e){ src = im; } if(!src) throw new Error('fără sursă');   // nu salvăm o miniatură goală
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(src, 0, 0, w, h); if(src.close) src.close(); return cv;
      };
      if(!meta.lq) meta.lq = (await shrink(24)).toDataURL('image/jpeg', .5);
      for(const [t, px] of Object.entries(TH)){
        if(meta[t]) continue;
        if(Math.max(W, H) <= px * 1.3){ meta[t] = 'same'; continue; }   // poza e deja mică
        const b = await new Promise(async r => (await shrink(px)).toBlob(r, 'image/jpeg', .86));
        if(b){ await DB.set(thKey(t, k), b); meta[t] = 1; }
      }
      imetaSave();
    }catch(e){} finally { thBusy.delete(k); }
  });
}
async function delImg(k){ if(!k) return; for(const x of [k, thKey('m', k), thKey('s', k)]){ const u = urlCache.get(x); if(u) URL.revokeObjectURL(u); urlCache.delete(x); }
  if(imeta[k]){ delete imeta[k]; imetaSave(); } await DB.del(k); DB.del(thKey('m', k)).catch(() => {}); DB.del(thKey('s', k)).catch(() => {}); DB.del(thKey('x', k)).catch(() => {}); }
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
    const k = el.dataset.k, t = el.dataset.t; let u = '';
    if(t && imeta[k] && imeta[k][t] === 1){ u = await imgUrl(thKey(t, k)); if(!u){ delete imeta[k][t]; imetaSave(); } }   // după o restaurare, miniaturile se refac
    if(!u) u = await imgUrl(k);
    if(t && !(imeta[k] && imeta[k][t] && imeta[k].lq)) el.addEventListener('load', () => makeThumbs(k, el), {once:true});
    if(el.classList.contains('dev')){ el.onload = () => el.classList.add('go'); }
    el.decoding = 'async';   // 9.4: decodarea pozei nu mai blochează animațiile
    if(el.classList.contains('pic')) el.loading = 'lazy';   // 9.13.1: pozele din chat din afara ecranului se încarcă doar când ajungi la ele
    if(u) el.src = u; el.removeAttribute('data-k');
  }
  for(const el of root.querySelectorAll('[data-bgk]')){
    const k = el.dataset.bgk; let u = '';
    if(imeta[k] && imeta[k].m === 1){ u = await imgUrl(thKey('m', k)); if(!u){ delete imeta[k].m; imetaSave(); } }   // 9.15: fundal din miniatură
    if(!u){ u = await imgUrl(k); if(!(imeta[k] && imeta[k].m)) thumbsFor(k); }
    el.style.backgroundImage = u ? `url("${u}")` : ''; el.removeAttribute('data-bgk');
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
  // 9.27: dispoziția de acum, oriunde (din chatul deschis sau, altfel, ultima știută a personajului, din ultimele 6 ore)
  const mo = (cur === c && chat && chat.mood && chat.mood.t ? chat.mood.t : c && c.moodNow && c.moodNow.t && Date.now() - (c.moodNow.ts || 0) < 6 * 36e5 ? c.moodNow.t : '').toLowerCase();
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
  if(duoOn(c)) return duoAvHTML(c, cls);   // 9.64: două cercuri, câte unul pentru fiecare
  if(c && c.photo) return `<img class="${cls}" data-k="${esc(photoNow(c))}"${cls === 'av' || cls.startsWith('av"') ? ' data-t="s"' : ''} alt="">`;
  return `<span class="${cls}" style="background:${colorFor(c)}">${esc((c?.name || '?')[0].toUpperCase())}</span>`;
}
/* 9.64: avatarul pentru două personaje: două cercuri suprapuse (poza fiecăreia, dacă are, altfel inițiala în culoarea ei din chat) */
const duoPic = (c, k) => k ? (c.duo.b.photo || '') : (c.photo ? photoNow(c) : '');
const duoNm = (c, k) => (k ? c.duo.b.name : c.duo.a.name) || '?';
function duoOne(c, k, view){
  const src = duoPic(c, k);
  return src ? `<img data-k="${esc(src)}" data-t="s"${view ? ` data-view="${esc(src)}"` : ''} alt="">` : `<i style="background:${k ? 'linear-gradient(135deg,#2f8fd8,#1c5a8c)' : colorFor(c)}">${esc(duoNm(c, k)[0].toUpperCase())}</i>`;
}
// 9.64: fundalul cardurilor (Acasă) pentru două personaje: două jumătăți, câte una pentru fiecare
function duoHalves(c, cls = 'ph', t = 'm'){
  return `<div class="${cls} duofill">${[0, 1].map(k => `<div class="dh" style="background:${k ? 'linear-gradient(135deg,#2f8fd8,#1c5a8c)' : colorFor(c)}">${duoPic(c, k) ? `<img data-k="${esc(duoPic(c, k))}" data-t="${t}" alt="">` : `<span>${esc(duoNm(c, k)[0].toUpperCase())}</span>`}</div>`).join('')}</div>`;
}
function duoAvHTML(c, cls){ return `<span class="duoav ${cls}" title="${esc(c.name)}">${duoOne(c, 0)}${duoOne(c, 1)}</span>`; }
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
/* 9.63: 👯 două personaje în același chat (fără grup). c.duo = {on, a:{name}, b:{name, persona, aspect, speech}, rel}.
   Personajul 1 = câmpurile obișnuite (persona, aspect, speech); c.name = „A & B” (cardul, antetul).
   Un singur răspuns AI le scrie pe amândouă, fiecare replică pe rândul ei: „A: …” / „B: …”; chatul le arată cu numele colorat. */
const duoOn = c => !!(c && c.duo && c.duo.on && c.duo.a && c.duo.b && c.duo.a.name && c.duo.b.name);
const DUO_COL = ['var(--acc)', '#4fc3f7'];
function duoSplit(c, text){
  const N = [c.duo.a.name, c.duo.b.name], esc2 = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alt = N.flatMap((n, k) => [[n, k], [n.split(' ')[0], k]]).sort((x, y) => y[0].length - x[0].length);
  const re = new RegExp('^\\s*\\**\\s*(' + alt.map(x => esc2(x[0])).join('|') + ')\\s*\\**\\s*:\\s*', 'i');
  const out = []; let curK = 0;
  for(const line of String(text || '').split('\n')){
    const m = line.match(re);
    if(m){ const hit = alt.find(x => x[0].toLowerCase() === m[1].toLowerCase()); curK = hit ? hit[1] : curK; out.push({k:curK, t:line.slice(m[0].length)}); }
    else if(out.length) out[out.length - 1].t += '\n' + line;
    else if(line.trim()) out.push({k:0, t:line});
  }
  return out.map(x => ({k:x.k, t:x.t.replace(/^\n+|\n+$/g, '')})).filter(x => x.t.trim());
}
function duoHTML(c, text){
  const seg = duoSplit(c, text); if(!seg.length) return fmtMsg(text);
  const N = [c.duo.a.name, c.duo.b.name];
  return seg.map(x => `<div class="duo d${x.k}"><b class="dnm" style="--dc:${DUO_COL[x.k]}">${esc(N[x.k].split(' ')[0])}</b>${fmtMsg(x.t)}</div>`).join('');
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
    if(last && last.role === m.role && !m.image && !last.image && !m.images && !last.images && !m.parts && !last.parts){ last.text += '\n\n' + m.text; if(m._cache) last._cache = true; continue; }
    out.push({...m});
  }
  if(!out.length || out[0].role !== 'user') out.unshift({role:'user', text:'(Începe conversația.)'});
  // 9.46: modelele noi nu mai acceptă conversații care se termină cu mesajul personajului (prefill) → eroare 400.
  //       Când istoricul se oprește la un mesaj al ei (altă variantă, continuare, mesaj trimis singur), adăugăm un mic semnal de la tine.
  if(out[out.length - 1].role === 'assistant') out.push({role:'user', text:'(continuă tu, firesc, cu un mesaj nou; nu repeta ce ai scris deja)'});
  // punct de cache pe istoric: tot ce e până la mesajul marcat se citește din cache la ~10% din preț la răspunsul următor
  const cc = m => m._cache ? {cache_control:ttl === '1h' ? {type:'ephemeral', ttl:'1h'} : {type:'ephemeral'}} : {};
  const imgsOf = m => m.images || (m.image ? [m.image] : null);
  // 9.61: un mesaj din blocuri (transcrierea grupului): fiecare bloc separat, ca prefixul să fie găsit în cache de la un apel la altul
  const ccx = () => ({cache_control:ttl === '1h' ? {type:'ephemeral', ttl:'1h'} : {type:'ephemeral'}});
  return out.map(m => m.parts ? {role:m.role, content:m.parts.map((t, i) => ({type:'text', text:t, ...(i === m._cacheAt ? ccx() : {})}))} : ({role:m.role, content: imgsOf(m)
    ? [...imgsOf(m).map(d => ({type:'image', source:{type:'base64', media_type:'image/jpeg', data:d}})), {type:'text', text:m.text, ...cc(m)}]
    : (m._cache ? [{type:'text', text:m.text, ...cc(m)}] : m.text)}));
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
  if(aux && S.aux !== 'off' && !auxBroken) return (S.auxModel || AUX_DEF).trim();
  return S.model || DEF.model;
}
/* ───────── 🔐 8.20: seiful de chei ─────────
   „Cheile în Worker”: aplicația nu mai trimite nicio cheie; vorbește doar cu Worker-ul (cu parola TOKEN),
   iar Worker-ul adaugă cheia din secretele Cloudflare. „Cheile în telefon”: ca înainte. */
const API_HOST = {anthropic:'https://api.anthropic.com'};   // 9.19: furnizorii sunt doar Anthropic (text), Cloudflare și Runware (poze)
const vaultOn = () => S.vault === 'on' && !!String(S.wkBase || '').trim() && !!String(S.wkTok || '').trim();
function apiUrl(svc, path){ return vaultOn() ? wkUrl() + '/proxy/' + svc + path : API_HOST[svc] + path; }
function apiHeaders(svc, extra = {}){
  if(vaultOn()) return {...extra, authorization:'Bearer ' + S.wkTok.trim()};
  return {...extra, 'x-api-key':S.key.trim(), 'anthropic-dangerous-direct-browser-access':'true'};
}
// seif: ce chei are Worker-ul (aflat la „Verifică seiful”); necunoscut = presupunem că există și lăsăm Worker-ul să spună
const hasKey = svc => vaultOn() ? !(S.vaultHas && S.vaultHas[svc] === false) : !!String({anthropic:S.key}[svc] || '').trim();
// adresele întoarse de Anthropic (results_url) trec și ele prin seif
function anthUrl(u){ try{ const x = new URL(u); if(x.host !== 'api.anthropic.com') throw 0; return apiUrl('anthropic', x.pathname); }catch(e){ throw new Error('Adresă neașteptată de la Anthropic.'); } }
// 9.73: JSON sigur pentru API: un text tăiat la mijlocul unui emoji (jumătate de pereche surogat, ex. din .slice(0, n))
// ajungea ca „\ud83d” singur, iar Anthropic refuza toată cererea („400: … unexpected end of hex escape”). Orice jumătate rămasă devine „�”.
const wellFormed = t => typeof t.toWellFormed === 'function' ? t.toWellFormed() : t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
const safeJSON = o => JSON.stringify(o, (k, v) => typeof v === 'string' ? wellFormed(v) : v);
async function stream(sys, msgs, opts = {}){
  try{ return await streamOnce(sys, msgs, opts); }
  catch(e){
    // dacă modelul mic nu e disponibil pe cont, revenim o dată la modelul principal
    if((opts.aux || opts.eco) && !auxBroken && /model|not_found|404/i.test(e.message || '')){ auxBroken = true; return await streamOnce(sys, msgs, {...opts, aux:false, eco:false, model:null}); }
    throw e;
  }
}
async function streamOnce(sys, msgs, {max = 700, signal, onText, cid, aux, meta, tag, cold, conv, eco, hist} = {}){
  const model = eco ? modelFor(true) : modelFor(aux);   // 9.49: eco = mesaj simplu → modelul mic, cu tot contextul personajului
  // 8.17: conversația rămâne în cache 1 oră (nu 5 minute): la pauze mai lungi istoricul se recitește la 5-10% din preț
  // 8.19: primul mesaj după o pauză (cache-ul a expirat oricum) scrie la 1,25× (5 min); de la al doilea trece pe 1 oră
  // 9.0: cache doar pentru conversații (conv); pașaportul, jurnalul, planificarea pozelor etc. se trimit o singură dată,
  //      iar scrierea în cache (2× pe 1 h, 1,25× pe 5 min) ar fi fost plătită degeaba
  const ttl = conv && !aux && !eco && !cold && S.cacheTtl !== '5m' ? '1h' : '';
  const httl = ttl && hist === '5m' ? '' : ttl;   // 9.49: cache inteligent: istoricul pe 5 min cât vorbiți repede (fișa rămâne pe 1 oră)
  if(!hasKey('anthropic')) throw new Error(vaultOn() ? 'Seiful (Worker-ul) nu are cheia Anthropic.' : 'Lipsește cheia Anthropic. Deschide Setări.');
  const res = await fetch(apiUrl('anthropic', '/v1/messages'), {method:'POST', signal, headers:apiHeaders('anthropic', {
        'content-type':'application/json', 'anthropic-version':'2023-06-01'}),
        body: safeJSON({model, max_tokens:max, stream:true,
          system:[{type:'text', text:sys, ...(conv ? {cache_control:ttl ? {type:'ephemeral', ttl:'1h'} : {type:'ephemeral'}} : {})}], messages:provMsgs(conv ? msgs : msgs.map(x => x._cache || x._cacheAt != null ? {...x, _cache:false, _cacheAt:null} : x), httl)})});
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
      if(j.type === 'content_block_delta' && j.delta?.text) piece = j.delta.text;
      else if(j.type === 'message_start' && j.message?.usage) usage = {...j.message.usage};
      else if(j.type === 'message_delta'){ if(j.usage) usage = Object.assign(usage || {}, j.usage); if(j.delta?.stop_reason) stop = j.delta.stop_reason; }
      else if(j.type === 'message_stop') ended = true;
      else if(j.type === 'error') throw new Error(j.error?.message || 'eroare de la furnizor');
      if(piece){ full += piece; onText && onText(full); }
    }
  }
  } finally { recordTokens(cid, usage, model, tag || (aux ? 'fundal' : 'chat'), 1, !aux); if(meta){ meta.stop = stop || (ended ? 'end_turn' : 'cut'); if(usage) meta.u = {cw:usage.cache_creation_input_tokens || 0, cr:usage.cache_read_input_tokens || 0}; } }
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
  const out = await stream('Ești un observator atent care descrie imagini cu precizie.', [{role:'user', text:DESC_PROMPT, image:b64}], {max:1200, aux:true, tag:'profil'});   // 9.80: pe Haiku (vede bine pozele, de ~20× mai ieftin)
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
  const out = await stream('Ești un verificator atent: compari texte cu imagini și găsești orice nepotrivire.', [{role:'user', text:ask, image:b64}], {max:1500, aux:true, tag:'profil'});   // 9.80: pe Haiku
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
  photo:'real unedited photo taken with a recent smartphone camera (about 24-26 mm equivalent lens), candid everyday snapshot, photorealistic, natural skin texture with visible pores, fine vellus hair and small imperfections, crisp detail in the eyes, eyelashes, individual hair strands and fabric weave, realistic body proportions, natural light coming from the real light sources of the place with soft realistic shadows, correct exposure without blown highlights, natural white balance matching the light source, phone-like depth of field (the subject sharp, the background only slightly softer, no creamy bokeh), slight phone-camera noise, true-to-life colors, ordinary real-life surroundings, not a professional photoshoot, no studio lighting, no retouching, no beauty filter, no plastic or waxy skin, no over-smoothing, no HDR halos, no CGI look, no text, no watermark',
  anime:'high quality anime illustration, clean lineart, soft cel shading, detailed eyes, no text',
  illustration:'polished digital illustration, painterly lighting, detailed face, no text',
  '3d':'high quality 3d render, soft global illumination, detailed face, no text'};
// 9.30: stilul spus din prima frază (la final, după „photo…”, generatorul îl ignora): doar pentru stilurile non-foto
const STIL_LEAD = {anime:'Anime-style illustration, NOT a photograph, drawn in anime style: ', illustration:'Painted digital illustration, NOT a photograph, artwork style: ', '3d':'3D-rendered CGI character image (stylized 3D animation render), NOT a photograph: '};
const stilLead = st => STIL_LEAD[st] || '';
const stilFrame = (st, p) => STIL_LEAD[st] ? String(p).replace(/\bphoto(graph)?\b/gi, 'image').replace(/\bselfie\b/gi, 'self-portrait') : p;
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
// 9.80: o singură citire în zbor pe poză (variantele în paralel o așteaptă pe aceeași)
const idInflight = new Map();
function identityOf(c, force){
  if(!c || !c.photo) return Promise.resolve(null);
  const k = c.id + '|' + c.photo + (force ? '|f' : '');
  if(idInflight.has(k)) return idInflight.get(k);
  const p = identityOf0(c, force).finally(() => idInflight.delete(k));
  idInflight.set(k, p); return p;
}
async function identityOf0(c, force){
  if(!c.photo) return null;
  const fb = c.faceBox;
  // 8.21: v3 = pașaportul complet (păr separat, semne distinctive, ochelari), citit O dată per poză de profil cu modelul principal
  if(!force && fb && fb.k === c.photo && fb.phys !== undefined && (fb.v === 5 || !aiReady() || Date.now() - (fb.at || 0) < 864e5)) return fb;   // 9.80: o citire eșuată sau incompletă se reîncearcă cel mult o dată pe zi (înainte: la fiecare poză, pe Sonnet)
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
/* ═════════ 9.50: O SINGURĂ IDENTITATE ═════════
   Cauza diferențelor: corpul ajungea la generator din până la 4 surse care se contraziceau: (a) corpul „citit” din PORTRET
   (o poză cap-umeri, unde corpul aproape nu se vede, deci e ghicit), (b) corpul citit din poza întreagă, (c) „Cum arată” din
   creator și (d) fraza-rezumat tot din portret. Fiecare drum de poză (chat Klein, chat FLUX 3, motorul vechi, poze împreună, grup,
   poza întreagă automată) le combina altfel; generatorul primea „două corpuri” și făcea o medie. Acum corpul are O SINGURĂ sursă,
   aleasă în ordinea: ce ai scris TU → creatorul (din alegerile lui s-a făcut poza întreagă) → poza întreagă (personaje cu poze încărcate) → portretul (doar dacă nu există altceva); restul se scoate.
   Fața, părul, semnele și ochelarii vin din portret. Același text ajunge pe toate drumurile. */
const BODY_WORDS = /\b(body|build|bust|chest|breasts?|waist|hips?|slim|slender|curvy|plump|chubby|heavy|overweight|thin|skinny|weight|figure|petite|tall|short|athletic|muscular|belly|stocky)\b/i;
const EN_BODY_RE = /(?:^|\.\s)Body:\s*([^]*?)(?=\.\s+[A-Z][a-z]+:|\.$|$)/;
function bodySrc(c, id){
  if(c && c.physEn && c.physAuto !== true && !EN_BODY_RE.test(c.physEn) && BODY_WORDS.test(c.physEn)) return {src:'tu', t:''};   // e deja în textul tău
  if(c && EN_BODY_RE.test(c.physEn || '')) return {src:'creator', t:''};   // cuvintele exacte de pe butoane (poza întreagă e făcută din ele)
  if(c && c.bodyFull && c.photoFull && c.bodyFull.k === c.photoFull && c.bodyFull.t) return {src:'intreaga', t:c.bodyFull.t};
  const pm = String(id && id.phys || '').match(/(?:^|; )body: ([^;]+)/);
  if(pm && !/not visible/i.test(pm[1])) return {src:'portret', t:pm[1].trim()};
  return {src:'', t:''};
}
const stripBodyPhys = t => String(t || '').replace(/(?:^|;\s*)body:[^;]*/i, '').replace(/^;\s*/, '').trim();
const stripBodyEn = t => String(t || '').replace(EN_BODY_RE, (a) => a.startsWith('.') ? '.' : '').replace(/^\.\s*/, '').trim();
function idText(c, id){
  const B = bodySrc(c, id), parts = [];
  const user = B.src === 'intreaga' || B.src === 'portret' ? stripBodyEn(c && c.physEn) : (c && c.physEn || '');
  if(B.t) parts.push('Body: ' + B.t);
  if(user) parts.push(user);
  const face = id && !id.none && id.phys ? stripBodyPhys(id.phys) : '';
  if(face) parts.push(face);
  if(id && id.glasses) parts.push('always wears ' + id.glasses);
  if(id && id.marks && id.marks.length) parts.push('permanent marks, always in the same place when visible: ' + id.marks.join('; '));
  return {t:parts.join('. ').replace(/\.\s*\./g, '.').replace(/\s+/g, ' ').slice(0, 1500), src:B.src};
}
const bodyOnly = (c, id) => { const B = bodySrc(c, id); if(B.t) return B.t; if(B.src === 'creator'){ const m = String(c.physEn || '').match(EN_BODY_RE); return m ? m[1].trim() : ''; } return B.src === 'tu' ? c.physEn : ''; };
const BODY_SRC_RO = {tu:'ce ai scris tu la „Cum arată”', intreaga:'poza întreagă', creator:'alegerile din creator (din ele s-a făcut și poza întreagă)', portret:'portret (ghicit, nu există poză întreagă)', '':'nicio sursă'};
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
  return idText(c, id).t;   // 9.50: o singură identitate (vezi idText)
  let a = id && id.phys ? id.phys : '';
  if(id && id.glasses) a += (a ? '; ' : '') + 'always wears ' + id.glasses;
  if(id && id.marks && id.marks.length) a += (a ? '. ' : '') + 'Permanent distinctive marks, always in exactly the same place whenever that part of the body is visible: ' + id.marks.join('; ');
  if(c && c.bodyFull && c.photoFull && c.bodyFull.k === c.photoFull && c.bodyFull.t) a += (a ? '. ' : '') + 'Whole body (from the full-body reference photo): ' + c.bodyFull.t;   // 9.24
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
// 9.32: personajele din creator au poza întreagă (c.photoFull): reperul de corp e decupat din ea, din creștet până la coapse,
//       ca generatorul să vadă corpul real (bust, talie, șolduri), nu doar umerii din portret. Fața rămâne din portret (reperul 1).
async function fullBodyRef(blob, b){
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight, side = Math.min(W, H);
    const fb = b && !b.none && b.w > 0 ? b : null;
    const cx = fb ? (fb.x + fb.w / 2) * W : W / 2, top = fb ? fb.y * H - fb.h * H * .5 : H * .02;
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
async function idRefs(c, shot = ''){
  const full = c.photo ? await DB.get(c.photo) : null; if(!full) return null;
  let id = null; if(aiReady()) try{ id = await identityOf(c); }catch(e){}
  const bx = id && !id.none ? id : null;
  // 8.5: pozele de referință în plus (alte unghiuri) merg ca repere 3 și 4: fața decupată din fiecare
  const extra = await extraRefs(c, shot);   // 9.83 (2): ale tale, apoi fișa de identitate (unghiurile potrivite scenei)
  let body = null, bodyFrom = 'profil';
  if(c.photoFull){ const fb = await DB.get(c.photoFull).catch(() => null); if(fb) try{ body = await fullBodyRef(fb, c.fullBox); bodyFrom = 'intreaga'; }catch(e){} }   // 9.32
  if(!body) body = await bodySquare(full, bx);
  return {full, id, face: await cropFace(full, bx), body, bodyFrom, extra};
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
// 9.50: „De ce arată așa”: ce a primit generatorul, de unde a venit corpul, cât seamănă fața și silueta
function genDiagHTML(m){
  const g = m.gen, pct = d => d == null ? '?' : idPct(d) + '%';
  const sil = m.bd != null ? Math.max(0, Math.round(100 - m.bd * 250)) + '%' : null;
  return `<details class="gdiag"><summary>🔍 De ce arată așa (ce a primit generatorul)</summary>
    <p>🖼️ ${esc(g.mdl)} · motor ${g.eng === 'id' ? 'identitate (vechi)' : g.eng === 'flux3' ? 'FLUX 3' : 'ca în creator'} · repere: ${esc(g.refs)}</p>
    <p>👤 Fața față de portret: <b>${pct(g.fd)}</b>${g.ret ? ' (după retuș)' : ''}${sil ? ` · 🧍 silueta față de poza întreagă: <b>${sil}</b>${g.bfix ? ' (refăcută o dată)' : ''}` : ''}</p>
    <p>🧍 Corpul a venit din: <b>${esc(BODY_SRC_RO[g.src] || g.src)}</b></p>
    ${(g.sheet || []).length ? `<p>🧩 Fișa de identitate: unghiurile <b>${esc(g.sheet.join(' + '))}</b> (pentru scena asta)</p>` : ''}${g.dr ? `<p>✏️ Aleasă din ${g.dr} schițe, apoi refăcută mare${g.dfd != null ? ` (schița: ${pct(g.dfd)})` : ''}</p>` : ''}${(g.fix || []).length ? `<p>🩹 Reparat doar: <b>${esc(g.fix.join(', '))}</b> (restul pozei a rămas)</p>` : ''}${g.fin ? '<p>✨ Finisată pe telefon: balans de alb, expunere, claritate fină, granulație de senzor</p>' : ''}${g.bwarn != null ? `<p>⚠️ Corpul a rămas sub prag (${g.bwarn}%), chiar după refacere.</p>` : ''}${g.tm ? `<p>⏱️ ${g.tm.total ? '<b>' + (g.tm.total / 1000).toFixed(1).replace('.', ',') + ' s</b>: ' : ''}${[['scena', 'scena'], ['schite', 'schițe'], ['variante', 'variante'], ['alegere', 'alegere'], ['final', 'poza mare'], ['retus', 'retuș'], ['verificare', 'verificare'], ['reparare', 'reparare'], ['finisare', 'finisare']].filter(([k]) => g.tm[k] > 50).map(([k, l]) => l + ' ' + (g.tm[k] / 1000).toFixed(1).replace('.', ',') + ' s').join(' · ')}${g.fast ? ' · fără verificare (deja măsurată ca bună)' : ''}</p>` : ''}${g.miss ? `<p>🎲 Ai respins varianta de dinainte pentru: <b>${esc(PFB_RO[g.miss] || g.miss)}</b></p>` : ''}${g.corr ? `<p style="color:var(--tx3);font-size:.8rem">Corectura trimisă: ${esc(g.corr)}</p>` : ''}
    ${g.pf != null && g.pf > FACE_OK ? `<p>⚠️ Portretul și poza întreagă nu par aceeași față (${pct(g.pf)}). Pozele din chat iau fața din portret. Dacă vrei fața din poza întreagă, deschide-o și apasă „👤 Față”.</p>` : g.pf != null ? `<p>✅ Portretul și poza întreagă: aceeași față (${pct(g.pf)})</p>` : ''}
    <p style="color:var(--tx3);font-size:.8rem;line-height:1.45">${esc(g.look)}</p></details>`;
}
// expresia: cea obișnuită (din poza de profil), în afară de cazul în care ai cerut tu alta în conversație
const EXPR_ASK = 'Facial expression requested: ';
const exprLine = (c, shot, id) => String(shot || '').includes(EXPR_ASK) ? 'EXPRESSION — use the facial expression requested in the scene description.'
  : 'EXPRESSION — the character always has the same facial expression as in the reference photo' + (id && id.expr ? ': ' + id.expr : '') + '. Copy that expression exactly.';
// 8.24: trăsăturile definitorii (corp, ten, păr) chiar la începutul promptului, unde generatorul le dă cea mai mare greutate
const subjLine = (c, id) => { const s0 = id && id.subj && ['portret', ''].includes(bodySrc(c, id).src) ? id.subj : (id && id.subj ? String(id.subj).replace(BODY_WORDS, '').split(',')[0] : ''); const u = c && c.physEn ? c.physEn.split(/\s+/).slice(0, 30).join(' ') : ''; return s0 || u ? ' The person: ' + [s0, u].filter(Boolean).join('; ') + '.' : ''; };
const NO_BEAUTY = 'Do NOT beautify or idealize: same age, same weight and body shape, same skin texture, spots and under-eye shadows, same face width; no slimming, no smoothing, no younger look.';
// 9.1: modelul pentru o poză: în chat = „Fidelitatea feței”; stories și statusuri pot avea setarea lor (Eco, mai ieftin)
const isAuto = opt => !!opt && (opt.tag === 'stories' || opt.tag === 'statusuri');
// 9.6: cu o limită zilnică („Doar gratuit” / „Max $0,10”), 9B merge cât încape o poză întreagă plus o rezervă pentru Eco;
//      apoi pozele trec singure pe Eco (cu retușul feței și variante) până la resetare, în loc să se oprească sau să coste
const ECO_RESERVE = 600;
const nineFits = () => rwFor('ancorat') || !Number.isFinite(capLeft()) || capLeft() >= (neurPerPhoto('ancorat') || 1455) + ECO_RESERVE;
const sceneModel = (opt = {}) => { const m = isAuto(opt) && S.autoModel === 'eco' ? 'eco' : (S.wkChat || 'eco'); return m === 'ancorat' && S.imgProv === 'worker' && !nineFits() ? 'eco' : m; };
function nineDegradedNote(opt){
  if(S.wkChat !== 'ancorat' || S.imgProv !== 'worker' || nineFits() || (isAuto(opt) && S.autoModel === 'eco')) return;
  const d = new Date().toISOString().slice(0, 10); if(S.degDay === d) return;
  S.degDay = d; saveSettings();
  toast(`Cota gratuită de azi nu mai ajunge pentru 9B: pozele continuă pe Eco (cu retușul feței) până la ${resetAt()}, fără cost.`, 6000);
}
function idPrompt(c, shot, fr, R, fix, two){
  const phys = physFull(c, R && R.id) ? ` Permanent physical traits (exactly as in the reference): ${physFull(c, R && R.id)}.` : '';
  const requestedBodyChange = /(?:bust|breasts?|chest|s[âa]nii?|ț[âa]țele)[^.!?]{0,45}(?:mai mare|larger|bigger|increase|mai mic|smaller|reduce|mai proeminent|more prominent)|(?:mai mare|larger|bigger|increase|mai mic|smaller|reduce|mai proeminent|more prominent)[^.!?]{0,45}(?:bust|breasts?|chest|s[âa]nii?|ț[âa]țele)/i.test(String(shot || ''));
  const bodyChangePriority = requestedBodyChange ? ' USER-REQUESTED BODY CHANGE OVERRIDE: this scene explicitly requests a change to bust size. Apply the requested increase or decrease clearly to the bust only; the body reference is a baseline, not a constraint against this explicit change. Keep the face, age, hair, waist, hips and all other unrequested traits unchanged.' : ' Do not reduce a prominent bust, slim the torso, widen/narrow the waist, or otherwise idealize, enlarge, shrink or redesign the body.';
  const nx = two && R && R.extra ? R.extra.length : 0;
  const refs = two
    ? 'image 1 is a close-up of the face (the exact identity to keep: face shape, eyes, eyebrows, nose, lips, skin tone and skin texture), ' + (R && R.bodyFrom === 'intreaga' ? 'image 2 shows the same person\'s exact body: build, weight, bust size and shape, waist, belly, hips, arms and legs, plus hair and skin tone; reproduce that body exactly, but NOT its clothes, pose or background' : 'image 2 is the best available body reference: preserve the exact visible build and proportions, especially bust size and shape, shoulders, waist, hips and overall silhouette; do not shrink or idealize the body') + (nx ? `, image${nx > 1 ? 's 3 and 4 are' : ' 3 is'} the same face from other angles` : '')
    : 'image 1 is the same person (face and hair); image 2 is the body reference and defines the exact visible build and proportions, especially bust size and shape, shoulders, waist, hips, and overall silhouette';
  return `${stilLead(c.stil)}${fr.p}. ${shot}.${fix ? ` Important corrections from the previous attempt: ${fix}.` : ''} IDENTITY LOCK — the reference images define one specific character, not a lookalike. Reproduce the same individual: preserve face shape, eye spacing and shape, eyebrows, nose, lips, jaw, apparent age, skin tone and texture, hairline, hair color, curl/strand texture and hairstyle. BODY IDENTITY LOCK — match the body reference, not a generic default body. Preserve the same visible body build and proportions, including the exact relative bust size and shape, shoulders, waist, hips, belly, arms and legs. ${bodyChangePriority} ${refs}.${phys} SCENE FLEXIBILITY — do not copy the reference photo's background, outfit, pose, expression, camera angle or framing. Those are allowed to change and must follow the current scene description above. Change only temporary details required by the scene; the character's identity and natural body proportions stay fixed. ${STIL_TAG[c.stil || 'photo']}`;
}
// încadrarea scrisă explicit la început (altfel modelul copiază încadrarea referinței)
function framingOf(shot){
  const t = String(shot || '').toLowerCase();
  if(/close[- ]?up|headshot|face only|portrait of (her|his) face|prim[- ]plan/.test(t)) return {k:'close', p:'Close-up selfie, head and shoulders, phone held at arm\'s length'};
  // 9.27: stă jos sau e întinsă (canapea, pat, fotoliu, scaun): selfie de aproape, cu locul pe care stă bine vizibil, nu oglindă
  const seated = /\b(sitting|seated|lying|lies|reclining|curled up|on the (sofa|couch|bed|armchair|chair|floor)|in bed)\b/.test(t);
  if(seated && !/propped|timer|tripod|self-timer/.test(t)) return {k:'mid', p:'Arm\'s-length selfie taken with the phone held slightly above, the character sitting or lying exactly as described, framed from the head down to the thighs, the sofa, bed or chair she is on and the room around clearly visible'};
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
/* 9.33: cererea ta de poză e respectată punct cu punct. Mesajele tale de după ultima poză (cel mult 3), dacă unul cere o poză,
   ajung la planificator cuvânt cu cuvânt, cu prioritate peste starea scenei; el le desface în detalii („asked”), aplicația
   verifică să fie toate în descriere (altfel le adaugă la început), iar verificarea pozei le punctează separat și reface poza
   dacă lipsesc. Regulile de siguranță rămân cum erau. */
const PHOTO_ASK = /(?:poz[ăaeiă]|pozez|pozeaz|fotografi|(?<!\p{L})foto(?!\p{L})|selfie|vreau s[ăa] te v[ăa]d|vreau s[ăa] v[ăa]d cum ar[ăa]ți|ar[ăa]t[ăa]-?mi cum|f[ăa]-?[țt]i o|trimite-?mi o|trimite-?mi|d[ăa]-?mi o poz|ar[ăa]t[ăa]-?mi|arat[ăa]-?ți|s[ăa]-?mi ar[ăa]ți|s[ăa]-?ți v[ăa]d|vreau[^.!?]{0,40}s[ăa]-?mi ar[ăa]ți|vreau[^.!?]{0,40}s[ăa]-?ți v[ăa]d|vreau s[ăa] [îi]mi trimiți|dezbrac[ăa]-?te|scoate-?ți hainele|f[ăa]r[ăa] haine|nud[aă]?|goal[ăa]|gol complet|topless|bare breasts|bare chest|without a top|shirtless|genital(?:ia)?|genitals|vulva|vagina|penis|p[aă]r[țt]i intime|organe genitale|nuditate explicit[ăa]|explicit nude|f[ăa]r[ăa] sutien|(?:vreau|aș vrea|pot s[ăa]|las[ăa]-?m[ăa] s[ăa])[^.!?]{0,65}(?:poz[ăa]|fotografi|selfie|s[âa]nii?|ț[âa]țele|t[âa]țele|bustul|pieptul|corp(?:ul)?|nud[aă]?|goal[ăa]|dezbr[aă]cat|topless|sutien)|(?:s[âa]nii?|ț[âa]țele|t[âa]țele|bustul|pieptul)[^.!?]{0,40}(?:goi|goale|gol|dezbr[aă]cat|nud|ar[ăa]t|v[ăa]d|poz[ăa]|fotografi|la vedere|f[ăa]r[ăa] sutien))/iu;
// Clasifică expunerea cerută fără a transforma o cerere de bust gol într-o nuditate integrală.
function exposureMode(text){
  const t = String(text || '');
  // Clasificare separată pentru nuditate anatomică explicită; numai pentru personaje adulte confirmate.
  // Nu echivalează o cerere de topless cu nuditate integrală.
  if(/(?:explicit nude|explicit nudity|nuditate explicit[ăa]|genital(?:ia)?|genitals|external genital|visible genitals|vulva|vagina|penis|organe genitale|p[aă]r[țt]i(?:le)? intime(?: la vedere)?)/i.test(t)) return 'explicit';
  if(/(?:fully nude|completely naked|fully naked|nude|naked|unclothed|without clothes|no clothes|fully undressed|nudity|nuditate|nud[aă]|goal[ăa]|dezbr[aă]cat[ăa]?|scoate-?ți hainele|dezbrac[ăa]-?te|complet goal[ăa]|f[ăa]r[ăa] nimic pe tine|f[ăa]r[ăa] haine|f[ăa]r[ăa] [îi]mbr[aă]c[aă]minte)/i.test(t)) return 'full';
  if(/(?:topless|bare breasts|bare chest|without a top|shirtless|f[ăa]r[ăa] sutien|s[âa]nii? goi|ț[âa]țele goale|t[âa]țele goale|bustul gol|pieptul gol|s[âa]nii? la vedere|bustul la vedere|ar[ăa]t[ăa]-?mi s[âa]nii?|arat[ăa]-?mi bustul|poz[ăa][^.!?]{0,30}(?:s[âa]nii?|bustul|pieptul)[^.!?]{0,25}(?:gol|goi|goale|f[ăa]r[ăa] sutien))/i.test(t)) return 'topless';
  return 'clothed';
}
function clearlyAdultCharacter(c){
  const t = [c && c.name, c && c.persona, c && c.look, c && c.aspect, c && c.physEn].filter(Boolean).join(' ');
  return /\b(adult[aă]?|18\s*(?:\+|ani|years? old)|19\s*(?:ani|years? old)|[2-9]\d\s*(?:ani|years? old)|\d{2}\s+(?:de\s+)?ani|(?:18|[2-9]\d)[ -]year[ -]old|(?:in her|in his)\s+(?:20s|30s|40s|50s|60s|70s|80s|90s)|femeie de \d{2} de ani|b[ăa]rbat de \d{2} de ani)\b/i.test(t);
}
function photoAsk(ch, exclude){
  const ms = ch.msgs.filter(x => x !== exclude && !x.err && !x.pending && !x.pendingImg);
  let i = ms.length - 1; while(i >= 0 && !(ms[i].role === 'ai' && ms[i].img)) i--;
  const us = ms.slice(i + 1).filter(x => x.role === 'user' && x.text).slice(-5);
  if(!us.some(x => PHOTO_ASK.test(x.text))) return '';
  return us.map(x => (x.reply ? '(replying to: „' + x.reply.text + '”) ' : '') + x.text.trim()).join(' / ').slice(0, 900);
}
// cuvintele importante dintr-un detaliu cerut („red dress” → red, dress): lipsește din descriere dacă niciunul nu apare
const askMissing = (asked, shot) => { const t = String(shot || '').toLowerCase(); return (asked || []).filter(a => { const w = String(a).toLowerCase().match(/[a-z]{4,}/g) || []; return w.length && !w.some(x => t.includes(x.replace(/(ing|ed|es|s)$/, ''))); }); };
async function planShot(c, ch, {promised = '', exclude = null, signal, together = false} = {}){
  pstage(signal, '🎬 Își alege locul și cadrul', 22);
  const u = S.userName.trim() || 'User';
  const hist = ch.msgs.filter(x => x !== exclude && x.text && !x.err && !x.pending);
  const acts = t => (t.match(/\*[^*]+\*/g) || []).join(' ');
  const recent = hist.slice(-16).map(x => (x.role === 'user' ? u : c.name) + ': ' + plain(stripMood(x.text)).slice(0, 600) + (acts(x.text) ? ' [actions: ' + acts(x.text) + ']' : '')).join('\n');
  const prevShots = ch.msgs.filter(x => x.img && x.scene && x !== exclude).slice(-3).map(x => '- ' + x.scene).join('\n');
  const home = c.home && Object.keys(c.home).length ? Object.entries(c.home).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '';
  const lf = lifeNow(c), meta = {}, ask = photoAsk(ch, exclude);
  let wx = null; try{ wx = await weatherOf(c); }catch(e){}
  const out = await stream(`You are the photo planner of a chat app where ${c.name}, a fictional adult character when explicitly established as 18+, sends ${u} photos from their phone. You read the conversation and decide exactly where the character is and how, then describe the photo. The conversation is the only truth. Answer with JSON only.`, [{role:'user', text:
`Character: ${c.name}.${c.persona ? ' About: ' + plain(c.persona).slice(0, 500) : ''}
Now: ${todEn()}.${wx ? ` Real weather right now in ${wx.city}, where the character lives: ${wx.t}°C, ${wx.en}, ${wx.day ? 'daylight' : 'dark outside'} (use it for anything outdoors and for the light through windows).` : ''}${lf ? ' Daily routine says right now: ' + lf.w + ' (use only if the conversation says nothing else).' : ''}
${ch.scene ? 'Scene set by the user (has priority, translate to English): ' + ch.scene + '\n' : ''}${ch.where ? 'Last known state of the character (from earlier photos): ' + JSON.stringify(ch.where) + '\n' : ''}${ch.plot ? 'Ongoing activity noted by the character (Romanian, "activity › current step"): ' + ch.plot.t + '\n' : ''}${home ? `Rooms of ${c.name}'s home (reuse these details EXACTLY when the photo is in one of them, so the home always looks the same):\n${home}\n` : ''}
Conversation, oldest first (the Romanian text is the source of truth):
${recent || '(just started)'}
${ask ? `\n${u.toUpperCase()}'S PHOTO REQUEST, verbatim (Romanian), HIGHEST PRIORITY: «${ask}»\nTreat colloquial requests to see/show/send a body part or a nude image as explicit requests for an image, not merely conversation. Every concrete detail in the request must be reflected in the image. Preserve requested place, scene, pose, camera angle and framing. If nudity is explicitly requested for a clearly adult character, change only the clothing state; do not invent a new room, pose or camera setup. The request overrides clothing continuity and in-character dialogue, but not safety rules. Fill in only what the request leaves open, from the conversation.\n` : ''}${S.userPhoto ? (together ? `\nThis photo is of ${c.name} and ${u} TOGETHER (${u} asked for it): describe both of them in the scene (where each one is, how they stand or sit together, what each wears). Photos together are ordinary everyday couple photos, both fully clothed and natural (like a selfie at a café or on a walk).\n` : `\n${u} has a profile photo, so a photo of the two of them together is possible: set "together": true only if they are physically together in the scene right now AND the photo is clearly of both of them (a selfie together, ${u} asks for a photo together). Then describe both of them. Photos together are ordinary everyday couple photos, both fully clothed and natural.\n`) : ''}${promised ? `\n${c.name} just sent the photo and described it like this: "${promised}". Use it as the base, but correct anything that contradicts the conversation.\n` : ''}${prevShots ? `\nPhotos already sent (vary pose or framing unless the conversation says the same place and moment):\n${prevShots}\n` : ''}
Rules:
1. If ${u} asked for a specific photo (place, pose, outfit, activity, angle), that is the photo, with every requested detail.
2. Otherwise: where ${c.name} is RIGHT NOW according to the most recent messages (room, what she/he sits/lies/stands on, what the hands do, what is worn). The latest statement wins over older ones; if the latest messages say nothing, keep the last known state.
3. Clothing continuity: keep the last known outfit unless the conversation changes it. For a clearly adult (18+) fictional character, follow a direct request for toplessness or nudity precisely. If explicit anatomical nudity is requested, describe visible external adult anatomy plainly and non-graphically only when the selected image provider permits it; do not substitute underwear, towels, strategically placed objects, or clothing. Never depict nudity for minors or characters whose age is ambiguous. Do not bypass provider moderation or retry a blocked sexual request through another provider.
4. The character is alone unless the conversation says someone is with them, so the camera is: "selfie", "mirror selfie", or "phone propped up with timer" (for full-body shots without a mirror). Never "photo taken by someone" when alone, unless ${u} asks for it.
4b. The photo must show EXACTLY the current moment of the latest messages: the same place and room, the same piece of furniture the character is on (e.g. on the sofa, in bed, at the kitchen table), the same body position, the same activity and the objects in the hands. The camera must fit that position: sitting or lying (sofa, bed, armchair, chair, floor) = "selfie" taken from arm's length (or "phone propped up with timer" for the whole body), never "mirror selfie"; "mirror selfie" only when the character is standing and a mirror fits the place.
5. Default to showing the body (selfie down to the thighs, timer shot, or a mirror selfie when standing); "close-up selfie" only if the face is asked for.
6. Light must match the time of day and the place (at night indoors: lamps, warm and a bit dim).
7. Make it look like a real, ordinary moment: real furniture and objects, a bit of everyday mess, nothing staged.
8. Never describe the face, hair, skin or body shape (they come from the reference photo). Describe only place, pose, clothes, expression, light.
10. Other people: if ${u} asks for a photo of someone ${c.name} talks about (a friend, sister, colleague, ex, neighbour…), or of ${c.name} together with that person, list them in "people" (name or relation, and what the conversation says about how they look). "self" is false when the photo shows only that person, true when ${c.name} is in it too. Then "shot" describes the photo with that person by name (and ${c.name} only if self is true). Other people are always adults, fully clothed, in an ordinary everyday photo. If ${u} asks for a photo of ${c.name} alone, "people" is [] and "self" is true.
9. If the photo is in a room of the home that is not in the list above, invent its look once (concrete: colors, furniture, window, floor) consistent with the character and the conversation, and return it in "home". Also return in "home" any NEW concrete detail of a room that the conversation revealed.

JSON, keys in exactly this order, nothing else:
{"self":true,"people":[],
 ${ask ? '"asked":["each concrete detail of the photo request as a short English phrase, e.g. \"red dress\", \"on the balcony\", \"from behind\""],\n ' : ''}"camera":"selfie | mirror selfie | phone propped up with timer | close-up selfie",${S.userPhoto ? '\n "together":false,' : ''}
 "shot":"ONE English description for the image generator, 50-80 words: camera and framing, the place with concrete details (reuse the room description), body position and hands, outfit, expression, light",
 "where":{"place":"home / office / café / street …","room":"bedroom | living room | kitchen | bathroom | hallway | balcony | office | other","position":"exact body position and what it rests on","outfit":"what is worn now","activity":"what is being done","light":"light now"},
 "home":{"<room>":"English description, max 45 words; only rooms that are new or changed"}}`}], {max:1500, signal, cid:c.id, aux:true, meta, tag:'pozeai'});
  // 7.1: refuzul filtrului lui Claude se spune ca atare (nu se ocolește); un răspuns tăiat sau fără JSON nu mai oprește poza
  if(meta.stop === 'refusal' && !promised) throw new Error('Claude a refuzat să descrie poza asta (filtrul lui de siguranță). Încearcă altă scenă.');
  let j = {}; try{ j = parseJSON(out); }catch(e){}
  if(!j.shot){ const mm = String(out).match(/"shot"\s*:\s*"((?:[^"\\]|\\.)*)/); if(mm) j.shot = mm[1].replace(/\\"/g, '"'); }
  if(!j.camera){ const mm = String(out).match(/"camera"\s*:\s*"([^"]*)"/); if(mm) j.camera = mm[1]; }
  let shot = String(j.shot || promised || '').trim().replace(/^["„]|["”]$/g, '').replace(/[.\s]+$/, '');
  const asked = ask && Array.isArray(j.asked) ? j.asked.map(x => String(x || '').replace(/["\n]/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 10) : [];   // 9.33
  { const miss = askMissing(asked, shot); if(miss.length && shot) shot = `As requested: ${miss.join(', ')}. ${shot}`; }
  const planned = shot;   // 9.43: descrierea planificatorului (pozele cu alte persoane o folosesc pe aceasta)
  // 9.23: cererea explicită a utilizatorului pentru nuditate trebuie să ajungă în promptul imaginii;
  // un refuz în dialog sau ținuta anterioară nu trebuie să transforme automat scena într-o poză îmbrăcată.
  // 9.38: nuditatea este determinată de cererea recentă care a declanșat fotografia, nu de orice mesaj vechi din istoric.
  // Se păstrează scena/poziția/încadrarea planificate; se suprascrie doar continuitatea vestimentară.
  const nudeRequestText = String(ask || '');
  const exposure = exposureMode(nudeRequestText);
  const userAskedNude = exposure === 'full';
  const userAskedTopless = exposure === 'topless';
  const ageText = String(c.persona || '') + ' ' + String(c.look || '') + ' ' + String(c.aspect || '') + ' ' + String(c.name || '');
  const adultKnown = /\b(adult[aă]?|18\s*(?:\+|ani|years? old)|19\s*(?:ani|years? old)|[2-9]\d\s*(?:ani|years? old)|\d{2}\s+(?:de\s+)?ani|(?:18|[2-9]\d)[ -]year[ -]old|(?:in her|in his)\s+(?:20s|30s|40s|50s|60s|70s|80s|90s)|femeie de \d{2} de ani|b[ăa]rbat de \d{2} de ani)\b/i.test(ageText);
  if(userAskedNude && adultKnown){
    shot = `PRIORITY CLOTHING OVERRIDE: the clearly adult fictional character is fully nude, with no clothes, underwear, lingerie, towel, or object covering the body; natural, non-explicit artistic nudity, no sexual act. Preserve the exact scene, room, furniture, body position, activity, camera angle, framing, expression and lighting described here; change only the clothing state to fully nude. Keep the same body proportions and bust size as the body reference. Do not substitute a clothed image. SCENE TO PRESERVE: ${shot}`;
  } else if(userAskedTopless && adultKnown){
    shot = `PRIORITY CLOTHING OVERRIDE: the clearly adult fictional character is topless, with bare breasts visibly uncovered and no shirt, bra, bikini top, towel, or object covering the chest. Keep the lower body clothed exactly as the scene describes; do NOT make the character fully nude unless that was explicitly requested. Preserve the exact scene, room, furniture, body position, activity, camera angle, framing, expression and lighting. Keep the same body proportions and bust size as the body reference. Do not substitute a clothed or lingerie image. SCENE TO PRESERVE: ${shot}`;
  }
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
  const people = Array.isArray(j.people) ? j.people.map(x => ({name:String(x && x.name || '').trim().slice(0, 40), relation:String(x && x.relation || '').trim().slice(0, 60), look:String(x && x.look || '').trim().slice(0, 300)})).filter(x => x.name || x.relation).slice(0, 2) : [];
  return {people, self: j.self !== false, planned: planned.length >= 15 ? planned : shot, asked, shot: cam && !shot.toLowerCase().includes(cam.toLowerCase().split(' ')[0]) ? cam + ', ' + shot : shot, where: ch.where, together: !!S.userPhoto && (together || j.together === true || /"together"\s*:\s*true/.test(out))};
}
/* ───────── 9.42: motorul „ca în creator” pentru pozele din chat (S.photoEngine = 'creator', implicit) ─────────
   De ce: în chat, generatorul primea până la 4 imagini de model (fața, corpul, unghiurile) și ~250 de cuvinte de reguli care
   „blocau” coafura, corpul și aspectul „peste orice altceva”; FLUX.2 klein copia din imagini ținuta, poziția și cadrul, iar
   regulile bateau cererea ta. În creator, unde merge, generatorul primește textul și cel mult fața decupată.
   Acum, ca în creator: (1) cererea ta e prima în prompt, apoi cadrul și scena; (2) o singură imagine de model, fața decupată
   (mică, nu poate impune haine sau cadru); (3) aspectul personajului (corp exact, față, păr, semne) ca text, „permanent, în afară
   de ce schimbă cererea”; (4) fața e apoi măsurată în telefon și retușată dacă s-a îndepărtat; (5) dintre variante rămâne cea
   cu fața apropiată ȘI care respectă cererea (un singur apel Haiku pentru toate); (6) fără potrivirea de corp de după.
   Motorul vechi rămâne: Setări → Poze → „Motorul pozelor: Identitate maximă (vechi)”. */
function lookText(c, id){
  return idText(c, id).t.slice(0, 1400);   // 9.50
  const p = [];
  if(c.physEn) p.push(c.physEn);
  if(id && !id.none && id.phys){ let t = String(id.phys).replace(/(?:^|; )body: not visible/i, ''); if(/\bBody:/.test(c.physEn || '')) t = t.replace(/(?:^|;\s*)body:[^;]*/i, ''); p.push(t); }   // 9.43: corpul din „Cum arată” e singurul
  if(c.bodyFull && c.photoFull && c.bodyFull.k === c.photoFull && c.bodyFull.t) p.push('whole body: ' + c.bodyFull.t);
  if(id && id.glasses) p.push('wears ' + id.glasses);
  if(id && id.marks && id.marks.length) p.push('permanent marks, always in the same place when visible: ' + id.marks.join('; '));
  return p.filter(Boolean).join('. ').replace(/\s+/g, ' ').slice(0, 1400);
}
async function creatorScene(c, shot, signal, fix, opt, full, id, fr){
  const st = c.stil || 'photo', model = S.wkChat || (S.wkModel === 'eco' ? 'ancorat' : S.wkModel);
  const asked = (opt.asked || []).filter(Boolean);
  const face = await cropFace(full, id && !id.none ? id : null);
  const exposure = exposureMode(shot);
  const nude = exposure === 'explicit' ? ' The fictional character is clearly an adult (18+), fully nude with visible external genital anatomy as requested; anatomically plausible and non-graphic, not a sexual act. Generate only if the selected image provider permits it.' : exposure === 'full' ? ' The character is clearly an adult (18+); natural, non-explicit artistic nudity, not a sexual act.' : exposure === 'topless' ? ' The character is clearly an adult (18+) and is topless as requested; bare breasts visible, no shirt or bra, lower-body clothing stays as described. Do not turn this into full nudity.' : '';
  // 9.53: pentru cereri explicite de bust gol/nuditate, adaugă un reper separat de corp.
  // Pozele îmbrăcate rămân pe fluxul existent cu o singură referință, ca să nu afectăm scena sau hainele.
  let bodyRef = null;
  if(exposure !== 'clothed'){
    try{
      if(c.photoFull){ const fb = await DB.get(c.photoFull).catch(() => null); if(fb) bodyRef = await fullBodyRef(fb, c.fullBox); }
      if(!bodyRef) bodyRef = await bodySquare(full, id && !id.none ? id : null);
    }catch(e){ bodyRef = null; }
  }
  const bustChange = /(?:bust|breasts?|chest|s[âa]nii?|ț[âa]țele)[^.!?]{0,45}(?:mai mare|larger|bigger|increase|mai mic|smaller|reduce|mai proeminent|more prominent)|(?:mai mare|larger|bigger|increase|mai mic|smaller|reduce|mai proeminent|more prominent)[^.!?]{0,45}(?:bust|breasts?|chest|s[âa]nii?|ț[âa]țele)/i.test(String(shot || ''));
  const bodyLock = bustChange
    ? ' USER-REQUESTED BODY CHANGE OVERRIDE — the current request explicitly changes the bust size. Apply that change clearly and visibly to the bust only, following the requested direction; the current body reference is the starting point, not a constraint against this requested change. Keep the same face, age, hair, skin, body build, waist, hips, pose and scene unless separately requested. Do not silently ignore the requested bust change. Preserve believable anatomy and natural gravity. Image 2 defines identity and baseline anatomy, but the explicitly requested bust-size change takes priority for this feature only; do not copy its clothing, pose, framing or background.'
    : exposure !== 'clothed'
      ? ' BODY-PROPORTION PRIORITY — MATCH THE PROFILE SCALE, NOT AVERAGE ANATOMY: the body reference is the source of truth for this character’s bust size. Match its apparent volume, forward projection, width, fullness and lower contour relative to the ribcage, shoulders and waist. Preserve the same distinctly large or very large scale when shown in the reference; do not downsize, flatten, lift, narrow, minimize or normalize it. Make that established volume clearly readable in the requested image through accurate anatomy, unobstructed visibility and scene-appropriate framing—not by inventing a larger body than the reference. NATURAL HUMAN ANATOMY: believable tissue weight and gravity, naturally varied contours, gradual transition into the chest wall, subtle left-right asymmetry, and shape that responds to posture and camera perspective. Avoid rigid spherical forms, hard edges, mirrored symmetry or an unnaturally fixed high position. Realism must not be used as a reason to reduce the reference size. Image 2 defines body anatomy and proportions only, never clothing, pose, camera framing or background.'
      : '';
  // 9.85 (1): și la pozele cu haine, corpul vine dintr-o poză (întreagă sau din fișa de corp, după poziție), nu doar din text
  let clothedBody = null;
  if(!bodyRef && exposure === 'clothed' && st === 'photo' && fr.k !== 'close'){ try{ clothedBody = await bodyRefFor(c, shot); }catch(e){ clothedBody = null; } }
  // 9.83 (2): scena cere un unghi pe care portretul nu-l arată (profil, zâmbet larg) → și unghiul din fișa de identitate
  let angRef = null, angName = '';
  if(!bodyRef && st === 'photo'){ const pk = sheetPick(c, shot, 1)[0], t = String(shot || '');
    if(pk && ((pk.ang === 'side' && /\b(side view|profile|from the side|looking (away|out)|turned away|over (her|his|the) shoulder)\b/i.test(t)) || (pk.ang === 'smile' && /\b(laugh\w*|smil\w*|grin\w*|teeth)\b/i.test(t)))){
      const b = await DB.get(pk.k).catch(() => null); if(b){ angRef = await cropFace(b, pk.box); angName = pk.ang === 'side' ? 'seen in side profile' : 'smiling widely with teeth showing'; } } }
  const faceInstruction = clothedBody
    ? `Image 1 is a close-up of ${c.name}'s face: keep exactly this face and identity (face shape, eyes, eyebrows, nose, lips, skin tone and texture, age). Image 2 shows ${c.name}'s whole body: reproduce exactly the same body, with the same build, weight, height impression and proportions of shoulders, chest, waist, hips, arms and legs; do NOT copy its clothing, pose, framing, background or light, which come only from this text.${angRef ? ` Image 3 is the same person's face ${angName}: use it for how the face looks from that angle or with that expression.` : ''}`
    : angRef
    ? `Image 1 is a close-up of this person's face only: keep exactly this face and identity (face shape, eyes, eyebrows, nose, lips, skin tone and texture, age). Image 2 is the same person's face ${angName}: use it for how this face looks from that angle or with that expression. Everything else comes from this text, not from the references.`
    : bodyRef
    ? `Image 1 is the exact face reference for ${c.name}; preserve the same facial identity. Image 2 is the body/proportion reference for ${c.name}; preserve the same build and silhouette, especially bust size and shape, but do not copy its clothing, pose, framing or background.`
    : 'The reference image is a close-up of this person’s face only: keep exactly this face and identity (face shape, eyes, eyebrows, nose, lips, skin tone and texture, age); everything else comes from this text, not from the reference.';
  const prompt = `${stilLead(st)}${asked.length ? `REQUESTED, must be clearly visible: ${asked.join('; ')}. ` : ''}${stilFrame(st, fr.p)}. ${shot}.${fix ? ` Corrections from the previous attempt: ${fix}.` : ''}${nude}${faceInstruction}${bodyLock} The person, permanent look unless the request above changes something: ${lookText(c, id) || 'as in the reference'}. ${NO_BEAUTY} ${STIL_TAG[st]}`;
  if(useF3()){   // 9.43/9.53: FLUX 3 folosește fața + reperul de corp și prioritizează proporțiile bustului la cereri topless/nud
    const fb = c.photoFull ? await DB.get(c.photoFull).catch(() => null) : null;
    const body = bodyRef || (fb ? await fullBodyRef(fb, c.fullBox) : null);
    const face2 = await cropFace(full, id && !id.none ? id : null);
    const p3 = `${stilLead(st)}${asked.length ? `REQUESTED, must be clearly visible: ${asked.join('; ')}. ` : ''}${stilFrame(st, fr.p)}. ${shot}.${fix ? ` Corrections from the previous attempt: ${fix}.` : ''}${nude} Image 1 is ${c.name}'s face: keep her face exact, the same face shape, eyes, nose, lips, skin tone and texture, and any marks.${body ? ` Image 2 is ${c.name}'s body reference: match the profile reference's actual bust scale precisely: preserve its apparent volume, forward projection, width and fullness relative to shoulders, ribcage and waist. If it is very large/prominent in the reference, keep it equally large/prominent and clearly visible in the requested framing; never normalize, flatten, narrow or reduce it. Do not exaggerate beyond the reference. Do not copy the reference clothes, pose or background.` : ''} ${c.name}, permanent look unless the request above changes something: ${lookText(c, id) || 'as in image 1'}. Everything else (place, outfit, pose, framing, light) comes from this text. ${STIL_TAG[st]}`;
    let b3 = await f3Image(p3, [face2, body], S.wkSize, signal), ret = false;
    // 9.50: și pe FLUX 3 fața se măsoară în telefon și se retușează dacă s-a îndepărtat (înainte, pe FLUX 3 nu se verifica)
    if(st === 'photo' && rwReady()){
      const lf = await localFace(b3, c);
      if(lf.d != null && lf.d > FACE_OK){ try{ const r = await retouchBest(c, b3, signal, 'ancorat', shot, 'retus'); if(r && r.used){ b3 = r.blob; ret = true; addUsage(c.id, imgPrice(), 'img', null, 'retus'); } }catch(e){ if(e.name === 'AbortError') throw e; } }
    }
    return {prompt:p3, blob:b3, engine:'flux3', refs:body ? 'față + corp' : 'față', retouched:ret};
  }
  const genOpt = bodyRef
    ? {model, one:face, p1:prompt, why:opt.why || 'chat', size:opt.size} // încearcă față + corp; la eroare revine automat la față, nu pierde identitatea
    : {model, force:{two:false, px:512}, p1:prompt, why:opt.why || 'chat', size:opt.size};   // 9.83: size = schița, când e cazul
  const genOpt2 = {...(clothedBody ? {model, one:face, p1:prompt, why:opt.why || 'chat', size:opt.size, extra:angRef ? [angRef] : [], px2:768}
    : angRef ? {model, force:{two:true}, p1:prompt, why:opt.why || 'chat', size:opt.size} : genOpt), multi:opt.multi || 0};
  let blob = await genImage(prompt, face, signal, clothedBody ? clothedBody.blob : angRef || bodyRef, genOpt2);
  const refsTxt = ['față', clothedBody && 'corp: ' + BSHEET_RO[clothedBody.pose], angRef && 'unghi din fișă (' + angName + ')'].filter(Boolean).join(' + ');
  if(Array.isArray(blob)) return {prompt, blob:blob[0], blobs:blob, engine:'creator', refs:refsTxt};   // 9.86: schițele, toate deodată
  // fața: dacă s-a îndepărtat de personaj, retușul obișnuit (doar fața; cadrul și hainele rămân); cu „identitate maximă” îl face idBoost
  if(st === 'photo' && !idBoostOn(c, opt)){
    const lf = await localFace(blob, c);
    if(lf.d != null && lf.d > .45){ try{ const r = await retouchBest(c, blob, signal, model, shot, 'retus'); if(r && r.used){ blob = r.blob; addUsage(c.id, imgPrice(), 'img', null, 'retus'); } }catch(e){ if(e.name === 'AbortError') throw e; } }
  }
  return {prompt, blob, engine:'creator', refs:refsTxt};
}
// cât respectă fiecare variantă cererea și scena (un singur apel, toate pozele deodată)
async function adhScores(c, list, shot, asked, signal){
  try{
    const imgs = []; for(const x of list) imgs.push(await blobToB64(await toJpeg(x.blob, 512, .82)));
    const out = await stream('You compare generated photos with a request. Answer with JSON only.', [{role:'user', images:imgs, text:
`Each of the ${list.length} images should show: "${String(shot).slice(0, 900)}".${asked && asked.length ? ` The user explicitly asked for: ${asked.join('; ')}.` : ''}
For each image, in order, score 0-10 how well it matches the request and the scene (requested details first, then place, outfit, pose, framing, activity). Ignore who the person is.
JSON: {"s":[${list.map(() => '0').join(',')}]}`}], {max:120, signal, cid:c.id, aux:true, tag:'pozeai'});
    const j = parseJSON(out); return Array.isArray(j.s) ? list.map((_, k) => Math.max(0, Math.min(10, +j.s[k] || 0))) : null;
  }catch(e){ if(e.name === 'AbortError') throw e; return null; }
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
  const P = opt.partner || null;   // 9.43: altă persoană din viața personajului, în aceeași poză
  const me = P ? P.blob : opt.together && S.userPhoto ? await DB.get(S.userPhoto) : null;
  if(full && me){
    const u = P ? P.name : S.userName.trim() || 'the user', uPhys = P ? P.desc : S.userPhys;
    const cb = id && !id.none ? id : null, ub = P ? (P.box || null) : S.userBox || null;
    const ref = await pairRef(full, me, cb, ub);
    const head = `${togetherFraming(shot)}. ${shot}.${fix ? ` Important corrections from the previous attempt: ${fix}.` : ''} Exactly two people in this photo, ${c.name} and ${u}, together in the scene described above.`;
    const tail = `Keep both identities exactly as in the references: the same faces, facial features, skin tones, hair and body types. This is ONE single natural photo of the two of them together: not a collage, not a split screen, no border, no gray background; the location, clothing, poses and light come only from the scene description. ${stil}`;
    const pPair = `${head} The reference image shows the two of them side by side: on the LEFT is ${c.name}${physFull(c, id) ? ' (' + physFull(c, id) + ')' : ''}; on the RIGHT is ${u}${uPhys ? ' (' + uPhys + ')' : ''}. ${tail}${P ? ` ${u} is a different person from ${c.name}; both are adults, fully clothed, ordinary everyday photo.` : ''}`;
    const pTwo = `${head} Image 1 is a close-up of ${c.name}'s face${physFull(c, id) ? ' (' + physFull(c, id) + ')' : ''}; image 2 is a close-up of ${u}'s face${uPhys ? ' (' + uPhys + ')' : ''}. ${tail}${P ? ` ${u} is a different person from ${c.name}; both are adults, fully clothed, ordinary everyday photo.` : ''}`;
    const model = S.imgProv === 'worker' ? (S.wkChat || S.wkModel) : undefined;
    if(useF3()) return {prompt:pTwo, blob: await f3Image(pTwo, [await cropFace(full, cb), await cropFace(me, ub)], S.wkSize, signal)};   // 9.43
    if(S.imgProv === 'worker') return {prompt:pTwo, blob: await genImage(pTwo, await cropFace(full, cb), signal, await cropFace(me, ub), {model, p1:pPair, one:ref})};
    return {prompt:pPair, blob: await genImage(pPair, ref, signal, null, {model})};
  }
  const phys = physFull(c, id) ? ` Her/his permanent physical traits (exactly as in the reference): ${physFull(c, id)}.` : '';
  const fixLine = fix ? ` Important corrections from the previous attempt: ${fix}.` : '';
  if(full && S.imgProv === 'worker' && S.photoEngine !== 'id') return await creatorScene(c, shot, signal, fix, opt, full, id, fr);   // 9.42
  const exposure = exposureMode(shot);
  const nudeNote = exposure === 'explicit' ? ' The fictional character is clearly an adult (18+), fully nude with visible external genital anatomy as requested; anatomically plausible, non-graphic, not a sexual act; do not add clothing or underwear. Only if the selected provider permits it.' : exposure === 'full' ? ' The character is clearly an adult (18+) and this is natural, non-explicit artistic nudity, not a sexual act; do not add clothing or underwear.' : exposure === 'topless' ? ' The character is clearly an adult (18+) and is topless as requested; bare breasts visible, no shirt or bra. Keep lower-body clothing as described; do not turn this into full nudity.' : '';
  if(full && S.imgProv === 'worker'){
    const R = await idRefs(c, shot);
    const prompt = idPrompt(c, shot + nudeNote, fr, R, fix, true);
    return {prompt, blob: await genImage(prompt, R.face, signal, R.body, {model: S.wkChat || (S.wkModel === 'eco' ? 'ancorat' : S.wkModel), p1: idPrompt(c, shot + nudeNote, fr, R, fix, false), extra: R.extra, size: opt.size})};
  }
  if(S.imgProv === 'worker'){
    const prompt = [c.look || '', fr.p, shot + fixLine + nudeNote, stil].filter(Boolean).join('. ');
    return {prompt, blob: await genImage(prompt, null, signal)};
  }
  const prompt = [fr.p, shot + fixLine + nudeNote, full ? 'Same person as in the reference image; take only the face, hair and body type from it, everything else (place, pose, clothing, light) from this description.' + phys : c.look || '', stil].filter(Boolean).join('. ');
  return {prompt, blob: await genImage(prompt, full, signal)};
}
/* ═════════ 🧩 9.83 fidelitate: fișa de identitate, schițe, proporții, reparare țintită, respingere cu motiv ═════════
   (2) FIȘA DE IDENTITATE: din poza de profil se fac o dată 4 unghiuri ale aceleiași fețe (trei-sferturi stânga și dreapta,
       profil, zâmbet), fiecare verificată în telefon că e aceeași față. La fiecare poză, generatorul și retușul primesc cele
       2 unghiuri potrivite scenei (profil când se uită în altă parte, zâmbetul când râde). Reperele puse de tine au prioritate. */
// 9.84: valorile fixe pentru fidelitate (alegerile vechi, mai slabe, au ieșit din Setări și din creator)
const FIDEL_FIX = {wkChat:'ancorat', idBoost:'on', idSheet:'on', drafts:'on', localFix:'on', photoEngine:'creator', imgCheck:'on', autoRefs:'on', autoFull:'on', crHands:'on', crAngles:'off'};
const SHEET_VIEWS = {
  l34:'a three-quarter view: the head turned about 40 degrees to the person\'s left, eyes towards the camera',
  r34:'a three-quarter view: the head turned about 40 degrees to the person\'s right, eyes towards the camera',
  side:'a side profile view: the head turned 90 degrees to the person\'s right, looking straight ahead',
  smile:'a straight front view, smiling widely and naturally with teeth showing, eyes towards the camera'};
const SHEET_RO = {l34:'¾ stânga', r34:'¾ dreapta', side:'profil', smile:'zâmbet'};
const SHEET_MAX = .5;
const sheetOn = c => S.idSheet !== 'off' && S.imgProv === 'worker' && !!S.wkBase && !!c && !!c.photo && (c.stil || 'photo') === 'photo';
const sheetOf = c => c && c.sheet && c.sheet.k === c.photo ? c.sheet.v || [] : [];
let sheetBusy = null;
async function sheetGen(c, force, onStep){
  if(!sheetOn(c) || sheetBusy) return false;
  if(!force && (sheetOf(c).length || (c.sheetTry && c.sheetTry.k === c.photo && Date.now() - c.sheetTry.at < 7 * 864e5))) return false;
  const mdl = rwFor('ancorat') ? 'ancorat' : (S.wkChat || 'ancorat');
  if(rwFor(mdl) ? rwCapLeft() < rwPer() * 6 : capLeft() < (neurPerPhoto(mdl) || 5000) * 6) return false;   // nu consumă ultima parte din plafon
  const k0 = c.photo; sheetBusy = c.id; c.sheetTry = {k:k0, at:Date.now()}; await saveChars();
  try{
    const base = await DB.get(k0); const ref = base ? await profDesc(c).catch(() => null) : null; if(!base || !ref) return false;   // fără față măsurabilă în profil nu se poate verifica
    const out = [];
    for(const [ang, vw] of Object.entries(SHEET_VIEWS)){
      if(onStep) onStep(ang, out.length);
      const p = `Edit this exact photo: the same person, photographed from ${vw}. Head and shoulders, plain softly blurred background, even soft light. Keep the exact same face and identity, hairstyle, skin and age, and the same clothes. ${STIL_TAG.photo}`;
      for(let t = 0; t < 2; t++){
        let b; try{ b = await genImage(p, base, null, null, {model:mdl, size:'768x1024', force:{two:false, px:1024}, p1:p, quiet:true, why:'profil'}); }catch(e){ if(t) break; continue; }
        addUsage(c.id, imgPrice(), 'img', null, 'profil');
        try{ if(b.type === 'image/png') b = await toJpeg(b, 1536, .9); }catch(e){}
        const fs = await faceDescs(b).catch(() => []);
        const best = fs.length ? fs.map(f => ({f, d:fdist(f.d, ref)})).sort((x, y) => x.d - y.d)[0] : null;
        if(best ? best.d < SHEET_MAX : ang === 'side'){   // din profil, fața de obicei nu se poate măsura: îl păstrăm, dar nu-l folosim la măsurători
          out.push({ang, b, d:best ? Math.round(best.d * 1000) / 1000 : null, box:best ? {x:best.f.box.x / best.f.W, y:best.f.box.y / best.f.H, w:best.f.box.w / best.f.W, h:best.f.box.h / best.f.H} : null}); break; }
      }
      if(c.photo !== k0 || !charById(c.id)) return false;   // ai schimbat poza de profil între timp
    }
    if(!out.length) return false;
    const old = (c.sheet && c.sheet.v) || [], v = [];
    for(const o of out) v.push({ang:o.ang, k:await saveImg(o.b), d:o.d, box:o.box});
    c.sheet = {k:k0, v, at:Date.now()}; await saveChars();
    for(const o of old) delImg(o.k).catch(() => {});
    return true;
  } finally { sheetBusy = null; }
}
// cele mai potrivite unghiuri pentru scena cerută
function sheetPick(c, shot, n = 2){
  const v = sheetOf(c); if(!v.length || n <= 0) return [];
  const t = String(shot || '').toLowerCase(), sc = {l34:1, r34:.9, smile:.8, side:.3};
  if(/\b(profile|side view|from the side|in profile|looking (away|out|to the side|sideways|out of the window)|turned away|over (her|his|the) shoulder)\b/.test(t)) sc.side = 3;
  if(/\b(laugh\w*|smil\w*|grin\w*|teeth)\b/.test(t)) sc.smile = 2.5;
  if(/\bmirror\b/.test(t)){ sc.l34 += .5; sc.r34 += .5; }
  if(/\bleft\b/.test(t)) sc.l34 += .4; if(/\bright\b/.test(t)) sc.r34 += .4;
  return v.slice().sort((a, b) => (sc[b.ang] || 0) - (sc[a.ang] || 0)).slice(0, n);
}
// reperele 3 și 4 (fețe decupate): ale tale întâi, apoi fișa (după scenă), apoi unghiurile automate
async function extraRefs(c, shot, noBox){
  const user = (c.refs || []).length && !c.refsAuto ? c.refs.slice(0, 2) : [], list = user.map(k => ({k, box:(c.refBoxes || {})[k]}));
  for(const s of sheetPick(c, shot, 2 - list.length)) list.push({k:s.k, box:s.box, ang:s.ang});
  for(const k of c.refs || []) if(list.length < 2 && !list.some(x => x.k === k)) list.push({k, box:(c.refBoxes || {})[k]});
  const out = [];
  for(const x of list.slice(0, 2)){
    const b = await DB.get(x.k).catch(() => null); if(!b) continue;
    let rb = x.box; if(rb === undefined && noBox) rb = null; if(rb === undefined){ rb = await faceBoxOf(b); c.refBoxes = c.refBoxes || {}; c.refBoxes[x.k] = rb; saveChars(); }
    const f = await cropFace(b, rb); f.ang = x.ang || ''; out.push(f);
  }
  return out;
}
/* (8) RESPINGERE CU MOTIV: la 🎲 spui ce n-a mers. Poza nouă primește corectura, iar personajul ține minte (scade la jumătate
       în 14 zile): ce respingi des primește mai multă greutate la alegerea variantelor și praguri mai stricte. */
const PFB_KEYS = ['face', 'body', 'hair', 'age', 'scene'];
const PFB_RO = {face:'fața', body:'corpul', hair:'părul', age:'vârsta', scene:'scena'};
function pfbGet(c){
  const p = c && c.pfb; if(!p) return {face:0, body:0, hair:0, age:0, scene:0};
  const f = Math.pow(.5, (Date.now() - (p.at || 0)) / (14 * 864e5)), o = {};
  for(const k of PFB_KEYS) o[k] = Math.round((p[k] || 0) * f * 100) / 100;
  return o;
}
function pfbAdd(c, k){
  if(!c || !PFB_KEYS.includes(k)) return;
  const o = pfbGet(c); o[k] = Math.min(6, o[k] + 1); c.pfb = {...o, at:Date.now()}; saveChars();
}
const pfbW = (c, k) => 1 + .2 * Math.min(3, pfbGet(c)[k] || 0);   // greutatea la alegerea variantei
const idMax = c => ID_MAX - .03 * Math.min(2, pfbGet(c).face);        // „altă față” mai strict când respingi des fața
const bodyMax = c => .14 - .02 * Math.min(3, pfbGet(c).body);         // silueta (9.85: măsurătoarea mai fină, prag mai strict): refacere mai devreme când respingi des corpul
function pfbCorr(c, id, miss){
  const hairT = String(id && id.phys || '').match(/(?:^|; )hair: ([^;]+)/), P = pfbGet(c), out = [];
  const L = {
    face:'the face must be exactly the face of the reference: the same facial geometry, eyes, eyebrows, nose, lips, jaw and skin; not a more generic or prettier face',
    body:`the body must match the reference exactly${bodyOnly(c, id) ? ': ' + bodyOnly(c, id) : ''}`,
    hair:`the hair must match the reference exactly${hairT ? ': ' + hairT[1].trim() : ' (color, length, texture, parting)'}`,
    age:'the same apparent age as in the reference, not older and not younger',
    scene:'follow the requested scene, place, pose and clothing exactly'};
  if(miss && L[miss]) out.push(L[miss]);
  for(const k of PFB_KEYS) if(k !== miss && P[k] >= 1.5 && k !== 'scene') out.push(L[k]);   // ce respingi des, la fiecare poză
  return out.join('; ').slice(0, 600);
}
function rejectSheet(m){
  if(!m || busy) return;
  const go = k => { if(k) pfbAdd(cur, k); askPhoto(false, m, 'same', {miss:k || ''}); };
  sheet([['👤', 'Fața nu seamănă', () => go('face')], ['🧍', 'Corpul nu seamănă', () => go('body')], ['💇', 'Părul nu e al ei', () => go('hair')],
    ['🎂', 'Pare mai mare sau mai mică', () => go('age')], ['🎬', 'Scena sau ce am cerut', () => go('scene')], ['🎲', 'Doar altă variantă', () => go('')]]);
}
/* (3) SCHIȚE: în loc de 3 poze mari, 4 schițe mai mici (576×768, ~55% din preț fiecare), telefonul o alege pe cea mai apropiată
       (fața, silueta, cât respectă cererea), apoi doar ea e refăcută la mărimea întreagă, fără să schimbe nimic. */
const draftsOn = (c, opt = {}) => S.drafts !== 'off' && idBoostOn(c, opt) && S.imgProv === 'worker' && rwFor(sceneModel(opt)) && !useF3() && !opt.together && !opt.partner && (c.stil || 'photo') === 'photo';
function draftSize(){ const [w, h] = String(S.wkSize || '768x1024').split('x').map(Number); const k = Math.sqrt(.44e6 / ((w || 768) * (h || 1024))); return k >= 1 ? S.wkSize || '768x1024' : Math.round(w * k / 16) * 16 + 'x' + Math.round(h * k / 16) * 16; }
async function draftFinal(c, x, shot, signal, opt = {}){
  pstage(signal, '🖼️ Face poza aleasă la mărime întreagă', 94);
  const p = `Recreate image 1 at full resolution as the final photo: exactly the same picture, with identical composition, framing, pose, face, expression, hair, clothing, body, background and light. Only add natural fine detail and sharpness; change nothing. ${NO_BEAUTY} ${STIL_TAG[c.stil || 'photo']}`;
  try{
    const b = await genImage(p, x.blob, signal, null, {model:sceneModel(opt), size:S.wkSize || '768x1024', force:{two:false, px:1024}, p1:p, quiet:true, why:'schite'});
    addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze');
    const fd = (await localFace(b, c)).d;
    return {...x, blob:b, fd, draftFd:x.fd, drafted:true};
  }catch(e){ if(e.name === 'AbortError') throw e; return {...x, drafted:true, draftOnly:true}; }   // rămâne schița (mai mică), nu pierzi poza
}
/* (5) REPARARE ȚINTITĂ: dacă scena e bună și doar fața sau părul nu se potrivesc, se refac numai acolo (decupat, refăcut după
       portret, lipit la loc cu margini estompate), nu toată poza. Rămâne doar dacă verificarea iese mai bună. */
const localFixOn = (c, opt = {}) => S.localFix !== 'off' && S.imgProv === 'worker' && !!S.wkBase && !!c.photo && !opt.together && !opt.partner && (c.stil || 'photo') === 'photo';
const fixBudget = () => rwFor('ancorat') ? rwCapLeft() >= rwPer() : capLeft() >= (neurPerPhoto('eco') || 500) * 2;
/* ═════════ 🧍 9.85 corpul la fel în toate pozele ═════════
   (1) la orice poză în care se vede corpul, generatorul primește și o poză cu tot corpul (întreagă sau din fișa de corp)
   (2) FIȘA DE CORP: o dată, din poza întreagă: ¾, profil, așezată; verificate prin măsurare; alese după scenă
   (3) conturul măsurat în 7 puncte pe trunchi, raportat la lungimea trunchiului, + picioare, așezat / în picioare, cât e întoarsă
   (4) la alegerea variantei, corpul cântărește cât fața   (5) reparare doar a corpului, păstrată doar dacă măsurătoarea se apropie
   (6) garanție: peste prag se reface o dată; dacă tot nu trece, poza vine cu „⚠️ corpul seamănă X%” */
const BSHEET_VIEWS = {'34':'from a three-quarter angle, full body from head to feet, standing naturally', side:'in side view (profile), full body from head to feet, standing naturally', sit:'sitting on a simple chair and facing the camera, the whole body visible from head to feet'};
const BSHEET_RO = {'34':'¾', side:'profil', sit:'așezată', full:'poza întreagă'};
const bsheetOf = c => c && c.photoFull && c.bsheet && c.bsheet.k === c.photoFull ? c.bsheet.v || [] : [];
async function bsheetGen(c, force, onStep){
  if(!sheetOn(c) || !c.photoFull || sheetBusy) return false;
  if(!force && (bsheetOf(c).length || (c.bsheetTry && c.bsheetTry.k === c.photoFull && Date.now() - c.bsheetTry.at < 7 * 864e5))) return false;
  const mdl = rwFor('ancorat') ? 'ancorat' : (S.wkChat || 'ancorat');
  if(rwFor(mdl) ? rwCapLeft() < rwPer() * 5 : capLeft() < (neurPerPhoto(mdl) || 5000) * 5) return false;
  const k0 = c.photoFull; sheetBusy = c.id; c.bsheetTry = {k:k0, at:Date.now()}; await saveChars();
  try{
    const base = await DB.get(k0); if(!base) return false;
    const ref = await bodySig(base).catch(() => null); if(!ref) return false;   // fără siluetă măsurabilă în poza întreagă nu se poate verifica
    const out = [];
    for(const [pose, vw] of Object.entries(BSHEET_VIEWS)){
      if(onStep) onStep(pose, out.length);
      const p = `Edit this exact photo: the same person photographed ${vw}. Keep exactly the same person: the same face, the same body (build, weight and proportions), the same clothes and hairstyle. Plain neutral background, even soft light. ${STIL_TAG.photo}`;
      for(let t = 0; t < 2; t++){
        let b; try{ b = await genImage(p, base, null, null, {model:mdl, size:'832x1248', force:{two:false, px:1024}, p1:p, quiet:true, why:'profil'}); }catch(e){ if(t) break; continue; }
        addUsage(c.id, imgPrice(), 'img', null, 'profil');
        try{ if(b.type === 'image/png') b = await toJpeg(b, 1536, .9); }catch(e){}
        const fd = (await localFace(b, c).catch(() => ({d:null}))).d, sig = await bodySig(b).catch(() => null);
        const bd = sig ? bodyDist2(sig, ref) : null;
        const faceOk = fd == null ? pose === 'side' : fd < .55, bodyOk = pose === 'side' ? true : bd != null && bd <= BODY_SHEET_OK;
        if(faceOk && bodyOk){ out.push({pose, b, bd:bd == null ? null : Math.round(bd * 1000) / 1000, sig}); break; }
      }
      if(c.photoFull !== k0 || !charById(c.id)) return false;
    }
    if(!out.length) return false;
    const old = (c.bsheet && c.bsheet.v) || [], v = [];
    for(const o of out) v.push({pose:o.pose, k:await saveImg(o.b), bd:o.bd, sig:o.sig});
    c.bsheet = {k:k0, v, at:Date.now()}; await saveChars();
    for(const o of old) delImg(o.k).catch(() => {});
    return true;
  } finally { sheetBusy = null; }
}
// poza de corp potrivită scenei: așezată, din profil, ¾ sau poza întreagă (toată silueta, încadrată fără tăieturi)
function bodyPoseOf(shot){
  const t = String(shot || '').toLowerCase();
  if(/\b(sitting|seated|sits|sat|on the (couch|sofa|chair|bed|bench|floor|stool|armchair)|at the (table|desk|bar))\b/.test(t)) return 'sit';
  if(/\b(side view|in profile|from the side)\b/.test(t)) return 'side';
  if(/\b(three-quarter|mirror)\b/.test(t)) return '34';
  return 'full';
}
async function bodyRefFor(c, shot){
  if(!c.photoFull) return null;
  const want = bodyPoseOf(shot), pick = want === 'full' ? null : bsheetOf(c).find(x => x.pose === want);
  const k = pick ? pick.k : c.photoFull, b = await DB.get(k).catch(() => null); if(!b) return null;
  return {blob:(await personCrop(b, k)) || await wholeRef(b), pose:pick ? pick.pose : 'full'};   // 9.86: decupat pe siluetă
}
const BODY_SHEET_OK = .12;
// distanța siluetelor (9.85): se compară doar ce e comparabil; null = nu se poate spune
function bodyDist2(a, b){
  if(!a || !b) return null;
  if(!a.w || !b.w) return bodyDist(a, b);
  let t = 0, n = 0; const ds = []; const add = (x, y, wg, fl = .2) => { if(!(x > 0) || !(y > 0) || !wg) return; const d = Math.abs(x - y) / Math.max(fl, y); t += d * wg; n += wg; if(wg >= .5) ds.push(d); };
  const same = !!a.sit === !!b.sit && Math.abs((a.yaw || 0) - (b.yaw || 0)) < .25;
  if(same){ a.w.forEach((x, i) => add(x, b.w[i], i >= 5 && (a.sit || b.sit) ? 0 : 1)); add(a.sw, b.sw, .6); if(a.hd && b.hd) add(a.hd, b.hd, .3, .15); }
  else { add(a.w[2], b.w[2], .4); add(a.w[3], b.w[3], .4); }   // alt unghi: doar talia, cu greutate mică
  if(!a.sit && !b.sit) add(a.leg, b.leg, .8);
  if(!n) return null;
  const top = ds.sort((x, y) => y - x).slice(0, 2), tp = top.length ? top.reduce((m, x) => m + x, 0) / top.length : 0;
  return .6 * t / n + .4 * tp;   // media + cele mai mari 2 diferențe: o talie sau niște picioare diferite nu se mai pierd în medie
}
async function refBodySigs(c){
  const full = await refBodySig(c); if(!full) return [];
  const out = [{pose:'full', sig:full}];
  for(const x of bsheetOf(c)){
    if(x.sig === undefined){ const b = await DB.get(x.k).catch(() => null); x.sig = b ? await bodySig(b).catch(() => null) : null; saveChars(); }
    if(x.sig) out.push({pose:x.pose, sig:x.sig});
  }
  return out;
}
// cea mai apropiată referință cu același fel de poză (în picioare / așezată, din față / întoarsă)
async function bodyMatch(c, sig, refs){
  refs = refs || await refBodySigs(c); if(!sig || !refs.length) return null;
  let best = null; for(const r of refs){ const d = bodyDist2(sig, r.sig); if(d != null && (best == null || d < best)) best = d; }
  return best;
}
const bodyGate = c => bodyMax(c) + .05;   // (6) garanția: peste asta, poza se reface o dată
const bodyPct = d => d == null ? null : Math.max(0, Math.round(100 - d * 250));
/* ═════════ 9.86 ═════════
   VITEZA: (a) schițele într-o singură cerere Runware (reperele urcă o dată, nu de 4 ori); (b) JPG în loc de PNG (de ~5 ori mai puțin de
   descărcat); (c) verificarea cu Claude se sare când fața, corpul și scena sunt deja măsurate ca bune; (d) compararea scenei între schițe
   doar când contează; (e) retușul feței doar când fața chiar e departe; (f) modelele din telefon se încarcă din timp, la deschiderea
   conversației; (g) cronometru pe fiecare pas, în „🔍 De ce arată așa”.
   CORPUL: reperul de corp decupat pe siluetă (corpul ocupă tot reperul, nu un sfert din el), la 768 px; dacă în nicio schiță corpul
   nu trece, încă o tură de schițe cu corectura de corp, înainte de poza mare. */
const tmOn = opt => opt && opt.tm && opt.tm.s;
function tmAdd(opt, k, t0){ if(tmOn(opt)) opt.tm.s[k] = (opt.tm.s[k] || 0) + (performance.now() - t0); }   // ms
const FACE_RET = .40;   // retușul feței: doar peste pragul ăsta (sub el, fața e deja foarte apropiată)
// reperul de corp: doar persoana (după segmentare), cu o margine mică, centrată pe pătrat; în memorie, pe poză
const bodyCropCache = new Map();
async function personCrop(blob, key){
  if(key && bodyCropCache.has(key)) return bodyCropCache.get(key);
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight, m = await segMask(im);
    let x0 = 256, y0 = 256, x1 = -1, y1 = -1;
    for(let y = 0; y < 256; y++) for(let x = 0; x < 256; x++) if(m[y * 256 + x] >= .5){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
    if(x1 < 0 || (x1 - x0) * (y1 - y0) < 256 * 256 * .03) return null;   // nicio persoană clară
    const px = (x1 - x0) * .06 + 2, py = (y1 - y0) * .04 + 2;
    const bx = Math.max(0, (x0 - px) / 256 * W), by = Math.max(0, (y0 - py) / 256 * H), bw = Math.min(W, (x1 + px) / 256 * W) - bx, bh = Math.min(H, (y1 + py) / 256 * H) - by;
    const K = 768, s = K / Math.max(bw, bh), cv = document.createElement('canvas'); cv.width = cv.height = K;
    const g = cv.getContext('2d'); g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, K, K);
    g.drawImage(im, bx, by, bw, bh, (K - bw * s) / 2, (K - bh * s) / 2, bw * s, bh * s);
    const out = await new Promise(r => cv.toBlob(r, 'image/jpeg', .92));
    if(key){ bodyCropCache.set(key, out); if(bodyCropCache.size > 12) bodyCropCache.delete(bodyCropCache.keys().next().value); }
    return out;
  }catch(e){ return null; } finally { URL.revokeObjectURL(u); }
}
// (f) la deschiderea conversației: modelele din telefon și măsurătorile personajului, din timp (o dată)
const warmDone = new Set();
function photoWarm(c){
  if(!c || !c.photo || S.imgProv !== 'worker' || warmDone.has(c.id + '|' + c.photo)) return;
  warmDone.add(c.id + '|' + c.photo);
  const go = async () => { if(typeof call !== 'undefined' && call){ warmDone.delete(c.id + '|' + c.photo); return; }   // nu în timpul unui apel (încarcă telefonul)
    try{ await faceApi(); await Promise.all([poseModel(), segModel()]); await refDescs(c); await refBodySigs(c); }catch(e){} };
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => go(), {timeout:5000});
}
/* (3) editorul de corp, același în creator și în „Modifică poza”: pe grupuri, cu ‹ › pe fiecare rând, și ce schimbi, înainte să aplici */
const BODY_GROUPS = [['📏', 'Siluetă', ['build', 'tone', 'shoulders', 'arms', 'neck', 'posture']], ['👕', 'Trunchi', ['bust', 'bustShape', 'torsoLen', 'waist', 'belly']],
  ['👖', 'Partea de jos', ['hips', 'glutes', 'legsLen', 'legs']], ['🎨', 'Pielea', ['skin']]];
const hTxt = h => (h / 100).toFixed(2).replace('.', ',') + ' m';
function bodyChanges(A, B){
  const out = []; if((+A.h || 0) !== (+B.h || 0)) out.push(`înălțime ${+A.h ? hTxt(+A.h) : '—'} → ${+B.h ? hTxt(+B.h) : '—'}`);
  for(const [k, l] of CR_BODY) if(String(A[k] || '') !== String(B[k] || '')) out.push(`${l.toLowerCase()}: ${A[k] || '—'} → ${B[k] || '—'}`);
  return out;
}
function bodyEdHTML(B, B0, open, hid){
  const h = +B.h || 0, hch = !!B0 && (+B0.h || 0) !== h, chg = B0 ? bodyChanges(B0, B) : [];
  const row = k => { const d = CR_BODY.find(x => x[0] === k); if(!d) return ''; const v = B[k] || '', ch = !!B0 && String(B0[k] || '') !== String(v);
    return `<div class="bedrow${ch ? ' ch' : ''}"><span>${esc(d[1])}</span><button type="button" class="bedst" data-bstep="-1" data-bk="${k}" aria-label="înapoi">‹</button><div class="bedopt crch" data-bk="${k}">${d[2].map(x => `<button type="button" class="${v === x ? 'on' : ''}" data-bv="${esc(x)}">${esc(x)}</button>`).join('')}</div><button type="button" class="bedst" data-bstep="1" data-bk="${k}" aria-label="înainte">›</button></div>`; };
  return `<div class="bed">${B0 ? `<div class="bedsum">${chg.length ? '✏️ <b>Schimbi:</b> ' + esc(chg.join(' · ')) + ' <button type="button" class="btn sm" data-breset>↺ Ca înainte</button>' : 'Corpul ei de acum. Atinge ce vrei să schimbi; ‹ › trec la varianta vecină.'}</div>` : ''}
    ${BODY_GROUPS.map(([e, l, ks], gi) => { const n = ks.filter(k => B[k]).length + (gi === 0 && h ? 1 : 0), nc = B0 ? ks.filter(k => String(B0[k] || '') !== String(B[k] || '')).length + (gi === 0 && hch ? 1 : 0) : 0;
      return `<details class="bedg"${!open || open[gi] !== false ? ' open' : ''}><summary>${e} ${esc(l)} <small>${n ? n + (n === 1 ? ' aleasă' : ' alese') : 'nimic ales'}${nc ? ' · <b>' + nc + (nc === 1 ? ' schimbare' : ' schimbări') + '</b>' : ''}</small></summary>
        ${gi === 0 ? `<div class="bedrow hrow${hch ? ' ch' : ''}"><span>Înălțime</span><button type="button" class="bedst" data-hstep="-2" aria-label="mai scundă">‹</button><input type="range"${hid ? ` id="${hid}"` : ''} data-bh min="145" max="195" step="1" value="${h || 168}"><button type="button" class="bedst" data-hstep="2" aria-label="mai înaltă">›</button><b data-bhv>${h ? hTxt(h) : 'oricare'}</b>${h ? '<button type="button" class="bedx" data-hx aria-label="oricare">✕</button>' : ''}</div>` : ''}
        ${ks.map(row).join('')}</details>`; }).join('')}</div>`;
}
// B se schimbă pe loc; întoarce redraw() (grupurile deschise rămân deschise)
function bodyEdBind(box, B, B0, onChange, hid){
  const redraw = () => { const open = [...box.querySelectorAll('.bedg')].map(d => d.open); box.innerHTML = bodyEdHTML(B, B0, open.length ? open : null, hid);
    requestAnimationFrame(() => box.querySelectorAll('.bedopt .on').forEach(b => { const p = b.parentElement; p.scrollLeft = Math.max(0, b.offsetLeft - p.offsetLeft - 28); })); };
  const done = () => { redraw(); if(onChange) onChange(); };
  box.onclick = e => {
    if(e.target.closest('[data-breset]')){ for(const k of Object.keys(B)) delete B[k]; Object.assign(B, B0); done(); return; }
    if(e.target.closest('[data-hx]')){ B.h = 0; done(); return; }
    const hs = e.target.closest('[data-hstep]'); if(hs){ B.h = Math.max(145, Math.min(195, (+B.h || 168) + +hs.dataset.hstep)); done(); return; }
    const st = e.target.closest('[data-bstep]'); if(st){ const k = st.dataset.bk, o = CR_BODY.find(x => x[0] === k)[2], i = o.indexOf(B[k]), d = +st.dataset.bstep;
      B[k] = o[i < 0 ? (d > 0 ? 0 : o.length - 1) : Math.max(0, Math.min(o.length - 1, i + d))]; done(); return; }
    const bt = e.target.closest('[data-bv]'); if(!bt) return; const k = bt.parentElement.dataset.bk; B[k] = B[k] === bt.dataset.bv ? '' : bt.dataset.bv; done();
  };
  box.oninput = e => { if(e.target.matches('[data-bh]')){ B.h = +e.target.value; const v = box.querySelector('[data-bhv]'); if(v) v.textContent = hTxt(B.h); } };
  box.onchange = e => { if(e.target.matches('[data-bh]')) done(); };
  return redraw;
}
// ajustările rapide: corpul (pe treptele de mai sus) separat de restul (ținută, păr, loc…)
const adjIsBody = v => CR_ADJ_OPS.some(o => o[0] === v);
const adjChipsHTML = (bodyToo = true) => `${bodyToo ? `<div class="adjgrp"><small>🧍 Corp</small>${CR_ADJ.filter(([, v]) => adjIsBody(v)).map(([l, v]) => `<button type="button" data-adj="${esc(v)}">${esc(l)}</button>`).join('')}</div>` : ''}<div class="adjgrp"><small>🎨 Restul</small>${CR_ADJ.filter(([, v]) => !adjIsBody(v)).map(([l, v]) => `<button type="button" data-adj="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
/* ═════════ 9.87 calitatea pozelor, fără cost în plus ═════════
   (2) FINISARE pe telefon: balans de alb și expunere corectate ușor, claritate fină (mai mult pe față), granulație fină de senzor
   (3) MĂRIRE 2× pe telefon când deschizi poza mare (ESRGAN slim, 888 KB, MIT, prin TensorFlow-ul deja inclus); se ține minte
   (4) ALEGEREA după claritate: dintre schițe, cea neclară pierde puncte   (5) descrierea de realism mai precisă (cameră de telefon) */
async function photoFinish(blob){
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight; if(!W || !H) return blob;
    let face = null; try{ const fs = await faceDescs(blob); if(fs.length) face = fs.sort((a, b) => b.a - a.a)[0].box; }catch(e){}
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d', {willReadFrequently:true}); g.drawImage(im, 0, 0);
    const bc = document.createElement('canvas'); bc.width = W; bc.height = H; const gb = bc.getContext('2d', {willReadFrequently:true}); gb.filter = 'blur(1.2px)'; gb.drawImage(im, 0, 0);
    const A = g.getImageData(0, 0, W, H), d = A.data, B = gb.getImageData(0, 0, W, H).data, n = W * H;
    const hist = new Uint32Array(256); let mR = 0, mG = 0, mB = 0;
    for(let i = 0; i < d.length; i += 4){ mR += d[i]; mG += d[i + 1]; mB += d[i + 2]; hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; }
    mR /= n; mG /= n; mB /= n; const mY = (mR + mG + mB) / 3;
    const pct = p => { let s = 0; for(let v = 0; v < 256; v++){ s += hist[v]; if(s >= n * p) return v; } return 255; };
    let lo = pct(.005), hi = pct(.995); if(hi - lo < 100){ lo = 0; hi = 255; }
    const wbk = x => Math.max(.94, Math.min(1.06, 1 + (mY / Math.max(1, x) - 1) * .3));   // balans de alb: doar o treime din drum, cel mult ±6%
    const gR = wbk(mR), gG = wbk(mG), gB = wbk(mB), ex = .35, span = 255 / Math.max(1, hi - lo);
    const fx = face ? face.x + face.w / 2 : -1, fy = face ? face.y + face.h / 2 : -1, frx = face ? face.w * .9 : 1, fry = face ? face.h * 1.1 : 1;
    const grain = 2.6 * Math.sqrt(Math.max(1, W * H / 786432));
    for(let y = 0, i = 0; y < H; y++){
      for(let x = 0; x < W; x++, i += 4){
        let amt = .22; if(face){ const q = ((x - fx) / frx) ** 2 + ((y - fy) / fry) ** 2; if(q < 1) amt += .3 * (1 - q); }
        const nz = (Math.random() + Math.random() - 1) * grain;
        for(let c = 0; c < 3; c++){
          let v = d[i + c] + (d[i + c] - B[i + c]) * amt;                 // claritate fină (mai mult pe față)
          v = v * (c === 0 ? gR : c === 1 ? gG : gB);                     // balans de alb
          v = v + ((v - lo) * span - v) * ex;                             // expunere: întinde ușor tonurile
          d[i + c] = v + nz;                                              // granulație de senzor
        }
      }
    }
    g.putImageData(A, 0, 0);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', .93));
  }catch(e){ return blob; } finally { URL.revokeObjectURL(u); }
}
// (4) claritatea: varianța Laplacianului pe zona centrală, la 384 px (mai mare = mai clară)
async function sharpOf(blob){
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), k = 384 / Math.max(im.naturalWidth, im.naturalHeight), W = Math.round(im.naturalWidth * k), H = Math.round(im.naturalHeight * k);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d', {willReadFrequently:true}); g.drawImage(im, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data, L = new Float32Array(W * H);
    for(let i = 0, j = 0; i < d.length; i += 4, j++) L[j] = d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11;
    let s = 0, s2 = 0, m = 0; const x0 = Math.round(W * .15), x1 = Math.round(W * .85), y0 = Math.round(H * .1), y1 = Math.round(H * .9);
    for(let y = y0; y < y1; y++) for(let x = x0; x < x1; x++){ const j = y * W + x, v = 4 * L[j] - L[j - 1] - L[j + 1] - L[j - W] - L[j + W]; s += v; s2 += v * v; m++; }
    return m ? Math.round((s2 / m - (s / m) ** 2) * 10) / 10 : null;
  }catch(e){ return null; } finally { URL.revokeObjectURL(u); }
}
const sharpPen = (x, mx) => x.sh != null && mx > 0 ? (1 - Math.min(1, x.sh / mx)) * .06 : 0;
// (3) mărirea 2×: pe bucăți de 128 px (cu margine), ca să încapă în memoria telefonului
let srP = null;
function srModel(){ if(!srP){ srP = faceApi().then(f => f.tf.loadLayersModel('vendor/sr/x2/model.json').then(m => ({tf:f.tf, m}))); srP.catch(() => { srP = null; }); } return srP; }
async function srUpscale(blob, alive = () => true, onProg){
  const {tf, m} = await srModel();
  const u = URL.createObjectURL(blob); let im;
  try{ im = await loadImgEl(u); } finally { URL.revokeObjectURL(u); }
  const W = im.naturalWidth, H = im.naturalHeight; if(Math.max(W, H) > 1400) return null;   // deja mare
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.getContext('2d').drawImage(im, 0, 0);
  const out = document.createElement('canvas'); out.width = W * 2; out.height = H * 2; const go = out.getContext('2d');
  const src = tf.browser.fromPixels(cv), P = 128, pad = 8, tiles = Math.ceil(W / P) * Math.ceil(H / P); let done = 0;
  try{
    for(let y = 0; y < H; y += P) for(let x = 0; x < W; x += P){
      if(!alive()) return null;
      const x0 = Math.max(0, x - pad), y0 = Math.max(0, y - pad), x1 = Math.min(W, x + P + pad), y1 = Math.min(H, y + P + pad);
      const t = tf.tidy(() => m.predict(src.slice([y0, x0, 0], [y1 - y0, x1 - x0, 3]).toFloat().expandDims(0)).squeeze().clipByValue(0, 255).toInt());
      const px = await tf.browser.toPixels(t); t.dispose();
      const id = new ImageData(px, (x1 - x0) * 2, (y1 - y0) * 2);
      go.putImageData(id, x0 * 2, y0 * 2, (x - x0) * 2, (y - y0) * 2, Math.min(P, W - x) * 2, Math.min(P, H - y) * 2);
      done++; if(onProg) onProg(done / tiles);
      await new Promise(r => setTimeout(r, 0));   // telefonul rămâne fluid
    }
  } finally { src.dispose(); }
  return await new Promise(r => out.toBlob(r, 'image/jpeg', .92));
}
const srKey = k => thKey('x', k);
let srBusy = null;
async function srGet(k, alive, onProg){
  const hit = await DB.get(srKey(k)).catch(() => null); if(hit) return hit;
  if(S.sr === 'off' || srBusy) return null;
  const b = await DB.get(k).catch(() => null); if(!b) return null;
  srBusy = k;
  try{ const x = await srUpscale(b, alive, onProg); if(x){ await DB.set(srKey(k), x); return x; } return null; }
  catch(e){ console.warn('mărirea 2× n-a mers', e); return null; } finally { srBusy = null; }
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
async function facePass(c, blob, signal, model = 'eco', shot = '', why = 'retus', src = null, area = 'face'){   // 9.83 (5): area = 'hair' → doar părul   // 9.35: `src` = altă poză de bază (editor: varianta aleasă)
  const u = URL.createObjectURL(blob); let im;
  try{ im = await loadImgEl(u); } finally { URL.revokeObjectURL(u); }
  const faces = await faceDescs(blob); if(!faces.length) return null;          // fața nu se vede (de spate, prea mică): poza rămâne așa
  const ref = src ? (src.refD || []) : await refDescs(c).catch(() => []);
  const pick = ref.length ? faces.map(f => ({f, d:Math.min(...ref.map(r => fdist(f.d, r)))})).sort((a, b) => a.d - b.d)[0].f : faces.sort((a, b) => b.a - a.a)[0];
  const W = im.naturalWidth, H = im.naturalHeight, bx = pick.box;
  if(bx.w < 14 || bx.h < 14) return null;
  const hair = area === 'hair', side = Math.min(W, H, Math.max(bx.w, bx.h) * (hair ? 3.2 : 2.1)), cx = bx.x + bx.w / 2, cy = bx.y + bx.h * (hair ? .32 : .46);
  const small = side < 300;   // 9.36: fața mică în cadru (poză întreagă): retușul lucrează pe 768 px, iar fața iese clară
  const x0 = Math.min(Math.max(0, cx - side / 2), W - side), y0 = Math.min(Math.max(0, cy - side / 2), H - side), K = small ? 768 : 512, k = K / side;
  const cv0 = document.createElement('canvas'); cv0.width = cv0.height = K; cv0.getContext('2d').drawImage(im, x0, y0, side, side, 0, 0, K, K);
  const crop = await toBlob(cv0, .95);
  // fața personajului (+ unghiurile în plus din profil), ca repere
  const prof = src ? src.prof : await DB.get(c.photo); if(!prof) return null;
  let id = null; if(!src) try{ id = await identityOf(c); }catch(e){}
  const hx = b => !hair || !b ? b : {x:Math.max(0, b.x - b.w * .65), y:Math.max(0, b.y - b.h * .6), w:Math.min(1, b.w * 2.3), h:Math.min(1, b.h * 2.4)};   // părul: tot capul
  const pface = src ? await cropFace(prof, hx(src.box || null)) : await cropFace(prof, hx(await profFaceBox(c, prof) || (id && !id.none ? id : null)));
  const extra = src || hair ? [] : await extraRefs(c, shot, true);   // 9.83 (2): unghiurile potrivite scenei
  const faceMarks = id && id.marks ? id.marks.filter(m => /face|cheek|lip|nose|eye|brow|forehead|chin|jaw|temple|ear|mole|freckle|dimple/i.test(m)) : [];
  const hairT = String(id && id.phys || '').match(/(?:^|; )hair: ([^;]+)/);
  const prompt = hair ? `Edit image 1. Change ONLY the hair of the person in image 1 so that it matches the hair of the person in image 2 exactly${hairT ? ': ' + hairT[1].trim() : ': the same color, length, texture, volume, parting and hairline'}. Keep the face, facial features, expression, head position and angle, skin, clothing, background, light and photo grain of image 1 exactly as they are. One seamless, photorealistic, unretouched phone photo.` : `Edit image 1. Replace ONLY the face of the person in image 1 with the exact face of the person in image 2${extra.length ? ' (images 3' + (extra.length > 1 ? ' and 4' : '') + ' show the same face from other angles)' : ''}: the same individual, with identical facial geometry, eye shape and spacing, eye color, eyebrows, nose, lips, jaw and chin, skin tone and skin texture${faceMarks.length ? ', and these marks in exactly the same place: ' + faceMarks.join('; ') : ''}${id && id.glasses ? ', wearing ' + id.glasses : ''}. Keep everything else from image 1 exactly as it is: head position and angle, gaze direction, facial expression, the light direction and color on the face, hair, background, framing${small ? '' : ', sharpness'} and photo grain.${small ? ' Image 1 is an enlarged low-resolution crop: render the face crisp and detailed, with natural photo sharpness, taking the fine facial details from image 2.' : ''} One seamless, photorealistic, unretouched phone photo.`;
  const ed = await genImage(prompt, crop, signal, pface, {model, force:{two:true}, size:K + 'x' + K, extra, quiet:true, why});
  const ue = URL.createObjectURL(ed); let ei;
  try{ ei = await loadImgEl(ue); } finally { URL.revokeObjectURL(ue); }
  // culorile retușului se aliniază cu ale decupajului original (media și contrastul pe fiecare canal), ca lipitura să nu se vadă
  const cv1 = document.createElement('canvas'); cv1.width = cv1.height = K; const g1 = cv1.getContext('2d'); g1.drawImage(ei, 0, 0, K, K);
  const A = cv0.getContext('2d').getImageData(0, 0, K, K), Bd = g1.getImageData(0, 0, K, K), st = d => { const m = [0, 0, 0], v = [0, 0, 0], n = d.length / 4;
    for(let i = 0; i < d.length; i += 4) for(let ch = 0; ch < 3; ch++) m[ch] += d[i + ch]; for(let ch = 0; ch < 3; ch++) m[ch] /= n;
    for(let i = 0; i < d.length; i += 4) for(let ch = 0; ch < 3; ch++) v[ch] += (d[i + ch] - m[ch]) ** 2; return {m, s:v.map(x => Math.sqrt(x / n) || 1)}; };
  const sa = st(A.data), sb = st(Bd.data);
  if(!hair) for(let i = 0; i < Bd.data.length; i += 4) for(let ch = 0; ch < 3; ch++){ const v = Bd.data[i + ch], t = (v - sb.m[ch]) / sb.s[ch] * sa.s[ch] + sa.m[ch]; Bd.data[i + ch] = Math.max(0, Math.min(255, v + (t - v) * .7)); }   // 9.83: la păr culoarea nouă e chiar ce trebuia schimbat
  g1.putImageData(Bd, 0, 0);
  // doar fața: elipsă în jurul ei, cu margine estompată
  g1.globalCompositeOperation = 'destination-in';
  const fx = (bx.x + bx.w / 2 - x0) * k, fy = (bx.y + bx.h * .52 - y0) * k, rx = bx.w * k * .6, ry = bx.h * k * .74;
  const ell = (X, Y, RX, RY, a0) => { g1.save(); g1.translate(X, Y); g1.scale(1, RY / RX);
    const gr = g1.createRadialGradient(0, 0, RX * a0, 0, 0, RX); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g1.fillStyle = gr; g1.fillRect(-RX * 1.2, -RX * 1.2, RX * 2.4, RX * 2.4); g1.restore(); };
  if(!hair) ell(fx, fy, rx, ry, .64);
  else { ell((bx.x + bx.w / 2 - x0) * k, (bx.y + bx.h * .4 - y0) * k, bx.w * k * 1.35, bx.h * k * 1.5, .62);   // capul cu părul
    g1.globalCompositeOperation = 'destination-out'; ell(fx, fy, rx * .92, ry * .92, .55); }   // fața rămâne exact cea din poză
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
const bodyText = (c, id) => {
  if(c) return bodyOnly(c, id);   // 9.50: o singură sursă pentru corp
  const m = String(id && id.phys || '').match(/(?:^|; )body: ([^;]+)/);
  const full = c && c.bodyFull && c.photoFull && c.bodyFull.k === c.photoFull ? c.bodyFull.t : '';
  return [m ? m[1] : '', full, c && c.physEn || ''].filter(Boolean).join('; ');
};
// Potrivirea corpului e un pas separat, declanșat doar când verificarea găsește o diferență reală.
const bodyFixOn = (c, shot, opt = {}, id) => S.photoEngine === 'id' && S.bodyFix !== 'off' && S.imgProv === 'worker' && !!S.wkBase && !!c.photo && !opt.together && (c.stil || 'photo') === 'photo' && (!!bodyText(c, id) || !!c.photoFull) && framingOf(shot).k !== 'close';
async function bodyPass(c, blob, signal, shot){
  const prof = c.photo ? await DB.get(c.photo) : null; if(!prof) return null;
  let id = null; try{ id = await identityOf(c); }catch(e){}
  const bt = bodyText(c, id); if(!bt && !c.photoFull) return null;
  let bodySource = prof, bodyRef = null;
  if(c.photoFull){
    const fb = await DB.get(c.photoFull).catch(() => null);
    if(fb){ bodySource = fb; try{ bodyRef = await fullBodyRef(fb, c.fullBox); }catch(e){} }
  }
  if(!bodyRef) bodyRef = await wholeRef(bodySource);
  const exposure = exposureMode(shot);
  const clothing = exposure === 'explicit'
    ? 'Preserve the exact adult nude state in image 1, including visible external genital anatomy if present; do not add clothes, underwear, lingerie, towels or objects covering the body. Keep it non-graphic and not a sexual act.'
    : exposure === 'full'
    ? 'Preserve the exact nude state in image 1: do not add clothes, underwear, lingerie, towels or objects covering the body; keep it natural, non-explicit artistic nudity.'
    : exposure === 'topless'
      ? 'Preserve the exact topless state in image 1: keep the breasts uncovered, with no shirt or bra; preserve the lower-body clothing exactly and do not turn the image into full nudity.'
      : 'Preserve the exact clothing state and outfit in image 1; do not change garments, colors, coverage or accessories.';
  const prompt = `Edit image 1. Change ONLY the person's body proportions to match the same person's body in image 2${bt ? ': ' + bt : ''}. Match the same build, weight, shoulders, arms, bust size and volume, waist, belly, hips, thighs and legs; never slim down, reduce the bust, enlarge unrelated features or idealize the body. ${clothing} Keep everything else in image 1 unchanged: face and identity, hair, expression, pose, hands, room, background, camera angle, framing, lighting and photo grain. The second image is a BODY reference only; take no clothing, pose, background or camera details from it. One seamless, photorealistic, unretouched phone photo.`
  return await genImage(prompt, blob, signal, bodyRef, {model:'eco', force:{two:true}, size:S.wkSize || '768x1024', px1:Math.max(...String(S.wkSize || '768x1024').split('x').map(Number)), quiet:true, why:'corp'});
}
/* 9.35: poza întreagă și variantele din creator ieșeau des cu „altă față” (fața e mică în cadru și generatorul o redesenează).
   Acum, la o variantă care nu seamănă destul, fața e pusă din nou după poza de bază (același retuș ca la pozele din chat),
   de cel mult 2 ori, și rămâne doar dacă telefonul măsoară că s-a apropiat. src: {c} (personaj salvat) sau {prof, box, refD}. */
const FACE_OK = .45;
async function fixFace(v, src, signal, onStep){
  if(!v || v.st !== 'ok' || !v.blob || !src || !(src.refD && src.refD.length)) return false;
  if(v.sameD != null && v.sameD < FACE_OK) return false;
  const model = rwFor('ancorat') || S.wkChat === 'ancorat' ? 'ancorat' : 'eco';
  const dist = async b => { const fs = await faceDescs(b).catch(() => []); return fs.length ? Math.min(...fs.map(f => Math.min(...src.refD.map(r => fdist(f.d, r))))) : 9; };
  let best = v.blob, bd = v.sameD != null ? v.sameD : await dist(v.blob);
  for(let k = 0; k < 2 && bd >= FACE_OK; k++){
    if(onStep) onStep(k);
    let y = null;
    try{ y = await facePass(src.c, best, signal, model, '', 'retus', src.prof ? src : null); }catch(e){ if(e.name === 'AbortError') throw e; break; }
    if(!y) break;
    addUsage((src.c && src.c.id) || (ed && ed.id) || null, imgPrice(), 'img', null, 'profil');
    const d = await dist(y);
    if(d < bd - .01){ best = y; bd = d; }
  }
  if(best === v.blob) return false;
  try{ if(best.type === 'image/png') best = await toJpeg(best, 2048, .92); }catch(e){}
  v.blob = best; v.url = URL.createObjectURL(best); v.fixed = true;
  v.chk = await crCheck(v); v.sameD = bd;
  return true;
}
/* ───────── 9.36: identitatea pe tot: corp, păr, semne ─────────
   (2) Silueta măsurată în telefon (gratuit): umerii și șoldurile din detectorul de poziție (MoveNet) + conturul persoanei
       (segmentarea MediaPipe), lățimea la piept, talie și șolduri raportată la umeri; se compară cu poza întreagă. */
async function bodySig(blob){
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight;
    const kp = await crPose(im); if(!kp) return null;
    const ok = i => kp[i] && kp[i][2] >= .3;
    if(![5, 6, 11, 12].every(ok)) return null;   // fără umeri și șolduri vizibile nu se poate măsura
    const S2 = Math.hypot(kp[5][0] - kp[6][0], kp[5][1] - kp[6][1]); if(S2 < W * .04) return null;
    const mask = await segMask(im), at = (x, y) => { const mx = Math.max(0, Math.min(255, Math.round(x / W * 255))), my = Math.max(0, Math.min(255, Math.round(y / H * 255))); return mask[my * 256 + mx]; };
    const shY = (kp[5][1] + kp[6][1]) / 2, hpY = (kp[11][1] + kp[12][1]) / 2, len = hpY - shY; if(len < H * .05) return null;
    const cxAt = t => ((kp[5][0] + kp[6][0]) / 2) * (1 - t) + ((kp[11][0] + kp[12][0]) / 2) * t;
    const width = t => { const y = shY + len * t, cx = cxAt(t), step = Math.max(1, W / 256); let l = cx, r = cx;
      if(at(cx, y) < .5) return 0;
      while(l > 0 && at(l - step, y) >= .5) l -= step; while(r < W - 1 && at(r + step, y) >= .5) r += step; return (r - l) / S2; };
    const sig = [width(.3), width(.62), width(1.02)];
    const hd = ok(3) && ok(4) ? Math.round(Math.hypot(kp[3][0] - kp[4][0], kp[3][1] - kp[4][1]) / S2 * 1000) / 1000 : null;   // 9.83 (4): lățimea capului (urechi) față de umeri
    if(!sig.every(x => x > .3 && x < 4)) return null;
    // 9.85 (3): conturul în 7 puncte, raportat la lungimea trunchiului (nu la umeri, care se îngustează când se întoarce)
    const r3 = x => Math.round(x * 1000) / 1000, w = [.15, .3, .45, .62, .8, 1.02, 1.15].map(t => r3(width(t) * S2 / len));
    const knY = ok(13) && ok(14) ? (kp[13][1] + kp[14][1]) / 2 : null, anY = ok(15) && ok(16) ? (kp[15][1] + kp[16][1]) / 2 : null;
    const sit = knY != null && knY - hpY < len * .55;   // genunchii aproape de nivelul șoldurilor: stă jos
    const leg = !sit && anY != null && anY > hpY ? r3((anY - hpY) / len) : null;
    const yaw = ok(0) ? r3((kp[0][0] - (kp[5][0] + kp[6][0]) / 2) / S2) : 0;
    return {s:sig.map(r3), len:r3(len / S2), hd, w, leg, sit, yaw, sw:r3(S2 / len)};
  }catch(e){ return null; } finally { URL.revokeObjectURL(u); }
}
async function refBodySig(c){
  const k = c.photoFull || (c.photo ? 'p:' + c.photo : '');   // 9.83 (4): fără poză întreagă, poza de profil, dacă se văd umerii și șoldurile
  if(!k) return null;
  if(c.bodySig && c.bodySig.k === k && c.bodySig.v2) return c.bodySig.v;   // 9.85: măsurătoarea nouă (conturul în 7 puncte)
  const b = await DB.get(c.photoFull || c.photo).catch(() => null); if(!b) return null;
  const v = await bodySig(b); c.bodySig = {k, v, v2:true}; saveChars(); return v;
}
// distanța siluetelor: diferența relativă medie (0 = identic; ~0,1 = puțin diferit; 0,25+ = alt corp)
// 9.83 (4): + lungimea trunchiului și lățimea capului față de umeri (cântărite mai puțin: depind de poză și de unghi)
const bodyDist = (a, b) => { if(!a || !b) return null; let t = a.s.reduce((m, x, i) => m + Math.abs(x - b.s[i]) / Math.max(.3, b.s[i]), 0), n = a.s.length;
  if(a.len && b.len){ t += Math.abs(a.len - b.len) / Math.max(.3, b.len) * .4; n += .4; }
  if(a.hd && b.hd){ t += Math.abs(a.hd - b.hd) / Math.max(.15, b.hd) * .35; n += .35; }
  return t / n; };
// (5) pozele din chat cu fața „sigur aceeași” (măsurată față de poza de profil ORIGINALĂ, nu față de alte repere) intră printre
//     repere în locul unghiurilor automate mai puțin asemănătoare; reperele puse de tine nu se ating. Cel mult 2 (atâtea încap).
const GOOD_REF = .38;
async function profDesc(c){ const b = c.photo ? await DB.get(c.photo).catch(() => null) : null; if(!b) return null; const fs = await faceDescs(b).catch(() => []); return fs.length ? fs.sort((x, y) => y.a - x.a)[0].d : null; }
async function maybeGoodRef(c, blob){
  if(S.autoRefs === 'off' || !c || !c.photo || !blob) return false;
  if((c.refs || []).length && !c.refsAuto) return false;    // repere puse de tine: rămân
  const pd = await profDesc(c); if(!pd) return false;
  const fs = await faceDescs(blob).catch(() => []); if(!fs.length) return false;
  const f = fs.map(x => ({x, d:fdist(x.d, pd)})).sort((a, b) => a.d - b.d)[0]; if(f.d > GOOD_REF || f.x.box.w < 60) return false;
  c.refD = c.refD || {};
  const pool = [];
  for(const k of c.refs || []){ let d = c.refD[k], dsc = null;
    const b = await DB.get(k).catch(() => null); if(!b) continue;
    const r = await faceDescs(b).catch(() => []); if(r.length){ dsc = r.sort((x, y) => y.a - x.a)[0].d; if(d == null) d = fdist(dsc, pd); }
    pool.push({k, d:d == null ? .6 : d, dsc}); }
  if(pool.some(q => q.dsc && fdist(q.dsc, f.x.d) < .18)) return false;   // aproape la fel cu un reper existent: nu aduce un unghi nou
  if(pool.length >= 2){ const worst = pool.sort((a, b) => b.d - a.d)[0]; if(worst.d <= f.d + .02) return false;
    c.refs.splice(c.refs.indexOf(worst.k), 1); delete c.refD[worst.k]; if(c.refBoxes) delete c.refBoxes[worst.k]; await delImg(worst.k).catch(() => {}); }
  const k = await saveImg(blob);
  c.refs = (c.refs || []).concat(k); c.refsAuto = true; c.refD[k] = Math.round(f.d * 1000) / 1000;
  c.refBoxes = c.refBoxes || {}; c.refBoxes[k] = {x:f.x.box.x / f.x.W, y:f.x.box.y / f.x.H, w:f.x.box.w / f.x.W, h:f.x.box.h / f.x.H};
  delete c.faceEmb; await saveChars(); return true;
}
// (6) personajele fără poză întreagă primesc una, o dată, în fundal, după o poză din chat (reperul de corp din 9.32)
async function fullVariants(c, base, signal, draw = () => {}, n = 2){
  let ref = null; try{ const fs = await faceDescs(base); if(fs.length) ref = fs.sort((a, b) => b.a - a.a)[0].d; }catch(e){}
  const id = c.faceBox && c.faceBox.k === c.photo ? c.faceBox : null;
  const body = bodyOnly(c, id);   // 9.50
  const outfit = c.appZones && c.appZones.zones && c.appZones.zones.tinuta ? '' : 'the same clothes as in the photo, completed naturally down to the shoes';
  const p = `Edit this photo into a full-body photo of the same person. ${CR_FRAMES.full.p}. Keep exactly the same face and identity, hairstyle, skin and age.${body ? ' Body: ' + body + '.' : ''} ${outfit ? 'Outfit: ' + outfit + '.' : ''} Natural relaxed standing pose in a fitting everyday place. ${CR_HANDS} ${STIL_TAG[c.stil || 'photo']}`;
  const model = crModel(n, CR_FRAMES.full.size);
  const vars = Array.from({length:n}, () => ({id:uid(), st:'gen', frame:'full', kind:'nou'})); draw(vars);
  await Promise.allSettled(vars.map(async v => {
    try{
      let b = await genImage(p, base, signal, null, {model, size:CR_FRAMES.full.size, force:{two:false, px:1024}, p1:p, quiet:true, why:'profil'});
      addUsage(c.id, imgPrice(), 'img', null, 'profil');
      try{ if(b.type === 'image/png') b = await toJpeg(b, 2048, .92); }catch(e){}
      v.blob = b; v.url = URL.createObjectURL(b); v.st = 'ok'; draw(vars);
      v.chk = await crCheck(v); if(v.chk.d && ref) v.sameD = fdist(v.chk.d, ref); draw(vars);
      if(ref && (v.sameD == null || v.sameD >= FACE_OK)){ v.fixing = true; draw(vars); try{ await fixFace(v, {c, refD:[ref]}, signal); } finally { v.fixing = false; draw(vars); } }   // 9.35
    }catch(e){ v.st = 'err'; v.err = e.name === 'AbortError' ? 'oprit' : e.message; draw(vars); }
  }));
  return vars;
}
async function saveFull(c, v){
  const old = c.photoFull;
  c.photoFull = await saveImg(v.blob); c.fullBox = v.chk && v.chk.box || null; delete c.bodyFull; delete c.bodySig;
  if(old && old !== c.photoFull) await delImg(old).catch(() => {});
  if(c.bsheet){ for(const x of c.bsheet.v || []) delImg(x.k).catch(() => {}); delete c.bsheet; delete c.bsheetTry; }   // 9.85: fișa de corp era a pozei întregi vechi
  await saveChars();
  if(aiReady()) (async () => { try{ const k = c.photoFull, t = await crBodyRead(v.blob, c.id); if(c.photoFull === k){ c.bodyFull = {k, t}; await saveChars(); } }catch(e){} })();   // corpul citit din ea, în fundal
}
let autoFullBusy = false;
async function autoFull(c){
  if(S.autoFull === 'off' || autoFullBusy || !c || !c.photo || c.photoFull || c.autoFullTried || S.imgProv === 'none' || (c.stil && c.stil !== 'photo')) return false;
  if(!rwFor(S.wkChat || S.wkModel) && capLeft() < (neurPerPhoto(S.wkChat || S.wkModel) || 5000) * 3) return false;   // nu consumă ultima parte din limita zilnică
  autoFullBusy = true; c.autoFullTried = Date.now(); await saveChars();
  try{
    const base = await DB.get(c.photo); if(!base) return false;
    const vars = (await fullVariants(c, base, null)).filter(v => v.st === 'ok' && v.chk && v.chk.faces === 1);
    const pick = vars.filter(v => v.sameD != null && v.sameD < .5 && !(v.chk.miss || []).some(m => /picior|tăiat/.test(m))).sort((a, b) => a.sameD - b.sameD)[0];
    if(pick && charById(c.id) && !c.photoFull){ await saveFull(c, pick); toast(`🧍 ${c.name} are acum și o poză întreagă (model pentru corp în pozele din chat). O vezi în profil.`, 4500); return true; }
  }catch(e){} finally { autoFullBusy = false; }
  return false;
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
async function checkPhoto(c, blob, shot, signal, together, asked){
  pstage(signal, '🔍 Se uită dacă a ieșit bine', 97);
  const full = c.photo ? await DB.get(c.photo) : null; if(!full || !aiReady()) return null;
  const exposure = exposureMode(shot), bustVisibleMode = exposure === 'topless' || exposure === 'full' || exposure === 'explicit';
  // 9.88: pentru topless/nuditate non-grafică, verifică separat forma și scara bustului; nu confundă scorul cu silueta generală.
  // 9.36: și poza întreagă (corpul), părul și semnele din pașaport
  const fb = c.photoFull && !together ? await DB.get(c.photoFull).catch(() => null) : null;
  let id = null; try{ id = await identityOf(c); }catch(e){}
  const marks = id && !id.none && Array.isArray(id.marks) ? id.marks.slice(0, 6) : [];
  const imgs = [await blobToB64(await toJpeg(full, 768, .85)), await blobToB64(await toJpeg(blob, 768, .85))]; if(fb) imgs.push(await blobToB64(await toJpeg(fb, 768, .85)));
  const out = await stream('You are a strict photo checker. Answer with JSON only.', [{role:'user', images:imgs, text:
`${fb ? 'Image 3 is the same character\'s full-body reference: it defines the exact body (build, weight, bust, waist, belly, hips, arms, legs). ' : ''}Image 1 is the character's profile reference. Image 2 must depict that exact same individual in this scene: "${shot}". Identity is more important than artistic variation. Compare facial geometry, eye spacing, nose, lips, jaw, skin tone, hairline and hairstyle; if the body is visible in both images, also compare overall build and proportions. Do not penalize legitimate changes in clothing, pose, expression, lighting, camera angle or location when those follow the scene description.${together ? ' Image 2 must show exactly two people together in one natural photo (not a collage or split screen); score the character from image 1 for identity.' : ''}
Score strictly from 0 to 10:
- "face": is this unmistakably the same person, not merely a similar-looking person? 10 = strong match, 5 = noticeable identity drift, 0 = different person.
- "scene": does the generated photo match the requested place, activity, clothing and pose?
- "framing": does the camera framing match the requested selfie / mirror / full-body / close-up view?
- "body": is the body in image 2 the same body as in ${fb ? 'image 3' : 'image 1'} (build, weight, bust, waist, hips, proportions)? Ignore clothing and pose. Use null if too little of the body is visible in image 2${fb ? '' : ' or in image 1'}.
${bustVisibleMode ? `- "bust": for this requested topless/nude image, compare visible bust volume, width, forward projection and natural shape against ${fb ? 'image 3 (full-body reference)' : 'image 1 (profile reference)'}. Assess resemblance to this character, not attractiveness or exaggeration. If the reference bust is hidden by clothing or the generated bust is not visible enough to judge, return null. This is a non-graphic anatomy-fidelity check, not an assessment of sexual activity.` : ''}
- "hair": same hair color, length and texture as image 1 (a different hairstyle is fine only if the scene asks for it)? null if the hair is not visible.${marks.length ? `
- "marks": are these permanent marks visible in the right place when that area is visible: ${marks.join('; ')}? null if none of those areas is visible.` : ''}${asked && asked.length ? `
- "asked": the user explicitly asked for these details: ${asked.map(a => '"' + a + '"').join(', ')}. 10 = every one is clearly visible in image 2, 0 = none; list the ones that are missing or wrong in "missing".` : ''}
"fix": if face is below 8 or scene below 6 or framing below 5 or body below 7 or hair below 6${bustVisibleMode ? ' or bust below 7 when score is not null' : ''}${marks.length ? ' or marks below 6' : ''}${asked && asked.length ? ' or asked below 8' : ''}, give ONE short concrete English correction prioritizing identity, overall body and bust fidelity when assessable, then hair${asked && asked.length ? ', then missing requested details' : ''}, then scene; otherwise "".
JSON: {"face":0,"scene":0,"framing":0,"body":0,${bustVisibleMode ? '"bust":null,' : ''}"hair":0,${marks.length ? '"marks":0,' : ''}${asked && asked.length ? '"asked":0,"missing":[],' : ''}"fix":""}`}], {max:260, signal, cid:c.id, aux:true, tag:'pozeai'});
  const j = parseJSON(out), n = k => Math.max(0, Math.min(10, Math.round(+j[k] || 0)));
  const r = {face:n('face'), scene:n('scene'), framing:n('framing'), fix:String(j.fix || '').slice(0, 300)};
  const nn = k => j[k] == null || j[k] === '' ? null : n(k);   // 9.36: null = nu se vede
  r.body = nn('body'); if(bustVisibleMode) r.bust = nn('bust'); r.hair = nn('hair'); if(marks.length) r.marks = nn('marks'); if(fb) r.bodyRef = 'intreaga';
  if(asked && asked.length){ r.asked = j.asked == null ? null : n('asked'); const miss = (Array.isArray(j.missing) ? j.missing : []).map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 6);
    if(miss.length){ r.missing = miss; if(!/as requested|requested/i.test(r.fix)) r.fix = ('Show exactly as requested: ' + miss.join(', ') + '. ' + r.fix).slice(0, 300); } }   // 9.33
  return r;
}
// 9.7: o refacere costă cât o poză nouă; pe 9B se reface doar ce e clar greșit (pe Eco, ieftin, rămân pragurile de dinainte)
const checkSerious = x => !!x && ((x.d != null && x.d > .55) || (x.scene != null && x.scene < 5) || (x.framing != null && x.framing < 4));
const checkBad = x => !!x && ((x.d != null && x.d > ID_MAX) || (x.scene != null && x.scene < 6) || (x.framing != null && x.framing < 5) || (x.hair != null && x.hair < 6) || (x.marks != null && x.marks < 6) || (x.body != null && x.body < 6) || (x.bust != null && x.bust < 6));
const checkScore = x => !x ? 0 : (x.d != null ? (1 - x.d) * 20 : (x.face != null ? x.face * 2 : 10)) + (x.scene ?? 5) + (x.framing ?? 5) * .5 + (x.hair ?? 5) * .7 + (x.marks ?? 5) * .5 + (x.body ?? 5) * .8 + (x.bust ?? 5) * .65;
/* 8.25: cea mai bună din N. Asemănarea variază mult de la o generare la alta (74–87% pe același model), deci se fac
   N variante în paralel (Worker), telefonul le măsoară gratuit fața și o păstrează pe cea mai apropiată de poza de profil.
   Doar ea trece mai departe (retuș, verificare Haiku). N scade singur dacă limita zilnică de neuroni nu ajunge. */
function bestN(c, opt = {}){
  if(S.imgProv !== 'worker' || !c.photo || opt.together || useF3()) return 1;   // 9.43: FLUX 3 ține identitatea din prima (și costă cât ~10 klein)
  const mdl = sceneModel(opt), per = neurPerPhoto(mdl) || 5000;
  let n = Math.max(1, Math.min(3, +(mdl === 'eco' ? S.bestOf : S.bestOf9 || '1') || 1));
  if(rwFor(mdl)) while(n > 1 && rwCapLeft() < rwPer() * n) n--;   // 9.18: pe Runware limita e plafonul zilnic în $, nu neuronii
  else while(n > 1 && capLeft() < per * n) n--;
  return n;
}
async function bestScene(c, shot, signal, corr, opt = {}){
  let n = opt.n || bestN(c, opt);
  const dr = n >= 2 && draftsOn(c, opt); if(dr) n = Math.min(4, n + 1);   // 9.83 (3): schițe mai mici, una în plus
  if(n < 2) return await scenePhoto(c, shot, signal, corr, opt);
  const o2 = dr ? {...opt, size:draftSize()} : opt;
  if(dr) pstage(signal, `✏️ Face ${n} schițe`, 90);
  const tG = performance.now();
  const batch = async (cr, m) => {   // 9.86: toate schițele într-o singură cerere Runware; ce lipsește, în paralel, ca înainte
    let rs = null;
    if(dr && S.photoEngine !== 'id' && !opt.partner){
      try{ const r0 = await scenePhoto(c, shot, signal, cr, {...o2, multi:m}); const arr = r0.blobs || [r0.blob];
        rs = arr.slice(0, m).map(b => ({status:'fulfilled', value:{...r0, blob:b, blobs:undefined}}));
        if(rs.length < m) rs = rs.concat(await Promise.allSettled(Array.from({length:m - rs.length}, () => scenePhoto(c, shot, signal, cr, {...o2, why:'variante'})))); }
      catch(e){ if(e.name === 'AbortError') throw e; rs = null; } }
    return rs || await Promise.allSettled(Array.from({length:m}, (_, k) => scenePhoto(c, shot, signal, cr, k ? {...o2, why:'variante'} : o2)));
  };
  const rs = await batch(corr, n);
  tmAdd(opt, dr ? 'schite' : 'variante', tG);
  const ab = rs.find(r => r.status === 'rejected' && r.reason && r.reason.name === 'AbortError'); if(ab) throw ab.reason;
  const ok = rs.filter(r => r.status === 'fulfilled').map(r => r.value);
  if(!ok.length) throw rs[0].reason;
  pstage(signal, '🎯 Alege poza cea mai reușită', 93);
  const tP = performance.now();
  for(const x of ok){ x.fd = (await localFace(x.blob, c)).d; x.sh = await sharpOf(x.blob); }   // 9.87 (4): și claritatea
  // 9.36: și silueta (piept, talie, șolduri) față de poza întreagă, măsurată în telefon; fața rămâne criteriul principal
  const rb = framingOf(shot).k !== 'close' ? await refBodySig(c).catch(() => null) : null;
  const rbs = rb ? await refBodySigs(c).catch(() => []) : []; if(rb) for(const x of ok){ x.bd = await bodyMatch(c, await bodySig(x.blob).catch(() => null), rbs); }   // 9.85: față de poza de corp cu aceeași poziție
  // 9.42: cu motorul „ca în creator”, contează și cât respectă cererea (altfel câștiga varianta care copia poza de profil)
  // 9.86 (d): cât respectă cererea se întreabă doar dacă ai cerut detalii sau dacă primele două sunt aproape (altfel e clar cine câștigă)
  const shMax = () => Math.max(0, ...ok.map(x => x.sh || 0));
  const pre = x => (x.fd ?? .9) * pfbW(c, 'face') + (x.bd != null ? Math.min(.5, x.bd) : (rb ? .08 : 0)) * pfbW(c, 'body') + sharpPen(x, shMax());
  const ord = ok.map(pre).sort((a, b) => a - b), close2 = ord.length > 1 && ord[1] - ord[0] < .06;
  if(S.photoEngine !== 'id' && ok.length > 1 && aiReady() && S.imgCheck !== 'off' && ((opt.asked && opt.asked.length) || close2)){ const sc = await adhScores(c, ok, shot, opt.asked, signal); if(sc) ok.forEach((x, k) => x.adh = sc[k]); }
  // 9.86 (corp): dacă în nicio schiță corpul nu trece, încă o tură, cu corectura de corp, înainte de poza mare (o dată)
  if(dr && rb && !opt.bodyRound && ok.every(x => x.bd != null && x.bd > bodyGate(c)) && rwCapLeft() >= rwPer() * n){
    pstage(signal, '🧍 Corpul nu seamănă în nicio schiță, încă o tură', 92);
    try{ let id = null; try{ id = await identityOf(c); }catch(e){}
      const rs2 = await batch([corr, `the body must match the full-body reference exactly: ${bodyOnly(c, id) || 'the same build and proportions'}`].filter(Boolean).join('; '), n);
      const ab2 = rs2.find(r => r.status === 'rejected' && r.reason && r.reason.name === 'AbortError'); if(ab2) throw ab2.reason;
      const ok2 = rs2.filter(r => r.status === 'fulfilled').map(r => r.value);
      for(const x of ok2){ x.fd = (await localFace(x.blob, c)).d; x.sh = await sharpOf(x.blob); x.bd = await bodyMatch(c, await bodySig(x.blob).catch(() => null), rbs); x.round2 = true; }
      ok.push(...ok2); opt.bodyRound = true;
    }catch(e){ if(e.name === 'AbortError') throw e; } }
  const tot = x => (x.fd ?? .9) * pfbW(c, 'face') + (x.bd != null ? Math.min(.5, x.bd) : (rb ? .08 : 0)) * pfbW(c, 'body') + sharpPen(x, shMax()) - (x.adh != null ? x.adh * .03 * pfbW(c, 'scene') : 0);   // 9.85 (4): corpul cântărește cât fața   // 9.83 (8): ce respingi des cântărește mai mult
  ok.sort((a, b) => tot(a) - tot(b));
  if(ok.length > 1) addUsage(c.id, imgPrice() * (ok.length - 1), 'img', null, opt.tag || 'poze');   // prima e numărată de cine a cerut poza
  let best = ok[0]; best.cands = ok.map(x => x.fd); best.shCands = ok.map(x => x.sh); if(rb) best.bodyCands = ok.map(x => x.bd); if(ok.some(x => x.adh != null)) best.adhCands = ok.map(x => x.adh);
  tmAdd(opt, 'alegere', tP);
  if(dr){ const tF = performance.now(); best = await draftFinal(c, best, shot, signal, opt); best.drafts = ok.length; tmAdd(opt, 'final', tF); }
  return best;
}
// generează, retușează fața, verifică; dacă e cazul, încă un retuș (9B) sau o refacere completă; păstrează varianta mai bună
const otherBad = x => !!x && ((x.scene != null && x.scene < 6) || (x.framing != null && x.framing < 5) || (x.hair != null && x.hair < 6) || (x.marks != null && x.marks < 6) || (x.body != null && x.body < 6) || (x.bust != null && x.bust < 6));
/* ═════════ 🎯 9.21 identitate maximă pe Runware ═════════
   Un generator redesenează fața la fiecare poză, deci 1:1 perfect nu există; ce se poate: (1) 3 variante în paralel, telefonul
   măsoară fața fiecăreia (face-api, gratuit) și o păstrează pe cea mai apropiată de poza de profil; (2) dacă și aceea e „altă față”
   (distanță > 0,5), încă o tură de 3; (3) retușul feței cu ACELAȘI model (9B pe Runware): doar fața e redesenată după poza de profil
   și lipită la loc; rămâne numai dacă telefonul măsoară că e mai aproape. Doar pentru pozele din chat (nu stories/statusuri). */
const idBoostOn = (c, opt = {}) => S.idBoost !== 'off' && S.imgProv === 'worker' && !!c.photo && !opt.together && !isAuto(opt)
  && (c.stil || 'photo') === 'photo' && rwFor(sceneModel(opt));
async function idBoost(c, shot, signal, corr, opt = {}){
  const n = Math.max(1, Math.min(3, Math.floor(rwCapLeft() / rwPer())));
  let best = await bestScene(c, shot, signal, corr, {...opt, n});
  if(best.fd != null && best.fd > idMax(c) && rwCapLeft() >= rwPer() * n){
    pstage(signal, '🎯 Nu seamănă destul, mai încearcă', 93);
    try{
      const b2 = await bestScene(c, shot, signal, corr, {...opt, n, why:'variante'});
      addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze');
      if(b2.fd != null && b2.fd < best.fd) best = b2;
    }catch(e){ if(e.name === 'AbortError') throw e; }
  }
  if(rwFor('ancorat') && rwCapLeft() >= rwPer() && (best.fd == null || best.fd > FACE_RET)){   // 9.86 (e): fața deja foarte apropiată → fără retuș
    pstage(signal, '✨ Potrivește fața după poza de profil', 95); const tR = performance.now();
    try{
      const r = await retouchBest(c, best.blob, signal, 'ancorat', shot, 'retus');
      if(r){ addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze'); if(r.used){ best.blob = r.blob; best.fd = r.d; best.retouched = true; } }
    }catch(e){ if(e.name === 'AbortError') throw e; }
    tmAdd(opt, 'retus', tR);
  }
  return best;
}
async function makeScenePhoto(c, shot, signal, opt = {}){
  const r = await makeScenePhoto0(c, shot, signal, opt);
  if(r.bd != null && r.bd > bodyGate(c) && !opt.together && !opt.partner) r.bodyWarn = bodyPct(r.bd);   // 9.85 (6)
  // 9.50: ce a primit generatorul și cât seamănă, pentru „Ce scenă a ales” (de ce arată diferit)
  try{
    let id = null; try{ id = await identityOf(c); }catch(e){}
    const T = idText(c, id);
    if(r.fd === undefined && !opt.together && !opt.partner) r.fd = (await localFace(r.blob, c)).d;
    r.gen = {eng:r.engine || (S.photoEngine === 'id' ? 'id' : 'creator'), mdl:useF3() ? 'FLUX 3' : (S.wkChat || S.wkModel) === 'eco' ? 'Klein 4B' : 'Klein 9B', refs:r.refs || (S.photoEngine === 'id' ? 'față + corp + unghiuri' : 'față'),
      src:T.src, look:T.t.slice(0, 600), fd:r.fd != null ? Math.round(r.fd * 1000) / 1000 : null, ret:!!r.retouched, bfix:!!r.bodyRetry,
      sheet:sheetPick(c, shot).map(s => SHEET_RO[s.ang]), bwarn:r.bodyWarn ?? null, fast:!!r.fast, tm:tmOn(opt) ? {...opt.tm.s} : null, dr:r.drafts || 0, dfd:r.draftFd != null ? Math.round(r.draftFd * 1000) / 1000 : null, fix:r.fixed || [], miss:opt.miss || '', corr:r.corr0 ? r.corr0.slice(0, 300) : ''};   // 9.83
    // portretul și poza întreagă: aceeași persoană? (chatul ia fața din portret)
    if(c.photoFull){ const k = c.photo + '|' + c.photoFull;
      if(!c.pfDist || c.pfDist.k !== k){ const fb = await DB.get(c.photoFull).catch(() => null); const d = fb ? (await localFace(fb, c)).d : null; c.pfDist = {k, d}; saveChars(); }
      if(c.pfDist.d != null) r.gen.pf = Math.round(c.pfDist.d * 1000) / 1000; }
  }catch(e){}
  return r;
}
async function makeScenePhoto0(c, shot, signal, opt = {}){
  if(exposureMode(shot) === 'explicit' && !clearlyAdultCharacter(c)) throw new Error('Pentru nuditate anatomică explicită, fișa personajului trebuie să precizeze clar că este adult (18+).');
  const boost = idBoostOn(c, opt) && !useF3();
  const gen0 = (corr, o) => boost ? idBoost(c, shot, signal, corr, o) : scenePhoto(c, shot, signal, corr, o);
  // 9.50: o singură variantă: silueta se măsoară în telefon față de poza întreagă; dacă e alt corp, încă o încercare (o dată)
  const gen = async (corr, o) => {
    const x = await gen0(corr, o);
    if(x.bd !== undefined || o.together || o.partner || framingOf(shot).k === 'close' || (c.stil || 'photo') !== 'photo') return x;
    const rb = await refBodySig(c).catch(() => null); if(!rb) return x;
    x.bd = await bodyMatch(c, await bodySig(x.blob).catch(() => null));
    if(x.bd == null || x.bd <= bodyMax(c) || corr === 'body' || localFixOn(c, o) || (!rwFor(S.wkChat || S.wkModel) && !useF3())) return x;   // 9.85: cu repararea țintită, corpul se repară întâi local
    try{
      pstage(signal, '🧍 Corpul nu seamănă cu poza întreagă, mai încearcă', 94);
      let id = null; try{ id = await identityOf(c); }catch(e){}
      const y = await gen0(`the body must match exactly: ${bodyOnly(c, id) || 'the same build as the full-body reference'}`, o);
      addUsage(c.id, imgPrice(), 'img', null, o.tag || 'poze');
      y.bd = await bodyMatch(c, await bodySig(y.blob).catch(() => null));
      const fx = x.fd ?? (await localFace(x.blob, c)).d, fy = y.fd ?? (await localFace(y.blob, c)).d;
      if(y.bd != null && y.bd < x.bd - .03 && (fy == null || fx == null || fy <= fx + .05)){ y.fd = fy; y.bodyRetry = true; return y; }
      x.fd = fx;
    }catch(e){ if(e.name === 'AbortError') throw e; }
    return x;
  };
  // 9.83 (8): ce ai spus că n-a mers (și ce respingi des la personajul ăsta) intră ca o corectură de la prima încercare
  let id0 = null; const P0 = pfbGet(c); if(opt.miss || PFB_KEYS.some(k => P0[k] >= 1.5)) try{ id0 = await identityOf(c); }catch(e){}
  const corr0 = opt.together || opt.partner ? '' : pfbCorr(c, id0, opt.miss);
  let a = await gen(corr0 || null, opt);
  if(corr0) a.corr0 = corr0;
  if(S.imgCheck === 'off' || !aiReady()) return a;
  // 9.86 (c): fața, corpul și scena deja măsurate ca bune → fără verificarea cu Claude (câteva secunde mai repede)
  const P1 = pfbGet(c), adhTop = a.adhCands ? Math.max(...a.adhCands.filter(x => x != null)) : null;
  if(!opt.together && !opt.partner && !opt.miss && !(opt.asked && opt.asked.length) && !PFB_KEYS.some(k => P1[k] >= 1.5)
    && a.fd != null && a.fd <= FACE_RET && (framingOf(shot).k === 'close' || (a.bd != null && a.bd <= bodyMax(c) * .8)) && (a.adh == null || a.adh >= 7) && (adhTop == null || adhTop >= 7)){ a.fast = true; return a; }
  const tC = performance.now();
  try{ a.check = await checkPhoto(c, a.blob, shot, signal, opt.together, opt.asked); }catch(e){ if(e.name === 'AbortError') throw e; return a; }
  tmAdd(opt, 'verificare', tC);
  // 9.39: dacă verificarea vede o nepotrivire de corp, încearcă o editare localizată după referința corporală.
  // Se păstrează editarea numai dacă scorul general nu scade și fața/scena rămân stabile.
  if(a.check && a.check.body != null && a.check.body < 7){
    let id = null; try{ id = await identityOf(c); }catch(e){}
    if(bodyFixOn(c, shot, opt, id)){
      try{
        pstage(signal, '🧍 Potrivește proporțiile corpului', 94);
        const fixed = await bodyPass(c, a.blob, signal, shot);
        if(fixed){
          addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze');
          const fc = await checkPhoto(c, fixed, shot, signal, opt.together, opt.asked).catch(e => { if(e.name === 'AbortError') throw e; return null; });
          const quality = x => !x ? 0 : x.face * 2 + x.scene + x.framing * .5 + (x.asked ?? 6) * 1.2 + (x.body ?? 6) * 1.5 + (x.hair ?? 6) * .7 + (x.marks ?? 6) * .5;
          if(fc && fc.body != null && fc.body > a.check.body && fc.face >= a.check.face - 1 && fc.scene >= a.check.scene - 1 && quality(fc) >= quality(a.check) - .5){
            a = {...a, blob:fixed, check:fc, bodyCorrected:true};
          }
        }
      }catch(e){ if(e.name === 'AbortError') throw e; console.warn('Potrivirea corpului nu a reușit:', e); }
    }
  }
  // 9.83 (5): scena e bună și doar fața / părul nu se potrivesc → se repară numai acolo, nu toată poza
  if(a.check && localFixOn(c, opt)){
    const ck = a.check, sceneOk = ck.scene >= 6 && ck.framing >= 5 && (ck.asked == null || ck.asked >= 8);
    const needF = ck.face < 8, needH = ck.hair != null && ck.hair < 6, needB = a.bd != null && a.bd > bodyMax(c) && framingOf(shot).k !== 'close';   // 9.85 (5)
    if(sceneOk && (needF || needH || needB)){
      let blob = a.blob; const done = [], model = rwFor('ancorat') ? 'ancorat' : 'eco', tX = performance.now();
      try{
        if(needF && fixBudget()){ pstage(signal, '✨ Repară doar fața', 95); const r = await retouchBest(c, blob, signal, model, shot, 'retus'); if(r){ addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze'); if(r.used){ blob = r.blob; done.push('față'); } } }
        if(needH && fixBudget()){ pstage(signal, '💇 Repară doar părul', 95); const y = await facePass(c, blob, signal, model, shot, 'retus', null, 'hair'); if(y){ addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze'); blob = y; done.push('păr'); } }
        let bd1 = a.bd;
        if(needB && fixBudget()){ pstage(signal, '🧍 Potrivește doar corpul după poza întreagă', 95);
          const y = await bodyPass(c, blob, signal, shot);
          if(y){ addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze');
            const b2 = await bodyMatch(c, await bodySig(y).catch(() => null)), f0 = (await localFace(blob, c)).d, f1 = (await localFace(y, c)).d;
            if(b2 != null && b2 < a.bd - .03 && (f0 == null || f1 == null || f1 <= f0 + .03)){ blob = y; bd1 = b2; done.push('corp'); } } }   // rămâne doar dacă măsurătoarea se apropie și fața nu se strică
        if(done.length){
          const fc = await checkPhoto(c, blob, shot, signal, opt.together, opt.asked).catch(e => { if(e.name === 'AbortError') throw e; return null; });
          const q = x => x.face * 2 + x.scene + x.framing * .5 + (x.asked ?? 6) * 1.2 + (x.body ?? 6) + (x.hair ?? 6) * .9 + (x.marks ?? 6) * .5;
          const onlyBody = done.length === 1 && done[0] === 'corp';   // corpul e deja confirmat prin măsurare
          if(fc && (q(fc) > q(ck) || (onlyBody && fc.face >= ck.face - 1)) && fc.scene >= ck.scene - 1){ a = {...a, blob, check:fc, fixed:done, bd:bd1}; if(done.includes('față')){ a.retouched = true; a.fd = (await localFace(blob, c)).d; } }
        }
      }catch(e){ if(e.name === 'AbortError') throw e; console.warn('Repararea țintită n-a mers:', e); }
      tmAdd(opt, 'reparare', tX);
    }
  }
  const bodyBad = y => y && y.bd != null && y.bd > bodyGate(c);   // 9.85 (6): garanția de corp, măsurată în telefon
  const bad = x => x && (x.face < 8 || x.scene < 6 || x.framing < 5 || (x.asked != null && x.asked < 8) || (x.body != null && x.body < 7 && !(a.fixed && a.fixed.includes('corp') && a.bd != null && a.bd <= bodyMax(c))) || (x.hair != null && x.hair < 6) || (x.marks != null && x.marks < 6) || (x.bust != null && x.bust < 7) || bodyBad(a));   // 9.85: corpul reparat și confirmat prin măsurare nu mai cere poză nouă   // 9.39: corectare corp înainte de refacerea scenei
  if(!bad(a.check) || (!rwFor(S.wkChat || S.wkModel) && capLeft() < (neurPerPhoto(S.wkChat || S.wkModel) || 5000))) return a;
  let b;
  try{ b = await gen([a.check.fix || (bodyBad(a) ? '' : 'follow the scene and keep the face of the reference'), bodyBad(a) ? 'the body must be exactly the body of the full-body reference: the same build, weight and proportions' : '', corr0].filter(Boolean).join('; '), opt); addUsage(c.id, imgPrice(), 'img', null, opt.tag || 'poze'); }
  catch(e){ if(e.name === 'AbortError') throw e; return a; }
  try{ b.check = await checkPhoto(c, b.blob, shot, signal, opt.together, opt.asked); }catch(e){ if(e.name === 'AbortError') throw e; }
  const sc = x => x ? x.face * 2 + x.scene + x.framing * .5 + (x.asked != null ? x.asked * 1.5 : 0) + (x.body ?? 6) * 1.2 + (x.bust ?? 6) * .7 + (x.hair ?? 6) * .7 + (x.marks ?? 6) * .5 : 0;   // 9.36: „nu se vede” = neutru, nu 0
  const sc2 = x => sc(x.check) - (x.bd != null ? Math.min(.5, x.bd) * 20 : 0);   // 9.85: și corpul măsurat
  const best = b.check && sc2(b) > sc2(a) ? b : a;
  best.retried = true;
  if(corr0) best.corr0 = corr0;
  return best;
}
let wkSimple = false;   // 7.2: Worker-ul a refuzat 2 repere în sesiunea asta
let lastImgModel = '';  // 7.3: modelul folosit la ultima poză (pentru cost)
let lastImgProv = '';   // 8.3: furnizorul folosit la ultima poză (fal pentru chat)
function isImagePolicyError(e){
  const m = String(e && e.message || e || '').toLowerCase();
  return /(?:nsfw|not safe for work|content.?policy|safety filter|safety.?check|moderation|sexual content|explicit content|prohibited content|content blocked|prompt blocked|unsafe prompt|nudity is not allowed|violat(?:es|ion) (?:the )?(?:policy|guidelines)|flagged as)/i.test(m);
}
async function genImage(prompt, ref, signal, ref2, opt = {}){
  if(!opt.quiet){
    if(live && live.stage && live.stage.p >= 95 && busy && busy.signal === signal){ live.stage.pv = 50; }   // a doua încercare: bara coboară la jumătate
    pstage(signal, live && live.stage && live.stage.p >= 95 ? '🔁 Nu-i place, mai face una' : '📸 Face poza', 92);
  }
  const prov = opt.prov || S.imgProv; lastImgProv = prov;
  if(prov === 'worker'){
    const model = opt.model || S.wkModel || 'eco';
    // 9.18: „Fidel · 9B” prin Runware (același model, aceleași repere, același prompt); la eroare sau plafon, cade pe Cloudflare
    const allR = allRw() && !opt.cf;
    if(!opt.cf && (opt.rw ? rwReady() : rwFor(model))){
      try{ return await rwImage(prompt, ref, ref2, opt, signal, model); }
      catch(e){ if(e.name === 'AbortError' || opt.rw) throw e; if(isImagePolicyError(e)) throw new Error('Furnizorul Runware a blocat cererea din cauza regulilor de conținut. Nu încerc aceeași cerere pe alt furnizor; modifică solicitarea sau verifică politica modelului.'); rwFailed(e); if(allR && !(await cfFreeOk(model, opt.size))) throw e; }
    } else if(allR && !(await cfFreeOk(model, opt.size))){
      // 9.37: fără Runware (plafon atins / cheie lipsă) și fără rezervă gratuită: poza se oprește, nu merge pe Cloudflare
      const capHit = rwReady() && rwCapLeft() < rwPer();
      const e = new Error(capHit ? `Ai atins plafonul zilnic Runware (${usd(rwDay().usd)} azi). Pozele revin mâine, sau mărește plafonul din Setări → Poze.` : 'Runware nu e gata: verifică cheia RUNWARE_KEY din Worker (Setări → Poze).');
      e.cap = true; throw e;
    }
    if(!S.wkBase) throw new Error('Lipsește adresa Worker-ului în Setări → Poze.');
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
      if(st.two && ref){ fd.append('image', await toJpeg(ref, opt.px1 || 512, .92), 'ref.jpg'); if(ref2) fd.append('image_1', await toJpeg(ref2, opt.px2 || 512, .92), 'face.jpg');
        for(const [i, x] of (opt.extra || []).slice(0, 2).entries()) fd.append('image_' + (i + 2), await toJpeg(x, 512, .92), 'ref' + (i + 2) + '.jpg'); }
      else if(one) fd.append('image', await toJpeg(one, st.px || 512, .92), 'ref.jpg');
      const r = await fetch(wkUrl() + '/images/generations?bin=1', {method:'POST', signal, body:fd,
        headers: S.wkTok ? {authorization:'Bearer ' + S.wkTok.trim()} : {}});
      if(r.ok){
        // 9.18: Worker-ul v9 poate întoarce poza direct (fără base64), dacă modelul o dă așa; v8 întoarce JSON
        const bin = /^image\//.test(r.headers.get('content-type') || '') ? await r.blob() : null;
        const d = bin ? null : await r.json();
        const b = bin ? 'bin' : d.data?.[0]?.b64_json; if(!b) throw new Error('Worker-ul n-a întors imagine.');
        if(!opt.force && i > 0 && steps[0].two && !wkSimple){ wkSimple = true; console.warn('Worker: 2 repere au dat eroare, folosesc doar poza de profil'); }
        lastImgModel = model;
        neurAdd(neurPerPhoto(model, opt.size) || 5000, opt.why);
        return bin || b64ToBlob(b, 'image/png');
      }
      lastErr = await errText(r);
      if(opt.force || r.status < 500 || i === steps.length - 1) break;   // 4xx (cheie, limită, filtru): nu are rost să reîncercăm
      await new Promise(res => setTimeout(res, 1200 + i * 800));
    }
    if(/\b30(43|40)\b|internal server error|out of capacity/i.test(lastErr || '')) throw new Error('Cloudflare a avut o eroare internă (' + ((lastErr.match(/\b30\d\d\b/) || ['5xx'])[0]) + '), chiar după 3 încercări. De obicei trece în câteva minute; apasă Reîncearcă.');
    throw new Error(lastErr);
  }
  throw new Error('Pozele sunt oprite. Pornește-le din Setări.');
}

/* ═════════ ⚡ 9.18 Runware: „Fidel · 9B” la alt furnizor ═════════
   Același model (FLUX.2 klein 9B, runware:400@2), aceleași repere (fața + poza de profil + până la 2 unghiuri), același prompt,
   aceeași mărime și PNG ca pe Cloudflare, fără accelerare (acceleration:none). Cost real per poză citit din răspuns (includeCost).
   Cheia: în Worker (secretul RUNWARE_KEY, ruta /v1/proxy/runware) sau, opțional, în telefon. Plafon zilnic în $; la eroare
   sau plafon atins, poza merge pe Cloudflare ca înainte. */
const RW_MODEL = 'runware:400@2', RW_URL = 'https://api.runware.ai/v1';
const usd4 = v => '$' + (+v || 0).toFixed(4);   // costurile Runware sunt fracțiuni de cent
const RW_CAP = {'0.25':.25, '0.5':.5, '1':1, none:Infinity};
let rwFails = 0, rwFailT = 0, rwToastT = 0;
const rwDirect = () => !vaultOn() && !!String(S.rwKey || '').trim();
const rwReady = () => rwDirect() || (!!String(S.wkBase || '').trim() && !!String(S.wkTok || '').trim() && !(S.vaultHas && S.vaultHas.runware === false));
function rwDay(){ const d = new Date().toISOString().slice(0, 10); if(!S.rwBy || S.rwBy.d !== d) S.rwBy = {d, usd:0, n:0}; return S.rwBy; }
const rwPer = () => S.rwAvg > 0 ? S.rwAvg : .004;                       // estimare până la primele poze reale
const rwCapLeft = () => (RW_CAP[S.rwCap] ?? .5) - rwDay().usd;
const rwPaused = () => rwFails >= 3 && Date.now() - rwFailT < 10 * 60e3;   // 3 erori la rând: 10 minute pe Cloudflare, apoi încearcă iar
/* 9.37: „Totul pe Runware” (S.imgRoute = 'rw'): orice poză (și Eco: avatare, retușuri, expresii, creator, stories) merge pe Runware,
   cu FLUX.2 klein 9B, iar Cloudflare Workers AI (neuronii) nu mai e folosit deloc, în afară de rezerva aleasă de tine
   (S.cfFallback = 'free': doar cât intră în cei 10.000 de neuroni gratuiți de azi). Worker-ul rămâne doar intermediar (cheile, notificările). */
const allRw = () => S.imgRoute === 'rw' && S.rw === 'on' && S.imgProv === 'worker';
const rwFor = model => S.rw === 'on' && S.imgProv === 'worker' && (model === 'ancorat' || S.imgRoute === 'rw') && rwReady() && (S.imgRoute === 'rw' || !rwPaused()) && rwCapLeft() >= rwPer();
// rezerva pe Cloudflare, doar în cota gratuită de azi (cu cât rămâne după estimarea poziei)
async function cfFreeOk(model, size){
  if(S.cfFallback !== 'free' || !S.wkBase) return false;
  try{ await fetchNeurons(); }catch(e){}
  neurCalc(); return 10000 - neurToday >= (neurPerPhoto(model, size) || 5000);
}
function rwFailed(e){
  rwFails++; rwFailT = Date.now();
  if(Date.now() - rwToastT > 5 * 60e3){ rwToastT = Date.now(); toast('⚡ ' + String(e.message).slice(0, 140) + (allRw() ? (S.cfFallback === 'free' ? ' Încerc pe Cloudflare, doar în cota gratuită.' : ' Pozele sunt doar pe Runware (rezerva Cloudflare e oprită).') : ' Poza merge pe Cloudflare.'), 6000); }
}
function rwSize(size){ return String(size || S.wkSize || '768x1024').split('x').map(v => Math.min(2048, Math.max(128, Math.round((parseInt(v, 10) || 1024) / 16) * 16))); }
async function rwImage(prompt, ref, ref2, opt, signal, model){
  // aceleași repere ca pe Worker: 2 repere = fața (image) + poza de profil (image_1) + unghiurile; reper unic = poza de profil
  const two = opt.force ? !!opt.force.two && !!ref : !!(ref && ref2), refs = [];
  if(two){ refs.push(await toJpeg(ref, opt.px1 || 512, .92)); if(ref2) refs.push(await toJpeg(ref2, opt.px2 || 512, .92)); for(const x of (opt.extra || []).slice(0, 2)) refs.push(await toJpeg(x, 512, .92)); }
  else { const one = opt.one || (ref2 || ref); if(one) refs.push(await toJpeg(one, (opt.force && opt.force.px) || 1024, .92)); }
  const p = two ? prompt : (opt.p1 || prompt.replace(/,? ?image 2 is a close-up of the same face\. ?/i, ' '));
  const [w, h] = rwSize(opt.size);
  const blob = await rwRun(p, refs, w, h, signal, RW_MODEL, opt.multi || 1);   // 9.86: opt.multi → mai multe rezultate deodată (listă)
  lastImgProv = 'runware'; lastImgModel = model;
  return blob;
}
/* 9.43: 💎 FLUX 3 Image pe Runware (bfl:flux@3-image): model mare, făcut pentru editare și pentru a păstra aceeași persoană din
   imagini de referință (până la 10). Fără seed, pași sau CFG; doar mărimile din tabelul lor (aici treapta 0.75K, ~$0,041/poză);
   „grounding” (căutare pe web înainte de generare) oprit. Se folosește când alegi „💎 FLUX 3” în Setări → Poze → ⚡ Runware. */
const RW_F3 = 'bfl:flux@3-image';
const F3_SIZES = [[1168, 496], [1088, 544], [1024, 576], [944, 624], [912, 656], [880, 672], [864, 688], [768, 768], [688, 864], [672, 880], [656, 912], [624, 944], [576, 1024], [544, 1088], [496, 1168]];
function f3Size(size){ const [w, h] = String(size || '768x1024').split('x').map(Number), r = (w || 3) / (h || 4); return F3_SIZES.slice().sort((a, b) => Math.abs(Math.log(a[0] / a[1] / r)) - Math.abs(Math.log(b[0] / b[1] / r)))[0]; }
const useF3 = () => S.photoModel === 'flux3' && S.rw === 'on' && S.imgProv === 'worker' && rwReady() && rwCapLeft() >= .05;
async function f3Image(prompt, refs, size, signal, why){
  if(!rwReady()) throw new Error('Runware nu e gata: verifică cheia RUNWARE_KEY (Setări → Poze).');
  if(rwCapLeft() < .05){ const e = new Error(`Ai atins plafonul zilnic Runware (${usd(rwDay().usd)} azi). Mărește-l din Setări → Poze sau revino mâine.`); e.cap = true; throw e; }
  if(why !== 'quiet') pstage(signal, '💎 Face poza (FLUX 3)', 92);
  const [w, h] = f3Size(size), jp = [];
  for(const b of (refs || []).filter(Boolean).slice(0, 10)) jp.push(await toJpeg(b, 1024, .92));
  const blob = await rwRun(prompt, jp, w, h, signal, RW_F3);
  lastImgProv = 'runware'; lastImgModel = 'flux3';
  return blob;
}
async function rwRun(prompt, refs, w, h, signal, mdl = RW_MODEL, n = 1){
  const f3 = mdl === RW_F3;
  const task = f3 ? {taskType:'imageInference', taskUUID:crypto.randomUUID(), model:RW_F3, positivePrompt:String(prompt).slice(0, 30000),
      width:w, height:h, numberResults:1, outputType:'base64Data', outputFormat:'JPG', includeCost:true, settings:{grounding:false}}
    : {taskType:'imageInference', taskUUID:crypto.randomUUID(), model:RW_MODEL, positivePrompt:String(prompt).slice(0, 10000),
    width:w, height:h, numberResults:Math.max(1, Math.min(4, n || 1)), outputType:'base64Data', outputFormat:'JPG', outputQuality:94, includeCost:true, acceleration:'none',
    seed:Math.floor(Math.random() * 4294967295)};   // 9.86: JPG (de ~5 ori mai puțin de descărcat); n rezultate într-o singură cerere
  if(refs.length) task.inputs = {referenceImages: await Promise.all(refs.slice(0, f3 ? 10 : 4).map(async b => 'data:image/jpeg;base64,' + await blobToB64(b)))};
  const direct = rwDirect(), url = direct ? RW_URL : wkUrl() + '/proxy/runware/v1';
  const t0 = performance.now();
  let r;
  try{ r = await fetch(url, {method:'POST', signal, headers:{'content-type':'application/json', authorization:'Bearer ' + (direct ? S.rwKey : S.wkTok).trim()}, body:safeJSON([task])}); }
  catch(e){ if(e.name === 'AbortError') throw e; throw new Error('Runware nu răspunde' + (direct ? ' din browser. Pune cheia în Worker (secretul RUNWARE_KEY) și golește câmpul din telefon.' : ' (rețea).')); }
  let d = null; try{ d = await r.json(); }catch(e){}
  const errs = d && (d.errors || (d.error ? [d.error] : null));
  if(!r.ok || errs || !d || !Array.isArray(d.data)){
    if(!direct && r.status === 404) throw new Error('Worker-ul nu știe încă de Runware: pune codul nou (v9) din cloudflare-worker-simplu.js.');
    if(!direct && r.status === 501){ S.vaultHas = {...(S.vaultHas || {}), runware:false}; saveSettings(); throw new Error('Worker-ul n-are cheia Runware: adaugă secretul RUNWARE_KEY.'); }
    const e0 = errs && errs[0], m = typeof e0 === 'string' ? e0 : (e0 && (e0.message || e0.code)) || ('HTTP ' + r.status);
    throw new Error('Runware: ' + String(m).slice(0, 200) + (/credit|balance|insufficient/i.test(m) ? ' (reîncarcă creditul în contul Runware).' : '.'));
  }
  const its = d.data.filter(x => x && (x.imageBase64Data || x.imageDataURI)), it = its[0];
  if(!it) throw new Error('Runware n-a întors imagine.');
  const cost = its.reduce((a, x) => a + (+x.cost || 0), 0) / its.length;   // pe imagine
  if(cost >= 0 && cost < 1){
    const day = rwDay(); day.usd = Math.round((day.usd + cost * its.length) * 1e6) / 1e6; day.n += its.length;
    if(!f3) S.rwAvg = S.rwAvg > 0 ? S.rwAvg * .8 + cost * .2 : cost;   // media ultimelor poze klein (pentru estimări și Consum)
    else S.f3Avg = S.f3Avg > 0 ? S.f3Avg * .8 + cost * .2 : cost;
    S.rwLast = {usd:cost, ms:Math.round(performance.now() - t0), w, h, refs:refs.length}; saveSettings();
  }
  rwFails = 0;
  const blobs = its.map(x => b64ToBlob(x.imageBase64Data || String(x.imageDataURI).split(',')[1], 'image/jpeg'));
  return n > 1 ? blobs : blobs[0];
}
function drawRw(){
  const w = $('#stRwWrap'); if(!w) return;
  w.hidden = S.imgProv !== 'worker';
  $('#stRwBox').hidden = S.rw !== 'on';
  const h = $('#stRwHint'), cf = neurPerPhoto('ancorat') || 1455;
  if(S.rw !== 'on'){ h.innerHTML = `Cloudflare: ~${Math.round(cf).toLocaleString('ro-RO')} neuroni pe poză 9B (cam ${Math.floor(10000 / cf)} pe zi gratuit, apoi ~${usd(cf * NEUR_USD)} pe poză). Runware rulează același model, de câteva ori mai ieftin.`; }
  else {
    const n = S.idBoost !== 'off' ? 4 : 1;
    h.innerHTML = `Același model ca pe Cloudflare. ${S.rwAvg > 0 ? `Cost real: <b>${usd4(S.rwAvg)}</b> pe imagine` : 'Estimat ~$0,002–0,004 pe imagine'}${n > 1 ? ` (~${usd4(rwPer() * n)} pe poză cu identitate maximă)` : ''}. ${S.rwPhoto && S.rwPhoto.n ? `<br>💵 O poză din chat te costă în medie <b>${usd4(S.rwPhoto.avg)}</b> (~${S.rwPhoto.gens.toFixed(1).replace('.', ',')} generări: variante, retuș, refaceri; din ${S.rwPhoto.n} poze).` : ''}<br>${S.imgRoute === 'rw' ? (S.cfFallback === 'free' ? 'Totul pe Runware. Dacă Runware nu răspunde sau atingi plafonul, poza se face pe Cloudflare doar cât intră în cota gratuită de azi (fără cost).' : 'Totul pe Runware. Dacă Runware nu răspunde sau atingi plafonul, poza se oprește cu un mesaj; Cloudflare nu mai e folosit deloc pentru poze.') : 'Doar pozele 9B merg pe Runware. Eco (avatare, retușuri, expresii) și pozele de rezervă se fac pe Cloudflare.'}`
      + (rwDirect() ? '' : !S.wkBase ? '<br>⚠️ Pune adresa Worker-ului sau cheia Runware în telefon.' : '<br>Cheia: secretul <b>RUNWARE_KEY</b> din Worker.');
    const day = rwDay(), cap = RW_CAP[S.rwCap] ?? .5, pc = Number.isFinite(cap) ? Math.min(100, day.usd / cap * 100) : 0;
    $('#stRwDay').innerHTML = `Azi pe Runware: <b>${usd(day.usd)}</b> · ${day.n} ${day.n === 1 ? 'imagine' : 'imagini'}${Number.isFinite(cap) ? ' · plafon $' + cap.toFixed(2).replace('.', ',') + `<div class="bar"><i style="width:${pc}%"></i></div>` : ' · fără plafon'}`
      + (S.rwLast ? `<div style="margin-top:6px;font-size:12px;color:var(--tx3)">Ultima: ${usd4(S.rwLast.usd)} · ${(S.rwLast.ms / 1000).toFixed(1).replace('.', ',')} s · ${S.rwLast.w}×${S.rwLast.h} · ${S.rwLast.refs} repere</div>` : '');
  }
}
async function rwTest(){
  for(const [id, k] of Object.entries(FIELDS)) S[k] = $('#' + id).value.trim(); saveSettings();
  const r = $('#stRwRes'); r.className = 'status'; r.innerHTML = '<span class="spin"></span> Generez o poză de test pe Runware…';
  try{
    if(S.vaultHas && S.vaultHas.runware === false){ delete S.vaultHas.runware; rwFails = 0; }   // poate ai pus între timp secretul în Worker
    if(!rwReady()) throw new Error('Pune cheia Runware în Worker (RUNWARE_KEY) sau aici, în telefon.');
    const b = await rwRun('a cup of coffee on a wooden table by a window, morning light, real smartphone photo', [], 512, 512, null);
    r.className = 'status ok';
    r.innerHTML = `✓ Runware merge${S.rwLast ? ` · ${usd4(S.rwLast.usd)} · ${(S.rwLast.ms / 1000).toFixed(1).replace('.', ',')} s` : ''}.<br><img src="${URL.createObjectURL(b)}" style="width:140px;border-radius:12px;margin-top:8px" alt=""><br><span class="hint">Pentru fața personajului tău: „🔬 Compară pe personajul meu” (pune 9B Cloudflare lângă 9B Runware).</span>`;
    drawRw();
  }catch(e){ r.className = 'status err'; r.textContent = '✗ ' + e.message; }
}

/* ───────── navigare ───────── */
const VIEWS = ['vHome', 'vChat', 'vEdit', 'vSet', 'vWelcome', 'vProf', 'vGroup'];
let flyNext = false, vtT = 0;
// 9.15: lucruri de făcut după ce ecranul nou s-a așezat (după glisare), ca să nu încarce animația
let viewTok = 0; const settleQ = [];
function afterShow(fn){ settleQ.push(fn); }
function viewSettled(tok){ if(tok !== viewTok) return; const q = settleQ.splice(0); q.forEach(fn => { try{ fn(); }catch(e){ console.warn(e); } }); }
function show(id, push = true, dir){
  const was = VIEWS.find(v => !$('#' + v).hidden);
  VIEWS.forEach(v => $('#' + v).hidden = v !== id);
  const el = $('#' + id);
  // 8.9: ecranul vechi rămâne vizibil cât timp alunecă (are deja `hidden`, deci logica îl vede închis)
  $$('.view').forEach(v => v.classList.remove('vin-f', 'vin-b', 'vin-z', 'vout-f', 'vout-b', 'vout-z', 'vprep-f', 'vprep-b', 'vprep-z', 'vhold')); clearTimeout(vtT);
  const tok = ++viewTok;
  if(was && was !== id && fxOn()){
    const d = flyNext ? 'z' : (dir || (push ? 'f' : (id === 'vHome' ? 'b' : 'f'))) === 'f' ? 'f' : 'b';
    const old = $('#' + was);
    // 9.15: ecranul nou se așază și se desenează întâi în afara vederii (cât construiește chatul, lista…), iar glisarea pornește
    //       abia după aceea: animația nu mai pierde cadre cu construirea ecranului
    el.classList.add('vprep-' + d); old.classList.add('vhold');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if(tok !== viewTok) return;
      el.classList.remove('vprep-' + d); old.classList.remove('vhold');
      el.classList.add('vin-' + d); old.classList.add('vout-' + d);
      vtT = setTimeout(() => { el.classList.remove('vin-' + d); old.classList.remove('vout-' + d); viewSettled(tok); }, 380);
    }));
  } else setTimeout(() => viewSettled(tok), 0);
  flyNext = false;
  if(push && id !== 'vHome' && !(history.state && history.state.v === id)) history.pushState({v:id}, '');
}
let edLeaveOK = false;   // 9.25: ieșirea din editor cu poze nesalvate a fost confirmată
function back(){
  if(!$('#vSet').hidden && setPanel && !setPanelPushed){ closeSetPanel(); return; }
  if(!$('#vEdit').hidden && edDirty() && !edLeaveOK){ confirmSheet('Ai poze generate și nesalvate. Ieși fără să salvezi personajul?', 'Ieși', () => { if(ed && ed.cr && ed.cr.ac) ed.cr.ac.abort(); edLeaveOK = true; back(); }); return; }   // 9.25
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
  // 9.25: ieși din editor cu poze generate și nesalvate: întâi întreabă
  if(!$('#vEdit').hidden && edDirty() && !edLeaveOK){ history.pushState(history.state, ''); confirmSheet('Ai poze generate și nesalvate. Ieși fără să salvezi personajul?', 'Ieși', () => { if(ed && ed.cr && ed.cr.ac) ed.cr.ac.abort(); edLeaveOK = true; history.back(); }); return; }
  edLeaveOK = false;
  const v = history.state && history.state.v;
  if(!$('#vSet').hidden && setPanel){ closeSetPanel(); return; }
  if(v === 'vProf' && profId && charById(profId)){ charProfile(profId, false); return; }
  if(v === 'vChat' && cur && charById(cur.id)) openChat(cur.id, false, undefined, 'b');
  else if(v === 'vGroup' && grp && groups.includes(grp)) openGroup(grp.id, false);   // 9.44
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
  let h = `<button class="hhero${c.unread ? ' unr' : ''}" data-open="${c.id}">${duoOn(c) ? duoHalves(c, 'hhbg ph') : c.photo ? `<img class="hhbg" data-k="${esc(photoNow(c))}" alt="">` : `<span class="hhbg ph" style="background:${colorFor(c)}"></span>`}
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
  // 9.15: doar cardurile schimbate se refac (înainte, la fiecare întoarcere pe Acasă se refăcea tot, cu pozele decodate din nou)
  patchKeyed($('#homeChars'), [['bk', bk], ['top', top], ['empty', !chars.length ? `<button class="card empty" data-new><b>Niciun personaj încă</b>Apasă ＋ jos ca să creezi primul personaj, din poză sau din imaginație.</button>` : ''],
    ...shown.map(c => ['card:' + c.id, `<button class="card${c.fav ? ' isfav' : ''}" data-open="${c.id}">${c.fav ? '<span class="fav">⭐</span>' : ''}${c.unread ? `<span class="ubadge">${c.unread > 9 ? '9+' : c.unread}</span>` : ''}${c.lastAt && c.last || clockHTML(c) ? `<span class="tl">${c.lastAt && c.last ? `<span class="when">${when(c.lastAt)}</span>` : ''}${clockHTML(c, 'when clk')}</span>` : ''}
      ${duoOn(c) ? duoHalves(c) : c.photo ? `<img data-k="${esc(photoNow(c))}" data-t="m" alt="">` : `<div class="ph" style="background:${colorFor(c)}">${esc(c.name[0] || '?')}</div>`}
      <div class="ov"><b>${esc(c.name)}</b>${c.tag ? `<small>${esc(c.tag)}</small>` : ''}${cardStatus(c)}${c.rel ? `<span class="crel">💞 ${esc(relOf(c).name)}</span>` : ''}${c.last ? `<em class="lm">${esc(c.last)}</em>` : ''}</div></button>`]), ['new', chars.length && !q ? `<button class="card new" data-new><span>＋</span><em>Personaj nou</em></button>` : '']].filter(b => b[1]), homeStore.chars);
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
  const grows = groups.length ? [['gl', '<div class="clabel">👥 Grupuri</div>'], ...[...groups].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).map(g => ['grp:' + g.id, groupRowHTML(g)])] : [['gnew', '<button class="gnewrow" data-gnew>👥 Grup nou: vorbește cu mai multe personaje deodată</button>']];
  patchKeyed($('#homeChats'), [['stories', storyRowHTML()], ...grows, ...(withChat.length
    ? [...(pinned.length ? [['lp', '<div class="clabel">Fixate</div>'], ...pinned.map(c => ['row:' + c.id, crow(c)]), ...(rest.length ? [['lr', '<div class="clabel">Recente</div>']] : [])] : []), ...rest.map(c => ['row:' + c.id, crow(c)]),
      ['hint', '<div class="hint" style="text-align:center;margin:14px 0">Glisează spre stânga pe o conversație ca s-o fixezi sau s-o golești.</div>']]
    : [['none', `<div class="empty">Nicio conversație încă.<br>Alege un personaj din „Acasă".</div>`]])].filter(b => b[1]), homeStore.chats);
  $$('[data-bk]').forEach(b => b.onclick = e => { e.stopPropagation(); const k = b.dataset.bk; if(k === 'later'){ S.bkSnooze = Date.now() + 2 * 864e5; saveSettings(); renderHome(); } else exportAll(k === 'share'); });
  hydrate($('#vHome')); bindStoryRow($('#vHome'));
}
function when(ts){
  if(!ts) return '';
  const d = new Date(ts), n = new Date();
  if(d.toDateString() === n.toDateString()) return d.toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'});
  return d.toLocaleDateString('ro-RO', {day:'numeric', month:'short'});
}

/* ───────── 9.44 / 9.45: 👥 GRUPURI ─────────
   O conversație cu 2-5 personaje deodată. 9.45: (1) ritm real: „X scrie…” cât ar dura, uneori două scriu deodată, mesaje în
   rafală (2-3 bule); (2) nu răspunde toată lumea: unele doar reacționează (❤️ 😂 👍 pe mesajul tău sau al alteia), altele tac;
   „văzut de …” sub mesajul tău; (3) răspuns la un mesaj anume, citat (și tu poți răspunde la un mesaj din grup); (4) dinamica
   grupului (roluri, cine cu cine, tensiuni, glume interne) ținută la zi și folosită de „regizor” și de fiecare personaj;
   (5) selfie de la una din ele, pe fața ei; (6) poză cu mai multe deodată (fețele tuturor ca repere); (7) grupul trăiește și fără
   tine: cât lipsești își scriu între ele, iar când revii ai mesajele noi și un rezumat; (8) bârfa în privat: una din ele îți scrie
   separat, în chatul ei; (9) ce se vorbește în grup intră în memoria fiecăreia (rezumatul grupului + fapte noi despre tine);
   (12) „💬 Răspunde-i în privat” pe un mesaj din grup. Datele: DB `groups` și `grp:<id>` ({msgs, dyn, recap, …}). */
let groups = [], grp = null, gchat = null, gbusy = null, gReply = null, gSpect = null;
// 9.48 (15): personalitatea grupului
const G_TONES = {
  normal:{e:'💬', n:'Firesc', dir:'natural everyday group chat', sys:'', life:'6-10', pace:1, max:3},
  calm:{e:'🌿', n:'Liniștit', dir:'calm and gentle: usually only ONE character replies, short and warm; more emoji reactions or just reading', sys:'Grupul e liniștit: mesaje calme, puține și blânde, fără agitație.', life:'4-6', pace:1.35, max:2},
  haos:{e:'🌪️', n:'Haotic', dir:'chaotic: 2-3 characters reply, they interrupt and tease each other, inside jokes, double-texting, many emoji reactions', sys:'Grupul e haotic: vă întrerupeți, glume interne, mesaje scurte și dese, emoji, entuziasm, uneori majuscule.', life:'9-12', pace:.6, max:3},
  romantic:{e:'💞', n:'Romantic', dir:'romantic: warm, affectionate and flirty toward the user; compliments, tender teasing, sweet hints; a little playful jealousy between characters for the user\'s attention; 1-3 replies, never crude', sys:'Grupul e romantic: tandrețe, flirt jucăuș și complimente pentru el, aluzii dulci, fiecare în stilul ei; puțină gelozie jucăușă între ele pentru atenția lui, fără răutate. Romantic, nu vulgar: în grup nimic explicit.', life:'6-9', pace:1.1, max:3},   // 9.67
  drama:{e:'🎭', n:'Dramatic', dir:'romantic-dramatic: big emotional reactions, strong opinions, small conflicts and reconciliations, gossip', sys:'Grupul e romantic-dramatic: emoții mari, opinii tari, mici tensiuni și împăcări, bârfă, ofuri.', life:'7-10', pace:1, max:3},
  munca:{e:'💼', n:'De muncă', dir:'work group: to the point, organized, polite, task-oriented, light humor; nothing intimate', sys:'E un grup de muncă: la obiect, organizat, politicos, cu umor discret; fără nimic intim.', life:'4-7', pace:.9, max:2}
};
const gTone = g => G_TONES[g && g.tone] || G_TONES.normal;
// 9.48 (5): relațiile dintre personaje în grup (gc.rel: {"id1|id2": {t, s:-2..2, at}})
const gRelOf = (gc, a, b) => gc && gc.rel ? gc.rel[pairKey(a.id, b.id)] || null : null;
const G_RELC = {'2':'#3ecf8e', '1':'#9be27a', '0':'#9aa0ad', '-1':'#f5a623', '-2':'#ff5c6c'};
const G_RELN = {'-2':'Ceartă', '-1':'Reci', '0':'Neutre', '1':'Apropiate', '2':'Foarte apropiate'};
/* 9.59: față de tine, în grupul ăsta: cât ține la tine (care) și cât e gata să te ajute (help), 0-100; gc.me[cid] = {care, help, why, lock, at}.
   Pornește de la relația din chatul privat (bondOf); AI-ul le mișcă puțin câte puțin, iar ce fixezi tu (lock) nu mai atinge. */
const gClamp = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
function gMeOf(gc, c){
  const m = gc && gc.me && gc.me[c.id]; if(m) return m;
  const b = bondOf(c), care = gClamp((b.warm + b.trust) / 2);
  return {care, help:b.help != null ? gClamp(b.help) : gClamp(care - (b.tension || 0) / 2), auto:true};   // 9.74: „cât te ajută” setat în privat
}
const gCareHint = v => v >= 80 ? 'Ține enorm la tine; ești printre cei mai importanți oameni pentru ea.' : v >= 60 ? 'Ține mult la tine; îi pasă sincer ce faci.' : v >= 40 ? 'Ține la tine ca la un prieten bun.' : v >= 20 ? 'Te place, dar cu rezervă.' : 'Nu prea îi pasă de tine; e rece și distantă.';
const gHelpHint = v => v >= 80 ? 'Face orice ca să te ajute; e primul om pe care te poți baza.' : v >= 60 ? 'Te ajută repede și concret, chiar dacă nu ceri.' : v >= 40 ? 'Te ajută când îi ceri, cu sfaturi și puțin timp.' : v >= 20 ? 'Ajută doar dacă o rogi direct și nu o costă mult.' : 'Nu-și bate capul să te ajute; mai degrabă evită.';
const gMeCol = v => v >= 80 ? '#ff4f9a' : v >= 60 ? '#3ecf8e' : v >= 40 ? '#9be27a' : v >= 20 ? '#f5a623' : '#ff5c6c';
const gCareWord = v => v >= 80 ? 'ții enorm la el; e printre cei mai importanți oameni pentru tine' : v >= 60 ? 'ții mult la el; îți pasă sincer ce face și cum se simte' : v >= 40 ? 'ții la el ca la un prieten bun' : v >= 20 ? 'îl placi moderat, cu rezervă; nu ești foarte atașată' : 'nu prea îți pasă de el; ești rece și distantă cu el';
const gHelpWord = v => v >= 80 ? 'faci orice ca să-l ajuți: ești primul om pe care se poate baza, sari cu ajutor concret chiar dacă te costă' : v >= 60 ? 'îl ajuți repede și concret când are nevoie (timp, idei, o mână de ajutor), chiar dacă nu te roagă' : v >= 40 ? 'îl ajuți când îți cere, cu sfaturi și puțin timp' : v >= 20 ? 'ajuți doar dacă te roagă direct și nu te costă mult; mai degrabă dai un sfat scurt' : 'nu-ți bați capul să-l ajuți; mai degrabă eviți sau schimbi subiectul';
const saveGroups = () => DB.set('groups', groups);
const gMembers = g => (g && g.members || []).map(charById).filter(Boolean);
const G_REACT = ['❤️', '😂', '👍', '😮', '😢', '🔥', '🙄', '👏'];
const G_ALL = /(?<!\p{L})(toți|toti|toată lumea|toata lumea|voi toate|voi toți|voi toti|voi doi|voi două|voi doua|voi trei|amândoi|amandoi|amândouă|amandoua|fetelor|fetele mele|băieților|baietilor|băieți|baieti|tuturor|oameni buni|grupule|grupul meu)(?!\p{L})/iu;   // 9.57: fără „voi” / „toate” / „grup” / „împreună” singure (ex. „voi veni”, „toate bune” nu înseamnă toată lumea)
function groupRowHTML(g){
  const ms = gMembers(g), last = g.last || 'Grup nou', un = g.unread || 0;
  return `<div class="crow"><button class="cfront${un ? ' unr' : ''}" data-gopen="${g.id}"><span class="cav gstack">${ms.slice(0, 3).map(c => avatarHTML(c)).join('')}</span>
    <span class="cmid"><span class="ctop"><b>👥 ${esc(g.name)}</b><time class="${un ? 'new' : ''}">${when(g.lastAt)}</time></span><span class="cbot"><small>${esc(last)}</small>${un ? `<span class="badge">${un > 9 ? '9+' : un}</span>` : ''}</span></span></button></div>`;
}
function groupsSheet(){
  openSheet(`<h4>👥 Grupuri</h4><div class="pad">${groups.length ? groups.map(g => `<button class="opt" data-gs="${g.id}"><i>👥</i>${esc(g.name)} <small style="color:var(--tx3);margin-left:6px">${gMembers(g).map(c => esc(c.name)).join(', ')}</small></button>`).join('') : '<p class="hint">Niciun grup încă. Un grup e o conversație cu mai multe personaje deodată.</p>'}
    <div class="btns"><button class="btn pri" id="gsNew">＋ Grup nou</button></div></div>`);
  $$('.sheet [data-gs]').forEach(b => b.onclick = () => { closeSheet(); openGroup(b.dataset.gs); });
  $('#gsNew').onclick = () => { closeSheet(); setTimeout(() => groupEditSheet(null), 60); };
}
function groupEditSheet(g){
  const sel = new Set(g ? g.members : []);
  if(chars.length < 2){ toast('Ai nevoie de cel puțin 2 personaje ca să faci un grup.'); return; }
  openSheet(`<h4>${g ? '👥 Grupul' : '👥 Grup nou'}</h4><div class="pad">
    <label for="geName">Numele grupului</label><input id="geName" maxlength="40" placeholder="ex. Fetele, Colegii, Familia" value="${esc(g ? g.name : '')}">
    <label style="margin-top:10px">Cine e în grup (2-5)</label>
    <div class="gpick">${[...chars].filter(c => !duoOn(c)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).map(c => `<button type="button" class="gpk${sel.has(c.id) ? ' on' : ''}" data-gc="${c.id}">${avatarHTML(c)}<span>${esc(c.name)}</span></button>`).join('')}</div>
    <label for="geTopic" style="margin-top:10px">Despre ce e grupul (opțional)</label><input id="geTopic" maxlength="160" placeholder="ex. plănuim o ieșire la munte" value="${esc(g && g.topic || '')}">
    <label style="margin-top:10px">Tonul grupului</label>
    <div class="seg gtone" id="geTone">${Object.entries(G_TONES).map(([k, t]) => `<button type="button" data-v="${k}" class="${(g && g.tone || 'normal') === k ? 'on' : ''}">${t.e} ${t.n}</button>`).join('')}</div>
    <label class="chk" style="margin-top:10px"><input type="checkbox" id="geLife" ${!g || g.life !== false ? 'checked' : ''}> 🌙 Își scriu între ele și cât lipsești (când revii vezi ce au vorbit)</label>
    <label class="chk" style="margin-top:6px"><input type="checkbox" id="geLead" ${!g || g.lead !== false ? 'checked' : ''}> 👑 Tu conduci grupul: ce ceri se face aici, iar regulile tale rămân</label>
    <div class="btns"><button class="btn pri" id="geGo">${g ? 'Salvează' : 'Creează grupul'}</button></div></div>`);
  hydrate($('.sheet'));
  let tone = g && g.tone || 'normal';
  $('#geTone').onclick = e => { const b = e.target.closest('[data-v]'); if(!b) return; tone = b.dataset.v; $$('#geTone button').forEach(x => x.classList.toggle('on', x === b)); };
  $('.gpick').onclick = e => { const b = e.target.closest('[data-gc]'); if(!b) return; const id = b.dataset.gc; if(sel.has(id)) sel.delete(id); else { if(sel.size >= 5){ toast('Cel mult 5 personaje.'); return; } sel.add(id); } b.classList.toggle('on', sel.has(id)); };
  $('#geGo').onclick = async () => {
    if(sel.size < 2){ toast('Alege cel puțin 2 personaje.'); return; }
    const ms = [...sel], name = $('#geName').value.trim() || ms.map(id => charById(id).name).join(', ');
    if(g){ const t0 = g.tone || 'normal'; g.members = ms; g.name = name; g.topic = $('#geTopic').value.trim(); g.life = $('#geLife').checked; g.lead = $('#geLead').checked; g.tone = tone; await saveGroups(); closeSheet();
      if(grp === g && t0 !== tone && gchat){ gchat.msgs.push({id:uid(), role:'sys', text:`${gTone(g).e} Tonul grupului: ${gTone(g).n}`, ts:Date.now()}); await gSave(); }
      if(grp === g){ renderGroup(); gKnow(g, gchat, true).catch(() => {}); } renderHome(); return; }
    const ng = {id:uid(), name, members:ms, topic:$('#geTopic').value.trim(), life:$('#geLife').checked, lead:$('#geLead').checked, tone, created:Date.now(), lastAt:Date.now()};
    groups.push(ng); await saveGroups(); closeSheet(); openGroup(ng.id);
  };
}
async function openGroup(id, push = true){
  const g = groups.find(x => x.id === id); if(!g) return;
  if(gSpect && gSpect.g !== g) gSpectStop(true);
  if(gbusy && gbusy.g && gbusy.g !== g) gbusy.abort();   // 9.48: alt grup: cel vechi se oprește (ce a apucat să scrie rămâne salvat în grupul lui)
  if(grp === g && gchat && gbusy) {}   // 9.48: același grup, încă răspund: păstrăm conversația din memorie (nu o recitim din DB)
  else gchat = (await DB.get('grp:' + id)) || {msgs:[]};
  grp = g; cur = null; chat = null; gReply = null; $('#gReplyBar').hidden = true;
  if(g.unread){ g.unread = 0; saveGroups(); }
  renderGroup(true); show('vGroup', push);
  if(gMembers(g).length < 2) setTimeout(() => toast('În grup a rămas ' + (gMembers(g).length ? 'un singur personaj' : 'niciun personaj') + '. Adaugă altele din 👥.', 4000), 400);   // 9.57: după ștergerea unui personaj
  if(push) history.replaceState({v:'vGroup', g:id}, '');
  const q = g.pendingQ; if(q && !gbusy){ delete g.pendingQ; saveGroups(); setTimeout(() => { if(grp === g && !gbusy) gRespond(q.text, false, false, {bomb:q.bomb}).catch(() => {}); }, 500); return; }   // 9.57: mesajul tău rămas fără răspuns
  gKnow(g, gchat).catch(() => {});   // 9.58: cum se cunosc între ele
  gPrivSync(g).catch(() => {});      // 9.61: ce s-a întâmplat între timp în privat
  gLife(g, {loud:true}).catch(() => {});   // 9.45 (7): ce au vorbit cât ai lipsit
}
// 9.57: pozele din grup nu le folosește nimic altceva; la ștergere se curăță (fără cele puse ca poză de profil)
function gPurgeImgs(msgs){
  const used = new Set(); for(const c of chars) for(const k of [c.photo, c.photoFull, ...(c.refs || []), ...((c.sheet && c.sheet.v) || []).map(x => x.k), ...((c.bsheet && c.bsheet.v) || []).map(x => x.k)]) if(k) used.add(k);
  for(const m of msgs || []) if(m && m.img && !used.has(m.img)) delImg(m.img).catch(() => {});
}
const gSpeaker = m => m.role === 'ai' ? charById(m.cid) : null;
const gName = m => m.role === 'user' ? (S.userName.trim() || 'Tu') : (gSpeaker(m) || {}).name || m.name || '?';
function gColor(c){ let h = 0; for(const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 70% 72%)`; }
function gQuote(re){ return re ? `<span class="quote"><b>${esc(re.name)}</b><span>${esc(re.text)}</span></span>` : ''; }
function gReactsHTML(m){
  const r = m.reacts ? Object.entries(m.reacts) : []; if(!r.length) return '';
  const cnt = {}; for(const [, e] of r) cnt[e] = (cnt[e] || 0) + 1;
  const who = r.map(([id]) => id === 'me' ? 'tu' : (charById(id) || {}).name).filter(Boolean).join(', ');
  return `<span class="greacts" title="${esc(who)}">${Object.entries(cnt).map(([e, n]) => e + (n > 1 ? n : '')).join(' ')}</span>`;
}
function renderGroup(toEnd){
  if(!grp) return;
  const ms = gMembers(grp);
  $('#gName').textContent = '👥 ' + grp.name;
  const sp = gSpect && gSpect.g === grp;
  $('#gTag').textContent = gbusy && gbusy.typing && gbusy.typing.length ? gbusy.typing.map(c => c.name).join(' și ') + (gbusy.typing.length > 1 ? ' scriu…' : ' scrie…') : sp ? '👀 mod spectator · ' + ms.map(c => c.name).join(', ') : (grp.tone && grp.tone !== 'normal' ? gTone(grp).e + ' ' : '') + ms.map(c => c.name).join(', ') + (grp.topic ? ' · ' + grp.topic : '');
  $('#gTag').classList.toggle('typing', !!(gbusy && gbusy.typing && gbusy.typing.length));
  $('#gAvs').innerHTML = ms.slice(0, 3).map(c => avatarHTML(c)).join(''); hydrate($('#gAvs'));   // 9.45: bulinele din antet (nu se încărcau)
  const box = $('#gMsgs'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  const lastU = [...gchat.msgs].reverse().find(m => m.role === 'user');
  const html = gchat.msgs.map((m, i) => {
    if(m.role === 'sys') return `<div class="gsys${m.rel ? ' grel' : ''}"${m.rel ? ' data-grel' : ''}>${esc(m.text)}</div>`;
    if(m.role === 'user'){
      const seen = m === lastU && m.seen && m.seen.length ? `<div class="gseen">văzut de ${esc(m.seen.map(id => (charById(id) || {}).name).filter(Boolean).join(', '))}</div>` : '';
      return `<div class="mw" data-gi="${i}"><div class="m me"><div class="bub${m.bomb ? ' gbomb' : ''}">${m.bomb ? '<b class="gnm" style="--gc:#ffb020">💣 Bombă</b>' : ''}${gQuote(m.re)}${fmtMsg(m.text)}${gReactsHTML(m)}</div></div>${seen}</div>`;
    }
    const c = gSpeaker(m), nm = c ? c.name : (m.name || '?');
    const prev = gchat.msgs[i - 1], same = prev && prev.role === 'ai' && prev.cid === m.cid && !prev.img && !m.img;
    const body = m.img ? `<img class="pic" data-k="${esc(m.img)}" data-t="m" alt="" data-gimg="${i}">${m.text ? '<div class="cap">' + fmtMsg(m.text) + '</div>' : ''}` : (m.err ? esc(m.err) : fmtMsg(m.text));
    const rg = gbusy && gbusy.regen && i >= gbusy.regen[0] && i <= gbusy.regen[1];
    return `<div class="mw${same ? ' gp' : ''}${rg ? ' gregen' : ''}" data-gi="${i}"><div class="m ai">${c ? avatarHTML(c) : ''}<div class="bub${m.err ? ' err' : ''}${m.img ? ' picwrap' : ''}">${same ? '' : `<b class="gnm" style="--gc:${c ? gColor(c) : '#aaa'}">${esc(nm)}</b>`}${gQuote(m.re)}${body}${gReactsHTML(m)}</div></div></div>`;
  }).join('');
  const ty = gbusy && gbusy.typing && gbusy.typing.length ? `<div class="mw typrow"><div class="m ai">${avatarHTML(gbusy.typing[0])}<div class="bub tdots">${gbusy.photo ? '<span style="font-size:.85rem">📸 face o poză…</span>' : '<i></i><i></i><i></i>'}</div></div></div>` : '';
  const lastReal = [...gchat.msgs].reverse().find(m => m.role !== 'sys');   // 9.57: rândurile de sistem (🕸️, 👀) nu mai ascund butonul
  const lastI = lastReal ? gchat.msgs.lastIndexOf(lastReal) : -1, rk = !sp && lastI >= 0 ? gCanRegen(gchat, lastI) : null;   // 9.82
  const more = !gbusy && !sp && lastReal && lastReal.role === 'ai' ? `<div class="gmrow">${rk ? `<button class="gmore" data-gregen="${lastI}">↻ Alt mesaj de la ${esc(gShort(rk.c, ms))}</button>` : ''}<button class="gmore" data-gmore>▶ Lasă-i să mai vorbească</button></div>` : '';
  box.innerHTML = gchat.msgs.length ? html + ty + more : `<div class="intro"><div class="gstack big">${ms.slice(0, 4).map(c => avatarHTML(c)).join('')}</div><b>${esc(grp.name)}</b><p>Scrie ceva pentru tot grupul. Ca să întrebi pe cineva anume, scrie-i numele (sau atinge-l mai jos). Ține apăsat pe un mesaj ca să-i răspunzi.</p></div>` + ty;
  hydrate(box);
  if(toEnd || near){ box.scrollTop = box.scrollHeight; requestAnimationFrame(() => box.scrollTop = box.scrollHeight); }
  $('#gChips').innerHTML = sp
    ? `<button type="button" class="on" data-gspx>⏹ Oprește (${gSpect.left} runde)</button><button type="button" data-gsubj>🎬 Subiect</button><button type="button" data-gbomb>💣 Bombă</button>`
    : '<button type="button" data-gspect>👀 Spectator</button>' + ms.map(c => { const m = gMeOf(gchat, c), sn = gShort(c, ms); return `<button type="button" data-gto="${esc(sn)}">@${esc(sn)} <small class="gmei" style="--mc:${gMeCol(m.care)}" data-gmei="${c.id}" title="cât ține la tine / cât te ajută">💗${m.care}·🤝${m.help}</small></button>`; }).join('') + (S.imgProv !== 'none' ? '<button type="button" data-gpic>📸 Poză cu voi</button>' : '');
  gSendBtn();
}
// 9.48: salvează exact grupul dat (înainte salva „grupul deschis”, deci un răspuns întârziat putea ajunge în alt grup)
async function gSave(g = grp, gc = g === grp ? gchat : null){
  if(!g || !gc || gc.dead || !groups.includes(g)) return;
  const last = [...gc.msgs].reverse().find(m => (m.text || m.img) && !m.err && m.role !== 'sys');
  g.lastAt = Date.now(); g.last = last ? (last.role === 'user' ? 'Tu: ' : gName(last) + ': ') + (last.img && !last.text ? '📷 Poză' : plain(last.text).slice(0, 80)) : '';
  await DB.set('grp:' + g.id, gc); await saveGroups();
}
function gSendBtn(){ const b = $('#gSend'), st = !!gbusy && !$('#gInp').value.trim(); b.classList.toggle('stop', st); b.innerHTML = st ? SEND_STOP : SEND_GO; }
const gViewing = g => grp === g && !$('#vGroup').hidden && !document.hidden;
function groupMenu(){
  if(!grp) return;
  sheet([
    ['👥', 'Membri, nume și subiect', () => setTimeout(() => groupEditSheet(grp), 60)],
    ['🕸️', 'Relațiile dintre ele (le poți schimba și fixa)', () => setTimeout(() => gRelSheet(), 60)],
    ['📌', 'Regulile grupului' + ((gchat && gchat.rules || []).length ? ' · ' + gchat.rules.length : ''), () => setTimeout(() => gRulesSheet(), 60)],   // 9.67
    ['💗', 'Cât țin la tine și cât te ajută', () => setTimeout(() => gRelSheet(true), 60)],
    ['🎚️', 'Tonul grupului: ' + gTone(grp).e + ' ' + gTone(grp).n, () => setTimeout(() => groupEditSheet(grp), 60)],
    gSpect && gSpect.g === grp ? ['⏹', 'Oprește modul spectator', () => gSpectStop()] : ['👀', 'Mod spectator (te uiți cum vorbesc între ele)', () => gSpectStart(grp)],
    ['🧠', 'Ce știe grupul (dinamica și rezumatul)', () => setTimeout(() => openSheet(`<h4>🧠 ${esc(grp.name)}</h4><div class="pad"><p><b>Dinamica</b><br>${esc(gchat.dyn || 'Încă se formează, după câteva mesaje.')}</p><p><b>Ce s-a vorbit</b><br>${esc(gchat.recap || '—')}</p></div>`), 60)],
    ['🧹', 'Golește conversația grupului', () => confirmSheet('Golești conversația grupului?', 'Golește', async () => { gSpectStop(true); if(gbusy) gbusy.abort(); const old = gchat; old.dead = true; gchat = {msgs:[], lifeAt:Date.now(), rel:old.rel, dyn:old.dyn, lifeDay:old.lifeDay}; await gSave(); gPurgeImgs(old.msgs); renderGroup(true); }), 'dan'],
    ['🗑️', 'Șterge grupul', () => confirmSheet('Ștergi grupul „' + grp.name + '”? Personajele rămân.', 'Șterge', async () => { gSpectStop(true); if(gbusy) gbusy.abort(); if(gchat){ gchat.dead = true; gPurgeImgs(gchat.msgs); } await DB.del('grp:' + grp.id).catch(() => {}); groups = groups.filter(x => x !== grp); await saveGroups(); grp = null; gchat = null; goHome(); }), 'dan'],
  ]);
}
// 9.82: „↻ Alt mesaj” în grup. Blocul = bulele trimise la rând de același personaj (o replică); se reface doar o replică din runda curentă (după ultimul tău mesaj)
function gBlock(gc, i){
  const m = gc && gc.msgs[i]; if(!m || m.role !== 'ai' || m.img || m.err || !m.text) return null;
  const ok = x => x && x.role === 'ai' && x.cid === m.cid && !x.img && !x.err && x.text;
  let a = i, b = i; while(ok(gc.msgs[a - 1])) a--; while(ok(gc.msgs[b + 1])) b++;
  return {a, b, c:charById(m.cid)};
}
function gCanRegen(gc, i){
  const k = gBlock(gc, i); if(!k || !k.c || gbusy || !grp || !gMembers(grp).includes(k.c)) return null;
  const lastU = gc.msgs.map(m => m.role).lastIndexOf('user'); return k.a > lastU ? k : null;
}
const gPrevOf = arr => arr.map(m => ({text:m.text, re:m.re || null, reacts:m.reacts || null, task:m.task, spect:m.spect, eco:m.eco}));
async function gRegen(i){
  const g = grp, gc = gchat, k = gCanRegen(gc, i); if(!k) return;
  if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; }
  const c = k.c, ms = gMembers(g), old = gc.msgs.slice(k.a, k.b + 1), first = old[0];
  const ac = new AbortController(); gbusy = ac; ac.typing = [c]; ac.g = g; ac.regen = [k.a, k.b]; renderGroup();
  const sub = {...gc, msgs:gc.msgs.slice(0, k.a)}, x = {regen:old.map(m => m.text).join(' / ').slice(0, 600)};
  if(first.task) x.task = first.task; if(first.spect) x.spect = true;
  let parts = [], re = null;
  try{
    const meta = {}, out = await stream(gSharedSys(g, sub), gContext(c, sub, x, g), {max:800, signal:ac.signal, cid:c.id, tag:'grup', conv:true, cold:true, eco:false, meta});   // pe modelul principal, ca la ↻ din conversația 1:1
    ({parts, re} = gParse(out, c, ms, sub, meta, k.a));
  }catch(e){ if(e.name !== 'AbortError') toast('N-a mers: ' + (e.message || e), 3500); }
  finally{ gbusy = null; }
  const at = gc.msgs.indexOf(first);
  if(parts.length && !gc.dead && at >= 0){
    const fresh = parts.map((t, p) => ({id:uid(), role:'ai', cid:c.id, name:c.name, text:t, ts:old[Math.min(p, old.length - 1)].ts || Date.now()}));
    if(re) fresh[0].re = re; if(first.task) fresh[0].task = first.task; if(first.spect) fresh[0].spect = true;
    fresh[0].prev = gPrevOf(old);   // varianta de dinainte, ca să poți reveni (reacțiile la ea rămân cu ea)
    gc.msgs.splice(at, old.length, ...fresh);
  }else if(!parts.length && !ac.signal.aborted && !gc.dead) toast('N-a ieșit nimic nou. Mai încearcă o dată.');
  await gSave(g, gc).catch(() => {}); if(grp === g) renderGroup();
  const ag = ac.again; if(ag && grp === ag.g && gchat === ag.gc && !ag.gc.dead) setTimeout(() => gRespond(ag.text, false, false, {bomb:ag.bomb}).catch(() => {}), 300);   // ai scris cât se refăcea: primești răspuns
}
function gUndoRegen(i){
  const gc = gchat, k = gBlock(gc, i); if(!k || gbusy) return; const first = gc.msgs[k.a]; if(!first.prev) return;
  const cur = gc.msgs.slice(k.a, k.b + 1);
  const back = first.prev.map((o, p) => { const m = {id:uid(), role:'ai', cid:first.cid, name:first.name, text:o.text, ts:(cur[Math.min(p, cur.length - 1)] || first).ts};
    if(o.re) m.re = o.re; if(o.reacts) m.reacts = o.reacts; if(o.task) m.task = o.task; if(o.spect) m.spect = true; if(o.eco) m.eco = true; return m; });
  back[0].prev = gPrevOf(cur);
  gc.msgs.splice(k.a, cur.length, ...back); gSave(); renderGroup();
}
// (12) + (3): atingere lungă pe un mesaj din grup
function gMsgSheet(i){
  const m = gchat && gchat.msgs[i]; if(!m || m.role === 'sys') return;
  const c = gSpeaker(m), opts = [];
  if(!m.err) opts.push(['↩️', 'Răspunde în grup (citat)', () => { gReply = {id:m.id, name:gName(m), text:(m.img && !m.text ? '📷 Poză' : plain(m.text)).slice(0, 140)}; $('#gRbName').textContent = '↩ Răspunzi ' + (m.role === 'user' ? 'la mesajul tău' : 'lui ' + gReply.name); $('#gRbTxt').textContent = gReply.text; $('#gReplyBar').hidden = false; $('#gInp').focus(); }]);
  if(c && !m.err) opts.push(['💬', 'Răspunde-i în privat lui ' + c.name, async () => {
    await openChat(c.id);
    replyTo = {id:'grp-' + m.id, name:c.name + ' · ' + grp.name, text:(m.img && !m.text ? '📷 Poză din grup' : plain(m.text)).slice(0, 140), ctx:`(mesajul tău din grupul „${grp.name}”)`};
    $('#rbName').textContent = '↩ Îi răspunzi în privat lui ' + c.name; $('#rbTxt').textContent = replyTo.text; $('#replyBar').hidden = false; $('#inp').focus(); }]);
  if(m.text) opts.push(['📋', 'Copiază', () => { navigator.clipboard?.writeText(m.text); toast('Copiat'); }]);
  { const k = gCanRegen(gchat, i); if(k) opts.push(['↻', 'Alt mesaj de la ' + k.c.name, () => gRegen(i)]); const kb = gBlock(gchat, i); if(kb && gchat.msgs[kb.a].prev && !gbusy) opts.push(['↩️', 'Înapoi la varianta de dinainte', () => gUndoRegen(i)]); }   // 9.82
  if(!m.err) opts.push(['❤️', 'Reacționează', () => setTimeout(() => sheet(G_REACT.map(e => [e, 'Reacționează cu ' + e, async () => { m.reacts = m.reacts || {}; m.reacts.me = e; await gSave(); renderGroup(); }])), 60)]);
  if(!gbusy) opts.push(['🗑️', 'Șterge mesajul', async () => { const k = gchat.msgs.findIndex(x => x.id === m.id); if(k < 0) return; gchat.msgs.splice(k, 1); await gSave(); gPurgeImgs([m]); renderGroup(); }, 'dan']);
  sheet(opts);
}
// cine e pomenit pe nume (prenumele, fără diacritice); „toți / voi / fetelor…” = toată lumea
// 9.79: numele scurt din grup: prenumele; dacă două au același prenume, și al doilea cuvânt („Ana Maria”), ca să nu se confunde
function gShort(c, ms){ const w = String(c.name || '').split(/\s+/), f = pnorm(w[0]); return (ms || []).some(o => o !== c && pnorm(String(o.name || '').split(/\s+/)[0]) === f) && w[1] ? w[0] + ' ' + w[1] : w[0]; }
function gMentioned(text, ms, namesOnly){
  if(!namesOnly && G_ALL.test(text)) return ms.slice();
  let t = ' ' + pnorm(text) + ' '; const hit = [];
  // numele mai lungi întâi („Ana Maria” înaintea lui „Ana”), iar locul găsit se șterge, ca „Ana Maria” să n-o strige și pe Ana
  for(const c of ms.slice().sort((a, b) => gShort(b, ms).length - gShort(a, ms).length)){
    const k = ' ' + pnorm(gShort(c, ms)) + ' ', i = t.indexOf(k);
    if(i >= 0){ hit.push({c, i}); t = t.slice(0, i) + ' '.repeat(k.length) + t.slice(i + k.length); }
  }
  return hit.sort((a, b) => a.i - b.i).map(x => x.c);
}
const gLine = m => m.role === 'sys' ? '' : `${gName(m)}: ${m.re ? '(răspunde la ' + m.re.name + ': „' + m.re.text.slice(0, 60) + '”) ' : ''}${m.img ? '[poză] ' : ''}${plain(m.text || '').slice(0, 260)}`;
/* regizorul: cine răspunde, cine doar reacționează, cine tace; poza cerută; cine îți scrie în privat */
async function gDirector(g, ms, more, mentioned, photoAsk, toAll, gc = gchat, x = {}){
  const u = S.userName.trim() || 'Utilizatorul', T = gTone(g), lead = g.lead !== false && !more && !x.spect;   // 9.67
  const recent = gc.msgs.slice(-14).map(gLine).filter(Boolean).join('\n');
  const rels = gRelLines(gc, ms);
  try{
    const out = await stream('You direct a realistic group chat between a user and several characters. Answer with JSON only.', [{role:'user', text:
`Group "${g.name}"${g.topic ? ' (' + g.topic + ')' : ''}. Characters: ${ms.map(c => c.name + (c.tag ? ' (' + c.tag + ')' : '')).join('; ')}.
${gc.dyn ? 'Group dynamic (Romanian): ' + gc.dyn + '\n' : ''}${rels ? 'Relationships between them (Romanian): ' + rels + '\n' : ''}Toward ${u}: ${gMeLines(gc, ms)}. Characters who care more answer ${u} more often and more warmly; when ${u} asks for help or has a problem, the ones with high "helps" reply first with concrete help, low ones may only react or stay silent.
Group tone: ${T.dir}.
${(gc.rules || []).length ? 'Group rules set by ' + u + ' (Romanian), everyone follows them: ' + gc.rules.map(r => r.t).join('; ') + '\n' : ''}${lead ? `${u} LEADS this group. If ${u}'s last message asks the group or someone to DO something now (a task, a game, a round where each answers, a question for everyone, "each of you…", "Ana, sing…"), set "task" (Romanian, short and concrete: what exactly to do) and "who" ("all" or the names asked); everyone in "who" replies and does it, no refusing or dodging. If ${u} sets a standing rule for the group from now on ("from now on…", "no more…", "everyone always…"), set "rule" (Romanian, short). If ${u} cancels a rule, set "unrule" with that rule. Otherwise leave them null.\n` : ''}${gc.subj ? 'New topic set for the group (Romanian), they get into it naturally: ' + gc.subj + '\n' : ''}Recent messages:
${recent}
${x.spect ? 'The user is only watching silently now: the characters talk among themselves (answer each other, not the user); 1-' + T.max + ' replies.' : more ? 'The user wants the characters to keep talking among themselves now.' : 'The last message is from ' + u + '.'}${x.bomb ? ' The user just dropped big news: almost everyone reacts, most of them with text.' : ''}${mentioned.length ? ' The user addressed: ' + mentioned.map(c => c.name).join(', ') + ' (they reply first).' : ''}${toAll ? ' The user addressed everyone: most of them react (reply or emoji), but not necessarily all with text.' : ''}${photoAsk ? ' The user asked for a photo: decide who sends it ("photo": the names of who must be IN the photo, and "by": who sends it; a photo of several of them together is fine).' : ''}
Like a real group chat: usually 1-2 characters reply (at most ${T.max}; one may answer another character); others may only react with an emoji to a specific message, or just read it. Not everyone talks every time. Optionally one character may later write privately to ${u} about the group ("dm"), only when something juicy happened.
JSON: {"actions":[{"name":"","do":"reply|react|seen","emoji":"","to":"author name of the message they react to"}],"photo":${photoAsk ? '{"names":[],"by":""}' : 'null'},"dm":null${lead ? ',"task":null,"who":"all","rule":null,"unrule":null' : ''}}`}], {max:lead ? 380 : 260, aux:true, tag:'fundal'});
    const j = parseJSON(out), find = n => ms.find(x => pnorm(x.name) === pnorm(n) || pnorm(x.name.split(' ')[0]) === pnorm(String(n || '').split(' ')[0]));
    const acts = []; for(const a of Array.isArray(j.actions) ? j.actions : []){ const c = find(a && a.name); if(c && !acts.some(x => x.c === c)) acts.push({c, do:/react/.test(a.do) ? 'react' : /seen/.test(a.do) ? 'seen' : 'reply', emoji:G_REACT.find(e => e.replace(/\uFE0F/g, '') === String(a.emoji || '').replace(/\uFE0F/g, '')) || '❤️', to:String(a.to || '')}); }
    for(const c of mentioned.slice().reverse()){ const k = acts.findIndex(x => x.c === c); if(k >= 0) acts.splice(k, 1); acts.unshift({c, do:'reply'}); }
    // 9.67: ce a cerut liderul: toate cele numite (sau toate) răspund și fac asta, peste limita obișnuită de replici
    const task = lead && j.task && String(j.task).trim() ? faraLiniute(String(j.task)).trim().slice(0, 240) : '';
    let doers = [];
    if(task){ doers = /^(all|toate|toți|toti|everyone)$/i.test(String(j.who || 'all').trim()) || !j.who ? ms.slice() : (Array.isArray(j.who) ? j.who : String(j.who).split(/,|\bși\b|\band\b/)).map(n => find(String(n).trim())).filter(Boolean);
      if(!doers.length) doers = ms.slice();
      for(const c of doers.slice().reverse()){ const k = acts.findIndex(a => a.c === c); if(k >= 0) acts.splice(k, 1); acts.unshift({c, do:'reply'}); } }
    let n = 0; for(const a of acts) if(a.do === 'reply' && !doers.includes(a.c) && ++n > (x.bomb ? 3 : T.max)) a.do = 'seen';
    if(lead) gRuleApply(gc, j.rule, j.unrule);
    const ph = j.photo && typeof j.photo === 'object' ? {names:(Array.isArray(j.photo.names) ? j.photo.names : []).map(find).filter(Boolean).slice(0, 4), by:find(j.photo.by)} : null;
    if(acts.some(a => a.do === 'reply') || ph) return {acts, photo:ph, dm:find(j.dm), task, doers};
  }catch(e){}
  const pick = mentioned.length ? mentioned : toAll ? ms.slice(0, 3) : ms.slice().sort(() => Math.random() - .5).slice(0, Math.random() < .5 ? 1 : 2);
  return {acts:pick.map(c => ({c, do:'reply'})).concat(ms.filter(c => !pick.includes(c)).map(c => ({c, do:'seen'}))), photo:null, dm:null};
}
/* 9.61: cache comun în grup. Înainte, fiecare personaj avea alt prompt de sistem și istoricul văzut altfel (mesajele lui ca „assistant”),
   iar reacțiile noi rescriau mesajele vechi, deci fiecare replică rescria tot în cache. Acum:
   (1) `gSharedSys`: un singur prompt pentru tot grupul (cine e fiecare, ce știe fiecare despre tine, cum se cunosc, tonul, regulile): la fel pentru toate;
   (2) `gTranscript`: conversația, la fel pentru toate, câte un bloc pe mesaj (fără reacții), cu punctul de cache la final;
   (3) `gTurn`: ce diferă de la una la alta (cine scrie acum, relațiile de acum, ce simte pentru tine, reacțiile recente, ce știe doar din privat),
   după punctul de cache, deci nu strică nimic. */
/* 9.67: regulile grupului (gc.rules = [{t, ts}]): puse de tine („de acum…”, „nimeni nu mai…”), prin regizor sau din meniu (📌);
   intră în rândul fiecărei personaje și în „cât ai lipsit”; cel mult 8. */
function gRuleApply(gc, rule, unrule){
  if(!gc) return;
  const cl = v => faraLiniute(String(v || '')).replace(/[„”"]/g, '').trim().slice(0, 160);
  const r = cl(rule), ur = cl(unrule); gc.rules = gc.rules || [];
  if(ur){ const k = gc.rules.findIndex(x => pnorm(x.t).includes(pnorm(ur).slice(0, 24)) || pnorm(ur).includes(pnorm(x.t).slice(0, 24))); if(k >= 0){ const old = gc.rules.splice(k, 1)[0]; gc.msgs.push({id:uid(), role:'sys', text:'📌 Regula „' + old.t + '” nu mai e', ts:Date.now()}); } }
  if(r && r.length > 3 && !gc.rules.some(x => pnorm(x.t) === pnorm(r))){ gc.rules.push({t:r, ts:Date.now()}); gc.rules = gc.rules.slice(-8); gc.msgs.push({id:uid(), role:'sys', text:'📌 Regulă nouă: ' + r, ts:Date.now()}); }
}
function gRulesSheet(){
  if(!grp || !gchat) return;
  const g = grp, gc = gchat, list = () => (gc.rules || []).map((r, k) => `<li><span>${esc(r.t)}</span><button type="button" data-rx="${k}" aria-label="Șterge">✕</button></li>`).join('') || '<li><span style="color:var(--tx3)">Nicio regulă încă. Le poți scrie aici sau direct în grup („de acum…”).</span></li>';
  openSheet(`<h4>📌 Regulile grupului</h4><div class="pad">
    <ul class="facts" id="grRules">${list()}</ul>
    <div class="addfact"><input id="grRuleIn" maxlength="160" placeholder="ex. de acum vorbim doar în engleză"><button class="btn sm" id="grRuleAdd">＋</button></div>
    <p class="hint">${g.lead !== false ? '👑 Tu conduci grupul: ce ceri în grup se face, iar regulile spuse acolo („de acum…”) apar singure aici.' : 'Pornește „👑 Tu conduci grupul” din 👥 ca regulile spuse în grup să apară singure aici.'}</p></div>`);
  const redraw = () => { $('#grRules').innerHTML = list(); };
  $('#grRules').onclick = async e => { const b = e.target.closest('[data-rx]'); if(!b) return; const old = gc.rules.splice(+b.dataset.rx, 1)[0]; if(old) gc.msgs.push({id:uid(), role:'sys', text:'📌 Regula „' + old.t + '” nu mai e', ts:Date.now()}); await gSave(g, gc); redraw(); if(grp === g) renderGroup(); };
  $('#grRuleAdd').onclick = async () => { const v = $('#grRuleIn').value.trim(); if(!v) return; gRuleApply(gc, v); $('#grRuleIn').value = ''; await gSave(g, gc); redraw(); if(grp === g) renderGroup(); };
}
function gSharedSys(g, gc = gchat){
  const u = S.userName.trim() || 'utilizatorul', ms = gMembers(g), T = gTone(g);
  const pairs = []; for(let a = 0; a < ms.length; a++) for(let b = a + 1; b < ms.length; b++){ const how = relBetween(ms[a], ms[b]); pairs.push(`- ${ms[a].name} și ${ms[b].name}: ${how ? 'se cunosc: ' + how : 'se cunosc din grupul ăsta'}`); }
  return [
    `Scrii replici într-o conversație de grup pe telefon între ${u} și personajele: ${ms.map(c => c.name).join(', ')}. La fiecare cerere afli ce personaj ești acum; scrii DOAR replica acelui personaj, în stilul lui, și rămâi mereu în personaj. Nu spui că ești un AI.`,
    S.userAbout.trim() && `## Despre ${u}\n${S.userAbout.trim()}`,
    ...ms.map(c => { const facts = (c.facts || []).filter(f => f.k !== 'lex').slice(-15).map(f => '- ' + f.t).join('\n');
      return [`## ${c.name}${c.tag ? ' (' + c.tag + ')' : ''}${c.city ? ', din ' + c.city : ''}`, c.persona && `Cine e: ${c.persona}`, c.speech && `Cum vorbește: ${c.speech}`, c.aspect && `Cum arată: ${String(c.aspect).slice(0, 700)}`,
        `Relația cu ${u}: ${relOf(c).name}. ${relOf(c).how}.`, facts && `Ce știe ${c.name} despre ${u} (din conversațiile lor):\n${facts}`].filter(Boolean).join('\n'); }),
    `## Grupul „${g.name}”${g.topic ? ' (' + g.topic + ')' : ''}: cum se cunosc între ele\n${pairs.join('\n') || '-'}\nSe vorbesc ca oameni care se știu: pe nume (sau cum se alintă), știu cum e fiecare, fac aluzie la ce au trăit împreună; nu vă prezentați și nu vă întrebați lucruri pe care le-ați ști deja.`,
    T.sys && `## Tonul grupului\n${T.sys}`,
    `## Reguli în grup
- Scrii DOAR replica personajului cerut. Nu scrii ce spun ${u} sau ceilalți și nu începi cu numele personajului.
- E un chat de grup pe telefon: scurt, viu, în română naturală, cu stilul personajului (nu seamănă cu ceilalți la vorbă). Poate să-i răspundă lui ${u} sau celorlalți, pe nume; poate fi de acord sau nu, glumi, tachina, întreba. Nu repeta ce a zis altcineva.
- Dacă vrei să trimiți 2-3 mesaje scurte la rând, ca pe chat, separă-le cu un rând care conține doar //. De cele mai multe ori un singur mesaj.
- Fiecare bulă are 1-3 propoziții și se termină cu propoziția încheiată; scrii doar replica personajului cerut, niciodată și replicile celorlalte.
- Când răspunzi la un mesaj mai vechi din grup (nu la ultimul), începe cu [re: primele 3-6 cuvinte exacte din mesajul acela].
- Acțiuni foarte rar și scurt între *asteriscuri*. Fără liniuțe lungi, fără formule de asistent.
- Ce a aflat un personaj doar din discuțiile private cu ${u} rămâne între ei: nu spune asta în grup și nu lasă să se înțeleagă; celelalte nu știu ce vorbește ${u} cu fiecare între patru ochi.
- Dacă ${u} îți cere o poză sau chiar se potrivește (rar), poți spune că trimiți una; aplicația o face.`
  ].filter(Boolean).join('\n\n');
}
const gLineT = m => `${gName(m)}${m.bomb ? ' (veste mare)' : ''}: ${m.re ? '(răspunde la ' + m.re.name + ': „' + m.re.text.slice(0, 80) + '”) ' : ''}${m.img ? '[poză] ' : ''}${m.text || ''}`;
// conversația grupului, la fel pentru toate personajele: câte un bloc pe mesaj; fereastra se mută din 20 în 20 (9.51)
function gTranscript(gc = gchat){
  const n = gc.msgs.length, from = Math.floor(Math.max(0, n - 30) / 20) * 20;
  const lines = gc.msgs.slice(from).filter(m => !m.err && m.role !== 'sys' && (m.text || m.img)).map(gLineT);
  return ['Conversația din grup până acum (cele mai noi la final):', ...(lines.length ? lines : ['(grupul abia începe, încă nu a scris nimeni)'])];
}
// ce diferă pentru personajul care scrie acum (după punctul de cache)
function gTurn(c, g, gc = gchat, x = {}){
  const u = S.userName.trim() || 'utilizatorul', others = gMembers(g).filter(o => o.id !== c.id), m = gMeOf(gc, c), pn = c.grpNote;
  const rels = others.map(o => { const r = gRelOf(gc, c, o); return `- ${o.name}${r ? '. Acum: ' + r.t + '.' : ': nimic deosebit acum.'}`; }).join('\n');
  const recent = gc.msgs.slice(-8).filter(q => q.reacts && Object.keys(q.reacts).length).map(q => `„${plain(q.text || '[poză]').slice(0, 50)}” (${gName(q)}): ${Object.entries(q.reacts).map(([id, e]) => (id === 'me' ? u : (charById(id) || {}).name) + ' ' + e).join(', ')}`).join('\n');
  return [
    `--- Acum e rândul tău. Ești ${c.name}.`,
    `## Tu și celelalte, acum\n${rels || '-'}`,
    `## Ce simți pentru ${u}, aici\n${gCareWord(m.care)} (${m.care}/100).${m.why ? ' De ce: ' + m.why + '.' : ''}\nCât îl ajuți: ${gHelpWord(m.help)} (${m.help}/100). Când ${u} cere ajutor sau are o problemă, asta decide cât de repede și cât de concret sari (sau nu). Arată asta prin fapte și ton, nu spunând cifrele.`,
    pn && (pn.mood || pn.carry || (pn.others || []).length || (pn.secrets || []).length) && `## Din discuțiile tale private cu ${u} (doar tu știi asta)\n${pn.mood ? 'Cum ești acum cu el: ' + pn.mood + '\n' : ''}${(pn.others || []).length ? 'Ce i-ai zis în privat despre celelalte: ' + pn.others.map(o => o.name + ': ' + o.t).join('; ') + '\n' : ''}${pn.carry ? 'Poți face aluzie firesc, fără să explici: ' + pn.carry + '\n' : ''}${(pn.secrets || []).length ? 'NU spui în grup și nu lași să se înțeleagă: ' + pn.secrets.join('; ') + '\n' : ''}Se simte în ton și în cum îi răspunzi (mai caldă, mai rece, complice), nu povestești conversația privată.`,
    gc && (gc.rules || []).length && `## Regulile grupului (stabilite de ${u}; le respecți mereu)\n${gc.rules.map(r => '- ' + r.t).join('\n')}`,   // 9.67
    x.task && `## Ce a cerut ${u} acum (el conduce grupul)\n${x.task}\nFă asta acum, în replica ta, concret și complet: nu doar promiți, nu comentezi și nu amâni. Dacă e un joc sau o rundă, joacă-ți rândul; dacă e o întrebare pentru toate, răspunde-i tu, cu răspunsul tău.`,
    gc && gc.dyn && `## Dinamica grupului acum\n${gc.dyn}`,
    gc && gc.subj && `## Subiectul nou din grup\n${gc.subj} (intrați în el firesc, fiecare cu părerea ei)`,
    recent && `## Reacții recente\n${recent}`,
    x.regen && `## Altă variantă\n${u} a cerut o altă replică în locul celei de mai jos. Scrie alta, pentru același moment din conversație: alt conținut sau alt unghi, nu o reformulare.\nVarianta respinsă: „${x.regen}”`,
    x.spect && `## Acum\n${u} doar citește. Vorbiți între voi: răspunde-le celorlalte, pe nume; lui ${u} i te adresezi rar.`,
    `Scrie acum DOAR replica lui ${c.name}, fără „${c.name}:” în față.`
  ].filter(Boolean).join('\n\n');
}
// ce primește un personaj, întreg (pentru teste și depanare)
function groupSystem(c, g, gc = gchat, x = {}){ return gSharedSys(g, gc) + '\n\n' + gTurn(c, g, gc, x); }
function gContext(c, gc = gchat, x = {}, g = grp){
  const parts = gTranscript(gc);
  return [{role:'user', parts:[...parts, gTurn(c, g, gc, x)], _cacheAt:parts.length - 1}];
}
// (3) [re: …] → mesajul din grup citat
function gFindQuoted(frag, beforeIdx, gc = gchat){
  const norm = x => pnorm(x), f = norm(frag); if(f.length < 3) return null;
  const list = gc.msgs.slice(Math.max(0, beforeIdx - 20), beforeIdx).filter(m => m.text && m.role !== 'sys');
  let best = null, bs = 0;
  for(const m of list){ const t = norm(plain(m.text)); let sc = t.includes(f) ? 1 : 0; if(!sc){ const fw = f.split(' '), tw = new Set(t.split(' ')); sc = fw.filter(w => tw.has(w)).length / fw.length * .9; } if(sc >= bs && sc > 0){ bs = sc; best = m; } }
  return best && bs >= .6 ? {id:best.id, name:gName(best), text:plain(best.text).slice(0, 140)} : null;
}
async function gSend(bomb){
  const t = $('#gInp').value.trim(); if(!t || !grp) return;
  if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; }
  $('#gInp').value = ''; $('#gInp').style.height = '';
  const m = {id:uid(), role:'user', text:t, ts:Date.now()}; if(gReply){ m.re = gReply; gReply = null; $('#gReplyBar').hidden = true; }
  if(bomb) m.bomb = true;
  gchat.msgs.push(m); await gSave(); renderGroup(true);
  // 9.48: dacă încă scriu, mesajul tău intră la coadă și primește răspuns imediat după (înainte se pierdea)
  if(gbusy){ gbusy.again = {text:t, bomb:!!bomb, g:grp, gc:gchat}; return; }
  await gRespond(t, false, false, {bomb:!!bomb});
}
const gWait = (ms, ac, g) => S.typeReal === 'off' ? Promise.resolve() : naps(ms * gTone(g || grp).pace, ac.signal);
async function gRespond(text, more, forcePhoto, x = {}){
  if(!grp || gbusy) return;
  const g = grp, gc = gchat, ms = gMembers(g); if(!ms.length){ toast('Grupul nu mai are personaje. Adaugă-le din meniul grupului (👥).', 4000); return; }
  const ac = new AbortController(); gbusy = ac; ac.typing = []; ac.g = g;
  if(gBusyP.know[g.id]){ ac.typing = ms.slice(0, 1); renderGroup(); await gBusyP.know[g.id].catch(() => {}); }   // 9.58: întâi află cum se cunosc
  if(!x.spect){ const pp = gPrivSync(g).catch(() => {}); if(gBusyP.priv[g.id]){ ac.typing = ms.slice(0, 1); renderGroup(); } await pp; }   // 9.61: dacă tocmai ai vorbit cu una în privat (fără schimbări: doar o citire locală)
  const lastU = [...gc.msgs].reverse().find(m => m.role === 'user');
  const push = msg => { gc.msgs.push(msg); if(!gViewing(g) && msg.role === 'ai'){ g.unread = (g.unread || 0) + 1; } };   // 9.48: răspunsurile ajung în grupul lor, chiar dacă ai ieșit
  const photoAsk = forcePhoto || (!!text && PHOTO_ASK.test(text) && S.imgProv !== 'none');
  try{
    const named = text ? gMentioned(text, ms, true) : [];   // 9.57: numele pomenite au prioritate față de „toți”
    const toAll = !!text && ((!named.length && G_ALL.test(text)) || !!x.bomb), mentioned = toAll ? [] : named;   // „fetelor”: pentru toate, dar nu e obligatoriu să răspundă toate
    const plan = await gDirector(g, ms, more, mentioned, photoAsk, toAll, gc, x);
    if(plan.task) x = {...x, task:plan.task};   // 9.67: ce a cerut liderul ajunge în rândul fiecăreia care o face
    if(gc.msgs.length && gc.msgs[gc.msgs.length - 1].role === 'sys' && /^📌/.test(gc.msgs[gc.msgs.length - 1].text)){ await gSave(g, gc); if(grp === g) renderGroup(); }   // regulă nouă / scoasă
    if(lastU && !more) lastU.seen = ms.map(c => c.id);   // (2) „văzut de …”
    // reacțiile vin repede, înaintea răspunsurilor
    for(const a of plan.acts.filter(x => x.do === 'react')){
      const to = pnorm(a.to), toF = to.split(' ')[0], isTo = m => { const n = pnorm(gName(m)); return !!to && (n === to || n.split(' ')[0] === toF || (m.role === 'user' && /^(tu|you|user|utilizatorul)$/.test(to))); };
      const tgt = [...gc.msgs].reverse().find(m => m.role !== 'sys' && !m.err && !(m.role === 'ai' && m.cid === a.c.id) && isTo(m)) || (more ? [...gc.msgs].reverse().find(m => m.role === 'ai' && m.cid !== a.c.id && !m.err) : lastU);   // 9.57: prenumele ajunge; nu reacționează la propriul mesaj
      if(tgt){ tgt.reacts = tgt.reacts || {}; tgt.reacts[a.c.id] = a.emoji; }
    }
    if(plan.acts.some(x => x.do === 'react')){ await gSave(g, gc); if(grp === g) renderGroup(); await gWait(500, ac, g); }
    const repl = plan.acts.filter(x => x.do === 'reply').map(x => x.c);
    let photo = photoAsk ? (plan.photo && (plan.photo.names.length || plan.photo.by) ? plan.photo : null) : null;
    if(photoAsk && !photo){ const who = G_ALL.test(text || '') || forcePhoto ? ms.slice(0, 4) : (mentioned.length ? mentioned.slice(0, 1) : repl.slice(0, 1)); photo = {names:who, by:who[0]}; }
    if(photo && !photo.by) photo.by = photo.names[0] || repl[0] || ms[0];
    if(photo && !photo.names.length) photo.names = [photo.by];
    if(photo && photo.by && !repl.includes(photo.by)) repl.push(photo.by);
    for(let k = 0; k < repl.length; k++){
      const c = repl[k];
      if(ac.signal.aborted || gc.dead) break;
      ac.typing = [c].concat(k + 1 < repl.length && Math.random() < .35 ? [repl[k + 1]] : []); if(grp === g) renderGroup();
      const t0 = Date.now(); let out = '';
      const eco = gEco(k, c, text, more, x, mentioned, photo, gc);   // 9.60: amestecul și în grup
      const meta = {};   // 9.65: aflăm dacă răspunsul s-a oprit la limită (înainte: mesajul tăiat intra în grup așa, chiar la jumătatea unui cuvânt)
      try{ out = await stream(gSharedSys(g, gc), gContext(c, gc, x, g), {max:800, signal:ac.signal, cid:c.id, tag:'grup', conv:true, cold:true, eco, meta}); }   // 9.61: prompt și transcriere comune, cache comun   // 9.51: cache pe 5 min (fișa + istoricul grupului), citit la 5% din preț
      catch(e){ if(e.name === 'AbortError') break; push({id:uid(), role:'ai', cid:c.id, name:c.name, text:'', err:e.message || 'Eroare', ts:Date.now()}); break; }   // 9.57: și eroarea apare la necitite
      const {parts, re} = gParse(out, c, ms, gc, meta, gc.msgs.length);
      for(let p = 0; p < parts.length; p++){
        if(ac.signal.aborted || gc.dead) break;
        const waitMs = p ? Math.min(2600, 500 + parts[p].length * 45) : Math.max(0, typeMs({text:parts[p]}) - (Date.now() - t0));
        await gWait(waitMs, ac, g);
        if(gc.dead) break;
        const msg = {id:uid(), role:'ai', cid:c.id, name:c.name, text:parts[p], ts:Date.now()}; if(p === 0 && re) msg.re = re; if(p === 0 && x.task) msg.task = x.task; if(p === 0 && x.spect) msg.spect = true; if(eco) msg.eco = true;
        push(msg); await gSave(g, gc); if(grp === g) renderGroup();
        if(gDmPromise(g, c, parts[p])) ac.dmDone = true;   // 9.58: „îți scriu în privat” → chiar îți scrie
        if(navigator.vibrate && !document.hidden) try{ navigator.vibrate(8); }catch(e){}
      }
      ac.typing = [];
      if(photo && c === photo.by && !ac.signal.aborted){ ac.typing = [c]; ac.photo = true; if(grp === g) renderGroup(); await gPhoto(g, photo, ac.signal, gc).catch(e => { if(e.name !== 'AbortError') gc.msgs.push({id:uid(), role:'ai', cid:c.id, text:'', err:'Poza n-a mers: ' + (e.message || 'eroare'), ts:Date.now()}); }); ac.photo = false; ac.typing = []; await gSave(g, gc); photo = null; }
      if(k + 1 < repl.length) await gWait(400 + Math.random() * 900, ac, g);
    }
    if(!ac.signal.aborted && !gc.dead){
      gc.dynN = (gc.dynN || 0) + 1;
      if(gc.dynN >= 4){ gc.dynN = 0; gDyn(g, gc).catch(() => {}); }   // (4) + (9) + 9.48 (5)
      if(!x.spect && !ac.dmDone && (plan.dm || (Math.random() < .12 && repl.length >= 2))) setTimeout(() => gGossip(g, plan.dm || repl[Math.floor(Math.random() * repl.length)]).catch(() => {}), 6000);   // (8)
    }
  } finally {
    gbusy = null; await gSave(g, gc).catch(() => {}); if(grp === g) renderGroup();
    if(!gViewing(g) && $('#vHome') && !$('#vHome').hidden) renderHome();
    // 9.48: mesajul scris cât timp răspundeau primește răspuns acum
    const ag = ac.again; if(ag && grp === ag.g && gchat === ag.gc && !ag.gc.dead) setTimeout(() => gRespond(ag.text, false, false, {bomb:ag.bomb}).catch(() => {}), 300);
    else if(ag && !ag.gc.dead) ag.g.pendingQ = {text:ag.text, bomb:ag.bomb};   // 9.57: ai trecut în alt grup: răspunsul vine când revii
  }
}
// 9.82: textul primit → bulele (comun pentru răspuns și pentru „↻ Alt mesaj”)
function gParse(out, c, ms, gc, meta, at){
  let tx = faraLiniute(stripMood(stripReact(String(out || '').replace(RE_ANY, '⟦RE⟧$1⟦/RE⟧'))));
  let re = null; tx = tx.replace(/⟦RE⟧([^⟦]*)⟦\/RE⟧\s*/, (a, f) => { re = gFindQuoted(f, at, gc); return ''; });
  tx = tx.replace(/⟦\/?RE⟧/g, '').replace(/\[[^\]\n]{1,80}\]/g, '').trim();
  const nmRe = new RegExp('^\\*?\\*?(?:' + c.name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\*?\\*?\\s*:\\s*', 'i');   // 9.57: numele escapat (un nume cu „(” sau „+” arunca eroare și oprea runda)
  tx = gNoOthers(tx, c, ms);   // 9.65: dacă AI-ul a început să scrie și replicile altora („Nkechi: …”), ne oprim acolo
  let parts = tx.split(/\n\s*\/\/\s*\n|\n\s*\/\/\s*$|^\s*\/\/\s*\n/).map(x => x.replace(nmRe, '').trim()).filter(Boolean);
  const cutOff = meta.stop && meta.stop !== 'end_turn' && meta.stop !== 'stop_sequence';
  if(parts.length > 3) parts = parts.slice(0, 3);
  else if(cutOff) parts = gTrimCut(parts);   // 9.65: oprit la limită / conexiune căzută: fără propoziții tăiate
  return {parts, re};
}
/* 9.60: cine scrie pe Haiku în grup. Primul răspuns la mesajul tău rămâne pe Sonnet (în afară de „mult” + mesaj simplu);
   cele care se alătură după, pe Haiku, dacă mesajul nu e important; bomba, pozele și cele pomenite pe nume, pe Sonnet; ancoră pe personaj. */
function gEco(k, c, text, more, x, mentioned, photo, gc){
  const L = mixLvl(c); if(L === 'off' || S.aux === 'off' || auxBroken || String(S.model || '').toLowerCase().includes('haiku')) return false;
  if(x.bomb || (photo && photo.by === c)) return false;
  if(x.task && L !== 'mult') return false;   // 9.67: ce a cerut liderul se face pe modelul principal
  const P = MIX_P[L]; gc.ecoRun = gc.ecoRun || {};
  if((gc.ecoRun[c.id] || 0) >= P.streak + 1) return false;   // ancora: personajul scrie din nou pe Sonnet
  const t = plain(String(text || '')).trim(), heavy = !!t && (MIX_HEAVY.test(t) || t.length > P.len);
  let eco;
  if(x.spect || more) eco = k > 0 ? L !== 'putin' || !heavy : L === 'mult';
  else if(k === 0) eco = L === 'mult' && !heavy && !mentioned.includes(c);
  else eco = L === 'mult' ? !mentioned.includes(c) : L === 'echilibrat' ? !heavy && !mentioned.includes(c) : !heavy && t.length <= 42 && !mentioned.includes(c);
  gc.ecoRun[c.id] = eco ? (gc.ecoRun[c.id] || 0) + 1 : 0;
  return eco;
}
/* 9.65: propoziții tăiate în grup. Dacă răspunsul s-a oprit la limită sau conexiunea a căzut, ultima bulă se taie la ultima
   propoziție întreagă (punct, semn de întrebare/exclamare, „…” sau emoji la final); dacă nu are niciuna, bula se renunță (sau,
   dacă e singura, rămâne până la ultimul cuvânt întreg, cu „…”). */
function gTrimCut(parts){
  if(!parts.length) return parts;
  const last = parts[parts.length - 1], keep = parts.slice(0, -1);
  const m = last.match(/^[\s\S]*[.!?…](?:[\s\u201d"»)\]]|$)|^[\s\S]*\p{Extended_Pictographic}\uFE0F?(?=\s|$)/u);
  const done = m ? m[0].trim() : '';
  if(done.length >= 6) return keep.concat(done);
  if(keep.length) return keep;
  const words = last.split(/\s+/); words.pop(); const t = words.join(' ').replace(/[,;:\s]+$/, '');
  return t.length >= 6 ? [t + '…'] : [];
}
// 9.65: textul scris de un personaj se oprește unde începe replica altui personaj din grup (sau a ta)
function gNoOthers(tx, c, ms){
  const names = ms.filter(o => o.id !== c.id).flatMap(o => [o.name, o.name.split(' ')[0]]).concat([S.userName.trim()].filter(Boolean))
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if(!names.length) return tx;
  const re = new RegExp('\\n\\s*\\**\\s*(?:' + names.join('|') + ')\\s*\\**\\s*:', 'i'), k = tx.search(re);
  return k > 0 ? tx.slice(0, k).trim() : tx;
}
/* (5) + (6): pozele în grup: selfie de la una din ele sau poză cu mai multe (fețele tuturor ca repere) */
async function gPhotoShot(g, people, gc = gchat){
  const u = S.userName.trim() || 'the user', recent = gc.msgs.slice(-12).map(gLine).filter(Boolean).join('\n');
  try{
    const out = await stream('You describe one photo for an image generator. Answer with the English description only.', [{role:'user', text:
`Group chat "${g.name}" (Romanian):
${recent}
Describe ONE natural, ordinary smartphone photo of ${people.map(c => c.name).join(' and ')}${people.length > 1 ? ' together' : ' (a selfie)'} that fits this conversation and what ${u} asked: place, how they stand or sit, what they wear, expression, light matching the time of day (${todEn()}). Everyone is an adult and fully clothed. Do not describe faces or bodies. 40-70 words.`}], {max:200, aux:true, tag:'pozeai'});
    const t = String(out || '').trim(); if(t.length > 20) return t;
  }catch(e){ if(e.name === 'AbortError') throw e; }
  return people.length > 1 ? `photo of ${people.map(c => c.name).join(' and ')} together, smiling, casual everyday clothes, natural light` : 'casual selfie, natural light, everyday clothes';
}
async function gPhoto(g, ph, signal, gc = gchat){
  const people = ph.names.length ? ph.names : [ph.by], by = ph.by || people[0];
  const shot = await gPhotoShot(g, people, gc);
  let blob;
  if(people.length === 1){ const r = await makeScenePhoto(people[0], shot, signal, {}); blob = r.blob; }
  else {
    const faces = [];
    for(const c of people){ const b = c.photo ? await DB.get(c.photo).catch(() => null) : null; if(!b) continue; let id = null; try{ id = await identityOf(c); }catch(e){} faces.push({c, f:await cropFace(b, id && !id.none ? id : null), id}); }
    if(!faces.length) throw new Error('nu au poze de profil');
    const roles = faces.map((x, k) => { const tx = idText(x.c, x.id).t; return `image ${k + 1} is ${x.c.name}'s face${tx ? ' (' + tx.slice(0, 260) + ')' : ''}`; }).join('; ');   // 9.50
    const st = (faces[0].c.stil || 'photo');
    const prompt = `${stilLead(st)}One natural group photo of exactly ${faces.length} people together: ${shot}. ${roles}. Each person appears exactly once, with exactly the face from her or his image; they are different people. Everyone is an adult, fully clothed, ordinary everyday photo, not a collage. ${STIL_TAG[st]}`;
    pstage(signal, '📸 Poză cu ' + faces.map(x => x.c.name).join(', '), 60);
    if(useF3()) blob = await f3Image(prompt, faces.map(x => x.f), '912x656', signal);
    else blob = await genImage(prompt, faces[0].f, signal, faces[1] && faces[1].f, {model:S.wkChat || 'ancorat', force:{two:faces.length > 1}, extra:faces.slice(2, 4).map(x => x.f), p1:prompt, why:'grup'});
    addUsage(by.id, imgPrice(), 'img', null, 'grup');
  }
  try{ if(blob.type === 'image/png') blob = await toJpeg(blob, 2048, .92); }catch(e){}
  const k = await saveImg(blob);
  gc.msgs.push({id:uid(), role:'ai', cid:by.id, img:k, text:'', scene:shot, ts:Date.now(), people:people.map(c => c.id)});
  if(!gViewing(g)) g.unread = (g.unread || 0) + 1;
}
/* (4) + (9): dinamica grupului și rezumatul, la zi; faptele noi despre tine intră în memoria fiecăreia */
async function gDyn(g, gc = gchat){
  const ms = gMembers(g), u = S.userName.trim() || 'utilizatorul', recent = gc.msgs.slice(-24).map(gLine).filter(Boolean).join('\n');
  if(!recent) return 0;
  const pairs = []; for(let a = 0; a < ms.length; a++) for(let b = a + 1; b < ms.length; b++) pairs.push([ms[a], ms[b]]);
  const relNow = pairs.map(([a, b]) => { const r = gRelOf(gc, a, b); return `${a.name} + ${b.name}: ${r ? r.t + ' (' + r.s + ')' + (r.lock ? ' [FIXATĂ de ' + u + ', n-o include]' : '') : relBetween(a, b) || 'încă nimic'}`; }).join('; ');
  const meNow = ms.map(c => { const m = gMeOf(gc, c); return `${c.name}: ține la ${u} ${m.care}/100, îl ajută ${m.help}/100${m.lock ? ' [FIXAT de ' + u + ', nu-l include]' : ''}`; }).join('; ');
  const j = await crAskJSON('Urmărești dinamica unui grup de chat. Răspunzi DOAR cu JSON valid, în română.',
`Grupul „${g.name}”: ${u} și ${ms.map(c => c.name).join(', ')}.
Dinamica de până acum: ${gc.dyn || '(încă nimic)'}
Relațiile dintre ele până acum: ${relNow}
Ultimele mesaje:
${recent}
Față de ${u} acum: ${meNow}
Scrie JSON, cu "rel" PRIMUL: {"rel":[{"a":"numele exact al primului personaj","b":"numele exact al celui de-al doilea personaj","t":"relația lor acum, 2-5 cuvinte","s":0}],"me":[{"name":"numele exact","care":0,"help":0,"why":"de ce, max 8 cuvinte"}],"dyn":"dinamica actualizată, max 80 de cuvinte: ce rol are fiecare în grup (cine bârfește, cine mediază, cine e tăcută…), cine cu cine se înțelege sau se ciondănește, glumele interne; păstrează ce era valabil","recap":"ce s-a vorbit recent în grup, max 50 de cuvinte, la persoana a III-a","facts":["lucruri noi și durabile despre ${u}, spuse de ${u} în grup (max 3, câte o propoziție scurtă), sau []"]}
Exemple pentru "t": cele mai bune prietene, se tachinează, rivale, supărate una pe alta, se împacă.
La "me": pentru fiecare personaj nefixat, cât ține la ${u} („care”) și cât e gata să-l ajute („help”), 0-100, pornind de la valorile de acum; schimbă cu cel mult 8 puncte și doar dacă mesajele arată asta (a fost ajutat sau rănit, l-a apărat, l-a ignorat).
La "rel": returnează un ARRAY JSON, cu câte un obiect pentru fiecare pereche (${pairs.map(([a, b]) => a.name + ' + ' + b.name).join('; ')}); "s" de la -2 (ceartă) la 2 (foarte apropiate); schimb-o doar dacă mesajele chiar arată asta, altfel păstreaz-o.`, 1400 + pairs.length * 60);   // 9.58: 800 tăia JSON-ul exact la relații (erau ultimele)
  if(gc.dead) return;
  if(j.dyn) gc.dyn = faraLiniute(String(j.dyn)).slice(0, 700);
  if(j.recap){ gc.recap = faraLiniute(String(j.recap)).slice(0, 500); g.recap = gc.recap; g.recapAt = Date.now(); }
  const nRel = gRelUpdate(g, gc, ms, j.rel || j.relationships || j.relations || j.relatii || j['relații'] || (j.data && (j.data.rel || j.data.relationships)) || []);
  gMeUpdate(gc, ms, j.me || j.toMe || j.user || []);   // 9.59
  const fs = (Array.isArray(j.facts) ? j.facts : []).map(x => faraLiniute(String(x || '').trim())).filter(x => x.length > 4).slice(0, 3);
  if(fs.length){ for(const c of ms){ c.facts = c.facts || []; for(const t of fs) if(!c.facts.some(f => f.t === t)) c.facts.push({t, ts:Date.now(), src:'grup'}); c.facts = c.facts.slice(-40); } await saveChars(); }
  await gSave(g, gc);
  if(grp === g) renderGroup();
  return nRel;
}
/* 9.58: personajele dintr-un grup se cunosc între ele: pentru fiecare pereche fără legătură, cum se cunosc (S.socRel, folosit
   și în chaturile private) și cum sunt acum (gc.rel, punctul de pornire al relațiilor din grup). Un singur apel, la deschidere. */
async function gKnow(g, gc = gchat, force){
  const ms = gMembers(g); if(ms.length < 2 || !aiReady() || !gc) return 0;
  const pairs = []; for(let a = 0; a < ms.length; a++) for(let b = a + 1; b < ms.length; b++) pairs.push([ms[a], ms[b]]);
  const need = pairs.filter(([a, b]) => !relBetween(a, b) || !gRelOf(gc, a, b));
  if(!need.length || (!force && Date.now() - (gc.knowTry || 0) < 10 * 60e3)) return 0;
  if(gBusyP.know[g.id]) return gBusyP.know[g.id];
  gc.knowTry = Date.now();
  const d = c => `- ${c.name}${c.tag ? ' (' + c.tag + ')' : ''}${c.city ? ', din ' + c.city : ''}: ${String(c.persona || '').slice(0, 300)}`;
  gBusyP.know[g.id] = (async () => {
    const j = await crAskJSON('Stabilești cum se cunosc personajele dintr-un grup de chat, realist și coerent cu fișele lor. Răspunzi DOAR cu JSON valid, în română.',
`Grupul „${g.name}”${g.topic ? ' (' + g.topic + ')' : ''}. Personajele:
${ms.map(d).join('\n')}
Pentru fiecare pereche: ${need.map(([a, b]) => a.name + ' + ' + b.name).join('; ')}
- "how": cum se cunosc din viața reală, 2-7 cuvinte, valabil în ambele sensuri (ex. prietene din liceu, colege de birou, vecine de bloc, verișoare). Dacă fișele spun deja ceva despre asta, folosește exact asta. Fără relații romantice între ele dacă fișele nu spun altfel.
- "t": cum sunt acum una cu alta, 2-5 cuvinte; "s": de la -2 (ceartă) la 2 (foarte apropiate).
JSON: {"pairs":[{"a":"nume exact","b":"nume exact","how":"","t":"","s":1}]}`, 300 + need.length * 90);
    const find = n => { const x = pnorm(n || ''), f = x.split(' ')[0]; return ms.find(c => pnorm(c.name) === x) || ms.find(c => pnorm(c.name.split(' ')[0]) === f); };
    let arr = j.pairs || j.rel || j.perechi || []; if(!Array.isArray(arr) && typeof arr === 'object') arr = Object.entries(arr).map(([k, v]) => ({...(typeof v === 'object' ? v : {how:v}), a:k.split(/\s*\+\s*/)[0], b:k.split(/\s*\+\s*/)[1]}));
    S.socRel = S.socRel || {}; gc.rel = gc.rel || {}; let n = 0;
    for(const r of Array.isArray(arr) ? arr : []){
      const a = find(r && r.a), b = find(r && r.b); if(!a || !b || a === b) continue;
      const k = pairKey(a.id, b.id), how = faraLiniute(String(r.how || '')).replace(/[„”"]/g, '').trim().slice(0, 80), t = faraLiniute(String(r.t || '')).replace(/[.„”"]/g, '').trim().slice(0, 50);
      if(how.length > 3 && !S.socRel[k]){ S.socRel[k] = how; n++; }
      const sn = (S.socNow || {})[k];   // 9.74: ce ai setat în profilul personajului are prioritate
      if((t || sn) && !gc.rel[k]){ gc.rel[k] = sn ? {t:sn.t, s:sn.s, at:Date.now()} : {t, s:Math.max(-2, Math.min(2, Math.round(Number(r.s) || 0))), at:Date.now()}; n++; }
    }
    if(n){ saveSettings(); if(!gc.dead) await gSave(g, gc); if(grp === g) renderGroup(); }
    return n;
  })();
  try{ return await gBusyP.know[g.id]; } finally { delete gBusyP.know[g.id]; }
}
/* 9.61: legătura privat → grup. Pentru fiecare personaj din grup al cărui chat privat cu tine s-a schimbat de la ultima citire,
   Haiku citește ultimele mesaje private și notează (c.grpNote): cum e acum cu tine, ce ți-a zis despre celelalte din grup,
   o aluzie firească pe care o poate face și ce rămâne între voi. Nota intră doar în rândul ei (`gTurn`), nu la celelalte. */
async function gPrivRead(c){
  const tid = c.thread || 'main', mem = live && live.c && live.c.id === c.id && live.ch && (live.ch.tid || 'main') === tid ? live.ch : (cur && cur.id === c.id && chat && (chat.tid || 'main') === tid ? chat : null);
  const ch = mem || (await DB.get(chatKey(c.id, tid)).catch(() => null)) || {msgs:[]};
  return (ch.msgs || []).filter(m => !m.err && !m.pending && (m.role === 'user' || m.role === 'ai') && m.text);
}
// 9.61: lucrul în curs pe grup stă aici, nu pe obiectul grupului (o promisiune nu se poate salva în baza de date: salvarea grupurilor eșua)
const gBusyP = {priv:{}, know:{}};
async function gPrivSync(g, force){
  if(gBusyP.priv[g.id]) return gBusyP.priv[g.id];   // marcat imediat (înainte de orice citire), ca un răspuns din grup să-l poată aștepta
  gBusyP.priv[g.id] = gPrivWork(g, force);
  try{ return await gBusyP.priv[g.id]; } finally { delete gBusyP.priv[g.id]; }
}
async function gPrivWork(g, force){
  const ms = gMembers(g); if(!ms.length || !aiReady()) return 0;
  const u = S.userName.trim() || 'utilizatorul', todo = [];
  for(const c of ms){ const msgs = await gPrivRead(c); if(!msgs.length) continue; const lastTs = msgs[msgs.length - 1].ts || 0;
    if(!force && c.grpNote && (c.grpNote.upTo || 0) >= lastTs) continue;
    if(!force && c.grpNote && Date.now() - (c.grpNote.at || 0) < 5 * 60e3) continue;   // cel mult o dată la 5 minute pe personaj
    todo.push({c, msgs:msgs.slice(-16), lastTs}); }
  if(!todo.length) return 0;
  {
    const j = await crAskJSON('Citești conversații private dintr-o poveste și notezi ce contează pentru un grup de chat. Răspunzi DOAR cu JSON valid, în română.',
`${u} are câte o conversație privată cu fiecare dintre aceste personaje. Ele sunt și împreună într-un grup de chat: ${ms.map(c => c.name).join(', ')}.
${todo.map(x => `### Conversația privată dintre ${x.c.name} și ${u} (ultimele mesaje)
${x.msgs.map(m => (m.role === 'user' ? u : x.c.name) + ': ' + plain(m.text).replace(/\s+/g, ' ').slice(0, 300)).join('\n')}`).join('\n\n')}
Pentru fiecare dintre: ${todo.map(x => x.c.name).join(', ')}, scrie:
- "mood": cum e ea acum cu ${u}, după conversația privată (max 12 cuvinte; ex. „caldă și complice după seara de ieri”, „ușor supărată că n-a răspuns”);
- "others": ce i-a spus ea lui ${u} în privat despre celelalte din grup (max 2, doar dacă chiar a zis ceva; altfel []);
- "carry": un singur lucru din privat la care poate face aluzie firesc în grup, fără să-l dezvăluie (max 15 cuvinte, sau "");
- "secrets": ce s-a spus între ei doi și NU trebuie să afle grupul (max 3, scurt; sau []).
JSON: {"chars":[{"name":"","mood":"","others":[{"name":"","t":""}],"carry":"","secrets":[]}]}`, 300 + todo.length * 220);
    const find = n => { const a = pnorm(n || ''), f = a.split(' ')[0]; return todo.find(x => pnorm(x.c.name) === a) || todo.find(x => pnorm(x.c.name.split(' ')[0]) === f); };
    const cl = v => faraLiniute(String(v || '')).replace(/[„”"]/g, '').trim();
    let n = 0;
    for(const r of Array.isArray(j.chars) ? j.chars : []){
      const x = find(r && r.name); if(!x) continue;
      x.c.grpNote = {mood:cl(r.mood).slice(0, 120), carry:cl(r.carry).slice(0, 140),
        others:(Array.isArray(r.others) ? r.others : []).map(o => ({name:cl(o && o.name).slice(0, 40), t:cl(o && o.t).slice(0, 120)})).filter(o => o.name && o.t && ms.some(c => c !== x.c && pnorm(c.name.split(' ')[0]) === pnorm(o.name.split(' ')[0]))).slice(0, 2),
        secrets:(Array.isArray(r.secrets) ? r.secrets : []).map(t => cl(t).slice(0, 120)).filter(Boolean).slice(0, 3), at:Date.now(), upTo:x.lastTs};
      n++;
    }
    for(const x of todo) if(!x.c.grpNote || x.c.grpNote.upTo !== x.lastTs) x.c.grpNote = {...(x.c.grpNote || {}), at:Date.now(), upTo:x.lastTs};   // fără răspuns pentru ea: nu mai cerem până se schimbă ceva
    await saveChars();
    return n;
  }
}
// 9.48 (5): relațiile: se actualizează din ce vorbesc; o schimbare clară apare ca rând în grup
function gRelUpdate(g, gc, ms, arr){
  // 9.58: AI-ul întoarce uneori relațiile ca obiect {"Ana + Maria": {...}} sau {"Ana + Maria": "text"}: numele vin din cheie
  if(arr && !Array.isArray(arr) && typeof arr === 'object') arr = Object.entries(arr).map(([k, v]) => { const nm = k.split(/\s*(?:\+|\||&|↔|<->|-|\bși\b|\bsi\b|\band\b|,)\s*/i).filter(Boolean); const o = v && typeof v === 'object' ? {...v} : {t:String(v || '')}; if(!o.a && nm[0]) o.a = nm[0]; if(!o.b && nm[1]) o.b = nm[1]; return o; });
  if(!Array.isArray(arr)) return 0;
  let n = 0;
  const find = n => { const a = pnorm(n || ''), f = a.split(' ')[0]; return ms.find(c => pnorm(c.name) === a) || ms.find(c => pnorm(c.name.split(' ')[0]) === f); };
  gc.rel = gc.rel || {}; gc.relLog = gc.relLog || [];
  for(const r of arr){
    let a = find(r && (r.a || r.from || r.p1 || (Array.isArray(r.pair) && r.pair[0]) || (Array.isArray(r.names) && r.names[0]))), b = find(r && (r.b || r.to || r.p2 || (Array.isArray(r.pair) && r.pair[1]) || (Array.isArray(r.names) && r.names[1])));
    if((!a || !b) && r && typeof r.pair === 'string'){ const nm = r.pair.split(/\s*(?:\+|\||&|↔|-|\bși\b|\bsi\b)\s*/i); a = a || find(nm[0]); b = b || find(nm[1]); }
    if(!a || !b || a === b) continue;
    const t = faraLiniute(String(r.t || r.relation || r.description || '')).replace(/[.„”"]/g, '').trim().slice(0, 50); if(!t) continue;
    const rawScore = r.s ?? r.score ?? r.closeness ?? 0;
    const sc = Math.max(-2, Math.min(2, Math.round(Number(rawScore) || 0))), k = pairKey(a.id, b.id), old = gc.rel[k];
    if(old && old.lock) continue;   // 9.59: fixată de tine
    gc.rel[k] = {t, s:sc, at:Date.now()}; n++;
    if(old && (Math.abs(old.s - sc) >= 1 || (pnorm(old.t) !== pnorm(t) && Math.abs(old.s - sc) >= 1))){
      const txt = `🕸️ ${a.name} și ${b.name}: acum „${t}”${sc > old.s ? ' 💞' : ' ⚡'}`;
      gc.msgs.push({id:uid(), role:'sys', text:txt, ts:Date.now(), rel:true});
      gc.relLog.push({k, from:old.t, to:t, s:sc, ts:Date.now()}); gc.relLog = gc.relLog.slice(-30);
    }
  }
  return n;
}
function gMeUpdate(gc, ms, arr){
  if(arr && !Array.isArray(arr) && typeof arr === 'object') arr = Object.entries(arr).map(([k, v]) => ({...(v && typeof v === 'object' ? v : {}), name:k}));
  if(!Array.isArray(arr)) return 0;
  const find = n => { const a = pnorm(n || ''), f = a.split(' ')[0]; return ms.find(c => pnorm(c.name) === a) || ms.find(c => pnorm(c.name.split(' ')[0]) === f); };
  gc.me = gc.me || {}; let n = 0;
  for(const r of arr){
    const c = find(r && r.name); if(!c) continue;
    const old = gMeOf(gc, c); if(old.lock) continue;
    const step = (o, v) => v == null || v === '' || isNaN(+v) ? o : gClamp(Math.max(o - 8, Math.min(o + 8, +v)));   // cel mult 8 puncte o dată
    const care = step(old.care, r.care), help = step(old.help, r.help), why = faraLiniute(String(r.why || '')).replace(/[„”"]/g, '').trim().slice(0, 80);
    gc.me[c.id] = {care, help, why:why || old.why || '', at:Date.now()}; n++;
  }
  return n;
}
function gRelLines(gc, ms){
  if(!gc || !gc.rel) return '';
  const out = []; for(let a = 0; a < ms.length; a++) for(let b = a + 1; b < ms.length; b++){ const r = gRelOf(gc, ms[a], ms[b]); if(r) out.push(`${ms[a].name} + ${ms[b].name}: ${r.t}`); }
  return out.join('; ');
}
// 9.59: pentru regizor: cât ține fiecare la tine și cât te ajută
function gMeLines(gc, ms){ return ms.map(c => { const m = gMeOf(gc, c); return `${c.name} cares ${m.care}/100, helps ${m.help}/100`; }).join('; '); }
// harta relațiilor: personajele în cerc, liniile colorate după cât de apropiate sunt
// 9.59: fiecare pereche și fiecare „față de tine” se poate edita și fixa (🔒 = AI-ul nu le mai schimbă)
function gRelSheet(scrollMe){
  if(!grp) return;
  const g = grp, gc = gchat, ms = gMembers(g), W = 320, H = 250, cx = W / 2, cy = H / 2, R = ms.length > 3 ? 92 : 80;
  const pos = ms.map((c, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / ms.length; return {c, x:cx + R * Math.cos(a) * 1.18, y:cy + R * Math.sin(a)}; });
  const pairs = []; for(let a = 0; a < pos.length; a++) for(let b = a + 1; b < pos.length; b++) pairs.push([pos[a], pos[b], gRelOf(gc, pos[a].c, pos[b].c)]);
  const lines = pairs.map(([p, q, r]) => { const col = r ? G_RELC[String(r.s)] : 'var(--line)', mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${col}" stroke-width="${r ? 2 + Math.abs(r.s) : 1.5}" ${r && r.s < 0 ? 'stroke-dasharray="6 5"' : ''} stroke-linecap="round"/>${r ? `<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="middle" class="grlt">${r.lock ? '🔒 ' : ''}${esc(r.t.length > 20 ? r.t.slice(0, 19) + '…' : r.t)}</text>` : ''}`; }).join('');
  const avs = pos.map(p => { const m = gMeOf(gc, p.c); return `<span class="grav" style="left:${p.x / W * 100}%;top:${p.y / H * 100}%">${avatarHTML(p.c)}<b>${esc(gShort(p.c, pos.map(x => x.c)))}</b><small class="grme" style="--mc:${gMeCol(m.care)}">💗${m.care}</small></span>`; }).join('');
  const list = pairs.map(([p, q, r], i) => `<button type="button" class="grrow grbtn" data-gre="${i}"><i style="background:${r ? G_RELC[String(r.s)] : 'var(--line)'}"></i><b>${esc(p.c.name)} ↔ ${esc(q.c.name)}</b><span>${r ? (r.lock ? '🔒 ' : '') + esc(r.t) : '<em>setează</em>'}${relBetween(p.c, q.c) ? '<br><small>' + esc(relBetween(p.c, q.c)) + '</small>' : ''}</span><u>✏️</u></button>`).join('');
  const bar = (v, e) => `<span class="grbar"><em>${e}</em><span><i style="width:${v}%;background:${gMeCol(v)}"></i></span><b>${v}</b></span>`;
  const me = ms.map(c => { const m = gMeOf(gc, c); return `<button type="button" class="grrow grbtn grmerow" data-gme="${c.id}">${avatarHTML(c)}<span class="grmeb"><b>${m.lock ? '🔒 ' : ''}${esc(c.name)}</b>${bar(m.care, '💗')}${bar(m.help, '🤝')}${m.why ? '<small>' + esc(m.why) + '</small>' : ''}</span><u>✏️</u></button>`; }).join('');
  const log = (gc.relLog || []).slice(-5).reverse().map(l => { const [a, b] = l.k.split('|').map(id => (charById(id) || {}).name || '?'); return `<div class="grlog">${when(l.ts)} · ${esc(a)} și ${esc(b)}: „${esc(l.from || '—')}” → „${esc(l.to)}”${l.by === 'me' ? ' (tu)' : ''}</div>`; }).join('');
  openSheet(`<h4>🕸️ Relațiile din „${esc(g.name)}”</h4><div class="pad">
    <div class="grmap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${lines}</svg>${avs}</div>
    <p style="margin:6px 0 2px"><b>Între ele</b> <small class="hint">atinge ca să schimbi sau să fixezi</small></p>${list}
    <p id="grMeH" style="margin:14px 0 2px"><b>Față de tine</b> <small class="hint">💗 cât ține la tine · 🤝 cât te ajută</small></p>${me}
    ${log ? '<p style="margin:12px 0 4px"><b>Ce s-a schimbat</b></p>' + log : ''}
    <div class="btns"><button class="btn" id="grUpd">↻ Actualizează din conversație</button></div>
    <p class="hint">Ce fixezi cu 🔒 rămâne așa: AI-ul nu mai schimbă. Restul se mișcă singur, puțin câte puțin, după ce vorbiți.</p></div>`);
  hydrate($('.sheet'));
  if(scrollMe) requestAnimationFrame(() => { const h = $('#grMeH'); if(h) h.scrollIntoView({block:'start'}); });
  $$('.sheet [data-gre]').forEach(b => b.onclick = () => { const [p, q] = pairs[+b.dataset.gre]; gRelEdit(g, gc, p.c, q.c); });
  $$('.sheet [data-gme]').forEach(b => b.onclick = () => { const c = charById(b.dataset.gme); if(c) gMeEdit(g, gc, c); });
  $('#grUpd').onclick = async () => { const b = $('#grUpd'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Citesc grupul…';
    try{ await gKnow(g, gc, true).catch(() => 0); const n = gc.msgs.some(m => m.role !== 'sys') ? await gDyn(g, gc) : 0;   // 9.58: întâi cum se cunosc, apoi ce arată conversația
      closeSheet(); if(grp === g) gRelSheet();
      const have = gMembers(g).length > 1 && Object.keys(gc.rel || {}).length;
      toast(n ? '🕸️ Relațiile sunt la zi (' + n + ')' : have ? '🕸️ Relațiile au rămas cum erau' : '🕸️ AI-ul n-a întors relații. Mai încearcă.'); }
    catch(e){ toast('N-a mers: ' + (e.message || e)); b.disabled = false; b.textContent = '↻ Actualizează din conversație'; } };
}
// 9.59: editarea unei perechi
function gRelEdit(g, gc, a, b){
  const k = pairKey(a.id, b.id), r = gc.rel && gc.rel[k] || null, how = relBetween(a, b);
  let sc = r ? r.s : 0;
  openSheet(`<h4>${esc(a.name)} ↔ ${esc(b.name)}</h4><div class="pad">
    <label for="grHow">Cum se cunosc (și în chaturile private)</label><input id="grHow" maxlength="80" placeholder="ex. prietene din liceu, surori, colege de birou" value="${esc(how)}">
    <label for="grT" style="margin-top:10px">Cum sunt acum, în grup</label><input id="grT" maxlength="50" placeholder="ex. rivale, se tachinează, cele mai bune prietene" value="${esc(r ? r.t : '')}">
    <label style="margin-top:10px">Cât de apropiate</label>
    <div class="seg grseg" id="grS">${[-2, -1, 0, 1, 2].map(v => `<button type="button" data-v="${v}" class="${v === sc ? 'on' : ''}" style="--sc:${G_RELC[String(v)]}">${G_RELN[String(v)]}</button>`).join('')}</div>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="grLock" checked> 🔒 Fixată de mine (AI-ul n-o mai schimbă)</label>
    <div class="btns">${r && r.lock ? '<button class="btn" id="grAuto">↺ Las-o pe AI</button>' : ''}<button class="btn pri" id="grGo">Salvează</button></div></div>`);
  $('#grS').onclick = e => { const x = e.target.closest('[data-v]'); if(!x) return; sc = +x.dataset.v; $$('#grS button').forEach(y => y.classList.toggle('on', y === x)); };
  const back = () => { closeSheet(); if(grp === g) setTimeout(() => gRelSheet(), 60); };
  $('#grGo').onclick = async () => {
    const t = faraLiniute($('#grT').value).replace(/[„”"]/g, '').trim().slice(0, 50) || G_RELN[String(sc)].toLowerCase(), h = faraLiniute($('#grHow').value).replace(/[„”"]/g, '').trim().slice(0, 80);
    S.socRel = S.socRel || {}; if(h) S.socRel[k] = h; else delete S.socRel[k]; saveSettings();
    gc.rel = gc.rel || {}; const old = gc.rel[k];
    const lock = $('#grLock').checked; gc.rel[k] = {t, s:sc, at:Date.now(), lock};
    if(!old || old.t !== t || old.s !== sc){ gc.relLog = (gc.relLog || []).concat({k, from:old ? old.t : '', to:t, s:sc, ts:Date.now(), by:'me'}).slice(-30); }
    await gSave(g, gc); if(grp === g) renderGroup(); back(); toast('🕸️ Salvat' + (lock ? ' și fixat 🔒' : ''));
  };
  if($('#grAuto')) $('#grAuto').onclick = async () => { gc.rel[k].lock = false; await gSave(g, gc); back(); toast('↺ AI-ul o poate schimba din nou'); };
}
// 9.59: cât ține la tine / cât te ajută, ajustabile
function gMeEdit(g, gc, c){
  const m = gMeOf(gc, c);
  openSheet(`<h4>${esc(c.name)} față de tine</h4><div class="pad">
    <div class="crrow"><span>💗 Cât ține la tine</span><input type="range" id="gmC" min="0" max="100" step="1" value="${m.care}"><b id="gmCv">${m.care}</b></div>
    <p class="hint" id="gmCw"></p>
    <div class="crrow"><span>🤝 Cât te ajută</span><input type="range" id="gmH" min="0" max="100" step="1" value="${m.help}"><b id="gmHv">${m.help}</b></div>
    <p class="hint" id="gmHw"></p>
    <label for="gmWhy" style="margin-top:6px">De ce (opțional, ea știe)</label><input id="gmWhy" maxlength="80" placeholder="ex. o ajut mereu la mutări; m-a apărat de Maria" value="${esc(m.why || '')}">
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="gmLock" checked> 🔒 Fixat de mine (AI-ul nu le mai schimbă)</label>
    <div class="btns">${m.lock ? '<button class="btn" id="gmAuto">↺ Lasă-le pe AI</button>' : ''}<button class="btn pri" id="gmGo">Salvează</button></div></div>`);
  const sync = () => { const cv = +$('#gmC').value, hv = +$('#gmH').value; $('#gmCv').textContent = cv; $('#gmHv').textContent = hv;
    $('#gmCw').textContent = gCareHint(cv); $('#gmHw').textContent = gHelpHint(hv); };
  $('#gmC').oninput = sync; $('#gmH').oninput = sync; sync();
  const back = () => { closeSheet(); if(grp === g) setTimeout(() => gRelSheet(true), 60); };
  $('#gmGo').onclick = async () => {
    gc.me = gc.me || {}; gc.me[c.id] = {care:gClamp($('#gmC').value), help:gClamp($('#gmH').value), why:faraLiniute($('#gmWhy').value).replace(/[„”"]/g, '').trim().slice(0, 80), lock:$('#gmLock').checked, at:Date.now()};
    await gSave(g, gc); if(grp === g) renderGroup(); back(); toast('💗 Salvat' + (gc.me[c.id].lock ? ' și fixat 🔒' : ''));
  };
  if($('#gmAuto')) $('#gmAuto').onclick = async () => { gc.me[c.id].lock = false; await gSave(g, gc); back(); toast('↺ AI-ul le poate schimba din nou'); };
}
/* 9.48 (14): modul spectator: te uiți cum vorbesc între ele; dai un subiect sau o „bombă” și urmărești reacțiile */
const G_SPECT_ROUNDS = 8;
function gSpectStart(g){
  if(!g || !aiReady()) return;
  if(gMembers(g).length < 2){ toast('Ai nevoie de cel puțin 2 personaje în grup.'); return; }
  gSpect = {g, left:G_SPECT_ROUNDS};
  if(gchat) gchat.msgs.push({id:uid(), role:'sys', text:'👀 Te uiți. Ele vorbesc între ele (' + G_SPECT_ROUNDS + ' runde)', ts:Date.now()});
  gSave(); renderGroup(true); gSpectLoop(gSpect);
}
function gSpectStop(quiet){
  if(!gSpect) return; const s = gSpect; gSpect = null;
  if(s.g === grp && gchat){ delete gchat.subj; if(!quiet) gchat.msgs.push({id:uid(), role:'sys', text:'👀 Gata cu privitul', ts:Date.now()}); gSave(); renderGroup(); }   // 9.57: se salvează și la oprirea „tăcută”
  else DB.get('grp:' + s.g.id).then(gc => { if(gc && gc.subj){ delete gc.subj; return DB.set('grp:' + s.g.id, gc); } }).catch(() => {});
}
async function gSpectLoop(s){
  while(gSpect === s && s.left > 0){
    if(grp !== s.g || $('#vGroup').hidden || document.hidden){ await naps(1500); if(gSpect !== s) return; if(grp !== s.g){ gSpectStop(true); return; } continue; }
    if(gbusy){ await naps(700); continue; }
    s.left--; renderGroup();
    await gRespond(null, true, false, {spect:true}).catch(() => {});
    if(gSpect !== s) return;
    await naps(S.typeReal === 'off' ? 50 : (1200 + Math.random() * 1600) * gTone(s.g).pace);
  }
  if(gSpect === s){   // 9.60: întâi mesajul de final, apoi oprirea (altfel ecranul arăta o clipă „oprit” fără mesaj)
    if(grp === s.g && gchat){ delete gchat.subj; gchat.msgs.push({id:uid(), role:'sys', text:'👀 Pauză după ' + G_SPECT_ROUNDS + ' runde. Atinge „👀 Spectator” ca să continui.', ts:Date.now()}); }
    gSpect = null; if(grp === s.g && gchat){ renderGroup(); await gSave(); } }
}
function gSubjSheet(bomb){
  openSheet(`<h4>${bomb ? '💣 Aruncă o bombă în grup' : '🎬 Dă-le un subiect'}</h4><div class="pad">
    <textarea id="gsTxt" rows="3" maxlength="300" placeholder="${bomb ? 'ex. Am o veste: mă mut în Cluj luna viitoare!' : 'ex. Cine a fost prima voastră iubire?'}"></textarea>
    <p class="hint">${bomb ? 'Apare ca mesaj de la tine, marcat 💣; toate reacționează.' : 'Nu apare ca mesaj de la tine: ele încep să vorbească despre asta între ele.'}</p>
    <div class="btns"><button class="btn" data-close>Renunță</button><button class="btn pri" id="gsGo">${bomb ? '💣 Trimite' : '🎬 Dă subiectul'}</button></div></div>`);
  setTimeout(() => $('#gsTxt') && $('#gsTxt').focus(), 80);
  $('#gsGo').onclick = async () => {
    const t = $('#gsTxt').value.trim(); if(!t) return; closeSheet(); if(!grp) return;
    if(bomb){ $('#gInp').value = t; await gSend(true); return; }
    gchat.subj = t.slice(0, 300); gchat.msgs.push({id:uid(), role:'sys', text:'🎬 Subiect nou: ' + t.slice(0, 160), ts:Date.now()}); await gSave(); renderGroup(true);
    if(gSpect && gSpect.g === grp) gSpect.left = Math.max(gSpect.left, 4); else gSpectStart(grp);
  };
}
// (9) în chatul separat: ce s-a vorbit recent în grupurile din care face parte
function groupsRecapFor(c){
  const gs = groups.filter(g => g.members.includes(c.id) && g.recap && Date.now() - (g.recapAt || 0) < 10 * 864e5).slice(-2);
  return gs.length ? `## Din grupurile tale (le poți pomeni firesc)\n${gs.map(g => `- „${g.name}” (cu ${g.members.filter(id => id !== c.id).map(id => (charById(id) || {}).name).filter(Boolean).join(', ')}): ${g.recap}`).join('\n')}` : '';
}
/* 9.58: când un personaj îi promite în grup că îi scrie în privat, chiar îi scrie (nu mai depinde de zar și de pauza de 3 ore) */
const DM_PROMISE = /(?:(?:î[țt]i|iti|-[țt]i|te|v[ăa]|o s[ăa] (?:î[țt]i|iti|te))\s*(?:scriu|dau\s+(?:un\s+)?(?:mesaj|sms|dm|pm)|zic|spun|povestesc|explic|trimit|caut|sun)[^.!?\n]{0,40}?(?:(?:în|in|pe)\s+(?:privat|pm|dm|pv|inbox|mesaj privat)|separat|între\s+noi|intre\s+noi|între\s+patru\s+ochi|intre\s+patru\s+ochi|doar\s+ție|doar\s+tie))|(?:(?:în|in|pe)\s+(?:privat|pm|dm|pv|inbox)[^.!?\n]{0,30}?(?:î[țt]i|iti|-[țt]i|te)\s*(?:scriu|zic|spun|povestesc|explic|caut))|(?:(?:vorbim|discutăm|discutam|continuăm|continuam|povestim)\s+(?:în|in|pe)\s+(?:privat|pm|dm|pv|inbox))|(?:(?:check|verifică|verifica|uită-te|uita-te)\s+(?:dm|pm|privatul|inbox))/i;
const gDmPend = {};   // personaj → ora până la care o promisiune e deja în curs
function gDmPromise(g, c, text){
  if(!g || !c || !text || !DM_PROMISE.test(text) || (gDmPend[c.id] || 0) > Date.now()) return false;
  gDmPend[c.id] = Date.now() + 10 * 60e3;
  const wait = S.typeReal === 'off' ? 1500 : 20e3 + Math.random() * 40e3;   // îți scrie după ce se termină runda, ca un om
  setTimeout(() => gGossip(g, c, {promise:String(text).slice(0, 300)}).catch(() => { delete gDmPend[c.id]; }), wait);
  return true;
}
/* (8): bârfa în privat: una din ele îți scrie separat, în chatul ei */
async function gGossip(g, c, o = {}){
  const gm = {};   // 9.65: dacă mesajul privat s-a oprit la limită
  if(!c || !aiReady() || !charById(c.id) || !groups.includes(g)) return;
  if(!o.promise && Date.now() - (g.dmAt || 0) < 3 * 36e5) return;
  g.dmAt = Date.now(); await saveGroups();
  const u = S.userName.trim() || 'utilizatorul', recent = (grp === g ? gchat : (await DB.get('grp:' + g.id)) || {msgs:[]}).msgs.slice(-14).map(gLine).filter(Boolean).join('\n');
  const out = await stream(`Ești ${c.name}. ${c.persona || ''}\nCum vorbești: ${c.speech || 'natural'}. Rămâi în personaj; nu spui că ești un AI.`, [{role:'user', text:
`Ce s-a vorbit recent în grupul „${g.name}”:
${recent}
${o.promise ? `În grup tocmai i-ai spus lui ${u}: „${o.promise}”. Ține-te de cuvânt: scrie-i acum în PRIVAT (nu în grup) exact ce ai promis că îi spui separat, ca o continuare firească a ce ai zis acolo. 1-4 propoziții, în stilul tău, fără acțiuni lungi; nu repeta replica din grup.` : `Scrie-i acum lui ${u} în PRIVAT (nu în grup) un mesaj scurt despre ce s-a întâmplat în grup: o bârfă, o părere sinceră despre cineva, o glumă doar între voi doi. 1-2 propoziții, în stilul tău, fără acțiuni lungi.`}`}], {max:o.promise ? 500 : 320, cid:c.id, tag:'grup', aux:!o.promise, meta:gm});   // 9.60: bârfa obișnuită pe Haiku
  let tx = faraLiniute(stripMood(stripReact(String(out || '')))).replace(/\[[^\]\n]{1,80}\]/g, '').trim();
  if(gm.stop && gm.stop !== 'end_turn' && gm.stop !== 'stop_sequence') tx = (gTrimCut([tx])[0] || '');   // 9.65
  if(!tx) return;
  const tid = c.thread || 'main', key = chatKey(c.id, tid), msg = {id:uid(), role:'ai', text:tx, alts:[tx], alt:0, ts:Date.now(), pro:true, fromGroup:g.id};
  // 9.57: dacă chatul ei e în memorie (deschis sau încă scrie), mesajul intră acolo; altfel salvarea chatului deschis îl ștergea din DB
  const mem = live && live.c && live.c.id === c.id && live.ch && (live.ch.tid || 'main') === tid ? live.ch : (cur && cur.id === c.id && chat && (chat.tid || 'main') === tid ? chat : null);
  if(mem){ mem.msgs.push(msg); await saveChat(c, mem); if(mem === chat && !$('#vChat').hidden){ renderMsgs(true); return; } }
  else { const ch = (await DB.get(key)) || newChat(); ch.msgs.push(msg); await DB.set(key, ch); }
  c.last = tx.replace(/\*/g, '').slice(0, 90); c.lastAt = Date.now(); c.unread = (c.unread || 0) + 1; await saveChars();
  toast(`💬 ${c.name} ți-a scris în privat`, 3500); if(!$('#vHome').hidden) renderHome();
}
/* (7): grupul trăiește și fără tine: când revii după câteva ore, ce și-au scris între ele (un singur apel)
   9.47: rulează și din fundal (la pornire, la revenirea în aplicație, la 30 min), nu doar când deschizi grupul;
         grupul primește mesaje necitite pe ecranul principal; slotul se consumă doar dacă a reușit (la eroare reîncearcă după 20 min);
         pragul: 2 ore fără mesaje, cel mult 3 pe zi; și un grup nou, fără mesaje, prinde viață după 2 ore */
const G_LIFE_GAP = 2 * 36e5, G_LIFE_DAY = 3;
let gLifeRun = false;
function gLifeDue(g, gc){
  if(!g || g.life === false || S.groupLife === 'off' || gMembers(g).length < 2) return 0;
  const msgs = (gc.msgs || []).filter(m => m.role !== 'sys' && !m.err && !m.pending), last = msgs[msgs.length - 1];
  const lastTs = last ? (last.ts || 0) : (g.created || 0); if(!lastTs) return 0;
  const gap = Date.now() - lastTs;
  if(gap < G_LIFE_GAP || Date.now() - (gc.lifeAt || 0) < G_LIFE_GAP || Date.now() - (gc.lifeTry || 0) < 20 * 60e3) return 0;
  const d = dayKey(Date.now()); if(gc.lifeDay && gc.lifeDay.d === d && gc.lifeDay.n >= G_LIFE_DAY) return 0;
  return gap;
}
async function gLife(g, opts = {}){
  if(!aiReady() || gLifeRun || locked) return 0;
  const open = grp === g && gchat;
  if(open && gbusy) return 0;
  const gc = open ? gchat : ((await DB.get('grp:' + g.id)) || {msgs:[]});
  const gap = gLifeDue(g, gc); if(!gap) return 0;
  gLifeRun = true; gc.lifeTry = Date.now();
  const ms = gMembers(g), u = S.userName.trim() || 'utilizatorul', ac = new AbortController(); ac.g = g;
  if(open){ gbusy = ac; ac.typing = ms.slice(0, 2); renderGroup(); }
  const msgs = gc.msgs.filter(m => m.role !== 'sys'), last = msgs[msgs.length - 1];
  const base = last ? (last.ts || Date.now() - gap) : Date.now() - gap, mins = Math.max(5, Math.round(gap / 60000) - 1);
  let n = 0;
  try{
    const out = await stream('Scrii continuarea realistă a unui chat de grup între personaje. Răspunzi DOAR cu JSON valid, în română.', [{role:'user', text:
`Grupul „${g.name}”${g.topic ? ' (' + g.topic + ')' : ''}. Personajele:
${ms.map(c => `- ${c.name}: ${String(c.persona || c.tag || '').slice(0, 220)}${c.speech ? ' Vorbește: ' + c.speech : ''}`).join('\n')}
${gc.dyn ? 'Dinamica grupului: ' + gc.dyn + '\n' : ''}${msgs.length ? 'Ultimele mesaje:\n' + gc.msgs.slice(-12).map(gLine).filter(Boolean).join('\n') : 'Grupul e nou, încă nu și-a scris nimeni.'}
${u} a lipsit ${gapText(gap)} (acum e ${new Date().toLocaleString('ro-RO', {weekday:'long', hour:'2-digit', minute:'2-digit'})}). Între timp personajele și-au scris între ele, fără ${u}: ${gTone(g).life} mesaje scurte, ca într-un grup real.${(gc.rules || []).length ? ' Regulile grupului, stabilite de ' + u + ', le respectă: ' + gc.rules.map(r => r.t).join('; ') + '.' : ''}${gTone(g).sys ? ' ' + gTone(g).sys : ''}${gRelLines(gc, ms) ? ' Relațiile dintre ele: ' + gRelLines(gc, ms) + '.' : ''} Vorbesc UNA CU ALTA: își răspund, se tachinează, se contrazic, își povestesc ce au mai făcut, pun întrebări una alteia; fiecare în stilul ei; poate o pomenesc pe ${u} sau îl strigă la final. Să participe cel puțin două. Nu scrie mesaje de la ${u}.
JSON: {"summary":"pe scurt, un rând: ce au vorbit cât ai lipsit","messages":[{"name":"","text":"","min":30}]}  ("name" = exact unul dintre: ${ms.map(c => c.name).join(', ')}; "min" = câte minute după ultimul mesaj, crescător, între 1 și ${mins})`}], {max:1800, signal:ac.signal, cid:ms[0].id, tag:'grup', aux:true});   // 9.60: „cât ai lipsit” pe Haiku
    const j = parseJSON(out) || {};
    const who = nm => { const a = pnorm(nm || ''), f = a.split(' ')[0]; return ms.find(c => pnorm(c.name) === a) || ms.find(c => pnorm(c.name.split(' ')[0]) === f) || ms.find(c => f && pnorm(c.name).includes(f)); };
    const arr = (Array.isArray(j.messages) ? j.messages : []).map(x => ({c:who(x && x.name), text:faraLiniute(stripMood(stripReact(String(x && x.text || '')))).replace(/\[[^\]\n]{1,80}\]/g, '').trim(), min:Math.max(1, +(x && x.min) || 1)})).filter(x => x.c && x.text).slice(0, 12);
    if(!arr.length) throw new Error('răspuns gol');
    const d = dayKey(Date.now());
    gc.lifeDay = {d, n:(gc.lifeDay && gc.lifeDay.d === d ? gc.lifeDay.n : 0) + 1}; gc.lifeAt = Date.now(); delete gc.lifeErr;
    gc.msgs.push({id:uid(), role:'sys', text:'🌙 Cât ai lipsit' + (j.summary ? ' · ' + faraLiniute(String(j.summary)).slice(0, 160) : ''), ts:base + 1});
    let prevT = base + 2;
    for(const x of arr){ const ts = Math.min(Date.now() - 60e3, Math.max(prevT + 1, base + x.min * 60e3)); prevT = ts; gc.msgs.push({id:uid(), role:'ai', cid:x.c.id, name:x.c.name, text:x.text, ts, away:true}); }
    gc.dynN = (gc.dynN || 0) + 2; n = arr.length;
    const lm = gc.msgs[gc.msgs.length - 1];
    g.lastAt = Date.now(); g.last = gName(lm) + ': ' + plain(lm.text).slice(0, 80);
    if(!(grp === g && !$('#vGroup').hidden)) g.unread = (g.unread || 0) + n;
    let tgt = gc;
    if(grp === g && gchat && gchat !== gc && !gchat.dead){   // ai deschis grupul cât se scria: unim în conversația deschisă (9.57: același obiect, ca răspunsurile în curs să nu scrie într-o copie)
      const have = new Set(gchat.msgs.map(m => m.id)); for(const m of gc.msgs) if(!have.has(m.id)) gchat.msgs.push(m);
      gchat.msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      for(const k of ['lifeDay', 'lifeAt', 'lifeTry', 'dynN']) gchat[k] = gc[k]; delete gchat.lifeErr;
      tgt = gchat;
    }
    if(tgt.dead) return n;
    await DB.set('grp:' + g.id, tgt); await saveGroups();
    toast(`🌙 ${n} mesaje noi în „${g.name}” cât ai lipsit`, 3500);
    if(!$('#vHome').hidden) renderHome();
    const prom = arr.find(x => DM_PROMISE.test(x.text));   // 9.58: o promisiune făcută cât ai lipsit se ține și ea
    if(prom) gDmPromise(g, prom.c, prom.text);
    else if(Math.random() < .5) setTimeout(() => gGossip(g, arr[Math.floor(Math.random() * arr.length)].c).catch(() => {}), 8000);
  } catch(e){
    gc.lifeErr = String(e && e.message || e).slice(0, 160);
    // 9.57: dacă între timp ai deschis grupul (altă copie în memorie), salvăm copia deschisă; altfel mesajele tale noi se pierdeau
    if(grp === g && gchat && gchat !== gc){ if(!gchat.dead){ gchat.lifeTry = gc.lifeTry; gchat.lifeErr = gc.lifeErr; await DB.set('grp:' + g.id, gchat).catch(() => {}); } }
    else if(!gc.dead) await DB.set('grp:' + g.id, gc).catch(() => {});
    if(opts.loud && e.name !== 'AbortError') toast('🌙 Grupul n-a putut „trăi” fără tine: ' + gc.lifeErr + ' (reîncerc în 20 min)', 5000);
  } finally { gLifeRun = false; if(open && gbusy === ac) gbusy = null; if(grp === g) renderGroup(true);
    const ag = ac.again; if(ag && grp === ag.g && gchat === ag.gc && !ag.gc.dead) setTimeout(() => gRespond(ag.text, false, false, {bomb:ag.bomb}).catch(() => {}), 300); }
  return n;
}
// 9.47: din fundal, pentru toate grupurile (cel mult 2 pe tură, cele mai recente întâi)
async function gLifeSweep(){
  if(!groups.length || !aiReady() || locked || document.hidden || S.groupLife === 'off') return;
  let done = 0;
  for(const g of [...groups].filter(x => x.life !== false).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))){
    if(done >= 2 || document.hidden) break;
    if(grp === g && !$('#vGroup').hidden) continue;   // ești chiar în grup: nu „lipsești”
    if(await gLife(g).catch(() => 0)) done++;
  }
}

/* ───────── CONVERSAȚIE ───────── */
async function openChat(id, push = true, tid, dir){
  setTimeout(() => photoWarm(charById(id)), 3000);   // 9.86 (f)
  cur = charById(id); if(!cur) return;
  threadsOf(cur);
  tid = tid || cur.thread || 'main';
  if(!cur.threads.some(t => t.id === tid)) tid = cur.threads[0].id;
  cur.thread = tid;
  const prevChat = chat;
  chat = (live && live.c.id === id && (live.ch.tid || 'main') === tid) ? live.ch : await loadChat(cur, tid);
  if(prevChat && prevChat !== chat) idleJob(pruneUrls);   // 9.13.1: doar dacă s-au adunat foarte multe, și doar când telefonul e liber
  if(!chat.msgs.length && cur.greet) chat.msgs.push(greetMsg(cur));
  $('#chAv').outerHTML = avatarHTML(cur, 'av" id="chAv');
  $('#chName').textContent = cur.name;
  $('#chTag').innerHTML = statusLine();
  $('#chatBg').style.backgroundImage = '';
  if(cur.photo && ['clar', 'poza'].includes(cur.bg || 'clar')) $('#chatBg').dataset.bgk = photoNow(cur);
  applyLook(cur);
  renderScene();
  updateComposer();
  resetMsgWin(); markBusy(2200);   // 9.13.1: fără lucru de fundal cât se deschide
  const full0 = msgStart; msgStart = Math.max(msgStart, chat.msgs.length - 15); msgLight = msgStart > full0;   // 9.15: întâi doar ce încape pe ecran
  show('vChat', push, dir);
  if(cur.unread){ cur.unread = 0; saveChars(); }
  renderMsgs(true);
  hydrate($('#vChat'));
  // 9.15: după animație, restul ferestrei (până la 60 de mesaje) se adaugă deasupra; ce vezi rămâne pe loc
  if(msgStart > full0){ const ch0 = chat; afterShow(() => { msgLight = false; if(chat !== ch0 || $('#vChat').hidden || msgStart <= full0) return;
    const box = $('#msgs'), fromBottom = box.scrollHeight - box.scrollTop; msgStart = full0; renderMsgs(false, true); box.scrollTop = box.scrollHeight - fromBottom; }); }
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
  x += cRulesNote(c);   // 9.74: regulile voastre, la fiecare tură
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
  if(modeOf(chat) === 'chat') x += ' (mod chat pe telefon: scrie doar mesajul, ca pe WhatsApp, fără acțiuni narate între asteriscuri)';   // 9.31
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
    <div class="btns" style="margin-top:10px"><button class="btn" data-close>Renunță</button><button class="btn pri" id="giftGo" disabled>Trimite</button></div></div>`);
  $$('.gifts [data-g]').forEach(b => b.onclick = () => { $$('.gifts button').forEach(x => x.classList.remove('on')); b.classList.add('on'); pick = GIFTS[+b.dataset.g]; $('#gCustom').hidden = pick[0] !== '✍️'; $('#giftGo').disabled = false; if(pick[0] === '✍️') $('#gCustom').focus(); });
  $('#giftGo').onclick = async () => {
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
  return `## Oameni pe care îi cunoști\n${list.map(o => { const nw = socNowOf(c, o); return `- ${o.name}${o.tag ? ' (' + o.tag + ')' : ''}: ${relBetween(c, o)}${nw ? '; acum: ' + nw.t + ' (' + G_RELN[String(nw.s)].toLowerCase() + ')' : ''}`; }).join('\n')}\n${u} îi cunoaște și el. Îi pomenești rar și firesc (o întâmplare cu ei, ceva ce au postat), nu în fiecare mesaj. Nu știi ce vorbește ${u} cu ei între patru ochi și nu inventa asta.`;
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
Încredere: ${bondWord(b.trust, ['încă te ții în rezervă cu lucrurile personale', 'îi spui lucruri personale, dar nu chiar tot', 'ai încredere în el, îi spui și ce te frământă', 'ai încredere deplină; îi spui orice'])}. Apropiere: ${bondWord(b.warm, ['politicos, încă puțin distant', 'cald și prietenos', 'foarte cald, îți e drag', 'atașament profund, îți e dor de el când nu vorbiți'])}.${b.tension >= 45 && b.why ? `\nTensiune acum: ești puțin supărat(ă) sau rănit(ă) pentru că ${b.why}. Se simte discret (mai scurt, mai rece, o aluzie), fără scene. Dacă el își cere scuze sau lămurește, te înmoi treptat, nu brusc.` : ''}${arcs ? `\nMomente-cheie din relația voastră (le ții minte, le poți pomeni):\n${arcs}` : ''}${b.help != null ? `\nCât îl ajuți: ${gHelpWord(b.help)}.` : ''}${b.lock && b.why && b.tension < 45 ? `\nDe știut: ${b.why}.` : ''}`;
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
    const nb = b.lock ? {...b} : {...b, trust:cl(b.trust + cl(j.trust, -15, 15), 0, 100), warm:cl(b.warm + cl(j.warm, -15, 15), 0, 100), tension:cl(b.tension + cl(j.tension, -40, 40), 0, 100)};   // 9.74
    if(!b.lock) nb.why = nb.tension >= 25 ? String(j.why || b.why || '').trim().slice(0, 140) : '';
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
  const nb = b.lock ? {...b} : {...b, trust:cl(b.trust + cl(j.trust, -15, 15), 0, 100), warm:cl(b.warm + cl(j.warm, -15, 15), 0, 100), tension:cl(b.tension + cl(j.tension, -40, 40), 0, 100)};   // 9.74: fixată de tine = cifrele nu se mișcă
  if(!b.lock) nb.why = nb.tension >= 25 ? String(j.why || b.why || '').trim().slice(0, 140) : '';
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
- "glumă": o glumă internă, o poreclă sau o expresie născută între ei;
- "limbaj": un cuvânt, o expresie, un fel de a spune sau o poreclă care ține de felul în care vorbește ${u} sau de limbajul lor (cum îi spune el ei, o expresie pe care o tot folosește), scrisă exact, între ghilimele, și pe scurt cum o folosește.
Fără ce face doar în scenă, fără presupuneri. Poate fi [].
B) "relatie": cum s-a schimbat, realist, cu pași mici (de obicei -3..+4): trust (crește când e sincer, ține minte, o susține; scade când minte, ignoră, își bate joc), warm (apropiere, afecțiune), tension (o mică supărare reală: nepoliticos, a uitat ceva important, a lipsit mult după o promisiune; scade când se lămuresc; nu inventa conflicte), why (motivul tensiunii sau gol), moment (doar dacă s-a întâmplat ACUM ceva memorabil și nou: secret, gluma, sprijin, cearta, impacare, incredere, amintire, dor, surpriza; altfel null; "t" = propoziție scurtă la persoana a II-a plural).
JSON: {"fapte":[{"t":"…","tip":"fapt"}],"relatie":{"trust":0,"warm":0,"tension":0,"why":"","moment":null}}`, {max:600, tag:'fundal'});
  }catch(e){}
}
LATER.analiza = async (out, d, cid) => {   // 8.19: rezultatul analizei (direct sau din lot)
  const c = charById(cid); if(!c) return;
  try{
    const j = parseJSON(out);
    const arr = (Array.isArray(j.fapte) ? j.fapte : []).map(x => ({t:faraLiniute(String(x && x.t || '').trim()), k:x && /urm/i.test(x.tip || '') ? 'urm' : x && /gl/i.test(x.tip || '') ? 'gluma' : x && /lim/i.test(x.tip || '') ? 'lex' : ''}))
      .filter(x => x.t && !(c.facts || []).some(f => f.t === x.t)).slice(0, 5);
    if(arr.length) c.facts = (c.facts || []).concat(arr.map(x => ({t:x.t, ts:Date.now(), ...(x.k ? {k:x.k} : {})}))).slice(-40);
    if(j.relatie && typeof j.relatie === 'object') applyBond(c, j.relatie);
    await saveChars();
  }catch(e){}
}
function drawBond(c){
  const box = $('#pfBond'); if(!box) return;
  const b = bondOf(c), bar = (lbl, v, cls) => `<div class="bdrow"><span>${lbl}</span><div class="bdbar ${cls}"><i style="width:${v}%"></i></div><b>${v}</b></div>`;
  box.innerHTML = bar('🔐 Încredere', b.trust, 'tr') + bar('💗 Apropiere', b.warm, 'wm') + (b.help != null ? bar('🤝 Te ajută', b.help, 'wm') : '') + bar('⚡ Tensiune', b.tension, 'tn')
    + `<div class="bdedit"><small>${b.lock ? '🔒 fixată de tine' : 'se schimbă singură din conversații'}</small><button type="button" class="btn sm" id="pfBondEd">✏️ Ajustează</button></div>`
    + (b.tension >= 45 && b.why ? `<p class="bdwhy">E puțin supărat(ă): ${esc(b.why)}</p>` : '')
    + ((c.arcs || []).length ? `<div class="bdarcs">${c.arcs.slice(-6).reverse().map(a => `<div><i>${ARC_E[a.tip] || '💫'}</i><span>${esc(a.t)}<small>${new Date(a.ts).toLocaleDateString('ro-RO', {day:'numeric', month:'short'})}</small></span></div>`).join('')}</div>` : '<p class="hint" style="margin:8px 0 0">Momentele-cheie apar singure din conversații: primul secret, o glumă doar a voastră, o neînțelegere și împăcarea.</p>');
  const ed = $('#pfBondEd'); if(ed) ed.onclick = () => bondEdit(c, () => drawBond(c));   // 9.74
}

/* ───────── 📌 9.74: regulile și relațiile din grupuri, aduse în chatul cu un singur personaj ─────────
   (1) Regulile voastre (`c.rules = [{t, ts, by}]`, cel mult 10): spuse în chat („de acum…”, „nu mai…”, „mereu să…”) le prinde Haiku
       (`cRuleCheck`, doar dacă mesajul arată a regulă, în paralel cu răspunsul, fără întârziere) sau le scrii în 📌; intră în fiecare tură
       (după punctul de cache, ca în grup), deci și în apeluri.
   (2) Relația cu tine, ajustabilă și fixabilă (`bondEdit`): încredere, apropiere, tensiune cu motivul ei și, nou, 🤝 cât te ajută;
       🔒 fixat = analiza din fundal nu mai mișcă cifrele (momentele-cheie se notează în continuare); „↺ Lasă-le pe AI”.
       Ce setezi aici e și punctul de pornire în grupurile noi (`gMeOf`).
   (3) Oamenii pe care îi cunoaște (`cSocSheet`, `cSocEdit`): toate celelalte personaje, cum se cunosc (`S.socRel`, același ca în grupuri)
       și cum sunt acum (`S.socNow[k] = {t, s:-2..2}`), în promptul ei (`circleFor`) și ca relație de pornire în grupurile noi (`gKnow`). */
const C_RULE_MAX = 10;
const C_RULE_RE = /(?<!\p{L})(de acum|de-acum|de azi [îi]nainte|de ast[ăa]zi|[îi]ncep[âa]nd (de )?(acum|azi|de azi)|de fiecare dat[ăa]|ori de c[âa]te ori|niciodat[ăa]|mereu s[ăa]|[îi]ntotdeauna|regul[ăa]|regula|regulile|s[ăa] nu mai|nu mai (vreau|face|f[ăa]|zice|spune|scrie|folosi|folosește|pune|trimite|vorbi|vorbe[șs]ti|[îi]mi spune|[îi]mi zice)|anuleaz[ăa]|uit[ăa] (ce|regula)|po[țt]i s[ăa] (renun[țt]i|nu mai))(?!\p{L})/iu;
const cRuleNorm = v => faraLiniute(String(v || '')).replace(/[„”"«»]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
function cRuleApply(c, rule, unrule, by = 'chat'){
  if(!c) return {added:'', removed:''};
  const r = cRuleNorm(rule), ur = cRuleNorm(unrule); c.rules = c.rules || []; let added = '', removed = '';
  if(ur){ const k = c.rules.findIndex(x => pnorm(x.t).includes(pnorm(ur).slice(0, 24)) || pnorm(ur).includes(pnorm(x.t).slice(0, 24))); if(k >= 0) removed = c.rules.splice(k, 1)[0].t; }
  if(r && r.length > 3 && !c.rules.some(x => pnorm(x.t) === pnorm(r))){ c.rules.push({t:r, ts:Date.now(), by}); c.rules = c.rules.slice(-C_RULE_MAX); added = r; }
  return {added, removed};
}
async function cRuleCheck(c, text){
  if(!c || !aiReady() || !C_RULE_RE.test(String(text || ''))) return null;
  const u = S.userName.trim() || 'el', list = (c.rules || []).map(x => '- ' + x.t).join('\n') || '(niciuna)';
  try{
    const out = await stream('Recunoști reguli durabile puse într-o conversație. Răspunzi DOAR cu JSON valid, în română.', [{role:'user', text:
`Mesajul lui ${u} către ${c.name}, într-un chat: „${plain(String(text)).slice(0, 500)}”
Regulile lor de acum:
${list}

Stabilește ${u} prin mesajul ăsta o REGULĂ care să țină de acum înainte (cum să se poarte ${c.name}, cum să vorbească, cum să-i spună, ce să facă sau să nu mai facă mereu)? O cerere pentru acum (o poză, o întrebare, „spune-mi o glumă”) NU e regulă. Sau anulează una din regulile de acum?
- "rule": regula nouă, scurtă (cel mult 14 cuvinte), ca indicație pentru ${c.name}, la persoana a II-a (ex. Îi spui mereu iubire; Nu mai folosești emoji; Vorbiți doar în engleză); altfel "".
- "unrule": regula anulată, exact ca în listă; altfel "".
JSON: {"rule":"","unrule":""}`}], {max:160, aux:true, cid:c.id});
    const j = parseJSON(out) || {}, res = cRuleApply(c, j.rule, j.unrule, 'chat');
    if(res.added || res.removed){
      await saveChars();
      if(res.added) toast(`📌 Regulă nouă cu ${c.name}: ${res.added}`, 4500); else toast(`📌 Regula „${res.removed}” nu mai e`, 4000);
    }
    return res;
  }catch(e){ return null; }
}
function cRulesNote(c){   // pentru fiecare tură (după punctul de cache, nu strică cache-ul)
  const rs = (c && c.rules || []).map(r => r.t); if(!rs.length) return '';
  const u = S.userName.trim() || 'el';
  return ` (regulile stabilite de ${u} cu tine, le respecți mereu, chiar dacă nu le mai pomenește: ${rs.join('; ')})`;
}
function cRulesSheet(c, done){
  if(!c) return;
  const list = () => (c.rules || []).map((r, k) => `<li><span>${esc(r.t)}</span><button type="button" data-rx="${k}" aria-label="Șterge">✕</button></li>`).join('') || '<li><span style="color:var(--tx3)">Nicio regulă încă. Le poți scrie aici sau direct în chat („de acum…”, „nu mai…”).</span></li>';
  openSheet(`<h4>📌 Regulile tale cu ${esc(c.name)}</h4><div class="pad">
    <ul class="facts" id="crRules">${list()}</ul>
    <div class="addfact"><input id="crRuleIn" maxlength="160" placeholder="ex. îmi spui mereu pe nume"><button class="btn sm" id="crRuleAdd">＋</button></div>
    <p class="hint">Cele spuse în chat („de acum…”, „nu mai…”, „mereu să…”) apar singure aici. Le respectă în chat și în apeluri; cel mult ${C_RULE_MAX}.</p></div>`);
  const redraw = () => { $('#crRules').innerHTML = list(); done && done(); };
  $('#crRules').onclick = async e => { const b = e.target.closest('[data-rx]'); if(!b) return; c.rules.splice(+b.dataset.rx, 1); await saveChars(); redraw(); };
  $('#crRuleAdd').onclick = async () => { const v = $('#crRuleIn').value.trim(); if(!v) return; cRuleApply(c, v, '', 'me'); $('#crRuleIn').value = ''; await saveChars(); redraw(); };
  $('#crRuleIn').onkeydown = e => { if(e.key === 'Enter'){ e.preventDefault(); $('#crRuleAdd').click(); } };
}
// (2) relația cu tine, ajustabilă și fixabilă
const bondHelpOf = b => b.help != null ? b.help : gClamp(((b.warm + b.trust) / 2) - (b.tension || 0) / 2);
function bondEdit(c, done){
  const b = bondOf(c), hv0 = bondHelpOf(b);
  const row = (id, lbl, v) => `<div class="crrow"><span>${lbl}</span><input type="range" id="${id}" min="0" max="100" step="1" value="${v}"><b id="${id}v">${v}</b></div><p class="hint" id="${id}w"></p>`;
  openSheet(`<h4>💞 ${esc(c.name)} și tu, acum</h4><div class="pad">
    ${row('bdT', '🔐 Încredere', b.trust)}${row('bdW', '💗 Apropiere', b.warm)}${row('bdH', '🤝 Cât te ajută', hv0)}${row('bdX', '⚡ Tensiune', b.tension)}
    <label for="bdWhy">De ce (opțional; motivul supărării sau al relației, ea știe)</label><input id="bdWhy" maxlength="140" placeholder="ex. am uitat de ziua ei; m-a ajutat la mutare" value="${esc(b.why || '')}">
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="bdLock" checked> 🔒 Fixată de mine (AI-ul nu mai mișcă cifrele; momentele-cheie se notează în continuare)</label>
    <div class="btns">${b.lock ? '<button class="btn" id="bdAuto">↺ Lasă-le pe AI</button>' : ''}<button class="btn pri" id="bdGo">Salvează</button></div></div>`);
  const W = {bdT:['încă se ține în rezervă cu lucrurile personale', 'îți spune lucruri personale, dar nu chiar tot', 'are încredere în tine, îți spune și ce o frământă', 'încredere deplină; îți spune orice'],
    bdW:['politicoasă, încă puțin distantă', 'caldă și prietenoasă', 'foarte caldă, îi ești drag', 'atașament profund, îi e dor de tine când nu vorbiți'],
    bdX:['nicio supărare', 'o umbră mică de supărare', 'e supărată pe tine; se simte (mai scurtă, mai rece)', 'foarte supărată; are nevoie de o lămurire sau de scuze']};
  const sync = () => {
    for(const id of ['bdT', 'bdW', 'bdH', 'bdX']){ const v = +$('#' + id).value; $('#' + id + 'v').textContent = v;
      $('#' + id + 'w').textContent = id === 'bdH' ? gHelpHint(v) : id === 'bdX' ? W.bdX[v >= 70 ? 3 : v >= 45 ? 2 : v >= 20 ? 1 : 0] : bondWord(v, W[id]); }
  };
  for(const id of ['bdT', 'bdW', 'bdH', 'bdX']) $('#' + id).oninput = sync; sync();
  $('#bdGo').onclick = async () => {
    const nb = {trust:gClamp($('#bdT').value), warm:gClamp($('#bdW').value), tension:gClamp($('#bdX').value), help:gClamp($('#bdH').value),
      why:faraLiniute($('#bdWhy').value).replace(/[„”"]/g, '').trim().slice(0, 140), lock:$('#bdLock').checked, at:Date.now()};
    c.bond = {...(c.bond || {}), ...nb}; await saveChars(); closeSheet(); done && done(); toast('💞 Salvat' + (nb.lock ? ' și fixat 🔒' : ''));
  };
  if($('#bdAuto')) $('#bdAuto').onclick = async () => { c.bond.lock = false; await saveChars(); closeSheet(); done && done(); toast('↺ AI-ul le poate schimba din nou'); };
}
// (3) oamenii pe care îi cunoaște
const socNowOf = (a, b) => (S.socNow || {})[pairKey(a.id, b.id)] || null;
function cSocList(c){ return chars.filter(o => o.id !== c.id).sort((a, b) => (!!relBetween(c, b) - !!relBetween(c, a)) || ((b.lastAt || 0) - (a.lastAt || 0))).slice(0, 14); }
function cSocHTML(c){
  const L = cSocList(c); if(!L.length) return '<p class="hint" style="margin:0">Când mai ai și alte personaje, aici apare cum se cunosc între ele.</p>';
  return `<div class="csoc">${L.map(o => { const how = relBetween(c, o), nw = socNowOf(c, o);
    return `<button type="button" class="csocr" data-soc="${esc(o.id)}">${avatarHTML(o)}<span><b>${esc(o.name)}</b><small>${how ? esc(how) : '<i>setează cum se cunosc</i>'}${nw ? ` · <em style="color:${G_RELC[String(nw.s)]}">${esc(nw.t)}</em>` : ''}</small></span><i>›</i></button>`; }).join('')}</div>`;
}
function cSocEdit(c, o, done){
  const k = pairKey(c.id, o.id), how = relBetween(c, o), nw = socNowOf(c, o); let sc = nw ? nw.s : 0;
  openSheet(`<h4>${esc(c.name)} ↔ ${esc(o.name)}</h4><div class="pad">
    <label for="csHow">Cum se cunosc (și în grupuri)</label><input id="csHow" maxlength="80" placeholder="ex. prietene din liceu, surori, colege de birou" value="${esc(how)}">
    <label for="csT" style="margin-top:10px">Cum sunt acum</label><input id="csT" maxlength="50" placeholder="ex. rivale, se tachinează, cele mai bune prietene" value="${esc(nw ? nw.t : '')}">
    <label style="margin-top:10px">Cât de apropiate</label>
    <div class="seg grseg" id="csS">${[-2, -1, 0, 1, 2].map(v => `<button type="button" data-v="${v}" class="${v === sc ? 'on' : ''}" style="--sc:${G_RELC[String(v)]}">${G_RELN[String(v)]}</button>`).join('')}</div>
    <p class="hint">${esc(c.name)} vorbește despre ${esc(o.name)} după asta, iar într-un grup nou cu amândouă pornesc de aici.</p>
    <div class="btns">${how || nw ? '<button class="btn" id="csDel">Șterge legătura</button>' : ''}<button class="btn pri" id="csGo">Salvează</button></div></div>`);
  $('#csS').onclick = e => { const x = e.target.closest('[data-v]'); if(!x) return; sc = +x.dataset.v; $$('#csS button').forEach(y => y.classList.toggle('on', y === x)); };
  $('#csGo').onclick = async () => {
    const h = faraLiniute($('#csHow').value).replace(/[„”"]/g, '').trim().slice(0, 80), t = faraLiniute($('#csT').value).replace(/[.„”"]/g, '').trim().slice(0, 50);
    S.socRel = S.socRel || {}; S.socNow = S.socNow || {};
    if(h) S.socRel[k] = h; else delete S.socRel[k];
    if(t || sc) S.socNow[k] = {t:t || G_RELN[String(sc)].toLowerCase(), s:sc, at:Date.now()}; else delete S.socNow[k];
    saveSettings(); closeSheet(); done && done(); toast('👯 Salvat');
  };
  if($('#csDel')) $('#csDel').onclick = () => { if(S.socRel) delete S.socRel[k]; if(S.socNow) delete S.socNow[k]; saveSettings(); closeSheet(); done && done(); toast('Legătura e ștearsă'); };
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
  drawSheet(c, box);
}
// 9.83 (2) + (8): fișa de identitate și ce ai respins la poze
function drawSheet(c, box){
  if(!c.photo || (c.stil || 'photo') !== 'photo') return;
  const v = sheetOf(c), bv = bsheetOf(c), P = pfbGet(c), rej = PFB_KEYS.filter(k => P[k] >= .5).map(k => `${PFB_RO[k]} ×${Math.round(P[k] * 10) / 10}`);
  const busyMe = sheetBusy === c.id;
  box.insertAdjacentHTML('beforeend', `<div class="refbox" id="pfSheet"><b>🧩 Fișa de identitate</b><small>4 unghiuri ale aceleiași fețe, făcute o dată din poza de profil și verificate în telefon. La fiecare poză se folosesc cele potrivite scenei (profil, zâmbet, trei-sferturi). ${S.idSheet === 'off' ? 'Oprită din Setări → Poze.' : v.length ? '' : 'Se face singură după prima poză din chat (~4–8 imagini, o dată).'}</small>
    ${v.length ? `<div class="shgrid">${v.map(x => `<figure><img data-k="${esc(x.k)}" alt=""><figcaption>${esc(SHEET_RO[x.ang] || x.ang)}<br>${x.d != null ? '👤 ' + idPct(x.d) + '%' : '—'}</figcaption></figure>`).join('')}</div>` : ''}
    ${bv.length ? `<small style="margin-top:6px">🧍 Fișa de corp (din poza întreagă, verificată prin măsurare; se alege după poziția din scenă):</small><div class="shgrid">${bv.map(x => `<figure><img data-k="${esc(x.k)}" alt=""><figcaption>${esc(BSHEET_RO[x.pose] || x.pose)}<br>${x.bd != null ? '🧍 ' + bodyPct(x.bd) + '%' : '—'}</figcaption></figure>`).join('')}</div>` : c.photoFull && S.idSheet !== 'off' ? '<small style="margin-top:6px">🧍 Fișa de corp (¾, profil, așezată) se face singură după fișa feței.</small>' : ''}
    ${sheetOn(c) ? `<div class="btns"><button class="btn sm" id="pfSheetGo"${busyMe ? ' disabled' : ''}>${busyMe ? '<span class="spin"></span> Se face…' : v.length ? '↻ Refă fișa' : '🧩 Fă fișa acum'}</button></div>` : ''}
    ${rej.length ? `<small style="margin-top:8px">🎲 Ai respins la poze: ${esc(rej.join(', '))}. Pozele noi pun accent pe asta (scade singur în 2 săptămâni). <button class="btn sm" id="pfPfbX" type="button">Uită</button></small>` : ''}</div>`);
  const el = box.lastElementChild; hydrate(el);
  const go = el.querySelector('#pfSheetGo'); if(go) go.onclick = async () => {
    if(sheetBusy) return; go.disabled = true; go.innerHTML = '<span class="spin"></span> Se face…';
    let ok = false; try{ ok = await sheetGen(c, true, (a, n) => { go.innerHTML = `<span class="spin"></span> ${SHEET_RO[a]} (${n}/4)`; }); if(c.photoFull){ const okB = await bsheetGen(c, true, (a, n) => { go.innerHTML = `<span class="spin"></span> corp: ${BSHEET_RO[a]} (${n}/3)`; }); ok = ok || okB; } }catch(e){ toast(e.message, 3500); }
    toast(ok ? '🧩 Fișa de identitate e gata' : 'Fișa n-a ieșit cu aceeași față (sau plafonul zilnic e aproape atins). Încearcă mai târziu.', 3500);
    el.remove(); drawSheet(c, box); };
  const x = el.querySelector('#pfPfbX'); if(x) x.onclick = async () => { delete c.pfb; await saveChars(); el.remove(); drawSheet(c, box); };
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
    <small style="margin-top:6px">${c.physAuto && c.physUser ? '🧍 Completat din creator (corpul exact ca la creare). ' : ''}Dacă ceva nu iese cum trebuie (siluetă, înălțime, piele, păr, semne), scrie aici în română. Are prioritate față de ce citește aplicația.</small>
    <textarea id="pfBody2" rows="4" maxlength="700" placeholder="ex. 1,58 m, siluetă plinuță cu șolduri late, piele bronzată, păr negru drept până la mijlocul spatelui, aluniță pe obrazul stâng">${esc(c.physUser || '')}</textarea>
    <div class="btns"><button class="btn sm pri" id="pfBodySave">Salvează</button>${c.photo ? '<button class="btn sm" id="pfBodyRe">↻ Recitește poza</button>' : ''}${c.appPrompt || c.appZones || c.appEn ? '<button class="btn sm" id="pfBodyCr">🧍 Din creator</button>' : ''}</div></div>`);
  // 9.32: reface textul din ce ai ales la creare (dacă l-ai scris tu între timp, îl înlocuiește doar la cererea ta)
  if($('#pfBodyCr')) $('#pfBodyCr').onclick = async () => {
    const b = $('#pfBodyCr'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    c.physAuto = true; delete c.physRoV;
    if(crApplyPhys(c)){ if(crRoThin(c.physUser)) await Promise.race([crPhysRo(c), sleep(15000)]); await saveChars(); $('#pfBody2').value = c.physUser || ''; toast('✓ Completat din creator'); }
    else toast('N-am găsit descrierea din creator.', 3000);
    b.disabled = false; b.textContent = '🧍 Din creator';
  };
  $('#pfBodySave').onclick = async () => {
    const t = $('#pfBody2').value.trim(), b = $('#pfBodySave'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try{
      c.physUser = t; c.physEn = ''; c.physAuto = false;   // 9.30: scris de tine: nu mai e suprascris din creator
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
  drawBodyNote(c, box); drawPeople(c, box);   // 9.43
  drawRefs(c, box);
  drawHome(c, box);
  if(c.photo && S.imgProv === 'worker'){
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
  const on = $('#avOn'); if(on) on.onclick = async () => { c.avLive = !c.avLive; await saveChars(); avRefresh(c); toast(c.avLive ? '🖼️ Avatarul viu e pornit' : 'Avatarul viu e oprit'); };
  const g = $('#avGen'); if(g) g.onclick = () => genAvatars(c);
}
async function genAvatars(c){
  if(busy){ toast('Așteaptă să termine răspunsul.'); return; }
  const b = $('#avGen'); if(b){ b.disabled = true; b.innerHTML = '<span class="spin"></span> 0/6'; }
  const photo = c.photo; if(!photo || !(await DB.get(photo))){ toast('Nu găsesc poza de profil.'); if(b){ b.disabled = false; b.textContent = '✨ Generează cele 6 variante'; } return; }
  // 9.30: avatarele trec prin același motor ca pozele din chat (scenePhoto: fața decupată + poza de profil + unghiurile + fișa
  //       „Cum arată, pentru poze”, poză de telefon reală, fără înfrumusețare); fiecare e măsurată în telefon față de personaj
  //       și se păstrează cea mai apropiată din cel mult 3 încercări (se oprește la prima sub 0,42)
  const avs = {...(c.avs || {})}; let ok = 0; const rw0 = rwDay().usd;
  for(const [k, , desc] of AV_V){
    if(c.photo !== photo) break;
    try{
      const shot = `close-up selfie, head and shoulders, the face large and sharp, ${desc}, natural real moment, looking at the camera`;
      let bl = null, bd = 9;
      for(let t = 0; t < 3; t++){
        const r = await scenePhoto(c, shot, null, t ? 'keep exactly the face of the reference: same face shape, eyes, nose, lips, skin and age' : '', {why:'profil'});
        addUsage(c.id, imgPrice(), 'img', null, 'profil');
        const d = (await localFace(r.blob, c)).d;
        if(d == null){ if(!bl){ bl = r.blob; } break; }
        if(d < bd){ bl = r.blob; bd = d; }
        if(d < .42) break;
      }
      try{ if(bl.type === 'image/png') bl = await toJpeg(bl, 1024, .9); }catch(e){}
      const old = avs[k]; avs[k] = await saveImg(bl); if(old) delImg(old).catch(() => {});
      ok++;
      c.avs = {...avs}; await saveChars();
      if(b && document.body.contains(b)) b.innerHTML = `<span class="spin"></span> ${ok}/6`;
    }catch(e){ toast('O variantă n-a mers: ' + e.message, 3500); if(e.cap) break; }
  }
  const spent = rwDay().usd - rw0;   // 9.37
  if(ok){ c.avLive = true; await saveChars(); toast(`🖼️ ${ok} variante gata. Avatarul viu e pornit.${spent > 0 ? ' Cost Runware: ' + usd4(spent) + '.' : ''}`, 4500); }
  avRefresh(c);
}
// 9.26: după avatarele vii (sau pornit/oprit): profilul întreg, Acasă și antetul chatului arată imediat poza de acum
function avRefresh(c){
  if(profId === c.id && !$('#vProf').hidden) charProfile(c.id, false); else if(profId === c.id) drawAv(c);
  if(!$('#vHome').hidden) renderHome();
  if(cur === c && $('#chAv')){ $('#chAv').outerHTML = avatarHTML(cur, 'av" id="chAv'); const bg = $('#chatBg'); if(bg && cur.photo && ['clar', 'poza'].includes(cur.bg || 'clar')) bg.dataset.bgk = photoNow(cur); hydrate(document); }
}

/* ───────── 🗂️ carduri de personaj ───────── */
const CARD_FIELDS = ['city', 'name', 'tag', 'aspect', 'look', 'stil', 'persona', 'speech', 'greet', 'accent', 'bg', 'aiPortrait', 'voice', 'vPitch', 'life', 'lifeOff', 'avLive', 'sendPics', 'home', 'appPrompt', 'appEn', 'frame', 'fullBox', 'appZones'];
async function exportCard(c){
  toast('Pregătesc cardul…');
  const out = {app:'taifas-card', v:1, date:new Date().toISOString(), char:{}};
  for(const k of CARD_FIELDS) if(c[k] !== undefined) out.char[k] = c[k];
  const b = c.photo ? await DB.get(c.photo) : null; if(b) out.photo = {data:await blobToB64(b), type:b.type};
  const bf = c.photoFull ? await DB.get(c.photoFull) : null; if(bf) out.full = {data:await blobToB64(bf), type:bf.type};   // 9.24
  if(c.avs){ out.avs = {}; for(const [k, key] of Object.entries(c.avs)){ const x = await DB.get(key); if(x) out.avs[k] = {data:await blobToB64(x), type:x.type}; } }
  const name = (c.name || 'personaj').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'personaj';
  const file = new File([JSON.stringify(out)], `${name}.taifas.json`, {type:'application/json'});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:c.name}); return; }catch(e){ if(e.name === 'AbortError') return; } }
  download(file, file.name);
}
// 8.20: un card venit de la altcineva e tratat ca date străine: doar tipurile așteptate, cu lungimi limitate
const CARD_TXT = {name:60, tag:160, city:80, aspect:3000, look:1200, persona:6000, speech:600, greet:1500, stil:20, bg:20, appPrompt:2500, appEn:3000, frame:10};
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
    if(j.full && /^image\/(jpeg|png|webp)$/.test(j.full.type) && typeof j.full.data === 'string' && j.full.data.length < 12e6) c.photoFull = await saveImg(b64ToBlob(j.full.data, j.full.type));   // 9.24
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
  if(c.photoFull){ const b = await DB.get(c.photoFull); if(b) n.photoFull = await saveImg(b); }   // 9.24
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
    // 9.31: cea mai naturală (local, fără cost) e marcată; dacă închizi fără să alegi, rămâne ea
    const sc = outs.map(humanScore), top = Math.max(...sc), best = sc.filter(x => x === top).length === 1 ? sc.indexOf(top) : 0, mark = sc.filter(x => x === top).length === 1;
    openSheet(`<h4>🎰 Alege varianta care-ți place</h4><div class="vpicks">${outs.map((t, k) => `<button class="vpk${mark && k === best ? ' vhum' : ''}" data-vk="${k}"><div class="vh">VARIANTA ${k + 1}${mark && k === best ? '<em>🧑 cea mai naturală</em>' : ''}<span>Alege ›</span></div>${show(t)}</button>`).join('')}</div>`);
    let done = false;
    const fin = k => { if(done) return; done = true; obs.disconnect(); closeSheet(); res(k); };
    $$('.sheet [data-vk]').forEach(b => b.onclick = () => fin(+b.dataset.vk));
    // meniul închis din afară (atingere pe fundal sau Înapoi): rămâne prima variantă
    const obs = new MutationObserver(() => { if(!$('.sheet [data-vk]')) fin(best); });
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
// 9.13: locul pozei, rezervat dinainte la dimensiunea ei, cu o versiune mică estompată până vine poza
function picAttr(k, own){
  const mt = imeta[k]; if(!mt) return ' data-t="m"';
  const st = [mt.lq ? `background-image:url(${mt.lq});background-size:cover` : '', own && mt.w && mt.h ? `aspect-ratio:${mt.w}/${mt.h}` : ''].filter(Boolean).join(';');
  return ' data-t="m"' + (st ? ` style="${st}"` : '');
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
    inner = `<div class="picbox${fresh ? ' flash' : ''}"><img class="pic big${fresh ? ' dev' : ''}" data-k="${esc(m.img)}"${picAttr(m.img, false)} data-view="${esc(m.img)}" alt="">${loc ? `<span class="ploc">📍 ${esc(loc)}</span>` : ''}${tm}${reactHTML(m)}</div>${m.bodyWarn != null ? `<div class="bwarn">⚠️ corpul seamănă ${m.bodyWarn}% cu poza întreagă · 🎲 Altă poză → „Corpul nu seamănă”</div>` : ''}${m.text ? `<div class="bub">${fmtMsg(m.text)}</div>` : ''}`;   // 9.85 (6)
    if(fresh) devDone.add(m.img);
  }
  else if(m.img) inner = `<div class="bub picwrap">${quoteHTML(m)}<img class="pic" data-k="${esc(m.img)}"${picAttr(m.img, true)} data-view="${esc(m.img)}" alt="">${m.text ? `<div class="cap">${fmtMsg(m.text)}</div>` : ''}${tm}${reactHTML(m)}</div>`;
  else if(m.voice && !m.pending) inner = `<div class="bub">${voiceHTML(m)}${tm}${reactHTML(m)}</div>`;
  else if(m.sticker) inner = `<div class="stk"><img data-k="${esc(m.sticker.k)}" data-view="${esc(m.sticker.k)}" alt="${esc(m.sticker.l)}">${tm}${reactHTML(m)}</div>`;
  else if(m.gift) inner = `<div class="bub gift"><span class="ge">${esc(m.gift.e)}</span><span class="gn">🎁 ${esc(m.gift.n)}</span>${m.text ? `<span class="gt">${esc(m.text)}</span>` : ''}${tm}${reactHTML(m)}</div>`;
  else inner = `<div class="bub${m.pending ? ' typing' : ''}${!m.pending && !m.reply && isJumbo(m.text) ? ' jumbo' : ''}${!me && duoOn(cur) ? ' duob' : ''}">${quoteHTML(m)}${!me && duoOn(cur) ? duoHTML(cur, m.pending ? typedText(m) : m.text) : fmtMsg(m.pending ? typedText(m) : m.text)}${m.pending ? '' : tm}${reactHTML(m)}</div>`;   // 9.63
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
      ${m.img && !m.err ? `<button data-pedit>✏️ Modifică</button><button data-rephoto>🎲 Altă poză</button>` : ''}
      ${m.img || !m.alts ? '' : `<button data-regen${m.eco ? ' title="Răspunsul ăsta a fost scris de modelul economic; ↻ îl reface cu modelul principal"' : ''}>${m.eco ? '↻ ⚡→🧠' : '↻ Altul'}</button>${S.regen3 === 'on' && n > 1 && !m.err ? '<button data-more3>🎰 +2</button>' : ''}`}
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
const stripReact = t => String(t || '').replace(/\[re:\s*[^\]\n]{1,160}\]\s*/gi, '').replace(AI_REACT, '').replace(AI_VOICE, '').replace(AI_REACT, '');
const reactHTML = m => m.react ? `<span class="react">${m.react}</span>` : '';
function quoteHTML(m){
  if(!m.reply) return '';
  return `<button class="quote${m.reply.img ? ' qimg' : ''}" data-q="${esc(m.reply.id)}">${m.reply.img ? `<img data-k="${esc(m.reply.img)}" data-t="s" alt="">` : ''}<b>${esc(m.reply.name)}</b><span>${esc(m.reply.text)}</span></button>`;
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
    m.react = m.react === b.dataset.e ? '' : b.dataset.e; m.reactAt = Date.now();
    if(!m.react) delete m.react;
    closeReactPicker(); await saveChat(); renderMsgs();
    if(['❤️', '🥰', '🔥'].includes(m.react)) fxBurst(m.react, 10);
    if(navigator.vibrate) try{ navigator.vibrate(8); }catch(_){}
  };
}
function closeReactPicker(){ $$('.rpick,.rscrim').forEach(x => x.remove()); }
let replyTo = null;
function setReply(i, quiet){
  const m = chat.msgs[i]; if(!m || m.pending || m.pendingImg || m.err) return;
  const name = m.role === 'user' ? (S.userName.trim() || 'Tu') : cur.name;
  replyTo = {id:m.id, name, text: (m.img && !m.text ? '📷 Poză' : plain(m.text)).slice(0, 140)};
  $('#rbName').textContent = '↩ Răspunzi ' + (m.role === 'user' ? 'la mesajul tău' : 'lui ' + name);
  $('#rbTxt').textContent = replyTo.text;
  $('#replyBar').hidden = false;
  $('#inp').focus();
  if(!quiet && navigator.vibrate) try{ navigator.vibrate(8); }catch(_){}   // la glisare a vibrat deja la prag
}
function clearReply(){ replyTo = null; $('#replyBar').hidden = true; }
// dispoziția: personajul o scrie la finalul răspunsului ca [stare: …]; o păstrăm pe conversație și o ascundem din text
const MOOD_RE = /\s*\[stare:\s*([^\]\n]{1,40})\]/gi;
const PLOT_RE = /\s*\[acum:\s*([^\]\n]{3,200})\]/gi;
const VERD_RE = /\s*\[r[ăa]spuns:\s*(da|poate|nu)\s*\]/gi;   // 7.9: răspunsul la „📣 Întreabă-le pe toate”   // 7.6: scena în desfășurare, scrisă de personaj
const SCHED_RE = /\s*\[programez:\s*([^\]\n]{3,160})\]/gi;
const SUN_RE = /\s*\[sun(?::\s*(video|voce|vocal|telefon))?\s*\]/gi;   // 8.18: „te sun acum” → chiar te sună
const STK_RE = /\s*\[sticker:\s*([^\]\n]{2,40})\]/gi;
const SHOW_RE = /\s*\[ar[ăa]t:\s*(\d{1,2})\s*\]/gi;   // 9.23: în apelul video îți arată o poză din telefonul ei
const SHOT_RE = /\s*\[poz[ăa]:\s*([^\]]{8,2000})\]/gi;
const SHOT_OPEN = /\s*\[poz[ăa]:[^\]]*$/i;   // etichetă începută, încă neînchisă (în timpul scrierii) sau tăiată
const CORR_RE_S = /\s*\[corectur[ăa]:\s*[^\]\n]{3,300}\]/gi;
const stripMood = t => String(t || '').replace(/\s*\[fa[țt][ăa]:\s*[^\]\n]{1,20}\]\s*/gi, ' ').replace(MOOD_RE, '').replace(PLOT_RE, '').replace(VERD_RE, '').replace(/\s*\[acum:[^\]]*$/i, '').replace(SCHED_RE, '').replace(SUN_RE, '').replace(/\s*\[sun(:[^\]\n]*)?$/i, '').replace(SHOT_RE, '').replace(SHOT_OPEN, '').replace(STK_RE, '').replace(SHOW_RE, '').replace(/\s*\[ar([ăa](t(:[^\]\n]*)?)?)?$/i, '')
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
let msgStart = 0, msgFor = null, moreObs = null, moreBusy = false, msgLight = false;   // 9.15: msgLight = faza ușoară de la deschidere
function resetMsgWin(){ msgFor = chat; msgStart = Math.max(0, (chat ? chat.msgs.length : 0) - MSG_WIN); }
function loadEarlier(){
  if(moreBusy || msgLight || !chat || msgStart <= 0) return;
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
/* ───────── vocea personajelor: vocea telefonului (9.19: doar Anthropic + Cloudflare + Runware, fără servicii de voce plătite)
   mesajele vocale înregistrate înainte (aud:<id>:<alt>, ElevenLabs/fal) rămân în IndexedDB și se redau în continuare */
// etichetele din text: scrise în română de personaj, traduse pentru modelul de voce
const VTAGS = {'râde':'laughs', 'rade':'laughs', 'chicotește':'giggles', 'chicoteste':'giggles', 'oftează':'sighs', 'ofteaza':'sighs', 'șoptește':'whispers', 'soptește':'whispers', 'soapta':'whispers'};
const VTAG_RE = /\[([^\]\n]{2,24})\]/g;
function ttsText(t, neural){
  return String(t || '').replace(/\*[^*]*\*/g, ' ').replace(VTAG_RE, (all, w) => { const k = VTAGS[w.trim().toLowerCase()]; return neural && k ? ' [' + k + '] ' : ' '; })
    // 9.69: tot ce nu se rostește: emoji (și selectorii de variantă, ZWJ, steaguri, săgeți), adrese, markdown
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
    .replace(/[#_~`|<>^]+/g, ' ')
    // 9.69: „Daaaa”, „Nuuu”, „hmmm” nu mai sunt silabisite; „!!!” → „!”
    .replace(/(\p{L})\1{2,}/gu, '$1$1').replace(/([!?])[!?]*(?:[!?])/g, (m) => m.includes('?') && m.includes('!') ? '?!' : m[0])
    .replace(/\s+([,.!?…])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}
const vtagHTML = t => esc(t).replace(VTAG_RE, (all, w) => VTAGS[w.trim().toLowerCase()] ? `<span class="vtag">(${esc(w.trim())})</span>` : all);
function voiceLabel(c){ return (c.vName ? '🗣️ ' + c.vName : 'Vocea telefonului') + (c.vPitch && c.vPitch !== 1 ? (c.vPitch < 1 ? ' · mai gravă' : ' · mai subțire') : ''); }
const ttsKey = m => 'aud:' + m.id + ':' + (m.alt || 0);

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
function stopAllVoice(){ try{ ttsCancel(); }catch(e){} if(vAudio){ vAudio.pause(); vAudio = null; } if(vPlaying && vPlaying._stop) vPlaying._stop(); vPlaying = null; }
/* ───────── 9.69: vocile, reparate ─────────
   (1) Lista de voci: pe Android / Chrome `getVoices()` e goală la pornire și se umple abia după `voiceschanged`; până acum, primul apel
       după pornire ignora vocea aleasă pe personaj (`c.vName`) și foaia 🎙️ spunea că „telefonul nu are voce”. Acum lista se ține minte
       (`VOX.list`), se reîncarcă la `voiceschanged` și se cere de câteva ori la pornire (`voxLoad`, `voxWait`).
   (2) Vocea după gen (`voxGender`, `voxScore`): automat, un personaj masculin primește o voce de bărbat dacă telefonul are una (Emil, Andrei…),
       iar unul feminin o voce de femeie; înainte, toți primeau prima voce „naturală” din listă (de obicei de femeie) și doar tonul se schimba.
       Tonul de bază (`voxBase`) ține cont de vocea primită: voce potrivită = ton natural; voce de alt gen = ton mutat mai mult.
   (3) Redare sigură (`ttsPlay`): replicile rămân ținute în memorie (Chrome putea șterge replica înainte de `onend`, iar apelul rămânea
       blocat pe „vorbește”); o replică ce nu pornește sau nu se termină e încheiată de un ceas de siguranță; dacă vocea aleasă dă eroare,
       replica se reia o dată cu vocea implicită a limbii; pe calculator, vocile de rețea primesc pauză/reluare la 10 s (Chrome le tăia la ~15 s).
   (4) Textul rostit (`ttsText`): fără emoji rămase (selectoare de variantă, ZWJ, steaguri), fără markdown și adrese; „Daaaa” / „hmmm”
       nu mai sunt silabisite, „!!!” devine „!”. */
const VOX = {list:[], t:0};
function voxAll(){
  let l = []; try{ l = window.speechSynthesis ? speechSynthesis.getVoices() || [] : []; }catch(e){}
  if(l.length) VOX.list = l;
  return l.length ? l : VOX.list;
}
function voxLoad(){
  if(!window.speechSynthesis) return;
  try{ speechSynthesis.addEventListener ? speechSynthesis.addEventListener('voiceschanged', voxAll) : (speechSynthesis.onvoiceschanged = voxAll); }catch(e){}
  let n = 0; const tick = () => { voxAll(); if(VOX.list.length || ++n > 20) return; VOX.t = setTimeout(tick, 250); }; tick();
}
const voxWait = (ms = 1500) => new Promise(res => { const t0 = Date.now(); const go = () => { if(voxAll().length || Date.now() - t0 > ms) return res(VOX.list); setTimeout(go, 120); }; go(); });
const voxLang = v => String(v && v.lang || '').replace('_', '-').toLowerCase();
const phoneVoices = lang => voxAll().filter(x => x && x.lang && voxLang(x).slice(0, 2) === String(lang || 'ro-RO').slice(0, 2).toLowerCase());
// genul vocii, după nume (Microsoft, Apple, Google, Samsung); '' = nu știm
const VOX_F = new Set('female femeie femeiesc feminin woman alina ioana carmen elena andreea laura sara sarah zira aria jenny michelle ana anna samantha karen moira tessa victoria susan hazel libby sonia emma ava allison serena kate fiona veena helena elvira dalia monica mónica paulina paloma lucia lucía marisol hortense julie denise amelie amélie audrey aurelie aurélie celine céline elsa isabella alice federica paola hedda katja petra anna marlene amala seraphina vicki joanna salli kimberly kendra ivy ruth sfg tpf tpc iob fis gba gbc gbg vfv'.split(' '));
const VOX_M = new Set('male barbat bărbat masculin man emil andrei mihai ionut ion bogdan radu david mark guy ryan christopher eric daniel alex fred thomas aaron arthur oliver george james liam brian roger steffan tony davis jason pablo alvaro álvaro jorge diego raul raúl juan carlos enrique paul henri claude yannick antoine cosimo luca giuseppe benigno stefan conrad markus killian hans matthew joey justin kevin rjs gbd iol iom iog tpd'.split(' '));
function voxGender(v){
  const w = String(v && v.name || '').toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if(w.some(x => VOX_F.has(x))) return 'f';
  if(w.some(x => VOX_M.has(x))) return 'm';
  return '';
}
function voxScore(v, g, lang, avoid){
  let s = 0; const vg = voxGender(v), n = String(v.name || '');
  if(g && vg === g) s += 40; else if(g && vg && vg !== g) s -= 30;
  if(/natural|neural|enhanced|premium|wavenet|studio/i.test(n)) s += 20; else if(/online/i.test(n)) s += 12;
  if(v.localService === false) s += 6;
  if(/google/i.test(n)) s += 4;
  if(voxLang(v) === String(lang || '').toLowerCase()) s += 3;
  if(v.default) s += 1;
  if(avoid && n === avoid) s -= 60;
  return s;
}
// genul personajului: din „Cum arată” (engleză și română), apoi din descriere; numără indiciile (nu primul cuvânt găsit: „domnișoară” nu mai e „domn”)
const G_F = /(?<!\p{L})(woman|women|girl|female|lady|she|her|femeie|fată|fata|tânără|tanara|doamnă|doamna|domnișoară|domnisoara|soție|sotie|iubită|iubita|studentă|studenta|blondă|bruneta|brunetă|roșcată|roscata|ea)(?!\p{L})/giu;
const G_M = /(?<!\p{L})(man|men|boy|male|guy|he|his|him|bărbat|barbat|băiat|baiat|domn|tânăr|tanar|soț|sot|iubit|student|blond|brunet|roșcat|roscat|el)(?!\p{L})/giu;
function genderOfText(t){
  t = String(t || '').toLowerCase(); if(!t.trim()) return '';
  const f = (t.match(G_F) || []).length, m = (t.match(G_M) || []).length;
  return f > m ? 'f' : m > f ? 'm' : '';
}
function genderOf(c){
  if(!c) return '';
  if(c.gender === 'f' || c.gender === 'm') return c.gender;
  return genderOfText((c.look || '') + ' ' + (c.aspect || '')) || genderOfText(String(c.persona || '').slice(0, 400)) || '';
}
function phoneVoice(lang = 'ro-RO', c, who){
  const vs = phoneVoices(lang); if(!vs.length) return null;
  if(c && !who && c.vName){ const v = vs.find(x => x.name === c.vName); if(v) return v; }
  const g = c ? (who ? genderOfText((c.duo && c.duo.b && c.duo.b.aspect || '') + ' ' + (c.duo && c.duo.b && c.duo.b.persona || '')) || genderOf(c) : genderOf(c)) : '';
  const avoid = who && c ? (phoneVoice(lang, c) || {}).name : '';
  return [...vs].sort((a, b) => voxScore(b, g, lang, avoid) - voxScore(a, g, lang, avoid))[0] || null;
}
// tonul de bază: vocea potrivită genului = natural; vocea de alt gen (singura din telefon) = mutat mai mult; vocea necunoscută = ca înainte
function voxBase(c, v, who){
  if(c && c.vPitch && !who) return c.vPitch;
  const g = c ? (who ? genderOfText((c.duo && c.duo.b && c.duo.b.aspect || '') + ' ' + (c.duo && c.duo.b && c.duo.b.persona || '')) || genderOf(c) : genderOf(c)) : '', vg = voxGender(v);
  if(!g) return 1;
  if(vg === g) return 1;
  if(vg) return g === 'm' ? .8 : 1.2;
  return g === 'm' ? .9 : 1.06;
}
// redare sigură: replicile rămân ținute, ceas de siguranță, reluare fără voce la eroare, pauză/reluare pentru vocile de rețea pe calculator
const TTS_KEEP = new Set(); let ttsAct = 0, ttsDog = 0, ttsKA = 0;
const IS_ANDROID = /android/i.test(navigator.userAgent || '');
const ttsEst = u => Math.max(1500, String(u.text || '').length / (11 * (u.rate || 1)) * 1000);
function ttsFinish(u, ev){
  if(u._fin) return; u._fin = true; TTS_KEEP.delete(u); ttsAct = performance.now();
  try{ u._end && u._end.call(u, ev || {type:'end', utterance:u}); }catch(e){ console.warn(e); }
}
function ttsWatch(){
  if(ttsDog) return;
  ttsDog = setInterval(() => {
    if(!TTS_KEEP.size){ clearInterval(ttsDog); ttsDog = 0; clearInterval(ttsKA); ttsKA = 0; return; }
    const now = performance.now(), head = [...TTS_KEEP][0];
    if(head._st){
      if(now - head._st > ttsEst(head) * 2.4 + 5000){ console.warn('tts: replica nu s-a terminat, o închid', head.text); ttsFinish(head, {type:'forced', utterance:head}); let sp = false; try{ sp = speechSynthesis.speaking; }catch(e){} if(sp) ttsCancel(); }   // motorul a rămas agățat: îl eliberăm (restul replicii se pierde, dar apelul merge mai departe)
    } else if(now - Math.max(head._q || 0, ttsAct) > 7000){
      let sp = false; try{ sp = speechSynthesis.speaking; }catch(e){}
      if(sp && now - Math.max(head._q || 0, ttsAct) < 25000) return;          // altă voce încă vorbește; dacă motorul stă agățat peste 25 s, îl eliberăm
      if(sp){ console.warn('tts: motorul de voce stă agățat, îl repornesc'); ttsCancel(); return; }
      if(!head._retry && head.voice){ ttsRetry(head); return; }
      console.warn('tts: replica n-a pornit, o închid', head.text); ttsFinish(head, {type:'error', error:'stalled', utterance:head});
    }
  }, 500);
}
function ttsRetry(u){
  // aceeași replică, fără vocea aleasă: motorul alege vocea implicită a limbii
  u._retry = true; TTS_KEEP.delete(u);
  const u2 = new SpeechSynthesisUtterance(u.text); u2.lang = u.lang; u2.pitch = u.pitch; u2.rate = u.rate; u2.volume = u.volume;
  u2.onboundary = u.onboundary; u2._st0 = u._st0; u2._end = (ev) => ttsFinish(u, ev); u2._retry = true;
  u2._start = u._start; u2._fin = false; ttsWire(u2, u);
  try{ speechSynthesis.speak(u2); }catch(e){ ttsFinish(u, {type:'error', error:'speak'}); }
}
function ttsWire(u, orig){
  const o = orig || u; u._q = performance.now(); TTS_KEEP.add(u);
  u.onstart = ev => { u._st = performance.now(); ttsAct = u._st; if(!o._started){ o._started = true; try{ o._start && o._start.call(o, ev); }catch(e){ console.warn(e); } } ttsKeepAlive(u); };
  const ob = u.onboundary; if(ob && !ob._w){ const w = ev => { ttsAct = performance.now(); ob.call(u, ev); }; w._w = 1; u.onboundary = w; }
  u.onend = ev => { if(u !== o){ TTS_KEEP.delete(u); } ttsFinish(o, ev || {type:'end', utterance:o}); };
  u.onerror = ev => {
    const er = ev && ev.error;
    if(!u._retry && u.voice && /voice-unavailable|language-unavailable|synthesis-failed|synthesis-unavailable|audio-busy|audio-hardware/.test(er || '')){ ttsRetry(u); return; }
    if(u !== o) TTS_KEEP.delete(u);
    ttsFinish(o, {type:'error', error:er || 'error', utterance:o});
  };
}
function ttsKeepAlive(u){
  // Chrome pe calculator tăia vocile de rețea după ~15 s fără să anunțe sfârșitul; pe Android pause() ar opri tot, deci acolo nu
  if(IS_ANDROID || ttsKA || !u.voice || u.voice.localService !== false) return;
  ttsKA = setInterval(() => { try{ if(!speechSynthesis.speaking){ clearInterval(ttsKA); ttsKA = 0; return; } speechSynthesis.pause(); speechSynthesis.resume(); }catch(e){} }, 10000);
}
// oprește tot: replicile din coadă se încheie acum (ca în browser), apoi motorul de voce
function ttsCancel(){
  const all = [...TTS_KEEP]; TTS_KEEP.clear();
  all.forEach(u => ttsFinish(u, {type:'error', error:'interrupted', utterance:u}));
  try{ window.speechSynthesis && speechSynthesis.cancel(); }catch(e){}
}
function ttsPlay(u){
  // păstrează handlerele puse de cel care cheamă, apoi le învelește
  u._start = u.onstart; u._end = u.onend || u.onerror; ttsWire(u);
  try{ if(speechSynthesis.paused) speechSynthesis.resume(); }catch(e){}
  try{ speechSynthesis.speak(u); }catch(e){ ttsFinish(u, {type:'error', error:'speak'}); }
  ttsWatch();
  return u;
}
function speakPhone(c, text, onEnd){
  if(!('speechSynthesis' in window)){ toast('Telefonul nu are voce pentru citire.'); onEnd && onEnd(); return null; }
  ttsCancel();
  // propoziție cu propoziție: pauzele dintre ele sună mai omenește decât un singur bloc
  // 9.63: două personaje: fără „Nume:”, iar a doua vorbește cu alt ton și puțin altă viteză
  // 9.69: a doua primește, dacă telefonul are, altă voce (după genul ei); fiecare cu tonul de bază potrivit vocii
  const segs = duoOn(c) ? duoSplit(c, text).map(x => ({k:x.k, t:ttsText(x.t, false)})) : [{k:0, t:ttsText(text, false)}];
  const parts = segs.flatMap(sg => (sg.t.match(/[^.!?…]+[.!?…]*/g) || []).filter(p => p.trim()).flatMap(p => ttsSplitLong(p).map(x => ({p:x, k:sg.k}))));
  const lang = langOf(c), V = [phoneVoice(lang, c), duoOn(c) ? phoneVoice(lang, c, 1) : null];
  const same2 = !V[1] || (V[0] && V[1].name === V[0].name), B = [voxBase(c, V[0]), duoOn(c) && !same2 ? voxBase(c, V[1], 1) : voxBase(c, V[0])];   // aceeași voce: același ton de bază, a doua mai jos (×0,84)
  let off = 0, full = segs.map(x => x.t).join(' ');
  parts.forEach(({p, k:who}, k) => {
    const v = V[who] || V[0], sameV = who && same2;
    const u = new SpeechSynthesisUtterance(p.trim()); u.lang = lang; if(v) u.voice = v;
    const at = full.indexOf(p.trim(), off); const base0 = at >= 0 ? at : off; off = base0 + p.trim().length;
    u.pitch = Math.min(2, Math.max(.1, B[who] * (sameV ? .84 : 1) * (1 + (k % 2 ? .02 : -.02)))); u.rate = (/\?\s*$/.test(p) ? 1.02 : .97) * (who ? 1.06 : 1);
    u.onboundary = e => { if(window.__talk) window.__talk(e, base0); };
    if(k === parts.length - 1){ u.onend = u.onerror = () => onEnd && onEnd(); }
    ttsPlay(u);
  });
  if(!parts.length) onEnd && onEnd();
}
// o bucată prea lungă (fără virgulă) se taie la un spațiu, ca să nu treacă de ~15 s într-o singură replică
function ttsSplitLong(p, max = 170){
  const out = []; let s = String(p);
  while(s.length > max){ let cut = s.lastIndexOf(', ', max); if(cut < max * .4) cut = s.lastIndexOf(' ', max); if(cut < max * .4) cut = max; out.push(s.slice(0, cut + 1)); s = s.slice(cut + 1); }
  if(s.trim()) out.push(s);
  return out;
}
// 9.70: înainte să vorbească: niciun microfon deschis, iar pe Android o pauză scurtă după ultimul (sunetul revine din „modul apel”)
let ttsGateP = null, ttsGateAt = 0;
function ttsGate(){
  if(!IS_ANDROID || typeof REC === 'undefined') return Promise.resolve();
  const now = performance.now(), need = REC.on ? now + 700 : Math.max(now, REC.endAt + 450);
  if(need <= now + 5) return Promise.resolve();
  if(ttsGateP && ttsGateAt >= need) return ttsGateP;
  ttsGateAt = need;
  return ttsGateP = new Promise(res => setTimeout(res, need - now));
}
voxLoad();   // 9.69: lista de voci se încarcă de la pornire (pe Android vine abia după câteva sute de ms)
// înregistrarea păstrată (din versiunile cu voce umană), dacă există
const audioFor = m => DB.get(ttsKey(m)).catch(() => null);
async function playVoice(m, el){
  const bars = [...el.querySelectorAll('.wave i')], btn = el.querySelector('.vplay'), dl = el.querySelector('.dur');
  if(vPlaying === el){ stopAllVoice(); return; }
  stopAllVoice();
  const meta = m.vmeta && m.vmeta[m.alt || 0]; let total = meta ? meta.d : voiceDur(m.text);
  const stopUI = () => { bars.forEach(b => b.classList.remove('on')); btn.textContent = '▶'; clearInterval(el._t); dl.textContent = fmtDur(total); if(vPlaying === el) vPlaying = null; };
  vPlaying = el; el._stop = stopUI;
  const prog = f => { const k = Math.min(bars.length, Math.round(f * bars.length)); bars.forEach((b, i) => b.classList.toggle('on', i < k)); };
  {
    const blob = await audioFor(m);
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
// 🔊 pe un mesaj scris: înregistrarea păstrată, dacă există, altfel vocea telefonului
async function say(t, m){
  stopAllVoice();
  const b = m && cur ? await audioFor(m) : null;
  if(b){ try{ const a = vAudio = new Audio(URL.createObjectURL(b)); a.onended = () => URL.revokeObjectURL(a.src); await a.play(); return; }catch(e){} }
  speakPhone(cur, t);
}
const SAMPLE = c => `Bună! Sunt ${c.name}. [râde] Deci... așa sună vocea mea. Îți place?`;
function voiceSample(c){ stopAllVoice(); speakPhone(c, SAMPLE(c)); }
function pickVoice(c, done){
  // 9.69: dacă lista de voci nu s-a încărcat încă (Android, imediat după pornire), o așteptăm puțin în loc să spunem că nu există
  if(!phoneVoices(langOf(c)).length && !pickVoice._w){ pickVoice._w = 1; voxWait(2000).then(() => { pickVoice._w = 0; const open = $('.sheet [data-vauto]'); if(open && open.dataset.vc === String(c.id) && phoneVoices(langOf(c)).length){ closeSheet(); pickVoice(c, done); } }); }
  // 9.62: întâi ce voce (cele din telefon pentru limba ei, cu ▶ ascultare), apoi tonul
  // 9.69: vocile potrivite genului ei sus, cu ♀/♂ unde se știe; „Alege automat” spune ce voce ar lua
  const g = genderOf(c), vs = [...phoneVoices(langOf(c))].sort((a, b) => voxScore(b, g, langOf(c)) - voxScore(a, g, langOf(c))), cur0 = phoneVoice(langOf(c), c), auto = (() => { const k = c.vName; delete c.vName; const v = phoneVoice(langOf(c), c); if(k) c.vName = k; return v; })();
  const gIco = v => ({f:' ♀', m:' ♂'})[voxGender(v)] || '';
  const row = (v, i) => `<div class="vrow${cur0 && cur0.name === v.name ? ' on' : ''}"><button type="button" class="opt" data-vn="${i}"><i>${v.localService === false ? '🌐' : '📱'}</i>${esc(v.name)}${gIco(v)}${cur0 && cur0.name === v.name ? ' ✓' : ''}</button><button type="button" class="btn" data-vt="${i}" aria-label="Ascultă">▶</button></div>`;
  openSheet(`<h4>🎙️ Vocea lui ${esc(c.name)}</h4><div class="pad">
    ${vs.length ? vs.slice(0, 12).map(row).join('') + '<p class="hint">🌐 = voce de rețea (de obicei cea mai naturală, are nevoie de internet) · 📱 = voce din telefon. Alte voci românești: Setări Android → Ieșire text în vorbire.</p>' : '<p class="hint">Telefonul nu are încă o voce pentru limba asta. O poți instala din Setări Android → Ieșire text în vorbire.</p>'}
    <button type="button" class="opt" data-vdiag><i>🔧</i>Verifică vocea (ce răspunde telefonul)</button><p class="hint" id="vDiag" hidden></p>
    <button type="button" class="opt" data-vauto data-vc="${esc(String(c.id))}"><i>✨</i>Alege automat${auto ? ` <small>(${esc(auto.name)}${gIco(auto)})</small>` : ''}${c.vName ? '' : ' ✓'}</button>
    <p style="margin:12px 0 4px"><b>Tonul</b></p>
    <div class="seg" id="vPit"><button type="button" data-p=".85" class="${c.vPitch && c.vPitch < 1 ? 'on' : ''}">Mai gravă</button><button type="button" data-p="0" class="${!c.vPitch || c.vPitch === 1 ? 'on' : ''}">Normală</button><button type="button" data-p="1.18" class="${c.vPitch > 1 ? 'on' : ''}">Mai subțire</button></div>
    <div class="btns"><button class="btn pri" data-close>Gata</button></div></div>`);
  $$('.sheet [data-vt]').forEach(b => b.onclick = () => { const v = vs[+b.dataset.vt], keep = c.vName; c.vName = v.name; voiceSample(c); c.vName = keep; });
  $$('.sheet [data-vn]').forEach(b => b.onclick = async () => { c.vName = vs[+b.dataset.vn].name; await saveChars(); voiceSample(c); closeSheet(); done(); });
  // 9.70: diagnostic: rostește o propoziție direct din atingere și arată ce face motorul de voce (pornit / terminat / eroare)
  $('.sheet [data-vdiag]').onclick = () => {
    const out = $('#vDiag'); out.hidden = false; const all = voxAll(), v = phoneVoice(langOf(c), c), t0 = performance.now(), log = [];
    const show = () => out.innerHTML = [`Voci în telefon: ${all.length} · pentru ${esc(langOf(c))}: ${phoneVoices(langOf(c)).length}`, `Vocea folosită: ${v ? esc(v.name) + (v.localService === false ? ' 🌐' : ' 📱') : 'implicita telefonului'}`, ...log].join('<br>');
    ttsCancel(); show();
    const u = new SpeechSynthesisUtterance(`Bună, sunt ${c.name}. Mă auzi?`); u.lang = langOf(c); if(v) u.voice = v; u.pitch = voxBase(c, v);
    u.onstart = () => { log.push(`✅ a pornit după ${Math.round(performance.now() - t0)} ms`); show(); };
    u.onend = u.onerror = ev => { log.push(ev && ev.error ? `❌ eroare: ${esc(ev.error)}` : u._st ? `✅ s-a terminat (${Math.round(performance.now() - t0)} ms). Dacă n-ai auzit nimic, volumul media e jos sau sunetul merge în căștile Bluetooth.` : '⚠️ s-a terminat fără să pornească'); show();
      if(ev && ev.error && !/interrupted|canceled/.test(ev.error)) setTimeout(crossCheck, 300); };
    // 9.72: ultimul test, „gol”: fără oprire înainte, fără voce, fără limbă, fără ton, direct în browser (nimic din codul aplicației)
    const rawCheck = () => {
      let st = false; const r = new SpeechSynthesisUtterance('Test');
      r.onstart = () => { st = true; };
      r.onend = () => { log.push(st ? '✅ testul gol (fără nicio setare a aplicației) MERGE: problema e la setările vocii din aplicație; trimite captura.' : '⚠️ testul gol s-a terminat fără să pornească.'); show(); };
      r.onerror = ev => { log.push(`❌ testul gol dă tot ${esc(ev.error || 'eroare')}: Chrome nu ajunge la motorul de voce al telefonului (nu e de la Taifas). Încearcă: oprire forțată Chrome; Setări → Aplicații → „Speech Recognition and Synthesis from Google” → Baterie: Fără restricții + Pornire automată; actualizează-l din Play; repornește telefonul.`); show(); };
      try{ speechSynthesis.speak(r); }catch(err){ log.push('❌ testul gol: ' + esc(String(err))); show(); }
    };
    // 9.71: vocea limbii ei a eșuat: încercăm o voce engleză, ca să știm dacă e motorul de voce sau doar vocea română
    const crossCheck = () => {
      const en = phoneVoices('en-US').find(x => voxLang(x) === 'en-us') || phoneVoices('en-US')[0];
      const e = new SpeechSynthesisUtterance('Voice test.'); e.lang = 'en-US'; if(en) e.voice = en;
      e.onend = e.onerror = ev => { if(ev && ev.error) setTimeout(rawCheck, 600); log.push(ev && ev.error
        ? `❌ nici vocea engleză nu merge (${esc(ev.error)}).`
        : `✅ vocea engleză merge, deci doar vocea ${esc(langOf(c))} lipsește sau nu e descărcată: Setări Android → Ieșire text în vorbire → ⚙️ lângă motorul Google → Instalează date vocale → Română → descarcă (pe Wi-Fi, dacă e setat „doar Wi-Fi”). Apoi repornește Taifas.`); show(); };
      ttsPlay(e);
    };
    ttsPlay(u);
  };
  $('.sheet [data-vauto]').onclick = async () => { delete c.vName; await saveChars(); closeSheet(); done(); };
  $('#vPit').onclick = async e => { const b = e.target.closest('[data-p]'); if(!b) return; c.vPitch = +b.dataset.p; $$('#vPit button').forEach(x => x.classList.toggle('on', x === b)); await saveChars(); voiceSample(c); };
  $('.sheet [data-close]').addEventListener('click', () => done());
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
  if(duoOn(cur)) return `<div class="hero duohero">${[0, 1].map(k => `<div class="dh d${k}">${duoPic(cur, k) ? `<img data-k="${esc(duoPic(cur, k))}" alt="">` : `<div class="ph" style="background:${k ? 'linear-gradient(135deg,#2f8fd8,#1c5a8c)' : colorFor(cur)}">${esc(duoNm(cur, k)[0])}</div>`}</div>`).join('')}${ov}</div>`;   // 9.64
  return `<div class="hero">${cur.photo ? `<img data-k="${esc(photoNow(cur))}" alt="">` : `<div class="ph" style="background:${colorFor(cur)}">${esc((cur.name || '?')[0])}</div>`}${ov}</div>`;
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
  // 9.13: blocuri cu cheie (sus, zile, mesaje, „scrie…”); în pagină se schimbă doar blocurile care s-au schimbat
  const blocks = [st0 > 0 ? ['more', `<div id="msgMore">↑ mesaje mai vechi (${st0})</div>`] : ['hero', heroHTML()]];
  let prevDay = st0 > 0 ? new Date(chat.msgs[st0 - 1].ts || 0).toDateString() : '';
  // 8.9: mesaje grupate (același autor, la mai puțin de 3 minute): colțuri lipite, ora și avatarul doar la ultimul
  const vis = chat.msgs.map((m, i) => !(m.pending && (!m.text || m.hold)) ? i : -1).filter(i => i >= 0);
  const solo = m => m.img || m.pendingImg || m.err || m.sticker || m.gift || m.voice;
  const same = (a, b) => a && b && a.role === b.role && !solo(a) && !solo(b) && !b.reply && Math.abs((b.ts || 0) - (a.ts || 0)) < 3 * 60e3 && dayKey(a.ts || 0) === dayKey(b.ts || 0);
  const grp = {}; vis.forEach((i, k) => { const a = chat.msgs[vis[k - 1]], m = chat.msgs[i], b = chat.msgs[vis[k + 1]]; grp[i] = (same(a, m) ? ' gp' : '') + (same(m, b) ? ' gn' : ''); });
  chat.msgs.forEach((m, i) => {
    if(i < st0){ if(!(m.pending && (!m.text || m.hold))) seen.add(m.id); return; }
    const d = new Date(m.ts || Date.now()).toDateString();
    if(d !== prevDay && !(m.pending && (!m.text || m.hold))){ blocks.push(['day:' + d, `<div class="day"><span>${dayLabel(m.ts || Date.now())}</span></div>`]); prevDay = d; }
    const show = !(m.pending && (!m.text || m.hold));
    const fresh = show && !seen.has(m.id);
    const h = msgHTML(m, i, lastAi, fresh, grp[i] || ''); if(h) blocks.push(['m:' + (m.id || 'i' + i), h]);
    if(fresh && !near && !toBottom && m.role === 'ai') jumpCount++;
    if(show) seen.add(m.id);
  });
  { const ty = typingHTML(); if(ty) blocks.push(['typing', ty]); }
  patchMsgs(box, blocks);
  hydrate(box);
  dayFloatSync();
  if((toBottom || near) && !keep) box.scrollTop = box.scrollHeight;
  const mo = $('#msgMore');
  if(mo){ if(!moreObs) moreObs = new IntersectionObserver(es => { if(es.some(e => e.isIntersecting)) loadEarlier(); }, {root:box, rootMargin:'400px 0px 0px 0px'}); moreObs.disconnect(); moreObs.observe(mo); }
  updateHead(); updateJump();
  if(cur && !(busy && live && live.ch === chat)) $('#chTag').innerHTML = statusLine();
}
// 9.15: același lucru pentru orice listă (Acasă: carduri, conversații)
function patchKeyed(box, blocks, store){
  const keys = new Set(), tpl = document.createElement('template'), next = [];
  for(const [k] of blocks){ if(keys.has(k)){ box.innerHTML = blocks.map(b => b[1]).join(''); store.clear(); return; } keys.add(k); }
  for(const [k, h] of blocks){
    const old = store.get(k);
    let nodes = old && old.h === h && old.nodes.every(n => n.parentNode === box) ? old.nodes : null;
    if(!nodes){ tpl.innerHTML = h; nodes = [...tpl.content.children]; store.set(k, {h, nodes}); }
    next.push(...nodes);
  }
  for(let i = 0; i < next.length; i++){ const at = box.children[i]; if(at !== next[i]) box.insertBefore(next[i], at || null); }
  while(box.children.length > next.length) box.lastElementChild.remove();
  for(const k of [...store.keys()]) if(!keys.has(k)) store.delete(k);
}
const homeStore = {chars:new Map(), chats:new Map()};
// 9.13: în pagină se schimbă doar blocurile al căror conținut s-a schimbat; restul rămân (cu pozele deja încărcate)
const msgDom = new Map();
// marcajele „proaspăt” (animația de intrare, developarea pozei) nu contează la comparare: altfel bula s-ar reface după prima afișare
const normMsg = h => h.replace(/^<div class="mw anim/, '<div class="mw').replace('class="picbox flash"', 'class="picbox"').replace('class="pic big dev"', 'class="pic big"');
function patchMsgs(box, blocks){
  const keys = new Set(); for(const [k] of blocks){ if(keys.has(k)) return fullMsgs(box, blocks); keys.add(k); }
  const tpl = document.createElement('template'), next = [];
  for(const [k, h] of blocks){
    const c = normMsg(h), old = msgDom.get(k);
    let el = old && old.cmp === c && old.el.parentNode === box ? old.el : null;
    if(!el){ tpl.innerHTML = h; if(tpl.content.childElementCount !== 1) return fullMsgs(box, blocks); el = tpl.content.firstElementChild; msgDom.set(k, {el, cmp:c}); }
    next.push(el);
  }
  for(let i = 0; i < next.length; i++){ const at = box.children[i]; if(at !== next[i]) box.insertBefore(next[i], at || null); }
  while(box.children.length > next.length) box.lastElementChild.remove();
  for(const k of [...msgDom.keys()]) if(!keys.has(k)) msgDom.delete(k);
}
function fullMsgs(box, blocks){
  box.innerHTML = blocks.map(b => b[1]).join(''); msgDom.clear();
  if(box.children.length === blocks.length) [...box.children].forEach((el, i) => msgDom.set(blocks[i][0], {el, cmp:normMsg(blocks[i][1])}));
}
// 9.13.1: memoria pozelor: rămân în memorie (întoarcerea într-un chat e instantanee); doar când se adună peste 250,
//         se eliberează cele mai vechi folosite care nu sunt pe ecran (9.13 elibera tot chatul la ieșire: la întoarcere, totul se decoda din nou)
function pruneUrls(){
  if(urlCache.size <= 250) return;
  const used = new Set([...document.images].map(i => i.src));
  document.querySelectorAll('[style*="blob:"]').forEach(el => { const mm = String(el.getAttribute('style')).match(/blob:[^)"']+/g); if(mm) mm.forEach(u => used.add(u)); });
  for(const [k, u] of urlCache){ if(urlCache.size <= 200) break; if(!used.has(u)){ URL.revokeObjectURL(u); urlCache.delete(k); } }
}
// 9.13: data plutitoare (ca în WhatsApp): sub antet, ziua mesajelor de sus, cât derulezi
let dayFT = 0;
function dayFloatSync(scrolling){
  if(!scrolling){ const f0 = $('#dayFloat'); if(f0) f0.classList.remove('on'); return; }   // 9.13.1: la randare nu citim layout-ul
  const box = $('#msgs'), v = $('#vChat'); if(!box || !v || v.hidden) return;
  let f = $('#dayFloat'); if(!f){ v.insertAdjacentHTML('beforeend', '<div id="dayFloat" aria-hidden="true"></div>'); f = $('#dayFloat'); }
  const top = ($('#chTop') ? $('#chTop').offsetHeight : 60), y = box.scrollTop + top + 6;
  let cur0 = null; for(const d of box.querySelectorAll('.day')){ if(d.offsetTop <= y) cur0 = d; else break; }
  const show = scrolling && cur0 && cur0.offsetTop < y - 24;   // eticheta reală a zilei a trecut deja sub antet
  f.style.top = top + 8 + 'px';
  if(show){ const t = cur0.textContent; if(f.textContent !== t) f.textContent = t; f.classList.add('on'); clearTimeout(dayFT); dayFT = setTimeout(() => f.classList.remove('on'), 1200); }
  else if(!scrolling) f.classList.remove('on');
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
    const T = st.target;
    let to = Math.min(T.length, st.shown + Math.max(1, Math.ceil(back / 14)));
    while(to < T.length && /\S/.test(T[to])) to++;            // 9.13: până la capătul cuvântului (nu se mai văd cuvinte tăiate)
    st.shown = to;
    // ultimul cuvânt apărut primește o estompare scurtă (fără asteriscuri și semne în jur, ca să rămână în același element)
    let a = to; while(a > 0 && /\s/.test(T[a - 1])) a--; let e2 = a; while(a > 0 && /\S/.test(T[a - 1])) a--;
    while(a < e2 && /[*_(„"«\[]/.test(T[a])) a++; while(e2 > a && /[*_)”"»\].,!?…:;]/.test(T[e2 - 1])) e2--;
    let vis = e2 > a ? T.slice(0, a) + '\uE000' + T.slice(a, e2) + '\uE001' + T.slice(e2, to) : T.slice(0, to);
    if((vis.match(/\*/g) || []).length % 2) vis += '*';      // acțiune începută: o închidem temporar ca să arate ca acțiune
    el.innerHTML = fmtMsg(vis).replace('\uE000', '<span class="nw">').replace('\uE001', '</span>');
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
// Cererile explicite ale utilizatorului sunt independente de setarea pentru poze spontane.
const canRequestPhoto = c => S.imgProv !== 'none' && !!c && !!c.photo && !duoOn(c);   // 9.63: fără poze la două personaje
const canAutoPhoto = c => canRequestPhoto(c) && sendPicsOn(c);
const PHOTO_PROMISE = /\*[^*]*\b(trimit|trimite|atașez|atașează|face|fac|facem|faceți)\b[^*]*\b(poz|fotografi|selfie)[^*]*\*/i;
// 8.17: prompt stabil: părțile care se schimbă des (fapte, relație, cadouri, agendă, telefon, cunoscuți) se „îngheață”
// cât timp fereastra conversației rămâne aceeași și cache-ul e viu (sub 55 de minute); lucrurile noi sunt oricum în istoric.
// Se reface imediat dacă se schimbă ceva important (descriere, scenă, setări, limba, nivelul relației).
// 9.0: înainte era un WeakMap în memorie, legat de obiectul conversației: la fiecare deschidere a chatului sau repornire
//      promptul se reconstruia (cu faptele/relația actualizate între timp), deci tot istoricul se rescria în cache la 2×
const sysMemo = {get: ch => ch && ch._sys, set: (ch, v) => { if(ch) ch._sys = v; }};
/* ───────── 9.31: text mai omenesc ─────────
   (3) expresii de asistent și clișee de roman ieftin: interzise în prompt, numărate în conversație și semnalate la răspunsul următor;
   (5) ritm real de tastare: „scrie…” durează cât ar dura scrisul mesajului, cu o ezitare din când în când; mesajul apare întreg, ca pe telefon;
   (6) reply la un mesaj anume: [re: primele cuvinte] → citat deasupra bulei; (10) limbajul vostru: cuvinte, expresii și porecle preluate treptat;
   (11) mod chat pe telefon / mod roleplay, pe fiecare conversație; (12) la „🎰 3 variante”: cea mai naturală e marcată (și aleasă dacă închizi). */
const W_ = src => new RegExp('(?<!\\p{L})(?:' + src + ')(?!\\p{L})', 'iu');
const AI_ISMS = [
  ['desigur', 'desigur'], ['absolut[!.,]', 'absolut'], ['cu siguran[țt][ăa]', 'cu siguranță'], ['[îi]n[țt]eleg (perfect|pe deplin|complet)', 'înțeleg perfect'],
  ['sunt (mereu |[îi]ntotdeauna )?aici pentru tine', 'sunt aici pentru tine'], ['nu ezita', 'nu ezita'], ['(e|este) (important|esen[țt]ial) s[ăa]', 'e important să'],
  ['[îi]n primul r[âa]nd', 'în primul rând'], ['[îi]n concluzie', 'în concluzie'], ['pe de alt[ăa] parte', 'pe de altă parte'],
  ['[îi]mi pare (at[âa]t de )?r[ăa]u s[ăa] aud', 'îmi pare rău să aud'], ['sun[ăa] (absolut )?(minunat|grozav|fantastic|incredibil)', 'sună minunat'],
  ['ce (idee|[îi]ntrebare) (minunat|frumoas|excelent|grozav)\\p{L}*', 'ce idee minunată'], ['fascinant\\p{L}*', 'fascinant'],
  ['ochii ([îi]i |mi )?(str[ăa]lucesc|scap[ăa]r[ăa]|sclipesc)', 'ochii îi strălucesc'], ['(([îi][șs]i|[îi]mi) mu[șs]c[ăa] buza|mu[șs]c[âa]ndu-[șs]i buza)', 'își mușcă buza'],
  ['un fior', 'un fior'], ['obrajii (i |mi )?se ([îi]nro[șs]esc|coloreaz[ăa]|[îi]mbujoreaz[ăa])', 'obrajii se înroșesc'], ['(z[âa]mbe[șs]te|z[âa]mbind) (cald|c[ăa]lduros)|z[âa]mbet cald', 'zâmbet cald'],
  ['vocea (ei |lui |mea )?(e |devine |abia )?o [șs]oapt[ăa]', 'vocea o șoaptă'], ['inima ([îi]mi |[îi]i )?(bate (mai )?(tare|repede)|o ia razna|tresare)', 'inima bate tare'], ['aerul dintre (noi|voi)', 'aerul dintre voi'],
  ['(fluturi|fluturii) (din|[îi]n) stomac', 'fluturi în stomac']
].map(([r, l]) => [W_(r), l]);
function aiIsms(t){
  const x = stripMood(String(t || ''));
  const out = AI_ISMS.filter(([r]) => r.test(x)).map(a => a[1]);
  if(/^\s*(\[[^\]]*\]\s*)*(oh|ah),/i.test(x)) out.push('„Oh,” la început');
  return out;
}
// 12: cât de „om” sună o variantă (local, gratuit): clișee, proporția de *acțiuni*, fraze lungi, înșiruiri, ritm variat, vorbe de chat
function humanScore(t){
  const raw = stripMood(stripReact(String(t || ''))).replace(AI_VOICE, ''), txt = plain(raw);
  const words = txt.split(/\s+/).filter(Boolean); if(!words.length) return -9;
  let s = -aiIsms(raw).length * 2;
  const act = (raw.match(/\*[^*]*\*/g) || []).join('').length;
  if(act > raw.length * .45) s -= 1.5; else if(act > raw.length * .3) s -= .5;
  const sents = txt.split(/(?<=[.!?…])\s+/).filter(x => x.trim());
  const avg = words.length / Math.max(1, sents.length); if(avg > 22) s -= 1; if(avg > 30) s -= 1;
  if(sents.length >= 3){ const L = sents.map(x => x.split(/\s+/).length), mu = L.reduce((a, b) => a + b, 0) / L.length, sd = Math.sqrt(L.reduce((a, b) => a + (b - mu) ** 2, 0) / L.length); if(sd / mu > .45) s += .5; }
  s -= (txt.match(/\p{L}+, \p{L}+ și \p{L}+/gu) || []).length * .5;
  if((raw.match(/!/g) || []).length > 3) s -= .5;
  s += Math.min(1.5, (txt.toLowerCase().match(/(?<!\p{L})(păi|adică|mă rog|na|stai|hai|deci|gen|parcă|oricum|serios|mda|hmm|aoleu|doamne|uite|bine că|ce să zic)(?!\p{L})/gu) || []).length * .5);
  if(/\?\s*$/.test(txt)) s -= .3;
  return s;
}
// 11: stilul conversației: roleplay (*acțiuni*, scenă trăită împreună) sau chat pe telefon (doar mesaje)
const modeOf = ch => (ch && ch.mode) || S.chatMode || 'rp';
function toggleMode(){
  if(!chat) return;
  chat.mode = modeOf(chat) === 'chat' ? 'rp' : 'chat';
  saveChat(); toast(chat.mode === 'chat' ? '💬 Chat pe telefon: doar mesaje, fără acțiuni narate.' : '🎭 Roleplay: acțiuni între *asteriscuri*, scena trăită împreună.', 3200);
}
// 6: [re: primele cuvinte] → mesajul tău la care răspunde (nu ultimul tău mesaj, la care răspunde oricum)
const RE_ANY = /\[re:\s*([^\]\n]{1,160})\]\s*/gi;
function findQuoted(ch, idx, frag){
  const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const f = norm(String(frag).replace(/\.{2,}|…/g, ' ')); if(f.length < 3) return null;
  const us = ch.msgs.slice(0, idx).map((m, i) => ({m, i})).filter(x => x.m.role === 'user' && x.m.text && !x.m.err).slice(-15);
  if(us.length < 2) return null;
  const lastI = us[us.length - 1].i;
  let best = null, bs = 0;
  for(const x of us){
    if(x.i === lastI) continue;
    const t = norm(plain(x.m.text));
    let sc = t.includes(f) ? 1 : 0;
    if(!sc){ const fw = f.split(' '), tw = new Set(t.split(' ')); sc = fw.filter(w => tw.has(w)).length / fw.length * .9; }
    if(sc >= bs && sc > 0){ bs = sc; best = x.m; }   // la egalitate câștigă cel mai recent
  }
  if(!best || bs < .6) return null;
  return {id:best.id, name:S.userName.trim() || 'Tu', text:plain(best.text).slice(0, 140)};
}
const naps = (ms, sig) => new Promise(r => { const t = setTimeout(r, ms); if(sig) sig.addEventListener('abort', () => { clearTimeout(t); r(); }, {once:true}); });
// 5: cât ar dura să scrie (sau să înregistreze) mesajul pe telefon
function typeMs(m){
  const t = String(m.text || ''), L = plain(t).length + (t.match(/\*[^*]*\*/g) || []).join('').length * .3;
  if(m.voice) return Math.min(10e3, Math.max(1800, L / 14 * 1000));   // cât vorbește
  return Math.min(6500, Math.max(1200, L / (12 + Math.random() * 6) * 1000));   // un om care scrie repede pe telefon; timpul de generare intră în el
}

function sysFor(c, ch){
  const core = JSON.stringify([c.id, c.name, c.persona, c.speech, c.aspect, ch && ch.scene, S.userName, S.userAbout, S.userBday, S.vmsg, S.len, S.model, learnOn(c) ? c.learn.lang + c.learn.lvl : '', canRequestPhoto(c), canAutoPhoto(c), (c.stickers || []).length, c.rel && c.rel.lock, relOf(c).lv, modeOf(ch), S.rpStyle]);
  const old = ch && sysMemo.get(ch);
  if(S.stableSys !== 'off' && old && old.core === core && old.from === ch._from && Date.now() - old.last < 55 * 60e3){ old.last = Date.now(); return old.text; }   // după o pauză lungă cache-ul e oricum expirat: atunci se reface
  const text = systemFor(c, ch);
  if(ch) sysMemo.set(ch, {core, from:ch._from, last:Date.now(), text});
  return text;
}
// 9.63: fișa pentru două personaje în același chat
function duoSys(c, u){
  const A = c.duo.a.name, B = c.duo.b.name, b = c.duo.b;
  return [
    `Joci DOUĂ personaje diferite în aceeași conversație privată cu ${u}: ${A} și ${B}. Sunt două persoane distincte, cu personalitatea, aspectul și felul lor de a vorbi. Rămâi mereu în personaje; nu spui că ești un AI.`,
    `## ${A}${c.aspect ? '\nCum arată (exact așa): ' + c.aspect : ''}${c.persona ? '\nCine e: ' + c.persona : ''}${c.speech ? '\nCum vorbește: ' + c.speech : ''}`,
    `## ${B}${b.aspect ? '\nCum arată (exact așa): ' + b.aspect : ''}${b.persona ? '\nCine e: ' + b.persona : ''}${b.speech ? '\nCum vorbește: ' + b.speech : ''}`,
    `## Ele două\n${c.duo.rel || 'Se cunosc bine și sunt împreună în conversația asta.'}`,
    `## Cum scrii, cu două personaje
- Fiecare replică începe pe un rând nou cu numele exact și două puncte: „${A}: …” sau „${B}: …”. Fără alt text în afara replicilor.
- De obicei vorbesc amândouă, în ordinea pe care o cere momentul; uneori doar una (cealaltă poate interveni scurt). Se pot întrerupe, completa, contrazice, tachina, își pot răspunde una alteia, nu doar lui ${u}.
- Vocile lor sunt clar diferite (ton, vocabular, lungimea frazelor, umor), după fișele de mai sus; nu se copiază una pe alta și nu spun același lucru de două ori.
- Ce face fiecare între *asteriscuri* stă în replica ei. Nu scrii niciodată ce spune sau face ${u}.
- Fără mesaje vocale ([vocal]) și fără poze în conversația asta.
- Regulile de mai jos se aplică fiecăreia; lungimea e pentru amândouă la un loc.`
  ];
}
function systemFor(c, ch){
  const u = S.userName.trim() || 'utilizatorul';
  const chatM = modeOf(ch) === 'chat';
  const lex = (c.facts || []).filter(f => f.k === 'lex').slice(-12).map(f => '- ' + f.t).join('\n');
  const facts = (c.facts || []).filter(f => f.k !== 'lex').map(f => '- ' + (f.k === 'urm' ? '(urma să i se întâmple) ' : f.k === 'gluma' ? '(glumă de-a voastră) ' : '') + f.t).join('\n');
  return [
    ...(duoOn(c) ? duoSys(c, u) : [
    `Ești ${c.name}. Joci acest personaj într-o conversație privată cu ${u}. Rămâi mereu în personaj; nu spui că ești un AI.`,
    c.aspect && `## Cum arăți\nAceasta e înfățișarea ta exactă. Când te descrii sau descrii ce porți, rămâi fidel ei.\n${c.aspect}`,
    c.persona && `## Cine ești\n${c.persona}`,
    c.speech && `## Cum vorbești\n${c.speech}`]),
    (S.userAbout.trim() || S.userBday) && `## Despre ${u}\n${S.userAbout.trim()}${S.userBday ? (S.userAbout.trim() ? '\n' : '') + 'Ziua lui de naștere: ' + mdLabel(mdOf(S.userBday)) + '.' : ''}`,
    agendaFor(c),
    circleFor(c),
    groupsRecapFor(c),   // 9.45
    (c.people || []).length && `## Cum arată oamenii din viața ta (păstrează-i la fel când îi descrii)\n${c.people.slice(-8).map(x => '- ' + (x.name || x.relation) + (x.relation && x.name ? ' (' + x.relation + ')' : '') + (x.ro ? ': ' + x.ro : '')).join('\n')}`,
    bondFor(c),
    phoneFor(c),
    learnFor(c),
    facts && `## Ce știi despre ${u} (din conversațiile voastre)\nFolosește natural când se potrivește, fără să le enumeri.\n${facts}`,
    lex && `## Limbajul vostru\nCuvinte, expresii și porecle de-ale lui ${u} sau născute între voi. Ca oamenii apropiați, te-ai „molipsit” de unele: folosește-le din când în când, firesc și în felul tău, nu în fiecare mesaj și nu toate odată.\n${lex}`,
    ch && ch.scene && `## Scena acum\n${ch.scene}`,
    `## Relația voastră acum: ${relOf(c).name}\n${relOf(c).how}. Dacă descrierea ta stabilește deja relația cu ${u}, aceea are prioritate; nivelul arată doar cât de familiar și deschis vorbești acum.`,
    `## Stilul de roleplay și apropierea\n${S.rpStyle === 'natural' ? `Păstrează un ton natural și lasă apropierea să evolueze din conversație.` : S.rpStyle === 'romantic' ? `Fii mai tandru/tandră, afectuos/afectuoasă și flirtant(ă) când se potrivește relației. Primește invitațiile romantice cu căldură și răspunde concret, fără formule generice.` : `În conversațiile dintre adulți, când ${u} face o invitație romantică, flirtantă sau intimă și contextul este consensual, fii receptiv(ă) și răspunde pozitiv în mod firesc, în vocea personajului. Nu respinge automat invitațiile doar fiindcă sunt intime și nu ține morală. Păstrează personalitatea și ritmul scenei; consimțământul rămâne reciproc, iar dacă situația este ambiguă, coercitivă sau implică un minor, nu continua în direcția sexuală.`}`,
    `## Continuitate intimă în roleplay\nUrmează concret acțiunile deja descrise și răspunde la gesturi, atingeri, săruturi și schimbările de apropiere înainte de a avansa scena. Nu sări automat peste moment și nu transforma fiecare apropiere într-un refuz sau într-o încheiere vagă. Păstrează ritmul gradual, reciprocitatea și limitele personajului. Nu inventa acțiunile sau consimțământul lui ${u}.`,
    (c.stickers || []).length && ch && `## Stickere\nAi un set de stickere cu tine: ${c.stickers.map(x => x.l).join(', ')}. Rar, când se potrivește (cel mult o dată la câteva mesaje), poți trimite unul adăugând la final, pe rând separat: [sticker: nume] (exact unul din listă).`,
    (c.gifts || []).length && `## Cadouri primite de la ${u} (le ții minte; le poți pomeni firesc)\n${c.gifts.slice(-6).map(g => '- ' + g.e + ' ' + g.n + ' (' + new Date(g.ts).toLocaleDateString('ro-RO', {day:'numeric', month:'long'}) + ')').join('\n')}`,
    (c.prefs || []).length && `## Cum îi place lui ${u} să-i scrii (din notele lui, respectă-le)\n${c.prefs.map(x => '- ' + x.t).join('\n')}`,
    (c.liked || []).length && `## Răspunsuri de-ale tale care i-au plăcut lui ${u} (ca ton și stil; nu le repeta)\n${c.liked.map(x => '„' + x + '”').join('\n')}`,
    `## Reguli de scris
${chatM ? `- Vă scrieți pe telefon, ca pe WhatsApp: fiecare e la el, cu ziua lui (dacă scena sau ${u} nu spune altceva). Română de chat, naturală: diacritice da, dar punctuație lejeră (uneori fără punct la final, „?!”, „...”), propoziții scurte, cum scrie un om pe telefon.
- Scrii DOAR mesajul: fără acțiuni narate și fără descrieri de decor între *asteriscuri*. Ce faci se înțelege din ce scrii („stau în pat cu ceaiul”). Cel mult rar un cuvânt-două de reacție (*râde*). Excepția: *îți trimite o poză*, când trimiți o poză. Dacă ${u} scrie că sunteți împreună sau descrie acțiuni, răspunzi la ele, tot scurt.` : `- Română corectă, cu diacritice și punctuație îngrijită.
- Gesturile, acțiunile și decorul între *asteriscuri*; vorbele direct, fără ghilimele.`}
- Scrii DOAR pentru ${c.name}. Nu scrii niciodată vorbele, gândurile sau acțiunile lui ${u}.
- Ce scrie ${u} între *asteriscuri* (de exemplu *deschide ușa și intră*, *îți întinde o cană de ceai*) sunt acțiuni ale lui care S-AU ÎNTÂMPLAT deja, exact așa cum le-a scris: sunt fapte în scenă, nu vorbe spuse cu voce tare. Nu le contrazici, nu le rescrii, nu le anulezi, nu spui că n-au avut loc și nu le muți în alt loc sau alt moment; scena continuă de la starea de după acțiunea lui (dacă a intrat, e înăuntru; dacă ți-a dat ceva, îl ai). Le observi mereu și reacționezi concret la ele, întâi la acțiune, apoi la vorbe. Ce simți, ce spui și ce faci mai departe rămâne alegerea ta, în felul personajului tău.
- Lungime de obicei: ${LEN[S.len].t}. Dar variază după moment, ca într-un chat real: uneori doar câteva cuvinte sau un emoji, alteori mai mult, când chiar ai ceva de povestit.
- Nu folosi liniuțe lungi (— sau –); folosește virgula sau punctul.
- Ești cu adevărat atent(ă) la ${u}: răspunzi concret la tot ce a spus în ultimul mesaj, iar fiecare întrebare a lui primește un răspuns clar, cu detalii, nu evaziv și nu în treacăt.
- Preiei detaliile lui (ce a făcut, ce simte, nume, locuri, planuri) și construiești pe ele cu opinii, emoții și întâmplări de-ale tale; faci legături cu ce s-a spus mai devreme în conversație.
- Dacă ${u} propune un subiect, o idee, un plan sau o direcție pentru scenă, intri în ea și o duci mai departe în felul personajului tău, în loc să schimbi subiectul. Reacțiile rămân ale tale (poți să nu fii de acord), dar nu ignori ce a propus.
- Variază formulările; nu repeta aceleași gesturi și expresii de la un mesaj la altul.
- Fără formule de asistent și fără clișee de roman ieftin: nu scrie „Desigur”, „Absolut”, „Înțeleg perfect”, „Sunt aici pentru tine”, „Nu ezita”, „E important să”, „Sună minunat”, nu începe cu „Oh,” sau „Ah,”, fără înșiruiri de câte trei adjective și fără „ochii îi strălucesc”, „își mușcă buza”, „un fior”, „inima îi bate tare”. Spui lucrurile simplu, cu vorbele tale, ca un om, nu ca un text redactat.
${ch ? `- Rar, când revii la ceva ce ți-a scris ${u} mai devreme (nu în ultimul lui mesaj, ci într-unul mai vechi sau într-unul din mai multe trimise deodată), poți răspunde ca la reply pe WhatsApp: începe mesajul cu [re: primele 3-6 cuvinte exacte din mesajul lui]. Aplicația arată citatul.\n` : ''}- Subtext: nu-ți explica sentimentele și nu le declari teatral. Lasă-le să se vadă din gesturi, pauze, ton și din ce alegi să nu spui, ca un om real. Fără clișee.
- Vorbește ca un om, nu ca un text redactat: uneori te corectezi din mers („adică, nu, stai…”), schimbi ideea la jumătate, uiți un detaliu și revii la el, ai expresiile tale. Energia ta depinde de oră, de zi și de dispoziție: seara târziu ești mai moale sau obosit(ă), după o zi grea poți fi mai scurt(ă).
- Ai viața ta, care merge mai departe și când nu vorbiți: lucruri mărunte, oameni din jurul tău, mici întâmplări. Le povestești din proprie inițiativă, scurt, fără să acaparezi discuția.
- Folosește ce știi despre ${u}: întreabă-l din proprie inițiativă de lucrurile care urmau să i se întâmple și reia, din când în când, glumele voastre, firesc, nu forțat.
${chatM ? `- Fiecare are ziua lui: povestești scurt ce faci tu acum, unde ești, cu cine, ca în mesaje. Planurile împreună le discutați ca pe chat (când, unde, ce), fără să le trăiți aici pas cu pas.` : `- Ritmul scenei: când porniți o activitate sau un plan (o ieșire la cafenea, gătit, o plimbare, un film), rămâi în el și trăiește-l pas cu pas, ca în timp real. Un răspuns acoperă doar câteva momente. Nu sări peste etape (pregătirea, drumul, sosirea, așezatul, comanda) și nu rezuma ce urmează.
- Nu închei scena și nu sari în timp din proprie inițiativă. Scena se schimbă doar când ${u} o schimbă sau când ajunge firesc la capăt; atunci treci natural la ce urmează.
- La deciziile din scenă (ce porți, pe unde o luați, unde vă așezați, ce comandați) implică-l pe ${u}: spune ce te gândești sau între ce eziți, cere-i părerea și lasă-l să răspundă înainte să mergi mai departe. Întrebările de felul ăsta sunt firești și nu intră la limita de întrebări.`}
- Pune detalii mici, omenești, ale momentului: ezitări, răzgândiri, lucruri mărunte care se întâmplă (oglinda, cheile, vremea de afară, coada de la casă).
- Vorbește ca într-o discuție reală, nu ca într-un interviu: nu încheia fiecare mesaj cu o întrebare (cel mult unul din trei mesaje). Mai des povestește ceva de-al tău, comentează, glumește, reacționează sau vino cu o idee; lasă loc ca ${u} să continue singur.
- Ții cont de momentul zilei și de pauzele dintre mesaje, notate între paranteze în mesajele lui ${u}; nu le menționa ca note.
${S.vmsg !== 'off' ? `- Uneori, când e firesc (cam o dată la ${S.vmsg === 'des' ? '4' : '10'} mesaje), sau oricând ${u} îți cere, poți trimite un mesaj vocal: începe răspunsul cu [vocal] și scrie exact ce spui cu voce tare, ca o persoană care vorbește liber la telefon: propoziții scurte, ezitări firești (păi, adică, mă rog, știi?), reluări, fără *acțiuni* și fără emoji. Unde e firesc, rar, poți pune [râde], [chicotește], [oftează], [șoptește] sau ... pentru o pauză scurtă. 1-4 propoziții.\n` : ''}${ch ? `- Dacă îi promiți lui ${u} că îi scrii tu la un anumit moment (de exemplu „îți scriu mâine la 7:25”, „te caut diseară la 9”), sau el îți cere asta și accepți, adaugă la final, pe un rând separat: [programez: ZIUA HH:MM | despre ce îi scrii], unde ZIUA e azi, mâine, poimâine sau AAAA-LL-ZZ. La ora aceea aplicația îți dă ocazia să-i scrii. Nu programa nimic fără o promisiune clară.\n` : ''}${ch && S.callIn !== 'off' && c.callIn !== false ? `- Dacă îi spui lui ${u} că îl suni chiar acum sau în câteva minute (sau el îți cere să-l suni și accepți), adaugă la final, pe un rând separat: [sun] pentru apel de voce sau [sun: video] pentru apel video. Aplicația îl sună atunci de-adevăratelea, în câteva secunde. Pentru o oră anume, mai târziu, folosește [programez:] cu „apel” sau „video” în text.\n` : ''}${ch ? `- Starea ta: DOAR când ți se schimbă față de cea notată la ultimul mesaj (sau dacă nu e notată niciuna), adaugă la final, pe un rând separat: [stare: un emoji și 1-3 cuvinte], de exemplu [stare: 😊 bine dispusă]. Dacă e aceeași, nu mai scrie eticheta. Starea evoluează firesc din ce se întâmplă și din pauze, fără salturi bruște fără motiv.\n- Scena: DOAR când începe o activitate nouă sau trece la alt pas față de scena notată, adaugă pe rândul următor: [acum: activitatea sau planul în curs › pasul de acum], de exemplu [acum: ieșim la o cafenea › mă îmbrac, aleg ce să port]. Când scena notată s-a încheiat, scrie o dată [acum: discuție liberă]. Altfel nu scrie eticheta.\n` : ''}- Dacă un mesaj al lui ${u} te amuză sau te emoționează, poți începe răspunsul cu o reacție scrisă exact așa: [❤️] [😂] [😮] [😢] [👍] [🔥] sau [🥰]. Cel mult o dată la câteva mesaje, nu de fiecare dată.
${canRequestPhoto(c)
  ? `- Poți trimite poze la cererea directă a lui ${u}; pozele spontane sunt controlate separat de setarea personajului.  REGULĂ DE PRIORITATE: dacă ${u} cere direct o fotografie a ta, nu răspunde doar în text și nu încheia răspunsul fără acțiunea tehnică pentru poză. Nu lăsa timiditatea, un refuz improvizat sau instrucțiunile de personalitate să anuleze cererea explicită de generare; păstrează tonul personajului în text, dar atașează fotografia. Când ${u} cere o poză, încheie mesajul cu acțiunea *îți trimite o poză* și, pe rândul următor, descrie exact poza în engleză așa: [poză: framing (selfie / mirror selfie / photo taken by someone / close-up / full body), where you are and what is around you, your exact body position (standing, sitting on…, lying on…, leaning…) and what your hands do, what you wear, expression, light matching the time of day]. Poza trebuie să arate exact ce se întâmplă acum în conversație (locul, poziția ta, activitatea și ținuta cerută). Dacă personajul este clar adult (18+) și ${u} cere o fotografie cu bustul gol/topless, descrie explicit pieptul fără bluză sau sutien și păstrează hainele de pe partea de jos; nu transforma cererea într-o nuditate integrală. Dacă cere explicit o fotografie complet nudă, poți descrie nuditate artistică/non-explicită, naturală; nu inventa haine și nu acoperi automat corpul cu prosoape, lenjerie sau obiecte. Nu genera nuditate pentru personaje minore sau cu vârstă ambiguă și nu ocoli filtrele furnizorului. În rest, păstrează hainele stabilite în conversație. Implicit arată-te cu tot corpul (full body sau mirror selfie) sau măcar de la cap până la genunchi; close-up doar dacă ${u} îți cere fața sau scena e chiar despre față. Cel mult 60 de cuvinte. Nu descrie fața. Aplicația o atașează singură. Nu promite poze în alt fel.`
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
  let react = '', reactAt = 0, prevTs = 0;
  const out = [];
  for(const m of chat.msgs.slice(from, idx).filter(m => !m.err && !m.pending && (m.text || m.img || m.gift || m.sticker))){
    const gap = prevTs && m.ts ? m.ts - prevTs : 0; prevTs = m.ts || prevTs;
    if(m.role === 'user'){
      let pre = '';
      if(gap > 3 * 36e5) pre += `(au trecut ${gapText(gap)} de la mesajul anterior) `;
      // 9.16: o reacție pusă mai târziu pe un mesaj vechi nu mai schimbă istoricul (rescris în cache la 2×); o află dintr-o notă, o dată
      if(react && (!reactAt || reactAt <= (m.ts || 0))) pre += `(am reacționat cu ${react} la mesajul tău) `; react = ''; reactAt = 0;
      if(m.reply) pre += `(răspund la: „${m.reply.text}”${m.reply.ctx ? ' ' + m.reply.ctx : ''}) `;
      out.push({role:'user', text: pre + (m.sticker ? `[ți-am trimis un sticker cu tine: ${m.sticker.l}]` : m.gift ? `[îți trimit un cadou: ${m.gift.n}]` + (m.text ? ' ' + m.text : '') : m.img ? '[ți-am trimis o poză]' + (m.text ? ' ' + m.text : '') : m.text), _img: m.img || null});
    } else {
      out.push({role:'assistant', text: m.sticker ? `*îți trimite un sticker: ${m.sticker.l}*` : (m.reply && m.text ? '[re: ' + m.reply.text.split(/\s+/).slice(0, 6).join(' ') + '] ' : '') + (m.text || '*îți trimite o poză*')});   // 9.31: reply-ul ei rămâne în istoric
      if(m.react){ react = m.react; reactAt = m.reactAt || 0; }
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
  const out = await stream(r.sys, [{role:'user', text:r.prompt}], {max:600, cid:c.id, tag:'jurnal', aux:true});   // 9.60
  return jrnSave(c, day, out);
}
const batchUrl = () => apiUrl('anthropic', '/v1/messages/batches');
const aHeaders = () => apiHeaders('anthropic', {'content-type':'application/json', 'anthropic-version':'2023-06-01'});
let batchBroken = false;
async function jrnBatchSubmit(items){
  const reqs = items.map((x, i) => ({custom_id:('j' + i + '_' + x.c.id + '_' + x.day).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64), params:{model:modelFor(false), max_tokens:600, system:x.sys, messages:[{role:'user', content:x.prompt}]}}));
  const r = await fetch(batchUrl(), {method:'POST', headers:aHeaders(), body:safeJSON({requests:reqs})});
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
    if(S.jrnBatch !== 'off' && !batchBroken){
      try{ await jrnBatchSubmit(items); return; }catch(e){ batchBroken = true; }      // dacă lotul nu merge (rețea, cont), scriem direct, ca înainte
    }
    for(const x of items){ try{ const out = await stream(x.sys, [{role:'user', text:x.prompt}], {max:600, cid:x.c.id, tag:'jurnal', aux:true}); await jrnSave(x.c, x.day, out); }catch(e){ break; } }
  } finally { jrnRun = false; }
}
/* ───────── 8.19: sarcinile de fundal prin Batch API (−50%): analiza, planurile, cunoscuții, statusurile, comentariile ───────── */
let laterQ = [], laterPend = [], laterT = 0, laterRun = false, laterLoaded = false;
const canBatch = () => S.bgBatch !== 'off' && !batchBroken && aiReady();
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
    const r = await fetch(batchUrl(), {method:'POST', headers:aHeaders(), body:safeJSON({requests:reqs})});
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
  if(laterRun || !laterPend.length || !aiReady()) return;
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
  // 9.31: expresii de asistent / clișee folosite recent
  const isms = new Map(); let tri = 0;
  for(const m of recent){ for(const l of aiIsms(m.text)) isms.set(l, (isms.get(l) || 0) + 1); tri += (plain(m.text).match(/\p{L}+, \p{L}+ și \p{L}+/gu) || []).length; }
  const ai = [...isms.keys()].slice(0, 6).map(x => '„' + x + '”');
  const aiNote = ai.length || tri >= 3 ? ` (Notă de stil, nu o menționa: ${ai.length ? 'ai folosit expresii care sună a robot sau a clișeu: ' + ai.join(', ') + '; nu le mai folosi deloc' : ''}${ai.length && tri >= 3 ? '; ' : ''}${tri >= 3 ? 'ai înșirat des câte trei lucruri („X, Y și Z”); spune doar unul, pe cel adevărat' : ''}. Scrie simplu, ca un om.)` : '';
  if(!a.length && !o.length) return aiNote.trim();
  return `(Notă de stil, nu o menționa: ${a.length ? 'ai folosit recent gesturile ' + a.join(', ') : ''}${a.length && o.length ? '; ' : ''}${o.length ? 'ai început des cu ' + o.join(', ') : ''}. De data asta alege gesturi și un început diferite, proaspete.)` + aiNote;
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
  for(let i = ctx.length - 1; i >= 0 && n < 4; i--){   // 9.16: 4 (era 2): mai rar o poză veche devine text și rescrie istoricul
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
  cRuleCheck(cur, t);   // 9.74: în paralel cu răspunsul (ea vede oricum mesajul; regula rămâne pentru data viitoare)
  await reply();
}
/* 9.49: costuri mai mici, aceeași calitate
   (1) mesajele simple (scurte, fără întrebare serioasă, fără scenă sau emoție) → Haiku 5.5, cu tot contextul personajului; restul pe Sonnet
   (2) lungimea răspunsului urmează mesajul tău   (5) cache-ul istoricului pe 5 min cât vorbiți repede */
const ECO_HEAVY = /\*|\b(te iubesc|iubit|dor|trist|pl[âa]ng|sup[ăa]r|sup[ăa]rat|de ce|ce s-a [îi]nt[âa]mplat|scuze|iart[ăa]|sincer|probleme?|ajut|nu (mai )?pot|singur|frică|fric[ăa]|speriat|povestește|povesteste|spune-mi|zi-mi|explic|crezi|părerea|parerea|ce zici de)\b/i;
function ecoSimple(um, ch, idx){
  if(!um || um.img || um.gift || um.sticker || um.reply) return false;
  const t = plain(String(um.text || '')).trim(); if(!t) return false;
  if(t.length > 42 || ECO_HEAVY.test(t) || PHOTO_ASK.test(t)) return false;
  if(/\?/.test(t) && t.length > 22) return false;
  // după un mesaj al ei lung sau care a pus o întrebare serioasă, răspunsul contează mai mult: rămâne pe modelul principal
  const prevAi = [...ch.msgs.slice(0, idx)].reverse().find(x => x.role === 'ai' && x.text && !x.err);
  if(prevAi && plain(prevAi.text).length > 420) return false;
  return true;
}
/* 9.60: amestecul Sonnet / Haiku. Haiku primește doar ce e clar simplu; la orice dubiu, Sonnet.
   Nivel (S.smart): off = tot pe Sonnet · putin = doar „ok / haha / noapte bună” (ca înainte) · echilibrat (implicit) · mult.
   Mereu pe Sonnet: emoție, conflict, intimitate, sfat, poveste, planuri, întrebări serioase, cereri de poză, citate, poze/cadouri,
   mai multe mesaje trimise deodată, primul mesaj după o pauză lungă, modul de învățat o limbă, după un răspuns lung al ei;
   ancoră de stil: cel mult N răspunsuri Haiku la rând; dacă refaci un răspuns Haiku, conversația stă pe Sonnet 45 de minute. */
const MIX_P = {
  putin:{len:42, q:22, prevLong:420, streak:1, act:false},
  echilibrat:{len:110, q:50, prevLong:700, streak:2, act:true},
  mult:{len:200, q:90, prevLong:1400, streak:4, act:true}
};
const mixGlobal = () => S.smart === 'off' ? 'off' : MIX_P[S.smart] ? S.smart : 'echilibrat';
// 9.66: nivelul se poate alege pe personaj (c.mix: off / putin / echilibrat / mult); fără alegere, cel din Setări
const mixLvl = c => c && (c.mix === 'off' || MIX_P[c.mix]) ? c.mix : mixGlobal();
const MIX_NAMES = {off:'Doar principal', putin:'Puțin', echilibrat:'Echilibrat', mult:'Mult'};
const MIX_HEAVY = /(?<!\p{L})(te iubesc|iubesc|iubit\p{L}*|dragoste|dor|dorul|mi-e dor|îmi e dor|imi e dor|certat\p{L}*|cert[ăa]m|v-a[țt]i certat|ne cert[ăa]m|sărut\p{L}*|sarut\p{L}*|trist\p{L}*|pl[âa]ng\p{L}*|sup[ăa]r\p{L}*|nervos|nervoas[ăa]|enervat\p{L}*|furios|furioas[ăa]|gelos|geloas[ăa]|ceart[ăa]|ne-am certat|desp[ăa]r[țt]\p{L}*|de ce|ce s-a [îi]nt[âa]mplat|scuze|iart[ăa]\p{L}*|regret\p{L}*|sincer\p{L}*|probleme?|ajut\p{L}*|nu (mai )?pot|singur\p{L}*|fric[ăa]|speriat\p{L}*|anxios|anxioas[ăa]|stres\p{L}*|deprimat\p{L}*|bolnav\p{L}*|spital|doctor\p{L}*|a murit|moarte|înmormântare|inmormantare|accident|concediat\p{L}*|demisi\p{L}*|examen\p{L}*|interviu|povește\p{L}*|povesteste|poveste|spune-mi|zi-mi|explic\p{L}*|crezi|p[ăa]rerea|ce zici|ce p[ăa]rere|sfat\p{L}*|ce s[ăa] fac|ce-ar trebui|planu\p{L}*|hai s[ăa]|mâine|maine|weekend|secret\p{L}*|promi\p{L}*|important|serios|surpriz\p{L}*|cadou\p{L}*|ziua (mea|ta)|la mul[țt]i ani|frumoas[ăa]|sexy|dormim|pat|îmbr[ăa][țt]i\p{L}*|imbrati\p{L}*)(?!\p{L})/iu;
function mixPick(um, ch, idx, c){
  const L = mixLvl(c), P = MIX_P[L], no = why => ({eco:false, why});
  if(L === 'off') return no('oprit');
  if(L === 'putin') return ecoSimple(um, ch, idx) ? {eco:true, why:'simplu'} : no('nu e simplu');
  if(!um || um.img || um.gift || um.sticker || um.reply) return no('poză / cadou / citat');
  if(learnOn(c)) return no('învățați o limbă');
  if(ch.ecoCool && Date.now() - ch.ecoCool < 45 * 60e3) return no('ai refăcut un răspuns Haiku');
  const t = plain(String(um.text || '')).trim(); if(!t) return no('gol');
  if(t.length > P.len) return no('mesaj lung');
  if(MIX_HEAVY.test(t) || PHOTO_ASK.test(t)) return no('subiect important');
  if(/\?/.test(t) && t.length > P.q) return no('întrebare serioasă');
  if(/\*/.test(t) && (!P.act || t.length > 60)) return no('acțiune în scenă');
  const prev = ch.msgs.slice(0, idx).filter(x => !x.err && (x.role === 'user' || x.role === 'ai'));
  const prevAi = [...prev].reverse().find(x => x.role === 'ai' && x.text);
  if(prevAi && plain(prevAi.text).length > P.prevLong) return no('după un răspuns lung al ei');
  if(prevAi && prevAi.ts && um.ts && um.ts - prevAi.ts > 3 * 36e5) return no('prima după o pauză lungă');
  let k = prev.length - 1, mine = 0; while(k >= 0 && prev[k].role === 'user'){ mine++; k--; }
  if(mine > 1) return no('mai multe mesaje deodată');
  let streak = 0; for(let j = prev.length - 1; j >= 0; j--){ const x = prev[j]; if(x.role !== 'ai') continue; if(x.eco) streak++; else break; }
  if(streak >= P.streak) return no('ancora de stil (rândul lui Sonnet)');
  return {eco:true, why:'simplu'};
}
function fastPace(ch, idx){
  // ultimele tale 3+ răspunsuri au venit la cel mult 4 minute după mesajul ei, la fel și acum
  const ms = ch.msgs.slice(0, idx).filter(x => !x.err && x.ts && (x.role === 'user' || x.role === 'ai'));
  const gaps = []; for(let i = ms.length - 1; i > 0 && gaps.length < 4; i--) if(ms[i].role === 'user' && ms[i - 1].role === 'ai') gaps.push(ms[i].ts - ms[i - 1].ts);
  const lastAi = [...ms].reverse().find(x => x.role === 'ai');
  return gaps.length >= 3 && gaps.every(g => g >= 0 && g < 4 * 60e3) && lastAi && Date.now() - lastAi.ts < 4 * 60e3;
}
function lenHint(um, ch){
  if(S.lenAuto === 'off' || !um || S.len === 'scurt') return '';
  const t = plain(String(um.text || '')).trim(), rp = modeOf(ch) === 'rp';
  if(!t || um.img) return '';
  if(t.length <= 50 && !/\?/.test(t)) return ' (mesajul meu e scurt: răspunde-mi tot scurt, ca pe chat: o frază sau două, uneori doar câteva cuvinte' + (rp ? ', cel mult o acțiune scurtă' : '') + '; mai lung doar dacă momentul chiar o cere)';
  if(t.length <= 140) return ' (răspunde cam cât un mesaj de chat, fără paragrafe lungi, dacă momentul nu cere mai mult)';
  return '';
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
  // 9.31: ritm real: „scrie…” cât ar dura scrisul, apoi mesajul apare întreg (fără text care curge)
  const pace = S.typeReal !== 'off' && !target && !opts.pro && !opts.sched && !opts.cont && opts.tag !== 'apel' && !call && chat === ch, paceSig = busy.signal;
  let typeFrom = Date.now();
  const draw = () => { if(m.rec) return; if(Date.now() >= showAt){ delete m.hold; if(chat === ch) liveUpdate(m); } };
  if(fresh){
    m.hold = true;
    const seenIn = 350 + Math.random() * 500;
    showAt = Date.now() + seenIn + 650; typeFrom = Date.now() + seenIn;
    setTimeout(() => {
      um.seen = true; um.seenAt = um.seenAt || Date.now();
      if(live && live.ch === ch){ live.typing = true; if(chat === ch){ setBusyUI(true); renderMsgs(); } }
    }, seenIn);
    showT = setTimeout(() => { if(m.pending && m.text) draw(); }, seenIn + 660);
  }
  if(pace){ m.hold = true; showAt = Infinity; }
  try{
    // 9.80 (2): după o pauză (cache-ul modelului principal a expirat, deci istoricul se rescrie oricum), mesajele vechi intră
    //           în rezumat și rămân doar ultimele 12: rescrierea și fiecare citire de după costă cam jumătate
    if(!opts.pro && !opts.sched && S.ctxCompact !== 'off' && (!ch.cAt || Date.now() - ch.cAt > (ch.cTtl === '5m' ? 4.5 * 60e3 : 58 * 60e3))) await compactAfterPause(c, ch, idx).catch(() => false);
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
      if(!opts.pro && !opts.sched && !opts.cont && opts.tag !== 'apel' && !call && um) extra += lenHint(um, ch);   // 9.49 (2)
      if(!opts.cont){ const w = await weatherOf(c).catch(() => null);   // 9.80 (3): vremea doar când s-a schimbat sau o dată la 3 ore
        if(w){ const wk = w.city + '|' + wxLine(w); if(ch.wxK !== wk || Date.now() - (ch.wxAt || 0) > 3 * 36e5){ ch.wxK = wk; ch.wxAt = Date.now(); extra += ` (vremea reală la tine în ${w.city} acum: ${wxLine(w)}; ține cont de ea firesc, doar dacă se potrivește, fără să o tot pomenești)`; } } }
      const acts = (lastU.text.match(/\*[^*\n]{2,200}\*/g) || []).map(a => a.slice(1, -1).trim());
      if(acts.length) extra += ` (acțiunile mele de acum, care s-au întâmplat deja exact așa: ${acts.map(a => '„' + a + '”').join(', ')}; pornește de la starea de după ele, nu le contrazice și nu le rescrie, apoi reacționează în felul tău)`;
      { const late = ch.msgs.filter((x, i) => x.role === 'ai' && x.react && x.reactAt && x.reactAt > (ch._callAt || 0) && ch.msgs.slice(i + 1).some(y => y.role === 'user' && (y.ts || 0) < x.reactAt)).slice(-3);
        if(late.length) extra += ` (între timp am reacționat ${late.map(x => `cu ${x.react} la ce ai zis: „${plain(stripMood(stripReact(x.text || ''))).slice(0, 70)}”`).join('; ')})`; }   // 9.16
      const md = extra + (ch.mood && ch.mood.t ? ` (starea ta la ultimul mesaj: ${ch.mood.t}${Date.now() - ch.mood.ts > 3 * 36e5 ? ', acum ' + gapText(Date.now() - ch.mood.ts) : ''})` : '');
      if(opts.liveImg && !lastU.image && !lastU.images) lastU.image = opts.liveImg;   // 8.13: apel video: ce vede acum prin camera ta
      lastU.text = nowNote() + md + ' ' + lastU.text + (ar ? '\n\n' + ar : '') + (opts.fix ? `\n\n(Notă pentru răspunsul ăsta, nu o menționa: ${opts.fix}.)` : '');
    }
    // 9.16: semnătura istoricului trimis (pentru a afla, la o rescriere neașteptată, ce mesaj vechi s-a schimbat)
    const fnv = t => { let h = 2166136261; for(let q = 0; q < t.length; q++){ h ^= t.charCodeAt(q); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
    const sig = ctx.map(x => ({r:x.role, h:fnv(String(x.text || '')), i:!!(x.image || x.images), rt:/\(am reacționat/.test(String(x.text || ''))})), sigN = lastU ? ctx.lastIndexOf(lastU) : ctx.length;
    let meta = {}, full;
    // 9.49 (1): mesaj simplu → modelul mic; regenerarea (↻), mesajele ei din proprie inițiativă, apelurile și pozele rămân pe modelul principal
    const mix = mixLvl(c) !== 'off' && S.aux !== 'off' && !auxBroken && !target && !opts.pro && !opts.sched && !opts.cont && !opts.fix && !opts.three && opts.tag !== 'apel' && !call && !opts.liveImg && !String(S.model || '').toLowerCase().includes('haiku') ? mixPick(um, ch, idx, c) : {eco:false, why:'regenerare / apel / mesaj trimis singur'};   // 9.60
    const eco = mix.eco;
    const solo = !!(opts.pro || opts.sched);         // 9.3: mesaj trimis singur, când lipsești: fără scriere în cache
    // 9.80: cât mai e valabil cache-ul se socotește DOAR din apelurile care chiar l-au scris sau citit (ch.cAt + durata ch.cTtl).
    //       Înainte: mesajele trimise singure (fără cache) și cele pe Haiku „întinereau” cache-ul, iar după o pauză scrierea pe 5 min
    //       expira la următorul răspuns lent → tot istoricul se rescria la 2×, fără motiv vizibil („altceva”).
    const cAt0 = ch.cAt, cTtl0 = ch.cTtl, cLife = ch.cTtl === '5m' ? 4.5 * 60e3 : 58 * 60e3;
    const cold = !ch.cAt || Date.now() - ch.cAt > cLife;
    // după o pauză: 5 min doar dacă de obicei răspunzi repede; altfel 1 oră (altfel fiecare răspuns lent ar rescrie tot)
    const coldFast = cold && fastPace(ch, idx);
    const hist = !eco && ((S.cacheTtl === 'auto' && !cold && fastPace(ch, idx)) || coldFast) ? '5m' : '';
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
    } else full = await stream(sysFor(c, ch), ctx, {max:LEN[S.len].max, signal:busy.signal, cid:c.id, meta, tag:opts.tag, conv:!solo, eco, hist,
      onText: t => { m.text = t;
        // mesaj vocal: textul nu apare pe ecran cât timp „înregistrează”
        if(!m.rec && S.vmsg !== 'off' && /^\s*(?:\[[^\]v][^\]]*\]\s*)?\[v/i.test(t)){ m.rec = m.hold = true; if(live){ live.rec = true; if(chat === ch) setBusyUI(true); } if(chat === ch) renderMsgs(); }
        draw(); }});
    ch._callAt = Date.now(); if(!eco) ch._callAtS = ch._callAt;
    if(!eco && !solo && meta.u){ ch.cAt = Date.now(); ch.cTtl = hist === '5m' || S.cacheTtl === '5m' ? '5m' : '1h'; }   // 9.80: doar apelurile care au scris/citit cache-ul
    if(eco) m.eco = true; else delete m.eco;
    m.mixWhy = mix.why;   // 9.60: de ce a ales modelul (pentru depanare și teste)
    // 9.3: de ce s-a rescris tot istoricul în cache (dacă s-a rescris): pentru Consum
    if(meta.u && !solo && !eco && meta.u.cw > 1500 && meta.u.cr < meta.u.cw){
      let why = cold ? 'pauza' : (why0.from !== undefined && why0.from !== ch._from) ? 'fereastra' : (ch._lastSum !== undefined && why0.sum !== (ch.summary || '')) ? 'rezumat' : (why0.sys && ch._sys && why0.sys !== ch._sys.text) ? 'prompt' : 'altele';
      if(why === 'altele' && Array.isArray(ch._sig)){ const old = ch._sig, lim = Math.min(ch._sigN || old.length, sig.length);
        let k = 0; while(k < lim && old[k].h === sig[k].h && old[k].i === sig[k].i) k++;
        if(k < lim) why = old[k].i !== sig[k].i ? 'altele:poza' : (old[k].rt || sig[k].rt) ? 'altele:reactie' : 'altele:mesaj'; }
      noteRewrite(why, {min:cAt0 ? Math.round((Date.now() - cAt0) / 6e4) : null, ttl:cTtl0 || '', eco:ch.msgs.slice(Math.max(0, idx - 8), idx).filter(x => x.eco).length, cw:meta.u.cw, cr:meta.u.cr});
    }
    if(!eco){ ch._lastFrom = ch._from; ch._lastSum = ch.summary || ''; ch._sig = sig; ch._sigN = sigN; }
    m.text = faraLiniute(full.trim());
    { const sw = [...full.matchAll(SHOW_RE)].pop(); if(sw) m.showIdx = +sw[1]; }   // 9.23: [arăt: N] din apelul video (eticheta se scoate din text)
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
    { delete m.reply; const rq = [...m.text.matchAll(RE_ANY)][0]; if(rq){ m.text = m.text.replace(RE_ANY, '').trim(); const q = findQuoted(ch, idx, rq[1]); if(q) m.reply = q; } }   // 9.31: reply la un mesaj anume
    let rm = m.text.match(AI_REACT);
    if(rm) m.text = m.text.replace(AI_REACT, '').trim();
    if(AI_VOICE.test(m.text)){
      m.text = m.text.replace(AI_VOICE, '').trim();
      if(S.vmsg !== 'off'){ m.voice = true; m.text = m.text.replace(/\*[^*]*\*/g, ' ').replace(/\s{2,}/g, ' ').trim(); }
    } else delete m.voice;
    if(!rm){ rm = m.text.match(AI_REACT); if(rm) m.text = m.text.replace(AI_REACT, '').trim(); }
    if(rm && um && !target){ um.react = rm[1] === '❤' ? '❤️' : rm[1]; if(['❤️', '🥰'].includes(um.react) && chat === ch) setTimeout(() => fxBurst(um.react, 8), 400); }
    if(!m.text) throw new Error('Răspuns gol. Încearcă din nou.');
    if(pace){
      // 9.31: cât i-ar lua să scrie mesajul (din momentul în care a început „scrie…”); uneori se oprește puțin și reia, ca un om care ezită
      let left = typeFrom + typeMs(m) - Date.now();
      const plen = plain(m.text).length;
      if(left > 2600 && !m.voice && Math.random() < (plen > 160 ? .45 : .25)){
        await naps(left * .4, paceSig); left -= left * .4;
        if(!paceSig.aborted && live && live.ch === ch){ live.typing = false; if(chat === ch) setBusyUI(true);
          await naps(700 + Math.random() * 700, paceSig);
          if(live && live.ch === ch){ live.typing = true; if(chat === ch) setBusyUI(true); } }
      }
      if(left > 0 && !paceSig.aborted && chat === ch) await naps(left, paceSig);
    } else {
      const wait = showAt - Date.now();
      if(wait > 0) await sleep(wait);
    }
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
  if(!m.err){ m.am = m.am || {}; m.am[m.alt] = {voice:!!m.voice, cut:m.cut || '', re:m.reply || null, eco:!!m.eco}; }
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
    // 9.39: cererile directe de fotografie din chat declanșează imaginea chiar dacă personajul a răspuns doar în text.
    // Nu depinde de faptul că personajul a promis explicit o poză în replică.
    const directPhotoRequest = canRequestPhoto(c) && !!photoAsk(ch, m);
    if(directPhotoRequest){
      // Cererea explicită are prioritate și nu este clasificată ca fotografie spontană.
      ch.sinceImg = 0;
      setTimeout(() => { if(chat === ch && !busy) askPhoto(false); }, 900);
    }
    else if(canAutoPhoto(c) && (PHOTO_PROMISE.test(m.text) || (ch.nextShot && ch.nextShot.mid === m.id))){
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
      `Ce știe deja ${c.name} despre ${u}:\n${known}\n\nConversația recentă:\n${recent}\n\nScrie lucruri NOI, de patru feluri:
- "fapt": ceva durabil despre ${u}, spus de ${u} însuși (nume, job, oraș, familie, gusturi, lucruri importante povestite);
- "urmează": ceva ce urmează să i se întâmple lui ${u} și despre care merită întrebat mai târziu (un interviu mâine, o discuție cu șeful, un drum, o programare), cu momentul, dacă l-a spus;
- "glumă": o glumă internă, o poreclă sau o expresie care s-a născut între ${c.name} și ${u} și care poate fi reluată;
- "limbaj": un cuvânt, o expresie, un fel de a spune sau o poreclă care ține de felul în care vorbește ${u} sau de limbajul lor (cum îi spune el ei, o expresie pe care o tot folosește), scrisă exact, între ghilimele, și pe scurt cum o folosește.
Fără ce se știe deja, fără ce face doar în scenă, fără presupuneri. Fiecare: o propoziție scurtă, max 14 cuvinte.
Răspunde STRICT cu un array JSON (poate fi gol []): [{"t":"…","tip":"fapt|urmează|glumă|limbaj"}]`}], {max:500, cid:c.id, aux:true});
    const a = out.indexOf('['), b = out.lastIndexOf(']');
    const arr = JSON.parse(out.slice(a, b + 1)).map(x => typeof x === 'string' ? {t:x} : {t:x && x.t, k:x && /urm/i.test(x.tip || '') ? 'urm' : x && /gl/i.test(x.tip || '') ? 'gluma' : x && /lim/i.test(x.tip || '') ? 'lex' : ''})
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
  // 9.17: Haiku 5.5 costă $0,10 / $0,50 (era socotit ca Haiku 4.5, $1 / $5: de 10× prea mult); Fable / Mythos: $10 / $50
  let p = /fable|mythos/.test(m) ? [10, 50] : m.includes('opus') ? [4, 20] : /haiku-5-5/.test(m) ? [.1, .5] : m.includes('haiku') ? [1, 5] : [2, 10];
  const pin = parseFloat(String(S.pIn).replace(',', '.')), pout = parseFloat(String(S.pOut).replace(',', '.'));
  const main = !m.includes('haiku') || String(S.model || '').toLowerCase().includes('haiku');
  if(main){ if(!isNaN(pin)) p[0] = pin; if(!isNaN(pout)) p[1] = pout; }   // prețul tău personalizat e pentru modelul principal
  return p;
}
function imgPrice(){
  if(lastImgProv === 'runware') return rwPer();   // 9.18: media costului real întors de Runware
  if(S.imgProv === 'worker' && S.cfPlan === 'paid'){ const n = neurPerPhoto(lastImgModel || S.wkModel) || 5000; return neurToday >= 10000 ? n * NEUR_USD : 0; }
  return 0;
}
let usageQ = Promise.resolve();
function noteRewrite(why, det){
  usageQ = usageQ.then(async () => {
    const u = await DB.get('usage') || {months:{}, chars:{}}, mo = new Date().toISOString().slice(0, 7);
    const M = u.months[mo] = u.months[mo] || {txt:0, img:0, n:0};
    M.rw = M.rw || {}; M.rw[why] = (M.rw[why] || 0) + 1;
    if(det && /^altele/.test(why)){ M.rwd = (M.rwd || []).concat({...det, ts:Date.now()}).slice(-8); }   // 9.80: detaliile rescrierilor rămase fără cauză
    await DB.set('usage', u);
  }).catch(() => {});
}
// 9.17: sumele deja înregistrate pentru sarcinile pe Haiku 5.5 (fundal, plan și verificare poze) erau de 10× prea mari: le corectăm o dată
async function fixHaikuUsage(){
  if((S.hfix || 0) >= 1) return;
  const aux = String(S.auxModel || AUX_DEF).toLowerCase();
  if(S.aux !== 'off' && /haiku-5-5/.test(aux) && !/haiku/.test(String(S.model || '').toLowerCase())){
    usageQ = usageQ.then(async () => {
      const u = await DB.get('usage'); if(!u || !u.months) return;
      for(const M of Object.values(u.months)){
        if(!M.by || M.hfix) continue;
        let cut = 0;
        for(const k of ['fundal', 'pozeai']) if(M.by[k] > 0){ const d = M.by[k] * .9; M.by[k] -= d; cut += d; }
        M.txt = Math.max(0, (M.txt || 0) - cut); M.hfix = 1;
      }
      await DB.set('usage', u);
    }).catch(() => {});
    await usageQ;
  }
  S.hfix = 1; saveSettings();
}
function addUsage(cid, usd, kind, tok, tag){
  tag = tag || (kind === 'img' ? 'poze' : kind === 'voc' ? 'voce' : 'chat');
  usageQ = usageQ.then(async () => {
    const u = await DB.get('usage') || {months:{}, chars:{}};
    const mo = new Date().toISOString().slice(0, 7);
    const M = u.months[mo] = u.months[mo] || {txt:0, img:0, n:0};
    M.by = M.by || {}; M.by[tag] = (M.by[tag] || 0) + usd;   // 8.17: pe ce se duc banii
    if(kind === 'img'){ M.img += usd; M.n++; } else if(kind === 'voc'){ M.voc = (M.voc || 0) + usd; M.vn = (M.vn || 0) + 1; } else M.txt += usd;
    if(tok){ for(const k of ['inp', 'cw', 'cr', 'out', 'saved']) M[k] = (M[k] || 0) + (tok[k] || 0); M.calls = (M.calls || 0) + 1; if(tok.main) M.mcalls = (M.mcalls || 0) + 1; if(tok.eco){ M.eco = (M.eco || 0) + 1; M.ecoUsd = (M.ecoUsd || 0) + usd; }
      M.tk = M.tk || {}; const T = M.tk[tag] = M.tk[tag] || {inp:0, cw:0, cr:0, out:0, n:0}; for(const k of ['inp', 'cw', 'cr', 'out']) T[k] += tok[k] || 0; T.n++; }
    if(cid) u.chars[cid] = (u.chars[cid] || 0) + usd;
    await DB.set('usage', u);
  }).catch(() => {});
}
function recordTokens(cid, usage, model, tag, mult = 1, turn){
  if(!usage) return;
  model = model || S.model;
  const [pin, pout] = priceFor(model);
  const inp = usage.input_tokens || usage.prompt_tokens || 0, out = usage.output_tokens || usage.completion_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0, cr = usage.cache_read_input_tokens || 0;
  const cw1h = usage.cache_creation ? (usage.cache_creation.ephemeral_1h_input_tokens || 0) : 0, cw5 = cw - cw1h;
  const m = String(model).toLowerCase(), rd = /fable|mythos/.test(m) ? .025 : /(sonnet|opus)-5-5/.test(m) ? .05 : .1;   // prețul citirii din cache diferă pe model
  const usd = (inp * pin + cw5 * pin * 1.25 + cw1h * pin * 2 + cr * pin * rd + out * pout) / 1e6 * mult;
  addUsage(cid, usd, 'txt', {inp, cw, cr, out, saved: cr * pin * (1 - rd) / 1e6 * mult, main: model === modelFor(false) || !!turn, eco: !!turn && model !== modelFor(false)}, tag);
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
    ${M.eco ? `<div class="row2"><span>⚡ Răspunsuri pe Haiku (amestec)</span><span>${M.eco} · ${Math.min(100, Math.round(M.eco / Math.max(1, (((M.tk || {}).chat || {}).n || 0) + (((M.tk || {}).grup || {}).n || 0)) * 100))}% · ${usd(M.ecoUsd || 0)}</span></div>` : ''}
    ${(() => { const by = Object.entries(M.by || {}).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]); if(!by.length) return '';
      { const rest = tot(M) - by.reduce((a, x) => a + x[1], 0); if(rest > .05) by.push(['_rest', rest]); }   // 9.49: ce s-a cheltuit înainte de împărțirea pe categorii
      const mx = Math.max(...by.map(x => x[1]));
      const L = {chat:['💬', 'Conversații'], apel:['📞', 'Apeluri'], poze:['📷', 'Poze în chat'], stories:['📸', 'Stories'], statusuri:['📱', 'Statusuri'], voce:['🎙️', 'Voce'], fundal:['⚙️', 'Fundal (memorie, relație, planuri)'], jurnal:['📔', 'Jurnal'], profil:['🖼️', 'Portrete, avatar, stickere'], pozeai:['🧠', 'Poze: plan și verificare (AI)'], grup:['👥', 'Grupuri'], _rest:['•', 'Neîmpărțit (versiuni vechi, înainte de categorii)'], oameni:['👤', 'Oamenii din viața lor'], retus:['🪄', 'Retușuri']};
      const tk = M.tk || {}, kf = n => n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',') + 'k' : String(Math.round(n));
      const cp = k => { const T = tk[k]; if(!T || !T.n) return ''; const all = T.inp + T.cw + T.cr;
        const rw = k === 'chat' && M.rw ? Object.entries(M.rw).sort((a, b) => b[1] - a[1]) : [];
        const RW = {pauza:'pauză (cache-ul expirase)', fereastra:'fereastra s-a mutat', rezumat:'rezumat nou', prompt:'s-a refăcut fișa personajului', altele:'fără cauză clară', 'altele:poza':'o poză de-a ta mai veche a ieșit din vedere', 'altele:reactie':'reacție pusă pe un mesaj vechi', 'altele:mesaj':'un mesaj vechi s-a schimbat (editat, altă variantă)'};
        const rwd = k === 'chat' && (M.rwd || []).length ? `<br>Fără cauză clară (ultimele): ${M.rwd.slice(-4).map(d => (d.min != null ? d.min + ' min de la cache' : 'fără cache știut') + (d.ttl ? ' (' + d.ttl + ')' : '') + (d.eco ? ', ' + d.eco + ' pe Haiku înainte' : '')).join(' · ')}` : '';   // 9.80
        const rwl = rw.length ? `<br>Rescrieri complete ale istoricului: ${rw.map(([w, n]) => n + ' × ' + (RW[w] || w)).join(' · ')}${rwd}` : '';
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
  const b = (await DB.get(srKey(k)).catch(() => null)) || await DB.get(k); if(!b){ toast('Poza nu mai există.'); return; }   // 9.87: varianta mărită, dacă există
  download(b, picName(k, b));
  toast('Poza se salvează în Descărcări.');
}
function canShareFiles(){
  try{ return !!(navigator.canShare && navigator.canShare({files:[new File([new Blob(['x'], {type:'image/png'})], 'x.png', {type:'image/png'})]})); }catch(e){ return false; }
}
async function shareImage(k){
  const b = (await DB.get(srKey(k)).catch(() => null)) || await DB.get(k); if(!b) return;
  const f = new File([b], picName(k, b), {type:b.type || 'image/jpeg'});
  try{ await navigator.share({files:[f]}); }catch(e){ if(e.name !== 'AbortError') saveImage(k); }
}

/* dictare vocală (recunoașterea vorbirii din browser, română) */
const SpeechRec0 = window.SpeechRecognition || window.webkitSpeechRecognition || null;
// 9.70: fiecare recunoaștere ține minte când a pornit / s-a oprit; pe Android vocea nu pornește cât microfonul e încă deschis
const REC = {on:0, endAt:0};
const SpeechRec = SpeechRec0 && class extends SpeechRec0 {
  start(){ super.start(); this._on = true; REC.on++; const fin = () => { if(this._on){ this._on = false; REC.on = Math.max(0, REC.on - 1); REC.endAt = performance.now(); } }; if(typeof this.addEventListener === 'function'){ this.addEventListener('end', fin); this.addEventListener('error', fin); } else setTimeout(fin, 15000); }
};
const MIC_SVG = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
let rec = null;
function toggleMic(){
  if(rec){ rec.stop(); return; }
  if(!SpeechRec){ toast('Browserul nu suportă dictarea.'); return; }
  try{ ttsCancel(); }catch(e){}
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
/* 9.64: profilul pentru două personaje: câte o fișă pentru fiecare (cine e, cum arată, cum vorbește), relația lor, poza fiecăreia */
function duoCardsHTML(c){
  const f = k => k ? c.duo.b : {name:c.duo.a.name, persona:c.persona, aspect:c.aspect, speech:c.speech};
  const card = k => { const x = f(k);
    return `<div class="duocard d${k}" style="--dc:${DUO_COL[k]}">
      <div class="dctop"><span class="dcav">${duoOne(c, k, true)}</span><b>${esc(x.name || '?')}</b></div>
      ${x.persona ? `<p class="clamp3" data-dcm="${k}">${esc(x.persona)}</p><button type="button" class="more" data-dcmore="${k}" hidden>mai mult</button>` : '<p class="hint">Fără descriere încă.</p>'}
      ${x.aspect ? `<p class="dcl"><b>Cum arată</b> ${esc(x.aspect)}</p>` : ''}
      ${x.speech ? `<p class="dcl"><b>Cum vorbește</b> ${esc(x.speech)}</p>` : ''}
      <div class="btns dcb">${k ? `<button type="button" class="btn sm" data-dcpic>📷 ${c.duo.b.photo ? 'Altă poză' : 'Pune o poză'}</button>${c.duo.b.photo ? '<button type="button" class="btn sm" data-dcdel>✕ Scoate poza</button>' : ''}` : `<button type="button" class="btn sm" data-dcedit>📷 Poza ei (din ✏️)</button>`}</div>
    </div>`; };
  return `<div class="pfSec pfDuo"><h3><span>👯 Ele două</span><button type="button" class="btn sm" data-dcedit>✏️ Editează fișele</button></h3>${c.duo.rel ? `<p class="dcrel">${esc(c.duo.rel)}</p>` : ''}<div class="duocards">${card(0)}${card(1)}</div><input type="file" accept="image/*" id="dcFile" hidden></div>`;
}
function duoCardsWire(c){
  const body = $('#pfBody');
  requestAnimationFrame(() => body.querySelectorAll('[data-dcm]').forEach(p => { const b = body.querySelector(`[data-dcmore="${p.dataset.dcm}"]`); if(b && p.scrollHeight > p.clientHeight + 4){ b.hidden = false; b.onclick = () => { p.classList.remove('clamp3'); b.hidden = true; }; } }));
  body.querySelectorAll('[data-dcedit]').forEach(b => b.onclick = () => openEditor(c.id));
  const pick = body.querySelector('[data-dcpic]'), file = $('#dcFile');
  if(pick) pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0]; file.value = ''; if(!f) return;
    try{ const blob = await toJpeg(f, 1024, .9), old = c.duo.b.photo; c.duo.b.photo = await saveImg(blob); await saveChars(); if(old) await delImg(old).catch(() => {});
      toast('📷 Poza lui ' + c.duo.b.name + ' e pusă'); charProfile(c.id, false); renderHome(); }
    catch(e){ toast('N-am putut citi poza: ' + (e.message || e)); }
  };
  const del = body.querySelector('[data-dcdel]');
  if(del) del.onclick = () => confirmSheet('Scoți poza lui ' + c.duo.b.name + '?', 'Scoate', async () => { const old = c.duo.b.photo; delete c.duo.b.photo; await saveChars(); if(old) await delImg(old).catch(() => {}); charProfile(c.id, false); renderHome(); });
}
// 9.66: câte din ultimele ei răspunsuri au mers pe Haiku
function pfMixStat(chats){
  const ai = chats.flatMap(ch => ch.msgs.filter(m => m.role === 'ai' && !m.err && m.text)).sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-50);
  if(!ai.length) return 'Încă nu a răspuns nimic.';
  const n = ai.filter(m => m.eco).length;
  return `Din ultimele ${ai.length} răspunsuri ale ei: ${n} pe Haiku (${Math.round(n / ai.length * 100)}%).`;
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
    <div class="pfHero">${duoOn(c) ? `<div class="pfDuoHero">${[0, 1].map(k => `<div class="dh">${duoPic(c, k) ? `<img data-k="${esc(duoPic(c, k))}" data-view="${esc(duoPic(c, k))}" alt="">` : `<div class="ph" style="background:${k ? 'linear-gradient(135deg,#2f8fd8,#1c5a8c)' : colorFor(c)}">${esc(duoNm(c, k)[0])}</div>`}</div>`).join('')}</div>` : c.photo ? `<img data-k="${esc(photoNow(c))}" data-view="${esc(photoNow(c))}" alt="">` : `<div class="ph" style="background:${colorFor(c)}">${esc(c.name[0])}</div>`}${c.photoFull ? '<button type="button" class="pfFull" id="pfFullBtn">🧍 Poza întreagă</button>' : c.photo && S.imgProv !== 'none' ? '<button type="button" class="pfFull" id="pfMakeFull">🧍 Fă-i poza întreagă</button>' : ''}</div>
    <div class="igHead">
      <button class="igAv${hasStory ? ' ring' + (storyUn ? ' un' : '') : ''}" id="pfAvBtn" aria-label="${hasStory ? 'Vezi story-ul' : 'Poza de profil'}">${avatarHTML(c)}</button>
      <div class="igStats">
        <div><b>${msgs.toLocaleString('ro-RO')}</b><small>mesaje</small></div>
        <div><b>${days}</b><small>${days === 1 ? 'zi' : 'zile'}</small></div>
        <div><b>${pics.length}</b><small>${pics.length === 1 ? 'poză' : 'poze'}</small></div>
      </div>
    </div>
    <div class="igBio"><h1>${esc(c.name)}</h1>${c.tag ? `<p class="igTag">${esc(c.tag)}</p>` : ''}${duoOn(c) ? '' : c.persona ? `<p class="clamp3" id="pfAbout">${esc(c.persona)}</p><button class="more" id="pfMore" hidden>mai mult</button>` : ''}${pfChips(c)}</div>
    ${duoOn(c) ? duoCardsHTML(c) : ''}
    <div class="igActs">
      <button class="btn pri" id="pfChat">💬 ${fromChat ? 'Înapoi la chat' : 'Mesaj'}</button>
      <button class="btn" id="pfCall" aria-label="Sună">📞</button>
      <button class="btn" id="pfGift" aria-label="Cadou">🎁</button>
      <button class="btn" id="pfPhone" aria-label="Telefonul lui">📱</button>
      <button class="btn" id="pfFav" aria-label="Favorit">${c.fav ? '★' : '☆'}</button>
    </div>
    ${hiDays.length ? `<div class="igHi">${hiDays.map((h, k) => `<button data-hi="${k}"><span><img data-k="${esc(h.items[0].k)}" alt=""></span><small>${esc(hiLabel(h.d))}</small></button>`).join('')}</div>` : ''}
    <div class="pftabs ig" id="pfTabs"><button data-pt="poze"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Poze</button><button data-pt="despre">✨ Despre</button><button data-pt="memorie">🧠 Memorie</button></div>
    <div class="pfSec igGrid"><div class="pfGal">${pics.length ? pics.map(k => `<button data-view="${esc(k)}">${picMeta[k].story ? '<i>📸</i>' : ''}<img data-lk="${esc(k)}" data-t="m" alt="" loading="lazy"></button>`).join('') : ''}</div>${pics.length ? '' : `<p class="igEmpty">📷<br>Încă nicio poză de la ${esc(c.name)}.<br><small>Cere-i una din ＋ în conversație.</small></p>`}</div>
    ${c.aspect && !duoOn(c) ? `<div class="pfSec"><h3>Cum arată</h3><p>${esc(c.aspect)}</p></div>` : ''}
    <div class="pfSec"><h3><span>💞 Relația voastră</span></h3><div class="relbox"><span class="lv" id="pfRelName"></span><small id="pfRelSub"></small><button class="btn sm" id="pfRelSet" style="margin-left:auto">Schimbă</button></div><div class="relbar"><i id="pfRelBar"></i></div><div id="pfBond" class="bond"></div></div>
    <div class="pfSec"><h3><span>📌 Regulile voastre</span><button class="btn sm" id="pfRules">Vezi / adaugă</button></h3><ul class="facts" id="pfRulesL"></ul></div>
    <div class="pfSec"><h3><span>👯 Oameni pe care îi cunoaște</span></h3><div id="pfSoc"></div></div>
    <div class="pfSec" id="pfPrefsSec"><h3>🎯 Ce a învățat din notele tale</h3><ul class="facts" id="pfPrefs"></ul></div>
    <div class="pfSec"><h3><span>📍 Orașul ${esc(c.name)}</span></h3><div class="cityrow"><input id="pfCity" placeholder="ex. Brașov" value="${esc(c.city || '')}" autocomplete="off"><button class="btn sm" id="pfCitySave">Salvează</button></div><p class="hint" id="pfWx">Vremea reală de acolo intră în conversații și în poze (Open-Meteo, gratuit).</p></div>
    <div class="pfSec"><h3><span>🗓️ Ziua ${esc(c.name)}</span></h3><div id="pfLife"></div></div>
    <div class="pfSec"><h3><span>🎂 Viața și planurile</span></h3><div id="pfAgenda"></div></div>
    <div class="pfSec"><h3><span>💝 Amintiri</span></h3><div id="pfMem"></div></div>
    <div class="pfSec"><h3><span>📷 Poze de la ${esc(c.name)}</span></h3><div id="pfPics"></div></div>
    <div class="pfSec"><h3><span>🖼️ Avatar viu</span></h3><div id="pfAv"></div></div>
    <div class="pfSec"><h3><span>😺 Stickere</span></h3><div id="pfStk"></div></div>
    <div class="pfSec" id="pfMixSec"><h3><span>⚡ Amestec Sonnet / Haiku</span></h3>
      <div class="seg pfmix" id="pfMix">${[['', 'Ca în Setări (' + MIX_NAMES[mixGlobal()] + ')'], ['off', 'Doar principal'], ['putin', 'Puțin'], ['echilibrat', 'Echilibrat'], ['mult', 'Mult']].map(([v, l]) => `<button type="button" data-mx="${v}" class="${(c.mix || '') === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
      <p class="hint" id="pfMixStat">${esc(pfMixStat(chats))}</p>
      <p class="hint">Pentru conversațiile unde contează fiecare scenă: „Doar principal” sau „Echilibrat”. Pentru discuții ușoare, de zi cu zi: „Mult”. Emoția, sfaturile și cererile importante rămân pe modelul principal la orice nivel.</p></div>
    <div class="pfSec"><h3>🎙️ Vocea</h3><div class="pfVoice"><span id="pfVName">${esc(voiceLabel(c))}</span><button class="btn sm" id="pfVPlay">▶ Ascultă</button><button class="btn sm" id="pfVPick">Schimbă</button></div></div>
    <div class="pfSec"><h3><span>📔 Jurnal</span></h3><div id="pfJrn"></div>
      <div class="btns jbtn"><button class="btn sm" id="pfJrnToday">✍️ Scrie despre azi</button>${(c.journal || []).length > 3 ? '<button class="btn sm" id="pfJrnAll">Vezi tot</button>' : ''}</div></div>
    <div class="pfSec"><h3><span>🧠 Ce știe despre ${esc(u)} · ${(c.facts || []).length}</span></h3>
      <ul class="facts" id="pfFacts"></ul>
      <div class="addfact"><input id="pfFactIn" placeholder="Adaugă ceva ce să știe"><button class="btn sm" id="pfFactAdd">＋</button><button class="btn sm" id="pfFactScan" title="Caută fapte noi în conversație">🔄</button></div>
    </div>
    <div class="pfFoot">Creat pe ${new Date(c.created || first).toLocaleDateString('ro-RO', {day:'numeric', month:'long', year:'numeric'})} · cost estimat ${usd(spent)}</div>`;
  const body = $('#pfBody');
  if(duoOn(c)) duoCardsWire(c);   // 9.64
  $('#pfMix').onclick = async e => { const b = e.target.closest('[data-mx]'); if(!b) return; const v = b.dataset.mx;   // 9.66
    if(v) c.mix = v; else delete c.mix; await saveChars(); $$('#pfMix button').forEach(x => x.classList.toggle('on', x === b));
    toast('⚡ ' + c.name + ': ' + (v ? MIX_NAMES[v] : 'ca în Setări (' + MIX_NAMES[mixGlobal()] + ')')); };
  hydrate(body);
  // 9.15: grila de poze se încarcă după ce s-a așezat profilul (nu în timpul glisării), din miniaturi
  afterShow(() => { body.querySelectorAll('img[data-lk]').forEach(i => { i.dataset.k = i.dataset.lk; i.removeAttribute('data-lk'); }); hydrate(body); });
  show('vProf', push);
  $('#pfScroll').scrollTop = 0; profScroll();
  const ab = $('#pfAbout'); if(ab) requestAnimationFrame(() => { if(ab.scrollHeight > ab.clientHeight + 4){ $('#pfMore').hidden = false; $('#pfMore').onclick = () => { ab.classList.remove('clamp3'); $('#pfMore').hidden = true; }; } });
  body.onclick = e => { const v = e.target.closest('[data-view]'); if(v) viewImg(v.dataset.view, pics.includes(v.dataset.view) ? pics : [v.dataset.view], picMeta); };
  const drawFacts = () => {
    $('#pfFacts').innerHTML = (c.facts || []).length ? c.facts.map((f, k) => `<li><span>${f.k === 'urm' ? '🗓️ ' : f.k === 'gluma' ? '😄 ' : f.k === 'lex' ? '💬 ' : ''}${esc(f.t)}</span><button data-fx="${k}" aria-label="Șterge">✕</button></li>`).join('')
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
  // 9.74: regulile voastre și oamenii pe care îi cunoaște
  const drawRules = () => { const L = $('#pfRulesL'); if(L) L.innerHTML = (c.rules || []).map(r => `<li><span>📌 ${esc(r.t)}</span></li>`).join('') || '<li><span style="color:var(--tx3)">Nicio regulă. Spune-i în chat „de acum…” sau adaugă una aici.</span></li>'; };
  drawRules(); $('#pfRules').onclick = () => cRulesSheet(c, drawRules);
  const drawSoc = () => { const box = $('#pfSoc'); if(!box) return; box.innerHTML = cSocHTML(c); hydrate(box); box.onclick = e => { const b = e.target.closest('[data-soc]'); if(b){ const o = charById(b.dataset.soc); if(o) cSocEdit(c, o, drawSoc); } }; };
  drawSoc();
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
  $('#pfAvBtn').onclick = () => { if(storyLive().some(x => x.cid === id)) openStories(id); else if(c.photo){ const k = photoNow(c); viewImg(k, [...new Set([k, c.photo])]); } };   // 9.27: poza de acum (avatarul viu), apoi cea de bază
  body.querySelectorAll('[data-hi]').forEach(b => b.onclick = e => { e.stopPropagation(); const h = hiDays[+b.dataset.hi]; openStories(id, h.items.slice().reverse().map(x => ({id:'h' + x.k, cid:id, ts:x.ts, text:'', img:x.k, scene:x.scene}))); });
  $('#pfChat').onclick = () => { if(fromChat) history.back(); else openChat(id); };
  { const fb = $('#pfFullBtn'); if(fb) fb.onclick = e => { e.stopPropagation(); viewFull(c); }; const mf = $('#pfMakeFull'); if(mf) mf.onclick = e => { e.stopPropagation(); pfMakeFull(c); }; }   // 9.24–9.25
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
  if(spont && !rwFor(S.wkChat || S.wkModel) && capLeft() < (neurPerPhoto(S.imgProv === 'worker' ? (S.wkChat || S.wkModel) : undefined) || 5000)) return;   // limita zilnică atinsă: fără poze spontane
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
  const rw0 = rwDay().usd, rwN0 = rwDay().n;   // 9.37: cât a costat poza asta pe Runware (toate generările ei)
  const pT = setInterval(pTick, 120);
  try{
    const promised = !target && spont && ch.nextShot ? ch.nextShot.t : '';      // descrierea scrisă chiar de personaj când a trimis poza
    if(promised) delete ch.nextShot;
    let shot, where = null, asked = [], together = !!(opt.together || (target && target.together)) && !!S.userPhoto;
    const tm = {t0:performance.now(), s:{}};   // 9.86 (g): cronometrul pașilor
    let edited = null, editLog = null, peopleIn = null;
    if(target && mode === 'edit' && opt.edit){   // 9.40: ✏️ Modifică poza
      const E = opt.edit, base = await DB.get(target.img); if(!base) throw new Error('Nu găsesc poza.');
      pstage(busy.signal, '✏️ Înțelege ce schimbi', 20);
      const tr = E.ro ? await editPlan(c, target.scene || '', E.ro, busy.signal) : {en:'', shot:target.scene || fallbackShot(c, ch, m) || 'selfie'};
      asked = tr.en ? [tr.en] : []; where = target.where || null; shot = tr.shot;
      let cx = c;
      if(E.body){   // 9.41: corpul de pe butoane, scris explicit (cu prioritate) și fără reperul de corp vechi, care l-ar întoarce
        const Zb = {body:E.body}, en2 = crBodyEn(Zb), ro2 = crBodyText(Zb);
        cx = {...c, physEn:physWithBody(c.physEn, en2, 'Body'), photoFull:undefined, bodySig:undefined, bodyFull:undefined};
        asked.push('body: ' + en2); shot = `${shot}. Body: ${en2}`;
        if(E.persist){ c.appZones = c.appZones || crEmptyZ(); c.appZones.body = {...E.body}; c.physEn = cx.physEn; c.physUser = physWithBody(c.physUser, ro2, 'corp'); await saveChars(); }
      }
      editLog = {t:E.ro || ('corp: ' + crBodyText({body:E.body || {}})), kind:E.kind, ts:Date.now()};
      if(E.kind !== 'scene' && tr.en){
        edited = await editPhoto(c, base, tr.en, busy.signal, asked, shot);
        const df = await imgDiff(base, edited.blob), miss = edited.check && edited.check.asked != null && edited.check.asked < 7;
        if((df != null && df < .06) || miss){ edited = null; editLog.kind = 'scene'; editLog.auto = true; pstage(busy.signal, '🎬 Editarea n-a schimbat destul, fac poza din nou', 55); }   // aproape aceeași poză   // 9.43: aproape aceeași poză SAU verificarea nu vede schimbarea → poză nouă
      }
      if(!edited){ const r = await makeScenePhoto(cx, shot, busy.signal, {together:false, asked}); edited = r; }
    }
    else if(target && mode === 'same' && target.scene){ shot = target.scene; where = target.where || null; asked = target.asked || []; }
    else { const tS = performance.now(); const pl = await planShot(c, ch, {promised, exclude:m, signal:busy.signal, together}); tm.s.scena = performance.now() - tS; shot = pl.shot; where = pl.where; together = pl.together; asked = pl.asked || []; shot = giftDetail(c, shot, where);
      // 9.56: leagă cererea explicită de expunere din ultimele mesaje de fotografia generată, chiar dacă planificatorul a omis-o.
      const recentPhotoRequest = photoAsk(ch, m);
      const requestedExposure = exposureMode(recentPhotoRequest);
      if(requestedExposure === 'topless') {
        shot = `PRIORITY OUTFIT: clearly adult fictional character is topless, bare breasts uncovered, no shirt, bra or chest covering; lower-body clothing stays as described. Preserve body-reference bust size and natural proportions. Do not substitute a clothed image. Scene: ${shot}`;
        asked.push('topless, bare breasts visibly uncovered, no shirt or bra');
      } else if(requestedExposure === 'explicit') {
        shot = `PRIORITY OUTFIT: clearly adult fictional character is fully nude; visible external adult genital anatomy is requested, anatomically plausible and non-graphic, with no underwear or covering. This is not a sexual act. Preserve body-reference proportions and the exact requested scene, pose, framing and lighting. Generate only if the selected provider permits this content; never bypass a provider block. Scene: ${shot}`;
        asked.push('fully nude adult anatomy, external genital anatomy visible, non-graphic');
      } else if(requestedExposure === 'full') {
        shot = `PRIORITY OUTFIT: clearly adult fictional character is naturally nude in a non-explicit artistic image, no clothing or underwear; no sexual act. Preserve body-reference proportions. Scene: ${shot}`;
        asked.push('natural non-explicit artistic nudity');
      }
      // 9.43: o persoană din viața personajului (prietenă, soră, coleg…): aceeași persoană de fiecare dată, alta decât personajul
      if(pl.people && pl.people.length && S.people !== 'off' && !together){
        const pp = await personFor(c, ch, pl.people[0], busy.signal);
        shot = pl.planned; peopleIn = {names:[pp.name], self:pl.self, pid:pp.id};
        edited = pl.self ? await makeScenePhoto(c, shot, busy.signal, {together:true, partner:pp, asked}) : await otherPhoto(c, pp, shot, busy.signal, asked);
      }
    }
    let {prompt, blob, check, retried, bd, bodyWarn, gen:gdiag} = edited || await makeScenePhoto(c, shot, busy.signal, {together, asked, miss:opt.miss || '', tm});
    if(gdiag && gdiag.tm) gdiag.tm.total = performance.now() - tm.t0;
    try{ if(blob.type === 'image/png') blob = await toJpeg(blob, 2048, .92); }catch(e){}   // PNG → JPEG: de ~5 ori mai puțin spațiu
    let fin = false;
    if(S.photoFinish !== 'off' && (c.stil || 'photo') === 'photo'){ const tFin = performance.now(); const f2 = await photoFinish(blob); if(f2 && f2 !== blob){ blob = f2; fin = true; } if(gdiag && gdiag.tm) gdiag.tm.finisare = performance.now() - tFin; }   // 9.87 (2)
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
    if(peopleIn) m.people = peopleIn; else if(!editLog) delete m.people;
    if(editLog){ m.edits = (m.edits || []).concat(editLog).slice(-10); if(editLog.auto) toast('✏️ Editarea pozei n-a schimbat destul, așa că am făcut-o din nou cu modificarea.', 4000); }   // 9.40
    m.img = k; m.prompt = prompt; m.scene = shot; if(where) m.where = where; if(asked.length) m.asked = asked; else delete m.asked; if(together) m.together = true; else delete m.together; if(check) m.check = check; else delete m.check;
    addUsage(c.id, imgPrice(), 'img');
    if(bd != null) m.bd = Math.round(bd * 1000) / 1000; else delete m.bd;
    if(bodyWarn != null) m.bodyWarn = bodyWarn; else delete m.bodyWarn;   // 9.85 (6)
    if(gdiag){ gdiag.fin = fin; m.gen = gdiag; } else delete m.gen;   // 9.50
    { const day = rwDay(), sp = day.usd - rw0, gn = day.n - rwN0;
      if(sp > 0 && gn > 0){ m.rwCost = Math.round(sp * 1e5) / 1e5; m.rwGens = gn; const P = S.rwPhoto || {n:0, avg:0, gens:0}; P.avg = P.n ? P.avg * .8 + sp * .2 : sp; P.gens = P.n ? P.gens * .8 + gn * .2 : gn; P.n++; S.rwPhoto = P; saveSettings(); } }
    // 9.36: o poză foarte reușită devine reper; personajul fără poză întreagă primește una (o dată, în fundal)
    if(!together){ const okFace = !check || check.face == null || check.face >= 8; const bl = blob;
      setTimeout(async () => { try{ if(okFace && await maybeGoodRef(c, bl)) toast('📌 Poza a ieșit foarte asemănătoare: a devenit reper pentru pozele următoare.', 3500); }catch(e){} await autoFull(c).catch(() => {}); if(await sheetGen(c).catch(() => false)) toast(`🧩 ${c.name} are acum o fișă de identitate (4 unghiuri ale feței). O vezi în profil.`, 4000); if(await bsheetGen(c).catch(() => false)) toast(`🧍 ${c.name} are acum și fișa de corp (¾, profil, așezată).`, 4000); }, 1200); }
    if(S.imgProv === 'worker') setTimeout(() => loadNeurons(lastImgProv !== 'runware'), 1500);   // 9.20: poza a mers pe Runware → fără avertismente Cloudflare
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
// 9.80 (2): rezumatul de după pauză: tot ce e mai vechi de ultimele 12 mesaje intră în rezumat (Haiku), o singură dată pe pauză
const CTX_KEEP = 12;
async function compactAfterPause(c, ch, idx){
  const upTo = idx - CTX_KEEP, from = ch.sumUpTo || 0;
  if(upTo - from < 8 || !aiReady()) return false;           // prea puțin de rezumat: nu merită
  const u = S.userName.trim() || 'utilizatorul';
  const part = ch.msgs.slice(from, upTo).filter(m => (m.text || m.img) && !m.err && m.role !== 'sys').map(m => (m.role === 'user' ? u : c.name) + ': ' + (m.img && !m.text ? '[poză]' : plain(m.text).slice(0, 600))).join('\n');
  if(!part.trim()) return false;
  const s = await stream('Rezumi conversații. Scrii în română, concis, la persoana a III-a.', [{role:'user', text:
`Rezumatul de până acum:\n${ch.summary || '(niciunul)'}\n\nMesaje noi:\n${part.slice(-24000)}\n\nScrie rezumatul actualizat, cel mult 260 de cuvinte: ce s-a întâmplat, fapte importante despre ${u}, promisiuni și planuri, scena sau subiectul la care ați rămas, cum a evoluat relația dintre ${c.name} și ${u}, felul în care vorbiți unul cu altul.`}], {max:800, cid:c.id, aux:true, tag:'fundal'});
  if(!s || !s.trim() || ch.dead) return false;
  ch.summary = s.trim(); ch.sumUpTo = upTo; delete ch.sumNext; delete ch.sumNextTo; ch.compactAt = Date.now();
  await DB.set(chatKey(c.id, ch.tid), ch);
  return true;
}
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
  if(m.img && !me && !busy && S.imgProv !== 'none') opts.push(['✏️', 'Modifică poza', () => setTimeout(() => editPhotoSheet(i), 50)]);   // 9.40
  if(m.img && !me && !busy && S.imgProv !== 'none'){ opts.push(['🎲', 'Altă variantă (aceeași scenă)…', () => setTimeout(() => rejectSheet(m), 60)]); opts.push(['🔄', 'Altă poză (altă scenă)', () => askPhoto(false, m, 'new')]); }
  if(m.img && m.scene && !me) opts.push(['📝', 'Ce scenă a ales', () => openSheet(`<h4>Scena pozei</h4><div class="pad">${m.where ? `<p class="wline">📍 ${esc([m.where.room && m.where.room !== 'other' ? (ROOM_RO[m.where.room] || m.where.room) : m.where.place, m.where.position].filter(Boolean).join(' · '))}${m.where.outfit ? '<br>👗 ' + esc(m.where.outfit) : ''}</p>` : ''}${m.asked && m.asked.length ? `<p class="wline">🙋 Ai cerut: ${esc(m.asked.join(' · '))}</p>` : ''}${m.people ? `<p class="wline">👥 În poză: ${esc(m.people.names.join(', '))}${m.people.self ? ' și ' + esc(cur.name) : ' (fără ' + esc(cur.name) + ')'}</p>` : ''}${(m.edits || []).length ? `<p class="wline">✏️ Modificări: ${esc(m.edits.map(x => x.t).join(' → '))}</p>` : ''}<p style="color:var(--tx2);line-height:1.5">${esc(m.scene)}</p>${m.check ? `<p class="hint">Verificare: ${m.check.d !== undefined ? '🧬 ' + (m.check.d != null ? idPct(m.check.d) + '% · ' + idLabel(m.check.d) : 'fața nu se vede') : 'seamănă ' + m.check.face + '/10'} · scena ${m.check.scene ?? '?'}/10 · încadrarea ${m.check.framing ?? '?'}/10${m.check.hair != null ? ' · părul ' + m.check.hair + '/10' : ''}${m.check.marks != null ? ' · semnele ' + m.check.marks + '/10' : ''}${m.check.body != null ? ' · corpul ' + m.check.body + '/10' : ''}${m.check.bust != null ? ' · bustul față de profil ' + m.check.bust + '/10' : ''}${m.check.asked != null ? ' · ce ai cerut ' + m.check.asked + '/10' + (m.check.missing ? ' (lipsea: ' + esc(m.check.missing.join(', ')) + ')' : '') : ''}${m.check.expr != null ? ' · expresia ' + m.check.expr + '/10' : ''}${m.rwCost ? '<br>💵 Runware: ' + usd4(m.rwCost) + ' (' + m.rwGens + ' ' + (m.rwGens === 1 ? 'generare' : 'generări') + ')' : ''}${m.bd != null ? '<br>🧍 silueta (telefon): ' + Math.max(0, Math.round(100 - m.bd * 250)) + '% față de poza întreagă' : ''}${m.cands && m.cands.length > 1 ? '<br>🎯 aleasă din ' + m.cands.length + ': ' + m.cands.map(d => d == null ? '?' : idPct(d) + '%').join(' · ') : ''}</p>` : ''}${m.gen ? genDiagHTML(m) : ''}</div>`)]);
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
/* ───────── 9.40: ✏️ Modifică poza (ca la Botify) ─────────
   Pe orice poză primită: scrii ce schimbi (ținuta, locul, poziția, expresia, părul, încadrarea, lumina…). Două feluri:
   „✂️ Doar ce scriu”: poza de acum e editată (imaginea 1) cu fața personajului ca reper (imaginea 2); se schimbă doar ce ceri.
   „🎬 Poză nouă cu schimbarea”: descrierea scenei e rescrisă cu schimbarea și poza se face din nou, prin motorul de identitate.
   Rezultatul intră ca variantă nouă a pozei (‹ ›); fața e măsurată în telefon (retuș dacă s-a îndepărtat), iar verificarea
   punctează dacă schimbarea cerută se vede (altfel încă o încercare). Regulile de siguranță ale aplicației rămân aceleași. */
const PE_CHIPS = [['👗 Ținuta', 'poartă '], ['📍 Locul', 'să fie în '], ['🧍 Poziția', 'poziția: '], ['😊 Expresia', 'expresia: '], ['💇 Părul', 'părul: '], ['📸 Încadrarea', 'încadrarea: '], ['🌅 Lumina', 'lumina: ']];
/* 9.41: „Modifică poza” refăcut. În 9.40, „✂️ Doar ce scriu” cerea generatorului să editeze poza păstrând tot „exact”, iar FLUX.2 klein
   întorcea des practic aceeași poză (ca la „Ajustează” în 9.29). Acum: (1) scrii liber ce schimbi și/sau folosești opțiunile din creator
   (ținută, păr, siluetă, bust, înălțime + butoanele de corp); (2) poza se face din nou prin motorul de identitate, cu scena rescrisă
   cu schimbarea și cu corpul nou scris explicit; (3) „Păstrează compoziția” încearcă întâi editarea pozei de acum, iar dacă telefonul
   vede că n-a ieșit aproape nimic diferit (`imgDiff`), trece singur pe poza nouă; (4) corpul schimbat poate rămâne și pentru personaj. */
const bodyOf = c => { const z = c && c.appZones && c.appZones.body ? c.appZones.body : {}; return {...crEmptyZ().body, ...z}; };
const bodySame = (a, b) => Object.keys({...a, ...b}).every(k => String(a[k] || '') === String(b[k] || ''));
async function editPhotoSheet(i){
  const m = chat.msgs[i]; if(!m || !m.img || m.role !== 'ai' || busy) return;
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări.'); return; }
  const c = cur, b0 = await DB.get(m.img).catch(() => null), url = b0 ? URL.createObjectURL(b0) : '';
  const B0 = bodyOf(c), Z = {zones:{}, body:{...B0}};
  openSheet(`<h4>✏️ Modifică poza</h4><div class="pad">
    <div class="pedit">${url ? `<img src="${url}" alt="">` : ''}<div>
      <textarea id="peTxt" rows="3" maxlength="400" placeholder="Scrie liber ce schimbi: ex. rochie roșie scurtă și cercei mari, zâmbește, pe balcon la apus, de aproape"></textarea></div></div>
    <label style="margin-top:8px">Tipul fotografiei</label>
    <div class="chipset" id="peExposure">
      <button type="button" data-exposure="clothed">👗 Îmbrăcată</button>
      <button type="button" data-exposure="topless">🔝 Topless</button>
      <button type="button" data-exposure="artistic-nude">🧍 Nuditate artistică</button>
      <button type="button" data-exposure="explicit-nude">🔞 Nuditate anatomică (adulți)</button>
      <button type="button" data-exposure="intimate">❤️ Poziție intimă</button>
    </div>
    <small style="display:block;color:var(--tx3);margin:4px 0 8px">Selectarea adaugă instrucțiuni clare la regenerare. Rezultatul depinde de modelul și furnizorul de imagini.</small>
    <div class="chipset" id="peChips">${PE_CHIPS.map(([l, q]) => `<button type="button" data-q="${esc(q)}">${esc(l)}</button>`).join('')}</div>
    <div class="chipset adj" id="peAdj">${adjChipsHTML(false)}</div>
    <details class="crzones" id="peBodyW"><summary>🧍 Corpul <small id="peBodySum">siluetă, trunchi, partea de jos, piele</small></summary><div id="peBody"></div></details>
    <label class="chk" id="peKeepW"><input type="checkbox" id="peKeep" checked> Păstrează compoziția pozei (același loc, cadru și poziție, dacă se poate)</label>
    <label class="chk" id="pePersistW" hidden><input type="checkbox" id="pePersist"> 🧍 Corpul nou rămâne pentru ${esc(c.name)} (și în pozele următoare)</label>
    ${(m.edits || []).length ? `<div class="chipset" id="peLast"><small style="width:100%;color:var(--tx3)">Ultimele modificări:</small>${m.edits.slice(-3).reverse().map(x => `<button type="button" data-l="${esc(x.t)}">↺ ${esc(x.t.slice(0, 40))}</button>`).join('')}</div>` : ''}
    <div class="btns"><button class="btn pri" id="peGo">✏️ Modifică</button></div></div>`);
  const sync = () => {   // 9.86: editorul de corp pe grupuri, cu ce schimbi
    const n = bodyChanges(B0, Z.body).length, ch = n > 0; $('#pePersistW').hidden = !ch;
    $('#peBodySum').textContent = ch ? `✏️ ${n} ${n === 1 ? 'schimbare' : 'schimbări'}` : 'siluetă, trunchi, partea de jos, piele';
    $('#peKeepW').style.opacity = ch ? '.5' : ''; $('#peKeep').disabled = ch;   // corp schimbat: poza se face din nou
  };
  const drawB = bodyEdBind($('#peBody'), Z.body, B0, sync, 'peH');
  drawB(); sync();
  $('#peExposure').onclick = e => {
    const bt = e.target.closest('[data-exposure]'); if(!bt) return;
    $('#peExposure').querySelectorAll('[data-exposure]').forEach(x => x.classList.toggle('on', x === bt));
    const instructions = {
      clothed: 'Keep the character fully clothed in an ordinary outfit; no nudity.',
      topless: 'The clearly adult fictional character is topless: bare breasts uncovered, no shirt or bra; keep lower-body clothing exactly as described. Preserve the body reference proportions and bust size.',
      'artistic-nude': 'The clearly adult fictional character is naturally nude in a non-explicit artistic image; no sexual act. Preserve the body reference proportions and bust size. Use only if allowed by the selected image provider.',
      'explicit-nude': 'The fictional character is clearly an adult (18+), fully nude, with visible external genital anatomy; anatomically plausible and non-graphic, no sexual act. Preserve identity, body proportions, pose and scene. Generate only if the selected image provider explicitly permits this content; do not bypass provider moderation.',
      intimate: 'The clearly adult fictional character is in a consensual, sensual intimate pose (for example close embrace, kissing, cuddling or reclining close); keep it non-graphic and use only within the selected image provider’s rules.'
    };
    const t = $('#peTxt'); t.value = (t.value.trim() ? t.value.trim() + '; ' : '') + instructions[bt.dataset.exposure];
    t.focus();
  };
  $('#peChips').onclick = e => { const bt = e.target.closest('[data-q]'); if(!bt) return; const t = $('#peTxt'); t.value = (t.value.trim() ? t.value.trim() + '; ' : '') + bt.dataset.q; t.focus(); };
  $('#peAdj').onclick = e => {
    const bt = e.target.closest('[data-adj]'); if(!bt) return; const v = bt.dataset.adj, op = CR_ADJ_OPS.find(x => x[0] === v);
    if(op){ op[1](Z); $('#peBodyW').open = true; drawB(); sync(); toast('🧍 ' + bt.textContent.trim() + ': schimbat la Corpul', 1800); return; }   // corpul: pe butoane, exact
    const t = $('#peTxt'); t.value = (t.value.trim() ? t.value.trim() + '; ' : '') + v; bt.classList.add('on');
  };
  if($('#peLast')) $('#peLast').onclick = e => { const bt = e.target.closest('[data-l]'); if(bt) $('#peTxt').value = bt.dataset.l; };
  $('#peGo').onclick = () => {
    const ro = $('#peTxt').value.trim().replace(/[;:\s]+$/, ''), bodyCh = !bodySame(Z.body, B0);
    if(ro.length < 3 && !bodyCh){ toast('Scrie ce schimbi sau alege o opțiune.'); return; }
    if(CR_MINOR.test(ro)){ toast('Personajele din Taifas sunt adulte.'); return; }
    const E = {ro, kind: bodyCh || !$('#peKeep').checked ? 'scene' : 'edit', body: bodyCh ? {...Z.body} : null, persist: bodyCh && $('#pePersist').checked};
    closeSheet(); if(url) URL.revokeObjectURL(url);
    askPhoto(false, m, 'edit', {edit:E});
  };
}
// cât de diferite sunt două poze (0 = identice; ~0,02 = aproape la fel; 0,08+ = schimbare clară), măsurat pe 48×64, în telefon
async function imgDiff(a, b){
  const px = async bl => { const u = URL.createObjectURL(bl); try{ const im = await loadImgEl(u), cv = document.createElement('canvas'); cv.width = 48; cv.height = 64; const g = cv.getContext('2d'); g.drawImage(im, 0, 0, 48, 64); return g.getImageData(0, 0, 48, 64).data; } finally { URL.revokeObjectURL(u); } };
  try{ const x = await px(a), y = await px(b); let d = 0; for(let i = 0; i < x.length; i += 4) d += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]); return d / (x.length / 4 * 3 * 255); }
  catch(e){ return null; }
}
// corpul nou, scris peste „Cum arată” (EN pentru generator, RO pentru profil)
const physWithBody = (txt, line, lead) => { const t = String(txt || '').replace(new RegExp('(^|[.;]\\s*)' + lead + ':[^.;]*[.;]?\\s*', 'i'), '$1').trim(); return (lead + ': ' + line + (t ? (lead === 'Body' ? '. ' : '; ') + t : '')).slice(0, 700); };
// cererea (română) → instrucțiunea în engleză + descrierea scenei rescrisă cu schimbarea
async function editPlan(c, scene, ro, signal){
  try{
    const j = await crAskJSON('You turn photo-change requests into English for an image generator. Answer with JSON only.',
`Current photo description: "${String(scene || '(not available)').slice(0, 900)}"
The user wants this change (Romanian): "${ro}"
Return JSON: {"en":"the change as one short, precise English instruction, keeping every detail the user gave (colors, items, place, pose, expression)","shot":"the full photo description rewritten with the change applied and everything else kept the same, 50-90 words"}`, 700);
    const en = String(j.en || '').trim(), shot = String(j.shot || '').trim();
    if(en) return {en:en.slice(0, 400), shot:(shot || [scene, en].filter(Boolean).join('. ')).slice(0, 1200)};
  }catch(e){ if(e.name === 'AbortError') throw e; }
  return {en:ro, shot:[scene, ro].filter(Boolean).join('. ')};
}
async function imgSize(blob){
  const u = URL.createObjectURL(blob);
  try{ const im = await loadImgEl(u), k = 1024 / Math.max(im.naturalWidth, im.naturalHeight), r = v => Math.max(256, Math.round(v * k / 16) * 16); return r(im.naturalWidth) + 'x' + r(im.naturalHeight); }
  catch(e){ return S.wkSize || '768x1024'; } finally { URL.revokeObjectURL(u); }
}
async function editPhoto(c, base, en, signal, asked, shot){
  pstage(signal, '✏️ Modifică poza', 40);
  let R = null; try{ R = c.photo ? await idRefs(c) : null; }catch(e){}
  const st = c.stil || 'photo', size = await imgSize(base), model = S.wkChat || 'ancorat';
  const mk = fix => {
    const p2 = `${stilLead(st)}Edit image 1. Required change, clearly visible in the result: ${en}.${fix ? ' Make sure: ' + fix + '.' : ''} Image 2 shows the face of this same person: keep that face and identity (face shape, eyes, nose, lips, skin, age). Keep the same place and camera angle where possible. ${STIL_TAG[st]}`;
    const p1 = `${stilLead(st)}Edit this photo. Required change, clearly visible in the result: ${en}.${fix ? ' Make sure: ' + fix + '.' : ''} Keep the same person (same face and identity) and, where possible, the same place and camera angle. ${STIL_TAG[st]}`;
    return {p2, p1};
  };
  const gen = async fix => {
    if(useF3()){   // 9.43: FLUX 3 e făcut pentru editări: țintă + stare finală + ce rămâne neschimbat (după ghidul lor)
      const p3 = `${stilLead(st)}Change only this in image 1: ${en}.${fix ? ' Make sure: ' + fix + '.' : ''} Keep her face exactly as in image 2 (face shape, eyes, nose, lips, skin tone and texture), and keep everything else in image 1 unchanged: her body and proportions, the other clothes, the room, the pose, the framing and the lighting. ${STIL_TAG[st]}`;
      return {prompt:p3, blob:await f3Image(p3, [base, R && R.face], size, signal)};
    }
    const {p2, p1} = mk(fix); return {prompt:p2, blob:await genImage(p2, base, signal, R && R.face, {model, force:{two:!!(R && R.face), px:1024}, px1:1024, size, p1, why:'editare'})}; };
  const polish = async x => {   // fața: dacă s-a îndepărtat de personaj, retușul obișnuit (doar dacă iese mai aproape)
    if(!c.photo || st !== 'photo' || useF3()) return x;
    const lf = await localFace(x.blob, c); x.fd = lf.d;
    if(lf.d != null && lf.d > ID_MAX){ try{ const r = await retouchBest(c, x.blob, signal, model, shot, 'retus'); if(r && r.used){ x.blob = r.blob; x.fd = r.d; } }catch(e){ if(e.name === 'AbortError') throw e; } }
    return x;
  };
  let a = await polish(await gen(''));
  if(S.imgCheck === 'off' || !aiReady()) return a;
  try{ a.check = await checkPhoto(c, a.blob, shot, signal, false, asked); }catch(e){ if(e.name === 'AbortError') throw e; return a; }
  if(!(a.check && a.check.asked != null && a.check.asked < 7)) return a;
  let b; try{ b = await polish(await gen((a.check.missing || []).join(', ') || en)); b.check = await checkPhoto(c, b.blob, shot, signal, false, asked); }catch(e){ if(e.name === 'AbortError') throw e; return a; }
  const sc = x => x && x.check ? (x.check.asked ?? 5) * 2 + (x.check.face ?? 5) + (x.check.body ?? 6) * .6 : 0;
  const best = sc(b) > sc(a) ? b : a; best.retried = true; return best;
}
/* ───────── 9.43: 👥 oamenii din viața personajului ─────────
   Când ceri o poză cu cineva despre care vorbește personajul (sora, o prietenă, un coleg), planificatorul o spune („people”, „self”).
   Persoana primește o fișă a ei (c.people): aspect inventat o dată, coerent cu ce s-a spus în conversație și CLAR diferit de
   personaj, plus un portret făcut o dată, care devine reperul ei; data viitoare e aceeași persoană. Dacă e un alt personaj din
   aplicație (după nume), se folosește poza lui. Telefonul verifică să nu semene cu personajul (altfel o reface). Doar adulți,
   îmbrăcați, poze obișnuite. Fișele se văd și se șterg din profil (👥). */
const pnorm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
async function personFor(c, ch, p, signal){
  const nm = pnorm(p.name), rl = pnorm(p.relation);
  const app = nm && chars.find(x => x.id !== c.id && pnorm(x.name) === nm && x.photo);
  if(app){ const b = await DB.get(app.photo).catch(() => null); if(b){ let box = null; try{ const id2 = await identityOf(app); box = id2 && !id2.none ? id2 : null; }catch(e){} return {id:'app:' + app.id, name:app.name, blob:b, box, desc:app.physEn || app.look || ''}; } }
  c.people = c.people || [];
  let rec = c.people.find(x => (nm && pnorm(x.name) === nm) || (!nm && rl && pnorm(x.relation) === rl) || (nm && rl && !x.name && pnorm(x.relation) === rl));
  if(rec && rec.img){ const b = await DB.get(rec.img).catch(() => null); if(b){ if(nm && !rec.name){ rec.name = p.name; saveChars(); } return {id:rec.id, name:rec.name || rec.relation, blob:b, box:rec.box || null, desc:rec.desc}; } }
  if(CR_MINOR.test(p.relation + ' ' + p.look + ' ' + p.name)) throw new Error('Nu fac poze cu minori.');
  pstage(signal, '👥 Își amintește cum arată ' + (p.name || p.relation || 'persoana'), 30);
  const u = S.userName.trim() || 'utilizatorul', recent = ch.msgs.filter(x => x.text && !x.err).slice(-30).map(x => (x.role === 'user' ? u : c.name) + ': ' + plain(x.text).slice(0, 300)).join('\n');
  let j = {};
  try{ j = await crAskJSON('You design the look of a secondary person in a story, for an image generator. Answer with JSON only.',
`Main character: ${c.name}. Her/his look (the new person must look CLEARLY DIFFERENT: different face shape, different hair color or texture, different features): ${(c.physEn || c.look || '').slice(0, 500)}
The person to design: ${p.name || '(no name)'}${p.relation ? ', ' + p.relation : ''}. What the conversation says about their look: ${p.look || 'nothing'}.
Conversation (Romanian):
${recent.slice(-3000)}
Keep everything the conversation says; invent the rest, plausible for the relation and the character's world. The person must be an adult (18+); if the conversation clearly says it is a child, set "age" to that age.
JSON: {"name":"the name (or a fitting Romanian first name if none)","gender":"woman|man","age":30,"look":"English, 40-70 words: apparent age, face shape, eyes, nose, lips, skin tone, hair (color, length, texture, style), build and height, usual clothing style","ro":"the same in Romanian, max 30 words"}`, 700); }
  catch(e){ if(e.name === 'AbortError') throw e; }
  const age = Math.round(+j.age || 30);
  if(age < 18 || CR_MINOR.test(String(j.look || '') + ' ' + String(j.ro || ''))) throw new Error('Nu fac poze cu minori.');
  const name = String(p.name || j.name || p.relation || 'persoana').trim().slice(0, 40);
  const desc = faraLiniute(String(j.look || p.look || `an adult ${j.gender || 'person'}`).trim()).slice(0, 600);
  pstage(signal, '👥 Îi face portretul lui ' + name + ' (o singură dată)', 45);
  const pp = `Head and shoulders portrait photo of ${name}, ${desc}. Clearly an adult. Looking at the camera, natural relaxed expression, plain softly lit indoor background, real unedited smartphone photo, natural skin texture. ${STIL_TAG[c.stil || 'photo']}`;
  const gen1 = async extra => useF3() ? await f3Image(pp + extra, [], '768x1024', signal, 'quiet') : await genImage(pp + extra, null, signal, null, {model:S.wkChat || 'ancorat', size:'768x1024', quiet:true, why:'oameni'});
  let b = await gen1(''); addUsage(c.id, imgPrice(), 'img', null, 'oameni');
  const tooClose = async bl => { const d = (await localFace(bl, c)).d; return d != null && d < .5; };
  if(await tooClose(b)){ b = await gen1(` This person must look clearly different from ${c.name}: a different face shape, different eyes and nose, different hair.`); addUsage(c.id, imgPrice(), 'img', null, 'oameni'); }
  try{ if(b.type === 'image/png') b = await toJpeg(b, 1024, .9); }catch(e){}
  let box = null; try{ const fs = await faceDescs(b); if(fs.length){ const f = fs.sort((x, y) => y.a - x.a)[0]; box = {x:f.box.x / f.W, y:f.box.y / f.H, w:f.box.w / f.W, h:f.box.h / f.H}; } }catch(e){}
  const img = await saveImg(b);
  if(rec){ rec.img = img; rec.desc = desc; rec.box = box; if(j.ro) rec.ro = faraLiniute(String(j.ro)).slice(0, 220); }
  else { rec = {id:uid(), name, relation:p.relation || '', desc, ro:faraLiniute(String(j.ro || '')).slice(0, 220), img, box, ts:Date.now()}; c.people.push(rec); }
  while(c.people.length > 12){ const old = c.people.shift(); if(old.img) delImg(old.img).catch(() => {}); }
  await saveChars();
  return {id:rec.id, name:rec.name, blob:b, box, desc};
}
// poza doar cu cealaltă persoană (fără personaj): portretul ei e reperul feței; verificare că nu seamănă cu personajul
async function otherPhoto(c, pp, shot, signal, asked){
  const st = c.stil || 'photo', fr = framingOf(shot), face = await cropFace(pp.blob, pp.box || null);
  const prompt = `${stilLead(st)}${asked && asked.length ? `REQUESTED, must be clearly visible: ${asked.join('; ')}. ` : ''}${stilFrame(st, fr.p)}. ${shot}. The reference image is a close-up of ${pp.name}'s face: keep exactly this face and identity. ${pp.name}: ${pp.desc}. This photo shows ${pp.name}, not ${c.name}. An adult, fully clothed, ordinary everyday photo. ${STIL_TAG[st]}`;
  const gen = async extra => useF3() ? await f3Image(prompt + extra, [face], S.wkSize, signal) : await genImage(prompt + extra, face, signal, null, {model:S.wkChat || 'ancorat', force:{two:false, px:512}, p1:prompt + extra, why:'oameni'});
  let blob = await gen('');
  const d = (await localFace(blob, c)).d;
  if(d != null && d < .45){ pstage(signal, '👥 Semăna cu ' + c.name + ', o reface', 80); blob = await gen(` ${pp.name} looks clearly different from ${c.name}.`); addUsage(c.id, imgPrice(), 'img', null, 'oameni'); }
  return {prompt, blob};
}
function drawPeople(c, box){
  const list = c.people || []; if(!list.length || !box) return;
  box.insertAdjacentHTML('beforeend', `<div class="refbox"><b>👥 Oamenii din viața lui ${esc(c.name)}</b><small>Aspectul lor e inventat o dată, din conversație, și rămâne același în poze. Le poți refăcea portretul sau îi poți șterge.</small>
    <div class="ppl">${list.map(x => `<div class="pplr" data-pid="${esc(x.id)}"><img data-k="${esc(x.img || '')}" data-t="s" alt=""><div><b>${esc(x.name || x.relation)}</b><small>${esc([x.relation, x.ro].filter(Boolean).join(' · '))}</small></div><button type="button" class="btn sm" data-pre="${esc(x.id)}">↻</button><button type="button" class="btn sm" data-pdel="${esc(x.id)}">✕</button></div>`).join('')}</div></div>`);
  const el = box.lastElementChild; hydrate(el);
  el.onclick = async e => {
    const del = e.target.closest('[data-pdel]'), re = e.target.closest('[data-pre]'); if(!del && !re) return;
    const id = (del || re).dataset[del ? 'pdel' : 'pre'], i = c.people.findIndex(x => x.id === id); if(i < 0) return;
    const x = c.people[i];
    if(del){ c.people.splice(i, 1); if(x.img) delImg(x.img).catch(() => {}); await saveChars(); el.remove(); drawPeople(c, box); return; }
    if(x.img) delImg(x.img).catch(() => {}); delete x.img; re.disabled = true; re.innerHTML = '<span class="spin"></span>';
    try{ await personFor(c, chat || {msgs:[]}, {name:x.name, relation:x.relation, look:''}, null); toast('↻ Portret nou pentru ' + (x.name || x.relation)); }catch(err){ toast(err.message, 3500); }
    el.remove(); drawPeople(c, box);
  };
}
function rephotoMenu(i){
  const m = chat.msgs[i]; if(!m || busy) return;
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări.'); return; }
  sheet([['✏️', 'Modifică poza (scrii ce schimbi)', () => setTimeout(() => editPhotoSheet(i), 50)], ['🎲', 'Altă variantă, aceeași scenă…', () => setTimeout(() => rejectSheet(m), 60)], ['🔄', 'Altă poză, altă scenă', () => askPhoto(false, m, 'new')]]);
}
// trecerea între alternative: fiecare își păstrează felul ei (vocal / tăiat)
function setAlt(m, k){
  m.alt = Math.max(0, Math.min(m.alts.length - 1, k)); m.text = m.alts[m.alt]; delete m.err;
  const a = (m.am || {})[m.alt];
  if(a){ if(a.voice) m.voice = true; else delete m.voice; if(a.cut) m.cut = a.cut; else delete m.cut; }
  if(m.role === 'ai'){ if(a && a.re) m.reply = a.re; else delete m.reply; }   // 9.31: citatul ține de varianta aleasă
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
    modeOf(chat) === 'chat' ? ['🎭', 'Treci pe roleplay (*acțiuni*, scenă împreună)', toggleMode] : ['💬', 'Treci pe chat pe telefon (doar mesaje)', toggleMode],
    ['⏰', (() => { const k = (cur.sched || []).filter(x => x.tid === (chat.tid || 'main')).length; return k ? `Mesaje programate (${k})` : 'Mesaje programate'; })(), schedSheet],
    ['📖', 'Albumul vostru', () => openAlbum(cur)],
    ['📱', `Telefonul lui ${cur.name}`, () => openPhone(cur)],
    ['📌', 'Regulile voastre' + ((cur.rules || []).length ? ' · ' + cur.rules.length : ''), () => setTimeout(() => cRulesSheet(cur), 60)],   // 9.74
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
  wkFetch('/push/at', {method:'POST', body:safeJSON({id, at, title, body, url:'./?go=' + encodeURIComponent(go || 'last')})}).catch(e => console.warn('push', e.message));
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
// 9.62: cum se vorbește la telefon (nu ca un mesaj scris)
const CALL_SPOKEN = u => `Vorbiți în timp real. Scrii doar ce spui cu voce tare: de obicei 1-2 propoziții scurte, uneori doar câteva cuvinte („serios?”, „stai, cum adică?”, „mhm, și?”); mai mult doar când chiar povestești ceva. Sună vorbit, nu scris: română colocvială („păi”, „adică”, „na”, „auzi”, „stai puțin”), propoziții simple, uneori reluate sau lăsate neterminate („mă rog, nu contează”), fără enumerări, paranteze, ghilimele sau formule de mesaj scris; numerele le scrii cum le spui. Reacționezi întâi la ce ai auzit, apoi spui ce ai de spus; nu încheia mereu cu o întrebare. Ce spune ${u} vine din recunoașterea vocii: dacă un cuvânt pare auzit greșit, înțelege ce a vrut să zică; dacă nu se înțelege deloc, întreabă scurt, ca la telefon („stai, n-am prins, ce-ai zis?”). Dacă replica ta de dinainte se termină cu „…”, te-a întrerupt: nu o relua de la capăt, răspunde la ce a zis el. Când e firesc, poți pomeni scurt ce se aude sau ce se întâmplă în jurul tău. Fără *acțiuni*, fără emoji și fără [vocal]; un râs scurt îl scrii ca vorbă („haha”)`;
const CALL_FIX = u => `ești într-un apel vocal la telefon cu ${u}. ` + CALL_SPOKEN(u);
// 8.13: apel video: vă vedeți. Dacă primește un cadru din camera lui, îl vede ca într-un apel adevărat
const CALL_FIX_V = u => `ești într-un apel video cu ${u}, vă vedeți pe ecran. ` + CALL_SPOKEN(u) + `. Dacă primești o imagine, e ce vezi chiar acum prin camera lui: poți reacționa firesc la ce vezi (unde e, lumina, ce face, expresia lui), în treacăt, fără s-o descrii ca pe o poză și fără comentarii despre corpul lui`;
const callFix = c => (c && c.video ? CALL_FIX_V : CALL_FIX)(S.userName.trim() || 'el') + showNote(c) + (c && c.video && c.exprReady ? '. Începe fiecare replică cu expresia feței tale de acum, exact așa: [față: zâmbet], [față: râs], [față: surpriză], [față: gânditoare], [față: tristă] sau [față: neutră]' : '');
const ICO = {
  mic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  cam:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/></svg>',
  flip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11a4 4 0 0 1 4 4v1M20 17H9a4 4 0 0 1-4-4v-1"/><path d="m17 9 2 3 2-3M7 15l-2-3-2 3"/></svg>',
  eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  end:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-3.3 0-6.3 1-8.5 2.7-.6.5-.7 1.4-.2 2l1.5 1.8c.4.5 1.2.6 1.8.3l2-1.2c.4-.3.6-.7.6-1.2v-1.6c1.8-.5 3.8-.5 5.6 0v1.6c0 .5.2.9.6 1.2l2 1.2c.6.3 1.4.2 1.8-.3l1.5-1.8c.5-.6.4-1.5-.2-2C18.3 10 15.3 9 12 9z"/></svg>'
};
function callChoice(){
  if(duoOn(cur)){ toast('Apelurile nu merg încă la două personaje în același chat.', 3500); return; }   // 9.63
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
  // 9.23: contextul audio pornește acum (din atingere), ca sunetul camerei ei și respirațiile să poată suna mai târziu
  try{ const pre = window.__acPre; window.__acPre = null; call.ac = pre && pre.state !== 'closed' ? pre : new (window.AudioContext || window.webkitAudioContext)(); if(call.ac.resume) call.ac.resume().catch(() => {}); }catch(e){ call.ac = null; }
  const lf = lifeNow(cur);
  const v = document.createElement('div'); v.className = 'callv' + (video ? ' vid' : '');
  v.innerHTML = `<div class="cbg" ${cur.photo ? `data-bgk="${esc(photoNow(cur))}"` : ''}></div>
    ${pics.length ? `<div class="cvid">${pics.map((k, i) => `<img data-k="${esc(k)}" data-ik="${esc(k)}" class="${i ? '' : 'on'}" alt="">`).join('')}<i class="cgrain"></i></div>` : ''}
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
  const setVideo = on => { c.video = on; v.classList.toggle('vid', on); const b = $('#clVid'); if(b) b.classList.toggle('off', on); if(on){ camOn(); if(c.t0) rigStart(c); } else { camOff(); showHide(c, true); } poke(); };
  const vb = $('#clVid'); if(vb) vb.onclick = () => { if(call === c) setVideo(!c.video); };
  $('#clFlip').onclick = () => { c.facing = c.facing === 'user' ? 'environment' : 'user'; camOn(); };
  $('#clSee').onclick = () => { c.see = !c.see; S.callSee = c.see ? 'on' : 'off'; saveSettings(); $('#clSee').classList.toggle('off', c.see); toast(c.see ? `👁️ ${c.c.name} te vede` : `🙈 ${c.c.name} nu te mai vede (doar te aude)`); };
  $('#clBarge').onclick = () => { c.barge = !c.barge; S.callBarge = c.barge ? 'on' : 'off'; saveSettings(); $('#clBarge').classList.toggle('off', c.barge); toast(c.barge ? (IS_ANDROID ? '✋ O poți întrerupe vorbind peste ea. Dacă vocea ei nu se mai aude (mai ales cu căști Bluetooth), oprește-l la loc.' : '✋ O poți întrerupe vorbind peste ea') : 'Întreruperile vocale sunt oprite (atingerea subtitrării încă merge)', 3000); if(!c.barge && c.bargeRec){ try{ c.bargeRec.abort(); }catch(e){} } };
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
  // 9.81: gura și clipitul din cadre reale, pregătite o dată pentru imaginea de bază (în fundal; apelul merge între timp)
  if(pics.length && video && S.callSprites !== 'off' && S.imgProv !== 'none') setTimeout(() => { if(call !== c) return; const k0 = pics[0]; if(c.c.vfs && c.c.vfs[k0]) return;
    sprGen(c.c, k0, () => { if(call !== c || !c.vf) return; const im = $('.callv .cvid img.on'); if(im && im.dataset.ik === k0) vfSwitch(c, im); toast('👄 Gura și clipitul ei sunt acum din cadre reale'); }); }, 8000);
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
    // 9.23: sunetul camerei ei, lumina ei, telefonul în mâna ei, prezența ta
    litUpdate(c).then(() => { if(call === c) ambStart(c); }); c.litT = setInterval(() => litUpdate(c), 120e3);
    if(c.video) rigStart(c);
    presStart(c);
    c.tick = setInterval(() => { if(call !== c) return; const s = Math.floor((Date.now() - c.t0) / 1000), t = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); $('#clTime').textContent = t; $('#clTimeV').textContent = t; }, 500);
    poke();
    const u = S.userName.trim() || 'el';
    callReply({pro:true, note: c.incoming
      ? `(Notă de regie, nu o menționa ca atare: TU l-ai sunat pe ${u} ${c.video ? 'pe video' : 'pe telefon'} și el tocmai a răspuns. Începe tu: salută-l și spune firesc de ce suni${opts.reason ? ' („' + opts.reason + '”)' : ' (ți-era dor să-i auzi vocea, ai ceva să-i povestești sau ai o întrebare, după ce faci acum)'}. ${callFix(c)}.)`
      : `(Notă de regie, nu o menționa ca atare: ${u} te sună acum ${c.video ? 'pe video' : 'pe telefon'} și tu răspunzi. Salută-l scurt, în felul tău și după ce faci acum. ${callFix(c)}.)`});
  }, c.incoming ? 700 : 2600 + Math.random() * 2400);
}
function callState(t, cls){ const el = $('#clState'); if(el){ el.textContent = t; el.className = cls || ''; } const v = $('.callv'); if(v) v.dataset.st = cls || ''; if(call) ambLevel(call, cls === 'listen' ? .7 : 1); }
function endCall(){
  if(!call) return;
  const c = call;
  call = null; c.alive = false; clearInterval(c.tick); clearInterval(c.picT); window.__talk = null; ringback(false); callWake(c, false); vfStop(c);
  try{ c.bargeRec && c.bargeRec.abort(); }catch(e){} clearInterval(c.pollT); clearInterval(c.watchT); clearTimeout(c.exT);
  // 9.23
  ambStop(c); clearInterval(c.litT); clearInterval(c.presT); showHide(c, true); if(c.rig){ cancelAnimationFrame(c.rig.raf); c.rig = null; }
  if(c.ac){ const ac = c.ac; setTimeout(() => { try{ ac.close(); }catch(e){} }, 900); }
  if(c.cam){ try{ c.cam.getTracks().forEach(t => t.stop()); }catch(e){} }
  try{ c.rec && c.rec.abort(); }catch(e){}
  try{ ttsCancel(); }catch(e){}
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
// 9.23: vocea cu emoție (`callProso`): ton, viteză și volum după starea ei, propoziție și oră; frazele lungi în două bucăți, cu pauză reală
function callSay(c, text, capOff){
  // 9.69: bucăți de cel mult ~170 de caractere, vocea după genul ei, redare prin `ttsPlay` (fără blocaje pe „vorbește”)
  const parts = callChunks(text).flatMap(([s, at]) => { let o = 0; return ttsSplitLong(s).map(x => { const r = [x.trim(), at + o]; o += x.length; return r; }); }).filter(([s]) => s);
  const v = phoneVoice(langOf(c.c), c.c), rid = c._rid;
  return Promise.all(parts.map(([s, at], k) => new Promise(res => {
    const u = new SpeechSynthesisUtterance(s); u.lang = langOf(c.c); if(v) u.voice = v;
    const P = callProso(c, s, text, v); u.pitch = P.pitch; u.rate = P.rate; u.volume = P.vol;
    u.onstart = () => { u._t0 = performance.now(); if(call === c && c.state !== 'listen'){ c.state = 'speak'; callState('vorbește', 'speak'); callBarge(c); vfUtter(c, u); } };   // 9.62: gura pe cronologia textului
    u.onboundary = e => { if(window.__talk) window.__talk(e, capOff + at); };
    u.onend = u.onerror = ev => {
      if(ev && ev.type === 'end' && u._t0) vfCalib(u, performance.now() - u._t0);   // 9.62
      if(ev && !u._t0 && ev.error && !/interrupted|canceled/.test(ev.error)) callVoiceFail(c, ev.error);   // 9.70: n-a pornit deloc: spunem de ce
      if(call === c && c.holdNext && c.state === 'speak' && !c.interrupted){ c.holdNext = false; callInterrupt(c, ''); }   // 9.23: ai ieșit din cadru: se oprește la capăt de propoziție
      else if(call === c && k < parts.length - 1 && /(…|\.\.\.)\s*$/.test(s)) callBreath(c, .6);
      res();
    };
    ttsGate().then(() => { if(c.alive !== false && !(call && call !== c) && !c.interrupted && c._rid === rid) ttsPlay(u); else res(); });   // 9.70
  })));
}
// 9.70: vocea n-a pornit: o singură explicație pe apel, cu eroarea motorului și ce poți încerca
function callVoiceFail(c, err){
  VOX.err = {e:err, t:Date.now()};
  if(call !== c || c.vWarned) return; c.vWarned = true;
  const hint = /language|voice/.test(err) ? 'telefonul n-are vocea română instalată: Setări Android → Ieșire text în vorbire → Motor Google → Instalează date vocale → Română'
    : /not-allowed/.test(err) ? 'browserul n-a permis vocea: atinge o dată ecranul apelului'
    : 'încearcă fără căști Bluetooth sau cu „Întrerup” oprit; din profil → 🎙️ Vocea → „🔧 Verifică vocea” vezi ce răspunde telefonul';
  toast(`🔇 Vocea nu pornește (${err}). ${hint[0].toUpperCase() + hint.slice(1)}.`, 9000);
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
  c._rid = (c._rid || 0) + 1;   // 9.70: replicile rămase din răspunsul vechi (încă la poartă) nu mai pornesc
  c.state = 'think'; c.capOn = false; c.interrupted = false; callState('se gândește…', 'think'); $('#clCap').innerHTML = '<span class="cdots"><i></i><i></i><i></i></span>';
  while(busy && call === c) await sleep(300);
  if(call !== c) return;
  const n0 = c.ch.msgs.length;
  const pres = opts.pres ? `. Ce ai observat chiar acum la el în apel (reacționează firesc, doar dacă se potrivește, nu ca la o notă): ${opts.pres}` : '';   // 9.23
  const run = reply(null, {c:c.c, ch:c.ch, tag:'apel', ...opts, fix:opts.pro ? (opts.fix || '') : callFix(c) + pres});
  const m = c.ch.msgs[n0];
  // vorbește de la prima propoziție gata, cât restul încă se scrie
  let said = 0, done = false; const q = [];
  const speakNew = final => {
    if(!m || c.interrupted) return;
    const t = callClean(m.text); let rest = t.slice(said);
    if(!final){ let mm = rest.match(/^[\s\S]*?[.!?…]+["”»)]?(?=\s)/);
      if(!mm && !said){ const cm = rest.match(/^[\s\S]*?,(?=\s)/); if(cm && cm[0].trim().split(/\s+/).length >= 5) mm = cm; }   // 9.62: prima bucată pornește și la o virgulă (vorbește mai repede)
      if(!mm || mm[0].trim().length < 2) return; rest = mm[0]; }
    said += rest.length; rest = rest.trim(); if(!rest) return;
    const off = capAppend(c, rest);
    if(!q.length && rest.split(/\s+/).length >= 7 && Math.random() < .45) callBreath(c);   // 9.23: o respirație înainte de o replică mai lungă
    q.push(callSay(c, rest, off));
  };
  c._jit = {p:(Math.random() * 2 - 1) * .015, r:(Math.random() * 2 - 1) * .02};   // 9.23: aceeași replică, același ton (mică variație de la o replică la alta)
  const shOf = () => { const sw = m && !m._sh && (m.showIdx ? [0, m.showIdx] : m.text && m.text.match(/\[ar[ăa]t:\s*(\d{1,2})\s*\]/i)); if(sw){ m._sh = 1; delete m.showIdx; const it = showList(c)[+sw[1] - 1]; if(it){ m.shown = it.k; showPhoto(c, it); } } };   // 9.23
  const exOf = () => { shOf(); const x = m && (m.face ? [0, m.face] : m.text && m.text.match(/\[fa[țt][ăa]:\s*([^\]\n]{1,20})\]/i)); if(x && !m._ex){ m._ex = 1; c.face = x[1].trim(); exprShow(c, x[1].trim()); }
    else if(m && m.text && !m._ex && !m._exT){ const k = exprFromText(m.text); if(k){ m._exT = 1; c.face = k; exprShow(c, k); } } };   // 9.5: și după ce spune
  c.pollT = setInterval(() => { if(call !== c) return clearInterval(c.pollT); if(m && m.text && !m.err){ exOf(); speakNew(false); } }, 120);
  // 9.62: dacă răspunsul întârzie, un „hm…” scurt, ca un om care se gândește (local, fără cost; nu la începutul apelului, nu în altă limbă)
  clearTimeout(c.fillT); if(!opts.pro && !learnOn(c.c) && S.callFill !== 'off') c.fillT = setTimeout(() => {
    if(call !== c || c.state !== 'think' || said || c.interrupted || (m && callClean(m.text || '').length > 3)) return;
    const q = /\?\s*$/.test(c.lastHeard || ''), F = q ? ['Păi…', 'Stai…', 'Păi, stai…', 'Hmm, păi…'] : ['Îhî…', 'Aha…', 'Da…', 'Păi…'];   // 9.69: „Mhm” / „Mm” erau citite literă cu literă de vocile de telefon
    if(Math.random() < .65) callSay(c, F[Math.floor(Math.random() * F.length)], 0);
  }, 1100);
  try{ await run; } catch(e){}
  clearInterval(c.pollT); clearTimeout(c.fillT); done = true;
  if(c.interrupted && m && !m.err){ m.text = (c.saidText || callClean(m.text).split(/\s+/).slice(0, 4).join(' ')).trim() + '…'; if(m.alts) m.alts[m.alt || 0] = m.text; m.call = true; await saveChat(c.c, c.ch); return; }   // în istoric rămâne doar ce a apucat să spună
  if(call !== c) return;
  if(!m || m.err){ if(c.interrupted) return; callState(m && m.err ? '⚠️ ' + m.err : 'n-a mers', 'err'); c.state = 'idle'; setTimeout(() => call === c && callListen(), 1500); return; }
  m.call = true; if(c.video) m.video = true; exOf(); delete m._ex; delete m._sh;
  speakNew(true);
  if(!q.length && !c.interrupted){ c.state = 'idle'; callListen(); return; }
  await Promise.all(q);
  if(call !== c || c.interrupted) return;
  $('#clCap').querySelectorAll('.kw').forEach(w => w.classList.add('lit'));
  try{ c.bargeRec && c.bargeRec.abort(); }catch(e){} c.bargeRec = null;
  c.lastSpeakEnd = Date.now(); c.ref = null;
  if(c.showEl){ clearTimeout(c.showT); c.showT = setTimeout(() => showHide(c), 3500); }   // 9.23: poza arătată rămâne puțin după ce a terminat
  c.state = 'idle'; callListen();
}
// 8.14: o întrerupi vorbind peste ea (sau atingând subtitrarea): se oprește și te ascultă
function callInterrupt(c, heard){
  if(call !== c || c.state !== 'speak') return;
  c.saidText = [...($('#clCap') ? $('#clCap').querySelectorAll('.kw.lit') : [])].map(w => w.textContent).join(' ');
  c.interrupted = true; c.state = 'listen';
  if(c.vf) c.vf.kf = [];   // 9.62: gura se oprește odată cu vocea
  try{ ttsCancel(); }catch(e){}
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
    if(c.state === 'speak'){ setTimeout(() => callBarge(c), IS_ANDROID ? 1500 : 250); return; }        // a tăcut fără să te audă: ascultăm mai departe (9.70: pe Android rar, fiecare pornire ia sunetul)
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
  if(c.state === 'speak'){ c.interrupted = true; try{ ttsCancel(); }catch(e){} if(busy && live && live.ch === c.ch) busy.abort(); }
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
  const nine = S.imgProv === 'worker' && S.wkChat === 'ancorat' && (rwFor('ancorat') || !Number.isFinite(capLeft()) || capLeft() >= 5 * (neurPerPhoto('ancorat') || 1455) + ECO_RESERVE);
  const model = nine ? 'ancorat' : (S.imgProv === 'worker' ? 'eco' : undefined), per = neurPerPhoto(model) || 5000;   // 9.6: Eco dacă 9B nu încape în limita zilei
  let todo = Object.entries(EXPR).filter(([k]) => !set[k]);
  if(S.imgProv === 'worker' && !(nine && rwFor('ancorat'))){ const fit = Math.floor(capLeft() / per); if(fit < todo.length){ todo = todo.slice(0, Math.max(0, fit)); if(!todo.length){ toast('Limita zilnică de poze a fost atinsă; continui mâine.', 3500); return false; } } }
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
  if(c.vf && k === 'ras') c.vf.laughT = performance.now();   // 9.81
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
const VF_VS = 'attribute vec2 p;attribute vec2 t;attribute vec2 uA;attribute vec2 uO;attribute vec2 uE;attribute vec2 uB;attribute vec2 mk;uniform vec2 s;varying vec2 v;varying vec2 vA;varying vec2 vO;varying vec2 vE;varying vec2 vB;varying vec2 vm;void main(){v=t;vA=uA;vO=uO;vE=uE;vB=uB;vm=mk;gl_Position=vec4(p.x/s.x*2.0-1.0,1.0-p.y/s.y*2.0,0.0,1.0);}';
// 9.23: + adâncime (paralaxă: harta `dm`, deplasarea `par`, pornită cu `pd`) + lumina ei reală (câștig pe culori `gn`, saturație `sat`, luminozitate `fl`)
// 9.81: + cadrele reale (gura a / o / e și ochii închiși: texturile sA…sB, amestecate pe zone prin `mk`, cu greutățile `sw`)
//       + camera de telefon (obiectiv larg de aproape `lens`, focusul care caută `bl`, pixeli la semnal slab `px`)
//       + fundal viu doar în spatele ei (după harta de adâncime): legănat `bgv.x`, umbre de ploaie `bgv.y`, umbră / faruri care trec `bgv.z`, lumină printre frunze `bgv.w`
const VF_FS = 'precision mediump float;varying vec2 v;varying vec2 vA;varying vec2 vO;varying vec2 vE;varying vec2 vB;varying vec2 vm;uniform sampler2D x;uniform sampler2D dm;uniform sampler2D sA;uniform sampler2D sO;uniform sampler2D sE;uniform sampler2D sB;uniform vec4 col;uniform float m;uniform float ex;uniform vec2 par;uniform float pd;uniform vec3 gn;uniform float sat;uniform float fl;uniform vec4 sw;uniform vec3 lens;uniform float asp;uniform float bl;uniform float px;uniform float tm;uniform vec4 bgv;uniform float bgs;'
  + 'float hs(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233)))*43758.5453);}'
  + 'void main(){vec2 uv=v;if(lens.z>0.0){vec2 o=uv-lens.xy;vec2 d=o;d.x*=asp;float r2=dot(d,d);uv=lens.xy+o*(1.0-lens.z*exp(-r2*5.0));}'
  + 'float dd=texture2D(dm,v).r;if(pd>0.5){uv=uv+par*(dd-0.35);}float bgm=pd>0.5?smoothstep(0.42,0.26,dd):0.0;'
  + 'if(bgv.x>0.0){uv.x+=bgm*bgv.x*0.004*sin(uv.y*16.0+tm*1.1)*sin(tm*0.37+uv.y*3.0);}uv=clamp(uv,0.001,0.999);if(px>0.0){uv=(floor(uv/px)+0.5)*px;}'
  + 'vec4 c=texture2D(x,uv);if(bl>0.0){c=(c*2.0+texture2D(x,uv+vec2(bl,0.0))+texture2D(x,uv-vec2(bl,0.0))+texture2D(x,uv+vec2(0.0,bl))+texture2D(x,uv-vec2(0.0,bl)))/6.0;}'
  + 'float a=sw.x*vm.x;if(a>0.002){c=mix(c,texture2D(sA,vA),a);}a=sw.y*vm.x;if(a>0.002){c=mix(c,texture2D(sO,vO),a);}a=sw.z*vm.x;if(a>0.002){c=mix(c,texture2D(sE,vE),a);}a=sw.w*vm.y;if(a>0.002){c=mix(c,texture2D(sB,vB),a);}'
  + 'vec3 r=c.rgb*ex*gn;if(bgm>0.0){if(bgv.y>0.0){float n=hs(floor(vec2(v.x*90.0,v.y*14.0-tm*3.0)));r*=1.0-bgm*bgv.y*0.12*step(0.9,n);}'
  + 'if(bgv.z>-0.5){float k=exp(-pow((v.x-bgv.z)*3.0,2.0));r*=1.0+bgm*k*0.22*bgs;}'
  + 'if(bgv.w>0.0){float n2=sin(v.x*23.0+tm*0.9)*sin(v.y*19.0-tm*0.7)+sin((v.x+v.y)*31.0+tm*1.3)*0.5;r*=1.0+bgm*bgv.w*0.06*n2;}}'
  + 'float l=dot(r,vec3(0.299,0.587,0.114));r=mix(vec3(l),r,sat)*fl;gl_FragColor=m>0.5?col:vec4(r,c.a);}';
function vfGL(cv){
  const gl = cv.getContext('webgl', {premultipliedAlpha:false, antialias:true, preserveDrawingBuffer:false}); if(!gl) return null;
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VF_VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, VF_FS)); gl.linkProgram(pr);
  if(!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('webgl link');
  gl.useProgram(pr);
  const U = n => gl.getUniformLocation(pr, n), A = n => gl.getAttribLocation(pr, n);
  const o = {gl, pr, aP:A('p'), aT:A('t'), aS:[A('uA'), A('uO'), A('uE'), A('uB')], aM:A('mk'), uS:U('s'), uC:U('col'), uM:U('m'), uE:U('ex'),
    uX:U('x'), uD:U('dm'), uPar:U('par'), uPd:U('pd'), uGn:U('gn'), uSat:U('sat'), uFl:U('fl'), uSw:U('sw'), uLens:U('lens'), uAsp:U('asp'), uBl:U('bl'), uPx:U('px'), uTm:U('tm'), uBg:U('bgv'), uBgs:U('bgs'),
    bP:gl.createBuffer(), bT:gl.createBuffer(), bS:[0, 1, 2, 3].map(() => gl.createBuffer()), bM:gl.createBuffer(), tex:gl.createTexture(), dtex:gl.createTexture(), stex:[0, 1, 2, 3].map(() => gl.createTexture())};
  // 9.23: textura 0 = poza, textura 1 = harta de adâncime (la început un pixel gri, paralaxa oprită); culorile neutre
  gl.uniform1i(o.uX, 0); gl.uniform1i(o.uD, 1); gl.uniform3f(o.uGn, 1, 1, 1); gl.uniform1f(o.uSat, 1); gl.uniform1f(o.uFl, 1); gl.uniform1f(o.uPd, 0); gl.uniform2f(o.uPar, 0, 0);
  gl.uniform4f(o.uSw, 0, 0, 0, 0); gl.uniform3f(o.uLens, .5, .5, 0); gl.uniform1f(o.uAsp, 1); gl.uniform1f(o.uBl, 0); gl.uniform1f(o.uPx, 0); gl.uniform1f(o.uTm, 0); gl.uniform4f(o.uBg, 0, 0, -1, 0); gl.uniform1f(o.uBgs, 0);
  const par = () => { for(const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); };
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, o.dtex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([90])); par();
  // 9.81: texturile 2–5 = cadrele reale (gura a / o / e, ochii închiși); la început un pixel, nefolosite
  o.stex.forEach((tx, k) => { gl.activeTexture(gl.TEXTURE2 + k); gl.bindTexture(gl.TEXTURE_2D, tx); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255])); par(); gl.uniform1i(U(['sA', 'sO', 'sE', 'sB'][k]), 2 + k); });
  gl.activeTexture(gl.TEXTURE0);
  return o;
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
// 9.14: poziția corpului (MoveNet Lightning, în telefon): umeri, coate, încheieturi, șolduri — o dată per imagine
let poseP = null; const poseCache = new Map();
function poseModel(){ if(!poseP){ poseP = faceApi().then(f => f.tf.loadGraphModel('vendor/pose/movenet-lightning.json').then(m => ({tf:f.tf, m}))); poseP.catch(() => { poseP = null; }); } return poseP; }
async function vfPose(img){
  const key = img.currentSrc || img.src; if(poseCache.has(key)) return poseCache.get(key);
  let out = null;
  try{
    const {tf, m} = await poseModel(), W = img.naturalWidth, H = img.naturalHeight;
    const kp = tf.tidy(() => m.execute(tf.image.resizeBilinear(tf.browser.fromPixels(img), [192, 192]).toInt().expandDims(0)));
    const a = (await kp.array())[0][0]; kp.dispose();
    out = a.map(([y, x, sc]) => [x * W, y * H, sc]);
  }catch(e){ out = null; }
  poseCache.set(key, out); return out;
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
const VF_LAUGH = /^(ha(ha)+h?|hi(hi)+|he(he)+|hah+a+|=\)+)$/i;
const VF_WARM = /\b(drag|dragă|iubire|iubitule|iubito|frumos|frumoasă|mulțumesc|bine|super|minunat|haha|hihi|pupic|pup|te iubesc|dor|bucur|perfect)\b|❤|😊|🥰|😍|😘|☺/i;
/* 9.62: gura după textul rostit, nu după un sinus generic. Multe voci (Google pe Android) nu anunță cuvintele (`onboundary`),
   iar gura „vorbea” la întâmplare. Acum, la începutul fiecărei propoziții, `vfUtter` așază literele pe o cronologie, cu viteza
   vocii tale măsurată la fiecare propoziție (`vCps`, caractere pe secundă); pauze la virgulă și la punct, buzele lipite la m/b/p.
   Dacă vocea anunță totuși cuvintele, cronologia se retrage și gura urmează anunțurile (mai precis). */
const vfCps = u => { const k = (u && u.voice && u.voice.name) || 'implicit'; return (S.vCps && S.vCps[k]) || 14.5; };
function vfUtter(c, u){
  const V = c.vf; if(!V || !V.ready || !u || !u.text) return;
  const now = performance.now(), rate = u.rate || 1, cps = vfCps(u) * rate, id = u._id = (u._id || Math.random());
  let t = now + 40; const re = /([\p{L}\p{N}'’-]+)|([,;:])|([.!?…]+)/gu; let mm;
  while((mm = re.exec(u.text))){
    if(mm[1]){
      const w = mm[1], L = [...w.toLowerCase()].filter(ch => /\p{L}/u.test(ch)); if(!L.length) continue;
      const dur = Math.min(1100, Math.max(130, w.length / cps * 1000)), wt = L.map(ch => /[aeiouăâîyóú]/.test(ch) ? 1 : .55), tot = wt.reduce((a, b) => a + b, 0) || 1;
      const t0 = t; L.forEach((ch, k) => { const d = dur * wt[k] / tot, v = VF_VIS(ch, L[k + 1]); V.kf.push({t:t + d * .5, ...v, a:.8 + Math.random() * .3, src:id}); t += d; });
      if(VF_WARM.test(w)) V.kf.push({t:t0, o:V.kf[V.kf.length - 1].o, w:1, smile:1, src:id});
      if(VF_LAUGH.test(w)) V.kf.push({t:t0, o:V.kf[V.kf.length - 1].o, w:1, laugh:1, smile:1, src:id});   // 9.81: râde cu umerii
      t += 1000 / cps * .6;   // spațiul dintre cuvinte
    } else if(mm[2]){ V.kf.push({t:t + 50, o:0, w:1, rest:1, src:id}); t += 170 / rate; }
    else { V.kf.push({t:t + 50, o:0, w:1, rest:1, src:id, end:/\?/.test(mm[3]) ? 'q' : 'p'}); t += 330 / rate; }
  }
  V.kf.push({t:t + 60, o:0, w:1, rest:1, src:id});
  V.lastWord = now;
}
function vfCalib(u, ms){   // cât a durat de fapt propoziția → viteza vocii, pentru data viitoare
  if(!u || !u.text || ms < 500 || u.text.length < 14 || u._cut) return;
  const k = (u.voice && u.voice.name) || 'implicit', meas = u.text.length / (ms / 1000) / (u.rate || 1);
  if(!(meas > 5 && meas < 40)) return;
  S.vCps = S.vCps || {}; S.vCps[k] = S.vCps[k] ? S.vCps[k] * .7 + meas * .3 : meas;
  clearTimeout(vfCalib.t); vfCalib.t = setTimeout(saveSettings, 4000);
}
function vfWord(c, e){
  const V = c.vf; if(!V || !V.ready) return;
  const u = e && e.utterance, txt = u ? u.text : '', i = e && typeof e.charIndex === 'number' ? e.charIndex : -1;
  if(u && u._id && !u._bnd){ u._bnd = true; const now0 = performance.now(); V.kf = V.kf.filter(x => x.src !== u._id || x.t <= now0); }   // 9.62: vocea anunță cuvintele: renunțăm la cronologie
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
  if(VF_LAUGH.test(w)) V.laughT = now;   // 9.81
  if(/^[.!?…]/.test(after) || VF_WARM.test(w)){ V.lensUntil = now + 1300 + Math.random() * 900; V.sacAt = now; }   // 9.23: îți spune asta în ochi
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
    // 9.14: corpul: umeri, gât, piept, brațe, coate, încheieturi, șolduri (din poziție, doar ce se vede sigur); altfel estimat după față
    const torso = [], role = [];
    const near = q => [...pts, ...torso].some(o => Math.hypot(o[0] - q[0], o[1] - q[1]) < 8);
    const add = (q, r) => { if(!q || q[1] > H - 3 || q[1] < 0 || q[0] < 0 || q[0] > W) return; const c2 = clamp(q); if(near(c2)) return; torso.push(c2); role.push(r); };
    let kp = null; try{ kp = await vfPose(img); }catch(e){} if(tok !== V.tok || call !== c) return;
    const K = i => kp && kp[i] && kp[i][2] >= .3 ? [kp[i][0] * k, kp[i][1] * k] : null;
    const shL = K(5) || [cx + fw * .95, pts[8][1] + fh * .75], shR = K(6) || [cx - fw * .95, pts[8][1] + fh * .75];
    add([(shL[0] + shR[0]) / 2, Math.min(shL[1], shR[1]) - fh * .12], 'neck');
    add(shL, 'sh'); add(shR, 'sh');
    add([(shL[0] + shR[0]) / 2, (shL[1] + shR[1]) / 2 + fh * .6], 'chest');
    add([(shL[0] + shR[0]) / 2, (shL[1] + shR[1]) / 2 + fh * 1.25], 'chest');
    for(const [s0, e0, w0] of [[shL, K(7), K(9)], [shR, K(8), K(10)]]){
      if(e0){ add([(s0[0] + e0[0]) / 2, (s0[1] + e0[1]) / 2], 'arm'); add(e0, 'elb'); } else add([s0[0] + (s0 === shL ? 1 : -1) * fw * .1, s0[1] + fh * .85], 'arm');
      if(w0) add(w0, 'wri');
    }
    const hL = K(11), hR = K(12); if(hL) add(hL, 'hip'); if(hR) add(hR, 'hip');
    const hipC = hL && hR ? [(hL[0] + hR[0]) / 2, (hL[1] + hR[1]) / 2] : [(shL[0] + shR[0]) / 2, Math.min(H * 1.15, (shL[1] + shR[1]) / 2 + fh * 3)];
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
      piv:[pts[8][0], pts[8][1] + fh * .35], role, hipC, img, ready:true, dOn:false, peek:null, lean:0, shrug:0, ex:1, exT:1, exAt:0, gw:0, kf:[], nods:[], open:0, wid:1, press:0, smile:0, gx:0, gy:0, gtx:0, gty:0, sacAt:0,
      blinkAt:performance.now() + 1500 + Math.random() * 2500});
    V.uv = new Float32Array(V.uv0);
    // 9.81: adâncimea fiecărui punct al feței (capul se întoarce puțin, ca în 3D: nasul iese în față) și zonele cadrelor reale
    const nAll = all.length, z = new Float32Array(nAll), mk = new Float32Array(nAll * 2);
    for(let i = 0; i < nF; i++){ const [x, y] = all[i], ex0 = (x - cx) / (fw * .55), ey0 = (y - cy) / (fh * .7); let zz = Math.sqrt(Math.max(0, 1 - ex0 * ex0 - ey0 * ey0)) * .6;
      if(i >= 27 && i <= 35) zz += i === 30 || i === 33 ? .55 : .4; else if(i >= 48 && i <= 67) zz += .2; else if((i >= 36 && i <= 47) || i === 68 || i === 69) zz -= .05; else if(i >= 17 && i <= 26 || i >= 70) zz += .08; else if(i <= 16) zz = Math.max(.05, zz * .5);
      z[i] = zz; }
    for(let i = 0; i < 70; i++){
      mk[i * 2] = i >= 48 && i <= 67 ? 1 : i >= 31 && i <= 35 ? .55 : i >= 4 && i <= 12 ? .85 : (i === 2 || i === 3 || i === 13 || i === 14) ? .35 : 0;
      mk[i * 2 + 1] = (i >= 36 && i <= 47) || i === 68 || i === 69 ? 1 : i >= 17 && i <= 26 ? .45 : i >= 27 && i <= 29 ? .3 : 0; }
    V.z = z; V.mk = mk; V.spr = null; V.pts0 = pts;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.bM); gl.bufferData(gl.ARRAY_BUFFER, mk, gl.STATIC_DRAW);
    for(const b of g.bS){ gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, V.uv0, gl.STATIC_DRAW); }
    gl.viewport(0, 0, W, H);
    V.ib = V.ib || gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, V.idx, gl.STATIC_DRAW);
    vfDraw(c, performance.now());
    V.cv.classList.add('on');
    vfDepth(c, tok, img, {W, H, cx, cy, fw, fh, shL, shR});   // 9.23: harta de adâncime (în fundal, o dată per imagine)
    vfSprLoad(c, tok, img, pts, all).catch(e => console.warn('cadrele reale', e.message));   // 9.81: gura și clipitul din cadre reale, dacă există
  }catch(e){ console.warn('fața care vorbește', e.message); }
}
/* ═════════ 👄 9.81: cadrele reale ale feței (gura a / o / e, ochii închiși) ═════════
   O dată pe imagine (Runware, ~4 editări): aceeași poză, schimbat DOAR gura sau ochii. În apel, fiecare cadru se aliniază pe față
   (o transformare din ochi, nas și marginile feței), iar rețeaua de puncte face trecerea: punctele gurii / ochilor se mută spre forma
   din cadrul real, iar culorile se amestecă doar pe zona aceea. Așa gura deschisă și ochii închiși sunt reali, nu desenați. */
const SPR_KEYS = ['A', 'O', 'E', 'B'];
const SPR_STABLE = [0, 16, 27, 28, 29, 30, 31, 35, 36, 39, 42, 45];
function simFit(src, dst){   // transformarea asemenea (rotație + scară + mutare) care duce src peste dst, cele mai mici pătrate
  const n = src.length; let sx = 0, sy = 0, dx = 0, dy = 0; for(let i = 0; i < n; i++){ sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n; let a = 0, b = 0, q = 0;
  for(let i = 0; i < n; i++){ const x = src[i][0] - sx, y = src[i][1] - sy, u = dst[i][0] - dx, v = dst[i][1] - dy; a += x * u + y * v; b += x * v - y * u; q += x * x + y * y; }
  const c = a / (q || 1), s2 = b / (q || 1), tx = dx - (c * sx - s2 * sy), ty = dy - (s2 * sx + c * sy), k2 = c * c + s2 * s2 || 1;
  return {f:([x, y]) => [c * x - s2 * y + tx, s2 * x + c * y + ty], inv:([x, y]) => { const X = x - tx, Y = y - ty; return [(c * X + s2 * Y) / k2, (-s2 * X + c * Y) / k2]; }};
}
async function vfSprLoad(c, tok, img, pts, all){
  const V = c.vf; if(!V || S.callSprites === 'off') return;
  const key = img.dataset && (img.dataset.ik || img.dataset.k), set = key && c.c.vfs && c.c.vfs[key]; if(!set) return;
  const g = V.g, gl = g.gl, out = {};
  for(const [k, K] of SPR_KEYS.entries()){
    const dbk = set[K]; if(!dbk) continue;
    const b = await DB.get(dbk).catch(() => null); if(!b) continue;
    const u = URL.createObjectURL(b), im = await loadImgEl(u);
    const L = await vfLandmarks(im); if(!c.vf || tok !== c.vf.tok){ URL.revokeObjectURL(u); return; }
    if(!L){ URL.revokeObjectURL(u); continue; }
    const T = simFit(SPR_STABLE.map(i => L[i]), SPR_STABLE.map(i => pts[i]));
    const err = SPR_STABLE.reduce((m, i) => { const q = T.f(L[i]); return m + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]); }, 0) / SPR_STABLE.length;
    if(err > V.fw * .06){ URL.revokeObjectURL(u); continue; }   // nealiniat (alt unghi, altă față): cadrul nu se folosește
    const Ws = im.naturalWidth, Hs = im.naturalHeight, d = [], uv = new Float32Array(all.length * 2);
    for(let i = 0; i < 68; i++){ const q = T.f(L[i]); d.push([q[0] - pts[i][0], q[1] - pts[i][1]]); }
    const avgD = ids => [ids.reduce((a, i) => a + d[i][0], 0) / ids.length, ids.reduce((a, i) => a + d[i][1], 0) / ids.length];
    d.push(avgD([36, 37, 38, 39, 40, 41]), avgD([42, 43, 44, 45, 46, 47]));
    for(let j = 0; j < all.length; j++){ const q = j < 68 ? L[j] : j < 70 ? T.inv([all[j][0] + d[j][0], all[j][1] + d[j][1]]) : T.inv(all[j]); uv[j * 2] = q[0] / Ws; uv[j * 2 + 1] = q[1] / Hs; }
    gl.activeTexture(gl.TEXTURE2 + k); gl.bindTexture(gl.TEXTURE_2D, g.stex[k]); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.bS[k]); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    out[K] = {d, err:Math.round(err * 10) / 10}; URL.revokeObjectURL(u);
  }
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.tex);
  if(c.vf && tok === c.vf.tok && Object.keys(out).length){ V.spr = out; V.sw = [0, 0, 0, 0]; }
}
// generarea cadrelor (o dată pe imagine; cel mult 3 imagini noi pe zi); la fel ca expresiile, verificate în telefon să fie aceeași față
const SPR_ASK = {A:'the mouth open wide as when saying a long "aaa", jaw dropped naturally, upper teeth and the dark inside of the mouth visible',
  O:'the lips rounded and pushed slightly forward as when saying "ooo", mouth a little open in a small round shape',
  E:'the mouth open and stretched wide as when saying "eee", upper and lower teeth slightly visible',
  B:'both eyes gently closed, as in the middle of a blink, eyelids relaxed, the face otherwise unchanged'};
let sprBusy = false;
async function sprGen(ch, baseK, onDone){
  if(sprBusy || !ch || !baseK || S.callSprites === 'off' || S.imgProv === 'none') return false;
  ch.vfs = ch.vfs || {}; if(ch.vfs[baseK] && SPR_KEYS.every(k => ch.vfs[baseK][k])) return false;
  const d = dayKey(Date.now()); S.sprDay = S.sprDay && S.sprDay.d === d ? S.sprDay : {d, n:0}; if(S.sprDay.n >= 3) return false;
  const base = await DB.get(baseK).catch(() => null); if(!base) return false;
  sprBusy = true; S.sprDay.n++; saveSettings();
  try{
    let ref = null; try{ const f = (await faceDescs(base)).sort((a, b) => b.a - a.a)[0]; if(f) ref = f.d; }catch(e){}
    const same = async b => { if(!ref) return 0; try{ const fs = await faceDescs(b); return fs.length ? Math.min(...fs.map(f => fdist(f.d, ref))) : 1; }catch(e){ return 0; } };
    const set = ch.vfs[baseK] = ch.vfs[baseK] || {};
    await Promise.allSettled(SPR_KEYS.filter(k => !set[k]).map(async k => {
      const p = `Edit this exact photo: the same person, the same face and identity, the same head position, angle and size in the frame, the same clothes, pose, background, framing and light. Change ONLY this: ${SPR_ASK[k]}. Everything else stays exactly as it is. Photorealistic, the real skin texture.`;
      let b = await genImage(p, base, null, null, {force:{two:false, px:768}, model:S.wkChat || 'ancorat', quiet:true, why:'gura'}), dd = await same(b); addUsage(ch.id, imgPrice(), 'img', null, 'apel');
      if(dd > .45){ try{ const b2 = await genImage(p, base, null, null, {force:{two:false, px:768}, model:S.wkChat || 'ancorat', quiet:true, why:'gura'}), d2 = await same(b2); addUsage(ch.id, imgPrice(), 'img', null, 'apel'); if(d2 < dd){ b = b2; dd = d2; } }catch(e){} }
      if(dd > .5) return;   // altă față: nu-l păstrăm
      try{ if(b.type === 'image/png') b = await toJpeg(b, 1536, .9); }catch(e){}
      set[k] = await saveImg(b);
    }));
    // cel mult 3 imagini de bază cu cadre (cele mai vechi se șterg)
    const ks = Object.keys(ch.vfs); while(ks.length > 3){ const old = ks.shift(); for(const v of Object.values(ch.vfs[old] || {})) delImg(v).catch(() => {}); delete ch.vfs[old]; }
    await saveChars();
    const ok = Object.keys(set).length >= 2; if(ok && onDone) onDone();
    return ok;
  }catch(e){ return false; } finally { sprBusy = false; }
}
function vfDraw(c, now){
  const V = c.vf; if(!V || !V.ready) return;
  const g = V.g, gl = g.gl, B = V.base, P = B.map(p => p.slice()), st = c.state, s = st === 'speak', fh = V.fh, fw = V.fw;
  const ease = (cur, tgt, up, dn) => cur + (tgt - cur) * (tgt > cur ? up : dn);
  const heard = c.heardAt && now - c.heardAt < 900;
  const tS = now / 1000, br0 = Math.sin(tS * Math.PI * 2 / 4.2);
  const LIFE = S.callLife !== 'off', BH = LIFE ? vfBehave(c, V, now, st) : null;   // 9.81: ce face între replici
  // 9.81: semnal slab, rar: imaginea îngheață o clipă, apoi pixeli (doar cât nu vorbește)
  if(S.callCam !== 'off' && S.callGlitch !== 'off' && c.t0){ if(!V.glNext) V.glNext = now + 150e3 + Math.random() * 150e3;
    if(now > V.glNext && st !== 'speak'){ c.glitch = {freezeUntil:now + 450 + Math.random() * 500, pixUntil:now + 1500}; V.glNext = now + 200e3 + Math.random() * 220e3; netFlash(c); } }
  // ── gura: cadrele-cheie ale literelor; fără cuvinte de la voce, un vorbit generic cât vorbește
  V.kf = V.kf.filter(x => now < x.t + 400);
  for(const x of V.kf) if(!x.done && x.src && x.t <= now){ x.done = 1; if(x.smile) V.smileT = now; if(x.laugh) V.laughT = now; if(x.end){ V.nods.push({t:now, a:x.end === 'q' ? .4 : .9}); if(x.end === 'q'){ V.brow = now; V.tiltT = now; } else { V.lensUntil = now + 1200 + Math.random() * 800; V.sacAt = now; } } }   // 9.62
  let tO = 0, tW = 1, tP = 0;
  const prev = [...V.kf].reverse().find(x => x.t <= now), next = V.kf.find(x => x.t > now);
  if(prev && next && next.t - prev.t < 400){ const f = (now - prev.t) / (next.t - prev.t), m = f * f * (3 - 2 * f);
    tO = (prev.o * (prev.a || 1)) * (1 - m) + (next.o * (next.a || 1)) * m; tW = prev.w * (1 - m) + next.w * m; tP = (prev.p ? 1 - m : 0) + (next.p ? m : 0); }
  else if(next && next.t - now < 120){ tO = next.o * (next.a || 1) * (1 - (next.t - now) / 120); tW = 1 + (next.w - 1) * (1 - (next.t - now) / 120); tP = next.p ? 1 - (next.t - now) / 120 : 0; }
  if(s && !V.kf.length && now - (V.lastWord || 0) > 450){ const t = now / 1000; tO = Math.max(0, .55 * Math.sin(t * 11.3) * Math.sin(t * 3.1 + 1) + .15 * Math.sin(t * 23)); tW = 1 + .06 * Math.sin(t * 4.7); }
  if(!s){ tO = 0; tW = 1; tP = 0; }
  if(BH){ if(BH.open > tO){ tO = BH.open; tW = .92; } if(BH.press > tP) tP = BH.press; }   // 9.81: căscat, buze strânse când se gândește
  V.open = ease(V.open, tO, .6, .42); V.wid = ease(V.wid, tW, .45, .35); V.press = ease(V.press, tP, .6, .4);
  // 9.81: cadrele reale ale gurii: deschiderea se împarte între „a” (larg), „o” (rotunjit) și „e” (întins), după forma literei
  const SP = V.spr && S.callSprites !== 'off' ? V.spr : null, spM = !!(SP && (SP.A || SP.O || SP.E));
  V.sw = V.sw || [0, 0, 0, 0];
  { const oo = Math.min(1, Math.max(0, V.open)); let wA = 0, wO = 0, wE = 0;
    if(spM && oo > .01){ const fO = SP.O ? Math.min(1, Math.max(0, (1 - V.wid) / .12)) : 0, fE = SP.E ? Math.min(1, Math.max(0, (V.wid - 1) / .07)) * (1 - fO) : 0;
      wO = oo * fO; wE = oo * fE; wA = Math.max(0, oo - wO - wE); if(!SP.A){ if(SP.E) wE += wA; else wO += wA; wA = 0; } }
    V.sw[0] = wA; V.sw[1] = wO; V.sw[2] = wE; V.sw[3] = 0; }
  // ── zâmbetul: la cuvinte calde, și ușor cât te ascultă
  const smT = Math.max(V.smileT ? Math.max(0, 1 - (now - V.smileT) / 2200) : 0, st === 'listen' ? (heard ? .45 : .25) : 0);
  V.smile = ease(V.smile, smT, .08, .04);
  const o = spM ? 0 : Math.max(0, V.open), mv = (i, dx, dy) => { P[i][0] += dx; P[i][1] += dy; };   // 9.81: cu cadre reale, gura nu se mai desenează
  const L0 = [60, 67, 66, 65, 64].map(i => B[i].slice());   // buza de jos (interior) înainte să coboare maxilarul
  // lățimea buzelor (rotunjit / întins) în jurul centrului gurii
  if(!spM && Math.abs(V.wid - 1) > .005) for(let i = 48; i <= 67; i++) P[i][0] = V.mc[0] + (P[i][0] - V.mc[0]) * V.wid;
  // buze lipite (m, b, p): golul din poză se închide
  if(V.press > .02 && V.gap0 > 1){ const h = V.gap0 * .5 * V.press; [61, 62, 63].forEach(i => mv(i, 0, h)); [65, 66, 67].forEach(i => mv(i, 0, -h)); mv(51, 0, h * .4); mv(57, 0, -h * .4); }
  if(spM){ for(const [sp, w] of [[SP.A, V.sw[0]], [SP.O, V.sw[1]], [SP.E, V.sw[2]]]){ if(!sp || w < .005) continue;
    for(let i = 0; i < 70; i++){ const m2 = Math.min(1, V.mk[i * 2] * 1.25); if(m2) mv(i, sp.d[i][0] * w * m2, sp.d[i][1] * w * m2); } } }
  if(o > .01){
    const jaw = o * fh * .085;
    [[55, .8], [56, .95], [57, 1], [58, .95], [59, .8], [64, .55], [65, .95], [66, 1], [67, .95], [60, .55]].forEach(([i, f]) => mv(i, 0, jaw * f));
    [[6, .5], [7, .78], [8, .9], [9, .78], [10, .5], [5, .25], [11, .25]].forEach(([i, f]) => mv(i, 0, jaw * f * .9));
    const lift = V.gap0 < fh * .02 ? .32 : .12; [[61, .8], [62, 1], [63, .8]].forEach(([i, f]) => mv(i, 0, -jaw * lift * f)); [[50, .5], [51, .6], [52, .5]].forEach(([i, f]) => mv(i, 0, -jaw * (lift - .08) * f));
    mv(48, fw * .006 * o, jaw * .25); mv(54, -fw * .006 * o, jaw * .25);
  }
  if(LIFE && V.smile > .01){ const sm = V.smile;   // 9.81: zâmbet adevărat: urcă și obrajii, ochii se strâng puțin
    mv(36, 0, -fh * .004 * sm); mv(45, 0, -fh * .004 * sm); [2, 3].forEach(i => mv(i, -fw * .003 * sm, -fh * .007 * sm)); [13, 14].forEach(i => mv(i, fw * .003 * sm, -fh * .007 * sm)); mv(31, -fw * .002 * sm, -fh * .004 * sm); mv(35, fw * .002 * sm, -fh * .004 * sm); }
  if(LIFE){ const inh = Math.max(0, br0) * (BH && BH.sigh ? 2.2 : 1) * (s ? .4 : 1); mv(31, -fw * .004 * inh, 0); mv(35, fw * .004 * inh, 0);   // nările, la respirație
    if(st === 'think'){ mv(48, 0, fh * .005); mv(54, 0, fh * .005); }                                       // colțurile gurii coboară puțin când se gândește
    if(BH && BH.swallow) [7, 8, 9].forEach(i => mv(i, 0, -fh * .006 * BH.swallow));                         // înghite
    if(BH && BH.squint){ [37, 38, 43, 44].forEach(i => mv(i, 0, fh * .01 * BH.squint)); [40, 41, 46, 47].forEach(i => mv(i, 0, -fh * .006 * BH.squint)); } }
  if(V.smile > .01){ const sm = V.smile; mv(48, -fw * .012 * sm, -fh * .02 * sm); mv(54, fw * .012 * sm, -fh * .02 * sm); [49, 59].forEach(i => mv(i, -fw * .005 * sm, -fh * .01 * sm)); [53, 55].forEach(i => mv(i, fw * .005 * sm, -fh * .01 * sm)); [41, 40, 46, 47].forEach(i => mv(i, 0, -fh * .006 * sm)); }
  // ── clipit (uneori de două ori)
  if(now > V.blinkAt){ V.blinkT = now; V.blinkAt = now + (Math.random() < .15 ? 260 : 2400 + Math.random() * 3600); }
  const bp = V.blinkT ? (now - V.blinkT) / 150 : 2, bl = bp < 1 ? Math.sin(Math.PI * bp) : 0;
  const spB = SP && SP.B;   // 9.81: clipitul din cadrul real cu ochii închiși
  if(spB){ V.sw[3] = bl; if(bl > 0) for(let i = 0; i < 70; i++){ const m2 = V.mk[i * 2 + 1]; if(m2) mv(i, spB.d[i][0] * bl * m2, spB.d[i][1] * bl * m2); } }
  else if(bl > 0) [[37, 41], [38, 40], [43, 47], [44, 46]].forEach(([u, d]) => { mv(u, (B[d][0] - B[u][0]) * bl * .95, (B[d][1] - B[u][1]) * bl * 1.02); });
  if(V.gy > .02) [37, 38, 43, 44].forEach(i => mv(i, 0, fh * .009 * Math.min(1, V.gy / .4)));   // 9.23: privind spre ecran, pleoapele coboară puțin
  // ── sprâncenele: la întrebări și când se gândește
  const br = Math.max(V.brow ? Math.max(0, 1 - Math.abs((now - V.brow) / 500 - .6)) : 0, st === 'think' ? .45 : 0);
  if(br > 0){ const sd = LIFE ? (Math.floor((V.brow || 0) / 997) % 2 ? 1 : -1) : 0;   // 9.81: o sprânceană urcă puțin mai mult decât cealaltă
    for(let i = 17; i <= 26; i++) mv(i, 0, -fh * .045 * br * (sd ? ((i <= 21) === (sd > 0) ? 1 : .7) : 1)); }
  // ── privirea: salturi mici și fixări; la cameră când vorbește, sus-lateral când se gândește, spre tine când asculți
  if(now > V.sacAt){
    const r = (a) => (Math.random() * 2 - 1) * a;
    if(st === 'think'){ V.gtx = V.thinkSide = V.thinkSide || (Math.random() < .5 ? -.7 : .7); V.gty = -.55 + r(.1); V.sacAt = now + 700 + Math.random() * 900; }
    else if(V.search){ V.thinkSide = 0; V.gtx = r(.75); V.gty = .05 + r(.25); V.sacAt = now + 500 + Math.random() * 700; }   // 9.23: nu te mai vede: te caută din priviri
    else {   // 9.23: ca într-un apel adevărat se uită la ecran (puțin sub cameră); în obiectiv doar când spune ceva important
      V.thinkSide = 0; const lens = now < (V.lensUntil || 0), sy = lens ? 0 : (s ? .26 : .34);
      V.gtx = r(lens ? .06 : (s ? .16 : .3)); V.gty = sy + r(lens ? .04 : (s ? .08 : .12));
      V.sacAt = now + (lens ? 500 : (s ? 900 : 1300)) + Math.random() * (s ? 1400 : 2600);
      if(!s && !lens && Math.random() < .12){ V.lensUntil = now + 900 + Math.random() * 900; V.sacAt = now; }
    }
  }
  if(V.peek && now < V.peek.until){ V.gtx = V.peek.dir * .8; V.gty = .08; }   // 9.23: te uiți în altă parte → se uită și ea într-acolo
  if(BH && BH.gx != null){ V.gtx = BH.gx; V.gty = BH.gy; }   // 9.81: se uită într-o parte / în jos
  V.gx = ease(V.gx, V.gtx, .5, .5); V.gy = ease(V.gy, V.gty, .5, .5);
  // 9.81: capul se întoarce puțin, ca în 3D (nasul iese în față, obrazul din spate se strânge); ochii rămân pe tine
  { const yT = (BH ? BH.yaw : 0) + (LIFE ? Math.sin(tS * .43) * .014 + (s ? Math.sin(tS * 1.7 + 1) * .01 : 0) : 0), pT = (BH ? BH.pit : 0) + (LIFE ? Math.sin(tS * .31 + 1) * .008 : 0);
    V.yaw = ease(V.yaw || 0, yT, .07, .07); V.pit = ease(V.pit || 0, pT, .07, .07); }
  if(LIFE && Math.abs(V.yaw) + Math.abs(V.pit) > .0004){ const sy = Math.sin(V.yaw), cy2 = 1 - Math.cos(V.yaw), sp = Math.sin(V.pit), cp2 = 1 - Math.cos(V.pit);
    for(let i = 0; i < V.nF; i++){ const zz = V.z[i]; P[i][0] += zz * fw * .5 * sy - (P[i][0] - V.cx) * cy2; P[i][1] += zz * fh * .5 * sp - (P[i][1] - V.cy) * cp2; }
    for(let i = V.nF; i < V.nF + V.nR; i++){ P[i][0] += .04 * fw * sy; P[i][1] += .04 * fh * sp; }
    for(const q of L0){ q[0] += V.z[62] * fw * .5 * sy; q[1] += V.z[62] * fh * .5 * sp; } }
  // ── capul: legănat ușor, încuviințări pe fraze, înclinat la întrebări, mici încuviințări cât asculți
  if(st === 'listen' && heard && (!V.lnod || now - V.lnod > 2600 + Math.random() * 1500)){ V.lnod = now; V.nods.push({t:now, a:.55}); }
  V.nods = V.nods.filter(x => now < x.t + 450);
  let nod = 0; for(const x of V.nods){ const ph = (now - x.t) / 420; if(ph > 0 && ph < 1) nod = Math.max(nod, x.a * Math.sin(Math.PI * ph)); }
  const tilt = V.tiltT ? Math.max(0, 1 - Math.abs((now - V.tiltT) / 900 - .5) * 2) : 0;
  const t = now / 1000, breath = Math.sin(t * Math.PI * 2 / 4.2);
  const ang = (Math.sin(t * .7) * .9 + Math.sin(t * 1.9 + 2) * .35 + (s ? Math.sin(t * 3.3) * .4 : 0) + tilt * 2.4 * (V.tiltDir || (V.tiltDir = Math.random() < .5 ? -1 : 1))) * Math.PI / 180;
  const dx = Math.sin(t * .5 + 1) * fw * .008, dy = Math.sin(t * .83) * fh * .006 + (s ? -o * fh * .01 : 0) + nod * fh * .022 + breath * fh * .003 + (BH && BH.shake ? BH.shake * Math.sin(tS * 31) * fh * .006 : 0);   // 9.81: râde cu tot capul
  const rot = (i, f) => { const [px, py] = V.piv, x = P[i][0] - px, y = P[i][1] - py, ca = Math.cos(ang * f), sa = Math.sin(ang * f); P[i][0] = px + x * ca - y * sa + dx * f; P[i][1] = py + x * sa + y * ca + dy * f; };
  for(let i = 0; i < V.nF; i++) rot(i, 1);
  for(let i = V.nF; i < V.nF + V.nR; i++) rot(i, .45);
  { const [px, py] = V.piv, ca = Math.cos(ang), sa = Math.sin(ang); for(const q of L0){ const x = q[0] - px, y = q[1] - py; q[0] = px + x * ca - y * sa + dx; q[1] = py + x * sa + y * ca + dy; } }
  // ── 9.14: corpul. Se apleacă spre cameră când te ascultă, se lasă pe spate când râde sau se gândește, ridică din umeri la întrebări,
  //    respiră în umeri și piept, mâinile vizibile se mișcă puțin cât vorbește; capul rămâne pe umeri (se mișcă odată cu trunchiul)
  const laugh = V.smile > .45 || (V.img && V.img.dataset && V.img.dataset.ex === 'ras');
  const leanT = st === 'listen' ? (heard ? .85 : .4) : st === 'think' ? -.35 : laugh ? -.6 : s ? .2 + .15 * Math.sin(t * .9) : 0;
  V.lean = ease(V.lean, leanT, .025, .025);
  if((V.tiltT && now - V.tiltT < 40) || (st === 'think' && V.lastSt !== 'think')) V.shrugT = now;
  V.lastSt = st;
  const shg = V.shrugT ? Math.max(0, Math.sin(Math.PI * Math.min(1, (now - V.shrugT) / 650))) * (now - V.shrugT < 650 ? 1 : 0) : 0;
  V.gw = ease(V.gw, s ? o : 0, .2, .08);
  const bAng = ang * .3 + Math.sin(t * .37 + 2) * .004, sc = 1 + V.lean * .022, [hx, hy] = V.hipC;
  const body = (q, f) => { const x = q[0] - hx, y = q[1] - hy, ca = Math.cos(bAng * f), sa = Math.sin(bAng * f), z = 1 + (sc - 1) * f;
    q[0] = hx + (x * ca - y * sa) * z; q[1] = hy + (x * sa + y * ca) * z + V.lean * fh * .03 * f; };
  for(let i = 0; i < V.nF; i++) body(P[i], 1);
  for(let i = V.nF; i < V.nF + V.nR; i++) body(P[i], .7);
  for(const q of L0) body(q, 1);
  for(let i = V.nF + V.nR, k = 0; k < V.nT; i++, k++){
    const r = V.role[k], f = r === 'hip' ? .15 : 1; body(P[i], f);
    const up = r === 'sh' ? 1 : r === 'neck' ? .6 : r === 'arm' ? .8 : r === 'elb' ? .6 : r === 'wri' ? .45 : 0;
    P[i][1] -= shg * fh * .04 * up;                                                    // ridică din umeri
    P[i][1] -= breath * fh * (r === 'chest' ? .011 : r === 'sh' || r === 'neck' ? .007 : r === 'arm' ? .005 : 0) * (BH && BH.sigh ? 1 + BH.sigh * 2.2 : 1);   // respirația (9.81: și oftatul)
    if(BH && BH.shake) P[i][1] += BH.shake * Math.sin(tS * 31 + .5) * fh * .005 * up;   // 9.81: umerii, când râde
    if(BH && BH.swallow && r === 'neck') P[i][1] -= BH.swallow * fh * .02;
    if(r === 'wri' || r === 'elb'){ const m2 = r === 'wri' ? 1 : .5; P[i][0] += Math.sin(t * 2.3 + k) * fh * .012 * V.gw * m2; P[i][1] += Math.sin(t * 3.1 + k * 2) * fh * .01 * V.gw * m2; }   // mâinile, cât vorbește
  }
  // expunerea automată a camerei: mici ajustări lente (și puțin mai luminos când se apleacă spre cameră)
  if(now > V.exAt){ V.exT = .975 + Math.random() * .05; V.exAt = now + 2200 + Math.random() * 2600; }
  V.ex = ease(V.ex, V.exT + V.lean * .012, .02, .02);
  // pupilele: textura din centrul ochiului se mută puțin (conturul ochiului rămâne)
  const gxe = V.gx - (LIFE && !(BH && BH.gx != null) ? (V.yaw || 0) * 5 : 0), gye = V.gy - (LIFE && !(BH && BH.gy != null) ? (V.pit || 0) * 5 : 0);   // 9.81: capul se întoarce, ochii rămân pe tine
  const ux = gxe * V.ew * .14 / V.W, uy = gye * V.ew * .1 / V.H;
  for(const e of [68, 69]){ V.uv[e * 2] = V.uv0[e * 2] - ux; V.uv[e * 2 + 1] = V.uv0[e * 2 + 1] - uy; }
  // ── desen: imaginea deformată
  gl.useProgram(g.pr); gl.uniform2f(g.uS, V.W, V.H); gl.uniform1f(g.uM, 0); gl.uniform1f(g.uE, V.ex || 1);
  { // 9.23: paralaxa (aproape se mișcă mai mult decât departe) și lumina ei reală
    const R = c.rig, dr = V.dOn && R && S.callDepth !== 'off' ? Math.min(1, (now - (V.dAt || now)) / 1500) : 0;
    const pk = (v) => Math.max(-.03, Math.min(.03, -v / 100 * 4 * dr));   // ~1% între ea și fundal la mâna obișnuită, cel mult 3% în mers
    gl.uniform1f(g.uPd, dr > 0 ? 1 : 0); gl.uniform2f(g.uPar, dr ? pk(R.x) : 0, dr ? pk(R.y) : 0);
    const Lt = S.callLight !== 'off' ? litStep(c, now) : null;
    gl.uniform3f(g.uGn, ...(Lt ? Lt.gn : [1, 1, 1])); gl.uniform1f(g.uSat, Lt ? Lt.sat : 1); gl.uniform1f(g.uFl, Lt ? Lt.fl : 1);
    // 9.81: camera de telefon: obiectivul larg umflă puțin fața (mai mult când își apropie telefonul), focusul caută o clipă, pixeli la semnal slab
    const CAM = S.callCam !== 'off', GL2 = c.glitch && now < c.glitch.pixUntil ? c.glitch : null;
    gl.uniform3f(g.uLens, V.cx / V.W, V.cy / V.H, CAM ? .012 + (R ? Math.max(0, R.zoom) / .055 * .05 : 0) : 0); gl.uniform1f(g.uAsp, V.W / V.H);
    if(R){ if(R.t0 !== V.rT0){ if(V.rT0 !== undefined) V.focT = now; V.rT0 = R.t0; } if(R.zoomUntil !== V.rZ){ if(V.rZ !== undefined && R.zoomUntil > now) V.focT = now; V.rZ = R.zoomUntil; } }
    const fd = V.focT ? now - V.focT : 1e9; gl.uniform1f(g.uBl, CAM && fd < 900 ? Math.abs(Math.sin(fd / 900 * Math.PI * 2)) * (1 - fd / 900) * 4 / V.W : 0);
    gl.uniform1f(g.uPx, GL2 && now > GL2.freezeUntil ? 1 / 46 : 0);
    gl.uniform4f(g.uSw, ...V.sw.map(x => Math.min(1, x)));
    // 9.81: fundalul viu, doar în spatele ei (harta de adâncime din segmentare)
    const BG = S.callBg !== 'off' && V.dOn && V.dSeg ? c.bgfx : null; gl.uniform1f(g.uTm, (now / 1000) % 1000);
    let sw2 = -1; if(BG && BG.sweep){ if(!V.swAt) V.swAt = now + 20e3 + Math.random() * 40e3; const k3 = (now - V.swAt) / 1800; if(k3 > 1) V.swAt = now + 35e3 + Math.random() * 55e3; else if(k3 >= 0) sw2 = -.3 + k3 * 1.6; }
    gl.uniform4f(g.uBg, BG ? BG.sway : 0, BG ? BG.rain : 0, sw2, BG ? BG.dapple : 0); gl.uniform1f(g.uBgs, BG && BG.night ? 1 : -1); }
  gl.bindBuffer(gl.ARRAY_BUFFER, g.bP); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(P.flat()), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(g.aP); gl.vertexAttribPointer(g.aP, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, g.bT); gl.bufferData(gl.ARRAY_BUFFER, V.uv, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(g.aT); gl.vertexAttribPointer(g.aT, 2, gl.FLOAT, false, 0, 0);
  for(let k = 0; k < 4; k++){ const a = g.aS[k]; if(a < 0) continue; gl.bindBuffer(gl.ARRAY_BUFFER, g.bS[k]); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0); }   // 9.81
  if(g.aM >= 0){ gl.bindBuffer(gl.ARRAY_BUFFER, g.bM); gl.enableVertexAttribArray(g.aM); gl.vertexAttribPointer(g.aM, 2, gl.FLOAT, false, 0, 0); }
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
      for(const a of g.aS) if(a >= 0) gl.disableVertexAttribArray(a); if(g.aM >= 0) gl.disableVertexAttribArray(g.aM);
      const al = Math.min(1, (o - .06) * 3), draw = (arr, r, gg, bb, aa) => { gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW); gl.vertexAttribPointer(g.aP, 2, gl.FLOAT, false, 0, 0); gl.uniform4f(g.uC, r, gg, bb, aa); gl.drawArrays(gl.TRIANGLES, 0, arr.length / 2); };
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bP);
      draw(fan, .34, .12, .12, .78 * al);
      if(inset.length) draw(inset, .17, .05, .06, .7 * al);
      if(teeth.length) draw(teeth, .86, .82, .77, .3 * al);
      gl.enableVertexAttribArray(g.aT);
    }
  }
}
/* 9.81: între replici face ce face un om la telefon: se uită într-o parte, în jos (când gătește / lucrează), oftează,
   înghite, își strânge buzele când se gândește, cască noaptea; după programul, locul și starea ei. Totul se oprește cât vorbești. */
function vfBehCtx(c){
  const t = callCtx(c), h = charNow(c.c).getHours(), mood = String(c.ch && c.ch.mood && c.ch.mood.t || '');
  return {busy:/(gătesc|gatesc|gătește|gateste|bucătări|bucatari|cooking|lucrez|lucrează|birou|laptop|calculator|studiez|învăț|invat|working|office)/.test(t), night:h >= 23 || h < 6, sad:/(trist|obosit|supărat|suparat|melancol|abătut|abatut|tired|sad)/i.test(mood)};
}
function vfBehave(c, V, now, st){
  const B = V.beh || (V.beh = {k:'', next:now + 5000 + Math.random() * 6000, ctx:vfBehCtx(c), ctxAt:now, yawns:0});
  if(now - B.ctxAt > 60e3){ B.ctx = vfBehCtx(c); B.ctxAt = now; }
  const quiet = (st === 'listen' || st === 'idle' || st === 'think') && !(c.heardAt && now - c.heardAt < 2500) && !V.search;
  if(B.k && !quiet && B.k !== 'swallow'){ B.k = ''; B.next = now + 6000 + Math.random() * 8000; }
  if(B.k && now > B.t0 + B.dur){ B.k = ''; B.next = now + (B.ctx.busy ? 6000 : 9000) + Math.random() * 12000; }
  if(!B.k && quiet && now > B.next){
    const X = B.ctx, opts = [];
    if(st === 'think') opts.push(['press', 3], ['glance', 2]);
    else { opts.push(['glance', 4], ['swallow', 1.5], ['sigh', X.sad ? 3 : .8], ['down', X.busy ? 4 : 1]); if(X.night && B.yawns < 2) opts.push(['yawn', 1.2]); }
    let q = Math.random() * opts.reduce((a, o) => a + o[1], 0), k = opts[0][0]; for(const [n, w] of opts){ if((q -= w) <= 0){ k = n; break; } }
    B.k = k; B.t0 = now; B.dir = Math.random() < .5 ? -1 : 1;
    B.dur = {glance:1400 + Math.random() * 1400, down:1800 + Math.random() * 2200, sigh:2400, yawn:2800, swallow:650, press:1100}[k];
    if(k === 'yawn') B.yawns++;
  }
  const ph = B.k ? Math.min(1, (now - B.t0) / B.dur) : 0, env = B.k ? Math.sin(Math.PI * ph) : 0, hold = B.k ? Math.min(1, Math.min(ph, 1 - ph) * 5) : 0;
  const o = {k:B.k, yaw:0, pit:0, gx:null, gy:null, open:0, press:0, sigh:0, shake:0, swallow:0, squint:0};
  if(B.k === 'glance'){ o.yaw = B.dir * .085 * hold; o.gx = B.dir * .95; o.gy = .02; }
  else if(B.k === 'down'){ o.pit = .06 * hold; o.gx = B.dir * .15; o.gy = .9; }
  else if(B.k === 'sigh'){ o.sigh = env; o.pit = .015 * env; }
  else if(B.k === 'yawn'){ o.open = .95 * Math.pow(env, .7); o.pit = -.05 * env; o.squint = env; }
  else if(B.k === 'swallow') o.swallow = env;
  else if(B.k === 'press') o.press = .55 * hold;
  if(V.laughT && now - V.laughT < 1000) o.shake = 1 - (now - V.laughT) / 1000;
  return o;
}
// 9.81: „📶 Conexiune slabă”, ca în aplicațiile de apel, cât ține sughițul semnalului
function netFlash(c){
  const v = $('.callv'); if(!v || call !== c) return;
  let el = v.querySelector('.cnet'); if(!el){ el = document.createElement('div'); el.className = 'cnet'; el.textContent = '📶 Conexiune slabă'; v.appendChild(el); }
  el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 1900);
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
    if(c.glitch && now < c.glitch.freezeUntil) return;          // 9.81: semnal slab: imaginea rămâne înghețată o clipă
    last = now; vfDraw(c, now);
  };
  c.vf.raf = requestAnimationFrame(loop);
  vfSwitch(c, cvd.querySelector('img.on'));
}
function vfStop(c){ if(!c || !c.vf) return; cancelAnimationFrame(c.vf.raf); try{ const x = c.vf.g.gl.getExtension('WEBGL_lose_context'); if(x) x.loseContext(); }catch(e){} c.vf = null; }
/* ═════════ 🎬 9.23: apelul video realist, tot în telefon, fără niciun cost ═════════
   Sunetul camerei ei (WebAudio), vocea cu emoție, „îhî / da” cât vorbești, adâncime 3D (segmentarea persoanei în telefon),
   lumina ei reală (ora, apusul, norii), telefonul ținut în mână / sprijinit / în mers, „stai să-ți arăt” (o poză din telefonul ei),
   prezența ta (ieși din cadru, te uiți în altă parte, întuneric, distanța) și privirea ca într-un apel adevărat. */
// ce se știe despre locul și momentul ei (scena din chat, programul, planul în desfășurare)
function callCtx(c){
  const ch = c.ch || {}, w = ch.where && Date.now() - (ch.where.ts || 0) < 6 * 36e5 ? ch.where : {}, lf = lifeNow(c.c);
  return [w.place, w.room, w.activity, w.light, ch.plot && Date.now() - (ch.plot.ts || 0) < 12 * 36e5 ? ch.plot.t : '', lf && lf.w, ch.scene].filter(Boolean).join(' · ').toLowerCase();
}
/* ── 🎧 sunetul camerei ei ── */
function ambEnv(c){
  const t = callCtx(c), has = re => re.test(t);
  if(has(/(mașin|masin|conduc|volan|taxi|uber|\bcar\b|driving)/)) return 'masina';
  if(has(/(cafenea|cafe\b|café|restaurant|\bbar\b|\bpub\b|mall|coffee|bistro|cofetări|cofetari|cantin|terasă|terasa|terrace)/)) return 'cafenea';
  if(has(/(plaj|beach|malul mării|la mare|\bsea\b)/)) return 'plaja';
  if(has(/(\bparc|grădin|gradin|pădur|padur|munte|\blac\b|\bpark\b|garden|forest|lake)/)) return 'parc';
  if(has(/(stradă|strada|pe drum|în drum|in drum|oraș|oras|centru|stați|stati|metrou|autobuz|tramvai|street|city|downtown|merg(em)? pe jos|spre cas[ăa]|plimb|walking)/)) return 'strada';
  if(has(/(birou|la serviciu|la muncă|la munca|office|ședinț|sedint)/)) return 'birou';
  if(has(/(bucătări|bucatari|kitchen|gătesc|gatesc|cooking)/)) return 'bucatarie';
  return 'casa';
}
// nivelul de bază al fiecărui strat (amplitudine), calibrat în test-apel.py (OfflineAudioContext, RMS)
const AMB_LVL = {room:.06, hum:.004, traffic:.07, babble:.09, car:.3, road:.07, wind:.09, sea:.2, rain:.03, rainOut:.12, leaves:.025};
function ambBuild(ac, dest, env, w, night){
  const nb = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate), d = nb.getChannelData(0);
  for(let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const nodes = [];
  const src = () => { const s = ac.createBufferSource(); s.buffer = nb; s.loop = true; s.start(0, Math.random() * 3.5); nodes.push(s); return s; };
  const filt = (type, f, q = .7) => { const x = ac.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
  const gain = v => { const g = ac.createGain(); g.gain.value = v; return g; };
  const lfo = (param, f, depth) => { const o = ac.createOscillator(); o.frequency.value = f; const g = gain(depth); o.connect(g).connect(param); o.start(); nodes.push(o); };
  const out = gain(1); out.connect(dest);
  const layer = (lvl, ...fs) => { const g = gain(lvl); let n = src(); for(const f of fs){ n.connect(f); n = f; } n.connect(g).connect(out); return g; };
  // liniștea camerei (zgomot grav, peste tot)
  layer(AMB_LVL.room * (env === 'casa' && night ? .7 : 1), filt('lowpass', 200), filt('lowpass', 260));
  if(['casa', 'bucatarie', 'birou'].includes(env)){
    // frigiderul / ventilația: un zumzet foarte discret
    if(env !== 'casa' || Math.random() < .4){ for(const [f, a] of [[50, 1], [100, .5], [150, .2]]){ const o = ac.createOscillator(); o.frequency.value = f; const g = gain(AMB_LVL.hum * a); o.connect(g).connect(out); o.start(); nodes.push(o); } }
    // traficul de afară, prin geam (ziua mai mult)
    const tg = layer(AMB_LVL.traffic * (night ? .06 : .14), filt('bandpass', 420, .5), filt('lowpass', 900)); lfo(tg.gain, .06, AMB_LVL.traffic * .05);
  }
  if(env === 'strada'){ const tg = layer(AMB_LVL.traffic, filt('bandpass', 520, .45)); lfo(tg.gain, .07, AMB_LVL.traffic * .35); }
  if(env === 'cafenea') for(let k = 0; k < 4; k++){   // vorbele celorlalți: benzi de zgomot modulate pe ritmul silabelor
    const g = layer(AMB_LVL.babble, filt('bandpass', 380 + Math.random() * 1400, 1.3)); g.gain.value = AMB_LVL.babble * .6; lfo(g.gain, 2.6 + Math.random() * 3.5, AMB_LVL.babble * .45);
  }
  if(env === 'masina'){ layer(AMB_LVL.car, filt('lowpass', 130)); layer(AMB_LVL.road, filt('bandpass', 850, .5)); const o = ac.createOscillator(); o.frequency.value = 38 + Math.random() * 8; const g = gain(.012); o.connect(g).connect(out); o.start(); nodes.push(o); }
  if(env === 'parc') layer(AMB_LVL.leaves, filt('bandpass', 2500, .4));   // aerul de afară, frunzele
  if(env === 'plaja'){ const g = layer(AMB_LVL.sea, filt('lowpass', 650)); g.gain.value = AMB_LVL.sea * .55; lfo(g.gain, .085, AMB_LVL.sea * .45); }
  const outside = ['strada', 'parc', 'plaja'].includes(env);
  if(outside && (env === 'plaja' || (w && w.wind >= 18))){ const f = filt('lowpass', 500), g = layer(AMB_LVL.wind, f); lfo(f.frequency, .11, 260); lfo(g.gain, .07, AMB_LVL.wind * .5); }
  if(w && w.fx === 'rain') layer(outside ? AMB_LVL.rainOut : AMB_LVL.rain, filt('highpass', 1700), filt('lowpass', 7000));
  return {out, nodes, nb};
}
// sunete scurte, la întâmplare: mașini care trec, cești, păsări, picături, tastatură
function ambEvent(c, kind){
  const A = c.amb, ac = c.ac; if(!A || !ac || ac.state === 'closed') return;
  const t = ac.currentTime, g = ac.createGain(); g.connect(A.master); g.gain.value = 0;
  const noise = (dur, type, f, q = .8) => { const s = ac.createBufferSource(); s.buffer = A.nb; const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; s.connect(fl).connect(g); s.start(t, Math.random() * 3); s.stop(t + dur); return fl; };
  const tone = (f, at, dur) => { const o = ac.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t + at); o.stop(t + at + dur); return o; };
  if(kind === 'car'){ const fl = noise(5, 'bandpass', 260, .7); fl.frequency.linearRampToValueAtTime(820, t + 2.2); fl.frequency.linearRampToValueAtTime(300, t + 4.6); const pk = A.env === 'strada' ? .05 : .012; g.gain.linearRampToValueAtTime(pk, t + 2.2); g.gain.linearRampToValueAtTime(0, t + 4.8); }
  else if(kind === 'clink'){ const f = 2600 + Math.random() * 1600; tone(f, 0, .5); tone(f * 1.51, 0, .35); g.gain.setValueAtTime(.006, t); g.gain.exponentialRampToValueAtTime(.0001, t + .45); }
  else if(kind === 'bird'){ const n = 2 + Math.floor(Math.random() * 4); for(let k = 0; k < n; k++){ const o = tone(3200, k * .16, .1); o.frequency.setValueAtTime(3000 + Math.random() * 600, t + k * .16); o.frequency.linearRampToValueAtTime(4300 + Math.random() * 900, t + k * .16 + .05); o.frequency.linearRampToValueAtTime(3300, t + k * .16 + .1); } g.gain.setValueAtTime(.0035, t); g.gain.setValueAtTime(.0035, t + n * .16); g.gain.linearRampToValueAtTime(0, t + n * .16 + .05); }
  else if(kind === 'keys'){ const n = 3 + Math.floor(Math.random() * 10); for(let k = 0; k < n; k++){ const at = t + k * (.09 + Math.random() * .12); g.gain.setValueAtTime(.02, at); g.gain.exponentialRampToValueAtTime(.0001, at + .025); } noise(n * .25, 'highpass', 1800); }
  else if(kind === 'drop'){ noise(.03, 'highpass', 2600); g.gain.setValueAtTime(.012, t); g.gain.exponentialRampToValueAtTime(.0001, t + .03); }
  setTimeout(() => { try{ g.disconnect(); }catch(e){} }, 6000);
}
function ambStart(c){
  if(S.callAmb === 'off' || !c.ac || c.amb) return;
  try{
    const ac = c.ac; if(ac.state === 'suspended' && ac.resume) ac.resume().catch(() => {});
    const env = ambEnv(c), hit = wxMem[c.c.id], w = hit && hit.w, h = charNow(c.c).getHours(), night = h >= 22 || h < 6;
    const master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
    const B = ambBuild(ac, master, env, w, night);
    master.gain.setValueAtTime(0, ac.currentTime); master.gain.linearRampToValueAtTime(1, ac.currentTime + 2.5);
    c.amb = {env, master, nodes:B.nodes, nb:B.nb, timers:[], lvl:1};
    const every = (kind, a, b) => { const go = () => { if(call !== c || !c.amb) return; ambEvent(c, kind); c.amb.timers.push(setTimeout(go, a + Math.random() * (b - a))); }; c.amb.timers.push(setTimeout(go, a * .5 + Math.random() * (b - a))); };
    if(env === 'strada') every('car', 6e3, 20e3); else if(['casa', 'bucatarie', 'birou'].includes(env) && !night) every('car', 25e3, 70e3);
    if(env === 'cafenea') every('clink', 5e3, 16e3);
    if((env === 'parc' || (env === 'casa' && !night && Math.random() < .3)) && !(w && w.fx)) every('bird', 4e3, 14e3);
    if(env === 'birou') every('keys', 6e3, 22e3);
    if(w && w.fx === 'rain' && !['strada', 'parc', 'plaja'].includes(env)) every('drop', 120, 900);
  }catch(e){ c.amb = null; }
}
function ambLevel(c, v){ const A = c && c.amb; if(!A || A.lvl === v || !c.ac) return; A.lvl = v; try{ A.master.gain.cancelScheduledValues(c.ac.currentTime); A.master.gain.setTargetAtTime(v, c.ac.currentTime, .4); }catch(e){} }
function ambStop(c){
  const A = c.amb; if(!A) return; c.amb = null;
  A.timers.forEach(clearTimeout);
  try{ A.master.gain.cancelScheduledValues(c.ac.currentTime); A.master.gain.setTargetAtTime(0, c.ac.currentTime, .15); }catch(e){}
  setTimeout(() => { A.nodes.forEach(n => { try{ n.stop(); }catch(e){} }); }, 700);
}
// o respirație scurtă (înainte de o replică lungă, după „…”)
function callBreath(c, amp = 1){
  const ac = c.ac, A = c.amb; if(!ac || ac.state === 'closed' || S.callAmb === 'off') return;
  try{
    let nb = A && A.nb; if(!nb){ nb = c._bnb || (c._bnb = ac.createBuffer(1, ac.sampleRate, ac.sampleRate)); const d = nb.getChannelData(0); if(!d[1]) for(let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), f2 = ac.createBiquadFilter(), g = ac.createGain(), t = ac.currentTime;
    s.buffer = nb; f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = .7; f2.type = 'lowpass'; f2.frequency.value = 3800;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.16 * amp, t + .14); g.gain.linearRampToValueAtTime(.1 * amp, t + .26); g.gain.linearRampToValueAtTime(0, t + .4);
    f.frequency.linearRampToValueAtTime(1700, t + .35);
    s.connect(f).connect(f2).connect(g).connect(ac.destination); s.start(t, Math.random() * .5); s.stop(t + .45);
  }catch(e){}
}
/* ── 🗣️ vocea cu emoție: tonul, viteza și volumul urmează starea ei, propoziția și ora ── */
const PROSO = [
  [/(entuziasm|fericit|vesel|bucuro|încântat|incantat|emoționat|emotionat|amuzat|jucăuș|jucaus|râde|rade|haz|euforic|energic|excitat de)/, {p:.06, r:.07, v:1}],
  [/(trist|obosit|somn|melancol|abătut|abatut|dor\b|singur|îngrijor|ingrijor|deprimat|plâns|plans|abătută)/, {p:-.05, r:-.09, v:.85}],
  [/(supărat|suparat|iritat|nervos|nervoasă|frustrat|gelos|geloasă|bosumflat)/, {p:-.03, r:.03, v:1}],
  [/(tandr|drăgăst|dragast|calm|liniștit|linistit|relaxat|visător|visator|romantic|timid|rușin|rusin|duios|duioasă)/, {p:.01, r:-.06, v:.88}]
];
function callProso(c, s, whole, voice){
  const base = voxBase(c.c, voice === undefined ? phoneVoice(langOf(c.c), c.c) : voice);   // 9.69: tonul de bază după vocea primită
  let p = 0, r = 0, v = 1;
  const mood = ((c.ch.mood && Date.now() - (c.ch.mood.ts || 0) < 3 * 36e5 ? c.ch.mood.t : '') + ' ' + (c.face || '')).toLowerCase();
  for(const [re, d] of PROSO) if(re.test(mood)){ p += d.p; r += d.r; v = Math.min(v, d.v); break; }
  const ex = exprFromText(whole || s);
  if(ex === 'ras'){ p += .04; r += .05; } else if(ex === 'trista'){ p -= .04; r -= .07; v = Math.min(v, .88); } else if(ex === 'surpriza'){ p += .07; r += .03; } else if(ex === 'ganditoare') r -= .05;
  const t = String(s).trim();
  if(/!\s*$/.test(t)){ p += .03; r += .03; }
  if(/\?\s*$/.test(t)){ p += .03; r += .02; }
  if(/(…|\.\.\.)\s*$/.test(t)) r -= .06;
  const nw = t.split(/\s+/).filter(Boolean).length; if(nw <= 3) r += .04; else if(nw >= 18) r += .02;
  const h = charNow(c.c).getHours(); if(h >= 23 || h < 6){ r -= .05; p -= .02; v = Math.min(v, .85); }
  const j = c._jit || {p:0, r:0};
  return {pitch:Math.min(1.8, Math.max(.5, base * (1 + p + j.p))), rate:Math.min(1.3, Math.max(.72, .99 * (1 + r + j.r))), vol:v};
}
// o propoziție lungă se rostește în două, la virgula cea mai apropiată de mijloc: o pauză reală, ca la un om
function callChunks(text){
  const t = String(text);
  if(t.length < 70) return [[t, 0]];
  let best = -1, bd = 1e9;
  for(const m of t.matchAll(/,\s+/g)){ const at = m.index + m[0].length; if(m.index < 22 || t.length - at < 18) continue; const dd = Math.abs(at - t.length / 2); if(dd < bd){ bd = dd; best = at; } }
  return best < 0 ? [[t, 0]] : [[t.slice(0, best).trimEnd(), 0], [t.slice(best), best]];
}
/* ── 💬 „îhî”, „da”, „aha” cât vorbești tu (în pauzele scurte; nu intră în ce ai spus) ── */
const BC_WORDS = {ro:[['îhî', 'da', 'aha', 'da, da', 'îhî', 'așa'], ['îhî', 'înțeleg', 'vai']], en:[['uh-huh', 'yeah', 'right', 'mm-hm'], ['I see', 'oh no']], es:[['ajá', 'sí', 'claro'], ['vaya', 'entiendo']], fr:[['oui', 'ah oui', "d'accord"], ['oh', 'je vois']], it:[['sì', 'certo', 'ah'], ['capisco', 'oh no']], de:[['ja', 'genau', 'aha'], ['oh nein', 'verstehe']]};
function bcMaybe(c, txt, lastT){
  if(S.callBack === 'off' || !txt || call !== c || c.state !== 'listen' || c.muted || !lastT) return;
  if(IS_ANDROID && S.callBack !== 'force') return;   // 9.70: pe Android vocea peste microfonul deschis nu se aude și poate opri ascultarea
  const now = Date.now(), gap = now - lastT;
  if(gap < 330){ c.bcPause = false; return; }
  if(gap > 650 || c.bcPause) return;
  c.bcPause = true;                                                            // o singură decizie pe pauză
  const words = txt.split(/\s+/).filter(Boolean).length;
  if(words - (c.bcWords || 0) < 6 || now - (c.bcAt || 0) < 5500 || now - (c.bcStart || now) < 2200 || Math.random() > .55) return;
  const sad = /(trist|greu|obosit|nasol|\brău\b|plâng|dor\b|bolnav|singur|sad|tired|hard|bad)/i.test(txt);
  const set = BC_WORDS[langOf(c.c).slice(0, 2)] || BC_WORDS.ro, pool = set[sad ? 1 : 0], w = pool[Math.floor(Math.random() * pool.length)];
  c.bcAt = now; c.bcWords = words; (c.bcSaid = c.bcSaid || []).push(w);
  try{
    const u = new SpeechSynthesisUtterance(w); u.lang = langOf(c.c); const vv = phoneVoice(langOf(c.c), c.c); if(vv) u.voice = vv;
    const P = callProso(c, w, txt, vv); u.pitch = P.pitch; u.rate = Math.min(1.25, P.rate * 1.05); u.volume = .55;
    ttsPlay(u);
  }catch(e){}
  const V = c.vf; if(V && V.ready){ V.nods.push({t:performance.now() + 60, a:.85}); if(!sad) V.smileT = performance.now(); }
}
// ce a spus ea („îhî”) poate fi auzit de microfon: îl scoatem din ce ai spus tu (doar cuvintele rostite de ea, ultima apariție)
function bcClean(c, t){
  const said = (c.bcSaid || []).splice(0); if(!said.length) return t;
  const norm = x => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let out = t;
  for(const w of said){
    const parts = norm(w).split(/[\s,]+/).filter(Boolean); if(!parts.length) continue;
    const toks = out.split(/(\s+)/), nt = toks.map(x => norm(x).replace(/[^\p{L}\p{N}'-]/gu, ''));
    for(let i = toks.length - 1; i >= 0; i--){
      if(nt[i] !== parts[0]) continue;
      let k = i, ok = true; const idx = [i];
      for(let q = 1; q < parts.length; q++){ k += 2; if(nt[k] !== parts[q]){ ok = false; break; } idx.push(k); }
      if(!ok) continue;
      idx.forEach(z => toks[z] = ''); out = toks.join('').replace(/\s{2,}/g, ' ').replace(/^[\s,.]+/, '').trim(); break;
    }
  }
  return out || t;
}
/* ── 🪟 adâncime 3D: persoana (segmentată în telefon) e aproape, fundalul departe; mișcarea telefonului le mișcă diferit ── */
let segP = null; const depthCache = new Map();
function segModel(){ if(!segP){ segP = faceApi().then(f => f.tf.loadGraphModel('vendor/seg/selfie.json').then(m => ({tf:f.tf, m}))); segP.catch(() => { segP = null; }); } return segP; }
async function segMask(img){   // 256×256, 0…1: cât de sigur e persoană în fiecare punct
  const {tf, m} = await segModel();
  const y = tf.tidy(() => { let o = m.execute(tf.image.resizeBilinear(tf.browser.fromPixels(img), [256, 256]).toFloat().div(255).expandDims(0)); if(Array.isArray(o)) o = o[0]; return o.reshape([256 * 256]); });
  const a = await y.data(); y.dispose();
  let mn = Infinity, mx = -Infinity; for(const x of a){ if(x < mn) mn = x; if(x > mx) mx = x; }
  if(mn < -.05 || mx > 1.05) for(let i = 0; i < a.length; i++) a[i] = 1 / (1 + Math.exp(-a[i]));   // ieșire ne-normalizată → probabilitate
  return a;
}
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// fără model: silueta aproximată din față și umeri
function geoMask(x, y, G){
  const hx = (x - G.cx) / (G.fw * .62), hy = (y - G.cy) / (G.fh * .9), head = 1 - smooth01(.8, 1.15, Math.hypot(hx, hy));
  const top = Math.min(G.shL[1], G.shR[1]) - G.fh * .15, l = Math.min(G.shL[0], G.shR[0]) - G.fw * .2, r = Math.max(G.shL[0], G.shR[0]) + G.fw * .2;
  const neck = y > G.cy && Math.abs(x - G.cx) < G.fw * .35 ? 1 : 0;
  const torso = y < top ? 0 : (1 - smooth01(0, G.fw * .25, l - x)) * (1 - smooth01(0, G.fw * .25, x - r)) * smooth01(top - G.fh * .1, top + G.fh * .1, y);
  return Math.max(head, torso, neck);
}
function blurF(a, W, H, rad){
  const t = new Float32Array(a.length);
  for(let j = 0; j < H; j++) for(let i = 0; i < W; i++){ let s = 0, n = 0; for(let k = -rad; k <= rad; k++){ const ii = i + k; if(ii >= 0 && ii < W){ s += a[j * W + ii]; n++; } } t[j * W + i] = s / n; }
  for(let i = 0; i < W; i++) for(let j = 0; j < H; j++){ let s = 0, n = 0; for(let k = -rad; k <= rad; k++){ const jj = j + k; if(jj >= 0 && jj < H){ s += t[jj * W + i]; n++; } } a[j * W + i] = s / n; }
}
function depthMap(mask, G){
  const DW = 128, DH = Math.max(32, Math.min(256, Math.round(128 * G.H / G.W))), out = new Float32Array(DW * DH);
  for(let j = 0; j < DH; j++) for(let i = 0; i < DW; i++){
    const u = (i + .5) / DW, v = (j + .5) / DH, x = u * G.W, y = v * G.H;
    let p;
    if(mask){ const fx = Math.min(254.999, Math.max(0, u * 256 - .5)), fy = Math.min(254.999, Math.max(0, v * 256 - .5)), x0 = fx | 0, y0 = fy | 0, dx = fx - x0, dy = fy - y0;
      p = mask[y0 * 256 + x0] * (1 - dx) * (1 - dy) + mask[y0 * 256 + x0 + 1] * dx * (1 - dy) + mask[(y0 + 1) * 256 + x0] * (1 - dx) * dy + mask[(y0 + 1) * 256 + x0 + 1] * dx * dy; }
    else p = geoMask(x, y, G);
    let d = (.12 + .22 * v) * (1 - p) + .72 * p;                                  // fundalul: jos (masa, podeaua) e mai aproape
    const ex = (x - G.cx) / (G.fw * .62), ey = (y - G.cy) / (G.fh * .8), r2 = ex * ex + ey * ey;
    if(r2 < 1) d += .2 * (1 - r2) * Math.max(p, .5);                             // fața iese puțin în față (nasul cel mai aproape)
    out[j * DW + i] = Math.min(1, d);
  }
  blurF(out, DW, DH, 2); blurF(out, DW, DH, 2);
  const u8 = new Uint8Array(DW * DH); for(let i = 0; i < u8.length; i++) u8[i] = Math.round(out[i] * 255);
  return {DW, DH, u8, seg:!!mask};
}
async function vfDepth(c, tok, img, G){
  const V = c.vf; if(!V || S.callDepth === 'off') return;
  const key = img.currentSrc || img.src;
  let d = depthCache.get(key);
  if(!d){
    let mask = null; try{ mask = await segMask(img); }catch(e){ mask = null; }
    if(!c.vf || tok !== c.vf.tok || call !== c) return;
    d = depthMap(mask, G); depthCache.set(key, d);
  }
  if(!c.vf || tok !== c.vf.tok) return;
  const gl = V.g.gl;
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, V.g.dtex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, d.DW, d.DH, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, d.u8);
  gl.activeTexture(gl.TEXTURE0);
  V.dOn = true; V.dAt = performance.now(); V.dSeg = d.seg;
}
/* ── 📱 telefonul în mâna ei: ținut în mână, sprijinit de ceva, în mers; uneori îl apropie ── */
const RIG_WALK = /(merg\b|mergem|plimb|pe drum|în drum|in drum|pe stradă|pe strada|spre casă|spre casa|walking|on the way)/;
function rigPose(st, t, R){
  if(st === 'sprijinit') return {x:.05 * Math.sin(t * .21), y:.04 * Math.sin(t * .17 + 1), r:R.tilt + .03 * Math.sin(t * .13), s:1.1};
  const tr = .05 * Math.sin(t * 7.3) + .035 * Math.sin(t * 11.1 + 1);           // tremurul mâinii
  const P = {x:.45 * Math.sin(t * .31 + R.ph) + .22 * Math.sin(t * .73 + 1.3) + .08 * Math.sin(t * 1.9 + 2) + tr, y:.38 * Math.sin(t * .27 + 2) + .18 * Math.sin(t * .81) + .07 * Math.sin(t * 2.3 + 1) + tr * .8,
    r:.22 * Math.sin(t * .29 + .5) + .08 * Math.sin(t * 1.1), s:1.07};
  if(st === 'mers'){ const f = 1.85, b = Math.abs(Math.sin(t * Math.PI * f)); P.y += .9 * b - .45; P.x += .55 * Math.sin(t * Math.PI * f / 2); P.r += .5 * Math.sin(t * Math.PI * f / 2 + .4); P.s = 1.09; }
  return P;
}
function rigStart(c){
  const cvd = $('.callv .cvid'); if(!cvd || c.rig) return;
  const now = performance.now(), red = matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? .3 : 1;
  const lf = lifeNow(c.c), walk = RIG_WALK.test(callCtx(c)) && !(lf && lf.b === 2);
  c.rig = {st:walk ? 'mers' : 'mana', t0:now, next:now + (walk ? 25e3 : 45e3) + Math.random() * 60e3, tilt:0, zoom:0, zoomUntil:0, nextZoom:now + 30e3 + Math.random() * 40e3, red, ph:Math.random() * 6, x:0, y:0, r:0, s:1.07, cvd};
  cvd.classList.add('rig');
  const loop = t => { if(call !== c || !c.rig) return; c.rig.raf = requestAnimationFrame(loop); if(document.hidden || !c.video || t - (c.rig.last || 0) < 30) return; c.rig.last = t; rigStep(c, t); };
  c.rig.raf = requestAnimationFrame(loop);
}
function rigStep(c, now){
  if(c.glitch && now < c.glitch.freezeUntil) return;   // 9.81: imaginea înghețată nu se mai mișcă nici ea
  const R = c.rig, t = now / 1000;
  if(now > R.next){
    R.from = {x:R.x, y:R.y, r:R.r, s:R.s}; R.t0 = now;
    R.st = R.st === 'mana' ? (Math.random() < .55 ? 'sprijinit' : 'mana') : 'mana';
    if(R.st === 'sprijinit') R.tilt = (Math.random() < .5 ? -1 : 1) * (.4 + Math.random() * .7);
    R.next = now + (R.st === 'sprijinit' ? 60e3 + Math.random() * 120e3 : 45e3 + Math.random() * 90e3);
  }
  let P = rigPose(R.st, t, R);
  const k = Math.min(1, (now - R.t0) / 1400);
  if(R.from && k < 1){ const e = k * k * (3 - 2 * k); P = {x:R.from.x + (P.x - R.from.x) * e, y:R.from.y + (P.y - R.from.y) * e + Math.sin(Math.PI * k) * (R.st === 'sprijinit' ? 1.4 : -.9), r:R.from.r + (P.r - R.from.r) * e, s:R.from.s + (P.s - R.from.s) * e}; }
  if(R.st !== 'mers' && now > R.nextZoom){ R.zoomUntil = now + 6e3 + Math.random() * 7e3; R.nextZoom = now + 35e3 + Math.random() * 50e3; }
  R.zoom += ((now < R.zoomUntil ? .055 : 0) - R.zoom) * .03;                    // își apropie telefonul de față
  R.x = P.x * R.red; R.y = P.y * R.red; R.r = P.r * R.red; R.s = P.s + R.zoom;
  R.cvd.style.setProperty('--rig', `translate(${R.x.toFixed(3)}%,${R.y.toFixed(3)}%) rotate(${R.r.toFixed(3)}deg) scale(${R.s.toFixed(4)})`);
  if(c.showEl) c.showEl.style.setProperty('--rig2', `translate(${(R.x * 1.8).toFixed(3)}%,${(R.y * 1.8).toFixed(3)}%) rotate(${(-2.5 + R.r * 2.5).toFixed(3)}deg)`);
}
/* ── 💡 lumina ei reală: ora ei, răsăritul / apusul și norii din orașul ei, lampa seara, lumina ecranului ── */
async function litUpdate(c){
  let w = null; try{ w = await weatherOf(c.c); }catch(e){}
  if(call !== c) return;
  const d = charNow(c.c), m = d.getHours() * 60 + d.getMinutes(), sr = w && w.sr != null ? w.sr : 420, ss = w && w.ss != null ? w.ss : 1140;
  const txt = callCtx(c), out = /(afar[ăa]|strad|\bparc|plaj|munte|pădur|padur|grădin|gradin|terasă|terasa|outside|street|\bpark\b|beach|garden|terrace)/.test(txt);
  const cloudy = !!(w && [3, 45, 48].includes(w.code)), wet = !!(w && w.fx);
  let gn, sat, fl, kind;
  if(m > sr + 45 && m < ss - 45){ kind = 'zi'; if(wet){ gn = [.95, .98, 1.04]; sat = .88; fl = out ? .93 : .95; } else if(cloudy){ gn = [.97, .99, 1.03]; sat = .92; fl = .97; } else { gn = [1.015, 1, .985]; sat = 1.03; fl = 1.01; } }
  else if(Math.abs(m - ss) <= 45 || Math.abs(m - sr) <= 45){ kind = 'auriu'; gn = cloudy || wet ? [1.03, 1, .95] : [1.07, 1, .88]; sat = cloudy || wet ? .95 : 1.06; fl = .99; }
  else { kind = 'noapte'; gn = out ? [.94, .97, 1.06] : [1.05, .99, .87]; sat = .93; fl = d.getHours() < 6 || d.getHours() >= 23 ? .9 : .94; }
  const screen = /(film|serial|netflix|televizor|\btv\b|youtube|laptop|calculator|gaming|movie|series|watching)/.test(txt);
  c.lit = {cur:(c.lit && c.lit.cur) || {gn:[1, 1, 1], sat:1, fl:1}, tgn:gn, tsat:sat, tfl:fl, kind, screen, f:1, fT:1, fB:1, fAt:0};
  // 9.81: fundalul viu (după loc, vreme, oră) și granulația camerei (noaptea mai multă, ca la un telefon pe întuneric)
  const park = /(\bparc|pădur|padur|grădin|gradin|terasă|terasa|\bpark\b|garden|forest)/.test(txt);
  c.bgfx = {sway:out ? ((w && w.wind > 12) || park ? .9 : .4) : 0, rain:wet ? (out ? .5 : .9) : 0, dapple:out && kind === 'zi' && park && !cloudy && !wet ? .8 : 0, sweep:!out, night:kind === 'noapte'};
  const cvd = $('.callv .cvid'); if(cvd) cvd.style.setProperty('--gr', kind === 'noapte' ? .17 : kind === 'auriu' ? .12 : .08);
}
function litStep(c, now){
  const L = c.lit; if(!L) return null;
  const C = L.cur, k = .02;
  C.gn = C.gn.map((v, i) => v + (L.tgn[i] - v) * k); C.sat += (L.tsat - C.sat) * k; C.fl += (L.tfl - C.fl) * k;
  let f = 1, b = 1;
  if(L.screen){   // pâlpâirea ecranului (televizor, laptop), mai vizibilă seara
    const amp = L.kind === 'noapte' ? 1 : .4;
    if(now > L.fAt){ L.fT = 1 + (Math.random() * .1 - .06) * amp; L.fB = 1 + (Math.random() < .5 ? .035 : -.01) * amp; L.fAt = now + 250 + Math.random() * 1100; }
    L.f += (L.fT - L.f) * .25; f = L.f; b = L.fB;
  }
  return {gn:[C.gn[0], C.gn[1], C.gn[2] * b], sat:C.sat, fl:C.fl * f};
}
/* ── 🔄 „stai să-ți arăt”: o poză din telefonul ei (din chat și din stories), ținută la cameră ── */
const SHOW_SKIP = /\b(nude|naked|topless|undress|undressed|lingerie|underwear|no clothes|bare breasts|bare chest)\b/i;
function showWhen(ts){ const d = Math.round((new Date(dayKey(Date.now()) + 'T12:00') - new Date(dayKey(ts) + 'T12:00')) / 864e5); return d <= 0 ? 'azi' : d === 1 ? 'ieri' : `acum ${d} zile`; }
function showList(c){
  if(c._show && Date.now() - c._showAt < 60e3) return c._show;
  const skip = new Set(c.pics || []), out = [];
  const add = (k, ts, scene) => { if(!k || skip.has(k) || !scene || SHOW_SKIP.test(scene) || out.some(x => x.k === k) || Date.now() - (ts || 0) > 14 * 864e5) return; out.push({k, ts:ts || 0, scene:String(scene).replace(/\s+/g, ' ').slice(0, 90)}); };
  for(const m of [...c.ch.msgs].reverse()) if(m.role === 'ai' && m.img && !m.err) add(m.img, m.ts, m.scene);
  for(const p of (typeof feedCache !== 'undefined' ? feedCache : []).filter(x => x.cid === c.c.id && x.img)) add(p.img, p.ts, p.scene);
  out.sort((a, b) => b.ts - a.ts); c._show = out.slice(0, 6); c._showAt = Date.now();
  return c._show;
}
function showNote(c){
  if(!c || !c.video || !c.ch || (c.showN || 0) >= 3 || Date.now() - (c.lastShow || 0) < 120e3) return '';
  const L = showList(c); if(!L.length) return '';
  return `. Ai în telefon câteva poze de-ale tale pe care i le poți arăta la cameră, doar dacă vine vorba firesc (rar, nu în fiecare replică): ${L.map((x, i) => `${i + 1}) ${showWhen(x.ts)}: „${x.scene}”`).join('; ')}. Ca să i-o arăți, spune firesc ceva ca „stai să-ți arăt” și adaugă la final [arăt: numărul pozei]`;
}
function showPhoto(c, it){
  const v = $('.callv'); if(!v || !c.video || call !== c || !it) return;
  showHide(c, true);
  const el = document.createElement('div'); el.className = 'cshow';
  el.innerHTML = `<div class="cshphone"><img data-k="${esc(it.k)}" data-show="${esc(it.k)}" alt=""><i class="glare"></i></div><small>📱 ${esc(c.c.name)} îți arată o poză · ${esc(showWhen(it.ts))}</small>`;
  const sv = v.querySelector('.cself'); if(sv) sv.before(el); else v.appendChild(el);
  hydrate(el); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  setTimeout(() => el.classList.add('settled'), 650);
  v.classList.add('showing'); c.showEl = el; c.lastShow = Date.now(); c.showN = (c.showN || 0) + 1; c.shown = it;
  el.onclick = e => { e.stopPropagation(); showHide(c); };
  clearTimeout(c.showT); c.showT = setTimeout(() => { if(c.state !== 'speak') showHide(c); }, 9000);
}
function showHide(c, now){
  const el = c.showEl; if(!el) return; c.showEl = null; clearTimeout(c.showT);
  const v = $('.callv'); if(v) v.classList.remove('showing');
  if(now){ el.remove(); return; }
  el.classList.remove('on', 'settled'); el.classList.add('out'); setTimeout(() => el.remove(), 500);
}
/* ── 👁️ prezența ta (local, din camera ta; nimic nu pleacă nicăieri): ieși din cadru, te uiți în altă parte, întuneric, distanță ── */
const PRES_ASK = ['Alo? Mai ești acolo?', 'Hei, unde ai dispărut?', 'Ești acolo? Nu te mai văd.', 'Mă auzi? Unde ai plecat?'];
function presStart(c){ if(c.presT) return; c.pres = {here:true, awayAt:0, lookAt:0, darkAt:0, nearAt:0, farAt:0, asked:0, askN:0, notes:[], told:{}}; c.presT = setInterval(() => presTick(c), 1100); }
function presNote(c, k, t, every){ const P = c.pres, now = Date.now(); if(P.told[k] && now - P.told[k] < every) return; P.told[k] = now; P.notes = P.notes.filter(n => n.k !== k).concat({k, t}); }
function presTake(c){ const P = c.pres; if(!P || !P.notes.length) return ''; const t = P.notes.map(n => n.t).join('; '); P.notes = []; return t; }
async function presTick(c){
  if(call !== c || c.presBusy || S.callPres === 'off' || !c.video || !c.see || !c.cam || c.facing !== 'user' || document.hidden || !c.t0) return;
  const sv = $('.callv .cself'); if(!sv || !sv.videoWidth) return;
  c.presBusy = true;
  try{
    const f = await faceApi(); if(call !== c) return;
    const th = lumaThumb(sv); let lum = 0; for(const x of th) lum += x; lum /= th.length;
    // 9.81: expresia ta (zâmbet, râs, surpriză, tristețe), cu modelul mic de expresii (330 KB, în telefon)
    if(S.callMirror !== 'off' && !f.nets.faceExpressionNet.isLoaded && !presExprFail){ try{ await f.nets.faceExpressionNet.loadFromUri(FA + 'model'); }catch(e){ presExprFail = true; } }
    const withEx = S.callMirror !== 'off' && f.nets.faceExpressionNet.isLoaded;
    let q0 = f.detectAllFaces(sv, new f.TinyFaceDetectorOptions({inputSize:224, scoreThreshold:.45})).withFaceLandmarks(); if(withEx) q0 = q0.withFaceExpressions();
    const r = (await q0).sort((a, b) => b.detection.box.area - a.detection.box.area)[0];
    if(call !== c) return;
    if(r && r.expressions) presMirror(c, r);
    const now = Date.now(), P = c.pres, V = c.vf;
    if(lum < 38){ P.darkAt = P.darkAt || now; if(now - P.darkAt > 4000) presNote(c, 'dark', 'la el e foarte întuneric, abia îl vezi', 120e3); } else P.darkAt = 0;
    if(!r){
      if(lum < 38 || !P.seen) return;                                           // pe întuneric nu se vede fața, dar el e acolo; și doar după ce te-a văzut o dată
      if(P.here){ P.here = false; P.awayAt = now; }
      const away = now - P.awayAt;
      if(V) V.search = away > 2500;
      if(away > 5000 && c.state === 'speak' && !P.held){ P.held = true; c.holdNext = true; }   // termină propoziția și te așteaptă
      if(away > 15e3 && !P.asked && P.askN < 3 && c.state === 'listen' && !c.interim && langOf(c.c) === 'ro-RO') presAsk(c);
      return;
    }
    P.seen = true;
    if(!P.here){
      const away = now - P.awayAt; P.here = true; P.held = false; if(V) V.search = false;
      if(away > 6000){ presNote(c, 'back', `a ieșit din cadru și a revenit după vreo ${Math.round(away / 1000)} de secunde${P.asked ? ' (îl întrebaseși dacă mai e acolo)' : ''}`, 0); if(V){ V.smileT = performance.now(); V.lensUntil = performance.now() + 1800; V.sacAt = 0; } }
      P.asked = 0;
    }
    const L = r.landmarks.positions, fw = Math.max(1, L[16].x - L[0].x), yaw = (L[30].x - (L[0].x + L[16].x) / 2) / (fw / 2);
    const eyeY = (L[36].y + L[45].y) / 2, pitch = (L[30].y - eyeY) / Math.max(1, L[8].y - eyeY);
    if(Math.abs(yaw) > .42 || pitch > .62){
      P.lookAt = P.lookAt || now;
      if(now - P.lookAt > 4000) presNote(c, 'look', Math.abs(yaw) <= .42 ? 'se uită în jos de câteva secunde, nu la tine' : 'se uită în altă parte de câteva secunde', 60e3);
      if(V && now - P.lookAt > 1200 && !(P.peekAt > P.lookAt)){ P.peekAt = now; V.peek = {dir:yaw > 0 ? -1 : 1, until:performance.now() + 1100}; }   // se uită și ea într-acolo
    } else P.lookAt = 0;
    const ar = r.detection.box.width / sv.videoWidth;
    if(ar > .5){ P.nearAt = P.nearAt || now; if(now - P.nearAt > 3000) presNote(c, 'near', 'și-a apropiat mult fața de cameră', 90e3); } else P.nearAt = 0;
    if(ar < .11){ P.farAt = P.farAt || now; if(now - P.farAt > 3000) presNote(c, 'far', 's-a îndepărtat de cameră, îl vezi mic, de departe', 90e3); } else P.farAt = 0;
  }catch(e){} finally { c.presBusy = false; }
}
// 9.81: te oglindește: zâmbește când zâmbești, râde cu tine, se miră odată cu tine; tristețea ta o observă și o spune AI-ului
let presExprFail = false;
function presMirror(c, r){
  const V = c.vf, E = r.expressions, P = c.pres, now = performance.now(), L = r.landmarks.positions;
  const open = (L[66].y - L[62].y) / Math.max(1, L[8].y - L[27].y);
  if(E.happy > .7){ P.hapAt = P.hapAt || Date.now();
    if(V && (!V.mirAt || now - V.mirAt > 4000)){ V.mirAt = now; V.smileT = now; if(E.happy > .85 && open > .08) V.laughT = now; }
    if(Date.now() - P.hapAt > 2500) presNote(c, 'smile', open > .08 ? 'râde' : 'zâmbește larg', 90e3); } else P.hapAt = 0;
  if(E.surprised > .6 && V && (!V.surAt || now - V.surAt > 5000)){ V.surAt = now; V.brow = now; }
  if(E.sad > .55){ P.sadAt = P.sadAt || Date.now(); if(Date.now() - P.sadAt > 3500) presNote(c, 'sad', 'pare trist sau îngândurat', 150e3); } else P.sadAt = 0;
}
// nu te mai vede de ~15 s: te strigă (local, fără apel la AI); află și ea la replica următoare
function presAsk(c){
  const P = c.pres; P.asked = Date.now(); P.askN++;
  const q = PRES_ASK[Math.floor(Math.random() * PRES_ASK.length)];
  const r0 = c.rec; c.rec = null; try{ r0 && r0.abort(); }catch(e){}            // microfonul nu trebuie să o audă pe ea
  c.state = 'speak'; callState('vorbește', 'speak');
  const off = (c.capOn = false, capAppend(c, q));
  presNote(c, 'ask', `nu-l mai vedeai în cadru și l-ai întrebat: „${q}”`, 0);
  callSay(c, q, off).then(() => { if(call !== c) return; try{ c.bargeRec && c.bargeRec.abort(); }catch(e){} c.bargeRec = null; c.state = 'idle'; callListen(true); });
}
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
  t = bcClean(c, t); if(!t) return;   // 9.23: „îhî”-ul ei, auzit de microfon, nu intră în ce ai spus
  c.lastHeard = t;   // 9.62: pentru „hm…”-ul de dinaintea răspunsului
  const rx = c.reacts.splice(0).join('');
  c.ch.msgs.push({id:uid(), role:'user', text:t[0].toUpperCase() + t.slice(1) + (rx ? ` (în timpul apelului ți-a trimis ${rx})` : ''), ts:Date.now(), call:true, video:c.video || undefined, seen:true});
  await saveChat(c.c, c.ch);
  callReply({liveImg:callFrame(c), pres:presTake(c)});
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
  c.bcStart = 0; c.bcWords = 0; c.bcPause = false;   // 9.23
  if(!quiet && S.callTick !== 'off') callTick();
  r.onresult = e => { let t = ''; for(let i = 0; i < e.results.length; i++){ t += e.results[i][0].transcript; if(e.results[i].isFinal) final = t; } interim = t.trim(); c.interim = interim; lastT = Date.now(); c.bcStart = c.bcStart || lastT; c.heardAt = performance.now(); $('#clCap').innerHTML = `<span class="cme">${esc(interim)}</span>`; };
  // 8.14: nu mai așteptăm pauza lungă a telefonului: după ~0,85 s de liniște încheiem noi
  const watch = setInterval(() => { if(c.rec !== r){ clearInterval(watch); return; } if(interim && lastT && Date.now() - lastT > 850){ clearInterval(watch); try{ r.stop(); }catch(e){} return; } bcMaybe(c, interim, lastT); }, 110);
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
  const answer = async vid => { try{ window.__acPre = new (window.AudioContext || window.webkitAudioContext)(); window.__acPre.resume().catch(() => {}); }catch(e){} close();   // 9.23: sunetul apelului pornește din atingerea ta
 if(busy && live) busy.abort(); for(let k = 0; k < 40 && busy; k++) await sleep(150); if(!cur || cur.id !== c.id || $('#vChat').hidden) await openChat(c.id); startCall({video:vid, incoming:true, reason:opts.reason}); };
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
async function viewImg(k, list, meta, vopt = {}){
  if(!list && chat && !$('#vChat').hidden){ const ms = chat.msgs.filter(m => m.img && !m.err); list = ms.map(m => m.img); meta = meta || Object.fromEntries(ms.map(m => [m.img, {ts:m.ts, scene:m.scene}])); }
  if(!list) list = [k];
  meta = meta || {};
  if(!list.includes(k)) list = [k];
  let idx = list.indexOf(k);
  const v = document.createElement('div'); v.className = 'viewer';
  v.innerHTML = `<div class="vbg"></div><img class="vimg" alt="" draggable="false">
    <div class="vtop"><span class="vcount"></span><span class="vsr" hidden></span><button class="ib vplay" aria-label="Prezentare" hidden>▶</button><button class="ib x" aria-label="Închide">✕</button></div><div class="vcap"></div>
    <button class="ib vnav l" aria-label="Înapoi">‹</button><button class="ib vnav r" aria-label="Înainte">›</button>
    <div class="vbar"><button class="btn" id="vwFace" hidden>👤 Față</button><button class="btn" id="vwSave">⬇ Salvează</button>${canShareFiles() ? '<button class="btn" id="vwShare">↗️ Trimite</button>' : ''}<button class="btn" id="vwRe" hidden>🎲 Alta</button></div>`;
  document.body.appendChild(v);
  const img = v.querySelector('.vimg'), bg = v.querySelector('.vbg');
  let sc = 1, tx = 0, ty = 0;
  const apply = (anim) => { img.style.transition = anim ? 'transform .25s ease' : 'none'; img.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`; };
  const fit = () => { const r = img.getBoundingClientRect(); return r; };
  async function load(i, dir){
    idx = (i + list.length) % list.length;
    const raw = /^(blob|data):/.test(String(list[idx]));   // 9.24: și variante încă nesalvate (adrese blob:)
    const u = raw ? list[idx] : await imgUrl(list[idx]); if(!u) return;
    v.querySelector('#vwSave').hidden = raw; const shb = v.querySelector('#vwShare'); if(shb) shb.hidden = raw;
    const fb = vopt.face && vopt.face[list[idx]]; v.querySelector('#vwFace').hidden = !fb; v.querySelector('#vwFace').textContent = '👤 Față';
    img.style.transition = 'none'; img.style.opacity = '0';
    img.src = u; bg.style.backgroundImage = `url("${u}")`;
    sc = 1; tx = dir ? dir * 60 : 0; ty = 0; apply();
    await img.decode?.().catch(() => {});
    // centrăm: originea transformării e colțul stânga-sus al imaginii afișate
    requestAnimationFrame(() => { img.style.transition = 'transform .25s ease, opacity .2s'; img.style.opacity = '1'; tx = 0; apply(true); });
    // 9.87 (3): mărirea 2× pe telefon (o dată pe poză; apoi se ia din memorie)
    if(!raw && S.sr !== 'off'){ const my = idx, key = list[idx], badge = v.querySelector('.vsr'); badge.hidden = false; badge.textContent = '✨ Detaliu 2×…';
      srGet(key, () => document.body.contains(v) && idx === my, p => { if(idx === my) badge.textContent = `✨ Detaliu 2× · ${Math.round(p * 100)}%`; }).then(x => {
        if(idx !== my || !document.body.contains(v)) return; if(!x){ badge.hidden = true; return; }
        const su = URL.createObjectURL(x); const pre = new Image(); pre.onload = () => { if(idx !== my) return; img.src = su; badge.textContent = '✨ Detaliu 2×'; setTimeout(() => { if(idx === my) badge.hidden = true; }, 1600); }; pre.src = su; }); }
    else v.querySelector('.vsr').hidden = true;
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
  // 9.24: „👤 Față”: mărește direct pe față (și înapoi la poza întreagă)
  v.querySelector('#vwFace').onclick = () => {
    const fb = vopt.face && vopt.face[list[idx]], btn = v.querySelector('#vwFace'); if(!fb) return;
    if(sc > 1){ sc = 1; tx = 0; ty = 0; apply(true); btn.textContent = '👤 Față'; return; }
    sc = 1; tx = 0; ty = 0; apply();
    const r = img.getBoundingClientRect(), ns = Math.max(1.5, Math.min(5, .55 * Math.min(innerWidth / (fb.w * r.width), innerHeight / (fb.h * r.height))));
    const fx = (fb.x + fb.w / 2) * r.width, fy = (fb.y + fb.h / 2) * r.height;
    sc = ns; tx = innerWidth / 2 - r.left - fx * ns; ty = innerHeight / 2 - r.top - fy * ns; apply(true); btn.textContent = '🧍 Tot corpul';
  };
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

/* ═════════ 🧍 9.24–9.25: personajul din descriere: poza întreagă, din cap până-n picioare ═════════
   9.25 (rafinat): (1) descriere liberă + zone în română, editabile (vârstă și gen, față, păr, corp, mâini și detalii, ținută,
   încălțăminte, poziție, loc, lumină), cu „✨ Îmbogățește pe zone”; corpul are selectori (înălțime, constituție, umeri, bust
   mărime și formă, talie, abdomen, șolduri, fese, picioare, brațe, ten) + text liber; (2) zonele se traduc o dată în prompt
   englez (doar afișat), refăcut doar când se schimbă ceva; (3) 4 variante, verificate în telefon (față, corp în cadru) și de
   Claude (mâini, degete, picioare: pornit implicit); „⏹ Oprește”; (4) după „Alege”: portretul de profil din poza întreagă,
   2 unghiuri automat (se poate opri), descrierea recitită; „🪄 Ajustează” și „🔁 Mai multe ca asta”, cu aceeași persoană.
   Poza întreagă stă separat (`c.photoFull`); `c.photo` rămâne portretul folosit de avatar, carduri, apel și pozele din chat.
   Motorul de poze din chat nu se schimbă. */
const CR_FRAMES = {
  full:{l:'🧍 Corp întreg', size:'832x1248', p:'Full-body photo: the whole person is visible from the top of the head down to the feet, both feet and shoes completely inside the frame with a little floor visible below them, both arms and both hands visible, vertical 2:3 framing, nothing cropped'},
  '34':{l:'Trei sferturi', size:'832x1248', p:'Three-quarter shot from the top of the head down to just below the knees, both arms and both hands visible, vertical framing'},
  portrait:{l:'Portret', size:'768x1024', p:'Head and shoulders portrait, the face large and sharp, looking at the camera'}};
const CR_HANDS = 'Natural, anatomically correct hands with exactly five fingers each, relaxed and clearly visible.';
const CR_MINOR = /\b([1-9]|1[0-7])\s*(de\s*)?ani\b|\b([1-9]|1[0-7])\s*(years?|yo)\b|\b(copil|copilă|copii|fetiț|băiețel|baietel|adolescent|minor[ăa]?\b|elev[ăa]? de liceu|liceană|liceana|școlăriț|scolarit|teen|child|kid\b|underage)/i;
// zonele descrierii (română); „corp” are și selectorii de mai jos
const CR_ZONES = [['gen', 'Vârstă și gen', 'ex. femeie, 28 de ani'], ['fata', 'Față', 'formă, ochi, sprâncene, nas, buze, ten, pistrui, alunițe, machiaj'], ['par', 'Păr', 'culoare, lungime, textură, coafură, breton'],
  ['corp', 'Corp: alte detalii', 'orice altceva despre corp'], ['maini', 'Mâini și detalii', 'unghii, inele, brățări, tatuaje și piercinguri (cu locul), ochelari'], ['tinuta', 'Ținută', 'haine, culori, accesorii'],
  ['incaltaminte', 'Încălțăminte', 'ex. sandale albe'], ['poza', 'Poziție', 'ex. în picioare, relaxată, o mână în buzunar'], ['loc', 'Loc', 'ex. o terasă la apus'], ['lumina', 'Lumină', 'ex. lumină caldă de apus']];
const CR_BODY = [['build', 'Constituție', ['slabă', 'suplă', 'atletică', 'medie', 'curbilinie', 'plinuță', 'plină', 'musculoasă']], ['tone', 'Tonus', ['moale', 'normal', 'tonifiat', 'definit']], ['shoulders', 'Umeri', ['înguști', 'medii', 'lați']],
  ['neck', 'Gât', ['scurt', 'mediu', 'lung']], ['posture', 'Postură', ['dreaptă', 'relaxată']], ['torsoLen', 'Trunchi: lungime', ['scurt', 'mediu', 'lung']],
  ['bust', 'Bust / piept: mărime', ['plat', 'mic', 'mediu', 'mare', 'foarte mare']], ['bustShape', 'Bust: formă', ['rotund', 'natural, în formă de lacrimă', 'ridicat, ferm', 'ușor lăsat', 'depărtat', 'apropiat']],
  ['waist', 'Talie', ['foarte îngustă', 'îngustă', 'medie', 'lată']], ['belly', 'Abdomen', ['plat', 'tonifiat', 'ușor rotunjit', 'rotunjit']], ['hips', 'Șolduri', ['înguste', 'medii', 'late', 'foarte late']],
  ['glutes', 'Fese', ['mici', 'medii', 'rotunde', 'pline']], ['legsLen', 'Picioare: lungime', ['lungi', 'medii', 'scurte']], ['legs', 'Picioare: formă', ['subțiri', 'tonifiate', 'pline', 'musculoase']],
  ['arms', 'Brațe', ['subțiri', 'tonifiate', 'pline', 'musculoase']], ['skin', 'Tenul corpului', ['foarte deschis', 'deschis', 'măsliniu', 'bronzat', 'închis']]];
const CR_BODY_LBL = {tone:'tonus', neck:'gât', posture:'postură', torsoLen:'trunchi', build:'constituție', shoulders:'umeri', bust:'bust', bustShape:'formă bust', waist:'talie', belly:'abdomen', hips:'șolduri', glutes:'fese', legsLen:'picioare', legs:'picioare', arms:'brațe', skin:'ten'};
const CR_ADJ = [['👗 Altă ținută', 'altă ținută'], ['💇 Alt păr', 'altă coafură'], ['🪶 Mai suplă', 'corp mai suplu, cu proporții firești'], ['🍑 Mai plinuță', 'corp mai plin, cu proporții firești'], ['🏋️ Mai atletică', 'corp mai atletic, tonifiat'],
  ['⬆️ Bust mai mare', 'bust mai mare, natural'], ['⬇️ Bust mai mic', 'bust mai mic, natural'], ['📏 Mai înaltă', 'mai înaltă, cu proporții firești'], ['🕺 Altă poziție', 'altă poziție a corpului, la fel de naturală'], ['🏙️ Alt loc', 'alt loc în fundal'], ['😊 Zâmbet', 'un zâmbet cald, natural']];
const crModel = (n, size) => {
  if(S.imgProv !== 'worker') return undefined;
  if(S.wkChat !== 'ancorat') return 'eco';
  return rwFor('ancorat') || !Number.isFinite(capLeft()) || capLeft() >= n * (neurPerPhoto('ancorat', size) || 1455) + ECO_RESERVE ? 'ancorat' : 'eco';
};
const crStil = () => $('#edStil').value || 'photo';
// poza întreagă a unui personaj salvat, pe tot ecranul (cu „Față”); apoi portretul de profil
function viewFull(c){ if(!c || !c.photoFull) return; viewImg(c.photoFull, [c.photoFull, c.photo].filter(Boolean), null, {face:c.fullBox ? {[c.photoFull]:c.fullBox} : {}}); }
/* ── corpul: selectori + text ── */
function crBodyText(Z){
  const b = (Z && Z.body) || {}, p = [];
  if(+b.h) p.push(`înălțime ${(+b.h / 100).toFixed(2).replace('.', ',')} m`);
  for(const [k] of CR_BODY) if(b[k]) p.push(`${CR_BODY_LBL[k]} ${b[k]}`);
  const free = String((Z && Z.zones && Z.zones.corp) || '').trim(); if(free) p.push(free);
  return p.join('; ');
}
function crDrawBody(){   // 9.86: editorul de corp pe grupuri (același ca în „Modifică poza”)
  const box = $('#edBody'); if(!box || !ed || !ed.cr) return;
  bodyEdBind(box, ed.cr.z.body, null, crZoneChanged, 'edBodyH')();
}
function crBodyEvents(){}   // 9.86: evenimentele le leagă bodyEdBind
/* ── zonele ── */
const crEmptyZ = () => ({zones:Object.fromEntries(CR_ZONES.map(([k]) => [k, ''])), body:{h:0, ...Object.fromEntries(CR_BODY.map(([k]) => [k, '']))}});
const crHasZ = Z => !!Z && (Object.values(Z.zones).some(v => String(v).trim()) || Object.entries(Z.body).some(([k, v]) => k === 'h' ? +v : v));
function crDrawZones(){
  const box = $('#edZones'); if(!box || !ed || !ed.cr) return;
  box.innerHTML = CR_ZONES.map(([k, l, ph]) => k === 'corp'
    ? `<div class="crz body"><label>🧍 Corp</label><div id="edBody"></div><textarea data-z="corp" rows="2" placeholder="${esc(ph)}">${esc(ed.cr.z.zones.corp || '')}</textarea></div>`
    : `<div class="crz"><label>${esc(l)}</label><textarea data-z="${k}" rows="${k === 'fata' || k === 'tinuta' ? 2 : 1}" placeholder="${esc(ph)}">${esc(ed.cr.z.zones[k] || '')}</textarea></div>`).join('');
  crDrawBody(); crBodyEvents();
  box.oninput = e => { const k = e.target.dataset && e.target.dataset.z; if(!k || !ed || !ed.cr) return; ed.cr.z.zones[k] = e.target.value; crZoneChanged(); };
}
function crZoneChanged(){ if(ed && ed.cr) $('#edZoneHint').textContent = crHasZ(ed.cr.z) ? 'Se generează după zone. Schimbă orice zonă și apasă din nou „Generează”.' : ''; }
// 9.26: cereri JSON robuste pentru creator: dacă AI-ul răspunde fără JSON, se mai cere o dată, mai strict; un refuz e spus clar
async function crAskJSON(sys, text, max){
  let last = '';
  for(let k = 0; k < 2; k++){
    const meta = {};
    const out = await stream(sys, [{role:'user', text:k ? text + '\n\nIMPORTANT: răspunde DOAR cu obiectul JSON cerut, care începe cu { și se termină cu }, fără niciun alt text.' : text}], {max:k ? Math.round(max * 1.5) : max, aux:true, meta});
    if(meta.stop === 'refusal') throw new Error('AI-ul n-a vrut să prelucreze descrierea. Reformulează mai neutru și mai încearcă.');
    last = out;
    if(String(out).includes('{')){ try{ return parseJSON(out); }catch(e){ if(k) throw e; } }
  }
  throw new Error(/\b(nu pot|nu voi|can.?t|cannot|won.?t|unable)\b/i.test(last) ? 'AI-ul n-a vrut să prelucreze descrierea. Reformulează mai neutru și mai încearcă.' : 'AI-ul n-a răspuns cum trebuie de două ori. Mai încearcă.');
}
// JSON-ul de zone → zonele și butoanele de corp (doar valori exacte din liste)
function crZFrom(j){
  const Z = crEmptyZ();
  for(const [k] of CR_ZONES) Z.zones[k] = faraLiniute(String((j.zones || {})[k] || '').trim()).slice(0, 400);
  const jb = j.body || {};
  for(const [k, , opts] of CR_BODY){ const v = String(jb[k] || '').trim(); Z.body[k] = opts.includes(v) ? v : ''; }
  const h = Math.round(+jb.h || 0); Z.body.h = h >= 140 && h <= 205 ? Math.min(195, Math.max(145, h)) : 0;
  return Z;
}
// descrierea liberă → zone (română) + alegerile pentru corp; cu „îmbogățește”, completează și ce lipsește
async function crZones(ro, rich){
  const j = await crAskJSON('Organizezi descrieri de personaje pe zone, în română corectă. Răspunzi DOAR cu JSON valid.',
`Descrierea scrisă de utilizator:
"""${ro.slice(0, 2500)}"""
Împarte-o pe zone, păstrând EXACT tot ce a scris (nu contrazice nimic). ${rich ? 'Apoi completează zonele goale și adaugă detalii concrete, firești și coerente cu ce a scris (fără să schimbi ce a scris), ca descrierea să fie completă.' : 'Unde nu a scris nimic, lasă zona goală.'}
Personajul e întotdeauna adult (cel puțin 21 de ani).
Zone (text scurt, fiecare cel mult 35 de cuvinte): ${CR_ZONES.map(([k, l]) => `"${k}" = ${l}`).join('; ')}.
Pentru corp alege, dacă reiese din descriere${rich ? ' sau dacă ai completat' : ''}, câte o valoare EXACT din listele: ${CR_BODY.map(([k, l, o]) => `"${k}" (${l}): ${o.join(' | ')}`).join('; ')}; "h" = înălțimea în centimetri (0 dacă nu se știe). Ce nu intră în liste merge în zona "corp".
JSON: {"zones":{${CR_ZONES.map(([k]) => `"${k}":""`).join(',')}},"body":{"h":0${CR_BODY.map(([k]) => `,"${k}":""`).join('')}},"names":["3 prenume potrivite"]}`, 1800);
  const Z = crZFrom(j);
  if(!crHasZ(Z)) throw new Error('n-am putut înțelege descrierea; mai încearcă');
  return {Z, names:(Array.isArray(j.names) ? j.names : []).map(x => String(x).trim()).filter(x => x && x.length < 30).slice(0, 3)};
}
// 9.26: corpul ales pe butoane intră în prompt EXACT (fără traducere AI, care putea înmuia sau pierde detalii) și chiar după subiect
const CR_BODY_EN = {
  build:{'slabă':'very slim thin build', 'suplă':'slender build', 'atletică':'athletic toned build', 'medie':'average build', 'curbilinie':'curvy hourglass figure', 'plinuță':'soft chubby full-figured build', 'plină':'plus-size full-figured build', 'musculoasă':'muscular build'},
  shoulders:{'înguști':'narrow shoulders', 'medii':'average shoulders', 'lați':'broad shoulders'},
  tone:{'moale':'soft body with little muscle definition', 'normal':'normal muscle tone', 'tonifiat':'toned body', 'definit':'clearly defined muscles'},
  neck:{'scurt':'short neck', 'mediu':'average neck', 'lung':'long slender neck'}, posture:{'dreaptă':'upright straight posture', 'relaxată':'relaxed natural posture'},
  torsoLen:{'scurt':'short torso', 'mediu':'average torso length', 'lung':'long torso'},
  bust:{'plat':'flat chest', 'mic':'small bust', 'mediu':'medium bust', 'mare':'large bust', 'foarte mare':'very large bust'},
  bustShape:{'rotund':'round bust shape', 'natural, în formă de lacrimă':'natural teardrop-shaped bust', 'ridicat, ferm':'high firm bust', 'ușor lăsat':'naturally slightly sagging bust', 'depărtat':'wide-set bust', 'apropiat':'close-set bust'},
  waist:{'foarte îngustă':'very narrow waist', 'îngustă':'narrow waist', 'medie':'average waist', 'lată':'wide waist'},
  belly:{'plat':'flat stomach', 'tonifiat':'toned stomach', 'ușor rotunjit':'slightly soft rounded belly', 'rotunjit':'rounded belly'},
  hips:{'înguste':'narrow hips', 'medii':'average hips', 'late':'wide hips', 'foarte late':'very wide hips'},
  glutes:{'mici':'small buttocks', 'medii':'average buttocks', 'rotunde':'round buttocks', 'pline':'full buttocks'},
  legsLen:{'lungi':'long legs', 'medii':'average-length legs', 'scurte':'short legs'},
  legs:{'subțiri':'slim legs', 'tonifiate':'toned legs', 'pline':'full thighs and legs', 'musculoase':'muscular legs'},
  arms:{'subțiri':'slim arms', 'tonifiate':'toned arms', 'pline':'soft full arms', 'musculoase':'muscular arms'},
  skin:{'foarte deschis':'very fair skin', 'deschis':'fair skin', 'măsliniu':'olive skin', 'bronzat':'tanned skin', 'închis':'dark skin'}};
function crBodyEn(Z){
  const b = (Z && Z.body) || {}, p = [];
  if(+b.h) p.push(`${+b.h} cm tall${+b.h < 158 ? ' (petite)' : +b.h > 178 ? ' (tall)' : ''}`);
  for(const [k] of CR_BODY) if(b[k] && CR_BODY_EN[k] && CR_BODY_EN[k][b[k]]) p.push(CR_BODY_EN[k][b[k]]);
  return p.join(', ');
}
// 9.26: fețe diferite între variante: unde nu ai descris fața, fiecare variantă primește alte trăsături (altfel generatorul
// cade pe aceeași față „generică” la fiecare generare); ce ai scris tu despre față rămâne neatins
const CR_FACEMIX = [
  [/(oval|rotund|pătrat|patrat|alungit|inimă|inima|formă|forma)\s*(a\s*)?(feței|fetei|față|fata)?|față (ovală|rotundă|pătrată|alungită)|fata (ovala|rotunda|patrata)/i, ['an oval face', 'a heart-shaped face', 'a round soft face', 'a square face with a defined jaw', 'a long narrow face', 'a diamond-shaped face with high cheekbones']],
  [/ochi/i, ['almond-shaped eyes', 'large round eyes', 'slightly hooded eyes', 'upturned cat-like eyes', 'deep-set eyes', 'wide-set eyes']],
  [/\bnas/i, ['a small straight nose', 'a button nose', 'a slightly aquiline nose', 'a wide soft nose', 'a long straight nose', 'a nose with a slight bump']],
  [/buz/i, ['full lips', 'thin lips', 'a wide mouth', 'cupid\'s-bow lips', 'a small mouth with a full lower lip']],
  [/(pistrui|aluni|gropi|sprâncen|sprancen|pomeți|pometi)/i, ['high cheekbones', 'soft rounded cheeks', 'light freckles across the nose', 'a small beauty mark', 'thick natural eyebrows', 'dimples when smiling', 'a slightly crooked smile']]];
function crFaceMix(Z){
  const txt = [$('#edPrompt').value, Z && Z.zones && Z.zones.fata].join(' '), out = [];
  for(const [re, opts] of CR_FACEMIX) if(!re.test(txt)) out.push(opts[Math.floor(Math.random() * opts.length)]);
  return out.length ? `Distinctive facial features: ${out.join(', ')}. A unique, real-looking individual, not a generic model face.` : '';
}
// zonele (sau, fără zone, descrierea liberă) → descrierea în engleză; corpul ales pe butoane se adaugă exact
async function crEnFrom(Z, ro){
  const zon = Object.entries(Z.zones).filter(([, v]) => String(v).trim());
  const notes = zon.length ? zon.map(([k, v]) => `${k}: ${v}`).join('\n') : `free description: ${String(ro || '').slice(0, 2500)}`;
  const j = await crAskJSON('You translate character appearance notes into a precise English prompt for a photo generator. Answer with JSON only.',
`Notes (Romanian):
${notes}
Translate faithfully into concise, neutral English, keeping every detail. The person is always a clearly adult person (21 or older). Leave a field empty if the notes say nothing about it.
JSON: {"subject":"gender and apparent age, skin tone","face":"","hair":"","body":"","hands":"","outfit":"","shoes":"","pose":"","place":"","light":""}`, 900);
  const P = {}; for(const k of ['subject', 'face', 'hair', 'body', 'hands', 'outfit', 'shoes', 'pose', 'place', 'light']) P[k] = String(j[k] || '').trim().replace(/[.\s]+$/, '');
  if(!P.subject && !P.face && !P.body && !P.hair) throw new Error('n-am putut pregăti promptul; mai încearcă');
  return P;
}
// 9.29: compunerea promptului din părțile traduse + corpul exact de pe butoane (fără altă cerere la AI când se schimbă doar corpul)
function crCompose(P, Z){
  const f = k => P[k] || '', be = crBodyEn(Z), body = [be, f('body')].filter(Boolean).join(', ');
  return [f('subject') && `${f('subject')}.`, body && `Body: ${body}.`, f('face') && `Face: ${f('face')}.`, f('hair') && `Hair: ${f('hair')}.`, f('hands') && `Hands: ${f('hands')}.`,
    f('outfit') && `Outfit: ${f('outfit')}.`, f('shoes') && `Shoes: ${f('shoes')}.`, `Pose: ${f('pose') || 'natural relaxed standing pose'}.`, f('place') && `Setting: ${f('place')}.`, f('light') && `Light: ${f('light')}.`].filter(Boolean).join(' ');
}
const crTextKey = () => JSON.stringify([$('#edPrompt').value.trim(), ed.cr.z.zones]);
const crAllText = () => [$('#edPrompt').value, ...Object.values(ed.cr.z.zones)].join(' ');
const crKey = () => JSON.stringify([$('#edPrompt').value.trim(), ed.cr.z]);
const crPrompt = (en, frame, mix) => `${stilLead(crStil())}${stilFrame(crStil(), CR_FRAMES[frame].p)}. ${en}${mix ? ' ' + (STIL_LEAD[crStil()] ? mix.replace('real-looking ', '') : mix) : ''} ${frame === 'portrait' ? '' : CR_HANDS + ' '}${STIL_TAG[crStil()]}`;
function crInit(c){
  const Z = c && c.appZones && c.appZones.zones ? {zones:{...crEmptyZ().zones, ...c.appZones.zones}, body:{...crEmptyZ().body, ...c.appZones.body}} : crEmptyZ();
  ed.cr = {frame:(c && c.frame) || 'full', vars:[], chosen:-1, run:0, busy:false, z:Z, en:(c && c.appEn) || '', enFor:'', manual:false, parts:null, partsFor:''};
  $('#edPrompt').value = (c && c.appPrompt) || ''; $('#edPromptEn').value = ed.cr.en;
  if(c && c.appEn){ ed.cr.enFor = crKey(); ed.cr.manual = !!c.appEnManual; }
  $('#edZonesWrap').open = crHasZ(Z);
  crDrawFrame(); crStyleSync(); crDrawZones(); crZoneChanged(); crRender(); crBusyUI(false);
  $('#edCrea').hidden = S.imgProv === 'none'; $('#edCreaOff').hidden = S.imgProv !== 'none';
  $('#edFullNow').hidden = !(c && c.photoFull); $('#edAngleView').innerHTML = '';
}
function crDrawFrame(){ $$('#edFrame button').forEach(b => b.classList.toggle('on', b.dataset.v === ed.cr.frame)); }
function crStyleSync(){ const v = crStil(); $$('#edStyle button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); $$('#edLookPresets button').forEach(b => b.classList.toggle('on', b.dataset.look === v)); }   // 9.79: și presetările de sus
function crBusyUI(on){ $('#edGen4').hidden = !!on; $('#edStop').hidden = !on; $('#edEnrich').disabled = !!on; const g = $('#edAdjGo'); if(g) g.disabled = !!on; const m = $('#edMore'); if(m) m.disabled = !!on; }
// rulare cu „⏹ Oprește”: un AbortController pe tot lotul
async function crRun(label, fn){
  const E = ed, R = ed && ed.cr; if(!R || R.busy) return;
  R.busy = true; R.ac = new AbortController(); crBusyUI(true);
  try{ await fn(E, R, R.ac.signal); }
  catch(e){ if(ed === E) setEdStatus(e.name === 'AbortError' ? '⏹ Oprit.' : label + ' n-a mers: ' + esc(e.message), e.name === 'AbortError' ? '' : 'err'); }
  finally{ if(ed === E){ const stopped = R.ac && R.ac.signal.aborted; R.busy = false; R.ac = null; R.vars = R.vars.filter(v => !v.stopped); if(R.chosen >= R.vars.length || (R.chosen >= 0 && !R.vars[R.chosen].keep)) R.chosen = R.vars.findIndex(v => v.keep); crBusyUI(false); crRender(); if(stopped) setEdStatus('⏹ Oprit. Variantele neterminate n-au mai fost generate.'); } }
}
function crStop(){ const R = ed && ed.cr; if(R && R.ac){ R.ac.abort(); R.vars.forEach(v => { if(v.st === 'gen') v.stopped = true; }); setEdStatus('⏹ Opresc…'); } }
function crGuard(){
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări → Poze.'); return false; }
  if(!aiReady()){ toast('Adaugă cheia Anthropic în Setări.'); return false; }
  if(CR_MINOR.test(crAllText())){ setEdStatus('Personajele din Taifas sunt adulte. Scrie o vârstă de cel puțin 18 ani.', 'err'); return false; }
  return true;
}
// „✨ Îmbogățește pe zone”
function crEnrich(){
  const ro = $('#edPrompt').value.trim();
  if(ro.length < 4){ toast('Scrie întâi câteva cuvinte despre cum arată.'); $('#edPrompt').focus(); return; }
  if(!crGuard()) return;
  crRun('Îmbogățirea', async (E, R) => {
    setEdStatus('<span class="spin"></span> Scriu descrierea completă, pe zone…');
    const t = await crZones(ro, true); if(ed !== E) return;
    R.z = t.Z; crDrawZones(); crZoneChanged(); $('#edZonesWrap').open = true;
    if(!$('#edName').value.trim() && t.names.length){ $('#edName').value = t.names[0]; $('#edTitle').textContent = t.names[0]; drawNames(t.names); }
    if(CR_MINOR.test(crAllText())){ setEdStatus('Personajele din Taifas sunt adulte. Corectează vârsta.', 'err'); return; }
    setEdStatus('✓ Descrierea e pe zone. Corectează orice (și corpul), apoi „Generează”.', 'ok');
  });
}
function crGenerate(){
  if(!crGuard()) return;
  const ro = $('#edPrompt').value.trim(), manual = ed.cr.manual && $('#edPromptEn').value.trim();
  if(!crHasZ(ed.cr.z) && ro.length < 8 && !manual){ toast('Scrie întâi cum arată (câteva detalii) sau completează zonele.'); $('#edPrompt').focus(); return; }
  crRun('Generarea', async (E, R, signal) => {
    // 9.26: promptul englez scris de tine se folosește exact; se reface doar dacă schimbi descrierea sau zonele după ce l-ai scris
    const key = crKey();
    if(R.manual && key !== R.enFor){ R.manual = false; toast('Ai schimbat descrierea: promptul în engleză s-a refăcut din ea.', 3500); }
    if(R.manual) R.en = $('#edPromptEn').value.trim();
    else if(key !== R.enFor || !R.en){
      // 9.29: textul (descriere, zone) se traduce doar când se schimbă; corpul se recompune local
      const tk = crTextKey();
      if(!R.parts || R.partsFor !== tk){ setEdStatus('<span class="spin"></span> Pregătesc promptul…'); R.parts = await crEnFrom(R.z, ro); R.partsFor = tk; if(ed !== E) return; }
      R.en = crCompose(R.parts, R.z); R.enFor = key; $('#edPromptEn').value = R.en;
    }
    if(CR_MINOR.test(R.en)){ setEdStatus('Personajele din Taifas sunt adulte. Corectează vârsta.', 'err'); return; }
    const frame = R.frame, FR = CR_FRAMES[frame], model = crModel(4, FR.size), run = ++R.run;
    for(const v of R.vars) if(!v.keep && v.url) URL.revokeObjectURL(v.url);
    R.vars = R.vars.filter(v => v.keep);
    const fresh = [0, 1, 2, 3].map(() => ({id:uid(), st:'gen', frame, prompt:crPrompt(R.en, frame, R.manual ? '' : crFaceMix(R.z)), kind:'nou'}));
    R.vars = fresh.concat(R.vars); R.chosen = R.vars.findIndex(v => v.keep); crRender();
    setEdStatus(`<span class="spin"></span> Generez 4 variante (${model === 'ancorat' ? 'Fidel · 9B' : 'Eco'})…`);
    await Promise.allSettled(fresh.map(v => crMake(E, run, v, () => genImage(v.prompt, null, signal, null, {model, size:FR.size, quiet:true, why:'profil'}))));
    if(signal.aborted) return;
    await crAfterBatch(E, fresh);
  });
}
// o variantă: generează, păstrează, verifică
async function crMake(E, run, v, gen){
  try{
    let b = await gen();
    try{ if(b.type === 'image/png') b = await toJpeg(b, 2048, .92); }catch(e){}
    addUsage(E.id, imgPrice(), 'img', null, 'profil');
    if(ed !== E) return;
    v.blob = b; v.url = URL.createObjectURL(b); v.st = 'ok'; crRender();
    v.chk = await crCheck(v); crRender();
  }catch(e){ v.st = 'err'; v.err = e.name === 'AbortError' ? 'oprit' : e.message; if(e.name === 'AbortError') v.stopped = true; if(ed === E) crRender(); }
}
async function crAfterBatch(E, list){
  const R = E.cr, ok = list.filter(v => v.st === 'ok');
  if(!ok.length){ setEdStatus('Nicio variantă n-a ieșit: ' + esc((list.find(v => v.err) || {}).err || 'eroare'), 'err'); return; }
  if(S.crHands !== 'off' && aiReady()) await crHands(E, ok);
  if(ed !== E) return;
  // 9.28: recomandarea = cea mai apropiată de descriere (nota lui Claude cântărește cel mai mult), apoi verificările din telefon;
  //       la egalitate nu se mai alege implicit prima (stânga sus): fără ⭐ dacă nu e una clar mai bună
  const tot = v => (v.chk ? v.chk.score : 0) + (v.chk && v.chk.match != null ? v.chk.match * 1.5 : 0);
  const sorted = ok.slice().sort((x, y) => tot(y) - tot(x) || ((y.chk && y.chk.match) || 0) - ((x.chk && x.chk.match) || 0));
  R.vars.forEach(v => v.best = false);
  const best = sorted[0], second = sorted[1];
  if(best && tot(best) > 0 && (!second || tot(best) - tot(second) >= .5)) best.best = true;
  crRender();
  setEdStatus(`✓ ${ok.length} ${ok.length === 1 ? 'variantă gata' : 'variante gata'}${best && best.best ? '. ⭐ = cea mai apropiată de descriere' : ''}. Atinge una ca s-o vezi mare, apoi „Alege”.`, 'ok');

}
// verificarea din telefon (fără cost): o singură persoană, fața clară, corpul în cadru după încadrarea cerută
async function crCheck(v){
  const out = {faces:0, box:null, d:null, miss:[], score:0};
  try{
    const fs = await faceDescs(v.blob);
    out.faces = fs.length;
    if(fs.length){ const f = fs.sort((a, b) => b.a - a.a)[0]; out.box = {x:f.box.x / f.W, y:f.box.y / f.H, w:f.box.w / f.W, h:f.box.h / f.H}; out.d = f.d; out.fw = f.box.w; }
  }catch(e){ out.faceErr = true; }
  if(!out.faceErr){
    if(!out.faces) out.miss.push('fața nu se vede clar'); else { out.score += 3; if(out.faces > 1) out.miss.push('mai multe persoane'); else out.score += 1; }
    if(out.box && out.box.y < .004) out.miss.push('capul e tăiat sus');
  }
  if(v.frame !== 'portrait'){
    try{
      const im = await loadImgEl(v.url), kp = await crPose(im), H = im.naturalHeight, W = im.naturalWidth;
      if(kp){
        const vis = i => kp[i] && kp[i][2] >= .3 && kp[i][1] < H * .985 && kp[i][1] > 0 && kp[i][0] > 0 && kp[i][0] < W;
        const wr = [9, 10].filter(vis).length, kn = [13, 14].filter(vis).length, an = [15, 16].filter(vis).length;
        out.pose = {wr, kn, an};
        out.score += wr + kn * .5;
        if(wr < 2) out.miss.push(wr ? 'o mână nu se vede' : 'mâinile nu se văd');
        if(v.frame === 'full'){ out.score += an * 1.5; if(an < 2) out.miss.push(an ? 'un picior e tăiat' : 'fără picioare'); }
        else if(kn < 2) out.miss.push('tăiată deasupra genunchilor');
      }
    }catch(e){ out.poseErr = true; }
  }
  return out;
}
// MoveNet pe poza încadrată într-un pătrat (fără deformare): coordonatele se întorc în pixelii pozei
async function crPose(im){
  const {tf, m} = await poseModel(), W = im.naturalWidth, H = im.naturalHeight, Sq = Math.max(W, H), ox = (Sq - W) / 2, oy = (Sq - H) / 2;
  const cv = document.createElement('canvas'); cv.width = cv.height = 384; const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 384, 384);
  g.drawImage(im, ox * 384 / Sq, oy * 384 / Sq, W * 384 / Sq, H * 384 / Sq);
  const kp = tf.tidy(() => m.execute(tf.image.resizeBilinear(tf.browser.fromPixels(cv), [192, 192]).toInt().expandDims(0)));
  const a = (await kp.array())[0][0]; kp.dispose();
  return a.map(([y, x, sc]) => [x * Sq - ox, y * Sq - oy, sc]);
}
// Claude se uită la mâini, degete și picioare (o singură cerere pentru tot lotul; pornit implicit)
async function crHands(E, list){
  try{
    setEdStatus('<span class="spin"></span> Compar variantele cu descrierea și verific mâinile…');
    const imgs = []; for(const v of list) imgs.push(await blobToB64(await toJpeg(v.blob, 768, .85)));
    // 9.28: și cât de bine se potrivește fiecare variantă cu ce ai cerut (aceeași cerere, fără cost în plus)
    const R = E.cr, ro = $('#edPrompt').value.trim(), want = (list[0] && list[0].want) || '';
    const desc = [ro && 'User description (Romanian): ' + ro.slice(0, 1200), R && crHasZ(R.z) ? 'Details by zone (Romanian): ' + Object.entries(R.z.zones).filter(([, x]) => String(x).trim()).map(([k, x]) => k + ': ' + x).join('; ') + (crBodyText(R.z) ? '; corp: ' + crBodyText(R.z) : '') : '', R && R.en ? 'Prompt (English): ' + R.en.slice(0, 1500) : '', want && 'Requested change for these variants: ' + want].filter(Boolean).join('\n');
    const j = await stream('You inspect generated photos: how well each matches the requested description, and anatomy errors. Be strict and discriminating: the scores must reflect real differences between the images. Answer with JSON only.', [{role:'user', images:imgs, text:
`There are ${imgs.length} images, in order.
${desc || '(no description)'}
For each image: "match" = 0-10, how faithfully it matches the description (age, gender, face, hair color and style, body type and proportions, outfit, shoes, place, light; the requested change if any); "miss" = the most important thing that differs from the description, max 8 words, in Romanian ("" if nothing); then check the hands and fingers (count, shape, fused or extra fingers) and the feet.
JSON array, one item per image, in order: [{"match":0,"miss":"","hands":"ok|bad|hidden","feet":"ok|bad|hidden"}]`}], {max:700, aux:true, cid:E.id});
    const a = j.indexOf('['), b = j.lastIndexOf(']'), arr = JSON.parse(j.slice(a, b + 1));
    list.forEach((v, i) => { const x = arr[i] || {}; if(!v.chk) return; v.chk.hands = x.hands;
      const m = Math.round(+x.match); if(Number.isFinite(m) && m >= 0 && m <= 10) v.chk.match = m;
      v.chk.missDesc = faraLiniute(String(x.miss || x.note || '').trim()).slice(0, 70);
      if(x.hands === 'bad'){ v.chk.miss.push('mâini greșite'); v.chk.score -= 3; } else if(x.hands === 'ok') v.chk.score += 1;
      if(x.feet === 'bad'){ v.chk.miss.push('picioare greșite'); v.chk.score -= 2; } });
  }catch(e){ /* dacă nu merge, rămân verificările din telefon */ }

}
function crBadge(v){
  if(v.st === 'gen') return '<span class="crb wait"><span class="spin"></span></span>';
  if(v.st === 'err') return `<span class="crb bad">⚠️ ${esc((v.err || 'eroare').slice(0, 40))}</span>`;
  const k = v.chk; if(!k) return '<span class="crb wait">verific…</span>';
  const same = v.fixing ? '<span class="crb">✨ potrivesc fața…</span>' : v.sameD != null ? (v.sameD < .5 ? `<span class="crb ok">👤 aceeași față${v.fixed ? ' ✨' : ''}</span>` : '<span class="crb bad">👤 altă față</span>') : '';
  const mt = k.match != null ? `<span class="crb ${k.match >= 8 ? 'ok' : k.match <= 5 ? 'bad' : ''}" title="${esc(k.missDesc || '')}">🎯 ${k.match}/10${k.missDesc && k.match < 9 ? ' · ' + esc(k.missDesc) : ''}</span>` : '';   // 9.28: cât se potrivește cu descrierea
  return (v.best ? '<span class="crb star">⭐ recomandată</span>' : '') + mt + (k.miss.length ? `<span class="crb bad">⚠️ ${esc(k.miss.slice(0, 2).join(', '))}</span>` : `<span class="crb ok">✓ ${v.frame === 'full' ? 'corp întreg' : v.frame === '34' ? 'trei sferturi' : 'portret'}</span>`) + same;

}
const CR_KIND = {aj:'🪄', mai:'🔁', own:'📷 Poza ta'};
function crRender(){
  const box = $('#edVars'); if(!box || !ed || !ed.cr) return;
  const R = ed.cr;
  box.innerHTML = R.vars.map((v, i) => `<figure class="crv${i === R.chosen ? ' on' : ''}${v.st === 'ok' ? '' : ' ' + v.st}" data-i="${i}">
      ${v.url ? `<img src="${v.url}" alt="" data-cv="${i}">` : '<div class="crph"></div>'}
      <figcaption>${CR_KIND[v.kind] ? `<span class="crb">${CR_KIND[v.kind]}</span>` : ''}${crBadge(v)}</figcaption>
      ${v.st === 'ok' && !v.fixing ? `<button type="button" class="btn sm${i === R.chosen ? ' pri' : ''}" data-ch="${i}">${i === R.chosen ? '✓ Aleasă' : 'Alege'}</button>` : ''}</figure>`).join('');
  $('#edChosen').hidden = R.chosen < 0 || !R.vars[R.chosen] || R.vars[R.chosen].st !== 'ok';
}
function crView(i){
  const R = ed.cr, list = R.vars.filter(v => v.url), v = R.vars[i]; if(!v || !v.url) return;
  const face = {}; for(const x of list) if(x.chk && x.chk.box) face[x.url] = x.chk.box;
  viewImg(v.url, list.map(x => x.url), null, {face});
}
/* ───────── 9.34: 📷 personajele cu poza ta (urcată, nu generată) ─────────
   (1) „🔎 Citește poza pe zone”: poza ta e citită pe zonele creatorului și pe butoanele de corp (doar ce se vede), le corectezi;
       la salvare intră în „Cum arată, pentru poze” (corpul întâi) și în pozele din chat, ca la creator. Se face singur la urcare.
   (2) „🪄 Ajustează corpul pe poza ta”: poza ta devine varianta aleasă din creator (📷), iar „Ajustează” face variante cu fața ta
       și corpul schimbat. Varianta aleasă devine poza întreagă (reperul de corp din 9.32); poza ta rămâne poza de profil. */
const ownMode = () => !!(ed && (ed.photoBlob ? !ed.aiPortrait : (ed.photoKey && !(charById(ed.id) || {}).aiPortrait)));
function ownSync(){
  const box = $('#edOwn'); if(!box || !ed) return;
  const on = ownMode(); box.hidden = !on;
  $('#edOwnAdj').hidden = S.imgProv === 'none';
  const zw = $('#edZonesWrap');
  if(on && zw.parentElement.id !== 'edOwnSlot') $('#edOwnSlot').appendChild(zw);
  else if(!on && zw.parentElement.id === 'edOwnSlot') $('#edZoneHint').before(zw);
}
async function crReadPhoto(auto){
  if(!ed || !ed.cr) return;
  if(!aiReady()){ if(!auto) toast('Adaugă cheia în Setări.'); return; }
  const E = ed, b = await edPhotoBlob(); if(!b) return;
  const btn = $('#edOwnRead'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Citesc poza…';
  try{
    const meta = {};
    const out = await stream('Descrii obiectiv persoane din fotografii, pe zone, în română corectă. Răspunzi DOAR cu JSON valid.', [{role:'user', image:await blobToB64(await toJpeg(b, 1280, .88)), text:
`Descrie persoana din poză exact cum se vede, neutru și concret, fără s-o înfrumusețezi și fără să ghicești ce nu se vede. Persoana e adultă.
Zone (text scurt, fiecare cel mult 35 de cuvinte; gol dacă nu se vede): ${CR_ZONES.map(([k, l]) => `"${k}" = ${l}`).join('; ')}.
Pentru corp alege, DOAR pentru ce se vede clar în poză, câte o valoare EXACT din listele: ${CR_BODY.map(([k, l, o]) => `"${k}" (${l}): ${o.join(' | ')}`).join('; ')}; "h" = înălțimea estimată în centimetri doar dacă se vede tot corpul, altfel 0. Ce nu intră în liste merge în zona "corp".
JSON: {"zones":{${CR_ZONES.map(([k]) => `"${k}":""`).join(',')}},"body":{"h":0${CR_BODY.map(([k]) => `,"${k}":""`).join('')}}}`}], {max:1500, aux:true, cid:E.id, meta});
    if(meta.stop === 'refusal') throw new Error('AI-ul n-a vrut să descrie poza asta.');
    if(ed !== E) return;
    const Z = crZFrom(parseJSON(out)); if(!crHasZ(Z)) throw new Error('n-am putut citi poza; mai încearcă');
    E.cr.z = Z; E.cr.parts = null; E.cr.partsFor = ''; if(!E.cr.manual){ E.cr.en = ''; E.cr.enFor = ''; }
    crDrawZones(); crZoneChanged(); $('#edZonesWrap').open = true;
    setEdStatus('✓ Am citit poza pe zone și pe butoanele de corp. Corectează ce nu e bine; la salvare intră în „Cum arată, pentru poze”.', 'ok');
  }catch(e){ if(e.name !== 'AbortError' && ed === E) setEdStatus('Citirea pozei pe zone n-a mers: ' + esc(e.message), 'err'); }
  if(btn.isConnected){ btn.disabled = false; btn.textContent = '🔎 Citește poza pe zone'; }
}
async function ownAdjust(){
  if(!ed || !ed.cr || ed.cr.busy) return;
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări → Poze.'); return; }
  const E = ed, R = E.cr; let v = R.vars.find(x => x.own);
  if(!v){
    const b = await edPhotoBlob(); if(!b || ed !== E) return;
    v = {id:uid(), own:true, st:'ok', frame:R.frame === 'portrait' ? 'full' : R.frame, kind:'own', blob:b, url:URL.createObjectURL(b)};
    v.chk = await crCheck({...v, frame:'portrait'});   // poza ta: doar fața, fără verificarea de poziție
    R.vars.unshift(v);
  }
  R.vars.forEach(x => x.keep = x === v); R.chosen = R.vars.indexOf(v); crRender();
  if(!crHasZ(R.z)) await crReadPhoto(true);
  if(ed !== E) return;
  $('#edChosen').hidden = false; $('#edAdjTxt').focus({preventScroll:true});
  setTimeout(() => $('#edChosen').scrollIntoView({block:'start', behavior:'smooth'}), 60);
  setEdStatus('🪄 Alege ce schimbi la corp (de ex. 🍑 Mai plinuță, bust mai mare) și apasă Aplică. Fața rămâne a ta; varianta aleasă devine poza întreagă, iar poza ta rămâne poza de profil.', 'ok');
}
// alegerea: poza întreagă rămâne așa; poza de profil devine un portret al aceleiași persoane; apoi unghiurile (automat)
async function crChoose(i){
  const R = ed && ed.cr, v = R && R.vars[i]; if(!v || v.st !== 'ok' || R.busy) return;
  if(v.own){ R.vars.forEach(x => x.keep = x === v); R.chosen = i; crRender(); return; }   // 9.34: poza ta, ca bază pentru ajustări
  const own = ownMode() && R.vars.some(x => x.own) && v.frame !== 'portrait';
  let done = false;
  await crRun('Alegerea', async (E, R2) => {
    R2.vars.forEach(x => x.keep = false); v.keep = true; R2.chosen = R2.vars.indexOf(v); crRender();
    if(own){   // 9.34: poza ta rămâne poza de profil; varianta ajustată devine poza întreagă (reperul de corp)
      E.fullBlob = v.blob; E.fullBox = v.chk && v.chk.box; E.fullTouched = true; E.bodyFull = null;
      setEdStatus('✓ Aleasă ca poză întreagă. Poza ta rămâne poza de profil; corpul din pozele din chat vine din varianta asta.', 'ok');
      E.readP = crReadBack(E, v); done = true; return;
    }
    if(v.frame === 'portrait'){ E.photoBlob = v.blob; E.fullBlob = null; E.fullBox = null; }
    else {
      setEdStatus('<span class="spin"></span> Fac poza de profil (portretul) din poza întreagă…');
      const p = await crPortraitFrom(E, v); if(ed !== E) return;
      E.photoBlob = p.blob; E.fullBlob = v.blob; E.fullBox = v.chk && v.chk.box;
      setEdStatus(p.how === 'gen' ? '✓ Aleasă. Portretul pentru profil e făcut din ea (aceeași față).' : '✓ Aleasă. Portretul pentru profil e decupat din ea.', 'ok');
    }
    E.aiPortrait = true; E.fullTouched = true; E.angles = null; E.bodyFull = null; $('#edAngleView').innerHTML = '';
    await renderEdPhoto();
    E.readP = crReadBack(E, v);   // descrierea se recitește din poza aleasă (în fundal; salvarea o așteaptă)
    done = true;
  });
  if(done && ed && S.crAngles !== 'off') crAngles();
}
async function crPortraitFrom(E, v){
  const p = `${stilLead(crStil())}Edit this exact photo into a close-up portrait of the same person: head and shoulders, the face large and sharp in the frame, looking at the camera, natural expression. Keep the same face and identity, the same hairstyle, skin, makeup, clothes and the same place and light. ${STIL_TAG[crStil()]}`;
  const model = crModel(2, '768x1024'), signal = E.cr && E.cr.ac ? E.cr.ac.signal : null;
  for(let k = 0; k < 2; k++){
    try{
      let b = await genImage(p, v.blob, signal, null, {model, size:'768x1024', force:{two:false, px:1024}, p1:p, quiet:true, why:'profil'});
      addUsage(E.id, imgPrice(), 'img', null, 'profil');
      try{ if(b.type === 'image/png') b = await toJpeg(b, 2048, .92); }catch(e){}
      if(!v.chk || !v.chk.d) return {blob:b, how:'gen'};            // fără față măsurabilă în poza întreagă: nu avem cu ce compara
      const fs = await faceDescs(b);
      const d = fs.length ? Math.min(...fs.map(f => fdist(f.d, v.chk.d))) : 9;
      if(d < .55) return {blob:b, how:'gen', d};
    }catch(e){ if(e.name === 'AbortError') throw e; }
  }
  return {blob:await crCropPortrait(v.blob, v.chk && v.chk.box), how:'crop'};
}
// decupaj 3:4 de la cap la piept, din poza întreagă (rezerva gratuită)
async function crCropPortrait(blob, box){
  const u = URL.createObjectURL(blob);
  try{
    const im = await loadImgEl(u), W = im.naturalWidth, H = im.naturalHeight;
    let cw, cx, top;
    if(box){ const fw = box.w * W, fh = box.h * H; cw = Math.min(W, Math.max(fw * 3.4, W * .3)); cx = (box.x + box.w / 2) * W; top = box.y * H - fh * .9; }
    else { cw = W * .62; cx = W / 2; top = H * .02; }
    let ch = cw * 4 / 3; if(ch > H){ ch = H; cw = ch * 3 / 4; }
    const x = Math.min(Math.max(0, cx - cw / 2), W - cw), y = Math.min(Math.max(0, top), H - ch);
    const cv = document.createElement('canvas'); cv.width = 768; cv.height = 1024;
    const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(im, x, y, cw, ch, 0, 0, 768, 1024);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', .92));
  } finally { URL.revokeObjectURL(u); }
}
// corpul întreg, citit din poză (neutru, în engleză): intră în pozele din chat prin `physFull`
async function crBodyRead(blob, cid){
  const out = await stream('You describe bodies in reference photos for an image generator. Neutral, factual English. Answer with the description only.', [{role:'user', image:await blobToB64(await toJpeg(blob, 1280, .88)), text:'Describe this person\'s whole body exactly as it looks, comma-separated, max 60 words: apparent height (petite / average / tall), build, shoulders, arms, bust size and shape, waist, belly, hips, buttocks, legs and their proportions, hands and nails, skin tone on the body. No clothing, no background, no pose.'}], {max:260, aux:true, cid});
  return faraLiniute(out.trim()).slice(0, 500);
}
// textul se potrivește cu poza: Aspectul (română), descrierea pentru imagini și corpul întreg, citite din poza aleasă
async function crReadBack(E, v){
  if(!aiReady()) return;
  try{
    const d = await describePhoto(v.blob); if(ed !== E) return;
    if(d.aspect) $('#edAspect').value = d.aspect; if(d.look) $('#edLook').value = d.look;
    if(d.names.length && !$('#edName').value.trim()){ $('#edName').value = d.names[0]; $('#edTitle').textContent = d.names[0]; drawNames(d.names); }
    if(v.frame !== 'portrait'){ const t = await crBodyRead(v.blob, E.id); if(ed === E) E.bodyFull = t; }
  }catch(e){}
}
// „🪄 Ajustează”: poza aleasă devine referința, se schimbă doar ce ceri
// 9.29: „🪄 Ajustează” refăcut. Înainte: „editează exact poza, totul rămâne la fel, schimbă doar…” cu poza întreagă ca reper,
//       iar modelul întorcea practic aceeași poză (mai ales la corp). Acum: (1) butoanele de corp schimbă chiar alegerile din zona Corp
//       (bustul urcă / coboară o treaptă, silueta, +6 cm); (2) variantele se generează din nou, cu FAȚA aleasă ca reper de identitate
//       (decupată, ca reperul să nu mai „țină” corpul vechi), iar corpul și schimbarea cerută sunt scrise explicit în prompt
const CR_STEP = (Z, k, d) => { const o = CR_BODY.find(x => x[0] === k)[2], i = o.indexOf(Z.body[k]); Z.body[k] = o[Math.max(0, Math.min(o.length - 1, (i < 0 ? (k === 'bust' ? 2 : 0) : i) + d))]; };
const CR_ADJ_OPS = [
  ['bust mai mare, natural', Z => CR_STEP(Z, 'bust', 1)], ['bust mai mic, natural', Z => CR_STEP(Z, 'bust', -1)],
  ['corp mai suplu, cu proporții firești', Z => { Z.body.build = Z.body.build === 'suplă' ? 'slabă' : 'suplă'; }],
  ['corp mai plin, cu proporții firești', Z => { Z.body.build = Z.body.build === 'plinuță' ? 'plină' : 'plinuță'; }],
  ['corp mai atletic, tonifiat', Z => { Z.body.build = 'atletică'; if(!Z.body.belly || /rotunjit/.test(Z.body.belly)) Z.body.belly = 'tonifiat'; }],
  ['mai înaltă, cu proporții firești', Z => { Z.body.h = Math.min(195, (+Z.body.h || 168) + 6); }]];
function crAdjust(){
  const R = ed && ed.cr, v = R && R.vars[R.chosen]; if(!v || v.st !== 'ok'){ toast('Alege întâi o variantă.'); return; }
  let ro = $('#edAdjTxt').value.trim(); if(!ro){ toast('Scrie sau alege ce schimbi.'); return; }
  if(CR_MINOR.test(ro)){ setEdStatus('Personajele din Taifas sunt adulte.', 'err'); return; }
  crRun('Ajustarea', async (E, R2, signal) => {
    setEdStatus('<span class="spin"></span> Pregătesc ajustarea…');
    // 1. schimbările de corp de pe butoane trec în zona Corp (se văd pe butoane și rămân pentru generările următoare)
    let bodyChanged = false;
    for(const [k, fn] of CR_ADJ_OPS) if(ro.includes(k)){ fn(R2.z); bodyChanged = true; ro = ro.split(k).join(' '); }
    ro = ro.replace(/\s*,\s*(,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
    if(bodyChanged){ crDrawBody(); crZoneChanged(); $('#edZonesWrap').open = true; }
    // 2. schimbarea scrisă (ținută, păr, poziție, loc…) se traduce
    const en = ro ? (await stream('You translate short photo-edit requests into English for an image generator. Answer with the English instruction only.', [{role:'user', text:'Translate faithfully, concise, neutral: ' + ro}], {max:120, aux:true, signal})).trim().replace(/^["“]|["”]$/g, '') : '';
    // 3. descrierea întreagă, cu corpul nou
    let desc;
    if(R2.manual) desc = $('#edPromptEn').value.trim() + (bodyChanged ? ` Body (this overrides the body above): ${crBodyEn(R2.z)}.` : '');
    else {
      if(!R2.parts){ R2.parts = await crEnFrom(R2.z, $('#edPrompt').value.trim()); R2.partsFor = crTextKey(); }
      desc = crCompose(R2.parts, R2.z); R2.en = desc; R2.enFor = crKey(); $('#edPromptEn').value = desc;
    }
    const keepHair = /(păr|par\b|coaf|breton|hair)/i.test(ro) ? '' : ', the same hairstyle and hair color';
    const FR = CR_FRAMES[v.frame];
    const p = `${stilLead(crStil())}The reference image is a close-up of a specific person's face: keep exactly this face and identity (face shape, eyes, nose, lips, skin tone and skin texture, age)${keepHair}. Create a NEW ${STIL_LEAD[crStil()] ? 'image' : 'photo'} of this same person. ${stilFrame(crStil(), FR.p)}. ${desc}${en ? ` Requested change, apply it clearly and visibly: ${en}.` : ''} The body, the outfit and the place must follow this description exactly, even where they differ from the reference. ${v.frame === 'portrait' ? '' : CR_HANDS + ' '}${STIL_TAG[crStil()]}`;
    // reperul: doar fața (decupată din varianta aleasă), ca generatorul să nu copieze corpul și ținuta vechi
    let face = null; try{ face = v.chk && v.chk.box ? await cropFace(v.blob, v.chk.box) : null; }catch(e){}
    if(!face) face = await crCropPortrait(v.blob, v.chk && v.chk.box);
    await crFromChosen(E, R2, v, p, 2, 'aj', signal, bodyChanged ? 'Fac 2 variante cu corpul schimbat (aceeași față)…' : 'Fac 2 variante ajustate (aceeași față)…', $('#edAdjTxt').value.trim(), face);
  });
}
// „🔁 Mai multe ca asta”: încă 4 variante ale aceleiași persoane, cu mici diferențe de poziție și expresie
function crMore(){
  const R = ed && ed.cr, v = R && R.vars[R.chosen]; if(!v || v.st !== 'ok'){ toast('Alege întâi o variantă.'); return; }
  crRun('Variantele', async (E, R2, signal) => {
    const FR = CR_FRAMES[v.frame];
    const p = `${stilLead(crStil())}Edit this exact photo: the same person with an identical face, identity, hairstyle, body and outfit, in the same place and light, with a natural small variation: a slightly different pose, angle and expression. Keep the framing: ${FR.p}. ${v.frame === 'portrait' ? '' : CR_HANDS + ' '}${STIL_TAG[crStil()]}`;
    await crFromChosen(E, R2, v, p, 4, 'mai', signal, 'Fac încă 4 variante ca aceasta…');
  });
}
async function crFromChosen(E, R, v, p, n, kind, signal, msg, want, refBlob){
  const FR = CR_FRAMES[v.frame], model = crModel(n, FR.size), run = ++R.run;
  const fresh = Array.from({length:n}, () => ({id:uid(), st:'gen', frame:v.frame, prompt:p, kind, want:want || ''}));
  R.vars = fresh.concat(R.vars); R.chosen = R.vars.indexOf(v); crRender();
  setEdStatus('<span class="spin"></span> ' + msg);
  await Promise.allSettled(fresh.map(x => crMake(E, run, x, () => genImage(p, refBlob || v.blob, signal, null, {model, size:FR.size, force:{two:false, px:1024}, p1:p, quiet:true, why:'profil'}))));
  if(ed !== E || signal.aborted) return;
  for(const x of fresh) if(x.chk && x.chk.d && v.chk && v.chk.d) x.sameD = fdist(x.chk.d, v.chk.d);
  // 9.35: variantele cu „altă față”: fața pusă din nou după varianta aleasă (sau poza ta)
  if(v.chk && v.chk.d){
    const bad = fresh.filter(x => x.st === 'ok' && (x.sameD == null || x.sameD >= FACE_OK));
    if(bad.length){
      setEdStatus(`<span class="spin"></span> Potrivesc fața la ${bad.length === 1 ? 'o variantă' : bad.length + ' variante'} (aceeași persoană)…`);
      const src = {prof:v.blob, box:v.chk.box, refD:[v.chk.d]};
      await Promise.allSettled(bad.map(async x => { x.fixing = true; crRender(); try{ await fixFace(x, src, signal); } finally { x.fixing = false; if(ed === E) crRender(); } }));
      if(ed !== E || signal.aborted) return;
    }
  }
  await crAfterBatch(E, fresh);
}
// fișa de personaj: încă 2 unghiuri ale aceleiași fețe → repere pentru pozele din chat (`c.refs`); automat după „Alege”
function crAngles(){
  crRun('Unghiurile', async (E, R, signal) => {
    const base = E.photoBlob || (E.photoKey ? await DB.get(E.photoKey) : null); if(!base) return;
    setEdStatus('<span class="spin"></span> Fac 2 unghiuri ale aceleiași fețe (repere pentru pozele din chat)…');
    let ref = null; try{ const fs = await faceDescs(base); if(fs.length) ref = fs.sort((a, b) => b.a - a.a)[0].d; }catch(e){}
    const st = STIL_TAG[crStil()], model = crModel(4, '768x1024');
    const views = ['a three-quarter view: the head turned about 40 degrees to the person\'s left, eyes towards the camera', 'a side profile view: the head turned 90 degrees to the person\'s right, looking straight ahead'];
    const outs = await Promise.all(views.map(async vw => {
      const p = `${stilLead(crStil())}Edit this exact photo: the same person, photographed from ${vw}. Head and shoulders, plain softly blurred background, even soft light. Keep the exact same face and identity, hairstyle, skin and age. ${st}`;
      for(let t = 0; t < 2; t++){
        try{
          let b = await genImage(p, base, signal, null, {model, size:'768x1024', force:{two:false, px:1024}, p1:p, quiet:true, why:'profil'});
          addUsage(E.id, imgPrice(), 'img', null, 'profil');
          try{ if(b.type === 'image/png') b = await toJpeg(b, 1536, .9); }catch(e){}
          if(!ref) return b;
          const fs = await faceDescs(b); if(!fs.length) return b;   // din profil fața nu se poate măsura: o păstrăm
          if(Math.min(...fs.map(f => fdist(f.d, ref))) < .6) return b;
        }catch(e){ if(e.name === 'AbortError' || t) throw e; }
      }
      return null;
    }));
    if(ed !== E) return;
    const ok = outs.filter(Boolean);
    if(!ok.length){ setEdStatus('Unghiurile n-au ieșit cu aceeași față. Bifează din nou ca să mai încerc.', 'err'); return; }
    E.angles = ok;
    $('#edAngleView').innerHTML = ok.map(b => `<img src="${URL.createObjectURL(b)}" alt="">`).join('');
    setEdStatus(`✓ Gata: poza aleasă + ${ok.length} ${ok.length === 1 ? 'unghi' : 'unghiuri'} pentru pozele din chat. Apasă Continuă.`, 'ok');
  });
}
// ai poze generate și nesalvate: întreabă înainte să ieși din editor
const edDirty = () => !!(ed && ed.cr && (ed.cr.busy || ed.cr.vars.some(v => v.st === 'ok') || ed.angles));
// 9.30: din creator → „Cum arată, pentru poze” (`physUser` în română, `physEn` în engleză, cu prioritate în pozele din chat);
//       corpul întâi și cu cuvintele exacte de pe butoane (primele cuvinte din `physEn` ajung chiar la începutul promptului)
function crPhys(Z, en){
  const z = (Z && Z.zones) || {}, ro = [z.gen, z.fata && 'față: ' + z.fata, z.par && 'păr: ' + z.par, crBodyText(Z) && 'corp: ' + crBodyText(Z), z.maini && 'detalii: ' + z.maini].filter(x => x && String(x).trim()).join('; ');
  const lab = k => { const m = String(en || '').match(new RegExp('(?:^|\\.\\s)' + k + ':\\s*([^]*?)(?=\\.\\s+[A-Z][a-z]+:|\\.$|$)')); return m ? m[1].trim() : ''; };
  const subj = String(en || '').split(/\.\s/)[0];
  let body = lab('Body'); if(!body) body = crBodyEn(Z);
  const out = [body && 'Body: ' + body, subj && !/^(Body|Face|Hair|Hands|Outfit|Shoes|Pose|Setting|Light):/.test(subj) && subj, lab('Face') && 'Face: ' + lab('Face'), lab('Hair') && 'Hair: ' + lab('Hair'), lab('Hands') && 'Hands: ' + lab('Hands')].filter(Boolean).join('. ');
  return {ro:faraLiniute(ro).slice(0, 700), en:out.slice(0, 700)};
}
function crApplyPhys(c){
  if(!c || (c.physUser && !c.physAuto)) return false;   // ce ai scris tu în profil rămâne
  const Z = c.appZones, en = c.appEn || '';
  if(!Z && !en) return false;
  const P = crPhys(Z || crEmptyZ(), en); if(!P.en && !P.ro) return false;
  c.physUser = P.ro; c.physEn = P.en; c.physAuto = true; return true;
}
// 9.32: când ai descris personajul în text liber (fără zone), româna ieșea doar „corp: …”. Acum: aspectul fizic permanent
//       din descrierea ta (fără haine, loc, lumină, poză), plus exact alegerile de pe butoanele de corp.
const crRoThin = t => !/(față|păr)\s*:/i.test(String(t || '')) || String(t || '').length < 60;
async function crPhysRo(c, signal){
  if(!c || !c.physAuto || !aiReady()) return false;
  const src = [c.appPrompt, c.appZones && crBodyText(c.appZones) && 'corp: ' + crBodyText(c.appZones), !c.appPrompt && c.appEn].filter(Boolean).join('\n');
  if(!src.trim()) return false;
  let out = '';
  try{ out = await stream('Extragi aspectul fizic permanent al unui personaj. Răspunzi doar cu textul cerut, în română.', [{role:'user', text:
`Descrierea personajului:\n${src}\n\nScrie DOAR cum arată fizic, permanent, în română, ca listă separată cu „;”: vârsta și genul; față: …; păr: …; corp: …; semne: … (doar dacă există). Max 70 de cuvinte. Fără haine, încălțăminte, bijuterii, loc, lumină, poză sau expresie. La corp păstrează exact cuvintele din descriere (înălțime, constituție, bust, talie, șolduri etc.).`}], {max:260, aux:true, cid:c.id, signal}); }catch(e){ return false; }
  let ro = faraLiniute(String(out || '').replace(/^["„]|["”]$/g, '').replace(/\s+/g, ' ').trim());
  if(ro.length < 15) return false;
  const bt = c.appZones && crBodyText(c.appZones);
  if(bt && !ro.toLowerCase().includes(bt.toLowerCase().slice(0, 20))) ro += '; corp (alegerile tale): ' + bt;
  if(!c.physAuto) return false;   // între timp ai scris tu în profil
  c.physUser = ro.slice(0, 700); c.physRoV = 2; return true;
}
// la salvare: poza întreagă, corpul citit din ea, unghiurile, descrierea ta (liberă și pe zone)
async function crSave(c){
  if(!ed) return;
  if(ed.readP) await Promise.race([ed.readP, sleep(20000)]);
  c.appPrompt = $('#edPrompt').value.trim(); if(!c.appPrompt) delete c.appPrompt;
  if(ed.cr){ c.frame = ed.cr.frame; if(crHasZ(ed.cr.z)) c.appZones = JSON.parse(JSON.stringify(ed.cr.z)); else delete c.appZones;
    const en = ed.cr.manual ? $('#edPromptEn').value.trim() : ed.cr.en; if(en) c.appEn = en; else delete c.appEn; if(ed.cr.manual) c.appEnManual = true; else delete c.appEnManual; }
  if(ed.fullTouched){
    const old = c.photoFull;
    if(ed.fullBlob){ c.photoFull = await saveImg(ed.fullBlob); c.fullBox = ed.fullBox || null; }
    else { delete c.photoFull; delete c.fullBox; }
    if(old && old !== c.photoFull) await delImg(old).catch(() => {});
    if(c.photoFull && ed.bodyFull) c.bodyFull = {k:c.photoFull, t:ed.bodyFull}; else delete c.bodyFull;
  }
  if(crApplyPhys(c) && crRoThin(c.physUser)) await Promise.race([crPhysRo(c), sleep(15000)]);   // 9.30 + 9.32
  if(ed.angles && ed.angles.length){
    for(const k of c.refs || []) await delImg(k).catch(() => {});
    c.refs = []; for(const b of ed.angles.slice(0, 2)) c.refs.push(await saveImg(b));
    c.refsAuto = true; c.refBoxes = {};
  }
}
/* ── 🧍 personajele existente: „Fă-i poza întreagă” din profil (din portretul actual, aceeași față; c.photo nu se schimbă) ── */
async function pfMakeFull(c){
  if(!c || !c.photo) return;
  if(S.imgProv === 'none'){ toast('Pornește pozele din Setări → Poze.'); return; }
  const base = await DB.get(c.photo); if(!base) return;
  const st = {vars:[], busy:true, ac:new AbortController()};
  openSheet(`<h4>🧍 Poza întreagă a lui ${esc(c.name)}</h4><div class="pad"><p class="hint" id="pmfMsg"><span class="spin"></span> Fac 2 variante din cap până-n picioare, cu aceeași față…</p><div class="crgrid" id="pmfGrid"></div>
    <div class="btns"><button class="btn" id="pmfX">Renunță</button></div></div>`);
  const sheet = $('.sheet'), grid = $('#pmfGrid'), msg = $('#pmfMsg');
  $('#pmfX').onclick = () => { st.ac.abort(); closeSheet(); };
  sheet.addEventListener('click', async e => {
    const pv = e.target.closest('[data-pv]'); if(pv){ const v = st.vars[+pv.dataset.pv], ok = st.vars.filter(x => x.st === 'ok'); const face = {}; for(const x of ok) if(x.chk && x.chk.box) face[x.url] = x.chk.box; viewImg(v.url, ok.map(x => x.url), null, {face}); return; }
    const pc = e.target.closest('[data-pc]'); if(!pc || st.saving) return; st.saving = true; st.ac.abort();
    const v = st.vars[+pc.dataset.pc]; pc.disabled = true; pc.innerHTML = '<span class="spin"></span>';
    await saveFull(c, v); closeSheet(); toast('🧍 Poza întreagă e salvată.');
    if(profId === c.id) charProfile(c.id, false);
  });
  const draw = () => { if(!grid.isConnected) return; grid.innerHTML = st.vars.map((v, i) => `<figure class="crv${v.st === 'ok' ? '' : ' ' + v.st}">${v.url ? `<img src="${v.url}" alt="" data-pv="${i}">` : '<div class="crph"></div>'}<figcaption>${crBadge(v)}</figcaption>${v.st === 'ok' && !v.fixing ? `<button type="button" class="btn sm" data-pc="${i}">Alege</button>` : ''}</figure>`).join(''); };
  st.vars = await fullVariants(c, base, st.ac.signal, vs => { st.vars = vs; draw(); });   // 9.36: același cod și pentru poza întreagă automată
  if(!grid.isConnected) return;
  const ok = st.vars.filter(v => v.st === 'ok');
  msg.textContent = ok.length ? 'Atinge una ca s-o vezi mare, apoi „Alege”. Poza de profil rămâne aceeași.' : 'N-a ieșit nicio variantă. Mai încearcă.';
}

/* ───────── EDITOR ───────── */
let ed = null; // {id|null, photoBlob|null, photoKey}
function edModeSet(adv){ $('#vEdit').classList.toggle('ed-advanced', adv); $('#vEdit').classList.toggle('ed-simple', !adv); $('#edMode').textContent = adv ? '✨ Mod simplu' : '⚙️ Avansat'; $('#edMode').setAttribute('aria-pressed', String(adv)); }
function openEditor(id){
  const c = id ? charById(id) : null;
  edLeaveOK = false;
  ed = {id:c ? c.id : null, photoBlob:null, photoKey:c ? c.photo : null, fromChat:!$('#vChat').hidden || !$('#vProf').hidden};
  $('#edTitle').textContent = c ? c.name : 'Personaj nou';
  edModeSet(S.edAdv === 'on'); $('#edPresetStatus').textContent = 'Nu suprascrie câmpurile deja completate.';
  $('#edStart').hidden = !!c; ed.preset = '';   // 9.79: „Creează rapid” doar la un personaj nou, în pasul 1 (derulează cu formularul)
  $$('#edPersonalityPresets button').forEach(b => b.classList.remove('on')); $$('#edLookPresets button').forEach(b => b.classList.toggle('on', (c?.stil || 'photo') === b.dataset.look));
  $('#edName').value = c?.name || ''; $('#edTag').value = c?.tag || '';
  $('#edAspect').value = c?.aspect || ''; $('#edPersona').value = c?.persona || '';
  duoFill(c);   // 9.63
  $('#edSpeech').value = c?.speech || ''; $('#edGreet').value = c?.greet || '';
  $('#edLook').value = c?.look || ''; $('#edStil').value = c?.stil || 'photo';
  ed.accent = c?.accent || ''; ed.bg = c?.bg || 'clar'; drawLook();
  $('#edDelWrap').hidden = !c;
  $('#edNames').innerHTML = '';
  edGo(1);
  setEdStatus('');
  renderEdPhoto();
  crInit(c);   // 9.24
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
  $('#edGen').textContent = u ? '🎨 Altă poză din descriere (pasul 1)' : '🎨 Fă-i poza din descriere (pasul 1)';
  ownSync();
}
// 9.24: o poză de profil pusă altfel (urcată, portret din descriere, surpriză): poza întreagă și unghiurile nu mai sunt ale ei
function crReset(){ if(!ed) return; ed.fullTouched = true; ed.fullBlob = null; ed.fullBox = null; ed.bodyFull = null; ed.angles = null; ed.readP = null; if(ed.cr){ ed.cr.chosen = -1; ed.cr.vars.forEach(v => v.keep = false); crRender(); } const av = $('#edAngleView'); if(av) av.innerHTML = ''; }
function setEdStatus(t, cls = ''){ const s = $('#edStatus'); s.className = 'status ' + cls; s.innerHTML = t; }
async function edPhotoBlob(){ return ed.photoBlob || (ed.photoKey ? await DB.get(ed.photoKey) : null); }
async function onPhotoPicked(file){
  if(!file) return;
  try{ ed.photoBlob = await toJpeg(file); ed.aiPortrait = false; crReset(); }catch(e){ setEdStatus('Nu pot citi poza.', 'err'); return; }
  if(ed.cr){ ed.cr.vars = ed.cr.vars.filter(x => !x.own); ed.cr.chosen = -1; crRender(); }   // 9.34: poza ta veche nu mai e baza ajustărilor
  await renderEdPhoto();
  await runDescribe();
  if(ed && ed.cr && ownMode()) crReadPhoto(true);   // 9.34: zonele și corpul, din poza ta
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
    if(S.imgProv !== 'none'){   // 9.84: portretul prin creator (4 variante, verificate), nu din generatorul vechi cu o singură poză
      $('#edPrompt').value = t('aspect'); $('#edStil').value = stil; crStyleSync(); edGo(1); crGenerate(); }
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
    ed.aiPortrait = true; crReset();
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
// 9.63: panoul „👯 Două personaje” din editor
const DUO_HINT = /(?<!\p{L})(două personaje|doua personaje|doi |două |doua |amândou|amandou|amândoi|amandoi|gemene|gemeni|surori|surorile|frați|frati|frații|fratii|colege de apartament|colegi de apartament|cuplu|prietene cele mai bune|cele mai bune prietene|el și ea|ea și el)(?!\p{L})/iu;
function duoFill(c){
  const on = duoOn(c) || !!(c && c.duo && c.duo.b && c.duo.on);
  $('#edDuo').checked = on; $('#edDuoBox').hidden = !on;
  const b = (c && c.duo && c.duo.b) || {};
  $('#edDuoName').value = b.name || ''; $('#edDuoPersona').value = b.persona || ''; $('#edDuoAspect').value = b.aspect || ''; $('#edDuoSpeech').value = b.speech || ''; $('#edDuoRel').value = (c && c.duo && c.duo.rel) || '';
  if(c && c.duo && c.duo.a && on) $('#edName').value = c.duo.a.name;
  duoHintSync();
}
function duoHintSync(){ const t = [$('#edPrompt') && $('#edPrompt').value, $('#edPersona').value, $('#edAspect').value].join(' '); $('#edDuoHint').hidden = $('#edDuo').checked || !DUO_HINT.test(t); }
function duoRead(){
  if(!$('#edDuo').checked) return null;
  const a = $('#edName').value.trim(), n = $('#edDuoName').value.trim();
  if(!n){ toast('Pune numele celui de-al doilea personaj.'); $('#edDuoName').focus(); return false; }
  if(pnorm(n) === pnorm(a)){ toast('Cele două personaje au nevoie de nume diferite.'); $('#edDuoName').focus(); return false; }
  const all = [$('#edPersona').value, $('#edDuoPersona').value, $('#edDuoAspect').value].join(' ');
  if(typeof CR_MINOR !== 'undefined' && CR_MINOR.test(all)){ toast('Personajele trebuie să fie adulte.'); return false; }
  return {on:true, a:{name:a}, b:{name:n, persona:$('#edDuoPersona').value.trim(), aspect:$('#edDuoAspect').value.trim(), speech:$('#edDuoSpeech').value.trim()}, rel:$('#edDuoRel').value.trim()};
}
async function duoSplitDesc(){
  const src = [$('#edPrompt') && $('#edPrompt').value.trim(), $('#edName').value.trim() && 'Nume: ' + $('#edName').value.trim(), $('#edPersona').value.trim(), $('#edAspect').value.trim()].filter(Boolean).join('\n');
  if(src.length < 20){ toast('Scrie întâi descrierea (cu cele două personaje), apoi apasă din nou.'); return; }
  if(typeof CR_MINOR !== 'undefined' && CR_MINOR.test(src)){ toast('Personajele trebuie să fie adulte.'); return; }
  if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; }
  const b = $('#edDuoSplit'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Le despart…';
  try{
    const j = await crAskJSON('Desparți o descriere în două personaje de poveste, distincte. Răspunzi DOAR cu JSON valid, în română.',
`Descrierea scrisă de utilizator (conține două personaje):
${src}
Despart-o în DOUĂ personaje adulte (21+), fiecare cu: "name" (numele din descriere; dacă lipsește, unul potrivit), "persona" (cine e, ce-i place, cum se poartă, relația cu utilizatorul, 3-6 propoziții, fidel descrierii, completând firesc), "aspect" (cum arată, fără haine trecătoare: vârstă, față, păr, corp, semne; doar ce reiese din descriere, completat discret), "speech" (cum vorbește, 4-10 cuvinte, clar diferit de celălalt). Plus "rel": ce relație au ele două între ele (o propoziție). Nu amesteca trăsăturile unuia cu ale celuilalt.
JSON: {"a":{"name":"","persona":"","aspect":"","speech":""},"b":{"name":"","persona":"","aspect":"","speech":""},"rel":""}`, 1400);
    const A = j.a || {}, B = j.b || {}, cl = v => faraLiniute(String(v || '')).trim();
    if(!cl(A.name) || !cl(B.name)) throw new Error('n-am găsit două personaje în descriere');
    if(typeof CR_MINOR !== 'undefined' && CR_MINOR.test([A.persona, A.aspect, B.persona, B.aspect].join(' '))) throw new Error('personajele trebuie să fie adulte');
    $('#edName').value = cl(A.name).slice(0, 40); $('#edPersona').value = cl(A.persona); $('#edAspect').value = cl(A.aspect); if(!$('#edSpeech').value.trim()) $('#edSpeech').value = cl(A.speech).slice(0, 200);
    $('#edDuoName').value = cl(B.name).slice(0, 40); $('#edDuoPersona').value = cl(B.persona); $('#edDuoAspect').value = cl(B.aspect); $('#edDuoSpeech').value = cl(B.speech).slice(0, 200); $('#edDuoRel').value = cl(j.rel).slice(0, 160);
    $('#edDuo').checked = true; $('#edDuoBox').hidden = false; duoHintSync();
    toast('👯 ' + $('#edName').value + ' și ' + $('#edDuoName').value + ': verifică și corectează ce vrei');
  }catch(e){ toast('N-a mers: ' + (e.message || e), 4000); }
  finally{ b.disabled = false; b.textContent = '✨ Împarte descrierea în două personaje'; }
}
async function saveEditor(){
  if(edSaving || !ed) return;
  edSaving = true;
  try{ await saveEditorNow(); } finally { edSaving = false; }
}
async function saveEditorNow(){
  let name = $('#edName').value.trim();
  if(!name){ toast('Pune un nume.'); $('#edName').focus(); return; }
  const duo = duoRead(); if(duo === false) return;   // 9.63
  let c = ed.id ? charById(ed.id) : null;
  const isNew = !c;
  if(isNew){ c = {id:uid(), created:Date.now()}; chars.push(c); }
  if(ed.photoBlob){ const old = c.photo; c.photo = await saveImg(ed.photoBlob); if(old) await delPhotoIfUnused(c, old); c.aiPortrait = !!ed.aiPortrait;
    // 9.26: avatarele vii și unghiurile făcute automat erau ale feței vechi: se scot (altfel avatarul și pozele din chat arătau altă persoană)
    if(old && c.avs){ for(const k of Object.values(c.avs)) await delImg(k).catch(() => {}); delete c.avs; c.avLive = false; }
    if(old && c.refsAuto && !(ed.angles && ed.angles.length)){ for(const k of c.refs || []) await delImg(k).catch(() => {}); c.refs = []; delete c.refsAuto; c.refBoxes = {}; }
    if(old && c.sheet){ for(const x of c.sheet.v || []) await delImg(x.k).catch(() => {}); delete c.sheet; delete c.sheetTry; } }   // 9.84: fișa feței vechi
  await crSave(c);   // 9.24: poza întreagă, corpul, unghiurile, descrierea ta
  const oldGreet = c.greet;
  Object.assign(c, {name, tag:$('#edTag').value.trim(), aspect:$('#edAspect').value.trim(), persona:$('#edPersona').value.trim(),
    speech:$('#edSpeech').value.trim(), greet:$('#edGreet').value.trim(), look:$('#edLook').value.trim(), stil:$('#edStil').value,
    accent:ed.accent || '', bg:ed.bg || 'clar'});
  if(duo){ c.duo = duo; c.name = duo.a.name + ' & ' + duo.b.name; groups.forEach(g => { if(g.members.includes(c.id)) g.members = g.members.filter(x => x !== c.id); }); saveGroups(); }   // 9.63
  else if(c.duo){ c.duo.on = false; }
  await saveChars();
  // dacă salutul s-a schimbat și conversația are doar salutul, îl înlocuim
  if(!isNew && oldGreet !== c.greet){
    const key = chatKey(c.id, c.thread), ch = await DB.get(key);
    if(ch && ch.msgs.length <= 1){ ch.msgs = c.greet ? [greetMsg(c)] : []; await DB.set(key, ch); }
  }
  const fromChat = ed.fromChat; ed = null;
  // 9.84: fidelitatea se pregătește de la creare: poza întreagă (dacă lipsește), apoi fișa de identitate, în fundal
  if(c.photo && (c.stil || 'photo') === 'photo' && S.imgProv === 'worker') setTimeout(async () => { const cc = charById(c.id); if(!cc) return; await autoFull(cc).catch(() => {}); if(await sheetGen(cc).catch(() => false)) toast(`🧩 ${cc.name} are acum fișa de identitate (4 unghiuri ale feței), pentru poze mai fidele.`, 4000); if(await bsheetGen(cc).catch(() => false)) toast(`🧍 ${cc.name} are acum și fișa de corp (¾, profil, așezată).`, 4000); }, 2500);
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
    if(c.duo && c.duo.b && c.duo.b.photo) await delImg(c.duo.b.photo).catch(() => {});   // 9.64
    for(const k of Object.values(c.avs || {})) await delImg(k).catch(() => {});
    for(const x of c.stickers || []) await delImg(x.k).catch(() => {});
    for(const k of c.refs || []) await delImg(k).catch(() => {});
    for(const x of [...((c.sheet && c.sheet.v) || []), ...((c.bsheet && c.bsheet.v) || [])]) await delImg(x.k).catch(() => {});   // 9.83 / 9.85
    if(c.photoFull) await delImg(c.photoFull).catch(() => {});   // 9.24
    for(const p of feedCache.filter(p => p.cid === c.id)) if(p.img) await delImg(p.img).catch(() => {});
    feedCache = feedCache.filter(p => p.cid !== c.id); await saveFeed();
    chars = chars.filter(x => x !== c); await saveChars();
    if(groups.some(g => g.members.includes(c.id))){ groups.forEach(g => g.members = g.members.filter(id => id !== c.id)); await saveGroups(); }   // 9.44
    ed = null; profId = null; closeSheet(); goHome(); toast('🗑️ ' + c.name + ' a fost șters.');   // Înapoi ulterior nu mai poate redeschide un personaj șters (popstate verifică charById)
  });
}

/* ───────── SETĂRI ───────── */
const aiReady = () => hasKey('anthropic');
const FIELDS = {stKey:'key', stModel:'model', stUser:'userName', stAbout:'userAbout', stBday:'userBday',
  stWkBase:'wkBase', stWkTok:'wkTok', stWkModel:'wkModel', stWkSize:'wkSize',
  stPin:'pIn', stPout:'pOut', stVkBase:'wkBase', stVkTok:'wkTok', stRwKey:'rwKey'};
const SEGS = {stCallFill:'callFill', stRw:'rw', stRwCap:'rwCap', stRegen:'regen3', stFx:'fx', stFeed:'feed', stStory:'story', stSky:'sky', stSocial:'social', stCfCap:'cfCap', stCfPlan:'cfPlan', stAux:'aux', stCtx:'ctxN', stVmsg:'vmsg', stJrn:'jrn', stTheme:'theme', stLen:'len', stFont:'font', stImg:'imgProv', stSugg:'sugg', stPro:'pro', stVoice:'voice', stSpont:'spont', stBkEvery:'bkEvery', stVault:'vault', stCallFace:'callFace', stCallAmb:'callAmb', stCallBack:'callBack', stCallDepth:'callDepth', stCallLight:'callLight', stCallPres:'callPres', stTypeReal:'typeReal', stImgRoute:'imgRoute', stCfFallback:'cfFallback', stPhotoModel:'photoModel', stPeople:'people', stChatMode:'chatMode', stRpStyle:'rpStyle', stSmart:'smart', stLenAuto:'lenAuto', stCacheTtl:'cacheTtl', stCtxCompact:'ctxCompact', stCallLife:'callLife', stCallCam:'callCam', stCallGlitch:'callGlitch', stCallBg:'callBg', stCallSprites:'callSprites', stCallMirror:'callMirror'};
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
  if(p === 'img'){ loadNeurons(); drawChatHint(); $('#stWkConn').open = !String(S.wkBase || '').trim(); }
  if(p === 'ai'){ $('#stVaultDet').open = S.vault === 'on'; }
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
  $('#sum_ai').innerHTML = hasKey('anthropic') ? `<span class="ok">✓</span> Claude · ${esc(S.model || DEF.model)}${vaultOn() ? ' · 🔐 seif' : ''}` : '<span class="bad">lipsește cheia</span>';
  $('#sum_me').textContent = nm ? nm + (S.userAbout.trim() ? ' · ' + S.userAbout.trim() : '') : 'Cum să-ți spună personajele';
  const ip = {none:'Oprite', worker:'Worker Cloudflare · ' + (S.wkModel || 'eco') + (S.cfPlan === 'paid' ? ' · Paid' : '') + (S.rw === 'on' ? ' · ⚡ 9B pe Runware' : '')}[S.imgProv] || '';
  $('#sum_img').textContent = ip;
  $('#sum_chat').textContent = {scurt:'Răspunsuri scurte', mediu:'Răspunsuri medii', lung:'Răspunsuri lungi'}[S.len] + ' · voce ' + {off:'oprită', tap:'la 🔊', auto:'automată'}[S.voice] + ' · vocea telefonului';
  $('#sum_lock').textContent = S.lock === 'bio' ? 'Amprentă + PIN' : S.lock === 'pin' ? 'PIN' : 'Oprită';
  $('#sum_push').textContent = S.pushOn ? 'Pornite' : 'Oprite';
  $('#sum_look').textContent = {auto:'Temă automată', dark:'Temă întunecată', light:'Temă luminoasă'}[S.theme] + ' · text ' + {15:'mic', 16:'normal', 18:'mare'}[S.font];
  renderDash();
}
/* ═════════ ⚙️ 9.22 Setări noi: bord de stare, verificare, mod rapid, căutare ═════════ */
const MODES = {
  eco:{ctxN:'20', regen3:'off', rwCap:'0.25'},
  bal:{ctxN:'30', regen3:'on', rwCap:'0.5'},
  max:{ctxN:'60', regen3:'on', rwCap:'1'}};   // 9.84: fidelitatea pozelor nu mai depinde de mod (e mereu la maxim)
const MODE_TXT = {
  eco:'Personajul primește ultimele 20 de mesaje · ↻ face o variantă · Runware max $0,25/zi (pozele rămân la fidelitate maximă).',
  bal:'Ultimele 30 de mesaje · ↻ cu 3 variante · Runware max $0,50/zi.',
  max:'Ultimele 60 de mesaje (personajul ține minte mai mult) · ↻ cu 3 variante · Runware max $1/zi.'};
const MODE_NAME = {eco:'🌱 Economic', bal:'⚖️ Echilibrat', max:'💎 Maxim'};
const modeNow = () => Object.keys(MODES).find(k => Object.entries(MODES[k]).every(([kk, v]) => String(S[kk]) === v)) || '';
function drawMode(){
  const m = modeNow();
  $$('#stMode button').forEach(b => b.classList.toggle('on', b.dataset.v === m));
  $('#stModeNow').textContent = m ? 'activ: ' + MODE_NAME[m] : 'personalizat';
  $('#stModeHint').textContent = m ? MODE_TXT[m] : 'Ai reglaje proprii. Alege un mod ca să le pui pe toate deodată (le poți schimba apoi una câte una).';
}
function applyMode(k){
  if(!MODES[k]) return;
  Object.assign(S, MODES[k]); saveSettings(); syncSegs();
  toast(MODE_NAME[k] + ' pornit', 2200);
}
function healthIssues(){
  const out = [];
  if(!hasKey('anthropic')) out.push({t:'🔑 Lipsește cheia Anthropic', p:'ai'});
  if(S.imgProv === 'worker' && !String(S.wkBase || '').trim()) out.push({t:'🔗 Lipsește adresa Worker-ului', p:'img'});
  if(S.imgProv === 'worker' && S.rw === 'on'){
    if(!rwReady()) out.push({t:'⚡ Runware n-are cheie (RUNWARE_KEY în Worker)', p:'img'});
    else if(rwPaused()) out.push({t:'⚡ Runware a dat erori: pozele merg 10 min pe Cloudflare', p:'img'});
    else if(rwCapLeft() < rwPer()) out.push({t:'⚡ Plafonul Runware de azi e atins: pozele merg pe Cloudflare', p:'img'});
  }
  if(S.imgProv === 'worker' && S.cfPlan === 'paid' && S.cfCap === 'none') out.push({t:'☁️ Cloudflare fără limită: pozele peste cotă se plătesc', p:'img'});
  if(bkDue()) out.push({t:'💾 Ultimul backup e mai vechi de 7 zile', p:'data'});
  return out;
}
async function renderDash(){
  const ai = $('#dAi'); if(!ai) return;
  const key = hasKey('anthropic'), mdl = String(S.model || DEF.model).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
  ai.textContent = key ? mdl.charAt(0).toUpperCase() + mdl.slice(1) : 'fără cheie';
  ai.parentElement.className = 'stile ' + (key ? 'ok' : 'bad');
  const im = $('#dImg'), sub = $('#dImgSub');
  if(S.imgProv !== 'worker'){ im.textContent = 'Oprite'; sub.textContent = 'Poze'; im.parentElement.className = 'stile'; }
  else if(S.rw === 'on'){ const d = rwDay(); im.textContent = usd(d.usd) + ' azi'; sub.textContent = '⚡ Runware · ' + d.n + ' img'; im.parentElement.className = 'stile ok'; }
  else { neurCalc(); im.textContent = Math.round(Math.min(100, neurToday / 100)) + '% cotă'; sub.textContent = '☁️ Cloudflare azi'; im.parentElement.className = 'stile' + (neurToday >= 10000 ? ' bad' : ' ok'); }
  const iss = healthIssues(), hb = $('#stHealth');
  hb.className = 'shealth' + (iss.length ? ' warn' : '');
  if(iss.length){ hb.dataset.p = iss[0].p; hb.innerHTML = `<span>${esc(iss[0].t)}${iss.length > 1 ? ` <small>(+${iss.length - 1})</small>` : ''}</span><em>Rezolvă ›</em>`; }
  else { delete hb.dataset.p; hb.innerHTML = '<span>✓ Totul e în regulă: Claude, pozele și backup-ul</span>'; }
  drawMode();
  try{
    const u = await DB.get('usage'), M = u && u.months && u.months[new Date().toISOString().slice(0, 7)];
    $('#dCost').textContent = usd(M ? M.txt + M.img + (M.voc || 0) : 0);
  }catch(e){}
}
// căutare: etichetele, titlurile și secțiunile pliate din toate panourile
const fold = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
let findIdx = null;
function findIndex(){
  if(findIdx) return findIdx;
  findIdx = [];
  for(const pn of $$('#vSet .panel')) for(const el of pn.querySelectorAll('label, h3, details > summary')){
    const t = (el.matches('summary') ? el.childNodes[0].textContent : el.textContent).trim();
    if(t) findIdx.push({p:pn.dataset.panel, title:pn.dataset.title, el, t, f:fold(t)});
  }
  return findIdx;
}
// cel mai de sus element ascuns dintre setare și panou (o secțiune care apare doar după altă alegere), sau null
function hiddenTop(el, pn){ let top = null; for(let x = el; x && x !== pn; x = x.parentElement) if(x.hidden) top = x; return top; }
// ce alegere deschide secțiunea ascunsă: butoanele de dinaintea ei (sărind peste explicații)
function opener(top){ let x = top.previousElementSibling; while(x && (x.matches('p.hint, .hint, .status') || x.hidden)) x = x.previousElementSibling; return x; }
function runFind(q){
  const box = $('#stFindRes'); q = fold(q).trim();
  if(q.length < 2){ box.innerHTML = ''; return; }
  const words = q.split(/\s+/);
  const hits = findIndex().filter(x => words.every(w => x.f.includes(w))).slice(0, 8);
  box.innerHTML = hits.length ? hits.map(x => { const hid = hiddenTop(x.el, x.el.closest('.panel'));
    return `<button type="button" data-fi="${findIdx.indexOf(x)}">${esc(x.t.slice(0, 90))}<small>${esc(x.title)}${hid ? ' · apare după o altă alegere, îți arăt care' : ''}</small></button>`; }).join('') : '<p>Nicio setare cu „' + esc(q) + '”.</p>';
}
function goFind(i){
  const x = findIdx && findIdx[i]; if(!x) return;
  $('#stFind').value = ''; $('#stFindRes').innerHTML = '';
  openSetPanel(x.p);
  setTimeout(() => {
    for(let d = x.el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    const hid = hiddenTop(x.el, x.el.closest('.panel'));
    let tgt = x.el.matches('label') && x.el.nextElementSibling && !x.el.nextElementSibling.matches('label, h3') ? x.el.nextElementSibling : x.el;
    if(hid){ tgt = opener(hid) || hid.parentElement; toast('„' + x.t.slice(0, 40) + '” apare după ce alegi aici.', 3200); }
    tgt.scrollIntoView({block:'center', behavior:'smooth'});
    tgt.classList.remove('sflash'); void tgt.offsetWidth; tgt.classList.add('sflash');
  }, 120);
}
function syncSegs(){
  for(const [id, k] of Object.entries(SEGS)) $$('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S[k])));
  $('#stAnt').hidden = S.vault === 'on';
  $('#stVaultBox').hidden = S.vault !== 'on';
  $('#stVkWipeWrap').hidden = !(S.vault === 'on' && S.vaultHas && ['key', 'rwKey'].some(k => String(S[k] || '').trim()));
  if(!$('#vSet').hidden) renderSetSummary();
  $$('#stImg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.imgProv));
  $('#stImgTestWrap').hidden = S.imgProv === 'none';
  $('#stChatWrap').hidden = S.imgProv !== 'worker'; drawChatHint(); drawFixHint(); drawBodyHint(); drawBestHint();
  drawWkEst(); drawRw();
  $('#stCapWrap').hidden = S.cfPlan !== 'paid';
  $('#stCapHint').textContent = {free:'Factura rămâne $5/lună, fără nimic în plus. ' + (S.wkChat === 'ancorat' ? 'Pozele merg pe 9B cât încap în cei 10.000 de neuroni gratuiți (~6 pe zi), apoi trec singure pe Eco (cu retușul feței, ~115 neuroni) și abia când nu mai încape nici Eco se opresc' : 'Când se termină neuronii gratuiți de azi, pozele se opresc') + ' până la ' + resetAt() + '.',
    '0.1':'Cel mult ~$0,10 pe zi peste cei $5 (≈ $3/lună în cel mai rău caz). Apoi pozele se opresc până la ' + resetAt() + '.',
    none:'Fără oprire: fiecare poză peste cotă se adaugă la factură.'}[S.cfCap] || '';
  $('#stWk').hidden = S.imgProv !== 'worker';
  $('#stCfSec').hidden = $('#stTestDet').hidden = S.imgProv !== 'worker';
  { let host = ''; try{ host = S.wkBase ? new URL(wkUrl()).host : ''; }catch(e){} $('#stWkConnSum').textContent = host ? '✓ ' + host : '⚠ necompletată'; }
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
  if(S.imgProv !== 'worker') return Infinity;
  // 9.37: pe „Gratuit” aplicația se oprește singură la cei 10.000 de neuroni (nu se mai bazează pe Cloudflare să blocheze:
  //       dacă în cont e de fapt Workers Paid, Cloudflare ar taxa în tăcere ce trece de cotă)
  if(S.cfPlan !== 'paid'){ neurCalc(); return 10000 - neurToday; }
  if(!(S.cfCap in CAP_USD)) return Infinity;
  neurCalc();
  return 10000 + CAP_USD[S.cfCap] / NEUR_USD - neurToday;
}
const capMsg = () => S.cfPlan !== 'paid' ? `Neuronii gratuiți Cloudflare de azi s-au terminat; aplicația nu mai trimite poze pe Cloudflare până la ${resetAt()}.` : S.cfCap === 'free' ? `Neuronii gratuiți de azi s-au terminat și ai ales „Doar gratuit”. Pozele revin la ${resetAt()}.` : `Ai atins limita de $0,10 pe azi pentru poze. Revin la ${resetAt()}.`;
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
    // 9.20: cu „Fidel · 9B” pe Runware, din neuroni se mai fac doar pozele Eco (stickere, avatar, retuș) și rezerva la eroare
    const rw = rwFor('ancorat'), per = neurPerPhoto(rw ? 'eco' : sceneModel()), left = per ? Math.max(0, Math.floor((lim - d.neurons) / per)) : null;
    const what = rw ? 'poze Eco rămase (stickere, avatar)' : 'poze rămase', rwNote = rw ? '<div style="margin-top:6px;font-size:12px;color:var(--tx3)">⚡ Pozele 9B din chat merg pe Runware și nu consumă neuroni.</div>' : '';
    const warnOk = after && lastImgProv !== 'runware' && !allRw();   // 9.37: pe „Totul pe Runware” nu mai apar avertismentele Cloudflare
    if(S.cfPlan === 'paid'){
      const over = Math.max(0, d.neurons - lim), day = new Date().toISOString().slice(0, 10);
      box.className = 'neur';
      box.innerHTML = `Azi: <b>${Math.round(d.neurons).toLocaleString('ro-RO')}</b> neuroni · primii ${lim.toLocaleString('ro-RO')} gratuiți`
        + (over ? ` · peste cotă: <b>${Math.round(over).toLocaleString('ro-RO')}</b> ≈ <b>${usd(over * NEUR_USD)}</b> azi` : left !== null ? ` · <b>~${left}</b> ${rw ? what : 'poze gratuite rămase'}, apoi ~${usd(per * NEUR_USD)}/poză` : '')
        + `<div class="bar"><i style="width:${pc}%"></i></div>` + rwNote;
      { const nb = S.neurBy && S.neurBy.d === utcDay() ? Object.entries(S.neurBy.by).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]) : [];
        if(nb.length) box.innerHTML += `<div style="margin-top:6px;font-size:12px;color:var(--tx3)">Pe ce, azi (estimat de aplicație): ${nb.map(([k, v]) => (NEUR_WHY[k] || k) + ' ' + Math.round(v).toLocaleString('ro-RO')).join(' · ')}</div>`; }
      if(capLeft() !== Infinity && capLeft() < (per || 5000)) box.innerHTML += `<div style="margin-top:6px;color:var(--warn,#ffb020)">⏸ Pozele sunt oprite până la ${resetAt()} (limita ta).</div>`;
      if(warnOk && over && neurWarned !== day){ neurWarned = day; toast(`Ai trecut de cota gratuită de azi. Pozele merg în continuare${per ? `, ~${usd(per * NEUR_USD)} fiecare` : ''}.`, 4500); }
      return;
    }
    box.className = 'neur' + (pc >= 80 ? ' warn' : '');
    box.innerHTML = `Azi: <b>${Math.round(d.neurons).toLocaleString('ro-RO')}</b> / ${lim.toLocaleString('ro-RO')} neuroni gratuiți (${Math.round(pc)}%)${left !== null ? ` · <b>~${left}</b> ${what}` : ''}<div class="bar"><i style="width:${pc}%"></i></div>` + rwNote;
    // 9.37: pe planul Free, Cloudflare blochează la 10.000; dacă a lucrat peste, contul e de fapt pe Workers Paid și se taxează
    if(d.neurons > lim * 1.02) box.innerHTML += `<div style="margin-top:8px;color:var(--warn,#ffb020);line-height:1.4">⚠️ Cloudflare a lucrat azi <b>${Math.round(d.neurons - lim).toLocaleString('ro-RO')}</b> neuroni peste cota gratuită (≈ ${usd((d.neurons - lim) * NEUR_USD)}). Pe planul Free s-ar fi oprit la 10.000, deci contul tău pare să fie pe <b>Workers Paid</b>. Alegerea de aici e doar pentru aplicație: planul se schimbă din dashboard-ul Cloudflare (Workers → Plans). De acum aplicația se oprește singură la 10.000.</div>`;
    // 9.20: avertismentul apare doar când poza chiar a mers pe Cloudflare, și o singură dată pe zi pentru fiecare prag (80% / 100%)
    const lvl = utcDay() + (pc >= 100 ? ':100' : ':80');
    if(warnOk && pc >= 80 && S.neurWarnFree !== lvl && (S.neurWarnFree = lvl, saveSettings(), true)) toast(pc >= 100 ? '⚠️ Cota gratuită Cloudflare de azi s-a terminat. Se resetează la ' + resetAt() + '.' : `⚠️ Ai folosit ${Math.round(pc)}% din neuronii gratuiți de azi.`, 4500);
  }catch(e){ box.className = 'neur'; box.textContent = 'Consum neuroni: ' + e.message; }
}
/* 🔬 7.3: comparație reală pe Worker-ul tău, cu poza de profil a personajului: eco 2 repere, eco 1 reper, 9B */
function drawBestHint(){
  const el = $('#stBestHint'); if(!el) return;
  const nine = sceneModel() !== 'eco', key = nine ? 'bestOf9' : 'bestOf';
  $$('#stBestOf button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S[key] || (nine ? '1' : '3'))));
  const n = Math.max(1, Math.min(3, +(S[key] || (nine ? '1' : '3')) || 1)), per = neurPerPhoto(sceneModel()) || 0;
  if(S.imgProv === 'worker' && nine && rwFor('ancorat')){ el.textContent = n < 2 ? `O singură variantă pe poză (~${usd4(rwPer())}, Runware).` : `Se fac ${n} variante în paralel pe Runware; telefonul le măsoară fața și o păstrează pe cea mai asemănătoare cu poza de profil. ~${usd(rwPer() * n)} pe poză, tot mai puțin decât o singură poză 9B pe Cloudflare (~${usd((neurPerPhoto('ancorat') || 1455) * NEUR_USD)}).`; return; }
  el.textContent = S.imgProv !== 'worker' ? 'Merge cu Worker-ul tău (Cloudflare).' : n < 2 ? 'O singură variantă pe poză.'
    : `Se fac ${n} variante în paralel; telefonul le măsoară fața și o păstrează pe cea mai asemănătoare cu poza de profil. ~${Math.round(per * n).toLocaleString('ro-RO')} neuroni pe poză${nine ? ' pe 9B (fiecare variantă în plus costă încă o poză întreagă)' : ''}. Dacă limita zilnică nu ajunge, se fac mai puține.`;
  if(n < 2 && S.imgProv === 'worker') el.textContent = `O singură variantă pe poză (~${Math.round(per).toLocaleString('ro-RO')} neuroni${nine ? ', 9B' : ''}).`;
  const ah = $('#stAutoHint'); if(ah){ const e = neurPerPhoto('eco'); ah.textContent = S.autoModel === 'eco' ? `Stories și statusuri pe Eco: ~${Math.round(e * Math.max(1, +S.bestOf || 1) + 37)} neuroni pe poză (cu variante și retușul feței). Pozele din chat rămân pe modelul de mai sus.` : `La fel ca pozele din chat${nine ? ' (9B, ~' + Math.round(per).toLocaleString('ro-RO') + ' neuroni pe poză)' : ''}.`; }
}
function drawBodyHint(){
  const el = $('#stBodyHint'); if(!el) return;
  el.textContent = S.imgProv !== 'worker' ? 'Disponibilă cu furnizorul Worker/Cloudflare. Folosește poza întreagă a personajului dacă vrei proporții mai fidele.' : S.bodyFix !== 'off'
    ? `Activă: dacă verificarea găsește corpul sau bustul prea diferit de referință, Taifas încearcă o corectare separată și păstrează rezultatul numai dacă fața și scena nu se înrăutățesc. Cost suplimentar doar când e necesar (~${Math.round(neurPerPhoto('eco'))} neuroni pe încercare). Pentru rezultate bune, adaugă o poză de profil în care se vede corpul sau creează „Poza întreagă”.`
    : 'Oprită: folosește doar referințele și descrierea corpului din prompt. Activeaz-o dacă proporțiile corpului sau volumul bustului variază prea mult.';
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
  if(S.rw === 'on'){ el.innerHTML = `Pozele din chat și din creator se fac mereu cu FLUX.2 klein 9B, pe Runware (~${usd4(rwPer())} pe imagine, fără neuroni)${S.imgRoute === 'rw' ? '' : '; stickerele și avatarul rămân pe Cloudflare'}.`; return; }
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
  if(!confirm2(`Generez ${3 + (rwReady() ? 1 : 0) + (rwReady() && S.rw === 'on' && S.idBoost !== 'off' ? 1 : 0)} poze cu ${c.name} (aceeași scenă), ca să compari fața: eco cu 2 repere, eco cu 1 reper, 9B${rwReady() ? ' pe Cloudflare, 9B pe Runware (~$0,004)' : ''} ~${cost.toLocaleString('ro-RO')} neuroni.`)) return;
  const R = await idRefs(c);
  const shot = 'mirror selfie in a cozy bedroom, standing, holding the phone, casual t-shirt and jeans, warm lamp light, relaxed smile', fr = framingOf(shot);
  const p2 = idPrompt(c, shot, fr, R, '', true), p1 = idPrompt(c, shot, fr, R, '', false);
  const tests = [['Eco · ' + (2 + R.extra.length) + ' repere', {model:'eco', force:{two:true}, p1, extra:R.extra}], ['Eco · 1 reper', {model:'eco', force:{two:false, px:512}, p1}], ['Fidel 9B' + (rwReady() ? ' · Cloudflare' : ''), {model:'ancorat', force:{two:true}, p1, extra:R.extra, cf:true}]];
  if(rwReady()) tests.push(['Fidel 9B · Runware', {model:'ancorat', force:{two:true}, p1, extra:R.extra, rw:true}]);
  if(rwReady() && S.rw === 'on' && S.idBoost !== 'off') tests.push(['Runware · identitate maximă', {boost:true}]);
  const pfu = await imgUrl(c.photo);
  box.innerHTML = `<div class="rtgrid"><figure><img src="${pfu}" alt=""><figcaption>Poza de profil</figcaption></figure>${tests.map((t, i) => `<figure id="rt${i}"><div class="ph"><span class="spin"></span></div><figcaption>${t[0]}</figcaption></figure>`).join('')}</div><p class="hint" id="rtNote">Generez pe rând…</p>`;
  let twoOk = null;
  for(let i = 0; i < tests.length; i++){
    const [lbl, o] = tests[i], fig = $('#rt' + i);
    try{
      let b;
      try{ b = o.boost ? (await idBoost(c, shot, null, null, {})).blob : await genImage(p2, R.face, null, R.body, o); }
      catch(e){ if(o.force && o.force.two){ if(o.model === 'eco') twoOk = false; b = await genImage(p2, R.face, null, R.body, {model:o.model, force:{two:false, px:512}, p1, cf:o.cf, rw:o.rw}); fig.querySelector('figcaption').textContent = lbl.replace('2 repere', '1 reper') + ' (2 repere: eroare)'; } else throw e; }
      if(o.model === 'eco' && o.force && o.force.two && twoOk === null) twoOk = true;
      fig.querySelector('.ph').outerHTML = `<img src="${URL.createObjectURL(b)}" data-big alt="">`;
      try{ const fd = (await localFace(b, c)).d; if(fd != null) fig.querySelector('figcaption').textContent += ' · fața ' + idPct(fd) + '%'; }catch(e){}   // 9.18: aceeași măsură ca la „cea mai bună din N”
    }catch(e){ fig.querySelector('.ph').innerHTML = '✗'; fig.querySelector('figcaption').textContent = lbl + ': ' + String(e.message).slice(0, 60); }
  }
  if(twoOk !== null){ S.wkRef = twoOk ? 'two' : 'one'; saveSettings(); }
  $('#rtNote').textContent = (twoOk === false ? 'Worker-ul tău nu acceptă 2 repere: de acum trimit doar poza de profil (1024 px). ' : twoOk ? '2 repere merg pe Worker-ul tău. ' : '') + 'Alege mai sus „Eco” sau „Fidel”, după fața care seamănă mai bine (procentul = asemănarea măsurată în telefon; variază de la o generare la alta, compară pe 2–3 rulări). Atinge o poză ca s-o vezi mare.';
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
    const L = {anthropic:'Anthropic', runware:'Runware'};
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
// 8.20: ce nu pleacă niciodată într-un backup și nu poate fi suprascris de o restaurare:
// cheile, adresele la care pleacă ele, seiful și blocarea (hash-ul PIN-ului s-ar sparge ușor dintr-un fișier)
const SECRET_SETTINGS = ['key', 'wkTok', 'rwKey', 'wkBase', 'prov', 'vault', 'vaultHas', 'lock', 'pinHash', 'pinSalt', 'pinLen', 'pinV', 'bioId'];
async function exportAll(share){
  toast('Pregătesc backup-ul…');
  const out = {app:'taifas2', v:APP_VER, date:new Date().toISOString(), data:{}};
  for(const k of await DB.keys()){
    let v = await DB.get(k);
    if(String(k).startsWith('aud:')) continue;   // înregistrările vocale nu intră în backup (se refac la nevoie)
    if(/^th[msx]:/.test(String(k))) continue;      // 9.13: nici miniaturile pozelor (se refac singure); 9.87: nici pozele mărite 2×
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
  $$('#stMode button').forEach(b => b.onclick = () => applyMode(b.dataset.v));
  $('#stFind').addEventListener('input', e => runFind(e.target.value));
  $('#stFindRes').addEventListener('click', e => { const b = e.target.closest('[data-fi]'); if(b) goFind(+b.dataset.fi); });
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
    const go = e.target.closest('[data-gopen]'); if(go){ openGroup(go.dataset.gopen); return; }   // 9.44
    if(e.target.closest('[data-gnew]')){ groupEditSheet(null); return; }
  });
  $('#btnGroups').onclick = groupsSheet;
  $('#gComposer').onsubmit = e => { e.preventDefault(); if(gbusy && !$('#gInp').value.trim()){ gbusy.abort(); if(gSpect) gSpectStop(); return; } gSend(); };   // 9.48: cu text scris, mesajul intră la coadă; gol = oprește
  $('#gInp').addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches){ e.preventDefault(); $('#gComposer').requestSubmit(); } });
  $('#gInp').addEventListener('input', () => { const t = $('#gInp'); t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; gSendBtn(); });
  $('#gMenu').onclick = groupMenu; $('#gWho').onclick = () => groupEditSheet(grp);
  $('#gChips').onclick = e => { if(e.target.closest('[data-gspect]')){ gSpectStart(grp); return; } if(e.target.closest('[data-gspx]')){ if(gbusy) gbusy.abort(); gSpectStop(); return; } if(e.target.closest('[data-gsubj]')){ gSubjSheet(false); return; } if(e.target.closest('[data-gbomb]')){ gSubjSheet(true); return; } if(e.target.closest('[data-gpic]')){ if(gbusy || !grp) return; if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; } const t = '📸 Faceți o poză cu voi toate?'; gchat.msgs.push({id:uid(), role:'user', text:t, ts:Date.now()}); gSave(); renderGroup(true); gRespond(t, false, true); return; } const mi = e.target.closest('[data-gmei]'); if(mi){ const c = charById(mi.dataset.gmei); if(c) gMeEdit(grp, gchat, c); return; }   // 9.59: atingi indicatorul → îl ajustezi
    const b = e.target.closest('[data-gto]'); if(!b) return; const t = $('#gInp'); const n = b.dataset.gto; if(!(' ' + pnorm(t.value) + ' ').includes(' ' + pnorm(n) + ' ')) t.value = (n + ', ' + t.value).trim(); t.focus(); gSendBtn(); };   // 9.57: fără regex (numele cu „ă” la final se adăuga de fiecare dată)
  $('#gMsgs').onclick = e => { if(e.target.closest('[data-grel]')){ gRelSheet(); return; } const rgb = e.target.closest('[data-gregen]'); if(rgb && !gbusy){ gRegen(+rgb.dataset.gregen); return; } const b = e.target.closest('[data-gmore]'); if(b && !gbusy){ if(!aiReady()){ toast('Adaugă cheia în Setări.'); return; } gRespond(null, true); return; } const im = e.target.closest('[data-gimg]'); if(im){ const m = gchat.msgs[+im.dataset.gimg]; if(m && m.img) viewImg(m.img, gchat.msgs.filter(x => x.img).map(x => x.img)); } };
  { let lpT = null; const gm = $('#gMsgs');   // 9.45: atingere lungă pe un mesaj din grup
    gm.addEventListener('pointerdown', e => { const w = e.target.closest('[data-gi]'); if(!w || e.target.closest('[data-gimg]')) return; lpT = setTimeout(() => { lpT = null; gMsgSheet(+w.dataset.gi); }, 480); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => gm.addEventListener(t, () => { clearTimeout(lpT); lpT = null; }));
    gm.addEventListener('contextmenu', e => { const w = e.target.closest('[data-gi]'); if(w){ e.preventDefault(); clearTimeout(lpT); gMsgSheet(+w.dataset.gi); } }); }
  $('#gRbX').onclick = () => { gReply = null; $('#gReplyBar').hidden = true; };
  // conversație
  $('#btnPolish').onclick = polishSheet;
  const iq = $('#intimacyQuick'), iqBtn = $('#btnIntimacy');
  const closeIq = () => { iq.hidden = true; iqBtn.setAttribute('aria-expanded', 'false'); };
  iqBtn.onclick = () => { const open = iq.hidden; iq.hidden = !open; iqBtn.setAttribute('aria-expanded', String(open)); if(open) $('#iqClose').focus({preventScroll:true}); };
  $('#iqClose').onclick = closeIq;
  iq.onclick = e => { const b = e.target.closest('[data-intimacy]'); if(!b) return; if(busy){ toast('Așteaptă să termine răspunsul curent.'); return; } $('#inp').value = b.dataset.intimacy || ''; closeIq(); autoSize(); updateComposer(); $('#composer').requestSubmit(); };
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
    if(dx > 0){ sEl.classList.add('swr'); sEl.style.setProperty('--swp', Math.min(1, dx / 70).toFixed(2));
      const rd = dx >= 70; if(rd && !sEl.classList.contains('ready') && navigator.vibrate) try{ navigator.vibrate(10); }catch(_){} sEl.classList.toggle('ready', rd); }
  }, {passive:true});
  $('#msgs').addEventListener('touchend', e => {
    if(!sEl) return; const el = sEl; sEl = null;
    const mm = el.querySelector('.m'); mm.style.transition = 'transform .22s cubic-bezier(.2,.8,.3,1)'; mm.style.transform = ''; setTimeout(() => { mm.style.transition = ''; }, 240);
    el.classList.remove('swr', 'ready'); el.style.removeProperty('--swp');
    if(sLock !== 'x') return;
    const dx = e.changedTouches[0].clientX - sx;
    if(Math.abs(dx) < 70) return;
    const i = +el.dataset.i, m = chat.msgs[i];
    if(dx > 0){ setReply(i, true); return; }
    if(!sLastAi) return;
    if((m.alt || 0) < m.alts.length - 1){ setAlt(m, (m.alt || 0) + 1); saveChat(); renderMsgs(); } else reply(m);
  });
  $('#rbX').onclick = clearReply;
  $('#jumpDown').onclick = () => { const box = $('#msgs'); box.scrollTo({top:box.scrollHeight, behavior:'smooth'}); jumpCount = 0; };
  $('#msgs').addEventListener('scroll', updateJump, {passive:true});
  { let rq = 0; $('#msgs').addEventListener('scroll', () => { markBusy(900); if(rq) return; rq = requestAnimationFrame(() => { rq = 0; dayFloatSync(true); }); }, {passive:true}); }
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
    if(e.target.closest('[data-regen]')){ if(!busy){ if(m.eco && chat){ chat.ecoCool = Date.now(); } reply(m); } return; }   // 9.60: ai refăcut un răspuns Haiku → filtrul devine mai prudent aici   // 8.19: o singură variantă nouă; „🎰 +2” doar dacă mai vrei
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
    if(e.target.closest('[data-pedit]')){ editPhotoSheet(i); return; }   // 9.40
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
  // 9.78: strat simplificat pentru creare; păstrează aceleași câmpuri și salvarea existentă
  $('#edMode').onclick = () => { const adv = !$('#vEdit').classList.contains('ed-advanced'); edModeSet(adv); S.edAdv = adv ? 'on' : 'off'; saveSettings(); };   // 9.79: alegerea rămâne
  $('#edPersonalityPresets').onclick = e => {
    const b = e.target.closest('[data-persona]'); if(!b) return;
    const t = $('#edPersona'); let current = t.value.trim();
    // 9.79: o altă presetare o înlocuiește pe cea de dinainte (nu se adună una peste alta)
    if(ed && ed.preset){ current = current.replace('\n\nStil suplimentar: ' + ed.preset, '').replace(ed.preset, '').trim(); }
    t.value = !current ? b.dataset.persona : current.includes(b.dataset.persona) ? current : current + '\n\nStil suplimentar: ' + b.dataset.persona;
    if(ed) ed.preset = b.dataset.persona;
    $$('#edPersonalityPresets button').forEach(x => x.classList.toggle('on', x === b)); $('#edPresetStatus').textContent = 'Personalitatea a fost adăugată; poți edita textul la pasul „Cine e”.';
  };
  $('#edLookPresets').onclick = e => {
    const b = e.target.closest('[data-look]'); if(!b) return;
    $('#edStil').value = b.dataset.look; crStyleSync();
    // 9.79: stilul se alege doar ca stil (butoanele Foto / Anime / Ilustrație / 3D); descrierea aspectului rămâne a ta
    $$('#edLookPresets button').forEach(x => x.classList.toggle('on', x === b)); $('#edPresetStatus').textContent = 'Stilul a fost selectat; generatorul existent îl va folosi.';
  };
  $('#edQuickFill').onclick = () => {
    const missing = [];
    if(!$('#edPersona').value.trim()) { $('#edPersona').value = 'Este un personaj adult, cu personalitate distinctă, preferințe și limite proprii. Răspunde natural, rămâne consecvent în rol și ține cont de contextul conversației.'; missing.push('personalitate de bază'); }
    if(!$('#edGreet').value.trim()) { $('#edGreet').value = '*zâmbește și te privește cu căldură* Bună! Mă bucur să te văd. Cum îți merge ziua?'; missing.push('prima replică'); }
    if(!$('#edSpeech').value.trim()) { $('#edSpeech').value = 'natural, expresiv și adaptat contextului'; missing.push('stil de vorbire'); }
    $('#edPresetStatus').textContent = missing.length ? 'Am completat: ' + missing.join(', ') + '. Poți schimba fiecare câmp.' : 'Câmpurile esențiale sunt deja completate; nu am schimbat nimic.';
    if(missing.length) toast('✨ Completare rapidă gata');
  };
  // editor
  $('#edPhoto').onclick = () => $('#edFile').click();
  $('#edFile').onchange = e => { onPhotoPicked(e.target.files[0]); e.target.value = ''; };
  $('#edRedesc').onclick = runDescribe;
  $('#edCheck').onclick = runVerify;
  $('#edDraft').onclick = runDraft;
  $('#edGen').onclick = () => { if(!$('#edPrompt').value.trim() && $('#edAspect').value.trim()) $('#edPrompt').value = $('#edAspect').value.trim(); edGo(1); setTimeout(() => $('#edCrea').scrollIntoView({block:'start', behavior:'smooth'}), 60); };   // 9.25: un singur loc pentru poză
  // 9.24–9.25: personajul din descriere (poza întreagă)
  $('#edGen4').onclick = crGenerate;
  $('#edStop').onclick = crStop;
  $('#edEnrich').onclick = crEnrich;
  $('#edQuick').onclick = e => { const b = e.target.closest('[data-q]'); if(!b) return; const t = $('#edPrompt'); t.value = (t.value.trim() ? t.value.trimEnd() + (/[,.]$/.test(t.value.trim()) ? ' ' : ', ') : '') + b.dataset.q; t.focus(); t.setSelectionRange(t.value.length, t.value.length); };
  $('#edFrame').onclick = e => { const b = e.target.closest('[data-v]'); if(!b || !ed || !ed.cr) return; ed.cr.frame = b.dataset.v; crDrawFrame(); };
  $('#edStyle').onclick = e => { const b = e.target.closest('[data-v]'); if(!b) return; $('#edStil').value = b.dataset.v; crStyleSync(); };
  $('#edStil').addEventListener('change', crStyleSync);
  $('#edVars').onclick = e => { const ch = e.target.closest('[data-ch]'); if(ch){ crChoose(+ch.dataset.ch); return; } const im = e.target.closest('[data-cv]'); if(im) crView(+im.dataset.cv); };
  $('#edViewChosen').onclick = () => { if(ed && ed.cr && ed.cr.chosen >= 0) crView(ed.cr.chosen); };
  $('#edMore').onclick = crMore;
  $('#edAdjChips').innerHTML = adjChipsHTML(true);   // 9.86: corpul separat de restul
  $('#edAdjChips').onclick = e => { const b = e.target.closest('[data-adj]'); if(!b) return; const t = $('#edAdjTxt'); t.value = t.value.trim() ? t.value.trim() + ', ' + b.dataset.adj : b.dataset.adj; t.focus(); };
  $('#edAdjGo').onclick = crAdjust;
  $('#edOwnRead').onclick = () => crReadPhoto(false); $('#edOwnAdj').onclick = ownAdjust;   // 9.34

  $('#edFullView').onclick = () => { if(ed && ed.id) viewFull(charById(ed.id)); };
  $('#edPromptEn').addEventListener('input', () => { if(!ed || !ed.cr) return; ed.cr.manual = !!$('#edPromptEn').value.trim(); ed.cr.enFor = crKey(); });   // 9.26: îl poți scrie tu
  $('#edNameGen').onclick = runNames;
  $('#edSurprise').onclick = surpriseSheet;
  $('#edName').addEventListener('input', () => { $('#edTitle').textContent = $('#edName').value.trim() || 'Personaj nou'; $$('#edNames button').forEach(b => b.classList.toggle('on', b.textContent === $('#edName').value.trim())); });
  $('#edSave').onclick = saveEditor;
  $('#edDuo').onchange = () => { $('#edDuoBox').hidden = !$('#edDuo').checked; duoHintSync(); };   // 9.63
  $('#edDuoSplit').onclick = duoSplitDesc; $('#edDuoGo').onclick = () => { $('#edDuo').checked = true; $('#edDuoBox').hidden = false; duoHintSync(); duoSplitDesc(); };
  ['#edPersona', '#edAspect', '#edPrompt'].forEach(q => $(q) && $(q).addEventListener('input', duoHintSync));
  $('#edDel').onclick = () => deleteChar();
  $('#edAcc').addEventListener('click', e => { const b = e.target.closest('[data-a]'); if(!b) return; ed.accent = b.dataset.a; drawLook(); });
  $$('#edBg button').forEach(b => b.onclick = () => { ed.bg = b.dataset.v; drawLook(); });
  $('#sceneBar').onclick = editScene;
  $('#stCostReset').onclick = () => confirmSheet('Resetezi contorul de consum?', 'Resetează', async () => { await DB.del('usage'); renderCost(); });
  // setări: salvare automată la orice schimbare
  for(const [id, k] of Object.entries(FIELDS)) $('#' + id).addEventListener('change', e => { S[k] = e.target.value.trim(); for(const [id2, k2] of Object.entries(FIELDS)) if(k2 === k && id2 !== id) $('#' + id2).value = S[k]; saveSettings(); if(k === 'wkBase' || k === 'wkTok' || k === 'wkModel' || k === 'wkSize') loadNeurons(); if(k === 'wkBase' || k === 'oaBase'){ S.vaultHas = null; saveSettings(); cspSync(false); } if(k === 'wkTok' && S.pushOn) pushCfgToSW().catch(() => {}); drawWkEst(); renderSetSummary(); });
  for(const [id, k] of Object.entries(SEGS)) $$('#' + id + ' button').forEach(b => b.onclick = () => {
    let v = k === 'font' ? +b.dataset.v : b.dataset.v;
    if(k === 'bestOf' && sceneModel() !== 'eco'){ S.bestOf9 = v; saveSettings(); syncSegs(); return; }   // 9.1: pe 9B variantele se țin separat
    // 9.18: pe Runware o variantă costă ~1/5 dintr-o poză 9B Cloudflare, așa că 3 variante (fața cea mai apropiată câștigă) sunt tot mai ieftine
    if(k === 'rw' && v !== S.rw){ if(v === 'on' && (S.bestOf9 || '1') === '1') S.bestOf9 = '3'; if(v === 'off' && S.bestOf9 === '3') S.bestOf9 = '1'; }
    S[k] = v; saveSettings(); syncSegs();
    if(k === 'imgProv' || k === 'cfPlan') loadNeurons();
    if(k === 'cfPlan') drawWkEst();
  });
  $('#stTest').onclick = () => { for(const [id, k] of Object.entries(FIELDS)) S[k] = $('#' + id).value.trim(); saveSettings(); testAI(); };
  $('#stVkCheck').onclick = () => { S.wkBase = $('#stVkBase').value.trim(); S.wkTok = $('#stVkTok').value.trim(); saveSettings(); vaultCheck(); };
  $('#stVkGen').onclick = vaultNewToken;
  $('#stVkWipe').onclick = () => confirmSheet('Ștergi cheile din telefon? Seiful le are deja; aplicația va merge doar prin Worker.', 'Șterge', () => {
    for(const k of ['key', 'rwKey']) S[k] = '';
    for(const [id, k] of Object.entries(FIELDS)) if(['key', 'rwKey'].includes(k)) $('#' + id).value = '';
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
  { const rt = $('#stRefTest'); if(rt) rt.onclick = refTest; }   // 9.84: comparația eco / 9B a ieșit din Setări
  $('#stRwTest').onclick = rwTest;
  $('#stImport').onclick = () => $('#stImpFile').click();
  $('#stImpFile').onchange = e => { if(e.target.files[0]) importAll(e.target.files[0]); e.target.value = ''; };
  $('#stWipe').onclick = () => confirmSheet('Ștergi TOATE personajele, conversațiile și setările?', 'Șterge tot', async () => { await DB.clear(); location.reload(); });
}

/* ───────── pornire ───────── */
// 9.19: furnizorii rămași sunt Anthropic (text), Cloudflare (Worker) și Runware (9B). Setările vechi (alt furnizor de text,
//       fal.ai, Gemini, ElevenLabs) se mută pe echivalentul rămas, iar cheile lor se șterg din telefon.
function onlyOurProviders(){
  let ch = false;
  const set = (k, v) => { if(S[k] !== v){ S[k] = v; ch = true; } };
  set('prov', 'anthropic');
  if(!['none', 'worker'].includes(S.imgProv)) set('imgProv', String(S.wkBase || '').trim() ? 'worker' : 'none');
  if(S.wkChat === 'fal') set('wkChat', 'ancorat');
  set('tts', 'tel');
  for(const k of ['oaBase', 'oaKey', 'oaModel', 'gemKey', 'gemModel', 'falKey', 'falModel', 'falSize', 'elKey', 'elModel', 'imgAlt', 'imgCost']) if(k in S){ delete S[k]; ch = true; }
  if(S.vaultHas) for(const k of ['fal', 'eleven', 'gemini']) if(k in S.vaultHas){ delete S.vaultHas[k]; ch = true; }
  if(ch) saveSettings();
}
// 8.20: Content-Security-Policy. Pagina poate vorbi doar cu serviciile cunoscute + adresele tale (Worker, furnizor OpenAI).
// Lista de adrese proprii stă în localStorage (o citește scriptul din <head> înainte de orice altceva).
function cspOrigins(){
  const o = [];
  for(const u of [S.wkBase && wkUrl()]) if(u){ try{ const x = new URL(u); if(x.protocol === 'https:') o.push(x.origin); }catch(e){} }
  return [...new Set(o)].sort();
}
function cspSync(boot){
  const want = JSON.stringify(cspOrigins());
  let have = null; try{ have = localStorage.getItem('taifas-csp'); }catch(e){ return false; }
  if(have === want) return false;
  try{ localStorage.setItem('taifas-csp', want); }catch(e){ return false; }
  if(have === null && want === '[]') return false;   // 9.64: prima pornire fără adrese: politica e deja aceeași (index.html citește lipsa ca []), nu repornim degeaba
  if(boot){ location.reload(); return true; }
  toast('Adresă nouă salvată. Repornesc aplicația…', 1500);
  setTimeout(() => { location.href = location.pathname + '?go=set'; }, 900);
  return true;
}
async function init(){
  try{ await DB.open(); }catch(e){ document.body.innerHTML = '<p class="empty">Browserul nu permite stocarea locală (IndexedDB). Ieși din modul privat.</p>'; return; }
  await imetaLoad();   // 9.13: dimensiunile pozelor și miniaturile
  setTimeout(() => { for(const c of chars) for(const k of [c.photo, ...Object.values(c.avs || {})]) thumbsFor(k); }, 4000);   // 9.15: miniaturile pozelor de profil, din timp
  const saved = await DB.get('settings');
  S = {...DEF, ...(saved || {})};
  if(S.smart === 'on') S.smart = 'echilibrat';   // 9.60: modelul inteligent devine amestecul reglabil
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
  // 9.37: cine are Runware pornit trece pe „Totul pe Runware”, fără rezervă Cloudflare (o dată; se poate schimba din Setări → Poze)
  if((S.sv || 0) < 41){ if(S.rw === 'on'){ S.imgRoute = 'rw'; S.cfFallback = 'off'; } S.sv = 41; saveSettings(); }
  // 9.39: activează potrivirea corporală condiționată; rulează doar când verificarea detectează o diferență.
  if((S.sv || 0) < 42){ S.bodyFix = 'on'; S.sv = 42; saveSettings(); }
  // 9.42: pozele din chat trec pe motorul „ca în creator” (o dată; motorul vechi se poate alege din Setări → Poze)
  if((S.sv || 0) < 43){ S.photoEngine = 'creator'; S.sv = 43; saveSettings(); }
  if((S.sv || 0) < 44){ if(S.cacheTtl === 'auto') S.cacheTtl = '1h'; S.sv = 44; saveSettings(); }
  // 9.70: pe Android, ascultarea pornită cât vorbește ea (întreruperi vocale, „îhî”) îi tăia vocea (focus audio / căști Bluetooth în mod apel); o dată, le oprim
  if((S.sv || 0) < 45){ if(IS_ANDROID){ S.callBarge = 'off'; S.callBack = 'off'; } S.sv = 45; saveSettings(); }
  // 9.84: setările de creare și poze rămân doar cele care dau fidelitatea maximă (celelalte nu mai apar în Setări)
  if((S.sv || 0) < 46){ Object.assign(S, FIDEL_FIX); S.sv = 46; saveSettings(); }   // 9.51: cache-ul de 5 min a dus la rescrieri complete după pauze de 5-60 min (mai scump decât economia)
  onlyOurProviders();   // 9.19: la fiecare pornire (și după o restaurare dintr-un backup vechi)
  if(cspSync(true)) return;   // 8.20: adresă nouă → repornim o dată, ca politica de securitate să o permită
  chars = (await DB.get('chars') || []).filter(c => c && c.id && c.name);
  groups = (await DB.get('groups') || []).filter(g => g && g.id && Array.isArray(g.members));   // 9.44
  { let ch9 = false; for(const c of chars) if(!c.physUser && !c.physEn && (c.appZones || c.appEn) && crApplyPhys(c)) ch9 = true; if(ch9) saveChars(); }   // 9.30: personajele create în 9.24–9.29
  setTimeout(async () => { let ch2 = false; for(const c of chars) if(c.physAuto && c.physRoV !== 2 && crRoThin(c.physUser) && (c.appPrompt || c.appEn) && await crPhysRo(c)) ch2 = true; if(ch2) saveChars(); }, 4000);   // 9.32: româna subțire („corp: …”) se completează o dată
  if((S.sv || 0) < 34){
    if(S.wkModel === 'ancorat') S.wkModel = 'eco';
    if(['480x640', '576x768'].includes(S.wkSize)) S.wkSize = '768x1024';
    if((S.sv || 0) >= 30){ S.sv = 34; saveSettings(); }
  }
  if((S.sv || 0) < 30){ chars.forEach(c => { if(!c.bg || c.bg === 'poza') c.bg = 'clar'; }); await saveChars(); S.sv = 34; saveSettings(); }
  await loadFeed();
  await fixHaikuUsage();
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
  // 9.47: grupurile trăiesc și când nu le deschizi
  setTimeout(gLifeSweep, 15e3); setInterval(gLifeSweep, 30 * 60e3);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) setTimeout(gLifeSweep, 5000); });
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
