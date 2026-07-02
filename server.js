import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import { jsonrepair } from 'jsonrepair'
import * as vl from 'vega-lite'
import fs from 'fs'
import path from 'path'
import { retrieveExamples, formatExamplesForPrompt } from './retrieveExamples.js'

dotenv.config()

const app = express()
const PORT = 5105

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Initialize Claude (Anthropic). Accept a few key-name variants (the .env has a
// misspelled CLAUE_API_KEY) so a typo doesn't silently disable every endpoint.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUE_API_KEY
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null
const LLM_MODEL = 'claude-opus-4-8'

// Public/open-source build: each LLM request brings the user's OWN Anthropic API key via the
// `x-anthropic-key` header (entered in the app's API-key dialog). A server-side key from .env
// is used only as a fallback for local development. Returns null when no key is available,
// in which case the endpoint responds 401 and the UI prompts the user to enter a key.
function clientForRequest(req) {
  const headerKey = (req.headers['x-anthropic-key'] || '').toString().trim()
  if (headerKey) return new Anthropic({ apiKey: headerKey })
  return anthropic  // .env fallback (may be null)
}
const NO_KEY_RESPONSE = { error: 'Anthropic API key required. Click "API Key" in the app and enter your key (sk-ant-…).' }

// Shared rule injected into every chart-generation prompt. The single most common
// LLM mistake is using "value" (a raw pixel constant that bypasses the scale) where
// "datum" (a data value passed through the scale) is required — see the 42000-pixel bug.
const DATA_POSITION_RULE = `POSITIONING AT A DATA VALUE — "value" vs "datum" (CRITICAL):
Vega-Lite treats these two channel keys completely differently. Confusing them is the single most common way to produce a broken chart, so apply this rule strictly:
- "value" sets a RAW VISUAL constant that BYPASSES the scale. For x/y it is a PIXEL coordinate measured from the top-left corner of the plotting area (y grows downward, 0 = top). For color/size/opacity it is the literal style. A "value" is NEVER passed through the axis scale.
- "datum" sets a DATA-SPACE constant that IS passed through the scale, landing at the same position the axis would map that data value to.
RULE: To place a mark, text label, or rule at a specific DATA position (a population of 42000, a year of 1980, a category name), you MUST use "datum" — NEVER "value".
  CORRECT (anchor a text label at population = 42000):
    "y": { "datum": 42000, "type": "quantitative" }
  WRONG (interpreted as 42000 PIXELS below the top edge -> far off a 250px-tall chart, the label vanishes):
    "y": { "value": 42000 }
- "value" is correct ONLY for true pixel placement (e.g. pinning a caption to the top with "y": {"value": 10}) or for non-positional constants like "color": {"value": "darkblue"}.
- A positional channel using "datum" does NOT take a "scale" object — the shared axis already owns the scale. Keep only "type" alongside "datum".
- WIDGET PATHS for data-positioned elements: expose the underlying DATA value the user actually thinks in (e.g. the year, the population), and point "path" at the field that drives it — the "datum" key, or, when a calculate transform builds a date, the source field in that layer's inline data.values. Do NOT expose a raw "encoding.y.value" pixel as if it were a data value.`

// Helper function to clean and parse JSON response
function parseJsonResponse(responseText) {
  // Handle empty or null response
  if (!responseText || responseText.trim() === '') {
    throw new Error('LLM returned empty response')
  }

  let cleanedResponse = responseText

  // Remove markdown code blocks if present
  if (cleanedResponse.includes('```')) {
    cleanedResponse = cleanedResponse
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
  }

  // Extract JSON object from response (find first { to last })
  const firstBrace = cleanedResponse.indexOf('{')
  const lastBrace = cleanedResponse.lastIndexOf('}')

  // If no JSON object found, throw error
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    console.error('No valid JSON object found in response:', responseText.substring(0, 200))
    throw new Error('LLM response does not contain valid JSON object')
  }

  cleanedResponse = cleanedResponse.substring(firstBrace, lastBrace + 1)

  // Remove control characters (0x00-0x1F except \n, \r, \t)
  cleanedResponse = cleanedResponse.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

  // Normalize quotes
  cleanedResponse = cleanedResponse
    .replace(/[\u2018\u2019]/g, "'")  // Replace fancy single quotes
    .replace(/[\u201C\u201D]/g, '"')  // Replace fancy double quotes

  // Fix common LLM error: missing } before ],
  // Pattern: ]\n    ], should be ]\n    }],
  cleanedResponse = cleanedResponse.replace(/\]\s*\n(\s*)\],/g, ']\n$1}],')

  // Use jsonrepair to fix malformed JSON (missing brackets, trailing commas, etc.)
  const repairedJson = jsonrepair(cleanedResponse)

  return JSON.parse(repairedJson)
}

// Validate Vega-Lite spec using vega-lite compiler
function validateVegaLiteSpec(spec) {
  try {
    // vega-lite compile will throw if spec is invalid
    vl.compile(spec)
    return { valid: true, error: null }
  } catch (error) {
    return { valid: false, error: error.message }
  }
}

// Post-process spec: enforce scale.zero=false on quantitative axes for non-bar charts
function applyScaleZeroFalse(spec) {
  if (!spec) return spec
  const barMarks = new Set(['bar', 'rect', 'arc'])
  const processLayer = (layer) => {
    if (!layer?.encoding) return
    const markType = typeof layer.mark === 'string' ? layer.mark : layer.mark?.type
    if (barMarks.has(markType)) return
    for (const ch of ['x', 'y']) {
      const enc = layer.encoding[ch]
      if (enc?.type === 'quantitative' && !enc.aggregate) {
        enc.scale = { ...enc.scale, zero: false }
      }
    }
  }
  if (spec.layer) {
    spec.layer.forEach(processLayer)
  } else if (spec.encoding) {
    processLayer(spec)
  }
  return spec
}

// Sanitize common LLM structural slips that crash vl.compile with cryptic errors.
function sanitizeSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec
  // A {facet, spec} operator spec must NOT carry a top-level `encoding` — that's invalid
  // and crashes the compiler ("Cannot read properties of undefined (reading 'concat')").
  // The real encoding already lives inside `spec` (or its layers), so drop the stray one.
  if (spec.facet && spec.spec && spec.encoding) {
    delete spec.encoding
  }
  return spec
}

