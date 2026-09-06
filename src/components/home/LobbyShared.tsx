import { useState, useEffect, useRef } from 'react';
import type { InputHTMLAttributes, KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Play, ChevronUp, ChevronDown, Trash2, UserMinus, Crown, RotateCcw, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MIN_WINNING_SCORE, MAX_WINNING_SCORE, MAX_TURN_DURATION, MAX_RECONNECT_TIMEOUT,
  MIN_ENABLED_TURN_DURATION, MIN_ENABLED_RECONNECT_TIMEOUT, MAX_CARD_COUNT,
  snapDisableableDuration, isNormalizedConfig, VALID_CARD_TYPES,
} from '../../utils/configValidation';
import type { Player, CardType, DiceMode, Ruleset } from '../../types';
import { useShallow } from 'zustand/react/shallow';
import { useGameStore } from '../../store/useGameStore';
import { readableNameVars } from '../../utils/contrastColor';
import { supportsIOSSwitchHaptic } from '../../utils/iosSwitchHaptic';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { REORDER_PRESS_RELEASE_MS } from '../../utils/uiTimings';
import { HOT_WIN_STREAK } from '../../utils/playerStats';
import ConfirmModal from '../ConfirmModal';
import './LobbyShared.css';

interface PlayerListProps {
  players: Player[];
  reorderPlayers: (players: Player[]) => void;
  isOnline?: boolean;
  myName?: string | null;
  hostId?: string | null;
  isHost?: boolean;
  changeColor: (p: Player, color: string) => void;
  onRemovePlayer: (p: Player) => void;
}

