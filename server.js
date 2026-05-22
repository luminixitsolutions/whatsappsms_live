const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const AUTH_PATH = path.resolve(__dirname, ".wwebjs_auth");
const CACHE_PATH = path.resolve(__dirname, ".wwebjs_cache");
const SESSION_PATH = path.join(AUTH_PATH, "session");
const STALL_RESET_MS = Number(process.env.STALL_RESET_MS) || 300000;
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS) || 4 * 60 * 1000;
const CONNECTION_CHECK_MS = Number(process.env.CONNECTION_CHECK_MS) || 3 * 60 * 1000;
const SESSION_DIR = path.join(AUTH_PATH, "session-default");

function ensureAuthDirectories() {
  fs.mkdirSync(AUTH_PATH, { recursive: true });
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

ensureAuthDirectories();

function clearAuthData() {
  for (const dir of [AUTH_PATH, CACHE_PATH]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  ensureAuthDirectories();
}

function hasPersistedSession() {
  try {
    return (
      fs.existsSync(SESSION_DIR) &&
      fs.readdirSync(SESSION_DIR).some((name) => !name.startsWith("."))
    );
  } catch (error) {
    return false;
  }
}

function shouldClearSessionOnDisconnect(reason) {
  const reasonStr = String(reason || "").toUpperCase();
  return (
    reasonStr.includes("LOGOUT") ||
    reasonStr === "UNPAIRED" ||
    reasonStr.includes("UNPAIRED_IDLE")
  );
}

function canResetSession(req) {
  const secret = process.env.RESET_SECRET;
  if (!secret) {
    return true;
  }

  const provided =
    req.query?.secret || req.body?.secret || req.get("x-reset-secret");
  return provided === secret;
}

const app = express();

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message || "Request timed out")), ms);
    }),
  ]);
}
app.use(express.json({ limit: "12mb" }));

let isReady = false;
let clientState = "initializing";
let lastQr = null;
let lastQrAt = 0;
let initError = null;
let clientStartedAt = Date.now();
let isReconnecting = false;
let stallWatchdogTimer = null;
let keepAliveTimer = null;
let connectionMonitorTimer = null;
let lastReadyAt = 0;
let waQueue = Promise.resolve();
let waCooldownUntil = 0;
const chatIdCache = new Map();
const GAP_BETWEEN_SENDS_MS = 2500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueWaTask(task, timeoutMs = 45000) {
  const run = waQueue
    .then(async () => {
      const waitMs = waCooldownUntil - Date.now();
      if (waitMs > 0) {
        console.log(`WhatsApp cooldown ${waitMs}ms`);
        await delay(waitMs);
      }

      await delay(GAP_BETWEEN_SENDS_MS);

      return withTimeout(
        Promise.resolve().then(task),
        timeoutMs,
        "WhatsApp busy — wait 5 seconds and try again."
      );
    })
    .catch((error) => {
      waCooldownUntil = Date.now() + 8000;
      throw error;
    });

  waQueue = run.then(() => undefined).catch(() => undefined);
  return run;
}

const puppeteerExecutable =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  undefined;

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_PATH,
    clientId: "default",
  }),
  takeoverOnConflict: true,
  takeoverTimeoutMs: 15000,
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wa-version/whatsapp-web-versions/main/html/{version}.html",
  },
  puppeteer: {
    headless: true,
    executablePath: puppeteerExecutable,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--no-first-run",
    ],
  },
});

async function resolveChatId(digits) {
  if (chatIdCache.has(digits)) {
    return chatIdCache.get(digits);
  }

  const numberId = await withTimeout(
    client.getNumberId(digits),
    45000,
    "Number lookup timed out — wait a few seconds and try again."
  );

  if (!numberId) {
    throw new Error("This number is not registered on WhatsApp.");
  }

  let chatId = `${digits}@c.us`;
  if (numberId._serialized) {
    chatId = numberId._serialized;
  } else if (numberId.user) {
    chatId = `${numberId.user}@c.us`;
  }

  chatIdCache.set(digits, chatId);
  return chatId;
}

