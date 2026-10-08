/**
 * Ascandir - NSC Group Automation
 * Foundry VTT v13/v14 · dnd5e 5.x/6.x
 *
 * NSC-Gruppen (Actor-Typ "group") sammeln die besten Werte ihrer Mitglieder.
 * Der DM legt Missionen an (Proben + DC, Stufe, Belohnung) und löst sie
 * über das Missionsboard aus. Chance, Wurf, Belohnung und Folgen laufen automatisch.
 */

const MODULE_ID = "ascandir-nsc-group-automation";
const DAY = 86400;
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
const loc = (s) => (s ? game.i18n.localize(s) : "");

const TIERS = {
  open:     { label: "Offen",        css: "open" },
  success:  { label: "Erfolg",       css: "success" },
  partial:  { label: "Teilerfolg",   css: "partial" },
  failure:  { label: "Misserfolg",   css: "failure" },
  disaster: { label: "Katastrophe",  css: "disaster" }
};

/* ------------------------------------------------------------------ */
/*  Missionsdaten                                                      */
/* ------------------------------------------------------------------ */

function defaultMission() {
  return {
    id: foundry.utils.randomID(),
    name: "Neue Mission",
    description: "",
    level: 1,
    checks: [],
    reward: { gp: 0, items: [] },
    partial: { enabled: true, margin: 3, percent: 50 },
    failure: { injuryDays: 3 },
    allowDeath: false,
    groupId: "",
    status: "open",
    result: null,
    created: Date.now()
  };
}

