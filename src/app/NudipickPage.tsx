// Temporary nudibranch picker page — visit /?nudipick to use
import { useState } from 'react'
import { NUDIBRANCHS } from './nudibranchs'

export default function NudipickPage() {
  const [checked, setChecked] = useState<Set<number>>(() => new Set())

  const toggle = (i: number) =>
    setChecked(s => { const next = new Set(s); next.has(i) ? next.delete(i) : next.add(i); return next })

  const result = Array.from(checked).sort((a, b) => a - b).join(', ')

  return (
    <div style={{ background: '#111', minHeight: '100vh', color: '#ccc', padding: '24px', fontFamily: 'monospace' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.15em', color: '#444', marginBottom: '16px' }}>
        NUDIBRANCH PICKER · check the ones you want · paste the output back
      </div>

      <div style={{
        position: 'sticky', top: 0, background: '#111', padding: '10px 0 14px',
        borderBottom: '1px solid #222', marginBottom: '20px', zIndex: 10,
      }}>
        <div style={{ fontSize: '9px', color: '#555', marginBottom: '6px' }}>{checked.size} selected</div>
        <textarea
          readOnly
          value={result || '(none selected)'}
          onClick={e => (e.target as HTMLTextAreaElement).select()}
          style={{
            width: '100%', maxWidth: '800px', height: '48px',
            background: '#1a1a1a', border: '1px solid #333', borderRadius: '4px',
            color: '#9c9', fontSize: '11px', fontFamily: 'monospace', padding: '6px 8px',
            resize: 'none',
          }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
        {NUDIBRANCHS.map((p, i) => (
          <label
            key={i}
            style={{
              cursor: 'pointer',
              border: `1px solid ${checked.has(i) ? '#7a9cc0' : '#222'}`,
              borderRadius: '4px',
              overflow: 'hidden',
              background: checked.has(i) ? '#1a2530' : '#0d0d0d',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} style={{ display: 'none' }} />
            <img src={p.url} alt={p.name} loading="lazy"
              style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', display: 'block' }} />
            <div style={{ padding: '6px 8px' }}>
              <div style={{ fontSize: '9px', color: checked.has(i) ? '#9cc' : '#888' }}>{i} · {p.name}</div>
              <div style={{ fontSize: '8px', color: '#444', fontStyle: 'italic', marginTop: '2px' }}>{p.sci}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}
