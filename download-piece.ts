import { readExactly } from './peer-metadata.ts';

// Assumes: you already did the standard handshake and verified info_hash

const BE = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};
const readU32 = (b: Uint8Array, off = 0) => new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0);

async function writeMsg(conn: any, id: number, payload = new Uint8Array(0)) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, 1 + payload.length);
  const msg = new Uint8Array(4 + 1 + payload.length);
  msg.set(len, 0);
  msg[4] = id;
  msg.set(payload, 5);
  await conn.write(msg);
}

async function readMsg(conn: any, timeoutMs: number): Promise<{ id: number | null; payload: Uint8Array }> {
  const lenBuf = await readExactly(conn, 4, timeoutMs);
  const length = readU32(lenBuf, 0);
  if (length === 0) return { id: null, payload: new Uint8Array(0) }; // keep-alive
  const id = (await readExactly(conn, 1, timeoutMs))[0];
  const payload = await readExactly(conn, length - 1, timeoutMs);
  return { id, payload };
}

export async function sendInterested(conn: any) {
  await writeMsg(conn, 2);
}

export async function waitForUnchoke(conn: any, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { id } = await readMsg(conn, Math.max(1, deadline - Date.now()));
    if (id === 1) return true;          // unchoke
    if (id === 0) return false;         // choke (explicit), keep waiting or bail
    // ignore other messages here
  }
  return false;
}

function pieceSizeFor(index: number, pieceLength: number, totalSize: number): number {
  const numPieces = Math.ceil(totalSize / pieceLength);
  if (index < 0 || index >= numPieces) throw new Error("piece index out of range");
  const lastSize = totalSize - (numPieces - 1) * pieceLength;
  return index === numPieces - 1 ? lastSize : pieceLength;
}

export async function downloadPiece(
  conn: any,
  index: number,
  pieceLength: number,
  totalSize: number,
  opts?: { blockSize?: number; pipeline?: number; timeoutMs?: number }
): Promise<Uint8Array> {
  const blockSize = opts?.blockSize ?? 16 * 1024;
  const pipeline = opts?.pipeline ?? 8;
  const timeoutMs = opts?.timeoutMs ?? 15000;

  const size = pieceSizeFor(index, pieceLength, totalSize);
  const buf = new Uint8Array(size);
  const pending = new Map<number, number>(); // begin -> length
  const received = new Set<number>();
  let nextBegin = 0;
  let bytesReceived = 0;
  let choked = false;

  // Let peer know we're interested
  await sendInterested(conn);
  // Wait for unchoke (or continue if already unchoked and peer sends data)
  // Not strictly required to block here, but helpful:
  await waitForUnchoke(conn, timeoutMs).catch(() => { /* ignore */ });

  const sendRequest = async (begin: number, len: number) => {
    const payload = new Uint8Array(12);
    payload.set(BE(index), 0);
    payload.set(BE(begin), 4);
    payload.set(BE(len), 8);
    await writeMsg(conn, 6, payload);
    pending.set(begin, len);
  };

  // Prime the pipeline
  const enqueueUntilFull = async () => {
    while (!choked && pending.size < pipeline && nextBegin < size) {
      const len = Math.min(blockSize, size - nextBegin);
      await sendRequest(nextBegin, len);
      nextBegin += len;
    }
  };
  await enqueueUntilFull();

  const deadline = () => Date.now() + timeoutMs;
  let until = deadline();

  while (bytesReceived < size) {
    const { id, payload } = await readMsg(conn, Math.max(1, until - Date.now()));
    if (id === null) { // keep-alive
      if (Date.now() >= until) until = deadline();
      continue;
    }

    if (id === 0) { // choke
      choked = true;
      continue;
    }
    if (id === 1) { // unchoke
      choked = false;
      await enqueueUntilFull();
      continue;
    }
    if (id === 7) { // piece
      if (payload.length < 8) continue;
      const pIndex = readU32(payload, 0);
      const begin = readU32(payload, 4);
      if (pIndex !== index) continue;
      const block = payload.slice(8);
      // place block if expected
      const expectLen = pending.get(begin);
      if (expectLen != null && block.length === expectLen && begin + block.length <= size) {
        buf.set(block, begin);
        pending.delete(begin);
        received.add(begin);
        bytesReceived += block.length;
        // Refill pipeline
        await enqueueUntilFull();
        // Refresh timeout
        until = deadline();
      }
      continue;
    }
    if (id === 0x10) {
      // reject_request (BEP 6 Fast Extension) - treat as if the request wasn't sent
      if (payload.length >= 12) {
        const b = readU32(payload, 4);
        pending.delete(b);
        await enqueueUntilFull();
      }
      continue;
    }
    // ignore other message types here (have, bitfield, extended, etc.)
    if (Date.now() >= until) until = deadline();
  }

  return buf;
}