"use strict";

// Data comes straight from TibiaData in the browser (it allows any origin and
// caches tibia.com for 5 minutes). Settings and alerts live behind /api, which
// Cloudflare Access protects; without it they stay in this browser.

const API = "https://api.tibiadata.com/v4";
const TOWNS = [
  "Ab'Dendriel", "Ankrahmun", "Carlin", "Darashia", "Edron", "Farmine", "Gray Beach",
  "Issavi", "Kazordoon", "Liberty Bay", "Moonfall", "Port Hope", "Rathleton",
  "Silvertides", "Svargrond", "Thais", "Venore", "Yalahar",
];
const ENDING_SOON_HOURS = 24;
const CACHE_MS = 5 * 60 * 1000;
const BAZAAR_PR = "https://github.com/tibiadata/tibiadata-api-go/pull/715";

const LABELS = {
  pvp_type: { open: "Open PvP", optional: "Optional PvP", hardcore: "Hardcore PvP", retro_open: "Retro Open PvP", retro_hardcore: "Retro Hardcore PvP" },
  battleye: { protected: "BattlEye green", initially_protected: "BattlEye yellow", not_protected: "No BattlEye" },
  skill: { magic_level: "Magic level", distance_fighting: "Distance", sword_fighting: "Sword", axe_fighting: "Axe", club_fighting: "Club", fist_fighting: "Fist", shielding: "Shielding", fishing: "Fishing" },
  search_type: { item: "item", item_wildcard: "item (partial)", character_name: "name" },
};

const $ = (sel, root = document) => root.querySelector(sel);
const gold = (n) => Number(n).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  settings: { world: "", towns: TOWNS.slice() },
  alerts: [],
  houses: [],
  synced: false,
};

// ---------- Storage: /api when deployed, this browser otherwise ----------

