/**
 * Blog post — targets the high-intent diagnostic query "signs of
 * overwatering" / "overwatered plant how to fix". Leads with the
 * counterintuitive bit (an overwatered plant looks thirsty), keeps the
 * household angle honest rather than forced: two carers, double doses.
 * Length ~1150 words.
 */
/**
 * Merged in 2026-11-15, when the two yellow-leaves posts became 301s to this
 * one (src/config/redirects.json): the root-colour line, cited below, and the
 * "If it is not the water" patterns, moved verbatim from
 * why-are-my-plant-leaves-turning-yellow. Approved wording.
 */
const SOURCES = [
  {
    publisher: 'University of Illinois Extension',
    title: 'Keep houseplants happy with simple solutions',
    url: 'https://extension.illinois.edu/news-releases/keep-houseplants-happy-simple-solutions',
  },
];

const READ_ON = '2026-11-05';

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
          slowly is normal aging. Several going soft-yellow together, low on the plant, is the
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
          <strong>Mold, algae or a white crust on the surface.</strong> Fuzzy white growth or a
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
      <p>
        University of Illinois Extension says healthy roots are generally white. Rusty orange to
        light brown roots point to underwatering, and dark brown to black roots point to
        overwatering.
      </p>

      <h2>How to fix an overwatered plant</h2>
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
          <strong>Don&rsquo;t fertilize.</strong> Damaged roots can&rsquo;t use it, and fertilizer
          salts in wet soil make things worse. Feed once it&rsquo;s clearly growing again.
        </li>
      </ol>
      <p>
        Then be patient. A plant that has lost half its roots will drop leaves for a few weeks
        &mdash; it can&rsquo;t support the foliage it has. Recovery looks like new growth, not like
        the old leaves coming back. Some plants won&rsquo;t make it, and cutting off a healthy piece
        to propagate is a reasonable insurance policy while you wait.
      </p>

      <h2>If it is not the water</h2>
      <p>
        Yellow leaves are a symptom, not a diagnosis. If the soil is dry, or the leaves are crisp
        rather than soft, look for one of these patterns instead.
      </p>

      <h3>Yellow going to brown and crispy, especially at edges and tips, soil dry</h3>
      <p>
        Underwatering, or air that&rsquo;s very dry, or both. A pot that&rsquo;s bone-light and soil
        that has shrunk away from the sides of the pot confirms it. When soil gets that dry, water
        runs straight down the gap and out the bottom without wetting anything, so the fix is to
        stand the pot in a few inches of water for half an hour and let it drink from below.
      </p>

      <h3>Whole plant pale, new leaves small or yellowish-green, growth leggy</h3>
      <p>
        Not enough light. The giveaway is the stretch: long bare stems, big gaps between leaves, and
        everything leaning toward the window. Moving it closer to a window generally fixes this, but
        move it in stages over a couple of weeks rather than all at once, and{' '}
        <a href="/blog/how-much-light-does-my-room-get">work out what light you actually have</a>{' '}
        first.
      </p>

      <h3>Yellow patches or bleached, washed-out areas on leaves facing the window</h3>
      <p>
        Too much direct sun, which is a real thing even indoors. Common after a plant gets moved, or
        in early summer when the sun&rsquo;s angle changes and a spot that was fine in March becomes
        a hotspot in June. Pull it back from the glass or diffuse the light with a sheer curtain.
      </p>

      <h3>Older leaves uniformly yellow, plant has been in the same soil for years</h3>
      <p>
        Possibly nutrient depletion &mdash; a plant that hasn&rsquo;t been fed or repotted in a long
        time eventually runs the pot down, and it withdraws what it can from old leaves to supply
        new growth. Repotting into fresh mix is the more reliable fix than fertilizer, and it lets
        you look at the roots while you&rsquo;re there.
      </p>
      <p>
        A caution, because this is where people do damage: don&rsquo;t reach for fertilizer as a
        general response to a sad plant. If the problem is roots, feeding makes it worse. Only feed
        a plant that is otherwise healthy and actively growing.
      </p>

      <h3>Yellow stippling or speckling, fine webbing, tiny moving dots</h3>
      <p>
        Pests. Turn the leaf over and look at the underside and where the leaf meets the stem
        &mdash; that&rsquo;s where they live. Spider mites give a fine pale stippling and sometimes
        webbing in leaf joints; sticky residue points at scale or aphids. Isolate the plant from its
        neighbors the same day.
      </p>

      <h3>Sudden yellowing after something changed</h3>
      <p>
        A move, a repot, a cold night by a drafty window, a radiator turned on for the season, a
        trip to a new home. Plants respond to change with a bit of leaf loss and then stabilize. If
        you can name a change in the last two weeks, the most useful thing you can do is nothing:
        hold the conditions steady and wait.
      </p>

      <h2>Plant by plant</h2>
      <p>
        How much water is too much depends on the plant. Each of our care guides gives that
        plant&rsquo;s watering rhythm and the problems it most often shows, and these ones cover
        overwatering on that plant specifically: <a href="/care/snake-plant">snake plant</a>,{' '}
        <a href="/care/zz-plant">ZZ plant</a>, <a href="/care/aloe-vera">aloe vera</a>,{' '}
        <a href="/care/jade-plant">jade plant</a>, <a href="/care/haworthia">haworthia</a>,{' '}
        <a href="/care/blue-echeveria">blue echeveria</a>, <a href="/care/sago-palm">sago palm</a>,{' '}
        <a href="/care/rosemary">rosemary</a>, <a href="/care/peace-lily">peace lily</a> and{' '}
        <a href="/care/fiddle-leaf-fig">fiddle-leaf fig</a>. The{' '}
        <a href="/care">care guide index</a> lists every plant we cover.
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
        the same reason a task can be assigned to one person, so the reminder goes to them rather
        than to the whole household.
      </p>

      <section aria-labelledby="post-sources">
        <h2 id="post-sources">Where the cited advice comes from</h2>
        <p>
          The lines above that name University of Illinois Extension were checked against this page.
          The wording is ours.
        </p>
        <ul>
          {SOURCES.map((s) => (
            <li key={s.url}>
              <a href={s.url} rel="noopener">
                {s.publisher}, {s.title}
              </a>{' '}
              (read <time dateTime={READ_ON}>November 5, 2026</time>)
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
