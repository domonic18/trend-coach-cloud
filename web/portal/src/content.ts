export type ContentName = 'system' | 'features' | 'guide' | 'faq' | 'privacy' | 'terms'

const files = import.meta.glob('../content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export function content(name: ContentName): string {
  const value = files[`../content/${name}.md`]
  if (value === undefined) throw new Error(`missing portal content: ${name}`)
  return value
}
