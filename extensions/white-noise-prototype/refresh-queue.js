// Runs `task` for many requests at once. Requests made within `delay` share one run,
// runs never overlap, and a request made during a run gets one more run after it. The
// returned promise settles after a run that started after the request.

export function coalesce(task, delay = 0) {
  let waiting = []
  let scheduled = false
  let running = false
  async function run() {
    scheduled = false
    running = true
    const batch = waiting
    waiting = []
    try {
      await task()
      for (const waiter of batch) waiter.resolve()
    } catch (error) {
      for (const waiter of batch) waiter.reject(error)
    } finally {
      running = false
      if (waiting.length) schedule()
    }
  }
  function schedule() {
    if (scheduled || running) return
    scheduled = true
    // The delay is not restarted by later requests, so a steady stream cannot starve it.
    setTimeout(run, delay)
  }
  return () => new Promise((resolve, reject) => {
    waiting.push({ resolve, reject })
    schedule()
  })
}
