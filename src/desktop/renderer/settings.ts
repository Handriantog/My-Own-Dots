import {
  DEFAULT_CATEGORY_VOLUMES,
  type CategoryVolumes,
  type SoundCategory,
} from '../core/sound-categories.js';
import type { Preferences } from '../shared/contracts.js';
import {
  ACCESSORIES,
  ACCESSORY_SLOTS,
  accessoriesFromKey,
  DEFAULT_ACCESSORIES,
  type Accessories,
} from '../shared/accessories.js';
import './settings.css';
import {
  DEFAULT_TALK_SHORTCUT,
  shortcutFromKey,
  shortcutLabel,
} from '../shared/talk-shortcut.js';

declare global {
  interface Window {
    dotSettings: {
      read(): Promise<Preferences>;
      update(change: Partial<Preferences>): Promise<Preferences>;
      shortcutStatus(): Promise<string>;
      captureShortcut(active: boolean): Promise<void>;
      onShortcutCaptureReset(callback: () => void): () => void;
    };
  }
}
const color = document.querySelector<HTMLInputElement>('#color')!;
const colorValue = document.querySelector<HTMLOutputElement>('#color-value')!;
const preview = document.querySelector<HTMLImageElement>('#dot-preview')!;
const swatches = document.querySelectorAll<HTMLButtonElement>('[data-color]');
let selectedAccessories: Accessories = { ...DEFAULT_ACCESSORIES };
const accessoryInputs = {
  headwear: document.querySelector<HTMLSelectElement>('#headwear')!,
  eyewear: document.querySelector<HTMLSelectElement>('#eyewear')!,
  neckwear: document.querySelector<HTMLSelectElement>('#neckwear')!,
};
for (const slot of ACCESSORY_SLOTS) {
  const select = accessoryInputs[slot];
  for (const item of ACCESSORIES[slot]) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    select.append(option);
  }
  select.value = selectedAccessories[slot];
  select.addEventListener('change', () => {
    renderAccessories(
      accessoriesFromKey(
        ACCESSORY_SLOTS.map((name) => accessoryInputs[name].value).join('.'),
      ),
    );
    renderPreview();
    void update({ accessories: selectedAccessories });
  });
}
function renderAccessories(value: Accessories): void {
  selectedAccessories = { ...value };
  for (const slot of ACCESSORY_SLOTS) accessoryInputs[slot].value = value[slot];
}
let previewRequest = 0;
function renderPreview(): void {
  const request = ++previewRequest;
  const value = color.value;
  const accessories = selectedAccessories;
  void import('./avatar')
    .then(({ renderCompanionAvatar }) =>
      renderCompanionAvatar(value, accessories),
    )
    .then((image) => {
      if (request !== previewRequest) return;
      preview.src = image;
      preview.alt = 'Your Dot';
    })
    .catch(() => {
      if (request === previewRequest) preview.alt = 'Dot preview unavailable';
    });
}
function renderColor(value: string): void {
  color.value = value;
  colorValue.textContent = value.toUpperCase();
  for (const swatch of swatches)
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === value));
  renderPreview();
}
function changeColor(value: string): void {
  renderColor(value);
  void update({ color: value });
}
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
  savedShortcut = preferences.talkShortcut;
  renderShortcut();
  categoryVolumes = { ...preferences.categoryVolumes };
  renderCategory();
  renderAccessories(preferences.accessories);
  renderColor(preferences.color);
  volume.value = String(Math.round(preferences.volume * 100));
  label.value = `${volume.value}%`;
  for (const name of switches)
    document.querySelector<HTMLInputElement>(`#${name}`)!.checked =
      preferences[name];
}
const shortcutButton =
  document.querySelector<HTMLButtonElement>('#talk-shortcut')!;
const shortcutStatus =
  document.querySelector<HTMLParagraphElement>('#shortcut-status')!;
let savedShortcut = DEFAULT_TALK_SHORTCUT;
let recording = false;
let recordingRequest = 0;
let savingShortcut = false;
for (const name of ['appearance', 'behavior'] as const) {
  document.querySelector(`#${name}-tab`)!.addEventListener('click', () => {
    for (const section of ['appearance', 'behavior'] as const) {
      document.querySelector<HTMLElement>(`#${section}-panel`)!.hidden =
        section !== name;
      document
        .querySelector(`#${section}-tab`)!
        .setAttribute('aria-pressed', String(section === name));
    }
    if (name === 'appearance') void stopRecording();
  });
}
function renderShortcut(): void {
  shortcutButton.textContent = recording
    ? 'Press your shortcut… Esc to cancel'
    : `${shortcutLabel(savedShortcut)} · Change`;
  shortcutButton.setAttribute('aria-pressed', String(recording));
}
async function stopRecording(): Promise<void> {
  recordingRequest++;
  recording = false;
  renderShortcut();
  await window.dotSettings.captureShortcut(false);
}
shortcutButton.addEventListener('click', () => {
  if (savingShortcut) return;
  if (recording) {
    void stopRecording();
    return;
  }
  const request = ++recordingRequest;
  void window.dotSettings
    .captureShortcut(true)
    .then(() => {
      if (request !== recordingRequest) return;
      if (!document.hasFocus() || document.activeElement !== shortcutButton) {
        void stopRecording();
        return;
      }
      recording = true;
      shortcutStatus.textContent = 'Use Command, Control or Option with a key.';
      renderShortcut();
    })
    .catch(() => {
      shortcutStatus.textContent = 'Could not record a shortcut. Try again.';
    });
});
async function saveShortcut(value: string): Promise<void> {
  if (savingShortcut) return;
  savingShortcut = true;
  try {
    const preferences = await window.dotSettings.update({
      talkShortcut: value,
    });
    savedShortcut = preferences.talkShortcut;
    shortcutStatus.textContent = value
      ? 'Shortcut saved.'
      : 'Shortcut disabled.';
  } catch (cause) {
    shortcutStatus.textContent =
      cause instanceof Error
        ? cause.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            '',
          )
        : 'Could not save the shortcut.';
  } finally {
    savingShortcut = false;
    await stopRecording();
  }
}
shortcutButton.addEventListener('keydown', (event) => {
  if (!recording || event.key === 'Tab') return;
  event.preventDefault();
  if (event.repeat || event.isComposing) return;
  if (event.key === 'Escape') {
    void stopRecording();
    return;
  }
  const value = shortcutFromKey(event);
  if (value) void saveShortcut(value);
});
shortcutButton.addEventListener('blur', () => {
  void stopRecording();
});
window.addEventListener('blur', () => {
  void stopRecording();
});
window.dotSettings.onShortcutCaptureReset(() => {
  recordingRequest++;
  recording = false;
  renderShortcut();
  void window.dotSettings
    .shortcutStatus()
    .then((message) => {
      if (message) shortcutStatus.textContent = message;
    })
    .catch(() => {});
});
document
  .querySelector('#shortcut-reset')!
  .addEventListener('click', () => void saveShortcut(DEFAULT_TALK_SHORTCUT));
document
  .querySelector('#shortcut-disable')!
  .addEventListener('click', () => void saveShortcut(''));
void window.dotSettings
  .shortcutStatus()
  .then((message) => {
    if (message) shortcutStatus.textContent = message;
  })
  .catch(() => {});
async function update(change: Partial<Preferences>): Promise<void> {
  try {
    await window.dotSettings.update(change);
    error.textContent = '';
  } catch {
    error.textContent = 'Could not save changes. Please try again.';
  }
}
color.addEventListener('input', () => changeColor(color.value));
for (const swatch of swatches)
  swatch.addEventListener('click', () => changeColor(swatch.dataset.color!));
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
