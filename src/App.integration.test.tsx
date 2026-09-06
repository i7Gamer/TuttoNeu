import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
// AnimatePresence as a pass-through: tests in this file run on fake timers,
// under which framer-motion's frame loop does not advance (and does not recover
// once real timers return), so a dismissed dialog's exit animation (ModalShell)
// would never finish and the panel never leave the DOM. Nothing here asserts on
// the animation itself — ModalShell.motion.test does.
// Captured rather than asserted on directly inside the mock factory: vi.mock
// factories run before the rest of this module's top-level code, so a plain
// module-scope `let` here would be reassigned by a later import-order quirk.
// vi.hoisted keeps it a stable reference the tests below can read after
// render(<App />) — the same shape FAST_TIMINGS uses further down.
const capturedMotionConfig = vi.hoisted(() => ({ reducedMotion: undefined as string | undefined }));
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  // Records the reducedMotion prop App.tsx passes down instead of rendering
  // framer-motion's real MotionConfig (a context provider with no DOM
  // footprint of its own) — there is nothing else here to assert on.
  MotionConfig: ({ children, reducedMotion }: { children?: ReactNode; reducedMotion?: string }) => {
    capturedMotionConfig.reducedMotion = reducedMotion;
    return <>{children}</>;
  },
}));
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, beforeAll, afterEach, type Mock } from 'vitest';
import App from './App';
import * as diceLogic from './utils/diceLogic';
import { useGameStore, _resetTimersForTests, _resetSocketSliceForTests } from './store/useGameStore';
import { disconnectSocket } from './store/socketRef';
import {
  DICE_PANEL_ENTRANCE_MS, TOAST_LIFETIME_MS, JOIN_TIMEOUT_MS,
  DIE_TUMBLE_MS, DIE_STAGGER_MS, ROLL_SETTLE_BUFFER_MS, AUTO_CONTINUE_SECONDS, CARD_FLIP_MS,
} from './utils/uiTimings';
import { TOTAL_DICE } from './utils/turnShapes';
import type { JoinRoomResponse } from './store/storeTypes';
import { makePlayer, makeDiceSnapshot, nonNull } from './testing/factories';
import { uiBusyState, _resetUiBusyStateForTests } from './utils/uiBusyState';

// The full-game test below runs the dice panel's real timers — Game.tsx's
// entrance delay, DiceGame's tumble/stagger/settle chain and the summary's
// auto-continue countdown — as genuine setTimeouts, twice over (one turn
// each for Alice and Bob). At production pace that is ~10 s of pure waiting
// in a test that is about the wiring, not the choreography, so the durations
// are shortened here while staying real: nothing in this file fakes the
// clock for that test, the waits below still elapse on their own. The
// countdown is the floor — useAutoContinueCountdown ticks in whole seconds,
// so 1 is as short as it goes.
const FAST_TIMINGS = vi.hoisted(() => ({
  DICE_PANEL_ENTRANCE_MS: 20,
  DIE_TUMBLE_MS: 20,
  DIE_STAGGER_MS: 5,
  ROLL_SETTLE_BUFFER_MS: 5,
  AUTO_CONTINUE_SECONDS: 1,
}));
vi.mock('./utils/uiTimings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils/uiTimings')>()),
  ...FAST_TIMINGS,
}));

// Every die in the opening roll tumbles for DIE_TUMBLE_MS, then the dice
// settle one after another DIE_STAGGER_MS apart, and the roll finalizes
// ROLL_SETTLE_BUFFER_MS after the last one settles (see DiceGame.tsx's roll()).
// Game.tsx's own DICE_PANEL_ENTRANCE_MS timeout has to elapse first (it is
// what flips panelReady, which is what starts the roll), so the wait below
// covers both in sequence. The margin on top is generous: it only bounds how
// long waitFor may poll, so it costs nothing when the roll lands on time, and
// under a loaded full-suite run (many files in parallel) a real timer can
// land well after its nominal delay.
const ROLL_ANIMATION_MARGIN_MS = 2000;
const FULL_ROLL_ANIMATION_MS =
  DICE_PANEL_ENTRANCE_MS + DIE_TUMBLE_MS + (TOTAL_DICE - 1) * DIE_STAGGER_MS + ROLL_SETTLE_BUFFER_MS + ROLL_ANIMATION_MARGIN_MS;

// The dice summary auto-continues to the next player only after a real
// AUTO_CONTINUE_SECONDS countdown (useAutoContinueCountdown), so a wait for
// that transition needs a timeout comfortably past the countdown's real
// wall-clock length.
const AUTO_CONTINUE_WAIT_MS = AUTO_CONTINUE_SECONDS * 1000 + 2000;
// A new turn's card flips for CARD_FLIP_MS before its controls appear, longer
// than findBy*'s default 1s. (An exiting panel used to linger past the flip
// and mask this; AnimatePresence is a pass-through in this file now.)
const AFTER_FLIP_WAIT_MS = CARD_FLIP_MS * 2;

// Mock confetti
vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('./utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  playTone: vi.fn(),
  vibrateBust: vi.fn(),
  vibrateSuccess: vi.fn(),
}));

// Create a mock for socket.io-client that can be configured per test. Every
// per-test literal assigned to it below is this same minimal shape (a couple
// of tests add `off`, which nothing else here uses).
type MockSocket = {
  on: Mock<(event: string, handler: (...args: unknown[]) => void) => void>;
  emit: Mock<(event: string, ...args: unknown[]) => void>;
  off?: Mock<(...args: unknown[]) => void>;
  disconnect: Mock<() => void>;
  id: string;
};
let mockSocketInstance: MockSocket | null = null;
vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => mockSocketInstance || {
      on: vi.fn(),
      emit: vi.fn(),
      off: vi.fn(),
      disconnect: vi.fn(),
      id: 'socket-default',
    })
  };
});

