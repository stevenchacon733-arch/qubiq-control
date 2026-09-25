const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  const { skipAuthRedirect = false, ...fetchOptions } = options;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    if (!skipAuthRedirect) $('#login').classList.remove('hidden');
    throw new Error(data.error || 'Sesión requerida.');
  }
  if (!response.ok) throw new Error(data.error || 'Error en la solicitud.');
  return data;
}

function msg(element, text, ok = false) {
  element.textContent = text;
  element.className = `message show ${ok ? 'success' : 'error'}`;
}

function clearMsg(element) {
  element.textContent = '';
  element.className = 'message';
}

function toast(text, ok = true) {
  const box = document.createElement('div');
  box.className = `toast ${ok ? 'success' : 'error'}`;
  box.textContent = text;
  $('#toastContainer')?.appendChild(box);
  requestAnimationFrame(() => box.classList.add('show'));
  setTimeout(() => { box.classList.remove('show'); setTimeout(() => box.remove(), 250); }, 3200);
}

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function formatHours(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!mins) return `${hours} h`;
  return `${hours} h ${mins} min`;
}

function formatCountedHours(hours) {
  if (hours === '' || hours == null) return '—';
  return formatHours(Math.round(Number(hours) * 60));
}

const DAY_NAMES = {
  1: 'Lu',
  2: 'Mar',
  3: 'Mier',
  4: 'Jue',
  5: 'Vier',
  6: 'Sab',
  0: 'Dom'
};

function formatWorkDays(value = '') {
  const selected = new Set(String(value).split(',').filter(Boolean).map(Number));
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => selected.has(day))
    .map((day) => DAY_NAMES[day])
    .join(', ') || '—';
}

function formatLateTime(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return `${mins} min`;
  if (!mins) return `${hours} h`;
  return `${hours} h ${mins} min`;
}

function statusBadge(row) {
  if (row.attendanceStatus === 'LATE') return `<span class="badge warn">Tarde ${formatLateTime(row.lateMinutes)}</span>`;
  if (row.entry) return '<span class="badge good">Presente</span>';
  if (row.attendanceStatus === 'OFF') return '<span class="badge">Libre</span>';
  return '<span class="badge bad">Pendiente</span>';
}

let appStatus = null;
let currentSystem = null;
let lastQrBlocked = null;
let cachedEmployees = [];
let cachedSchedules = [];

function installInputFilters() {
  document.querySelectorAll('input[name="nationalId"], input[name="phone"], input[name="pin"]').forEach((input) => {
    input.addEventListener('input', () => { input.value = input.value.replace(/\D+/g, ''); });
  });
  document.querySelectorAll('input[name="employeeCode"]').forEach((input) => {
    input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9_-]+/g, '').slice(0, 20); });
  });
}

async function boot() {
  installInputFilters();
  appStatus = await api('/api/status');
  setBusinessLabel(appStatus.company);
  if (appStatus.setupRequired) {
    location.href = '/setup.html';
    return;
  }
  $('#loginRoleTabs').classList.toggle('hidden', !appStatus.kioskEnabled);

  $('#payFrom').value = appStatus.today;
  $('#payTo').value = appStatus.today;
  $('#overviewDate').value = appStatus.today;

  let me;
  try {
    me = await api('/api/auth/me');
  } catch {
    return;
  }
  if (me.role === 'kiosk') {
    location.href = '/kiosk.html';
    return;
  }

  await reloadAdminData();
  refreshQr();
}

async function reloadAdminData() {
  await Promise.all([loadOverview(), loadSchedules(), loadEmployees(), loadSystem()]);
}

