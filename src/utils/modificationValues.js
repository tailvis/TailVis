// Older group modifications keep their original values on individual targets.
export function getOriginalModificationValues(modification) {
  const values = modification.originalValues
    ?? (modification.group ? modification.group.map(target => target.originalValue) : [modification.originalValue])
  return [...new Set(values.map(value => value ?? null))]
}
