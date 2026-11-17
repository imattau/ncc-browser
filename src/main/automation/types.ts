/**
 * Automation surface. The MCP server and tools only see these interfaces, so they can be
 * tested without Electron; `electron-host.ts` adapts the real shell to them.
 */

export interface AutomationPage {
  tabId: string
  url: string
  title: string
  active: boolean
}

export interface MouseOptions {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

export interface AutomationDiagnostic {
  time: string
  kind: 'console' | 'load-failure'
  level: 'info' | 'warning' | 'error' | 'debug'
  message: string
  url: string
  line?: number
}

export interface AutomationContents {
  /** Evaluate an expression in the page's main world and return its JSON value. */
  evaluate(code: string): Promise<unknown>
  /** PNG of the visible viewport. */
  screenshot(): Promise<Buffer>
  /** Move, then press and release, at viewport CSS coordinates. */
  click(x: number, y: number, options?: MouseOptions): Promise<void>
  hover(x: number, y: number): Promise<void>
  insertText(text: string): Promise<void>
  /** Press a key by its Electron accelerator name, e.g. `Enter`, `Tab`, `A`. */
  pressKey(key: string, modifiers: string[]): Promise<void>
  /** Recent renderer console messages and page load failures captured in this tab. */
  diagnostics(): AutomationDiagnostic[]
}

export interface AutomationHost {
  /** Only ordinary tabs; private and Tor tabs are never exposed. */
  listTabs(): AutomationPage[]
  newTab(url?: string): string
  closeTab(tabId: string): void
  selectTab(tabId: string): void
  /** Start a navigation and resolve when it stops loading (or times out). */
  navigate(tabId: string, input: string): Promise<void>
  history(tabId: string, direction: 'back' | 'forward'): Promise<void>
  contents(tabId: string): AutomationContents | null
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(
    host: AutomationHost,
    args: Record<string, unknown>,
    gate: AutomationGate
  ): Promise<ToolResult>
}

export interface PendingApproval {
  site: string
  /** The first action the agent attempted on the site. */
  action: string
  /** Epoch milliseconds when the prompt was raised. */
  since: number
}

/**
 * Asks the user whether an agent may act on a site. Resolves true when allowed and false
 * when denied. Agents can look at prompts and revoke grants, but there is deliberately no
 * way here to answer a prompt: only the user can allow access.
 */
export interface AutomationGate {
  authorize(site: string, action: string): Promise<boolean>
  pending?(): PendingApproval[]
  grants?(): string[]
  revoke?(site: string): void
}