async function loadOverview() {
  const selected = $('#overviewDate')?.value || appStatus?.today || '';
  const query = selected ? `?date=${encodeURIComponent(selected)}` : '';
  const data = await api(`/api/admin/overview${query}`);
  $('#today').textContent = data.date;
  $('#sEmployees').textContent = data.totals.employees;
  $('#sPresent').textContent = data.totals.present;
  $('#sLate').textContent = data.totals.late;
  $('#sCompleted').textContent = data.totals.completed;
  $('#attendanceBody').innerHTML = data.rows.map((row) => `
    <tr>
      <td><strong>${esc(row.name)}</strong><br><small class="muted">${esc(row.employee_code)}</small></td>
      <td>${row.entry || '—'}</td>
      <td>${row.exit || '—'}</td>
      <td>${statusBadge(row)}</td>
      <td>${row.exit ? formatHours(row.workedMinutes) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="5">No hay empleados activos.</td></tr>';
}

async function loadSystem() {
  const data = await api('/api/admin/system');
  currentSystem = data;
  $('#stMail').className = `status-dot ${data.mailConfigured ? 'good' : 'bad'}`;
  const pending = Number(data.mailQueue?.PENDING || 0) + Number(data.mailQueue?.RETRY || 0);
  $('#stMailText').textContent = data.mailConfigured ? (pending ? `Activo · ${pending} pendiente(s)` : 'Activo') : 'No configurado';
  $('#stSheets').className = `status-dot ${data.googleSheetsConfigured ? 'good' : 'warn'}`;
  const googleAccount = data.googleOAuth?.account?.email || '';
  $('#stSheetsText').textContent = data.googleSheetsConfigured ? `Conectado${googleAccount ? ` · ${googleAccount}` : ''}` : (data.googleOAuth?.clientInstalled ? 'Listo para autorizar' : 'Falta conexión');
  $('#googleConnect').textContent = data.googleSheetsConfigured ? 'Reconectar' : (data.googleOAuth?.clientInstalled ? 'Autorizar Google' : 'Configurar Google');
  const backupAt = data.backup?.lastBackupAt;
  $('#stBackup').className = `status-dot ${backupAt ? 'good' : 'warn'}`;
  $('#stBackupText').textContent = backupAt
    ? `Último: ${new Date(backupAt).toLocaleString()} · Automático diario 21:00`
    : 'Automático diario 21:00';
  renderLicense(data.license || {});
  return data;
}

function renderLicense(license) {
  const dotClass = license.valid ? 'good' : (license.banner?.type === 'danger' ? 'bad' : (license.banner ? 'warn' : 'good'));
  $('#stLicense').className = `status-dot ${dotClass}`;
  $('#stLicenseText').textContent = license.valid
    ? `Activa${license.daysRemaining != null ? ` · vence en ${license.daysRemaining} día(s)` : ''}`
    : (license.hasKey ? (license.banner?.text || 'Sin verificar') : 'Sin configurar');

  if ($('#licenseInfoDot')) $('#licenseInfoDot').className = `status-dot ${dotClass}`;
  if ($('#licenseInfoText')) {
    const lastCheck = license.lastCheckAt ? new Date(license.lastCheckAt).toLocaleString() : null;
    $('#licenseInfoText').textContent = license.valid
      ? `Licencia activa${license.expiresAt ? ` · vence ${new Date(license.expiresAt).toLocaleDateString()} (${license.daysRemaining} día(s))` : ''}${lastCheck ? ` · última verificación ${lastCheck}` : ''}`
      : (license.hasKey
        ? `${license.message || license.banner?.text || 'No se pudo validar la licencia.'}${lastCheck ? ` · última verificación ${lastCheck}` : ''}`
        : 'Sin licencia configurada.');
  }

  const banner = $('#licenseBanner');
  if (banner) {
    if (license.banner) {
      banner.className = `license-banner ${license.banner.type}`;
      banner.textContent = license.banner.text;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  const qrBlocked = Boolean(license.blockQrGeneration);
  if (lastQrBlocked !== null && lastQrBlocked !== qrBlocked) refreshQr();
  lastQrBlocked = qrBlocked;
}

function scheduleOptions() {
  return '<option value="">Sin horario</option>' + cachedSchedules.map((schedule) =>
    `<option value="${schedule.id}">${esc(schedule.name)} (${schedule.start_time}-${schedule.end_time})</option>`
  ).join('');
}

async function loadSchedules() {
  cachedSchedules = await api('/api/admin/schedules');
  $('#scheduleBody').innerHTML = cachedSchedules.map((schedule) => `
    <tr>
      <td>${esc(schedule.name)}</td>
      <td>${schedule.start_time}</td>
      <td>${schedule.end_time}</td>
      <td>${schedule.tolerance_minutes} min</td>
      <td><button class="btn secondary edit-schedule" type="button" data-id="${schedule.id}">Editar</button></td>
    </tr>`).join('') || '<tr><td colspan="5">No hay horarios.</td></tr>';

  $$('.edit-schedule').forEach((button) => {
    button.onclick = () => openScheduleModal(button.dataset.id);
  });

  const options = scheduleOptions();
  $('#employeeSchedule').innerHTML = options;
  $('#editEmployeeSchedule').innerHTML = options;
}

function closeScheduleModal() {
  $('#scheduleModal').classList.add('hidden');
  $('#editScheduleForm').reset();
  clearMsg($('#editScheduleMsg'));
}

function openScheduleModal(id) {
  const schedule = cachedSchedules.find((item) => Number(item.id) === Number(id));
  if (!schedule) return;

  const form = $('#editScheduleForm');
  form.elements.id.value = schedule.id;
  form.elements.name.value = schedule.name;
  form.elements.startTime.value = schedule.start_time;
  form.elements.endTime.value = schedule.end_time;
  form.elements.toleranceMinutes.value = schedule.tolerance_minutes;
  clearMsg($('#editScheduleMsg'));
  $('#scheduleModal').classList.remove('hidden');
  form.elements.name.focus();
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    window.prompt('Copiá el código de marcación:', code);
  }
}

function closeEmployeeModal() {
  $('#employeeModal').classList.add('hidden');
  $('#editEmployeeForm').reset();
  clearMsg($('#editEmployeeMsg'));
}

function openEmployeeModal(id) {
  const employee = cachedEmployees.find((item) => Number(item.id) === Number(id));
  if (!employee) return;

  const form = $('#editEmployeeForm');
  form.elements.id.value = employee.id;
  form.elements.employeeCode.value = employee.employee_code;
  form.elements.name.value = employee.name;
  form.elements.nationalId.value = employee.national_id || '';
  form.elements.phone.value = employee.phone || '';
  form.elements.email.value = employee.email || '';
  form.elements.hireDate.value = employee.hire_date || '';
  form.elements.position.value = employee.position || '';
  form.elements.hourlyRate.value = Number(employee.hourly_rate) > 0 ? employee.hourly_rate : '';
  form.elements.pin.value = '';
  form.elements.scheduleId.value = employee.schedule_id ?? '';
  clearMsg($('#editEmployeeMsg'));
  $('#employeeModal').classList.remove('hidden');
  form.elements.name.focus();
}

async function loadEmployees() {
  cachedEmployees = await api('/api/admin/employees');
  $('#employeeBody').innerHTML = cachedEmployees.map((employee) => `
    <tr data-search="${esc([employee.employee_code, employee.name, employee.national_id, employee.email, employee.position].join(' ').toLowerCase())}">
      <td>
        <div class="code-cell">
          <code>${esc(employee.employee_code)}</code>
          <button class="mini-btn copy-code" type="button" data-code="${esc(employee.employee_code)}">Copiar</button>
        </div>
      </td>
      <td><strong>${esc(employee.name)}</strong><br><small class="muted">Cédula: ${esc(employee.national_id || '—')}</small></td>
      <td>${esc(employee.position || '—')}<br><small class="muted">${esc(employee.email || 'Sin correo')}</small></td>
      <td>${esc(employee.schedule_name || 'Sin horario')}</td>
      <td>
        <button class="btn ${employee.active ? 'secondary' : 'danger'} toggle"
                data-id="${employee.id}" data-active="${employee.active}">
          ${employee.active ? 'Activo' : 'Inactivo'}
        </button>
      </td>
      <td><button class="btn secondary edit-employee" type="button" data-id="${employee.id}">Editar</button></td>
    </tr>`).join('') || '<tr><td colspan="6">No hay empleados.</td></tr>';

  $$('.copy-code').forEach((button) => {
    button.onclick = () => copyCode(button.dataset.code);
  });

  $$('.edit-employee').forEach((button) => {
    button.onclick = () => openEmployeeModal(button.dataset.id);
  });

  $$('.toggle').forEach((button) => {
    button.onclick = async () => {
      try {
        await api(`/api/admin/employees/${button.dataset.id}/active`, {
          method: 'PATCH',
          body: JSON.stringify({ active: button.dataset.active !== '1' })
        });
        await Promise.all([loadEmployees(), loadOverview()]);
      } catch (error) {
        alert(error.message);
      }
    };
  });
}

function refreshQr() {
  clearInterval(window.qrInterval);
  if (currentSystem?.license?.blockQrGeneration) {
    $('#qr').removeAttribute('src');
    $('#qrTimer').textContent = '--';
    if (!$('#qrBlockedMsg')) {
      const p = document.createElement('p');
      p.id = 'qrBlockedMsg';
      p.className = 'message show error';
      p.textContent = currentSystem.license.banner?.text || 'Active su licencia para generar el QR de asistencia.';
      $('.qr-wrap')?.insertBefore(p, $('#qr').nextSibling);
    }
    return;
  }
  $('#qrBlockedMsg')?.remove();

  const ttl = Math.max(10, Number(appStatus?.qrTtlSeconds || 45));
  let remaining = ttl;
  const reload = () => {
    $('#qr').src = `/api/admin/qr.png?t=${Date.now()}`;
    remaining = ttl;
    $('#qrTimer').textContent = remaining;
  };

  reload();
  window.qrInterval = setInterval(() => {
    remaining -= 1;
    $('#qrTimer').textContent = Math.max(remaining, 0);
    if (remaining <= 0) reload();
  }, 1000);
}

$$('nav.tabs .tab').forEach((button) => {
  button.onclick = () => {
    $$('nav.tabs .tab').forEach((tab) => tab.classList.remove('active'));
    $$('.panel').forEach((panel) => panel.classList.remove('active'));
    button.classList.add('active');
    $(`#${button.dataset.tab}`).classList.add('active');
    if (button.dataset.tab === 'settings') loadSettings().catch((error) => toast(error.message, false));
  };
});

