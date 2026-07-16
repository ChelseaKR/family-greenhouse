# Household plant spaces

Plant spaces model where plants currently live without asking a household to build a floor plan.
Every space is household-scoped and classified as `inside` or `outside`; plants with no current
space remain visible in the `Unplaced` group.

## Data model

| Entity          | DynamoDB key                         | Important fields           |
| --------------- | ------------------------------------ | -------------------------- |
| Plant space     | `PK=HOUSEHOLD#{id}`, `SK=SPACE#{id}` | `name`, `environment`      |
| Plant placement | existing `PLANT#{id}` row            | `spaceId`, `placementNote` |

The legacy plant `location` string remains readable for imports, exports, and old clients. New UI
placement writes use `spaceId`; `placementNote` stores the position within that space, such as
“east window, top shelf.” Environment belongs to the space rather than the plant so moving a plant
does not change its species traits.

## API

- `GET /spaces`
- `POST /spaces` with `{ name, environment }`
- `PUT /spaces/{id}` with either field
- `DELETE /spaces/{id}` only when no plants still reference it

Plant create and update accept `spaceId` and `placementNote`. The handler verifies that a supplied
space belongs to the caller's active household.

## UX rules

- Space setup is optional; unplaced plants continue through every care flow.
- The consumer hierarchy stops at Inside/Outside → Space. There are no floors, shelves, or maps.
- Household city/coordinates remain the “Local climate” setting and are not a plant space.
