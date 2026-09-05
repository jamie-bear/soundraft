import { useState } from 'react'

export default function PageControls({ cursor, load, reload }: {
  cursor?: string | null; load: () => Promise<void>; reload?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="my-4 flex flex-wrap items-center gap-3">
    {cursor && <button className="rounded bg-surface-800 px-4 py-2 text-white disabled:opacity-50" disabled={busy}
      onClick={async () => { setBusy(true); setError(''); try { await load() } catch (e) { setError(e instanceof Error ? e.message : 'Could not load more') } finally { setBusy(false) } }}>
      {busy ? 'Loading…' : 'Load more'}</button>}
    {error && <span role="alert">{error} {reload && <button onClick={() => { setError(''); reload() }}>Reload</button>}</span>}
  </div>
}
