// Discord-style unified chat: game channels on the left, tells as DMs,
// message pane + composer on the right. Traffic arrives via the addon's
// incoming-packet interceptor (SSE 'chat' events); sends go through
// `input /<cmd>` — the same path as the game's chat line.
import { Component, View, inject, signal, computed, effect } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import { ChevronDown, ChevronRight, Pin, PinOff } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import { Dropdown } from '../core/dropdown';
import { commandFromDraft } from './send';
import type { ChatCustomChannel, ChatMessage } from '../core/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { PanelShell, PanelSidebar } from '../core/panel';

interface ChannelDef {
  key: string;
  label: string;
}

// canonical sidebar order — channels with traffic sit under ACTIVE, the
// rest collapse under OTHER until something arrives (or they're opened)
const CHANNELS: ChannelDef[] = [
  { key: 'say', label: 'say' },
  { key: 'shout', label: 'shout' },
  { key: 'yell', label: 'yell' },
  { key: 'emote', label: 'emote' },
  { key: 'party', label: 'party' },
  { key: 'linkshell', label: 'linkshell' },
  { key: 'linkshell2', label: 'linkshell2' },
  { key: 'unity', label: 'unity' },
  { key: 'battle', label: 'battle' },
  { key: 'system', label: 'system' },
  { key: 'echo', label: 'echo' },
  { key: 'assistj', label: 'assist jp' },
  { key: 'assiste', label: 'assist en' },
];

// in-game channel colors (client default font-color palette) — the
// whole line tints this way, so the chip and body share it
const CHANNEL_COLOR: Record<string, string> = {
  say: '#ffffff',
  shout: '#f0a9b8',
  tell: '#f06ec8',
  yell: '#b0f0b0',
  emote: '#7ee0f0',
  party: '#99d8f8',
  linkshell: '#a8e898',
  linkshell2: '#a8e898',
  unity: '#c0a8f0',
  battle: '#e0e0a0',
  system: '#b8b8b8',
  echo: '#909090',
  assistj: '#90c0f0',
  assiste: '#90c0f0',
};

// source channels offered in the custom-channel editor — 'tell' pulls
// every DM thread into the filter
const CUSTOM_SOURCES: ChannelDef[] = [
  ...CHANNELS,
  { key: 'tell', label: 'tells (all)' },
];

// FFXI's two default chat windows as preset threads: the conversation
// window and the system/combat log window
const PRESET_THREADS: Record<string, string[]> = {
  chat: [
    'say', 'shout', 'yell', 'tell', 'party', 'linkshell', 'linkshell2',
    'unity', 'emote', 'assistj', 'assiste',
  ],
  log: ['battle', 'system', 'echo'],
};

// composer only shows for these — system/assist are receive-only feeds
const SENDABLE = new Set([
  'say',
  'shout',
  'yell',
  'emote',
  'party',
  'linkshell',
  'linkshell2',
  'unity',
  'echo',
]);

// ---------- auto-translate phrases in the composer ----------
//
// A chosen phrase is inserted as {Name} — literal braces, the same
// convention Windower's chat line uses. The input's own text is
// transparent and a mirror div behind it renders the braces green/red
// like the game does; the addon encodes valid {Name} spans into real
// 0xFD…0xFD wire bytes on send.
const AT_OPEN = '{';
const AT_CLOSE = '}';

/** [openIdx, endIdx) pairs of brace-wrapped phrases in `text`; when
 *  `valid` is given, only spans whose inner name resolves count */
function atSpans(text: string, valid?: Set<string>): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = text.indexOf(AT_OPEN);
  while (i >= 0) {
    const e = text.indexOf(AT_CLOSE, i + 1);
    if (e < 0) break;
    const inner = text.slice(i + 1, e);
    if (inner && (!valid || valid.has(inner.toLowerCase())))
      spans.push([i, e + 1]);
    i = text.indexOf(AT_OPEN, e + 1);
  }
  return spans;
}

/** text -> JSX with auto-translate braces colored like the client:
 *  green open, red close */
