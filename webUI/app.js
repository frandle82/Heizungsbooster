/*************************************************
 * Heizungsbooster – Custom Web UI
 * kompatibel mit Safari & Chrome
 * Datenquellen: sensor, text_sensor, number, select
 *************************************************/

/* ========= KONFIG ========= */

// ESP-IP optional per URL:
// index.html?esp=http://10.1.3.62
function getEspBase() {
  var u = new URL(window.location.href);
  var esp = u.searchParams.get("esp");
  return esp ? esp.replace(/\/$/, "") : "http://heizungsbooster.local";
}
var ESP_BASE = getEspBase();

// ESPHome object_ids
var IDS = {
  mode:   "betriebsmodus",                // select
  manual: "man_lueftergeschwindigkeit",   // number
  room:   "raumtemperatur",               // sensor
  setp:   "solltemperatur",               // sensor
  fan:    "luefterleistung",              // sensor
  ktxt:   "k-faktor-anpassung",            // text_sensor
  heater: "heizungstemperatur",            // sensor (optional)
  proxy:  "heizung_konvektions-proxy"      // sensor (optional)
};

/* ========= STATE ========= */

var state = {
  mode: "off",
  room: NaN,
  setp: NaN,
  fan:  NaN,
  manual: NaN,
  heater: NaN,
  proxy: NaN,
  ktxt: "—",
  connected: false
};

/* ========= HILFSFUNKTIONEN ========= */

function $(id) {
  return document.getElementById(id);
}

function num(x) {
  var v = parseFloat(x);
  return isFinite(v) ? v : NaN;
}

function fmt1(x) {
  return isFinite(x) ? x.toFixed(1) : "—";
}

function fmt0(x) {
  return isFinite(x) ? Math.round(x) : "—";
}

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

function readNumberResponse(r) {
  if (!r) return NaN;
  if (r.state != null) return num(r.state);
  if (r.value != null) return num(r.value);
  return NaN;
}

function readTextResponse(r) {
  if (!r) return "—";
  if (r.state != null) return r.state;
  if (r.value != null) return r.value;
  return "—";
}

function deltaColor(delta) {
  if (!isFinite(delta)) return "rgba(255,255,255,.25)";

  if (delta >= 0) return "#2ee59d";
  if (delta <= -1.5) return "#ff5d5d";
  if (delta <= -0.5) return "#ffd166";

  return "#2ee59d";
}

function fmtSigned(x) {
  if (!isFinite(x)) return "—";
  var sign = x > 0 ? "+" : "";
  return sign + x.toFixed(1);
}

function computeEffectiveRate(roomHistory, heaterHistory, fan) {
  if (roomHistory.length < 2) return NaN;

  var first = roomHistory[0];
  var last = roomHistory[roomHistory.length - 1];
  var dt = (last.t - first.t) / 60000;
  if (dt <= 0) return NaN;

  var rateRoom = (last.v - first.v) / dt;
  var heaterTemp = heaterHistory.length ? heaterHistory[heaterHistory.length - 1].v : NaN;
  var heatSupport = isFinite(heaterTemp) ? clamp((heaterTemp - last.v) / 20, 0, 1) : 0;
  var fanFactor = 0.5 + (isFinite(fan) ? fan : 0) / 200;

  return rateRoom * fanFactor * (1 + heatSupport);
}

function estimateETA(room, setp, rate) {
  if (!isFinite(rate) || rate <= 0) return NaN;
  var remaining = setp - room;
  if (remaining <= 0) return 0;
  return remaining / rate;
}

function updateETAUI(text, color) {
  var etaEl = $("eta");
  if (etaEl) {
    var content = text || "";
    etaEl.textContent = content;
    etaEl.style.color = color ? color : "var(--muted)";
    etaEl.style.display = content ? "" : "none";
  }
}

function computeStatus(mode, delta, fan) {
  if (mode === "off") return "Ausgeschaltet";
  if (mode === "manual") return "Manueller Betrieb";

  if (fan > 0 && delta < -1.5) return "Heizt stark";
  if (fan > 0 && delta < -0.5) return "Heizt";
  if (fan > 0 && delta >= -0.5) return "Hält Temperatur";
  if (fan === 0 && delta >= 0) return "Ziel erreicht";
  if (fan === 0 && delta < -0.5) return "Wartet auf Wärme";

  return "Bereit";
}

var tempHistory = [];
var heaterHistory = [];

function updateHistory(history, value, now, minDelta) {
  if (!isFinite(value)) return;

  if (history.length) {
    var last = history[history.length - 1];
    if (Math.abs(value - last.v) < minDelta) return;
  }

  history.push({ t: now, v: value });
  if (history.length > 10) history.shift();
}

