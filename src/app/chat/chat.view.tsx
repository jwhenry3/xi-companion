// Discord-style unified chat: game channels on the left, tells as DMs,
// message pane + composer on the right. Traffic arrives via the addon's
// incoming-packet interceptor (SSE 'chat' events); sends go through
// `input /<cmd>` — the same path as the game's chat line.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import { AddonApi } from '../core/addon-api.service';
import type { ChatMessage } from '../core/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ChannelDef {
  key: string;
  label: string;
  readonly?: boolean;
}

const CHANNELS: ChannelDef[] = [
  { key: 'party', label: 'party' },
  { key: 'say', label: 'say' },
  { key: 'shout', label: 'shout' },
  { key: 'yell', label: 'yell' },
  { key: 'linkshell', label: 'linkshell' },
  { key: 'linkshell2', label: 'linkshell2' },
  { key: 'unity', label: 'unity' },
  { key: 'emote', label: 'emote' },
  { key: 'assist', label: 'assist', readonly: true },
];

const READONLY = new Set(CHANNELS.filter((c) => c.readonly).map((c) => c.key));

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
    out.push(
      <span key={o}>
        <span class="text-green-400">{'{'}</span>
        {inner}
        <span class="text-red-400">{'}'}</span>
      </span>,
    );
    i = e + 1;
  }
  out.push(text.slice(i));
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

