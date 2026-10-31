// xport-socket.ts — the overlay's events+request socket.
//
// The wails assetserver buffers every response until its handler
// returns (Windows WebView2 marshaling), so a held SSE stream can never
// deliver a byte there. When the addon launches the overlay with --pid,
// the Go side instead hosts a real ws://127.0.0.1 socket carrying the
// backend's message protocol — {t:'sse'|'res'} down, {t:'req'|'sub'}
// up — and names it at GET /api/xport/info: a completed GET, which the
// buffered writer handles fine.
//
// Every caller probes first: a null means the http surface (browser tab
// or dev server — the Lua server has no such route) and the normal
// fetch/EventSource paths stay untouched.

// Debug line → overlay.log via POST /api/xport/log on the Go side
// (transport.go). Fire-and-forget fetch — window.chrome.webview would
// work too but the POST also serves contexts that lack it. Off the
// overlay (browser/dev server) the route 404s and this is console-only.
export function xlog(msg: string): void {
  try {
    console.debug('[xport]', msg);
  } catch {}
  try {
    void fetch('/api/xport/log', { method: 'POST', body: msg }).catch(
      () => {},
    );
  } catch {}
}

export async function eventsSocketURL(apiBase: string): Promise<string | null> {
  const probe = `${apiBase}/api/xport/info`;
  try {
    const res = await fetch(probe);
    if (!res.ok) {
      xlog(`probe ${probe} -> ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { events?: unknown };
    const ev = typeof j.events === 'string' ? j.events : null;
    xlog(`probe ${probe} -> events=${ev}`);
    return ev;
  } catch (e) {
    xlog(`probe ${probe} threw: ${e}`);
    return null;
  }
}

export interface XportSocketHandlers {
  /** each backend event: name + JSON-string payload (SSE `data:` shape) */
  onEvent: (e: string, d: string) => void;
  /** a res for a req this socket sent — same client id */
  onRes?: (id: number, status: number, body: string | Uint8Array) => void;
  /** open/close transitions — feeds the same conn-status signal as SSE */
  onState?: (open: boolean) => void;
  /** socket died — caller decides when/whether to reopen */
  onDead?: () => void;
}

export interface XportSocket {
  socket: WebSocket;
  /** send a {t:'req'} frame; the res lands on onRes with the same id */
  sendReq(msg: { id: number; method: string; path: string; body?: string }): void;
}

export function openXportSocket(
  url: string,
  h: XportSocketHandlers,
): XportSocket {
  xlog(`ws open ${url}`);
  const sock = new WebSocket(url);
  sock.onopen = () => {
    xlog('ws open ok');
    h.onState?.(true);
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let m: {
      t?: string;
      e?: string;
      d?: string;
      id?: number;
      status?: number;
      body?: unknown;
      enc?: string;
    };
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.t === 'sse' && typeof m.e === 'string' && typeof m.d === 'string') {
      h.onEvent(m.e, m.d);
    } else if (m.t === 'res' && typeof m.id === 'number' && h.onRes) {
      let body: string | Uint8Array = typeof m.body === 'string' ? m.body : '';
      // hex flags a binary body (icons, map DATs) that can't ride JSON
      if (m.enc === 'hex' && typeof m.body === 'string') {
        const hex = m.body;
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) {
          out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        body = out;
      }
      h.onRes(m.id, typeof m.status === 'number' ? m.status : 0, body);
    }
  };
  sock.onerror = () => xlog('ws error event');
  sock.onclose = (ev) => {
    xlog(
      `ws close code=${ev.code} clean=${ev.wasClean} reason=${ev.reason || '-'}`,
    );
    h.onState?.(false);
    h.onDead?.();
  };
  return {
    socket: sock,
    sendReq(msg) {
      try {
        sock.send(JSON.stringify({ t: 'req', ...msg }));
      } catch (e) {
        xlog(`ws send failed (${msg.method} ${msg.path}): ${e}`);
      }
    },
  };
}
