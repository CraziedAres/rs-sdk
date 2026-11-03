// Processing porcelain: tick-aligned bursts of no-delay item combines, effect-paced
// delayed actions, make-X skill dialogs, spells on items, one-visit bank loads,
// obstacles and runecrafting altars.
//
// Two facts about the engine shape everything here:
// - The server reads up to 5 player packets per tick and applies them in order.
//   A no-delay op (fletching arrows, cutting gems, mixing potions, stringing)
//   therefore takes 5 per tick when 5 are sent within one tick.
// - An op sent while the player is delayed (p_delay: burying, alching,
//   enchanting) is dropped with no message: only `opFeedback.opRejectedCount`
//   moves. Those ops are paced by their effect instead: one send, wait for the
//   XP or inventory change, wait out the delay, send the next.
//
// Every helper judges itself by the effect the server applied (XP, inventory),
// never by the send's dispatch result.

import type { BotSDK } from './index';
import type { BotActions } from './actions';
import type {
    ActionResult,
    BotWorldState,
    DialogOption,
    InventoryItem,
    NearbyLoc,
    BankLoadResult,
    BurstResult,
    BurstTick,
    CastOnItemResult,
    CrossObstacleResult,
    CraftRunesResult,
    EnterRuinsResult,
    MakeXOpener,
    MakeXResult,
    PacedResult,
    WithdrawRequest,
} from './types';
import { exactNamePattern, resolveSkillDialogProduct, skillDialogProductLabels } from './action-quantity';
import { Spells, type SpellName } from './spells';
import { ticksToMs } from './tick-clock';

export type ItemTarget = InventoryItem | string | RegExp;

/** The server applies at most this many player packets per tick. */
export const MAX_OPS_PER_TICK = 5;

/**
 * Ticks from one accepted cast to the next for spells cast on an item
 * (server scripts: alchemy.rs2 p_delay(3) for High Alchemy, p_delay(1) for Low
 * Alchemy; enchant.rs2 p_delay(1)). One cast lands per this many ticks; a cast
 * sent sooner is dropped.
 */
export const SPELL_PERIOD_TICKS: Partial<Record<SpellName, number>> = {
    HIGH_ALCHEMY: 5,
    LOW_ALCHEMY: 3,
    ENCHANT_LVL1: 3,
    ENCHANT_LVL2: 3,
    ENCHANT_LVL3: 3,
    ENCHANT_LVL4: 3,
    ENCHANT_LVL5: 3,
    SUPERHEAT: 3,
};

const QUANTITY_BUTTON = /^make\s+(x|\d+)$/i;

// ---------- pure helpers (exported for tests) ----------

/** Every inventory slot an item target matches, in slot order. A string matches the name exactly, else as a substring. */
export function matchInventory(inventory: readonly InventoryItem[], target: ItemTarget): InventoryItem[] {
    let hits: InventoryItem[];
    if (typeof target === 'string') {
        const exact = exactNamePattern(target);
        hits = inventory.filter(i => exact.test(i.name));
        if (hits.length === 0) {
            const lower = target.toLowerCase();
            hits = inventory.filter(i => i.name.toLowerCase().includes(lower));
        }
    } else if (target instanceof RegExp) {
        hits = inventory.filter(i => { target.lastIndex = 0; return target.test(i.name); });
    } else {
        hits = inventory.filter(i => i.id === target.id);
    }
    return [...hits].sort((a, b) => a.slot - b.slot);
}

export function describeTarget(target: ItemTarget): string {
    return typeof target === 'string' ? target : target instanceof RegExp ? String(target) : target.name;
}

/** Total count across every slot a target matches. */
export function countInventory(inventory: readonly InventoryItem[], target: ItemTarget): number {
    return matchInventory(inventory, target).reduce((n, i) => n + i.count, 0);
}

/**
 * How many sends one side of a combine can take in one tick: a stack or a kept
 * tool takes any number (the same slot each time); single unstackable items take
 * one send each, on distinct slots.
 */
export function sideCapacity(matches: readonly InventoryItem[], kept: boolean): number {
    if (matches.length === 0) return 0;
    if (kept || matches.some(i => i.count > 1)) return Infinity;
    return matches.length;
}

/** The item the i-th send of a tick uses on one side. */
export function pickForSend(matches: readonly InventoryItem[], i: number, capacity: number): InventoryItem | undefined {
    return capacity === Infinity ? matches[0] : matches[i];
}

export function totalXp(state: BotWorldState | null | undefined): number {
    return state?.skills.reduce((n, s) => n + (s.experience || 0), 0) ?? 0;
}

export function skillXp(state: BotWorldState | null | undefined, skill: string): number {
    const lower = skill.toLowerCase();
    return state?.skills.find(s => s.name.toLowerCase() === lower)?.experience ?? 0;
}

export function rejectedOps(state: BotWorldState | null | undefined): number {
    return state?.opFeedback?.opRejectedCount ?? 0;
}

export function inventoryKey(state: BotWorldState | null | undefined): string {
    return (state?.inventory ?? []).map(i => `${i.slot}:${i.id}:${i.count}`).join(',');
}

