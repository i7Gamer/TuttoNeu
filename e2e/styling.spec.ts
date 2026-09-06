import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { seedLocalDeck, startLocalGame, joinOnlineRoomPair } from './helpers';

/**
 * Tailwind v4 emits its utilities inside a real `@layer utilities`. Unlayered
 * CSS beats every layer no matter how weak its selector, so the moment any of
 * the app's own rules sits outside a layer it silently outranks the utilities —
 * `* { margin: 0; padding: 0 }` in index.css alone was enough to kill every
 * `p-*` and `m-*` class in the app. Nothing else catches it: the build passes,
 * the rules are all still in the stylesheet, and jsdom does not resolve layers,
 * so the unit suite cannot see it either. It only exists as computed style in a
 * real browser against the real bundle, which is exactly what this file has.
 *
 * The expectations below are what Tailwind v3 actually produced, not what looks
 * tidy: with no layers in play, specificity decided. Utilities (0,1,0) beat the
 * element rules (0,0,1) and the `*` reset (0,0,0), and LOSE to the app's own
 * class rules, which match at equal specificity and are written after them.
 */
// Opens the dice panel and waits until `ready` is on screen. The opening
// auto-roll busts before any selection about once in forty runs (about one
// in three full runs, over three engines); on a bust the summary
// auto-continues to the next player, whose board offers a fresh roll, so the
// helper simply rolls again (whose turn it is never matters to a layout or
// contrast probe). Shared by EVERY probe that opens the panel: the one that
// clicked Roll Dice on its own and waited for Select all was this file's
// flakiest test, and its trace showed exactly this -- the panel opened,
// busted, and closed on its own before anything selectable appeared.
const OPENING_ROLL_ATTEMPTS = 3;
const OPENING_ROLL_TIMEOUT_MS = 15000;
// Longer than framer-motion's default hover tween, so a scale that should no
// longer exist would have fully landed before a measurement (B6).
const HOVER_SETTLE_MS = 400;
const rollUntil = async (page: Page, ready: Locator): Promise<void> => {
  const bust = page.getByText(/Bust!/i);
  const rollDice = page.getByRole('button', { name: /Roll Dice/i });
  for (let attempt = 0; attempt < OPENING_ROLL_ATTEMPTS; attempt++) {
    await rollDice.click();
    await expect(ready.or(bust)).toBeVisible({ timeout: OPENING_ROLL_TIMEOUT_MS });
    if (await ready.isVisible()) return;
    await expect(rollDice).toBeVisible({ timeout: OPENING_ROLL_TIMEOUT_MS });
  }
  throw new Error(`the opening roll busted ${OPENING_ROLL_ATTEMPTS} times in a row`);
};
const rollUntilSelectable = (page: Page): Promise<void> =>
  rollUntil(page, page.getByRole('button', { name: /Select all/i }));

test.describe('stylesheet cascade', () => {
  // Probes are injected rather than looked for in the UI: this is about which
  // rule wins, and a real element would confound that with its own classes.
  //
  // `contest` is the self-oracle for a "X still wins over U" claim, and it is
  // not optional pedantry: the gap probe below used to name `gap-8`, which
  // Tailwind never generated — @source covers src/, not e2e/, and the app's
  // only use of it is the responsive `sm:gap-8`. So the probe was reading
  // `.stat-grid-2` against NOTHING and passing on the strength of one rule
  // applying. `contest` measures the utility on its own first, which fails
  // loudly if it is absent from the stylesheet.
  //
  // `open` names a screen that has to be visited first. Statistics and the end
  // screen are lazy routes (App.tsx), so their CSS ships as its own stylesheet
  // and is injected only when the chunk loads. That makes the stat-grid probe
  // the more interesting one of the pair now: it proves an unlayered rule
  // still outranks `@layer utilities` when its stylesheet arrives LATE, which
  // is the cascade situation the lazy split introduced.
  interface Probe {
    html: string;
    property: string;
    expected: string;
    what: string;
    contest?: { html: string; expected: string };
    open?: 'statistics';
  }

  const PROBES: Probe[] = [
    { html: '<div class="p-4"></div>', property: 'paddingTop', expected: '16px',
      what: 'a p-4 utility outranks the * reset' },
    { html: '<div class="mb-8"></div>', property: 'marginBottom', expected: '32px',
      what: 'an mb-8 utility outranks the * reset' },
    { html: '<h1 class="text-5xl"></h1>', property: 'fontSize', expected: '48px',
      what: 'a text-5xl utility outranks the h1 font-size' },
    { html: '<h1 class="mb-2"></h1>', property: 'marginBottom', expected: '8px',
      what: 'an mb-2 utility outranks the h1 margin-bottom' },
    { html: '<div class="modal-panel p-4"></div>', property: 'paddingTop', expected: '16px',
      what: 'a p-4 utility applies where the component class sets no padding' },
    { html: '<button class="theme-toggle p-4"></button>', property: 'paddingTop', expected: '8px',
      contest: { html: '<button class="p-4"></button>', expected: '16px' },
      what: '.theme-toggle padding still wins over p-4, as it did in v3' },
    // gap-6 rather than gap-8: it is one the app actually uses, so Tailwind
    // emits it. .stat-grid-2 is gap-4 (16px), so the two genuinely disagree.
    { html: '<div class="stat-grid-2 gap-6"></div>', property: 'gap', expected: '16px',
      contest: { html: '<div class="gap-6"></div>', expected: '24px' },
      open: 'statistics',
      what: '.stat-grid-2 gap still wins over a gap utility, as it did in v3' },
  ];

  const computed = (page: Page, html: string, property: string) =>
    page.evaluate(({ html, property }) => {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.appendChild(host);
      // Indexed by the camelCase JS name, exactly as the untyped version
      // did — getPropertyValue would want the kebab-case CSS name instead.
      const styles = getComputedStyle(host.firstElementChild as Element) as unknown as Record<string, string>;
      const value = styles[property];
      host.remove();
      return value;
    }, { html, property });

  /**
   * All eight probes against one page load, where each used to pay for its own
   * context and `goto` to inject a div and read one property back.
   *
   * `expect.soft` so a single lost cascade battle still reports the other
   * seven — and so a `contest` that fails (the utility is missing from the
   * stylesheet entirely) no longer aborts before the probe it guards, which is
   * the more informative of the two readings. What a merged test cannot
   * survive is a THROW: a crashed page or a failed `computed()` evaluate ends
   * it there and the probes after it never run. Nothing here reads a value an
   * earlier probe produced, so that costs diagnostic breadth, never a verdict.
   */
  test("the app's own rules and Tailwind's utilities resolve as v3 did", async ({ page }) => {
    await page.goto('/');

    const runProbe = ({ html, property, expected, what, contest }: Probe) =>
      // The former test's own title, so it still names the failure in the HTML
      // report and in the trace.
      test.step(what, async () => {
        if (contest) {
          expect.soft(
            await computed(page, contest.html, property),
            'the utility this claims to outrank is not in the stylesheet at all',
          ).toBe(contest.expected);
        }

        expect.soft(await computed(page, html, property), what).toBe(expected);
      });

    for (const probe of PROBES.filter(probe => !probe.open)) await runProbe(probe);

    // Split out of the data rather than hand-written below, so a ninth probe
    // declaring `open` cannot silently end up running in the closed state.
    const afterStatistics = PROBES.filter(probe => probe.open === 'statistics');
    if (afterStatistics.length > 0) {
      // Last, and only once the closed-state readings are in: visiting
      // Statistics injects that lazy chunk's stylesheet, and its LATE arrival
      // is the whole premise of the probes below (see the note above).
      await page.getByRole('button', { name: 'View Statistics' }).click();
      // Waited for, not assumed: the chunk's stylesheet is injected as part
      // of loading it, so probing before the screen is up would measure a
      // document that legitimately has no such rule yet. Hard, not soft —
      // every reading after it depends on the screen actually being up.
      await expect(page.getByTestId('statistics-page')).toBeVisible();

      for (const probe of afterStatistics) await runProbe(probe);
    }
  });
});

