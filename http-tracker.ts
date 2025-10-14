import { bdecode } from './bdecode.ts';
import { parseTrackerPeers } from './parse-tracker-peers.ts';

function hexToUint8(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function percentEncodeInfoHash(infoHash: Uint8Array): string {
    return Array.from(infoHash)
        .map(b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
}

function getHttpTrackersUrl(trackers: string[]): string[] | null {
    const httpTrackers = trackers.filter(tr => tr.startsWith('http://') || tr.startsWith('https://'));
    return httpTrackers.length > 0 ? httpTrackers : null;
}

export async function getHttpTrackers(peerId: string, parsedMagnet: {
    info: string;
    infohash: Uint8Array<ArrayBuffer>;
    trackers: string[];
    name: string | null;
}) {
    const peersSet = new Set<string>();

    const httpTrackerUrls = getHttpTrackersUrl(parsedMagnet.trackers);
    if (!httpTrackerUrls) {
        console.log('No HTTP tracker found');
        return null;
    }
    const infoHash = hexToUint8(parsedMagnet.info); // Convert hex to Uint8Array
    const encodedInfoHash = percentEncodeInfoHash(infoHash);

    const port = 6881;
    
    for (const trackerUrl of httpTrackerUrls) {
        const url = new URL(trackerUrl);
        url.search = `?info_hash=${encodedInfoHash}&peer_id=${peerId}&port=${port}&uploaded=0&downloaded=0&left=0&compact=1&event=started`;

        const res = await fetch(url.toString());
        const body = new Uint8Array(await res.arrayBuffer());

        try {
            const decoded = bdecode(body);
            // {
            //     complete: 69,
            //     incomplete: 4,
            //     interval: 1800,
            //     "min interval": 900,
            //     peers: Uint8Array(24) [
            //         75,  91, 203, 116,  26, 225,  86,
            //         177, 146,   3,  26, 225,  82,  12,
            //         184, 196,  26, 225,  92,  20, 231,
            //         245,  26, 225
            //     ]
            // }
            const peers = parseTrackerPeers(decoded.peers);
            if (!peers) continue;
            peers.forEach((peer: { ip: string; port: number }) => peersSet.add(`${peer.ip}:${peer.port}`));
        } catch (e) {
            console.log(new TextDecoder().decode(body));
        }
    }
    return Array.from(peersSet).map(p => {
        const [ip, portStr] = p.split(':');
        return { ip, port: parseInt(portStr) };
    });
}