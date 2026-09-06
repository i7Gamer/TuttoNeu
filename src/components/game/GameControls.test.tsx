import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
// AnimatePresence as a pass-through: tests in this file run on fake timers,
// under which framer-motion's frame loop does not advance (and does not recover
// once real timers return), so a dismissed dialog's exit animation (ModalShell)
// would never finish and the panel never leave the DOM. Nothing here asserts on
// the animation itself — ModalShell.motion.test does.
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import GameControls from './GameControls';
import { useGameStore, type GameStore } from '../../store/useGameStore';
import type { CardType, DiceSnapshot } from '../../types';
import { CARD_FLIP_MS, SPECTATOR_LIVE_STATE_GRACE_MS } from '../../utils/uiTimings';
import { MAX_SCORE_MAGNITUDE } from '../../utils/configValidation';
import { makePlayer, makeDiceSnapshot } from '../../testing/factories';

// GameControls now reads currentCard, cards, ruleset, isOnline, isHost,
// liveTurnState and currentPlayer (plus the undo/endGame/leaveRoom actions)
// straight off the store instead of taking them as props (see Game.tsx's
// useGameSlice for the same narrowing, and AdvancedOptionsPanel in
// LobbyShared.tsx for the pattern this copies). So driving these tests means
// setting store state, not passing props -- mirrors the beforeEach in
// Game.test.tsx: reset() first (the store outlives every test), then clear
// the localStorage/sessionStorage caches reset() deliberately leaves alone,
// then layer this file's own baseline on top.
const setStore = (partial: Partial<GameStore> = {}) => {
  useGameStore.getState().reset();
  localStorage.clear();
  sessionStorage.clear();
  useGameStore.setState({
    enforcedDiceMode: null,
    currentCard: '200',
    cards: Array.from({ length: 5 }),
    ruleset: 'modernized',
    isOnline: false,
    isHost: true,
    liveTurnState: null,
    currentPlayerIndex: 0,
    players: [makePlayer({ name: 'Alice', socketId: 'socket1', position: 1 })],
    undo: vi.fn(),
    endGame: vi.fn(),
    leaveRoom: vi.fn(),
    ...partial,
  });
};

beforeEach(() => {
  setStore();
});

describe('GameControls card-flip state', () => {
  // Replaces six tests that imported GameControls, never rendered it, and
  // asserted on local variables they had just assigned -- deleting
  // GameControls.tsx would not have failed one of them. What they were
  // gesturing at is real and is below: the flip is derived DURING render, not
  // in an effect, so the new card and the hidden controls land on the same
  // frame instead of the old content painting once first.
  //
  // Real timers throughout: the controls sit inside an AnimatePresence, so
  // their disappearance is one exit animation away and fake timers do not
  // drive it. Every wait below is bounded by the flip's own deadline rather
  // than by a guess, so none of them can pass merely by being slow.
  const flipProps = (overrides = {}) => ({
    isMyTurn: true,
    diceMode: 'physical' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    canUndo: true,
    ...overrides,
  });

  const scoreInputShown = () => screen.queryByPlaceholderText('game.controls.scorePlaceholder') !== null;
  // Comfortably past the only clock in play, so "still hidden" cannot mean
  // "the timer had not got round to it yet".
  const PAST_THE_FLIP_MS = CARD_FLIP_MS * 2;
  const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('hides the turn controls for exactly one flip when the card changes', async () => {
    setStore({ currentCard: '200', cards: Array.from({ length: 5 }) });
    render(<GameControls {...flipProps()} />);
    expect(scoreInputShown(), 'the first render has nothing to flip from').toBe(true);

    act(() => { useGameStore.setState({ currentCard: 'x2' }); });
    await waitFor(() => {
      expect(scoreInputShown(), 'the old card\'s controls stayed up over the new card').toBe(false);
    });

    await waitFor(() => {
      expect(scoreInputShown(), 'the controls never came back').toBe(true);
    }, { timeout: PAST_THE_FLIP_MS });
  });

  it('flips on a deck-size change too, not only on a new card', async () => {
    // The other half of the trigger condition. A classic mid-turn draw moves
    // both at once, but the deck can also shrink on its own (a reshuffle),
    // and the controls have to be covered for that too -- the card face
    // behind them is about to be replaced either way.
    //
    // Asserted as the transition, never as "still visible after a wait":
    // written that way this test passed while the flip WAS happening, because
    // the settle it used outlasted the flip it was denying.
    setStore({ currentCard: 'x2', cards: Array.from({ length: 5 }) });
    render(<GameControls {...flipProps()} />);
    expect(scoreInputShown()).toBe(true);

    act(() => { useGameStore.setState({ cards: Array.from({ length: 4 }) }); });

    await waitFor(() => {
      expect(scoreInputShown(), 'a deck-size change alone left the old controls up').toBe(false);
    });
    await waitFor(() => expect(scoreInputShown()).toBe(true), { timeout: PAST_THE_FLIP_MS });
  });

  it('clears a flip left standing when there is no card on either side of the change', async () => {
    // Going card -> null starts a flip whose timer never arms (the effect
    // needs a currentCard), so the reset branch is the only thing that can
    // end it. Without that branch the controls stay hidden for good.
    setStore({ currentCard: '200', cards: Array.from({ length: 5 }) });
    render(<GameControls {...flipProps()} />);

    act(() => { useGameStore.setState({ currentCard: null }); });
    await waitFor(() => expect(scoreInputShown()).toBe(false));

    await settle(PAST_THE_FLIP_MS);
    expect(scoreInputShown(), 'no card means no timer, so the flip is still standing').toBe(false);

    act(() => { useGameStore.setState({ currentCard: null, cards: Array.from({ length: 4 }) }); });

    await waitFor(() => {
      expect(scoreInputShown(), 'the reset branch never ran, so the controls are gone for good').toBe(true);
    });
  });
});