/**
 * Finding 38 — the base `margin-bottom: 1rem` on h1-h4 (index.css) used to
 * apply unconditionally, including to a heading sharing a flex row with a
 * sibling control: the extra space below the heading's content grows its own
 * margin box, so `align-items: center` centres that taller box instead of the
 * text inside it, and the heading's visible content lands above the row's
 * true centre. index.css now excludes a heading that is itself a flex/grid
 * item from that rule (`:not(:where(.flex, .inline-flex, .grid, .inline-grid)
 * > *)`) — CurrentRollBoard's "Current Roll" h4, sharing a
 * `flex items-center justify-between` row with the "Select all" button, is
 * one of three sites this fixed (the other two are HelpPopup's dialog title,
 * centred against its close button, and OnlineLobby's "Recent Rooms"
 * heading). All three need a real browser to lay the row out and resolve
 * the `@layer`/`:where()` cascade — jsdom does neither — so this one probe
 * stands in for the shape of bug all three shared.
 */
test.describe('base heading margin does not leak into a flex row (finding 38)', () => {
  test('CurrentRollBoard\'s "Current Roll" heading has no bottom margin and centres with Select all', async ({ page }) => {
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);

    await rollUntilSelectable(page);
    const heading = page.getByText('Current Roll', { exact: true });
    const selectAll = page.getByRole('button', { name: /Select all/i });
    await expect(selectAll).toBeVisible();
    await expect(heading).toBeVisible();

    expect(await heading.evaluate(el => getComputedStyle(el).marginBottom)).toBe('0px');

    const headingBox = await heading.boundingBox();
    const buttonBox = await selectAll.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();

    const headingCentre = headingBox!.y + headingBox!.height / 2;
    const buttonCentre = buttonBox!.y + buttonBox!.height / 2;
    // A leaked 1rem bottom margin used to push the heading's visible centre
    // roughly 8px above the button's — well outside this tolerance.
    expect(Math.abs(headingCentre - buttonCentre)).toBeLessThanOrEqual(2);
  });
});

/**
 * The same trap, caught on a real element rather than a probe: `.lobby-row`
 * sets background-color from OUTSIDE any layer, so it outranks `@layer
 * utilities` however specific the utility is — a `hover:bg-gray-50` on the row
 * itself silently never applied, and the Random Order switch had no hover cue
 * at all. The fix moves the hover into the same unlayered context
 * (`.lobby-row-hoverable:hover`, LobbyShared.css), which only a real browser
 * can confirm: the rule is present in the stylesheet either way, and jsdom
 * resolves neither layers nor :hover.
 */
test.describe('the lobby row hover cue survives the cascade', () => {
  // How long a background colour is given to stop moving before the reading
  // that samples it is called unstable. Explicit rather than left to
  // expect.poll's 5 s default, so the number the message quotes is the number
  // that applies. The intervals start tight because the transition being
  // waited out is ~150ms — the default first-poll gap alone would be most of it.
  const BACKGROUND_SETTLE_TIMEOUT_MS = 5000;
  const BACKGROUND_SETTLE_INTERVALS_MS = [50, 50, 100, 250, 500];

  test('hovering the Random Order switch actually changes its background', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Show Advanced Options/i }).click();

    const toggle = page.getByRole('switch', { name: /Random Order/i });
    await expect(toggle).toBeVisible();

    const background = () => toggle.evaluate(el => getComputedStyle(el).backgroundColor);

    // Park the pointer somewhere harmless first, so the "resting" reading is
    // genuinely un-hovered however the previous action left the mouse.
    await page.mouse.move(0, 0);
    const resting = await background();

    await toggle.hover();
    await expect.poll(background, {
      message: '.lobby-row-hoverable:hover lost to the unlayered .lobby-row background',
    }).not.toBe(resting);
  });

  /**
   * The roster row (LobbyShared.tsx, PlayerList) paired `hover:bg-white` with
   * a plain (non-hover) `dark:bg-slate-800/50` — white-on-white made the light
   * hover invisible, and the unconditional dark rule gave no hover cue at all
   * in dark mode (it wins over the hover rule whether or not the row is
   * hovered). Fixed to `hover:bg-indigo-50 dark:hover:bg-slate-700/60`.
   *
   * Checked on another player's row in a real online lobby, not the local
   * one: LocalLobby has no concept of "other players" (`isMe` is
   * unconditionally true there), so every row already carries the always-on
   * own-row highlight — which differs from any hover colour regardless of
   * whether the hover utility does anything at all, masking exactly the bug
   * this guards. This is the case the custom no-conflicting-classnames lint
   * rule misses: it does not reason about a hover variant fighting an
   * unscoped dark variant on the same property.
   *
   * The same room also lets this test check the other half of that
   * always-on own-row highlight directly: AliceHost's own row (the one that
   * masks a broken hover cue above) is read fresh in each theme and must
   * actually read as dark in dark mode and light in light mode, not just
   * differ from whatever it was before.
   */
  test('hovering another player\'s roster row changes its background in both light and dark mode', async ({ browser }, testInfo: TestInfo) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = `E2E-HOVER-${testInfo.project.name}-w${testInfo.workerIndex}-${Date.now()}`;
    await joinOnlineRoomPair({ page: pageA, name: 'AliceHost' }, { page: pageB, name: 'BobGuest' }, roomId);
    await expect(pageA.getByText('AliceHost').first()).toBeVisible({ timeout: 15000 });
    await expect(pageA.getByText('BobGuest').first()).toBeVisible({ timeout: 15000 });

    // BobGuest's row, read from AliceHost's page: not "isMe", so it never
    // carries the own-row highlight.
    const row = pageA.locator('.player-name', { hasText: 'BobGuest' }).locator('xpath=..');
    const background = () => row.evaluate(el => getComputedStyle(el).backgroundColor);

    // AliceHost's own row, read from her own page: this one IS "isMe", so it
    // carries the always-on own-row highlight instead of a hover cue — a
    // light tint in light mode, a dark tint in dark mode (LobbyShared.tsx).
    // Read alongside Bob's row below rather than in a separate test, so it
    // reuses this same online room instead of paying for a second one.
    const ownRow = pageA.locator('.player-name', { hasText: 'AliceHost' }).locator('xpath=..');
    const ownBackground = () => ownRow.evaluate(el => getComputedStyle(el).backgroundColor);

    // transition-colors animates the background over ~150ms — settle before
    // sampling, or a resting/hover pair caught mid-animation can differ by
    // residual interpolation alone and pass for the wrong reason.
    //
    // Two consecutive equal readings rather than a sleep longer than the
    // transition: it waits on the thing itself instead of on a clock that has
    // to be re-tuned whenever the duration changes, and it returns as soon as
    // the colour has actually stopped.
    const settledBackground = async (readBackground: () => Promise<string>, what: string): Promise<string> => {
      let previous = await readBackground();
      await expect.poll(async () => {
        const current = await readBackground();
        const unchanged = current === previous;
        previous = current;
        return unchanged;
      }, {
        message: `${what} was still changing colour after ${BACKGROUND_SETTLE_TIMEOUT_MS}ms — no reading of it settled`,
        timeout: BACKGROUND_SETTLE_TIMEOUT_MS,
        intervals: BACKGROUND_SETTLE_INTERVALS_MS,
      }).toBe(true);
      return previous;
    };

    // Same oklab/oklch-aware colour parsing the A8 contrast probe above needs
    // for the same reason: this Chromium build echoes a Tailwind v4 palette
    // colour's getComputedStyle() back as oklch()/oklab(), not rgb() — a
    // plain rgba() regex on the own row's background would silently read it
    // as black (alpha 0) and make both thresholds below meaningless. Only the
    // background side is needed here (no foreground colour), composited over
    // the element's own ancestor chain so a translucent tint (e.g.
    // dark:bg-indigo-900/20) reads as it actually paints on screen rather
    // than as its own uncomposited channel.
    const backgroundLuminance = (locator: Locator): Promise<number> => locator.evaluate((el) => {
      const oklabToSrgb255 = (L: number, a: number, b: number): [number, number, number] => {
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
        const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
        const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
        const gamma = (c: number) => {
          const clamped = Math.max(0, Math.min(1, c));
          return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
        };
        return [gamma(r) * 255, gamma(g) * 255, gamma(bl) * 255];
      };
      const num = (tok: string | undefined, fallback: number): number =>
        tok === undefined ? fallback : parseFloat(tok) / (tok.endsWith('%') ? 100 : 1);
      const parseRGBA = (str: string): [number, number, number, number] => {
        let m = str.match(/^rgba?\(([^)]+)\)$/);
        if (m) {
          const p = m[1].split(/[ ,/]+/).filter(Boolean);
          return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), num(p[3], 1)];
        }
        m = str.match(/^oklch\(([^)]+)\)$/);
        if (m) {
          const p = m[1].split(/[ /]+/).filter(Boolean);
          const [L, C] = [parseFloat(p[0]), parseFloat(p[1])];
          const hRad = parseFloat(p[2]) * Math.PI / 180;
          return [...oklabToSrgb255(L, C * Math.cos(hRad), C * Math.sin(hRad)), num(p[3], 1)];
        }
        m = str.match(/^oklab\(([^)]+)\)$/);
        if (m) {
          const p = m[1].split(/[ /]+/).filter(Boolean);
          return [...oklabToSrgb255(parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])), num(p[3], 1)];
        }
        // 'transparent' and anything unrecognised: alpha 0, so it never
        // contributes to the ancestor background walk below.
        return [0, 0, 0, 0];
      };
      const over = (fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number, number] => {
        const a = fg[3];
        return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
      };
      const luminance = ([r, g, b]: [number, number, number, number]): number => {
        const s = (c: number) => { const n = c / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
        return 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
      };
      const chain: Element[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) chain.unshift(n);
      let bg: [number, number, number, number] = [255, 255, 255, 1];
      for (const n of chain) {
        const c = parseRGBA(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) bg = over(c, bg);
      }
      return luminance(bg);
    });
    // Thresholds rather than exact colours: LobbyShared.tsx's own-row tint is
    // a separate, actively-changing piece of styling (see the note on this
    // describe block's parent test file section) — this only needs the
    // result to actually read as dark in dark mode and light in light mode,
    // not pin its exact shade.
    const DARK_LUMINANCE_CEILING = 0.2;
    const LIGHT_LUMINANCE_FLOOR = 0.5;

    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') {
        await pageA.getByLabel('Toggle theme').click();
      }
      await pageA.mouse.move(0, 0);
      const resting = await settledBackground(background, `BobGuest's un-hovered roster row in ${theme} mode`);

      await test.step(`AliceHost's own roster row reads as ${theme} in ${theme} mode`, async () => {
        await settledBackground(ownBackground, `AliceHost's own roster row in ${theme} mode`);
        const ownLuminance = await backgroundLuminance(ownRow);
        if (theme === 'dark') {
          expect(ownLuminance, `AliceHost's own row luminance ${ownLuminance} should read as dark in dark mode`)
            .toBeLessThan(DARK_LUMINANCE_CEILING);
        } else {
          expect(ownLuminance, `AliceHost's own row luminance ${ownLuminance} should read as light in light mode`)
            .toBeGreaterThan(LIGHT_LUMINANCE_FLOOR);
        }
      });

      await row.hover();
      await expect.poll(background, {
        message: `BobGuest's roster row hover had no visible effect in ${theme} mode`,
      }).not.toBe(resting);

      await pageA.mouse.move(0, 0);
    }

    await contextA.close();
    await contextB.close();
  });
});

