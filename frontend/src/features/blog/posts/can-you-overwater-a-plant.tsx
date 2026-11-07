/**
 * Blog post — answers the generic overwatering head queries Search Console
 * showed between 2026-08-01 and 2026-11-04 ("overwatering plants", "can you
 * overwater a plant", "plants with too much water", "frequent watering",
 * "what happens if a plant gets too much water"…): 16 phrasings, 52
 * impressions at positions 36-92, all landing on the overwatering post,
 * which is about signs and fixes. This one answers "can you, and how do you
 * avoid it": yes, and water by checking rather than by the calendar.
 *
 * Every factual line traces to a source in SOURCES below, read 2026-11-05.
 * The wording is ours; the one quotation is under 15 words. No day count
 * appears, because no source gives one: Clemson says outright there is no
 * fixed answer to "how often".
 */
const SOURCES = [
  {
    publisher: 'Clemson Cooperative Extension, Home & Garden Information Center',
    title: 'Indoor Plants – Watering (HGIC 1459)',
    url: 'https://hgic.clemson.edu/factsheet/indoor-plants-watering/',
  },
  {
    publisher: 'Clemson Cooperative Extension, Home & Garden Information Center',
    title: 'Houseplant Diseases & Disorders (HGIC 2251)',
    url: 'https://hgic.clemson.edu/factsheet/houseplant-diseases-disorders/',
  },
  {
    publisher: 'Iowa State University Extension and Outreach, Yard and Garden',
    title: 'Diagnosing Houseplant Problems Related to Poor Culture',
    url: 'https://yardandgarden.extension.iastate.edu/how-to/diagnosing-houseplant-problems-related-poor-culture',
  },
  {
    publisher: 'Iowa State University Extension and Outreach, Yard and Garden',
    title: 'Prevent Root Rot Problems on Houseplants',
    url: 'https://yardandgarden.extension.iastate.edu/article/1994/12-9-1994/rrot.html',
  },
];

const READ_ON = '2026-11-05';

