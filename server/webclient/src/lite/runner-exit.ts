// Exit codes for runner.ts, kept apart so they can be tested without starting a session.
//
//   0  stopped (SIGINT)
//   1  the session died, or any other error
//   3  the server runs another game revision; restarting won't help
//   6  logged out as requested (the logout button, e.g. bot.logout())
//   7  login refused; the line `login_response=<code>` names the server's code

import { LoginError, OutdatedClientError } from './net/GameConnection.js';
import type { SessionEnd } from './session.js';

export const EXIT_STOPPED = 0;
export const EXIT_ERROR = 1;
export const EXIT_OUTDATED = 3;
export const EXIT_LOGGED_OUT = 6;
export const EXIT_LOGIN_REFUSED = 7;

/** The logout tab's button, `logout:try_logout`; bot.logout() clicks it. */
export const LOGOUT_BUTTON_COMPONENT = 2458;
/** A session that ends this many ticks after a logout click ended because of it. */
export const REQUESTED_LOGOUT_TICKS = 100;

/** How a failed login exits, or null to rethrow (exit 1). Prints the code line for a server refusal. */
export function loginFailureExit(err: unknown, log: (line: string) => void = console.log): number | null {
    // A revision mismatch won't fix itself: exit 3 so a supervisor can stop restarting us
    if (err instanceof OutdatedClientError) {
        return EXIT_OUTDATED;
    }
    // The server answered with a refusal code (already logged in, offline, bad password, ...).
    // Whether and when to retry depends on the code, so report it and leave that to the caller.
    // Negative codes are the client's own checks (name or password length), not the server's.
    if (err instanceof LoginError && err.code >= 0) {
        log(`login_response=${err.code}`);
        return EXIT_LOGIN_REFUSED;
    }
    return null;
}

/**
 * How a game session that ended exits. The server closes the socket right after
 * LOGOUT, so a requested logout can also surface as 'disconnected' if the close
 * is seen before the packet.
 */
export function sessionEndExit(end: SessionEnd, loggedOutOnRequest: boolean): number {
    if (end.reason === 'stopped') return EXIT_STOPPED;
    if ((end.reason === 'logged-out' || end.reason === 'disconnected') && loggedOutOnRequest) return EXIT_LOGGED_OUT;
    return EXIT_ERROR;
}
