import { useState } from 'react'
import './EncodingBar.css'

// Import icon images directly (Vite handles this)
import iconBar from '../img/Bar chart.png'
import iconLine from '../img/Line chart.png'
import iconScatter from '../img/Scatter plot.png'
import iconHistogram from '../img/Histogram.png'
import iconArea from '../img/Area chart.png'
import iconBoxplot from '../img/Boxplot.png'
import iconGroupedBar from '../img/Grouped bar.png'
import iconHeatmap from '../img/Heatmap.png'
import iconPie from '../img/Pie chart.png'
import iconDonut from '../img/Donut.png'
import iconStackedBar from '../img/Stackedbar.png'
import iconTreemap from '../img/Treemap.png'
import iconWaterfall from '../img/Waterfall.png'

// Chart type definitions
const CHART_TYPES = [
  { id: 'bar', label: 'Bar', icon: iconBar, mark: 'bar' },
  { id: 'line', label: 'Line', icon: iconLine, mark: 'line' },
  { id: 'point', label: 'Scatter', icon: iconScatter, mark: 'point' },
  { id: 'histogram', label: 'Histogram', icon: iconHistogram, mark: 'bar' },
  { id: 'area', label: 'Area', icon: iconArea, mark: 'area' },
  { id: 'boxplot', label: 'Boxplot', icon: iconBoxplot, mark: 'boxplot' },
  { id: 'grouped-bar', label: 'Grouped', icon: iconGroupedBar, mark: 'bar' },
  { id: 'heatmap', label: 'Heatmap', icon: iconHeatmap, mark: 'rect' },
  { id: 'pie', label: 'Pie', icon: iconPie, mark: 'arc' },
  { id: 'stacked-bar', label: 'Stacked', icon: iconStackedBar, mark: 'bar' },
  // { id: 'waterfall', label: 'Waterfall', icon: iconWaterfall, mark: 'bar' }, 
  { id: 'treemap', label: 'Treemap', icon: iconTreemap, mark: 'rect' },
]

function EncodingBar({ selectedChartType, onChartTypeSelect, onEncodingNLSubmit, isProcessing }) {
  const [nlText, setNlText] = useState('')

  const handleNLSubmit = (e) => {
    e.preventDefault()
    const command = nlText.trim()
    if (!command || isProcessing) return
    onEncodingNLSubmit?.(command)
    setNlText('')
  }

  return (
    <div className="encoding-bar">
      <div className="encoding-bar-center">
        {CHART_TYPES.map(ct => (
          <button
            key={ct.id}
            className={`chart-type-btn ${selectedChartType === ct.id ? 'active' : ''}`}
            onClick={() => onChartTypeSelect(ct.id)}
            title={ct.label}
          >
            <img
              src={ct.icon}
              alt={ct.label}
              className="chart-type-icon"
              onError={(e) => { e.target.style.display = 'none' }}
            />
            <span className="chart-type-label">{ct.label}</span>
          </button>
        ))}
      </div>

      {onEncodingNLSubmit && (
        <form className="encoding-bar-nl" onSubmit={handleNLSubmit}>
          <input
            type="text"
            className="encoding-nl-input"
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            placeholder={isProcessing ? 'Generating chart…' : 'Describe a chart in plain English…'}
            disabled={isProcessing}
          />
          <button
            type="submit"
            className="encoding-nl-submit"
            disabled={isProcessing || !nlText.trim()}
            title="Create chart from description"
          >
            {isProcessing ? <span className="encoding-nl-spinner" aria-label="Processing" /> : '↵'}
          </button>
        </form>
      )}
    </div>
  )
}

export { CHART_TYPES }
export default EncodingBar
