import type { Loader, SkinnedMesh } from 'three';
export class MMDLoader extends Loader {
  load(url: string, onLoad: (mesh: SkinnedMesh) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: unknown) => void): void;
}
