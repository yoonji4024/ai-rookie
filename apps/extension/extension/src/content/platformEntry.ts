/** Local UI preference only: no URLs, browsing history, or conversations are stored. */
export const SNOOZE_KEY = 'memflix.platform.snoozedOn';

export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function entryMode(input: {
  ready: boolean; visible: boolean; accepted: boolean; busy: boolean;
  today: string; snoozedOn: unknown;
}): 'hidden' | 'invite' | 'pet' {
  if (!input.ready) return 'hidden';
  // Never discard an active conversation because another tab changed a preference.
  if (input.busy || input.accepted) return 'pet';
  if (!input.visible || input.snoozedOn === input.today) return 'hidden';
  return 'invite';
}
