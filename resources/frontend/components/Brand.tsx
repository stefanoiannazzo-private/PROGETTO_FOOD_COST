/**
 * NUOVO — Marchio Ricetta Quadra.
 * Logo completo (pittogramma + scritta, sfondo trasparente) con variante per il tema scuro,
 * e pittogramma da solo per gli spazi piccoli.
 */
export function BrandLogo({ height = 34, className = '' }: { height?: number; className?: string }) {
  return (
    <span className={`brand-logo ${className}`} style={{ height }}>
      <img className="logo-light" src="/app/brand/logo.png" alt="Ricetta Quadra" height={height} />
      <img className="logo-dark" src="/app/brand/logo-dark.png" alt="Ricetta Quadra" height={height} aria-hidden="true" />
    </span>
  )
}

export function BrandMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <img className={`brand-mark-img ${className}`} src="/app/brand/mark.png" alt="Ricetta Quadra" width={size} height={size} />
}
