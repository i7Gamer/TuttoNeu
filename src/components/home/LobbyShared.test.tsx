import { render, screen, fireEvent, act } from '@testing-library/react';
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
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
// Mocked so AnimationsSettingSelector's tests control the OS preference
// directly instead of stubbing matchMedia — the hook itself is unit-tested on
// its own (usePrefersReducedMotion.test.ts).
vi.mock('../../hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: vi.fn(() => false),
}));
import { StartGameButton, PlayerList, AdvancedOptionsPanel, AdvancedOptionsToggle, HapticsSettingSelector, CustomGameBadge, RulesetSelector, RulesetBadge, DiceModeSelector, DiceModeEnforcedBadge, AudioSettingSelector, AnimationsSettingSelector } from './LobbyShared';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useGameStore } from '../../store/useGameStore';
import type { GameStore } from '../../store/useGameStore';
import { VALID_CARD_TYPES } from '../../utils/configValidation';
import { REORDER_PRESS_RELEASE_MS } from '../../utils/uiTimings';
import type { Player } from '../../types';
import { makePlayer, nonNull } from '../../testing/factories';

// AdvancedOptionsPanel subscribes to the store itself (no more `game` prop),
// so its tests stage state/action-spies with setState and restore the
// pristine snapshot afterwards.
const pristineStore = useGameStore.getState();
const stageStore = (partial: Partial<GameStore>) => useGameStore.setState(partial);

