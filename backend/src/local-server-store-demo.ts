/**
 * Store-demo household for the App Store / Google Play screenshot run.
 *
 * WHY THIS IS A SECOND HOUSEHOLD AND NOT AN EDIT TO THE DEFAULT SEED
 *
 * `resetDb()` in local-server.ts seeds one user, one household, one plant and
 * one task, and the whole integration + e2e suite is written against exactly
 * that: `tests/integration/away-kit-photos-recap.test.ts` asserts
 * `db.photos.size === 0`, several specs count the seed household's plants and
 * tasks, and `tests/e2e/*.spec.ts` logs into `test@example.com` expecting one
 * "Monstera" row. Growing that fixture to eight plants and eighteen
 * completions would rewrite those expectations for a reason that has nothing
 * to do with what they test. So this is a SEPARATE household with its own
 * members, behind an env flag, and the default seed is untouched.
 *
 * It is also opt-in rather than always-on. Every household-scoped route
 * filters by `householdId`, so a second household is invisible to the default
 * seed's queries — but `db.photos`/`db.completions`/`db.activity` are global
 * Maps that a few integration tests count directly. Seeding only when
 * `SEED_STORE_DEMO=1` keeps those counts at zero for every existing caller;
 * `tests/e2e/playwright.store.config.ts` is the one place that sets it.
 *
 * Nothing here changes app behaviour. It writes fixture rows into the same
 * Maps the mock's own routes write, in the same shapes, and registers no
 * routes of its own.
 *
 * EVERY NAME, ADDRESS AND PLANT IN THIS FILE IS INVENTED. The addresses are
 * `@example.com` (RFC 2606, permanently unregistrable) precisely so no frame
 * can ever show a real person's account — a store-review requirement, not a
 * style choice. See `store-assets/README.md`.
 *
 * Unlike local-server.ts this file is type-checked (no `@ts-nocheck`), so the
 * row shapes below are declared rather than inferred from `any`.
 */

/** Subset of local-server's `User` this fixture writes. */
export interface StoreDemoUser {
  id: string;
  email: string;
  password: string;
  name: string;
  confirmed: boolean;
  householdId: string | null;
  householdRole: 'admin' | 'member' | null;
  memberships: Array<{ householdId: string; role: 'admin' | 'member'; joinedAt: string }>;
}

/** Subset of local-server's `Household`. */
export interface StoreDemoHousehold {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
}

