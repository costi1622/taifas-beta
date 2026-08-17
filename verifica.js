#!/usr/bin/env node
/* Taifas — verificator dinaintea fiecărui upload.
   Rulează:  node verifica.js
   Verifică ce s-a stricat de fapt în practică, nu ce sună bine în teorie. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const P = f => path.join(DIR, f);
let erori = 0, atentionari = 0;

const rosu = s => '\x1b[31m' + s + '\x1b[0m';
const verde = s => '\x1b[32m' + s + '\x1b[0m';
const galben = s => '\x1b[33m' + s + '\x1b[0m';

function ok(m) { console.log('  ' + verde('✓') + ' ' + m); }
function rau(m) { console.log('  ' + rosu('✗') + ' ' + m); erori++; }
function atentie(m) { console.log('  ' + galben('!') + ' ' + m); atentionari++; }
function titlu(t) { console.log('\n' + t); }

/* ---------- 0. fișierele există ---------- */
titlu('Fișiere');
const NECESARE = ['index.html', 'sw.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'icon-180.png'];
NECESARE.forEach(f => {
  if (fs.existsSync(P(f))) ok(f);
  else rau(f + ' LIPSEȘTE');
});
if (erori) { console.log(rosu('\nOpresc: lipsesc fișiere.')); process.exit(1); }

const html = fs.readFileSync(P('index.html'), 'utf8');
const sw = fs.readFileSync(P('sw.js'), 'utf8');
// varianta fara comentarii, pentru verificarile care privesc codul real
const faraComentarii = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const swCod = faraComentarii(sw);

/* ---------- 1. sintaxă ---------- */
titlu('Sintaxă');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = scripts[scripts.length - 1] || '';
try { new vm.Script(js); ok('index.html — scriptul principal'); }
catch (e) { rau('index.html — ' + e.message); }
try { new vm.Script(sw); ok('sw.js'); }
catch (e) { rau('sw.js — ' + e.message); }
try { JSON.parse(fs.readFileSync(P('manifest.webmanifest'), 'utf8')); ok('manifest.webmanifest — JSON valid'); }
catch (e) { rau('manifest — ' + e.message); }

/* ---------- 2. versiuni coerente ---------- */
titlu('Versiuni');
const ver = (html.match(/const APP_VER='([^']+)'/) || [])[1];
const cache = (sw.match(/const CACHE = '([^']+)'/) || [])[1];
if (!ver) rau('APP_VER lipsește din index.html');
else ok('APP_VER = ' + ver);
if (!cache) rau('CACHE lipsește din sw.js');
else ok('cache service worker = ' + cache);

/* NOUTATI trebuie să conțină versiunea curentă, altfel actualizarea trece în tăcere */
if (ver) {
  const noutati = (js.match(/const NOUTATI=\[([\s\S]*?)\n\];/) || [])[1] || '';
  if (noutati.includes("v:'" + ver + "'")) ok('NOUTATI are o intrare pentru ' + ver);
  else rau('NOUTATI NU are intrare pentru ' + ver + ' — actualizarea ar trece nevăzută');
}

/* cache-ul trebuie incrementat față de git, dar măcar verificăm formatul */
if (cache && !/^taifas-v\d+$/.test(cache)) atentie('cache-ul nu are forma taifas-vN: ' + cache);

/* ---------- 3. fiecare onclick are funcția lui ---------- */
titlu('Legături HTML → JS');
const definite = new Set();
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) definite.add(m[1]);
for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g)) definite.add(m[1]);
const NATIVE = new Set(['this', 'event', 'location', 'alert', 'confirm', 'focus', 'getElementById',
  'preventDefault', 'reload', 'stopPropagation', 'toggle', 'add', 'remove', 'if', 'setProperty',
  'trim', 'querySelector', 'scrollIntoView', 'classList', 'parseInt', 'parseFloat', 'String', 'Number']);
const chemate = new Set();
for (const m of html.matchAll(/on(?:click|input|change|keydown|load|error|scroll|submit)="([^"]+)"/g)) {
  // scoatem interpolarile ${...}: acolo e JS din sabloane, nu apeluri din HTML
  const cod = m[1].replace(/\$\{[^}]*\}/g, '');
  for (const c of cod.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) chemate.add(c[1]);
}
const lipsa = [...chemate].filter(c => !definite.has(c) && !NATIVE.has(c));
if (lipsa.length) rau('funcții chemate din HTML dar nedefinite: ' + lipsa.join(', '));
else ok(chemate.size + ' funcții chemate din HTML, toate definite');

