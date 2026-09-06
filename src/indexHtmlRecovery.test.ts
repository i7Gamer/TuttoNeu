/**
 * The stale-bundle recovery handler in index.html.
 *
 * It is an inline <script> deliberately — it has to run before main.tsx and
 * before any React error boundary exists, so it cannot be a module the app
 * imports. That also means nothing else in the suite covers it. This file
 * reads the real index.html, pulls the inline script out, and evaluates it
 * with addEventListener stubbed so the registered handler can be invoked
 * directly (rather than dispatching events into a window that accumulates a
 * fresh listener for every test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const RELOAD_KEY = 'tutto_last_reload';
const CHUNK_ERROR_MESSAGE = 'Failed to fetch dynamically imported module: /assets/index-abc123.js';
const EXPECTED_INLINE_SCRIPTS = 1;

type ErrorHandler = (e: { message?: string; target?: unknown }) => void;

/**
 * The one inline <script> in a page's <body> — index.html's module tag
 * carries a src, and the pre-paint theme script (see indexHtmlTheme.test.ts)
 * lives in <head>, so scoping to <body> keeps this file's parser pointed at
 * the recovery script alone.
 */
const parseInlineScript = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const inline = Array.from(doc.body.querySelectorAll('script')).filter(
    script => !script.hasAttribute('src')
  );
  if (inline.length !== EXPECTED_INLINE_SCRIPTS) {
    throw new Error(
      `index.html <body> should have ${EXPECTED_INLINE_SCRIPTS} inline <script>, found ${inline.length}`
    );
  }
  return inline[0].textContent ?? '';
};

/** The real index.html on disk, run through the parser above. */
const readInlineScript = (): string =>
  parseInlineScript(fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'));

const inlineScript = readInlineScript();

const readIndexHtml = (): string => fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

// These three meta tags asked the browser not to cache the document at all —
// inert in every current browser, which only honours Cache-Control (and
// Pragma/Expires) from the actual HTTP response headers, never from a <meta
// http-equiv> in the document it already received. server/index.ts now sets
// the real header instead (see the immutable-caching test in server/api.test.ts).
describe('index.html has no inert cache-control metas', () => {
  it('carries no http-equiv meta tag', () => {
    expect(readIndexHtml()).not.toMatch(/<meta\s+http-equiv=/i);
  });
});

/** Evaluates the inline script and returns the 'error' listener it registers. */
const loadHandler = (): ErrorHandler => {
  let captured: ErrorHandler | undefined;
  const addEventListener = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation((type: string, cb: unknown) => {
      if (type === 'error') captured = cb as ErrorHandler;
    });
  try {
    new Function(inlineScript)();
  } finally {
    addEventListener.mockRestore();
  }
  if (!captured) throw new Error('index.html script registered no error listener');
  return captured;
};

const reload = vi.fn();
const cacheDelete = vi.fn(async () => true);
const unregister = vi.fn(async () => true);

const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
};

