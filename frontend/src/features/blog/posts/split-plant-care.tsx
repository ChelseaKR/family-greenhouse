/**
 * Blog post — targets "how to split plant care with partner" / "dividing
 * household chores fairly" / "who waters the plants". Sits downstream of
 * the existing nag post: that one diagnoses the dynamic, this one is the
 * practical menu of ways to actually divide the work. Length ~1150 words.
 */
export default function SplitPlantCare() {
  return (
    <article className="prose-fg">
      <p className="lead">
        &ldquo;We&rsquo;ll both just do it&rdquo; is the most common plant-care arrangement in a
        shared household, and it&rsquo;s the only one that reliably fails. Two people who both might
        water a plant will, between them, water it less often than one person who knows it&rsquo;s
        theirs. Here are four ways to actually divide it, and what each one costs you.
      </p>

      <h2>Why unassigned care is worse than solo care</h2>
      <p>
        If you live alone, you have one signal: the plant looks thirsty, and nobody else is coming.
        Add a second person and that signal gets noisier. The drooping leaf might mean nobody
        watered it. It might mean your housemate watered it yesterday and it&rsquo;s just dramatic.
        You can&rsquo;t tell by looking, so you either water it again &mdash; which is its own
        problem &mdash; or you assume it&rsquo;s handled and walk past.
      </p>
      <p>
        Both of those are rational responses to missing information. That&rsquo;s the thing to hold
        on to: nobody in this story is lazy. The arrangement is just underspecified, and
        underspecified work goes to whoever cares most, until that person gets tired of being the
        one who cares most.
      </p>

      <h2>Four ways to split it</h2>

      <h3>1. Split by plant</h3>
      <p>
        Each plant belongs to one person. Your monstera, their fern. You water yours, they water
        theirs, and neither of you touches the other&rsquo;s without asking.
      </p>
      <p>
        <strong>Works when</strong> the collection came from two people who each brought plants, or
        when one of you is much more into this than the other. Ownership is a strong motivator and
        it&rsquo;s completely unambiguous.
      </p>
      <p>
        <strong>Costs you</strong> resilience. If one person travels, or gets busy, or loses
        interest, their whole set declines while the other person watches and tries to decide
        whether saying something is nagging. It also quietly creates two classes of plant, and the
        neglected class is visible from the sofa.
      </p>

      <h3>2. Split by week</h3>
      <p>
        One person does everything on odd weeks, the other on even weeks. Or you alternate months.
        The unit doesn&rsquo;t matter much; the point is that the whole job moves as one block.
      </p>
      <p>
        <strong>Works when</strong> your schedules are lumpy &mdash; shift work, alternating
        childcare, someone who travels for work. Whoever&rsquo;s home covers the whole thing, and
        the off-duty person is genuinely off duty, which is more restful than it sounds.
      </p>
      <p>
        <strong>Costs you</strong> continuity. Plants don&rsquo;t run on a seven-day cycle, so
        handovers land mid-schedule and things get missed at the seam. This one only works if
        there&rsquo;s a written record of what was last done &mdash; otherwise every Monday starts
        with an archaeology problem.
      </p>

      <h3>3. Split by room</h3>
      <p>
        You take the living room and the hallway; they take the bedroom and the kitchen. Plants
        belong to zones, and zones belong to people.
      </p>
      <p>
        <strong>Works when</strong> your home is laid out in a way that makes this natural &mdash;
        someone works from the spare room and sees those plants every day; someone else is in the
        kitchen constantly. Attaching the job to a place you already go is the whole trick. Rooms
        are also easier to remember than a list of species.
      </p>
      <p>
        <strong>Costs you</strong> fairness, usually. Rooms don&rsquo;t hold equal numbers of
        plants, and the sunny room is both the nicest and the thirstiest. Re-audit it every few
        months, or it silently turns into one person doing most of the work.
      </p>

      <h3>4. Split by job, not by plant</h3>
      <p>
        One person waters everything. The other handles the occasional stuff: repotting, feeding in
        spring, wiping dust off leaves, dealing with the fungus gnats, buying the new pot.
      </p>
      <p>
        <strong>Works when</strong> one of you likes the weekly rhythm and the other likes projects.
        It&rsquo;s the split that most often matches how people actually are, and it stops the
        project person from feeling like a spare part.
      </p>
      <p>
        <strong>Costs you</strong> visible balance. Watering is frequent and boring; repotting is
        rare and satisfying. Even if the hours come out even across a year, the week-to-week feel
        doesn&rsquo;t, and that&rsquo;s what people actually keep score on. Say the imbalance out
        loud when you set it up and it stops being a grievance.
      </p>

      <h2>The part that has to be true regardless</h2>
      <p>Whichever split you pick, three things make it hold:</p>
      <ol>
        <li>
          <strong>One list, both people.</strong> If the plan lives in one person&rsquo;s head, that
          person is now the manager, and management is the actual chore you&rsquo;re trying to
          divide. Write it down somewhere you both look.
        </li>
        <li>
          <strong>A record of what was last done.</strong> Not for accountability &mdash; so nobody
          has to ask. &ldquo;Watered Tuesday&rdquo; ends the conversation before it starts, and it
          also stops the double-watering that kills more shared plants than forgetting does.
        </li>
        <li>
          <strong>A named plan for gaps.</strong> Trips, illness, deadline weeks. Decide in advance
          what happens: the other person covers, or you both accept that a fortnight of drought is
          survivable for most of the collection. Either is fine. Undecided is not.
        </li>
      </ol>

      <h2>Renegotiate on a schedule, not in a moment</h2>
      <p>
        The worst time to redesign the split is when you&rsquo;ve just found a dead plant. Everyone
        is annoyed, the conversation is about blame, and whatever you agree to is a truce rather
        than a system.
      </p>
      <p>
        Pick a boring moment &mdash; the start of a season is a natural one, since watering
        frequency changes anyway &mdash; and spend ten minutes on it. Who has what, is it still
        even, what broke last time. Ten minutes twice a year is less total effort than one argument.
      </p>

      <h2>If you want the tooling</h2>
      <p>
        <a href="/">Family Greenhouse</a> is built around this specific problem: one plant list the
        whole household sees, tasks assigned to a person rather than broadcast to everyone, and a
        log showing who did what and when. It supports every split above &mdash; per-plant
        ownership, rotation, whatever you land on &mdash; because the hard part was never the
        watering, it was knowing where things stand.
      </p>
      <p>
        A shared note on the fridge does the same job for a small collection. Use whatever
        you&rsquo;ll actually keep up. The only arrangement that doesn&rsquo;t work is the one where
        you both assume.
      </p>
    </article>
  );
}
