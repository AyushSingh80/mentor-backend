/**
 * What a notification should SAY, and whether to send it at all.
 *
 * Pure. No `expo-notifications`, no clock of its own — `lib/notifications.ts`
 * does the scheduling and this decides the content. Split so the decision is
 * testable under Node, where the native module cannot load.
 *
 * ## Why the bodies are built rather than fixed
 *
 * `deriveNotifications` in `lib/schedule.ts` carries a placeholder body —
 * "Today's targets, revision due, and one question to attempt." A notification
 * that says the same thing every morning is one she swipes away without
 * reading, and after a fortnight the channel is dead for anything that matters.
 * "6 cards due, 2 lectures behind" is a different object: it is information,
 * and it is the same information she would have opened the app to get.
 *
 * ## Why a notification can decline to fire
 *
 * The most valuable thing this module does is return null. A morning briefing
 * with nothing due is a push notification that says "nothing to tell you",
 * which is worse than silence — it spends attention and returns none. The
 * pre-shift checkpoint is the sharpest case: if she has already logged the
 * morning, reminding her to log it is the app not paying attention.
 */

import type { Consistency } from '@/lib/streaks';

export const NOTIFY_RULES = {
  /**
   * Never more than this many in a day, whatever the derivation says.
   *
   * Three is already the ceiling `deriveNotifications` produces, and this is
   * the backstop rather than the policy: a future feature that adds a fourth
   * should have to change this line and read why it is here.
   */
  maxPerDay: 3,
  /** Body length before Android truncates it in the shade. */
  maxBodyChars: 160,
} as const;

/** What the app knows when a notification is about to be built. */
export interface NotifyContext {
  /** Cards and topics due today. */
  revisionDue: number;
  /** Whole lectures behind, from the Phase 2 tracker. */
  lecturesBehind: number;
  /** Unread current-affairs items inside the catch-up window. */
  unreadDigest: number;
  /** Banked drill prompts. Zero means the bank is empty, not that none exist. */
  drillsBanked: number;
  /** Unseen MCQs. */
  mcqUnseen: number;
  /** True once anything has been recorded for today. */
  loggedToday: boolean;
  /** For the weekly audit's opening line. */
  consistency: Consistency;
}

export interface NotifyContent {
  title: string;
  body: string;
}

function clamp(body: string): string {
  return body.length <= NOTIFY_RULES.maxBodyChars
    ? body
    : `${body.slice(0, NOTIFY_RULES.maxBodyChars - 1).trimEnd()}…`;
}

/**
 * The morning briefing, or null.
 *
 * Lists only what is actually outstanding, in the order the day should take
 * them: revision first because it is time-sensitive and compounding, then the
 * digest because it goes stale, then the backlog. Returns null when there is
 * nothing outstanding at all, which is a real and good state.
 */
export function morningBriefing(ctx: NotifyContext): NotifyContent | null {
  const parts: string[] = [];

  if (ctx.revisionDue > 0) {
    parts.push(`${ctx.revisionDue} due for revision`);
  }
  if (ctx.unreadDigest > 0) {
    parts.push(`${ctx.unreadDigest} unread in the digest`);
  }
  if (ctx.lecturesBehind > 0) {
    parts.push(`${ctx.lecturesBehind} ${ctx.lecturesBehind === 1 ? 'lecture' : 'lectures'} behind`);
  }

  if (parts.length === 0) return null;

  return {
    title: 'This morning',
    body: clamp(`${parts.join(' · ')}.`),
  };
}

/**
 * The pre-shift checkpoint, or null.
 *
 * Fires before she leaves for a 2:30pm shift, and its whole job is to catch the
 * morning while it is still recallable. Silent once she has logged anything
 * today: reminding her to do what she has done is the app not paying attention,
 * and one such notification costs more trust than the reminder was worth.
 */
export function preShiftCheckpoint(ctx: NotifyContext): NotifyContent | null {
  if (ctx.loggedToday) return null;

  return {
    title: 'Before your shift',
    body: clamp(
      'Two minutes: log what you actually finished this morning. It is the input to everything the app tells you later.',
    ),
  };
}

/**
 * The weekly audit.
 *
 * Never null. This one always fires, because its job is the review she would
 * otherwise skip, and a week with nothing in it is precisely the week worth
 * being told about.
 */
export function weeklyAudit(ctx: NotifyContext): NotifyContent {
  const state = ctx.consistency;

  const opener =
    state.adherence === null
      ? 'First look at the week'
      : `${state.activeDaysInWindow} of ${state.studyDaysInWindow} study days`;

  const parts: string[] = [];
  if (ctx.lecturesBehind > 0) parts.push(`${ctx.lecturesBehind} lectures behind`);
  if (ctx.mcqUnseen < 40) parts.push(`${ctx.mcqUnseen} questions left in the bank`);
  if (ctx.drillsBanked === 0) parts.push('no drill prompts banked');

  return {
    title: 'Weekly audit',
    body: clamp(
      parts.length === 0
        ? `${opener}. Coverage, score trend and next week.`
        : `${opener}. ${parts.join(' · ')}.`,
    ),
  };
}

export type NotificationId = 'morning-briefing' | 'pre-shift-checkpoint' | 'weekly-audit';

/**
 * Content for one notification id, or null to skip it.
 *
 * The single place that maps an id to its builder, so a new notification cannot
 * be scheduled without someone deciding what it says and when it stays quiet.
 */
export function contentFor(id: NotificationId, ctx: NotifyContext): NotifyContent | null {
  switch (id) {
    case 'morning-briefing':
      return morningBriefing(ctx);
    case 'pre-shift-checkpoint':
      return preShiftCheckpoint(ctx);
    case 'weekly-audit':
      return weeklyAudit(ctx);
    default:
      return null;
  }
}