/** True while a skill dialog offering products (Make 1/5/10/X) is open. */
export function hasProductDialog(state: BotWorldState | null | undefined): boolean {
    if (!state?.dialog?.isOpen) return false;
    return state.dialog.options.some(o => QUANTITY_BUTTON.test(o.text.trim()));
}

/**
 * The button to click in a skill dialog for `amount` of `product`. These dialogs
 * publish, per product, its quantity buttons and then one button labelled with
 * the product (Make 1). The quantity buttons are the run just before the named
 * one. Amounts other than 1, 5 and 10 use Make X, which then asks for a count.
 */
export function resolveMakeButton(
    options: readonly DialogOption[],
    product: string | undefined,
    amount: number,
): { option: DialogOption; count: number | null; label: string } | null {
    const named = resolveSkillDialogProduct(options, product);
    if (!named) return null;
    const at = options.indexOf(named);
    const run: DialogOption[] = [];
    for (let j = at - 1; j >= 0 && QUANTITY_BUTTON.test(options[j]!.text.trim()); j--) run.push(options[j]!);
    const find = (re: RegExp) => run.find(o => re.test(o.text.trim()));
    const label = named.text.replace(/\\n/g, ' ').trim();
    if (amount <= 1) return { option: named, count: null, label };
    if (amount === 5) { const b = find(/^make\s+5$/i); if (b) return { option: b, count: null, label }; }
    if (amount === 10) { const b = find(/^make\s+10$/i); if (b) return { option: b, count: null, label }; }
    const x = find(/^make\s+x$/i);
    if (x) return { option: x, count: amount, label };
    // No Make X: the largest fixed amount not above the request.
    for (const [n, re] of [[10, /^make\s+10$/i], [5, /^make\s+5$/i]] as const) {
        const b = find(re);
        if (b && amount >= n) return { option: b, count: null, label };
    }
    return { option: named, count: null, label };
}

/** The spell id for a name ('high alchemy', 'HIGH_ALCHEMY', 'enchant lvl1') or a raw component id. */
export function resolveSpell(spell: number | string): { id: number; name: SpellName | null } | null {
    if (typeof spell === 'number') {
        const name = (Object.keys(Spells) as SpellName[]).find(k => Spells[k] === spell) ?? null;
        return { id: spell, name };
    }
    const key = spell.trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/^HIGH_ALCH$/, 'HIGH_ALCHEMY').replace(/^LOW_ALCH$/, 'LOW_ALCHEMY').replace(/^HIGH_LEVEL_ALCHEMY$/, 'HIGH_ALCHEMY').replace(/^LOW_LEVEL_ALCHEMY$/, 'LOW_ALCHEMY');
    if (key in Spells) return { id: Spells[key as SpellName], name: key as SpellName };
    return null;
}

// ---------- the engine ----------

interface PendingTick { report: BurstTick; xp: number; rejected: number; key: string; state: BotWorldState }

export class ProcessingActions {
    constructor(private readonly sdk: BotSDK, private readonly bot: BotActions) {}

    private state(): BotWorldState | null {
        return this.sdk.getState();
    }

    /** The next state frame with a tick after `tick`, or null if none arrives within `ticks` ticks. */
    private async frameAfter(tick: number, ticks = 10): Promise<BotWorldState | null> {
        try {
            return await this.sdk.waitForCondition(s => s.tick > tick, ticksToMs(this.sdk, ticks));
        } catch {
            return null;
        }
    }

    /** Waits until the state's tick reaches `tick` (no wait if it already has). */
    private async untilTick(tick: number): Promise<BotWorldState | null> {
        const now = this.state();
        if (now && now.tick >= tick) return now;
        try {
            return await this.sdk.waitForCondition(s => s.tick >= tick, ticksToMs(this.sdk, Math.max(5, tick - (now?.tick ?? tick) + 5)));
        } catch {
            return this.state();
        }
    }

    /** A level-up (click-to-continue) chat box blocks inventory ops: clear it, leaving shops, banks and product dialogs alone. */
    private async clearContinueDialog(state: BotWorldState): Promise<boolean> {
        if (!state.dialog?.isOpen || hasProductDialog(state)) return false;
        await this.bot.dismissBlockingUI();
        return true;
    }

