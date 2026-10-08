(function(){
"use strict";
const PEOPLE = ["Fifaliana","Fara","Fleure","Rajo","Nambinina"];
const COLORS = ["var(--p1)","var(--p2)","var(--p3)","var(--p4)","var(--p5)"];
const LS_KEY = "partage-elec-mois-v1";
const METHOD_LABEL = {nambinina:"attribué à Nambinina", prop:"au prorata", equal:"à parts égales", none:"non réparti"};

const fmtKwh = new Intl.NumberFormat("fr-FR",{maximumFractionDigits:2});
const fmtAr  = new Intl.NumberFormat("fr-FR",{maximumFractionDigits:0});
const fmtPrice = new Intl.NumberFormat("fr-FR",{maximumFractionDigits:2,minimumFractionDigits:2});
const ar = v => fmtAr.format(Math.round(v)) + " Ar";
const $ = id => document.getElementById(id);

function monthLabel(id){
  const [y,m] = id.split("-").map(Number);
  const s = new Date(y, m-1, 1).toLocaleDateString("fr-FR",{month:"long",year:"numeric"});
  return s.charAt(0).toUpperCase()+s.slice(1);
}
function parseNum(v){
  if (v === null || v === undefined) return NaN;
  const s = String(v).replace(/\s|\u00a0|\u202f/g,"").replace(",",".").replace(/[\u2212\u2013]/g,"-");
  if (s === "") return NaN;
  return Number(s);
}
function currentMonthId(){
  const d = new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}

/* ---------- Stockage : Supabase (partagé) + cache localStorage ---------- */
let months = {};          // id -> doc
let sb = null;            // client Supabase, si configuré
const TABLE = "mois";
function loadLocal(){
  try { const raw = localStorage.getItem(LS_KEY); months = raw ? JSON.parse(raw) : {}; }
  catch(e){ months = {}; }
}
function saveLocal(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(months)); } catch(e){}
}
function setSync(text, bad){
  const el = $("syncState"); el.textContent = text; el.style.color = bad ? "var(--danger)" : "";
}
async function persist(doc){
  months[doc.id] = doc;
  saveLocal();
  if (sb){
    const { error } = await sb.from(TABLE).upsert({ id: doc.id, data: doc, updated_at: new Date().toISOString() });
    if (error){ setSync("Erreur de synchronisation — enregistré sur cet appareil", true); toast("Non synchronisé : " + error.message); }
    else setSync("Synchronisé — historique partagé");
  }
}
async function removeMonth(id){
  delete months[id];
  saveLocal();
  if (sb){
    const { error } = await sb.from(TABLE).delete().eq("id", id);
    if (error) toast("Suppression non synchronisée : " + error.message);
  }
}
async function loadRemote(){
  const { data, error } = await sb.from(TABLE).select("id, data");
  if (error) throw error;
  const next = {};
  data.forEach(row => { next[row.id] = row.data; });
  return next;
}
async function connectRemote(){
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey || cfg.url.includes("VOTRE")) return;
  if (!window.supabase){ setSync("Bibliothèque Supabase non chargée — enregistré sur cet appareil", true); return; }
  try {
    sb = window.supabase.createClient(cfg.url, cfg.anonKey);
    setSync("Connexion à la base…");
    const remote = await loadRemote();
    // Envoie une seule fois les mois présents uniquement sur cet appareil
    const missing = Object.keys(months).filter(id => !remote[id]);
    if (missing.length){
      const { error } = await sb.from(TABLE).upsert(missing.map(id => ({ id, data: months[id], updated_at: new Date().toISOString() })));
      if (!error) missing.forEach(id => { remote[id] = months[id]; });
    }
    months = remote; saveLocal();
    setSync("Synchronisé — historique partagé");
    // Mises à jour en direct quand quelqu'un d'autre enregistre
    sb.channel("mois-live")
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, payload => {
        if (payload.eventType === "DELETE"){ delete months[payload.old.id]; }
        else { months[payload.new.id] = payload.new.data; }
        saveLocal(); refreshAll();
      })
      .subscribe();
    // Rafraîchit aussi au retour sur l'onglet
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState !== "visible") return;
      try { months = await loadRemote(); saveLocal(); refreshAll(); } catch(e){}
    });
  } catch(e){
    sb = null;
    setSync("Base injoignable — enregistré sur cet appareil", true);
  }
}

