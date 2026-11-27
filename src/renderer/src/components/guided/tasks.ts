export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface Task {
  key: string
  label: string
  status: TaskStatus
  /** Extra text under the label: what is happening, or why it failed. */
  detail?: string
  /** A real count for a progress bar; omit when the length is unknown. */
  progress?: { done: number; total: number }
}
