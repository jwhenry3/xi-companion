/** composer draft → POST /api/command payload.
 *
 * windower.send_command takes the CONSOLE form — what you'd type after
 * `//` in the console — so a user-typed '//x' strips to 'x'. Client
 * ('/x') commands route through `input` so the game runs them as
 * native input (the same form the addon uses for its own game cmds).
 * Returns null for non-command drafts (they go through /api/chat). */
export function commandFromDraft(text: string): string | null {
  if (text.startsWith('//')) return text.slice(2);
  if (text.startsWith('/')) return `input ${text}`;
  return null;
}
