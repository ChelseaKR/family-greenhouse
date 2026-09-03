/**
 * Blog post — targets "plant sitter instructions" / "what to tell someone
 * watering your plants" / "plant sitting checklist". Pairs with the
 * vacation post: that one covers the trip, this one covers the handover.
 * The advice is deliberately about writing instructions a non-expert can
 * follow, not about plant care itself. Length ~1150 words.
 */
export default function PlantSitterHandoff() {
  return (
    <article className="prose-fg">
      <p className="lead">
        The reason plant-sitting goes wrong is almost never that the sitter didn&rsquo;t care.
        It&rsquo;s that they were handed instructions written by someone who already knows the
        answer. &ldquo;Water when the top inch is dry&rdquo; is a perfectly good rule and a terrible
        instruction, because it asks a person who has never met your monstera to make a judgement
        call and be confident about it.
      </p>

      <h2>Write actions, not conditions</h2>
      <p>
        Everything good about a set of sitting instructions follows from this. Your sitter should be
        able to do the whole job without deciding anything.
      </p>
      <p>Compare:</p>
      <ul>
        <li>
          <strong>Bad:</strong> &ldquo;Water the ferns when they look thirsty, they&rsquo;re quite
          sensitive.&rdquo;
        </li>
        <li>
          <strong>Good:</strong> &ldquo;Saturday: two mugs of water into the big fern by the
          bookshelf. That&rsquo;s the only thing that needs doing this week.&rdquo;
        </li>
      </ul>
      <p>
        The second version can be executed by someone thinking about something else, which is the
        realistic condition your sitter is in. Specific vessel, specific quantity, specific day,
        specific plant, nothing to interpret.
      </p>

      <h2>The five things to actually leave them</h2>

      <h3>1. A list of only the plants that need something</h3>
      <p>
        Not your whole collection. If eleven of your fifteen plants can go a fortnight untouched,
        they don&rsquo;t belong on the list &mdash; putting them there just creates work and
        anxiety. Write down the four that need attention and say plainly that everything else is
        already handled.
      </p>

      <h3>2. Which plant is which, unambiguously</h3>
      <p>
        Species names are useless to a non-plant-person. Location plus size plus a photo is what
        works: &ldquo;the tall one on the floor next to the TV.&rdquo; If two plants look similar,
        put a sticky note on the pot. A photo of each plant with its instruction next to it removes
        every remaining doubt, and takes about four minutes to make on your phone.
      </p>

      <h3>3. The amount, in an object they can see</h3>
      <p>
        &ldquo;A good soak&rdquo; means nothing. &ldquo;Fill this blue jug to the line and pour it
        all in&rdquo; means something. Leave the jug or the watering can out on the counter where
        they&rsquo;ll trip over it, and fill in the measurement in terms of that specific object.
      </p>

      <h3>4. Explicit permission to skip</h3>
      <p>
        This is the one people leave out and it matters more than the rest. Tell your sitter, in
        writing: <strong>if you&rsquo;re unsure, don&rsquo;t water it.</strong> A plant that misses
        a watering is nearly always fine. A plant that gets watered three times because a
        conscientious person kept worrying about it is at real risk, and root damage from a
        waterlogged fortnight is much harder to walk back than a bit of drought.
      </p>
      <p>
        Saying this also does something for the sitter, who is usually more nervous about killing
        your plants than you are. Take the pressure off and they&rsquo;ll do a better job.
      </p>

      <h3>5. What to do if something looks wrong</h3>
      <p>
        Give them one instruction and one contact method. &ldquo;If anything looks dramatic, send me
        a photo &mdash; don&rsquo;t try to fix it.&rdquo; That&rsquo;s it. Most of what looks
        alarming to a non-plant-person (a yellow lower leaf, a bit of drooping) is normal, and the
        fixes an anxious helper reaches for &mdash; more water, more sun, a bigger pot &mdash; are
        usually worse than the problem.
      </p>

      <h2>Things not to put in the instructions</h2>
      <ul>
        <li>
          <strong>Misting.</strong> It&rsquo;s a lot of effort for a very short-lived humidity bump,
          and it turns a five-minute job into a chore your sitter starts resenting on day three.
        </li>
        <li>
          <strong>Fertiliser.</strong> Nothing needs feeding during a two-week absence, and a
          mis-measured dose is a real way to hurt a plant.
        </li>
        <li>
          <strong>Rotating, pruning, repotting, dusting.</strong> All of it can wait for you.
        </li>
        <li>
          <strong>Explanations.</strong> You do not need to teach them why. A paragraph on why the
          calathea wants filtered water gives a person one more thing to get wrong.
        </li>
      </ul>

      <h2>Set it up before you need it</h2>
      <p>
        The universal failure is writing the instructions at 11pm the night before a flight, from
        memory, badly. If you write them once now &mdash; while you&rsquo;re calm and standing next
        to the plants &mdash; you can reuse them for every trip, adjusting the frequencies for the
        season.
      </p>
      <p>
        Take the photos at the same time. A shared album or a note with four photos and four
        sentences is the entire artefact, and it&rsquo;s the difference between a sitter who feels
        capable and one who is quietly guessing.
      </p>

      <h2>If you want this to be automatic</h2>
      <p>
        This is one of the things <a href="/">Family Greenhouse</a> was built for. You can hand a
        sitter a time-boxed link: they open it, see only the tasks actually due while you&rsquo;re
        away &mdash; &ldquo;Water the Monstera&rdquo;, with where it lives &mdash; and tap them off
        as they go. No account, no sign-up, no joining your household, and the link stops working
        when you&rsquo;re back. You come home to a log of what was done and when, instead of trying
        to reconstruct it from a half-remembered conversation.
      </p>
      <p>
        A note on the counter genuinely works too, and for three plants it&rsquo;s the right amount
        of technology. The principle doesn&rsquo;t change either way: give a person actions, not
        conditions, and tell them it&rsquo;s fine to skip.
      </p>
    </article>
  );
}
