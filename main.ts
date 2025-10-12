import { parseMagnet } from './parse-magnet.ts';
import { getTrackers } from './http-tracker.ts';
import { parseTrackerPeers } from './parse-tracker-peers.ts';

const magnet = "magnet:?xt=urn:btih:2F875D32B69F4896DB731EE952D93B4787EEB7E6&dn=Special+Forces+Worlds+Toughest+Test+S04E03+1080p+WEB+h264-EDITH&tr=http%3A%2F%2Fp4p.arenabg.com%3A1337%2Fannounce&tr=udp%3A%2F%2F47.ip-51-68-199.eu%3A6969%2Fannounce&tr=udp%3A%2F%2F9.rarbg.me%3A2780%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2710%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2730%2Fannounce&tr=udp%3A%2F%2F9.rarbg.to%3A2920%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Fopentracker.i2p.rocks%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.cyberia.is%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.internetwarriors.net%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.pirateparty.gr%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.tiny-vps.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce"

async function test() {

    const parsed = parseMagnet(magnet);
    const trackers = await getTrackers(parsed);
    if (!trackers) {
        console.log('No trackers found');
        return;
    }
    const peers = parseTrackerPeers(trackers);
    if (!peers) {
        console.log('No peers found');
        return;
    }

    for (const peer of peers) {
        console.log('Peer:', peer);
        // try to connect to peer
        Deno.connect({ hostname: peer.ip, port: peer.port }).then(conn => {
            console.log('Connected to', peer.ip, peer.port);
            conn.close();
        }).catch(err => {
            console.log('Failed to connect to', peer.ip, peer.port, err.message);
        });
    }

}

test();