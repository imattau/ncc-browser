/**
 * Browser commands shared by the hamburger menu and the keyboard shortcut router.
 */

export type CommandId =
  | 'new-tab'
  | 'new-private-tab'
  | 'new-tor-tab'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'focus-address'
  | 'back'
  | 'forward'
  | 'reload'
  | 'force-reload'
  | 'stop'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-page-devtools'
  | 'toggle-browser-devtools'
  | 'toggle-bookmark'
  | 'open-history'
  | 'open-downloads'
  | 'open-settings'
  | 'open-identity'
  | 'open-spec'
  | 'quit'

export type CommandGroup = 'Tabs' | 'Navigation' | 'View' | 'Developer' | 'Application'

export interface CommandDefinition {
  id: CommandId
  label: string
  shortcut?: string
  group: CommandGroup
}

export const COMMAND_ORDER: CommandGroup[] = [
  'Tabs',
  'Navigation',
  'View',
  'Developer',
  'Application'
]

export const COMMANDS: CommandDefinition[] = [
  { id: 'new-tab', label: 'New tab', shortcut: 'Ctrl+T', group: 'Tabs' },
  {
    id: 'new-private-tab',
    label: 'New private tab',
    shortcut: 'Ctrl+Shift+N',
    group: 'Tabs'
  },
  { id: 'new-tor-tab', label: 'New Tor tab', shortcut: 'Ctrl+Shift+O', group: 'Tabs' },
  { id: 'close-tab', label: 'Close tab', shortcut: 'Ctrl+W', group: 'Tabs' },
  { id: 'next-tab', label: 'Next tab', shortcut: 'Ctrl+Tab', group: 'Tabs' },
  { id: 'previous-tab', label: 'Previous tab', shortcut: 'Ctrl+Shift+Tab', group: 'Tabs' },
  { id: 'focus-address', label: 'Focus address bar', shortcut: 'Ctrl+L', group: 'Navigation' },
  { id: 'back', label: 'Back', shortcut: 'Alt+←', group: 'Navigation' },
  { id: 'forward', label: 'Forward', shortcut: 'Alt+→', group: 'Navigation' },
  { id: 'reload', label: 'Reload', shortcut: 'Ctrl+R', group: 'Navigation' },
  { id: 'force-reload', label: 'Force reload', shortcut: 'Ctrl+Shift+R', group: 'Navigation' },
  { id: 'stop', label: 'Stop loading', shortcut: 'Ctrl+.', group: 'Navigation' },
  { id: 'toggle-bookmark', label: 'Bookmark this page', shortcut: 'Ctrl+D', group: 'Navigation' },
  { id: 'open-history', label: 'History of this tab', shortcut: 'Ctrl+H', group: 'Navigation' },
  { id: 'zoom-in', label: 'Zoom in', shortcut: 'Ctrl++', group: 'View' },
  { id: 'zoom-out', label: 'Zoom out', shortcut: 'Ctrl+-', group: 'View' },
  { id: 'zoom-reset', label: 'Actual size', shortcut: 'Ctrl+0', group: 'View' },
  {
    id: 'toggle-page-devtools',
    label: 'Page developer tools',
    shortcut: 'Ctrl+Shift+I',
    group: 'Developer'
  },
  {
    id: 'toggle-browser-devtools',
    label: 'Browser developer tools',
    shortcut: 'Ctrl+Shift+J',
    group: 'Developer'
  },
  { id: 'open-settings', label: 'Settings', group: 'Application' },
  { id: 'open-identity', label: 'Identity & signer', group: 'Application' },
  { id: 'open-downloads', label: 'Downloads', shortcut: 'Ctrl+J', group: 'Application' },
  { id: 'open-spec', label: 'NCC-05 specification', group: 'Application' },
  { id: 'quit', label: 'Quit', shortcut: 'Ctrl+Q', group: 'Application' }
]