// Helper function to call the Claude (Anthropic) API
async function callClaude(client, systemPrompt, userPrompt, model = LLM_MODEL) {
  const result = await client.messages.create({
    model,
    max_tokens: 8000,
    // NOTE: temperature is deprecated/unsupported on Opus 4.8 (claude-opus-4-8) —
    // passing it returns 400 invalid_request_error. Omit it.
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const outputText = result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')

  if (!outputText || outputText.trim() === '') {
    console.error('Claude returned empty response.')
    throw new Error('LLM returned empty response. Please try again.')
  }

  return outputText.trim()
}


// ─── Data Summary Helper ───────────────────────────────────────────────────

function inferColumnType(values) {
  const nonNull = values.filter(v => v != null && v !== '')
  if (nonNull.length === 0) return 'nominal'

  const datePatterns = [
    /^\d{4}-\d{2}(-\d{2})?$/,
    /^\d{4}\/\d{2}(\/\d{2})?$/,
    /^\d{2}\/\d{2}\/\d{4}$/,
  ]
  const isDate = nonNull.every(v => {
    const str = String(v).trim()
    return datePatterns.some(p => p.test(str)) || (!isNaN(Date.parse(str)) && typeof v === 'string' && isNaN(Number(v)))
  })
  if (isDate) return 'temporal'

  const isNumeric = nonNull.every(v => !isNaN(Number(v)) && typeof v !== 'boolean')
  if (isNumeric) return 'quantitative'

  return 'nominal'
}

function generateDataSummary(data) {
  if (!data || data.length === 0) return null
  const columns = Object.keys(data[0])
  return {
    rowCount: data.length,
    columns: columns.map(col => {
      const values = data.map(r => r[col]).filter(v => v != null && v !== '')
      const type = inferColumnType(values)
      const info = { name: col, type }
      if (type === 'quantitative') {
        const nums = values.map(Number).filter(n => !isNaN(n))
        nums.sort((a, b) => a - b)
        info.min = nums[0]
        info.max = nums[nums.length - 1]
        info.mean = +(nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(2)
      } else if (type === 'temporal') {
        const sorted = [...values].sort()
        info.min = sorted[0]
        info.max = sorted[sorted.length - 1]
      } else {
        const unique = [...new Set(values)]
        info.uniqueCount = unique.length
        if (unique.length <= 20) {
          info.uniqueValues = unique
        } else {
          info.sampleValues = unique.slice(0, 10)
        }
      }
      return info
    })
  }
}

// Strip data.values from a spec (recursively for layers), preserving small annotation layers
function stripSpecData(spec) {
  if (!spec) return spec
  const stripped = JSON.parse(JSON.stringify(spec))
  // Remove top-level data.values if present
  if (stripped.data?.values) {
    stripped.data = { values: [] }  // keep data key but empty values
  }
  // For layers: only strip the main data layer (not small annotation inline data)
  if (Array.isArray(stripped.layer)) {
    stripped.layer = stripped.layer.map(layer => {
      if (layer.data?.values && layer.data.values.length > 10) {
        // Large inline data in a layer → strip it
        return { ...layer, data: { values: [] } }
      }
      return layer
    })
  }
  return stripped
}

// API endpoint to modify Vega-Lite spec with NL command
app.post('/api/modify-chart', async (req, res) => {
  try {
    const client = clientForRequest(req)
    if (!client) return res.status(401).json(NO_KEY_RESPONSE)

    const { currentSpec, command } = req.body

    if (!currentSpec || !command) {
      return res.status(400).json({ error: 'Missing currentSpec or command' })
    }

    // Strip data.values from spec before sending to LLM (save tokens)
    const specForLLM = stripSpecData(currentSpec)
    const rawData = currentSpec?.data?.values
    const dataSummary = rawData && rawData.length > 0 ? generateDataSummary(rawData) : null

    const systemPrompt = `You are a Vega-Lite expert. Given a Vega-Lite specification and a user instruction, modify the specification and provide adjustable widget options.

NOTE: The spec's data.values has been stripped to save tokens. A dataSummary is provided separately with column names, types, and statistics. When outputting the modified spec, set data.values to [] — the frontend will inject the actual data automatically.

OUTPUT CONTRACT (STRICT — any violation breaks the parser and fails the request):
- Return EXACTLY ONE JSON object and NOTHING ELSE. Your entire response MUST start with "{" and end with "}". No markdown code fences (no \`\`\`json), no prose, no explanation, no summary, no notes BEFORE or AFTER the JSON.
- Do NOT append any trailing description after the closing brace — e.g. NEVER write "주요 변경사항:", "Summary of changes", "변경 내용", or any commentary. The character immediately after your final "}" must be the end of the response.
- ENGLISH ONLY. Every human-readable string you author — every widget "label", the "widget_title", and any title/text/label you write into the spec — MUST be in English. NEVER emit Korean or any other non-English text anywhere in your response. (The user's instruction may be in Korean; your OUTPUT must still be English.)

OUTPUT FORMAT (JSON):
{
  "spec": { /* the modified Vega-Lite specification */ },
  "widget_title": "Short descriptive title for the widget group (2-4 words, e.g. 'Highlight Settings', 'Bar Color', 'Font Style')",
  "widget_options": [
    {
      "id": "unique_option_id",
      "label": "Display label in ENGLISH (e.g. 'Bar Color', 'Opacity', 'X Label Angle')",
      "type": "color|number|select|boolean|text",
      "value": "current value in the spec",
      "path": "exact JSON path in the spec where this value is located",
      "min": 0, "max": 100, "step": 1,  // for number type only
      "options": ["opt1", "opt2"],  // REQUIRED for select type — must include all valid choices
      "valueTemplate": "expression with {value} placeholder"  // REQUIRED when path points to a string expression
    }
  ]
}

RULES FOR SPEC:
1. The spec's data.values has been STRIPPED to save tokens. Set data.values to [] in your output — the frontend injects actual data automatically. Do NOT fabricate data rows.
2. Use the provided dataSummary to understand field names, types, and value ranges (unique values for nominal, min/max/mean for quantitative, min/max for temporal).
3. If you add a NEW layer that needs its OWN inline data (e.g., rect annotation with custom coordinates), that layer CAN have its own "data": { "values": [...] } with the inline data you create.
4. Transforms (filter, joinaggregate, calculate, etc.) are fine — they operate on the data at runtime. Reference field names from the dataSummary.
5. Always output valid Vega-Lite v6 JSON (use schema https://vega.github.io/schema/vega-lite/v6.json)
6. Even if the spec structure produces no error, think carefully about the visual render result. Consider how your changes will look with the actual data.
7. For scatter plots, line charts, and area charts, use "scale": {"zero": false} on quantitative x/y encodings so axes fit the data range. Do NOT add this to bar charts (bars need a zero baseline).

LAYER STRUCTURE RULES:
0. FACETED specs (a "column"/"row"/"facet" encoding, e.g. a violin plot). Faceting CANNOT be a sibling of a "layer" array — putting "column"/"row" in a layered spec's shared "encoding" silently fails to facet (all groups collapse into ONE cell, overlapping). Two valid forms by mark count:
   - SINGLE mark (no overlay needed): keep a UNIT spec — mark + encoding at top level, with column/row alongside x/y/color.
   - MULTIPLE layers (e.g. adding raw points / a strip over a violin): you MUST switch to the "facet" OPERATOR that WRAPS the layered spec:
       { "facet": {"column": {"field":"<GROUP>", ...}}, "spec": { "width":100, "layer": [ <violin>, <points> ] } }
     The faceted field's per-group transforms (e.g. density groupby) stay INSIDE the relevant layer. Data goes at the TOP level next to "facet". NEVER leave "column"/"row" in the inner layer encodings.
1. Otherwise the input spec will be a layered spec (with a "layer" array). NEVER convert a layered spec to a non-layered one.
2. When adding new elements (rect backgrounds, reference lines, annotations, trend lines), ALWAYS append new layers at the END of the layer array. NEVER insert at the beginning or middle.
3. NEVER reorder existing layers — their indices must remain stable so that existing widget paths (e.g. "layer[0].mark.color") continue to work.
4. If you need to modify an existing layer, edit it in place. Do not remove and re-add it.

RECT BACKGROUND RULES:
The input spec already uses a layered structure. When adding rect backgrounds:
1. APPEND the rect layer at the END of the layer array.
2. For highlighting a SINGLE category on a nominal axis:
   Use filter pattern with rect layer:
   {"mark": {"type": "rect", "opacity": 0.2, "color": "#ffcccc"},
    "transform": [{"filter": "datum.Region == 'East'"}],
    "encoding": {"x": {"field": "Region", "type": "nominal"}}}
3. For highlighting a time RANGE on a temporal axis:
   Use separate inline data with field references:
   {"mark": {"type": "rect", "opacity": 0.2},
    "data": {"values": [{"start": "2024-05-01", "end": "2024-09-01"}]},
    "encoding": {"x": {"field": "start", "type": "temporal"},
                 "x2": {"field": "end", "type": "temporal"},
                 "color": {"value": "lightblue"}}}
4. For MULTIPLE background regions: single rect layer with inline data and color field with scale:null.
5. INLINE DATA FIELD NAMING: NEVER use "x", "x2", "y", "y2" as field names — use "start", "end", etc.
6. AXIS: The rect layer must NOT use "axis": null. Either omit axis config (preferred) or use "axis": {"title": null}.
7. SCALE DOMAIN: If the rect layer shares an axis with the data layer, ensure both layers use the same scale domain. Copy the domain from the existing data layer to the rect layer's encoding.

${DATA_POSITION_RULE}

RULES FOR WIDGET_OPTIONS:
1. Include options for elements you ADDED or MODIFIED. You may also include 1-2 closely related properties the user would naturally want to adjust next (e.g., if you changed color, you can also add opacity).
2. Max 5 widget options per change — do not exceed this.
3. For select types, include ALL valid choices in options array.
4. WIDGET ↔ SPEC CONSISTENCY (MANDATORY): Every widget's "path" MUST resolve to a value that is PHYSICALLY PRESENT in the "spec" you return. If you want a widget for a property that is not yet in the spec (e.g. mark.opacity, mark.cornerRadius, encoding.color.scale.scheme), you MUST FIRST write that property — and every parent object it needs — into the spec at exactly that path, with its default value. Creating a widget whose path does not exist in the spec is FORBIDDEN: either add the property to the spec, or drop the widget. Do NOT point a path at a nested object that does not exist (e.g. "...color.scale.scheme" when there is no color encoding, or no scale object).
5. The "path" must EXACTLY match where the value exists in your final spec
   - Use dot notation: "mark.color"
   - Use [index] for arrays: "layer[1].mark.color"
6. The "value" must be the actual current value at that path in your spec
7. For number types, provide sensible min/max/step
8. LABEL LENGTH: Keep "label" short and clear — max 3-4 words (e.g., "Bar Color", "Font Size", "X Label Angle"). Do NOT use long descriptive phrases.

WIDGET TYPE SELECTION — select vs text:
- Use "select" ONLY for properties with a PREDEFINED finite set of valid choices:
  color schemes (e.g. "category10", "set2", "blues"), interpolation methods, mark types,
  aggregate functions, timeUnit, stack modes, legend orient, axis orient, font families, etc.
- Use "text" for FREE-FORM string values the user should type themselves:
  titles, labels, annotation text, axis title text, mark.text content, filter expressions, custom format strings, etc.
- Do NOT make free-form text inputs into select dropdowns — it prevents the user from entering their own values.

CRITICAL - PATH ACCURACY:
Before outputting EACH widget_option, mentally walk its "path" through the spec you are about to return, key by key, and confirm:
- Every segment of the path exists in my spec (the leaf AND every parent object). If any segment is missing, I MUST add it to the spec first (see WIDGET rule 4) — or delete this widget.
- The value living at that path in my spec is IDENTICAL to what I put in "value".
- If the spec uses layers, the layer index points at the layer that actually contains this property.
A widget pointing at a path that is absent from the spec is a hard failure — never emit one.

CRITICAL - CONDITION TEST VALUES (condition.test expressions):
When writing predicate tests for conditional encodings, follow this rule strictly:

**Rule: Literal vs. Data-Dependent values**

A) USER-SPECIFIED LITERAL — use the value directly in the test:
   User says "8000 이상", "전자제품 카테고리", "0보다 작은 값"
   → Use the literal: datum.Revenue >= 8000, datum.category == 'Electronics', datum.value < 0
   → Widget: expose a number/text slider with valueTemplate so user can adjust

B) DATA-DEPENDENT AGGREGATE — NEVER hardcode a guessed value. Always compute dynamically via transform:
   User says "최댓값", "최솟값", "평균 이상", "중앙값보다 큰", "상위 N%", etc.
   → Add a "joinaggregate" transform to compute the value as a new field on each row
   → Reference the computed field in the test expression
   → Widget: only expose color/style options (NOT a number slider for the threshold, since it's dynamic)

EXAMPLE — "최댓값을 빨간색으로":
  WRONG: { "test": "datum.Revenue >= 9400", "value": "#ff0000" }   ← hardcoded guess, will break with different data
  CORRECT:
    "transform": [{ "joinaggregate": [{ "op": "max", "field": "Revenue", "as": "_max_Revenue" }] }],
    "encoding": { "color": { "condition": { "test": "datum.Revenue === datum._max_Revenue", "value": "#ff0000" }, "value": "#9dadbe" } }

EXAMPLE — "평균 이상을 강조":
  WRONG: { "test": "datum.Revenue >= 7500" }   ← hardcoded average
  CORRECT:
    "transform": [{ "joinaggregate": [{ "op": "mean", "field": "Revenue", "as": "_mean_Revenue" }] }],
    "encoding": { "color": { "condition": { "test": "datum.Revenue >= datum._mean_Revenue", "value": "#ff0000" }, "value": "#9dadbe" } }

Supported joinaggregate ops: "max", "min", "mean", "median", "sum", "count", "stdev", "q1", "q3"
Use a leading underscore (e.g. _max_Revenue) to avoid colliding with original data field names.

CRITICAL - valueTemplate:
Use "valueTemplate" whenever "path" points to a STRING expression that CONTAINS the adjustable value as part of a larger expression.
The {value} placeholder marks the part the user will change — it can be any type (number, string, etc.).
- Set "value" to ONLY the adjustable part (its current value in the spec)
- Set "valueTemplate" to the FULL expression string with {value} where the adjustable part appears
Examples:
  Numeric threshold:
    path: "encoding.color.condition.test"  ← "datum.sum_Revenue >= 8000"
    value: 8000
    valueTemplate: "datum.sum_Revenue >= {value}"
  String filter:
    path: "transform[0].filter"  ← "datum.category == 'Electronics'"
    value: "Electronics"
    valueTemplate: "datum.category == '{value}'"
  Mixed expression:
    path: "encoding.color.condition.test"  ← "datum.name == 'Alice' || datum.value > 100"
    value: 100
    valueTemplate: "datum.name == 'Alice' || datum.value > {value}"
Do NOT use valueTemplate when the path points directly to a scalar value (e.g. "mark.opacity" → 0.8).

CRITICAL - Gradient stops (mark.fill.gradient):
When a gradient uses rgba() strings in stops[N].color, do NOT create separate widgets for color and opacity pointing to the same path. Instead:
- For color control: path = "layer[N].mark.fill.stops[0].color", value = "#b4b4b4", valueTemplate = "rgba({value},0.6)" where {value} is the hex/rgb part — but this is complex. SIMPLER APPROACH:
- Split the rgba into separate stops properties if possible, OR
- Create ONE widget per stop that controls the full rgba string:
  value: "rgba(180,180,180,0.6)"
  valueTemplate: "rgba(180,180,180,{value})"  ← only expose opacity as {value}
- NEVER map two widgets (color + opacity) to the exact same path — only one can win.
- Preferred: use separate mark properties like "fillOpacity" (scalar 0-1) for opacity control, and a hex color for the stop color. Restructure the spec if needed.

Return ONLY valid JSON with both "spec" and "widget_options" fields.`

    const baseUserPrompt = `Current Vega-Lite specification (data.values stripped to save tokens):
${JSON.stringify(specForLLM, null, 2)}
${dataSummary ? `\nData Summary (use this to understand the dataset — actual values not shown):
${JSON.stringify(dataSummary, null, 2)}` : ''}

User instruction: "${command}"

IMPORTANT: In your output spec, set data.values to [] — the frontend injects actual data automatically.

Return the modified Vega-Lite specification:`

    // RAG: inject validated reference examples relevant to the command (after rules).
    const examples = retrieveExamples(command, { topK: 3 })
    const exampleBlock = formatExamplesForPrompt(examples)
    const fullSystemPrompt = exampleBlock ? `${systemPrompt}\n\n${exampleBlock}` : systemPrompt
    console.log('[modify-chart] retrieved examples:', examples.map(e => e.id))

    // Validation loop
    const MAX_ATTEMPTS = 3
    let result = null
    let lastError = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Build user prompt with error feedback if this is a retry
      let userPrompt = baseUserPrompt
      if (lastError) {
        userPrompt = `${baseUserPrompt}

IMPORTANT - PREVIOUS ATTEMPT FAILED:
Your previous response produced an invalid Vega-Lite spec with this error:
"${lastError}"

Please fix this error and return a valid Vega-Lite specification.`
      }

      const responseText = await callClaude(client, fullSystemPrompt, userPrompt)
      result = parseJsonResponse(responseText)

      // Validate the generated spec
      const validation = validateVegaLiteSpec(result.spec)

      if (validation.valid) {
        applyScaleZeroFalse(result.spec)
        break
      } else {
        lastError = validation.error
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`Failed to generate valid Vega-Lite spec after ${MAX_ATTEMPTS} attempts. Last error: ${validation.error}`)
        }
      }
    }

    console.log('\n modify:', JSON.stringify(result, null, 2))

    const widgetOptions = result.widget_options || []

    res.json({
      spec: result.spec,
      widget_title: result.widget_title || '',
      widget_options: widgetOptions,
      retried: lastError != null
    })
    console.log('\n[SYSTEM modify-chart]')
    console.log('  widget_title:', result.widget_title)
    console.log('  widget_options:', widgetOptions.map(o => `${o.label} (${o.type}): ${JSON.stringify(o.value)}`))

  } catch (error) {
    console.error('Error processing command:', error)
    res.status(500).json({ error: error.message || 'Internal server error' })
  }
})

