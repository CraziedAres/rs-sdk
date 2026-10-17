# Combat

Successful patterns for combat training.

## Attacking NPCs

Use `bot.attack()` for cleaner code, or raw SDK for more control:

```typescript
// Porcelain method (recommended)
const attack = await bot.attack(/cow/i);
if (!attack.success) console.warn(attack.reason, attack.message);

// Raw SDK dispatch (observe combat state afterwards)
const state = sdk.getState();
const npc = state?.nearbyNpcs.find(n => /cow/i.test(n.name));
const attackOpt = npc?.optionsWithIndex.find(o => /attack/i.test(o.text));
if (npc && attackOpt) {
    await sdk.sendInteractNpc(npc.index, attackOpt.opIndex);
    await sdk.waitForCondition(s => s.player?.combat.inCombat === true, 5_000);
}
```

## Combat Style Cycling

Combat-style indices depend on the equipped weapon (index 2 is aggressive on a
stabsword but controlled on a scimitar), so ask for the skill and let
`bot.setCombatStyle` resolve the index from `state.combatStyle.styles`:

```typescript
const result = await bot.setCombatStyle({ trains: 'Defence' });
if (!result.success) {
    // no_such_style: the weapon has no Defence style; not_applied: the server
    // ignored the click (it does while the player is busy), so retry when idle.
    throw new Error(`${result.reason}: ${result.message}`);
}
```

It waits for `state.combatStyle.currentStyle` (varp 43, com_mode) to show the
new style. com_mode isn't saved: **every login resets it to 0** (the first
style, usually Accurate), so set it again after a reconnect.

## Checking Combat State

```typescript
const state = sdk.getState();
const inCombat = state?.player?.combat.inCombat ?? false;

// Animation is a useful heuristic, but is not specific to combat.
const isAnimating = (state?.player?.animId ?? -1) !== -1;
```

## Safe Training Locations

| Location | Coordinates | Targets | Notes |
|----------|-------------|---------|-------|
| Lumbridge cows | (3253, 3290) | Cows | Safe, good for all levels. South gate at (3253, 3266) |
| Lumbridge goblins | (3252, 3230) | Goblins, rats | Mixed enemies. Cluster runs NE from here — nothing at the old (3240, 3220) waypoint |
| Lumbridge chickens | (3237, 3295) | Chickens | Very safe, feathers drop |
| Al Kharid warriors | ~(3293, 3170) | `Al-Kharid warrior` (lvl 9) | Faster XP, kebabs nearby for food, can hit hard via multicombat vs low combat levels. |

## Cow Field Details (Proven from 200+ kills)

The cow field is fenced with a gate on the south side:
- **Field center**: ~(3253, 3290)
- **South gate position**: (3253, 3266)
- **Inside cow pen**: x between 3242-3265, z between 3255-3298

```typescript
function isInsideCowPen(x, z) {
    return x >= 3242 && x <= 3265 && z >= 3255 && z <= 3298;
}
```

## Opening Gates

Cow field and chicken coop have fenced gates:

```typescript
// Check for gate blocking path
const gate = sdk.getState()?.nearbyLocs.find(l => /gate/i.test(l.name));
if (gate) {
    const openOpt = gate.optionsWithIndex.find(o => /^open$/i.test(o.text));
    if (openOpt) {
        await bot.openDoor(gate);
    }
}
```

## Finding New Targets

After killing an NPC, find the next one quickly:

```typescript
async function findTarget(pattern) {
    const state = sdk.getState();
    if (!state) return null;

    return state.nearbyNpcs
        .filter(n => pattern.test(n.name))
        .filter(n => n.optionsWithIndex.some(o => /attack/i.test(o.text)))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
}
```

## Looting Ground Items

**CRITICAL**: Use `sdk.scanGroundItems()` NOT `state.nearbyLocs` for dropped items!

```typescript
// WRONG - nearbyLocs is for static objects (trees, rocks, etc.)
const wrongLoot = sdk.getState()?.nearbyLocs.filter(i => /hide/i.test(i.name));  // Won't work!

// CORRECT - scanGroundItems() for drops
const groundItems = await sdk.scanGroundItems();
const loot = groundItems.filter(i => /hide|bones|coins/i.test(i.name));
```

### Limit Pickups Per Loop

Pick up a few items (e.g. 3), then return to combat. Prevents getting stuck in infinite loot loops:

```typescript
const MAX_PICKUPS = 3;
const groundItems = await sdk.scanGroundItems();
const loot = groundItems
    .filter(i => /hide|bones/i.test(i.name))
    .filter(i => i.distance < 5)
    .slice(0, MAX_PICKUPS);

for (const item of loot) {
    await bot.pickupItem(item);
    await new Promise(r => setTimeout(r, 500));
}
// Back to combat
```

## Error Handling for Long Runs (Critical!)

Timeouts and errors are frequent in crowded areas. Wrap attacks in try/catch:

```typescript
// This pattern enabled consistent 10-minute runs
try {
    await bot.attack(/cow/i);
} catch (err) {
    console.log(`Attack timed out, trying next cow`);
    continue;  // Don't crash - just find another target
}
```

### Common Messages and Handling

| Message | Meaning | Response |
|---------|---------|----------|
| "I'm already under attack" | Crowded area, NPC in combat | Find different target |
| "I can't reach that!" | Obstacle or fence | Move closer, check gates |
| Attack timeout | Target died/moved | Try next NPC |

### State Validation

Browser glitches sometimes return invalid positions. Validate state before acting:

```typescript
const player = sdk.getState()?.player;
if (!player || player.worldX === 0 || player.worldZ === 0) {
    console.log('Invalid state - waiting for sync');
    await new Promise(r => setTimeout(r, 2000));
    continue;
}

// Also catch impossible position changes (>500 tiles = glitch)
if (Math.abs(player.worldX - lastX) > 500) {
    console.log('Position glitch detected, skipping action');
    continue;
}
```

## Auto-Train Lowest Combat Stat

For balanced progression, automatically train whichever stat is lowest:

```typescript
function getLowestCombatStat(state) {
    const skills = state.skills;
    const atk = skills.find(s => s.name === 'Attack')?.baseLevel ?? 1;
    const str = skills.find(s => s.name === 'Strength')?.baseLevel ?? 1;
    const def = skills.find(s => s.name === 'Defence')?.baseLevel ?? 1;

    if (def <= atk && def <= str) return 'Defence';
    if (str <= atk) return 'Strength';
    return 'Attack';
}

const state = sdk.getState();
if (!state) throw new Error('No world state');
const stat = getLowestCombatStat(state);
const result = await bot.setCombatStyle({ trains: stat });
if (!result.success) throw new Error(`No ${stat} style: ${result.message}`);
console.log(`Training ${stat} with ${result.style?.name}`);
```

This pattern enabled balanced 60+ in all melee stats.