/* ---------- Calcul ---------- */
function compute(m){
  const mainKwh = m.main.fin - m.main.debut;
  const subs = PEOPLE.map(p => m.subs[p].fin - m.subs[p].debut);
  const subTotal = subs.reduce((a,b)=>a+b,0);
  const gap = mainKwh - subTotal;
  const billPrice = m.bill.amount / m.bill.kwh;

  let shares;
  if (m.method === "nambinina") shares = PEOPLE.map(p => p === "Nambinina" ? gap : 0); // tout l'écart pour Nambinina
  else if (m.method === "none") shares = PEOPLE.map(()=>0);
  else if (m.method === "equal" || subTotal <= 0) shares = PEOPLE.map(()=>gap/PEOPLE.length);
  else shares = subs.map(c => gap * c / subTotal);

  const kwh = subs.map((c,i)=>c+shares[i]);
  const kwhTotal = kwh.reduce((a,b)=>a+b,0);

  let price = billPrice, target;
  if (m.balance && kwhTotal > 0){
    price = m.bill.amount / kwhTotal;
    target = m.bill.amount;
  }
  // Ajustements du mois (Ar) convertis en kWh au prix appliqué
  const adj = m.adjust || {};
  if (price > 0) PEOPLE.forEach((p,i) => { if (adj[p]) kwh[i] += adj[p] / price; });
  const raw = kwh.map(k => k*price);
  // Arrondi à l'ariary, en gardant un total exact (méthode du plus grand reste)
  if (target === undefined) target = raw.reduce((a,b)=>a+b,0);
  const totalRounded = Math.round(target);
  const floors = raw.map(Math.floor);
  let rest = totalRounded - floors.reduce((a,b)=>a+b,0);
  const order = raw.map((v,i)=>[v-Math.floor(v),i]).sort((a,b)=>b[0]-a[0]);
  const amounts = floors.slice();
  for (let k=0; rest>0 && k<order.length; k++, rest--) amounts[order[k][1]]++;

  return {mainKwh, subs, subTotal, gap, shares, kwh, kwhTotal, billPrice, price, amounts,
          amountTotal: amounts.reduce((a,b)=>a+b,0)};
}

