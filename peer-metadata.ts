import { parseMagnet } from './parse-magnet.ts';
import { getUdpTrackers } from './udp-tracker.ts';
import { getHttpTrackers } from './http-tracker.ts';
import { parseTrackerPeers } from './parse-tracker-peers.ts';
import { bdecode } from './bdecode.ts';

// Minimal connection shape we use, to avoid depending on Deno types in annotations
type ConnLike = {
    read(p: Uint8Array): Promise<number | null>;
    write(p: Uint8Array): Promise<number>;
    close(): void;
};

function hexToBytes(hex: string): Uint8Array {
    if (hex.length !== 40) throw new Error("Invalid hex info_hash");
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function bencodeDict(obj: Record<string, any>): Uint8Array {
    const encoder = new TextEncoder();
    let result = "d";

    for (const [key, value] of Object.entries(obj)) {
        result += `${key.length}:${key}`;

        if (typeof value === "number") {
            result += `i${value}e`;
        } else if (typeof value === "string") {
            result += `${value.length}:${value}`;
        } else if (typeof value === "object" && value !== null) {
            result += new TextDecoder().decode(bencodeDict(value));
        }
    }

    result += "e";
    return encoder.encode(result);
}

async function sendExtendedHandshake(conn: ConnLike) {
    const handshakeDict = {
        m: {
            ut_metadata: 1,
        },
    };

    const payload = bencodeDict(handshakeDict);

    const buffer = new Uint8Array(4 + 1 + 1 + payload.length);
    const view = new DataView(buffer.buffer);

    view.setUint32(0, 2 + payload.length); // message length (1 + 1 + payload)
    buffer[4] = 20; // message ID for extension protocol
    buffer[5] = 0;  // extended message ID 0 = handshake
    buffer.set(payload, 6);

    await conn.write(buffer);
}


async function tryConnect(infoHash: string, peerId: string, peer: { ip: string, port: number }, timeoutMs = 2000): Promise<Uint8Array | null> {
    const peerIdBytes = new TextEncoder().encode(peerId);
    const infoHashBytes = hexToBytes(infoHash);
    const connPromise = (globalThis as any).Deno.connect({ hostname: peer.ip, port: peer.port });

    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out")), timeoutMs)
    );

    try {
        const conn = await Promise.race([connPromise as Promise<ConnLike>, timeout]) as ConnLike;
        // console.log("✅ Connected to", peer.ip, peer.port);
        await conn.write(createHandshake(infoHashBytes, peerIdBytes));
        // Read full 68-byte handshake (may arrive fragmented)
        const response = await readExactly(conn, 68, timeoutMs);
        // console.log("Received handshake response from", peer.ip, peer.port, response);

        const receivedInfoHash = response.slice(28, 48);
        if (receivedInfoHash.every((b, i) => b === infoHashBytes[i])) {
            // console.log("✅ Handshake successful with", peer.ip, peer.port);
            await sendExtendedHandshake(conn);
            // Consume messages until we find extended handshake (id=20, ext id=0)
            const extHandshake = await readUntilExtendedHandshake(conn, timeoutMs);
            if (extHandshake) {
                // console.log("Decoded extended handshake:", extHandshake);
                // Try to fetch metadata via BEP-9 if supported
                const m = (extHandshake as any).m as Record<string, unknown> | undefined;
                const utMeta = typeof m?.["ut_metadata"] === 'number' ? (m!["ut_metadata"] as number) : null;
                const metadataSize = typeof (extHandshake as any).metadata_size === 'number' ? (extHandshake as any).metadata_size as number : null;
                // console.log("Metadata size:", metadataSize, "UT Metadata ID:", utMeta);
                // Some peers require 'interested' before serving metadata
                try { await sendInterested(conn); } catch { }
                if (utMeta && metadataSize && metadataSize > 0 && metadataSize < 8 * 1024 * 1024) {
                    try {
                        const meta = await fetchMetadataFromPeer(conn, utMeta, metadataSize, timeoutMs);
                        if (meta) return meta;
                    } catch (e) {
                        // ignore per-peer metadata errors
                    }
                }
            }

        }
        conn.close();
    } catch (err) {
        // swallow per-peer errors in race
    }
    return null;
}

function createHandshake(infoHash: Uint8Array, peerId: Uint8Array): Uint8Array {
    const buffer = new Uint8Array(68);
    buffer[0] = 19;
    buffer.set(new TextEncoder().encode("BitTorrent protocol"), 1);
    // reserved bytes: set BEP-10 (Extension Protocol) bit
    const reserved = new Uint8Array(8);
    // Extended Messaging (BEP-10) is bit 0x10 in byte index 5
    reserved[5] |= 0x10;
    buffer.set(reserved, 20);
    buffer.set(infoHash, 28);
    buffer.set(peerId, 48);
    return buffer;
}

