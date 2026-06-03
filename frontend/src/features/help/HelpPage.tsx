import { useMemo, useState } from 'react';
import { Card, CardHeader } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { ChevronDownIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

/**
 * In-app help/FAQ. Hand-curated rather than CMS-driven because the article
 * count is small and changes slowly. Filter is text-based; categories are
 * for browsing when the user doesn't have a specific question yet.
 */

interface HelpArticle {
  q: string;
  a: React.ReactNode;
  /** Plain-text body kept alongside the React node so the search filter
   *  can match content, not just titles. */
  searchText: string;
}

interface HelpSection {
  id: string;
  title: string;
  description: string;
  articles: HelpArticle[];
}

function md(strings: TemplateStringsArray): string {
  // Tag for clean co-location of the searchable plain-text version of an
  // article body. Templates here intentionally don't interpolate.
  return strings.join('');
}

const SECTIONS: HelpSection[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description: 'The first 5 minutes.',
    articles: [
      {
        q: 'How do I add my first plant?',
        a: (
          <>
            From the dashboard, click <strong>Plants</strong> in the sidebar and then the green{' '}
            <strong>Add plant</strong> button. You can upload a photo, pick a species (typing in the
            field shows suggestions from our 240-entry catalog plus, when configured, the Perenual
            species database), and add a location like &ldquo;kitchen window.&rdquo; Don&rsquo;t
            have a name in mind? Click <em>✨ Generate a fun name</em>.
          </>
        ),
        searchText: md`
From the dashboard, click Plants in the sidebar and then Add plant. Upload photo pick species suggestions Perenual catalog location kitchen window generate fun name
        `,
      },
      {
        q: "Why didn't my new plant appear with care suggestions?",
        a: (
          <>
            Care suggestions only appear when the species you picked matches an entry our species
            database recognizes. Free-text species (e.g.{' '}
            <em>&ldquo;the funky one Aunt Ruth gave me&rdquo;</em>) save fine but don&rsquo;t
            trigger the suggested watering schedule or care guide. Pick a suggestion from the
            dropdown to wire those features in.
          </>
        ),
        searchText: md`
Care suggestions species recognized Perenual database free-text watering schedule care guide pick suggestion dropdown
        `,
      },
      {
        q: 'I picked a species but no watering task was created.',
        a: (
          <>
            We only auto-create a watering task when Perenual returns a recommended cadence
            (frequent / average / minimum). Some species entries don&rsquo;t have one. You can
            always add a task manually from the plant&rsquo;s detail page — click{' '}
            <strong>Add task</strong> under Care.
          </>
        ),
        searchText: md`
watering task Perenual cadence frequent average minimum manually add task plant detail Care
        `,
      },
    ],
  },
  {
    id: 'sharing',
    title: 'Sharing & households',
    description: 'Letting your housemates help.',
    articles: [
      {
        q: 'How do I share my plants with my partner or roommates?',
        a: (
          <>
            Go to <strong>Household</strong> in the sidebar, then{' '}
            <strong>Generate invite link</strong>. Send the link to anyone you want to add.
            They&rsquo;ll create their own login and join your household automatically. The Seedling
            plan supports up to 2 members, Garden 6, Greenhouse 50.
          </>
        ),
        searchText: md`
share plants partner roommates Household sidebar Generate invite link create login Seedling Garden Greenhouse plan members
        `,
      },
      {
        q: 'Can I belong to more than one household?',
        a: (
          <>
            Yes. Once you have one household, the sidebar shows a switcher with an{' '}
            <strong>Add a household</strong> option. Each household has its own plants, tasks,
            members, and (optionally) location for climate tips. You can be admin in one and a
            member in another. Switching households doesn&rsquo;t move your default — your first
            household stays attached to your login for any client that doesn&rsquo;t use the
            switcher.
          </>
        ),
        searchText: md`
multiple households switcher add household admin member default first household login
        `,
      },
      {
        q: 'How do I promote someone to admin or remove them?',
        a: (
          <>
            On the <strong>Household</strong> page, each member has a role badge. Admins see promote
            / demote / remove buttons next to other members&rsquo; names. You can&rsquo;t demote
            yourself if you&rsquo;re the last admin — promote someone else first.
          </>
        ),
        searchText: md`
promote admin demote remove member household page role badge last admin
        `,
      },
    ],
  },
  {
    id: 'tasks',
    title: 'Tasks & reminders',
    description: 'Watering, fertilizing, pruning — and snoozing.',
    articles: [
      {
        q: "What's the difference between completing and snoozing a task?",
        a: (
          <>
            <strong>Done</strong> records that you watered / fertilized / etc. and pushes the
            next-due date forward by the task&rsquo;s frequency. <strong>Snooze</strong> bumps the
            next-due date by 1 / 3 / 7 days (or skip the cycle entirely) <em>without</em> recording
            a completion — useful when you&rsquo;ll get to it tomorrow but don&rsquo;t want to lose
            your streak.
          </>
        ),
        searchText: md`
Done complete task fertilize next-due frequency snooze 1 3 7 days skip cycle completion streak
        `,
      },
      {
        q: 'How do streaks work?',
        a: (
          <>
            A streak counts consecutive on-time completions of the same task. On-time means within
            1.5× the task&rsquo;s frequency — so a weekly task allows about 10 days of slack before
            the streak breaks. Each plant&rsquo;s detail page shows its longest historical streak in
            the care report.
          </>
        ),
        searchText: md`
streaks consecutive on-time completions 1.5x frequency slack break weekly longest historical care report
        `,
      },
      {
        q: "Why didn't my reminder go through?",
        a: (
          <>
            Check <strong>Settings → Notifications</strong>. Each channel (browser, email, SMS) is
            opt-in. Email is on by default; browser requires <em>Allow notifications</em> in your
            OS. SMS needs a phone number in E.164 format (e.g. <code>+15551234567</code>) and is on
            a free trial — paid plans only. Quiet hours pause email + SMS during the window you set;
            browser push respects your OS Do Not Disturb settings.
          </>
        ),
        searchText: md`
reminder notification email SMS browser opt-in E.164 phone quiet hours Do Not Disturb DND OS
        `,
      },
      {
        q: 'Can I apply the same care template to many plants at once?',
        a: (
          <>
            Yes. From the <strong>Plants</strong> page, click <strong>Apply template</strong>. Pick
            a template (water, fertilize, etc. with sensible defaults), then check the plants you
            want it applied to. Up to 50 at once.
          </>
        ),
        searchText: md`
care template multiple plants bulk apply Plants page button water fertilize 50 limit
        `,
      },
    ],
  },
  {
    id: 'climate-and-care',
    title: 'Climate & care guidance',
    description: 'Smarter advice based on your plants and your weather.',
    articles: [
      {
        q: 'What is the climate card on my dashboard?',
        a: (
          <>
            When your household has a saved location, the dashboard shows local weather plus derived
            care tips: low-humidity warnings for tropicals, freeze alerts for outdoor plants,
            &ldquo;skip watering today&rdquo; on rainy days, hot-day soil-moisture nudges. Set or
            change the location on the <strong>Household</strong> page (admin only).
          </>
        ),
        searchText: md`
climate card dashboard household location weather tips humidity tropicals freeze outdoor rain hot soil moisture admin
        `,
      },
      {
        q: 'How do I get a long-form care guide for my plant?',
        a: (
          <>
            Open the plant&rsquo;s detail page. If we recognize the species via Perenual,
            you&rsquo;ll see a <strong>Care guide</strong> card with watering, sunlight, pruning
            sections plus toxicity warnings and hardiness zones. Plants saved with free-text species
            names (we don&rsquo;t recognize them) won&rsquo;t show this card.
          </>
        ),
        searchText: md`
care guide plant detail Perenual species watering sunlight pruning toxicity hardiness zones free-text
        `,
      },
      {
        q: 'What are pest alerts?',
        a: (
          <>
            An opt-in feature. When enabled, you get a notification (max one per plant per quarter)
            when one of your plants is entering a typical pest season — spider mites, aphids, etc.
            Only fires for plants we recognize and only when you&rsquo;ve turned it on under{' '}
            <strong>Settings → Notifications</strong>.
          </>
        ),
        searchText: md`
pest alerts opt-in notification quarter spider mites aphids season recognized species notifications
        `,
      },
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics & insights',
    description: 'How your household is doing on care.',
    articles: [
      {
        q: 'What do the KPI tiles on the Analytics page mean?',
        a: (
          <>
            <strong>Plants</strong> and <strong>Active tasks</strong> are current totals.{' '}
            <strong>Done last 7 days</strong> sums completions from the daily series.{' '}
            <strong>Overdue now</strong> turns amber when there&rsquo;s anything past its due date —
            click into <em>Plants at risk</em> below to see the worst offenders.
          </>
        ),
        searchText: md`
KPI tiles analytics plants active tasks done last 7 days overdue amber plants at risk worst offenders
        `,
      },
      {
        q: 'Why is the by-task-type breakdown empty?',
        a: (
          <>
            That card shows year-to-date completions by task type. If your household joined this
            year and hasn&rsquo;t completed many tasks yet, the card hides itself. It&rsquo;ll start
            showing up after a handful of completions land.
          </>
        ),
        searchText: md`
by task type breakdown year to date completions empty hides few tasks new household
        `,
      },
    ],
  },
  {
    id: 'account',
    title: 'Account & data',
    description: 'Profile, photos, exports, and the goodbye flow.',
    articles: [
      {
        q: 'How do I edit my display name?',
        a: (
          <>
            <strong>Settings → Account</strong>. The name change propagates to every household
            you&rsquo;re a member of. Past activity events and task completion records keep the name
            you had at the time — we don&rsquo;t rewrite history.
          </>
        ),
        searchText: md`
edit name display profile settings account propagate household activity completion history
        `,
      },
      {
        q: 'My plant photo upload failed — what now?',
        a: (
          <>
            Photos must be JPEG, PNG, or WebP and under 5 MB. If the upload was interrupted (closed
            tab, dropped network) the plant won&rsquo;t show a broken image — we only commit the
            photo after the upload finishes. Just try again from the plant detail page.
          </>
        ),
        searchText: md`
plant photo upload failed JPEG PNG WebP 5 MB interrupted commit retry plant detail
        `,
      },
      {
        q: 'How do I export my data?',
        a: (
          <>
            <strong>Settings → Account → Download my data</strong>. Two CSVs land in your downloads
            — one for plants, one for tasks. RFC 4180 compatible; opens cleanly in any spreadsheet.
          </>
        ),
        searchText: md`
export data CSV download plants tasks RFC 4180 spreadsheet account settings
        `,
      },
      {
        q: 'How do I delete my account?',
        a: (
          <>
            <strong>Settings → Account → Delete my account</strong>. We wipe your login and remove
            you from every household you belong to. If you&rsquo;re the only admin in any of those
            households (with other members), promote someone else first or the request is refused.
            Past completion records keep your name on them as a historical artifact.
          </>
        ),
        searchText: md`
delete account settings remove household admin promote member historical completion records
        `,
      },
    ],
  },
  {
    id: 'preferences',
    title: 'Preferences & accessibility',
    description: 'Theme, density, language, keyboard.',
    articles: [
      {
        q: 'How do I change the theme or density?',
        a: (
          <>
            <strong>Settings → Preferences</strong>. Theme is light / dark / system; density is cozy
            or compact (about 25% less vertical padding). Settings save per device — your phone and
            laptop can differ.
          </>
        ),
        searchText: md`
theme dark light system density cozy compact preferences settings device per-device
        `,
      },
      {
        q: 'Is there a keyboard shortcut for search?',
        a: (
          <>
            <kbd>⌘K</kbd> on Mac, <kbd>Ctrl+K</kbd> elsewhere. Searches across your plants and
            tasks; press a result with Enter to jump straight to it.
          </>
        ),
        searchText: md`
keyboard shortcut search Cmd K Ctrl K plants tasks Enter
        `,
      },
      {
        q: 'Where are the Spanish (or other language) translations?',
        a: (
          <>
            We have the i18n infrastructure but only ship English today. Non-English translation
            files exist as scaffolding — we hide the language picker until they&rsquo;re translated
            by a real human. When that lands, the picker reappears automatically.
          </>
        ),
        searchText: md`
Spanish language translation i18n English picker hidden gated
        `,
      },
    ],
  },
  {
    id: 'billing',
    title: 'Billing',
    description: 'Plans, payments, cancellation.',
    articles: [
      {
        q: 'How do I cancel my subscription?',
        a: (
          <>
            <strong>Settings → Billing</strong> → <strong>Manage subscription</strong>. That opens
            our payment provider&rsquo;s portal where you can cancel, change plans, or update your
            payment method. Your plan stays active until the end of the current billing period.
          </>
        ),
        searchText: md`
cancel subscription settings billing manage portal change plan payment method billing period
        `,
      },
      {
        q: 'What happens when I downgrade past my plant or member limit?',
        a: (
          <>
            Existing plants and members stay — we never auto-delete data. You won&rsquo;t be able to
            add new ones until you&rsquo;re back under the cap, or upgrade again. Active tasks keep
            running.
          </>
        ),
        searchText: md`
downgrade plan plant limit member cap auto-delete data add new upgrade tasks running
        `,
      },
    ],
  },
];

function flatten(sections: HelpSection[]): Array<{ section: HelpSection; article: HelpArticle }> {
  return sections.flatMap((section) => section.articles.map((article) => ({ section, article })));
}

export function HelpPage() {
  useDocumentTitle('Help');
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.map((section) => {
      const articles = section.articles.filter(
        (a) => a.q.toLowerCase().includes(q) || a.searchText.toLowerCase().includes(q)
      );
      return { ...section, articles };
    }).filter((s) => s.articles.length > 0);
  }, [query]);

  const visibleArticles = flatten(filtered);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Guides & answers"
        title="Help"
        description={
          <>
            Quick answers to the questions we hear most. Still stuck? Email us at{' '}
            <a
              className="text-primary-700 hover:text-primary-800"
              href="mailto:hello@family-greenhouse.example"
            >
              hello@family-greenhouse.example
            </a>
            .
          </>
        }
      />

      <div className="relative">
        <MagnifyingGlassIcon
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"
          aria-hidden="true"
        />
        <input
          type="search"
          aria-label="Search help articles"
          placeholder="Search help…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="input pl-10"
        />
      </div>

      {visibleArticles.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-700">
            No articles match &ldquo;{query}&rdquo;. Try fewer words, or email us directly.
          </p>
        </Card>
      ) : (
        filtered.map((section) => (
          <Card key={section.id} padding="none">
            <CardHeader title={section.title} description={section.description} />
            <ul className="divide-y divide-gray-200">
              {section.articles.map((article) => {
                const id = `${section.id}::${article.q}`;
                const isOpen = open === id;
                return (
                  <li key={article.q}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      aria-expanded={isOpen}
                      aria-controls={`faq-${id}`}
                      onClick={() => setOpen(isOpen ? null : id)}
                    >
                      <span className="text-sm font-medium text-gray-900">{article.q}</span>
                      <ChevronDownIcon
                        className={clsx(
                          'h-5 w-5 flex-shrink-0 text-gray-500 transition-transform',
                          isOpen && 'rotate-180'
                        )}
                        aria-hidden="true"
                      />
                    </button>
                    {isOpen && (
                      <div
                        id={`faq-${id}`}
                        className="px-6 pb-4 text-sm text-gray-700 leading-relaxed"
                      >
                        {article.a}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}
