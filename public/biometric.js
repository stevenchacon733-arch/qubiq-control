// Pantalla "Lector de Huella" y diálogo "Asignar o cambiar huella digital" del Administrador.
// Toda la lógica vive en el servidor; acá solo se muestra el estado y se disparan las acciones.

const STATES = {
  CONNECTED: ['good', 'Conectado'],
  SYNCING: ['warn', 'Sincronizando'],
  DISCONNECTED: ['bad', 'Desconectado'],
  PENDING: ['warn', 'Sin verificar'],
  DISABLED: ['', 'Desactivado']
};
const EVENT_LABELS = {
  APPLIED: ['good', 'Registrada'],
  UNMAPPED: ['warn', 'Sin empleado vinculado'],
  REJECTED: ['bad', 'No aplicada'],
  IGNORED: ['', 'Ignorada'],
  INVALID: ['bad', 'Inválida'],
  // Modo sucursal: la marcación no se registra acá, viaja a la central.
  QUEUED: ['warn', 'En cola para la central'],
  SENT: ['good', 'Enviada a la central'],
  SENT_PENDING: ['warn', 'Enviada, sin aplicar'],
  SEND_ERROR: ['bad', 'Rechazada por la central']
};
const REFRESH_MS = 5000;

export function mountBiometric({ $, $$, api, msg, clearMsg, toast, esc, reloadEmployees, branchMode = () => false }) {
  let devices = [];
  let busy = false;
  let loaded = false;
  const diagnostics = new Map();

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const hour = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
  const visible = () => $('#biometric').classList.contains('active') && $('#login').classList.contains('hidden');

  // ---------- Resumen en "Hoy" ----------
  function renderSummary(summary = {}) {
    const total = Number(summary.devices || 0);
    const down = Number(summary.disconnected || 0);
    $('#stBio').className = `status-dot ${!total ? '' : (down ? 'bad' : (summary.connected === total ? 'good' : 'warn'))}`;
    $('#stBioText').textContent = !total ? 'Sin configurar'
      : (down ? `${down} lector(es) desconectado(s)` : `${summary.connected} de ${total} conectado(s)`);
  }

  // ---------- Lectores ----------
  function diagnosticsHtml(data) {
    if (!data) return '';
    const item = (label, value) => `<div><span>${label}</span><b>${esc(value == null || value === '' ? '—' : value)}</b></div>`;
    const device = data.device || {};
    const drift = data.clockDriftSeconds;
    const clock = data.deviceTime
      ? `${data.deviceTime}${drift != null && Math.abs(drift) > 120 ? ` · desfase de ${Math.round(Math.abs(drift) / 60)} min` : ' · en hora'}`
      : null;
    return `<div class="bio-diag">
      ${item('IP y puerto', data.address)}
      ${item('Estado', data.online ? 'Responde' : 'No responde')}
      ${item('Latencia', data.latencyMs != null ? `${data.latencyMs} ms` : null)}
      ${item('Último contacto', when(device.lastContactAt))}
      ${item('Última sincronización', when(device.lastSyncAt))}
      ${item('Marcaciones pendientes', data.pendingEvents)}
      ${item('Modelo', data.model)}
      ${item('Firmware', data.firmware)}
      ${item('Número de serie', data.serial)}
      ${item('Plataforma', data.platform)}
      ${item('MAC', data.mac)}
      ${item('Reloj del lector', clock)}
      ${item('Marcaciones guardadas', data.records != null ? `${data.records} de ${data.recordsCapacity}` : null)}
      ${item('Usuarios / huellas', data.users != null ? `${data.users} / ${data.fingers}` : null)}
      ${item('Último error', data.error || device.lastError || 'Ninguno')}
    </div>`;
  }

  function deviceHtml(device) {
    const [tone, label] = STATES[device.status] || STATES.PENDING;
    const off = !device.active;
    const error = device.status === 'DISCONNECTED' && device.lastError
      ? `<div class="message show error">${esc(device.lastError)}${device.consecutiveFailures > 1 ? ` · ${device.consecutiveFailures} intentos fallidos, se sigue reintentando solo.` : ''}</div>`
      : '';
    const unlinked = device.unlinkedEvents
      ? `<div class="message show">${device.unlinkedEvents} marcación(es) de IDs sin empleado vinculado. Vinculá el ID abajo y se aplican solas.</div>`
      : '';
    const disabled = off ? 'disabled' : '';
    // Lector de otra sucursal: llega a través de la computadora de esa sucursal, así que desde acá no se prueba
    // ni se sincroniza; solo se le cambia el nombre o se lo desactiva.
    const where = device.remote
      ? `${device.agentName ? `Vía ${esc(device.agentName)}` : 'Otra sucursal'}${device.address ? ` · ${esc(device.address)}` : ''}`
      : esc(device.address || `${device.ip}:${device.port}`);
    const third = branchMode()
      ? `<div><span>En cola para la central</span><strong>${device.queued || 0}</strong></div>`
      : `<div><span>Empleados vinculados</span><strong>${device.linkedEmployees}</strong></div>`;
    const buttons = device.remote
      ? `<button type="button" class="btn secondary" data-act="configure">Configurar</button>
        <button type="button" class="btn ${off ? 'secondary' : 'danger'}" data-act="toggle">${off ? 'Activar' : 'Desactivar'}</button>`
      : `<button type="button" class="btn secondary" data-act="test">Probar conexión</button>
        <button type="button" class="btn" data-act="sync" ${disabled}>Sincronizar ahora</button>
        <button type="button" class="btn secondary" data-act="download" ${disabled}>Descargar marcaciones</button>
        <button type="button" class="btn secondary" data-act="diagnostics">Diagnóstico</button>
        <button type="button" class="btn secondary" data-act="configure">Configurar</button>
        <button type="button" class="btn ${off ? 'secondary' : 'danger'}" data-act="toggle">${off ? 'Activar' : 'Desactivar'}</button>`;
    return `<article class="bio-device ${off ? 'off' : ''}" data-id="${device.id}">
      <div class="bio-device-head">
        <div><h3>${esc(device.name)}${device.remote ? ' <code class="branch-tag">otra sucursal</code>' : ''}</h3><span class="muted">${device.branchName && !branchMode() ? `${esc(device.branchName)} (${esc(device.branchCode)}) · ` : ''}${where}${device.location ? ` · ${esc(device.location)}` : ''}${device.serialNumber ? ` · Serie ${esc(device.serialNumber)}` : ''}</span></div>
        <span class="bio-state ${tone}"><span class="status-dot ${tone}"></span>${label}</span>
      </div>
      <div class="bio-facts">
        <div><span>${device.remote ? 'Última marcación recibida' : 'Última sincronización'}</span><strong>${hour(device.lastSyncAt)}</strong></div>
        <div><span>Marcaciones hoy</span><strong>${device.punchesToday}</strong></div>
        ${third}
        <div><span>${device.remote ? 'Último reporte del lector' : 'Último contacto'}</span><strong>${hour(device.lastContactAt)}</strong></div>
      </div>
      ${error}${unlinked}
      <div class="button-row">
        ${buttons}
      </div>
      ${diagnosticsHtml(diagnostics.get(device.id))}
    </article>`;
  }

  function renderDevices() {
    $('#bioDevices').innerHTML = devices.map(deviceHtml).join('')
      || '<div class="bio-empty">Todavía no hay ningún lector. Tocá <b>Agregar lector</b> y escribí la IP del ZKTeco.</div>';
    $$('#bioDevices [data-act]').forEach((button) => {
      button.addEventListener('click', () => act(button, Number(button.closest('.bio-device').dataset.id), button.dataset.act));
    });
  }

  async function loadDevices() {
    devices = await api('/api/admin/biometric/devices');
    renderDevices();
    const select = $('#bioMapDevice');
    const current = select.value;
    select.innerHTML = devices.map((device) => `<option value="${device.id}">${esc(device.name)}${device.branchCode ? ` · ${esc(device.branchCode)}` : ''}</option>`).join('');
    if (devices.some((device) => String(device.id) === current)) select.value = current;
    select.classList.toggle('hidden', devices.length < 2);
  }

  async function act(button, id, action) {
    const device = devices.find((item) => item.id === id);
    if (!device || busy) return;
    if (action === 'configure') return openDeviceModal(device);
    const warning = device.remote
      ? `¿Desactivar ${device.name}? La central deja de aceptar sus marcaciones; quedan guardadas en esa sucursal hasta que lo vuelvas a activar.`
      : `¿Desactivar ${device.name}? Qubiq dejará de consultarlo; las huellas y marcaciones siguen guardadas en el lector.`;
    if (action === 'toggle' && device.active && !window.confirm(warning)) return;
    busy = true;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Un momento...';
    try {
      if (action === 'test') {
        const result = await api(`/api/admin/biometric/devices/${id}/test`, { method: 'POST', body: '{}' });
        toast(result.ok ? `${device.name} responde en ${result.address} (${result.latencyMs} ms).` : `Sin conexión con ${result.address}: ${result.error}`, result.ok);
      } else if (action === 'sync' || action === 'download') {
        const result = await api(`/api/admin/biometric/devices/${id}/sync`, { method: 'POST', body: JSON.stringify({ full: action === 'download' }) });
        toast(result.upToDate ? 'Sin marcaciones nuevas en el lector.'
          : `${result.received} recibidas · ${result.imported} nuevas · ${result.duplicates} ya existentes.`);
      } else if (action === 'diagnostics') {
        if (diagnostics.has(id)) diagnostics.delete(id);
        else diagnostics.set(id, await api(`/api/admin/biometric/devices/${id}/diagnostics`));
      } else if (action === 'toggle') {
        await api(`/api/admin/biometric/devices/${id}/active`, { method: 'PATCH', body: JSON.stringify({ active: !device.active }) });
        diagnostics.delete(id);
      }
    } catch (error) {
      toast(error.message, false);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = original;
      await refresh(true).catch(() => {});
    }
  }

  // ---------- Alta y configuración de un lector ----------
  function closeDeviceModal() {
    $('#bioDeviceModal').classList.add('hidden');
    $('#bioDeviceForm').reset();
    clearMsg($('#bioDeviceMsg'));
  }

  // Nombre sugerido para un lector nuevo: ZK-<código de sucursal>-<número>, por ejemplo ZK-AGZ-01.
  let branchOptions = [];
  let suggestedName = '';
  function suggestName() {
    const form = $('#bioDeviceForm');
    if (form.elements.id.value || (form.elements.name.value && form.elements.name.value !== suggestedName)) return;
    const branch = branchOptions.find((item) => String(item.id) === form.elements.branchId.value);
    if (!branch) return;
    const used = new Set(devices.map((item) => item.name));
    let number = devices.filter((item) => item.branchId === branch.id).length + 1;
    while (used.has(`ZK-${branch.code}-${String(number).padStart(2, '0')}`)) number += 1;
    suggestedName = `ZK-${branch.code}-${String(number).padStart(2, '0')}`;
    form.elements.name.value = suggestedName;
  }

  async function openDeviceModal(device = null) {
    const form = $('#bioDeviceForm');
    form.reset();
    clearMsg($('#bioDeviceMsg'));
    $('#bioDeviceTitle').textContent = device ? `Configurar ${device.name}` : 'Agregar lector';
    // De un lector de otra sucursal solo se cambia el nombre, la ubicación y el tiempo de doble toque.
    const remote = Boolean(device?.remote);
    for (const field of ['ip', 'port', 'deviceNumber', 'commKey', 'branchId', 'pollSeconds']) {
      form.elements[field].disabled = remote;
      form.elements[field].closest('label').classList.toggle('hidden', remote || (field === 'branchId' && branchMode()));
    }
    $('#bioDeviceHint').textContent = remote
      ? 'Lector de otra sucursal: la IP y la clave se configuran en la computadora de esa sucursal.'
      : 'El lector debe estar en la misma red que esta computadora.';
    form.elements.id.value = device?.id || '';
    suggestedName = '';
    try { branchOptions = (await api('/api/admin/branches')).filter((item) => item.active || item.id === device?.branchId); }
    catch { branchOptions = []; }
    form.elements.branchId.innerHTML = branchOptions.map((item) => `<option value="${item.id}">${esc(item.name)} (${esc(item.code)})</option>`).join('');
    if (device?.branchId) form.elements.branchId.value = String(device.branchId);
    $('#bioSerialRow').classList.toggle('hidden', !device?.serialNumber || Boolean(device?.remote));
    $('#bioSerialText').textContent = `Se cambió el aparato por otro (el registrado es el de serie ${device?.serialNumber || ''})`;
    form.elements.name.value = device?.name || '';
    if (!device) suggestName();
    form.elements.ip.value = device?.remote ? '' : (device?.ip || '');
    form.elements.port.value = device?.remote ? '' : (device?.port || 4370);
    form.elements.deviceNumber.value = device?.deviceNumber || 1;
    form.elements.location.value = device?.location || '';
    form.elements.pollSeconds.value = device?.pollSeconds || 30;
    form.elements.minGapSeconds.value = device?.minGapSeconds ?? 120;
    form.elements.commKey.value = '';
    form.elements.commKey.placeholder = device?.hasCommKey ? 'Guardada · dejar vacía la conserva' : 'Vacía si el lector no tiene';
    $('#bioDeviceModal').classList.remove('hidden');
    (device ? form.elements.name : form.elements.ip).focus();
  }

  $('#bioAddDevice').addEventListener('click', () => openDeviceModal());
  $('#bioDeviceForm').elements.branchId.addEventListener('change', suggestName);
  $('#closeBioDeviceModal').addEventListener('click', closeDeviceModal);
  $('#cancelBioDevice').addEventListener('click', closeDeviceModal);
  $('#bioDeviceModal').addEventListener('click', (event) => { if (event.target === $('#bioDeviceModal')) closeDeviceModal(); });
  $('#bioDeviceForm').elements.commKey.addEventListener('input', (event) => { event.currentTarget.value = event.currentTarget.value.replace(/\D+/g, ''); });
  $('#bioDeviceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const id = body.id;
    delete body.id;
    clearMsg($('#bioDeviceMsg'));
    try {
      const saved = id
        ? await api(`/api/admin/biometric/devices/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/admin/biometric/devices', { method: 'POST', body: JSON.stringify(body) });
      closeDeviceModal();
      if (saved.remote) { toast(`${saved.name} guardado.`); await refresh(true); return; }
      toast(`${saved.name} guardado. Comprobando la conexión...`);
      await refresh(true);
      const test = await api(`/api/admin/biometric/devices/${saved.id}/test`, { method: 'POST', body: '{}' });
      toast(test.ok ? `${saved.name} conectado (${test.latencyMs} ms).` : `No se pudo conectar: ${test.error}`, test.ok);
      await refresh(true);
    } catch (error) {
      msg($('#bioDeviceMsg'), error.message);
    }
  });

  // ---------- Empleados e IDs ----------
  async function loadMappings() {
    const deviceId = $('#bioMapDevice').value;
    const body = $('#bioMapBody');
    if (!deviceId) {
      body.innerHTML = '<tr><td colspan="5">Agregá un lector para vincular empleados.</td></tr>';
      return;
    }
    let data;
    try { data = await api(`/api/admin/biometric/devices/${deviceId}/mappings`); }
    catch (error) {
      // En una sucursal la lista de empleados se consulta a la central: puede no haber conexión en este momento.
      body.innerHTML = `<tr><td colspan="5">${esc(error.message)}</td></tr>`;
      return;
    }
    body.innerHTML = data.rows.map((row) => `
      <tr data-employee="${esc(row.employeeId)}">
        <td><strong>${esc(row.name)}</strong>${row.active ? '' : '<br><small class="muted">Inactivo</small>'}</td>
        <td><code>${esc(row.employeeCode)}</code></td>
        <td><div class="bio-id"><input inputmode="numeric" maxlength="9" value="${esc(row.zkUserId || '')}" placeholder="${row.sharedId ? `Usa el ${esc(row.sharedId)}` : 'Sin ID'}" aria-label="ID biométrico de ${esc(row.name)}"><button type="button" class="mini-btn bio-save-id">Guardar</button></div></td>
        <td>${row.zkUserId ? '<span class="badge good">Vinculado</span>' : '<span class="badge warn">Sin vincular</span>'}</td>
        <td><button type="button" class="btn secondary bio-finger" data-name="${esc(row.name)}">Asignar o cambiar huella</button></td>
      </tr>`).join('') || `<tr><td colspan="5">${branchMode() ? 'La central todavía no tiene empleados.' : 'No hay empleados.'}</td></tr>`;
    $$('#bioMapBody input').forEach((input) => {
      input.addEventListener('input', () => { input.value = input.value.replace(/\D+/g, ''); });
    });
    $$('#bioMapBody .bio-save-id').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('tr');
        try {
          const result = await api('/api/admin/biometric/mappings', { method: 'PUT', body: JSON.stringify({
            employeeId: row.dataset.employee, deviceId, zkUserId: row.querySelector('input').value }) });
          toast(result.zkUserId
            ? `ID ${result.zkUserId} vinculado.${result.reprocessed ? ` Se aplicaron ${result.reprocessed} marcación(es) que estaban esperando.` : ''}`
            : 'Vínculo quitado.');
          await refresh(true);
        } catch (error) { toast(error.message, false); }
      });
    });
    $$('#bioMapBody .bio-finger').forEach((button) => {
      button.addEventListener('click', () => openFinger(button.closest('tr').dataset.employee, button.dataset.name));
    });
  }
  $('#bioMapDevice').addEventListener('change', () => loadMappings().catch((error) => toast(error.message, false)));

  // ---------- Actividad ----------
  async function loadActivity() {
    const [events, logs] = await Promise.all([api('/api/admin/biometric/events?limit=40'), api('/api/admin/biometric/logs?limit=40')]);
    $('#bioEventBody').innerHTML = events.map((event) => {
      const [tone, label] = EVENT_LABELS[event.status] || ['', event.status];
      return `<tr>
        <td>${esc(event.punchedLocal.replace(/^!/, ''))}</td>
        <td>${event.branchCode ? `<code title="${esc(event.branchName || '')} · ${esc(event.deviceName)}">${esc(event.branchCode)}</code>` : '—'}</td>
        <td>${esc(event.zkUserId)}</td>
        <td>${esc(event.employee || '—')}</td>
        <td><span class="badge ${tone}">${label}</span>${event.note ? `<br><small class="muted">${esc(event.note)}</small>` : ''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5">Sin marcaciones todavía.</td></tr>';
    $('#bioLogBody').innerHTML = logs.map((log) => `<tr>
        <td>${esc(when(log.created_at))}</td>
        <td>${esc(log.device_name)}</td>
        <td>${esc(log.action)}</td>
        <td><span class="badge ${log.result === 'OK' ? 'good' : 'bad'}">${log.result === 'OK' ? 'OK' : 'Error'}</span>${log.message ? `<br><small class="muted">${esc(log.message)}</small>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="4">Sin registros todavía.</td></tr>';
  }

  async function refresh(withMappings = false) {
    await loadDevices();
    await Promise.all([loadActivity(), withMappings || !loaded ? loadMappings() : null]);
    loaded = true;
  }

  setInterval(() => {
    const editing = document.activeElement?.closest?.('#bioMapBody');
    if (!visible() || busy || editing) return;
    refresh().catch(() => {});
  }, REFRESH_MS);

  // ---------- Asignar o cambiar huella digital ----------
  let fingerDevices = [];
  let enrolling = false;

  function closeFinger() {
    if (enrolling) return;
    $('#fingerModal').classList.add('hidden');
    clearMsg($('#fingerMsg'));
  }

  function fillFingerId() {
    const form = $('#fingerForm');
    const device = fingerDevices.find((item) => String(item.deviceId) === form.elements.deviceId.value);
    form.elements.zkUserId.value = device?.zkUserId || device?.suggestedId || '';
    // La huella de un lector de otra sucursal se registra allá, parado frente a ese lector.
    $('#fingerEnroll').disabled = !device || Boolean(device.remote);
    if (device?.remote) msg($('#fingerMsg'), 'Ese lector está en otra sucursal: la huella se registra desde la computadora de esa sucursal. Acá podés dejar guardado el ID.', true);
    else if (device) clearMsg($('#fingerMsg'));
  }

  async function openFinger(employeeId, name) {
    const form = $('#fingerForm');
    clearMsg($('#fingerMsg'));
    form.elements.employeeId.value = employeeId;
    $('#fingerEmployee').textContent = name || '';
    $('#fingerModal').classList.remove('hidden');
    try {
      fingerDevices = (await api(`/api/admin/biometric/employees/${employeeId}`)).filter((item) => item.active);
    } catch (error) {
      fingerDevices = [];
      msg($('#fingerMsg'), error.message);
    }
    form.elements.deviceId.innerHTML = fingerDevices.map((item) => `<option value="${item.deviceId}">${esc(item.deviceName)}${item.remote ? ' (otra sucursal)' : ''}</option>`).join('');
    const ready = fingerDevices.length > 0;
    $('#fingerSaveId').disabled = !ready;
    fillFingerId();
    if (!ready) msg($('#fingerMsg'), 'Primero agregá el lector en la pestaña "Lector de Huella".');
  }

  async function describeEmployee(employeeId) {
    const info = $('#editEmployeeFingerInfo');
    info.textContent = 'Para marcar con el lector de huella.';
    try {
      const list = (await api(`/api/admin/biometric/employees/${employeeId}`)).filter((item) => item.zkUserId);
      if (list.length) info.textContent = list.map((item) => `ID ${item.zkUserId} en ${item.deviceName}`).join(' · ');
      else info.textContent = 'Todavía sin ID en el lector de huella.';
    } catch { /* se deja el texto por defecto */ }
  }

  $('#fingerForm').elements.deviceId.addEventListener('change', fillFingerId);
  $('#fingerForm').elements.zkUserId.addEventListener('input', (event) => { event.currentTarget.value = event.currentTarget.value.replace(/\D+/g, ''); });
  $('#closeFingerModal').addEventListener('click', closeFinger);
  $('#fingerModal').addEventListener('click', (event) => { if (event.target === $('#fingerModal')) closeFinger(); });

  $('#fingerSaveId').addEventListener('click', async () => {
    const form = $('#fingerForm');
    if (!form.reportValidity()) return;
    try {
      const body = Object.fromEntries(new FormData(form));
      const result = await api('/api/admin/biometric/mappings', { method: 'PUT', body: JSON.stringify(body) });
      msg($('#fingerMsg'), `ID ${result.zkUserId} guardado. Registrá la huella en el lector con ese mismo ID.`, true);
      await Promise.all([refresh(true), describeEmployee(body.employeeId)]);
    } catch (error) { msg($('#fingerMsg'), error.message); }
  });

  $('#fingerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (enrolling) return;
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    const device = fingerDevices.find((item) => String(item.deviceId) === body.deviceId);
    // Si ya tenía ID en este lector es un cambio de huella: la anterior se borra antes de pedir la nueva.
    body.replace = Boolean(device?.zkUserId) && device.zkUserId === body.zkUserId;
    if (body.replace && !window.confirm('Si este empleado ya tenía huella en el lector, se va a reemplazar. Si no terminás el registro, queda sin huella hasta volver a registrarla. ¿Continuar?')) return;
    const buttons = [$('#fingerEnroll'), $('#fingerSaveId'), $('#closeFingerModal')];
    enrolling = true;
    busy = true;
    buttons.forEach((button) => { button.disabled = true; });
    const startedAt = Date.now();
    const waiting = () => {
      const left = Math.max(0, 60 - Math.round((Date.now() - startedAt) / 1000));
      $('#fingerMsg').textContent = left > 0
        ? `Andá al lector: va a pedir el dedo tres veces (ID ${body.zkUserId}). Quedan ${left} s.`
        : 'Confirmando con el lector...';
    };
    waiting();
    $('#fingerMsg').className = 'message show';
    const countdown = setInterval(waiting, 1000);
    try {
      const result = await api('/api/admin/biometric/enroll', { method: 'POST', body: JSON.stringify(body) });
      form.elements.zkUserId.value = result.zkUserId;
      if (result.enrolled) {
        msg($('#fingerMsg'), `Huella registrada con el ID ${result.zkUserId}. Ya puede marcar con el dedo.`, true);
      } else {
        const reason = result.error
          || (result.outcome === 'DUPLICATE' ? 'Esa huella ya pertenece a otro usuario del lector.'
            : 'El lector no confirmó la huella a tiempo.');
        msg($('#fingerMsg'), `${reason} El ID ${result.zkUserId} quedó guardado: podés reintentar, o registrar la huella directamente en el menú del lector usando ese mismo ID.`);
      }
    } catch (error) {
      msg($('#fingerMsg'), error.message);
    } finally {
      clearInterval(countdown);
      enrolling = false;
      busy = false;
      buttons.forEach((button) => { button.disabled = false; });
      await Promise.all([refresh(true).catch(() => {}), describeEmployee(body.employeeId), reloadEmployees().catch(() => {})]);
      fingerDevices = await api(`/api/admin/biometric/employees/${body.employeeId}`).then((list) => list.filter((item) => item.active)).catch(() => fingerDevices);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#fingerModal').classList.contains('hidden')) closeFinger();
    else if (!$('#bioDeviceModal').classList.contains('hidden')) closeDeviceModal();
  });

  return {
    renderSummary,
    show: () => {
      if (branchMode()) $('#bioIntro').textContent = 'El lector guarda y verifica las huellas. Esta computadora solo le pasa a la central quién marcó y a qué hora; la asistencia se registra allá.';
      return refresh(true).catch((error) => toast(error.message, false));
    },
    openFinger,
    describeEmployee
  };
}
