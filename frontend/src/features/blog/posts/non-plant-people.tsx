/**
 * Blog post — targets "getting my partner to help with the plants" /
 * "how to get housemates to help with chores" and the product's core
 * wedge: making a household member who doesn't care about plants
 * genuinely able to contribute. Deliberately sympathetic to the
 * non-plant-person. Length ~1150 words.
 */
export default function NonPlantPeople() {
  return (
    <article className="prose-fg">
      <p className="lead">
        Every plant household has a plant person and, usually, someone who lives there too. The
        second person is not the villain of this story. They&rsquo;re willing to help; they just
        don&rsquo;t have the thing the plant person has, which is a running background model of
        which pot is thirsty. Everything below is about closing that gap without asking them to
        develop the interest.
      </p>

      <h2>The thing you&rsquo;re actually asking for</h2>
      <p>
        When a plant person says &ldquo;can you help with the plants,&rdquo; what they usually mean
        is &ldquo;can you notice the plants.&rdquo; Those are wildly different asks. Noticing is the
        hard part &mdash; it&rsquo;s an ongoing, unpaid attentional job, and it&rsquo;s the reason
        the plant person is tired.
      </p>
      <p>
        You cannot delegate noticing to someone who isn&rsquo;t interested. You can delegate doing.
        So the goal is to take the noticing out of the job entirely, do it once yourself, in
        advance, and hand over something that requires none.
      </p>

      <h2>Rules for instructions a non-plant-person can follow</h2>

      <h3>Remove every judgement call</h3>
      <p>
        &ldquo;Water it when the soil feels dry an inch down&rdquo; requires a person to have a
        calibrated sense of what dry-an-inch-down feels like, and the confidence to act on it.
        &ldquo;Give the big one by the window two cups on Sundays&rdquo; requires a cup and a
        Sunday.
      </p>
      <p>
        The fixed schedule is slightly less optimal for the plant than reading the soil. It is
        enormously more likely to actually happen. Take the trade.
      </p>

      <h3>Give them whole plants, not whole tasks</h3>
      <p>
        &ldquo;You do the watering&rdquo; is a job with no edges &mdash; it&rsquo;s never done, and
        every plant in the house is a potential failure. &ldquo;These three are yours&rdquo; is a
        job that finishes.
      </p>
      <p>
        Start with three, and start with the forgiving ones. If the first plant somebody is put in
        charge of is a calathea, they will conclude they&rsquo;re bad at this, and they will be
        right, because everyone is bad at calatheas.
      </p>

      <h3>Attach the job to something they already do</h3>
      <p>
        The most reliable version I&rsquo;ve seen: the plants that belong to the non-plant-person
        live in the room they&rsquo;re in every day, and get done on the day they already do
        something else. Bins go out Wednesday; the two kitchen plants get watered Wednesday. Nobody
        has to build a new habit from nothing.
      </p>

      <h3>Label the pot</h3>
      <p>
        Slightly undignified, extremely effective. A strip of masking tape on the pot with a name
        and a frequency &mdash; &ldquo;Doug &mdash; Sundays, 2 cups&rdquo; &mdash; puts the
        instruction exactly where the decision gets made. You can take it off once the habit sticks.
      </p>

      <h2>The part where you have to let go</h2>
      <p>
        Here is where most of these arrangements actually die. The non-plant-person waters a plant.
        The plant person watches them do it slightly wrong &mdash; too little, wrong day, splashing
        the leaves &mdash; and corrects them.
      </p>
      <p>
        That correction is the end of the arrangement. Not because anyone gets angry, but because
        the job now comes with supervision, and a supervised chore is less appealing than no chore.
        The other person quietly stops, and the plant person concludes they can&rsquo;t be relied
        on.
      </p>
      <p>Three things that help:</p>
      <ul>
        <li>
          <strong>Decide what actually matters.</strong> For nearly every houseplant, the only thing
          that matters is roughly-right water at roughly-right intervals. Almost everything else
          you&rsquo;d correct is preference.
        </li>
        <li>
          <strong>Fix the system, not the person.</strong> If they consistently underwater, the
          instruction should say a bigger number, not the person should try harder. Change the note
          on the pot without mentioning it.
        </li>
        <li>
          <strong>Say thanks for the doing, not the outcome.</strong> The plant surviving is not
          their achievement to be praised for &mdash; that&rsquo;s condescending and everyone can
          feel it. &ldquo;Thanks for doing the kitchen ones&rdquo; is enough.
        </li>
      </ul>

      <h2>What good enough looks like</h2>
      <p>
        A plant watered on a rigid weekly schedule by a person who isn&rsquo;t paying close
        attention will not be the best specimen on the internet. It will be alive, and it will be
        alive without anyone having to remember it, and in a shared house that&rsquo;s the metric
        that counts.
      </p>
      <p>
        The alternative &mdash; one person holding the whole model in their head, doing everything
        themselves, and being mildly resentful about it &mdash; produces better plants and a worse
        household. Most people, asked directly, would take the second-best pothos.
      </p>

      <h2>When it&rsquo;s not going to work</h2>
      <p>
        Sometimes the honest answer is that the other person isn&rsquo;t going to participate, and
        that&rsquo;s a legitimate outcome. If that&rsquo;s where you are, the useful move is to
        shrink the collection to the size one person can carry, rather than keep twenty plants and a
        grievance. Giving away four plants is not a defeat; it&rsquo;s a very sensible response to
        the amount of attention actually available in your home.
      </p>

      <h2>The tooling version</h2>
      <p>
        <a href="/">Family Greenhouse</a> exists because this handover is the hard part. Plants get
        assigned to a specific person, reminders go to <em>that</em> person rather than pinging
        everyone (which is how both people end up assuming the other has it), and the instruction
        travels with the plant, so the care notes stop living in one person&rsquo;s head. Tapping a
        task done takes a second and doesn&rsquo;t require knowing anything about plants.
      </p>
      <p>
        None of that is the point, though. The point is that the person helping should never have to
        make a judgement call, and should never be corrected for making it wrong. Any system that
        gets you there works &mdash; masking tape included.
      </p>
    </article>
  );
}
