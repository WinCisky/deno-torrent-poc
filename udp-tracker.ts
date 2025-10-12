export async function getUdpTrackers(
    peerId: string,
    parsedMagnet: {
        info: string;
        infohash: Uint8Array<ArrayBuffer>;
        trackers: string[];
        name: string | null;
    },
    timeoutMs = 2000, // add per-receive timeout (ms)
) {
    const udpTrackers = parsedMagnet.trackers.filter(tr => tr.startsWith('udp://'));
    if (udpTrackers.length === 0) {
        console.log('No UDP tracker found');
        return null;
    }

    const peersSet = new Set<string>();

    await Promise.allSettled(
        udpTrackers.map(async (trackerUrl) => {
            let conn: Deno.DatagramConn | null = null;
            try {
                const url = new URL(trackerUrl);
                const hostname = url.hostname;
                const udpPort = url.port ? parseInt(url.port) : 80;

                conn = Deno.listenDatagram({ transport: "udp", port: 0, hostname: "0.0.0.0" });

                const trackerIp = hostname;
                const trackerPort = udpPort;
                const infoHash = parsedMagnet.infohash;

                // 1. Send connect request
                const txId1 = Math.floor(Math.random() * 0xffffffff);
                const connectReq = createConnectRequest(txId1);
                await conn.send(connectReq, { transport: "udp", hostname: trackerIp, port: trackerPort });

                // 2. Wait for response (with timeout)
                const [resp1] = await withTimeout(conn.receive(), timeoutMs, "connect receive");
                const { connectionId } = parseConnectResponse(resp1);

                // 3. Send announce request
                const txId2 = Math.floor(Math.random() * 0xffffffff);
                const announceReq = createAnnounceRequest(
                    connectionId,
                    txId2,
                    infoHash as unknown as Uint8Array,
                    peerId as unknown as Uint8Array
                );
                await conn.send(announceReq, { transport: "udp", hostname: trackerIp, port: trackerPort });

                // 4. Wait for announce response (with timeout)
                const [resp2] = await withTimeout(conn.receive(), timeoutMs, "announce receive");
                const { peers } = parseAnnounceResponse(resp2);

                peers.forEach(peer => peersSet.add(`${peer.ip}:${peer.port}`));
            } catch {
                // ignore individual tracker errors
            } finally {
                try { conn?.close(); } catch {}
            }
        })
    );

    return Array.from(peersSet).map(p => {
        const [ip, portStr] = p.split(':');
        return { ip, port: parseInt(portStr) };
    });
}

function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then(
            v => { clearTimeout(id); resolve(v); },
            e => { clearTimeout(id); reject(e); }
        );
    });
}

function createConnectRequest(transactionId: number): Uint8Array {
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer);
    view.setBigUint64(0, 0x41727101980n); // magic constant
    view.setUint32(8, 0); // action: connect
    view.setUint32(12, transactionId);
    return new Uint8Array(buffer);
}

function parseConnectResponse(buf: Uint8Array): { transactionId: number; connectionId: bigint } {
    const view = new DataView(buf.buffer);
    const action = view.getUint32(0);
    const transactionId = view.getUint32(4);
    const connectionId = view.getBigUint64(8);
    if (action !== 0) throw new Error("Invalid connect response");
    return { transactionId, connectionId };
}

function createAnnounceRequest(connectionId: bigint, transactionId: number, infoHash: Uint8Array, peerId: Uint8Array): Uint8Array {
    const buffer = new ArrayBuffer(98);
    const view = new DataView(buffer);
    let offset = 0;

    view.setBigUint64(offset, connectionId); offset += 8;
    view.setUint32(offset, 1); offset += 4; // action: announce
    view.setUint32(offset, transactionId); offset += 4;

    new Uint8Array(buffer, offset, 20).set(infoHash); offset += 20;
    new Uint8Array(buffer, offset, 20).set(peerId); offset += 20;

    view.setBigUint64(offset, 0n); offset += 8; // downloaded
    view.setBigUint64(offset, BigInt(0xffffffffffffffffn)); offset += 8; // left
    view.setBigUint64(offset, 0n); offset += 8; // uploaded

    view.setUint32(offset, 0); offset += 4; // event
    view.setUint32(offset, 0); offset += 4; // IP address
    view.setUint32(offset, Math.floor(Math.random() * 0xffffffff)); offset += 4; // key
    view.setInt32(offset, -1); offset += 4; // num_want
    view.setUint16(offset, 6881); offset += 2; // port

    return new Uint8Array(buffer);
}

function parseAnnounceResponse(buf: Uint8Array): { peers: { ip: string, port: number }[] } {
    const view = new DataView(buf.buffer);
    const action = view.getUint32(0);
    const transactionId = view.getUint32(4);
    const interval = view.getUint32(8);
    const leechers = view.getUint32(12);
    const seeders = view.getUint32(16);

    const peers: { ip: string, port: number }[] = [];
    for (let i = 20; i < buf.length; i += 6) {
        const ip = `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`;
        const port = (buf[i + 4] << 8) + buf[i + 5];
        peers.push({ ip, port });
    }

    return { peers };
}
