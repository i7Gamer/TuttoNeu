import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { parseSavedDiceState } from '../utils/diceTurnState';
import { MAX_CHAIN_CARDS } from '../types';
import DiceGame from './DiceGame';
import { playTone, playSuccess } from '../utils/soundEffects';
import confetti from 'canvas-confetti';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  playTone: vi.fn(),
  vibrateBust: vi.fn(),
  vibrateSuccess: vi.fn(),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

// Deterministic dice: rollDie() drains this queue and falls back to the real
// implementation when empty (so tests that don't care keep working).
const { rollQueue } = vi.hoisted(() => ({ rollQueue: [] as number[] }));

vi.mock('../utils/diceLogic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/diceLogic')>();
  return {
    ...actual,
    rollDie: () => (rollQueue.length > 0 ? rollQueue.shift()! : actual.rollDie()),
  };
});

// Each roll consumes 2N rollDie() calls: N for the real values and N for the
// initial display values (which the test-env path immediately overwrites), so
// the values are pushed twice.
const queueRoll = (vals: number[]) => { rollQueue.push(...vals, ...vals); };

// Every test starts from a drained queue: one that queues more values than its
// rolls consume would otherwise feed the leftovers to whichever test happens
// to run next — invisible in declaration order, real under --sequence.shuffle.
beforeEach(() => {
  rollQueue.length = 0;
});

// The die's accessible name is `${t('dice.die_showing')} ${val}` — under the
// test i18n mock, `dice.die_showing ${val}` — and its selection state lives in
// aria-pressed, not in the label. These two find dice the way the old
// "Die showing X, (not) selected" labels did: by value AND state, with
// dieShowing keeping getBy* semantics (throws unless exactly one match).
const diceShowing = (val: number, selected: boolean): HTMLElement[] =>
  screen.getAllByLabelText(`dice.die_showing ${val}`)
    .filter(el => el.getAttribute('aria-pressed') === String(selected));
