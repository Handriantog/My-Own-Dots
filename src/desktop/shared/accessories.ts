/** One catalog for the native picker, persisted outfits and every Dot renderer. */
export const ACCESSORIES = {
  headwear: [
    { id: 'none', label: 'None' },
    { id: 'headphones', label: 'Headphones' },
    { id: 'beanie', label: 'Cozy beanie' },
    { id: 'cap', label: 'Baseball cap' },
    { id: 'crown', label: 'Golden crown' },
    { id: 'wizard-hat', label: 'Wizard hat' },
    { id: 'party-hat', label: 'Party hat' },
    { id: 'flower', label: 'Daisy' },
  ],
  eyewear: [
    { id: 'none', label: 'None' },
    { id: 'round-glasses', label: 'Round glasses' },
    { id: 'sunglasses', label: 'Sunglasses' },
  ],
  neckwear: [
    { id: 'none', label: 'None' },
    { id: 'scarf', label: 'Cozy scarf' },
    { id: 'bow-tie', label: 'Bow tie' },
    { id: 'bandana', label: 'Bandana' },
    { id: 'medal', label: 'Star medal' },
  ],
} as const;
export type AccessorySlot = keyof typeof ACCESSORIES;
export type Accessories = {
  [Slot in AccessorySlot]: (typeof ACCESSORIES)[Slot][number]['id'];
};
export const DEFAULT_ACCESSORIES: Readonly<Accessories> = Object.freeze({
  headwear: 'headphones',
  eyewear: 'none',
  neckwear: 'none',
});
export const ACCESSORY_SLOTS = Object.keys(ACCESSORIES) as AccessorySlot[];
export function accessoriesKey(value: Accessories): string {
  return `${value.headwear}.${value.eyewear}.${value.neckwear}`;
}
export const DEFAULT_ACCESSORIES_KEY = accessoriesKey(DEFAULT_ACCESSORIES);
export function accessoriesFromKey(key: string | null): Accessories {
  const parts = key?.split('.') ?? [];
  if (parts.length !== 3) return { ...DEFAULT_ACCESSORIES };
  const result = { ...DEFAULT_ACCESSORIES };
  for (const [index, slot] of ACCESSORY_SLOTS.entries()) {
    const id = parts[index];
    if (ACCESSORIES[slot].some((item) => item.id === id))
      (result[slot] as string) = id;
  }
  return result;
}
export function accessoriesQuery(value: Accessories): string {
  const key = accessoriesKey(value);
  return key === DEFAULT_ACCESSORIES_KEY
    ? ''
    : `&dotAccessories=${encodeURIComponent(key)}`;
}

/** Height above the feet, including room for the tallest wearable. */
export function avatarHeight({ headwear }: Accessories): number {
  if (headwear === 'wizard-hat') return 148;
  if (headwear === 'party-hat') return 143;
  if (headwear === 'crown') return 130;
  if (headwear === 'beanie') return 127;
  if (headwear === 'cap') return 120;
  return 116;
}