describe('App Integration (End-to-End)', () => {
  beforeEach(() => {
    localStorage.clear();
    useGameStore.getState().reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // connectSocket is a no-op while socketRef already holds a socket, so a
    // test whose real joinRoom created one otherwise hands its acks to the
    // next test (mirrors the shared afterEach in store/useGameStore.test.ts).
    disconnectSocket();
    _resetSocketSliceForTests();
  });

  it('plays a full local game with edge cases (Busts, Tuttos) to the EndScreen', async () => {
    useGameStore.setState({ diceMode: 'digital' });
    // 1. Setup deterministic game environment
    const originalRandom = Math.random;
    Math.random = () => 0.999999; // Deterministic: keeps the player order stable (identity shuffle)

    // We will control dice rolls to force specific outcomes
    const mockRolls: number[] = [];
    vi.spyOn(diceLogic, 'rollDie').mockImplementation(() => {
      if (mockRolls.length > 0) return nonNull(mockRolls.shift());
      return 1; // Default to 1 (valid score, 6 ones = Tutto)
    });

    render(<App />);

    // 2. Select Local Game
    const localButton = screen.getByText(/home.localPlay/i);
    fireEvent.click(localButton);

    // Pin the deck to '200' cards only so both turns deterministically draw a
    // '200' bonus card — buildDeck's constrained-random draw doesn't preserve
    // insertion order under a mocked Math.random the way the old plain shuffle
    // did. Must happen AFTER the mode click above, which resets initialCards.
    act(() => useGameStore.setState({ initialCards: { '200': 50 } }));

    // 2. Change Winning Score to 1000
    const advancedOptionsButton = screen.getByText(/lobby.showAdvancedOptions/i);
    fireEvent.click(advancedOptionsButton);
    
    // The input has label "Winning Score"
    // However, getByLabelText might fail if the label isn't linked with 'for', so let's get the input by value
    const winningScoreInput = screen.getByDisplayValue('6000');
    await userEvent.clear(winningScoreInput);
    await userEvent.type(winningScoreInput, '1000');

    // 3. Add Players
    const playerInput = screen.getByPlaceholderText(/lobby.newPlayerPlaceholder/i);
    await userEvent.type(playerInput, 'Alice');
    fireEvent.click(screen.getByRole('button', { name: /lobby.addPlayerButton/i }));

    await userEvent.clear(playerInput);
    await userEvent.type(playerInput, 'Bob');
    fireEvent.click(screen.getByRole('button', { name: /lobby.addPlayerButton/i }));

    // 4. Start Game
    const startButton = screen.getByText(/lobby.startGame/i);
    fireEvent.click(startButton);

    // 5. Game Board Renders
    await waitFor(() => {
      expect(screen.getByText('game.round')).toBeTruthy();
      expect(screen.getAllByText(/Alice/i).length).toBeGreaterThan(0);
    });

    // 6. First Card is drawn automatically.
    // It is '200' — the pinned deck contains nothing else.

    // Alice's turn. First card is '200'.
    // We just do 1 Tutto!
    const openModalButton = await screen.findByRole('button', { name: /game.controls.rollDice/i });
    fireEvent.click(openModalButton);
    
    // Wait for modal to render
    await screen.findByRole('heading', { name: /dice.title/i });

    // The dice auto-roll once the panel's entrance delay elapses — there's no
    // manual roll button anymore. Game.tsx's DICE_PANEL_ENTRANCE_MS timeout
    // starts the roll, and DiceGame's own tumble/settle timers then have to
    // run to completion before a die actually accepts a click (Die.tsx
    // disables it until the roll finalizes) — both are real timers here, so
    // this waits for real elapsed time rather than advancing a fake clock.
    await waitFor(() => {
      const dice = screen.getAllByTestId('die');
      expect(dice.length).toBeGreaterThanOrEqual(6);
      dice.forEach(die => expect(die).not.toBeDisabled());
    }, { timeout: FULL_ROLL_ANIMATION_MS });

    const actualDice = screen.getAllByTestId('die');
    actualDice.forEach(die => fireEvent.click(die));

    // After 1 Tutto on a 200 card, score should be 2200 points!
    // The summary now auto-continues to the next player (same as a bust), so we
    // assert on Alice's committed leaderboard score rather than the fleeting modal.
    const stopButton = await screen.findByText(/dice.stop_and_score/i);
    fireEvent.click(stopButton);

    // Auto-advance to Bob's turn; Alice's 2200 is recorded on the leaderboard,
    // rendered grouped ("2,200" — en-US default in tests, see formatNumber.ts).
    // Waiting on visible text alone is a false-positive trap here: "2,200" can
    // show up transiently inside Alice's OWN still-open summary, and "Bob" is
    // always in the leaderboard regardless of whose turn it is — neither
    // implies the turn actually advanced. currentPlayerIndex flipping to 1
    // is the one fact that does.
    await waitFor(() => {
      expect(useGameStore.getState().currentPlayerIndex).toBe(1);
    }, { timeout: AUTO_CONTINUE_WAIT_MS });
    expect(screen.getAllByText(/2,200/).length).toBeGreaterThan(0);

    // Bob's card is automatically drawn due to nextTurn logic.
    // It should be '200'.

    // Bob rolls dice
    const rollBobModal = await screen.findByRole('button', { name: /game.controls.rollDice/i }, { timeout: AFTER_FLIP_WAIT_MS });
    fireEvent.click(rollBobModal);

    await screen.findByRole('heading', { name: /dice.title/i });

    // The dice auto-roll once the panel's entrance delay elapses (see the
    // matching comment on Alice's turn above).
    await waitFor(() => {
      const dice = screen.getAllByTestId('die');
      expect(dice.length).toBeGreaterThanOrEqual(6);
      dice.forEach(die => expect(die).not.toBeDisabled());
    }, { timeout: FULL_ROLL_ANIMATION_MS });

    // We make Bob score just 100 points and stop
    const bobDice = screen.getAllByTestId('die');
    fireEvent.click(bobDice[0]); // Select one '1'

    const stopBob = await screen.findByText(/dice.stop_and_score/i);
    fireEvent.click(stopBob);

    // Bob's turn auto-continues too. Round is over! Alice has 2200, Bob has 100.
    // Winning score is 1000, so the End Screen should be shown! EndScreen's
    // own score cell renders it grouped ("2,200" — en-US default in tests).
    await waitFor(() => {
      expect(screen.getByText(/end.winner Alice/i)).toBeTruthy();
      expect(screen.getAllByText(/2,200/).length).toBeGreaterThan(0);
    }, { timeout: AUTO_CONTINUE_WAIT_MS });

    Math.random = originalRandom;
  }, 20000);


  it('renders ToastMessage and ReconnectPopup overlays based on store state', async () => {
    render(<App />);
    
    act(() => {
      useGameStore.setState({ toasts: [{ id: 1, message: 'Host ended game early' }] });
    });
    expect(screen.getByText('Host ended game early')).toBeInTheDocument();
    
    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });
    expect(screen.getByText('home.reconnect.title')).toBeInTheDocument();
    expect(screen.getByText(/home.reconnect.description/)).toBeInTheDocument();
    // aria-modal is what Game.tsx's global keyboard-shortcut guard checks for
    // — without it, a mid-game disconnect (Game stays mounted underneath
    // this popup) would let Space/Enter presses fall through to it.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');

    fireEvent.click(screen.getByText('home.reconnect.returnMenu'));
    expect(screen.queryByText('home.reconnect.title')).not.toBeInTheDocument();
    expect(useGameStore.getState().mode).toBe('local');
  });

  it('announces toasts, which are otherwise only ever seen', () => {
    // Every toast the app raises is transient and lives in a corner nothing
    // moves focus to: an invite link copied, a dice game resumed, a join
    // refused, a player kicked. Without a live region none of it is announced,
    // and a screen reader user is simply not told any of those things happened.
    render(<App />);

    act(() => {
      useGameStore.setState({ toasts: [{ id: 1, message: 'Host ended game early' }] });
    });

    // The reaction announcer (ReactionOverlay) is a status region too, so
    // find the toast's own region by its message rather than by role alone.
    const live = screen.getByText('Host ended game early').closest('[role="status"]');
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('lets a long toast wrap instead of overflowing the phone viewport', () => {
    // A toast is the only notice a player gets for losing a seat (kicked, a
    // name conflict, a superseded session), and it removes itself after
    // TOAST_LIFETIME_MS. Rendered nowrap inside a translate-centred fixed
    // container, a long message overflowed BOTH edges at phone widths, so the
    // one line that explained what happened was mostly off-screen.
    render(<App />);
    const message = 'Your seat in room ABCDEF was taken over by another device using the same name';

    act(() => {
      useGameStore.setState({ toasts: [{ id: 1, message }] });
    });

    const toast = screen.getByText(message);
    expect(toast).not.toHaveClass('whitespace-nowrap');
    expect(toast).toHaveClass('break-words');
    expect(toast).toHaveClass('max-w-[calc(100vw-2rem)]');
  });

  it('clears a toast once its time is up', () => {
    vi.useFakeTimers();
    render(<App />);

    act(() => {
      useGameStore.setState({ toasts: [{ id: 1, message: 'Host ended game early' }] });
    });

    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1); });
    expect(screen.getByText('Host ended game early')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1); });

    expect(useGameStore.getState().toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it('renders RestoreSessionPopup and clears session when clicking Cancel', async () => {
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });

    render(<App />);

    expect(screen.getByText('home.restore.title')).toBeInTheDocument();
    expect(screen.getByText(/home.restore.description/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');

    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    expect(screen.queryByText('home.restore.title')).not.toBeInTheDocument();
  });

  it('times out a reconnect whose ack never arrives instead of spinning forever', async () => {
    // joinRoom resolves only on the server's ack; if the server is down
    // mid-restart the promise never settles. The popup must fall back to the
    // failure path (dismissed + toast) after the shared join deadline rather
    // than show "attempting to reconnect" indefinitely.
    vi.useFakeTimers();
    // Restored afterwards: store reset() only rewinds state fields, so an
    // overridden ACTION would otherwise leak into every later test.
    const originalJoinRoom = useGameStore.getState().joinRoom;
    try {
      act(() => {
        useGameStore.setState({
          pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' },
          joinRoom: vi.fn(() => new Promise<JoinRoomResponse>(() => {})),
        });
      });
      render(<App />);

      fireEvent.click(screen.getByText('home.restore.yes'));
      expect(useGameStore.getState().showReconnectPopup).toBe(true);

      await act(async () => { vi.advanceTimersByTime(JOIN_TIMEOUT_MS + 100); });

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(useGameStore.getState().toasts.map(toast => toast.message))
        .toContain('lobby.online.joinTimeout');
    } finally {
      // act(): this runs before RTL unmounts App, so restoring the overridden
      // action re-renders a still-mounted tree. The restore itself cannot be
      // dropped — store reset() rewinds state fields only, so an overridden
      // ACTION would leak into every later test.
      act(() => { useGameStore.setState({ joinRoom: originalJoinRoom }); });
      vi.useRealTimers();
    }
  });

  it('translates a refused restore the server named a code for', async () => {
    // The restore popup toasts whatever the ack carried, and the ack's prose is
    // English in every language — so a refusal with a code must be rendered
    // from the code, the way the lobby's error box already is.
    const originalJoinRoom = useGameStore.getState().joinRoom;
    try {
      act(() => {
        useGameStore.setState({
          pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' },
          joinRoom: vi.fn(async () => ({
            success: false as const,
            code: 'name_taken',
            error: 'Username already exists in this room',
          })),
        });
      });
      render(<App />);

      await act(async () => { fireEvent.click(screen.getByText('home.restore.yes')); });

      const messages = useGameStore.getState().toasts.map(toast => toast.message);
      expect(messages).toContain('lobby.online.joinError.nameTaken');
      expect(messages.some(m => m.includes('Username already exists'))).toBe(false);
      expect(useGameStore.getState().showReconnectPopup).toBe(false);
    } finally {
      // act(): this runs before RTL unmounts App, so restoring the overridden
      // action re-renders a still-mounted tree. The restore itself cannot be
      // dropped — store reset() rewinds state fields only, so an overridden
      // ACTION would leak into every later test.
      act(() => { useGameStore.setState({ joinRoom: originalJoinRoom }); });
    }
  });

  it('shows a codeless refusal as the prose the server sent', async () => {
    // An older server, or a refusal with no key here yet: the sentence is still
    // shown rather than replaced by the generic failure message.
    const originalJoinRoom = useGameStore.getState().joinRoom;
    try {
      act(() => {
        useGameStore.setState({
          pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' },
          joinRoom: vi.fn(async () => ({ success: false as const, error: 'Refused, reason unknown to this client' })),
        });
      });
      render(<App />);

      await act(async () => { fireEvent.click(screen.getByText('home.restore.yes')); });

      expect(useGameStore.getState().toasts.map(toast => toast.message))
        .toContain('Refused, reason unknown to this client');
    } finally {
      // act(): this runs before RTL unmounts App, so restoring the overridden
      // action re-renders a still-mounted tree. The restore itself cannot be
      // dropped — store reset() rewinds state fields only, so an overridden
      // ACTION would leak into every later test.
      act(() => { useGameStore.setState({ joinRoom: originalJoinRoom }); });
    }
  });

  it('drops the stored session when the restore is refused because the room is gone', async () => {
    // The room itself is gone, not just this seat, so there is nothing left to
    // reconnect to — and init() re-reads tutto_online_session on every mount,
    // so a session left behind here asks the same dead question after every
    // reload. Driven through the socket rather than by overriding the action,
    // because the real joinRoom is half of what is under test.
    mockSocketInstance = {
      on: vi.fn(),
      emit: vi.fn((event, ...args) => {
        if (event === 'joinRoom') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            callback({ success: false, code: 'room-gone', error: 'That game is no longer on the server.' });
          }
        }
      }),
      disconnect: vi.fn(),
      id: 'socket-room-gone',
    };

    sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'GHOST_ROOM', myName: 'Charlie' }));
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });

    const { unmount } = render(<App />);
    await act(async () => { fireEvent.click(screen.getByText('home.restore.yes')); });

    expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
    expect(useGameStore.getState().pendingReconnectSession).toBeNull();

    // And the next page load does not ask again — which is the whole point:
    // App's init() rebuilds pendingReconnectSession from that stored session.
    unmount();
    render(<App />);
    expect(screen.queryByText('home.restore.title')).not.toBeInTheDocument();

    // This test's joinRoom really did create a socket. The shared afterEach
    // disconnects it (see the top of this describe block) — only the mock
    // instance itself needs resetting here.
    mockSocketInstance = null;
  });

  it('moves keyboard focus into the reconnect popup when it appears', async () => {
    // Neither of these popups is opened by a click, so nothing puts focus
    // inside them: it stays wherever the player left it, behind the backdrop.
    // Tab from there walks the page underneath instead of the dialog.
    render(<App />);

    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });

    await waitFor(() => {
      expect(screen.getByText('home.reconnect.returnMenu')).toHaveFocus();
    });
  });

  it('moves keyboard focus into the restore-session popup when it appears', async () => {
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('home.restore.yes')).toHaveFocus();
    });
  });

  it('keeps Tab inside the restore-session popup', async () => {
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });

    render(<App />);

    const cancel = screen.getByText('home.restore.cancel');
    cancel.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

    expect(screen.getByText('home.restore.yes')).toHaveFocus();
  });

  it('dismisses the "Connection Lost" popup and shows an error toast when reconnect join fails', async () => {
    // Before this fix, a failed joinRoom() left showReconnectPopup stuck at
    // true forever — there's no gameState event to clear it (the join never
    // succeeded), so the user would be stuck on a misleading "attempting to
    // reconnect" popup with no feedback that anything went wrong.
    mockSocketInstance = {
      on: vi.fn(),
      emit: vi.fn((event, ...args) => {
        if (event === 'joinRoom') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            callback({ success: false, error: 'Game is already running. You cannot join mid-game.' });
          }
        }
      }),
      disconnect: vi.fn(),
      id: 'socket-fail',
    };

    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'MIDGAME_ROOM', myName: 'Dave' } });
    });

    render(<App />);

    const reconnectButton = screen.getByText('home.restore.yes');
    await act(async () => {
      fireEvent.click(reconnectButton);
    });

    // The "Connection Lost" popup must not be stuck open.
    expect(useGameStore.getState().showReconnectPopup).toBe(false);
    expect(screen.queryByText('home.reconnect.title')).not.toBeInTheDocument();

    // The user must see feedback explaining what happened.
    const messages = useGameStore.getState().toasts.map(t => t.message);
    expect(messages).toContain('Game is already running. You cannot join mid-game.');

    mockSocketInstance = null;
  });

  it('RestoreSessionPopup Cancel button triggers temp socket join+leave flow', async () => {
    const { io } = await import('socket.io-client');

    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect') {
          // Simulate connection after a brief delay
          setTimeout(() => handler(), 5);
        }
      }),
      emit: vi.fn((event, ...args) => {
        // If joinRoom, invoke the callback
        if (event === 'joinRoom') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            setTimeout(() => callback({ success: true }), 10);
          }
        }
      }),
      disconnect: vi.fn(),
      id: 'temp-socket-123',
    };
    const socket = nonNull(mockSocketInstance);

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'TEST_ROOM_123', myName: 'Alice' },
        liveTurnState: makeDiceSnapshot({ turnScore: 50 }),
      });
    });
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 50 }));

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');

    fireEvent.click(cancelButton);

    // State should be immediately cleared
    expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    expect(useGameStore.getState().liveTurnState).toBeNull();

    // The flow is a chain of real-timer hops: connect → joinRoom → its ack →
    // leaveRoom → disconnect. Waiting on the last link rather than on a fixed
    // sleep, which a loaded run can outlast mid-chain — everything below it
    // has necessarily already happened by the time it has.
    await waitFor(() => expect(socket.disconnect).toHaveBeenCalled());

    // Verify temp socket was created
    expect(io).toHaveBeenCalledWith(expect.any(String));

    // Verify joinRoom was emitted with correct args
    const joinRoomCall = socket.emit.mock.calls.find(c => c[0] === 'joinRoom');
    expect(joinRoomCall).toBeTruthy();
    expect(nonNull(joinRoomCall)[1]).toMatchObject({
      roomId: 'TEST_ROOM_123',
      name: 'Alice',
      deviceId: expect.any(String),
    });

    // Verify leaveRoom was emitted after successful join
    expect(socket.emit).toHaveBeenCalledWith('leaveRoom');

    mockSocketInstance = null;
  });

  it('RestoreSessionPopup Cancel button cleans up on socket connect_error', async () => {
    let connectErrorHandler: ((...args: unknown[]) => void) | undefined;

    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect_error') {
          connectErrorHandler = handler;
        }
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
      id: 'temp-socket-error',
    };
    const socket = nonNull(mockSocketInstance);

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'ROOM_ERROR', myName: 'Bob' },
      });
    });

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Wait for the handler the temp socket registers, not for a duration —
    // and then call it unconditionally, since an `if` around it would turn a
    // registration that never happened into a silently passing test.
    await waitFor(() => expect(connectErrorHandler).toBeDefined());
    nonNull(connectErrorHandler)();

    // Should still clean up the socket. Asserted first because it is the
    // positive end of the error path: without waiting for something that does
    // happen, the negative below would pass merely by being early.
    await waitFor(() => expect(socket.disconnect).toHaveBeenCalled());

    // Should NOT attempt to join on error
    expect(socket.emit.mock.calls.some((c) => c[0] === 'joinRoom')).toBe(false);

    mockSocketInstance = null;
  });

  it('ReconnectPopup (in-game disconnect) does not create temp socket', async () => {
    const { io } = await import('socket.io-client');
    const ioMock = vi.mocked(io);
    const initialIOCallCount = ioMock.mock.calls.length;

    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });

    render(<App />);
    expect(screen.getByText('home.reconnect.title')).toBeInTheDocument();

    const returnButton = screen.getByText('home.reconnect.returnMenu');
    fireEvent.click(returnButton);

    // Popup should close
    expect(screen.queryByText('home.reconnect.title')).not.toBeInTheDocument();
    // Mode should switch to local (indicating intentional disconnect)
    expect(useGameStore.getState().mode).toBe('local');

    // No new temp socket should be created
    // (io call count should not increase beyond initial calls)
    expect(ioMock.mock.calls.length).toBe(initialIOCallCount);
  });

  it('RestoreSessionPopup Cancel explicitly calls cancelReconnect with roomId and name', async () => {
    const cancelReconnectSpy = vi.spyOn(useGameStore.getState(), 'cancelReconnect');

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'SPY_ROOM', myName: 'SpyUser' },
      });
    });

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Verify cancelReconnect was called with the correct roomId and name
    expect(cancelReconnectSpy).toHaveBeenCalledWith('SPY_ROOM', 'SpyUser');
    expect(cancelReconnectSpy).toHaveBeenCalledTimes(1);

    cancelReconnectSpy.mockRestore();
  });

  it('ReconnectPopup Return button calls cancelReconnect with no arguments', async () => {
    const cancelReconnectSpy = vi.spyOn(useGameStore.getState(), 'cancelReconnect');

    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });

    render(<App />);
    const returnButton = screen.getByText('home.reconnect.returnMenu');
    fireEvent.click(returnButton);

    // Verify cancelReconnect was called with no roomId/name (in-game disconnect)
    expect(cancelReconnectSpy).toHaveBeenCalledWith();
    expect(cancelReconnectSpy).toHaveBeenCalledTimes(1);

    cancelReconnectSpy.mockRestore();
  });

  it('RestoreSessionPopup Cancel handles socket timeout gracefully', async () => {
    let connectErrorHandler: ((...args: unknown[]) => void) | undefined;

    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect_error') {
          connectErrorHandler = handler;
        }
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
      id: 'temp-socket-timeout',
    };
    const socket = nonNull(mockSocketInstance);

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'TIMEOUT_ROOM', myName: 'TimeoutUser' },
      });
    });

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Simulate the connection failing, as a timeout would — once the handler
    // is actually registered rather than after a guess at how long that takes.
    await waitFor(() => expect(connectErrorHandler).toBeDefined());
    nonNull(connectErrorHandler)();

    // Should have called disconnect to clean up
    await waitFor(() => expect(socket.disconnect).toHaveBeenCalled());
    // Should not have attempted joinRoom
    const joinRoomCalls = socket.emit.mock.calls.filter(c => c[0] === 'joinRoom');
    expect(joinRoomCalls.length).toBe(0);

    mockSocketInstance = null;
  });

  it('RestoreSessionPopup Cancel propagates localStorage/sessionStorage cleanup on cancel', async () => {
    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'CLEANUP_ROOM', myName: 'CleanupUser' },
        liveTurnState: makeDiceSnapshot({ turnScore: 75 }),
      });
    });

    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 75 }));
    localStorage.setItem('tutto_color', '#FF5733');
    sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'CLEANUP_ROOM', myName: 'CleanupUser' }));

    render(<App />);

    // Verify data exists before cancel
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeTruthy();
    expect(sessionStorage.getItem('tutto_online_session')).toBeTruthy();

    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Game state should be cleared. Retried until it is, rather than checked
    // once after a sleep long enough to hope it was.
    await waitFor(() => {
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(useGameStore.getState().liveTurnState).toBeNull();
      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    });

    // But user preferences should remain
    expect(localStorage.getItem('tutto_color')).toBe('#FF5733');

    mockSocketInstance = null;
  });

  it('RestoreSessionPopup Cancel with multiple state mutations maintains consistency', async () => {
    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 5);
        }
      }),
      emit: vi.fn((event, ...args) => {
        if (event === 'joinRoom') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            setTimeout(() => callback({ success: true }), 10);
          }
        }
      }),
      disconnect: vi.fn(),
      id: 'temp-socket-consistency',
    };
    const socket = nonNull(mockSocketInstance);

    // Set up complex state
    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'CONSISTENCY_ROOM', myName: 'ConsistencyUser' },
        liveTurnState: makeDiceSnapshot({
          turnScore: 200,
          keptDice: [{ id: 'd1', val: 1 }, { id: 'd2', val: 2 }, { id: 'd3', val: 3 }],
        }),
        showReconnectPopup: false,
      });
    });

    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 200, keptDice: [1, 2, 3] }));
    sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'CONSISTENCY_ROOM', myName: 'ConsistencyUser' }));

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');

    fireEvent.click(cancelButton);

    // The same chain as the join+leave test above, so wait on the same last
    // link: disconnect. Everything asserted below precedes it.
    await waitFor(() => expect(socket.disconnect).toHaveBeenCalled());

    // All game state should be cleared consistently
    const state = useGameStore.getState();
    expect(state.pendingReconnectSession).toBeNull();
    expect(state.liveTurnState).toBeNull();
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(sessionStorage.getItem('tutto_online_session')).toBeNull();

    // Temp socket should have properly left
    expect(socket.emit).toHaveBeenCalledWith('leaveRoom');

    mockSocketInstance = null;
  });

  // Both reconnect tests below used to build their own "simulate what the
  // actual gameState handler does" function inside the test and then assert on
  // the store fields that local function had just written -- socketSlice's real
  // handler never ran, and its `wasDisconnected && status === 'playing'` rule
  // could have been anything. These drive the registered handler instead.
  const withCapturedHandlers = (): Record<string, (...args: unknown[]) => void> => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    mockSocketInstance = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => { handlers[event] = handler; }),
      emit: vi.fn(),
      off: vi.fn(),
      disconnect: vi.fn(),
      id: 'socket-reconnect',
    };
    // connectSocket is a no-op while a socket already exists (socketRef) —
    // the shared afterEach above disconnects it after every test, so this
    // always sees a clean socketRef and actually creates one from the
    // instance just staged above.
    act(() => { useGameStore.getState().connectSocket(); });
    return handlers;
  };

  const PLAYING_ROOM = {
    status: 'playing',
    currentPlayerIndex: 1,
    currentCard: 'Kniffel',
    turnDuration: 60,
    liveTurnState: null,
    finished: false,
  };

  it('sets justReconnected on a reconnect into a running game with no dice panel open', () => {
    // The rule is the STATUS, not liveTurnState: a player who reconnects while
    // someone else is mid-turn on physical dice has no live dice state to
    // recognise, and still needs the timer resynced.
    const handlers = withCapturedHandlers();
    act(() => {
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'RECONNECT_ROOM',
        status: 'playing', currentPlayerIndex: 1, liveTurnState: null,
        justReconnected: false, showReconnectPopup: true,
      });
    });

    act(() => { handlers.gameState({ ...PLAYING_ROOM }); });

    expect(useGameStore.getState().justReconnected).toBe(true);
    expect(useGameStore.getState().liveTurnState).toBeNull();
    expect(useGameStore.getState().showReconnectPopup, 'the popup outlived the reconnect').toBe(false);

    mockSocketInstance = null;
  });

  it('does not set justReconnected when the reconnect lands in the lobby', () => {
    const handlers = withCapturedHandlers();
    act(() => {
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'RECONNECT_LOBBY',
        status: 'lobby', currentPlayerIndex: null,
        justReconnected: false, showReconnectPopup: true,
      });
    });

    act(() => {
      handlers.gameState({ status: 'lobby', currentPlayerIndex: null, players: [], liveTurnState: null, finished: false });
    });

    expect(useGameStore.getState().justReconnected).toBe(false);
    expect(useGameStore.getState().showReconnectPopup).toBe(false);

    mockSocketInstance = null;
  });

  it('clears justReconnected on the very next broadcast, mounted component or not', () => {
    // Self-clearing is the half no test covered, and the half that goes wrong
    // silently: nothing guarantees a component was mounted to consume the
    // flag, so without the reset here it stays true and resurfaces on a later,
    // unrelated turn (reconnecting as a spectator, or on physical dice).
    const handlers = withCapturedHandlers();
    act(() => {
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'RECONNECT_ROOM',
        status: 'playing', currentPlayerIndex: 1, liveTurnState: null,
        justReconnected: false, showReconnectPopup: true,
      });
    });

    act(() => { handlers.gameState({ ...PLAYING_ROOM }); });
    expect(useGameStore.getState().justReconnected).toBe(true);

    // An ordinary turn broadcast, with no reconnect behind it.
    act(() => { handlers.gameState({ ...PLAYING_ROOM, currentPlayerIndex: 0 }); });

    expect(useGameStore.getState().justReconnected, 'the flag is stuck on for the rest of the game').toBe(false);

    mockSocketInstance = null;
  });

  it('DiceGame does not auto-open on reconnect without liveTurnState', async () => {
    render(<App />);

    // Staged after mount, not before: App's startup restores the store from
    // storage, and with localStorage cleared in beforeEach that means defaults
    // overwriting whatever was staged first. Set up ahead of the render, none
    // of this survived — the app stayed on Home, and the negative assertion
    // below passed for want of anything at all being on screen.
    act(() => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        myName: 'Alice',
        diceMode: 'digital',
        players: [makePlayer({ name: 'Alice', socketId: 'sock-123' })],
        justReconnected: true,
        liveTurnState: null,  // No saved dice state
        showReconnectPopup: false,
      });
    });

    // Wait for the game view to be up — Game.tsx renders the leaderboard
    // unconditionally, so its arrival is the signal that the effects under
    // test have actually run.
    expect(screen.getByText('game.leaderboard')).toBeInTheDocument();

    // DiceGame should NOT appear because liveTurnState is null
    expect(screen.queryByText(/resume|rolling/i)).not.toBeInTheDocument();
  });

  it('Game time syncs from server on start and is maintained during play', async () => {
    vi.useFakeTimers();
    try {
      act(() => {
        useGameStore.setState({
          mode: 'local',
          isOnline: false,
          players: [makePlayer({ name: 'Alice', score: 0 })],
          status: 'lobby',
        });
      });

      render(<App />);

      // Start game
      act(() => {
        useGameStore.getState().startGame();
      });

      // Game time should initialize to 0
      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
      expect(useGameStore.getState().status).toBe('playing');

      // The local game clock ticks on a real 1000ms setInterval (see
      // startLocalTimers in store/timers.ts) — advance it instead of
      // sleeping a real second.
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    } finally {
      _resetTimersForTests();
      vi.useRealTimers();
    }
  });

  it('Game time resyncs from server without drift on reconnect', async () => {
    // Simulate player in online game - server time is at 30 seconds
    useGameStore.setState({
      mode: 'online',
      isOnline: true,
      status: 'playing',
      currentPlayerIndex: 0,
      gameTimeInSeconds: 30,
      gameStartTime: Date.now() - 30000,  // Set up so elapsed time = 30 seconds
    });

    // First sync establishes baseline
    useGameStore.getState().syncOnlineTimers();
    let state = useGameStore.getState();
    let initialElapsed = Math.floor((Date.now() - nonNull(state.gameStartTime)) / 1000);
    expect(initialElapsed).toBe(30);

    // Server time advances to 35 seconds (e.g., due to network latency or processing)
    useGameStore.setState({ gameTimeInSeconds: 35 });

    // Re-sync with new server time
    useGameStore.getState().syncOnlineTimers();

    state = useGameStore.getState();
    const resyncElapsed = Math.floor((Date.now() - nonNull(state.gameStartTime)) / 1000);

    // Should now reflect 35 seconds
    expect(resyncElapsed).toBe(35);

    // Wait a bit and verify time continues to advance from correct reference
    vi.useFakeTimers();
    try {
      act(() => {
        vi.advanceTimersByTime(500);
      });

      state = useGameStore.getState();
      const afterWait = Math.floor((Date.now() - nonNull(state.gameStartTime)) / 1000);
      // Should be ~35.5 seconds
      expect(afterWait).toBeGreaterThanOrEqual(35);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Game time does not drift across multiple server updates', async () => {
    const measurements = [];

    // Simulate multiple syncs with server time advancing
    for (let serverTime = 10; serverTime <= 12; serverTime++) {
      act(() => {
        useGameStore.setState({
          mode: 'online',
          isOnline: true,
          status: 'playing',
          currentPlayerIndex: 0,
          gameTimeInSeconds: serverTime,
        });
      });

      useGameStore.getState().syncOnlineTimers();

      const store = useGameStore.getState();
      const elapsedMs = Date.now() - nonNull(store.gameStartTime);
      const elapsedSeconds = Math.floor(elapsedMs / 1000);

      measurements.push({ server: serverTime, local: elapsedSeconds });

      // Fast-forward simulated time by shifting gameStartTime backward 1000ms
      if (serverTime < 12) {
        act(() => {
          useGameStore.setState(s => ({ gameStartTime: nonNull(s.gameStartTime) - 1000 }));
        });
      }
    }

    // Verify no significant drift
    measurements.forEach(({ server, local }) => {
      // Local time should match server time within ±1 second
      expect(Math.abs(server - local)).toBeLessThanOrEqual(1);
    });
  });

  it('lets a join link win over a saved local game, and keeps the save', async () => {
    // Following an invitation with an unfinished local game on this device
    // used to land on that old game's board: init() restored it, so App routed
    // into <Game/> and <Home/> — the only thing that consumes the link — was
    // unmounted before the code could be typed anywhere.
    const savedGame = JSON.stringify({
      players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
      status: 'playing', currentPlayerIndex: 0, finished: false, round: 2, gameTimeInSeconds: 50,
    });
    localStorage.setItem('tutto_local_game', savedGame);
    window.history.replaceState({}, '', '/?room=LINKED');

    try {
      render(<App />);

      // The invitation's lobby, with the room already filled in.
      expect(screen.getByDisplayValue('LINKED')).toBeInTheDocument();
      expect(screen.queryByText('game.round')).not.toBeInTheDocument();

      // Nothing was thrown away: the save is still on disk, so picking local
      // play resumes the game exactly where it was left.
      expect(JSON.parse(nonNull(localStorage.getItem('tutto_local_game'))).players[0].name).toBe('Alice');
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('Game time sync works for both online and local games', async () => {
    vi.useFakeTimers();
    try {
      // Local game
      act(() => {
        useGameStore.setState({
          mode: 'local',
          isOnline: false,
          players: [makePlayer({ name: 'Alice', score: 0 })],
          status: 'lobby',
        });
      });

      useGameStore.getState().startGame();
      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);

      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThanOrEqual(1);

      useGameStore.getState().reset();
      _resetTimersForTests();

      // Online game
      act(() => {
        useGameStore.setState({
          mode: 'online',
          isOnline: true,
          status: 'playing',
          currentPlayerIndex: 0,
          gameTimeInSeconds: 0,
        });
      });

      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);

      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    } finally {
      _resetTimersForTests();
      vi.useRealTimers();
    }
  });

  // swUpdate.ts (isSafeToApplyUpdate) refuses to apply a waiting update while
  // this is true: `showStats` below is plain component state, never
  // persisted, so a reload lands back on Home rather than reopening
  // Statistics — there is no "same screen" to resume reading on. See
  // uiBusyState.ts.
  // B58: startup used to ignore prefers-color-scheme outright (`localStore.read
  // ('tutto-theme') || 'light'`), so a dark-mode OS with no prior in-app choice
  // still opened white. resolveInitialTheme (themePreference.ts) is unit-tested
  // on its own; these drive it through App's actual mount to prove the value it
  // returns is what ends up on <html data-theme>.
  describe('honouring the OS colour scheme on first load', () => {
    // The whole document, not a container React unmounts — App writes
    // data-theme onto <html> itself (see the effect in App.tsx), and nothing
    // clears that attribute between tests. Reset here to whatever the OS says
    // matches:false resolves to (light), the same value setupTests.tsx's own
    // default matchMedia mock would have left it at anyway.
    afterEach(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      vi.unstubAllGlobals();
    });

    const stubSystemScheme = (prefersDark: boolean) => {
      vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        matches: prefersDark,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })));
    };

    it('opens dark when nothing was chosen before and the OS prefers dark', () => {
      stubSystemScheme(true);

      render(<App />);

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('keeps a stored light choice even though the OS now prefers dark', () => {
      localStorage.setItem('tutto-theme', 'light');
      stubSystemScheme(true);

      render(<App />);

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  // The per-device Animations override (LobbyShared.tsx's AnimationsSettingSelector,
  // motionOverride in the store): a player who wants their OS's reduced-motion
  // setting overridden flips it on, and both halves that honour "user" motion
  // preference — framer-motion's own MotionConfig and the CSS block in
  // index.css gated on data-motion — must follow it.
  describe('honouring the per-device Animations override', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('data-motion');
    });

    it('passes reducedMotion="user" and carries no data-motion attribute by default', () => {
      render(<App />);

      expect(capturedMotionConfig.reducedMotion).toBe('user');
      expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
    });

    it('passes reducedMotion="never" and sets data-motion="always" when the override is on', () => {
      useGameStore.setState({ motionOverride: true });

      render(<App />);

      expect(capturedMotionConfig.reducedMotion).toBe('never');
      expect(document.documentElement.getAttribute('data-motion')).toBe('always');
    });
  });

  describe('reporting the Statistics screen to uiBusyState', () => {
    // Statistics.tsx observes chart elements into view with framer-motion's
    // viewport feature, which jsdom has no native IntersectionObserver for —
    // see Statistics.test.tsx's own copy of this stub.
    beforeAll(() => {
      class MockIntersectionObserver implements IntersectionObserver {
        root: Element | Document | null = null;
        rootMargin = '';
        scrollMargin = '';
        thresholds: number[] = [];
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords(): IntersectionObserverEntry[] { return []; }
      }
      window.IntersectionObserver = MockIntersectionObserver;
    });

    afterEach(() => {
      _resetUiBusyStateForTests();
    });

    it('goes busy on opening Statistics and idle again on going back', async () => {
      render(<App />);
      expect(uiBusyState.getState().statsScreenOpen).toBe(false);

      fireEvent.click(screen.getByText(/home.viewStats/i));
      await waitFor(() => expect(uiBusyState.getState().statsScreenOpen).toBe(true));

      const backButton = await screen.findByRole('button', { name: /common.back/i });
      fireEvent.click(backButton);

      expect(uiBusyState.getState().statsScreenOpen).toBe(false);
    });

    it('clears the flag on unmount so a closed app cannot leave an update stuck', async () => {
      const { unmount } = render(<App />);

      fireEvent.click(screen.getByText(/home.viewStats/i));
      await waitFor(() => expect(uiBusyState.getState().statsScreenOpen).toBe(true));

      unmount();

      expect(uiBusyState.getState().statsScreenOpen).toBe(false);
    });
  });

  describe('EndScreen -> View Statistics -> Back', () => {
    // Same jsdom gap as the describe above — Statistics renders regardless of
    // which screen opened it.
    beforeAll(() => {
      class MockIntersectionObserver implements IntersectionObserver {
        root: Element | Document | null = null;
        rootMargin = '';
        scrollMargin = '';
        thresholds: number[] = [];
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords(): IntersectionObserverEntry[] { return []; }
      }
      window.IntersectionObserver = MockIntersectionObserver;
    });

    it('opens Statistics without clearing the finished game, and Back returns to the same winner', async () => {
      useGameStore.setState({
        finished: true,
        currentPlayerIndex: null,
        players: [
          makePlayer({ name: 'Alice', score: 10000, position: 1 }),
          makePlayer({ name: 'Bob', score: 5000, position: 2 }),
        ],
        round: 5,
      });

      render(<App />);

      // The end screen is up first, with Alice as the winner (highest score).
      // A generous timeout, not the RTL default: EndScreen is lazy-loaded
      // (see App.tsx), and the very first dynamic import a test file makes
      // can outlast the 1s default under a cold/loaded transform.
      expect(await screen.findByText('Alice', {}, { timeout: 5000 })).toBeInTheDocument();

      fireEvent.click(screen.getByText(/end.viewStatistics/i));

      // Statistics is showing now (its own Back button), and the end screen
      // — including the winner's name — is off-screen, not just covered.
      const backButton = await screen.findByRole('button', { name: /common.back/i }, { timeout: 5000 });
      expect(screen.queryByText('Alice')).toBeNull();

      fireEvent.click(backButton);

      // Back lands on the SAME finished game, not a cleared one — no restart,
      // no return to Home, no toggling `finished`.
      // A generous timeout, not the RTL default: EndScreen is lazy-loaded
      // (see App.tsx), and the very first dynamic import a test file makes
      // can outlast the 1s default under a cold/loaded transform.
      expect(await screen.findByText('Alice', {}, { timeout: 5000 })).toBeInTheDocument();
      expect(useGameStore.getState().finished).toBe(true);
    });
  });

  describe('closing Statistics when a game starts', () => {
    // Same jsdom gap as the describes above — Statistics renders regardless
    // of which screen opened it.
    beforeAll(() => {
      class MockIntersectionObserver implements IntersectionObserver {
        root: Element | Document | null = null;
        rootMargin = '';
        scrollMargin = '';
        thresholds: number[] = [];
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords(): IntersectionObserverEntry[] { return []; }
      }
      window.IntersectionObserver = MockIntersectionObserver;
    });

    it('leaves Statistics open when a game only finishes', async () => {
      // Finishing while already on Statistics (e.g. a slow-to-load Statistics
      // screen racing the final gameState broadcast) must not be treated the
      // same as a new game starting — no `isPlaying` transition happened, so
      // nothing should close the screen out from under the reader.
      useGameStore.setState({
        finished: true,
        currentPlayerIndex: null,
        players: [
          makePlayer({ name: 'Alice', score: 10000, position: 1 }),
          makePlayer({ name: 'Bob', score: 5000, position: 2 }),
        ],
        round: 5,
      });

      render(<App />);

      expect(await screen.findByText('Alice', {}, { timeout: 5000 })).toBeInTheDocument();

      fireEvent.click(screen.getByText(/end.viewStatistics/i));
      await screen.findByRole('button', { name: /common.back/i }, { timeout: 5000 });

      act(() => {
        useGameStore.setState({ finished: true, round: 6 });
      });

      expect(screen.getByRole('button', { name: /common.back/i })).toBeInTheDocument();
    });

    it('closes Statistics and shows the running game when the host starts the next round', async () => {
      // A player who opened Statistics from the end screen must not stay on
      // it silently while an online game starts under them — they would
      // otherwise miss their turn with no indication anything changed.
      useGameStore.setState({
        finished: true,
        currentPlayerIndex: null,
        players: [
          makePlayer({ name: 'Alice', score: 10000, position: 1 }),
          makePlayer({ name: 'Bob', score: 5000, position: 2 }),
        ],
        round: 5,
      });

      render(<App />);

      expect(await screen.findByText('Alice', {}, { timeout: 5000 })).toBeInTheDocument();

      fireEvent.click(screen.getByText(/end.viewStatistics/i));
      await screen.findByRole('button', { name: /common.back/i }, { timeout: 5000 });

      // The host starts the next game while this player is still reading
      // Statistics — isPlaying flips true out from under them.
      act(() => {
        useGameStore.setState({
          finished: false,
          currentPlayerIndex: 0,
          players: [
            makePlayer({ name: 'Alice', score: 0, position: 1 }),
            makePlayer({ name: 'Bob', score: 0, position: 2 }),
          ],
          round: 1,
        });
      });

      expect(screen.queryByRole('button', { name: /common.back/i })).toBeNull();
      expect(await screen.findByText('game.currentPlayer')).toBeInTheDocument();
    });
  });
});
