import { bdecode } from './bdecode.ts';

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

export async function getTrackers(parsedMagnet: {
    info: string;
    infohash: Uint8Array<ArrayBuffer>;
    trackers: string[];
    name: string | null;
}) {
    const httpTrackerUrls = getHttpTrackersUrl(parsedMagnet.trackers);
    if (!httpTrackerUrls) {
        console.log('No HTTP tracker found');
        return null;
    }
    const infoHash = hexToUint8(parsedMagnet.info); // Convert hex to Uint8Array
    const encodedInfoHash = percentEncodeInfoHash(infoHash);

    const peerId = '-DN0001-' + crypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + String.fromCharCode(65 + (b % 26)), '');

    const port = 6881;
    
    for (const trackerUrl of httpTrackerUrls) {
        const url = new URL(trackerUrl);
        url.search = `?info_hash=${encodedInfoHash}&peer_id=${peerId}&port=${port}&uploaded=0&downloaded=0&left=0&compact=1&event=started`;

        const res = await fetch(url.toString());
        const body = new Uint8Array(await res.arrayBuffer());

        try {
            const decoded = bdecode(body);
            return decoded;
        } catch (e) {
            console.log(new TextDecoder().decode(body));
        }
    }
    return null;
}