import { localStore, sessionStore } from '../utils/storage';
import { io, type Socket } from 'socket.io-client';
import { buildDeviceStatsPayload, noUndoableTurn } from '../utils/coreGameEngine';
import i18n from '../i18n';
import { ONLINE_SESSION_KEY } from '../utils/reconnectSession';
import { formatInt } from '../utils/formatNumber';
import { areInitialCardsEqual, normalizeRoomId, DEFAULT_RECONNECT_TIMEOUT } from '../utils/configValidation';
import { MS_PER_SECOND } from '../utils/time';
import { validateOnlineConfig } from './persistence';
import { getSocket, setSocket } from './socketRef';
import { REACTION_DISPLAY_MS } from '../utils/reactions';
import { roomPhase } from '../utils/roomPhase';
import { SYNCED_GAME_STATE_KEYS } from '../types';
import type {
  Reaction, CardType, DiceSnapshot, AssertNever, SyncedGameStateKey, DrawCardAck, PushStateAck,
  StatsSubmitAck, StatsRefusalReason, DeviceStatsPayload, GlobalStatsPayload,
} from '../types';
import type { GameStore, JoinRoomResponse, ConfigKeys, ImmerStateCreator } from './storeTypes';
import { finishedGameSnapshotOf, makeToast } from './gameSlice';
import { clearTurnCaches } from '../utils/diceTurnState';
import { joinErrorMessage } from '../utils/joinErrors';
import {
  DRAW_CARD_ACK_TIMEOUT_MS,
  JOIN_TIMEOUT_MS, PUSH_REJOIN_RACE_WINDOW_MS, PUSH_REJOIN_RETRY_DELAY_MS, CANCEL_RECONNECT_FAILSAFE_MS,
  STATS_SUBMIT_ACK_TIMEOUT_MS, STATS_SUBMIT_RETRY_BASE_MS,
} from '../utils/uiTimings';

type SocketSlice = Pick<GameStore,
  | 'connectSocket' | 'joinRoom' | 'leaveRoom' | 'kickPlayer'
  | 'cancelReconnect' | 'pushState' | 'pushLiveTurnState' | 'requestServerDraw' | 'sendOnlineStats'
>;

// Fields the server's 'gameState' broadcast is allowed to overwrite on the
// client store — the canonical SYNCED_GAME_STATE_KEYS (src/types.ts), which
// server/roomTypes.ts locks against RoomState, the authoritative game state
// the server actually spreads into that payload. Without this allowlist,
// Object.assign(prev, serverState) would apply every key a (compromised or
// buggy) server sends, including store action functions like
// startGame/sendOnlineStats, since serverState is typed as Partial<GameStore>.
// The satisfies is the lock's client half: every synced key is a real store field.
export const GAME_STATE_SYNC_KEYS = SYNCED_GAME_STATE_KEYS satisfies readonly (keyof GameStore)[];

// Shared by every path that abandons the current online room (leaveRoom, the
// 'kicked' handler, cancelReconnect, and useGameStore's reset) so these
// 30 room-identity/game fields can't drift out of sync between them the
// way they were previously duplicated as separate hand-written literals.
export const clearRoomState = (): Pick<GameStore,
  | 'players' | 'currentPlayerIndex' | 'currentCard' | 'cards' | 'round' | 'finished'
  | 'status' | 'roomId' | 'isHost' | 'hostId' | 'myName' | 'liveTurnState'
  | 'turnTimeRemaining' | 'turnDeadline'
  | 'chartValues' | 'chartNames' | 'chartLabels' | 'historyLog'
  | 'previousCard' | 'previousScore' | 'previousLeaders' | 'previousWasBust'
  | 'previousWasSuccess' | 'previousHighestTurnScore'
  | 'previousHighestFeuerwerkTurnScore' | 'previousHighestX2TurnScore'
  | 'previousPlayerName' | 'previousTurnSummary' | 'finishedGameSnapshot'
  | 'lastAppliedStateVersion' | 'gameTimeInSeconds' | 'showReconnectPopup' | 'reactions'
  | 'roomStateSynced' | 'justReconnected' | 'preGameStats' | 'gameStartTime'
> => ({
  players: [],
  currentPlayerIndex: null,
  currentCard: null,
  cards: [],
  round: 1,
  finished: false,
  status: 'lobby',
  roomId: null,
  isHost: false,
  hostId: null,
  myName: null,
  liveTurnState: null,
  // Only online rooms have a turn timer, and stopOnlineTimers clears the
  // interval without clearing the value it was counting down — Scoreboard
  // renders its tile from this alone, so an abandoned room's countdown sat
  // frozen inside a local game.
  turnTimeRemaining: null,
  // Client-derived, like turnTimeRemaining above — an abandoned room's
  // deadline must not survive into the next local/online game either.
  turnDeadline: null,
  // The rest of the abandoned game, not just who was at the table. These are
  // per-game, so leaving them behind is the same bleed the roster used to
  // cause: setMode('local') only overwrites the keys a saved local game
  // happens to contain, so with no save (or one predating a key) the online
  // room's chart series and activity log survive into local mode — and the
  // local persistence subscriber then writes them to disk. The undo block is
  // the sharp one: Game.tsx's hasUndoableTurn reads previousCard/
  // previousPlayerName, so a live Undo button was offered for a turn played
  // in a room this client had already left.
  chartValues: [],
  chartNames: [],
  chartLabels: [],
  historyLog: [],
  // The finished game goes with the room it was played in.
  finishedGameSnapshot: null,
  // Versions are per-room and start over at zero in a freshly created room, so
  // a floor carried out of the room just left would make the next room's whole
  // opening sequence look stale and be ignored.
  lastAppliedStateVersion: null,
  // startGame resets this to 0 before anything can read it again while a game
  // is running, but an abandoned room is not restarted — it is simply left.
  // Formerly kept (see FieldKeptOnLeave's history), on the theory that "no
  // turn yet" never reads it: true for startGame's own path, but
  // setMode('local') also restores an ALREADY-in-progress saved local game
  // directly into `status: 'playing'`, with no startGame in between. A save
  // predating this key (or one whose value failed isNonNegativeNumber) left
  // whatever the abandoned online room's elapsed time was sitting here, which
  // the local persistence subscriber then wrote to disk on the very next
  // set(), and reanchorLocalClock used to re-anchor the resumed local game's
  // clock from the online room's elapsed time instead of the save's own.
  gameTimeInSeconds: 0,
  // Client-only UI state, not one of the synced game-state fields above: the
  // full-screen "Connection Lost" modal a drop raises. It is normally lowered
  // by the next 'gameState' broadcast (see registerSocketHandlers), but
  // surrenderSeat (kicked/seatTakenOver) and the 'no-room' push refusal both
  // abandon the room and flip to local mode without ever receiving one — left
  // set, it rendered as a non-dismissible full-screen modal over local Home.
  showReconnectPopup: false,
  // A reaction from the room just left would otherwise float over the local
  // game (or the join form) that replaced it for the rest of its
  // REACTION_DISPLAY_MS — the handler that pushes them is itself guarded by
  // inRoom, but an already-received one is not retroactively undone. Not
  // `toasts`: surrenderSeat toasts the kick/takeover message before calling
  // this, on purpose.
  reactions: [],
  // Four client-only, room-scoped fields — never part of the server's synced
  // gameState (SYNCED_GAME_STATE_KEYS), so leaving them out of this object was
  // invisible rather than harmless: joinRoom sets roomStateSynced false itself
  // before the first sync, the Game mount effect refetches preGameStats, the
  // gameState handler re-derives justReconnected, and startGame/the local
  // clock re-anchor overwrite gameStartTime — every reachable path happened to
  // write over the leftover before anything read it. EndScreen's lone
  // `leaveRoom` alone (no follow-up setMode('local')) is the one caller that
  // does not immediately overwrite these, and it stays online, so it is
  // unaffected either way.
  roomStateSynced: false,
  justReconnected: false,
  preGameStats: null,
  gameStartTime: null,
  ...noUndoableTurn(),
});

// The other half of clearRoomState's contract, enforced at compile time:
// every synced game-state field must either be cleared above or be named here
// as deliberately surviving a leave. A new field filed in neither refuses to
// build instead of silently bleeding from an abandoned room into local play.
type FieldKeptOnLeave =
  // Room config: the next lobby deliberately reopens with the same settings.
  | 'initialCards' | 'winningScore' | 'randomOrder' | 'turnDuration'
  | 'reconnectTimeout' | 'ruleset'
  // Every read is gated on isOnline (Game.tsx's effectiveDiceMode, the online
  // lobbies), so a value left behind is inert until the next room's first
  // sync replaces it.
  | 'enforcedDiceMode';

