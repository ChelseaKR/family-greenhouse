/*
 * The in-app half of `npm run store:screenshots:ios` (capture-ios.mjs).
 *
 * NEVER part of a shipped build. capture-ios.mjs copies this file into the
 * synced iOS web folder (ios/App/App/public, which git ignores and every
 * `cap sync` rewrites) of a local simulator build only, and adds one script tag
 * for it there. It is not in src/, not in dist/, and not in any bundle.
 *
 * It signs in to the store-demo household the way a person would (typing into
 * the real sign-in form), then asks the capture script for one step at a time
 * over http://localhost:<port>: open a route, tap a link, scroll a section into
 * view. When the page has settled it reports back, and the capture script
 * takes the screenshot with `simctl io screenshot`. The native tab bar and
 * navigation bar follow the route exactly as they do when a person taps,
 * because the web reports every route change to the native frame itself.
 */
(function storeShotsTour() {
  var script = document.currentScript;
  var port = (script && script.getAttribute('data-port')) || '4199';
  var base = 'http://localhost:' + port;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function post(path, body) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json();
    });
  }

  function textOf(el) {
    return (el && (el.innerText || el.textContent || '')).trim();
  }

  function visible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** The innermost visible element matching `selector` whose text includes `text`. */
  function innermost(selector, text, startsWith) {
    var all = document.querySelectorAll(selector || '*');
    var best = null;
    var wanted = (text || '').toLowerCase();
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var at = textOf(el).toLowerCase().indexOf(wanted);
      if (at === -1 || (startsWith && at !== 0)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  async function waitFor(check, what, timeout) {
    var until = Date.now() + (timeout || 20000);
    while (Date.now() < until) {
      var value = check();
      if (value) return value;
      await sleep(150);
    }
    throw new Error('timed out waiting for ' + what);
  }

  /** Nothing still loading: no skeletons, spinners or busy regions, fonts ready. */
  async function settle(extra) {
    await waitFor(
      function () {
        return !document.querySelector(
          '[aria-busy="true"], .animate-pulse, .animate-spin, [data-loading="true"]'
        );
      },
      'the page to finish loading',
      20000
    ).catch(function () {
      /* a page with a decorative pulse still gets captured; the log says so */
    });
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await sleep(extra || 1200);
  }

  function setValue(input, value) {
    var proto = Object.getPrototypeOf(input);
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function go(path) {
    if (location.pathname + location.search === path) return;
    history.pushState(history.state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }

  async function signIn(email, password) {
    if (location.pathname !== '/login') go('/login');
    var emailInput = await waitFor(function () {
      return document.querySelector('input[type="email"], input[name="email"]');
    }, 'the sign-in form');
    setValue(emailInput, email);
    setValue(document.querySelector('input[name="password"]'), password);
    await sleep(200);
    document.querySelector('form button[type="submit"]').click();
    await waitFor(
      function () {
        return location.pathname === '/dashboard';
      },
      'the dashboard after signing in',
      30000
    );
  }

  async function run(step) {
    if (step.signIn) await signIn(step.signIn.email, step.signIn.password);
    if (step.go) go(step.go);
    if (step.tap) {
      var target = await waitFor(
        function () {
          return innermost(step.tap.selector, step.tap.text || '');
        },
        'something to tap: ' + JSON.stringify(step.tap)
      );
      (target.closest('a,button') || target).click();
    }
    if (step.path) {
      await waitFor(function () {
        return new RegExp(step.path).test(location.pathname + location.search);
      }, 'the route ' + step.path);
    }
    if (step.waitText) {
      await waitFor(
        function () {
          return document.body && textOf(document.body).indexOf(step.waitText) !== -1;
        },
        'the text "' + step.waitText + '"'
      );
    }
    await settle(400);
    if (step.scrollTo) {
      var el = await waitFor(
        function () {
          return innermost(
            step.scrollTo.selector || 'h1,h2,h3,h4',
            step.scrollTo.text,
            step.scrollTo.startsWith
          );
        },
        'the section "' + step.scrollTo.text + '"'
      );
      // Inside the native frame the page scrolls under a translucent navigation
      // bar, whose height WebKit reports as the top safe-area inset.
      var probe = document.createElement('div');
      probe.style.cssText =
        'position:fixed;top:0;height:env(safe-area-inset-top);visibility:hidden';
      document.body.appendChild(probe);
      var inset = probe.getBoundingClientRect().height;
      probe.remove();
      var top =
        el.getBoundingClientRect().top + window.scrollY - inset - (step.scrollTo.offset || 16);
      window.scrollTo(0, Math.max(0, top));
    } else if (step.scrollTop !== false && window.scrollY > 0) {
      // Only when scrolled: inside the native frame the top of the page sits
      // below the navigation bar, and scrolling to 0 would tuck it under it.
      window.scrollTo(0, 0);
    }
    await settle(step.settleMs || 1500);
    return {
      path: location.pathname + location.search,
      title: document.title,
      scrollY: window.scrollY,
    };
  }

  async function loop() {
    // Let the app boot and the native frame configure itself first.
    await sleep(1500);
    for (;;) {
      var next;
      try {
        next = await post('/next', { path: location.pathname });
      } catch (e) {
        await sleep(1000);
        continue;
      }
      if (!next || next.done) return;
      try {
        var result = await run(next.step);
        await post('/ready', { id: next.id, ok: true, result: result });
      } catch (e) {
        await post('/ready', { id: next.id, ok: false, error: String((e && e.message) || e) });
      }
    }
  }

  loop();
})();
