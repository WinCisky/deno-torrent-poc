import { getTorrentMetadata } from "./peer-metadata.ts";
import { parseMagnet } from "./parse-magnet.ts";
import {
  contentDispositionFilename,
  createTorrentDownloadStream,
  createTorrentFilePlan,
  TorrentDownloadError,
} from "./torrent-download.ts";

const METADATA_ROUTE = new URLPattern({ pathname: "/metadata/:magnet" });
const DOWNLOAD_ROUTE = new URLPattern({ pathname: "/download" });

const trackerOptions = {
  skipHttp: true,
  skipUdp: false,
  skipDht: true,
};

Deno.serve({
  port: 4122,
  hostname: "0.0.0.0",
}, async (req: Request) => {
  const metadataMatch = METADATA_ROUTE.exec(req.url);
  if (metadataMatch) {
    const base64magnet = metadataMatch.pathname.groups.magnet;
    if (!base64magnet) {
      return new Response("Magnet link missing", { status: 400 });
    }

    const magnet = decodeBase64Magnet(base64magnet);
    if (!magnet) {
      return new Response("Invalid magnet link", { status: 400 });
    }

    const metadata = await getTorrentMetadata(magnet, trackerOptions);
    if (metadata) {
      return new Response(Uint8Array.from(metadata), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="metadata.torrent"`,
        },
      });
    }

    return new Response("No metadata retrieved", { status: 500 });
  }

  const downloadMatch = DOWNLOAD_ROUTE.exec(req.url);
  if (downloadMatch) {
    if (req.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    try {
      const body = await readDownloadRequest(req);
      const parsed = parseMagnet(body.magnet);
      const metadata = await getTorrentMetadata(body.magnet, trackerOptions);

      if (!metadata) {
        throw new TorrentDownloadError("No metadata retrieved", 502);
      }

      const plan = createTorrentFilePlan(metadata, body.path);
      const stream = await createTorrentDownloadStream(parsed, plan);

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(plan.length),
          "Content-Disposition": contentDispositionFilename(plan.filename),
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  return new Response("Route not found", {
    status: 404,
  });
});

type DownloadRequest = {
  magnet: string;
  path: string;
};

async function readDownloadRequest(req: Request): Promise<DownloadRequest> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new TorrentDownloadError("Expected JSON request body", 400);
  }

  if (!isRecord(body)) {
    throw new TorrentDownloadError("Expected JSON object request body", 400);
  }

  const magnet = body.magnet;
  const path = body.path;

  if (typeof magnet !== "string" || !magnet.startsWith("magnet:")) {
    throw new TorrentDownloadError("Invalid magnet link", 400);
  }

  if (typeof path !== "string" || path.trim().length === 0) {
    throw new TorrentDownloadError("Invalid file path", 400);
  }

  return { magnet, path };
}

function decodeBase64Magnet(base64magnet: string): string | null {
  try {
    const magnet = atob(base64magnet);
    return magnet.startsWith("magnet:") ? magnet : null;
  } catch {
    return null;
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof TorrentDownloadError) {
    return new Response(error.message, { status: error.status });
  }

  if (error instanceof Error) {
    console.error(error);
    return new Response(error.message, { status: 500 });
  }

  return new Response("Unknown error", { status: 500 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
