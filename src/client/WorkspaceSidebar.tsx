import {
  BookOpen,
  Clock3,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Settings2,
} from 'lucide-react';
import type { Dot, State, WorkspaceState } from '../shared/types';
import type {
  WorkspaceDestination,
  WorkspaceStatus,
} from '../desktop/shared/workspace-contract';
import type { WorkspaceView } from './workspace-navigation';
import type { Dialog } from './WorkspaceDialog';
import { Mascot } from './Mascot';
import { SpaceNav } from './SpaceNav';
import { ThreadList } from './ThreadList';
interface Props {
  view: WorkspaceView;
  workspace: WorkspaceState;
  state: State;
  dot: Dot;
  configured: boolean;
  busy: boolean;
  selectedThread?: string;
  spaceId: string;
  pageId?: string;
  backendStatus?: WorkspaceStatus;
  newConversation: () => void;
  setDialog: (dialog: Dialog) => void;
  chooseDot: (dot: Dot) => void;
  navigateDestination: (destination: WorkspaceDestination) => boolean;
  openPage: (space: string, page?: string) => void;
  setView: (view: WorkspaceView) => boolean;
  setSelectedDot: (id: string) => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}
export function WorkspaceSidebar({
  view,
  workspace,
  state,
  dot,
  configured,
  busy,
  selectedThread,
  spaceId,
  pageId,
  backendStatus,
  newConversation,
  setDialog,
  chooseDot,
  navigateDestination,
  openPage,
  setView,
  setSelectedDot,
  mutate,
}: Props) {
  return (
    <aside id="workspace-sidebar" className="sidebar workspace-sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="sidebar-kicker">MY OWN DOTS</span>
          <h2>
            {
              {
                chat: 'Chats',
                space: 'Spaces',
                tasks: 'Activity',
                memories: 'Memory',
                settings: 'Settings',
              }[view]
            }
          </h2>
        </div>
      </div>
      <div className="sidebar-scroll">
        {view === 'chat' && (
          <>
            <button
              className="new-chat nav-item"
              disabled={!configured || busy}
              onClick={() => void newConversation()}
            >
              <Plus size={17} />
              <span>New conversation</span>
              <kbd>⌘ N</kbd>
            </button>
            <div className="spaces-heading nav-label">
              YOUR DOTS
              <button
                className="icon-button"
                aria-label="Create Dot"
                onClick={() =>
                  setDialog({
                    type: 'dot',
                    spaceId: workspace.spaces[0]?.id || '',
                  })
                }
              >
                <Plus size={14} />
              </button>
            </div>
            <nav className="dots-nav" aria-label="Dots">
              {workspace.dots.map((item) => (
                <div className="dot-nav-row" key={item.id}>
                  <button
                    className={`dot-nav ${dot.id === item.id ? 'active' : ''}`}
                    onClick={() => chooseDot(item)}
                  >
                    <Mascot
                      identity={item.id}
                      name={item.name}
                      small
                      decorative
                    />
                    <span>{item.name}</span>
                  </button>
                  <button
                    className="icon-button dot-settings"
                    aria-label={`Edit ${item.name} settings`}
                    onClick={() =>
                      setDialog({
                        type: 'dot',
                        dot: item,
                        spaceId: item.spaceId,
                      })
                    }
                  >
                    <MoreHorizontal size={15} />
                  </button>
                </div>
              ))}
            </nav>
            {configured ? (
              <ThreadList
                dotId={dot.id}
                dots={workspace.dots}
                local={workspace.conversations}
                selected={selectedThread}
                onSelect={(id) => navigateDestination({ threadId: id })}
                onNew={() => void newConversation()}
              />
            ) : (
              <p className="sidebar-empty">
                Complete workspace setup to start a conversation.
              </p>
            )}
          </>
        )}
        {view === 'space' && (
          <>
            <button
              className="new-chat nav-item"
              onClick={() => setDialog({ type: 'space' })}
            >
              <Plus size={17} />
              New Space
            </button>
            <p className="sidebar-description">
              Pages and context for the work you care about.
            </p>
            <nav className="spaces-nav" aria-label="Spaces">
              {workspace.spaces.map((space) => (
                <SpaceNav
                  key={space.id}
                  space={space}
                  active={spaceId === space.id}
                  pageId={pageId}
                  onOpen={(id) => openPage(space.id, id)}
                />
              ))}
            </nav>
          </>
        )}
        {view === 'tasks' && (
          <>
            <p className="sidebar-description">
              Follow the work your Dots are doing, and revisit scheduled
              conversations.
            </p>
            <div className="context-stat">
              <Clock3 size={18} />
              <span>Scheduled & activity</span>
              <strong>{state.tasks.length}</strong>
            </div>
            <p className="sidebar-description">
              Schedule a task from the clock in any conversation. Select a task
              to inspect its runs and controls.
            </p>
            <button className="nav-item" onClick={() => setView('chat')}>
              <MessageCircle size={17} />
              Go to conversations
            </button>
          </>
        )}
        {view === 'memories' && (
          <>
            <p className="sidebar-description">
              Manage what your Dots remember and how they learn.
            </p>
            <div className="nav-label">SELECT A DOT</div>
            {workspace.dots.map((item) => (
              <button
                className={`dot-nav ${dot.id === item.id ? 'active' : ''}`}
                key={item.id}
                onClick={() => setSelectedDot(item.id)}
              >
                <Mascot identity={item.id} name={item.name} small decorative />
                {item.name}
              </button>
            ))}
            <div className="sidebar-info">
              <BookOpen size={19} />
              <strong>Context, on your terms</strong>
              <p>
                Review, edit or forget memories. Learning controls live in each
                Dot’s settings.
              </p>
            </div>
            <button
              className="nav-item"
              onClick={() =>
                setDialog({ type: 'dot', dot, spaceId: dot.spaceId })
              }
            >
              <Settings2 size={17} />
              Edit {dot.name}
            </button>
          </>
        )}
        {view === 'settings' && (
          <>
            <p className="sidebar-description">
              Appearance, permissions and connected services for your workspace.
            </p>
            <div className="sidebar-info">
              <Settings2 size={19} />
              <strong>Workspace preferences</strong>
              <p>
                Changes to access permissions apply to every Dot. Customize an
                individual Dot from Chats.
              </p>
            </div>
            <button
              className="nav-item"
              onClick={() =>
                setDialog({ type: 'dot', dot, spaceId: dot.spaceId })
              }
            >
              <Mascot identity={dot.id} name={dot.name} small decorative />
              Edit {dot.name}
            </button>
          </>
        )}
      </div>
      <div className="workspace-status">
        <span
          className={`online-dot ${!configured || backendStatus?.warning || (backendStatus && backendStatus.phase !== 'ready') ? 'off' : ''}`}
        />
        <div>
          <strong>
            {backendStatus?.phase === 'error'
              ? 'Workspace disconnected'
              : backendStatus?.phase === 'stopped'
                ? 'Workspace stopped'
                : backendStatus &&
                    ['idle', 'starting'].includes(backendStatus.phase)
                  ? 'Workspace connecting'
                  : backendStatus?.warning
                    ? 'Workspace needs attention'
                    : state.settings.paused
                      ? 'Dots paused'
                      : configured
                        ? 'Workspace connected'
                        : 'Setup needed'}
          </strong>
          <small>
            {workspace.setup.llmBackend === 'subscription'
              ? `${workspace.setup.llmProvider || 'Codex'} · Subscription`
              : 'Configured model'}
          </small>
        </div>
        <button
          className="icon-button"
          aria-label={
            state.settings.paused ? 'Resume all Dots' : 'Pause all Dots'
          }
          onClick={() =>
            void mutate('/settings', 'PATCH', {
              paused: !state.settings.paused,
            })
          }
        >
          {state.settings.paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      </div>
    </aside>
  );
}
