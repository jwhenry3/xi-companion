import { bootstrap } from '@preact-mvc/core';
import { AppModule } from './app/app.module';
import { host, fabMode, detachedMode, tooltipMode, installWindowChrome } from './app/core/host';
import './styles.css';

// Esc collapses the overlay back to the floating button — in Electron the
// shell intercepts the key before the page; under Wails we handle it here.
// A detached (?window=) tab closes its own window instead.
// Capture phase so it behaves the same either way (expand via //xicompanion
// overlay or clicking the fab).
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !host.inShell() || fabMode.value) return;
    // an open modal owns Esc — collapsing the window mid-dialog is jarring
    if (document.querySelector('[data-modal]')) return;
    if (tooltipMode) host.closeTooltip();
    else if (detachedMode) host.closeWindow();
    else host.collapse();
  },
  true,
);
installWindowChrome();

bootstrap(AppModule, document.getElementById('app')!);

// the shell holds the initial SetURL retry loop open until this posts —
// a mount failure means no hello, so a wedged first navigation self-heals
host.loaded();
