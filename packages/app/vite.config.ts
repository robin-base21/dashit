import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			// Client-only SPA: every route is served from the fallback and renders against the local DB.
			adapter: adapter({ fallback: 'index.html', strict: false })
		})
	],
	optimizeDeps: {
		// Emscripten output and the VFS modules must not be pre-bundled.
		exclude: ['@vlcn.io/crsqlite-wasm', '@vlcn.io/wa-sqlite']
	},
	worker: {
		format: 'es'
	}
});
