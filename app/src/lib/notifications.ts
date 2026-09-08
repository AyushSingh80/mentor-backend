/**
 * Scheduling the derived notifications with the OS.
 *
 * `lib/schedule.ts` decides WHEN (and asserts none can fire during her shift),
 * `lib/notify-plan.ts` decides WHAT and whether to fire at all, and this file
 * is the only thing that touches `expo-notifications`. That split is what makes
 * the first two testable under Node, where the native module cannot load.
 *
 * ## Why a daily trigger and not a background task
 *
 * The recurring decision in this app, and the same answer as `drill/index.tsx`,
 * `current/index.tsx` and `practice/index.tsx`: Android background execution is
 * throttled or silently disabled by most OEM battery managers, so anything that
 * depends on it fails on the devices it was written for.
 *
 * The consequence here is a real trade-off rather than a free win. A `DAILY`
 * OS trigger fires reliably without the app running, but its body is fixed at
 * SCHEDULING time — so "6 cards due" is the count from whenever the schedule
 * was last rebuilt, not from this morning. That is why `refreshNotifications`
 * is called on every foreground: the numbers are then at most one app-open
 * stale, which for a morning briefing means yesterday evening at worst.
 *
 * A wrong number in a notification is worse than a vague one, so the bodies
 * built in `notify-plan.ts` are deliberately about STOCK ("6 due for revision")
 * rather than events, because stock changes slowly and a day-old stock figure
 * is still true enough to act on.
 *
 * ## Nothing here throws
 *
 * Permission can be refused, the module can be unavailable on a simulator, and
 * neither is a reason to break the screen that called it. Every function
 * returns a result instead.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { deriveNotifications, notificationsRespectWorkHours, type ScheduleProfile } from '@/lib/schedule';
import { contentFor, type NotificationId, type NotifyContext } from '@/lib/notify-plan';

/** Android needs a channel before anything is delivered. */
const CHANNEL_ID = 'study';

export interface ScheduleResult {
  scheduled: number;
  /** Ids deliberately skipped because there was nothing worth saying. */
  skipped: NotificationId[];
  /** Always populated. "Nothing happened" must be explicable on screen. */
  reason: string;
  granted: boolean;
}

/**
 * Asks for permission. Never throws.
 *
 * Deliberately NOT called at launch. A permission prompt on first open, before
 * she has seen what the app does, is the one most reliably denied — and on
 * Android a denial is sticky. It is called from the notifications screen, after
 * she has chosen to turn them on.
 */
export async function requestPermission(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return true;
    if (!existing.canAskAgain) return false;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

export async function hasPermission(): Promise<boolean> {
  try {
    return (await Notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Study reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
      // No sound and no vibration. These fire at 07:45 and before a shift; a
      // buzz would make them an interruption rather than a note on the shade,
      // and an interruption is what gets a channel muted.
      sound: null,
      vibrationPattern: null,
      enableVibrate: false,
    });
  } catch {
    // A channel that cannot be created means delivery may be silent. Not a
    // reason to abandon scheduling — the OS falls back to a default channel.
  }
}

/** Clears everything this app scheduled. Never throws. */
export async function cancelAll(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // Nothing scheduled, or the module is unavailable. Both are fine.
  }
}

/**
 * Rebuilds the whole schedule from the profile and the current counts.
 *
 * Cancel-then-reschedule rather than diffing, because the alternative is
 * tracking OS identifiers across a profile edit and a reinstall, and a stale
 * identifier means a notification that cannot be cancelled — one that fires
 * during her shift after she has changed her hours, which is the exact failure
 * `notificationsRespectWorkHours` exists to prevent.
 */
export async function refreshNotifications(
  profile: ScheduleProfile,
  ctx: NotifyContext,
): Promise<ScheduleResult> {
  const granted = await hasPermission();
  if (!granted) {
    return {
      scheduled: 0,
      skipped: [],
      granted: false,
      reason: 'Notifications are off. Nothing is scheduled.',
    };
  }

  const derived = deriveNotifications(profile);

  // The Phase 0 guard, enforced at the point of scheduling and not only in a
  // test. A profile edit that moved her shift could otherwise produce a valid
  // derivation for the OLD hours and fire it during the new ones.
  const guard = notificationsRespectWorkHours(profile, derived);
  if (!guard.ok) {
    await cancelAll();
    return {
      scheduled: 0,
      skipped: [],
      granted: true,
      reason: `Nothing scheduled: ${guard.violations.length} reminder${
        guard.violations.length === 1 ? '' : 's'
      } would have fired during your shift. Check your hours in onboarding.`,
    };
  }

  await ensureChannel();
  await cancelAll();

  const skipped: NotificationId[] = [];
  let scheduled = 0;

  for (const entry of derived) {
    const id = entry.id as NotificationId;
    const content = contentFor(id, ctx);
    if (content === null) {
      skipped.push(id);
      continue;
    }

    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: content.title,
          body: content.body,
          data: { id },
          ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
        },
        trigger:
          entry.dayOfWeek === null
            ? {
                type: Notifications.SchedulableTriggerInputTypes.DAILY,
                hour: Math.floor(entry.minutes / 60),
                minute: entry.minutes % 60,
              }
            : {
                type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
                // `expo-notifications` weekday is 1-7 with Sunday = 1, where
                // `DerivedNotification.dayOfWeek` is JS's 0-6 with Sunday = 0.
                // Off by one here means the weekly audit lands on the wrong day
                // and nothing ever reports it.
                weekday: entry.dayOfWeek + 1,
                hour: Math.floor(entry.minutes / 60),
                minute: entry.minutes % 60,
              },
      });
      scheduled += 1;
    } catch {
      // One failed schedule must not abandon the rest.
      skipped.push(id);
    }
  }

  return {
    scheduled,
    skipped,
    granted: true,
    reason:
      scheduled === 0
        ? 'Nothing outstanding, so nothing was scheduled. That is a good state, not a failure.'
        : `${scheduled} reminder${scheduled === 1 ? '' : 's'} scheduled${
            skipped.length > 0 ? `, ${skipped.length} skipped as there was nothing to say` : ''
          }.`,
  };
}

/** What is actually queued with the OS, for the settings screen. */
export async function scheduledCount(): Promise<number> {
  try {
    return (await Notifications.getAllScheduledNotificationsAsync()).length;
  } catch {
    return 0;
  }
}