    /**
     * Fires up to `perTick` sends at the start of each server tick and reads
     * their effect from the next frame. `plan` returns the sends for this tick
     * (fewer when the inventory can't take more). Falls back to one send per
     * tick for the rest of the call when a tick shows a rejected op.
     */
    async burst(opts: {
        plan: (state: BotWorldState, budget: number) => Array<() => Promise<ActionResult>>;
        times: number;
        perTick: number;
        timeoutTicks: number;
        stallTicks?: number;
        learn?: (before: BotWorldState, after: BotWorldState) => void;
        label: string;
    }): Promise<BurstResult> {
        const start = this.state();
        if (!start) return this.burstDone('No game state', [], 0, 0, 0, 0, 'timeout', false);
        if (start.bank?.isOpen || start.shop?.isOpen || start.trade?.isOpen) {
            return this.burstDone('A bank, shop or trade interface is open and hides the inventory from the server: close it first', [], 0, 0, 0, 0, 'modal_open', false);
        }
        let perTick = Math.max(1, Math.min(MAX_OPS_PER_TICK, Math.floor(opts.perTick)));
        const stallTicks = opts.stallTicks ?? 4;
        const xp0 = totalXp(start);
        const rej0 = rejectedOps(start);
        const ticks: BurstTick[] = [];
        let sent = 0, stall = 0, effective = 0, fellBack = false;
        let pending: PendingTick | null = null;
        let reason: BurstResult['reason'];
        let tick = start.tick;
        const deadline = start.tick + opts.timeoutTicks;

        for (;;) {
            const state = await this.frameAfter(tick);
            if (!state) { reason = 'timeout'; break; }
            tick = state.tick;
            if (pending) {
                pending.report.xp = totalXp(state) - pending.xp;
                pending.report.rejected = rejectedOps(state) - pending.rejected;
                const changed = pending.report.xp > 0 || inventoryKey(state) !== pending.key;
                if (changed) { effective++; opts.learn?.(pending.state, state); }
                stall = changed ? 0 : stall + 1;
                if (pending.report.rejected > 0 && perTick > 1) { perTick = 1; fellBack = true; }
                pending = null;
            }
            if (stall >= stallTicks) { reason = 'no_effect'; break; }
            if (sent >= opts.times) break;
            if (tick >= deadline) { reason = 'timeout'; break; }
            if (hasProductDialog(state)) { reason = 'dialog_opened'; break; }
            if (await this.clearContinueDialog(state)) continue;
            const sends = opts.plan(state, Math.min(perTick, opts.times - sent));
            if (sends.length === 0) { reason = 'out_of_items'; break; }
            const report: BurstTick = { tick, sent: sends.length, xp: 0, rejected: 0 };
            pending = { report, xp: totalXp(state), rejected: rejectedOps(state), key: inventoryKey(state), state };
            ticks.push(report);
            const results = await Promise.all(sends.map(send => send()));
            const failed = results.find(r => !r.success);
            sent += sends.length;
            if (failed && results.every(r => !r.success)) {
                return this.burstDone(`${opts.label}: ${failed.message}`, ticks, sent, totalXp(this.state()) - xp0, rejectedOps(this.state()) - rej0, effective, failed.reason === 'modal_open' ? 'modal_open' : 'timeout', fellBack);
            }
        }
        const end = this.state();
        const xpGained = totalXp(end) - xp0;
        const rejected = rejectedOps(end) - rej0;
        const message = `${opts.label}: ${sent} sent over ${ticks.length} ticks, ${xpGained} XP, ${rejected} rejected${reason ? ` (${reason})` : ''}`;
        return this.burstDone(message, ticks, sent, xpGained, rejected, effective, reason, fellBack);
    }

    /** Success: at least one tick showed an effect, and nothing hid the inventory. */
    private burstDone(message: string, perTick: BurstTick[], sent: number, xpGained: number, rejected: number, effectiveTicks: number, reason: BurstResult['reason'], fellBack: boolean): BurstResult {
        const success = effectiveTicks > 0 && reason !== 'modal_open';
        return { success, message, sent, ticks: perTick.length, xpGained, rejected, perTick, reason, fellBackToOnePerTick: fellBack || undefined };
    }

    // ---------- S1: item on item ----------

    async useItemOnItem(source: ItemTarget, target: ItemTarget, options: {
        times?: number; perTick?: number; keep?: 'source' | 'target' | 'both'; timeoutTicks?: number; stallTicks?: number;
    } = {}): Promise<BurstResult> {
        const times = Math.max(1, Math.floor(options.times ?? 1));
        const kept = { source: options.keep === 'source' || options.keep === 'both', target: options.keep === 'target' || options.keep === 'both' };
        const state0 = this.state();
        if (state0 && (matchInventory(state0.inventory, source).length === 0 || matchInventory(state0.inventory, target).length === 0)) {
            const missing = matchInventory(state0.inventory, source).length === 0 ? source : target;
            return { success: false, message: `useItemOnItem: no ${describeTarget(missing)} in the inventory`, sent: 0, ticks: 0, xpGained: 0, rejected: 0, perTick: [], reason: 'item_not_found' };
        }
        return this.burst({
            label: 'useItemOnItem',
            times,
            perTick: options.perTick ?? 1,
            timeoutTicks: options.timeoutTicks ?? times + 20,
            stallTicks: options.stallTicks,
            plan: (state, budget) => {
                const src = matchInventory(state.inventory, source);
                const srcSlots = new Set(src.map(i => i.slot));
                const tgt = matchInventory(state.inventory, target).filter(i => !srcSlots.has(i.slot));
                const capS = sideCapacity(src, kept.source);
                const capT = sideCapacity(tgt, kept.target);
                const n = Math.min(budget, capS, capT);
                const sends: Array<() => Promise<ActionResult>> = [];
                for (let i = 0; i < n; i++) {
                    const a = pickForSend(src, i, capS), b = pickForSend(tgt, i, capT);
                    if (!a || !b) break;
                    sends.push(() => this.sdk.sendUseItemOnItem(a.slot, b.slot));
                }
                return sends;
            },
            // A side whose count didn't fall while the combine worked is a tool (knife, chisel, needle): any number of sends.
            learn: (before, after) => {
                if (!kept.source && countInventory(after.inventory, source) >= countInventory(before.inventory, source)) kept.source = true;
                if (!kept.target && countInventory(after.inventory, target) >= countInventory(before.inventory, target)) kept.target = true;
            },
        });
    }

