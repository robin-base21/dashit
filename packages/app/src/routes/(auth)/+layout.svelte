<script lang="ts">
	// Deliberately bare, and outside `(app)`: signing in must never open the database. Two owners
	// of the OPFS access-handle pool cannot coexist, which is why `/spike` sits outside it too.
	import { Toaster } from '$lib/components/ui/sonner';

	let { children } = $props();
</script>

<div class="flex min-h-svh flex-col items-center justify-center bg-background p-4">
	<main class="w-full max-w-sm">
		{@render children()}
	</main>
</div>

<Toaster />
