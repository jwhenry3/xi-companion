// item display/command helpers shared by inventory, sets and the
// floating item tooltip window

export function augmentText(a: string | Record<string, unknown>): string {
  if (typeof a === 'string') return a;
  return Object.entries(a)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}

// res slot names -> /equip command arguments
const EQUIP_CMD_SLOT: Record<string, string> = {
  'Left Ear': 'l.ear',
  'Right Ear': 'r.ear',
  'Left Ring': 'l.ring',
  'Right Ring': 'r.ring',
};

export function equipCmdSlot(resName: string): string {
  return EQUIP_CMD_SLOT[resName] ?? resName.toLowerCase();
}

// res.slots order — decode_slots emits an unordered set, so consumers
// that pick slots[0] (equip commands) can't rely on it. Weapons land
// Main+Sub, rings Left+Right etc., so multi-slot items need one action
// per slot rather than an arbitrary first.
const SLOT_ORDER = [
  'Main', 'Sub', 'Range', 'Ammo', 'Head', 'Body', 'Hands', 'Legs',
  'Feet', 'Neck', 'Waist', 'Left Ear', 'Right Ear', 'Left Ring',
  'Right Ring', 'Back',
];

/** the item's valid equip slots in canonical order */
export function equipSlots(slots: string[] | undefined): string[] {
  if (!slots?.length) return [];
  return SLOT_ORDER.filter((s) => slots.includes(s));
}

export function cmdStr(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
