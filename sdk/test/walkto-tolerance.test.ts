/**
 * walkTo must honor a caller tolerance below 2 on the final waypoint, and
 * judge tolerance in tiles (Chebyshev), not Euclidean distance.
 * Bug-report harvest 2026-09-21 (openGE/openBank/staircase "Stuck at" family).
 */
import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';

function makeBot(start: { x: number; z: number }) {
    const sdk = new BotSDK({ botUsername: 'test' });
    let pos = { ...start };
    const state = () => ({
        player: { worldX: pos.x, worldZ: pos.z, x: pos.x, z: pos.z, level: 0, lifeId: 1, isDead: false },
        tick: 1, gameMessages: [], nearbyLocs: [], nearbyNpcs: [], inventory: [],
        dialog: { isOpen: false, options: [], isWaiting: false }, interface: { isOpen: false },
    });
    (sdk as any).getState = state;
    const bot = new BotActions(sdk);
    (bot as any).dismissBlockingUI = async () => {};
    const steps: number[] = [];
    (bot as any).helpers.walkStepToward = async (tx: number, tz: number, tolerance: number) => {
        steps.push(tolerance);
        // The stepper stops as soon as it is within its tolerance, like the real one.
        while (Math.max(Math.abs(tx - pos.x), Math.abs(tz - pos.z)) > tolerance) pos = { x: pos.x + Math.sign(tx - pos.x), z: pos.z + Math.sign(tz - pos.z) };
        return { status: 'arrived' as const, pos: { ...pos } };
    };
    return { sdk, bot, steps, pos: () => pos };
}

describe('walkTo tolerance', () => {
    test('tolerance 0 reaches the exact tile', async () => {
        const { sdk, bot, steps, pos } = makeBot({ x: 3200, z: 3200 });
        // Turn points more than one segment apart (16 tiles), so the first is walked on its own.
        (sdk as any).sendFindPath = async () => ({ success: true, reachedDestination: true, waypoints: [{ x: 3220, z: 3200 }, { x: 3240, z: 3200 }] });
        const r = await bot.walkTo(3240, 3200, 0);
        expect(r.success).toBe(true);
        expect(pos()).toEqual({ x: 3240, z: 3200 });
        // An intermediate waypoint is passed from 3 tiles out (the next click goes while moving); the final one uses the caller's 0.
        expect(steps).toEqual([3, 0]);
    });

    test('turn points within one segment are walked as one click', async () => {
        const { sdk, bot, steps, pos } = makeBot({ x: 3200, z: 3200 });
        const clicks: { x: number; z: number }[] = [];
        const step = (bot as any).helpers.walkStepToward;
        (bot as any).helpers.walkStepToward = async (tx: number, tz: number, tolerance: number, last: { x: number; z: number }) => { clicks.push({ x: tx, z: tz }); return step(tx, tz, tolerance, last); };
        (sdk as any).sendFindPath = async () => ({ success: true, reachedDestination: true, waypoints: [{ x: 3203, z: 3200 }, { x: 3206, z: 3203 }, { x: 3210, z: 3203 }, { x: 3230, z: 3203 }] });
        const r = await bot.walkTo(3230, 3203, 0);
        expect(r.success).toBe(true);
        expect(pos()).toEqual({ x: 3230, z: 3203 });
        // The first three are within 16 tiles of the start: one click to the third, then the last.
        expect(clicks).toEqual([{ x: 3210, z: 3203 }, { x: 3230, z: 3203 }]);
        expect(steps).toEqual([3, 0]);
    });

    test('tolerance 1 accepts a diagonally adjacent tile', async () => {
        const { sdk, bot } = makeBot({ x: 3201, z: 3201 });
        (sdk as any).sendFindPath = async () => { throw new Error('should not path: already within 1 tile (diagonal)'); };
        const r = await bot.walkTo(3200, 3200, 1);
        expect(r.success).toBe(true);
        expect(r.message).toBe('Already at destination');
    });
});
