// v1.25: the only permission Cipher Bot ever grants: the microphone (audio only, never camera or screen), for the main
// window's own page (file://), for hold-to-talk. Every other permission request and check is denied.
export interface PermissionAsk { permission: string; mediaTypes?: string[]; isMainWindow: boolean; url: string }

export function allowPermission(a: PermissionAsk): boolean {
  if (a.permission !== 'media' || !a.isMainWindow || !a.url.startsWith('file://')) return false;
  const types = a.mediaTypes ?? [];
  return types.length === 1 && types[0] === 'audio';
}

/** Synchronous permission checks (navigator.permissions etc.): same rule; the media type must be audio. */
export function allowPermissionCheck(a: { permission: string; mediaType?: string; isMainWindow: boolean; url: string }): boolean {
  return a.permission === 'media' && a.mediaType === 'audio' && a.isMainWindow && a.url.startsWith('file://');
}
