import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';

const BRONZE_BAR = 2349;
const ANVIL = { id: 2783, name: 'Anvil', x: 3188, z: 3426, distance: 1, reachable: true, optionsWithIndex: [] };

function bars(count: number) {
    return Array.from({ length: count }, (_, i) => ({ id: BRONZE_BAR, name: 'Bronze bar', count: 1, slot: i + 1 }));
}

function harness(barCount: number) {
    const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
    const internal = sdk as any;
    internal.state = {
        tick: 100,
        player: { animId: -1, x: 3188, z: 3425, worldX: 3188, worldZ: 3425 },
        inventory: [{ id: 2347, name: 'Hammer', count: 1, slot: 0 }, ...bars(barCount)],
        skills: [{ name: 'Smithing', experience: 1000 }],
        nearbyLocs: [ANVIL],
        gameMessages: [],
        recentDialogs: [],
        dialog: { isOpen: false, options: [] },
        interface: { isOpen: false, interfaceId: -1, options: [] },
    };
    const bot = new BotActions(sdk);
    const s = () => internal.state;
    const publish = () => setTimeout(() => { for (const l of internal.stateListeners) l(s()); }, 0);
    const calls = { use: 0, click: 0 };
    let observation = 0;
    const openDialog = (text: string) => {
        s().interface = { isOpen: false, interfaceId: -1, options: [] };
        s().dialog = { isOpen: true, options: [{ index: 1, text: 'Click here to continue' }] };
        s().recentDialogs = [{ text: [text], tick: s().tick, observationId: ++observation, interfaceId: 210 }, ...s().recentDialogs];
    };
    const smithOne = (cost: number) => {
        s().tick += 2;
        s().interface = { isOpen: false, interfaceId: -1, options: [] };
        s().inventory = s().inventory.filter((item: any) => item.id !== BRONZE_BAR).concat(bars(barCount - cost));
        s().inventory.push({ id: 1117, name: 'Bronze platebody', count: 1, slot: 27 });
        s().skills[0].experience += 62.5 * cost;
    };
    sdk.sendUseItemOnLoc = async () => {
        calls.use++;
        s().interface = { isOpen: true, interfaceId: 994, options: [] };
        return { success: true, message: 'dispatched' };
    };
    sdk.sendClickDialog = async () => {
        s().dialog = { isOpen: false, options: [] };
        publish();
        return { success: true, message: 'dispatched' };
    };
    return { sdk, bot, s, publish, calls, openDialog, smithOne };
}

describe('smithAtAnvil completion evidence', () => {
    test('fails fast when too few bars are held, without touching the anvil', async () => {
        const h = harness(4);
        h.sdk.sendUseItemOnLoc = async () => { throw new Error('must not use bars on the anvil'); };
        expect(await h.bot.smithAtAnvil('bronze platebody')).toMatchObject({ success: false, reason: 'no_bars' });
    });

    test('reads a not-enough-bars chat-box refusal instead of waiting out the timeout', async () => {
        const h = harness(4);
        // A bare component id carries no bar cost, so only the server can refuse.
        h.sdk.sendClickComponentWithOption = async () => {
            h.calls.click++;
            h.s().tick += 1;
            h.openDialog("You don't have enough bronze bars to make a platebody.");
            h.publish();
            return { success: true, message: 'dispatched' };
        };
        const started = Date.now();
        const result = await h.bot.smithAtAnvil(1121, { barPattern: /bronze bar/i, timeout: 60_000 });
        expect(result).toMatchObject({ success: false, reason: 'no_bars' });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(h.calls.use).toBe(1);
    });

    test('retries when a late level-up dialog closes the anvil before the click', async () => {
        const h = harness(10);
        h.sdk.sendUseItemOnLoc = async () => {
            h.calls.use++;
            if (h.calls.use === 1) {
                // The previous smith's level-up arrives on top of the anvil.
                h.openDialog('Congratulations, you just advanced a Smithing level.');
            } else {
                h.s().interface = { isOpen: true, interfaceId: 994, options: [] };
            }
            return { success: true, message: 'dispatched' };
        };
        h.sdk.sendClickComponentWithOption = async () => {
            h.calls.click++;
            h.smithOne(5);
            h.publish();
            return { success: true, message: 'dispatched' };
        };
        const result = await h.bot.smithAtAnvil('bronze platebody');
        expect(result).toMatchObject({ success: true, xpGained: 312.5, product: { name: 'Bronze platebody' } });
        expect(h.calls).toEqual({ use: 2, click: 1 });
    });

    test('counts a used-up bar as success before the XP is published', async () => {
        const h = harness(5);
        h.sdk.sendClickComponentWithOption = async () => {
            h.smithOne(5);
            h.s().skills[0].experience = 1000; // XP not in this state yet
            h.publish();
            return { success: true, message: 'dispatched' };
        };
        expect(await h.bot.smithAtAnvil('bronze platebody')).toMatchObject({ success: true, itemsSmithed: 1 });
    });

    test('still times out when the click produces nothing', async () => {
        const h = harness(5);
        h.sdk.sendClickComponentWithOption = async () => ({ success: true, message: 'dispatched' });
        expect(await h.bot.smithAtAnvil('bronze platebody', { timeout: 50 })).toMatchObject({ success: false, reason: 'timeout' });
    });

    test('gives up with the dialog text when every attempt is interrupted', async () => {
        const h = harness(5);
        h.sdk.sendUseItemOnLoc = async () => {
            h.calls.use++;
            h.openDialog('Something else entirely.');
            return { success: true, message: 'dispatched' };
        };
        const result = await h.bot.smithAtAnvil('bronze platebody');
        expect(result).toMatchObject({ success: false, reason: 'interrupted' });
        expect(result.message).toContain('something else entirely');
        expect(h.calls.use).toBe(3);
    });
});
