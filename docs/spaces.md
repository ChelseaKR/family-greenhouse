# Household plant spaces

Plant spaces model where plants currently live without asking a household to build a floor plan.
Every space is household-scoped and classified as `inside` or `outside`; plants with no current
space remain visible in the `Unplaced` group.

## Data model

| Entity          | DynamoDB key                         | Important fields                                             |
| --------------- | ------------------------------------ | ------------------------------------------------------------ |
| Plant space     | `PK=HOUSEHOLD#{id}`, `SK=SPACE#{id}` | `name`, `environment`, optional `lightLevel` / `petAccess`   |
| Plant placement | existing `PLANT#{id}` row            | `spaceId`, `placementNote`, `summerSpaceId`, `winterSpaceId` |

The legacy plant `location` string remains readable for imports, exports, and old clients. New UI
placement writes use `spaceId`; `placementNote` stores the position within that space, such as
“east window, top shelf.” Environment belongs to the space rather than the plant so moving a plant
does not change its species traits.

## API

- `GET /spaces`
- `POST /spaces` with `{ name, environment }`
- `PUT /spaces/{id}` with either field
- `DELETE /spaces/{id}` only when no plants still reference it
- `POST /plants/move` with one to 50 unique plant IDs, a destination `spaceId` (or `null` for
  Unplaced), and an optional placement note

Plant create and update accept `spaceId`, `placementNote`, `summerSpaceId`, and `winterSpaceId`.
The handler verifies that every supplied space belongs to the caller's active household. A space
cannot be deleted while any plant uses it as its current or seasonal home.

## UX rules

- Space setup is optional; unplaced plants continue through every care flow.
- The consumer hierarchy stops at Inside/Outside → Space. There are no floors, shelves, or maps.
- Household city/coordinates remain the “Local climate” setting and are not a plant space.

## Care rounds

The Tasks page offers two organizations over the same due-work query:

- **By date** preserves the existing Overdue, Today, and Upcoming sections.
- **Care round** joins tasks to their plants and current spaces in the client, then orders the
  route as inside spaces, outside spaces, and unplaced plants. No task rows or schedules are
  duplicated; completion, claiming, vacation cover, and climate-skip controls are reused.

The route respects the active task filter, so “My tasks” plus “Care round” becomes a personal route
through the household.

## Task location visibility

The dashboard and both Tasks organizations resolve each task's plant to its current space at read
time. This avoids denormalizing a space name onto recurring task rows, which would become stale every
time a plant moves or a space is renamed. Placement notes ride with the displayed space label, and
plants without a structured space are explicitly shown as Unplaced.

Active sitter links use the same read-time lookup for due tasks, sharing the current space name and
short placement note so a sitter can find the plant. The public projection never includes the
household's saved climate location, private plant/task notes, or member identity/contact details.

## Moving plants

The plant detail page offers a one-step Move action, while the collection page supports selecting
up to 50 plants and moving them together. Both use the same atomic endpoint, so a mixed-household or
missing plant cannot leave half of a batch in the new space. A one-plant move can set a precise
placement note; bulk moves clear old position notes that no longer describe the destination.

## Seasonal homes

A plant can optionally remember a preferred summer and winter space. The plant detail page uses the
saved household latitude and a broad April–September northern warm season (inverted in the southern
hemisphere) to suggest a move when the current space differs. Accepting the suggestion uses the same
`POST /plants/move` operation as quick and bulk moves; it does not silently relocate plants.

## Placement-fit checks

Spaces can optionally record a broad `lightLevel` (`low`, `medium`, or `bright`) and whether pets
can reach their plants. Both fields hydrate to `null` for legacy rows, so an unknown value never
becomes a warning. On plant detail, recognized species can surface two conservative checks:

- the space's recorded light is below the species' lowest known tolerated level;
- the species is known to be toxic and the space is marked as accessible to pets.

The UI frames these as observations to consider, not measurements, diagnoses, or automatic move
instructions. Weather exposure remains driven by `environment` and `rainExposure`.