export function PlayerList({
  players,
  reorderPlayers,
  isOnline = false,
  myName = null,
  hostId = null,
  isHost = true,
  changeColor,
  onRemovePlayer,
}: PlayerListProps) {
  const { t } = useTranslation();
  // The streak badge shows the bucket matching the rules this lobby is set
  // to — flipping the selector flips the badges with it.
  const ruleset = useGameStore((s) => s.ruleset);

  // The reorder is deferred (together with the blur() in the onClick
  // handlers) — see REORDER_PRESS_RELEASE_MS for why. Only one deferred
  // reorder is ever pending: two presses inside the window would both have
  // been computed from the same pre-swap roster, so applying both would just
  // replay the earlier, stale one — last press wins instead.
  const pendingReorderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingReorderTimer.current), []);

  // Kicking a connected player out of a live room is not reversible the way
  // reordering or a colour change is — the same reason End Game/Leave/Undo
  // confirm (see GameControls.tsx) — so an online kick opens this dialog
  // instead of firing on the tap itself. Removing a not-yet-joined local
  // player (isOnline false) stays a direct tap: there is no room to be
  // kicked from, only a name typed a moment ago.
  const [pendingKick, setPendingKick] = useState<Player | null>(null);

  const deferReorder = (newPlayers: Player[]) => {
    if (!reorderPlayers) return;
    clearTimeout(pendingReorderTimer.current);
    pendingReorderTimer.current = setTimeout(() => reorderPlayers(newPlayers), REORDER_PRESS_RELEASE_MS);
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const newPlayers = [...players];
    [newPlayers[index - 1], newPlayers[index]] = [newPlayers[index], newPlayers[index - 1]];
    deferReorder(newPlayers);
  };

  const handleMoveDown = (index: number) => {
    if (index === players.length - 1) return;
    const newPlayers = [...players];
    [newPlayers[index + 1], newPlayers[index]] = [newPlayers[index], newPlayers[index + 1]];
    deferReorder(newPlayers);
  };

  if (!players || players.length === 0) return null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="bg-white dark:bg-slate-800/40 rounded-xl overflow-hidden mb-6 border border-gray-100 dark:border-slate-700"
      >
        <div className="w-full flex flex-col">
          <AnimatePresence>
            {players.map((p, idx) => {
              const isMe = isOnline ? p.name === myName : true;
              const streak = ruleset === 'classic' ? p.winStreakClassic : p.winStreak;
              return (
                <motion.div
                  key={p.id ?? p.name}
                  layout
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className={`flex items-center justify-between p-3 border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-indigo-50 dark:hover:bg-slate-700/60 transition-colors ${isOnline && isMe ? 'bg-indigo-50/50 dark:bg-indigo-900/30' : ''}`}
                >
                  <div className="player-name font-semibold flex items-center gap-2" style={readableNameVars(p.color)}>
                    {isMe ? (
                      <input
                        type="color"
                        /* The player name rides OUTSIDE t(): every one of these
                           labels names a specific row, and an interpolated name
                           collapses to one identical string under the unit i18n
                           mock — the same reason the recent-rooms remove button
                           builds its label this way. */
                        aria-label={`${t('lobby.playerColorLabel', 'Color for:')} ${p.name}`}
                        title={`${t('lobby.playerColorLabel', 'Color for:')} ${p.name}`}
                        value={p.color || '#ffffff'}
                        onChange={(e) => changeColor(p, e.target.value)}
                        className={`w-6 h-6 p-0 border-0 bg-transparent align-middle cursor-pointer ${!isOnline ? 'mr-1' : ''}`}
                      />
                    ) : (
                      <span className="inline-block w-4 h-4 rounded-full shadow-xs border border-black/10" style={{ backgroundColor: p.color || '#ffffff' }} />
                    )}
                    {p.name}
                    {isOnline && p.socketId === hostId && <Crown size={16} className="text-amber-500" />}
                    {streak !== undefined && streak >= HOT_WIN_STREAK && (
                      <span title={t('lobby.winStreakTitle', 'On a 🔥 {{streak}}-game win streak!', { streak })} className="text-amber-700 dark:text-amber-200 text-xs font-bold bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 rounded-full border border-amber-100 dark:border-amber-900/50 flex items-center gap-0.5 whitespace-nowrap">
                        🔥 {streak}
                      </span>
                    )}
                    {p.disconnected && <span className="text-red-500 text-xs ml-1 font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50">{t('lobby.disconnected', 'Disconnected')}</span>}
                  </div>
                  <div className="whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1">
                      {isHost && (
                        <div className="w-[68px] flex items-center justify-center gap-1">
                          {/* disabled accompanies aria-hidden: an aria-hidden element
                              must not stay focusable (WCAG) — without it, a keyboard
                              user can Tab onto an invisible (opacity-0) button. */}
                          {/* min-h-11 (phone only — sm:h-8 reverts to the fixed
                              32px square a mouse pointer needs no larger) grows
                              the tap target to the 44px WCAG minimum
                              (MIN_TAP_TARGET_PX, e2e/styling.spec.ts); these
                              were 32px. -my-1.5 (cancelled by sm:my-0 on larger
                              screens) gives the added height back as negative
                              margin so a 5-player lobby still fits at 375x812
                              without new scrolling — the row's own height is
                              unchanged, only the overflow into its existing
                              padding grows. */}
                          <button
                            className={`text-gray-500 dark:text-gray-400 w-8 min-h-11 sm:h-8 -my-1.5 sm:my-0 flex items-center justify-center rounded-sm transition-colors ${idx === 0 ? 'opacity-0' : 'hover:bg-gray-100 active:bg-gray-200 dark:hover:bg-slate-700 dark:active:bg-slate-600'}`}
                            onClick={(e) => { e.currentTarget.blur(); if (idx > 0) handleMoveUp(idx); }}
                            aria-label={`${t('lobby.movePlayerUp', 'Move up:')} ${p.name}`}
                            title={`${t('lobby.movePlayerUp', 'Move up:')} ${p.name}`}
                            aria-hidden={idx === 0}
                            disabled={idx === 0}
                          >
                            <ChevronUp size={18} />
                          </button>
                          <button
                            className={`text-gray-500 dark:text-gray-400 w-8 min-h-11 sm:h-8 -my-1.5 sm:my-0 flex items-center justify-center rounded-sm transition-colors ${idx === players.length - 1 ? 'opacity-0' : 'hover:bg-gray-100 active:bg-gray-200 dark:hover:bg-slate-700 dark:active:bg-slate-600'}`}
                            onClick={(e) => { e.currentTarget.blur(); if (idx < players.length - 1) handleMoveDown(idx); }}
                            aria-label={`${t('lobby.movePlayerDown', 'Move down:')} ${p.name}`}
                            title={`${t('lobby.movePlayerDown', 'Move down:')} ${p.name}`}
                            aria-hidden={idx === players.length - 1}
                            disabled={idx === players.length - 1}
                          >
                            <ChevronDown size={18} />
                          </button>
                        </div>
                      )}
                      {/* Same phone-only min-h-11 / -my-1.5 treatment as the
                          reorder buttons above. The button STRETCHES to the
                          wrapper's cross axis (no items-center here): a
                          percentage h-full against a min-height parent never
                          resolves, and the button collapsed to its 18px icon. */}
                      <div className="w-8 min-h-11 sm:h-8 -my-1.5 sm:my-0 flex items-stretch justify-center ml-1">
                        {(!isOnline || (isHost && p.socketId !== hostId)) && (
                          <button
                            className="text-red-500 hover:bg-red-100 active:bg-red-200 dark:hover:bg-red-900/40 dark:active:bg-red-900/60 w-full flex items-center justify-center rounded-sm transition-colors"
                            aria-label={`${isOnline ? t('lobby.kickPlayer', 'Kick:') : t('lobby.removePlayer', 'Remove:')} ${p.name}`}
                            title={`${isOnline ? t('lobby.kickPlayer', 'Kick:') : t('lobby.removePlayer', 'Remove:')} ${p.name}`}
                            onClick={() => (isOnline ? setPendingKick(p) : onRemovePlayer(p))}
                          >
                            {isOnline ? <UserMinus size={18} /> : <Trash2 size={18} />}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </motion.div>
      <ConfirmModal
        open={pendingKick !== null}
        danger
        message={t('lobby.kickConfirm', 'Kick {{name}} from the game?', { name: pendingKick?.name ?? '' })}
        onCancel={() => setPendingKick(null)}
        onConfirm={() => {
          if (pendingKick) onRemovePlayer(pendingKick);
          setPendingKick(null);
        }}
      />
    </>
  );
}

interface DiceModeSelectorProps {
  diceMode: DiceMode;
  setDiceMode: (mode: DiceMode) => void;
  nameSuffix?: string;
}

export function DiceModeSelector({ diceMode, setDiceMode, nameSuffix = 'Lobby' }: DiceModeSelectorProps) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px] min-w-0 m-0">
      {/* sr-only: the option labels already read fine on their own, this
          legend only names the GROUP for a screen reader announcing it as
          one radio group rather than two unrelated buttons. */}
      <legend className="sr-only">{t('lobby.diceMode', 'Dice Mode')}</legend>
      <label className="radio-wrapper lobby-radio">
        <input type="radio" name={`diceMode${nameSuffix}`} checked={diceMode === 'digital'} onChange={() => setDiceMode('digital')} />
        <span className="font-medium">{t('lobby.digitalDice', 'Digital Dice')}</span>
      </label>
      <label className="radio-wrapper lobby-radio">
        <input type="radio" name={`diceMode${nameSuffix}`} checked={diceMode === 'physical'} onChange={() => setDiceMode('physical')} />
        <span className="font-medium">{t('lobby.physicalDice', 'Physical Dice')}</span>
      </label>
    </fieldset>
  );
}

interface EnforceDiceModeToggleProps {
  // The host's own current diceMode — becomes the value enforced for
  // everyone the moment the checkbox is checked (see setDiceMode in
  // configSlice.ts for how it keeps following the host's choice afterward).
  diceMode: DiceMode;
  enforcedDiceMode: DiceMode | null;
  setEnforcedDiceMode: (val: DiceMode | null) => void;
}

// Host-only control: renders nothing for non-host viewers. The read-only
// counterpart guests see instead (when enforcement is on) lives inline in
// OnlineLobby, next to where their own now-inert DiceModeSelector would be.
export function EnforceDiceModeToggle({ diceMode, enforcedDiceMode, setEnforcedDiceMode }: EnforceDiceModeToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px]">
      <label className="checkbox-wrapper text-gray-700 dark:text-gray-200">
        <input
          type="checkbox"
          checked={enforcedDiceMode !== null}
          onChange={(e) => setEnforcedDiceMode(e.target.checked ? diceMode : null)}
        />
        <span className="font-medium">{t('lobby.enforceDiceMode', 'Enforce dice mode for all players')}</span>
      </label>
    </div>
  );
}

