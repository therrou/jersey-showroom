import { create } from 'zustand'

/** First-load progress: the GLB and every kit painted up to the first rack frame. */
interface LoadingState {
  started: number
  done: number
  /** The rack has drawn its first frames with every jersey on it. */
  ready: boolean
  setReady: () => void
}

export const useLoading = create<LoadingState>((set) => ({
  started: 0,
  done: 0,
  ready: false,
  setReady: () => set({ ready: true }),
}))

/** Count a loading promise toward the progress bar (only before the first rack frame). */
export function track<T>(p: Promise<T>): Promise<T> {
  if (useLoading.getState().ready) return p
  useLoading.setState((s) => ({ started: s.started + 1 }))
  const finish = () => useLoading.setState((s) => ({ done: s.done + 1 }))
  p.then(finish, finish)
  return p
}
