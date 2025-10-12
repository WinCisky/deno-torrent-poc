
function parseMagnet(uri: string) {
  const params = new URL(uri).searchParams;
  const xt = params.get('xt'); // e.g. 'urn:btih:...'
  if (!xt) throw new Error('no xt');
  const info = xt.replace(/^urn:btih:/, '');
  const infohash = (info.length === 40)
    ? hexToUint8(info)
    : base32ToUint8(info); // implement base32 decoder
  const trackers = params.getAll('tr');
  return { info, infohash, trackers, name: params.get('dn') };
}

function hexToUint8(hex: string) {
  if (hex.length % 2 !== 0) throw new Error('invalid hex');
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return arr;
}

function base32ToUint8(base32: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32.replace(/=+$/, '').toUpperCase();
  const bits = cleaned.split('').map(c => {
    const idx = alphabet.indexOf(c);
    if (idx === -1) throw new Error('invalid base32');
    return idx.toString(2).padStart(5, '0');
  }).join('');
  const byteLength = Math.floor(bits.length / 8);
  const arr = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    arr[i] = parseInt(bits.substr(i * 8, 8), 2);
  }
  return arr;
}

export { parseMagnet };