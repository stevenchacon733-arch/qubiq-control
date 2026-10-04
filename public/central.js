// Tarjeta "Conexión entre sucursales" de Configuración y aviso de modo sucursal.
// Una computadora es central (recibe las marcaciones de las demás) o sucursal (envía las suyas). La lógica y
// las validaciones viven en el servidor.

const REFRESH_MS = 5000;

export function mountCentral({ $, $$, api, msg, clearMsg, toast, esc, branchMode }) {
  const body = $('#centralBody');
  let data = null;
  let shownRole = '';
  let revealed = null;
  let busy = false;

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const hour = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
  const visible = () => $('#settings').classList.contains('active') && $('#login').classList.contains('hidden');

  // ---------- Aviso arriba de la pantalla cuando esta computadora es una sucursal ----------
  function renderBanner() {
    const banner = $('#branchBanner');
    if (!branchMode() || !data?.link?.connected) return banner.classList.add('hidden');
    const link = data.link;
    const place = link.branchName ? `${link.branchName}${link.branchCode ? ` (${link.branchCode})` : ''}` : 'sucursal';
    const waiting = link.queue?.waiting || 0;
    const trouble = Boolean(link.lastError);
    banner.className = `license-banner ${trouble ? 'danger' : 'warn'}`;
    banner.textContent = trouble
      ? `Sucursal ${place}: sin comunicación con la central. ${waiting ? `${waiting} marcación(es) guardada(s) acá, ` : 'Las marcaciones se guardan acá y '}se envían solas cuando vuelva. Motivo: ${link.lastError}`
      : `Sucursal ${place}, conectada a la central. Las marcaciones del lector se envían solas; los empleados, los horarios y la planilla se ven en la central.${waiting ? ` Enviando ${waiting}...` : ''}`;
    banner.classList.remove('hidden');
  }

  // ---------- Partes que se refrescan solas ----------
  function agentState(agent) {
    if (!agent.active) return '<span class="badge">Desactivada</span>';
    if (agent.online) return `<span class="badge good">En línea</span><br><small class="muted">Visto ${esc(hour(agent.lastSeenAt))}${agent.queuePending ? ` · ${agent.queuePending} en cola allá` : ''}</small>`;
    if (agent.lastSeenAt) return `<span class="badge bad">Sin conexión</span><br><small class="muted">Desde ${esc(when(agent.lastSeenAt))}</small>`;
    return '<span class="badge warn">Sin conectar</span>';
  }

  function centralLive() {
    const listener = data.listener || {};
    const status = listener.listening
      ? `<div class="central-status"><span class="status-dot good"></span><div>Esta computadora es la central<small>Recibe las marcaciones de las sucursales por el puerto ${listener.port}.${data.lanUrl ? ` Dentro de esta misma red: ${esc(data.lanUrl)}` : ''}</small></div></div>`
      : `<div class="central-status bad"><span class="status-dot bad"></span><div>La central no está recibiendo<small>${esc(listener.error || 'No hay ninguna sucursal conectada activa.')}</small></div></div>`;
    const rows = data.agents.map((agent) => `
      <tr data-id="${agent.id}" data-name="${esc(agent.name)}">
        <td><strong>${esc(agent.branchName)}</strong> <code>${esc(agent.branchCode)}</code><br><small class="muted">${esc(agent.name)}</small></td>
        <td>${agentState(agent)}</td>
        <td>${agent.readers.length ? agent.readers.map(esc).join('<br>') : '<small class="muted">Sin lector todavía</small>'}</td>
        <td>${agent.eventsReceived}${agent.lastEventAt ? `<br><small class="muted">Última ${esc(when(agent.lastEventAt))}</small>` : ''}</td>
        <td><div class="branch-actions">
          <button type="button" class="mini-btn central-rotate">Clave nueva</button>
          <button type="button" class="mini-btn central-toggle">${agent.active ? 'Desactivar' : 'Activar'}</button>
          ${agent.removable ? '<button type="button" class="mini-btn central-remove">Eliminar</button>' : ''}
        </div></td>
      </tr>`).join('');
    return `${status}
      <div class="table-wrap"><table class="bio-table">
        <thead><tr><th>Sucursal</th><th>Estado</th><th>Lectores</th><th>Marcaciones recibidas</th><th>Acciones</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function branchLive() {
    const link = data.link;
    const queue = link.queue || {};
    const tone = link.lastError ? 'bad' : (queue.waiting ? 'warn' : '');
    return `<div class="central-status ${tone}"><span class="status-dot ${tone || 'good'}"></span><div>Esta computadora es la sucursal ${esc(link.branchName || '')}${link.branchCode ? ` (${esc(link.branchCode)})` : ''}<small>Central: ${esc(link.centralName || '')} · ${esc(link.url)} · clave terminada en ${esc(link.keyHint)}</small></div></div>
      ${link.lastError ? `<div class="message show error">${esc(link.lastError)} Las marcaciones quedan guardadas acá y se envían solas cuando vuelva la conexión.</div>` : ''}
      <div class="central-facts">
        <div><span>En cola</span><strong>${queue.waiting || 0}</strong></div>
        <div><span>Enviadas</span><strong>${queue.synced || 0}</strong></div>
        <div><span>Rechazadas</span><strong>${queue.error || 0}</strong></div>
        <div><span>Última respuesta de la central</span><strong>${esc(hour(link.lastOkAt))}</strong></div>
      </div>
      <div class="button-row">
        <button type="button" class="btn" id="centralFlush">Enviar ahora</button>
        ${queue.error ? '<button type="button" class="btn secondary" id="centralRetry">Reintentar rechazadas</button>' : ''}
        <button type="button" class="btn danger" id="centralDisconnect">Desconectar de la central</button>
      </div>`;
  }

  function bindLive() {
    $$('#centralLive .central-rotate').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest('tr');
        if (!window.confirm(`¿Generar una clave nueva para ${row.dataset.name}? La clave actual deja de funcionar en el acto y hay que volver a conectar esa computadora con la nueva.`)) return;
        act(async () => {
          const result = await api(`/api/admin/central/agents/${row.dataset.id}/key`, { method: 'POST', body: '{}' });
          revealed = { name: result.agent.name, key: result.key };
        });
      });
    });
    $$('#centralLive .central-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest('tr');
        const agent = data.agents.find((item) => String(item.id) === row.dataset.id);
        if (agent?.active && !window.confirm(`¿Desactivar ${agent.name}? La central deja de aceptar sus marcaciones; quedan guardadas en esa sucursal hasta que se vuelva a activar.`)) return;
        act(() => api(`/api/admin/central/agents/${row.dataset.id}/active`, { method: 'PATCH', body: JSON.stringify({ active: !agent?.active }) }));
      });
    });
    $$('#centralLive .central-remove').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest('tr');
        if (!window.confirm(`¿Eliminar ${row.dataset.name}? Su clave deja de servir.`)) return;
        act(() => api(`/api/admin/central/agents/${row.dataset.id}`, { method: 'DELETE' }));
      });
    });
    $('#centralFlush')?.addEventListener('click', () => act(async () => {
      const result = await api('/api/admin/central/link/flush', { method: 'POST', body: '{}' });
      toast(result.sent ? `${result.sent} marcación(es) enviada(s) a la central.` : 'No había marcaciones en cola.');
    }));
    $('#centralRetry')?.addEventListener('click', () => act(async () => {
      const result = await api('/api/admin/central/link/retry', { method: 'POST', body: '{}' });
      toast(`${result.retried} marcación(es) vuelven a la cola.`);
    }));
    $('#centralDisconnect')?.addEventListener('click', async () => {
      if (!window.confirm('¿Desconectar esta computadora de la central? Vuelve a trabajar sola y deja de enviar marcaciones.')) return;
      try {
        await api('/api/admin/central/link', { method: 'DELETE' });
      } catch (error) {
        if (error.code !== 'confirm') return toast(error.message, false);
        if (!window.confirm(`${error.message}\n\n¿Desconectar igual?`)) return;
        try { await api('/api/admin/central/link?force=true', { method: 'DELETE' }); }
        catch (again) { return toast(again.message, false); }
      }
      location.reload();
    });
  }

  function renderLive() {
    const live = $('#centralLive');
    if (!live) return;
    live.innerHTML = data.role === 'central' ? centralLive() : (data.role === 'branch' ? branchLive()
      : '<p class="muted">Esta computadora trabaja sola. Para llevar varias sucursales en un solo sistema, una computadora hace de central y las demás le envían las marcaciones de su lector.</p>');
    bindLive();
  }

  // ---------- Clave recién creada: se muestra una sola vez ----------
  function renderKey() {
    const box = $('#centralKey');
    if (!box) return;
    // Mientras la clave está a la vista no se vuelve a dibujar: se perdería lo que la persona está seleccionando.
    if (box.dataset.key === (revealed?.key || '')) return;
    box.dataset.key = revealed?.key || '';
    if (!revealed) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="central-key">
        <strong>Clave de ${esc(revealed.name)}</strong><br>
        <small class="muted">Copiala ahora: no se vuelve a mostrar. En la computadora de esa sucursal abrí Configuración, "Conexión entre sucursales", "Esta computadora es una sucursal", y pegala ahí junto con la dirección de esta central.</small>
        <div class="bio-id"><input id="centralKeyValue" readonly value="${esc(revealed.key)}" aria-label="Clave de sucursal"><button type="button" class="mini-btn" id="centralKeyCopy">Copiar</button></div>
        <button type="button" class="mini-btn" id="centralKeyHide">Ya la guardé</button>
      </div>`;
    $('#centralKeyCopy').addEventListener('click', () => {
      const input = $('#centralKeyValue');
      input.focus();
      input.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      toast(copied ? 'Clave copiada.' : 'Seleccioná la clave y copiala con Ctrl+C.', copied);
    });
    $('#centralKeyHide').addEventListener('click', () => { revealed = null; renderKey(); });
  }

  // ---------- Formularios (solo se rearman cuando cambia el papel de esta computadora) ----------
  async function renderForms() {
    const forms = $('#centralForms');
    if (data.role === 'branch') { forms.innerHTML = ''; return; }
    let branches = [];
    try { branches = (await api('/api/admin/branches')).filter((branch) => branch.active); } catch { branches = []; }
    const options = `<option value="">Elegí la sucursal</option>${branches.map((branch) => `<option value="${branch.id}">${esc(branch.name)} (${esc(branch.code)})</option>`).join('')}`;
    const agentForm = `<form id="centralAgentForm" autocomplete="off">
        <h3>${data.role === 'central' ? 'Conectar otra sucursal' : 'Esta computadora es la central'}</h3>
        <p class="muted">${data.role === 'central' ? 'Cada computadora de sucursal lleva su propia clave.' : 'Recibe las marcaciones de las demás. Creá una clave para cada sucursal que se va a conectar.'}${branches.length < 2 ? ' Primero agregá la otra sucursal en la tarjeta "Sucursales".' : ''}</p>
        <label>Sucursal que se conecta<select name="branchId" required>${options}</select></label>
        <label>Nombre de esa computadora<input name="name" maxlength="80" placeholder="Se sugiere solo"></label>
        <button class="btn">Crear clave de sucursal</button>
        <div id="centralAgentMsg" class="message"></div>
      </form>`;
    const linkForm = `<form id="centralLinkForm" autocomplete="off">
        <h3>Esta computadora es una sucursal</h3>
        <p class="muted">Envía las marcaciones de su lector a la central. La dirección y la clave se piden en la central.</p>
        <label>Dirección de la central<input name="url" required maxlength="200" placeholder="https://..."></label>
        <label>Clave de sucursal<input name="key" type="password" required maxlength="140" autocomplete="off" placeholder="qbq_..."></label>
        <button class="btn">Conectar con la central</button>
        <div id="centralLinkMsg" class="message"></div>
      </form>`;
    forms.innerHTML = data.role === 'central' ? agentForm : `<div class="central-choice">${agentForm}${linkForm}</div>`;

    $('#centralAgentForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      clearMsg($('#centralAgentMsg'));
      try {
        const result = await api('/api/admin/central/agents', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        revealed = { name: result.agent.name, key: result.key };
        await load();
      } catch (error) { msg($('#centralAgentMsg'), error.message); }
    });

    $('#centralLinkForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      const payload = Object.fromEntries(new FormData(form));
      clearMsg($('#centralLinkMsg'));
      button.disabled = true;
      button.textContent = 'Conectando...';
      try {
        try {
          await api('/api/admin/central/link', { method: 'PUT', body: JSON.stringify(payload) });
        } catch (error) {
          if (error.code !== 'confirm' || !window.confirm(`${error.message}\n\n¿Conectar igual?`)) throw error;
          await api('/api/admin/central/link', { method: 'PUT', body: JSON.stringify({ ...payload, confirm: true }) });
        }
        location.reload();
      } catch (error) {
        msg($('#centralLinkMsg'), error.message);
        button.disabled = false;
        button.textContent = 'Conectar con la central';
      }
    });
  }

  async function act(work) {
    if (busy) return;
    busy = true;
    try { await work(); } catch (error) { toast(error.message, false); }
    busy = false;
    await load().catch(() => {});
  }

  async function load() {
    data = await api('/api/admin/central');
    if (!$('#centralLive')) body.innerHTML = '<div id="centralLive"></div><div id="centralKey"></div><div id="centralForms"></div>';
    renderLive();
    renderKey();
    renderBanner();
    if (shownRole !== data.role) {
      shownRole = data.role;
      await renderForms();
    }
    return data;
  }

  setInterval(() => {
    if (busy || document.hidden || $('#login').classList.contains('hidden') === false) return;
    if (visible() || branchMode()) load().catch(() => {});
  }, REFRESH_MS);

  return { load };
}
