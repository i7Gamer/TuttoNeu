import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import Die from './Die';
import type { Die as DieType } from '../../types';

interface CurrentRollBoardProps {
  // What is painted (mid-tumble faces included) vs. what was actually rolled —
  // the dice panel owns both and the shuffle animation between them.
  displayRoll: DieType[];
  currentRoll: DieType[];
  rollingDiceIndices: Set<string>;
  bustState: boolean;
  isRolling: boolean;
  isSelectionLocked: boolean;
  hasRolled: boolean;
  // Whether the current selection scores — drives the invalid-selection
  // indicator, whose space stays reserved either way.
  selectionValid: boolean;
  selectedCount: number;
  onToggleDie: (id: string) => void;
  onSelectAllValid: () => void;
}

export default function CurrentRollBoard({
  displayRoll, currentRoll, rollingDiceIndices, bustState, isRolling, isSelectionLocked,
  hasRolled, selectionValid, selectedCount, onToggleDie, onSelectAllValid,
}: CurrentRollBoardProps) {
  const { t } = useTranslation();

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2 sm:mb-3">
        <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('dice.current_roll', 'Current Roll')}</h4>
        {hasRolled && !isRolling && !bustState && (
          <button
            // min-h-11 grows the tap target to 44px (MIN_TAP_TARGET_PX,
            // e2e/styling.spec.ts); the -my-2 gives the extra height back as
            // negative margin, so the row still lays out at its old height
            // and the heading stays centred against this button. The button
            // itself is a transparent hit area — the visible chip is the
            // inner span, so the 44px target no longer makes the chip 44px
            // tall (the same mistake the EN/DE pill had, LanguageSwitcher).
            // "group" lets the chip take its hover colour from the button —
            // and (U-1, see LanguageSwitcher.tsx) its keyboard focus ring:
            // the button hides its own outline and the chip below carries
            // group-focus-visible:ring-2 instead.
            className="group min-h-11 flex items-center justify-center -my-2 focus-visible:outline-hidden"
            onClick={onSelectAllValid}
          >
            <span className="text-xs font-bold px-2.5 py-1 rounded-md border border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400 group-hover:bg-indigo-50 dark:group-hover:bg-indigo-900/30 group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 transition-colors">
              {t('dice.select_all_valid', 'Select all')}
            </span>
          </button>
        )}
      </div>
      <div className="min-h-[80px] p-4 bg-white dark:bg-slate-800 rounded-2xl flex gap-3 flex-wrap justify-center border border-gray-200 dark:border-slate-600 shadow-xs">
        {displayRoll.map(d => {
          const isDieTumbling = rollingDiceIndices.has(d.id);
          const isSelected = currentRoll.find(cr => cr.id === d.id)?.selected ?? false;
          return (
            <Die key={d.id} die={d} isSelected={isSelected} isDieTumbling={isDieTumbling} bustState={bustState} isRollPending={isRolling} isSelectionLocked={isSelectionLocked} onToggle={onToggleDie} />
          );
        })}
      </div>
      {bustState && (
        // Losing the turn is the most consequential thing that happens on this
        // board, and it was conveyed by colour alone.
        <motion.div role="alert" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-center text-red-500 text-2xl font-black mt-6 bg-red-50 py-3 rounded-xl border border-red-100">
          {t('dice.bust_description', 'Bust! (Volltreffer/Niete)')}
        </motion.div>
      )}
      {!bustState && (
        // The live region is this always-mounted wrapper rather than the
        // message: the message toggles `invisible`, which takes it out of the
        // accessibility tree, and a region announced into existence alongside
        // its own content is not reliably read out.
        <div role="status" aria-live="polite" className="text-center mt-3 min-h-[24px]">
          {/* Always mounted (visibility toggled, not presence) so
              this line's reserved space never pops in/out as the
              selection flips valid/invalid. */}
          <span
            className={`text-red-700 dark:text-red-300 font-bold bg-red-50 dark:bg-red-950/40 px-3 py-1 rounded-full border border-red-100 ${
              !selectionValid && selectedCount > 0 ? '' : 'invisible'
            }`}
          >
            {t('dice.invalid_selection', 'Invalid selection')}
          </span>
        </div>
      )}
    </div>
  );
}
