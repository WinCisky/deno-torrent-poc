import { bdecode } from "./bdecode.ts";
import { downloadPiece } from "./download-piece.ts";
import { parseMagnet } from "./parse-magnet.ts";
import {
  ConnLike,
  createHandshake,
  getPeersFromParsedMagnet,
  readExactly,
} from "./peer-metadata.ts";

type ParsedMagnet = ReturnType<typeof parseMagnet>;

type TorrentFile = {
  path: string;
  length: number;
  offset: number;
};

export type TorrentFilePlan = {
  path: string;
  filename: string;
  length: number;
  startOffset: number;
  endOffset: number;
  pieceLength: number;
  totalSize: number;
  firstPiece: number;
  lastPiece: number;
  pieces: Uint8Array;
};

export class TorrentDownloadError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

const DEFAULT_TRACKER_OPTIONS = {
  skipHttp: true,
  skipUdp: false,
  skipDht: true,
};

const peerId = "-DN0001-" +
  crypto.getRandomValues(new Uint8Array(12)).reduce(
    (s, b) => s + String.fromCharCode(65 + (b % 26)),
    "",
  );

export function createTorrentFilePlan(
  metadata: Uint8Array,
  targetPath: string,
): TorrentFilePlan {
  const info = bdecode(metadata) as Record<string, unknown>;
  const pieceLength = readNumber(info["piece length"], "piece length");
  const pieces = readBytes(info["pieces"], "pieces");
  const files = listFiles(info);
  const normalizedTarget = normalizeTorrentPath(targetPath);
  const file = files.find((entry) => entry.path === normalizedTarget);

  if (!file) {
    throw new TorrentDownloadError("File not found in torrent metadata", 404);
  }

  if (file.length <= 0) {
    throw new TorrentDownloadError("Cannot download an empty file", 400);
  }

  const totalSize = files.reduce((sum, entry) => sum + entry.length, 0);
  const endOffset = file.offset + file.length;
  const firstPiece = Math.floor(file.offset / pieceLength);
  const lastPiece = Math.floor((endOffset - 1) / pieceLength);
  const expectedPieces = Math.ceil(totalSize / pieceLength);

  if (pieces.length < expectedPieces * 20) {
    throw new TorrentDownloadError(
      "Torrent metadata has invalid piece hashes",
      500,
    );
  }

  return {
    path: file.path,
    filename: file.path.split("/").at(-1) || "download",
    length: file.length,
    startOffset: file.offset,
    endOffset,
    pieceLength,
    totalSize,
    firstPiece,
    lastPiece,
    pieces,
  };
}