const peerId = '-DN0001-' + crypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + String.fromCharCode(65 + (b % 26)), '');

export async function getTorrentMetadata(magnet: string, options: { skipHttp?: boolean; skipUdp?: boolean; skipDht?: boolean; } = {
    skipHttp: true,
    skipUdp: false,
    skipDht: true
}): Promise<Uint8Array | null> {

    const parsed = parseMagnet(magnet);
    const peers = new Set<{ ip: string; port: number }>();

    if (!options.skipUdp) {
        const udpTrackers = await getUdpTrackers(peerId, parsed);
        udpTrackers?.forEach(p => peers.add(p));
    }

    console.log(`Found ${peers.size} peers from UDP trackers`);

    if (!options.skipHttp) {
        const httpTrackers = await getHttpTrackers(peerId, parsed);
        httpTrackers?.forEach(p => peers.add(p));
    }
    
    console.log(`Found ${peers.size} peers from HTTP trackers`);

    // for (const peer of peers) {
    //     await tryConnect(parsed.info, peerId, peer);
    // }
    const peerList = [...peers];
    const CONCURRENCY = 10; // tune as needed
    if (peerList.length === 0) return null;

    // Resolve on first successful metadata; ignore others
    return await firstSuccess(peerList, CONCURRENCY, (peer) => tryConnect(parsed.info, peerId, peer, 4000));
}

async function firstSuccess<TInput, TOut>(items: TInput[], concurrency: number, worker: (item: TInput) => Promise<TOut | null>): Promise<TOut | null> {
    return new Promise<TOut | null>((resolve) => {
        let idx = 0;
        let resolved = false;
        let running = 0;

        const launch = () => {
            while (running < concurrency && idx < items.length && !resolved) {
                const current = items[idx++];
                running++;
                worker(current)
                    .then((res) => {
                        if (!resolved && res) {
                            resolved = true;
                            resolve(res);
                        }
                    })
                    .catch(() => {})
                    .finally(() => {
                        running--;
                        if (!resolved) {
                            if (idx < items.length) launch();
                            else if (running === 0) resolve(null);
                        }
                    });
            }
        };
        launch();
    });
}

// ---- Helpers for framed reads and message parsing ----

function withTimeout<T>(p: Promise<T>, ms: number, label = "op"): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then(
            v => { clearTimeout(id); resolve(v); },
            e => { clearTimeout(id); reject(e); }
        );
    });
}

async function readExactly(conn: ConnLike, n: number, timeoutMs: number): Promise<Uint8Array> {
    const buf = new Uint8Array(n);
    let off = 0;
    while (off < n) {
        const toRead = buf.subarray(off);
        const readN: number = await withTimeout<number>(conn.read(toRead).then((v: number | null) => v ?? 0), timeoutMs, `read(${n - off})`);
        if (readN === 0) throw new Error("EOF while reading");
        off += readN;
    }
    return buf;
}

type BtMessage = { id: number; payload: Uint8Array };

async function readBtMessage(conn: ConnLike, timeoutMs: number): Promise<BtMessage | null> {
    // 4-byte length prefix (big-endian)
    const lenBuf = await readExactly(conn, 4, timeoutMs);
    const view = new DataView(lenBuf.buffer, lenBuf.byteOffset, lenBuf.byteLength);
    const length = view.getUint32(0);
    if (length === 0) return { id: -1, payload: new Uint8Array(0) }; // keep-alive
    const body = await readExactly(conn, length, timeoutMs);
    const id = body[0];
    return { id, payload: body.subarray(1) };
}

async function readUntilExtendedHandshake(conn: ConnLike, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs * 2; // allow a couple of messages within ~2x timeout
    while (Date.now() < deadline) {
        const { id, payload } = await readBtMessage(conn, timeoutMs) as BtMessage;
        if (id === -1) continue; // keep-alive
        if (id === 5) {
            // bitfield — fine, ignore
            continue;
        }
        if (id === 20) {
            // extended message: first byte is extended message ID
            if (payload.length === 0) continue;
            const extId = payload[0];
            const extPayload = payload.subarray(1);
            if (extId === 0) {
                // extended handshake payload is bencoded dict
                try {
                    const decoded = bdecode(extPayload) as Record<string, unknown>;
                    return decoded;
                } catch (_e) {
                    // ignore malformed and continue
                }
            }
        }
        // Other messages (unchoke=1, interested=2, have=4, etc.) can be ignored here
    }
    return null;
}

// ---- BEP-9 metadata exchange ----

const META_PIECE_LEN = 16 * 1024; // 16KiB

