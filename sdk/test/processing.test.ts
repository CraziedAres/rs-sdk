import { afterEach, describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';
import { matchInventory, pickForSend, resolveMakeButton, resolveSpell, sideCapacity } from '../processing';
import type { BurstResult, InventoryItem, PacedResult } from '../types';

// A fake server: a new state object every tick (as real frames are), up to 5
// player packets applied per tick, and ops sent while the player is delayed
// dropped with only opFeedback.opRejectedCount moving.

type Op = { kind: 'combine'; src: number; dst: number } | { kind: 'use'; slot: number; op: number } | { kind: 'spell'; slot: number; spell: number };
interface World {
    tick: number;
    inventory: InventoryItem[];
    xp: Record<string, number>;
    rejected: number;
    delayedUntil: number;
    dialog: { isOpen: boolean; options: { index: number; text: string }[] };
}

const item = (id: number, name: string, slot: number, count = 1, options: string[] = []): InventoryItem =>
    ({ id, name, slot, count, optionsWithIndex: options.map((text, i) => ({ text, opIndex: i + 1 })) } as unknown as InventoryItem);

const timers: ReturnType<typeof setInterval>[] = [];
afterEach(() => { while (timers.length) clearInterval(timers.pop()!); });

function harness(world: World, rules: {
    combine?: (w: World, src: InventoryItem, dst: InventoryItem) => boolean | 'reject';
    use?: (w: World, it: InventoryItem, op: number) => boolean | 'reject';
    spell?: (w: World, it: InventoryItem, spell: number) => boolean | 'reject';
    perTickLimit?: number;
}) {
    const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
    const internal = sdk as any;
    const queue: Op[] = [];
    const perTickSends: number[] = [];
    const frame = () => ({
        tick: world.tick,
        inGame: true,
        player: { worldX: 3200, worldZ: 3200, animId: -1 },
        inventory: world.inventory.map(i => ({ ...i })),
        skills: Object.entries(world.xp).map(([name, experience]) => ({ name, experience, level: 1, baseLevel: 1 })),
        gameMessages: [],
        recentDialogs: [],
        dialog: { isOpen: world.dialog.isOpen, options: world.dialog.options.map(o => ({ ...o })) },
        interface: { isOpen: false, interfaceId: -1, options: [] },
        bank: { isOpen: false, items: [], noteMode: false },
        shop: { isOpen: false },
        nearbyLocs: [],
        opFeedback: { mapFlagUnsetCount: world.rejected, lastMapFlagUnsetTick: -1, opRejectedCount: world.rejected, lastOpRejectedTick: -1 },
    });
    internal.state = frame();
    const bySlot = (slot: number) => world.inventory.find(i => i.slot === slot);
    const apply = (outcome: boolean | 'reject' | undefined) => { if (outcome === 'reject' || outcome === false) world.rejected++; };
    const step = () => {
        world.tick++;
        const batch = queue.splice(0, rules.perTickLimit ?? 5);
        perTickSends.push(batch.length);
        for (const op of batch) {
            if (world.tick < world.delayedUntil) { world.rejected++; continue; }
            if (op.kind === 'combine') {
                const a = bySlot(op.src), b = bySlot(op.dst);
                apply(a && b && rules.combine ? rules.combine(world, a, b) : false);
            } else if (op.kind === 'use') {
                const a = bySlot(op.slot);
                apply(a && rules.use ? rules.use(world, a, op.op) : false);
            } else {
                const a = bySlot(op.slot);
                apply(a && rules.spell ? rules.spell(world, a, op.spell) : false);
            }
        }
        internal.state = frame();
        for (const l of internal.stateListeners) l(internal.state);
    };
    const ok = async () => ({ success: true, message: 'dispatched' });
    sdk.sendUseItemOnItem = async (src: number, dst: number) => { queue.push({ kind: 'combine', src, dst }); return ok(); };
    sdk.sendUseItem = async (slot: number, op = 1) => { queue.push({ kind: 'use', slot, op }); return ok(); };
    sdk.sendSpellOnItem = async (slot: number, spell: number) => { queue.push({ kind: 'spell', slot, spell }); return ok(); };
    timers.push(setInterval(step, 4));
    const bot = new BotActions(sdk);
    return { sdk, bot, world, perTickSends, queue };
}

const removeOne = (w: World, it: InventoryItem, n = 1) => {
    it.count -= n;
    if (it.count <= 0) w.inventory = w.inventory.filter(i => i !== it);
};

describe('pure helpers', () => {
    test('side capacity: stacks and kept tools take every send, single items one each', () => {
        const stack = [item(52, 'Arrow shaft', 0, 300)];
        const singles = [item(1607, 'Uncut sapphire', 1), item(1607, 'Uncut sapphire', 2)];
        expect(sideCapacity(stack, false)).toBe(Infinity);
        expect(sideCapacity(singles, false)).toBe(2);
        expect(sideCapacity([item(1755, 'Chisel', 0)], false)).toBe(1);
        expect(sideCapacity([item(1755, 'Chisel', 0)], true)).toBe(Infinity);
        expect(pickForSend(singles, 1, 2)?.slot).toBe(2);
        expect(pickForSend(stack, 3, Infinity)?.slot).toBe(0);
    });

    test('a string target matches the exact name before a substring', () => {
        const inv = [item(1, 'Bones', 0), item(2, 'Big bones', 1)];
        expect(matchInventory(inv, 'bones').map(i => i.slot)).toEqual([0]);
        expect(matchInventory(inv, /bones$/i).map(i => i.slot)).toEqual([0, 1]);
        expect(matchInventory(inv, 'big').map(i => i.slot)).toEqual([1]);
    });

    test('make buttons: the quantity run just before the named product', () => {
        const options = ['Make X', 'Make 10', 'Make 5', 'Short Bow', 'Make X', 'Make 10', 'Make 5', 'Long Bow'].map((text, i) => ({ index: i + 1, text }));
        expect(resolveMakeButton(options, 'long bow', 27)).toMatchObject({ option: { index: 5 }, count: 27 });
        expect(resolveMakeButton(options, 'long bow', 5)).toMatchObject({ option: { index: 7 }, count: null });
        expect(resolveMakeButton(options, 'short', 10)).toMatchObject({ option: { index: 2 }, count: null });
        expect(resolveMakeButton(options, 'short', 1)).toMatchObject({ option: { index: 4 }, count: null });
        expect(resolveMakeButton(options, 'crossbow', 1)).toBeNull();
    });

    test('spell names resolve', () => {
        expect(resolveSpell('high alchemy')?.name).toBe('HIGH_ALCHEMY');
        expect(resolveSpell('High Alch')?.name).toBe('HIGH_ALCHEMY');
        expect(resolveSpell(1178)?.name).toBe('HIGH_ALCHEMY');
        expect(resolveSpell('enchant lvl3')?.name).toBe('ENCHANT_LVL3');
        expect(resolveSpell('fireball')).toBeNull();
    });
});

describe('useItemOnItem bursts', () => {
    test('a no-delay stack combine sends 5 per tick and every send takes effect', async () => {
        const h = harness({ tick: 100, inventory: [item(52, 'Arrow shaft', 0, 300), item(314, 'Feather', 1, 300)], xp: { Fletching: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {
            combine: (w, a, b) => { removeOne(w, a, 15); removeOne(w, b, 15); w.xp.Fletching! += 375; const hl = w.inventory.find(i => i.id === 53); if (hl) hl.count += 15; else w.inventory.push(item(53, 'Headless arrow', 2, 15)); return true; },
        });
        const r = await h.bot.useItemOnItem('Arrow shaft', 'Feather', { times: 12, perTick: 5 });
        expect(r.success).toBe(true);
        expect(r.perTick.map(t => t.sent)).toEqual([5, 5, 2]);
        expect(r.xpGained).toBe(12 * 375);
        expect(r.rejected).toBe(0);
        expect(Math.max(...h.perTickSends)).toBeLessThanOrEqual(5);
    });

    test('a tool side is learned after the first tick, then single items go out on distinct slots', async () => {
        const gems = Array.from({ length: 7 }, (_, i) => item(1623, 'Uncut sapphire', i + 1));
        const h = harness({ tick: 100, inventory: [item(1755, 'Chisel', 0), ...gems], xp: { Crafting: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {
            combine: (w, _chisel, gem) => { if (!/uncut/i.test(gem.name)) return false; gem.id = 1607; gem.name = 'Sapphire'; w.xp.Crafting! += 1250; return true; },
        });
        const r = await h.bot.useItemOnItem(/^chisel$/i, /^uncut sapphire$/i, { times: 7, perTick: 5 });
        expect(r.perTick.map(t => t.sent)).toEqual([1, 5, 1]);
        expect(r.xpGained).toBe(7 * 1250);
        expect(r.rejected).toBe(0);
    });

    test('runs out cleanly when one side is used up', async () => {
        const h = harness({ tick: 100, inventory: [item(52, 'Arrow shaft', 0, 30), item(314, 'Feather', 1, 300)], xp: { Fletching: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {
            combine: (w, a, b) => { removeOne(w, a, 15); removeOne(w, b, 15); w.xp.Fletching! += 375; return true; },
        });
        const r = await h.bot.useItemOnItem('Arrow shaft', 'Feather', { times: 50, perTick: 5, keep: 'both' });
        // Two combines' worth of shafts; extra sends that tick find no shafts and are lost, then the side is empty.
        expect(r.xpGained).toBe(2 * 375);
        expect(r.reason).toBe('out_of_items');
        expect(r.success).toBe(true);
    });

    test('a tick with a rejected op drops the rest of the call to one send per tick', async () => {
        const h = harness({ tick: 100, inventory: [item(52, 'Arrow shaft', 0, 3000), item(314, 'Feather', 1, 3000)], xp: { Fletching: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {
            perTickLimit: 3, // this server only reads 3 a tick: the other 2 wait, and the fake counts the overflow as rejected below
            combine: (w, a, b) => { removeOne(w, a, 15); removeOne(w, b, 15); w.xp.Fletching! += 375; return true; },
        });
        // Make the overflow visible as a rejection, as a dropped op would be.
        const origStep = h.queue;
        void origStep;
        let first = true;
        const sdkAny = h.sdk as any;
        const send = h.sdk.sendUseItemOnItem;
        sdkAny.sendUseItemOnItem = async (s: number, d: number) => { if (first) { h.world.rejected++; first = false; } return send(s, d); };
        const r = await h.bot.useItemOnItem('Arrow shaft', 'Feather', { times: 8, perTick: 5 });
        expect(r.fellBackToOnePerTick).toBe(true);
        expect(r.perTick[0]!.sent).toBe(5);
        expect(r.perTick.slice(1).every(t => t.sent === 1)).toBe(true);
    });

    test('refuses up front with the bank open', async () => {
        const h = harness({ tick: 100, inventory: [item(52, 'Arrow shaft', 0, 30), item(314, 'Feather', 1, 30)], xp: {}, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {});
        (h.sdk as any).state.bank.isOpen = true;
        const r = await h.bot.useItemOnItem('Arrow shaft', 'Feather', { times: 2, perTick: 5 });
        expect(r).toMatchObject({ success: false, reason: 'modal_open', sent: 0 });
    });
});

describe('effect-paced ops', () => {
    const bones = (n: number) => Array.from({ length: n }, (_, i) => item(532, 'Big bones', i, 1, ['Bury', 'Drop']));
    // bury_bone.rs2: the op starts a delay; the player takes the next op 3 ticks later.
    const bury = (w: World, it: InventoryItem, op: number) => { if (op !== 1) return false; removeOne(w, it); w.xp.Prayer! += 375; w.delayedUntil = w.tick + 3; return true; };

    test('burying learns the cooldown, then a call given it drops nothing', async () => {
        const h = harness({ tick: 100, inventory: bones(10), xp: { Prayer: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, { use: bury });
        const first = await h.bot.useInventoryItems(/^big bones$/i, 'Bury', { max: 4 }) as PacedResult;
        expect(first.done).toBe(4);
        expect(first.xpGained).toBe(4 * 375);
        expect(first.cooldownTicks).toBeGreaterThanOrEqual(1);
        const second = await h.bot.useInventoryItems(/^big bones$/i, 'Bury', { max: 6, cooldownTicks: first.cooldownTicks }) as PacedResult;
        expect(second.done).toBe(6);
        expect(second.dropped).toBe(0);
        expect(h.world.inventory.length).toBe(0);
    });

    test('an option the item lacks fails without sending', async () => {
        const h = harness({ tick: 100, inventory: bones(2), xp: { Prayer: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, { use: bury });
        const r = await h.bot.useInventoryItems(/^big bones$/i, 'Eat') as PacedResult;
        expect(r).toMatchObject({ success: false, reason: 'no_option', sent: 0 });
    });

    test('identify bursts 5 per tick when asked', async () => {
        const herbs = Array.from({ length: 10 }, (_, i) => item(199, 'Unidentified guam', i, 1, ['Identify']));
        const h = harness({ tick: 100, inventory: herbs, xp: { Herblore: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {
            use: (w, it) => { it.id = 249; it.name = 'Guam leaf'; it.optionsWithIndex = []; w.xp.Herblore! += 62.5; return true; },
        });
        const r = await h.bot.useInventoryItems(/^unidentified guam$/i, 'Identify', { perTick: 5 }) as BurstResult;
        expect(r.perTick.map(t => t.sent)).toEqual([5, 5]);
        expect(r.xpGained).toBe(625);
    });
});

describe('castOnItem waits out the spell delay', () => {
    test('back-to-back High Alchemy casts each land first time', async () => {
        const bows = Array.from({ length: 3 }, (_, i) => item(855, 'Yew longbow', i));
        const h = harness({ tick: 100, inventory: bows, xp: { Magic: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {
            spell: (w, it, spell) => { if (spell !== 1178) return false; removeOne(w, it); w.xp.Magic! += 1625; w.delayedUntil = w.tick + 5; return true; },
        });
        const results = [];
        for (let i = 0; i < 3; i++) results.push(await h.bot.castOnItem('high alchemy', /^yew longbow$/i));
        expect(results.map(r => r.success)).toEqual([true, true, true]);
        expect(results.map(r => r.retries)).toEqual([0, 0, 0]);
        expect(h.world.rejected).toBe(0);
        expect(results[1]!.castTick! - results[0]!.castTick!).toBe(5);
    });

    test('enchantItem no longer returns inside the delay', async () => {
        const rings = Array.from({ length: 2 }, (_, i) => item(1637, 'Sapphire ring', i));
        const h = harness({ tick: 100, inventory: rings, xp: { Magic: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {
            spell: (w, it) => { it.id = 2550; it.name = 'Ring of recoil'; w.xp.Magic! += 437.5; w.delayedUntil = w.tick + 3; return true; },
        });
        (h.sdk as any).getSkill = (name: string) => (h.sdk.getState()!.skills.find(s => s.name === name));
        const a = await h.bot.enchantItem(/^sapphire ring$/i, 1);
        const b = await h.bot.enchantItem(/^sapphire ring$/i, 1);
        expect(a.success && b.success).toBe(true);
        expect(h.world.rejected).toBe(0);
    });
});

describe('makeX', () => {
    test('clicks Make X for the product, answers the count, and counts each grant', async () => {
        const options = ['Make X', 'Make 10', 'Make 5', 'Short Bow', 'Make X', 'Make 10', 'Make 5', 'Long Bow'].map((text, i) => ({ index: i + 1, text }));
        const logs = Array.from({ length: 6 }, (_, i) => item(1517, 'Maple logs', i + 1));
        const world: World = { tick: 100, inventory: [item(946, 'Knife', 0), ...logs], xp: { Fletching: 0 }, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } };
        const h = harness(world, { combine: w => { w.dialog = { isOpen: true, options }; return true; } });
        let clicked = -1, counted = -1, remaining = 0;
        h.sdk.sendClickDialog = async (i: number) => { clicked = i; world.dialog = { isOpen: false, options: [] }; return { success: true, message: 'ok' }; };
        h.sdk.sendCountDialog = async (n: number) => { counted = n; remaining = n; return { success: true, message: 'ok' }; };
        // One bow per 2 ticks while the count lasts (cut_logs.rs2 weakqueue).
        const timer = setInterval(() => {
            if (remaining > 0 && world.tick % 2 === 0) {
                const log = world.inventory.find(i => i.id === 1517);
                if (!log) { remaining = 0; return; }
                removeOne(world, log);
                world.inventory.push(item(62, 'Maple longbow (u)', 20 + remaining));
                world.xp.Fletching! += 1458;
                remaining--;
            }
        }, 4);
        timers.push(timer);
        const r = await h.bot.makeX('long bow', 6, { open: { use: 'Knife', on: /^maple logs$/i }, skill: 'Fletching' });
        expect(clicked).toBe(5);
        expect(counted).toBe(6);
        expect(r.made).toBe(6);
        expect(r.success).toBe(true);
        expect(r.product).toContain('Long Bow');
    });

    test('names the products when none match', async () => {
        const options = ['Make X', 'Make 10', 'Make 5', 'Wool'].map((text, i) => ({ index: i + 1, text }));
        const h = harness({ tick: 100, inventory: [], xp: {}, rejected: 0, delayedUntil: 0, dialog: { isOpen: true, options } }, {});
        const r = await h.bot.makeX('flax', 28);
        expect(r).toMatchObject({ success: false, reason: 'no_product' });
        expect(r.message).toContain('Wool');
    });
});

describe('bank loads', () => {
    test('depositAllExcept keeps tools and deposits each other kind once', async () => {
        const h = harness({ tick: 100, inventory: [item(946, 'Knife', 0), item(62, 'Maple longbow (u)', 1), item(62, 'Maple longbow (u)', 2), item(1777, 'Bow string', 3)], xp: {}, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {});
        (h.sdk as any).state.bank.isOpen = true;
        const deposits: string[] = [];
        h.bot.depositItem = async (it: any) => {
            deposits.push(it.name);
            h.world.inventory = h.world.inventory.filter(i => i.id !== it.id);
            (h.sdk as any).state.inventory = h.world.inventory.map(i => ({ ...i }));
            return { success: true, message: 'ok' } as any;
        };
        const r = await h.bot.depositAllExcept([/^knife$/i]);
        expect(r.success).toBe(true);
        expect(deposits).toEqual(['Maple longbow (u)', 'Bow string']);
    });

    test('withdrawMany reports what the bank lacks', async () => {
        const h = harness({ tick: 100, inventory: [], xp: {}, rejected: 0, delayedUntil: 0, dialog: { isOpen: false, options: [] } }, {});
        const st = (h.sdk as any).state;
        st.bank = { isOpen: true, items: [{ id: 1517, name: 'Maple logs', count: 100, slot: 0 }], noteMode: false };
        h.bot.withdrawItem = async (_it: any, amount: number) => {
            const now = (h.sdk as any).state;
            now.inventory = Array.from({ length: amount }, (_, i) => item(1517, 'Maple logs', i));
            return { success: true, message: 'ok' } as any;
        };
        const r = await h.bot.withdrawMany([{ item: /^maple logs$/i, amount: 27 }, { item: /^bow string$/i, amount: 1 }]);
        expect(r.success).toBe(false);
        expect(r.withdrawn).toEqual([{ item: 'Maple logs', amount: 27 }]);
        expect(r.missing).toEqual(['/^bow string$/i']);
    });
});
