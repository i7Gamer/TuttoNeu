import { getDisplayCardName } from '../utils/cardVisuals';
import PageContainer from './PageContainer';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGameStore } from '../store/useGameStore';
import { vibrateYourTurn, vibrateTurnUrgent } from '../utils/soundEffects';
import { computeRankedPlayers, canUndoState } from '../utils/coreGameEngine';
import { applyTuttoBonus } from '../utils/diceLogic';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../utils/formatTime';
import { buildTurnKey } from '../utils/diceTurnState';
import { hasScoreInput, isSpecialCard, parseScoreInput } from '../utils/diceTurnControls';
import { gameModeOf, isCustomGameMode } from '../utils/statsApi';
import { DICE_PANEL_ENTRANCE_MS, TURN_URGENT_SECONDS } from '../utils/uiTimings';
import { useWakeLock } from '../hooks/useWakeLock';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useDeviceStats } from '../hooks/useDeviceStats';
import type { PreGameStats } from '../store/storeTypes';
import type { CardType, DiceSnapshot, TurnEnd, TurnSummary } from '../types';
import { KNIFFEL_SCORE, PLUS_MINUS_SCORE } from '../utils/coreGameEngine';
import { usePhysicalChain, readPhysicalChainCache } from '../hooks/usePhysicalChain';
import { useReconnectResume } from '../hooks/useReconnectResume';
import { useTurnAnnouncement } from '../hooks/useTurnAnnouncement';
import { useStopCardAutoContinue } from '../hooks/useStopCardAutoContinue';
import { useFeuerwerkFanfare } from '../hooks/useFeuerwerkFanfare';

import ModalShell from './ModalShell';
import ConfirmModal from './ConfirmModal';
import Scoreboard from './game/Scoreboard';
import CardDisplay from './game/CardDisplay';
import GameControls from './game/GameControls';
import Leaderboard from './game/Leaderboard';
import ReactionBar from './game/ReactionBar';
import DiceGame from './DiceGame';
import HistoryLog from './game/HistoryLog';

// Identifies the turn slot a commit handler's closure was rendered for, so
// it can later be compared against the live store to tell whether that
// closure is still current (see isStaleTurnClosure below). A plain string
// key rather than a tuple/object: both call sites need to compare it with
// `!==`, which a fresh object or array would never satisfy even for the
// same round/seat.
const turnSlotKey = (round: number, currentPlayerIndex: number | null) => `${round}:${currentPlayerIndex}`;

// Only the fields Game actually reads (directly or via game.X below / the
// Scoreboard prop) are selected here, with shallow equality — so a store
// mutation that touches an unrelated slice (toasts, reactions, other
// players' rooms) doesn't force this component and its whole subtree to
// re-render. See HistoryLog.tsx/HelpPopup.tsx for the same narrow-selector
// pattern applied via single-field selectors instead.
const useGameSlice = () => useGameStore(useShallow(state => ({
  currentCard: state.currentCard,
  cards: state.cards,
  nextTurn: state.nextTurn,
  drawCardMidTurn: state.drawCardMidTurn,
  isOnline: state.isOnline,
  myName: state.myName,
  winningScore: state.winningScore,
  initialCards: state.initialCards,
  players: state.players,
  currentPlayerIndex: state.currentPlayerIndex,
  gameTimeInSeconds: state.gameTimeInSeconds,
  liveTurnState: state.liveTurnState,
  setLiveTurnState: state.setLiveTurnState,
  pushLiveTurnState: state.pushLiveTurnState,
  diceMode: state.diceMode,
  enforcedDiceMode: state.enforcedDiceMode,
  ruleset: state.ruleset,
  isHost: state.isHost,
  kickPlayer: state.kickPlayer,
  justReconnected: state.justReconnected,
  roomId: state.roomId,
  round: state.round,
  deviceId: state.deviceId,
  setPreGameStats: state.setPreGameStats,
  turnTimeRemaining: state.turnTimeRemaining,
  addToast: state.addToast,
  sendReaction: state.sendReaction,
  hostId: state.hostId,
  finished: state.finished,
  previousCard: state.previousCard,
  previousPlayerName: state.previousPlayerName,
  previousTurnSummary: state.previousTurnSummary,
})));