    // ---------- S4: an inventory option on every match ----------

    async useInventoryItems(target: ItemTarget, option: string | RegExp | number, options: {
        max?: number; perTick?: number; cooldownTicks?: number; timeoutTicks?: number;
    } = {}): Promise<BurstResult | PacedResult> {
        const opIndexOf = (item: InventoryItem): number | null => {
            if (typeof option === 'number') return option;
            const re = typeof option === 'string' ? new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : option;
            return item.optionsWithIndex?.find(o => re.test(o.text))?.opIndex ?? null;
        };
        const state0 = this.state();
        const first = state0 ? matchInventory(state0.inventory, target)[0] : undefined;
        if (!first) return { success: false, message: `No ${describeTarget(target)} in the inventory`, done: 0, sent: 0, dropped: 0, ticks: 0, xpGained: 0, cooldownTicks: 0, reason: 'item_not_found' };
        if (opIndexOf(first) === null) {
            return { success: false, message: `${first.name} has no option matching ${String(option)} (has: ${(first.optionsWithIndex ?? []).map(o => o.text).join(', ')})`, done: 0, sent: 0, dropped: 0, ticks: 0, xpGained: 0, cooldownTicks: 0, reason: 'no_option' };
        }
        const max = Math.max(1, Math.floor(options.max ?? countInventory(state0!.inventory, target)));
        if ((options.perTick ?? 1) > 1) {
            return this.burst({
                label: 'useInventoryItems',
                times: max,
                perTick: options.perTick!,
                timeoutTicks: options.timeoutTicks ?? max + 20,
                plan: (state, budget) => matchInventory(state.inventory, target).slice(0, budget).flatMap(item => {
                    const op = opIndexOf(item);
                    return op === null ? [] : [() => this.sdk.sendUseItem(item.slot, op)];
                }),
            });
        }
        return this.paced({
            label: 'useInventoryItems',
            times: max,
            cooldownTicks: options.cooldownTicks,
            timeoutTicks: options.timeoutTicks,
            next: state => {
                const item = matchInventory(state.inventory, target)[0];
                const op = item ? opIndexOf(item) : null;
                return item && op !== null ? () => this.sdk.sendUseItem(item.slot, op) : null;
            },
        });
    }

    /**
     * One send at a time, each after the last one's effect plus a cooldown. A
     * send that shows no effect (the server dropped it while the player was
     * delayed) raises the cooldown by a tick and is sent again, so repeated calls
     * settle on the action's real cadence with no drops.
     */
    async paced(opts: {
        next: (state: BotWorldState) => (() => Promise<ActionResult>) | null;
        times: number;
        cooldownTicks?: number;
        effectTicks?: number;
        timeoutTicks?: number;
        effect?: (before: BotWorldState, after: BotWorldState) => boolean;
        label: string;
    }): Promise<PacedResult> {
        const start = this.state();
        if (!start) return { success: false, message: 'No game state', done: 0, sent: 0, dropped: 0, ticks: 0, xpGained: 0, cooldownTicks: 0, reason: 'timeout' };
        if (start.bank?.isOpen || start.shop?.isOpen || start.trade?.isOpen) {
            return { success: false, message: 'A bank, shop or trade interface is open and hides the inventory from the server: close it first', done: 0, sent: 0, dropped: 0, ticks: 0, xpGained: 0, cooldownTicks: 0, reason: 'modal_open' };
        }
        const effect = opts.effect ?? ((a, b) => totalXp(b) > totalXp(a) || inventoryKey(b) !== inventoryKey(a));
        const effectTicks = opts.effectTicks ?? 3;
        const deadline = start.tick + (opts.timeoutTicks ?? opts.times * 8 + 20);
        let cooldown = Math.max(0, opts.cooldownTicks ?? 0);
        let done = 0, sent = 0, dropped = 0, misses = 0;
        let reason: PacedResult['reason'];
        let state: BotWorldState = start;

        while (done < opts.times) {
            if (state.tick >= deadline) { reason = 'timeout'; break; }
            if (hasProductDialog(state)) { reason = 'dialog_opened'; break; }
            if (await this.clearContinueDialog(state)) { state = (await this.frameAfter(state.tick)) ?? state; continue; }
            const send = opts.next(state);
            if (!send) { reason = 'out_of_items'; break; }
            const before = state;
            const result = await send();
            sent++;
            if (!result.success) { reason = result.reason === 'modal_open' ? 'modal_open' : 'timeout'; break; }
            let hit: BotWorldState | null = null;
            let t = before.tick;
            for (let k = 0; k < effectTicks + 1; k++) {
                const s = await this.frameAfter(t);
                if (!s) break;
                t = s.tick;
                state = s;
                if (effect(before, s)) { hit = s; break; }
                if (rejectedOps(s) > rejectedOps(before)) break;
            }
            if (hit) {
                done++;
                misses = 0;
                // Wait out the delay after the last one too, so the next call's first send isn't dropped.
                if (cooldown > 0) state = (await this.untilTick(hit.tick + cooldown)) ?? hit;
                continue;
            }
            // Dropped: the player was still delayed. Wait a tick longer after each effect from now on.
            dropped++;
            misses++;
            cooldown = Math.min(cooldown + 1, 8);
            if (misses >= 3) { reason = 'no_effect'; break; }
        }
        const end = this.state() ?? state;
        const xpGained = totalXp(end) - totalXp(start);
        return {
            success: done > 0 && reason !== 'no_effect' && reason !== 'timeout' && reason !== 'modal_open',
            message: `${opts.label}: ${done} done from ${sent} sends (${dropped} dropped) over ${end.tick - start.tick} ticks, ${xpGained} XP, cooldown ${cooldown}${reason ? ` (${reason})` : ''}`,
            done, sent, dropped, ticks: end.tick - start.tick, xpGained, cooldownTicks: cooldown, reason,
        };
    }

