import { describe, expect, test } from 'bun:test';
import { findLongPath, TemporaryOpenLocs, type OpenLocInfo } from '../pathfinding';

// The Deserted Keep's web (bigweb_slashable, 3158, 3951): the only way out of the keep's lever room. The bundled
// collision map keeps it as a solid loc even when it has been cut.
const web: OpenLocInfo = { level: 0, x: 3158, z: 3951, width: 1, length: 1 };
const inside = { x: 3158, z: 3950 };
const outside = { x: 3158, z: 3953 };

const reaches = (path: Array<{ x: number; z: number }>, to: { x: number; z: number }) => {
    const last = path[path.length - 1];
    return !!last && last.x === to.x && last.z === to.z;
};

describe('TemporaryOpenLocs', () => {
    test('expires: a cut web grows back', () => {
        let now = 1_000;
        const open = new TemporaryOpenLocs(() => now);
        open.open(web, 500);
        expect(open.active()).toEqual([web]);
        expect(open.has(0, 3158, 3951)).toBeTrue();
        now = 1_500;
        expect(open.active()).toEqual([]);
        expect(open.has(0, 3158, 3951)).toBeFalse();
    });

    test('is isolated per SDK session', () => {
        const first = new TemporaryOpenLocs(() => 0);
        const second = new TemporaryOpenLocs(() => 0);
        first.open(web);
        expect(first.active()).toEqual([web]);
        expect(second.active()).toEqual([]);
    });
});

describe('findLongPath with open locs', () => {
    test('the keep web blocks the path until the session marks it open; the shared map is restored after', () => {
        expect(reaches(findLongPath(0, inside.x, inside.z, outside.x, outside.z), outside)).toBeFalse();
        expect(reaches(findLongPath(0, inside.x, inside.z, outside.x, outside.z, 500, [], [web]), outside)).toBeTrue();
        // Another session (no open list) still sees the web: the lift lasted only for that query.
        expect(reaches(findLongPath(0, inside.x, inside.z, outside.x, outside.z), outside)).toBeFalse();
    });
});