// Chat agent prompt
const chatAgentPrompt = `You are a helpful chart modification assistant. You help users modify Vega-Lite charts through conversation.

Your role:
1. Understand what the user wants to do with their chart
2. Ask clarifying questions if the request is ambiguous or has issues
3. When ready, generate the modified spec and widget options

OUTPUT CONTRACT (STRICT — any violation breaks the parser):
- Return EXACTLY ONE JSON object and NOTHING ELSE. Your entire response MUST start with "{" and end with "}". No markdown code fences (no \`\`\`json), no text before or after the JSON.
- ENGLISH ONLY. Every string you author — the "message", every widget "label", titles, and any text/label you write into the spec — MUST be in English. NEVER emit Korean or any other non-English text. (The user may write to you in Korean; your output is still English.)

IMPORTANT BEHAVIORS:
- If the user's request cannot be fulfilled (e.g., missing data fields, incompatible chart type), explain why and offer alternatives
- If the request is clear and valid, generate the spec immediately
- Keep responses concise and friendly
- Always respond in English

IMPORTANT: The input spec usually uses a layered structure with a "layer" array — maintain it (append new layers at the END, never reorder, never flatten to non-layered). FACETED specs (a "column"/"row"/"facet" encoding, e.g. a violin plot): faceting can NEVER sit in a layered spec's shared "encoding" (the facet is ignored and all groups collapse into one overlapping cell). If the faceted chart has a SINGLE mark, keep it a unit spec. If you must ADD a layer to it (e.g. overlay raw points on a violin), convert it to the "facet" OPERATOR form: { "facet": {"column": {...}}, "spec": { "layer": [ <existing>, <new> ] } } — see the LAYER STRUCTURE RULES and any injected violin example.

DATA HANDLING:
- The spec's data.values has been STRIPPED to save tokens. A dataSummary is provided with column names, types, and statistics.
- Set data.values to [] in your output spec — the frontend injects actual data automatically.
- Use the dataSummary to understand field names, types, and value ranges for correct field references, condition tests, and transforms.
- If you add a new layer with its own inline data (e.g., rect annotations), that layer CAN have its own data.values.
- Even if the spec structure produces no error, think carefully about the visual render result. Consider how your changes will look with the actual data.
- For scatter plots, line charts, and area charts, use "scale": {"zero": false} on quantitative x/y encodings so axes fit the data range. Do NOT add this to bar charts (bars need a zero baseline).

OUTPUT FORMAT (JSON only):
{
  "message": "Your response message to the user (in ENGLISH)",
  "status": "clarifying" | "ready" | "error",
  "change_type": "data_transformation" | "chart_type" | "visual_refinement" | null,
  "new_spec": { /* Vega-Lite spec if status is ready */ } | null,
  "widget_preview": [
    {
      "id": "unique_option_id",
      "label": "Display label in ENGLISH",
      "type": "color" | "number" | "select" | "boolean" | "text",
      "value": "current value in the spec",
      "path": "exact JSON path in spec (e.g., mark.color, encoding.x.axis.labelAngle)",
      "options": ["opt1", "opt2"]  // REQUIRED for select type — must list all valid choices
      // Use "select" ONLY for predefined finite choices (color schemes, mark types, aggregates, etc.)
      // Use "text" for free-form strings (titles, labels, annotation text, format strings, etc.)
    }
  ] | null,
  "actions": [
    { "type": "apply" | "cancel" | "custom", "label": "button label", "primary": true/false, "changeType": "..." }
  ] | null
}

CHANGE_TYPE CLASSIFICATION (STRICT):
- "data_transformation": ONLY when the request actually reshapes the DATA — aggregation, binning,
  filtering rows, pivot/fold, computing a new field, changing granularity. This is the only type
  that branches off visually; use it sparingly.
- "chart_type": switching the mark/chart family (bar↔line↔scatter↔area↔point, etc.) WITHOUT
  reshaping the data. A chart-type switch is NOT a data_transformation.
- "visual_refinement": styling, colors, axes, labels, annotations, highlights, mark options, legend.
- DEFAULT: if unsure, use "visual_refinement". Reserve "data_transformation" for genuine data reshaping
  ONLY — never label a plain chart-type switch or styling change as data_transformation.

When status is "ready":
- Include the complete modified Vega-Lite spec in new_spec
- Include widget_preview with adjustable options ONLY for the NEWLY ADDED or MODIFIED elements
  - CRITICAL: Do NOT include options for pre-existing elements
- WIDGET ↔ SPEC CONSISTENCY (MANDATORY): every widget "path" MUST resolve to a value physically present in new_spec. If you want a widget for a property not yet in the spec, FIRST write that property (and its parent objects) into new_spec at exactly that path with a default value. A widget whose path is absent from the spec is FORBIDDEN — add the property or drop the widget.
- Include actions with at least an "apply" button


LAYER OVERLAY INVARIANT (applies to ANY layer you append on top of an existing
base chart — markers, value labels, rule/reference lines, rect highlights, etc.):
The FIRST layer owns the axes, scales, and axis titles for each shared channel.
A layer you append that reuses an existing channel (x/y) is a VISUAL OVERLAY, not
an axis owner. Therefore:
1. An overlay MUST NOT emit competing axis metadata on a shared channel. If two
   layers on the same channel both produce a title/scale, Vega-Lite concatenates
   them and the result is corrupted (garbled "title, title" axis labels, or a
   fought-over scale domain).
2. The #1 cause of this corruption is an aggregate/argmax encoding on the
   overlay's shared channel. So DO NOT aggregate in the overlay's encoding —
   compute the value in a "transform" and reference the field plainly:
     WRONG (pollutes the y-axis title):
       {"mark":"circle","encoding":{"y":{"field":"v","type":"quantitative","aggregate":{"argmax":"v"}}}}
     RIGHT (overlay shares the base axis cleanly):
       {"transform":[{"joinaggregate":[{"op":"max","field":"v","as":"_peak"}]},
                     {"filter":"datum.v === datum._peak"}],
        "mark":"circle","encoding":{"x":{"field":"t"},"y":{"field":"v","type":"quantitative"}}}
   Plain matching field refs let Vega-Lite reuse the base layer's single title —
   no "axis":null needed (and "axis":null on an aggregate encoding can even fail
   to compile). For min/peak use op "min"/"max"; for a mean line use "mean".
3. The base layer alone decides a shared channel's scale domain. An overlay
   inherits it — it does not restate it.
4. A marker + its text label must use the SAME transform/encoding so they land on
   the same row. Offset the label with dx/dy and show its value via "text" + "format".

OVERLAY GOTCHAS (non-obvious Vega-Lite traps, not recipes):
- An overlay with its OWN inline data (e.g. a date-RANGE rect: {"start":...,"end":...})
  does NOT share the base data, so it CAN'T inherit the domain by field name — give
  that layer the same scale domain as the base layer's channel.
- In such inline data, NEVER name a field "x","x2","y","y2" — use "start","end", etc.

For concrete per-chart-type overlay structures, follow the RELEVANT EXAMPLE SPECS
injected below.

${DATA_POSITION_RULE}

When status is "clarifying":
- Ask your question in message
- include actions as quick response buttons

When status is "error":
- Explain the issue and offer alternatives

CRITICAL — ELEMENT REFERENCES:
When the user message includes "=== SELECTED ELEMENTS ===" context, the user has physically clicked on chart elements in the UI before chatting. This is NOT about Vega-Lite selection parameters/interactions. Rules:
1. The user wants to visually modify these specific elements (change color, size, opacity, etc.)
2. Target modifications using datum values from the element references. For example, if element has data Region="East", use encoding.color.condition with test "datum.Region == 'East'" and the desired value.
3. NEVER respond with "선택 기능이 활성화되어 있지 않습니다" or suggest adding Vega-Lite params.selection. The selection already happened in the UI — do NOT add any Vega-Lite selection interaction.
4. If the user says "이거 빨간색으로 바꿔줘" with a selected element, change that specific element's color to red using a condition on its datum values.
5. If multiple elements are selected, apply the change to all of them unless told otherwise.
6. Use the current style properties from the references to set original values in widget_options.
7. When the element has aggregate values in the datum, use joinaggregate if needed to target the correct aggregated value.

NUMBERED REFERENCES:
When the user's message contains [1], [2], [3] etc., these refer to specific chart elements they clicked during the chat. The element details are provided in the context. Rules:
1. [1] means the first referenced element. Use its datum values to target it precisely.
2. The user may say things like "[1]은 빨간색으로, [2]는 파란색으로" — apply different modifications to different elements.
3. Target each element using condition tests based on their datum values.
4. If the user says "[1]과 [2]를 합쳐줘" or similar data operations, modify the data/encoding accordingly.
5. NEVER confuse these with Vega-Lite selection parameters.`