/* ---------- Saisie ---------- */
function buildMeters(){
  const rows = [{key:"main", name:"Compteur principal", color:"var(--brand)"}]
    .concat(PEOPLE.map((p,i)=>({key:p, name:p, color:COLORS[i]})));
  $("meters").innerHTML = rows.map(r => `
    <div class="mrow${r.key==="main"?" main":""}" data-key="${r.key}">
      <div class="who"><span class="dot" style="background:${r.color}"></span>${r.name}</div>
      <div><label for="d-${r.key}">Début du mois</label><input type="text" inputmode="decimal" id="d-${r.key}" autocomplete="off"></div>
      <div><label for="f-${r.key}">Fin du mois</label><input type="text" inputmode="decimal" id="f-${r.key}" autocomplete="off"></div>
      <div class="delta num" id="c-${r.key}">–<small>kWh</small></div>
    </div>`).join("");
  $("meters").addEventListener("input", updateDeltas);
  $("adjusts").innerHTML = PEOPLE.map((p,i)=>`
    <div><label for="a-${p}"><span class="dot" style="background:${COLORS[i]};display:inline-block;margin-right:6px;vertical-align:-1px"></span>${p}</label>
    <input type="text" inputmode="text" id="a-${p}" placeholder="0" autocomplete="off"></div>`).join("");
  $("adjusts").addEventListener("input", updateAdjTotal);
}
function updateDeltas(){
  ["main"].concat(PEOPLE).forEach(k=>{
    const d = parseNum($("d-"+k).value), f = parseNum($("f-"+k).value);
    const el = $("c-"+k);
    if (isFinite(d) && isFinite(f)){
      const c = f-d;
      el.innerHTML = `${fmtKwh.format(c)}<small>kWh consommés</small>`;
      el.style.color = c < 0 ? "var(--danger)" : "";
    } else { el.innerHTML = "–<small>kWh</small>"; el.style.color=""; }
  });
}
function updateAdjTotal(){
  const t = PEOPLE.reduce((s,p)=>{ const v = parseNum($("a-"+p).value); return s + (isFinite(v)?v:0); },0);
  const el = $("adjTotal");
  el.textContent = "Total des ajustements : " + fmtAr.format(t) + " Ar" + (Math.abs(t) >= 0.5 ? " (doit faire 0)" : "");
  el.style.color = Math.abs(t) >= 0.5 ? "var(--danger)" : "";
}
function previousMonth(id){
  return Object.keys(months).filter(k=>k<id).sort().pop();
}
function fillForm(id){
  const m = months[id];
  const setv = (el,v) => { $(el).value = (v===undefined||v===null||Number.isNaN(v)) ? "" : String(v).replace(".",","); };
  if (m){
    setv("d-main",m.main.debut); setv("f-main",m.main.fin);
    PEOPLE.forEach(p=>{ setv("d-"+p,m.subs[p].debut); setv("f-"+p,m.subs[p].fin); });
    setv("billAmount",m.bill.amount); setv("billKwh",m.bill.kwh);
    PEOPLE.forEach(p=>{ const a = m.adjust && m.adjust[p]; $("a-"+p).value = a ? String(a).replace(".",",") : ""; });
    document.querySelector(`input[name=method][value="${m.method}"]`).checked = true;
    $("balance").checked = !!m.balance;
    $("entryHint").textContent = "Ce mois est déjà enregistré. Modifiez les valeurs puis enregistrez à nouveau.";
    $("deleteBtn").hidden = false;
  } else {
    const prev = months[previousMonth(id)];
    ["main"].concat(PEOPLE).forEach(k=>{ $("d-"+k).value=""; $("f-"+k).value=""; });
    $("billAmount").value=""; $("billKwh").value="";
    PEOPLE.forEach(p=>$("a-"+p).value="");
    if (prev){
      setv("d-main",prev.main.fin);
      PEOPLE.forEach(p=>setv("d-"+p,prev.subs[p].fin));
      document.querySelector(`input[name=method][value="${prev.method}"]`).checked = true;
      $("balance").checked = !!prev.balance;
      $("entryHint").textContent = `Relevés de début repris depuis la fin de ${monthLabel(previousMonth(id)).toLowerCase()}.`;
    } else {
      $("entryHint").textContent = "Saisissez les relevés de début et de fin de chaque compteur.";
    }
    $("deleteBtn").hidden = true;
  }
  document.querySelectorAll("#view-entry input.bad").forEach(i=>i.classList.remove("bad"));
  $("errors").textContent = "";
  updateDeltas();
  updateAdjTotal();
}
function readForm(){
  const errs = [];
  document.querySelectorAll("#view-entry input.bad").forEach(i=>i.classList.remove("bad"));
  const id = $("month").value;
  if (!id) errs.push("Choisissez le mois.");
  const read = (elId, label) => {
    const v = parseNum($(elId).value);
    if (!isFinite(v) || v < 0){ $(elId).classList.add("bad"); errs.push(`${label} : saisissez un nombre valide.`); }
    return v;
  };
  const pair = (k,label) => {
    const debut = read("d-"+k, label+" (début)"), fin = read("f-"+k, label+" (fin)");
    if (isFinite(debut) && isFinite(fin) && fin < debut){
      $("f-"+k).classList.add("bad");
      errs.push(`${label} : le relevé de fin est inférieur au relevé de début.`);
    }
    return {debut, fin};
  };
  const main = pair("main","Compteur principal");
  const subs = {}; PEOPLE.forEach(p=>subs[p]=pair(p,p));
  const amount = read("billAmount","Montant de la facture");
  const kwh = read("billKwh","kWh facturés");
  if (isFinite(kwh) && kwh === 0){ $("billKwh").classList.add("bad"); errs.push("kWh facturés : la valeur doit être supérieure à 0."); }
  const adjust = {}; let adjSum = 0;
  PEOPLE.forEach(p=>{
    const raw = $("a-"+p).value.trim();
    if (raw === "") return;
    const v = parseNum(raw);
    if (!isFinite(v)){ $("a-"+p).classList.add("bad"); errs.push(`Ajustement de ${p} : saisissez un nombre valide.`); return; }
    if (v !== 0){ adjust[p] = v; adjSum += v; }
  });
  if (Math.abs(adjSum) >= 0.5) errs.push(`Ajustements : le total doit faire 0 Ar (actuellement ${fmtAr.format(adjSum)} Ar).`);
  const method = document.querySelector("input[name=method]:checked").value;
  const prevPaid = months[id] && months[id].paid;
  const paid = {}; PEOPLE.forEach(p=>paid[p] = !!(prevPaid && prevPaid[p]));
  return {errs, doc:{id, main, subs, bill:{amount, kwh}, adjust, method, balance:$("balance").checked, paid, updatedAt:new Date().toISOString()}};
}

