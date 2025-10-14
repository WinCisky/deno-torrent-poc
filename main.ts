import { serveFile } from "jsr:@std/http/file-server";
import { getTorrentMetadata } from './peer-metadata.ts';

const magnet = "magnet:?xt=urn:btih:7B973E55B2198EAC530440DC7D9589DD708F5692&dn=Shrek+%282001%29+1080p+BrRip+x264+-+1GB-+YIFY&tr=http%3A%2F%2Fp4p.arenabg.com%3A1337%2Fannounce&tr=udp%3A%2F%2F47.ip-51-68-199.eu%3A6969%2Fannounce&tr=udp%3A%2F%2F9.rarbg.me%3A2780%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2710%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2730%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2920%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Fopentracker.i2p.rocks%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.cyberia.is%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.internetwarriors.net%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.pirateparty.gr%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.tiny-vps.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce"

const options = {
    skipHttp: true,
    skipUdp: false,
    skipDht: true // DHT not implemented yet
};

Deno.serve(async (req: Request) => {
    const metadata = await getTorrentMetadata(magnet, options);
    if (metadata) {
        console.log(`Got metadata: ${metadata.length} bytes`);
        // return metadata as json
        return new Response(Uint8Array.from(metadata), {
            status: 200,
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": `attachment; filename="metadata.torrent"`,
            },
        });
    } else {
        console.log('No metadata retrieved');
        return new Response('No metadata retrieved', { status: 500 });
    }
});