/**
 * index.css reads two colours out of Tailwind's theme rather than copying them
 * (`--primary: var(--color-indigo-600)`), which keeps them from drifting the way
 * they did across the v4 upgrade. The catch is that a theme variable is only
 * emitted when something references that palette entry — drop the last
 * `bg-indigo-600` from the app and `--color-indigo-600` stops existing, taking
 * `--primary` with it. An unresolvable var() in a custom property computes to
 * the guaranteed-invalid value, which reads back as the empty string, so nothing
 * throws and nothing logs: the focus ring and the checked checkbox just lose
 * their colour.
 */
test.describe('theme colours resolve', () => {
  const SEMANTIC = ['--primary', '--secondary', '--border-color', '--bg-color', '--text-color'];

  /**
   * Six probes against one page load, where each used to pay for its own.
   *
   * Merging them is free of the usual risk: every read below sets `data-theme`
   * itself immediately before its synchronous getComputedStyle call, and every
   * one appends and then removes its own probe node — so no state carries from
   * one step to the next and their order is not load-bearing.
   *
   * `expect.soft` throughout, so a broken mechanism still lets the other five
   * report. What a merged test cannot survive is a THROW — a crashed page or a
   * failed `page.evaluate` ends it at that step and the rest never run. No step
   * here reads a value an earlier one produced, so a throw costs diagnostics
   * only, never a wrong verdict.
   */
  test('every theme-driven colour mechanism resolves', async ({ page }) => {
    await page.goto('/');

    for (const theme of ['light', 'dark']) {
      await test.step(`every semantic colour has a value in ${theme} mode`, async () => {
        // The list is passed in rather than closed over — page.evaluate runs in
        // the browser, so a second copy written inline here would silently stop
        // covering whatever SEMANTIC grew.
        const values = await page.evaluate(({ theme, names }) => {
          document.documentElement.setAttribute('data-theme', theme);
          const style = getComputedStyle(document.documentElement);
          return Object.fromEntries(names.map(name => [name, style.getPropertyValue(name).trim()]));
        }, { theme, names: SEMANTIC });

        expect.soft(SEMANTIC.filter(name => values[name] === '')).toEqual([]);
      });
    }

    /**
     * B58: `color-scheme` was never set at all, so native chrome the app does
     * not theme itself — form control renderings, the scrollbar track — always
     * rendered light, even under `[data-theme="dark"]`. index.css sets it on
     * `:root` and overrides it in the dark block; this is the one part no unit
     * test can see, because jsdom does not resolve color-scheme into anything
     * `getComputedStyle` reports.
     */
    await test.step('color-scheme on <html> follows data-theme', async () => {
      const read = (theme: string) => page.evaluate((theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        return getComputedStyle(document.documentElement).colorScheme;
      }, theme);

      expect.soft(await read('light')).toBe('light');
      expect.soft(await read('dark')).toBe('dark');
    });

    /**
     * The `dark:` variant and the `[data-theme="dark"]` rules above are two
     * different mechanisms — the first is a `@custom-variant` in index.css, the
     * second an ordinary selector — and only the second is covered by the steps
     * above. The variant replaced a `darkMode` array in the deleted JS config, and
     * getting it wrong compiles `dark:` back to `prefers-color-scheme`, which
     * fails only for a reader whose OS theme disagrees with the in-app toggle.
     */
    await test.step('the dark: variant follows the attribute, not the OS', async () => {
      const read = (theme: string) => page.evaluate((theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        const probe = document.createElement('div');
        probe.className = 'bg-white dark:bg-slate-800';
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      }, theme);

      const light = await read('light');
      const dark = await read('dark');

      expect.soft(light).not.toBe(dark);
      expect.soft(light).toBe('rgb(255, 255, 255)');
    });

    /**
     * A player's name is drawn in their own colour, fitted per theme because most
     * colours legible on the light card are illegible on the dark one and vice
     * versa. React sets both fitted values as custom properties and `.player-name`
     * in index.css picks between them, so the switch is pure CSS — which means the
     * unit suite can only assert that the two properties are set, never that the
     * right one wins. That half lives here.
     */
    await test.step('a player name follows the theme through its two custom properties', async () => {
      const read = (theme: string) => page.evaluate((theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        const probe = document.createElement('div');
        probe.className = 'player-name';
        // Stand-ins for what readableNameVars emits, distinct enough that a rule
        // reading the wrong one, or neither, is unmistakable.
        probe.style.setProperty('--player-name-light', 'rgb(1, 2, 3)');
        probe.style.setProperty('--player-name-dark', 'rgb(250, 251, 252)');
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      }, theme);

      expect.soft(await read('light')).toBe('rgb(1, 2, 3)');
      expect.soft(await read('dark')).toBe('rgb(250, 251, 252)');
    });

    /**
     * `.player-name` is unlayered, like every other class rule in index.css, so it
     * has to outrank a text-* utility landing on the same element — otherwise a
     * colour utility added to one of those four elements later would silently take
     * the fitted colour away and put an unreadable one back.
     */
    await test.step('a player name outranks a colour utility on the same element', async () => {
      const color = await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        const probe = document.createElement('div');
        probe.className = 'player-name text-red-500';
        probe.style.setProperty('--player-name-light', 'rgb(1, 2, 3)');
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });

      expect.soft(color).toBe('rgb(1, 2, 3)');
    });
  });
});