/** Subset of local-server's `PlantSpace`. */
export interface StoreDemoSpace {
  id: string;
  householdId: string;
  name: string;
  environment: 'inside' | 'outside';
  rainExposure: 'exposed' | 'sheltered';
  lightLevel: 'low' | 'medium' | 'bright' | null;
  petAccess: boolean | null;
  defaultCaregiverId: string | null;
  rotation: null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** Subset of local-server's `Plant`. */
export interface StoreDemoPlant {
  id: string;
  householdId: string;
  name: string;
  species: string | null;
  location: string | null;
  spaceId: string | null;
  placementNote: string | null;
  summerSpaceId: string | null;
  winterSpaceId: string | null;
  imageUrl: string | null;
  notes: string | null;
  careRule?: string | null;
  status: 'active' | 'died' | 'gave_away' | 'archived';
  statusChangedAt: string | null;
  tags: string[];
  perenualSpeciesId: number | null;
  parentPlantId: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** Subset of local-server's `Task`. */
export interface StoreDemoTask {
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
  assignmentSource: 'space_default' | 'move_day' | 'rotation' | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

/** Subset of local-server's `Completion`. */
export interface StoreDemoCompletion {
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

/** Subset of `services/activity.ts`'s `ActivityEvent`. */
export interface StoreDemoActivityEvent {
  id: string;
  type: string;
  householdId: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** The slice of the mock DB this module writes. Passed in rather than
 *  imported so local-server.ts stays the only module that owns it. */
export interface StoreDemoDeps {
  users: Map<string, StoreDemoUser>;
  households: Map<string, StoreDemoHousehold>;
  spaces: Map<string, StoreDemoSpace>;
  plants: Map<string, StoreDemoPlant>;
  tasks: Map<string, StoreDemoTask>;
  completions: Map<string, StoreDemoCompletion>;
  activity: Map<string, StoreDemoActivityEvent>;
}

/**
 * Fixed ids, so a screenshot re-run produces the same URLs as the last one and
 * a frame can be diffed against its predecessor. They share the default seed's
 * `550e8400-e29b-41d4-a716-` prefix and differ in the last block, which the
 * default seed leaves at `…440000`/`…440001`.
 */
export const STORE_DEMO_HOUSEHOLD_ID = '550e8400-e29b-41d4-a716-4466554410ff';
const MEMBER_IDS = {
  dana: '550e8400-e29b-41d4-a716-446655441001',
  marisol: '550e8400-e29b-41d4-a716-446655441002',
  theo: '550e8400-e29b-41d4-a716-446655441003',
} as const;

/** The account `tests/e2e/store-screenshots.spec.ts` signs in as. */
export const STORE_DEMO_LOGIN = {
  email: 'dana@example.com',
  password: 'password123',
} as const;

type MemberKey = keyof typeof MEMBER_IDS;

/**
 * Three members, not four: the free Seedling plan caps a household at three
 * (`models/plans.ts`), and the demo household is deliberately left on the free
 * plan so no frame can show an upgrade nudge or any other billing surface —
 * the store listing states the app collects no payment.
 */
const MEMBERS: Array<{
  key: MemberKey;
  name: string;
  email: string;
  role: 'admin' | 'member';
  /** Days before "now" this member joined; drives the `member.joined` feed. */
  joinedDaysAgo: number;
}> = [
  {
    key: 'dana',
    name: 'Dana Whitfield',
    email: STORE_DEMO_LOGIN.email,
    role: 'admin',
    joinedDaysAgo: 384,
  },
  {
    key: 'marisol',
    name: 'Marisol Reyes',
    email: 'marisol@example.com',
    role: 'member',
    joinedDaysAgo: 291,
  },
  {
    key: 'theo',
    name: 'Theo Nakamura',
    email: 'theo@example.com',
    role: 'member',
    joinedDaysAgo: 66,
  },
];

/**
 * Five rooms, so the plants page's spaces view and the tasks page's care
 * round both have a real route to draw, inside before outside.
 *
 * `lightLevel` is at or above every resident species' `minimumLight`
 * (`frontend/src/utils/careGuidance.ts`) and no room is marked pet-accessible,
 * so `PlacementFitCard` finds nothing to warn about and correctly renders
 * nothing. That card's absence is a claim, not a silence — see its own header
 * comment — so the placements are made to be genuinely fine rather than the
 * warning suppressed. Nine of the ten curated species are toxic to pets, so a
 * pet-accessible room here would put an amber "may be toxic if chewed" panel
 * at the top of the plant-detail frame, which is both a pet-safety claim the
 * listing deliberately avoids and an invented fact about an invented household.
 */
const SPACES: Array<{
  key: string;
  name: string;
  environment: 'inside' | 'outside';
  rainExposure: 'exposed' | 'sheltered';
  lightLevel: 'low' | 'medium' | 'bright';
  petAccess: boolean;
}> = [
  {
    key: 'living',
    name: 'Living Room',
    environment: 'inside',
    rainExposure: 'sheltered',
    lightLevel: 'bright',
    petAccess: false,
  },
  {
    key: 'kitchen',
    name: 'Kitchen',
    environment: 'inside',
    rainExposure: 'sheltered',
    lightLevel: 'bright',
    petAccess: false,
  },
  {
    key: 'bedroom',
    name: 'Bedroom',
    environment: 'inside',
    rainExposure: 'sheltered',
    lightLevel: 'medium',
    petAccess: false,
  },
  {
    key: 'study',
    name: 'Back Study',
    environment: 'inside',
    rainExposure: 'sheltered',
    lightLevel: 'medium',
    petAccess: false,
  },
  {
    key: 'porch',
    name: 'Back Porch',
    environment: 'outside',
    rainExposure: 'exposed',
    lightLevel: 'bright',
    petAccess: false,
  },
];

/**
 * Eight plants, every species an exact scientific-name hit in the curated
 * catalog (`frontend/src/utils/careGuidance.ts`), so a plant-detail frame
 * shows a real "Caring for …" card rather than the no-care-data notice — the
 * local mock answers `/species/search` with `disabled`, so a species outside
 * that catalog has nothing to fall back on locally. Insertion
 * order is render order: `GET /plants` returns Map order and the plants page
 * does not re-sort, so the first entry is the card the screenshot spec clicks
 * for `03-plant-detail.png`.
 */
const PLANTS: Array<{
  key: string;
  name: string;
  species: string;
  space: string;
  notes: string;
  careRule?: string;
  addedDaysAgo: number;
  addedBy: MemberKey;
}> = [
  {
    key: 'monstera',
    name: 'Monstera',
    species: 'Monstera deliciosa',
    space: 'living',
    notes: 'Aerial roots are climbing the moss pole — tuck the loose ones back in when you water.',
    careRule: 'Bottom-water this one. The top of the pot dries out long before the root ball does.',
    addedDaysAgo: 372,
    addedBy: 'dana',
  },
  {
    key: 'fiddle',
    name: 'Fiddle Leaf Fig',
    species: 'Ficus lyrata',
    space: 'living',
    notes: 'Hates being moved. Rotate a quarter turn each month instead.',
    addedDaysAgo: 288,
    addedBy: 'marisol',
  },
  {
    key: 'pothos',
    name: 'Golden Pothos',
    species: 'Epipremnum aureum',
    space: 'kitchen',
    notes: 'The trailing vine over the window is from a cutting off the long one.',
    addedDaysAgo: 240,
    addedBy: 'marisol',
  },
  {
    key: 'aloe',
    name: 'Aloe',
    species: 'Aloe vera',
    space: 'kitchen',
    notes: 'By the hob, on purpose. Let it dry right out between waterings.',
    addedDaysAgo: 196,
    addedBy: 'dana',
  },
  {
    key: 'snake',
    name: 'Snake Plant',
    species: 'Dracaena trifasciata',
    space: 'bedroom',
    notes: 'Happiest ignored. Three weeks between waterings is plenty.',
    addedDaysAgo: 173,
    addedBy: 'theo',
  },
  {
    key: 'peace-lily',
    name: 'Peace Lily',
    species: 'Spathiphyllum wallisii',
    space: 'bedroom',
    notes: 'Droops dramatically before it actually needs water — wait for the leaves to fold.',
    addedDaysAgo: 120,
    addedBy: 'marisol',
  },
  {
    key: 'zz',
    name: 'ZZ Plant',
    species: 'Zamioculcas zamiifolia',
    space: 'study',
    notes: 'Lives on the filing cabinet, out of the afternoon sun.',
    addedDaysAgo: 84,
    addedBy: 'theo',
  },
  {
    key: 'jade',
    name: 'Jade Plant',
    species: 'Crassula ovata',
    space: 'porch',
    notes: 'Comes indoors when the forecast dips under 10°C.',
    addedDaysAgo: 51,
    addedBy: 'dana',
  },
];

/**
 * The shared-household story, which is the whole reason these frames exist:
 * work due today that three different people are holding, one overdue job
 * nobody has claimed yet, and a week of scheduled care behind it.
 *
 * `assignee: null` is what renders the "Up for grabs" badge and the Claim
 * button (`TasksPage.tsx`, `DashboardPage.tsx`); a named assignee renders
 * "Assigned to …". Completed work is not a task state — it is a `Completion`
 * row, seeded below, which is what fills Care History and the activity feed.
 */
const TASKS: Array<{
  key: string;
  plant: string;
  type: StoreDemoTask['type'];
  frequency: number;
  /** Days from "now"; negative is overdue, 0 is due today. */
  dueInDays: number;
  assignee: MemberKey | null;
  /** Members who did the previous rounds, most recent first. */
  history: MemberKey[];
}> = [
  // Overdue, unclaimed — the case the product exists to solve.
  {
    key: 'peace-lily-water',
    plant: 'peace-lily',
    type: 'water',
    frequency: 7,
    dueInDays: -1,
    assignee: null,
    history: ['dana', 'theo', 'marisol'],
  },
  // Due today, spread across all three members plus one still up for grabs.
  {
    key: 'monstera-water',
    plant: 'monstera',
    type: 'water',
    frequency: 7,
    dueInDays: 0,
    assignee: 'dana',
    history: ['marisol', 'theo', 'dana', 'marisol'],
  },
  {
    key: 'pothos-water',
    plant: 'pothos',
    type: 'water',
    frequency: 5,
    dueInDays: 0,
    assignee: 'marisol',
    history: ['theo', 'marisol', 'dana'],
  },
  {
    key: 'fiddle-water',
    plant: 'fiddle',
    type: 'water',
    frequency: 7,
    dueInDays: 0,
    assignee: 'theo',
    history: ['theo', 'dana'],
  },
  {
    key: 'aloe-water',
    plant: 'aloe',
    type: 'water',
    frequency: 21,
    dueInDays: 0,
    assignee: null,
    history: ['dana'],
  },
  // The rest of the week.
  {
    key: 'fiddle-prune',
    plant: 'fiddle',
    type: 'prune',
    frequency: 60,
    dueInDays: 2,
    assignee: null,
    history: ['marisol'],
  },
  {
    key: 'snake-water',
    plant: 'snake',
    type: 'water',
    frequency: 21,
    dueInDays: 3,
    assignee: 'theo',
    history: ['marisol'],
  },
  {
    key: 'jade-water',
    plant: 'jade',
    type: 'water',
    frequency: 14,
    dueInDays: 4,
    assignee: 'marisol',
    history: ['dana'],
  },
  {
    key: 'zz-water',
    plant: 'zz',
    type: 'water',
    frequency: 21,
    dueInDays: 5,
    assignee: null,
    history: ['theo'],
  },
  {
    key: 'monstera-fertilize',
    plant: 'monstera',
    type: 'fertilize',
    frequency: 30,
    dueInDays: 6,
    assignee: 'dana',
    history: ['dana'],
  },
];

/** Local-midnight-anchored timestamp `days` from now, at `hour` local time.
 *  Every due-date surface in the app compares calendar days
 *  (`frontend/src/utils/date.ts`), so the hour only has to be plausible. */
function at(now: Date, days: number, hour: number): string {
  const when = new Date(now);
  when.setDate(when.getDate() + days);
  when.setHours(hour, 0, 0, 0);
  return when.toISOString();
}

/** Two hex digits per row kind, so two kinds at the same index cannot collide. */
const ID_KIND = { space: 'a1', plant: 'b2', task: 'c3', done: 'd4', feed: 'e5' } as const;

/** Deterministic ids: same fixture, same URLs, run after run. */
function idFor(kind: keyof typeof ID_KIND, index: number): string {
  return `550e8400-e29b-41d4-a716-4466${ID_KIND[kind]}${index.toString(16).padStart(6, '0')}`;
}

/**
 * Seed the store-demo household into the mock DB.
 *
 * Idempotent: called from `resetDb()`, which clears every Map first.
 */
export function seedStoreDemoHousehold(db: StoreDemoDeps): void {
  const now = new Date();
  const householdCreatedAt = at(now, -384, 9);

  const memberIdOf = (key: MemberKey) => MEMBER_IDS[key];
  const memberNameOf = (key: MemberKey) => MEMBERS.find((member) => member.key === key)?.name ?? '';

  for (const member of MEMBERS) {
    const joinedAt = at(now, -member.joinedDaysAgo, 10);
    db.users.set(MEMBER_IDS[member.key], {
      id: MEMBER_IDS[member.key],
      email: member.email,
      password: STORE_DEMO_LOGIN.password,
      name: member.name,
      confirmed: true,
      householdId: STORE_DEMO_HOUSEHOLD_ID,
      householdRole: member.role,
      memberships: [{ householdId: STORE_DEMO_HOUSEHOLD_ID, role: member.role, joinedAt }],
    });
  }

  db.households.set(STORE_DEMO_HOUSEHOLD_ID, {
    id: STORE_DEMO_HOUSEHOLD_ID,
    name: 'The Fernwood House',
    createdAt: householdCreatedAt,
    createdBy: MEMBER_IDS.dana,
  });

  const spaceIds = new Map<string, string>();
  SPACES.forEach((space, index) => {
    const id = idFor('space', index);
    spaceIds.set(space.key, id);
    db.spaces.set(id, {
      id,
      householdId: STORE_DEMO_HOUSEHOLD_ID,
      name: space.name,
      environment: space.environment,
      rainExposure: space.rainExposure,
      lightLevel: space.lightLevel,
      petAccess: space.petAccess,
      // Left unset on purpose: a space default would stamp every task with
      // `assignmentSource`, which swaps the Claim button for "Take over" and
      // buries the up-for-grabs state these frames are meant to show.
      defaultCaregiverId: null,
      rotation: null,
      createdAt: householdCreatedAt,
      createdBy: MEMBER_IDS.dana,
      updatedAt: householdCreatedAt,
    });
  });

  const plantIds = new Map<string, string>();
  PLANTS.forEach((plant, index) => {
    const id = idFor('plant', index);
    plantIds.set(plant.key, id);
    const addedAt = at(now, -plant.addedDaysAgo, 11);
    db.plants.set(id, {
      id,
      householdId: STORE_DEMO_HOUSEHOLD_ID,
      name: plant.name,
      species: plant.species,
      location: SPACES.find((space) => space.key === plant.space)?.name ?? null,
      spaceId: spaceIds.get(plant.space) ?? null,
      placementNote: null,
      summerSpaceId: null,
      winterSpaceId: null,
      // No photograph. Every photo the app can show here would have to be
      // invented, and an invented picture presented as a household's own plant
      // is exactly what the "no real user data" rule is protecting against.
      // The brand placeholder is the honest empty state and is what ships.
      imageUrl: null,
      notes: plant.notes,
      careRule: plant.careRule ?? null,
      status: 'active',
      statusChangedAt: null,
      tags: [],
      perenualSpeciesId: null,
      parentPlantId: null,
      createdAt: addedAt,
      createdBy: MEMBER_IDS[plant.addedBy],
      updatedAt: addedAt,
    });
  });

  const taskIds = new Map<string, string>();
  let completionIndex = 0;
  TASKS.forEach((task, index) => {
    const id = idFor('task', index);
    taskIds.set(task.key, id);
    const plantId = plantIds.get(task.plant);
    const plantName = PLANTS.find((plant) => plant.key === task.plant)?.name ?? '';
    if (!plantId) return;

    // Previous rounds land exactly one interval apart, ending one interval
    // before the next due date. That keeps "Due", "Last" and the streak line
    // on the plant-detail row telling the same story.
    const historyAt = task.history.map((_, position) =>
      at(now, task.dueInDays - task.frequency * (position + 1), 18)
    );

    db.tasks.set(id, {
      id,
      householdId: STORE_DEMO_HOUSEHOLD_ID,
      plantId,
      plantName,
      type: task.type,
      customType: null,
      frequency: task.frequency,
      lastCompleted: historyAt[0] ?? null,
      nextDue: at(now, task.dueInDays, 9),
      assignedTo: task.assignee ? memberIdOf(task.assignee) : null,
      assignedToName: task.assignee ? memberNameOf(task.assignee) : null,
      assignmentSource: null,
      notes: null,
      createdBy: MEMBER_IDS.dana,
      createdAt: at(now, -Math.max(task.frequency * task.history.length, 30), 11),
    });

    task.history.forEach((actor, position) => {
      const completionId = idFor('done', completionIndex++);
      db.completions.set(completionId, {
        id: completionId,
        householdId: STORE_DEMO_HOUSEHOLD_ID,
        plantId,
        taskId: id,
        taskType: task.type,
        completedBy: memberIdOf(actor),
        completedByName: memberNameOf(actor),
        completedAt: historyAt[position],
        notes: null,
      });
    });
  });

  // Feed rows the completions above cannot produce. `GET /households/:id/
  // activity` folds completions in as `task.completed` already, so these only
  // add the kinds a household actually accumulates: people arriving, plants
  // being added, and a job someone picked up.
  const feed: Array<{
    type: string;
    actor: MemberKey;
    daysAgo: number;
    payload: Record<string, unknown>;
  }> = [
    {
      type: 'task.claimed',
      actor: 'theo',
      daysAgo: 1,
      payload: {
        taskId: taskIds.get('fiddle-water'),
        plantId: plantIds.get('fiddle'),
        plantName: 'Fiddle Leaf Fig',
        taskType: 'water',
      },
    },
    {
      type: 'plant.created',
      actor: 'dana',
      daysAgo: 51,
      payload: { plantId: plantIds.get('jade'), plantName: 'Jade Plant' },
    },
    {
      type: 'member.joined',
      actor: 'theo',
      daysAgo: 66,
      payload: { role: 'member' },
    },
    {
      type: 'plant.created',
      actor: 'theo',
      daysAgo: 84,
      payload: { plantId: plantIds.get('zz'), plantName: 'ZZ Plant' },
    },
    {
      type: 'member.joined',
      actor: 'marisol',
      daysAgo: 291,
      payload: { role: 'member' },
    },
  ];

  feed.forEach((event, index) => {
    const id = idFor('feed', index);
    db.activity.set(id, {
      id,
      type: event.type,
      householdId: STORE_DEMO_HOUSEHOLD_ID,
      actorId: memberIdOf(event.actor),
      actorName: memberNameOf(event.actor),
      occurredAt: at(now, -event.daysAgo, 16),
      payload: event.payload,
    });
  });
}
