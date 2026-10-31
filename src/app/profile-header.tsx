import { Component, View, inject, signal } from '@preact-mvc/core';
import { AddonApi } from './core/addon-api.service';
import { SetsStore } from './sets/sets.store';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// minimal profile — injectSetsBlock only needs a get_sets() to splice
// the managed <xicompanion sets> block into
const NEW_FILE_LUA = `-- GearSwap profile — created by XI Companion.

function get_sets()
end
`;

/**
 * Profile scope header shared by the Sets and Bindings tabs — the file
 * picker selects which GearSwap profile's managed section is being edited,
 * save flushes every dirty profile's <xicompanion sets> block, and the +
 * button creates a fresh profile file.
 */
@Component()
export class ProfileHeader extends View {
  private api = inject(AddonApi);
  private store = inject(SetsStore);

  private newOpen = signal(false);
  private newName = signal('');
  private newBusy = signal(false);
  private newErr = signal<string | null>(null);

  /** validate the dialog's name into a relative .lua path, or null */
  private newPath(): string | null {
    const raw = this.newName.value.trim().replace(/\.lua$/i, '');
    // addon sanitizer allows [\w._-\/\\ space]+ with a .lua tail —
    // keep to that charset, reject traversal and empty names
    if (!raw || /\.\./.test(raw) || !/^[\w .\-/]+$/.test(raw)) return null;
    return `${raw}.lua`;
  }

  private async createFile() {
    const path = this.newPath();
    if (!path) {
      this.newErr.value = 'invalid name — letters, digits, space, .-_ and / only';
      return;
    }
    if ((this.api.files.value?.files ?? []).some((f) => f.path === path)) {
      this.newErr.value = `${path} already exists`;
      return;
    }
    this.newBusy.value = true;
    try {
      await this.api.saveFile(path, NEW_FILE_LUA);
      await this.api.refreshFiles();
      await this.store.selectFile(path);
      this.newOpen.value = false;
      this.newName.value = '';
      this.newErr.value = null;
      this.store.flash(`created ${path}`);
    } catch (e) {
      this.newErr.value = `create failed: ${e}`;
    } finally {
      this.newBusy.value = false;
    }
  }

  render() {
    const store = this.store;
    const files = this.api.files.value;
    return (
      <>
        <div class="mb-1 flex items-center gap-3 px-3 pt-2">
          <Select
          className="w-72"
          value={store.activeFile.value ?? ''}
          placeholder="gearswap file…"
          emptyLabel="(no file)"
          options={(files?.files ?? []).map((f) => ({ value: f.path }))}
          onChange={(v) => void store.selectFile(v === '' ? null : v)}
        />
        <Button
          variant="secondary"
          size="xs"
          title="new gearswap file"
          onClick={() => {
            this.newName.value = '';
            this.newErr.value = null;
            this.newOpen.value = true;
          }}
        >
          +
        </Button>
        <span class="flex-1" />
        {store.notice.value && (
          <span class="text-xs text-slate-400">{store.notice.value}</span>
        )}
        <span class={`text-xs ${store.dirty.value ? 'text-amber-300' : 'text-slate-600'}`}>
          {store.dirty.value ? '● unsaved changes' : 'sets.* auto-import on select'}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!store.dirty.value || store.saving.value}
          onClick={() => void store.saveAll()}
        >
          {store.saving.value ? 'saving…' : 'save'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void this.api.reloadGearswap();
            store.flash('Sent //gs reload');
          }}
        >
          gs reload
        </Button>
      </div>
      {this.newOpen.value && (
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => (this.newOpen.value = false)}
        >
          <div
            data-modal
            class="w-72 rounded border border-slate-600 bg-slate-900 p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
              New GearSwap file
            </h3>
            <Input
              autofocus
              placeholder="name (e.g. WAR.lua)"
              value={this.newName.value}
              onInput={(e) =>
                (this.newName.value = (e.target as HTMLInputElement).value)
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') void this.createFile();
                else if (e.key === 'Escape') this.newOpen.value = false;
              }}
            />
            {this.newErr.value && (
              <p class="mt-2 text-[11px] text-rose-400">{this.newErr.value}</p>
            )}
            <p class="mt-2 text-[10px] text-slate-500">
              .lua is appended if omitted; / makes a folder.
            </p>
            <div class="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (this.newOpen.value = false)}
              >
                cancel
              </Button>
              <Button
                size="sm"
                disabled={this.newBusy.value}
                onClick={() => void this.createFile()}
              >
                {this.newBusy.value ? 'creating…' : 'create'}
              </Button>
            </div>
          </div>
        </div>
      )}
      </>
    );
  }
}
