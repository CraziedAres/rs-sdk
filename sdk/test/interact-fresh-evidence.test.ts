import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';

const CHOP_ANIM = 879;
const TREE = { id: 1276, name: 'Tree', x: 3200, z: 3230, distance: 1, reachable: true, optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] };
const STUMP = { ...TREE, id: 1342, name: 'Tree stump', optionsWithIndex: [] };
const SPOT = { index: 12, name: 'Fishing spot', x: 3240, z: 3150, distance: 1, reachable: true, optionsWithIndex: [{ text: 'Net', opIndex: 1 }] };

/**
 * The player is still showing the chop animation from the tree it just
 * felled. `animStartTick` undefined simulates a client that predates it.
 */
function harness(opts: { animStartTick?: number | null } = { animStartTick: 95 }) {
    const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
    const internal = sdk as any;
    const player: any = { animId: CHOP_ANIM, x: 3200, z: 3229, worldX: 3200, worldZ: 3229, level: 0 };
    if ('animStartTick' in opts) player.animStartTick = opts.animStartTick;
    internal.state = {
        tick: 100, player,
        inventory: [{ id: 1351, name: 'Bronze axe', count: 1, slot: 0 }],
        skills: [{ name: 'Woodcutting', experience: 5000 }, { name: 'Fishing', experience: 5000 }],
        nearbyLocs: [TREE], nearbyNpcs: [SPOT],
        gameMessages: [], recentDialogs: [],
        dialog: { isOpen: false, options: [] }, interface: { isOpen: false, interfaceId: -1, options: [] },
        opFeedback: { opRejectedCount: 0 },
    };
    // One ms per tick so the idle window and grace run fast.
    sdk.ticksToMs = (ticks: number) => ticks;
    const bot = new BotActions(sdk);
    const s = () => internal.state;
    /** Publish `n` more ticks, applying `change` before the first. */
    const tickAfterClick = (change: () => void = () => {}, n = 6) => {
        let i = 0;
        const step = () => {
            if (i === 0) change();
            s().tick += 1;
            for (const l of internal.stateListeners) l(s());
            if (++i < n) setTimeout(step, 0);
        };
        setTimeout(step, 0);
    };
    return { sdk, bot, s, tickAfterClick };
}

describe('interactLoc needs evidence from after the click', () => {
    test('a lingering animation from the previous action is not success', async () => {
        const h = harness();
        h.sdk.sendInteractLoc = async () => { h.tickAfterClick(); return { success: true, message: 'dispatched' }; };
        expect(await h.bot.interactLoc(/^tree$/i, /^chop/i)).toMatchObject({ success: false, reason: 'timeout' });
    });

    test('the same animation started again after the click is success', async () => {
        const h = harness();
        h.sdk.sendInteractLoc = async () => {
            h.tickAfterClick(() => { h.s().player.animStartTick = h.s().tick + 1; });
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.interactLoc(/^tree$/i, /^chop/i)).toMatchObject({ success: true });
    });

    test('the loc changing is success', async () => {
        const h = harness();
        h.sdk.sendInteractLoc = async () => {
            h.tickAfterClick(() => { h.s().nearbyLocs = [STUMP]; });
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.interactLoc(/^tree$/i, /^chop/i)).toMatchObject({ success: true });
    });

    test('logs or XP gained is success', async () => {
        const h = harness();
        h.sdk.sendInteractLoc = async () => {
            h.tickAfterClick(() => { h.s().inventory = [...h.s().inventory, { id: 1511, name: 'Logs', count: 1, slot: 1 }]; });
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.interactLoc(/^tree$/i, /^chop/i)).toMatchObject({ success: true });
    });

    test('an older client without animStartTick needs the animation to change', async () => {
        const stale = harness({});
        stale.sdk.sendInteractLoc = async () => { stale.tickAfterClick(); return { success: true, message: 'dispatched' }; };
        expect(await stale.bot.interactLoc(/^tree$/i, /^chop/i)).toMatchObject({ success: false });

        const restarted = harness({});
        restarted.sdk.sendInteractLoc = async () => {
            restarted.tickAfterClick(() => { restarted.s().player.animId = -1; }, 1);
            setTimeout(() => restarted.tickAfterClick(() => { restarted.s().player.animId = CHOP_ANIM; }, 3), 5);
            return { success: true, message: 'dispatched' };
        };
        expect(await restarted.bot.interactLoc(/^tree$/i, /^chop/i)).toMatchObject({ success: true });
    });

    test('an animation from idle is still success', async () => {
        const h = harness({ animStartTick: null });
        h.s().player.animId = -1;
        h.sdk.sendInteractLoc = async () => {
            h.tickAfterClick(() => { h.s().player.animId = CHOP_ANIM; h.s().player.animStartTick = h.s().tick + 1; });
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.interactLoc(/^tree$/i, /^chop/i)).toMatchObject({ success: true });
    });
});

describe('interactNpc needs evidence from after the click', () => {
    test('a lingering fishing animation is not success', async () => {
        const h = harness();
        h.sdk.sendInteractNpc = async () => { h.tickAfterClick(); return { success: true, message: 'dispatched' }; };
        expect(await h.bot.interactNpc(/fishing spot/i, /^net$/i)).toMatchObject({ success: false, reason: 'timeout' });
    });

    test('a fresh animation start is success', async () => {
        const h = harness();
        h.sdk.sendInteractNpc = async () => {
            h.tickAfterClick(() => { h.s().player.animStartTick = h.s().tick + 1; });
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.interactNpc(/fishing spot/i, /^net$/i)).toMatchObject({ success: true });
    });
});

describe('useItemOnLoc needs evidence from after the click', () => {
    test('a lingering animation is not success', async () => {
        const h = harness();
        h.sdk.sendUseItemOnLoc = async () => { h.tickAfterClick(); return { success: true, message: 'dispatched' }; };
        expect(await h.bot.useItemOnLoc(/bronze axe/i, /^tree$/i, { timeout: 20 })).toMatchObject({ success: false, reason: 'timeout' });
    });

    test('a fresh animation start is success', async () => {
        const h = harness();
        h.sdk.sendUseItemOnLoc = async () => {
            h.tickAfterClick(() => { h.s().player.animStartTick = h.s().tick + 1; });
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.useItemOnLoc(/bronze axe/i, /^tree$/i)).toMatchObject({ success: true });
    });
});
