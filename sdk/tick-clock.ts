// Server tick length, measured from the tick numbers on incoming state.
//
// Action timeouts are game time, not wall time: a 10 s wait is 100 ticks on a
// 100 ms server but only 33 on a 300 ms one, so the same action that works
// locally times out on a slower server. BotActions budgets its waits in ticks
// and converts them here.

/**
 * The tick the SDK's tick budgets were sized against. A budget of N ticks never
 * waits less than N x this many ms, so behaviour at this tick (or faster) is the
 * same as the old fixed-ms timeouts.
 */
export const REFERENCE_TICK_MS = 100;

const WINDOW = 50;          // samples kept (about one per tick)
const MIN_SPAN_TICKS = 5;   // ticks needed before trusting a measurement

export class TickClock {
    private samples: Array<{ tick: number; at: number }> = [];

    /** Record a state's tick. A tick that goes backwards (server restart) starts over. */
    observe(tick: number, at: number = Date.now()): void {
        if (!Number.isFinite(tick)) return;
        const last = this.samples[this.samples.length - 1];
        if (last) {
            if (tick === last.tick) return;
            if (tick < last.tick) this.samples = [];
        }
        this.samples.push({ tick, at });
        if (this.samples.length > WINDOW) this.samples.shift();
    }

    /** Measured ms per tick over the recent window, or null until enough ticks are seen. */
    msPerTick(): number | null {
        if (this.samples.length < 2) return null;
        const first = this.samples[0]!;
        const last = this.samples[this.samples.length - 1]!;
        const ticks = last.tick - first.tick;
        if (ticks < MIN_SPAN_TICKS) return null;
        return (last.at - first.at) / ticks;
    }

    /** Wall-clock ms for `ticks` game ticks; never less than at REFERENCE_TICK_MS. */
    toMs(ticks: number): number {
        const measured = this.msPerTick() ?? REFERENCE_TICK_MS;
        return Math.ceil(ticks * Math.max(REFERENCE_TICK_MS, measured));
    }
}

/**
 * `sdk.ticksToMs(ticks)`, or the reference-tick budget for an SDK stand-in
 * (tests, wrappers) that has no tick clock.
 */
export function ticksToMs(sdk: { ticksToMs?: (ticks: number) => number }, ticks: number): number {
    return typeof sdk.ticksToMs === 'function' ? sdk.ticksToMs(ticks) : ticks * REFERENCE_TICK_MS;
}