export default function Game() {
  const { t } = useTranslation();
  const game = useGameSlice();
  const {
    currentCard,
    cards,
    nextTurn,
    drawCardMidTurn,
    isOnline,
    myName,
    winningScore,
    initialCards,
    players,
    currentPlayerIndex,
    gameTimeInSeconds,
    liveTurnState,
    setLiveTurnState,
    diceMode,
    enforcedDiceMode,
    isHost,
    kickPlayer,
    justReconnected,
    roomId,
    round,
    deviceId,
    setPreGameStats,
    turnTimeRemaining,
    addToast,
  } = game;

  // Keeps the screen awake for the whole gameplay session, on every device —
  // host or client, since this component mounts identically for both.
  useWakeLock();

  const formattedTime = formatTime(gameTimeInSeconds);

  // The host may pin a single dice mode for how every player takes their OWN
  // turn, overriding each player's personal device preference (offline has no
  // host to enforce anything, so it's always the personal preference there).
  const effectiveDiceMode = isOnline && enforcedDiceMode ? enforcedDiceMode : diceMode;

  const currentPlayer = currentPlayerIndex !== null ? players[currentPlayerIndex] : null;
  const sortedPlayers = useMemo(() => computeRankedPlayers(players), [players]);
  // Scoreboard is memoized (see Scoreboard.tsx) and reads only these 8
  // fields of the slice above — but `game` itself is a fresh object on every
  // liveTurnState tick during a roll (useShallow only skips re-rendering
  // Game when EVERY selected field is unchanged; it still returns a new
  // object here since liveTurnState did change). Passing `game` straight
  // through would reconstruct Scoreboard's prop every ~300ms regardless of
  // memoization, so it's narrowed to its own stable object instead.
  const scoreboardGame = useMemo(() => ({
    players, currentPlayerIndex, isOnline, myName, round, winningScore, turnTimeRemaining, hostId: game.hostId,
  }), [players, currentPlayerIndex, isOnline, myName, round, winningScore, turnTimeRemaining, game.hostId]);

  const isMyTurn = !isOnline || (currentPlayer && currentPlayer.name === myName);
  useTurnAnnouncement({ isOnline, isMyTurn: !!isMyTurn, addToast });
  const isClassic = game.ruleset === 'classic';
  // Classic PHYSICAL chains live in usePhysicalChain (digital chains live
  // inside DiceGame). The typed running total restores from the same cache
  // the chain does, so a reload resumes the turn mid-entry.
  const classicPhysical = isClassic && effectiveDiceMode === 'physical';
  const physicalTurnKey = buildTurnKey(roomId, round, currentPlayerIndex, currentCard, game.ruleset);
  const [scoreInput, setScoreInput] = useState(() => (classicPhysical ? readPhysicalChainCache(physicalTurnKey)?.scoreInput : null) ?? '');
  const [applyBonus, setApplyBonus] = useState(false);
  const [showDiceGame, setShowDiceGame] = useState(false);
  // The physical counterpart of the digital panel's onStateChange (wired at
  // the bottom of this file). Straight to pushLiveTurnState rather than
  // setLiveTurnState: that one also writes the DIGITAL resume cache, and a
  // physical turn resumes from its own key instead (usePhysicalChain). Gated
  // on being the active player because the server accepts a liveTurnState
  // only from the host or the seat whose turn it is.
  const { pushLiveTurnState } = game;
  const relayPhysicalChain = useCallback((snapshot: DiceSnapshot | null) => {
    if (!isOnline || !isMyTurn) return;
    pushLiveTurnState(snapshot);
  }, [isOnline, isMyTurn, pushLiveTurnState]);
  const {
    awaitingChoice: physicalAwaitingChoice,
    hasChain: hasPhysicalChain,
    canDrawAnotherCard,
    completeCurrentCard,
    recordDraw,
    buildSummary: buildPhysicalSummary,
    clearChain,
  } = usePhysicalChain({
    enabled: classicPhysical,
    roomId, round, currentPlayerIndex, currentCard, ruleset: game.ruleset,
    scoreInput,
    onSnapshot: relayPhysicalChain,
  });
  // An externally advanced turn (undo, the online Stop auto-continue, a
  // server timeout) never passes through the commit handlers that reset the
  // entry fields. Digits surviving into the new slot would be re-cached by
  // the chain cache's write-through under the NEW turn's key — undoing the
  // lifecycle clear one render later — so this corrects at render time (the
  // stale-modal pattern below), landing before any effect can write.
  const turnSlot = turnSlotKey(round, currentPlayerIndex);
  const [prevTurnSlot, setPrevTurnSlot] = useState(turnSlot);
  if (turnSlot !== prevTurnSlot) {
    setPrevTurnSlot(turnSlot);
    if (scoreInput !== '') setScoreInput('');
    if (applyBonus) setApplyBonus(false);
  }
  // D-15: the CARD_FLIP_MS gate hides the NEXT render, but the exiting
  // AnimatePresence node (GameControls' whole input-controls panel) keeps its
  // stale onClick closure clickable for the length of the exit tween — a
  // double-click, or a held Enter on the focused button, reaches it a second
  // time and commits again onto the player nextTurn already moved to. Zustand's
  // `set` is synchronous, so by the second click the live store has already
  // moved off the slot this closure was rendered for, and comparing against it
  // catches the stale call without a ref or a timer. `nextTurn` always moves
  // the seat or the round (a one-player game bumps the round; a chain draws
  // the next card without calling it), so no two legitimate commits ever share
  // a slot, and undo restores the old slot — so the fresh closure that follows
  // an undo matches it again and nothing needs clearing.
  const isStaleTurnClosure = useCallback(() => {
    const live = useGameStore.getState();
    return turnSlotKey(live.round, live.currentPlayerIndex) !== turnSlot;
  }, [turnSlot]);
  // Tracks whether the dice panel's own entrance animation has finished, so
  // DiceGame knows when it's safe to start rolling automatically. Reset once
  // the panel closes so the next opening waits for its own animation again.
  const [diceGamePanelReady, setDiceGamePanelReady] = useState(false);
  // Seeded with the initial value (not false) so mounting straight into an
  // already-your-turn state (fresh load, reconnect) doesn't itself count as
  // a "turn started" transition — only a later false-to-true flip does.
  const wasMyTurnRef = useRef(!!isMyTurn);

  // Guards the awaited draw in handlePhysicalDrawNextCard — see there.
  const drawInFlightRef = useRef(false);
  // UI-7: the ref above is read-only re-entrancy — a ref write doesn't
  // itself re-render, so the button gave no visual feedback across the
  // round trip. This state exists purely for that: GameControls binds it to
  // disabled/aria-busy on the "Draw next card" button.
  const [isDrawingNextCard, setIsDrawingNextCard] = useState(false);

  // Both of these correct state during render rather than from an effect. An
  // effect renders the stale value first and fixes it on the next pass, and
  // for the dice panel that stale frame is a modal covering the whole screen
  // on a turn that has already moved on to somebody else.
  if (showDiceGame && !isMyTurn) setShowDiceGame(false);
  // Readiness must not outlive the panel it belongs to, or the next opening
  // starts already "ready" and auto-rolls before its entrance has played.
  if (!showDiceGame && diceGamePanelReady) setDiceGamePanelReady(false);

  // Local hot-seat has no meaning for "your turn" haptics — every turn is
  // "mine" there, since one device is passed around the table.
  useEffect(() => {
    if (isOnline && isMyTurn && !wasMyTurnRef.current) {
      vibrateYourTurn();
    }
    wasMyTurnRef.current = !!isMyTurn;
  }, [isOnline, isMyTurn]);

  // Fires once per second for as long as your own turn timer reads 10s or
  // under (turnTimeRemaining ticks down once a second, so this effect
  // re-running on each new value already gives the "every second" cadence —
  // no edge-detection needed). Only for the active player's own device —
  // spectators watching someone else's countdown run low shouldn't feel
  // their phone buzz for it.
  useEffect(() => {
    if (!isOnline || !isMyTurn) return;
    if (turnTimeRemaining === null || turnTimeRemaining === undefined) return;
    if (turnTimeRemaining <= TURN_URGENT_SECONDS) vibrateTurnUrgent();
  }, [isOnline, isMyTurn, turnTimeRemaining]);

  useEffect(() => {
    if (!showDiceGame) return;
    const timer = setTimeout(() => setDiceGamePanelReady(true), DICE_PANEL_ENTRANCE_MS);
    return () => clearTimeout(timer);
  }, [showDiceGame]);

  // Snapshot this device's lifetime records once, right as the game begins —
  // this component only mounts when a fresh game starts (App.tsx swaps in
  // EndScreen while finished, then remounts Game on "Play Again"), and this
  // read is guaranteed to land before this game's own endGameStats submission
  // (which only fires from nextTurn at game-over). EndScreen later diffs the
  // post-game stats against this snapshot to detect genuinely new personal
  // records, rather than merely tying an older one.
  // Snapshotted rather than depended on: the values are read for the game this
  // component mounted for, and a later change to either is not a new game.
  const [atGameStart] = useState(() => ({ isOnline, deviceId, mode: gameModeOf({ winningScore, initialCards }, game.ruleset) }));
  const { isOnline: onlineAtStart, deviceId: deviceAtStart, mode: modeAtStart } = atGameStart;
  // A custom game never celebrates a personal record (see EndScreen), which
  // is the only thing this snapshot feeds — so there is nothing to compare
  // against and no reason to spend the request. A classic game compares
  // against its OWN bucket, so the mode rides the URL.
  const { stats: preGameStatsData } = useDeviceStats<Partial<PreGameStats>>(
    deviceAtStart, modeAtStart,
    { enabled: !!onlineAtStart && !!deviceAtStart && !isCustomGameMode(modeAtStart) },
  );

  useEffect(() => {
    // Cleared before anything else: a snapshot left over from an earlier game
    // in this session would be diffed against THIS game's numbers.
    setPreGameStats(null);
  }, [setPreGameStats]);

  useEffect(() => {
    if (!preGameStatsData) return;
    setPreGameStats({
      highestTurnScore: preGameStatsData.highestTurnScore ?? null,
      fastestWinTurns: preGameStatsData.fastestWinTurns ?? null,
      fastestLossTurns: preGameStatsData.fastestLossTurns ?? null,
      highestFeuerwerkTurnScore: preGameStatsData.highestFeuerwerkTurnScore ?? null,
      highestX2TurnScore: preGameStatsData.highestX2TurnScore ?? null,
      mostCardsInTurn: preGameStatsData.mostCardsInTurn ?? null,
      highestForfeitedTurnScore: preGameStatsData.highestForfeitedTurnScore ?? null,
    });
  }, [preGameStatsData, setPreGameStats]);

  // Stable for useReconnectResume's dependency array.
  const openDiceGame = useCallback(() => setShowDiceGame(true), []);

  // What a Stop card commits when it runs out its own clock. A classic chain
  // standing under it is forfeited with its summary (and the total typed so
  // far); anything else is the bare turn advance.
  const commitStopCard = useCallback(() => {
    if (isClassic && hasPhysicalChain()) {
      nextTurn(0, false, buildPhysicalSummary('stopCard', false, parseScoreInput(scoreInput)));
      clearChain();
    } else {
      nextTurn(0, false);
    }
  }, [isClassic, hasPhysicalChain, nextTurn, buildPhysicalSummary, clearChain, scoreInput]);

  useReconnectResume({
    isOnline,
    justReconnected,
    isMyTurn: !!isMyTurn,
    effectiveDiceMode,
    liveTurnState,
    currentCard,
    currentPlayerName: currentPlayer?.name,
    currentPlayerIndex,
    roomId,
    round,
    ruleset: game.ruleset,
    addToast,
    onResume: openDiceGame,
  });

  const stopCardCountdown = useStopCardAutoContinue({
    currentCard,
    cardsLength: cards?.length,
    isOnline,
    isMyTurn: !!isMyTurn,
    showDiceGame,
    onAutoContinue: commitStopCard,
  });

  useFeuerwerkFanfare(currentCard, cards?.length);

  const commitNextTurn = useCallback(() => {
    if (isStaleTurnClosure()) return;
    let parsedScore = parseScoreInput(scoreInput);
    // A bonus multiplies or adds to a SCORED turn — applyTuttoBonus(0, '400')
    // is 400, so applying it to an empty box used to bank the bonus alone
    // (nextTurn(400, true)) for a turn that scored nothing. Zero scored means
    // nothing banked, the same as the empty-box bust path.
    if (applyBonus && parsedScore > 0) {
      parsedScore = applyTuttoBonus(parsedScore, currentCard);
    }
    if (isClassic) {
      // The player enters the fully-computed final total (the Apply-bonus
      // helper is hidden for classic — mid-chain it would apply the wrong
      // card's arithmetic). A completed special card was already marked in
      // the chain when its Yes was answered.
      const banked = parsedScore > 0;
      // Feuerwerk is marked here instead: banking a total IS how that card is
      // completed (see TurnCardPlayed), and it opens no bank-or-draw choice
      // for the flag above to carry — digital has always recorded it that way
      // (the Feuerwerk null in DiceGame). One that banks nothing reached no
      // goal and stays uncompleted. It counts no tutto either way: the null it
      // completes on is not one (see TUTTOS_PER_COMPLETION).
      const feuerwerkBanked = currentCard === 'Feuerwerk' && banked;
      nextTurn(parsedScore, banked, buildPhysicalSummary(banked ? 'banked' : 'null', physicalAwaitingChoice || feuerwerkBanked));
      clearChain();
    } else {
      nextTurn(parsedScore, parsedScore > 0);
    }
    setScoreInput('');
    setApplyBonus(false);
  }, [scoreInput, applyBonus, currentCard, nextTurn, isClassic, buildPhysicalSummary, physicalAwaitingChoice, clearChain, isStaleTurnClosure]);

  // Whether Next Turn is about to record a bust with nobody having said so on
  // purpose — modernized physical play has no explicit Bust button (that's
  // classic-only, see canBustOnThisCard/handlePhysicalBust below), so an
  // empty or zero score box committed here silently cost the whole turn. Gated
  // on the SAME parsedScore commitNextTurn would use, not on scoreInput's raw
  // text, so a bonus-checkbox-only submit (parses to 0 before the bonus is
  // even considered) is caught the same way a truly empty box is.
  const [pendingBustConfirm, setPendingBustConfirm] = useState(false);

  const handleNextTurn = useCallback(() => {
    if (!isClassic && effectiveDiceMode === 'physical' && parseScoreInput(scoreInput) === 0) {
      setPendingBustConfirm(true);
      return;
    }
    commitNextTurn();
  }, [isClassic, effectiveDiceMode, scoreInput, commitNextTurn]);

  const confirmBust = useCallback(() => {
    setPendingBustConfirm(false);
    commitNextTurn();
  }, [commitNextTurn]);

  const cancelBust = useCallback(() => {
    setPendingBustConfirm(false);
  }, []);

  // Every classic-physical turn that ends on ZERO banked points — a special
  // card's No, a Kleeblatt answered either way, a mid-chain Stop, a declared
  // bust — commits the same three things: the turn with the chain's summary,
  // the chain itself cleared, the score box emptied. Spelled out at each of
  // the four call sites it was four chances to forget one of them (the
  // forfeited total in particular, which is what the summary carries the
  // typed score for).
  //
  // `banked` is derived rather than passed: 'banked' is precisely the end a
  // caller means when the turn scored, and the two arguments could not
  // disagree without one of them being a bug.
  const commitPhysicalTurn = useCallback((ended: TurnEnd, lastCardCompleted = false) => {
    if (isStaleTurnClosure()) return;
    nextTurn(0, ended === 'banked', buildPhysicalSummary(ended, lastCardCompleted, parseScoreInput(scoreInput)));
    clearChain();
    setScoreInput('');
  }, [nextTurn, buildPhysicalSummary, clearChain, scoreInput, isStaleTurnClosure]);

  const handleYesNo = useCallback((isSuccess: boolean) => {
    if (isStaleTurnClosure()) return;
    if (isClassic && currentCard && isSpecialCard(currentCard) && currentCard !== 'Kleeblatt') {
      // Kniffel/Plus_Minus under classic: a Yes does NOT commit the turn —
      // the card is completed, its fixed value is pre-filled into the score
      // input, and the player chooses to bank the total or draw the next
      // card. Only a No (the whole chain forfeited) commits here.
      if (isSuccess) {
        const isPlusMinus = currentCard === 'Plus_Minus';
        completeCurrentCard(isPlusMinus);
        setScoreInput(prev => String((parseInt(prev, 10) || 0) + (isPlusMinus ? PLUS_MINUS_SCORE : KNIFFEL_SCORE)));
        return;
      }
      commitPhysicalTurn('null');
      return;
    }
    if (isClassic && currentCard === 'Kleeblatt') {
      // The one caller with a completed last card to record: a Kleeblatt Yes
      // both banks and completes, a No does neither.
      commitPhysicalTurn(isSuccess ? 'banked' : 'null', isSuccess);
      return;
    }
    if (isClassic && currentCard === 'Stop' && hasPhysicalChain()) {
      // The local Continue button on a mid-chain Stop — same forfeit the
      // online auto-continue commits.
      commitPhysicalTurn('stopCard');
      return;
    }
    nextTurn(0, isSuccess);
  }, [nextTurn, isClassic, currentCard, completeCurrentCard, hasPhysicalChain, commitPhysicalTurn, isStaleTurnClosure]);

  // Classic physical: the player made a tutto with their real dice and
  // reveals the next card, keeping the running total in the score input.
  // A drawn Stop resolves through the Stop-card flow (auto online, the
  // Continue button locally), which commits the chain forfeit.
  const handlePhysicalDrawNextCard = useCallback(async () => {
    if (!currentCard) return;
    // The chain caps at MAX_CHAIN_CARDS (see canDrawAnotherCard) — refused
    // BEFORE drawCardMidTurn, or the drawn card would leave the deck without
    // ever entering the chain.
    if (!canDrawAnotherCard()) return;
    // One draw at a time. isDrawingNextCard below disables the button, but
    // that's a re-render away from this click, and canDrawAnotherCard reads
    // a chain that only grows in recordDraw — i.e. after the answer lands —
    // so across the round trip below every one of this handler's own guards
    // still says yes. The ref is what actually closes the gap: set
    // synchronously here, before any await, a same-tick double-tap sees it
    // true on the second call. A double-tap would otherwise deal twice for
    // one tutto: two cards off the room deck, two turn-timer restarts, and a
    // card entering the chain marked completed that was never rolled, which
    // buildSummary counts as a tutto and MAX-merges into mostCardsInTurn for
    // good. DiceGame's drawNextCard holds the same ref for the same reason.
    if (drawInFlightRef.current) return;
    drawInFlightRef.current = true;
    // UI-7: paired with the ref above, but this one exists to be READ —
    // GameControls renders off it, disabling the button and marking it
    // aria-busy for the length of the round trip.
    setIsDrawingNextCard(true);
    // Awaited: online the card is dealt by the server (the deck is not this
    // client's to draw from), so this is a round trip. `currentCard` is read
    // here, BEFORE the ask, because it is the card the chain is being
    // continued from and the store has moved on to the new one by the time the
    // answer lands — see recordDraw.
    const drawnFrom = currentCard;
    let drawn: CardType | null;
    try {
      drawn = await drawCardMidTurn();
    } finally {
      drawInFlightRef.current = false;
      setIsDrawingNextCard(false);
    }
    if (!drawn) return;
    recordDraw(drawn, drawnFrom);
  }, [currentCard, canDrawAnotherCard, drawCardMidTurn, recordDraw]);

  // Classic physical: the player rolled a null. Said outright instead of being
  // inferred from a cleared score box — which was both the only way to express
  // it and the thing that destroyed the number, so physical could never record
  // highestForfeitedTurnScore the way digital does. Forgetting to clear the
  // box banked a chain that had just been lost. Same call handleYesNo's No
  // already makes for a special card.
  const handlePhysicalBust = useCallback(() => {
    commitPhysicalTurn('null');
  }, [commitPhysicalTurn]);

  const handleDiceComplete = useCallback((score: number, isSuccess: boolean, turnSummary?: TurnSummary) => {
    if (isStaleTurnClosure()) return;
    setShowDiceGame(false);
    nextTurn(score, isSuccess, turnSummary);
  }, [nextTurn, isStaleTurnClosure]);

  const currentCardHasInput = hasScoreInput(currentCard);
  const currentCardHasYesNo = isSpecialCard(currentCard);
  const isStopCard = currentCard === 'Stop';

  // Feuerwerk is the one card a chain cannot be carried off: the turn ends on
  // its null, banking whatever was accumulated, so there is never a tutto to
  // draw on. Digital mode has always refused it (canDrawAfterTutto in
  // DiceGame, which also excludes a completed Kleeblatt — that one has won the
  // game outright); physical rendered the button for every card that takes a
  // score, Feuerwerk included. Kleeblatt needs no mention here: isSpecialCard
  // keeps it out of the score-input branch this button lives in.
  const canDrawOnThisCard = classicPhysical && currentCard !== 'Feuerwerk';
  // Only while a SCORING card is on the table. A special card is answered with
  // Yes/No — its No already forfeits the chain with the typed total — and
  // Feuerwerk is excluded for the same reason it cannot be drawn on: its null
  // banks the accumulated total rather than losing it.
  const canBustOnThisCard = classicPhysical && currentCardHasInput && currentCard !== 'Feuerwerk';

  // Keyboard shortcuts: Space/Enter triggers whatever GameControls' primary
  // button is for the current turn state. There's no dice-roll modal dismiss
  // shortcut — once opened it auto-rolls immediately and can't be backed out
  // of. The roll/stop/select keys inside that modal live in DiceGame; the
  // guards both rely on (typing, open modals, held keys) are in the hook.
  const primaryAction = () => {
    if (isStopCard) {
      // A Stop showing while the dice modal is up is a classic mid-chain
      // forfeit that DiceGame commits itself, with the chain summary — the
      // same reason the Stop auto-continue effect above skips it. Committing
      // here too would advance the turn a second time (and without the
      // summary), handing the next player a forfeited turn.
      if (!showDiceGame) handleYesNo(false);
    } else if (effectiveDiceMode === 'digital') {
      // Digital mode always shows "Roll Dice" for any non-Stop card — it
      // doesn't distinguish input/yes-no cards the way physical mode does.
      if (!showDiceGame) setShowDiceGame(true);
    } else if (physicalAwaitingChoice) {
      // The bank-or-draw choice after a special card's Yes: banking the
      // entered total is the primary action, same as the button order.
      handleNextTurn();
    } else if (currentCardHasYesNo) {
      handleYesNo(true);
    } else if (currentCardHasInput) {
      handleNextTurn();
    }
  };

  useKeyboardShortcuts({
    space: isMyTurn ? primaryAction : undefined,
    enter: isMyTurn ? primaryAction : undefined,
  });

  // A turn exists to undo at all — the exact predicate calculateUndo's own
  // early-outs use (shared via canUndoState so the two can never drift),
  // including the guard this component used to be missing: the previous
  // player must still be in the roster, or Undo would silently no-op.
  const hasUndoableTurn = canUndoState(game);
  // ...and this client is allowed to act on it (offline, or online as the
  // active player/host).
  const canActOnUndo = !isOnline || isMyTurn || isHost;
  // ...and no turn is currently being rolled on this device. The dice panel
  // covers the screen but the controls behind it stay mounted and focusable
  // (no focus trap — see the ModalShell note on the panel below), so Undo was
  // reachable by Tab from behind it. Undoing there hands the turn back to the
  // previous player while the panel keeps rolling for the current one, and its
  // score then commits onto whoever undo just made current.
  const canUndo = hasUndoableTurn && canActOnUndo && !showDiceGame;
  // Which turn that is, for the confirm dialog to hold on to. Player, card and
  // round together: a gameState broadcast rewrites all three as one set (see
  // noUndoableTurn), so any turn change moves this string.
  const undoTurnId = hasUndoableTurn
    ? `${game.previousPlayerName}:${game.previousCard}:${round}`
    : null;

  return (
    <PageContainer className="pt-2 md:pt-4 gap-2 md:gap-4">
      <Scoreboard game={scoreboardGame} formattedTime={formattedTime} />

      {/* overflow-x-clip: the two columns below slide in from +-20px
          (CardDisplay from the left, GameControls from the right), and
          nothing was clipping that transient horizontal excursion — at
          375px wide it pushed document.documentElement.scrollWidth past the
          viewport for the ~300ms the tween runs, jiggling in a horizontal
          scrollbar on phones. `-x-clip` rather than `-hidden`: it clips only
          the horizontal axis, so it can sit on this stable (untransformed)
          wrapper without touching vertical overflow anywhere inside it —
          CardDisplay's own countdown ring, GameControls' content — and
          without affecting the dice panel's ModalShell, which is `fixed`
          and rendered as this component's own sibling below, outside this
          grid entirely. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-4 overflow-x-clip">
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col h-full">
          <CardDisplay currentCard={currentCard} cards={cards} stopCardCountdown={stopCardCountdown} />
        </motion.div>

        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col h-full">
          <GameControls
            isMyTurn={!!isMyTurn}
            diceMode={effectiveDiceMode}
            showDiceGame={showDiceGame}
            setShowDiceGame={setShowDiceGame}
            scoreInput={scoreInput}
            setScoreInput={setScoreInput}
            applyBonus={applyBonus}
            setApplyBonus={setApplyBonus}
            handleNextTurn={handleNextTurn}
            handleYesNo={handleYesNo}
            onDrawNextCard={canDrawOnThisCard ? handlePhysicalDrawNextCard : undefined}
            isDrawingNextCard={isDrawingNextCard}
            onBust={canBustOnThisCard ? handlePhysicalBust : undefined}
            awaitingChainChoice={physicalAwaitingChoice}
            canUndo={canUndo}
            undoTurnId={undoTurnId}
          />
          {/* Reactions are meaningless without other players around to see
              them, so the bar only makes sense for online games. */}
          {isOnline && (
            <div className="mt-2 md:mt-4">
              <ReactionBar sendReaction={game.sendReaction} />
            </div>
          )}
        </motion.div>

        <Leaderboard
          sortedPlayers={sortedPlayers}
          currentPlayerName={currentPlayer?.name}
          isOnline={isOnline}
          isHost={isHost}
          hostId={game.hostId}
          isClassic={isClassic}
          winningScore={winningScore}
          kickPlayer={kickPlayer}
        />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="md:col-span-2"
        >
          <HistoryLog />
        </motion.div>
      </div>

      {/* A ModalShell like every other overlay in the app: it was the one
          full-screen panel that wasn't, so nothing announced a dialog had
          opened and Tab walked straight into the leaderboard and the End
          Game / Undo controls behind the backdrop. No onDismiss — the turn
          auto-rolls the moment this opens and cannot be backed out of, which
          is also why the backdrop click does nothing. */}
      {/* Mounted conditionally rather than driven by ModalShell's own `open`:
          its AnimatePresence keeps a closing panel on screen until the exit
          finishes, and this panel has to come down in the SAME commit the turn
          moves away (see the stale-modal correction above) — a full-screen
          modal outliving its turn by an animation is the thing that guard
          exists to prevent. The cost is ModalShell's focus-return-on-close,
          which needs the open->closed transition it never sees here; by then
          the button that opened this is usually gone anyway, the turn having
          moved on. The hand-rolled markup this replaced had an exit animation
          that never ran either, nothing having wrapped it to run it. */}
      {showDiceGame && (
        <ModalShell
          open
          // A direct name, not labelledBy: the panel's own <h2> is swapped out
          // for the summary and the drawn-card reveal, so there is no id that
          // is always there to point at. Same wording as that header, and the
          // card matters — it decides the turn's whole scoring rule.
          label={`${t('dice.title', 'Dice Game')} - ${getDisplayCardName(currentCard)}`}
          backdropClassName="modal-backdrop modal-backdrop-under-hud"
          panelClassName="w-full max-w-4xl rounded-3xl"
          motionProps={{
            initial: { opacity: 0, scale: 0.9, y: 20 },
            animate: { opacity: 1, scale: 1, y: 0 },
          }}
        >
          <DiceGame
            currentCard={currentCard}
            turnKey={buildTurnKey(roomId, round, currentPlayerIndex, currentCard, game.ruleset)}
            onComplete={handleDiceComplete}
            onStateChange={effectiveDiceMode === 'digital' ? setLiveTurnState : undefined}
            panelReady={diceGamePanelReady}
            ruleset={game.ruleset}
            onDrawCard={game.drawCardMidTurn}
          />
        </ModalShell>
      )}

      <ConfirmModal
        open={pendingBustConfirm}
        danger
        message={t('game.confirmBustTitle', 'Record this turn as a bust with no points?')}
        confirmLabel="game.confirmBustYes"
        cancelLabel="game.confirmBustNo"
        onCancel={cancelBust}
        onConfirm={confirmBust}
      />
    </PageContainer>
  );
}