describe('GameControls spectator view (online, not my turn)', () => {
  const renderSpectator = (activeTurnState: DiceSnapshot, currentCard: CardType | null = null, diceMode: 'digital' | 'physical' = 'digital') => {
    setStore({ isOnline: true, isHost: false, currentCard, liveTurnState: activeTurnState });
    return render(
      <GameControls
        isMyTurn={false}
        diceMode={diceMode}
        setShowDiceGame={vi.fn()}
        scoreInput=""
        setScoreInput={vi.fn()}
        applyBonus={false}
        setApplyBonus={vi.fn()}
        handleNextTurn={vi.fn()}
        handleYesNo={vi.fn()}
        canUndo={true}
      />
    );
  };

  // With currentRoll empty, the only single-digit texts on screen are the kept dice.
  const keptDiceOrder = () => screen.getAllByText(/^[1-6]$/).map((el) => el.textContent);

  it('sorts kept dice ascending for Kniffel when the first target is 1 (same as the active player)', () => {
    renderSpectator(
      {
        turnScore: 300,
        keptDice: [{ id: 'a', val: 5 }, { id: 'b', val: 1 }, { id: 'c', val: 3 }],
        currentRoll: [],
        kniffelProgress: [1],
        tuttosThisTurn: 0,
      },
      'Kniffel'
    );
    expect(keptDiceOrder()).toEqual(['1', '3', '5']);
  });

  it('sorts kept dice descending for Kniffel when the first target is not 1', () => {
    renderSpectator(
      {
        turnScore: 300,
        keptDice: [{ id: 'a', val: 1 }, { id: 'b', val: 3 }, { id: 'c', val: 5 }],
        currentRoll: [],
        kniffelProgress: [6],
        tuttosThisTurn: 0,
      },
      'Kniffel'
    );
    expect(keptDiceOrder()).toEqual(['5', '3', '1']);
  });

  it('leaves kept dice in their original order for non-Kniffel cards', () => {
    renderSpectator(
      {
        turnScore: 300,
        keptDice: [{ id: 'a', val: 5 }, { id: 'b', val: 1 }, { id: 'c', val: 3 }],
        currentRoll: [],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    expect(keptDiceOrder()).toEqual(['5', '1', '3']);
  });

  // The spectator panel mirrors the active player's dice, and the faces are
  // pips — SVG circles carrying no text. The dice INSIDE the roll panel were
  // given names in 62c1f1b; this mirror was missed, so a spectator using a
  // screen reader heard the running total but never the dice behind it.
  it('groups the mirrored running total like every other score on screen', () => {
    renderSpectator({
      turnScore: 1200,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0,
    }, '200');

    expect(screen.getByText('1,200')).toBeInTheDocument();
  });

  it('names every mirrored die for a screen reader', () => {
    renderSpectator({
      turnScore: 300,
      keptDice: [{ id: 'a', val: 5 }, { id: 'b', val: 1 }],
      currentRoll: [{ id: 'c', val: 3, selected: false }, { id: 'd', val: 6, selected: true }],
      kniffelProgress: [],
      tuttosThisTurn: 0,
    }, '200');

    // Two kept plus two rolled — every one of the four, not just the tray.
    const named = screen.getAllByRole('img');
    expect(named).toHaveLength(4);
    named.forEach(die => expect(die).toHaveAttribute('aria-label'));
  });

  it('shows the live dice view to spectators whose OWN diceMode is physical', () => {
    // diceMode is a per-device input preference — it decides how the viewer
    // enters their own turns, not whether they may watch the active player's
    // digital dice. Physical-dice spectators used to get only the generic
    // waiting spinner.
    renderSpectator(
      {
        turnScore: 450,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'r1', val: 5, selected: false }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200',
      'physical'
    );
    expect(screen.getByText('450')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByText(/waiting/i)).toBeNull();
  });

  it('gives a selected spectator die a dark-mode background so its pips stay visible (not emerald-100 on emerald-100)', () => {
    renderSpectator(
      {
        turnScore: 100,
        keptDice: [],
        currentRoll: [{ id: 'r1', val: 5, selected: true }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    const selectedDie = screen.getByText('5');
    expect(selectedDie.className).toContain('dark:bg-slate-700');
  });

  it('marks busted dice red and shows no bust text', () => {
    renderSpectator(
      {
        turnScore: 0,
        keptDice: [],
        currentRoll: [
          { id: 'r1', val: 2, selected: false },
          { id: 'r2', val: 4, selected: false },
        ],
        kniffelProgress: [],
        tuttosThisTurn: 0,
        busted: true,
      },
      '200'
    );
    expect(screen.queryByText('dice.bust_description')).toBeNull();
    expect(screen.getByText('2').className).toContain('border-red-300');
    expect(screen.getByText('4').className).toContain('border-red-300');
  });

  it('applies text-transparent class to kept and roll spectator dice to visually hide text numbers', () => {
    renderSpectator(
      {
        turnScore: 450,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'r1', val: 5, selected: false }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    // Kept dice uses DiePips with indigo styling
    expect(screen.getByText('1').className).toContain('text-transparent');
    // Roll dice uses DiePips
    expect(screen.getByText('5').className).toContain('text-transparent');
  });

  it('ensures spectator dice text is transparent (via class, not inline style)', () => {
    renderSpectator(
      {
        turnScore: 450,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'r1', val: 5, selected: false }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    const keptDie = screen.getByText('1');
    const rollDie = screen.getByText('5');
    // Should use text-transparent class
    expect(keptDie.className).toContain('text-transparent');
    expect(rollDie.className).toContain('text-transparent');
    // Should NOT have redundant inline color style
    expect(keptDie.style.color).not.toBe('transparent');
    expect(rollDie.style.color).not.toBe('transparent');
  });
});

describe('GameControls spectator view when the active player rolls physical dice', () => {
  // Physical dice never push a liveTurnState — an individual player's OWN
  // dice-mode preference never leaves their device, so enforcedDiceMode is
  // the only signal a spectator has that no snapshot is ever coming. Without
  // it, the generic "waiting" branch (a spinner) used to spin for the whole
  // real-world duration of the active player's turn.
  const renderAsSpectator = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => {
    return render(
      <GameControls
        isMyTurn={false}
        diceMode="digital"
        setShowDiceGame={vi.fn()}
        scoreInput=""
        setScoreInput={vi.fn()}
        applyBonus={false}
        setApplyBonus={vi.fn()}
        handleNextTurn={vi.fn()}
        handleYesNo={vi.fn()}
        canUndo={true}
        {...overrides}
      />
    );
  };

  it('shows a static notice instead of a spinner when the room enforces physical dice', () => {
    setStore({
      isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: 'physical',
      currentPlayerIndex: 0,
      players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
    });
    const { container } = renderAsSpectator();

    expect(screen.getByText('game.physicalTurnNotice')).toBeInTheDocument();
    expect(screen.queryByText('game.controls.waiting')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('shows the turn-timer countdown beside the notice when a turn timer is running', () => {
    setStore({
      isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: 'physical',
      turnTimeRemaining: 12,
      currentPlayerIndex: 0,
      players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
    });
    renderAsSpectator();

    expect(screen.getByText('game.timeSeconds')).toBeInTheDocument();
  });

  it('omits the countdown when no turn timer is running', () => {
    setStore({
      isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: 'physical',
      turnTimeRemaining: null,
      currentPlayerIndex: 0,
      players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
    });
    renderAsSpectator();

    expect(screen.queryByText('game.timeSeconds')).toBeNull();
  });

  it('leaves the digital-active-player-without-a-snapshot-yet spinner unchanged, before the grace period elapses', () => {
    // The control: an active player on digital (or an unenforced room, where
    // a spectator has no way to know the other player's own preference) still
    // gets the generic spinner while waiting for their first liveTurnState —
    // at least until SPECTATOR_LIVE_STATE_GRACE_MS runs out (see below).
    setStore({
      isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: null,
      currentPlayerIndex: 0,
      players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
    });
    const { container } = renderAsSpectator();

    expect(screen.getByText('game.controls.waiting')).toBeInTheDocument();
    expect(screen.queryByText('game.physicalTurnNotice')).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  // diceMode is per-device and never networked (roomTypes.ts) — in an
  // UNENFORCED room a spectator has no way to know the active player's own
  // device happens to be on physical dice, which pushes no liveTurnState at
  // all. Without a grace period the spinner above spun for that player's
  // entire real-world turn.
  describe('unenforced room, no live state yet', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps showing the spinner until SPECTATOR_LIVE_STATE_GRACE_MS elapses', () => {
      setStore({
        isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: null,
        currentPlayerIndex: 0, round: 1,
        players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
      });
      const { container } = renderAsSpectator();

      act(() => { vi.advanceTimersByTime(SPECTATOR_LIVE_STATE_GRACE_MS - 1); });

      expect(screen.getByText('game.controls.waiting')).toBeInTheDocument();
      expect(screen.queryByText('game.physicalTurnNotice')).toBeNull();
      expect(container.querySelector('.animate-spin')).not.toBeNull();
    });

    // An unenforced room's grace period only means "no live dice snapshot has
    // shown up yet" — that is equally true of a digital player who has not
    // opened the dice panel, so claiming they are "rolling real dice" here
    // would assert something nobody actually knows. A neutral notice replaces
    // it once the grace elapses in an unenforced room; only an ENFORCED
    // physical room (tested below) still earns the specific claim.
    it('shows a neutral turn-in-progress notice (not the physical-dice claim) once the grace period elapses', () => {
      setStore({
        isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: null,
        currentPlayerIndex: 0, round: 1,
        players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
      });
      renderAsSpectator();

      act(() => { vi.advanceTimersByTime(SPECTATOR_LIVE_STATE_GRACE_MS); });

      expect(screen.getByText('game.turnInProgressNotice')).toBeInTheDocument();
      expect(screen.queryByText('game.physicalTurnNotice')).toBeNull();
      expect(screen.queryByText('game.controls.waiting')).toBeNull();
    });

    it('cancels the wait once live turn state arrives, showing the mirrored view instead of either notice', () => {
      setStore({
        isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: null,
        currentPlayerIndex: 0, round: 1,
        players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
      });
      renderAsSpectator();

      act(() => { vi.advanceTimersByTime(SPECTATOR_LIVE_STATE_GRACE_MS - 500); });
      act(() => {
        useGameStore.setState({ liveTurnState: makeDiceSnapshot({ turnScore: 250 }) });
      });
      act(() => { vi.advanceTimersByTime(1000); });

      expect(screen.queryByText('game.physicalTurnNotice')).toBeNull();
      expect(screen.queryByText('game.turnInProgressNotice')).toBeNull();
      expect(screen.getByText('250')).toBeInTheDocument();
    });

    it('restarts the grace period for a new turn instead of inheriting what was left of the previous one', () => {
      setStore({
        isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: null,
        currentPlayerIndex: 0, round: 1,
        players: [
          makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 }),
          makePlayer({ name: 'Carol', socketId: 'socket2', position: 2 }),
        ],
      });
      renderAsSpectator();

      act(() => { vi.advanceTimersByTime(SPECTATOR_LIVE_STATE_GRACE_MS - 500); });
      expect(screen.queryByText('game.turnInProgressNotice')).toBeNull();

      // The turn moves on to a new player before the old grace period ran out.
      act(() => { useGameStore.setState({ currentPlayerIndex: 1 }); });

      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.queryByText('game.turnInProgressNotice'), 'the new turn only just started waiting').toBeNull();

      act(() => { vi.advanceTimersByTime(SPECTATOR_LIVE_STATE_GRACE_MS - 500); });
      expect(screen.getByText('game.turnInProgressNotice')).toBeInTheDocument();
    });
  });

  it('shows the physical-dice notice immediately (no grace period) when the room enforces physical dice', () => {
    vi.useFakeTimers();
    try {
      setStore({
        isOnline: true, isHost: false, liveTurnState: null, enforcedDiceMode: 'physical',
        currentPlayerIndex: 0,
        players: [makePlayer({ name: 'Bob', socketId: 'socket1', position: 1 })],
      });
      renderAsSpectator();

      expect(screen.getByText('game.physicalTurnNotice')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GameControls physical dice interactions', () => {
  const baseProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    isMyTurn: true,
    diceMode: 'physical' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    canUndo: true,
    ...overrides,
  });

  it('quick-add button appends its value to a blank score input', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: '', setScoreInput })} />);

    fireEvent.click(screen.getByText('+100'));

    expect(setScoreInput).toHaveBeenCalledTimes(1);
    const updater = setScoreInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater('')).toBe('100');
  });

  it('keeps a quick-add chip its own size inside a 44px hit area', () => {
    render(<GameControls {...baseProps({ scoreInput: '' })} />);
    const chip = screen.getByText('+100');
    const button = chip.closest('button')!;
    expect(chip.tagName).toBe('SPAN');
    expect(button).toHaveClass('min-h-11');
    expect(button.className).not.toMatch(/border|rounded|shadow/);
    expect(chip.className).toMatch(/rounded-lg/);
    expect(chip.className).toMatch(/border/);
  });

  // U-1 (see LanguageSwitcher.tsx): the button's own focus outline hugged the
  // invisible hit area, not the visible chip. The ring moves to the chip via
  // `group-focus-visible`, and the button hides its own outline.
  it('puts the keyboard focus ring on a quick-add chip, not the hit area', () => {
    render(<GameControls {...baseProps({ scoreInput: '' })} />);
    const chip = screen.getByText('+100');
    const button = chip.closest('button')!;
    expect(button).toHaveClass('group', 'focus-visible:outline-hidden');
    expect(chip).toHaveClass('group-focus-visible:ring-2', 'group-focus-visible:ring-indigo-500');
  });

  it('quick-add button accumulates onto an existing numeric score input', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: '250', setScoreInput })} />);

    fireEvent.click(screen.getByText('+50'));

    const updater = setScoreInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater('250')).toBe('300');
  });

  it('quick-add button treats a non-numeric score input as 0', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: '', setScoreInput })} />);

    // Labelled "+1,000" (en-US grouping — see formatNumber.ts), even though
    // the value it actually adds is the raw 1000.
    fireEvent.click(screen.getByText('+1,000'));

    const updater = setScoreInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater('not-a-number')).toBe('1000');
  });

  // Bug: the score box had a 7-digit length cap (MAX_SCORE_INPUT_LENGTH) but
  // no numeric ceiling, so it happily held 9,999,999 while the server's own
  // MAX_SCORE_MAGNITUDE (1,000,000 — also 7 digits) silently dropped anything
  // past it, desyncing the client and server totals.
  it('declares the shared server maximum on the input element', () => {
    render(<GameControls {...baseProps()} />);
    const input = screen.getByPlaceholderText('game.controls.scorePlaceholder');
    expect(input).toHaveAttribute('max', String(MAX_SCORE_MAGNITUDE));
  });

  it('clamps a typed value above the maximum down to it, live in the box', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: '', setScoreInput })} />);

    const input = screen.getByPlaceholderText('game.controls.scorePlaceholder');
    fireEvent.change(input, { target: { value: '9999999' } });

    expect(setScoreInput).toHaveBeenCalledWith(String(MAX_SCORE_MAGNITUDE));
  });

  it('clamps a quick-add that would push the total past the maximum', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: String(MAX_SCORE_MAGNITUDE - 10), setScoreInput })} />);

    fireEvent.click(screen.getByText('+1,000'));

    const updater = setScoreInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater(String(MAX_SCORE_MAGNITUDE - 10))).toBe(String(MAX_SCORE_MAGNITUDE));
  });
});

