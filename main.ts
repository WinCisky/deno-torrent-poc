import { bdecode } from './bdecode.ts';
import { getTorrentMetadata } from './peer-metadata.ts';

const magnet = "magnet:?xt=urn:btih:7B973E55B2198EAC530440DC7D9589DD708F5692&dn=Shrek+%282001%29+1080p+BrRip+x264+-+1GB-+YIFY&tr=http%3A%2F%2Fp4p.arenabg.com%3A1337%2Fannounce&tr=udp%3A%2F%2F47.ip-51-68-199.eu%3A6969%2Fannounce&tr=udp%3A%2F%2F9.rarbg.me%3A2780%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2710%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2730%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2920%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Fopentracker.i2p.rocks%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.cyberia.is%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.internetwarriors.net%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.pirateparty.gr%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.tiny-vps.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce"

const METADATA_ROUTE = new URLPattern({ pathname: "/metadata/:magnet" });
const IMAGE_ROUTE = new URLPattern({ pathname: "/image/:magnet" });

Deno.serve({
    port: 4122,
    hostname: "0.0.0.0"
}, async (req: Request) => {

    const metadataMatch = METADATA_ROUTE.exec(req.url);
    if (metadataMatch) {
        const options = {
            skipHttp: true,
            skipUdp: false,
            skipDht: true // DHT not implemented yet
        };
        const base64magnet = metadataMatch.pathname.groups.magnet;
        if (!base64magnet) {
            return new Response("Magnet link missing", { status: 400 });
        }
        const magnet = atob(base64magnet);
        if (!magnet.startsWith("magnet:")) {
            return new Response("Invalid magnet link", { status: 400 });
        }
        const metadata = await getTorrentMetadata(magnet, options);

        if (metadata) {
            return new Response(Uint8Array.from(metadata), {
                status: 200,
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Disposition": `attachment; filename="metadata.torrent"`,
                },
            });
        }

        return new Response('No metadata retrieved', { status: 500 });
    }

    const retrieveImageMatch = IMAGE_ROUTE.exec(req.url);
    if (retrieveImageMatch) {
        // const base64magnet = retrieveImageMatch.pathname.groups.magnet;
        // if (!base64magnet) {
        //     return new Response("Magnet link missing", { status: 400 });
        // }
        // const magnet = atob(base64magnet);
        // if (!magnet.startsWith("magnet:")) {
        //     return new Response("Invalid magnet link", { status: 400 });
        // }
        // const options = {
        //     skipHttp: true,
        //     skipUdp: false,
        //     skipDht: true // DHT not implemented yet
        // };
        // const metadata = await getTorrentMetadata(magnet, options);

        // mock metadata for testing loading it from local file
        const metadata = await Deno.readFile("./metadata.torrent");

        if (metadata) {
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

            // let totalOffset = 0;
            // for (const file of bdecoded['files'] || []) {
            //     totalOffset += file['length'];
            //     const filePathParts = file['path'].map((part: Uint8Array) => new TextDecoder().decode(part));
            //     const fileName = filePathParts.join('/').toLowerCase();
            //     console.log(`File: ${fileName}, Length: ${file['length']} bytes`);
            // }
            // console.log(`Total torrent size: ${totalOffset} bytes, ${Math.floor(totalOffset / pieceLength)} files.`);

            const firstImageEndOffset = firstImageStartOffset + firstImageLength;
            const piecesIndexStart = Math.floor(firstImageStartOffset / pieceLength);
            const piecesIndexEnd = Math.floor((firstImageEndOffset - 1) / pieceLength);

            // each piece is composed of 20-byte SHA1 hash
            const piecesSha1: Uint8Array[] = [];
            for (let i = piecesIndexStart; i <= piecesIndexEnd; i++) {
                for (let j = 0; j < 20; j++) {
                    piecesSha1.push(bdecoded['pieces'].subarray(i * 20 + j, i * 20 + j + 1));
                }
            }
            console.log(`Image file spans pieces ${piecesSha1}`);

            // TODO: Retrieve the actual image data from peers using the metadata information.

            // Placeholder response for demonstration
            return new Response("Image data would be here", {
                status: 200,
                headers: {
                    "Content-Type": "image/jpeg",
                },
            });
        }

        return new Response('No metadata retrieved', { status: 500 });
    }

    return new Response("Route not found", {
        status: 404,
    });
});


type FileEntry = { length: number; path: string[] }; // from info.files
type PlanBlock = { pieceIndex: number; begin: number; length: number };

function buildFilePlan(
    files: FileEntry[] | null,
    pieceLength: number,
    piecesSha1: Uint8Array[], // 20-byte entries
    targetPath: string[],
    blockSize = 16 * 1024,
) {
    // 1) Compute torrent-wide file offsets
    const index: { path: string; start: number; length: number }[] = [];
    let cursor = 0;
    if (files && files.length) {
        for (const f of files) {
            const path = f.path.map(p => new TextDecoder().decode(p as unknown as Uint8Array)).join("/");
            index.push({ path, start: cursor, length: f.length });
            cursor += f.length;
        }
    } else {
        // single-file mode
        const name = "file"; // replace with info.name
        const length = /* info.length */ 0; // fill with real length
        index.push({ path: name, start: 0, length });
        cursor = length;
    }

    // 2) Locate target file
    const pathStr = targetPath.join("/");
    const f = index.find(e => e.path === pathStr);
    if (!f) throw new Error("Target file not found in torrent metadata");

    const fileStart = f.start;
    const fileEnd = f.start + f.length;

    // 3) Piece range
    const firstPiece = Math.floor(fileStart / pieceLength);
    const lastPiece = Math.floor((fileEnd - 1) / pieceLength);

    // 4) Full block plan (full pieces for verification)
    const blocks: PlanBlock[] = [];
    for (let p = firstPiece; p <= lastPiece; p++) {
        const pieceSize = (p === piecesSha1.length - 1)
            ? (cursor - p * pieceLength) // last piece may be shorter overall
            : pieceLength;

        for (let begin = 0; begin < pieceSize; begin += blockSize) {
            const len = Math.min(blockSize, pieceSize - begin);
            blocks.push({ pieceIndex: p, begin, length: len });
        }
    }

    // 5) For writing: compute per-piece file subranges
    function pieceFileSlice(pieceIndex: number) {
        const pieceStart = pieceIndex * pieceLength;
        const pieceEnd = pieceStart + ((pieceIndex === piecesSha1.length - 1) ? (cursor - pieceStart) : pieceLength);
        const writeStart = Math.max(pieceStart, fileStart);
        const writeEnd = Math.min(pieceEnd, fileEnd);
        if (writeStart >= writeEnd) return null;
        return {
            offsetInPiece: writeStart - pieceStart,
            bytesToWrite: writeEnd - writeStart,
            offsetInFile: writeStart - fileStart,
        };
    }

    return { blocks, firstPiece, lastPiece, pieceFileSlice };
}