let loginRole = 'admin';
$$('#loginRoleTabs .tab').forEach((button) => {
  button.onclick = () => {
    $$('#loginRoleTabs .tab').forEach((tab) => tab.classList.remove('active'));
    button.classList.add('active');
    loginRole = button.dataset.role;
    $('#loginRoleTitle').textContent = loginRole === 'kiosk' ? 'Recepción' : 'Administrador';
    $('#loginPassword').value = '';
    clearMsg($('#loginMsg'));
    $('#loginPassword').focus();
  };
});

$('#loginForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  clearMsg($('#loginMsg'));
  button.disabled = true;
  button.textContent = 'Ingresando...';
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      skipAuthRedirect: true,
      body: JSON.stringify({ password: $('#loginPassword').value, role: loginRole })
    });
    if (result.role === 'kiosk') { location.href = '/kiosk.html'; return; }
    location.reload();
  } catch (error) {
    msg($('#loginMsg'), error.message);
    button.disabled = false;
    button.textContent = 'Ingresar';
  }
};

$('#logout').onclick = async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', skipAuthRedirect: true });
  } finally {
    $('#loginPassword').value = '';
    clearMsg($('#loginMsg'));
    $('#login').classList.remove('hidden');
    clearInterval(window.qrInterval);
    setTimeout(() => $('#loginPassword').focus(), 50);
  }
};

