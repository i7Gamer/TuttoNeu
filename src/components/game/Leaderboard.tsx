import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import ConfirmModal from '../ConfirmModal';
import { readableNameVars } from '../../utils/contrastColor';
import { formatInt } from '../../utils/formatNumber';
import { HOT_WIN_STREAK } from '../../utils/playerStats';
import type { Player } from '../../types';

export interface LeaderboardProps {
  /** Already ranked and tie-aware — see computeRankedPlayers. */
  sortedPlayers: Player[];
  /** Whose turn it is, for the highlighted row. Undefined between turns. */
  currentPlayerName: string | undefined;
  isOnline: boolean;
  isHost: boolean;
  hostId: string | null;
  /** Decides which of the two win streaks a badge may show. */
  isClassic: boolean;
  /** The goal footer is hidden entirely for an endless game (0). */
  winningScore: number;
  kickPlayer: (targetSocketId: string) => void;
}

/**
 * The standings table under the card and the controls: one row per player in
 * rank order, with the badges that describe them (host crown, hot streak,
 * disconnected) and — for the host of an online room — the pill that removes
 * a player who is not coming back.
 *
 * Pure over its props except for that one pill: the confirm it opens is state
 * nobody outside this table has any use for, so it lives here rather than in
 * Game. The dialog is a SIBLING of the card, not a child: the card animates
 * its own transform, and a transformed ancestor would make the dialog's
 * fixed-position backdrop lay itself out against the card instead of the
 * viewport.
 *
 * Memoized: every prop here is already a primitive, a store-owned reference
 * (kickPlayer), or built with useMemo in Game.tsx (sortedPlayers) — so this
 * bails out of the re-render Game does on every liveTurnState tick during a
 * roll (see HistoryLog.tsx for the same source).
 */
