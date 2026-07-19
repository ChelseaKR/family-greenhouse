/**
 * Blog post — targets the search query "how to remember to water plants"
 * (~3K/mo per the marketing plan). Voice is personal + slightly contrarian
 * so it doesn't read as AI-generated SEO copy. Length ~1100 words.
 */
export default function RememberingToWater() {
  return (
    <article className="prose-fg">
      <p className="lead">
        The honest answer most plant blogs won&rsquo;t give you: you forget to water your plants
        because remembering is a job your brain isn&rsquo;t designed for. It&rsquo;s not a moral
        failing. It&rsquo;s a system problem. Fix the system and the watering takes care of itself.
      </p>

      <h2>Why &ldquo;just remember&rdquo; doesn&rsquo;t work</h2>
      <p>
        Plants don&rsquo;t fit cleanly into your week. A peace lily wants water every five-ish days.
        A jade plant wants water every fifteen. A fiddle leaf fig wants water when the top inch of
        soil is dry, which is between four and ten days depending on the season.
      </p>
      <p>
        That&rsquo;s a different schedule per plant, all running on different clocks, none of which
        line up with anything else in your life. The only way to keep all of them straight in your
        head is to think about plants more often than is reasonable. Most people don&rsquo;t — and
        the plant pays for it.
      </p>

      <h2>Three systems that actually work</h2>
      <p>
        I&rsquo;ve tried all of these. They&rsquo;re ranked here from worst to best, with the
        trade-offs for each.
      </p>

      <h3>1. The sticky-note method</h3>
      <p>
        A sticky note on the fridge that says &ldquo;water Monstera Mondays.&rdquo; Works for one or
        two plants. Falls apart at three. The notes accumulate, you stop reading them, and
        you&rsquo;re back where you started. Worse: when you skip a Monday, the note doesn&rsquo;t
        adjust. It just keeps lying to you.
      </p>

      <h3>2. The calendar reminder</h3>
      <p>
        Recurring events in Google Calendar. Better than a sticky note because the reminder finds
        you wherever you are. Worse than it sounds because completing a calendar event doesn&rsquo;t
        reschedule the next one based on what actually happened. If you watered three days late,
        your next reminder still arrives a week from when you should have watered, not a week from
        when you actually did.
      </p>

      <h3>3. A real plant-care app</h3>
      <p>
        The thing calendar reminders are missing is feedback. When you mark a watering done, the
        next due date should shift forward from the moment you marked it done — not from when it was
        scheduled. That single behavior is the difference between a system that drifts and a system
        that stays in sync with your actual life.
      </p>
      <p>
        It&rsquo;s also why <em>shared</em> plant care is a real problem: when there are two people
        in the house and only one set of reminders, the wrong person sometimes gets the reminder,
        and the other person has no idea whether the watering happened. The solution is shared state
        — a single source of truth that both people see.
      </p>

      <h2>The minimum reliable setup</h2>
      <p>For each plant, you need three pieces of information:</p>
      <ul>
        <li>
          <strong>Frequency.</strong> Not exact — start with a guess and adjust. &ldquo;Every 7
          days&rdquo; is fine for most tropicals; jade and succulents go 14+. The number matters
          less than the system.
        </li>
        <li>
          <strong>Last watered date.</strong> Without this, the system can&rsquo;t calculate the
          next due date.
        </li>
        <li>
          <strong>Who&rsquo;s doing it next.</strong> If you live alone, that&rsquo;s you. If you
          don&rsquo;t, decide ahead of time — or rotate.
        </li>
      </ul>
      <p>
        Most people skip the third one and then wonder why their plants died after their partner
        forgot.
      </p>

      <h2>What to actually do this week</h2>
      <p>
        Walk around your home with a notebook (or a phone). For each plant, write down its name (a
        guess is fine), where it lives, and your best estimate for how often it&rsquo;s been getting
        watered. Then pick a system — anything from a spreadsheet to a dedicated app — and put each
        plant in it.
      </p>
      <p>
        The most important thing is that the system records when watering actually happened, not
        when it was scheduled. Anything that does that is better than nothing. Anything that
        doesn&rsquo;t is just a nicer-looking sticky note.
      </p>

      <h2>A shared-system example</h2>
      <p>
        We built <a href="/">Family Greenhouse</a> because every other plant-care app we tried was
        built for one person, and most plant care happens in households. It does the feedback-loop
        thing (completing a task pushes the next due date forward from now, not from the original
        schedule), and it lets multiple people see and act on the same plant list. It is free for
        households with up to 10 plants; the spreadsheet still beats the sticky note.
      </p>
    </article>
  );
}
