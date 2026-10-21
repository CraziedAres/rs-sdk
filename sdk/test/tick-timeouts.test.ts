import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';
import { REFERENCE_TICK_MS, TickClock } from '../tick-clock';

function clockAt(msPerTick: number, ticks = 20): TickClock {
    const clock = new TickClock();
    for (let t = 0; t <= ticks; t++) clock.observe(1000 + t, 50_000 + t * msPerTick);
    return clock;
}

describe('TickClock', () => {
    test('uses the reference tick until enough ticks are seen', () => {
        const clock = new TickClock();
        expect(clock.msPerTick()).toBeNull();
        expect(clock.toMs(1200)).toBe(1200 * REFERENCE_TICK_MS);
        clock.observe(1, 0);
        clock.observe(2, 300);
        expect(clock.msPerTick()).toBeNull();
    });

    test('keeps the old ms budgets at a 100 ms tick and scales them at 300 ms', () => {
        expect(clockAt(100).toMs(1200)).toBe(120_000);
        expect(clockAt(300).toMs(1200)).toBe(360_000);
        expect(clockAt(300).msPerTick()).toBe(300);
    });

    test('never waits less than at the reference tick', () => {
        expect(clockAt(50).toMs(100)).toBe(10_000);
    });

    test('measures across skipped ticks and ignores repeats', () => {
        const clock = new TickClock();
        clock.observe(10, 0);
        clock.observe(10, 50);
        clock.observe(16, 1800);
        clock.observe(22, 3600);
        expect(clock.msPerTick()).toBe(300);
    });

    test('starts over when the tick goes backwards (server restart)', () => {
        const clock = clockAt(100);
        clock.observe(3, 0);
        expect(clock.msPerTick()).toBeNull();
    });
});

describe('BotSDK tick measurement', () => {
    test('measures the tick from incoming state messages', () => {
        const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
        const handle = (sdk as any).handleMessage.bind(sdk);
        for (let t = 0; t <= 10; t++) {
            handle(JSON.stringify({ type: 'sdk_state', state: { tick: 500 + t, skills: [] }, stateReceivedAt: 10_000 + t * 300 }));
        }
        expect(sdk.getTickMs()).toBe(300);
        expect(sdk.ticksToMs(100)).toBe(30_000);
    });
});

describe('walkTo timeout', () => {
    function stuckWalker(ticksToMs: (ticks: number) => number) {
        const sdk = Object.create(BotSDK.prototype) as BotSDK;
        (sdk as any).getState = () => ({
            tick: 0,
            player: { worldX: 3200, worldZ: 3200, x: 3200, z: 3200, level: 0, animId: -1 },
            dialog: { isOpen: false, options: [] }, interface: { isOpen: false },
            shop: { isOpen: false }, bank: { isOpen: false },
            nearbyLocs: [], gameMessages: [], inventory: [],
        });
        (sdk as any).ticksToMs = ticksToMs;
        (sdk as any).sendFindPath = () => new Promise(() => {}); // never answers
        return new BotActions(sdk);
    }

    test('defaults to a budget in game ticks', async () => {
        const asked: number[] = [];
        const bot = stuckWalker(ticks => { asked.push(ticks); return 20; });
        const result = await bot.walkTo(3300, 3300);
        expect(asked).toContain(1200);
        expect(result).toMatchObject({ success: false, reason: 'timeout' });
        expect(result.message).toContain('20ms');
    });

    test('takes timeoutTicks, and an explicit ms timeout as given', async () => {
        const asked: number[] = [];
        const bot = stuckWalker(ticks => { asked.push(ticks); return ticks; });
        expect((await bot.walkTo(3300, 3300, 3, { timeoutTicks: 30 })).message).toContain('30ms');
        expect((await bot.walkTo(3300, 3300, 3, { timeout: 25 })).message).toContain('25ms');
        expect(asked).toEqual([30]);
    });
});
