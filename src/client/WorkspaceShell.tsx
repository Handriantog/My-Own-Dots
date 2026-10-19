import {
  BookOpen,
  Clock3,
  Folder,
  MessageCircle,
  PanelLeft,
  Search,
  Settings2,
} from 'lucide-react';
import type { WorkspaceView } from './workspace-navigation';
export function WorkspaceTitlebar({
  onSearch,
  onToggle,
  collapsed,
}: {
  onSearch: () => void;
  onToggle: () => void;
  collapsed: boolean;
}) {
  return (
    <header className="workspace-titlebar">
      <div className="titlebar-leading">
        <button
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title="Toggle sidebar (⌘⇧B)"
          onClick={onToggle}
        >
          <PanelLeft size={17} />
        </button>
        <span>My Own Dots</span>
      </div>
      <button className="titlebar-search" onClick={onSearch}>
        <Search size={15} />
        <span>Quick navigation</span>
        <kbd>⌘ K</kbd>
      </button>
      <span className="titlebar-caption">Your workspace</span>
    </header>
  );
}
export function WorkspaceRail({
  view,
  onNavigate,
}: {
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
}) {
  return (
    <nav className="workspace-rail" aria-label="Workspace navigation">
      <div className="workspace-mark" aria-label="My Own Dots">
        <i />
        <i />
        <i />
        <i />
      </div>
      {(
        [
          { view: 'chat', label: 'Chats', icon: MessageCircle },
          { view: 'space', label: 'Spaces', icon: Folder },
          { view: 'tasks', label: 'Activity', icon: Clock3 },
          { view: 'memories', label: 'Memory', icon: BookOpen },
          { view: 'settings', label: 'Settings', icon: Settings2 },
        ] as const
      ).map((item) => (
        <button
          key={item.view}
          className={view === item.view ? 'active' : ''}
          aria-current={view === item.view ? 'page' : undefined}
          onClick={() => onNavigate(item.view)}
        >
          <item.icon size={21} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
