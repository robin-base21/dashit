<script lang="ts">
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { RelayError } from '$lib/auth/api';
	import { createAccountWithPasskey, requestSignupCode, verifySignupCode } from '$lib/auth/flows';
	import { getSession } from '$lib/auth/session.svelte';
	import { isSupported } from '$lib/auth/webauthn';

	const session = getSession();

	type Step = 'email' | 'code' | 'passkey';
	let step = $state<Step>('email');
	let email = $state('');
	let code = $state('');
	let regToken = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	function explain(e: unknown): string {
		if (e instanceof RelayError) {
			if (e.rateLimited) return 'Too many attempts. Try again shortly.';
			if (e.code === 'locked') return 'Too many wrong codes. Try again in an hour.';
			if (e.code === 'invalid_code') return 'That code is not right, or it has expired.';
			if (e.code === 'already_registered') return 'That address already has an account — sign in with your passkey instead.';
		}
		if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
			return 'Passkey setup was cancelled.';
		}
		return e instanceof Error ? e.message : String(e);
	}

	async function sendCode() {
		busy = true;
		error = null;
		try {
			await requestSignupCode(session.client, email.trim());
			// The response is deliberately identical whether or not the address is known, so this
			// says "if" rather than claiming an email is on its way.
			step = 'code';
		} catch (e) {
			error = explain(e);
		} finally {
			busy = false;
		}
	}

	async function checkCode() {
		busy = true;
		error = null;
		try {
			const res = await verifySignupCode(session.client, email.trim(), code.trim());
			regToken = res.reg_token;
			step = 'passkey';
		} catch (e) {
			error = explain(e);
		} finally {
			busy = false;
		}
	}

	async function makePasskey() {
		busy = true;
		error = null;
		try {
			const result = await createAccountWithPasskey(session.client, regToken);
			await session.adoptTokens(result);
			toast.success('Account created');
			await goto('/settings');
		} catch (e) {
			error = explain(e);
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Create an account</Card.Title>
		<Card.Description>
			An account lets you sync this dashboard to your other devices. Everything keeps working without one.
		</Card.Description>
	</Card.Header>

	<Card.Content class="flex flex-col gap-3">
		{#if step === 'email'}
			<div class="grid gap-2">
				<Label for="email">Email</Label>
				<Input
					id="email"
					type="email"
					bind:value={email}
					placeholder="you@example.com"
					onkeydown={(e) => e.key === 'Enter' && email.includes('@') && sendCode()}
				/>
			</div>
			<Button onclick={sendCode} disabled={busy || !email.includes('@')} data-testid="send-code">
				{busy ? 'Sending…' : 'Send me a code'}
			</Button>
		{:else if step === 'code'}
			<div class="grid gap-2">
				<Label for="code">Six-digit code</Label>
				<Input
					id="code"
					inputmode="numeric"
					autocomplete="one-time-code"
					bind:value={code}
					placeholder="000000"
					onkeydown={(e) => e.key === 'Enter' && code.trim().length === 6 && checkCode()}
				/>
				<p class="text-xs text-muted-foreground">
					If {email} can be registered, a code is on its way. It expires in 15 minutes.
				</p>
			</div>
			<Button onclick={checkCode} disabled={busy || code.trim().length !== 6} data-testid="check-code">
				{busy ? 'Checking…' : 'Continue'}
			</Button>
			<!-- An address that already has an account gets no code, and the response cannot say so
			     without becoming an account-existence oracle. This is the way out, and it has to be
			     obvious rather than a footnote, because for that user no code is ever coming. -->
			<div class="rounded-md border border-primary/40 bg-accent/40 p-3">
				<p class="text-sm font-medium">Already have an account?</p>
				<p class="mt-1 text-xs text-muted-foreground">
					Addresses that are already registered are not sent a code. Sign in with your passkey instead — it
					works even if the passkey lives on another device.
				</p>
				<Button variant="outline" size="sm" class="mt-2 w-full" onclick={() => goto('/login')} data-testid="pivot-signin">
					Sign in instead
				</Button>
			</div>
		{:else}
			<p class="text-sm text-muted-foreground">
				Create a passkey to finish. It is what you will sign in with — no password to remember.
			</p>
			<Button onclick={makePasskey} disabled={busy || !isSupported()} data-testid="make-passkey">
				{busy ? 'Waiting for your passkey…' : 'Create a passkey'}
			</Button>
			{#if !isSupported()}
				<p class="text-sm text-destructive">This browser does not support passkeys.</p>
			{/if}
		{/if}

		{#if error}
			<p class="text-sm text-destructive" data-testid="register-error">{error}</p>
		{/if}
	</Card.Content>

	<Card.Footer>
		<Button variant="ghost" class="w-full" onclick={() => goto('/dashboard')}>Back to the dashboard</Button>
	</Card.Footer>
</Card.Root>
