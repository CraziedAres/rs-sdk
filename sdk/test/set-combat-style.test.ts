import { describe, expect, test } from 'bun:test';
import { BotActions } from '../actions';
import type { CombatStyleOption, CombatStyleState } from '../types';

const style = (index: number, name: string, type: string, trainsSkills: string[], damageType: string): CombatStyleOption =>
    ({ index, name, type, trainsSkills, damageType });

// Stabsword (bronze dagger/sword) and scimitar tables, as StateCollector publishes them:
// index 2 is aggressive Slash on one and controlled Stab on the other.
const STABSWORD = [
    style(0, 'Stab', 'Accurate', ['Attack'], 'Stab'),
    style(1, 'Lunge', 'Aggressive', ['Strength'], 'Stab'),
    style(2, 'Slash', 'Aggressive', ['Strength'], 'Slash'),
    style(3, 'Block', 'Defensive', ['Defence'], 'Stab'),
];
const SCIMITAR = [
    style(0, 'Chop', 'Accurate', ['Attack'], 'Slash'),
    style(1, 'Slash', 'Aggressive', ['Strength'], 'Slash'),
    style(2, 'Lunge', 'Controlled', ['Attack', 'Strength', 'Defence'], 'Stab'),
    style(3, 'Block', 'Defensive', ['Defence'], 'Slash'),
];
const CONTROLLED_ONLY = [
    style(0, 'Pound', 'Controlled', ['Attack', 'Strength', 'Defence'], 'Crush'),
];

function combatStyle(styles: CombatStyleOption[], currentStyle = 0, known = true): CombatStyleState {
    return { currentStyle, weaponName: 'Bronze sword', styles, tabInterfaceId: 2276, known };
}

/**
 * A fake SDK whose com_mode follows the click unless the server is "busy",
 * in which case the click is dropped (the varp only resyncs).
 */
function createBot(initial: CombatStyleState | undefined, options: { busyClicks?: number; dispatchFails?: boolean } = {}) {
    let current = initial;
    let busy = options.busyClicks ?? 0;
    const clicks: number[] = [];
    const state = () => ({
        dialog: { isOpen: false, options: [] },
        interface: { isOpen: false, interfaceId: -1 },
        shop: { isOpen: false },
        bank: { isOpen: false },
        combatStyle: current,
    });
    const sdk = {
        getState: () => state(),
        sendSetCombatStyle: async (index: number) => {
            clicks.push(index);
            if (options.dispatchFails) return { success: false, message: 'no combat tab' };
            if (busy > 0) busy--;
            else if (current) current = { ...current, currentStyle: index };
            return { success: true, message: 'dispatched' };
        },
        waitForCondition: async (predicate: (s: any) => boolean) => {
            if (predicate(state())) return state();
            throw new Error('waitForCondition timed out');
        },
        waitForStateChange: async () => state(),
    };
    return { bot: new BotActions(sdk as any), clicks };
}

describe('BotActions.setCombatStyle', () => {
    test('picks the style that trains only the skill and confirms com_mode', async () => {
        const { bot, clicks } = createBot(combatStyle(SCIMITAR));
        const result = await bot.setCombatStyle({ trains: 'Strength' });
        expect(result.success).toBe(true);
        expect(result.changed).toBe(true);
        expect(result.style?.index).toBe(1);
        expect(clicks).toEqual([1]);
    });

    test('resolves by skill per weapon, not by a fixed index', async () => {
        const stab = await createBot(combatStyle(STABSWORD)).bot.setCombatStyle({ trains: 'Defence' });
        const scim = await createBot(combatStyle(SCIMITAR)).bot.setCombatStyle({ trains: 'Defence' });
        expect(stab.style?.index).toBe(3);
        expect(scim.style?.index).toBe(3);
        // Controlled (index 2 on a scimitar) is never chosen while a single-skill style exists.
        const str = await createBot(combatStyle(SCIMITAR)).bot.setCombatStyle({ trains: 'Strength' });
        expect(str.style?.type).toBe('Aggressive');
    });

    test('falls back to a controlled style when nothing trains the skill alone', async () => {
        const result = await createBot(combatStyle(CONTROLLED_ONLY)).bot.setCombatStyle({ trains: 'Defence' });
        expect(result.success).toBe(true);
        expect(result.style?.type).toBe('Controlled');
    });

    test('does not click a non-zero style that is already selected', async () => {
        const { bot, clicks } = createBot(combatStyle(STABSWORD, 3));
        const result = await bot.setCombatStyle({ trains: 'Defence' });
        expect(result).toMatchObject({ success: true, changed: false });
        expect(clicks).toEqual([]);
    });

    test('always clicks index 0, since com_mode reads 0 before the server sends it', async () => {
        const { bot, clicks } = createBot(combatStyle(STABSWORD, 0));
        const result = await bot.setCombatStyle({ trains: 'Attack' });
        expect(result).toMatchObject({ success: true, changed: false });
        expect(clicks).toEqual([0]);
    });

    test('retries once when the server drops the click', async () => {
        const { bot, clicks } = createBot(combatStyle(STABSWORD), { busyClicks: 1 });
        const result = await bot.setCombatStyle({ trains: 'Strength' });
        expect(result.success).toBe(true);
        expect(clicks).toEqual([1, 1]);
    });

    test('reports not_applied when com_mode never changes', async () => {
        const { bot, clicks } = createBot(combatStyle(STABSWORD), { busyClicks: 5 });
        const result = await bot.setCombatStyle({ trains: 'Strength' });
        expect(result).toMatchObject({ success: false, reason: 'not_applied' });
        expect(clicks).toHaveLength(2);
    });

    test('reports no_such_style on an unrecognised tab instead of guessing', async () => {
        const unknownTab = [style(0, 'Style 0', 'Unknown', [], 'Unknown'), style(1, 'Style 1', 'Unknown', [], 'Unknown')];
        const result = await createBot(combatStyle(unknownTab, 0, false)).bot.setCombatStyle({ trains: 'Strength' });
        expect(result.reason).toBe('no_such_style');
        expect(result.message).toContain('unrecognised');
    });

    test('takes a raw index that exists on the tab', async () => {
        const ok = await createBot(combatStyle(STABSWORD)).bot.setCombatStyle(2);
        const missing = await createBot(combatStyle(CONTROLLED_ONLY)).bot.setCombatStyle(3);
        expect(ok.success).toBe(true);
        expect(missing.reason).toBe('no_such_style');
    });

    test('reports missing state and dispatch failures', async () => {
        expect((await createBot(undefined).bot.setCombatStyle({ trains: 'Attack' })).reason).toBe('no_combat_style_state');
        expect((await createBot(combatStyle(STABSWORD), { dispatchFails: true }).bot.setCombatStyle({ trains: 'Strength' })).reason).toBe('dispatch_failed');
    });
});
