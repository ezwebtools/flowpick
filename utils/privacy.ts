export function mayCaptureRequestHeaders(type: string, potentialResource: boolean, excluded: boolean): boolean {
  // Unknown API requests may still be classified by response Content-Type, but
  // their credentials are never cached speculatively.
  return !excluded && (type === 'media' || potentialResource)
}