const store = {
  async load(key, fallback) {
    try {
      const resp = await fetch(`api/${key}`, { cache: "no-store" });
      if (resp.ok) {
        state.synced = true;
        return (await resp.json()) ?? fallback;
      }
    } catch { /* offline or local preview */ }
    try {
      return JSON.parse(localStorage.getItem(`tt.${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  async save(key, value) {
    const body = JSON.stringify(value);
    if (state.synced) {
      const resp = await fetch(`api/${key}`, { method: "PUT", body, headers: { "content-type": "application/json" } });
      if (!resp.ok) throw new Error(`Saving failed (HTTP ${resp.status})`);
      return;
    }
    try { localStorage.setItem(`tt.${key}`, body); } catch { /* private mode */ }
  },
};

// ---------- TibiaData ----------

async function getJSON(url, { cache = true } = {}) {
  const key = `tt.cache.${url}`;
  if (cache) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(key));
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    } catch { /* ignore */ }
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = new Error(`TibiaData answered HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* full */ }
  return data;
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

let worldsPromise;
function loadWorlds() {
  worldsPromise ??= getJSON(`${API}/worlds`).then((d) => d.worlds.regular_worlds.map((w) => w.name).sort());
  return worldsPromise;
}

function hoursLeft(timeLeft) {
  const m = /^(\d+) (minute|hour|day)/.exec(timeLeft || "");
  if (!m) return null;
  return Number(m[1]) * { minute: 0, hour: 1, day: 24 }[m[2]];
}

function houseUrl(world, id) {
  return `https://www.tibia.com/community/?subtopic=houses&page=view&world=${encodeURIComponent(world)}&houseid=${id}`;
}

const houseImg = (id) => `https://static.tibia.com/images/houses/house_${id}.png`;

async function fetchHouses(world, towns, force) {
  if (force) {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith("tt.cache.")) sessionStorage.removeItem(k);
  }
  const perTown = await mapLimited(towns, 4, async (town) => {
    const data = await getJSON(`${API}/houses/${encodeURIComponent(world)}/${encodeURIComponent(town)}`);
    const h = data.houses || {};
    const list = [];
    for (const [key, guildhall] of [["house_list", false], ["guildhall_list", true]]) {
      for (const x of h[key] || []) {
        if (!x.auctioned || x.auction?.finished) continue;
        list.push({
          id: x.house_id, name: x.name, town, size: x.size, rent: x.rent, guildhall,
          bid: x.auction?.current_bid ?? 0, timeLeft: x.auction?.time_left ?? "",
          hours: hoursLeft(x.auction?.time_left),
        });
      }
    }
    return list;
  });
  return perTown.flat();
}

// ---------- Houses tab ----------

const SORTS = {
  ending: (a, b) => (a.hours === null) - (b.hours === null) || (a.hours ?? 0) - (b.hours ?? 0) || a.name.localeCompare(b.name),
  "bid-asc": (a, b) => a.bid - b.bid,
  "bid-desc": (a, b) => b.bid - a.bid,
  size: (a, b) => b.size - a.size,
  name: (a, b) => a.name.localeCompare(b.name),
};

function filteredHouses() {
  const q = $("#f-search").value.trim().toLowerCase();
  const town = $("#f-town").value;
  const maxBid = Number($("#f-maxbid").value) || null;
  const minSize = Number($("#f-minsize").value) || null;
  const guildhalls = $("#f-guildhalls").checked;
  return state.houses
    .filter((h) => (!q || h.name.toLowerCase().includes(q))
      && (!town || h.town === town)
      && (maxBid === null || h.bid <= maxBid)
      && (minSize === null || h.size >= minSize)
      && (guildhalls || !h.guildhall))
    .sort(SORTS[$("#f-sort").value]);
}

function houseCard(h) {
  const soon = h.hours !== null && h.hours <= ENDING_SOON_HOURS;
  const status = h.timeLeft ? `${esc(h.timeLeft)} left` : "No bids yet";
  return `
    <article class="card">
      <div class="card-top">
        <img class="thumb" src="${houseImg(h.id)}" alt="" loading="lazy" width="72" height="72" onerror="this.style.visibility='hidden'">
        <div>
          <div class="card-title">${esc(h.name)}</div>
          <div class="card-sub">${esc(h.town)}${h.guildhall ? '<span class="badge badge-gold">Guildhall</span>' : ""}${soon ? '<span class="badge badge-hot">Ending soon</span>' : ""}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><span>Bid</span><b class="gold">${h.bid ? gold(h.bid) : "—"}</b></div>
        <div class="stat"><span>Size</span><b>${h.size} sqm</b></div>
        <div class="stat"><span>Ends</span><b>${status}</b></div>
      </div>
      <div class="card-actions">
        <button class="btn btn-small" data-details="${h.id}">Details</button>
        <a class="btn btn-small btn-primary" href="${esc(houseUrl(state.settings.world, h.id))}" target="_blank" rel="noopener">View auction ↗</a>
      </div>
    </article>`;
}

function renderHouses() {
  const list = filteredHouses();
  const grid = $("#houses-grid");
  grid.innerHTML = list.length
    ? list.map(houseCard).join("")
    : `<div class="empty">${state.houses.length ? "No houses match these filters." : "No houses are up for auction in the selected towns right now."}</div>`;
  const shown = list.length === state.houses.length ? `${list.length}` : `${list.length} of ${state.houses.length}`;
  $("#houses-summary").textContent = `${shown} houses on ${state.settings.world} · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

async function loadHouses(force = false) {
  const { world, towns } = state.settings;
  if (!world) return;
  $("#houses-error").hidden = true;
  $("#houses-summary").textContent = `Loading houses on ${world}…`;
  $("#houses-grid").innerHTML = '<div class="skeleton"></div>'.repeat(6);
  try {
    state.houses = await fetchHouses(world, towns, force);
    renderHouses();
  } catch (e) {
    $("#houses-grid").innerHTML = "";
    $("#houses-summary").textContent = "";
    const box = $("#houses-error");
    box.hidden = false;
    box.innerHTML = `Couldn't load houses: ${esc(e.message)}. TibiaData may be busy. <button class="btn btn-small" id="retry-houses">Try again</button>`;
    $("#retry-houses").onclick = () => loadHouses(true);
  }
}

async function openHouse(id) {
  const h = state.houses.find((x) => x.id === id);
  const world = state.settings.world;
  const dlg = $("#house-dialog");
  $("#hd-title").textContent = h.name;
  $("#hd-body").innerHTML = '<div class="skeleton" style="height:150px"></div>';
  dlg.showModal();
  let d = null;
  try {
    d = (await getJSON(`${API}/house/${encodeURIComponent(world)}/${id}`)).house;
  } catch { /* fall back to list data */ }
  const auction = d?.status?.auction || {};
  const end = auction.auction_end ? new Date(auction.auction_end) : null;
  const rows = [
    ["Town", esc(h.town) + (h.guildhall ? " · guildhall" : "")],
    ["Size", `${h.size} sqm`],
    d?.beds ? ["Beds", d.beds] : null,
    ["Rent", `${gold(h.rent)} gold / month`],
    ["Current bid", h.bid ? `<span style="color:var(--gold)">${gold(h.bid)} gold</span>` : "No bids yet"],
    auction.current_bidder ? ["Top bidder", esc(auction.current_bidder)] : null,
    end ? ["Auction ends", esc(end.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))] : null,
    h.timeLeft ? ["Time left", esc(h.timeLeft)] : null,
  ].filter(Boolean);
  $("#hd-body").innerHTML = `
    <div class="house-detail">
      <img src="${houseImg(id)}" alt="Map of ${esc(h.name)}" onerror="this.style.visibility='hidden'">
      <div>
        <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
        ${d?.status?.original ? `<p class="detail-note">${esc(d.status.original)}</p>` : ""}
      </div>
    </div>
    <div class="dialog-foot" style="padding:18px 0 0;border:0">
      <span class="spacer"></span>
      <a class="btn btn-primary" href="${esc(houseUrl(world, id))}" target="_blank" rel="noopener">Bid on tibia.com ↗</a>
    </div>`;
}

// ---------- Characters tab ----------

let bazaarLive = null;

async function checkBazaar() {
  const box = $("#bazaar-status");
  box.className = "banner";
  box.textContent = "Checking whether character data is available…";
  try {
    await getJSON(`${API}/charactertrades/ending`, { cache: false });
    bazaarLive = true;
    box.className = "banner banner-ok";
    box.innerHTML = "<strong>Character data is live.</strong> Matching auctions for your alerts are shown below.";
  } catch (e) {
    bazaarLive = false;
    box.className = "banner banner-wait";
    box.innerHTML = e.status === 404
      ? `<strong>Waiting for TibiaData.</strong> Character auctions aren't available yet
         (<a href="${BAZAAR_PR}" target="_blank" rel="noopener">pull request #715</a> is still open).
         You can set up your alerts now. They'll start working once it goes live, and the tracker will notify you.`
      : `<strong>Couldn't reach TibiaData</strong> (${esc(e.message)}). Your alerts are still saved.`;
  }
  renderAuctions();
}

function alertChips(a) {
  const chips = [];
  if (a.world) chips.push(a.world);
  if (a.pvp_type) chips.push(LABELS.pvp_type[a.pvp_type]);
  if (a.battleye) chips.push(LABELS.battleye[a.battleye]);
  if (a.vocation) chips.push(a.vocation[0].toUpperCase() + a.vocation.slice(1));
  if (a.min_level || a.max_level) chips.push(`Level ${a.min_level || 1}–${a.max_level || "∞"}`);
  if (a.skill) chips.push(`${LABELS.skill[a.skill]} ${a.min_skill || 0}–${a.max_skill || "∞"}`);
  if (a.search) chips.push(`${LABELS.search_type[a.search_type]}: “${a.search}”`);
  if (a.max_bid) chips.push(`≤ ${gold(a.max_bid)} TC`);
  return chips.length ? chips : ["Any character"];
}

function renderAlerts() {
  const box = $("#alerts-list");
  if (!state.alerts.length) {
    box.innerHTML = '<div class="empty">No alerts yet. Create one to get notified about characters you\'re interested in.</div>';
    return;
  }
  box.innerHTML = state.alerts.map((a) => `
    <article class="card alert-card ${a.enabled ? "" : "alert-off"}">
      <div class="alert-head">
        <div class="card-title">${esc(a.label)}</div>
        <label class="switch" title="${a.enabled ? "On" : "Off"}">
          <input type="checkbox" data-toggle="${a.id}" ${a.enabled ? "checked" : ""} aria-label="Alert on">
          <span></span>
        </label>
      </div>
      <div class="chips">${alertChips(a).map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>
      <div class="card-actions"><button class="btn btn-small" data-edit="${a.id}">Edit</button></div>
    </article>`).join("");
}

function alertQuery(a) {
  const p = new URLSearchParams();
  for (const k of ["world", "pvp_type", "battleye", "vocation", "min_level", "max_level", "skill", "min_skill", "max_skill"]) {
    if (a[k]) p.set(k, a[k]);
  }
  if (a.search) { p.set("search", a.search); p.set("search_type", a.search_type); }
  return p.toString();
}

async function renderAuctions() {
  const active = state.alerts.filter((a) => a.enabled);
  $("#auctions-block").hidden = !bazaarLive || !active.length;
  if (!bazaarLive || !active.length) return;
  const list = $("#auctions-list");
  list.innerHTML = '<div class="skeleton"></div>'.repeat(3);
  const byId = new Map();
  try {
    await mapLimited(active, 2, async (a) => {
      const data = await getJSON(`${API}/charactertrades/ending?${alertQuery(a)}`);
      for (const x of data.charactertrades?.auction_list || []) {
        if (a.max_bid && x.bid > a.max_bid) continue;
        const hit = byId.get(x.auction_id) || { ...x, alerts: [] };
        hit.alerts.push(a.label);
        byId.set(x.auction_id, hit);
      }
    });
  } catch (e) {
    list.innerHTML = `<div class="empty">Couldn't load auctions: ${esc(e.message)}</div>`;
    return;
  }
  const hits = [...byId.values()].sort((a, b) => new Date(a.auction_end) - new Date(b.auction_end));
  list.innerHTML = hits.length ? hits.map((x) => `
    <article class="card">
      <div class="card-title">${esc(x.name)}</div>
      <div class="card-sub">Level ${x.level} ${esc(x.vocation)} · ${esc(x.world)}</div>
      <div class="stats">
        <div class="stat"><span>${x.bid_type === "current" ? "Bid" : "Min bid"}</span><b class="gold">${gold(x.bid)} TC</b></div>
        <div class="stat" style="grid-column:span 2"><span>Ends</span><b>${esc(new Date(x.auction_end).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}</b></div>
      </div>
      <div class="chips">${x.alerts.map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</div>
      <div class="card-actions">
        <a class="btn btn-small btn-primary" href="https://www.tibia.com/charactertrade/?subtopic=currentcharactertrades&page=details&auctionid=${Number(x.auction_id)}" target="_blank" rel="noopener">View auction ↗</a>
      </div>
    </article>`).join("") : '<div class="empty">No auctions ending in the next 24 hours match your alerts.</div>';
}

const ALERT_FIELDS = ["label", "world", "pvp_type", "battleye", "vocation", "min_level", "max_level", "skill", "min_skill", "max_skill", "search", "search_type", "max_bid"];
const NUMERIC = new Set(["min_level", "max_level", "min_skill", "max_skill", "max_bid"]);
let editingId = null;

async function openAlertForm(id = null) {
  editingId = id;
  const form = $("#alert-form");
  form.reset();
  const a = state.alerts.find((x) => x.id === id) || { world: state.settings.world, enabled: true, search_type: "item" };
  $("#af-title").textContent = id ? "Edit alert" : "New character alert";
  $("#af-delete").hidden = !id;
  await fillWorldSelect(form.elements.world, "Any world");
  for (const k of ALERT_FIELDS) form.elements[k].value = a[k] ?? "";
  form.elements.search_type.value = a.search_type || "item";
  form.elements.enabled.checked = a.enabled !== false;
  $("#alert-dialog").showModal();
}

async function saveAlerts() {
  try {
    await store.save("alerts", state.alerts);
  } catch (e) {
    alert(e.message);
  }
  renderAlerts();
  renderAuctions();
}

// ---------- Settings ----------

async function fillWorldSelect(select, emptyLabel) {
  const current = select.value;
  try {
    const worlds = await loadWorlds();
    select.innerHTML = `<option value="">${emptyLabel}</option>` + worlds.map((w) => `<option>${esc(w)}</option>`).join("");
  } catch { /* keep what is there */ }
  select.value = current;
}

async function openSettings() {
  const form = $("#settings-form");
  await fillWorldSelect(form.elements.world, "Choose a world…");
  form.elements.world.value = state.settings.world;
  $("#settings-towns").innerHTML = TOWNS.map((t) => `
    <label class="check"><input type="checkbox" name="town" value="${esc(t)}" ${state.settings.towns.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("");
  $("#settings-dialog").showModal();
}

function applySettings() {
  const chip = $("#world-chip");
  chip.hidden = !state.settings.world;
  chip.textContent = state.settings.world;
  const townSel = $("#f-town");
  townSel.innerHTML = '<option value="">All towns</option>' + state.settings.towns.map((t) => `<option>${esc(t)}</option>`).join("");
}

// ---------- Wiring ----------

function showTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  $("#tab-houses").hidden = name !== "houses";
  $("#tab-chars").hidden = name !== "chars";
  if (name === "chars" && bazaarLive === null) checkBazaar();
  try { localStorage.setItem("tt.tab", name); } catch { /* ignore */ }
}

function wire() {
  for (const t of document.querySelectorAll(".tab")) t.onclick = () => showTab(t.dataset.tab);
  for (const el of document.querySelectorAll("[data-close]")) el.onclick = () => el.closest("dialog").close();
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  }

  for (const id of ["#f-search", "#f-town", "#f-sort", "#f-maxbid", "#f-minsize", "#f-guildhalls"]) {
    $(id).addEventListener("input", renderHouses);
  }
  $("#refresh-houses").onclick = () => loadHouses(true);
  $("#houses-grid").onclick = (e) => {
    const b = e.target.closest("[data-details]");
    if (b) openHouse(Number(b.dataset.details));
  };

  $("#open-settings").onclick = openSettings;
  $("#settings-form").onsubmit = async (e) => {
    const f = e.target;
    const towns = [...f.querySelectorAll('input[name="town"]:checked')].map((x) => x.value);
    if (!f.elements.world.value || !towns.length) {
      e.preventDefault();
      alert("Pick a world and at least one town.");
      return;
    }
    state.settings = { world: f.elements.world.value, towns };
    try { await store.save("settings", state.settings); } catch (err) { alert(err.message); }
    applySettings();
    loadHouses();
  };

  $("#new-alert").onclick = () => openAlertForm();
  $("#alerts-list").onclick = (e) => {
    const edit = e.target.closest("[data-edit]");
    if (edit) openAlertForm(edit.dataset.edit);
  };
  $("#alerts-list").onchange = (e) => {
    const t = e.target.closest("[data-toggle]");
    if (!t) return;
    const a = state.alerts.find((x) => x.id === t.dataset.toggle);
    a.enabled = t.checked;
    saveAlerts();
  };
  $("#alert-form").onsubmit = (e) => {
    const f = e.target;
    const a = { id: editingId || crypto.randomUUID(), enabled: f.elements.enabled.checked };
    for (const k of ALERT_FIELDS) {
      const v = f.elements[k].value.trim();
      a[k] = NUMERIC.has(k) ? (v ? Number(v) : null) : v;
    }
    if (!a.search) a.search_type = "item";
    if (!a.skill) { a.min_skill = null; a.max_skill = null; }
    const i = state.alerts.findIndex((x) => x.id === a.id);
    if (i >= 0) state.alerts[i] = a; else state.alerts.push(a);
    saveAlerts();
  };
  $("#af-delete").onclick = () => {
    if (!confirm("Delete this alert?")) return;
    state.alerts = state.alerts.filter((x) => x.id !== editingId);
    $("#alert-dialog").close();
    saveAlerts();
  };
}

async function init() {
  wire();
  const [settings, alerts] = await Promise.all([store.load("settings", null), store.load("alerts", [])]);
  if (settings) state.settings = { ...state.settings, ...settings };
  state.alerts = Array.isArray(alerts) ? alerts : [];
  $("#storage-mode").textContent = state.synced ? "" : " Settings are saved in this browser only.";
  applySettings();
  renderAlerts();

  let tab = "houses";
  try { tab = localStorage.getItem("tt.tab") || tab; } catch { /* ignore */ }
  showTab(tab);

  if (state.settings.world) loadHouses();
  else {
    $("#houses-summary").textContent = "Choose your world to see its house auctions.";
    $("#houses-grid").innerHTML = '<div class="empty">No world selected yet. <button class="btn btn-primary btn-small" id="pick-world">Choose world</button></div>';
    $("#pick-world").onclick = openSettings;
    openSettings();
  }
}

init();
