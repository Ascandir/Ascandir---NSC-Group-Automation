/**
 * Ascandir - NSC Group Automation
 * Foundry VTT v13/v14 · dnd5e 5.x/6.x
 *
 * NSC-Gruppen (Actor-Typ "group") sammeln die besten Werte ihrer Mitglieder.
 * Der DM legt Missionen an, entsendet Gruppen und löst die Missionen über das
 * Missionsboard auf. Chance, Wurf, Belohnung und Folgen laufen automatisch.
 */

const MODULE_ID = "ascandir-nsc-group-automation";
const DAY = 86400;
const INJURED = "nga-injured";
const DEAD = "dead";
const SYNC_STATUSES = [DEAD, INJURED];
const OBJECT_TYPE = `${MODULE_ID}.customobject`;
const OBJECT_KINDS = { missionboard: "Missionsboard" };
const { ApplicationV2 } = foundry.applications.api;

/* ------------------------------------------------------------------ */
/*  Hilfsfunktionen                                                    */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const pct = (p) => `${Math.round(p * 100)} %`;
const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const fmtLevel = (l) => (Math.round(l * 10) / 10).toLocaleString("de-DE");
const setting = (key, fallback) => {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
};
const loc = (s) => (s ? game.i18n.localize(s) : "");
const UNITS = { hours: { label: "Stunden", sec: 3600 }, days: { label: "Tage", sec: DAY }, weeks: { label: "Wochen", sec: 7 * DAY } };
const repeatSeconds = (m) => Math.max(0, num(m.repeat?.value, 0)) * (UNITS[m.repeat?.unit]?.sec ?? DAY);
function fmtDuration(sec) {
  if (sec >= DAY) return `${Math.ceil(sec / DAY)} Tag(en)`;
  return `${Math.max(1, Math.ceil(sec / 3600))} Stunde(n)`;
}
const range = (min, max) => (num(min) === num(max) ? `${num(min)}` : `${num(min)}–${num(max)}`);

const TIERS = {
  open:      { label: "Offen",       css: "open" },
  traveling: { label: "Unterwegs",   css: "traveling" },
  success:   { label: "Erfolg",      css: "success" },
  partial:   { label: "Teilerfolg",  css: "partial" },
  failure:   { label: "Misserfolg",  css: "failure" },
  disaster:  { label: "Katastrophe", css: "disaster" }
};

/* ------------------------------------------------------------------ */
/*  Missionsdaten                                                      */
/* ------------------------------------------------------------------ */

function defaultMission() {
  return {
    id: foundry.utils.randomID(),
    name: "Neue Mission",
    description: "",
    playerDescription: "",
    playerVisible: false,
    level: 1,
    checks: [],
    reward: { gpMin: 0, gpMax: 0, guaranteed: [], possible: [] },
    partial: { enabled: true, margin: 3, percent: 50 },
    failure: { injuryDays: 3, hpLoss: 25 },
    allowDeath: false,
    repeat: { enabled: false, value: 7, unit: "days" },
    availableAt: null,
    lastResult: null,
    groupId: "",
    status: "open",
    sentAt: null,
    result: null,
    created: Date.now()
  };
}

function normalizeMission(m) {
  const src = foundry.utils.deepClone(m ?? {});
  // Altes Format (v0.1.0): gp + items
  if (src.reward && ("gp" in src.reward || "items" in src.reward)) {
    const gp = num(src.reward.gp);
    src.reward.gpMin ??= gp;
    src.reward.gpMax ??= gp;
    src.reward.guaranteed ??= (src.reward.items ?? []).map((it) => ({
      uuid: it.uuid, name: it.name, img: it.img, min: num(it.quantity, 1), max: num(it.quantity, 1)
    }));
    delete src.reward.gp;
    delete src.reward.items;
  }
  return foundry.utils.mergeObject(defaultMission(), src, { inplace: false });
}

function getMissions() {
  const raw = game.settings.get(MODULE_ID, "missions") ?? {};
  const out = {};
  for (const [id, m] of Object.entries(raw)) out[id] = normalizeMission({ ...m, id });
  return out;
}

async function saveMissions(missions) {
  await game.settings.set(MODULE_ID, "missions", missions);
}

/* ------------------------------------------------------------------ */
/*  Proben (Fertigkeiten, Attribute, Rettungswürfe)                    */
/* ------------------------------------------------------------------ */

function allRefs() {
  const refs = [];
  for (const k of Object.keys(CONFIG.DND5E.skills ?? {})) refs.push(`skill:${k}`);
  for (const k of Object.keys(CONFIG.DND5E.abilities ?? {})) refs.push(`ability:${k}`);
  for (const k of Object.keys(CONFIG.DND5E.abilities ?? {})) refs.push(`save:${k}`);
  return refs;
}

function checkLabel(ref) {
  const [type, key] = String(ref).split(":");
  if (type === "skill") return loc(CONFIG.DND5E.skills?.[key]?.label) || key;
  const ab = loc(CONFIG.DND5E.abilities?.[key]?.label) || key;
  return type === "save" ? `Rettungswurf ${ab}` : `${ab}-Wurf`;
}