interface DiceModeEnforcedBadgeProps {
  enforcedDiceMode: DiceMode;
}

// Read-only view shown to non-host players in place of their own
// DiceModeSelector once the host has pinned a mode — their personal
// preference no longer has any effect on gameplay, so the selector would be
// misleading rather than merely inert.
export function DiceModeEnforcedBadge({ enforcedDiceMode }: DiceModeEnforcedBadgeProps) {
  const { t } = useTranslation();
  const modeLabel = enforcedDiceMode === 'digital'
    ? t('lobby.digitalDice', 'Digital Dice')
    : t('lobby.physicalDice', 'Physical Dice');
  return (
    <div className="flex items-center justify-center gap-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-4 py-3 sm:px-6 rounded-xl border border-indigo-100 dark:border-indigo-800 h-full min-h-[50px] font-medium">
      {t('lobby.diceModeEnforcedBadge', 'Dice Mode: {{mode}} (set by host)', { mode: modeLabel })}
    </div>
  );
}

interface RulesetSelectorProps {
  ruleset: Ruleset;
  setRuleset: (val: Ruleset) => void;
  nameSuffix?: string;
}

// The rules choice changes gameplay fundamentally, so it gets its own always-
// visible row above the settings buttons rather than a slot inside the
// collapsed advanced panel. Host-only online — guests see RulesetBadge below.
export function RulesetSelector({ ruleset, setRuleset, nameSuffix = 'Lobby' }: RulesetSelectorProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 mb-4">
      <fieldset className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 m-0 p-0 border-0 min-w-0">
        {/* sr-only: "Rules" already reads visibly right beside the radios
            (below); the legend exists only so a screen reader announces this
            as one named group instead of two loose radios. */}
        <legend className="sr-only">{t('lobby.rulesetLabel', 'Rules')}</legend>
        <span aria-hidden="true" className="font-semibold text-gray-800 dark:text-gray-100">{t('lobby.rulesetLabel', 'Rules')}:</span>
        <label className="radio-wrapper lobby-radio">
          <input type="radio" name={`ruleset${nameSuffix}`} checked={ruleset === 'modernized'} onChange={() => setRuleset('modernized')} />
          <span className="font-medium">{t('lobby.rulesetModernized', 'Modernized')}</span>
        </label>
        <label className="radio-wrapper lobby-radio">
          <input type="radio" name={`ruleset${nameSuffix}`} checked={ruleset === 'classic'} onChange={() => setRuleset('classic')} />
          <span className="font-medium">{t('lobby.rulesetClassic', 'Classic')}</span>
        </label>
      </fieldset>
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
        {ruleset === 'classic'
          ? t('lobby.rulesetClassicDesc', 'Official rules: after a Tutto you may reveal another card and keep going — but a bust then loses everything.')
          : t('lobby.rulesetModernizedDesc', 'House rules: a completed card ends your turn and banks the points.')}
      </p>
    </div>
  );
}

