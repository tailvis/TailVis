import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
const App = lazy(() => import('./App.jsx'))
const GuidedDemo = lazy(() => import('./components/GuidedDemo.jsx'))
import './index.css'

// Read-only example gallery.
//   ?gallery                → grid of frozen examples (Gallery, lazy)
//   ?gallery&example=<id>   → the REAL editor rendered read-only, scoped to that frozen tree
// The bundled examples (galleryExamples.json, ~MBs of thumbnails) are loaded ONLY on the
// gallery routes via dynamic import, so the main editor bundle stays lean.
const Gallery = lazy(() => import('./components/Gallery.jsx'))

const GALLERY_KEY = 'chart-authoring-gallery'

// Resolve a single example by id: bundled examples first (lazy-loaded), then any
// user-saved ones in localStorage (empty on the public static demo).
async function loadGalleryExample(id) {
  try {
    const { GALLERY_EXAMPLES } = await import('./data/galleryExamples.js')
    const bundled = GALLERY_EXAMPLES.find(e => e.id === id)
    if (bundled) return bundled
  } catch { /* ignore */ }
  try {
    const list = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]')
    return list.find(e => e.id === id) || null
  } catch {
    return null
  }
}

function GalleryExampleView({ id }) {
  const [state, setState] = React.useState({ status: 'loading', example: null })
  React.useEffect(() => {
    let alive = true
    loadGalleryExample(id).then(example => {
      if (alive) setState({ status: example ? 'ready' : 'notfound', example })
    })
    return () => { alive = false }
  }, [id])

  if (state.status === 'loading') return <div style={{ padding: 40 }}>Loading example…</div>
  if (state.status === 'notfound') {
    return (
      <div style={{ padding: 40 }}>
        Example not found. <a href={import.meta.env.BASE_URL}>← Back to gallery</a>
      </div>
    )
  }
  // Real editor, frozen + read-only, scoped to this example's tree.
  return <App readOnly galleryExample={state.example} />
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2>Something went wrong.</h2>
          <button
            style={{ marginTop: 16, padding: '8px 24px', fontSize: 14, cursor: 'pointer' }}
            onClick={() => {
              localStorage.removeItem(new URLSearchParams(window.location.search).has('demo') ? 'tailvis-guided-demo-v1' : 'chart-authoring-state')
              window.location.reload()
            }}
          >
            Reset &amp; Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function Root() {
  const params = new URLSearchParams(window.location.search)
  if (params.has('demo')) return <GuidedDemo />
  if (params.has('system')) return <App />
  if (params.has('gallery') && params.get('example')) return <GalleryExampleView id={params.get('example')} />
  return <Gallery />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={<div className="route-loading">Loading TailVis…</div>}><Root /></Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
)
