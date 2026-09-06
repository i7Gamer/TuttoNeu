import { useTranslation } from 'react-i18next';

export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language || 'en';

  return (
    <div className="flex gap-2 bg-black/5 dark:bg-white/5 p-1 rounded-lg sm:backdrop-blur-sm border border-gray-200 dark:border-slate-600">
      {/* min-h-11 min-w-11 grow the tap target to the 44px WCAG minimum
          (MIN_TAP_TARGET_PX, e2e/styling.spec.ts) — these were ~28px tall.
          -my-2 gives the added height back as negative margin so this
          switcher's own footprint (and the fixed HUD strip it sits in,
          App.tsx) doesn't grow with it; growing that would have pushed the
          HUD into content the A9 tests already check it clears. The button
          itself stays a transparent hit area (no background/shadow/rounding)
          — the visible pill (size, colour, shadow) lives on the inner span
          below, so the 44px tap target no longer forces the visible pill to
          be 44px tall too. It used to: the pill was ~36px tall and the 44px
          button carrying its styling directly made the selected pill stick
          out top and bottom of its ~36px container (B3). U-1: the button is
          also the transparent hit area for keyboard focus, so the browser's
          own outline drew around the invisible 44px box instead of the
          visible pill. `group` lets the pill react to the button's
          :focus-visible: the pill gets `group-focus-visible:ring-2` (the
          house focus ring, Die.tsx/LobbyShared.tsx) and the button hides its
          own outline with `focus-visible:outline-hidden` — not
          `outline-none`, which would also drop the outline Windows High
          Contrast (forced-colours) mode draws regardless of CSS. */}
      <button
        onClick={() => void i18n.changeLanguage('en')}
        aria-label={t('app.switchToEnglish', 'Switch to English')}
        aria-pressed={currentLanguage.startsWith('en')}
        className="group min-h-11 min-w-11 flex items-center justify-center -my-2 focus-visible:outline-hidden"
      >
        <span className={`px-3 py-1 rounded-md text-sm font-bold transition-all group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 ${currentLanguage.startsWith('en') ? 'bg-white dark:bg-slate-700 shadow-xs text-indigo-600 dark:text-indigo-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}>
          EN
        </span>
      </button>
      <button
        onClick={() => void i18n.changeLanguage('de')}
        aria-label={t('app.switchToGerman', 'Switch to German')}
        aria-pressed={currentLanguage.startsWith('de')}
        className="group min-h-11 min-w-11 flex items-center justify-center -my-2 focus-visible:outline-hidden"
      >
        <span className={`px-3 py-1 rounded-md text-sm font-bold transition-all group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 ${currentLanguage.startsWith('de') ? 'bg-white dark:bg-slate-700 shadow-xs text-indigo-600 dark:text-indigo-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}>
          DE
        </span>
      </button>
    </div>
  );
}