/* ---------- Résultats ---------- */
let shownMonth = null;
function renderResults(){
  const panel = $("resultsPanel");
  const ids = Object.keys(months).sort().reverse();
  if (!ids.length){
    panel.innerHTML = `<div class="empty"><p>Aucun mois enregistré pour l'instant.</p><button class="btn primary" data-go="entry">Saisir les relevés</button></div>`;
    return;
  }
  if (!shownMonth || !months[shownMonth]) shownMonth = ids[0];
  const m = months[shownMonth], r = compute(m);
  const opts = ids.map(i=>`<option value="${i}"${i===shownMonth?" selected":""}>${monthLabel(i)}</option>`).join("");
  const gapAbs = Math.abs(r.gap), gapPct = r.mainKwh>0 ? gapAbs/r.mainKwh*100 : 0;

  const warns = [];
  if (r.gap < 0) warns.push(`La somme des sous-compteurs (${fmtKwh.format(r.subTotal)} kWh) dépasse le compteur principal de ${fmtKwh.format(gapAbs)} kWh. Vérifiez les relevés.`);
  else if (gapPct > 15) warns.push(`L'écart non mesuré représente ${fmtKwh.format(gapPct)} % du compteur principal. Vérifiez les relevés.`);
  if (r.mainKwh > 0 && Math.abs(r.mainKwh - m.bill.kwh)/m.bill.kwh > 0.1) warns.push(`Le compteur principal (${fmtKwh.format(r.mainKwh)} kWh) diffère de plus de 10 % des kWh facturés (${fmtKwh.format(m.bill.kwh)} kWh). Les périodes de relevé ne correspondent peut-être pas.`);
  if (r.kwh.some(k=>k<0)) warns.push("Une part est négative après répartition de l'écart. Choisissez une autre méthode de répartition.");

  // Barre et légende basées sur les kWh attribués (mêmes valeurs que le tableau)
  const unassigned = r.mainKwh - r.kwhTotal;               // écart non réparti (méthode « Ne pas répartir »)
  const total = Math.max(r.mainKwh, r.kwhTotal) || 1;
  const bar = PEOPLE.map((p,i)=>`<div style="width:${Math.max(0,r.kwh[i])/total*100}%;background:${COLORS[i]}" title="${p} : ${fmtKwh.format(r.kwh[i])} kWh"></div>`).join("")
    + (unassigned>0.005 ? `<div class="gapseg" style="width:${unassigned/total*100}%" title="Écart non réparti : ${fmtKwh.format(unassigned)} kWh"></div>` : "");
  const legend = PEOPLE.map((p,i)=>`<span><i class="sw" style="background:${COLORS[i]}"></i>${p} ${fmtKwh.format(r.kwh[i])} kWh</span>`).join("")
    + (unassigned>0.005 ? `<span><i class="sw" style="background:repeating-linear-gradient(135deg,var(--gap) 0 3px,transparent 3px 6px)"></i>Écart non réparti ${fmtKwh.format(unassigned)} kWh</span>` : "");

  const rows = PEOPLE.map((p,i)=>{
    const share = r.shares[i];
    const detail = (m.method==="none" || share===0 || (m.adjust && m.adjust[p])) ? "" :
      `${fmtKwh.format(r.subs[i])} ${share>=0?"+":"−"} ${fmtKwh.format(Math.abs(share))} d'écart`;
    const paid = m.paid && m.paid[p];
    return `<tr>
      <td class="name"><span class="dot" style="background:${COLORS[i]}"></span>${p}</td>
      <td>${fmtKwh.format(r.kwh[i])}<span class="sub">${detail}</span></td>
      <td>${fmtPrice.format(r.price)} Ar</td>
      <td class="pay">${ar(r.amounts[i])}</td>
      <td><button class="paid-toggle" data-paid="${p}" aria-pressed="${paid?"true":"false"}">${paid?"Payé":"À payer"}</button></td>
    </tr>`;
  }).join("");
  const paidCount = PEOPLE.filter(p=>m.paid&&m.paid[p]).length;
  const remaining = PEOPLE.reduce((s,p,i)=>s+((m.paid&&m.paid[p])?0:r.amounts[i]),0);

  panel.innerHTML = `
    <div class="res-head">
      <div><h2>${monthLabel(shownMonth)}</h2><p class="hint" style="margin:0">Écart ${METHOD_LABEL[m.method]}${m.balance?", ajusté au montant de la facture":""}.</p></div>
      <div class="actions">
        <select id="monthPick" aria-label="Choisir le mois">${opts}</select>
        <button class="btn ghost" id="editBtn">Modifier</button>
      </div>
    </div>
    ${warns.map(w=>`<p class="warn">${w}</p>`).join("")}
    <div class="facts num">
      <div class="fact"><span>Compteur principal</span><b>${fmtKwh.format(r.mainKwh)} kWh</b></div>
      <div class="fact"><span>Somme des sous-compteurs</span><b>${fmtKwh.format(r.subTotal)} kWh</b></div>
      <div class="fact"><span>Écart</span><b>${fmtKwh.format(r.gap)} kWh</b></div>
      <div class="fact"><span>Prix moyen facture</span><b>${fmtPrice.format(r.billPrice)} Ar/kWh</b></div>
      <div class="fact"><span>Facture</span><b>${ar(m.bill.amount)}</b></div>
    </div>
    <div class="split" aria-label="Répartition de la consommation du compteur principal">
      <div class="bar">${bar}</div>
      <div class="legend num">${legend}</div>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Nom</th><th>Consommation (kWh)</th><th>Prix du kWh</th><th>Montant à payer</th><th>Paiement</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td>${fmtKwh.format(r.kwhTotal)}</td><td></td><td>${ar(r.amountTotal)}</td><td>${paidCount}/5</td></tr></tfoot>
      </table>
    </div>
    <p class="note num">${m.balance
      ? `Le prix appliqué (${fmtPrice.format(r.price)} Ar/kWh) répartit exactement le montant de la facture sur les ${fmtKwh.format(r.kwhTotal)} kWh attribués.`
      : `Prix appliqué : prix moyen de la facture. Écart avec la facture : ${ar(r.amountTotal - m.bill.amount)}.`}
      ${remaining>0 ? ` Reste à encaisser : ${ar(remaining)}.` : " Tout le monde a payé."}</p>`;
}