export default function CanYouOverwaterAPlant() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Yes. Clemson Extension calls over-watering &ldquo;the main cause of death of potted
        plants.&rdquo; The damage comes from soil that stays wet, so the roots can&rsquo;t get air.
        The fix is to water by checking the soil, not by counting days.
      </p>

      <h2>What too much water does to a plant</h2>
      <p>
        Roots need oxygen as well as water. Clemson explains that roots surrounded by water
        can&rsquo;t take up oxygen, so they may rot, and the whole plant may die. Its houseplant
        disorders factsheet adds that overwatering cuts the oxygen available for root growth and
        favors root diseases.
      </p>
      <p>
        The plant then wilts, because damaged roots can&rsquo;t move water to the leaves. Iowa State
        Extension points out the trap: the wilting prompts more watering, which makes the problem
        worse. Its list of symptoms is yellowing or browning leaves, leaf drop, wilting, crown rot,
        fungus gnats and, in the end, death.
      </p>

      <h2>How often should you water, then?</h2>
      <p>
        Clemson&rsquo;s answer is that there is no fixed answer. How much and how often depends on
        the plant, its stage of growth, where it sits, the pot, the potting mix and the weather. A
        few rules of thumb from the same factsheet:
      </p>
      <ul>
        <li>
          Plants with thin or large leaves, or fine surface roots, need water more often than
          succulents that store water in fleshy leaves and stems.
        </li>
        <li>A porous clay pot dries faster than a plastic or glazed one.</li>
        <li>
          A large plant in a small pot needs water more often than a small plant in a large pot.
        </li>
        <li>Heavy, peat-rich mixes hold more water than loose mixes with bark, sand or perlite.</li>
        <li>A warm, dry, sunny spot dries a pot faster than a cool, dim one.</li>
        <li>A plant that is resting after a flush of growth or flowering needs less water.</li>
      </ul>

      <h2>Check on a schedule; water when the soil says so</h2>
      <p>
        Iowa State&rsquo;s advice is the clearest single habit: check for water on a schedule, but
        don&rsquo;t water on one. Before each watering, touch the soil. If it is wet or damp, wait.
        If it is dry down an inch or two, water.
      </p>
      <p>Clemson lists four ways to tell, from most to least direct:</p>
      <ul>
        <li>
          <strong>Touch.</strong> Push a finger into the mix up to the first joint. Dry at the
          fingertip means it needs water.
        </li>
        <li>
          <strong>Weight.</strong> A drying pot gets noticeably lighter. Lift it after watering and
          again later, and you learn the difference.
        </li>
        <li>
          <strong>Tap.</strong> A clay pot sounds dull when the soil is moist and hollow when it is
          dry.
        </li>
        <li>
          <strong>Color.</strong> Most potting mixes turn lighter as they dry.
        </li>
      </ul>
      <p>
        Clemson also says moisture meters vary widely in accuracy, and fertilizer and soil type can
        throw off the reading, so treat one as a hint rather than an answer.
      </p>

      <h2>When you do water, water thoroughly</h2>
      <p>
        A thorough watering is not the problem. Clemson&rsquo;s advice is to water until it runs out
        of the bottom of the pot, which reaches the roots in the lower part of the pot and flushes
        out excess salts. Then empty the saucer, because the pot should not sit in the runoff. Iowa
        State describes the cycle houseplants do best on: soak the root ball, then let it dry before
        the next watering. It recommends watering when the soil is completely dry but before the
        plant starts to wilt.
      </p>
      <p>Clemson also suggests water that is neither hot nor cold, between 62 and 72 °F.</p>

      <h2>Setups that overwater for you</h2>
      <p>Some pots stay wet no matter how carefully you water. Iowa State names four:</p>
      <ul>
        <li>A pot that is too big for the plant.</li>
        <li>A pot with no drainage hole.</li>
        <li>A saucer or decorative outer pot that holds the runoff.</li>
        <li>Old, broken-down, compacted soil, which holds more water than fresh mix.</li>
      </ul>
      <p>
        Its root rot article adds that the mix should be well aerated and drain easily, with water
        running out the bottom after each watering.
      </p>

      <h2>If you think it has already happened</h2>
      <p>
        Yellow lower leaves, wilting in wet soil and fungus gnats are the usual first signs. For the
        two-minute check and the fix, see{' '}
        <a href="/blog/signs-of-overwatering-and-how-to-fix-it">how to fix an overwatered plant</a>.
        If the question is whether yellow leaves really mean too much water, see{' '}
        <a href="/blog/do-yellow-leaves-mean-overwatering">do yellow leaves mean overwatering</a>.
      </p>

      <h2>Plant by plant</h2>
      <p>
        Clemson notes that succulents, which store water in fleshy leaves and stems, need water less
        often than thin-leaved plants, and it singles out the{' '}
        <a href="/care/snake-plant">snake plant</a> as prone to rot. Each of our care guides gives
        one plant&rsquo;s watering rhythm and cites where it comes from, for example the{' '}
        <a href="/care/zz-plant">ZZ plant</a>, <a href="/care/aloe-vera">aloe vera</a>,{' '}
        <a href="/care/jade-plant">jade plant</a> and <a href="/care/haworthia">haworthia</a>. The{' '}
        <a href="/care">care guide index</a> lists every plant we cover.
      </p>

      <h2>When more than one person waters</h2>
      <p>
        A plant in a shared home can be overwatered by two careful people who each water it once.
        Checking the soil catches that, and so does a record of when it was last watered.{' '}
        <a href="/">Family Greenhouse</a> keeps one shared list for the household with who watered
        what and when, so whoever checks the soil also knows when it was last watered.
      </p>

      <section aria-labelledby="post-sources">
        <h2 id="post-sources">Where this advice comes from</h2>
        <p>The advice in this post was checked against these pages. The wording is ours.</p>
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
