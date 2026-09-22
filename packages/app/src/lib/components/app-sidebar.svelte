<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { getUi } from '$lib/state/ui.svelte';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import LogOutIcon from '@lucide/svelte/icons/log-out';

	const ui = getUi();

	const nav = [
		{ title: 'Datasources', href: '/datasources', icon: DatabaseIcon },
		{ title: 'Transformers', href: '/transformers', icon: WorkflowIcon }
	] as const;

	const isActive = (href: string) => page.url.pathname.startsWith(href);
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton isActive={isActive('/dashboard')} tooltipContent="Dashboard">
					{#snippet child({ props })}
						<a href={resolve('/dashboard')} {...props}>
							<LayoutDashboardIcon />
							<span>Dashboard</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={ui.elementsPanelOpen}
							tooltipContent="Elements"
							onclick={() => (ui.elementsPanelOpen = !ui.elementsPanelOpen)}
						>
							<BoxesIcon />
							<span>Elements</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					{#each nav as item (item.href)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={isActive(item.href)} tooltipContent={item.title}>
								{#snippet child({ props })}
									<a href={resolve(item.href)} {...props}>
										<item.icon />
										<span>{item.title}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton {...props} tooltipContent="Settings">
								<SettingsIcon />
								<span>Settings</span>
							</Sidebar.MenuButton>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content side="right" align="end" class="min-w-44">
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a href={resolve('/settings')} {...props}>
									<SettingsIcon class="size-4" />
									Settings
								</a>
							{/snippet}
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item disabled>
							<LogOutIcon class="size-4" />
							Log out
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>
