// Marcar entrada/salida en la computadora del negocio, sin celular. Lo usan el panel del Administrador y la
// pantalla de Recepción. El servidor aplica las mismas reglas que al escanear el QR (PIN, bloqueo por intentos,
// tardanza, correo), así que acá solo se arma el formulario y se muestra el resultado.

const CLEAR_AFTER_MS = 8000;

function show(element, text, ok) {
  element.textContent = text;
  element.className = `message show ${ok ? 'success' : 'error'}`;
}

function clear(element) {
  element.textContent = '';
  element.className = 'message';
}

// Igual que la tabla de "Hoy": 528 minutos se leen "8 h 48 min".
export function formatLate(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return `${mins} min`;
  return mins ? `${hours} h ${mins} min` : `${hours} h`;
}

export function describeMark(data) {
  const action = data.eventType === 'ENTRY' ? 'Entrada' : 'Salida';
  const late = data.status === 'LATE' && data.lateMinutes > 0 ? ` · ${formatLate(data.lateMinutes)} tarde` : '';
  return `${data.employee}: ${action} registrada a las ${data.time}${late}.`;
}

export function mountAppMark(form, { onMarked = () => {} } = {}) {
  if (!form) return;
  const code = form.elements.employeeCode;
  const pin = form.elements.pin;
  const button = form.querySelector('button');
  const result = form.querySelector('[data-role="result"]');
  let clearTimer = null;

  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9_-]+/g, '').slice(0, 20); });
  pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D+/g, '').slice(0, 8); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearTimeout(clearTimer);
    clear(result);
    button.disabled = true;
    try {
      const response = await fetch('/api/admin/attendance/mark', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeCode: code.value, pin: pin.value })
      });
      if (response.status === 401) { location.href = '/admin.html'; return; }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo registrar la asistencia.');

      show(result, describeMark(data), true);
      form.reset();
      code.focus();
      onMarked(data);
      // En una computadora compartida el siguiente empleado no debe ver quién marcó antes.
      clearTimer = setTimeout(() => clear(result), CLEAR_AFTER_MS);
    } catch (error) {
      show(result, error.message, false);
      pin.value = '';
      pin.focus();
    } finally {
      button.disabled = false;
    }
  });
}
