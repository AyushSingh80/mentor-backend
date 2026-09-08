/**
 * What a notification says, and when it stays quiet.
 *
 * The most valuable behaviour here is returning null. A push that says
 * "nothing to tell you" spends attention and returns none, and after a
 * fortnight of those the channel is dead for the one that matters.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NOTIFY_RULES,
  contentFor,
  morningBriefing,
  preShiftCheckpoint,
  weeklyAudit,
  type NotifyContext,
} from '../src/lib/notify-plan';
import { consistency } from '../src/lib/streaks';
import { activityByDay, dayRange } from '../src/lib/activity';

function state(activeDays: number, total = 28) {
  const days = dayRange('2026-09-30', total);
  return consistency({
    days: activityByDay(
      days.slice(0, activeDays).map((day) => ({
        kind: 'answer' as const,
        day,
        minuteOfDay: 540,
        weight: 1,
      })),
      days,
    ),
    studyDays: new Set<string>(),
  });
}

function ctx(overrides: Partial<NotifyContext> = {}): NotifyContext {
  return {
    revisionDue: 0,
    lecturesBehind: 0,
    unreadDigest: 0,
    drillsBanked: 6,
    mcqUnseen: 120,
    loggedToday: false,
    consistency: state(20),
    ...overrides,
  };
}

/* ------------------------------------------------------- morning briefing */

describe('morningBriefing', () => {
  it('stays silent when nothing is outstanding', () => {
    // A real and good state. Saying "nothing due" out loud is how a channel
    // gets muted before it ever carries something worth reading.
    assert.equal(morningBriefing(ctx()), null);
  });

  it('names the actual counts rather than a fixed sentence', () => {
    const content = morningBriefing(ctx({ revisionDue: 6, lecturesBehind: 2 }));
    assert.match(content?.body ?? '', /6 due for revision/);
    assert.match(content?.body ?? '', /2 lectures behind/);
  });

  it('orders them by urgency: revision, then digest, then backlog', () => {
    // Revision is time-sensitive and compounding; the digest goes stale; the
    // backlog is the one that waits.
    const body = morningBriefing(ctx({ revisionDue: 3, unreadDigest: 4, lecturesBehind: 5 }))?.body;
    assert.ok(body!.indexOf('revision') < body!.indexOf('digest'));
    assert.ok(body!.indexOf('digest') < body!.indexOf('behind'));
  });

  it('singularises one lecture', () => {
    assert.match(morningBriefing(ctx({ lecturesBehind: 1 }))?.body ?? '', /1 lecture behind/);
  });

  it('mentions only what is outstanding', () => {
    const body = morningBriefing(ctx({ revisionDue: 6 }))?.body ?? '';
    assert.doesNotMatch(body, /lecture|digest/);
  });
});

/* ------------------------------------------------------ pre-shift checkpoint */

describe('preShiftCheckpoint', () => {
  it('fires when nothing has been logged', () => {
    assert.notEqual(preShiftCheckpoint(ctx({ loggedToday: false })), null);
  });

  it('stays silent once she has logged today', () => {
    // Reminding her to do what she has done is the app not paying attention,
    // and one of those costs more trust than the reminder was worth.
    assert.equal(preShiftCheckpoint(ctx({ loggedToday: true })), null);
  });
});

/* ------------------------------------------------------------ weekly audit */

describe('weeklyAudit', () => {
  it('always fires, because a week with nothing in it is the week worth naming', () => {
    assert.notEqual(weeklyAudit(ctx({ consistency: state(0) })), null);
    assert.notEqual(weeklyAudit(ctx({ consistency: state(28) })), null);
  });

  it('opens with the rate when there is one', () => {
    assert.match(weeklyAudit(ctx({ consistency: state(20) })).body, /20 of 28 study days/);
  });

  it('does not invent a rate before there is history', () => {
    const body = weeklyAudit(ctx({ consistency: state(2, 3) })).body;
    assert.match(body, /First look/);
    assert.doesNotMatch(body, /0 of/);
  });

  it('names a thin bank and an empty drill bank', () => {
    const body = weeklyAudit(ctx({ mcqUnseen: 12, drillsBanked: 0 })).body;
    assert.match(body, /12 questions left/);
    assert.match(body, /no drill prompts banked/);
  });

  it('says nothing about a healthy bank', () => {
    const body = weeklyAudit(ctx({ mcqUnseen: 300, drillsBanked: 10 })).body;
    assert.doesNotMatch(body, /questions left|drill prompts/);
  });
});

/* ------------------------------------------------------------- the shared */

describe('every body', () => {
  it('fits inside the notification shade', () => {
    const cases = [
      morningBriefing(ctx({ revisionDue: 999, lecturesBehind: 999, unreadDigest: 999 })),
      preShiftCheckpoint(ctx()),
      weeklyAudit(ctx({ mcqUnseen: 0, drillsBanked: 0, lecturesBehind: 42 })),
    ];
    for (const content of cases) {
      assert.ok(
        (content?.body.length ?? 0) <= NOTIFY_RULES.maxBodyChars,
        `"${content?.body}" is ${content?.body.length} chars`,
      );
    }
  });

  it('carries a title as well as a body', () => {
    for (const content of [morningBriefing(ctx({ revisionDue: 1 })), preShiftCheckpoint(ctx()), weeklyAudit(ctx())]) {
      assert.notEqual(content?.title.trim(), '');
    }
  });
});

describe('contentFor', () => {
  it('maps every derived id to a builder', () => {
    // `deriveNotifications` in `lib/schedule.ts` emits exactly these three. An
    // id with no builder is a notification that silently never fires.
    for (const id of ['morning-briefing', 'pre-shift-checkpoint', 'weekly-audit'] as const) {
      const content = contentFor(id, ctx({ revisionDue: 3, loggedToday: false }));
      assert.notEqual(content, null, `${id} has no builder`);
    }
  });

  it('passes the skip decision through rather than inventing content', () => {
    assert.equal(contentFor('morning-briefing', ctx()), null);
    assert.equal(contentFor('pre-shift-checkpoint', ctx({ loggedToday: true })), null);
  });
});
