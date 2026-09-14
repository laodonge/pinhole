export interface ResponseMeta {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Uint8Array {
  const u = new URL(url);
  const path = u.pathname + u.search;

  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${u.host}`,
    "Connection: close",
  ];
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "connection" || lk === "host" || lk === "content-length") continue;
    lines.push(`${k}: ${v}`);
  }
  if (body.length > 0) {
    lines.push(`Content-Length: ${body.length}`);
  }

  const head = encoder.encode(lines.join("\r\n") + "\r\n\r\n");
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export async function splitResponse(
  stream: ReadableStream<Uint8Array>,
): Promise<{ meta: ResponseMeta; body: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  let buffered = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock();
      throw new Error("invalid HTTP response: no header terminator");
    }
    buffered = concat([buffered, value]);
    const idx = findCrlfCrlf(buffered);
    if (idx !== -1) {
      const headBytes = buffered.subarray(0, idx);
      const rest = buffered.subarray(idx + 4);
      const meta = parseHead(headBytes);
      const body = makeBodyStream(reader, rest);
      return { meta, body };
    }
  }
}

function parseHead(headBytes: Uint8Array): ResponseMeta {
  const lines = decoder.decode(headBytes).split("\r\n");
  const statusLine = lines[0];
  const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/);
  const status = m ? parseInt(m[1], 10) : 502;
  const statusText = m && m[2] ? m[2] : "";

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) {
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  return { status, statusText, headers };
}

function makeBodyStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initial: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial.length > 0) controller.enqueue(initial);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });
}

function findCrlfCrlf(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
