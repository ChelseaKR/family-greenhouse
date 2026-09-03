export interface User {
  id: string;
  email: string;
  name: string;
  householdId: string | null;
  householdRole: 'admin' | 'member' | null;
}

export interface HouseholdLocation {
  /** Display label, user-supplied. Doubles as the geocode source of truth. */
  city: string;
  /** WGS84 latitude / longitude pair. We keep both so the weather lookup
   *  doesn't have to re-geocode on every call. */
  lat: number;
  lon: number;
}

export interface Household {
  id: string;
  name: string;
  /** Optional household location, used for climate-aware care tips. Set
   *  via the household settings page; off by default — we don't ask for
   *  geo without an explicit reason. */
  location?: HouseholdLocation | null;
  /**
   * Auto-handoff rule (ADR 0018): a task this many days overdue goes up for
   * grabs and the rest of the household is told once. null/absent = OFF.
   * The server enforces a floor of 5 days (escalation.ts) so a client can
   * never turn the feature into hourly nagging.
   */
  escalateAfterDays?: number | null;
  createdAt: string;
  createdBy: string;
}

export interface HouseholdMember {
  householdId: string;
  userId: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

/**
 * Whether the app can currently reach a member by email.
 *
 *   - `ok` — nothing has told us otherwise.
 *   - `undeliverable` — the address is on the suppression list and no product
 *     email is being sent to it. Deliberately does NOT say why: a bounce and a
 *     spam complaint both stop the mail, but "this housemate reported us as
 *     spam" is the recipient's business, not the roster's.
 *   - `unknown` — the suppression store could not be read. Not a synonym for
 *     `ok`; a failed lookup must never render as a clean bill of health
 *     (ADR 0010).
 */
export type MemberEmailStatus = 'ok' | 'undeliverable' | 'unknown';

/**
 * Household-roster shape for the household detail endpoint (GET
 * /households/:id). Omits email — the Privacy Policy states other members
 * "cannot see your email," with no admin carve-out. Callers that
 * legitimately need email (outbound reminders/digest/recap mail) use the
 * full HouseholdMember via getHouseholdMembers instead.
 *
 * `emailStatus` carries deliverability WITHOUT carrying the address: the
 * household needs to know that a member is not getting reminders (otherwise
 * the failure is invisible and looks like health), and knowing that reveals
 * nothing the Privacy Policy protects.
 */
export type PublicHouseholdMember = Omit<HouseholdMember, 'email'> & {
  emailStatus: MemberEmailStatus;
};

export interface HouseholdInvite {
  code: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Plant lifecycle. We don't "delete" a plant you cared for — we record its
 * outcome, so the history (and the plant-survival metric) survives. `active`
 * plants are the ones being cared for; `died`/`gave_away` are past outcomes
 * and `archived` is the neutral, reversible “not caring for this right now”
 * that drop out of the default list, the plan cap, and the reminder scan but
 * keep all their history. True hard-delete is reserved for mistakes.
 * Legacy rows with no `status` are treated as `active`.
 */
export type PlantStatus = 'active' | 'died' | 'gave_away' | 'archived';

/**
 * Care rotation for a space (ADR 0018): "the balcony alternates between Sam
 * and Priya, weekly". Time-indexed from `anchor` rather than a stored turn
 * counter, so "whose turn" is a function of the clock — the server can derive
 * it for any date without a write, and a missed cycle cannot desynchronise it.
 */
export interface SpaceRotation {
  /** Members in turn order. At least two — a rotation of one is a default caregiver. */
  memberIds: string[];
  cadence: 'weekly' | 'monthly';
  /** Instant period 0 starts at. Set when the rotation is created. */
  anchor: string;
}

/** A household-scoped place where plants currently live. Keeping the
 * inside/outside classification on the space (rather than the plant) means a
 * seasonal move changes one relationship instead of rewriting plant traits. */
export interface PlantSpace {
  id: string;
  householdId: string;
  name: string;
  environment: 'inside' | 'outside';
  /** Whether rainfall reaches plants in this space. Legacy outdoor spaces
   * default to exposed; indoor spaces default to sheltered. */
  rainExposure: 'exposed' | 'sheltered';
  /** Approximate ambient light. Null means the household has not assessed it. */
  lightLevel: 'low' | 'medium' | 'bright' | null;
  /** Whether cats or dogs can reach plants here. Null means unknown. */
  petAccess: boolean | null;
  /** Current household member assigned to new tasks for plants here. */
  defaultCaregiverId: string | null;
  /** Care rotation; takes precedence over defaultCaregiverId. Null = none. */
  rotation: SpaceRotation | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface Plant {
  id: string;
  householdId: string;
  name: string;
  species: string | null;
  location: string | null;
  /** Current first-class household space. Optional for legacy rows. */
  spaceId?: string | null;
  /** Specific position inside a space, e.g. "east window, top shelf". */
  placementNote?: string | null;
  /** Preferred warm-season home. Optional for legacy rows. */
  summerSpaceId?: string | null;
  /** Preferred cool-season home. Optional for legacy rows. */
  winterSpaceId?: string | null;
  imageUrl: string | null;
  notes: string | null;
  /** House rule: one short per-plant care convention, e.g. "bottom-water
   *  only" (≤140 chars, trimmed server-side). Surfaced to whoever is about
   *  to complete a task for this plant; `notes` stays the long-form field.
   *  Optional for legacy rows; null/absent means no rule, so nothing renders. */
  careRule?: string | null;
  /** Lifecycle status; absent on legacy rows → treated as 'active'. */
  status: PlantStatus;
  /** When status last changed (set on archive/outcome/restore). */
  statusChangedAt?: string | null;
  /** Free-form tags for filtering. Max 10 tags, ≤40 chars each. */
  tags: string[];
  /** Perenual species id, set when the user picks an enrichment-backed
   *  suggestion from the species autocomplete. Optional — free-text species
   *  names without a Perenual match leave this null. */
  perenualSpeciesId?: number | null;
  /**
   * Server-resolved canonical scientific name for external integrations.
   * Unlike `species`, clients cannot set this directly: the backend derives it
   * from the trusted Perenual record referenced by `perenualSpeciesId`.
   */
  canonicalSpecies?: string | null;
  /** Propagation lineage: the plant this one was cut from. Always within
   *  the same household; null/absent for plants that aren't cuttings. The
   *  parent may itself die or be given away — the link is history, not a
   *  foreign key, so it intentionally survives parent status changes. */
  parentPlantId?: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  householdId: string;
  plantId: string;
  plantName: string;
  type: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
  customType: string | null;
  frequency: number;
  lastCompleted: string | null;
  nextDue: string;
  assignedTo: string | null;
  assignedToName: string | null;
  /** Inherited assignments remain claimable; null means explicit/unassigned.
   *  `space_default` came from the space's usual caregiver, `move_day` from
   *  Seasonal Move Day's round-robin split (services/moveDay.ts), `rotation`
   *  from the space's care-rotation turn (ADR 0018). */
  assignmentSource: 'space_default' | 'move_day' | 'rotation' | null;
  notes: string | null;
  /**
   * Auto-handoff marker (ADR 0018). Set once per occurrence: `escalatedForDue`
   * pins the `nextDue` the escalation fired for, so the hourly scan can never
   * escalate the same lapse twice and a completion (which advances nextDue)
   * naturally re-arms it. Absent on rows that were never escalated.
   */
  escalatedAt?: string | null;
  escalatedForDue?: string | null;
  /** Who held the task when it was escalated (null when it was unassigned). */
  escalatedFrom?: string | null;
  createdBy: string;
  createdAt: string;
}

export interface TaskCompletion {
  id: string;
  householdId: string;
  plantId: string;
  taskId: string;
  taskType: string;
  completedBy: string;
  completedByName: string;
  completedAt: string;
  notes: string | null;
  /**
   * Set when the member saw the double-care notice and chose "log it anyway":
   * the id of the other member's completion this one duplicates. Counted per
   * month in analytics and excluded from schedule-drift math. Absent/null on
   * every ordinary completion (and on rows that predate the feature).
   */
  duplicateOfCompletionId?: string | null;
}

// DynamoDB item types
export interface DynamoDBItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
  entityType: string;
  [key: string]: unknown;
}
