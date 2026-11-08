import test from 'node:test'
import assert from 'node:assert/strict'
import { getLayerIndex } from '../src/utils/elementUtils.js'
import { compile } from 'vega-lite'
import { View, parse } from 'vega'
import { buildSelectionTargets, selectionKey } from '../src/utils/selectionTargets.js'
import { applyModificationsToSpec } from '../src/utils/scopeUtils.js'

const rows = [{category: 'A', value: 1}, {category: 'B', value: 2}]
const unit = {data: {values: rows}, mark: 'bar', encoding: {
  x: {field: 'category', type: 'nominal'}, y: {field: 'value', type: 'quantitative'},
  color: {field: 'category', type: 'nominal'},
}}
const element = (layerIndex, datum, scopeType = 'all-marks', scopeData = {}) => ({
  selector: `g.layer_${layerIndex}_marks path[aria-label="${datum.category}"]`,
  layerIndex, datum, markGroup: 'mark-rect', semanticRole: 'data-mark',
  _scopeType: scopeType, _scopeData: scopeData,
})
const edit = (base, elements, property = 'fill', value = '#ff0000') => applyModificationsToSpec(base, [{
  property, value, group: buildSelectionTargets(elements, property),
}])
async function marks(spec) {
  const view = new View(parse(compile(JSON.parse(JSON.stringify(spec))).spec), {renderer:'none'})
  await view.runAsync()
  const items = []
  function walk(item) {
    if (item.mark?.role === 'mark' && item.datum?.category) items.push(item)
    item.items?.forEach(walk)
  }
  walk(view.scenegraph().root)
  const result = items.map(i => ({category:i.datum.category, fill:i.fill, opacity:i.opacity, stroke:i.stroke}))
  view.finalize()
  return result
}

test('All Marks spans selected layers and overrides field-bound colors', async () => {
  const base = {layer:[unit, {...unit, mark:'circle'}]}
  const els = [element(0,rows[0]),element(0,rows[1]),
    {...element(1,rows[0]),markGroup:'mark-symbol'}, {...element(1,rows[1]),markGroup:'mark-symbol'}]
  const result = edit(base, els)
  assert.equal(buildSelectionTargets(els,'fill').length,2)
  assert.equal((await marks(result.spec)).filter(m=>m.fill==='#ff0000').length,4)
  assert.equal(base.layer[0].encoding.color.field,'category')
})
test('same type scope edits every selected layer and leaves other marks alone', async () => {
  const base = {layer:[unit,unit,{...unit,mark:'circle'}]}
  const els = [element(0,rows[0],'same-mark-type'),element(1,rows[0],'same-mark-type')]
  const result = edit(base,els)
  assert.equal((await marks(result.spec)).filter(m=>m.fill==='#ff0000').length,4)
  assert.equal(result.spec.layer[2].encoding.color.field,'category')
})
test('field scopes target the same category in every selected layer', async () => {
  const els = [0,1].map(i=>element(i,rows[0],'field-value',{field:'category',value:'A'}))
  const result = edit({layer:[unit,unit]},els,'opacity',0.25)
  const rendered = await marks(result.spec)
  assert.equal(rendered.filter(m=>m.category==='A' && m.opacity===0.25).length,2)
  assert.ok(rendered.filter(m=>m.category==='B').every(m=>m.opacity!==0.25))
})
test('field names and values containing quotes form valid Vega expressions', async () => {
  const field = "owner's group"
  const data = [{[field]:"O'Brien",value:1},{[field]:'Other',value:2}]
  const base = {...unit,data:{values:data.map((r,i)=>({...r,category:rows[i].category}))}}
  const result = edit(base,[element(null,data[0],'field-value',{field,value:"O'Brien"})])
  const view = new View(parse(compile(result.spec).spec),{renderer:'none'})
  await view.runAsync()
  const svg = await view.toSVG()
  assert.equal((svg.match(/fill="#ff0000"/g)||[]).length,1)
  view.finalize()
})
test('explicit groups of the same size have distinct identities; order does not matter', () => {
  const a = [element(0,rows[0],'explicit'),element(1,rows[0],'explicit')]
  const b = [element(0,rows[1],'explicit'),element(1,rows[1],'explicit')]
  assert.notEqual(selectionKey(a),selectionKey(b))
  assert.equal(selectionKey(a),selectionKey([...a].reverse()))
})
test('unknown and condition scopes never expand to all marks', async () => {
  for (const type of ['condition-match','condition-default','future-scope']) {
    const els=[element(null,rows[0],type)]
    assert.equal(buildSelectionTargets(els,'opacity')[0].scope.type,'this-only')
    const rendered = await marks(edit(unit,els,'opacity',0.2).spec)
    assert.equal(rendered.find(m=>m.category==='A').opacity,0.2)
    assert.notEqual(rendered.find(m=>m.category==='B').opacity,0.2)
  }
})
test('mixed legend + data selections retain both roles', () => {
  const els=[{...element(null,rows[0],'field-value',{field:'category',value:'A'}),semanticRole:'legend',legendValue:0},element(null,rows[0],'field-value',{field:'category',value:'A'})]
  const targets=buildSelectionTargets(els,'fill')
  assert.equal(targets.length,2)
  assert.equal(targets[0].scope.type,'selected-element')
  assert.equal(targets[0].legendValue,0)
  assert.equal(targets[1].scope.type,'by-field')
})
test('axis labels and composite parts stay confined to selected SVG elements', () => {
  for (const extra of [{semanticRole:'axis',axisSubType:'label'}, {compositeMarkType:'boxplot',compositeSubPart:'median'}]) {
    const els=[{...element(0,rows[0],'field-value',{field:'category',value:'A'}),...extra}]
    const result=edit(unit,els)
    assert.deepEqual(result.svgOverrides[els[0].selector],{fill:'#ff0000'})
    assert.equal(result.spec.encoding.color.field,'category')
  }
})
test('stroke on colored bars does not replace their fill encoding', async () => {
  const result=edit(unit,[element(null,rows[0])],'stroke','#ff0000')
  assert.equal(result.spec.encoding.color.field,'category')
  assert.ok((await marks(result.spec)).every(m=>m.stroke==='#ff0000' && m.fill!=='#ff0000'))
})
test('group line dash writes a Vega-Lite array', () => {
  const result=edit({...unit,mark:'line'},[{...element(null,rows[0]),markGroup:'mark-line'}],'strokeDasharray','4,4')
  assert.deepEqual(result.spec.mark.strokeDash,[4,4])
})

