<?php
/**
 * WhatsApp send form — calls Railway API from the browser (works on shared hosting).
 * https://whatsappsmslive-production.up.railway.app
 */
define(
    'WHATSAPP_API_BASE',
    getenv('WHATSAPP_API_BASE') ?: 'https://whatsappsmslive-production.up.railway.app'
);
define('WHATSAPP_API_URL', WHATSAPP_API_BASE . '/send-message');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Send WhatsApp Message</title>
    <style>
        :root {
            --card: #ffffff;
            --primary: #25d366;
            --primary-dark: #1da851;
            --danger: #dc2626;
            --danger-bg: #fef2f2;
            --success: #16a34a;
            --success-bg: #f0fdf4;
            --text: #1e293b;
            --muted: #64748b;
            --border: #e2e8f0;
            --shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: "Segoe UI", system-ui, sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.25rem;
            color: var(--text);
        }
        .card {
            background: var(--card);
            width: 100%;
            max-width: 440px;
            border-radius: 16px;
            box-shadow: var(--shadow);
            padding: 2rem;
        }
        .card-header { text-align: center; margin-bottom: 1.75rem; }
        .logo {
            width: 56px; height: 56px;
            background: var(--primary);
            border-radius: 50%;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 1rem;
            font-size: 1.75rem;
        }
        .card-header h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 0.35rem; }
        .card-header p { font-size: 0.875rem; color: var(--muted); }
        .alert {
            padding: 0.875rem 1rem;
            border-radius: 10px;
            font-size: 0.9rem;
            margin-bottom: 1.25rem;
            line-height: 1.45;
        }
        .alert-success { background: var(--success-bg); color: var(--success); border: 1px solid #bbf7d0; }
        .alert-error { background: var(--danger-bg); color: var(--danger); border: 1px solid #fecaca; }
        .form-group { margin-bottom: 1.25rem; }
        label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.4rem; }
        .hint { font-size: 0.75rem; color: var(--muted); margin-top: 0.35rem; }
        input[type="text"], textarea {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 1px solid var(--border);
            border-radius: 10px;
            font-size: 1rem;
            font-family: inherit;
        }
        input:focus, textarea:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(37, 211, 102, 0.2);
        }
        textarea { min-height: 120px; resize: vertical; }
        .btn {
            width: 100%;
            padding: 0.9rem 1rem;
            border: none;
            border-radius: 10px;
            background: var(--primary);
            color: #fff;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }
        .btn:hover:not(:disabled) { background: var(--primary-dark); }
        .btn:disabled { opacity: 0.75; cursor: not-allowed; }
        .spinner {
            width: 18px; height: 18px;
            border: 2px solid rgba(255,255,255,0.35);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
            display: none;
        }
        .btn.is-loading .spinner { display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .footer-note { margin-top: 1.25rem; text-align: center; font-size: 0.75rem; color: var(--muted); }
        .footer-note a { color: #2563eb; }
    </style>
</head>
<body>
    <div class="card">
        <div class="card-header">
            <div class="logo" aria-hidden="true">💬</div>
            <h1>Send WhatsApp</h1>
            <p>API: Railway (browser → <?php echo htmlspecialchars(WHATSAPP_API_BASE, ENT_QUOTES, 'UTF-8'); ?>)</p>
        </div>

        <div id="alertBox" class="alert" role="alert" style="display:none"></div>

        <form id="whatsappForm" novalidate>
            <div class="form-group">
                <label for="phone">Phone Number</label>
                <input type="text" id="phone" name="phone" inputmode="numeric" autocomplete="tel" placeholder="919876543210" required>
                <p class="hint">Country code + number (e.g. 919876543210). + and spaces are OK.</p>
            </div>
            <div class="form-group">
                <label for="message">Message</label>
                <textarea id="message" name="message" placeholder="Type your message..." required></textarea>
            </div>
            <button type="submit" class="btn" id="submitBtn">
                <span class="spinner" aria-hidden="true"></span>
                <span class="btn-text">Send Message</span>
            </button>
        </form>

        <p class="footer-note">
            <a href="<?php echo htmlspecialchars(WHATSAPP_API_BASE, ENT_QUOTES, 'UTF-8'); ?>/status" target="_blank" rel="noopener">Check API status</a>
            ·
            <a href="<?php echo htmlspecialchars(WHATSAPP_API_BASE, ENT_QUOTES, 'UTF-8'); ?>/qr" target="_blank" rel="noopener">QR login</a>
        </p>
    </div>

    <script>
    (function () {
        var API_URL = <?php echo json_encode(WHATSAPP_API_URL, JSON_UNESCAPED_SLASHES); ?>;
        var form = document.getElementById('whatsappForm');
        var btn = document.getElementById('submitBtn');
        var alertBox = document.getElementById('alertBox');
        var btnText = btn.querySelector('.btn-text');

        function showAlert(type, text) {
            alertBox.style.display = 'block';
            alertBox.className = 'alert alert-' + type;
            alertBox.textContent = text;
        }

        function normalizePhone(raw) {
            var digits = String(raw).replace(/\D/g, '');
            if (!digits) return { ok: false, error: 'Phone number is required.' };
            if (digits.length < 10 || digits.length > 15) {
                return { ok: false, error: 'Use country code + number (e.g. 919876543210).' };
            }
            if (digits.length === 10) digits = '91' + digits;
            return { ok: true, phone: digits };
        }

        var REQUEST_TIMEOUT_MS = 65000;

        function resetButton() {
            btn.disabled = false;
            btn.classList.remove('is-loading');
            btnText.textContent = 'Send Message';
        }

        function fetchWithTimeout(url, options) {
            var controller = new AbortController();
            var timer = setTimeout(function () {
                controller.abort();
            }, REQUEST_TIMEOUT_MS);

            return fetch(url, Object.assign({}, options, { signal: controller.signal }))
                .finally(function () {
                    clearTimeout(timer);
                });
        }

        function parseApiResponse(res) {
            return res.text().then(function (body) {
                var data;
                try { data = JSON.parse(body); } catch (e) { data = null; }
                return { ok: res.ok, data: data, body: body };
            });
        }

        function sendGet(phone, message) {
            var url = API_URL + '?phone=' + encodeURIComponent(phone) + '&message=' + encodeURIComponent(message);
            return fetchWithTimeout(url, { method: 'GET', mode: 'cors' }).then(parseApiResponse);
        }

        function sendPost(phone, message) {
            return fetchWithTimeout(API_URL, {
                method: 'POST',
                mode: 'cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone, message: message })
            }).then(parseApiResponse);
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var phoneCheck = normalizePhone(document.getElementById('phone').value);
            if (!phoneCheck.ok) { showAlert('error', phoneCheck.error); return; }

            var messageRaw = document.getElementById('message').value.trim();
            if (!messageRaw) { showAlert('error', 'Message is required.'); return; }

            btn.disabled = true;
            btn.classList.add('is-loading');
            btnText.textContent = 'Sending...';
            alertBox.style.display = 'none';

            var safetyTimer = setTimeout(function () {
                resetButton();
                showAlert('error', 'Request timed out. Try again or open the API status link below.');
            }, REQUEST_TIMEOUT_MS + 3000);

            sendGet(phoneCheck.phone, messageRaw)
                .catch(function () {
                    return sendPost(phoneCheck.phone, messageRaw);
                })
                .then(function (result) {
                    if (!result) {
                        showAlert('error', 'Cannot reach Railway API. Check status link below.');
                        return;
                    }
                    if (result.data && result.data.status === true) {
                        showAlert('success', result.data.message || 'Message sent successfully');
                        form.reset();
                        return;
                    }
                    showAlert('error', (result.data && result.data.message) || result.body || 'Failed to send message.');
                })
                .catch(function (err) {
                    if (err && err.name === 'AbortError') {
                        showAlert('error', 'Request timed out. WhatsApp may be slow — try again.');
                    } else {
                        showAlert('error', 'Network error. Check API status is ready, then try again.');
                    }
                })
                .finally(function () {
                    clearTimeout(safetyTimer);
                    resetButton();
                });
        });
    })();
    </script>
</body>
</html>
