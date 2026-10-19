import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Search, X } from 'lucide-react';
import type { WorkspaceState } from '../shared/types';
import { navigationItems, type NavigationItem } from './workspace-navigation';
export function QuickNavigation({
  workspace,
  onChoose,
  onClose,
}: {
  workspace: WorkspaceState;
  onChoose: (item: NavigationItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = navigationItems(workspace, query).slice(0, 30);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    panel.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div className="quick-backdrop" onClick={onClose}>
      <div
        className="quick-navigation"
        role="dialog"
        aria-modal="true"
        aria-label="Quick navigation"
        ref={panel}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) =>
              items.length
                ? (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) %
                  items.length
                : 0,
            );
          }
          if (e.key === 'Enter' && items[active]) {
            e.preventDefault();
            onChoose(items[active]);
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <div className="quick-input">
          <Search size={20} />
          <input
            ref={input}
            role="combobox"
            aria-label="Find a Dot, conversation or Space"
            aria-autocomplete="list"
            aria-controls="quick-results"
            aria-expanded="true"
            aria-activedescendant={
              items[active] ? `quick-${active}` : undefined
            }
            value={query}
            placeholder="Go to a Dot, conversation or Space…"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <button
            className="icon-button"
            aria-label="Close quick navigation"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="quick-results" role="listbox" id="quick-results">
          {items.map((item, i) => (
            <button
              role="option"
              aria-selected={i === active}
              id={`quick-${i}`}
              key={item.id}
              onMouseMove={() => setActive(i)}
              onClick={() => onChoose(item)}
            >
              <span className="quick-symbol">
                {item.detail === 'Dot' ? (
                  '●'
                ) : item.detail === 'Space' ? (
                  '#'
                ) : (
                  <ArrowUpRight size={17} />
                )}
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <ArrowUpRight size={15} />
            </button>
          ))}
          {!items.length && (
            <p className="quick-empty">
              No matching destinations. Try a Dot, Space or conversation title.
            </p>
          )}
        </div>
        <footer>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>esc</kbd> Close
          </span>
        </footer>
      </div>
    </div>
  );
}
