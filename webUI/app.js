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

function fmtMinutes(x) {
  if (!isFinite(x)) return "—";
  return Math.max(0, Math.round(x));
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

function formatModeLabel(mode) {
  if (mode === "manual") return "Modus: MANUELL";
  if (mode === "auto") return "Modus: AUTO";
  return "Modus: AUS";
}

var tempHistory = [];
var heaterHistory = [];
var setpHistory = [];
var fanHistory = [];

function updateHistory(history, value, now, minDelta, maxLen) {
  if (!isFinite(value)) return;

  if (history.length) {
    var last = history[history.length - 1];
    var stale = now - last.t > 45000;
    if (Math.abs(value - last.v) < minDelta && !stale) return;
  }

  history.push({ t: now, v: value });
  var cap = maxLen || 30;
  if (history.length > cap) history.shift();
}

function heaterIsRising(history) {
  if (history.length < 2) return false;
  var last = history[history.length - 1];
  var prev = history[history.length - 2];
  return last.v > prev.v;
}

function historyIsUnstable(tempHistory, fanHistory) {
  var now = Date.now();
  var unstableTemp = false;
  var unstableFan = false;

  for (var i = Math.max(1, tempHistory.length - 5); i < tempHistory.length; i++) {
    var prevTemp = tempHistory[i - 1];
    var currTemp = tempHistory[i];
    if (currTemp.t - prevTemp.t < 120000 && Math.abs(currTemp.v - prevTemp.v) > 0.4) {
      unstableTemp = true;
      break;
    }
  }

  for (var j = Math.max(1, fanHistory.length - 5); j < fanHistory.length; j++) {
    var prevFan = fanHistory[j - 1];
    var currFan = fanHistory[j];
    if (currFan.t - prevFan.t < 120000 && Math.abs(currFan.v - prevFan.v) > 25) {
      unstableFan = true;
      break;
    }
  }

  if (!tempHistory.length || now - tempHistory[tempHistory.length - 1].t > 240000) {
    unstableTemp = true;
  }

  return unstableTemp || unstableFan;
}

function drawDiagChart() {
  var canvas = $("diagChart");
  if (!canvas) return;
  var parent = canvas.parentElement;
  if (!parent) return;

  var width = parent.clientWidth;
  var height = 140;
  if (width <= 0) return;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.height = height + "px";

  var ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  var allTemp = tempHistory.concat(setpHistory);
  if (allTemp.length < 2 && fanHistory.length < 2) return;

  var minT = Infinity;
  var maxT = -Infinity;
  for (var i = 0; i < allTemp.length; i++) {
    minT = Math.min(minT, allTemp[i].v);
    maxT = Math.max(maxT, allTemp[i].v);
  }
  if (!isFinite(minT) || !isFinite(maxT) || minT === maxT) {
    minT = isFinite(minT) ? minT - 1 : 18;
    maxT = isFinite(maxT) ? maxT + 1 : 24;
  } else {
    minT -= 0.5;
    maxT += 0.5;
  }

  var startTime = Infinity;
  var endTime = -Infinity;
  var allHistories = [tempHistory, setpHistory, fanHistory];
  for (var h = 0; h < allHistories.length; h++) {
    var hist = allHistories[h];
    if (!hist.length) continue;
    startTime = Math.min(startTime, hist[0].t);
    endTime = Math.max(endTime, hist[hist.length - 1].t);
  }
  if (!isFinite(startTime) || !isFinite(endTime)) return;
  if (startTime === endTime) {
    endTime = startTime + 60000;
  }

  var padding = 8;
  var innerW = width - padding * 2;
  var innerH = height - padding * 2;

  function xFor(t) {
    return padding + ((t - startTime) / (endTime - startTime)) * innerW;
  }

  function yForTemp(v) {
    return padding + (1 - (v - minT) / (maxT - minT)) * innerH;
  }

  function yForFan(v) {
    var clamped = clamp(v, 0, 100);
    return padding + (1 - clamped / 100) * innerH;
  }

  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding + innerH / 2);
  ctx.lineTo(padding + innerW, padding + innerH / 2);
  ctx.stroke();

  function drawLine(history, color, yMap) {
    if (!history.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i < history.length; i++) {
      var p = history[i];
      var x = xFor(p.t);
      var y = yMap(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (history.length === 1) {
      var last = history[0];
      ctx.lineTo(xFor(endTime), yMap(last.v));
    }
    ctx.stroke();
    var lastPoint = history[history.length - 1];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xFor(lastPoint.t), yMap(lastPoint.v), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLine(tempHistory, "#4aa3ff", yForTemp);
  drawLine(setpHistory, "#2ee59d", yForTemp);
  drawLine(fanHistory, "#ffd166", yForFan);
}

/* ========= RENDER ========= */

function render() {
  var now = Date.now();
  updateHistory(tempHistory, state.room, now, 0.05);
  updateHistory(setpHistory, state.setp, now, 0.05);
  updateHistory(fanHistory, state.fan, now, 1);

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


  var statusEl = $("statusText");
  if (statusEl) statusEl.textContent = formatModeLabel(state.mode);

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
  var diagState = $("diagState");
  if (diagState) diagState.textContent = state.ktxt;

  var statusDetails = [];
  var hasTemp = isFinite(state.room) && isFinite(state.setp);
  var hasFan = isFinite(state.fan);
  var unstable = historyIsUnstable(tempHistory, fanHistory);   

  if (hasTemp) {
    statusDetails.push("Zieltemperatur: " + fmt1(state.setp) + " °C");
  } else {
    statusDetails.push("Zieltemperatur: —");
  }

  var etaText = "";
  if (state.mode === "off") {
    etaText = "Keine ETA berechenbar";
  } else if (!hasTemp) {
    etaText = "Keine ETA berechenbar";
  } else if (unstable) {
    etaText = "Warte auf stabile Messwerte";
  } else if (state.mode !== "auto") {
    etaText = "Keine ETA berechenbar";
  } else if (!isFinite(delta) || delta >= -0.2) {
    etaText = "Keine ETA berechenbar";
  } else if (!hasFan || state.fan === 0) {
    etaText = "Keine ETA berechenbar";
  } else {
    var heaterTemp = heaterHistory.length ? heaterHistory[heaterHistory.length - 1].v : NaN;
    var heaterRising = heaterIsRising(heaterHistory);
    var proxyWarm = isFinite(state.proxy) && isFinite(state.room) && state.proxy > state.room + 0.8;
    if (isFinite(heaterTemp) && heaterTemp < state.room) {
      etaText = "Keine ETA berechenbar";
    } else if (!heaterRising && !proxyWarm) {
      etaText = "Keine ETA berechenbar";
    } else {
      var effectiveRate = computeEffectiveRate(tempHistory, heaterHistory, state.fan);
      if (isFinite(effectiveRate) && effectiveRate > 0) {
        var etaMinutes = estimateETA(state.room, state.setp, effectiveRate);
        if (isFinite(etaMinutes)) {
          etaText = "Ziel voraussichtlich in ca. " + fmtMinutes(etaMinutes) + " Minuten erreicht";
        } else {
          etaText = "Keine ETA berechenbar";
        }
      } else {
        etaText = "Keine ETA berechenbar";
      }
    }
  }

  var nextText = "";
  if (state.mode === "off") {
    nextText = "System deaktiviert – keine aktive Regelung";
  } else if (!hasTemp || !hasFan) {
    nextText = "Keine verlässliche Aussage möglich";
  } else if (unstable) {
    nextText = "Regelung passt sich aktuell an";
  } else if (Math.abs(delta) < 0.2) {
    nextText = "Temperatur im Zielbereich – stabil";
  } else if (delta < -0.2) {
    nextText = "Ziel wird weiter angefahren";
  } else if (delta > 0.2) {
    nextText = "Lüfterleistung wird als Nächstes reduziert";
  } else {
    nextText = "System stabil – keine Anpassung geplant";
  }

  if (nextText) statusDetails.push(nextText);

  var statusDetailsEl = $("statusDetails");
  if (statusDetailsEl) {
    statusDetailsEl.innerHTML = "";
    for (var s = 0; s < statusDetails.length; s++) {
      var line = document.createElement("div");
      line.className = "status-line";
      line.textContent = statusDetails[s];
      statusDetailsEl.appendChild(line);
    }
  }

  updateETAUI(etaText, deltaColor(delta));
  drawDiagChart();
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
        window.requestAnimationFrame(drawDiagChart);
      } else {
        diagPanel.setAttribute("hidden", "");
        diagToggle.textContent = "▼";
      }
    });
  }

  window.addEventListener("resize", function () {
    if (diagPanel && !diagPanel.hasAttribute("hidden")) {
      drawDiagChart();
    }
  });

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