export async function createTorrentDownloadStream(
  parsed: ParsedMagnet,
  plan: TorrentFilePlan,
): Promise<ReadableStream<Uint8Array>> {
  const peers = await getPeersFromParsedMagnet(parsed, DEFAULT_TRACKER_OPTIONS);
  if (!peers || peers.length === 0) {
    throw new TorrentDownloadError("No peers found from trackers", 504);
  }

  const orderedPeers = shuffle(peers);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (
          let pieceIndex = plan.firstPiece;
          pieceIndex <= plan.lastPiece;
          pieceIndex++
        ) {
          const piece = await downloadVerifiedPiece(
            parsed,
            orderedPeers,
            plan,
            pieceIndex,
          );
          const pieceStart = pieceIndex * plan.pieceLength;
          const from = Math.max(plan.startOffset - pieceStart, 0);
          const to = Math.min(plan.endOffset - pieceStart, piece.length);
          controller.enqueue(piece.subarray(from, to));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export function contentDispositionFilename(filename: string): string {
  const fallback = filename.replace(/[^\w.!#$&+^`{}~-]+/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function downloadVerifiedPiece(
  parsed: ParsedMagnet,
  peers: { ip: string; port: number }[],
  plan: TorrentFilePlan,
  pieceIndex: number,
): Promise<Uint8Array> {
  const maxAttempts = Math.min(peers.length, 20);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const peer = peers[(pieceIndex + attempt) % peers.length];
    try {
      const piece = await downloadPieceFromPeer(parsed, peer, plan, pieceIndex);
      if (await verifyPiece(piece, expectedHash(plan, pieceIndex))) {
        return piece;
      }
      lastError = new Error("Piece hash mismatch");
    } catch (error) {
      lastError = error;
    }
  }

  throw new TorrentDownloadError(
    `Failed to download piece ${pieceIndex}: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
    504,
  );
}

async function downloadPieceFromPeer(
  parsed: ParsedMagnet,
  peer: { ip: string; port: number },
  plan: TorrentFilePlan,
  pieceIndex: number,
  timeoutMs = 6000,
): Promise<Uint8Array> {
  const peerIdBytes = new TextEncoder().encode(peerId);
  const conn = await connectWithTimeout(peer, timeoutMs);

  try {
    await conn.write(createHandshake(parsed.infohash, peerIdBytes));
    const response = await readExactly(conn, 68, timeoutMs);
    const receivedInfoHash = response.slice(28, 48);
    if (!receivedInfoHash.every((b, i) => b === parsed.infohash[i])) {
      throw new Error("Peer returned a different info hash");
    }

    const numPieces = Math.ceil(plan.totalSize / plan.pieceLength);
    const availability = await waitForPeerAvailability(
      conn,
      numPieces,
      timeoutMs,
    );
    if (
      availability.source !== "unknown" &&
      availability.source !== "partial" &&
      !availability.have[pieceIndex]
    ) {
      throw new Error("Peer does not have the requested piece");
    }

    return await downloadPiece(
      conn,
      pieceIndex,
      plan.pieceLength,
      plan.totalSize,
      {
        blockSize: 16 * 1024,
        pipeline: 8,
        timeoutMs: 15000,
      },
    );
  } finally {
    try {
      conn.close();
    } catch {
      // ignore close failures
    }
  }
}

async function connectWithTimeout(
  peer: { ip: string; port: number },
  timeoutMs: number,
): Promise<ConnLike> {
  const connPromise = Deno.connect({ hostname: peer.ip, port: peer.port });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Connection timed out")), timeoutMs)
  );
  return await Promise.race([connPromise, timeout]);
}

function readUInt32BE(bytes: Uint8Array, offset = 0): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return dv.getUint32(0);
}

async function readMessage(
  conn: ConnLike,
  timeoutMs: number,
): Promise<{ id: number | null; payload: Uint8Array }> {
  const lenBuf = await readExactly(conn, 4, timeoutMs);
  const length = readUInt32BE(lenBuf, 0);
  if (length === 0) return { id: null, payload: new Uint8Array(0) };
  const id = (await readExactly(conn, 1, timeoutMs))[0];
  const payload = await readExactly(conn, length - 1, timeoutMs);
  return { id, payload };
}

function parseBitfield(payload: Uint8Array, numPieces: number): boolean[] {
  const have = new Array<boolean>(numPieces).fill(false);
  for (let i = 0; i < numPieces; i++) {
    const byteIndex = (i / 8) | 0;
    const bitIndex = 7 - (i % 8);
    if (byteIndex < payload.length) {
      have[i] = ((payload[byteIndex] >> bitIndex) & 1) === 1;
    }
  }
  return have;
}

async function waitForPeerAvailability(
  conn: ConnLike,
  numPieces: number,
  timeoutMs: number,
): Promise<
  {
    have: boolean[];
    source: "bitfield" | "have_all" | "have_none" | "partial" | "unknown";
  }
> {
  const have = new Array<boolean>(numPieces).fill(false);
  const deadline = Date.now() + timeoutMs;
  let sawAnyHave = false;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let message: { id: number | null; payload: Uint8Array };
    try {
      message = await readMessage(conn, remaining);
    } catch {
      break;
    }
    const { id, payload } = message;

    if (id === null) continue;

    switch (id) {
      case 5:
        return { have: parseBitfield(payload, numPieces), source: "bitfield" };
      case 4:
        if (payload.length >= 4) {
          const idx = readUInt32BE(payload, 0);
          if (idx < numPieces) {
            have[idx] = true;
            sawAnyHave = true;
          }
        }
        break;
      case 0x0E:
        have.fill(true);
        return { have, source: "have_all" };
      case 0x0F:
        return { have, source: "have_none" };
      default:
        break;
    }
  }

  return { have, source: sawAnyHave ? "partial" : "unknown" };
}

function listFiles(info: Record<string, unknown>): TorrentFile[] {
  const td = new TextDecoder();
  const files = info["files"];
  let offset = 0;

  if (Array.isArray(files)) {
    return files.map((file) => {
      if (!isRecord(file)) {
        throw new TorrentDownloadError("Invalid torrent file entry", 500);
      }
      const length = readNumber(file["length"], "file length");
      const pathParts = readPath(file["path"], td);
      const entry = {
        path: normalizeTorrentPath(pathParts.join("/")),
        length,
        offset,
      };
      offset += length;
      return entry;
    });
  }

  const name = readOptionalBytes(info["name"]);
  const length = readNumber(info["length"], "length");
  return [{
    path: normalizeTorrentPath(name ? td.decode(name) : "download"),
    length,
    offset: 0,
  }];
}

function readPath(value: unknown, td: TextDecoder): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TorrentDownloadError("Invalid torrent file path", 500);
  }
  return value.map((part) => td.decode(readBytes(part, "path part")));
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TorrentDownloadError(`Invalid torrent ${label}`, 500);
  }
  return value;
}

function readBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TorrentDownloadError(`Invalid torrent ${label}`, 500);
  }
  return value;
}

function readOptionalBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function normalizeTorrentPath(path: string): string {
  return path.split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== ".")
    .join("/");
}

function expectedHash(plan: TorrentFilePlan, pieceIndex: number): Uint8Array {
  const start = pieceIndex * 20;
  return plan.pieces.subarray(start, start + 20);
}

async function verifyPiece(
  piece: Uint8Array,
  expected: Uint8Array,
): Promise<boolean> {
  const input = new ArrayBuffer(piece.byteLength);
  new Uint8Array(input).set(piece);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  return digest.every((byte, index) => byte === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
