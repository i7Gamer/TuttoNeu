import { useState, useEffect, useRef } from 'react';
import { Undo2, ChevronRight, Check, X, Dices, Layers } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGameStore } from '../../store/useGameStore';
import { sortKeptDiceForDisplay, hasScoreInput, isSpecialCard, clampScoreInputText } from '../../utils/diceTurnControls';
import { formatInt } from '../../utils/formatNumber';
import { CARD_FLIP_MS, SPECTATOR_LIVE_STATE_GRACE_MS } from '../../utils/uiTimings';
import { BONUS_CARDS, MAX_SCORE_MAGNITUDE } from '../../utils/configValidation';
import type { CardType, DiceMode } from '../../types';
import { DiePips } from './Die';
import ConfirmModal from '../ConfirmModal';
import { useSpectatorGrace } from '../../hooks/useSpectatorGrace';

interface GameControlsProps {
  isMyTurn: boolean;
  diceMode: DiceMode;
  // Whether the dice panel is up over these controls. It covers the screen
  // but leaves them mounted and focusable (no focus trap — see the ModalShell
  // note in Game.tsx), so the Stop card's committing Continue is reachable
  // from behind it.
  showDiceGame?: boolean;
  setShowDiceGame: (show: boolean) => void;
  scoreInput: string;
  setScoreInput: (val: string | ((prev: string) => string)) => void;
  applyBonus: boolean;
  setApplyBonus: (val: boolean) => void;
  handleNextTurn: () => void;
  handleYesNo: (isSuccess: boolean) => void;
  // Classic physical chains: reveals the next card mid-turn. Rendered only
  // when provided (Game passes it for classic + physical dice).
  onDrawNextCard?: () => void;
  // UI-7: Game.tsx's handlePhysicalDrawNextCard awaits a network round trip
  // (drawCardMidTurn), and a ref read in render (its own re-entrancy guard)
  // doesn't itself trigger one — so without this, the button gave no visual
  // feedback while a draw was in flight. Only meaningful alongside
  // onDrawNextCard.
  isDrawingNextCard?: boolean;
  // Classic physical chains: says outright "I rolled a null", which physical
  // mode had no way to express. Rendered only when provided — Game withholds
  // it for Feuerwerk, whose null banks rather than forfeits.
  onBust?: () => void;
  // A special card's Yes was answered under classic — the yes/no buttons
  // give way to the bank-total input plus the draw button.
  awaitingChainChoice?: boolean;
  canUndo: boolean;
  /**
   * Identifies the turn Undo would reverse, so the confirm dialog can tell
   * whether it is still being asked about the same one. null when there is
   * nothing to undo. Opaque here — Game owns what goes into it.
   */
  undoTurnId?: string | null;
}

// The manual-score quick-add buttons: fixed point values a player can bank
// with one tap instead of typing them in.
const QUICK_ADD_SCORES = [50, 100, 200, 300, 400, 500, 600, 1000];

// Read straight from the store instead of taking these as props from Game —
// they are the store's own state (or actions), and Game was only ever
// forwarding them untouched. Same narrowing as Game.tsx's own useGameSlice
// (and see AdvancedOptionsPanel in LobbyShared.tsx for the pattern this
// copies): a shallow selector so an unrelated store change (toasts,
// reactions) doesn't re-render this subtree.
const useGameControlsSlice = () => useGameStore(useShallow(state => ({
  currentCard: state.currentCard,
  cardsLength: state.cards?.length ?? 0,
  ruleset: state.ruleset,
  isOnline: state.isOnline,
  isHost: state.isHost,
  activeTurnState: state.liveTurnState,
  currentPlayer: state.currentPlayerIndex !== null ? state.players[state.currentPlayerIndex] : null,
  // Identifies the turn a spectator is waiting on (useSpectatorGrace's
  // turnKey below) — currentPlayerIndex alone repeats every round.
  currentPlayerIndex: state.currentPlayerIndex,
  round: state.round,
  // The host-enforced dice mode is the only signal a spectator ever gets
  // about how the ACTIVE player is rolling — an individual player's own
  // dice-mode preference is local-only and never leaves their device (see
  // roomTypes.ts), so it cannot be read for anyone but yourself. When the
  // room enforces physical, liveTurnState above will never arrive for this
  // turn — physical dice never push one — so a spinner waiting on it would
  // spin forever.
  enforcedDiceMode: state.enforcedDiceMode,
  turnTimeRemaining: state.turnTimeRemaining,
  undo: state.undo,
  endGame: state.endGame,
  leaveRoom: state.leaveRoom,
})));

