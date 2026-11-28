/**
 * Observe Marmot's reactive group list and return a handle that stops the
 * asynchronous iterator. The caller remains responsible for hydrating local
 * groups before enabling includeStateChanges.
 */
export function watchGroups(groupsManager, onChange, onError = () => {}) {
  const controller = new AbortController()

  void (async () => {
    try {
      for await (const groups of groupsManager.watch({
        includeStateChanges: true,
        signal: controller.signal
      })) {
        if (!controller.signal.aborted) onChange(groups)
      }
    } catch (error) {
      if (!controller.signal.aborted) onError(error)
    }
  })()

  return () => controller.abort()
}
