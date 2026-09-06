import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGameStore, _resetTimersForTests, _resetSocketSliceForTests } from './useGameStore';
import { disconnectSocket } from './socketRef';
import { DEFAULT_INITIAL_CARDS } from '../utils/configValidation';
import { blockStorage, failStorageMethods, restoreStorage } from '../testing/storageStubs';
import { DRAW_CARD_ACK_TIMEOUT_MS, JOIN_TIMEOUT_MS, PUSH_REJOIN_RACE_WINDOW_MS, PUSH_REJOIN_RETRY_DELAY_MS, STATS_SUBMIT_ACK_TIMEOUT_MS } from '../utils/uiTimings';
import { STATS_SUBMIT_MAX_ATTEMPTS, statsSubmitRetryDelayMs, isRetryableStatsRefusal, PARKED_EMIT_MAX_AGE_MS } from './socketSlice';
import { STATS_REFUSAL_REASONS, MAX_HISTORY_LOG_SIZE } from '../types';
import type { DiceSnapshot, StatsSubmitAck, Player } from '../types';
import type { GameStore, JoinRoomResponse } from './storeTypes';
import { makePlayer as makeFullPlayer, mockFetchJson, nonNull } from '../testing/factories';

let mockEmit = vi.fn();
// A handler registered via the mock socket's `on(event, handler)` — same
// loose shape vitest/socket.io-client itself uses for a listener, which is
// all this file needs: every mockOnHandlers['x'](...) call site already
// passes whatever payload shape that event carries.
type SocketEventHandler = (...args: unknown[]) => void;
let mockOnHandlers: Record<string, SocketEventHandler> = {};
// The mock socket's transport state. socketSlice's pushState parks its payload
// while the socket is down and flushes it after the rejoin, so the tests for
// that path have to be able to take the socket offline. A getter keeps the
// one object io() handed out in step with this flag.
let mockSocketConnected = true;
const mockDisconnect = vi.fn();

vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => ({
      on: (event: string, handler: SocketEventHandler) => {
        mockOnHandlers[event] = handler;
      },
      emit: mockEmit,
      off: vi.fn(),
      disconnect: mockDisconnect,
      id: 'socket-123',
      get connected() { return mockSocketConnected; },
    }))
  };
});

// Which events the mock socket was asked to emit, in order. Negative
// assertions go through this rather than not.toHaveBeenCalledWith(event, ...):
// that matcher compares the full argument list, so it silently starts passing
// the moment an emit grows an argument (an ack callback, say).
const emittedEvents = (): unknown[] => mockEmit.mock.calls.map(([event]) => event);

// What socketSlice's `inRoom` guard requires before ANY server->client handler
// will apply its event: a room, in online mode. Tests that drive a handler
// directly have to look like a seated client, or the guard drops the event the
// same way it drops a broadcast that lands after a leave.
const seatedInRoom = { mode: 'online' as const, isOnline: true, roomId: 'ROOM1' };

// Minimal player stand-ins for tests that only ever read `name`.
const namedPlayers = (...names: string[]): Player[] =>
  names.map(name => ({ name }) as unknown as Player);

// Thin, name-first adapter over the shared factory — keeps every existing
// `makeOnlinePlayer('Alice', { score: 500 })` call site unchanged while
// returning a real, fully-typed Player (every counter zeroed) instead of a
// hand-rolled partial literal.
const makeOnlinePlayer = (name: string, overrides: Partial<Player> = {}): Player =>
  makeFullPlayer({ name, socketId: `sock-${name}`, deviceId: `dev-${name}`, ...overrides });

// gameTimeInSeconds is declared as a plain `number` (CoreGameState), so
// Partial<GameStore> narrows it to `number | undefined` — but a value
// restored from localStorage or an untyped push can genuinely be `null`
// (timers.ts defensively checks `!== null` for exactly this), and the two
// tests below deliberately drive that runtime-only case.
const setStateWithNullableGameTime = useGameStore.setState as (
  partial: Partial<Omit<GameStore, 'gameTimeInSeconds'>> & { gameTimeInSeconds?: number | null }
) => void;

// A full DiceSnapshot with the mid-turn fields (kniffelProgress, tuttosThisTurn)
// most of these tests never look at — they only care about turnScore/keptDice/
// currentRoll surviving a round trip.
const makeSnapshot = (overrides: Partial<DiceSnapshot> = {}): DiceSnapshot => ({
  turnScore: 0,
  keptDice: [],
  currentRoll: [],
  kniffelProgress: [],
  tuttosThisTurn: 0,
  ...overrides,
});