// The score box lives outside a <form> (no submit for Enter to trigger), and
// useKeyboardShortcuts deliberately ignores Enter/Space while an INPUT is
// focused (see NATIVE_ACTIVATION_SELECTOR_BY_KEY there) -- so without this
// handler, Enter in the box did nothing.
describe('GameControls score input Enter key', () => {
  const baseProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    isMyTurn: true,
    diceMode: 'physical' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '150',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    canUndo: true,
    ...overrides,
  });

  it('Enter in the score input triggers Next Turn', () => {
    const handleNextTurn = vi.fn();
    render(<GameControls {...baseProps({ handleNextTurn })} />);

    fireEvent.keyDown(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { key: 'Enter' });

    expect(handleNextTurn).toHaveBeenCalledTimes(1);
  });

  it('a non-Enter key in the score input does not trigger Next Turn', () => {
    const handleNextTurn = vi.fn();
    render(<GameControls {...baseProps({ handleNextTurn })} />);

    fireEvent.keyDown(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { key: 'a' });

    expect(handleNextTurn).not.toHaveBeenCalled();
  });

  // Enter is wired through a click() on the actual Next Turn button rather
  // than calling handleNextTurn directly, so a disabled button can never be
  // bypassed from the keyboard -- see the disabled guard by score-input's
  // onKeyDown in GameControls.tsx.
  it('Enter does not trigger Next Turn when its button is disabled', () => {
    const handleNextTurn = vi.fn();
    render(<GameControls {...baseProps({ handleNextTurn })} />);
    const nextTurnButton = screen.getByText('game.controls.nextTurn').closest('button')!;
    nextTurnButton.disabled = true;

    fireEvent.keyDown(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { key: 'Enter' });

    expect(handleNextTurn).not.toHaveBeenCalled();
  });

  // Holding Enter down auto-repeats keydown at the OS repeat rate (every
  // ~30-50ms) while the key stays physically down. Each repeat used to click
  // Next Turn again, re-invoking Game.tsx's commitNextTurn and committing a
  // zero-score "null" turn for every player after the one who was actually
  // rolling — see useKeyboardShortcuts.ts:75, which already guards
  // event.repeat for the window-level shortcuts path.
  it('a held Enter key (OS auto-repeat) triggers Next Turn only once', () => {
    const handleNextTurn = vi.fn();
    render(<GameControls {...baseProps({ handleNextTurn })} />);
    const input = screen.getByPlaceholderText('game.controls.scorePlaceholder');

    fireEvent.keyDown(input, { key: 'Enter', repeat: false });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });

    expect(handleNextTurn).toHaveBeenCalledTimes(1);
  });
});