// Re-homed from 'theme colours resolve', which had accumulated probes with no
// theme in them: a describe's name is what a `-g` gate selects on, and that
// one was selecting four tests for the price of one.
test.describe('scroll containment', () => {
  /**
   * A scroller that reaches its end hands the rest of the gesture to the page
   * behind it — scroll chaining — so scrolling to the bottom of the wiki carried
   * on into the app underneath. `overscroll-contain` stops the handoff.
   *
   * Asserted on the real element rather than an injected probe: the unit suites
   * already pin that each scroller carries the class, and what is left to prove
   * is the half jsdom cannot — that it resolves to `contain` in a browser rather
   * than being dropped by the cascade.
   *
   * Playwright's WebKit is NOT Safari, and this property is where that shows:
   * measured 2026-08-19, its `CSS.supports('overscroll-behavior-y','contain')`
   * is false and an inline declaration does not even take, while real iOS
   * Safari has supported it since 16.0 (caniuse) — which is the platform this
   * change is aimed at. So the containment half is skipped there rather than
   * passed vacuously, and the scroll-container half, which every engine can
   * answer, is asserted first and unconditionally.
   */
  test("the wiki's scroller contains its overscroll instead of chaining to the page", async ({ page }) => {
    await page.goto('/');
    await page.getByTitle('Open Help / Wiki').click();

    const scroller = page.locator('[role="dialog"] .overflow-y-auto').first();
    await expect(scroller).toBeVisible();

    const behaviour = await scroller.evaluate(node => ({
      overflowY: getComputedStyle(node).overflowY,
      containment: getComputedStyle(node).getPropertyValue('overscroll-behavior-y'),
      supported: typeof CSS !== 'undefined' && !!CSS.supports
        && CSS.supports('overscroll-behavior-y', 'contain'),
    }));

    // `overscroll-behavior` only applies to an actual scroll container, so a
    // rule that lost its overflow would make the containment inert while still
    // reading as set. Checked everywhere, before the skip below.
    expect(behaviour.overflowY).toBe('auto');

    test.skip(!behaviour.supported, 'this WebKit build does not implement overscroll-behavior; real iOS Safari 16+ does');
    expect(behaviour.containment).toBe('contain');
  });
});

test.describe('phone layouts: bottom clearance and the landscape variant', () => {
  /**
   * Two controls float over every screen: the help button (bottom-left) and
   * the theme/language row (bottom-right). Game.tsx has always cleared them
   * with `pb-20`; Statistics and the end screen had only their own `py-8`, so
   * the last row of a table or a chart sat underneath them on a phone.
   *
   * Measured against the button's real box rather than asserting `80px`, so
   * this stays true if the button is ever resized — and it is jsdom-proof only
   * here: layout is the whole assertion.
   */
  test('the statistics page clears the floating controls at the bottom', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 700 });
    await page.goto('/');
    await page.getByRole('button', { name: 'View Statistics' }).click();

    const container = page.getByTestId('statistics-page');
    await expect(container).toBeVisible();

    const help = page.getByTitle('Open Help / Wiki');
    const helpBox = await help.boundingBox();
    const viewport = page.viewportSize()!;
    // How far up the screen the floating button reaches from the bottom edge.
    const occupied = viewport.height - helpBox!.y;

    const paddingBottom = await container.evaluate(node =>
      parseFloat(getComputedStyle(node).paddingBottom));

    // Guards the guard: a button that measured as taking no space at all would
    // make the comparison below pass for any padding, including none.
    expect(occupied).toBeGreaterThan(40);
    expect(paddingBottom).toBeGreaterThanOrEqual(occupied);
  });

  /**
   * The other `@custom-variant`, and the other half of what the deleted JS
   * config used to hold. The scoreboard reflows into a row on a sideways phone
   * (Scoreboard.tsx); a width breakpoint alone would also catch a portrait one,
   * which has the height to lay the tiles out normally.
   */
  test('the phone-landscape variant applies only lying down', async ({ page }) => {
    await page.goto('/');

    const widthAt = async (viewport: { width: number; height: number }) => {
      await page.setViewportSize(viewport);
      return page.evaluate(() => {
        const probe = document.createElement('div');
        probe.className = 'phone-landscape:min-w-[75px]';
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).minWidth;
        probe.remove();
        return value;
      });
    };

    // Only the positive case has an exact value; unset min-width reads back as
    // `auto` or `0px` depending on the engine, so the others assert absence.
    expect(await widthAt({ width: 850, height: 420 })).toBe('75px');       // sideways phone
    expect(await widthAt({ width: 420, height: 850 })).not.toBe('75px');   // same phone, upright
    expect(await widthAt({ width: 1280, height: 800 })).not.toBe('75px');  // desktop
  });
});

/**
 * A8 — a contrast pass on a handful of accent/caption colours that shipped
 * below WCAG AA (4.5:1 for text, 3:1 for large text) once the v3->v4 palette
 * swap left several `text-*-500/600` utilities with no `dark:` twin, and a
 * couple of gray-on-white captions under 3:1 in light mode.
 *
 * The ratio itself is computed here rather than in a unit test: the app's own
 * contrastRatio (src/utils/contrastColor.ts) takes hex, but Tailwind v4's
 * palette is defined in oklch and only resolves to a concrete rgb() once a
 * real browser has laid the page out — exactly the case the task allowed
 * falling back to an e2e probe for. The algorithm below is the same WCAG 2.1
 * relative-luminance formula contrastColor.ts uses, reading getComputedStyle()
 * instead of a hex literal.
 */
