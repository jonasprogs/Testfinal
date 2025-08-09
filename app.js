async function sha256(t){return t}
// Minimal local-first expense tracker with IndexedDB, quick parser, monthly budgets, and passcode lock.

const DB_NAME = 'expense_mvp_db';
const DB_VER = 1;
let db;

// IndexedDB helpers
function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e)=>{
      const db = req.result;
      if(!db.objectStoreNames.contains('expenses')){
        const s = db.createObjectStore('expenses', {keyPath:'id'});
        s.createIndex('date','date');
        s.createIndex('category','category');
      }
      if(!db.objectStoreNames.contains('meta')){
        db.createObjectStore('meta', {keyPath:'key'});
      }
      if(!db.objectStoreNames.contains('categories')){
        const c = db.createObjectStore('categories',{keyPath:'id'});
        c.createIndex('name','name',{unique:true});
      }
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
function tx(store, mode='readonly'){
  const t = db.transaction(store, mode);
  return t.objectStore(store);
}
function getAll(store){
  return new Promise((resolve, reject)=>{
    const s = tx(store);
    const req = s.getAll();
    req.onsuccess = ()=> resolve(req.result || []);
    req.onerror = ()=> reject(req.error);
  });
}
function put(store, value){
  return new Promise((resolve, reject)=>{
    const s = tx(store, 'readwrite');
    const req = s.put(value);
    req.onsuccess = ()=> resolve(value);
    req.onerror = ()=> reject(req.error);
  });
}
function del(store, key){
  return new Promise((resolve, reject)=>{
    const s = tx(store, 'readwrite');
    const req = s.delete(key);
    req.onsuccess = ()=> resolve();
    req.onerror = ()=> reject(req.error);
  });
}
function get(store, key){
  return new Promise((resolve, reject)=>{
    const s = tx(store);
    const req = s.get(key);
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
// meta helpers
function getMeta(key){ return get('meta', key); }
function setMeta(key, value){ return put('meta', {key, value}); }
function delMeta(key){ return del('meta', key); }

async function ensureDefaults(){

  // default category Lebensmittel
  const cats = await getAll('categories');
  if(!cats.find(c=>c.name.toLowerCase()==='lebensmittel')){
    await put('categories', {id: crypto.randomUUID(), name:'Lebensmittel', monthlyBudgetCents:null});
  }
}

// Utilities
const deLocale = 'de-DE';
function cents(n){ return Math.round(n); }
function parseAmountToCents(raw){
  if(!raw) return null;
  let t = (''+raw).trim();
  t = t.replace(/[€\s]/g,'');
  // convert comma to dot for parseFloat
  t = t.replace(',', '.');
  let v = Number.parseFloat(t);
  if(Number.isNaN(v)) return null;
  return cents(v*100);
}
function formatCents(c){
  const s = (c/100).toLocaleString(deLocale, {style:'currency', currency:'EUR'});
  return s;
}
function todayISO(){
  const d = new Date(); d.setHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function dateToISO(d){
  if(typeof d === 'string'){
    // try parse dd.mm.yyyy
    const m = d.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if(m){
      const dd = String(m[1]).padStart(2,'0');
      const mm = String(m[2]).padStart(2,'0');
      return `${m[3]}-${mm}-${dd}`;
    }
    // yyyy-mm-dd
    if(/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  }
  const x = new Date(d);
  x.setHours(0,0,0,0);
  return x.toISOString().slice(0,10);
}
function isoToDisplay(iso){
  const [y,m,d]=iso.split('-');
  return `${d}.${m}.${y}`;
}
function startOfWeekISO(date){
  const d = new Date(date);
  const day = (d.getDay()+6)%7; // monday=0
  d.setDate(d.getDate()-day);
  d.setHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function endOfWeekISO(date){
  const d = new Date(startOfWeekISO(date));
  d.setDate(d.getDate()+6);
  return d.toISOString().slice(0,10);
}
function endOfMonthISO(date){
  const d = new Date(date);
  d.setMonth(d.getMonth()+1, 0);
  d.setHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function daysLeftInMonth(dateISO){
  const end = new Date(endOfMonthISO(dateISO));
  const cur = new Date(dateISO);
  const diff = Math.round((end - cur)/(1000*60*60*24)) + 1; // incl today
  return diff;
}
function normalizeCategory(name){
  if(!name) return null;
  return name.trim().toLowerCase();
}


// Quick parser: amount, category, date keywords, name (rest)
const DATE_WORDS = ['heute','gestern','vorgestern','mo','di','mi','do','fr','sa','so','montag','dienstag','mittwoch','donnerstag','freitag','samstag','sonntag'];
function parseQuick(input){
  let text = (input||'').trim();
  if(!text) return null;
  // amount
  const amountRe = /(\d+[.,]?\d{0,2})\s*€?/i;
  const am = text.match(amountRe);
  let amountCents = null;
  if(am){
    amountCents = parseAmountToCents(am[1]);
    text = (text.slice(0, am.index) + ' ' + text.slice(am.index + am[0].length)).trim();
  }
  // explicit date dd.mm.yyyy
  let dateISO = null;
  const dateDMY = text.match(/(\b\d{1,2}\.\d{1,2}\.\d{4}\b)/);
  if(dateDMY){
    dateISO = dateToISO(dateDMY[1]);
    text = text.replace(dateDMY[1],'').trim();
  }
  // keywords
  if(!dateISO){
    const tokens = text.split(/\s+/);
    let keep = [];
    for(const tok of tokens){
      const t = tok.toLowerCase();
      if(DATE_WORDS.includes(t)){
        // map to date
        const d = new Date();
        d.setHours(0,0,0,0);
        if(['gestern'].includes(t)) d.setDate(d.getDate()-1);
        else if(['vorgestern'].includes(t)) d.setDate(d.getDate()-2);
        else if(['heute'].includes(t)){} // today
        else {
          // weekday: go back to most recent that day (Mon=1..Sun=7)
          const map = {
            'mo':1,'montag':1,'di':2,'dienstag':2,'mi':3,'mittwoch':3,'do':4,'donnerstag':4,'fr':5,'freitag':5,'sa':6,'samstag':6,'so':0,'sonntag':0
          };
          const target = map[t];
          const cur = d.getDay(); // Sun=0..Sat=6
          let diff = (cur - target);
          if(diff<=0) diff += 7;
          d.setDate(d.getDate()-diff);
        }
        dateISO = d.toISOString().slice(0,10);
      } else {
        keep.push(tok);
      }
    }
    text = keep.join(' ').trim();
  }
  if(!dateISO) dateISO = todayISO();
  // category: use last token that matches existing category else literal "lebensmittel" if present
  // Simple: if includes 'lebensmittel' => that category, else if single word equals existing cat => that.
  let category = null;
  if(/\blebensmittel\b/i.test(text)){
    category = 'lebensmittel';
    text = text.replace(/\blebensmittel\b/ig,'').trim();
  }
  const name = text.trim() || '(ohne Titel)';
  return {amountCents, dateISO, category, name};
}

async function ensureCategory(name){
  if(!name) return null;
  name = normalizeCategory(name);
  const all = await getAll('categories');
  let found = all.find(c=>c.name.toLowerCase()===name);
  if(found) return found.id;
  // auto-add new category without budget
  const id = crypto.randomUUID();
  await put('categories', {id, name, monthlyBudgetCents:null});
  return id;
}

async function addExpense(obj){
  const id = crypto.randomUUID();
  const rec = {
    id,
    name: (obj.name||'(ohne Titel)').trim(),
    amountCents: cents(obj.amountCents ?? 0),
    date: obj.dateISO || todayISO(),
    category: obj.categoryId || null,
    note: (obj.note||'').trim()
  };
  await put('expenses', rec);
  return rec;
}

function inRange(iso, range){
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  if(range==='today') return d.getTime()===today.getTime();
  if(range==='week'){
    const s = new Date(startOfWeekISO(todayISO()));
    const e = new Date(endOfWeekISO(todayISO()));
    return d>=s && d<=e;
  }
  if(range==='month'){
    const t = todayISO();
    return iso.slice(0,7)===t.slice(0,7);
  }
  return true;
}
function sumCents(list){ return list.reduce((a,b)=>a+(b.amountCents||0),0); }

  const all = await getAll('expenses');
  const curISO = todayISO();
  const curMonth = curISO.slice(0,7);
  const spent = all.filter(e=> e.category===food.id && e.date.slice(0,7)===curMonth);
  let used = sumCents(spent);
  const ov = await getMeta('food_spent_override_'+curMonth);
  if(ov && typeof ov.value === 'number'){ used = ov.value; }
  const d = new Date(curISO);
  const dayOfMonth = d.getDate();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
  const targetSoFar = (budget / daysInMonth) * dayOfMonth;
  const allowToday = targetSoFar - used;
  const cls = allowToday >= 0 ? 'ok' : 'danger';
  const allowedTxt = formatCents(allowToday);
  return {
    text: `${allowedTxt} heute verfügbar nach Plan · (Budget/Monatstage × Tag) − Ausgegeben`,
    cls
  };
};
  const budget = food.monthlyBudgetCents;
  if(!budget){ return {text:'Kein Monatsbudget gesetzt.', cls:'warn'}; }
  const all = await getAll('expenses');
  const curMonth = todayISO().slice(0,7);
  const spent = all.filter(e=> e.category===food.id && e.date.slice(0,7)===curMonth);
  let used = sumCents(spent);
  const ov = await getMeta('food_spent_override_'+curMonth);
  if(ov && typeof ov.value === 'number'){ used = ov.value; }
  const left = Math.max(0, budget - used);
  const daysLeft = daysLeftInMonth(todayISO());
  const perDay = left / daysLeft;
  const cls = left>0 ? 'ok' : 'danger';
  return {
    text: `${formatCents(left)} übrig im Monat · Ø ${formatCents(perDay)} pro Tag (${daysLeft} Tage übrig)`,
    cls
  };
}


async function calcDailyRemaining(){
  const cats = await getAll('categories');
  const food = cats.find(c=>c.name.toLowerCase()==='lebensmittel');
  if(!food) return {text:'Keine Kategorie „Lebensmittel“ gefunden.', cls:'muted'};
  const budget = food.monthlyBudgetCents;
  if(!budget){ return {text:'Kein Monatsbudget gesetzt.', cls:'warn'}; }
  const all = await getAll('expenses');
  const curISO = todayISO();
  const curMonth = curISO.slice(0,7);
  const spent = all.filter(e=> e.category===food.id && e.date.slice(0,7)===curMonth);
  let used = sumCents(spent);
  const ov = await getMeta('food_spent_override_'+curMonth);
  if(ov && typeof ov.value === 'number'){ used = ov.value; }
  const d = new Date(curISO);
  const dayOfMonth = d.getDate();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
  const targetSoFar = (budget / daysInMonth) * dayOfMonth;
  const allowToday = targetSoFar - used;
  const cls = allowToday >= 0 ? 'ok' : 'danger';
  return {
    text: `${(allowToday/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'})} heute verfügbar nach Plan · (Budget/Monatstage × Tag) − Ausgegeben`,
    cls
  };
}

// Rendering
const listEl = document.getElementById('list');
const searchEl = document.getElementById('search');
const rangeBtns = document.querySelectorAll('.tabs .pill');
let currentRange = 'month';
rangeBtns.forEach(b=>{
  b.addEventListener('click', ()=>{
    currentRange = b.dataset.range;
    renderList();
  });
});

async function renderList(){
  const q = (searchEl.value||'').toLowerCase();
  const items = await getAll('expenses');
  items.sort((a,b)=> b.date.localeCompare(a.date));
  const filtered = items.filter(e=>{
    if(!inRange(e.date, currentRange)) return false;
    const hay = `${(e.name||'').toLowerCase()} ${(e.note||'').toLowerCase()} ${e.category||''}`;
    return hay.includes(q);
  });
  listEl.innerHTML='';
  const tpl = document.getElementById('expense-template');
  for(const e of filtered){
    const node = tpl.content.cloneNode(true);
    node.querySelector('.name').textContent = e.name;
    node.querySelector('.amount').textContent = formatCents(e.amountCents);
    node.querySelector('.date').textContent = isoToDisplay(e.date);
    // category name
    const cats = await getAll('categories');
    const cat = cats.find(c=>c.id===e.category);
    node.querySelector('.cat').textContent = cat ? cat.name : '–';
    node.querySelector('.note').textContent = e.note ? `• ${e.note}` : '';
    node.querySelector('.del').addEventListener('click', async ()=>{
      if(confirm('Löschen?')){
        await del('expenses', e.id);
        renderAll();
      }
    });
    node.querySelector('.edit').addEventListener('click', ()=> openExpenseDialog(e));
    listEl.appendChild(node);
  }
}

async function renderCats(){
  const cats = await getAll('categories');
  const el = document.getElementById('cats');
  el.innerHTML='';
  for(const c of cats){
    const div = document.createElement('div');
    div.className='item';
    const budgetTxt = c.monthlyBudgetCents!=null ? formatCents(c.monthlyBudgetCents) : '–';
    div.innerHTML = `<div><strong>${c.name}</strong><div class="meta"><span>Monatsbudget: ${budgetTxt}</span></div></div>
      <div class="right">
        <button class="pill edit">Bearb.</button>
        <button class="pill btn-danger del">Löschen</button>
      </div>`;
    div.querySelector('.edit').addEventListener('click', async ()=>{
      const val = prompt('Monatsbudget (leer = kein Budget)', c.monthlyBudgetCents!=null ? (c.monthlyBudgetCents/100).toString().replace('.',',') : '');
      if(val===null) return;
      if(val.trim()===''){ c.monthlyBudgetCents=null; await put('categories',c); renderAll(); return; }
      const centsVal = parseAmountToCents(val);
      if(centsVal==null){ alert('Ungültiger Betrag'); return; }
      c.monthlyBudgetCents = centsVal; await put('categories', c); renderAll();
    });
    div.querySelector('.del').addEventListener('click', async ()=>{
      if(!confirm('Kategorie löschen? (Ausgaben behalten ihre alte Category-ID)')) return;
      await del('categories', c.id); renderAll();
    });
    el.appendChild(div);
  }
}

async function renderDaily(){
  const r = await calcDailyRemaining();
  const el = document.getElementById('dailyInfo');
  el.className = r.cls || 'muted';
  el.textContent = r.text;
}

// Dialogs
const expenseDialog = document.getElementById('expenseDialog');
const dlgTitle = document.getElementById('dlgTitle');
const dlgName = document.getElementById('dlgName');
const dlgAmount = document.getElementById('dlgAmount');
const dlgDate = document.getElementById('dlgDate');
const dlgCategory = document.getElementById('dlgCategory');
const dlgNote = document.getElementById('dlgNote');
const dlgSave = document.getElementById('dlgSave');
const dlgCancel = document.getElementById('dlgCancel');

let editing = null;
function openExpenseDialog(e=null){
  editing = e;
  dlgTitle.textContent = e ? 'Ausgabe bearbeiten' : 'Neue Ausgabe';
  dlgName.value = e?.name || '';
  dlgAmount.value = e ? (e.amountCents/100).toString().replace('.',',') : '';
  dlgDate.value = e?.date || todayISO();
  dlgCategory.value = '';
  if(e){
    // lookup category name
    getAll('categories').then(cats=>{
      const c = cats.find(x=>x.id===e.category);
      dlgCategory.value = c ? c.name : '';
    });
  } else {
    dlgCategory.value = 'lebensmittel';
  }
  dlgNote.value = e?.note || '';
  expenseDialog.showModal();
}
dlgCancel.addEventListener('click', ()=> expenseDialog.close());
dlgSave.addEventListener('click', async ()=>{
  const amount = parseAmountToCents(dlgAmount.value);
  if(amount==null){ alert('Bitte gültigen Betrag eingeben.'); return; }
  let catId = await ensureCategory(dlgCategory.value || 'lebensmittel');
  const rec = {
    id: editing?.id || crypto.randomUUID(),
    name: dlgName.value || '(ohne Titel)',
    amountCents: amount,
    date: dlgDate.value || todayISO(),
    category: catId,
    note: dlgNote.value || ''
  };
  await put('expenses', rec);
  expenseDialog.close();
  renderAll();
});

// Quick add
document.getElementById('parseBtn').addEventListener('click', async ()=>{
  const raw = document.getElementById('quick').value;
  const p = parseQuick(raw);
  if(!p){ alert('Bitte Text eingeben.'); return; }
  if(p.amountCents==null){ alert('Betrag nicht erkannt.'); return; }
  const catId = await ensureCategory((p.category && p.category.toLowerCase()==='lebensmittel') ? 'lebensmittel' : 'lebensmittel');
  await addExpense({name:p.name, amountCents:p.amountCents, dateISO:p.dateISO, categoryId:catId});
  document.getElementById('quick').value='';
  renderAll();
});
document.getElementById('addManualBtn').addEventListener('click', ()=> openExpenseDialog(null));

// Import/Export
const fileInput = document.getElementById('fileInput');
document.getElementById('importBtn').addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const text = await file.text();
  const isTSV = file.name.toLowerCase().endsWith('.tsv') || text.split('\n')[0].split('\t').length>1;
  const delim = isTSV ? '\t' : ',';
  const rows = text.split(/\r?\n/).filter(x=>x.trim().length>0).map(r=> r.split(delim));
  if(rows.length===0) return;
  const headers = rows[0].map(h=> h.trim().toLowerCase());
  const idx = (name)=> headers.findIndex(h=> h===name);
  const iName = idx('name'); const iAmount = idx('amount'); const iDate = idx('date'); const iCat = idx('category'); const iNote = idx('note');
  if(iName<0 || iAmount<0 || iDate<0){ alert('Headers benötigt: name, amount, date (optional: category, note)'); return; }
  for(let r=1; r<rows.length; r++){
    const row = rows[r];
    const name = row[iName]?.trim() || '(ohne Titel)';
    const amountCents = parseAmountToCents(row[iAmount]);
    const dateISO = dateToISO((row[iDate]||'').trim());
    const catName = (iCat>=0 ? row[iCat] : 'lebensmittel') || 'lebensmittel';
    const note = (iNote>=0 ? row[iNote] : '') || '';
    const catId = await ensureCategory(catName);
    if(amountCents!=null){
      await addExpense({name, amountCents, dateISO, categoryId:catId, note});
    }
  }
  renderAll();
  fileInput.value='';
});
document.getElementById('exportBtn').addEventListener('click', async ()=>{
  const items = await getAll('expenses');
  const cats = await getAll('categories');
  const map = Object.fromEntries(cats.map(c=>[c.id,c.name]));
  const rows = [['name','amount','date','category','note']];
  for(const e of items){
    rows.push([
      e.name,
      (e.amountCents/100).toString().replace('.',','),
      e.date,
      map[e.category] || '',
      e.note || ''
    ]);
  }
  const csv = rows.map(r=> r.map(v=> `"${(v??'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'expenses_export.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});

// Budget edit (Lebensmittel)
document.getElementById('editBudgetBtn').addEventListener('click', async ()=>{
  const dlg = document.getElementById('budgetDialog');
  const input = document.getElementById('budgetInput');
  const cats = await getAll('categories');
  const food = cats.find(c=>c.name.toLowerCase()==='lebensmittel');
  input.value = food?.monthlyBudgetCents!=null ? (food.monthlyBudgetCents/100).toString().replace('.',',') : '';
  dlg.showModal();
});
document.getElementById('budgetCancel').addEventListener('click', ()=> document.getElementById('budgetDialog').close());
document.getElementById('budgetSave').addEventListener('click', async ()=>{
  const val = document.getElementById('budgetInput').value;
  const centsVal = parseAmountToCents(val);
  if(centsVal==null){ alert('Bitte gültigen Betrag eingeben.'); return; }
  const cats = await getAll('categories');
  const food = cats.find(c=>c.name.toLowerCase()==='lebensmittel');
  if(!food){ alert('Kategorie Lebensmittel nicht vorhanden.'); return; }
  food.monthlyBudgetCents = centsVal;
  await put('categories', food);
  document.getElementById('budgetDialog').close();
  renderAll();
});

// Categories UI
document.getElementById('addCatBtn').addEventListener('click', async ()=>{
  const name = prompt('Neue Kategorie (Name)');
  if(!name) return;
  await ensureCategory(name);
  renderAll();
});

// Install prompt
let deferredPrompt=null;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault(); deferredPrompt = e; installBtn.style.display='inline-flex';
});
installBtn.addEventListener('click', async ()=>{
  if(deferredPrompt){ deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; }
});

// Initial boot
async function renderAll(){
  await renderList();
  await renderCats();
  await renderDaily();
}
(async function init(){
  db = await openDB();
  await ensureDefaults();
  await renderAll();
  
})();

// Bisher ausgegeben (Override) handlers
document.getElementById('setSpentBtn').addEventListener('click', async ()=>{
  const dlg = document.getElementById('spentDialog');
  const input = document.getElementById('spentInput');
  const curMonth = todayISO().slice(0,7);
  const ov = await getMeta('food_spent_override_'+curMonth);
  input.value = (ov && typeof ov.value === 'number') ? (ov.value/100).toString().replace('.',',') : '';
  dlg.showModal();
});
document.getElementById('spentCancel').addEventListener('click', ()=> document.getElementById('spentDialog').close());
document.getElementById('spentClear').addEventListener('click', async ()=>{
  const curMonth = todayISO().slice(0,7);
  await delMeta('food_spent_override_'+curMonth);
  document.getElementById('spentDialog').close();
  renderAll();
});
document.getElementById('spentSave').addEventListener('click', async ()=>{
  const val = document.getElementById('spentInput').value;
  const centsVal = parseAmountToCents(val);
  if(centsVal==null){ alert('Bitte gültigen Betrag eingeben.'); return; }
  const curMonth = todayISO().slice(0,7);
  await setMeta('food_spent_override_'+curMonth, centsVal);
  document.getElementById('spentDialog').close();
  renderAll();
});