client.on("qr", (qr) => {
  lastQr = qr;
  lastQrAt = Date.now();
  initError = null;
  clientState = "qr_pending";
  isReady = false;
  console.log("QR received — scan with WhatsApp (Linked Devices):");
  console.log("Open /qr in browser to scan on Railway");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  clientState = "authenticated";
  console.log("WhatsApp authenticated — session saved to", AUTH_PATH);
});

client.on("auth_failure", (message) => {
  clientState = "auth_failure";
  isReady = false;
  initError = String(message || "Authentication failed");
  console.error("Authentication failed:", message);
});

client.on("ready", () => {
  isReady = true;
  clientState = "ready";
  lastQr = null;
  initError = null;
  lastReadyAt = Date.now();
  clientStartedAt = Date.now();
  chatIdCache.clear();
  console.log("WhatsApp ready — session kept at", AUTH_PATH);
});

client.on("disconnected", async (reason) => {
  isReady = false;
  clientState = "disconnected";
  console.log("Disconnected", reason ? `(${reason})` : "");

  if (isReconnecting) {
    return;
  }

  console.log("Reconnecting WhatsApp client in 5s...");

  setTimeout(async () => {
    if (isReconnecting) {
      return;
    }

    if (shouldClearSessionOnDisconnect(reason)) {
      console.log("Clearing session after disconnect:", reason);
      clearAuthData();
    } else {
      console.log("Keeping saved session after disconnect:", reason);
    }

    try {
      await reconnectWhatsApp("disconnected_event");
      console.log("WhatsApp reconnect finished");
    } catch (error) {
      initError = error.message;
      clientState = "init_failed";
      console.error("Reconnect failed:", error.message);
    }
  }, 5000);
});

client.on("loading_screen", (percent, message) => {
  clientState = "loading";
  isReady = false;
  console.log(`Loading: ${percent}% — ${message}`);
});

async function getWaConnectionState() {
  const attempts = 3;
  const timeoutMs = 20000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withTimeout(
        client.getState(),
        timeoutMs,
        "Could not read WhatsApp connection state"
      );
    } catch (error) {
      console.warn(
        `getState attempt ${attempt}/${attempts} failed:`,
        error.message
      );
      if (attempt < attempts) {
        await delay(1500);
      }
    }
  }

  return null;
}

function getNotReadyMessage() {
  if (clientState === "qr_pending" || lastQr) {
    return "WhatsApp is not linked. Open /qr, scan the QR code, wait until status shows ready, then send.";
  }

  if (clientState === "loading" || clientState === "authenticated") {
    return "WhatsApp is still connecting — wait until /status shows ready, then try again.";
  }

  if (clientState === "auth_failure") {
    return (
      initError ||
      "Authentication failed. Open /reset-session?confirm=1 then scan QR at /qr."
    );
  }

  if (
    clientState === "disconnected" ||
    clientState === "not_connected" ||
    clientState.startsWith("wa_")
  ) {
    return "WhatsApp disconnected. Open /qr to link again, or /reset-session?confirm=1 if stuck.";
  }

  return "WhatsApp not ready. Open /qr or check /status before sending.";
}

async function reconnectWhatsApp(reason) {
  if (isReconnecting) {
    throw new Error("WhatsApp is already reconnecting");
  }

  isReconnecting = true;
  isReady = false;
  clientState = "reconnecting";
  initError = null;
  console.log("Soft reconnect (session kept):", reason || "manual");

  try {
    await client.destroy();
  } catch (error) {
    console.warn("Destroy during reconnect:", error.message);
  }

  clientStartedAt = Date.now();

  try {
    await client.initialize();
  } finally {
    isReconnecting = false;
  }
}

