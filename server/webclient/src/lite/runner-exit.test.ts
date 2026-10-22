import { describe, expect, test } from 'bun:test';

import { LoginError, OutdatedClientError } from './net/GameConnection.js';
import { EXIT_ERROR, EXIT_LOGGED_OUT, EXIT_LOGIN_REFUSED, EXIT_OUTDATED, EXIT_STOPPED, loginFailureExit, sessionEndExit } from './runner-exit.js';

describe('runner exit codes', () => {
    test('a server login refusal exits 7 and prints its code', () => {
        const lines: string[] = [];
        expect(loginFailureExit(new LoginError(5, 'Account already logged in'), l => lines.push(l))).toBe(EXIT_LOGIN_REFUSED);
        expect(lines).toEqual(['login_response=5']);
        expect(EXIT_LOGIN_REFUSED).toBe(7);
    });

    test('a revision mismatch still exits 3, with no code line', () => {
        const lines: string[] = [];
        expect(loginFailureExit(new OutdatedClientError('http://localhost', 999), l => lines.push(l))).toBe(EXIT_OUTDATED);
        expect(EXIT_OUTDATED).toBe(3);
        expect(lines).toEqual([]);
    });

    test("the client's own checks and other errors rethrow (exit 1)", () => {
        expect(loginFailureExit(new LoginError(-1, 'Username must be 1-12 characters'), () => {})).toBeNull();
        expect(loginFailureExit(new Error('ECONNREFUSED'), () => {})).toBeNull();
    });

    test('a session that ends after a logout click exits 6', () => {
        expect(sessionEndExit({ reason: 'logged-out' }, true)).toBe(EXIT_LOGGED_OUT);
        expect(sessionEndExit({ reason: 'disconnected' }, true)).toBe(EXIT_LOGGED_OUT);
        expect(EXIT_LOGGED_OUT).toBe(6);
    });

    test('every other ending is unchanged', () => {
        expect(sessionEndExit({ reason: 'stopped' }, false)).toBe(EXIT_STOPPED);
        expect(sessionEndExit({ reason: 'stopped' }, true)).toBe(EXIT_STOPPED);
        expect(sessionEndExit({ reason: 'logged-out' }, false)).toBe(EXIT_ERROR);
        expect(sessionEndExit({ reason: 'disconnected' }, false)).toBe(EXIT_ERROR);
        expect(sessionEndExit({ reason: 'idle' }, true)).toBe(EXIT_ERROR);
        expect(sessionEndExit({ reason: 'error', error: new Error('x') }, true)).toBe(EXIT_ERROR);
    });
});
