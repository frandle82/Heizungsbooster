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
  ktxt:   "k-faktor-anpassung"             // text_sensor
};

/* ========= STATE ========= */

var state = {
  mode: "off",
  room: NaN,
  setp: NaN,
  fan:  NaN,
  manual: NaN,
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

/* ========= RENDER ========= */

function render() {
  // Verbindung
  var sub = document.querySelector(".sub");
  if (sub) sub.textContent = state.connected ? "Live verbunden" : "Verbinde…";

  // Modus-Buttons
  var btns = document.querySelectorAll(".segbtn");
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle("active", btns[i].dataset.mode === state.mode);
  }

  // Views
  if ($("view-off"))    $("view-off").classList.toggle("hidden", state.mode !== "off");
  if ($("view-manual")) $("view-manual").classList.toggle("hidden", state.mode !== "manual");
  if ($("view-auto"))   $("view-auto").classList.toggle("hidden", state.mode !== "auto");

  // MANUELL
  if ($("mFanNow"))    $("mFanNow").textContent    = fmt0(state.fan);
  if ($("mFanTarget")) $("mFanTarget").textContent = fmt0(state.manual);
  if ($("manualSlider") && isFinite(state.manual)) {
    $("manualSlider").value = state.manual;
  }

  // AUTO
  if ($("aRoom")) $("aRoom").textContent = fmt1(state.room);
  if ($("aSet"))  $("aSet").textContent  = fmt1(state.setp);
  if ($("aFan"))  $("aFan").textContent  = fmt0(state.fan);

  // Δ berechnen
  var delta = (isFinite(state.setp) && isFinite(state.room))
    ? (state.room - state.setp)
    : NaN;

  if ($("aDelta")) $("aDelta").textContent = fmt1(delta);

  // Δ-Farbklasse
  var dc = $("a-delta");
  if (dc) {
    dc.classList.remove("good", "warn", "bad");
    if (!isFinite(delta))      dc.classList.add("warn");
    else if (delta <= 0.2)     dc.classList.add("good");
    else if (delta <= 1.0)     dc.classList.add("warn");
    else                       dc.classList.add("bad");
  }

  // k-Faktor / Auswertung
  if ($("kVal"))  $("kVal").textContent  = state.ktxt;
  if ($("kEval")) $("kEval").textContent = state.ktxt;
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
      restGet("text_sensor", IDS.ktxt).catch(() => null)
    ]).then(function (r) {
      if (r[0] && r[0].state) state.mode   = r[0].state;
      if (r[1] && r[1].value != null) state.manual = r[1].value;
      if (r[2] && r[2].value != null) state.room   = r[2].value;
      if (r[3] && r[3].value != null) state.setp   = r[3].value;
      if (r[4] && r[4].value != null) state.fan    = r[4].value;
      if (r[5] && r[5].state != null) state.ktxt   = r[5].state;

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
    restGet("text_sensor", IDS.ktxt)
  ]).then(function (r) {
    state.mode   = r[0].state || "off";
    state.manual= r[1].value;
    state.room  = r[2].value;
    state.setp  = r[3].value;
    state.fan   = r[4].value;
    state.ktxt  = r[5].state || "—";
    state.connected = true;
    render();
  }).catch(function () {
    render();
    startPollingFallback();
  });

  startEvents();
}

document.addEventListener("DOMContentLoaded", init);