function Leaderboard({
  sortedPlayers,
  currentPlayerName,
  isOnline,
  isHost,
  hostId,
  isClassic,
  winningScore,
  kickPlayer,
}: LeaderboardProps) {
  const { t, i18n } = useTranslation();
  // Kicking a disconnected player mid-game is not reversible, so the pill
  // opens the same confirm dialog End Game/Leave/Undo use (ConfirmModal,
  // see GameControls.tsx) instead of kicking on the tap itself.
  const [pendingKick, setPendingKick] = useState<{ socketId: string; name: string } | null>(null);

  return (
    <>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="md:col-span-2 bg-white dark:bg-slate-800/80 sm:backdrop-blur-sm border border-white/40 rounded-3xl p-4 md:p-6 shadow-xl flex flex-col">
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 uppercase tracking-wider text-center">{t('game.leaderboard', 'Leaderboard')}</h3>
        <div className="flex flex-col rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800/40 overflow-hidden">
          <div className="flex px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-slate-700 bg-black/5 dark:bg-white/5">
            <div className="w-12">{t('game.pos', 'Pos')}</div>
            <div className="flex-1">{t('game.player', 'Player')}</div>
            <div className="w-24 text-right">{t('game.score', 'Score')}</div>
          </div>
          <div className="flex flex-col">
            {sortedPlayers.map(p => {
              const isCurrent = currentPlayerName !== undefined && p.name === currentPlayerName;
              return (
                <motion.div
                  layout
                  key={p.id ?? p.name}
                  className={`flex items-center px-4 py-3 border-b border-gray-50 dark:border-slate-700/50 last:border-0 transition-colors ${isCurrent ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'hover:bg-white/50 dark:hover:bg-slate-800/50'}`}
                >
                  <div className="w-12 font-medium text-gray-600 dark:text-gray-300">{p.position}.</div>
                  <div className="player-name flex-1 font-bold flex items-center flex-wrap gap-2" style={readableNameVars(p.color)}>
                    <span>{p.name}</span>
                    {isOnline && hostId === p.socketId && (
                      <span title={t('game.host', 'Host')} className="text-lg leading-none">
                        <span aria-hidden="true">👑</span>
                        <span className="sr-only">{t('game.host', 'Host')}</span>
                      </span>
                    )}
                    {(() => {
                      // The streak matching the rules this room plays by.
                      const streak = isClassic ? p.winStreakClassic : p.winStreak;
                      return streak !== undefined && streak >= HOT_WIN_STREAK && (
                        <span title={t('game.winStreakTitle', 'On a 🔥 {{streak}}-game win streak!', { streak })} className="text-amber-700 dark:text-amber-200 text-[10px] sm:text-xs font-bold bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 rounded-full border border-amber-100 dark:border-amber-900/50 flex items-center gap-0.5 whitespace-nowrap">
                          <span aria-hidden="true">🔥 {streak}</span>
                          <span className="sr-only">{t('game.winStreakTitle', 'On a 🔥 {{streak}}-game win streak!', { streak })}</span>
                        </span>
                      );
                    })()}
                    {p.disconnected && (
                      <>
                        <span className="text-red-500 text-[10px] sm:text-xs font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50 whitespace-nowrap">{t('game.disconnected', 'Disconnected')}</span>
                        {isOnline && isHost && (
                          <button
                            onClick={() => { if (p.socketId) setPendingKick({ socketId: p.socketId, name: p.name }); }}
                            // min-h-11 min-w-11: the 44px WCAG tap target
                            // (MIN_TAP_TARGET_PX, e2e/styling.spec.ts); -my-2
                            // gives the extra height back as negative margin
                            // so the row's own height doesn't grow with it.
                            // The button is a transparent hit area and the
                            // visible pill an inner span — styled directly,
                            // the 44px button WAS the pill (see the same fix
                            // on the EN/DE switch, LanguageSwitcher — that is
                            // also where U-1, the button's own focus ring
                            // hugging this invisible box instead of the
                            // pill, is fixed the same way: outline hidden on
                            // the button, group-focus-visible:ring-2 on the
                            // pill below).
                            className="group ml-1 min-h-11 min-w-11 flex items-center justify-center -my-2 focus-visible:outline-hidden"
                            title={t('game.kickPlayer', 'Kick Player')}
                          >
                            <span className="text-red-600 dark:text-red-400 group-hover:text-white group-hover:bg-red-500 dark:group-hover:bg-red-600 px-2 py-0.5 text-[10px] sm:text-xs font-semibold rounded-full border border-red-200 dark:border-red-800 group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 transition-colors shadow-xs">
                              {t('game.kick', 'Kick')}
                            </span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div className="w-24 font-bold text-gray-800 dark:text-gray-100 text-right">{formatInt(p.score, i18n.language)}</div>
                </motion.div>
              );
            })}
          </div>
        </div>
        {winningScore > 0 && (
          <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-white/5 p-3 rounded-xl border border-gray-100 dark:border-slate-700">
            {t('game.goalPrefix', 'Goal:')} <strong className="accent-number">{formatInt(winningScore, i18n.language)}</strong> {t('game.goalSuffix', 'points. The round is played to the end; a tie plays on.')}
            <span className="mx-1">·</span>
            {t('game.rulesetBadge', {
              defaultValue: '{{value}} rules',
              value: isClassic
                ? t('lobby.rulesetClassic', 'Classic')
                : t('lobby.rulesetModernized', 'Modernized'),
            })}
          </div>
        )}
      </motion.div>

      <ConfirmModal
        open={pendingKick !== null}
        danger
        message={t('lobby.kickConfirm', 'Kick {{name}} from the game?', { name: pendingKick?.name ?? '' })}
        onCancel={() => setPendingKick(null)}
        onConfirm={() => {
          if (pendingKick) kickPlayer(pendingKick.socketId);
          setPendingKick(null);
        }}
      />
    </>
  );
}

Leaderboard.displayName = 'Leaderboard';

export default memo(Leaderboard);
