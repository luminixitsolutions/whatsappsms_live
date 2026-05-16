<?php
/**
 * WhatsApp message form — integrates with Node.js WhatsApp API.
 * Compatible with PHP 7+, Laragon, XAMPP, and live servers.
 *
 * Set WHATSAPP_API_URL to match your Node server (default port 3000).
 */

// --- Configuration (adjust for production) ---
define('WHATSAPP_API_URL', getenv('WHATSAPP_API_URL') ?: 'http://localhost:3000/send-message');
define('CURL_TIMEOUT', 30);

/**
 * Normalize and validate phone (country code + digits only).
 *
 * @param string $phone Raw input
 * @return array{ok:bool, phone?:string, error?:string}
 */
function validatePhoneInput($phone)
{
    $phone = trim((string) $phone);

    if ($phone === '') {
        return ['ok' => false, 'error' => 'Phone number is required.'];
    }

    // Remove spaces, dashes, plus, parentheses, etc.
    $digits = preg_replace('/\D+/', '', $phone);

    if ($digits === '' || $digits === null) {
        return ['ok' => false, 'error' => 'Phone number is invalid.'];
    }

    $len = strlen($digits);

    if ($len < 10 || $len > 15) {
        return [
            'ok' => false,
            'error' => 'Phone must include country code (10–15 digits, e.g. 919876543210).',
        ];
    }

    // 10-digit only: assume India (+91) if no country code provided
    if ($len === 10) {
        $digits = '91' . $digits;
        error_log('[WhatsApp Form] Prepended country code 91 to 10-digit number.');
    }

    return ['ok' => true, 'phone' => $digits];
}

/**
 * Validate message text.
 *
 * @param string $message Raw input
 * @return array{ok:bool, message?:string, error?:string}
 */
function validateMessageInput($message)
{
    $message = trim((string) $message);

    if ($message === '') {
        return ['ok' => false, 'error' => 'Message is required.'];
    }

    if (strlen($message) > 4096) {
        return ['ok' => false, 'error' => 'Message is too long (maximum 4096 characters).'];
    }

    return ['ok' => true, 'message' => $message];
}

/**
 * Send WhatsApp message via Node.js API (POST JSON).
 *
 * @param string $phone   Digits with country code (e.g. 919876543210)
 * @param string $message Message body
 * @return array{success:bool, message:string, data?:array, http_code?:int}
 */
function sendWhatsAppMessage($phone, $message)
{
    $payload = json_encode([
        'phone'   => $phone,
        'message' => $message,
    ]);

    if ($payload === false) {
        error_log('[WhatsApp Form] JSON encode failed: ' . json_last_error_msg());
        return [
            'success' => false,
            'message' => 'Could not prepare request data.',
        ];
    }

    error_log('[WhatsApp Form] Sending to ' . WHATSAPP_API_URL . ' phone=' . $phone);

    $ch = curl_init(WHATSAPP_API_URL);

    if ($ch === false) {
        error_log('[WhatsApp Form] curl_init failed');
        return [
            'success' => false,
            'message' => 'Could not initialize connection to WhatsApp API.',
        ];
    }

    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'Accept: application/json',
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => CURL_TIMEOUT,
        CURLOPT_FOLLOWLOCATION => false,
    ]);

    $responseBody = curl_exec($ch);
    $curlErrNo    = curl_errno($ch);
    $curlError    = curl_error($ch);
    $httpCode     = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($curlErrNo !== 0) {
        error_log('[WhatsApp Form] cURL error (' . $curlErrNo . '): ' . $curlError);
        return [
            'success'   => false,
            'message'   => 'Cannot reach WhatsApp API. Is the Node server running?',
            'http_code' => 0,
        ];
    }

    if ($responseBody === false || $responseBody === '') {
        error_log('[WhatsApp Form] Empty response, HTTP ' . $httpCode);
        return [
            'success'   => false,
            'message'   => 'WhatsApp API returned an empty response.',
            'http_code' => $httpCode,
        ];
    }

    $data = json_decode($responseBody, true);

    if (json_last_error() !== JSON_ERROR_NONE) {
        error_log('[WhatsApp Form] Invalid JSON: ' . json_last_error_msg() . ' body=' . substr($responseBody, 0, 200));
        return [
            'success'   => false,
            'message'   => 'Invalid response from WhatsApp API.',
            'http_code' => $httpCode,
        ];
    }

    error_log('[WhatsApp Form] API HTTP ' . $httpCode . ' response: ' . $responseBody);

    // Node API: { "status": true|false, "message": "..." }
    $apiOk  = !empty($data['status']);
    $apiMsg = isset($data['message']) ? (string) $data['message'] : 'Unknown API response.';

    if ($httpCode >= 500) {
        return [
            'success'   => false,
            'message'   => $apiMsg ?: 'WhatsApp API server error.',
            'data'      => $data,
            'http_code' => $httpCode,
        ];
    }

    if (!$apiOk) {
        return [
            'success'   => false,
            'message'   => $apiMsg,
            'data'      => $data,
            'http_code' => $httpCode,
        ];
    }

    return [
        'success'   => true,
        'message'   => $apiMsg ?: 'Message sent successfully',
        'data'      => $data,
        'http_code' => $httpCode,
    ];
}

