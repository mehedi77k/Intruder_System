const API_BASE = `${window.location.origin}/smart_intruder_api`;
const DASHBOARD_HOST = window.location.hostname || "localhost";
const PYTHON_STREAM_BASE = `http://${DASHBOARD_HOST}:5000`;
const CAMERA_STREAM_URL = `${PYTHON_STREAM_BASE}/video_feed`;
const PYTHON_HEALTH_URL = `${PYTHON_STREAM_BASE}/health`;
const HISTORY_LIMIT = 100;
const LIVE_REFRESH_MS = 1000;
const CAMERA_RETRY_MS = 5000;
let currentPage = 1;
let totalPages = 1;
let currentMode = "AT_HOME";
let lastAlertKey = "";
let cameraWorking = false;
let pythonStreamHealthy = false;
let liveRefreshBusy = false;
let modeUpdateBusy = false;
const systemStatusEl = document.getElementById("systemStatus");
const cameraFeedEl = document.getElementById("cameraFeed");
const cameraFallbackEl = document.getElementById("cameraFallback");
const cameraFallbackTextEl = document.getElementById("cameraFallbackText");
const modeAtHomeRadio = document.getElementById("modeAtHome");
const modeNotAtHomeRadio = document.getElementById("modeNotAtHome");
const currentModeText = document.getElementById("currentModeText");
const intruderCountEl = document.getElementById("intruderCount");
const alertBadgeEl = document.getElementById("alertBadge");
const alertInfoEl = document.getElementById("alertInfo");
const historyTableBody = document.getElementById("historyTableBody");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageInfoEl = document.getElementById("pageInfo");
document.addEventListener("DOMContentLoaded", async () => {
  updateModeUI(currentMode);
  bindEvents();
  askNotificationPermission();
  initCameraStream();
  await loadAll();
  setInterval(async () => {
    if (liveRefreshBusy || modeUpdateBusy) return;

    liveRefreshBusy = true;
    try {
      await loadLiveData();
      await loadHistory(currentPage, false);
    } finally {
      liveRefreshBusy = false;
    }
  }, LIVE_REFRESH_MS);
  setInterval(() => {
    if (!cameraWorking) {
      reconnectCameraStream("Trying to reconnect to Python stream...");
    }
  }, CAMERA_RETRY_MS);
});
function bindEvents() {
  modeAtHomeRadio.addEventListener("change", async () => {
    if (modeAtHomeRadio.checked && currentMode !== "AT_HOME" && !modeUpdateBusy) {
      await setMode("AT_HOME");
    }
  });
  modeNotAtHomeRadio.addEventListener("change", async () => {
    if (modeNotAtHomeRadio.checked && currentMode !== "NOT_AT_HOME" && !modeUpdateBusy) {
      await setMode("NOT_AT_HOME");
    }
  });
  prevPageBtn.addEventListener("click", async () => {
    if (currentPage > 1) {
      currentPage -= 1;
      await loadHistory(currentPage, true);
    }
  });
  nextPageBtn.addEventListener("click", async () => {
    if (currentPage < totalPages) {
      currentPage += 1;
      await loadHistory(currentPage, true);
    }
  });
}
async function loadAll() {
  await loadLiveData();
  await loadHistory(currentPage, true);
}
function initCameraStream() {
  cameraFeedEl.onload = () => {
    cameraWorking = true;
    cameraFeedEl.style.display = "block";
    cameraFallbackEl.style.display = "none";
  };
  cameraFeedEl.onerror = () => {
    cameraWorking = false;
    cameraFeedEl.style.display = "none";
    cameraFallbackEl.style.display = "block";
    setCameraFallbackText("Python stream not available.");
  };
  reconnectCameraStream("Connecting to Python processed stream...");
}
function reconnectCameraStream(message) {
  setCameraFallbackText(message);
  cameraWorking = false;
  cameraFeedEl.style.display = "none";
  cameraFallbackEl.style.display = "block";

  cameraFeedEl.src = "";
  cameraFeedEl.src = `${CAMERA_STREAM_URL}?t=${Date.now()}`;
}
function setCameraFallbackText(message) {
  if (cameraFallbackTextEl) {
    cameraFallbackTextEl.textContent = message;
  }
}
async function checkPythonStreamHealth() {
  try {
    const response = await fetch(`${PYTHON_HEALTH_URL}?t=${Date.now()}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error("Python health check failed");
    }
    const data = await response.json();
    pythonStreamHealthy = Boolean(data.stream_ok);
    return pythonStreamHealthy;
  } catch (error) {
    pythonStreamHealthy = false;
    return false;
  }
}
async function loadLiveData() {
  try {
    const [statusResponse, pythonHealthy] = await Promise.all([
      fetch(`${API_BASE}/get_system_status.php?t=${Date.now()}`, {
        cache: "no-store"
      }),
      checkPythonStreamHealth()
    ]);
    if (!statusResponse.ok) {
      throw new Error("Status API failed");
    }
    const data = await statusResponse.json();
    const latest = data.latest || {};
    currentMode = normalizeMode(data.current_mode || latest.mode || currentMode);
    updateModeUI(currentMode);
    const detection = Number(latest.detection ?? data.latest_detection ?? 0);
    intruderCountEl.textContent = detection;
    const backendOnline = Boolean(data.system_online);
    updateSystemStatus(backendOnline);
    updateAlert(detection);
    maybeSendBrowserNotification(detection, currentMode, latest);
    if (!cameraWorking && pythonHealthy) {
      reconnectCameraStream("Python stream is healthy. Loading video...");
    }
  } catch (error) {
    console.error(error);
    updateSystemStatus(false);
    updateModeUI(currentMode);
    intruderCountEl.textContent = "0";
    setNotAlertText("API unavailable");
  }
}
async function setMode(mode) {
  if (modeUpdateBusy) return;
  modeUpdateBusy = true;
  setModeInputsDisabled(true);
  try {
    const body = new URLSearchParams();
    body.append("mode", mode);
    body.append("source", "dashboard");
    const response = await fetch(`${API_BASE}/set_mode.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      cache: "no-store",
      body: body.toString()
    });
    if (!response.ok) {
      throw new Error("Mode set API failed");
    }
    const data = await response.json();
    if (data.status !== "success") {
      throw new Error(data.message || "Mode update failed");
    }
    currentMode = normalizeMode(data.current_mode || mode);
    updateModeUI(currentMode);
    currentPage = 1;
    await loadLiveData();
    await loadHistory(currentPage, true);
  } catch (error) {
    console.error(error);
    alert("Mode update failed. Please check your API.");
    updateModeUI(currentMode);
  } finally {
    setModeInputsDisabled(false);
    modeUpdateBusy = false;
  }
}
function setModeInputsDisabled(disabled) {
  modeAtHomeRadio.disabled = disabled;
  modeNotAtHomeRadio.disabled = disabled;
}
function updateModeUI(mode) {
  currentMode = normalizeMode(mode);
  currentModeText.textContent = formatMode(currentMode);
  modeAtHomeRadio.checked = currentMode === "AT_HOME";
  modeNotAtHomeRadio.checked = currentMode === "NOT_AT_HOME";
}
function updateSystemStatus(isOnline) {
  systemStatusEl.textContent = isOnline ? "ONLINE" : "OFFLINE";
  systemStatusEl.classList.toggle("online", isOnline);
  systemStatusEl.classList.toggle("offline", !isOnline);
}
function updateAlert(detection) {
  if (detection > 0) {
    alertBadgeEl.textContent = "Alert";
    alertBadgeEl.classList.remove("safe");
    alertBadgeEl.classList.add("alert");
    alertInfoEl.textContent = `Detection is ${detection}`;
  } else {
    setNotAlertText("Detection is 0");
  }
}
function setNotAlertText(message) {
  alertBadgeEl.textContent = "Not Alert";
  alertBadgeEl.classList.remove("alert");
  alertBadgeEl.classList.add("safe");
  alertInfoEl.textContent = message;
}
async function loadHistory(page, showLoader = true) {
  const targetPage = Number(page || 1);
  if (showLoader) {
    historyTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-cell">Loading data...</td>
      </tr>
    `;
  }
  try {
    const response = await fetch(
      `${API_BASE}/get_history.php?page=${targetPage}&limit=${HISTORY_LIMIT}&t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      throw new Error("History API failed");
    }
    const data = await response.json();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    currentPage = Number(data.page || 1);
    totalPages = Number(data.total_pages || 1);
    pageInfoEl.textContent = `Page ${currentPage} of ${totalPages}`;
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
    if (rows.length === 0) {
      historyTableBody.innerHTML = `
        <tr>
          <td colspan="4" class="empty-cell">No data found.</td>
        </tr>
      `;
      return;
    }
    historyTableBody.innerHTML = rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.serial_no ?? "")}</td>
        <td>${escapeHtml(row.time ?? "")}</td>
        <td>${escapeHtml(formatMode(normalizeMode(row.mode ?? "AT_HOME")))}</td>
        <td>${escapeHtml(String(row.detection ?? "0"))}</td>
      </tr>
    `).join("");
  } catch (error) {
    console.error(error);
    if (showLoader) {
      historyTableBody.innerHTML = `
        <tr>
          <td colspan="4" class="empty-cell">Failed to load history.</td>
        </tr>
      `;
    }
  }
}
function maybeSendBrowserNotification(detection, mode, latest) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (detection <= 0) return;
  const key = `${latest.serial_no || ""}-${detection}-${mode}`;
  if (lastAlertKey === key) return;
  lastAlertKey = key;
  const body = `Alert detected. Intruder count: ${detection}.`;
  new Notification("Smart Intruder System", { body });
}
function askNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}
function normalizeMode(mode) {
  const value = String(mode || "").trim().toUpperCase();
  if (value === "AT_HOME" || value === "AT HOME" || value === "HOME") {
    return "AT_HOME";
  }
  if (
    value === "NOT_AT_HOME" ||
    value === "NOT AT HOME" ||
    value === "AWAY" ||
    value === "NOTHOME"
  ) {
    return "NOT_AT_HOME";
  }
  return "AT_HOME";
}
function formatMode(mode) {
  return mode === "NOT_AT_HOME" ? "Not At Home" : "At Home";
}
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}