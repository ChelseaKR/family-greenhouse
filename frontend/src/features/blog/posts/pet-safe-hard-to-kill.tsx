/**
 * Blog post — targets the search intent behind "pet-safe houseplants" +
 * "hard to kill pet-friendly plants". The trick of this query is that the
 * two requirements (safe AND tough) knock out most of the plants the
 * generic lists name, so the post is honest about that tension. Voice is
 * personal + anti-listicle, ends in the usual low-key product mention.
 * Length ~1100 words.
 */
export default function PetSafeHardToKill() {
  return (
    <article className="prose-fg">
      <p className="lead">
        &ldquo;Pet-safe&rdquo; and &ldquo;hard to kill&rdquo; sound like two easy boxes to tick. Put
        them together and most of the internet&rsquo;s favourite beginner plants fall out of the
        running &mdash; pothos, ZZ, snake plant, peace lily, aloe, philodendron are all toxic to
        cats and dogs. What&rsquo;s left is a shorter, more honest list than the listicles admit.
      </p>

      <h2>Why this list is harder than it looks</h2>
      <p>
        The plants people reach for when they want something forgiving are forgiving for a reason:
        they store water, tolerate low light, and shrug off neglect. A lot of that toughness comes
        from the same chemistry that makes them unpleasant to chew &mdash; the calcium oxalate
        crystals in pothos and philodendron, the saponins in a snake plant. Tough and toxic
        correlate more than anyone selling you a plant wants to mention.
      </p>
      <p>
        So the real pet-safe-and-tough list is built from a different group: spider plants,
        calatheas (sort of), certain palms, a few ferns. The catch is that some of those are
        pet-safe but fussy. Below are the ones that genuinely clear both bars, ranked by how much
        abuse they forgive.
      </p>

      <h2>The plants that actually clear both bars</h2>

      <h3>1. Spider plant (Chlorophytum comosum)</h3>
      <p>
        The clear winner. Non-toxic to cats and dogs per the ASPCA, and one of the most forgiving
        plants there is &mdash; it wilts visibly when thirsty, perks up within hours of water, and
        hands you free baby plants on long runners. The only complication is that cats find the
        dangling leaves irresistible, which is harder on the plant than the cat. Hang it up and
        everyone&rsquo;s happy. If I could only recommend one plant to a household with a pet, this
        is it.
      </p>

      <h3>2. Parlour palm (Chamaedorea elegans)</h3>
      <p>
        Non-toxic, genuinely low-light tolerant, and slow enough that it almost never needs
        repotting. It asks for a drink when the top inch of soil dries and otherwise leaves you
        alone. It gives a room that leafy, established look without the toxicity asterisk that hangs
        over most of the &ldquo;statement&rdquo; plants. A bit prone to spider mites in very dry
        air, but that&rsquo;s the worst you&rsquo;ll deal with.
      </p>

      <h3>3. Areca palm (Dypsis lutescens)</h3>
      <p>
        Bigger and thirstier than the parlour palm but every bit as pet-safe. This is the one to buy
        if you want a floor plant a cat will inevitably brush past &mdash; it&rsquo;s non-toxic, so
        a nibbled frond is a non-event. It wants brighter light and more consistent water than the
        parlour palm, so it&rsquo;s a notch fussier, but nothing a regular check-in won&rsquo;t
        cover.
      </p>

      <h3>4. Boston fern (Nephrolepis exaltata)</h3>
      <p>
        Non-toxic and beautiful, but here&rsquo;s where &ldquo;hard to kill&rdquo; starts to strain.
        Ferns want humidity and even moisture, and a Boston fern in a dry apartment in winter sheds
        fronds dramatically. It clears the pet-safe bar with room to spare; it clears the
        hard-to-kill bar only if your home is humid or you&rsquo;re willing to fuss. Honest framing:
        safe, gorgeous, demanding.
      </p>

      <h3>5. Calathea (Goeppertia)</h3>
      <p>
        I&rsquo;m including it with a caveat. Calatheas are non-toxic to cats and dogs per the
        ASPCA, and they have the best foliage on this whole list &mdash; but they are not hard to
        kill. They want filtered water, steady moisture, and real humidity, and they&rsquo;ll crisp
        at the edges to tell you when they don&rsquo;t get it. Buy a calathea for its looks and its
        pet safety, not for forgiveness. If you want safe <em>and</em> tough, start with the spider
        plant and work up to this.
      </p>

      <h2>The ones to skip, even though every list includes them</h2>
      <ul>
        <li>
          <strong>Succulents as a category.</strong> Some are safe, many aren&rsquo;t, and
          &ldquo;succulent&rdquo; isn&rsquo;t a useful safety label. Aloe vera in particular gets
          recommended constantly and is toxic to cats and dogs &mdash; the soothing gel is fine, the
          plant is not. Check the specific species, never the category.
        </li>
        <li>
          <strong>&ldquo;Lucky&rdquo; and gift plants.</strong> Jade, ZZ, and the peace lilies that
          turn up in supermarket bouquets are all toxic. A plant being marketed as low-maintenance
          tells you nothing about whether it&rsquo;s pet-safe.
        </li>
        <li>
          <strong>Anything called a &ldquo;lily.&rdquo;</strong> True lilies (Lilium) and daylilies
          are an emergency-level hazard to cats &mdash; even pollen or vase water can cause kidney
          failure. Peace lilies aren&rsquo;t true lilies and are far less dangerous, but the word
          &ldquo;lily&rdquo; on a label is always worth a second look.
        </li>
      </ul>

      <h2>How to actually check, in ten seconds</h2>
      <p>
        Don&rsquo;t trust the listicle and don&rsquo;t trust the plant-shop label, which is usually
        wrong or absent. The reference vets point people to is the ASPCA&rsquo;s toxic and non-toxic
        plant database, which distinguishes cats from dogs and tells you what actually happens
        rather than a vague &ldquo;toxic.&rdquo;
      </p>
      <p>
        We built a free version of that lookup into Family Greenhouse so you can check before you
        buy &mdash; type a plant name into the <a href="/pet-safe">pet-safe checker</a>, no signup,
        and it gives you the cats-versus-dogs verdict in plain language, grounded in the same ASPCA
        data. It&rsquo;s the fastest way to settle the question standing in the aisle of a garden
        centre.
      </p>

      <h2>The honest summary</h2>
      <p>
        If you have a pet and want something you genuinely can&rsquo;t kill, buy a spider plant and
        a parlour palm and call it a day. If you want the showy foliage, a calathea is safe but
        demanding, so pair it with a system that reminds you to keep up its routine.{' '}
        <a href="/">Family Greenhouse</a> is the one I built for exactly that &mdash; it tracks each
        plant&rsquo;s schedule and, for the fussier ones, holds the care notes so &ldquo;use
        filtered water&rdquo; doesn&rsquo;t live in one person&rsquo;s head. A spreadsheet works
        too. The point is to check the safety first, then build the habit second.
      </p>
    </article>
  );
}
