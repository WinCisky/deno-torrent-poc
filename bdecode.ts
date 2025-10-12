export function bdecode(buf: Uint8Array): any {
    let pos = 0;

    function readByte(): number {
        return buf[pos++];
    }

    function peekByte(): number {
        return buf[pos];
    }

    function readNumber(): number {
        let start = pos;
        while (buf[pos] !== 0x65 /* 'e' */) pos++;
        const numStr = new TextDecoder().decode(buf.subarray(start, pos));
        pos++; // skip 'e'
        return parseInt(numStr, 10);
    }

    function readInt(): number {
        pos++; // skip 'i'
        return readNumber();
    }

    function readString(): string | Uint8Array {
        // read length until ':'
        let lenStart = pos;
        while (buf[pos] !== 0x3A /* ':' */) pos++;
        const lenStr = new TextDecoder().decode(buf.subarray(lenStart, pos));
        const len = parseInt(lenStr, 10);
        pos++; // skip ':'
        const strBytes = buf.subarray(pos, pos + len);
        pos += len;
        // You can return string or Uint8Array — depends on use case
        return new TextDecoder().decode(strBytes);
    }

    function readList(): any[] {
        pos++; // skip 'l'
        const list = [];
        while (buf[pos] !== 0x65 /* 'e' */) {
            list.push(readAny());
        }
        pos++; // skip 'e'
        return list;
    }

    function readDict(): Record<string, any> {
        pos++; // skip 'd'
        const dict: Record<string, any> = {};
        while (buf[pos] !== 0x65 /* 'e' */) {
            const key = readString();
            const val = readAny();
            dict[key as string] = val;
        }
        pos++; // skip 'e'
        return dict;
    }

    function readAny(): any {
        const byte = peekByte();
        if (byte === 0x64) return readDict();     // 'd'
        if (byte === 0x6C) return readList();     // 'l'
        if (byte === 0x69) return readInt();      // 'i'
        if (byte >= 0x30 && byte <= 0x39) return readString(); // digit
        throw new Error(`Unknown bencode type at position ${pos}: ${String.fromCharCode(byte)}`);
    }

    return readAny();
}
