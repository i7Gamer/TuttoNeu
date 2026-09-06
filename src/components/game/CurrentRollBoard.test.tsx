import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CurrentRollBoard from './CurrentRollBoard';

describe('CurrentRollBoard', () => {
  const dice = [{ id: 'a', val: 1, selected: true }, { id: 'b', val: 2, selected: false }];

  const baseProps = {
    displayRoll: dice,
    currentRoll: dice,
    rollingDiceIndices: new Set<string>(),
    bustState: false,
    isRolling: false,
    isSelectionLocked: false,
    hasRolled: true,
    selectionValid: true,
    selectedCount: 1,
    onToggleDie: vi.fn(),
    onSelectAllValid: vi.fn(),
  };

  it('offers Select all on a settled board and routes the click out', () => {
    const onSelectAllValid = vi.fn();
    render(<CurrentRollBoard {...baseProps} onSelectAllValid={onSelectAllValid} />);

    fireEvent.click(screen.getByText('dice.select_all_valid'));
    expect(onSelectAllValid).toHaveBeenCalledTimes(1);
  });

  // The 44px tap target (min-h-11) used to sit on the styled button, so the
  // chip itself was 44px tall — the same mistake the EN/DE pill had. The
  // button is a transparent hit area; the visible chip is an inner span.
  it('keeps the Select all chip its own size inside a 44px hit area', () => {
    render(<CurrentRollBoard {...baseProps} />);
    const chip = screen.getByText('dice.select_all_valid');
    const button = chip.closest('button')!;
    expect(chip.tagName).toBe('SPAN');
    expect(button).toHaveClass('min-h-11');
    expect(button.className).not.toMatch(/border|rounded|px-/);
    expect(chip.className).toMatch(/border/);
    expect(chip.className).toMatch(/rounded-md/);
  });

  // U-1 (see LanguageSwitcher.tsx): the button's own focus outline hugged the
  // invisible hit area, not the visible chip. The ring moves to the chip via
  // `group-focus-visible`, and the button hides its own outline.
  it('puts the keyboard focus ring on the Select all chip, not the hit area', () => {
    render(<CurrentRollBoard {...baseProps} />);
    const chip = screen.getByText('dice.select_all_valid');
    const button = chip.closest('button')!;
    expect(button).toHaveClass('group', 'focus-visible:outline-hidden');
    expect(chip).toHaveClass('group-focus-visible:ring-2', 'group-focus-visible:ring-indigo-500');
  });

  it('hides Select all while dice tumble and once the roll busted', () => {
    const { rerender } = render(<CurrentRollBoard {...baseProps} isRolling />);
    expect(screen.queryByText('dice.select_all_valid')).toBeNull();

    rerender(<CurrentRollBoard {...baseProps} bustState />);
    expect(screen.queryByText('dice.select_all_valid')).toBeNull();
  });

  it('keeps the invalid-selection line mounted and only toggles its visibility', () => {
    const { rerender } = render(<CurrentRollBoard {...baseProps} selectionValid={false} selectedCount={1} />);
    expect(screen.getByText('dice.invalid_selection')).not.toHaveClass('invisible');

    // Valid again: the reserved space stays, the message goes invisible.
    rerender(<CurrentRollBoard {...baseProps} selectionValid selectedCount={1} />);
    expect(screen.getByText('dice.invalid_selection')).toHaveClass('invisible');

    // Nothing selected at all reads as neutral, not as invalid.
    rerender(<CurrentRollBoard {...baseProps} selectionValid={false} selectedCount={0} />);
    expect(screen.getByText('dice.invalid_selection')).toHaveClass('invisible');
  });

  it('replaces the invalid-selection line with the bust banner on a bust', () => {
    render(<CurrentRollBoard {...baseProps} bustState />);

    expect(screen.getByText('dice.bust_description')).toBeInTheDocument();
    expect(screen.queryByText('dice.invalid_selection')).toBeNull();
  });

  // Losing the turn is the single most important thing that happens on this
  // board, and it was announced by colour alone.
  it('announces a bust assertively', () => {
    render(<CurrentRollBoard {...baseProps} bustState />);

    expect(screen.getByRole('alert')).toHaveTextContent('dice.bust_description');
  });

  // The live region is the always-mounted wrapper, not the message itself:
  // the message toggles `invisible` (and so leaves the accessibility tree),
  // and a region that appears at the same moment as its content is not
  // reliably announced.
  it('keeps a polite live region around the invalid-selection line', () => {
    const { rerender } = render(<CurrentRollBoard {...baseProps} selectionValid selectedCount={1} />);

    const region = screen.getByRole('status');
    expect(region).toContainElement(screen.getByText('dice.invalid_selection'));

    rerender(<CurrentRollBoard {...baseProps} selectionValid={false} selectedCount={1} />);
    expect(screen.getByRole('status')).toBe(region);
  });
});