export default function GameControls({
  isMyTurn,
  diceMode,
  showDiceGame = false,
  setShowDiceGame,
  scoreInput,
  setScoreInput,
  applyBonus,
  setApplyBonus,
  handleNextTurn,
  handleYesNo,
  onDrawNextCard,
  isDrawingNextCard = false,
  onBust,
  awaitingChainChoice = false,
  canUndo,
  undoTurnId = null,
}: GameControlsProps) {
  const { t, i18n } = useTranslation();
  const {
    currentCard,
    cardsLength,
    ruleset,
    isOnline,
    isHost,
    activeTurnState,
    currentPlayer,
    currentPlayerIndex,
    round,
    enforcedDiceMode,
    turnTimeRemaining,
    undo,
    endGame,
    leaveRoom,
  } = useGameControlsSlice();

  // A spectator online, not on their own turn, with no live turn state yet:
  // in an enforced-physical room that state is permanent (see the branch
  // below), but in an UNENFORCED room it may just be that the active
  // player's first roll hasn't arrived. diceMode is per-device and never
  // networked, so nothing else here can tell the two apart — after this
  // grace period with still nothing, treat it the same as enforced-physical
  // rather than spinning for the rest of that player's turn.
  const waitingOnUnenforcedLiveState = isOnline && !isMyTurn && !activeTurnState && enforcedDiceMode !== 'physical';
  const spectatorGraceElapsed = useSpectatorGrace({
    active: waitingOnUnenforcedLiveState,
    turnKey: `${currentPlayerIndex}-${round}`,
    graceMs: SPECTATOR_LIVE_STATE_GRACE_MS,
  });
  const currentCardHasInput = hasScoreInput(currentCard);
  const currentCardHasYesNo = isSpecialCard(currentCard);
  const isStopCard = currentCard === 'Stop';

  const [prevCardsLength, setPrevCardsLength] = useState(cardsLength);
  const [prevCard, setPrevCard] = useState<CardType | null>(currentCard);
  const [isFlipping, setIsFlipping] = useState(false);
  // Which of the three confirm-gated actions below is pending a yes/no from
  // ConfirmModal — replaces the blocking window.confirm() every one of them
  // used to call directly.
  const [pendingAction, setPendingAction] = useState<'end' | 'leave' | 'undo' | null>(null);
  // The turn Undo was opened FOR. `pendingAction` alone said only that a
  // dialog is up, so confirming acted on whatever the previous-turn fields
  // held at that moment — and those are rewritten by every gameState
  // broadcast. A host who opened Undo for one player's turn and answered after
  // the next turn resolved rewound the WRONG turn, and pushState carried it to
  // the whole room. `!showDiceGame` on canUndo only guards the moment the
  // button is pressed, not the seconds the dialog is open.
  const [pendingUndoTurn, setPendingUndoTurn] = useState<string | null>(null);

  // Enter in the score box below routes through a real click() on this
  // button rather than calling handleNextTurn directly, so a disabled Next
  // Turn button can't be bypassed from the keyboard (see the onKeyDown next
  // to score-input).
  const nextTurnButtonRef = useRef<HTMLButtonElement>(null);

  // Render-time correction, the same pattern the flip state above uses: the
  // turn moved on, so the question the dialog is asking no longer has an
  // answer. Closing beats leaving it up over a turn that is gone.
  if (pendingAction === 'undo' && pendingUndoTurn !== null && undoTurnId !== pendingUndoTurn) {
    setPendingAction(null);
    setPendingUndoTurn(null);
  }

  // Synchronous render-time derived state: must run before paint so isFlipping
  // is true on the same frame the new card arrives, preventing a visible flash.
  if (cardsLength !== prevCardsLength || currentCard !== prevCard) {
    setPrevCardsLength(cardsLength);
    setPrevCard(currentCard);
    if (currentCard || prevCard) {
      setIsFlipping(true);
    } else if (!currentCard) {
      setIsFlipping(false);
    }
  }

  useEffect(() => {
    if (isFlipping && currentCard) {
      const timer = setTimeout(() => setIsFlipping(false), CARD_FLIP_MS);
      return () => clearTimeout(timer);
    }
  }, [isFlipping, currentCard]);

  const addScore = (val: number) => {
    setScoreInput(prev => {
      const current = parseInt(prev, 10) || 0;
      // Clamped like every other write to this box (see the score input's own
      // onChange below) — a run of quick-add taps must not be able to push
      // the total past what the server will actually accept.
      return clampScoreInputText((current + val).toString());
    });
  };

  return (
    <div className="flex flex-col bg-(--card-bg) sm:backdrop-blur-sm border border-white/40 rounded-3xl p-4 md:p-6 shadow-xl relative overflow-hidden h-full w-full min-h-[360px] md:min-h-[400px]">
      <div className="flex-1 flex flex-col justify-center items-center w-full min-h-[220px]">
        <AnimatePresence mode="wait">
          {isMyTurn && !isStopCard && !isFlipping && (
            <motion.div
              key="input-controls"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="w-full flex flex-col items-center"
            >
              {diceMode === 'digital' && (
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-indigo-500/30 transition-colors mb-4"
                  onClick={() => setShowDiceGame(true)}
                >
                  <Dices className="w-5 h-5 md:w-6 md:h-6" /> {t('game.controls.rollDice', 'Roll Dice')}
                </motion.button>
              )}

              {(currentCardHasInput || awaitingChainChoice) && diceMode === 'physical' && (
                <>
                  <div className="flex flex-row items-center gap-3 mb-4 md:mb-6 w-full max-w-sm">
                    <label htmlFor="score-input" className="sr-only">{t('game.controls.scorePlaceholder', 'Score')}</label>
                    <input
                      id="score-input"
                      type="number"
                      min="0"
                      max={MAX_SCORE_MAGNITUDE}
                      value={scoreInput}
                      // Clamped on every keystroke (not just at commit time)
                      // so the box can never DISPLAY a number larger than
                      // what Next Turn will actually bank — see
                      // clampScoreInputText.
                      onChange={(e) => setScoreInput(clampScoreInputText(e.target.value))}
                      // The box sits outside a <form> (nothing for Enter to
                      // submit), and useKeyboardShortcuts deliberately
                      // ignores Enter while an INPUT is focused — so without
                      // this, Enter here did nothing. Routed through the
                      // button's own click() rather than handleNextTurn
                      // directly so a disabled button still wins.
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        if (e.repeat) return;
                        e.preventDefault();
                        if (nextTurnButtonRef.current?.disabled) return;
                        nextTurnButtonRef.current?.click();
                      }}
                      placeholder={t('game.controls.scorePlaceholder', 'Score')}
                      className="flex-1 min-w-0 w-full text-center text-2xl md:text-3xl font-bold py-3 md:py-4 rounded-2xl border-2 border-gray-200 dark:border-slate-600 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 bg-(--card-bg) transition-all outline-hidden"
                    />
                    {/* The cards that change what a manually entered score is
                        worth: the flat bonuses, plus the doubler. Hidden for
                        classic: it is keyed to the card showing at entry
                        time, which is wrong mid-chain (a classic x2 doubles
                        the WHOLE accumulated total) — the player enters the
                        fully-computed final total instead. */}
                    {ruleset !== 'classic' && ([...BONUS_CARDS, 'x2'] as string[]).includes(currentCard ?? '') && (
                      <div className="flex items-center bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-3 py-2 md:py-3 rounded-2xl border border-amber-200 dark:border-amber-800 h-full">
                        <label className="checkbox-wrapper">
                          <input type="checkbox" checked={applyBonus} onChange={(e) => setApplyBonus(e.target.checked)} />
                          <span className="text-xs md:text-sm whitespace-nowrap font-semibold">{t('game.controls.applyBonus', 'Apply bonus')}</span>
                        </label>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-4 gap-2 mb-6 w-full max-w-sm">
                    {QUICK_ADD_SCORES.map(val => (
                      <motion.button
                        key={val}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        // min-h-11: the tappable box is the 44px WCAG
                        // target — a quick-add tap is exactly the kind of
                        // repeated, rushed input where a too-small hit area
                        // causes mis-taps (MIN_TAP_TARGET_PX,
                        // e2e/styling.spec.ts) — while the visible chip is
                        // the inner span at its usual small size. Styled
                        // directly, the 44px button was the chip. Same
                        // U-1 fix as the other three (LanguageSwitcher.tsx):
                        // the button hides its own focus outline and the
                        // chip below carries group-focus-visible:ring-2.
                        className="group min-h-11 flex items-center justify-center focus-visible:outline-hidden"
                        // data-testid rather than an accessible-name lookup:
                        // "+{val}" is two adjacent JSX text nodes, and its
                        // exact rendered whitespace isn't worth pinning a
                        // test to (see physical-bust/physical-draw-next-card
                        // above for the same reasoning).
                        data-testid={`quick-add-${val}`}
                        onClick={() => addScore(val)}
                      >
                        <span className="w-full bg-(--card-bg) group-hover:bg-indigo-50 dark:group-hover:bg-indigo-900/50 text-indigo-700 dark:text-white font-bold py-1.5 md:py-2 text-sm md:text-base rounded-lg md:rounded-xl border border-indigo-100 dark:border-indigo-800 group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 transition-colors shadow-xs">
                          +{formatInt(val, i18n.language)}
                        </span>
                      </motion.button>
                    ))}
                  </div>

                  <motion.button
                    ref={nextTurnButtonRef}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="bg-emerald-500 hover:bg-emerald-600 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-emerald-500/30 transition-colors"
                    onClick={handleNextTurn}
                  >
                    {t('game.controls.nextTurn', 'Next Turn')} <ChevronRight className="w-5 h-5 md:w-6 md:h-6" />
                  </motion.button>

                  {onBust && (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      data-testid="physical-bust"
                      className="mt-3 bg-red-500 hover:bg-red-600 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-red-500/30 transition-colors"
                      onClick={onBust}
                    >
                      <X className="w-5 h-5 md:w-6 md:h-6" /> {t('game.controls.bust', 'Bust — lose the chain')}
                    </motion.button>
                  )}

                  {onDrawNextCard && (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      data-testid="physical-draw-next-card"
                      className="mt-3 bg-amber-500 hover:bg-amber-600 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-amber-500/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={onDrawNextCard}
                      disabled={isDrawingNextCard}
                      aria-busy={isDrawingNextCard}
                    >
                      {t('dice.draw_next_card', 'Draw next card — risk everything!')} <Layers className="w-5 h-5 md:w-6 md:h-6" />
                    </motion.button>
                  )}
                </>
              )}

              {currentCardHasYesNo && diceMode === 'physical' && !awaitingChainChoice && (
                <div className="w-full mt-2">
                  <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 text-center">{t('game.controls.didYouSucceed', 'Did you succeed?')}</h4>
                  <div className="flex gap-4 w-full max-w-sm mx-auto">
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-emerald-500/30 transition-colors"
                      onClick={() => handleYesNo(true)}
                    >
                      <Check className="w-5 h-5 md:w-6 md:h-6" /> {t('game.controls.yes', 'Yes')}
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex-1 bg-red-500 hover:bg-red-600 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-red-500/30 transition-colors"
                      onClick={() => handleYesNo(false)}
                    >
                      <X className="w-5 h-5 md:w-6 md:h-6" /> {t('game.controls.no', 'No')}
                    </motion.button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* A Stop showing while the dice panel is up is a classic mid-chain
              forfeit that DiceGame commits itself, with the chain summary —
              the same reason Game's Stop auto-continue and its Space/Enter
              shortcut both stand down for it. Committing from here too would
              advance the turn a second time, and without that summary. */}
          {isMyTurn && isStopCard && !isFlipping && !showDiceGame && (
            <motion.div
              key="stop-controls"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center justify-center w-full text-center"
            >
              <h4 className="text-2xl font-bold text-red-500 mb-6">{t('game.controls.stopTurnOver', 'Stop! Your turn is over.')}</h4>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="bg-red-500 hover:bg-red-600 text-white w-full max-w-sm py-4 rounded-2xl text-xl font-bold flex justify-center items-center gap-3 shadow-lg shadow-red-500/30 transition-colors"
                onClick={() => handleYesNo(false)}
              >
                {t('game.controls.continue', 'Continue')} <ChevronRight size={24} />
              </motion.button>
            </motion.div>
          )}

          {!isMyTurn && (
            <motion.div
              key="waiting-controls"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center w-full text-center"
            >
              {/* The live view mirrors the ACTIVE player's digital dice; the
                  viewer's own diceMode is a per-device input preference and
                  must not hide it (physical-dice spectators watch too). */}
              {isOnline && activeTurnState ? (
                <div className="w-full">
                  <p className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
                    {t('game.controls.playerIsPlaying', '{{name}} is playing', { name: currentPlayer?.name ?? '' })}
                  </p>
                  <div className="text-4xl font-black text-indigo-600 dark:text-indigo-400 mb-4">
                    {formatInt(activeTurnState.turnScore, i18n.language)}
                  </div>
                  {(activeTurnState.cardsThisTurn?.length ?? 0) > 1 && (
                    <p className="text-xs font-bold text-indigo-500 uppercase tracking-wider -mt-3 mb-4">
                      {t('game.controls.chainCard', 'Card {{count}} of this turn', { count: activeTurnState.cardsThisTurn?.length })}
                    </p>
                  )}
                  {activeTurnState.keptDice.length > 0 && (
                    <div className="mb-4">
                      <p className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{t('game.controls.keptDice', 'Kept Dice')}</p>
                      <div className="flex gap-2 flex-wrap justify-center">
                        {sortKeptDiceForDisplay(activeTurnState.keptDice, currentCard, activeTurnState.kniffelProgress, ruleset).map((d) => (
                          // Pips carry no text, and the digit beside them is
                          // text-transparent — so without a name of its own a
                          // mirrored die is silent. Same treatment the roll
                          // panel's own dice got (KeptDiceTray/CurrentRollBoard).
                          <div key={d.id} role="img" aria-label={t('dice.dieFace', 'Die showing {{value}}', { value: d.val })} className="w-10 h-10 bg-indigo-600 text-transparent rounded-xl flex items-center justify-center text-xl font-bold border-2 border-indigo-400 relative">
                            {d.val}
                            <DiePips val={d.val} isSelected={false} bustState={false} size="small" isIndigo={true} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {activeTurnState.currentRoll.length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{t('game.controls.currentRoll', 'Current Roll')}</p>
                      <div className="flex gap-2 flex-wrap justify-center">
                        {activeTurnState.currentRoll.map((d) => {
                          const isRolling = activeTurnState.rollingDiceIds?.includes(d.id) ?? false;
                          const isBusted = activeTurnState.busted ?? false;
                          return (
                            <motion.div
                              key={d.id}
                              role="img"
                              aria-label={t('dice.dieFace', 'Die showing {{value}}', { value: d.val })}
                              animate={{
                                rotate: isRolling ? [0, 90, 180, 270, 360] : 0,
                                y: isRolling ? [0, -15, 0] : 0,
                              }}
                              transition={{
                                rotate: { repeat: isRolling ? Infinity : 0, duration: 0.2 },
                                y: { repeat: isRolling ? Infinity : 0, duration: 0.15 },
                              }}
                              className={`w-10 h-10 rounded-xl flex items-center justify-center text-transparent border-2 relative ${
                                isBusted
                                  ? 'bg-red-50 border-red-300 opacity-70'
                                  : d.selected
                                    ? 'bg-emerald-100 border-emerald-500 dark:bg-slate-700 dark:border-emerald-400'
                                    : 'bg-white dark:bg-slate-700 border-gray-300 dark:border-slate-500'
                              }`}
                            >
                              {d.val}
                              <DiePips val={d.val} isSelected={d.selected} bustState={isBusted} size="small" />
                            </motion.div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ) : isOnline && (enforcedDiceMode === 'physical' || spectatorGraceElapsed) ? (
                // Physical dice push no liveTurnState. In an enforced-physical
                // room that is permanent, so the specific "rolling real dice"
                // notice below shows at once and is actually true. In an
                // UNENFORCED room the grace elapsing only means "no live dice
                // snapshot has shown up yet" — which looks identical to a
                // digital player who simply hasn't opened the dice panel, so
                // claiming they are rolling real dice would assert something
                // nobody actually knows. That room gets a neutral notice
                // instead (see the comment on waitingOnUnenforcedLiveState
                // above for the grace period itself). A static notice either
                // way, with the room's own turn countdown (Scoreboard shows
                // it too, but not next to this message) when a turn timer is
                // running.
                <div className="w-full">
                  <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">
                    {enforcedDiceMode === 'physical'
                      ? t('game.physicalTurnNotice', '{{name}} is rolling real dice', { name: currentPlayer?.name ?? '' })
                      : t('game.turnInProgressNotice', '{{name}} is taking their turn…', { name: currentPlayer?.name ?? '' })}
                  </h4>
                  {turnTimeRemaining !== null && turnTimeRemaining !== undefined && (
                    <p className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('game.timeSeconds', '{{time}}s', { time: turnTimeRemaining })}
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin mb-4"></div>
                  <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t('game.controls.waiting', 'Waiting for other player…')}</h4>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex justify-between w-full mt-auto pt-6 border-t border-gray-100 dark:border-slate-700">
        {(!isOnline || isHost) ? (
          <button
            className="flex items-center gap-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-4 py-2 rounded-lg font-medium transition-colors"
            onClick={() => setPendingAction('end')}
          >
            <X size={18} /> {t('game.controls.endGame', 'End Game')}
          </button>
        ) : (
          <button
            className="flex items-center gap-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-4 py-2 rounded-lg font-medium transition-colors"
            onClick={() => setPendingAction('leave')}
          >
            <X size={18} /> {t('game.controls.leaveGame', 'Leave Game')}
          </button>
        )}
        <button
          className="flex items-center gap-2 text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 hover:text-gray-800 dark:hover:text-gray-100 px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none"
          onClick={() => { setPendingUndoTurn(undoTurnId); setPendingAction('undo'); }}
          disabled={!canUndo}
        >
          <Undo2 size={18} /> {t('game.controls.undo', 'Undo')}
        </button>
      </div>

      <ConfirmModal
        open={pendingAction !== null}
        danger={pendingAction === 'end' || pendingAction === 'leave'}
        message={
          pendingAction === 'end'
            ? t('game.controls.endGameConfirm', 'Do you really want to end the game?')
            : pendingAction === 'leave'
              ? t('game.controls.leaveGameConfirm', 'Do you really want to leave the game?')
              : t('game.controls.undoConfirm', 'Undo the last turn?')
        }
        onCancel={() => { setPendingAction(null); setPendingUndoTurn(null); }}
        onConfirm={() => {
          if (pendingAction === 'end') endGame();
          else if (pendingAction === 'leave') leaveRoom();
          // Belt to the render-time close above: whatever raced the click,
          // the turn confirmed must be the turn asked about.
          else if (pendingAction === 'undo' && undoTurnId === pendingUndoTurn) undo();
          setPendingAction(null);
          setPendingUndoTurn(null);
        }}
      />
    </div>
  );
}
