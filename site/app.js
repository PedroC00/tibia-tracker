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
// Tibia shorthand: 800K, 2.5KK (one decimal at most).
const shortGold = (n) => {
  const short = (size) => Number((n / size).toFixed(n >= 100 * size ? 0 : 1));
  if (n >= 999_500) return `${short(1e6)}KK`;
  if (n >= 1000) return `${short(1e3)}K`;
  return String(n);
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  settings: { world: "", towns: TOWNS.slice() },
  alerts: [],
  world: "",  // the world on screen; starts at the default from settings
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
  worldsPromise ??= getJSON(`${API}/worlds`)
    .then((d) => d.worlds.regular_worlds.sort((a, b) => a.name.localeCompare(b.name)))
    .catch((e) => { worldsPromise = null; throw e; });
  return worldsPromise;
}

// Character World Transfer rules from the Tibia manual (Extra Services): PvP may
// only stay the same or get milder, worlds protected by BattlEye since launch only
// take characters from such worlds, blocked worlds take none, and characters on
// locked worlds can only move to other locked worlds.
const PVP_RANK = { "Optional PvP": 0, "Open PvP": 1, "Retro Open PvP": 1, "Hardcore PvP": 2, "Retro Hardcore PvP": 2 };
const TRANSFER_MANUAL = "https://www.tibia.com/gameguides/?subtopic=manual&section=products";

function canTransfer(from, to) {
  if (from.name === to.name) return true;
  if (to.transfer_type === "blocked") return false;
  if (from.transfer_type === "locked" && to.transfer_type !== "locked") return false;
  if ((PVP_RANK[from.pvp_type] ?? -1) < (PVP_RANK[to.pvp_type] ?? 0)) return false;
  if (to.battleye_date === "release" && from.battleye_date !== "release") return false;
  return true;
}

async function transferSources(target) {
  const worlds = await loadWorlds();
  const to = worlds.find((w) => w.name === target);
  if (!to) return null;
  return { to, worlds, from: new Set(worlds.filter((w) => canTransfer(w, to)).map((w) => w.name)) };
}

function hoursLeft(timeLeft) {
  const m = /^(\d+) (minute|hour|day)/.exec(timeLeft || "");
  if (!m) return null;
  return Number(m[1]) * { minute: 0, hour: 1, day: 24 }[m[2]];
}

function houseUrl(world, id) {
  return `https://www.tibia.com/community/?subtopic=houses&page=view&world=${encodeURIComponent(world)}&houseid=${id}`;
}

// Houses only one vocation can enter, by house id. Neither tibia.com nor TibiaData
// says so; TibiaWiki notes it on the house pages, and these are the only ones.
// Keep in sync with VOCATION_ONLY in tracker/houses.py.
const VOCATION_ONLY = {
  10505: "Sorcerers", 10508: "Sorcerers", 10510: "Sorcerers",  // Sorcerer's Avenue Labs, Sorcerer Guild basement in Thais
};

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

const ICONS = {
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  bed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18V7m0 6h18v5M3 13V11a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m10 0v-1a3 3 0 0 0-3-3h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor"/></svg>',
};

// A house's bed count never changes, so it's fetched once and kept in this browser.
let beds = {};
try { beds = JSON.parse(localStorage.getItem("tt.beds")) || {}; } catch { /* private mode */ }

const bedsText = (n) => (n === undefined ? "… beds" : `${n} bed${n === 1 ? "" : "s"}`);

async function fillBeds(world, ids) {
  const missing = ids.filter((id) => beds[id] === undefined);
  await mapLimited(missing, 4, async (id) => {
    try {
      const n = (await getJSON(`${API}/house/${encodeURIComponent(world)}/${id}`)).house?.beds;
      if (typeof n === "number") beds[id] = n;
    } catch { /* leave it unknown */ }
    for (const el of document.querySelectorAll(`[data-beds="${id}"]`)) {
      el.lastChild.textContent = beds[id] === undefined ? "? beds" : bedsText(beds[id]);
    }
  });
  try { localStorage.setItem("tt.beds", JSON.stringify(beds)); } catch { /* full */ }
}

// Joins the last two words so a short ending like "2c" never wraps alone.
const keepLastWords = (name) => esc(name).replace(/ (\S+)$/, "\u00a0$1");

