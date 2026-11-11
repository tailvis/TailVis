# TailVis: Expressive Chart Refinement Preserving Data-Binding Integrity

TailVis is an AI-assisted tool for refining Vega-Lite charts through direct element
selection, natural-language requests, and on-demand widgets. It maintains a
modification history and supports branching to explore alternative refinements.

[Project page](https://tailvis.github.io/TailVis/) ·
[Paper](https://arxiv.org/abs/2607.25386)

## Project page and editor views

The home page includes the demo entry point, Paper and Source code links, a demo
video, four interactive feature illustrations, the example gallery, and a link to
the full system. Query parameters select the editor views on both local development
and GitHub Pages:

| View | URL | What it does |
| --- | --- | --- |
| Home / Gallery | `/` or `?gallery` | Introduces TailVis and lists saved examples. |
| Guided demo | `?demo` | Offers prepared refinements for three example charts. |
| Full system | `?system` | Opens the editor for your own data and free-form requests. AI features require a backend. |
| Gallery example | `?gallery&example=<id>` | Opens a saved history with adjustable widgets; changes are temporary. |

### Guided demo

The demo includes **Interaction patterns** (boxplot), **Employment change** (bar
chart), and **Population over time** (line chart). Click a chart and use **Try a
request** to choose a prepared refinement. Available requests reflect the current
chart state: completed requests disappear and follow-up requests become available.
Preview and adjust generated widgets, then apply the refinement or branch it.
Requests are handled by local presets; the guided demo does not call an LLM backend.

The data panel starts hidden. Clicking a chart or one of its elements shows that
chart's data in a floating panel without shifting the canvas. Selecting another
chart switches the displayed data. The demo data panel supports inspection and
selection, with no dataset browser, back button, or data editing controls.

Demo work is stored in the browser separately from the full editor. **Reset demo**
clears only the guided demo state. **System ↗** opens the full editor.

### Gallery

Gallery cards open saved examples and their refinement histories. You can pan and
zoom, select chart elements, expand selection scopes, inspect modifications and data,
and adjust widgets to preview chart changes. Widget changes propagate along the
example’s chart history, but are not saved: reopening or reloading the example
restores it. Use **Cmd/Ctrl+Z** to undo a widget change and **Cmd/Ctrl+Shift+Z**
to redo it. Free-form AI requests and other editing controls remain disabled. Examples come from the bundled gallery
and any previously saved examples in the same browser. The current editor UI
hides the **Save to Gallery** button.

### Modifications

In the guided demo and full system, the Modifications panel shows the property and
its **original value → current value**. Group changes use the same value display;
when original values differ, **Mixed** shows their values on hover. If no original
value was saved, the panel displays a dash. Modification values can be adjusted
inline, and modifications can be removed. Applying a group change again preserves
its initial original values.

Scope changes are made through chart selection. The Modifications panel has no
scope selector or applied-scope label.

## Run locally

Use Node.js 20 or later and npm. From the repository root:

```bash
npm install
npm start
```

This starts the Vite frontend at **http://localhost:5104** and the Express backend
at **http://localhost:5105**. Open `http://localhost:5104/?demo` for the guided demo or
`http://localhost:5104/?system` for the full editor. Vite proxies `/api` to the backend.

To run the frontend and backend separately:

```bash
npm run dev      # frontend, port 5104
npm run server   # backend, port 5105
```

Only `npm run dev` is needed to browse the home page, use the guided demo, or inspect
gallery examples.

### Enable free-form AI features

The full system uses Claude for natural-language chart creation and refinement.
Set your Anthropic API key in a `.env` file at the repository root before starting
the backend:

```dotenv
ANTHROPIC_API_KEY=your-anthropic-api-key
```

The server uses this key as a fallback. It also accepts a per-request key in the
`x-anthropic-key` header. The guided demo's preset requests do not require a key.

### Connect the hosted full system to a backend

GitHub Pages serves the frontend only. To use free-form AI features there:

1. Run `npm run server` with your Anthropic key configured in `.env`.
2. Open the hosted **Full system** (`?system`).
3. Click **Backend** in its header and enter the backend URL, such as
   `http://localhost:5105`, then save.

The backend URL is saved in browser localStorage and prepended to API requests.
The **Backend** button is available in the static build's full system, not in the
guided demo. The static build's connection dialog takes a backend URL rather than
an API key. Use HTTPS for a remotely hosted backend; localhost access also depends
on your browser's connection policies. The Express backend enables CORS.

## Build and preview

```bash
npm run build
npm run preview
```

The build writes to `dist/` with the `/TailVis/` asset base. With Vite's default
preview port, open **http://localhost:4173/TailVis/**.

For the static GitHub Pages build:

```bash
VITE_STATIC_DEMO=true npm run build
```

The GitHub Actions workflow uses this flag and deploys GitHub Pages on pushes to
`main` or a manual workflow run. The guided demo uses presets in either build;
the flag enables the hosted full system's backend connection UI.

## Project structure

```text
server.js                         Express API for AI chart creation and refinement
vite.config.js                    Development ports, API proxy, production asset base
public/media/tailvis-demo.mp4      Demo video
src/
  main.jsx                        Query-parameter routing and lazy loading
  App.jsx                         Editor state, modifications, undo/redo, persistence
  components/
    Gallery.jsx                   Home page and example gallery
    FeatureIllustrations.jsx      Interactive SVG feature illustrations
    GuidedDemo.jsx                Guided demo configuration and editor entry point
    Canvas.jsx                    Chart rendering, selection, and canvas overlays
    DataTable.jsx                 Data inspection and editing
    ModificationPanel.jsx         Property changes and original/current values
    ApiKeyModal.jsx               Backend/key connection dialog
  data/
    guidedDemo.js                 Example state, preset requests, and responses
    guidedInteractions.json       Guided interaction-patterns dataset
    galleryExamples.js            Bundled gallery loader
  utils/                          Selection, scope, rendering, data, and API helpers
tests/                            Unit and browser checks
```
