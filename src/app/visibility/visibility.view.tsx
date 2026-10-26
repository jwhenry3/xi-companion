// Visibility toggle: a tiny always-up window (48px) that collapse-all
// never hides — it's the restore handle for the whole overlay.
// Visibility toggle: a tiny always-up window (48px) that collapse-all
// never hides — it's the restore handle for the whole overlay. The
// button state is shell-owned via __xicCollapsed so it survives reloads.
import { Component, View } from '@preact-mvc/core';
import { host, uiCollapsed } from '../core/host';
import { XicLogo } from '../fab';

@Component()
export class VisibilityView extends View {
  private dragged = false;

  render() {
    return (
      <div class="flex h-screen w-screen items-center justify-center bg-transparent">
        <button
          class="ffxi-fab grid h-9 w-9 cursor-pointer place-items-center rounded-full"
          title={uiCollapsed.value ? 'show all windows' : 'hide all windows'}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            // click vs drag — past the threshold the native move loop
            // owns the gesture and no toggle should fire
            this.dragged = false;
            const sx = e.screenX;
            const sy = e.screenY;
            const mv = (ev: MouseEvent) => {
              if (this.dragged) return;
              if (Math.hypot(ev.screenX - sx, ev.screenY - sy) > 4) {
                this.dragged = true;
                window.removeEventListener('mousemove', mv, true);
                host.drag();
              }
            };
            const up = () => {
              window.removeEventListener('mousemove', mv, true);
              window.removeEventListener('mouseup', up, true);
            };
            window.addEventListener('mousemove', mv, true);
            window.addEventListener('mouseup', up, true);
          }}
          onClick={() => {
            if (!this.dragged) host.collapseAll();
          }}
        >
          <XicLogo size={22} />
        </button>
      </div>
    );
  }
}