function bencode(obj: Record<string, number>): Uint8Array {
    // Minimal bencode for dict of numbers
    const parts: string[] = ["d"];
    for (const k of Object.keys(obj)) {
        const key = `${k.length}:${k}`;
        const val = `i${obj[k]}e`;
        parts.push(key, val);
    }
    parts.push("e");
    return new TextEncoder().encode(parts.join(""));
}

function buildExtendedMessage(extId: number, payload: Uint8Array): Uint8Array {
    const length = 2 + payload.length; // id(20) + extId + payload
    const out = new Uint8Array(4 + length);
    const view = new DataView(out.buffer);
    view.setUint32(0, length);
    out[4] = 20; // extended message id
    out[5] = extId;
    out.set(payload, 6);
    return out;
}

async function sendInterested(conn: ConnLike): Promise<void> {
    // length=1, id=2
    const buf = new Uint8Array(5);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 1);
    buf[4] = 2;
    await conn.write(buf);
}

type DecodedWithPos<T> = { value: T; consumed: number };

function bdecodePrefix(buf: Uint8Array, start = 0): DecodedWithPos<any> {
    let pos = start;
    const td = new TextDecoder();
    function readByte(): number { return buf[pos++]; }
    function peekByte(): number { return buf[pos]; }
    function readInt(): number {
        pos++; // 'i'
        const s = pos; while (buf[pos] !== 0x65) pos++; // 'e'
        const numStr = td.decode(buf.subarray(s, pos)); pos++; return parseInt(numStr, 10);
    }
    function readString(): Uint8Array {
        const colon = buf.indexOf(0x3A, pos);
        const len = parseInt(td.decode(buf.subarray(pos, colon)));
        pos = colon + 1; const out = buf.subarray(pos, pos + len); pos += len; return out;
    }
    function readList(): any[] { pos++; const arr: any[] = []; while (buf[pos] !== 0x65) arr.push(readAny()); pos++; return arr; }
    function readDict(): Record<string, any> { pos++; const obj: Record<string, any> = {}; while (buf[pos] !== 0x65) { const k = td.decode(readString()); obj[k] = readAny(); } pos++; return obj; }
    function readAny(): any { const b = peekByte(); if (b === 0x64) return readDict(); if (b === 0x6C) return readList(); if (b === 0x69) return readInt(); if (b >= 0x30 && b <= 0x39) return readString(); throw new Error("bad bencode"); }
    const value = readAny();
    return { value, consumed: pos - start };
}

async function fetchMetadataFromPeer(conn: ConnLike, utMetadataId: number, metadataSize: number, timeoutMs: number): Promise<Uint8Array | null> {
    const pieceCount = Math.ceil(metadataSize / META_PIECE_LEN);
    const buffer = new Uint8Array(metadataSize);
    const received = new Array<boolean>(pieceCount).fill(false);

    // You can limit outstanding requests if needed; here we request all
    for (let i = 0; i < pieceCount; i++) {
        const reqDict = bencode({ msg_type: 0, piece: i });
        const msg = buildExtendedMessage(utMetadataId, reqDict);
        await conn.write(msg);
    }

    const deadline = Date.now() + Math.max(timeoutMs * 3, 6000);
    while (Date.now() < deadline) {
        const m = await readBtMessage(conn, timeoutMs);
        if (!m) continue;
        if (m.id !== 20) continue; // only interested in extended messages
        const payload = m.payload;
        if (payload.length === 0) continue;
        const extId = payload[0];
        // Some peers may respond with an unexpected extId; rely on header parsing below.
        const rest = payload.subarray(1);
        // header is bencoded dict, followed by piece data for msg_type=1
        let header: any;
        let consumed = 0;
        try {
            const dec = bdecodePrefix(rest, 0);
            header = dec.value;
            consumed = dec.consumed;
        } catch { continue; }
        const msgType = typeof header?.msg_type === 'number' ? header.msg_type as number : NaN;
        const pieceIndex = typeof header?.piece === 'number' ? header.piece as number : NaN;
        if (msgType !== 1 /* data */ || Number.isNaN(pieceIndex) || pieceIndex < 0 || pieceIndex >= pieceCount) {
            continue;
        }
        const pieceData = rest.subarray(consumed);
        const offset = pieceIndex * META_PIECE_LEN;
        const expected = Math.min(META_PIECE_LEN, metadataSize - offset);
        if (pieceData.length < expected) {
            // some peers send exactly expected; if shorter, skip
            continue;
        }
        buffer.set(pieceData.subarray(0, expected), offset);
        received[pieceIndex] = true;
        if (received.every(Boolean)) {
            return buffer;
        }
    }
    return null;
}