// Chat agent API
app.post('/api/chat-agent', async (req, res) => {
  try {
    const client = clientForRequest(req)
    if (!client) return res.status(401).json(NO_KEY_RESPONSE)

    const { chartSpec, message, conversationHistory, elementReferences, numberedReferences } = req.body

    if (!chartSpec || !message) {
      return res.status(400).json({ error: 'Missing chartSpec or message' })
    }

    // Build element context if selected elements are provided
    let elementContext = ''
    if (elementReferences && elementReferences.length > 0) {
      elementContext = `\n\n=== SELECTED ELEMENTS (user has already selected these via direct click — do NOT add Vega-Lite selection params) ===\n`
      elementContext += `The user has directly clicked and selected ${elementReferences.length} element(s) on the chart canvas.\n`
      elementContext += `These are NOT Vega-Lite "selection" interactions. The user physically selected these marks and wants to modify them.\n\n`
      for (const ref of elementReferences) {
        elementContext += `- Element ${ref.ref}: ${ref.markType} mark`
        if (ref.datum) {
          const datumStr = Object.entries(ref.datum)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ')
          elementContext += ` | data: {${datumStr}}`
        }
        if (ref.properties) {
          const propsStr = Object.entries(ref.properties)
            .filter(([, v]) => v != null && v !== '' && v !== 'none')
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
          if (propsStr) elementContext += ` | current style: {${propsStr}}`
        }
        elementContext += '\n'
      }
      elementContext += `\nIMPORTANT: When the user refers to "selected", "this", "these", "it", they mean the elements above. Modify them by targeting their datum values (e.g., condition test on datum.Region == 'East'). Do NOT add Vega-Lite params.selection — the selection already happened in the UI.\n`
    }

    // Build numbered references context (Scenario B)
    let numberedContext = ''
    if (numberedReferences && numberedReferences.length > 0) {
      numberedContext = `\n\n=== NUMBERED ELEMENT REFERENCES ===\n`
      numberedContext += `The user has clicked specific chart elements during this chat and assigned them numbers.\n`
      numberedContext += `In their message, [1], [2], [3] etc. refer to these specific elements:\n\n`
      for (const ref of numberedReferences) {
        numberedContext += `[${ref.ref}] = ${ref.markType} mark`
        if (ref.datum) {
          const datumStr = Object.entries(ref.datum)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ')
          numberedContext += ` | data: {${datumStr}}`
        }
        if (ref.properties) {
          const propsStr = Object.entries(ref.properties)
            .filter(([, v]) => v != null && v !== '' && v !== 'none')
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
          if (propsStr) numberedContext += ` | style: {${propsStr}}`
        }
        numberedContext += '\n'
      }
      numberedContext += `\nWhen the user writes [1], [2], etc., they mean EXACTLY the elements above. Modify them by targeting their datum values. Do NOT add Vega-Lite selection params.\n`
    }

    // Strip data.values from chat agent spec too
    const chatSpecForLLM = stripSpecData(chartSpec)
    const chatRawData = chartSpec?.data?.values
    const chatDataSummary = chatRawData && chatRawData.length > 0 ? generateDataSummary(chatRawData) : null

    const userPrompt = `Current Vega-Lite specification (data.values stripped to save tokens):
${JSON.stringify(chatSpecForLLM, null, 2)}
${chatDataSummary ? `\nData Summary:\n${JSON.stringify(chatDataSummary, null, 2)}` : ''}
${elementContext}${numberedContext}

Conversation history:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

User's new message: "${message}"

IMPORTANT: In your output spec, set data.values to [] — the frontend injects actual data automatically.

Respond to the user:`

    // RAG: inject validated reference examples relevant to the edit (topK=2 — this
    // prompt is already large with spec + history + element refs). After the rules.
    const chatExamples = retrieveExamples(message, { topK: 2 })
    const chatExampleBlock = formatExamplesForPrompt(chatExamples)
    const fullChatPrompt = chatExampleBlock ? `${chatAgentPrompt}\n\n${chatExampleBlock}` : chatAgentPrompt
    console.log('[chat-agent] retrieved examples:', chatExamples.map(e => e.id))

    const responseText = await callClaude(client, fullChatPrompt, userPrompt)
    let parsed
    try {
      parsed = parseJsonResponse(responseText)
    } catch {
      // LLM replied with plain text instead of JSON — wrap as clarifying response
      parsed = {
        message: responseText.replace(/```[\s\S]*?```/g, '').trim(),
        status: 'clarifying',
        new_spec: null,
        actions: [{ type: 'cancel', label: 'Cancel', primary: false }]
      }
    }

    // Validate spec if ready
    if (parsed.status === 'ready' && parsed.new_spec) {
      sanitizeSpec(parsed.new_spec)
      applyScaleZeroFalse(parsed.new_spec)
      const validation = validateVegaLiteSpec(parsed.new_spec)
      if (!validation.valid) {
        // Try to fix by asking LLM again
        const fixPrompt = `The spec you generated has an error: "${validation.error}"
Please fix it and return the corrected JSON response.`

        const fixResponse = await callClaude(client, fullChatPrompt, fixPrompt)
        const fixedParsed = parseJsonResponse(fixResponse)

        if (fixedParsed.new_spec) {
          sanitizeSpec(fixedParsed.new_spec)
          const revalidation = validateVegaLiteSpec(fixedParsed.new_spec)
          if (revalidation.valid) {
            applyScaleZeroFalse(fixedParsed.new_spec)
            return res.json({ ...fixedParsed, retried: true })
          }
        }

        // If still invalid, log the offending spec so cryptic vl.compile crashes
        // (e.g. "Cannot read properties of undefined (reading 'concat')") can be diagnosed.
        console.error('[chat-agent] spec failed validation:', validation.error)
        console.error('[chat-agent] offending spec:\n', JSON.stringify(parsed.new_spec, null, 2))
        console.error('[chat-agent] retried spec:\n', JSON.stringify(fixedParsed?.new_spec, null, 2))
        return res.json({
          message: `An error occurred while generating the spec: ${validation.error}. Please try again.`,
          status: 'error',
          retried: true,
          actions: [{ type: 'cancel', label: 'Cancel', primary: false }]
        })
      }
    }

    // Ensure an apply (and cancel) action always exists when new_spec is ready —
    // even if the LLM returned a non-empty actions list that omits 'apply'.
    if (parsed.new_spec) {
      const actions = Array.isArray(parsed.actions) ? parsed.actions : []
      if (!actions.some(a => a.type === 'apply')) {
        actions.unshift({ type: 'apply', label: 'Apply', primary: true })
      }
      if (!actions.some(a => a.type === 'cancel')) {
        actions.push({ type: 'cancel', label: 'Cancel', primary: false })
      }
      parsed.actions = actions
    }

    // Ensure widget_preview is always an array
    if (parsed.widget_preview && !Array.isArray(parsed.widget_preview)) {
      try { parsed.widget_preview = Object.values(parsed.widget_preview) } catch { parsed.widget_preview = [] }
    }

    console.log('\n chat-agent:', JSON.stringify(parsed, null, 2))

    res.json(parsed)

  } catch (error) {
    console.error('Chat agent error:', error)
    res.status(500).json({ error: error.message || 'Internal server error' })
  }
})

