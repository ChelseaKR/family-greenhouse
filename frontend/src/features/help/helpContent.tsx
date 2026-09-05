import { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Help content, hand-written and hand-verified against the shipped product.
 *
 * Rules for editing this file, in order of importance:
 *
 * 1. Every answer must be true of what is deployed. If you are not sure how
 *    something behaves, read the code; if the code does not settle it, leave
 *    the answer out. An overselling help page turns a confused user into an
 *    angry one, which is worse than no page at all.
 * 2. `text` is a plain-text rendering of `a`, and it must SAY THE SAME THING.
 *    It feeds both the search filter and the FAQPage structured data that
 *    HelpTopicPage publishes, so a `text` that drifts from `a` publishes a
 *    wrong answer to search engines under a right-looking question.
 * 3. `id` is a URL fragment that ships in support replies and search results.
 *    Adding is free; renaming breaks other people's links.
 *
 * Deliberately NOT documented here, and why:
 *
 * - Trial state in Settings. Subscriptions really are created with a 14-day
 *   trial (`trial_period_days: 14` in backend/src/services/billing.ts), so the
 *   trial itself is safe to describe. How it is *displayed* is not: on main,
 *   `checkout.session.completed` writes a hardcoded `status: 'active'` for a
 *   subscription whose real status is `trialing`, and whichever Stripe event
 *   lands last wins. The branch `fix/trial-status-from-stripe` changes this.
 *   Until it lands, no answer here promises what the plan card will say during
 *   a trial, or that a trial-end date is shown.
 * - The calendar (.ics) feed. `GET /me/calendar.ics` sits behind the Cognito
 *   JWT authorizer and the URL offered in Settings carries no credential, so
 *   there is no evidence a calendar app can subscribe to it. Documenting it
 *   would send people to a broken flow.
 * - Native push notifications. Device tokens are captured but nothing sends to
 *   them, and the settings UI hides the controls on purpose.
 */

export const SUPPORT_EMAIL = 'support@familygreenhouse.net';

export interface HelpArticle {
  /** Stable URL fragment. Never rename one that has shipped. */
  id: string;
  q: string;
  a: ReactNode;
  /** Plain-text twin of `a`. Feeds search and the FAQPage JSON-LD. */
  text: string;
}

export interface HelpSection {
  id: string;
  title: string;
  description: string;
  articles: HelpArticle[];
  /**
   * Hidden inside the iOS/Android shells. The store builds neither sell plans
   * nor link out to a payment flow, so purchase instructions there are an
   * answer to a question the app cannot act on.
   */
  webOnly?: boolean;
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description: 'Your first plant, and what the app does with it.',
    articles: [
      {
        id: 'add-first-plant',
        q: 'How do I add my first plant?',
        a: (
          <>
            <p>
              Open <strong>Plants</strong> and choose <strong>Add plant</strong>. Give it a name,
              start typing a species to pick one from the suggestions, and optionally add a photo
              and a space (&ldquo;kitchen window&rdquo;).
            </p>
            <p>
              Picking a species from the suggestion list is the step that matters. It is what wires
              up the care guide, the pet-toxicity note, and a suggested care schedule. A species you
              type freehand saves perfectly well, but it stays just a label.
            </p>
          </>
        ),
        text: 'Open Plants and choose Add plant. Give it a name, start typing a species to pick one from the suggestions, and optionally add a photo and a space such as kitchen window. Picking a species from the suggestion list is the step that matters: it is what wires up the care guide, the pet-toxicity note, and a suggested care schedule. A species you type freehand saves fine but stays just a label.',
      },
      {
        id: 'auto-care-tasks',
        q: 'Why did (or didn’t) my new plant get care tasks automatically?',
        a: (
          <>
            <p>
              When you add a plant with <strong>Add suggested care tasks</strong> ticked and a
              recognised species, we set up a routine for you:
            </p>
            <ul>
              <li>
                If the species matches one of our curated care bundles (tropical houseplant,
                succulent or cactus, and so on), you get that whole bundle — typically watering,
                fertilising and pruning on sensible intervals.
              </li>
              <li>
                If it doesn&rsquo;t match a bundle but our species data has a watering cadence, you
                get a single watering task on that cadence.
              </li>
              <li>
                If the species is freehand text, or the species data has no watering cadence, you
                get nothing automatically.
              </li>
            </ul>
            <p>
              You can always add tasks by hand from the plant&rsquo;s page — nothing here is
              required.
            </p>
          </>
        ),
        text: 'When you add a plant with Add suggested care tasks ticked and a recognised species, we set up a routine. If the species matches one of our curated care bundles such as tropical houseplant or succulent and cactus, you get that whole bundle, typically watering, fertilising and pruning. If it does not match a bundle but our species data has a watering cadence, you get a single watering task on that cadence. If the species is freehand text, or the species data has no watering cadence, you get nothing automatically. You can always add tasks by hand from the plant page.',
      },
      {
        id: 'no-care-guide',
        q: 'Why does my plant have no care guide?',
        a: (
          <>
            <p>
              Care guides come from an external species database, and they only appear for plants
              saved with a species we recognised — that is, one you picked from the autocomplete
              rather than typed freehand.
            </p>
            <p>
              To fix it, edit the plant and re-pick the species from the suggestion list. If the
              species genuinely isn&rsquo;t in the database, there is no guide to show, and we
              won&rsquo;t invent one.
            </p>
          </>
        ),
        text: 'Care guides come from an external species database and only appear for plants saved with a species we recognised, meaning one picked from the autocomplete rather than typed freehand. To fix it, edit the plant and re-pick the species from the suggestion list. If the species is not in the database there is no guide to show, and we will not invent one.',
      },
      {
        id: 'search-shortcut',
        q: 'Is there a keyboard shortcut for search?',
        a: (
          <p>
            Inside the app, press <kbd>⌘K</kbd> on a Mac or <kbd>Ctrl</kbd>+<kbd>K</kbd> elsewhere.
            It searches your plants (by name, species and location) and your tasks (by plant name,
            task type and notes), showing up to eight of each. Press Enter on a result to jump to
            it.
          </p>
        ),
        text: 'Inside the app, press Command-K on a Mac or Ctrl-K elsewhere. It searches your plants by name, species and location, and your tasks by plant name, task type and notes, showing up to eight of each. Press Enter on a result to jump to it.',
      },
    ],
  },

  {
    id: 'plants',
    title: 'Plants and photos',
    description: 'Photos, limits, importing, and what happens when a plant dies.',
    articles: [
      {
        id: 'photo-requirements',
        q: 'What photo formats and sizes can I upload?',
        a: (
          <p>
            JPEG, PNG or WebP, up to 5 MB — and the app shrinks large photos in your browser before
            uploading, so most phone photos are fine as they come. If an upload is interrupted, the
            plant is still saved and no broken image is attached; retry from the plant&rsquo;s page.
          </p>
        ),
        text: 'JPEG, PNG or WebP, up to 5 MB. The app shrinks large photos in your browser before uploading, so most phone photos are fine as they come. If an upload is interrupted the plant is still saved and no broken image is attached; retry from the plant page.',
      },
      {
        id: 'plant-limit',
        q: 'I’ve hit my plant limit. What now?',
        a: (
          <>
            <p>
              The cap counts <em>active</em> plants only. Plants you have archived, or marked as
              died or given away, do not count against it — so archiving a plant you are no longer
              caring for frees a slot immediately, and keeps all of its history.
            </p>
            <p>
              The caps are 20 plants on the free Seedling plan, 200 on Garden and 5,000 on
              Greenhouse. Nothing is ever deleted for being over a cap; you just can&rsquo;t add
              more until you are back under it. A household that was already above a cap when it
              changed keeps every plant it has.
            </p>
          </>
        ),
        text: 'The cap counts active plants only. Plants you have archived, or marked as died or given away, do not count against it, so archiving a plant you are no longer caring for frees a slot immediately and keeps all of its history. The caps are 20 plants on the free Seedling plan, 200 on Garden and 5,000 on Greenhouse. Nothing is ever deleted for being over a cap; you just cannot add more until you are back under it. A household that was already above a cap when it changed keeps every plant it has.',
      },
      {
        id: 'plant-died',
        q: 'One of my plants died. Should I delete it?',
        a: (
          <>
            <p>Probably not. A plant can be in one of four states:</p>
            <ul>
              <li>
                <strong>Active</strong> — being cared for.
              </li>
              <li>
                <strong>Archived</strong> — a neutral, reversible &ldquo;not right now&rdquo;.
              </li>
              <li>
                <strong>Died</strong> or <strong>given away</strong> — a recorded outcome.
              </li>
            </ul>
            <p>
              All three non-active states drop the plant out of your default list, out of your plan
              limit, and out of the reminder scan — so you stop being nagged about it — while
              keeping its photos and care history. Deleting is a hard delete, meant for genuine
              mistakes, and it takes the history with it.
            </p>
          </>
        ),
        text: 'Probably not. A plant can be active (being cared for), archived (a neutral, reversible not-right-now), or marked died or given away as a recorded outcome. All three non-active states drop the plant out of your default list, out of your plan limit, and out of the reminder scan, so you stop being nagged about it, while keeping its photos and care history. Deleting is a hard delete meant for genuine mistakes, and it takes the history with it.',
      },
      {
        id: 'import-plants',
        q: 'Can I import a lot of plants at once?',
        a: (
          <p>
            Yes — <strong>Plants → Import</strong> takes a CSV or JSON file, up to 100 plants per
            import with up to 10 care tasks each. An import is partial-success by design: if you hit
            your plan&rsquo;s plant limit part-way through, the rows already created are kept, the
            rest are reported as skipped, and you are told which. Run it again after freeing space
            and only the skipped rows need re-adding.
          </p>
        ),
        text: 'Yes. Plants then Import takes a CSV or JSON file, up to 100 plants per import with up to 10 care tasks each. An import is partial-success by design: if you hit your plan plant limit part-way through, the rows already created are kept, the rest are reported as skipped, and you are told which. Run it again after freeing space and only the skipped rows need re-adding.',
      },
      {
        id: 'identify-photo',
        q: 'How does identifying a plant from a photo work, and is it limited?',
        a: (
          <>
            <p>
              On the Add plant screen, <strong>Identify from photo</strong> sends one photo to an
              external identification service and offers up to five suggestions with a confidence
              percentage. Accepting one fills in the species field for you.
            </p>
            <p>
              It is metered per household, per calendar month, and resets on the 1st:{' '}
              <strong>1 identification on Seedling, 30 on Garden, 100 on Greenhouse</strong>. The
              app does not show a running count, so the first you&rsquo;ll hear of the limit is a
              message when you reach it. An attempt is counted even if the service then fails, so a
              timeout can still use one.
            </p>
            <p>
              If the feature isn&rsquo;t configured on the server you&rsquo;ll see &ldquo;Photo
              identification is unavailable right now&rdquo; and can still type the species in
              yourself.
            </p>
          </>
        ),
        text: 'On the Add plant screen, Identify from photo sends one photo to an external identification service and offers up to five suggestions with a confidence percentage. Accepting one fills in the species field. It is metered per household per calendar month and resets on the 1st: 1 identification on Seedling, 30 on Garden, 100 on Greenhouse. The app does not show a running count, so the first you will hear of the limit is a message when you reach it. An attempt is counted even if the service then fails, so a timeout can still use one. If the feature is not configured on the server you will see Photo identification is unavailable right now and can still type the species yourself.',
      },
      {
        id: 'leaf-health',
        q: 'What is the leaf health check — and is it a diagnosis?',
        a: (
          <>
            <p>
              <strong>No, it is not a diagnosis, and you should not treat it as one.</strong> It is
              a cosmetic visual check: you photograph one leaf, and an AI model reports what is
              visible in that single photo — yellowing, browning edges, wilting, spots, visible
              pests — as &ldquo;looking healthy&rdquo;, &ldquo;worth monitoring&rdquo; or
              &ldquo;needs attention&rdquo;. It does not identify diseases and cannot see roots,
              soil, or anything outside the frame. Every result carries its own disclaimer saying
              so.
            </p>
            <p>
              It is available on every plan, including free, and requires a household. It is capped
              at 200 checks per household per calendar month, resetting on the 1st. Running a check
              adds an entry to your household&rsquo;s activity feed, so other members can see that
              you ran one and what the verdict was.
            </p>
            <p>
              If the server can&rsquo;t reach the model you are told so — the check fails with
              &ldquo;temporarily unavailable&rdquo; and nothing is analysed. On a demo or preview
              server you instead get a clearly-labelled demo result that says &ldquo;Demo
              result&rdquo; on the card. Don&rsquo;t act on that. Either way, you never get an
              assessment the model did not actually make.
            </p>
          </>
        ),
        text: 'No, it is not a diagnosis and you should not treat it as one. It is a cosmetic visual check: you photograph one leaf and an AI model reports what is visible in that single photo, such as yellowing, browning edges, wilting, spots or visible pests, as looking healthy, worth monitoring, or needs attention. It does not identify diseases and cannot see roots, soil, or anything outside the frame. Every result carries its own disclaimer saying so. It is available on every plan including free and requires a household. It is capped at 200 checks per household per calendar month, resetting on the 1st. Running a check adds an entry to your household activity feed, so other members can see that you ran one and what the verdict was. If the server cannot reach the model the check fails with "temporarily unavailable" and nothing is analysed; on a demo or preview server you instead get a clearly labelled demo result, which you should not act on. Either way you never get an assessment the model did not actually make.',
      },
    ],
  },

  {
    id: 'tasks',
    title: 'Tasks and streaks',
    description: 'Completing, snoozing, and what the streak number really means.',
    articles: [
      {
        id: 'done-vs-snooze',
        q: 'What’s the difference between Done and Snooze?',
        a: (
          <>
            <p>
              <strong>Done</strong> records that you actually did it. It writes a completion to the
              plant&rsquo;s history and moves the next due date to today plus the task&rsquo;s
              frequency.
            </p>
            <p>
              <strong>Snooze</strong> just moves the due date without recording that anything was
              done. The options are 1 day, 3 days, 1 week, or <em>Skip cycle</em>, which pushes it
              by one full frequency. Snoozing an already-overdue task counts from today, not from
              the old due date, so it doesn&rsquo;t land back in the past.
            </p>
          </>
        ),
        text: 'Done records that you actually did it: it writes a completion to the plant history and moves the next due date to today plus the task frequency. Snooze just moves the due date without recording that anything was done. The options are 1 day, 3 days, 1 week, or Skip cycle, which pushes it by one full frequency. Snoozing an already-overdue task counts from today, not from the old due date, so it does not land back in the past.',
      },
      {
        id: 'streaks',
        q: 'How do streaks work, and why does mine show a “+”?',
        a: (
          <>
            <p>
              A streak counts consecutive completions where the gap to the previous completion
              stayed within about 1.5× the task&rsquo;s frequency. It is a measure of{' '}
              <em>regularity</em>, not punctuality — if you water every nine days on a seven-day
              task, that is a streak, even though every one of those waterings was late.
            </p>
            <p>
              The plus matters. Streaks are counted from the last 10 logged completions for the
              whole plant, shared across all of that plant&rsquo;s tasks. When an unbroken run uses
              up every row we can see, we show &ldquo;10+&rdquo; rather than &ldquo;10&rdquo;,
              because older care is over the horizon and we won&rsquo;t report a ceiling as if it
              were a measurement. The same 10-completion window applies to the care report card on
              the plant page.
            </p>
          </>
        ),
        text: 'A streak counts consecutive completions where the gap to the previous completion stayed within about 1.5 times the task frequency. It is a measure of regularity, not punctuality: if you water every nine days on a seven-day task, that is a streak even though every watering was late. Streaks are counted from the last 10 logged completions for the whole plant, shared across all of that plant tasks. When an unbroken run uses up every row we can see, we show 10+ rather than 10, because older care is over the horizon and we will not report a ceiling as if it were a measurement. The same 10-completion window applies to the care report card on the plant page.',
      },
      {
        id: 'vacation',
        q: 'I’m going away. How do I stop the reminders?',
        a: (
          <p>
            Set a vacation window for yourself. While it is active you get no reminders at all, and
            your assigned tasks route to whoever you nominated as cover. If you didn&rsquo;t
            nominate anyone — or your cover is away too, or has left the household — those tasks
            roll up into everyone&rsquo;s reminder instead, so they don&rsquo;t quietly go
            unwatered.
          </p>
        ),
        text: 'Set a vacation window for yourself. While it is active you get no reminders at all, and your assigned tasks route to whoever you nominated as cover. If you did not nominate anyone, or your cover is away too or has left the household, those tasks roll up into everyone reminder instead, so they do not quietly go unwatered.',
      },
    ],
  },

  {
    id: 'reminders',
    title: 'Reminders and notifications',
    description: 'Why a reminder did or didn’t arrive, and how to turn things off.',
    articles: [
      {
        id: 'no-reminder',
        q: 'Why didn’t my reminder arrive?',
        a: (
          <>
            <p>Working from the most common cause down:</p>
            <ul>
              <li>
                <strong>Nothing was due.</strong> We only remind about tasks due in the next 24
                hours or already overdue, and only for active plants.
              </li>
              <li>
                <strong>You already got one today.</strong> There is at most one reminder per
                person, per household, per channel, per day — and it bundles every due task together
                rather than pinging per plant.
              </li>
              <li>
                <strong>The channel is off.</strong> In <em>Settings → Notifications</em>, email is
                on by default; browser notifications are off until you turn them on and grant
                permission.
              </li>
              <li>
                <strong>Quiet hours.</strong> These pause email (and SMS) inside your window.
                Nothing is lost — the next hourly pass delivers once the window lifts.
              </li>
              <li>
                <strong>You&rsquo;re on vacation.</strong> An active vacation window suppresses all
                of your reminders.
              </li>
              <li>
                <strong>Browser notifications need more than a tick.</strong> See{' '}
                <Link to="/help/reminders#browser-notifications">the browser question below</Link>.
              </li>
            </ul>
            <p>
              The scan runs hourly, so a task that becomes due at 09:05 may be notified at 10:00
              rather than immediately.
            </p>
          </>
        ),
        text: 'Working from the most common cause down. Nothing was due: we only remind about tasks due in the next 24 hours or already overdue, and only for active plants. You already got one today: there is at most one reminder per person, per household, per channel, per day, and it bundles every due task together rather than pinging per plant. The channel is off: in Settings then Notifications, email is on by default and browser notifications are off until you turn them on and grant permission. Quiet hours pause email and SMS inside your window; nothing is lost, the next hourly pass delivers once the window lifts. An active vacation window suppresses all of your reminders. Browser notifications need more than a tick. The scan runs hourly, so a task that becomes due at 09:05 may be notified at 10:00 rather than immediately.',
      },
      {
        id: 'browser-notifications',
        q: 'I turned on browser notifications but nothing pops up.',
        a: (
          <>
            <p>Browser notifications have more moving parts than the other channels:</p>
            <ul>
              <li>
                Your browser must have <em>granted</em> permission. If you dismissed the prompt
                rather than allowing it, the setting is not saved. If you blocked it, you have to
                unblock the site in your browser before the button will work.
              </li>
              <li>
                Permission is per browser and per device. Enabling it on your laptop does nothing
                for your phone.
              </li>
              <li>
                Some devices support only <em>foreground</em> notifications — pop-ups while a Family
                Greenhouse tab is open. When that&rsquo;s the case the app tells you explicitly that
                background delivery is unavailable on that device.
              </li>
              <li>
                In-tab pop-ups for newly-overdue tasks only appear on the dashboard, and on the
                first load in a browser session anything already overdue is marked as seen without
                popping up. Only tasks that cross the line afterwards will announce themselves.
              </li>
            </ul>
            <p>
              Quiet hours deliberately do <em>not</em> silence browser notifications — your
              operating system&rsquo;s own Do Not Disturb handles that better than we can.
            </p>
          </>
        ),
        text: 'Browser notifications have more moving parts than the other channels. Your browser must have granted permission: if you dismissed the prompt rather than allowing it the setting is not saved, and if you blocked it you have to unblock the site in your browser first. Permission is per browser and per device, so enabling it on your laptop does nothing for your phone. Some devices support only foreground notifications, meaning pop-ups while a Family Greenhouse tab is open; when that is the case the app tells you explicitly that background delivery is unavailable on that device. In-tab pop-ups for newly overdue tasks only appear on the dashboard, and on the first load in a browser session anything already overdue is marked as seen without popping up, so only tasks that cross the line afterwards announce themselves. Quiet hours deliberately do not silence browser notifications, because your operating system Do Not Disturb handles that better.',
      },
      {
        id: 'quiet-hours-timezone',
        q: 'My quiet hours don’t seem to be working.',
        a: (
          <>
            <p>
              The most likely reason is your time zone. Quiet hours are evaluated in the time zone
              stored on your account, and that defaults to <strong>UTC</strong>. The settings form
              pre-fills your browser&rsquo;s time zone, but it is only saved when you actually press{' '}
              <strong>Save quiet hours</strong>. If you have never pressed it, your window is being
              applied in UTC.
            </p>
            <p>
              Two other things worth knowing: you must set both a start and an end (one alone is
              rejected), and a window where start and end are identical suppresses nothing. Windows
              that cross midnight — 22:00 to 07:00 — work as you would expect.
            </p>
          </>
        ),
        text: 'The most likely reason is your time zone. Quiet hours are evaluated in the time zone stored on your account, and that defaults to UTC. The settings form pre-fills your browser time zone but it is only saved when you actually press Save quiet hours; if you have never pressed it, your window is being applied in UTC. You must set both a start and an end, as one alone is rejected, and a window where start and end are identical suppresses nothing. Windows that cross midnight such as 22:00 to 07:00 work as you would expect.',
      },
      {
        id: 'stop-emails',
        q: 'How do I stop the emails?',
        a: (
          <>
            <p>
              The weekly digest and the annual recap carry an{' '}
              <strong>Unsubscribe from these</strong> link in the footer, and they are sent with the
              headers that put a one-click <strong>Unsubscribe</strong> button at the top of the
              message in Gmail, Apple Mail and other clients that support them. Either one works in
              a single click, and neither needs you to be signed in.
            </p>
            <p>
              For finer control, open <em>Settings → Notifications</em>. Unticking{' '}
              <strong>Email</strong> stops everything, including task reminders — those carry no
              unsubscribe link of their own, because they are answering a task you created. If you
              want reminders but not the Monday summary, untick just{' '}
              <strong>Weekly plant digest</strong> and leave email on. One email always goes out
              regardless of preferences: the welcome message when you first create a household.
            </p>
            <p>
              If you can&rsquo;t sign in and have no recent digest to unsubscribe from, email{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we&rsquo;ll do it for you.
            </p>
          </>
        ),
        text: 'The weekly digest and the annual recap carry an Unsubscribe from these link in the footer, and they are sent with the headers that put a one-click Unsubscribe button at the top of the message in Gmail, Apple Mail and other clients that support them. Either one works in a single click, and neither needs you to be signed in. For finer control, open Settings then Notifications. Unticking Email stops everything, including task reminders, which carry no unsubscribe link of their own because they are answering a task you created. If you want reminders but not the Monday summary, untick just Weekly plant digest and leave email on. One email always goes out regardless of preferences: the welcome message when you first create a household. If you cannot sign in and have no recent digest to unsubscribe from, email support and we will do it for you.',
      },
      {
        id: 'weekly-digest',
        q: 'What is the weekly digest, and when does it arrive?',
        a: (
          <p>
            An email summary of what is overdue in your household, sent on Mondays. It is email only
            — there is no browser or SMS version — and it is skipped entirely for households with
            nothing overdue, so a quiet week means no email rather than an empty one. It lists up to
            five plants but the subject line tells you the true total. If it lands during your quiet
            hours, a later pass the same day delivers it.
          </p>
        ),
        text: 'An email summary of what is overdue in your household, sent on Mondays. It is email only, with no browser or SMS version, and it is skipped entirely for households with nothing overdue, so a quiet week means no email rather than an empty one. It lists up to five plants but the subject line tells you the true total. If it lands during your quiet hours, a later pass the same day delivers it.',
      },
      {
        id: 'pest-alerts',
        q: 'What are pest alerts?',
        a: (
          <p>
            An opt-in nudge when one of your plants is entering a typical season for a common pest.
            Turn them on under <em>Settings → Notifications</em>. They only fire for plants with a
            species we recognise, at most one pest per plant, and at most once every 90 days for the
            same plant and pest. They are a seasonal prompt to go and look at the plant — not a
            detection, and not evidence that anything is actually wrong.
          </p>
        ),
        text: 'An opt-in nudge when one of your plants is entering a typical season for a common pest. Turn them on under Settings then Notifications. They only fire for plants with a species we recognise, at most one pest per plant, and at most once every 90 days for the same plant and pest. They are a seasonal prompt to go and look at the plant, not a detection, and not evidence that anything is actually wrong.',
      },
      {
        id: 'sms-reminders',
        q: 'Can I get reminders by text message?',
        a: (
          <p>
            Not right now. SMS is built but switched off — the phone-verification form is hidden and
            the app will tell you that SMS delivery is not enabled. Email and browser reminders work
            normally. We haven&rsquo;t committed to a date for turning it on.
          </p>
        ),
        text: 'Not right now. SMS is built but switched off: the phone-verification form is hidden and the app will tell you that SMS delivery is not enabled. Email and browser reminders work normally. We have not committed to a date for turning it on.',
      },
      {
        id: 'prefs-scope',
        q: 'I’m in two households. Are my notification settings separate?',
        a: (
          <p>
            No. Your notification preferences, quiet hours and time zone are stored once per account
            and apply everywhere. What <em>is</em> per household is the reminder itself: you can
            receive one reminder per household per day, so being in two households means up to two
            reminders.
          </p>
        ),
        text: 'No. Your notification preferences, quiet hours and time zone are stored once per account and apply everywhere. What is per household is the reminder itself: you can receive one reminder per household per day, so being in two households means up to two reminders.',
      },
    ],
  },

  {
    id: 'households',
    title: 'Households and members',
    description: 'Sharing with the people you live with, and taking access back.',
    articles: [
      {
        id: 'invite-someone',
        q: 'How do I share my plants with someone?',
        a: (
          <p>
            On the <strong>Household</strong> page, an admin can{' '}
            <strong>Generate invite link</strong> and send it to whoever should join. They create
            their own login and land in your household as a member. The link{' '}
            <strong>expires after 7 days</strong> and can be used by more than one person in that
            window, so treat it as semi-private and don&rsquo;t post it publicly. There is no way to
            revoke an invite early — if one gets out, the safest response is to wait it out and
            remove anyone unexpected.
          </p>
        ),
        text: 'On the Household page, an admin can Generate invite link and send it to whoever should join. They create their own login and land in your household as a member. The link expires after 7 days and can be used by more than one person in that window, so treat it as semi-private and do not post it publicly. There is no way to revoke an invite early; if one gets out, wait it out and remove anyone unexpected.',
      },
      {
        id: 'admin-vs-member',
        q: 'What can an admin do that a member can’t?',
        a: (
          <>
            <p>Admins alone can:</p>
            <ul>
              <li>Generate invite links</li>
              <li>Change someone&rsquo;s role, and remove members</li>
              <li>Create and revoke plant-sitter links</li>
              <li>Buy, change or cancel the household&rsquo;s plan</li>
              <li>Create and revoke API keys</li>
            </ul>
            <p>
              Everything else — adding and editing plants, completing, snoozing and claiming tasks,
              photos, activity and analytics — is open to every member. Roles are per household, so
              you can be an admin in one and a member in another.
            </p>
          </>
        ),
        text: 'Admins alone can generate invite links, change someone role and remove members, create and revoke plant-sitter links, buy change or cancel the household plan, and create and revoke API keys. Everything else — adding and editing plants, completing, snoozing and claiming tasks, photos, activity and analytics — is open to every member. Roles are per household, so you can be an admin in one and a member in another.',
      },
      {
        id: 'remove-member',
        q: 'How do I remove someone from my household?',
        a: (
          <>
            <p>
              An admin removes them from the <strong>Household</strong> page. They immediately lose
              access to that household&rsquo;s plants and tasks; their own account and any other
              households are untouched.
            </p>
            <p>Two rules the app enforces:</p>
            <ul>
              <li>You cannot remove yourself.</li>
              <li>
                You cannot remove the last admin of a household that still has other members —
                promote someone else first.
              </li>
            </ul>
            <p>
              Their history stays, anonymised. Past completions and activity remain so the
              household&rsquo;s care record stays intact, but their name is replaced with{' '}
              <strong>&ldquo;Former member&rdquo;</strong>. Anything currently assigned to them
              becomes unassigned. Worth knowing: a sitter link they created stays active — revoke it
              separately if you no longer want it working.
            </p>
          </>
        ),
        text: 'An admin removes them from the Household page. They immediately lose access to that household plants and tasks; their own account and any other households are untouched. Two rules are enforced: you cannot remove yourself, and you cannot remove the last admin of a household that still has other members, so promote someone else first. Their history stays, anonymised: past completions and activity remain so the household care record stays intact, but their name is replaced with Former member, and anything currently assigned to them becomes unassigned. A sitter link they created stays active, so revoke it separately if you no longer want it working.',
      },
      {
        id: 'leave-household',
        q: 'How do I leave a household I’ve joined?',
        a: (
          <p>
            You can&rsquo;t do it yourself yet, and we&rsquo;d rather say so than let you hunt for
            the button. Today the options are to ask an admin of that household to remove you, or to
            delete your whole account — which removes you from every household at once. A
            leave-but-keep-your-account flow is a known gap.
          </p>
        ),
        text: 'You cannot do it yourself yet, and we would rather say so than let you hunt for the button. Today the options are to ask an admin of that household to remove you, or to delete your whole account, which removes you from every household at once. A leave-but-keep-your-account flow is a known gap.',
      },
      {
        id: 'household-full',
        q: 'Someone can’t join — it says the household is full.',
        a: (
          <p>
            The free <strong>Seedling</strong> plan holds three people. <strong>Garden</strong> and{' '}
            <strong>Greenhouse</strong> have no member limit at all, so Garden — the cheaper of the
            two — is the tier that lifts this. The cap is checked at the moment someone joins, and
            it only ever blocks a new join: if you are already over it, everyone you have stays, and
            stays editable. Either remove a member you no longer need, or move to Garden.
          </p>
        ),
        text: 'The free Seedling plan holds three people. Garden and Greenhouse have no member limit at all, so Garden, the cheaper of the two, is the tier that lifts this. The cap is checked at the moment someone joins, and it only ever blocks a new join: if you are already over it, everyone you have stays, and stays editable. Either remove a member you no longer need, or move to Garden.',
      },
      {
        id: 'multiple-households',
        q: 'Can I belong to more than one household?',
        a: (
          <p>
            Yes — your own place, a parent&rsquo;s plants, a shared house. Use the switcher in the
            sidebar to move between them or add another. Each household has its own plants, tasks,
            members, plan and location; there is deliberately no combined &ldquo;all my
            plants&rdquo; view. Your first household stays your default for anything that
            doesn&rsquo;t use the switcher.
          </p>
        ),
        text: 'Yes: your own place, a parent plants, a shared house. Use the switcher in the sidebar to move between them or add another. Each household has its own plants, tasks, members, plan and location; there is deliberately no combined all-my-plants view. Your first household stays your default for anything that does not use the switcher.',
      },
      {
        id: 'what-members-see',
        q: 'What can other household members see about me?',
        a: (
          <p>
            Your display name, and which tasks you have completed, plus everything in the shared
            household — plants, tasks, photos, notes and the activity feed. They cannot see your
            email address, your phone number, or your notification settings.
          </p>
        ),
        text: 'Your display name and which tasks you have completed, plus everything in the shared household: plants, tasks, photos, notes and the activity feed. They cannot see your email address, your phone number, or your notification settings.',
      },
    ],
  },

  {
    id: 'sitters',
    title: 'Plant sitters',
    description: 'Handing your plants to a neighbour without handing over your account.',
    articles: [
      {
        id: 'create-sitter-link',
        q: 'How do I set up a plant sitter?',
        a: (
          <p>
            An admin creates a sitter link on the <strong>Household</strong> page, choosing how long
            it should last — up to 7 days on the free <strong>Seedling</strong> plan, and up to 90
            on <strong>Garden</strong> and <strong>Greenhouse</strong>. The form suggests 14, or
            your plan&rsquo;s maximum where that is lower. You send that link to your sitter — they
            need no account, no password and no app. The link is shown{' '}
            <strong>once, at the moment you create it</strong>, so copy it then; we cannot show it
            to you again afterwards.
          </p>
        ),
        text: 'An admin creates a sitter link on the Household page, choosing how long it should last: up to 7 days on the free Seedling plan, and up to 90 on Garden and Greenhouse. The form suggests 14, or your plan maximum where that is lower. You send that link to your sitter: they need no account, no password and no app. The link is shown once, at the moment you create it, so copy it then; we cannot show it to you again afterwards.',
      },
      {
        id: 'sitter-sees',
        q: 'What exactly can a plant sitter see?',
        a: (
          <>
            <p>Only a to-do list. The page shows, for tasks due in the next 7 days or overdue:</p>
            <ul>
              <li>the plant&rsquo;s name</li>
              <li>what needs doing (water, fertilise, prune, repot, or your custom task name)</li>
              <li>when it is due, and whether it is overdue</li>
              <li>which space the plant is in, and its placement note</li>
            </ul>
            <p>
              They cannot see your household members&rsquo; names or contact details, your saved
              location, plant or task notes, photos, the activity feed, analytics, your plan or
              billing, or any other household. They cannot even see plants that have nothing due.
            </p>
            <p>
              One caveat you control: plant names, space names and placement notes are your own free
              text, and the sitter sees them verbatim. If a plant is called something you
              wouldn&rsquo;t hand to a neighbour, rename it first.
            </p>
          </>
        ),
        text: 'Only a to-do list. The page shows, for tasks due in the next 7 days or overdue: the plant name, what needs doing (water, fertilise, prune, repot, or your custom task name), when it is due and whether it is overdue, and which space the plant is in with its placement note. They cannot see your household members names or contact details, your saved location, plant or task notes, photos, the activity feed, analytics, your plan or billing, or any other household. They cannot even see plants that have nothing due. One caveat you control: plant names, space names and placement notes are your own free text and the sitter sees them verbatim, so if a plant is called something you would not hand to a neighbour, rename it first.',
      },
      {
        id: 'sitter-can-do',
        q: 'What can a sitter change?',
        a: (
          <p>
            One thing: they can mark a listed task done. They cannot add, edit or delete plants or
            tasks, snooze anything, upload photos, invite anyone, or reach settings. Their
            completions are recorded as <strong>&ldquo;a plant sitter&rdquo;</strong> rather than
            attributed to you or to any named person, and they advance the task&rsquo;s schedule
            exactly as your own completions do.
          </p>
        ),
        text: 'One thing: they can mark a listed task done. They cannot add, edit or delete plants or tasks, snooze anything, upload photos, invite anyone, or reach settings. Their completions are recorded as a plant sitter rather than attributed to you or any named person, and they advance the task schedule exactly as your own completions do.',
      },
      {
        id: 'revoke-sitter',
        q: 'How do I cut off a sitter’s access?',
        a: (
          <p>
            An admin revokes the link on the <strong>Household</strong> page and it stops working
            immediately. Otherwise it expires by itself on the date you chose — at most 7 days out
            on the free Seedling plan, and at most 90 on Garden and Greenhouse. Anyone holding the
            link can use it — it is the credential, so only send it to someone you trust, and revoke
            it if you forward it to the wrong person.
          </p>
        ),
        text: 'An admin revokes the link on the Household page and it stops working immediately. Otherwise it expires by itself on the date you chose: at most 7 days out on the free Seedling plan, and at most 90 on Garden and Greenhouse. Anyone holding the link can use it, because it is the credential, so only send it to someone you trust and revoke it if you forward it to the wrong person.',
      },
    ],
  },

  {
    id: 'billing',
    title: 'Plans, payment and cancelling',
    description: 'What the free plan keeps, what you get for paying, and how to stop paying.',
    webOnly: true,
    articles: [
      {
        id: 'whats-free',
        q: 'What do I get without paying?',
        a: (
          <>
            <p>
              The free <strong>Seedling</strong> plan is a real plan, not a trial: a couple and
              their plants &mdash; one home, up to 3 members and 20 plants, with no card required
              and no expiry. It includes plants and photos, unlimited tasks and reminders, invites
              and task claiming, one plant-sitter link at a time (up to 7 days), climate tips, the
              last 30 days of analytics, the calendar feed, data export, and leaf-health checks each
              month.
            </p>
            <p>
              The paid plans are drawn on homes and hands, not on how many plants you own.{' '}
              <strong>Garden</strong> is for a household that has to coordinate: one home, unlimited
              members, 200 plants, your full analytics history, and the AI care assistant.{' '}
              <strong>Greenhouse</strong> is for many homes and many hands: belong to every
              household you help with, unlimited members, 5,000 plants, and API keys on top. Plant
              identification is available on every plan, with a monthly allowance that grows with
              the tier. Export and your care history are never behind a plan.
            </p>
          </>
        ),
        text: 'The free Seedling plan is a real plan, not a trial: a couple and their plants — one home, up to 3 members and 20 plants, with no card required and no expiry. It includes plants and photos, unlimited tasks and reminders, invites and task claiming, one plant-sitter link at a time (up to 7 days), climate tips, the last 30 days of analytics, the calendar feed, data export, and leaf-health checks each month. The paid plans are drawn on homes and hands, not on how many plants you own. Garden is for a household that has to coordinate: one home, unlimited members, 200 plants, your full analytics history, and the AI care assistant. Greenhouse is for many homes and many hands: belong to every household you help with, unlimited members, 5,000 plants, and API keys on top. Plant identification is available on every plan, with a monthly allowance that grows with the tier. Export and your care history are never behind a plan.',
      },
      {
        id: 'who-can-buy',
        q: 'Who can buy or change the plan?',
        a: (
          <p>
            Only an <strong>admin of that household</strong>, from <em>Settings → Billing</em> on
            the web. Plans belong to households, not to people: one subscription covers everyone in
            that household, and if you belong to two households each has its own plan. Purchases are
            not available inside the iOS and Android apps.
          </p>
        ),
        text: 'Only an admin of that household, from Settings then Billing on the web. Plans belong to households, not to people: one subscription covers everyone in that household, and if you belong to two households each has its own plan. Purchases are not available inside the iOS and Android apps.',
      },
      {
        id: 'billing-cadence',
        q: 'Can I pay yearly, or once?',
        a: (
          <p>
            Not any more. Both tiers are sold <strong>monthly only</strong> — Garden at $4.99 a
            month and Greenhouse at $9.99 a month. Annual billing and the one-off Garden lifetime
            purchase have been withdrawn from sale. If you already hold an annual or lifetime plan
            you keep it on the terms and the price you bought it at: annual subscriptions go on
            renewing, and a lifetime tier stays yours permanently.
          </p>
        ),
        text: 'Not any more. Both tiers are sold monthly only: Garden at $4.99 a month and Greenhouse at $9.99 a month. Annual billing and the one-off Garden lifetime purchase have been withdrawn from sale. If you already hold an annual or lifetime plan you keep it on the terms and the price you bought it at: annual subscriptions go on renewing, and a lifetime tier stays yours permanently.',
      },
      {
        id: 'free-trial',
        q: 'Is there a free trial?',
        a: (
          <p>
            Yes — every new subscription starts with a <strong>14-day free trial</strong>. Checkout
            collects a card up front, and billing begins when the trial ends unless you cancel
            before then. Cancelling during the trial leaves you on the free Seedling plan.
          </p>
        ),
        text: 'Yes. Every new subscription starts with a 14-day free trial. Checkout collects a card up front, and billing begins when the trial ends unless you cancel before then. Cancelling during the trial leaves you on the free Seedling plan.',
      },
      {
        id: 'cancel',
        q: 'How do I cancel?',
        a: (
          <>
            <p>
              Go to <em>Settings → Billing</em> and press <strong>Manage subscription</strong>. That
              opens our payment provider&rsquo;s billing portal, which is the only place a live
              subscription can be changed or cancelled — you must be an admin of the household.
            </p>
            <p>
              Cancelling does not cut you off on the spot. You keep the paid plan until the end of
              the period you have already paid for, and the billing page shows the date it ends.
              After that the household drops to the free Seedling plan.
            </p>
            <p>
              The same <strong>Manage subscription</strong> button stays available after you cancel,
              so you can still reach your invoices and receipts.
            </p>
          </>
        ),
        text: 'Go to Settings then Billing and press Manage subscription. That opens our payment provider billing portal, which is the only place a live subscription can be changed or cancelled, and you must be an admin of the household. Cancelling does not cut you off on the spot: you keep the paid plan until the end of the period you have already paid for, and the billing page shows the date it ends. After that the household drops to the free Seedling plan. The same Manage subscription button stays available after you cancel, so you can still reach your invoices and receipts.',
      },
      {
        id: 'after-cancel',
        q: 'What happens to my plants when I cancel or downgrade?',
        a: (
          <>
            <p>
              <strong>Nothing is deleted. Ever.</strong> If you drop to a plan whose caps you are
              over, every plant and every member stays exactly where it is, and all of it stays
              readable and editable. Your tasks keep running and your reminders keep arriving.
            </p>
            <p>
              The only thing that changes is that you can&rsquo;t <em>add</em> more plants or
              members until you are back under the cap — the billing page shows a warning telling
              you where you stand. Archiving plants you are no longer caring for is the quickest way
              back under a plant cap.
            </p>
            <p>
              Two features do switch off with the tier: the AI care assistant needs Garden or above,
              and API keys need Greenhouse.
            </p>
          </>
        ),
        text: 'Nothing is deleted, ever. If you drop to a plan whose caps you are over, every plant and every member stays exactly where it is, and all of it stays readable and editable. Your tasks keep running and your reminders keep arriving. The only thing that changes is that you cannot add more plants or members until you are back under the cap, and the billing page shows a warning telling you where you stand. Archiving plants you are no longer caring for is the quickest way back under a plant cap. Two features do switch off with the tier: the AI care assistant needs Garden or above, and API keys need Greenhouse.',
      },
      {
        id: 'change-plan',
        q: 'I already subscribed — why is there no button to switch tiers?',
        a: (
          <p>
            Because a second checkout would start a second subscription alongside the first and bill
            you twice. While you have a live subscription, tier changes go through{' '}
            <strong>Manage subscription</strong> instead, and the app refuses a second purchase
            rather than risking the double charge. If you own Garden outright through one of the
            earlier lifetime purchases, there is nothing left to buy at that tier and we won&rsquo;t
            sell it to you again.
          </p>
        ),
        text: 'Because a second checkout would start a second subscription alongside the first and bill you twice. While you have a live subscription, tier changes go through Manage subscription instead, and the app refuses a second purchase rather than risking the double charge. If you own Garden outright through one of the earlier lifetime purchases, there is nothing left to buy at that tier and we will not sell it to you again.',
      },
      {
        id: 'billing-questions',
        q: 'Something looks wrong with a charge.',
        a: (
          <p>
            Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with the date and amount
            and we&rsquo;ll investigate. Please don&rsquo;t send card details. Your invoices are in
            the billing portal behind <strong>Manage subscription</strong>. We don&rsquo;t publish a
            refund policy, so anything in that territory is handled case by case — ask.
          </p>
        ),
        text: 'Email support with the date and amount and we will investigate. Please do not send card details. Your invoices are in the billing portal behind Manage subscription. We do not publish a refund policy, so anything in that territory is handled case by case; ask.',
      },
      {
        id: 'care-assistant',
        q: 'What is the care assistant, and what are its limits?',
        a: (
          <>
            <p>
              A chat assistant, included with <strong>Garden and Greenhouse</strong>, that can look
              at your household&rsquo;s plants, your upcoming tasks and your local climate, and
              search our plant-care knowledge base to answer questions.
            </p>
            <p>
              It <strong>cannot create anything</strong>. When it suggests a reminder you get a
              proposal card, and the task only exists once you press Create. It won&rsquo;t give
              pesticide or fertiliser dosing beyond published nursery guidance, won&rsquo;t identify
              a plant from a written description, and if it can&rsquo;t verify the numbers in an
              answer against its sources it says so rather than guessing.
            </p>
            <p>
              Usage is metered per household per month and shown as a percentage on the chat page.
              Conversations are shared within the household and are kept for 30 days, then deleted
              automatically.
            </p>
          </>
        ),
        text: 'A chat assistant, included with Garden and Greenhouse, that can look at your household plants, your upcoming tasks and your local climate, and search our plant-care knowledge base to answer questions. It cannot create anything: when it suggests a reminder you get a proposal card, and the task only exists once you press Create. It will not give pesticide or fertiliser dosing beyond published nursery guidance, will not identify a plant from a written description, and if it cannot verify the numbers in an answer against its sources it says so rather than guessing. Usage is metered per household per month and shown as a percentage on the chat page. Conversations are shared within the household and are kept for 30 days, then deleted automatically.',
      },
    ],
  },

  {
    id: 'data',
    title: 'Your data',
    description: 'Getting it out, and deleting it for good.',
    articles: [
      {
        id: 'export',
        q: 'How do I export my data?',
        a: (
          <>
            <p>
              From <em>Settings → Account &amp; data</em>, two different downloads:
            </p>
            <ul>
              <li>
                <strong>Download full data (JSON)</strong> — the complete one. Your profile, your
                notification preferences, and for <em>every</em> household you belong to: its name,
                your role, all plants (including archived, died and given-away ones) and all tasks.
              </li>
              <li>
                <strong>CSV</strong> — two spreadsheet files, one of plants and one of tasks, for
                your <em>currently selected</em> household only. Handy for a spreadsheet, but a
                narrower slice.
              </li>
            </ul>
            <p>
              Both download straight to your device; nothing is emailed and there is no waiting.
              Neither export includes photo image files, task completion history, the activity feed,
              or other members&rsquo; details — plants carry a link to their current photo, not the
              image itself.
            </p>
          </>
        ),
        text: 'From Settings then Account and data there are two different downloads. Download full data (JSON) is the complete one: your profile, your notification preferences, and for every household you belong to its name, your role, all plants including archived, died and given-away ones, and all tasks. CSV gives two spreadsheet files, one of plants and one of tasks, for your currently selected household only. Both download straight to your device; nothing is emailed and there is no waiting. Neither export includes photo image files, task completion history, the activity feed, or other members details; plants carry a link to their current photo, not the image itself.',
      },
      {
        id: 'delete-account',
        q: 'How do I delete my account, and what actually gets deleted?',
        a: (
          <>
            <p>
              <em>Settings → Account &amp; data → Delete my account</em>. It is{' '}
              <strong>immediate and permanent</strong> — there is no grace period and no undo, so
              export first if you want a copy.
            </p>
            <p>
              Deleted outright: your login, your notification preferences and phone verification,
              your browser notification subscriptions, and your delivery history.
            </p>
            <p>
              For a household where you were the <strong>only</strong> member, the whole household
              goes with you — plants, tasks, photos, spaces, chat, sitter links and activity.
            </p>
            <p>
              For a household with other people in it, the shared record survives without you.
              Plants, tasks and photos you created stay, and past completions and activity stay so
              the household&rsquo;s history remains intact — but your name on them is replaced with{' '}
              <strong>&ldquo;Former member&rdquo;</strong>. Anything assigned to you becomes
              unassigned.
            </p>
            <p>
              One blocker: if you are the only admin of a household that still has other members,
              deletion is refused until you promote someone else. Promote them, then try again.
            </p>
          </>
        ),
        text: 'Settings then Account and data then Delete my account. It is immediate and permanent, with no grace period and no undo, so export first if you want a copy. Deleted outright: your login, your notification preferences and phone verification, your browser notification subscriptions, and your delivery history. For a household where you were the only member, the whole household goes with you: plants, tasks, photos, spaces, chat, sitter links and activity. For a household with other people in it, the shared record survives without you. Plants, tasks and photos you created stay, and past completions and activity stay so the household history remains intact, but your name on them is replaced with Former member, and anything assigned to you becomes unassigned. One blocker: if you are the only admin of a household that still has other members, deletion is refused until you promote someone else.',
      },
      {
        id: 'cancel-before-delete',
        q: 'Does deleting my account cancel my subscription?',
        a: (
          <>
            <p>
              <strong>No — and this is the one thing on this page we most want you to read.</strong>{' '}
              Account deletion does not tell our payment provider anything. A subscription will keep
              billing after your account is gone.
            </p>
            <p>
              <strong>Cancel first, delete second.</strong> Go to <em>Settings → Billing</em>, press{' '}
              <strong>Manage subscription</strong>, cancel there, and only then delete your account.
              If you have already deleted an account and think you are still being charged, email{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> straight away and we will sort
              it out.
            </p>
          </>
        ),
        text: 'No, and this is the one thing on this page we most want you to read. Account deletion does not tell our payment provider anything: a subscription will keep billing after your account is gone. Cancel first, delete second. Go to Settings then Billing, press Manage subscription, cancel there, and only then delete your account. If you have already deleted an account and think you are still being charged, email support straight away and we will sort it out.',
      },
      {
        id: 'delete-locked-out',
        q: 'I can’t sign in — can you delete my account for me?',
        a: (
          <p>
            Yes. Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from the address on
            the account; we may ask you to confirm ownership, and we respond within 30 days. The{' '}
            <Link to="/account-deletion">account deletion page</Link> has the full instructions.
          </p>
        ),
        text: 'Yes. Email support from the address on the account; we may ask you to confirm ownership, and we respond within 30 days. The account deletion page has the full instructions.',
      },
      {
        id: 'delete-household',
        q: 'Can I delete a whole household?',
        a: (
          <p>
            Not directly — there is no delete-household button. A household is only destroyed as a
            side effect of the last remaining member deleting their account. If you need one removed
            and that route doesn&rsquo;t fit, email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and ask.
          </p>
        ),
        text: 'Not directly: there is no delete-household button. A household is only destroyed as a side effect of the last remaining member deleting their account. If you need one removed and that route does not fit, email support and ask.',
      },
      {
        id: 'api-keys',
        q: 'What are API keys for?',
        a: (
          <p>
            Reading your household&rsquo;s data from your own scripts or home-automation setup — a
            read-only API for plants, tasks and activity, plus an optional scope for completing and
            snoozing tasks. Creating one needs <strong>Greenhouse</strong> and household admin. The
            key is shown once when you create it and we only store a hash, so if you lose it you
            revoke it and make another. Keys don&rsquo;t expire; revoking is instant.
          </p>
        ),
        text: 'Reading your household data from your own scripts or home-automation setup: a read-only API for plants, tasks and activity, plus an optional scope for completing and snoozing tasks. Creating one needs Greenhouse and household admin. The key is shown once when you create it and we only store a hash, so if you lose it you revoke it and make another. Keys do not expire; revoking is instant.',
      },
    ],
  },

  {
    id: 'limits',
    title: 'Devices and known limits',
    description: 'What works where, and what we haven’t built yet.',
    articles: [
      {
        id: 'mobile-apps',
        q: 'What’s different in the iOS and Android apps?',
        a: (
          <>
            <p>Two things, and both are worth knowing before you rely on the app:</p>
            <ul>
              <li>
                <strong>No notifications at all.</strong> Push notifications are not shipped in the
                mobile apps, and web push doesn&rsquo;t work inside them either. Reminders reach you
                by email; the notification settings screen deliberately hides the controls it cannot
                honour.
              </li>
              <li>
                <strong>No purchases.</strong> Plans can be viewed but not bought or changed in the
                app. Use the website for anything to do with billing.
              </li>
            </ul>
            <p>Everything else — plants, tasks, households, sitters, chat — works the same.</p>
          </>
        ),
        text: 'Two things, and both are worth knowing before you rely on the app. No notifications at all: push notifications are not shipped in the mobile apps, and web push does not work inside them either. Reminders reach you by email, and the notification settings screen deliberately hides the controls it cannot honour. No purchases: plans can be viewed but not bought or changed in the app, so use the website for anything to do with billing. Everything else — plants, tasks, households, sitters, chat — works the same.',
      },
      {
        id: 'dark-mode',
        q: 'Is there a dark mode?',
        a: (
          <p>
            No. There was one, but it only recoloured the page background and left cards and forms
            unreadable, so it was removed rather than left half-working. It will come back when the
            components have real dark variants. <em>Settings → Preferences</em> currently offers
            display density (cozy or compact) only, and that choice is saved per device.
          </p>
        ),
        text: 'No. There was one, but it only recoloured the page background and left cards and forms unreadable, so it was removed rather than left half-working. It will come back when the components have real dark variants. Settings then Preferences currently offers display density, cozy or compact, only, and that choice is saved per device.',
      },
      {
        id: 'languages',
        q: 'Is the app available in other languages?',
        a: (
          <p>
            English only today. The translation machinery is in place and there are partial
            non-English files, but we keep the language picker hidden until a real human has
            translated and reviewed them — a half-translated interface is worse than an honest
            monolingual one. The picker will reappear on its own when that work lands.
          </p>
        ),
        text: 'English only today. The translation machinery is in place and there are partial non-English files, but we keep the language picker hidden until a real human has translated and reviewed them, because a half-translated interface is worse than an honest monolingual one. The picker will reappear on its own when that work lands.',
      },
      {
        id: 'placement-and-climate',
        q: 'How reliable are the climate tips and placement checks?',
        a: (
          <>
            <p>
              Treat them as prompts to go and look, not measurements. Climate tips need a saved
              household location and come from a public weather service: low-humidity warnings for
              tropicals, freeze alerts for plants in outdoor spaces, and skip-watering suggestions
              on rainy days — the last of which only applies to outdoor spaces you have marked as
              rain-exposed, so a covered porch stays on its normal schedule.
            </p>
            <p>
              Placement checks compare a space&rsquo;s light level and pet access, if you have
              recorded them, against care data for recognised species. Unknown details never produce
              a warning — which means silence is not a clean bill of health.
            </p>
            <p>
              None of this is regulated horticultural advice. If a plant is valuable or sentimental,
              don&rsquo;t rely on our reminders alone.
            </p>
          </>
        ),
        text: 'Treat them as prompts to go and look, not measurements. Climate tips need a saved household location and come from a public weather service: low-humidity warnings for tropicals, freeze alerts for plants in outdoor spaces, and skip-watering suggestions on rainy days, the last of which only applies to outdoor spaces you have marked as rain-exposed, so a covered porch stays on its normal schedule. Placement checks compare a space light level and pet access, if you have recorded them, against care data for recognised species. Unknown details never produce a warning, which means silence is not a clean bill of health. None of this is regulated horticultural advice. If a plant is valuable or sentimental, do not rely on our reminders alone.',
      },
      {
        id: 'something-broken',
        q: 'Something looks broken. Is it me or you?',
        a: (
          <p>
            Check the <Link to="/status">status page</Link> first — it checks our API live and will
            tell you if the problem is ours. If everything there is green, try a reload, then email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with what you did, what you
            expected and what happened. Never include a password or a sign-in code.
          </p>
        ),
        text: 'Check the status page first: it checks our API live and will tell you if the problem is ours. If everything there is green, try a reload, then email support with what you did, what you expected and what happened. Never include a password or a sign-in code.',
      },
    ],
  },
];

/** Questions the support inbox actually gets, surfaced above the fold. */
export const POPULAR: Array<{ section: string; article: string; label: string }> = [
  { section: 'billing', article: 'cancel', label: 'How do I cancel?' },
  {
    section: 'data',
    article: 'cancel-before-delete',
    label: 'Does deleting my account cancel my subscription?',
  },
  { section: 'reminders', article: 'no-reminder', label: 'Why didn’t my reminder arrive?' },
  { section: 'sitters', article: 'sitter-sees', label: 'What can a plant sitter see?' },
  {
    section: 'billing',
    article: 'after-cancel',
    label: 'What happens to my plants if I downgrade?',
  },
  { section: 'households', article: 'remove-member', label: 'How do I remove someone?' },
  { section: 'data', article: 'export', label: 'How do I export my data?' },
  { section: 'plants', article: 'plant-limit', label: 'I’ve hit my plant limit.' },
];

/**
 * Sections visible on this platform. Native store builds drop the billing
 * section: they cannot sell plans or open a payment flow, so purchase
 * instructions there answer a question the app cannot act on.
 */
export function visibleSections(native: boolean): HelpSection[] {
  return native ? HELP_SECTIONS.filter((section) => !section.webOnly) : HELP_SECTIONS;
}

export function findSection(id: string | undefined, native: boolean): HelpSection | undefined {
  if (!id) return undefined;
  return visibleSections(native).find((section) => section.id === id);
}