$('#refresh').onclick = () => loadOverview().catch((error) => alert(error.message));
$('#reloadEmployees').onclick = () => loadEmployees().catch((error) => toast(error.message, false));
$('#employeeSearch').oninput = () => {
  const query = $('#employeeSearch').value.trim().toLowerCase();
  $('#employeeBody tr').forEach((row) => {
    row.hidden = Boolean(query) && !String(row.dataset.search || '').includes(query);
  });
};
$('#createBackup').onclick = async () => {
  try {
    const result = await api('/api/admin/backup', { method: 'POST' });
    toast(result.cloud?.uploaded ? 'Backup local y en Google Drive creado.' : 'Backup local creado correctamente.');
    await loadSystem();
  } catch (error) { toast(error.message, false); }
};

async function startGoogleOAuth() {
  const result = await api('/api/admin/google/oauth/start', { method: 'POST' });
  window.open(result.url, '_blank', 'noopener');
  toast('Autorizá Google en el navegador. Qubiq detectará la conexión.');
  const started = Date.now();
  const timer = setInterval(async () => {
    try {
      const state = await loadSystem();
      if (state.googleSheetsConfigured) {
        clearInterval(timer);
        toast('Google Sheets y Drive conectados correctamente.');
      } else if (Date.now() - started > 180000) {
        clearInterval(timer);
      }
    } catch { /* esperar el siguiente intento */ }
  }, 2500);
}