async function waitForReady(maxMs = 90000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (isReady && clientState === "ready") {
      return true;
    }
    if (isReconnecting || clientState === "loading") {
      await delay(2000);
      continue;
    }
    break;
  }
  return isReady && clientState === "ready";
}

async function ensureClientReadyForSend() {
  if (isReady && clientState === "ready") {
    return;
  }

  if (!hasPersistedSession()) {
    throw new Error(getNotReadyMessage());
  }

  if (isReconnecting) {
    const ok = await waitForReady(60000);
    if (ok) {
      return;
    }
    throw new Error(
      "WhatsApp is reconnecting — wait 30 seconds and try again."
    );
  }

  console.log("Send requested while not ready — reconnecting with saved session");
  await reconnectWhatsApp("before_send");
  const ok = await waitForReady(90000);
  if (!ok) {
    throw new Error(
      "WhatsApp session expired or stuck. Open /qr to scan again (one-time), or /reset-session?confirm=1."
    );
  }
}

async function resetWhatsAppSession(reason) {
  if (isReconnecting) {
    throw new Error("WhatsApp is already resetting — wait a moment.");
  }

  isReconnecting = true;
  isReady = false;
  lastQr = null;
  lastQrAt = 0;
  clientState = "resetting";
  initError = null;
  chatIdCache.clear();

  console.log("Resetting WhatsApp session:", reason || "manual");

  try {
    await client.destroy();
  } catch (error) {
    console.warn("Destroy during reset:", error.message);
  }

  clearAuthData();
  clientStartedAt = Date.now();
  clientState = "initializing";

  try {
    await client.initialize();
    console.log("WhatsApp re-initialized after session reset");
    return {
      status: true,
      message: "Session cleared. Open /qr and scan when the QR appears.",
      clientState,
    };
  } catch (error) {
    initError = error.message;
    clientState = "init_failed";
    throw error;
  } finally {
    isReconnecting = false;
  }
}

function startStallWatchdog() {
  if (stallWatchdogTimer) {
    clearInterval(stallWatchdogTimer);
  }

  stallWatchdogTimer = setInterval(() => {
    if (isReady || lastQr || isReconnecting) {
      return;
    }

    if (Date.now() - clientStartedAt < STALL_RESET_MS) {
      return;
    }

    if (clientState === "disconnected" || clientState === "not_connected") {
      if (hasPersistedSession() && !isReconnecting) {
        console.log("Stall watchdog: reconnecting with saved session");
        reconnectWhatsApp("stall_watchdog_disconnect").catch((error) => {
          console.error("Stall watchdog reconnect failed:", error.message);
        });
      }
      return;
    }

    const stalledStates = new Set([
      "initializing",
      "loading",
      "authenticated",
      "init_failed",
    ]);

    if (!stalledStates.has(clientState)) {
      return;
    }

    if (hasPersistedSession() && lastReadyAt > 0) {
      console.log(
        `Stall watchdog: stuck in "${clientState}" but session exists — reconnecting`
      );
      reconnectWhatsApp("stall_watchdog_session").catch((error) => {
        console.error("Stall watchdog reconnect failed:", error.message);
      });
      return;
    }

    console.log(
      `No QR for ${STALL_RESET_MS}ms in state "${clientState}" — auto-resetting session`
    );

    resetWhatsAppSession("stall_watchdog").catch((error) => {
      console.error("Stall watchdog reset failed:", error.message);
    });
  }, 30000);
}

function startKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
  }

  keepAliveTimer = setInterval(async () => {
    if (!isReady || clientState !== "ready" || isReconnecting) {
      return;
    }

    try {
      const state = await withTimeout(
        client.getState(),
        20000,
        "keepalive getState"
      );
      if (state !== "CONNECTED") {
        console.warn("Keep-alive: state is", state, "— reconnecting");
        await reconnectWhatsApp("keepalive_not_connected");
      }
    } catch (error) {
      console.warn("Keep-alive failed:", error.message, "— reconnecting");
      try {
        await reconnectWhatsApp("keepalive_failed");
      } catch (reconnectError) {
        console.error("Keep-alive reconnect failed:", reconnectError.message);
      }
    }
  }, KEEPALIVE_MS);
}

