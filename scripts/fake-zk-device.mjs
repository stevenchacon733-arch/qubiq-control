// Simulador de terminal ZKTeco (protocolo TCP 4370) para las pruebas automáticas.
// No sustituye la prueba física: reproduce el protocolo documentado, no un firmware real.
import net from 'node:net';
import { CMD, checksum, encodeTime, makeCommKey } from '../src/services/biometric/zkProtocol.js';

const MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const SESSION = 0x1a2b;

export class FakeZkDevice {
  constructor({ commKey = 0, userPacketSize = 72, inlineSmall = false } = {}) {
    this.commKey = commKey;
    this.userPacketSize = userPacketSize;
    this.inlineSmall = inlineSmall;
    this.users = [];
    this.records = [];
    this.fingers = 0;
    this.silent = false;
    this.enrollWorks = true;
    this.clock = () => new Date();
    this.clockParts = null;
    this.sockets = new Set();
    this.commandsSeen = [];
    this.server = null;
    this.port = 0;
  }

  start(port = this.port) {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.#accept(socket));
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  punch(userId, time, { status = 1, punch = 0 } = {}) {
    this.records.push({ userId: String(userId), time, status, punch });
  }

  #accept(socket) {
    this.sockets.add(socket);
    const ctx = { authed: false, buffer: null, pending: Buffer.alloc(0) };
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', (chunk) => {
      ctx.pending = Buffer.concat([ctx.pending, chunk]);
      while (ctx.pending.length >= 8) {
        const length = ctx.pending.readUInt32LE(4);
        if (ctx.pending.length < 8 + length) break;
        const payload = ctx.pending.subarray(8, 8 + length);
        ctx.pending = ctx.pending.subarray(8 + length);
        if (!this.silent) this.#handle(socket, ctx, payload);
      }
    });
  }

  #send(socket, code, replyId, data = Buffer.alloc(0), sessionField = SESSION) {
    const body = Buffer.alloc(8 + data.length);
    body.writeUInt16LE(code, 0);
    body.writeUInt16LE(sessionField, 4);
    body.writeUInt16LE(replyId, 6);
    data.copy(body, 8);
    body.writeUInt16LE(checksum(body), 2);
    const top = Buffer.alloc(8);
    MAGIC.copy(top, 0);
    top.writeUInt32LE(body.length, 4);
    if (!socket.destroyed) socket.write(Buffer.concat([top, body]));
  }

  #userBytes() {
    const size = this.userPacketSize;
    const rows = this.users.map((user) => {
      const row = Buffer.alloc(size);
      row.writeUInt16LE(user.uid, 0);
      if (size === 28) {
        Buffer.from(user.name).subarray(0, 8).copy(row, 8);
        row.writeUInt32LE(Number(user.userId) >>> 0, 24);
      } else {
        Buffer.from(user.name).subarray(0, 23).copy(row, 11);
        Buffer.from(user.userId).subarray(0, 23).copy(row, 48);
      }
      return row;
    });
    return Buffer.concat(rows);
  }

  #recordBytes() {
    return Buffer.concat(this.records.map((record, index) => {
      const row = Buffer.alloc(40);
      row.writeUInt16LE(index + 1, 0);
      Buffer.from(record.userId).subarray(0, 23).copy(row, 2);
      row[26] = record.status;
      row.writeUInt32LE(record.raw ?? encodeTime(record.time), 27);
      row[31] = record.punch;
      return row;
    }));
  }

  #handle(socket, ctx, payload) {
    const code = payload.readUInt16LE(0);
    const replyId = payload.readUInt16LE(6);
    const data = payload.subarray(8);
    this.commandsSeen.push(code);
    const ok = (extra) => this.#send(socket, CMD.ACK_OK, replyId, extra);

    if (code === CMD.CONNECT) {
      if (this.commKey) return this.#send(socket, CMD.ACK_UNAUTH, replyId);
      ctx.authed = true;
      return ok();
    }
    if (code === CMD.AUTH) {
      ctx.authed = data.equals(makeCommKey(this.commKey, SESSION));
      return this.#send(socket, ctx.authed ? CMD.ACK_OK : CMD.ACK_UNAUTH, replyId);
    }
    if (code === CMD.ACK_OK) return undefined; // acuse de un evento
    if (!ctx.authed) return this.#send(socket, CMD.ACK_UNAUTH, replyId);

    switch (code) {
      case CMD.EXIT: ok(); return socket.end();
      case CMD.GET_FREE_SIZES: {
        const sizes = Buffer.alloc(80);
        sizes.writeInt32LE(this.users.length, 16);
        sizes.writeInt32LE(this.fingers, 24);
        sizes.writeInt32LE(this.records.length, 32);
        sizes.writeInt32LE(3000, 56);
        sizes.writeInt32LE(1000, 60);
        sizes.writeInt32LE(100000, 64);
        return ok(sizes);
      }
      case CMD.OPTIONS_RRQ: {
        const key = data.toString('latin1').replace(/\0/g, '');
        const values = { '~SerialNumber': 'SIM0001', '~DeviceName': 'SimTerminal', '~Platform': 'ZEM-SIM', MAC: '00:17:61:00:00:01' };
        return ok(Buffer.from(`${key}=${values[key] ?? ''}\0`, 'latin1'));
      }
      case CMD.GET_VERSION: return ok(Buffer.from('Ver 6.60 Sim\0', 'latin1'));
      case CMD.GET_TIME: {
        const out = Buffer.alloc(4);
        out.writeUInt32LE(encodeTime(this.clockParts ? this.clockParts() : { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }), 0);
        return ok(out);
      }
      case CMD.PREPARE_BUFFER: {
        const target = data.readInt16LE(1);
        const content = target === CMD.ATTLOG_RRQ ? this.#recordBytes() : this.#userBytes();
        const header = Buffer.alloc(4);
        header.writeUInt32LE(content.length, 0);
        ctx.buffer = Buffer.concat([header, content]);
        if (this.inlineSmall && ctx.buffer.length <= 1024) return this.#send(socket, CMD.DATA, replyId, ctx.buffer);
        const info = Buffer.alloc(5);
        info.writeUInt32LE(ctx.buffer.length, 1);
        return ok(info);
      }
      case CMD.READ_BUFFER: {
        const start = data.readInt32LE(0);
        const size = data.readInt32LE(4);
        const slice = ctx.buffer.subarray(start, start + size);
        const announce = Buffer.alloc(4);
        announce.writeUInt32LE(slice.length, 0);
        this.#send(socket, CMD.PREPARE_DATA, replyId, announce);
        const half = Math.ceil(slice.length / 2);
        this.#send(socket, CMD.DATA, replyId, slice.subarray(0, half));
        if (slice.length > half) this.#send(socket, CMD.DATA, replyId, slice.subarray(half));
        return ok();
      }
      case CMD.FREE_DATA: ctx.buffer = null; return ok();
      case CMD.USER_WRQ: {
        const size = this.userPacketSize;
        const row = Buffer.alloc(size);
        data.copy(row, 0, 0, Math.min(size, data.length));
        const text = (from, to) => { const part = row.subarray(from, to); const end = part.indexOf(0); return part.subarray(0, end === -1 ? part.length : end).toString(); };
        const user = size === 28
          ? { uid: row.readUInt16LE(0), name: text(8, 16), userId: String(row.readUInt32LE(24)) }
          : { uid: row.readUInt16LE(0), name: text(11, 35), userId: text(48, 72) };
        this.users = this.users.filter((item) => item.uid !== user.uid).concat(user);
        return ok();
      }
      case CMD.DELETE_USER: {
        const uid = data.readUInt16LE(0);
        this.users = this.users.filter((item) => item.uid !== uid);
        return ok();
      }
      case CMD.STARTENROLL: {
        ok();
        if (!this.enrollWorks) return undefined;
        if (this.enrollStyle === 'legacy') {
          // Firmware que no indica el tipo de evento: el resultado va en 2 bytes y la sesión es la real.
          const event = (result, delay) => setTimeout(() => {
            const body = Buffer.alloc(8);
            body.writeUInt16LE(result, 0);
            this.#send(socket, CMD.REG_EVENT, 0, body);
          }, delay);
          event(0x64, 30); event(0x64, 60); event(0x64, 90);
          setTimeout(() => { this.fingers += 1; }, 100);
          if (!this.enrollSilentEnd) event(0, 120);
          return undefined;
        }
        // Como un terminal real: el tipo de evento viaja en el campo de sesión y la calidad es 1 byte.
        const emit = (kind, data, delay) => setTimeout(() => this.#send(socket, CMD.REG_EVENT, 0, data, kind), delay);
        for (const delay of [30, 60, 90]) {
          emit(2, Buffer.alloc(0), delay);
          emit(256, Buffer.from([0x64]), delay + 10);
        }
        setTimeout(() => { this.fingers += 1; }, 110);
        const done = Buffer.alloc(6);
        done.writeUInt16LE(this.enrollResult ?? 0, 0);
        emit(8, done, 130);
        return undefined;
      }
      case CMD.DEL_USER_TEMP:
        this.templatesDeleted = (this.templatesDeleted || 0) + 1;
        return ok();
      case CMD.REG_EVENT:
      case CMD.CANCELCAPTURE:
      case CMD.STARTVERIFY:
      case CMD.REFRESHDATA:
        return ok();
      default:
        return this.#send(socket, CMD.ACK_ERROR, replyId);
    }
  }
}