function heaterIsRising(history) {
  if (history.length < 2) return false;
  var last = history[history.length - 1];
  var prev = history[history.length - 2];
  return last.v > prev.v;
}

/* ========= RENDER ========= */

function render() {
  var now = Date.now();
  updateHistory(tempHistory, state.room, now, 0.05);

  var heaterValue = isFinite(state.heater) ? state.heater : state.proxy;
  updateHistory(heaterHistory, heaterValue, now, 0.1);

  // Verbindung
  var sub = document.querySelector(".sub");
  if (sub) sub.textContent = state.connected ? "Live verbunden" : "Verbinde…";

  // Modus-Buttons
  var btns = document.querySelectorAll(".segbtn");
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle("active", btns[i].dataset.mode === state.mode);
  }

  // MANUELL
  if ($("manualSlider")) {
    if (isFinite(state.manual)) {
      $("manualSlider").value = state.manual;
    }
  }

  // Δ berechnen (Raum - Soll)
  var delta = (isFinite(state.setp) && isFinite(state.room))
    ? (state.room - state.setp)
    : NaN;

  var deltaText = fmtSigned(delta) + " °C";
  var deltaEl = $("delta");
  if (deltaEl) {
    deltaEl.textContent = deltaText;
    deltaEl.style.color = deltaColor(delta);
  }

  var roomEl = $("room");
  if (roomEl) roomEl.textContent = "Raum " + fmt1(state.room) + " °C";

  var setpEl = $("setp");
  if (setpEl) setpEl.textContent = "Soll " + fmt1(state.setp) + " °C";

  var fanEl = $("fanValue");
  if (fanEl) {
    if (isFinite(state.fan)) {
      fanEl.textContent = fmt0(state.fan) + " %";
    } else {
      fanEl.textContent = "—";
    }
  }

  // k-Faktor / Auswertung
  var statusText = computeStatus(state.mode, delta, state.fan);
  var statusEl = $("statusText");
  if (statusEl) statusEl.textContent = statusText;

  var statusCard = $("status");
  if (statusCard) {
    var statusColor = deltaColor(delta);
    if (state.mode === "off") statusColor = "var(--off)";
    if (state.mode === "manual") statusColor = "var(--manual)";
    statusCard.style.background = statusColor;
  }

  var fanBlock = $("fan");
  if (fanBlock) {
    fanBlock.style.display = state.mode === "off" ? "none" : "";
  }

  var sliderWrap = $("manualSliderWrap");
  if (sliderWrap) {
    sliderWrap.style.display = state.mode === "manual" ? "" : "none";
  }

  var diagHeater = $("diagHeater");
  if (diagHeater) diagHeater.textContent = fmt1(state.heater) + " °C";
  var diagProxy = $("diagProxy");
  if (diagProxy) {
    var proxyDiff = isFinite(state.proxy) && isFinite(state.room) ? (state.proxy - state.room) : NaN;
    diagProxy.textContent = (isFinite(proxyDiff) ? fmtSigned(proxyDiff) : "—") + " °C";
  }
  var diagFan = $("diagFan");
  if (diagFan) diagFan.textContent = fmt0(state.fan) + " %";
  var diagState = $("diagState");
  if (diagState) diagState.textContent = state.ktxt;

  // ETA
  if (state.mode !== "auto" || !isFinite(delta) || delta >= 0) {
    updateETAUI("", null);
    return;
  }

  var heaterTemp = heaterHistory.length ? heaterHistory[heaterHistory.length - 1].v : NaN;
  var heaterRising = heaterIsRising(heaterHistory);
  var proxyWarm = isFinite(state.proxy) && isFinite(state.room) && state.proxy > state.room + 0.8;

  if (isFinite(heaterTemp) && heaterTemp < state.room) {
    updateETAUI("", null);
    return;
  }

  if (!heaterRising && !proxyWarm) {
    updateETAUI("", null);
    return;
  }

  if (!isFinite(state.fan) || state.fan === 0) {
    updateETAUI("", NaN, null);
    return;
  }

  var effectiveRate = computeEffectiveRate(tempHistory, heaterHistory, state.fan);
  if (!isFinite(effectiveRate) || effectiveRate <= 0) {
    updateETAUI("", NaN, null);
    return;
  }

  var etaMinutes = estimateETA(state.room, state.setp, effectiveRate);
  if (!isFinite(etaMinutes)) {
    updateETAUI("", NaN, null);
    return;
  }

  var etaText = "≈ " + Math.round(etaMinutes) + " min bis Ziel";
  updateETAUI(etaText, deltaColor(delta));
}

/* ========= REST ========= */

function restGet(domain, id) {
  return fetch(ESP_BASE + "/" + domain + "/" + id)
    .then(function (r) { return r.json(); });
}

