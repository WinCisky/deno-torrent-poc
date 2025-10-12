
function parsePeers(peersBinary: Uint8Array): { ip: string; port: number }[] {
    const peers = [];
    for (let i = 0; i < peersBinary.length; i += 6) {
        const ip = peersBinary.slice(i, i + 4).join('.');
        const port = (peersBinary[i + 4] << 8) + peersBinary[i + 5];
        peers.push({ ip, port });
    }
    return peers;
}

export function parseTrackerPeers(trackers: any): { ip: string; port: number }[] | null {
    if (!trackers || !trackers.peers) {
        console.log('No peers found in tracker response');
        return null;
    }

    const peersBinary = typeof trackers.peers === "string"
        ? new TextEncoder().encode(trackers.peers)
        : trackers.peers as Uint8Array;

    const peerList = parsePeers(peersBinary);
    
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