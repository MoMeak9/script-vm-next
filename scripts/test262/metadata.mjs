// Test262's descriptive YAML is left untouched. Interpret only execution metadata,
// accepting its scalar/list/map forms and rejecting ambiguous execution fields.
const listKeys = new Set(['flags', 'includes', 'features'])

function scalar(text) {
  const value = text.trim().replace(/\s+#.*$/, '')
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return JSON.parse(value)
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'")
  if (!/^[\w./$-]+$/.test(value)) throw new Error(`Unsupported metadata scalar: ${value}`)
  return value
}

export function readMetadata(source) {
  const match = source.match(/\/\*---\r?\n([\s\S]*?)\r?\n---\*\//)
  if (!match) throw new Error('Missing Test262 frontmatter')
  const fields = new Map()
  let key
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([\w-]+):\s*(.*)$/)
    if (field) {
      key = field[1]
      if (fields.has(key)) throw new Error(`Duplicate metadata field: ${key}`)
      fields.set(key, [field[2]])
    } else if (key) fields.get(key).push(line)
  }
  const metadata = { flags: [], includes: [], features: [] }
  for (const name of listKeys) {
    if (!fields.has(name)) continue
    const lines = fields.get(name).filter(line => line.trim() && !line.trim().startsWith('#'))
    if (lines.length === 1 && /^\[.*\](?:\s+#.*)?$/.test(lines[0].trim())) {
      const contents = lines[0].trim().replace(/\s+#.*$/, '').slice(1, -1).trim()
      metadata[name] = contents ? contents.split(',').map(scalar) : []
    } else {
      metadata[name] = lines.map(line => {
        const item = line.match(/^\s+-\s+(.+)$/)
        if (!item) throw new Error(`Unsupported ${name} metadata: ${line}`)
        return scalar(item[1])
      })
    }
  }
  if (fields.has('negative')) {
    metadata.negative = {}
    for (const line of fields.get('negative').filter(line => line.trim() && !line.trim().startsWith('#'))) {
      const item = line.match(/^\s+(phase|type):\s+(.+)$/)
      if (!item || metadata.negative[item[1]]) throw new Error(`Unsupported negative metadata: ${line}`)
      metadata.negative[item[1]] = scalar(item[2])
    }
    if (!['parse', 'early', 'runtime', 'resolution'].includes(metadata.negative.phase) || !metadata.negative.type) {
      throw new Error('Negative metadata requires a supported phase and error type')
    }
  }
  const flags = new Set(metadata.flags)
  if (flags.has('onlyStrict') && flags.has('noStrict')) throw new Error('Conflicting strict flags')
  if (flags.has('raw') && (flags.has('onlyStrict') || metadata.includes.length)) {
    throw new Error('Raw tests cannot request strict transformation or harness includes')
  }
  return metadata
}

export function variants(metadata) {
  const known = new Set(['onlyStrict', 'noStrict', 'raw', 'generated', 'module', 'async', 'CanBlockIsTrue', 'CanBlockIsFalse', 'non-deterministic'])
  const unsupported = metadata.flags.filter(flag => !known.has(flag) || ['module', 'async', 'CanBlockIsTrue', 'CanBlockIsFalse', 'non-deterministic'].includes(flag))
  if (metadata.negative?.phase === 'resolution') unsupported.push('resolution-phase module tests')
  if (unsupported.length) return [{ mode: 'unsupported', skip: `Unsupported execution requirements: ${unsupported.join(', ')}` }]
  if (metadata.flags.includes('raw')) return [{ mode: 'raw' }]
  if (metadata.flags.includes('onlyStrict')) return [{ mode: 'strict' }]
  if (metadata.flags.includes('noStrict')) return [{ mode: 'sloppy' }]
  return [{ mode: 'sloppy' }, { mode: 'strict' }]
}
