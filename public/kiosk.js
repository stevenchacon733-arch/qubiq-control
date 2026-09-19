const $ = (selector) => document.querySelector(selector);

function msg(element, text, ok = false) {
  element.textContent = text;
  element.className = `message show ${ok ? 'success' : 'error'}`;
}

function clearMsg(element) {
  element.textContent = '';
  element.className = 'message';
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Error en la solicitud.');
  return data;
}

let qrTtlSeconds = 45;
let lastQrUrl = '';

async function reloadQr() {
  try {
    const response = await fetch(`/api/admin/qr.png?t=${Date.now()}`, { credentials: 'same-origin' });
    if (response.status === 401) { location.href = '/admin.html'; return false; }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo generar el QR.');
    }
    const blob = await response.blob();
    if (lastQrUrl) URL.revokeObjectURL(lastQrUrl);
    lastQrUrl = URL.createObjectURL(blob);
    $('#qr').src = lastQrUrl;
    clearMsg($('#kioskMsg'));
    return true;
  } catch (error) {
    $('#qr').removeAttribute('src');
    msg($('#kioskMsg'), error.message);
    return false;
  }
}

function startQrLoop() {
  clearInterval(window.qrInterval);
  const ttl = Math.max(10, Number(qrTtlSeconds || 45));
  let remaining = ttl;
  const tick = async () => {
    const ok = await reloadQr();
    remaining = ttl;
    $('#qrTimer').textContent = ok ? remaining : '--';
  };
  tick();
  window.qrInterval = setInterval(() => {
    remaining -= 1;
    $('#qrTimer').textContent = Math.max(remaining, 0);
    if (remaining <= 0) tick();
  }, 1000);
}

async function boot() {
  let status = {};
  try { status = await api('/api/status'); } catch { /* seguimos con los valores por defecto */ }
  qrTtlSeconds = status.qrTtlSeconds || 45;
  const business = status.company?.businessName;
  if (business && business !== 'Mi negocio') $('#businessLabel').textContent = business;

  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'kiosk' && me.role !== 'admin') throw new Error('sin sesión');
  } catch {
    location.href = '/admin.html';
    return;
  }

  startQrLoop();
}

$('#logout').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); }
  finally { location.href = '/admin.html'; }
};

boot().catch(() => { location.href = '/admin.html'; });