describe('StartGameButton', () => {
  it('renders "Start Game!" when not disabled and playersCount >= 2', () => {
    render(<StartGameButton startGame={() => {}} playersCount={2} disabled={false} />);
    expect(screen.getByText('lobby.startGame')).toBeInTheDocument();
  });

  it('renders "Need at least 2 players" when disabled and playersCount < 2', () => {
    render(<StartGameButton startGame={() => {}} playersCount={1} disabled={true} />);
    expect(screen.getByText('lobby.needAtLeast2Players')).toBeInTheDocument();
  });

  it('renders "Waiting for players to reconnect..." when disabled but playersCount >= 2', () => {
    render(<StartGameButton startGame={() => {}} playersCount={3} disabled={true} />);
    expect(screen.getByText('lobby.waitingForPlayersToReconnect')).toBeInTheDocument();
  });

  it('renders a custom disabledMessage instead of the default when provided', () => {
    render(<StartGameButton startGame={() => {}} playersCount={3} disabled={true} disabledMessage="Add at least one card to the deck" />);
    expect(screen.getByText('Add at least one card to the deck')).toBeInTheDocument();
    expect(screen.queryByText('lobby.waitingForPlayersToReconnect')).not.toBeInTheDocument();
  });

  it('does not render when playersCount is 0', () => {
    const { container } = render(<StartGameButton startGame={() => {}} playersCount={0} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('PlayerList', () => {
  const mockPlayers = [
    makePlayer({ name: 'Alice', color: '#ff0000', socketId: 'host1' }),
    makePlayer({ name: 'Bob', color: '#00ff00', socketId: 'client2' }),
    makePlayer({ name: 'Charlie', color: '#0000ff', socketId: 'client3' }),
  ];

  it('renders players and reorder buttons correctly for host', () => {
    const { container } = render(
      <PlayerList 
        players={mockPlayers} 
        reorderPlayers={() => {}} 
        isOnline={true} 
        isHost={true} 
        changeColor={() => {}} 
        onRemovePlayer={() => {}} 
      />
    );

    // Alice is the first player. She should only have a Down button (ChevronDown)
    // The up/down buttons are wrapped in a flex container `w-[68px]`
    const downButtons = container.querySelectorAll('.lucide-chevron-down');
    const upButtons = container.querySelectorAll('.lucide-chevron-up');

    // Since we now render all buttons to prevent focus shifting on mobile,
    // total up = 3, total down = 3
    expect(downButtons.length).toBe(3);
    expect(upButtons.length).toBe(3);
    
    // But the first Up button should be invisible
    expect(nonNull(upButtons[0].closest('button')).className).toContain('opacity-0');
    // And the last Down button should be invisible
    expect(nonNull(downButtons[2].closest('button')).className).toContain('opacity-0');
  });

  it('takes the invisible boundary reorder buttons out of the tab order via disabled', () => {
    const { container } = render(
      <PlayerList
        players={mockPlayers}
        reorderPlayers={() => {}}
        isOnline={true}
        isHost={true}
        changeColor={() => {}}
        onRemovePlayer={() => {}}
      />
    );

    const upButtons = [...container.querySelectorAll('.lucide-chevron-up')].map(i => i.closest('button'));
    const downButtons = [...container.querySelectorAll('.lucide-chevron-down')].map(i => i.closest('button'));

    // An aria-hidden element must not stay focusable — the invisible first-row
    // Up and last-row Down buttons are disabled, the visible ones are not.
    expect(upButtons[0]).toBeDisabled();
    expect(downButtons[2]).toBeDisabled();
    expect(upButtons[1]).not.toBeDisabled();
    expect(upButtons[2]).not.toBeDisabled();
    expect(downButtons[0]).not.toBeDisabled();
    expect(downButtons[1]).not.toBeDisabled();
  });

  it('renders flex div structure instead of table to avoid transform bugs', () => {
    const { container } = render(
      <PlayerList 
        players={mockPlayers} 
        reorderPlayers={() => {}} 
        isOnline={false} 
        isHost={true} 
        changeColor={() => {}} 
        onRemovePlayer={() => {}} 
      />
    );

    // Ensure there is no table element, only divs
    expect(container.querySelector('table')).toBeNull();

    // Check that we have motion.div wrappers for the rows
    const rows = screen.getAllByText(/Alice|Bob|Charlie/);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  // Every control in a row is an icon or a swatch — no text anywhere — so a
  // screen reader announced the whole roster as unlabelled buttons. The player
  // name is appended OUTSIDE t(): the unit i18n mock returns bare keys, so an
  // interpolated name would collapse to one identical string for every row and
  // the "which player" half could not be asserted at all.
  describe('accessible names', () => {
    const renderList = (isHost = true, isOnline = true) => render(
      <PlayerList
        players={mockPlayers}
        reorderPlayers={() => {}}
        isOnline={isOnline}
        isHost={isHost}
        hostId="host1"
        changeColor={() => {}}
        onRemovePlayer={() => {}}
      />
    );

    it('names the colour picker for the player it belongs to', () => {
      // Only the viewer's own row has one, and PlayerList has no myName prop —
      // offline every row is editable, which is the case with a picker to find.
      renderList(true, false);

      const pickers = screen.getAllByLabelText(/lobby\.playerColorLabel/);
      expect(pickers.length).toBe(mockPlayers.length);
      pickers.forEach(picker => expect(picker).toHaveAttribute('type', 'color'));
      expect(screen.getByLabelText('lobby.playerColorLabel Alice')).toBeInTheDocument();
    });

    it('names the move-up, move-down and remove buttons per player', () => {
      const { container } = renderList();

      const nameOf = (icon: string, i: number) =>
        [...container.querySelectorAll(icon)].map(el => el.closest('button'))[i]?.getAttribute('aria-label');

      expect(nameOf('.lucide-chevron-up', 1)).toBe('lobby.movePlayerUp Bob');
      expect(nameOf('.lucide-chevron-down', 0)).toBe('lobby.movePlayerDown Alice');
      // Alice holds hostId, so she has no kick button — index 0 is Bob.
      expect(nameOf('.lucide-user-minus', 0)).toBe('lobby.kickPlayer Bob');
    });

    // The name is also the tooltip: these are 32px icon buttons whose meaning
    // is not obvious to a sighted mouse user either.
    it('gives the same text as a hover title', () => {
      const { container } = renderList();

      const up = [...container.querySelectorAll('.lucide-chevron-up')][1].closest('button');
      expect(up).toHaveAttribute('title', up!.getAttribute('aria-label'));
    });

    // The invisible boundary buttons are aria-hidden and disabled already; a
    // name on them would be pointless but not harmful — what matters is that
    // labelling them did not accidentally take them back INTO the tab order.
    it('leaves the boundary buttons out of the tab order', () => {
      const { container } = renderList();

      const up = [...container.querySelectorAll('.lucide-chevron-up')].map(i => i.closest('button'));
      expect(up[0]).toBeDisabled();
      expect(up[0]).toHaveAttribute('aria-hidden', 'true');
    });
  });
});

describe('AdvancedOptionsToggle', () => {
  // aria-expanded says whether the panel is open; aria-controls names it, so
  // a screen reader user knows which element the toggle affects even though
  // it renders somewhere else in the tree (OnlineLobby's scanner toggle uses
  // the same aria-expanded pattern for its own collapsible panel).
  it('reflects the open state and names the panel it controls', () => {
    const { rerender } = render(
      <AdvancedOptionsToggle showAdvanced={false} setShowAdvanced={vi.fn()} panelId="advanced-panel-1" />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'advanced-panel-1');

    rerender(<AdvancedOptionsToggle showAdvanced={true} setShowAdvanced={vi.fn()} panelId="advanced-panel-1" />);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('AdvancedOptionsPanel', () => {
  // The id is what AdvancedOptionsToggle's aria-controls names — set here
  // rather than defaulted, since the two are rendered by separate lobbies
  // that generate the shared id themselves (useId).
  it('renders with the id its toggle would point aria-controls at', () => {
    const { container } = render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} id="advanced-panel-1" />);
    expect(container.querySelector('#advanced-panel-1')).not.toBeNull();
  });

  // BlurInput clamps to minVal/maxVal on commit, but consumed them itself and
  // rendered a bare <input type="number">: no native bounds, no spinner limits,
  // and nothing for a screen reader to announce the range from. The clamp is
  // still the authority — this only publishes it.
  it('publishes the range of every number input on the element itself', () => {
    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const numbers = screen.getAllByRole('spinbutton');
    expect(numbers.length).toBeGreaterThan(0);
    numbers.forEach(input => {
      expect(input, input.getAttribute('aria-label') ?? '').toHaveAttribute('min');
      expect(input).toHaveAttribute('max');
      // A range that reads backwards would make every value out of range.
      expect(Number(input.getAttribute('min')))
        .toBeLessThan(Number(input.getAttribute('max')));
    });
  });

  afterEach(() => {
    act(() => {
      useGameStore.setState(pristineStore, true);
    });
  });

  // lobby.zeroToDisable ("0 to disable") and lobby.disconnect ("(after
  // disconnect)") existed in both locale files but were never rendered
  // anywhere — nothing explained why typing 1-9 into the turn/kick timer
  // silently snaps to 10 (snapDisableableDuration, configValidation.ts), or
  // that the kick timer's clock only starts once a player actually
  // disconnects.
  it('renders the 0-to-disable hint under both timer inputs, and the disconnect hint under the kick timer', () => {
    stageStore({ turnDuration: 10, reconnectTimeout: 10, initialCards: {} });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    expect(screen.getAllByText('lobby.zeroToDisable')).toHaveLength(2);
    expect(screen.getByText('lobby.disconnect')).toBeInTheDocument();
  });

  it('does not render the timer hints for offline games, which have no online timers to explain', () => {
    stageStore({ initialCards: {} });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    expect(screen.queryByText('lobby.zeroToDisable')).not.toBeInTheDocument();
    expect(screen.queryByText('lobby.disconnect')).not.toBeInTheDocument();
  });

  it('updates card count using object syntax instead of functional update', () => {
    const mockSetInitialCards = vi.fn();
    stageStore({ initialCards: { Kleeblatt: 1, Stop: 10 }, setInitialCards: mockSetInitialCards });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    // Find the input for 'Kleeblatt'
    const input = screen.getByDisplayValue('1');
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);

    // It should be called with an object, not a function
    expect(mockSetInitialCards).toHaveBeenCalledWith({
      Kleeblatt: 2,
      Stop: 10
    });
  });
  describe('the Random Order toggle', () => {
    // It was a bare <div onClick>: no tabIndex, no key handler, no role and no
    // aria-checked, with its state carried by track colour and knob offset
    // alone. It is the ONLY call site of setRandomOrder, so a keyboard-only
    // host had no keystroke at all that could change the play order
    // (WCAG 2.1.1 Level A), and a screen reader could not read its state
    // (4.1.2 Level A). Every sibling row in the same grid is a real control.
    const renderToggle = (randomOrder: boolean, setRandomOrder = vi.fn()) => {
      stageStore({ randomOrder, setRandomOrder, initialCards: { Kleeblatt: 1 }, setInitialCards: vi.fn() });
      render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);
      return { setRandomOrder, toggle: screen.getByRole('switch', { name: /lobby.randomOrder/i }) };
    };

    it('exposes its state to assistive technology', () => {
      const { toggle } = renderToggle(true);
      expect(toggle).toHaveAttribute('aria-checked', 'true');

      act(() => { useGameStore.setState({ randomOrder: false }); });
      expect(screen.getByRole('switch', { name: /lobby.randomOrder/i })).toHaveAttribute('aria-checked', 'false');
    });

    it('is reachable and operable from the keyboard', async () => {
      const user = userEvent.setup();
      const { setRandomOrder, toggle } = renderToggle(true);

      toggle.focus();
      expect(toggle).toHaveFocus();

      await user.keyboard('{Enter}');
      expect(setRandomOrder).toHaveBeenCalledWith(false);

      await user.keyboard(' ');
      expect(setRandomOrder).toHaveBeenCalledTimes(2);
    });

    it('still toggles on click', () => {
      const { setRandomOrder, toggle } = renderToggle(false);
      fireEvent.click(toggle);
      expect(setRandomOrder).toHaveBeenCalledWith(true);
    });
  });

  it('offers a row for every card type, including ones the config has lost', () => {
    // validateOnlineConfig filters the deck entry-wise, so a corrupted saved
    // config can arrive missing card types. Rendering only the keys present
    // meant those cards had no input at all — unreachable except by resetting
    // the whole deck to defaults.
    stageStore({ initialCards: { Kleeblatt: 1, Stop: 10 }, setInitialCards: vi.fn() });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const grid = screen.getByTestId('deck-composition-grid');
    expect(grid.querySelectorAll('input')).toHaveLength(VALID_CARD_TYPES.length);
    // The absent ones read as the zero they effectively are.
    expect(screen.getByLabelText('Feuerwerk')).toHaveValue(0);
    expect(screen.getByLabelText('Kniffel')).toHaveValue(0);
  });

  it('can raise a card type the config had lost back above zero', () => {
    const mockSetInitialCards = vi.fn();
    stageStore({ initialCards: { Kleeblatt: 1, Stop: 10 }, setInitialCards: mockSetInitialCards });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const feuerwerk = screen.getByLabelText('Feuerwerk');
    fireEvent.change(feuerwerk, { target: { value: '4' } });
    fireEvent.blur(feuerwerk);

    // Merged onto what was there, not replacing it.
    expect(mockSetInitialCards).toHaveBeenCalledWith({ Kleeblatt: 1, Stop: 10, Feuerwerk: 4 });
  });

  it('lists the read-only deck by card type too, not by whatever keys survived', () => {
    stageStore({ initialCards: { Kleeblatt: 1, Stop: 10 } });

    const { container } = render(
      <AdvancedOptionsPanel showAdvanced={true} isOnline={true} readOnly={true} />
    );

    // Each chip is "<name>: <count>" with the count in its own element, so the
    // text is matched per chip rather than as one node.
    const chips = Array.from(container.querySelectorAll('span')).map(s => s.textContent);
    expect(chips).toContain('Feuerwerk: 0');
    expect(chips).toContain('Plus/Minus: 0');
    expect(chips).toContain('Kleeblatt: 1');
    expect(chips).toContain('Stop: 10');
  });

  it('shows the turn/kick timer chip value with the unit stated once, not doubled with the "(s)" label', () => {
    // The translation key behind the label already reads "Turn Timer (s)" /
    // "Kick Timer (s)" — the unit-suffixed test mock hides that here, but the
    // chip used to ALSO append a literal "s" to the value in JS
    // (`${turnDuration}s`), which is visible regardless of the mock and is
    // exactly the doubling this guards against.
    stageStore({ turnDuration: 120, reconnectTimeout: 60, initialCards: {} });

    const { container } = render(
      <AdvancedOptionsPanel showAdvanced={true} isOnline={true} readOnly={true} />
    );

    const chips = Array.from(container.querySelectorAll('span')).map(s => s.textContent);
    expect(chips.some(c => c?.includes('120s'))).toBe(false);
    expect(chips.some(c => c?.includes(': 120'))).toBe(true);
    expect(chips.some(c => c?.includes('60s'))).toBe(false);
    expect(chips.some(c => c?.includes(': 60'))).toBe(true);
  });

  it('reverts the displayed count when the store refuses the edit', () => {
    // Zeroing the LAST non-zero card type makes the deck unplayable, so
    // validateOnlineConfig drops initialCards entirely and the store keeps its
    // old value. The input had already committed "0" to its own local text and
    // never resynced (its `value` prop never changed), so the panel showed a
    // deck the game was not actually going to use.
    stageStore({ initialCards: { Kleeblatt: 1 } });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    const input = screen.getByDisplayValue('1');
    act(() => {
      fireEvent.change(input, { target: { value: '0' } });
      fireEvent.blur(input);
    });

    expect(useGameStore.getState().initialCards.Kleeblatt).toBe(1);
    expect(input).toHaveValue(1);
  });

  it('shows the committed count once the store accepts the edit', () => {
    stageStore({ initialCards: { Kleeblatt: 1, Stop: 10 } });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    const input = screen.getByDisplayValue('1');
    act(() => {
      fireEvent.change(input, { target: { value: '4' } });
      fireEvent.blur(input);
    });

    expect(useGameStore.getState().initialCards.Kleeblatt).toBe(4);
    expect(input).toHaveValue(4);
  });

  it('clamps negative winning scores up to the 1000 minimum the server accepts', () => {
    const mockSetWinningScore = vi.fn();
    stageStore({ winningScore: 6000, setWinningScore: mockSetWinningScore, initialCards: {} });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    const input = screen.getByDisplayValue('6000');
    fireEvent.change(input, { target: { value: '-10' } });
    fireEvent.blur(input);

    expect(mockSetWinningScore).toHaveBeenCalledWith(1000);
  });

  it('clamps a below-minimum winning score up to 1000 instead of sending a value the server rejects', () => {
    // isValidWinningScore requires >= 1000; the server's updateConfig silently
    // drops smaller values, which left the host seeing a different score than
    // everyone else. The input must never commit such a value.
    const mockSetWinningScore = vi.fn();
    stageStore({ winningScore: 6000, setWinningScore: mockSetWinningScore, initialCards: {} });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    const input = screen.getByDisplayValue('6000');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(mockSetWinningScore).toHaveBeenCalledWith(1000);
  });

  it('snaps a turn timer in the 1-9s gap up to the 10s minimum (0 stays disabled)', () => {
    // Valid turn durations are 0 (disabled) or 10..600 — a plain min/max clamp
    // can't express the hole, so 1-9 snaps up to 10 rather than being silently
    // rejected by the server.
    const mockSetTurnDuration = vi.fn();
    stageStore({
      winningScore: 6000, turnDuration: 120, setTurnDuration: mockSetTurnDuration,
      reconnectTimeout: 60, initialCards: {},
    });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const input = screen.getByDisplayValue('120');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(mockSetTurnDuration).toHaveBeenCalledWith(10);

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(mockSetTurnDuration).toHaveBeenCalledWith(0);
  });

  it('snaps a kick timer in the 1-9s gap up to the 10s minimum (0 stays disabled)', () => {
    const mockSetReconnectTimeout = vi.fn();
    stageStore({
      winningScore: 6000, turnDuration: 120,
      reconnectTimeout: 60, setReconnectTimeout: mockSetReconnectTimeout, initialCards: {},
    });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const input = screen.getByDisplayValue('60');
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    expect(mockSetReconnectTimeout).toHaveBeenCalledWith(10);

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(mockSetReconnectTimeout).toHaveBeenCalledWith(0);
  });

  it('clamps winningScore to 99999 when value exceeds the upper bound', () => {
    const mockSetWinningScore = vi.fn();
    stageStore({ winningScore: 6000, setWinningScore: mockSetWinningScore, initialCards: {} });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    const input = screen.getByDisplayValue('6000');
    fireEvent.change(input, { target: { value: '200000' } });
    fireEvent.blur(input);
    expect(mockSetWinningScore).toHaveBeenCalledWith(99999);
  });

  it('clamps turnDuration to 600 when value exceeds the upper bound', () => {
    const mockSetTurnDuration = vi.fn();
    stageStore({
      winningScore: 6000, turnDuration: 120, setTurnDuration: mockSetTurnDuration,
      reconnectTimeout: 60, initialCards: {},
    });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const input = screen.getByDisplayValue('120');
    fireEvent.change(input, { target: { value: '800' } });
    fireEvent.blur(input);
    expect(mockSetTurnDuration).toHaveBeenCalledWith(600);
  });

  it('clamps reconnectTimeout to 3600 when value exceeds the upper bound', () => {
    const mockSetReconnectTimeout = vi.fn();
    stageStore({
      winningScore: 6000, turnDuration: 120,
      reconnectTimeout: 60, setReconnectTimeout: mockSetReconnectTimeout, initialCards: {},
    });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const input = screen.getByDisplayValue('60');
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.blur(input);
    expect(mockSetReconnectTimeout).toHaveBeenCalledWith(3600);
  });

  it('does not trigger onValueChange on blur if the input was not modified', () => {
    const mockSetWinningScore = vi.fn();
    stageStore({
      winningScore: 6000, setWinningScore: mockSetWinningScore,
      turnDuration: 120, reconnectTimeout: 60, initialCards: {},
    });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    const input = screen.getByDisplayValue('6000');
    fireEvent.blur(input);
    // Should not be called because it was never changed
    expect(mockSetWinningScore).not.toHaveBeenCalled();
  });

  it('does not trigger onValueChange on unmount if input was not modified', () => {
    const mockSetWinningScore = vi.fn();
    stageStore({
      winningScore: 6000, setWinningScore: mockSetWinningScore,
      turnDuration: 120, reconnectTimeout: 60, initialCards: {},
    });

    const { unmount } = render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} />);

    unmount();
    // BlurInput should not call commit() during unmount since isDirty is false
    expect(mockSetWinningScore).not.toHaveBeenCalled();
  });

  it('calls onResetGeneralSettings when reset button is clicked', () => {
    const mockResetGeneralSettings = vi.fn();
    stageStore({
      winningScore: 5000, randomOrder: false, turnDuration: 300, reconnectTimeout: 120, initialCards: {},
    });

    render(
      <AdvancedOptionsPanel
        showAdvanced={true}
        isOnline={true}
        onResetGeneralSettings={mockResetGeneralSettings}
        onResetCards={vi.fn()}
      />
    );

    const resetButtons = screen.getAllByRole('button').filter(btn =>
      btn.title === 'lobby.resetGeneralSettings'
    );
    expect(resetButtons.length).toBeGreaterThan(0);
    fireEvent.click(resetButtons[0]);
    expect(mockResetGeneralSettings).toHaveBeenCalledOnce();
  });

  it('calls onResetCards when reset cards button is clicked', () => {
    const mockResetCards = vi.fn();
    stageStore({
      winningScore: 6000, randomOrder: true, initialCards: { Kleeblatt: 5, Stop: 20 },
    });

    render(
      <AdvancedOptionsPanel
        showAdvanced={true}
        isOnline={false}
        onResetGeneralSettings={vi.fn()}
        onResetCards={mockResetCards}
      />
    );

    const resetButtons = screen.getAllByRole('button').filter(btn =>
      btn.title === 'lobby.resetCardsInDeck'
    );
    expect(resetButtons.length).toBeGreaterThan(0);
    fireEvent.click(resetButtons[0]);
    expect(mockResetCards).toHaveBeenCalledOnce();
  });

  it('hides reset buttons when callbacks are not provided', () => {
    stageStore({ winningScore: 6000, randomOrder: true, initialCards: {} });

    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    // The keys, not the English: `t` is mocked to return the key it is given
    // (see the setup), so neither English string could ever appear and both
    // assertions passed in every state — including one where the buttons are
    // rendered. The sibling test above already queries by key.
    expect(screen.queryByTitle('lobby.resetGeneralSettings')).toBeNull();
    expect(screen.queryByTitle('lobby.resetCardsInDeck')).toBeNull();
  });
});

describe('HapticsSettingSelector', () => {
  it('exposes itself as a named group', () => {
    Object.defineProperty(navigator, 'vibrate', { value: vi.fn(), configurable: true });
    render(<HapticsSettingSelector hapticsEnabled={true} setHapticsEnabled={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'lobby.hapticsSetting' })).toBeInTheDocument();
  });

  afterEach(() => {
    // @ts-expect-error test-only cleanup of a jsdom-absent API
    delete navigator.vibrate;
    // @ts-expect-error test-only cleanup of a jsdom-absent API
    delete HTMLInputElement.prototype.switch;
  });

  it('renders the vibration toggle when the Vibration API is supported', () => {
    Object.defineProperty(navigator, 'vibrate', { value: vi.fn(), configurable: true });

    render(<HapticsSettingSelector hapticsEnabled={true} setHapticsEnabled={vi.fn()} />);

    expect(screen.getByText('lobby.hapticsOn')).toBeInTheDocument();
    expect(screen.getByText('lobby.hapticsOff')).toBeInTheDocument();
  });

  it('renders nothing on iOS even when the browser supports the switch-haptic fallback — disabled for now (IOS_SWITCH_HAPTIC_ENABLED)', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'switch', { value: true, configurable: true });

    const { container } = render(<HapticsSettingSelector hapticsEnabled={true} setHapticsEnabled={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when neither the Vibration API nor the iOS switch-haptic fallback is supported — a visible toggle would do nothing there', () => {
    const { container } = render(<HapticsSettingSelector hapticsEnabled={true} setHapticsEnabled={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });
});

describe('AnimationsSettingSelector', () => {
  afterEach(() => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(false);
  });

  it('renders nothing when the OS does not ask for reduced motion', () => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(false);

    const { container } = render(<AnimationsSettingSelector motionOverride={false} setMotionOverride={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders the toggle, named visibly, when the OS asks for reduced motion', () => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(true);

    render(<AnimationsSettingSelector motionOverride={false} setMotionOverride={vi.fn()} />);

    // "Follow system | Always on" alone never said what it followed: the
    // visible "Animations:" label is what names the setting (Option B of the
    // mockups Timo picked), the sr-only legend names the group.
    expect(screen.getByText('lobby.animationsSetting:')).toBeInTheDocument();
    expect(screen.getByText('lobby.animationsReduced')).toBeInTheDocument();
    expect(screen.getByText('lobby.animationsOn')).toBeInTheDocument();
  });

  it('explains the current choice in a hint line that changes with it', () => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(true);

    const { rerender } = render(<AnimationsSettingSelector motionOverride={false} setMotionOverride={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByText('lobby.animationsReducedDesc')).toBeInTheDocument();
    expect(screen.queryByText('lobby.animationsOnDesc')).not.toBeInTheDocument();

    rerender(<AnimationsSettingSelector motionOverride={true} setMotionOverride={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByText('lobby.animationsOnDesc')).toBeInTheDocument();
    expect(screen.queryByText('lobby.animationsReducedDesc')).not.toBeInTheDocument();
  });

  it('exposes itself as a named group', () => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(true);

    render(<AnimationsSettingSelector motionOverride={false} setMotionOverride={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'lobby.animationsSetting' })).toBeInTheDocument();
  });

  it('checks "Reduced" when motionOverride is false, and "On" when true', () => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(true);

    const { rerender } = render(<AnimationsSettingSelector motionOverride={false} setMotionOverride={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByText('lobby.animationsReduced').previousSibling).toHaveProperty('checked', true);
    expect(screen.getByText('lobby.animationsOn').previousSibling).toHaveProperty('checked', false);

    rerender(<AnimationsSettingSelector motionOverride={true} setMotionOverride={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByText('lobby.animationsReduced').previousSibling).toHaveProperty('checked', false);
    expect(screen.getByText('lobby.animationsOn').previousSibling).toHaveProperty('checked', true);
  });

  it('calls setMotionOverride(true)/(false) when the radios are clicked', () => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(true);
    const setMotionOverride = vi.fn();

    const { rerender } = render(<AnimationsSettingSelector motionOverride={false} setMotionOverride={setMotionOverride} nameSuffix="Test" />);

    fireEvent.click(screen.getByText('lobby.animationsOn'));
    expect(setMotionOverride).toHaveBeenCalledWith(true);

    // Rerender with the store's new value, as a real parent would after the
    // setter above runs — clicking an already-checked radio a second time
    // fires no onChange, same as DiceModeSelector's own toggle test.
    rerender(<AnimationsSettingSelector motionOverride={true} setMotionOverride={setMotionOverride} nameSuffix="Test" />);

    fireEvent.click(screen.getByText('lobby.animationsReduced'));
    expect(setMotionOverride).toHaveBeenCalledWith(false);
  });
});

describe('PlayerList win streak', () => {
  it('renders win streak badge for players with winStreak >= 3', () => {
    const players: Player[] = [
      makePlayer({ name: 'P1', winStreak: 3, socketId: '1', position: 0, deviceId: 'a', color: '#ff0000', disconnected: false }),
      makePlayer({ name: 'P2', winStreak: 2, socketId: '2', position: 1, deviceId: 'b', color: '#00ff00', disconnected: false }),
    ];
    render(
      <PlayerList 
        players={players} 
        reorderPlayers={vi.fn()} 
        isOnline={true} 
        myName="P1" 
        hostId="1" 
        isHost={true} 
        changeColor={vi.fn()} 
        onRemovePlayer={vi.fn()} 
      />
    );
    expect(screen.getByText('🔥 3')).toBeInTheDocument();
    expect(screen.queryByText('🔥 2')).not.toBeInTheDocument();
  });
});

describe('CustomGameBadge', () => {
  afterEach(() => {
    // act(), as in AdvancedOptionsPanel above: this hook runs before RTL
    // unmounts the badge, so the reset re-renders a still-mounted component.
    act(() => {
      useGameStore.setState(pristineStore, true);
    });
  });

  const badge = () => screen.queryByText('lobby.customGameNoStats');

  it('says nothing about the default configuration', () => {
    render(<CustomGameBadge />);
    expect(badge()).not.toBeInTheDocument();
  });

  it('warns about a changed winning score', () => {
    stageStore({ winningScore: 1000 });
    render(<CustomGameBadge />);
    expect(badge()).toBeInTheDocument();
  });

  it('warns about a changed deck', () => {
    stageStore({ initialCards: { ...pristineStore.initialCards, Kleeblatt: 42 } });
    render(<CustomGameBadge />);
    expect(badge()).toBeInTheDocument();
  });

  // The four settings a game may change and still count. Each is staged alone,
  // so a badge appearing here would mean the lobby is warning about a game
  // that will be recorded perfectly normally.
  it.each([
    ['the turn timer', { turnDuration: 0 }],
    ['the kick timer', { reconnectTimeout: 3600 }],
    ['the play order', { randomOrder: false }],
    ['an enforced dice mode', { enforcedDiceMode: 'physical' as const }],
  ])('stays quiet about %s', (_label, partial) => {
    stageStore(partial);
    render(<CustomGameBadge />);
    expect(badge()).not.toBeInTheDocument();
  });

  it('stays quiet about the classic ruleset (it has its own bucket, not "custom")', () => {
    stageStore({ ruleset: 'classic' });
    render(<CustomGameBadge />);
    expect(badge()).not.toBeInTheDocument();
  });
});

describe('RulesetSelector', () => {
  it('renders both options with the current one checked, plus its description', () => {
    render(<RulesetSelector ruleset="modernized" setRuleset={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByText('lobby.rulesetModernized')).toBeInTheDocument();
    expect(screen.getByText('lobby.rulesetClassic')).toBeInTheDocument();
    expect(screen.getByText('lobby.rulesetModernizedDesc')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it('calls setRuleset with the clicked rule set', () => {
    const setRuleset = vi.fn();
    render(<RulesetSelector ruleset="modernized" setRuleset={setRuleset} nameSuffix="Test" />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    fireEvent.click(radios[1]);
    expect(setRuleset).toHaveBeenCalledWith('classic');
  });

  it('shows the classic description when classic is selected', () => {
    render(<RulesetSelector ruleset="classic" setRuleset={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByText('lobby.rulesetClassicDesc')).toBeInTheDocument();
    expect(screen.queryByText('lobby.rulesetModernizedDesc')).not.toBeInTheDocument();
  });

  it('exposes itself as a named group', () => {
    render(<RulesetSelector ruleset="modernized" setRuleset={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByRole('group', { name: 'lobby.rulesetLabel' })).toBeInTheDocument();
  });
});

describe('RulesetBadge', () => {
  // Unlike DiceModeEnforcedBadge, this renders unconditionally — a room
  // always plays by some rule set, so guests must always see which.
  it('renders the room rule set read-only', () => {
    render(<RulesetBadge ruleset="classic" />);
    expect(screen.getByText('lobby.rulesetBadge')).toBeInTheDocument();
  });
});

describe('PlayerList reordering', () => {
  const three = [
    { name: 'Alice', color: '#ff0000', socketId: 'host1' },
    { name: 'Bob', color: '#00ff00', socketId: 'client2' },
    { name: 'Charlie', color: '#0000ff', socketId: 'client3' },
  ];

  const renderList = (reorderPlayers: (p: Player[]) => void) => render(
    <PlayerList
      players={three as Player[]}
      reorderPlayers={reorderPlayers}
      isOnline={false}
      isHost={true}
      changeColor={vi.fn()}
      onRemovePlayer={vi.fn()}
    />
  );

  const names = (spy: ReturnType<typeof vi.fn>) =>
    (spy.mock.calls[0][0] as Player[]).map(p => p.name);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('defers the swap by one press-release window, then applies it', () => {
    const reorder = vi.fn();
    renderList(reorder);

    fireEvent.click(screen.getByRole('button', { name: 'lobby.movePlayerDown Alice' }));

    // Not synchronous: the press must release (and its focus ring settle)
    // before the rows move under the pointer.
    expect(reorder).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(REORDER_PRESS_RELEASE_MS); });
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(names(reorder)).toEqual(['Bob', 'Alice', 'Charlie']);
  });

  it('moves a player up past the one above', () => {
    const reorder = vi.fn();
    renderList(reorder);

    fireEvent.click(screen.getByRole('button', { name: 'lobby.movePlayerUp Charlie' }));
    act(() => { vi.advanceTimersByTime(REORDER_PRESS_RELEASE_MS); });

    expect(names(reorder)).toEqual(['Alice', 'Charlie', 'Bob']);
  });

  it('applies only the last press inside the window — both were computed from the same roster', () => {
    // The spy never feeds the swap back into props, mirroring the real race:
    // the second press lands before the store has applied the first, so both
    // handlers computed from the SAME pre-swap roster. Applying both would
    // replay the earlier, stale one; last press wins instead.
    const reorder = vi.fn();
    renderList(reorder);

    fireEvent.click(screen.getByRole('button', { name: 'lobby.movePlayerDown Alice' }));
    act(() => { vi.advanceTimersByTime(10); });
    fireEvent.click(screen.getByRole('button', { name: 'lobby.movePlayerDown Bob' }));
    act(() => { vi.advanceTimersByTime(REORDER_PRESS_RELEASE_MS); });

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(names(reorder)).toEqual(['Alice', 'Charlie', 'Bob']);
  });

  it('drops a reorder still pending when the list unmounts', () => {
    const reorder = vi.fn();
    const { unmount } = renderList(reorder);

    fireEvent.click(screen.getByRole('button', { name: 'lobby.movePlayerDown Alice' }));
    unmount();
    act(() => { vi.advanceTimersByTime(REORDER_PRESS_RELEASE_MS * 2); });

    expect(reorder).not.toHaveBeenCalled();
  });
});

describe('PlayerList row actions', () => {
  const three = [
    { name: 'Alice', color: '#ff0000', socketId: 'host1' },
    { name: 'Bob', color: '#00ff00', socketId: 'client2' },
    { name: 'Charlie', color: '#0000ff', socketId: 'client3' },
  ];

  it('changes a player colour through their own picker, passing the player object', () => {
    const changeColor = vi.fn();
    render(
      <PlayerList players={three as Player[]} reorderPlayers={vi.fn()} isOnline={false}
        isHost={true} changeColor={changeColor} onRemovePlayer={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText('lobby.playerColorLabel Bob'), { target: { value: '#123456' } });

    expect(changeColor).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bob' }), '#123456');
  });

  it('shows white in the picker for a player with no colour yet', () => {
    render(
      <PlayerList players={[{ name: 'Nocolor' }] as Player[]} reorderPlayers={vi.fn()} isOnline={false}
        isHost={true} changeColor={vi.fn()} onRemovePlayer={vi.fn()} />
    );

    expect(screen.getByLabelText('lobby.playerColorLabel Nocolor')).toHaveValue('#ffffff');
  });

  // Kicking a live player from a room is not reversible the way reordering
  // or a colour change is — the same reason End Game/Leave/Undo confirm
  // (see GameControls.tsx) — so the row button now opens a confirm dialog
  // instead of kicking on the tap itself.
  it('kicks online only after the confirm dialog is accepted, passing the player object', async () => {
    const onRemovePlayer = vi.fn();
    render(
      <PlayerList players={three as Player[]} reorderPlayers={vi.fn()} isOnline={true}
        isHost={true} hostId="host1" myName="Alice" changeColor={vi.fn()} onRemovePlayer={onRemovePlayer} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'lobby.kickPlayer Bob' }));
    expect(onRemovePlayer).not.toHaveBeenCalled();
    expect(screen.getByText('lobby.kickConfirm')).toBeInTheDocument();

    fireEvent.click(screen.getByText('common.confirm'));
    expect(onRemovePlayer).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bob' }));
    expect(screen.queryByText('lobby.kickConfirm')).toBeNull();
  });

  it('cancelling the kick confirm dialog does not remove the player', async () => {
    const onRemovePlayer = vi.fn();
    render(
      <PlayerList players={three as Player[]} reorderPlayers={vi.fn()} isOnline={true}
        isHost={true} hostId="host1" myName="Alice" changeColor={vi.fn()} onRemovePlayer={onRemovePlayer} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'lobby.kickPlayer Bob' }));
    fireEvent.click(screen.getByText('common.cancel'));

    expect(onRemovePlayer).not.toHaveBeenCalled();
    expect(screen.queryByText('lobby.kickConfirm')).toBeNull();
  });

  it('removes offline through the trash button', () => {
    const onRemovePlayer = vi.fn();
    render(
      <PlayerList players={three as Player[]} reorderPlayers={vi.fn()} isOnline={false}
        isHost={true} changeColor={vi.fn()} onRemovePlayer={onRemovePlayer} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'lobby.removePlayer Charlie' }));

    expect(onRemovePlayer).toHaveBeenCalledWith(expect.objectContaining({ name: 'Charlie' }));
  });

  it('online, crowns the host row and offers a picker only on my own row', () => {
    const { container } = render(
      <PlayerList players={three as Player[]} reorderPlayers={vi.fn()} isOnline={true}
        isHost={false} hostId="host1" myName="Bob" changeColor={vi.fn()} onRemovePlayer={vi.fn()} />
    );

    const pickers = screen.getAllByLabelText(/lobby\.playerColorLabel/);
    expect(pickers).toHaveLength(1);
    expect(pickers[0]).toHaveAccessibleName('lobby.playerColorLabel Bob');
    expect(container.querySelectorAll('.lucide-crown')).toHaveLength(1);
  });
});

describe('PlayerList own-row highlight', () => {
  // bg-indigo-50/50 alone (no dark variant) rendered as a pale grey wash in
  // dark mode — the row highlighting the current user needs its own dark
  // reading, matching the row hover (dark:hover:bg-slate-700/60) and the
  // current-player row in Leaderboard (dark:bg-indigo-900/30).
  const three = [
    { name: 'Alice', color: '#ff0000', socketId: 'host1' },
    { name: 'Bob', color: '#00ff00', socketId: 'client2' },
  ];

  it("carries a dark: background utility on the current user's own online row", () => {
    render(
      <PlayerList players={three as Player[]} reorderPlayers={vi.fn()} isOnline={true}
        isHost={true} hostId="host1" myName="Alice" changeColor={vi.fn()} onRemovePlayer={vi.fn()} />
    );

    const ownRow = screen.getByText('Alice').closest('.border-b') as HTMLElement;
    expect(ownRow).not.toBeNull();
    expect(ownRow.className).toMatch(/dark:bg-/);
  });

  it("does not highlight another player's row", () => {
    render(
      <PlayerList players={three as Player[]} reorderPlayers={vi.fn()} isOnline={true}
        isHost={true} hostId="host1" myName="Alice" changeColor={vi.fn()} onRemovePlayer={vi.fn()} />
    );

    const otherRow = screen.getByText('Bob').closest('.border-b') as HTMLElement;
    expect(otherRow).not.toBeNull();
    expect(otherRow.className).not.toMatch(/dark:bg-/);
    expect(otherRow.className).not.toMatch(/bg-indigo-50\/50/);
  });
});

describe('PlayerList streak bucket', () => {
  afterEach(() => {
    act(() => { useGameStore.setState(pristineStore, true); });
  });

  const renderWith = (player: Partial<Player>) => render(
    <PlayerList players={[{ name: 'P1', color: '#ff0000', ...player }] as Player[]}
      reorderPlayers={vi.fn()} isOnline={false} isHost={true}
      changeColor={vi.fn()} onRemovePlayer={vi.fn()} />
  );

  it('shows the classic streak while the lobby is set to classic rules', () => {
    // The badge must follow the RULES SELECTOR, not always the modernized
    // bucket — flipping the selector flips which streak is on the line.
    stageStore({ ruleset: 'classic' });
    renderWith({ winStreak: 7, winStreakClassic: 4 });

    expect(screen.getByText('🔥 4')).toBeInTheDocument();
    expect(screen.queryByText('🔥 7')).not.toBeInTheDocument();
  });

  it('shows no badge when the selected bucket has no streak yet', () => {
    stageStore({ ruleset: 'classic' });
    renderWith({ winStreak: 5 });

    expect(screen.queryByText(/🔥/)).not.toBeInTheDocument();
  });
});

describe('DiceModeSelector', () => {
  it('switches to the clicked mode in both directions', () => {
    const setDiceMode = vi.fn();
    const { rerender } = render(<DiceModeSelector diceMode="digital" setDiceMode={setDiceMode} nameSuffix="Test" />);
    const radios = () => screen.getAllByRole('radio') as HTMLInputElement[];

    expect(radios()[0].checked).toBe(true);
    fireEvent.click(radios()[1]);
    expect(setDiceMode).toHaveBeenCalledWith('physical');

    rerender(<DiceModeSelector diceMode="physical" setDiceMode={setDiceMode} nameSuffix="Test" />);
    fireEvent.click(radios()[0]);
    expect(setDiceMode).toHaveBeenCalledWith('digital');
  });

  // A bare pair of <input type="radio"> with no shared name announces as two
  // unrelated controls; wrapping them in a <fieldset>/<legend> gives the pair
  // an accessible group name a screen reader can announce once.
  it('exposes itself as a named group', () => {
    render(<DiceModeSelector diceMode="digital" setDiceMode={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByRole('group', { name: 'lobby.diceMode' })).toBeInTheDocument();
  });
});

describe('AudioSettingSelector', () => {
  it('exposes itself as a named group', () => {
    render(<AudioSettingSelector audioEnabled={true} setAudioEnabled={vi.fn()} nameSuffix="Test" />);
    expect(screen.getByRole('group', { name: 'lobby.soundSetting' })).toBeInTheDocument();
  });

  it('switches between sound on and muted', () => {
    const setAudioEnabled = vi.fn();
    const { rerender } = render(<AudioSettingSelector audioEnabled={true} setAudioEnabled={setAudioEnabled} nameSuffix="Test" />);
    const radios = () => screen.getAllByRole('radio') as HTMLInputElement[];

    fireEvent.click(radios()[1]);
    expect(setAudioEnabled).toHaveBeenCalledWith(false);

    rerender(<AudioSettingSelector audioEnabled={false} setAudioEnabled={setAudioEnabled} nameSuffix="Test" />);
    fireEvent.click(radios()[0]);
    expect(setAudioEnabled).toHaveBeenCalledWith(true);
  });
});

describe('HapticsSettingSelector toggling', () => {
  afterEach(() => {
    // @ts-expect-error test-only cleanup of a jsdom-absent API
    delete navigator.vibrate;
  });

  it('switches between vibration on and off', () => {
    Object.defineProperty(navigator, 'vibrate', { value: vi.fn(), configurable: true });
    const setHapticsEnabled = vi.fn();
    const { rerender } = render(<HapticsSettingSelector hapticsEnabled={true} setHapticsEnabled={setHapticsEnabled} nameSuffix="Test" />);
    const radios = () => screen.getAllByRole('radio') as HTMLInputElement[];

    fireEvent.click(radios()[1]);
    expect(setHapticsEnabled).toHaveBeenCalledWith(false);

    rerender(<HapticsSettingSelector hapticsEnabled={false} setHapticsEnabled={setHapticsEnabled} nameSuffix="Test" />);
    fireEvent.click(radios()[0]);
    expect(setHapticsEnabled).toHaveBeenCalledWith(true);
  });
});

describe('RulesetSelector switching back', () => {
  it('calls setRuleset with modernized from a classic lobby', () => {
    const setRuleset = vi.fn();
    render(<RulesetSelector ruleset="classic" setRuleset={setRuleset} nameSuffix="Test" />);

    fireEvent.click((screen.getAllByRole('radio') as HTMLInputElement[])[0]);

    expect(setRuleset).toHaveBeenCalledWith('modernized');
  });
});

describe('DiceModeEnforcedBadge', () => {
  // The mode label is interpolated INSIDE t(...), so the bare-key i18n mock
  // collapses digital and physical to the same rendered string — which arm
  // produced the label is only assertable with real i18n (the e2e suite).
  // This is a render smoke over both arms, nothing more.
  it('renders for both enforced modes', () => {
    const { rerender } = render(<DiceModeEnforcedBadge enforcedDiceMode="physical" />);
    expect(screen.getByText('lobby.diceModeEnforcedBadge')).toBeInTheDocument();

    rerender(<DiceModeEnforcedBadge enforcedDiceMode="digital" />);
    expect(screen.getByText('lobby.diceModeEnforcedBadge')).toBeInTheDocument();
  });
});

describe('AdvancedOptionsPanel BlurInput edge commits', () => {
  afterEach(() => {
    act(() => { useGameStore.setState(pristineStore, true); });
  });

  it('falls back to the committed value when the typed text parses to nothing', () => {
    const setWinningScore = vi.fn();
    stageStore({ winningScore: 6000, setWinningScore, initialCards: {} });
    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    const input = screen.getByDisplayValue('6000');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    // parseInt('') is NaN — the field must revert, not commit NaN (which the
    // clamp would pass through: Math.min/max propagate NaN).
    expect(setWinningScore).not.toHaveBeenCalled();
    expect(input).toHaveValue(6000);
  });

  it('commits on Enter without waiting for a pointer blur', () => {
    const setWinningScore = vi.fn();
    stageStore({ winningScore: 6000, setWinningScore, initialCards: {} });
    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={false} />);

    const input = screen.getByDisplayValue('6000');
    act(() => { (input as HTMLInputElement).focus(); });
    fireEvent.change(input, { target: { value: '7000' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setWinningScore).toHaveBeenCalledWith(7000);
  });
});

describe('AdvancedOptionsPanel read-only chips', () => {
  afterEach(() => {
    act(() => { useGameStore.setState(pristineStore, true); });
  });

  it('spells out disabled timers, a fixed order and the enforced dice mode', () => {
    stageStore({
      turnDuration: 0, reconnectTimeout: 0, randomOrder: false,
      enforcedDiceMode: 'physical', initialCards: { Kleeblatt: 1 },
    });
    render(<AdvancedOptionsPanel showAdvanced={true} isOnline={true} readOnly={true} />);

    // Both zeroed timers read as disabled, not as "0s".
    expect(screen.getAllByText('common.disabled')).toHaveLength(2);
    expect(screen.getByText('game.controls.no')).toBeInTheDocument();
    // Unlike the badge above, the chip's mode label sits OUTSIDE the
    // interpolation, so the two arms stay distinguishable under the mock.
    expect(screen.getByText('lobby.physicalDice')).toBeInTheDocument();

    act(() => { useGameStore.setState({ enforcedDiceMode: 'digital' }); });
    expect(screen.getByText('lobby.digitalDice')).toBeInTheDocument();
  });
});
