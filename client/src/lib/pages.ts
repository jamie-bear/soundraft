export function appendUnique<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const ids = new Set(previous.map(item => item.id))
  return [...previous, ...next.filter(item => !ids.has(item.id))]
}
