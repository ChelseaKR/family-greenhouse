/**
 * Blog post — targets the high-intent diagnostic query "signs of
 * overwatering" / "overwatered plant how to fix". Leads with the
 * counterintuitive bit (an overwatered plant looks thirsty), keeps the
 * household angle honest rather than forced: two carers, double doses.
 * Length ~1150 words.
 */
export default function SignsOfOverwatering() {
  return (
    <article className="prose-fg">
      <p className="lead">
        The cruel thing about overwatering is that it looks like underwatering. Drooping leaves,
        yellowing, a plant that seems to be crying out for a drink &mdash; so you water it again,
        and it gets worse, and you water it again. Overwatering is the mistake attentive people
        make, which is why it&rsquo;s worth being able to tell the two apart.
      </p>

      <h2>What&rsquo;s actually happening</h2>
      <p>
        Roots need air as much as water. Potting mix holds water in the spaces between particles;
        when those spaces stay full, the roots can&rsquo;t take up oxygen, they begin to die, and
        rot organisms move into the dead tissue.
      </p>
      <p>
        A plant with damaged roots can&rsquo;t absorb water, so it wilts &mdash; while sitting in
        wet soil. That&rsquo;s the whole trap. The visible symptom is drought; the actual cause is
        the opposite.
      </p>
      <p>
        Worth being precise about the word: overwatering is usually about{' '}
        <em>frequency and drainage</em>, not volume. Giving a plant a big drink and letting it drain
        out completely is fine. Giving it a small drink every second day, or letting a pot with no
        drainage hole stay damp, is what causes this.
      </p>

      <h2>The signs, in the order they usually appear</h2>
      <ul>
        <li>
          <strong>Soil that&rsquo;s still wet days after watering.</strong> The clearest early
          signal. Push a finger two knuckles in, or slide a wooden skewer to the bottom and look at
          it. Damp soil three or four days on in an average room means the pot is holding more water
          than the plant is using.
        </li>
        <li>
          <strong>Yellowing lower leaves, several at once.</strong> One old bottom leaf yellowing
          slowly is normal ageing. Several going soft-yellow together, low on the plant, is the
          classic overwatering pattern.
        </li>
        <li>
          <strong>Limp, soft leaves rather than crispy ones.</strong> This is the most useful
          distinction in the whole article. Thirsty plants go dry, papery and crisp at the edges.
          Overwatered plants go soft, floppy and translucent. Feel the leaf before you reach for the
          watering can.
        </li>
        <li>
          <strong>Fungus gnats.</strong> Small black flies rising off the soil when you walk past.
          They breed in permanently damp top-inch soil, so they&rsquo;re less a pest problem than a
          watering-frequency readout.
        </li>
        <li>
          <strong>Mould, algae or a white crust on the surface.</strong> Fuzzy white growth or a
          green film means the surface never dries.
        </li>
        <li>
          <strong>A sour smell.</strong> Healthy potting mix smells like earth. Rotting roots smell
          sulphurous or drainy. If you can smell a pot from a foot away, the situation is advanced.
        </li>
        <li>
          <strong>Soft, dark mush at the base of the stem.</strong> The late sign. Firm stem good,
          squishy stem bad.
        </li>
      </ul>

      <h2>How to check properly, in two minutes</h2>
      <p>
        <strong>Lift the pot.</strong> Learn what your plant weighs right after a full watering and
        what it weighs when it&rsquo;s dry. Weight is the most reliable soil-moisture meter there
        is, it&rsquo;s free, and it works through the whole depth of the pot rather than just the
        top inch.
      </p>
      <p>
        <strong>Then look at the roots.</strong> If you suspect rot, slide the plant out of its pot
        &mdash; this is much less traumatic than people fear, and it&rsquo;s the only way to know.
        Healthy roots are firm and pale, white or tan, and they hold their shape. Rotted roots are
        brown or black, slimy, and come apart between your fingers. The smell confirms it.
      </p>

      <h2>Fixing it</h2>
      <ol>
        <li>
          <strong>Stop watering.</strong> Obvious, and still the step people skip. Nothing else
          works until the soil can dry.
        </li>
        <li>
          <strong>Empty the saucer, and check there&rsquo;s a drainage hole.</strong> A decorative
          pot with no hole is the single most common cause of this problem. Either drill it, or keep
          the plant in its nursery pot and use the pretty one as a sleeve you tip out after
          watering.
        </li>
        <li>
          <strong>If it&rsquo;s only slightly soggy, wait.</strong> Move it somewhere brighter and
          warmer with a bit of air movement, and leave it alone until the pot feels light. Many
          plants recover from here with no intervention at all.
        </li>
        <li>
          <strong>If roots are rotting, repot.</strong> Remove as much of the wet soil as you can,
          trim off the mushy roots with clean scissors, and repot into fresh, barely-damp mix in a
          pot that isn&rsquo;t oversized. A big pot holds more water than small roots can use, which
          restarts the whole cycle.
        </li>
        <li>
          <strong>Don&rsquo;t fertilise.</strong> Damaged roots can&rsquo;t use it, and fertiliser
          salts in wet soil make things worse. Feed once it&rsquo;s clearly growing again.
        </li>
      </ol>
      <p>
        Then be patient. A plant that has lost half its roots will drop leaves for a few weeks
        &mdash; it can&rsquo;t support the foliage it has. Recovery looks like new growth, not like
        the old leaves coming back. Some plants won&rsquo;t make it, and cutting off a healthy piece
        to propagate is a reasonable insurance policy while you wait.
      </p>

      <h2>The shared-household version</h2>
      <p>
        There&rsquo;s one cause of overwatering that has nothing to do with plant knowledge: two
        people watering the same plant without knowing the other one did. Both of you are being
        careful. The plant gets double doses, and it&rsquo;s the well-loved plant in the busiest
        room that dies &mdash; because that&rsquo;s the one both people walk past.
      </p>
      <p>
        You can&rsquo;t solve this by being more attentive, since attention is what caused it. It
        needs a record: some shared place that says this was watered on Tuesday, so the second
        person doesn&rsquo;t. A note on the pot works. So does <a href="/">Family Greenhouse</a>,
        which logs who watered what and when precisely so nobody in the house has to guess &mdash;
        the same reason it assigns each task to one person instead of reminding everybody.
      </p>
      <p>
        If you want the fuller diagnosis on discoloured foliage, we went through the causes in{' '}
        <a href="/blog/why-are-my-plant-leaves-turning-yellow">why plant leaves turn yellow</a>.
      </p>
    </article>
  );
}
