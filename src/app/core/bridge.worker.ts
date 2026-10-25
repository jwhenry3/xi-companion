/// <reference lib="webworker" />
// Bridge SharedWorker — the single transport between every XIC window
// (main, detached panels, tooltip, spawned tabs) and the addon's HTTP
// server. Chromium caps ~6 connections per origin and an SSE stream
// holds one forever, so N windows holding N streams starved every other
// fetch once a handful of panels were open. One worker = one stream +
// one request queue; windows attach a MessagePort and get the same
// traffic, replayed on connect.
//
// Wire protocol (both directions are plain postMessage objects):
//   port → worker  {t:'req', id, method, path, headers?, body?}
//                  {t:'close'}
//   worker → port  {t:'sse', e:<event>, d:<raw data>}
//                  {t:'conn', ok:<bool>}       SSE stream open/closed
//                  {t:'res', id, ok, status, body}
//
// Snapshot-style SSE events (state/journal/recasts/map) are cached and
// replayed to newly attached ports so a just-spawned window hydrates
// without a fetch. `chat` is a stream, not a snapshot — windows pull
// their own /api/chat?after= history through the proxy.
const ctx = self as unknown as SharedWorkerGlobalScope;

const API_BASE: string =
  (import.meta.env.VITE_GSUI_API as string | undefined) ?? '';

const ports = new Set<MessagePort>();
const latest = new Map<string, string>();
const REPLAY = new Set(['state', 'journal', 'recasts', 'map']);
const EVENTS = new Set(['ping', 'state', 'chat', 'journal', 'recasts', 'map']);

let sseAbort: AbortController | null = null;
let sseOpen = false;
let lastEventAt = Date.now();

const broadcast = (msg: unknown) => {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch {
      ports.delete(p);
    }
  }
};

function dispatch(evt: string, d: string) {
  if (!EVENTS.has(evt)) return;
  lastEventAt = Date.now();
  if (REPLAY.has(evt)) latest.set(evt, d);
  broadcast({ t: 'sse', e: evt, d });
}

// EventSource is a Window-only API — worker globals don't expose it.
// The stream is read off fetch's ReadableStream and parsed per the SSE
// spec (event:/data: field lines, blank line terminates an event).
async function connect() {
  try {
    sseAbort?.abort();
  } catch {
    // aborting a dead stream can throw — irrelevant
  }
  const ab = (sseAbort = new AbortController());
  sseOpen = false;
  try {
    const res = await fetch(`${API_BASE}/api/events`, {
      signal: ab.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
    sseOpen = true;
    broadcast({ t: 'conn', ok: true });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let evt = 'message';
    let data = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data) dispatch(evt, data.endsWith('\n') ? data.slice(0, -1) : data);
          evt = 'message';
          data = '';
        } else if (line.startsWith('event:')) {
          evt = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += line.slice(5).replace(/^ /, '') + '\n';
        }
        // id:/retry:/comment lines carry nothing the windows need
      }
    }
    throw new Error('stream ended');
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return;
    sseOpen = false;
    broadcast({ t: 'conn', ok: false });
  }
}
void connect();

// the addon pings every 25s; >75s of silence means the conn died
// without an error — rebuild it (one stream for all windows)
setInterval(() => {
  if (Date.now() - lastEventAt > 75_000) void connect();
}, 15_000);

// ---------- request proxy ----------
// identical in-flight GETs share one fetch; static endpoints cache
// forever (itemmeta + journal names are per-window ~1MB pulls today)
interface ReqMsg {
  t: 'req';
  id: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}
interface ResBody {
  ok: boolean;
  status: number;
  body: string;
}
const inflight = new Map<string, Promise<ResBody>>();
const cached = new Map<string, ResBody>();
const IMMUTABLE = [
  /^\/api\/itemmeta\?/,
  /^\/api\/journal\/names$/,
  /^\/api\/chat\/phrases$/,
];

function doFetch(msg: ReqMsg, port: MessagePort) {
  const get = msg.method === 'GET';
  const key = `GET ${msg.path}`;
  const reply = (r: ResBody) => port.postMessage({ t: 'res', id: msg.id, ...r });
  if (get) {
    const hit = cached.get(key);
    if (hit) {
      reply(hit);
      return;
    }
    const flying = inflight.get(key);
    if (flying) {
      void flying.then(reply);
      return;
    }
  }
  const p = (async (): Promise<ResBody> => {
    try {
      const res = await fetch(`${API_BASE}${msg.path}`, {
        method: msg.method,
        headers: msg.headers,
        body: msg.body,
      });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e) {
      return { ok: false, status: 0, body: String(e) };
    }
  })();
  if (get) {
    inflight.set(key, p);
    void p.then((r) => {
      inflight.delete(key);
      if (r.ok && IMMUTABLE.some((re) => re.test(msg.path))) {
        cached.set(key, r);
      }
    });
  }
  void p.then(reply);
}

ctx.onconnect = (ev: MessageEvent) => {
  const port = ev.ports[0];
  ports.add(port);
  // hydrate: current connection state first — always posted, both as
  // the client's bridge-alive check and so resyncs fire off `conn ok` —
  // then the cached snapshot events
  port.postMessage({ t: 'conn', ok: sseOpen });
  for (const [e, d] of latest) port.postMessage({ t: 'sse', e, d });
  port.onmessage = (m: MessageEvent) => {
    const msg = m.data;
    if (msg?.t === 'req') {
      void doFetch(msg as ReqMsg, port);
    } else if (msg?.t === 'close') {
      ports.delete(port);
      port.close();
    }
  };
  port.start();
};
