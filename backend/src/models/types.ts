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

export interface HouseholdInvite {
  code: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface Plant {
  id: string;
  householdId: string;
  name: string;
  species: string | null;
  location: string | null;
  imageUrl: string | null;
  notes: string | null;
  /** Free-form tags for filtering. Max 10 tags, ≤40 chars each. */
  tags: string[];
  /** Perenual species id, set when the user picks an enrichment-backed
   *  suggestion from the species autocomplete. Optional — free-text species
   *  names without a Perenual match leave this null. */
  perenualSpeciesId?: number | null;
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
