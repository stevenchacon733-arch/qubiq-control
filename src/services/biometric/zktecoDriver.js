// Capa de hardware para terminales ZKTeco. El resto de Qubiq solo conoce esta interfaz,
// de modo que otro modelo o marca se agrega registrando un driver nuevo en index.js.
import { ZkError, ZkSession } from './zkProtocol.js';

const pad = (value, size = 2) => String(value).padStart(size, '0');

function validTime(t) {
  if (!t || t.year < 2015 || t.year > 2099) return false;
  if (t.month < 1 || t.month > 12 || t.day < 1 || t.hour > 23 || t.minute > 59 || t.second > 59) return false;
  return t.day <= new Date(Date.UTC(t.year, t.month, 0)).getUTCDate();
}

const stamp = (t) => `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;

async function withSession(device, work) {
  const session = new ZkSession({
    ip: device.ip,
    port: device.port,
    connectTimeoutMs: device.connectTimeoutMs ?? 5000,
    timeoutMs: device.timeoutMs ?? 8000
  });
  try {
    await session.open(device.commKey);
    return await work(session);
  } finally {
    await session.close();
  }
}

async function readInfo(session) {
  const info = { latencyMs: session.connectMs };
  const safe = async (key, read) => { try { info[key] = await read(); } catch (error) { if (error.code !== 'TIMEOUT') throw error; } };
  await safe('serial', () => session.option('~SerialNumber'));
  await safe('model', () => session.option('~DeviceName'));
  await safe('platform', () => session.option('~Platform'));
  await safe('mac', () => session.option('MAC'));
  await safe('firmware', () => session.firmware());
  const time = await session.deviceTime().catch(() => null);
  info.deviceTime = validTime(time) ? stamp(time) : null;
  info.sizes = await session.sizes();
  return info;
}

export const zktecoDriver = {
  id: 'zkteco',
  label: 'ZKTeco (TCP/IP 4370)',

  // Comprueba que el puerto responde y que la sesión se autentica.
  testConnection: (device) => withSession(device, async (session) => ({
    latencyMs: session.connectMs,
    sizes: await session.sizes()
  })),

  diagnostics: (device) => withSession(device, readInfo),

  // Cuenta rápida para saber si hay marcaciones nuevas sin descargar todo el registro.
  peek: (device) => withSession(device, async (session) => ({
    latencyMs: session.connectMs,
    sizes: await session.sizes()
  })),

  // Descarga las marcaciones. Nunca borra nada del dispositivo.
  readAttendance: (device) => withSession(device, async (session) => {
    const { sizes, records } = await session.attendance();
    return {
      latencyMs: session.connectMs,
      sizes,
      events: records.map((record) => ({
        userId: record.userId,
        valid: validTime(record.time) && /^[A-Za-z0-9]{1,23}$/.test(record.userId),
        localStamp: validTime(record.time) ? stamp(record.time) : null,
        time: record.time,
        verifyStatus: record.status,
        punchState: record.punch
      }))
    };
  }),

  readUsers: (device) => withSession(device, (session) => session.users()),

  // Crea el usuario (ID + nombre) si no existe y pide la huella en el propio lector.
  enrollUser: (device, { userId, name, waitMs = 60000, replace = false }) => withSession(device, async (session) => {
    if (!/^\d{1,9}$/.test(String(userId))) throw new ZkError('El ID biométrico debe ser numérico.', 'BAD_ID');
    let users = await session.users();
    let existing = users.find((user) => user.userId === String(userId));
    let created = false;
    if (!existing) {
      const used = new Set(users.map((user) => user.uid));
      let uid = 1;
      while (used.has(uid)) uid += 1;
      if (uid > 65000) throw new ZkError('El lector no tiene espacio para más usuarios.', 'FULL');
      let packetSize = session.userPacketSize || 72;
      await session.writeUser({ uid, userId, name, packetSize });
      users = await session.users();
      existing = users.find((user) => user.userId === String(userId) && user.uid === uid);
      if (!existing && session.userPacketSize && session.userPacketSize !== packetSize) {
        // El modelo usa el otro formato de usuario: se deshace y se reintenta una vez.
        packetSize = session.userPacketSize;
        await session.deleteUserSlot(uid);
        await session.writeUser({ uid, userId, name, packetSize });
        users = await session.users();
        existing = users.find((user) => user.userId === String(userId) && user.uid === uid);
      }
      if (!existing) throw new ZkError('El lector no confirmó la creación del usuario.', 'USER_VERIFY');
      created = true;
    }
    const result = await session.enroll({ userId, waitMs, replace: replace && !created });
    return { ...result, created, uid: existing.uid };
  })
};
