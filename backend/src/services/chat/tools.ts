/**
 * Tool definitions exposed to Claude. Every tool:
 *
 *   - Has a tightly-scoped input schema. Claude validates against this; we
 *     re-validate after to catch any drift.
 *   - Scopes its DB reads by the caller's `householdId` (never by tool
 *     input). The model can't ask for another household's data.
 *   - Returns a redacted payload — no member emails, no Cognito subs,
 *     no createdBy fields. Tool results land directly in the next prompt;
 *     leaking PII here leaks it to Bedrock.
 */
import { v4 as uuid } from 'uuid';
import * as plantService from '../plantService.js';
import * as taskService from '../taskService.js';
import * as climateService from '../climate.js';
import * as householdService from '../householdService.js';
import { searchCorpus } from './corpus.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';

const listHouseholdPlants: ToolDefinition = {
  name: 'list_household_plants',
  description:
    "List the plants in the user's active household. Returns nickname, species, location in the home, and date acquired. Use this whenever the user asks about their own plants collectively (e.g. 'what plants do I have', 'tell me about my collection').",
  input_schema: {
    type: 'object',
    properties: {},
  },
  execute: async (_input, ctx: ToolExecutionContext) => {
    const plants = await plantService.getPlants(ctx.householdId);
    return plants.map((p) => ({
      id: p.id,
      nickname: p.name,
      species: p.species ?? null,
      location: p.location ?? null,
      addedAt: p.createdAt,
    }));
  },
};

const listUpcomingTasks: ToolDefinition<{ days?: number }> = {
  name: 'list_upcoming_tasks',
  description:
    "List upcoming care tasks (watering, fertilizing, pruning, etc.) due in the next N days. Default 7. Use this when the user asks 'what needs attention', 'what's overdue', or specifically when they're planning their week.",
  input_schema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        description: 'Number of days forward to look. Defaults to 7 if omitted. Capped at 30.',
        minimum: 1,
        maximum: 30,
      },
    },
  },
  execute: async (input, ctx) => {
    const days = Math.min(Math.max(Number(input.days ?? 7), 1), 30);
    const all = await taskService.getUpcomingTasks(ctx.householdId);
    const horizon = Date.now() + days * 24 * 60 * 60 * 1000;
    return all
      .filter((t) => new Date(t.nextDue).getTime() <= horizon)
      .map((t) => ({
        id: t.id,
        plantId: t.plantId,
        type: t.type,
        nextDue: t.nextDue,
        lastCompleted: t.lastCompleted,
        frequencyDays: t.frequency,
      }));
  },
};

const getHouseholdClimate: ToolDefinition = {
  name: 'get_household_climate',
  description:
    "Get the household's saved location plus current weather conditions. Use this whenever the question is climate-sensitive (watering frequency, sun exposure, when to bring tropicals indoors). Returns null if the user hasn't set a location.",
  input_schema: {
    type: 'object',
    properties: {},
  },
  execute: async (_input, ctx) => {
    const household = await householdService.getHousehold(ctx.householdId);
    if (!household?.location) {
      return { hasLocation: false };
    }
    const snapshot = await climateService.getWeatherCached(
      household.location.lat,
      household.location.lon
    );
    if (!snapshot) {
      return { hasLocation: true, location: household.location, weather: null };
    }
    return {
      hasLocation: true,
      location: {
        city: household.location.city ?? null,
        lat: household.location.lat,
        lon: household.location.lon,
      },
      weather: {
        tempC: snapshot.tempC,
        humidity: snapshot.humidity,
        condition: snapshot.condition,
        description: snapshot.description,
        observedAt: snapshot.observedAt,
        forecast: snapshot.forecast,
      },
    };
  },
};