function startConnectionMonitor() {
  if (connectionMonitorTimer) {
    clearInterval(connectionMonitorTimer);
  }

  connectionMonitorTimer = setInterval(async () => {
    if (isReconnecting || lastQr) {
      return;
    }

    if (isReady && clientState === "ready") {
      return;
    }

    if (!hasPersistedSession()) {
      return;
    }

    const offlineStates = new Set([
      "disconnected",
      "not_connected",
      "init_failed",
      "reconnecting",
    ]);

    if (offlineStates.has(clientState)) {
      console.log("Connection monitor: recovering", clientState);
      try {
        await reconnectWhatsApp("connection_monitor");
      } catch (error) {
        console.error("Connection monitor failed:", error.message);
      }
    }
  }, CONNECTION_CHECK_MS);
}

function renderQrWaitingPage() {
  const uptimeSec = Math.floor(process.uptime());
  const waitingSec = Math.floor((Date.now() - clientStartedAt) / 1000);
  const detail = initError
    ? `<p style="color:#b91c1c">Error: ${escapeHtml(initError)}</p>`
    : "";
  const resetHint =
    waitingSec >= 60
      ? `<p><a href="/reset-session?confirm=1" style="color:#1d4ed8">Reset session and show new QR</a></p>`
      : `<p><small>If no QR after 2 minutes, <a href="/reset-session?confirm=1">reset session</a>.</small></p>`;

  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"3\">" +
    "<title>Waiting for QR</title></head>" +
    "<body style=\"font-family:sans-serif;text-align:center;padding:2rem;max-width:520px;margin:0 auto\">" +
    "<h2>Waiting for QR code...</h2>" +
    "<p>State: <strong>" +
    escapeHtml(clientState) +
    "</strong> · waiting " +
    waitingSec +
    "s · uptime " +
    uptimeSec +
    "s</p>" +
    detail +
    resetHint +
    "<p>Page refreshes every 3 seconds.</p>" +
    "<p><a href=\"/status\">API status (JSON)</a></p></body></html>"
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function assertWhatsAppConnected() {
  if (!isReady || clientState !== "ready") {
    throw new Error(getNotReadyMessage());
  }

  const state = await getWaConnectionState();

  if (state === "CONNECTED") {
    return;
  }

  if (state === null) {
    console.warn("getState unavailable — proceeding because client emitted ready");
    return;
  }

  const needsQr = new Set([
    "UNPAIRED",
    "UNPAIRED_IDLE",
    "PAIRING",
    "TIMEOUT",
    "TOS_BLOCK",
    "SMB_TOS_BLOCK",
    "PROXYBLOCK",
  ]);

  isReady = false;
  clientState = `wa_${String(state).toLowerCase()}`;

  if (needsQr.has(state)) {
    throw new Error(
      "WhatsApp is not linked. Open /qr, scan the QR code, wait for ready status, then send."
    );
  }

  throw new Error(
    `WhatsApp is not ready (${state}). Wait a moment or open /qr to link again.`
  );
}

function validatePhone(phone) {
  if (typeof phone !== "string" && typeof phone !== "number") {
    return { valid: false, message: "Phone must be a string or number" };
  }

  const digits = String(phone).replace(/\D/g, "");

  if (!digits) {
    return { valid: false, message: "Phone number is invalid" };
  }

  if (digits.length < 10 || digits.length > 15) {
    return {
      valid: false,
      message: "Phone must include country code (10–15 digits)",
    };
  }

  return { valid: true, digits };
}

function validateImageUrl(imageUrl) {
  if (imageUrl === undefined || imageUrl === null || imageUrl === "") {
    return { valid: true, url: null };
  }

  if (typeof imageUrl !== "string") {
    return { valid: false, message: "Image URL must be a string" };
  }

  const trimmed = imageUrl.trim();
  if (!trimmed) {
    return { valid: true, url: null };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        valid: false,
        message: "Image URL must start with http:// or https://",
      };
    }
    return { valid: true, url: trimmed };
  } catch (error) {
    return { valid: false, message: "Invalid image URL" };
  }
}

