/**
 * Blog post — targets long-tail "shared plant care app for couples" /
 * "how to split household chores without becoming a nag". This one is
 * more about the relational dynamic than the product. Length ~1200 words.
 */
export default function SharingPlantCare() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Almost every couple I&rsquo;ve talked to about plant care has the same argument once a
        season. Someone&rsquo;s noticed the fiddle leaf is drooping; someone else thought the other
        person was watering it; nobody wants to be the household nag, but here we are, having a
        tense conversation about a ficus.
      </p>
      <p>
        It&rsquo;s a tiny argument. It&rsquo;s also a perfect example of why shared chores break
        down even between people who love each other and try hard. The fix isn&rsquo;t better
        intentions. It&rsquo;s a small amount of structure.
      </p>

      <h2>The pattern</h2>
      <p>It usually goes like this:</p>
      <ol>
        <li>Person A buys a plant. They water it for the first month.</li>
        <li>
          Person B wants to help. They water it once or twice. Without a system, neither person
          knows when it was last done.
        </li>
        <li>
          Both assume the other has it covered. The plant goes ten days without water. Person A
          notices first.
        </li>
        <li>
          Person A asks &mdash; gently &mdash; if person B has been watering it. Person B feels
          accused. Now there&rsquo;s tension over the plant.
        </li>
        <li>
          Person A starts watering it again, alone. The plant survives. The dynamic doesn&rsquo;t.
        </li>
      </ol>
      <p>
        The thing that broke wasn&rsquo;t the watering. It was the visibility. Neither person could
        see what the other was doing.
      </p>

      <h2>Why &ldquo;just communicate&rdquo; isn&rsquo;t the answer</h2>
      <p>
        The standard advice is &ldquo;talk about it.&rdquo; That works for a weekend. It
        doesn&rsquo;t work for a year of weekly recurring care across twelve plants.
      </p>
      <p>
        Communicating about every watering is exactly the kind of overhead that makes shared chores
        feel like work. Nobody wants to send a text every time they pour water on a plant. Nobody
        wants to be the household project manager.
      </p>
      <p>
        What you actually want is for the watering to be visible{' '}
        <em>without anyone having to talk about it</em>. That&rsquo;s a structural problem, and
        structural problems need structural solutions.
      </p>

      <h2>What works</h2>
      <p>Three things, in order of importance:</p>

      <h3>1. A shared list</h3>
      <p>
        Both people see the same plants. Both people see the same watering schedule. When one person
        waters, the other sees it. This is the whole thing &mdash; everything else is decoration.
      </p>
      <p>
        A shared note in your phone&rsquo;s notes app technically counts. A spreadsheet counts. A
        purpose-built app counts. The form matters less than the fact that both people are looking
        at the same thing.
      </p>

      <h3>
        2. Reminders that find <em>someone</em>, not <em>everyone</em>
      </h3>
      <p>
        If a reminder pings both people, both people assume the other will handle it. If a reminder
        pings whoever&rsquo;s assigned, that person knows it&rsquo;s their turn. This is one of
        those small differences that completely changes the dynamic.
      </p>
      <p>
        It also means assignment has to rotate. Otherwise the &ldquo;assigned person&rdquo; just
        becomes the new household plant manager, and you&rsquo;re back to one person doing all the
        work.
      </p>

      <h3>3. Completion is visible</h3>
      <p>
        When someone waters a plant, the system should record it &mdash; ideally with their name and
        the time. Not so the other person can check up on them. So the other person{' '}
        <em>doesn&rsquo;t have to</em>.
      </p>
      <p>
        This is the hidden value of an activity feed. It removes the need to ask &ldquo;did you
        water the monstera?&rdquo; because you can just see that yes, your partner did, on Tuesday
        at 8pm. Conversation eliminated. Trust preserved.
      </p>

      <h2>The relationship math</h2>
      <p>
        There&rsquo;s a version of this where the plant care app feels like surveillance &mdash;
        tracking who did what, generating a report card. That&rsquo;s the wrong frame. The point
        isn&rsquo;t accountability; it&rsquo;s relief.
      </p>
      <p>
        The relief is in not having to remember. In not having to ask. In not having to{' '}
        <em>care</em> who did the watering, just that it got done. When the system handles those
        things, the people involved can spend their relational energy on better things than plant
        logistics.
      </p>
      <p>
        That&rsquo;s the actual benefit, and it scales beyond plants. The same pattern applies to
        feeding the cat, taking out the trash, paying the recurring bills, and any other low-stakes
        recurring task that needs coordinating. We picked plants because plants are visible,
        beloved, and small enough to start with.
      </p>

      <h2>If you want to use this pattern</h2>
      <p>
        You don&rsquo;t need our app. You need a shared system that meets the three criteria above.{' '}
        <a href="/">Family Greenhouse</a> happens to be the one I built &mdash; collaborative by
        default and structured around exactly this dynamic. The hosted site is currently a technical
        demonstration with new account registration paused. If a Google Sheet works for you, use the
        Google Sheet.
      </p>
      <p>
        The point isn&rsquo;t the tool. The point is that you stop having the same argument every
        season.
      </p>
    </article>
  );
}
