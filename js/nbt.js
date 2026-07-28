// Uncompressed big-endian NBT reader/writer. No gzip here (see task 8).

export const TAG = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12,
};

export const tag = {
  byte: (n) => ({ type: TAG.BYTE, value: n }),
  short: (n) => ({ type: TAG.SHORT, value: n }),
  int: (n) => ({ type: TAG.INT, value: n }),
  long: (n) => ({ type: TAG.LONG, value: n }),
  float: (n) => ({ type: TAG.FLOAT, value: n }),
  double: (n) => ({ type: TAG.DOUBLE, value: n }),
  string: (s) => ({ type: TAG.STRING, value: s }),
  byteArray: (arr) => ({ type: TAG.BYTE_ARRAY, value: arr }),
  intArray: (arr) => ({ type: TAG.INT_ARRAY, value: arr }),
  longArray: (arr) => ({ type: TAG.LONG_ARRAY, value: arr }),
  list: (elemType, items) => ({ type: TAG.LIST, value: { elemType, items } }),
  compound: (obj) => ({ type: TAG.COMPOUND, value: obj }),
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class Reader {
  constructor(uint8) {
    this.view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    this.pos = 0;
  }

  u8() {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  i8() {
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  i16() {
    const v = this.view.getInt16(this.pos, false);
    this.pos += 2;
    return v;
  }

  u16() {
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  i32() {
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  i64() {
    const v = this.view.getBigInt64(this.pos, false);
    this.pos += 8;
    return v;
  }

  f32() {
    const v = this.view.getFloat32(this.pos, false);
    this.pos += 4;
    return v;
  }

  f64() {
    const v = this.view.getFloat64(this.pos, false);
    this.pos += 8;
    return v;
  }

  bytes(n) {
    const start = this.view.byteOffset + this.pos;
    const v = new Uint8Array(this.view.buffer, start, n);
    this.pos += n;
    return v;
  }

  string() {
    const len = this.u16();
    const start = this.view.byteOffset + this.pos;
    const slice = new Uint8Array(this.view.buffer, start, len);
    this.pos += len;
    return textDecoder.decode(slice);
  }

  payload(type) {
    switch (type) {
      case TAG.BYTE:
        return this.i8();
      case TAG.SHORT:
        return this.i16();
      case TAG.INT:
        return this.i32();
      case TAG.LONG:
        return this.i64();
      case TAG.FLOAT:
        return this.f32();
      case TAG.DOUBLE:
        return this.f64();
      case TAG.BYTE_ARRAY: {
        const len = this.i32();
        const arr = new Int8Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.i8();
        return arr;
      }
      case TAG.STRING:
        return this.string();
      case TAG.LIST: {
        const elemType = this.u8();
        const count = this.i32();
        const items = [];
        for (let i = 0; i < count; i++) {
          items.push({ type: elemType, value: this.payload(elemType) });
        }
        return { elemType, items };
      }
      case TAG.COMPOUND: {
        const obj = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG.END) break;
          const name = this.string();
          obj[name] = { type: t, value: this.payload(t) };
        }
        return obj;
      }
      case TAG.INT_ARRAY: {
        const len = this.i32();
        const arr = new Int32Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.i32();
        return arr;
      }
      case TAG.LONG_ARRAY: {
        const len = this.i32();
        const arr = new BigInt64Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.i64();
        return arr;
      }
      default:
        throw new Error(`Unknown NBT tag type: ${type}`);
    }
  }
}

export function readNbt(uint8) {
  const r = new Reader(uint8);
  const type = r.u8();
  const name = r.string();
  const value = r.payload(type);
  return { name, value: { type, value } };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(uint8) {
    this.chunks.push(uint8);
    this.length += uint8.byteLength;
  }

  u8(v) {
    this.push(Uint8Array.of(v & 0xff));
  }

  i8(v) {
    const b = new Uint8Array(1);
    new DataView(b.buffer).setInt8(0, v);
    this.push(b);
  }

  i16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, v, false);
    this.push(b);
  }

  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, false);
    this.push(b);
  }

  i32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, false);
    this.push(b);
  }

  i64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, false);
    this.push(b);
  }

  f32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, false);
    this.push(b);
  }

  f64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, false);
    this.push(b);
  }

  string(s) {
    const bytes = textEncoder.encode(s);
    this.u16(bytes.length);
    this.push(bytes);
  }

  payload(type, value) {
    switch (type) {
      case TAG.BYTE:
        return this.i8(value);
      case TAG.SHORT:
        return this.i16(value);
      case TAG.INT:
        return this.i32(value);
      case TAG.LONG:
        return this.i64(value);
      case TAG.FLOAT:
        return this.f32(value);
      case TAG.DOUBLE:
        return this.f64(value);
      case TAG.BYTE_ARRAY: {
        this.i32(value.length);
        for (let i = 0; i < value.length; i++) this.i8(value[i]);
        return;
      }
      case TAG.STRING:
        return this.string(value);
      case TAG.LIST: {
        const { elemType, items } = value;
        this.u8(elemType);
        this.i32(items.length);
        for (const item of items) this.payload(elemType, item.value);
        return;
      }
      case TAG.COMPOUND: {
        for (const [name, child] of Object.entries(value)) {
          this.u8(child.type);
          this.string(name);
          this.payload(child.type, child.value);
        }
        this.u8(TAG.END);
        return;
      }
      case TAG.INT_ARRAY: {
        this.i32(value.length);
        for (let i = 0; i < value.length; i++) this.i32(value[i]);
        return;
      }
      case TAG.LONG_ARRAY: {
        this.i32(value.length);
        for (let i = 0; i < value.length; i++) this.i64(value[i]);
        return;
      }
      default:
        throw new Error(`Unknown NBT tag type: ${type}`);
    }
  }

  toUint8Array() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

export function writeNbt(name, value) {
  const w = new Writer();
  w.u8(value.type);
  w.string(name);
  w.payload(value.type, value.value);
  return w.toUint8Array();
}