function checkOptions(selected) {
  const groups = [
    ["Fertigkeiten", "skill", CONFIG.DND5E.skills],
    ["Attributswürfe", "ability", CONFIG.DND5E.abilities],
    ["Rettungswürfe", "save", CONFIG.DND5E.abilities]
  ];
  return groups.map(([label, type, cfg]) => {
    const opts = Object.keys(cfg ?? {})
      .map((k) => ({ ref: `${type}:${k}`, label: checkLabel(`${type}:${k}`) }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"))
      .map((o) => `<option value="${o.ref}" ${o.ref === selected ? "selected" : ""}>${esc(o.label)}</option>`)
      .join("");
    return `<optgroup label="${label}">${opts}</optgroup>`;
  }).join("");
}

function valueFor(actor, ref) {
  const [type, key] = String(ref).split(":");
  const s = actor.system ?? {};
  if (type === "skill") {
    const sk = s.skills?.[key];
    if (!sk) return null;
    return num(sk.total ?? sk.mod, 0);
  }
  const ab = s.abilities?.[key];
  if (!ab) return null;
  if (type === "ability") return num(ab.mod, 0);
  if (type === "save") {
    const sv = ab.save;
    if (typeof sv === "number") return sv;
    if (sv && typeof sv === "object") return num(sv.value ?? sv.total ?? ab.mod, 0);
    return num(ab.mod, 0);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Status (tot / verletzt) – auf Actor UND allen Token                */
/* ------------------------------------------------------------------ */

/** Der Welt-Actor plus alle nicht verknüpften Token dieses Actors in allen Szenen. */
function actorsFor(base) {
  const list = [base];
  for (const scene of game.scenes) {
    for (const t of scene.tokens) {
      if (!t.actorLink && t.actorId === base.id && t.actor) list.push(t.actor);
    }
  }
  return list;
}

function statusEffectData(id, extra = {}) {
  const cfg = CONFIG.statusEffects.find((s) => s.id === id) ?? {};
  const data = {
    name: loc(cfg.name ?? cfg.label) || id,
    img: cfg.img ?? cfg.icon ?? "icons/svg/skull.svg",
    statuses: [id]
  };
  if (id === DEAD) data.flags = { core: { overlay: true } };
  return foundry.utils.mergeObject(data, extra, { inplace: false });
}

const findStatus = (actor, id) => actor.effects.find((e) => e.statuses?.has?.(id));

async function addStatus(base, id, extra = {}) {
  for (const a of actorsFor(base)) {
    const existing = findStatus(a, id);
    if (existing) {
      if (Object.keys(extra).length) await existing.update(extra, { ngaSync: true });
    } else {
      await a.createEmbeddedDocuments("ActiveEffect", [statusEffectData(id, extra)], { ngaSync: true });
    }
  }
}

async function removeStatus(base, id) {
  for (const a of actorsFor(base)) {
    const ids = a.effects.filter((e) => e.statuses?.has?.(id)).map((e) => e.id);
    if (ids.length) await a.deleteEmbeddedDocuments("ActiveEffect", ids, { ngaSync: true });
  }
}

async function setHP(base, fn) {
  for (const a of actorsFor(base)) {
    const hp = a.system?.attributes?.hp;
    if (!hp) continue;
    const next = Math.max(0, Math.round(fn(num(hp.value), num(hp.max))));
    if (next !== num(hp.value)) await a.update({ "system.attributes.hp.value": next });
  }
}

function isDead(actor) {
  return !!actor.statuses?.has?.(DEAD);
}

/** Verbleibende Verletzungstage: 0 = nicht verletzt, Infinity = ohne Ablauf. */
function injuryDays(actor) {
  const e = findStatus(actor, INJURED);
  if (!e) return 0;
  const until = e.getFlag(MODULE_ID, "until");
  if (!until) return Infinity;
  const rest = until - game.time.worldTime;
  return rest > 0 ? Math.ceil(rest / DAY) : 0;
}

/* ------------------------------------------------------------------ */
/*  Gruppen                                                            */
/* ------------------------------------------------------------------ */

function getGroups() {
  return game.actors.filter((a) => a.type === "group")
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

function getMembers(group) {
  const raw = group?.system?.members;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Array.from(raw);
  const out = [];
  for (const m of list) {
    let a = m?.actor ?? m;
    if (typeof a === "string") a = game.actors.get(a) ?? fromUuidSync(a);
    if (a?.documentName === "Actor" && !out.includes(a)) out.push(a);
  }
  return out;
}

function isGroupMember(actorId) {
  return getGroups().some((g) => getMembers(g).some((a) => a.id === actorId));
}

function getLevel(actor) {
  const cr = actor.system?.details?.cr;
  if (cr !== undefined && cr !== null && cr !== "" && Number.isFinite(Number(cr))) return Number(cr);
  return num(actor.system?.details?.level, 0);
}

function groupStats(group) {
  const all = getMembers(group);
  const dead = all.filter(isDead);
  const injured = all.filter((a) => !isDead(a) && injuryDays(a) > 0);
  const members = all.filter((a) => !dead.includes(a) && !injured.includes(a));
  const best = {};
  for (const ref of allRefs()) {
    let top = null;
    for (const a of members) {
      const v = valueFor(a, ref);
      if (v === null) continue;
      if (!top || v > top.value) top = { value: v, actor: a.name };
    }
    best[ref] = top;
  }
  const level = members.length ? members.reduce((s, a) => s + getLevel(a), 0) / members.length : 0;
  return { all, members, injured, dead, best, level };
}

/** Mission, auf der die Gruppe gerade unterwegs ist. */
function travelingMission(groupId, missions = getMissions()) {
  return Object.values(missions).find((m) => m.status === "traveling" && m.groupId === groupId) ?? null;
}

/* ------------------------------------------------------------------ */
/*  Berechnung                                                         */
/* ------------------------------------------------------------------ */

function computeChance(mission, group) {
  const stats = groupStats(group);
  if (!stats.members.length) return { error: "Die Gruppe hat keine einsatzbereiten Mitglieder." };

  const parts = mission.checks.map((c) => {
    const best = stats.best[c.ref];
    const bonus = best?.value ?? 0;
    const dc = num(c.dc, 15);
    const p = clamp((21 - dc + bonus) / 20, 0, 1);
    return { ref: c.ref, label: checkLabel(c.ref), dc, bonus, who: best?.actor ?? "–", p };
  });

  const base = parts.length ? parts.reduce((s, x) => s + x.p, 0) / parts.length : 0.5;
  const step = num(game.settings.get(MODULE_ID, "levelStep"), 5) / 100;
  const levelDiff = stats.level - num(mission.level, 0);
  const levelMod = levelDiff * step;
  const chance = clamp(base + levelMod, 0.05, 0.95);
  const dc = clamp(21 - Math.round(chance * 20), 2, 20);
  return { stats, parts, base, levelDiff, levelMod, chance, dc };
}

/** Menge in der Spanne – jeder Punkt Überschuss schiebt das Ergebnis Richtung Maximum. */
function rollAmount(min, max, surplus) {
  min = Math.max(0, num(min));
  max = Math.max(min, num(max));
  const bonus = surplus * num(game.settings.get(MODULE_ID, "surplusStep"), 5) / 100;
  const f = clamp(Math.random() + bonus, 0, 1);
  return min + Math.round(f * (max - min));
}

/* ------------------------------------------------------------------ */
/*  Belohnung                                                          */
/* ------------------------------------------------------------------ */

async function giveItem(group, uuid, qty) {
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  const existing = group.items.find((i) => i.name === doc.name && i.type === doc.type);
  if (existing && "quantity" in (existing.system ?? {})) {
    await existing.update({ "system.quantity": num(existing.system.quantity) + qty });
  } else {
    const data = doc.toObject();
    delete data._id;
    data.system ??= {};
    data.system.quantity = qty;
    await group.createEmbeddedDocuments("Item", [data]);
  }
  return doc.name;
}

async function giveGold(group, gp) {
  if (gp <= 0) return 0;
  const cur = group.system?.currency;
  if (!cur || !("gp" in cur)) {
    ui.notifications.warn(`${group.name} hat kein Geldfeld – Gold bitte manuell vergeben (${gp} GM).`);
    return 0;
  }
  await group.update({ "system.currency.gp": num(cur.gp) + gp });
  return gp;
}

/**
 * full = true: voller Erfolg (Gold, garantierter + möglicher Loot, Überschuss zählt)
 * full = false: Teilerfolg (Prozent von Gold und garantiertem Loot, kein möglicher Loot)
 */
async function grantRewards(group, m, surplus, full) {
  const factor = full ? 1 : num(m.partial.percent, 50) / 100;
  const log = { gp: 0, items: [], rolls: [] };

  const gp = Math.floor(rollAmount(m.reward.gpMin, m.reward.gpMax, surplus) * factor);
  log.gp = await giveGold(group, gp);

  for (const it of m.reward.guaranteed) {
    const qty = Math.floor(rollAmount(it.min, it.max, surplus) * factor);
    if (qty <= 0) continue;
    const name = await giveItem(group, it.uuid, qty);
    if (name) log.items.push(`${qty}× ${name}`);
    else ui.notifications.warn(`Belohnung "${it.name}" wurde nicht mehr gefunden.`);
  }

  if (full) {
    const step = num(game.settings.get(MODULE_ID, "surplusStep"), 5);
    for (const it of m.reward.possible) {
      const chance = clamp(num(it.chance, 50) + surplus * step, 0, 100);
      const d100 = Math.floor(Math.random() * 100) + 1;
      const hit = d100 <= chance;
      let line = `${esc(it.name)}: ${chance} % → W100 ${d100}`;
      if (hit) {
        const qty = rollAmount(it.min, it.max, surplus);
        const name = qty > 0 ? await giveItem(group, it.uuid, qty) : null;
        if (name) log.items.push(`${qty}× ${name}`);
        line += ` ✔ ${qty}×`;
      } else {
        line += " ✘";
      }
      log.rolls.push(line);
    }
  }
  return log;
}

/* ------------------------------------------------------------------ */
/*  Folgen bei Misserfolg                                              */
/* ------------------------------------------------------------------ */

async function injureMembers(stats, m, disaster) {
  const days = num(m.failure.injuryDays, 3) * (disaster ? 2 : 1);
  const lossPct = clamp(num(m.failure.hpLoss, 25) * (disaster ? 2 : 1), 0, 100);
  const log = [];
  for (const a of stats.members) {
    const hpBefore = num(a.system?.attributes?.hp?.value);
    await setHP(a, (v, max) => Math.max(1, v - Math.round(max * lossPct / 100)));
    const hpAfter = num(a.system?.attributes?.hp?.value);
    if (days > 0) {
      await addStatus(a, INJURED, { flags: { [MODULE_ID]: { until: game.time.worldTime + days * DAY } } });
    }
    log.push(`${esc(a.name)}: −${hpBefore - hpAfter} TP${days > 0 ? `, ${days} Tag(e) verletzt` : ""}`);
  }
  return { days, lossPct, log };
}

async function killRandomMember(stats) {
  const victim = stats.members[Math.floor(Math.random() * stats.members.length)];
  if (!victim) return null;
  await setHP(victim, () => 0);
  await removeStatus(victim, INJURED);
  await addStatus(victim, DEAD);
  return victim.name;
}

/* ------------------------------------------------------------------ */
/*  Entsenden, Zurückrufen, Auflösen                                   */
/* ------------------------------------------------------------------ */

/**
 * Gruppe auf Mission entsenden. Gibt bei Problemen einen Fehlertext zurück.
 * @param {string} id          Missions-ID
 * @param {object} [opts]
 * @param {string} [opts.groupId]   Gruppe (sonst die am Board gewählte)
 * @param {User}   [opts.byPlayer]  Anfrage eines Spielers – nur Freigegebenes erlaubt
 */
async function sendGroup(id, { groupId, byPlayer } = {}) {
  const fail = (msg) => {
    if (!byPlayer) ui.notifications.warn(msg);
    return msg;
  };
  const missions = getMissions();
  const m = missions[id];
  if (!m) return fail("Diese Mission gibt es nicht mehr.");
  if (m.status !== "open") return fail(`„${m.name}“ ist gerade nicht offen.`);
  if (byPlayer && !m.playerVisible) return fail("Diese Mission ist nicht freigegeben.");
  const group = game.actors.get(groupId ?? m.groupId);
  if (!group) return fail("Bitte zuerst eine Gruppe auswählen.");
  if (byPlayer && !groupVisible(group)) return fail("Diese Gruppe ist nicht freigegeben.");
  const busy = travelingMission(group.id, missions);
  if (busy) return fail(`${group.name} ist bereits unterwegs.`);
  if (!groupStats(group).members.length) return fail(`${group.name} hat keine einsatzbereiten Mitglieder.`);
  m.groupId = group.id;
  m.status = "traveling";
  m.sentAt = game.time.worldTime;
  missions[id] = m;
  await saveMissions(missions);
  const who = byPlayer ? ` (von ${byPlayer.name})` : "";
  ui.notifications.info(`${group.name} wurde auf „${m.name}“ entsandt${who}.`);
  return null;
}

/* ------------------------------------------------------------------ */
/*  Socket: Spieler bitten den DM-Client ums Entsenden                 */
/* ------------------------------------------------------------------ */

const SOCKET = `module.${MODULE_ID}`;

function isResponsibleGM() {
  return game.user.isGM && game.users.activeGM?.id === game.user.id;
}

async function onSocket(data) {
  if (!data?.action) return;
  if (data.action === "sendGroup" && isResponsibleGM()) {
    const user = game.users.get(data.userId);
    if (!user) return;
    const error = await sendGroup(data.missionId, { groupId: data.groupId, byPlayer: user });
    game.socket.emit(SOCKET, { action: "sendGroupResult", userId: user.id, error });
  } else if (data.action === "sendGroupResult" && data.userId === game.user.id) {
    if (data.error) ui.notifications.warn(data.error);
    else ui.notifications.info("Die Gruppe ist aufgebrochen.");
  }
}

function requestSendGroup(missionId, groupId) {
  if (!game.users.activeGM) return ui.notifications.warn("Es ist kein DM online – Entsenden ist gerade nicht möglich.");
  if (!groupId) return ui.notifications.warn("Bitte zuerst eine Gruppe auswählen.");
  game.socket.emit(SOCKET, { action: "sendGroup", missionId, groupId, userId: game.user.id });
}

async function recallGroup(id) {
  const missions = getMissions();
  const m = missions[id];
  if (!m || m.status !== "traveling") return;
  m.status = "open";
  m.sentAt = null;
  await saveMissions(missions);
}

async function resolveMission(id) {
  if (!game.user.isGM) return ui.notifications.warn("Nur der DM kann Missionen auflösen.");
  const missions = getMissions();
  const m = missions[id];
  if (!m) return;
  if (m.status !== "traveling") return ui.notifications.warn("Die Gruppe muss zuerst entsandt werden.");
  const group = game.actors.get(m.groupId);
  if (!group) return ui.notifications.warn("Die entsandte Gruppe existiert nicht mehr.");

  const calc = computeChance(m, group);
  if (calc.error) return ui.notifications.warn(calc.error);

  const roll = await new Roll("1d20").evaluate();
  const r = roll.total;

  let tier;
  if (r >= calc.dc) tier = "success";
  else if (r === 1 || r <= calc.dc - 10) tier = "disaster";
  else if (m.partial.enabled && r >= calc.dc - num(m.partial.margin, 3)) tier = "partial";
  else tier = "failure";

  const surplus = Math.max(0, r - calc.dc);
  const result = {
    roll: r, dc: calc.dc, chance: calc.chance, surplus, groupName: group.name,
    gp: 0, items: [], lootRolls: [], injuries: [], injuryDays: 0, deceased: null,
    worldTime: game.time.worldTime
  };

  if (tier === "success" || tier === "partial") {
    const log = await grantRewards(group, m, tier === "success" ? surplus : 0, tier === "success");
    result.gp = log.gp; result.items = log.items; result.lootRolls = log.rolls;
  } else {
    const inj = await injureMembers(calc.stats, m, tier === "disaster");
    result.injuries = inj.log;
    result.injuryDays = inj.days;
    if (tier === "disaster" && m.allowDeath) result.deceased = await killRandomMember(calc.stats);
  }

  m.status = tier;
  m.result = result;
  m.availableAt = m.repeat?.enabled ? game.time.worldTime + repeatSeconds(m) : null;
  missions[id] = m;
  await saveMissions(missions);
  await postResult(m, group, calc, roll, tier, result);
}

async function postResult(m, group, calc, roll, tier, res) {
  const rows = calc.parts.map((p) => `
    <tr><td>${esc(p.label)}</td><td>${p.dc}</td><td>${sign(p.bonus)} <small>(${esc(p.who)})</small></td><td>${pct(p.p)}</td></tr>`).join("");

  const out = [];
  if (tier === "success" || tier === "partial") {
    const got = [];
    if (res.gp) got.push(`${res.gp} GM`);
    got.push(...res.items.map(esc));
    out.push(`<p><strong>Beute für ${esc(group.name)}:</strong> ${got.length ? got.join(", ") : "nichts"}</p>`);
    if (res.lootRolls.length) out.push(`<p class="nga-loot"><strong>Zusatz-Loot</strong><br>${res.lootRolls.join("<br>")}</p>`);
    if (tier === "success" && res.surplus) out.push(`<p><em>Überschuss ${res.surplus} → bessere Beute.</em></p>`);
    if (tier === "partial") out.push(`<p><em>Teilerfolg – nur ${num(m.partial.percent, 50)} % der Beute, kein Zusatz-Loot.</em></p>`);
  }
  if (res.injuries.length) out.push(`<p><strong>Verletzungen</strong><br>${res.injuries.join("<br>")}</p>`);
  if (res.deceased) out.push(`<p class="nga-death"><strong>☠ ${esc(res.deceased)}</strong> ist auf der Mission gestorben.</p>`);

  const content = `
  <div class="nga-chat">
    <h3>Mission: ${esc(m.name)}</h3>
    <p><strong>Gruppe:</strong> ${esc(group.name)} · Ø-Stufe ${fmtLevel(calc.stats.level)} gegen Missionsstufe ${num(m.level)}</p>
    ${calc.parts.length ? `<table><thead><tr><th>Probe</th><th>SG</th><th>Bester</th><th>Chance</th></tr></thead><tbody>${rows}</tbody></table>` : `<p><em>Keine Proben hinterlegt – Grundchance 50 %.</em></p>`}
    <p>Grundchance ${pct(calc.base)} · Stufenunterschied ${sign(Math.round(calc.levelDiff * 10) / 10)} → ${sign(Math.round(calc.levelMod * 100))} %</p>
    <p class="nga-summary"><strong>Erfolgschance ${pct(calc.chance)}</strong> → Ziel-SG <strong>${calc.dc}</strong></p>
    <p class="nga-summary">Wurf: <strong>${roll.total}</strong> <span class="nga-badge ${TIERS[tier].css}">${TIERS[tier].label}</span></p>
    ${out.join("")}
  </div>`;

  const whisper = game.settings.get(MODULE_ID, "publicResults")
    ? []
    : game.users.filter((u) => u.isGM).map((u) => u.id);

  await ChatMessage.create({
    speaker: { alias: "Missionsboard" },
    content,
    rolls: [roll],
    whisper,
    sound: CONFIG.sounds?.dice
  });
}

/* ------------------------------------------------------------------ */
/*  Missionsboard                                                      */
/* ------------------------------------------------------------------ */

let boardApp = null;
let playerBoardApp = null;

/** DM: volles Board · Spieler: Ansicht mit freigegebenen Missionen und Gruppen */
function openBoard() {
  if (!game.user.isGM) return openPlayerBoard();
  boardApp ??= new MissionBoard();
  boardApp.render({ force: true });
  return boardApp;
}

function openPlayerBoard() {
  playerBoardApp ??= new PlayerBoard();
  playerBoardApp.render({ force: true });
  return playerBoardApp;
}

const groupVisible = (g) => !!g?.getFlag(MODULE_ID, "playerVisible");

let refreshTimer = null;
function refreshBoard() {
  if (!boardApp?.rendered && !playerBoardApp?.rendered) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (boardApp?.rendered) boardApp.render();
    if (playerBoardApp?.rendered) playerBoardApp.render();
  }, 100);
}

function repeatInfo(m) {
  if (!m.repeat?.enabled) return "";
  const every = `${num(m.repeat.value)} ${UNITS[m.repeat.unit]?.label ?? "Tage"}`;
  if (m.availableAt && !["open", "traveling"].includes(m.status)) {
    const rest = m.availableAt - game.time.worldTime;
    return `<br><small class="nga-repeat" title="Wiederholbar alle ${every}"><i class="fa-solid fa-arrows-rotate"></i> neu in ${fmtDuration(Math.max(0, rest))}</small>`;
  }
  return `<br><small class="nga-repeat"><i class="fa-solid fa-arrows-rotate"></i> alle ${every}</small>`;
}

function rewardText(m) {
  const parts = [];
  if (num(m.reward.gpMax)) parts.push(`${range(m.reward.gpMin, m.reward.gpMax)} GM`);
  for (const it of m.reward.guaranteed) parts.push(`${range(it.min, it.max)}× ${esc(it.name)}`);
  for (const it of m.reward.possible) parts.push(`<span class="nga-possible">${range(it.min, it.max)}× ${esc(it.name)} (${num(it.chance)} %)</span>`);
  return parts.length ? parts.join("<br>") : "<em>keine</em>";
}

function visibilityButton(action, data, visible) {
  return `<button type="button" class="nga-visibility ${visible ? "on" : ""}" data-action="${action}" ${data}
    title="${visible ? "Für Spieler sichtbar – klicken zum Verbergen" : "Für Spieler verborgen – klicken zum Freigeben"}">
    <i class="fa-solid ${visible ? "fa-eye" : "fa-eye-slash"}"></i></button>`;
}

function memberRow(a, gm = true) {
  const hp = a.system?.attributes?.hp;
  const hpText = hp && gm ? ` · ${num(hp.value)}/${num(hp.max)} TP` : "";
  let state;
  let buttons = "";
  if (isDead(a)) {
    state = `<span class="nga-badge disaster">tot</span>`;
    buttons = `<button type="button" data-action="reviveMember" data-actor="${a.id}" title="Wiederbeleben (1 TP)"><i class="fa-solid fa-heart-pulse"></i></button>`;
  } else {
    const d = injuryDays(a);
    if (d > 0) {
      state = `<span class="nga-badge failure">verletzt${d === Infinity ? "" : ` · ${d} T.`}</span>`;
      buttons = `
        <button type="button" data-action="injuryMinus" data-actor="${a.id}" title="1 Tag weniger"><i class="fa-solid fa-minus"></i></button>
        <button type="button" data-action="injuryPlus" data-actor="${a.id}" title="1 Tag mehr"><i class="fa-solid fa-plus"></i></button>
        <button type="button" data-action="healMember" data-actor="${a.id}" title="Verletzung entfernen"><i class="fa-solid fa-bandage"></i></button>`;
    } else {
      state = `<span class="nga-badge success">bereit</span>`;
    }
  }
  return `<li class="nga-member">
    <span class="nga-member-name">${esc(a.name)} <small>HG ${fmtLevel(getLevel(a))}${hpText}</small></span>
    ${state}<span class="nga-member-btns">${gm ? buttons : ""}</span></li>`;
}

class MissionBoard extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-board`,
    classes: ["ascandir-nga", "nga-framed"],
    window: { title: "Missionsboard", icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 1100, height: 780 },
    actions: {
      newMission: this._onNew,
      editMission: this._onEdit,
      deleteMission: this._onDelete,
      sendGroup: this._onSend,
      recallGroup: this._onRecall,
      resolveMission: this._onResolve,
      resetMission: this._onReset,
      reviveMember: this._onRevive,
      healMember: this._onHeal,
      injuryMinus: this._onInjuryMinus,
      injuryPlus: this._onInjuryPlus,
      toggleMissionVisible: this._onToggleMissionVisible,
      toggleGroupVisible: this._onToggleGroupVisible
    }
  };

  async _renderHTML() {
    const groups = getGroups();
    const missions = getMissions();
    const missionList = Object.values(missions).sort((a, b) => a.created - b.created);

    const groupHtml = groups.length ? groups.map((g) => {
      const st = groupStats(g);
      const trip = travelingMission(g.id, missions);
      const status = trip
        ? `<span class="nga-badge traveling">unterwegs</span><small>${esc(trip.name)}</small>`
        : st.members.length
          ? `<span class="nga-badge success">einsatzbereit</span>`
          : `<span class="nga-badge failure">nicht einsatzbereit</span>`;
      const bestRows = allRefs().map((ref) => {
        const b = st.best[ref];
        return b ? `<li><span>${esc(checkLabel(ref))}</span><span>${sign(b.value)} <small>${esc(b.actor)}</small></span></li>` : "";
      }).join("");
      return `
        <div class="nga-group nga-parchment nga-pinned">
          <div class="nga-group-head">
            <img src="${esc(g.img)}" alt="">
            <div class="nga-group-name"><strong>${esc(g.name)}</strong><br>
              <small>${st.members.length} bereit · ${st.injured.length} verletzt · ${st.dead.length} tot · Ø-Stufe ${fmtLevel(st.level)}</small></div>
            <div class="nga-group-status">${status}</div>
            ${visibilityButton("toggleGroupVisible", `data-group="${g.id}"`, groupVisible(g))}
          </div>
          <details ${st.injured.length || st.dead.length ? "open" : ""}>
            <summary>Mitglieder</summary>
            <ul class="nga-members">${st.all.map((a) => memberRow(a)).join("") || "<li><em>keine Mitglieder</em></li>"}</ul>
          </details>
          <details>
            <summary>Beste Werte</summary>
            <ul class="nga-best">${bestRows}</ul>
          </details>
        </div>`;
    }).join("") : `<p class="nga-empty">Noch keine Gruppen. Lege im Actors-Tab einen Actor vom Typ <strong>Gruppe</strong> an und ziehe deine NSCs hinein.</p>`;

    const groupOptions = (selected) => `<option value="">– Gruppe wählen –</option>` + groups.map((g) => {
      const trip = travelingMission(g.id, missions);
      return `<option value="${g.id}" ${g.id === selected ? "selected" : ""}>${esc(g.name)}${trip ? " (unterwegs)" : ""}</option>`;
    }).join("");

    const missionRows = missionList.length ? missionList.map((m) => {
      const group = game.actors.get(m.groupId);
      const resolved = !["open", "traveling"].includes(m.status);
      let chanceHtml = "–";
      if (!resolved && group) {
        const calc = computeChance(m, group);
        chanceHtml = calc.error
          ? `<span class="nga-warn" title="${esc(calc.error)}">!</span>`
          : `<strong>${pct(calc.chance)}</strong><br><small>Ziel-SG ${calc.dc}</small>`;
      } else if (resolved && m.result) {
        chanceHtml = `${pct(m.result.chance)}<br><small>Wurf ${m.result.roll} / SG ${m.result.dc}</small>`;
      }
      const checks = m.checks.map((c) => `${esc(checkLabel(c.ref))} SG ${num(c.dc, 15)}`).join(" · ") || "<em>keine Proben</em>";

      let groupCell;
      let actions;
      if (m.status === "open") {
        const busy = group && travelingMission(group.id, missions);
        groupCell = `<select class="nga-group-select" data-mission="${m.id}">${groupOptions(m.groupId)}</select>`;
        actions = `<button type="button" class="nga-primary" data-action="sendGroup" data-mission="${m.id}" ${group && !busy ? "" : "disabled"}><i class="fa-solid fa-person-walking-arrow-right"></i> Entsenden</button>`;
      } else if (m.status === "traveling") {
        groupCell = `<strong>${esc(group?.name ?? "–")}</strong>`;
        actions = `
          <button type="button" class="nga-primary" data-action="resolveMission" data-mission="${m.id}"><i class="fa-solid fa-dice-d20"></i> Auflösen</button>
          <button type="button" data-action="recallGroup" data-mission="${m.id}" title="Zurückrufen (ohne Ergebnis)"><i class="fa-solid fa-person-walking-arrow-loop-left"></i></button>`;
      } else {
        groupCell = esc(m.result?.groupName ?? group?.name ?? "–");
        actions = `<button type="button" data-action="resetMission" data-mission="${m.id}" title="Mission wieder öffnen"><i class="fa-solid fa-rotate-left"></i></button>`;
      }

      return `
        <tr class="${TIERS[m.status]?.css ?? ""}">
          <td><strong>${esc(m.name)}</strong> <small>(Stufe ${num(m.level)})</small><br><small class="nga-checks">${checks}</small></td>
          <td>${rewardText(m)}</td>
          <td>${groupCell}</td>
          <td class="nga-center">${chanceHtml}</td>
          <td class="nga-center"><span class="nga-badge ${TIERS[m.status]?.css}">${TIERS[m.status]?.label ?? m.status}</span>${repeatInfo(m)}</td>
          <td class="nga-actions">
            ${actions}
            ${visibilityButton("toggleMissionVisible", `data-mission="${m.id}"`, m.playerVisible)}
            <button type="button" data-action="editMission" data-mission="${m.id}" title="Bearbeiten"><i class="fa-solid fa-pen"></i></button>
            <button type="button" data-action="deleteMission" data-mission="${m.id}" title="Löschen"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>`;
    }).join("") : `<tr><td colspan="6" class="nga-empty">Noch keine Missionen – klicke auf „Neue Mission“.</td></tr>`;

    return `
      <section class="nga-board"><div class="nga-drape" aria-hidden="true"></div>
        <h2 class="nga-sign"><i class="fa-solid fa-people-group"></i> Gruppen</h2>
        <div class="nga-groups">${groupHtml}</div>
        <div class="nga-board-head">
          <h2 class="nga-sign"><i class="fa-solid fa-scroll"></i> Missionen</h2>
          <button type="button" data-action="newMission"><i class="fa-solid fa-plus"></i> Neue Mission</button>
        </div>
        <div class="nga-parchment nga-table-wrap">
          <table class="nga-table">
            <thead><tr><th>Mission</th><th>Belohnung</th><th>Gruppe</th><th>Chance</th><th>Status</th><th></th></tr></thead>
            <tbody>${missionRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelectorAll("select.nga-group-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const missions = getMissions();
        const m = missions[sel.dataset.mission];
        if (!m) return;
        m.groupId = sel.value;
        await saveMissions(missions);
      });
    });
  }

  static _onNew() {
    new MissionEditor(null).render({ force: true });
  }

  static _onEdit(event, target) {
    new MissionEditor(target.dataset.mission).render({ force: true });
  }

  static async _onDelete(event, target) {
    const missions = getMissions();
    const m = missions[target.dataset.mission];
    if (!m) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Mission löschen" },
      content: `<p>Mission <strong>${esc(m.name)}</strong> wirklich löschen?</p>`
    });
    if (!ok) return;
    delete missions[m.id];
    await saveMissions(missions);
  }

  static async _onSend(event, target) {
    await sendGroup(target.dataset.mission);
  }

  static async _onRecall(event, target) {
    await recallGroup(target.dataset.mission);
  }

  static async _onResolve(event, target) {
    target.disabled = true;
    try {
      await resolveMission(target.dataset.mission);
    } finally {
      refreshBoard();
    }
  }

  static async _onReset(event, target) {
    const missions = getMissions();
    const m = missions[target.dataset.mission];
    if (!m) return;
    m.status = "open";
    m.result = null;
    m.sentAt = null;
    m.availableAt = null;
    await saveMissions(missions);
  }

  static async _onRevive(event, target) {
    const a = game.actors.get(target.dataset.actor);
    if (!a) return;
    await removeStatus(a, DEAD);
    await setHP(a, (v) => Math.max(1, v));
    refreshBoard();
  }

  static async _onHeal(event, target) {
    const a = game.actors.get(target.dataset.actor);
    if (a) await removeStatus(a, INJURED);
    refreshBoard();
  }

  static async _onInjuryMinus(event, target) {
    await shiftInjury(target.dataset.actor, -1);
  }

  static async _onInjuryPlus(event, target) {
    await shiftInjury(target.dataset.actor, 1);
  }

  static async _onToggleMissionVisible(event, target) {
    const missions = getMissions();
    const m = missions[target.dataset.mission];
    if (!m) return;
    m.playerVisible = !m.playerVisible;
    await saveMissions(missions);
  }

  static async _onToggleGroupVisible(event, target) {
    const g = game.actors.get(target.dataset.group);
    if (!g) return;
    await g.setFlag(MODULE_ID, "playerVisible", !groupVisible(g));
  }
}

