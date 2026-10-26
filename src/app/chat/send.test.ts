import { describe, expect, it } from 'vitest';
import { commandFromDraft } from './send';

describe('commandFromDraft', () => {
  it('strips // to the windower console form', () => {
    // the regression: send_command('//xicompanion status') silently
    // no-ops — the API takes 'xicompanion status' without slashes
    expect(commandFromDraft('//xicompanion status')).toBe(
      'xicompanion status',
    );
  });

  it('routes / commands through input', () => {
    expect(commandFromDraft('/say hi')).toBe('input /say hi');
    expect(commandFromDraft('/echo test')).toBe('input /echo test');
  });

  it('keeps auto-translate braces intact for the client', () => {
    expect(commandFromDraft('/say {Hello!}')).toBe('input /say {Hello!}');
  });

  it('returns null for plain chat', () => {
    expect(commandFromDraft('hi there')).toBeNull();
    expect(commandFromDraft('{Hello!} how are you')).toBeNull();
  });
});
