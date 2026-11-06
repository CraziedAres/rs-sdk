/**
 * tryCutBlockingWeb: a slashable web beside the player is cut (a held knife, else the Slash op), retried while it
 * still offers Slash (half the tries work: web.rs2), and marked open in this session's path queries once cut.
 */
import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';

function makeBot(opts: { knife: boolean; cutsAfter: number; refuse?: boolean }) {
    const sdk = new BotSDK({ botUsername: 'test' });
    let tick = 1;
    let tries = 0;
    let cut = false;
    const messages: { text: string; tick: number }[] = [];
    const web = () => ({
        id: cut ? 734 : 733, name: cut ? 'Slashed web' : 'Web', x: 3158, z: 3951, level: 0, distance: 1,
        options: cut ? [] : ['Slash'], optionsWithIndex: cut ? [] : [{ text: 'Slash', opIndex: 1 }],
    });
    const state = () => ({
        player: { worldX: 3158, worldZ: 3950, level: 0 }, tick, gameMessages: messages, nearbyLocs: [web()], nearbyNpcs: [],
        inventory: opts.knife ? [{ name: 'Knife', slot: 4, id: 946, count: 1 }] : [],
    });
    (sdk as any).getState = state;
    (sdk as any).getNearbyLocs = () => state().nearbyLocs;
    (sdk as any).waitForTicks = async (n: number) => { tick += n; };
    const sent: string[] = [];
    const attempt = () => {
        tries++;
        if (opts.refuse) messages.push({ text: 'Only a sharp blade can cut through this sticky web.', tick });
        else if (tries >= opts.cutsAfter) cut = true;
    };
    (sdk as any).sendUseItemOnLoc = async (slot: number) => { sent.push(`knife slot ${slot}`); attempt(); return { success: true }; };
    (sdk as any).sendInteractLoc = async (_x: number, _z: number, _id: number, op: number) => { sent.push(`op ${op}`); attempt(); return { success: true }; };
    const bot = new BotActions(sdk);
    return { sdk, bot, sent, tries: () => tries };
}

describe('tryCutBlockingWeb', () => {
    test('a held knife on the web, retried until it is cut, then the web is open in this session', async () => {
        const { sdk, bot, sent, tries } = makeBot({ knife: true, cutsAfter: 3 });
        expect(await (bot as any).helpers.tryCutBlockingWeb()).toBe(true);
        expect(tries()).toBe(3);
        expect(sent.every(s => s === 'knife slot 4')).toBe(true);
        expect(sdk.isLocTemporarilyOpen(0, 3158, 3951)).toBe(true);
    });

    test('no knife: the Slash op (a slash weapon equipped)', async () => {
        const { sdk, bot, sent } = makeBot({ knife: false, cutsAfter: 1 });
        expect(await (bot as any).helpers.tryCutBlockingWeb()).toBe(true);
        expect(sent).toEqual(['op 1']);
        expect(sdk.isLocTemporarilyOpen(0, 3158, 3951)).toBe(true);
    });

    test('nothing sharp: the refusal stops it, nothing marked open', async () => {
        const { sdk, bot, tries } = makeBot({ knife: false, cutsAfter: 99, refuse: true });
        expect(await (bot as any).helpers.tryCutBlockingWeb()).toBe(false);
        expect(tries()).toBe(1);
        expect(sdk.isLocTemporarilyOpen(0, 3158, 3951)).toBe(false);
    });
});