/* ---------- Historique ---------- */
function renderHistory(){
  const panel = $("historyPanel");
  const ids = Object.keys(months).sort().reverse();
  if (!ids.length){
    panel.innerHTML = `<div class="empty"><p>L'historique se remplit à chaque mois enregistré.</p><button class="btn primary" data-go="entry">Saisir les relevés</button></div>`;
    return;
  }
  const totals = PEOPLE.map(()=>0); let grand = 0, grandKwh = 0;
  const rows = ids.map(id=>{
    const m = months[id], r = compute(m);
    grand += r.amountTotal; grandKwh += r.mainKwh;
    return `<tr data-open="${id}">
      <td>${monthLabel(id)}</td>
      <td>${fmtKwh.format(r.mainKwh)}</td>
      ${PEOPLE.map((p,i)=>{ totals[i]+=r.amounts[i];
        return `<td>${fmtAr.format(r.amounts[i])}${m.paid&&m.paid[p]?'<span class="ck" title="Payé" aria-label="payé">✓</span>':""}</td>`; }).join("")}
      <td><b>${fmtAr.format(r.amountTotal)}</b></td>
    </tr>`;
  }).join("");
  panel.innerHTML = `
    <h2>Historique</h2>
    <p class="hint">Montants en ariary. ✓ indique un paiement reçu. Touchez un mois pour voir le détail.</p>
    <div class="tbl-wrap">
      <table id="history">
        <thead><tr><th>Mois</th><th>kWh</th>${PEOPLE.map(p=>`<th>${p}</th>`).join("")}<th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Cumul</td><td>${fmtKwh.format(grandKwh)}</td>${totals.map(t=>`<td>${fmtAr.format(t)}</td>`).join("")}<td>${fmtAr.format(grand)}</td></tr></tfoot>
      </table>
    </div>`;
}