// Exported only so noUnusedLocals sees a use; nothing imports it. Each tuple
// element must be `never`, or the build fails naming the offending key.
export type ClearRoomStateLock = [
  // Every synced field is either cleared or deliberately kept.
  AssertNever<Exclude<SyncedGameStateKey, keyof ReturnType<typeof clearRoomState> | FieldKeptOnLeave>>,
  // No field is both kept and cleared.
  AssertNever<Extract<keyof ReturnType<typeof clearRoomState>, FieldKeptOnLeave>>,
  // The kept list holds only real synced fields (typo guard).
  AssertNever<Exclude<FieldKeptOnLeave, SyncedGameStateKey>>,
];

// Tracks the in-flight cancelReconnect attempt (if any) so a second rapid
// call cancels the first's throwaway socket instead of leaving it dangling
// alongside a new one.
let pendingCancelReconnectCleanup: (() => void) | null = null;

/**
 * How old an emit parked for the rejoin (see parkedPush and the stats parks
 * below) may be when that rejoin finally acks. Past it the park is dropped
 * unsent.
 *
 * Nothing else bounds the wait: socket.io-client retries forever, so a tab
 * suspended mid-turn can reconnect an hour later and flush a full-state
 * snapshot into a room that has long since moved on — or, since Play Again
 * resets the server's per-game stats dedup, get the finished game's stats
 * recorded against the NEXT one. A room only holds a disconnected seat for its
 * own kick timer, so past the DEFAULT one the rejoin doing the flushing is far
 * more likely to be a fresh seat than the one the emit was made for. Written
 * as that expression rather than a number so the two cannot drift apart.
 *
 * It NARROWS that window; it does not close it. Everything above is still
 * reachable inside the bound: the host drops, another player is promoted and
 * starts a new game, and the original host rejoins forty seconds later with a
 * park the server happily records against the game now running. Widening the
 * fix would mean carrying a game identity on the emit and having the server
 * check it, which is a protocol change; this is the cheap half of it, and the
 * remaining exposure is one kick-timer's worth rather than unbounded.
 *
 * flushParkedPush and flushParkedStats also evaluate the bound independently,
 * against their own park stamps, so the two halves of one finished game can
 * disagree: a push parked a little earlier expires while the stats parked
 * moments later do not. The stats then arrive at a server that never saw
 * finished=true and are refused 'not-finished' — terminal (see
 * isRetryableStatsRefusal), so nothing resends them and the row is lost. The
 * ordering in the rejoin handler is what keeps the common case safe; it
 * cannot help once one of the two has aged out.
 */
export const PARKED_EMIT_MAX_AGE_MS = DEFAULT_RECONNECT_TIMEOUT * MS_PER_SECOND;

/**
 * An emit held for the rejoin, with the moment it was parked.
 *
 * The stamp rides with the payload rather than being taken at flush time so a
 * park that has to be re-parked — the transport dropped again before the flush
 * could send it — keeps accruing age instead of starting over.
 */
interface ParkedEmit<T> {
  payload: T;
  parkedAt: number;
}

/** The exact bytes pushState puts on the wire — see the action at the bottom. */
interface PushStatePayload {
  roomId: string | null;
  newState: Record<SyncedGameStateKey, unknown>;
}

/**
 * The one push that could not be sent, held until this client's rejoin lands.
 *
 * socket.io-client would happily buffer the emit itself — and that is the bug.
 * Its Socket#onconnect flushes the send buffer BEFORE it fires 'connect', so a
 * buffered push arrives on the NEW socket id while the seat still carries the
 * old one. The server (which has no connection-state recovery) then sees a
 * socket that is neither host nor active player, drops the push silently, and
 * the rejoin's own broadcast overwrites the turn the player already committed
 * locally. Parking it here instead puts it behind the joinRoom ack.
 *
 * One slot, latest wins: every push is a full snapshot of the synced keys, so
 * an older parked one describes a state the newer one already supersedes.
 */
let parkedPush: ParkedEmit<PushStatePayload> | null = null;

// The single retry armed for a push refused as 'unauthorized' right after a
// reconnect (see emitPushState). Held so every teardown path can cancel it.
let pushRejoinRetryTimer: ReturnType<typeof setTimeout> | null = null;

// When this client last reconnected, or null if it has not. An 'unauthorized'
// refusal within PUSH_REJOIN_RACE_WINDOW_MS of that is read as the rejoin race
// rather than as a real refusal.
let lastReconnectAt: number | null = null;

