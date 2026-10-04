// Cliente del protocolo tradicional ZKTeco sobre TCP (puerto 4370).
// No es HTTP ni REST: es un protocolo binario con cabecera propia.
// Solo implementa las operaciones que Qubiq necesita para asistencia.
import net from 'node:net';

const USHRT_MAX = 65535;
const TCP_MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CHUNK = 0xffc0;

export const CMD = Object.freeze({
  CONNECT: 1000,
  EXIT: 1001,
  AUTH: 1102,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_UNAUTH: 2005,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  PREPARE_BUFFER: 1503,
  READ_BUFFER: 1504,
  USER_WRQ: 8,
  USERTEMP_RRQ: 9,
  OPTIONS_RRQ: 11,
  ATTLOG_RRQ: 13,
  DELETE_USER: 18,
  GET_FREE_SIZES: 50,
  STARTVERIFY: 60,
  STARTENROLL: 61,
  CANCELCAPTURE: 62,
  DEL_USER_TEMP: 134,
  GET_TIME: 201,
  REG_EVENT: 500,
  REFRESHDATA: 1013,
  GET_VERSION: 1100
});
const FCT_USER = 5;
// Tipos de aviso en tiempo real (viajan en el campo de sesión del paquete).
const EVENT = Object.freeze({ ENROLL_FINGER: 8, FINGER_SCORE: 256 });
const OTHER_EVENTS = new Set([1, 2, 4, 16, 32, 64, 128, 512, 1024]);

export class ZkError extends Error {
  constructor(message, code = 'ZK_ERROR') {
    super(message);
    this.name = 'ZkError';
    this.code = code;
  }
}

export function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum += i === buf.length - 1 ? buf[i] : buf.readUInt16LE(i);
    sum %= USHRT_MAX;
  }
  return USHRT_MAX - sum - 1;
}

// Clave de autenticación derivada de la "communication key" y la sesión.
export function makeCommKey(key, sessionId, ticks = 50) {
  const numericKey = Number(key) >>> 0;
  let k = 0;
  for (let i = 0; i < 32; i += 1) {
    k = (numericKey & (1 << i)) ? ((k << 1) | 1) >>> 0 : (k << 1) >>> 0;
  }
  k = (k + Number(sessionId)) >>> 0;
  const a = Buffer.alloc(4);
  a.writeUInt32LE(k, 0);
  a[0] ^= 0x5a; a[1] ^= 0x4b; a[2] ^= 0x53; a[3] ^= 0x4f; // "ZKSO"
  const b = Buffer.from([a[2], a[3], a[0], a[1]]);
  const t = ticks & 0xff;
  return Buffer.from([b[0] ^ t, b[1] ^ t, t, b[3] ^ t]);
}

export function decodeTime(value) {
  let t = value >>> 0;
  const second = t % 60; t = Math.floor(t / 60);
  const minute = t % 60; t = Math.floor(t / 60);
  const hour = t % 24; t = Math.floor(t / 24);
  const day = (t % 31) + 1; t = Math.floor(t / 31);
  const month = (t % 12) + 1; t = Math.floor(t / 12);
  const year = t + 2000;
  return { year, month, day, hour, minute, second };
}

export function encodeTime({ year, month, day, hour, minute, second }) {
  return ((((year % 100) * 12 * 31) + ((month - 1) * 31) + day - 1) * 86400)
    + ((hour * 60 + minute) * 60) + second;
}

function cString(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('latin1').trim();
}

function utf8CString(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8').split(String.fromCharCode(0xfffd)).join('').trim();
}

