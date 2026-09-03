/**
 * Blog post — targets the very high-volume diagnostic query "why are my
 * plant leaves turning yellow". The honest structure for this query is a
 * triage by pattern rather than a list of causes, plus explicit
 * permission to be uncertain and change one variable at a time.
 * Length ~1150 words.
 */
export default function YellowLeaves() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Yellow leaves are a symptom, not a diagnosis. Roughly everything that can go wrong with a
        houseplant &mdash; too much water, too little, wrong light, cold draught, exhausted soil,
        pests, or simply age &mdash; can produce a yellow leaf. So the useful question isn&rsquo;t
        &ldquo;what causes yellow leaves,&rdquo; it&rsquo;s &ldquo;which leaves, in what pattern,
        and what else is true.&rdquo;
      </p>

      <h2>Start here: is this just an old leaf?</h2>
      <p>
        Plants shed their oldest leaves. It is completely normal, it happens on healthy plants, and
        it accounts for a large share of the yellow leaves people panic about.
      </p>
      <p>It&rsquo;s ordinary ageing if all of the following are true:</p>
      <ul>
        <li>It&rsquo;s the lowest leaf, or one of the lowest, and one of the oldest.</li>
        <li>It&rsquo;s one leaf, or one every few weeks &mdash; not several at once.</li>
        <li>The rest of the plant looks fine, and there&rsquo;s new growth somewhere.</li>
      </ul>
      <p>
        Pull it off gently or snip it and get on with your day. If it doesn&rsquo;t detach easily,
        just leave it; the plant will drop it when it&rsquo;s finished reclaiming what it wants.
      </p>

      <h2>Triage by pattern</h2>

      <h3>Several lower leaves yellow at once, soil wet, leaves soft</h3>
      <p>
        The most likely answer, and the most common one overall: too much water, or a pot that
        can&rsquo;t drain. Check the weight of the pot and whether there&rsquo;s a drainage hole
        before you do anything else. Full walkthrough in{' '}
        <a href="/blog/signs-of-overwatering-and-how-to-fix-it">the overwatering post</a>.
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
        new growth. Repotting into fresh mix is the more reliable fix than fertiliser, and it lets
        you look at the roots while you&rsquo;re there.
      </p>
      <p>
        A caution, because this is where people do damage: don&rsquo;t reach for fertiliser as a
        general response to a sad plant. If the problem is roots, feeding makes it worse. Only feed
        a plant that is otherwise healthy and actively growing.
      </p>

      <h3>Yellow stippling or speckling, fine webbing, tiny moving dots</h3>
      <p>
        Pests. Turn the leaf over and look at the underside and where the leaf meets the stem
        &mdash; that&rsquo;s where they live. Spider mites give a fine pale stippling and sometimes
        webbing in leaf joints; sticky residue points at scale or aphids. Isolate the plant from its
        neighbours the same day.
      </p>

      <h3>Sudden yellowing after something changed</h3>
      <p>
        A move, a repot, a cold night by a draughty window, a radiator turned on for the season, a
        trip to a new home. Plants respond to change with a bit of leaf loss and then stabilise. If
        you can name a change in the last fortnight, the most useful thing you can do is nothing:
        hold the conditions steady and wait.
      </p>

      <h2>The two-week rule</h2>
      <p>
        The most common way people finish off a struggling plant is by doing everything at once:
        watering it, feeding it, repotting it, and moving it to a brighter spot in the same
        afternoon. If it recovers you&rsquo;ve learned nothing, and if it dies you&rsquo;ve learned
        less.
      </p>
      <p>
        Change one variable. Wait two weeks. New growth is the signal to watch &mdash; not the
        yellow leaves, which will never turn green again no matter what you do. A leaf that has gone
        yellow is spent. Judge the plant by what it does next.
      </p>

      <h2>When it&rsquo;s genuinely unclear</h2>
      <p>
        Sometimes you check everything and none of it fits. That happens, and the honest advice is
        that a plant with a couple of yellow leaves and otherwise normal growth usually
        doesn&rsquo;t need an intervention. Keep the watering consistent, leave it where it is, and
        look again in a fortnight. Most of the time it resolves.
      </p>

      <h2>The reason it&rsquo;s hard to diagnose in a shared house</h2>
      <p>
        Every branch above starts with &ldquo;when was it last watered?&rdquo; &mdash; and in a
        household where two or three people might have done it, nobody knows. You can&rsquo;t tell
        overwatering from underwatering without that fact, so people guess, and the guess is usually
        &ldquo;it needs water,&rdquo; which is the wrong answer about half the time.
      </p>
      <p>
        A shared record fixes the diagnosis, not just the schedule. That&rsquo;s what{' '}
        <a href="/">Family Greenhouse</a> keeps: one list for the household, with who did what and
        when, so &ldquo;it was watered on Sunday and it&rsquo;s still soggy&rdquo; is a fact rather
        than a theory. A note stuck to the pot does the same thing for one plant.
      </p>
    </article>
  );
}