/** Lets the handler's caches → unregister → reload promise chain settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

// The regex this replaced matched only a bare, lower-case, attribute-free
// <script> that preceded the module tag. Nothing in the suite noticed,
// because index.html happens to satisfy all three. These pin the tolerance
// down so a nonce, a re-case or a reorder in index.html cannot quietly break
// every test in this file at import time.
describe('inline script extraction', () => {
  const INLINE = 'var recovered = true;';
  const MODULE_TAG = '<script type="module" src="/src/main.tsx"></script>';
  const page = (body: string): string => `<html><body>${body}</body></html>`;

  it('finds the inline script whatever the tag case', () => {
    expect(parseInlineScript(page(`<SCRIPT>${INLINE}</SCRIPT>`))).toBe(INLINE);
  });

  it('finds it through attributes on the tag', () => {
    const tagged = `<script nonce="abc123" type="text/javascript">${INLINE}</script>`;
    expect(parseInlineScript(page(tagged))).toBe(INLINE);
  });

  it('picks the inline script even when the module tag comes first', () => {
    expect(parseInlineScript(page(`${MODULE_TAG}<script>${INLINE}</script>`))).toBe(INLINE);
  });

  it('throws when no inline script is left to extract', () => {
    expect(() => parseInlineScript(page(MODULE_TAG))).toThrow(/found 0/);
  });

  it('throws rather than guess when a second inline script appears', () => {
    const two = `<script>${INLINE}</script><script>var other = 1;</script>`;
    expect(() => parseInlineScript(page(two))).toThrow(/found 2/);
  });
});

describe('index.html stale-bundle recovery', () => {
  it('uses plain ES5 only (no optional chaining or nullish coalescing)', () => {
    const optionalChaining = /\?\./;
    const nullishCoalescing = /\?\?/;
    expect(inlineScript).not.toMatch(optionalChaining);
    expect(inlineScript).not.toMatch(nullishCoalescing);
  });

  beforeEach(() => {
    localStorage.clear();
    reload.mockClear();
    cacheDelete.mockClear();
    unregister.mockClear();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.stubGlobal('caches', { keys: vi.fn(async () => ['precache-v1']), delete: cacheDelete });
    Object.defineProperty(window, 'location', {
      value: { reload, href: 'https://tutto.example/' },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistrations: async () => [{ unregister }] },
      configurable: true,
    });
    setOnline(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('wipes the cache, unregisters the worker and reloads on a chunk error', async () => {
    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(cacheDelete).toHaveBeenCalledWith('precache-v1');
    expect(unregister).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  // The whole point of the precache is offline play, and offline is exactly
  // when a chunk fetch fails. Recovering there deletes the caches and
  // unregisters the worker with no network to refill either — turning a
  // recoverable miss into an app that cannot start until it is back online.
  // The 60s throttle does not help: one pass is all the damage there is.
  it('leaves the cache and the worker alone while the device is offline', async () => {
    setOnline(false);

    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(cacheDelete).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  // Going offline must not burn the one attempt the cooldown allows, or
  // coming back online would find a fresh timestamp and skip the recovery.
  it('does not spend the reload cooldown on an offline error', async () => {
    setOnline(false);
    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(localStorage.getItem(RELOAD_KEY)).toBeNull();

    setOnline(true);
    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(reload).toHaveBeenCalled();
  });

  it('still ignores an unrelated third-party script error', async () => {
    loadHandler()({ target: { tagName: 'SCRIPT', src: 'https://cdn.example/analytics.js' } });
    await settle();

    expect(reload).not.toHaveBeenCalled();
  });

  // A privacy mode, a full quota, or a policy can make every localStorage
  // call throw rather than merely return null. Raw calls inside the handler
  // would propagate that throw straight out of the 'error' listener,
  // aborting the recovery before it ever reaches the cache/unregister/reload
  // chain — silently disabling the one path meant to recover a broken deploy.
  it('still recovers when reading the last-reload timestamp throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });

    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(reload).toHaveBeenCalled();
  });

  // Same failure mode on the write side: recording the cooldown timestamp is
  // best-effort bookkeeping for the NEXT error, not a precondition for
  // recovering from THIS one.
  it('still recovers when writing the last-reload timestamp throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });

    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(cacheDelete).toHaveBeenCalled();
    expect(unregister).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  // A hand-edited or corrupted value parses to NaN. `NaN > RELOAD_COOLDOWN_MS`
  // is always false, so the old unguarded comparison fell into "too soon"
  // forever — the recovery path would never fire again until something else
  // cleared the key. A garbage timestamp must count as "no previous reload",
  // the same as the key being absent.
  it('treats a non-numeric stored timestamp as no previous reload, not "too soon" forever', async () => {
    localStorage.setItem(RELOAD_KEY, 'not-a-number');

    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(reload).toHaveBeenCalled();
  });
});
