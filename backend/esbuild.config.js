import * as esbuild from 'esbuild';
import { lambdaBundleOptions, lambdaEntryPoints } from './esbuild.options.js';

await esbuild.build({
  ...lambdaBundleOptions,
  entryPoints: lambdaEntryPoints(),
  outdir: 'dist',
});

console.log('Build complete!');
