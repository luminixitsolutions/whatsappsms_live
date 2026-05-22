# Railway — keep WhatsApp linked (no daily QR scan)

After you scan the QR **once**, the session is stored in `.wwebjs_auth`. These steps stop disconnects and “timeout on day 2”.

## 1. Persistent volume (required)

Without a volume, every Railway redeploy/restart **deletes** the session → you must scan QR again.

1. Railway project → your service → **Volumes**
2. Add volume:
   - **Mount path:** `/app/.wwebjs_auth`
   - Size: 1 GB is enough
3. Redeploy

Optional cache (faster restarts):

- **Mount path:** `/app/.wwebjs_cache`

## 2. Keep the service awake (recommended)

Free/low tiers **sleep** when idle. After sleep, Chrome/WhatsApp can be stale → send timeout.

Ping every **10 minutes** (free cron):

- URL: `https://whatsappsmslive-production.up.railway.app/wake`
- Method: GET

Examples: [cron-job.org](https://cron-job.org), UptimeRobot, or GitHub Actions schedule.

The app also runs an internal keep-alive every 4 minutes when connected.

## 3. First link

1. Open `/qr` and scan with WhatsApp (Linked devices).
2. Wait **2–3 minutes** before closing/redeploying (session files must finish writing to the volume).
3. Check `/status` → `"status":"ready"`, `"sessionPersisted":true`.

## 4. If day 2 shows timeout

1. Open `/status` — if `sessionPersisted` is `false`, add the volume and scan QR once.
2. If `sessionPersisted` is `true` but not ready, wait 1–2 minutes (auto-reconnect) or call `/wake`.
3. Only use `/reset-session?confirm=1` if stuck (that **deletes** the link and requires a new QR scan).
