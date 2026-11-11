import { defineConfig, normalizePath, type Plugin } from 'vite';
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import typegpu from 'unplugin-typegpu/vite';

// The project root (one level up) holds audio/, data/ and assets/ (and refs/: reference films' music for ?song=); serve them next to the app.
// No directory symlinks under public/ (Git and some tools on Windows turn them into plain files): requests are
// rewritten to the root through Vite's /@fs/, and builds copy the folders (upstream pdoom-video fix #2).
const repoRoot = path.resolve(import.meta.dirname, '..');
const assetDirs = ['audio', 'data', 'assets', 'refs'];

function repoAssets(): Plugin {
  return {
    name: 'repo-assets',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (assetDirs.some((dir) => req.url?.startsWith(`/${dir}/`))) {
          req.url = `/@fs/${encodeURI(normalizePath(repoRoot))}${req.url}`;
        }
        next();
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      for (const dir of assetDirs) {
        const src = path.join(repoRoot, dir);
        if (existsSync(src)) cpSync(src, path.join(options.dir, dir), { recursive: true });
      }
    },
  };
}

// Model decoders (engine/model.ts): /__three/draco/ and /__three/basis/ are three's own Draco and KTX2 decoders
// (node_modules/three/examples/jsm/libs), served as files because the loaders fetch them at run time.
const threeLibs = path.resolve(import.meta.dirname, 'node_modules/three/examples/jsm/libs');
function threeDecoders(): Plugin {
  return {
    name: 'three-decoders',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/__three/')) req.url = `/@fs/${encodeURI(normalizePath(threeLibs))}/${req.url.slice('/__three/'.length)}`;
        next();
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      for (const dir of ['draco', 'basis']) {
        const src = path.join(threeLibs, dir);
        if (existsSync(src)) cpSync(src, path.join(options.dir, '__three', dir), { recursive: true });
      }
    },
  };
}

// Draggable keyframe tracks (src/engine/tracks.ts): GET /__tracks reads src/tracks.json, POST writes it (the curve
// editor in the preview saves here). Not imported as a module, so saving does not hot-reload the page mid-drag.
const tracksFile = path.resolve(import.meta.dirname, 'src/tracks.json');
const EMPTY_TRACKS = '{\n "version": 1,\n "tracks": {}\n}\n';
function tracks(): Plugin {
  return {
    name: 'keyframe-tracks',
    configureServer(server) {
      server.middlewares.use('/__tracks', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            try {
              const j = JSON.parse(body);
              if (!j || typeof j !== 'object' || typeof j.tracks !== 'object') throw new Error('need { tracks: {...} }');
              const tmp = tracksFile + '.tmp';
              writeFileSync(tmp, JSON.stringify(j, null, 1) + '\n', 'utf8');
              renameSync(tmp, tracksFile);
              res.statusCode = 200; res.end('{"ok":true}');
            } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })); }
          });
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(existsSync(tracksFile) ? readFileSync(tracksFile, 'utf8') : EMPTY_TRACKS);
      });
    },
    writeBundle(options) {
      if (options.dir) writeFileSync(path.join(options.dir, '__tracks'), existsSync(tracksFile) ? readFileSync(tracksFile, 'utf8') : EMPTY_TRACKS);
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // typegpu: compiles 'use gpu' functions (the vendored shaders library, src/library/vendor/shaders, see its VENDOR.md) to WGSL
  plugins: [repoAssets(), threeDecoders(), tracks(), typegpu()],
  // PDOOM_NO_HMR=1: no live reload (export renders must not reload mid-run when a file changes)
  server: { port: 5173, strictPort: false, hmr: process.env.PDOOM_NO_HMR ? false : undefined, fs: { allow: [repoRoot] } },
  resolve: { alias: { '@root': repoRoot, '@coreroot': path.resolve(import.meta.dirname, 'src/library/vendor/shaders') } },
  build: { target: 'esnext', assetsInlineLimit: 0 },
});
