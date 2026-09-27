<?php
/* App Keys: the keys UnraidClaw adds when it calls an installed app's own API.
 *
 * GET  ?action=list          which apps have a key and how it is sent, plus the
 *                            installed containers to pick from. Never a value.
 * POST action=save           name, type (header|bearer|basic), header, username, value
 * POST action=delete         name
 *
 * Changes are POST only, so Unraid's own CSRF check (local_prepend.php) covers
 * them and a key never travels in a URL, where it would end up in logs.
 */
header('Content-Type: application/json');
header('Cache-Control: no-store');

$docroot = $docroot ?? $_SERVER['DOCUMENT_ROOT'] ?? '/usr/local/emhttp';
require_once "$docroot/webGui/include/Wrappers.php";

$file = '/boot/config/plugins/unraidclaw/app-keys.json';

function occKeysFail($message, $status = 400) {
    http_response_code($status);
    echo json_encode(['success' => false, 'error' => $message]);
    exit;
}

function occReadKeys($file) {
    if (!is_file($file)) return [];
    $keys = json_decode(@file_get_contents($file), true);
    return is_array($keys) ? $keys : [];
}

function occWriteKeys($file, $keys) {
    $dir = dirname($file);
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $tmp = $file . '.tmp';
    $json = json_encode((object)$keys, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (@file_put_contents($tmp, $json, LOCK_EX) === false || !@rename($tmp, $file)) {
        @unlink($tmp);
        occKeysFail('Could not write ' . $file, 500);
    }
    @chmod($file, 0600);
}

function occValidText($value, $max = 4096) {
    return is_string($value) && $value !== '' && strlen($value) <= $max && !preg_match('/[\r\n\0]/', $value);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $method === 'POST' ? ($_POST['action'] ?? '') : ($_GET['action'] ?? 'list');

if ($method === 'GET' && $action === 'list') {
    $list = [];
    foreach (occReadKeys($file) as $name => $entry) {
        if (!is_array($entry)) continue;
        $type = $entry['type'] ?? '';
        $list[] = [
            'name' => $name,
            'type' => $type,
            'header' => $type === 'header' ? ($entry['header'] ?? '') : 'Authorization',
            'username' => $type === 'basic' ? ($entry['username'] ?? '') : '',
        ];
    }
    $containers = [];
    exec("docker ps -a --format '{{.Names}}' 2>/dev/null", $containers);
    sort($containers);
    echo json_encode(['success' => true, 'keys' => $list, 'containers' => $containers]);
    exit;
}

if ($method !== 'POST') occKeysFail('Use POST to change App Keys.', 405);

$name = $_POST['name'] ?? '';
if (!is_string($name) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/', $name)) occKeysFail('Pick an installed container.');

$keys = occReadKeys($file);

if ($action === 'delete') {
    unset($keys[$name]);
    occWriteKeys($file, $keys);
    echo json_encode(['success' => true]);
    exit;
}

if ($action !== 'save') occKeysFail('Unknown action.');

$type = $_POST['type'] ?? '';
$value = $_POST['value'] ?? '';
if (!occValidText($value)) occKeysFail('Enter the key.');

switch ($type) {
    case 'header':
        $header = $_POST['header'] ?? '';
        if (!is_string($header) || !preg_match('/^[A-Za-z0-9-]{1,64}$/', $header)) occKeysFail('Enter the header name the app expects, such as x-api-key.');
        $keys[$name] = ['type' => 'header', 'header' => $header, 'value' => $value];
        break;
    case 'bearer':
        $keys[$name] = ['type' => 'bearer', 'value' => $value];
        break;
    case 'basic':
        $username = $_POST['username'] ?? '';
        if (!occValidText($username, 256) || strpos($username, ':') !== false) occKeysFail('Enter the user name, without ":".');
        $keys[$name] = ['type' => 'basic', 'username' => $username, 'value' => $value];
        break;
    default:
        occKeysFail('Pick how the app expects the key.');
}

occWriteKeys($file, $keys);
echo json_encode(['success' => true]);
