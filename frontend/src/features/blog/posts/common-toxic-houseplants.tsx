/**
 * Blog post — targets "toxic houseplants for cats" / "poisonous houseplants
 * for dogs" / "which houseplants are toxic". The format that wins this query
 * is pairing each common toxic plant with a safer swap, so the reader leaves
 * with an action rather than just a list of things to fear. Grounded in the
 * ASPCA database; voice stays personal and anti-listicle. Ends in the usual
 * soft product mention. Length ~1150 words.
 */
export default function CommonToxicHouseplants() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Most &ldquo;toxic plants&rdquo; posts are a wall of scary names with no advice on what to
        actually buy instead. That&rsquo;s the wrong shape. If your cat chews leaves or your dog
        grazes the floor plants, you don&rsquo;t need a longer list of fears &mdash; you need a
        swap. Here are the most common toxic houseplants, what each one does, and a genuinely safer
        plant that scratches the same itch.
      </p>

      <h2>First, the one real emergency</h2>
      <p>
        Before the swaps, the plant that deserves its own paragraph: true lilies (Lilium) and
        daylilies (Hemerocallis). For cats these aren&rsquo;t &ldquo;mildly toxic&rdquo; &mdash;
        even pollen, a chewed leaf, or the water from a vase can cause sudden kidney failure, and
        it&rsquo;s often fatal without fast treatment. If you have a cat, true lilies simply
        shouldn&rsquo;t come into the house, cut flowers included. Everything else on this page is
        the ordinary, recoverable kind of toxic. This one isn&rsquo;t.
      </p>

      <h2>The common toxic ones, and what to buy instead</h2>

      <h3>Pothos &rarr; spider plant</h3>
      <p>
        Pothos is the default beginner vine, and it&rsquo;s toxic to cats and dogs &mdash; the
        calcium oxalate crystals cause mouth pain, drooling, and vomiting if chewed. The swap is the
        spider plant: same trailing, hang-it-up habit, same near-indestructible temperament, but
        non-toxic to both cats and dogs per the ASPCA. It even gives you free babies on runners.
        It&rsquo;s the closest thing to a like-for-like replacement on this list.
      </p>

      <h3>Aloe vera &rarr; haworthia</h3>
      <p>
        Aloe gets recommended as a beginner succulent and a first-aid plant, but it&rsquo;s toxic to
        cats and dogs &mdash; the gel is fine, the leaf isn&rsquo;t. If you want a small spiky
        succulent for a sunny sill, a haworthia (the little &ldquo;zebra&rdquo; succulents) gives
        you the same look and the same drought-loving, hard-to-overthink care, and isn&rsquo;t on
        the toxic list. You lose the burn-gel trick, but you keep the windowsill aesthetic.
      </p>

      <h3>Snake plant &rarr; cast iron plant</h3>
      <p>
        The snake plant is the go-to &ldquo;tough upright architectural&rdquo; plant, and its
        saponins make it mildly toxic to pets. For the same upright, neglect-tolerant, low-light
        silhouette without the toxicity, the cast iron plant (Aspidistra) is the swap &mdash;
        non-toxic, famously indestructible, and happy in the same dim corners. It grows slowly
        enough to test your patience, but it asks for nothing and won&rsquo;t hurt a curious pet.
      </p>

      <h3>Peace lily &rarr; calathea</h3>
      <p>
        People buy peace lilies for the lush leaves and white flowers, and they&rsquo;re toxic to
        cats and dogs (though, despite the name, not a true lily and not the kidney-failure kind).
        If you want showy foliage at floor level where a pet roams, a calathea is the swap:
        non-toxic to both per the ASPCA, with patterns far prettier than a peace lily&rsquo;s plain
        green. The trade is care &mdash; a calathea is fussier about water and humidity &mdash; but
        it&rsquo;s one of the few genuinely pet-safe statement plants.
      </p>

      <h3>ZZ plant &rarr; parlour palm</h3>
      <p>
        The ZZ is the &ldquo;I can&rsquo;t keep anything alive&rdquo; plant, and it&rsquo;s toxic to
        cats and dogs (the reputation overstates it, but it&rsquo;s real). If you want
        near-indestructible <em>and</em> pet-safe, the parlour palm (Chamaedorea) is the swap:
        non-toxic, low-light tolerant, slow, and forgiving. It&rsquo;s leafier and softer than a ZZ
        rather than glossy and architectural, but it fills the same &ldquo;tough green thing for a
        dim room&rdquo; slot.
      </p>

      <h3>Philodendron &amp; monstera &rarr; spider plant or palm</h3>
      <p>
        The whole philodendron and monstera family carries the same calcium oxalate crystals as
        pothos, so they&rsquo;re toxic to cats and dogs too. There isn&rsquo;t a perfect non-toxic
        monstera lookalike &mdash; those dramatic split leaves are genuinely one of a kind &mdash;
        so the honest move is to enjoy them up high out of reach, or accept a different shape
        entirely: a spider plant for trailing, a palm for height. Don&rsquo;t let a list tell you a
        pet-safe plant looks exactly like a monstera. It doesn&rsquo;t.
      </p>

      <h3>Dieffenbachia &rarr; just skip it (or calathea)</h3>
      <p>
        Dieffenbachia (&ldquo;dumb cane&rdquo;) is the one I&rsquo;d single out to avoid in a home
        with pets or small children. It&rsquo;s toxic to cats, dogs, and people, and its sap is
        harsher than the average houseplant &mdash; bad enough to numb and swell the mouth and
        throat. For similar big patterned leaves without that risk, a calathea is again the pet-safe
        swap. This is the one plant on the list where the right answer is often just
        &ldquo;don&rsquo;t.&rdquo;
      </p>

      <h2>The trap in the word &ldquo;toxic&rdquo;</h2>
      <p>
        Notice how much range there is in that one word. A nibbled pothos means a drooly, miserable
        afternoon and a full recovery. A chewed true lily is a veterinary emergency. A poinsettia
        &mdash; the plant everyone fears at Christmas &mdash; is barely an upset stomach.
        &ldquo;Toxic to pets&rdquo; on a label flattens all of that into one scary syllable, which
        is exactly why people either panic over a safe plant or relax around a dangerous one.
      </p>
      <p>
        What you actually want is the specific verdict: which animal, how bad, and what to do. The
        ASPCA&rsquo;s toxic and non-toxic plant database is the reference vets point to for exactly
        that, because it separates cats from dogs and describes the real effect.
      </p>

      <h2>Check before you buy</h2>
      <p>
        We built a free lookup into Family Greenhouse so you don&rsquo;t have to memorise any of
        this &mdash; type a plant name into the <a href="/pet-safe">pet-safe checker</a> and it
        returns the cats-versus-dogs answer in plain language, grounded in the same ASPCA data, no
        signup required. It&rsquo;s meant for the moment you&rsquo;re standing in a shop holding a
        plant with a useless label, deciding whether it&rsquo;s coming home.
      </p>
      <p>
        And once a plant is home, the safe ones still need keeping alive.{' '}
        <a href="/">Family Greenhouse</a> tracks each plant&rsquo;s schedule and reminds the right
        person, which matters most for the fussier safe picks like calatheas. But the order is what
        counts: check the safety first, then build the watering habit. A dead pet-safe plant helps
        no one, and a thriving toxic one is a hazard &mdash; getting both right is the whole job.
      </p>
    </article>
  );
}