$('#googleConnect').onclick = async () => {
  try {
    if (!currentSystem?.googleOAuth?.clientInstalled) return $('#googleClientFile').click();
    await startGoogleOAuth();
  } catch (error) { toast(error.message, false); }
};

$('#googleClientFile').onchange = async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    const credentials = JSON.parse(await file.text());
    await api('/api/admin/google/client', {
      method: 'POST',
      body: JSON.stringify({ credentials })
    });
    await loadSystem();
    toast('Credencial Google cargada. Ahora autorizá la cuenta.');
    await startGoogleOAuth();
  } catch (error) {
    toast(`No se pudo cargar la credencial: ${error.message}`, false);
  } finally {
    event.currentTarget.value = '';
  }
};

$('#employeeForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  clearMsg($('#employeeMsg'));

  try {
    await api('/api/admin/employees', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(formData))
    });
    form.reset();
    msg($('#employeeMsg'), 'Empleado creado.', true);
    await Promise.all([loadEmployees(), loadOverview()]);
  } catch (error) {
    msg($('#employeeMsg'), error.message);
  }
};

$('#editEmployeeForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const id = formData.get('id');
  const body = Object.fromEntries(formData);
  delete body.id;
  clearMsg($('#editEmployeeMsg'));

  try {
    await api(`/api/admin/employees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    msg($('#editEmployeeMsg'), 'Cambios guardados.', true);
    await Promise.all([loadEmployees(), loadOverview()]);
    setTimeout(closeEmployeeModal, 450);
  } catch (error) {
    msg($('#editEmployeeMsg'), error.message);
  }
};

$('#deleteEmployee').onclick = async () => {
  const form = $('#editEmployeeForm');
  const id = form.elements.id.value;
  const name = form.elements.name.value || 'este empleado';
  if (!id || !window.confirm(`¿Eliminar a ${name} de la lista? Su historial se conservará.`)) return;
  try {
    await api(`/api/admin/employees/${id}`, { method: 'DELETE' });
    closeEmployeeModal();
    await Promise.all([loadEmployees(), loadOverview()]);
  } catch (error) {
    msg($('#editEmployeeMsg'), error.message);
  }
};

$('#closeEmployeeModal').onclick = closeEmployeeModal;
$('#cancelEmployeeEdit').onclick = closeEmployeeModal;
$('#employeeModal').onclick = (event) => {
  if (event.target === $('#employeeModal')) closeEmployeeModal();
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#employeeModal').classList.contains('hidden')) closeEmployeeModal();
});

$('#scheduleForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  clearMsg($('#scheduleMsg'));

  try {
    await api('/api/admin/schedules', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    form.reset();
    msg($('#scheduleMsg'), 'Horario creado.', true);
    await loadSchedules();
  } catch (error) {
    msg($('#scheduleMsg'), error.message);
  }
};

$('#editScheduleForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const id = formData.get('id');
  const body = Object.fromEntries(formData);
  delete body.id;
  clearMsg($('#editScheduleMsg'));

  try {
    await api(`/api/admin/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    msg($('#editScheduleMsg'), 'Cambios guardados.', true);
    await Promise.all([loadSchedules(), loadEmployees()]);
    setTimeout(closeScheduleModal, 450);
  } catch (error) {
    msg($('#editScheduleMsg'), error.message);
  }
};

$('#closeScheduleModal').onclick = closeScheduleModal;
$('#cancelScheduleEdit').onclick = closeScheduleModal;
$('#scheduleModal').onclick = (event) => {
  if (event.target === $('#scheduleModal')) closeScheduleModal();
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#scheduleModal').classList.contains('hidden')) closeScheduleModal();
});

