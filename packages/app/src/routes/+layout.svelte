<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { Theme, setTheme } from '$lib/theme/theme.svelte';

	let { children } = $props();

	const theme = new Theme();
	setTheme(theme);
	$effect(() => theme.apply());
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>DashIt</title>
</svelte:head>

{@render children()}
