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
            console.log("Parsed metadata:", bdecoded);

            const imagesExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
            const imagesFiles = bdecoded['files'].filter((file: Record<string, any>) => {
                // parse arraybuffer to string
                // const fileName = new TextDecoder().decode(file['path'].flat());
                // console.log("Checking file:", new TextDecoder().decode(file['path']));
                const filePaths = file['path'].map((part: Uint8Array) => new TextDecoder().decode(part));
                console.log("Checking file:", filePaths);
                const fileName = filePaths.join('/');
                return imagesExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
            });

            console.log("Image files found:", imagesFiles);

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