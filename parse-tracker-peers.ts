
function parsePeers(peers: Uint8Array): { ip: string; port: number }[] {
    const peerList = [];
    for (let i = 0; i < peers.length; i += 6) {
        const ip = `${peers[i]}.${peers[i + 1]}.${peers[i + 2]}.${peers[i + 3]}`;
        const port = (peers[i + 4] << 8) + peers[i + 5];
        peerList.push({ ip, port });
    }
    return peerList;
}

export function parseTrackerPeers(trackers: any): { ip: string; port: number }[] | null {
    if (!trackers || trackers.length === 0) {
        console.log('No peers found in tracker response');
        return null;
    }

    const peerList = parsePeers(trackers);

    // remove those with invalid IPs or ports
    const validPeerList = peerList.filter(p => {
        const ipParts = p.ip.split('.').map(Number);
        const validIp = ipParts.length === 4 && ipParts.every(part => part >= 0 && part <= 255);
        const validPort = p.port > 0 && p.port < 65536;
        return validIp && validPort;
    });

    if (validPeerList.length === 0) {
        console.log('No valid peers found');
        return null;
    }

    return validPeerList;
}