describe('useGameStore', () => {
  beforeEach(() => {
    // Reset state before each test
    useGameStore.getState().reset();
    // reset() only resets Zustand state — the module-level gameTimerInterval/
    // turnTimerInterval aren't part of that state, so a timer started in one
    // test can otherwise keep firing into the next (vitest caches the module
    // between test cases within the same file).
    _resetTimersForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockEmit.mockClear();
    mockSocketConnected = true;
    // Two module singletons outlive reset(): the socket in socketRef.ts
    // (connectSocket is a no-op while one exists, so a later joinRoom test
    // would never see io() called) and socketSlice's pending cancelReconnect
    // cleanup (invoked by the next cancelReconnect, whose disconnect
    // assertions then count a stranger's teardown). Both showed up as
    // order-dependent failures under --sequence.shuffle.
    mockOnHandlers = {};
    disconnectSocket();
    _resetSocketSliceForTests();
  });

  describe('default deck isolation', () => {
    // configValidation.ts states the rule outright: consumers that keep these
    // defaults in mutable state must copy them. Handing the store the shared
    // object means any in-place write — from any path Immer does not own —
    // silently rewrites the defaults for the whole app for the rest of the
    // session, and every later "reset to defaults" lands on the corrupted deck.
    // setMode already copies; the initial state and reset() did not.
    it('does not alias the shared DEFAULT_INITIAL_CARDS object', () => {
      expect(useGameStore.getState().initialCards).toEqual(DEFAULT_INITIAL_CARDS);
      expect(useGameStore.getState().initialCards).not.toBe(DEFAULT_INITIAL_CARDS);
    });

    it('gives each reset its own copy', () => {
      const before = useGameStore.getState().initialCards;
      useGameStore.getState().reset();
      const after = useGameStore.getState().initialCards;

      expect(after).toEqual(DEFAULT_INITIAL_CARDS);
      expect(after).not.toBe(DEFAULT_INITIAL_CARDS);
      expect(after).not.toBe(before);
    });

    // Same hazard, the four collections initialCards was fixed alongside. They
    // are array literals built once at module load and spread into every reset,
    // so all resets share them. Immer's copy-on-write hides it today; a single
    // push outside a producer would corrupt the defaults for the session.
    it('gives each reset its own collections, not the module-level literals', () => {
      useGameStore.getState().reset();
      const first = useGameStore.getState();
      const before = {
        chartValues: first.chartValues,
        chartNames: first.chartNames,
        chartLabels: first.chartLabels,
        historyLog: first.historyLog,
      };

      useGameStore.getState().reset();
      const after = useGameStore.getState();

      expect(after.chartValues).not.toBe(before.chartValues);
      expect(after.chartNames).not.toBe(before.chartNames);
      expect(after.chartLabels).not.toBe(before.chartLabels);
      expect(after.historyLog).not.toBe(before.historyLog);
      expect(after.chartValues).toEqual([]);
      expect(after.historyLog).toEqual([]);
    });
  });

  describe('_resetTimersForTests', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops a running local game timer so it no longer fires after reset', () => {
      useGameStore.setState({
        mode: 'local', currentPlayerIndex: 0, finished: false, gameStartTime: Date.now(),
      });
      useGameStore.getState().startLocalTimers();

      vi.advanceTimersByTime(1000);
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThan(0);

      _resetTimersForTests();
      const snapshot = useGameStore.getState().gameTimeInSeconds;

      // Without the reset, this tick would have updated gameTimeInSeconds again.
      vi.advanceTimersByTime(5000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(snapshot);
    });
  });

  it('initializes with default local state', () => {
    const state = useGameStore.getState();
    expect(state.mode).toBe('local');
    expect(state.isOnline).toBe(false);
    expect(state.players).toEqual([]);
    expect(state.round).toBe(1);
  });

  it('initializes from localStorage if available', () => {
    const storedState = { players: [{ name: 'Alice', color: '#ff0000', score: 100 }], round: 3 };
    localStorage.setItem('tutto_local_game', JSON.stringify(storedState));
    localStorage.setItem('tutto_diceMode', 'digital');

    useGameStore.getState().init('device-123');
    const state = useGameStore.getState();

    expect(state.deviceId).toBe('device-123');
    expect(state.players.length).toBe(1);
    expect(state.players[0].name).toBe('Alice');
    expect(state.round).toBe(3);
    expect(state.diceMode).toBe('digital');
  });

  it('defaults diceMode to digital, and falls back to it when the stored value is invalid', () => {
    // A fresh store (no tutto_diceMode key at all) must default to digital.
    expect(useGameStore.getState().diceMode).toBe('digital');

    localStorage.setItem('tutto_diceMode', 'not-a-real-mode');
    useGameStore.getState().init('device-123');
    expect(useGameStore.getState().diceMode).toBe('digital');
  });

  it('does not let a corrupted local-game save clobber a store action', () => {
    // Object.assign'ing an unvalidated parsed save into state could overwrite
    // an action (e.g. startGame) with whatever value the save file held.
    localStorage.setItem('tutto_local_game', JSON.stringify({ round: 3, startGame: 'not a function anymore' }));
    useGameStore.getState().init('device-123');
    expect(useGameStore.getState().round).toBe(3);
    expect(typeof useGameStore.getState().startGame).toBe('function');
  });

  it('ignores a non-object localStorage value instead of corrupting state', () => {
    // A valid-JSON-but-not-an-object value (e.g. a leftover string) must not be
    // Object.assign'd into state. Previously JSON.parse('"corrupt"') → "corrupt"
    // would spread string indices into the store.
    localStorage.setItem('tutto_local_game', '"corrupt"');
    useGameStore.getState().init('device-123');
    const state = useGameStore.getState();
    expect(state.players).toEqual([]);
    expect(state.deviceId).toBe('device-123');
  });

  it('re-anchors the game clock when restoring an in-progress local game', () => {
    // Saved games persist elapsed seconds, not an absolute start time. Restoring an
    // in-progress game must re-anchor gameStartTime so the timer continues instead of
    // freezing (regression: gameStartTime stayed null → tick no-ops → clock frozen).
    const storedState = {
      players: [{ name: 'Alice', color: '#ff0000', score: 100 }, { name: 'Bob', color: '#00ff00', score: 50 }],
      status: 'playing',
      currentPlayerIndex: 0,
      finished: false,
      round: 2,
      gameTimeInSeconds: 50,
    };
    localStorage.setItem('tutto_local_game', JSON.stringify(storedState));

    const before = Date.now();
    useGameStore.getState().init('device-xyz');
    const state = useGameStore.getState();

    expect(state.gameStartTime).not.toBeNull();
    // Anchored to ~now - 50s, so the derived elapsed continues from ~50.
    const elapsed = Math.floor((before - (state.gameStartTime as number)) / 1000);
    expect(elapsed).toBeGreaterThanOrEqual(49);
    expect(elapsed).toBeLessThanOrEqual(51);
  });

  it('startGame refuses to start an online game below the player minimum', () => {
    // The lobby enforces two players; the end screen's Play Again reaches
    // startGame directly, so the store must hold the same line after
    // opponents have left the finished room.
    useGameStore.setState({
      mode: 'online', isOnline: true, isHost: true, status: 'playing', finished: true,
      round: 7,
      players: [makeOnlinePlayer('Alice', { score: 10000, position: 1 })],
    });

    useGameStore.getState().startGame();

    // Refused: the finished game stays finished, nothing resets.
    expect(useGameStore.getState().finished).toBe(true);
    expect(useGameStore.getState().round).toBe(7);
  });

  it('resuming a mid-game local save also restarts the 1-second game clock', () => {
    // App routes a restored playing save straight into <Game/> — so
    // setMode('local'), the only other startLocalTimers caller besides
    // startGame, never runs on that path. Without init starting the interval
    // itself, the displayed clock stays frozen at the saved value and the
    // NEXT reload re-anchors from that stale number, silently discarding all
    // the time played since this one.
    vi.useFakeTimers();
    try {
      localStorage.setItem('tutto_local_game', JSON.stringify({
        players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
        status: 'playing',
        currentPlayerIndex: 0,
        finished: false,
        round: 2,
        gameTimeInSeconds: 50,
      }));
      useGameStore.getState().init('device-xyz');

      vi.advanceTimersByTime(3000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(53);
    } finally {
      _resetTimersForTests();
      vi.useRealTimers();
    }
  });

  it('does not restore the saved local game over a join link, and leaves the save on disk', () => {
    // A join link switches the client to online play before init() ever runs:
    // <Home/> mounts on App's first render and its link effect flushes ahead
    // of App's own (child effects run first). Restoring the saved game on top
    // of that routes App straight into <Game/>, unmounting the lobby the
    // invitation was meant to fill in.
    const savedGame = JSON.stringify({
      players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
      status: 'playing', currentPlayerIndex: 0, finished: false, round: 2, gameTimeInSeconds: 50,
    });
    localStorage.setItem('tutto_local_game', savedGame);
    useGameStore.setState({ mode: 'online' });

    useGameStore.getState().init('device-xyz');

    const state = useGameStore.getState();
    expect(state.deviceId).toBe('device-xyz');
    expect(state.players).toEqual([]);
    expect(state.currentPlayerIndex).toBeNull();
    expect(state.round).toBe(1);
    // The game is postponed, not lost — setMode('local') restores it later.
    expect(localStorage.getItem('tutto_local_game')).toBe(savedGame);
  });

  it('does not re-anchor the clock when the restored local game is not in progress', () => {
    localStorage.setItem('tutto_local_game', JSON.stringify({
      players: [{ name: 'Alice', color: '#ff0000', score: 0 }],
      status: 'lobby',
      currentPlayerIndex: null,
      finished: false,
      gameTimeInSeconds: 0,
    }));
    useGameStore.getState().init('device-xyz');
    expect(useGameStore.getState().gameStartTime).toBeNull();
  });

  describe("setMode('local') and the 1s game clock", () => {
    // Home calls setMode('local') on mount with no game running at all — that
    // used to start the 1s interval unconditionally, leaving it ticking
    // (harmlessly no-op'ing on every tick, but never stopped) for as long as
    // the player sits on the menu. The clock should only start when a game
    // actually starts (startGame) or an in-progress local game is restored.
    it('with no local game running, does not start the 1s game clock', () => {
      localStorage.removeItem('tutto_local_game');
      useGameStore.setState({ mode: 'online' });
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      useGameStore.getState().setMode('local');

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    // A saved local game restored via setMode (e.g. a room's setMode('local')
    // fallback finding a mid-game save on disk) must still get its clock
    // going, exactly like init() already does for the direct-into-<Game/> path
    // (see 'resuming a mid-game local save also restarts the 1-second game
    // clock' above).
    it('restoring an in-progress local save starts the clock and it actually ticks', () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem('tutto_local_game', JSON.stringify({
          players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
          status: 'playing',
          currentPlayerIndex: 0,
          finished: false,
          round: 2,
          gameTimeInSeconds: 50,
        }));
        useGameStore.setState({ mode: 'online' });

        useGameStore.getState().setMode('local');
        vi.advanceTimersByTime(3000);

        expect(useGameStore.getState().gameTimeInSeconds).toBe(53);
      } finally {
        _resetTimersForTests();
        vi.useRealTimers();
      }
    });

    it('a save that is not in progress (lobby) does not start the clock either', () => {
      localStorage.setItem('tutto_local_game', JSON.stringify({
        players: [{ name: 'Alice', color: '#ff0000', score: 0 }],
        status: 'lobby',
        currentPlayerIndex: null,
        finished: false,
        gameTimeInSeconds: 0,
      }));
      useGameStore.setState({ mode: 'online' });
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      useGameStore.getState().setMode('local');

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });
  });

  it('does not rewrite localStorage on a pure game-timer tick, but does on a real change', () => {
    useGameStore.getState().addPlayer('Alice');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    // Simulate a 1s timer tick: only gameTimeInSeconds changes → must NOT persist.
    useGameStore.setState({ gameTimeInSeconds: 999 });
    const writesAfterTick = setItemSpy.mock.calls.filter(c => c[0] === 'tutto_local_game').length;
    expect(writesAfterTick).toBe(0);

    // A real state change (new player) must persist.
    useGameStore.getState().addPlayer('Bob');
    const writesAfterChange = setItemSpy.mock.calls.filter(c => c[0] === 'tutto_local_game').length;
    expect(writesAfterChange).toBeGreaterThan(0);

    setItemSpy.mockRestore();
  });

  it('persists previousWasBust/previousHighestTurnScore so undo after a reload stays accurate', () => {
    // calculateUndo reads both fields to revert bust counters and restore the
    // player's highestTurnScore. previousCard IS persisted (so undo stays
    // available after a reload) — if these two are dropped from the save, a
    // post-reload undo resets highestTurnScore to 0 and never reverts busts.
    useGameStore.setState({
      mode: 'local', status: 'playing',
      players: [{ ...namedPlayers('Alice')[0], score: 500, busts: 1, highestTurnScore: 800 }],
      currentPlayerIndex: 0, previousCard: '200', previousScore: 0,
      previousWasBust: true, previousHighestTurnScore: 800,
    });

    const savedRaw = localStorage.getItem('tutto_local_game')!;
    const saved = JSON.parse(savedRaw);
    expect(saved.previousWasBust).toBe(true);
    expect(saved.previousHighestTurnScore).toBe(800);

    // Simulate the reload: fresh store state, then init() restores the save.
    // reset() itself re-triggers the persistence subscriber (a real reload
    // doesn't — the page is gone), so put the on-disk save back before init.
    useGameStore.getState().reset();
    localStorage.setItem('tutto_local_game', savedRaw);
    useGameStore.getState().init('device-123');

    expect(useGameStore.getState().previousWasBust).toBe(true);
    expect(useGameStore.getState().previousHighestTurnScore).toBe(800);
  });

  it('persists previousHighestFeuerwerkTurnScore/previousHighestX2TurnScore so undo after a reload stays accurate', () => {
    // Same hazard as the previousHighestTurnScore test above, but for the
    // Feuerwerk/x2 siblings: calculateUndo restores
    // highestFeuerwerkTurnScore/highestX2TurnScore from these two fields, so
    // dropping them from the save resets both to 0 on a post-reload undo.
    useGameStore.setState({
      mode: 'local', status: 'playing',
      players: [{ ...namedPlayers('Alice')[0], score: 500, highestFeuerwerkTurnScore: 900, highestX2TurnScore: 700 }],
      currentPlayerIndex: 0, previousCard: 'Feuerwerk', previousScore: 300,
      previousHighestFeuerwerkTurnScore: 600, previousHighestX2TurnScore: 700,
    });

    const savedRaw = localStorage.getItem('tutto_local_game')!;
    const saved = JSON.parse(savedRaw);
    expect(saved.previousHighestFeuerwerkTurnScore).toBe(600);
    expect(saved.previousHighestX2TurnScore).toBe(700);

    useGameStore.getState().reset();
    localStorage.setItem('tutto_local_game', savedRaw);
    useGameStore.getState().init('device-123');

    expect(useGameStore.getState().previousHighestFeuerwerkTurnScore).toBe(600);
    expect(useGameStore.getState().previousHighestX2TurnScore).toBe(700);
  });

  it('nextTurn propagates previousHighestFeuerwerkTurnScore/X2TurnScore so a subsequent undo restores them instead of zeroing them (regression for STORE-BUG-1)', () => {
    useGameStore.setState({
      mode: 'local', status: 'playing', finished: false,
      players: [
        { ...namedPlayers('Alice')[0], score: 500, highestFeuerwerkTurnScore: 900 },
        { ...namedPlayers('Bob')[0], score: 200 },
      ],
      currentPlayerIndex: 0, currentCard: 'Feuerwerk', cards: ['200'],
      initialCards: { '200': 5 }, round: 1,
    });

    // Alice takes a 300-point Feuerwerk turn — below her existing 900 record,
    // so highestFeuerwerkTurnScore must stay 900, and the store must remember
    // that prior 900 so undo can restore it correctly.
    useGameStore.getState().nextTurn(300, true);
    expect(useGameStore.getState().previousHighestFeuerwerkTurnScore).toBe(900);

    useGameStore.getState().undo();
    expect(useGameStore.getState().players[0].highestFeuerwerkTurnScore).toBe(900);
  });

  it('adds and removes players', () => {
    useGameStore.getState().addPlayer('Player 1');
    useGameStore.getState().addPlayer('Player 2');

    let state = useGameStore.getState();
    expect(state.players.length).toBe(2);
    expect(state.players[0].name).toBe('Player 1');
    expect(state.players[0].color).toBeDefined();

    useGameStore.getState().removePlayer('Player 1');
    state = useGameStore.getState();
    expect(state.players.length).toBe(1);
    expect(state.players[0].name).toBe('Player 2');
  });

  it('updates configuration', () => {
    useGameStore.getState().setWinningScore(8000);
    useGameStore.getState().setTurnDuration(60);
    useGameStore.getState().setRandomOrder(false);

    const state = useGameStore.getState();
    expect(state.winningScore).toBe(8000);
    expect(state.turnDuration).toBe(60);
    expect(state.randomOrder).toBe(false);
  });

  it('updateConfig drops out-of-range/invalid values instead of applying them (STORE-SMELL-4)', () => {
    useGameStore.setState({ winningScore: 6000, turnDuration: 120 });

    // NaN/-5 are runtime-invalid, not type-invalid (updateConfig takes plain
    // numbers) — the guard under test rejects them at the value level.
    useGameStore.getState().updateConfig({ winningScore: NaN, turnDuration: -5 });

    const state = useGameStore.getState();
    expect(state.winningScore).toBe(6000);
    expect(state.turnDuration).toBe(120);
  });

  describe('configSlice remaining setters and resets', () => {
    it('setDiceMode updates state and persists to localStorage', () => {
      useGameStore.getState().setDiceMode('digital');
      expect(useGameStore.getState().diceMode).toBe('digital');
      expect(localStorage.getItem('tutto_diceMode')).toBe('digital');
    });

    it('a dice mode chosen while online survives the switch back to local', () => {
      // The local persistence subscriber is inert while online, so the saved
      // game keeps whatever mode it was written with. setMode('local') applies
      // that save and does not re-read tutto_diceMode, so carrying diceMode in
      // the save silently reverted the player's live choice.
      localStorage.setItem('tutto_local_game', JSON.stringify({ round: 2, diceMode: 'digital' }));
      useGameStore.setState({ mode: 'online', isOnline: true });

      useGameStore.getState().setDiceMode('physical');
      useGameStore.getState().setMode('local');

      expect(useGameStore.getState().diceMode).toBe('physical');
      expect(localStorage.getItem('tutto_diceMode')).toBe('physical');
    });

    it('setDiceMode does not touch enforcedDiceMode while offline or not enforcing', () => {
      useGameStore.getState().setDiceMode('digital');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();

      useGameStore.setState({ isOnline: true, isHost: true, enforcedDiceMode: null });
      useGameStore.getState().setDiceMode('physical');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setDiceMode follows the host\'s new choice while enforcement is active', () => {
      // While the host is enforcing a mode, their own DiceModeSelector doubles
      // as "which mode to enforce" — the enforced value must track it live
      // instead of requiring the host to re-toggle the checkbox.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ isOnline: true, isHost: true, roomId: 'ROOM1', enforcedDiceMode: 'digital' });
      mockEmit.mockClear();

      useGameStore.getState().setDiceMode('physical');

      expect(useGameStore.getState().diceMode).toBe('physical');
      expect(useGameStore.getState().enforcedDiceMode).toBe('physical');
      const call = mockEmit.mock.calls.find(c => c[0] === 'updateConfig');
      expect(call?.[1]).toMatchObject({ enforcedDiceMode: 'physical' });
    });

    it('setDiceMode does not follow for a non-host client even while enforcedDiceMode is set', () => {
      useGameStore.setState({ isOnline: true, isHost: false, enforcedDiceMode: 'digital' });
      useGameStore.getState().setDiceMode('physical');
      expect(useGameStore.getState().enforcedDiceMode).toBe('digital');
    });

    it('setEnforcedDiceMode toggles enforcement on and off', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ isOnline: true, isHost: true, roomId: 'ROOM1' });
      mockEmit.mockClear();

      useGameStore.getState().setEnforcedDiceMode('digital');
      expect(useGameStore.getState().enforcedDiceMode).toBe('digital');

      useGameStore.getState().setEnforcedDiceMode(null);
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setAudioEnabled updates state and persists to localStorage', () => {
      useGameStore.getState().setAudioEnabled(false);
      expect(useGameStore.getState().audioEnabled).toBe(false);
      expect(localStorage.getItem('tutto_audioEnabled')).toBe('false');
    });

    it('setHapticsEnabled updates state and persists to localStorage', () => {
      useGameStore.getState().setHapticsEnabled(false);
      expect(useGameStore.getState().hapticsEnabled).toBe(false);
      expect(localStorage.getItem('tutto_hapticsEnabled')).toBe('false');
    });

    it('setMotionOverride updates state and persists to localStorage', () => {
      useGameStore.getState().setMotionOverride(true);
      expect(useGameStore.getState().motionOverride).toBe(true);
      expect(localStorage.getItem('tutto_motionOverride')).toBe('true');
    });

    it('setInitialCards updates the deck composition', () => {
      const newCards = { Stop: 20, Kniffel: 0 };
      useGameStore.getState().setInitialCards(newCards as never);
      expect(useGameStore.getState().initialCards).toEqual(newCards);
    });

    it('setReconnectTimeout updates the kick timer', () => {
      useGameStore.getState().setReconnectTimeout(45);
      expect(useGameStore.getState().reconnectTimeout).toBe(45);
    });

    it('resetGeneralSettings restores winningScore/randomOrder/turnDuration/reconnectTimeout to defaults', () => {
      useGameStore.setState({ winningScore: 9999, randomOrder: false, turnDuration: 30, reconnectTimeout: 10 });
      useGameStore.getState().resetGeneralSettings();

      const state = useGameStore.getState();
      expect(state.winningScore).toBe(6000);
      expect(state.randomOrder).toBe(true);
      expect(state.turnDuration).toBe(120);
      expect(state.reconnectTimeout).toBe(60);
    });

    it('resetInitialCards restores the default deck each time it is called', () => {
      useGameStore.setState({ initialCards: { Stop: 0 } as never });
      useGameStore.getState().resetInitialCards();
      expect(useGameStore.getState().initialCards.Stop).toBe(10);

      // A second reset from a different tampered state must still land on the
      // same defaults — proving each call spreads a fresh copy rather than
      // handing out (and risking corruption of) the shared default object.
      useGameStore.setState({ initialCards: { Stop: 77 } as never });
      useGameStore.getState().resetInitialCards();
      expect(useGameStore.getState().initialCards.Stop).toBe(10);
    });

    it('updateConfig emits updateConfig over the socket only when online AND host AND a roomId exists', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      mockEmit.mockClear();

      // Online but not host — must not emit.
      useGameStore.setState({ isOnline: true, isHost: false, roomId: 'ROOM1' });
      useGameStore.getState().setWinningScore(7000);
      expect(emittedEvents()).not.toContain('updateConfig');

      // Host but not online (e.g. local mode) — must not emit.
      useGameStore.setState({ isOnline: false, isHost: true, roomId: 'ROOM1' });
      useGameStore.getState().setWinningScore(7100);
      expect(emittedEvents()).not.toContain('updateConfig');

      // Online + host but no roomId — must not emit.
      useGameStore.setState({ isOnline: true, isHost: true, roomId: null });
      useGameStore.getState().setWinningScore(7200);
      expect(emittedEvents()).not.toContain('updateConfig');

      // Online + host + roomId — must emit the full config snapshot.
      useGameStore.setState({
        isOnline: true, isHost: true, roomId: 'ROOM1',
        initialCards: { Stop: 5 } as never, randomOrder: false, turnDuration: 45, reconnectTimeout: 20,
      });
      useGameStore.getState().setWinningScore(7300);
      expect(mockEmit).toHaveBeenCalledWith('updateConfig', {
        roomId: 'ROOM1',
        winningScore: 7300,
        initialCards: { Stop: 5 },
        randomOrder: false,
        turnDuration: 45,
        reconnectTimeout: 20,
        enforcedDiceMode: null,
        ruleset: 'modernized',
      });

      disconnectSocket();
    });
  });

  it('changes player color locally', () => {
    useGameStore.getState().addPlayer('Alice');
    useGameStore.getState().changePlayerColor('Alice', '#FFFFFF');

    const state = useGameStore.getState();
    expect(state.players[0].color).toBe('#FFFFFF');
  });

  it('changes myColor and saves to localStorage', () => {
    useGameStore.setState({ myName: 'Bob' });
    useGameStore.getState().addPlayer('Bob');
    useGameStore.getState().changeMyColor('#123456');

    const state = useGameStore.getState();
    expect(state.players[0].color).toBe('#123456');
    expect(localStorage.getItem('tutto_color')).toBe('#123456');
  });

  it('sendReaction emits over the socket when online with a room', () => {
    useGameStore.getState().connectSocket('http://localhost:3000');
    useGameStore.setState({ isOnline: true, roomId: 'ROOM1' });
    mockEmit.mockClear();

    useGameStore.getState().sendReaction('🔥');

    expect(mockEmit).toHaveBeenCalledWith('sendReaction', { emoji: '🔥' });
    disconnectSocket();
  });

  it('sendReaction does nothing for local (non-online) games', () => {
    useGameStore.getState().connectSocket('http://localhost:3000');
    useGameStore.setState({ isOnline: false });
    mockEmit.mockClear();

    useGameStore.getState().sendReaction('🔥');

    expect(emittedEvents()).not.toContain('sendReaction');
    disconnectSocket();
  });

  it('removeReaction filters the reaction out of state', () => {
    useGameStore.setState({
      reactions: [
        { id: 1, emoji: '🔥', senderName: 'Alice' },
        { id: 2, emoji: '❤️', senderName: 'Bob' },
      ],
    });

    useGameStore.getState().removeReaction(1);

    expect(useGameStore.getState().reactions).toEqual([{ id: 2, emoji: '❤️', senderName: 'Bob' }]);
  });

  it('starts local game', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    
    useGameStore.getState().startGame();

    const state = useGameStore.getState();
    expect(state.status).toBe('playing');
    expect(state.currentPlayerIndex).toBeGreaterThanOrEqual(0); // If randomOrder is true, it might be 0 or 1
    expect(state.round).toBe(1);
    expect(state.gameTimeInSeconds).toBe(0);
    expect(state.finished).toBe(false);
  });

  it('deals the initial deck with the same MAX_CLUSTER constraint mid-game rebuilds use', () => {
    // The opening deal used to be a plain shuffle, so a game could start with a
    // 4+ run of one card that buildDeck forbids everywhere else. currentCard is
    // drawn from the deck's head, so it counts toward the leading run.
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    useGameStore.setState({ initialCards: { Stop: 30, x2: 20 } });

    for (let attempt = 0; attempt < 10; attempt++) {
      useGameStore.getState().startGame();
      const state = useGameStore.getState();
      const fullDeck = [state.currentCard, ...state.cards];

      expect(fullDeck).toHaveLength(50);
      expect(fullDeck.filter(c => c === 'Stop')).toHaveLength(30);
      expect(fullDeck.filter(c => c === 'x2')).toHaveLength(20);

      let cluster = 1;
      for (let i = 1; i < fullDeck.length; i++) {
        cluster = fullDeck[i] === fullDeck[i - 1] ? cluster + 1 : 1;
        expect(cluster).toBeLessThanOrEqual(3);
      }
    }
  });

  it('processes nextTurn', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    useGameStore.setState({ status: 'playing', currentPlayerIndex: 0, round: 1 });
    
    // Simulate a successful turn
    useGameStore.getState().nextTurn(500, true);

    const state = useGameStore.getState();
    expect(state.previousCard).toBeDefined();
    // It should move to next player since it's a success
    expect(state.currentPlayerIndex).toBe(1);
    expect(state.players[0].score).toBe(500);
  });

  it('processes undo', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.setState({ 
      status: 'playing', 
      currentPlayerIndex: 1,
      previousCard: 'x2',
      previousScore: 0,
      previousLeaders: [],
      previousPlayerName: 'P1',
      players: [makeOnlinePlayer('P1', { score: 500 }), makeOnlinePlayer('P2')]
    });

    useGameStore.getState().undo();

    const state = useGameStore.getState();
    // It should revert back to P1
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.previousCard).toBeNull();
  });

  it('appends history log on nextTurn and pops on undo', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    useGameStore.setState({
      status: 'playing',
      currentPlayerIndex: 0,
      round: 1,
      currentCard: '300',
      historyLog: []
    });

    useGameStore.getState().nextTurn(500, true);
    let state = useGameStore.getState();
    expect(state.historyLog.length).toBe(1);
    expect(state.historyLog[0].playerName).toBe('P1');
    expect(state.historyLog[0].type).toBe('success');
    expect(state.historyLog[0].score).toBe(500);

    // Let's set up undo-able turn state
    useGameStore.setState({
      previousCard: '300',
      previousScore: 500,
      previousLeaders: [],
      previousPlayerName: 'P1',
      currentPlayerIndex: 1,
      round: 1,
      players: [makeOnlinePlayer('P1', { score: 500 }), makeOnlinePlayer('P2')]
    });

    useGameStore.getState().undo();
    state = useGameStore.getState();
    expect(state.historyLog.length).toBe(0);
  });

  it('caps historyLog at MAX_HISTORY_LOG_SIZE', () => {
    const log = Array.from({ length: 50 }, (_, i) => ({
      id: `rnd-P1-${i}`,
      round: 1,
      playerName: 'P1',
      card: '300' as const,
      type: 'success' as const,
      score: 100,
    }));
    useGameStore.getState().addPlayer('P1');
    useGameStore.setState({
      status: 'playing',
      currentPlayerIndex: 0,
      round: 1,
      currentCard: '300',
      historyLog: log,
    });

    useGameStore.getState().nextTurn(100, true);
    const state = useGameStore.getState();
    expect(state.historyLog.length).toBe(50);
    // The oldest entry should have been shifted out
    expect(state.historyLog[0].id).toBe('rnd-P1-1');
    expect(state.historyLog[49].id).toBe('1-P1-1');
  });

  // Pins the known asymmetry between the two ends of a full log: nextTurn
  // shifts the oldest entry off to stay under the cap, and undo only pops the
  // newest, so the shifted one cannot come back. Accepted rather than fixed —
  // see the comments at both sites (gameSlice's nextTurn and undo). The log is
  // rendered and never read back into game logic, and the next capped turn
  // re-establishes the same window, so the loss is display-only and
  // self-correcting. Raising MAX_HISTORY_LOG_SIZE is NOT the fix: it is one of
  // the dimensions MAX_PUSHED_STATE_BYTES was measured against.
  it('undo cannot bring back the history entry the cap already shifted off', () => {
    const log = Array.from({ length: MAX_HISTORY_LOG_SIZE }, (_, i) => ({
      id: `old-${i}`,
      round: 1,
      playerName: 'P1',
      card: '300' as const,
      type: 'success' as const,
      score: 100,
    }));
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    useGameStore.setState({
      status: 'playing', currentPlayerIndex: 0, round: 1, currentCard: '300', historyLog: log,
    });

    useGameStore.getState().nextTurn(500, true);
    expect(useGameStore.getState().historyLog[0].id, 'the cap shifted the oldest entry off').toBe('old-1');

    useGameStore.setState({
      previousCard: '300', previousScore: 500, previousLeaders: [], previousPlayerName: 'P1',
      currentPlayerIndex: 1, round: 1,
      players: [makeOnlinePlayer('P1', { score: 500 }), makeOnlinePlayer('P2')],
    });
    useGameStore.getState().undo();

    const restored = useGameStore.getState().historyLog;
    expect(restored).toHaveLength(MAX_HISTORY_LOG_SIZE - 1);
    expect(restored.some(entry => entry.id === 'old-0'), 'undo pops the newest, never the shifted one').toBe(false);
  });

  it('undo clears the current player\'s live dice snapshot and cache, not just the previous-turn bookkeeping', () => {
    // Undo can be triggered while the CURRENT player is mid-roll (digital dice).
    // Without clearing liveTurnState/the localStorage cache too, spectators keep
    // seeing that in-progress roll attributed to whoever undo reassigns the turn
    // to, and a stale snapshot could be resumed into their next turn.
    useGameStore.getState().addPlayer('P1');
    const liveSnapshot = { turnScore: 250, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(liveSnapshot));
    useGameStore.setState({
      status: 'playing',
      currentPlayerIndex: 1,
      previousCard: 'x2',
      previousScore: 0,
      previousLeaders: [],
      previousPlayerName: 'P1',
      players: [makeOnlinePlayer('P1', { score: 500 }), makeOnlinePlayer('P2')],
      liveTurnState: liveSnapshot,
    });

    useGameStore.getState().undo();

    const state = useGameStore.getState();
    expect(state.liveTurnState).toBeNull();
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
  });

  it('undo returns the whole in-progress classic chain to the deck, not just the card in play', () => {
    // The engine can only do this if the store hands it liveTurnState (it is
    // not part of CoreGameState — see UndoInputState in coreGameEngine.ts).
    // P2 is mid-chain: the turn opened on 300 and drew Kniffel then 400, so
    // three cards left the deck and all three have to come back, in order.
    useGameStore.getState().addPlayer('P1');
    useGameStore.setState({
      status: 'playing',
      currentPlayerIndex: 1,
      currentCard: '400',
      cards: ['600', 'Kleeblatt'],
      previousCard: 'x2',
      previousScore: 0,
      previousLeaders: [],
      previousPlayerName: 'P1',
      players: [makeOnlinePlayer('P1', { score: 500 }), makeOnlinePlayer('P2')],
      liveTurnState: {
        turnScore: 900, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
        cardsThisTurn: ['300', 'Kniffel', '400'],
      },
    });

    useGameStore.getState().undo();

    const state = useGameStore.getState();
    expect(state.currentCard).toBe('x2');
    expect(state.cards).toEqual(['300', 'Kniffel', '400', '600', 'Kleeblatt']);
  });

  it('starting a new game clears BOTH cached turn entries, digital and physical', () => {
    // A Play-Again (or any new local game) resets round to 1 with the same
    // room and ruleset — a chain cached by the PREVIOUS game could otherwise
    // key-collide and resurrect its cards and typed total into the new one.
    // The digital cache has always been cleared here; the physical one must
    // ride along at every such lifecycle boundary.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 250 }));
    localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
      turnKey: 'local:1:0:300:classic',
      cards: [{ card: '300', completed: true }],
      plusMinusScores: [],
      awaitingChoice: false,
      scoreInput: '350',
    }));

    const store = useGameStore.getState();
    store.addPlayer('Alice');
    store.startGame();

    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(localStorage.getItem('tutto_physical_turn_state')).toBeNull();
  });

  describe('local game stats saving', () => {
    it('does NOT send any stats when a local game ends', () => {
      global.fetch = vi.fn(() => Promise.resolve(mockFetchJson({})));

      const store = useGameStore.getState();
      store.addPlayer('Alice');
      store.startGame();

      // Pinned rather than left to startGame's shuffle: a special card is
      // worth its fixed value or nothing, so whether this turn reaches the
      // winning score at all would otherwise depend on which card came up.
      useGameStore.setState({ currentCard: '200' });
      useGameStore.getState().nextTurn(6000, true);

      expect(useGameStore.getState().finished).toBe(true);
      expect(global.fetch).not.toHaveBeenCalledWith('/api/stats/global', expect.any(Object));
      expect(global.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/\/api\/stats\//), expect.any(Object));

      vi.mocked(global.fetch).mockRestore();
    });
  });

  describe('online game stats saving', () => {
    it('sends online stats for non-host when receiving finished gameState', () => {
      // Connect to online mode as non-host
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ isHost: false, roomId: 'ROOM1', myName: 'Bob', deviceId: 'dev-bob', players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')], status: 'playing', finished: false });

      mockEmit.mockClear();

      // Simulate receiving a gameState that finishes the game
      if (mockOnHandlers['gameState']) {
        mockOnHandlers['gameState']({
          status: 'playing',
          finished: true,
          players: [{name: 'Alice', score: 6000}, {name: 'Bob', score: 2000}]
        });
      }

      // Should have emitted endGameStats with Bob's deviceId
      // The third argument is the ack callback the retry hangs off (see the
      // retry suite below).
      expect(mockEmit).toHaveBeenCalledWith('endGameStats', expect.objectContaining({
        deviceId: 'dev-bob'
      }), expect.any(Function));
    });

    it('sends online stats exactly once when host finishes the game', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Bob', { score: 2000 }), makeOnlinePlayer('Alice', { score: 5500 })],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {}
      });

      mockEmit.mockClear();

      // Host triggers winning turn
      useGameStore.getState().nextTurn(500, true);

      // Should emit endGameStats for Alice (personal stats via socket)
      expect(mockEmit).toHaveBeenCalledWith('endGameStats', expect.objectContaining({
        deviceId: 'dev-alice'
      }), expect.any(Function));

      // Should emit global stats via socket (no HTTP token needed). No
      // roomId in the payload: the server resolves the room from the session.
      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', {
        payload: expect.any(Object),
      }, expect.any(Function));
    });

    it('includes players-per-game, rounds, and feuerwerk/x2 turn maxima in endGameStats and submitGlobalStats payloads', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [
          makeOnlinePlayer('Bob', { score: 2000 }),
          makeOnlinePlayer('Alice', { score: 5500, highestFeuerwerkTurnScore: 300, highestX2TurnScore: 400 }),
        ],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {}, round: 4,
      });

      mockEmit.mockClear();

      // Winning turn for the last player in the round doesn't advance the round further.
      useGameStore.getState().nextTurn(500, true);

      expect(mockEmit).toHaveBeenCalledWith('endGameStats', expect.objectContaining({
        deviceId: 'dev-alice',
        stats: expect.objectContaining({
          totalPlayersSum: 2,
          mostPlayersInGame: 2,
          totalRoundsSum: 4,
          longestGameRounds: 4,
          highestFeuerwerkTurnScore: 300,
          highestX2TurnScore: 400,
        }),
      }), expect.any(Function));

      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', expect.objectContaining({
        payload: expect.objectContaining({
          totalPlayersSum: 2,
          mostPlayersInGame: 2,
          totalRoundsSum: 4,
          longestGameRounds: 4,
        }),
      }), expect.any(Function));
    });

    it('emits pushState BEFORE the stats events on the winning turn, so the server sees finished=true first', () => {
      // The server refuses endGameStats/submitGlobalStats until it has seen
      // finished=true (socketHandlers.ts), and socket.io preserves
      // per-connection event order — so the winning client's own submission
      // only lands if its pushState goes out first.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Bob', { score: 2000 }), makeOnlinePlayer('Alice', { score: 5500 })],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {},
      });

      mockEmit.mockClear();

      useGameStore.getState().nextTurn(500, true);

      const eventOrder = mockEmit.mock.calls.map(c => c[0]);
      const pushIdx = eventOrder.indexOf('pushState');
      const endStatsIdx = eventOrder.indexOf('endGameStats');
      const globalStatsIdx = eventOrder.indexOf('submitGlobalStats');
      expect(pushIdx).toBeGreaterThanOrEqual(0);
      expect(endStatsIdx).toBeGreaterThan(pushIdx);
      expect(globalStatsIdx).toBeGreaterThan(pushIdx);
    });

    it('does not double-submit stats when the server echoes the finished gameState back to the host', () => {
      // The host's own pushState() round-trips through the server and comes back
      // as a 'gameState' broadcast (the host isn't excluded from their own room's
      // broadcast). nextTurn() already sent stats locally when it flipped
      // `finished` to true — the echo must not trigger a second submission.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Bob', { score: 2000 }), makeOnlinePlayer('Alice', { score: 5500 })],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {},
      });

      mockEmit.mockClear();

      // Host triggers the winning turn — flips `finished` locally and sends stats.
      useGameStore.getState().nextTurn(500, true);

      const endGameStatsCallsAfterNextTurn = mockEmit.mock.calls.filter(c => c[0] === 'endGameStats').length;
      const submitGlobalStatsCallsAfterNextTurn = mockEmit.mock.calls.filter(c => c[0] === 'submitGlobalStats').length;
      expect(endGameStatsCallsAfterNextTurn).toBe(1);
      expect(submitGlobalStatsCallsAfterNextTurn).toBe(1);

      // Now simulate the server echoing the same finished state back to the host.
      mockOnHandlers['gameState']({
        status: 'playing',
        finished: true,
        players: useGameStore.getState().players,
      });

      // Counts must be unchanged — the echo must not trigger a second submission.
      const endGameStatsCallsAfterEcho = mockEmit.mock.calls.filter(c => c[0] === 'endGameStats').length;
      const submitGlobalStatsCallsAfterEcho = mockEmit.mock.calls.filter(c => c[0] === 'submitGlobalStats').length;
      expect(endGameStatsCallsAfterEcho).toBe(1);
      expect(submitGlobalStatsCallsAfterEcho).toBe(1);
    });
  });


  describe('endGameStats is retried until the server says it landed', () => {
    // It used to be fire-and-forget, so a transient sqlite error on the
    // server — which rolls its dedup entry back precisely so a resend CAN be
    // recorded — lost this device's row for the game, permanently and
    // silently. Only 'write-failed' (and a server that answers nothing at
    // all) is resent; every other refusal is terminal.
    const statsEmits = () => mockEmit.mock.calls.filter(([event]) => event === 'endGameStats');
    const ackLast = (ack: StatsSubmitAck | undefined) => nonNull(statsEmits().at(-1))[2](ack);

    /** A finished online game with this device seated, ready to submit. */
    const stageFinishedGame = () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        // Not the host: submitGlobalStats is a separate event with its own
        // (unchanged) fire-and-forget contract, and leaving it out keeps
        // these cases about the device row alone.
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice', { score: 6000 }), makeOnlinePlayer('Bob', { score: 100 })],
        status: 'playing', finished: true, round: 3,
      });
      mockEmit.mockClear();
    };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('sends once and arms nothing when the first attempt is acked ok', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      expect(statsEmits(), 'one submission per finished game').toHaveLength(1);
      expect(statsEmits()[0][2], 'and it carries an ack callback').toBeTypeOf('function');

      ackLast({ ok: true });
      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(1));

      expect(statsEmits(), 'nothing to retry').toHaveLength(1);
    });

    it('resends the identical payload after a write-failed, and stops once it lands', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      ackLast({ ok: false, reason: 'write-failed' });
      expect(statsEmits(), 'the resend waits out the backoff').toHaveLength(1);

      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1));
      expect(statsEmits()).toHaveLength(2);
      expect(statsEmits()[1][1], 'the very same submission, so the server can merge it')
        .toEqual(statsEmits()[0][1]);

      ackLast({ ok: true });
      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(2));
      expect(statsEmits(), 'the second attempt landed').toHaveLength(2);
    });

    it('gives up after STATS_SUBMIT_MAX_ATTEMPTS rather than resending forever', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      for (let attempt = 1; attempt < STATS_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
        ackLast({ ok: false, reason: 'write-failed' });
        vi.advanceTimersByTime(statsSubmitRetryDelayMs(attempt));
        expect(statsEmits()).toHaveLength(attempt + 1);
      }

      // The last attempt fails too — and that is the end of it.
      ackLast({ ok: false, reason: 'write-failed' });
      vi.advanceTimersByTime(statsSubmitRetryDelayMs(STATS_SUBMIT_MAX_ATTEMPTS) * 2);

      expect(statsEmits()).toHaveLength(STATS_SUBMIT_MAX_ATTEMPTS);
    });

    it('resends when the server answers nothing at all, and still gives up', () => {
      // A server predating the ack never invokes the callback, which is
      // indistinguishable from one that died mid-write — so silence is
      // retried. Its own per-game dedup makes the extra sends no-ops.
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(1));
      expect(statsEmits()).toHaveLength(2);

      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(2));
      expect(statsEmits()).toHaveLength(STATS_SUBMIT_MAX_ATTEMPTS);

      vi.advanceTimersByTime((STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(3)) * 2);
      expect(statsEmits(), 'bounded even against a silent server').toHaveLength(STATS_SUBMIT_MAX_ATTEMPTS);
    });

    it('does not resend a refusal a resend cannot fix', () => {
      // 'duplicate' most of all: the row is already in, and resending would
      // be asking the server to count the game twice.
      const terminal: Extract<StatsSubmitAck, { ok: false }>[] = [
        { ok: false, reason: 'unauthorized' },
        { ok: false, reason: 'no-room' },
        { ok: false, reason: 'duplicate' },
        { ok: false, reason: 'not-finished' },
        { ok: false, reason: 'invalid' },
        { ok: false, reason: 'rate-limited' },
      ];

      for (const ack of terminal) {
        stageFinishedGame();
        useGameStore.getState().sendOnlineStats();
        ackLast(ack);
        vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(1));

        expect(statsEmits(), `${ack.reason} must not be retried`).toHaveLength(1);
      }
    });

    it('cancels a pending retry when the player leaves the room', () => {
      // The retry is module state, so clearRoomState cannot reach it: without
      // an explicit cancel a submission for an abandoned room would go out
      // seconds later, from a socket that no longer holds that seat.
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      ackLast({ ok: false, reason: 'write-failed' });
      useGameStore.getState().leaveRoom();

      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1) * 2);

      expect(statsEmits(), 'the retry left with the room').toHaveLength(1);
    });

    it('cancels the no-ack deadline when the player leaves the room', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      useGameStore.getState().leaveRoom();

      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS * 2);

      expect(statsEmits()).toHaveLength(1);
    });

    it('drops an earlier game\'s pending retry when the next game submits', () => {
      // One slot: a retry still owed for the previous game must not race the
      // submission for the one just finished.
      stageFinishedGame();
      useGameStore.getState().sendOnlineStats();
      ackLast({ ok: false, reason: 'write-failed' });

      stageFinishedGame();
      useGameStore.getState().sendOnlineStats();
      const afterSecondGame = statsEmits().length;

      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1) * 2);

      expect(statsEmits(), 'only the second game\'s own deadline is live')
        .toHaveLength(afterSecondGame);
    });

    it('arms no resend when a stale write-failed ack arrives after leaveRoom', () => {
      // clearPendingStatsSubmit (called from leaveRoom) stops the resend timer
      // and ack deadline, but the in-flight attempt's own closure had no way
      // to know that — until it does, its `settle` still runs and would arm a
      // resend against a room this client already left.
      stageFinishedGame();
      useGameStore.getState().sendOnlineStats();
      const staleAck = nonNull(statsEmits().at(-1))[2];

      useGameStore.getState().leaveRoom();
      staleAck({ ok: false, reason: 'write-failed' });

      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1) * 2);

      expect(statsEmits(), 'no resend for a room already left').toHaveLength(1);
    });

    it('does not let a stale attempt\'s late ack cancel a newer attempt\'s deadline', () => {
      // submitGlobalStats/sendOnlineStats clear and start a fresher attempt;
      // an old closure settling later must not run clearStatsSubmit again and
      // kill the NEW attempt's ack deadline.
      stageFinishedGame();
      useGameStore.getState().sendOnlineStats();
      const staleAck = nonNull(statsEmits().at(-1))[2];

      stageFinishedGame();
      useGameStore.getState().sendOnlineStats();
      const afterSecondGame = statsEmits().length;

      staleAck({ ok: false, reason: 'write-failed' });

      // A stale resend (the bug) would fire here, on the OLD attempt's own backoff.
      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1));
      expect(statsEmits(), 'the stale ack must not arm its own resend')
        .toHaveLength(afterSecondGame);

      // The newer attempt's own ack deadline must still be live and retry on silence.
      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS);
      expect(statsEmits(), 'the newer attempt still retries on silence')
        .toHaveLength(afterSecondGame + 1);
    });
  });

  describe('isRetryableStatsRefusal classifies every known stats refusal reason', () => {
    // STATS_REFUSAL_REASONS (src/types.ts) has no other consumer pinning the
    // client's retry classification against it — walking the full array here
    // means a reason added there without an explicit entry in this table
    // fails loudly instead of silently falling through as terminal.
    const expectedRetryable: Record<(typeof STATS_REFUSAL_REASONS)[number], boolean> = {
      unauthorized: false,
      'no-room': false,
      'not-finished': false,
      invalid: false,
      'rate-limited': false,
      duplicate: false,
      'write-failed': true,
    };

    it.each(STATS_REFUSAL_REASONS)('%s', (reason) => {
      expect(isRetryableStatsRefusal(reason)).toBe(expectedRetryable[reason]);
    });

    it('covers every reason STATS_REFUSAL_REASONS declares', () => {
      expect(Object.keys(expectedRetryable).sort()).toEqual([...STATS_REFUSAL_REASONS].sort());
    });
  });

  describe('submitGlobalStats is retried until the server says it landed', () => {
    // The host's row for the whole GAME had the same fire-and-forget hole the
    // device row did: the server rolls its per-game `global` dedup flag back
    // when the write throws, so a resend can land — but nothing resent, and
    // one transient sqlite error dropped the game from the server-wide totals
    // for good. Same policy as endGameStats: only 'write-failed' and silence
    // are resent.
    const globalEmits = () => mockEmit.mock.calls.filter(([event]) => event === 'submitGlobalStats');
    const ackLast = (ack: StatsSubmitAck | undefined) => nonNull(globalEmits().at(-1))[2](ack);

    /** A finished online game this client HOSTS, so it owes the global row. */
    const stageFinishedGame = () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice', { score: 6000 }), makeOnlinePlayer('Bob', { score: 100 })],
        status: 'playing', finished: true, round: 3,
      });
      mockEmit.mockClear();
    };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('sends once and arms nothing when the first attempt is acked ok', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      expect(globalEmits(), 'one submission per finished game').toHaveLength(1);
      expect(globalEmits()[0][2], 'and it carries an ack callback').toBeTypeOf('function');

      ackLast({ ok: true });
      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(1));

      expect(globalEmits(), 'nothing to retry').toHaveLength(1);
    });

    it('sends no roomId — the server resolves the room from the session', () => {
      // The server stopped trusting the payload's roomId (a stale or forged
      // one could name another room this same socket hosts), so the client
      // stopped sending it: a field nobody reads only invites the next reader
      // to think it is authoritative.
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();

      const submitted = nonNull(globalEmits()[0])[1] as Record<string, unknown>;
      expect(submitted).not.toHaveProperty('roomId');
      expect(Object.keys(submitted)).toEqual(['payload']);
    });

    it('resends the identical payload after a write-failed, and stops once it lands', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      ackLast({ ok: false, reason: 'write-failed' });
      expect(globalEmits(), 'the resend waits out the backoff').toHaveLength(1);

      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1));
      expect(globalEmits()).toHaveLength(2);
      expect(globalEmits()[1][1], 'the very same submission the server asked for again')
        .toEqual(globalEmits()[0][1]);

      ackLast({ ok: true });
      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(2));
      expect(globalEmits(), 'the second attempt landed').toHaveLength(2);
    });

    it('gives up after STATS_SUBMIT_MAX_ATTEMPTS rather than resending forever', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      for (let attempt = 1; attempt < STATS_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
        ackLast({ ok: false, reason: 'write-failed' });
        vi.advanceTimersByTime(statsSubmitRetryDelayMs(attempt));
        expect(globalEmits()).toHaveLength(attempt + 1);
      }

      // The last attempt fails too — and that is the end of it.
      ackLast({ ok: false, reason: 'write-failed' });
      vi.advanceTimersByTime(statsSubmitRetryDelayMs(STATS_SUBMIT_MAX_ATTEMPTS) * 2);

      expect(globalEmits()).toHaveLength(STATS_SUBMIT_MAX_ATTEMPTS);
    });

    it('resends when the server answers nothing at all, and still gives up', () => {
      // A server predating the ack never invokes the callback; its own
      // per-game dedup refuses the extra sends as duplicates.
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(1));
      expect(globalEmits()).toHaveLength(2);

      vi.advanceTimersByTime((STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(2)) * 2);
      expect(globalEmits(), 'bounded even against a silent server').toHaveLength(STATS_SUBMIT_MAX_ATTEMPTS);
    });

    it('does not resend a refusal a resend cannot fix', () => {
      // 'duplicate' most of all: the game is already counted server-wide, and
      // resending would ask for it to be counted twice.
      const terminal: Extract<StatsSubmitAck, { ok: false }>[] = [
        { ok: false, reason: 'unauthorized' },
        { ok: false, reason: 'no-room' },
        { ok: false, reason: 'duplicate' },
        { ok: false, reason: 'not-finished' },
        { ok: false, reason: 'invalid' },
        { ok: false, reason: 'rate-limited' },
      ];

      for (const ack of terminal) {
        stageFinishedGame();
        useGameStore.getState().sendOnlineStats();
        ackLast(ack);
        vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS + statsSubmitRetryDelayMs(1));

        expect(globalEmits(), ack.reason + ' must not be retried').toHaveLength(1);
      }
    });

    it('cancels a pending retry when the player leaves the room', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      ackLast({ ok: false, reason: 'write-failed' });
      useGameStore.getState().leaveRoom();

      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1) * 2);

      expect(globalEmits(), 'the retry left with the room').toHaveLength(1);
    });

    it('cancels the no-ack deadline when the player leaves the room', () => {
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      useGameStore.getState().leaveRoom();

      vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS * 2);

      expect(globalEmits()).toHaveLength(1);
    });

    it('retries alongside the device submission without either cancelling the other', () => {
      // A host owes BOTH rows for the same finished game, and the two go out
      // back to back. One shared retry slot would mean the second submission
      // disarmed the first one's deadline the moment it was sent — the device
      // row would then never be resent, which is the very bug being fixed.
      const deviceEmits = () => mockEmit.mock.calls.filter(([event]) => event === 'endGameStats');
      stageFinishedGame();

      useGameStore.getState().sendOnlineStats();
      expect(deviceEmits()).toHaveLength(1);
      expect(globalEmits()).toHaveLength(1);

      nonNull(deviceEmits().at(-1))[2]({ ok: false, reason: 'write-failed' });
      ackLast({ ok: false, reason: 'write-failed' });
      vi.advanceTimersByTime(statsSubmitRetryDelayMs(1));

      expect(deviceEmits(), 'the device row is resent').toHaveLength(2);
      expect(globalEmits(), 'and so is the global one').toHaveLength(2);
    });
  });

  describe('socket callbacks', () => {
    beforeEach(() => {
      useGameStore.getState().connectSocket('http://localhost:3000');
    });

    afterEach(() => {
      // Every test below drives socketSlice through the handler it registered
      // under these keys. Left standing between tests, one test's registration
      // would keep answering for the next — and a registration socketSlice
      // stopped making altogether would still appear to be there. Dropping the
      // socket too is what makes the beforeEach above register afresh (
      // connectSocket is a no-op while a socket already exists).
      mockOnHandlers = {};
      disconnectSocket();
    });

    it('gameAborted adds a toast', () => {
      expect(mockOnHandlers['gameAborted']).toBeTypeOf('function');
      // Seated first: like every other room broadcast, this one is dropped for
      // a client that no longer holds the room, so driving the handler from a
      // bare store would exercise the guard rather than the toast.
      useGameStore.setState({ roomId: 'ROOM1', mode: 'online', isOnline: true });
      mockOnHandlers['gameAborted']();

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message === 'game.aborted' || t.message.toLowerCase().includes('aborted'))).toBe(true);
    });

    it('playerReaction appends to reactions and self-prunes after the display window', () => {
      vi.useFakeTimers();
      try {
        useGameStore.setState(seatedInRoom);
        expect(mockOnHandlers['playerReaction']).toBeTypeOf('function');
        mockOnHandlers['playerReaction']({ id: 1, emoji: '🔥', senderName: 'Alice', senderColor: '#ff0000' });
        expect(useGameStore.getState().reactions).toEqual([{ id: 1, emoji: '🔥', senderName: 'Alice', senderColor: '#ff0000' }]);

        vi.runAllTimers();
        expect(useGameStore.getState().reactions).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('hostId updates isHost and hostId state', () => {
      useGameStore.setState(seatedInRoom);
      expect(mockOnHandlers['hostId']).toBeTypeOf('function');
      mockOnHandlers['hostId']('socket-123'); // matches mock socket id
      expect(useGameStore.getState().isHost).toBe(true);
      expect(useGameStore.getState().hostId).toBe('socket-123');

      mockOnHandlers['hostId']('other-socket');
      expect(useGameStore.getState().isHost).toBe(false);
      expect(useGameStore.getState().hostId).toBe('other-socket');
    });

    // The 'finished' edge is the only thing that submits global stats, and
    // only the host may. If the host's socket is already dead when the winning
    // push lands, nobody submits: every connected client sees the edge but is
    // not host, and the promotion that follows used to only flip a flag. The
    // game was then missing from global_statistics for good.
    it('submits the global stats a dead host never sent when promotion lands on a finished game', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, hostId: 'departed-host', roomId: 'ROOM1', myName: 'Alice',
        deviceId: 'dev-alice', finished: true,
        players: [makeOnlinePlayer('Alice', { score: 6000 }), makeOnlinePlayer('Bob', { score: 2000 })],
      });
      mockEmit.mockClear();

      mockOnHandlers['hostId']('socket-123'); // this client's own socket id

      expect(useGameStore.getState().isHost).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', {
        payload: expect.any(Object),
      }, expect.any(Function));
    });

    // With the default non-zero reconnectTimeout the promotion only happens
    // when the disconnect timer drains — and that server callback splices the
    // seat FIRST, then broadcasts gameState before hostId. So the promoted
    // client's payload was built over a roster the departed player, usually
    // the winner, is no longer in: every counter summed over the survivors,
    // totalPlayersSum short, and fastestWinTurns derived from getLeaders over
    // what is left — which in a mid-round finish writes a value lower than any
    // genuine win into a MIN-merged column.
    it('submits the roster the game FINISHED with, not the one the promotion left behind', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, hostId: 'departed-host', roomId: 'ROOM1', myName: 'Bob',
        deviceId: 'dev-bob', finished: false, round: 7,
        players: namedPlayers('Alice', 'Bob', 'Carol'),
      });

      // The winning push: three seats at the table when the game ended.
      mockOnHandlers['gameState']({
        status: 'playing', finished: true, round: 7,
        players: [
          makeOnlinePlayer('Alice', { score: 6000, totalTurns: 9 }),
          makeOnlinePlayer('Bob', { score: 2000, totalTurns: 9 }),
          makeOnlinePlayer('Carol', { score: 1500, totalTurns: 9 }),
        ],
      });

      // …then Alice's reconnect timer drains: the server splices her seat and
      // broadcasts the shrunken roster before handing this client the room.
      mockOnHandlers['gameState']({
        status: 'playing', finished: true, round: 7,
        players: [
          makeOnlinePlayer('Bob', { score: 2000, totalTurns: 9 }),
          makeOnlinePlayer('Carol', { score: 1500, totalTurns: 9 }),
        ],
      });
      mockEmit.mockClear();

      mockOnHandlers['hostId']('socket-123');

      const submitted = mockEmit.mock.calls.find(([event]) => event === 'submitGlobalStats');
      expect(submitted, 'the promoted client still submits').toBeDefined();
      expect(submitted![1].payload.totalPlayersSum, 'three players finished this game').toBe(3);
      expect(submitted![1].payload.mostPlayersInGame).toBe(3);
    });

    // The mirror image of the test above, for the one client the finish edge
    // never fires for: the player who ENDED the game. nextTurn sets finished
    // locally before the push goes out, so by the time the server echoes it
    // back `wasFinished` is already true and no snapshot is taken. If that
    // same client is then promoted (it is connected, so promoteHostAfterLoss
    // prefers it), submitGlobalStats has nothing frozen to read.
    it('submits the roster the game finished with even when this client is the one that ended it', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, hostId: 'departed-host', roomId: 'ROOM1', myName: 'Bob',
        deviceId: 'dev-bob', round: 7,
        // Bob is last in the turn order, so his turn closes the round — which
        // is the only boundary calculateNextTurn ends a game on.
        status: 'playing', finished: false, currentPlayerIndex: 2,
        winningScore: 6000, currentCard: 'Feuerwerk', cards: ['Stop'],
        chartValues: [], chartNames: [], chartLabels: [],
        players: [
          makeOnlinePlayer('Alice', { score: 1000, totalTurns: 9 }),
          makeOnlinePlayer('Carol', { score: 1500, totalTurns: 9 }),
          makeOnlinePlayer('Bob', { score: 6000, totalTurns: 9 }),
        ] as unknown as Player[],
      });

      // Bob takes the winning turn himself: nextTurn flips `finished` locally.
      useGameStore.getState().nextTurn(0, false);
      expect(useGameStore.getState().finished, 'the turn ended the game').toBe(true);

      // The server echoes that same finished state back — `wasFinished` is
      // already true here, so the finish edge does not fire for this client.
      mockOnHandlers['gameState']({
        status: 'playing', finished: true, round: 7,
        players: [
          makeOnlinePlayer('Alice', { score: 1000, totalTurns: 9 }),
          makeOnlinePlayer('Carol', { score: 1500, totalTurns: 9 }),
          makeOnlinePlayer('Bob', { score: 6000, totalTurns: 10 }),
        ],
      });

      // …then the dead host's reconnect timer drains: the seat is spliced and
      // the shrunken roster is broadcast before this client is handed the room.
      mockOnHandlers['gameState']({
        status: 'playing', finished: true, round: 7,
        players: [
          makeOnlinePlayer('Carol', { score: 1500, totalTurns: 9 }),
          makeOnlinePlayer('Bob', { score: 6000, totalTurns: 10 }),
        ],
      });
      mockEmit.mockClear();

      mockOnHandlers['hostId']('socket-123');

      const submitted = mockEmit.mock.calls.find(([event]) => event === 'submitGlobalStats');
      expect(submitted, 'the promoted client still submits').toBeDefined();
      expect(submitted![1].payload.totalPlayersSum, 'three players finished this game').toBe(3);
      expect(submitted![1].payload.mostPlayersInGame).toBe(3);
    });

    // The snapshot is written on the finish edge but nothing clears it when a
    // new game starts, and buildGlobalStatsPayload prefers it over live state.
    // A host who takes the winning turn HIMSELF never re-arms it (nextTurn sets
    // finished locally, so the echo is not an edge), so the rematch's payload
    // is built from the game before it.
    it('records the rematch, not the game before it, when the host ends the rematch himself', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, hostId: 'socket-123', roomId: 'ROOM1', myName: 'Alice',
        deviceId: 'dev-alice', round: 4, finished: false,
        players: namedPlayers('Alice', 'Bob', 'Carol'),
      });

      // Game 1 ends with Bob's winning push: this client sees the finish edge
      // and freezes three seats, then submits.
      mockOnHandlers['gameState']({
        status: 'playing', finished: true, round: 4,
        players: [
          makeOnlinePlayer('Alice', { score: 2000, totalTurns: 5 }),
          makeOnlinePlayer('Bob', { score: 6000, totalTurns: 5 }),
          makeOnlinePlayer('Carol', { score: 1000, totalTurns: 5 }),
        ],
      });
      expect(useGameStore.getState().finishedGameSnapshot?.round).toBe(4);

      // Play Again, now as a two-player rematch that Alice wins on her own
      // last turn — nine rounds in, so the payload is unmistakably this game's.
      useGameStore.setState({
        status: 'playing', finished: false, round: 9, currentPlayerIndex: 1,
        winningScore: 6000, currentCard: 'Feuerwerk', cards: ['Stop'],
        chartValues: [], chartNames: [], chartLabels: [],
        players: [
          makeOnlinePlayer('Bob', { score: 1500, totalTurns: 12 }),
          makeOnlinePlayer('Alice', { score: 6000, totalTurns: 12 }),
        ] as unknown as Player[],
      });
      mockEmit.mockClear();

      useGameStore.getState().nextTurn(0, false);
      expect(useGameStore.getState().finished, 'the rematch ended').toBe(true);

      const submitted = mockEmit.mock.calls.find(([event]) => event === 'submitGlobalStats');
      expect(submitted, 'the host submits the rematch').toBeDefined();
      expect(submitted![1].payload.totalRoundsSum, "the rematch's round count").toBe(9);
      expect(submitted![1].payload.totalPlayersSum, 'two players played the rematch').toBe(2);
    });

    it('does not resubmit global stats when an already-host client is re-told it is host', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, hostId: 'socket-123', roomId: 'ROOM1', myName: 'Alice',
        deviceId: 'dev-alice', finished: true,
        players: [makeOnlinePlayer('Alice', { score: 6000 }), makeOnlinePlayer('Bob', { score: 2000 })],
      });
      mockEmit.mockClear();

      // emitRoomState broadcasts hostId alongside every gameState, so this
      // arrives repeatedly for the whole end screen.
      mockOnHandlers['hostId']('socket-123');

      // Matched by event name rather than through not.toHaveBeenCalledWith:
      // that matcher compares the whole argument list, so an expectation
      // written for the pre-ack two-argument emit would pass no matter what
      // this client sent.
      expect(emittedEvents()).not.toContain('submitGlobalStats');
    });

    it('does not submit global stats on promotion while the game is still running', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, hostId: 'departed-host', roomId: 'ROOM1', myName: 'Alice',
        deviceId: 'dev-alice', finished: false,
        players: [makeOnlinePlayer('Alice', { score: 100 }), makeOnlinePlayer('Bob', { score: 200 })],
      });
      mockEmit.mockClear();

      mockOnHandlers['hostId']('socket-123');

      expect(useGameStore.getState().isHost).toBe(true);
      expect(emittedEvents()).not.toContain('submitGlobalStats');
    });

    // The lobby's join button and the reconnect popup's "Yes, Reconnect" both
    // race joinRoom against JOIN_TIMEOUT_MS already. The automatic rejoin on
    // 'connect' did not — and it is the one path with no user watching a
    // button: safeOn (server/socketContext.ts) catches a throwing handler and
    // logs it, so the ack simply never fires while the socket stays healthy.
    // Nothing then retries, and the full-screen "attempting to reconnect"
    // modal was up for good.
    describe('the automatic rejoin on reconnect', () => {
      const stageSeatedReconnect = () => {
        useGameStore.getState().setMode('online');
        useGameStore.setState({
          roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
          showReconnectPopup: true,
        });
      };

      it('gives up and lowers the popup when the ack never comes', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          expect(mockEmit).toHaveBeenCalledWith('joinRoom', expect.objectContaining({
            roomId: 'ROOM1', name: 'Alice',
          }), expect.any(Function));

          // Still waiting: the deadline has not passed, so the popup stays up
          // and nothing has been said to the player.
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS - 1);
          expect(useGameStore.getState().showReconnectPopup).toBe(true);

          vi.advanceTimersByTime(1);
          expect(useGameStore.getState().showReconnectPopup).toBe(false);
          expect(useGameStore.getState().toasts.length).toBeGreaterThan(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not fire once the ack has arrived', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockImplementation((event, _payload, ack) => {
            if (event === 'joinRoom') ack({ success: true, isHost: false, name: 'Alice' });
          });

          mockOnHandlers['connect']();
          expect(useGameStore.getState().isHost).toBe(false);

          // The popup is the gameState handler's to lower from here (it clears
          // it on the sync that follows a successful rejoin) — the watchdog
          // must not have armed a late toast behind it.
          const toastsAfterAck = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length).toBe(toastsAfterAck);
        } finally {
          mockEmit.mockReset();
          vi.useRealTimers();
        }
      });

      // How long the first reconnect's rejoin is left in flight before the
      // transport drops again — any value short of the deadline will do.
      const FIRST_ATTEMPT_IN_FLIGHT_MS = JOIN_TIMEOUT_MS / 2;

      // The watchdog used to be a plain local of the 'connect' handler, so a
      // second reconnect while the first rejoin was still in flight left the
      // first one armed: its ack can never come (that socket is gone), so it
      // toasted "No response from the server" and tore the popup down ten
      // seconds after the SECOND rejoin had already succeeded.
      it('does not fire the first attempt\'s watchdog once a later reconnect is acked', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          // First connect: the rejoin goes out and nothing ever acks it.
          mockOnHandlers['connect']();
          vi.advanceTimersByTime(FIRST_ATTEMPT_IN_FLIGHT_MS);

          // The transport comes back and this rejoin is acked.
          mockEmit.mockImplementation((event, _payload, ack) => {
            if (event === 'joinRoom') ack({ success: true, isHost: false, name: 'Alice' });
          });
          mockOnHandlers['connect']();
          expect(useGameStore.getState().myName).toBe('Alice');

          const toastsAfterAck = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length, 'the dead attempt must stay quiet').toBe(toastsAfterAck);
          // The gameState sync that follows the rejoin is what lowers this —
          // the stale watchdog must not do it first.
          expect(useGameStore.getState().showReconnectPopup).toBe(true);
        } finally {
          mockEmit.mockReset();
          vi.useRealTimers();
        }
      });

      it('drops the watchdog when the room is left while the rejoin is in flight', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          useGameStore.getState().leaveRoom();

          const toasts = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length, 'no seat is waiting on that ack any more').toBe(toasts);
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops the watchdog when the reconnect is cancelled while the rejoin is in flight', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          useGameStore.getState().cancelReconnect();

          const toasts = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length).toBe(toasts);
          expect(useGameStore.getState().showReconnectPopup).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops the watchdog when the store is reset while the rejoin is in flight', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          useGameStore.getState().reset();

          const toasts = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length).toBe(toasts);
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops the watchdog when the seat is surrendered while the rejoin is in flight', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          mockOnHandlers['kicked']();

          const toasts = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length, 'only the kick is worth saying').toBe(toasts);
        } finally {
          vi.useRealTimers();
        }
      });

      it('a late success ack after leaveRoom leaves the store untouched', () => {
        // leaveRoom doesn't disconnect the socket, so the in-flight rejoin's
        // ack can still land afterwards. Only the watchdog had a relevance
        // guard; the ack callback itself did not, and would happily re-seat a
        // store already back in local mode.
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          const rejoinAck = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'))[2];

          useGameStore.getState().leaveRoom();
          rejoinAck({ success: true, isHost: true, name: 'Alice' });

          const s = useGameStore.getState();
          expect(s.roomId, 'the leave must stick').toBeNull();
          expect(s.isHost, 'a late success must not re-seat this client as host').toBe(false);
          expect(s.myName).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it('a late failure ack after leaveRoom produces no toast', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          const rejoinAck = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'))[2];

          useGameStore.getState().leaveRoom();
          const toastsBefore = useGameStore.getState().toasts.length;

          rejoinAck({ success: false, error: 'Room no longer exists' });

          expect(useGameStore.getState().toasts.length, 'a leave already handled has nothing left to say')
            .toBe(toastsBefore);
        } finally {
          vi.useRealTimers();
        }
      });

      it('arms no watchdog when there is no seat to rejoin', () => {
        vi.useFakeTimers();
        try {
          useGameStore.getState().setMode('online');
          useGameStore.setState({ roomId: null, myName: null, showReconnectPopup: true });
          mockEmit.mockClear();

          mockOnHandlers['connect']();

          // Nothing to rejoin: the popup is stale and lowered immediately, and
          // no join was ever sent for a watchdog to be waiting on.
          expect(emittedEvents()).not.toContain('joinRoom');
          expect(useGameStore.getState().showReconnectPopup).toBe(false);
          const toasts = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length).toBe(toasts);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    // pushState was fire-and-forget in both directions. socket.io-client
    // flushes buffered emits BEFORE it fires 'connect', so a push made during
    // a transport drop reached the server on the new socket id while the seat
    // still carried the old one — it failed the authorization gate, was
    // dropped without a word, and the rejoin broadcast then overwrote the turn
    // the player had already committed locally. The parked slot below, the
    // ack, and the version floor are the three halves of the fix.
    describe('pushState/stats parking, the refusal ack and the stateVersion floor', () => {
      const STAGED_ROUND = 4;
      const LATER_ROUND = 5;
      /** The attempt number a first send carries — socketSlice's FIRST_STATS_ATTEMPT. */
      const FIRST_ATTEMPT = 1;

      const stageSeatedGame = () => {
        useGameStore.setState({
          mode: 'online', isOnline: true,
          roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice', isHost: true,
          players: namedPlayers('Alice', 'Bob'),
          status: 'playing', currentPlayerIndex: 0, round: STAGED_ROUND,
        });
        mockEmit.mockClear();
      };

      const pushes = () => mockEmit.mock.calls.filter(([event]) => event === 'pushState');

      const ackRejoin = (res: { success: boolean; isHost?: boolean; name?: string; code?: string; error?: string }) => {
        const join = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'));
        expect(join, 'the reconnect must have attempted a rejoin').toBeTruthy();
        join[2](res);
      };

      it('parks a push made while the socket is down and sends it once the rejoin is acked', () => {
        stageSeatedGame();
        mockSocketConnected = false;

        useGameStore.getState().pushState();
        expect(pushes(), 'nothing may go out over a dead transport').toHaveLength(0);

        mockSocketConnected = true;
        mockOnHandlers['connect']();
        expect(pushes(), 'and not before the rejoin is acked either').toHaveLength(0);

        ackRejoin({ success: true, isHost: true, name: 'Alice' });

        expect(pushes()).toHaveLength(1);
        expect(pushes()[0][1].newState.round).toBe(STAGED_ROUND);
      });

      it('re-parks a push the flush finds the socket down for again, instead of firing it into the void', () => {
        // Mirrors the stats twin (see 'stats submissions parked across the
        // same drop' > 're-parks a submission...' below): flushParkedPush
        // used to check only `if (sock)`, not `sock.connected`, so a rejoin
        // ack that lands while the transport is already gone again emitted
        // straight into a dead socket instead of re-parking the snapshot.
        stageSeatedGame();
        mockSocketConnected = false;
        useGameStore.getState().pushState();

        // The rejoin acks, but the transport is gone again by the time it is
        // processed.
        mockSocketConnected = true;
        mockOnHandlers['connect']();
        mockSocketConnected = false;
        ackRejoin({ success: true, isHost: true, name: 'Alice' });
        expect(pushes(), 'nothing may go out over a dead transport').toHaveLength(0);

        mockSocketConnected = true;
        mockOnHandlers['connect']();
        ackRejoin({ success: true, isHost: true, name: 'Alice' });
        expect(pushes(), 'the park must survive to the next rejoin').toHaveLength(1);
      });

      it('keeps only the newest parked push — an older snapshot is obsolete', () => {
        stageSeatedGame();
        mockSocketConnected = false;

        useGameStore.getState().pushState();
        useGameStore.setState({ round: LATER_ROUND });
        useGameStore.getState().pushState();

        mockSocketConnected = true;
        mockOnHandlers['connect']();
        ackRejoin({ success: true, isHost: true, name: 'Alice' });

        expect(pushes(), 'one flush, not two').toHaveLength(1);
        expect(pushes()[0][1].newState.round).toBe(LATER_ROUND);
      });

      it('drops the parked push when the rejoin itself fails', () => {
        stageSeatedGame();
        mockSocketConnected = false;
        useGameStore.getState().pushState();

        mockSocketConnected = true;
        mockOnHandlers['connect']();
        ackRejoin({ success: false, code: 'name_taken', error: 'Username already exists in this room' });

        expect(pushes(), 'the seat is gone — the move has nowhere to land').toHaveLength(0);
        expect(useGameStore.getState().roomId).toBeNull();
      });

      it('toasts and asks for a fresh state when the server refuses the push', () => {
        stageSeatedGame();

        useGameStore.getState().pushState();
        const push = pushes()[0];
        expect(push[2], 'the push carries an ack callback').toBeTypeOf('function');

        push[2]({ ok: false, reason: 'stale-roster' });

        expect(useGameStore.getState().toasts.some(
          t => t.message.includes('not accepted by the server'),
        )).toBe(true);
        expect(mockEmit).toHaveBeenCalledWith('requestState', { roomId: 'ROOM1' });
      });

      it('gives the seat up when the server says the room is gone', () => {
        // 'no-room' is not something a fresh state can repair: there is no
        // room left to ask. Toasting "the game state was refreshed" and then
        // firing a requestState into the void left the player looking at a
        // room that no longer exists, with every action silently doing
        // nothing. Same teardown the kicked/seatTakenOver handlers run.
        stageSeatedGame();
        sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'ROOM1', myName: 'Alice' }));

        useGameStore.getState().pushState();
        pushes()[0][2]({ ok: false, reason: 'no-room' });

        const state = useGameStore.getState();
        expect(state.toasts.some(t => t.message.includes('no longer exists'))).toBe(true);
        expect(state.roomId, 'the room is given up, not refreshed').toBeNull();
        expect(state.mode).toBe('local');
        expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
        expect(emittedEvents()).not.toContain('requestState');
      });

      it('stays quiet when the server refuses the push as rate-limited', () => {
        // Nothing is wrong with the client's state — it is simply pushing
        // faster than the limiter allows, and the next legitimate push will
        // land. A toast per dropped push would be a burst of alarming noise,
        // and a requestState per dropped push feeds the very flood that
        // caused it.
        stageSeatedGame();

        useGameStore.getState().pushState();
        pushes()[0][2]({ ok: false, reason: 'rate-limited' });

        expect(useGameStore.getState().toasts).toHaveLength(0);
        expect(emittedEvents()).not.toContain('requestState');
        expect(useGameStore.getState().roomId, 'and the seat is kept').toBe('ROOM1');
      });

      it('says nothing at all when the server accepts the push', () => {
        stageSeatedGame();

        useGameStore.getState().pushState();
        pushes()[0][2]({ ok: true, stateVersion: 3 });

        expect(useGameStore.getState().toasts).toHaveLength(0);
        expect(emittedEvents()).not.toContain('requestState');
      });

      it('tolerates a server old enough to ack nothing', () => {
        stageSeatedGame();

        useGameStore.getState().pushState();
        expect(() => pushes()[0][2](undefined)).not.toThrow();

        expect(useGameStore.getState().toasts).toHaveLength(0);
        expect(emittedEvents()).not.toContain('requestState');
      });

      it('retries an unauthorized refusal once when it lands right after a reconnect', () => {
        vi.useFakeTimers();
        try {
          stageSeatedGame();
          mockSocketConnected = false;
          useGameStore.getState().pushState();

          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackRejoin({ success: true, isHost: true, name: 'Alice' });

          // The rejoin race: the server saw the push before it saw the join.
          pushes()[0][2]({ ok: false, reason: 'unauthorized' });
          expect(useGameStore.getState().toasts, 'a race is not worth a toast').toHaveLength(0);
          expect(emittedEvents()).not.toContain('requestState');

          vi.advanceTimersByTime(PUSH_REJOIN_RETRY_DELAY_MS);
          expect(pushes(), 'the same snapshot goes out again').toHaveLength(2);
          expect(pushes()[1][1].newState.round).toBe(STAGED_ROUND);

          // Once. A second refusal is a real one.
          pushes()[1][2]({ ok: false, reason: 'unauthorized' });
          vi.advanceTimersByTime(PUSH_REJOIN_RETRY_DELAY_MS * 4);
          expect(pushes()).toHaveLength(2);
          expect(useGameStore.getState().toasts.some(
            t => t.message.includes('not accepted by the server'),
          )).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it('parks the retry instead of emitting it into a socket that dropped again', () => {
        // The retry exists for a flaky reconnect, so a second drop inside its
        // 300ms is exactly the case it must survive. socket.io-client buffers
        // an emit made while disconnected and flushes that buffer BEFORE it
        // fires 'connect' -- so the push would arrive on the NEW socket id
        // while the seat still carries the old one, be refused, and be gone:
        // the retry is not retryable and nothing was parked to recover it.
        // The player's banked turn disappears with no toast.
        vi.useFakeTimers();
        try {
          stageSeatedGame();
          mockSocketConnected = false;
          useGameStore.getState().pushState();

          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackRejoin({ success: true, isHost: true, name: 'Alice' });

          pushes()[0][2]({ ok: false, reason: 'unauthorized' });

          // The transport drops again while the retry is armed.
          mockSocketConnected = false;
          vi.advanceTimersByTime(PUSH_REJOIN_RETRY_DELAY_MS);
          expect(pushes(), 'nothing is emitted into a dead socket').toHaveLength(1);

          // ...and it is held, so the next rejoin sends it.
          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackRejoin({ success: true, isHost: true, name: 'Alice' });

          expect(pushes(), 'the parked snapshot goes out on the new connection').toHaveLength(2);
          expect(pushes()[1][1].newState.round).toBe(STAGED_ROUND);
        } finally {
          vi.useRealTimers();
        }
      });

      it('cancels a pending rejoin retry when a newer push is made before it fires', () => {
        vi.useFakeTimers();
        try {
          stageSeatedGame();
          mockSocketConnected = false;
          useGameStore.getState().pushState();

          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackRejoin({ success: true, isHost: true, name: 'Alice' });

          // The rejoin race arms a retry of the STAGED_ROUND snapshot.
          pushes()[0][2]({ ok: false, reason: 'unauthorized' });
          const pushesBeforeRetry = pushes().length;

          // A newer full snapshot is pushed before that retry ever fires —
          // it must supersede the stale one instead of racing it.
          useGameStore.setState({ round: LATER_ROUND });
          useGameStore.getState().pushState();

          vi.advanceTimersByTime(PUSH_REJOIN_RETRY_DELAY_MS);

          expect(pushes(), 'the stale retry must not also fire').toHaveLength(pushesBeforeRetry + 1);
          expect(pushes().at(-1)![1].newState.round).toBe(LATER_ROUND);
        } finally {
          vi.useRealTimers();
        }
      });

      it('treats an unauthorized refusal as real when no reconnect preceded it', () => {
        stageSeatedGame();

        useGameStore.getState().pushState();
        pushes()[0][2]({ ok: false, reason: 'unauthorized' });

        expect(pushes(), 'no retry without a reconnect to blame').toHaveLength(1);
        expect(mockEmit).toHaveBeenCalledWith('requestState', { roomId: 'ROOM1' });
      });

      it('treats an unauthorized refusal as real once the reconnect window has passed', () => {
        vi.useFakeTimers();
        try {
          stageSeatedGame();
          mockOnHandlers['connect']();
          ackRejoin({ success: true, isHost: true, name: 'Alice' });
          mockEmit.mockClear();

          useGameStore.getState().pushState();
          vi.advanceTimersByTime(PUSH_REJOIN_RACE_WINDOW_MS + 1);
          pushes()[0][2]({ ok: false, reason: 'unauthorized' });

          expect(pushes()).toHaveLength(1);
          expect(mockEmit).toHaveBeenCalledWith('requestState', { roomId: 'ROOM1' });
        } finally {
          vi.useRealTimers();
        }
      });

      it('ignores a broadcast older than the one already applied, and applies the rest', () => {
        stageSeatedGame();

        mockOnHandlers['gameState']({ round: 10, stateVersion: 10 });
        expect(useGameStore.getState().round).toBe(10);
        expect(useGameStore.getState().lastAppliedStateVersion).toBe(10);

        mockOnHandlers['gameState']({ round: 9, stateVersion: 9 });
        expect(useGameStore.getState().round, 'a late broadcast may not undo newer state').toBe(10);

        // Equal, higher, and missing all apply — the last so an older server
        // (and the very first broadcast) still works.
        mockOnHandlers['gameState']({ round: 11, stateVersion: 10 });
        expect(useGameStore.getState().round).toBe(11);
        mockOnHandlers['gameState']({ round: 12, stateVersion: 11 });
        expect(useGameStore.getState().round).toBe(12);
        mockOnHandlers['gameState']({ round: 13 });
        expect(useGameStore.getState().round).toBe(13);
        expect(useGameStore.getState().lastAppliedStateVersion, 'an unversioned broadcast leaves the floor alone').toBe(11);
      });

      it('drops the floor on a successful rejoin, so a fresh room can never be ignored', () => {
        stageSeatedGame();
        mockOnHandlers['gameState']({ round: 10, stateVersion: 50 });

        mockOnHandlers['connect']();
        ackRejoin({ success: true, isHost: true, name: 'Alice' });
        expect(useGameStore.getState().lastAppliedStateVersion).toBeNull();

        mockOnHandlers['gameState']({ round: 1, stateVersion: 1 });
        expect(useGameStore.getState().round).toBe(1);
      });

      it('drops the floor on an explicit joinRoom too, not only on the automatic rejoin', async () => {
        // Defence in depth, and the same reason: the room behind this id may
        // have been recreated since this store last applied a broadcast, and
        // a fresh room's versions start at 1 — under a carried-over floor of
        // 50 every one of them is dropped as stale and the client renders a
        // room it never syncs.
        stageSeatedGame();
        mockOnHandlers['gameState']({ round: 10, stateVersion: 50 });
        expect(useGameStore.getState().lastAppliedStateVersion).toBe(50);

        const joining = useGameStore.getState().joinRoom('ROOM1', 'Alice', false);
        const join = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'));
        join[2]({ success: true, isHost: true, name: 'Alice' });
        await joining;

        expect(useGameStore.getState().lastAppliedStateVersion).toBeNull();
      });

      it('drops a push parked for a room the client is no longer in', () => {
        stageSeatedGame();
        mockSocketConnected = false;
        useGameStore.getState().pushState();

        // Every departure path clears the park today, so this is belt and
        // braces — but a push is a FULL snapshot, so a room switch that ever
        // forgot to would land ROOM1's game on top of ROOM2's.
        mockSocketConnected = true;
        useGameStore.setState({ roomId: 'ROOM2' });
        mockEmit.mockClear();
        mockOnHandlers['connect']();
        ackRejoin({ success: true, isHost: true, name: 'Alice' });

        expect(pushes()).toHaveLength(0);
      });

      it('leaveRoom clears both the floor and the parked push', () => {
        stageSeatedGame();
        mockOnHandlers['gameState']({ round: 10, stateVersion: 50 });
        mockSocketConnected = false;
        useGameStore.getState().pushState();

        useGameStore.getState().leaveRoom();
        expect(useGameStore.getState().lastAppliedStateVersion).toBeNull();

        // Nothing left to flush: a later reconnect must not resurrect a move
        // made in a room this client has left.
        mockSocketConnected = true;
        useGameStore.setState({ roomId: 'ROOM1', myName: 'Alice' });
        mockEmit.mockClear();
        mockOnHandlers['connect']();
        ackRejoin({ success: true, isHost: true, name: 'Alice' });
        expect(pushes()).toHaveLength(0);
      });

      it('reset clears the floor too', () => {
        stageSeatedGame();
        mockOnHandlers['gameState']({ round: 10, stateVersion: 50 });

        useGameStore.getState().reset();

        expect(useGameStore.getState().lastAppliedStateVersion).toBeNull();
      });

      // The stats emits had no `connected` check at all, and socket.io's own
      // buffer is no substitute: it flushes BEFORE 'connect' fires, so a
      // buffered submission reaches the server ahead of this client's rejoin,
      // is refused 'no-room' (terminal — the resend logic ignores it) and the
      // row is lost. They are parked behind the rejoin ack like the push.
      describe('stats submissions parked across the same drop', () => {
        const stageFinishedGame = () => {
          useGameStore.setState({
            mode: 'online', isOnline: true,
            roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice', isHost: true,
            players: [makeOnlinePlayer('Alice', { score: 6000, totalTurns: 9 }), makeOnlinePlayer('Bob')],
            status: 'playing', finished: true, round: STAGED_ROUND,
          });
          mockEmit.mockClear();
        };

        const emitsOf = (event: string) => mockEmit.mock.calls.filter(([e]) => e === event);

        // The rejoin under test is not always the first one in the log — the
        // re-park case below drives two of them.
        const ackLatestRejoin = (res: { success: boolean; isHost?: boolean; name?: string }) => {
          const joins = mockEmit.mock.calls.filter(([event]) => event === 'joinRoom');
          nonNull(joins.at(-1), 'the reconnect must have attempted a rejoin')[2](res);
        };

        it('parks both submissions made on a dead socket and sends them once the rejoin is acked', () => {
          stageFinishedGame();
          mockSocketConnected = false;

          useGameStore.getState().sendOnlineStats();
          expect(emitsOf('endGameStats'), 'nothing may go out over a dead transport').toHaveLength(0);
          expect(emitsOf('submitGlobalStats')).toHaveLength(0);

          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });

          // One park per EVENT: sendOnlineStats fires the two back to back, so
          // a single shared slot would silently drop this device's own row.
          expect(emitsOf('endGameStats')).toHaveLength(1);
          expect(emitsOf('submitGlobalStats')).toHaveLength(1);
        });

        it('flushes the parked push first — the server refuses stats until it has seen finished=true', () => {
          stageFinishedGame();
          mockSocketConnected = false;

          useGameStore.getState().pushState();
          useGameStore.getState().sendOnlineStats();

          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });

          const order = mockEmit.mock.calls.map(([event]) => event).filter(event => event !== 'joinRoom');
          expect(order, "'not-finished' is terminal, so the winning push has to land first").toEqual(
            ['pushState', 'endGameStats', 'submitGlobalStats'],
          );
        });

        it('re-parks a submission the flush finds the socket down for again, instead of firing it into the void', () => {
          stageFinishedGame();
          mockSocketConnected = false;
          useGameStore.getState().sendOnlineStats();

          // The rejoin acks, but the transport is gone again by the time it is
          // processed. A flush that emitted a captured payload would hand it
          // straight back to the dead socket; re-entering the sender parks it
          // again, so the retry schedule stays live.
          mockSocketConnected = true;
          mockOnHandlers['connect']();
          mockSocketConnected = false;
          ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });
          expect(emitsOf('endGameStats')).toHaveLength(0);

          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });
          expect(emitsOf('endGameStats'), 'the park must survive to the next rejoin').toHaveLength(1);
        });

        it('clears a park from an earlier finish even when the new finish is seatless', () => {
          // buildDeviceStatsPayload returns null when this device holds no
          // seat in the final roster (spectating, or spliced out).
          // sendOnlineStats used to call clearPendingStatsSubmit() only
          // INSIDE the `stats && socket` branch, so a park from an earlier
          // finish rode along on the very next rejoin and was recorded
          // against a game this device never held a seat in.
          stageFinishedGame();
          mockSocketConnected = false;
          useGameStore.getState().sendOnlineStats();
          expect(emitsOf('endGameStats')).toHaveLength(0);

          // A second finish, with this device spliced out of the final
          // roster — still on a dead transport.
          useGameStore.setState({ players: [makeOnlinePlayer('Bob')] });
          useGameStore.getState().sendOnlineStats();

          mockSocketConnected = true;
          mockOnHandlers['connect']();
          ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });

          expect(emitsOf('endGameStats'), 'a park from the previous game must not survive a seatless finish').toHaveLength(0);
        });

        it('forgets a submission parked for a room the client then left', () => {
          stageFinishedGame();
          mockSocketConnected = false;
          useGameStore.getState().sendOnlineStats();

          useGameStore.getState().leaveRoom();

          // A different room, a different game: the finished game's row must
          // not ride in on the next rejoin and be recorded against it.
          mockSocketConnected = true;
          useGameStore.setState({ mode: 'online', isOnline: true, roomId: 'ROOM2', myName: 'Alice' });
          mockOnHandlers['connect']();
          ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });

          expect(emitsOf('endGameStats')).toHaveLength(0);
          expect(emitsOf('submitGlobalStats')).toHaveLength(0);
        });

        // Nothing else bounds the wait: socket.io retries forever, so a
        // suspended tab can rejoin long after the room moved on — and Play
        // Again resets the server's per-game stats dedup, so a submission
        // flushed then is recorded against the NEXT game.
        describe('a park does not outlive the game it was made in', () => {
          beforeEach(() => { vi.useFakeTimers(); });
          afterEach(() => { vi.useRealTimers(); });

          const rejoinAfter = (ageMs: number) => {
            vi.advanceTimersByTime(ageMs);
            mockSocketConnected = true;
            mockOnHandlers['connect']();
            ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });
          };

          it('drops a push parked for longer than the bound', () => {
            stageSeatedGame();
            mockSocketConnected = false;
            useGameStore.getState().pushState();

            rejoinAfter(PARKED_EMIT_MAX_AGE_MS + 1);

            expect(pushes(), 'a stale snapshot overwrites a room that has moved on').toHaveLength(0);
          });

          it('still flushes one that is only just inside it', () => {
            stageSeatedGame();
            mockSocketConnected = false;
            useGameStore.getState().pushState();

            rejoinAfter(PARKED_EMIT_MAX_AGE_MS - 1);

            expect(pushes()).toHaveLength(1);
          });

          it('drops stale parked stats for the same reason', () => {
            stageFinishedGame();
            mockSocketConnected = false;
            useGameStore.getState().sendOnlineStats();

            rejoinAfter(PARKED_EMIT_MAX_AGE_MS + 1);

            expect(emitsOf('endGameStats')).toHaveLength(0);
            expect(emitsOf('submitGlobalStats')).toHaveLength(0);
          });

          // Half the window: far enough in that a stamp taken at that moment
          // would still look fresh a full window later, and comfortably
          // inside the bound at the moment it is taken.
          const HALF_PARK_WINDOW_MS = PARKED_EMIT_MAX_AGE_MS / 2;

          it('keeps the original stamp when a park has to be re-parked', () => {
            // The stamp rides with the payload (ParkedEmit) precisely so age
            // keeps accruing across a second park instead of starting over —
            // otherwise a transport that drops on every rejoin renews the
            // submission indefinitely and it is eventually flushed into
            // whatever game the room is playing by then.
            stageFinishedGame();
            mockSocketConnected = false;
            useGameStore.getState().sendOnlineStats();

            // The rejoin lands, but the transport is gone again by the time
            // the flush runs, so the submission is parked a second time.
            vi.advanceTimersByTime(HALF_PARK_WINDOW_MS);
            mockSocketConnected = true;
            mockOnHandlers['connect']();
            mockSocketConnected = false;
            ackLatestRejoin({ success: true, isHost: true, name: 'Alice' });
            expect(emitsOf('endGameStats'), 'nothing may go out over a dead transport').toHaveLength(0);

            // Past the bound counted from the FIRST park, still inside it
            // counted from the second.
            rejoinAfter(HALF_PARK_WINDOW_MS + 1);

            expect(
              emitsOf('endGameStats'),
              'a re-park restarted the age, so a submission older than the bound was sent',
            ).toHaveLength(0);
            expect(emitsOf('submitGlobalStats')).toHaveLength(0);
          });

          it('keeps the original stamp when a parked PUSH has to be re-parked', () => {
            // The push path re-parks too: a flushed snapshot refused as a
            // rejoin race arms a retry, and a retry that finds the transport
            // gone again parks it. Re-stamped there, the snapshot renews
            // itself on every flaky reconnect and is eventually pushed over
            // whatever game the room is playing by then.
            stageSeatedGame();
            mockSocketConnected = false;
            useGameStore.getState().pushState();

            // Flushed halfway through the window, and refused as a race with
            // this client's own rejoin.
            rejoinAfter(HALF_PARK_WINDOW_MS);
            expect(pushes(), 'the flush must actually have sent it').toHaveLength(1);
            pushes()[0][2]({ ok: false, reason: 'unauthorized' });

            // The transport is gone again by the time the retry fires, so the
            // snapshot parks a second time.
            mockSocketConnected = false;
            vi.advanceTimersByTime(PUSH_REJOIN_RETRY_DELAY_MS);
            mockEmit.mockClear();

            // Past the bound counted from the FIRST park, still inside it
            // counted from the second.
            rejoinAfter(
              PARKED_EMIT_MAX_AGE_MS + 1 - HALF_PARK_WINDOW_MS - PUSH_REJOIN_RETRY_DELAY_MS,
            );

            expect(
              pushes(),
              'a re-park restarted the age, so a snapshot older than the bound was sent',
            ).toHaveLength(0);
          });

          it('keeps it across an ack timeout and its backoff too', () => {
            // The resend is the other place the stamp can be lost, and it is
            // the more expensive one: a flushed submission that gets no ack
            // burns STATS_SUBMIT_ACK_TIMEOUT_MS plus a backoff before the
            // retry runs, and a retry that then finds the socket down parks
            // again. Re-stamped there, the submission comes back looking
            // newer than the game it belongs to and rides the next rejoin
            // into a room that has since started another one — where Play
            // Again has reset the server's per-game dedup and the row is
            // recorded against the wrong game.
            stageFinishedGame();
            mockSocketConnected = false;
            useGameStore.getState().sendOnlineStats();

            // Flushed halfway through the window, onto a socket that answers
            // nothing.
            rejoinAfter(HALF_PARK_WINDOW_MS);
            expect(emitsOf('endGameStats'), 'the flush must actually have sent it').toHaveLength(1);

            // Ack deadline, then the backoff — and the transport is gone by
            // the time the resend fires, so it parks.
            vi.advanceTimersByTime(STATS_SUBMIT_ACK_TIMEOUT_MS);
            mockSocketConnected = false;
            vi.advanceTimersByTime(statsSubmitRetryDelayMs(FIRST_ATTEMPT));

            mockEmit.mockClear();
            rejoinAfter(
              PARKED_EMIT_MAX_AGE_MS + 1
              - HALF_PARK_WINDOW_MS - STATS_SUBMIT_ACK_TIMEOUT_MS - statsSubmitRetryDelayMs(FIRST_ATTEMPT),
            );

            expect(
              emitsOf('endGameStats'),
              'the resend re-stamped the submission, so it outlived the bound',
            ).toHaveLength(0);
            expect(emitsOf('submitGlobalStats')).toHaveLength(0);
          });
        });
      });
    });

    // A join ack is the one message that arrives with no room attached: it is
    // what SETS roomId/mode, so it cannot be checked against them. Without a
    // per-attempt epoch, a late ack from an abandoned join rewrote a live local
    // game into `mode: 'online'` under a foreign name, and rewrote the stored
    // session key with it.
    describe('a join this client walked away from', () => {
      const startJoin = () => {
        const pending = useGameStore.getState().joinRoom('ROOM1', 'Alice');
        const join = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'));
        return { pending, ack: join[2] as (res: JoinRoomResponse) => void };
      };

      it('leaves the game the client moved on to untouched, and still settles its promise', async () => {
        const { pending, ack } = startJoin();

        // The player gives up on the join and plays locally instead.
        useGameStore.getState().leaveRoom();
        useGameStore.setState({ mode: 'local', isOnline: false, players: namedPlayers('Ann', 'Ben') });
        mockEmit.mockClear();

        ack({ success: true, isHost: true, name: 'Alice', roomId: 'ROOM1' });

        const state = useGameStore.getState();
        expect(state.mode, 'a stale ack must not drag a local game online').toBe('local');
        expect(state.roomId).toBeNull();
        expect(state.myName).toBeNull();
        expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
        // Never: the server's leaveRoom takes no room argument and vacates
        // whatever the session points at, so tidying up this way would eject
        // the player from the room they are legitimately in.
        expect(emittedEvents()).not.toContain('leaveRoom');
        // Resolved, not abandoned — OnlineLobby and App.tsx both await it.
        await expect(pending).resolves.toMatchObject({ success: true });
      });

      const abandonPaths: [string, () => void][] = [
        ['leaveRoom', () => useGameStore.getState().leaveRoom()],
        ['cancelReconnect', () => useGameStore.getState().cancelReconnect()],
        ['reset', () => useGameStore.getState().reset()],
        // surrenderSeat inlines its own teardown instead of calling leaveRoom,
        // so it has to invalidate the attempt itself. Seated first because a
        // kick is only reachable for a client that holds a seat — the handler
        // now drops one addressed to a room this store never entered, which is
        // what stops a straggling kick from clearing a local game.
        ['a kick', () => {
          useGameStore.setState({ roomId: 'PREVIOUS_ROOM', mode: 'online', isOnline: true });
          mockOnHandlers['kicked']();
        }],
      ];

      it.each(abandonPaths)('%s invalidates an attempt still in flight', async (_name, abandon) => {
        const { pending, ack } = startJoin();

        abandon();
        ack({ success: true, isHost: true, name: 'Alice', roomId: 'ROOM1' });

        expect(useGameStore.getState().roomId).toBeNull();
        expect(useGameStore.getState().mode).toBe('local');
        await expect(pending).resolves.toMatchObject({ success: true });
      });

      it('does not fire on a legitimate first join, whose ack is what sets the room', async () => {
        const { pending, ack } = startJoin();

        ack({ success: true, isHost: true, name: 'Alice', roomId: 'ROOM1' });

        expect(useGameStore.getState().roomId).toBe('ROOM1');
        expect(useGameStore.getState().mode).toBe('online');
        await expect(pending).resolves.toMatchObject({ success: true });
      });
    });

    // The window the gameState guard already existed for: leaveRoom and the
    // kicked/seatTakenOver surrender flip the store out of the room before the
    // server has processed the leave, so everything it emitted during that
    // round trip still arrives. Five of the six handlers applied it anyway —
    // one shared `inRoom` guard is what stops them drifting apart again.
    describe('every room handler is gated on actually holding a room', () => {
      const roomOnlyHandlers: [string, () => void, () => void][] = [
        ['gameState', () => mockOnHandlers['gameState']({ round: 9, players: namedPlayers('Stranger') }), () => {
          expect(useGameStore.getState().round).toBe(1);
          expect(useGameStore.getState().players).toEqual([]);
        }],
        ['hostId', () => mockOnHandlers['hostId']('socket-123'), () => {
          expect(useGameStore.getState().isHost).toBe(false);
          expect(useGameStore.getState().hostId).toBeNull();
        }],
        ['liveTurnState', () => mockOnHandlers['liveTurnState']({ liveTurnState: makeSnapshot({ turnScore: 500 }) }), () => {
          expect(useGameStore.getState().liveTurnState).toBeNull();
        }],
        ['playerReaction', () => mockOnHandlers['playerReaction']({ id: 1, emoji: '🔥', senderName: 'Stranger', senderColor: '#fff' }), () => {
          expect(useGameStore.getState().reactions).toEqual([]);
        }],
        ['playerDisconnected', () => mockOnHandlers['playerDisconnected']('Stranger'), () => {
          expect(useGameStore.getState().toasts).toEqual([]);
        }],
        ['nameConflictWithDisconnected', () => mockOnHandlers['nameConflictWithDisconnected']('Stranger'), () => {
          expect(useGameStore.getState().toasts).toEqual([]);
        }],
        // The two destructive ones: both run surrenderSeat, which clears the
        // room state and flips to local mode -- and the local persistence
        // subscriber writes on any set() made while mode is 'local', so
        // arriving after this client has already left would empty a RESTORED
        // LOCAL GAME and overwrite its save on disk.
        ['seatTakenOver', () => mockOnHandlers['seatTakenOver'](), () => {
          expect(useGameStore.getState().toasts).toEqual([]);
          expect(useGameStore.getState().mode, 'no surrender, so no flip to local').toBe('online');
        }],
        ['gameAborted', () => mockOnHandlers['gameAborted'](), () => {
          expect(useGameStore.getState().toasts).toEqual([]);
        }],
      ];

      it.each(roomOnlyHandlers)('%s does nothing once the room is gone', (_name, drive, expectUntouched) => {
        // Still online — this is the leave that keeps the user on the join
        // form, which the mode check alone cannot see.
        useGameStore.setState({ mode: 'online', isOnline: true, roomId: null });

        drive();

        expectUntouched();
      });
    });

    it('playerDisconnected adds a toast with reconnectTimeout', () => {
      useGameStore.setState({ ...seatedInRoom, reconnectTimeout: 45 });
      expect(mockOnHandlers['playerDisconnected']).toBeTypeOf('function');
      mockOnHandlers['playerDisconnected']('Alice');

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message.includes('Alice disconnected! They have 45 seconds to reconnect.'))).toBe(true);
    });

    it('playerDisconnected omits the reconnect deadline when the kick timer is disabled (reconnectTimeout 0)', () => {
      // reconnectTimeout: 0 means the server never auto-kicks a disconnected
      // player (see server/socketHandlers.ts) — a "N seconds to reconnect"
      // message would invent a deadline that doesn't exist.
      useGameStore.setState({ ...seatedInRoom, reconnectTimeout: 0 });
      expect(mockOnHandlers['playerDisconnected']).toBeTypeOf('function');
      mockOnHandlers['playerDisconnected']('Alice');

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message === 'Alice disconnected!')).toBe(true);
      expect(toasts.some(t => t.message.includes('seconds to reconnect'))).toBe(false);
    });

    it('nameConflictWithDisconnected adds a warning toast', () => {
      useGameStore.setState(seatedInRoom);
      expect(mockOnHandlers['nameConflictWithDisconnected']).toBeTypeOf('function');
      mockOnHandlers['nameConflictWithDisconnected']('Bob');

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message.includes('Someone tried to join as "Bob", which belongs to a disconnected player'))).toBe(true);
    });

    it('connect event emits joinRoom if roomId and myName exist', () => {
      useGameStore.setState({ roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice' });
      localStorage.setItem('tutto_color', '#ff0000');
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(mockEmit).toHaveBeenCalledWith('joinRoom', expect.objectContaining({
        roomId: 'ROOM1',
        name: 'Alice',
        deviceId: 'dev-alice',
        color: '#ff0000',
      }), expect.any(Function));
    });

    it('a failed auto-rejoin clears the reconnect popup and drops back to the join form', () => {
      // The seat being unrecoverable (room deleted, name reclaimed) is
      // permanent — without this the "attempting to reconnect" popup stayed up
      // forever because only a gameState event ever cleared it.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'GONE_ROOM', myName: 'Alice', deviceId: 'dev-alice',
        isHost: true, hostId: 'socket-123',
        status: 'playing', currentPlayerIndex: 0,
        players: namedPlayers('Alice', 'Bob'),
        showReconnectPopup: true,
      });
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'GONE_ROOM', myName: 'Alice' }));
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: false, error: 'Username already exists in this room' });

      const s = useGameStore.getState();
      expect(s.showReconnectPopup).toBe(false);
      expect(s.roomId).toBeNull();
      expect(s.myName).toBeNull();
      expect(s.isHost).toBe(false);
      expect(s.hostId).toBeNull();
      expect(s.status).toBe('lobby');
      expect(s.players).toEqual([]);
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(s.toasts.some(t => t.message.includes('Username already exists'))).toBe(true);
    });

    it('translates a refusal the server named a code for, instead of toasting its English prose', () => {
      // The server sends prose AND a stable code (JOIN_REFUSAL_CODES); the
      // prose is English whatever the player's language is, so the code is
      // what the toast should actually be built from.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'GONE_ROOM', myName: 'Alice', deviceId: 'dev-alice',
        showReconnectPopup: true,
      });
      mockEmit.mockClear();

      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: false, code: 'name_taken', error: 'Username already exists in this room' });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages).toContain('That name is already taken in this room.');
      expect(messages.some(m => m.includes('Username already exists'))).toBe(false);
    });

    it('falls back to the raw prose for a refusal carrying no code', () => {
      // An older server, or a refusal this client has no key for: the player
      // still learns why, just untranslated.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'GONE_ROOM', myName: 'Alice', deviceId: 'dev-alice',
      });
      mockEmit.mockClear();

      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      joinRoomCall[2]({ success: false, error: 'Refused for a reason this client predates' });

      expect(useGameStore.getState().toasts.map(t => t.message))
        .toContain('Refused for a reason this client predates');
    });

    it('marks the automatic rejoin as a reconnect on the wire', () => {
      // The server (server/socketRoomHandlers.ts, item A10) only refuses to
      // CREATE a missing room for a join carrying isReconnect — an automatic
      // rejoin that omitted it would silently fall back to being treated as a
      // fresh join and recreate the room the client is trying to get back into.
      useGameStore.setState({ roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice' });
      mockEmit.mockClear();

      mockOnHandlers['connect']();

      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      expect(joinRoomCall[1]).toMatchObject({ isReconnect: true });
    });

    it('a room-gone auto-rejoin refusal lands back on local Home, not the online join form', () => {
      // Item A10: before the server refused to recreate a missing room, this
      // exact shape (mode 'online', status still 'playing' from before the
      // drop, an existing roster) is what let a rejoin silently succeed into
      // a brand-new empty lobby and made the FOLLOWING gameState broadcast
      // (status 'playing' -> 'lobby' with >=2 players still seated) read as
      // the host ending the game early (see the gameState handler above).
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'RESTARTED_ROOM', myName: 'Alice', deviceId: 'dev-alice',
        isHost: true, hostId: 'socket-123',
        status: 'playing', currentPlayerIndex: 0,
        players: namedPlayers('Alice', 'Bob'),
        showReconnectPopup: true,
        pendingReconnectSession: { roomId: 'RESTARTED_ROOM', myName: 'Alice' },
      });
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'RESTARTED_ROOM', myName: 'Alice' }));
      mockEmit.mockClear();

      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: false, code: 'room-gone', error: 'This game no longer exists on the server.' });

      const s = useGameStore.getState();
      expect(s.mode).toBe('local');
      expect(s.roomId).toBeNull();
      expect(s.pendingReconnectSession).toBeNull();
      expect(s.showReconnectPopup).toBe(false);
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(s.toasts.map(t => t.message)).toContain('That game is no longer on the server.');

      // Even a late, racing gameState broadcast for the old room (a lobby
      // status with the roster that used to trip the false toast) is now
      // discarded outright — mode/roomId no longer describe an online seat.
      mockOnHandlers['gameState']({
        status: 'lobby',
        players: namedPlayers('Alice', 'Bob'),
      });
      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Host ended game early'))).toBe(false);
    });

    it('a successful auto-rejoin keeps the room state and only refreshes isHost', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice', isHost: false,
        players: namedPlayers('Alice', 'Bob'),
      });
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: true, isHost: true });

      const s = useGameStore.getState();
      expect(s.roomId).toBe('ROOM1');
      expect(s.myName).toBe('Alice');
      expect(s.isHost).toBe(true);
      expect(s.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
    });
  });

  // "abc" and "ABC" used to be two different rooms end to end. joinRoom
  // normalizes the id it is given (see normalizeRoomId in configValidation.ts)
  // before it is ever emitted, sent to the server, or written into the store —
  // so a lower-case type-in still ends up asking for, and remembering, the
  // canonical room.
  describe('joinRoom normalizes the room id it is given', () => {
    it('emits the canonical (upper-cased) form, not what was typed', async () => {
      mockEmit.mockClear();
      const joining = useGameStore.getState().joinRoom('abc', 'Alice', false);
      const join = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'));
      expect(join[1].roomId).toBe('ABC');
      join[2]({ success: true, isHost: true, name: 'Alice', roomId: 'ABC' });
      await joining;
    });

    it('trims surrounding whitespace before emitting', async () => {
      mockEmit.mockClear();
      const joining = useGameStore.getState().joinRoom('  abc  ', 'Alice', false);
      const join = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'));
      expect(join[1].roomId).toBe('ABC');
      join[2]({ success: true, isHost: true, name: 'Alice', roomId: 'ABC' });
      await joining;
    });

    it('stores the canonical id from the ack, not the one it sent, when the two differ', async () => {
      // Defence in depth for an older/mismatched server: this client already
      // normalized before sending, so in practice the two agree — but the
      // store must prefer whatever the server actually seated it under.
      mockEmit.mockClear();
      const joining = useGameStore.getState().joinRoom('abc', 'Alice', false);
      const join = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'));
      join[2]({ success: true, isHost: true, name: 'Alice', roomId: 'ABC-RENAMED' });
      await joining;

      expect(useGameStore.getState().roomId).toBe('ABC-RENAMED');
      expect(JSON.parse(nonNull(sessionStorage.getItem('tutto_online_session')))).toEqual({
        roomId: 'ABC-RENAMED', myName: 'Alice',
      });
    });

    it('falls back to its own normalized id when an older ack carries none', async () => {
      mockEmit.mockClear();
      const joining = useGameStore.getState().joinRoom('abc', 'Alice', false);
      const join = nonNull(mockEmit.mock.calls.find(([event]) => event === 'joinRoom'));
      join[2]({ success: true, isHost: true, name: 'Alice' });
      await joining;

      expect(useGameStore.getState().roomId).toBe('ABC');
    });
  });

  describe('legacy config fallback', () => {
    it('setMode(local) parses and merges config from localStorage fallback', () => {
      const legacyState = { winningScore: 7000, randomOrder: false, turnDuration: 300, reconnectTimeout: 120, initialCards: { '200': 10 } };
      localStorage.setItem('tutto_local_game', JSON.stringify(legacyState));

      useGameStore.getState().setMode('local');
      const state = useGameStore.getState();

      expect(state.winningScore).toBe(7000);
      expect(state.randomOrder).toBe(false);
      expect(state.turnDuration).toBe(300);
      expect(state.reconnectTimeout).toBe(120);
      expect(state.initialCards['200']).toBe(10);
    });
  });

  describe('enforcedDiceMode mode-switch resets', () => {
    it('setMode(local) resets a leftover enforcedDiceMode from a previous online room', () => {
      useGameStore.setState({ enforcedDiceMode: 'digital' });
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setMode(online) does not carry a stale enforcedDiceMode into a fresh room join', () => {
      useGameStore.setState({ enforcedDiceMode: 'digital' });
      localStorage.removeItem('tutto_online_config');
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setMode(online) restores a saved enforcedDiceMode from a previous hosted room', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 6000, randomOrder: true, turnDuration: 120, reconnectTimeout: 60,
        initialCards: { '200': 10 }, enforcedDiceMode: 'physical',
      }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().enforcedDiceMode).toBe('physical');
      localStorage.removeItem('tutto_online_config');
    });
  });

  describe('ruleset mode-switch resets', () => {
    it('setMode(local) with no local save resets a leftover online ruleset', () => {
      // Staged from ONLINE mode: in local mode the persistence subscriber
      // would immediately save the staged ruleset as a local game, and the
      // switch would (correctly) restore it instead of resetting.
      localStorage.removeItem('tutto_online_config');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ ruleset: 'classic' });
      localStorage.removeItem('tutto_local_game');
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().ruleset).toBe('modernized');
    });

    it('setMode(local) restores the ruleset a saved local game was played by', () => {
      // Unlike enforcedDiceMode, the ruleset IS part of a local save — it
      // decides how the resumed game actually plays.
      localStorage.setItem('tutto_local_game', JSON.stringify({ ruleset: 'classic', round: 2 }));
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().ruleset).toBe('classic');
      localStorage.removeItem('tutto_local_game');
    });

    it('setMode(online) restores a saved ruleset from a previous hosted room', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({ ruleset: 'classic' }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().ruleset).toBe('classic');
      localStorage.removeItem('tutto_online_config');
    });

    it('setMode(online) with no saved config falls back to modernized', () => {
      localStorage.removeItem('tutto_online_config');
      useGameStore.setState({ ruleset: 'classic' });
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().ruleset).toBe('modernized');
    });
  });

  describe('socket disconnect behavior', () => {
    it('sets showReconnectPopup when disconnected unexpectedly while seated in a room', () => {
      // Connect to online mode
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'ROOM1', myName: 'Alice' });

      // Ensure the 'disconnect' handler was registered
      expect(mockOnHandlers['disconnect']).toBeDefined();

      // Trigger unexpected disconnect
      mockOnHandlers['disconnect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(true);
    });

    it('does NOT set showReconnectPopup when online without a seat to reclaim', () => {
      // Sitting on the online join form (left the room / finished the game):
      // there is nothing to reconnect TO, so the full-screen "attempting to
      // reconnect" modal reports a loss the player cannot act on.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: null, myName: null });

      expect(mockOnHandlers['disconnect']).toBeTypeOf('function');
      mockOnHandlers['disconnect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
    });

    it('lowers a raised reconnect popup on connect when there is nothing to rejoin', () => {
      // The other half of the same bug: without this, a popup raised while
      // seatless stayed up after the connection came back, because the
      // 'connect' handler only ever acted when a seat was worth reclaiming.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: null, myName: null, showReconnectPopup: true });
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(emittedEvents()).not.toContain('joinRoom');
    });

    it('leaves the popup up on connect while a session restore is still in flight', () => {
      // The restore prompt raises the popup itself and only then calls
      // joinRoom — the store holds no roomId (and is still in local mode)
      // until the server acks, so the reconnect that carries that very join
      // must not pull the modal out from under it.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ mode: 'local', roomId: null, myName: null, showReconnectPopup: true });

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(true);
    });

    it('still attempts the auto-rejoin, popup and all, when a seat is held', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice', showReconnectPopup: true,
      });
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(mockEmit).toHaveBeenCalledWith('joinRoom', expect.objectContaining({
        roomId: 'ROOM1', name: 'Alice', deviceId: 'dev-alice',
      }), expect.any(Function));
      // Still "attempting to reconnect" until the ack decides the seat's fate.
      expect(useGameStore.getState().showReconnectPopup).toBe(true);
    });

    it('does NOT set showReconnectPopup when intentionally disconnecting by setting local mode', () => {
      // Connect to online mode
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');

      // Intentional disconnect (e.g. clicking "Leave" sets mode to local)
      useGameStore.getState().setMode('local');

      // Ensure mockDisconnect was called
      expect(mockDisconnect).toHaveBeenCalled();

      // Trigger 'disconnect' event (simulating what socket.io would do after disconnect() is called)
      // Asserted, not guarded: a missing handler would make the expectation
      // below pass without anything having happened.
      expect(mockOnHandlers['disconnect']).toBeTypeOf('function');
      mockOnHandlers['disconnect']();

      // showReconnectPopup should be false because mode is local
      expect(useGameStore.getState().showReconnectPopup).toBe(false);
    });
  });

  describe('online session recovery', () => {
    it('restores pendingReconnectSession from sessionStorage on init', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));
      useGameStore.getState().init('dev-123');
      
      const state = useGameStore.getState();
      expect(state.pendingReconnectSession).toEqual({ roomId: 'TEST_ROOM', myName: 'Alice' });
    });

    // The stored session was the one entry read back with a bare cast: a
    // half-written or corrupted value reached the restore prompt intact and
    // asked whether to reconnect to "room (undefined)" — and answering yes
    // then joined a room named `undefined`.
    it.each([
      ['an object missing both fields', '{}'],
      ['a name without a room', JSON.stringify({ myName: 'Alice' })],
      ['a non-string room id', JSON.stringify({ roomId: 7, myName: 'Alice' })],
      ['a non-JSON value', 'not json'],
    ])('drops %s instead of prompting for it', (_label, stored) => {
      sessionStorage.setItem('tutto_online_session', stored);
      useGameStore.getState().init('dev-123');

      expect(useGameStore.getState().pendingReconnectSession).toBeFalsy();
      // Removed, so the next mount does not re-read the same broken value.
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
    });

    it('normalises a lower-case stored room id on init', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'test_room', myName: 'Alice' }));
      useGameStore.getState().init('dev-123');

      expect(useGameStore.getState().pendingReconnectSession).toEqual({ roomId: 'TEST_ROOM', myName: 'Alice' });
      expect(sessionStorage.getItem('tutto_online_session'), 'a usable session stays put').not.toBeNull();
    });

    it('clears sessionStorage when leaving a room intentionally', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));
      useGameStore.getState().leaveRoom();

      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
    });

    it('a kick that arrives after the client already left leaves the local game alone', () => {
      // leaveRoom does not disconnect the socket, so anything the server
      // emitted during the leave round trip still arrives. Home and
      // OnlineLobby both follow leaveRoom() with setMode('local'), which
      // restores the saved local game synchronously — so an unguarded kick
      // landing a moment later ran surrenderSeat over that restored game, and
      // because the local persistence subscriber writes on any set() made in
      // local mode, the emptied roster went straight to disk on top of the
      // save. Unrecoverable, from a room the player had already left.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().leaveRoom();
      useGameStore.setState({
        mode: 'local', isOnline: false, roomId: null,
        players: [makeOnlinePlayer('Alice', { score: 2400 }), makeOnlinePlayer('Bob', { score: 1500 })],
        status: 'playing', currentPlayerIndex: 1, round: 4,
      });

      mockOnHandlers['kicked']();

      const after = useGameStore.getState();
      expect(after.players.map(p => p.name), 'the local roster survived the stray kick').toEqual(['Alice', 'Bob']);
      expect(after.players[0].score).toBe(2400);
      expect(after.status).toBe('playing');
      expect(after.round).toBe(4);
      expect(after.currentPlayerIndex).toBe(1);
      expect(after.toasts, 'and no kick toast for a room the player already left').toEqual([]);
    });

    it('clears session/room state, toasts, and returns to local mode when kicked from a room', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));

      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        roomId: 'TEST_ROOM', isHost: true, hostId: 'socket-123', myName: 'Alice',
        // The room's in-progress game — without clearing these too, a kicked
        // player with no saved local game (setMode('local') only overwrites
        // keys a save happens to contain) would land on the local lobby still
        // showing the online roster and mid-game state (bug: kicked bleed).
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Stop', round: 3,
        liveTurnState: { turnScore: 50, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });

      expect(mockOnHandlers['kicked']).toBeTypeOf('function');
      mockOnHandlers['kicked']();

      const state = useGameStore.getState();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(state.roomId).toBeNull();
      expect(state.isHost).toBe(false);
      expect(state.hostId).toBeNull();
      expect(state.myName).toBeNull();
      expect(state.mode).toBe('local');
      expect(state.isOnline).toBe(false);
      expect(state.toasts.map(t => t.message)).toContain('You were kicked by the host');
      expect(state.players).toEqual([]);
      expect(state.status).toBe('lobby');
      expect(state.currentPlayerIndex).toBeNull();
      expect(state.currentCard).toBeNull();
      expect(state.round).toBe(1);
      expect(state.finished).toBe(false);
      expect(state.liveTurnState).toBeNull();
    });

    it('lowers the reconnect popup when a kick lands while it is still up', () => {
      // A drop raises the full-screen "Connection Lost" modal (see the
      // 'disconnect' handler); if the rejoin that follows finds the seat
      // already lost (kicked while away), surrenderSeat used to tear the room
      // down and flip to local mode without ever lowering the popup — it is
      // not one of the synced game-state fields a 'gameState' broadcast (the
      // only other thing that clears it) would ever arrive to fix, so it sat
      // over local Home, non-dismissible, forever.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        roomId: 'TEST_ROOM', isHost: false, myName: 'Alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        status: 'playing', currentPlayerIndex: 0, round: 3,
        showReconnectPopup: true,
      });

      mockOnHandlers['kicked']();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
    });

    it('surrenders the seat the same way when the same device takes it over elsewhere', () => {
      // The server moves the seat to the new connection and drops this one
      // from the channel. Silently, that left this window holding a full
      // roster on a healthy socket whose every event the server ignores — the
      // player could open the dice panel and commit turns into a void while
      // the turn timer ran out on the seat they thought they had.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        roomId: 'TEST_ROOM', isHost: true, hostId: 'socket-123', myName: 'Alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        status: 'playing', currentPlayerIndex: 0, round: 3,
      });

      expect(mockOnHandlers['seatTakenOver']).toBeTypeOf('function');
      mockOnHandlers['seatTakenOver']();

      const state = useGameStore.getState();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(state.roomId).toBeNull();
      expect(state.myName).toBeNull();
      expect(state.isHost).toBe(false);
      expect(state.mode).toBe('local');
      expect(state.players).toEqual([]);
      expect(state.status).toBe('lobby');
      // Its own wording — nobody kicked them.
      expect(state.toasts.map(t => t.message))
        .toEqual(['This device joined the room from somewhere else, so this window left it.']);
    });

    it('clears pendingReconnectSession when clearPendingReconnect is called', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));
      useGameStore.setState({ pendingReconnectSession: { roomId: 'TEST_ROOM', myName: 'Alice' } });

      useGameStore.getState().clearPendingReconnect();

      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    });

    it('sets justReconnected when reconnecting with active game (status=playing), independent of liveTurnState', () => {
      // Registers the gameState handler this test drives. It used to lean on
      // a socket an EARLIER test had connected, which the shared afterEach
      // now tears down — under --sequence.shuffle there was none.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        roomId: 'R1',
        showReconnectPopup: true,
        status: 'playing',
        currentPlayerIndex: 1,
        liveTurnState: null,  // Explicitly no dice game in progress
      });

      // Simulate incoming gameState while disconnected
      const newState = {
        status: 'playing',
        currentPlayerIndex: 1,
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        liveTurnState: null,  // Still no dice game
        gameTimeInSeconds: 45,
        turnTimeRemaining: 30,
      };

      // Simulate socket.io 'gameState' event
      mockOnHandlers['gameState'](newState);

      // justReconnected should be set despite no liveTurnState
      expect(useGameStore.getState().justReconnected).toBe(true);
      expect(useGameStore.getState().liveTurnState).toBeNull();
    });

    it('does NOT set justReconnected when reconnecting with non-playing status', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        roomId: 'R1',
        showReconnectPopup: true,
        status: 'lobby',  // Game not started
        currentPlayerIndex: null,
      });

      const newState = {
        status: 'lobby',
        currentPlayerIndex: null,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: null,
      };

      mockOnHandlers['gameState'](newState);

      // justReconnected should NOT be set when status is not 'playing'
      expect(useGameStore.getState().justReconnected).toBe(false);
    });

    it('timer sync uses server turnTimeRemaining even without liveTurnState (same ongoing turn)', () => {
      // Prime internal tracking so player=0/card=Kniffel is the "known" turn
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'R1', status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, gameTimeInSeconds: 20,
        liveTurnState: null, justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers();

      // Simulate reconnect: same player, same card, server sends remaining=25
      useGameStore.setState({
        justReconnected: true,
        turnTimeRemaining: 25,  // Server calculated: 60 - 35 elapsed = 25 remaining
      });

      useGameStore.getState().syncOnlineTimers();

      // Same turn + reconnect → timer must use server's remaining time (25), not full 60
      expect(useGameStore.getState().turnTimeRemaining).toBe(25);
    });

    it('justReconnected flag persists across a syncOnlineTimers call — only the gameState handler clears it', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        roomId: 'R1',
        status: 'playing',
        currentPlayerIndex: 0,
        currentCard: 'Stop',
        turnDuration: 60,
        gameTimeInSeconds: 10,
        gameStartTime: Date.now() - 10000,
        liveTurnState: null,
        justReconnected: true,
      });

      useGameStore.getState().syncOnlineTimers();

      // syncOnlineTimers must NOT clear justReconnected — it's consulted (not
      // reset) there to decide whether to reuse the server's turnTimeRemaining.
      expect(useGameStore.getState().justReconnected).toBe(true);
    });

    it('the gameState handler self-clears justReconnected on the next event that is not itself a reconnect', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        roomId: 'R1',
        showReconnectPopup: true,
        status: 'playing',
        currentPlayerIndex: 0,
      });

      // First event: a genuine reconnect — sets the flag.
      mockOnHandlers['gameState']({
        status: 'playing',
        currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: null,
      });
      expect(useGameStore.getState().justReconnected).toBe(true);

      // Second event: an ordinary update, not a fresh reconnect (showReconnectPopup
      // is already false by now) — must clear the flag rather than leaving it
      // stuck true for a future, unrelated turn to pick up.
      mockOnHandlers['gameState']({
        status: 'playing',
        currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: { turnScore: 50, keptDice: [], currentRoll: [] },
      });
      expect(useGameStore.getState().justReconnected).toBe(false);
    });

    it('does NOT set justReconnected on a normal gameState update (not a reconnect)', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        showReconnectPopup: false,  // Not disconnected — normal steady-state
        status: 'playing',
        currentPlayerIndex: 0,
        justReconnected: false,
      });

      const newState = {
        status: 'playing',
        currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: null,
        gameTimeInSeconds: 15,
        turnTimeRemaining: 45,
      };

      mockOnHandlers['gameState'](newState);

      // Most gameState events are NOT reconnects — justReconnected must stay false
      expect(useGameStore.getState().justReconnected).toBe(false);
    });

    it('syncOnlineTimers uses full turn duration when NOT reconnecting (justReconnected=false)', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        currentCard: 'Kniffel',
        turnDuration: 60,
        turnTimeRemaining: 5,   // Stale leftover from previous countdown
        justReconnected: false, // Normal new turn — not a reconnect
      });

      useGameStore.getState().syncOnlineTimers();

      // Must reset to full duration (60), not re-use the stale 5
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    it('syncOnlineTimers uses server turnTimeRemaining when justReconnected=true AND same player/card (ongoing turn)', () => {
      // turnTimerPlayerIndex/Card start null, so first call always sets them — we need
      // to prime the internal state by running a first sync, then simulate a reconnect
      // where player + card are unchanged.
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, turnTimeRemaining: 40,
        justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers(); // prime internal tracking vars

      // Now simulate reconnect: same player, same card, justReconnected=true
      useGameStore.setState({ justReconnected: true, turnTimeRemaining: 25 });
      useGameStore.getState().syncOnlineTimers();

      // Same turn + reconnect → use server's remaining time (25), not full duration (60)
      expect(useGameStore.getState().turnTimeRemaining).toBe(25);
    });

    it.each([
      ['Feuerwerk', 3],
      ['Kleeblatt', 2],
      ['200',       1],
      ['Stop',      1],
    ] as const)('syncOnlineTimers applies %s turn multiplier (%dx)', (card, multiplier) => {
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: card,
        turnDuration: 60, justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(60 * multiplier);
    });

    it('stopOnlineTimers clears both game and turn timer state', () => {
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, turnTimeRemaining: 30,
      });
      useGameStore.getState().syncOnlineTimers(); // start timers
      useGameStore.getState().stopOnlineTimers();
      // turnTimeRemaining is NOT reset by stopOnlineTimers (only by syncOnlineTimers/setMode)
      // but the internal interval tracking vars should be cleared — verified indirectly:
      // a subsequent syncOnlineTimers must treat the card as "new" and reset to full duration.
      useGameStore.setState({ turnTimeRemaining: 5 });
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    it('syncOnlineTimers uses full turn duration when justReconnected=true but player changed (new turn)', () => {
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, turnTimeRemaining: 3, // nearly-expired from previous turn
        justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers(); // prime: player=0, card=Kniffel

      // New turn starts while justReconnected is still true
      useGameStore.setState({ currentPlayerIndex: 1, justReconnected: true, turnTimeRemaining: 3 });
      useGameStore.getState().syncOnlineTimers();

      // playerChanged=true must win over justReconnected → full duration, not 3
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    it('adopts the server turnTimeRemaining on reconnect even when the turn tracking is fresh (page reload)', () => {
      // After a page reload the module-level turn tracking vars are empty (the
      // beforeEach _resetTimersForTests() mirrors that), so playerChanged is
      // true. The gameState answering the rejoin carries the server's actual
      // remaining time — that value must win over the "new turn → full
      // duration" heuristic, or the countdown shows a full turn mid-turn.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'R1', showReconnectPopup: true,
        status: 'playing', turnDuration: 60,
      });

      mockOnHandlers['gameState']({
        status: 'playing', currentPlayerIndex: 1, currentCard: 'Kniffel',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        turnDuration: 60, turnTimeRemaining: 25, gameTimeInSeconds: 30,
      });

      expect(useGameStore.getState().justReconnected).toBe(true);
      expect(useGameStore.getState().turnTimeRemaining).toBe(25);

      // Later tests expect no lingering module-level socket (e.g. they assert
      // that joinRoom creates a fresh one).
      disconnectSocket();
    });

    it('restarts the countdown from the server turnTimeRemaining even after the local countdown hit 0', () => {
      vi.useFakeTimers();
      try {
        useGameStore.getState().connectSocket('http://localhost:3000');
        useGameStore.setState({
          mode: 'online', isOnline: true, roomId: 'R1', status: 'playing',
          currentPlayerIndex: 0, currentCard: 'Kniffel', turnDuration: 60,
          showReconnectPopup: false, justReconnected: false,
        });
        useGameStore.getState().syncOnlineTimers(); // prime: full 60s countdown
        vi.advanceTimersByTime(61_000); // countdown reaches 0 and its interval self-clears
        expect(useGameStore.getState().turnTimeRemaining).toBe(0);

        // A mid-turn broadcast for the SAME player/card carrying the
        // authoritative remaining time (e.g. the host raised turnDuration
        // mid-turn): the display must resume counting from the server value
        // instead of staying frozen at 0 with its interval gone.
        mockOnHandlers['gameState']({
          status: 'playing', currentPlayerIndex: 0, currentCard: 'Kniffel',
          players: [makeOnlinePlayer('Alice')],
          turnDuration: 60, turnTimeRemaining: 30, gameTimeInSeconds: 43,
        });
        expect(useGameStore.getState().turnTimeRemaining).toBe(30);

        vi.advanceTimersByTime(1000);
        expect(useGameStore.getState().turnTimeRemaining).toBe(29);
      } finally {
        disconnectSocket();
        vi.useRealTimers();
      }
    });

    describe('server-authoritative game time sync', () => {
    it('startGame initializes gameTimeInSeconds to 0', () => {
      useGameStore.setState({
        mode: 'local',
        isOnline: false,
        players: [makeOnlinePlayer('Alice')],
      });

      useGameStore.getState().startGame();

      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
      expect(useGameStore.getState().status).toBe('playing');
    });

    it('syncOnlineTimers sets gameStartTime from server gameTimeInSeconds', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 45,  // Server says 45 seconds elapsed
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();

      // Compute elapsed AFTER sync so both Date.now() calls are nearly simultaneous
      const state = useGameStore.getState();
      const elapsedSeconds = Math.floor((Date.now() - nonNull(state.gameStartTime)) / 1000);
      expect(elapsedSeconds).toBe(45);
    });

    it('local timer increments between server syncs', () => {
      // Fake timers instead of a real 1100ms wait: under a loaded test run, a
      // real setInterval(..., 1000) can fire late enough that a 1100ms wait
      // observes zero ticks, making this test flaky (it failed intermittently
      // in the full suite while passing in isolation).
      vi.useFakeTimers();
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 10,
        turnDuration: 60,
      });

      useGameStore.getState().syncOnlineTimers();
      const initialTime = useGameStore.getState().gameTimeInSeconds;

      vi.advanceTimersByTime(1100);

      // Timer should have incremented by ~1
      const afterWait = useGameStore.getState().gameTimeInSeconds;
      expect(afterWait).toBeGreaterThanOrEqual(initialTime + 1);
      vi.useRealTimers();
    });

    it('reconnect syncs gameStartTime from new server gameTimeInSeconds value', async () => {
      // Simulate: game started 30 seconds ago from server's perspective
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 30,
        gameStartTime: Date.now() - 30000,
      });

      useGameStore.getState().syncOnlineTimers();

      // Server sends updated state: now 35 seconds elapsed
      const newServerTime = 35;
      useGameStore.setState({ gameTimeInSeconds: newServerTime });

      // Resync with new server value
      useGameStore.getState().syncOnlineTimers();

      const state = useGameStore.getState();
      const elapsedMs = Date.now() - nonNull(state.gameStartTime);
      const elapsedSeconds = Math.floor(elapsedMs / 1000);

      // Should reflect new server time (35 seconds)
      expect(elapsedSeconds).toBe(newServerTime);
    });

    it('game time does not drift on repeated syncs', () => {
      vi.useFakeTimers();
      try {
        const syncTimes = [];

        // Simulate 3 syncs over 2+ seconds
        for (let i = 0; i < 3; i++) {
          const serverTime = 10 + i;  // Server advances: 10, 11, 12
          useGameStore.setState({
            mode: 'online',
            isOnline: true,
            status: 'playing',
            currentPlayerIndex: 0,
            gameTimeInSeconds: serverTime,
          });

          useGameStore.getState().syncOnlineTimers();
          const state = useGameStore.getState();
          const elapsedMs = Date.now() - nonNull(state.gameStartTime);
          const elapsedSeconds = Math.floor(elapsedMs / 1000);

          syncTimes.push({ server: serverTime, local: elapsedSeconds });

          // Fast-forward simulated time between syncs
          if (i < 2) vi.advanceTimersByTime(1100);
        }

        // Verify no large drifts between server and local times
        syncTimes.forEach(({ server, local }) => {
          expect(Math.abs(server - local)).toBeLessThanOrEqual(1);
        });
      } finally {
        _resetTimersForTests();
        vi.useRealTimers();
      }
    });

    it('game timer respects gameStartTime being set', () => {
      const targetTime = 25;
      const now = Date.now();

      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: targetTime,
        gameStartTime: now - (targetTime * 1000),  // Pre-calculated start time
      });

      // Manual interval tick
      const s = useGameStore.getState();
      if (s.gameStartTime) {
        const calculated = Math.floor((Date.now() - s.gameStartTime) / 1000);
        expect(calculated).toBe(targetTime);
      }
    });

    it('does not set gameStartTime if gameTimeInSeconds is null', () => {
      setStateWithNullableGameTime({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: null,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();

      // gameStartTime should remain null
      expect(useGameStore.getState().gameStartTime).toBeNull();
    });

    it('does not set gameStartTime if gameTimeInSeconds is negative', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: -1,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();

      // gameStartTime should remain null
      expect(useGameStore.getState().gameStartTime).toBeNull();
    });

    it('does not reset gameStartTime when server lag is ≤2s (prevents backward timer jump on opponent turns)', () => {
      // Client has been running for 46s locally; server sends 45 (1s behind due to Math.floor)
      const originalStart = Date.now() - 46000;
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 45, // server value: 1s behind client
        gameStartTime: originalStart,
      });

      useGameStore.getState().syncOnlineTimers();

      // Drift is 1s ≤ 2s threshold → gameStartTime must NOT be reset
      expect(useGameStore.getState().gameStartTime).toBe(originalStart);
    });

    it('resets gameStartTime when drift exceeds 2s (reconnect or true clock divergence)', () => {
      // Client has stale gameStartTime showing 10s; server says 45s (reconnect scenario)
      const staleStart = Date.now() - 10000;
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 45, // server value: 35s ahead of stale local
        gameStartTime: staleStart,
      });

      useGameStore.getState().syncOnlineTimers();

      // Drift is 35s > 2s threshold → gameStartTime must be updated
      const newStart = useGameStore.getState().gameStartTime;
      expect(newStart).not.toBe(staleStart);
      const newElapsed = Math.floor((Date.now() - nonNull(newStart)) / 1000);
      expect(newElapsed).toBe(45);
    });

    it('game timer increments correctly via gameStartTime reference', () => {
      vi.useFakeTimers();
      // gameTimeInSeconds=0 → syncOnlineTimers sets gameStartTime → interval uses that path
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 0,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();
      const initial = useGameStore.getState().gameTimeInSeconds;

      vi.advanceTimersByTime(1100);

      const afterWait = useGameStore.getState().gameTimeInSeconds;
      expect(afterWait).toBeGreaterThanOrEqual(initial! + 1);
      vi.useRealTimers();
    });

    it('game timer does not tick when gameStartTime is null (null gameTimeInSeconds skips anchor)', () => {
      vi.useFakeTimers();
      // gameTimeInSeconds=null → syncOnlineTimers cannot anchor gameStartTime → timer fires but does nothing
      setStateWithNullableGameTime({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: null,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().gameStartTime).toBeNull(); // Confirm no anchor was set

      vi.advanceTimersByTime(1100);

      // Without gameStartTime the timer interval has nothing to compute — value stays null.
      expect(useGameStore.getState().gameTimeInSeconds).toBeNull();
      vi.useRealTimers();
    });
    });

    it('cancelReconnect (no args) clears showReconnectPopup and local state without connecting', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();

      useGameStore.setState({ showReconnectPopup: true, liveTurnState: makeSnapshot({ turnScore: 50 }) });
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'R1', myName: 'Alice' }));
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 50 }));

      useGameStore.getState().cancelReconnect();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(useGameStore.getState().liveTurnState).toBeNull();
      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      // No temp socket opened — no roomId provided
      expect(io).not.toHaveBeenCalled();
    });

    it('cancelReconnect clears the abandoned room identity and game state ("Return to Main Menu")', () => {
      // Without this, the stale roomId later rendered a phantom joined-room
      // lobby, and the online roster could bleed into local mode — the
      // setMode('local') that follows only overwrites keys a saved local game
      // happens to contain.
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'R1', myName: 'Alice', isHost: true, hostId: 'socket-123',
        status: 'playing', currentPlayerIndex: 1, currentCard: 'Stop',
        cards: ['x2'], round: 4, finished: false,
        players: namedPlayers('Alice', 'Bob'),
        showReconnectPopup: true,
      });

      useGameStore.getState().cancelReconnect();

      const s = useGameStore.getState();
      expect(s.roomId).toBeNull();
      expect(s.myName).toBeNull();
      expect(s.isHost).toBe(false);
      expect(s.hostId).toBeNull();
      expect(s.players).toEqual([]);
      expect(s.status).toBe('lobby');
      expect(s.currentPlayerIndex).toBeNull();
      expect(s.currentCard).toBeNull();
      expect(s.cards).toEqual([]);
      expect(s.round).toBe(1);
    });

    it('cancelReconnect (no args) frees the seat the STORE is holding', async () => {
      // App.tsx's "Return to Main Menu" calls this with no arguments while the
      // store still holds roomId/myName. Without falling back to them the
      // teardown join is never sent, and a room whose reconnectTimeout is 0
      // arms no kick timer server-side — the seat is a permanent ghost.
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'R1', myName: 'Alice', deviceId: 'dev-alice',
        players: namedPlayers('Alice', 'Bob'),
        showReconnectPopup: true,
      });

      useGameStore.getState().cancelReconnect();

      expect(io).toHaveBeenCalledWith(expect.any(String));
      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      // The room identity the store held, even though the local state was
      // already cleared before the temp socket opened.
      expect(joinRoomCall[1]).toMatchObject({ roomId: 'R1', name: 'Alice', isReconnect: true });

      joinRoomCall[2]({ success: true });
      expect(mockEmit).toHaveBeenCalledWith('leaveRoom');
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) without an active store room leaves a restored local game untouched', () => {
      // Declining the restore prompt happens on a fresh page load where the
      // store may already hold a restored LOCAL game. Only the roomId ARGUMENT
      // (the room to leave server-side) is set there — the store's own roomId
      // is null, and nothing in the store may be wiped.
      useGameStore.setState({
        mode: 'local', isOnline: false, roomId: null,
        status: 'playing', currentPlayerIndex: 0, round: 3,
        players: namedPlayers('Carol', 'Dave'),
        pendingReconnectSession: { roomId: 'OLD_ROOM', myName: 'Carol' },
      });

      useGameStore.getState().cancelReconnect('OLD_ROOM', 'Carol');

      const s = useGameStore.getState();
      expect(s.players.map(p => p.name)).toEqual(['Carol', 'Dave']);
      expect(s.status).toBe('playing');
      expect(s.round).toBe(3);
      expect(s.currentPlayerIndex).toBe(0);
    });

    it('joinRoom extracts and emits initialConfig from localStorage', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 8000,
        randomOrder: false,
        turnDuration: 30,
        reconnectTimeout: 10,
        initialCards: { '200': 10 }
      }));

      const joinPromise = useGameStore.getState().joinRoom('CONFIG_ROOM', 'Alice', false);
      expect(io).toHaveBeenCalledWith(expect.any(String));
      mockOnHandlers['connect']();

      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      expect(joinRoomCall[1]).toMatchObject({
        roomId: 'CONFIG_ROOM',
        name: 'Alice',
        initialConfig: {
          winningScore: 8000,
          randomOrder: false,
          turnDuration: 30,
          reconnectTimeout: 10,
          initialCards: { '200': 10 }
        }
      });

      const joinCallback = joinRoomCall[2];
      joinCallback({ success: true, isHost: true });
      await joinPromise;

      const state = useGameStore.getState();
      expect(state.roomId).toBe('CONFIG_ROOM');
      
      // Should show the translated "Saved settings loaded" toast instead of individual ones
      const toasts = state.toasts;
      expect(toasts.some(t => t.message === 'lobby.savedSettingsLoaded' || t.message === 'Saved settings loaded')).toBe(true);
      expect(toasts.some(t => t.message.includes('Winning score'))).toBe(false);

      localStorage.removeItem('tutto_online_config');
    });

    it('joinRoom includes a saved enforcedDiceMode in the transmitted initialConfig', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 8000, randomOrder: false, turnDuration: 30, reconnectTimeout: 10,
        initialCards: { '200': 10 }, enforcedDiceMode: 'digital',
      }));

      const joinPromise = useGameStore.getState().joinRoom('CONFIG_ROOM2', 'Alice', false);
      mockOnHandlers['connect']();

      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall[1].initialConfig).toMatchObject({ enforcedDiceMode: 'digital' });

      joinRoomCall[2]({ success: true, isHost: true });
      await joinPromise;
      localStorage.removeItem('tutto_online_config');
    });

    it('joinRoom includes a saved ruleset in the transmitted initialConfig', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_online_config', JSON.stringify({ ruleset: 'classic' }));

      const joinPromise = useGameStore.getState().joinRoom('CONFIG_ROOM3', 'Alice', false);
      mockOnHandlers['connect']();

      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall[1].initialConfig).toMatchObject({ ruleset: 'classic' });

      joinRoomCall[2]({ success: true, isHost: true });
      await joinPromise;
      localStorage.removeItem('tutto_online_config');
    });

    it('joinRoom adopts the server-confirmed name from the ack (mid-game seat takeover)', async () => {
      // Rejoining a running game with a different name keeps the seat's
      // original name server-side; the client must adopt it or isMyTurn and
      // stats matching (both keyed on myName) silently break.
      mockEmit.mockClear();

      const joinPromise = useGameStore.getState().joinRoom('SEAT_ROOM', 'Impostor', true);
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: true, isHost: false, name: 'Alice' });
      await joinPromise;

      expect(useGameStore.getState().myName).toBe('Alice');
      expect(JSON.parse(nonNull(sessionStorage.getItem('tutto_online_session')))).toEqual({ roomId: 'SEAT_ROOM', myName: 'Alice' });
    });

    it('auto-rejoin adopts the server-confirmed name when provided', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ roomId: 'ROOM1', myName: 'Alicia', deviceId: 'dev-a', mode: 'online', isOnline: true });
      mockEmit.mockClear();

      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: true, isHost: false, name: 'Alice' });

      expect(useGameStore.getState().myName).toBe('Alice');
    });

    it('cancelReconnect(roomId, name) clears state and opens a temp socket to leave the room', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();

      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' }, liveTurnState: makeSnapshot({ turnScore: 10 }) });
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 10 }));

      useGameStore.getState().cancelReconnect('GHOST_ROOM', 'Charlie');

      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
      expect(useGameStore.getState().liveTurnState).toBeNull();
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
      // Temp socket was created
      expect(io).toHaveBeenCalledWith(expect.any(String));

      // Simulate socket connecting and server accepting joinRoom
      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall).toBeTruthy();
      expect(joinRoomCall[1]).toMatchObject({ roomId: 'GHOST_ROOM', name: 'Charlie' });

      // Simulate successful joinRoom callback → should emit leaveRoom
      const joinCallback = joinRoomCall[2];
      joinCallback({ success: true });
      expect(mockEmit).toHaveBeenCalledWith('leaveRoom');
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) marks its throwaway join as a reconnect, so a vanished room is not recreated', async () => {
      // The probe join exists only to release the seat. Sent as an ordinary
      // join, a room the server had already lost (a restart) was created
      // afresh with this client as host and then deleted again by the
      // leaveRoom that follows — needless churn, and a window in which a
      // second player could join a phantom lobby. As a reconnect it is
      // refused with room-gone and nothing is created.
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();

      useGameStore.getState().cancelReconnect('GHOST_ROOM', 'Charlie');
      mockOnHandlers['connect']();

      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall[1]).toMatchObject({ roomId: 'GHOST_ROOM', name: 'Charlie', isReconnect: true });
    });

    it('cancelReconnect(roomId, name) does not emit leaveRoom if joinRoom fails', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      useGameStore.getState().cancelReconnect('GHOST_ROOM', 'Charlie');

      expect(io).toHaveBeenCalledWith(expect.any(String));
      mockOnHandlers['connect']();

      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      const joinCallback = joinRoomCall[2];
      // Simulate failed joinRoom (success: false or server error)
      joinCallback({ success: false });

      // Should NOT emit leaveRoom on failure
      expect(emittedEvents()).not.toContain('leaveRoom');
      // But should still disconnect to clean up the temp socket
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) cleans up on connect_error without trying to join', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      useGameStore.getState().cancelReconnect('GHOST_ROOM', 'Charlie');

      expect(io).toHaveBeenCalledWith(expect.any(String));
      // Simulate connection failure
      mockOnHandlers['connect_error']();

      // Should not attempt to join
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeUndefined();
      // But should clean up
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) passes color from localStorage if available', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_color', '#FF5733');
      useGameStore.getState().cancelReconnect('ROOM_123', 'Alice');

      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(joinRoomCall[1]).toMatchObject({ color: '#FF5733' });
    });

    it('cancelReconnect handles missing deviceId gracefully', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      // Temporarily clear deviceId to test edge case
      const originalDeviceId = useGameStore.getState().deviceId;
      useGameStore.setState({ deviceId: null });

      useGameStore.getState().cancelReconnect('ROOM_XYZ', 'TestUser');

      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      // Should still emit joinRoom even with null deviceId
      expect(joinRoomCall).toBeTruthy();
      expect(joinRoomCall[1]).toMatchObject({
        roomId: 'ROOM_XYZ',
        name: 'TestUser',
        deviceId: null,
      });

      // Restore original deviceId
      useGameStore.setState({ deviceId: originalDeviceId });
    });

    it('cancelReconnect called multiple times disconnects the prior temp socket instead of leaving it dangling (STORE-SMELL-7)', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockDisconnect.mockClear();

      const store = useGameStore.getState();

      // First call with roomId - creates a temp socket, not yet disconnected.
      store.cancelReconnect('ROOM_1', 'Alice');
      expect(io).toHaveBeenCalledTimes(1);
      // Clears any disconnect triggered by this call cleaning up a dangling
      // attempt left pending by an earlier test — isolates this test to just
      // what happens from here on.
      mockDisconnect.mockClear();

      // Second call with roomId - the first attempt is cancelled (disconnected)
      // before a second temp socket is created.
      store.cancelReconnect('ROOM_2', 'Bob');
      expect(io).toHaveBeenCalledTimes(2);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      // Call without roomId - does NOT create a temp socket, but does clean up
      // the still-pending second attempt.
      store.cancelReconnect();
      expect(io).toHaveBeenCalledTimes(2);
      expect(mockDisconnect).toHaveBeenCalledTimes(2);

      // Verify handlers were registered for both socket attempts
      expect(mockOnHandlers['connect_error']).toBeDefined();
    });

    it('cancelReconnect cleans up socket after joinRoom callback with error', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      useGameStore.getState().cancelReconnect('ROOM_FAIL', 'FailUser');

      mockOnHandlers['connect']();
      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      const callback = joinRoomCall[2];

      // Simulate error in callback (e.g., room no longer exists)
      callback({ success: false, error: 'Room not found' });

      // Should still disconnect even on error
      expect(mockDisconnect).toHaveBeenCalled();
      // Should not emit leaveRoom on failure
      expect(emittedEvents()).not.toContain('leaveRoom');
    });

    it('cancelReconnect disconnects socket after 10s if joinRoom callback never fires', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockDisconnect.mockClear();

      vi.useFakeTimers();

      useGameStore.getState().cancelReconnect('ROOM_TIMEOUT', 'Ghost');

      // Socket connects but server never calls the joinRoom callback
      mockOnHandlers['connect']();

      // Before timeout: not yet disconnected
      vi.advanceTimersByTime(9999);
      expect(mockDisconnect).not.toHaveBeenCalled();

      // At 10s: failsafe fires and disconnects
      vi.advanceTimersByTime(1);
      expect(mockDisconnect).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('cancelReconnect clears the timeout when joinRoom callback fires normally', async () => {
      const { io } = await import('socket.io-client');
      vi.mocked(io).mockClear();
      mockDisconnect.mockClear();

      vi.useFakeTimers();

      useGameStore.getState().cancelReconnect('ROOM_OK', 'Alice');
      mockOnHandlers['connect']();

      const joinRoomCall = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      const callback = joinRoomCall[2];

      // Callback fires well before the 10s timeout
      callback({ success: true });
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      // Advancing past 10s must NOT trigger a second disconnect
      vi.advanceTimersByTime(15000);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('cancelReconnect clears showReconnectPopup when called with no roomId', async () => {
      useGameStore.setState({
        showReconnectPopup: true,
        liveTurnState: makeSnapshot({ turnScore: 100 }),
      });

      useGameStore.getState().cancelReconnect();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(useGameStore.getState().liveTurnState).toBeNull();
    });
  });

  // Orchestration behaviours that previously lived only in the removed
  // useOnlineGame / useGameLogic hooks.
  describe('startGame resets player statistics', () => {
    it('zeroes accumulated stats from a previous game', () => {
      const store = useGameStore.getState();
      store.addPlayer('Alice');
      // Pollute the player with stale stats.
      useGameStore.setState((s) => {
        Object.assign(s.players[0], {
          score: 5000, totalTurns: 9, busts: 3, feuerwerkBusts: 2,
          x2Busts: 1, feuerwerkPointsScored: 1500, x2PointsScored: 800,
          timesKleeblattCompleted: 1,
        });
      });

      useGameStore.getState().startGame();

      const p = useGameStore.getState().players[0];
      expect(p.score).toBe(0);
      expect(p.totalTurns).toBe(0);
      expect(p.busts).toBe(0);
      expect(p.feuerwerkBusts).toBe(0);
      expect(p.x2Busts).toBe(0);
      expect(p.feuerwerkPointsScored).toBe(0);
      expect(p.x2PointsScored).toBe(0);
      expect(p.timesKleeblattCompleted).toBe(0);
    });
  });

  describe('addPlayer store-level invariants', () => {
    it('ignores a name differing only by case from an existing player', () => {
      // Duplicate names break every name-keyed lookup (Plus/Minus deduction,
      // undo, pushState merging) and make persistence.hasUniquePlayerNames
      // drop the entire restored save on the next reload — the store must
      // enforce this itself, not rely on LocalLobby being the only caller.
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('alice');

      expect(useGameStore.getState().players.map(p => p.name)).toEqual(['Alice']);
    });

    it('ignores empty, whitespace-only, and over-length names', () => {
      useGameStore.getState().addPlayer('');
      useGameStore.getState().addPlayer('   ');
      useGameStore.getState().addPlayer('x'.repeat(31));

      expect(useGameStore.getState().players).toEqual([]);
    });

    it('trims surrounding whitespace, matching the lobby input', () => {
      useGameStore.getState().addPlayer('  Alice  ');

      expect(useGameStore.getState().players.map(p => p.name)).toEqual(['Alice']);
    });
  });

  describe('player identity (Player.id)', () => {
    it('mints a non-empty, unique id for each new player', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      const [alice, bob] = useGameStore.getState().players;

      expect(alice.id).toBeTruthy();
      expect(bob.id).toBeTruthy();
      expect(alice.id).not.toBe(bob.id);
    });

    it('preserves each player’s id across the startGame stat reset', () => {
      // randomOrder is on by default — startGame legitimately reshuffles the
      // roster, so this compares the SET of ids (not array order) before and
      // after, to isolate "did startGame mint fresh ids" from "did it shuffle".
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      const idsBefore = new Set(useGameStore.getState().players.map(p => p.id));

      useGameStore.getState().startGame();

      const idsAfter = new Set(useGameStore.getState().players.map(p => p.id));
      expect(idsAfter).toEqual(idsBefore);
    });
  });

  describe('default vs custom game detection (global stats payload)', () => {
    const DEFAULT_CARDS = {
      Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
      x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5,
    };

    it('marks a 6000-point default-deck game as isDefaultGame: true', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.setState({ winningScore: 6000, initialCards: { ...DEFAULT_CARDS } });

      const payload = useGameStore.getState().buildGlobalStatsPayload();
      expect(payload.isDefaultGame).toBe(true);
    });

    it('marks a tweaked deck as isDefaultGame: false', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.setState({ winningScore: 6000, initialCards: { ...DEFAULT_CARDS, Kleeblatt: 99 } });

      const payload = useGameStore.getState().buildGlobalStatsPayload();
      expect(payload.isDefaultGame).toBe(false);
    });

    it('marks a non-6000 winning score as isDefaultGame: false', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.setState({ winningScore: 8000, initialCards: { ...DEFAULT_CARDS } });

      const payload = useGameStore.getState().buildGlobalStatsPayload();
      expect(payload.isDefaultGame).toBe(false);
    });
  });

  describe('online game global stats', () => {
    const DEFAULT_CARDS = {
      Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
      x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5,
    };

    it('host sends global stats when an online game ends', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ ...makeOnlinePlayer('Alice'), score: 5500 }],
        currentPlayerIndex: 0, status: 'playing', finished: false,
        winningScore: 6000, initialCards: { ...DEFAULT_CARDS },
      });

      mockEmit.mockClear();
      useGameStore.getState().nextTurn(500, true);

      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', {
        payload: expect.any(Object),
      }, expect.any(Function));
    });

    it('non-host does NOT send global stats when an online game ends', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ ...makeOnlinePlayer('Alice'), score: 5500 }],
        currentPlayerIndex: 0, status: 'playing', finished: false,
        winningScore: 6000, initialCards: { ...DEFAULT_CARDS },
      });

      mockEmit.mockClear();
      useGameStore.getState().nextTurn(500, true);

      expect(emittedEvents()).not.toContain('submitGlobalStats');
    });
  });

  describe('gameState after leaving online mode', () => {
    it('ignores a broadcast that lands once the client is back in local mode', () => {
      // leaveRoom/kicked flip the mode before the socket fully tears down —
      // a late broadcast applied then would inject the online room into
      // local state, and the local persistence subscriber would immediately
      // write it to disk.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.getState().setMode('local');
      useGameStore.setState({ players: [], status: 'lobby', round: 1 });

      mockOnHandlers['gameState']({
        status: 'playing', round: 5, currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Stranger')],
      });

      const state = useGameStore.getState();
      expect(state.status).toBe('lobby');
      expect(state.round).toBe(1);
      expect(state.players).toEqual([]);
    });

    it('ignores a broadcast for the room it just left, while still in online mode', () => {
      // The mode check above cannot see this one. leaveRoom applies
      // clearRoomState, which contains neither `mode` nor `isOnline` — four of
      // its five call sites deliberately stay in online mode so the user lands
      // back on the join form. The server only drops the socket from the
      // channel when it processes the leave, so anything emitted during that
      // round trip still arrives, and it restored players/finished/
      // currentPlayerIndex — which is exactly what App.tsx routes off. The
      // result was Game/EndScreen rendered over a roomId-less store where
      // every action silently no-ops and the turn countdown restarts.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'R1', myName: 'Alice',
        status: 'playing', players: namedPlayers('Alice', 'Bob'), round: 3,
      });

      useGameStore.getState().leaveRoom();
      expect(useGameStore.getState().mode, 'the user stays on the online join form').toBe('online');

      mockOnHandlers['gameState']({
        status: 'playing', round: 5, currentPlayerIndex: 0, finished: true,
        players: [makeOnlinePlayer('Stranger')],
      });

      const state = useGameStore.getState();
      expect(state.roomId).toBeNull();
      expect(state.players).toEqual([]);
      expect(state.finished).toBe(false);
      expect(state.currentPlayerIndex).toBeNull();
      expect(state.status).toBe('lobby');
    });
  });

  // clearRoomState's contract: once a room is abandoned, nothing of that game
  // may survive into local mode. It used to clear only the roster and the room
  // identity, so the chart series, the activity log and the previous-turn undo
  // block rode along — and since setMode('local') only overwrites what a saved
  // local game happens to contain, they could then be persisted into
  // `tutto_local_game` and shown inside an unrelated local game.
  describe('abandoning an online room clears the whole game, not just the roster', () => {
    const seatOnlineGame = () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'R1', myName: 'Alice',
        players: namedPlayers('Alice', 'Bob'),
        status: 'playing', round: 3, currentPlayerIndex: 1, finished: false,
        turnDuration: 60, turnTimeRemaining: 47,
        chartValues: [[100], [200]], chartNames: ['Alice', 'Bob'], chartLabels: [1],
        historyLog: [{ id: 'h1', round: 1, playerName: 'Alice', card: '200', type: 'success', score: 100 }],
        previousCard: '200', previousScore: 100, previousPlayerName: 'Alice',
        previousWasBust: false, previousWasSuccess: true, previousHighestTurnScore: 100,
        gameTimeInSeconds: 321,
        reactions: [{ id: 1, emoji: '🔥', senderName: 'Bob' }],
      });
    };

    const expectNothingLeftOver = () => {
      const s = useGameStore.getState();
      expect(s.players).toEqual([]);
      // Scoreboard renders its turn-timer tile whenever this is non-null, and
      // a local game has no turn timer at all — so an abandoned room's
      // countdown would sit frozen in one.
      expect(s.turnTimeRemaining).toBeNull();
      expect(s.chartValues).toEqual([]);
      expect(s.chartNames).toEqual([]);
      expect(s.chartLabels).toEqual([]);
      expect(s.historyLog).toEqual([]);
      expect(s.previousCard).toBeNull();
      expect(s.previousScore).toBeNull();
      expect(s.previousPlayerName).toBeNull();
      expect(s.previousTurnSummary).toBeNull();
      expect(s.previousHighestTurnScore).toBe(0);
      // undefined, not false — "no outcome recorded" (see noUndoableTurn).
      expect(s.previousWasSuccess).toBeUndefined();
      // startGame resets this to 0 before anything can read it again while a
      // room is running, but an abandoned room's elapsed time is not
      // otherwise cleared — see the dedicated local-save-bleed test below for
      // why that mattered.
      expect(s.gameTimeInSeconds).toBe(0);
      // A reaction from the room just left would otherwise float over the
      // local game (or the join form) that replaced it.
      expect(s.reactions).toEqual([]);
    };

    it('leaveRoom drops the chart series, the activity log and the undo block', () => {
      seatOnlineGame();
      useGameStore.getState().leaveRoom();
      expectNothingLeftOver();
    });

    it('a kick drops them too', () => {
      seatOnlineGame();
      mockOnHandlers['kicked']();
      expectNothingLeftOver();
    });

    it('cancelReconnect drops them once a room was actually joined', () => {
      seatOnlineGame();
      useGameStore.getState().cancelReconnect();
      expectNothingLeftOver();
    });

    it('leaves no live Undo button behind in local mode', () => {
      // With no saved local game there is nothing to overwrite the leftovers,
      // so Game.tsx's hasUndoableTurn used to offer Undo for a turn played in
      // a room this client already left.
      seatOnlineGame();
      useGameStore.getState().leaveRoom();
      localStorage.removeItem('tutto_local_game');
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().previousCard).toBeNull();
      expect(useGameStore.getState().previousPlayerName).toBeNull();
    });

    it('does not let the abandoned room clock bleed into an old save missing gameTimeInSeconds', () => {
      // A save written before gameTimeInSeconds existed (or one that failed
      // isNonNegativeNumber) has no key for it, so pickLocalGameState leaves
      // whatever the store currently holds in place rather than overwriting
      // it. gameTimeInSeconds used to be the one synced field clearRoomState
      // deliberately left standing, on the theory that startGame always
      // resets it to 0 before anything reads it again — but setMode('local')
      // restores an IN-PROGRESS save without ever calling startGame, so the
      // abandoned online room's elapsed time rode straight into the restored
      // local game, and reanchorLocalClock then re-anchored its clock from
      // it (status: 'playing' with a seated currentPlayerIndex).
      localStorage.setItem('tutto_local_game', JSON.stringify({
        players: [{ name: 'Ann', color: '#ff0000', score: 1200 }],
        currentPlayerIndex: 0, round: 3, status: 'playing', finished: false,
      }));
      seatOnlineGame();
      useGameStore.setState({ gameTimeInSeconds: 999 });
      useGameStore.getState().leaveRoom();
      useGameStore.getState().setMode('local');

      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
    });
  });

  // chartValues is player-indexed — one score series per player. Both
  // server-side twins (turnTimers.advanceTurnOnTimeout,
  // rooms.handleActivePlayerRemoved) refuse to append when the two disagree;
  // the client indexed result.players past the end and threw, taking the game
  // into the ErrorBoundary's clear-and-reload.
  describe('round-end chart bookkeeping', () => {
    const stagePlayingRound = (chartValues: number[][]) => {
      useGameStore.setState({
        mode: 'local', isOnline: false, status: 'playing',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: 1, // committing this turn wraps the round
        currentCard: '200', cards: ['300'], round: 2,
        chartValues, chartLabels: [1],
      });
    };

    it('appends a datapoint per player when the series match the roster', () => {
      stagePlayingRound([[100], [200]]);
      useGameStore.getState().nextTurn(100, true);
      expect(useGameStore.getState().chartValues).toEqual([[100, 0], [200, 100]]);
      expect(useGameStore.getState().chartLabels).toEqual([1, 2]);
    });

    it('skips the append instead of crashing when there are more series than players', () => {
      stagePlayingRound([[100], [200], [300]]);
      expect(() => useGameStore.getState().nextTurn(100, true)).not.toThrow();
      expect(useGameStore.getState().chartValues).toEqual([[100], [200], [300]]);
      // The label may only be appended when the series it labels were.
      expect(useGameStore.getState().chartLabels).toEqual([1]);
    });

    it('skips it for fewer series than players too, rather than charting a partial round', () => {
      stagePlayingRound([[100]]);
      expect(() => useGameStore.getState().nextTurn(100, true)).not.toThrow();
      expect(useGameStore.getState().chartValues).toEqual([[100]]);
      expect(useGameStore.getState().chartLabels).toEqual([1]);
    });
  });

  describe('online config-change toasts', () => {
    beforeEach(() => {
      // These tests simulate an already-joined lobby receiving a LATER host
      // change — the first-sync suppression (roomStateSynced) must be armed
      // past its quiet first gameState.
      useGameStore.setState({ roomStateSynced: true });
    });

    it('stays quiet on the first gameState after joining — the room introducing itself is not a change', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      // This device once hosted with a custom config; the joined room runs
      // defaults. The differences are the ROOM'S existing settings, not
      // changes anybody made.
      useGameStore.setState({ roomId: 'R1', status: 'lobby', winningScore: 10000, ruleset: 'classic', toasts: [], roomStateSynced: false });

      mockOnHandlers['gameState']({ status: 'lobby', winningScore: 6000, ruleset: 'modernized', players: [] });

      expect(useGameStore.getState().toasts).toEqual([]);
      // The sync itself still applies…
      expect(useGameStore.getState().winningScore).toBe(6000);

      // …and a LATER host change toasts as before.
      mockOnHandlers['gameState']({ status: 'lobby', winningScore: 8000, players: [] });
      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('8,000'))).toBe(true);
    });

    it('joinRoom re-arms the first-sync suppression for the next room', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomStateSynced: true });

      void useGameStore.getState().joinRoom('ROOM2', 'Alice');

      expect(useGameStore.getState().roomStateSynced).toBe(false);
    });

    it('toasts when the host changes the winning score in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', winningScore: 6000 });

      mockOnHandlers['gameState']({ status: 'lobby', winningScore: 8000, players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('8,000'))).toBe(true);
    });

    it('does not toast when winningScore is present but not a number', () => {
      // The old guard was `'winningScore' in serverState`, which is true for
      // any value including undefined — formatInt(undefined) rendered
      // "Winning score: 0", inventing a change that never happened.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', winningScore: 6000 });

      mockOnHandlers['gameState']({ status: 'lobby', winningScore: undefined, players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Winning score'))).toBe(false);
    });

    it('toasts when the host turns on dice mode enforcement in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', enforcedDiceMode: null });

      mockOnHandlers['gameState']({ status: 'lobby', enforcedDiceMode: 'digital', players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Digital Dice'))).toBe(true);
    });

    it('toasts when the host turns off dice mode enforcement in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', enforcedDiceMode: 'physical' });

      mockOnHandlers['gameState']({ status: 'lobby', enforcedDiceMode: null, players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Disabled'))).toBe(true);
    });

    it('groups the new winning score in the toast the way the goal banner shows it', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      useGameStore.setState({ roomId: 'R1', status: 'lobby', winningScore: 6000, toasts: [] });

      mockOnHandlers['gameState']({
        status: 'lobby', players: [], winningScore: 10000,
        turnDuration: s.turnDuration, reconnectTimeout: s.reconnectTimeout,
        enforcedDiceMode: s.enforcedDiceMode, initialCards: s.initialCards,
      });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('10,000')), messages.join(' | ')).toBe(true);
    });

    it('does not toast config changes for a partial gameState payload that omits those keys', () => {
      // The sync loop guards every field with `key in serverState`; the toast
      // diffs must do the same — a payload missing winningScore etc. means
      // "unchanged", not "changed to undefined" (which would toast
      // "Winning score: undefined").
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        status: 'lobby', winningScore: 6000, turnDuration: 45,
        reconnectTimeout: 60, enforcedDiceMode: null, toasts: [],
      });

      mockOnHandlers['gameState']({ status: 'lobby', players: [] });

      expect(useGameStore.getState().toasts).toEqual([]);
    });

    it('does not toast when enforcedDiceMode is unchanged', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      useGameStore.setState({ roomId: 'R1', status: 'lobby', enforcedDiceMode: 'physical', toasts: [] });

      // Every other lobby-diffed field must also match the current state,
      // or its own toast fires and masks what this test is checking.
      mockOnHandlers['gameState']({
        status: 'lobby', enforcedDiceMode: 'physical', players: [],
        winningScore: s.winningScore, turnDuration: s.turnDuration,
        reconnectTimeout: s.reconnectTimeout, initialCards: s.initialCards,
      });

      expect(useGameStore.getState().toasts).toEqual([]);
    });

    it('toasts when the host switches the ruleset in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', ruleset: 'modernized', toasts: [] });

      mockOnHandlers['gameState']({ status: 'lobby', ruleset: 'classic', players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Classic'))).toBe(true);
      expect(useGameStore.getState().ruleset).toBe('classic');
    });

    it('does not toast when the ruleset is unchanged', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      useGameStore.setState({ roomId: 'R1', status: 'lobby', ruleset: 'classic', toasts: [] });

      mockOnHandlers['gameState']({
        status: 'lobby', ruleset: 'classic', players: [],
        winningScore: s.winningScore, turnDuration: s.turnDuration,
        reconnectTimeout: s.reconnectTimeout, initialCards: s.initialCards,
        enforcedDiceMode: s.enforcedDiceMode,
      });

      expect(useGameStore.getState().toasts).toEqual([]);
    });
  });

  describe('gameState sync allowlist (STORE-SEC-1)', () => {
    it('only applies known game-state fields from the server, ignoring anything else in the payload', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      // setMode spreads clearRoomState, so the seat has to come after it.
      useGameStore.setState({ roomId: 'R1' });
      const originalStartGame = useGameStore.getState().startGame;

      // A compromised/buggy server sending an extra, unexpected key (here,
      // even an action name) must not reach the store — only fields on the
      // allowlist may be applied.
      mockOnHandlers['gameState']({
        status: 'lobby', players: [], winningScore: 9999,
        startGame: 'hacked', someUnknownField: 'hacked',
      } as never);

      expect(useGameStore.getState().winningScore).toBe(9999);
      expect(useGameStore.getState().startGame).toBe(originalStartGame);
      expect((useGameStore.getState() as unknown as Record<string, unknown>).someUnknownField).toBeUndefined();
    });
  });

  describe('online turn timer', () => {
    // Turn expiry is authoritative on the server (server/index.ts startServerTurnTimer /
    // advanceTurnOnTimeout) so it still fires even if the host disconnects or backgrounds
    // their tab. The client's countdown is display-only: it must NOT call nextTurn/pushState
    // itself when it hits 0, for host or non-host alike — it just stops and waits for the
    // server's gameState push.
    it.each([
      ['host', true],
      ['non-host', false],
    ])('%s client does not auto-advance the turn when its local countdown hits 0', (_label, isHost) => {
      vi.useFakeTimers();
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      // currentPlayerIndex/currentCard vary per iteration (rather than being fixed)
      // so syncOnlineTimers always sees a "new turn" — the module-level
      // turnTimerPlayerIndex/turnTimerCard tracking vars from the previous
      // it.each iteration would otherwise make this a no-op on the second run.
      useGameStore.setState({
        isHost, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: isHost ? 0 : 1, status: 'playing', finished: false,
        turnDuration: 2, currentCard: isHost ? '200' : '300', cards: ['200'], initialCards: { 200: 5 },
        round: 1, chartValues: [[], []], chartLabels: [], chartNames: ['Alice', 'Bob'],
      });

      // Kick the turn timer off as syncOnlineTimers would after a state push.
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(2);

      mockEmit.mockClear();
      vi.advanceTimersByTime(2000);

      // Countdown stops at 0, but no local pushState/turn-advance is triggered —
      // that would race with (or duplicate) the server's own authoritative advance.
      expect(useGameStore.getState().turnTimeRemaining).toBe(0);
      expect(useGameStore.getState().currentPlayerIndex).toBe(isHost ? 0 : 1);
      expect(emittedEvents()).not.toContain('pushState');

      // Advancing further must not somehow retrigger anything (interval was cleared).
      vi.advanceTimersByTime(5000);
      expect(emittedEvents()).not.toContain('pushState');

      vi.useRealTimers();
    });
  });

  describe('liveTurnState', () => {
    it('setLiveTurnState stores the snapshot locally', () => {
      const snapshot = makeSnapshot({ turnScore: 200, keptDice: [{ id: 'd1', val: 1 }] });
      useGameStore.getState().setLiveTurnState(snapshot);
      expect(useGameStore.getState().liveTurnState).toEqual(snapshot);
    });

    it('setLiveTurnState pushes via the dedicated liveTurnState event when online, not the full pushState event', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: 0, status: 'playing',
      });
      mockEmit.mockClear();

      const snapshot = makeSnapshot({ turnScore: 350, keptDice: [{ id: 'd1', val: 5 }], currentRoll: [{ id: 'd2', val: 3, selected: false }] });
      useGameStore.getState().setLiveTurnState(snapshot);

      // A dedicated, small event — not the full state-bundle 'pushState' event
      // (see server/socketHandlers.ts's separate 'liveTurnState' handler).
      expect(mockEmit).toHaveBeenCalledWith('liveTurnState', { roomId: 'ROOM1', liveTurnState: snapshot });
      expect(emittedEvents()).not.toContain('pushState');
    });

    it('setLiveTurnState does not include playerName in the liveTurnState pushed to the server', () => {
      // playerName is only persisted in localStorage, never sent over the wire
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: 0, status: 'playing',
      });
      mockEmit.mockClear();

      const snapshot = makeSnapshot({ turnScore: 350 });
      useGameStore.getState().setLiveTurnState(snapshot);

      const pushCall = mockEmit.mock.calls.find(([ev]) => ev === 'liveTurnState');
      expect(pushCall).toBeDefined();
      expect(pushCall![1].liveTurnState).not.toHaveProperty('playerName');
      // Also verify in-memory store has no playerName on liveTurnState
      expect(useGameStore.getState().liveTurnState).not.toHaveProperty('playerName');
    });

    it('the liveTurnState socket event merges into the store without touching other fields', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        ...seatedInRoom, myName: 'Alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        round: 3, historyLog: [],
      });

      const incoming = { turnScore: 500, keptDice: [{ val: 6 }], currentRoll: [] };
      mockOnHandlers['liveTurnState']({ liveTurnState: incoming });

      expect(useGameStore.getState().liveTurnState).toEqual(incoming);
      // Untouched by the targeted merge — proves this doesn't run through the
      // full 'gameState' Object.assign path.
      expect(useGameStore.getState().round).toBe(3);
      expect(useGameStore.getState().myName).toBe('Alice');
    });

    it('nextTurn clears liveTurnState', () => {
      useGameStore.getState().addPlayer('P1');
      useGameStore.getState().addPlayer('P2');
      useGameStore.setState({
        status: 'playing', currentPlayerIndex: 0, round: 1,
        liveTurnState: makeSnapshot({ turnScore: 100 }),
      });

      useGameStore.getState().nextTurn(500, true);

      expect(useGameStore.getState().liveTurnState).toBeNull();
    });

    it('endGame clears liveTurnState', () => {
      useGameStore.setState({
        liveTurnState: makeSnapshot({ turnScore: 100 }),
      });

      useGameStore.getState().endGame();

      expect(useGameStore.getState().liveTurnState).toBeNull();
    });

    it('endGame resets cards, chart data and previous-turn fields, not just round/status', () => {
      // startGame() already resets all of these before a new game; endGame()
      // previously left them stale while sitting in the lobby between games —
      // cosmetic today (nothing renders them in the lobby), but a foot-gun for
      // any future lobby UI that reads them (e.g. a "last game" recap).
      useGameStore.setState({
        cards: ['200', '300'],
        previousCard: 'Kniffel',
        previousScore: 2000,
        previousLeaders: [makeOnlinePlayer('Alice', { score: 6000 })],
        previousWasBust: true,
        previousHighestTurnScore: 2000,
        chartValues: [[0, 500], [0, 300]],
        chartNames: ['Alice', 'Bob'],
        chartLabels: [1],
      });

      useGameStore.getState().endGame();

      const state = useGameStore.getState();
      expect(state.cards).toEqual([]);
      expect(state.previousCard).toBeNull();
      expect(state.previousScore).toBeNull();
      expect(state.previousLeaders).toBeNull();
      expect(state.previousWasBust).toBe(false);
      expect(state.previousHighestTurnScore).toBe(0);
      expect(state.chartValues).toEqual([]);
      expect(state.chartNames).toEqual([]);
      expect(state.chartLabels).toEqual([]);
    });

    // buildGlobalStatsPayload PREFERS this snapshot over live state, so one
    // left behind by the previous game is not stale-but-harmless — it is what
    // the next submission would report. Both game-start paths drop it.
    it.each([
      ['startGame', () => { useGameStore.getState().startGame(); }],
      ['endGame', () => { useGameStore.getState().endGame(); }],
    ])("%s drops the previous game's finished-game snapshot", (_name, act) => {
      useGameStore.setState({
        players: namedPlayers('Alice', 'Bob'),
        finishedGameSnapshot: {
          players: namedPlayers('Zoe'), round: 12, gameTimeInSeconds: 900,
        },
      });

      act();

      expect(useGameStore.getState().finishedGameSnapshot).toBeNull();
    });
  });

  describe('Plus_Minus store integration', () => {
    const makeP = (name: string, score = 0): Player => makeFullPlayer({ name, score });

    it('deducts 1000 from leader with exactly 1000 pts when non-leader plays Plus_Minus', () => {
      useGameStore.setState({
        status: 'playing', round: 1, finished: false,
        currentPlayerIndex: 1, currentCard: 'Plus_Minus',
        players: [makeP('Alice', 1000), makeP('Bob', 0)],
        cards: ['200', '300'], chartValues: [[], []], chartLabels: [],
      });

      useGameStore.getState().nextTurn(0, true);

      const s = useGameStore.getState();
      expect(s.players[0].score).toBe(0);    // Alice: 1000 - 1000
      expect(s.players[1].score).toBe(1000); // Bob: 0 + 1000
      expect(s.players[0].times1000PointsDeducted).toBe(1);
      expect(s.previousLeaders).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Alice', score: 1000 }),
      ]));
      expect(s.previousCard).toBe('Plus_Minus');
      expect(s.previousScore).toBe(1000);
    });

    it('undo restores leader from 0 back to exactly 1000 after Plus_Minus', () => {
      // State after Bob played Plus_Minus: Alice=0, Bob=1000, now Alice's turn (round 2)
      useGameStore.setState({
        status: 'playing', round: 2, finished: false,
        currentPlayerIndex: 0, currentCard: '200',
        players: [
          makeP('Alice', 0),
          { ...makeP('Bob', 1000), totalTurns: 1, timesPlusMinusCompleted: 1 },
        ],
        cards: ['300'],
        chartValues: [[0], [1000]], chartLabels: [1],
        previousCard: 'Plus_Minus',
        previousScore: 1000,
        previousLeaders: [makeP('Alice', 1000)],
        previousWasBust: false,
        previousHighestTurnScore: 0,
        previousPlayerName: 'Bob',
      });

      useGameStore.getState().undo();

      const s = useGameStore.getState();
      expect(s.players[0].score).toBe(1000); // Alice restored to 1000
      expect(s.players[1].score).toBe(0);    // Bob loses his 1000
      expect(s.players[0].times1000PointsDeducted).toBe(0);
      expect(s.players[1].timesPlusMinusCompleted).toBe(0);
      expect(s.previousCard).toBeNull();
      expect(s.previousLeaders).toBeNull();
      expect(s.currentPlayerIndex).toBe(1); // back to Bob's turn
    });

    it('full nextTurn then undo round-trip for leader at exactly 1000', () => {
      useGameStore.setState({
        status: 'playing', round: 1, finished: false,
        currentPlayerIndex: 1, currentCard: 'Plus_Minus',
        players: [makeP('Alice', 1000), makeP('Bob', 0)],
        cards: ['200'], chartValues: [[], []], chartLabels: [],
        previousCard: null, previousScore: null, previousLeaders: null,
        previousWasBust: false, previousHighestTurnScore: 0,
      });

      useGameStore.getState().nextTurn(0, true);

      let s = useGameStore.getState();
      expect(s.players[0].score).toBe(0);
      expect(s.players[1].score).toBe(1000);

      useGameStore.getState().undo();

      s = useGameStore.getState();
      expect(s.players[0].score).toBe(1000); // Alice fully restored
      expect(s.players[1].score).toBe(0);    // Bob fully reversed
    });

    it('does NOT deduct when card holder is the leader at exactly 1000', () => {
      useGameStore.setState({
        status: 'playing', round: 1, finished: false,
        currentPlayerIndex: 0, currentCard: 'Plus_Minus',
        players: [makeP('Alice', 1000), makeP('Bob', 0)],
        cards: ['200', '300'], chartValues: [[], []], chartLabels: [],
      });

      useGameStore.getState().nextTurn(0, true);

      const s = useGameStore.getState();
      expect(s.players[0].score).toBe(2000); // Alice: 1000 + 1000, no deduction
      expect(s.players[1].score).toBe(0);    // Bob untouched
      expect(s.previousLeaders).toBeNull();  // no snapshot because no deduction
    });
  });

  describe('disconnect toast', () => {
    it('includes the reconnect countdown in the toast', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ ...seatedInRoom, reconnectTimeout: 45 });

      mockOnHandlers['playerDisconnected']('Bob');

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Bob') && m.includes('45 seconds'))).toBe(true);
    });
  });

  describe('nameConflictWithDisconnected toast', () => {
    it('tells the host which disconnected player\'s name was contested', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState(seatedInRoom);

      mockOnHandlers['nameConflictWithDisconnected']('Bob');

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Bob'))).toBe(true);
    });
  });

  describe('drawCardMidTurn (classic chains)', () => {
    it('pops the deck, sets the drawn card as current, and returns it', async () => {
      useGameStore.setState({
        currentPlayerIndex: 0,
        players: [{ name: 'Alice', score: 0 } as never],
        currentCard: '300',
        cards: ['x2', 'Stop'],
        finished: false,
      });
      const drawn = await useGameStore.getState().drawCardMidTurn();
      expect(drawn).toBe('x2');
      const s = useGameStore.getState();
      expect(s.currentCard).toBe('x2');
      expect(s.cards).toEqual(['Stop']);
    });

    it('rebuilds the deck from initialCards when it runs empty', async () => {
      useGameStore.setState({
        currentPlayerIndex: 0,
        players: [{ name: 'Alice', score: 0 } as never],
        currentCard: '300',
        cards: [],
        initialCards: { '200': 2 },
        finished: false,
      });
      const drawn = await useGameStore.getState().drawCardMidTurn();
      expect(drawn).toBe('200');
      expect(useGameStore.getState().cards).toEqual(['200']);
    });

    it('refuses when no turn is active or the game is finished', async () => {
      useGameStore.setState({ currentPlayerIndex: null, cards: ['200'] });
      await expect(useGameStore.getState().drawCardMidTurn()).resolves.toBeNull();
      useGameStore.setState({ currentPlayerIndex: 0, players: [{ name: 'A', score: 0 } as never], finished: true });
      await expect(useGameStore.getState().drawCardMidTurn()).resolves.toBeNull();
    });

    describe('online, where the card is the server’s to choose', () => {
      // The deck a client holds is the ordered list of cards not yet dealt, so
      // a client that draws from its own copy has read the answer before
      // making the decision the whole classic turn turns on. The draw is asked
      // for over the wire and answered by the server now.
      const midTurn = (over: Partial<GameStore> = {}) => {
        // A real socket (the module singleton) as well as the online flags:
        // the draw is a round trip, so a test without one only ever exercises
        // the no-socket bail-out.
        useGameStore.getState().connectSocket('http://localhost:3000');
        useGameStore.setState({
          ...seatedInRoom,
          currentPlayerIndex: 0,
          players: namedPlayers('Alice', 'Bob'),
          currentCard: '300',
          cards: ['x2', 'Stop'],
          finished: false,
          ...over,
        });
        mockEmit.mockClear();
      };

      afterEach(() => {
        disconnectSocket();
      });

      it('asks the server instead of shifting its own deck', async () => {
        midTurn();
        mockEmit.mockImplementation((event, _payload, ack) => {
          if (event === 'drawCard') ack({ ok: true, card: 'Kleeblatt' });
        });

        const drawn = await useGameStore.getState().drawCardMidTurn();

        // 'Kleeblatt' is nowhere in the local deck, whose top card is 'x2' —
        // so a client that still drew locally could not produce this.
        expect(drawn).toBe('Kleeblatt');
        expect(useGameStore.getState().currentCard).toBe('Kleeblatt');
        expect(emittedEvents()).toContain('drawCard');
      });

      it('does not push a card of its own choosing', async () => {
        midTurn();
        mockEmit.mockImplementation((event, _payload, ack) => {
          if (event === 'drawCard') ack({ ok: true, card: 'Kleeblatt' });
        });

        await useGameStore.getState().drawCardMidTurn();

        expect(emittedEvents(), 'the draw is the request, not a fait accompli').not.toContain('pushState');
      });

      it('refuses when the server does, leaving the card in play alone', async () => {
        midTurn();
        mockEmit.mockImplementation((event, _payload, ack) => {
          if (event === 'drawCard') ack({ ok: false, reason: 'not-playing' });
        });

        await expect(useGameStore.getState().drawCardMidTurn()).resolves.toBeNull();
        expect(useGameStore.getState().currentCard).toBe('300');
      });

      it('gives up on silence rather than leaving the turn parked forever', async () => {
        // The panel has already committed the tutto by the time it asks, so a
        // draw that never resolves strands it on a decided turn with nothing
        // left to press. A null is the answer it already knows how to take:
        // bank the tutto instead.
        vi.useFakeTimers();
        try {
          midTurn();
          mockEmit.mockImplementation(() => {});

          const pending = useGameStore.getState().drawCardMidTurn();
          vi.advanceTimersByTime(DRAW_CARD_ACK_TIMEOUT_MS);

          await expect(pending).resolves.toBeNull();
          expect(useGameStore.getState().currentCard).toBe('300');
        } finally {
          vi.useRealTimers();
        }
      });

      it('ignores an ack that lands after the deadline already banked the turn', async () => {
        // The deadline above is the panel's answer to silence -- but the ack
        // is not cancelled by it, and the socket is still connected. Arriving
        // late it would write its card over whatever is current NOW, which by
        // then is the next turn's: the room and the table disagree until some
        // later broadcast happens to correct it.
        vi.useFakeTimers();
        try {
          midTurn();
          let lateAck: ((res: unknown) => void) | undefined;
          mockEmit.mockImplementation((event, _payload, ack) => {
            if (event === 'drawCard') lateAck = ack;
          });

          const pending = useGameStore.getState().drawCardMidTurn();
          vi.advanceTimersByTime(DRAW_CARD_ACK_TIMEOUT_MS);
          await expect(pending).resolves.toBeNull();

          // The turn moved on while the server was quiet.
          useGameStore.setState({ currentCard: 'Kniffel' });
          lateAck!({ ok: true, card: 'Kleeblatt' });

          expect(useGameStore.getState().currentCard, 'the late ack does not touch the new turn').toBe('Kniffel');
        } finally {
          vi.useRealTimers();
        }
      });

      it('ignores an ack that lands after this client left the room', async () => {
        // currentCard is one of STABLE_LOCAL_GAME_KEYS, so writing it here
        // puts a card from a room this client no longer holds into whatever
        // local game replaced it -- which the persistence subscriber then
        // saves over that game's file on disk.
        midTurn();
        let lateAck: ((res: unknown) => void) | undefined;
        mockEmit.mockImplementation((event, _payload, ack) => {
          if (event === 'drawCard') lateAck = ack;
        });

        const pending = useGameStore.getState().drawCardMidTurn();
        useGameStore.setState({ roomId: null, currentCard: 'Kniffel' });
        lateAck!({ ok: true, card: 'Kleeblatt' });

        await expect(pending).resolves.toBeNull();
        expect(useGameStore.getState().currentCard).toBe('Kniffel');
      });

      it('ignores an ack that lands after this client joined a DIFFERENT room', async () => {
        // inRoom only asks whether SOME room is held, so a client that left
        // and joined another room between the request and the ack passes it —
        // and the card dealt off the old room's deck would be written into
        // the new room's turn.
        midTurn();
        let lateAck: ((res: unknown) => void) | undefined;
        mockEmit.mockImplementation((event, _payload, ack) => {
          if (event === 'drawCard') lateAck = ack;
        });

        const pending = useGameStore.getState().drawCardMidTurn();
        useGameStore.setState({ roomId: 'ROOM2', currentCard: 'Kniffel' });
        lateAck!({ ok: true, card: 'Kleeblatt' });

        await expect(pending).resolves.toBeNull();
        expect(useGameStore.getState().currentCard).toBe('Kniffel');
      });

      it('does not let a draw be buffered across a dropped socket', async () => {
        // socket.io buffers an emit made while the transport is down. For a
        // draw that is worse than dropping it: the panel gives up and banks
        // the tutto, and the buffered request then spends a card off the
        // room's deck for a turn that ended seconds ago.
        midTurn();
        mockSocketConnected = false;
        try {
          await expect(useGameStore.getState().drawCardMidTurn()).resolves.toBeNull();
          expect(emittedEvents()).not.toContain('drawCard');
        } finally {
          mockSocketConnected = true;
        }
      });

      it('answers null without asking when there is no turn to draw on', async () => {
        midTurn({ finished: true });

        await expect(useGameStore.getState().drawCardMidTurn()).resolves.toBeNull();
        expect(emittedEvents()).not.toContain('drawCard');
      });
    });
  });

  describe('Dice Game State Persistence', () => {
    it('setLiveTurnState saves state to localStorage', () => {
      const turnState = makeSnapshot({
        turnScore: 1250,
        keptDice: [{ id: 'die-1', val: 1 }],
        currentRoll: [{ id: 'die-2', val: 6, selected: true }],
        rollingDiceIds: ['die-3']
      });

      useGameStore.setState({
        players: namedPlayers('TestPlayer'),
        currentPlayerIndex: 0
      });

      useGameStore.getState().setLiveTurnState(turnState);

      const saved = localStorage.getItem('tutto_dice_turn_state');
      expect(saved).toBeDefined();
      // roomId: null, round: 1, currentCard: null after reset() in beforeEach.
      expect(JSON.parse(saved!)).toEqual({ ...turnState, playerName: 'TestPlayer', turnKey: 'local:1:0:none:modernized' });
    });

    it('setLiveTurnState does not save null state to localStorage', () => {
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 100 }));

      useGameStore.getState().setLiveTurnState(null);

      const saved = localStorage.getItem('tutto_dice_turn_state');
      expect(saved).toBe(JSON.stringify({ turnScore: 100 })); // Should not be cleared by null
    });

    it('nextTurn clears dice game state from localStorage', () => {
      // Setup initial state
      useGameStore.setState({
        players: [
          makeOnlinePlayer('Alice', { deviceId: 'dev-alice', position: 1, color: '#ff0000' }),
        ],
        currentPlayerIndex: 0,
        currentCard: 'Feuerwerk',
        cards: ['200', '200', '200', '200', '200', '200'],
        round: 1
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 500 }));

      useGameStore.getState().nextTurn(500, true);

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('endGame clears dice game state from localStorage', () => {
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 750 }));

      useGameStore.getState().endGame();

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });
  });

  describe('init state restoration', () => {
    it('clears tutto_dice_turn_state if the active player does not match the cached player name in local mode', () => {
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice', 'Bob'),
        currentPlayerIndex: 1,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Alice',
      }));

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('keeps tutto_dice_turn_state if the active player matches the cached player name in local mode', () => {
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice', 'Bob'),
        currentPlayerIndex: 1,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Bob',
      }));

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).not.toBeNull();
    });

    it('does not delete tutto_dice_turn_state for legacy local saves that have no playerName', () => {
      // Old saves written before this fix have no playerName field — we must not drop them
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice'),
        currentPlayerIndex: 0,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 500,
        // no playerName
      }));

      useGameStore.getState().init('test-device-id');

      // Validation only fires when playerName is present; legacy saves are left untouched
      expect(localStorage.getItem('tutto_dice_turn_state')).not.toBeNull();
    });

    it('does not delete tutto_dice_turn_state when an online reconnect is pending, even if names mismatch the local roster', () => {
      // init() runs at app mount, BEFORE the reconnect popup can set
      // mode='online' — so the pending session (restored from sessionStorage
      // inside init itself) is the only signal that the cache belongs to an
      // online game. Judging it against the local roster here would delete the
      // reconnecting player's in-progress turn; DiceGame's turnKey check
      // (which runs after the reconnect against real state) is the validator
      // for this path.
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'ROOM1', myName: 'Alice' }));
      useGameStore.setState({
        mode: 'local', // what init() actually observes at mount
        players: namedPlayers('Carol', 'Bob'),
        currentPlayerIndex: 1,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Alice', // mismatches the local roster, belongs to ROOM1
      }));

      useGameStore.getState().init('test-device-id');

      // Should NOT be cleared — a pending online reconnect owns this cache
      expect(localStorage.getItem('tutto_dice_turn_state')).not.toBeNull();
    });

    it('does not delete tutto_dice_turn_state when the saved local game\'s restore was postponed for a join link', () => {
      // Same reasoning as the pending-reconnect case above, from the other
      // side: the roster this cache would be judged against is still on disk
      // rather than in state, so checking it here would delete the half-rolled
      // turn of the very game being kept for later.
      localStorage.setItem('tutto_local_game', JSON.stringify({
        players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
        status: 'playing', currentPlayerIndex: 0, finished: false, round: 2,
      }));
      const cachedTurn = JSON.stringify({ turnScore: 250, playerName: 'Alice' });
      localStorage.setItem('tutto_dice_turn_state', cachedTurn);
      useGameStore.setState({ mode: 'online' }); // what Home's join-link effect already did

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).toBe(cachedTurn);
    });

    it('still clears an orphaned tutto_dice_turn_state when there is no saved local game to postpone', () => {
      // Only a POSTPONED restore protects the cache. With no save at all there
      // is no game coming back for it, so the ordinary ownership check applies
      // even though a join link has already switched the mode.
      localStorage.removeItem('tutto_local_game');
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 250,
        playerName: 'Alice',
      }));
      useGameStore.setState({ mode: 'online' });

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('does not crash when currentPlayerIndex is null during init', () => {
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice'),
        currentPlayerIndex: null,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Alice',
      }));

      expect(() => useGameStore.getState().init('test-device-id')).not.toThrow();
      // activePlayer is null → mismatch → cache cleared
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('restores hapticsEnabled from localStorage', () => {
      localStorage.setItem('tutto_hapticsEnabled', 'false');
      useGameStore.getState().init('test-device-id');
      expect(useGameStore.getState().hapticsEnabled).toBe(false);
    });

    it('restores motionOverride from localStorage', () => {
      localStorage.setItem('tutto_motionOverride', 'true');
      useGameStore.getState().init('test-device-id');
      expect(useGameStore.getState().motionOverride).toBe(true);
    });
  });

  describe('validateOnlineConfig (stored online config loading)', () => {
    it('applies a fully valid stored config when switching to online mode', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 8000, randomOrder: false, turnDuration: 60, reconnectTimeout: 120,
        initialCards: { '200': 3, Stop: 2 },
      }));
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      expect(s.winningScore).toBe(8000);
      expect(s.randomOrder).toBe(false);
      expect(s.turnDuration).toBe(60);
      expect(s.reconnectTimeout).toBe(120);
      expect(s.initialCards).toEqual({ '200': 3, Stop: 2 });
    });

    it('drops out-of-range and wrong-typed fields, keeping the defaults', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 500,        // below the 1000 minimum
        randomOrder: 'yes',       // wrong type
        turnDuration: 5,          // server only accepts 0 or 10-600
        reconnectTimeout: 99999,  // above 3600
      }));
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      expect(s.winningScore).toBe(6000);
      expect(s.randomOrder).toBe(true);
      expect(s.turnDuration).toBe(120);
      expect(s.reconnectTimeout).toBe(60);
    });

    it('accepts 0 as the explicit "disabled" value for both timers', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        turnDuration: 0, reconnectTimeout: 0,
      }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().turnDuration).toBe(0);
      expect(useGameStore.getState().reconnectTimeout).toBe(0);
    });

    it('keeps only the valid initialCards entries', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        // Bogus is an unknown card, 100 exceeds the 99 cap, -1 is negative
        initialCards: { '200': 3, Bogus: 4, '300': 100, Stop: -1 },
      }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().initialCards).toEqual({ '200': 3 });
    });

    it('keeps the default deck when no initialCards entry is valid', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        initialCards: { Bogus: 4 },
      }));
      useGameStore.getState().setMode('online');
      const cards = useGameStore.getState().initialCards;
      expect(cards.Stop).toBe(10);
      expect(cards.Kleeblatt).toBe(1);
    });

    it('keeps the default deck when the stored initialCards is all zeros (would leave currentCard permanently null)', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        initialCards: { Stop: 0, Kleeblatt: 0, '200': 0 },
      }));
      useGameStore.getState().setMode('online');
      const cards = useGameStore.getState().initialCards;
      expect(cards.Stop).toBe(10);
      expect(cards.Kleeblatt).toBe(1);
    });

    it('ignores a non-object stored config', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify('garbage'));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().winningScore).toBe(6000);
    });

    it('joinRoom transmits only the validated fields from the stored config', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 7000,
        turnDuration: 3,   // invalid — must not be transmitted
        bogus: true,       // unknown — must not be transmitted
      }));
      void useGameStore.getState().joinRoom('room-x', 'Alice');
      const call = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(call).toBeDefined();
      expect(call[1].initialConfig).toEqual({ winningScore: 7000 });
    });

    it('joinRoom sends no initialConfig when the stored config is entirely invalid', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({ turnDuration: 3 }));
      void useGameStore.getState().joinRoom('room-y', 'Alice');
      const call = nonNull(mockEmit.mock.calls.find(c => c[0] === 'joinRoom'));
      expect(call).toBeDefined();
      expect(call[1].initialConfig).toBeUndefined();
    });
  });

  // Every previous-turn field describes the same single turn, so the three
  // sites that end one clear them together — a site that clears some but not
  // others leaves a half-erased turn for undo and for the broadcast.
  describe.each([
    ['startGame', () => { useGameStore.getState().startGame(); }],
    ['endGame', () => { useGameStore.getState().endGame(); }],
    ['undo', () => { useGameStore.getState().undo(); }],
  ])('%s leaves no previous turn behind', (_label, act) => {
    it('clears every previous* field', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      useGameStore.getState().startGame();
      useGameStore.setState({
        // Bob is up in round 2, so Alice's turn is genuinely undoable —
        // calculateUndo refuses outright in round 1 (nothing to wind back to).
        currentPlayerIndex: 1,
        round: 2,
        currentCard: '200',
        previousCard: 'Kniffel',
        previousScore: 2000,
        previousLeaders: [{ name: 'Bob', score: 10 } as Player],
        previousWasBust: true,
        previousHighestTurnScore: 1200,
        previousHighestFeuerwerkTurnScore: 800,
        previousHighestX2TurnScore: 600,
        previousPlayerName: 'Alice',
        previousTurnSummary: { cards: [{ card: 'Kniffel', completed: true }], tuttoCount: 1, plusMinusScores: [], ended: 'banked' },
      });

      act();

      const s = useGameStore.getState();
      expect(s.previousCard).toBeNull();
      expect(s.previousScore).toBeNull();
      expect(s.previousLeaders).toBeNull();
      expect(s.previousWasBust).toBe(false);
      expect(s.previousHighestTurnScore).toBe(0);
      expect(s.previousHighestFeuerwerkTurnScore).toBe(0);
      expect(s.previousHighestX2TurnScore).toBe(0);
      expect(s.previousPlayerName).toBeNull();
      expect(s.previousTurnSummary).toBeNull();
    });
  });

  describe('storage refusing to cooperate', () => {
    afterEach(() => {
      restoreStorage();
    });

    // The local-save subscriber writes synchronously inside EVERY store
    // mutation, so a refused write surfaces from whatever caused it — a turn
    // commit, a toast — rather than merely losing the save.
    it.each([
      ['a refused write', () => failStorageMethods('localStorage', ['setItem'])],
      ['blocked site data', () => blockStorage('localStorage')],
    ])('keeps mutating state through %s', (_label, breakStorage) => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      breakStorage();

      expect(() => useGameStore.getState().startGame()).not.toThrow();
      // Pinned: startGame shuffles, and the engine substitutes its own score
      // for a Kniffel/Plus_Minus (or wins outright on a Kleeblatt), none of
      // which this test is about.
      useGameStore.setState({ currentCard: '200' });
      expect(() => useGameStore.getState().nextTurn(300, true)).not.toThrow();
      expect(() => useGameStore.getState().addToast('still here')).not.toThrow();
      expect(useGameStore.getState().players[0].score).toBe(300);
    });

    it('still restores nothing rather than throwing when reads are refused', () => {
      blockStorage('localStorage');
      blockStorage('sessionStorage');

      expect(() => useGameStore.getState().init('device-1')).not.toThrow();
      expect(useGameStore.getState().deviceId).toBe('device-1');
    });

    it('keeps the live dice snapshot flowing when its cache write is refused', () => {
      failStorageMethods('localStorage', ['setItem']);

      expect(() => useGameStore.getState().setLiveTurnState({
        turnScore: 50, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
      })).not.toThrow();
      expect(useGameStore.getState().liveTurnState?.turnScore).toBe(50);
    });
  });

});
