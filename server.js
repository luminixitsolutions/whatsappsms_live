const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const AUTH_PATH = path.resolve(__dirname, ".wwebjs_auth");
const SESSION_PATH = path.join(AUTH_PATH, "session");

function ensureAuthDirectories() {
  fs.mkdirSync(AUTH_PATH, { recursive: true });
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

ensureAuthDirectories();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let isReady = false;
let clientState = "initializing";

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_PATH,
    clientId: "default",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

client.on("qr", (qr) => {
  clientState = "qr_pending";
  isReady = false;
  console.log("QR received — scan with WhatsApp (Linked Devices):");
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
  console.log("WhatsApp ready");
});

client.on("disconnected", (reason) => {
  isReady = false;
  clientState = "disconnected";
  console.log("Disconnected", reason ? `(${reason})` : "");
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

function validateMessage(message) {
  if (typeof message !== "string") {
    return { valid: false, message: "Message must be a string" };
  }

  const trimmed = message.trim();

  if (!trimmed) {
    return { valid: false, message: "Message cannot be empty" };
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
      status: "GET /status",
      sendMessageGet:
        "GET /send-message?phone=919876543210&message=Hello",
      sendMessagePost: "POST /send-message",
      health: "GET /health",
    },
  });
});

app.get("/status", (req, res) => {
  res.json({
    status: isReady ? "ready" : "not_ready",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    whatsapp: isReady ? "ready" : clientState,
  });
});

async function handleSendMessage(phone, message, res) {
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

  const messageCheck = validateMessage(message);
  if (!messageCheck.valid) {
    return res.status(400).json({
      status: false,
      message: messageCheck.message,
    });
  }

  const chatId = `${phoneCheck.digits}@c.us`;
  await client.sendMessage(chatId, messageCheck.text);

  console.log("Message sent", { to: phoneCheck.digits });

  return res.json({
    status: true,
    message: "Message sent successfully",
  });
}

app.get("/send-message", async (req, res) => {
  try {
    const { phone, message } = req.query;
    await handleSendMessage(phone, message, res);
  } catch (error) {
    console.error("Send message error:", error.message);
    return res.status(500).json({
      status: false,
      message: error.message || "Failed to send message",
    });
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

    const { phone, message } = req.body;
    await handleSendMessage(phone, message, res);
  } catch (error) {
    console.error("Send message error:", error.message);
    return res.status(500).json({
      status: false,
      message: error.message || "Failed to send message",
    });
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