const searchCareKnowledge: ToolDefinition<{ query: string }> = {
  name: 'search_care_knowledge',
  description:
    "Search the bundled plant-care knowledge base for relevant guidance. Use this for general plant-care questions (watering, light, humidity, pests, repotting, fertilizing, seasonal care, troubleshooting yellow leaves, brown tips, root rot, propagation). Don't use this for questions about the user's specific plants — those use list_household_plants. Returns the top 3 relevant article excerpts with titles + content.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          "Natural-language question or topic, e.g. 'my monstera has brown tips' or 'when to repot'. Be specific — narrower queries return better excerpts.",
      },
    },
    required: ['query'],
  },
  execute: async (input) => {
    const results = await searchCorpus(input.query, 3);
    return results.map((r) => ({
      title: `${r.articleTitle} — ${r.sectionTitle}`,
      source: r.source,
      content: r.text,
      relevance: Math.round(r.score * 100) / 100,
    }));
  },
};

/**
 * Propose-style write tool. The model "proposes" a reminder task; this
 * tool does NOT write to DynamoDB. Instead, the proposal is returned to
 * the model AND captured for the API response so the frontend can render
 * a Confirm/Cancel card. Confirmation hits POST /tasks separately —
 * keeps the model from doing destructive writes without a user-in-the-loop.
 *
 * The TASK_TYPES enum + the bounds below mirror createTaskSchema in
 * models/schemas.ts (type enum, frequency 1–365, customType ≤50, notes
 * ≤500). The executor re-validates everything — Claude's JSON-schema
 * validation is best-effort, and a card that POST /tasks would reject is
 * worse than an invalid tool_result the model can recover from.
 */
const TASK_TYPES = ['water', 'fertilize', 'prune', 'repot', 'custom'] as const;
type TaskType = (typeof TASK_TYPES)[number];

/** Max confirm cards a single turn may produce. Mirrored in the system prompt. */
export const MAX_PROPOSALS_PER_TURN = 3;

interface ProposeReminderInput {
  plantId: string;
  type: TaskType;
  customType?: string;
  frequencyDays: number;
  assignedTo?: string;
  note?: string;
  rationale?: string;
}

export interface ReminderProposal {
  /** Server-assigned id — lets the UI key cards stably across re-renders. */
  proposalId: string;
  plantId: string;
  plantName: string;
  type: TaskType;
  customType: string | null;
  frequencyDays: number;
  assignedTo: string | null;
  /** Display name of the assignee, looked up server-side. */
  assigneeName: string | null;
  note: string | null;
  rationale: string | null;
}

export type ProposeReminderResult =
  { status: 'proposed'; proposal: ReminderProposal } | { status: 'invalid'; reason: string };

function invalid(reason: string): ProposeReminderResult {
  return { status: 'invalid', reason };
}

