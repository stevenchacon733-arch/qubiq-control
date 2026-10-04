// Tarjeta "Sucursales" de Configuración. La lógica y las validaciones viven en el servidor.

export function mountBranches({ $, $$, api, msg, clearMsg, toast, esc }) {
  let branches = [];
  const form = $('#branchForm');

  function resetForm() {
    form.reset();
    form.elements.id.value = '';
    $('#branchSubmit').textContent = 'Agregar sucursal';
    $('#branchCancel').classList.add('hidden');
  }

  function render() {
    $('#branchBody').innerHTML = branches.map((branch) => `
      <tr data-id="${branch.id}">
        <td><code>${esc(branch.code)}</code></td>
        <td><strong>${esc(branch.name)}</strong></td>
        <td>${branch.active ? '<span class="badge good">Activa</span>' : '<span class="badge">Inactiva</span>'}</td>
        <td><div class="branch-actions">
          <button type="button" class="mini-btn branch-edit">Editar</button>
          <button type="button" class="mini-btn branch-toggle">${branch.active ? 'Desactivar' : 'Activar'}</button>
        </div></td>
      </tr>`).join('') || '<tr><td colspan="4">Todavía no hay sucursales.</td></tr>';

    $$('#branchBody .branch-edit').forEach((button) => {
      button.addEventListener('click', () => {
        const branch = branches.find((item) => item.id === Number(button.closest('tr').dataset.id));
        if (!branch) return;
        clearMsg($('#branchMsg'));
        form.elements.id.value = branch.id;
        form.elements.name.value = branch.name;
        form.elements.code.value = branch.code;
        $('#branchSubmit').textContent = 'Guardar cambios';
        $('#branchCancel').classList.remove('hidden');
        form.elements.name.focus();
      });
    });
    $$('#branchBody .branch-toggle').forEach((button) => {
      button.addEventListener('click', async () => {
        const branch = branches.find((item) => item.id === Number(button.closest('tr').dataset.id));
        if (!branch) return;
        try {
          await api(`/api/admin/branches/${branch.id}/active`, { method: 'PATCH', body: JSON.stringify({ active: !branch.active }) });
          await load();
        } catch (error) { toast(error.message, false); }
      });
    });
  }

  async function load() {
    branches = await api('/api/admin/branches');
    render();
    return branches;
  }

  form.elements.code.addEventListener('input', (event) => {
    event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6);
  });
  $('#branchCancel').addEventListener('click', () => { resetForm(); clearMsg($('#branchMsg')); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const id = body.id;
    delete body.id;
    clearMsg($('#branchMsg'));
    try {
      const saved = id
        ? await api(`/api/admin/branches/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/admin/branches', { method: 'POST', body: JSON.stringify(body) });
      resetForm();
      msg($('#branchMsg'), id ? `Sucursal ${saved.name} actualizada.` : `Sucursal ${saved.name} creada con el código ${saved.code}.`, true);
      await load();
    } catch (error) {
      msg($('#branchMsg'), error.message);
    }
  });

  return { load };
}
