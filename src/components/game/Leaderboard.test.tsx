import { waitFor, render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import Leaderboard, { type LeaderboardProps } from './Leaderboard';
import { HOT_WIN_STREAK } from '../../utils/playerStats';
import { formatInt } from '../../utils/formatNumber';
import type { Player } from '../../types';

const HOST_SOCKET = 'socket-host';
const GUEST_SOCKET = 'socket-guest';
const WINNING_SCORE = 5000;
const ENDLESS = 0;

// Only the fields the table reads; the rest of Player is per-game counters it
// never looks at.
const player = (over: Partial<Player> & { name: string }): Player =>
  ({ score: 0, position: 1, ...over } as Player);

const props = (over: Partial<LeaderboardProps> = {}): LeaderboardProps => ({
  sortedPlayers: [
    player({ name: 'Ada', score: 900, position: 1, socketId: HOST_SOCKET }),
    player({ name: 'Grace', score: 300, position: 2, socketId: GUEST_SOCKET }),
  ],
  currentPlayerName: 'Ada',
  isOnline: true,
  isHost: true,
  hostId: HOST_SOCKET,
  isClassic: false,
  winningScore: WINNING_SCORE,
  kickPlayer: vi.fn(),
  ...over,
});

describe('Leaderboard', () => {
  it('lists the players in the rank order it is given, with their positions and scores', () => {
    const { container } = render(<Leaderboard {...props()} />);

    const names = Array.from(container.querySelectorAll('.player-name')).map(el => el.textContent);
    expect(names[0]).toContain('Ada');
    expect(names[1]).toContain('Grace');
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('2.')).toBeInTheDocument();
    expect(screen.getByText('900')).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
  });

  it('crowns the host, and only online', () => {
    render(<Leaderboard {...props()} />);
    expect(screen.getAllByText('game.host').length).toBeGreaterThan(0);
  });

  it('shows no crown in a local game, where there is no host to mark', () => {
    render(<Leaderboard {...props({ isOnline: false })} />);
    expect(screen.queryByText('game.host')).not.toBeInTheDocument();
  });

  it('badges a player who is on a hot streak under the rules being played', () => {
    render(<Leaderboard {...props({
      sortedPlayers: [player({ name: 'Ada', winStreak: HOT_WIN_STREAK, winStreakClassic: 0 })],
    })} />);

    expect(screen.getByText('game.winStreakTitle')).toBeInTheDocument();
  });

  it('reads the CLASSIC streak in a classic room, so a modernized streak earns no badge there', () => {
    const streaky = [player({ name: 'Ada', winStreak: HOT_WIN_STREAK, winStreakClassic: 0 })];

    render(<Leaderboard {...props({ isClassic: true, sortedPlayers: streaky })} />);

    expect(screen.queryByText('game.winStreakTitle')).not.toBeInTheDocument();
  });

  it('shows no badge one win short of the threshold', () => {
    render(<Leaderboard {...props({
      sortedPlayers: [player({ name: 'Ada', winStreak: HOT_WIN_STREAK - 1 })],
    })} />);

    expect(screen.queryByText('game.winStreakTitle')).not.toBeInTheDocument();
  });

  it('marks a disconnected player and offers the host a kick pill', () => {
    render(<Leaderboard {...props({
      sortedPlayers: [player({ name: 'Grace', socketId: GUEST_SOCKET, disconnected: true })],
    })} />);

    expect(screen.getByText('game.disconnected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'game.kick' })).toBeInTheDocument();
  });

  it('keeps the kick pill its own size inside a 44px hit area', () => {
    render(<Leaderboard {...props({
      sortedPlayers: [player({ name: 'Grace', socketId: GUEST_SOCKET, disconnected: true })],
    })} />);
    const button = screen.getByRole('button', { name: 'game.kick' });
    const pill = screen.getByText('game.kick');
    expect(pill.tagName).toBe('SPAN');
    expect(button).toHaveClass('min-h-11', 'min-w-11');
    expect(button.className).not.toMatch(/border|rounded-full|px-/);
    expect(pill.className).toMatch(/rounded-full/);
  });

  // U-1 (see LanguageSwitcher.tsx): the button's own focus outline hugged the
  // invisible hit area, not the visible pill. The ring moves to the pill via
  // `group-focus-visible`, and the button hides its own outline.
  it('puts the keyboard focus ring on the Kick pill, not the hit area', () => {
    render(<Leaderboard {...props({
      sortedPlayers: [player({ name: 'Grace', socketId: GUEST_SOCKET, disconnected: true })],
    })} />);
    const button = screen.getByRole('button', { name: 'game.kick' });
    const pill = screen.getByText('game.kick');
    expect(button).toHaveClass('group', 'focus-visible:outline-hidden');
    expect(pill).toHaveClass('group-focus-visible:ring-2', 'group-focus-visible:ring-indigo-500');
  });

  it('offers no kick pill to a non-host, even though the badge still shows', () => {
    render(<Leaderboard {...props({
      isHost: false,
      sortedPlayers: [player({ name: 'Grace', socketId: GUEST_SOCKET, disconnected: true })],
    })} />);

    expect(screen.getByText('game.disconnected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'game.kick' })).not.toBeInTheDocument();
  });

  it('offers no kick pill for a player who is still connected', () => {
    render(<Leaderboard {...props()} />);
    expect(screen.queryByRole('button', { name: 'game.kick' })).not.toBeInTheDocument();
  });

  it('asks before kicking, and kicks the socket it asked about', async () => {
    const kickPlayer = vi.fn();
    render(<Leaderboard {...props({
      kickPlayer,
      sortedPlayers: [player({ name: 'Grace', socketId: GUEST_SOCKET, disconnected: true })],
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'game.kick' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('lobby.kickConfirm')).toBeInTheDocument();
    expect(kickPlayer, 'the tap itself must not kick').not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));

    expect(kickPlayer).toHaveBeenCalledWith(GUEST_SOCKET);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('kicks nobody when the confirm is cancelled', async () => {
    const kickPlayer = vi.fn();
    render(<Leaderboard {...props({
      kickPlayer,
      sortedPlayers: [player({ name: 'Grace', socketId: GUEST_SOCKET, disconnected: true })],
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'game.kick' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'common.cancel' }));

    expect(kickPlayer).not.toHaveBeenCalled();
    // Awaited: the dialog fades out (ModalShell exit animation) before it leaves the DOM.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('shows the goal footer, with the target and the ruleset, for a game that has one', () => {
    // The footer is one run of interleaved text and markup, so it is read off
    // the rendered text rather than queried element by element.
    const { container } = render(<Leaderboard {...props()} />);

    expect(container.textContent).toContain('game.goalPrefix');
    // Grouped (en-US default in tests — see formatNumber.ts), not the raw digits.
    expect(screen.getByText(formatInt(WINNING_SCORE, 'en'))).toBeInTheDocument();
    expect(container.textContent).toContain('game.rulesetBadge');
  });

  it('hides the goal footer entirely for an endless game', () => {
    const { container } = render(<Leaderboard {...props({ winningScore: ENDLESS })} />);

    expect(container.textContent).not.toContain('game.goalPrefix');
    expect(container.textContent).not.toContain('game.rulesetBadge');
  });
});