// UI-7: Game.tsx sets isDrawingNextCard around the drawCardMidTurn round
// trip; this just pins that GameControls actually binds it onto the button
// rather than dropping it.
describe('GameControls draw-next-card busy state', () => {
  const baseProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    isMyTurn: true,
    diceMode: 'physical' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    onDrawNextCard: vi.fn(),
    canUndo: true,
    ...overrides,
  });

  it('leaves the draw button enabled and not busy by default', () => {
    render(<GameControls {...baseProps()} />);
    const drawButton = screen.getByTestId('physical-draw-next-card');
    expect(drawButton).not.toBeDisabled();
    expect(drawButton).toHaveAttribute('aria-busy', 'false');
  });

  it('disables the draw button and marks it aria-busy when isDrawingNextCard is true', () => {
    render(<GameControls {...baseProps({ isDrawingNextCard: true })} />);
    const drawButton = screen.getByTestId('physical-draw-next-card');
    expect(drawButton).toBeDisabled();
    expect(drawButton).toHaveAttribute('aria-busy', 'true');
  });
});

describe('GameControls end/leave game confirmation dialogs', () => {
  const baseProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    isMyTurn: true,
    diceMode: 'physical' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    canUndo: true,
    ...overrides,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offline: shows End Game, and only calls the store\'s endGame once the confirm dialog is accepted', async () => {
    const endGame = vi.fn();
    setStore({ isOnline: false, isHost: true, endGame });
    render(<GameControls {...baseProps()} />);

    expect(screen.queryByText('game.controls.leaveGame')).toBeNull();
    fireEvent.click(screen.getByText('game.controls.endGame'));
    expect(screen.getByText('game.controls.endGameConfirm')).toBeInTheDocument();
    expect(endGame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(endGame).not.toHaveBeenCalled();
    expect(screen.queryByText('game.controls.endGameConfirm')).toBeNull();

    fireEvent.click(screen.getByText('game.controls.endGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(endGame).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('game.controls.endGameConfirm')).toBeNull();
  });

  it('online + host: still shows End Game (not Leave Game)', () => {
    const endGame = vi.fn();
    setStore({ isOnline: true, isHost: true, endGame });
    render(<GameControls {...baseProps()} />);

    fireEvent.click(screen.getByText('game.controls.endGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(endGame).toHaveBeenCalledTimes(1);
  });

  it('online + non-host: shows Leave Game, and only calls the store\'s leaveRoom once the confirm dialog is accepted', () => {
    const leaveRoom = vi.fn();
    setStore({ isOnline: true, isHost: false, leaveRoom });
    render(<GameControls {...baseProps()} />);

    expect(screen.queryByText('game.controls.endGame')).toBeNull();
    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    expect(screen.getByText('game.controls.leaveGameConfirm')).toBeInTheDocument();
    expect(leaveRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(leaveRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(leaveRoom).toHaveBeenCalledTimes(1);
  });

  it('undo: only calls the store\'s undo once the confirm dialog is accepted', () => {
    const undo = vi.fn();
    setStore({ undo });
    render(<GameControls {...baseProps()} />);

    fireEvent.click(screen.getByText('game.controls.undo'));
    expect(screen.getByText('game.controls.undoConfirm')).toBeInTheDocument();
    expect(undo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(undo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('game.controls.undo'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('undo: refuses once the turn it was opened for is no longer the last one', async () => {
    // pendingAction is plain state and nothing re-read the turn behind it, so
    // the dialog acted on whatever the previous-turn fields held at CONFIRM
    // time. A host opens Undo for Bob's turn; before answering, Carol's turn
    // resolves (or the server timer advances it) and the previous-turn fields
    // are rewritten by the broadcast; Confirm then rewound CAROL's turn — and
    // pushState propagated it to the whole room.
    const undo = vi.fn();
    setStore({ undo });
    const { rerender } = render(<GameControls {...baseProps({ undoTurnId: 'Bob:200:4' })} />);

    fireEvent.click(screen.getByText('game.controls.undo'));
    expect(screen.getByText('game.controls.undoConfirm')).toBeInTheDocument();

    // The turn moves on underneath the open dialog.
    rerender(<GameControls {...baseProps({ undoTurnId: 'Carol:Kniffel:4' })} />);

    expect(
      screen.queryByText('game.controls.undoConfirm'),
      'the dialog must not keep asking about a turn that is gone',
    ).not.toBeInTheDocument();
    expect(undo, 'a different turn must never be undone in its place').not.toHaveBeenCalled();
  });

  it('undo: still undoes the turn it was opened for', () => {
    // The control: the guard above must not simply stop undo working.
    const undo = vi.fn();
    setStore({ undo });
    const { rerender } = render(<GameControls {...baseProps({ undoTurnId: 'Bob:200:4' })} />);

    fireEvent.click(screen.getByText('game.controls.undo'));
    // An unrelated re-render — a score tick, another player's colour change —
    // leaves the turn identity alone and must not cancel anything.
    rerender(<GameControls {...baseProps({ undoTurnId: 'Bob:200:4' })} />);
    fireEvent.click(screen.getByText('common.confirm'));

    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('undo: is disabled when canUndo is false', () => {
    render(<GameControls {...baseProps({ canUndo: false })} />);
    const undoBtn = screen.getByText('game.controls.undo').closest('button');
    expect(undoBtn).toBeDisabled();
  });

  it('reads undo/endGame/leaveRoom from the store rather than from props', () => {
    // GameControlsProps carries none of these three any more -- every call
    // above already exercises this, but this test pins it explicitly: a spy
    // installed straight on the store (no prop of the same name exists to
    // shadow it) is still the function every button below invokes.
    const undo = vi.fn();
    const endGame = vi.fn();
    const leaveRoom = vi.fn();
    setStore({ undo, endGame, leaveRoom, isOnline: false, isHost: true });
    const { unmount } = render(<GameControls {...baseProps()} />);

    fireEvent.click(screen.getByText('game.controls.endGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(endGame).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('game.controls.undo'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(leaveRoom).not.toHaveBeenCalled();
    unmount();

    setStore({ undo, endGame, leaveRoom, isOnline: true, isHost: false });
    render(<GameControls {...baseProps()} />);
    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(leaveRoom).toHaveBeenCalledTimes(1);
  });
});

describe('GameControls Stop card while the dice panel is open', () => {
  const stopProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    isMyTurn: true,
    diceMode: 'digital' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    canUndo: true,
    ...overrides,
  });

  beforeEach(() => {
    setStore({ currentCard: 'Stop' });
  });

  it('shows Continue and commits the turn while the dice panel is closed', () => {
    const handleYesNo = vi.fn();
    render(<GameControls {...stopProps({ showDiceGame: false, handleYesNo })} />);

    expect(screen.getByText('game.controls.stopTurnOver')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /game.controls.continue/i }));
    expect(handleYesNo).toHaveBeenCalledWith(false);
  });

  it('does not render the Continue button behind an open dice panel', () => {
    // A classic chain that draws a Stop inside DiceGame leaves the panel up
    // showing the forfeit summary, which DiceGame commits itself. These
    // controls stay mounted behind it (no focus trap), so a live Continue
    // here is reachable and would commit the turn a second time — without
    // the chain summary.
    // Nothing to click here on purpose: with the block unrendered there IS no
    // interaction that could reach handleYesNo, which is the whole point — the
    // test above pins that the same Continue commits the turn when it is up.
    render(<GameControls {...stopProps({ showDiceGame: true })} />);

    expect(screen.queryByRole('button', { name: /game.controls.continue/i })).toBeNull();
    expect(screen.queryByText('game.controls.stopTurnOver')).toBeNull();
  });

  it('treats an omitted showDiceGame as "panel closed"', () => {
    render(<GameControls {...stopProps()} />);
    expect(screen.getByRole('button', { name: /game.controls.continue/i })).toBeInTheDocument();
  });

  it('leaves the other branches alone while the dice panel is open', () => {
    // Only the stop-controls block is guarded: a non-Stop card behind the
    // panel keeps rendering exactly as before (the panel closes with the
    // turn, and these controls are what the player returns to).
    setStore({ currentCard: '200' });
    render(<GameControls {...stopProps({ showDiceGame: true })} />);

    expect(screen.getByText('game.controls.rollDice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /game.controls.continue/i })).toBeNull();
  });

  it('still shows the spectator view for a Stop card on someone else\'s turn', () => {
    render(<GameControls {...stopProps({ isMyTurn: false, showDiceGame: false })} />);
    expect(screen.getByText('game.controls.waiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /game.controls.continue/i })).toBeNull();
  });
});