function normalizeMission(m) {
  return foundry.utils.mergeObject(defaultMission(), foundry.utils.deepClone(m ?? {}), { inplace: false });
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
/*  Proben (Skills, Attribute, Rettungswürfe)                          */
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

function isDead(actor) {
  return !!actor.statuses?.has?.("dead");
}

function getLevel(actor) {
  const cr = actor.system?.details?.cr;
  if (cr !== undefined && cr !== null && cr !== "" && Number.isFinite(Number(cr))) return Number(cr);
  return num(actor.system?.details?.level, 0);
}

function groupStats(group) {
  const all = getMembers(group);
  const members = all.filter((a) => !isDead(a));
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
  return { members, dead: all.filter(isDead), best, level };
}

function blockedDays(group) {
  const until = group?.getFlag(MODULE_ID, "blockedUntil");
  if (!until) return 0;
  const rest = until - game.time.worldTime;
  return rest > 0 ? Math.ceil(rest / DAY) : 0;
}

/* ------------------------------------------------------------------ */
/*  Berechnung                                                         */
/* ------------------------------------------------------------------ */

function computeChance(mission, group) {
  const stats = groupStats(group);
  if (!stats.members.length) return { error: "Die Gruppe hat keine lebenden Mitglieder." };

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

/* ------------------------------------------------------------------ */
/*  Auflösung                                                          */
/* ------------------------------------------------------------------ */

async function applyReward(group, gp, items) {
  const given = { gp: 0, items: [] };
  if (gp > 0) {
    const cur = group.system?.currency;
    if (cur && "gp" in cur) {
      await group.update({ "system.currency.gp": num(cur.gp) + gp });
      given.gp = gp;
    } else {
      ui.notifications.warn(`${group.name} hat kein Geldfeld – Gold bitte manuell vergeben (${gp} GM).`);
    }
  }
  const toCreate = [];
  for (const it of items ?? []) {
    const doc = await fromUuid(it.uuid);
    if (!doc) {
      ui.notifications.warn(`Belohnungs-Gegenstand "${it.name}" wurde nicht mehr gefunden.`);
      continue;
    }
    const data = doc.toObject();
    delete data._id;
    data.system ??= {};
    data.system.quantity = Math.max(1, num(it.quantity, 1));
    toCreate.push(data);
    given.items.push(`${data.system.quantity}× ${doc.name}`);
  }
  if (toCreate.length) await group.createEmbeddedDocuments("Item", toCreate);
  return given;
}

async function killRandomMember(stats) {
  const victim = stats.members[Math.floor(Math.random() * stats.members.length)];
  if (!victim) return null;
  try {
    await victim.toggleStatusEffect?.("dead", { active: true, overlay: true });
  } catch (e) {
    console.warn(`${MODULE_ID} | Status "tot" konnte nicht gesetzt werden`, e);
  }
  return victim.name;
}

async function resolveMission(id) {
  if (!game.user.isGM) return ui.notifications.warn("Nur der DM kann Missionen auflösen.");
  const missions = getMissions();
  const m = missions[id];
  if (!m) return;
  const group = game.actors.get(m.groupId);
  if (!group) return ui.notifications.warn("Bitte zuerst eine Gruppe für die Mission auswählen.");
  const blocked = blockedDays(group);
  if (blocked > 0) return ui.notifications.warn(`${group.name} ist noch ${blocked} Tag(e) verletzt und nicht einsatzbereit.`);

  const calc = computeChance(m, group);
  if (calc.error) return ui.notifications.warn(calc.error);

  const roll = await new Roll("1d20").evaluate();
  const r = roll.total;

  let tier;
  if (r >= calc.dc) tier = "success";
  else if (r === 1 || r <= calc.dc - 10) tier = "disaster";
  else if (m.partial.enabled && r >= calc.dc - num(m.partial.margin, 3)) tier = "partial";
  else tier = "failure";

  const result = {
    roll: r, dc: calc.dc, chance: calc.chance, groupName: group.name,
    gp: 0, items: [], injuryDays: 0, deceased: null, worldTime: game.time.worldTime
  };

  if (tier === "success") {
    const g = await applyReward(group, num(m.reward.gp), m.reward.items);
    result.gp = g.gp; result.items = g.items;
  } else if (tier === "partial") {
    const gp = Math.floor(num(m.reward.gp) * num(m.partial.percent, 50) / 100);
    const g = await applyReward(group, gp, []);
    result.gp = g.gp;
  } else {
    const days = num(m.failure.injuryDays, 3) * (tier === "disaster" ? 2 : 1);
    if (days > 0) {
      await group.setFlag(MODULE_ID, "blockedUntil", game.time.worldTime + days * DAY);
      result.injuryDays = days;
    }
    if (tier === "disaster" && m.allowDeath) result.deceased = await killRandomMember(calc.stats);
  }

  m.status = tier;
  m.result = result;
  missions[id] = m;
  await saveMissions(missions);
  await postResult(m, group, calc, roll, tier, result);
}

async function postResult(m, group, calc, roll, tier, res) {
  const rows = calc.parts.map((p) => `
    <tr><td>${esc(p.label)}</td><td>${p.dc}</td><td>${sign(p.bonus)} <small>(${esc(p.who)})</small></td><td>${pct(p.p)}</td></tr>`).join("");

  const consequences = [];
  if (res.gp || res.items.length) {
    const parts = [];
    if (res.gp) parts.push(`${res.gp} GM`);
    parts.push(...res.items.map(esc));
    consequences.push(`<p><strong>Belohnung an ${esc(group.name)}:</strong> ${parts.join(", ")}</p>`);
  } else if (tier === "success" || tier === "partial") {
    consequences.push(`<p><strong>Belohnung:</strong> keine</p>`);
  }
  if (tier === "partial") consequences.push(`<p><em>Teilerfolg – nur ${num(m.partial.percent, 50)} % des Goldes, keine Gegenstände.</em></p>`);
  if (res.injuryDays) consequences.push(`<p><strong>Verletzt:</strong> Die Gruppe ist ${res.injuryDays} Tag(e) nicht einsatzbereit.</p>`);
  if (res.deceased) consequences.push(`<p class="nga-death"><strong>☠ ${esc(res.deceased)}</strong> ist auf der Mission gestorben.</p>`);

  const content = `
  <div class="nga-chat">
    <h3>Mission: ${esc(m.name)}</h3>
    <p><strong>Gruppe:</strong> ${esc(group.name)} · Ø-Stufe ${fmtLevel(calc.stats.level)} gegen Missionsstufe ${num(m.level)}</p>
    ${calc.parts.length ? `<table><thead><tr><th>Probe</th><th>SG</th><th>Bester</th><th>Chance</th></tr></thead><tbody>${rows}</tbody></table>` : `<p><em>Keine Proben hinterlegt – Grundchance 50 %.</em></p>`}
    <p>Grundchance ${pct(calc.base)} · Stufenunterschied ${sign(Math.round(calc.levelDiff * 10) / 10)} → ${sign(Math.round(calc.levelMod * 100))} %</p>
    <p class="nga-summary"><strong>Erfolgschance ${pct(calc.chance)}</strong> → Ziel-SG <strong>${calc.dc}</strong></p>
    <p class="nga-summary">Wurf: <strong>${roll.total}</strong> <span class="nga-badge ${TIERS[tier].css}">${TIERS[tier].label}</span></p>
    ${consequences.join("")}
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

function openBoard() {
  if (!game.user.isGM) return ui.notifications.warn("Das Missionsboard ist nur für den DM.");
  boardApp ??= new MissionBoard();
  boardApp.render({ force: true });
  return boardApp;
}

function refreshBoard() {
  if (boardApp?.rendered) boardApp.render();
}

function rewardText(m) {
  const parts = [];
  if (num(m.reward.gp)) parts.push(`${num(m.reward.gp)} GM`);
  for (const it of m.reward.items) parts.push(`${num(it.quantity, 1)}× ${esc(it.name)}`);
  return parts.length ? parts.join("<br>") : "<em>keine</em>";
}

class MissionBoard extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-board`,
    classes: ["ascandir-nga"],
    window: { title: "Missionsboard", icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 980, height: 680 },
    actions: {
      newMission: this._onNew,
      editMission: this._onEdit,
      deleteMission: this._onDelete,
      resolveMission: this._onResolve,
      resetMission: this._onReset,
      releaseGroup: this._onRelease
    }
  };

  async _renderHTML() {
    const groups = getGroups();
    const missions = Object.values(getMissions()).sort((a, b) => a.created - b.created);

    const groupHtml = groups.length ? groups.map((g) => {
      const st = groupStats(g);
      const blocked = blockedDays(g);
      const statusHtml = blocked
        ? `<span class="nga-badge failure">verletzt · ${blocked} Tag(e)</span> <button type="button" data-action="releaseGroup" data-group="${g.id}" title="Sofort wieder einsatzbereit">Freigeben</button>`
        : `<span class="nga-badge success">einsatzbereit</span>`;
      const bestRows = allRefs().map((ref) => {
        const b = st.best[ref];
        return b ? `<li><span>${esc(checkLabel(ref))}</span><span>${sign(b.value)} <small>${esc(b.actor)}</small></span></li>` : "";
      }).join("");
      const memberList = [
        ...st.members.map((a) => `${esc(a.name)} (HG ${fmtLevel(getLevel(a))})`),
        ...st.dead.map((a) => `<s>${esc(a.name)}</s> ☠`)
      ].join(", ") || "<em>keine Mitglieder</em>";
      return `
        <div class="nga-group">
          <div class="nga-group-head">
            <img src="${esc(g.img)}" alt="">
            <div class="nga-group-name"><strong>${esc(g.name)}</strong><br><small>${st.members.length} aktiv · Ø-Stufe ${fmtLevel(st.level)}</small></div>
            <div class="nga-group-status">${statusHtml}</div>
          </div>
          <details>
            <summary>Mitglieder &amp; beste Werte</summary>
            <p class="nga-members">${memberList}</p>
            <ul class="nga-best">${bestRows}</ul>
          </details>
        </div>`;
    }).join("") : `<p class="nga-empty">Noch keine Gruppen. Lege im Actors-Tab einen Actor vom Typ <strong>Gruppe</strong> an und ziehe deine NSCs hinein.</p>`;

    const groupOptions = (selected) => `<option value="">– Gruppe wählen –</option>` + groups.map((g) => {
      const b = blockedDays(g);
      return `<option value="${g.id}" ${g.id === selected ? "selected" : ""}>${esc(g.name)}${b ? ` (verletzt ${b} T.)` : ""}</option>`;
    }).join("");

    const missionRows = missions.length ? missions.map((m) => {
      const group = game.actors.get(m.groupId);
      const resolved = m.status !== "open";
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
      const groupCell = resolved
        ? esc(m.result?.groupName ?? group?.name ?? "–")
        : `<select class="nga-group-select" data-mission="${m.id}">${groupOptions(m.groupId)}</select>`;
      const actions = resolved
        ? `<button type="button" data-action="resetMission" data-mission="${m.id}" title="Mission wieder öffnen"><i class="fa-solid fa-rotate-left"></i></button>`
        : `<button type="button" class="nga-resolve" data-action="resolveMission" data-mission="${m.id}" ${group ? "" : "disabled"}><i class="fa-solid fa-dice-d20"></i> Auflösen</button>`;
      return `
        <tr class="${TIERS[m.status]?.css ?? ""}">
          <td><strong>${esc(m.name)}</strong> <small>(Stufe ${num(m.level)})</small><br><small class="nga-checks">${checks}</small></td>
          <td>${rewardText(m)}</td>
          <td>${groupCell}</td>
          <td class="nga-center">${chanceHtml}</td>
          <td class="nga-center"><span class="nga-badge ${TIERS[m.status]?.css}">${TIERS[m.status]?.label ?? m.status}</span></td>
          <td class="nga-actions">
            ${actions}
            <button type="button" data-action="editMission" data-mission="${m.id}" title="Bearbeiten"><i class="fa-solid fa-pen"></i></button>
            <button type="button" data-action="deleteMission" data-mission="${m.id}" title="Löschen"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>`;
    }).join("") : `<tr><td colspan="6" class="nga-empty">Noch keine Missionen – klicke auf „Neue Mission“.</td></tr>`;

    return `
      <section class="nga-board">
        <h2><i class="fa-solid fa-people-group"></i> Gruppen</h2>
        <div class="nga-groups">${groupHtml}</div>
        <div class="nga-board-head">
          <h2><i class="fa-solid fa-scroll"></i> Missionen</h2>
          <button type="button" data-action="newMission"><i class="fa-solid fa-plus"></i> Neue Mission</button>
        </div>
        <table class="nga-table">
          <thead><tr><th>Mission</th><th>Belohnung</th><th>Gruppe</th><th>Chance</th><th>Status</th><th></th></tr></thead>
          <tbody>${missionRows}</tbody>
        </table>
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
    await saveMissions(missions);
  }

  static async _onRelease(event, target) {
    const g = game.actors.get(target.dataset.group);
    if (g) await g.unsetFlag(MODULE_ID, "blockedUntil");
    refreshBoard();
  }
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
    position: { width: 640, height: "auto" },
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

    const items = m.reward.items.map((it, i) => `
      <div class="nga-item-row" data-index="${i}">
        <img src="${esc(it.img)}" alt="">
        <span>${esc(it.name)}</span>
        <label>Anzahl <input type="number" name="item-qty" value="${num(it.quantity, 1)}" min="1"></label>
        <button type="button" data-action="removeItem" data-index="${i}" title="Entfernen"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join("");

    return `
      <div class="nga-editor">
        <div class="form-group"><label>Name</label><input type="text" name="name" value="${esc(m.name)}"></div>
        <div class="form-group"><label>Missionsstufe</label><input type="number" name="level" value="${num(m.level)}" min="0" step="0.5"></div>
        <div class="form-group stacked"><label>Beschreibung (nur für dich)</label><textarea name="description" rows="3">${esc(m.description)}</textarea></div>

        <fieldset>
          <legend>Benötigte Proben</legend>
          ${checks}
          <button type="button" data-action="addCheck"><i class="fa-solid fa-plus"></i> Probe hinzufügen</button>
        </fieldset>

        <fieldset>
          <legend>Belohnung (geht an die Gruppe)</legend>
          <div class="form-group"><label>Gold (GM)</label><input type="number" name="gp" value="${num(m.reward.gp)}" min="0"></div>
          ${items}
          <div class="nga-dropzone"><i class="fa-solid fa-hand-holding-heart"></i> Gegenstände aus dem Items-Tab oder einem Kompendium hierher ziehen</div>
        </fieldset>

        <fieldset>
          <legend>Teilerfolg &amp; Misserfolg</legend>
          <div class="form-group"><label>Teilerfolg möglich</label><input type="checkbox" name="partial-enabled" ${m.partial.enabled ? "checked" : ""}></div>
          <div class="form-group"><label>Teilerfolg, wenn knapp verfehlt um bis zu</label><input type="number" name="partial-margin" value="${num(m.partial.margin, 3)}" min="1" max="10"></div>
          <div class="form-group"><label>Gold bei Teilerfolg (%)</label><input type="number" name="partial-percent" value="${num(m.partial.percent, 50)}" min="0" max="100"></div>
          <div class="form-group"><label>Verletzt bei Misserfolg (Tage)</label><input type="number" name="injury-days" value="${num(m.failure.injuryDays, 3)}" min="0"></div>
          <div class="form-group"><label>Bei Katastrophe kann ein NSC sterben</label><input type="checkbox" name="allow-death" ${m.allowDeath ? "checked" : ""}></div>
          <p class="hint">Katastrophe = natürliche 1 oder 10+ unter dem Ziel-SG. Dann doppelte Verletzungsdauer.</p>
        </fieldset>

        <footer class="nga-footer">
          <button type="button" data-action="cancel">Abbrechen</button>
          <button type="button" data-action="saveMission" class="nga-resolve"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
        </footer>
      </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const zone = this.element.querySelector(".nga-dropzone");
    if (!zone) return;
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("hover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("hover"));
    zone.addEventListener("drop", (e) => this._onDropItem(e));
  }

  async _onDropItem(event) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn("Bitte nur Gegenstände (Items) hierher ziehen.");
    const item = await fromUuid(data.uuid);
    if (!item) return;
    this._readForm();
    this.mission.reward.items.push({ uuid: item.uuid, name: item.name, img: item.img, quantity: 1 });
    this.render();
  }

  _readForm() {
    const el = this.element;
    const q = (n) => el.querySelector(`[name="${n}"]`);
    const m = this.mission;
    m.name = q("name")?.value?.trim() || "Unbenannte Mission";
    m.level = num(q("level")?.value, 1);
    m.description = q("description")?.value ?? "";
    m.reward.gp = Math.max(0, num(q("gp")?.value, 0));
    m.partial.enabled = !!q("partial-enabled")?.checked;
    m.partial.margin = clamp(num(q("partial-margin")?.value, 3), 1, 10);
    m.partial.percent = clamp(num(q("partial-percent")?.value, 50), 0, 100);
    m.failure.injuryDays = Math.max(0, num(q("injury-days")?.value, 3));
    m.allowDeath = !!q("allow-death")?.checked;
    m.checks = [...el.querySelectorAll(".nga-check-row")].map((row) => ({
      ref: row.querySelector('[name="check-ref"]').value,
      dc: num(row.querySelector('[name="check-dc"]').value, 15)
    }));
    el.querySelectorAll(".nga-item-row").forEach((row) => {
      const it = m.reward.items[num(row.dataset.index)];
      if (it) it.quantity = Math.max(1, num(row.querySelector('[name="item-qty"]').value, 1));
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
    this.mission.reward.items.splice(num(target.dataset.index), 1);
    this.render();
  }

  static async _onSave() {
    this._readForm();
    const missions = getMissions();
    missions[this.mission.id] = this.mission;
    await saveMissions(missions);
    this.close();
  }

  static _onCancel() {
    this.close();
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
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

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
    hint: "Missionen anlegen, Gruppen zuweisen und auflösen.",
    icon: "fa-solid fa-scroll",
    type: BoardLauncher,
    restricted: true
  });
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = { openBoard, resolveMission, groupStats, computeChance, getMissions };
});

Hooks.on("renderActorDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".nga-open-board")) return;
  const target = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  if (!target) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nga-open-board";
  btn.innerHTML = `<i class="fa-solid fa-scroll"></i> Missionsboard`;
  btn.addEventListener("click", (e) => { e.preventDefault(); openBoard(); });
  target.append(btn);
});

for (const hook of ["updateActor", "createActor", "deleteActor", "updateWorldTime"]) {
  Hooks.on(hook, () => refreshBoard());
}