function houseCard(h) {
  const soon = h.hours !== null && h.hours <= ENDING_SOON_HOURS;
  const ends = h.timeLeft ? `${esc(h.timeLeft)} left` : "Starts at first bid";
  const tags = [];
  if (VOCATION_ONLY[h.id]) tags.push(`<span class="badge badge-warn" title="Only ${VOCATION_ONLY[h.id].toLowerCase()} can enter this house">${VOCATION_ONLY[h.id]} only</span>`);
  if (h.guildhall) tags.push('<span class="badge badge-gold">Guildhall</span>');
  return `
    <article class="card house-card${soon ? " is-soon" : ""}">
      <button class="house-img" data-details="${h.id}" aria-label="Details for ${esc(h.name)}">
        <img src="${houseImg(h.id)}" alt="" loading="lazy" width="150" height="150" onerror="this.style.visibility='hidden'">
      </button>
      <div class="house-info">
        <div>
          <h3 class="house-name">${keepLastWords(h.name)}</h3>
          <div class="house-town">${esc(h.town)}</div>
          ${tags.length ? `<div class="house-tags">${tags.join("")}</div>` : ""}
        </div>
        <div class="house-size">
          <span class="amount">${h.size}<small> sqm</small></span>
          <span class="meta" data-beds="${h.id}">${ICONS.bed}<span>${bedsText(beds[h.id])}</span></span>
        </div>
        <div class="house-meta">
          <span class="meta bid" title="${h.bid ? `${gold(h.bid)} gold` : ""}">${ICONS.tag}${h.bid ? `${shortGold(h.bid)} bid` : "No bids yet"}</span>
          <span class="meta${soon ? " hot" : ""}">${ICONS.clock}${ends}</span>
        </div>
      </div>
      <div class="house-actions">
        <button class="btn btn-small btn-ghost" data-details="${h.id}">Details</button>
        <a class="btn btn-small btn-primary" href="${esc(houseUrl(state.world, h.id))}" target="_blank" rel="noopener">View auction ↗</a>
      </div>
    </article>`;
}

