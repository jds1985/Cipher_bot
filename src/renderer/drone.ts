// Standalone animated drone element (preview module; not yet wired into the app UI).
// Same state model as avatar.ts: data-state idle / thinking / speaking, .is-muted / .is-archived, per-bot phase class.
import { composeDrone, type DroneSpec } from './droneParts.js';
import { phaseOf, type AvatarState } from './avatar.js';

export interface DroneOptions { spec: DroneSpec; size: number; botId?: number; state?: AvatarState; muted?: boolean; archived?: boolean; }

/** Detail level for a pixel size: the simplified optical variant at 48px and below. */
export const droneDetailFor = (size: number): 'full' | 'small' => (size <= 48 ? 'small' : 'full');

export function droneMarkup(o: DroneOptions, uid = ''): string {
  const cls = [`ph-${phaseOf(o.botId ?? 0)}`, o.muted ? 'is-muted' : '', o.archived ? 'is-archived' : ''].filter(Boolean).join(' ');
  return composeDrone(o.spec, { size: o.size, detail: droneDetailFor(o.size), uid, className: cls });
}

let seq = 0;
export function createDrone(o: DroneOptions): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML = droneMarkup(o, `u${++seq}`); // markup is generated from enumerated part ids only
  const svg = host.firstElementChild as SVGSVGElement;
  svg.dataset.state = o.state ?? 'idle';
  return svg;
}
export function setDroneState(el: SVGSVGElement, s: AvatarState): void { el.dataset.state = s; }