function validateMessage(message, hasImage) {
  if (message !== undefined && message !== null && typeof message !== "string") {
    return { valid: false, message: "Message must be a string" };
  }

  const trimmed = String(message || "").trim();

  if (!trimmed && !hasImage) {
    return { valid: false, message: "Message or image is required" };
  }

  if (trimmed.length > 4096) {
    return { valid: false, message: "Message exceeds maximum length (4096)" };
  }

  return { valid: true, text: trimmed };
}

app.get("/", (req, res) => {
  res.json({
    name: "WhatsApp API",
    whatsapp: isReady ? "ready" : "not_ready",
    endpoints: {
      qr: "GET /qr",
      resetSession: "GET /reset-session?confirm=1",
      status: "GET /status",
      sendMessageGet:
        "GET /send-message?phone=919876543210&message=Hello&image=https://example.com/pic.jpg",
      sendMessagePost:
        'POST /send-message {phone, message, image | imageBase64, imageMime}',
      health: "GET /health",
      wake: "GET /wake (ping every 10 min to avoid Railway sleep)",
    },
    sessionPersisted: hasPersistedSession(),
    sessionPath: AUTH_PATH,
  });
});

app.get("/wake", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    whatsapp: isReady && clientState === "ready" ? "ready" : clientState,
    sessionPersisted: hasPersistedSession(),
  });
});

app.get("/qr", async (req, res) => {
  if (isReady) {
    return res.send(
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>WhatsApp</title></head>" +
        "<body style=\"font-family:sans-serif;text-align:center;padding:2rem\">" +
        "<h2>WhatsApp is connected</h2><p><a href=\"/status\">Check status</a></p></body></html>"
    );
  }

  if (!lastQr) {
    return res.send(renderQrWaitingPage());
  }

  try {
    const dataUrl = await QRCode.toDataURL(lastQr);
    return res.send(
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"20\">" +
        "<title>Scan WhatsApp QR</title></head>" +
        "<body style=\"font-family:sans-serif;text-align:center;padding:2rem\">" +
        "<h2>Scan with WhatsApp</h2>" +
        "<p>Settings → Linked devices → Link a device</p>" +
        "<img src=\"" + dataUrl + "\" alt=\"WhatsApp QR\" style=\"max-width:320px\">" +
        "<p><small>Refreshes every 20s if QR expires</small></p></body></html>"
    );
  } catch (error) {
    console.error("QR page error:", error.message);
    return res.status(500).send("Failed to generate QR image");
  }
});

app.get("/reset-session", async (req, res) => {
  if (req.query.confirm !== "1") {
    return res.status(400).json({
      status: false,
      message: "Add ?confirm=1 to reset the WhatsApp session and force a new QR.",
    });
  }

  if (!canResetSession(req)) {
    return res.status(403).json({
      status: false,
      message: "Invalid or missing RESET_SECRET.",
    });
  }

  try {
    const result = await resetWhatsAppSession("api_get");
    if (req.accepts("html") && req.query.json !== "1") {
      return res.redirect("/qr");
    }
    return res.json(result);
  } catch (error) {
    if (req.accepts("html") && req.query.json !== "1") {
      return res
        .status(500)
        .send(
          "<!DOCTYPE html><html><body style=\"font-family:sans-serif;padding:2rem\">" +
            "<h2>Reset failed</h2><p>" +
            escapeHtml(error.message || "Failed to reset session") +
            "</p><p><a href=\"/qr\">Back to QR</a></p></body></html>"
        );
    }

    return res.status(500).json({
      status: false,
      message: error.message || "Failed to reset session",
      clientState,
    });
  }
});