async function loadRestReview() {
  const from = encodeURIComponent($('#payFrom').value);
  const to = encodeURIComponent($('#payTo').value);
  const review = await api(`/api/admin/payroll/review?from=${from}&to=${to}`);
  const box = $('#restReview');
  const unresolved = review.unresolvedWeeks || [];
  const seven = review.workedSevenDays || [];
  const conflicts = review.conflicts || [];
  if (!unresolved.length && !seven.length && !conflicts.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return review;
  }
  const cards = unresolved.map((item) => `
    <div class="review-item">
      <strong>${esc(item.empleado)}</strong><span class="badge warn">Descanso por confirmar</span>
      <small class="muted">Semana ${item.semana} → ${item.semanaFin}${item.semanaCompleta ? '' : ' · en curso'}</small>
      <div class="rest-candidates">${item.candidatos.map((date) => `<button type="button" class="mini-btn choose-rest" data-employee="${item.employeeId}" data-date="${date}">${date}</button>`).join('')}</div>
    </div>`).join('');
  const warnings = seven.map((item) => `<div class="review-item danger-review"><strong>${esc(item.empleado)}</strong><span class="badge bad">7 días con marcación</span><small class="muted">Semana ${item.semana} → ${item.semanaFin}</small></div>`).join('');
  const conflictHtml = conflicts.map((item) => `<div class="review-item danger-review"><strong>${esc(item.empleado)}</strong><span class="badge bad">Conflicto</span><small class="muted">${item.fecha}: ${esc(item.mensaje)}</small></div>`).join('');
  box.innerHTML = `<div class="section-head"><div><h3>Revisión de descansos</h3><span class="muted">Elegí el día libre cuando haya más de una posibilidad.</span></div></div>${cards}${warnings}${conflictHtml}`;
  box.classList.remove('hidden');
  $$('.choose-rest').forEach((button) => {
    button.onclick = async () => {
      try {
        await api('/api/admin/day-status', { method: 'POST', body: JSON.stringify({ employeeId: button.dataset.employee, workDate: button.dataset.date, status: 'REST' }) });
        toast(`Descanso confirmado: ${button.dataset.date}`);
        await loadRestReview();
      } catch (error) { toast(error.message, false); }
    };
  });
  return review;
}

async function loadPayroll() {
  try {
    const data = await api(`/api/admin/payroll?from=${encodeURIComponent($('#payFrom').value)}&to=${encodeURIComponent($('#payTo').value)}`);
    $('#payBody').innerHTML = data.map((row) => `
      <tr>
        <td>${row.fecha}</td>
        <td>${esc(row.codigo)}</td>
        <td>${esc(row.empleado)}</td>
        <td>${row.entrada || '—'}</td>
        <td>${row.salida || '—'}</td>
        <td>${formatLateTime(row.tardanzaMin)}</td>
        <td>${formatCountedHours(row.horasTrabajadas)}</td>
      </tr>`).join('') || '<tr><td colspan="7">Sin registros en el rango.</td></tr>';
    msg($('#payMsg'), `${data.length} registros encontrados.`, true);
    await loadRestReview();
  } catch (error) {
    msg($('#payMsg'), error.message);
  }
}