function restSet(domain, id, params) {
  var q = new URLSearchParams(params);
  return fetch(
    ESP_BASE + "/" + domain + "/" + id + "/set?" + q.toString(),
    { method: "POST" }
  );
}

/* ========= EVENTS ========= */

function applyEvent(o) {
  if (!o || !o.id) return;

  var id = o.id;
  var s  = o.state;
  var v  = o.value;

  if (id === "select-" + IDS.mode) {
    state.mode = s || "off";
  }
  else if (id === "number-" + IDS.manual) {
    state.manual = num(s);
  }
  else if (id === "sensor-" + IDS.room) {
    state.room = num(s);
  }
  else if (id === "sensor-" + IDS.setp) {
    state.setp = num(s);
  }
  else if (id === "sensor-" + IDS.fan) {
    state.fan = num(s);
  }
  else if (id === "sensor-" + IDS.heater) {
    state.heater = num(s);
  }
  else if (id === "sensor-" + IDS.proxy) {
    state.proxy = num(s);
  }
  else if (id === "text_sensor-" + IDS.ktxt) {
    state.ktxt = s || "—";
  }
}

/* ========= EVENTSOURCE + FALLBACK ========= */

var pollTimer = null;

function startPollingFallback() {
  if (pollTimer) return;

  pollTimer = setInterval(function () {
    Promise.all([
      restGet("select", IDS.mode).catch(() => null),
      restGet("number", IDS.manual).catch(() => null),
      restGet("sensor", IDS.room).catch(() => null),
      restGet("sensor", IDS.setp).catch(() => null),
      restGet("sensor", IDS.fan).catch(() => null),
      restGet("sensor", IDS.heater).catch(() => null),
      restGet("sensor", IDS.proxy).catch(() => null),
      restGet("text_sensor", IDS.ktxt).catch(() => null)
    ]).then(function (r) {
      if (r[0] && r[0].state) state.mode   = r[0].state;
      state.manual = readNumberResponse(r[1]);
      state.room   = readNumberResponse(r[2]);
      state.setp   = readNumberResponse(r[3]);
      state.fan    = readNumberResponse(r[4]);
      state.heater = readNumberResponse(r[5]);
      state.proxy  = readNumberResponse(r[6]);
      state.ktxt   = readTextResponse(r[7]);

      state.connected = true;
      render();
    });
  }, 2500);
}

function startEvents() {
  try {
    var es = new EventSource(ESP_BASE + "/events");

    es.onopen = function () {
      state.connected = true;
      render();
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    es.onerror = function () {
      state.connected = false;
      render();
      try { es.close(); } catch (e) {}
      startPollingFallback();
    };

    es.addEventListener("state", function (ev) {
      try {
        applyEvent(JSON.parse(ev.data));
        render();
      } catch (e) {}
    });
  }
  catch (e) {
    startPollingFallback();
  }
}

/* ========= INIT ========= */

function init() {
  var diagToggle = $("diagToggle");
  var diagPanel = $("diagnostics");
  if (diagToggle && diagPanel) {
    diagToggle.textContent = "▼";
    diagToggle.addEventListener("click", function () {
      var isHidden = diagPanel.hasAttribute("hidden");
      if (isHidden) {
        diagPanel.removeAttribute("hidden");
        diagToggle.textContent = "▲";
      } else {
        diagPanel.setAttribute("hidden", "");
        diagToggle.textContent = "▼";
      }
    });
  }

  // Modus wechseln
  var btns = document.querySelectorAll(".segbtn");
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener("click", function () {
      restSet("select", IDS.mode, { option: this.dataset.mode });
    });
  }

  // Manuell-Slider
  if ($("manualSlider")) {
    $("manualSlider").addEventListener("change", function () {
      restSet("number", IDS.manual, { value: this.value });
    });
  }

  // Initial Fetch
  Promise.all([
    restGet("select", IDS.mode),
    restGet("number", IDS.manual),
    restGet("sensor", IDS.room),
    restGet("sensor", IDS.setp),
    restGet("sensor", IDS.fan),
    restGet("sensor", IDS.heater),
    restGet("sensor", IDS.proxy),
    restGet("text_sensor", IDS.ktxt)
  ]).then(function (r) {
    state.mode   = r[0].state || "off";
    state.manual= readNumberResponse(r[1]);
    state.room  = readNumberResponse(r[2]);
    state.setp  = readNumberResponse(r[3]);
    state.fan   = readNumberResponse(r[4]);
    state.heater = readNumberResponse(r[5]);
    state.proxy  = readNumberResponse(r[6]);
    state.ktxt  = readTextResponse(r[7]);
    state.connected = true;
    render();
  }).catch(function () {
    render();
    startPollingFallback();
  });

  startEvents();
}

document.addEventListener("DOMContentLoaded", init);