app.post("/reset-session", async (req, res) => {
  if (!canResetSession(req)) {
    return res.status(403).json({
      status: false,
      message: "Invalid or missing RESET_SECRET.",
    });
  }

  try {
    const result = await resetWhatsAppSession("api_post");
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error.message || "Failed to reset session",
      clientState,
    });
  }
});

app.get("/status", async (req, res) => {
  const waState = await getWaConnectionState();
  const ready =
    isReady && clientState === "ready" && waState === "CONNECTED";

  res.json({
    status: ready ? "ready" : "not_ready",
    clientState,
    waState: waState || "unknown",
    hasQr: Boolean(lastQr),
    initError: initError || null,
    sessionPersisted: hasPersistedSession(),
    lastReadyAt: lastReadyAt || null,
    waitingSeconds: Math.floor((Date.now() - clientStartedAt) / 1000),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    whatsapp:
      isReady && clientState === "ready" ? "ready" : clientState,
  });
});

const ALLOWED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

function parseImageOptions(source) {
  const url = source.image || source.imageUrl || null;
  const imageCheck = validateImageUrl(url);
  if (!imageCheck.valid) {
    return imageCheck;
  }

  let base64 = source.imageBase64 || source.image_base64 || null;
  let mime = source.imageMime || source.imageMimetype || source.mimeType || null;
  let filename = source.imageFilename || source.filename || "image.jpg";

  if (base64 && typeof base64 === "string") {
    base64 = base64.trim();
    if (base64.includes("base64,")) {
      const header = base64.split(";base64,")[0];
      if (header.startsWith("data:")) {
        mime = mime || header.replace("data:", "");
      }
      base64 = base64.split("base64,")[1];
    }

    if (!mime || !ALLOWED_IMAGE_MIMES.includes(mime)) {
      return {
        valid: false,
        message: "imageMime must be image/jpeg, image/png, image/gif, or image/webp",
      };
    }

    if (base64.length > 10 * 1024 * 1024) {
      return { valid: false, message: "Image file is too large (max ~7MB)" };
    }

    return {
      valid: true,
      url: imageCheck.url,
      base64,
      mime,
      filename,
    };
  }

  return {
    valid: true,
    url: imageCheck.url,
    base64: null,
    mime: null,
    filename: null,
  };
}

async function buildMessageMedia(imageOptions) {
  if (imageOptions.base64) {
    return new MessageMedia(
      imageOptions.mime,
      imageOptions.base64,
      imageOptions.filename
    );
  }

  if (imageOptions.url) {
    return withTimeout(
      MessageMedia.fromUrl(imageOptions.url, {
        unsafeMime: true,
        client,
      }),
      60000,
      "Failed to download image from URL"
    );
  }

  return null;
}