async function shiftInjury(actorId, days) {
  const a = game.actors.get(actorId);
  if (!a) return;
  const e = findStatus(a, INJURED);
  if (!e) return;
  const now = game.time.worldTime;
  const current = e.getFlag(MODULE_ID, "until") || now;
  const until = Math.max(now, current) + days * DAY;
  if (until <= now) await removeStatus(a, INJURED);
  else await addStatus(a, INJURED, { flags: { [MODULE_ID]: { until } } });
  refreshBoard();
}

/* ------------------------------------------------------------------ */
/*  Missions-Editor                                                    */
/* ------------------------------------------------------------------ */

class MissionEditor extends ApplicationV2 {
  constructor(missionId, options = {}) {
    const missions = getMissions();
    const mission = missionId && missions[missionId] ? missions[missionId] : defaultMission();
    super({ id: `${MODULE_ID}-editor-${mission.id}`, ...options });
    this.mission = mission;
  }

  static DEFAULT_OPTIONS = {
    classes: ["ascandir-nga", "ascandir-nga-editor"],
    window: { title: "Mission bearbeiten", icon: "fa-solid fa-pen-to-square", resizable: true },
    position: { width: 680, height: "auto" },
    actions: {
      addCheck: this._onAddCheck,
      removeCheck: this._onRemoveCheck,
      removeItem: this._onRemoveItem,
      saveMission: this._onSave,
      cancel: this._onCancel
    }
  };

