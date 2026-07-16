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
 * Household-roster shape for the household detail endpoint (GET
 * /households/:id). Omits email — the Privacy Policy states other members
 * "cannot see your email," with no admin carve-out. Callers that
 * legitimately need email (outbound reminders/digest/recap mail) use the
 * full HouseholdMember via getHouseholdMembers instead.
 */
export type PublicHouseholdMember = Omit<HouseholdMember, 'email'>;

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
  imageUrl: string | null;
  notes: string | null;
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
  notes: string | null;
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