test.describe('WCAG AA contrast — accent and caption fixes (A8)', () => {
  const AA_TEXT = 4.5;
  const AA_LARGE = 3;

  const contrastOf = (locator: Locator): Promise<number> => locator.evaluate((el) => {
    // getComputedStyle().color on a Tailwind v4 utility comes back as a raw
    // 'oklch(L C H)' (or 'oklab(L a b)' for a colourless mix like bg-black/5)
    // string in this Chromium build, not rgb()/rgba() — confirmed by probing
    // a real `text-indigo-600` node, and a canvas fillStyle round-trip does
    // NOT normalise it either (its getter echoes the oklch string back
    // unchanged). A plain rgba() regex over either therefore silently read
    // every colour as black-on-transparent and every ratio came back exactly
    // 1. This converts oklab/oklch to sRGB directly with the standard
    // OKLab<->linear-sRGB matrices (Björn Ottosson's oklab reference), the
    // same math every CSS-color-4-aware engine uses internally.
    const oklabToSrgb255 = (L: number, a: number, b: number): [number, number, number] => {
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
      const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
      const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
      const gamma = (c: number) => {
        const clamped = Math.max(0, Math.min(1, c));
        return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
      };
      return [gamma(r) * 255, gamma(g) * 255, gamma(bl) * 255];
    };
    // A token ending in '%' is a percentage of its own axis (alpha: 0-100%,
    // oklch chroma/lightness: 0-100% of that axis's own reference range) —
    // only alpha is ever hit here in practice, so '%' is just read as /100.
    const num = (tok: string | undefined, fallback: number): number =>
      tok === undefined ? fallback : parseFloat(tok) / (tok.endsWith('%') ? 100 : 1);

    const parseRGBA = (str: string): [number, number, number, number] => {
      let m = str.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[ ,/]+/).filter(Boolean);
        return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), num(p[3], 1)];
      }
      m = str.match(/^oklch\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[ /]+/).filter(Boolean);
        const [L, C] = [parseFloat(p[0]), parseFloat(p[1])];
        const hRad = parseFloat(p[2]) * Math.PI / 180;
        return [...oklabToSrgb255(L, C * Math.cos(hRad), C * Math.sin(hRad)), num(p[3], 1)];
      }
      m = str.match(/^oklab\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[ /]+/).filter(Boolean);
        return [...oklabToSrgb255(parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])), num(p[3], 1)];
      }
      // 'transparent' and anything unrecognised: alpha 0, so it never
      // contributes to the ancestor background walk below.
      return [0, 0, 0, 0];
    };
    // Composites `fg` over `bg`, both already resolved to opaque channels.
    const over = (fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number, number] => {
      const a = fg[3];
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const s = (c: number) => { const n = c / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
      return 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
    };
    // Several of the elements below sit on a translucent card (--card-bg is
    // rgba, not opaque) over the page background, so the background actually
    // behind the text is composited down the ancestor chain rather than read
    // off the nearest parent alone.
    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.unshift(n);
    let bg: [number, number, number, number] = [255, 255, 255, 1];
    for (const n of chain) {
      const c = parseRGBA(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) bg = over(c, bg);
    }
    const fg = over(parseRGBA(getComputedStyle(el).color), bg);
    const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  });

  const setTheme = (page: Page, theme: 'light' | 'dark') =>
    page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);

  /**
   * Stop & Score always banks the turn as a win (DiceGame.tsx's `stop` branch
   * dispatches `TURN_BANKED` with `won: true` unconditionally), so once a die
   * is selectable the win is guaranteed; rollUntilSelectable handles the rare
   * busted opening roll.
   */
  const winATurn = async (page: Page) => {
    await rollUntilSelectable(page);
    await page.getByRole('button', { name: /Select all/i }).click();
    await page.getByRole('button', { name: /Stop & Score/i }).click();
  };

  for (const theme of ['light', 'dark'] as const) {
    /**
     * One game start for both readings. They used to boot the same game twice
     * — seed, goto, setTheme, startLocalGame — and the goal number is on screen
     * before the turn is won, so reading it first and then carrying on into
     * winATurn walks exactly the same states in exactly the same order.
     *
     * The goal half is soft so a failing ratio there still lets the summary
     * report; the summary half stays hard, because winATurn is a click
     * sequence and carrying on past a soft failure would mean clicking against
     * a screen that is not where the test thinks it is. (Soft does not cover
     * everything: if the goal line never renders at all, the contrast read
     * throws and the summary half is lost with it. Soft buys the report for
     * the failure this actually guards — a legible element with a bad ratio.)
     *
     * The merged test measures ~7 s on webkit locally against the 30 s default
     * timeout, and a loaded CI run costs more than a local one — so it must not
     * grow further without a `test.setTimeout` of its own.
     */
    test(`the goal number clears AA in ${theme} mode, and so does the dice summary`, async ({ page }) => {
      await seedLocalDeck(page);
      await page.goto('/');
      await setTheme(page, theme);
      await startLocalGame(page);

      await test.step(`the goal number clears AA in ${theme} mode`, async () => {
        // The default fallback string in Leaderboard.tsx reads "Goal:" — but
        // en/translation.json overrides it to the same "Goal:", and that
        // loaded string, not the fallback, is what actually renders.
        const goalLine = page.getByText('Goal:');
        await expect.soft(goalLine).toBeVisible();
        expect.soft(await contrastOf(goalLine.locator('strong'))).toBeGreaterThanOrEqual(AA_TEXT);
      });

      await test.step(`the dice summary's win heading and points-gained value clear AA in ${theme} mode`, async () => {
        await winATurn(page);

        // The summary fades in (motion opacity 0 -> 1). toBeVisible is
        // satisfied at opacity 0, and contrastOf composes through ancestor
        // opacity, so a one-shot read taken mid-fade reports ~1:1 — it did,
        // once, under a loaded full run. Poll until the entrance has settled.
        const heading = page.getByRole('heading', { name: 'Success!' });
        await expect(heading).toBeVisible();
        await expect.poll(() => contrastOf(heading)).toBeGreaterThanOrEqual(AA_LARGE);

        const pointsLine = page.getByText('Points gained:');
        await expect(pointsLine).toBeVisible();
        await expect.poll(() => contrastOf(pointsLine.locator('strong'))).toBeGreaterThanOrEqual(AA_TEXT);
      });
    });

    test(`the join-room error text clears AA in ${theme} mode`, async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
      await page.getByRole('button', { name: /Online Play/i }).click();
      await page.getByRole('button', { name: /Join \/ Create/i }).click();

      const error = page.getByText('Please enter both a Room Code and a Name.');
      await expect(error).toBeVisible();
      expect(await contrastOf(error)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});

/**
 * A9 — the fixed HUD (language switcher + theme toggle, App.tsx) sits
 * bottom-right at every width (B10c). That used to put it directly over the
 * dice panel's action row (Stop & Score / Roll Again) on a phone, because the
 * panel reserved no bottom space for it; the fix is on the panel's side now —
 * its scroll area (DiceGame.tsx) carries extra bottom padding on phones so
 * the action row clears the HUD's footprint instead of the HUD moving out of
 * the way. The help trigger (HelpPopup.tsx) was once `z-50`, the same layer
 * as the dice panel's own backdrop (`.modal-backdrop-under-hud`) and earlier
 * in the DOM, so it lost the paint order tie and was unreachable while the
 * dice panel was open.
 */
test.describe('HUD vs dice panel, help button z-order (A9)', () => {
  interface Box { x: number; y: number; width: number; height: number; }

  const intersects = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  // A box read only once two consecutive reads agree: the dice panel scales
  // and slides into place as it opens (Game.tsx's motionProps), and a box
  // read mid-entrance sits lower and larger than where the row ends up —
  // enough, once on WebKit, to "intersect" a HUD it does not touch at rest.
  const BOX_SETTLE_POLL_MS = 100;
  const BOX_SETTLE_ATTEMPTS = 20;
  const settledBox = async (locator: Locator) => {
    let previous = await locator.boundingBox();
    for (let i = 0; i < BOX_SETTLE_ATTEMPTS; i++) {
      await locator.page().waitForTimeout(BOX_SETTLE_POLL_MS);
      const next = await locator.boundingBox();
      if (JSON.stringify(next) === JSON.stringify(previous)) return next;
      previous = next;
    }
    return previous;
  };

  const openDicePanelOnPhone = async (page: Page) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);
    await rollUntil(page, page.getByRole('button', { name: /Stop & Score/i }));
  };

  /**
   * Both halves want the same screen — a dice panel open on a phone — and used
   * to boot one each. Merging them halves the boots, which is worth more than
   * the page loads: openDicePanelOnPhone goes through the same bust-retrying
   * rollUntil as every other panel opener, waiting for Stop & Score.
   *
   * Order is load-bearing: the action-row half reads a screen that the help
   * half then changes by opening the wiki, so it goes first. Its assertions are
   * soft (a covered action row must not stop the z-order half from reporting);
   * the help half stays hard, because each of its steps is what puts the screen
   * where the next one expects it.
   */
  test('the HUD clears the dice panel action row, and the help trigger stays above its backdrop, at 375x812', async ({ page }) => {
    await openDicePanelOnPhone(page);

    await test.step('the language switcher and theme toggle do not cover the dice panel action row', async () => {
      const languageSwitcher = page.getByLabel('Switch to English').locator('xpath=..');
      const themeToggle = page.getByLabel('Toggle theme');
      const stopButton = page.getByRole('button', { name: /Stop & Score/i });
      const rollAgainButton = page.getByRole('button', { name: /Roll Again/i });

      const languageBox = await languageSwitcher.boundingBox();
      const themeBox = await themeToggle.boundingBox();
      const stopBox = await settledBox(stopButton);
      expect.soft(languageBox).not.toBeNull();
      expect.soft(themeBox).not.toBeNull();
      expect.soft(stopBox).not.toBeNull();
      // Returned on rather than `!`-dereferenced: a soft failure does not
      // throw, so reading .x off a null box here would TypeError and take the
      // help-trigger half down with it — which is what soft is here to prevent.
      if (!languageBox || !themeBox || !stopBox) return;

      expect.soft(intersects(languageBox, stopBox)).toBe(false);
      expect.soft(intersects(themeBox, stopBox)).toBe(false);

      // B10c: the HUD sits bottom-right now, not top-right — confirm it
      // actually landed there rather than merely failing to overlap the
      // action row by accident. hud is the fixed wrapper itself (App.tsx),
      // reached the same way B58 below reaches it: the theme toggle's own
      // parent.
      const hud = page.getByLabel('Toggle theme').locator('xpath=..');
      const hudBox = await hud.boundingBox();
      expect.soft(hudBox).not.toBeNull();
      if (hudBox) {
        const phoneViewportHeightPx = 812;
        const bottomQuarterStartY = phoneViewportHeightPx * 0.75;
        expect.soft(hudBox.y).toBeGreaterThanOrEqual(bottomQuarterStartY);
      }

      // Roll Again is absent only on the rare turn that already made a tutto —
      // checked when present rather than asserted unconditionally.
      if (!(await rollAgainButton.isVisible())) return;
      const rollAgainBox = await settledBox(rollAgainButton);
      expect.soft(rollAgainBox).not.toBeNull();
      if (!rollAgainBox) return;

      expect.soft(intersects(languageBox, rollAgainBox)).toBe(false);
      expect.soft(intersects(themeBox, rollAgainBox)).toBe(false);
    });

    await test.step('the help trigger sits above the dice panel backdrop and stays clickable', async () => {
      const helpButton = page.getByTitle('Open Help / Wiki');
      const backdrop = page.locator('.modal-backdrop-under-hud');
      await expect(backdrop).toBeVisible();
      await expect(helpButton).toBeVisible();

      const helpZ = Number(await helpButton.evaluate(el => getComputedStyle(el).zIndex));
      const backdropZ = Number(await backdrop.evaluate(el => getComputedStyle(el).zIndex));
      expect(helpZ).toBeGreaterThan(backdropZ);

      await helpButton.click();
      await expect(page.getByRole('heading', { name: 'Tutto Wiki' })).toBeVisible();
    });
  });

  /**
   * A10 — before B10c, the HUD sat top-right on phones (it now sits
   * bottom-right at every width, same as the dice panel case above), and it
   * used to sit over whatever the current screen put in its own top-right
   * corner: the Scoreboard's Score tile during ordinary play, and the centred
   * main heading on Home. Both tests below now pass trivially — a
   * bottom-right HUD is nowhere near either target — and stay only as a
   * regression guard against the HUD moving back to the top.
   */
  test('the language switcher and theme toggle do not cover the Scoreboard tiles at 375x812 with the dice panel closed', async ({ page }) => {
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);
    await page.setViewportSize({ width: 375, height: 812 });
    // Resizing the viewport keeps the prior scroll offset, which at the wider
    // desktop size (used above so the lobby's icon-only "Add" button keeps its
    // accessible name) can leave the top of the page scrolled out of view —
    // scroll back up so the boxes below reflect what a phone visitor actually
    // sees on arrival.
    await page.evaluate(() => window.scrollTo(0, 0));

    const languageSwitcher = page.getByLabel('Switch to English').locator('xpath=..');
    const themeToggle = page.getByLabel('Toggle theme');
    // The tile label sits directly inside its tile container (Scoreboard.tsx),
    // so one level up from the label text is the whole tile's bounding box.
    const currentPlayerTile = page.getByText('Current Player').locator('xpath=..');
    // 'Score' alone also names the Leaderboard's column header further down
    // the page (Leaderboard.tsx) — .first() takes the Scoreboard's own tile,
    // which renders earlier in the DOM.
    const scoreTile = page.getByText('Score', { exact: true }).first().locator('xpath=..');

    const languageBox = await languageSwitcher.boundingBox();
    const themeBox = await themeToggle.boundingBox();
    const currentPlayerBox = await currentPlayerTile.boundingBox();
    const scoreBox = await scoreTile.boundingBox();
    expect(languageBox).not.toBeNull();
    expect(themeBox).not.toBeNull();
    expect(currentPlayerBox).not.toBeNull();
    expect(scoreBox).not.toBeNull();

    expect(intersects(languageBox!, currentPlayerBox!)).toBe(false);
    expect(intersects(themeBox!, currentPlayerBox!)).toBe(false);
    expect(intersects(languageBox!, scoreBox!)).toBe(false);
    expect(intersects(themeBox!, scoreBox!)).toBe(false);
  });

  test('the language switcher and theme toggle do not cover the Home screen main heading at 375x812', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const languageSwitcher = page.getByLabel('Switch to English').locator('xpath=..');
    const themeToggle = page.getByLabel('Toggle theme');
    const heading = page.getByRole('heading', { level: 1 });

    const languageBox = await languageSwitcher.boundingBox();
    const themeBox = await themeToggle.boundingBox();
    const headingBox = await heading.boundingBox();
    expect(languageBox).not.toBeNull();
    expect(themeBox).not.toBeNull();
    expect(headingBox).not.toBeNull();

    expect(intersects(languageBox!, headingBox!)).toBe(false);
    expect(intersects(themeBox!, headingBox!)).toBe(false);
  });
});

