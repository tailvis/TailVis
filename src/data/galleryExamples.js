// Curated examples are loaded only on gallery routes.
import examples from './galleryExamples.json'

// The waterfall's labels are split into increase, decrease, and in-bar text
// layers. Its saved label controls must target all three, not just decreases.
const labelWidgetProperties = {
  delta_label_color: 'mark.color',
  delta_label_size: 'mark.fontSize',
  delta_label_format: 'encoding.text.format',
}
export const GALLERY_EXAMPLES = examples.map(example => {
  if (example.id !== 'ex_1782928410103') return example
  return { ...example, charts: example.charts.map(chart => ({
    ...chart,
    widgetOptions: chart.widgetOptions?.map(option => {
      const property = labelWidgetProperties[option.id]
      if (!property) return option
      const paths = (chart.spec.layer || []).flatMap((layer, index) =>
        (typeof layer.mark === 'string' ? layer.mark : layer.mark?.type) === 'text'
          ? [`layer[${index}].${property}`] : [])
      return paths.length ? { ...option, paths, label: option.label.replace(/^Change Label/, 'Label') } : option
    }),
  })) }
})

export default GALLERY_EXAMPLES
