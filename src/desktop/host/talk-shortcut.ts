import { validTalkShortcut } from '../shared/talk-shortcut.js';

/** Register a replacement before releasing the working shortcut. */
export class TalkShortcut {
  private selected = '';
  private registered = '';
  private paused = false;
  constructor(
    private readonly api: {
      register(key: string, callback: () => void): boolean;
      unregister(key: string): void;
    },
    private readonly toggle: () => void,
  ) {}

  set(value: string): void {
    if (!validTalkShortcut(value))
      throw new Error('Choose a key with Command, Control or Option.');
    if (value && value !== this.registered) {
      let accepted = false;
      try {
        accepted = this.api.register(value, this.toggle);
      } catch {
        /* Invalid native accelerator. */
      }
      if (!accepted)
        throw new Error(
          'That shortcut is already in use or unavailable. Choose another combination.',
        );
    }
    if (this.registered && this.registered !== value)
      this.api.unregister(this.registered);
    this.selected = value;
    this.registered = value;
    if (this.paused && value) {
      this.api.unregister(value);
      this.registered = '';
    }
  }

  pause(value: boolean): void {
    this.paused = value;
    if (value) {
      if (this.registered) this.api.unregister(this.registered);
      this.registered = '';
    } else this.set(this.selected);
  }

  destroy(): void {
    if (this.registered) this.api.unregister(this.registered);
    this.registered = '';
  }
}
