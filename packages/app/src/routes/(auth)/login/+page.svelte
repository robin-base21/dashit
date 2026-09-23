<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { RelayError } from '$lib/auth/api';
	import { getSession } from '$lib/auth/session.svelte';
	import { hasPlatformAuthenticator, isSupported } from '$lib/auth/webauthn';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';

	const session = getSession();

	let busy = $state(false);
	let error = $state<string | null>(null);
	const supported = isSupported();
	const platform = $derived(hasPlatformAuthenticator());

	async function signIn() {
		busy = true;
		error = null;
		try {
			await session.signInWithPasskey();
			await goto('/dashboard');
		} catch (e) {
			// WebAuthn returns the same NotAllowedError whether the prompt was cancelled or there was
			// no usable passkey here — deliberately, so a page cannot probe for credentials. Saying
			// nothing therefore leaves the commonest case, a passkey on another device, looking like
			// a dead button.
			if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
				error =
					'No passkey was used. If yours is on another device, choose “use a passkey from another device” in your browser’s prompt and scan the code with your phone.';
			} else if (e instanceof RelayError) {
				error = e.rateLimited ? 'Too many attempts. Try again shortly.' : 'That passkey was not recognised.';
			} else {
				error = e instanceof Error ? e.message : String(e);
			}
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Sign in</Card.Title>
		<Card.Description>Use the passkey you created for DashIt. No email needed.</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#if !supported}
			<p class="text-sm text-destructive">This browser does not support passkeys.</p>
		{:else}
			<Button onclick={signIn} disabled={busy} data-testid="signin">
				<KeyRoundIcon class="size-4" />
				{busy ? 'Waiting for your passkey…' : 'Continue with a passkey'}
			</Button>
			<div class="rounded-md border p-3 text-xs text-muted-foreground">
				<p class="font-medium text-foreground">Signing in on a new device?</p>
				<p class="mt-1">
					Your passkey does not have to be on this device. Start the sign-in above and choose
					<span class="font-medium">“use a passkey from another device”</span> in the prompt, then scan the code
					with the phone that has it.
				</p>
				{#await platform then available}
					{#if !available}
						<p class="mt-1">This device has no built-in authenticator, so a phone or security key is the way in.</p>
					{/if}
				{/await}
			</div>
		{/if}
		{#if error}
			<p class="text-sm text-destructive" data-testid="login-error">{error}</p>
		{/if}
	</Card.Content>
	<Card.Footer class="flex flex-col items-stretch gap-2">
		<Button variant="outline" onclick={() => goto('/register')}>Create an account</Button>
		<Button variant="ghost" onclick={() => goto('/dashboard')}>Keep using DashIt without an account</Button>
	</Card.Footer>
</Card.Root>
