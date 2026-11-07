/**
 * Blog post — answers the yes/no question Search Console showed eight
 * phrasings of between 2026-08-01 and 2026-11-04 ("are yellow leaves a sign
 * of overwatering", "does overwatering cause yellow leaves", "does yellow
 * leaves mean too much water"…): 21 impressions at positions 36-46, all
 * landing on the overwatering post, which answers a different question
 * (how to fix it). Answer first, then the two checks that settle it.
 *
 * Every factual line traces to a source in SOURCES below, read 2026-11-05.
 * The wording is ours; the one quotation is under 15 words. No day count
 * appears that a source does not give.
 */
const SOURCES = [
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
  {
    publisher: 'University of Illinois Extension',
    title: 'Keep houseplants happy with simple solutions',
    url: 'https://extension.illinois.edu/news-releases/keep-houseplants-happy-simple-solutions',
  },
  {
    publisher: 'Clemson Cooperative Extension, Home & Garden Information Center',
    title: 'Indoor Plants – Watering (HGIC 1459)',
    url: 'https://hgic.clemson.edu/factsheet/indoor-plants-watering/',
  },
];

const READ_ON = '2026-11-05';

export default function YellowLeavesOverwatering() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Often, yes. Clemson Extension&rsquo;s houseplant factsheet puts it plainly: &ldquo;Most
        often, yellowing is a symptom caused by overwatering.&rdquo; But not always. The same
        factsheet lists too little light, too little fertilizer, insects and mites as other causes,
        and a plant left too dry for a long time can yellow too. So before you change anything,
        check the soil, then the roots.
      </p>

      <h2>The short answer, as a checklist</h2>
      <ul>
        <li>
          <strong>Yellow leaves and soil that is still wet or damp:</strong> overwatering is the
          likely cause. Stop watering.
        </li>
        <li>
          <strong>Yellow leaves and soil that is dry well below the surface:</strong> the plant may
          be too dry. Water it thoroughly.
        </li>
        <li>
          <strong>Yellow leaves and normal soil moisture:</strong> look at light, feeding and pests
          before you blame the watering.
        </li>
      </ul>

      <h2>Why too much water turns leaves yellow</h2>
      <p>
        Roots need oxygen as well as water. Clemson&rsquo;s watering factsheet explains that roots
        surrounded by water can&rsquo;t take up oxygen, so they start to die and can rot. Iowa State
        Extension adds that an excessively wet growing medium is one of the most common stresses
        that sets a plant up for root rot.
      </p>
      <p>
        Damaged roots can&rsquo;t supply the leaves. Iowa State describes plants with root rot
        wilting, often from the bottom leaves upward, with leaves that may yellow and drop. That
        wilting is the trap: it looks like thirst, so people water again and make it worse.
      </p>

      <h2>Check 1: the soil</h2>
      <p>
        Iowa State&rsquo;s advice is to check the soil before every watering. If it is wet or damp
        to the touch, wait. If it is dry down an inch or two, water. Clemson suggests pushing a
        finger into the mix up to the first joint, lifting the pot to feel its weight, or watching
        the mix turn lighter in color as it dries.
      </p>
      <p>
        Clemson also notes that the symptoms of overwatering and underwatering are similar, because
        both end in poor root health. That is why the soil check comes first. The leaf alone
        can&rsquo;t tell you which one you have.
      </p>

      <h2>Check 2: the roots</h2>
      <p>
        If the soil has stayed wet and the plant keeps yellowing, slide it out of its pot and look.
        University of Illinois Extension says healthy roots are generally white. Rusty orange to
        light brown roots point to underwatering, and dark brown to black roots point to
        overwatering. Iowa State describes rotted roots as darkened and collapsed, sometimes with
        the outer layer sloughing off and leaving a thread-like core.
      </p>

      <h2>Other signs that it is the water</h2>
      <p>
        Iowa State lists the symptoms of overwatering as yellowing or browning leaves, leaf drop,
        wilting, crown rot, fungus gnats and, eventually, death. Yellow leaves together with fungus
        gnats or a soft crown make the water the prime suspect.
      </p>
      <p>
        A few setups make overwatering easy even when you water carefully. Iowa State names a pot
        that is too big, a pot with no drainage hole, a saucer or outer sleeve left full of water,
        and old, compacted soil that holds more water than fresh mix.
      </p>

      <h2>If it is overwatering, what to do</h2>
      <p>
        Illinois Extension&rsquo;s advice is to hold off on water until the soil is quite dry, then
        ease into a new watering routine. Iowa State suggests watering less often and says repotting
        may help. Our step-by-step for an overwatered plant, including what to do about rotted
        roots, is in{' '}
        <a href="/blog/signs-of-overwatering-and-how-to-fix-it">how to fix an overwatered plant</a>.
      </p>
      <p>
        The leaves that already turned yellow will not turn green again. Judge the recovery by new
        growth.
      </p>

      <h2>If it is not the water</h2>
      <p>
        Illinois Extension notes that a plant moved to a new spot may yellow or drop leaves while it
        adjusts, and usually settles if the conditions suit it. If the yellowing continues for more
        than a few weeks, it suggests trying another spot and adjusting the watering a little. For
        the other patterns (low light, sunburn, an exhausted pot, pests), we went through them in{' '}
        <a href="/blog/why-are-my-plant-leaves-turning-yellow">why plant leaves turn yellow</a>, and{' '}
        <a href="/blog/how-much-light-does-my-room-get">how much light your room gets</a> helps rule
        light in or out.
      </p>

      <h2>Plant by plant</h2>
      <p>
        How wet is too wet depends on the plant. Clemson singles out the{' '}
        <a href="/care/snake-plant">snake plant</a> as prone to rotting when overwatered. Each of
        our care guides gives one plant&rsquo;s watering rhythm and cites where it comes from, for
        example the <a href="/care/zz-plant">ZZ plant</a>, <a href="/care/pothos">pothos</a>,{' '}
        <a href="/care/monstera">monstera</a> and{' '}
        <a href="/care/fiddle-leaf-fig">fiddle-leaf fig</a>. The{' '}
        <a href="/care">care guide index</a> lists every plant we cover.
      </p>

      <h2>When more than one person waters</h2>
      <p>
        Every check above starts with one fact: when was this plant last watered? In a home where
        two or three people might have done it, nobody knows for sure, and a plant can get watered
        twice. <a href="/">Family Greenhouse</a> keeps one shared list for the household with who
        watered what and when, so the soil check starts from a fact instead of a guess.
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
