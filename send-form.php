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
        input[type="text"], input[type="url"], textarea {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 1px solid var(--border);
            border-radius: 10px;
            font-size: 1rem;
            font-family: inherit;
        }
        #imagePreview {
            margin-top: 0.5rem;
            max-width: 100%;
            max-height: 160px;
            border-radius: 8px;
            display: none;
        }
        input[type="file"] {
            width: 100%;
            font-size: 0.875rem;
            padding: 0.35rem 0;
        }
        .or-divider {
            text-align: center;
            font-size: 0.75rem;
            color: var(--muted);
            margin: 0.5rem 0;
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
                <label for="message">Message <span style="font-weight:400;color:var(--muted)">(caption if image)</span></label>
                <textarea id="message" name="message" placeholder="Type your message..."></textarea>
            </div>
            <div class="form-group">
                <label for="imageFile">Choose image <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
                <input type="file" id="imageFile" name="imageFile" accept="image/jpeg,image/png,image/gif,image/webp">
                <p class="hint">JPG, PNG, GIF, WebP - max 5MB. Message text becomes caption.</p>
                <p class="or-divider">- or use image URL -</p>
                <label for="image" style="margin-top:0.5rem">Image URL</label>
                <input type="url" id="image" name="image" placeholder="https://example.com/photo.jpg">
                <img id="imagePreview" alt="Preview">
            </div>
            <button type="submit" class="btn" id="submitBtn">
                <span class="spinner" aria-hidden="true"></span>
                <span class="btn-text">Send Message</span>
            </button>
        </form>

        <p class="footer-note">
            Wait 3+ seconds between messages.
            <br>
            <a href="<?php echo htmlspecialchars(WHATSAPP_API_BASE, ENT_QUOTES, 'UTF-8'); ?>/status" target="_blank" rel="noopener">Check API status</a>
            ·
            <a href="<?php echo htmlspecialchars(WHATSAPP_API_BASE, ENT_QUOTES, 'UTF-8'); ?>/qr" target="_blank" rel="noopener">QR login</a>
        </p>
    </div>

    <script>
    (function () {
        var API_URL = <?php echo json_encode(WHATSAPP_API_URL, JSON_UNESCAPED_SLASHES); ?>;
        var API_BASE = <?php echo json_encode(WHATSAPP_API_BASE, JSON_UNESCAPED_SLASHES); ?>;
        var QR_URL = API_BASE + '/qr';
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

        var TEXT_TIMEOUT_MS = 125000;
        var IMAGE_TIMEOUT_MS = 155000;
        var lastSubmitAt = 0;
        var MIN_GAP_MS = 3000;

        var selectedFile = null;
        var preview = document.getElementById('imagePreview');
        var imageUrlInput = document.getElementById('image');
        var imageFileInput = document.getElementById('imageFile');

        function showPreview(src) {
            preview.src = src;
            preview.style.display = 'block';
            preview.onerror = function () { preview.style.display = 'none'; };
        }

        imageUrlInput.addEventListener('input', function () {
            selectedFile = null;
            imageFileInput.value = '';
            var url = this.value.trim();
            if (!url) {
                preview.style.display = 'none';
                preview.removeAttribute('src');
                return;
            }
            showPreview(url);
        });

        imageFileInput.addEventListener('change', function () {
            imageUrlInput.value = '';
            selectedFile = this.files && this.files[0] ? this.files[0] : null;
            if (!selectedFile) {
                preview.style.display = 'none';
                preview.removeAttribute('src');
                return;
            }
            var allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
            if (allowed.indexOf(selectedFile.type) === -1) {
                showAlert('error', 'Please choose JPG, PNG, GIF, or WebP.');
                this.value = '';
                selectedFile = null;
                return;
            }
            if (selectedFile.size > 5 * 1024 * 1024) {
                showAlert('error', 'Image must be 5MB or smaller.');
                this.value = '';
                selectedFile = null;
                return;
            }
            showPreview(URL.createObjectURL(selectedFile));
        });

        function readImageFile(file) {
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function () {
                    var result = reader.result;
                    var base64 = result.split('base64,')[1];
                    resolve({
                        imageBase64: base64,
                        imageMime: file.type,
                        imageFilename: file.name
                    });
                };
                reader.onerror = function () { reject(new Error('Could not read image file.')); };
                reader.readAsDataURL(file);
            });
        }

        function buildPayload(phone, message, imageUrl, fileData) {
            var payload = { phone: phone, message: message };
            if (fileData) {
                payload.imageBase64 = fileData.imageBase64;
                payload.imageMime = fileData.imageMime;
                payload.imageFilename = fileData.imageFilename;
            } else if (imageUrl) {
                payload.image = imageUrl;
            }
            return payload;
        }

        function resetButton() {
            btn.disabled = false;
            btn.classList.remove('is-loading');
            btnText.textContent = 'Send Message';
        }

        function fetchWithTimeout(url, options, timeoutMs) {
            var controller = new AbortController();
            var timer = setTimeout(function () {
                controller.abort();
            }, timeoutMs);

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

        function sendGet(phone, message, imageUrl, timeoutMs) {
            var url = API_URL + '?phone=' + encodeURIComponent(phone) + '&message=' + encodeURIComponent(message);
            if (imageUrl) url += '&image=' + encodeURIComponent(imageUrl);
            return fetchWithTimeout(url, { method: 'GET', mode: 'cors' }, timeoutMs).then(parseApiResponse);
        }

        function sendPost(phone, message, imageUrl, fileData, timeoutMs) {
            return fetchWithTimeout(API_URL, {
                method: 'POST',
                mode: 'cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildPayload(phone, message, imageUrl, fileData))
            }, timeoutMs).then(parseApiResponse);
        }

        function checkApiStatus() {
            return fetchWithTimeout(API_BASE + '/status', { method: 'GET', mode: 'cors' }, 25000)
                .then(parseApiResponse)
                .then(function (result) {
                    if (!result || !result.data) {
                        return { ok: false, error: 'Cannot reach WhatsApp API. Check Railway is running.' };
                    }
                    var data = result.data;
                    if (data.status === 'ready') {
                        return { ok: true };
                    }
                    if (data.hasQr || data.clientState === 'qr_pending' || data.waState === 'UNPAIRED') {
                        return {
                            ok: false,
                            error: 'WhatsApp is not linked. Open QR login, scan with your phone, wait until status is ready, then send.',
                            qr: true
                        };
                    }
                    if (data.clientState === 'loading' || data.clientState === 'authenticated') {
                        return {
                            ok: false,
                            error: 'WhatsApp is still connecting on Railway — wait 30 seconds and try again.'
                        };
                    }
                    return {
                        ok: false,
                        error: 'WhatsApp API is not ready (' + (data.clientState || 'unknown') + '). Check status link below.'
                    };
                })
                .catch(function () {
                    return { ok: false, error: 'Cannot reach WhatsApp API. Check Railway deployment.' };
                });
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();

            var now = Date.now();
            if (now - lastSubmitAt < MIN_GAP_MS) {
                var waitSec = Math.ceil((MIN_GAP_MS - (now - lastSubmitAt)) / 1000);
                showAlert('error', 'Please wait ' + waitSec + ' second(s) before sending again.');
                return;
            }

            var phoneCheck = normalizePhone(document.getElementById('phone').value);
            if (!phoneCheck.ok) { showAlert('error', phoneCheck.error); return; }

            var messageRaw = document.getElementById('message').value.trim();
            var imageRaw = imageUrlInput.value.trim();
            var hasFile = Boolean(selectedFile);

            if (!messageRaw && !imageRaw && !hasFile) {
                showAlert('error', 'Enter a message and/or choose an image.');
                return;
            }

            if (imageRaw && hasFile) {
                showAlert('error', 'Use either choose image OR image URL, not both.');
                return;
            }

            if (imageRaw) {
                try {
                    var imgUrl = new URL(imageRaw);
                    if (imgUrl.protocol !== 'http:' && imgUrl.protocol !== 'https:') {
                        showAlert('error', 'Image URL must start with http:// or https://');
                        return;
                    }
                } catch (err) {
                    showAlert('error', 'Invalid image URL.');
                    return;
                }
            }

            btn.disabled = true;
            btn.classList.add('is-loading');
            btnText.textContent = 'Checking WhatsApp...';
            alertBox.style.display = 'none';

            checkApiStatus().then(function (statusCheck) {
                if (!statusCheck.ok) {
                    resetButton();
                    var msg = statusCheck.error;
                    if (statusCheck.qr) {
                        msg += ' QR: ' + QR_URL;
                    }
                    showAlert('error', msg);
                    return;
                }

                lastSubmitAt = Date.now();
                var hasImage = Boolean(imageRaw || hasFile);
                var timeoutMs = hasImage ? IMAGE_TIMEOUT_MS : TEXT_TIMEOUT_MS;

                btn.disabled = true;
                btn.classList.add('is-loading');
                btnText.textContent = hasImage ? 'Sending image...' : 'Sending...';

                var safetyTimer = setTimeout(function () {
                    resetButton();
                    showAlert('error', 'Request timed out. Wait 5 seconds, then try again.');
                }, timeoutMs + 2000);

                var sendPromise;
                if (hasFile) {
                    sendPromise = readImageFile(selectedFile).then(function (fileData) {
                        return sendPost(phoneCheck.phone, messageRaw, null, fileData, timeoutMs);
                    });
                } else if (imageRaw) {
                    sendPromise = sendPost(phoneCheck.phone, messageRaw, imageRaw, null, timeoutMs);
                } else {
                    sendPromise = sendGet(phoneCheck.phone, messageRaw, null, timeoutMs);
                }

                return sendPromise
                .then(function (result) {
                    if (!result) {
                        showAlert('error', 'Cannot reach Railway API. Check status link below.');
                        return;
                    }
                    if (result.data && result.data.status === true) {
                        showAlert('success', result.data.message || 'Message sent successfully');
                        form.reset();
                        selectedFile = null;
                        preview.style.display = 'none';
                        lastSubmitAt = Date.now();
                        return;
                    }
                    showAlert('error', (result.data && result.data.message) || result.body || 'Failed to send message.');
                })
                .catch(function (err) {
                    if (err && err.name === 'AbortError') {
                        showAlert('error', 'Request timed out. WhatsApp may be slow - try again.');
                    } else if (err && err.message) {
                        showAlert('error', err.message);
                    } else {
                        showAlert('error', 'Network error. Check API status is ready, then try again.');
                    }
                })
                .finally(function () {
                    clearTimeout(safetyTimer);
                    resetButton();
                });
            });
        });
    })();
    </script>
</body>
</html>
