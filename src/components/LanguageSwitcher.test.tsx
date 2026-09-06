import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import LanguageSwitcher from './LanguageSwitcher';
import { useTranslation } from 'react-i18next';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual('react-i18next');
  return {
    ...actual,
    useTranslation: vi.fn(),
  };
});

// The aria-labels go through t(key, defaultValue) — return the default so the
// assertions below keep checking the human-readable label.
const tMock = (_key: string, defaultValue?: string) => defaultValue ?? _key;

// The real useTranslation() return type carries a branded TFunction and a
// 30+-member i18n instance; LanguageSwitcher only ever reads t, i18n.language
// and i18n.changeLanguage. Threading a minimal stand-in through unknown once
// here, rather than fabricating (or `any`-ing away) the rest of i18next's
// surface, is what "type it as unknown at the boundary" means for a
// third-party hook whose full shape isn't the thing under test.
const mockUseTranslation = (i18n: { language: string; changeLanguage: (lng: string) => void }) => {
  vi.mocked(useTranslation).mockReturnValue({ t: tMock, i18n } as unknown as ReturnType<typeof useTranslation>);
};

describe('LanguageSwitcher', () => {
  it('renders correctly and switches language', () => {
    const changeLanguageMock = vi.fn();
    mockUseTranslation({ language: 'en', changeLanguage: changeLanguageMock });

    render(<LanguageSwitcher />);

    // Should display language options or toggle
    const deButton = screen.getByText('DE');
    expect(deButton).toBeInTheDocument();

    const enButton = screen.getByText('EN');
    expect(enButton).toBeInTheDocument();

    // Click to switch to German
    fireEvent.click(deButton);
    expect(changeLanguageMock).toHaveBeenCalledWith('de');
  });

  it('exposes aria-label and aria-pressed reflecting the active language (COMP-ISSUE-37)', () => {
    mockUseTranslation({ language: 'en', changeLanguage: vi.fn() });

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole('button', { name: 'Switch to English' });
    const deButton = screen.getByRole('button', { name: 'Switch to German' });
    expect(enButton).toHaveAttribute('aria-pressed', 'true');
    expect(deButton).toHaveAttribute('aria-pressed', 'false');
  });

  // B3: the button carries min-h-11/min-w-11 (the 44px tap target,
  // e2e/styling.spec.ts "tap targets >= 44px") but the visible pill
  // (background, shadow, rounded corners) must live on an inner span — a
  // ~36px pill styled directly on the 44px button stuck out top and bottom
  // of its container. The button stays a transparent hit area only.
  it('puts the tap target on the button and the visible pill styling on an inner span', () => {
    mockUseTranslation({ language: 'en', changeLanguage: vi.fn() });

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole('button', { name: 'Switch to English' });
    const deButton = screen.getByRole('button', { name: 'Switch to German' });

    // Both buttons keep the 44px tap target and stay visually transparent —
    // no pill background/shadow/rounding on the button itself.
    for (const button of [enButton, deButton]) {
      expect(button).toHaveClass('min-h-11', 'min-w-11');
      expect(button.className).not.toMatch(/bg-white|shadow-xs|rounded-md/);
    }

    // The selected (EN) pill's visible styling lives on an inner span.
    const enPill = screen.getByText('EN');
    expect(enPill.tagName).toBe('SPAN');
    expect(enPill).toHaveClass('bg-white', 'dark:bg-slate-700', 'shadow-xs', 'rounded-md', 'px-3', 'py-1');
    expect(enButton).toContainElement(enPill);

    // The unselected (DE) pill has no selected-state classes.
    const dePill = screen.getByText('DE');
    expect(dePill.tagName).toBe('SPAN');
    expect(dePill.className).not.toMatch(/bg-white|shadow-xs/);
    expect(deButton).toContainElement(dePill);
  });

  // U-1: the button is a transparent 44px hit area, so the browser's own
  // focus outline drew around the invisible box instead of the visible pill.
  // The button hides its own outline and the pill (span) carries the ring
  // instead, driven by the button's :focus-visible via the `group` class.
  it('puts the keyboard focus ring on the pill, not the transparent hit area', () => {
    mockUseTranslation({ language: 'en', changeLanguage: vi.fn() });

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole('button', { name: 'Switch to English' });
    const deButton = screen.getByRole('button', { name: 'Switch to German' });
    for (const button of [enButton, deButton]) {
      expect(button).toHaveClass('group', 'focus-visible:outline-hidden');
    }

    const enPill = screen.getByText('EN');
    const dePill = screen.getByText('DE');
    for (const pill of [enPill, dePill]) {
      expect(pill).toHaveClass('group-focus-visible:ring-2', 'group-focus-visible:ring-indigo-500');
    }
  });
});
