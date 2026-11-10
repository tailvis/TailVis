import { useState } from 'react'

const heights = [27, 47, 65, 38]
const deicticHeights = [21, 32, 25, 36]

function MiniChart({ x = 0, y = 0, accent = '#6394c4' }) {
  return <g transform={`translate(${x} ${y})`}>
    <path d="M0 0V25H36" fill="none" stroke="#cbd7e4" />
    {[11, 19, 15].map((h, i) => <rect key={i} x={5 + i * 10} y={24 - h} width="6" height={h} rx="1" fill={accent} />)}
  </g>
}

export default function FeatureIllustrations() {
  const [selected, setSelected] = useState(2)
  const [referenced, setReferenced] = useState(2)
  const [widgetAnimation, setWidgetAnimation] = useState(0)
  const [branch, setBranch] = useState(0)
  return <div className="feature-illustrations">
    <div className="feature-illustration">
      <svg viewBox="0 0 166 98" role="group" aria-label="Select a bar in the illustration">
        <path d="M18 12V81H149" fill="none" stroke="#cbd7e4" />
        {heights.map((h, i) => <g key={i} role="button" tabIndex="0" aria-label={`Select bar ${i + 1}`} aria-pressed={selected === i}
          onClick={() => setSelected(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(i) } }} className="feature-bar">
          <rect x={30 + i * 29} y="10" width="25" height="74" fill="transparent" />
          <rect x={34 + i * 29} y={80 - h} width="17" height={h} rx="2" fill={selected === i ? '#346da8' : '#c2d6e9'} />
          {selected === i && <rect x={30 + i * 29} y={76 - h} width="25" height={h + 8} rx="3" fill="none" stroke="#346da8" strokeDasharray="3 3" />}
        </g>)}
        <path d={`M${43 + selected * 29} 54l1 23 6-6 7 2z`} fill="#26384a" stroke="white" strokeWidth="1.5" pointerEvents="none" />
      </svg>
      <div><h3>Directly select chart elements</h3><p>Click individual marks or select related groups to target your changes.</p></div>
    </div>
    <div className="feature-illustration">
      <svg viewBox="0 0 166 98" role="group" aria-label="Send a request to generate a widget">
        <rect x="10" y="6" width="146" height="24" rx="6" fill="white" stroke="#d7e1eb" />
        <text x="18" y="22" fill="#526579" fontSize="10">Make the bars wider</text>
        <g role="button" tabIndex="0" aria-label="Send request to generate a widget" className="feature-send"
          onClick={() => setWidgetAnimation(value => value + 1)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWidgetAnimation(value => value + 1) } }}>
          <rect x="131" y="9" width="22" height="18" rx="4" fill="#346da8" />
          <path d="M137 18h10m-4-4 4 4-4 4" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <g key={widgetAnimation} className={widgetAnimation > 0 ? "feature-generated-widget" : undefined} aria-label="Generated bar width widget">
        <path d="M83 33V43m-4-4 4 4 4-4" fill="none" stroke="#6394c4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="23" y="49" width="120" height="43" rx="6" fill="white" stroke="#91b4d5" />
        <text x="33" y="64" fill="#346da8" fontSize="10">Bar width</text>
        <rect x="117" y="55" width="17" height="12" rx="3" fill="#edf5fc" />
        <text x="125.5" y="64" textAnchor="middle" fill="#526579" fontSize="8">24</text>
        <path d="M34 79H132" stroke="#dae3ed" strokeWidth="4" strokeLinecap="round" />
        <path d="M34 79H95" stroke="#6394c4" strokeWidth="4" strokeLinecap="round" />
        <circle cx="95" cy="79" r="5" fill="#346da8" stroke="white" strokeWidth="1.5" />
        </g>
      </svg>
      <div><h3>Refine with requests and on-demand widgets</h3><p>Describe a change. TailVis generates widgets tailored to your request, so you can fine-tune the result directly.</p></div>
    </div>
    <div className="feature-illustration">
      <svg viewBox="0 0 166 98" role="group" aria-label="Select the bar referred to by this bar">
        <rect x="10" y="6" width="146" height="25" rx="6" fill="white" stroke="#d7e1eb" />
        <rect x="45" y="10" width="35" height="17" rx="3" fill="#dfecf8" />
        <text x="19" y="22" fill="#526579" fontSize="10">Make <tspan>this bar</tspan> darker</text>
        <path className="feature-reference-line" d={`M62.5 31V40H${43 + referenced * 25}V${81 - deicticHeights[referenced]}`} fill="none" stroke="#6394c4" strokeDasharray="3 3" pointerEvents="none" />
        <path d={`M${40 + referenced * 25} ${77 - deicticHeights[referenced]}l3 4 3-4`} fill="none" stroke="#6394c4" strokeWidth="1.2" pointerEvents="none" />
        <path d="M24 44V86H144" fill="none" stroke="#cbd7e4" />
        {deicticHeights.map((h, i) => <g key={i} role="button" tabIndex="0" aria-label={`Refer to bar ${i + 1}`} aria-pressed={referenced === i} className="feature-bar"
          onClick={() => setReferenced(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setReferenced(i) } }}>
          <rect x={32 + i * 25} y="44" width="22" height="45" fill="transparent" />
          <rect x={36 + i * 25} y={85 - h} width="14" height={h} rx="1.5" fill={referenced === i ? '#346da8' : '#c2d6e9'} />
          {referenced === i && <rect x={32 + i * 25} y={81 - h} width="22" height={h + 8} rx="3" fill="none" stroke="#346da8" strokeDasharray="3 3" />}
        </g>)}
        <path d={`M${45 + referenced * 25} 68l1 20 5-5 6 1z`} fill="#26384a" stroke="white" strokeWidth="1.5" pointerEvents="none" />
      </svg>
      <div><h3>Refer to elements with deictic interaction</h3><p>Select an element and refer to it as “this bar” or “these labels” in your request. TailVis uses your selection to understand what you mean.</p></div>
    </div>
    <div className="feature-illustration">
      <div className="feature-branches">
        <svg viewBox="0 0 166 98" aria-hidden="true">
          <path d="M62 49H83V25H103M83 49V74H103" fill="none" stroke="#cbd7e4" strokeWidth="1.5" />
          <rect x="12" y="27" width="51" height="44" rx="5" fill="white" stroke="#d7e1eb" />
          <MiniChart x={20} y={36} />
          {[4, 53].map((y, i) => <g key={i}><rect x="103" y={y} width="51" height="44" rx="5" fill={branch === i ? '#edf5fc' : 'white'} stroke={branch === i ? '#346da8' : '#d7e1eb'} /><MiniChart x={111} y={y + 9} accent={i ? '#8b9db5' : '#6394c4'} /></g>)}
        </svg>
        <button aria-label="Explore first refinement branch" aria-pressed={branch === 0} onClick={() => setBranch(0)} />
        <button aria-label="Explore second refinement branch" aria-pressed={branch === 1} onClick={() => setBranch(1)} />
      </div>
      <div><h3>Explore different directions</h3><p>Branch a refinement and keep its history.<br />Your charts stay linked to the data.</p></div>
    </div>
  </div>
}