/* ---------- Navigation & événements ---------- */
function show(view){
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-selected", b.dataset.view===view?"true":"false"));
  document.querySelectorAll("section.view").forEach(s=>s.classList.toggle("active", s.id==="view-"+view));
  if (view==="results") renderResults();
  if (view==="history") renderHistory();
  window.scrollTo(0,0);
}
function refreshAll(){
  const active = document.querySelector("section.view.active").id;
  if (active==="view-results") renderResults();
  if (active==="view-history") renderHistory();
  if (active==="view-entry") $("deleteBtn").hidden = !months[$("month").value];
}
let toastTimer;
function toast(msg){
  const t=$("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove("show"),2200);
}

document.querySelector("nav.tabs").addEventListener("click", e=>{
  const b = e.target.closest("button[data-view]"); if (b) show(b.dataset.view);
});
document.addEventListener("click", async e=>{
  const go = e.target.closest("[data-go]"); if (go){ show(go.dataset.go); return; }
  const tr = e.target.closest("tr[data-open]"); if (tr){ shownMonth = tr.dataset.open; show("results"); return; }
  const pb = e.target.closest("button[data-paid]");
  if (pb && shownMonth && months[shownMonth]){
    const doc = JSON.parse(JSON.stringify(months[shownMonth]));
    doc.paid = doc.paid || {};
    doc.paid[pb.dataset.paid] = !doc.paid[pb.dataset.paid];
    pb.disabled = true;
    await persist(doc);
    renderResults();
    return;
  }
  if (e.target.id==="editBtn"){ $("month").value = shownMonth; fillForm(shownMonth); show("entry"); }
});
document.addEventListener("change", e=>{
  if (e.target.id==="monthPick"){ shownMonth = e.target.value; renderResults(); }
});
$("month").addEventListener("change", ()=>{ if ($("month").value) fillForm($("month").value); });
$("saveBtn").addEventListener("click", async ()=>{
  const {errs, doc} = readForm();
  if (errs.length){ $("errors").textContent = errs[0] + (errs.length>1 ? ` (+${errs.length-1} autre${errs.length>2?"s":""})` : ""); return; }
  $("errors").textContent = "";
  $("saveBtn").disabled = true;
  await persist(doc);
  $("saveBtn").disabled = false;
  shownMonth = doc.id;
  toast("Mois enregistré");
  show("results");
});
$("deleteBtn").addEventListener("click", async ()=>{
  const id = $("month").value;
  if (!months[id]) return;
  if (!confirm(`Supprimer définitivement ${monthLabel(id).toLowerCase()} ?`)) return;
  await removeMonth(id);
  if (shownMonth===id) shownMonth=null;
  fillForm(id);
  toast("Mois supprimé");
});

/* ---------- Démarrage ---------- */
loadLocal();
buildMeters();
$("month").value = currentMonthId();
fillForm($("month").value);
connectRemote().then(() => {
  // Recharge le formulaire si rien n'a encore été saisi
  if (!$("f-main").value) fillForm($("month").value);
  refreshAll();
});
})();
