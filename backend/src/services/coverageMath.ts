/**
 * Coverage — the household's bus-factor view. DESIGN RULE, stated once here
 * because the copy and the shape both depend on it:
 *
 *   This is a fragility view, NOT a leaderboard. Nothing in this module emits
 *   a per-member completion total, ranks members, or orders anything by how
 *   much someone has done. Every number here counts PLANTS at risk; no number
 *   here counts work. Plants sort by name, away-risks sort by date, and a
 *   member appears only as "the one person who knows this plant".
 *
 * The obvious extension — "who did more" — is deliberately not built. A
 * scoreboard in a household is a fight generator and it contradicts the
 * product's north star (share plant care without anyone becoming the nag).
 * The adjacent chores market (Tody's FairShare targets, Sweepy's family
 * leaderboard) does monetize fairness scoring, so this is a testable opinion
 * rather than a law: ship coverage, watch whether households ask for the
 * scoreboard. Until they do, the answer to "it all rests on Priya" is "teach
 * someone else these plants" or "assign a backup", not "do more".
 *
 * Pure arithmetic over data the analytics page already reads — completion
 * history (`completedBy` is a durable snapshot), the active plant list, the
 * member roster and the vacation windows. No AWS imports, so the local dev
 * server and the Lambda handler share this exact function.
 */

export interface CoverageMember {
  userId: string;
  name: string;
}

/** The two completion fields coverage needs. Everything else is ignored. */
export interface CoverageCompletion {
  plantId: string;
  completedBy: string;
}

export interface CoveragePlantInput {
  id: string;
  name: string;
}

/** The subset of a vacation window coverage reasons about. */
export interface CoverageWindow {
  userId: string;
  coveredBy: string;
  coveredByName: string | null;
  startDate: string;
  endDate: string;
}

export interface CoverageInput {
  /** Current members. Only they can step in, so only they count as cover. */
  members: CoverageMember[];
  /** Active plants — retired plants are nobody's risk. */
  plants: CoveragePlantInput[];
  /** Every completion the household has ever logged, any window. */
  completions: CoverageCompletion[];
  /** Windows that have not ended yet (active or upcoming). */
  windows: CoverageWindow[];
  now?: Date;
}

export interface CoveragePlant {
  plantId: string;
  plantName: string;
  /**
   * Every CURRENT member who has ever logged care on this plant, by name.
   * A set, not a tally: the shape has no room for "how many times".
   */
  caregivers: CoverageMember[];
  /** Size of `caregivers` — how many people could step in today. */
  caregiverCount: number;
  /** The one person who knows this plant, when exactly one current member does. */
  soleCaregiver: CoverageMember | null;
}

export interface AwayRisk {
  userId: string;
  name: string;
  startDate: string;
  endDate: string;
  coveredBy: string;
  coveredByName: string | null;
  /** True when the window is active right now (vs upcoming). */
  active: boolean;
  /**
   * Active plants this member is the only current member ever to have cared
   * for — the plants that would have nobody who knows them while they are
   * away. By plant name.
   */
  uncoveredPlants: Array<{ plantId: string; plantName: string }>;
  uncoveredPlantCount: number;
}

export interface CoverageReport {
  /** Roster the client can offer as backups. Names and ids only. */
  members: CoverageMember[];
  memberCount: number;
  plantCount: number;
  /** Every active plant with its caregiver set, by plant name. */
  plants: CoveragePlant[];
  /** The subset of `plants` resting on one person, by plant name. */
  soleCaregiverPlants: CoveragePlant[];
  /** Active plants no current member has ever logged care on. */
  uncaredPlantCount: number;
  /** One entry per pending vacation window, soonest first. */
  awayRisks: AwayRisk[];
  generatedAt: string;
}

/** Actor-id prefix the sitter completion path writes (`sitter:{linkId}`). */
const SITTER_ACTOR_PREFIX = 'sitter:';

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name) || a.name.length - b.name.length;
}

/**
 * Compute the coverage report. Deterministic and total: the only orderings
 * are by name and by date, and a member is never paired with a number of
 * completions (see the module header).
 */
export function computeCoverage(input: CoverageInput): CoverageReport {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const memberById = new Map<string, CoverageMember>();
  for (const m of input.members) {
    memberById.set(m.userId, { userId: m.userId, name: m.name });
  }
  const members = [...memberById.values()].sort(byName);

  // plantId → set of CURRENT member ids who have ever completed a task on it.
  // A sitter or a former member has cared for the plant but cannot step in
  // today, so neither counts as cover. `completedBy` is the durable snapshot
  // written at completion time; it survives the actor leaving.
  const caregiverIdsByPlant = new Map<string, Set<string>>();
  for (const c of input.completions) {
    if (!c.plantId || !c.completedBy) continue;
    if (c.completedBy.startsWith(SITTER_ACTOR_PREFIX)) continue;
    if (!memberById.has(c.completedBy)) continue;
    let set = caregiverIdsByPlant.get(c.plantId);
    if (!set) {
      set = new Set<string>();
      caregiverIdsByPlant.set(c.plantId, set);
    }
    set.add(c.completedBy);
  }

  const plants: CoveragePlant[] = input.plants
    .map((p) => {
      const caregivers = [...(caregiverIdsByPlant.get(p.id) ?? [])]
        .map((id) => memberById.get(id)!)
        .sort(byName);
      return {
        plantId: p.id,
        plantName: p.name,
        caregivers,
        caregiverCount: caregivers.length,
        soleCaregiver: caregivers.length === 1 ? caregivers[0] : null,
      };
    })
    .sort((a, b) => byName({ name: a.plantName }, { name: b.plantName }));

  const soleCaregiverPlants = plants.filter((p) => p.soleCaregiver !== null);
  const uncaredPlantCount = plants.filter((p) => p.caregiverCount === 0).length;

  const awayRisks: AwayRisk[] = input.windows
    .filter((w) => w.endDate >= nowIso && memberById.has(w.userId))
    .map((w) => {
      const uncoveredPlants = soleCaregiverPlants
        .filter((p) => p.soleCaregiver!.userId === w.userId)
        .map((p) => ({ plantId: p.plantId, plantName: p.plantName }));
      return {
        userId: w.userId,
        name: memberById.get(w.userId)!.name,
        startDate: w.startDate,
        endDate: w.endDate,
        coveredBy: w.coveredBy,
        coveredByName: w.coveredByName ?? memberById.get(w.coveredBy)?.name ?? null,
        active: w.startDate <= nowIso && nowIso <= w.endDate,
        uncoveredPlants,
        uncoveredPlantCount: uncoveredPlants.length,
      };
    })
    // Soonest first, then by name — never by how many plants are at risk.
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || byName(a, b));

  return {
    members,
    memberCount: members.length,
    plantCount: plants.length,
    plants,
    soleCaregiverPlants,
    uncaredPlantCount,
    awayRisks,
    generatedAt: nowIso,
  };
}