/**
 * B58 — safe areas. viewport-fit=cover (index.html) lets the page draw under
 * a phone's notch/home-indicator; without it the browser never reports a
 * non-zero env(safe-area-inset-*), so the HUD's padding (App.tsx) would be a
 * no-op on exactly the hardware it targets. The HUD sits bottom-right at
 * every width now (B10c) — the inset it pads from is the bottom one, since
 * that's the edge it actually touches (a home-indicator bar), not the top.
 */
test.describe('safe-area viewport (B58)', () => {
  /**
   * Two reads off one loaded page, where each used to pay for its own. Neither
   * half mutates anything, so nothing carries between them and their order is
   * free; `expect.soft` throughout, so a dropped meta tag and a dropped padding
   * utility are two failures rather than one.
   */
  test('the page opts into device cutouts and the HUD pads for them', async ({ page }) => {
    await page.goto('/');

    await test.step('the viewport meta opts into drawing under device cutouts', async () => {
      const content = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect.soft(content).toContain('viewport-fit=cover');
    });

    await test.step('the HUD declares its padding from the safe-area inset', async () => {
      // A real cutout cannot be simulated here, and a computed padding-bottom
      // is "0px" both with the env() rule (inset 0 on this hardware) and with
      // no rule at all — so the value proves nothing. What can regress is the
      // declaration: the utility being dropped from App.tsx, or Tailwind no
      // longer emitting a rule for it. Check both.
      const hud = page.getByLabel('Toggle theme').locator('xpath=..');
      const className = await hud.evaluate(el => el.className);
      expect.soft(className).toContain('pb-[env(safe-area-inset-bottom)]');

      const declared = await page.evaluate(() =>
        Array.from(document.styleSheets).some(sheet => {
          try {
            return Array.from(sheet.cssRules).some(rule => rule.cssText.includes('env(safe-area-inset-bottom)'));
          } catch {
            return false;
          }
        }));
      expect.soft(declared, 'no stylesheet rule mentions env(safe-area-inset-bottom)').toBe(true);
    });
  });
});