const dieShowing = (val: number, selected: boolean): HTMLElement => {
  const matches = diceShowing(val, selected);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one die showing ${val} with selected=${selected}, found ${matches.length}`);
  }
  return matches[0];
};
const selectedDice = (): HTMLElement[] =>
  screen.queryAllByLabelText(/dice.die_showing/).filter(el => el.getAttribute('aria-pressed') === 'true');

// DiceGame no longer has a test-env fast path: roll() always schedules its
// animation/finalize timers for real. Most tests here don't care how long
// that takes, so this mock defaults every one of those durations to 0 —
// same net effect the old isTestEnv() collapse had — while a handful of
// describes below (the ones actually testing the timed behavior) restore the
// real values via `realTiming`.
const { timing, realTiming, ZERO_TIMING } = vi.hoisted(() => {
  const zero = { DIE_TUMBLE_MS: 0, DIE_STAGGER_MS: 0, ROLL_SETTLE_BUFFER_MS: 0, BUST_SUMMARY_DELAY_MS: 0, AUTO_CONTINUE_SECONDS: 0 };
  return {
    timing: { ...zero },
    realTiming: {} as Record<'DIE_TUMBLE_MS' | 'DIE_STAGGER_MS' | 'ROLL_SETTLE_BUFFER_MS' | 'BUST_SUMMARY_DELAY_MS' | 'AUTO_CONTINUE_SECONDS', number>,
    ZERO_TIMING: zero,
  };
});

vi.mock('../utils/uiTimings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/uiTimings')>();
  Object.assign(realTiming, {
    DIE_TUMBLE_MS: actual.DIE_TUMBLE_MS,
    DIE_STAGGER_MS: actual.DIE_STAGGER_MS,
    ROLL_SETTLE_BUFFER_MS: actual.ROLL_SETTLE_BUFFER_MS,
    BUST_SUMMARY_DELAY_MS: actual.BUST_SUMMARY_DELAY_MS,
    AUTO_CONTINUE_SECONDS: actual.AUTO_CONTINUE_SECONDS,
  });
  return {
    ...actual,
    get DIE_TUMBLE_MS() { return timing.DIE_TUMBLE_MS; },
    get DIE_STAGGER_MS() { return timing.DIE_STAGGER_MS; },
    get ROLL_SETTLE_BUFFER_MS() { return timing.ROLL_SETTLE_BUFFER_MS; },
    get BUST_SUMMARY_DELAY_MS() { return timing.BUST_SUMMARY_DELAY_MS; },
    get AUTO_CONTINUE_SECONDS() { return timing.AUTO_CONTINUE_SECONDS; },
  };
});

// Most describes below run on ambient REAL timers (never fake), so a debounce
// like LIVE_SNAPSHOT_DEBOUNCE_MS can still be awaited for real further down in
// the same test. With every duration above mocked to 0, roll()'s
// setTimeout(fn, 0) calls fire on the very next real macrotask instead of
// after a genuine delay — flushRoll drains those. finalizeRoll's own
// zero-delay timer is registered alongside the six die-settle ones, so one
// flush drains all seven; a bust then schedules ANOTHER zero-delay timer for
// its summary from inside that first callback, one macrotask later — hence
// two flushes, not one.
const flushRoll = async () => {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
};

// A handful of describes below use FAKE timers instead (they need to control
// a later, unrelated deadline deterministically). For those, the same
// zero-mocked roll settles on a small fake-timer advance rather than a real
// macrotask flush — see the cascading-timer note on FAKE_FLUSH_MS's usage.
/**
 * Ask for the next chain card, and let the request settle before reading the DOM.
 *
 * The draw stopped being a local shift off the client's own deck: online the
 * card is dealt by the SERVER, because a client holding the undrawn deck knows
 * the answer to the very question a classic turn asks ("bank, or reveal the
 * next card and risk everything"). onDrawCard therefore hands back a promise,
 * and the reveal, the chain entry and the deferred roll all land a microtask
 * after the click rather than inside it — so every test that presses Draw has
 * to yield here first.
 */
const settleDraw = () => act(async () => { await Promise.resolve(); });
const clickDraw = async () => {
  fireEvent.click(screen.getByTestId('draw-next-card'));
  await settleDraw();
};
const pressDrawKey = async () => {
  fireEvent.keyDown(window, { key: 'd' });
  await settleDraw();
};

const FAKE_FLUSH_MS = 5;
const flushRollFake = () => act(() => { vi.advanceTimersByTime(FAKE_FLUSH_MS); });

describe('DiceGame panel surface', () => {
  // The dark-theme panel was 95% opaque, so the game screen and the dimmed
  // backdrop showed through it while the dice tumbled. Both themes are solid.
  it('is fully opaque in both themes', () => {
    const { container } = render(<DiceGame currentCard="300" onComplete={vi.fn()} />);
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toMatch(/\bbg-white\b/);
    expect(panel.className).toMatch(/\bdark:bg-slate-800\b/);
    expect(panel.className).not.toMatch(/bg-slate-800\/\d+/);
  });
});

describe('DiceGame State Restoration Logic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('parses and restores turnScore from localStorage', () => {
    const savedState = { turnScore: 250, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.turnScore).toBe(250);
  });

  it('preserves kniffelProgress array structure when restoring', () => {
    const savedState = {
      turnScore: 100,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [1, 2, 3],
      tuttosThisTurn: 0
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(Array.isArray(restored?.kniffelProgress)).toBe(true);
    expect(restored?.kniffelProgress).toEqual([1, 2, 3]);
  });

  it('correctly converts undefined busted to false', () => {
    const savedState = {
      turnScore: 100,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.busted).toBe(false);
  });

  it('preserves busted=true when present', () => {
    const savedState = {
      turnScore: 0,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0,
      busted: true
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.busted).toBe(true);
  });

  it('returns null when localStorage has no saved state', () => {
    localStorage.removeItem('tutto_dice_turn_state');

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored).toBeNull();
  });

  it('returns null when saved state is invalid JSON', () => {
    localStorage.setItem('tutto_dice_turn_state', 'not valid json {]');

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored).toBeNull();
  });

  it('provides defaults for missing optional fields', () => {
    const minimalState = { turnScore: 50 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(minimalState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.keptDice).toEqual([]);
    expect(restored?.kniffelProgress).toEqual([]);
    expect(restored?.tuttosThisTurn).toBe(0);
  });

  it('keeps the stopped marker through a parse round-trip', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 450, stopped: true }));
    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));
    expect(restored?.stopped).toBe(true);
  });

  it('drops malformed or oversized chain fields instead of restoring them', () => {
    // The server accepts only bounded shapes for these (isChainCounter /
    // isChainScoreList) — the local cache parse mirrors that, so a corrupted
    // entry resets to absent rather than riding into a snapshot.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 100, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
      cardsThisTurn: ['300'], plusMinusScores: [1800, -1], chainTuttoCount: 101,
    }));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.cardsThisTurn).toEqual(['300']);
    expect(restored?.plusMinusScores).toBeUndefined();
    expect(restored?.chainTuttoCount).toBeUndefined();
  });

  it('restores a chain\'s Plus/Minus running totals', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 2800, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
      cardsThisTurn: ['300', 'Plus_Minus'], plusMinusScores: [1800], chainTuttoCount: 2,
    }));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.plusMinusScores).toEqual([1800]);
  });
});

describe('DiceGame restored-state bust rendering', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows the same "Bust!" summary for a restored Kleeblatt bust as a live one', () => {
    // Simulates a page reload/reconnect mid-Kleeblatt-turn right after busting.
    // Kleeblatt is all-or-nothing (needs 2 successful tuttos), so a bust always
    // forfeits the turn regardless of tuttosThisTurn banked so far — the restored
    // path (DiceGame.tsx initial state) and the live bust path both produce
    // { won: false, score: 0 }, so the rendered summary must match exactly.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 0,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 1,
      busted: true,
    }));

    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    expect(screen.queryByText('dice.success')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.tutto')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.points_gained')).not.toBeInTheDocument();
  });

  it('restores a Stop & Score decision into its banked summary, not a rollable table', () => {
    // Without the stopped marker this restored into the pre-stop dice table:
    // the player who had already seen "Success!" could reload inside the
    // 3-second countdown and pick Roll Again instead — a decision rollback.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 450,
      keptDice: [{ id: 'k1', val: 1 }, { id: 'k2', val: 5 }],
      currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
      stopped: true,
    }));

    render(<DiceGame currentCard="300" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    expect(screen.getByText('450')).toBeInTheDocument();
    expect(screen.queryByText('dice.roll_again')).not.toBeInTheDocument();
  });

  it('re-commits the stopped marker of a restored banked decision into the live snapshot', async () => {
    // A reload-of-a-reload: the summary rendering alone comes from the cached
    // summary, but the SECOND reload restores from the snapshot this mount
    // emits — if the restored stopped marker does not ride out again, that
    // reload lands on a rollable table and the decision rollback returns.
    const onStateChange = vi.fn();
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 450,
      keptDice: [{ id: 'k1', val: 1 }, { id: 'k2', val: 5 }],
      currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
      stopped: true,
    }));

    render(<DiceGame currentCard="300" onComplete={vi.fn()} onStateChange={onStateChange} />);

    await waitFor(() => {
      const last = onStateChange.mock.calls.at(-1)?.[0];
      expect(last?.stopped).toBe(true);
      expect(last?.turnScore).toBe(450);
      expect(last?.currentRoll).toEqual([]);
      // 5s, not waitFor's 1s default: the snapshot only exists after a REAL
      // 300ms debounce (LIVE_SNAPSHOT_DEBOUNCE_MS), so the default left
      // ~700ms of slack that a loaded CI worker can eat.
    }, { timeout: 5000 });
  });

  it('restores a reload during a modernized tutto summary into that summary, not a rollable table', () => {
    // Without committing the tutto (all six put aside, stopped marker) the
    // snapshot still held the pre-tutto table: a reload inside the 3-second
    // countdown restored a rollable table where the player could deselect a
    // die and keep rolling past the tutto — which modernized forbids.
    const kept = [1, 1, 1, 5, 5, 5].map((v, i) => ({ id: `d${i}`, val: v }));
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 1800, keptDice: kept, currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 0, stopped: true, turnKey: 'K',
    }));

    render(<DiceGame currentCard="300" turnKey="K" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    // All six dice put aside IS the tutto — the restored summary keeps saying so.
    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    // DiceSummary's points line — grouped (en-US default in tests, see
    // formatNumber.ts), unlike TurnScoreHeader's raw '1800' elsewhere in this file.
    expect(screen.getByText('1,800')).toBeInTheDocument();
    expect(screen.queryByText('dice.roll_again')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.stop_and_score')).not.toBeInTheDocument();
  });

  it('restores a reload during a Kleeblatt win summary into the win, not a rollable table', async () => {
    // The second tutto had already been rolled and the win summary was on
    // screen — restoring into a dice table would let the player reroll (and
    // potentially bust away) a game they had already won.
    const onComplete = vi.fn();
    const kept = [1, 1, 1, 5, 5, 5].map((v, i) => ({ id: `d${i}`, val: v }));
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 3000, keptDice: kept, currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 1, stopped: true, turnKey: 'K',
    }));

    render(<DiceGame currentCard="Kleeblatt" turnKey="K" onComplete={onComplete} />);

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    expect(screen.queryByText('dice.roll_again')).not.toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(3000, true));
  });

  // A snapshot cached while the dice were still tumbling carries no verdict:
  // the live snapshot is debounced from the moment the roll starts, while the
  // `busted` flag is only written once finalizeRoll has run (every die
  // settled, plus the settle buffer). Restoring such an entry as a settled
  // board left a busting roll unjudged — hasRolled, no bust, no auto-roll, and
  // isBust only ever runs inside roll() — so nothing on the device could end
  // the turn, and this panel cannot be dismissed.
  const midTumbleSnapshot = (vals: number[], extra: Record<string, unknown> = {}) => ({
    turnScore: 0,
    keptDice: [],
    currentRoll: vals.map((val, i) => ({ id: `d${i}`, val, selected: false })),
    kniffelProgress: [],
    tuttosThisTurn: 0,
    rollingDiceIds: vals.map((_, i) => `d${i}`),
    turnKey: 'K',
    ...extra,
  });

  it('restores a mid-tumble snapshot of a busting roll into the bust, not an unresolved table', async () => {
    const onComplete = vi.fn();
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(midTumbleSnapshot([2, 2, 3, 3, 4, 6])));

    render(<DiceGame currentCard="300" turnKey="K" onComplete={onComplete} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    expect(screen.queryByText('dice.roll_again')).not.toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false));
  });

  it('banks a mid-tumble Feuerwerk null that had points on it, like the live null does', async () => {
    // A Feuerwerk null BANKS everything accumulated — the re-derived verdict
    // has to reach the same summary the live path would have.
    const onComplete = vi.fn();
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(
      midTumbleSnapshot([2, 2, 3, 3, 4, 6], { turnScore: 1500 }),
    ));

    render(<DiceGame currentCard="Feuerwerk" turnKey="K" onComplete={onComplete} />);

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1500, true));
  });

  it('resumes a mid-tumble snapshot of a scoring roll as a playable table', () => {
    const onComplete = vi.fn();
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(midTumbleSnapshot([1, 5, 2, 3, 4, 6])));

    render(<DiceGame currentCard="300" turnKey="K" onComplete={onComplete} />);

    expect(screen.queryByText('dice.bust')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText(/dice.die_showing/).length).toBe(6);

    fireEvent.click(dieShowing(1, false));
    expect(screen.getByText('dice.stop_and_score').closest('button')).not.toBeDisabled();
  });

  it('re-applies classic Feuerwerk\'s forced keep when resuming a mid-tumble scoring roll', () => {
    // The forced selection is made in finalizeRoll, which never ran for this
    // snapshot — and toggleDie is a no-op for classic Feuerwerk, so a restore
    // with nothing selected has no button that could act either.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(midTumbleSnapshot([1, 5, 2, 3, 4, 6])));

    render(<DiceGame currentCard="Feuerwerk" turnKey="K" ruleset="classic" onComplete={vi.fn()} />);

    expect(dieShowing(1, true)).toBeInTheDocument();
    expect(dieShowing(5, true)).toBeInTheDocument();
    expect(dieShowing(2, false)).toBeInTheDocument();
    expect(screen.getByText('dice.roll_again').closest('button')).not.toBeDisabled();
    // And the re-applied keep is as uneditable as a live one: the dice must not
    // invite clicks that toggleDie is going to drop.
    screen.getAllByLabelText(/dice.die_showing/).forEach(die => expect(die).toBeDisabled());
  });

  it('still trusts a settled snapshot: no rollingDiceIds means the roll was already judged', () => {
    // The same busting dice, cached AFTER they settled and were rejudged as a
    // scoring board (the player had put the scoring dice aside) — nothing to
    // re-derive, so this must still resume as a table.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 100,
      keptDice: [{ id: 'k1', val: 1 }],
      currentRoll: [{ id: 'r1', val: 2, selected: false }, { id: 'r2', val: 3, selected: false }],
      kniffelProgress: [], tuttosThisTurn: 0, turnKey: 'K',
    }));

    render(<DiceGame currentCard="300" turnKey="K" onComplete={vi.fn()} />);

    expect(screen.queryByText('dice.bust')).not.toBeInTheDocument();
    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('100');
  });

  it('paints a resumed turn on its first commit rather than correcting itself', () => {
    // Restoration used to be an effect calling eight setters, so resuming a
    // turn meant mounting an empty table, painting it, and only then filling
    // in the game the player was actually in the middle of. panelReady stays
    // false here so the auto-roll cannot account for any commit.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 250,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0,
      busted: false,
    }));

    let commits = 0;
    render(
      <Profiler id="dice" onRender={() => { commits += 1; }}>
        <DiceGame currentCard="x2" onComplete={vi.fn()} panelReady={false} />
      </Profiler>
    );

    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('250');
    expect(commits).toBe(1);
  });
});

describe('DiceGame stale turn restoration (turnKey)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // A player's turn ended (e.g. the server's turn timer advanced past them while
  // disconnected) without their own client ever running the code that clears this
  // cache entry — so it survives, stamped for a turn that is no longer current.
  const staleSnapshot = {
    turnScore: 0,
    keptDice: [],
    currentRoll: [],
    kniffelProgress: [],
    tuttosThisTurn: 1,
    busted: true,
    turnKey: 'ROOM1:2:0:Kleeblatt',
  };

  it('restores the snapshot when turnKey matches the current turn', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(staleSnapshot));

    render(<DiceGame currentCard="Kleeblatt" turnKey="ROOM1:2:0:Kleeblatt" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
  });

  it('discards a snapshot stamped for a different turn instead of resuming it', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(staleSnapshot));
    queueRoll([1, 2, 3, 4, 6, 6]); // includes a 1 so the fresh auto-roll can't bust

    // Same player and card, but the round has advanced — a later turn, not a
    // resumable one.
    render(<DiceGame currentCard="Kleeblatt" turnKey="ROOM1:3:0:Kleeblatt" onComplete={vi.fn()} />);

    // A fresh turn auto-rolls immediately, not the stale bust summary.
    expect(screen.getAllByLabelText(/dice.die_showing/).length).toBe(6);
    expect(screen.queryByText('dice.bust')).not.toBeInTheDocument();
    // Cleared, not just ignored, so it can't resurface on a later mount either.
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
  });

  it('restores unconditionally when the caller does not pass turnKey (backward compatible)', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(staleSnapshot));

    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
  });
});

describe('DiceGame interactive turn logic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  const selectAllValid = () => fireEvent.click(screen.getByText('dice.select_all_valid'));
  const clickDie = (val: number) => {
    const dice = diceShowing(val, false);
    fireEvent.click(dice[0]);
  };

  it('scores the selected dice and completes the turn on Stop & Score', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 5, 2, 2, 3, 4]);
    render(<DiceGame currentCard="200" onComplete={onComplete} />);
    await flushRoll();

    clickDie(1);
    clickDie(5);
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    // 100 (single 1) + 50 (single 5); auto-continue fires onComplete in test env
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(150, true));
  });

  it('renders kept dice as pip faces, not raw digits, matching the current-roll dice style', async () => {
    queueRoll([1, 5, 2, 2, 3, 4]); // first (auto) roll
    queueRoll([5, 2, 3, 4, 6]); // reroll of the 5 dice not kept — includes a 5 so it isn't a bust
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
    await flushRoll();

    clickDie(1);
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    const keptDiceBox = screen.getByText('dice.kept_dice').nextElementSibling as HTMLElement;
    // A pip face is a 3x3 grid of dot divs (see DiePips), not the bare "1".
    expect(keptDiceBox.querySelector('.grid-cols-3')).not.toBeNull();
    expect(keptDiceBox).not.toHaveTextContent('1');
  });

  it('marks a non-scoring selection invalid and disables both action buttons', async () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
    await flushRoll();

    clickDie(2); // a lone 2 can never score

    expect(screen.getByText('dice.invalid_selection')).toBeInTheDocument();
    expect(screen.getByText('dice.roll_again').closest('button')).toBeDisabled();
    // Stop & Score stays mounted (disabled), not removed — removing it used
    // to resize the sibling Roll Again button, producing a visible layout jump.
    expect(screen.getByText('dice.stop_and_score').closest('button')).toBeDisabled();
  });

  it('keeps Stop & Score mounted in place when selection validity toggles, instead of unmounting it', async () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
    await flushRoll();

    clickDie(1); // a lone 1 scores: valid
    const stopButtonWhenValid = screen.getByText('dice.stop_and_score').closest('button');
    expect(stopButtonWhenValid).not.toBeDisabled();

    clickDie(2); // 1+2 together don't score: invalid
    const stopButtonWhenInvalid = screen.getByText('dice.stop_and_score').closest('button');

    // Same DOM node across the toggle proves it was disabled in place rather
    // than unmounted and re-mounted (which would resize the button row).
    expect(stopButtonWhenInvalid).toBe(stopButtonWhenValid);
    expect(stopButtonWhenInvalid).toBeDisabled();
  });

  it('keeps the invalid-selection indicator mounted and only toggles its visibility', async () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
    await flushRoll();

    clickDie(1); // valid: indicator hidden
    const indicatorWhenValid = screen.getByText('dice.invalid_selection');
    expect(indicatorWhenValid.className).toMatch(/invisible/);

    clickDie(2); // invalid: indicator visible
    const indicatorWhenInvalid = screen.getByText('dice.invalid_selection');
    expect(indicatorWhenInvalid.className).not.toMatch(/invisible/);

    // Same node — no pop-in remount.
    expect(indicatorWhenInvalid).toBe(indicatorWhenValid);
  });

  it('does not remount the score display when only selection validity changes', async () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
    await flushRoll();

    clickDie(1); // valid
    const scoreNodeWhenValid = screen.getByTestId('dice-current-score');

    clickDie(2); // invalid
    const scoreNodeWhenInvalid = screen.getByTestId('dice-current-score');

    expect(scoreNodeWhenInvalid).toBe(scoreNodeWhenValid);
  });

  // The turn loop is select → roll or stop, over and over. Game.tsx already
  // binds Space/Enter to open this panel; inside it every repetition was a
  // mouse trip to a button.
  describe('keyboard shortcuts', () => {
    const pressKey = (key: string) => fireEvent.keyDown(window, { key });

    it('still fires while rendered inside an aria-modal panel', async () => {
      // Game renders this panel inside a ModalShell, so an aria-modal element
      // is always present around it while a turn is being rolled — the
      // shortcut hook blocks on modals it is NOT inside of, not on all of them.
      queueRoll([1, 5, 2, 2, 3, 4]);
      const { container } = render(
        <div role="dialog" aria-modal="true">
          <DiceGame currentCard="200" onComplete={vi.fn()} />
        </div>
      );
      await flushRoll();
      expect(container.querySelector('[aria-modal="true"]')).not.toBeNull();

      pressKey('a');

      // 'a' selected every scoring die: the 1 and the 5.
      expect(selectedDice()).toHaveLength(2);
    });

    it('goes quiet while a second modal is open over the panel', async () => {
      queueRoll([1, 5, 2, 2, 3, 4]);
      render(
        <>
          <div role="dialog" aria-modal="true">
            <DiceGame currentCard="200" onComplete={vi.fn()} />
          </div>
          <div role="dialog" aria-modal="true" data-testid="confirm-on-top" />
        </>
      );
      await flushRoll();

      pressKey('a');

      expect(selectedDice()).toHaveLength(0);
    });

    it('scores the selected dice on S, the same as Stop & Score', async () => {
      const onComplete = vi.fn();
      queueRoll([1, 5, 2, 2, 3, 4]);
      render(<DiceGame currentCard="200" onComplete={onComplete} />);
      await flushRoll();

      clickDie(1);
      clickDie(5);
      pressKey('s');

      expect(screen.getByText('dice.success')).toBeInTheDocument();
      await waitFor(() => expect(onComplete).toHaveBeenCalledWith(150, true));
    });

    it('banks the selection and rerolls on R, the same as Roll Again', async () => {
      queueRoll([1, 5, 2, 2, 3, 4]);
      queueRoll([5, 2, 3, 4, 6]); // includes a 5, so the reroll is not a bust
      render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
      await flushRoll();

      clickDie(1);
      pressKey('r');
      await flushRoll();

      const keptDiceBox = screen.getByText('dice.kept_dice').nextElementSibling as HTMLElement;
      expect(keptDiceBox.querySelector('.grid-cols-3')).not.toBeNull();
    });

    it('selects every valid die on A', async () => {
      queueRoll([1, 5, 2, 2, 3, 4]);
      render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
      await flushRoll();

      pressKey('a');

      // The 1 and the 5 are the whole valid selection: 100 + 50.
      expect(screen.getByTestId('dice-current-score')).toHaveTextContent('150');
    });

    it('ignores R and S while the selection is invalid, matching the disabled buttons', async () => {
      const onComplete = vi.fn();
      queueRoll([1, 2, 3, 4, 6, 6]);
      render(<DiceGame currentCard="200" onComplete={onComplete} />);
      await flushRoll();

      clickDie(2); // a lone 2 can never score
      pressKey('r');
      pressKey('s');

      expect(screen.getByText('dice.invalid_selection')).toBeInTheDocument();
      expect(screen.queryByText('dice.success')).not.toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('ignores shortcuts once the turn has busted', async () => {
      const onComplete = vi.fn();
      queueRoll([2, 2, 3, 4, 6, 6]); // no 1, no 5, no triple: an immediate bust
      render(<DiceGame currentCard="200" onComplete={onComplete} />);
      await flushRoll();
      const callsBefore = onComplete.mock.calls.length;

      expect(screen.getByText('dice.bust')).toBeInTheDocument();
      pressKey('a');
      pressKey('r');
      pressKey('s');

      // The !bustState clause of canAct is behaviourally unkillable: r/s/d need
      // validation.valid (nothing is selected after a bust) and a calls selectAllValid.
      expect(onComplete.mock.calls.length).toBe(callsBefore);
      expect(selectedDice()).toHaveLength(0);
    });
  });

  it('busting a regular card ends the turn with 0 points', async () => {
    const onComplete = vi.fn();
    queueRoll([2, 2, 3, 3, 4, 6]); // no 1/5 and no triplet → bust
    render(<DiceGame currentCard="300" onComplete={onComplete} />);
    await flushRoll();

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false));
  });

  it('a Tutto on a bonus card ends the turn immediately with the bonus applied', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="400" onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    // 1000 (triple 1s) + 500 (triple 5s) + 400 bonus
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1900, true));
  });

  // UI-2: unlike drawNextCard, the 'stop' and tutto-completing branches of
  // handleAction had no re-entrancy guard. Since neither branch awaits,
  // two sequential clicks can never actually overlap -- JS runs the first
  // call to completion before the second is even dispatched -- so the real
  // risk is a call that re-enters handleAction from INSIDE its own
  // execution (a second input -- e.g. Enter's native button activation --
  // landing in the same call stack a synchronous side effect touches).
  // confetti() fires partway through the tutto branch, before the dispatch
  // that ends the turn; this mock uses that moment to fire a second click
  // on the same button, synchronously, before the first call returns --
  // genuine reentrancy, not two settled clicks -- and the guard must
  // swallow it.
  it('a reentrant call into handleAction during a Tutto only completes the turn once', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="400" onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();
    const stopButton = screen.getByText('dice.stop_and_score');

    let reentered = false;
    vi.mocked(confetti).mockImplementation(() => {
      if (!reentered) {
        reentered = true;
        fireEvent.click(stopButton);
      }
      return null;
    });

    fireEvent.click(stopButton);

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // 1000 (triple 1s) + 500 (triple 5s) + 400 bonus -- double-counted score
    // is the observable symptom of a double dispatch.
    expect(onComplete).toHaveBeenCalledWith(1900, true);
    expect(confetti).toHaveBeenCalledTimes(1);
    expect(playSuccess).toHaveBeenCalledTimes(1);
  });

  it('a Tutto on x2 doubles the turn score', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="x2" onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(3000, true));
  });

  it('Feuerwerk keeps rolling after a Tutto and banks all points on the eventual bust', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]); // first roll: full Tutto worth 1500
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();

    // Feuerwerk never offers Stop — only Roll Again.
    expect(screen.queryByText('dice.stop_and_score')).not.toBeInTheDocument();

    queueRoll([2, 2, 3, 3, 4, 6]); // forced re-roll busts
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    // The bust still banks everything rolled before it — a Feuerwerk "win".
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1500, true));
  });

  it('Feuerwerk busting on the first roll scores 0 and counts as a loss', async () => {
    const onComplete = vi.fn();
    queueRoll([2, 2, 3, 3, 4, 6]);
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} />);
    await flushRoll();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false));
  });

  it('Kleeblatt needs two Tuttos: the first re-rolls automatically, the second wins', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    // The first Tutto immediately triggers the second 6-dice roll — queue it up front.
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.roll_2nd_tutto'));
    await flushRoll();

    // Second roll is live now; one Tutto banked.
    expect(screen.getByText('dice.tuttos_count')).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(3000, true));
  });

  it('Kleeblatt busting forfeits the card as a loss', async () => {
    const onComplete = vi.fn();
    queueRoll([2, 2, 3, 3, 4, 6]);
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} />);
    await flushRoll();

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false));
  });

  it('Kniffel builds the run across rolls and completes with score 0 (engine awards the 2000)', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 2, 3, 2, 4, 6]);
    render(<DiceGame currentCard="Kniffel" onComplete={onComplete} />);
    await flushRoll();

    selectAllValid(); // picks the 1-2-3-4 run
    queueRoll([5, 6]); // two dice remain; the run needs 5 then 6
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    // roll_again above already consumed the queued roll; select the completion
    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    // Kniffel itself scores 0 — calculateNextTurn turns the success into 2000.
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, true));
  });

  it('Kniffel judges the next selection by the progress the roll-on committed', async () => {
    // The machine's kniffelProgress — not the roll's own bust parameter — is
    // what validates the NEXT selection. If the roll-on commit lost it, a 6
    // after a kept 1 would read as a fresh descending start and be accepted,
    // quietly abandoning the run the player is mid-way through.
    queueRoll([1, 3, 3, 4, 4, 2]);
    render(<DiceGame currentCard="Kniffel" onComplete={vi.fn()} />);
    await flushRoll();

    fireEvent.click(dieShowing(1, false)); // start the ascending run
    queueRoll([6, 2, 3, 3, 4]); // five dice: the needed 2, and the impostor 6
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    // A 6 is only a valid pick when there is NO progress (fresh descending
    // start). With [1] committed, the run needs a 2 — the 6 must not pass.
    fireEvent.click(dieShowing(6, false));
    expect(screen.getByText('dice.roll_again').closest('button')).toBeDisabled();

    fireEvent.click(dieShowing(6, true)); // put the impostor back
    fireEvent.click(dieShowing(2, false));
    expect(screen.getByText('dice.roll_again').closest('button')).not.toBeDisabled();
  });

  it('does not roll automatically while the panel is still appearing (panelReady=false)', () => {
    render(<DiceGame currentCard="200" onComplete={vi.fn()} panelReady={false} />);

    expect(screen.queryAllByLabelText(/dice.die_showing/).length).toBe(0);
    expect(playTone).not.toHaveBeenCalled();
  });

  it('auto-rolls as soon as panelReady flips to true', async () => {
    queueRoll([1, 5, 2, 2, 3, 4]);
    const { rerender } = render(<DiceGame currentCard="200" onComplete={vi.fn()} panelReady={false} />);

    expect(screen.queryAllByLabelText(/dice.die_showing/).length).toBe(0);

    rerender(<DiceGame currentCard="200" onComplete={vi.fn()} panelReady={true} />);
    await flushRoll();

    expect(screen.getAllByLabelText(/dice.die_showing/).length).toBe(6);
  });

  // Plus/Minus and Kniffel are worth a fixed award for being completed, not the
  // dice they were rolled with — a straight scores no dice at all, and
  // Plus/Minus discards its own. The running total names that award the moment
  // the selection completes the card, instead of standing at zero all the way
  // to the summary (or, for modernized Plus/Minus, climbing toward a dice total
  // the engine always replaced with 1000).
  describe('the running total for a card worth a fixed award', () => {
    const scoreShown = () => screen.getByTestId('dice-current-score').textContent;

    it('shows Plus/Minus what it pays, not the dice, under modernized rules', async () => {
      queueRoll([1, 1, 1, 5, 5, 5]); // 1500 dice points that are never awarded
      render(<DiceGame currentCard="Plus_Minus" onComplete={vi.fn()} />);
      await flushRoll();

      clickDie(1);
      expect(scoreShown()).toBe('0'); // a partial selection completes nothing

      selectAllValid();
      expect(scoreShown()).toBe('1,000');
    });

    it('shows the same for Plus/Minus under classic rules, on top of the chain total', async () => {
      queueRoll([1, 1, 1, 5, 5, 5]);
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1800, keptDice: [], currentRoll: [], kniffelProgress: [],
        tuttosThisTurn: 0, cardsThisTurn: ['300', 'Plus_Minus'], plusMinusScores: [], chainTuttoCount: 1,
        turnKey: 'K',
      }));
      render(<DiceGame currentCard="Plus_Minus" turnKey="K" ruleset="classic" onDrawCard={vi.fn()} onComplete={vi.fn()} />);
      await flushRoll();

      expect(scoreShown()).toBe('1,800');
      selectAllValid();
      expect(scoreShown()).toBe('2,800');
    });

    it('shows a completed straight its 2000', async () => {
      queueRoll([1, 2, 3, 4, 5, 6]);
      render(<DiceGame currentCard="Kniffel" onComplete={vi.fn()} />);
      await flushRoll();

      clickDie(1);
      expect(scoreShown()).toBe('0');

      selectAllValid();
      expect(scoreShown()).toBe('2,000');
    });

    it('leaves an ordinary card counting its dice', async () => {
      queueRoll([1, 5, 2, 2, 3, 4]);
      render(<DiceGame currentCard="200" onComplete={vi.fn()} />);
      await flushRoll();

      selectAllValid();
      expect(scoreShown()).toBe('150'); // 100 + 50, and no card award until the tutto
    });
  });
});

describe('DiceGame pending timer cleanup on unmount', () => {
  beforeEach(() => {
    localStorage.clear();
    // This suite asserts an ABSOLUTE playTone count, so it must own its own
    // baseline. It used to inherit one from the preceding describe's
    // afterEach — a coupling that held in declaration order and broke under
    // --sequence.shuffle, where any tone-playing test could run directly
    // before this one.
    vi.mocked(playTone).mockClear();
    // Use the real (non-zero) durations so roll() actually schedules its
    // animation/finalize setTimeouts at meaningful delays instead of firing
    // on the next tick — otherwise there would be nothing queued to verify
    // cleanup against.
    Object.assign(timing, realTiming);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(timing, ZERO_TIMING);
    localStorage.clear();
  });

  it('clears every pending timer on unmount so no callbacks fire afterward', () => {
    // roll() calls playTone once synchronously (the initial "shake" tone) and
    // then once per die via the staggered tumble timers that live in
    // pendingTimers — that second batch is what unmount must actually cancel.
    // A prop-callback spy (onComplete/onStateChange) doesn't work here: they're
    // wired to *other*, independently-cleaned-up effects and would pass even
    // with pendingTimers cleanup deleted entirely (verified by temporarily
    // removing it — the callback-spy version still passed, a false negative).
    const { unmount } = render(
      <DiceGame currentCard="200" onComplete={vi.fn()} />
    );

    expect(playTone).toHaveBeenCalledTimes(1); // the synchronous "shake" tone only

    // Unmount immediately — before any of the 6 staggered per-die timers fire.
    unmount();
    vi.mocked(playTone).mockClear();

    // If pendingTimers cleanup didn't run, each die's tumble timer would call
    // playTone here.
    act(() => { vi.runAllTimers(); });

    expect(playTone).not.toHaveBeenCalled();
  });
});

describe('DiceGame roll-again mid-animation button stability', () => {
  beforeEach(() => {
    localStorage.clear();
    // Use the real (non-zero) durations so isRolling actually stays true for
    // a stretch after Roll Again, instead of the roll resolving on the next tick.
    Object.assign(timing, realTiming);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(timing, ZERO_TIMING);
    localStorage.clear();
  });

  it('disables Roll Again and Stop & Score in place mid-reroll, instead of unmounting Stop & Score', async () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    // advanceTimersByTime, not runAllTimers: the tumbling-display effect runs
    // a recurring setInterval while dice are rolling (real, non-zero timing in
    // this suite), which runAllTimers would spin on forever.
    act(() => { vi.advanceTimersByTime(2000); }); // let the first roll's animation settle

    fireEvent.click(diceShowing(1, false)[0]); // a lone 1 scores: valid

    const rollAgainBefore = screen.getByText('dice.roll_again').closest('button');
    const stopBefore = screen.getByText('dice.stop_and_score').closest('button');
    expect(rollAgainBefore).not.toBeDisabled();
    expect(stopBefore).not.toBeDisabled();

    queueRoll([2, 3, 4, 6, 1]); // reroll of the 5 dice not kept (includes a 1 so it isn't a bust)
    fireEvent.click(screen.getByText('dice.roll_again')); // starts the reroll: isRolling(true)

    // Mid-animation, before the reroll's timers have run: both buttons must
    // still be the same mounted nodes, merely disabled — previously canStop
    // unmounted Stop & Score here, snapping Roll Again to full width.
    const rollAgainDuring = screen.getByText('dice.roll_again').closest('button');
    const stopDuring = screen.getByText('dice.stop_and_score').closest('button');
    expect(rollAgainDuring).toBe(rollAgainBefore);
    expect(stopDuring).toBe(stopBefore);
    expect(rollAgainDuring).toBeDisabled();
    expect(stopDuring).toBeDisabled();

    act(() => { vi.advanceTimersByTime(2000); }); // finish the reroll animation

    // Still the same nodes once isRolling clears — no remount either way.
    expect(screen.getByText('dice.roll_again').closest('button')).toBe(rollAgainBefore);
    expect(screen.getByText('dice.stop_and_score').closest('button')).toBe(stopBefore);
  });
});

describe('DiceGame chain draw the server discards', () => {
  // Two server paths drop a pushed state outright: applyPushedState's roster
  // bail-out, and the socket-identity gate in socketGameStateHandlers when a
  // transport blip means the sender's socket is no longer the seat's socketId.
  // The next emitRoomState then reverts currentCard (a GAME_STATE_SYNC_KEY) to
  // the card that was drawn FROM — and the deferred chain roll waits on a
  // guard that value can never satisfy again, leaving an empty table with
  // every button disabled on a panel that cannot be dismissed.
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  // Generously past the panel's own recovery deadline — the test pins that the
  // turn recovers, not how long it waits first.
  const PAST_RECOVERY_DEADLINE_MS = 30_000;

  const selectAllValid = () => fireEvent.click(screen.getByText('dice.select_all_valid'));

  /**
   * Draw, then dismiss the reveal it puts up.
   *
   * Awaited throughout this file because the draw is a round trip now: online
   * the card is dealt by the SERVER (the deck is not the client's to draw
   * from), so onDrawCard hands back a promise and the panel does not react
   * within the click that started it.
   */
  const drawAndDismiss = async () => {
    selectAllValid();
    await clickDraw();
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
  };

  it('a second press during the round trip does not spend a second card', async () => {
    // Two guards enforce this and the test passes under either, so it is a
    // behavioural pin rather than an oracle for one of them: the load-bearing
    // one is `validation.valid` at the top of the action handler (the table
    // was committed on the first press, so no valid selection is left to act
    // on), and drawNextCard's drawInFlightRef is the backstop behind it.
    // Deleting the ref alone leaves this green -- deliberately recorded here,
    // because the equivalent physical-dice path in Game.tsx has NO first
    // guard, and there the same double-press really did deal twice.
    let releaseDraw: (card: '500') => void = () => {};
    const onDrawCard = vi.fn(() => new Promise<'500'>(resolve => { releaseDraw = resolve; }));
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={vi.fn()} />);
    flushRollFake();

    selectAllValid();
    await clickDraw();
    await pressDrawKey();

    expect(onDrawCard, 'one press, one card off the deck').toHaveBeenCalledTimes(1);

    await act(async () => { releaseDraw('500'); await Promise.resolve(); });
  });

  it('banks the committed tutto when the drawn card never arrives, instead of stranding the roll', async () => {
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => '500' as const);
    queueRoll([1, 1, 1, 5, 5, 5]); // 1500 dice + 300 card = 1800
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />);
    flushRollFake();

    await drawAndDismiss();
    // currentCard is never re-rendered as '500': the push was discarded, so
    // the store still says '300'.
    act(() => { vi.advanceTimersByTime(PAST_RECOVERY_DEADLINE_MS); });

    // The same fallback a draw the store refuses already takes: bank the tutto
    // that was already committed.
    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledWith(1800, true, expect.objectContaining({
      // The card that never became this turn's must not ride into the summary
      // — nor count against the chain cap.
      cards: [{ card: '300', completed: true }],
      tuttoCount: 1,
      ended: 'banked',
    }));
  });

  it('recovers on the contradiction itself, without stranding the reveal or waiting out the deadline', async () => {
    // The real sequence: drawCardMidTurn sets the drawn card locally before the
    // push is even sent, so the reveal goes up on a card that IS current — and
    // the discarded push's revert lands while the player is still reading it.
    // Arming the deadline only on dismissal put them in front of an empty table
    // with every button disabled for the whole of it.
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => '500' as const);
    queueRoll([1, 1, 1, 5, 5, 5]); // 1500 dice + 300 card = 1800
    const props = { ruleset: 'classic' as const, onDrawCard, onComplete };
    const { rerender } = render(<DiceGame currentCard="300" {...props} />);
    flushRollFake();

    selectAllValid();
    await clickDraw();
    rerender(<DiceGame currentCard="500" {...props} />); // the store's own optimistic set...
    rerender(<DiceGame currentCard="300" {...props} />); // ...reverted by the next room state

    // No timer advanced: the reveal for a card that is not in play is gone and
    // the panel is on the banked summary for the card the server does call
    // current — a state the player can act on.
    expect(screen.queryByTestId('drawn-card-continue')).not.toBeInTheDocument();
    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenCalledWith(1800, true, expect.objectContaining({
      cards: [{ card: '300', completed: true }],
      tuttoCount: 1,
      ended: 'banked',
    }));
  });

  it('leaves the accepted draw alone: the card arrives, the roll is released, nothing is banked', async () => {
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => '500' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    const { rerender } = render(
      <DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />,
    );
    flushRollFake();

    selectAllValid();
    await clickDraw();
    queueRoll([1, 5, 2, 3, 4, 6]); // the fresh roll on the new card
    rerender(<DiceGame currentCard="500" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));

    act(() => { vi.advanceTimersByTime(PAST_RECOVERY_DEADLINE_MS); });

    expect(dieShowing(1, false)).toBeInTheDocument();
    expect(screen.queryByText('dice.bank_points')).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not mistake a second card of the same type for a discarded draw', async () => {
    // currentCard cannot change when the drawn card matches the current one,
    // so this draw looks exactly like a reverted one from the outside — the
    // reveal being dismissed is what releases it.
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => '300' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />);
    flushRollFake();

    selectAllValid();
    await clickDraw();
    queueRoll([1, 5, 2, 3, 4, 6]);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));

    act(() => { vi.advanceTimersByTime(PAST_RECOVERY_DEADLINE_MS); });

    expect(dieShowing(1, false)).toBeInTheDocument();
    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('1,800');
    expect(screen.queryByText('dice.bank_points')).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('recovers a discarded Stop draw while its reveal is still up', async () => {
    // A drawn Stop never arms the deferred roll, so none of the recovery above
    // watches it — yet its push can be discarded exactly like any other draw.
    // Committing the forfeit anyway logs a Stop the server's deck still holds.
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => 'Stop' as const);
    queueRoll([1, 1, 1, 5, 5, 5]); // 1500 dice + 300 card = 1800
    const props = { ruleset: 'classic' as const, onDrawCard, onComplete };
    const { rerender } = render(<DiceGame currentCard="300" {...props} />);
    flushRollFake();

    selectAllValid();
    await clickDraw();
    rerender(<DiceGame currentCard="Stop" {...props} />); // the store's own optimistic set...
    rerender(<DiceGame currentCard="300" {...props} />); // ...reverted by the next room state

    // The reveal announces a card the turn never got — gone with the draw, and
    // the forfeit it would have led to never shows. The committed tutto banks,
    // the same fallback as every other discarded draw.
    expect(screen.queryByTestId('drawn-card-continue')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.stop_card_drawn')).not.toBeInTheDocument();
    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenCalledWith(1800, true, expect.objectContaining({
      cards: [{ card: '300', completed: true }],
      tuttoCount: 1,
      ended: 'banked',
    }));
  });

  it('recovers when the revert lands after the Stop reveal was dismissed', async () => {
    // The forfeit summary runs a countdown before it commits — a revert
    // landing inside that window must still convert the turn to its bank.
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => 'Stop' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    const props = { ruleset: 'classic' as const, onDrawCard, onComplete };
    const { rerender } = render(<DiceGame currentCard="300" {...props} />);
    flushRollFake();

    selectAllValid();
    await clickDraw();
    rerender(<DiceGame currentCard="Stop" {...props} />);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    expect(screen.getByText('dice.stop_card_drawn')).toBeInTheDocument();

    rerender(<DiceGame currentCard="300" {...props} />);

    expect(screen.queryByText('dice.stop_card_drawn')).not.toBeInTheDocument();
    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenCalledWith(1800, true, expect.objectContaining({
      cards: [{ card: '300', completed: true }],
      tuttoCount: 1,
      ended: 'banked',
    }));
  });

  it('leaves a Stop the store does hold alone — the forfeit is real', async () => {
    // The optimistic set makes currentCard 'Stop' and nothing reverts it: the
    // recovery must not fire on the interim renders around the reveal.
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => 'Stop' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    const props = { ruleset: 'classic' as const, onDrawCard, onComplete };
    const { rerender } = render(<DiceGame currentCard="300" {...props} />);
    flushRollFake();

    selectAllValid();
    await clickDraw();
    rerender(<DiceGame currentCard="Stop" {...props} />);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));

    expect(screen.getByText('dice.stop_card_drawn')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(PAST_RECOVERY_DEADLINE_MS); });
    expect(onComplete).toHaveBeenCalledWith(0, false, expect.objectContaining({
      cards: [{ card: '300', completed: true }, { card: 'Stop', completed: false }],
      ended: 'stopCard',
    }));
  });
});

describe('DiceGame dice settled before the roll finalizes', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // Use the real (non-zero) durations — collapsing the whole roll to the
    // next tick would erase the very window this describe is about.
    Object.assign(timing, realTiming);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(timing, ZERO_TIMING);
    localStorage.clear();
  });

  const DICE_IN_A_ROLL = 6;
  // The last die of a full roll stops tumbling here; finalizeRoll — which is
  // what actually lets clicks through — only runs ROLL_SETTLE_BUFFER_MS later.
  // Read from realTiming (the true values captured before this describe's
  // beforeEach overrides `timing`), not the live mocked import — this
  // constant is computed once, at collection time, before any beforeEach runs.
  const LAST_DIE_SETTLES_MS = realTiming.DIE_TUMBLE_MS + (DICE_IN_A_ROLL - 1) * realTiming.DIE_STAGGER_MS;

  it('renders a settled die disabled while the roll as a whole is still pending', () => {
    // The die had stopped moving and looked clickable — pointer cursor, hover
    // highlight — while DiceGame's own handler still dropped the click: the
    // player clicks a 1 and nothing happens.
    queueRoll([1, 5, 2, 3, 4, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    act(() => { vi.advanceTimersByTime(LAST_DIE_SETTLES_MS); });

    const settled = dieShowing(1, false);
    expect(settled).toBeDisabled();
    expect(settled.className).not.toContain('cursor-pointer');
    fireEvent.click(settled);
    expect(dieShowing(1, false)).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(realTiming.ROLL_SETTLE_BUFFER_MS); });

    // Finalized: the guard is gone, so the die offers itself again — and means it.
    const finalized = dieShowing(1, false);
    expect(finalized).not.toBeDisabled();
    expect(finalized.className).toContain('cursor-pointer');
    fireEvent.click(finalized);
    expect(dieShowing(1, true)).toBeInTheDocument();
  });

  it('keeps a busted roll\'s dice disabled once it finalizes', () => {
    // The pending flag clears on the same tick the bust arrives — the dice
    // must not become clickable in the swap.
    queueRoll([2, 2, 3, 3, 4, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    act(() => { vi.advanceTimersByTime(LAST_DIE_SETTLES_MS + realTiming.ROLL_SETTLE_BUFFER_MS); });

    expect(screen.getByText('dice.bust_description')).toBeInTheDocument();
    screen.getAllByLabelText(/dice.die_showing/).forEach(die => expect(die).toBeDisabled());
  });
});

describe('DiceGame Kleeblatt bust delay', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(timing, realTiming);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(timing, ZERO_TIMING);
    localStorage.clear();
  });

  it('delays showing the summary when busting on Kleeblatt card', () => {
    const onComplete = vi.fn();
    queueRoll([2, 2, 3, 3, 4, 6]); // A bust roll
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} />);

    // Let the dice roll animation complete
    // totalAnimationTime is baseTumbleTime + 5 * staggerDelay = 400 + 5 * 150 = 1150ms
    // finalizeRoll runs totalAnimationTime + ROLL_SETTLE_BUFFER_MS (100ms) = 1250ms
    act(() => { vi.advanceTimersByTime(1250); });

    // After roll settles, we should be busted, but the summary is delayed
    expect(screen.queryByText('dice.bust')).toBeNull();

    // Advance by BUST_SUMMARY_DELAY_MS (1500ms)
    act(() => { vi.advanceTimersByTime(1500); });

    // Now the bust summary should be visible
    expect(screen.getByText('dice.bust')).toBeInTheDocument();
  });
});

describe('DiceGame classic chains', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  const selectAllValid = () => fireEvent.click(screen.getByText('dice.select_all_valid'));
  const clickDie = (val: number) => {
    const dice = diceShowing(val, false);
    fireEvent.click(dice[0]);
  };

  it('offers bank and draw side by side on the tutto, and banks with a turn summary', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]); // 1000 + 500, all six scoring
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={vi.fn()} onComplete={onComplete} />);
    await flushRoll();

    // Both options sit in the same button row, on the selection that completes
    // the tutto — the player is not told the turn stopped and then offered a
    // way to carry on.
    selectAllValid();
    expect(screen.getByText('dice.stop_and_score')).toBeInTheDocument();
    expect(screen.getByTestId('draw-next-card')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.stop_and_score'));

    // Banking is now a decided turn: the summary states the total and counts
    // down, offering no second choice.
    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();
    expect(screen.queryByTestId('draw-next-card')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenCalledWith(1800, true, expect.objectContaining({
      cards: [{ card: '300', completed: true }],
      tuttoCount: 1,
      plusMinusScores: [],
      ended: 'banked',
    }));
  });

  it('offers the draw only once the selection completes the tutto', async () => {
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={vi.fn()} onComplete={vi.fn()} />);
    await flushRoll();

    clickDie(1); // one scoring die: valid, but nowhere near a tutto
    expect(screen.queryByTestId('draw-next-card')).not.toBeInTheDocument();

    selectAllValid();
    expect(screen.getByTestId('draw-next-card')).toBeInTheDocument();
  });

  it('never offers the draw under modernized rules', async () => {
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" onDrawCard={vi.fn()} onComplete={vi.fn()} />);
    await flushRoll();

    selectAllValid();
    expect(screen.getByText('dice.stop_and_score')).toBeInTheDocument();
    expect(screen.queryByTestId('draw-next-card')).not.toBeInTheDocument();
  });

  it('drawing an x2 mid-chain doubles the whole accumulated total on its tutto', async () => {
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => 'x2' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    const { rerender } = render(
      <DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />,
    );
    await flushRoll();

    selectAllValid();
    queueRoll([1, 1, 1, 5, 5, 5]); // the fresh 6-dice roll on the x2 card
    await clickDraw(); // tutto → 1800, drawn on
    expect(onDrawCard).toHaveBeenCalled();

    // The new card arrives through the prop, and the roll waits for the reveal
    // to be dismissed on top of that.
    rerender(<DiceGame currentCard="x2" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    // (1800 + 1500) doubled by the x2 tutto = 6600.
    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenCalledWith(6600, true, expect.objectContaining({
      cards: [{ card: '300', completed: true }, { card: 'x2', completed: true }],
      tuttoCount: 2,
      ended: 'banked',
    }));
  });

  it('a Stop card drawn mid-chain forfeits the entire turn', async () => {
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => 'Stop' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="500" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();
    await clickDraw();

    // The Stop is revealed like any other drawn card; the forfeit summary
    // follows once the player has seen it.
    expect(screen.getByTestId('drawn-card-continue')).toBeInTheDocument();
    expect(screen.queryByText('dice.stop_card_drawn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('drawn-card-continue'));

    expect(screen.getByText('dice.stop_card_drawn')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false, expect.objectContaining({
      cards: [{ card: '500', completed: true }, { card: 'Stop', completed: false }],
      ended: 'stopCard',
    })));
  });

  it('classic Feuerwerk force-keeps every scoring die and locks the selection', async () => {
    queueRoll([1, 5, 2, 3, 4, 6]); // exactly two scoring dice: the 1 and the 5
    render(<DiceGame currentCard="Feuerwerk" ruleset="classic" onComplete={vi.fn()} />);
    await flushRoll();

    expect(dieShowing(1, true)).toBeInTheDocument();
    expect(dieShowing(5, true)).toBeInTheDocument();
    expect(dieShowing(2, false)).toBeInTheDocument();

    // toggleDie is a no-op: clicking the forced selection changes nothing.
    fireEvent.click(dieShowing(1, true));
    expect(dieShowing(1, true)).toBeInTheDocument();
    fireEvent.click(dieShowing(2, false));
    expect(dieShowing(2, false)).toBeInTheDocument();
  });

  it('renders classic Feuerwerk\'s locked dice as unclickable, not merely dead to clicks', async () => {
    // The no-op above was invisible: every die still came with a pointer cursor
    // and a hover highlight, so the whole board invited clicks it swallowed.
    queueRoll([1, 5, 2, 3, 4, 6]);
    render(<DiceGame currentCard="Feuerwerk" ruleset="classic" onComplete={vi.fn()} />);
    await flushRoll();

    screen.getAllByLabelText(/dice.die_showing/).forEach(die => {
      expect(die).toBeDisabled();
      expect(die.className).not.toContain('cursor-pointer');
    });

    // Modernized Feuerwerk picks its own dice — that board stays clickable.
    cleanup();
    queueRoll([1, 5, 2, 3, 4, 6]);
    render(<DiceGame currentCard="Feuerwerk" onComplete={vi.fn()} />);
    await flushRoll();
    expect(dieShowing(1, false)).not.toBeDisabled();
  });

  it('classic straight collects any missing numbers, in any order', async () => {
    const onComplete = vi.fn();
    queueRoll([3, 3, 2, 2, 4, 4]); // a modernized straight would bust here (no 1, no 6)
    render(<DiceGame currentCard="Kniffel" ruleset="classic" onDrawCard={vi.fn()} onComplete={onComplete} />);
    await flushRoll();

    clickDie(3);
    clickDie(2);
    clickDie(4);
    queueRoll([1, 5, 6]); // the three still-missing numbers at once
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));

    // Straight = 2000, then the bank-or-draw choice.
    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenCalledWith(2000, true, expect.objectContaining({
      cards: [{ card: 'Kniffel', completed: true }],
      ended: 'banked',
    }));
  });

  it('classic Plus/Minus scores exactly +1000 on its tutto, ignoring the dice points', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]); // 1500 dice points that must NOT count
    render(<DiceGame currentCard="Plus_Minus" ruleset="classic" onDrawCard={vi.fn()} onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));

    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenCalledWith(1000, true, expect.objectContaining({
      cards: [{ card: 'Plus_Minus', completed: true }],
      // Nothing was on the table before it — the running total the engine
      // replays this ±1000 against is 0.
      plusMinusScores: [0],
      ended: 'banked',
    }));
  });

  it('records the running total a mid-chain Plus/Minus resolved on', async () => {
    // The engine replays each ±1000 against what the player held when the card
    // resolved, so a Plus/Minus drawn onto 1800 must report 1800 — not 0, which
    // would deduct from a leader this chain had already overtaken.
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => 'Plus_Minus' as const);
    queueRoll([1, 1, 1, 5, 5, 5]); // 300 card: 1500 dice + 300 = 1800
    const { rerender } = render(
      <DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />,
    );
    await flushRoll();

    selectAllValid();
    queueRoll([1, 1, 1, 5, 5, 5]);
    await clickDraw();
    rerender(<DiceGame currentCard="Plus_Minus" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));
    fireEvent.click(screen.getByText('dice.bank_points'));

    expect(onComplete).toHaveBeenCalledWith(2800, true, expect.objectContaining({
      plusMinusScores: [1800],
      ended: 'banked',
    }));
  });

  it('a classic Feuerwerk null banks the whole accumulated chain', async () => {
    const onComplete = vi.fn();
    const onDrawCard = vi.fn(async () => 'Feuerwerk' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    const { rerender } = render(
      <DiceGame currentCard="200" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />,
    );
    await flushRoll();
    selectAllValid();
    queueRoll([1, 2, 3, 4, 6, 6]); // the forced keep takes the 1...
    await clickDraw(); // tutto → 1700, drawn on
    rerender(<DiceGame currentCard="Feuerwerk" ruleset="classic" onDrawCard={onDrawCard} onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    await flushRoll();

    queueRoll([2, 3, 4, 6, 6]); // ...and the next roll is a null → banks everything
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1800, true, expect.objectContaining({
      cards: [{ card: '200', completed: true }, { card: 'Feuerwerk', completed: true }],
      ended: 'banked',
    })));
  });

  it('a classic Feuerwerk banked without a single clear counts no tutto', async () => {
    // The null that ends a Feuerwerk banks the card — that is how this one
    // completes — but a null is not a tutto, and nothing here ever cleared six
    // dice. `completed` and the tutto count answer two different questions.
    const onComplete = vi.fn();
    queueRoll([1, 2, 3, 4, 6, 6]); // the forced keep takes the 1 — 100, no clear
    render(<DiceGame currentCard="Feuerwerk" ruleset="classic" onDrawCard={vi.fn()} onComplete={onComplete} />);
    await flushRoll();

    queueRoll([2, 3, 4, 6, 6]); // the five left roll a null → banks the 100
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(100, true, expect.objectContaining({
      cards: [{ card: 'Feuerwerk', completed: true }],
      tuttoCount: 0,
      ended: 'banked',
    })));
  });

  it('counts the clears a classic Feuerwerk made before the null that banked it', async () => {
    // Feuerwerk hands all six dice back on a clear, so the tuttos are real and
    // counted — the physical side can only ever report its floor for the same
    // turn (see usePhysicalChain.buildSummary).
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]); // all six score: a tutto worth 1500, six fresh dice
    render(<DiceGame currentCard="Feuerwerk" ruleset="classic" onDrawCard={vi.fn()} onComplete={onComplete} />);
    await flushRoll();

    queueRoll([2, 2, 3, 3, 4, 6]); // the fresh six roll a null → banks the 1500
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1500, true, expect.objectContaining({
      cards: [{ card: 'Feuerwerk', completed: true }],
      tuttoCount: 1,
      ended: 'banked',
    })));
  });

  it('restores a snapshot with all six dice put aside into the banked summary', () => {
    // Six kept dice under classic is a completed tutto that was BANKED — the
    // draw was already declined in the button row, so restoring must not
    // reopen it (nor hand back a table with nothing left to select).
    const kept = [1, 2, 3, 4, 5, 6].map(v => ({ id: `d${v}`, val: v }));
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 1800, keptDice: kept, currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 1, cardsThisTurn: ['300'], plusMinusScores: [], chainTuttoCount: 1,
      turnKey: 'K',
    }));
    render(<DiceGame currentCard="300" turnKey="K" ruleset="classic" onDrawCard={vi.fn()} onComplete={vi.fn()} />);

    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();
    expect(screen.queryByTestId('draw-next-card')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.roll_again')).not.toBeInTheDocument();
  });

  it('shows the drawn card and holds the fresh roll until it is dismissed', async () => {
    const onDrawCard = vi.fn(async () => '500' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    const { rerender } = render(
      <DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={vi.fn()} />,
    );
    await flushRoll();

    selectAllValid();
    await clickDraw();
    rerender(<DiceGame currentCard="500" ruleset="classic" onDrawCard={onDrawCard} onComplete={vi.fn()} />);

    // The reveal names the drawn card, which card of the chain it is, and the
    // total it puts at risk — this modal covers the board, so nothing else
    // would tell the player any of it.
    expect(screen.getByText('dice.drawn_card_title')).toBeInTheDocument();
    expect(screen.getByText('dice.chain_card_count')).toBeInTheDocument();
    expect(screen.getByText('1800')).toBeInTheDocument();
    // No dice yet: rolling behind the reveal would waste the roll the player
    // never saw.
    expect(screen.queryAllByTestId('die')).toHaveLength(0);
    expect(screen.queryByText('dice.current_score')).not.toBeInTheDocument();

    queueRoll([1, 5, 2, 3, 4, 6]);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    await flushRoll();

    expect(screen.queryByText('dice.drawn_card_title')).not.toBeInTheDocument();
    expect(dieShowing(1, false)).toBeInTheDocument();
  });

  it('banks the tutto when the store refuses to draw', async () => {
    // The store declines for a finished game or an empty deck. The tutto is
    // already committed by then, so the turn has to land on the banked
    // summary — not on a decided table with nothing left to press.
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={async () => null} onComplete={onComplete} />);
    await flushRoll();

    selectAllValid();
    await clickDraw();

    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1800, true, expect.objectContaining({
      cards: [{ card: '300', completed: true }],
      ended: 'banked',
    })));
  });

  it('draws a second card of the same type without waiting for a prop that never changes', async () => {
    // currentCard does not change when the drawn card matches the current one,
    // so the deferred roll can only be released by the reveal being dismissed.
    const onDrawCard = vi.fn(async () => '300' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={vi.fn()} />);
    await flushRoll();

    selectAllValid();
    await clickDraw();
    expect(screen.getByTestId('drawn-card-continue')).toBeInTheDocument();

    queueRoll([1, 5, 2, 3, 4, 6]);
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    await flushRoll();

    expect(dieShowing(1, false)).toBeInTheDocument();
    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('1,800');
  });

  it('D draws the next card, the same as the button', async () => {
    const onDrawCard = vi.fn(async () => '500' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={vi.fn()} />);
    await flushRoll();

    selectAllValid();
    await pressDrawKey();

    expect(onDrawCard).toHaveBeenCalled();
    expect(screen.getByTestId('drawn-card-continue')).toBeInTheDocument();
  });

  it('resumes a reload taken between the draw and its first roll by rolling', async () => {
    // The reveal panel holds that window open for as long as the player takes
    // to dismiss it, so the empty table it snapshots is now genuinely
    // reachable — restoring it as-is left no dice and no way to get any.
    queueRoll([1, 5, 2, 3, 4, 6]);
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 1800, keptDice: [], currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 0, cardsThisTurn: ['300', '500'], plusMinusScores: [], chainTuttoCount: 1,
      turnKey: 'K',
    }));
    render(<DiceGame currentCard="500" turnKey="K" ruleset="classic" onDrawCard={vi.fn()} onComplete={vi.fn()} />);
    await flushRoll();

    expect(dieShowing(1, false)).toBeInTheDocument();
    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('1,800');
  });

  it('Stop & Score commits the banked state into the live snapshot', async () => {
    // Spectators and the resume cache must see the DECIDED turn during the
    // countdown, not the pre-stop table the decision could roll back into.
    const onStateChange = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 2]); // five scoring dice; the 2 stays out
    render(<DiceGame currentCard="300" onComplete={vi.fn()} onStateChange={onStateChange} />);
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    await waitFor(() => {
      const last = onStateChange.mock.calls.at(-1)?.[0];
      expect(last?.stopped).toBe(true);
      expect(last?.turnScore).toBe(1100);
      expect(last?.currentRoll).toEqual([]);
      // 5s: the snapshot follows a real 300ms debounce (see the restore test).
    }, { timeout: 5000 });
  });

  it('a modernized tutto commits the banked state into the live snapshot', async () => {
    // Same contract as Stop & Score above: the DECIDED turn must reach the
    // resume cache and the spectators — not the pre-tutto table the decision
    // could be rolled back into.
    const onStateChange = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]); // all six scoring → tutto
    render(<DiceGame currentCard="300" onComplete={vi.fn()} onStateChange={onStateChange} />);
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    await waitFor(() => {
      const last = onStateChange.mock.calls.at(-1)?.[0];
      expect(last?.stopped).toBe(true);
      expect(last?.turnScore).toBe(1800); // 1500 dice + 300 card bonus
      expect(last?.keptDice).toHaveLength(6);
      expect(last?.currentRoll).toEqual([]);
    }, { timeout: 5000 });
  });

  it('a completed Kleeblatt win commits the decided state into the live snapshot', async () => {
    const onStateChange = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]); // first tutto
    queueRoll([1, 1, 1, 5, 5, 5]); // second tutto — the win
    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} onStateChange={onStateChange} />);
    await flushRoll();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.roll_2nd_tutto'));
    await flushRoll();
    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    await waitFor(() => {
      const last = onStateChange.mock.calls.at(-1)?.[0];
      expect(last?.stopped).toBe(true);
      expect(last?.keptDice).toHaveLength(6);
      expect(last?.currentRoll).toEqual([]);
    }, { timeout: 5000 });
  });

  it('restores a reload during the drawn-Stop summary into that summary, not a dice table', async () => {
    // The snapshot written while the Stop forfeit summary was showing: no
    // dice on the table, the chain ending in the drawn Stop. Restoring it
    // into the regular dice table would let the player roll — and bank —
    // against a Stop card.
    const onComplete = vi.fn();
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 1800, keptDice: [], currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 1, cardsThisTurn: ['300', 'Stop'], plusMinusScores: [], chainTuttoCount: 1,
      turnKey: 'K',
    }));
    render(<DiceGame currentCard="Stop" turnKey="K" ruleset="classic" onDrawCard={vi.fn()} onComplete={onComplete} />);

    expect(screen.getByText('dice.stop_card_drawn')).toBeInTheDocument();
    // A forfeit offers no bank-or-draw choice and no dice to roll.
    expect(screen.queryByText('dice.bank_points')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.roll_again')).not.toBeInTheDocument();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false, expect.objectContaining({
      cards: [{ card: '300', completed: true }, { card: 'Stop', completed: false }],
      ended: 'stopCard',
      forfeitedScore: 1800,
    })));
  });

  it('names the banked chain total at the chain-card cap and banks via the countdown', async () => {
    const onComplete = vi.fn();
    const kept = [1, 2, 3, 4, 5, 6].map(v => ({ id: `d${v}`, val: v }));
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 9000, keptDice: kept, currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 1, cardsThisTurn: Array(MAX_CHAIN_CARDS).fill('300'),
      plusMinusScores: [], chainTuttoCount: MAX_CHAIN_CARDS, turnKey: 'K',
    }));
    render(<DiceGame currentCard="300" turnKey="K" ruleset="classic" onDrawCard={vi.fn()} onComplete={onComplete} />);

    // A capped chain is still a chain TOTAL being banked, so the summary has
    // to keep naming it. "May another card be drawn?" and "is this a banked
    // chain total?" are two questions, and answering both with the same
    // expression is what once hid the banked total here. DiceSummary's own
    // tests take banksChainTotal as a prop, so this is the only place the
    // expression that computes it is exercised.
    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();
    expect(screen.queryByText('dice.continue')).not.toBeInTheDocument();
    expect(screen.getByText('dice.points_gained')).toBeInTheDocument();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(9000, true, expect.objectContaining({
      ended: 'banked',
    })));
    expect(onComplete.mock.calls[0][2].cards).toHaveLength(MAX_CHAIN_CARDS);
  });

  // Every validator that carries a chain (resume cache, pushed snapshot, turn
  // summary) refuses anything past MAX_CHAIN_CARDS wholesale — one more draw
  // would get the whole turn thrown away, so at the cap the only move left is
  // banking. Both resume mid-draw (empty table → fresh roll) and play the
  // tutto, which is where the offer is now made.
  const renderChainOfLength = async (length: number) => {
    queueRoll([1, 1, 1, 5, 5, 5]);
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 9000, keptDice: [], currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 0, cardsThisTurn: Array(length).fill('300'),
      plusMinusScores: [], chainTuttoCount: length - 1, turnKey: 'K',
    }));
    render(<DiceGame currentCard="300" turnKey="K" ruleset="classic" onDrawCard={vi.fn()} onComplete={vi.fn()} />);
    await flushRoll();
    selectAllValid();
  };

  it('closes the draw at the chain-card cap, leaving only Stop & Score', async () => {
    await renderChainOfLength(MAX_CHAIN_CARDS);

    expect(screen.queryByTestId('draw-next-card')).not.toBeInTheDocument();
    expect(screen.getByText('dice.stop_and_score')).toBeInTheDocument();
  });

  it('still offers the draw one card below the cap', async () => {
    await renderChainOfLength(MAX_CHAIN_CARDS - 1);

    expect(screen.getByTestId('draw-next-card')).toBeInTheDocument();
  });
});

// A mutation sweep over diceTurnReducer (the review of 5c8a0ac) killed each
// of the transitions below without any DOM test noticing — they were pinned
// only by the reducer's own unit tests. Each test here asserts the
// user-visible consequence through the real board. The sweep's remaining
// arms (CHAIN_DRAWN's bust/showSummary/turnScore/tutto-reset/Stop-summary
// handling, ROLL_STARTED's bust-clear, DRAW_ABANDONED's count) stay
// unit-only on purpose: no real flow can reach them — a draw cannot happen
// while busted, the drawn card's base always equals the already-committed
// total — so a DOM test would have to fabricate impossible state. The init
// mapping's bustState seed and DRAW_ABANDONED's stopped marker are likewise
// pinned only by the reducer's unit tests.
describe('machine transitions the DOM suite left to unit tests', () => {
  const selectAllValid = () => fireEvent.click(screen.getByText('dice.select_all_valid'));

  // Same hygiene as every other describe here that touches the resume cache:
  // the restore tests below seed tutto_dice_turn_state, and the live tests
  // mount without a turnKey — which restores UNCONDITIONALLY, so a leftover
  // seed from any earlier test would replace their fresh roll.
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('shows the banked running total after rolling on', async () => {
    queueRoll([1, 5, 2, 2, 3, 4]);
    render(<DiceGame currentCard="300" onComplete={vi.fn()} />);
    await flushRoll();

    fireEvent.click(dieShowing(1, false));
    fireEvent.click(dieShowing(5, false));
    queueRoll([2, 3, 4, 1]); // four dice left; the 1 keeps the roll alive
    fireEvent.click(screen.getByText('dice.roll_again'));

    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('150');
  });

  it('clears the kept tray for the second Kleeblatt tutto attempt', async () => {
    // The first tutto is built across TWO rolls, so the tray actually holds
    // dice when it completes — a one-roll tutto keeps everything in the
    // selection and would leave nothing for the clear to be seen clearing.
    queueRoll([1, 1, 1, 2, 3, 4]);
    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} />);
    await flushRoll();

    selectAllValid(); // the three 1s go to the tray
    queueRoll([5, 5, 5]);
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();
    selectAllValid(); // the three 5s complete the first tutto
    queueRoll([1, 2, 3, 4, 6, 6]); // the fresh six; the 1 keeps it alive
    fireEvent.click(screen.getByText('dice.roll_2nd_tutto'));
    await flushRoll();

    // The first tutto is banked into the total; the tray must be EMPTY for
    // the second attempt — six fresh dice on the board, none carried over.
    // (Tray dice carry the interpolated dice.dieFace label, which the
    // bare-key mock collapses — so the tray is asserted by count.)
    expect(screen.queryAllByLabelText('dice.dieFace')).toHaveLength(0);
    expect(screen.getAllByLabelText(/dice.die_showing/)).toHaveLength(6);
  });

  it('commits the completed Kniffel run into the live snapshot', async () => {
    const onStateChange = vi.fn();
    queueRoll([1, 2, 3, 2, 4, 6]);
    render(<DiceGame currentCard="Kniffel" onComplete={vi.fn()} onStateChange={onStateChange} />);
    await flushRoll();

    selectAllValid(); // the 1-2-3-4 run
    queueRoll([5, 6]);
    fireEvent.click(screen.getByText('dice.roll_again'));
    await flushRoll();
    selectAllValid(); // 5 and 6 complete it
    fireEvent.click(screen.getByText('dice.finish_card'));

    // The decided turn's snapshot carries the finished run — it is what a
    // spectator sorts the kept dice by, and what a reload restores from.
    await waitFor(() => {
      const last = onStateChange.mock.calls.at(-1)?.[0];
      expect(last?.stopped).toBe(true);
      expect(last?.kniffelProgress).toEqual([1, 2, 3, 4, 5, 6]);
    }, { timeout: 5000 });
  });

  it('counts the drawn card into the chain badge', async () => {
    const onDrawCard = vi.fn(async () => '300' as const);
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="300" ruleset="classic" onDrawCard={onDrawCard} onComplete={vi.fn()} />);
    await flushRoll();

    // Card 1 of the chain: no badge yet.
    expect(screen.queryByText('dice.chain_card_count')).not.toBeInTheDocument();

    selectAllValid();
    queueRoll([1, 2, 3, 4, 6, 6]);
    await clickDraw();
    // Drawing the SAME card type: currentCard never changes, so no rerender
    // is needed — dismissing the reveal releases the deferred roll.
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    await flushRoll();

    // Card 2: the badge appears. The count itself is interpolated inside
    // t() (collapsed by the bare-key mock); presence at >1 is the assertable
    // edge, and exactly what a dropped increment breaks.
    expect(screen.getByText('dice.chain_card_count')).toBeInTheDocument();
  });

  it('starts a freshly drawn Kniffel with an empty run', async () => {
    const onDrawCard = vi.fn(async () => 'Kniffel' as const);
    queueRoll([1, 2, 3, 4, 5, 6]); // classic Kniffel: the whole straight at once
    render(<DiceGame currentCard="Kniffel" ruleset="classic" onDrawCard={onDrawCard} onComplete={vi.fn()} />);
    await flushRoll();

    selectAllValid();
    queueRoll([1, 2, 2, 3, 3, 4]);
    await clickDraw();
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    await flushRoll();

    // The new Kniffel needs every number again, so a 1 must be selectable.
    // With the finished run leaking across the draw, every number would read
    // as already collected and no selection could ever be valid again.
    fireEvent.click(dieShowing(1, false));
    expect(screen.getByText('dice.roll_again').closest('button')).not.toBeDisabled();
  });

  it("puts the snapshot's kept dice back on the tray", () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 150,
      keptDice: [{ id: 'k1', val: 1 }, { id: 'k2', val: 5 }],
      currentRoll: [2, 3, 4, 1].map((val, i) => ({ id: `c${i}`, val, selected: false })),
      kniffelProgress: [], tuttosThisTurn: 0,
    }));

    render(<DiceGame currentCard="300" onComplete={vi.fn()} />);

    expect(screen.getAllByLabelText('dice.dieFace')).toHaveLength(2);
    expect(dieShowing(2, false)).toBeInTheDocument();
  });

  it('judges the first selection after a restore by the restored run', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 0,
      keptDice: [{ id: 'k1', val: 1 }],
      currentRoll: [6, 2, 3, 3, 4].map((val, i) => ({ id: `c${i}`, val, selected: false })),
      kniffelProgress: [1], tuttosThisTurn: 0,
    }));

    render(<DiceGame currentCard="Kniffel" onComplete={vi.fn()} />);

    // Same discriminator as the live roll-on test above: a 6 is only a valid
    // pick when there is NO progress (a fresh descending start) — the
    // restored [1] must refuse it and demand the 2.
    fireEvent.click(dieShowing(6, false));
    expect(screen.getByText('dice.roll_again').closest('button')).toBeDisabled();

    fireEvent.click(dieShowing(6, true));
    fireEvent.click(dieShowing(2, false));
    expect(screen.getByText('dice.roll_again').closest('button')).not.toBeDisabled();
  });

  it('wins on the second tutto after restoring a mid-Kleeblatt turn', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 1300,
      keptDice: [],
      currentRoll: [1, 1, 1, 5, 5, 5].map((val, i) => ({ id: `c${i}`, val, selected: false })),
      kniffelProgress: [], tuttosThisTurn: 1,
    }));

    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} />);

    selectAllValid();
    // tuttosThisTurn = 1 restored: this selection is the SECOND tutto — the
    // button must offer to finish the card, not to roll a "2nd" tutto again.
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
  });
});

describe('DiceGame restore verdict is a fact about the snapshot, not about the live card', () => {
  beforeEach(() => {
    localStorage.clear();
    rollQueue.length = 0;
  });

  afterEach(() => {
    localStorage.clear();
  });

  // A reload during a drawn Stop restores straight into that card's forfeit
  // summary (deriveRestoredTurn's stoppedByCard branch). If the server then
  // discards the draw, currentCard reverts off 'Stop' and the panel converts
  // the turn to the bank it had already committed.
  //
  // deriveRestoredTurn was re-run on every render, and its midDraw branch is
  // card-dependent through exactly that stoppedByCard check: false while the
  // prop said 'Stop', true the moment it moved off it. midDraw is a dependency
  // of the opening-roll effect, whose only brake for a restored turn is
  // `restored && !restore.midDraw` — so the revert flipped the dep, re-ran the
  // effect and fired a fresh six-dice roll UNDERNEATH the summary the recovery
  // had just opened. The effect consults neither showSummary nor stopped, so a
  // busting roll would then take the whole banked chain and record a bust.
  const stopDrawSnapshot = {
    turnScore: 1800,
    keptDice: [],
    currentRoll: [],
    kniffelProgress: [],
    tuttosThisTurn: 1,
    busted: false,
    stopped: false,
    // The drawn Stop is the chain's last card, exactly as the live forfeit
    // path records it — the recovery pops it back off when the draw turns out
    // to have been discarded.
    cardsThisTurn: ['300', 'Stop'],
    chainTuttoCount: 1,
  };

  it('does not re-arm the opening roll when a discarded Stop draw reverts the card', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(stopDrawSnapshot));
    // Exactly one roll's worth. The roll is probed through this queue rather
    // than through the DOM: the summary covers the dice table, so the board a
    // stray roll produces is not rendered — which is precisely why the bug
    // survived. rollDie() drains the queue, so an untouched queue is the
    // evidence that no roll ran.
    queueRoll([2, 3, 4, 6, 6, 2]);
    const UNCONSUMED = 12; // 6 real values + 6 display values
    const onComplete = vi.fn();
    // onDrawCard is what makes this a chain turn — banksChainTotal, and so the
    // summary's "Bank N points" wording, is gated on it.
    const props = { ruleset: 'classic' as const, onComplete, onDrawCard: vi.fn() };

    const { rerender } = render(<DiceGame currentCard="Stop" {...props} />);
    expect(screen.getByText('dice.stop_card_drawn')).toBeInTheDocument();
    expect(rollQueue, 'restoring a decided turn rolls nothing').toHaveLength(UNCONSUMED);

    // The discarded push's revert: the store moves back to the card the draw
    // was made from.
    rerender(<DiceGame currentCard="300" {...props} />);

    // The defect: the flipped midDraw dep re-ran the opening-roll effect and
    // rolled six fresh dice underneath the summary.
    expect(rollQueue, 'the revert must not re-arm the opening roll').toHaveLength(UNCONSUMED);
    // And the recovery's own outcome is intact — the forfeit gave way to the
    // bank the turn had already committed.
    expect(screen.queryByText('dice.stop_card_drawn')).not.toBeInTheDocument();
    expect(screen.getByText('dice.bank_points')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.bank_points'));
    expect(onComplete).toHaveBeenLastCalledWith(1800, true, expect.objectContaining({
      cards: [{ card: '300', completed: true }],
      tuttoCount: 1,
      ended: 'banked',
    }));
  });

  it('still auto-rolls a genuine mid-draw resume, which is what the brake exists for', () => {
    // The other side of the same branch: an empty table that is NOT a decided
    // summary was snapshotted between drawing a chain card and its first roll,
    // and resuming it has to roll or the player gets a table with no dice and
    // no button that would put any there.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      ...stopDrawSnapshot,
      cardsThisTurn: ['300', '500'],
    }));
    queueRoll([1, 2, 3, 4, 6, 6]);

    render(<DiceGame currentCard="500" ruleset="classic" onComplete={vi.fn()} />);

    expect(screen.getAllByLabelText(/dice.die_showing/)).toHaveLength(6);
  });
});
