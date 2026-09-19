let step = 0;
const byId = (id) => document.getElementById(id);
const steps = [...document.querySelectorAll('.wizard-step')];
const dots = [...document.querySelectorAll('.setup-progress i')];
const message = byId('msg');

const MAIL_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false },
  custom: { host: '', port: 587, secure: false }
};

function show(n) {
  step = Math.max(0, Math.min(steps.length - 1, n));
  steps.forEach((node, index) => node.classList.toggle('active', index === step));
  dots.forEach((node, index) => node.classList.toggle('active', index <= step));
  if (step === 1) passwordStepOk();
  if (step === steps.length - 1) {
    byId('sumBusiness').textContent = byId('businessName').value.trim() || '—';
    byId('sumBranch').textContent = byId('branchName').value.trim() || '—';
    byId('sumAdmin').textContent = byId('adminName').value.trim() || 'Administrador';
    byId('sumMail').textContent = byId('skipMail').checked ? 'Pendiente' : (byId('mailUser').value.trim() || 'Pendiente');
  }
}

function requiredOk() {
  const inputs = [...steps[step].querySelectorAll('input[required]')];
  return inputs.every((input) => input.reportValidity());
}

function passwordStepOk({ showMessage = false } = {}) {
  if (step !== 1) return true;
  const password = byId('password').value;
  const confirm = byId('confirm').value;
  const checks = {
    length: password.length >= 10,
    letter: /[A-Za-z]/.test(password),
    number: /\d/.test(password),
    match: confirm.length > 0 && password === confirm
  };
  const map = [['pwRuleLength', checks.length], ['pwRuleLetter', checks.letter], ['pwRuleNumber', checks.number], ['pwRuleMatch', checks.match]];
  for (const [id, ok] of map) { const el = byId(id); el.classList.toggle('ok', ok); el.textContent = (ok ? '✓ ' : '○ ') + el.textContent.replace(/^[✓○]\s*/, ''); }
  const valid = Object.values(checks).every(Boolean);
  byId('adminNext').disabled = !valid;
  const msg = byId('passwordStepMsg');
  msg.className = 'message'; msg.textContent = '';
  if (showMessage && !valid) { msg.textContent = 'La contraseña debe cumplir todos los requisitos antes de continuar.'; msg.className = 'message show error'; }
  return valid;
}function mailStepOk() {
  if (step !== 2 || byId('skipMail').checked) return true;
  const user = byId('mailUser').value.trim();
  const pass = byId('mailPass').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
    byId('mailUser').reportValidity();
    alert('Ingresá un correo remitente válido o marcá “Configurar después”.');
    return false;
  }
  if (pass.length < 4) {
    alert('Ingresá la contraseña de aplicación del correo o marcá “Configurar después”.');
    return false;
  }
  if (byId('mailProvider').value === 'custom' && !byId('mailHost').value.trim()) {
    alert('Indicá el servidor SMTP del proveedor.');
    return false;
  }
  return true;
}

document.querySelectorAll('.next').forEach((button) => button.addEventListener('click', () => {
  if (requiredOk() && passwordStepOk({ showMessage: true }) && mailStepOk()) show(step + 1);
}));
document.querySelectorAll('.back').forEach((button) => button.addEventListener('click', () => show(step - 1)));
for (const id of ['password','confirm']) byId(id).addEventListener('input', () => passwordStepOk());

function updateMailPreset() {
  const provider = byId('mailProvider').value;
  const preset = MAIL_PRESETS[provider];
  byId('customMailFields').classList.toggle('hidden', provider !== 'custom');
  if (provider !== 'custom') {
    byId('mailHost').value = preset.host;
    byId('mailPort').value = String(preset.port);
  }
}
byId('mailProvider').addEventListener('change', updateMailPreset);
byId('skipMail').addEventListener('change', () => {
  const disabled = byId('skipMail').checked;
  for (const id of ['mailProvider','mailUser','mailPass','mailHost','mailPort']) byId(id).disabled = disabled;
});
updateMailPreset();

document.querySelector('#setup').addEventListener('submit', async (event) => {
  event.preventDefault();
  message.className = 'message';
  message.textContent = '';
  const password = byId('password').value;
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    message.textContent = 'Use una contraseña de al menos 10 caracteres que incluya letras y números.';
    message.className = 'message show error';
    return;
  }
  if (password !== byId('confirm').value) {
    message.textContent = 'Las contraseñas no coinciden.';
    message.className = 'message show error';
    return;
  }
  const finish = byId('finish');
  finish.disabled = true;
  finish.textContent = 'Configurando…';  try {
    const provider = byId('mailProvider').value;
    const preset = MAIL_PRESETS[provider];
    const mail = byId('skipMail').checked ? null : {
      host: byId('mailHost').value.trim() || preset.host,
      port: Number(byId('mailPort').value || preset.port),
      secure: Boolean(preset.secure),
      user: byId('mailUser').value.trim(),
      pass: byId('mailPass').value.trim(),
      from: byId('mailUser').value.trim()
    };
    const body = {
      businessName: byId('businessName').value.trim(),
      branchName: byId('branchName').value.trim(),
      adminName: byId('adminName').value.trim() || 'Administrador',
      adminEmail: byId('adminEmail').value.trim(),
      password,
      mail
    };
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo completar la configuración.');
    location.href = '/admin.html';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'message show error';
    finish.disabled = false;
    finish.textContent = 'Finalizar configuración';
  }
});