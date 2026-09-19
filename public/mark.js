const token = new URLSearchParams(location.search).get('token');
const state = document.querySelector('#tokenState');
const form = document.querySelector('#markForm');
const result = document.querySelector('#result');
const employeeCodeInput = document.querySelector('#employeeCode');
const pinInput = document.querySelector('#pin');

async function loadBranding() {
  try {
    const response = await fetch('/api/branding', { cache: 'no-store' });
    const company = await response.json();
    const label = document.querySelector('#businessLabel');
    if (label) label.textContent = company.businessName || '';
  } catch { /* la marcación sigue aunque el branding no cargue */ }
}
async function validate() {
  if (!token) {
    state.textContent = 'Falta el código QR.';
    state.className = 'error';
    return;
  }

  const response = await fetch(`/api/attendance/token-info?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    state.textContent = data.error || 'No se pudo validar el QR.';
    state.className = 'error';
    return;
  }

  state.textContent = 'QR válido. Ingresá tu código y PIN.';
  form.classList.remove('hidden');
}

form.onsubmit = async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  result.className = 'message';

  try {
    const response = await fetch('/api/attendance/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        employeeCode: employeeCodeInput.value,
        pin: pinInput.value
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo registrar la asistencia.');

    form.classList.add('hidden');
    state.textContent = 'Registro completado.';
    const action = data.eventType === 'ENTRY' ? 'Entrada' : 'Salida';
    const extra = data.status === 'LATE' ? ` · ${data.lateMinutes} min tarde` : '';
    const mail = data.emailQueued
      ? ' · Correo de confirmación programado.'
      : ' · Asistencia guardada.';
    result.textContent = `${data.employee}: ${action} registrada a las ${data.time}${extra}.${mail}`;
    result.className = 'message show success';
  } catch (error) {
    result.textContent = error.message;
    result.className = 'message show error';
  } finally {
    button.disabled = false;
  }
};

loadBranding().finally(() => validate()).catch(() => {
  state.textContent = 'No se pudo validar el QR.';
  state.className = 'error';
});