function renderHouses() {
  const list = filteredHouses();
  // The filters start collapsed, so say on the toggle when any are narrowing the list.
  const active = ["#f-search", "#f-town", "#f-maxbid", "#f-minsize"].filter((id) => $(id).value.trim()).length
    + ($("#f-guildhalls").checked ? 0 : 1) + ($("#f-sort").value === "ending" ? 0 : 1);
  $("#filters-count").hidden = !active;
  $("#filters-count").textContent = active;
  const grid = $("#houses-grid");
  grid.innerHTML = list.length
    ? list.map(houseCard).join("")
    : `<div class="empty">${state.houses.length ? "No houses match these filters." : "No houses are up for auction in the selected towns right now."}</div>`;
  const shown = list.length === state.houses.length ? `${list.length}` : `${list.length} of ${state.houses.length}`;
  $("#houses-summary").textContent = `${shown} houses on ${state.world} · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  fillBeds(state.world, list.map((h) => h.id));
}

async function loadHouses(force = false) {
  const { world } = state;
  const { towns } = state.settings;
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
  const world = state.world;
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
    VOCATION_ONLY[id] ? ["Access", `<span class="warn">Only ${VOCATION_ONLY[id].toLowerCase()} can enter</span>`] : null,
    ["Size", `${h.size} sqm`],
    (d?.beds ?? beds[id]) !== undefined ? ["Beds", d?.beds ?? beds[id]] : null,
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
         ${state.synced
           ? "You can set up your alerts now. They'll start working once it goes live, and the tracker will notify you."
           : "You can set up alerts now to see matches on this page once it goes live. They're saved in this browser only; phone notifications use the tracker's own settings."}`
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
  if (a.transfer_to) chips.push(`Can move to ${a.transfer_to}`);
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
  const movable = {};
  let here = null;
  try {
    for (const w of new Set([state.world, ...active.map((a) => a.transfer_to)].filter(Boolean))) {
      movable[w] = (await transferSources(w))?.from;
    }
    here = movable[state.world];
    await mapLimited(active, 2, async (a) => {
      const data = await getJSON(`${API}/charactertrades/ending?${alertQuery(a)}`);
      for (const x of data.charactertrades?.auction_list || []) {
        if (a.max_bid && x.bid > a.max_bid) continue;
        if (a.transfer_to && movable[a.transfer_to] && !movable[a.transfer_to].has(x.world)) continue;
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
      <div class="chips">
        ${here ? (here.has(x.world) ? `<span class="chip chip-ok">Can move to ${esc(state.world)}</span>` : `<span class="chip chip-no">Can't move to ${esc(state.world)}</span>`) : ""}
        ${x.alerts.map((l) => `<span class="chip">${esc(l)}</span>`).join("")}
      </div>
      <div class="card-actions">
        <a class="btn btn-small btn-primary" href="https://www.tibia.com/charactertrade/?subtopic=currentcharactertrades&page=details&auctionid=${Number(x.auction_id)}" target="_blank" rel="noopener">View auction ↗</a>
      </div>
    </article>`).join("") : '<div class="empty">No auctions ending in the next 24 hours match your alerts.</div>';
}

const ALERT_FIELDS = ["label", "world", "pvp_type", "battleye", "vocation", "min_level", "max_level", "skill", "min_skill", "max_skill", "search", "search_type", "max_bid"];
const NUMERIC = new Set(["min_level", "max_level", "min_skill", "max_skill", "max_bid"]);
let editingId = null;

async function openAlertForm(id = null, preset = {}) {
  editingId = id;
  const form = $("#alert-form");
  form.reset();
  const a = state.alerts.find((x) => x.id === id) || { world: state.settings.world, enabled: true, search_type: "item", ...preset };
  $("#af-title").textContent = id ? "Edit alert" : "New character alert";
  $("#af-delete").hidden = !id;
  await fillWorldSelect(form.elements.world, "Any world");
  for (const k of ALERT_FIELDS) form.elements[k].value = a[k] ?? "";
  form.elements.search_type.value = a.search_type || "item";
  form.elements.enabled.checked = a.enabled !== false;
  form.elements.transfer_only.checked = Boolean(a.transfer_to);
  $("#af-transfer-world").textContent = a.transfer_to || state.world;
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

async function renderTransferGuide() {
  const world = state.world;
  for (const el of document.querySelectorAll("[data-world]")) el.textContent = world;
  $("#transfer-guide").hidden = !world;
  if (!world) return;
  const body = $("#tg-body");
  let t;
  try {
    t = await transferSources(world);
  } catch {
    body.innerHTML = '<p class="muted">Couldn\'t load the world list from TibiaData. Try again later.</p>';
    return;
  }
  if (!t || world !== state.world) return;
  const { to, worlds, from } = t;
  $("#tg-count").textContent = to.transfer_type === "blocked" ? "Transfers closed" : `${from.size - 1} of ${worlds.length - 1} worlds`;

  const pvpFrom = {
    0: "any PvP type (Optional, Open, Retro Open, Hardcore, Retro Hardcore)",
    1: "Open, Retro Open, Hardcore and Retro Hardcore PvP worlds. Not from Optional PvP",
    2: "Hardcore and Retro Hardcore PvP worlds only",
  }[PVP_RANK[to.pvp_type]] || "worlds with the same or harsher PvP";
  const rules = [
    to.transfer_type === "blocked"
      ? `<li class="rule-no"><b>${esc(world)} is blocked for transfers right now.</b> Only characters already on ${esc(world)} can play there. That can change, so check again later.</li>`
      : to.transfer_type === "locked"
        ? `<li><b>${esc(world)} is a locked world.</b> Characters can move in from anywhere, but once there they can only move on to other locked worlds.</li>`
        : `<li><b>${esc(world)} accepts transfers.</b></li>`,
    `<li><b>PvP:</b> ${esc(world)} is ${esc(to.pvp_type)}, so characters can come from ${pvpFrom}. A character can only move to the same or a milder PvP type.</li>`,
    to.battleye_date === "release"
      ? `<li><b>BattlEye:</b> ${esc(world)} has been protected since launch (green shield), so characters must also come from a world protected since launch.</li>`
      : `<li><b>BattlEye:</b> ${esc(world)} wasn't protected from launch (yellow shield), so BattlEye doesn't limit where characters can come from.</li>`,
  ];

  const byRegion = {};
  for (const w of worlds) {
    if (!from.has(w.name)) continue;
    (byRegion[w.location] ||= []).push(w);
  }
  const regions = Object.keys(byRegion).sort((a, b) => (a === to.location ? -1 : b === to.location ? 1 : a.localeCompare(b)));
  const worldList = to.transfer_type === "blocked" ? "" : `
    <h3 class="guide-h">Worlds characters can come from</h3>
    ${regions.map((r) => `
      <div class="region"><span class="region-name">${esc(r)}${r === to.location ? " · same region, best ping" : ""}</span>
        <div class="chips">${byRegion[r].map((w) => `<span class="chip${w.name === world ? " chip-ok" : ""}" title="${esc(w.pvp_type)}">${esc(w.name)}</span>`).join("")}</div>
      </div>`).join("")}
    <button class="btn btn-primary btn-small" data-transfer-alert>Create an alert for characters that can move to ${esc(world)}</button>`;

  body.innerHTML = `
    <ul class="rules">${rules.join("")}</ul>
    ${worldList}
    <h3 class="guide-h">Before you bid, check the auction page</h3>
    <ul class="checklist">
      <li><b>Last transfer:</b> a character that moved worlds in the last 6 months needs an Express transfer, which costs more.</li>
      <li><b>No house, not a guild leader, no red or black skull, no open Market offers with Tibia Coins.</b> All of these block a transfer until they're cleared.</li>
      <li><b>Left Rookgaard or Newhaven:</b> characters still there can't transfer.</li>
      <li><b>Extra cost:</b> the transfer is bought separately in the Store with Tibia Coins, on top of your winning bid.</li>
    </ul>
    <p class="muted small">Rules from the <a href="${TRANSFER_MANUAL}" target="_blank" rel="noopener">Tibia manual</a> and world details from TibiaData. CipSoft can change them, so confirm in the Store before you buy.</p>`;
}

// ---------- Settings ----------

async function fillWorldSelect(select, emptyLabel) {
  const current = select.value;
  try {
    const worlds = await loadWorlds();
    select.innerHTML = `<option value="">${emptyLabel}</option>` + worlds.map((w) => `<option>${esc(w.name)}</option>`).join("");
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

async function applySettings() {
  const sel = $("#world-switch");
  sel.hidden = !state.world;
  sel.innerHTML = `<option>${esc(state.world)}</option>`;
  await fillWorldSelect(sel, "");
  sel.querySelector('option[value=""]')?.remove();
  sel.value = state.world;
  const townSel = $("#f-town");
  townSel.innerHTML = '<option value="">All towns</option>' + state.settings.towns.map((t) => `<option>${esc(t)}</option>`).join("");
}

// ---------- Wiring ----------

function showTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  $("#tab-houses").hidden = name !== "houses";
  $("#tab-chars").hidden = name !== "chars";
  if (name === "chars" && bazaarLive === null) checkBazaar();
  if (name === "chars") renderTransferGuide();
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
  $("#world-switch").onchange = (e) => {
    state.world = e.target.value;
    loadHouses();
    renderTransferGuide();
    renderAuctions();
  };
  $("#settings-form").onsubmit = async (e) => {
    const f = e.target;
    const towns = [...f.querySelectorAll('input[name="town"]:checked')].map((x) => x.value);
    if (!f.elements.world.value || !towns.length) {
      e.preventDefault();
      alert("Pick a world and at least one town.");
      return;
    }
    state.settings = { world: f.elements.world.value, towns };
    state.world = state.settings.world;
    try { await store.save("settings", state.settings); } catch (err) { alert(err.message); }
    applySettings();
    loadHouses();
  };

  $("#new-alert").onclick = () => openAlertForm();
  $("#tg-body").onclick = (e) => {
    if (!e.target.closest("[data-transfer-alert]")) return;
    openAlertForm(null, { world: "", transfer_to: state.world, label: `Can move to ${state.world}` });
  };
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
    a.transfer_to = f.elements.transfer_only.checked ? $("#af-transfer-world").textContent : "";
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
  state.world = state.settings.world;
  $("#storage-mode").textContent = state.synced ? "" : " Settings are saved in this browser only.";
  applySettings();
  renderAlerts();

  let tab = "houses";
  try { tab = localStorage.getItem("tt.tab") || tab; } catch { /* ignore */ }
  showTab(tab);

  if (state.world) loadHouses();
  else {
    $("#houses-summary").textContent = "Choose your world to see its house auctions.";
    $("#houses-grid").innerHTML = '<div class="empty">No world selected yet. <button class="btn btn-primary btn-small" id="pick-world">Choose world</button></div>';
    $("#pick-world").onclick = openSettings;
    openSettings();
  }
}

init();
