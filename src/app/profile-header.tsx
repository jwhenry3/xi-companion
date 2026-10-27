import { Component, View, inject } from '@preact-mvc/core';
import { AddonApi } from './core/addon-api.service';
import { SetsStore } from './sets/sets.store';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

/**
 * Profile scope header shared by the Sets and Bindings tabs — the file
 * picker selects which GearSwap profile's managed section is being edited,
 * and save flushes every dirty profile's <xicompanion sets> block.
 */
@Component()
export class ProfileHeader extends View {
  private api = inject(AddonApi);
  private store = inject(SetsStore);

  render() {
    const store = this.store;
    const files = this.api.files.value;
    return (
      <div class="mb-1 flex items-center gap-3 px-3 pt-2">
        <Select
          className="w-72"
          value={store.activeFile.value ?? ''}
          placeholder="gearswap file…"
          emptyLabel="(no file)"
          options={(files?.files ?? []).map((f) => ({ value: f.path }))}
          onChange={(v) => void store.selectFile(v === '' ? null : v)}
        />
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
    );
  }
}
