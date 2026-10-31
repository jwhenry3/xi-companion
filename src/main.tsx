import { bootstrap } from '@preact-mvc/core';
import { AppModule } from './app/app.module';
import { installErrorLog } from './app/core/errlog';
import { host, fabMode, detachedMode, menuMode, tooltipMode, installWindowChrome } from './app/core/host';
import './styles.css';

installErrorLog('page');

// Esc collapses the overlay back to the floating button — handled here in
// the page (capture phase).
// Detached (?window=) panels ignore Esc — destroying a HUD window off a
// stray keystroke was too easy; close them via × or the Panels menu.
// Capture phase so it behaves the same either way (expand via //xicompanion
// overlay or clicking the fab).
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !host.inShell() || fabMode.value) return;
    // an open modal owns Esc — collapsing the window mid-dialog is jarring
    if (document.querySelector('[data-modal]')) return;
    if (tooltipMode) host.closeTooltip();
    else if (menuMode) host.fabMenuHide();
    else if (!detachedMode) host.collapse();
  },
  true,
);
installWindowChrome();

bootstrap(AppModule, document.getElementById('app')!);

// the shell holds the initial SetURL retry loop open until this posts —
// a mount failure means no hello, so a wedged first navigation self-heals
host.loaded();