    // ---------- S2: make-X skill dialogs ----------

    private async open(opener: MakeXOpener): Promise<ActionResult> {
        if (typeof opener === 'function') {
            await opener();
            return { success: true, message: 'opened' };
        }
        if ('loc' in opener) {
            const r = await this.bot.interactLoc(opener.loc, opener.option ?? 1);
            return { success: r.success, message: r.message, reason: r.reason };
        }
        const state = this.state();
        const use = state ? matchInventory(state.inventory, opener.use)[0] : undefined;
        if (!use) return { success: false, message: `No ${describeTarget(opener.use)} in the inventory`, reason: 'item_not_found' };
        if ('onLoc' in opener) {
            const r = await this.bot.useItemOnLoc(use, opener.onLoc);
            return { success: r.success, message: r.message, reason: r.reason };
        }
        const on = state ? matchInventory(state.inventory, opener.on).filter(i => i.slot !== use.slot)[0] : undefined;
        if (!on) return { success: false, message: `No ${describeTarget(opener.on)} in the inventory`, reason: 'item_not_found' };
        return this.sdk.sendUseItemOnItem(use.slot, on.slot);
    }

    async makeX(product: string | undefined, amount: number, options: {
        open?: MakeXOpener; skill?: string; stallTicks?: number; timeoutTicks?: number; restarts?: number;
    } = {}): Promise<MakeXResult> {
        const want = Math.max(1, Math.floor(amount));
        const start = this.state();
        if (!start) return { success: false, message: 'No game state', made: 0, xpGained: 0, ticks: 0, reason: 'timeout' };
        const xpOf = (s: BotWorldState | null) => (options.skill ? skillXp(s, options.skill) : totalXp(s));
        const stallTicks = options.stallTicks ?? 8;
        const deadline = start.tick + (options.timeoutTicks ?? want * 8 + 40);
        let made = 0, restarts = 0;
        let chosen: string | undefined;
        let reason: MakeXResult['reason'];

        while (made < want) {
            let state = this.state();
            if (!state) { reason = 'timeout'; break; }
            if (!hasProductDialog(state)) {
                if (!options.open) {
                    if (made === 0) return { success: false, message: 'No make-X dialog is open and no way to open one was given', made, xpGained: 0, ticks: 0, reason: 'dialog_not_open' };
                    break;
                }
                if (state.dialog?.isOpen) await this.bot.dismissBlockingUI();
                const opened = await this.open(options.open);
                if (!opened.success) {
                    reason = made > 0 ? 'out_of_items' : (opened.reason === 'item_not_found' ? 'item_not_found' : 'dialog_not_open');
                    if (made === 0) return { success: false, message: `makeX: ${opened.message}`, made, xpGained: 0, ticks: 0, reason };
                    break;
                }
                try {
                    state = await this.sdk.waitForCondition(s => hasProductDialog(s), ticksToMs(this.sdk, 8));
                } catch {
                    reason = made > 0 ? 'out_of_items' : 'dialog_not_open';
                    if (made === 0) return { success: false, message: 'makeX: the make-X dialog did not open', made, xpGained: 0, ticks: 0, reason };
                    break;
                }
            }
            const button = resolveMakeButton(state.dialog.options, product, want - made);
            if (!button) {
                const offered = skillDialogProductLabels(state.dialog.options);
                return { success: false, message: `makeX: no product matched "${product}" (offered: ${offered.join(', ')})`, made, xpGained: xpOf(this.state()) - xpOf(start), ticks: 0, reason: 'no_product' };
            }
            chosen = button.label;
            const xpBefore = xpOf(state);
            await this.sdk.sendClickDialog(button.option.index);
            if (button.count !== null) await this.sdk.sendCountDialog(button.count);
            // Watch the grants: each tick the skill's XP rises is one product.
            let last = xpBefore, quiet = 0, tick = state.tick, grantsThisRun = 0;
            const target = button.count ?? (/make\s+(\d+)/i.exec(button.option.text)?.[1] ? Number(/make\s+(\d+)/i.exec(button.option.text)![1]) : 1);
            for (;;) {
                const s = await this.frameAfter(tick);
                if (!s) { reason = 'timeout'; break; }
                tick = s.tick;
                const xp = xpOf(s);
                if (xp > last) { made++; grantsThisRun++; last = xp; quiet = 0; } else quiet++;
                if (made >= want || grantsThisRun >= target) break;
                if (tick >= deadline) { reason = 'timeout'; break; }
                if (quiet >= stallTicks) break;
            }
            if (reason === 'timeout' || made >= want) break;
            if (grantsThisRun === 0 && restarts > 0) { reason = 'no_effect'; break; }
            if (++restarts > (options.restarts ?? 4)) { reason = 'interrupted'; break; }
        }
        const end = this.state();
        const xpGained = xpOf(end) - xpOf(start);
        return {
            success: made > 0,
            message: `makeX: ${made}/${want} ${chosen ?? product ?? ''} made, ${xpGained} XP over ${(end?.tick ?? 0) - start.tick} ticks${reason ? ` (${reason})` : ''}`,
            made, xpGained, ticks: (end?.tick ?? 0) - start.tick, product: chosen, reason,
        };
    }