/**
 * C65 — a handful of game-time controls had tap targets well under the 44px
 * WCAG 2.5.5 minimum at 375px: "Select all" (72×26), the quick-add score
 * chips (~32px tall), the local lobby's reorder/kick icon buttons (32×32),
 * the in-game Kick pill on a disconnected player's row (~20px tall), and the
 * HUD's language buttons (~28px tall). Each grew its own hit area — via
 * min-h-11/min-w-11 plus, wherever the control shares a row with other
 * content whose spacing must not shift, a symmetric negative vertical margin
 * that hands the added height back (see the comments at each call site) —
 * without enlarging the visible chip itself. Only a real browser lays these
 * rows out to measure; jsdom cannot.
 */
test.describe('tap targets ≥ 44px on game-time controls (C65)', () => {
  const MIN_TAP_TARGET_PX = 44;

  /**
   * Measure a tap target, polling until its layout has settled.
   *
   * Every screen these controls sit on animates in (framer-motion: the roster
   * tweens height 0 -> auto with its rows sliding in, the game entrance slides
   * its columns, the leaderboard rows scale). A child measured during a
   * parent's tween reports a fraction under its settled size — so a one-shot
   * boundingBox() turns a passing control into a failure that varies per run
   * and per browser rather than reproducing. The lobby probe below read
   * 43.79-43.96 against the 44 its CSS asks for, on CI and locally alike.
   *
   * Polling keeps the assertion honest rather than loosening it: a control
   * that never reaches 44 still fails, on the real number, once the poll
   * gives up. A tolerance would have hidden that.
   */
  const expectTapTarget = async (
    locator: Locator,
    sides: readonly ('height' | 'width')[],
    what: string,
  ): Promise<void> => {
    await expect(locator, `${what} is not visible`).toBeVisible({ timeout: 15000 });
    for (const side of sides) {
      await expect
        .poll(async () => (await locator.boundingBox())?.[side] ?? 0, { message: `${what} ${side}` })
        .toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    }
  };

  test('the quick-add score chips are at least 44px tall on phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedLocalDeck(page);
    await page.goto('/');
    // Physical dice mode is what renders the manual score entry row and its
    // quick-add chips (GameControls.tsx) — the digital path never shows them.
    await page.getByLabel(/Physical Dice/i).click();
    await startLocalGame(page);

    // The chips share one class string, so the first and last of the eight
    // stand in for the whole row (same reasoning the rest of this file uses
    // for a shared class: one representative element, not all of them).
    for (const val of [50, 1000]) {
      await expectTapTarget(page.getByTestId(`quick-add-${val}`), ['height'], `+${val} chip`);
    }
  });

  test('"Select all" is at least 44px in both dimensions on phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);

    await rollUntilSelectable(page);
    await expectTapTarget(
      page.getByRole('button', { name: /Select all/i }), ['height', 'width'], 'Select all',
    );
  });

  test('the language switcher buttons are at least 44px in both dimensions on phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    for (const label of ['Switch to English', 'Switch to German']) {
      await expectTapTarget(page.getByLabel(label), ['height', 'width'], label);
    }
  });

  test('the local lobby\'s reorder/kick controls are at least 44px tall on phone, and a 5-player roster still fits without new scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const playerInput = page.getByPlaceholder(/Player name/i);
    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
    for (const name of names) {
      await playerInput.fill(name);
      await page.getByRole('button', { name: /^Add$/i }).click();
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }

    // Only these two utilities changed size (LobbyShared.tsx keeps the
    // buttons' width at 32px on phone — see the PR notes); height is what
    // was under 44px and what this checks.
    const moveDown = page.getByRole('button', { name: /Move down: Alice/i });
    const remove = page.getByRole('button', { name: /Remove: Bob/i });
    await expectTapTarget(moveDown, ['height'], 'Move down: Alice');
    await expectTapTarget(remove, ['height'], 'Remove: Bob');

    // The taller tap targets must not have grown the ROW itself — that's what
    // the negative margin on each button is for, and it's what keeps a
    // 5-player roster fitting the same footprint it always did (asserting on
    // total page scrollHeight instead would be measuring Home's title and
    // mode tabs above the roster too, which this change never touched).
    // Pre-fix this row was ~56px tall (p-3's 24px of padding plus a 32px-tall
    // button); min-h-11 without the compensating margin would have pushed it
    // to ~68px. 64px draws the line well clear of either number as noise but
    // well short of the regression.
    const aliceRow = page.locator('.player-name', { hasText: 'Alice' }).locator('xpath=..');
    const rowBox = await aliceRow.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.height).toBeLessThanOrEqual(64);
  });

  test('the in-game Kick pill on a disconnected player is at least 44px in both dimensions on phone', async ({ browser }, testInfo: TestInfo) => {
    test.setTimeout(60000);
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    try {
      const pageB = await contextB.newPage();

      const roomId = `E2E-KICKSIZE-${testInfo.project.name}-w${testInfo.workerIndex}-${Date.now()}`;
      await joinOnlineRoomPair({ page: pageA, name: 'AliceHost' }, { page: pageB, name: 'BobGuest' }, roomId);
      await expect(pageA.getByText('AliceHost').first()).toBeVisible({ timeout: 15000 });
      await expect(pageA.getByText('BobGuest').first()).toBeVisible({ timeout: 15000 });

      await pageA.getByRole('button', { name: /Start Game!/i }).click();
      await expect(pageA.getByText(/Current Player/i).first()).toBeVisible({ timeout: 15000 });

      // The Kick pill (Leaderboard.tsx) only renders for the host, next to a
      // player the server has marked disconnected — closing Bob's context
      // drops his socket's transport, which the server treats as an immediate
      // disconnect (socketRoomHandlers.ts sets `disconnected = true` and
      // broadcasts right away; it does not wait out the reconnect timeout).
      await contextB.close();

      await pageA.setViewportSize({ width: 375, height: 812 });

      await expectTapTarget(
        pageA.getByRole('button', { name: 'Kick' }), ['height', 'width'], 'Kick pill',
      );

    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

/**
 * U-1 — the language switcher's buttons are a transparent 44px hit area
 * (C65 above) with the visible EN/DE pill on an inner span; the button's own
 * focus outline used to draw around that invisible box instead of the pill.
 * LanguageSwitcher.tsx now hides the button's outline
 * (focus-visible:outline-hidden) and puts a ring on the pill instead
 * (group-focus-visible:ring-2 group-focus-visible:ring-indigo-500). The unit
 * test pins the classes; only a real browser can confirm the outline is
 * actually gone and the ring (a box-shadow) is actually there once the
 * button is reached by real keyboard navigation.
 */
test.describe('language switcher keyboard focus ring sits on the pill (U-1)', () => {
  const TAB_ATTEMPTS = 40;

  test('the button shows no outline and the pill grows a ring once Tab reaches it', async ({ page }) => {
    await page.goto('/');

    const button = page.getByLabel('Switch to English');

    // Walk the real tab order from the top of the document, the same bounded
    // loop as the Random Order switch above — reachability (and genuine
    // :focus-visible, which locator.focus() cannot guarantee on every
    // engine) is the whole point.
    await page.evaluate(() => document.body.focus());
    let reached = false;
    for (let i = 0; i < TAB_ATTEMPTS && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await button.evaluate(el => el === document.activeElement);
    }
    expect(reached, 'Tab never reached the EN language button').toBe(true);

    await expect(button).toHaveCSS('outline-style', 'none');

    const pill = page.getByText('EN', { exact: true });
    const boxShadow = await pill.evaluate(el => getComputedStyle(el).boxShadow);
    expect(boxShadow, 'the pill should carry the focus ring as a box-shadow').not.toBe('none');
  });
});

/**
 * C69.2 — the two-tab and three-tab rows (personal/global, ruleset,
 * normal/custom) used to be a plain `flex ... justify-center` row, which
 * wraps onto a second line once the pills no longer fit a phone's width.
 * Statistics.tsx now makes each one `flex-nowrap overflow-x-auto` with
 * `shrink-0` pills, so a row that cannot fit scrolls horizontally instead of
 * wrapping — asserted here as "one line tall", since jsdom (the unit suite)
 * never lays out real widths and so cannot see wrapping happen at all.
 */
test.describe('Statistics tabs stay a single scrollable row on phones (C69.2)', () => {
  test('each tablist is exactly one pill tall at 375x812, not wrapped onto a second line', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.getByRole('button', { name: 'View Statistics' }).click();
    await expect(page.getByTestId('statistics-page')).toBeVisible();

    // The personal tab is selected by default, so all three tablists — the
    // top-level pair, the ruleset pair, and the personal/custom mode pair —
    // are on screen together.
    const tablists = page.getByRole('tablist');
    await expect(tablists).toHaveCount(3);

    const count = await tablists.count();
    for (let i = 0; i < count; i++) {
      const tablist = tablists.nth(i);
      const pillHeight = (await tablist.getByRole('tab').first().boundingBox())!.height;
      const scrollHeight = await tablist.evaluate((el) => el.scrollHeight);

      expect(Math.abs(scrollHeight - pillHeight)).toBeLessThanOrEqual(2);
    }
  });

  // B10a — below `sm:` these rows used to be `sm:justify-center`-only, i.e.
  // left-aligned, even for a row that comfortably fits a phone's width.
  // Statistics.tsx now centers every row via auto margins on its first/last
  // pill instead, which (unlike turning on `justify-center` unconditionally)
  // degrades to a flush, fully-scrollable start once a row genuinely
  // overflows rather than clipping its own left end. Measured from the pills'
  // boxes, not from scrollWidth: for a row that fits, the auto margins are
  // part of the scrollable content, so scrollWidth equals the row width and
  // says nothing about where the pills sit.
  test('each tablist that fits is centered, and none clips its own start (B10a)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.getByRole('button', { name: 'View Statistics' }).click();
    await expect(page.getByTestId('statistics-page')).toBeVisible();

    const tablists = page.getByRole('tablist');
    await expect(tablists).toHaveCount(3);

    const count = await tablists.count();
    for (let i = 0; i < count; i++) {
      // All three boxes from one evaluate, i.e. one frame: the panel these
      // rows sit in slides into place on mount, and three separate
      // boundingBox round trips read the row and its pills at different
      // points of that slide — a few px of "off-centre" that was only motion.
      const { leftGap, rightGap, overflows } = await tablists.nth(i).evaluate((el) => {
        const tabs = el.querySelectorAll('[role="tab"]');
        const row = el.getBoundingClientRect();
        const first = tabs[0].getBoundingClientRect();
        const last = tabs[tabs.length - 1].getBoundingClientRect();
        return {
          leftGap: first.left - row.left,
          rightGap: row.right - last.right,
          overflows: el.scrollWidth > el.clientWidth + 1,
        };
      });

      // Never starts to the left of the row's own edge — the one way that
      // could happen is `justify-center` clipping an overflowing row's start,
      // which is exactly what B10a fixed.
      expect(leftGap, `tablist ${i} clips its start`).toBeGreaterThanOrEqual(-1);
      // And when the row actually fits, it sits in the middle.
      if (!overflows) {
        expect(Math.abs(leftGap - rightGap), `tablist ${i} is off-centre`).toBeLessThanOrEqual(2);
      }
    }
  });

  // The Personal / Global Community row was the one that did not fit a
  // 375px phone (364px of pills in a 277px row): it scrolled, so it sat
  // flush left under two centred rows and cut its second pill off at the
  // card's edge. The card's phone padding and the pills' icons are what
  // went; German labels are longer still, so both languages are checked.
  test('every tablist fits a 375px phone in English and German (B10a)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.getByRole('button', { name: 'View Statistics' }).click();
    await expect(page.getByTestId('statistics-page')).toBeVisible();
    const tablists = page.getByRole('tablist');
    await expect(tablists).toHaveCount(3);

    const expectAllFit = async (language: string) => {
      const count = await tablists.count();
      for (let i = 0; i < count; i++) {
        const { scrollWidth, clientWidth } = await tablists.nth(i).evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(scrollWidth, `${language}: tablist ${i} overflows`).toBeLessThanOrEqual(clientWidth + 1);
      }
    };

    await expectAllFit('en');
    await page.getByLabel('Switch to German').click();
    await expect(page.getByRole('tab', { name: 'Persönlich' })).toBeVisible();
    await expectAllFit('de');
  });

  // B6 — whileHover on these pills scaled a hovered one 1.05×, and since each
  // row is flex-nowrap overflow-x-auto, a transformed pill at the row's end
  // extends the row's scrollable overflow enough to grow a scrollbar under a
  // row that fits. Reported on a desktop while switching rulesets and modes
  // with the mouse, so this hovers the way that report did: desktop width,
  // pointer parked on the pill just switched to. (Rows may legitimately
  // scroll at phone width — that is C69.2's job above, not this test's.)
  test('switching ruleset and mode pills leaves no scrollbar behind (B6)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'View Statistics' }).click();
    await expect(page.getByTestId('statistics-page')).toBeVisible();

    const tablists = page.getByRole('tablist');
    await expect(tablists).toHaveCount(3);

    const expectNoOverflow = async () => {
      const count = await tablists.count();
      for (let i = 0; i < count; i++) {
        const { scrollWidth, clientWidth } = await tablists.nth(i).evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(scrollWidth, `tablist ${i} grew a scrollbar`).toBeLessThanOrEqual(clientWidth + 1);
      }
    };

    for (const name of ['Classic', 'Custom', 'Modernized', 'Normal']) {
      const pill = page.getByRole('tab', { name, exact: true });
      await pill.hover();
      await pill.click();
      await expect(pill).toHaveAttribute('aria-selected', 'true');
      // A hover scale would be a ~200ms tween; give it time to have landed
      // before measuring, so a regression cannot slip through mid-animation.
      await page.waitForTimeout(HOVER_SETTLE_MS);
      await expectNoOverflow();
    }
  });
});
