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
const SESSION_PATH = path.join(AUTH_PATH, "session");

function ensureAuthDirectories() {
  fs.mkdirSync(AUTH_PATH, { recursive: true });
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

ensureAuthDirectories();

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
app.use(express.json({ limit: "1mb" }));

let isReady = false;
let clientState = "initializing";
let lastQr = null;
let isReconnecting = false;
let waQueue = Promise.resolve();
const chatIdCache = new Map();

function enqueueWaTask(task) {
  const run = waQueue.then(task);
  waQueue = run.catch(() => {});
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
  console.error("Authentication failed:", message);
});

client.on("ready", () => {
  isReady = true;
  clientState = "ready";
  lastQr = null;
  chatIdCache.clear();
  console.log("WhatsApp ready");
});

client.on("disconnected", async (reason) => {
  isReady = false;
  clientState = "disconnected";
  console.log("Disconnected", reason ? `(${reason})` : "");

  if (isReconnecting) {
    return;
  }

  isReconnecting = true;
  console.log("Reconnecting WhatsApp client in 5s...");

  setTimeout(async () => {
    try {
      await client.destroy();
    } catch (error) {
      console.error("Destroy before reconnect:", error.message);
    }

    try {
      await client.initialize();
      console.log("WhatsApp reconnect started");
    } catch (error) {
      console.error("Reconnect failed:", error.message);
    } finally {
      isReconnecting = false;
    }
  }, 5000);
});

client.on("loading_screen", (percent, message) => {
  clientState = "loading";
  console.log(`Loading: ${percent}% — ${message}`);
});

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
    return { valid: false, message: "Message or image URL is required" };
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
      status: "GET /status",
      sendMessageGet:
        "GET /send-message?phone=919876543210&message=Hello&image=https://example.com/pic.jpg",
      sendMessagePost:
        'POST /send-message {"phone","message","image"}',
      health: "GET /health",
    },
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
    return res.send(
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"3\">" +
        "<title>Waiting for QR</title></head>" +
        "<body style=\"font-family:sans-serif;text-align:center;padding:2rem\">" +
        "<h2>Waiting for QR code...</h2><p>Page refreshes every 3 seconds.</p></body></html>"
    );
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

app.get("/status", (req, res) => {
  res.json({
    status: isReady ? "ready" : "not_ready",
    clientState,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    whatsapp: isReady ? "ready" : clientState,
  });
});

async function handleSendMessage(phone, message, imageUrl, res) {
  if (!isReady) {
    return res.status(503).json({
      status: false,
      message: "WhatsApp not ready. Scan QR first or wait for session restore.",
      clientState,
    });
  }

  const phoneCheck = validatePhone(phone);
  if (!phoneCheck.valid) {
    return res.status(400).json({
      status: false,
      message: phoneCheck.message,
    });
  }

  const imageCheck = validateImageUrl(imageUrl);
  if (!imageCheck.valid) {
    return res.status(400).json({
      status: false,
      message: imageCheck.message,
    });
  }

  const messageCheck = validateMessage(message, Boolean(imageCheck.url));
  if (!messageCheck.valid) {
    return res.status(400).json({
      status: false,
      message: messageCheck.message,
    });
  }

  const sendTimeoutMs = imageCheck.url ? 120000 : 90000;

  return enqueueWaTask(async () => {
    if (!isReady) {
      return res.status(503).json({
        status: false,
        message: "WhatsApp not ready. Scan QR at /qr",
        clientState,
      });
    }

    const chatId = await resolveChatId(phoneCheck.digits);
    console.log("Sending to chatId:", chatId, imageCheck.url ? "(with image)" : "");

    if (imageCheck.url) {
      const media = await withTimeout(
        MessageMedia.fromUrl(imageCheck.url, {
          unsafeMime: true,
          client,
        }),
        60000,
        "Failed to download image from URL"
      );

      await withTimeout(
        client.sendMessage(chatId, media, {
          caption: messageCheck.text || undefined,
          linkPreview: false,
          sendSeen: false,
        }),
        sendTimeoutMs,
        "WhatsApp image send timed out — wait and try again."
      );
    } else {
      await withTimeout(
        client.sendMessage(chatId, messageCheck.text, {
          linkPreview: false,
          sendSeen: false,
        }),
        sendTimeoutMs,
        "WhatsApp send timed out — wait 10 seconds between messages and try again."
      );
    }

    console.log("Message sent", {
      to: phoneCheck.digits,
      image: Boolean(imageCheck.url),
    });

    return res.json({
      status: true,
      message: imageCheck.url
        ? "Image sent successfully"
        : "Message sent successfully",
    });
  });
}

app.get("/send-message", async (req, res) => {
  try {
    const { phone, message, image, imageUrl } = req.query;
    const imageParam = image || imageUrl;
    await handleSendMessage(phone, message, imageParam, res);
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

    const { phone, message, image, imageUrl } = req.body;
    const imageParam = image || imageUrl;
    await handleSendMessage(phone, message, imageParam, res);
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

async function startServer() {
  ensureAuthDirectories();

  const server = app.listen(PORT, HOST, () => {
    console.log(`WhatsApp API running on http://${HOST}:${PORT}`);
  });

  try {
    await client.initialize();
  } catch (error) {
    console.error("Failed to initialize WhatsApp client:", error.message);
    process.exit(1);
  }

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
