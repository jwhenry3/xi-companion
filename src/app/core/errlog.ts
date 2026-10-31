// errlog.ts — forward page-side failures to overlay.log via xlog
// (POST /api/xport/log on the Go assetserver, console.debug off-shell).
// Installed before bootstrap so a module-level throw still reports —
// a dying page previously failed silently (no page: lines).
import { xlog } from './xport-socket';

const seen = new Set<string>();
let sent = 0;
// per-context cap — a render-loop error shouldn't fill overlay.log
const MAX_REPORTS = 60;

function report(kind: string, detail: string) {
  if (sent >= MAX_REPORTS) return;
  const loc = `${location.pathname}${location.search}`;
  const line = `${kind} @${loc}: ${detail}`.slice(0, 1500);
  if (seen.has(line)) return;
  seen.add(line);
  sent++;
  xlog(line);
}

const str = (v: unknown) =>
  v instanceof Error ? (v.stack ?? v.message) : String(v);

export function installErrorLog(tag: string) {
  const g = globalThis as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addEventListener?: (t: string, fn: (e: any) => void) => void;
  };
  g.addEventListener?.('error', (e: ErrorEvent) => {
    const src = e.filename
      ? ` ${e.filename}:${e.lineno}:${e.colno}`
      : '';
    report(
      `${tag} jserr`,
      `${e.message}${src}${e.error ? ` | ${e.error.stack ?? ''}` : ''}`,
    );
  });
  g.addEventListener?.(
    'unhandledrejection',
    (e: PromiseRejectionEvent) => {
      report(`${tag} unhandled`, str(e.reason));
    },
  );
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origError(...args);
    report(`${tag} console.error`, args.map(str).join(' '));
  };
}
