import { bdecode } from './bdecode.ts';
import { downloadPiece } from './download-piece.ts';
import { parseMagnet } from './parse-magnet.ts';
import { getPeersFromParsedMagnet, firstSuccess, createHandshake, readExactly, ConnLike, hexToBytes } from './peer-metadata.ts';

const peerId = '-DN0001-' + crypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + String.fromCharCode(65 + (b % 26)), '');

async function fetchPeerPieces(
    parsed: ReturnType<typeof parseMagnet>,
    plans: { index: number; begin: number; length: number; sha1: Uint8Array }[],
    pieceLength: number,
    totalOffset: number,
    options: { skipHttp: boolean; skipUdp: boolean; skipDht: boolean }
): Promise<Uint8Array | null> {

    // get list of peers
    const peers = await getPeersFromParsedMagnet(parsed, options);
    if (!peers || peers.length === 0) {
        console.log("No peers found");
        return null;
    }

    const CONCURRENCY = 10; // tune as needed

    // TODO: implement fetching pieces from multiple peers concurrently using cooperation
    return await firstSuccess(peers, CONCURRENCY, (peer) => tryConnect(parsed, plans, peerId, peer, pieceLength, totalOffset, 4000));
}


async function tryConnect(parsed: ReturnType<typeof parseMagnet>, plans: { index: number; begin: number; length: number; sha1: Uint8Array }[], peerId: string, peer: { ip: string, port: number }, pieceLength: number, totalOffset: number, timeoutMs = 2000): Promise<Uint8Array | null> {
    const peerIdBytes = new TextEncoder().encode(peerId);
    const infoHashBytes = hexToBytes(parsed.info);
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
        if (!receivedInfoHash.every((b, i) => b === infoHashBytes[i])) return null;

        const numPieces = Math.ceil(totalOffset / pieceLength);

        const availability = await waitForPeerAvailability(conn, numPieces, timeoutMs);
        
        const plansPieces = new Set(plans.map(p => p.index));
        const wantedPiece = plansPieces.values().next().value;
        if (typeof wantedPiece === "undefined" || !availability.have[wantedPiece]) {
            console.log("Peer does not have the wanted piece:", wantedPiece);
            return null;
        }

        const data = await downloadPiece(conn, wantedPiece, pieceLength, totalOffset, {
            blockSize: 16 * 1024,
            pipeline: 8,
            timeoutMs: 15000,
        });

        console.log("Downloaded piece data length:", data.length);
        return data;


    } catch (err) {
        // console.log("❌ Failed to connect to", peer.ip, peer.port, err);
        return null;
    }

    return null;
}

// Adapt these to your environment if needed
function readUInt32BE(bytes: Uint8Array, offset = 0): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return dv.getUint32(0);
}

// Reads one wire message: returns { id, payload } where id=null for keep-alive
async function readMessage(conn: any, timeoutMs: number): Promise<{ id: number | null; payload: Uint8Array }> {
  const lenBuf: Uint8Array = await readExactly(conn, 4, timeoutMs);
  const length = readUInt32BE(lenBuf, 0);
  if (length === 0) return { id: null, payload: new Uint8Array(0) }; // keep-alive
  const idBuf: Uint8Array = await readExactly(conn, 1, timeoutMs);
  const id = idBuf[0];
  const payload: Uint8Array = await readExactly(conn, length - 1, timeoutMs);
  return { id, payload };
}

function parseBitfield(payload: Uint8Array, numPieces: number): boolean[] {
  const have = new Array<boolean>(numPieces).fill(false);
  for (let i = 0; i < numPieces; i++) {
    const byteIndex = (i / 8) | 0;
    const bitIndex = 7 - (i % 8); // MSB-first
    if (byteIndex < payload.length) {
      have[i] = ((payload[byteIndex] >> bitIndex) & 1) === 1;
    }
  }
  return have;
}

// Waits for availability info; returns a boolean[] with what the peer has.
// It prefers a bitfield; falls back to accumulating HAVE messages until timeout.
async function waitForPeerAvailability(conn: any, numPieces: number, timeoutMs: number): Promise<{ have: boolean[]; source: 'bitfield' | 'have_all' | 'have_none' | 'partial' }> {
  const have = new Array<boolean>(numPieces).fill(false);
  const deadline = Date.now() + timeoutMs;
  let sawAnyHave = false;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const { id, payload } = await readMessage(conn, remaining);
    console.log("Received message id:", id, "payload length:", payload.length);

    if (id === null) continue; // keep-alive; ignore

    switch (id) {
      case 5: { // bitfield
        const bf = parseBitfield(payload, numPieces);
        return { have: bf, source: 'bitfield' };
      }
      case 4: { // have
        if (payload.length >= 4) {
          const idx = readUInt32BE(payload, 0);
          if (idx < numPieces) {
            have[idx] = true;
            sawAnyHave = true;
          }
        }
        break;
      }
      case 0x0E: { // have_all (BEP 6)
        have.fill(true);
        return { have, source: 'have_all' };
      }
      case 0x0F: { // have_none (BEP 6)
        have.fill(false);
        return { have, source: 'have_none' };
      }
      default:
        // other messages (choke, unchoke, interested, etc.) — ignore for availability
        break;
    }
  }

  // Timeout: if we saw at least one HAVE, return partial; otherwise still empty.
  return { have, source: sawAnyHave ? 'partial' : 'have_none' };
}

export async function downloadFirstImage(metadata: Uint8Array, parsed: ReturnType<typeof parseMagnet>) {
    const bdecoded = bdecode(metadata) as Record<string, any>;
    // console.log("Parsed metadata:", bdecoded);
    const pieceLength = bdecoded['piece length'];

    const imagesExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    let firstImageStartOffset = -1;
    let firstImageLength = -1;
    for (let i = 0; i < (bdecoded['files'] || []).length; i++) {
        const file = bdecoded['files'][i];
        const filePathParts = file['path'].map((part: Uint8Array) => new TextDecoder().decode(part));
        const fileName = filePathParts.join('/').toLowerCase();
        if (imagesExtensions.some(ext => fileName.toLowerCase().endsWith(ext))) {
            firstImageLength = file['length'];
            break;
        }
        firstImageStartOffset += file['length'];
    }

    let totalOffset = 0;
    for (const file of bdecoded['files'] || []) {
        totalOffset += file['length'];
    }

    const firstImageEndOffset = firstImageStartOffset + firstImageLength;
    const piecesIndexStart = Math.floor(firstImageStartOffset / pieceLength);
    const piecesIndexEnd = Math.floor((firstImageEndOffset - 1) / pieceLength);

    const plans = [];
    for (let i = piecesIndexStart; i <= piecesIndexEnd; i++) {
        for (let j = 0; j < 20; j++) {
            plans.push({
                index: i,
                begin: j * 16384,
                length: Math.min(16384, pieceLength - j * 16384),
                sha1: bdecoded['pieces'].subarray(i * 20 + j, i * 20 + j + 1)
            });
        }
    }

    // Execute the plan to retrieve the image data
    const data = await fetchPeerPieces(parsed, plans, pieceLength, totalOffset, {
        skipHttp: true,
        skipUdp: false,
        skipDht: true
    });

    console.log("Retrieved image data length:", data?.length);
    // write to a file for testing
    if (data) {
        await Deno.writeFile("downloaded_image.dat", data);
    }

    return data;

    // TODO: Assemble the image data from the retrieved pieces
}