    // ---------- S3: item on a loc, repeated ----------

    async useItemOnLocX(item: ItemTarget, loc: NearbyLoc | string | RegExp, amount: number, options: {
        product?: string; cooldownTicks?: number; timeoutTicks?: number;
    } = {}): Promise<PacedResult> {
        const want = Math.max(1, Math.floor(amount));
        const start = this.state();
        if (!start) return { success: false, message: 'No game state', done: 0, sent: 0, dropped: 0, ticks: 0, xpGained: 0, cooldownTicks: 0, reason: 'timeout' };
        const before = countInventory(start.inventory, item);
        if (before === 0) return { success: false, message: `No ${describeTarget(item)} in the inventory`, done: 0, sent: 0, dropped: 0, ticks: 0, xpGained: 0, cooldownTicks: 0, reason: 'item_not_found' };
        // The first use walks to the loc (doors included) and proves it takes the item.
        const first = await this.bot.useItemOnLoc(matchInventory(start.inventory, item)[0]!, loc);
        if (!first.success) return { success: false, message: `useItemOnLocX: ${first.message}`, done: 0, sent: 1, dropped: 0, ticks: 0, xpGained: 0, cooldownTicks: 0, reason: first.reason === 'cant_reach' ? 'cant_reach' : 'no_effect' };
        const afterFirst = this.state()!;
        // Some locs answer with a make-X dialog (a spinning wheel's Spin): hand over to makeX.
        if (hasProductDialog(afterFirst)) {
            const made = await this.makeX(options.product, want, {});
            return { success: made.success, message: made.message, done: made.made, sent: 1, dropped: 0, ticks: made.ticks, xpGained: made.xpGained, cooldownTicks: 0, reason: made.reason === 'no_product' ? 'no_effect' : undefined };
        }
        const locNow = typeof loc === 'object' && !(loc instanceof RegExp)
            ? (afterFirst.nearbyLocs.find(l => l.x === loc.x && l.z === loc.z && l.id === loc.id) ?? loc)
            : afterFirst.nearbyLocs.find(l => (loc instanceof RegExp ? loc.test(l.name) : exactNamePattern(loc).test(l.name)));
        if (!locNow) return { success: false, message: `useItemOnLocX: ${String(loc)} is no longer visible`, done: 1, sent: 1, dropped: 0, ticks: 0, xpGained: totalXp(afterFirst) - totalXp(start), cooldownTicks: 0, reason: 'no_effect' };
        const firstDone = countInventory(afterFirst.inventory, item) < before ? 1 : 0;
        const rest = await this.paced({
            label: 'useItemOnLocX',
            times: want - firstDone,
            cooldownTicks: options.cooldownTicks,
            timeoutTicks: options.timeoutTicks,
            effect: (a, b) => countInventory(b.inventory, item) < countInventory(a.inventory, item),
            next: state => {
                const it = matchInventory(state.inventory, item)[0];
                return it ? () => this.sdk.sendUseItemOnLoc(it.slot, locNow.x, locNow.z, locNow.id) : null;
            },
        });
        const end = this.state() ?? afterFirst;
        const done = rest.done + firstDone;
        return { ...rest, success: done > 0 && rest.reason !== 'no_effect', done, sent: rest.sent + 1, ticks: end.tick - start.tick, xpGained: totalXp(end) - totalXp(start), message: `useItemOnLocX: ${done}/${want} done, ${rest.message}` };
    }

    // ---------- S5: spells on items ----------