// Read-only counterpart for non-host players. Always rendered (a room always
// plays by some rule set), unlike DiceModeEnforcedBadge above, which only
// exists while enforcement is active.
export function RulesetBadge({ ruleset }: { ruleset: Ruleset }) {
  const { t } = useTranslation();
  const label = ruleset === 'classic'
    ? t('lobby.rulesetClassic', 'Classic')
    : t('lobby.rulesetModernized', 'Modernized');
  return (
    <div className="flex items-center justify-center gap-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-4 py-3 rounded-xl border border-indigo-100 dark:border-indigo-800 mb-4 font-medium">
      {t('lobby.rulesetBadge', 'Rules: {{mode}} (set by host)', { mode: label })}
    </div>
  );
}

interface AudioSettingSelectorProps {
  audioEnabled: boolean;
  setAudioEnabled: (val: boolean) => void;
  nameSuffix?: string;
}

export function AudioSettingSelector({ audioEnabled, setAudioEnabled, nameSuffix = 'Lobby' }: AudioSettingSelectorProps) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px] min-w-0 m-0">
      {/* sr-only legend: names the pair as one group, as DiceModeSelector does. */}
      <legend className="sr-only">{t('lobby.soundSetting', 'Sound')}</legend>
      <label className="radio-wrapper lobby-radio">
        <input type="radio" name={`audioSetting${nameSuffix}`} checked={audioEnabled === true} onChange={() => setAudioEnabled(true)} />
        <span className="font-medium">{t('lobby.soundOn', 'Sound On')}</span>
      </label>
      <label className="radio-wrapper lobby-radio">
        <input type="radio" name={`audioSetting${nameSuffix}`} checked={audioEnabled === false} onChange={() => setAudioEnabled(false)} />
        <span className="font-medium">{t('lobby.muted', 'Muted')}</span>
      </label>
    </fieldset>
  );
}

interface HapticsSettingSelectorProps {
  hapticsEnabled: boolean;
  setHapticsEnabled: (val: boolean) => void;
  nameSuffix?: string;
}

export function HapticsSettingSelector({ hapticsEnabled, setHapticsEnabled, nameSuffix = 'Lobby' }: HapticsSettingSelectorProps) {
  const { t } = useTranslation();

  // iOS (Safari and every other browser there, all WebKit) has never
  // implemented the Vibration API, but supportsIOSSwitchHaptic() covers the
  // one working fallback there (see iosSwitchHaptic.ts). Hide the toggle
  // only when NEITHER path is available — otherwise it's a setting that
  // visibly exists but can never do anything, which just reads as broken.
  const hasVibrationSupport = typeof navigator !== 'undefined' && 'vibrate' in navigator;
  if (!hasVibrationSupport && !supportsIOSSwitchHaptic()) return null;

  return (
    <fieldset className="flex sm:hidden flex-wrap items-center justify-center gap-2 sm:gap-6 bg-white dark:bg-slate-800/50 px-3 py-2 sm:px-6 sm:py-3 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px] min-w-0 m-0">
      <legend className="sr-only">{t('lobby.hapticsSetting', 'Vibration')}</legend>
      <label className="radio-wrapper lobby-radio">
        <input type="radio" name={`hapticsSetting${nameSuffix}`} checked={hapticsEnabled === true} onChange={() => setHapticsEnabled(true)} />
        <span className="font-medium">{t('lobby.hapticsOn', 'Vibration On')}</span>
      </label>
      <label className="radio-wrapper lobby-radio">
        <input type="radio" name={`hapticsSetting${nameSuffix}`} checked={hapticsEnabled === false} onChange={() => setHapticsEnabled(false)} />
        <span className="font-medium">{t('lobby.hapticsOff', 'Vibration Off')}</span>
      </label>
    </fieldset>
  );
}

interface AnimationsSettingSelectorProps {
  motionOverride: boolean;
  setMotionOverride: (val: boolean) => void;
  nameSuffix?: string;
}

