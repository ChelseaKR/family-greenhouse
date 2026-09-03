/**
 * Blog post — targets "how much light does my plant need" / "bright
 * indirect light meaning" / "low light plants north facing window",
 * written for renters who can't change their windows. Practical tests
 * over jargon; honest about grow lights. Length ~1150 words.
 */
export default function RoomLight() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Every plant label says &ldquo;bright indirect light,&rdquo; which is a phrase that manages
        to be both universal and useless. It describes a condition most rented flats have in about
        one square metre of one room. Working out how much light you actually have is the single
        highest-value plant skill there is, and it takes a day and no equipment.
      </p>

      <h2>The shadow test</h2>
      <p>
        On a bright day, around midday, hold your hand a foot above a surface in the spot
        you&rsquo;re considering and look at the shadow.
      </p>
      <ul>
        <li>
          <strong>Sharp-edged shadow you could trace.</strong> Direct sun. Good for succulents,
          cacti, most herbs. Will scorch a fern or a calathea.
        </li>
        <li>
          <strong>Soft shadow with fuzzy edges, clearly visible.</strong> This is bright indirect
          light &mdash; the thing every label is asking for. Most tropical houseplants are happiest
          here.
        </li>
        <li>
          <strong>Faint shadow you have to look for.</strong> Medium to low light. Plenty of plants
          cope: pothos, snake plants, cast iron plants, parlour palms.
        </li>
        <li>
          <strong>No shadow at all.</strong> Too dark for a plant to grow, whatever the label
          claims. Something might survive here for months while slowly declining, which is not the
          same as living there.
        </li>
      </ul>
      <p>
        Do this in the spot you actually want the plant, not near it. Which brings us to the thing
        that surprises people most.
      </p>

      <h2>Light falls off much faster than it looks like it should</h2>
      <p>
        Your eyes adapt continuously, so a spot three metres from the window looks nearly as bright
        as the sill. It isn&rsquo;t &mdash; not remotely. Light intensity drops off steeply with
        distance from the source, which is why the plant on the windowsill thrives and the identical
        plant on the shelf across the room slowly stretches and pales.
      </p>
      <p>
        The practical version: <strong>proximity to the window beats everything else</strong>. If a
        plant is struggling, moving it a metre closer to the glass is usually more effective than
        any other single change you can make, and it costs nothing.
      </p>

      <h2>What direction your windows face</h2>
      <p>
        In the northern hemisphere &mdash; flip north and south if you&rsquo;re below the equator:
      </p>
      <ul>
        <li>
          <strong>South-facing:</strong> the most light, and the only orientation that reliably
          gives direct sun for hours. Great, but it can be too much in summer for anything that
          isn&rsquo;t a succulent. A sheer curtain converts it into excellent indirect light.
        </li>
        <li>
          <strong>East-facing:</strong> gentle direct morning sun, then bright indirect. Arguably
          the best all-round houseplant window, because morning sun is weak enough not to burn.
        </li>
        <li>
          <strong>West-facing:</strong> indirect in the morning, strong hot sun in the late
          afternoon. Fine, but the afternoon sun is more intense than it feels and it heats the
          room, so pull tender plants back a bit.
        </li>
        <li>
          <strong>North-facing:</strong> steady, gentle, never direct. Not bad &mdash; just limited.
          Right on a north window is a decent spot for low-light plants; three metres into a
          north-facing room is not a plant location.
        </li>
      </ul>
      <p>
        Then subtract for reality: a building opposite, a large tree, a balcony overhead, permanent
        net curtains, or the deep reveal of an old window can all take a nominally good aspect down
        a whole category. Judge the actual spot, not the compass.
      </p>

      <h2>What to do about a genuinely dark flat</h2>
      <p>Three honest options, in the order I&rsquo;d try them.</p>
      <h3>1. Match the plants to the light</h3>
      <p>
        The cheapest fix, and the one people resist. If your flat has one good window, put the
        light-hungry plants there and fill the dim corners with things that genuinely tolerate low
        light rather than things you wish did. A thriving pothos in a dark hallway looks better than
        a suffering fiddle leaf fig anywhere.
      </p>
      <h3>2. Rotate plants through the good spot</h3>
      <p>
        Two plants, one bright window, swapped every few weeks. It works better than you&rsquo;d
        think, especially for plants that are decorative in a specific place. Put it on the same
        schedule as something you already do so it actually happens.
      </p>
      <h3>3. A grow light</h3>
      <p>
        Unglamorous and effective. A decent LED bulb in an ordinary lamp fitting is enough for a
        couple of plants; the strip kind works for a shelf. Two things matter more than the
        specification: <strong>distance</strong> (close &mdash; think 30 centimetres, not across the
        room) and <strong>consistency</strong>. Put it on a cheap plug-in timer for something like
        twelve hours a day, because a light you remember to switch on is a light that&rsquo;s off
        most of the time.
      </p>
      <p>
        You don&rsquo;t need the purple ones. Ordinary warm-white full-spectrum LEDs work and look
        much better in a living room, which means you&rsquo;ll actually leave them up.
      </p>

      <h2>Light changes, and nobody notices</h2>
      <p>
        The spot that was perfect in April can be scorching in July and inadequate in December.
        Winter light in a temperate country is a fraction of summer light, and it arrives at a
        different angle for fewer hours.
      </p>
      <p>
        Two consequences worth acting on. Plants need much less water in winter, because they
        aren&rsquo;t growing much &mdash; keeping a summer watering schedule through December is a
        very common way to rot a plant. And a plant that looked fine all summer can start stretching
        in autumn, which isn&rsquo;t a new problem so much as a seasonal one. Re-check your good
        spots twice a year.
      </p>

      <h2>Write the spot down</h2>
      <p>
        This sounds trivial and isn&rsquo;t, particularly if you share a home. Someone tidies,
        someone moves a plant off the windowsill to make room for something, someone shifts it
        during a party and it never goes back. A month later the plant is declining and nobody
        connects the two events, because the person who chose the spot and the person who moved it
        are different people and neither did anything wrong.
      </p>
      <p>
        Recording where each plant lives &mdash; and why &mdash; makes the reasoning visible to
        everyone in the house. <a href="/">Family Greenhouse</a> keeps a location and care notes
        against each plant for exactly that reason, alongside the watering schedule. A line of
        masking tape on the pot saying &ldquo;needs the east window&rdquo; achieves the same thing
        for free.
      </p>
    </article>
  );
}