// --- Handle form submission ---
$alertType = '';
$alertText = '';
$oldPhone  = '';
$oldMessage = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $oldPhone   = isset($_POST['phone']) ? (string) $_POST['phone'] : '';
    $oldMessage = isset($_POST['message']) ? (string) $_POST['message'] : '';

    error_log('[WhatsApp Form] POST received');

    $phoneCheck = validatePhoneInput($oldPhone);
    if (!$phoneCheck['ok']) {
        $alertType = 'error';
        $alertText = $phoneCheck['error'];
    } else {
        $messageCheck = validateMessageInput($oldMessage);
        if (!$messageCheck['ok']) {
            $alertType = 'error';
            $alertText = $messageCheck['error'];
        } else {
            $result = sendWhatsAppMessage($phoneCheck['phone'], $messageCheck['message']);

            if ($result['success']) {
                $alertType = 'success';
                $alertText = $result['message'];
                $oldPhone  = '';
                $oldMessage = '';
            } else {
                $alertType = 'error';
                $alertText = $result['message'];
            }
        }
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Send WhatsApp Message</title>
    <style>
        :root {
            --bg: #0f172a;
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

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
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

        .card-header {
            text-align: center;
            margin-bottom: 1.75rem;
        }

        .logo {
            width: 56px;
            height: 56px;
            background: var(--primary);
            border-radius: 50%;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 1rem;
            font-size: 1.75rem;
        }

        .card-header h1 {
            font-size: 1.35rem;
            font-weight: 700;
            margin-bottom: 0.35rem;
        }

        .card-header p {
            font-size: 0.875rem;
            color: var(--muted);
        }

        .alert {
            padding: 0.875rem 1rem;
            border-radius: 10px;
            font-size: 0.9rem;
            margin-bottom: 1.25rem;
            line-height: 1.45;
        }

        .alert-success {
            background: var(--success-bg);
            color: var(--success);
            border: 1px solid #bbf7d0;
        }

        .alert-error {
            background: var(--danger-bg);
            color: var(--danger);
            border: 1px solid #fecaca;
        }

        .form-group {
            margin-bottom: 1.25rem;
        }

        label {
            display: block;
            font-size: 0.875rem;
            font-weight: 600;
            margin-bottom: 0.4rem;
        }

        .hint {
            font-size: 0.75rem;
            color: var(--muted);
            margin-top: 0.35rem;
        }

        input[type="text"],
        textarea {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 1px solid var(--border);
            border-radius: 10px;
            font-size: 1rem;
            font-family: inherit;
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        input[type="text"]:focus,
        textarea:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(37, 211, 102, 0.2);
        }

        textarea {
            min-height: 120px;
            resize: vertical;
        }

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
            transition: background 0.2s, transform 0.1s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .btn:hover:not(:disabled) {
            background: var(--primary-dark);
        }

        .btn:active:not(:disabled) {
            transform: scale(0.98);
        }

        .btn:disabled {
            opacity: 0.75;
            cursor: not-allowed;
        }

        .spinner {
            width: 18px;
            height: 18px;
            border: 2px solid rgba(255, 255, 255, 0.35);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
            display: none;
        }

        .btn.is-loading .spinner {
            display: inline-block;
        }

        .btn.is-loading .btn-text {
            opacity: 0.9;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .footer-note {
            margin-top: 1.25rem;
            text-align: center;
            font-size: 0.75rem;
            color: var(--muted);
        }

        @media (max-width: 480px) {
            .card {
                padding: 1.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="card-header">
            <div class="logo" aria-hidden="true">💬</div>
            <h1>Send WhatsApp</h1>
            <p>Powered by Node.js WhatsApp API</p>
        </div>

        <?php if ($alertType !== ''): ?>
            <div class="alert alert-<?php echo $alertType === 'success' ? 'success' : 'error'; ?>" role="alert">
                <?php echo htmlspecialchars($alertText, ENT_QUOTES, 'UTF-8'); ?>
            </div>
        <?php endif; ?>

        <form id="whatsappForm" method="post" action="" novalidate>
            <div class="form-group">
                <label for="phone">Phone Number</label>
                <input
                    type="text"
                    id="phone"
                    name="phone"
                    inputmode="numeric"
                    autocomplete="tel"
                    placeholder="919876543210"
                    value="<?php echo htmlspecialchars($oldPhone, ENT_QUOTES, 'UTF-8'); ?>"
                    required
                >
                <p class="hint">Country code + number (e.g. 91 for India). No + or spaces needed.</p>
            </div>

            <div class="form-group">
                <label for="message">Message</label>
                <textarea
                    id="message"
                    name="message"
                    placeholder="Type your message..."
                    required
                ><?php echo htmlspecialchars($oldMessage, ENT_QUOTES, 'UTF-8'); ?></textarea>
            </div>

            <button type="submit" class="btn" id="submitBtn">
                <span class="spinner" aria-hidden="true"></span>
                <span class="btn-text">Send Message</span>
            </button>
        </form>

        <p class="footer-note">API: <?php echo htmlspecialchars(WHATSAPP_API_URL, ENT_QUOTES, 'UTF-8'); ?></p>
    </div>

    <script>
        (function () {
            var form = document.getElementById('whatsappForm');
            var btn = document.getElementById('submitBtn');

            form.addEventListener('submit', function () {
                btn.disabled = true;
                btn.classList.add('is-loading');
                btn.querySelector('.btn-text').textContent = 'Sending...';
            });
        })();
    </script>
</body>
</html>
