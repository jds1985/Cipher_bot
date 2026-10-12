// v1.24: is a folder on a network or cloud mount? Read-only check of /proc/mounts (Linux): the longest mount point
// that contains the folder gives its filesystem type. Used to warn before a scheduled backup goes to such a folder.
import fs from 'node:fs';

export const NETWORK_FSTYPES = new Set([
  'cifs', 'smb', 'smb2', 'smb3', 'smbfs', 'nfs', 'nfs4', 'ncpfs', 'afs', 'davfs', 'fuse.davfs', 'fuse.sshfs', 'sshfs',
  'fuse.gvfsd-fuse', 'fuse.gvfs-fuse-daemon', 'fuse.rclone', 'fuse.s3fs', 'fuse.gcsfuse', 'fuse.onedriver', 'fuse.google-drive-ocamlfuse',
  'glusterfs', 'ceph', '9p',
]);

const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));

export function parseMounts(text: string): { mountPoint: string; fstype: string; device: string }[] {
  return text.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
    .map(([device, mp, fstype]) => ({ device: unescape(device), mountPoint: unescape(mp), fstype }));
}

export function networkMountFor(folder: string, mountsText: string): { network: boolean; fstype: string | null; mountPoint: string | null } {
  let best: { mountPoint: string; fstype: string; device: string } | null = null;
  for (const m of parseMounts(mountsText)) {
    const mp = m.mountPoint === '/' ? '/' : m.mountPoint.replace(/\/+$/, '');
    if (folder === mp || folder.startsWith(mp === '/' ? '/' : `${mp}/`)) {
      if (!best || mp.length > best.mountPoint.length) best = { ...m, mountPoint: mp };
    }
  }
  const fstype = best?.fstype ?? null;
  const network = (!!fstype && (NETWORK_FSTYPES.has(fstype) || /^fuse\.(sshfs|gvfs|rclone|s3|davfs)/.test(fstype)))
    || /\/gvfs\//.test(`${folder}/`) || /^\/\/|^[a-z0-9.-]+:\//i.test(best?.device ?? '');
  return { network, fstype, mountPoint: best?.mountPoint ?? null };
}

export function isNetworkFolder(folder: string, read: () => string = () => fs.readFileSync('/proc/mounts', 'utf8')): { network: boolean; fstype: string | null } {
  let text = '';
  try { text = read(); } catch { /* not Linux: no warning */ }
  const r = networkMountFor(folder, text);
  return { network: r.network, fstype: r.fstype };
}
