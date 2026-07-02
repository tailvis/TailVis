import './AncestorWidgetPanel.css'

// Number range rules (shared with ConnectionWidget)
const NUMBER_RULES = [
  { test: /angle|rotate|rotation|labelangle|각도|회전/i, min: -360, max: 360, step: 1 },
  { test: /opacity|fillopacity|strokeopacity|투명|불투명/i, min: 0, max: 1, step: 0.05 },
  { test: /fontsize|titlefontsize|labelfontsize|글꼴.*크기|폰트.*크기|글자.*크기/i, min: 6, max: 48, step: 1 },
  { test: /strokewidth|domainwidth|gridwidth|선.*두께|테두리.*두께/i, min: 0, max: 10, step: 0.5 },
  { test: /cornerradius|모서리.*반경|둥글기/i, min: 0, max: 20, step: 1 },
  { test: /\bsize\b|크기/i, min: 0, max: 500, step: 10 },
  { test: /paddinginner|paddingouter|bandpadding/i, min: 0, max: 1, step: 0.05 },
  { test: /offset|오프셋|위치/i, min: -200, max: 200, step: 1 },
  { test: /padding|spacing|간격|패딩|여백/i, min: 0, max: 50, step: 1 },
  { test: /ticksize|tickwidth|눈금.*크기/i, min: 0, max: 20, step: 1 },
  { test: /\bwidth\b|\bheight\b|너비|높이/i, min: 50, max: 1200, step: 10 },
]

function WidgetControl({ option, onChange }) {
  switch (option.type) {
    case 'color':
      return (
        <div className="ancestor-option color-control">
          <label>{option.label}</label>
          <input type="color" value={option.value || '#000000'} onChange={(e) => onChange(e.target.value)} />
        </div>
      )
    case 'number': {
      const value = option.value ?? 0
      let min = option.min, max = option.max, step = option.step
      if (min === undefined || max === undefined || step === undefined) {
        const hint = [option.id, option.label, option.path].join(' ')
        const rule = NUMBER_RULES.find(r => r.test.test(hint))
        if (rule) { min = min ?? rule.min; max = max ?? rule.max; step = step ?? rule.step }
        else if (/투명|opacity/i.test(hint)) { min = min ?? 0; max = max ?? 1; step = step ?? 0.05 }
        else { min = min ?? 0; max = max ?? Math.max(10, Math.ceil(Math.abs(value) * 3) || 10); step = step ?? (value >= 10 ? 1 : 0.5) }
      }
      return (
        <div className="ancestor-option number-control">
          <label>{option.label}</label>
          <input type="number" className="number-input" min={min} max={max} step={step} value={option.value} onChange={(e) => onChange(parseFloat(e.target.value))} />
          <input type="range" min={min} max={max} step={step} value={option.value} onChange={(e) => onChange(parseFloat(e.target.value))} />
        </div>
      )
    }
    case 'select': {
      const hasOpts = Array.isArray(option.options) && option.options.length > 0
      return (
        <div className="ancestor-option select-control">
          <label>{option.label}</label>
          {hasOpts
            ? <select value={option.value} onChange={(e) => onChange(e.target.value)}>{option.options.map(o => { const isObj = typeof o === 'object' && o !== null; return <option key={isObj ? o.value : o} value={isObj ? o.value : o}>{isObj ? o.label : o}</option> })}</select>
            : <input type="text" value={option.value ?? ''} onChange={(e) => onChange(e.target.value)} />}
        </div>
      )
    }
    case 'boolean':
      return (
        <div className="ancestor-option boolean-control">
          <label>{option.label}</label>
          <input type="checkbox" checked={option.value} onChange={(e) => onChange(e.target.checked)} />
        </div>
      )
    case 'text':
      return (
        <div className="ancestor-option text-control">
          <label>{option.label}</label>
          <input type="text" value={option.value ?? ''} onChange={(e) => onChange(e.target.value)} />
        </div>
      )
    default:
      return null
  }
}

function deriveWidgetGroupLabel(chart) {
  if (chart.widgetTitle) return chart.widgetTitle
  // Summarize from widget labels (e.g., "Bar Color, Opacity")
  if (chart.widgetOptions?.length > 0) {
    const labels = chart.widgetOptions.slice(0, 3).map(w => w.label).join(', ')
    return labels + (chart.widgetOptions.length > 3 ? ` +${chart.widgetOptions.length - 3}` : '')
  }
  // Fallback: changeType-based
  const typeLabels = {
    visual_refinement: 'Style',
    data_transformation: 'Data',
    encoding: 'Encoding',
    annotation: 'Annotation',
  }
  if (chart.changeType && typeLabels[chart.changeType]) return typeLabels[chart.changeType]
  return chart.command?.slice(0, 25) || 'Widgets'
}

function AncestorWidgetPanel({ chain, onWidgetOptionChange, selectedChartId }) {
  const chartsWithWidgets = chain.filter(c => c.widgetOptions && c.widgetOptions.length > 0)

  const selectedIndex = chain.findIndex(c => c.id === selectedChartId)
  const reversed = [...chartsWithWidgets].reverse()

  return (
    <div className="ancestor-widget-panel">
      {reversed.map((chart, idx) => {
        const isSelected = chart.id === selectedChartId
        const chainIndex = chain.indexOf(chart)
        const distFromSelected = selectedIndex - chainIndex
        const label = deriveWidgetGroupLabel(chart)
        const tag = isSelected ? 'Current' : `+${distFromSelected}`

        return (
          <div key={chart.id} className={`ancestor-group ${isSelected ? 'ancestor-group--current' : ''}`}>
            <div className="ancestor-group-header">
              <span className="ancestor-tag">{tag}</span>
              <span className="ancestor-label" title={chart.command || ''}>{label}</span>
            </div>
            <div className="ancestor-widgets">
              {chart.widgetOptions.map(opt => (
                <WidgetControl
                  key={opt.id}
                  option={opt}
                  onChange={(newValue) => onWidgetOptionChange(chart.id, opt.id, newValue)}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default AncestorWidgetPanel