// Only meaningful — and only shown — on a device whose OS is currently asking
// for reduced motion: a player who never asked for that in the first place
// has nothing to override, and a visible toggle that does nothing would just
// read as broken (the same reasoning HapticsSettingSelector applies to
// unsupported vibration). See usePrefersReducedMotion.ts and App.tsx's
// <MotionConfig>/data-motion wiring for the two halves this flips.
export function AnimationsSettingSelector({ motionOverride, setMotionOverride, nameSuffix = 'Lobby' }: AnimationsSettingSelectorProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = usePrefersReducedMotion();

  if (!prefersReducedMotion) return null;

  // Laid out like RulesetSelector, not like the Sound pill: "Sound On |
  // Muted" explains itself, but "Follow system | Always on" never said what
  // it followed, so this one carries a visible "Animations:" label and a hint
  // line that spells out what the current choice does. The pill is taller
  // than its neighbours for it; the options row stretches its items, so the
  // others grow to match (Option B of the mockups Timo picked).
  return (
    <div className="flex flex-col items-center gap-2 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px] min-w-0">
      <fieldset className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 m-0 p-0 border-0 min-w-0">
        {/* sr-only legend + aria-hidden visible label, as RulesetSelector:
            the group is announced once, by the legend, and the visible word
            is not read a second time. */}
        <legend className="sr-only">{t('lobby.animationsSetting', 'Animations')}</legend>
        <span aria-hidden="true" className="font-semibold text-gray-800 dark:text-gray-100">{t('lobby.animationsSetting', 'Animations')}:</span>
        <label className="radio-wrapper lobby-radio">
          <input type="radio" name={`animationsSetting${nameSuffix}`} checked={motionOverride === false} onChange={() => setMotionOverride(false)} />
          <span className="font-medium">{t('lobby.animationsReduced', 'Reduced')}</span>
        </label>
        <label className="radio-wrapper lobby-radio">
          <input type="radio" name={`animationsSetting${nameSuffix}`} checked={motionOverride === true} onChange={() => setMotionOverride(true)} />
          <span className="font-medium">{t('lobby.animationsOn', 'On')}</span>
        </label>
      </fieldset>
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs text-balance">
        {motionOverride
          ? t('lobby.animationsOnDesc', 'On for Tutto only. Your device still asks other apps for less motion.')
          : t('lobby.animationsReducedDesc', 'Your device asks for less motion, so dice, cards and popups do not animate.')}
      </p>
    </div>
  );
}

interface AdvancedOptionsToggleProps {
  showAdvanced: boolean;
  setShowAdvanced: (val: boolean) => void;
  /** The id of the AdvancedOptionsPanel this toggle expands — generated by
   *  the caller with useId() and passed to both, same as OnlineLobby's
   *  scanner toggle names its own aria-expanded state. */
  panelId: string;
}

export function AdvancedOptionsToggle({ showAdvanced, setShowAdvanced, panelId }: AdvancedOptionsToggleProps) {
  const { t } = useTranslation();
  return (
    <button
      className="flex items-center justify-center gap-2 text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-800/50 hover:bg-gray-50 dark:hover:bg-slate-800 px-4 py-3 rounded-xl font-medium transition-colors border border-gray-200 dark:border-slate-600 h-full min-h-[50px]"
      onClick={() => setShowAdvanced(!showAdvanced)}
      aria-expanded={showAdvanced}
      aria-controls={panelId}
    >
      <Settings size={18} /> {showAdvanced ? t('lobby.hideAdvancedOptions', 'Hide Advanced Options') : t('lobby.showAdvancedOptions', 'Show Advanced Options')}
    </button>
  );
}

// Warns that the configured game will be recorded apart from everything else.
// Rendered next to the advanced-options toggle rather than inside the panel,
// so it is visible whether or not the settings are expanded — a player who
// never opens them still needs to know before the game starts.
//
// Deliberately used only by the online lobby: a local game records no
// statistics whatever its configuration, so here it would warn about a
// distinction that does not exist.
export function CustomGameBadge() {
  const { t } = useTranslation();
  const config = useGameStore(useShallow((s) => ({
    winningScore: s.winningScore,
    initialCards: s.initialCards,
  })));

  if (isNormalizedConfig(config)) return null;

  return (
    <div className="flex items-center justify-center gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 mb-4">
      <AlertTriangle size={16} className="shrink-0" />
      <span>{t('lobby.customGameNoStats', 'Custom game — this game will not count toward the statistics')}</span>
    </div>
  );
}

interface AdvancedOptionsPanelProps {
  showAdvanced: boolean;
  isOnline?: boolean;
  readOnly?: boolean;
  onResetGeneralSettings?: (() => void) | null;
  onResetCards?: (() => void) | null;
  /** Matches the AdvancedOptionsToggle's aria-controls, so the two are wired
   *  together for assistive tech even though they render in separate places. */
  id?: string;
}