// Create chart from data + NL command (encoding scenario)
app.post('/api/create-chart', async (req, res) => {
  try {
    const client = clientForRequest(req)
    if (!client) return res.status(401).json(NO_KEY_RESPONSE)

    const { data_columns, selected_columns, user_command, data } = req.body

    if (!user_command) {
      return res.status(400).json({ error: 'Missing user_command' })
    }

    const systemPrompt = `You are a Vega-Lite v6 expert. The user wants to create a new chart from their data.

AVAILABLE DATA COLUMNS:
${JSON.stringify(data_columns, null, 2)}

SELECTED COLUMNS (user highlighted these — use them preferentially):
${JSON.stringify(selected_columns)}

SAMPLE DATA (first 5 rows):
${JSON.stringify((data || []).slice(0, 5), null, 2)}

Create a Vega-Lite v6 specification based on the user's request. Use the provided data columns and types.

OUTPUT CONTRACT (STRICT — any violation breaks the parser and fails the request):
- Return EXACTLY ONE JSON object and NOTHING ELSE. Your entire response MUST start with "{" and end with "}". No markdown code fences (no \`\`\`json), no prose, no explanation, no notes BEFORE or AFTER the JSON.
- ENGLISH ONLY. Every human-readable string you author — every widget "label", the "widget_title", and any title/text/label written into the spec — MUST be in English. NEVER emit Korean or any other non-English text. (The user's request may be in Korean; your output is still English.)

CHART TYPE RULES:
- For line charts, ALWAYS use mark: { type: "line", point: true } to show data points on the line.
- For scatter plots, line charts, and area charts, add "scale": {"zero": false} to quantitative x and y encodings so axes fit the data range. Do NOT add this to bar charts (bars need a zero baseline).

OUTPUT FORMAT (JSON only, no markdown):
{
  "spec": {
    "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
    "data": { "values": [] },
    "layer": [
      {
        "mark": "...",
        "encoding": { ... }
      }
    ],
    "width": 400,
    "height": 250
  },
  "widget_title": "Short descriptive title for the widget group (2-4 words, e.g. 'Line Chart Style', 'Color Encoding', 'Axis Settings')",
  "widget_options": [
    {
      "id": "unique_id",
      "label": "Display Label in ENGLISH",
      "type": "select|number|color|boolean|text",
      "value": "current_value",
      "path": "dot.path.in.spec",
      "options": ["opt1", "opt2"],  // select type only — for predefined finite choices
      "valueTemplate": "full expression with {value} as placeholder"  // use when path points to a string expression containing the adjustable value
    }
  ]
}

IMPORTANT — ALWAYS USE LAYERED SPEC (with ONE exception below):
Every chart MUST use the "layer" array format, even for a single mark type.
- CORRECT: { "layer": [{ "mark": "bar", "encoding": { ... } }] }
- WRONG:   { "mark": "bar", "encoding": { ... } }
This ensures consistent structure for future modifications (adding layers, annotations, etc.).
Widget paths must reflect the layered structure: "layer[0].mark.color", "layer[0].encoding.x.axis.labelAngle", etc.

CRITICAL EXCEPTION — FACETED CHARTS (column / row / facet), e.g. VIOLIN PLOTS:
Faceting CANNOT be a sibling of "layer" in Vega-Lite. A spec that puts "column"/"row"/"facet"
in a top-level "encoding" next to a "layer" array is INVALID and renders broken (the facet is
ignored and the marks collapse on top of each other).
- SINGLE-mark faceted chart (e.g. a plain violin): emit a UNIT spec with "mark" and "encoding" at
  the TOP LEVEL, keeping x/y/color AND column/row TOGETHER in that one "encoding".
    { "mark": {"type":"area","orient":"horizontal"},
      "transform": [{"density":"<FIELD>","groupby":["<GROUP>"]}],
      "encoding": { "x": {"field":"density","stack":"center", ...}, "y": {"field":"value", ...},
                    "color": {"field":"<GROUP>", ...}, "column": {"field":"<GROUP>", ...} } }
- MULTI-LAYER faceted chart (e.g. violin + raw points overlaid): use the "facet" OPERATOR that
  WRAPS a layered "spec" — this is the ONLY correct way to combine faceting with layers:
    { "facet": {"column": {"field":"<GROUP>", ...}},
      "spec": { "width":100, "layer": [ {<violin: density area>}, {<points>} ] } }
  Per-group transforms (density groupby) live INSIDE the relevant layer; data sits at the top level.
- WRONG (facet split off from a layer — produces the broken, all-groups-overlapping chart):
    { "layer": [{ "mark": ..., "encoding": { "x":..., "y":..., "color":... } }],
      "encoding": { "column": {...} } }
- Follow the structure of any injected violin/density facet EXAMPLE spec EXACTLY.

RECT BACKGROUND RULES (when the user asks for highlights or background regions):
1. Single category highlight on nominal axis: use filter pattern with rect layer.
2. Time range highlight: use inline data with field references (not datum) for x/x2.
3. Multiple background regions with different colors: single rect layer with inline data and color field with scale:null.
4. Conditional background based on data values: use conditions on rect layer's color encoding.
5. NEVER name inline data fields "x", "x2", "y", "y2" — use descriptive names like "start", "end".
6. The rect layer must NOT use "axis": null on positional channels — it removes the shared axis entirely. Either omit axis config (preferred) or use "axis": {"title": null}.
7. SCALE DOMAIN: If the rect layer shares an axis with the data layer, ensure both layers use the same scale domain. Copy the domain from the existing data layer to the rect layer's encoding.

${DATA_POSITION_RULE}

IMPORTANT:
- Set data.values to an EMPTY array [] — the frontend will inject the actual data.
- Use Vega-Lite v6 syntax only (not Vega).
- Include widget_options for key encoding choices (chart type, x/y field, color field, aggregation).
- Each widget must have a valid "path" pointing to the spec property it controls.
- Use "valueTemplate" whenever "path" points to a string expression that contains the adjustable value as part of a larger string (e.g. condition test, filter expression). Set "value" to ONLY the adjustable part (any type: number, string, etc.), and "valueTemplate" to the full expression with {value} as placeholder. Do NOT use it when the path points directly to a scalar value.
Return ONLY valid JSON.`

    // RAG: inject validated reference examples relevant to the request (after rules).
    const examples = retrieveExamples(user_command, { topK: 3 })
    const exampleBlock = formatExamplesForPrompt(examples)
    const fullSystemPrompt = exampleBlock ? `${systemPrompt}\n\n${exampleBlock}` : systemPrompt
    console.log('[create-chart] retrieved examples:', examples.map(e => e.id))

    // Validation loop: create-chart previously never retried — now 2 attempts.
    const MAX_ATTEMPTS = 2
    let result = null
    let lastError = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let userPrompt = user_command
      if (lastError) {
        userPrompt = `${user_command}

IMPORTANT - PREVIOUS ATTEMPT FAILED:
Your previous response produced an invalid Vega-Lite spec with this error:
"${lastError}"

Please fix this error and return a valid Vega-Lite specification.`
      }

      const text = await callClaude(client, fullSystemPrompt, userPrompt)
      let parsed
      try {
        parsed = parseJsonResponse(text)
      } catch {
        lastError = 'Response was not valid JSON.'
        if (attempt === MAX_ATTEMPTS) {
          return res.status(500).json({ error: 'Failed to parse LLM response' })
        }
        continue
      }

      // Enforce scale.zero=false for non-bar quantitative axes
      applyScaleZeroFalse(parsed.spec)

      // Validate structure (spec still has empty data.values — vl.compile is data-agnostic)
      const validation = validateVegaLiteSpec(parsed.spec)
      if (validation.valid) {
        result = parsed
        break
      }
      lastError = validation.error
      console.log(`[create-chart] attempt ${attempt} invalid: ${validation.error}`)
      if (attempt === MAX_ATTEMPTS) {
        result = parsed   // best-effort: return last attempt so the UI still renders
      }
    }

    // Inject actual data into spec
    if (result.spec && data) {
      result.spec.data = { values: data }
    }

    console.log('[create-chart] done. retried:', lastError != null, '| valid:', lastError == null,
                '| widgets:', (result.widget_options || []).length)

    res.json({
      spec: result.spec,
      widget_title: result.widget_title || '',
      widget_options: result.widget_options || [],
      change_type: 'encoding',
      retried: lastError != null
    })

  } catch (error) {
    console.error('Create chart error:', error)
    res.status(500).json({ error: error.message || 'Internal server error' })
  }
})

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