const proposeReminderTask: ToolDefinition<ProposeReminderInput> = {
  name: 'propose_reminder_task',
  description:
    "Propose a recurring reminder task for one of the user's plants. This does NOT create the task — it shows the user a 'Create task' card; the task only exists after the user confirms it there. Never tell the user the task/reminder was created or set up — say you've suggested it and they should confirm via the card. Use this when the user asks for reminders or schedules, e.g. 'can you set up a watering schedule' or 'remind me to fertilize Bertha monthly'. ALWAYS look up the plant first with list_household_plants to get its real plantId. At most 3 proposals per turn. Include a concise rationale explaining the recommendation (e.g. 'tropicals like Monstera want roughly weekly watering in the growing season').",
  input_schema: {
    type: 'object',
    properties: {
      plantId: {
        type: 'string',
        description:
          "UUID of the user's plant the task is for. Must be a plantId from list_household_plants — never invent one.",
      },
      type: {
        type: 'string',
        enum: [...TASK_TYPES],
        description: 'Task type. Use "custom" only when none of water/fertilize/prune/repot fit.',
      },
      customType: {
        type: 'string',
        maxLength: 50,
        description:
          'Short label for the task when type is "custom" (e.g. "mist leaves"). Required for custom tasks, ignored otherwise.',
      },
      frequencyDays: {
        type: 'integer',
        minimum: 1,
        maximum: 365,
        description: 'How often the task should recur, in days.',
      },
      assignedTo: {
        type: 'string',
        description:
          'Optional userId of the household member to assign the task to. Only when the user explicitly asked for it; must be a real member userId.',
      },
      note: {
        type: 'string',
        maxLength: 500,
        description: 'Optional note to store on the task itself (visible on the task afterwards).',
      },
      rationale: {
        type: 'string',
        description:
          "A short (one sentence) reason for the recommendation, anchored in the user's actual plant or care knowledge.",
      },
    },
    required: ['plantId', 'type', 'frequencyDays'],
  },
  execute: async (input, ctx): Promise<ProposeReminderResult> => {
    // Per-turn cap. The orchestrator tracks accepted proposals; refuse
    // beyond the cap so one turn can't wallpaper the chat with cards.
    if ((ctx.proposalsThisTurn ?? 0) >= MAX_PROPOSALS_PER_TURN) {
      return invalid(
        `Proposal cap reached (${MAX_PROPOSALS_PER_TURN} per turn). Ask the user before suggesting more reminders.`
      );
    }

    // Re-validate against the task schema bounds — Claude's schema check is
    // advisory, and a proposal POST /tasks would reject must never card.
    if (!TASK_TYPES.includes(input.type)) {
      return invalid(
        `Unknown task type "${String(input.type)}". Use one of: ${TASK_TYPES.join(', ')}.`
      );
    }
    const freq = Number(input.frequencyDays);
    if (!Number.isInteger(freq) || freq < 1 || freq > 365) {
      return invalid('frequencyDays must be an integer between 1 and 365.');
    }
    const customType = input.customType?.trim();
    if (input.type === 'custom' && !customType) {
      return invalid('customType is required when type is "custom" — give the task a short label.');
    }
    if (customType && customType.length > 50) {
      return invalid('customType must be 50 characters or fewer.');
    }
    if (input.note && input.note.length > 500) {
      return invalid('note must be 500 characters or fewer.');
    }

    // Verify the plant actually belongs to the caller's household AND is
    // still being cared for. The model could hallucinate a UUID or recall
    // one from training; either is a confirmation card pointed at nothing.
    const plant = await plantService.getPlant(ctx.householdId, input.plantId);
    if (!plant) {
      return invalid(
        `Plant ${input.plantId} not found in this household. Re-call list_household_plants and use a real id.`
      );
    }
    if (plant.status !== 'active') {
      return invalid(
        `Plant "${plant.name}" is no longer active (${plant.status}) — reminders can only be proposed for active plants.`
      );
    }

    // If the model wants to assign the task, the assignee must be a real
    // member of THIS household — anything else is a card that 400s on
    // confirm (or worse, leaks a cross-household assignment attempt).
    let assigneeName: string | null = null;
    if (input.assignedTo) {
      const members = await householdService.getHouseholdMembers(ctx.householdId);
      const member = members.find((m) => m.userId === input.assignedTo);
      if (!member) {
        return invalid(
          `assignedTo "${input.assignedTo}" is not a member of this household. Omit it or use a real member userId.`
        );
      }
      assigneeName = member.name;
    }

    return {
      status: 'proposed',
      proposal: {
        proposalId: uuid(),
        plantId: input.plantId,
        plantName: plant.name,
        type: input.type,
        customType: input.type === 'custom' ? (customType ?? null) : null,
        frequencyDays: freq,
        assignedTo: input.assignedTo ?? null,
        assigneeName,
        note: input.note?.trim() || null,
        rationale: input.rationale?.trim() || null,
      },
    };
  },
};

// The registry's generic is unused at the call site (the dispatcher casts
// `use.input as never` since Claude's JSON validation is the source of truth
// for input shape). Cast each typed tool to the registry's default generic
// to satisfy the heterogeneous array.
export const TOOL_REGISTRY: ToolDefinition[] = [
  listHouseholdPlants,
  // Kept for uniformity with the other casts above even though this tool's
  // type already matches the registry's default generic.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  listUpcomingTasks as ToolDefinition,
  getHouseholdClimate,
  searchCareKnowledge as ToolDefinition,
  proposeReminderTask as unknown as ToolDefinition,
];

/**
 * Look up a tool by name (Claude returns the name in its tool_use block).
 * Returns undefined for an unknown tool; the dispatcher renders that as a
 * tool_result with isError=true so the model can recover.
 */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
