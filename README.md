# TailVis: Expressive Chart Refinement Preserving Data-Binding Integrity

TailVis is an AI-assisted, Figma-style tool for authoring and refining data
visualizations. It builds on Vega-Lite and uses Claude for natural-language chart
creation and editing, with direct-manipulation widgets, a modification stack, and
lineage-based branching.

## Live Demo

A static demo is published via GitHub Pages: **https://tailvis.github.io/TailVis/**

In the demo you can browse the example gallery, pan/zoom, select elements, expand
semantic scopes, inspect the widgets and modification stack, and edit the Vega-Lite
spec directly — no setup required.

The **AI features** (natural-language chart creation, editing, and the chat/widget
refinement) need a backend, which static hosting can't run. To use them, run the backend
yourself and point the demo at it: run `npm run server` locally (with your Anthropic key
in `.env`), then click the **Backend** button in the demo's top bar and enter its URL
(e.g. `http://localhost:5105`). The frontend then routes its `/api` requests there.

> The demo is served over HTTPS. Chrome/Edge allow `http://localhost`, but a **remote**
> backend must be served over `https://` (Safari blocks plain `http`). CORS is already
> enabled on the backend.

## Getting Started

### 1. Install

```bash
npm install
```

### 2. Run

```bash
npm start
```

Then open http://localhost:5104 (the backend runs on port 5105; Vite proxies `/api` to it).

To run the two processes separately:

```bash
npm run server   # backend  (port 5105)
npm run dev      # frontend (port 5104)
```

### Build

```bash
npm run build
```

## Anthropic API key (required for AI features)

The AI features — natural-language chart creation, editing, and the chat/widget
refinement — call the Claude API and need an Anthropic API key. **You bring your own key.**

Put it in a `.env` file at the project root; the backend reads it:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at https://console.anthropic.com/settings/keys. Everything else (viewing,
selecting, the gallery, direct editing of the Vega-Lite spec) works without a key.

> The hosted static demo has no backend of its own, so instead of a key it asks for the
> **URL of a backend you run** (see [Live Demo](#live-demo)). That backend supplies the
> key from its own `.env` — the key is never entered in the demo page.

## Example Gallery

Click the **☆ Gallery** button in the top bar (or visit `?gallery`) to open the example
gallery — a grid of saved chart trees. Selecting one opens it in a **read-only** view of the
real editor scoped to that lineage tree: you can pan/zoom, select elements, expand scopes, and
inspect the widgets, modification stack, and dataset, but nothing can be edited. Use
`?gallery&example=<id>` to link directly to a specific example. No API key is needed to browse
the gallery.

## Project Structure

```
server.js              # Express API (modify-chart, chat-agent, create-chart) — per-request API key
vite.config.js         # Vite dev server; proxies /api → backend
src/
  App.jsx              # root: state, undo/redo, localStorage persistence
  components/          # Canvas, ChatAgent, PropertyPanel, ModificationPanel, Gallery, ApiKeyModal, …
  utils/               # scopeUtils, elementUtils, apiKey, dataUtils, …
  data/                # sample datasets
```
