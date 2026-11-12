import { loadWorkspace } from './store.js'

export const ctx = {
  workspace: loadWorkspace(),
  previewJob: null,
  exportJobs: new Map(),
  activeExportId: null,
}