// The deadline armed for the automatic rejoin the latest 'connect' sent (see
// registerSocketHandlers). Module state rather than a local of that handler:
// reconnects can overlap — the transport can drop again while a rejoin is
// still in flight — and the earlier attempt's ack can then never arrive,
// because the socket it was sent on is gone. Left armed, that dead attempt
// toasted "No response from the server" and tore the reconnect popup down
// JOIN_TIMEOUT_MS after the newer rejoin had already succeeded.
let rejoinWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Disarms the pending rejoin watchdog, if any.
 *
 * Called when a newer 'connect' supersedes the attempt it belongs to, when
 * that attempt is acked, and from every path that abandons the room
 * (leaveRoom, the kicked/seatTakenOver surrender, cancelReconnect,
 * useGameStore's reset) — the same set clearPendingPush is called from, and
 * for the same reason: `set(clearRoomState())` cannot reach module state.
 */
export const clearRejoinWatchdog = (): void => {
  if (rejoinWatchdogTimer !== null) {
    clearTimeout(rejoinWatchdogTimer);
    rejoinWatchdogTimer = null;
  }
};

/**
 * Forgets any push this client is still holding for the current room.
 *
 * Module state, so `set(clearRoomState())` cannot reach it — every path that
 * abandons the room (leaveRoom, the kicked/seatTakenOver surrender,
 * cancelReconnect, useGameStore's reset) calls this alongside it. Without it a
 * move made in a room the player has already left would be flushed into
 * whatever room the next reconnect finds them in.
 */
/**
 * Cancels a pending rejoin retry (see pushRejoinRetryTimer/emitPushState)
 * without touching parkedPush or lastReconnectAt.
 *
 * Split out of clearPendingPush so pushState can call just this: a fresh
 * pushState() call means a newer full snapshot exists, which supersedes
 * whatever stale one a queued retry would otherwise resend — but pushState
 * has nothing to do with abandoning the room, so parkedPush and
 * lastReconnectAt (whose clearing means exactly that) must stay put.
 */
const clearPendingPushRetry = (): void => {
  if (pushRejoinRetryTimer !== null) {
    clearTimeout(pushRejoinRetryTimer);
    pushRejoinRetryTimer = null;
  }
};

export const clearPendingPush = (): void => {
  parkedPush = null;
  clearPendingPushRetry();
  lastReconnectAt = null;
  // Every caller of this is a path that abandons the current online room
  // (leaveRoom, the kicked/seatTakenOver surrender, the unrecoverable-rejoin
  // branch, cancelReconnect, useGameStore's reset), and an endGameStats
  // resend still owed to that room must not outlive it either — it would go
  // out from a socket that no longer holds the seat. Cleared here rather than
  // at each of those five call sites so the two cannot drift apart.
  clearPendingStatsSubmit();
};

/**
 * Which joinRoom attempt this client is actually waiting on.
 *
 * A join ack is the one message that arrives with no room attached — it is
 * what SETS roomId/mode/myName — so unlike every other handler it cannot be
 * validated against them (see inRoom): that check would reject every
 * legitimate first join, whose ack is exactly what fills those fields in. This
 * counter is the discriminator instead: joinRoom takes the next number before
 * it emits, and applies its ack only if that number is still current.
 *
 * Without it, an ack from a join the user had already walked away from rewrote
 * a live LOCAL game into `mode: 'online'` under a foreign myName and a room
 * nobody was in, and wrote that room into the stored session key with it.
 */
let joinEpoch = 0;

/**
 * Invalidates whatever join is in flight, so its ack lands as a no-op.
 *
 * Called by every path that walks away from a join or a room: leaveRoom,
 * cancelReconnect, useGameStore's reset, and surrenderSeat — which inlines its
 * own teardown rather than calling leaveRoom, and so has to say this itself.
 */
export const abandonJoinAttempt = (): void => {
  joinEpoch++;
};

// Test-only escape hatch, the socket twin of timers.ts's _resetTimersForTests:
// the pending cleanup above is module state, so a cancelReconnect left
// in flight by one test would be torn down by the NEXT test's call and
// count against its disconnect assertions. reset() cannot reach it. The
// parked push and its retry timer are module state for the same reason.
export const _resetSocketSliceForTests = (): void => {
  pendingCancelReconnectCleanup?.();
  pendingCancelReconnectCleanup = null;
  clearPendingPush();
  clearRejoinWatchdog();
};

type SocketSliceSet = Parameters<ImmerStateCreator<SocketSlice>>[0];
type SocketSliceGet = Parameters<ImmerStateCreator<SocketSlice>>[1];

/**
 * How many times one finished game's stats submission is sent before the
 * client gives up: the first attempt plus two resends.
 *
 * Bounded, and small, because the thing being retried is not free: each
 * attempt costs a socket round trip and a slot in the server's per-socket
 * limiter for that event (5 per 10s each). Three attempts spread over a few
 * seconds comfortably outlast the transient lock contention this exists for; a
 * database that is still refusing writes by then is not a client problem.
 */
export const STATS_SUBMIT_MAX_ATTEMPTS = 3;

/** The attempt number the first send carries — the backoff counts from here. */
const FIRST_STATS_ATTEMPT = 1;

/** Exponential backoff: base, then double per further attempt. Exported so the tests
 * pin the schedule rather than re-deriving it. */
export const statsSubmitRetryDelayMs = (attempt: number): number =>
  STATS_SUBMIT_RETRY_BASE_MS * 2 ** (attempt - FIRST_STATS_ATTEMPT);

/**
 * Which of a stats submission's refusal reasons is worth resending —
 * 'write-failed' alone (see STATS_REFUSAL_REASONS in ../types for what each
 * reason means and why only this one is retryable).
 *
 * Named and exported, rather than an inline `=== 'write-failed'` check, so a
 * test can walk every reason STATS_REFUSAL_REASONS declares against an
 * explicit expected table: nothing else in the codebase reads that array, so
 * without this a reason added there would silently fall through this
 * function's bare comparison as terminal.
 */
export const isRetryableStatsRefusal = (reason: StatsRefusalReason): boolean =>
  reason === 'write-failed';

/**
 * The two submissions one finished game produces: this device's own row, and
 * — from the host alone — the game's server-wide row.
 *
 * Each keeps its OWN retry slot below. A host owes both and sends them back
 * to back (see sendOnlineStats), so a single shared slot would have the
 * second submission disarm the first one's ack deadline on its way out, and
 * the device row would never be resent — the very failure this retry exists
 * for.
 */
const STATS_SUBMIT_EVENTS = ['endGameStats', 'submitGlobalStats'] as const;
type StatsSubmitEvent = (typeof STATS_SUBMIT_EVENTS)[number];

// The resend armed for a submission the server could not write, and the
// deadline that decides a server answered nothing at all. At most one of each
// is ever live PER EVENT: a client submits each once per finished game, and
// each new submission supersedes whatever the last one left behind.
//
// Module state for the same reason parkedPush is — `set(clearRoomState())`
// cannot reach it, so every path that abandons the room has to clear it
// explicitly, or a resend for a room this client already left would go out
// from a socket that no longer holds that seat.
type PendingStatsSubmit = {
  resendTimer: ReturnType<typeof setTimeout> | null;
  ackDeadline: ReturnType<typeof setTimeout> | null;
  // Bumped by every clearStatsSubmit — including the one an attempt's own
  // settle() runs on its way to arming a resend — so an in-flight attempt's
  // closure can tell whether it still owns this slot by the time its ack or
  // deadline fires. Without it, an attempt cancelled by leaveRoom/
  // cancelReconnect (which stop the timers but cannot reach the closure)
  // still ran settle() when its ack landed and armed a resend against a room
  // already left; and a fresher attempt starting (submitGlobalStats/
  // sendOnlineStats clearing and resubmitting) left the OLD attempt's closure
  // free to have its own late ack call clearStatsSubmit again, cancelling the
  // NEW attempt's ack deadline out from under it.
  epoch: number;
  // The submission that could not be sent because the transport was down,
  // held until this client's rejoin lands — see emitStatsSubmission. One park
  // PER EVENT for the same reason the timers above are per event: a host owes
  // both and sends them back to back, so a single shared park would keep only
  // the second and silently lose this device's own row.
  parked: ParkedEmit<{ payload: EndGameStatsPayload | GlobalStatsSubmission; attempt: number }> | null;
};

const pendingStatsSubmits: Record<StatsSubmitEvent, PendingStatsSubmit> = {
  endGameStats: { resendTimer: null, ackDeadline: null, epoch: 0, parked: null },
  submitGlobalStats: { resendTimer: null, ackDeadline: null, epoch: 0, parked: null },
};

/** Forgets whatever one of the two submissions still owes. */
const clearStatsSubmit = (event: StatsSubmitEvent): void => {
  const pending = pendingStatsSubmits[event];
  pending.epoch += 1;
  if (pending.resendTimer !== null) {
    clearTimeout(pending.resendTimer);
    pending.resendTimer = null;
  }
  if (pending.ackDeadline !== null) {
    clearTimeout(pending.ackDeadline);
    pending.ackDeadline = null;
  }
  // The park is owed to the room this attempt was made in just as much as the
  // timers are: left behind, a submission for a room this client has left
  // would be flushed into whatever room the next rejoin finds it in, where the
  // server — its per-game dedup reset by the Play Again in between — records
  // the finished game's row against the new game.
  pending.parked = null;
};

/** Forgets every stats attempt this client still owes. */
export const clearPendingStatsSubmit = (): void => {
  for (const event of STATS_SUBMIT_EVENTS) clearStatsSubmit(event);
};

type EndGameStatsPayload = {
  roomId: string | null;
  deviceId: string | null;
  stats: DeviceStatsPayload;
};

// No roomId: the server resolves the room from the session and ignores
// whatever the wire payload claims (see submitGlobalStats in
// server/socketStatsHandlers.ts). A field nobody reads only invites the next
// reader to think it is authoritative.
type GlobalStatsSubmission = { payload: GlobalStatsPayload };

/**
 * Sends one game's stats and resends them if the server lost the write.
 *
 * Both submissions used to be fire-and-forget, and the server's write failure
 * path — which rolls the matching dedup entry back precisely so a resend CAN
 * be recorded — had nothing on the other end to resend. One transient sqlite
 * error therefore lost that row for the game for good: this device's, or, for
 * submitGlobalStats, the game's server-wide one.
 *
 * Exactly two outcomes lead to a resend:
 *
 *  - 'write-failed', which is the server saying the dedup is reopened and an
 *    identical payload is expected.
 *  - no answer at all inside STATS_SUBMIT_ACK_TIMEOUT_MS — a server that died
 *    mid-write, and also a server predating the ack. The latter would already
 *    have recorded the row, and its own per-game dedup drops the resends.
 *
 * Every other refusal is terminal, 'duplicate' most of all: the row is in, and
 * resending would be asking the server to count the same game twice.
 *
 * None of that can start over a dead transport, which is why the `connected`
 * check comes first. socket.io-client would happily buffer the emit itself,
 * and that is the bug: its Socket#onconnect flushes the send buffer BEFORE it
 * fires 'connect', so a buffered submission reaches the server ahead of this
 * client's rejoin, from a socket holding no seat, and is refused 'no-room' —
 * terminal, so nothing above resends it and the row is simply lost. Parking it
 * puts it behind the rejoin ack instead (same mechanism as parkedPush).
 *
 * `parkedAt` is threaded through rather than re-stamped — by flushParkedStats
 * on its way back in here, and by the resend below — so neither a second park
 * nor an ack timeout plus backoff restarts the clock on a submission that has
 * been waiting since the first one. See ParkedEmit.
 */
const emitStatsSubmission = (
  event: StatsSubmitEvent,
  payload: EndGameStatsPayload | GlobalStatsSubmission,
  attempt: number,
  parkedAt: number = Date.now(),
): void => {
  const socket = getSocket();
  if (!socket) return;
  const pending = pendingStatsSubmits[event];
  if (!socket.connected) {
    // Parked BEFORE the ack deadline is armed: nothing is in flight to answer
    // it, so arming one here would burn this submission's whole retry budget
    // against a socket that cannot carry it.
    pending.parked = { payload: { payload, attempt }, parkedAt };
    return;
  }
  // The generation this attempt owns the slot under. clearStatsSubmit bumps
  // it on every cancellation — leaveRoom/cancelReconnect abandoning the room,
  // and a fresher attempt starting — so settle() below can tell a slot it no
  // longer owns from one still live, even though those cancellations can
  // reach the timers but never this closure.
  const epoch = pending.epoch;

  // Whichever arrives first — the ack or the deadline — settles this attempt;
  // a late ack after the deadline has already armed a resend must not arm a
  // second one, and neither may fire once this attempt's epoch is stale.
  let settled = false;
  const settle = (resend: boolean): void => {
    if (settled || pending.epoch !== epoch) return;
    settled = true;
    clearStatsSubmit(event);
    if (!resend || attempt >= STATS_SUBMIT_MAX_ATTEMPTS) return;
    pending.resendTimer = setTimeout(() => {
      pending.resendTimer = null;
      // Carrying this attempt's stamp, for the same reason flushParkedStats
      // carries the park's: it dates the SUBMISSION, not the send. A resend
      // that let it default re-stamped the row as brand new, so a retry that
      // then found the transport down parked at now() — and the age bound
      // that drops a submission for a game the room has moved on from was
      // measured from the resend rather than from the original park. An
      // attempt that runs out its ack deadline and backs off adds
      // STATS_SUBMIT_ACK_TIMEOUT_MS plus a backoff to the true age per
      // attempt, so a park already close to the bound came back looking fresh
      // and was flushed into the NEXT game's dedup window.
      emitStatsSubmission(event, payload, attempt + 1, parkedAt);
    }, statsSubmitRetryDelayMs(attempt));
  };

  pending.ackDeadline = setTimeout(() => settle(true), STATS_SUBMIT_ACK_TIMEOUT_MS);

  socket.emit(event, payload, (ack?: StatsSubmitAck) => {
    settle(ack !== undefined && !ack.ok && isRetryableStatsRefusal(ack.reason));
  });
};

// Global stats are submitted by the host over the socket, so no secret token
// needs to be compiled into the client bundle: the server validates the sender
// is the room host by socket identity.
//
// Safe to call more than once for the same game. The server refuses it unless
// room.state.finished, and records it once per game (statsRecordedForGame.global,
// reset when the next one starts) — which is what lets the host-promotion path
// below fire it without having to know whether the departed host already did.
// A repeat that the server has already recorded comes back as 'duplicate',
// which the retry above treats as terminal.
const submitGlobalStats = (get: SocketSliceGet): void => {
  // Anything still pending for this event can only belong to an earlier
  // attempt at the same row, which this fresher one supersedes.
  clearStatsSubmit('submitGlobalStats');
  emitStatsSubmission(
    'submitGlobalStats',
    { payload: get().buildGlobalStatsPayload() },
    FIRST_STATS_ATTEMPT,
  );
};

/**
 * Sends one push and acts on what the server says about it.
 *
 * The ack is optional on the wire in both directions: a server predating it
 * simply never invokes the callback, which is indistinguishable from a push
 * nobody objected to — so silence is success. A refusal is not silent:
 *
 *  - 'unauthorized' shortly after a reconnect is almost always this client's
 *    own rejoin not having landed yet, so the same snapshot is re-sent ONCE
 *    (`retryable` is false on that retry, and on every push that follows).
 *  - 'no-room' is the one refusal a fresh snapshot cannot answer: there is no
 *    room left to ask. The seat is given up the same way the kicked and
 *    seatTakenOver handlers give it up (see surrenderSeat), rather than the
 *    player being left in a room that does not exist, where every action
 *    silently does nothing.
 *  - 'rate-limited' says nothing is wrong with what this client is holding —
 *    it is simply pushing faster than the limiter allows, and the next
 *    legitimate push lands normally. A toast per dropped push would be a burst
 *    of alarming noise, and a requestState per dropped push feeds the flood.
 *  - anything else — and a second 'unauthorized' — is a push the room has
 *    genuinely thrown away. The player is told, and a fresh snapshot is pulled
 *    so the client stops rendering a turn the room never accepted.
 *
 * `parkedAt` is the stamp this snapshot already carries when the caller is
 * flushing a park; a re-park below reuses it so the age keeps accruing, which
 * is the invariant ParkedEmit documents. Absent (a live push) the re-park
 * stamps itself.
 */
const emitPushState = (
  sock: Socket,
  payload: PushStatePayload,
  get: SocketSliceGet,
  retryable: boolean,
  parkedAt?: number,
): void => {
  sock.emit('pushState', payload, (ack?: PushStateAck) => {
    if (!ack || ack.ok) return;

    const racedOwnRejoin = ack.reason === 'unauthorized' && retryable &&
      lastReconnectAt !== null && Date.now() - lastReconnectAt <= PUSH_REJOIN_RACE_WINDOW_MS;
    if (racedOwnRejoin) {
      if (pushRejoinRetryTimer !== null) clearTimeout(pushRejoinRetryTimer);
      pushRejoinRetryTimer = setTimeout(() => {
        pushRejoinRetryTimer = null;
        const current = getSocket();
        // Connected, not merely present. This retry is armed for a flaky
        // reconnect, so the transport dropping again inside its delay is the
        // case it exists for — and emitting then is the exact bug parkedPush
        // was built to prevent: socket.io-client flushes its send buffer
        // BEFORE it fires 'connect', so the push lands on the new socket id
        // while the seat still carries the old one, is refused, and is gone
        // (this retry is not itself retryable). Park it instead, and the
        // rejoin flushes it in order like any other held push.
        if (current?.connected) emitPushState(current, payload, get, false, parkedAt);
        else parkedPush = { payload, parkedAt: parkedAt ?? Date.now() };
      }, PUSH_REJOIN_RETRY_DELAY_MS);
      return;
    }

    if (ack.reason === 'no-room') {
      get().addToast(i18n.t('game.toastPushRoomGone',
        'This room no longer exists on the server.'));
      // leaveRoom is surrenderSeat's own teardown (stop the timers, drop the
      // stored session, clear the turn caches and the parked push, wipe the
      // room state) plus a 'leaveRoom' emit the server ignores for a room it
      // no longer has; setMode('local') completes it, exactly as the
      // room-gone branch of the rejoin handler does.
      get().leaveRoom();
      get().setMode('local');
      return;
    }

    if (ack.reason === 'rate-limited') return;

    get().addToast(i18n.t('game.toastPushRefused',
      'Your last move was not accepted by the server; the game state was refreshed.'));
    // Answered with a gameState to this socket alone. The room broadcasts on
    // its own schedule, and a refused push may be the last thing that would
    // have happened in it for a while — this client cannot afford to wait.
    getSocket()?.emit('requestState', { roomId: payload.roomId });
  });
};

/**
 * Sends the push held for a transport drop, now that the rejoin has been acked.
 *
 * Cleared before the emit, not after: the flush must be one-shot even if the
 * emit itself throws. A park older than PARKED_EMIT_MAX_AGE_MS is dropped
 * instead of sent — it describes a game the room has moved on from, and a push
 * is a FULL snapshot, so landing it would overwrite live play with a dead turn.
 * A park made for another room is dropped for the same reason: every departure
 * path clears the park today, so this is belt and braces for a room switch
 * that ever forgets to.
 *
 * The stamp rides on into emitPushState so a re-park (the rejoin-race retry
 * finding the transport gone again) keeps accruing age instead of renewing the
 * snapshot on every flaky reconnect.
 */
const flushParkedPush = (get: SocketSliceGet): void => {
  const parked = parkedPush;
  parkedPush = null;
  if (!parked) return;
  if (Date.now() - parked.parkedAt > PARKED_EMIT_MAX_AGE_MS) return;
  if (parked.payload.roomId !== get().roomId) return;
  const sock = getSocket();
  if (!sock) return;
  if (!sock.connected) {
    // Connected, not merely present — same reason emitPushState's own
    // rejoin-race retry re-checks it (see ~line 596). The rejoin ack that
    // reached here can still find the transport gone again (the ack and a
    // fresh drop can land in the same tick), and emitting into it would be
    // the exact bug parkedPush exists to prevent. Re-parked with the SAME
    // stamp, not a fresh one, so age keeps accruing across re-parks — the
    // invariant ParkedEmit documents.
    parkedPush = parked;
    return;
  }
  emitPushState(sock, parked.payload, get, true, parked.parkedAt);
};

/**
 * Sends the stats submissions held for a transport drop, now that the rejoin
 * has been acked. Same age bound, and for the second of the two reasons given
 * on PARKED_EMIT_MAX_AGE_MS.
 *
 * Re-enters emitStatsSubmission rather than emitting the payload from here:
 * that is what re-reads the live socket AND this slot's epoch at send time, so
 * a transport that dropped again between the ack and this call parks the
 * submission afresh instead of firing it into a dead socket — the exact
 * failure the park exists to prevent — and the ack deadline and resend budget
 * are armed by the one function that owns them. Each slot is emptied before
 * its send, so the flush is one-shot even if the emit throws.
 */
const flushParkedStats = (): void => {
  for (const event of STATS_SUBMIT_EVENTS) {
    const parked = pendingStatsSubmits[event].parked;
    pendingStatsSubmits[event].parked = null;
    if (!parked) continue;
    if (Date.now() - parked.parkedAt > PARKED_EMIT_MAX_AGE_MS) continue;
    emitStatsSubmission(event, parked.payload.payload, parked.payload.attempt, parked.parkedAt);
  }
};

/**
 * Whether this client currently holds a seat a room broadcast may be applied to.
 *
 * Every server->client handler is gated on this, not just the ones carrying
 * game state: a broadcast can land after this client has already left, because
 * leaveRoom and the kicked/seatTakenOver surrender flip the store out of the
 * room while the server is still processing the leave, so anything it emitted
 * during that round trip still arrives.
 *
 * roomId as well as mode, because the mode check alone cannot see a leave that
 * stays online: clearRoomState contains neither `mode` nor `isOnline`, and four
 * of leaveRoom's five call sites deliberately keep the user in online mode on
 * the join form. One helper rather than six copies of the expression, so the
 * handlers cannot drift apart again — five of them carried no guard at all.
 *
 * NOT usable for the joinRoom ack, which is what sets these fields in the first
 * place — joinEpoch is that side's answer.
 */
const inRoom = (get: SocketSliceGet): boolean => get().mode === 'online' && !!get().roomId;

// Wires every server->client event for one socket connection. Extracted out of
// connectSocket (which just creates the socket and delegates here) so the
// event-bus itself is a standalone, independently readable unit rather than a
// 150-line inline factory.
const registerSocketHandlers = (sock: Socket, get: SocketSliceGet, set: SocketSliceSet): void => {
  // `stateVersion` rides alongside the synced fields (server/rooms.ts's
  // emitRoomState bumps it once per broadcast) but is not one of them: it is
  // server-derived metadata, deliberately absent from SYNCED_GAME_STATE_KEYS
  // so the sync loop below cannot apply it and a push can never write it.
  sock.on('gameState', (serverState: Partial<GameStore> & { stateVersion?: number }) => {
    // A broadcast can land after this client already returned to local mode
    // (leaveRoom/kicked flip the mode before the socket fully tears down).
    // Applying it would inject the online room into local state — which the
    // local persistence subscriber would immediately write to disk. Every
    // teardown path upholds this invariant on its own; the guard makes it
    // structural instead of distributed. Restoring players/finished/
    // currentPlayerIndex is enough for App.tsx to route back into
    // Game/EndScreen over a store with no room, where every action silently
    // no-ops and syncOnlineTimers restarts the countdown that was just
    // stopped. See inRoom for why roomId is checked as well as mode; it is set
    // in the same tick as mode on the way in (the joinRoom ack), so this closes
    // a window rather than opening one.
    if (!inRoom(get)) return;

    // A straggler from before something this client has already applied — a
    // broadcast that overtook a newer one, or the room's own pre-push state
    // arriving after the push that superseded it. Applying it would undo a
    // turn already committed here, and the next broadcast would not
    // necessarily correct it. Only a STRICTLY lower version is dropped:
    // equal still applies (the requestState reply re-sends the same version),
    // and a missing one applies too, so an older server keeps working.
    const incomingVersion = serverState.stateVersion;
    const floor = get().lastAppliedStateVersion;
    if (typeof incomingVersion === 'number' && floor !== null && incomingVersion < floor) return;

    const wasFinished = get().finished;
    set((prev) => {
      const wasDisconnected = prev.showReconnectPopup;

      // The first sync after joining describes the room as it already is —
      // only LATER diffs are host changes worth announcing.
      const firstRoomSync = !prev.roomStateSynced;
      prev.roomStateSynced = true;

      if (!firstRoomSync && prev.mode === 'online' && prev.status === 'lobby' && serverState.status === 'lobby') {
        // Each diff is guarded with `key in serverState`, matching the sync
        // loop below: serverState is typed Partial<GameStore>, so an absent
        // key must read as "unchanged", not "changed to undefined" (which
        // would toast e.g. "Winning score: undefined").
        if (typeof serverState.winningScore === 'number' && prev.winningScore !== serverState.winningScore) {
          prev.toasts.push(makeToast(i18n.t('game.toastWinningScore', {
            defaultValue: 'Winning score: {{value}}',
            value: formatInt(serverState.winningScore, i18n.language),
          })));
        }
        if ('turnDuration' in serverState && prev.turnDuration !== serverState.turnDuration) {
          const value = serverState.turnDuration === 0
            ? i18n.t('common.disabled', 'Disabled')
            : i18n.t('game.timeSeconds', { defaultValue: '{{time}}s', time: serverState.turnDuration });
          prev.toasts.push(makeToast(i18n.t('game.toastTurnTimer', { defaultValue: 'Turn timer: {{value}}', value })));
        }
        if ('reconnectTimeout' in serverState && prev.reconnectTimeout !== serverState.reconnectTimeout) {
          prev.toasts.push(makeToast(i18n.t('game.toastKickTimer', {
            defaultValue: 'Kick timer: {{value}}',
            value: `${serverState.reconnectTimeout}s`,
          })));
        }
        if (serverState.initialCards && !areInitialCardsEqual(prev.initialCards, serverState.initialCards)) {
          prev.toasts.push(makeToast(i18n.t('game.toastDeckChanged', 'Deck composition changed')));
        }
        if ('enforcedDiceMode' in serverState && prev.enforcedDiceMode !== serverState.enforcedDiceMode) {
          const value = serverState.enforcedDiceMode === null
            ? i18n.t('common.disabled', 'Disabled')
            : serverState.enforcedDiceMode === 'digital'
              ? i18n.t('lobby.digitalDice', 'Digital Dice')
              : i18n.t('lobby.physicalDice', 'Physical Dice');
          prev.toasts.push(makeToast(i18n.t('game.toastDiceModeEnforced', { defaultValue: 'Dice mode: {{value}}', value })));
        }
        if ('ruleset' in serverState && prev.ruleset !== serverState.ruleset) {
          const value = serverState.ruleset === 'classic'
            ? i18n.t('lobby.rulesetClassic', 'Classic')
            : i18n.t('lobby.rulesetModernized', 'Modernized');
          prev.toasts.push(makeToast(i18n.t('game.toastRuleset', { defaultValue: 'Rules: {{value}}', value })));
        }
      }
      if (prev.mode === 'online' && roomPhase(prev) === 'playing' && serverState.status === 'lobby' && (serverState.players?.length ?? 0) >= 2) {
        prev.toasts.push(makeToast(i18n.t('game.toastHostEndedEarly', 'Host ended game early')));
      }
      for (const key of GAME_STATE_SYNC_KEYS) {
        if (key in serverState) (prev as Record<string, unknown>)[key] = serverState[key];
      }
      if (typeof incomingVersion === 'number') prev.lastAppliedStateVersion = incomingVersion;

      const isNewReconnect = wasDisconnected && serverState.status === 'playing';
      if (isNewReconnect) {
        prev.justReconnected = true;
      } else if (prev.justReconnected) {
        // Self-clearing: true for exactly one gameState event's processing
        // window, then reset here on the next one — regardless of whether
        // any component (e.g. Game.tsx) was mounted to react to it and
        // clear it itself. Without this it could get stuck true forever
        // (e.g. reconnecting as a spectator, or on physical dice) and
        // wrongly resurface on a later, unrelated turn.
        prev.justReconnected = false;
      }
      prev.showReconnectPopup = false;
    });
    // Pass the server-computed remaining turn time so the display countdown
    // resyncs to it (see syncOnlineTimers for why it is authoritative).
    get().syncOnlineTimers(serverState.turnTimeRemaining);

    if (!wasFinished && get().finished) {
      // Frozen BEFORE the submission, and kept for the promotion path that may
      // submit much later: a host promotion on a dead host only fires when the
      // disconnect timer drains, and the server splices that seat before it
      // broadcasts — so by then the roster is missing the player who left, very
      // often the winner.
      //
      // This edge covers every client that WATCHES the finish. The one that
      // caused it sets `finished` locally first, so the echo is no edge at all
      // — gameSlice.nextTurn freezes it there, through the same helper.
      set({ finishedGameSnapshot: finishedGameSnapshotOf(get()) });
      get().sendOnlineStats();
    }
  });

  sock.on('playerDisconnected', (name: string) => {
    // Same guard as every other room event (see inRoom): a disconnect notice
    // for a room this client has left is a toast about strangers.
    if (!inRoom(get)) return;
    const seconds = get().reconnectTimeout;
    // 0 = the kick timer is disabled for this room (see configValidation.ts)
    // — there is no deadline, so a message inventing one is misleading.
    if (!seconds) {
      get().addToast(i18n.t('game.playerDisconnectedNoTimeout', {
        defaultValue: '{{name}} disconnected!',
        name,
      }));
      return;
    }
    get().addToast(i18n.t('game.playerDisconnected', {
      defaultValue: '{{name}} disconnected! They have {{seconds}} seconds to reconnect.',
      name,
      seconds,
    }));
  });

  sock.on('nameConflictWithDisconnected', (name: string) => {
    // Host-only advice about a room this client may no longer be in — and it
    // ends with "Kick them below", pointing at a lobby that is gone.
    if (!inRoom(get)) return;
    get().addToast(i18n.t('game.nameConflictWithDisconnected', {
      defaultValue: 'Someone tried to join as "{{name}}", which belongs to a disconnected player. Kick them below to free up the name.',
      name,
    }));
  });

  sock.on('playerReaction', (reaction: Reaction) => {
    // A reaction from the room this client just left would otherwise float
    // over the local game (or the join form) that replaced it.
    if (!inRoom(get)) return;
    set((state) => { state.reactions.push(reaction); });
    // Self-pruning, like toasts — the sender only needs the id/timing
    // contract, not a per-reaction cleanup call from the UI layer.
    setTimeout(() => get().removeReaction(reaction.id), REACTION_DISPLAY_MS);
  });

  sock.on('hostId', (hostSocketId: string) => {
    // emitRoomState only ever sends this alongside a gameState, so guarding it
    // identically keeps the pair from being applied by halves: a client that
    // has left would otherwise be told it is host of the room it left, and the
    // promotion branch below would submit that game's global stats from it.
    if (!inRoom(get)) return;
    const wasHost = get().isHost;
    const isNowHost = hostSocketId === sock.id;
    set({ isHost: isNowHost, hostId: hostSocketId });

    // Only the host submits global stats, and only on the tick where
    // `finished` flips (see the gameState handler). A host whose socket died
    // before the winning push landed never saw that tick, and every client
    // that did was not host — so the game went unrecorded. Being promoted onto
    // an already-finished game is the one moment left to catch it. Narrow on
    // purpose: emitRoomState broadcasts hostId with every gameState, so this
    // arrives repeatedly through the whole end screen, and only the
    // not-host -> host transition may act on it.
    if (!wasHost && isNowHost && get().finished) submitGlobalStats(get);
  });

  // Dedicated low-frequency-cost path for live dice-roll updates (see
  // pushLiveTurnState) — a plain single-field merge, deliberately not
  // routed through the 'gameState' handler above so a dice tick doesn't
  // re-run its toast-diffing/justReconnected/timer-sync/stats side
  // effects, none of which apply here.
  sock.on('liveTurnState', (payload: { liveTurnState: DiceSnapshot | null }) => {
    // Guarded like its heavyweight sibling: a spectator frame applied after
    // the leave leaves someone else's dice on the table of the next game.
    if (!inRoom(get)) return;
    set({ liveTurnState: payload.liveTurnState });
  });

  // Losing the seat, whichever way it happened: say why, then tear the room
  // down. Mirrors leaveRoom's reset (see its comment): setMode('local') below
  // only overwrites the keys a saved local game happens to contain, so without
  // clearing the online room's roster/game state here too, it bleeds into
  // local mode whenever there's no local save to overwrite it.
  const surrenderSeat = (message: string): void => {
    get().addToast(message);
    get().stopOnlineTimers();
    sessionStore.remove(ONLINE_SESSION_KEY);
    clearTurnCaches();
    clearPendingPush();
    clearRejoinWatchdog();
    // Spelled out here because this teardown is inlined rather than delegated
    // to leaveRoom: a join in flight when the seat is lost must not be able to
    // re-seat the store on its way in (see abandonJoinAttempt).
    abandonJoinAttempt();
    set(clearRoomState());
    get().setMode('local');
  };

  // Guarded like every other room broadcast, and for a sharper reason than
  // most: surrenderSeat clears the room state and flips to local mode, and the
  // local persistence subscriber writes on any set() made while mode is
  // 'local' — so a kick that lands after this client already left would empty
  // a RESTORED LOCAL GAME and overwrite its save on disk, unrecoverably. The
  // window is real: leaveRoom does not disconnect the socket, and Home and
  // OnlineLobby both do leaveRoom() then setMode('local'), which restores that
  // saved game synchronously.
  sock.on('kicked', () => {
    if (!inRoom(get)) return;
    surrenderSeat(i18n.t('game.kickedByHost', 'You were kicked by the host'));
  });

  // The same device joined again from somewhere else (a second tab, the app
  // reopened) and the server moved the seat to that connection. Without this
  // the superseded tab kept a full-looking room whose every action silently
  // did nothing.
  sock.on('seatTakenOver', () => {
    if (!inRoom(get)) return;
    surrenderSeat(i18n.t('game.seatTakenOver',
      'This device joined the room from somewhere else, so this window left it.'));
  });

  sock.on('gameAborted', () => {
    if (!inRoom(get)) return;
    get().addToast(i18n.t('game.aborted'));
  });

  sock.on('disconnect', () => {
    // Only a client holding a seat has anything to reconnect TO. Online mode
    // alone is not enough: sitting on the join form (after leaving a room or
    // finishing a game) there is no room to recover, and the 'connect' handler
    // below would have had no rejoin to run — so the full-screen "attempting
    // to reconnect" modal stayed up over a connection that was already back.
    const { mode, roomId, myName } = get();
    if (mode === 'online' && roomId && myName) set({ showReconnectPopup: true });
  });

  sock.on('connect', () => {
    // Stamped before the early return: an 'unauthorized' push refusal is only
    // excused as a rejoin race for a short window after this moment.
    lastReconnectAt = Date.now();
    // Whatever the previous connect was still waiting on died with its
    // socket: only the attempt this handler is about to make (if any) may
    // speak for the player from here.
    clearRejoinWatchdog();
    const { mode, roomId, myName, deviceId } = get();
    if (!roomId || !myName) {
      // Nothing to rejoin, so anything the drop raised is now stale. Limited
      // to online mode because a session restore raises the popup itself and
      // only then calls joinRoom: until the server acks that join the store
      // still holds no room AND is still in local mode, and this very
      // connection is the one carrying it — lowering it here would pull the
      // modal out from under an attempt that is still running.
      if (mode === 'online') set({ showReconnectPopup: false });
      return;
    }
    const savedColor = localStore.read('tutto_color');

    // The same deadline the lobby's join button and the reconnect popup's
    // "Yes, Reconnect" already race their joins against — this path had none,
    // and it is the one nobody is watching a button for. An ack can go missing
    // on a socket that stays perfectly healthy: safeOn (server/socketContext)
    // catches a throwing handler and logs it, so no ack is ever sent and no
    // later 'connect' fires to retry. Without this the full-screen "attempting
    // to reconnect" modal stayed up for good, with the menu button as the only
    // way out.
    const watchdog = setTimeout(() => {
      rejoinWatchdogTimer = null;
      get().addToast(i18n.t('lobby.online.joinTimeout', 'No response from the server. Please try again.'));
      set({ showReconnectPopup: false });
    }, JOIN_TIMEOUT_MS);
    rejoinWatchdogTimer = watchdog;

    sock.emit('joinRoom', { roomId, name: myName, deviceId, color: savedColor, isReconnect: true }, (res: JoinRoomResponse) => {
      clearTimeout(watchdog);
      // Only if this ack's own watchdog is still the pending one — a late ack
      // from a superseded attempt must not disarm the live attempt's deadline
      // (same identity check pendingCancelReconnectCleanup's cleanup makes).
      if (rejoinWatchdogTimer === watchdog) rejoinWatchdogTimer = null;
      // leaveRoom and cancelReconnect don't disconnect the socket, so this
      // ack can still land after either has already run set(clearRoomState())
      // and put the store back in local mode. clearRoomState is what makes
      // that room-departure structural (see its own comment): it always
      // clears roomId, so a mismatch here means this ack no longer has a
      // room to speak for — a late success must not re-seat the store, and a
      // late failure must not toast or force local mode over a leave the
      // player already completed on their own.
      if (get().roomId !== roomId) return;
      if (res.success) {
        // The floor goes with the connection: the room may have been
        // recreated under the same id while this client was away, and its
        // versions then start over below whatever floor was carried in.
        set({ isHost: res.isHost ?? false, myName: res.name ?? myName, lastAppliedStateVersion: null });
        // Only now: the seat is this socket's again, so the push made during
        // the drop can finally pass the server's authorization gate.
        flushParkedPush(get);
        // Strictly after the push, never before: the server refuses end-game
        // stats until it has seen finished=true, with 'not-finished' — a
        // terminal refusal — so the winning push has to land first. Same order
        // nextTurn sends the two in, for the same reason.
        flushParkedStats();
        return;
      }
      // The seat is unrecoverable (room deleted after the reconnect
      // timeout, name reclaimed, …) — retrying on the next 'connect'
      // can never succeed, so stop showing the "attempting to
      // reconnect" popup and drop back to the online join form. The parked
      // push goes with it: there is no seat left for it to land in.
      clearPendingPush();
      get().addToast(
        joinErrorMessage(res, (key, defaultValue) => i18n.t(key, defaultValue))
          ?? i18n.t('home.restore.failed', 'Failed to reconnect to the game'),
      );
      get().leaveRoom();
      set({ showReconnectPopup: false, hostId: null });
      // room-gone specifically (see server/socketRoomHandlers.ts, item A10):
      // the room itself is gone, not just this seat, so there is nothing left
      // to show an "online join form" for — land back on local Home instead
      // (leaveRoom above already dropped tutto_online_session), and drop any
      // stale restore prompt this device might also be holding.
      if (res.code === 'room-gone') {
        set({ pendingReconnectSession: null });
        get().setMode('local');
      }
    });
  });
};

export const createSocketSlice: ImmerStateCreator<SocketSlice> = (set, get) => ({
  cancelReconnect: (roomId?: string | null, name?: string | null) => {
    pendingCancelReconnectCleanup?.();
    pendingCancelReconnectCleanup = null;

    clearTurnCaches();
    clearPendingPush();
    clearRejoinWatchdog();
    // This is the "no, don't reconnect me" answer — whatever join is still in
    // flight is exactly what is being declined.
    abandonJoinAttempt();
    sessionStore.remove(ONLINE_SESSION_KEY);
    set({ pendingReconnectSession: null, liveTurnState: null, showReconnectPopup: false });

    // Read BEFORE the clearRoomState below wipes them: the arguments identify
    // the room to release when the caller knows it (declining the restore
    // prompt, where the store never held one), but App.tsx's "Return to Main
    // Menu" calls this with none while the store is still seated. Without this
    // fallback the server was never told, and a room configured with
    // reconnectTimeout 0 arms no kick timer (server/socketRoomHandlers.ts), so
    // the abandoned seat stayed in the room forever.
    const targetRoomId = roomId ?? get().roomId;
    const targetName = name ?? get().myName;

    // Abandoning an active room (the "Return to Main Menu" path) must also drop
    // the room identity and game state from the store — the setMode('local')
    // that follows only overwrites the keys a saved local game happens to
    // contain, so without this the stale roomId later renders a phantom
    // joined-room lobby (or the online roster bleeds into local mode).
    // Guarded on the STORE's roomId: declining the restore prompt on a fresh
    // page load (store roomId never set — the roomId argument here identifies
    // the room to leave server-side) must not wipe a restored local game.
    if (get().roomId) {
      // Inside the same guard, and for the same reason: stopOnlineTimers owns
      // the ONE interval handle both clocks run on, so calling it with no room
      // to abandon would freeze the local game init() had just restarted. With
      // a room, it is required — clearRoomState cannot reach module state, so
      // the game clock would otherwise keep ticking gameTimeInSeconds into
      // whatever game comes next (the turn countdown retires itself once
      // turnDeadline is cleared below, but the game clock has no such check).
      get().stopOnlineTimers();
      set(clearRoomState());
    }

    if (!targetRoomId) return;

    const tempSocket = io(window.location.origin);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeoutId);
      tempSocket.disconnect();
      if (pendingCancelReconnectCleanup === cleanup) pendingCancelReconnectCleanup = null;
    };
    pendingCancelReconnectCleanup = cleanup;
    const timeoutId = setTimeout(cleanup, CANCEL_RECONNECT_FAILSAFE_MS);

    tempSocket.on('connect_error', cleanup);
    tempSocket.on('connect', () => {
      const savedColor = localStore.read('tutto_color');
      tempSocket.emit('joinRoom', {
        roomId: targetRoomId,
        name: targetName,
        deviceId: get().deviceId,
        color: savedColor,
        // A reconnect, so a room the server no longer has is refused
        // (room-gone) instead of being created and immediately deleted.
        isReconnect: true,
      }, (res: JoinRoomResponse) => {
        if (res?.success) tempSocket.emit('leaveRoom');
        cleanup();
      });
    });
  },

  connectSocket: (url?: string) => {
    if (!getSocket()) {
      const sock = io(url ?? window.location.origin);
      setSocket(sock);
      registerSocketHandlers(sock, get, set);
    }
  },

  joinRoom: (room, name, isReconnect = false) => {
    // First, before anything else this action does and long before the emit:
    // this attempt supersedes any earlier one, whose ack must from here on be
    // ignored rather than allowed to seat the store in a room this client
    // asked to leave (see joinEpoch).
    const attempt = ++joinEpoch;
    // The single choke point every caller of joinRoom goes through (the
    // lobby's typed input, a scanned QR code, a shared invite link already
    // normalizes its own parse, and the automatic reconnect-on-connect
    // handler above, which replays whatever this action last stored) — so
    // "abc" and "ABC" always ask the server for the same room, and never two.
    const normalizedRoom = normalizeRoomId(room);
    if (!isReconnect) {
      clearTurnCaches();
      set({ liveTurnState: null });
    }
    // The first gameState after ANY join is the room introducing itself, not
    // the host changing something — the config-diff toasts must not fire for
    // it (they would announce every difference between this device's saved
    // host config and the room's actual settings as "changes").
    set({ roomStateSynced: false });
    return new Promise<JoinRoomResponse>((resolve) => {
      let initialConfig: Partial<Pick<GameStore, ConfigKeys>> | undefined = undefined;
      try {
        const storedConfigStr = localStore.read('tutto_online_config');
        if (storedConfigStr) {
          // Only transmit fields the server would accept — same validator the
          // lobby uses when loading this config, so both stay in sync.
          const validated = validateOnlineConfig(JSON.parse(storedConfigStr));
          if (Object.keys(validated).length > 0) initialConfig = validated;
        }
      } catch (e) {
        console.error('Failed to parse online config for joinRoom', e);
      }

      get().connectSocket();
      const savedColor = localStore.read('tutto_color');
      const socket = getSocket();
      if (!socket) {
        resolve({ success: false, error: 'Socket not connected' });
        return;
      }
      socket.emit('joinRoom', { roomId: normalizedRoom, name, deviceId: get().deviceId, color: savedColor, initialConfig, isReconnect }, (res: JoinRoomResponse) => {
        // An ack for an attempt this client has walked away from (see
        // joinEpoch). It is resolved, not dropped: OnlineLobby and App.tsx
        // both await this promise, and a "return early" here would leave them
        // waiting on it forever. And deliberately WITHOUT emitting a leave:
        // the server's 'leaveRoom' takes no room argument and vacates whatever
        // the session points at, so tidying up room A this way would eject the
        // player from room B — the room they are legitimately in.
        if (attempt !== joinEpoch) {
          resolve(res);
          return;
        }
        if (res.success) {
          // Adopt the name the server seated us under — a mid-game rejoin with
          // a different name keeps the seat's original name (see JoinRoomResponse).
          const seatedName = res.name ?? name;
          // The server echoes back the same canonical id this normalized —
          // res.roomId only needs to stand in for it against an older server
          // that predates the ack carrying one.
          const canonicalRoomId = res.roomId ?? normalizedRoom;
          // The floor goes with the join, exactly as it does on the automatic
          // rejoin above: the room behind this id may have been recreated
          // since this store last applied a broadcast, and a fresh room's
          // versions start at 1 — every one of them below a carried-over
          // floor, and so dropped as stale.
          set({
            roomId: canonicalRoomId, isHost: res.isHost ?? false, myName: seatedName,
            mode: 'online', isOnline: true, lastAppliedStateVersion: null,
          });
          sessionStore.write(ONLINE_SESSION_KEY, JSON.stringify({ roomId: canonicalRoomId, myName: seatedName }));

          if (res.isHost && !isReconnect && initialConfig) {
            get().addToast(i18n.t('lobby.savedSettingsLoaded'));
          }
        }
        resolve(res);
      });
    });
  },

  leaveRoom: () => {
    const socket = getSocket();
    if (socket) socket.emit('leaveRoom');
    get().stopOnlineTimers();
    sessionStore.remove(ONLINE_SESSION_KEY);
    clearTurnCaches();
    clearPendingPush();
    clearRejoinWatchdog();
    // A join whose ack has not landed yet is abandoned by this leave as surely
    // as the room is — see abandonJoinAttempt.
    abandonJoinAttempt();
    set(clearRoomState());
  },

  kickPlayer: (targetSocketId) => {
    const socket = getSocket();
    if (get().isHost && socket) socket.emit('kickPlayer', targetSocketId);
  },

  // Dedicated low-overhead sibling to pushState, used only for the
  // ~300ms-cadence live dice-roll snapshot (see gameSlice.setLiveTurnState).
  // Sends just this one field instead of the full state bundle pushState
  // gathers below — pushState itself is untouched and still carries
  // liveTurnState as part of the full sync for every other mutation.
  pushLiveTurnState: (snapshot) => {
    const s = get();
    const socket = getSocket();
    if (s.isOnline && socket) {
      socket.emit('liveTurnState', { roomId: s.roomId, liveTurnState: snapshot });
    }
  },

  /**
   * "I have committed to drawing — which card do I get?"
   *
   * The only way an online classic chain reveals a card. It used to be a local
   * `cards.shift()` pushed back as a fait accompli, which meant the answer was
   * sitting in the store — readable in devtools — at the moment the player was
   * deciding whether to risk everything on it. The server holds the deck now
   * and deals from it here (server/socketGameStateHandlers.ts's drawCard).
   *
   * Resolves null rather than rejecting for every way of not getting a card —
   * refused, no socket, or no answer at all. The caller has already committed
   * the tutto by the time it asks, and null is the outcome DiceGame has always
   * known how to take: bank that tutto instead of playing on.
   *
   * The deadline is what makes "no answer at all" an outcome rather than a
   * hang. Without it a dropped ack parks the turn on a decided table with
   * every button disabled, behind a panel that is deliberately
   * non-dismissible — the same dead end DISCARDED_DRAW_RECOVERY_MS exists to
   * get the deferred roll out of.
   */
  requestServerDraw: () => new Promise<CardType | null>(resolve => {
    const s = get();
    const socket = getSocket();
    // `connected`, not just "there is a socket": socket.io BUFFERS an emit made
    // while the transport is down and delivers it on reconnect. For a full
    // snapshot that is merely the wrong recovery (see parkedPush); for a draw
    // it is worse than useless — the panel would have given up and banked the
    // tutto seconds earlier, and the buffered request would then spend a card
    // off the room's deck for a turn that had already ended.
    if (!s.isOnline || !socket || !socket.connected) return resolve(null);

    // One-shot: whichever of the ack and the deadline lands first wins, and
    // the loser must not resolve a promise that has already been answered —
    // a late ack settling a draw the panel has already banked would leave the
    // chain and the room disagreeing about whether a card was ever dealt.
    let settled = false;
    const settle = (card: CardType | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(card);
    };
    const deadline = setTimeout(() => settle(null), DRAW_CARD_ACK_TIMEOUT_MS);

    // The room this draw was asked of. inRoom below only asks whether SOME
    // room is held, which a client that left and joined another one still
    // passes — and the card would then be dealt off the old room's deck into
    // the new room's turn.
    const reqRoomId = s.roomId;
    socket.emit('drawCard', { roomId: reqRoomId }, (ack?: DrawCardAck) => {
      // `settled` as well as the ack itself: an ack that lost the race to the
      // deadline is answering a draw the panel has already banked and moved
      // past, and the write below would then land on the NEXT turn's card.
      // `inRoom` for the same reason every broadcast handler carries it —
      // currentCard is one of STABLE_LOCAL_GAME_KEYS, so writing it after a
      // leave puts a card from a room this client is no longer in into a
      // restored local game, which the persistence subscriber then saves to
      // disk. Unreachable today only because setMode('local') disconnects the
      // socket and socket.io drops pending acks with it; that is a property of
      // the teardown order, not of this callback.
      // No player-index or round check beyond this: the server broadcasts the
      // dealt card BEFORE it acks, so either would drop a legitimately dealt
      // card whenever the broadcast had already moved the store on.
      if (!ack || !ack.ok || settled || !inRoom(get) || get().roomId !== reqRoomId) return settle(null);
      // Adopted locally as well as handed back, so the panel does not have to
      // wait for the broadcast to be applied before it can act on the card.
      // The room's own gameState carries the same card AND the deck it came
      // off, and the server sends it before this ack — so this write is
      // normally a no-op, and is only load-bearing if the two ever land the
      // other way round.
      set({ currentCard: ack.card });
      settle(ack.card);
    });
  }),

  pushState: () => {
    // A newer full snapshot supersedes any retry still queued for an older
    // one (see clearPendingPushRetry) — otherwise that stale resend can land
    // AFTER this push and the server, which tracks no version for pushState
    // payloads by design, would apply it right over the top.
    clearPendingPushRetry();
    const s = get();
    const socket = getSocket();
    if (s.isOnline && socket) {
      const {
        players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
        randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
        previousScore, previousCard, previousLeaders, previousWasBust, previousWasSuccess,
        previousHighestTurnScore,
        previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore,
        previousPlayerName, previousTurnSummary, chartValues, chartNames, chartLabels, status,
        liveTurnState, enforcedDiceMode, ruleset, historyLog,
      } = s;
      const payload: PushStatePayload = {
        roomId: s.roomId,
        newState: {
          players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
          randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
          previousScore, previousCard, previousLeaders, previousWasBust, previousWasSuccess,
          previousHighestTurnScore,
          previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore,
          previousPlayerName, previousTurnSummary, chartValues, chartNames, chartLabels, status,
          liveTurnState, enforcedDiceMode, ruleset, historyLog,
          // The wire payload is the sixth hand-written copy of the synced
          // field set (destructure above + literal here). satisfies makes it
          // the compiler's problem: a canonical key missing here refuses to
          // build, and the shorthand identifiers force the destructure to
          // carry whatever the literal names — without this, a new synced
          // field passed every other lock and still never reached the wire,
          // where applyPushedState's allowlist loop silently dropped it.
          //
          // stateVersion is NOT here on purpose: it is the server's own
          // counter, not a field a client may write.
        } satisfies Record<SyncedGameStateKey, unknown>,
      };

      // Park rather than let socket.io buffer it — see parkedPush for why
      // the library's own buffering is the bug and not the fix. Stamped so
      // the flush can tell a snapshot worth sending from one the room has
      // long since moved past (PARKED_EMIT_MAX_AGE_MS).
      if (!socket.connected) {
        parkedPush = { payload, parkedAt: Date.now() };
        return;
      }
      emitPushState(socket, payload, get, true);
    }
  },

  sendOnlineStats: () => {
    const s = get();
    const socket = getSocket();
    // The payload itself lives in coreGameEngine beside its global
    // counterpart, so the integration suite can build the very same one
    // instead of keeping a copy that drifts.
    const stats = buildDeviceStatsPayload(s.players, s.myName, s.gameTimeInSeconds, s.round);
    // Anything still pending can only belong to an earlier game — this call
    // means a new finish superseded it. Hoisted above the `stats` check:
    // buildDeviceStatsPayload returns null whenever this device holds no seat
    // in the final roster (spectating, or spliced out by a host-failover
    // splice), and a stale park from an earlier finish must not survive a
    // seatless one either — same reason pushState clears its own retry first.
    clearPendingStatsSubmit();
    if (stats && socket) {
      emitStatsSubmission(
        'endGameStats',
        { roomId: s.roomId, deviceId: s.deviceId, stats },
        FIRST_STATS_ATTEMPT,
      );
    }

    if (s.isHost) submitGlobalStats(get);
  },
});