/* ---------- 4. fiecare id folosit în JS există în HTML ---------- */
titlu('Identificatori');
const idsHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const DINAMICE = new Set(['live', 'moodOut', 'pingOut', 'editBox', 'thName', 'pText', 'pGreet', 'scIn', 'homeSearch']);
const idsJs = new Set([...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
const idLipsa = [...idsJs].filter(i => !idsHtml.has(i) && !DINAMICE.has(i));
if (idLipsa.length) rau('getElementById pe id-uri inexistente: ' + idLipsa.join(', '));
else ok(idsJs.size + ' id-uri citite din JS, toate există');

/* referințe scurte de tip stFoo.value / edFoo.value */
const IGNORA = new Set(['edMemory', 'edColor', 'edSeed', 'edAvatarUrl', 'edMoods', 'edDirty']);
const scurte = new Set([...js.matchAll(/\b(st[A-Z]\w+|ed[A-Z]\w+|sec[A-Z]\w+)\b\./g)].map(m => m[1]));
const scurteLipsa = [...scurte].filter(i => !idsHtml.has(i) && !IGNORA.has(i));
if (scurteLipsa.length) rau('referințe scurte fără element: ' + scurteLipsa.join(', '));
else ok(scurte.size + ' referințe scurte, toate au element');

/* ---------- 5. funcții definite de două ori (a doua o suprascrie pe prima) ---------- */
titlu('Dubluri');
const nr = {};
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) nr[m[1]] = (nr[m[1]] || 0) + 1;
const dubluri = Object.entries(nr).filter(([, n]) => n > 1);
if (dubluri.length) rau('funcții definite de mai multe ori: ' + dubluri.map(([k, n]) => k + ' (×' + n + ')').join(', '));
else ok('nicio funcție definită de două ori');

/* ---------- 6. invariante care s-au stricat deja o dată ---------- */
titlu('Invariante');
const cerinte = [
  ['manifestul NU are câmpul orientation', !fs.readFileSync(P('manifest.webmanifest'), 'utf8').includes('"orientation"')],
  ['service worker-ul NU folosește cache.addAll', !swCod.includes('addAll')],
  ['service worker-ul nu interceptează manifestul', swCod.includes('.webmanifest')],
  ['service worker-ul ascultă SKIP_WAITING', swCod.includes('SKIP_WAITING')],
  ['cheile API nu intră în backup', js.includes('delete set.key') && js.includes('delete set.imgApiKey')],
  ['CSP permite api.anthropic.com', html.includes('https://api.anthropic.com')],
  ['CSP permite Pollinations', html.includes('image.pollinations.ai')],
  ['imaginile de scenă au seed derivat din scenă', js.includes('sceneSeed(')],
  ['restaurarea păstrează o copie pentru anulare', js.includes('taifas_prev')],
  ['golirea conversației păstrează personajul', js.includes('taifas_convo_prev')],
  ['meniul mesajului e pe apăsare lungă', js.includes('bindLongPress')],
  ['setările se salvează singure', js.includes('bindAutoSave')],
];
cerinte.forEach(([nume, cond]) => cond ? ok(nume) : rau(nume + ' — NU'));

/* ---------- 7. tipurile de mesaj sunt tratate peste tot ---------- */
titlu('Acoperire');
['renderMsgs', 'buildTurns', 'exportConvo', 'estimateConvo'].forEach(f => {
  if (js.includes('function ' + f) || js.includes('function ' + f + '(')) ok(f + ' există');
  else rau(f + ' lipsește');
});
if (js.includes("m.role==='user'") ) ok('mesajele utilizatorului sunt distinse explicit');

/* ---------- 8. dimensiuni ---------- */
titlu('Dimensiuni');
const kb = n => (n / 1024).toFixed(1) + ' KB';
ok('index.html ' + kb(html.length));
if (html.length > 400 * 1024) atentie('index.html trece de 400 KB — ia în calcul împărțirea');

/* ---------- rezultat ---------- */
console.log('');
if (erori) {
  console.log(rosu('✗ ' + erori + ' probleme') + (atentionari ? galben(' · ' + atentionari + ' atenționări') : ''));
  process.exit(1);
}
console.log(verde('✓ Totul e în regulă') + (atentionari ? galben(' · ' + atentionari + ' atenționări') : ''));
