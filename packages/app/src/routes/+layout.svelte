<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { Theme, setTheme } from '$lib/theme/theme.svelte';
	import { Session, setSession } from '$lib/auth/session.svelte';

	let { children } = $props();

	const theme = new Theme();
	setTheme(theme);
	$effect(() => theme.apply());

	// The session lives above both route groups: `(auth)` needs it and `(app)` shows the account
	// in Settings. It touches no database, so it is safe here where `(app)`'s own state is not.
	const session = new Session();
	setSession(session);
	void session.restore();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>DashIt</title>
</svelte:head>

{@render children()}
