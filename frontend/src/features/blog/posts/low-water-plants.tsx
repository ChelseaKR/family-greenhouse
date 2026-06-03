/**
 * Blog post — targets the search query "low maintenance houseplants"
 * (~12K/mo) and the long-tail "plants for forgetful people". Voice is
 * deliberately not the breezy listicle voice that dominates this space;
 * we add real reasons-why and a contrarian take. Length ~1100 words.
 */
export default function LowWaterPlants() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Most &ldquo;low maintenance plants&rdquo; lists are actually &ldquo;plants the writer of the
        listicle has heard of.&rdquo; The real question for someone who keeps killing their plants
        isn&rsquo;t which species are <em>easiest</em> — it&rsquo;s which species fail in ways that
        are recoverable. Here are seven that meet that bar, ranked by how forgiving they are when
        your life gets busy for two months.
      </p>

      <h2>What &ldquo;low maintenance&rdquo; actually means</h2>
      <p>A houseplant is forgiving when these three things are true:</p>
      <ol>
        <li>
          <strong>It survives a missed watering.</strong> Plants like ferns punish a single dry-out
          by dropping fronds and never quite recovering. A snake plant will sit in dry soil for a
          month and shrug it off.
        </li>
        <li>
          <strong>It tolerates lighting you actually have.</strong> Bright indirect light is what
          every label says. Most apartments don&rsquo;t have it. The plants below mostly do fine in
          dim corners.
        </li>
        <li>
          <strong>Its problems are visible early.</strong> A plant that wilts before it dies is a
          forgiving plant — it&rsquo;s telling you to act. A plant that looks fine until the day
          it&rsquo;s dead is not forgiving, no matter what the listicle says.
        </li>
      </ol>

      <h2>The list, ranked</h2>

      <h3>1. ZZ plant (Zamioculcas zamiifolia)</h3>
      <p>
        The plant equivalent of a houseguest who never asks for anything. The rhizome stores water
        for weeks. Tolerates low light cheerfully. The only way to kill a ZZ plant is to overwater
        it, which is almost impossible if you&rsquo;re the kind of person reading this article.
      </p>

      <h3>2. Snake plant (Dracaena trifasciata)</h3>
      <p>
        Closely related to the ZZ in temperament — succulent leaves, water storage, indifference to
        neglect. Grows slowly, which sounds like a downside but is actually a feature: it
        doesn&rsquo;t need repotting every six months. Mine sits next to a north-facing window and
        gets watered when I remember, which is roughly every three weeks.
      </p>

      <h3>3. Pothos (Epipremnum aureum)</h3>
      <p>
        Thrives on neglect and has the courtesy to wilt visibly when you finally need to pay
        attention. Within a day of watering it&rsquo;s back to normal. The cuttings root in plain
        water in about a week, which means one pothos quickly becomes ten. Everyone has a pothos.
      </p>

      <h3>4. Cast iron plant (Aspidistra elatior)</h3>
      <p>
        Named for its toughness. Survives dim light, dry soil, and most common pests. The catch: it
        grows so slowly you may not realize it&rsquo;s alive. A friend of mine had one for nine
        years before producing a new leaf.
      </p>

      <h3>5. Spider plant (Chlorophytum comosum)</h3>
      <p>
        More forgiving than its delicate appearance suggests. Wilts when thirsty (recoverable),
        produces baby plants on long stems (free new plants), tolerates a wide range of light. The
        one downside: cats find it irresistible. If you have a cat and a spider plant, you really
        only have a cat.
      </p>

      <h3>6. Philodendron heartleaf (Philodendron hederaceum)</h3>
      <p>
        A pothos&rsquo;s slightly classier cousin. Same neglect-tolerance, prettier leaves, vines
        beautifully. If you want a plant that looks like you&rsquo;re putting in effort but you
        actually aren&rsquo;t, this is it.
      </p>

      <h3>7. Jade plant (Crassula ovata)</h3>
      <p>
        A succulent shrub that wants <em>less</em> water than you think. Watering it weekly will
        kill it; watering it every three weeks will make it thrive. A jade plant is the test of
        whether you&rsquo;ve learned that more attention isn&rsquo;t always better attention.
      </p>

      <h2>Plants that masquerade as low-maintenance</h2>
      <p>Some plants get put on every &ldquo;low maintenance&rdquo; list and do not belong:</p>
      <ul>
        <li>
          <strong>Fiddle leaf fig.</strong> The most-photographed plant on Instagram is also one of
          the most temperamental. They drop leaves if you move them, change the light, or breathe
          wrong. Skip until you&rsquo;ve mastered the boring plants.
        </li>
        <li>
          <strong>Boston fern.</strong> Wants high humidity, even moisture, and bright indirect
          light. None of those words describe an apartment in winter. Beautiful, demanding,
          frequently dead.
        </li>
        <li>
          <strong>Calathea.</strong> Striking foliage. Will let you know it hates you with brown
          crispy leaf edges within forty-eight hours.
        </li>
      </ul>

      <h2>The real lever: a system, not a species</h2>
      <p>
        Even the most forgiving plant needs <em>some</em> attention. If you&rsquo;ve killed three
        pothos, the problem isn&rsquo;t the species — it&rsquo;s that you don&rsquo;t have a way to
        remember when to water it. Picking a hardier species buys you more slack; having a watering
        schedule (even a sticky note) buys you more.
      </p>
      <p>
        Pair a forgiving plant with a system that actually tells you when to water and you&rsquo;ll
        have something alive a year from now. <a href="/">Family Greenhouse</a> is the system I
        built for this; a calendar reminder works too.
      </p>
    </article>
  );
}
