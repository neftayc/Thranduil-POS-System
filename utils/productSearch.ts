export const normalizeSearchText = (value: any) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()

const splitWords = (value: string) =>
  value.split(/[^a-z0-9]+/).filter((word) => word.length > 0)

const maxDistanceForToken = (length: number) => {
  if (length <= 4) return 1
  if (length <= 8) return 2
  return 3
}

const isDistanceWithin = (source: string, target: string, maxDistance: number) => {
  if (source === target) return true
  if (Math.abs(source.length - target.length) > maxDistance) return false

  let prevRow: number[] = Array.from({ length: target.length + 1 }, (_, i) => i)

  for (let i = 1; i <= source.length; i += 1) {
    const currentRow: number[] = [i]
    let minInRow = currentRow[0]

    for (let j = 1; j <= target.length; j += 1) {
      const substitutionCost = source[i - 1] === target[j - 1] ? 0 : 1
      const insertion = currentRow[j - 1] + 1
      const deletion = prevRow[j] + 1
      const substitution = prevRow[j - 1] + substitutionCost
      const value = Math.min(insertion, deletion, substitution)
      currentRow[j] = value
      if (value < minInRow) minInRow = value
    }

    if (minInRow > maxDistance) return false
    prevRow = currentRow
  }

  return prevRow[target.length] <= maxDistance
}

const fuzzyTokenMatch = (token: string, words: string[]) => {
  const maxDistance = maxDistanceForToken(token.length)
  const tokenFirstChar = token[0]

  return words.some((word) => {
    if (word.length < 3) return false
    if (word[0] !== tokenFirstChar) return false
    if (word.includes(token)) return true
    return isDistanceWithin(token, word, maxDistance)
  })
}

export const matchesTokensAndFuzzy = (term: any, haystack: any) => {
  const normalizedTerm = normalizeSearchText(term)
  if (!normalizedTerm) return true

  const normalizedHaystack = normalizeSearchText(haystack)
  if (!normalizedHaystack) return false
  if (normalizedHaystack.includes(normalizedTerm)) return true

  const tokens = normalizedTerm.split(/\s+/).filter((token) => token.length > 0)
  if (!tokens.length) return true

  const words = splitWords(normalizedHaystack)
  if (!words.length) return false

  return tokens.every((token) => {
    if (normalizedHaystack.includes(token)) return true
    if (token.length < 3) return false
    return fuzzyTokenMatch(token, words)
  })
}
