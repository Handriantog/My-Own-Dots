import { randomUUID } from 'node:crypto';
import {
  AbilityFailure,
  invocationContextSchema,
} from '../../../shared/abilities/bridge.js';
import {
  ownerViewSchema,
  type OwnerView,
} from '../../../shared/abilities/desktop.js';
import {
  abilityLimits,
  assertBoundedJson,
} from '../../../shared/abilities/limits.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import { ownerResultSchema } from '../../../shared/abilities/protocol.js';
import type {
  InvocationContext,
  JsonValue,
  OwnerResult,
} from '../../../shared/abilities/types.js';
type Entry = {
  context: InvocationContext;
  result: OwnerResult;
  view: OwnerView;
  expires: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
};
export class OwnerResultStore {
  private readonly entries = new Map<string, Entry>();
  private readonly selections = new Map<
    string,
    { handle: string; itemId: string }
  >();
  private bytes = 0;
  constructor(
    private readonly options: { now?: () => number; maxResults?: number } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private remove(handle: string) {
    const entry = this.entries.get(handle);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.bytes -= entry.bytes;
    this.entries.delete(handle);
    for (const [key, selection] of this.selections)
      if (selection.handle === handle) this.selections.delete(key);
  }
  private entry(dotId: string, handle: string): Entry | undefined {
    const entry = this.entries.get(handle);
    if (entry && entry.expires <= this.now()) {
      this.remove(handle);
      return;
    }
    return entry?.context.dotId === dotId ? entry : undefined;
  }
  put(context: InvocationContext, result: OwnerResult): string {
    invocationContextSchema.parse(context);
    assertBoundedJson(result, abilityLimits.frameBytes);
    const parsed = ownerResultSchema.parse(result);
    const view = ownerViewSchema.parse(
      parsed.kind === 'text'
        ? parsed
        : {
            ...parsed,
            items: parsed.items.map(({ action, ...item }) => ({
              ...item,
              id: randomUUID(),
              selectable: action !== undefined,
            })),
          },
    );
    const handle = randomUUID(),
      bytes =
        Buffer.byteLength(JSON.stringify(parsed)) +
        Buffer.byteLength(JSON.stringify(view));
    for (const [key, item] of this.entries)
      if (item.expires <= this.now()) this.remove(key);
    while (
      this.entries.size >= (this.options.maxResults ?? 128) ||
      this.bytes + bytes > 16 * 1024 * 1024
    ) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) throw new AbilityFailure('busy');
      this.remove(oldest);
    }
    const timer = setTimeout(
      () => this.remove(handle),
      abilityLimits.ownerResultMs,
    );
    timer.unref?.();
    this.entries.set(handle, {
      context: structuredClone(context),
      result: structuredClone(parsed),
      view,
      expires: this.now() + abilityLimits.ownerResultMs,
      bytes,
      timer,
    });
    this.bytes += bytes;
    return handle;
  }
  read(dotId: string, handle: string): OwnerView | undefined {
    const entry = this.entry(dotId, handle);
    return entry ? structuredClone(entry.view) : undefined;
  }
  context(dotId: string, handle: string): InvocationContext | undefined {
    const entry = this.entry(dotId, handle);
    return entry ? structuredClone(entry.context) : undefined;
  }
  select(dotId: string, handle: string, itemId: string): string {
    const entry = this.entry(dotId, handle);
    if (
      entry?.view.kind !== 'list' ||
      !entry.view.items.some((item) => item.id === itemId && item.selectable)
    )
      throw new AbilityFailure('permission_denied');
    // Repeated clicks replace the previous choice and cannot grow memory unboundedly.
    for (const [key, selection] of this.selections)
      if (selection.handle === handle) this.selections.delete(key);
    const selectionRef = randomUUID();
    this.selections.set(selectionRef, { handle, itemId });
    return selectionRef;
  }
  take(
    context: InvocationContext,
    reference: string,
  ): Record<string, JsonValue> | undefined {
    const selection = this.selections.get(reference);
    if (!selection) return;
    const entry = this.entry(context.dotId, selection.handle);
    if (!entry || entry.view.kind !== 'list' || entry.result.kind !== 'list')
      return;
    const scope = ({
      tool: _tool,
      invocationId: _invocationId,
      ...value
    }: InvocationContext) => value;
    if (canonicalJson(scope(context)) !== canonicalJson(scope(entry.context)))
      return;
    const index = entry.view.items.findIndex(
      (item) => item.id === selection.itemId,
    );
    const action = entry.result.items[index]?.action;
    if (!action) return;
    this.selections.delete(reference);
    return structuredClone(action);
  }
  clearBinding(bindingId: string): void {
    for (const [key, entry] of this.entries)
      if (entry.context.bindingId === bindingId) this.remove(key);
  }
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }
}