async function handleSendMessage(phone, message, imageSource, res) {
  if ((!isReady || clientState !== "ready") && !hasPersistedSession()) {
    return res.status(503).json({
      status: false,
      message: getNotReadyMessage(),
      clientState,
      needsQr: Boolean(lastQr) || clientState === "qr_pending",
    });
  }

  const phoneCheck = validatePhone(phone);
  if (!phoneCheck.valid) {
    return res.status(400).json({
      status: false,
      message: phoneCheck.message,
    });
  }

  const imageOptions = parseImageOptions(
    typeof imageSource === "string"
      ? { image: imageSource }
      : imageSource || {}
  );

  if (!imageOptions.valid) {
    return res.status(400).json({
      status: false,
      message: imageOptions.message,
    });
  }

  const hasImage = Boolean(imageOptions.url || imageOptions.base64);
  const messageCheck = validateMessage(message, hasImage);
  if (!messageCheck.valid) {
    return res.status(400).json({
      status: false,
      message: messageCheck.message,
    });
  }

  const sendTimeoutMs = hasImage ? 120000 : 90000;
  const queueTimeoutMs = hasImage ? 150000 : 120000;

  return enqueueWaTask(async () => {
    await ensureClientReadyForSend();
    await assertWhatsAppConnected();

    const chatId = await resolveChatId(phoneCheck.digits);
    console.log("Sending to chatId:", chatId, hasImage ? "(with image)" : "");

    const sendOptions = {
      linkPreview: false,
      sendSeen: false,
    };

    async function doSend() {
      if (hasImage) {
        const media = await buildMessageMedia(imageOptions);
        return client.sendMessage(chatId, media, {
          ...sendOptions,
          caption: messageCheck.text || undefined,
        });
      }

      return client.sendMessage(chatId, messageCheck.text, sendOptions);
    }

    try {
      await withTimeout(
        doSend(),
        sendTimeoutMs,
        hasImage
          ? "WhatsApp image send timed out — wait and try again."
          : "WhatsApp send timed out — wait 10 seconds between messages and try again."
      );
    } catch (error) {
      if (String(error.message || "").includes("timed out")) {
        isReady = false;
        clientState = "disconnected";
        chatIdCache.delete(phoneCheck.digits);
        console.error("Send timed out — reconnecting with saved session");
        reconnectWhatsApp("send_timeout").catch((reconnectError) => {
          console.error("Reconnect after send timeout:", reconnectError.message);
        });
      }
      throw error;
    }

    console.log("Message sent", {
      to: phoneCheck.digits,
      image: hasImage,
    });

    return res.json({
      status: true,
      message: hasImage ? "Image sent successfully" : "Message sent successfully",
    });
  }, queueTimeoutMs);
}

app.get("/send-message", async (req, res) => {
  try {
    const { phone, message, image, imageUrl } = req.query;
    await handleSendMessage(phone, message, { image: image || imageUrl }, res);
  } catch (error) {
    console.error("Send message error:", error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        status: false,
        message: error.message || "Failed to send message",
      });
    }
  }
});

app.post("/send-message", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        status: false,
        message: "Request body must be JSON",
      });
    }

    const {
      phone,
      message,
      image,
      imageUrl,
      imageBase64,
      imageMime,
      imageFilename,
    } = req.body;
    await handleSendMessage(phone, message, req.body, res);
  } catch (error) {
    console.error("Send message error:", error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        status: false,
        message: error.message || "Failed to send message",
      });
    }
  }
});

app.use((req, res) => {
  res.status(404).json({
    status: false,
    message: "Route not found",
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({
    status: false,
    message: "Internal server error",
  });
});

async function startWhatsAppClient() {
  clientStartedAt = Date.now();
  clientState = "initializing";
  initError = null;

  try {
    await client.initialize();
    console.log("WhatsApp client initialize() finished");
  } catch (error) {
    initError = error.message;
    clientState = "init_failed";
    console.error("Failed to initialize WhatsApp client:", error.message);
    console.log("Retrying with a clean session in 3s...");

    await delay(3000);

    if (hasPersistedSession()) {
      try {
        await reconnectWhatsApp("init_failed_retry");
        return;
      } catch (reconnectError) {
        console.error("Reconnect after init failed:", reconnectError.message);
      }
    }

    try {
      await resetWhatsAppSession("init_failed");
    } catch (resetError) {
      console.error("Recovery reset failed:", resetError.message);
    }
  }
}

async function startServer() {
  ensureAuthDirectories();

  const server = app.listen(PORT, HOST, () => {
    console.log(`WhatsApp API running on http://${HOST}:${PORT}`);
  });

  startStallWatchdog();
  startKeepAlive();
  startConnectionMonitor();
  startWhatsAppClient();

  const shutdown = async (signal) => {
    console.log(`${signal} received — shutting down`);
    server.close();
    try {
      await client.destroy();
    } catch (error) {
      console.error("Error destroying client:", error.message);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startServer().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