    async castOnItem(spell: number | string, item: ItemTarget, options: { waitOutDelay?: boolean; tries?: number; timeoutTicks?: number } = {}): Promise<CastOnItemResult> {
        const resolved = resolveSpell(spell);
        if (!resolved) return { success: false, message: `Unknown spell: ${spell}`, reason: 'unknown_spell' };
        const period = (resolved.name && SPELL_PERIOD_TICKS[resolved.name]) || 3;
        const start = this.state();
        if (!start) return { success: false, message: 'No game state', reason: 'timeout' };
        if (start.bank?.isOpen || start.shop?.isOpen) return { success: false, message: 'Close the bank or shop first: it hides the inventory from the server', reason: 'modal_open' };
        const tries = options.tries ?? 4;
        const msgFrom = start.gameMessages.length ? Math.max(...start.gameMessages.map(m => m.tick ?? 0)) : 0;
        for (let attempt = 0; attempt < tries; attempt++) {
            const s0 = this.state()!;
            const target = matchInventory(s0.inventory, item)[0];
            if (!target) return { success: false, message: `No ${describeTarget(item)} in the inventory`, reason: 'item_not_found' };
            const magic0 = skillXp(s0, 'Magic');
            const sent = await this.sdk.sendSpellOnItem(target.slot, resolved.id);
            if (!sent.success) return { success: false, message: sent.message, reason: 'timeout' };
            let tick = s0.tick;
            for (let k = 0; k < (options.timeoutTicks ?? 2); k++) {
                const s = await this.frameAfter(tick);
                if (!s) break;
                tick = s.tick;
                const gained = skillXp(s, 'Magic') - magic0;
                if (gained > 0) {
                    if (options.waitOutDelay !== false) await this.untilTick(s.tick + period - 1);
                    return { success: true, message: `Cast ${resolved.name ?? resolved.id} on ${target.name}: ${gained} Magic XP`, xpGained: gained, item: target.name, castTick: s.tick, periodTicks: period, retries: attempt };
                }
                const refusal = s.gameMessages.find(m => (m.tick ?? 0) > msgFrom && /do not have enough|don't have enough|need a magic level|level to cast|can't use|cannot be (turned|used)|coins/i.test(m.text));
                if (refusal) {
                    const text = refusal.text.toLowerCase();
                    const reason: CastOnItemResult['reason'] = text.includes('enough') ? 'no_runes' : text.includes('level') ? 'level_too_low' : 'refused';
                    return { success: false, message: refusal.text, reason };
                }
                if (rejectedOps(s) > rejectedOps(s0)) break; // dropped while delayed: send again
            }
        }
        return { success: false, message: `The cast showed no Magic XP after ${tries} tries`, reason: 'timeout' };
    }

    // ---------- S6: one bank visit per load ----------

    async depositAllExcept(keep: Array<string | RegExp>): Promise<BankLoadResult> {
        const state = this.state();
        if (!state?.bank?.isOpen) return { success: false, message: 'Bank is not open', deposited: [], withdrawn: [], missing: [], reason: 'bank_not_open' };
        const keeps = keep.map(k => (typeof k === 'string' ? exactNamePattern(k) : k));
        const kept = (name: string) => keeps.some(re => { re.lastIndex = 0; return re.test(name); });
        const ids = [...new Map(state.inventory.filter(i => !kept(i.name)).map(i => [i.id, i])).values()];
        const deposited: string[] = [];
        for (const item of ids) {
            const now = this.state()?.inventory.find(i => i.id === item.id);
            if (!now) continue;
            const r = await this.bot.depositItem(now, -1);
            if (!r.success) return { success: false, message: `Depositing ${item.name}: ${r.message}`, deposited, withdrawn: [], missing: [], reason: 'deposit_failed' };
            deposited.push(item.name);
        }
        const left = (this.state()?.inventory ?? []).filter(i => !kept(i.name));
        if (left.length) return { success: false, message: `Still carrying ${left.map(i => i.name).join(', ')}`, deposited, withdrawn: [], missing: [], reason: 'deposit_failed' };
        return { success: true, message: `Deposited ${deposited.length ? deposited.join(', ') : 'nothing'}`, deposited, withdrawn: [], missing: [] };
    }

    async withdrawMany(requests: WithdrawRequest[]): Promise<BankLoadResult> {
        const state = this.state();
        if (!state?.bank?.isOpen) return { success: false, message: 'Bank is not open', deposited: [], withdrawn: [], missing: [], reason: 'bank_not_open' };
        const withdrawn: Array<{ item: string; amount: number }> = [];
        const missing: string[] = [];
        for (const req of requests) {
            const pattern = typeof req.item === 'string' ? exactNamePattern(req.item) : req.item;
            const inBank = this.state()?.bank.items.find(i => { pattern.lastIndex = 0; return pattern.test(i.name); });
            if (!inBank) { missing.push(String(req.item)); continue; }
            const before = countInventory(this.state()!.inventory, pattern);
            const r = await this.bot.withdrawItem(inBank, req.amount, { asNote: req.asNote });
            const got = countInventory(this.state()!.inventory, req.asNote ? new RegExp(pattern.source, pattern.flags) : pattern) - before;
            if (!r.success && got <= 0) { missing.push(String(req.item)); continue; }
            withdrawn.push({ item: inBank.name, amount: Math.max(got, 0) });
        }
        const ok = missing.length === 0;
        return {
            success: ok,
            message: ok ? `Withdrew ${withdrawn.map(w => `${w.amount} ${w.item}`).join(', ')}` : `Missing from the bank: ${missing.join(', ')}`,
            deposited: [], withdrawn, missing, reason: ok ? undefined : 'missing',
        };
    }