interface BlurInputProps extends InputHTMLAttributes<HTMLInputElement> {
  value: number;
  onValueChange: (val: number) => void;
  minVal?: number;
  maxVal?: number;
  // Applied after clamping — for fields whose valid range has a hole that a
  // min/max pair can't express (e.g. the "0 = disabled, otherwise >= 10" timers).
  normalize?: (val: number) => number;
}

function BlurInput({ value, onValueChange, minVal = 0, maxVal = MAX_WINNING_SCORE, normalize, ...props }: BlurInputProps) {
  const [localValue, setLocalValue] = useState((value ?? 0).toString());
  const [prevValue, setPrevValue] = useState(value);
  const [isDirty, setIsDirty] = useState(false);

  // Synchronous render-time derived state (same pattern as GameControls): when
  // the committed value changes from outside (reset buttons, a server update),
  // adopt it and drop any uncommitted edit.
  if (value !== prevValue) {
    setPrevValue(value);
    setLocalValue((value ?? 0).toString());
    setIsDirty(false);
  }

  const commit = () => {
    if (!isDirty) return;
    let parsed = parseInt(localValue, 10);
    if (isNaN(parsed)) parsed = value ?? 0;
    const clamped = Math.min(maxVal, Math.max(minVal, parsed));
    const committed = normalize ? normalize(clamped) : clamped;
    setIsDirty(false);

    if (committed !== value) {
      onValueChange(committed);
    }
    // Fall back to the value the OWNER currently holds rather than optimistically
    // displaying `committed`. An accepted edit changes `value`, and the
    // render-time sync above then adopts it — but an owner may legitimately
    // refuse the write (zeroing the last non-zero card type leaves the deck
    // unplayable, so validateOnlineConfig drops initialCards outright), in which
    // case `value` never changes, the sync never fires, and the field would keep
    // showing a number the game isn't actually using.
    setLocalValue((value ?? 0).toString());
  };

  const handleBlur = () => commit();
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  return (
    <input
      {...props}
      // The bounds are published on the element, not just enforced in commit
      // above: without them the field is a bare number input — no native
      // spinner limits, and nothing for a screen reader to announce the range
      // from. commit() stays the authority (a pasted or typed value is clamped
      // there regardless), so this only tells the browser and AT what it is.
      // Spread AFTER {...props} so a caller cannot half-override the pair.
      min={minVal}
      max={maxVal}
      value={localValue}
      onChange={(e) => {
        setLocalValue(e.target.value);
        setIsDirty(true);
      }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}

export function AdvancedOptionsPanel({
  showAdvanced,
  isOnline = false,
  readOnly = false,
  onResetGeneralSettings = null,
  onResetCards = null,
  id,
}: AdvancedOptionsPanelProps) {
  const { t } = useTranslation();

  // Subscribes to its own config slice instead of receiving the whole store
  // as a prop from the lobbies (which forced them to drill it through).
  const {
    winningScore, setWinningScore, turnDuration, setTurnDuration,
    reconnectTimeout, setReconnectTimeout, randomOrder, setRandomOrder,
    enforcedDiceMode, initialCards, setInitialCards,
  } = useGameStore(useShallow((s) => ({
    winningScore: s.winningScore,
    setWinningScore: s.setWinningScore,
    turnDuration: s.turnDuration,
    setTurnDuration: s.setTurnDuration,
    reconnectTimeout: s.reconnectTimeout,
    setReconnectTimeout: s.setReconnectTimeout,
    randomOrder: s.randomOrder,
    setRandomOrder: s.setRandomOrder,
    enforcedDiceMode: s.enforcedDiceMode,
    initialCards: s.initialCards,
    setInitialCards: s.setInitialCards,
  })));

  const updateCardCount = (card: CardType, count: number) => {
    setInitialCards({ ...initialCards, [card]: count });
  };

  // Driven by the card-type list, not by whatever keys the config happens to
  // hold: validateOnlineConfig filters the deck entry-wise, so a corrupted
  // saved config can arrive missing types — and a type with no row has no way
  // back into the deck short of resetting the whole thing. An absent count
  // reads as the zero it effectively is. Also fixes the display order, which
  // followed the object's key order before.
  const deckRows = VALID_CARD_TYPES.map(card => ({ card, count: initialCards?.[card] ?? 0 }));

  return (
    <AnimatePresence>
      {showAdvanced && (
        <motion.div
          id={id}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden mb-8"
        >
          {readOnly ? (
            <div className="bg-white dark:bg-slate-800/40 p-3 sm:p-5 rounded-xl border border-gray-200 dark:border-slate-600">
              <div className="flex flex-wrap gap-2 mb-4">
                <span className="lobby-chip">
                  {t('lobby.winningScore', 'Winning Score')}: <strong>{winningScore}</strong>
                </span>
                {isOnline && (
                  <>
                    {/* The label itself already reads "Turn Timer (s)" / "Kick
                        Timer (s)" (same key the editable input uses below) —
                        the value must not also append a literal "s", or the
                        unit is stated twice ("Turn Timer (s): 120s"). */}
                    <span className="lobby-chip">
                      {t('lobby.turnTimer', 'Turn Timer (s)')}: <strong>{turnDuration > 0 ? turnDuration : t('common.disabled', 'Disabled')}</strong>
                    </span>
                    <span className="lobby-chip">
                      {t('lobby.kickTimer', 'Kick Timer (s)')}: <strong>{reconnectTimeout > 0 ? reconnectTimeout : t('common.disabled', 'Disabled')}</strong>
                    </span>
                  </>
                )}
                <span className="lobby-chip">
                  {t('lobby.randomOrder', 'Random Order')}: <strong>{randomOrder !== false ? t('game.controls.yes', 'Yes') : t('game.controls.no', 'No')}</strong>
                </span>
                {isOnline && enforcedDiceMode && (
                  <span className="lobby-chip">
                    {t('lobby.diceMode', 'Dice Mode')}: <strong>{enforcedDiceMode === 'digital' ? t('lobby.digitalDice', 'Digital Dice') : t('lobby.physicalDice', 'Physical Dice')}</strong>
                  </span>
                )}
              </div>
              <div className="pt-4 border-t border-gray-200 dark:border-slate-600">
                <h4 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t('lobby.cardsInDeck', 'Cards in Deck')}</h4>
                <div className="flex flex-wrap gap-2">
                  {deckRows.map(({ card, count }) => (
                    <span key={card} className="px-2.5 py-1 bg-gray-100 dark:bg-slate-700/50 text-gray-700 dark:text-gray-300 rounded-md text-sm font-medium border border-gray-200 dark:border-slate-600">
                      {card.replace('_', '/')}: <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800/40 p-3 sm:p-6 rounded-xl border border-gray-200 dark:border-slate-600">
              <div className="flex items-center justify-between mb-4">
                <h4 className="font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-slate-600 pb-2 flex-1">{t('lobby.generalSettings', 'General Settings')}</h4>
                {onResetGeneralSettings && (
                  <button
                    onClick={onResetGeneralSettings}
                    className="flex items-center p-1 rounded-sm hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400 transition-colors"
                    title={t('lobby.resetGeneralSettings', 'Reset General Settings to Default Values')}
                  >
                    <RotateCcw size={18} />
                    <span className="ml-1 text-xs font-medium inline">{t('lobby.defaultValues', 'default values')}</span>
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3 mb-6 items-stretch">
                <label className="lobby-row focus-within:ring-2 focus-within:ring-indigo-500 cursor-text">
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.winningScore', 'Winning Score')}</span>
                  <BlurInput
                    type="number" minVal={MIN_WINNING_SCORE} maxVal={MAX_WINNING_SCORE} inputMode="numeric" pattern="[0-9]*"
                    className="bg-transparent border-0 outline-hidden focus:outline-hidden focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium"
                    value={winningScore}
                    onValueChange={(val) => setWinningScore(val)}
                  />
                </label>
                {isOnline && (
                  <>
                    <div className="flex flex-col gap-1">
                      <label className="lobby-row focus-within:ring-2 focus-within:ring-indigo-500 cursor-text">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.turnTimer', 'Turn Timer (s)')}</span>
                        <BlurInput
                          type="number" minVal={0} maxVal={MAX_TURN_DURATION} inputMode="numeric" pattern="[0-9]*"
                          normalize={(val) => snapDisableableDuration(val, MIN_ENABLED_TURN_DURATION)}
                          className="bg-transparent border-0 outline-hidden focus:outline-hidden focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium"
                          value={turnDuration}
                          onValueChange={(val) => setTurnDuration(val)}
                          placeholder="0"
                        />
                      </label>
                      {/* Otherwise unexplained: a value below MIN_ENABLED_TURN_DURATION
                          (10) silently snaps up to it on blur (snapDisableableDuration,
                          configValidation.ts) — 0 is the one exception, which disables
                          the timer instead of snapping. */}
                      <span className="text-xs text-gray-500 dark:text-gray-400 px-1">{t('lobby.zeroToDisable', '0 to disable')}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="lobby-row focus-within:ring-2 focus-within:ring-indigo-500 cursor-text">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.kickTimer', 'Kick Timer (s)')}</span>
                        <BlurInput
                          type="number" minVal={0} maxVal={MAX_RECONNECT_TIMEOUT} inputMode="numeric" pattern="[0-9]*"
                          normalize={(val) => snapDisableableDuration(val, MIN_ENABLED_RECONNECT_TIMEOUT)}
                          className="bg-transparent border-0 outline-hidden focus:outline-hidden focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium"
                          value={reconnectTimeout}
                          onValueChange={(val) => setReconnectTimeout(val)}
                          placeholder="0"
                        />
                      </label>
                      {/* Same 0-disables / snap-to-10 rule as the turn timer, plus
                          the one thing "Kick Timer" alone doesn't say: the clock only
                          starts once a player actually disconnects, not from whenever
                          this is set. */}
                      <span className="text-xs text-gray-500 dark:text-gray-400 px-1 flex flex-wrap gap-x-1">
                        <span>{t('lobby.zeroToDisable', '0 to disable')}</span>
                        <span>{t('lobby.disconnect', '(after disconnect)')}</span>
                      </span>
                    </div>
                  </>
                )}
                {/* A real <button role="switch">, not a div: this is the only
                    call site of setRandomOrder, so as a bare onClick div there
                    was no keystroke at all by which a keyboard-only host could
                    change the play order, and nothing announced its state.
                    Every sibling row in this grid is already a real control.
                    The hover background lives in .lobby-row-hoverable:hover
                    (LobbyShared.css) rather than on a utility here —
                    .lobby-row sets background-color from outside any cascade
                    layer, so it outranks @layer utilities and a hover:bg-*
                    here silently never applied. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={randomOrder !== false}
                  onClick={() => setRandomOrder(!randomOrder)}
                  className="lobby-row lobby-row-hoverable w-full text-left cursor-pointer focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2 py-1">{t('lobby.randomOrder', 'Random Order')}</span>
                  <div className={`w-10 h-5 rounded-full flex items-center p-0.5 transition-colors ${randomOrder !== false ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-slate-600'}`}>
                    <motion.div
                      layout
                      transition={{ type: 'spring', stiffness: 700, damping: 30 }}
                      className="w-4 h-4 bg-white rounded-full shadow-xs"
                      style={{ marginLeft: randomOrder !== false ? '20px' : '0px' }}
                    />
                  </div>
                </button>
              </div>

              <div className="flex items-center justify-between mb-4">
                <h4 className="font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-slate-600 pb-2 flex-1">{t('lobby.cardsInDeck', 'Cards in Deck')}</h4>
                {onResetCards && (
                  <button
                    onClick={onResetCards}
                    className="flex items-center p-1 rounded-sm hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400 transition-colors ml-2"
                    title={t('lobby.resetCardsInDeck', 'Reset Cards in Deck to Default Values')}
                  >
                    <RotateCcw size={18} />
                    <span className="ml-1 text-xs font-medium inline">{t('lobby.defaultValues', 'default values')}</span>
                  </button>
                )}
              </div>
              {/* One column on a phone: a card's name shares its line with the
                  count and is set to ellipsis, so two columns cut the longer
                  names off mid-word. This used to be enforced from index.css,
                  by a rule that also overrode Tailwind's own grid-cols-2
                  everywhere else — it belongs here, on the element it is
                  about. */}
              <div data-testid="deck-composition-grid" className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
                {deckRows.map(({ card, count }) => (
                  <label key={card} className="lobby-row focus-within:ring-2 focus-within:ring-indigo-500 cursor-text">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{card.replace('_', '/')}</span>
                    <BlurInput
                      type="number" minVal={0} maxVal={MAX_CARD_COUNT} inputMode="numeric" pattern="[0-9]*"
                      aria-label={card.replace('_', '/')}
                      className="bg-transparent border-0 outline-hidden focus:outline-hidden focus:ring-0 focus:border-transparent shadow-none text-right w-16 py-1 text-gray-900 dark:text-white font-medium"
                      value={count}
                      onValueChange={(val) => updateCardCount(card, val)}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface StartGameButtonProps {
  startGame: () => void;
  playersCount: number;
  disabled?: boolean;
  // Overrides the default "need players" / "waiting to reconnect" message —
  // needed for reasons those two don't cover (e.g. an empty deck), and to
  // avoid showing the 2-player message in local mode, which never required it.
  disabledMessage?: string;
}

export function StartGameButton({ startGame, playersCount, disabled = false, disabledMessage }: StartGameButtonProps) {
  const { t } = useTranslation();
  const fallbackMessage = playersCount < 2
    ? t('lobby.needAtLeast2Players', 'Need at least 2 players')
    : t('lobby.waitingForPlayersToReconnect', 'Waiting for players to reconnect…');
  return (
    <AnimatePresence>
      {playersCount > 0 && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          className="flex justify-center"
        >
          <motion.button
            whileHover={!disabled ? { scale: 1.05 } : {}}
            whileTap={!disabled ? { scale: 0.95 } : {}}
            className={`w-full py-4 rounded-xl text-xl font-bold flex justify-center items-center gap-3 transition-colors ${disabled ? 'bg-gray-400 text-gray-200 cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'}`}
            onClick={startGame}
            disabled={disabled}
          >
            <Play size={24} /> {disabled ? (disabledMessage ?? fallbackMessage) : t('lobby.startGame', 'Start Game!')}
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