export class ZkSession {
  constructor({ ip, port = 4370, connectTimeoutMs = 5000, timeoutMs = 8000, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.ip = ip;
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.socket = null;
    this.sessionId = 0;
    this.replyId = USHRT_MAX - 1;
    this.pending = Buffer.alloc(0);
    this.frames = [];
    this.waiter = null;
    this.failure = null;
    this.connectMs = null;
    this.userPacketSize = null;
  }

  #fail(error) {
    if (!this.failure) this.failure = error;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(this.failure); }
    this.socket?.destroy();
  }

  #onData(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      if (!this.pending.subarray(0, 4).equals(TCP_MAGIC)) {
        return this.#fail(new ZkError('El dispositivo respondió con un formato desconocido.', 'PROTOCOL'));
      }
      const length = this.pending.readUInt32LE(4);
      if (length < 8 || length > MAX_FRAME_BYTES) {
        return this.#fail(new ZkError('El dispositivo envió un paquete de tamaño inválido.', 'PROTOCOL'));
      }
      if (this.pending.length < 8 + length) break;
      const payload = this.pending.subarray(8, 8 + length);
      this.pending = this.pending.subarray(8 + length);
      const frame = {
        code: payload.readUInt16LE(0),
        sessionId: payload.readUInt16LE(4),
        replyId: payload.readUInt16LE(6),
        data: Buffer.from(payload.subarray(8))
      };
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.frames.push(frame);
      }
    }
  }

  nextFrame(timeoutMs = this.timeoutMs) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new ZkError('El dispositivo no respondió a tiempo.', 'TIMEOUT'));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  #write(command, data, replyId) {
    const body = Buffer.alloc(8 + data.length);
    body.writeUInt16LE(command, 0);
    body.writeUInt16LE(0, 2);
    body.writeUInt16LE(this.sessionId, 4);
    body.writeUInt16LE(replyId, 6);
    data.copy(body, 8);
    body.writeUInt16LE(checksum(body), 2);
    const nextReply = (replyId + 1) % USHRT_MAX;
    body.writeUInt16LE(nextReply, 6);
    const top = Buffer.alloc(8);
    TCP_MAGIC.copy(top, 0);
    top.writeUInt32LE(body.length, 4);
    if (this.failure) throw this.failure;
    this.socket.write(Buffer.concat([top, body]));
    return nextReply;
  }

  async command(command, data = Buffer.alloc(0), { timeoutMs = this.timeoutMs, onEvent = null } = {}) {
    // Descarta respuestas atrasadas de un comando anterior; conserva los eventos.
    for (const stale of this.frames.splice(0)) {
      if (stale.code === CMD.REG_EVENT) { this.ackEvent(); onEvent?.(stale); }
    }
    this.#write(command, data, this.replyId);
    for (;;) {
      const frame = await this.nextFrame(timeoutMs);
      if (frame.code === CMD.REG_EVENT) { // evento en tiempo real intercalado
        this.ackEvent();
        onEvent?.(frame);
        continue;
      }
      this.replyId = frame.replyId;
      return frame;
    }
  }

  ackEvent() {
    try { this.#write(CMD.ACK_OK, Buffer.alloc(0), USHRT_MAX - 1); } catch { /* sesión cerrada */ }
  }

  async open(commKey = '') {
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.ip, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ZkError(`Sin respuesta de ${this.ip}:${this.port} (tiempo agotado).`, 'CONNECT_TIMEOUT'));
      }, this.connectTimeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new ZkError(`No se pudo conectar a ${this.ip}:${this.port} (${error.code || error.message}).`, 'CONNECT_FAILED'));
      });
      this.socket = socket;
    });
    this.connectMs = Date.now() - started;
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.on('error', (error) => this.#fail(new ZkError(`Conexión interrumpida (${error.code || error.message}).`, 'SOCKET')));
    this.socket.on('close', () => this.#fail(new ZkError('El dispositivo cerró la conexión.', 'CLOSED')));

    let frame = await this.command(CMD.CONNECT);
    this.sessionId = frame.sessionId;
    if (frame.code === CMD.ACK_UNAUTH) {
      frame = await this.command(CMD.AUTH, makeCommKey(commKey || 0, this.sessionId));
      if (frame.code !== CMD.ACK_OK) {
        throw new ZkError('El dispositivo rechazó la clave de comunicación.', 'AUTH');
      }
    } else if (frame.code !== CMD.ACK_OK) {
      throw new ZkError(`El dispositivo rechazó la conexión (código ${frame.code}).`, 'REJECTED');
    }
    return this;
  }

  async close() {
    if (!this.socket) return;
    try {
      if (!this.failure) await this.command(CMD.EXIT, Buffer.alloc(0), { timeoutMs: 1500 });
    } catch { /* cierre de cortesía */ }
    this.socket.removeAllListeners('close');
    this.socket.on('error', () => {});
    this.socket.destroy();
    this.socket = null;
    if (!this.failure) this.failure = new ZkError('Sesión cerrada.', 'CLOSED');
  }

  async option(name) {
    const frame = await this.command(CMD.OPTIONS_RRQ, Buffer.from(`${name}\0`, 'latin1'));
    if (frame.code !== CMD.ACK_OK) return '';
    const text = cString(frame.data);
    const index = text.indexOf('=');
    return (index === -1 ? '' : text.slice(index + 1)).replace(/[^\x20-\x7E]/g, '').slice(0, 80);
  }

  async firmware() {
    const frame = await this.command(CMD.GET_VERSION);
    return frame.code === CMD.ACK_OK ? cString(frame.data).replace(/[^\x20-\x7E]/g, '').slice(0, 80) : '';
  }

  async deviceTime() {
    const frame = await this.command(CMD.GET_TIME);
    if (frame.code !== CMD.ACK_OK || frame.data.length < 4) return null;
    return decodeTime(frame.data.readUInt32LE(0));
  }

  async sizes() {
    const frame = await this.command(CMD.GET_FREE_SIZES);
    if (frame.code !== CMD.ACK_OK || frame.data.length < 80) {
      throw new ZkError('El dispositivo no informó su capacidad.', 'SIZES');
    }
    const field = (i) => frame.data.readInt32LE(i * 4);
    return {
      users: field(4), fingers: field(6), records: field(8),
      fingersCapacity: field(14), usersCapacity: field(15), recordsCapacity: field(16)
    };
  }

  async #readChunk(start, size) {
    const request = Buffer.alloc(8);
    request.writeInt32LE(start, 0);
    request.writeInt32LE(size, 4);
    const first = await this.command(CMD.READ_BUFFER, request);
    if (first.code === CMD.DATA) return first.data;
    if (first.code !== CMD.PREPARE_DATA || first.data.length < 4) {
      throw new ZkError('El dispositivo no entregó los datos solicitados.', 'READ');
    }
    const expected = first.data.readUInt32LE(0);
    if (expected > this.maxBytes) throw new ZkError('El dispositivo anunció un bloque demasiado grande.', 'PROTOCOL');
    const parts = [];
    let received = 0;
    for (;;) {
      const frame = await this.nextFrame();
      if (frame.code === CMD.DATA) {
        parts.push(frame.data);
        received += frame.data.length;
        if (received > expected + 64) throw new ZkError('El dispositivo envió más datos de los anunciados.', 'PROTOCOL');
      } else if (frame.code === CMD.ACK_OK) {
        this.replyId = frame.replyId;
        break;
      } else if (frame.code === CMD.REG_EVENT) {
        this.ackEvent();
      } else {
        throw new ZkError('Respuesta inesperada durante la descarga.', 'READ');
      }
    }
    if (received < expected) throw new ZkError('La descarga quedó incompleta.', 'READ');
    return Buffer.concat(parts).subarray(0, expected);
  }

  async readWithBuffer(command, fct = 0, ext = 0) {
    const request = Buffer.alloc(11);
    request.writeInt8(1, 0);
    request.writeInt16LE(command, 1);
    request.writeInt32LE(fct, 3);
    request.writeInt32LE(ext, 7);
    const frame = await this.command(CMD.PREPARE_BUFFER, request);
    if (frame.code === CMD.DATA) return frame.data;
    if (frame.code !== CMD.ACK_OK || frame.data.length < 5) {
      throw new ZkError('El dispositivo no admite la lectura solicitada.', 'READ');
    }
    const size = frame.data.readUInt32LE(1);
    if (size > this.maxBytes) throw new ZkError('El dispositivo anunció un volumen de datos fuera de rango.', 'PROTOCOL');
    const parts = [];
    for (let start = 0; start < size; start += MAX_CHUNK) {
      parts.push(await this.#readChunk(start, Math.min(MAX_CHUNK, size - start)));
    }
    try { await this.command(CMD.FREE_DATA); } catch { /* liberar buffer es opcional */ }
    return Buffer.concat(parts);
  }

  async users() {
    const sizes = await this.sizes();
    if (sizes.users <= 0) return [];
    const data = await this.readWithBuffer(CMD.USERTEMP_RRQ, FCT_USER);
    if (data.length <= 4) return [];
    const total = data.readUInt32LE(0);
    const body = data.subarray(4, 4 + total);
    const size = total / sizes.users;
    if (size !== 28 && size !== 72) {
      throw new ZkError('No se reconoce el formato de usuarios de este modelo.', 'USER_FORMAT');
    }
    this.userPacketSize = size;
    const users = [];
    for (let offset = 0; offset + size <= body.length; offset += size) {
      const row = body.subarray(offset, offset + size);
      const uid = row.readUInt16LE(0);
      const privilege = row[2];
      if (size === 28) {
        users.push({ uid, privilege, name: utf8CString(row.subarray(8, 16)), userId: String(row.readUInt32LE(24)) });
      } else {
        users.push({ uid, privilege, name: utf8CString(row.subarray(11, 35)), userId: cString(row.subarray(48, 72)) });
      }
    }
    return users;
  }

  async attendance() {
    const sizes = await this.sizes();
    if (sizes.records <= 0) return { sizes, records: [] };
    const data = await this.readWithBuffer(CMD.ATTLOG_RRQ);
    if (data.length <= 4) return { sizes, records: [] };
    const total = data.readUInt32LE(0);
    const body = data.subarray(4, 4 + total);
    const exact = total / sizes.records;
    const size = [8, 16, 40].includes(exact) ? exact : [40, 16, 8].find((s) => total % s === 0 && total / s >= sizes.records);
    if (!size) throw new ZkError('No se reconoce el formato de marcaciones de este modelo.', 'ATT_FORMAT');
    let uidMap = null;
    if (size === 8) uidMap = new Map((await this.users()).map((user) => [user.uid, user.userId]));
    const records = [];
    for (let offset = 0; offset + size <= body.length; offset += size) {
      const row = body.subarray(offset, offset + size);
      if (size === 8) {
        const uid = row.readUInt16LE(0);
        records.push({ userId: uidMap.get(uid) || String(uid), status: row[2], time: decodeTime(row.readUInt32LE(3)), punch: row[7] });
      } else if (size === 16) {
        records.push({ userId: String(row.readUInt32LE(0)), time: decodeTime(row.readUInt32LE(4)), status: row[8], punch: row[9] });
      } else {
        records.push({ userId: cString(row.subarray(2, 26)), status: row[26], time: decodeTime(row.readUInt32LE(27)), punch: row[31] });
      }
    }
    return { sizes, records };
  }

  // Crea o actualiza únicamente el ID y el nombre visible. No toca huellas.
  async writeUser({ uid, userId, name, packetSize }) {
    let packet;
    if (packetSize === 28) {
      packet = Buffer.alloc(28);
      packet.writeUInt16LE(uid, 0);
      Buffer.from(name, 'utf8').subarray(0, 8).copy(packet, 8);
      packet.writeUInt32LE(Number(userId) >>> 0, 24);
    } else {
      packet = Buffer.alloc(72);
      packet.writeUInt16LE(uid, 0);
      Buffer.from(name, 'utf8').subarray(0, 23).copy(packet, 11);
      Buffer.from(String(userId), 'latin1').subarray(0, 23).copy(packet, 48);
    }
    const frame = await this.command(CMD.USER_WRQ, packet);
    if (frame.code !== CMD.ACK_OK) throw new ZkError('El dispositivo no aceptó el usuario.', 'USER_WRITE');
    await this.command(CMD.REFRESHDATA).catch(() => {});
  }

  async deleteUserSlot(uid) {
    const data = Buffer.alloc(2);
    data.writeUInt16LE(uid, 0);
    await this.command(CMD.DELETE_USER, data);
    await this.command(CMD.REFRESHDATA).catch(() => {});
  }

  // Pone el lector a pedir el dedo. La huella se captura y queda SOLO en el lector.
  // replace=true borra antes la huella anterior de ese dedo (necesario para cambiarla).
  async enroll({ userId, finger = 0, waitMs = 60000, replace = false, onProgress = null }) {
    const id24 = Buffer.alloc(24);
    Buffer.from(String(userId), 'latin1').subarray(0, 23).copy(id24, 0);
    if (replace) await this.command(CMD.DEL_USER_TEMP, Buffer.concat([id24, Buffer.from([finger])])).catch(() => {});
    const before = (await this.sizes()).fingers;
    const flags = Buffer.alloc(4);
    flags.writeUInt32LE(0xffff, 0);
    await this.command(CMD.REG_EVENT, flags).catch(() => {});
    await this.command(CMD.CANCELCAPTURE).catch(() => {});
    const start = await this.command(CMD.STARTENROLL, Buffer.concat([id24, Buffer.from([finger, 1])]));
    if (start.code !== CMD.ACK_OK) throw new ZkError('El lector no pudo iniciar el registro de huella.', 'ENROLL_START');

    const deadline = Date.now() + waitMs;
    let outcome = 'TIMEOUT';
    let touches = 0;
    let lastTouchAt = 0;
    const touch = () => { touches += 1; lastTouchAt = Date.now(); onProgress?.(touches); };
    const handle = (frame) => {
      // En los avisos del lector el campo de sesión trae el tipo de evento, y el dato puede venir en 1 o 2 bytes
      // (la calidad de cada toque llega como un solo byte, 0x64).
      const kind = frame.sessionId;
      const result = Buffer.concat([frame.data, Buffer.alloc(2)]).readUInt16LE(0);
      if (kind === EVENT.ENROLL_FINGER) {
        outcome = result === 0 ? 'DONE' : (result === 5 ? 'DUPLICATE' : 'CANCELLED');
      } else if (kind === EVENT.FINGER_SCORE) {
        if (result === 0x64) touch();
      } else if (!OTHER_EVENTS.has(kind)) {
        // Firmware que no indica el tipo de evento: se interpreta por el valor.
        if (result === 0x64) touch();
        else if (result === 5) outcome = 'DUPLICATE';
        else if (result === 4 || result === 6) outcome = 'CANCELLED';
        else if (result === 0 && touches >= 3 && frame.data.length >= 2) outcome = 'DONE';
      }
    };
    // Mientras el lector captura el dedo no se le envían comandos: solo se escuchan sus avisos.
    while (Date.now() < deadline && outcome === 'TIMEOUT') {
      // Si ya hubo tres toques y el lector no manda el aviso final, se sale a comprobar el resultado.
      if (touches >= 3 && Date.now() - lastTouchAt > 5000) break;
      try {
        const frame = await this.nextFrame(Math.min(1000, Math.max(250, deadline - Date.now())));
        if (frame.code === CMD.REG_EVENT) { this.ackEvent(); handle(frame); }
      } catch (error) {
        if (error.code !== 'TIMEOUT') throw error;
      }
    }
    flags.writeUInt32LE(0, 0);
    const quick = { timeoutMs: 3000 };
    await this.command(CMD.REG_EVENT, flags, quick).catch(() => {});
    await this.command(CMD.CANCELCAPTURE, Buffer.alloc(0), quick).catch(() => {});
    await this.command(CMD.STARTVERIFY, Buffer.alloc(0), quick).catch(() => {});
    await this.command(CMD.REFRESHDATA, Buffer.alloc(0), quick).catch(() => {});
    const after = await this.sizes().then((sizes) => sizes.fingers).catch(() => null);
    const enrolled = outcome === 'DONE' || (after != null && after > before);
    return { enrolled, outcome: enrolled ? 'DONE' : outcome, touches };
  }
}
