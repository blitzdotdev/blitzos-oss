// Shared visual language for agent identity chips/rails in the island.
export function agentGradient(id: string): string {
  // Blitz (the primary agent '0') is the OS itself, not just another peer — so it wears the BlitzOS theme:
  // the island blue fading into obsidian black, instead of a random golden-angle hue.
  if (id === '0') {
    return 'radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.48) 0%, transparent 40%), linear-gradient(145deg, #a78bfa 0%, #6366f1 30%, #2563eb 62%, #0ea5e9 100%)'
  }
  // Spread hues by the golden angle so sequential peer ids ('1','2'...) get maximally different colors.
  let n = 0
  for (let i = 0; i < id.length; i++) n = (n * 33 + id.charCodeAt(i)) >>> 0
  const base = /^\d+$/.test(id) ? parseInt(id, 10) : n
  const h = (base * 137.508) % 360
  // Vary saturation, lightness, and angle per agent so avatars feel distinct, not just hue-shifted clones.
  const s1 = 74 + (base * 7) % 22        // 74–95%
  const l1 = 48 + (base * 5) % 22        // 48–69%
  const s2 = 68 + (base * 11) % 22       // 68–89%
  const l2 = 44 + (base * 3) % 22        // 44–65%
  const deg = 140 + (base * 17) % 44     // 140–183°
  return `radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.42) 0%, transparent 40%), linear-gradient(${deg}deg, hsl(${h} ${s1}% ${l1}%), hsl(${(h + 50) % 360} ${s2}% ${l2}%) 45%, hsl(${(h + 110) % 360} 82% 58%))`
}

// BlitzOS Support wears a full-spectrum "all colors at once" avatar — the SAME gradient-disc treatment as agent
// avatars (a radial top-left sheen over the hue wheel + the chip's inset ring), but a conic rainbow instead of a
// per-id two-tone, so Support reads as its own identity inside the same visual language.
export const SUPPORT_GRADIENT =
  'radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.5) 0%, transparent 42%), conic-gradient(from 210deg at 50% 50%, #ff5f6d, #ffb24d, #ffe74d, #5dff8f, #4de1ff, #5d8bff, #c45dff, #ff5db4, #ff5f6d)'
