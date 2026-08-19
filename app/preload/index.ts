import electron from 'electron'

const { contextBridge } = electron

// IPC bridge for the review/edit UI, wired up starting build-order step 2.
contextBridge.exposeInMainWorld('api', {})
