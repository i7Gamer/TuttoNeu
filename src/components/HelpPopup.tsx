import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, type ReactNode, type RefObject } from 'react';
import { scrollBehavior } from '../utils/reducedMotion';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { HelpCircle, X, ChevronRight, ChevronDown } from 'lucide-react';
import ModalShell from './ModalShell';
import { useGameStore } from '../store/useGameStore';
import { HELP_SECTION_OPEN_ANIMATION_MS } from '../utils/uiTimings';
import { renderBoldMarkdown } from '../utils/renderBoldMarkdown';
import { APP_VERSION } from '../utils/appVersion';
import { BONUS_CARDS } from '../utils/configValidation';
import './HelpPopup.css';

interface SectionProps {
  title: string;
  id: string;
  isOpen: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}

function Section({ title, id, isOpen, onToggle, children }: SectionProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (isOpen && contentRef.current) {
      contentRef.current.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
  }, [isOpen]);

  return (
    <div className="mb-3 sm:mb-4 bg-gray-50 dark:bg-slate-800 rounded-lg sm:rounded-xl overflow-hidden border border-gray-100 dark:border-slate-700">
      {/* The only cue that a section is open was a swapped icon with no
          accessible name, so nothing announced the state or the relationship
          to the panel below. The scanner toggle in OnlineLobby already does
          this; the wiki did not. */}
      <button
        onClick={() => onToggle(id)}
        aria-expanded={isOpen}
        aria-controls={`${id}-panel`}
        className="w-full flex items-center justify-between px-3 py-3 sm:px-4 sm:py-4 bg-white dark:bg-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
      >
        <span className="text-base sm:text-lg leading-none font-bold text-gray-800 dark:text-gray-100 pt-0.5">{title}</span>
        {isOpen ? <ChevronDown size={20} className="text-gray-500 shrink-0" /> : <ChevronRight size={20} className="text-gray-500 shrink-0" />}
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-gray-100 dark:border-slate-700"
          >
            <div id={`${id}-panel`} ref={contentRef} className="p-3 sm:p-4 text-sm sm:text-base text-gray-600 dark:text-gray-300 space-y-3">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface CardEntryProps {
  isActive: boolean;
  activeRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

// One entry in the Cards section. The card currently on the table gets both
// the highlight and the scroll target — asked once here rather than once per
// card at each of the two places that have to agree.
function CardEntry({ isActive, activeRef, children }: CardEntryProps) {
  return (
    <div ref={isActive ? activeRef : undefined} className={isActive ? 'wiki-card-highlight' : undefined}>
      {children}
    </div>
  );
}

export default function HelpPopup() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const status = useGameStore(state => state.status);
  const currentCard = useGameStore(state => state.currentCard);
  // The rule text follows the selected/active rule set. Keys are picked with
  // literal ternaries, never built dynamically — translations.test.ts scans
  // for literal keys and would flag a template string as a missing one.
  const ruleset = useGameStore(state => state.ruleset);
  const isClassic = ruleset === 'classic';

  const [activeSection, setActiveSection] = useState<string>('general');
  const activeCardRef = useRef<HTMLDivElement>(null);
  const openedDuringPlayRef = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  // When opening during gameplay, check if we have a current card
  useLayoutEffect(() => {
    if (isOpen && status === 'playing' && currentCard && !openedDuringPlayRef.current) {
      openedDuringPlayRef.current = true;
      setActiveSection('cards');
    } else if (!isOpen) {
      openedDuringPlayRef.current = false;
    }
  }, [isOpen, status, currentCard]);

  // The Section's own scrollIntoView (see contentRef above) only brings the
  // "Cards" section's wrapper into view, not the specific highlighted card
  // inside it — which can still be off-screen if it sits further down that
  // section. Scroll the highlighted card itself once the section's open
  // animation has settled (see HELP_SECTION_OPEN_ANIMATION_MS).
  useEffect(() => {
    if (activeSection !== 'cards' || !currentCard) return;
    const timer = setTimeout(() => {
      activeCardRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    }, HELP_SECTION_OPEN_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [activeSection, currentCard]);

  const toggleSection = useCallback((id: string) => {
    setActiveSection(prev => prev === id ? '' : id);
  }, []);


  // Memoized against `t` (not moved to module scope — the labels/text are
  // translated, so they must still be recomputed when the language changes).
  const tocSections = useMemo(() => [
    { id: 'general', label: t('help.toc.general', 'General Rules') },
    { id: 'gameModes', label: t('help.toc.gameModes', 'Game Modes') },
    { id: 'cards', label: t('help.toc.cards', 'Cards') },
    { id: 'settings', label: t('help.toc.settings', 'Settings') },
    { id: 'online', label: t('help.toc.online', 'Playing Online') },
    { id: 'shortcuts', label: t('help.toc.shortcuts', 'Keyboard') },
    { id: 'statistics', label: t('help.toc.statistics', 'Statistics') },
    { id: 'faq', label: t('help.toc.faq', 'FAQ') },
  ], [t]);

  // Four ways to hand a room to someone, all of them icon buttons that say
  // nothing on their own. Ordered by how little the other person has to type.
  const invites = useMemo(() => [
    { id: 'inviteLink', description: t('help.online.inviteLink') },
    { id: 'share', description: t('help.online.share') },
    { id: 'qr', description: t('help.online.qr') },
    { id: 'scan', description: t('help.online.scan') },
    { id: 'recentRooms', description: t('help.online.recentRooms') },
  ], [t]);

  // Nothing on screen hints that these exist, so this list is the only place a
  // player can find them. Keys are bound in Game.tsx (the primary action) and
  // DiceGame.tsx (inside the dice panel), both through useKeyboardShortcuts.
  const shortcuts = useMemo(() => [
    { keys: ['Space', 'Enter'], description: t('help.shortcuts.primary') },
    { keys: ['R'], description: t('help.shortcuts.rollAgain') },
    { keys: ['S'], description: t('help.shortcuts.stop') },
    { keys: ['A'], description: t('help.shortcuts.selectAll') },
    { keys: ['D'], description: t('help.shortcuts.drawNextCard') },
  ], [t]);

  const faqs = useMemo(() => [
    { q: t('help.faq.q1'), a: isClassic ? t('help.faq.a1Classic') : t('help.faq.a1') },
    { q: t('help.faq.q2'), a: t('help.faq.a2') },
    { q: t('help.faq.q3'), a: t('help.faq.a3') },
    { q: t('help.faq.q4'), a: t('help.faq.a4') },
    { q: t('help.faq.q5'), a: isClassic ? t('help.faq.a5Classic') : t('help.faq.a5') },
    { q: t('help.faq.q6'), a: t('help.faq.a6') },
    { q: t('help.faq.q7'), a: t('help.faq.a7') },
  ], [t, isClassic]);

  return (
    <>
      <button
        ref={openButtonRef}
        onClick={() => setIsOpen(true)}
        // z-100 (not z-50, the dice panel's own `.modal-backdrop-under-hud`
        // layer): this button was earlier in the DOM than that backdrop and
        // tied with it at z-50, so it lost the paint-order tie and was
        // unreachable while the dice panel was open. z-100 is the same layer
        // App.tsx's language/theme corner already uses.
        className="fixed bottom-6 left-6 w-12 h-12 bg-white dark:bg-slate-800 rounded-full shadow-lg flex items-center justify-center hover:scale-110 transition-transform z-100 text-indigo-500 dark:text-indigo-400 border border-gray-100 dark:border-slate-700"
        title={t('help.buttonTitle', 'Open Help / Wiki')}
        aria-label={t('help.buttonTitle', 'Open Help / Wiki')}
      >
        <HelpCircle size={24} />
      </button>

      <ModalShell
        open={isOpen}
        onDismiss={() => setIsOpen(false)}
        labelledBy="help-dialog-title"
        initialFocusRef={closeButtonRef}
        returnFocusRef={openButtonRef}
        backdropClassName="modal-backdrop modal-backdrop-roomy"
        panelClassName="modal-panel modal-panel-wide"
        motionProps={{
          initial: { opacity: 0, scale: 0.95, y: 20 },
          animate: { opacity: 1, scale: 1, y: 0 },
          exit: { opacity: 0, scale: 0.95, y: 20 },
        }}
      >
              {/* Header */}
              <div className="relative flex items-center justify-center p-4 sm:p-6 border-b border-gray-100 dark:border-slate-800">
                <h2 id="help-dialog-title" className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                  <HelpCircle className="text-indigo-500 w-5 h-5 sm:w-6 sm:h-6" />
                  {t('help.title', 'Tutto Wiki')}
                </h2>
                <button
                  ref={closeButtonRef}
                  onClick={() => setIsOpen(false)}
                  className="absolute right-4 sm:right-6 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 bg-gray-100 dark:bg-slate-800 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                  title={t('help.close', 'Close')}
                  aria-label={t('help.close', 'Close')}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 scroll-smooth">
                {/* Table of Contents - Horizontal Pills for quick nav */}
                {/* items-center, not the flex default: items stretch to their
                    own line's height, and the label below is taller than a
                    pill — so pills sharing the label's line rendered bigger
                    than the ones that wrapped onto the next. */}
                <div className="flex flex-wrap items-center gap-2 mb-6 sm:mb-8">
                  <span className="text-sm font-semibold text-gray-500 dark:text-gray-400 py-2 mr-2">
                    {t('help.toc.title', 'Table of Contents')}:
                  </span>
                  {tocSections.map((section) => (
                    <button
                      key={section.id}
                      data-testid="help-toc-pill"
                      onClick={() => setActiveSection(section.id)}
                      // Selection was carried by a class alone, so which
                      // chapter is showing was visible information only.
                      aria-current={activeSection === section.id ? 'true' : undefined}
                      className={`wiki-pill ${activeSection === section.id ? 'wiki-pill-active' : 'wiki-pill-idle'}`}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>

                {/* Sections */}
                <Section id="general" title={t('help.general.title', 'General Rules')} isOpen={activeSection === 'general'} onToggle={toggleSection}>
                  <p>{t('help.general.intro')}</p>
                  <h4 className="wiki-heading mt-4">{t('help.general.turnFlowTitle')}</h4>
                  <div className="space-y-3">
                    <div>
                      <span className="wiki-term">{t('help.general.step1Title')}</span> {t('help.general.step1Desc')}
                    </div>
                    <div>
                      <span className="wiki-term">{t('help.general.step2Title')}</span> {t('help.general.step2Desc')}
                    </div>
                    <div>
                      <span className="wiki-term">{t('help.general.step3Title')}</span> {t('help.general.step3Desc')}
                    </div>
                    <div>
                      <span className="wiki-term">{t('help.general.step4Title')}</span> {t('help.general.step4Desc')}
                      <ul className="list-disc pl-5 mt-1 space-y-1">
                        <li><span className="font-semibold">{t('help.general.step4aTitle')}</span> {t('help.general.step4aDesc')}</li>
                        <li><span className="font-semibold">{t('help.general.step4bTitle')}</span> {t('help.general.step4bDesc')}</li>
                      </ul>
                    </div>
                    <div>
                      <span className="wiki-term">{t('help.general.step5Title')}</span> {isClassic ? t('help.general.step5DescClassic') : t('help.general.step5Desc')}
                    </div>
                  </div>
                </Section>

                <Section id="gameModes" title={t('help.gameModes.title', 'Game Modes')} isOpen={activeSection === 'gameModes'} onToggle={toggleSection}>
                  <p>{t('help.gameModes.intro')}</p>
                  <ul className="list-disc pl-5 space-y-2">
                    <li><span className="font-semibold">{t('lobby.rulesetModernized', 'Modernized')}:</span> {t('help.gameModes.modernized')}</li>
                    <li><span className="font-semibold">{t('lobby.rulesetClassic', 'Classic')}:</span> {t('help.gameModes.classic')}</li>
                  </ul>
                  <p className="text-sm italic">{t('help.gameModes.stats')}</p>
                </Section>

                <Section id="cards" title={t('help.cards.title', 'Cards')} isOpen={activeSection === 'cards'} onToggle={toggleSection}>
                  <div className="space-y-4">
                    <CardEntry isActive={!!currentCard && BONUS_CARDS.includes(currentCard)} activeRef={activeCardRef}>
                      <h4 className="wiki-heading">{t('help.cards.bonus', 'Bonus (200 - 600)')}</h4>
                      <p className="text-sm">{isClassic ? t('help.cards.bonusDescClassic') : t('help.cards.bonusDesc')}</p>
                    </CardEntry>
                    <CardEntry isActive={currentCard === 'x2'} activeRef={activeCardRef}>
                      <h4 className="wiki-heading">{t('help.cards.x2', 'x2 (Double)')}</h4>
                      <p className="text-sm">{isClassic ? t('help.cards.x2DescClassic') : t('help.cards.x2Desc')}</p>
                    </CardEntry>
                    <CardEntry isActive={currentCard === 'Stop'} activeRef={activeCardRef}>
                      <h4 className="wiki-heading">{t('help.cards.stop', 'Stop')}</h4>
                      <p className="text-sm">{t('help.cards.stopDesc')}</p>
                    </CardEntry>
                    <CardEntry isActive={currentCard === 'Feuerwerk'} activeRef={activeCardRef}>
                      <h4 className="wiki-heading">{t('help.cards.fireworks', 'Feuerwerk')}</h4>
                      <p className="wiki-card-note border-orange-400 text-orange-800 dark:text-orange-200" dangerouslySetInnerHTML={{ __html: renderBoldMarkdown(isClassic ? t('help.cards.fireworksDescClassic') : t('help.cards.fireworksDesc')) }}></p>
                    </CardEntry>
                    <CardEntry isActive={currentCard === 'Kniffel'} activeRef={activeCardRef}>
                      <h4 className="wiki-heading">{t('help.cards.kniffel', 'Kniffel')}</h4>
                      <p className="wiki-card-note border-indigo-400 text-indigo-800 dark:text-indigo-200" dangerouslySetInnerHTML={{ __html: renderBoldMarkdown(isClassic ? t('help.cards.kniffelDescClassic') : t('help.cards.kniffelDesc')) }}></p>
                    </CardEntry>
                    <CardEntry isActive={currentCard === 'Plus_Minus'} activeRef={activeCardRef}>
                      <h4 className="wiki-heading">{t('help.cards.plusMinus', 'Plus/Minus')}</h4>
                      <p className="wiki-card-note border-red-400 text-red-800 dark:text-red-200" dangerouslySetInnerHTML={{ __html: renderBoldMarkdown(isClassic ? t('help.cards.plusMinusDescClassic') : t('help.cards.plusMinusDesc')) }}></p>
                    </CardEntry>
                    <CardEntry isActive={currentCard === 'Kleeblatt'} activeRef={activeCardRef}>
                      <h4 className="wiki-heading">{t('help.cards.kleeblatt', 'Kleeblatt')}</h4>
                      <p className="wiki-card-note border-green-400 text-green-800 dark:text-green-200" dangerouslySetInnerHTML={{ __html: renderBoldMarkdown(t('help.cards.kleeblattDesc')) }}></p>
                    </CardEntry>
                  </div>
                </Section>

                <Section id="settings" title={t('help.settings.title', 'Settings')} isOpen={activeSection === 'settings'} onToggle={toggleSection}>
                  <ul className="list-disc pl-5 space-y-2">
                    <li>{t('help.settings.winningScore')}</li>
                    <li>{t('help.settings.turnTimer')}</li>
                    <li>{t('help.settings.kickTimer')}</li>
                    <li>{t('help.settings.randomOrder')}</li>
                    <li>{t('help.settings.diceMode')}</li>
                    <li>{t('help.settings.deckComp')}</li>
                  </ul>
                </Section>

                <Section id="online" title={t('help.online.title', 'Playing Online')} isOpen={activeSection === 'online'} onToggle={toggleSection}>
                  <p>{t('help.online.intro')}</p>
                  <ul className="list-disc pl-5 space-y-2">
                    {invites.map(invite => (
                      <li key={invite.id}>{invite.description}</li>
                    ))}
                  </ul>
                  <p className="text-sm italic">{t('help.online.scanSecure')}</p>
                </Section>

                <Section id="shortcuts" title={t('help.shortcuts.title', 'Keyboard Shortcuts')} isOpen={activeSection === 'shortcuts'} onToggle={toggleSection}>
                  <p>{t('help.shortcuts.intro')}</p>
                  <dl className="space-y-2">
                    {shortcuts.map(shortcut => (
                      <div key={shortcut.keys.join('+')} className="flex items-baseline gap-3">
                        <dt className="flex gap-1 shrink-0">
                          {shortcut.keys.map(key => (
                            <kbd
                              key={key}
                              className="px-2 py-0.5 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-xs font-bold text-gray-700 dark:text-gray-200 shadow-xs"
                            >
                              {key}
                            </kbd>
                          ))}
                        </dt>
                        <dd className="text-sm">{shortcut.description}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-sm italic">{t('help.shortcuts.note')}</p>
                </Section>

                <Section id="statistics" title={t('help.statistics.title', 'Statistics')} isOpen={activeSection === 'statistics'} onToggle={toggleSection}>
                  <ul className="list-disc pl-5 space-y-2">
                    <li>{t('help.statistics.s1')}</li>
                    <li>{t('help.statistics.s2')}</li>
                    <li>{t('help.statistics.s3')}</li>
                    <li>{t('help.statistics.s4')}</li>
                    <li>{t('help.statistics.s5')}</li>
                    <li>{t('help.statistics.s6')}</li>
                    <li>{t('help.statistics.s7')}</li>
                  </ul>
                </Section>

                <Section id="faq" title={t('help.faq.title', 'FAQ')} isOpen={activeSection === 'faq'} onToggle={toggleSection}>
                  <div className="space-y-4">
                    {faqs.map((faq, idx) => (
                      <div key={`faq-${idx}`}>
                        <h4 className="wiki-heading">{faq.q}</h4>
                        <p className="text-sm mt-1">{faq.a}</p>
                      </div>
                    ))}
                  </div>
                </Section>

              </div>

              {/* Outside the scroll container so it is visible without scrolling
                  to the bottom of the wiki — the point of it is to be findable
                  when someone asks "which build are you running?". */}
              <footer className="shrink-0 px-4 sm:px-6 py-3 border-t border-gray-100 dark:border-slate-800 text-center">
                <span data-testid="help-app-version" className="text-xs text-gray-500 dark:text-gray-400">
                  {t('help.version', 'Version')} {APP_VERSION}
                </span>
                {' · '}
                {/* AGPL-3.0 §13: a network-facing modified copy must offer its
                    users a way to get the source. The app's own source is
                    already public, but nothing in the UI pointed there — this
                    is that pointer, for whoever forks the published image and
                    never reads the footer of a README they didn't ship. */}
                <a
                  href="https://github.com/i7Gamer/Tutto"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="help-source-link"
                  className="text-xs text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-300"
                >
                  {t('help.sourceLink', 'Source & License')}
                </a>
              </footer>
      </ModalShell>
    </>
  );
}
