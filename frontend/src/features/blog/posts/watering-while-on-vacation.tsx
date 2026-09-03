/**
 * Blog post — targets the high-intent seasonal query "how to water plants
 * while on vacation" / "keep plants alive while away". Structured by trip
 * length because that's the actual decision the reader is making, and
 * honest about which of the popular hacks don't work. Length ~1200 words.
 */
export default function WateringWhileOnVacation() {
  return (
    <article className="prose-fg">
      <p className="lead">
        The honest answer to &ldquo;how do I water my plants while I&rsquo;m away&rdquo; depends
        almost entirely on how long you&rsquo;re gone. Four days is a non-problem. Two weeks is a
        real one. Most of the advice online blurs those together and sends people building elaborate
        drip systems for a long weekend.
      </p>

      <h2>Up to five days: do almost nothing</h2>
      <p>
        Most houseplants are fine. Water everything thoroughly the morning you leave, let the pots
        drain properly, and go.
      </p>
      <p>Two adjustments worth making:</p>
      <ul>
        <li>
          <strong>Pull plants back from hot windows.</strong> A south-facing sill in July dries a
          pot far faster than the middle of the same room. Moving a plant a metre inland for a week
          costs it nothing and buys you days.
        </li>
        <li>
          <strong>Close the blinds and leave the heating off.</strong> Cooler and dimmer means
          slower growth and slower drying. Your plants will not miss five days of sunshine.
        </li>
      </ul>
      <p>
        Skip the gadgets entirely at this length. Succulents, snake plants, ZZ plants and most
        things with thick leaves would be fine for three times as long.
      </p>

      <h2>One to two weeks: buy time mechanically</h2>
      <p>
        This is the range where you need to do something, and where the cheap tricks actually earn
        their keep. In rough order of how reliable I&rsquo;ve found them:
      </p>

      <h3>Group everything together</h3>
      <p>
        Move all your plants into one room, close together, out of direct sun. Plants transpire, so
        a huddle raises the humidity around itself and everything dries more slowly. It costs
        nothing, it can&rsquo;t go wrong, and it&rsquo;s the single highest-value move on this list.
      </p>

      <h3>The wick</h3>
      <p>
        A strip of cotton or a shoelace, one end buried a few inches into the pot, the other in a
        jar of water sitting higher than the soil. Capillary action pulls water along the wick at
        roughly the rate the soil dries.
      </p>
      <p>
        It works. It also fails silently if the wick dries out and breaks the water column, so
        <strong> set it up a week before you leave and check it</strong>. A wick you tested is a
        good system; a wick you improvised at 6am on the way to the airport is a coin flip.
      </p>

      <h3>The bathtub tray</h3>
      <p>
        Line a bath or a large tray with a wet towel, stand the pots on it, and add an inch of
        water. The pots drink through their drainage holes as they dry. Works well for a week, and
        works best for thirsty tropicals in plastic nursery pots.
      </p>
      <p>
        Two cautions: this is bottom-watering left on indefinitely, so anything that hates wet feet
        &mdash; succulents, cacti, snake plants &mdash; should stay out of the tub. And a windowless
        bathroom is a dark place to park a plant for two weeks. A bright bathroom or a tray in a
        living room is better.
      </p>

      <h3>Self-watering pots and reservoir spikes</h3>
      <p>
        If you already have self-watering planters, fill them and stop worrying. If you&rsquo;re
        buying something, the terracotta spikes that screw into a wine bottle are the middle option
        &mdash; more controlled than a bare bottle, less fiddly than a wick.
      </p>
      <p>
        What I&rsquo;d avoid is the plain upturned bottle jammed into the soil. In dense or loose
        potting mix it tends to either dump its whole volume in an afternoon or seal up and deliver
        nothing, and you find out which when you get home.
      </p>

      <h3>The plastic-bag greenhouse</h3>
      <p>
        A clear bag over a plant, loosely tented on sticks, traps humidity and can hold a fussy
        plant for a couple of weeks. Genuinely useful for ferns and calatheas, which suffer most in
        a dry empty flat.
      </p>
      <p>
        Keep it out of direct sun. A sealed bag in a sunny window becomes an oven, and a cooked
        plant is a worse outcome than a dry one.
      </p>

      <h2>Over two weeks: you need a person</h2>
      <p>
        Past a fortnight, every passive system is either running dry or drowning something. If you
        have a collection you care about, get a human in.
      </p>
      <p>
        It doesn&rsquo;t need to be a plant person, and it doesn&rsquo;t need to be often. One visit
        in the middle of a three-week trip resets the clock on everything. A neighbour with a key, a
        friend who wants your parking space, a housemate who stayed behind &mdash; all fine. What
        matters is that they get instructions specific enough to follow without judgement calls,
        which is a genuinely different skill from knowing how to care for plants yourself. We wrote
        a whole post on that:{' '}
        <a href="/blog/what-to-leave-for-a-plant-sitter">what to leave for a plant sitter</a>.
      </p>

      <h2>The mistake people make when they get back</h2>
      <p>
        Coming home to droopy plants triggers an urge to fix everything at once: water every pot to
        the brim, move things back, repot the sad ones, feed them all. Don&rsquo;t.
      </p>
      <p>
        Water normally, put things back where they were, and wait a week before deciding anything is
        actually damaged. Some leaf loss after a trip is ordinary. The plants that look worst on day
        one are frequently fine on day ten, and the ones that get killed are usually killed by the
        rescue rather than the neglect.
      </p>

      <h2>The bit that&rsquo;s easy to forget</h2>
      <p>
        Whoever covers for you &mdash; a sitter, a housemate, the partner who stayed home &mdash;
        needs to know what was already done before you left, or they&rsquo;ll redo it. Coming back
        to a plant that was watered the day you left and again the day after by someone being
        helpful is the classic version of this.
      </p>
      <p>
        <a href="/">Family Greenhouse</a> handles the handover directly: you can share a time-boxed
        link with a sitter, who sees only the tasks that are actually due while you&rsquo;re gone
        and taps them off as they go, without creating an account or joining your household. When
        you get back, the log tells you exactly what happened. A note on the kitchen table does the
        same job for four plants; it&rsquo;s the fourteen-plant version where the tooling starts to
        pay.
      </p>
    </article>
  );
}
