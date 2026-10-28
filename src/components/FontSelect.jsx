const FONTS = [
  'sans-serif', 'serif', 'monospace',
  'Arial', 'Helvetica', 'Avenir', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Georgia', 'Times New Roman', 'Courier New',
  'Apple SD Gothic Neo', 'Malgun Gothic',
]

export default function FontSelect({ value = 'sans-serif', onChange, mixed = false, label = 'Font family' }) {
  const current = value || 'sans-serif'
  const options = FONTS.includes(current) ? FONTS : [current, ...FONTS]
  return (
    <select aria-label={label} value={mixed ? '' : current} onChange={e => onChange(e.target.value)}>
      {mixed && <option value="" disabled>Mixed</option>}
      {options.map(font => <option key={font} value={font}>{font}</option>)}
    </select>
  )
}
