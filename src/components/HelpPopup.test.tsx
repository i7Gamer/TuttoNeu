import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import HelpPopup from './HelpPopup';
import { useGameStore } from '../store/useGameStore';
import { APP_VERSION } from '../utils/appVersion';

// Mock the dependencies
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

/** Where the AGPL §13 source offer in the footer has to point. */
const SOURCE_URL = 'https://github.com/i7Gamer/Tutto';

describe('HelpPopup', () => {
  // 'defaults to cards section...' and 'scrolls the specific highlighted
  // card...' below both set status/currentCard on the shared store and never
  // restore them. Without this reset, that leaks into every test that runs
  // after — most insidiously the 'section headers' tests further down, where
  // it silently swapped which section starts open.
  beforeEach(() => {
    useGameStore.setState({ status: 'lobby', currentCard: null });
  });

  it('has an aria-label on the help launcher for screen readers', () => {
    render(<HelpPopup />);
    expect(screen.getByTitle('help.buttonTitle')).toHaveAttribute('aria-label', 'help.buttonTitle');
  });

  it('renders closed by default and opens on click', async () => {
    render(<HelpPopup />);

    // Popup content should not be in document
    expect(screen.queryByText('help.title')).not.toBeInTheDocument();

    // Click the help button
    const button = screen.getByTitle('help.buttonTitle');
    fireEvent.click(button);

    // Popup content should now be visible
    expect(screen.getByText('help.title')).toBeInTheDocument();

    // The 'general' section should be open by default
    expect(screen.getByText('help.general.intro')).toBeInTheDocument();

    // Click close
    const closeBtn = screen.getByTitle('help.close');
    fireEvent.click(closeBtn);

    // Give time for exit animation (mocked usually, but waitFor is safer)
    await waitFor(() => {
      expect(screen.queryByText('help.title')).not.toBeInTheDocument();
    });
  });

  it('can toggle sections via table of contents', async () => {
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    // Click on FAQ in TOC
    const faqBtn = screen.getByText('help.toc.faq');
    fireEvent.click(faqBtn);

    // FAQ section content should become visible
    expect(screen.getByText('help.faq.q1')).toBeInTheDocument();
  });

  it('names the running build in the footer', () => {
    // The published image tags are `latest` and `nightly`, which do not say
    // which build is actually running. This is the only place that does.
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    expect(screen.getByTestId('help-app-version')).toHaveTextContent(APP_VERSION);
  });

  it('offers the source, which AGPL-3.0 obliges a network-facing copy to do', () => {
    // §13: whoever deploys a modified copy has to point its users at the
    // source, and this footer link is the app's only pointer — a fork that
    // never reads the README it did not ship has nothing else. It carried a
    // data-testid that nothing referenced, so the link, its destination and
    // its rel could all have been dropped by a footer refactor in silence.
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    const link = screen.getByTestId('help-source-link');
    expect(link).toHaveAttribute('href', SOURCE_URL);
    // target="_blank" without both tokens hands the opened tab a live
    // window.opener back into this one, and leaks the URL as a referrer.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')?.split(/\s+/)).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    );
  });

  it('documents how to get someone else into your room', () => {
    // Four ways to hand a room over and a remembered-rooms list, none of which
    // is self-explanatory from an icon button.
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    fireEvent.click(screen.getByText('help.toc.online'));

    expect(screen.getByText('help.online.inviteLink')).toBeInTheDocument();
    expect(screen.getByText('help.online.share')).toBeInTheDocument();
    expect(screen.getByText('help.online.qr')).toBeInTheDocument();
    expect(screen.getByText('help.online.scan')).toBeInTheDocument();
    expect(screen.getByText('help.online.recentRooms')).toBeInTheDocument();
  });

  it('documents the keyboard shortcuts, which have no on-screen hint of their own', () => {
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    fireEvent.click(screen.getByText('help.toc.shortcuts'));

    expect(screen.getByText('help.shortcuts.primary')).toBeInTheDocument();
    expect(screen.getByText('help.shortcuts.rollAgain')).toBeInTheDocument();
    expect(screen.getByText('help.shortcuts.stop')).toBeInTheDocument();
    expect(screen.getByText('help.shortcuts.selectAll')).toBeInTheDocument();
  });

  it('defaults to cards section if opened during gameplay and a card is active', async () => {
    useGameStore.setState({
      status: 'playing',
      currentCard: 'Feuerwerk',
    });

    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    // Cards section should be open (we can assert that fireworks title is rendered)
    await waitFor(() => {
      expect(screen.getByText('help.cards.fireworks')).toBeInTheDocument();
    });
  });

  it('scrolls the specific highlighted card into view, not just the section wrapper', () => {
    // Regression test: the section's own scrollIntoView only brought the
    // "Cards" section's wrapper into view — if the active card sits further
    // down that section, it could still be off-screen. The card itself must
    // be the element scrolled into view.
    useGameStore.setState({
      status: 'playing',
      currentCard: 'Feuerwerk',
    });

    const scrolledElements: Element[] = [];
    window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolledElements.push(this);
    };

    vi.useFakeTimers();
    try {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));

      act(() => {
        vi.advanceTimersByTime(400); // past HELP_SECTION_OPEN_ANIMATION_MS
      });

      const highlightedCard = screen.getByText('help.cards.fireworks').closest('div');
      expect(highlightedCard).not.toBeNull();
      expect(scrolledElements).toContain(highlightedCard);
    } finally {
      vi.useRealTimers();
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
  });

  describe('table of contents pills', () => {
    const openWiki = () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));
      return screen.getAllByTestId('help-toc-pill');
    };

    it('styles every pill through the same class, so none can drift from the rest', () => {
      // The pills used to carry a copy of the same utility string each; the
      // only thing that may differ between them is the selected/unselected
      // modifier.
      const pills = openWiki();
      expect(pills.length).toBeGreaterThan(1);

      const boxes = pills.map(pill =>
        [...pill.classList].filter(name => !name.startsWith('wiki-pill-')).sort().join(' ')
      );
      expect(new Set(boxes).size).toBe(1);
      expect(boxes[0]).toContain('wiki-pill');
    });

    it('marks only the selected pill as selected', () => {
      const pills = openWiki();

      expect(pills.filter(pill => pill.classList.contains('wiki-pill-active'))).toHaveLength(1);
    });

    it('marks the selected pill as current, not by colour alone', () => {
      // wiki-pill-active is a class: which chapter is showing was visible
      // information only.
      const pills = openWiki();

      const current = pills.filter(pill => pill.getAttribute('aria-current') === 'true');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveClass('wiki-pill-active');
    });

    it('does not let the row stretch its pills', () => {
      // The real assertion is the e2e one (e2e/wiki.spec.js) — jsdom has no
      // layout. This guards the cause: a wrapping flex row stretches items to
      // their own line's height, and the "Table of Contents:" label is taller
      // than a pill, so pills sharing its line came out bigger than wrapped
      // ones.
      const [firstPill] = openWiki();

      expect(firstPill.parentElement).toHaveClass('items-center');
    });
  });

  describe('modal accessibility (COMP-ISSUE-25/26)', () => {
    it('exposes dialog role, aria-modal, and a labelled title', () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      const labelledBy = dialog.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(labelledBy!)).toHaveTextContent('help.title');
    });

    it('gives the close button an accessible name beyond title alone', () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));

      expect(screen.getByRole('button', { name: 'help.close' })).toBeInTheDocument();
    });

    it('moves focus into the dialog on open and back to the trigger on close', async () => {
      render(<HelpPopup />);
      const openButton = screen.getByTitle('help.buttonTitle');
      fireEvent.click(openButton);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'help.close' })).toHaveFocus();
      });

      fireEvent.click(screen.getByRole('button', { name: 'help.close' }));

      await waitFor(() => {
        expect(openButton).toHaveFocus();
      });
    });

    it('closes on Escape', async () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });
  });

  // A scroller that hits its end hands the remaining gesture to the page
  // behind it (scroll chaining), so reaching the bottom of the wiki scrolled
  // the app underneath. `overscroll-contain` stops the handoff; it is
  // supported on iOS Safari 16+, which is where this is worst.
  //
  // Asserted as an invariant over every scroller this component renders
  // rather than one pinned element, so a scroller added later without it
  // fails here. jsdom resolves no stylesheet, so that the utility actually
  // computes to `contain` is pinned in e2e/styling.spec.ts.
  // The header was a plain button whose only open/closed cue was a swapped
  // icon with no accessible name — nothing announced the state, and nothing
  // tied the header to the panel it controls. Nothing was unreachable; what
  // was missing is state feedback (WCAG 4.1.2 Level A).
  describe('section headers report whether they are open', () => {
    const openWiki = () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));
    };

    const sectionHeaders = (): HTMLElement[] =>
      screen.getAllByRole('button').filter(b => b.hasAttribute('aria-expanded'));

    it('gives every section header an aria-expanded state', () => {
      openWiki();

      const headers = sectionHeaders();
      expect(headers.length, 'no section headers found — the selector has gone stale').toBeGreaterThan(0);
      for (const header of headers) {
        expect(['true', 'false']).toContain(header.getAttribute('aria-expanded'));
      }
    });

    it('opens a closed section and points at the panel it opened', () => {
      openWiki();
      const headers = sectionHeaders();
      const header = headers.find(h => h.getAttribute('aria-expanded') === 'false');
      expect(header, 'no closed section header found — the selector has gone stale').toBeTruthy();

      fireEvent.click(header!);

      expect(header!.getAttribute('aria-expanded')).toBe('true');
      const controls = header!.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      expect(document.getElementById(controls!)).toBeInTheDocument();
    });

    it('closes an open section', () => {
      openWiki();
      const headers = sectionHeaders();
      const header = headers.find(h => h.getAttribute('aria-expanded') === 'true');
      expect(header, 'no open section header found — the selector has gone stale').toBeTruthy();

      fireEvent.click(header!);

      expect(header!.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('contains overscroll on every scroller it renders', () => {
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));
    const scrollers = document.querySelectorAll('.overflow-y-auto');
    expect(scrollers.length, 'no scroller found — the selector has gone stale').toBeGreaterThan(0);
    scrollers.forEach(scroller => {
      expect(scroller.className, scroller.className).toContain('overscroll-contain');
    });
  });

});
