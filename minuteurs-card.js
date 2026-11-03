/*
 * minuteurs-card — liste et commande des minuteurs Voice Satellite de Kiosk Satellite.
 *
 * Les minuteurs lancés à la voix vivent dans Home Assistant (intents de minuteur) ;
 * Kiosk Satellite les expose par des actions ESPHome nommées d'après le nœud :
 * esphome.<node>_vs_list_timers, _vs_start_timer, _vs_pause_timer, _vs_resume_timer,
 * _vs_cancel_timer, _vs_add_time, _vs_remove_time et _vs_cancel (fait taire une alarme).
 *
 * Écrit pour du matériel modeste (Echo Show 8 1re génération) :
 * - liste relue seulement sur l'évènement esphome.kiosk_satellite_timer, quand les capteurs
 *   VS Timers / VS Next timer changent, et toutes les 30 s tant qu'un minuteur existe ;
 * - le décompte n'écrit que les textes et les arcs qui changent, une fois par seconde,
 *   et s'arrête quand aucun minuteur ne tourne ;
 * - aucune animation CSS permanente ;
 * - JavaScript sans ?. ni ?? ni champs de classe, pour les WebView anciennes.
 */
const VERSION = "1.3.0";
const EVENT = "esphome.kiosk_satellite_timer";
const DEFAULT_NODE = "ks_amzn_echo_show_8";
const DEFAULT_PRESETS = [1, 3, 5, 10, 15, 20, 30, 60];
const RESYNC_MS = 30000;
const RING = 2 * Math.PI * 26; // circonférence de l'anneau (rayon 26 dans un viewBox de 60)

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pad(n) { return n < 10 ? "0" + n : String(n); }

// 754 → "12:34", 3754 → "1:02:34"
function clock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

// 600 → "10 min", 5400 → "1 h 30", 90 → "1 min 30 s"
function label(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return h + " h" + (m ? " " + pad(m) : "");
  if (m) return m + " min" + (s ? " " + s + " s" : "");
  return s + " s";
}

// Secondes restantes, à partir de la dernière liste reçue
function remaining(t, fetchedAt) {
  if (t.finished) return 0;
  if (!t.is_active) return t.seconds_left;
  if (t.ends_at) return (Date.parse(t.ends_at) - Date.now()) / 1000;
  return t.seconds_left - (Date.now() - fetchedAt) / 1000;
}

// Chaque minuteur garde sa couleur tant qu'il existe, sur la carte comme sur la mini-horloge
const PALETTE = ["#03a9f4", "#ff9800", "#8bc34a", "#e91e63", "#b388ff", "#ffeb3b"];
const timerColors = {};

function syncColors(timers) {
  const ids = timers.map((t) => t.timer_id);
  Object.keys(timerColors).forEach((id) => { if (ids.indexOf(id) < 0) delete timerColors[id]; });
  timers.forEach((t) => {
    if (timerColors[t.timer_id]) return;
    const used = Object.keys(timerColors).map((id) => timerColors[id]);
    const free = PALETTE.filter((c) => used.indexOf(c) < 0);
    timerColors[t.timer_id] = free.length ? free[0] : PALETTE[ids.indexOf(t.timer_id) % PALETTE.length];
  });
}

function timerColor(id) { return timerColors[id] || PALETTE[0]; }

function presetLabel(min) {
  return min % 60 === 0 ? min / 60 + " h" : min + " min";
}

const ICONS = {
  pause: "M14,19H18V5H14M6,19H10V5H6V19Z",
  play: "M8,5.14V19.14L19,12.14L8,5.14Z",
  close: "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
  bell: "M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21",
  minus: "M19,13H5V11H19V13Z",
  timer: "M12,20A7,7 0 0,1 5,13A7,7 0 0,1 12,6A7,7 0 0,1 19,13A7,7 0 0,1 12,20M19.03,7.39L20.45,5.97C20,5.46 19.55,5 19.04,4.56L17.62,6C16.07,4.74 14.12,4 12,4A9,9 0 0,0 3,13A9,9 0 0,0 12,22C17,22 21,17.97 21,13C21,10.88 20.26,8.93 19.03,7.39M11,14H13V8H11M15,1H9V3H15V1Z",
  plus: "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z",
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}

class MinuteursCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._timers = [];
    this._fetchedAt = 0;
    this._draft = { h: 0, m: 5, s: 0 };
    this._error = "";
    this._loaded = false;
    this._sensorKey = null;
    this._unsub = null;
    this._tick = null;
    this._resync = null;
    this._fetching = null;
    this._refetch = false;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
  }

  setConfig(config) {
    const node = (config && config.node) || DEFAULT_NODE;
    this._config = {
      node: node,
      // Les capteurs perdent le préfixe "ks_" du nœud : sensor.amzn_echo_show_8_vs_timers
      entity_prefix: (config && config.entity_prefix) || node.replace(/^ks_/, ""),
      title: config && config.title != null ? config.title : "Minuteurs",
      compact: !!(config && config.compact),
      presets: (config && Array.isArray(config.presets) && config.presets.length) ? config.presets : DEFAULT_PRESETS,
    };
    this._rendered = false;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._subscribe();
      this._fetch();
      return;
    }
    // Relire seulement si un capteur de minuteur a bougé, pas à chaque état de la maison
    const p = this._config.entity_prefix;
    const a = hass.states["sensor." + p + "_vs_timers"], b = hass.states["sensor." + p + "_vs_next_timer"];
    const key = (a ? a.state : "") + "|" + (b ? b.state : "");
    if (this._sensorKey !== null && key !== this._sensorKey) this._fetch();
    this._sensorKey = key;
  }

  connectedCallback() {
    // La mini-horloge s'efface quand la carte complète est à l'écran
    this._full = !!(this._config && !this._config.compact);
    if (this._full) floating.fullCards++;
    floating.update();
    if (this._hass) {
      this._subscribe();
      this._fetch();
    }
  }

  disconnectedCallback() {
    if (this._full) floating.fullCards--;
    this._full = false;
    floating.update();
    if (this._unsub) {
      this._unsub.then((u) => u()).catch(() => {});
      this._unsub = null;
    }
    this._stopTimers();
  }

  getCardSize() { return this._config && this._config.compact ? 2 : 6; }
  getGridOptions() { return { columns: "full", min_rows: 2 }; }
  static getStubConfig() { return { node: DEFAULT_NODE }; }

  // --- Données -----------------------------------------------------------

  _subscribe() {
    if (this._unsub || !this._hass) return;
    this._unsub = this._hass.connection.subscribeEvents(() => this._fetch(), EVENT);
    this._unsub.catch(() => { this._unsub = null; }); // non-admin : on garde les capteurs et la resynchro
  }

  _call(service, data, withResponse) {
    const msg = {
      type: "call_service",
      domain: "esphome",
      service: this._config.node + "_" + service,
      service_data: data || {},
    };
    if (withResponse) msg.return_response = true;
    return this._hass.callWS(msg);
  }

  _fetch() {
    if (!this._hass) return Promise.resolve();
    if (this._fetching) { this._refetch = true; return this._fetching; }
    this._fetching = this._call("vs_list_timers", {}, true)
      .then((res) => {
        const r = res && res.response;
        this._timers = (r && r.timers) || [];
        this._fetchedAt = Date.now();
        syncColors(this._timers);
        this._error = "";
      })
      .catch((err) => {
        this._error = "Minuteurs indisponibles : " + ((err && err.message) || "Voice Satellite est-il actif ?");
      })
      .then(() => {
        this._loaded = true;
        this._fetching = null;
        this._render();
        if (this._refetch) { this._refetch = false; this._fetch(); }
      });
    return this._fetching;
  }

  _remaining(t) { return remaining(t, this._fetchedAt); }

  _act(promise) {
    this._error = "";
    return promise
      .catch((err) => { this._error = (err && err.message) || "Action refusée"; })
      .then(() => this._fetch());
  }

  _start(sec, name) {
    sec = Math.round(sec);
    if (sec <= 0) return;
    // Home Assistant retrouve un minuteur par son nom, ou par sa durée s'il n'en a pas :
    // deux minuteurs anonymes de même durée seraient impossibles à distinguer.
    if (!name) {
      const same = this._timers.filter((t) => !t.name && t.total_seconds === sec).length;
      if (same) name = label(sec) + " (" + (same + 1) + ")";
    }
    const data = { name: name || "", hours: Math.floor(sec / 3600), minutes: Math.floor((sec % 3600) / 60), seconds: sec % 60 };
    this._act(this._call("vs_start_timer", data));
  }

  // --- Interaction ------------------------------------------------------

  _onClick(ev) {
    const el = ev.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act, id = el.dataset.id;
    const t = this._timers.find((x) => x.timer_id === id);
    const d = this._draft;
    switch (act) {
      case "preset": this._start(Number(el.dataset.min) * 60, ""); break;
      case "start": {
        const input = this.shadowRoot.querySelector("#name");
        const name = input ? input.value.trim() : "";
        this._start(d.h * 3600 + d.m * 60 + d.s, name);
        if (input) input.value = "";
        break;
      }
      case "step": {
        const unit = el.dataset.unit, delta = Number(el.dataset.delta);
        const max = unit === "h" ? 23 : 59;
        d[unit] = (d[unit] + delta + max + 1) % (max + 1);
        this._renderDraft();
        break;
      }
      case "toggle":
        if (t) this._act(this._call(t.is_active ? "vs_pause_timer" : "vs_resume_timer", { timer_id: id }));
        break;
      // Les actions ESPHome refusent (400) un appel sans tous leurs champs
      case "add": this._act(this._call("vs_add_time", { timer_id: id, hours: 0, minutes: 1, seconds: 0 })); break;
      case "remove": this._act(this._call("vs_remove_time", { timer_id: id, hours: 0, minutes: 1, seconds: 0 })); break;
      case "cancel": this._act(this._call("vs_cancel_timer", { timer_id: id })); break;
      case "silence": this._act(this._call("vs_cancel", {})); break;
    }
  }

  // --- Rendu ------------------------------------------------------------

  _render() {
    if (!this._config || !this._hass) return;
    const c = this._config;
    if (!this._rendered) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card class="${c.compact ? "compact" : "full"}">
        ${c.title ? `<div class="title">${esc(c.title)}</div>` : ""}
        <div class="body">
          <div class="list"></div>
          ${c.compact ? "" : this._newTimerHtml()}
        </div>
        <div class="error" hidden></div>
      </ha-card>`;
      this._rendered = true;
      this._listKey = null;
      this._renderDraft();
    }
    this._renderList();
    const e = this.shadowRoot.querySelector(".error");
    e.hidden = !this._error;
    e.textContent = this._error;
  }

  _newTimerHtml() {
    const unit = (u, name) => `<div class="unit">
        <button class="round" data-act="step" data-unit="${u}" data-delta="1" aria-label="Plus ${name}">${icon("plus")}</button>
        <div class="val" data-unit="${u}"></div>
        <div class="unit-name">${name}</div>
        <button class="round" data-act="step" data-unit="${u}" data-delta="-1" aria-label="Moins ${name}">${icon("minus")}</button>
      </div>`;
    return `<div class="new">
      <div class="sub">Lancer un minuteur</div>
      <div class="presets">${this._config.presets.map((m) =>
        `<button class="chip" data-act="preset" data-min="${Number(m)}">${presetLabel(Number(m))}</button>`).join("")}</div>
      <div class="custom">
        ${unit("h", "h")}<div class="sep">:</div>${unit("m", "min")}<div class="sep">:</div>${unit("s", "s")}
      </div>
      <div class="go">
        <input id="name" type="text" placeholder="Nom (facultatif)" maxlength="40" autocomplete="off">
        <button class="primary" data-act="start">${icon("play")}<span>Lancer</span></button>
      </div>
    </div>`;
  }

  _renderDraft() {
    const d = this._draft;
    this.shadowRoot.querySelectorAll(".val").forEach((v) => { v.textContent = pad(d[v.dataset.unit]); });
    const go = this.shadowRoot.querySelector('[data-act="start"]');
    if (go) go.disabled = !(d.h || d.m || d.s);
  }

  _renderList() {
    const list = this.shadowRoot.querySelector(".list");
    const ts = this._timers.slice().sort((a, b) =>
      (b.finished - a.finished) || (this._remaining(a) - this._remaining(b)));
    // Reconstruire le DOM seulement si l'ensemble des minuteurs ou leur état change
    const key = ts.map((t) => [t.timer_id, t.name, t.total_seconds, t.is_active, t.finished, timerColor(t.timer_id)].join("~")).join("|");
    if (key !== this._listKey) {
      this._listKey = key;
      if (!ts.length) {
        list.innerHTML = this._loaded
          ? (this._config.compact
            ? `<div class="empty">Aucun minuteur.</div>`
            : `<div class="empty">${icon("timer")}<div>Aucun minuteur</div><div class="hint">Dites « Alexa, minuteur 10 minutes » ou choisissez une durée.</div></div>`)
          : "";
      } else {
        list.innerHTML = ts.map((t) => this._timerHtml(t)).join("");
      }
    }
    this._paint();
    this._schedule(ts);
  }

  _timerHtml(t) {
    const id = esc(t.timer_id);
    const state = t.finished ? "done" : t.is_active ? "run" : "paused";
    const actions = t.finished
      ? `<button class="primary" data-act="silence">${icon("bell")}<span>Arrêter</span></button>`
      : `${this._config.compact ? "" : `<button class="round" data-act="remove" data-id="${id}" aria-label="Retirer une minute">−1</button>`}
         <button class="round" data-act="add" data-id="${id}" aria-label="Ajouter une minute">+1</button>
         <button class="round big" data-act="toggle" data-id="${id}" aria-label="${t.is_active ? "Pause" : "Reprendre"}">${icon(t.is_active ? "pause" : "play")}</button>
         <button class="round" data-act="cancel" data-id="${id}" aria-label="Arrêter">${icon("close")}</button>`;
    return `<div class="timer ${state}" data-id="${id}">
      <svg class="ring" viewBox="0 0 60 60" aria-hidden="true">
        <circle class="track" cx="30" cy="30" r="26"/>
        <circle class="arc" cx="30" cy="30" r="26" stroke-dasharray="${RING.toFixed(2)}" style="stroke:${timerColor(t.timer_id)}"/>
      </svg>
      <div class="info">
        <div class="name">${esc(t.name || label(t.total_seconds))}</div>
        <div class="time"></div>
        <div class="state">${t.finished ? "Terminé" : t.is_active ? (t.name ? label(t.total_seconds) : "") : "En pause"}</div>
      </div>
      <div class="actions">${actions}</div>
    </div>`;
  }

  // Écrit uniquement le temps restant et l'arc de chaque minuteur
  _paint() {
    let ended = false;
    this.shadowRoot.querySelectorAll(".timer").forEach((row) => {
      const t = this._timers.find((x) => x.timer_id === row.dataset.id);
      if (!t) return;
      const left = this._remaining(t);
      if (t.is_active && !t.finished && left <= 0) ended = true;
      const txt = t.finished ? "00:00" : clock(left);
      const time = row.querySelector(".time");
      if (time.textContent !== txt) time.textContent = txt;
      const frac = t.total_seconds ? Math.min(1, Math.max(0, left / t.total_seconds)) : 0;
      const off = (RING * (1 - frac)).toFixed(1);
      const arc = row.querySelector(".arc");
      if (arc.getAttribute("stroke-dashoffset") !== off) arc.setAttribute("stroke-dashoffset", off);
    });
    if (ended) this._fetch(); // l'alarme sonne : récupérer l'état "terminé"
  }

  _schedule(ts) {
    const running = ts.some((t) => t.is_active && !t.finished);
    if (running && !this._tick) this._tick = setInterval(() => this._paint(), 1000);
    if (!running && this._tick) { clearInterval(this._tick); this._tick = null; }
    if (ts.length && !this._resync) this._resync = setInterval(() => this._fetch(), RESYNC_MS);
    if (!ts.length && this._resync) { clearInterval(this._resync); this._resync = null; }
  }

  _stopTimers() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._resync) { clearInterval(this._resync); this._resync = null; }
  }
}

const STYLE = `
  :host { display: block; height: 100%; }
  ha-card { padding: 16px; box-sizing: border-box; height: 100%; }
  .title { font-size: 22px; font-weight: 500; margin: 0 0 12px; color: var(--primary-text-color); }
  .body { display: flex; gap: 24px; align-items: flex-start; }
  .list { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .new { flex: 0 0 340px; }
  @media (max-width: 760px) { .body { flex-direction: column; } .new { flex: none; width: 100%; } }
  .empty { color: var(--secondary-text-color); font-size: 16px; padding: 12px 0; }
  .timer { display: flex; align-items: center; gap: 14px; padding: 10px 12px; border-radius: 16px;
    background: var(--secondary-background-color, rgba(127,127,127,.1)); }
  .ring { width: 60px; height: 60px; flex: none; transform: rotate(-90deg); }
  .ring circle { fill: none; stroke-width: 6; }
  .ring .track { stroke: var(--divider-color, rgba(127,127,127,.3)); }
  .ring .arc { stroke: var(--primary-color); stroke-linecap: round; }
  .paused .ring .arc { opacity: .4; }
  .done .ring .track { stroke: var(--error-color, #db4437); }
  .info { flex: 1 1 auto; min-width: 0; }
  .name { font-size: 15px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .time { font-size: 34px; font-weight: 500; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--primary-text-color); }
  .paused .time { color: var(--warning-color, #ff9800); }
  .done .time { color: var(--error-color, #db4437); }
  .state { font-size: 13px; color: var(--secondary-text-color); min-height: 16px; }
  .actions { display: flex; gap: 8px; flex: none; align-items: center; }
  button { font: inherit; color: var(--primary-text-color); border: none; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  button:disabled { opacity: .4; cursor: default; }
  button svg { width: 24px; height: 24px; fill: currentColor; }
  .round { width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: var(--card-background-color, #fff); font-size: 16px; font-weight: 500;
    box-shadow: inset 0 0 0 1px var(--divider-color, rgba(127,127,127,.3)); }
  .round.big { width: 56px; height: 56px; background: var(--primary-color); color: var(--text-primary-color, #fff); box-shadow: none; }
  .round:active, .chip:active, .primary:active { filter: brightness(1.25); }
  .primary { display: flex; align-items: center; gap: 6px; height: 48px; padding: 0 18px; border-radius: 24px;
    background: var(--primary-color); color: var(--text-primary-color, #fff); font-size: 16px; font-weight: 500; }
  .done .primary { background: var(--error-color, #db4437); }
  .sub { font-size: 15px; color: var(--secondary-text-color); margin-bottom: 8px; }
  .presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .chip { height: 44px; border-radius: 22px; background: var(--secondary-background-color, rgba(127,127,127,.1));
    font-size: 16px; box-shadow: inset 0 0 0 1px var(--divider-color, rgba(127,127,127,.3)); }
  .custom { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 14px 0 10px; }
  .unit { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .unit .round { width: 44px; height: 40px; border-radius: 20px; }
  .val { font-size: 32px; font-weight: 500; font-variant-numeric: tabular-nums; line-height: 1; color: var(--primary-text-color); }
  .unit-name { font-size: 12px; color: var(--secondary-text-color); }
  .sep { font-size: 28px; color: var(--secondary-text-color); padding-bottom: 18px; }
  .go { display: flex; gap: 8px; }
  .go input { flex: 1 1 auto; min-width: 0; height: 48px; box-sizing: border-box; padding: 0 14px; border-radius: 24px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.3)); background: transparent;
    color: var(--primary-text-color); font: inherit; font-size: 16px; }
  .error { margin-top: 10px; color: var(--error-color, #db4437); font-size: 14px; }
  /* Carte complète : remplit la vue panneau et grossit pour le doigt */
  ha-card.full { display: flex; flex-direction: column; min-height: 100%; }
  .full .body { flex: 1 1 auto; align-items: stretch; }
  .full .new { display: flex; flex-direction: column; flex-basis: 380px; }
  .full .presets { flex: 1 1 auto; grid-auto-rows: 1fr; gap: 10px; }
  .full .chip { height: auto; min-height: 52px; border-radius: 18px; font-size: 20px; }
  .full .custom { margin: 18px 0 14px; gap: 10px; }
  .full .unit .round { width: 56px; height: 48px; border-radius: 24px; }
  .full .val { font-size: 44px; }
  .full .sep { font-size: 36px; padding-bottom: 22px; }
  .full .go input, .full .primary { height: 56px; border-radius: 28px; font-size: 18px; }
  .full .list { gap: 12px; }
  .full .timer { padding: 14px 16px; gap: 18px; border-radius: 20px; }
  .full .ring { width: 76px; height: 76px; }
  .full .name { font-size: 17px; }
  .full .time { font-size: 46px; }
  .full .round { width: 54px; height: 54px; font-size: 18px; }
  .full .round.big { width: 64px; height: 64px; }
  .full .empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; text-align: center; font-size: 22px; padding: 0 16px; }
  .full .empty svg { width: 96px; height: 96px; fill: currentColor; opacity: .35; }
  .full .empty .hint { font-size: 16px; opacity: .8; max-width: 380px; }
  @media (max-width: 760px) { .full .presets { flex: none; } }
  .compact .title { font-size: 18px; margin-bottom: 8px; }
  .compact .timer { padding: 8px 10px; gap: 10px; }
  .compact .ring { width: 44px; height: 44px; }
  .compact .time { font-size: 26px; }
`;

/*
 * Mini-horloge flottante : remplace la grosse pastille de Kiosk Satellite (à couper dans
 * l'app : Voice Satellite > Minuteurs > Show timer pills). Elle suit toutes les vues du
 * dashboard du Show. Chaque minuteur y est un anneau de sa couleur qui se vide, les uns
 * dans les autres : le plus court au centre, le plus long à l'extérieur. Touchée, elle
 * s'ouvre 3 s pour afficher le temps exact. Touchée pendant une alarme, elle la fait taire.
 * Indépendante des cartes : elle prend la connexion de l'élément <home-assistant>.
 */
const FLOAT_PATH = "/echo-show"; // seulement sur le dashboard du Show
const FLOAT_OPEN_MS = 3000;

class MinuteursFloat {
  constructor() {
    this.fullCards = 0;
    this._timers = [];
    this._fetchedAt = 0;
    this._conn = null;
    this._el = null;
    this._tick = null;
    this._resync = null;
    this._close = null;
    this._fetching = false;
    this._key = null;
    this._wait = setInterval(() => this._attach(), 1000);
    const onNav = () => this.update();
    window.addEventListener("location-changed", onNav);
    window.addEventListener("popstate", onNav);
  }

  _attach() {
    const ha = document.querySelector("home-assistant");
    const conn = ha && ha.hass && ha.hass.connection;
    if (!conn || !document.body) return;
    clearInterval(this._wait);
    this._conn = conn;
    conn.subscribeEvents(() => this._fetch(), EVENT).catch(() => {});
    conn.addEventListener("ready", () => this._fetch()); // reconnexion après coupure
    this._fetch();
  }

  _call(service, withResponse) {
    const msg = { type: "call_service", domain: "esphome", service: DEFAULT_NODE + "_" + service, service_data: {} };
    if (withResponse) msg.return_response = true;
    return this._conn.sendMessagePromise(msg);
  }

  _fetch() {
    if (!this._conn || this._fetching) return;
    this._fetching = true;
    this._call("vs_list_timers", true)
      .then((res) => {
        this._timers = (res && res.response && res.response.timers) || [];
        this._fetchedAt = Date.now();
        syncColors(this._timers);
      })
      .catch(() => { this._timers = []; })
      .then(() => { this._fetching = false; this.update(); });
  }

  _visible() {
    return this._timers.length > 0 && this.fullCards <= 0 && location.pathname.indexOf(FLOAT_PATH) === 0;
  }

  update() {
    const show = this._visible();
    if (show && !this._el) this._build();
    if (this._el) this._el.hidden = !show;
    const running = show && this._timers.some((t) => t.is_active && !t.finished);
    if (running && !this._tick) this._tick = setInterval(() => this._paint(), 1000);
    if (!running && this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._timers.length && !this._resync) this._resync = setInterval(() => this._fetch(), RESYNC_MS);
    if (!this._timers.length && this._resync) { clearInterval(this._resync); this._resync = null; }
    if (show) this._paint();
  }

  _build() {
    const host = document.createElement("div");
    host.id = "minuteurs-float";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${FLOAT_STYLE}</style>
      <button class="fab" aria-label="Minuteur">
        <span class="clock"><svg viewBox="0 0 40 40" aria-hidden="true"></svg></span>
        <span class="badge" hidden></span>
        <span class="detail"></span>
      </button>`;
    this._fab = root.querySelector(".fab");
    this._fab.addEventListener("click", () => this._onTap());
    document.body.appendChild(host);
    this._el = host;
  }

  _sorted() {
    const f = this._fetchedAt;
    return this._timers.slice().sort((a, b) => (b.finished - a.finished) || (remaining(a, f) - remaining(b, f)));
  }

  _onTap() {
    if (this._timers.some((t) => t.finished)) {
      this._call("vs_cancel", false).catch(() => {}).then(() => this._fetch());
      return;
    }
    this._fab.classList.add("open");
    clearTimeout(this._close);
    this._close = setTimeout(() => this._fab.classList.remove("open"), FLOAT_OPEN_MS);
    this._paint();
  }

  // Les anneaux ne sont redessinés que si les minuteurs, leur ordre ou leur état changent ;
  // ensuite seul l'arc de chacun et les textes du détail sont mis à jour
  _paint() {
    if (!this._el || this._el.hidden) return;
    const all = this._sorted(), f = this._fetchedAt;
    if (!all.length) return;
    const root = this._el.shadowRoot;
    const state = all.some((t) => t.finished) ? "done" : all.some((t) => t.is_active) ? "run" : "paused";
    if (this._fab.dataset.state !== state) this._fab.dataset.state = state;
    if (all.some((t) => t.is_active && !t.finished && remaining(t, f) <= 0)) this._fetch(); // l'alarme sonne
    // Le plus court au centre : tri par temps restant
    const rings = all.slice().sort((a, b) => remaining(a, f) - remaining(b, f)).slice(0, FLOAT_MAX_RINGS);
    const key = rings.map((t) => [t.timer_id, t.is_active, t.finished, timerColor(t.timer_id)].join("~")).join("|");
    const svg = root.querySelector("svg");
    if (key !== this._key) {
      this._key = key;
      const n = rings.length;
      const step = n > 1 ? Math.min(5, (FLOAT_R - FLOAT_R_MIN) / (n - 1)) : 0;
      const width = n > 1 ? 3 : 3.5;
      svg.innerHTML = rings.map((t, i) => {
        const r = FLOAT_R - (n - 1 - i) * step, c = (2 * Math.PI * r).toFixed(2);
        const cls = t.finished ? "done" : t.is_active ? "" : "paused";
        return `<circle class="track" cx="20" cy="20" r="${r}" stroke-width="${width}"/>` +
          `<circle class="arc ${cls}" data-id="${esc(t.timer_id)}" data-c="${c}" cx="20" cy="20" r="${r}" stroke-width="${width}" ` +
          `stroke-dasharray="${c}" style="stroke:${timerColor(t.timer_id)}"/>`;
      }).join("");
    }
    svg.querySelectorAll(".arc").forEach((arc) => {
      const t = rings.find((x) => x.timer_id === arc.dataset.id);
      if (!t) return;
      const frac = t.total_seconds ? Math.min(1, Math.max(0, remaining(t, f) / t.total_seconds)) : 0;
      const off = (Number(arc.dataset.c) * (1 - frac)).toFixed(1);
      if (arc.getAttribute("stroke-dashoffset") !== off) arc.setAttribute("stroke-dashoffset", off);
    });
    const badge = root.querySelector(".badge");
    badge.hidden = all.length <= FLOAT_MAX_RINGS;
    if (badge.textContent !== String(all.length)) badge.textContent = String(all.length);
    if (!this._fab.classList.contains("open")) return;
    const html = rings.map((x) =>
      `<span class="line"><span class="dot" style="background:${timerColor(x.timer_id)}"></span>` +
      `<span class="n">${esc(x.name || label(x.total_seconds))}</span>` +
      `<span class="t">${x.finished ? "Terminé" : clock(remaining(x, f)) + (x.is_active ? "" : " ❚❚")}</span></span>`).join("");
    const detail = root.querySelector(".detail");
    if (detail.innerHTML !== html) detail.innerHTML = html;
  }
}

const FLOAT_R = 17, FLOAT_R_MIN = 4, FLOAT_MAX_RINGS = 4;

const FLOAT_STYLE = `
  :host { position: fixed; top: 10px; right: 10px; z-index: 9; }
  :host([hidden]) { display: none; }
  .fab { display: flex; align-items: center; gap: 0; min-height: 52px; padding: 6px; border: none; border-radius: 26px;
    background: rgba(20, 20, 20, .82); color: #fff; font: 500 16px Roboto, system-ui, sans-serif; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, .35); -webkit-tap-highlight-color: transparent; position: relative; }
  .clock { position: relative; width: 40px; height: 40px; flex: none; }
  .clock svg { width: 40px; height: 40px; transform: rotate(-90deg); }
  .clock circle { fill: none; }
  .track { stroke: rgba(255, 255, 255, .14); }
  .arc { stroke-linecap: round; transition: stroke-dashoffset .4s linear; }
  .arc.paused { opacity: .4; }
  [data-state="done"] { background: var(--error-color, #db4437); animation: sonne .5s ease-in-out infinite alternate; }
  .arc.done { stroke: #fff !important; }
  @keyframes sonne { from { transform: rotate(-8deg); } to { transform: rotate(8deg); } }
  .badge { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
    border-radius: 9px; background: var(--primary-color, #03a9f4); font-size: 12px; line-height: 18px; text-align: center; }
  .badge[hidden] { display: none; }
  .detail { display: flex; flex-direction: column; justify-content: center; max-width: 0; overflow: hidden; white-space: nowrap;
    opacity: 0; transition: max-width .3s ease, opacity .2s ease, margin .3s ease; }
  .open .detail { max-width: 220px; opacity: 1; margin: 0 10px 0 8px; }
  .line { display: flex; gap: 8px; align-items: center; line-height: 1.2; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .n { font-size: 12px; font-weight: 400; opacity: .75; max-width: 110px; overflow: hidden; text-overflow: ellipsis; align-self: center; }
  .t { font-size: 18px; font-variant-numeric: tabular-nums; margin-left: auto; }
`;

// Une seule horloge même si le module est chargé deux fois
const floating = window.minuteursFloat || (window.minuteursFloat = new MinuteursFloat());

if (!customElements.get("minuteurs-card")) {
  customElements.define("minuteurs-card", MinuteursCard);
  console.info("%c minuteurs-card %c " + VERSION, "background:#03a9f4;color:#fff", "");
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "minuteurs-card",
  name: "Minuteurs Voice Satellite",
  description: "Liste, lance, met en pause et arrête les minuteurs de Kiosk Satellite.",
});