    // ---------- S7: obstacles ----------

    async crossObstacle(loc: NearbyLoc | string | RegExp, option: string | RegExp | number = 1, expect: { to?: { x: number; z: number }; xp?: boolean; timeoutTicks?: number } = {}): Promise<CrossObstacleResult> {
        const start = this.state();
        if (!start?.player) return { success: false, message: 'No game state', xpGained: 0, reason: 'timeout' };
        const agility0 = skillXp(start, 'Agility');
        const hp0 = start.skills.find(s => s.name === 'Hitpoints')?.level ?? 0;
        const r = await this.bot.interactLoc(loc, option);
        if (!r.success) return { success: false, message: r.message, xpGained: 0, reason: r.reason === 'cant_reach' ? 'cant_reach' : 'loc_not_found' };
        const arrived = (s: BotWorldState) => !expect.to || (s.player != null && Math.abs(s.player.worldX - expect.to.x) <= 1 && Math.abs(s.player.worldZ - expect.to.z) <= 1);
        const gotXp = (s: BotWorldState) => skillXp(s, 'Agility') > agility0;
        const wantXp = expect.xp ?? !expect.to;
        try {
            const s = await this.sdk.waitForCondition(s => arrived(s) && (!wantXp || gotXp(s)), ticksToMs(this.sdk, expect.timeoutTicks ?? 30));
            return { success: true, message: 'Crossed', xpGained: skillXp(s, 'Agility') - agility0, position: s.player ? { x: s.player.worldX, z: s.player.worldZ } : undefined };
        } catch {
            const s = this.state()!;
            const hp = s.skills.find(k => k.name === 'Hitpoints')?.level ?? hp0;
            const failed = hp < hp0 || (gotXp(s) === false && !arrived(s));
            return { success: false, message: failed ? 'The obstacle was failed or not crossed' : 'Timed out', xpGained: skillXp(s, 'Agility') - agility0, position: s.player ? { x: s.player.worldX, z: s.player.worldZ } : undefined, reason: failed ? 'failed' : 'timeout' };
        }
    }

    // ---------- S8: runecrafting ----------

    async enterRuins(talisman: ItemTarget = /talisman$/i, options: { ruins?: NearbyLoc | string | RegExp; timeoutTicks?: number } = {}): Promise<EnterRuinsResult> {
        const start = this.state();
        if (!start?.player) return { success: false, message: 'No game state', reason: 'timeout' };
        const ruins = options.ruins ?? /mysterious ruins/i;
        const from = { x: start.player.worldX, z: start.player.worldZ };
        const held = matchInventory(start.inventory, talisman)[0];
        const r = held
            ? await this.bot.useItemOnLoc(held, ruins)
            : await this.bot.interactLoc(ruins, /enter/i);
        if (!r.success) return { success: false, message: r.message, reason: held ? (r.reason === 'cant_reach' ? 'cant_reach' : 'no_effect') : 'no_talisman' };
        try {
            const s = await this.sdk.waitForCondition(s => s.player != null && Math.max(Math.abs(s.player.worldX - from.x), Math.abs(s.player.worldZ - from.z)) > 30, ticksToMs(this.sdk, options.timeoutTicks ?? 15));
            return { success: true, message: 'Entered the ruins', position: { x: s.player!.worldX, z: s.player!.worldZ } };
        } catch {
            return { success: false, message: 'Did not arrive inside the ruins', reason: 'timeout' };
        }
    }

    async craftRunes(options: { altar?: NearbyLoc | string | RegExp; essence?: ItemTarget; timeoutTicks?: number } = {}): Promise<CraftRunesResult> {
        const start = this.state();
        if (!start) return { success: false, message: 'No game state', xpGained: 0, essenceUsed: 0, reason: 'timeout' };
        const essence = options.essence ?? /essence$/i;
        const ess0 = countInventory(start.inventory, essence);
        if (ess0 === 0) return { success: false, message: 'No essence in the inventory', xpGained: 0, essenceUsed: 0, reason: 'no_essence' };
        const rc0 = skillXp(start, 'Runecraft');
        const r = await this.bot.interactLoc(options.altar ?? /^altar$/i, /craft/i);
        if (!r.success) return { success: false, message: r.message, xpGained: 0, essenceUsed: 0, reason: r.reason === 'cant_reach' ? 'cant_reach' : 'altar_not_found' };
        try {
            const s = await this.sdk.waitForCondition(s => skillXp(s, 'Runecraft') > rc0 && countInventory(s.inventory, essence) < ess0, ticksToMs(this.sdk, options.timeoutTicks ?? 15));
            return { success: true, message: 'Crafted runes', xpGained: skillXp(s, 'Runecraft') - rc0, essenceUsed: ess0 - countInventory(s.inventory, essence) };
        } catch {
            const s = this.state()!;
            const msg = s.gameMessages.find(m => /level|can't|cannot/i.test(m.text));
            return { success: false, message: msg?.text ?? 'No Runecraft XP', xpGained: 0, essenceUsed: 0, reason: msg && /level/i.test(msg.text) ? 'level_too_low' : 'timeout' };
        }
    }
}
