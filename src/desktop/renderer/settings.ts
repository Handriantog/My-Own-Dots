import {
  DEFAULT_CATEGORY_VOLUMES,
  type CategoryVolumes,
  type SoundCategory,
} from '../core/sound-categories.js';
import type { Preferences } from '../shared/contracts.js';
import './settings.css';

declare global {
  interface Window {
    dotSettings: {
      read(): Promise<Preferences>;
      update(change: Partial<Preferences>): Promise<Preferences>;
    };
  }
}
const color = document.querySelector<HTMLInputElement>('#color')!;
const volume = document.querySelector<HTMLInputElement>('#volume')!;
const label = document.querySelector<HTMLOutputElement>('#volume-label')!;
const category = document.querySelector<HTMLSelectElement>('#sound-category')!;
const categoryVolume =
  document.querySelector<HTMLInputElement>('#category-volume')!;
const categoryLabel = document.querySelector<HTMLOutputElement>(
  '#category-volume-label',
)!;
const categoryName = document.querySelector<HTMLSpanElement>(
  '#category-volume-name',
)!;
let categoryVolumes: CategoryVolumes = { ...DEFAULT_CATEGORY_VOLUMES };
function renderCategory(): void {
  categoryVolume.value = String(
    Math.round(categoryVolumes[category.value as SoundCategory] * 100),
  );
  categoryLabel.value = `${categoryVolume.value}%`;
  categoryName.textContent = `${category.selectedOptions[0].text} volume`;
}
const error = document.querySelector<HTMLParagraphElement>('#error')!;
const switches = ['muted', 'paused', 'reducedMotion'] as const;
function render(preferences: Preferences): void {
  categoryVolumes = { ...preferences.categoryVolumes };
  renderCategory();
  color.value = preferences.color;
  volume.value = String(Math.round(preferences.volume * 100));
  label.value = `${volume.value}%`;
  for (const name of switches)
    document.querySelector<HTMLInputElement>(`#${name}`)!.checked =
      preferences[name];
}
async function update(change: Partial<Preferences>): Promise<void> {
  try {
    await window.dotSettings.update(change);
    error.textContent = '';
  } catch {
    error.textContent = 'Could not save changes. Please try again.';
  }
}
color.addEventListener('input', () => void update({ color: color.value }));
volume.addEventListener('input', () => {
  label.value = `${volume.value}%`;
  void update({ volume: Number(volume.value) / 100 });
});
category.addEventListener('change', renderCategory);
categoryVolume.addEventListener('input', () => {
  categoryVolumes = {
    ...categoryVolumes,
    [category.value]: Number(categoryVolume.value) / 100,
  };
  categoryLabel.value = `${categoryVolume.value}%`;
  void update({ categoryVolumes });
});
for (const name of switches)
  document
    .querySelector<HTMLInputElement>(`#${name}`)!
    .addEventListener(
      'change',
      (event) =>
        void update({ [name]: (event.target as HTMLInputElement).checked }),
    );
void window.dotSettings
  .read()
  .then(render)
  .catch(() => {
    error.textContent = 'Could not load preferences.';
  });