function renderAtText(text: string, valid?: Set<string>) {
  const out: (string | JSX.Element)[] = [];
  let i = 0;
  while (i < text.length) {
    const o = text.indexOf(AT_OPEN, i);
    if (o < 0) break;
    const e = text.indexOf(AT_CLOSE, o + 1);
    if (e < 0) break;
    const inner = text.slice(o + 1, e);
    if (!inner || (valid && !valid.has(inner.toLowerCase()))) {
      // not a phrase — literal braces, no color
      out.push(text.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    out.push(text.slice(i, o));
    // bold the whole phrase, separated by spaces — none before when it
    // opens the message, none doubled next to existing whitespace
    const pre = o > 0 && !/\s/.test(text[o - 1]);
    const post = e + 1 < text.length && !/\s/.test(text[e + 1]);
    out.push(
      <span key={o} class="font-bold">
        {pre ? ' ' : ''}
        <span class="text-green-400">{'{'}</span>
        {inner}
        <span class="text-red-400">{'}'}</span>
        {post ? ' ' : ''}
      </span>,
    );
    i = e + 1;
  }
  out.push(text.slice(i));
  return out;
}

/** case-insensitive query -> JSX with matches wrapped in <mark> */
function hlText(seg: string, q: string): (string | JSX.Element)[] {
  if (!q) return [seg];
  const out: (string | JSX.Element)[] = [];
  const lseg = seg.toLowerCase();
  const lq = q.toLowerCase();
  let i = 0;
  while (i < seg.length) {
    const j = lseg.indexOf(lq, i);
    if (j < 0) break;
    if (j > i) out.push(seg.slice(i, j));
    out.push(
      <mark key={j} class="rounded-sm bg-amber-400/30 text-amber-100">
        {seg.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  out.push(seg.slice(i));
  return out;
}

/** message body render: auto-translate braces stay colored, the plain
 *  runs in between get query highlighting */
function renderMsgText(text: string, q?: string) {
  if (!q) return renderAtText(text);
  const out: (string | JSX.Element)[] = [];
  let i = 0;
  while (i < text.length) {
    const o = text.indexOf(AT_OPEN, i);
    if (o < 0) break;
    const e = text.indexOf(AT_CLOSE, o + 1);
    if (e < 0) break;
    out.push(...hlText(text.slice(i, o), q));
    out.push(
      <span key={o}>
        <span class="text-green-400">{'{'}</span>
        {hlText(text.slice(o + 1, e), q)}
        <span class="text-red-400">{'}'}</span>
      </span>,
    );
    i = e + 1;
  }
  out.push(...hlText(text.slice(i), q));
  return out;
}

/** the word fragment ending at the caret (autocomplete target) */
function fragmentBefore(v: string, caret: number): { start: number; text: string } {
  let s = caret;
  while (s > 0 && v[s - 1] !== ' ' && v[s - 1] !== AT_OPEN && v[s - 1] !== AT_CLOSE) s--;
  return { start: s, text: v.slice(s, caret) };
}

function atMatches(frag: string, names: string[]): string[] {
  const f = frag.toLowerCase();
  if (!f) return [];
  const pre = names.filter((n) => n.toLowerCase().startsWith(f));
  if (pre.length) return pre.slice(0, 8);
  return names.filter((n) => n.toLowerCase().includes(f)).slice(0, 8);
}

/** thread a message belongs to — tells are DMs keyed by peer (mirrors
 *  AddonApi.chatThread) */
function chatThreadKey(m: ChatMessage): string {
  return m.channel === 'tell' ? `tell:${m.peer ?? m.sender ?? ''}` : m.channel;
}

// stable per-sender hue so names are scannable like discord
function nameColor(name?: string): string {
  let h = 0;
  for (const c of name ?? '') h = (h * 31 + (c.codePointAt(0) ?? 0)) | 0;
  return `color: hsl(${((h % 360) + 360) % 360} 70% 66%)`;
}

function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function MessageList({
  messages,
  query,
  onOpenThread,
  newAt,
  onDismiss,
}: {
  messages: ChatMessage[];
  query?: string;
  /** set when the list mixes channels (all-scope search) — rows get a
   *  channel chip that jumps to that thread */
  onOpenThread?: (thread: string) => void;
  /** seq where unread starts — renders the 'new messages' divider */
  newAt?: number | null;
  /** pane click clears the divider (discord-style) */
  onDismiss?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.seq]);

  return (
    <div
      ref={ref}
      class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-4 py-3"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      onClick={() => onDismiss?.()}
    >
      {messages.length === 0 && (
        <p class="py-8 text-center text-xs text-slate-500">
          {query ? 'no matches' : 'no messages yet'}
        </p>
      )}
      {messages.map((m) => {
        const learn = m.kind === 'learn';
        const divider = m.seq === newAt;
        // every message is a full inline row — channel on the chip only,
        // no continuation grouping (a sender's messages across channels
        // were collapsing under the wrong label)
        return (
          <div key={m.seq} class="contents">
            {divider && (
              <div class="flex items-center gap-2 pt-2">
                <span class="h-px flex-1 bg-rose-500/60" />
                <span class="text-[9px] font-bold uppercase tracking-wider text-rose-400">
                  new
                </span>
                <span class="h-px flex-1 bg-rose-500/60" />
              </div>
            )}
          <div class={cn('pt-0.5', m.self && 'text-right')}>
            {/* metadata line: time, sender, then channel/zone after the
                name — message text drops to the line below so long
                bodies never crowd the label */}
            <div
              class={cn(
                'flex items-baseline gap-2',
                m.self && 'justify-end',
              )}
            >
              {learn && <span class="text-[10px] text-sky-300">★</span>}
              <span
                class="shrink-0 text-xs font-semibold text-slate-400"
                title={m.mode != null ? `mode ${m.mode}` : undefined}
              >
                {fmtTime(m.ts)}
              </span>
              <button
                class="shrink-0 text-xs font-bold hover:brightness-125"
                style={{ color: CHANNEL_COLOR[m.channel] ?? '#64748b' }}
                onClick={() => onOpenThread?.(chatThreadKey(m))}
              >
                {m.channel === 'tell'
                  ? `@${m.peer ?? m.sender ?? '?'}`
                  : `#${m.channel}`}
              </button>
              {m.sender && !m.self && (
                <button
                  class="shrink-0 text-xs font-bold hover:underline"
                  title={`message ${m.sender}`}
                  style={nameColor(m.sender)}
                  onClick={() =>
                    onOpenThread?.('tell:' + m.sender)
                  }
                >
                  {m.sender}
                </button>
              )}
              {m.zone && (
                <span class="shrink-0 text-xs font-semibold text-slate-400">
                  {m.zone}
                </span>
              )}
            </div>
            {/* sms-style bubble — self right with a tail, others left */}
            <div class={cn('flex', m.self ? 'justify-end' : 'justify-start')}>
              <div
                class={cn(
                  'chat-bubble max-w-[80%] rounded-sm px-1.5 py-0.5 text-left text-sm leading-snug break-words',
                  m.self
                    ? 'bg-sky-700/20 text-sky-50'
                    : 'bg-black/20 text-slate-200',
                  learn && 'learn border-l-2 bg-sky-950/20 text-sky-100',
                  m.channel === 'emote' && 'italic',
                )}
              >
              {m.channel === 'emote' ? `* ${m.text}` : renderMsgText(m.text, query)}
              </div>
            </div>
          </div>
          </div>
        );
      })}
    </div>
  );
}

@Component()
export class ChatView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);

  private draft = signal('');
  private dmOpen = signal(false);
  private dmName = signal('');
  private searchQ = signal('');
  private searchAll = signal(false);
  private clearAllArm = signal(false);
  /** sidebar section collapse state — section name -> hidden. Not
   *  persisted; collapsed is a session convenience */
  private sectionHidden = signal(new Set<string>());
  private toggleSection(name: string) {
    const s = new Set(this.sectionHidden.value);
    s.has(name) ? s.delete(name) : s.add(name);
    this.sectionHidden.value = s;
  }
  private sectionHead(name: string, label: string, extra?: JSX.Element) {
    const hidden = this.sectionHidden.value.has(name);
    return (
      <div class="mt-2 flex items-center justify-between border-t border-slate-800 px-2 pt-2 pb-1">
        <button
          class="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-slate-500 hover:text-slate-300"
          onClick={() => this.toggleSection(name)}
        >
          {hidden ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
          {label}
        </button>
        {extra}
      </div>
    );
  }

  private pins = signal<Set<string>>(
    new Set(
      JSON.parse(
        localStorage.getItem('xicompanion.chat.pins') ?? '[]',
      ) as string[],
    ),
  );
  private customOpen = signal(false);
  private customEditing = signal<string | null>(null);
  private customName = signal('');
  private customPicks = signal<Record<string, boolean>>({});
  // where 'all'/custom threads send — remembered across channel hops
  private sendTarget = signal('party');
  private error = signal<string | null>(null);
  private phrases = signal<string[] | null>(null);
  private phraseSet = new Set<string>();
  private suggest = signal<{ items: string[]; index: number } | null>(null);
  private inputEl: HTMLInputElement | null = null;
  private disposeFocus: (() => void) | null = null;
  private focusSeen = 0;

  onInit() {
    void this.api.refreshChat();
    void this.api.refreshChatChannels();
    void this.ensurePhrases();
    // spacebar→chat-focus: register this window so the addon's key steal
    // gates correctly, and answer its 'chatfocus' ping by raising the
    // window + dropping the caret into the composer
    void this.api.chatFocusWindow(true);
    this.focusSeen = this.api.chatFocus.value;
    this.disposeFocus = effect(() => {
      const n = this.api.chatFocus.value;
      if (n > this.focusSeen) {
        this.focusSeen = n;
        host.spawnWindow('/chat'); // no-op if open; raises + focuses it
        this.inputEl?.focus();
      }
    });
    // another window (e.g. the map's player → tell action) hands us a
    // thread through localStorage — consume it on boot and on change
    const pending = localStorage.getItem('xicompanion.chat.thread');
    if (pending) {
      localStorage.removeItem('xicompanion.chat.thread');
      this.open(pending);
    }
    window.addEventListener('storage', this.onStorage);
  }

  onDestroy() {
    window.removeEventListener('storage', this.onStorage);
    void this.api.chatFocusWindow(false);
    this.disposeFocus?.();
    this.disposeFocus = null;
  }

  private onStorage = (e: StorageEvent) => {
    if (e.key === 'xicompanion.chat.thread' && e.newValue) {
      localStorage.removeItem('xicompanion.chat.thread');
      this.open(e.newValue);
    }
  };

  private async ensurePhrases() {
    if (this.phrases.value) return;
    try {
      const names = await this.api.chatPhrases();
      this.phrases.value = names;
      for (const n of names) this.phraseSet.add(n.toLowerCase());
    } catch {
      // autocomplete is best-effort
    }
  }

  /** phrase names currently wrapped in braces inside `text` */
  private markedPhrases(text: string): string[] {
    return atSpans(text, this.phraseSet).map(([o, e]) => text.slice(o + 1, e - 1));
  }

  private acceptPhrase(name: string) {
    const el = this.inputEl;
    // fall back to the draft signal — a missing ref must not silently
    // swallow the accept, the visible text has to change either way
    const src = el?.value ?? this.draft.value;
    const caret = el?.selectionStart ?? src.length;
    const frag = fragmentBefore(src, caret);
    // a '{' the user opened themselves gets swallowed into the phrase
    const s = src[frag.start - 1] === AT_OPEN ? frag.start - 1 : frag.start;
    const ins = AT_OPEN + name + AT_CLOSE + ' ';
    const next = src.slice(0, s) + ins + src.slice(caret);
    this.draft.value = next;
    if (el) {
      el.value = next;
      // the re-render re-assigns input.value and collapses the caret —
      // restore it on the microtask after the diff lands
      const pos = s + ins.length;
      queueMicrotask(() => {
        if (this.inputEl) {
          this.inputEl.selectionStart = this.inputEl.selectionEnd = pos;
        }
      });
    }
    this.suggest.value = null;
  }

  private async autocomplete(el: HTMLInputElement) {
    await this.ensurePhrases();
    const names = this.phrases.value;
    if (!names) return;
    const caret = el.selectionStart ?? el.value.length;
    const items = atMatches(fragmentBefore(el.value, caret).text, names);
    if (items.length === 1) this.acceptPhrase(items[0]);
    else if (items.length > 1) this.suggest.value = { items, index: 0 };
  }

  private onComposerInput(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const v = el.value;
    this.draft.value = v;
    const sug = this.suggest.value;
    if (sug && this.phrases.value) {
      const caret = el.selectionStart ?? v.length;
      const items = atMatches(fragmentBefore(v, caret).text, this.phrases.value);
      this.suggest.value = items.length ? { items, index: sug.index % items.length } : null;
    }
  }

  private onComposerKey(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLInputElement;
    // '/' commands: Enter always sends (native input behavior) — an
    // open suggest popup must not eat it; Tab still accepts a phrase
    if (e.key === 'Enter' && el.value.startsWith('/')) {
      e.preventDefault();
      this.suggest.value = null;
      void this.send();
      return;
    }
    const sug = this.suggest.value;
    if (sug) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : sug.items.length - 1;
        this.suggest.value = {
          items: sug.items,
          index: (sug.index + d) % sug.items.length,
        };
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.acceptPhrase(sug.items[sug.index]);
        return;
      }
      if (e.key === 'Escape') {
        this.suggest.value = null;
        return;
      }
    }
    if (e.key === 'Enter') {
      void this.send();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      void this.autocomplete(el);
      return;
    }
    // atomic phrase deletion: Backspace/Delete landing inside (or at the
    // edge of) a braced phrase removes { + name + } as one unit
    if (
      (e.key === 'Backspace' || e.key === 'Delete') &&
      el.selectionStart === el.selectionEnd
    ) {
      const caret = el.selectionStart ?? 0;
      const span = atSpans(el.value, this.phraseSet).find(([o, ce]) =>
        e.key === 'Backspace'
          ? caret > o && caret <= ce
          : caret >= o && caret < ce,
      );
      if (span) {
        e.preventDefault();
        el.value = el.value.slice(0, span[0]) + el.value.slice(span[1]);
        el.selectionStart = el.selectionEnd = span[0];
        this.draft.value = el.value;
        this.suggest.value = null;
      }
    }
  }

  // tell:* threads seen in history, most recent first
  private dms = computed(() => {
    const latest = new Map<string, number>();
    for (const m of this.api.chat.value) {
      const peer = m.channel === 'tell' ? (m.peer ?? m.sender ?? '') : '';
      if (peer) latest.set(peer, Math.max(latest.get(peer) ?? 0, m.seq));
    }
    return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  });

  /** fixed sidebar order — channels never regroup on traffic; only
   *  user pins float a row to the PINNED section */
  private listedChannels = computed(() =>
    CHANNELS.filter((c) => !this.pins.value.has(c.key)),
  );

  /** member channels for multi-channel threads — 'all', custom,
   *  presets return null/sets; single channels return null and match
   *  by chatThread instead */
  private membersOf(thread: string): Set<string> | null {
    if (thread.startsWith('custom:')) {
      const def = this.api.chatCustom.value.find(
        (c) => `custom:${c.name}` === thread,
      );
      return new Set(def?.channels ?? []);
    }
    if (PRESET_THREADS[thread]) return new Set(PRESET_THREADS[thread]);
    return null;
  }

  private filterMsgs(thread: string, all: boolean, q: string) {
    const members = this.membersOf(thread);
    return this.api.chat.value.filter((m) => {
      if (!all && thread !== 'all') {
        if (members) {
          if (!members.has(m.channel)) return false;
        } else if (this.api.chatThread(m) !== thread) {
          return false;
        }
      }
      if (!q) return true;
      return (
        m.text.toLowerCase().includes(q) ||
        (m.sender?.toLowerCase().includes(q) ?? false)
      );
    });
  }

  private messages = computed(() =>
    this.filterMsgs(
      this.api.activeChat.value === 'split'
        ? this.pane1Thread.value
        : this.api.activeChat.value,
      this.searchAll.value,
      this.searchQ.value.trim().toLowerCase(),
    ),
  );

  // ---------- vertical split (FFXI's two-window layout) ----------

  private splitOpen = signal(
    localStorage.getItem('xicompanion.chat.split') === '1',
  );
  private splitSearchQ = signal('');
  private splitThread = signal(
    localStorage.getItem('xicompanion.chat.splitthread') ?? 'log',
  );
  private pane1Thread = signal(
    localStorage.getItem('xicompanion.chat.pane1') ?? 'chat',
  );
  private setPane1Thread(t: string) {
    this.pane1Thread.value = t;
    localStorage.setItem('xicompanion.chat.pane1', t);
  }

  private splitMessages = computed(() =>
    this.filterMsgs(
      this.splitThread.value,
      false,
      this.splitSearchQ.value.trim().toLowerCase(),
    ),
  );

  private setSplit(v: boolean) {
    this.splitOpen.value = v;
    localStorage.setItem('xicompanion.chat.split', v ? '1' : '0');
  }
  private setSplitThread(t: string) {
    this.splitThread.value = t;
    localStorage.setItem('xicompanion.chat.splitthread', t);
  }

  // ---------- split-pane composer ----------

  private splitDraft = signal('');
  private splitSendTarget = signal('party');

  /** sendable members of the split pane's thread (empty for tell:/read-
   *  only threads) */
  private splitTargets(): string[] {
    const t = this.splitThread.value;
    const members =
      t === 'all' ? CHANNELS.map((c) => c.key)
      : t.startsWith('custom:')
        ? (this.api.chatCustom.value.find((c) => `custom:${c.name}` === t)
            ?.channels ?? [])
        : PRESET_THREADS[t] ?? (t.startsWith('tell:') ? [] : [t]);
    return members.filter((c) => SENDABLE.has(c));
  }

  private splitSendChannel(): string | null {
    const targets = this.splitTargets();
    if (!targets.length) return null;
    return targets.includes(this.splitSendTarget.value)
      ? this.splitSendTarget.value
      : (targets[0] ?? null);
  }

  private async sendSplit() {
    const text = this.splitDraft.value.trim();
    if (!text) return;
    this.splitDraft.value = '';
    const st = this.splitThread.value;
    try {
      if (st.startsWith('tell:')) {
        await this.api.sendChat('tell', text, st.slice(5));
      } else {
        const chan = this.splitSendChannel();
        if (!chan) return;
        this.splitSendTarget.value = chan;
        await this.api.sendChat(chan, text);
      }
    } catch (e) {
      this.error.value = String(e);
    }
  }

  private dividerSeq = signal<number | null>(null);

  private open(thread: string) {
    // capture the unread anchor BEFORE markChatRead zeroes the badge —
    // the first unread message is unread-count back from the tail.
    // Only set on unread — re-entering a read thread must NOT clear it:
    // the marker is dismissed by interaction, not navigation
    const unread = this.api.chatUnread.value[thread] ?? 0;
    if (unread > 0) {
      const msgs = this.filterMsgs(thread, false, '');
      const seq = msgs[msgs.length - unread]?.seq;
      if (seq != null) this.dividerSeq.value = seq;
    }
    this.api.activeChat.value = thread;
    this.api.markChatRead(thread);
    // search is scoped to the thread — it doesn't travel with the switch
    this.searchQ.value = '';
  }

  /** dismiss the new-messages marker — only when the pane interacted
   *  with is the one actually rendering it (a click in a different
   *  channel's pane shouldn't count) */
  private dismissNew() {
    const seq = this.dividerSeq.value;
    if (seq != null && this.messages.value.some((m) => m.seq === seq)) {
      this.dividerSeq.value = null;
    }
  }

  private startDm() {
    const name = this.dmName.value.trim();
    if (!name) return;
    this.dmName.value = '';
    this.dmOpen.value = false;
    this.open(`tell:${name}`);
  }

  // ---------- custom filter channels ----------

  private startCustom(c: ChatCustomChannel | null) {
    this.customEditing.value = c?.name ?? null;
    this.customName.value = c?.name ?? '';
    const picks: Record<string, boolean> = {};
    for (const ch of c?.channels ?? []) picks[ch] = true;
    this.customPicks.value = picks;
    this.customOpen.value = true;
  }

  private async saveCustom() {
    const name = this.customName.value.trim();
    const channels = CUSTOM_SOURCES.filter(
      (c) => this.customPicks.value[c.key],
    ).map((c) => c.key);
    if (!name || !channels.length) return;
    const editing = this.customEditing.value;
    const list = this.api.chatCustom.value.filter(
      (c) => c.name !== editing && c.name !== name,
    );
    list.push({ name, channels });
    try {
      await this.api.saveChatChannels(list);
      this.customOpen.value = false;
    } catch (e) {
      this.error.value = String(e);
    }
  }

  private async deleteCustom(name: string) {
    try {
      await this.api.saveChatChannels(
        this.api.chatCustom.value.filter((c) => c.name !== name),
      );
      if (this.api.activeChat.value === `custom:${name}`) this.open('all');
    } catch (e) {
      this.error.value = String(e);
    }
  }

  // ---------- sending ----------

  /** channels the composer can target in the current thread: null when
   *  the thread IS a channel (it sends to itself), a list for
   *  'all'/custom views */
  private sendTargets(): string[] | null {
    const thread = this.api.activeChat.value;
    if (thread === 'split') {
      return CHANNELS.filter((c) => SENDABLE.has(c.key)).map((c) => c.key);
    }
    if (thread === 'all') {
      return CHANNELS.filter((c) => SENDABLE.has(c.key)).map((c) => c.key);
    }
    if (thread.startsWith('custom:')) {
      const def = this.api.chatCustom.value.find(
        (c) => `custom:${c.name}` === thread,
      );
      return (def?.channels ?? []).filter((c) => SENDABLE.has(c));
    }
    if (PRESET_THREADS[thread]) {
      return PRESET_THREADS[thread].filter((c) => SENDABLE.has(c));
    }
    return null;
  }

  /** resolves the actual POST /api/chat channel for the current thread */
  private sendChannel(): string | null {
    const targets = this.sendTargets();
    if (!targets) {
      const thread = this.api.activeChat.value;
      return SENDABLE.has(thread) ? thread : null;
    }
    return targets.includes(this.sendTarget.value)
      ? this.sendTarget.value
      : (targets[0] ?? null);
  }

  private async send() {
    const text = this.draft.value.trim();
    if (!text) return;
    const thread = this.api.activeChat.value;
    this.draft.value = '';
    this.suggest.value = null;
    this.error.value = null;
    try {
      const clean = text.replace(/[⁠​]/g, '');
      const cmd = commandFromDraft(clean);
      if (cmd != null) {
        // raw command — channel picker ignored; '//' runs as a
        // windower command, '/' reaches the client through `input`
        await this.api.sendCommand(cmd);
        // '//echo' prints to the windower console, not the game log —
        // mirror it into our echo channel ('/echo' echoes back itself)
        const e = clean.match(/^\/\/echo\s+(.+)/s);
        if (e) this.api.injectLocal('echo', e[1]);
        return;
      }
      if (thread.startsWith('tell:')) {
        await this.api.sendChat('tell', text, thread.slice(5));
      } else {
        const chan = this.sendChannel();
        if (!chan) return;
        this.sendTarget.value = chan;
        if (chan === 'echo') {
          // no sendable channel — /echo is a native client command that
          // prints to your own log (which our capture then surfaces)
          await this.api.sendCommand(`input /echo ${clean}`);
          return;
        }
        await this.api.sendChat(chan, text);
      }
    } catch (e) {
      this.error.value = String(e);
    }
  }

  private togglePin(key: string) {
    const s = new Set(this.pins.value);
    if (s.has(key)) s.delete(key);
    else s.add(key);
    this.pins.value = s;
    localStorage.setItem('xicompanion.chat.pins', JSON.stringify([...s]));
  }

  /** pinned rows resolved for the PINNED section: channel, custom,
   *  or DM thread keys → [key, label, icon] */
  private pinnedRows = computed((): [string, string, string][] => {
    const out: [string, string, string][] = [];
    for (const k of this.pins.value) {
      if (k === 'all' || k === 'chat' || k === 'log')
        out.push([k, k, '≡']);
      else if (k.startsWith('custom:')) {
        const c = this.api.chatCustom.value.find((x) => `custom:${x.name}` === k);
        if (c) out.push([k, c.name, '≡']);
      } else if (k.startsWith('tell:')) {
        out.push([k, k.slice(5), '@']);
      } else if (CHANNELS.some((c) => c.key === k)) {
        out.push([k, CHANNELS.find((c) => c.key === k)!.label, '#']);
      }
    }
    return out;
  });

  private threadRow(key: string, label: string, icon: string) {
    const active = this.api.activeChat.value === key;
    const unread = this.api.chatUnread.value[key] ?? 0;
    const alerts = this.api.chatAlerts.value[key] ?? 0;
    return (
      <div key={key} class="group flex items-center">
        <button
          class={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-sm',
            active ? 'bg-black/30 text-slate-100' : 'text-slate-400 hover:bg-black/30/60 hover:text-slate-200',
          )}
          onClick={() => this.open(key)}
        >
          <span class="text-slate-500">{icon}</span>
          <span class="min-w-0 flex-1 truncate">{label}</span>
          {alerts > 0 && (
            <span class="text-[10px] text-sky-300" title="flagged messages">
              ★{alerts > 1 ? alerts : ''}
            </span>
          )}
          {unread > 0 && (
            <span class="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </div>
    );
  }

  render() {
    const thread = this.api.activeChat.value;
    const isSplit = thread === 'split';
    const isTell = thread.startsWith('tell:');
    const isAll = thread === 'all';
    const customDef = thread.startsWith('custom:')
      ? this.api.chatCustom.value.find(
          (c) => `custom:${c.name}` === thread,
        )
      : undefined;
    const chan = isTell ? 'tell' : thread;
    const icon = isTell ? '@' : isAll || customDef ? '≡' : '#';
    const label = isTell
      ? thread.slice(5)
      : customDef
        ? customDef.name
        : chan;
    const title = `${icon} ${label}`;
    const targets = this.sendTargets();
    const canSend =
      isTell ||
      (targets ? targets.length > 0 : SENDABLE.has(chan));
    // chips on rows when the pane mixes channels
    const mixed =
      this.searchAll.value || isAll || isSplit || thread.startsWith('custom:');

    return (
      <PanelShell class="chat-view">
        {/* channel / DM sidebar */}
        <PanelSidebar class="w-48">
          <div class="flex-1 overflow-y-auto p-2">
            {this.threadRow('all', 'all', '≡')}
            {this.threadRow('chat', 'chat', '≡')}
            {this.threadRow('log', 'log', '≡')}
            {this.threadRow('split', 'split', '⇕')}
            {this.pinnedRows.value.length > 0 && (
              <>
                {this.sectionHead('pinned', 'PINNED')}
                {!this.sectionHidden.value.has('pinned') &&
                  this.pinnedRows.value.map(([k, l, i]) =>
                    this.threadRow(k, l, i),
                  )}
              </>
            )}
            {this.sectionHead('channels', 'CHANNELS')}
            {!this.sectionHidden.value.has('channels') &&
              this.listedChannels.value.map((c) =>
                this.threadRow(c.key, c.label, '#'),
              )}
            {this.sectionHead(
              'custom',
              'CUSTOM',
              <button
                class="text-xs text-slate-500 hover:text-slate-200"
                title="new filter channel"
                onClick={() => this.startCustom(null)}
              >
                +
              </button>,
            )}
            {!this.sectionHidden.value.has('custom') &&
              this.api.chatCustom.value
              .filter((c) => !this.pins.value.has(`custom:${c.name}`))
              .map((c) => (
              <div key={c.name} class="group flex items-center">
                {this.threadRow(`custom:${c.name}`, c.name, '≡')}
                <button
                  class="shrink-0 px-0.5 text-[10px] text-slate-600 opacity-0 transition-opacity hover:text-slate-200 group-hover:opacity-100"
                  title="edit filter"
                  onClick={() => this.startCustom(c)}
                >
                  ✎
                </button>
                <button
                  class="shrink-0 px-0.5 text-[10px] text-slate-600 opacity-0 transition-opacity hover:text-rose-300 group-hover:opacity-100"
                  title="delete filter"
                  onClick={() => void this.deleteCustom(c.name)}
                >
                  ×
                </button>
              </div>
            ))}
            {this.api.chatCustom.value.length === 0 &&
              !this.sectionHidden.value.has('custom') && (
                <p class="px-2 text-[10px] text-slate-600">saved filters</p>
              )}
            {this.sectionHead(
              'dms',
              'DIRECT MESSAGES',
              <button
                class="text-xs text-slate-500 hover:text-slate-200"
                title="new tell"
                onClick={() => (this.dmOpen.value = !this.dmOpen.value)}
              >
                +
              </button>,
            )}
            {!this.sectionHidden.value.has('dms') &&
              this.dms.value
                .filter((peer) => !this.pins.value.has(`tell:${peer}`))
                .map((peer) => this.threadRow(`tell:${peer}`, peer, '@'))}
            {this.dms.value.length === 0 &&
              !this.sectionHidden.value.has('dms') && (
                <p class="px-2 text-[10px] text-slate-600">no conversations</p>
              )}
          </div>
        </PanelSidebar>

        {/* message pane + composer */}
        <section class="flex min-w-0 flex-1 flex-col">
          <div class="flex min-h-0 flex-1 flex-col">
          <header class="flex h-10 shrink-0 items-center gap-2 border-b border-slate-800 px-4">
            {isSplit ? (
              <Dropdown
                class="font-semibold"
                title="pane channel"
                value={this.pane1Thread.value}
                onChange={(v) => this.setPane1Thread(v)}
                formatValue={(v) =>
                  (v === 'all' ? '≡ all'
                  : v.startsWith('custom:') ? `≡ ${v.slice(7)}`
                  : PRESET_THREADS[v] ? `≡ ${v}`
                  : `# ${v}`) + ' ▾'
                }
                options={[
                  { value: 'chat', label: '≡ chat' },
                  { value: 'log', label: '≡ log' },
                  { value: 'all', label: '≡ all' },
                  ...CHANNELS.map((c) => ({
                    value: c.key,
                    label: `#${c.label}`,
                  })),
                  ...this.api.chatCustom.value.map((c) => ({
                    value: `custom:${c.name}`,
                    label: `≡${c.name}`,
                  })),
                ]}
              />
            ) : (
              <>
                <span class="text-slate-500">{icon}</span>
                <h2 class="text-sm font-semibold">{label}</h2>
                {/* pin lives here, next to the name — rows never move
                    unless the user pins them */}
                <button
                  class={cn(
                    'text-[11px] leading-none',
                    this.pins.value.has(thread)
                      ? 'text-sky-300'
                      : 'text-slate-600 hover:text-slate-300',
                  )}
                  title={
                    this.pins.value.has(thread)
                      ? 'unpin'
                      : 'pin to top of sidebar'
                  }
                  onClick={() => this.togglePin(thread)}
                >
                  {this.pins.value.has(thread) ? (
                    <PinOff size={11} />
                  ) : (
                    <Pin size={11} />
                  )}
                </button>
              </>
            )}
            <div class="ml-auto flex items-center gap-1">
              {/* clear history — real threads only; 'all'/custom are
                  merged views, clearing them would be ambiguous */}
              {(isTell || CHANNELS.some((c) => c.key === thread)) && (
                <button
                  class="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-black/30 hover:text-slate-300"
                  title="clear this channel's history"
                  onClick={() => this.api.clearChat(thread)}
                >
                  clear
                </button>
              )}
              {/* wipe every thread — two clicks so it can't fire by
                  accident: first arms the confirm, second clears */}
              {isAll && (
                <button
                  class="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-black/30 hover:text-slate-300"
                  title="clear ALL chat history"
                  onClick={() => (this.clearAllArm.value = true)}
                >
                  clear all
                </button>
              )}
              <Input
                class="w-36"
                placeholder={
                  this.searchAll.value ? 'search all' : 'search'
                }
                value={this.searchQ.value}
                onInput={(e) =>
                  (this.searchQ.value = e.currentTarget.value)
                }
                onKeyDown={(e) => {
                  if (e.key === 'Escape') this.searchQ.value = '';
                }}
              />
            </div>
          </header>
          <MessageList
            messages={this.messages.value}
            newAt={this.dividerSeq.value}
            onDismiss={() => this.dismissNew()}
            query={this.searchQ.value.trim() || undefined}
            onOpenThread={
              mixed
                ? (t) => {
                    this.open(t);
                    // land in that channel, still filtered by the query
                    this.searchAll.value = false;
                  }
                : undefined
            }
          />
          </div>
          {isSplit && (
            <div class="flex min-h-0 flex-1 flex-col">
              <header class="flex h-10 shrink-0 items-center gap-2 border-y border-slate-800 px-4">
                <Dropdown
                  class="font-semibold"
                  title="split pane channel"
                  value={this.splitThread.value}
                  onChange={(v) => this.setSplitThread(v)}
                  formatValue={(v) =>
                    (v === 'all' ? '≡ all'
                    : v.startsWith('custom:') ? `≡ ${v.slice(7)}`
                    : PRESET_THREADS[v] ? `≡ ${v}`
                    : v.startsWith('tell:') ? `@ ${v.slice(5)}`
                    : `# ${v}`) + ' ▾'
                  }
                  options={[
                    { value: 'log', label: '≡ log' },
                    { value: 'chat', label: '≡ chat' },
                    { value: 'all', label: '≡ all' },
                    ...CHANNELS.map((c) => ({
                      value: c.key,
                      label: `#${c.label}`,
                    })),
                    ...this.api.chatCustom.value.map((c) => ({
                      value: `custom:${c.name}`,
                      label: `≡${c.name}`,
                    })),
                    ...this.dms.value.map((p) => ({
                      value: `tell:${p}`,
                      label: `@${p}`,
                    })),
                  ]}
                />
                <div class="ml-auto flex items-center gap-1">
                  <Input
                    class="w-36"
                    placeholder="search"
                    value={this.splitSearchQ.value}
                    onInput={(e) =>
                      (this.splitSearchQ.value = e.currentTarget.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') this.splitSearchQ.value = '';
                    }}
                  />
                </div>
              </header>
              <MessageList
                messages={this.splitMessages.value}
                query={this.splitSearchQ.value.trim() || undefined}
                onOpenThread={(t) => this.open(t)}
              />
            </div>
          )}
          <footer class="shrink-0 border-y border-slate-700 p-1.5">
            {canSend && this.markedPhrases(this.draft.value).length > 0 && (
              <div class="flex flex-wrap items-center gap-1 pb-1.5">
                <span class="text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                  auto-translate
                </span>
                {this.markedPhrases(this.draft.value).map((n, i) => (
                  <span
                    key={i}
                    class="rounded bg-sky-900/60 px-1.5 py-px text-[10px] text-sky-200"
                  >
                    <span class="text-green-400">{'{'}</span>
                    {n}
                    <span class="text-red-400">{'}'}</span>
                  </span>
                ))}
              </div>
            )}
            {canSend ? (
              <div class="flex">
                {targets && (
                  <Dropdown
                    class="shrink-0 rounded-r-none border-r-0"
                    title="send to"
                    value={this.sendChannel() ?? ''}
                    formatValue={(v) => `#${v} ▾`}
                    onChange={(v) => (this.sendTarget.value = v)}
                    options={targets.map((c) => ({
                      value: c,
                      label: `#${c}`,
                    }))}
                  />
                )}
                <div class="relative flex-1">
                  <Input
                    inputRef={(el) => {
                      this.inputEl = el;
                    }}
                    class={cn(
                      'rounded-r-none border-r-0 font-mono',
                      targets && 'rounded-l-none',
                    )}
                    placeholder={`message ${title} — tab completes auto-translate`}
                    value={this.draft.value}
                    onInput={(e) => this.onComposerInput(e)}
                    onKeyDown={(e) => this.onComposerKey(e)}
                    onFocus={() => this.dismissNew()}
                    onBlur={() => (this.suggest.value = null)}
                  />
                  {this.suggest.value && (
                    <div class="absolute bottom-full left-0 mb-1 w-72 overflow-hidden rounded-lg border border-slate-700 bg-black/30 shadow-xl">
                      <p class="px-2 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                        auto-translate · tab/enter accepts
                      </p>
                      {this.suggest.value.items.map((n, i) => (
                        <button
                          key={n}
                          class={cn(
                            'flex w-full items-baseline gap-1.5 px-2 py-1 text-left text-xs',
                            i === this.suggest.value!.index
                              // slate-50 flips dark in light mode —
                              // 'text-white' would vanish on the
                              // flipped slate-700 row
                              ? 'bg-black/40 text-slate-50'
                              : 'text-slate-300 hover:bg-black/30',
                          )}
                          // mousedown beats input blur so clicks still land
                          onMouseDown={(e) => {
                            e.preventDefault();
                            this.acceptPhrase(n);
                          }}
                        >
                          <span>
                            <span class="text-green-400">{'{'}</span>
                            <span class="text-red-400">{'}'}</span>
                          </span>
                          {n}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  class="h-8 rounded-l-none border border-input bg-card px-3 hover:bg-accent"
                  onClick={() => void this.send()}
                >
                  send
                </Button>
              </div>
            ) : (
              <p class="text-[11px] text-slate-500">
                read-only channel — incoming messages only
              </p>
            )}
            {this.error.value && (
              <p class="pt-1 text-[11px] text-rose-400">{this.error.value}</p>
            )}
          </footer>
        </section>

        {/* clear-all-history confirm */}
        {this.clearAllArm.value && (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            data-modal
            onClick={() => (this.clearAllArm.value = false)}
          >
            <div
              class="w-72 rounded border border-slate-600 bg-black/30 p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Clear all history
              </h3>
              <p class="text-xs text-slate-400">
                This wipes every channel's saved history — it can't be
                undone.
              </p>
              <div class="mt-3 flex justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => (this.clearAllArm.value = false)}
                >
                  cancel
                </Button>
                <Button
                  size="sm"
                  class="bg-red-800 hover:bg-red-700"
                  onClick={() => {
                    this.clearAllArm.value = false;
                    this.api.clearChat('*');
                  }}
                >
                  clear all
                </Button>
              </div>
            </div>
          </div>
        )}
        {/* new-direct-message dialog */}
        {this.dmOpen.value && (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            data-modal
            onClick={() => (this.dmOpen.value = false)}
          >
            <div
              class="w-72 rounded border border-slate-600 bg-black/30 p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                New message
              </h3>
              <Input
                autofocus
                placeholder="character name"
                value={this.dmName.value}
                onInput={(e) => (this.dmName.value = e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') this.startDm();
                  else if (e.key === 'Escape') this.dmOpen.value = false;
                }}
              />
              <div class="mt-3 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => (this.dmOpen.value = false)}
                >
                  cancel
                </Button>
                <Button size="sm" onClick={() => this.startDm()}>
                  open
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* custom filter channel editor */}
        {this.customOpen.value && (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            data-modal
            onClick={() => (this.customOpen.value = false)}
          >
            <div
              class="w-80 rounded border border-slate-600 bg-black/30 p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                {this.customEditing.value ? 'Edit channel' : 'New channel'}
              </h3>
              <Input
                autofocus
                placeholder="channel name"
                value={this.customName.value}
                onInput={(e) => (this.customName.value = e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void this.saveCustom();
                  else if (e.key === 'Escape') this.customOpen.value = false;
                }}
              />
              <p class="pt-3 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                include messages from
              </p>
              <div class="grid grid-cols-2 gap-x-3 gap-y-1">
                {CUSTOM_SOURCES.map((c) => (
                  <label
                    key={c.key}
                    class="flex items-center gap-1.5 text-xs text-slate-300"
                  >
                    <input
                      type="checkbox"
                      checked={!!this.customPicks.value[c.key]}
                      onChange={(e) =>
                        (this.customPicks.value = {
                          ...this.customPicks.value,
                          [c.key]: e.currentTarget.checked,
                        })
                      }
                    />
                    {c.label}
                  </label>
                ))}
              </div>
              <div class="mt-4 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => (this.customOpen.value = false)}
                >
                  cancel
                </Button>
                <Button size="sm" onClick={() => void this.saveCustom()}>
                  save
                </Button>
              </div>
            </div>
          </div>
        )}
      </PanelShell>
    );
  }
}