function MessageList({ messages }: { messages: ChatMessage[] }) {
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
    >
      {messages.length === 0 && (
        <p class="py-8 text-center text-xs text-slate-500">no messages yet</p>
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        // group consecutive same-sender messages within 5min, discord-style
        const grouped =
          prev &&
          prev.sender === m.sender &&
          prev.channel === m.channel &&
          (m.ts ?? 0) - (prev.ts ?? 0) < 300;
        return (
          <div key={m.seq} class={grouped ? 'pl-14' : 'pt-1.5'}>
            {!grouped && (
              <div class="flex items-baseline gap-2">
                <span class="text-xs font-semibold" style={nameColor(m.sender)}>
                  {m.sender ?? (m.channel === 'assist' ? 'assist' : '?')}
                </span>
                <span class="text-[10px] text-slate-500">{fmtTime(m.ts)}</span>
              </div>
            )}
            <div
              class={cn(
                'break-words text-sm leading-snug text-slate-200',
                m.self && 'text-slate-300',
              )}
            >
              {renderAtText(m.text)}
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
  private error = signal<string | null>(null);
  private phrases = signal<string[] | null>(null);
  private phraseSet = new Set<string>();
  private suggest = signal<{ items: string[]; index: number } | null>(null);
  private inputEl: HTMLInputElement | null = null;
  private mirrorEl: HTMLDivElement | null = null;

  onInit() {
    void this.api.refreshChat();
    void this.ensurePhrases();
    // another window (e.g. the map's player → tell action) hands us a
    // thread through localStorage — consume it on boot and on change
    const pending = localStorage.getItem('xic.chat.thread');
    if (pending) {
      localStorage.removeItem('xic.chat.thread');
      this.open(pending);
    }
    window.addEventListener('storage', this.onStorage);
  }

  onDestroy() {
    window.removeEventListener('storage', this.onStorage);
  }

  private onStorage = (e: StorageEvent) => {
    if (e.key === 'xic.chat.thread' && e.newValue) {
      localStorage.removeItem('xic.chat.thread');
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

  private messages = computed(() =>
    this.api.chat.value.filter(
      (m) => this.api.chatThread(m) === this.api.activeChat.value,
    ),
  );

  private open(thread: string) {
    this.api.activeChat.value = thread;
    this.api.markChatRead(thread);
  }

  private startDm() {
    const name = this.dmName.value.trim();
    if (!name) return;
    this.dmName.value = '';
    this.dmOpen.value = false;
    this.open(`tell:${name}`);
  }

  private async send() {
    const text = this.draft.value.trim();
    if (!text) return;
    const thread = this.api.activeChat.value;
    this.draft.value = '';
    this.suggest.value = null;
    this.error.value = null;
    try {
      if (thread.startsWith('tell:')) {
        await this.api.sendChat('tell', text, thread.slice(5));
      } else {
        await this.api.sendChat(thread, text);
      }
    } catch (e) {
      this.error.value = String(e);
    }
  }

  private threadRow(key: string, label: string, icon: string) {
    const active = this.api.activeChat.value === key;
    const unread = this.api.chatUnread.value[key] ?? 0;
    return (
      <button
        key={key}
        class={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm',
          active ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
        )}
        onClick={() => this.open(key)}
      >
        <span class="text-slate-500">{icon}</span>
        <span class="min-w-0 flex-1 truncate">{label}</span>
        {unread > 0 && (
          <span class="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    );
  }

  render() {
    const thread = this.api.activeChat.value;
    const isTell = thread.startsWith('tell:');
    const chan = isTell ? 'tell' : thread;
    const ro = READONLY.has(chan);
    const title = isTell ? `@ ${thread.slice(5)}` : `# ${chan}`;

    return (
      <div class="flex h-full min-h-0 overflow-hidden rounded border border-slate-800 bg-slate-900">
        {/* channel / DM sidebar */}
        <aside class="flex w-48 shrink-0 flex-col border-r border-slate-800 bg-slate-950/60">
          <div class="flex-1 overflow-y-auto p-2">
            <p class="px-2 pb-1 pt-1 text-[10px] font-semibold tracking-wider text-slate-500">
              CHANNELS
            </p>
            {CHANNELS.map((c) => this.threadRow(c.key, c.label, '#'))}
            <div class="mt-3 flex items-center justify-between px-2 pb-1">
              <p class="text-[10px] font-semibold tracking-wider text-slate-500">
                DIRECT MESSAGES
              </p>
              <button
                class="text-xs text-slate-500 hover:text-slate-200"
                title="new tell"
                onClick={() => (this.dmOpen.value = !this.dmOpen.value)}
              >
                +
              </button>
            </div>
            {this.dms.value.map((peer) =>
              this.threadRow(`tell:${peer}`, peer, '@'),
            )}
            {this.dms.value.length === 0 && (
              <p class="px-2 text-[10px] text-slate-600">no conversations</p>
            )}
          </div>
        </aside>

        {/* message pane + composer */}
        <section class="flex min-w-0 flex-1 flex-col">
          <header class="flex h-10 shrink-0 items-center gap-2 border-b border-slate-800 px-4">
            <span class="text-slate-500">{isTell ? '@' : '#'}</span>
            <h2 class="text-sm font-semibold">{isTell ? thread.slice(5) : chan}</h2>
            {ro && <span class="text-[10px] text-slate-500">read only</span>}
          </header>
          <MessageList messages={this.messages.value} />
          <footer class="shrink-0 border-t border-slate-800 p-3">
            {ro ? (
              <p class="text-xs text-slate-500">
                assist messages are generated by the game — you can't post here
              </p>
            ) : (
              <div class="flex gap-2">
                <div class="relative flex-1">
                  {/* colorized copy behind the transparent-text input —
                      clip region matches the input's content box (1px
                      border + px-2.5) so scrolled text aligns */}
                  <div
                    aria-hidden="true"
                    class="pointer-events-none absolute inset-y-0 left-[11px] right-px flex items-center overflow-hidden"
                  >
                    <div
                      ref={(el) => {
                        this.mirrorEl = el;
                      }}
                      class="shrink-0 whitespace-pre text-sm"
                    >
                      {renderAtText(
                        this.draft.value,
                        this.phrases.value ? this.phraseSet : undefined,
                      )}
                    </div>
                  </div>
                  <Input
                    inputRef={(el) => {
                      this.inputEl = el;
                    }}
                    class="w-full text-transparent caret-slate-200"
                    placeholder={`message ${title} — tab completes auto-translate`}
                    value={this.draft.value}
                    onInput={(e) => this.onComposerInput(e)}
                    onKeyDown={(e) => this.onComposerKey(e)}
                    onScroll={(e) => {
                      const p = this.mirrorEl?.parentElement;
                      if (p) p.scrollLeft = e.currentTarget.scrollLeft;
                    }}
                    onBlur={() => (this.suggest.value = null)}
                  />
                  {this.suggest.value && (
                    <div class="absolute bottom-full left-0 mb-1 w-72 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
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
                              ? 'bg-slate-700 text-slate-50'
                              : 'text-slate-300 hover:bg-slate-800',
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
                <Button size="sm" onClick={() => void this.send()}>
                  send
                </Button>
              </div>
            )}
            {this.markedPhrases(this.draft.value).length > 0 && (
              <div class="flex flex-wrap items-center gap-1 pt-1.5">
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
            {this.error.value && (
              <p class="pt-1 text-[11px] text-rose-400">{this.error.value}</p>
            )}
          </footer>
        </section>

        {/* new-direct-message dialog */}
        {this.dmOpen.value && (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            data-modal
            onClick={() => (this.dmOpen.value = false)}
          >
            <div
              class="w-72 rounded border border-slate-600 bg-slate-900 p-4 shadow-xl"
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
      </div>
    );
  }
}
