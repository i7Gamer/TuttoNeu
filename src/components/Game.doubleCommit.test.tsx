/**
 * D-15 (review_round13.md, Slice D): a stale commit closure ends the NEXT
 * player's turn too.
 *
 * Deliberately does NOT mock framer-motion's AnimatePresence as a
 * pass-through the way Game.test.tsx does. That mock removes an exiting
 * node from the DOM the instant its condition flips, which is exactly what
 * hides this bug: GameControls' whole "input-controls" panel (Yes/No,
 * Next Turn, the score box) is wrapped in a real AnimatePresence and only
 * renders while `!isFlipping` — the moment a commit changes `currentCard`,
 * GameControls flips `isFlipping` true and that panel starts an EXIT
 * animation. With a real AnimatePresence and no timers advanced between two
 * synchronous clicks, the exiting node — and its onClick closure, bound to
 * the turn it was rendered for — is still in the DOM for a second click to
 * land on.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Game from './Game';
import { useGameStore, _resetTimersForTests } from '../store/useGameStore';
import { makePlayer } from '../testing/factories';
import { CARD_FLIP_MS } from '../utils/uiTimings';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  vibrateYourTurn: vi.fn(),
  vibrateTurnUrgent: vi.fn(),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('./DiceGame', () => ({
  default: () => <div data-testid="mock-dice-game">Dice Game</div>,
}));

describe('Game double-commit (D-15)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.getState().reset();
    _resetTimersForTests();
    localStorage.clear();
    sessionStorage.clear();
    // A real local two-player game: isOnline false so isMyTurn is always
    // true regardless of whose seat it is, and nextTurn/undo run for real —
    // this is what lets historyLog/currentPlayerIndex prove the bug (a
    // mocked nextTurn, as Game.test.tsx uses, would never move either).
    useGameStore.setState({
      mode: 'local',
      isOnline: false,
      enforcedDiceMode: null,
      diceMode: 'physical',
      ruleset: 'modernized',
      round: 1,
      currentPlayerIndex: 0,
      winningScore: 6000,
      myName: 'Alice',
      historyLog: [],
      players: [
        makePlayer({ name: 'Alice', position: 1 }),
        makePlayer({ name: 'Bob', position: 2 }),
      ],
    });
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('a double click on the same "No" element commits only one turn', () => {
    useGameStore.setState({ currentCard: 'Kleeblatt' });
    render(<Game />);

    const noButton = screen.getByRole('button', { name: /game.controls.no/i });
    fireEvent.click(noButton);
    fireEvent.click(noButton);

    expect(useGameStore.getState().historyLog.length).toBe(1);
    expect(useGameStore.getState().currentPlayerIndex).toBe(1);
  });

  it('double-clicking "Next Turn" with a score typed banks it only once', () => {
    useGameStore.setState({ currentCard: '300' });
    render(<Game />);

    fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '500' } });
    const nextTurnButton = screen.getByText('game.controls.nextTurn');
    fireEvent.click(nextTurnButton);
    fireEvent.click(nextTurnButton);

    const state = useGameStore.getState();
    expect(state.historyLog.length).toBe(1);
    expect(state.historyLog[0].score).toBe(500);
    expect(state.players.find(p => p.name === 'Alice')?.score).toBe(500);
  });

  it('commit, undo, commit again still lands the second commit', () => {
    useGameStore.setState({ currentCard: 'Kleeblatt' });
    render(<Game />);

    fireEvent.click(screen.getByRole('button', { name: /game.controls.no/i }));
    act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });
    expect(useGameStore.getState().historyLog.length).toBe(1);

    act(() => { useGameStore.getState().undo(); });
    act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });
    expect(useGameStore.getState().historyLog.length).toBe(0);
    expect(useGameStore.getState().currentPlayerIndex).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /game.controls.no/i }));

    expect(useGameStore.getState().historyLog.length).toBe(1);
    expect(useGameStore.getState().currentPlayerIndex).toBe(1);
  });
});
