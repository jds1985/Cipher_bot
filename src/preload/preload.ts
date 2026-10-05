import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('cipher', {});