$('#loadPayroll').onclick = loadPayroll;
$('#downloadXlsx').onclick = async () => {
  const from = $('#payFrom').value;
  const to = $('#payTo').value;
  try {
    const response = await fetch(`/api/admin/payroll.xlsx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo generar el libro de Excel.');
    }
    const disposition = response.headers.get('content-disposition') || '';
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] || `Planilla ${from} a ${to}.xlsx`;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    msg($('#payMsg'), `Libro descargado: ${fileName}`, true);
  } catch (error) {
    msg($('#payMsg'), error.message);
  }
};
$('#downloadCsv').onclick = () => {
  const from = encodeURIComponent($('#payFrom').value);
  const to = encodeURIComponent($('#payTo').value);
  location.href = `/api/admin/payroll.csv?from=${from}&to=${to}`;
};
$('#syncSheets').onclick = async () => {
  try {
    const result = await api('/api/admin/sync/google-sheets', {
      method: 'POST',
      body: JSON.stringify({ from: $('#payFrom').value, to: $('#payTo').value })
    });
    const missing = result.missingEmployees?.length ? ` · Sin hoja: ${result.missingEmployees.join(', ')}` : '';
    const open = result.skippedOpen ? ` · Jornadas sin cerrar: ${result.skippedOpen}` : '';
    const unresolved = result.review?.unresolvedWeeks?.length || 0;
    const seven = result.review?.workedSevenDays?.length || 0;
    const review = unresolved ? ` · Revisar descanso en ${unresolved} semana(s)` : (seven ? ` · Atención: ${seven} semana(s) con 7 días marcados` : '');
    const created = result.createdSheet ? ` · Planilla creada automáticamente${result.folderName ? ` en ${result.folderName}` : ''}` : '';
    const employeeTabs = result.autoCreatedEmployees?.length
      ? ` · Pestañas nuevas: ${result.autoCreatedEmployees.map(item => `${item.pestaña} (${item.puesto})`).join(', ')}`
      : '';
    const cloud = result.cloudBackup?.uploaded ? ' · Backup nube ✓' : '';
    msg($('#payMsg'), `Sincronizados ${result.updatedRows} días en ${result.template} (${result.quincena}).${created}${employeeTabs}${missing}${open}${review}${cloud}`, true);
    await loadSystem();
  } catch (error) {
    msg($('#payMsg'), error.message);
  }
};

setInterval(() => {
  if (!$('#login').classList.contains('hidden')) return;
  loadSystem().catch(() => {});
}, 60000);

boot().catch((error) => {
  console.error(error);
  alert(`No se pudo iniciar Qubiq Control: ${error.message}`);
});


let currentSettings = null;

const MAIL_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: 'false' },
  outlook: { host: 'smtp.office365.com', port: 587, secure: 'false' },
  custom: null
};
function detectMailProvider(host = '') {
  const value = String(host).toLowerCase();
  if (value === 'smtp.gmail.com') return 'gmail';
  if (value === 'smtp.office365.com' || value === 'smtp-mail.outlook.com') return 'outlook';
  return 'custom';
}
function applyMailProviderPreset(provider) {
  const preset = MAIL_PRESETS[provider];
  const form = $('#mailSettingsForm');
  if (!preset || !form) return;
  form.elements.host.value = preset.host;
  form.elements.port.value = preset.port;
  form.elements.secure.value = preset.secure;
}

function setBusinessLabel(company = {}) {
  const business = company.businessName && company.businessName !== 'Mi negocio' ? company.businessName : '';
  if ($('#businessLabel')) $('#businessLabel').textContent = business || 'Sistema local';
}

async function loadSettings() {
  currentSettings = await api('/api/admin/settings');
  const company = currentSettings.company || {};
  const form = $('#companySettingsForm');
  if (!form) return currentSettings;
  for (const key of ['businessName','branchName','adminName','adminEmail']) {
    if (form.elements[key]) form.elements[key].value = company[key] || '';
  }
  setBusinessLabel(company);

  const mail = currentSettings.integrations?.mail || {};
  const mailForm = $('#mailSettingsForm');
  if (mailForm) {
    mailForm.elements.host.value = mail.host || '';
    mailForm.elements.port.value = mail.port || 587;
    mailForm.elements.secure.value = String(Boolean(mail.secure));
    mailForm.elements.user.value = mail.user || '';
    mailForm.elements.pass.value = '';
    mailForm.elements.pass.placeholder = mail.configured ? 'Dejar vacía conserva la actual' : 'Obligatoria la primera vez';
    mailForm.elements.from.value = mail.from || mail.user || '';
    const provider = detectMailProvider(mail.host);
    if ($('#mailProviderSettings')) $('#mailProviderSettings').value = provider;
  }
  const account = currentSettings.googleOAuth?.account?.email || '';
  $('#settingsGoogleAccount').textContent = currentSettings.googleSheetsConfigured
    ? `Conectado: ${account || 'cuenta autorizada'}`
    : (currentSettings.googleOAuth?.clientInstalled ? 'Credencial lista. Falta autorizar la cuenta.' : 'Aún no se ha configurado Google.');
  $('#settingsGoogleConnect').textContent = currentSettings.googleSheetsConfigured ? 'Reconectar Google' : 'Conectar Google';
  renderKioskInfo(currentSettings.kioskEnabled);
  return currentSettings;
}

function renderKioskInfo(kioskEnabled) {
  const dotClass = kioskEnabled ? 'good' : 'warn';
  if ($('#kioskInfoDot')) $('#kioskInfoDot').className = `status-dot ${dotClass}`;
  if ($('#kioskInfoText')) $('#kioskInfoText').textContent = kioskEnabled
    ? 'Activo · el personal puede entrar con esta clave y solo ve el QR.'
    : 'No configurado. El inicio de sesión de Recepción no aparece hasta que le pongas una clave.';
  if ($('#kioskDisable')) $('#kioskDisable').classList.toggle('hidden', !kioskEnabled);
}

$('#companySettingsForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  clearMsg($('#companySettingsMsg'));
  try {
    const body = Object.fromEntries(new FormData(form));
    const result = await api('/api/admin/company', { method: 'PATCH', body: JSON.stringify(body) });
    currentSettings = { ...(currentSettings || {}), company: result.company };
    setBusinessLabel(result.company);
    msg($('#companySettingsMsg'), 'Identidad guardada correctamente.', true);
    toast('Personalización actualizada.');
  } catch (error) { msg($('#companySettingsMsg'), error.message); }
};

if ($('#mailProviderSettings')) {
  $('#mailProviderSettings').onchange = (event) => applyMailProviderPreset(event.currentTarget.value);
}

$('#mailSettingsForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  clearMsg($('#mailSettingsMsg'));
  try {
    const body = Object.fromEntries(new FormData(form));
    body.secure = body.secure === 'true';
    body.port = Number(body.port || 587);
    const result = await api('/api/admin/mail', { method: 'PATCH', body: JSON.stringify(body) });
    form.elements.pass.value = '';
    msg($('#mailSettingsMsg'), result.mail.configured ? 'Correo configurado y cifrado.' : 'Configuración guardada; faltan datos para activar el correo.', true);
    await Promise.all([loadSystem(), loadSettings()]);
  } catch (error) { msg($('#mailSettingsMsg'), error.message); }
};

$('#kioskSettingsForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  clearMsg($('#kioskSettingsMsg'));
  try {
    const password = form.elements.kioskPassword.value;
    const result = await api('/api/admin/kiosk', { method: 'POST', body: JSON.stringify({ password }) });
    form.reset();
    appStatus.kioskEnabled = result.kioskEnabled;
    $('#loginRoleTabs').classList.toggle('hidden', !result.kioskEnabled);
    msg($('#kioskSettingsMsg'), 'Contraseña de Recepción guardada.', true);
    await loadSettings();
  } catch (error) { msg($('#kioskSettingsMsg'), error.message); }
};

$('#kioskDisable').onclick = async () => {
  if (!window.confirm('¿Desactivar el acceso de Recepción? El personal ya no podrá entrar con esa clave.')) return;
  clearMsg($('#kioskSettingsMsg'));
  try {
    const result = await api('/api/admin/kiosk/disable', { method: 'POST' });
    appStatus.kioskEnabled = result.kioskEnabled;
    $('#loginRoleTabs').classList.toggle('hidden', !result.kioskEnabled);
    msg($('#kioskSettingsMsg'), 'Acceso de Recepción desactivado.', true);
    await loadSettings();
  } catch (error) { msg($('#kioskSettingsMsg'), error.message); }
};

$('#licenseSettingsForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  clearMsg($('#licenseSettingsMsg'));
  try {
    const body = Object.fromEntries(new FormData(form));
    const result = await api('/api/admin/license', { method: 'POST', body: JSON.stringify(body) });
    msg($('#licenseSettingsMsg'), result.license.valid ? 'Licencia activada correctamente.' : (result.license.message || result.license.banner?.text || 'La licencia no pudo validarse.'), result.license.valid);
    await loadSystem();
  } catch (error) { msg($('#licenseSettingsMsg'), error.message); }
};

$('#licenseRecheck').onclick = async () => {
  clearMsg($('#licenseSettingsMsg'));
  try {
    const result = await api('/api/admin/license/recheck', { method: 'POST' });
    msg($('#licenseSettingsMsg'), result.license.valid ? 'Licencia verificada: activa.' : (result.license.message || result.license.banner?.text || 'La licencia no está activa.'), result.license.valid);
    await loadSystem();
  } catch (error) { msg($('#licenseSettingsMsg'), error.message); }
};

$('#settingsGoogleConnect').onclick = async () => {
  try {
    if (!currentSettings?.googleOAuth?.clientInstalled) {
      $('#googleClientFile').click();
      return;
    }
    await startGoogleOAuth();
  } catch (error) { toast(error.message, false); }
};

$('#settingsMailTest').onclick = async () => {
  try {
    const suggested = currentSettings?.company?.adminEmail || currentSettings?.integrations?.mail?.user || '';
    const to = window.prompt('Correo donde enviar la prueba:', suggested);
    if (!to) return;
    const result = await api('/api/admin/mail/test', { method: 'POST', body: JSON.stringify({ to }) });
    toast(result.sent ? `Correo de prueba enviado a ${to}.` : 'No se pudo enviar el correo.', Boolean(result.sent));
  } catch (error) { toast(error.message, false); }
};