test('field edits preserve explicit color domains and unrelated layer styling', async () => {
  const first = {...unit, encoding:{...unit.encoding,color:{field:'category',type:'nominal',scale:{domain:['B','A'],range:['#0000ff','#00ff00']}}}}
  const other = {...unit,mark:{type:'bar',opacity:0.8,fill:'#abcdef'}}
  const result=edit({layer:[first,other]},[element(0,rows[0],'field-value',{field:'category',value:'A'})])
  assert.deepEqual(result.spec.layer[0].encoding.color.scale.domain,['B','A'])
  assert.deepEqual(result.spec.layer[0].encoding.color.scale.range,['#0000ff','#ff0000'])
  assert.equal(result.spec.layer[1].mark.fill,'#abcdef')
})
test('group edits override inherited encoding without changing unselected layers', async () => {
  const base = {data:unit.data,encoding:unit.encoding,layer:[{mark:'bar'},{mark:'circle'}]}
  const result=edit(base,[element(0,rows[0])])
  const rendered=await marks(result.spec)
  assert.equal(rendered.filter(m=>m.fill==='#ff0000').length,2)
  assert.equal(result.spec.encoding.color.field,'category')
})

test('field edits on inherited color preserve the other category', async () => {
  const base = {data:unit.data,encoding:unit.encoding,layer:[{mark:'bar'},{mark:'circle'}]}
  const before = await marks(base)
  const els=[element(0,rows[0],'field-value',{field:'category',value:'A'}),{...element(1,rows[0],'field-value',{field:'category',value:'A'}),markGroup:'mark-symbol'}]
  const after = await marks(edit(base,els).spec)
  assert.equal(after.filter(m=>m.category==='A' && m.fill==='#ff0000').length,2)
  assert.deepEqual(after.filter(m=>m.category==='B'),before.filter(m=>m.category==='B'))
})

test('a later expanded field edit overrides earlier individual conditions in its group', async () => {
  const first = {property:'fill',value:'#0000ff',scope:{type:'this-only'},semanticRole:'data-mark',markGroup:'mark-rect',datum:rows[0]}
  const later = {property:'fill',value:'#ff0000',group:buildSelectionTargets([element(null,rows[0],'field-value',{field:'category',value:'A'})],'fill')}
  const rendered=await marks(applyModificationsToSpec(unit,[first,later]).spec)
  assert.equal(rendered.find(m=>m.category==='A').fill,'#ff0000')
  assert.equal(rendered.find(m=>m.category==='B').fill,'#f58518')
})
test('faceted selection edits the inner layers and preserves the outer data', async () => {
  const base={data:unit.data,facet:{column:{field:'category',type:'nominal'}},spec:{mark:'bar',encoding:unit.encoding}}
  const result=edit(base,[element(null,rows[0])])
  assert.equal(result.spec.spec.mark.fill,'#ff0000')
  assert.equal(result.spec.spec.encoding.color.value,'#ff0000')
  assert.equal(result.spec.spec.data,undefined)
  assert.deepEqual(result.spec.data,base.data)
})

test('layer detection handles real Vega class lists, facets and nested layers', () => {
  const root = {}
  for (const [className,expected] of [
    ['mark-rect role-mark layer_0_marks',0],
    ['mark-symbol role-mark layer_2_marks',2],
    ['mark-symbol role-mark child_layer_1_marks',1],
    ['mark-line role-mark layer_3_layer_0_marks',3],
    ['mark-symbol role-mark marks',null],
  ]) {
    const group={className:{baseVal:className},parentElement:root}
    const el={className:{baseVal:''},parentElement:group}
    assert.equal(getLayerIndex(el,root),expected,className)
  }
})

// Typed category scopes must retain exact SVG targets, even on ordinary marks.
test('kind/category intersections never collapse into whole-category edits', () => {
  for (const extra of [{}, {compositeMarkType: 'boxplot', compositeSubPart: 'box'}]) {
    const selected = [0, 1].map(i => ({...element(i, rows[0], 'field-value-kind', {field: 'category', value: 'A', kind: {type: 'rect'}}), ...extra}))
    const targets = buildSelectionTargets(selected, 'fill')
    assert.equal(targets.length, 2)
    assert.ok(targets.every(target => target.scope.type === 'selected-element'))
    const result = edit({layer: [unit, unit]}, selected)
    assert.deepEqual(result.spec, {layer: [unit, unit]})
    assert.equal(Object.keys(result.svgOverrides).length, 2)
  }
})