  async _renderHTML() {
    const m = this.mission;
    const checks = m.checks.map((c, i) => `
      <div class="nga-check-row" data-index="${i}">
        <select name="check-ref">${checkOptions(c.ref)}</select>
        <label>SG <input type="number" name="check-dc" value="${num(c.dc, 15)}" min="1" max="40"></label>
        <button type="button" data-action="removeCheck" data-index="${i}" title="Entfernen"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join("") || `<p class="nga-empty">Noch keine Proben.</p>`;

    const itemRows = (list, kind) => list.map((it, i) => `
      <div class="nga-item-row" data-kind="${kind}" data-index="${i}">
        <img src="${esc(it.img)}" alt="">
        <span>${esc(it.name)}</span>
        ${kind === "possible" ? `<label>Chance <input type="number" name="chance" value="${num(it.chance, 50)}" min="0" max="100">%</label>` : ""}
        <label>Menge <input type="number" name="min" value="${num(it.min, 1)}" min="0"> bis <input type="number" name="max" value="${num(it.max, 1)}" min="0"></label>
        <button type="button" data-action="removeItem" data-kind="${kind}" data-index="${i}" title="Entfernen"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join("");

    return `
      <div class="nga-editor">
        <div class="form-group"><label>Name</label><input type="text" name="name" value="${esc(m.name)}"></div>
        <div class="form-group"><label>Missionsstufe</label><input type="number" name="level" value="${num(m.level)}" min="0" step="0.5"></div>
        <div class="form-group stacked"><label>Notizen (nur für dich)</label><textarea name="description" rows="2">${esc(m.description)}</textarea></div>
        <div class="form-group stacked"><label>Beschreibung für Spieler</label><textarea name="playerDescription" rows="2">${esc(m.playerDescription)}</textarea></div>

        <fieldset>
          <legend>Benötigte Proben</legend>
          ${checks}
          <button type="button" data-action="addCheck"><i class="fa-solid fa-plus"></i> Probe hinzufügen</button>
        </fieldset>

        <fieldset>
          <legend>Belohnung (geht an die Gruppe)</legend>
          <div class="form-group"><label>Gold (GM) von – bis</label>
            <span class="nga-range"><input type="number" name="gpMin" value="${num(m.reward.gpMin)}" min="0"> bis <input type="number" name="gpMax" value="${num(m.reward.gpMax)}" min="0"></span></div>

          <h4>Garantierter Loot <small>– kommt bei Erfolg immer mit</small></h4>
          ${itemRows(m.reward.guaranteed, "guaranteed")}
          <div class="nga-dropzone" data-kind="guaranteed"><i class="fa-solid fa-box"></i> Gegenstand hierher ziehen</div>

          <h4>Möglicher Loot <small>– wird mit Chance ausgewürfelt</small></h4>
          ${itemRows(m.reward.possible, "possible")}
          <div class="nga-dropzone" data-kind="possible"><i class="fa-solid fa-gem"></i> Gegenstand hierher ziehen</div>

          <p class="hint">Jeder Punkt, den der Wurf über dem Ziel-SG liegt, schiebt die Mengen Richtung Maximum und erhöht die Loot-Chancen (Standard +5 % pro Punkt, in den Moduleinstellungen änderbar).</p>
        </fieldset>

        <fieldset>
          <legend>Teilerfolg &amp; Misserfolg</legend>
          <div class="form-group"><label>Teilerfolg möglich</label><input type="checkbox" name="partial-enabled" ${m.partial.enabled ? "checked" : ""}></div>
          <div class="form-group"><label>Teilerfolg, wenn knapp verfehlt um bis zu</label><input type="number" name="partial-margin" value="${num(m.partial.margin, 3)}" min="1" max="10"></div>
          <div class="form-group"><label>Beute bei Teilerfolg (% von Gold &amp; garantiertem Loot)</label><input type="number" name="partial-percent" value="${num(m.partial.percent, 50)}" min="0" max="100"></div>
          <div class="form-group"><label>TP-Verlust bei Misserfolg (% der max. TP)</label><input type="number" name="hp-loss" value="${num(m.failure.hpLoss, 25)}" min="0" max="100"></div>
          <div class="form-group"><label>Verletzt bei Misserfolg (Tage)</label><input type="number" name="injury-days" value="${num(m.failure.injuryDays, 3)}" min="0"></div>
          <div class="form-group"><label>Bei Katastrophe kann ein NSC sterben</label><input type="checkbox" name="allow-death" ${m.allowDeath ? "checked" : ""}></div>
          <p class="hint">Katastrophe = natürliche 1 oder 10+ unter dem Ziel-SG: doppelter TP-Verlust und doppelte Verletzungsdauer.</p>
        </fieldset>

        <fieldset>
          <legend>Wiederholbar</legend>
          <div class="form-group"><label>Mission erneuert sich von selbst</label><input type="checkbox" name="repeat-enabled" ${m.repeat.enabled ? "checked" : ""}></div>
          <div class="form-group"><label>Wieder verfügbar nach</label>
            <span class="nga-range"><input type="number" name="repeat-value" value="${num(m.repeat.value, 7)}" min="0">
            <select name="repeat-unit">${Object.entries(UNITS).map(([k, u]) => `<option value="${k}" ${k === m.repeat.unit ? "selected" : ""}>${u.label}</option>`).join("")}</select></span></div>
          <p class="hint">Die Zeit läuft ab dem Auflösen über die Spielzeit. Danach steht die Mission wieder auf „Offen“ und kann neu vergeben werden.</p>
        </fieldset>

        <footer class="nga-footer">
          <button type="button" data-action="cancel">Abbrechen</button>
          <button type="button" data-action="saveMission" class="nga-primary"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
        </footer>
      </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelectorAll(".nga-dropzone").forEach((zone) => {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("hover"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("hover"));
      zone.addEventListener("drop", (e) => this._onDropItem(e, zone.dataset.kind));
    });
  }

  async _onDropItem(event, kind) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn("Bitte nur Gegenstände (Items) hierher ziehen.");
    const item = await fromUuid(data.uuid);
    if (!item) return;
    this._readForm();
    const entry = { uuid: item.uuid, name: item.name, img: item.img, min: 1, max: 1 };
    if (kind === "possible") entry.chance = 50;
    this.mission.reward[kind].push(entry);
    this.render();
  }

  _readForm() {
    const el = this.element;
    const q = (n) => el.querySelector(`[name="${n}"]`);
    const m = this.mission;
    m.name = q("name")?.value?.trim() || "Unbenannte Mission";
    m.level = num(q("level")?.value, 1);
    m.description = q("description")?.value ?? "";
    m.playerDescription = q("playerDescription")?.value ?? "";
    m.reward.gpMin = Math.max(0, num(q("gpMin")?.value, 0));
    m.reward.gpMax = Math.max(m.reward.gpMin, num(q("gpMax")?.value, 0));
    m.partial.enabled = !!q("partial-enabled")?.checked;
    m.partial.margin = clamp(num(q("partial-margin")?.value, 3), 1, 10);
    m.partial.percent = clamp(num(q("partial-percent")?.value, 50), 0, 100);
    m.failure.hpLoss = clamp(num(q("hp-loss")?.value, 25), 0, 100);
    m.failure.injuryDays = Math.max(0, num(q("injury-days")?.value, 3));
    m.allowDeath = !!q("allow-death")?.checked;
    m.repeat.enabled = !!q("repeat-enabled")?.checked;
    m.repeat.value = Math.max(0, num(q("repeat-value")?.value, 7));
    m.repeat.unit = UNITS[q("repeat-unit")?.value] ? q("repeat-unit").value : "days";
    m.checks = [...el.querySelectorAll(".nga-check-row")].map((row) => ({
      ref: row.querySelector('[name="check-ref"]').value,
      dc: num(row.querySelector('[name="check-dc"]').value, 15)
    }));
    el.querySelectorAll(".nga-item-row").forEach((row) => {
      const it = m.reward[row.dataset.kind]?.[num(row.dataset.index)];
      if (!it) return;
      it.min = Math.max(0, num(row.querySelector('[name="min"]').value, 1));
      it.max = Math.max(it.min, num(row.querySelector('[name="max"]').value, it.min));
      const ch = row.querySelector('[name="chance"]');
      if (ch) it.chance = clamp(num(ch.value, 50), 0, 100);
    });
  }

  static _onAddCheck() {
    this._readForm();
    this.mission.checks.push({ ref: "skill:prc", dc: 15 });
    this.render();
  }

  static _onRemoveCheck(event, target) {
    this._readForm();
    this.mission.checks.splice(num(target.dataset.index), 1);
    this.render();
  }

  static _onRemoveItem(event, target) {
    this._readForm();
    this.mission.reward[target.dataset.kind]?.splice(num(target.dataset.index), 1);
    this.render();
  }

  static async _onSave() {
    this._readForm();
    const missions = getMissions();
    const stored = missions[this.mission.id];
    // Status/Ergebnis nicht überschreiben, falls die Mission inzwischen entsandt oder aufgelöst wurde
    if (stored) {
      this.mission.status = stored.status;
      this.mission.result = stored.result;
      this.mission.sentAt = stored.sentAt;
      this.mission.groupId = stored.groupId;
      this.mission.playerVisible = stored.playerVisible;
      this.mission.lastResult = stored.lastResult;
      // Neuer Zeitraum gilt ab dem letzten Auflösen
      this.mission.availableAt = this.mission.repeat.enabled && stored.result
        ? (stored.result.worldTime ?? game.time.worldTime) + repeatSeconds(this.mission)
        : null;
    }
    missions[this.mission.id] = this.mission;
    await saveMissions(missions);
    this.close();
  }

  static _onCancel() {
    this.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Spieler-Ansicht                                                    */
/* ------------------------------------------------------------------ */

class PlayerBoard extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-player-board`,
    classes: ["ascandir-nga", "nga-framed", "nga-player"],
    window: { title: "Missionsboard", icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 1100, height: 780 },
    actions: {
      playerSend: this._onPlayerSend
    }
  };

  static _onPlayerSend(event, target) {
    const missionId = target.dataset.mission;
    const select = this.element.querySelector(`select[data-mission="${missionId}"]`);
    requestSendGroup(missionId, select?.value);
  }

  async _renderHTML() {
    const missions = getMissions();
    const groups = getGroups().filter(groupVisible);
    const list = Object.values(missions).filter((m) => m.playerVisible).sort((a, b) => a.created - b.created);

    const groupHtml = groups.length ? groups.map((g) => {
      const st = groupStats(g);
      const trip = travelingMission(g.id, missions);
      const status = trip
        ? `<span class="nga-badge traveling">unterwegs</span><small>${trip.playerVisible ? esc(trip.name) : "auf geheimer Mission"}</small>`
        : st.members.length
          ? `<span class="nga-badge success">einsatzbereit</span>`
          : `<span class="nga-badge failure">nicht einsatzbereit</span>`;
      return `
        <div class="nga-group nga-parchment nga-pinned">
          <div class="nga-group-head">
            <img src="${esc(g.img)}" alt="">
            <div class="nga-group-name"><strong>${esc(g.name)}</strong><br>
              <small>${st.members.length} bereit · ${st.injured.length} verletzt · ${st.dead.length} tot · Ø-Stufe ${fmtLevel(st.level)}</small></div>
            <div class="nga-group-status">${status}</div>
          </div>
          <details>
            <summary>Mitglieder</summary>
            <ul class="nga-members">${st.all.map((a) => memberRow(a, false)).join("") || "<li><em>keine Mitglieder</em></li>"}</ul>
          </details>
        </div>`;
    }).join("") : `<p class="nga-empty">Keine Gruppen freigegeben.</p>`;

    const missionHtml = list.length ? list.map((m) => {
      const group = game.actors.get(m.groupId);
      const groupName = m.status === "open" ? "" : (m.result?.groupName ?? group?.name ?? "");
      const loot = [];
      if (num(m.reward.gpMax)) loot.push(`${range(m.reward.gpMin, m.reward.gpMax)} GM`);
      for (const it of m.reward.guaranteed) loot.push(`${range(it.min, it.max)}× ${esc(it.name)}`);
      if (m.reward.possible.length) loot.push(`<span class="nga-possible">+ mögliche Zusatzbeute</span>`);
      const checks = m.checks.map((c) => esc(checkLabel(c.ref))).join(" · ");
      let sendHtml = "";
      if (m.status === "open") {
        const free = groups.filter((g) => !travelingMission(g.id, missions) && groupStats(g).members.length);
        sendHtml = free.length
          ? `<div class="nga-send">
               <select data-mission="${m.id}">${free.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>
               <button type="button" class="nga-primary" data-action="playerSend" data-mission="${m.id}"><i class="fa-solid fa-person-walking-arrow-right"></i> Entsenden</button>
             </div>`
          : `<p class="nga-empty"><small>Keine freie Gruppe verfügbar.</small></p>`;
      }
      return `
        <div class="nga-mission-card nga-parchment nga-pinned ${TIERS[m.status]?.css ?? ""}">
          <div class="nga-mission-head">
            <strong>${esc(m.name)}</strong> <small>Stufe ${num(m.level)}</small>
            <span class="nga-badge ${TIERS[m.status]?.css}">${TIERS[m.status]?.label ?? m.status}</span>
          </div>
          ${m.playerDescription ? `<p>${esc(m.playerDescription).replace(/\n/g, "<br>")}</p>` : ""}
          ${checks ? `<p><small><strong>Gefragt:</strong> ${checks}</small></p>` : ""}
          <p><small><strong>Belohnung:</strong> ${loot.join(", ") || "keine"}</small></p>
          ${groupName ? `<p><small><strong>Gruppe:</strong> ${esc(groupName)}</small></p>` : ""}
          ${repeatInfo(m)}
          ${sendHtml}
        </div>`;
    }).join("") : `<p class="nga-empty">Keine Missionen ausgehängt.</p>`;

    return `
      <section class="nga-board"><div class="nga-drape" aria-hidden="true"></div>
        <h2 class="nga-sign"><i class="fa-solid fa-people-group"></i> Gruppen</h2>
        <div class="nga-groups">${groupHtml}</div>
        <h2 class="nga-sign"><i class="fa-solid fa-scroll"></i> Missionen</h2>
        <div class="nga-mission-cards">${missionHtml}</div>
      </section>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }
}

/* ------------------------------------------------------------------ */
/*  Actor-Typ "Custom Objekt"                                          */
/* ------------------------------------------------------------------ */

class CustomObjectData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      objectType: new f.StringField({ required: true, initial: "missionboard", choices: () => ({ ...OBJECT_KINDS }) })
    };
  }
}

/** Spieler (und DM per Doppelklick) – was passiert beim Öffnen des Objekts */
function useCustomObject(actor) {
  if (actor.system?.objectType === "missionboard") {
    if (!game.user.isGM && !setting("boardObjectActive", true)) {
      return ui.notifications.info("Das Missionsboard ist gerade nicht verfügbar.");
    }
    return openBoard();
  }
}

const ActorSheetBase = foundry.applications?.sheets?.ActorSheetV2;

class CustomObjectSheet extends ActorSheetBase {
  static DEFAULT_OPTIONS = {
    classes: ["ascandir-nga", "nga-object-sheet"],
    position: { width: 420, height: "auto" },
    window: { resizable: false },
    form: { submitOnChange: true },
    actions: {
      useObject: this._onUseObject
    }
  };

  /** Spieler bekommen nie das Blatt, sondern direkt das Objekt (z. B. das Missionsboard). */
  render(options, _options) {
    if (!game.user.isGM) {
      useCustomObject(this.document);
      return this;
    }
    return super.render(options, _options);
  }

  async _renderHTML() {
    const a = this.document;
    const kinds = Object.entries(OBJECT_KINDS)
      .map(([k, l]) => `<option value="${k}" ${k === a.system.objectType ? "selected" : ""}>${l}</option>`).join("");
    const active = setting("boardObjectActive", true);
    return `
      <div class="nga-object">
        <img src="${esc(a.img)}" alt="" data-action="editImage" data-edit="img" title="Bild ändern">
        <div class="nga-object-fields">
          <div class="form-group"><label>Name</label><input type="text" name="name" value="${esc(a.name)}"></div>
          <div class="form-group"><label>Objekttyp</label><select name="system.objectType">${kinds}</select></div>
        </div>
      </div>
      <p class="hint">Spieler öffnen das Objekt per Doppelklick auf den Token.
        ${a.system.objectType === "missionboard" ? `Status: <strong>${active ? "aktiv" : "deaktiviert"}</strong> (Moduleinstellungen).` : ""}</p>
      <button type="button" class="nga-primary" data-action="useObject"><i class="fa-solid fa-scroll"></i> ${OBJECT_KINDS[a.system.objectType] ?? "Objekt"} öffnen</button>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  static _onUseObject() {
    useCustomObject(this.document);
  }
}

/* Einstellungs-Knopf: öffnet einfach das Board */
class BoardLauncher extends ApplicationV2 {
  render() {
    openBoard();
    return this;
  }
}

/* ------------------------------------------------------------------ */
/*  Status-Abgleich zwischen Actor und Token                           */
/* ------------------------------------------------------------------ */

/**
 * Setzt oder entfernt der DM "tot" bzw. "Verletzt (Mission)" an einem Token
 * oder Actor eines Gruppenmitglieds, wird das auf Actor und alle Token übertragen.
 */
async function mirrorEffect(effect, op, options, userId) {
  if (options?.ngaSync || userId !== game.user.id || !game.user.isGM) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor") return;
  const ids = [...(effect.statuses ?? [])].filter((s) => SYNC_STATUSES.includes(s));
  if (!ids.length) return;
  const base = actor.isToken ? game.actors.get(actor.id) : actor;
  if (!base || !isGroupMember(base.id)) return;

  for (const id of ids) {
    if (op === "delete") {
      for (const a of actorsFor(base)) {
        if (a.uuid === actor.uuid) continue;
        const del = a.effects.filter((e) => e.statuses?.has?.(id)).map((e) => e.id);
        if (del.length) await a.deleteEmbeddedDocuments("ActiveEffect", del, { ngaSync: true });
      }
    } else {
      const flags = effect.flags?.[MODULE_ID] ? { flags: { [MODULE_ID]: foundry.utils.deepClone(effect.flags[MODULE_ID]) } } : {};
      for (const a of actorsFor(base)) {
        if (a.uuid === actor.uuid) continue;
        const existing = findStatus(a, id);
        if (existing) {
          if (op === "update" && Object.keys(flags).length) await existing.update(flags, { ngaSync: true });
        } else if (op === "create") {
          await a.createEmbeddedDocuments("ActiveEffect", [statusEffectData(id, flags)], { ngaSync: true });
        }
      }
    }
  }
  refreshBoard();
}

/** Wiederholbare Missionen nach Ablauf der Zeit wieder öffnen. */
async function refreshRepeatables() {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  const missions = getMissions();
  const now = game.time.worldTime;
  const renewed = [];
  for (const m of Object.values(missions)) {
    if (!m.repeat?.enabled || !m.availableAt || ["open", "traveling"].includes(m.status)) continue;
    if (m.availableAt > now) continue;
    m.lastResult = m.result;
    m.status = "open";
    m.result = null;
    m.sentAt = null;
    m.availableAt = null;
    renewed.push(m.name);
  }
  if (!renewed.length) return;
  await saveMissions(missions);
  ui.notifications.info(`Wieder verfügbar: ${renewed.join(", ")}`);
}

/** Abgelaufene Verletzungen automatisch entfernen. */
async function clearExpiredInjuries() {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  for (const g of getGroups()) {
    for (const a of getMembers(g)) {
      const e = findStatus(a, INJURED);
      const until = e?.getFlag(MODULE_ID, "until");
      if (e && until && until <= game.time.worldTime) await removeStatus(a, INJURED);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

const startupErrors = [];

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "missions", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: () => refreshBoard()
  });

  game.settings.register(MODULE_ID, "levelStep", {
    name: "Bonus/Malus pro Stufe Unterschied (%)",
    hint: "Liegt die Ø-Stufe der Gruppe über der Missionsstufe, steigt die Chance um diesen Wert pro Stufe – darunter sinkt sie.",
    scope: "world",
    config: true,
    type: Number,
    default: 5,
    onChange: () => refreshBoard()
  });

  game.settings.register(MODULE_ID, "surplusStep", {
    name: "Beute-Bonus pro Punkt Überschuss (%)",
    hint: "Pro Punkt, den der Wurf über dem Ziel-SG liegt: Mengen rücken so viel Prozent der Spanne Richtung Maximum, Loot-Chancen steigen um so viele Prozentpunkte.",
    scope: "world",
    config: true,
    type: Number,
    default: 5
  });

  game.settings.register(MODULE_ID, "playerDirectoryButton", {
    name: "Missionsboard für Spieler im Actors-Tab",
    hint: "Spieler sehen oben im Actors-Tab einen Knopf zum Missionsboard (nur freigegebene Missionen und Gruppen).",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => ui.actors?.render()
  });

  game.settings.register(MODULE_ID, "boardObjectActive", {
    name: "Missionsboard-Objekt aktiv",
    hint: "Spieler können platzierte Custom Objekte vom Typ Missionsboard per Doppelklick öffnen.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "publicResults", {
    name: "Ergebnisse öffentlich im Chat",
    hint: "Aus: Das Ergebnis wird nur dem DM zugeflüstert.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.registerMenu(MODULE_ID, "board", {
    name: "Missionsboard",
    label: "Missionsboard öffnen",
    hint: "Missionen anlegen, Gruppen entsenden und Missionen auflösen.",
    icon: "fa-solid fa-scroll",
    type: BoardLauncher,
    restricted: true
  });
});

/* Actor-Typ "Custom Objekt" registrieren – jeder Schritt einzeln abgesichert */
Hooks.once("init", () => {
  const step = (label, fn) => {
    try { fn(); } catch (err) {
      console.error(`${MODULE_ID} | ${label} fehlgeschlagen`, err);
      startupErrors.push(`${label}: ${err?.message ?? err}`);
    }
  };
  step("Datenmodell", () => { CONFIG.Actor.dataModels[OBJECT_TYPE] = CustomObjectData; });
  step("Typname", () => {
    CONFIG.Actor.typeLabels ??= {};
    CONFIG.Actor.typeLabels[OBJECT_TYPE] = "NGA.CustomObject";
  });
  step("Bogen", () => {
    const sheetOptions = { types: [OBJECT_TYPE], makeDefault: true, label: "NGA.CustomObject" };
    const sheetConfig = foundry.applications?.apps?.DocumentSheetConfig;
    if (sheetConfig?.registerSheet) sheetConfig.registerSheet(CONFIG.Actor.documentClass, MODULE_ID, CustomObjectSheet, sheetOptions);
    else (foundry.documents?.collections?.Actors ?? globalThis.Actors).registerSheet(MODULE_ID, CustomObjectSheet, sheetOptions);
  });
});

Hooks.once("ready", () => {
  if (startupErrors.length && game.user.isGM) {
    ui.notifications.error(`NSC Group Automation: Start-Fehler – ${startupErrors.join(" | ")}`, { permanent: true });
  }
  console.log(`${MODULE_ID} | v${game.modules.get(MODULE_ID)?.version} geladen`);
  game.socket.on(SOCKET, onSocket);
  // Eigener Token-Status "Verletzt (Mission)" – im Token-HUD setz- und entfernbar
  if (!CONFIG.statusEffects.some((s) => s.id === INJURED)) {
    CONFIG.statusEffects.push({ id: INJURED, name: "Verletzt (Mission)", img: "icons/svg/blood.svg" });
  }
  game.modules.get(MODULE_ID).api = {
    openBoard, sendGroup, recallGroup, resolveMission, groupStats, computeChance, getMissions
  };
  clearExpiredInjuries();
  refreshRepeatables();

});

/*
 * Doppelklick auf ein Custom Objekt öffnet direkt das Objekt (z. B. das Missionsboard) – für alle.
 * Muss vor dem ersten Zeichnen der Szene passieren, sonst haben die Token noch den alten Klick-Handler.
 */
Hooks.once("setup", () => {
  const TokenClass = CONFIG.Token.objectClass;
  const originalClick2 = TokenClass?.prototype?._onClickLeft2;
  if (!originalClick2) return console.warn(`${MODULE_ID} | Token-Doppelklick konnte nicht erweitert werden`);
  TokenClass.prototype._onClickLeft2 = function (event) {
    if (this.actor?.type === OBJECT_TYPE) {
      event?.stopPropagation?.();
      return useCustomObject(this.actor);
    }
    return originalClick2.call(this, event);
  };
});

/* Falls doch ein Blatt für ein Custom Objekt aufgeht: Spieler bekommen stattdessen das Objekt */
for (const hook of ["renderDocumentSheetV2", "renderActorSheet"]) {
  Hooks.on(hook, (app) => {
    const doc = app.document ?? app.actor;
    if (doc?.documentName !== "Actor" || doc.type !== OBJECT_TYPE || game.user.isGM) return;
    app.close({ animate: false });
    useCustomObject(doc);
  });
}

Hooks.on("renderActorDirectory", (app, html) => {
  if (!game.user.isGM && !setting("playerDirectoryButton", false)) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".nga-open-board")) return;
  // Eigene Leiste ganz oben im Kopf des Actors-Tabs – die normale Knopfleiste ist bei Spielern ausgeblendet
  const header = root.querySelector(":scope > header") ?? root.querySelector(".directory-header") ?? root.querySelector("header");
  const target = document.createElement("div");
  target.className = "nga-directory-bar flexrow";
  if (header) header.insertAdjacentElement("afterbegin", target);
  else root.insertAdjacentElement("afterbegin", target);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nga-open-board";
  btn.innerHTML = `<i class="fa-solid fa-scroll"></i> Missionsboard`;
  btn.addEventListener("click", (e) => { e.preventDefault(); openBoard(); });
  target.append(btn);
});

Hooks.on("preCreateActor", (actor, data) => {
  if (actor.type !== OBJECT_TYPE) return;
  const changes = {
    "ownership.default": CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED,
    "prototypeToken.actorLink": true,
    "prototypeToken.disposition": CONST.TOKEN_DISPOSITIONS.NEUTRAL
  };
  if (!data.img || data.img === "icons/svg/mystery-man.svg") {
    changes.img = "icons/svg/book.svg";
    changes["prototypeToken.texture.src"] = "icons/svg/book.svg";
  }
  actor.updateSource(changes);
});

Hooks.on("createActiveEffect", (effect, options, userId) => mirrorEffect(effect, "create", options, userId));
Hooks.on("updateActiveEffect", (effect, changes, options, userId) => mirrorEffect(effect, "update", options, userId));
Hooks.on("deleteActiveEffect", (effect, options, userId) => mirrorEffect(effect, "delete", options, userId));

Hooks.on("updateWorldTime", () => {
  clearExpiredInjuries();
  refreshRepeatables();
  refreshBoard();
});

for (const hook of ["updateActor", "createActor", "deleteActor"]) {
  Hooks.on(hook, () => refreshBoard());
}
