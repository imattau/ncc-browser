export interface AddressParts {
  scheme: string
  id: string
  rest: string
}

export interface AddressEntry {
  address: string
  title?: string
}

export function addressParts(url: string): AddressParts
export function avatar(text: string, className?: string, address?: string): HTMLSpanElement
export function displayAddress(url: string): string
export function icon(name: string, className?: string): SVGSVGElement
export function iconKey(address: string): string
export function labelFor(entry: AddressEntry): string
export function saveIcon(address: string, dataUrl: string): void
export function setIcon(svg: SVGSVGElement, name: string): void
export function shortId(id: string): string
