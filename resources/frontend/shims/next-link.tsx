/**
 * Sostituto di `next/link` per la build Vite: stessa interfaccia usata dalle pagine originali
 * (href, className, onClick, prefetch), instradamento lato client con React Router.
 */
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string
  prefetch?: boolean
  replace?: boolean
  children?: ReactNode
}

const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch: _prefetch, replace, ...rest }, ref) {
  // collegamenti esterni, download e API: ancora normale
  if (/^(https?:|mailto:|tel:)/.test(href) || href.startsWith('/api/')) return <a ref={ref} href={href} {...rest} />
  return <RouterLink ref={ref} to={href} replace={replace} {...rest} />
})

export default Link