// POST /api/log — append events to participant's JSONL file
app.post('/api/log', (req, res) => {
  try {
    const { participantId, events } = req.body
    if (!participantId || !events?.length) return res.json({ ok: true, count: 0 })
    const logDir = path.join(process.cwd(), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const logFile = path.join(logDir, `${participantId}.jsonl`)
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.appendFileSync(logFile, lines)
    res.json({ ok: true, count: events.length })
  } catch (e) {
    console.error('Log write error:', e)
    res.status(500).json({ error: e.message })
  }
})

// Save final spec to {pid}_final.json (append per taskId)
app.post('/api/final-spec', (req, res) => {
  try {
    const { participantId, timestamp, condition, taskId, spec, charts } = req.body
    if (!participantId) return res.status(400).json({ error: 'Missing participantId' })
    const logDir = path.join(process.cwd(), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const filePath = path.join(logDir, `${participantId}_final.json`)
    let data = []
    try {
      if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch { data = [] }
    data.push({ timestamp, condition, taskId, spec, charts })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('Final spec write error:', e)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/log/:pid — read log file (for debugging)
app.get('/api/log/:pid', (req, res) => {
  try {
    const logFile = path.join(process.cwd(), 'logs', `${req.params.pid}.jsonl`)
    if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'Not found' })
    res.type('text/plain').send(fs.readFileSync(logFile, 'utf-8'))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
})
